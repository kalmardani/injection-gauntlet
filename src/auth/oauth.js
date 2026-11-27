// Generic OAuth 2.0 client with three grants: client credentials,
// authorization code with PKCE (S256) and a loopback redirect, and the device
// authorization grant. It only talks to the endpoints the user configured.
// Tokens go to the token cache and are never printed or logged.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { requestJson } from '../providers/http.js';
import { validate } from '../schema.js';
import { TokenStore } from './store.js';

export class AuthError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AuthError';
  }
}

export const GRANTS = ['client_credentials', 'pkce', 'device'];

const CONFIG_SCHEMA = {
  type: 'object',
  required: ['grant', 'token_url', 'client_id'],
  additionalProperties: false,
  properties: {
    grant: { type: 'string', enum: GRANTS },
    token_url: { type: 'string', minLength: 8 },
    auth_url: { type: 'string', minLength: 8 },
    device_url: { type: 'string', minLength: 8 },
    client_id: { type: 'string', minLength: 1, maxLength: 500 },
    client_secret_env: { type: 'string', pattern: '^[A-Za-z_][A-Za-z0-9_]*$' },
    client_auth: { type: 'string', enum: ['post', 'basic'] },
    scope: { type: 'string', maxLength: 2000 },
    audience: { type: 'string', maxLength: 2000 },
    redirect_port: { type: 'integer', minimum: 0, maximum: 65535 },
  },
};

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

function checkEndpoint(name, value) {
  let u;
  try {
    u = new URL(value);
  } catch {
    throw new AuthError(`${name} is not a valid URL`);
  }
  if (u.protocol === 'https:') return;
  if (u.protocol === 'http:' && LOOPBACK.has(u.hostname)) return;
  throw new AuthError(`${name} must use https (plain http is accepted only for a loopback address)`);
}

/** Build the OAuth config from a JSON file and IG_OAUTH_* env vars (env wins). */
export function loadOAuthConfig({ file, env = process.env } = {}) {
  let cfg = {};
  const source = file || env.IG_OAUTH_CONFIG;
  if (source) cfg = JSON.parse(readFileSync(source, 'utf8'));
  const fromEnv = {
    grant: env.IG_OAUTH_GRANT,
    token_url: env.IG_OAUTH_TOKEN_URL,
    auth_url: env.IG_OAUTH_AUTH_URL,
    device_url: env.IG_OAUTH_DEVICE_URL,
    client_id: env.IG_OAUTH_CLIENT_ID,
    client_secret_env: env.IG_OAUTH_CLIENT_SECRET_ENV,
    client_auth: env.IG_OAUTH_CLIENT_AUTH,
    scope: env.IG_OAUTH_SCOPE,
    audience: env.IG_OAUTH_AUDIENCE,
  };
  for (const [k, v] of Object.entries(fromEnv)) if (v) cfg[k] = v;
  if (!Object.keys(cfg).length) return null;
  const errors = validate(cfg, CONFIG_SCHEMA, 'oauth');
  if (errors.length) throw new AuthError(`OAuth config is invalid; ${errors.join('; ')}`);
  checkEndpoint('token_url', cfg.token_url);
  if (cfg.grant === 'pkce') {
    if (!cfg.auth_url) throw new AuthError('the pkce grant needs auth_url');
    checkEndpoint('auth_url', cfg.auth_url);
  }
  if (cfg.grant === 'device') {
    if (!cfg.device_url) throw new AuthError('the device grant needs device_url');
    checkEndpoint('device_url', cfg.device_url);
  }
  return cfg;
}

export const base64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** PKCE pair per RFC 7636, method S256. */
export function pkcePair(bytes = randomBytes(32)) {
  const verifier = base64url(bytes);
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

function sameString(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Open a URL in the default browser without a shell. Best effort, returns false on failure. */
export function openBrowser(url) {
  const u = new URL(url);
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
  const [file, args] =
    process.platform === 'darwin'
      ? ['open', [u.href]]
      : process.platform === 'win32'
        ? ['rundll32', ['url.dll,FileProtocolHandler', u.href]]
        : ['xdg-open', [u.href]];
  try {
    const child = spawn(file, args, { shell: false, stdio: 'ignore', detached: true, windowsHide: true });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

const TOKEN_RESPONSE = {
  type: 'object',
  required: ['access_token'],
  properties: {
    access_token: { type: 'string', minLength: 1 },
    token_type: { type: 'string' },
    expires_in: { type: ['integer', 'number', 'string'] },
    refresh_token: { type: 'string' },
    scope: { type: 'string' },
  },
};

export class OAuthClient {
  /**
   * deps: fetchImpl, now, sleep, store, openUrl, log (writes user facing
   * lines, never tokens), env, timeoutMs.
   */
  constructor(config, deps = {}) {
    this.config = config;
    this.fetchImpl = deps.fetchImpl || globalThis.fetch;
    this.now = deps.now || (() => Date.now());
    this.sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.store = deps.store || new TokenStore();
    this.openUrl = deps.openUrl || openBrowser;
    this.log = deps.log || ((line) => process.stderr.write(`${line}\n`));
    this.env = deps.env || process.env;
    this.timeoutMs = deps.timeoutMs || 30000;
  }

  get cacheKey() {
    const c = this.config;
    return createHash('sha256')
      .update([c.token_url, c.client_id, c.scope || '', c.audience || ''].join('\n'))
      .digest('hex')
      .slice(0, 32);
  }

  clientSecret() {
    const name = this.config.client_secret_env || 'IG_OAUTH_CLIENT_SECRET';
    return this.env[name] || null;
  }

  async tokenRequest(params) {
    const form = new URLSearchParams(params);
    const headers = {};
    const secret = this.clientSecret();
    if (secret && this.config.client_auth === 'basic') {
      const enc = (x) => encodeURIComponent(x);
      headers.authorization = `Basic ${Buffer.from(`${enc(this.config.client_id)}:${enc(secret)}`).toString('base64')}`;
    } else {
      form.set('client_id', this.config.client_id);
      if (secret) form.set('client_secret', secret);
    }
    if (this.config.audience && !form.has('audience')) form.set('audience', this.config.audience);
    const { data } = await requestJson(this.config.token_url, {
      method: 'POST',
      body: form,
      headers,
      timeoutMs: this.timeoutMs,
      maxRetries: 2,
      fetchImpl: this.fetchImpl,
      sleep: this.sleep,
      acceptStatus: [400, 401, 403],
    });
    if (data && typeof data.error === 'string') return { error: data.error, description: data.error_description || '' };
    const errors = validate(data, TOKEN_RESPONSE, 'token response');
    if (errors.length) throw new AuthError(`token endpoint returned an unexpected response; ${errors.join('; ')}`);
    return { tokens: data };
  }

  save(tokens, previous) {
    const seconds = Number(tokens.expires_in);
    const entry = {
      access_token: tokens.access_token,
      token_type: tokens.token_type || 'Bearer',
      expires_at: this.now() + (Number.isFinite(seconds) && seconds > 0 ? seconds : 3600) * 1000,
      refresh_token: tokens.refresh_token || previous?.refresh_token || null,
      scope: tokens.scope || this.config.scope || null,
      grant: this.config.grant,
      token_url_host: new URL(this.config.token_url).host,
      saved_at: new Date(this.now()).toISOString(),
    };
    this.store.set(this.cacheKey, entry);
    return entry;
  }

  /** A valid access token, refreshed before expiry. Throws AuthError when a login is needed. */
  async accessToken() {
    const entry = this.store.get(this.cacheKey);
    const marginMs = 60000;
    if (entry && entry.expires_at - marginMs > this.now()) return entry.access_token;
    if (entry?.refresh_token) {
      const r = await this.tokenRequest({ grant_type: 'refresh_token', refresh_token: entry.refresh_token });
      if (r.tokens) return this.save(r.tokens, entry).access_token;
      this.store.delete(this.cacheKey);
    }
    if (this.config.grant === 'client_credentials') return (await this.loginClientCredentials()).access_token;
    throw new AuthError('no valid OAuth token; run "injection-gauntlet auth login oauth" first');
  }

  async login() {
    if (this.config.grant === 'client_credentials') return this.loginClientCredentials();
    if (this.config.grant === 'pkce') return this.loginPkce();
    return this.loginDevice();
  }

  async loginClientCredentials() {
    const params = { grant_type: 'client_credentials' };
    if (this.config.scope) params.scope = this.config.scope;
    const r = await this.tokenRequest(params);
    if (r.error) throw new AuthError(`client credentials grant refused: ${r.error} ${r.description}`.trim());
    return this.save(r.tokens);
  }

  /** Authorization code with PKCE and a loopback redirect on 127.0.0.1. */
  async loginPkce({ timeoutMs = 300000 } = {}) {
    const { verifier, challenge } = pkcePair();
    const state = base64url(randomBytes(16));
    const server = http.createServer();
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.config.redirect_port || 0, '127.0.0.1', resolve);
    });
    const redirectUri = `http://127.0.0.1:${server.address().port}/callback`;
    try {
      const url = new URL(this.config.auth_url);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('client_id', this.config.client_id);
      url.searchParams.set('redirect_uri', redirectUri);
      if (this.config.scope) url.searchParams.set('scope', this.config.scope);
      if (this.config.audience) url.searchParams.set('audience', this.config.audience);
      url.searchParams.set('state', state);
      url.searchParams.set('code_challenge', challenge);
      url.searchParams.set('code_challenge_method', 'S256');
      this.log('Open this URL in a browser to sign in:');
      this.log(url.href);
      this.openUrl(url.href);
      const code = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new AuthError('sign in timed out')), timeoutMs);
        server.on('request', (req, res) => {
          const u = new URL(req.url, redirectUri);
          if (u.pathname !== '/callback') {
            res.writeHead(404).end();
            return;
          }
          const finish = (status, text, err, value) => {
            res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' }).end(text);
            clearTimeout(timer);
            if (err) reject(err);
            else resolve(value);
          };
          if (!sameString(u.searchParams.get('state') || '', state)) {
            finish(400, 'State mismatch. Sign in was not completed.', new AuthError('state mismatch on the OAuth callback'));
          } else if (u.searchParams.get('error')) {
            finish(400, 'Sign in was refused.', new AuthError(`authorization refused: ${u.searchParams.get('error')}`));
          } else if (!u.searchParams.get('code')) {
            finish(400, 'Missing code.', new AuthError('callback without an authorization code'));
          } else {
            finish(200, 'Signed in. You can close this tab.', null, u.searchParams.get('code'));
          }
        });
      });
      const r = await this.tokenRequest({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        code_verifier: verifier,
      });
      if (r.error) throw new AuthError(`code exchange refused: ${r.error} ${r.description}`.trim());
      return this.save(r.tokens);
    } finally {
      server.close();
    }
  }

  /** Device authorization grant (RFC 8628). */
  async loginDevice() {
    const form = { client_id: this.config.client_id };
    if (this.config.scope) form.scope = this.config.scope;
    if (this.config.audience) form.audience = this.config.audience;
    const { data } = await requestJson(this.config.device_url, {
      method: 'POST',
      body: new URLSearchParams(form),
      timeoutMs: this.timeoutMs,
      maxRetries: 2,
      fetchImpl: this.fetchImpl,
      sleep: this.sleep,
    });
    const errors = validate(data, {
      type: 'object',
      required: ['device_code', 'user_code', 'verification_uri'],
      properties: {
        device_code: { type: 'string', minLength: 1 },
        user_code: { type: 'string', minLength: 1, maxLength: 100 },
        verification_uri: { type: 'string', minLength: 8 },
        expires_in: { type: ['integer', 'number'] },
        interval: { type: ['integer', 'number'] },
      },
    });
    if (errors.length) throw new AuthError(`device endpoint returned an unexpected response; ${errors.join('; ')}`);
    this.log(`To sign in, open ${data.verification_uri} and enter the code ${data.user_code}`);
    if (data.verification_uri_complete) this.log(`Or open ${data.verification_uri_complete}`);
    let interval = Math.max(1, Number(data.interval) || 5);
    const deadline = this.now() + (Number(data.expires_in) || 900) * 1000;
    while (this.now() < deadline) {
      await this.sleep(interval * 1000);
      const r = await this.tokenRequest({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: data.device_code,
      });
      if (r.tokens) return this.save(r.tokens);
      if (r.error === 'authorization_pending') continue;
      if (r.error === 'slow_down') {
        interval += 5;
        continue;
      }
      throw new AuthError(`device sign in failed: ${r.error} ${r.description}`.trim());
    }
    throw new AuthError('device code expired before sign in finished');
  }

  status() {
    const e = this.store.get(this.cacheKey);
    if (!e) return { signed_in: false };
    return {
      signed_in: true,
      valid: e.expires_at > this.now(),
      expires_at: new Date(e.expires_at).toISOString(),
      refreshable: !!e.refresh_token,
      scope: e.scope,
      grant: e.grant,
      token_host: e.token_url_host,
    };
  }

  logout() {
    return this.store.delete(this.cacheKey);
  }
}
