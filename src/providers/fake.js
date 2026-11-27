// Scripted provider for tests and offline wiring checks. It measures nothing
// about any model. A script is a list of responses, consumed in order, or a
// function (request, callIndex) returning one response.
// A response is { text } or { toolCalls: [{ name, arguments }] }.

import { readFileSync } from 'node:fs';

export function createFakeProvider({ script, scriptFile } = {}) {
  let steps = script;
  if (!steps && scriptFile) steps = JSON.parse(readFileSync(scriptFile, 'utf8'));
  if (!steps) steps = [{ text: 'fake provider: no script given' }];
  let calls = 0;
  return {
    name: 'fake',
    model: 'fake',
    requests: [],
    async chat(request) {
      this.requests.push(structuredClone(request));
      const i = calls++;
      let r;
      if (typeof steps === 'function') r = await steps(request, i);
      else r = steps[Math.min(i, steps.length - 1)];
      return {
        text: r.text || '',
        toolCalls: (r.toolCalls || []).map((c, j) => ({ id: c.id || `fake_${i}_${j}`, name: c.name, arguments: c.arguments ?? {} })),
        usage: { inputTokens: r.inputTokens || 0, outputTokens: r.outputTokens || 0 },
        model: 'fake',
      };
    },
  };
}
