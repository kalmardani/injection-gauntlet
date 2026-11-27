// HTTP helper for every outbound call the tool makes on purpose (model
// providers, OAuth endpoints, the http target). Timeout on every attempt,
// bounded retries with exponential backoff and jitter on 429, 5xx and network
// errors. Error messages never contain request headers, so keys and tokens
// cannot end up in a log.

export class HttpError extends Error {
  constructor(message, { status = 0, body = '', retryable = false } = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.body = body;
    this.retryable = retryable;
  }
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

function retryDelay(attempt, retryAfter, baseMs) {
  const header = Number(retryAfter);
  if (Number.isFinite(header) && header >= 0) return Math.min(header * 1000, 30000);
  const exp = baseMs * 2 ** attempt;
  return Math.min(exp + Math.floor(Math.random() * baseMs), 30000);
}

/**
 * Send a request and parse a JSON response.
 * options: method, headers, body (object for JSON, string or URLSearchParams
 * otherwise), timeoutMs, maxRetries, fetchImpl, sleep, baseDelayMs,
 * acceptStatus (list of non 2xx statuses returned to the caller as data).
 */
export async function requestJson(url, options = {}) {
  const {
    method = 'POST',
    headers = {},
    body,
    timeoutMs = 60000,
    maxRetries = 3,
    fetchImpl = globalThis.fetch,
    sleep = defaultSleep,
    baseDelayMs = 500,
    acceptStatus = [],
  } = options;
  let payload = body;
  const h = { accept: 'application/json', ...headers };
  if (body && typeof body === 'object' && !(body instanceof URLSearchParams)) {
    payload = JSON.stringify(body);
    h['content-type'] = 'application/json';
  } else if (body instanceof URLSearchParams) {
    payload = body.toString();
    h['content-type'] = 'application/x-www-form-urlencoded';
  }

  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let res;
    try {
      res = await fetchImpl(url, { method, headers: h, body: payload, signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      const timedOut = e?.name === 'TimeoutError' || e?.name === 'AbortError';
      lastError = new HttpError(timedOut ? `request timed out after ${timeoutMs} ms` : `network error: ${e?.message || e}`, {
        retryable: true,
      });
      if (attempt < maxRetries) {
        await sleep(retryDelay(attempt, null, baseDelayMs));
        continue;
      }
      throw lastError;
    }
    const text = await res.text();
    if (res.ok || acceptStatus.includes(res.status)) {
      if (!text) return { status: res.status, data: null };
      try {
        return { status: res.status, data: JSON.parse(text) };
      } catch {
        throw new HttpError(`response from ${new URL(url).host} is not JSON`, { status: res.status, body: text.slice(0, 300) });
      }
    }
    const retryable = res.status === 429 || res.status >= 500;
    lastError = new HttpError(`HTTP ${res.status} from ${new URL(url).host}: ${text.slice(0, 300)}`, {
      status: res.status,
      body: text.slice(0, 2000),
      retryable,
    });
    if (retryable && attempt < maxRetries) {
      await sleep(retryDelay(attempt, res.headers.get('retry-after'), baseDelayMs));
      continue;
    }
    throw lastError;
  }
  throw lastError;
}
