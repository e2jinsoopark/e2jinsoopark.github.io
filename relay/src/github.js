// The team repo on GitHub, called with the Worker's own token (TEAM_GITHUB_TOKEN; browsers never see it).
// Small per-isolate caches: commits and tree listings by sha (immutable), the branch head (briefly, revalidated with
// a conditional GET that GitHub answers 304 without counting it against the rate limit), the repo's visibility,
// the repo paths of subtrees and blobs served recently (so a client walking a truncated tree level by level can be
// filtered by path, and may read the blobs it was shown), upper bounds of the sizes of blobs uploaded here, parsed
// library.json files by blob sha, and what trees made here changed (for the commit message).

export const GITHUB_API_VERSION = '2022-11-28';
export const JSON_MEDIA = 'application/vnd.github+json';
export const RAW_MEDIA = 'application/vnd.github.raw+json';
export const USER_AGENT = 'paper-relay';
/** GitHub response headers passed back to the browser (rate limits and the ref ETag). */
export const RATE_HEADERS = ['x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset', 'x-ratelimit-used',
  'x-ratelimit-resource', 'retry-after'];

/** A head is reused this long for reads; writes always revalidate it. */
const HEAD_TTL_MS = 10_000;
const INFO_TTL_MS = 10 * 60 * 1000;
const LEARNED_TTL_MS = 10 * 60 * 1000;
const MAX_COMMITS = 500;
/** Root-tree indexes kept: the head, a tree just made on it, and a few recent heads (blob reads after a push). */
const MAX_INDEXES = 4;
const MAX_LEARNED = 20_000;
const MAX_UPLOADS = 5_000;
const MAX_LIBRARIES = 4;
const MAX_TREE_NOTES = 200;
/** At most this many commits are walked back when looking for a recent head (subrequests are limited). */
const MAX_HISTORY = 20;
const SHA_RE = /^[0-9a-f]{40}$/;

const MSG = {
  down: 'GitHub(공용 서재 저장소)에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.',
  auth: '공용 서재 서버의 GitHub 연결에 문제가 있습니다(서버 토큰 TEAM_GITHUB_TOKEN이 없거나 권한이 없습니다). 관리자에게 알려 주세요.',
  missing: '공용 서재 저장소를 찾을 수 없습니다(SHARED_LIBRARIES의 repo 또는 서버 토큰의 저장소 범위를 확인하세요). 관리자에게 알려 주세요.',
  invalid: 'GitHub에서 예상하지 못한 응답을 받았습니다. 잠시 후 다시 시도해 주세요.',
};

/**
 * A GitHub answer the proxy turns into a response: an upstream status passed through (with GitHub's message), or a
 * server-side problem (502) that is not the caller's fault.
 */
export class UpstreamError extends Error {
  constructor(status, message, headers = {}) {
    super(message);
    this.name = 'UpstreamError';
    this.status = status;
    this.headers = headers;
  }
}

/** @typedef {{ tree: string, parents: string[], date: number, message: string }} CommitInfo */
/** @typedef {{ state: 'ok', commitSha: string, treeSha: string } | { state: 'empty' } | { state: 'missing' }} Head */
/**
 * @typedef {{ entries: any[], files: Map<string, { sha: string, size: number }>, trees: Map<string, string[]>,
 *             blobs: Map<string, string[]>, bytes: number, truncated: boolean }} TreeIndex
 */

const caches = new Map();

function cacheFor(key) {
  let c = caches.get(key);
  if (!c) {
    c = {
      head: null, info: null, commits: new Map(), indexes: new Map(), learned: new Map(), learnedBlobs: new Map(),
      uploads: new Map(), libraries: new Map(), treeNotes: new Map(),
    };
    caches.set(key, c);
  }
  return c;
}

/** Map insert that drops the oldest entry beyond `max`. */
function remember(map, key, value, max) {
  map.delete(key);
  if (map.size >= max) map.delete(map.keys().next().value);
  map.set(key, value);
  return value;
}

const fresh = (at, now, ttl) => now >= at && now - at < ttl;

/** Branch name for a URL: slashes kept, everything else escaped. */
export function encodeBranch(branch) {
  return branch.split('/').map(encodeURIComponent).join('/');
}

/** A 403/429 that is GitHub's rate limit (primary or secondary), not a permission problem. */
export function isRateLimited(res) {
  if (res.status !== 403 && res.status !== 429) return false;
  return res.status === 429 || res.headers.get('x-ratelimit-remaining') === '0' || res.headers.has('retry-after');
}

/** One request's view of a shared library's repo. Cheap to create; the caches behind it are shared. */
export class TeamRepo {
  /**
   * @param {import('./config.js').SharedLibrary} lib
   * @param {{ githubApiBase: string, teamToken: string }} config
   */
  constructor(lib, config) {
    this.lib = lib;
    this.base = `${config.githubApiBase}/repos/${lib.repo}`;
    this.token = config.teamToken;
    this.cache = cacheFor(`${config.githubApiBase}\n${lib.repo}\n${lib.branch}`);
    /** Rate-limit headers of the latest GitHub answer during this request. */
    this.rate = {};
  }

  /**
   * One GitHub request (path relative to /repos/<owner>/<repo>). Only the Worker's token, the API version, Accept,
   * User-Agent, a JSON content type and If-None-Match are sent. A 401, or a 403 that is not a rate limit, means the
   * Worker's token is wrong → UpstreamError 502; every other answer is returned for the caller to interpret.
   * @param {string} method
   * @param {string} path
   * @param {{ accept?: string, json?: any, body?: BodyInit, etag?: string | null }} [opts]
   * @returns {Promise<Response>}
   */
  async call(method, path, { accept = JSON_MEDIA, json, body, etag } = {}) {
    const headers = {
      authorization: `Bearer ${this.token}`,
      accept,
      'x-github-api-version': GITHUB_API_VERSION,
      'user-agent': USER_AGENT,
    };
    let payload = body;
    if (json !== undefined) payload = JSON.stringify(json);
    if (payload !== undefined) headers['content-type'] = 'application/json';
    if (etag) headers['if-none-match'] = etag;
    let res;
    try {
      res = await fetch(`${this.base}${path}`, { method, headers, body: payload });
    } catch (err) {
      console.error('[relay] GitHub request failed', method, path, err);
      throw new UpstreamError(502, MSG.down);
    }
    const rate = {};
    for (const name of RATE_HEADERS) {
      const v = res.headers.get(name);
      if (v !== null) rate[name] = v;
    }
    if (Object.keys(rate).length) this.rate = rate;
    if (res.status === 401 || (res.status === 403 && !isRateLimited(res))) {
      console.error('[relay] GitHub refused the team token', method, path, res.status);
      await res.body?.cancel();
      throw new UpstreamError(502, MSG.auth);
    }
    return res;
  }

  /** UpstreamError carrying GitHub's own status and message (for statuses passed through to the client). */
  async passThrough(res) {
    const data = await res.json().catch(() => null);
    const message = typeof data?.message === 'string' && data.message ? data.message : `GitHub ${res.status}`;
    const headers = { ...this.rate };
    return new UpstreamError(res.status, message, headers);
  }

  /** Repo visibility, cached 10 min. @returns {Promise<{ private: boolean, visibility: string }>} */
  async info(now) {
    const c = this.cache.info;
    if (c && fresh(c.at, now, INFO_TTL_MS)) return c.value;
    const res = await this.call('GET', '');
    if (res.status === 404) {
      await res.body?.cancel();
      throw new UpstreamError(502, MSG.missing);
    }
    if (res.status !== 200) throw await this.passThrough(res);
    const data = await res.json().catch(() => null);
    if (!data || typeof data !== 'object') throw new UpstreamError(502, MSG.invalid);
    const value = { private: data.private === true, visibility: String(data.visibility ?? (data.private ? 'private' : 'public')) };
    this.cache.info = { at: now, value };
    return value;
  }

  /**
   * The branch head. `maxAgeMs: 0` revalidates (conditional GET); reads may use a head up to 10 s old.
   * @returns {Promise<Head>}
   */
  async head(now, { maxAgeMs = HEAD_TTL_MS } = {}) {
    const c = this.cache.head;
    if (c && maxAgeMs > 0 && fresh(c.at, now, maxAgeMs)) return c.value;
    const res = await this.call('GET', `/git/ref/heads/${encodeBranch(this.lib.branch)}`, { etag: c?.etag });
    if (res.status === 304 && c) {
      c.at = now;
      return c.value;
    }
    let value;
    let etag = null;
    if (res.status === 200) {
      const data = await res.json().catch(() => null);
      const sha = data?.object?.sha;
      if (!SHA_RE.test(sha || '')) throw new UpstreamError(502, MSG.invalid);
      const commit = await this.commit(sha);
      if (!commit) throw new UpstreamError(502, MSG.invalid);
      value = { state: 'ok', commitSha: sha, treeSha: commit.tree };
      etag = res.headers.get('etag');
    } else if (res.status === 409) {
      await res.body?.cancel();
      value = { state: 'empty' };
    } else if (res.status === 404) {
      await res.body?.cancel();
      await this.info(now); // a missing branch only if the repo itself is reachable
      value = { state: 'missing' };
    } else {
      throw await this.passThrough(res);
    }
    this.cache.head = { at: now, etag, value };
    return value;
  }

  /** The branch now points at `commitSha` (after a ref update or a server-side commit through this Worker). */
  async noteHead(commitSha, now) {
    const commit = await this.commit(commitSha);
    if (commit) this.cache.head = { at: now, etag: null, value: { state: 'ok', commitSha, treeSha: commit.tree } };
    else this.cache.head = null;
  }

  forgetHead() {
    this.cache.head = null;
  }

  /** A commit's tree, parents, committer date and message (cached by sha). Null when GitHub has no such commit. */
  async commit(sha) {
    const known = this.cache.commits.get(sha);
    if (known) return known;
    const res = await this.call('GET', `/git/commits/${sha}`);
    if (res.status === 404 || res.status === 422) {
      await res.body?.cancel();
      return null;
    }
    if (res.status !== 200) throw await this.passThrough(res);
    const data = await res.json().catch(() => null);
    if (!SHA_RE.test(data?.tree?.sha || '')) throw new UpstreamError(502, MSG.invalid);
    return this.rememberCommit(sha, {
      tree: data.tree.sha,
      parents: Array.isArray(data.parents) ? data.parents.map((p) => p?.sha).filter((s) => SHA_RE.test(s || '')) : [],
      date: Date.parse(data.committer?.date || data.author?.date || ''),
      message: String(data.message ?? ''),
    });
  }

  /** @param {string} sha @param {CommitInfo} info */
  rememberCommit(sha, info) {
    const map = this.cache.commits;
    if (map.size >= MAX_COMMITS) map.delete(map.keys().next().value);
    map.set(sha, info);
    return info;
  }

  /** GitHub's listing of a tree (null when there is no such tree). */
  async listing(sha, recursive) {
    const res = await this.call('GET', `/git/trees/${sha}${recursive ? '?recursive=1' : ''}`);
    if (res.status === 404 || res.status === 422) {
      await res.body?.cancel();
      return null;
    }
    if (res.status !== 200) throw await this.passThrough(res);
    const data = await res.json().catch(() => null);
    if (!data || !Array.isArray(data.tree)) throw new UpstreamError(502, MSG.invalid);
    return data;
  }

  /**
   * Every file and subtree of a root tree (one recursive listing, cached by sha): files with sizes, the paths of each
   * subtree sha, and the total size. A truncated listing (more than GitHub returns at once) gives partial totals.
   * @returns {Promise<TreeIndex | null>}
   */
  async index(treeSha) {
    const known = this.cache.indexes.get(treeSha);
    if (known) return known;
    const data = await this.listing(treeSha, true);
    if (!data) return null;
    const files = new Map();
    const trees = new Map();
    const blobs = new Map();
    let bytes = 0;
    const add = (map, sha, path) => {
      const paths = map.get(sha);
      if (paths) paths.push(path);
      else map.set(sha, [path]);
    };
    for (const e of data.tree) {
      if (!e || typeof e.path !== 'string') continue;
      if (e.type === 'blob') {
        const size = Number(e.size) || 0;
        files.set(e.path, { sha: e.sha, size });
        add(blobs, e.sha, e.path);
        bytes += size;
      } else if (e.type === 'tree') {
        add(trees, e.sha, e.path);
      }
    }
    const index = { entries: data.tree, files, trees, blobs, bytes, truncated: Boolean(data.truncated) };
    return remember(this.cache.indexes, treeSha, index, MAX_INDEXES);
  }

  /** An index already in this isolate's cache (no request), or null. */
  cachedIndex(treeSha) {
    return this.cache.indexes.get(treeSha) ?? null;
  }

  /**
   * Whether `test(commitSha, commit)` (sync or async) holds for the current head or a commit that was the head
   * within the last `windowMs`: walking first parents back from the (revalidated) head, a parent was the head
   * until its child was committed. `head`: a head just revalidated by the caller (saves a request).
   */
  async recentHead(now, windowMs, test, head = null) {
    head ??= await this.head(now, { maxAgeMs: 0 });
    if (head.state !== 'ok') return false;
    let sha = head.commitSha;
    for (let i = 0; i < MAX_HISTORY && sha; i++) {
      const commit = await this.commit(sha);
      if (!commit) return false;
      if (await test(sha, commit)) return true;
      if (!(now - commit.date <= windowMs)) return false;
      sha = commit.parents[0];
    }
    return false;
  }

  /**
   * The newest commit of the branch committed at or before `untilMs` (GitHub's commit list with `until`), or null
   * when there is none (or the repo is empty). @returns {Promise<{ sha: string, tree: string } | null>}
   */
  async commitBefore(untilMs) {
    const until = new Date(Math.max(0, untilMs)).toISOString();
    const res = await this.call('GET', `/commits?sha=${encodeURIComponent(this.lib.branch)}`
      + `&until=${encodeURIComponent(until)}&per_page=1`);
    if (res.status === 404 || res.status === 409) {
      await res.body?.cancel();
      return null;
    }
    if (res.status !== 200) throw await this.passThrough(res);
    const list = await res.json().catch(() => null);
    const c = Array.isArray(list) ? list[0] : null;
    if (!c) return null;
    const sha = c.sha;
    const tree = c.commit?.tree?.sha;
    if (!SHA_RE.test(sha || '') || !SHA_RE.test(tree || '')) throw new UpstreamError(502, MSG.invalid);
    const date = Date.parse(c.commit?.committer?.date || c.commit?.author?.date || '');
    if (Number.isFinite(date) && date > untilMs) return null; // GitHub must not hand back a newer commit
    return { sha, tree };
  }

  /**
   * Raw bytes of a blob, at most `max` bytes. @returns {Promise<{ bytes: Uint8Array } | { tooLarge: true } | null>}
   * null when GitHub has no such blob.
   */
  async blobBytes(sha, max) {
    const res = await this.call('GET', `/git/blobs/${sha}`, { accept: RAW_MEDIA });
    if (res.status === 404 || res.status === 422) {
      await res.body?.cancel();
      return null;
    }
    if (res.status !== 200) throw await this.passThrough(res);
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > max) {
      await res.body?.cancel();
      return { tooLarge: true };
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    return bytes.byteLength > max ? { tooLarge: true } : { bytes };
  }

  /** A parsed library.json by blob sha (`parse` turns the bytes into the cached value). */
  async library(sha, max, parse) {
    const known = this.cache.libraries.get(sha);
    if (known) return known;
    const read = await this.blobBytes(sha, max);
    const value = read === null ? { missing: true } : read.tooLarge ? { tooLarge: true } : parse(read.bytes);
    return remember(this.cache.libraries, sha, value, MAX_LIBRARIES);
  }

  /**
   * Whether `uploader` (a person in one library, e.g. 'team
<personId>' — never anyone else) uploaded blob `sha`
   * through this isolate. The cache is shared by every caller of the repo, so the answer is per uploader: a sha that
   * another person (or another code's library) uploaded is not "theirs".
   */
  uploadedBy(sha, uploader) {
    return Boolean(this.cache.uploads.get(sha)?.has(uploader));
  }

  /** Remember that `uploader` uploaded blob `sha` (see uploadedBy). */
  rememberUpload(sha, uploader) {
    const who = new Set(this.cache.uploads.get(sha) || []);
    who.add(uploader);
    remember(this.cache.uploads, sha, who, MAX_UPLOADS);
  }

  /** What tree `tree` changed on top of `base` (computed when it was made here), or null. */
  treeNote(tree, base) {
    return this.cache.treeNotes.get(`${tree}\n${base}`) ?? null;
  }

  rememberTreeNote(tree, base, note) {
    remember(this.cache.treeNotes, `${tree}\n${base}`, note, MAX_TREE_NOTES);
  }

  /** Record the repo paths of subtrees and blobs just shown to a client (only entries it was allowed to see). */
  learnTrees(entries, prefix, now) {
    for (const e of entries) {
      const map = e.type === 'tree' ? this.cache.learned : e.type === 'blob' ? this.cache.learnedBlobs : null;
      if (!map) continue;
      const path = prefix ? `${prefix}/${e.path}` : e.path;
      let paths = map.get(e.sha);
      if (!paths) {
        if (map.size >= MAX_LEARNED) map.delete(map.keys().next().value);
        paths = new Map();
        map.set(e.sha, paths);
      }
      paths.set(path, now);
    }
  }

  /** Repo paths at which subtree `sha` was shown recently. @returns {string[]} */
  learnedPaths(sha, now) {
    return freshPaths(this.cache.learned.get(sha), now);
  }

  /** Repo paths at which blob `sha` was shown recently (level-by-level listings). @returns {string[]} */
  learnedBlobPaths(sha, now) {
    return freshPaths(this.cache.learnedBlobs.get(sha), now);
  }
}

function freshPaths(paths, now) {
  if (!paths) return [];
  return [...paths].filter(([, at]) => fresh(at, now, LEARNED_TTL_MS)).map(([path]) => path);
}
