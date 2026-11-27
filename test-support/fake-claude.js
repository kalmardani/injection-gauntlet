// Stands in for the claude CLI in tests. Behaviour comes from env vars:
//   FAKE_CLI_STATE  folder for the signed in marker and the argument log
//   FAKE_CLI_MODE   final | tool-then-final | invalid | invalid-once | error
import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const state = process.env.FAKE_CLI_STATE;
const marker = state ? path.join(state, 'signed-in') : null;
if (state) appendFileSync(path.join(state, 'args.log'), `${JSON.stringify(args)}\n`);

if (args[0] === '--version') {
  process.stdout.write('9.9.9 (fake claude)\n');
  process.exit(0);
}
if (args[0] === 'auth' && args[1] === 'status') {
  process.stdout.write(JSON.stringify({ loggedIn: !!(marker && existsSync(marker)), authMethod: 'fake' }));
  process.exit(0);
}
if (args[0] === 'auth' && args[1] === 'login') {
  if (marker) writeFileSync(marker, '1');
  process.exit(0);
}
const input = readFileSync(0, 'utf8');
const signedIn = !marker || existsSync(marker);
if (!signedIn) {
  process.stdout.write(JSON.stringify({ type: 'result', is_error: true, result: 'Not logged in' }));
  process.exit(1);
}
const mode = process.env.FAKE_CLI_MODE || 'final';
let result;
if (mode === 'final') result = '{"action":"final","content":"OK"}';
else if (mode === 'invalid') result = 'I would rather not use JSON today.';
else if (mode === 'invalid-once') result = input.includes('previous reply was rejected') ? '```json\n{"action":"final","content":"fixed"}\n```' : 'no json here';
else if (mode === 'tool-then-final') {
  result = input.includes('[tool result') ? '{"action":"final","content":"The file says hello."}' : '{"action":"tool_call","tool":"read_file","arguments":{"path":"a.txt"}}';
} else if (mode === 'error') {
  process.stdout.write(JSON.stringify({ type: 'result', is_error: true, result: 'overloaded' }));
  process.exit(0);
}
process.stdout.write(JSON.stringify({ type: 'result', is_error: false, result, usage: { input_tokens: 10, output_tokens: 5 }, total_cost_usd: 0.001, modelUsage: { 'fake-model-1': {} } }));
