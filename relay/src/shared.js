// Shared team library ("공용 서재", docs/SHARED.md §2): a GitHub-API-compatible proxy in front of a private team repo,
// so the app's GitHubClient + SyncEngine work unchanged with apiBase = <relay>/shared/<lib>/gh, owner 'team', repo
// 'library' and the invite code as its token. The Worker checks the code, allows only the routes and repo paths
// of the layout (everyone may change the shared files, nobody another person's people/<id>/ files), hides other
// people's files from tree listings, rewrites commit messages with the code's name and calls GitHub with its own
// token (TEAM_GITHUB_TOKEN). Also GET /shared, GET /shared/<lib>/activity, the admin stats / purge / split, and
// removing a deleted invite code's people/<id>/ files and its own library (removeCodeData, for
// DELETE /relay/admin/codes/<code> in index.js).
//
// Two kinds of library share one repo (docs/CODE-LIBRARIES.md): the team library ('전체 공용 서재', the repo root,
// /shared/team/gh) and one library per invite code (codes/<libraryId>/, /shared/mine/gh — only that code's holders).
// The client of a code library uses 'codes/<libraryId>/' as the prefix of every path; the proxy enforces it.
import { checkInviteCode } from './auth.js';
import { applySplit, planLibraryDelete, planLibraryMove, planSplit } from './code-libraries.js';
import { CODE_LIBRARY_URL_ID, hostLibrary } from './config.js';
import {
  allCodes, ensureLibraryId, hasSharedTree, insertSharedBlob, insertSharedTree, SHARED_TREE_KEEP_MS, uploadedBlobs,
} from './db.js';
import { encodeBranch, JSON_MEDIA, RAW_MEDIA, TeamRepo, UpstreamError } from './github.js';
import { apiError, bearer, json, parseJson, readBody } from './http.js';
import { TOO_MANY_MESSAGE, tooManyAttempts } from './limiter.js';
import {
  adminMessage, checkTreeEntries, classifyIn, clientSummary, CODE_DELETE_SUMMARY, codeRoot, commitLines,
  commitMessageFor, compareLibraries, confirmedPurgeIds, describeSharedChange, filterEntries, LIBRARY_ID_RE,
  LIBRARY_PATH, markerOf, messageFor, paperFiles, parseLibrary, PERSONAL_SUMMARY, personFiles, personIdForRow,
  personIdsOfDeletedCode, QUIET_LIBRARY_SUMMARY, QUIET_SUMMARIES, TEAM_MARKER, visibleIn,
} from './shared-paths.js';

/** "A tree the client got from this proxy in the last 10 min": heads (and trees made here) stay usable this long. */
export const RECENT_MS = 10 * 60 * 1000;
export const PURGE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;
export const MAX_BLOB_BODY_BYTES = 100 * 1024 * 1024;
/** Blobs this large count against the library's size cap even when they do not look like a PDF. */
export const LARGE_BLOB_BYTES = 8 * 1024 * 1024;
const MAX_TREE_BODY_BYTES = 4 * 1024 * 1024;
const MAX_SMALL_BODY_BYTES = 64 * 1024;
const MAX_README_BYTES = 64 * 1024;
const SNIFF_BYTES = 1024;
const MAX_PURGE_ATTEMPTS = 3;
/** A library.json this size or larger is treated as corrupt rather than parsed (it must stay a small index). */
const MAX_LIBRARY_JSON_BYTES = 32 * 1024 * 1024;
const SHA_RE = /^[0-9a-f]{40}$/;
const ETAG_RE = /^(?:W\/)?"[\x21\x23-\x7e]{1,200}"$/;
const DOCS_URL = 'https://docs.github.com/rest';
const PROXY_OWNER = 'team';
const PROXY_REPO = 'library';

const MSG = {
  noCode: '초대 코드가 없습니다. 설정에서 초대 코드를 입력해 주세요.',
  badCode: '초대 코드가 올바르지 않거나 사용이 중지되었습니다.',
  notFound: '공용 서재에서 찾을 수 없는 주소입니다.',
  noToken: '공용 서재가 아직 준비되지 않았습니다(서버에 TEAM_GITHUB_TOKEN이 없습니다). 관리자에게 알려 주세요.',
  notPrivate: '공용 서재 저장소가 비공개(Private)가 아니어서 사용을 멈췄습니다. 관리자에게 알려 주세요.',
  badJson: '요청 본문이 올바른 JSON 객체가 아닙니다.',
  tooLargeBody: '요청이 너무 큽니다.',
  blobTooLarge: `파일이 너무 커서 공용 서재에 올릴 수 없습니다(최대 ${MAX_BLOB_BODY_BYTES / 1024 / 1024}MB).`,
  noLength: '파일 크기(Content-Length)를 알 수 없어 공용 서재에 올릴 수 없습니다.',
  empty: 'Git Repository is empty.',
  needBase: '공용 서재에는 현재 내용(base_tree) 위에 바꾼 파일만 저장할 수 있습니다. base_tree가 필요합니다.',
  noBranchBase: '공용 서재 브랜치가 아직 없어 base_tree를 쓸 수 없습니다.',
  staleBase: '공용 서재가 그사이 다른 사람의 변경으로 바뀌었습니다. 최신 상태를 받아 합친 뒤 다시 저장합니다.',
  staleParent: '공용 서재가 그사이 다른 사람의 변경으로 바뀌었습니다. 최신 상태를 받아 합친 뒤 다시 저장합니다.',
  badParents: '공용 서재에는 현재 커밋 하나를 부모(parents)로 하는 커밋만 만들 수 있습니다.',
  badTree: '이 트리는 공용 서재 서버를 거쳐 현재 내용 위에 만든 것이 아니어서 저장할 수 없습니다.',
  badSha: '커밋 sha 형식이 올바르지 않습니다.',
  force: '공용 서재에서는 강제 덮어쓰기(force)를 쓸 수 없습니다.',
  badRef: '공용 서재에서는 정해진 브랜치만 만들 수 있습니다.',
  refExists: 'Reference already exists',
  notEmpty: '공용 서재 저장소는 이미 시작되었습니다(README.md는 빈 저장소에서만 만듭니다).',
  badReadme: 'README.md 내용이 올바르지 않습니다(base64, 최대 64KB).',
  tooManyFiles: (max) => `공용 서재에 담을 수 있는 파일 수(${max.toLocaleString('en-US')}개)를 넘었습니다. 휴지통을 비우거나 관리자에게 알려 주세요.`,
  badLibrary: 'library.json 내용이 올바르지 않습니다(공용 서재 목록 형식이 아닙니다).',
  noListing: 'GitHub에서 공용 서재의 파일 목록을 받지 못했습니다. 잠시 후 다시 시도해 주세요.',
  dropsRecords: (items) => `공용 서재에서는 폴더·논문을 목록에서 지울 수 없습니다(삭제는 휴지통으로만 합니다). 문제가 된 항목: ${items.join(', ')}`,
  unknownKeys: (keys) => `공용 서재에서는 다음 항목을 쓸 수 없습니다: ${keys.join(', ')}`,
  full: (used, max, size) => `공용 서재 저장 공간이 부족해 이 PDF(${mb(size)})를 올릴 수 없습니다 `
    + `(사용 중 ${mb(used)} / ${mb(max)}). 휴지통을 비우거나 관리자에게 알려 주세요.`,
  codeFull: (name, used, max, size) => `${name}의 저장 공간이 부족해 이 PDF(${mb(size)})를 올릴 수 없습니다 `
    + `(사용 중 ${mb(used)} / ${mb(max)}). 휴지통을 비우거나 관리자에게 알려 주세요.`,
  notHost: '이 서재에는 코드별 서재가 없습니다.',
  // The same answer whether or not GitHub has such a blob (it is not asked): 409 makes the app pull, upload again
  // (js/store/sync.js) and save.
  notUploaded: '이 서재에 올린 기록이 없는 파일이 있어 저장할 수 없습니다. 파일을 다시 올린 뒤 저장합니다.',
};

/** Commit pages read for 최근 활동 (100 commits each): other libraries' commits are skipped, so read a few. */
const ACTIVITY_PAGES = 3;
/** Summaries of the server-made commits (최근 활동; the app hides none of them). */
export const SPLIT_SUMMARY = '올린 사람의 코드 서재로 나누기';
const SPLIT_TARGET_SUMMARY = (n) => `전체 공용 서재에서 논문 ${n}편 옮겨 옴`;
const MOVE_SUMMARY = (n) => `삭제된 코드의 서재에서 논문 ${n}편 옮겨 옴`;
const LIBRARY_DELETE_SUMMARY = '코드 삭제로 서재 비움';
const PURGE_SUMMARY = (papers, files) => `휴지통 비우기: 30일 지난 논문 ${papers}개의 파일 ${files}개 삭제`;

/**
 * Libraries an invite code may use, as GET /shared lists them: its own code library first ('mine', when the repo
 * that holds code libraries is configured), then every library of SHARED_LIBRARIES ('team' = 전체 공용 서재). The
 * only place that decides which libraries a code sees (the proxy and activity resolve through libraryView).
 * @param {import('./db.js').CodeRow} row
 * @param {import('./config.js').RelayConfig} config
 * @returns {{ id: string, name: string, kind: 'code' | 'team' }[]}
 */
export function librariesFor(row, config) {
  if (!row?.active) return [];
  const own = hostLibrary(config) ? [{ id: CODE_LIBRARY_URL_ID, name: codeLibraryName(row), kind: 'code' }] : [];
  return [...own, ...config.sharedLibraries.map((l) => ({ id: l.id, name: l.name, kind: 'team' }))];
}

/** "<code name> 서재": what the app shows for a code's own library. */
export function codeLibraryName(row) {
  return `${row.name} 서재`;
}

/**
 * One library as the proxy works with it.
 * @typedef {{ urlId: string, kind: 'team' | 'code', lib: import('./config.js').SharedLibrary, root: string,
 *             marker: string, treeKey: string, name: string, maxBytes: number | null }} LibraryView
 *   lib: the SHARED_LIBRARIES entry whose repo holds it (repo-wide caps); root: '' or 'codes/<libraryId>/';
 *   marker: the commit marker ('team' or the library id); treeKey: shared_trees.lib ('team', 'code:<libraryId>');
 *   maxBytes: the code library's own size cap (null for a team library).
 */

/** @returns {LibraryView} */
function teamView(lib) {
  return { urlId: lib.id, kind: 'team', lib, root: '', marker: TEAM_MARKER, treeKey: lib.id, name: lib.name, maxBytes: null };
}

/** @returns {LibraryView} */
export function codeView(host, row, libraryId, config) {
  return {
    urlId: CODE_LIBRARY_URL_ID, kind: 'code', lib: host, root: codeRoot(libraryId), marker: libraryId,
    treeKey: `code:${libraryId}`, name: codeLibraryName(row), maxBytes: libraryMaxBytes(row, config),
  };
}

/** A code library's size cap: the admin's per-code value, else CODE_LIBRARY_MAX_BYTES. */
export function libraryMaxBytes(row, config) {
  const own = Number(row?.library_max_bytes);
  return Number.isFinite(own) && own > 0 ? own : config.codeLibraryMaxBytes;
}

/**
 * The library `urlId` names for the calling code ('mine' = its own code library, made now if it has no id yet), or
 * null when the code may not use it. Call only with TEAM_GITHUB_TOKEN set (a first visit writes the id).
 * @returns {Promise<LibraryView | null>}
 */
async function libraryView(who, urlId, deps) {
  const { config, env } = deps;
  if (!who.row?.active) return null;
  if (urlId === CODE_LIBRARY_URL_ID) {
    const host = hostLibrary(config);
    return host ? codeView(host, who.row, await ensureLibraryId(env.DB, who.row), config) : null;
  }
  const lib = config.sharedLibraries.find((l) => l.id === urlId);
  return lib ? teamView(lib) : null;
}

/** Whether `urlId` names a library this code may use (no D1 write). */
function knownLibrary(who, urlId, config) {
  return librariesFor(who.row, config).some((l) => l.id === urlId);
}

// ───────────────────────────── routing ─────────────────────────────

/**
 * /shared, /shared/<lib>/activity, /shared/<lib>/gh/... (the caller checked the prefix).
 * @param {Request} request
 * @param {URL} url
 * @param {import('./index.js').Deps} deps
 */
export async function handleShared(request, url, deps) {
  const { pathname } = url;
  const method = request.method;
  if (pathname === '/shared') return method === 'GET' ? sharedInfo(request, deps) : notAllowed(method);
  const m = /^\/shared\/([^/]+)(\/.*)?$/.exec(pathname);
  const rest = m?.[2] || '';
  if (m && (rest === '/gh' || rest.startsWith('/gh/'))) return proxy(request, url, m[1], rest.slice(3), deps);
  if (m && rest === '/activity') return method === 'GET' ? activity(request, url, m[1], deps) : notAllowed(method);
  return apiError(404, 'not_found_error', `요청한 주소를 찾을 수 없습니다: ${method} ${pathname}`);
}

function notAllowed(method) {
  return apiError(405, 'invalid_request_error', `이 주소에서는 ${method} 요청을 쓸 수 없습니다.`);
}

/**
 * The invite code (Authorization: Bearer, as GitHubClient sends its token; or x-api-key) → its row and personId,
 * behind the same failed-attempt limiter as the Claude endpoints (auth.js). personId is keyed on the code as stored
 * ("PR-XXXX-XXXX", or a custom code such as "EICU-2026") and its person salt (personIdForRow), so every way of typing
 * it is the same person, and a deleted code made again is a new one.
 * @returns {Promise<{ code: string, row: import('./db.js').CodeRow, personId: string }
 *                   | { error: { status: 401 | 429, message: string, retryAfter?: number } }>}
 */
async function identify(request, { env, now }) {
  const raw = bearer(request) || request.headers.get('x-api-key') || '';
  const check = await checkInviteCode(request, { db: env.DB, raw, now });
  if (check.missing) return { error: { status: 401, message: MSG.noCode } };
  if (check.limited) return { error: { status: 429, message: TOO_MANY_MESSAGE, retryAfter: check.retryAfter } };
  if (!check.row) return { error: { status: 401, message: MSG.badCode } };
  const { row } = check;
  return { code: row.code, row, personId: await personIdForRow(row, env.PERSON_ID_SECRET || '') };
}

/** identify()'s refusal in Anthropic's error shape (/shared, /shared/<lib>/activity). */
function refusal(error) {
  return error.status === 429 ? tooManyAttempts(error.retryAfter) : apiError(401, 'authentication_error', error.message);
}

/** identify()'s refusal in GitHub's error shape (the proxy); GitHubClient waits for retry-after on a 429. */
function ghRefusal(error) {
  return error.status === 429
    ? ghError(429, error.message, { 'retry-after': String(error.retryAfter), 'x-should-retry': 'false' })
    : ghError(401, error.message);
}

/**
 * GET /shared → { libraries: [{ id, name, kind }], personId, name, libraryId } for the calling code: its own library
 * ('mine', kind 'code') and the team libraries (kind 'team'); libraryId = the id of its own library (the client's path
 * prefix 'codes/<libraryId>/'), made on the first call. No libraries (and libraryId null) while TEAM_GITHUB_TOKEN is
 * missing.
 */
async function sharedInfo(request, deps) {
  const who = await identify(request, deps);
  if (who.error) return refusal(who.error);
  const { config, env } = deps;
  const libraries = config.teamToken ? librariesFor(who.row, config) : [];
  const libraryId = libraries.some((l) => l.kind === 'code') ? await ensureLibraryId(env.DB, who.row) : null;
  return json({ libraries, personId: who.personId, name: who.row.name, libraryId });
}

/**
 * GET /shared/<lib>/activity?limit=50 → { items: [{ ts, who, summary }] }: this library's lines of the branch's
 * latest commits (the {lib:…} marker of each commit says which library it changed; never sent).
 */
async function activity(request, url, urlId, deps) {
  const who = await identify(request, deps);
  if (who.error) return refusal(who.error);
  if (!knownLibrary(who, urlId, deps.config)) return apiError(404, 'not_found_error', '공용 서재를 찾을 수 없습니다.');
  if (!deps.config.teamToken) return apiError(503, 'api_error', MSG.noToken);
  const limit = clampInt(url.searchParams.get('limit'), 50, 1, 100);
  try {
    const view = await libraryView(who, urlId, deps);
    if (!view) return apiError(404, 'not_found_error', '공용 서재를 찾을 수 없습니다.');
    const repo = new TeamRepo(view.lib, deps.config);
    const items = [];
    let from = view.lib.branch;
    for (let page = 0; page < ACTIVITY_PAGES && from && items.length < limit; page++) {
      const res = await repo.call('GET', `/commits?sha=${encodeURIComponent(from)}&per_page=100`);
      if (res.status === 404 || res.status === 409) {
        await res.body?.cancel();
        break;
      }
      if (res.status !== 200) throw await repo.passThrough(res);
      const list = await res.json().catch(() => null);
      const commits = Array.isArray(list) ? list : [];
      for (const c of commits) {
        const { who: name, lines } = commitLines(c?.commit?.message);
        const line = lines.find((l) => l.marker === view.marker);
        if (line) items.push({ ts: c?.commit?.committer?.date || c?.commit?.author?.date || null, who: name, summary: line.summary });
        if (items.length >= limit) break;
      }
      const parent = commits.at(-1)?.parents?.[0]?.sha;
      from = commits.length >= 100 && SHA_RE.test(parent || '') ? parent : null;
    }
    return json({ items });
  } catch (err) {
    if (err instanceof UpstreamError) return apiError(err.status >= 500 ? err.status : 502, 'api_error', err.message);
    throw err;
  }
}

// ───────────────────────────── GitHub-compatible proxy ─────────────────────────────

/** Error in GitHub's JSON shape ({ message, documentation_url }); `message` is Korean unless passed through. */
function ghError(status, message, headers = {}) {
  return json({ message, documentation_url: DOCS_URL }, status, headers);
}

/**
 * @typedef {{ request: Request, url: URL, deps: any, view: LibraryView, lib: import('./config.js').SharedLibrary,
 *             repo: TeamRepo, me: string, name: string, now: number }} ProxyCtx
 *   lib = view.lib (the repo, its branch and its repo-wide caps)
 */

/**
 * /shared/<lib>/gh/<sub>: only the routes of SHARED.md §2.1 on /repos/team/library; everything else is 404.
 * <lib> is 'team' (or another SHARED_LIBRARIES id) or 'mine' (the calling code's own library, codes/<libraryId>/).
 */
async function proxy(request, url, urlId, sub, deps) {
  const who = await identify(request, deps);
  if (who.error) return ghRefusal(who.error);
  const m = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(sub);
  if (!knownLibrary(who, urlId, deps.config) || !m || m[1] !== PROXY_OWNER || m[2] !== PROXY_REPO) return ghError(404, MSG.notFound);
  if (!deps.config.teamToken) return ghError(503, MSG.noToken);
  const view = await libraryView(who, urlId, deps);
  if (!view) return ghError(404, MSG.notFound);
  const ctx = {
    request, url, deps, view, lib: view.lib, repo: new TeamRepo(view.lib, deps.config), me: who.personId,
    name: who.row.name, now: deps.now,
  };
  try {
    const res = await proxyRoute(ctx, request.method, m[3] || '');
    for (const [k, v] of Object.entries(ctx.repo.rate)) if (!res.headers.has(k)) res.headers.set(k, v);
    return res;
  } catch (err) {
    if (err instanceof UpstreamError) return ghError(err.status, err.message, { ...ctx.repo.rate, ...err.headers });
    throw err;
  }
}

/** @param {ProxyCtx} ctx */
function proxyRoute(ctx, method, rest) {
  const branch = encodeBranch(ctx.lib.branch);
  let m;
  if (rest === '') return method === 'GET' ? getRepo(ctx) : notFound();
  if (rest === `/git/ref/heads/${branch}`) return method === 'GET' ? getRef(ctx) : notFound();
  if ((m = /^\/git\/commits\/([0-9a-f]{40})$/.exec(rest))) return method === 'GET' ? getCommit(ctx, m[1]) : notFound();
  if ((m = /^\/git\/trees\/([0-9a-f]{40})$/.exec(rest))) return method === 'GET' ? getTree(ctx, m[1]) : notFound();
  if ((m = /^\/git\/blobs\/([0-9a-f]{40})$/.exec(rest))) return method === 'GET' ? getBlob(ctx, m[1]) : notFound();
  if (rest === '/git/blobs') return method === 'POST' ? createBlob(ctx) : notFound();
  if (rest === '/git/trees') return method === 'POST' ? createTree(ctx) : notFound();
  if (rest === '/git/commits') return method === 'POST' ? createCommit(ctx) : notFound();
  if (rest === `/git/refs/heads/${branch}`) return method === 'PATCH' ? updateRef(ctx) : notFound();
  if (rest === '/git/refs') return method === 'POST' ? createRef(ctx) : notFound();
  if (rest === '/contents/README.md') return method === 'PUT' ? bootstrapReadme(ctx) : notFound();
  return notFound();
}

const notFound = () => ghError(404, MSG.notFound);

/** GET /repos/team/library: a sanitised repo object; refused while the real repo is not private. */
async function getRepo(ctx) {
  const info = await ctx.repo.info(ctx.now);
  if (!info.private || info.visibility !== 'private') return ghError(503, MSG.notPrivate);
  return json({
    name: PROXY_REPO, full_name: `${PROXY_OWNER}/${PROXY_REPO}`, private: true, visibility: 'private',
    default_branch: ctx.lib.branch, permissions: { pull: true, push: true },
  });
}

/** GET git/ref/heads/<branch>: passed through with If-None-Match / ETag / 304. */
async function getRef(ctx) {
  const given = ctx.request.headers.get('if-none-match');
  const etag = given && ETAG_RE.test(given.trim()) ? given.trim() : null;
  const res = await ctx.repo.call('GET', `/git/ref/heads/${encodeBranch(ctx.lib.branch)}`, { etag });
  const tag = res.headers.get('etag');
  const headers = tag ? { etag: tag } : {};
  if (res.status === 304) return new Response(null, { status: 304, headers: { ...headers, 'cache-control': 'no-store' } });
  if (res.status !== 200) throw await ctx.repo.passThrough(res);
  const data = await res.json().catch(() => null);
  const sha = data?.object?.sha;
  if (!SHA_RE.test(sha || '')) throw new UpstreamError(502, 'GitHub에서 브랜치 정보를 받지 못했습니다.');
  return json({ ref: `refs/heads/${ctx.lib.branch}`, object: { sha, type: 'commit' } }, 200, headers);
}

/** GET git/commits/<sha>: tree, parents, message and dates only (no names or e-mail addresses). */
async function getCommit(ctx, sha) {
  const c = await ctx.repo.commit(sha);
  if (!c) return notFound();
  const date = Number.isFinite(c.date) ? new Date(c.date).toISOString() : null;
  // Only this library's line of the message: another code library's titles and names never show here.
  return json({
    sha, tree: { sha: c.tree }, parents: c.parents.map((p) => ({ sha: p })), message: messageFor(c.message, ctx.view.marker),
    author: { date }, committer: { date },
  });
}

/**
 * Where tree `sha` sits in the repo: '' for a root tree (the head's, a head of the last 10 min, or one this person
 * made here in the last 10 min), the subtree's path for a subtree of the head (or one shown recently), else null.
 * @param {ProxyCtx} ctx
 * @returns {Promise<string | null>}
 */
async function treeLocation(ctx, sha) {
  const { repo, now, me } = ctx;
  const pick = (paths) => paths.find((p) => visibleIn(p, ctx.view.root, me)) ?? null;
  const fromHead = async (head) => {
    if (head.state !== 'ok') return null;
    if (head.treeSha === sha) return '';
    const index = await repo.index(head.treeSha);
    return pick(index?.trees.get(sha) || []);
  };
  let where = await fromHead(await repo.head(now));
  if (where !== null) return where;
  where = pick(repo.learnedPaths(sha, now));
  if (where !== null) return where;
  const head = await repo.head(now, { maxAgeMs: 0 });
  where = await fromHead(head);
  if (where !== null) return where;
  if (await repo.recentHead(now, RECENT_MS, (_, commit) => commit.tree === sha, head)) return '';
  if (await hasSharedTree(ctx.deps.env.DB, { lib: ctx.view.treeKey, tree: sha, person: me, since: now - RECENT_MS })) return '';
  return null;
}

/**
 * GET git/trees/<sha>[?recursive=1]: GitHub's listing without other people's people/<id>/ entries — and, for the team
 * library, without codes/ (the code libraries); for a code library, without anything outside codes/<libraryId>/
 * (its listings of the root and of codes/ show only the way down).
 */
async function getTree(ctx, sha) {
  const recursive = ctx.url.searchParams.has('recursive');
  const where = await treeLocation(ctx, sha);
  if (where === null || !visibleIn(where, ctx.view.root, ctx.me)) return notFound();
  let entries;
  let truncated;
  if (where === '' && recursive) {
    const index = await ctx.repo.index(sha);
    if (!index) return notFound();
    ({ entries, truncated } = index);
  } else {
    const data = await ctx.repo.listing(sha, recursive);
    if (!data) return notFound();
    entries = data.tree;
    truncated = Boolean(data.truncated);
  }
  const tree = filterEntries(entries, where, ctx.me, ctx.view.root);
  ctx.repo.learnTrees(tree, where, ctx.now);
  return json({ sha, tree, truncated });
}

/**
 * May `me` read blob `sha`? Only a blob shown to this person: one reachable at a path visible to them in the current
 * (or a recent) head tree, or one listed to them level-by-level in the last 10 min, or one they uploaded here. A
 * blob sha of another person's people/<other>/ file is never listed, so this adds a check in depth: even if such a
 * sha were learned some other way, the blob is not served to anyone who was not shown it.
 */
async function blobVisible(ctx, sha) {
  const { repo, me, now } = ctx;
  const visible = (p) => visibleIn(p, ctx.view.root, me);
  if (repo.uploadedBy(sha, uploaderKey(ctx))) return true; // this person uploaded exactly these bytes, to this library
  if (repo.learnedBlobPaths(sha, now).some(visible)) return true;
  const inHead = async (head) => {
    if (head.state !== 'ok') return false;
    const index = await repo.index(head.treeSha);
    return (index?.blobs.get(sha) || []).some(visible);
  };
  if (await inHead(await repo.head(now))) return true;
  const head = await repo.head(now, { maxAgeMs: 0 });
  if (await inHead(head)) return true;
  // A blob of a head from the last 10 min (a file just replaced by a concurrent push that this person is still
  // reading): walk recent heads and accept the blob when it sat at a path visible to them.
  return repo.recentHead(now, RECENT_MS, async (_, commit) => {
    const index = await repo.index(commit.tree);
    return (index?.blobs.get(sha) || []).some(visible);
  }, head);
}

/** GET git/blobs/<sha>: streamed through (raw media type honoured) only for a blob this person may read. */
async function getBlob(ctx, sha) {
  if (!(await blobVisible(ctx, sha))) return notFound();
  const accept = /application\/vnd\.github\.raw/i.test(ctx.request.headers.get('accept') || '') ? RAW_MEDIA : JSON_MEDIA;
  const res = await ctx.repo.call('GET', `/git/blobs/${sha}`, { accept });
  if (res.status !== 200) throw await ctx.repo.passThrough(res);
  const headers = new Headers({ 'cache-control': 'no-store' });
  for (const name of ['content-type', 'content-length']) {
    const v = res.headers.get(name);
    if (v !== null) headers.set(name, v);
  }
  return new Response(res.body, { status: 200, headers });
}

/**
 * POST git/blobs: streamed to GitHub. Bodies over 100 MB are refused; a PDF (or any blob over 8 MB) that would push
 * the repo past its maxBytes — or a code library past its own cap — is refused with 413 before anything is sent.
 */
async function createBlob(ctx) {
  const { request, lib, repo, now, view } = ctx;
  const length = Number(request.headers.get('content-length'));
  if (!request.body || !Number.isFinite(length) || length <= 0) {
    // Read what was sent before answering: a reply in the middle of an upload reaches a browser as a network
    // error (and the sync engine would retry forever) instead of a refusal it can show.
    if (request.body) await discard(request.body.getReader(), MAX_BLOB_BODY_BYTES);
    return ghError(411, MSG.noLength);
  }
  if (length > MAX_BLOB_BODY_BYTES) return ghError(413, MSG.blobTooLarge);
  const reader = request.body.getReader();
  const prefix = await readPrefix(reader, SNIFF_BYTES);
  const size = Math.floor((length * 3) / 4); // base64 JSON body → decoded bytes (upper bound)
  if (looksLikePdf(prefix) || size > LARGE_BLOB_BYTES) {
    const head = await repo.head(now);
    const index = head.state === 'ok' ? await repo.index(head.treeSha) : null;
    const used = index?.bytes ?? 0;
    if (used + size > lib.maxBytes) {
      await discard(reader, MAX_BLOB_BODY_BYTES);
      return ghError(413, MSG.full(used, lib.maxBytes, size));
    }
    if (view.root) {
      const own = bytesUnder(index, view.root);
      if (own + size > view.maxBytes) {
        await discard(reader, MAX_BLOB_BODY_BYTES);
        return ghError(413, MSG.codeFull(view.name, own, view.maxBytes, size));
      }
    }
  }
  const res = await repo.call('POST', '/git/blobs', { body: fixedLengthBody(prefix, reader, length) });
  if (res.status !== 201) throw await repo.passThrough(res);
  const data = await res.json().catch(() => null);
  if (!SHA_RE.test(data?.sha || '')) throw new UpstreamError(502, 'GitHub에서 파일 sha를 받지 못했습니다.');
  repo.rememberUpload(data.sha, uploaderKey(ctx)); // this person's own upload, for the blob-read and tree checks
  // The same proof for a tree that reaches another isolate (createTree). Best effort: the upload itself succeeded,
  // and a tree refused for want of it makes the app upload again.
  await insertSharedBlob(ctx.deps.env.DB, { lib: view.treeKey, sha: data.sha, person: ctx.me, now })
    .catch((err) => console.error('[relay] upload proof not stored', err));
  return json({ sha: data.sha }, 201);
}

/**
 * POST git/trees: on top of the current head's tree (or a head of the last 10 min), only allowlisted paths of this
 * library (under codes/<libraryId>/ for a code library; nothing under codes/ for the team library), deletions only
 * under people/<me>/. Remembered (D1) so POST git/commits can check the commit's parent.
 */
async function createTree(ctx) {
  const { repo, now, me, lib, view } = ctx;
  const libraryPath = `${view.root}${LIBRARY_PATH}`;
  const body = await readJsonObject(ctx.request, MAX_TREE_BODY_BYTES);
  if (body.error) return body.error;
  const extra = Object.keys(body.value).filter((k) => k !== 'base_tree' && k !== 'tree');
  if (extra.length) return ghError(403, MSG.unknownKeys(extra));
  const { base_tree: base, tree } = body.value;
  const head = await repo.head(now, { maxAgeMs: 0 });
  if (head.state === 'empty') return ghError(409, MSG.empty);
  let baseFiles = null;
  let baseIndex = null;
  if (head.state === 'missing') {
    if (base !== undefined) return ghError(403, MSG.noBranchBase);
  } else {
    if (typeof base !== 'string' || !SHA_RE.test(base)) return ghError(403, MSG.needBase);
    if (base !== head.treeSha && !(await repo.recentHead(now, RECENT_MS, (_, c) => c.tree === base, head))) {
      return ghError(409, MSG.staleBase);
    }
    baseIndex = await repo.index(base);
    if (!baseIndex) return ghError(409, MSG.staleBase);
    baseFiles = baseIndex.files;
  }
  const checked = checkTreeEntries(tree, { me, baseFiles, root: view.root });
  if (checked.error) return ghError(403, checked.error);
  // Before GitHub (or this Worker) touches any blob the tree names: each must be one this person uploaded through
  // this library or can already see in it. GitHub accepts any blob of the repo, so otherwise a tree would tell
  // whether some other library (or the history) holds a file whose bytes one can guess — a published PDF — and
  // copy another library's file in by its sha.
  if ((await unprovenBlobs(ctx, checked.entries, baseIndex)).length) return ghError(409, MSG.notUploaded);
  // Cap the number of files: without this a single code could fill the repo (and GitHub's tree) cheaply with
  // countless tiny per-paper JSON files (every papers/<anything>/translation.json or people/<me>/papers/<anything>/…).
  let fileCount = baseFiles ? baseFiles.size : 0;
  for (const e of checked.entries) {
    const exists = Boolean(baseFiles?.has(e.path));
    if (e.sha === null) { if (exists) fileCount--; } else if (!exists) fileCount++;
  }
  if (fileCount > lib.maxFiles) return ghError(403, MSG.tooManyFiles(lib.maxFiles));
  // library.json is the index everyone shares. A client may change it, but not make a folder or paper vanish from
  // the list: deletes must be tombstones (휴지통, restorable 30 days). So a new library.json may not drop any record
  // the base had — this keeps a malicious or buggy client from wiping entries with no recoverable trail.
  const libEntry = checked.entries.find((e) => e.path === libraryPath && e.sha !== null);
  let cmp = null;
  if (libEntry) {
    const next = await loadLibrary(repo, libEntry.sha);
    if (!next.value) return ghError(422, MSG.badLibrary);
    const baseSha = baseFiles?.get(libraryPath)?.sha;
    const baseLib = baseSha ? (await loadLibrary(repo, baseSha)).value ?? null : null;
    cmp = compareLibraries(baseLib, next.value);
    if (cmp.dropped.length) return ghError(403, MSG.dropsRecords(cmp.dropped.slice(0, 5)));
  }
  const res = await repo.call('POST', '/git/trees', {
    json: baseFiles ? { base_tree: base, tree: checked.entries } : { tree: checked.entries },
  });
  if (res.status !== 201) throw await repo.passThrough(res);
  const data = await res.json().catch(() => null);
  if (!SHA_RE.test(data?.sha || '')) throw new UpstreamError(502, 'GitHub에서 트리 sha를 받지 못했습니다.');
  repo.rememberTreeNote(data.sha, noteKey(view, baseFiles ? base : ''), summariseBatch(checked.entries, me, cmp, view.root));
  await insertSharedTree(ctx.deps.env.DB, { lib: view.treeKey, tree: data.sha, base: baseFiles ? base : '', person: me, now });
  return json({ sha: data.sha, tree: filterEntries(data.tree, '', me, view.root), truncated: Boolean(data.truncated) }, 201);
}

/**
 * POST git/commits: parents = [current head] (none while the branch does not exist), the tree made here by this
 * person through this library on top of that head's tree; message → "[<code name>] {lib:<marker>} <first line>"
 * (the answer leaves the marker out).
 */
async function createCommit(ctx) {
  const { repo, now, me, view } = ctx;
  const body = await readJsonObject(ctx.request, MAX_SMALL_BODY_BYTES);
  if (body.error) return body.error;
  const extra = Object.keys(body.value).filter((k) => !['message', 'tree', 'parents'].includes(k));
  if (extra.length) return ghError(403, MSG.unknownKeys(extra));
  const { message, tree, parents } = body.value;
  if (typeof tree !== 'string' || !SHA_RE.test(tree)) return ghError(403, MSG.badTree);
  if (!Array.isArray(parents) || !parents.every((p) => typeof p === 'string' && SHA_RE.test(p))) {
    return ghError(403, MSG.badParents);
  }
  const head = await repo.head(now, { maxAgeMs: 0 });
  if (head.state === 'empty') return ghError(409, MSG.empty);
  const since = now - RECENT_MS;
  const db = ctx.deps.env.DB;
  const baseKey = head.state === 'missing' ? '' : head.treeSha;
  if (head.state === 'missing') {
    if (parents.length) return ghError(403, MSG.badParents);
    if (!(await hasSharedTree(db, { lib: view.treeKey, tree, base: '', person: me, since }))) return ghError(403, MSG.badTree);
  } else {
    if (parents.length !== 1) return ghError(403, MSG.badParents);
    if (parents[0] !== head.commitSha) return ghError(409, MSG.staleParent);
    if (tree !== head.treeSha && !(await hasSharedTree(db, { lib: view.treeKey, tree, base: head.treeSha, person: me, since }))) {
      return ghError(403, MSG.badTree);
    }
  }
  // The commit message becomes the 최근 활동 line, so a client must not label a real change (adding, deleting or
  // wiping folders/papers) as one the app hides ('논문 정보 갱신', '내 메모·AI 결과 동기화'). The Worker allows a quiet
  // summary only when the tree really is that quiet; otherwise it writes its own visible summary of the change.
  // The check looks at the summary exactly as it will be written (markers, codes and runs of spaces removed).
  const first = clientSummary(message);
  let effective = message;
  if (QUIET_SUMMARIES.has(first)) {
    const note = repo.treeNote(tree, noteKey(view, baseKey)) ?? await changeNote(ctx, tree, baseKey);
    if (!note.allowedQuiet.has(first)) effective = note.summary;
  }
  const text = commitMessageFor(ctx.name, effective, view.marker);
  const res = await repo.call('POST', '/git/commits', { json: { message: text, tree, parents } });
  if (res.status !== 201) throw await repo.passThrough(res);
  const data = await res.json().catch(() => null);
  if (!SHA_RE.test(data?.sha || '')) throw new UpstreamError(502, 'GitHub에서 커밋 sha를 받지 못했습니다.');
  repo.rememberCommit(data.sha, {
    tree, parents: [...parents], message: text, date: Date.parse(data.committer?.date || '') || now,
  });
  return json({ sha: data.sha, tree: { sha: tree }, parents: parents.map((p) => ({ sha: p })), message: messageFor(text, view.marker) }, 201);
}

/** PATCH git/refs/heads/<branch>: force must be false; GitHub's 422 (not a fast-forward) passes through. */
async function updateRef(ctx) {
  const body = await readJsonObject(ctx.request, MAX_SMALL_BODY_BYTES);
  if (body.error) return body.error;
  const extra = Object.keys(body.value).filter((k) => k !== 'sha' && k !== 'force');
  if (extra.length) return ghError(403, MSG.unknownKeys(extra));
  const { sha, force } = body.value;
  if (force !== undefined && force !== false) return ghError(403, MSG.force);
  if (typeof sha !== 'string' || !SHA_RE.test(sha)) return ghError(422, MSG.badSha);
  const res = await ctx.repo.call('PATCH', `/git/refs/heads/${encodeBranch(ctx.lib.branch)}`, { json: { sha, force: false } });
  if (res.status !== 200) {
    ctx.repo.forgetHead();
    throw await ctx.repo.passThrough(res);
  }
  await res.body?.cancel();
  await ctx.repo.noteHead(sha, ctx.now);
  return json({ ref: `refs/heads/${ctx.lib.branch}`, object: { sha, type: 'commit' } });
}

/** POST git/refs: only the library's branch, only while it does not exist. */
async function createRef(ctx) {
  const body = await readJsonObject(ctx.request, MAX_SMALL_BODY_BYTES);
  if (body.error) return body.error;
  const extra = Object.keys(body.value).filter((k) => k !== 'ref' && k !== 'sha');
  if (extra.length) return ghError(403, MSG.unknownKeys(extra));
  const { ref, sha } = body.value;
  if (ref !== `refs/heads/${ctx.lib.branch}`) return ghError(403, MSG.badRef);
  if (typeof sha !== 'string' || !SHA_RE.test(sha)) return ghError(422, MSG.badSha);
  const head = await ctx.repo.head(ctx.now, { maxAgeMs: 0 });
  if (head.state === 'empty') return ghError(409, MSG.empty);
  if (head.state === 'ok') return ghError(422, MSG.refExists);
  // Only a first commit made here (no parents, a tree this person built without a base), not e.g. another branch's.
  const commit = await ctx.repo.commit(sha);
  if (!commit || commit.parents.length || !(await hasSharedTree(ctx.deps.env.DB, {
    lib: ctx.view.treeKey, tree: commit.tree, base: '', person: ctx.me, since: ctx.now - RECENT_MS,
  }))) {
    return ghError(403, MSG.badTree);
  }
  const res = await ctx.repo.call('POST', '/git/refs', { json: { ref, sha } });
  if (res.status !== 201) {
    ctx.repo.forgetHead();
    throw await ctx.repo.passThrough(res);
  }
  await res.body?.cancel();
  await ctx.repo.noteHead(sha, ctx.now);
  return json({ ref, object: { sha, type: 'commit' } }, 201);
}

/** PUT contents/README.md: only while the repo is empty (the client's bootstrap). */
async function bootstrapReadme(ctx) {
  const body = await readJsonObject(ctx.request, MAX_SMALL_BODY_BYTES * 2);
  if (body.error) return body.error;
  const extra = Object.keys(body.value).filter((k) => !['message', 'content', 'branch'].includes(k));
  if (extra.length) return ghError(403, MSG.unknownKeys(extra));
  const { message, content, branch = ctx.lib.branch } = body.value;
  if (branch !== ctx.lib.branch) return ghError(403, MSG.badRef);
  if (typeof content !== 'string' || !/^[A-Za-z0-9+/=\s]*$/.test(content) || content.length > (MAX_README_BYTES * 4) / 3 + 4) {
    return ghError(422, MSG.badReadme);
  }
  const head = await ctx.repo.head(ctx.now, { maxAgeMs: 0 });
  if (head.state !== 'empty') return ghError(422, MSG.notEmpty);
  const res = await ctx.repo.call('PUT', '/contents/README.md', {
    json: { message: commitMessageFor(ctx.name, message, ctx.view.marker), content, branch },
  });
  ctx.repo.forgetHead();
  if (res.status !== 201 && res.status !== 200) throw await ctx.repo.passThrough(res);
  const data = await res.json().catch(() => null);
  const commitSha = data?.commit?.sha;
  const treeSha = data?.commit?.tree?.sha;
  if (!SHA_RE.test(commitSha || '') || !SHA_RE.test(treeSha || '')) {
    throw new UpstreamError(502, '빈 저장소를 준비하지 못했습니다.');
  }
  return json({
    content: { path: 'README.md', sha: data?.content?.sha ?? null },
    commit: { sha: commitSha, tree: { sha: treeSha } },
  }, res.status);
}

// ───────────────────────────── admin ─────────────────────────────

/**
 * /relay/admin/shared/<lib>/stats, /purge and /split-by-uploader (the caller checked the admin token). `path` is
 * after /relay/admin.
 * @returns {Promise<Response | null>} null when the path is not a shared-library admin path
 */
export async function handleSharedAdmin(request, path, deps) {
  const m = /^\/shared\/([^/]+)\/(stats|purge|split-by-uploader)$/.exec(path);
  if (!m) return null;
  const { config } = deps;
  const lib = config.sharedLibraries.find((l) => l.id === m[1]);
  if (!lib) return apiError(404, 'not_found_error', `공용 서재를 찾을 수 없습니다: ${m[1]}`);
  const wanted = m[2] === 'stats' ? 'GET' : 'POST';
  if (request.method !== wanted) return notAllowed(request.method);
  if (!config.teamToken) return apiError(503, 'api_error', MSG.noToken);
  let dryRun = true;
  if (m[2] === 'split-by-uploader') {
    if (lib !== hostLibrary(config)) return apiError(400, 'invalid_request_error', MSG.notHost);
    const read = await readBody(request, MAX_SMALL_BODY_BYTES);
    const body = read.tooLarge ? undefined : read.bytes.byteLength ? parseJson(read.bytes) : {};
    if (!body || typeof body !== 'object' || Array.isArray(body) || (body.dryRun !== undefined && typeof body.dryRun !== 'boolean')) {
      return apiError(400, 'invalid_request_error', '요청 본문은 { "dryRun": true | false } 형식이어야 합니다.');
    }
    dryRun = body.dryRun !== false;
  }
  const repo = new TeamRepo(lib, config);
  try {
    if (m[2] === 'stats') return await stats(repo, lib, deps);
    if (m[2] === 'purge') return await purge(repo, deps);
    return await splitByUploader(repo, deps, { dryRun });
  } catch (err) {
    if (err instanceof UpstreamError) return apiError(err.status >= 500 ? err.status : 502, 'api_error', err.message);
    throw err;
  }
}

/**
 * { bytes, papers, people, maxBytes }: totals of the head tree (bytes = the whole repo, which maxBytes caps; papers =
 * the team library's paper.pdf files, people = its people/<id>/ folders — code libraries are not counted there).
 */
async function stats(repo, lib, { now }) {
  const head = await repo.head(now, { maxAgeMs: 0 });
  const index = head.state === 'ok' ? await repo.index(head.treeSha) : null;
  const files = index ? [...index.files.keys()] : [];
  const people = new Set(files.map((p) => /^people\/([^/]+)\//.exec(p)?.[1]).filter(Boolean));
  return json({
    bytes: index?.bytes ?? 0,
    papers: files.filter((p) => /^papers\/[^/]+\/paper\.pdf$/.test(p)).length,
    people: people.size,
    maxBytes: lib.maxBytes,
  });
}

/**
 * One server-side commit deleting the files (papers/<id>/* and everyone's people/<x>/papers/<id>/*) of papers that
 * were tombstoned more than 30 days ago — in the team library and in every code library of the repo (each by its own
 * library.json; one 최근 활동 line per library). The tombstone records stay in library.json.
 * → { purged: [paperId], files, freedBytes, commitSha }
 */
async function purge(repo, { now }) {
  // The deletion time in a tombstone is written by a client, so it cannot by itself prove a paper has been in the
  // 휴지통 for 30 days (a back-dated deletedAt could otherwise make the next purge destroy a just-deleted paper and
  // everyone's notes on it at once). A paper is purged only when it was already tombstoned, with the same deletion
  // time, in the newest commit that is itself at least 30 days old by GitHub's commit date.
  const beforeCommit = await repo.commitBefore(now - PURGE_AFTER_MS);
  const beforeIndex = beforeCommit ? await repo.index(beforeCommit.tree) : null;
  const beforeOf = async (root) => {
    const file = beforeIndex?.files.get(`${root}${LIBRARY_PATH}`);
    return file ? (await loadLibrary(repo, file.sha)).value?.top ?? null : null;
  };
  const done = await serverCommit(repo, now, async (head) => {
    const index = await repo.index(head.treeSha);
    if (!index) return null;
    const lines = [];
    const paths = [];
    const purged = [];
    let freedBytes = 0;
    for (const root of libraryRoots(index)) {
      const libraryFile = index.files.get(`${root}${LIBRARY_PATH}`);
      if (!libraryFile) continue;
      const library = (await loadLibrary(repo, libraryFile.sha)).value?.top ?? null;
      const ids = confirmedPurgeIds(library, await beforeOf(root), now, PURGE_AFTER_MS);
      if (!ids.length) continue;
      const own = paperFiles(relativePaths(index.files, root), ids);
      if (!own.length) continue;
      const done = ids.filter((id) => own.some((p) => p.startsWith(`papers/${id}/`) || p.includes(`/papers/${id}/`)));
      const full = own.map((p) => `${root}${p}`);
      paths.push(...full);
      purged.push(...done);
      freedBytes += full.reduce((sum, p) => sum + (index.files.get(p)?.size ?? 0), 0);
      lines.push({ marker: markerOf(root), summary: PURGE_SUMMARY(done.length, full.length) });
    }
    if (!paths.length) return null;
    return { entries: paths.map((path) => ({ path, sha: null })), message: adminMessage(lines), purged, freedBytes };
  });
  if (!done) return json({ purged: [], files: 0, freedBytes: 0, commitSha: null });
  return json({ purged: done.purged, files: done.entries.length, freedBytes: done.freedBytes, commitSha: done.commitSha });
}

/**
 * The split (POST /relay/admin/shared/team/split-by-uploader { dryRun }): every paper of the team library whose
 * addedBy is exactly the name of exactly one code (active or stopped) and that is not in the 휴지통 moves into that
 * code's own library — PDF, translation and that code holder's notes, in folders of the same names — and leaves the
 * team library (its record removed, folders left empty tombstoned). The dry run only plans; the apply is one commit
 * "[관리자] {lib:team} 올린 사람의 코드 서재로 나누기" (+ one line per receiving code library), planned again on the
 * newest head. A re-run finds nothing more to move.
 * → { moves: [{ paperId, title, toCode, folderPath }], skipped: [{ paperId, title, reason }] } (+ commitSha on apply)
 */
async function splitByUploader(repo, deps, { dryRun }) {
  const { env, now } = deps;
  const secret = env.PERSON_ID_SECRET || '';
  const codes = await allCodes(env.DB);
  const read = async (head) => {
    const index = await repo.index(head.treeSha);
    if (!index || index.truncated) throw new UpstreamError(502, MSG.noListing);
    const file = index.files.get(LIBRARY_PATH);
    return { index, library: file ? (await loadLibrary(repo, file.sha)).value?.top ?? null : null };
  };
  const shown = ({ moves, skipped }) => ({ moves: moves.map(({ code, ...move }) => move), skipped });
  if (dryRun) {
    const head = await repo.head(now, { maxAgeMs: 0 });
    if (head.state !== 'ok') return json({ moves: [], skipped: [] });
    const { library } = await read(head);
    return json(shown(planSplit({ library, codes })));
  }
  let latest = { moves: [], skipped: [] };
  const done = await serverCommit(repo, now, async (head) => {
    const { index, library } = await read(head);
    const plan = planSplit({ library, codes });
    const targets = new Map();
    const moves = [];
    for (const move of plan.moves) {
      if (!targets.has(move.code)) {
        const row = codes.find((c) => c.code === move.code);
        const libraryId = await ensureLibraryId(env.DB, row);
        const root = codeRoot(libraryId);
        const file = index.files.get(`${root}${LIBRARY_PATH}`);
        const parsed = file ? (await loadLibrary(repo, file.sha)).value : null;
        const personIds = await personIdsOfDeletedCode(row, secret);
        // A code library whose library.json cannot be read is left alone (its papers would be hidden).
        targets.set(move.code, file && !parsed ? null : {
          root, marker: libraryId, library: parsed?.top ?? null, personIds, personId: personIds[0],
        });
      }
      if (targets.get(move.code)) moves.push(move);
      else plan.skipped.push({ paperId: move.paperId, title: move.title, reason: '코드 서재의 목록(library.json)을 읽을 수 없음' });
    }
    latest = { moves, skipped: plan.skipped };
    if (!moves.length) return null;
    const result = applySplit({ library, files: index.files, moves, targets, now });
    const entries = [...result.entries, { path: LIBRARY_PATH, sha: await createJsonBlob(repo, result.team) }];
    const lines = [{ marker: TEAM_MARKER, summary: SPLIT_SUMMARY }];
    for (const [root, lib] of result.libraries) entries.push({ path: `${root}${LIBRARY_PATH}`, sha: await createJsonBlob(repo, lib) });
    for (const [code, n] of result.counts) lines.push({ marker: targets.get(code).marker, summary: SPLIT_TARGET_SUMMARY(n) });
    return { entries, message: adminMessage(lines) };
  });
  return json({ ...shown(latest), commitSha: done?.commitSha ?? null });
}

/**
 * One server-side commit on the library's branch with the changes `plan(head)` picks — `{ entries: [{ path, sha }],
 * message, … }` (sha null = delete), or null when there is nothing to change — on top of the current head. When
 * someone pushes in between (GitHub's 422 on the ref update) it starts again from the new head, at most
 * MAX_PURGE_ATTEMPTS times. Used by the 30-day purge, code deletion and the split. Throws UpstreamError when GitHub
 * cannot be reached or refuses.
 * @param {TeamRepo} repo
 * @param {number} now
 * @param {(head: { commitSha: string, treeSha: string }) => Promise<{ entries: { path: string, sha: string | null }[],
 *          message: string } | null>} plan
 * @returns {Promise<({ entries: any[], message: string, commitSha: string } & Record<string, any>) | null>}
 */
async function serverCommit(repo, now, plan) {
  for (let attempt = 1; ; attempt++) {
    const head = await repo.head(now, { maxAgeMs: 0 });
    if (head.state !== 'ok') return null; // an empty repo or a missing branch holds no files
    const planned = await plan(head);
    if (!planned?.entries.length) return null;
    const treeRes = await repo.call('POST', '/git/trees', {
      json: { base_tree: head.treeSha, tree: planned.entries.map(({ path, sha }) => ({ path, mode: '100644', type: 'blob', sha })) },
    });
    if (treeRes.status !== 201) throw await repo.passThrough(treeRes);
    const tree = (await treeRes.json().catch(() => null))?.sha;
    if (!SHA_RE.test(tree || '')) throw new UpstreamError(502, 'GitHub에서 트리 sha를 받지 못했습니다.');
    const { message } = planned;
    const commitRes = await repo.call('POST', '/git/commits', { json: { message, tree, parents: [head.commitSha] } });
    if (commitRes.status !== 201) throw await repo.passThrough(commitRes);
    const commitSha = (await commitRes.json().catch(() => null))?.sha;
    if (!SHA_RE.test(commitSha || '')) throw new UpstreamError(502, 'GitHub에서 커밋 sha를 받지 못했습니다.');
    repo.rememberCommit(commitSha, { tree, parents: [head.commitSha], message, date: now });
    const refRes = await repo.call('PATCH', `/git/refs/heads/${encodeBranch(repo.lib.branch)}`, {
      json: { sha: commitSha, force: false },
    });
    if (refRes.status === 200) {
      await refRes.body?.cancel();
      await repo.noteHead(commitSha, now);
      return { ...planned, commitSha };
    }
    repo.forgetHead();
    if (refRes.status !== 422 || attempt >= MAX_PURGE_ATTEMPTS) throw await repo.passThrough(refRes);
    await refRes.body?.cancel(); // someone pushed meanwhile: start again from the new head
  }
}

/**
 * Code deletion (index.js), in every library of SHARED_LIBRARIES: remove everything under the team library's
 * people/<id>/ of `personIds` (the 최근 활동 line "[관리자] 초대 코드 삭제에 따라 개인 기록 정리", no person id in it),
 * and — in the repo that holds code libraries — the deleted code's own library at the same time, in the same commit:
 * - `library.action === 'delete'`: every file under codes/<libraryId>/;
 * - `library.action === 'move'`: everything under codes/<libraryId>/ moves into codes/<to.libraryId>/ (library.json
 *   records merged by id, a clashing id renamed; the deleted holder's notes become `to.personId`'s), so replacing a
 *   person's code keeps their library.
 * A library with nothing to change gets no commit. Shared files of the team library and other people's folders are
 * never touched. Throws UpstreamError when GitHub cannot be reached or refuses, so the caller keeps the code; a retry
 * skips what is already done. The repo holding the code's own library is done last, so a failure in another library
 * never leaves the code (switched back on) without its library. Without TEAM_GITHUB_TOKEN nothing can have been
 * stored through this Worker.
 * @param {import('./index.js').Deps} deps
 * @param {{ personIds: string[], library: null | { libraryId: string, action: 'delete' }
 *          | { libraryId: string, action: 'move', to: { libraryId: string, personId: string } } }} what
 * @returns {Promise<{ files: number, commits: number, library: null | { action: 'delete' | 'move', papers: number,
 *                     files: number, renamed?: number } }>} files = people files removed (as before code libraries)
 */
export async function removeCodeData(deps, { personIds, library = null }) {
  const { config, now } = deps;
  if (!config.teamToken) return { files: 0, commits: 0, library: null };
  const host = hostLibrary(config);
  let files = 0;
  let commits = 0;
  let libraryDone = null;
  // The repo that holds the code's own library goes last: its commit deletes or moves that library for good, so it
  // happens only once every other library is clean — a failure anywhere before leaves the library where it was.
  const order = [...config.sharedLibraries.filter((l) => l !== host), ...config.sharedLibraries.filter((l) => l === host)];
  for (const lib of order) {
    const repo = new TeamRepo(lib, config);
    const withLibrary = lib === host && library && LIBRARY_ID_RE.test(library.libraryId || '');
    const done = await serverCommit(repo, now, async (head) => {
      const people = personIds.length ? await personPaths(repo, head, personIds) : [];
      const entries = people.map((path) => ({ path, sha: null }));
      const lines = people.length ? [{ marker: TEAM_MARKER, summary: CODE_DELETE_SUMMARY }] : [];
      const own = withLibrary ? await planCodeLibrary(repo, head, library, personIds, now) : null;
      if (own) {
        entries.push(...own.entries);
        lines.push(own.line);
      }
      if (!entries.length) return null;
      return { entries, message: adminMessage(lines), people: people.length, library: own?.result ?? null };
    });
    if (done) {
      files += done.people;
      commits++;
      if (done.library) libraryDone = done.library;
    }
  }
  return { files, commits, library: libraryDone };
}

/** Delete or move a deleted code's own library on `head` (removeCodeData); null when it holds no files. */
async function planCodeLibrary(repo, head, what, personIds, now) {
  const fromRoot = codeRoot(what.libraryId);
  const fromFiles = await filesUnder(repo, head, fromRoot);
  if (!fromFiles.size) return null;
  const from = await libraryAt(repo, fromFiles, fromRoot);
  const papers = from.value ? livePapers(from.value) : 0;
  if (what.action !== 'move') {
    const paths = planLibraryDelete(fromFiles, fromRoot);
    return {
      entries: paths.map((path) => ({ path, sha: null })),
      line: { marker: what.libraryId, summary: LIBRARY_DELETE_SUMMARY },
      result: { action: 'delete', papers, files: paths.length },
    };
  }
  const toRoot = codeRoot(what.to.libraryId);
  const toFiles = await filesUnder(repo, head, toRoot);
  const to = await libraryAt(repo, toFiles, toRoot);
  // A library.json that cannot be read is never replaced: then the records stay where they are (files still move).
  const merge = !from.corrupt && !to.corrupt;
  const plan = planLibraryMove({
    files: new Map([...fromFiles, ...toFiles]), fromRoot, toRoot, from: merge ? from.value : null, to: to.value,
    personMap: new Map(personIds.map((id) => [id, what.to.personId])), now,
  });
  if (!plan) return null;
  const entries = [...plan.entries];
  if (plan.library) entries.push({ path: `${toRoot}${LIBRARY_PATH}`, sha: await createJsonBlob(repo, plan.library) });
  return {
    entries,
    line: { marker: what.to.libraryId, summary: MOVE_SUMMARY(plan.papers) },
    result: { action: 'move', papers: plan.papers, files: plan.entries.filter((e) => e.sha !== null).length, renamed: plan.renamed },
  };
}

/**
 * GET /relay/admin/codes/<code>/library: the code's own library — { code, name, libraryId, papers (not in the 휴지통),
 * trashed, files, bytes, maxBytes }. A code that never opened its library has libraryId null and zeros.
 * @param {import('./db.js').CodeRow} row
 */
export async function codeLibraryReport(deps, row) {
  const { config, now } = deps;
  const host = hostLibrary(config);
  const libraryId = LIBRARY_ID_RE.test(row.library_id || '') ? row.library_id : null;
  const report = { code: row.code, name: row.name, libraryId, papers: 0, trashed: 0, files: 0, bytes: 0, maxBytes: libraryMaxBytes(row, config) };
  if (!libraryId || !host) return report;
  const repo = new TeamRepo(host, config);
  const head = await repo.head(now, { maxAgeMs: 0 });
  if (head.state !== 'ok') return report;
  const root = codeRoot(libraryId);
  const files = await filesUnder(repo, head, root);
  const library = (await libraryAt(repo, files, root)).value;
  const papers = library ? listOf(library.papers).filter((p) => p && typeof p === 'object' && typeof p.id === 'string') : [];
  return {
    ...report,
    papers: papers.filter((p) => p.deleted !== true).length,
    trashed: papers.filter((p) => p.deleted === true).length,
    files: files.size,
    bytes: [...files.values()].reduce((sum, f) => sum + (f.size || 0), 0),
  };
}

/**
 * The files under people/<id>/ of `personIds` in the head tree: from the (cached) recursive index or — when GitHub
 * truncated that listing (a very large repo) — by walking root → people → <id>, each person's own folder listed
 * recursively.
 * @param {TeamRepo} repo
 */
async function personPaths(repo, head, personIds) {
  const index = await repo.index(head.treeSha);
  if (!index) throw new UpstreamError(502, MSG.noListing);
  if (!index.truncated) return personFiles(index.files.keys(), personIds);
  const root = await repo.listing(head.treeSha, false);
  if (!root) throw new UpstreamError(502, MSG.noListing);
  const people = root.tree.find((e) => e?.path === 'people' && e.type === 'tree');
  if (!people) return [];
  const level = await repo.listing(people.sha, false);
  if (!level) throw new UpstreamError(502, MSG.noListing);
  const found = [];
  for (const dir of level.tree) {
    if (dir?.type !== 'tree' || !personIds.includes(dir.path)) continue;
    const sub = await repo.listing(dir.sha, true);
    if (!sub || sub.truncated) throw new UpstreamError(502, MSG.noListing);
    for (const f of sub.tree) if (f?.type === 'blob' && typeof f.path === 'string') found.push(`people/${dir.path}/${f.path}`);
  }
  return personFiles(found, personIds);
}

/**
 * The files of the head tree under `root` (a code library's 'codes/<id>/'): from the recursive index, or — when GitHub
 * truncated it — by walking down to that folder and listing it recursively.
 * @returns {Promise<Map<string, { sha: string, size: number }>>}
 */
async function filesUnder(repo, head, root) {
  const index = await repo.index(head.treeSha);
  if (!index) throw new UpstreamError(502, MSG.noListing);
  if (!index.truncated) return new Map([...index.files].filter(([path]) => path.startsWith(root)));
  let sha = head.treeSha;
  for (const part of root.slice(0, -1).split('/')) {
    const level = await repo.listing(sha, false);
    if (!level) throw new UpstreamError(502, MSG.noListing);
    const dir = level.tree.find((e) => e?.path === part && e.type === 'tree');
    if (!dir) return new Map();
    sha = dir.sha;
  }
  const sub = await repo.listing(sha, true);
  if (!sub || sub.truncated) throw new UpstreamError(502, MSG.noListing);
  const out = new Map();
  for (const f of sub.tree) {
    if (f?.type === 'blob' && typeof f.path === 'string') out.set(`${root}${f.path}`, { sha: f.sha, size: Number(f.size) || 0 });
  }
  return out;
}

/** The library.json at `root` among `files`: { value } (null when there is none) or { value: null, corrupt: true }. */
async function libraryAt(repo, files, root) {
  const file = files.get(`${root}${LIBRARY_PATH}`);
  if (!file) return { value: null, corrupt: false };
  const value = (await loadLibrary(repo, file.sha)).value?.top ?? null;
  return { value, corrupt: !value };
}

/** Papers of a library.json object that are not in the 휴지통. */
function livePapers(library) {
  return listOf(library?.papers).filter((p) => p && typeof p === 'object' && typeof p.id === 'string' && p.deleted !== true).length;
}

/** '' (the team library) and 'codes/<id>/' of every code library with a library.json in `index`. */
function libraryRoots(index) {
  const codes = [];
  for (const path of index.files.keys()) {
    const m = /^codes\/([0-9a-f]{16})\/library\.json$/.exec(path);
    if (m) codes.push(codeRoot(m[1]));
  }
  return ['', ...codes.sort()];
}

/** Paths under `root`, relative to it. */
function relativePaths(files, root) {
  const out = [];
  for (const path of files.keys()) if (path.startsWith(root)) out.push(path.slice(root.length));
  return out;
}

/** Upload a JSON file (as the app writes it: 2-space indent, final newline); its blob sha. */
async function createJsonBlob(repo, value) {
  const bytes = new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`);
  const res = await repo.call('POST', '/git/blobs', { json: { content: toBase64(bytes), encoding: 'base64' } });
  if (res.status !== 201) throw await repo.passThrough(res);
  const sha = (await res.json().catch(() => null))?.sha;
  if (!SHA_RE.test(sha || '')) throw new UpstreamError(502, 'GitHub에서 파일 sha를 받지 못했습니다.');
  return sha;
}

function toBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

const listOf = (v) => (Array.isArray(v) ? v : []);

/** Bytes of the files under `root` in a head index (a code library's share of the repo). */
function bytesUnder(index, root) {
  let sum = 0;
  if (index) for (const [path, f] of index.files) if (path.startsWith(root)) sum += f.size || 0;
  return sum;
}

/**
 * Who uploaded a blob, for the blob-read check: this person in this library (a person's upload to their code library
 * must not make the blob readable through 전체 공용 서재, nor by anyone else who happens to ask for its sha).
 */
function uploaderKey(ctx) {
  return `${ctx.view.treeKey}
${ctx.me}`;
}

/**
 * The blob shas of a tree POST's entries that this person has not shown they have, in this library: not uploaded
 * by them through it (this isolate's memory, else the D1 proof of the last hour) and not at a path they can see in
 * it — in the base tree, or listed to them level by level. Decided without asking GitHub, so the answer is the same
 * whether or not the repo holds such a blob.
 * @param {ProxyCtx} ctx
 * @param {{ sha: string | null }[]} entries checked entries (sha null = a deletion)
 * @param {import('./github.js').TreeIndex | null} baseIndex the base tree's index (null: no base)
 * @returns {Promise<string[]>}
 */
async function unprovenBlobs(ctx, entries, baseIndex) {
  const { repo, me, view, now } = ctx;
  const visible = (p) => visibleIn(p, view.root, me);
  const left = [];
  for (const sha of new Set(entries.map((e) => e.sha).filter(Boolean))) {
    if (repo.uploadedBy(sha, uploaderKey(ctx))) continue;
    if ((baseIndex?.blobs.get(sha) || []).some(visible) || repo.learnedBlobPaths(sha, now).some(visible)) continue;
    left.push(sha);
  }
  if (!left.length) return left;
  const proven = await uploadedBlobs(ctx.deps.env.DB, { lib: view.treeKey, shas: left, person: me, since: now - SHARED_TREE_KEEP_MS });
  return left.filter((sha) => !proven.has(sha));
}

/** Key of a tree note (what a tree made here changed) for one library: the same tree may sit in two libraries. */
function noteKey(view, base) {
  return `${view.marker}:${base}`;
}

// ───────────────────────────── helpers ─────────────────────────────

/**
 * Parse the library.json blob `sha` as every client reads it (cached by sha).
 * @returns {Promise<{ value: { top, folders, papers } } | { value: null }>} value is null when missing, too large or corrupt.
 */
async function loadLibrary(repo, sha) {
  const res = await repo.library(sha, MAX_LIBRARY_JSON_BYTES, (bytes) => parseLibrary(bytes));
  return res && 'value' in res ? res : { value: null };
}

/**
 * What a tree POST's changed entries are (summary line + which hidden summaries they may legitimately carry).
 * `entries` are the changed paths of the batch (a tree POST with a base lists only what changed); `cmp` is the
 * library.json comparison when the batch changed it; `root` the library's root (paths outside it are loud).
 * @returns {{ allowedQuiet: Set<string>, summary: string }}
 */
function summariseBatch(entries, me, cmp, root = '') {
  let libraryChanged = false;
  let translations = 0;
  let pdfs = 0;
  let loudOther = 0; // a shared change others can see that is not quiet (e.g. a path outside the layout)
  let total = 0;
  for (const e of entries) {
    total++;
    const where = classifyIn(e.path, root);
    if (where?.kind === 'library') libraryChanged = true;
    else if (where?.kind === 'translation') translations++;
    else if (where?.kind === 'pdf') pdfs++;
    else if (where?.kind === 'personal' && where.person === me) { /* a person's own file: others can't see it */ }
    else loudOther++;
  }
  // A batch may carry a hidden summary (내 메모·AI 결과 동기화 / 논문 정보 갱신) only when it holds nothing others need to
  // see: no new/changed translation or PDF, nothing outside the layout, and any library.json change limited to
  // progress counts. One's own people/<me>/ files are always hidden. A loud batch gets the Worker's own summary.
  const quiet = total > 0 && translations === 0 && pdfs === 0 && loudOther === 0 && (!libraryChanged || Boolean(cmp?.quiet));
  const allowedQuiet = quiet ? new Set([PERSONAL_SUMMARY, QUIET_LIBRARY_SUMMARY]) : new Set();
  return { allowedQuiet, summary: describeSharedChange({ library: libraryChanged ? cmp : null, translations, pdfs }) };
}

/**
 * The change a committed tree makes over its parent tree (recomputed when createTree's per-isolate note is gone,
 * e.g. the commit reached a different isolate). Diffs the two trees' file lists and compares library.json.
 * @param {ProxyCtx} ctx
 * @returns {Promise<{ allowedQuiet: Set<string>, summary: string }>}
 */
async function changeNote(ctx, treeSha, baseTreeSha) {
  const { repo, me, view } = ctx;
  const libraryPath = `${view.root}${LIBRARY_PATH}`;
  const idxNew = await repo.index(treeSha);
  if (!idxNew) return { allowedQuiet: new Set(), summary: describeSharedChange({}) };
  const baseFiles = baseTreeSha ? (await repo.index(baseTreeSha))?.files ?? new Map() : new Map();
  const changed = [];
  for (const [path, f] of idxNew.files) if (baseFiles.get(path)?.sha !== f.sha) changed.push({ path, sha: f.sha });
  for (const path of baseFiles.keys()) if (!idxNew.files.has(path)) changed.push({ path, sha: null });
  let cmp = null;
  const libEntry = changed.find((e) => e.path === libraryPath && e.sha);
  if (libEntry) {
    const next = await loadLibrary(repo, libEntry.sha);
    const baseSha = baseFiles.get(libraryPath)?.sha;
    const baseLib = baseSha ? (await loadLibrary(repo, baseSha)).value ?? null : null;
    if (next.value) cmp = compareLibraries(baseLib, next.value);
  }
  return summariseBatch(changed, me, cmp, view.root);
}

/** @returns {Promise<{ value: Record<string, any> } | { error: Response }>} */
async function readJsonObject(request, max) {
  const read = await readBody(request, max);
  if (read.tooLarge) return { error: ghError(413, MSG.tooLargeBody) };
  const value = parseJson(read.bytes);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { error: ghError(400, MSG.badJson) };
  return { value };
}

/** Read at least `n` bytes (or everything, if shorter) from the start of a body. */
async function readPrefix(reader, n) {
  const chunks = [];
  let size = 0;
  while (size < n) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

/** Read and drop the rest of a body (at most `max` bytes, then give up and cancel). */
async function discard(reader, max) {
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      size += value.byteLength;
      if (size > max) break;
    }
  } catch { /* the client went away */ }
  await reader.cancel().catch(() => {});
}

/** Does a POST git/blobs body (JSON, content base64 or utf-8) start a PDF? */
export function looksLikePdf(prefix) {
  const text = String.fromCharCode(...prefix.subarray(0, SNIFF_BYTES));
  const m = /"content"\s*:\s*"([^"]{0,16})/.exec(text);
  if (!m) return false;
  if (m[1].startsWith('%PDF-')) return true;
  const b64 = m[1].replace(/\s+/g, '').slice(0, 8);
  if (b64.length < 8 || !/^[A-Za-z0-9+/]{8}$/.test(b64)) return false;
  return atob(b64).startsWith('%PDF-');
}

/** The already read `prefix` followed by the rest of `reader`, as a body of exactly `length` bytes (streamed). */
function fixedLengthBody(prefix, reader, length) {
  const { readable, writable } = new FixedLengthStream(length);
  const writer = writable.getWriter();
  (async () => {
    try {
      if (prefix.byteLength) await writer.write(prefix);
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        await writer.write(value);
      }
      await writer.close();
    } catch (err) {
      await writer.abort(err).catch(() => {});
      await reader.cancel(err).catch(() => {});
    }
  })();
  return readable;
}

function mb(bytes) {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
  return `${(bytes / 1e6).toFixed(1)} MB`;
}

function clampInt(raw, fallback, min, max) {
  const n = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}
