// Invite-code relay ("초대 코드 서버") for the paper reader: colleagues call Claude with an invite code instead of
// their own API key. The Worker checks the code, enforces per-code and global daily budgets (Asia/Seoul day),
// forwards to Anthropic with the owner's key, streams the reply through unchanged and records usage in D1.
// Contract: docs/RELAY.md §1.
import { generateCode, normalizeCode, validateCodeInput } from './codes.js';
import { KNOWN_MODELS, MAX_ADMIN_BODY_BYTES, MAX_BODY_BYTES, MIN_ADMIN_TOKEN_LENGTH, MODEL_NAMES, readConfig } from './config.js';
import { codesWithUsage, codeWithBudget, insertCode, parseModels, recordUsage, updateCode, usageByDay } from './db.js';
import { apiError, isOriginAllowed, json, parseJson, preflight, readBody, withCors } from './http.js';
import { meterBody } from './meter.js';
import { costUsd } from './pricing.js';
import { kstDay, kstDaysBack, kstMonth, nextKstMidnight, requestNow } from './time.js';

/** Upstream response headers the client may need (content type, ids, retry hints). */
const PASS_HEADERS = ['content-type', 'cache-control', 'request-id', 'retry-after', 'retry-after-ms', 'x-should-retry'];
const DEFAULT_ANTHROPIC_VERSION = '2023-06-01';
// The relay does not know model release dates; /v1/models needs some RFC 3339 value (the app does not use it).
const MODEL_LISTED_AT = '2026-01-01T00:00:00Z';

const MSG = {
  noCode: '초대 코드가 없습니다. 설정에서 초대 코드를 입력해 주세요.',
  badCode: '초대 코드가 올바르지 않거나 사용이 중지되었습니다.',
  badAdmin: '관리자 토큰이 올바르지 않습니다.',
  noAdmin: `중계 서버에 관리자 토큰(ADMIN_TOKEN)이 없거나 너무 짧습니다(${MIN_ADMIN_TOKEN_LENGTH}자 이상).`,
  noKey: '중계 서버에 Anthropic API 키가 설정되지 않았습니다. 관리자에게 알려 주세요.',
  badOrigin: '이 웹사이트(Origin)에서는 중계 서버를 쓸 수 없습니다.',
  badJson: '요청 본문이 올바른 JSON이 아닙니다.',
  badShape: '요청 형식이 올바르지 않습니다. model, max_tokens(1 이상의 정수), messages(배열)가 필요합니다.',
  tooLarge: `요청이 너무 큽니다(최대 ${MAX_BODY_BYTES / 1024 / 1024}MB). 더 짧은 내용으로 다시 시도해 주세요.`,
  upstreamDown: 'Anthropic 서버에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.',
  internal: '중계 서버 내부 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.',
};

export default {
  /**
   * @param {Request} request
   * @param {Record<string, any>} env
   * @param {{ waitUntil(p: Promise<any>): void }} ctx
   */
  async fetch(request, env, ctx) {
    const config = readConfig(env);
    const origin = request.headers.get('origin');
    const allowedOrigin = origin && isOriginAllowed(origin, config.allowedOrigins) ? origin : null;
    if (origin && !allowedOrigin) return withCors(apiError(403, 'permission_error', MSG.badOrigin), null);
    if (request.method === 'OPTIONS') {
      return allowedOrigin
        ? preflight(request, allowedOrigin)
        : withCors(new Response(null, { status: 204, headers: { allow: 'GET, POST, PATCH, OPTIONS' } }), null);
    }
    let response;
    try {
      response = await route(request, { env, ctx, config, now: requestNow(request, config.testMode) });
    } catch (err) {
      console.error('[relay] unhandled error', err);
      response = apiError(500, 'api_error', MSG.internal);
    }
    return withCors(response, allowedOrigin);
  },
};

/**
 * @typedef {{ env: Record<string, any>, ctx: { waitUntil(p: Promise<any>): void },
 *             config: import('./config.js').RelayConfig, now: number }} Deps
 */

/** @param {Request} request @param {Deps} deps */
async function route(request, deps) {
  const url = new URL(request.url);
  const { pathname } = url;
  const method = request.method;
  if (pathname === '/' && method === 'GET') return json({ service: 'paper-relay', ok: true });
  if (pathname === '/v1/messages') return method === 'POST' ? handleMessages(request, url, deps) : notAllowed(method);
  if (pathname === '/v1/models') return method === 'GET' ? handleModels(request, url, deps) : notAllowed(method);
  if (pathname === '/relay/me') return method === 'GET' ? handleMe(request, deps) : notAllowed(method);
  if (pathname === '/relay/admin' || pathname.startsWith('/relay/admin/')) return handleAdmin(request, url, deps);
  return apiError(404, 'not_found_error', `요청한 주소를 찾을 수 없습니다: ${method} ${pathname}`);
}

function notAllowed(method) {
  return apiError(405, 'invalid_request_error', `이 주소에서는 ${method} 요청을 쓸 수 없습니다.`);
}

// ───────────────────────────── invite-code endpoints ─────────────────────────────

/**
 * Resolve the invite code (x-api-key, or Authorization: Bearer) with today's budgets.
 * @returns {Promise<{ code: string, row: import('./db.js').CodeBudgetRow, models: string[], day: string }
 *                   | { error: Response }>}
 */
async function authenticate(request, { env, now }) {
  const raw = request.headers.get('x-api-key') || bearer(request);
  if (!raw) return { error: apiError(401, 'authentication_error', MSG.noCode) };
  const code = normalizeCode(raw);
  const day = kstDay(now);
  const row = code ? await codeWithBudget(env.DB, code, day) : null;
  if (!row || !row.active) return { error: apiError(401, 'authentication_error', MSG.badCode) };
  return { code, row, day, models: allowedModels(row) };
}

/** POST /v1/messages (also ?beta=true): check, forward, stream back, record usage. */
async function handleMessages(request, url, deps) {
  const { env, ctx, config, now } = deps;
  const auth = await authenticate(request, deps);
  if (auth.error) return auth.error;
  const { code, row, day } = auth;

  const read = await readBody(request, MAX_BODY_BYTES);
  if (read.tooLarge) return apiError(413, 'request_too_large', MSG.tooLarge);
  const params = parseJson(read.bytes);
  if (params === undefined) return apiError(400, 'invalid_request_error', MSG.badJson);
  if (!params || typeof params !== 'object' || typeof params.model !== 'string' || !params.model
    || !Number.isInteger(params.max_tokens) || params.max_tokens < 1 || !Array.isArray(params.messages)) {
    return apiError(400, 'invalid_request_error', MSG.badShape);
  }
  const { model } = params;
  if (!auth.models.includes(model)) {
    return apiError(403, 'permission_error', `이 초대 코드로는 ${model}을 쓸 수 없습니다.`);
  }
  const feature = forbiddenFeature(params);
  if (feature) return apiError(403, 'permission_error', `이 초대 코드로는 다음 기능을 쓸 수 없습니다: ${feature}`);
  if (params.max_tokens > config.maxTokensCap) {
    return apiError(400, 'invalid_request_error',
      `max_tokens는 ${config.maxTokensCap} 이하로 요청해 주세요(요청값: ${params.max_tokens}).`);
  }
  const budgetHeaders = { 'x-relay-today-usd': usdText(row.today_usd), 'x-relay-limit-usd': usdText(row.daily_limit_usd) };
  if (row.today_usd >= row.daily_limit_usd) {
    return apiError(429, 'rate_limit_error',
      `오늘 사용 한도(${dollars(row.daily_limit_usd)})를 모두 썼습니다. 내일 오전 0시(한국 시간)에 다시 열립니다.`,
      budgetHeaders);
  }
  if (row.global_today_usd >= config.globalDailyLimitUsd) {
    return apiError(429, 'rate_limit_error',
      `중계 서버의 오늘 전체 사용 한도(${dollars(config.globalDailyLimitUsd)})를 모두 썼습니다. `
      + '내일 오전 0시(한국 시간)에 다시 열립니다.', budgetHeaders);
  }
  if (!config.apiKey) return apiError(500, 'api_error', MSG.noKey, { 'x-should-retry': 'false' });

  const entry = { code, day, now };
  let upstream;
  try {
    upstream = await fetch(`${config.upstreamUrl}/v1/messages${url.search}`, {
      method: 'POST',
      headers: upstreamHeaders(request, config.apiKey),
      body: read.bytes,
    });
  } catch (err) {
    console.error('[relay] upstream fetch failed', err);
    recordLater(deps, entry, null, model);
    return apiError(502, 'api_error', MSG.upstreamDown);
  }

  const headers = new Headers(budgetHeaders);
  for (const name of PASS_HEADERS) {
    const value = upstream.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  if (!upstream.ok || !upstream.body) {
    // A failed call counts as a request but bills no tokens.
    recordLater(deps, entry, null, model);
    return new Response(upstream.body, { status: upstream.status, headers });
  }
  const metered = meterBody(upstream.body, upstream.headers.get('content-type'), model);
  recordLater(deps, entry, metered.finished, model);
  return new Response(metered.body, { status: upstream.status, headers });
}

/**
 * Request features that are billed beyond tokens (so the budget could not see them) or that would pick models
 * outside the code's allowlist. The paper reader uses none of them except `fallbacks: 'default'`.
 */
function forbiddenFeature(params) {
  if (params.fallbacks !== undefined && params.fallbacks !== 'default') return 'fallbacks 모델 직접 지정';
  if (params.speed !== undefined && params.speed !== 'standard') return '빠른 모드(speed)';
  if (Array.isArray(params.tools) && params.tools.some((t) => t?.type !== undefined && t.type !== 'custom')) {
    return '서버 도구(tools)';
  }
  if (params.mcp_servers !== undefined) return 'MCP 서버(mcp_servers)';
  if (params.container !== undefined) return '코드 실행 컨테이너(container)';
  return null;
}

/** Headers for Anthropic: the owner's key replaces the invite code; nothing else from the browser is forwarded. */
function upstreamHeaders(request, apiKey) {
  const headers = new Headers({
    'content-type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': request.headers.get('anthropic-version') || DEFAULT_ANTHROPIC_VERSION,
  });
  const beta = request.headers.get('anthropic-beta');
  if (beta) headers.set('anthropic-beta', beta);
  return headers;
}

/**
 * Record one forwarded request once its reply has finished (ctx.waitUntil). `finished` resolves to the metered
 * usage, or null/undefined for a failed call (one request, no tokens, booked on the requested model).
 */
function recordLater({ env, ctx }, entry, finished, requestedModel) {
  const task = Promise.resolve(finished).then((result) => {
    const parts = result?.parts?.length
      ? result.parts.map((p) => ({ ...p, usd: costUsd(p) }))
      : [{ model: requestedModel, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, usd: 0 }];
    return recordUsage(env.DB, { ...entry, parts });
  }).catch((err) => console.error('[relay] usage not recorded', err));
  ctx.waitUntil(task);
}

/** GET /v1/models: the code's allowed models, in the Models API page shape (limit / after_id / before_id). */
async function handleModels(request, url, deps) {
  const auth = await authenticate(request, deps);
  if (auth.error) return auth.error;
  const all = auth.models.map((id) => ({ type: 'model', id, display_name: MODEL_NAMES[id] || id, created_at: MODEL_LISTED_AT }));
  const afterId = url.searchParams.get('after_id');
  const beforeId = url.searchParams.get('before_id');
  const limit = clampInt(url.searchParams.get('limit'), 20, 1, 1000);
  let rest = all;
  if (afterId) rest = all.slice(all.findIndex((m) => m.id === afterId) + 1 || all.length);
  else if (beforeId) rest = all.slice(0, Math.max(0, all.findIndex((m) => m.id === beforeId)));
  const page = beforeId ? rest.slice(-limit) : rest.slice(0, limit);
  return json({
    data: page,
    has_more: page.length < rest.length,
    first_id: page[0]?.id ?? null,
    last_id: page.at(-1)?.id ?? null,
  }, 200, budgetHeadersFor(auth.row));
}

/** GET /relay/me: who the code belongs to and today's spend. */
async function handleMe(request, deps) {
  const auth = await authenticate(request, deps);
  if (auth.error) return auth.error;
  const { row } = auth;
  return json({
    name: row.name,
    allowedModels: auth.models,
    dailyLimitUsd: row.daily_limit_usd,
    todayUsd: roundUsd(row.today_usd),
    todayRequests: row.today_requests,
    resetsAt: new Date(nextKstMidnight(deps.now)).toISOString(),
  }, 200, budgetHeadersFor(row));
}

// ───────────────────────────── admin endpoints ─────────────────────────────

/** /relay/admin/*: owner-only code management (Authorization: Bearer <ADMIN_TOKEN>). */
async function handleAdmin(request, url, deps) {
  const { config } = deps;
  if (config.adminToken.length < MIN_ADMIN_TOKEN_LENGTH) return apiError(401, 'authentication_error', MSG.noAdmin);
  if (!(await sameSecret(bearer(request), config.adminToken))) return apiError(401, 'authentication_error', MSG.badAdmin);
  const path = url.pathname.slice('/relay/admin'.length);
  const method = request.method;
  if (path === '/codes') {
    if (method === 'GET') return listCodes(deps);
    if (method === 'POST') return createCode(request, deps);
    return notAllowed(method);
  }
  const one = /^\/codes\/([^/]+)$/.exec(path);
  if (one) return method === 'PATCH' ? patchCode(request, safeDecode(one[1]), deps) : notAllowed(method);
  if (path === '/usage') return method === 'GET' ? usageReport(url, deps) : notAllowed(method);
  return apiError(404, 'not_found_error', `요청한 관리자 주소를 찾을 수 없습니다: ${method} ${url.pathname}`);
}

async function listCodes({ env, config, now }) {
  const rows = await codesWithUsage(env.DB, { day: kstDay(now), month: kstMonth(now) });
  const codes = rows.map(codeRecord);
  return json({
    codes,
    todayTotalUsd: roundUsd(rows.reduce((s, r) => s + r.today_usd, 0)),
    monthTotalUsd: roundUsd(rows.reduce((s, r) => s + r.month_usd, 0)),
    globalDailyLimitUsd: config.globalDailyLimitUsd,
  });
}

async function createCode(request, { env, config, now }) {
  const body = await readAdminJson(request);
  if (body.error) return body.error;
  const checked = validateCodeInput(body.value, {
    partial: false,
    defaults: { allowedModels: config.defaultModels, dailyLimitUsd: config.defaultDailyLimitUsd },
  });
  if (checked.error) return apiError(400, 'invalid_request_error', checked.error);
  const { name, allowedModels, dailyLimitUsd, active = true } = checked.value;
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateCode();
    if (await insertCode(env.DB, { code, name, active, allowedModels, dailyLimitUsd, createdAt: now })) {
      return json(await codeReport(env.DB, code, now), 201);
    }
  }
  return apiError(500, 'api_error', '새 초대 코드를 만들지 못했습니다. 다시 시도해 주세요.');
}

async function patchCode(request, rawCode, { env, now }) {
  const code = normalizeCode(rawCode);
  if (!code) return apiError(404, 'not_found_error', `초대 코드를 찾을 수 없습니다: ${rawCode}`);
  const body = await readAdminJson(request);
  if (body.error) return body.error;
  const checked = validateCodeInput(body.value, { partial: true });
  if (checked.error) return apiError(400, 'invalid_request_error', checked.error);
  if (!(await updateCode(env.DB, code, checked.value))) {
    return apiError(404, 'not_found_error', `초대 코드를 찾을 수 없습니다: ${code}`);
  }
  return json(await codeReport(env.DB, code, now));
}

/** GET /relay/admin/usage?days=30[&code=PR-…]: every KST day in the window (newest first), zeros included. */
async function usageReport(url, { env, now }) {
  const count = clampInt(url.searchParams.get('days'), 30, 1, 366);
  const rawCode = url.searchParams.get('code');
  const code = rawCode ? normalizeCode(rawCode) : null;
  if (rawCode && !code) return apiError(400, 'invalid_request_error', `초대 코드 형식이 아닙니다: ${rawCode}`);
  const dayList = kstDaysBack(now, count);
  const rows = await usageByDay(env.DB, { fromDay: dayList.at(-1), toDay: dayList[0], code });
  const byDay = new Map(dayList.map((day) => [day, { day, usd: 0, requests: 0, byModel: {} }]));
  for (const r of rows) {
    const d = byDay.get(r.day);
    if (!d) continue;
    d.usd += r.usd;
    d.requests += r.requests;
    d.byModel[r.model] = {
      usd: roundUsd(r.usd),
      requests: r.requests,
      inputTokens: r.input_tokens,
      outputTokens: r.output_tokens,
      cacheReadTokens: r.cache_read_tokens,
      cacheWriteTokens: r.cache_write_tokens,
    };
  }
  const days = [...byDay.values()].map((d) => ({ ...d, usd: roundUsd(d.usd) }));
  return json({ days });
}

async function codeReport(db, code, now) {
  const [row] = await codesWithUsage(db, { day: kstDay(now), month: kstMonth(now), code });
  return codeRecord(row);
}

/** @param {import('./db.js').CodeUsageRow} row */
function codeRecord(row) {
  return {
    code: row.code,
    name: row.name,
    active: Boolean(row.active),
    allowedModels: allowedModels(row),
    dailyLimitUsd: row.daily_limit_usd,
    createdAt: new Date(row.created_at).toISOString(),
    lastUsedAt: row.last_used_at == null ? null : new Date(row.last_used_at).toISOString(),
    todayUsd: roundUsd(row.today_usd),
    monthUsd: roundUsd(row.month_usd),
    totalUsd: roundUsd(row.total_usd),
    totalRequests: row.total_requests,
  };
}

/** @returns {Promise<{ value: any } | { error: Response }>} */
async function readAdminJson(request) {
  const read = await readBody(request, MAX_ADMIN_BODY_BYTES);
  if (read.tooLarge) return { error: apiError(413, 'request_too_large', '요청이 너무 큽니다.') };
  const value = parseJson(read.bytes);
  if (value === undefined) return { error: apiError(400, 'invalid_request_error', MSG.badJson) };
  return { value };
}

// ───────────────────────────── helpers ─────────────────────────────

/** decodeURIComponent that keeps malformed input (e.g. a lone "%") instead of throwing. */
function safeDecode(text) {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

function bearer(request) {
  const m = /^Bearer\s+(.+)$/i.exec(request.headers.get('authorization') || '');
  return m ? m[1].trim() : '';
}

/** Constant-time comparison: both sides are hashed first, so neither length nor content leaks through timing. */
async function sameSecret(given, expected) {
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

/** The code's models, limited to KNOWN_MODELS (a hand-edited row cannot unlock anything else). */
function allowedModels(row) {
  const models = parseModels(row.allowed_models);
  return KNOWN_MODELS.filter((m) => models.includes(m));
}

function budgetHeadersFor(row) {
  return { 'x-relay-today-usd': usdText(row.today_usd), 'x-relay-limit-usd': usdText(row.daily_limit_usd) };
}

function roundUsd(v) {
  return Math.round((Number(v) || 0) * 1e6) / 1e6;
}

function usdText(v) {
  return String(roundUsd(v));
}

function dollars(v) {
  return `$${Number(v).toFixed(2)}`;
}

function clampInt(raw, fallback, min, max) {
  const n = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}
