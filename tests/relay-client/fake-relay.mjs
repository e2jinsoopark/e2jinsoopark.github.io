// In-process fake of the invite-code relay worker, answering exactly what docs/RELAY.md specifies: CORS (echo an
// allowed Origin, expose only request-id / x-relay-*), Anthropic-shaped errors with Korean messages, `x-should-retry:
// false` on refusals, /v1/messages (JSON + SSE, ?beta=true), /v1/models, /relay/me and /relay/admin/*.
// Used through Playwright route interception of RELAY_URL; nothing leaves the machine.
// Codes as the Worker has them since custom codes (relay/src/codes.js, imported): a presented code is matched by its
// key (letters and digits), the owner may choose a code (POST `code`; 409 when its key is taken, 400 when not allowed),
// and more than CODE_FAIL_LIMIT unknown codes in a window → 429 "시도가 너무 많습니다…" (relay/src/limiter.js).
import { parseTranslationUserMessage } from '../../js/ai/prompts.js';
import { codeKey, validateCustomCode } from '../../relay/src/codes.js';

export const RELAY_URL = 'https://relay.test';
export const ADMIN_TOKEN = 'adm-test-token-0000';
const EXPOSE = 'request-id, x-relay-today-usd, x-relay-limit-usd';
const ALLOWED_ORIGINS = [/^https:\/\/e2jinsoopark\.github\.io$/, /^http:\/\/localhost:\d+$/, /^http:\/\/127\.0\.0\.1:\d+$/];
const KNOWN_MODELS = ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5'];
const HAIKU = ['claude-haiku-5-5'];
const HAIKU_SONNET = ['claude-haiku-5-5', 'claude-sonnet-5-5'];
const DAY = 86_400_000;
export const CODE_FAIL_LIMIT = 20;
const FAIL_WINDOW_MS = 10 * 60 * 1000;
export const TOO_MANY_MESSAGE = '시도가 너무 많습니다. 잠시 후 다시 시도해 주세요.';
const TAKEN_MESSAGE = '이미 있는 코드입니다(대소문자와 하이픈은 구분하지 않습니다). 다른 코드를 정해 주세요.';

/** Codes every test starts with (Crockford base32: no I, L, O, U). */
export const CODES = Object.freeze({
  haiku: 'PR-7K3M-9QXA', // 홍길동, Haiku only, $0.03 of $0.50 used today
  sonnet: 'PR-5NWB-2C4D', // 김간호, Haiku + Sonnet
  spent: 'PR-Q0TA-D0NE', // 이한도, today's budget used up
  stopped: 'PR-ST0P-PED1', // 박중지, disabled
  ownerKey: 'PR-AP1K-EY00', // upstream answers 401 (the owner's Anthropic key is bad)
  ownerCredit: 'PR-CRED-1T00', // upstream answers 400 "credit balance is too low"
});

function seed() {
  const now = Date.now();
  const rec = (code, fields) => ({
    code, active: true, allowedModels: [...HAIKU], dailyLimitUsd: 0.5, todayUsd: 0, todayRequests: 0, monthUsd: 0,
    totalUsd: 0, totalRequests: 0, createdAt: now - 10 * DAY, lastUsedAt: null, upstream: 'ok', ...fields,
  });
  return new Map([
    rec(CODES.haiku, { name: '홍길동', todayUsd: 0.03, todayRequests: 4, monthUsd: 1.2, totalUsd: 3.4, totalRequests: 120, lastUsedAt: now - 3_600_000, createdAt: now - 20 * DAY }),
    rec(CODES.sonnet, { name: '김간호', allowedModels: [...HAIKU_SONNET], dailyLimitUsd: 1, todayUsd: 0.12, todayRequests: 9, monthUsd: 2.5, totalUsd: 2.5, totalRequests: 80, lastUsedAt: now - 600_000 }),
    rec(CODES.spent, { name: '이한도', todayUsd: 0.5, todayRequests: 40, monthUsd: 0.5, totalUsd: 0.5, totalRequests: 40, lastUsedAt: now - 60_000 }),
    rec(CODES.stopped, { name: '박중지', active: false, totalUsd: 0.2, totalRequests: 10, createdAt: now - 30 * DAY }),
    rec(CODES.ownerKey, { name: '키오류', upstream: 'auth' }),
    rec(CODES.ownerCredit, { name: '크레딧', upstream: 'credit' }),
  ].map((r) => [r.code, r]));
}

const usd = (v) => `$${v.toFixed(2)}`;
const anthropicError = (status, type, message, headers = {}) => ({
  status, headers, json: { type: 'error', error: { type, message } },
});

/** The next 00:00 in Asia/Seoul (UTC+9, no DST) as ISO. */
function nextKstMidnight(now = Date.now()) {
  const kst = new Date(now + 9 * 3_600_000);
  const midnightKst = Date.UTC(kst.getUTCFullYear(), kst.getUTCMonth(), kst.getUTCDate() + 1);
  return new Date(midnightKst - 9 * 3_600_000).toISOString();
}

export function createFakeRelay() {
  const db = seed();
  /** Every non-preflight request: { method, path, search, headers, body }. */
  const calls = [];
  let seq = 0;
  let nextCode = 0;
  /** Failed code lookups of this "network" (one fake = one IP): { at, guess }. */
  const failures = [];
  const keyOf = (code) => String(code).replace(/-/g, '');
  const findByKey = (key) => [...db.values()].find((r) => keyOf(r.code) === key) || null;

  const toApi = (r) => ({
    code: r.code, name: r.name, active: r.active, allowedModels: [...r.allowedModels], dailyLimitUsd: r.dailyLimitUsd,
    createdAt: r.createdAt, lastUsedAt: r.lastUsedAt, todayUsd: r.todayUsd, monthUsd: r.monthUsd, totalUsd: r.totalUsd,
    totalRequests: r.totalRequests,
  });

  function validate(fields, partial) {
    if (fields.name !== undefined || !partial) {
      if (typeof fields.name !== 'string' || !fields.name.trim() || fields.name.trim().length > 40) return '이름은 1~40자여야 합니다.';
    }
    if (fields.dailyLimitUsd !== undefined && !(typeof fields.dailyLimitUsd === 'number' && fields.dailyLimitUsd >= 0 && fields.dailyLimitUsd <= 20)) {
      return '하루 한도는 0~20 사이여야 합니다.';
    }
    if (fields.allowedModels !== undefined && !(Array.isArray(fields.allowedModels) && fields.allowedModels.length
      && fields.allowedModels.every((m) => KNOWN_MODELS.includes(m)))) return '알 수 없는 모델입니다.';
    if (fields.active !== undefined && typeof fields.active !== 'boolean') return 'active는 true/false여야 합니다.';
    return '';
  }

  function admin(call) {
    const auth = call.headers.authorization || '';
    if (auth !== `Bearer ${ADMIN_TOKEN}`) return anthropicError(401, 'authentication_error', '관리자 토큰이 올바르지 않습니다.');
    const { method, path } = call;
    if (method === 'GET' && path === '/relay/admin/codes') {
      const codes = [...db.values()].map(toApi);
      return {
        json: {
          codes,
          todayTotalUsd: codes.reduce((s, c) => s + c.todayUsd, 0),
          monthTotalUsd: codes.reduce((s, c) => s + c.monthUsd, 0),
          globalDailyLimitUsd: 5,
        },
      };
    }
    if (method === 'POST' && path === '/relay/admin/codes') {
      const body = call.body || {};
      const problem = validate(body, false);
      if (problem) return anthropicError(400, 'invalid_request_error', problem);
      let code;
      if (body.code !== undefined && body.code !== null && String(body.code).trim()) {
        const chosen = validateCustomCode(body.code);
        if (chosen.error) return anthropicError(400, 'invalid_request_error', chosen.error);
        if (findByKey(keyOf(chosen.code))) return anthropicError(409, 'invalid_request_error', TAKEN_MESSAGE);
        code = chosen.code;
      } else {
        const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
        const n = nextCode++;
        code = `PR-NEW${alphabet[n % 32]}-${'K9X7'}`;
      }
      const r = {
        code, name: body.name.trim(), active: true, allowedModels: body.allowedModels || [...HAIKU],
        dailyLimitUsd: body.dailyLimitUsd ?? 0.5, todayUsd: 0, todayRequests: 0, monthUsd: 0, totalUsd: 0, totalRequests: 0,
        createdAt: Date.now(), lastUsedAt: null, upstream: 'ok',
      };
      db.set(code, r);
      return { json: toApi(r) };
    }
    const m = /^\/relay\/admin\/codes\/([^/]+)$/.exec(path);
    if (method === 'PATCH' && m) {
      const parsed = codeKey(decodeURIComponent(m[1]));
      const r = parsed ? findByKey(parsed.key) : null;
      if (!r) return anthropicError(404, 'not_found_error', '그런 초대 코드가 없습니다.');
      const body = call.body || {};
      const problem = validate(body, true);
      if (problem) return anthropicError(400, 'invalid_request_error', problem);
      for (const k of ['name', 'active', 'allowedModels', 'dailyLimitUsd']) if (body[k] !== undefined) r[k] = k === 'name' ? body[k].trim() : body[k];
      return { json: toApi(r) };
    }
    if (method === 'GET' && path === '/relay/admin/usage') {
      const days = Number(new URLSearchParams(call.search).get('days') || 30);
      const today = new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 10);
      const yesterday = new Date(Date.now() + 9 * 3_600_000 - DAY).toISOString().slice(0, 10);
      return {
        json: {
          days: [
            { day: yesterday, usd: 1.25, requests: 210, byModel: { 'claude-haiku-5-5': { usd: 0.45, requests: 200 }, 'claude-sonnet-5-5': { usd: 0.8, requests: 10 } } },
            { day: today, usd: 0.65, requests: 53, byModel: { 'claude-haiku-5-5': { usd: 0.65, requests: 53 } } },
          ].slice(0, days),
        },
      };
    }
    return anthropicError(404, 'not_found_error', '요청한 주소를 찾을 수 없습니다.');
  }

  function answer(body) {
    const user = body.messages?.[0]?.content;
    if (body.output_config?.format) {
      const { items } = parseTranslationUserMessage(typeof user === 'string' ? user : '');
      return JSON.stringify({ translations: items.map((it) => ({ id: it.sid, ko: `번역: ${it.text}` })) });
    }
    return '요약입니다. 이 논문은 중환자실 간호를 다룹니다.';
  }

  function messages(rec, call) {
    const b = call.body;
    if (!b || typeof b.model !== 'string' || !b.max_tokens || !Array.isArray(b.messages)) {
      return anthropicError(400, 'invalid_request_error', '요청 형식이 올바르지 않습니다(model, max_tokens, messages 필요).');
    }
    if (!rec.allowedModels.includes(b.model)) {
      return anthropicError(403, 'permission_error', `이 초대 코드로는 ${b.model}을 쓸 수 없습니다.`, { 'x-should-retry': 'false' });
    }
    if (b.max_tokens > 32000) return anthropicError(400, 'invalid_request_error', 'max_tokens는 32000 이하여야 합니다.');
    if (rec.todayUsd >= rec.dailyLimitUsd) {
      return anthropicError(429, 'rate_limit_error',
        `오늘 사용 한도(${usd(rec.dailyLimitUsd)})를 모두 썼습니다. 내일 오전 0시(한국 시간)에 다시 열립니다.`, { 'x-should-retry': 'false' });
    }
    // Upstream (Anthropic) answers pass through unchanged: English messages.
    if (rec.upstream === 'auth') return anthropicError(401, 'authentication_error', 'invalid x-api-key');
    if (rec.upstream === 'credit') {
      return anthropicError(400, 'invalid_request_error', 'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.');
    }
    rec.todayUsd += 0.001;
    rec.todayRequests += 1;
    rec.totalRequests += 1;
    rec.lastUsedAt = Date.now();
    const text = answer(b);
    const usage = { input_tokens: 1200, output_tokens: 80, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    if (b.stream) {
      const ev = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
      const half = Math.ceil(text.length / 2);
      return {
        contentType: 'text/event-stream',
        body: [
          ev('message_start', { type: 'message_start', message: { id: 'msg_relay', type: 'message', role: 'assistant', model: b.model, content: [], stop_reason: null, stop_sequence: null, usage: { ...usage, output_tokens: 1 } } }),
          ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
          ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text.slice(0, half) } }),
          ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text.slice(half) } }),
          ev('content_block_stop', { type: 'content_block_stop', index: 0 }),
          ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 80 } }),
          ev('message_stop', { type: 'message_stop' }),
        ].join(''),
      };
    }
    return {
      json: {
        id: 'msg_relay', type: 'message', role: 'assistant', model: b.model, content: [{ type: 'text', text }],
        stop_reason: 'end_turn', stop_sequence: null, usage,
      },
    };
  }

  function respond(call) {
    if (call.path.startsWith('/relay/admin/')) return admin(call);
    const bearer = /^Bearer (.+)$/.exec(call.headers.authorization || '')?.[1];
    const presented = call.headers['x-api-key'] || bearer || '';
    if (!presented) return anthropicError(401, 'authentication_error', '초대 코드가 없습니다. 설정에서 초대 코드를 입력해 주세요.');
    const parsed = codeKey(presented);
    const rec = parsed ? findByKey(parsed.key) : null;
    // The failed-attempt limiter: while it holds, only an existing, active GENERATED code still works.
    const now = Date.now();
    const recent = failures.filter((f) => now - f.at < FAIL_WINDOW_MS);
    if (recent.length >= CODE_FAIL_LIMIT && !(parsed?.generated && rec?.active)) {
      return anthropicError(429, 'rate_limit_error', TOO_MANY_MESSAGE, { 'x-should-retry': 'false', 'retry-after': '600' });
    }
    if (!rec) {
      const guess = parsed ? parsed.key : presented.trim();
      if (failures.at(-1)?.guess !== guess) failures.push({ at: now, guess }); // the same wrong value again is not counted
    }
    if (!rec || !rec.active) return anthropicError(401, 'authentication_error', '초대 코드가 올바르지 않거나 사용이 중지되었습니다.');
    if (call.method === 'GET' && call.path === '/relay/me') {
      return {
        json: {
          name: rec.name, allowedModels: [...rec.allowedModels], dailyLimitUsd: rec.dailyLimitUsd,
          todayUsd: Math.round(rec.todayUsd * 1e6) / 1e6, todayRequests: rec.todayRequests, resetsAt: nextKstMidnight(),
        },
      };
    }
    if (call.method === 'GET' && call.path === '/v1/models') {
      const data = rec.allowedModels.map((id) => ({ type: 'model', id, display_name: id, created_at: '2026-09-01T00:00:00Z' }));
      return { json: { data, has_more: false, first_id: data[0]?.id ?? null, last_id: data.at(-1)?.id ?? null } };
    }
    if (call.method === 'POST' && call.path === '/v1/messages') return messages(rec, call);
    return anthropicError(404, 'not_found_error', '요청한 주소를 찾을 수 없습니다.');
  }

  /** Playwright route handler for `${RELAY_URL}/**`. */
  async function handle(route) {
    const req = route.request();
    const url = new URL(req.url());
    const headers = req.headers();
    const origin = headers.origin || '';
    const cors = ALLOWED_ORIGINS.some((re) => re.test(origin))
      ? { 'access-control-allow-origin': origin, vary: 'Origin', 'access-control-expose-headers': EXPOSE }
      : {};
    if (req.method() === 'OPTIONS') {
      const allow = cors['access-control-allow-origin'] ? {
        'access-control-allow-methods': 'GET, POST, PATCH, OPTIONS',
        'access-control-allow-headers': headers['access-control-request-headers'] || '',
        'access-control-max-age': '86400',
      } : {};
      await route.fulfill({ status: 204, headers: { ...cors, ...allow } });
      return;
    }
    let body = null;
    try { body = req.postData() ? JSON.parse(req.postData()) : null; } catch { body = req.postData(); }
    const call = { method: req.method(), path: url.pathname, search: url.search, headers, body };
    calls.push(call);
    const res = respond(call);
    await route.fulfill({
      status: res.status || 200,
      headers: { ...cors, 'request-id': `req_relay_${++seq}`, ...(res.headers || {}) },
      contentType: res.contentType || 'application/json',
      body: res.json !== undefined ? JSON.stringify(res.json) : res.body ?? '',
    }).catch(() => {}); // the page may have aborted the request meanwhile
  }

  return { db, calls, failures, handle };
}
