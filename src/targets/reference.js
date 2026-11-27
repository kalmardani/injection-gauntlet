// The built in reference agent: a plain tool calling loop over the provider
// layer. It is deliberately ordinary. It does not label tool output as
// untrusted and has no filters, so its numbers show what a typical agent
// does with a given model and system prompt.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_SYSTEM_PROMPT_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'prompts', 'reference-agent.txt');

export function readPromptFile(file) {
  return readFileSync(file, 'utf8').replace(/\r\n/g, '\n').trim();
}

export function referenceTarget({ provider, systemPrompt }) {
  return {
    kind: 'reference',
    describe: () => ({ target: 'reference', provider: provider.name, model: provider.model, auth: provider.auth }),
    async open({ tools, context, seed }) {
      const system = context ? `${systemPrompt}\n\n${context}` : systemPrompt;
      const messages = [];
      let pending = [];
      const usage = { inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 0 };

      async function step() {
        const res = await provider.chat({ system, messages, tools, seed });
        usage.calls += 1;
        usage.inputTokens += res.usage?.inputTokens || 0;
        usage.outputTokens += res.usage?.outputTokens || 0;
        usage.costUsd += res.usage?.costUsd || 0;
        if (res.toolCalls.length) {
          messages.push({ role: 'assistant', content: res.text || '', toolCalls: res.toolCalls });
          const replies = res.toolCalls.map((c) => ({ type: 'tool_call', id: c.id, name: c.name, arguments: c.arguments }));
          pending = replies.slice(1);
          return replies[0];
        }
        messages.push({ role: 'assistant', content: res.text });
        return { type: 'final', content: res.text };
      }

      return {
        usage,
        transcript: messages,
        async user(content) {
          messages.push({ role: 'user', content });
          return step();
        },
        async toolResult({ id, name, content, isError }) {
          messages.push({ role: 'tool', toolCallId: id, name, content, isError });
          if (pending.length) return pending.shift();
          return step();
        },
        async close() {},
      };
    },
  };
}
