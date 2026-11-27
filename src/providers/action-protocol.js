// JSON action protocol for model CLIs without native tool calling here
// (claude-cli and codex-cli). The model sees the tools and the transcript as
// text and answers with exactly one JSON object. The reply is validated by
// hand written checks; an invalid reply is retried once with the validation
// error, then the call fails closed.

import { validate } from '../schema.js';

export const PROTOCOL_INSTRUCTIONS = `You are acting as the model inside an agent loop. You can call the tools listed in the <tools> block.
Reply with exactly one JSON object and nothing else, in one of these two forms:
{"action":"tool_call","tool":"<tool name>","arguments":{...}}
{"action":"final","content":"<your answer to the user>"}
Call one tool at a time. After a tool call you will see its result in the transcript and can continue.
Use "final" when you are done with the user's current request.`;

const ACTION_SCHEMA = {
  anyOf: [
    {
      type: 'object',
      required: ['action', 'tool', 'arguments'],
      additionalProperties: false,
      properties: { action: { const: 'tool_call' }, tool: { type: 'string', minLength: 1 }, arguments: { type: 'object' } },
    },
    {
      type: 'object',
      required: ['action', 'content'],
      additionalProperties: false,
      properties: { action: { const: 'final' }, content: { type: 'string' } },
    },
  ],
};

export function renderTranscript(messages, tools) {
  const lines = ['<tools>', JSON.stringify(tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })), null, 1), '</tools>', '', '<transcript>'];
  for (const m of messages) {
    if (m.role === 'user') lines.push('[user]', m.content);
    else if (m.role === 'assistant') {
      if (m.toolCalls?.length) for (const c of m.toolCalls) lines.push('[assistant]', JSON.stringify({ action: 'tool_call', tool: c.name, arguments: c.arguments }));
      else lines.push('[assistant]', JSON.stringify({ action: 'final', content: m.content || '' }));
    } else if (m.role === 'tool') lines.push(`[tool result: ${m.name}${m.isError ? ', error' : ''}]`, m.content);
  }
  lines.push('</transcript>', '', 'Reply with one JSON object now.');
  return lines.join('\n');
}

/** Extract and validate one action from model text. Returns { action } or { error }. */
export function parseAction(text, toolNames) {
  let t = String(text || '').trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start < 0 || end < start) return { error: 'the reply contains no JSON object' };
  let obj;
  try {
    obj = JSON.parse(t.slice(start, end + 1));
  } catch (e) {
    return { error: `the reply is not valid JSON (${e.message})` };
  }
  const errors = validate(obj, ACTION_SCHEMA, 'reply');
  if (errors.length) return { error: errors.slice(0, 3).join('; ') };
  if (obj.action === 'tool_call' && !toolNames.includes(obj.tool)) {
    return { error: `unknown tool "${obj.tool}"; available tools are ${toolNames.join(', ')}` };
  }
  return { action: obj };
}

/**
 * Drive one model turn through a text completion function.
 * complete(prompt) returns { text, usage, model }.
 */
export async function chatViaActions({ complete, messages, tools, idPrefix }) {
  const names = tools.map((t) => t.name);
  let prompt = renderTranscript(messages, tools);
  const usage = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
  let model;
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await complete(prompt);
    usage.inputTokens += r.usage?.inputTokens || 0;
    usage.outputTokens += r.usage?.outputTokens || 0;
    usage.costUsd += r.usage?.costUsd || 0;
    model = r.model || model;
    const parsed = parseAction(r.text, names);
    if (parsed.action) {
      const a = parsed.action;
      if (a.action === 'final') return { text: a.content, toolCalls: [], usage, model };
      return { text: '', toolCalls: [{ id: `${idPrefix}_${messages.length}`, name: a.tool, arguments: a.arguments }], usage, model };
    }
    prompt = `${renderTranscript(messages, tools)}\n\nYour previous reply was rejected: ${parsed.error}. Reply with exactly one JSON object in one of the two allowed forms.`;
  }
  const err = new Error('model reply failed the JSON action protocol twice; failing closed');
  err.code = 'INVALID_OUTPUT';
  throw err;
}
