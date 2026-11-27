// Subscription access through the official vendor CLIs, as subprocesses only.
// This module never reads, copies or reuses the credentials those CLIs store,
// and never calls a vendor API with them. It only runs the CLIs' own
// commands and looks at their exit codes and their documented status output.

import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runProcess, runInteractive, envArgs } from '../spawn.js';

export const CLIS = {
  claude: {
    label: 'Claude subscription (official claude CLI)',
    binEnv: 'IG_CLAUDE_BIN',
    argsEnv: 'IG_CLAUDE_BIN_ARGS',
    defaultBin: 'claude',
    installHint: 'Install the official Claude Code CLI first: npm install -g @anthropic-ai/claude-code',
    loginArgs: ['auth', 'login'],
  },
  chatgpt: {
    label: 'ChatGPT subscription (official codex CLI)',
    binEnv: 'IG_CODEX_BIN',
    argsEnv: 'IG_CODEX_BIN_ARGS',
    defaultBin: 'codex',
    installHint: 'Install the official Codex CLI first: npm install -g @openai/codex',
    loginArgs: ['login'],
  },
};

export function cliCommand(which, env = process.env) {
  const c = CLIS[which];
  return { bin: env[c.binEnv] || c.defaultBin, prefix: envArgs(c.argsEnv) };
}

export async function cliInstalled(which) {
  const { bin, prefix } = cliCommand(which);
  try {
    const r = await runProcess(bin, [...prefix, '--version'], { timeoutMs: 20000 });
    return r.code === 0 ? { installed: true, version: r.stdout.trim().split('\n')[0].slice(0, 80) } : { installed: false };
  } catch {
    return { installed: false };
  }
}

/** Tiny claude -p probe. Costs one very small model call. */
export async function probeClaude() {
  const { bin, prefix } = cliCommand('claude');
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'ig-probe-'));
  try {
    const r = await runProcess(
      bin,
      [...prefix, '-p', '--output-format', 'json', '--tools', '', '--strict-mcp-config', '--no-session-persistence', '--setting-sources', '', 'Reply with the word OK.'],
      { timeoutMs: 90000, cwd },
    );
    if (r.code !== 0) return false;
    try {
      return JSON.parse(r.stdout).is_error === false;
    } catch {
      return false;
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

/** Sign in state without a model call, from the CLIs' own status commands. */
export async function cliSignedIn(which) {
  const { bin, prefix } = cliCommand(which);
  try {
    if (which === 'claude') {
      const r = await runProcess(bin, [...prefix, 'auth', 'status', '--json'], { timeoutMs: 30000 });
      if (r.code !== 0) return false;
      return JSON.parse(r.stdout).loggedIn === true;
    }
    const r = await runProcess(bin, [...prefix, 'login', 'status'], { timeoutMs: 30000 });
    return r.code === 0 && /logged in/i.test(`${r.stdout}\n${r.stderr}`);
  } catch {
    return false;
  }
}

/**
 * auth login claude|chatgpt. Checks the CLI, checks the sign in state, and if
 * needed hands the terminal to the CLI's own interactive sign in.
 */
export async function loginSubscription(which, { log = (l) => process.stderr.write(`${l}\n`) } = {}) {
  const c = CLIS[which];
  const inst = await cliInstalled(which);
  if (!inst.installed) {
    log(c.installHint);
    return { ok: false, reason: 'not_installed' };
  }
  log(`Found ${c.defaultBin} ${inst.version}.`);
  const already = which === 'claude' ? await probeClaude() : await cliSignedIn(which);
  if (already) {
    log(`${c.label} is already signed in. The ${which === 'claude' ? 'claude-cli' : 'codex-cli'} adapter will use it.`);
    return { ok: true, already: true };
  }
  log(`Starting the official sign in of ${c.defaultBin}. Follow its prompts.`);
  const { bin, prefix } = cliCommand(which);
  const code = await runInteractive(bin, [...prefix, ...c.loginArgs]);
  const ready = code === 0 && (which === 'claude' ? await probeClaude() : await cliSignedIn(which));
  log(ready ? `Signed in. The ${which === 'claude' ? 'claude-cli' : 'codex-cli'} adapter will use it.` : 'Sign in did not finish.');
  return { ok: ready, already: false };
}
