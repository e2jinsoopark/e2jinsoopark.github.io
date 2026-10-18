// Invite-code relay (docs/RELAY.md): colleagues use the app without an API key. The relay provider is the Claude
// provider pointed at the owner's Cloudflare Worker (baseURL = settings.relayUrl(), apiKey = the invite code), so
// requests, streaming and errors are the Claude provider's. Plus the worker's own endpoints: GET /relay/me (who am I,
// today's usage) and the owner's /relay/admin/* (invite codes, usage), and helpers for invite links.
//
// relay.js and providers.js import each other: nothing here may use an imported binding at module top level (the
// Claude provider underneath is made on first use).
import { APP_PUBLIC_URL, CLAUDE_MODELS, RELAY_DEFAULT_URL } from '../core/config.js';
import { settings } from '../core/settings.js';
import { formatUsd } from '../core/util.js';
import { isLegacyClaudeModel, makeClaudeProvider, pickClaudeModel } from './claude.js';
import { applyModelList } from './models.js';
import { aiError } from './providers.js';

export const RELAY_LABEL = '초대 코드';
/** Choices offered when creating a code (the worker accepts any subset of the known Claude models). */
export const MODEL_SETS = Object.freeze([
  Object.freeze({ id: 'haiku', label: 'Haiku만', models: Object.freeze(['claude-haiku-5-5']) }),
  Object.freeze({ id: 'haiku-sonnet', label: 'Haiku + Sonnet', models: Object.freeze(['claude-haiku-5-5', 'claude-sonnet-5-5']) }),
]);
export const NAME_MAX = 40;
export const DAILY_LIMIT_MAX = 20;

const REQUEST_TIMEOUT_MS = 20_000;
const HANGUL = /[가-힣]/;
const CODE_RE = /^PR-[0-9A-Z]{4}-[0-9A-Z]{4}$/;
const STATUS_CODES = { 400: 'bad_request', 401: 'auth', 403: 'permission', 404: 'not_found', 413: 'bad_request', 429: 'quota' };
// A new code starts on 자동 선택 (models picked from the code's allowed ones).
const NO_MODEL_CHOICE = Object.freeze({ translateModel: '', assistModel: '', autoModels: { translate: '', assist: '' } });

const NO_URL_MESSAGE = '초대 코드 서버 주소가 없습니다. 설정 → AI 번역 → 키 없이 쓰기에서 서버 주소를 입력해 주세요.';
const NO_CODE_MESSAGE = '초대 코드가 없습니다. 설정 → AI 번역 → 키 없이 쓰기에서 초대 코드를 입력해 주세요.';
const BAD_CODE_MESSAGE = '초대 코드가 올바르지 않거나 사용이 중지되었습니다.';
const FORMAT_MESSAGE = '초대 코드 형식이 올바르지 않습니다. PR-XXXX-XXXX 형식(예: PR-7K3M-9QXA)인지 확인해 주세요.';
const CONNECT_MESSAGE = '초대 코드 서버에 연결할 수 없습니다. 인터넷 연결을 확인하고, 계속되면 설정의 서버 주소를 확인해 주세요.';
const CSP_MESSAGE = '이 앱의 보안 정책(CSP)이 초대 코드 서버 주소로의 연결을 막았습니다. 설정의 서버 주소를 확인해 주세요. '
  + '다른 서버를 쓰려면 관리자가 index.html의 connect-src에 그 주소를 추가해야 합니다.';
const TIMEOUT_MESSAGE = '초대 코드 서버가 응답하지 않습니다. 잠시 후 다시 시도해 주세요.';
const OWNER_SETUP_MESSAGE = '초대 코드 서버의 Claude 연결(관리자의 API 키 또는 크레딧)에 문제가 있습니다. 초대해 준 분에게 알려 주세요.';
const NOT_FOUND_MESSAGE = '초대 코드 서버에서 요청한 기능을 찾을 수 없습니다. 설정의 서버 주소가 맞는지 확인해 주세요.';
const ADMIN_AUTH_MESSAGE = '관리자 토큰이 올바르지 않습니다.';
const NO_ADMIN_MESSAGE = '관리자 토큰을 먼저 저장해 주세요.';

// ───────────────────────────── invite codes ─────────────────────────────

/**
 * Canonical form of a typed or pasted code (or a whole pasted invite link): upper case, no spaces, PR-XXXX-XXXX
 * dashes, and the Crockford base32 look-alikes the generator never emits read as digits (O → 0, I/L → 1).
 * @param {unknown} raw
 */
export function normalizeInviteCode(raw) {
  let s = String(raw ?? '').trim();
  const link = /#\/join\/([^/?#\s]+)/i.exec(s);
  if (link) s = safeDecode(link[1]);
  s = s.toUpperCase().replace(/\s+/g, '').replace(/[‐‑‒–—―−]/g, '-');
  const parts = /^PR-?([0-9A-Z]{4})-?([0-9A-Z]{4})$/.exec(s);
  const digits = (x) => x.replace(/O/g, '0').replace(/[IL]/g, '1');
  return parts ? `PR-${digits(parts[1])}-${digits(parts[2])}` : s;
}

/** True for a code in the PR-XXXX-XXXX format (after normalizeInviteCode). */
export function isInviteCode(code) {
  return CODE_RE.test(String(code || ''));
}

/** Join link for a code; the code travels in the fragment, which browsers never send to a server. */
export function inviteLink(code) {
  return `${APP_PUBLIC_URL.replace(/\/+$/, '')}/#/join/${encodeURIComponent(code)}`;
}

/**
 * Korean invite text to paste into a chat: greeting, the join link, one line of fallback instructions.
 * @param {{ code: string, name?: string, dailyLimitUsd?: number }} info
 */
export function inviteMessage({ code, name = '', dailyLimitUsd }) {
  const who = name ? `${name}님, ` : '';
  const limit = Number.isFinite(dailyLimitUsd) ? `하루 한도 ${formatUsd(dailyLimitUsd)}, ` : '';
  return [
    `[논문 리더 초대] ${who}아래 링크를 열면 API 키 없이 영어 논문 번역·요약·채팅을 쓸 수 있습니다.`,
    inviteLink(code),
    `링크가 안 열리면 논문 리더 → 설정 → AI 번역 → ‘키 없이 쓰기’에 코드 ${code}를 넣고 테스트를 누르세요. (${limit}코드는 본인만 써 주세요)`,
  ].join('\n');
}

/** 'Haiku 5.5' for a known Claude model id; other ids as they are. */
export function modelShortName(id) {
  const known = CLAUDE_MODELS.find((m) => m.id === id);
  return known ? known.label.replace(/\s*\(.*\)$/, '').replace(/^Claude\s+/, '') : String(id);
}

/** 'Haiku만' / 'Haiku + Sonnet' for the offered sets, else the short names joined. */
export function modelSetLabel(models) {
  const list = Array.isArray(models) ? models : [];
  const set = MODEL_SETS.find((s) => s.models.length === list.length && s.models.every((m) => list.includes(m)));
  return set ? set.label : list.map(modelShortName).join(' + ') || '-';
}

/** The settings status line: '홍길동님 · 오늘 $0.03 / $0.50 · 모델: Haiku 5.5'. */
export function formatMe(me) {
  const who = me.name ? `${me.name}님` : '초대 코드 확인됨';
  const models = me.allowedModels.length ? me.allowedModels.map(modelShortName).join(', ') : '-';
  return `${who} · 오늘 ${formatUsd(me.todayUsd)} / ${formatUsd(me.dailyLimitUsd)} · 모델: ${models}`;
}

// ───────────────────────────── provider ─────────────────────────────

let claudeBase = null;

/** The Claude provider bound to the relay, made on first use. */
function base() {
  claudeBase ||= makeClaudeProvider({
    id: 'relay',
    label: RELAY_LABEL,
    auth: () => {
      const baseURL = settings.relayUrl();
      if (!baseURL) throw aiError(NO_URL_MESSAGE, { code: 'no_key' });
      return { apiKey: normalizeInviteCode(settings.get().relay?.code), baseURL, fetch: relaySdkFetch };
    },
    missingKeyMessage: NO_CODE_MESSAGE,
    describeError: describeRelayError,
  });
  return claudeBase;
}

export const relayProvider = {
  id: 'relay',
  label: RELAY_LABEL,
  complete: (opts) => base().complete(opts),
  stream: (opts) => base().stream(opts),
  listModels: () => base().listModels(),
  /** Checks the code with GET /relay/me (no tokens), remembers its name and models; `models` = the allowed ones. */
  async testKey() {
    try {
      const me = await refreshMe();
      return { ok: true, message: formatMe(me), models: me.allowedModels.map((id) => ({ id, label: modelLabel(id) })) };
    } catch (err) {
      return { ok: false, message: err?.message || BAD_CODE_MESSAGE };
    }
  },
  // The code's allowed models are Claude models: translation → newest Haiku, summaries/chat → newest Sonnet.
  pickDefaultModel: (models, kind) => pickClaudeModel(models, kind),
  isLegacyModel: (id) => isLegacyClaudeModel(id),
};

function modelLabel(id) {
  return CLAUDE_MODELS.find((m) => m.id === id)?.label || id;
}

/**
 * fetch for the SDK client. The relay's own refusals (429: today's budget is used up) say `x-should-retry: false`,
 * but a cross-origin response hides every header the server does not expose. relay/ exposes it; this marks the
 * refusal anyway, so a Worker exposing only the contract's minimum does not get a request retried that cannot
 * succeed today. Anthropic's own 429s (English, passed through) stay retryable.
 */
async function relaySdkFetch(input, init) {
  const res = await fetch(input, init);
  if (res.status !== 429 || res.headers.get('x-should-retry')) return res;
  const text = await res.clone().text().catch(() => '');
  if (!HANGUL.test(errorMessageOf(text))) return res;
  const headers = new Headers(res.headers);
  headers.set('x-should-retry', 'false');
  return new Response(text, { status: res.status, statusText: res.statusText, headers });
}

function errorMessageOf(text) {
  try { return String(JSON.parse(text)?.error?.message || ''); } catch { return ''; }
}

/**
 * Relay-specific error mapping (null = the Claude provider's generic one). The relay's own answers — bad code,
 * model not allowed, daily budget — carry Korean, user-presentable messages and are shown as they are.
 */
function describeRelayError(err, sdk, info = {}) {
  const status = err?.status;
  const detail = String(err?.error?.error?.message || '');
  const warn = (code) => console.warn('[relay] error', code, status ?? '', detail || err?.message || '');
  if (err instanceof sdk.APIError && status && HANGUL.test(detail)) {
    const code = STATUS_CODES[status] || (status >= 500 ? 'server' : 'unknown');
    warn(code);
    if (code === 'permission') refreshMe().catch(() => {}); // the owner may have changed the code's models
    // "이 초대 코드로는 <model>을 쓸 수 없습니다." — the code no longer allows the model this tab still asks for:
    // not_found with the model, so getProvider() switches to an allowed one and retries (js/ai/models.js).
    if (code === 'permission' && info.model && detail.includes(info.model)) {
      return aiError(detail, { code: 'not_found', status, model: info.model, cause: err });
    }
    const message = code === 'quota' && !/내일/.test(detail) ? `${detail} 내일 다시 시도해 주세요.` : detail;
    return aiError(message, { code, status, cause: err });
  }
  if (err instanceof sdk.APIConnectionTimeoutError) return null;
  if (err instanceof sdk.APIConnectionError) {
    warn('network');
    return aiError(isRelayOriginAllowed() ? CONNECT_MESSAGE : CSP_MESSAGE, { code: 'network', cause: err });
  }
  // Passed through from Anthropic about the server's own key or credit: only the owner can fix these.
  if (err instanceof sdk.AuthenticationError || status === 402
    || (err instanceof sdk.BadRequestError && /credit balance/i.test(detail))) {
    warn('owner');
    return aiError(OWNER_SETUP_MESSAGE, { code: 'server', fatal: true, status, cause: err });
  }
  if (err instanceof sdk.NotFoundError) {
    warn('not_found');
    // Anthropic's own 404 passed through ("model: claude-…"): the model is gone, not the server address.
    if (info.model && /\bmodel\b/i.test(detail)) {
      return aiError(`초대 코드 서버에서 ${info.model} 모델을 찾을 수 없습니다. 설정에서 다른 모델을 고르거나, 계속되면 초대해 준 분에게 알려 주세요.`, {
        code: 'not_found', status, model: info.model, cause: err,
      });
    }
    return aiError(NOT_FOUND_MESSAGE, { code: 'not_found', status, cause: err });
  }
  return null;
}

// ───────────────────────────── /relay/me ─────────────────────────────

/**
 * Who the code belongs to and today's usage.
 * @param {{ code?: string, url?: string, signal?: AbortSignal }} [opts] default: the saved code and server
 * @returns {Promise<{ name: string, allowedModels: string[], dailyLimitUsd: number, todayUsd: number,
 *                     todayRequests: number, resetsAt: string }>}
 */
export async function fetchMe({ code = settings.get().relay?.code, url, signal } = {}) {
  const key = normalizeInviteCode(code);
  if (!key) throw aiError(NO_CODE_MESSAGE, { code: 'no_key' });
  const d = await relayFetch('/relay/me', { key, url, signal });
  return {
    name: typeof d.name === 'string' ? d.name : '',
    allowedModels: modelList(d.allowedModels),
    dailyLimitUsd: toNumber(d.dailyLimitUsd),
    todayUsd: toNumber(d.todayUsd),
    todayRequests: Math.round(toNumber(d.todayRequests)),
    resetsAt: typeof d.resetsAt === 'string' ? d.resetsAt : '',
  };
}

/**
 * fetchMe() for the saved code, remembering its name and allowed models; the models to request are picked from the
 * allowed ones (js/ai/models.js), so a code the owner changed is followed on the next visit.
 */
export async function refreshMe({ signal } = {}) {
  const code = normalizeInviteCode(settings.get().relay?.code);
  const me = await fetchMe({ code, signal });
  const r = settings.get().relay || {};
  if (normalizeInviteCode(r.code) !== code) return me; // the code was changed meanwhile
  const patch = {};
  if (r.name !== me.name) patch.name = me.name;
  if (JSON.stringify(r.allowedModels || []) !== JSON.stringify(me.allowedModels)) patch.allowedModels = me.allowedModels;
  if (Object.keys(patch).length) settings.set({ relay: patch });
  applyModelList(relayProvider, me.allowedModels); // drops choices the code no longer allows, picks the defaults
  return me;
}

/**
 * Join link / pasted code: check the code first, then switch this browser to the relay with it (an invalid code
 * leaves the settings untouched). Other providers' keys stay saved, so the user can switch back in 설정.
 * @returns {Promise<Awaited<ReturnType<typeof fetchMe>> & { code: string }>}
 */
export async function registerInviteCode(raw, { signal } = {}) {
  const code = normalizeInviteCode(raw);
  if (!isInviteCode(code)) throw aiError(FORMAT_MESSAGE, { code: 'bad_request' });
  const me = await fetchMe({ code, signal });
  settings.set({ provider: 'relay', relay: { code, name: me.name, allowedModels: me.allowedModels, ...NO_MODEL_CHOICE } });
  applyModelList(relayProvider, me.allowedModels);
  return { ...me, code };
}

/** Save a typed code; a different code forgets the previous one's name, models and model choices. */
export function saveInviteCode(raw) {
  const code = normalizeInviteCode(raw);
  const r = settings.get().relay || {};
  if (code === r.code) return code;
  settings.set({ relay: { code, name: '', allowedModels: [], ...NO_MODEL_CHOICE } });
  return code;
}

/** Save a server address; the default address is stored as '' so it follows RELAY_DEFAULT_URL. */
export function saveRelayUrl(raw) {
  const url = String(raw ?? '').trim().replace(/\/+$/, '');
  settings.set({ relay: { url: url === RELAY_DEFAULT_URL.replace(/\/+$/, '') ? '' : url } });
  return url;
}

// ───────────────────────────── admin ─────────────────────────────

/**
 * Every invite code with today's/this month's usage (KST) and the totals.
 * @param {{ token?: string, signal?: AbortSignal }} [opts] token default: the saved admin token
 */
export async function listCodes({ token, signal } = {}) {
  const d = await adminFetch('/relay/admin/codes', { token, signal });
  return {
    codes: (Array.isArray(d.codes) ? d.codes : []).map(toCode),
    todayTotalUsd: toNumber(d.todayTotalUsd),
    monthTotalUsd: toNumber(d.monthTotalUsd),
    globalDailyLimitUsd: toNumber(d.globalDailyLimitUsd),
  };
}

/** Create a code. @param {{ name: string, allowedModels?: string[], dailyLimitUsd?: number }} fields */
export async function createCode(fields, { token, signal } = {}) {
  const body = codeFields(fields, { requireName: true });
  return toCode(await adminFetch('/relay/admin/codes', { method: 'POST', body, token, signal }));
}

/** Change a code. @param {{ name?: string, active?: boolean, allowedModels?: string[], dailyLimitUsd?: number }} patch */
export async function updateCode(code, patch, { token, signal } = {}) {
  const body = codeFields(patch, { requireName: false });
  if (patch.active !== undefined) body.active = Boolean(patch.active);
  return toCode(await adminFetch(`/relay/admin/codes/${encodeURIComponent(code)}`, { method: 'PATCH', body, token, signal }));
}

/** Daily totals for the last `days` days (KST calendar days). */
export async function usage({ days = 30, token, signal } = {}) {
  const d = await adminFetch(`/relay/admin/usage?days=${encodeURIComponent(days)}`, { token, signal });
  return {
    days: (Array.isArray(d.days) ? d.days : []).map((x) => ({
      day: String(x?.day ?? ''),
      usd: toNumber(x?.usd),
      requests: Math.round(toNumber(x?.requests)),
      byModel: x?.byModel && typeof x.byModel === 'object' ? x.byModel : {},
    })),
  };
}

function adminFetch(path, { token = settings.get().relay?.adminToken, ...rest } = {}) {
  const t = String(token || '').trim();
  if (!t) return Promise.reject(aiError(NO_ADMIN_MESSAGE, { code: 'no_key' }));
  return relayFetch(path, { ...rest, admin: t });
}

/** Validate code fields like the worker does, so mistakes are explained before a request. */
function codeFields({ name, allowedModels, dailyLimitUsd } = {}, { requireName }) {
  const body = {};
  if (name !== undefined || requireName) {
    const n = String(name ?? '').trim();
    if (!n || n.length > NAME_MAX) throw aiError(`이름은 1~${NAME_MAX}자로 입력해 주세요.`, { code: 'bad_request' });
    body.name = n;
  }
  if (dailyLimitUsd !== undefined) {
    const v = Number(dailyLimitUsd);
    if (!Number.isFinite(v) || v < 0 || v > DAILY_LIMIT_MAX) {
      throw aiError(`하루 한도는 $0~$${DAILY_LIMIT_MAX} 사이로 입력해 주세요.`, { code: 'bad_request' });
    }
    body.dailyLimitUsd = Math.round(v * 100) / 100;
  }
  if (allowedModels !== undefined) {
    const known = new Set(CLAUDE_MODELS.map((m) => m.id));
    const list = [...new Set(allowedModels || [])].filter((m) => known.has(m));
    if (!list.length) throw aiError('쓸 수 있는 모델을 하나 이상 골라 주세요.', { code: 'bad_request' });
    body.allowedModels = list;
  }
  return body;
}

function toCode(c) {
  return {
    code: String(c?.code ?? ''),
    name: String(c?.name ?? ''),
    active: c?.active !== false && c?.active !== 0,
    allowedModels: modelList(c?.allowedModels),
    dailyLimitUsd: toNumber(c?.dailyLimitUsd),
    createdAt: toTime(c?.createdAt),
    lastUsedAt: toTime(c?.lastUsedAt),
    todayUsd: toNumber(c?.todayUsd),
    monthUsd: toNumber(c?.monthUsd),
    totalUsd: toNumber(c?.totalUsd),
    totalRequests: Math.round(toNumber(c?.totalRequests)),
  };
}

// ───────────────────────────── transport ─────────────────────────────

/**
 * JSON request to the relay's own endpoints. `key` = invite code (x-api-key), `admin` = admin token (Bearer).
 * Errors are Korean aiErrors; the relay's own Korean messages are kept as they are.
 */
async function relayFetch(path, { method = 'GET', body, key, admin, url = settings.relayUrl(), signal } = {}) {
  const root = String(url || '').trim().replace(/\/+$/, '');
  if (!root) throw aiError(NO_URL_MESSAGE, { code: 'no_key' });
  const headers = admin ? { authorization: `Bearer ${admin}` } : { 'x-api-key': key };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  let res;
  let data = null;
  try {
    res = await fetch(`${root}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: signal && AbortSignal.any ? AbortSignal.any([signal, timeout]) : signal || timeout,
      credentials: 'omit',
      cache: 'no-store',
    });
    data = await res.json().catch(() => null);
  } catch (err) {
    if (signal?.aborted) throw aiError('요청을 취소했습니다.', { code: 'aborted', cause: err });
    if (timeout.aborted) throw aiError(TIMEOUT_MESSAGE, { code: 'timeout', cause: err });
    console.warn('[relay] request failed', path, err);
    throw aiError(isRelayOriginAllowed(root) ? CONNECT_MESSAGE : CSP_MESSAGE, { code: 'network', cause: err });
  }
  if (!res.ok) throw httpError(res.status, data, Boolean(admin));
  if (!data || typeof data !== 'object') {
    throw aiError('초대 코드 서버의 응답을 해석하지 못했습니다. 설정의 서버 주소가 맞는지 확인해 주세요.', { code: 'parse' });
  }
  return data;
}

function httpError(status, data, admin) {
  const detail = data?.error?.message;
  const code = STATUS_CODES[status] || (status >= 500 ? 'server' : 'unknown');
  let message;
  if (typeof detail === 'string' && HANGUL.test(detail)) message = detail;
  else if (status === 401 || (admin && status === 403)) message = admin ? ADMIN_AUTH_MESSAGE : BAD_CODE_MESSAGE;
  else if (status === 404) message = NOT_FOUND_MESSAGE;
  else if (status === 429) message = '오늘 사용 한도를 모두 썼습니다. 내일 다시 시도해 주세요.';
  else message = `초대 코드 서버에서 오류가 발생했습니다(HTTP ${status}). 잠시 후 다시 시도해 주세요.`;
  console.warn('[relay] HTTP', status, detail || '');
  return aiError(message, { code, status });
}

/**
 * Whether this page's CSP lets fetch() reach `url` (connect-src, else default-src). The CSP is a static <meta> in
 * index.html, so a server address other than the deployed default is blocked by the browser before any request.
 */
export function isRelayOriginAllowed(url = settings.relayUrl()) {
  let target;
  try { target = new URL(url); } catch { return false; }
  let meta = null;
  try { meta = document.querySelector('meta[http-equiv="Content-Security-Policy" i]'); } catch { return true; }
  if (!meta) return true;
  const directives = new Map();
  for (const part of String(meta.getAttribute('content') || '').split(';')) {
    const [name, ...values] = part.trim().split(/\s+/);
    if (name && !directives.has(name.toLowerCase())) directives.set(name.toLowerCase(), values);
  }
  const sources = directives.get('connect-src') || directives.get('default-src');
  return !sources || sources.some((src) => sourceMatches(src.toLowerCase(), target));
}

function sourceMatches(src, url) {
  if (src === "'self'") return url.origin === location.origin;
  if (src.startsWith("'")) return false;
  if (src === '*') return url.protocol === 'https:' || url.protocol === 'http:';
  if (/^[a-z][a-z0-9+.-]*:$/.test(src)) return url.protocol === src;
  const m = /^(?:([a-z][a-z0-9+.-]*):\/\/)?(\*\.)?([^/:]+)(?::(\d+|\*))?/.exec(src);
  if (!m) return false;
  const [, scheme, wildcard, host, port] = m;
  const sourceScheme = scheme ? `${scheme}:` : location.protocol;
  const upgraded = sourceScheme === 'http:' && url.protocol === 'https:'; // http: sources also allow https:
  if (url.protocol !== sourceScheme && !upgraded) return false;
  if (wildcard ? !url.hostname.endsWith(`.${host}`) : url.hostname !== host) return false;
  if (port === '*') return true;
  const defaultPort = (protocol) => (protocol === 'https:' ? '443' : '80');
  return (port || defaultPort(url.protocol)) === (url.port || defaultPort(url.protocol));
}

// ───────────────────────────── helpers ─────────────────────────────

function safeDecode(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}

function modelList(v) {
  return Array.isArray(v) ? v.filter((m) => typeof m === 'string' && m) : [];
}

function toNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** ms since epoch from a number (seconds or ms) or an ISO string; 0 when unknown. */
function toTime(v) {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v < 1e12 ? v * 1000 : v;
  if (typeof v === 'string' && v) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return n < 1e12 ? n * 1000 : n;
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : 0;
  }
  return 0;
}
