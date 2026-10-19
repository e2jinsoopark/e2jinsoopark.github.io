// Invite-code relay (docs/RELAY.md): colleagues use the app without an API key. The relay provider is the Claude
// provider pointed at the owner's Cloudflare Worker (baseURL = settings.relayUrl(), apiKey = the invite code), so
// requests, streaming and errors are the Claude provider's. Plus the worker's own endpoints: GET /relay/me (who am I,
// today's usage) and the owner's /relay/admin/* (invite codes, usage), and helpers for invite links.
//
// relay.js and providers.js import each other: nothing here may use an imported binding at module top level (the
// Claude provider underneath is made on first use).
import { bus } from '../core/bus.js';
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
/** Length of a code the owner chooses, hyphens included (relay/src/codes.js CUSTOM_CODE_MIN/MAX). */
export const CUSTOM_CODE_MIN = 6;
export const CUSTOM_CODE_MAX = 24;
/**
 * Words a chosen code may not be, compared without hyphens — the same list as relay/src/codes.js RESERVED_CODES
 * (checked here only to say so before a request; the Worker has the final say with a 400).
 */
export const RESERVED_CODES = Object.freeze([
  'ADMIN', 'ADMINS', 'ADMINISTRATOR', 'ROOT', 'SYSTEM', 'MASTER', 'RELAY', 'PAPERRELAY', 'SHARED', 'SHARE', 'JOIN',
  'INVITE', 'INVITES', 'INVITECODE', 'CODE', 'CODES', 'SETTINGS', 'LIBRARY', 'TEAM', 'GALPI', 'PAPER', 'PAPERS',
  'TEST', 'TESTS', 'TESTING', 'TESTER', 'DEMO', 'SAMPLE', 'EXAMPLE', 'GUEST', 'ANONYMOUS', 'USER', 'USERS', 'LOGIN',
  'SIGNIN', 'PUBLIC', 'PRIVATE', 'PASSWORD', 'PASSWD', 'SECRET', 'TOKEN', 'APIKEY', 'DEFAULT', 'NULL', 'UNDEFINED',
  'NONE', 'TRUE', 'FALSE', 'ANTHROPIC', 'CLAUDE', 'OPENAI', 'GEMINI', 'GITHUB', 'WELCOME', 'LETMEIN', 'HELLO',
]);
// Keyboard rows and counting runs: a code that is a piece of one of these is too easy to guess (relay/src/codes.js).
const RUNS = ['01234567890', '09876543210', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'ZYXWVUTSRQPONMLKJIHGFEDCBA', 'QWERTYUIOP',
  'ASDFGHJKL', 'ZXCVBNM'];

const REQUEST_TIMEOUT_MS = 20_000;
/** Deleting a code also deletes its files in every team library (one GitHub commit each): give it longer. */
const DELETE_TIMEOUT_MS = 90_000;
/**
 * Emitted on the bus when the saved invite code — one that worked on this device before — is refused with a 401
 * (the owner deleted or stopped it): `{ code }`. js/app.js clears the code once and tells the person.
 */
export const CODE_REFUSED_EVENT = 'relay:code-refused';
const HANGUL = /[가-힣]/;
// Crockford base32 (no I, L, O, U), as relay/src/codes.js generates and reads it.
const CODE_RE = /^PR-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;
// A chosen code as stored: A–Z 0–9 and single hyphens, starting and ending with a letter or digit.
const CUSTOM_RE = /^[0-9A-Z]+(?:-[0-9A-Z]+)*$/;
/** The shortest chosen code ("A-B-CD", 6 characters) has 4 letters and digits: what a presented code needs at least. */
const KEY_MIN = 4;
// Every dash look-alike a phone keyboard or a messenger may produce.
const DASHES = /[‐-―−﹘﹣－]/g;
const STATUS_CODES = { 400: 'bad_request', 401: 'auth', 403: 'permission', 404: 'not_found', 409: 'conflict', 413: 'bad_request', 429: 'quota' };
// A new code starts on 자동 선택 (models picked from the code's allowed ones).
const NO_MODEL_CHOICE = Object.freeze({ translateModel: '', assistModel: '', autoModels: { translate: '', assist: '' } });

const NO_URL_MESSAGE = '초대 코드 서버 주소가 없습니다. 설정 → AI 번역 → 키 없이 쓰기에서 서버 주소를 입력해 주세요.';
const NO_CODE_MESSAGE = '초대 코드가 없습니다. 설정 → AI 번역 → 키 없이 쓰기에서 초대 코드를 입력해 주세요.';
const BAD_CODE_MESSAGE = '초대 코드가 올바르지 않거나 사용이 중지되었습니다.';
const FORMAT_MESSAGE = '초대 코드 형식이 올바르지 않습니다. 받은 코드(예: PR-7K3M-9QXA)를 그대로 넣었는지 확인해 주세요.';
const CONNECT_MESSAGE = '초대 코드 서버에 연결할 수 없습니다. 인터넷 연결을 확인하고, 계속되면 설정의 서버 주소를 확인해 주세요.';
const CSP_MESSAGE = '이 앱의 보안 정책(CSP)이 초대 코드 서버 주소로의 연결을 막았습니다. 설정의 서버 주소를 확인해 주세요. '
  + '다른 서버를 쓰려면 관리자가 index.html의 connect-src에 그 주소를 추가해야 합니다.';
const TIMEOUT_MESSAGE = '초대 코드 서버가 응답하지 않습니다. 잠시 후 다시 시도해 주세요.';
const OWNER_SETUP_MESSAGE = '초대 코드 서버의 Claude 연결(관리자의 API 키 또는 크레딧)에 문제가 있습니다. 초대해 준 분에게 알려 주세요.';
const NOT_FOUND_MESSAGE = '초대 코드 서버에서 요청한 기능을 찾을 수 없습니다. 설정의 서버 주소가 맞는지 확인해 주세요.';
const ADMIN_AUTH_MESSAGE = '관리자 토큰이 올바르지 않습니다.';
const NO_ADMIN_MESSAGE = '관리자 토큰을 먼저 저장해 주세요.';
const NO_DELETE_MESSAGE = '초대 코드 서버가 아직 코드 삭제를 지원하지 않습니다. 서버(Worker)를 새 버전으로 배포한 뒤 다시 시도해 주세요.';

// ───────────────────────────── invite codes ─────────────────────────────

/*
 * Two kinds of code (relay/src/codes.js decides; this mirrors it so that mistakes are caught before a request):
 * - generated  PR-XXXX-XXXX (Crockford base32). Anything that is "PR" + 8 letters/digits once every other character
 *              is dropped (spaces, dashes, dots, Hangul…) is this kind: upper case, PR-XXXX-XXXX dashes, and the
 *              look-alikes the generator never emits read as digits (O → 0, I/L → 1). A U left over means no code.
 * - chosen     by the owner: 6–24 of A–Z, 0–9 and hyphens ("ICU-2TEAM"), stored in upper case with the owner's
 *              hyphens. No letter is ever replaced (an O stays an O). The generated shape is reserved for generated
 *              codes, so the O/I/L reading never touches a chosen code. The Worker matches a presented code by its KEY
 *              (letters and digits only): "icu 2team", "ICU2TEAM" and "Icu-2team" all open "ICU-2TEAM".
 * In this app a typed chosen code is kept as typed, folded: upper case, full-width letters as ASCII, spaces and dash
 * look-alikes as one hyphen, no hyphen at either end.
 */

/** Upper case, ASCII (full-width letters from a Korean keyboard folded), dash look-alikes as '-'. */
function fold(raw) {
  let s = String(raw ?? '');
  try { s = s.normalize('NFKC'); } catch { /* keep */ }
  return s.toUpperCase().replace(DASHES, '-').trim();
}

/**
 * "PR" + 8 letters/digits once everything that is not A–Z/0–9 is dropped (the generated shape, exactly as
 * relay/src/codes.js codeKey reads it) → PR-XXXX-XXXX with O → 0 and I/L → 1, else ''. The result may still not be a
 * code (a U is not Crockford); isInviteCode decides. The same rules are pinned by relay/test/code-vectors.json.
 */
function generatedForm(folded) {
  const compact = folded.replace(/[^0-9A-Z]/g, '');
  const m = /^PR([0-9A-Z]{4})([0-9A-Z]{4})$/.exec(compact);
  if (!m) return '';
  const digits = (x) => x.replace(/O/g, '0').replace(/[IL]/g, '1');
  return `PR-${digits(m[1])}-${digits(m[2])}`;
}

/**
 * Canonical form of a typed or pasted code (or a whole pasted invite link): see the two kinds above.
 * @param {unknown} raw
 */
export function normalizeInviteCode(raw) {
  let s = String(raw ?? '').trim();
  const link = /#\/join\/([^/?#\s]+)/i.exec(s);
  if (link) s = safeDecode(link[1]);
  const folded = fold(s);
  return generatedForm(folded) || folded.replace(/[\s-]+/g, '-').replace(/^-+|-+$/g, '');
}

/** True for a generated PR-XXXX-XXXX code (after normalizeInviteCode). */
export function isGeneratedCode(code) {
  return CODE_RE.test(String(code || ''));
}

/**
 * What the Worker matches a code by: its letters and digits ("ICU-2TEAM" and "ICU2TEAM" are one code). Two spellings
 * of one code are the same code here too (the saved code vs a join link).
 */
export function inviteCodeKey(code) {
  return normalizeInviteCode(code).replace(/-/g, '');
}

/** True for a code that can exist (after normalizeInviteCode): generated, or a chosen code's spelling. */
export function isInviteCode(code) {
  const c = String(code || '');
  if (CODE_RE.test(c)) return true;
  const key = c.replace(/-/g, '');
  return CUSTOM_RE.test(c) && key.length >= KEY_MIN && key.length <= CUSTOM_CODE_MAX && !generatedForm(c);
}

/**
 * The owner's own code for a new invite (설정 → 초대 코드 관리 → 코드 직접 정하기), checked like the Worker does.
 * '' = none (a random one is made).
 * @returns {{ code: string, error?: undefined } | { code?: undefined, error: string }}
 */
export function checkCustomCode(raw) {
  const folded = fold(raw);
  if (!folded) return { code: '' };
  if (/[^0-9A-Z\s-]/.test(folded)) return { error: '코드는 영문·숫자·하이픈(-)만 쓸 수 있어요.' };
  if (generatedForm(folded)) return { error: 'PR-XXXX-XXXX 모양은 자동으로 만드는 코드용이에요. 다른 모양으로 정해 주세요.' };
  const code = folded.replace(/[\s-]+/g, '-').replace(/^-+|-+$/g, '');
  if (code.length < CUSTOM_CODE_MIN || code.length > CUSTOM_CODE_MAX || !CUSTOM_RE.test(code)) {
    return { error: `코드는 하이픈을 포함해 ${CUSTOM_CODE_MIN}~${CUSTOM_CODE_MAX}자로 정해 주세요.` };
  }
  const key = code.replace(/-/g, '');
  if (RESERVED_CODES.includes(key)) return { error: '이 단어는 코드로 쓸 수 없어요. 다른 코드를 정해 주세요.' };
  if (/^(.)\1+$/.test(key) || RUNS.some((run) => run.includes(key))) {
    return { error: '너무 쉬운 코드예요(같은 글자 반복이나 123456·ABCDEF·QWERTY 같은 순서). 다른 코드를 정해 주세요.' };
  }
  return { code };
}

/**
 * The invite code in whatever was pasted or typed: a bare code (any case, with or without hyphens), a whole invite
 * link, or the whole invite message from a messenger. In this order: '#/join/<code>' in a link → a line
 * '코드: <code>' → a PR-XXXX-XXXX pattern → the trimmed text itself as a chosen code. '' when nothing can be a code.
 * @param {unknown} text
 */
export function extractInviteCode(text) {
  const s = String(text ?? '');
  const take = (raw) => {
    const code = normalizeInviteCode(raw);
    return isInviteCode(code) ? code : '';
  };
  // A pasted message can lose its line breaks (single-line inputs strip them), so a code is read only as far as
  // letters, digits, hyphens and %-escapes go.
  const link = /#\/join\/((?:[0-9A-Za-z\-‐-―−－]|%[0-9A-Fa-f]{2})+)/.exec(s);
  const line = /코드\s*[:：]\s*([0-9A-Za-z０-９Ａ-Ｚａ-ｚ\-‐-―−－]+)/.exec(s);
  const generated = /(?<![0-9A-Za-z-])P\s*R[\s\-‐-―−－]*[0-9A-Za-z]{4}[\s\-‐-―−－]*[0-9A-Za-z]{4}(?![0-9A-Za-z-])/i.exec(s);
  const bare = s.trim();
  const candidates = [link && safeDecode(link[1]), line?.[1], generated?.[0], bare && !/[\r\n]/.test(bare) ? bare : ''];
  for (const raw of candidates) {
    const code = raw ? take(raw) : '';
    if (code) return code;
  }
  return '';
}

/** Join link for a code; the code travels in the fragment, which browsers never send to a server. */
export function inviteLink(code) {
  return `${APP_PUBLIC_URL.replace(/\/+$/, '')}/#/join/${encodeURIComponent(code)}`;
}

/**
 * Korean invite text to paste into a messenger: a short title, the join link, and the code on its own line (for a
 * home-screen app or another browser, where it is pasted into the first screen).
 *   [갈피 초대] 김간호사님
 *   https://e2jinsoopark.github.io/#/join/PR-7K3M-Q9XD
 *   코드: PR-7K3M-Q9XD
 * @param {{ code: string, name?: string }} info
 */
export function inviteMessage({ code, name = '' }) {
  const who = String(name || '').trim();
  return [who ? `[갈피 초대] ${who}님` : '[갈피 초대]', inviteLink(code), `코드: ${code}`].join('\n');
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
    if (status === 401) reportRefusedCode(settings.get().relay?.code); // deleted or stopped by the owner
    // "이 초대 코드로는 <model>을 쓸 수 없습니다." — the code no longer allows the model this tab still asks for:
    // not_found with the model, so getProvider() switches to an allowed one and retries (js/ai/models.js).
    if (code === 'permission' && info.model && detail.includes(info.model)) {
      return aiError(detail, { code: 'not_found', status, model: info.model, cause: err });
    }
    // "내일 다시" belongs to the daily budget only, not to the relay's too-many-tries refusal ("잠시 후 다시…").
    const message = code === 'quota' && /한도/.test(detail) && !/내일|잠시 후/.test(detail) ? `${detail} 내일 다시 시도해 주세요.` : detail;
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
  // The code this browser already has (a join link opened twice, an iPhone home-screen app that starts at its join
  // link every time): nothing to check or change — only an AI setup that is no longer usable falls back to it.
  const saved = settings.get().relay || {};
  if (saved.code && inviteCodeKey(saved.code) === inviteCodeKey(code)) {
    if (!settings.isAiReady()) settings.set({ provider: 'relay' });
    return {
      name: saved.name || '', allowedModels: modelList(saved.allowedModels), dailyLimitUsd: 0, todayUsd: 0, todayRequests: 0,
      resetsAt: '', code: normalizeInviteCode(saved.code), unchanged: true,
    };
  }
  const me = await fetchMe({ code, signal });
  settings.set({ provider: 'relay', relay: { code, name: me.name, allowedModels: me.allowedModels, ...NO_MODEL_CHOICE } });
  applyModelList(relayProvider, me.allowedModels);
  return { ...me, code };
}

/**
 * A 401 for `code` (from /relay/me, /shared, the 공용 서재 proxy or /v1/messages). When it is the saved code and that
 * code worked on this device before (its name / allowed models came from the relay), the owner has deleted or stopped
 * it: CODE_REFUSED_EVENT once, and js/app.js clears it. A code being tried (first screen, join link, a code just typed
 * in 설정 — saveInviteCode forgets the name and models) is only an error where it was typed.
 * @returns {boolean} whether it was reported
 */
export function reportRefusedCode(code) {
  const key = code ? inviteCodeKey(code) : '';
  const r = settings.get().relay || {};
  if (!key || !r.code || inviteCodeKey(r.code) !== key) return false;
  const accepted = Boolean(String(r.name || '').trim()) || modelList(r.allowedModels).length > 0;
  if (!accepted) return false;
  console.warn('[relay] the saved invite code was refused (401): deleted or stopped by the owner');
  bus.emit(CODE_REFUSED_EVENT, { code: normalizeInviteCode(r.code) });
  return true;
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

// ───────────────────────────── shared team library (docs/SHARED.md) ─────────────────────────────

/** Library ids the Worker uses in paths (`/shared/<lib>/…`). */
const LIBRARY_ID = /^[A-Za-z0-9_-]{1,64}$/;
const SHARED_NAME = '공용 서재';

/**
 * The team libraries this code may use: GET /shared → libraries, the code's personId (its per-person folder in the
 * team repo) and name. The code goes as `Authorization: Bearer` like the GitHub proxy's.
 * @param {{ code?: string, url?: string, signal?: AbortSignal }} [opts] default: the saved code and server
 * @returns {Promise<{ libraries: { id: string, name: string }[], personId: string, name: string }>}
 */
export async function fetchShared({ code = settings.get().relay?.code, url, signal } = {}) {
  const key = normalizeInviteCode(code);
  if (!key) throw aiError(NO_CODE_MESSAGE, { code: 'no_key' });
  const d = await relayFetch('/shared', { bearer: key, url, signal });
  const seen = new Set();
  const libraries = [];
  for (const x of Array.isArray(d.libraries) ? d.libraries : []) {
    const id = String(x?.id ?? '');
    if (!LIBRARY_ID.test(id) || seen.has(id)) continue;
    seen.add(id);
    const name = typeof x?.name === 'string' && x.name.trim() ? x.name.trim().slice(0, 60) : SHARED_NAME;
    libraries.push({ id, name });
  }
  return {
    libraries,
    personId: typeof d.personId === 'string' && /^[0-9a-f]{16}$/.test(d.personId) ? d.personId : '',
    name: typeof d.name === 'string' ? d.name : '',
  };
}

/**
 * Who added, moved or deleted what in a team library, newest first: GET /shared/<lib>/activity (from the team repo's
 * recent commits; `who` is the name of the invite code that made the change).
 * @returns {Promise<{ items: { ts: number, who: string, summary: string }[] }>}
 */
export async function fetchActivity(lib, { limit = 50, code = settings.get().relay?.code, url, signal } = {}) {
  const key = normalizeInviteCode(code);
  if (!key) throw aiError(NO_CODE_MESSAGE, { code: 'no_key' });
  const n = Math.min(Math.max(Math.round(Number(limit) || 50), 1), 100);
  const d = await relayFetch(`/shared/${libraryPath(lib)}/activity?limit=${n}`, { bearer: key, url, signal });
  const items = (Array.isArray(d.items) ? d.items : []).map((x) => ({
    ts: toTime(x?.ts),
    who: typeof x?.who === 'string' ? x.who : '',
    summary: typeof x?.summary === 'string' ? x.summary : '',
  })).filter((x) => x.summary || x.who);
  items.sort((a, b) => b.ts - a.ts);
  return { items };
}

/**
 * Admin: size of a team library (`maxBytes`: the Worker's cap, 0 when it does not say).
 * @returns {Promise<{ bytes: number, papers: number, people: number, maxBytes: number }>}
 */
export async function sharedStats(lib, { token, signal } = {}) {
  const d = await adminFetch(`/relay/admin/shared/${libraryPath(lib)}/stats`, { token, signal });
  return {
    bytes: toNumber(d.bytes), papers: Math.round(toNumber(d.papers)), people: Math.round(toNumber(d.people)), maxBytes: toNumber(d.maxBytes),
  };
}

/**
 * Admin: delete the files of papers that have been in the 휴지통 for more than 30 days (one server-side commit; the
 * tombstone records stay). The Worker answers { purged: [paperId], files, freedBytes, commitSha }; `purged` here is
 * the number of papers whose files were removed.
 * @returns {Promise<{ purged: number, bytes: number, raw: object }>}
 */
export async function purgeShared(lib, { token, signal } = {}) {
  const d = await adminFetch(`/relay/admin/shared/${libraryPath(lib)}/purge`, { method: 'POST', body: {}, token, signal });
  const list = [d.purged, d.papers, d.removed, d.paperIds].find(Array.isArray);
  const purged = list ? list.length : Math.round(toNumber(d.purged ?? d.removed ?? d.count ?? d.papers));
  return { purged, bytes: toNumber(d.bytes ?? d.freedBytes), raw: d };
}

/** GitHub-API-compatible proxy root for a team library (the GitHubClient's `apiBase`). */
export function sharedApiBase(lib, url = settings.relayUrl()) {
  const root = String(url || '').trim().replace(/\/+$/, '');
  return root ? `${root}/shared/${libraryPath(lib)}/gh` : '';
}

function libraryPath(lib) {
  const id = String(lib ?? '');
  if (!LIBRARY_ID.test(id)) throw aiError('공용 서재 이름(id)이 올바르지 않습니다.', { code: 'bad_request' });
  return id;
}

// ───────────────────────────── admin ─────────────────────────────

/**
 * Every invite code with today's/this month's usage (KST) and the totals.
 * @param {{ token?: string, signal?: AbortSignal }} [opts] token default: the saved admin token
 */
export async function listCodes({ token, signal } = {}) {
  const d = await adminFetch('/relay/admin/codes', { token, signal });
  const codes = (Array.isArray(d.codes) ? d.codes : []).map(toCode);
  const todayTotalUsd = toNumber(d.todayTotalUsd);
  const monthTotalUsd = toNumber(d.monthTotalUsd);
  // Deleted codes keep their usage rows, so the totals include them; the list shows their month as one row.
  // Taken from the Worker (`deletedUsage: { todayUsd, monthUsd, … }`), else what the totals hold beyond the listed codes.
  const deleted = (field, total, key) => {
    const given = [d.deletedUsage?.[key], d[field]].find((v) => v !== undefined && v !== null);
    const rest = given !== undefined ? toNumber(given) : total - codes.reduce((s, c) => s + c[key], 0);
    return rest >= 0.005 ? Math.round(rest * 1e6) / 1e6 : 0;
  };
  return {
    codes,
    todayTotalUsd,
    monthTotalUsd,
    deletedTodayUsd: deleted('deletedTodayUsd', todayTotalUsd, 'todayUsd'),
    deletedMonthUsd: deleted('deletedMonthUsd', monthTotalUsd, 'monthUsd'),
    globalDailyLimitUsd: toNumber(d.globalDailyLimitUsd),
  };
}

/**
 * Create a code: a random PR-XXXX-XXXX, or `code` when the owner chose one (checkCustomCode; the Worker answers 409
 * when it is taken, 400 when it is not allowed — both with Korean messages, shown as they are).
 * @param {{ name: string, code?: string, allowedModels?: string[], dailyLimitUsd?: number }} fields
 */
export async function createCode(fields, { token, signal } = {}) {
  const body = codeFields(fields, { requireName: true });
  if (fields.code !== undefined && String(fields.code).trim()) {
    const chosen = checkCustomCode(fields.code);
    if (chosen.error) throw aiError(chosen.error, { code: 'bad_request' });
    body.code = chosen.code;
  }
  return toCode(await adminFetch('/relay/admin/codes', { method: 'POST', body, token, signal }));
}

/** Change a code. @param {{ name?: string, active?: boolean, allowedModels?: string[], dailyLimitUsd?: number }} patch */
export async function updateCode(code, patch, { token, signal } = {}) {
  const body = codeFields(patch, { requireName: false });
  if (patch.active !== undefined) body.active = Boolean(patch.active);
  return toCode(await adminFetch(`/relay/admin/codes/${encodeURIComponent(code)}`, { method: 'PATCH', body, token, signal }));
}

/**
 * Delete a code for good: the Worker removes its files (people/<personId>/: highlights, notes, AI results) from every
 * team library, then the code. Its usage stays in the totals. A GitHub failure is a 502 with a Korean message and the
 * code is kept (try again); a code that is already gone is a 404.
 * @returns {Promise<{ deleted: boolean, purgedFiles: number }>}
 */
export async function deleteCode(code, { token, signal } = {}) {
  let d;
  try {
    d = await adminFetch(`/relay/admin/codes/${encodeURIComponent(code)}`, { method: 'DELETE', token, signal, timeoutMs: DELETE_TIMEOUT_MS });
  } catch (err) {
    // A Worker from before deleting existed: DELETE is not one of its methods.
    if (err?.status === 405) throw aiError(NO_DELETE_MESSAGE, { code: 'not_found', status: 405 });
    throw err;
  }
  return { deleted: d.deleted !== false, purgedFiles: Math.round(toNumber(d.purgedFiles)) };
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
 * JSON request to the relay's own endpoints. `key` = invite code (x-api-key), `bearer` = invite code sent as
 * `Authorization: Bearer` (the shared-library endpoints), `admin` = admin token (Bearer).
 * Errors are Korean aiErrors; the relay's own Korean messages are kept as they are.
 */
async function relayFetch(path, { method = 'GET', body, key, bearer, admin, url = settings.relayUrl(), signal, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const root = String(url || '').trim().replace(/\/+$/, '');
  if (!root) throw aiError(NO_URL_MESSAGE, { code: 'no_key' });
  const token = admin || bearer;
  const headers = token ? { authorization: `Bearer ${token}` } : { 'x-api-key': key };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const timeout = AbortSignal.timeout(timeoutMs);
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
  if (!res.ok) {
    const err = httpError(res.status, data, Boolean(admin));
    if (res.status === 401 && !admin) reportRefusedCode(key || bearer); // only the saved, once-working code
    throw err;
  }
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
  else if (status === 409) message = '이미 있는 코드입니다. 다른 코드를 정해 주세요.';
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
