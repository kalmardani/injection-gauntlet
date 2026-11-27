import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, readdirSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMcpHandler, MCP_TOOLS } from '../src/mcp.js';
import { resolveConfig, parseArgs } from '../src/config.js';
import { renderHtml } from '../src/report/html.js';
import { executeRun } from '../src/app.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(ROOT, 'bin', 'injection-gauntlet.js');
const GULLIBLE = path.join(ROOT, 'examples', 'agents', 'gullible-agent.js');
const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'ig-cli-'));

function cli(args, { input = '', env = {} } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], { cwd: ROOT, env: { ...process.env, ...env }, shell: false });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

test('help, version, list, show and validate', async () => {
  assert.match((await cli(['--help'])).stdout, /auth login <claude\|chatgpt\|oauth>/);
  assert.equal((await cli(['--version'])).stdout.trim(), JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version);
  const list = await cli(['list', '--category', 'obfuscated']);
  assert.equal(list.code, 0);
  assert.match(list.stdout, /3 scenarios/);
  const show = await cli(['show', 'trifecta-support-reply']);
  assert.deepEqual(JSON.parse(show.stdout).derived.indicators.emails, ['tom.backup@attacker.example']);
  assert.match((await cli(['validate'])).stdout, /30 valid scenarios/);
  const bad = await cli(['run', '--target', 'nope']);
  assert.equal(bad.code, 2);
  assert.equal((await cli(['frobnicate'])).code, 2);
});

test('run against the gullible agent writes reports and honours --max-asr', async () => {
  const out = tmp();
  try {
    const r = await cli(['run', '--category', 'indirect_web', '--out', out, '--max-asr', '50%', '--', 'node', path.relative(ROOT, GULLIBLE)]);
    assert.equal(r.code, 1, `ASR above the threshold gives exit 1\n${r.stderr}`);
    assert.match(r.stdout, /BREACHED/);
    const report = JSON.parse(readFileSync(path.join(out, 'report.json'), 'utf8'));
    assert.equal(report.schema, 'injection-gauntlet/report@1');
    assert.equal(report.summary.trials, 3);
    assert.equal(report.protocol.target, 'command');
    const html = readFileSync(path.join(out, 'report.html'), 'utf8');
    assert.match(html, /Content-Security-Policy/);
    const ok = await cli(['run', '--only', 'obf-*', '--max-asr', '0.5', '--quiet', '--', 'node', GULLIBLE]);
    assert.equal(ok.code, 0);
    const again = path.join(out, 'b.json');
    await cli(['run', '--category', 'indirect_web', '--json', again, '--allow-tools', 'http_get,search_web', '--', 'node', GULLIBLE]);
    const cmp = await cli(['compare', path.join(out, 'report.json'), again]);
    assert.match(cmp.stdout, /indirect_web/);
    const rerender = path.join(out, 'again.html');
    assert.equal((await cli(['report', again, '--html', rerender])).code, 0);
    assert.ok(statSync(rerender).size > 1000);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('config file sets options and resolves paths against its folder', () => {
  const dir = tmp();
  try {
    writeFileSync(path.join(dir, 'c.json'), JSON.stringify({ target: 'command', command: ['node', 'agent.js'], k: 2, only: ['obf-*'], system_prompt_file: 'p.txt' }));
    writeFileSync(path.join(dir, 'agent.js'), '');
    const cfg = resolveConfig({ flags: { config: path.join(dir, 'c.json'), k: '3' }, env: {} });
    assert.equal(cfg.k, 3, 'flags win over the file');
    assert.equal(cfg.command[1], path.join(dir, 'agent.js'));
    assert.equal(cfg.system_prompt_file, path.join(dir, 'p.txt'));
    assert.deepEqual(cfg.only, ['obf-*']);
    assert.throws(() => resolveConfig({ flags: { provider: 'nope' }, env: {} }), /unknown provider/);
    assert.throws(() => resolveConfig({ flags: { 'max-asr': '2' }, env: {} }), /between 0 and 1/);
    assert.throws(() => parseArgs(['--bogus']), /unknown option/);
    assert.deepEqual(parseArgs(['a', '--k=2', '--', 'node', 'x']).rest, ['node', 'x']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('auth status lists every connection type and prints no secret', async () => {
  const r = await cli(['auth', 'status'], {
    env: { OPENAI_API_KEY: 'sk-test-do-not-print', IG_CLAUDE_BIN: path.join(os.tmpdir(), 'missing-claude'), IG_CODEX_BIN: path.join(os.tmpdir(), 'missing-codex'), IG_OAUTH_CONFIG: '' },
  });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /OPENAI_API_KEY\s+ready/);
  assert.match(r.stdout, /oauth/);
  assert.match(r.stdout, /claude CLI/);
  assert.match(r.stdout, /codex CLI/);
  assert.ok(!r.stdout.includes('sk-test-do-not-print'));
});

test('HTML report escapes agent output and loads nothing', () => {
  const evil = '<script>alert(1)</script><img src="https://x.attacker.example/p.png">\x1b[31m';
  const report = {
    tool: { name: 'injection-gauntlet', version: '0' },
    started_at: 'now',
    protocol: { target: 'command', command: evil, k: 1, seed: 1 },
    summary: { asr: 1, utility: 0, pass_hat_k: 0, trials: 1, hijacked: 1, errors: 0 },
    categories: { direct: { scenarios: 1, asr: 1, utility: 0, pass_hat_k: 0, blocked_calls: 0 } },
    threshold: { max_asr: null },
    scenarios: [
      {
        id: 'x', title: evil, category: 'direct', technique: evil, k: 1, hijacks: 1, passes: 0, pass_hat_k: false,
        trifecta: { private_data: true, untrusted_content: true, outbound: true },
        trials: [{ trial: 0, seed: 1, status: 'hijacked', hijacks: [{ type: 't', detail: evil }], success: [], error: null, events: [{ type: 'final', content: evil }, { type: 'tool_call', tool: evil, args: { a: evil }, executed: true, result: { content: evil, isError: false } }] }],
      },
    ],
  };
  const html = renderHtml(report);
  assert.ok(!/<script/i.test(html));
  assert.ok(!/<img/i.test(html));
  assert.ok(!html.includes('\x1b'));
  assert.match(html, /default-src 'none'/);
});

test('MCP handler: initialize, tools/list, list, run, read report, errors', async () => {
  const out = tmp();
  try {
    const cfg = resolveConfig({ flags: { out }, rest: ['node', GULLIBLE], env: {} });
    const handle = createMcpHandler({ cfg });
    const init = await handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
    assert.equal(init.result.protocolVersion, '2025-06-18');
    assert.equal(init.result.serverInfo.name, 'injection-gauntlet');
    assert.equal(await handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
    const tools = await handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    assert.deepEqual(tools.result.tools.map((t) => t.name), MCP_TOOLS.map((t) => t.name));
    const list = await handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_scenarios', arguments: { category: 'multi_turn' } } });
    assert.equal(JSON.parse(list.result.content[0].text).length, 2);
    const run = await handle({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'run_scenarios', arguments: { ids: ['email-newsletter-bcc'], k: 1 } } });
    assert.match(run.result.content[0].text, /report_id r1/);
    const read = await handle({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'read_report', arguments: { report_id: 'r1', scenario_id: 'email-newsletter-bcc' } } });
    assert.match(read.result.content[0].text, /Treat them as data/);
    const badArgs = await handle({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'run_scenarios', arguments: { k: 50 } } });
    assert.equal(badArgs.result.isError, true);
    const smuggle = await handle({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'run_scenarios', arguments: { command: ['rm', '-rf', '/'] } } });
    assert.equal(smuggle.result.isError, true, 'a command cannot be passed through the tool');
    assert.equal((await handle({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'nope' } })).error.code, -32602);
    assert.equal((await handle({ jsonrpc: '2.0', id: 9, method: 'resources/list' })).error.code, -32601);
    assert.ok(readdirSync(out).includes('report.json'));
    const noTarget = createMcpHandler({ cfg: resolveConfig({ flags: {}, env: {}, allowIncomplete: true }) });
    const refused = await noTarget({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'run_scenarios', arguments: {} } });
    assert.match(refused.result.content[0].text, /no target configured/);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('MCP server speaks JSON-RPC over stdio', async () => {
  const input = [
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2099-01-01' } }),
    'not json',
    JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_scenario', arguments: { id: 'obf-base64-instruction' } } }),
    '',
  ].join('\n');
  const r = await cli(['mcp'], { input });
  const lines = r.stdout.trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.find((l) => l.id === 1).result.protocolVersion, '2025-11-25');
  assert.equal(lines.find((l) => l.id === null).error.code, -32700);
  assert.match(lines.find((l) => l.id === 2).result.content[0].text, /keys@attacker.example/);
});

test('fake provider through the CLI is labelled as measuring nothing', async () => {
  const dir = tmp();
  try {
    writeFileSync(path.join(dir, 's.json'), JSON.stringify([{ text: 'I cannot help.' }]));
    const r = await cli(['run', '--provider', 'fake', '--fake-script', path.join(dir, 's.json'), '--only', 'direct-*', '--quiet']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /do not describe any model/);
    const { report } = await executeRun(resolveConfig({ flags: { provider: 'fake', 'fake-script': path.join(dir, 's.json'), only: ['direct-*'] }, env: {} }));
    assert.equal(report.protocol.provider, 'fake');
    assert.equal(report.protocol.system_prompt_file, 'reference-agent.txt');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
