// Who is calling: invite codes (both kinds, codes.js) and the admin token, behind the failed-attempt limiter
// (limiter.js). Used by the Claude endpoints (index.js) and the shared library (shared.js), so every way in that
// takes a code — /v1/*, /relay/me, /shared, /shared/<lib>/activity, the GitHub proxy — shares one counter per IP.
import { codeKey } from './codes.js';
import { lookupCodeStatement } from './db.js';
import {
  activeFailures, ADMIN_FAIL_LIMIT, clientKey, CODE_FAIL_LIMIT, failureRow, failureStatement, guessFingerprint,
  pruneFailures, retryAfterSeconds,
} from './limiter.js';

/**
 * Resolve a presented invite code (`raw`: header value; '' = none presented).
 * One D1 batch (one round trip, one transaction): count a failure if no code has this key, then read the code, its
 * budgets and the caller's counter. A successful lookup writes nothing.
 * - `{ missing: true }` nothing presented (never counted).
 * - `{ limited: true, retryAfter }` the caller's IP has used up its failures for this window. While it lasts only a
 *   GENERATED code that exists and is active still works: guessing one (40 random bits) is hopeless, and refusing it
 *   would only lock out colleagues behind the same network. A custom code is refused like any guess — otherwise
 *   200-versus-429 would tell a guesser which word is a code.
 * - `{ refused: 'unknown' }` no such code (counted), `{ refused: 'disabled' }` switched off (not counted).
 * - `{ row }` the code's row (with today's budgets when `day` is given).
 * @param {Request} request
 * @param {{ db: any, raw: string, now: number, day?: string | null }} opts
 */
export async function checkInviteCode(request, { db, raw, now, day = null }) {
  if (!raw) return { missing: true };
  const ip = clientKey(request);
  const parsed = codeKey(raw);
  const key = parsed?.key ?? '';
  const guess = await guessFingerprint('code', parsed ? key : String(raw).trim());
  const [counted, looked] = await db.batch([
    failureStatement(db, { ip, kind: 'code', now, guess, limit: CODE_FAIL_LIMIT, unlessCodeKey: key }),
    lookupCodeStatement(db, { key, ip, day }),
  ]);
  const row = looked.results?.[0] ?? null;
  const found = row?.code != null;
  if (!found) {
    // Not counted although no code matched: the window already holds CODE_FAIL_LIMIT failures.
    if (!counted.results?.length) return { limited: true, retryAfter: retryAfterSeconds(row?.fail_window_start ?? now, now) };
    await pruneFailures(db, now);
    return { refused: 'unknown' };
  }
  if (activeFailures(row.fail_count, row.fail_window_start, now) >= CODE_FAIL_LIMIT && !(parsed.generated && row.active)) {
    return { limited: true, retryAfter: retryAfterSeconds(row.fail_window_start, now) };
  }
  if (!row.active) return { refused: 'disabled' };
  return { row };
}

/**
 * Check the admin token (`given`: the Bearer value) against `expected`, behind its own limiter bucket. A wrong token
 * is counted in one statement (atomic, as for invite codes); a right one reads the counter. While the bucket is full
 * even the right token is refused: an owner-chosen token may be guessable, and the only person locked out is the
 * owner on that network for at most 10 minutes.
 * @returns {Promise<{ ok: true } | { limited: true, retryAfter: number } | { refused: true }>}
 */
export async function checkAdminToken(request, { db, given, expected, now }) {
  const ip = clientKey(request);
  if (await sameSecret(given, expected)) {
    const counter = await failureRow(db, { ip, kind: 'admin' });
    if (activeFailures(counter?.failures, counter?.window_start, now) >= ADMIN_FAIL_LIMIT) {
      return { limited: true, retryAfter: retryAfterSeconds(counter.window_start, now) };
    }
    return { ok: true };
  }
  if (!given) return { refused: true }; // no token at all: nothing guessed, nothing counted
  const guess = await guessFingerprint('admin', given);
  const counted = await failureStatement(db, { ip, kind: 'admin', now, guess, limit: ADMIN_FAIL_LIMIT }).all();
  if (counted.results?.length) {
    await pruneFailures(db, now);
    return { refused: true };
  }
  const counter = await failureRow(db, { ip, kind: 'admin' });
  return { limited: true, retryAfter: retryAfterSeconds(counter?.window_start ?? now, now) };
}

/** Constant-time comparison: both sides are hashed first, so neither length nor content leaks through timing. */
export async function sameSecret(given, expected) {
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(given)),
    crypto.subtle.digest('SHA-256', enc.encode(expected)),
  ]);
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0 && given.length > 0;
}
