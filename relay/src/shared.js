// Shared team library ("공용 서재", docs/SHARED.md §2): a GitHub-API-compatible proxy in front of a private team repo,
// so the app's GitHubClient + SyncEngine work unchanged with apiBase = <relay>/shared/<lib>/gh, owner 'team', repo
// 'library' and the invite code as its token. The Worker checks the code, allows only the routes and repo paths
// of the layout (everyone may change the shared files, nobody another person's people/<id>/ files), hides other
// people's files from tree listings, rewrites commit messages with the code's name and calls GitHub with its own
// token (TEAM_GITHUB_TOKEN). Also GET /shared, GET /shared/<lib>/activity, the admin stats / purge, and removing a
// deleted invite code's people/<id>/ files (removePersonFiles, for DELETE /relay/admin/codes/<code> in index.js).
import { checkInviteCode } from './auth.js';
import { hasSharedTree, insertSharedTree } from './db.js';
import { encodeBranch, JSON_MEDIA, RAW_MEDIA, TeamRepo, UpstreamError } from './github.js';
import { apiError, bearer, json, parseJson, readBody } from './http.js';
import { TOO_MANY_MESSAGE, tooManyAttempts } from './limiter.js';
import {
  checkTreeEntries, classifyPath, CODE_DELETE_MESSAGE, commitMessageFor, compareLibraries, confirmedPurgeIds,
  describeSharedChange, filterEntries, LIBRARY_PATH, paperFiles, parseCommitLine, parseLibrary, PERSONAL_SUMMARY,
  personFiles, personIdForRow, QUIET_LIBRARY_SUMMARY, QUIET_SUMMARIES, scrubText, visibleTo,
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
};

/**
 * Libraries an invite code may use. Today every active code may use every library in SHARED_LIBRARIES; a
 * code_libraries table can restrict this here later (the only place that decides it).
 * @param {import('./db.js').CodeRow} row
 * @param {import('./config.js').RelayConfig} config
 */
export function librariesFor(row, config) {
  return row?.active ? config.sharedLibraries : [];
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

/** GET /shared → { libraries: [{ id, name }], personId, name } for the calling code. */
async function sharedInfo(request, deps) {
  const who = await identify(request, deps);
  if (who.error) return refusal(who.error);
  const libraries = deps.config.teamToken ? librariesFor(who.row, deps.config) : [];
  return json({ libraries: libraries.map(({ id, name }) => ({ id, name })), personId: who.personId, name: who.row.name });
}

/** GET /shared/<lib>/activity?limit=50 → { items: [{ ts, who, summary }] } from the branch's latest commits. */
async function activity(request, url, libId, deps) {
  const who = await identify(request, deps);
  if (who.error) return refusal(who.error);
  const lib = librariesFor(who.row, deps.config).find((l) => l.id === libId);
  if (!lib) return apiError(404, 'not_found_error', '공용 서재를 찾을 수 없습니다.');
  if (!deps.config.teamToken) return apiError(503, 'api_error', MSG.noToken);
  const limit = clampInt(url.searchParams.get('limit'), 50, 1, 100);
  const repo = new TeamRepo(lib, deps.config);
  try {
    const res = await repo.call('GET', `/commits?sha=${encodeURIComponent(lib.branch)}&per_page=${limit}`);
    if (res.status === 404 || res.status === 409) {
      await res.body?.cancel();
      return json({ items: [] });
    }
    if (res.status !== 200) throw await repo.passThrough(res);
    const list = await res.json().catch(() => null);
    const items = (Array.isArray(list) ? list : []).slice(0, limit).map((c) => {
      const { who: name, summary } = parseCommitLine(c?.commit?.message);
      return { ts: c?.commit?.committer?.date || c?.commit?.author?.date || null, who: name, summary };
    });
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
 * @typedef {{ request: Request, url: URL, deps: any, lib: import('./config.js').SharedLibrary, repo: TeamRepo,
 *             me: string, name: string, now: number }} ProxyCtx
 */

/** /shared/<lib>/gh/<sub>: only the routes of SHARED.md §2.1 on /repos/team/library; everything else is 404. */
async function proxy(request, url, libId, sub, deps) {
  const who = await identify(request, deps);
  if (who.error) return ghRefusal(who.error);
  const lib = librariesFor(who.row, deps.config).find((l) => l.id === libId);
  const m = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(sub);
  if (!lib || !m || m[1] !== PROXY_OWNER || m[2] !== PROXY_REPO) return ghError(404, MSG.notFound);
  if (!deps.config.teamToken) return ghError(503, MSG.noToken);
  const ctx = {
    request, url, deps, lib, repo: new TeamRepo(lib, deps.config), me: who.personId, name: who.row.name, now: deps.now,
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
  return json({
    sha, tree: { sha: c.tree }, parents: c.parents.map((p) => ({ sha: p })), message: scrubText(c.message),
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
  const pick = (paths) => paths.find((p) => visibleTo(p, me)) ?? null;
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
  if (await hasSharedTree(ctx.deps.env.DB, { lib: ctx.lib.id, tree: sha, person: me, since: now - RECENT_MS })) return '';
  return null;
}

/** GET git/trees/<sha>[?recursive=1]: GitHub's listing without other people's people/<id>/ entries. */
async function getTree(ctx, sha) {
  const recursive = ctx.url.searchParams.has('recursive');
  const where = await treeLocation(ctx, sha);
  if (where === null || !visibleTo(where, ctx.me)) return notFound();
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
  const tree = filterEntries(entries, where, ctx.me);
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
  if (repo.blobSize(sha) !== null) return true; // this person uploaded exactly these bytes
  if (repo.learnedBlobPaths(sha, now).some((p) => visibleTo(p, me))) return true;
  const inHead = async (head) => {
    if (head.state !== 'ok') return false;
    const index = await repo.index(head.treeSha);
    return (index?.blobs.get(sha) || []).some((p) => visibleTo(p, me));
  };
  if (await inHead(await repo.head(now))) return true;
  const head = await repo.head(now, { maxAgeMs: 0 });
  if (await inHead(head)) return true;
  // A blob of a head from the last 10 min (a file just replaced by a concurrent push that this person is still
  // reading): walk recent heads and accept the blob when it sat at a path visible to them.
  return repo.recentHead(now, RECENT_MS, async (_, commit) => {
    const index = await repo.index(commit.tree);
    return (index?.blobs.get(sha) || []).some((p) => visibleTo(p, me));
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
 * the library past its maxBytes is refused with 413 before anything is sent.
 */
async function createBlob(ctx) {
  const { request, lib, repo, now } = ctx;
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
  }
  const res = await repo.call('POST', '/git/blobs', { body: fixedLengthBody(prefix, reader, length) });
  if (res.status !== 201) throw await repo.passThrough(res);
  const data = await res.json().catch(() => null);
  if (!SHA_RE.test(data?.sha || '')) throw new UpstreamError(502, 'GitHub에서 파일 sha를 받지 못했습니다.');
  repo.rememberBlobSize(data.sha, size); // this person's own upload, for the blob-read check and the size estimate
  return json({ sha: data.sha }, 201);
}

/**
 * POST git/trees: on top of the current head's tree (or a head of the last 10 min), only allowlisted paths, deletions
 * only under people/<me>/. Remembered (D1) so POST git/commits can check the commit's parent.
 */
async function createTree(ctx) {
  const { repo, now, me, lib } = ctx;
  const body = await readJsonObject(ctx.request, MAX_TREE_BODY_BYTES);
  if (body.error) return body.error;
  const extra = Object.keys(body.value).filter((k) => k !== 'base_tree' && k !== 'tree');
  if (extra.length) return ghError(403, MSG.unknownKeys(extra));
  const { base_tree: base, tree } = body.value;
  const head = await repo.head(now, { maxAgeMs: 0 });
  if (head.state === 'empty') return ghError(409, MSG.empty);
  let baseFiles = null;
  if (head.state === 'missing') {
    if (base !== undefined) return ghError(403, MSG.noBranchBase);
  } else {
    if (typeof base !== 'string' || !SHA_RE.test(base)) return ghError(403, MSG.needBase);
    if (base !== head.treeSha && !(await repo.recentHead(now, RECENT_MS, (_, c) => c.tree === base, head))) {
      return ghError(409, MSG.staleBase);
    }
    const index = await repo.index(base);
    if (!index) return ghError(409, MSG.staleBase);
    baseFiles = index.files;
  }
  const checked = checkTreeEntries(tree, { me, baseFiles });
  if (checked.error) return ghError(403, checked.error);
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
  const libEntry = checked.entries.find((e) => e.path === LIBRARY_PATH && e.sha !== null);
  let cmp = null;
  if (libEntry) {
    const next = await loadLibrary(repo, libEntry.sha);
    if (!next.value) return ghError(422, MSG.badLibrary);
    const baseSha = baseFiles?.get(LIBRARY_PATH)?.sha;
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
  repo.rememberTreeNote(data.sha, baseFiles ? base : '', summariseBatch(checked.entries, me, cmp));
  await insertSharedTree(ctx.deps.env.DB, { lib: lib.id, tree: data.sha, base: baseFiles ? base : '', person: me, now });
  return json({ sha: data.sha, tree: filterEntries(data.tree, '', me), truncated: Boolean(data.truncated) }, 201);
}

/**
 * POST git/commits: parents = [current head] (none while the branch does not exist), the tree made here by this
 * person on top of that head's tree; message → "[<code name>] <first line>".
 */
async function createCommit(ctx) {
  const { repo, now, me, lib } = ctx;
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
    if (!(await hasSharedTree(db, { lib: lib.id, tree, base: '', person: me, since }))) return ghError(403, MSG.badTree);
  } else {
    if (parents.length !== 1) return ghError(403, MSG.badParents);
    if (parents[0] !== head.commitSha) return ghError(409, MSG.staleParent);
    if (tree !== head.treeSha && !(await hasSharedTree(db, { lib: lib.id, tree, base: head.treeSha, person: me, since }))) {
      return ghError(403, MSG.badTree);
    }
  }
  // The commit message becomes the 최근 활동 line, so a client must not label a real change (adding, deleting or
  // wiping folders/papers) as one the app hides ('논문 정보 갱신', '내 메모·AI 결과 동기화'). The Worker allows a quiet
  // summary only when the tree really is that quiet; otherwise it writes its own visible summary of the change.
  const first = scrubText(String(message ?? '').split(/\r\n|\r|\n/)[0]).trim();
  let effective = message;
  if (QUIET_SUMMARIES.has(first)) {
    const note = repo.treeNote(tree, baseKey) ?? await changeNote(ctx, tree, baseKey);
    if (!note.allowedQuiet.has(first)) effective = note.summary;
  }
  const text = commitMessageFor(ctx.name, effective);
  const res = await repo.call('POST', '/git/commits', { json: { message: text, tree, parents } });
  if (res.status !== 201) throw await repo.passThrough(res);
  const data = await res.json().catch(() => null);
  if (!SHA_RE.test(data?.sha || '')) throw new UpstreamError(502, 'GitHub에서 커밋 sha를 받지 못했습니다.');
  repo.rememberCommit(data.sha, {
    tree, parents: [...parents], message: text, date: Date.parse(data.committer?.date || '') || now,
  });
  return json({ sha: data.sha, tree: { sha: tree }, parents: parents.map((p) => ({ sha: p })), message: text }, 201);
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
    lib: ctx.lib.id, tree: commit.tree, base: '', person: ctx.me, since: ctx.now - RECENT_MS,
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
    json: { message: commitMessageFor(ctx.name, message), content, branch },
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
 * /relay/admin/shared/<lib>/stats and /purge (the caller checked the admin token). `path` is after /relay/admin.
 * @returns {Promise<Response | null>} null when the path is not a shared-library admin path
 */
export async function handleSharedAdmin(request, path, deps) {
  const m = /^\/shared\/([^/]+)\/(stats|purge)$/.exec(path);
  if (!m) return null;
  const lib = deps.config.sharedLibraries.find((l) => l.id === m[1]);
  if (!lib) return apiError(404, 'not_found_error', `공용 서재를 찾을 수 없습니다: ${m[1]}`);
  const wanted = m[2] === 'stats' ? 'GET' : 'POST';
  if (request.method !== wanted) return notAllowed(request.method);
  if (!deps.config.teamToken) return apiError(503, 'api_error', MSG.noToken);
  const repo = new TeamRepo(lib, deps.config);
  try {
    return m[2] === 'stats' ? await stats(repo, lib, deps) : await purge(repo, deps);
  } catch (err) {
    if (err instanceof UpstreamError) return apiError(err.status >= 500 ? err.status : 502, 'api_error', err.message);
    throw err;
  }
}

/** { bytes, papers, people, maxBytes }: totals of the head tree (papers = paper.pdf files, people = people/<id>/). */
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
 * were tombstoned in library.json more than 30 days ago. The tombstone records stay in library.json.
 * → { purged: [paperId], files, freedBytes, commitSha }
 */
async function purge(repo, { now }) {
  // The deletion time in a tombstone is written by a client, so it cannot by itself prove a paper has been in the
  // 휴지통 for 30 days (a back-dated deletedAt could otherwise make the next purge destroy a just-deleted paper and
  // everyone's notes on it at once). A paper is purged only when it was already tombstoned, with the same deletion
  // time, in the newest commit that is itself at least 30 days old by GitHub's commit date.
  const beforeCommit = await repo.commitBefore(now - PURGE_AFTER_MS);
  let before = null;
  if (beforeCommit) {
    const beforeIndex = await repo.index(beforeCommit.tree);
    const beforeLib = beforeIndex?.files.get(LIBRARY_PATH);
    if (beforeLib) before = (await loadLibrary(repo, beforeLib.sha)).value?.top ?? null;
  }
  const done = await deletionCommit(repo, now, async (head) => {
    const index = await repo.index(head.treeSha);
    const libraryFile = index?.files.get(LIBRARY_PATH);
    if (!index || !libraryFile) return null;
    const res = await repo.call('GET', `/git/blobs/${libraryFile.sha}`, { accept: RAW_MEDIA });
    if (res.status !== 200) throw await repo.passThrough(res);
    const library = parseJson(new Uint8Array(await res.arrayBuffer()));
    const ids = confirmedPurgeIds(library, before, now, PURGE_AFTER_MS);
    const paths = paperFiles(index.files.keys(), ids);
    if (!paths.length) return null;
    const purged = ids.filter((id) => paths.some((p) => p.startsWith(`papers/${id}/`) || p.includes(`/papers/${id}/`)));
    const freedBytes = paths.reduce((sum, p) => sum + (index.files.get(p)?.size ?? 0), 0);
    const message = `[관리자] 휴지통 비우기: 30일 지난 논문 ${purged.length}개의 파일 ${paths.length}개 삭제`;
    return { paths, message, purged, freedBytes };
  });
  if (!done) return json({ purged: [], files: 0, freedBytes: 0, commitSha: null });
  return json({ purged: done.purged, files: done.paths.length, freedBytes: done.freedBytes, commitSha: done.commitSha });
}

/**
 * One server-side commit on the library's branch that deletes the files `plan(head)` picks — `{ paths, message, … }`,
 * or null when there is nothing to delete — on top of the current head. When someone pushes in between (GitHub's 422
 * on the ref update) it starts again from the new head, at most MAX_PURGE_ATTEMPTS times. Used by the 30-day purge
 * and by code deletion. Throws UpstreamError when GitHub cannot be reached or refuses.
 * @param {TeamRepo} repo
 * @param {number} now
 * @param {(head: { commitSha: string, treeSha: string }) => Promise<{ paths: string[], message: string } | null>} plan
 * @returns {Promise<({ paths: string[], message: string, commitSha: string } & Record<string, any>) | null>}
 */
async function deletionCommit(repo, now, plan) {
  for (let attempt = 1; ; attempt++) {
    const head = await repo.head(now, { maxAgeMs: 0 });
    if (head.state !== 'ok') return null; // an empty repo or a missing branch holds no files
    const planned = await plan(head);
    if (!planned?.paths.length) return null;
    const treeRes = await repo.call('POST', '/git/trees', {
      json: { base_tree: head.treeSha, tree: planned.paths.map((path) => ({ path, mode: '100644', type: 'blob', sha: null })) },
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
 * Code deletion (index.js): remove everything under people/<id>/ of `personIds` from every library in
 * SHARED_LIBRARIES — one server-side commit per library that holds such files, with the 최근 활동 line
 * "[관리자] 초대 코드 삭제에 따라 개인 기록 정리" (no person id in it); a library without them gets no commit. Shared
 * files (library.json, papers/*) and other people's folders are never touched. Throws UpstreamError when GitHub
 * cannot be reached or refuses, so the caller keeps the code; a retry skips the libraries already cleaned.
 * Without TEAM_GITHUB_TOKEN the shared libraries are switched off (GET /shared lists none, the proxy answers 503), so
 * nothing can be stored through this Worker: nothing to remove.
 * @param {import('./index.js').Deps} deps
 * @param {string[]} personIds
 * @returns {Promise<{ files: number, commits: number }>}
 */
export async function removePersonFiles(deps, personIds) {
  const { config, now } = deps;
  if (!config.teamToken || !personIds.length) return { files: 0, commits: 0 };
  let files = 0;
  let commits = 0;
  for (const lib of config.sharedLibraries) {
    const repo = new TeamRepo(lib, config);
    const done = await deletionCommit(repo, now, async (head) => {
      const paths = await personPaths(repo, head, personIds);
      return paths.length ? { paths, message: CODE_DELETE_MESSAGE } : null;
    });
    if (done) {
      files += done.paths.length;
      commits++;
    }
  }
  return { files, commits };
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
 * library.json comparison when the batch changed it.
 * @returns {{ allowedQuiet: Set<string>, summary: string }}
 */
function summariseBatch(entries, me, cmp) {
  let libraryChanged = false;
  let translations = 0;
  let pdfs = 0;
  let loudOther = 0; // a shared change others can see that is not quiet (e.g. a path outside the layout)
  let total = 0;
  for (const e of entries) {
    total++;
    const where = classifyPath(e.path);
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
  const { repo, me } = ctx;
  const idxNew = await repo.index(treeSha);
  if (!idxNew) return { allowedQuiet: new Set(), summary: describeSharedChange({}) };
  const baseFiles = baseTreeSha ? (await repo.index(baseTreeSha))?.files ?? new Map() : new Map();
  const changed = [];
  for (const [path, f] of idxNew.files) if (baseFiles.get(path)?.sha !== f.sha) changed.push({ path, sha: f.sha });
  for (const path of baseFiles.keys()) if (!idxNew.files.has(path)) changed.push({ path, sha: null });
  let cmp = null;
  const libEntry = changed.find((e) => e.path === LIBRARY_PATH && e.sha);
  if (libEntry) {
    const next = await loadLibrary(repo, libEntry.sha);
    const baseSha = baseFiles.get(LIBRARY_PATH)?.sha;
    const baseLib = baseSha ? (await loadLibrary(repo, baseSha)).value ?? null : null;
    if (next.value) cmp = compareLibraries(baseLib, next.value);
  }
  return summariseBatch(changed, me, cmp);
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
