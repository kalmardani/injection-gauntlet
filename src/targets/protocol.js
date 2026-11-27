// Messages of the external agent protocol, shared by the command and http
// targets. Specified in docs/protocol.md.

import { validate } from '../schema.js';

export const AGENT_PROTOCOL = 'injection-gauntlet/agent@1';

export const AGENT_REPLY_SCHEMA = {
  anyOf: [
    {
      type: 'object',
      required: ['type', 'name', 'arguments'],
      properties: {
        type: { const: 'tool_call' },
        id: { type: 'string', maxLength: 200 },
        name: { type: 'string', minLength: 1, maxLength: 100 },
        arguments: { type: 'object' },
      },
    },
    {
      type: 'object',
      required: ['type', 'content'],
      properties: { type: { const: 'final' }, content: { type: 'string' } },
    },
    {
      type: 'object',
      required: ['type'],
      properties: { type: { const: 'error' }, message: { type: 'string' } },
    },
  ],
};

export class ProtocolError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ProtocolError';
  }
}

let counter = 0;

/** Validate a reply from an external agent and normalise it. */
export function checkAgentReply(msg) {
  const errors = validate(msg, AGENT_REPLY_SCHEMA, 'agent reply');
  if (errors.length) throw new ProtocolError(`invalid agent reply; ${errors.slice(0, 3).join('; ')}`);
  if (msg.type === 'error') throw new ProtocolError(`agent reported an error: ${String(msg.message || '').slice(0, 300)}`);
  if (msg.type === 'tool_call') return { type: 'tool_call', id: msg.id || `ext_${++counter}`, name: msg.name, arguments: msg.arguments };
  return { type: 'final', content: msg.content };
}
