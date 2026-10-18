// GitHub REST client for the private data repo (Git Data API). Talks only to `apiBase`
// (https://api.github.com unless a test points it at a fake server) and only sends the token there.
import { base64ToBytes, bytesToBase64, sleep, utf8Decode, utf8Encode } from '../core/util.js';

export const DEFAULT_API_BASE = 'https://api.github.com';
const API_VERSION = '2022-11-28';
const JSON_MEDIA = 'application/vnd.github+json';
const RAW_MEDIA = 'application/vnd.github.raw+json';
const META_TIMEOUT_MS = 30_000; // metadata calls only; blob transfers may legitimately take minutes
const UPLOAD_CONCURRENCY = 3;
const BLOB_STALL_MS = 60_000; // a download that receives nothing for this long is aborted (timeout → retried)
const UPLOAD_BASE_TIMEOUT_MS = 120_000;
const UPLOAD_MIN_BYTES_PER_MS = 50; // ≈ 50 KB/s: slower uploads than this are treated as stalled
const MAX_ATTEMPTS = 3; // per request: transient 5xx / short rate-limit waits

const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;

export const README_PATH = 'README.md';
/** Root entries a data repo may contain without looking like someone else's project. */
const APP_ROOT_ENTRIES = new Set(['library.json', 'papers', 'people', 'README.md', '.gitattributes', '.gitignore', 'LICENSE', '.github']);
export const README_TEXT = `# 논문 리더 데이터 저장소

이 저장소는 **논문 리더** 앱이 자동으로 관리하는 데이터 저장소입니다.
논문 PDF, 번역, 하이라이트·메모, AI 요약이 들어 있으니 **반드시 비공개(Private)로 유지하세요.**
파일을 직접 고치거나 지우면 앱의 라이브러리가 어긋날 수 있습니다.

- \`library.json\` — 폴더와 논문 목록
- \`papers/<논문 id>/paper.pdf\` — 원문 PDF
- \`papers/<논문 id>/translation.json\` · \`annotations.json\` · \`ai.json\` — 번역, 하이라이트·메모, AI 결과

This repository is app data for "Paper Reader". Keep it private and do not edit it by hand.
`;

/**
 * Error from the GitHub API with a Korean, user-presentable `message`.
 * code: 'auth' | 'forbidden' | 'not_found' | 'rate_limit' | 'conflict' | 'empty' | 'invalid' |
 *       'too_large' | 'server' | 'network' | 'timeout' | 'config' | 'integrity' | 'unknown'
 */
export class GitHubError extends Error {
  constructor(message, { code = 'unknown', status = 0, retryAt = null, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'GitHubError';
    this.code = code;
    this.status = status;
    this.retryAt = retryAt; // epoch ms (rate limits)
  }
  /** True when retrying later can succeed without the user changing anything. */
  get transient() {
    return ['network', 'timeout', 'server', 'rate_limit'].includes(this.code);
  }
}

/** The branch moved since `parent` (PATCH ref was not a fast-forward). Re-pull, merge, retry. */
export class GitHubConflictError extends GitHubError {
  constructor(message = '다른 기기에서 먼저 저장한 변경 사항이 있습니다. 다시 받아서 합칩니다.', opts = {}) {
    super(message, { code: 'conflict', status: 422, ...opts });
    this.name = 'GitHubConflictError';
  }
}

export class GitHubClient {
  #owner;
  #repo;
  #branch;
  #token;
  #apiBase;
  #fetch;
  #rateLimitMaxWaitMs;
  #proxy;
  #refCache = null; // { etag, commitSha } — conditional GETs (304s) do not count against the rate limit
  #treeOfCommit = new Map();

  /**
   * @param {{ owner: string, repo: string, branch?: string, token: string, apiBase?: string,
   *           fetch?: typeof fetch, rateLimitMaxWaitMs?: number }} opts
   *   apiBase: test hook (fake server); defaults to https://api.github.com.
   *   rateLimitMaxWaitMs: rate-limit waits up to this long are slept through; longer ones throw.
   *   proxy: `apiBase` is the relay's GitHub-compatible proxy for the shared library (공용 서재, docs/SHARED.md
   *     §2.1) and `token` is an invite code. Korean messages from the proxy are shown as they are, a stale
   *     base_tree/parent (409/422 on POST trees/commits) is a conflict (re-pull, merge, retry), and an invalid
   *     apiBase is a configuration error — never a fallback to api.github.com (the code must not go there).
   */
  constructor({ owner, repo, branch = 'main', token, apiBase, fetch: fetchImpl, rateLimitMaxWaitMs = 60_000, proxy = false } = {}) {
    this.#owner = String(owner ?? '').trim();
    this.#repo = String(repo ?? '').trim().replace(/\.git$/i, '');
    this.#branch = String(branch || 'main').trim() || 'main';
    this.#token = String(token ?? '').trim();
    this.#proxy = Boolean(proxy);
    // No default in proxy mode: a missing relay address must never become api.github.com.
    this.#apiBase = this.#proxy ? normalizeProxyBase(apiBase) : normalizeApiBase(apiBase ?? DEFAULT_API_BASE);
    this.#fetch = fetchImpl || ((...args) => globalThis.fetch(...args));
    this.#rateLimitMaxWaitMs = rateLimitMaxWaitMs;
  }

  get owner() { return this.#owner; }
  get repo() { return this.#repo; }
  get branch() { return this.#branch; }
  get apiBase() { return this.#apiBase; }
  /** True for the shared library's relay proxy (the token is an invite code). */
  get proxy() { return this.#proxy; }
  /** Stable identity of the remote ("same repo?") — never includes the token. */
  get target() { return `${this.#apiBase}/${this.#owner}/${this.#repo}#${this.#branch}`; }

  // ------------------------------------------------------------ public API

  /**
   * Verify token, repo and permissions without changing the repo's history.
   * The full check (settings screen) also creates a 0-byte blob to prove write access — fine-grained
   * tokens report the *user's* permissions in `permissions.push`, not the token's — and looks at
   * the root for unrelated files (a likely wrong repo). `quick` (sync start) skips both.
   * @returns {Promise<{ ok: boolean, repoPrivate: boolean|null, canPush: boolean, message: string,
   *                     code?: string, empty?: boolean, branchExists?: boolean, foreign?: boolean,
   *                     defaultBranch?: string }>}
   */
  async checkAccess({ quick = false, signal } = {}) {
    const invalid = this.#configProblem();
    if (invalid) return { ok: false, repoPrivate: null, canPush: false, message: invalid };
    const name = `${this.#owner}/${this.#repo}`;
    let repo;
    let scopes;
    try {
      ({ data: repo, scopes } = await this.#request('GET', this.#repoPath(''), { signal }));
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      return { ok: false, repoPrivate: null, canPush: false, message: err.message, code: err.code };
    }
    // Only 'private' is private: an enterprise 'internal' repo is readable by every member of the enterprise.
    const visibility = repo.visibility ?? (repo.private === true ? 'private' : 'public');
    const repoPrivate = visibility === 'private';
    const perms = repo.permissions;
    let canPush = perms ? Boolean(perms.push || perms.maintain || perms.admin) : true;
    if (!repoPrivate) {
      return {
        ok: true, repoPrivate: false, canPush, visibility,
        message: visibility === 'internal'
          ? `조직 내부(Internal) 저장소입니다 (${name}). 조직의 모든 구성원이 논문 PDF·번역·메모를 볼 수 있습니다. 개인 비공개(Private) 저장소를 사용하세요.`
          : `공개(Public) 저장소입니다 (${name}). 여기에 동기화하면 논문 PDF·번역·메모가 누구에게나 공개됩니다. 비공개 저장소를 사용하세요.`,
      };
    }
    // Classic tokens (ghp_…, or any response carrying X-OAuth-Scopes) reach every repository the user can,
    // so one stolen token would expose all of them, not just this data repo.
    const broadToken = /(^|[\s,])repo([\s,]|$)/.test(scopes || '') || /^gh[op]_/.test(this.#token);

    let empty = false;
    let branchExists = true;
    let foreign = false;
    try {
      const { data: ref } = await this.#request('GET', this.#refPath(), { signal });
      if (!quick) foreign = await this.#hasForeignFiles(ref?.object?.sha, signal);
    } catch (err) {
      if (err.code === 'empty') { empty = true; branchExists = false; } else if (err.code === 'not_found') branchExists = false;
      else if (err.name === 'AbortError') throw err;
      else return { ok: false, repoPrivate, canPush, message: err.message, code: err.code };
    }

    if (canPush && !quick && !empty) {
      try {
        await this.#request('POST', this.#repoPath('/git/blobs'), { body: { content: '', encoding: 'utf-8' }, signal });
      } catch (err) {
        if (err.code === 'forbidden' || err.code === 'not_found') canPush = false;
        else if (err.code === 'empty') empty = true;
        else if (err.name === 'AbortError') throw err;
        else return { ok: false, repoPrivate, canPush, message: err.message, code: err.code };
      }
    }
    if (!canPush) {
      return {
        ok: true, repoPrivate, canPush: false, empty, branchExists,
        message: `이 토큰은 ${name} 저장소를 읽을 수만 있습니다. 토큰의 Contents 권한을 ‘Read and write’로 바꾸세요.`,
      };
    }
    const notes = [];
    if (empty) notes.push('빈 저장소 — 첫 동기화 때 README.md를 만들고 시작합니다');
    else if (!branchExists) notes.push(`‘${this.#branch}’ 브랜치가 없어 첫 동기화 때 만듭니다`);
    if (foreign) notes.push('주의: 이 저장소에는 논문 리더와 관계없는 파일이 있습니다. 논문 전용 비공개 저장소를 따로 만들어 쓰는 것을 권장합니다');
    if (broadToken) notes.push('주의: 이 토큰은 내 모든 저장소에 접근할 수 있는 Classic 토큰입니다. 이 저장소 하나만 선택한 Fine-grained 토큰(github_pat_…)으로 바꾸는 것을 권장합니다');
    return {
      ok: true, repoPrivate, canPush: true, empty, branchExists, foreign, broadToken, defaultBranch: repo.default_branch,
      message: [`연결되었습니다 · 비공개 저장소 · 쓰기 가능 (${name}, ${this.#branch} 브랜치)`, ...notes].join(' · '),
    };
  }

  /**
   * Head of the branch, or null when the repo is empty or the branch does not exist yet.
   * @returns {Promise<{ commitSha: string, treeSha: string } | null>}
   */
  async getHead({ signal } = {}) {
    this.#assertConfig();
    let commitSha;
    try {
      const res = await this.#request('GET', this.#refPath(), { etag: this.#refCache?.etag, signal });
      if (res.status === 304 && this.#refCache) {
        commitSha = this.#refCache.commitSha;
      } else {
        commitSha = res.data?.object?.sha;
        if (!commitSha) throw new GitHubError('GitHub 응답에서 브랜치 정보를 찾을 수 없습니다.', { code: 'invalid' });
        this.#refCache = res.etag ? { etag: res.etag, commitSha } : null;
      }
    } catch (err) {
      if (err.code === 'empty') { this.#refCache = null; return null; }
      if (err.code === 'not_found') {
        this.#refCache = null;
        // 404 means "no such branch" only if the repo itself is reachable.
        await this.#request('GET', this.#repoPath(''), { signal });
        return null;
      }
      throw err;
    }
    return { commitSha, treeSha: await this.#commitTree(commitSha, signal) };
  }

  /** Every blob in the tree, recursively. @returns {Promise<Map<string, { sha: string, size: number }>>} */
  async listTree(treeSha, { signal } = {}) {
    this.#assertConfig();
    const { data } = await this.#request('GET', this.#repoPath(`/git/trees/${encodeURIComponent(treeSha)}?recursive=1`), { signal });
    const out = new Map();
    if (!data.truncated) {
      for (const e of data.tree || []) if (e.type === 'blob') out.set(e.path, { sha: e.sha, size: e.size ?? 0 });
      return out;
    }
    // Huge trees come back truncated: walk them one level at a time instead.
    await this.#walkTree(treeSha, '', out, signal);
    return out;
  }

  /** Raw bytes of a blob (up to 100 MB), verified against its git sha. */
  async readBlob(sha, { signal } = {}) {
    this.#assertConfig();
    const res = await this.#request('GET', this.#repoPath(`/git/blobs/${encodeURIComponent(sha)}`), {
      accept: RAW_MEDIA, responseType: 'bytes', signal, timeoutMs: 0, stallMs: BLOB_STALL_MS,
    });
    let bytes = res.bytes;
    if ((await gitBlobSha(bytes)) === sha) return bytes;
    // Some proxies ignore the raw media type and send the JSON envelope instead.
    const envelope = parseBlobEnvelope(bytes);
    if (envelope) {
      bytes = envelope;
      if ((await gitBlobSha(bytes)) === sha) return bytes;
    }
    throw new GitHubError('GitHub에서 받은 파일이 손상되었습니다. 잠시 후 다시 시도하세요.', { code: 'integrity' });
  }

  /** Upload one blob. @returns {Promise<string>} its sha */
  async createBlob(bytes, { signal } = {}) {
    this.#assertConfig();
    const u8 = bytes instanceof Uint8Array ? bytes : utf8Encode(String(bytes));
    // Build the (possibly ~130 MB) JSON body from parts to avoid another full-size string copy.
    const body = new Blob(['{"encoding":"base64","content":"', bytesToBase64(u8), '"}'], { type: 'application/json' });
    // Upload progress cannot be observed with fetch, so bound the whole upload generously by its size.
    const timeoutMs = UPLOAD_BASE_TIMEOUT_MS + Math.ceil(body.size / UPLOAD_MIN_BYTES_PER_MS);
    const { data } = await this.#request('POST', this.#repoPath('/git/blobs'), { rawBody: body, signal, timeoutMs });
    if (!data?.sha) throw new GitHubError('GitHub에 파일을 올리지 못했습니다.', { code: 'invalid' });
    return data.sha;
  }

  /**
   * One commit on top of `parent`: blobs → tree(base_tree) → commit → PATCH ref (force:false).
   * files: [{ path, bytes?: Uint8Array, text?: string, sha?: string (already uploaded), delete?: true }];
   * passing `baseTree` (the parent's tree) saves a request when the caller already knows it.
   * With `parent: null` the branch is created (an empty repo is first bootstrapped with README.md
   * through the contents API, because the Git Data API answers 409 on empty repos).
   * @returns {Promise<{ commitSha: string, treeSha: string, blobs: Record<string, string> }>}
   * @throws {GitHubConflictError} when the branch moved (non-fast-forward)
   */
  async commit(files, message, { parent = null, baseTree = null, signal } = {}) {
    this.#assertConfig();
    let createRef = false;
    if (!parent) {
      const boot = await this.bootstrap({ signal });
      if (boot) {
        parent = boot.commitSha;
        baseTree = boot.treeSha;
      } else {
        createRef = true;
      }
    }
    if (parent && !baseTree) baseTree = await this.#commitTree(parent, signal);

    const blobs = {};
    const writes = files.filter((f) => !f.delete);
    await mapLimit(writes, UPLOAD_CONCURRENCY, async (f) => {
      const sha = f.sha || (await this.createBlob(f.bytes ?? utf8Encode(f.text ?? ''), { signal }));
      blobs[f.path] = sha;
    });
    const entries = files.map((f) => ({
      path: f.path, mode: '100644', type: 'blob', sha: f.delete ? null : blobs[f.path],
    }));
    const treeBody = baseTree ? { base_tree: baseTree, tree: entries } : { tree: entries.filter((e) => e.sha) };
    // The relay proxy accepts trees only on the current head and commits only whose parent is the head: when
    // someone else pushed meanwhile it answers 409/422 here, which (like a non-fast-forward) means re-pull.
    const staleBase = (err) => {
      if (this.#proxy && (err.status === 409 || err.status === 422)) throw new GitHubConflictError(undefined, { cause: err });
      throw err;
    };
    const { data: tree } = await this.#request('POST', this.#repoPath('/git/trees'), { body: treeBody, signal }).catch(staleBase);
    const { data: commit } = await this.#request('POST', this.#repoPath('/git/commits'), {
      body: { message, tree: tree.sha, parents: parent ? [parent] : [] }, signal,
    }).catch(staleBase);

    try {
      if (createRef) {
        await this.#request('POST', this.#repoPath('/git/refs'), { body: { ref: `refs/heads/${this.#branch}`, sha: commit.sha }, signal });
      } else {
        await this.#request('PATCH', this.#repoPath(`/git/refs/heads/${encodeBranch(this.#branch)}`), {
          body: { sha: commit.sha, force: false }, signal,
        });
      }
    } catch (err) {
      // 422 = not a fast-forward (PATCH) or the branch appeared meanwhile (POST): someone else pushed —
      // unless the branch is protected (branch protection / rulesets), which no retry can fix.
      if (err.status === 422 && /protected|rule|violat/i.test(err.ghMessage || '')) {
        throw new GitHubError(`‘${this.#branch}’ 브랜치에 보호 규칙(branch protection·ruleset)이 있어 앱이 저장할 수 없습니다. 저장소 설정에서 이 브랜치의 보호 규칙을 해제하거나, 보호되지 않은 다른 브랜치를 지정하세요.`, { code: 'protected', status: 422, cause: err });
      }
      if (err.status === 422) throw new GitHubConflictError(undefined, { cause: err });
      throw err;
    }
    this.#treeOfCommit.set(commit.sha, tree.sha);
    this.#refCache = null;
    return { commitSha: commit.sha, treeSha: tree.sha, blobs };
  }

  // -------------------------------------------------------------- internals

  #configProblem() {
    if (this.#proxy && !this.#apiBase) return '공용 서재 서버 주소가 올바르지 않습니다. 설정 → 초대 코드에서 서버 주소를 확인하세요.';
    if (this.#proxy && !this.#token) return '초대 코드가 없습니다. 설정에서 초대 코드를 입력해 주세요.';
    if (!this.#owner || !this.#repo || !this.#token) return '소유자, 저장소 이름, 토큰을 모두 입력하세요.';
    if (!OWNER_RE.test(this.#owner)) return `소유자 이름이 올바르지 않습니다: ‘${this.#owner}’ (영문·숫자·하이픈만 쓸 수 있습니다)`;
    if (!REPO_RE.test(this.#repo) || this.#repo === '.' || this.#repo === '..') return `저장소 이름이 올바르지 않습니다: ‘${this.#repo}’`;
    if (/[\s~^:?*[\\]|\.\.|^\/|\/$|\.lock$/.test(this.#branch)) return `브랜치 이름이 올바르지 않습니다: ‘${this.#branch}’`;
    return '';
  }

  #assertConfig() {
    const problem = this.#configProblem();
    if (problem) throw new GitHubError(problem, { code: 'config' });
  }

  #repoPath(suffix) {
    return `/repos/${encodeURIComponent(this.#owner)}/${encodeURIComponent(this.#repo)}${suffix}`;
  }

  #refPath() {
    return this.#repoPath(`/git/ref/heads/${encodeBranch(this.#branch)}`);
  }

  async #commitTree(commitSha, signal) {
    const known = this.#treeOfCommit.get(commitSha);
    if (known) return known;
    const { data } = await this.#request('GET', this.#repoPath(`/git/commits/${encodeURIComponent(commitSha)}`), { signal });
    const treeSha = data?.tree?.sha;
    if (!treeSha) throw new GitHubError('GitHub 응답에서 커밋 정보를 찾을 수 없습니다.', { code: 'invalid' });
    this.#treeOfCommit.set(commitSha, treeSha);
    return treeSha;
  }

  /** True when the branch's root holds files this app does not manage (a likely wrong repo). */
  async #hasForeignFiles(commitSha, signal) {
    if (!commitSha) return false;
    const treeSha = await this.#commitTree(commitSha, signal);
    const { data } = await this.#request('GET', this.#repoPath(`/git/trees/${encodeURIComponent(treeSha)}`), { signal });
    return (data.tree || []).some((e) => !APP_ROOT_ENTRIES.has(e.path));
  }

  async #walkTree(treeSha, prefix, out, signal) {
    const { data } = await this.#request('GET', this.#repoPath(`/git/trees/${encodeURIComponent(treeSha)}`), { signal });
    for (const e of data.tree || []) {
      const path = prefix ? `${prefix}/${e.path}` : e.path;
      if (e.type === 'blob') out.set(path, { sha: e.sha, size: e.size ?? 0 });
      else if (e.type === 'tree') await this.#walkTree(e.sha, path, out, signal);
    }
  }

  /**
   * Prepare a repo that has no commit on our branch yet. Empty repo → create README.md through the
   * contents API (the Git Data API answers 409 on empty repos) and return the new head. Repo without
   * our branch → null (commit with `parent: null` creates the ref). Branch exists after all →
   * GitHubConflictError (the caller re-pulls).
   * @returns {Promise<{ commitSha: string, treeSha: string } | null>}
   */
  async bootstrap({ signal } = {}) {
    this.#assertConfig();
    try {
      await this.#request('GET', this.#refPath(), { signal });
    } catch (err) {
      if (err.code === 'not_found') return null;
      if (err.code !== 'empty') throw err;
      let data;
      try {
        ({ data } = await this.#request('PUT', this.#repoPath(`/contents/${README_PATH}`), {
          body: { message: '논문 리더 데이터 저장소 시작', content: bytesToBase64(utf8Encode(README_TEXT)), branch: this.#branch },
          signal,
        }));
      } catch (putErr) {
        // Another device bootstrapped the repo a moment ago.
        if (putErr.status === 409 || putErr.status === 422) throw new GitHubConflictError(undefined, { cause: putErr });
        throw putErr;
      }
      const commitSha = data?.commit?.sha;
      const treeSha = data?.commit?.tree?.sha;
      if (!commitSha || !treeSha) throw new GitHubError('빈 저장소를 준비하지 못했습니다.', { code: 'invalid' });
      this.#treeOfCommit.set(commitSha, treeSha);
      return { commitSha, treeSha };
    }
    throw new GitHubConflictError();
  }

  /**
   * fetch wrapper: auth + API headers, Korean errors, short rate-limit waits, 5xx retries.
   * @returns {Promise<{ status: number, data?: any, bytes?: Uint8Array, etag?: string }>}
   */
  async #request(method, path, { body, rawBody, accept = JSON_MEDIA, etag, responseType = 'json', signal, timeoutMs = META_TIMEOUT_MS, stallMs = 0 } = {}) {
    const url = `${this.#apiBase}${path}`;
    for (let attempt = 1; ; attempt++) {
      const headers = {
        Accept: accept,
        Authorization: `Bearer ${this.#token}`,
        'X-GitHub-Api-Version': API_VERSION,
      };
      if (body !== undefined || rawBody) headers['Content-Type'] = 'application/json';
      if (etag) headers['If-None-Match'] = etag;
      // Blob transfers have no overall timeout (they may take minutes); a stall watchdog aborts a download
      // that stops moving (half-open connection after sleep/Wi-Fi switch), so the sync cycle cannot hang.
      const stall = stallMs ? stallWatchdog(stallMs) : null;
      const signals = [signal, timeoutMs ? AbortSignal.timeout(timeoutMs) : null, stall?.signal].filter(Boolean);
      const timeoutError = (cause) => new GitHubError('GitHub 응답이 너무 늦습니다. 인터넷 연결을 확인하세요.', { code: 'timeout', cause });
      let res;
      try {
        res = await this.#fetch(url, {
          method,
          headers,
          body: rawBody ?? (body !== undefined ? JSON.stringify(body) : undefined),
          cache: 'no-store',
          credentials: 'omit',
          referrerPolicy: 'no-referrer',
          signal: signals.length > 1 ? AbortSignal.any(signals) : signals[0],
        });
      } catch (err) {
        stall?.stop();
        if (signal?.aborted) throw signal.reason ?? err;
        if (err?.name === 'TimeoutError') throw timeoutError(err);
        throw new GitHubError('인터넷에 연결되어 있지 않거나 GitHub에 접속할 수 없습니다.', { code: 'network', cause: err });
      }

      if (res.status === 304) { stall?.stop(); return { status: 304, etag }; }
      if (res.ok) {
        const out = { status: res.status, etag: res.headers.get('etag') || undefined, scopes: res.headers.get('x-oauth-scopes') };
        try {
          if (responseType === 'bytes') out.bytes = await readBytes(res, stall);
          else out.data = res.status === 204 ? null : await res.json().catch(() => null);
        } catch (err) {
          if (signal?.aborted) throw signal.reason ?? err;
          if (err?.name === 'TimeoutError') throw timeoutError(err);
          throw new GitHubError('GitHub에서 파일을 받는 중 연결이 끊어졌습니다.', { code: 'network', cause: err });
        } finally {
          stall?.stop();
        }
        return out;
      }
      stall?.stop();

      const errBody = await res.json().catch(() => null);
      const err = this.#errorFor(res, errBody, method, path);
      err.ghMessage = String(errBody?.message || '');
      console.warn('[store] GitHub', method, path, res.status, errBody?.message || '');
      if (attempt < MAX_ATTEMPTS) {
        if (err.code === 'rate_limit' && err.retryAt - Date.now() <= this.#rateLimitMaxWaitMs) {
          await sleepUnlessAborted(Math.max(0, err.retryAt - Date.now()) + 250, signal);
          continue;
        }
        if (err.code === 'server') {
          await sleepUnlessAborted(attempt * 1000, signal);
          continue;
        }
      }
      throw err;
    }
  }

  #errorFor(res, body, method, path) {
    const status = res.status;
    const ghMessage = String(body?.message || '');
    const name = `${this.#owner}/${this.#repo}`;
    const rate = rateLimitInfo(res, ghMessage);
    if (rate) {
      const t = new Date(rate.retryAt);
      const at = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
      return new GitHubError(`GitHub 요청 한도를 넘었습니다. ${at} 이후에 자동으로 다시 동기화합니다.`, { code: 'rate_limit', status, retryAt: rate.retryAt });
    }
    if (this.#proxy) return this.#proxyError(status, ghMessage, method, path);
    switch (status) {
      case 401:
        return new GitHubError('GitHub 토큰이 올바르지 않거나 만료되었습니다. 설정에서 새 토큰을 입력하세요.', { code: 'auth', status });
      case 403:
        if (method === 'GET') {
          return new GitHubError(`이 토큰으로는 ${name} 저장소에 접근할 수 없습니다 (403). 토큰의 저장소 접근 범위와 조직의 SSO 승인을 확인하세요.`, { code: 'forbidden', status });
        }
        return new GitHubError(`이 토큰으로는 ${name} 저장소에 쓸 수 없습니다. 토큰이 이 저장소를 포함하고 Contents 권한이 ‘Read and write’인지 확인하세요.`, { code: 'forbidden', status });
      case 404:
        if (/\/git\/ref\//.test(path) && method === 'GET') return new GitHubError(`‘${this.#branch}’ 브랜치를 찾을 수 없습니다.`, { code: 'not_found', status });
        return new GitHubError(`저장소 ${name}을(를) 찾을 수 없거나 이 토큰으로 접근할 수 없습니다. 소유자·저장소 이름과 토큰의 저장소 접근 범위를 확인하세요.`, { code: 'not_found', status });
      case 409:
        return new GitHubError('저장소가 비어 있습니다.', { code: 'empty', status });
      case 413:
        return new GitHubError('파일이 너무 커서 GitHub에 올릴 수 없습니다 (최대 100 MB).', { code: 'too_large', status });
      case 422:
        return new GitHubError(`GitHub가 요청을 거부했습니다: ${ghMessage || '처리할 수 없는 요청'}`, { code: 'invalid', status });
      default:
        if (status >= 500) return new GitHubError('GitHub 서버에 일시적인 문제가 있습니다. 잠시 후 자동으로 다시 시도합니다.', { code: 'server', status });
        return new GitHubError(`GitHub 요청에 실패했습니다 (${status}).`, { code: 'unknown', status });
    }
  }

  /** Errors from the relay proxy (공용 서재): its Korean messages are shown as they are. */
  #proxyError(status, ghMessage, method, path) {
    const korean = /[가-힣]/.test(ghMessage) ? ghMessage : '';
    const make = (fallback, code) => new GitHubError(korean || fallback, { code, status });
    switch (status) {
      case 401:
        return make('초대 코드가 올바르지 않거나 사용이 중지되었습니다. 설정에서 초대 코드를 확인하세요.', 'auth');
      case 403:
        return make(method === 'GET' ? '이 초대 코드로는 공용 서재를 열 수 없습니다.' : '공용 서재에 이 변경을 저장할 수 없습니다 (403).', 'forbidden');
      case 404:
        if (/\/git\/ref\//.test(path) && method === 'GET') return make(`공용 서재의 ‘${this.#branch}’ 브랜치를 찾을 수 없습니다.`, 'not_found');
        return make('공용 서재를 찾을 수 없습니다. 초대 코드 서버가 공용 서재를 지원하는지 확인하세요.', 'not_found');
      case 409:
        return make('공용 서재 저장소가 비어 있습니다.', 'empty');
      case 413:
        return make('파일이 너무 커서 공용 서재에 올릴 수 없습니다.', 'too_large');
      case 422:
        return make(`공용 서재 서버가 요청을 거부했습니다: ${ghMessage || '처리할 수 없는 요청'}`, 'invalid');
      default:
        if (status >= 500) return make('공용 서재 서버에 일시적인 문제가 있습니다. 잠시 후 자동으로 다시 시도합니다.', 'server');
        return make(`공용 서재 요청에 실패했습니다 (${status}).`, 'unknown');
    }
  }
}

// ------------------------------------------------------------------ helpers

/** git's blob id: sha1("blob <len>\0" + content), hex. */
export async function gitBlobSha(bytes) {
  const header = utf8Encode(`blob ${bytes.byteLength}\0`);
  const buf = new Uint8Array(header.byteLength + bytes.byteLength);
  buf.set(header, 0);
  buf.set(bytes, header.byteLength);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-1', buf));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Rate-limit detection: primary (x-ratelimit-remaining: 0) and secondary (retry-after / message). */
function rateLimitInfo(res, ghMessage) {
  if (res.status !== 403 && res.status !== 429) return null;
  const retryAfter = Number(res.headers.get('retry-after'));
  const remaining = res.headers.get('x-ratelimit-remaining');
  const reset = Number(res.headers.get('x-ratelimit-reset'));
  if (Number.isFinite(retryAfter) && retryAfter > 0) return { retryAt: Date.now() + retryAfter * 1000 };
  if (remaining === '0' && Number.isFinite(reset) && reset > 0) return { retryAt: Math.max(Date.now(), reset * 1000) };
  if (res.status === 429 || /rate limit/i.test(ghMessage)) return { retryAt: Date.now() + 60_000 };
  return null;
}

function parseBlobEnvelope(bytes) {
  if (bytes.byteLength < 2 || bytes[0] !== 0x7b) return null; // '{'
  try {
    const obj = JSON.parse(utf8Decode(bytes));
    if (obj && obj.encoding === 'base64' && typeof obj.content === 'string') return base64ToBytes(obj.content);
  } catch { /* not an envelope */ }
  return null;
}

/** Keep the slashes of a branch like "feature/x" but escape everything else. */
function encodeBranch(branch) {
  return branch.split('/').map(encodeURIComponent).join('/');
}

/**
 * The relay proxy base (e.g. https://relay.example/shared/team/gh): https or loopback http, no query, fragment
 * or credentials; '' when invalid (a configuration error — never replaced by api.github.com).
 */
function normalizeProxyBase(apiBase) {
  const raw = String(apiBase || '').trim().replace(/\/+$/, '');
  try {
    const u = new URL(raw);
    const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
    const github = /(^|\.)github\.com$/i.test(u.hostname); // the relay, never GitHub itself
    if (!github && (u.protocol === 'https:' || (u.protocol === 'http:' && loopback)) && !u.search && !u.hash && !u.username && !u.password) return raw;
  } catch { /* fall through */ }
  console.warn('[store] invalid shared-library proxy address', raw);
  return '';
}

/** https only, except loopback (local fake server in tests). */
function normalizeApiBase(apiBase) {
  const raw = String(apiBase || DEFAULT_API_BASE).trim().replace(/\/+$/, '');
  try {
    const u = new URL(raw);
    const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
    if (u.protocol === 'https:' || (u.protocol === 'http:' && loopback)) return raw;
  } catch { /* fall through */ }
  console.warn('[store] ignoring invalid GitHub apiBase', raw);
  return DEFAULT_API_BASE;
}

/** An AbortSignal that fires (TimeoutError) when `kick()` has not been called for `ms`. */
function stallWatchdog(ms) {
  const ac = new AbortController();
  let timer = null;
  const kick = () => {
    clearTimeout(timer);
    timer = setTimeout(() => ac.abort(new DOMException('GitHub 전송이 멈췄습니다.', 'TimeoutError')), ms);
  };
  kick();
  return { signal: ac.signal, kick, stop: () => clearTimeout(timer) };
}

/** Response body as bytes; every chunk resets the stall watchdog. */
async function readBytes(res, stall) {
  if (!stall || !res.body?.getReader) return new Uint8Array(await res.arrayBuffer());
  stall.kick();
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    stall.kick();
    chunks.push(value);
    size += value.byteLength;
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.byteLength; }
  return out;
}

async function sleepUnlessAborted(ms, signal) {
  if (!signal) return sleep(ms);
  if (signal.aborted) throw signal.reason;
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(t); reject(signal.reason); };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** Run `fn` over `items` with at most `limit` in flight; rejects on the first failure. */
export async function mapLimit(items, limit, fn) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}
