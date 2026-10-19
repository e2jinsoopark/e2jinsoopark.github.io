// Failed-attempt limiter (docs/RELAY.md §4): custom invite codes can be short words, so guessing them must be slow.
// Per client IP (CF-Connecting-IP; an IPv6 address counts as its /64), failures are counted in a fixed window that
// starts at the first failure: once CODE_FAIL_LIMIT invite-code lookups (or ADMIN_FAIL_LIMIT admin tokens, a separate
// bucket) have failed within FAIL_WINDOW_MS, the next attempt gets 429 until the window ends. State lives in D1
// (auth_failures), not the Cache API (per data centre, and by Cloudflare's docs not usable on *.workers.dev — not
// verified here). The count and the code lookup run in one D1 batch, so parallel guesses cannot all slip past a
// counter that has not been written yet; a code that exists writes nothing.
//
// What counts as one failure: a presented credential that matches no code (or a wrong admin token). Not counted: no
// credential at all; a code that exists but is switched off (an old device of someone whose code was stopped keeps
// polling and must not lock out everyone behind the same hospital network); the same wrong credential again right
// after itself (a client stuck on one wrong value tells a guesser nothing new). A success never resets the count.

import { apiError } from './http.js';

export const FAIL_WINDOW_MS = 10 * 60 * 1000;
export const CODE_FAIL_LIMIT = 20;
export const ADMIN_FAIL_LIMIT = 10;
/** A window that starts this far in the future is a clock jump (or a test clock moved back): treated as over. */
const CLOCK_SKEW_MS = 60 * 1000;

export const TOO_MANY_MESSAGE = '시도가 너무 많습니다. 잠시 후 다시 시도해 주세요.';

/**
 * The limiter key of the caller: CF-Connecting-IP (set by Cloudflare, not by the client), an IPv6 address cut to its
 * /64 (one user usually holds a whole /64), an IPv4-mapped IPv6 address as its IPv4. 'unknown' without the header.
 * @param {Request} request
 */
export function clientKey(request) {
  const raw = String(request.headers.get('cf-connecting-ip') || '').trim().toLowerCase();
  if (!raw) return 'unknown';
  if (!raw.includes(':')) return raw.slice(0, 64);
  return ipv6Prefix(raw) ?? raw.slice(0, 64);
}

/** "2001:db8:1:2::abcd" → "2001:0db8:0001:0002::/64"; "::ffff:198.51.100.7" → "198.51.100.7"; null if malformed. */
export function ipv6Prefix(ip) {
  const s = ip.replace(/^\[|\]$/g, '').split('%')[0];
  const mapped = /^[0:]*:ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
  if (mapped) return mapped[1];
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  const groups = [...head, ...Array(missing).fill('0'), ...tail];
  if (!groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null;
  return `${groups.slice(0, 4).map((g) => g.padStart(4, '0')).join(':')}::/64`;
}

/** Is a window that started at `windowStart` still running at `now`? */
export function windowOpen(windowStart, now) {
  return windowStart != null && windowStart > now - FAIL_WINDOW_MS && windowStart <= now + CLOCK_SKEW_MS;
}

/** Failures counted in the window running at `now` (0 when there is none). */
export function activeFailures(count, windowStart, now) {
  return windowOpen(windowStart, now) ? Number(count) || 0 : 0;
}

/** Whole seconds until the window ends (at least 1): the 429's retry-after. */
export function retryAfterSeconds(windowStart, now) {
  return Math.max(1, Math.ceil((windowStart + FAIL_WINDOW_MS - now) / 1000));
}

/**
 * 429 rate_limit_error for a caller at the limit (Anthropic error shape; x-should-retry: false like every refusal
 * of the relay's own). `retry-after` = seconds until its window ends — a budget 429 never carries one, which is how a
 * client can tell "wait a few minutes" from "come back tomorrow".
 */
export function tooManyAttempts(retryAfter) {
  return apiError(429, 'rate_limit_error', TOO_MANY_MESSAGE, { 'retry-after': String(retryAfter) });
}

/**
 * A short one-way fingerprint of a failed credential, so "the same wrong value again" can be recognised without
 * storing what was typed (it may be a mistyped real code, or an API key pasted into the wrong box).
 */
export async function guessFingerprint(kind, text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${kind}:${text}`));
  return Array.from(new Uint8Array(digest).slice(0, 8), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * The statement that counts one failure of `kind` ('code' | 'admin') for `ip` at `now`: a new window when none is
 * running, the same count when `guess` repeats the last failed value, else +1 — and nothing at all once the window
 * holds `limit` failures (a caller over the limit costs no writes). RETURNING gives a row only when it counted.
 *
 * With `unlessCodeKey`, it counts only when no invite code has that key, so the code lookup and the count run in
 * one D1 batch (auth.js). D1 runs a batch as one transaction and one batch at a time, so parallel guesses are
 * decided one after another: a burst of N guesses gets `limit` answers and N − `limit` refusals, never N answers.
 */
export function failureStatement(db, { ip, kind, now, guess, limit, unlessCodeKey = null }) {
  const expired = 'auth_failures.window_start <= ?3 - ?5 OR auth_failures.window_start > ?3 + ?6';
  const when = unlessCodeKey === null ? 'WHERE 1' : "WHERE NOT EXISTS (SELECT 1 FROM codes WHERE replace(code, '-', '') = ?8)";
  const args = [ip, kind, now, guess, FAIL_WINDOW_MS, CLOCK_SKEW_MS, limit];
  if (unlessCodeKey !== null) args.push(unlessCodeKey);
  // "SELECT … WHERE …" rather than VALUES: an INSERT … SELECT needs a WHERE before ON CONFLICT (SQLite parsing rule).
  return db.prepare(`
    INSERT INTO auth_failures (ip, kind, window_start, failures, last_guess)
    SELECT ?1, ?2, ?3, 1, ?4 ${when}
    ON CONFLICT (ip, kind) DO UPDATE SET
      failures = CASE WHEN ${expired} THEN 1
                      WHEN auth_failures.last_guess = excluded.last_guess THEN auth_failures.failures
                      ELSE auth_failures.failures + 1 END,
      window_start = CASE WHEN ${expired} THEN ?3 ELSE auth_failures.window_start END,
      last_guess = excluded.last_guess
    WHERE ${expired} OR auth_failures.failures < ?7
    RETURNING failures`).bind(...args);
}

/** Drop the rows of finished windows (after a counted failure; nothing depends on it being prompt). */
export async function pruneFailures(db, now) {
  try {
    await db.prepare('DELETE FROM auth_failures WHERE window_start <= ?1').bind(now - FAIL_WINDOW_MS - CLOCK_SKEW_MS).run();
  } catch (err) {
    console.error('[relay] auth_failures not pruned', err);
  }
}

/**
 * The failure counter of `kind` for `ip` (the admin check for a right token; invite codes read it in their lookup).
 * @returns {Promise<{ failures: number, window_start: number } | null>}
 */
export function failureRow(db, { ip, kind }) {
  return db.prepare('SELECT failures, window_start FROM auth_failures WHERE ip = ?1 AND kind = ?2').bind(ip, kind).first();
}
