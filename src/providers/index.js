// The provider layer. One place decides which adapter talks to which model
// and how it authenticates. Everything else sees one interface:
//   provider.chat({ system, messages, tools, seed }) ->
//     { text, toolCalls: [{ id, name, arguments }], usage, model }
//
// Adapters: openai, anthropic, claude-cli, codex-cli, fake.
// Auth kinds: api-key, oauth, none (local servers), subscription (CLI adapters).

import { createOpenAIProvider } from './openai.js';
import { createAnthropicProvider } from './anthropic.js';
import { createClaudeCliProvider, createCodexCliProvider } from './cli.js';
import { createFakeProvider } from './fake.js';
import { OAuthClient, loadOAuthConfig } from '../auth/oauth.js';

export const PROVIDERS = ['openai', 'anthropic', 'claude-cli', 'codex-cli', 'fake'];
export const AUTH_KINDS = ['api-key', 'oauth', 'none', 'subscription'];

const DEFAULT_KEY_ENV = { openai: 'OPENAI_API_KEY', anthropic: 'ANTHROPIC_API_KEY' };

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** Decide the auth kind for an adapter when the user did not name one. */
export function defaultAuth(provider, env = process.env, apiKeyEnv) {
  if (provider === 'claude-cli' || provider === 'codex-cli') return 'subscription';
  if (provider === 'fake') return 'none';
  if (env[apiKeyEnv || DEFAULT_KEY_ENV[provider]]) return 'api-key';
  if (env.IG_OAUTH_CONFIG || env.IG_OAUTH_TOKEN_URL) return 'oauth';
  return provider === 'openai' ? 'none' : 'api-key';
}

/** Returns an async function giving the auth headers for one request. Keys stay in memory only. */
export function authHeadersFor({ provider, auth, apiKeyEnv, oauthConfigFile, env = process.env, fetchImpl, oauthDeps }) {
  if (auth === 'none') return async () => ({});
  if (auth === 'api-key') {
    const name = apiKeyEnv || DEFAULT_KEY_ENV[provider];
    const key = env[name];
    if (!key) throw new ConfigError(`auth api-key needs the environment variable ${name}`);
    if (provider === 'anthropic') return async () => ({ 'x-api-key': key });
    return async () => ({ authorization: `Bearer ${key}` });
  }
  if (auth === 'oauth') {
    const cfg = loadOAuthConfig({ file: oauthConfigFile, env });
    if (!cfg) throw new ConfigError('auth oauth needs IG_OAUTH_CONFIG, --oauth-config or IG_OAUTH_* variables');
    const client = new OAuthClient(cfg, { fetchImpl, env, ...oauthDeps });
    return async () => ({ authorization: `Bearer ${await client.accessToken()}` });
  }
  throw new ConfigError(`auth ${auth} does not apply to the ${provider} adapter`);
}

/**
 * Build a provider from resolved options.
 * opts: provider, model, baseUrl, auth, apiKeyEnv, oauthConfigFile,
 * timeoutMs, maxRetries, temperature, maxTokens, fakeScript, fakeScriptFile,
 * fetchImpl, env.
 */
export function createProvider(opts) {
  const env = opts.env || process.env;
  const provider = opts.provider;
  if (!PROVIDERS.includes(provider)) throw new ConfigError(`unknown provider ${provider}; use one of ${PROVIDERS.join(', ')}`);
  const auth = opts.auth || defaultAuth(provider, env, opts.apiKeyEnv);
  if (!AUTH_KINDS.includes(auth)) throw new ConfigError(`unknown auth ${auth}; use one of ${AUTH_KINDS.join(', ')}`);
  const common = {
    model: opts.model,
    timeoutMs: opts.timeoutMs || 120000,
    maxRetries: opts.maxRetries ?? 3,
    temperature: opts.temperature,
    maxTokens: opts.maxTokens || 1024,
    fetchImpl: opts.fetchImpl,
  };
  switch (provider) {
    case 'openai':
    case 'anthropic': {
      if (auth === 'subscription') {
        throw new ConfigError(`a subscription works only through the official CLIs; use --provider ${provider === 'openai' ? 'codex-cli' : 'claude-cli'}`);
      }
      const authHeaders = authHeadersFor({ provider, auth, apiKeyEnv: opts.apiKeyEnv, oauthConfigFile: opts.oauthConfigFile, env, fetchImpl: opts.fetchImpl });
      const baseUrl = opts.baseUrl || (provider === 'openai' ? env.OPENAI_BASE_URL : env.ANTHROPIC_BASE_URL);
      const make = provider === 'openai' ? createOpenAIProvider : createAnthropicProvider;
      const p = make({ ...common, baseUrl, authHeaders });
      p.auth = auth;
      return p;
    }
    case 'claude-cli':
    case 'codex-cli': {
      if (auth !== 'subscription') throw new ConfigError(`the ${provider} adapter uses the CLI's own sign in; auth must be subscription`);
      const make = provider === 'claude-cli' ? createClaudeCliProvider : createCodexCliProvider;
      const p = make({ model: opts.model, timeoutMs: opts.timeoutMs ? Math.max(opts.timeoutMs, 60000) : undefined, maxRetries: Math.min(common.maxRetries, 2) });
      p.auth = auth;
      return p;
    }
    case 'fake': {
      const p = createFakeProvider({ script: opts.fakeScript, scriptFile: opts.fakeScriptFile });
      p.auth = 'none';
      return p;
    }
    default:
      throw new ConfigError(`unknown provider ${provider}`);
  }
}
