import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, statSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OAuthClient, loadOAuthConfig, pkcePair, base64url, AuthError } from '../src/auth/oauth.js';
import { TokenStore, userConfigDir } from '../src/auth/store.js';
import { authHeadersFor } from '../src/providers/index.js';
import { cliSignedIn, cliInstalled, loginSubscription } from '../src/auth/subscription.js';
import { startTokenServer } from '../test-support/token-server.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'ig-auth-'));

function client(cfg, extra = {}) {
  const dir = tmp();
  const lines = [];
  const c = new OAuthClient(cfg, { store: new TokenStore(dir), log: (l) => lines.push(l), sleep: async () => {}, ...extra });
  c.lines = lines;
  c.dir = dir;
  return c;
}

test('PKCE verifier and S256 challenge follow RFC 7636', () => {
  // Test vector from RFC 7636 appendix B.
  const bytes = Buffer.from([116, 24, 223, 180, 151, 153, 224, 37, 79, 250, 96, 125, 216, 173, 187, 186, 22, 212, 37, 77, 105, 214, 191, 240, 91, 88, 5, 88, 83, 132, 141, 121]);
  const { verifier, challenge } = pkcePair(bytes);
  assert.equal(verifier, 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk');
  assert.equal(challenge, 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  const fresh = pkcePair();
  assert.match(fresh.verifier, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(fresh.challenge, base64url(createHash('sha256').update(fresh.verifier).digest()));
});

test('config loader validates grants and refuses plain http outside loopback', () => {
  assert.equal(loadOAuthConfig({ env: {} }), null);
  const ok = loadOAuthConfig({ env: { IG_OAUTH_GRANT: 'client_credentials', IG_OAUTH_TOKEN_URL: 'http://127.0.0.1:1/token', IG_OAUTH_CLIENT_ID: 'svc' } });
  assert.equal(ok.grant, 'client_credentials');
  assert.throws(() => loadOAuthConfig({ env: { IG_OAUTH_GRANT: 'client_credentials', IG_OAUTH_TOKEN_URL: 'http://gateway.example/token', IG_OAUTH_CLIENT_ID: 'svc' } }), /https/);
  assert.throws(() => loadOAuthConfig({ env: { IG_OAUTH_GRANT: 'pkce', IG_OAUTH_TOKEN_URL: 'https://a.example/t', IG_OAUTH_CLIENT_ID: 'x' } }), /auth_url/);
  assert.throws(() => loadOAuthConfig({ env: { IG_OAUTH_GRANT: 'magic', IG_OAUTH_TOKEN_URL: 'https://a.example/t', IG_OAUTH_CLIENT_ID: 'x' } }), AuthError);
});

test('client credentials: token fetched, cached with 0600, reused, secret only in the request', async () => {
  const srv = await startTokenServer();
  try {
    const c = client({ grant: 'client_credentials', token_url: `${srv.base}/token`, client_id: 'svc', scope: 'llm.read' }, { env: { IG_OAUTH_CLIENT_SECRET: 's3cret' } });
    assert.equal(await c.accessToken(), 'at_1');
    assert.equal(await c.accessToken(), 'at_1', 'cached token is reused');
    assert.equal(srv.state.requests.length, 1);
    assert.equal(srv.state.requests[0].form.client_secret, 's3cret');
    assert.equal(srv.state.requests[0].form.scope, 'llm.read');
    const file = path.join(c.dir, 'tokens.json');
    if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.ok(!readFileSync(file, 'utf8').includes('s3cret'), 'the client secret is never cached');
    assert.ok(!c.lines.join('\n').includes('at_1'), 'tokens are never logged');
    assert.equal(c.status().signed_in, true);
    assert.equal(c.logout(), true);
    assert.equal(c.status().signed_in, false);
    const basic = client({ grant: 'client_credentials', token_url: `${srv.base}/token`, client_id: 'svc', client_auth: 'basic' }, { env: { IG_OAUTH_CLIENT_SECRET: 's3cret' } });
    await basic.accessToken();
    assert.equal(srv.state.requests.at(-1).headers.authorization, `Basic ${Buffer.from('svc:s3cret').toString('base64')}`);
    const wrong = client({ grant: 'client_credentials', token_url: `${srv.base}/token`, client_id: 'nobody' });
    await assert.rejects(wrong.accessToken(), /invalid_client/);
  } finally {
    await srv.close();
  }
});

test('expiry and refresh: an expired token is refreshed before use, a dead refresh token forces login', async () => {
  const srv = await startTokenServer({ expiresIn: 120 });
  try {
    let now = 1_000_000;
    const c = client({ grant: 'device', token_url: `${srv.base}/token`, device_url: `${srv.base}/device`, client_id: 'cli' }, { now: () => now });
    srv.state.devicePlan = ['ok'];
    await c.login();
    assert.equal(await c.accessToken(), 'at_1');
    now += 61_000; // inside the 60 s safety margin before expiry
    assert.equal(await c.accessToken(), 'at_2', 'refreshed before expiry');
    assert.equal(srv.state.requests.at(-1).form.grant_type, 'refresh_token');
    assert.equal(srv.state.requests.at(-1).form.refresh_token, 'rt_1');
    now += 200_000;
    srv.state.refreshValid = false;
    await assert.rejects(c.accessToken(), /auth login oauth/);
    assert.equal(c.status().signed_in, false, 'the dead entry is removed');
  } finally {
    await srv.close();
  }
});

test('device grant polls through authorization_pending and slow_down', async () => {
  const srv = await startTokenServer({ devicePlan: ['authorization_pending', 'slow_down', 'authorization_pending', 'ok'] });
  try {
    const sleeps = [];
    const c = client({ grant: 'device', token_url: `${srv.base}/token`, device_url: `${srv.base}/device`, client_id: 'cli', scope: 'openid' }, { sleep: async (ms) => sleeps.push(ms) });
    const entry = await c.login();
    assert.equal(entry.access_token, 'at_1');
    assert.deepEqual(sleeps, [1000, 1000, 6000, 6000], 'slow_down adds five seconds to the interval');
    assert.ok(c.lines.some((l) => l.includes('ABCD-EFGH')), 'the user code is shown');
    const denied = await startTokenServer({ devicePlan: ['access_denied'] });
    const d = client({ grant: 'device', token_url: `${denied.base}/token`, device_url: `${denied.base}/device`, client_id: 'cli' });
    await assert.rejects(d.login(), /access_denied/);
    await denied.close();
  } finally {
    await srv.close();
  }
});

async function pkceLogin(srv, tamper) {
  let opened;
  const c = client(
    { grant: 'pkce', token_url: `${srv.base}/token`, auth_url: `${srv.base}/authorize`, client_id: 'app', scope: 'openid' },
    { openUrl: (u) => (opened = u) },
  );
  const done = c.login().then((v) => ({ v }), (e) => ({ e }));
  while (!opened) await new Promise((r) => setTimeout(r, 10));
  const u = new URL(opened);
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(u.searchParams.get('response_type'), 'code');
  const redirect = new URL(u.searchParams.get('redirect_uri'));
  assert.equal(redirect.hostname, '127.0.0.1');
  srv.state.codes.set('code-1', { challenge: u.searchParams.get('code_challenge') });
  const state = tamper === 'state' ? 'forged' : u.searchParams.get('state');
  const res = await fetch(`${redirect.href}?code=code-1&state=${encodeURIComponent(state)}`);
  return { done, res, c };
}

test('PKCE login: loopback redirect, state check and verifier exchange', async () => {
  const srv = await startTokenServer();
  try {
    const { done, res, c } = await pkceLogin(srv);
    assert.equal(res.status, 200);
    const { v: entry } = await done;
    assert.equal(entry.access_token, 'at_1');
    const exchange = srv.state.requests.find((r) => r.form.grant_type === 'authorization_code');
    assert.ok(exchange.form.code_verifier.length >= 43);
    assert.ok(c.lines.some((l) => l.startsWith('http://127.0.0.1')), 'the URL is printed for a manual open');
    const bad = await pkceLogin(srv, 'state');
    assert.equal(bad.res.status, 400);
    const { e } = await bad.done;
    assert.match(e.message, /state mismatch/);
  } finally {
    await srv.close();
  }
});

test('oauth auth headers feed the provider layer', async () => {
  const srv = await startTokenServer();
  const dir = tmp();
  try {
    const env = { IG_OAUTH_GRANT: 'client_credentials', IG_OAUTH_TOKEN_URL: `${srv.base}/token`, IG_OAUTH_CLIENT_ID: 'svc', IG_CONFIG_DIR: dir };
    const headers = authHeadersFor({ provider: 'openai', auth: 'oauth', env, oauthDeps: { store: new TokenStore(dir) } });
    assert.deepEqual(await headers(), { authorization: 'Bearer at_1' });
    assert.deepEqual(await headers(), { authorization: 'Bearer at_1' });
  } finally {
    await srv.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('config dir follows the platform conventions', () => {
  assert.ok(userConfigDir('win32', { APPDATA: 'C:\\Users\\u\\AppData\\Roaming' }).includes('AppData'));
  assert.ok(userConfigDir('darwin', {}).includes(path.join('Library', 'Application Support')));
  assert.equal(userConfigDir('linux', { XDG_CONFIG_HOME: '/x/cfg' }), path.join('/x/cfg', 'injection-gauntlet'));
  assert.equal(userConfigDir('linux', { IG_CONFIG_DIR: '/y' }), path.resolve('/y'));
});

test('subscription login drives the official CLIs and never touches their credentials', async () => {
  const state = tmp();
  const saved = { ...process.env };
  process.env.IG_CLAUDE_BIN = process.execPath;
  process.env.IG_CLAUDE_BIN_ARGS = JSON.stringify([path.join(ROOT, 'test-support', 'fake-claude.js')]);
  process.env.IG_CODEX_BIN = process.execPath;
  process.env.IG_CODEX_BIN_ARGS = JSON.stringify([path.join(ROOT, 'test-support', 'fake-codex.js')]);
  process.env.FAKE_CLI_STATE = state;
  try {
    assert.deepEqual((await cliInstalled('claude')).installed, true);
    assert.equal(await cliSignedIn('claude'), false);
    const log = [];
    const r = await loginSubscription('claude', { log: (l) => log.push(l) });
    assert.equal(r.ok, true);
    assert.equal(r.already, false);
    assert.equal(await cliSignedIn('claude'), true);
    const again = await loginSubscription('claude', { log: () => {} });
    assert.equal(again.already, true);
    const calls = readFileSync(path.join(state, 'args.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.ok(calls.some((a) => a[0] === 'auth' && a[1] === 'login'), 'the official sign in was started');
    assert.ok(calls.some((a) => a[0] === '-p'), 'a tiny -p probe checked the sign in');
    assert.equal(await cliSignedIn('chatgpt'), false);
    assert.equal((await loginSubscription('chatgpt', { log: () => {} })).ok, true);
    assert.equal(await cliSignedIn('chatgpt'), true);
    process.env.IG_CLAUDE_BIN = path.join(state, 'no-such-binary');
    process.env.IG_CLAUDE_BIN_ARGS = '[]';
    const missing = await loginSubscription('claude', { log: (l) => log.push(l) });
    assert.equal(missing.reason, 'not_installed');
    assert.ok(log.at(-1).includes('npm install -g'));
  } finally {
    for (const k of ['IG_CLAUDE_BIN', 'IG_CLAUDE_BIN_ARGS', 'IG_CODEX_BIN', 'IG_CODEX_BIN_ARGS', 'FAKE_CLI_STATE']) delete process.env[k];
    Object.assign(process.env, saved);
    rmSync(state, { recursive: true, force: true });
  }
});

test('subscription code never opens the vendor credential stores', () => {
  for (const f of ['src/auth/subscription.js', 'src/providers/cli.js']) {
    const src = readFileSync(path.join(ROOT, f), 'utf8');
    assert.ok(!/\.credentials|auth\.json|keychain|\.claude\.json|CODEX_HOME/i.test(src.replace(/^\s*\/\/.*$/gm, '')), `${f} must not reference CLI credential files`);
  }
});

test('the example OAuth configs load', () => {
  for (const name of ['client-credentials', 'pkce', 'device']) {
    const cfg = loadOAuthConfig({ file: path.join(ROOT, 'examples', 'oauth', `${name}.json`), env: {} });
    assert.ok(cfg.token_url.startsWith('https://'), name);
  }
});
