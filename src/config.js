// Run configuration: defaults, then a JSON config file, then IG_* env vars,
// then command line flags. Paths in a config file resolve against the file's
// folder; paths on the command line resolve against the working directory.

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { ConfigError, PROVIDERS, AUTH_KINDS } from './providers/index.js';
import { TOOL_NAMES } from './tools.js';
import { CATEGORIES } from './scenario.js';

export const TARGETS = ['reference', 'command', 'http'];

export const DEFAULTS = {
  target: 'reference',
  provider: null,
  model: null,
  base_url: null,
  auth: null,
  api_key_env: null,
  oauth_config: null,
  url: null,
  command: null,
  scenarios: null,
  only: [],
  category: [],
  k: 1,
  seed: 1,
  max_asr: null,
  out: null,
  json: null,
  html: null,
  system_prompt_file: null,
  allow_tools: null,
  max_steps: 10,
  max_tool_calls: 30,
  timeout_ms: 120000,
  trial_timeout_ms: 600000,
  concurrency: 1,
  temperature: null,
  max_tokens: 1024,
  fake_script: null,
  quiet: false,
};

// flag name -> [config key, kind]
export const FLAGS = {
  config: ['config', 'string'],
  target: ['target', 'string'],
  provider: ['provider', 'string'],
  model: ['model', 'string'],
  'base-url': ['base_url', 'string'],
  auth: ['auth', 'string'],
  'api-key-env': ['api_key_env', 'string'],
  'oauth-config': ['oauth_config', 'path'],
  url: ['url', 'string'],
  scenarios: ['scenarios', 'paths'],
  only: ['only', 'list'],
  category: ['category', 'list'],
  k: ['k', 'int'],
  seed: ['seed', 'int'],
  'max-asr': ['max_asr', 'ratio'],
  out: ['out', 'path'],
  json: ['json', 'path'],
  html: ['html', 'path'],
  'system-prompt-file': ['system_prompt_file', 'path'],
  'allow-tools': ['allow_tools', 'list'],
  'max-steps': ['max_steps', 'int'],
  'max-tool-calls': ['max_tool_calls', 'int'],
  timeout: ['timeout_ms', 'int'],
  'trial-timeout': ['trial_timeout_ms', 'int'],
  concurrency: ['concurrency', 'int'],
  temperature: ['temperature', 'number'],
  'max-tokens': ['max_tokens', 'int'],
  'fake-script': ['fake_script', 'path'],
  quiet: ['quiet', 'bool'],
  help: ['help', 'bool'],
};

const ENV = {
  IG_TARGET: 'target',
  IG_PROVIDER: 'provider',
  IG_MODEL: 'model',
  IG_BASE_URL: 'base_url',
  IG_AUTH: 'auth',
  IG_API_KEY_ENV: 'api_key_env',
  IG_URL: 'url',
  IG_K: 'k',
  IG_SEED: 'seed',
  IG_TIMEOUT_MS: 'timeout_ms',
};

/** Parse argv into { positionals, flags, rest }. rest is everything after "--". */
export function parseArgs(argv) {
  const positionals = [];
  const flags = {};
  let rest = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      rest = argv.slice(i + 1);
      break;
    }
    if (a.startsWith('--')) {
      let name = a.slice(2);
      let value;
      const eq = name.indexOf('=');
      if (eq >= 0) {
        value = name.slice(eq + 1);
        name = name.slice(0, eq);
      }
      const spec = FLAGS[name];
      if (!spec) throw new ConfigError(`unknown option --${name}`);
      if (spec[1] === 'bool') {
        flags[name] = value === undefined ? true : value !== 'false';
        continue;
      }
      if (value === undefined) {
        value = argv[++i];
        if (value === undefined) throw new ConfigError(`--${name} needs a value`);
      }
      if (spec[1] === 'paths' || spec[1] === 'list') (flags[name] ||= []).push(value);
      else flags[name] = value;
    } else {
      positionals.push(a);
    }
  }
  return { positionals, flags, rest };
}

function convert(key, kind, raw, base) {
  switch (kind) {
    case 'int': {
      const n = Number(raw);
      if (!Number.isInteger(n)) throw new ConfigError(`${key} must be an integer`);
      return n;
    }
    case 'number': {
      const n = Number(raw);
      if (!Number.isFinite(n)) throw new ConfigError(`${key} must be a number`);
      return n;
    }
    case 'ratio': {
      const s = String(raw).trim();
      const n = s.endsWith('%') ? Number(s.slice(0, -1)) / 100 : Number(s);
      if (!Number.isFinite(n) || n < 0 || n > 1) throw new ConfigError(`${key} must be between 0 and 1, or a percentage`);
      return n;
    }
    case 'path':
      return path.resolve(base, String(raw));
    case 'paths':
      return [].concat(raw).map((p) => path.resolve(base, String(p)));
    case 'list':
      return [].concat(raw).flatMap((x) => String(x).split(',')).map((x) => x.trim()).filter(Boolean);
    case 'bool':
      return raw === true || raw === 'true' || raw === '1';
    default:
      return raw === null || raw === undefined ? raw : String(raw);
  }
}

const KIND_BY_KEY = Object.fromEntries(Object.values(FLAGS).map(([k, kind]) => [k, kind]));

/** Make relative file arguments of the agent command absolute, since the agent runs in a temp folder. */
export function absolutizeCommand(command, base) {
  return command.map((arg, i) => {
    if (i === 0 && !/[\\/]/.test(arg)) return arg;
    if (arg.startsWith('-')) return arg;
    const abs = path.resolve(base, arg);
    return existsSync(abs) ? abs : arg;
  });
}

export function resolveConfig({ flags = {}, rest = null, env = process.env, cwd = process.cwd(), allowIncomplete = false }) {
  const cfg = { ...DEFAULTS };
  let targetSet = !!flags.target || !!env.IG_TARGET;
  const configFile = flags.config ? path.resolve(cwd, flags.config) : null;
  if (configFile) {
    let data;
    try {
      data = JSON.parse(readFileSync(configFile, 'utf8'));
    } catch (e) {
      throw new ConfigError(`cannot read config ${configFile}: ${e.message}`);
    }
    const base = path.dirname(configFile);
    for (const [k, v] of Object.entries(data)) {
      if (k === '$comment') continue;
      if (k === 'target') targetSet = true;
      if (!(k in DEFAULTS)) throw new ConfigError(`unknown key "${k}" in ${configFile}`);
      if (k === 'command') {
        if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) throw new ConfigError('command must be an array of strings');
        cfg.command = absolutizeCommand(v, base);
      } else {
        cfg[k] = v === null ? null : convert(k, KIND_BY_KEY[k], v, base);
      }
    }
  }
  for (const [name, key] of Object.entries(ENV)) {
    if (env[name] !== undefined && env[name] !== '') cfg[key] = convert(key, KIND_BY_KEY[key], env[name], cwd);
  }
  for (const [name, value] of Object.entries(flags)) {
    const [key, kind] = FLAGS[name];
    if (key === 'config' || key === 'help') continue;
    cfg[key] = convert(key, kind, value, cwd);
  }
  if (rest && rest.length) cfg.command = absolutizeCommand(rest, cwd);
  if (cfg.command && !targetSet) cfg.target = 'command';
  return check(cfg, allowIncomplete);
}

function check(cfg, allowIncomplete) {
  if (!TARGETS.includes(cfg.target)) throw new ConfigError(`unknown target ${cfg.target}; use one of ${TARGETS.join(', ')}`);
  cfg.target_ready = !(cfg.target === 'reference' && !cfg.provider);
  if (allowIncomplete && !cfg.target_ready) return cfg;
  if (cfg.target === 'reference') {
    if (!cfg.provider) throw new ConfigError('the reference target needs --provider (openai, anthropic, claude-cli, codex-cli or fake)');
    if (!PROVIDERS.includes(cfg.provider)) throw new ConfigError(`unknown provider ${cfg.provider}`);
  }
  if (cfg.auth && !AUTH_KINDS.includes(cfg.auth)) throw new ConfigError(`unknown auth ${cfg.auth}`);
  if (cfg.target === 'command' && !cfg.command?.length) throw new ConfigError('the command target needs the agent command after --, for example: -- node my-agent.js');
  if (cfg.target === 'http' && !cfg.url) throw new ConfigError('the http target needs --url');
  if (cfg.k < 1 || cfg.k > 100) throw new ConfigError('k must be between 1 and 100');
  if (cfg.concurrency < 1 || cfg.concurrency > 16) throw new ConfigError('concurrency must be between 1 and 16');
  for (const t of cfg.allow_tools || []) if (!TOOL_NAMES.includes(t)) throw new ConfigError(`--allow-tools names an unknown tool ${t}`);
  for (const c of cfg.category || []) if (!CATEGORIES.includes(c)) throw new ConfigError(`unknown category ${c}; use one of ${CATEGORIES.join(', ')}`);
  if (cfg.target === 'http' && cfg.url) {
    try {
      new URL(cfg.url);
    } catch {
      throw new ConfigError('--url is not a valid URL');
    }
  }
  return cfg;
}
