// Invite-code relay ("초대 코드 서버") for the paper reader: colleagues call Claude with an invite code instead of
// their own API key. The Worker checks the code, enforces per-code and global daily budgets (Asia/Seoul day),
// forwards to Anthropic with the owner's key, streams the reply through unchanged and records usage in D1.
// The same codes open the shared team library (공용 서재) through a GitHub-compatible proxy (src/shared.js).
// Contracts: docs/RELAY.md §1, docs/SHARED.md §2.
import { checkAdminToken, checkInviteCode } from './auth.js';
import { codeKey, generateCode, newPersonSalt, validateCodeInput } from './codes.js';
import {
  hostLibrary, KNOWN_MODELS, MAX_ADMIN_BODY_BYTES, MAX_BODY_BYTES, MAX_CODE_LIBRARY_MAX_BYTES, MIN_ADMIN_TOKEN_LENGTH,
  MIN_CODE_LIBRARY_MAX_BYTES, MODEL_NAMES, readConfig,
} from './config.js';
import {
  codesWithUsage, deleteCodeRecord, deletedCodesUsage, ensureLibraryId, findCodeByKey, insertCode, newLibraryId,
  parseModels, recordUsage, setLibraryMaxBytes, updateCode, usageByDay,
} from './db.js';
import { UpstreamError } from './github.js';
import {
  ALLOW_METHODS, apiError, bearer, isOriginAllowed, json, parseJson, preflight, readBody, SHARED_ALLOW_METHODS, withCors,
} from './http.js';
import { tooManyAttempts } from './limiter.js';
import { meterBody } from './meter.js';
import { costUsd } from './pricing.js';
import { codeLibraryReport, handleShared, handleSharedAdmin, libraryMaxBytes, removeCodeData } from './shared.js';
import { LIBRARY_ID_RE, personIdForRow, personIdsOfDeletedCode } from './shared-paths.js';
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
  takenCode: '이미 있는 코드입니다(대소문자와 하이픈은 구분하지 않습니다). 다른 코드를 정해 주세요.',
  noAdmin: `중계 서버에 관리자 토큰(ADMIN_TOKEN)이 없거나 너무 짧습니다(${MIN_ADMIN_TOKEN_LENGTH}자 이상).`,
  noKey: '중계 서버에 Anthropic API 키가 설정되지 않았습니다. 관리자에게 알려 주세요.',
  badOrigin: '이 웹사이트(Origin)에서는 중계 서버를 쓸 수 없습니다.',
  badJson: '요청 본문이 올바른 JSON이 아닙니다.',
  notUtf8: '요청 본문이 UTF-8이 아니어서 이름의 한글이 깨집니다. UTF-8로 다시 보내 주세요(앱의 초대 코드 관리 화면을 쓰거나, curl은 UTF-8로 저장한 파일을 --data-binary @파일.json으로 보내세요).',
  badShape: '요청 형식이 올바르지 않습니다. model, max_tokens(1 이상의 정수), messages(배열)가 필요합니다.',
  tooLarge: `요청이 너무 큽니다(최대 ${MAX_BODY_BYTES / 1024 / 1024}MB). 더 짧은 내용으로 다시 시도해 주세요.`,
  upstreamDown: 'Anthropic 서버에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.',
  // Code deletion could not remove the person's files from 공용 서재: the code is kept (as it was), so nothing is
  // left orphaned; the admin deletes again later.
  deleteFailed: '공용 서재(GitHub)에 연결하지 못해 이 코드의 개인 기록을 지우지 못했습니다. 코드는 그대로 두었으니 잠시 후 다시 삭제해 주세요.',
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
      const methods = isSharedPath(new URL(request.url).pathname) ? SHARED_ALLOW_METHODS : ALLOW_METHODS;
      return allowedOrigin
        ? preflight(request, allowedOrigin, methods)
        : withCors(new Response(null, { status: 204, headers: { allow: methods } }), null);
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
  if (isSharedPath(pathname)) return handleShared(request, url, deps);
  return apiError(404, 'not_found_error', `요청한 주소를 찾을 수 없습니다: ${method} ${pathname}`);
}

const isSharedPath = (pathname) => pathname === '/shared' || pathname.startsWith('/shared/');

function notAllowed(method) {
  return apiError(405, 'invalid_request_error', `이 주소에서는 ${method} 요청을 쓸 수 없습니다.`);
}

// ───────────────────────────── invite-code endpoints ─────────────────────────────

/**
 * Resolve the invite code (x-api-key, or Authorization: Bearer) with today's budgets, behind the failed-attempt
 * limiter (auth.js). `code` is the code as stored ("PR-XXXX-XXXX" or a custom "EICU-2026"), whatever was typed.
 * @returns {Promise<{ code: string, row: import('./db.js').CodeBudgetRow, models: string[], day: string }
 *                   | { error: Response }>}
 */
async function authenticate(request, { env, now }) {
  const raw = request.headers.get('x-api-key') || bearer(request);
  const day = kstDay(now);
  const check = await checkInviteCode(request, { db: env.DB, raw, now, day });
  if (check.missing) return { error: apiError(401, 'authentication_error', MSG.noCode) };
  if (check.limited) return { error: tooManyAttempts(check.retryAfter) };
  if (!check.row) return { error: apiError(401, 'authentication_error', MSG.badCode) };
  const { row } = check;
  return { code: row.code, row, day, models: allowedModels(row) };
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
  const admin = await checkAdminToken(request, { db: deps.env.DB, given: bearer(request), expected: config.adminToken, now: deps.now });
  if (admin.limited) return tooManyAttempts(admin.retryAfter);
  if (!admin.ok) return apiError(401, 'authentication_error', MSG.badAdmin);
  const path = url.pathname.slice('/relay/admin'.length);
  const method = request.method;
  if (path === '/codes') {
    if (method === 'GET') return listCodes(deps);
    if (method === 'POST') return createCode(request, deps);
    return notAllowed(method);
  }
  const one = /^\/codes\/([^/]+)$/.exec(path);
  if (one) {
    if (method === 'PATCH') return patchCode(request, safeDecode(one[1]), deps);
    if (method === 'DELETE') return deleteCode(safeDecode(one[1]), url, deps);
    return notAllowed(method);
  }
  const own = /^\/codes\/([^/]+)\/library$/.exec(path);
  if (own) {
    if (method === 'GET') return codeLibrary(safeDecode(own[1]), deps);
    if (method === 'PATCH') return patchCodeLibrary(request, safeDecode(own[1]), deps);
    return notAllowed(method);
  }
  if (path === '/usage') return method === 'GET' ? usageReport(url, deps) : notAllowed(method);
  const shared = path.startsWith('/shared/') ? await handleSharedAdmin(request, path, deps) : null;
  if (shared) return shared;
  return apiError(404, 'not_found_error', `요청한 관리자 주소를 찾을 수 없습니다: ${method} ${url.pathname}`);
}

/**
 * GET /relay/admin/codes. The totals include the usage of deleted codes (their history stays in the usage table and
 * the owner paid for it), which is also given on its own as `deletedUsage` for the list's "삭제된 코드" row.
 */
async function listCodes({ env, config, now }) {
  const day = kstDay(now);
  const month = kstMonth(now);
  const [rows, deleted] = await Promise.all([
    codesWithUsage(env.DB, { day, month }),
    deletedCodesUsage(env.DB, { day, month }),
  ]);
  const codes = rows.map(codeRecord);
  return json({
    codes,
    todayTotalUsd: roundUsd(rows.reduce((s, r) => s + r.today_usd, 0) + deleted.today_usd),
    monthTotalUsd: roundUsd(rows.reduce((s, r) => s + r.month_usd, 0) + deleted.month_usd),
    globalDailyLimitUsd: config.globalDailyLimitUsd,
    deletedUsage: {
      todayUsd: roundUsd(deleted.today_usd),
      monthUsd: roundUsd(deleted.month_usd),
      totalUsd: roundUsd(deleted.total_usd),
      totalRequests: deleted.total_requests,
    },
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
  const { name, allowedModels, dailyLimitUsd, active = true, code: chosen } = checked.value;
  // Every new code gets its own person salt (a custom code deleted and made again is a new person in 공용 서재) and
  // its own library id (its library is codes/<id>/ in the team repo, docs/CODE-LIBRARIES.md).
  const fields = {
    name, active, allowedModels, dailyLimitUsd, createdAt: now, personSalt: newPersonSalt(), libraryId: newLibraryId(),
  };
  if (chosen) {
    if (await insertCode(env.DB, { code: chosen, ...fields })) {
      return json(await codeReport(env.DB, chosen, now), 201);
    }
    return apiError(409, 'invalid_request_error', MSG.takenCode);
  }
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateCode();
    if (await insertCode(env.DB, { code, ...fields })) {
      return json(await codeReport(env.DB, code, now), 201);
    }
  }
  return apiError(500, 'api_error', '새 초대 코드를 만들지 못했습니다. 다시 시도해 주세요.');
}

async function patchCode(request, rawCode, { env, now }) {
  const parsed = codeKey(rawCode);
  const found = parsed ? await findCodeByKey(env.DB, parsed.key) : null;
  if (!found) return apiError(404, 'not_found_error', `초대 코드를 찾을 수 없습니다: ${parsed?.code ?? rawCode}`);
  const body = await readAdminJson(request);
  if (body.error) return body.error;
  const checked = validateCodeInput(body.value, { partial: true });
  if (checked.error) return apiError(400, 'invalid_request_error', checked.error);
  if (!(await updateCode(env.DB, found.code, checked.value))) {
    return apiError(404, 'not_found_error', `초대 코드를 찾을 수 없습니다: ${found.code}`);
  }
  return json(await codeReport(env.DB, found.code, now));
}

/**
 * DELETE /relay/admin/codes/<code> (any spelling, as PATCH): the code is gone for good.
 * 1. The code is switched off first, so its owner cannot store anything new while the files go (every proxy request
 *    checks the code; a push that raced past is caught by the ref update's fast-forward check).
 * 2. Everything under people/<personId>/ (the person's highlights, notes, AI results) is removed from every shared
 *    library — one "[관리자] 초대 코드 삭제에 따라 개인 기록 정리" commit per library that has any (shared.js).
 * 3. Only then the code row and its shared_trees rows are deleted; its usage rows stay as history (db.js).
 * If GitHub cannot be reached or refuses in step 2, nothing is deleted: the code gets its previous on/off state back
 * and the answer is 502 with a Korean message, so the admin can simply delete again (libraries already cleaned are
 * skipped). There is never a deleted code whose notes were silently left behind.
 * The code's own library (codes/<libraryId>/, docs/CODE-LIBRARIES.md) goes in step 2 too, in the same commit as its
 * team-library notes: `?library=delete` (the default) removes it, `?library=move&to=<other code>` moves its papers,
 * folders, translations and the holder's notes into that code's library (the notes become that code holder's).
 * → { deleted: true, purgedFiles } (+ `library: { action, papers, files, renamed? }` when its library had files)
 */
async function deleteCode(rawCode, url, deps) {
  const { env, now } = deps;
  const parsed = codeKey(rawCode);
  const found = parsed ? await findCodeByKey(env.DB, parsed.key) : null;
  if (!found) return apiError(404, 'not_found_error', `초대 코드를 찾을 수 없습니다: ${parsed?.code ?? rawCode}`);
  const action = url.searchParams.get('library') || 'delete';
  if (action !== 'delete' && action !== 'move') {
    return apiError(400, 'invalid_request_error', '서재 처리(library)는 delete 또는 move여야 합니다.');
  }
  const secret = env.PERSON_ID_SECRET || '';
  const personIds = await personIdsOfDeletedCode(found, secret);
  let library = null;
  if (action === 'move') {
    const rawTo = url.searchParams.get('to') || '';
    const toKey = rawTo ? codeKey(rawTo) : null;
    const target = toKey ? await findCodeByKey(env.DB, toKey.key) : null;
    if (!rawTo) return apiError(400, 'invalid_request_error', '서재를 옮길 코드(to)를 정해 주세요.');
    if (!target) return apiError(404, 'not_found_error', `서재를 옮길 코드를 찾을 수 없습니다: ${toKey?.code ?? rawTo}`);
    if (target.code === found.code) return apiError(400, 'invalid_request_error', '삭제할 코드와 같은 코드로는 옮길 수 없습니다.');
    if (LIBRARY_ID_RE.test(found.library_id || '') && hostLibrary(deps.config)) {
      library = {
        action, libraryId: found.library_id,
        to: { libraryId: await ensureLibraryId(env.DB, target), personId: await personIdForRow(target, secret) },
      };
    }
  } else if (LIBRARY_ID_RE.test(found.library_id || '')) {
    library = { action, libraryId: found.library_id };
  }
  const wasActive = Boolean(found.active);
  if (wasActive) await updateCode(env.DB, found.code, { active: false });
  let removed;
  try {
    removed = await removeCodeData(deps, { personIds, library });
  } catch (err) {
    if (wasActive) {
      await updateCode(env.DB, found.code, { active: true })
        .catch((e) => console.error('[relay] code not switched back on after a failed delete', e));
    }
    if (err instanceof UpstreamError) {
      console.error('[relay] code delete: shared files not removed', err.status, err.message);
      return apiError(502, 'api_error', MSG.deleteFailed);
    }
    throw err;
  }
  await deleteCodeRecord(env.DB, { code: found.code, personIds, now });
  return json({ deleted: true, purgedFiles: removed.files, ...(removed.library ? { library: removed.library } : {}) });
}

/** The code of an admin path segment (any spelling), or a 404 response. */
async function codeOrMissing(env, rawCode) {
  const parsed = codeKey(rawCode);
  const found = parsed ? await findCodeByKey(env.DB, parsed.key) : null;
  return found ? { found } : { error: apiError(404, 'not_found_error', `초대 코드를 찾을 수 없습니다: ${parsed?.code ?? rawCode}`) };
}

/**
 * GET /relay/admin/codes/<code>/library → the code's own library: { code, name, libraryId, papers, trashed, files,
 * bytes, maxBytes } (the delete dialog shows `papers`). libraryId null and zeros until the code first opens it.
 */
async function codeLibrary(rawCode, deps) {
  const { found, error } = await codeOrMissing(deps.env, rawCode);
  if (error) return error;
  if (!deps.config.teamToken) return apiError(503, 'api_error', '공용 서재가 아직 준비되지 않았습니다(서버에 TEAM_GITHUB_TOKEN이 없습니다).');
  try {
    return json(await codeLibraryReport(deps, found));
  } catch (err) {
    if (err instanceof UpstreamError) return apiError(err.status >= 500 ? err.status : 502, 'api_error', err.message);
    throw err;
  }
}

/**
 * PATCH /relay/admin/codes/<code>/library { maxBytes: number | null } → { code, name, libraryId, maxBytes }: the size
 * cap of the code's own library (null = the default CODE_LIBRARY_MAX_BYTES, 500 MB unless configured).
 */
async function patchCodeLibrary(request, rawCode, deps) {
  const { env, config } = deps;
  const { found, error } = await codeOrMissing(env, rawCode);
  if (error) return error;
  const body = await readAdminJson(request);
  if (body.error) return body.error;
  const value = body.value;
  const keys = value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value) : null;
  const max = value?.maxBytes;
  const valid = max === null || (Number.isInteger(max) && max >= MIN_CODE_LIBRARY_MAX_BYTES && max <= MAX_CODE_LIBRARY_MAX_BYTES);
  if (!keys || keys.length !== 1 || keys[0] !== 'maxBytes' || !valid) {
    return apiError(400, 'invalid_request_error', `서재 용량(maxBytes)은 ${MIN_CODE_LIBRARY_MAX_BYTES}~${MAX_CODE_LIBRARY_MAX_BYTES} 사이의 `
      + '정수(바이트)이거나, 기본값으로 되돌리려면 null이어야 합니다.');
  }
  if (!(await setLibraryMaxBytes(env.DB, found.code, max))) {
    return apiError(404, 'not_found_error', `초대 코드를 찾을 수 없습니다: ${found.code}`);
  }
  const row = { ...found, library_max_bytes: max };
  return json({
    code: found.code, name: found.name, libraryId: LIBRARY_ID_RE.test(found.library_id || '') ? found.library_id : null,
    maxBytes: libraryMaxBytes(row, config),
  });
}

/** GET /relay/admin/usage?days=30[&code=PR-… or a custom code]: every KST day in the window (newest first), zeros included. */
async function usageReport(url, { env, now }) {
  const count = clampInt(url.searchParams.get('days'), 30, 1, 366);
  const rawCode = url.searchParams.get('code');
  const parsed = rawCode ? codeKey(rawCode) : null;
  if (rawCode && !parsed) return apiError(400, 'invalid_request_error', `초대 코드 형식이 아닙니다: ${rawCode}`);
  // A code nobody has is reported with zero days, as before.
  const code = parsed ? (await findCodeByKey(env.DB, parsed.key))?.code ?? parsed.code ?? parsed.key : null;
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

/**
 * Admin bodies must be UTF-8: a name typed in a Korean Windows console is often sent as CP949, which a lenient
 * decoder turns into U+FFFD and the invitee then sees "������님". Such a body is refused with a Korean hint instead.
 * @returns {Promise<{ value: any } | { error: Response }>}
 */
async function readAdminJson(request) {
  const read = await readBody(request, MAX_ADMIN_BODY_BYTES);
  if (read.tooLarge) return { error: apiError(413, 'request_too_large', '요청이 너무 큽니다.') };
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(read.bytes);
  } catch {
    return { error: apiError(400, 'invalid_request_error', MSG.notUtf8) };
  }
  const value = parseJsonText(text);
  if (value === undefined) return { error: apiError(400, 'invalid_request_error', MSG.badJson) };
  return { value };
}

function parseJsonText(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
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
