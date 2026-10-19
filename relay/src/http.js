// Responses, Anthropic-shaped errors and CORS.

/** DELETE: the admin's code deletion (DELETE /relay/admin/codes/<code>). */
export const ALLOW_METHODS = 'GET, POST, PATCH, DELETE, OPTIONS';
/** The shared library's GitHub proxy also takes PUT (README bootstrap of an empty repo). */
export const SHARED_ALLOW_METHODS = 'GET, POST, PATCH, PUT, OPTIONS';
// The Anthropic SDK decides about retries from x-should-retry / retry-after*: a browser shows it those headers
// only when they are exposed, so a quota 429 is not retried in the browser either. The GitHub client of the shared
// library needs the ref ETag (conditional GETs → 304) and GitHub's rate-limit headers.
const EXPOSE_HEADERS = 'request-id, x-relay-today-usd, x-relay-limit-usd, x-should-retry, retry-after, retry-after-ms, '
  + 'etag, x-ratelimit-limit, x-ratelimit-remaining, x-ratelimit-reset, x-ratelimit-used, x-ratelimit-resource';
const DEFAULT_ALLOW_HEADERS = 'authorization, content-type, x-api-key, anthropic-version, anthropic-beta, '
  + 'anthropic-dangerous-direct-browser-access';

/** Short random id for responses the relay produces itself (upstream replies keep Anthropic's request-id). */
export function relayRequestId() {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return `relay_${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/** JSON response. */
export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
}

/**
 * Error in Anthropic's shape ({ type: 'error', error: { type, message } }), so the Anthropic SDK maps it to its
 * typed errors. Every error the relay itself decides on (auth, permission, quota, bad input) carries
 * x-should-retry: false: retrying cannot change the answer.
 * @param {number} status
 * @param {string} type Anthropic error type, e.g. 'authentication_error'
 * @param {string} message Korean, shown to the user as-is
 */
export function apiError(status, type, message, headers = {}) {
  const requestId = relayRequestId();
  const retry = status < 500 ? { 'x-should-retry': 'false' } : {};
  return json({ type: 'error', error: { type, message }, request_id: requestId }, status,
    { 'request-id': requestId, ...retry, ...headers });
}

/**
 * True when `origin` is listed in `allowed`. Entries are exact origins, or "scheme://host:*" for any port
 * (including the scheme's default port, which browsers omit from Origin).
 */
export function isOriginAllowed(origin, allowed) {
  if (!origin) return false;
  return allowed.some((entry) => {
    if (entry.endsWith(':*')) {
      const base = entry.slice(0, -2);
      if (origin === base) return true;
      return origin.startsWith(`${base}:`) && /^\d{1,5}$/.test(origin.slice(base.length + 1));
    }
    return origin === entry;
  });
}

/** 204 answer to a CORS preflight from an allowed origin. */
export function preflight(request, origin, methods = ALLOW_METHODS) {
  return new Response(null, {
    status: 204,
    headers: {
      'access-control-allow-origin': origin,
      'access-control-allow-methods': methods,
      'access-control-allow-headers': request.headers.get('access-control-request-headers') || DEFAULT_ALLOW_HEADERS,
      'access-control-max-age': '86400',
      vary: 'Origin',
    },
  });
}

/**
 * Add `Vary: Origin` and, for an allowed browser origin, the CORS headers. Returns a response whose headers are
 * mutable (a fresh Response around the same body when needed).
 * @param {Response} response
 * @param {string | null} origin allowed origin, or null for none
 */
export function withCors(response, origin) {
  let out = response;
  try {
    out.headers.append('vary', 'Origin');
  } catch {
    out = new Response(response.body, response); // immutable headers (e.g. a fetched response)
    out.headers.append('vary', 'Origin');
  }
  if (origin) {
    out.headers.set('access-control-allow-origin', origin);
    out.headers.set('access-control-expose-headers', EXPOSE_HEADERS);
  }
  return out;
}

/**
 * Read a request body up to `max` bytes without trusting Content-Length.
 * @returns {Promise<{ bytes: Uint8Array } | { tooLarge: true }>}
 */
export async function readBody(request, max) {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > max) return { tooLarge: true };
  if (!request.body) return { bytes: new Uint8Array(0) };
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return { tooLarge: true };
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.byteLength;
  }
  return { bytes };
}

/** The token of an `Authorization: Bearer <token>` header, or ''. */
export function bearer(request) {
  const m = /^Bearer\s+(.+)$/i.exec(request.headers.get('authorization') || '');
  return m ? m[1].trim() : '';
}

/** Parse a JSON body; undefined when it is not valid JSON. */
export function parseJson(bytes) {
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return undefined;
  }
}
