// A fake OAuth 2.0 authorization server on 127.0.0.1 for the OAuth tests.
import http from 'node:http';
import { createHash } from 'node:crypto';

const b64url = (b) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export async function startTokenServer(options = {}) {
  const state = {
    requests: [],
    issued: 0,
    codes: new Map(),
    devicePolls: 0,
    devicePlan: options.devicePlan || ['authorization_pending', 'slow_down', 'ok'],
    refreshValid: true,
    expiresIn: options.expiresIn ?? 3600,
  };
  const token = (extra = {}) => {
    state.issued += 1;
    return { access_token: `at_${state.issued}`, token_type: 'Bearer', expires_in: state.expiresIn, refresh_token: `rt_${state.issued}`, ...extra };
  };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const url = new URL(req.url, 'http://127.0.0.1');
      const form = Object.fromEntries(new URLSearchParams(body));
      state.requests.push({ path: url.pathname, form, headers: req.headers });
      const json = (code, obj) => res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(obj));
      if (url.pathname === '/device') return json(200, { device_code: 'dev123', user_code: 'ABCD-EFGH', verification_uri: 'http://127.0.0.1/verify', expires_in: 600, interval: 1 });
      if (url.pathname !== '/token') return json(404, { error: 'not_found' });
      switch (form.grant_type) {
        case 'client_credentials': {
          const basic = req.headers.authorization?.startsWith('Basic ') ? Buffer.from(req.headers.authorization.slice(6), 'base64').toString().split(':')[0] : null;
          const id = form.client_id || basic;
          return id === 'svc' ? json(200, token({ refresh_token: undefined })) : json(401, { error: 'invalid_client' });
        }
        case 'authorization_code': {
          const entry = state.codes.get(form.code);
          if (!entry) return json(400, { error: 'invalid_grant' });
          const ok = b64url(createHash('sha256').update(form.code_verifier || '').digest()) === entry.challenge;
          return ok ? json(200, token()) : json(400, { error: 'invalid_grant', error_description: 'PKCE verification failed' });
        }
        case 'refresh_token':
          return state.refreshValid && form.refresh_token?.startsWith('rt_') ? json(200, token()) : json(400, { error: 'invalid_grant' });
        case 'urn:ietf:params:oauth:grant-type:device_code': {
          const step = state.devicePlan[Math.min(state.devicePolls++, state.devicePlan.length - 1)];
          return step === 'ok' ? json(200, token()) : json(400, { error: step });
        }
        default:
          return json(400, { error: 'unsupported_grant_type' });
      }
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, state, close: () => new Promise((r) => server.close(r)) };
}
