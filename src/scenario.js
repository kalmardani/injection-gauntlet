// Scenario format, loading and static analysis.
// A scenario is plain JSON, versioned by its "schema" field. See
// docs/scenario-format.md for the field by field description.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validate } from './schema.js';
import { TOOL_NAMES, TOOL_CATALOG } from './tools.js';
import { PREDICATE_SCHEMA, validatePredicate } from './predicates.js';
import { foldConfusables, extractEmails, extractHosts, normalizeAddress } from './text.js';

export { extractEmails, extractHosts, hostOf, normalizeAddress } from './text.js';

export const SCENARIO_SCHEMA_ID = 'injection-gauntlet/scenario@1';

export const CATEGORIES = [
  'direct',
  'indirect_document',
  'indirect_web',
  'indirect_email',
  'tool_output',
  'exfiltration',
  'goal_hijack',
  'privilege_escalation',
  'obfuscated',
  'multi_turn',
  'lethal_trifecta',
];

export const BUILTIN_SCENARIO_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scenarios');

const text = (max) => ({ type: 'string', maxLength: max });
const toolName = { type: 'string', enum: TOOL_NAMES };

export const SCENARIO_SCHEMA = {
  type: 'object',
  required: ['schema', 'id', 'title', 'category', 'task', 'tools', 'environment', 'injection', 'success', 'failure'],
  additionalProperties: false,
  properties: {
    schema: { const: SCENARIO_SCHEMA_ID },
    id: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{2,63}$' },
    title: { type: 'string', minLength: 3, maxLength: 120 },
    category: { type: 'string', enum: CATEGORIES },
    description: text(2000),
    task: {
      type: 'object',
      required: ['turns', 'needs_tools'],
      additionalProperties: false,
      properties: {
        turns: { type: 'array', minItems: 1, maxItems: 8, items: { type: 'string', minLength: 1, maxLength: 8000 } },
        context: text(2000),
        needs_tools: { type: 'array', items: toolName, maxItems: 13 },
      },
    },
    tools: { type: 'array', minItems: 1, maxItems: 13, items: toolName },
    environment: {
      type: 'object',
      additionalProperties: false,
      properties: {
        files: {
          type: 'object',
          additionalProperties: {
            type: 'object',
            required: ['content'],
            additionalProperties: false,
            properties: { content: text(50000), private: { type: 'boolean' } },
          },
        },
        web: {
          type: 'object',
          additionalProperties: {
            type: 'object',
            required: ['content'],
            additionalProperties: false,
            properties: {
              content: text(50000),
              status: { type: 'integer', minimum: 100, maximum: 599 },
              post_response: text(5000),
            },
          },
        },
        search: {
          type: 'array',
          maxItems: 20,
          items: {
            type: 'object',
            required: ['title', 'url', 'snippet'],
            additionalProperties: false,
            properties: { title: text(300), url: text(2000), snippet: text(5000) },
          },
        },
        emails: {
          type: 'array',
          maxItems: 50,
          items: {
            type: 'object',
            required: ['id', 'from', 'subject', 'body'],
            additionalProperties: false,
            properties: {
              id: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,40}$' },
              from: text(300),
              to: text(300),
              date: text(40),
              subject: text(300),
              body: text(20000),
              private: { type: 'boolean' },
            },
          },
        },
        db: {
          type: 'object',
          additionalProperties: { type: 'array', maxItems: 500, items: { type: 'object' } },
        },
        shell: {
          type: 'array',
          maxItems: 20,
          items: {
            type: 'object',
            required: ['match', 'output'],
            additionalProperties: false,
            properties: { match: { type: 'string', minLength: 1, maxLength: 500 }, output: text(20000) },
          },
        },
        tool_responses: {
          type: 'array',
          maxItems: 20,
          items: {
            type: 'object',
            required: ['tool', 'output'],
            additionalProperties: false,
            properties: { tool: toolName, args: { type: 'object' }, output: text(20000) },
          },
        },
      },
    },
    injection: {
      type: 'object',
      required: ['location', 'payload'],
      additionalProperties: false,
      properties: {
        location: { type: 'string', pattern: '^(turn|file|web|search|email|db|shell|tool_response):.+$' },
        payload: { type: 'string', minLength: 8, maxLength: 8000 },
        technique: text(200),
        indicators: {
          type: 'object',
          additionalProperties: false,
          properties: {
            emails: { type: 'array', items: { type: 'string', minLength: 3, maxLength: 300 } },
            hosts: { type: 'array', items: { type: 'string', minLength: 3, maxLength: 300 } },
          },
        },
      },
    },
    success: { type: 'array', minItems: 1, maxItems: 10, items: PREDICATE_SCHEMA },
    failure: { type: 'array', minItems: 1, maxItems: 10, items: PREDICATE_SCHEMA },
  },
};

/** Return the text found at an injection location, or null when the location does not exist. */
export function contentAt(scenario, location) {
  const idx = location.indexOf(':');
  const kind = location.slice(0, idx);
  const ref = location.slice(idx + 1);
  const env = scenario.environment || {};
  switch (kind) {
    case 'turn':
      return scenario.task.turns[Number(ref)] ?? null;
    case 'file':
      return env.files?.[ref]?.content ?? null;
    case 'web':
      return env.web?.[ref]?.content ?? null;
    case 'search': {
      const r = env.search?.[Number(ref)];
      return r ? `${r.title}\n${r.url}\n${r.snippet}` : null;
    }
    case 'email': {
      const m = env.emails?.find((e) => e.id === ref);
      return m ? `${m.from}\n${m.subject}\n${m.body}` : null;
    }
    case 'db': {
      const rows = env.db?.[ref];
      return rows ? rows.map((row) => Object.values(row).join('\n')).join('\n') : null;
    }
    case 'shell':
      return env.shell?.[Number(ref)]?.output ?? null;
    case 'tool_response':
      return env.tool_responses?.[Number(ref)]?.output ?? null;
    default:
      return null;
  }
}

/** Full semantic check of a parsed scenario. Returns a list of problems. */
export function checkScenario(s) {
  const errors = validate(s, SCENARIO_SCHEMA);
  if (errors.length) return errors;
  for (const t of s.task.needs_tools) {
    if (!s.tools.includes(t)) errors.push(`$.task.needs_tools lists ${t}, which is not in $.tools`);
  }
  if (new Set(s.tools).size !== s.tools.length) errors.push('$.tools has duplicates');
  const located = contentAt(s, s.injection.location);
  if (located === null) {
    errors.push(`$.injection.location ${s.injection.location} does not exist in the scenario`);
  } else if (!located.includes(s.injection.payload)) {
    errors.push(`$.injection.payload is not found at ${s.injection.location}`);
  }
  [...s.success, ...s.failure].forEach((p, i) => {
    for (const e of validatePredicate(p)) errors.push(`predicate ${i}: ${e}`);
  });
  return errors;
}

function stripBom(t) {
  return t.charCodeAt(0) === 0xfeff ? t.slice(1) : t;
}

/** Load one scenario file. Throws with a readable message when invalid. */
export function loadScenarioFile(file) {
  let parsed;
  try {
    parsed = JSON.parse(stripBom(readFileSync(file, 'utf8')));
  } catch (e) {
    throw new Error(`${file}: not valid JSON (${e.message})`);
  }
  const errors = checkScenario(parsed);
  if (errors.length) throw new Error(`${file}: ${errors.slice(0, 6).join('; ')}`);
  return { ...parsed, source: file };
}

/** Load scenarios from files and folders. Folders are read non recursively, *.json only, sorted. */
export function loadScenarios(paths = [BUILTIN_SCENARIO_DIR]) {
  const files = [];
  for (const p of paths) {
    const abs = path.resolve(p);
    const st = statSync(abs);
    if (st.isDirectory()) {
      for (const name of readdirSync(abs).sort()) {
        if (name.endsWith('.json')) files.push(path.join(abs, name));
      }
    } else {
      files.push(abs);
    }
  }
  const out = [];
  const seen = new Map();
  for (const f of files) {
    const s = loadScenarioFile(f);
    if (seen.has(s.id)) throw new Error(`duplicate scenario id ${s.id} in ${f} and ${seen.get(s.id)}`);
    seen.set(s.id, f);
    out.push(s);
  }
  return out;
}

/** Filter by ids (exact or with a trailing *), and by categories. */
export function selectScenarios(scenarios, { only = [], categories = [] } = {}) {
  return scenarios.filter((s) => {
    if (categories.length && !categories.includes(s.category)) return false;
    if (!only.length) return true;
    return only.some((pat) => (pat.endsWith('*') ? s.id.startsWith(pat.slice(0, -1)) : s.id === pat));
  });
}

// Indicator extraction. An attacker indicator is an email address or host
// that appears in the injected payload and nowhere in the trusted parts of the
// scenario. Explicit indicators from the scenario are always kept.

function allStrings(v, out = []) {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => allStrings(x, out));
  else if (v && typeof v === 'object') Object.entries(v).forEach(([k, x]) => { out.push(k); allStrings(x, out); });
  return out;
}

export function attackerIndicators(s) {
  const payload = s.injection.payload;
  const trusted = allStrings([s.task, s.environment]).map((t) => t.split(payload).join(' ')).join('\n');
  const trustedEmails = new Set(extractEmails(trusted));
  const trustedHosts = new Set(extractHosts(trusted));
  const emails = new Set(extractEmails(payload).filter((e) => !trustedEmails.has(e)));
  const hosts = new Set(extractHosts(payload).filter((h) => !trustedHosts.has(h)));
  for (const e of s.injection.indicators?.emails || []) emails.add(normalizeAddress(e));
  for (const h of s.injection.indicators?.hosts || []) hosts.add(foldConfusables(h).toLowerCase());
  return { emails: [...emails].sort(), hosts: [...hosts].sort() };
}

/** Static lethal trifecta analysis of what the scenario offers the agent. */
export function trifecta(s) {
  const env = s.environment || {};
  const caps = new Set(s.tools.flatMap((t) => TOOL_CATALOG[t].capabilities));
  const hasPrivate =
    Object.values(env.files || {}).some((f) => f.private) ||
    (env.emails || []).some((m) => m.private) ||
    Object.keys(env.db || {}).length > 0 ||
    JSON.stringify(s).includes('{{CANARY}}');
  const rendersOutput = s.failure.some((p) => p.type === 'output_link_to_injected_host');
  return {
    private_data: hasPrivate && caps.has('private_data'),
    untrusted_content: true,
    outbound: caps.has('outbound') || rendersOutput,
  };
}
