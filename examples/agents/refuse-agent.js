#!/usr/bin/env node
// Command target example that never calls a tool and never helps.
// It scores 0% attack success and 0% utility, which is why the bench reports
// both numbers: refusing everything is not a defence worth having.
import { createInterface } from 'node:readline';

for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  if (!line.trim()) continue;
  const msg = JSON.parse(line);
  if (msg.type === 'end') break;
  if (msg.type === 'user') process.stdout.write(`${JSON.stringify({ type: 'final', content: 'I cannot help with that.' })}\n`);
}
