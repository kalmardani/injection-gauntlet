// Process spawning that behaves the same on Windows, macOS and Linux.
// Always an argument array and shell: false. On Windows a bare command name
// is resolved through PATH and PATHEXT; a .cmd or .bat shim runs through
// cmd.exe only when every argument is free of characters cmd.exe would
// interpret, so no argument can turn into a second command.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

const CMD_UNSAFE = /["%!^&|<>\r\n]/;

function findOnPath(bin) {
  const exts = ['.exe', '.cmd', '.bat', '.com'];
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const ext of exts) {
    for (const dir of dirs) {
      const full = path.join(dir, bin + ext);
      if (existsSync(full)) return full;
    }
  }
  return null;
}

/** Turn [bin, args] into what spawn needs on this platform. */
export function resolveCommand(bin, args, platform = process.platform) {
  if (platform !== 'win32') return { file: bin, args };
  let file = bin;
  if (!path.extname(bin)) file = findOnPath(bin) || bin;
  if (/\.(cmd|bat)$/i.test(file)) {
    for (const a of [file, ...args]) {
      if (CMD_UNSAFE.test(a)) throw new Error(`refusing to pass an argument with shell metacharacters to ${path.basename(file)}`);
    }
    const quoted = [file, ...args].map((a) => `"${a}"`).join(' ');
    return { file: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', `"${quoted}"`], windowsVerbatimArguments: true };
  }
  return { file, args };
}

/**
 * Run a process to completion. Returns { code, stdout, stderr, timedOut }.
 * stdin receives options.input and is then closed. Output is capped.
 */
export function runProcess(bin, args, { input = '', timeoutMs = 120000, cwd, env, maxOutput = 10 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    let resolved;
    try {
      resolved = resolveCommand(bin, args);
    } catch (e) {
      reject(e);
      return;
    }
    const child = spawn(resolved.file, resolved.args, {
      cwd,
      env: env || process.env,
      shell: false,
      windowsHide: true,
      windowsVerbatimArguments: !!resolved.windowsVerbatimArguments,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      if (stdout.length < maxOutput) stdout += d;
    });
    child.stderr.on('data', (d) => {
      if (stderr.length < maxOutput) stderr += d;
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
    child.stdin.on('error', () => {
      // The child may exit before reading stdin; the exit code tells the story.
    });
    child.stdin.end(input);
  });
}

/** Run a process attached to the user's terminal (interactive sign in). Resolves with the exit code. */
export function runInteractive(bin, args, { env } = {}) {
  return new Promise((resolve, reject) => {
    const resolved = resolveCommand(bin, args);
    const child = spawn(resolved.file, resolved.args, {
      env: env || process.env,
      shell: false,
      stdio: 'inherit',
      windowsVerbatimArguments: !!resolved.windowsVerbatimArguments,
    });
    child.on('error', reject);
    child.on('close', (code) => resolve(code));
  });
}

/** Parse a JSON array of strings from an env var, for prefix arguments. */
export function envArgs(name) {
  const raw = process.env[name];
  if (!raw) return [];
  const v = JSON.parse(raw);
  if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) throw new Error(`${name} must be a JSON array of strings`);
  return v;
}
