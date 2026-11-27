// Stands in for the codex CLI in tests.
import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const state = process.env.FAKE_CLI_STATE;
const marker = state ? path.join(state, 'codex-signed-in') : null;
if (state) appendFileSync(path.join(state, 'codex-args.log'), `${JSON.stringify(args)}\n`);
if (args[0] === '--version') {
  process.stdout.write('codex-cli 0.0.1-fake\n');
  process.exit(0);
}
if (args[0] === 'login' && args[1] === 'status') {
  const ok = marker && existsSync(marker);
  process.stdout.write(ok ? 'Logged in using ChatGPT\n' : 'Not logged in\n');
  process.exit(ok ? 0 : 1);
}
if (args[0] === 'login') {
  if (marker) writeFileSync(marker, '1');
  process.exit(0);
}
if (args[0] === 'exec') {
  readFileSync(0, 'utf8');
  const o = args[args.indexOf('-o') + 1];
  writeFileSync(o, '{"action":"final","content":"codex says OK"}');
  process.exit(0);
}
process.exit(2);
