// The http target. Stateless: each step POSTs the whole transcript to the
// user's endpoint, which answers with one reply object. The endpoint comes
// only from the user's own configuration.

import { requestJson } from '../providers/http.js';
import { AGENT_PROTOCOL, checkAgentReply } from './protocol.js';

export function httpTarget({ url, timeoutMs = 120000, maxRetries = 2, token, fetchImpl }) {
  if (!url) throw new Error('the http target needs --url');
  const u = new URL(url);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('the http target URL must be http or https');
  return {
    kind: 'http',
    describe: () => ({ target: 'http', url: `${u.origin}${u.pathname}` }),
    async open({ scenarioId, trial, seed, tools, context, system }) {
      const session = `${scenarioId}:${trial}:${seed}`;
      const messages = [];
      const headers = token ? { authorization: `Bearer ${token}` } : {};
      async function step() {
        const { data } = await requestJson(url, {
          body: { protocol: AGENT_PROTOCOL, session, scenario: scenarioId, trial, seed, system: system || null, context: context || null, tools, messages },
          headers,
          timeoutMs,
          maxRetries,
          fetchImpl,
        });
        const reply = checkAgentReply(data);
        if (reply.type === 'tool_call') messages.push({ role: 'assistant', tool_call: { id: reply.id, name: reply.name, arguments: reply.arguments } });
        else messages.push({ role: 'assistant', content: reply.content });
        return reply;
      }
      return {
        usage: {},
        async user(content) {
          messages.push({ role: 'user', content });
          return step();
        },
        async toolResult({ id, name, content, isError }) {
          messages.push({ role: 'tool', id, name, content, is_error: !!isError });
          return step();
        },
        async close() {},
      };
    },
  };
}
