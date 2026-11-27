// Subscription adapters. They spawn the official vendor CLIs as subprocesses
// and use whatever sign in the user made with those CLIs. Nothing here reads
// the CLIs' stored credentials.
//
// claude-cli: claude -p --output-format json, with every built in tool and
//   every MCP server switched off and no user settings loaded, so an injected
//   instruction cannot reach the real machine through the target.
// codex-cli:  codex exec in a read only sandbox, with the user's config ignored.
//
// Both run in a fresh, empty temp directory per call, never the user's current
// directory. The CLIs load instruction files (CLAUDE.md, AGENTS.md and
// similar) from their working directory and send them with every call.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runProcess } from '../spawn.js';
import { cliCommand } from '../auth/subscription.js';
import { chatViaActions, PROTOCOL_INSTRUCTIONS } from './action-protocol.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function makeWorkDir() {
  return mkdtempSync(path.join(os.tmpdir(), 'injection-gauntlet-llm-'));
}

// Called from a finally block, so it also runs after an error or a timeout. The
// retries cover Windows, where a killed process can hold the folder for a moment.
// A leftover temp folder must not hide the real result, so errors are swallowed.
export function removeWorkDir(dir) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    // best effort
  }
}

async function withRetries(fn, maxRetries) {
  let last;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (!e.retryable || attempt === maxRetries) throw e;
      await sleep(1000 * 2 ** attempt);
    }
  }
  throw last;
}

function cliError(message, retryable) {
  const e = new Error(message);
  e.retryable = retryable;
  return e;
}

export function claudeArgs({ system, model }) {
  const args = [
    '-p',
    '--output-format',
    'json',
    '--tools',
    '',
    '--strict-mcp-config',
    '--no-session-persistence',
    '--setting-sources',
    '',
    '--system-prompt',
    system,
  ];
  if (model) args.push('--model', model);
  return args;
}

export function createClaudeCliProvider({ model, timeoutMs = 180000, maxRetries = 2, spawn } = {}) {
  const { bin, prefix } = cliCommand('claude');
  return {
    name: 'claude-cli',
    model: model || null,
    async chat({ system, messages, tools }) {
      const fullSystem = `${system || ''}\n\n${PROTOCOL_INSTRUCTIONS}`.trim();
      const complete = (prompt) =>
        withRetries(async () => {
          const cwd = makeWorkDir();
          try {
            const r = await runProcess(bin, [...prefix, ...claudeArgs({ system: fullSystem, model })], { input: prompt, timeoutMs, cwd, spawnImpl: spawn });
            if (r.timedOut) throw cliError(`claude CLI timed out after ${timeoutMs} ms`, true);
            let out;
            try {
              out = JSON.parse(r.stdout);
            } catch {
              throw cliError(`claude CLI exited with ${r.code} without JSON output: ${r.stderr.slice(0, 300)}`, r.code !== 0);
            }
            if (out.is_error) {
              const msg = String(out.result || out.subtype);
              // A usage limit does not clear within the retry window, so do not retry it.
              throw cliError(`claude CLI reported an error: ${msg.slice(0, 300)}`, !/usage|limit|credits|log ?in/i.test(msg));
            }
            const usedModel = out.modelUsage ? Object.keys(out.modelUsage)[0] : model;
            const u = out.usage || {};
            return {
              text: out.result || '',
              model: usedModel,
              usage: {
                inputTokens: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0),
                outputTokens: u.output_tokens || 0,
                costUsd: out.total_cost_usd || 0,
              },
            };
          } finally {
            removeWorkDir(cwd);
          }
        }, maxRetries);
      const res = await chatViaActions({ complete, messages, tools, idPrefix: 'cc' });
      if (res.model) this.model = res.model;
      return res;
    },
  };
}

export function createCodexCliProvider({ model, timeoutMs = 240000, maxRetries = 2, spawn } = {}) {
  const { bin, prefix } = cliCommand('chatgpt');
  return {
    name: 'codex-cli',
    model: model || null,
    async chat({ system, messages, tools }) {
      const header = `${system || ''}\n\n${PROTOCOL_INSTRUCTIONS}\nDo not run shell commands and do not read or write files; the tools in <tools> are the only tools for this task.`.trim();
      const complete = (prompt) =>
        withRetries(async () => {
          const cwd = makeWorkDir();
          const outFile = path.join(cwd, 'last-message.txt');
          try {
            const args = [...prefix, 'exec', '--skip-git-repo-check', '--sandbox', 'read-only', '--ephemeral', '--ignore-user-config', '--color', 'never', '-C', cwd, '-o', outFile];
            if (model) args.push('-m', model);
            args.push('-');
            const r = await runProcess(bin, args, { input: `${header}\n\n${prompt}`, timeoutMs, cwd, spawnImpl: spawn });
            if (r.timedOut) throw cliError(`codex CLI timed out after ${timeoutMs} ms`, true);
            if (r.code !== 0) throw cliError(`codex CLI exited with ${r.code}: ${r.stderr.slice(-300)}`, true);
            let text;
            try {
              text = readFileSync(outFile, 'utf8');
            } catch {
              text = r.stdout;
            }
            return { text, model, usage: {} };
          } finally {
            removeWorkDir(cwd);
          }
        }, maxRetries);
      return chatViaActions({ complete, messages, tools, idPrefix: 'cx' });
    },
  };
}
