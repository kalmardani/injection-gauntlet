// The command target. Spawns the user's agent program once per trial, in an
// empty temp directory, and speaks line delimited JSON over stdin and stdout.
// The command comes only from the user's own configuration, never from a
// scenario or a model.

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveCommand } from '../spawn.js';
import { AGENT_PROTOCOL, ProtocolError, checkAgentReply } from './protocol.js';

const MAX_LINE = 1024 * 1024;

export function commandTarget({ command, timeoutMs = 120000 }) {
  if (!Array.isArray(command) || !command.length) throw new Error('the command target needs a command, for example: -- node my-agent.js');
  return {
    kind: 'command',
    describe: () => ({ target: 'command', command: command.join(' ') }),
    async open({ scenarioId, trial, seed, tools, context, system }) {
      const cwd = mkdtempSync(path.join(os.tmpdir(), 'ig-agent-'));
      const resolved = resolveCommand(command[0], command.slice(1));
      const child = spawn(resolved.file, resolved.args, {
        cwd,
        shell: false,
        windowsHide: true,
        windowsVerbatimArguments: !!resolved.windowsVerbatimArguments,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let buffer = '';
      let stderr = '';
      let closed = false;
      let fatal = null;
      const queue = [];
      const waiters = [];

      const deliver = (item) => {
        const w = waiters.shift();
        if (w) w(item);
        else queue.push(item);
      };

      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        buffer += chunk;
        if (buffer.length > MAX_LINE && !buffer.includes('\n')) {
          fatal = new ProtocolError('agent wrote a line longer than 1 MiB');
          child.kill('SIGKILL');
          deliver({ error: fatal });
          return;
        }
        let nl;
        while ((nl = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, nl).replace(/\r$/, '');
          buffer = buffer.slice(nl + 1);
          if (!line.trim()) continue;
          let msg;
          try {
            msg = JSON.parse(line);
          } catch {
            deliver({ error: new ProtocolError(`agent wrote a line that is not JSON: ${line.slice(0, 120)}`) });
            continue;
          }
          if (msg && msg.type === 'log') continue;
          deliver({ msg });
        }
      });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (d) => {
        if (stderr.length < 20000) stderr += d;
      });
      child.on('error', (e) => {
        fatal = new ProtocolError(`could not start the agent command: ${e.message}`);
        deliver({ error: fatal });
      });
      child.on('close', (code) => {
        closed = true;
        deliver({ error: new ProtocolError(`agent exited with code ${code} before answering. stderr: ${stderr.slice(-300)}`) });
      });
      child.stdin.on('error', () => {});

      const send = (obj) => {
        if (closed || fatal) throw fatal || new ProtocolError('agent process is not running');
        child.stdin.write(`${JSON.stringify(obj)}\n`);
      };

      const next = () =>
        new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new ProtocolError(`agent did not answer within ${timeoutMs} ms`)), timeoutMs);
          const take = (item) => {
            clearTimeout(timer);
            if (item.error) reject(item.error);
            else {
              try {
                resolve(checkAgentReply(item.msg));
              } catch (e) {
                reject(e);
              }
            }
          };
          if (queue.length) take(queue.shift());
          else waiters.push(take);
        });

      send({ type: 'start', protocol: AGENT_PROTOCOL, scenario: scenarioId, trial, seed, tools, context: context || null, system: system || null });
      let turn = 0;

      return {
        usage: {},
        async user(content) {
          send({ type: 'user', turn: turn++, content });
          return next();
        },
        async toolResult({ id, name, content, isError }) {
          send({ type: 'tool_result', id, name, content, is_error: !!isError });
          return next();
        },
        async close() {
          try {
            if (!closed) child.stdin.end(`${JSON.stringify({ type: 'end' })}\n`);
          } catch {
            // The process is already gone.
          }
          await new Promise((resolve) => {
            if (closed) return resolve();
            const t = setTimeout(() => {
              child.kill('SIGKILL');
              resolve();
            }, 2000);
            child.once('close', () => {
              clearTimeout(t);
              resolve();
            });
          });
          rmSync(cwd, { recursive: true, force: true });
        },
      };
    },
  };
}
