// The sandbox. Every simulated tool works on in-memory state built from the
// scenario. Nothing here reads or writes the real file system, opens a socket
// or runs a process. The sandbox records every call, executed or refused, so
// the predicates can judge the trial afterwards.

import { TOOL_CATALOG, toolDefinitions } from './tools.js';
import { validate } from './schema.js';
import { truncate } from './text.js';
import { rngFromSeed, randomHex } from './rng.js';

export const MAX_TOOL_OUTPUT = 8000;

function substitute(value, vars) {
  if (typeof value === 'string') return value.replace(/\{\{(CANARY)\}\}/g, (_, k) => vars[k]);
  if (Array.isArray(value)) return value.map((v) => substitute(v, vars));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [substitute(k, vars), substitute(v, vars)]));
  }
  return value;
}

/** Virtual paths use forward slashes and stay inside the workspace. */
export function normalizeVirtualPath(p) {
  const parts = [];
  for (const seg of String(p).replace(/\\/g, '/').split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') return null;
    parts.push(seg);
  }
  return parts.length ? parts.join('/') : null;
}

const SQL_WRITE = /^\s*(delete|drop|update|insert|alter|grant|revoke|truncate|create|replace)\b/i;

function matchArgs(want = {}, args = {}) {
  return Object.entries(want).every(([k, m]) => {
    const v = String(args[k] ?? '');
    if (typeof m === 'string') return v === m;
    if (m.equals !== undefined && v !== m.equals) return false;
    if (m.contains !== undefined && !v.includes(m.contains)) return false;
    if (m.icontains !== undefined && !v.toLowerCase().includes(m.icontains.toLowerCase())) return false;
    if (m.matches !== undefined && !new RegExp(m.matches, 'iu').test(v)) return false;
    return true;
  });
}

/**
 * Create a sandbox for one trial.
 * @param scenario  a validated scenario
 * @param options.seed       trial seed, drives the canary value
 * @param options.allowTools optional allowlist; tools outside it are not offered and calls are refused
 */
export function createSandbox(scenario, { seed = 1, allowTools = null } = {}) {
  const rng = rngFromSeed(seed);
  const canary = `ig_${randomHex(rng, 24)}`;
  const usesCanary = JSON.stringify(scenario).includes('{{CANARY}}');
  const env = substitute(structuredClone(scenario.environment || {}), { CANARY: canary });
  const turns = substitute(scenario.task.turns, { CANARY: canary });

  const files = new Map();
  for (const [p, f] of Object.entries(env.files || {})) {
    const key = normalizeVirtualPath(p);
    if (key) files.set(key, { content: f.content, private: !!f.private });
  }
  const initialFiles = new Map([...files].map(([k, v]) => [k, { ...v }]));
  const emails = (env.emails || []).map((m) => ({ ...m }));
  const db = structuredClone(env.db || {});
  const web = env.web || {};
  const offered = scenario.tools.filter((t) => !allowTools || allowTools.includes(t));
  const events = [];
  let seq = 0;
  let turn = 0;

  const ok = (content) => ({ content: truncate(content, MAX_TOOL_OUTPUT), isError: false });
  const fail = (content) => ({ content, isError: true });

  function lookupWeb(url) {
    let u;
    try {
      u = new URL(url);
    } catch {
      return null;
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    const candidates = [url, u.href, `${u.origin}${u.pathname}`, `${u.origin}${u.pathname.replace(/\/$/, '')}`];
    for (const c of candidates) if (web[c]) return web[c];
    return null;
  }

  function runSql(sql) {
    const text = sql.trim().replace(/;\s*$/, '');
    if (SQL_WRITE.test(text)) {
      const m = text.match(/^\s*(?:delete\s+from|drop\s+table|truncate\s+table|truncate)\s+["`]?(\w+)/i);
      if (m && db[m[1]]) {
        const where = text.match(/where\s+(\w+)\s*=\s*'?([^';]*)'?/i);
        if (/^\s*drop/i.test(text)) delete db[m[1]];
        else db[m[1]] = where ? db[m[1]].filter((r) => String(r[where[1]]) !== where[2]) : [];
      }
      return { tier: 'destructive', result: ok('Query OK (simulated). Statement applied.') };
    }
    const sel = text.match(/^\s*select\s+(.+?)\s+from\s+["`]?(\w+)["`]?(.*)$/is);
    if (!sel) return { tier: 'read', result: fail('Unsupported statement. Use SELECT columns FROM table [WHERE column = value] [LIMIT n].') };
    const [, colsRaw, table, rest] = sel;
    if (!db[table]) return { tier: 'read', result: fail(`Unknown table ${table}. Tables: ${Object.keys(db).join(', ') || 'none'}`) };
    let rows = db[table];
    const where = rest.match(/where\s+(\w+)\s*=\s*'?([^';]*?)'?(?:\s+limit|\s*$)/i);
    if (where) rows = rows.filter((r) => String(r[where[1]]) === where[2]);
    const limit = rest.match(/limit\s+(\d+)/i);
    if (limit) rows = rows.slice(0, Number(limit[1]));
    const cols = colsRaw.trim() === '*' ? null : colsRaw.split(',').map((c) => c.trim());
    if (/^\s*count\(\*\)\s*$/i.test(colsRaw)) return { tier: 'read', result: ok(JSON.stringify([{ count: rows.length }])) };
    const out = cols ? rows.map((r) => Object.fromEntries(cols.map((c) => [c, r[c]]))) : rows;
    return { tier: 'read', result: ok(JSON.stringify(out, null, 2)) };
  }

  function execute(name, args) {
    const override = (env.tool_responses || []).find((r) => r.tool === name && matchArgs(r.args, args));
    switch (name) {
      case 'list_files': {
        const dir = args.dir ? normalizeVirtualPath(args.dir) : '';
        const list = [...files.keys()].filter((p) => !dir || p.startsWith(`${dir}/`) || p === dir).sort();
        return ok(override?.output ?? (list.join('\n') || '(no files)'));
      }
      case 'read_file': {
        const p = normalizeVirtualPath(args.path);
        if (!p) return fail('Path must stay inside the workspace.');
        if (override) return ok(override.output);
        const f = files.get(p);
        return f ? ok(f.content) : fail(`File not found: ${p}`);
      }
      case 'write_file': {
        const p = normalizeVirtualPath(args.path);
        if (!p) return fail('Path must stay inside the workspace.');
        files.set(p, { content: args.content, private: false });
        return ok(override?.output ?? `Wrote ${args.content.length} characters to ${p}.`);
      }
      case 'delete_file': {
        const p = normalizeVirtualPath(args.path);
        if (!p) return fail('Path must stay inside the workspace.');
        if (!files.has(p)) return fail(`File not found: ${p}`);
        files.delete(p);
        return ok(override?.output ?? `Deleted ${p}.`);
      }
      case 'http_get': {
        if (override) return ok(override.output);
        const page = lookupWeb(args.url);
        if (!page) return fail('HTTP 404 Not Found');
        return (page.status || 200) >= 400 ? fail(`HTTP ${page.status}`) : ok(page.content);
      }
      case 'http_post': {
        if (override) return ok(override.output);
        const page = lookupWeb(args.url);
        return ok(page?.post_response ?? 'HTTP 200 OK');
      }
      case 'search_web': {
        if (override) return ok(override.output);
        return ok(JSON.stringify(env.search || [], null, 2));
      }
      case 'list_emails': {
        if (override) return ok(override.output);
        const list = emails.map((m) => ({ id: m.id, from: m.from, subject: m.subject, date: m.date || '' }));
        return ok(JSON.stringify(list, null, 2));
      }
      case 'read_email': {
        if (override) return ok(override.output);
        const m = emails.find((e) => e.id === args.id);
        if (!m) return fail(`No email with id ${args.id}`);
        return ok(`From: ${m.from}\nTo: ${m.to || ''}\nDate: ${m.date || ''}\nSubject: ${m.subject}\n\n${m.body}`);
      }
      case 'send_email':
        return ok(override?.output ?? 'Message sent (simulated).');
      case 'delete_email': {
        const i = emails.findIndex((e) => e.id === args.id);
        if (i < 0) return fail(`No email with id ${args.id}`);
        emails.splice(i, 1);
        return ok(override?.output ?? `Deleted email ${args.id}.`);
      }
      case 'run_shell': {
        if (override) return ok(override.output);
        const hit = (env.shell || []).find((s) => args.command.includes(s.match));
        return ok(hit ? hit.output : '(simulated shell: command recorded, no output)');
      }
      default:
        return fail(`Unknown tool ${name}`);
    }
  }

  /** Execute or refuse one tool call. Always records an event. */
  function call(name, args) {
    const event = { type: 'tool_call', seq: ++seq, turn, tool: String(name), args: args ?? {}, executed: false };
    events.push(event);
    if (!TOOL_CATALOG[name]) {
      event.refused = 'unknown_tool';
      return (event.result = fail(`Unknown tool ${name}. Available tools: ${offered.join(', ')}`));
    }
    if (!offered.includes(name)) {
      event.refused = scenario.tools.includes(name) ? 'not_allowed' : 'not_offered';
      return (event.result = fail(`Tool ${name} is not available in this session.`));
    }
    const errors = validate(args, TOOL_CATALOG[name].parameters, 'arguments');
    if (errors.length) {
      event.refused = 'invalid_arguments';
      return (event.result = fail(`Invalid arguments: ${errors.join('; ')}`));
    }
    event.tier = TOOL_CATALOG[name].tier;
    let result;
    if (name === 'run_query') {
      const r = runSql(args.sql);
      event.tier = r.tier;
      result = r.result;
    } else {
      result = execute(name, args);
    }
    event.executed = true;
    event.result = result;
    return result;
  }

  return {
    canary: usesCanary ? canary : null,
    turns,
    tools: toolDefinitions(offered),
    offered,
    events,
    files,
    initialFiles,
    call,
    setTurn(n) {
      turn = n;
    },
    record(event) {
      events.push({ seq: ++seq, turn, ...event });
    },
  };
}
