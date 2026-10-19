// One fetch path for the keyless scholarly APIs (PubMed E-utilities, Europe PMC, Crossref): a client-side
// rate limiter per service, a timeout per request, the caller's AbortSignal, back-off on 429, and friendly
// Korean errors. No API key, cookie, referrer or personal data is sent.
import { abortError, anySignal, isAbortError, sleepAbortable } from './shared.js';

export class ScholarlyError extends Error {
  /** @param {{ status?: number, service?: string, code?: 'network'|'timeout'|'rate'|'server'|'http'|'parse' }} [o] */
  constructor(message, { status = 0, service = '', code = 'http' } = {}) {
    super(message);
    this.name = 'ScholarlyError';
    this.status = status;
    this.service = service;
    this.code = code;
  }
}

/**
 * Lets at most `max` requests start in any `windowMs` (sliding window), first come first served.
 * `pause(ms)` holds everyone back after the server said 429.
 */
export class RateLimiter {
  #starts = [];
  #queue = Promise.resolve();
  #pausedUntil = 0;

  constructor({ max, windowMs }) {
    this.max = max;
    this.windowMs = windowMs;
  }

  /** Resolves when the caller may send; rejects with an AbortError if `signal` aborts while waiting. */
  acquire(signal) {
    const turn = this.#queue.then(() => this.#waitForSlot(signal));
    this.#queue = turn.catch(() => {});
    return turn;
  }

  pause(ms) {
    this.#pausedUntil = Math.max(this.#pausedUntil, Date.now() + ms);
  }

  async #waitForSlot(signal) {
    for (;;) {
      if (signal?.aborted) throw abortError();
      const now = Date.now();
      if (now < this.#pausedUntil) { await sleepAbortable(this.#pausedUntil - now, signal); continue; }
      this.#starts = this.#starts.filter((t) => now - t < this.windowMs);
      if (this.#starts.length < this.max) { this.#starts.push(now); return; }
      await sleepAbortable(this.windowMs - (now - this.#starts[0]) + 5, signal);
    }
  }
}

/**
 * Service table. NCBI allows 3 requests/s per IP without a key. It counts arrivals, and the first request's
 * connection setup (≈ 0.3–0.5 s from Korea) can bunch 4 arrivals into one second even when we start only
 * 3 per 1.1 s — that drew a real 429 on 2026-10-19 — so we start at most 3 per 1.5 s. Crossref's public pool
 * currently answers `x-rate-limit-limit: 1` per second; Europe PMC publishes no hard limit.
 */
export const SERVICES = {
  pubmed: { label: 'PubMed', limiter: new RateLimiter({ max: 3, windowMs: 1500 }), timeoutMs: 15000 },
  europepmc: { label: 'Europe PMC', limiter: new RateLimiter({ max: 5, windowMs: 1000 }), timeoutMs: 15000 },
  crossref: { label: 'Crossref', limiter: new RateLimiter({ max: 1, windowMs: 1100 }), timeoutMs: 15000 },
};

export function busyMessage(label) {
  return `${label}가 잠시 바쁩니다. 잠시 후 다시 시도해 주세요.`;
}

function statusMessage(label, status) {
  if (status === 429) return busyMessage(label);
  if (status >= 500) return `${label} 서버에 문제가 있습니다. 잠시 후 다시 시도해 주세요.`;
  return `${label} 요청에 실패했습니다 (${status}).`;
}

/** Seconds or HTTP-date in Retry-After → ms (capped), else null. */
function retryAfterMs(res) {
  const v = res.headers.get('retry-after');
  if (!v) return null;
  const s = Number(v);
  const ms = Number.isFinite(s) ? s * 1000 : Date.parse(v) - Date.now();
  return Number.isFinite(ms) && ms > 0 ? Math.min(ms, 10000) : null;
}

const RETRY_STATUS = new Set([429, 502, 503, 504]);
/** First wait after a failed fetch (doubles per retry); NCBI's own 429s say Retry-After: 2. */
const NETWORK_RETRY_MS = 2000;

/**
 * GET `url` from `service`. Resolves to parsed JSON (`as: 'json'`) or text (`as: 'text'`); null on 404.
 * Up to `retries` automatic retries on 429/502/503/504 (Retry-After or 1 s, 2 s …) and on a failed fetch
 * while online (a 429 without CORS headers looks like that; 2 s, 4 s …), then a ScholarlyError.
 * @param {'pubmed'|'europepmc'|'crossref'} service
 */
export async function scholarlyGet(service, url, { signal, as = 'json', timeoutMs, retries = 2 } = {}) {
  const svc = SERVICES[service];
  if (!svc) throw new Error(`unknown service ${service}`);
  const { label } = svc;
  for (let attempt = 0; ; attempt++) {
    await svc.limiter.acquire(signal);
    const timer = new AbortController();
    const t = setTimeout(() => timer.abort(), timeoutMs ?? svc.timeoutMs);
    const both = anySignal(signal, timer.signal);
    try {
      let res;
      try {
        res = await fetch(url, {
          signal: both, credentials: 'omit', referrerPolicy: 'no-referrer',
          headers: { Accept: as === 'json' ? 'application/json' : 'text/xml, text/plain, */*' },
        });
      } catch (err) {
        if (signal?.aborted) throw err;
        if (timer.signal.aborted) throw new ScholarlyError(`${label} 응답이 늦어 중단했습니다. 잠시 후 다시 시도해 주세요.`, { service, code: 'timeout' });
        const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
        // NCBI answers 429 without CORS headers (checked 2026-10-19), and gateways may do the same with 5xx:
        // the browser then only reports a failed fetch. So a failed fetch while online is retried like a 429
        // (everyone waits, then 2 s, 4 s) before it counts as a connection problem.
        if (!offline && attempt < retries) {
          const wait = NETWORK_RETRY_MS * 2 ** attempt + Math.round(Math.random() * 250);
          svc.limiter.pause(wait);
          clearTimeout(t);
          await sleepAbortable(wait, signal);
          continue;
        }
        console.warn(`[features] ${service} fetch failed`, err);
        throw new ScholarlyError(offline
          ? `${label}에 연결하지 못했습니다. 인터넷 연결을 확인해 주세요.`
          : `${label}에 연결하지 못했습니다. 서버가 잠시 바쁘거나 네트워크가 막혀 있을 수 있습니다. 잠시 후 다시 시도해 주세요.`,
        { service, code: 'network' });
      }
      if (RETRY_STATUS.has(res.status) && attempt < retries) {
        const wait = retryAfterMs(res) ?? 1000 * 2 ** attempt + Math.round(Math.random() * 250);
        if (res.status === 429) svc.limiter.pause(wait);
        clearTimeout(t);
        await sleepAbortable(wait, signal);
        continue;
      }
      if (res.status === 404) return null;
      if (!res.ok) {
        throw new ScholarlyError(statusMessage(label, res.status), { status: res.status, service, code: res.status === 429 ? 'rate' : res.status >= 500 ? 'server' : 'http' });
      }
      try {
        return as === 'json' ? await res.json() : await res.text();
      } catch (err) {
        if (signal?.aborted) throw err;
        if (timer.signal.aborted) throw new ScholarlyError(`${label} 응답이 늦어 중단했습니다. 잠시 후 다시 시도해 주세요.`, { service, code: 'timeout' });
        throw new ScholarlyError(`${label} 응답을 읽지 못했습니다.`, { status: res.status, service, code: 'parse' });
      }
    } catch (err) {
      if (signal?.aborted && isAbortError(err, signal)) throw abortError();
      throw err;
    } finally {
      clearTimeout(t);
    }
  }
}

/** Build a URL with query parameters (arrays become repeated parameters; null/'' are skipped). */
export function buildUrl(base, params = {}) {
  const u = new URL(base);
  for (const [k, v] of Object.entries(params)) {
    if (Array.isArray(v)) for (const x of v) u.searchParams.append(k, String(x));
    else if (v != null && v !== '') u.searchParams.set(k, String(v));
  }
  return u.href;
}
