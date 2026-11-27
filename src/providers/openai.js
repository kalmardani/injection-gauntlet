// Adapter for any OpenAI compatible chat completions endpoint (hosted or a
// local server). Native tool calling.

import { requestJson } from './http.js';
import { validate } from '../schema.js';

const RESPONSE_SCHEMA = {
  type: 'object',
  required: ['choices'],
  properties: {
    choices: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        required: ['message'],
        properties: {
          message: {
            type: 'object',
            properties: {
              content: { type: ['string', 'null'] },
              tool_calls: {
                type: 'array',
                items: {
                  type: 'object',
                  required: ['function'],
                  properties: {
                    id: { type: 'string' },
                    function: {
                      type: 'object',
                      required: ['name'],
                      properties: { name: { type: 'string' }, arguments: { type: ['string', 'object', 'null'] } },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
};

export function toOpenAIMessages(system, messages) {
  const out = [];
  if (system) out.push({ role: 'system', content: system });
  for (const m of messages) {
    if (m.role === 'user') out.push({ role: 'user', content: m.content });
    else if (m.role === 'assistant') {
      const msg = { role: 'assistant', content: m.content || null };
      if (m.toolCalls?.length) {
        msg.tool_calls = m.toolCalls.map((c) => ({
          id: c.id,
          type: 'function',
          function: { name: c.name, arguments: JSON.stringify(c.arguments ?? {}) },
        }));
      }
      out.push(msg);
    } else if (m.role === 'tool') {
      out.push({ role: 'tool', tool_call_id: m.toolCallId, content: m.isError ? `ERROR: ${m.content}` : m.content });
    }
  }
  return out;
}

export function parseArguments(raw) {
  if (raw && typeof raw === 'object') return { value: raw };
  if (raw == null || raw === '') return { value: {} };
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v) ? { value: v } : { error: 'arguments must be a JSON object' };
  } catch (e) {
    return { error: `arguments are not valid JSON (${e.message})` };
  }
}

export function createOpenAIProvider({ model, baseUrl, authHeaders, timeoutMs, maxRetries, temperature, maxTokens, fetchImpl }) {
  if (!model) throw new Error('the openai provider needs a model (--model or IG_MODEL)');
  const url = `${(baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '')}/chat/completions`;
  return {
    name: 'openai',
    model,
    async chat({ system, messages, tools, seed }) {
      const body = {
        model,
        messages: toOpenAIMessages(system, messages),
        max_tokens: maxTokens,
      };
      if (tools?.length) {
        body.tools = tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
        body.tool_choice = 'auto';
      }
      if (temperature !== undefined) body.temperature = temperature;
      if (seed !== undefined) body.seed = seed;
      const { data } = await requestJson(url, { body, headers: await authHeaders(), timeoutMs, maxRetries, fetchImpl });
      const errors = validate(data, RESPONSE_SCHEMA, 'response');
      if (errors.length) throw new Error(`openai provider returned an unexpected response; ${errors.slice(0, 3).join('; ')}`);
      const msg = data.choices[0].message;
      const toolCalls = (msg.tool_calls || []).map((c, i) => {
        const parsed = parseArguments(c.function.arguments);
        return {
          id: c.id || `call_${i + 1}`,
          name: c.function.name,
          arguments: parsed.value ?? { _unparsable_arguments: String(c.function.arguments).slice(0, 500) },
          parseError: parsed.error,
        };
      });
      return {
        text: msg.content || '',
        toolCalls,
        usage: { inputTokens: data.usage?.prompt_tokens || 0, outputTokens: data.usage?.completion_tokens || 0 },
        model: data.model || model,
      };
    },
  };
}
