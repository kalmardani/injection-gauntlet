#!/usr/bin/env node
// Command target example. Speaks the injection-gauntlet agent protocol on
// stdin and stdout, one JSON object per line. Run it with:
//   injection-gauntlet run -- node examples/agents/gullible-agent.js
import { createInterface } from 'node:readline';
import { initialState, next } from './gullible-core.js';

let state = null;
let callId = 0;
const send = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);

for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  if (!line.trim()) continue;
  const msg = JSON.parse(line);
  if (msg.type === 'start') {
    state = initialState(msg.tools);
    continue;
  }
  if (msg.type === 'end') break;
  if (msg.type === 'user' || msg.type === 'tool_result') {
    const action = next(state, msg);
    if (action.type === 'tool_call') send({ ...action, id: `g${++callId}` });
    else send(action);
  }
}
