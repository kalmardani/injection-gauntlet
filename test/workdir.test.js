// The vendor CLIs read CLAUDE.md, AGENTS.md and similar files from their working
// directory and send them with every call. Each adapter call must therefore run
// in its own fresh, empty folder under the OS temp dir, never the current
// directory, and remove it afterwards, also when the call fails.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createClaudeCliProvider, createCodexCliProvider } from '../src/providers/cli.js';

const FINAL = '{"action":"final","content":"pong"}';

// A spawn stand in. It records the cwd and what the folder holds while the "CLI" runs.
function fakeSpawn(reply) {
  const seen = [];
  const fn = (file, args, opts) => {
    seen.push({ cwd: opts.cwd, existed: existsSync(opts.cwd), entries: readdirSync(opts.cwd), shell: opts.shell });
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = () => {};
    const r = reply(args);
    setImmediate(() => {
      if (r.file) writeFileSync(args[args.indexOf('-o') + 1], r.file);
      child.stdout.end(r.stdout ?? '');
      child.stderr.end(r.stderr ?? '');
      setImmediate(() => child.emit('close', r.code ?? 0));
    });
    return child;
  };
  fn.seen = seen;
  return fn;
}

function insideTmp(dir) {
  const rel = path.relative(os.tmpdir(), dir);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

const cases = [
  ['claude-cli', createClaudeCliProvider, 'IG_CLAUDE_BIN', () => ({ stdout: JSON.stringify({ is_error: false, result: FINAL, usage: {} }) }),
    () => ({ code: 1, stdout: JSON.stringify({ is_error: true, result: 'Not logged in, please log in' }) })],
  ['codex-cli', createCodexCliProvider, 'IG_CODEX_BIN', () => ({ file: FINAL }), () => ({ code: 1, stderr: 'boom' })],
];

for (const [name, make, binEnv, ok, fail] of cases) {
  test(`${name} runs in a fresh empty temp dir and removes it, also on error`, async () => {
    // A known binary, so Windows never resolves a real CLI shim from PATH. The fake spawn runs nothing.
    const saved = process.env[binEnv];
    process.env[binEnv] = process.execPath;
    try {
      const good = fakeSpawn(ok);
      const r = await make({ maxRetries: 0, spawn: good }).chat({ system: 's', messages: [{ role: 'user', content: 'ping' }], tools: [] });
      assert.equal(r.text, 'pong');
      const bad = fakeSpawn(fail);
      await assert.rejects(make({ maxRetries: 0, spawn: bad }).chat({ system: 's', messages: [{ role: 'user', content: 'ping' }], tools: [] }));
      const seen = [...good.seen, ...bad.seen];
      assert.equal(seen.length, 2);
      for (const s of seen) {
        assert.ok(insideTmp(s.cwd), `cwd ${s.cwd} is inside ${os.tmpdir()}`);
        assert.notEqual(s.cwd, process.cwd());
        assert.equal(s.shell, false);
        assert.ok(s.existed, 'the folder exists while the CLI runs');
        assert.deepEqual(s.entries, [], 'the folder is empty');
        assert.ok(!existsSync(s.cwd), 'the folder is gone after the call');
      }
      assert.notEqual(seen[0].cwd, seen[1].cwd, 'every call gets its own folder');
    } finally {
      if (saved === undefined) delete process.env[binEnv];
      else process.env[binEnv] = saved;
    }
  });
}
