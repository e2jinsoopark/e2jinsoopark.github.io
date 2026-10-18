// Provider registry + the shared error shape every provider throws.
//
// Provider = {
//   id, label,
//   async complete({ model, system, messages, json?, maxTokens, effort?, signal }) → { text, json?, usage, stopReason }
//   async *stream({ ...same, no json }) → yields { type:'text', text } … finally { type:'done', usage, stopReason }
//   async listModels() → [{ id, label }]
//   async testKey() → { ok, message }
// }
// system:   string | [{ text, cache?: true }]
// messages: [{ role: 'user'|'assistant', content: string | Part[] }]
// Part:     { type:'text', text } | { type:'image', mediaType:'image/png', data /* base64 */ }
//
// Note: claude.js / gemini.js / mock.js / relay.js import aiError() from here while this file imports them. The
// cycle is safe because aiError/isAbort are hoisted function declarations and the provider objects are only read
// inside getProvider() at call time — keep it that way (no top-level use of imported bindings in either direction).
//
// `relay` re-exports js/ai/relay.js (invite codes, /relay/me, admin API) so the app gets it with this dynamically
// loaded module instead of importing the AI modules statically.
import { settings } from '../core/settings.js';
import { claudeProvider } from './claude.js';
import { geminiProvider } from './gemini.js';
import { mockProvider } from './mock.js';
import { relayProvider } from './relay.js';

export * as relay from './relay.js';

/** Selectable providers for the settings screen (mock is test-only and not listed). */
export const PROVIDER_OPTIONS = [
  { id: 'relay', label: '초대 코드 (키 없이 쓰기)' },
  { id: 'claude', label: 'Claude (Anthropic)' },
  { id: 'gemini', label: 'Gemini (Google)' },
];

/**
 * Error codes carried on `err.code`. `fatal` errors stop a whole translation run (bad key, no access, no credit),
 * the rest fail only the current request.
 */
export const AI_ERROR_CODES = Object.freeze({
  noKey: 'no_key',
  auth: 'auth',
  permission: 'permission',
  billing: 'billing',
  notFound: 'not_found',
  badRequest: 'bad_request',
  rateLimit: 'rate_limit',
  quota: 'quota',
  server: 'server',
  network: 'network',
  timeout: 'timeout',
  aborted: 'aborted',
  refusal: 'refusal',
  maxTokens: 'max_tokens',
  parse: 'parse',
  unknown: 'unknown',
});

const FATAL_CODES = new Set(['no_key', 'auth', 'permission', 'billing', 'not_found']);

/**
 * Build an Error with a Korean, user-presentable message plus machine-readable fields.
 * @param {string} message Korean message
 * @param {{ code?: string, fatal?: boolean, status?: number, cause?: unknown, [k: string]: unknown }} [extra]
 * @returns {Error & { code: string, fatal: boolean }}
 */
export function aiError(message, { code = 'unknown', fatal, cause, ...extra } = {}) {
  const err = new Error(message, cause === undefined ? undefined : { cause });
  err.name = code === 'aborted' ? 'AbortError' : 'AiError';
  return Object.assign(err, { code, fatal: fatal ?? FATAL_CODES.has(code) }, extra);
}

/** True for user cancellation (our aiError, DOM AbortError, or an aborted signal). */
export function isAbort(err, signal) {
  return Boolean(signal?.aborted) || err?.code === 'aborted' || err?.name === 'AbortError';
}

/** Throw a Korean AbortError if `signal` is already aborted. */
export function throwIfAborted(signal) {
  if (signal?.aborted) throw aiError('요청을 취소했습니다.', { code: 'aborted' });
}

/**
 * The provider for `id` (default: the one selected in settings; `?mock=1` forces 'mock').
 * @param {string} [id]
 */
export function getProvider(id = settings.get().provider) {
  const registry = { relay: relayProvider, claude: claudeProvider, gemini: geminiProvider, mock: mockProvider };
  const provider = registry[id];
  if (!provider) throw aiError(`알 수 없는 AI 제공자입니다: ${id}`, { code: 'bad_request' });
  return provider;
}
