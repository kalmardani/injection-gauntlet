// Adapter for the Messages API. Native tool calling.

import { requestJson } from './http.js';
import { validate } from '../schema.js';

const RESPONSE_SCHEMA = {
  type: 'object',
  required: ['content'],
  properties: {
    content: {
      type: 'array',
      items: {
        type: 'object',
        required: ['type'],
        properties: { type: { type: 'string' }, text: { type: 'string' }, id: { type: 'string' }, name: { type: 'string' }, input: { type: 'object' } },
      },
    },
    stop_reason: { type: ['string', 'null'] },
  },
};

/** Convert the neutral transcript. Consecutive tool results become one user message. */
export function toAnthropicMessages(messages) {
  const out = [];
  for (const m of messages) {
    if (m.role === 'user') out.push({ role: 'user', content: m.content });
    else if (m.role === 'assistant') {
      const content = [];
      if (m.content) content.push({ type: 'text', text: m.content });
      for (const c of m.toolCalls || []) content.push({ type: 'tool_use', id: c.id, name: c.name, input: c.arguments ?? {} });
      out.push({ role: 'assistant', content: content.length ? content : [{ type: 'text', text: '' }] });
    } else if (m.role === 'tool') {
      const block = { type: 'tool_result', tool_use_id: m.toolCallId, content: m.content, is_error: !!m.isError };
      const last = out[out.length - 1];
      if (last && last.role === 'user' && Array.isArray(last.content) && last.content[0]?.type === 'tool_result') last.content.push(block);
      else out.push({ role: 'user', content: [block] });
    }
  }
  return out;
}

export function createAnthropicProvider({ model, baseUrl, authHeaders, timeoutMs, maxRetries, temperature, maxTokens, fetchImpl }) {
  if (!model) throw new Error('the anthropic provider needs a model (--model or IG_MODEL)');
  const url = `${(baseUrl || 'https://api.anthropic.com').replace(/\/+$/, '')}/v1/messages`;
  return {
    name: 'anthropic',
    model,
    async chat({ system, messages, tools }) {
      const body = { model, max_tokens: maxTokens, messages: toAnthropicMessages(messages) };
      if (system) body.system = system;
      if (tools?.length) body.tools = tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
      if (temperature !== undefined) body.temperature = temperature;
      const headers = { 'anthropic-version': '2023-06-01', ...(await authHeaders()) };
      const { data } = await requestJson(url, { body, headers, timeoutMs, maxRetries, fetchImpl });
      const errors = validate(data, RESPONSE_SCHEMA, 'response');
      if (errors.length) throw new Error(`anthropic provider returned an unexpected response; ${errors.slice(0, 3).join('; ')}`);
      const text = data.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
      const toolCalls = data.content
        .filter((b) => b.type === 'tool_use')
        .map((b) => ({ id: b.id, name: b.name, arguments: b.input ?? {} }));
      return {
        text,
        toolCalls,
        usage: { inputTokens: data.usage?.input_tokens || 0, outputTokens: data.usage?.output_tokens || 0 },
        model: data.model || model,
      };
    },
  };
}
