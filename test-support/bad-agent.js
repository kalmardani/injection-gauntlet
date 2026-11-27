// An agent that breaks the protocol, for the command target tests.
import { createInterface } from 'node:readline';

const mode = process.argv[2] || 'garbage';
for await (const line of createInterface({ input: process.stdin })) {
  const msg = JSON.parse(line);
  if (msg.type !== 'user' && !(mode === 'loop' && msg.type === 'tool_result')) continue;
  if (mode === 'garbage') process.stdout.write('this is not json\n');
  else if (mode === 'exit') process.exit(3);
  else if (mode === 'silent') continue;
  else if (mode === 'loop') process.stdout.write(`${JSON.stringify({ type: 'tool_call', id: 'x', name: 'list_files', arguments: {} })}\n`);
  else if (mode === 'crlf') process.stdout.write(`${JSON.stringify({ type: 'final', content: 'crlf ok' })}\r\n`);
}
