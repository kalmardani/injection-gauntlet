#!/usr/bin/env node
// HTTP target example: the gullible agent behind a local endpoint.
//   node examples/agents/http-agent.js 8787
//   injection-gauntlet run --target http --url http://127.0.0.1:8787/step
// The endpoint is stateless. It replays the transcript it receives to rebuild
// the agent state, then answers with the next action.
import http from 'node:http';
import { initialState, next } from './gullible-core.js';

export function answer(body) {
  const state = initialState(body.tools || []);
  let action = null;
  for (const m of body.messages || []) {
    if (m.role === 'user') action = next(state, { type: 'user', content: m.content });
    else if (m.role === 'tool') action = next(state, { type: 'tool_result', name: m.name, content: m.content });
  }
  return action || { type: 'final', content: '' };
}

export function createServer() {
  return http.createServer((req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405).end();
      return;
    }
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (d) => {
      raw += d;
      if (raw.length > 5_000_000) req.destroy();
    });
    req.on('end', () => {
      try {
        const reply = answer(JSON.parse(raw));
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(reply));
      } catch (e) {
        res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ type: 'error', message: e.message }));
      }
    });
  });
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('http-agent.js')) {
  const port = Number(process.argv[2] || 8787);
  createServer().listen(port, '127.0.0.1', () => process.stderr.write(`gullible http agent on http://127.0.0.1:${port}/step\n`));
}
