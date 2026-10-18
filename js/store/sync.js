// Local-first sync engine. Every write lands in IndexedDB immediately and marks its path dirty;
// a debounced push commits all dirty paths in one commit. Pull on start, on focus and every 2 min.
// Concurrent edits are merged per file kind (see MERGERS); non-fast-forward pushes re-pull and retry.
import { emit } from '../core/bus.js';
import { sleep, uid, utf8Decode, utf8Encode } from '../core/util.js';
import { db as defaultDb, DELETE } from './db.js';
import { GitHubClient, GitHubConflictError, GitHubError, README_PATH, README_TEXT, gitBlobSha, mapLimit } from './github.js';
import { deepEqual, mergeAi, mergeAnnotations, mergeLibrary, mergeRecords, mergeTranslation, toMillis } from './merge.js';

export { deepEqual, mergeAi, mergeAnnotations, mergeLibrary, mergeRecords, mergeTranslation, toMillis };

const PUSH_DELAY_MS = 3_000;
const PUSH_MAX_DELAY_MS = 30_000; // continuous writes (e.g. a running translation) still push this often
const PULL_INTERVAL_MS = 120_000;
const FOCUS_PULL_MIN_GAP_MS = 15_000;
const RETRY_DELAYS_MS = [5_000, 15_000, 30_000, 60_000, 120_000];
const MAX_CONFLICT_RETRIES = 4;
const TRANSFER_CONCURRENCY = 3;
const COMMIT_BATCH_BYTES = 48 * 1024 * 1024;
const LOCK_NAME = 'paper-reader-sync';
const VERIFY_EVERY_MS = 10 * 60_000; // re-check that the repo is still private while a tab stays open
const VERIFY_BEFORE_PUSH_MS = 60_000; // …and shortly before uploading anything
// 'dirty' index values: 1 = waiting to be pushed, 2 = GitHub refused the upload (kept locally, not retried
// until the file is written again or the user syncs by hand).
const PENDING = 1;
const REJECTED = 2;

const CHANNEL_NAME = 'paper-reader-sync';
const META_KEY = 'remote';
const LIBRARY_PATH = 'library.json';

/**
 * A row of the 'files' store.
 * @typedef {{
 *   path: string,
 *   data: string | Uint8Array | null,  // null for a pending delete
 *   dirty?: 1,                          // only while waiting to be pushed (indexed)
 *   deleted?: true,                     // pending delete
 *   baseSha: string | null,             // remote blob this content descends from
 *   base?: string,                      // that blob's text, kept while dirty, for 3-way merges
 *   wid?: string,                       // id of the local write that produced `data`
 *   mtime: number,
 * }} FileRecord
 *
 * Last known remote state ('meta' store, key 'remote').
 * @typedef {{ target: string, commitSha: string|null, treeSha: string|null,
 *             tree: Record<string, { sha: string, size: number }>, lastSyncAt: number|null }} RemoteMeta
 */

export class SyncEngine extends EventTarget {
  #db;
  #getConfig;
  #createClient;
  #opts;
  #id = uid('sync');
  #status = { state: 'disabled', message: '', pending: 0, rejected: 0, lastSyncAt: null };
  #client = null;
  #running = false;
  #verified = false;
  #verifiedAt = 0;
  #fatal = false;
  #cycle = null;
  #again = false;
  #abort = null;
  #pushTimer = null;
  #firstDirtyAt = null;
  #retryTimer = null;
  #failures = 0;
  #interval = null;
  #lastPullAt = 0;
  #meta = null; // cached RemoteMeta (invalidated by other tabs)
  #inflight = new Map(); // `${path}\n${sha}` → Promise (remote reads)
  #uploaded = new Map(); // `${target}\n${path}\n${wid}` → blob sha (skip re-uploads on retry)
  #channel = null;
  #listeners = [];

  /**
   * @param {{ db?: typeof defaultDb, getConfig: () => ({ owner, repo, branch?, token, apiBase? } | null),
   *           createClient?: (cfg) => GitHubClient, pushDelayMs?: number, pushMaxDelayMs?: number,
   *           pullIntervalMs?: number, retryDelaysMs?: number[] }} opts
   */
  constructor({ db = defaultDb, getConfig, createClient = (cfg) => new GitHubClient(cfg), ...opts } = {}) {
    super();
    this.#db = db;
    this.#getConfig = getConfig || (() => null);
    this.#createClient = createClient;
    this.#opts = {
      pushDelayMs: opts.pushDelayMs ?? PUSH_DELAY_MS,
      pushMaxDelayMs: opts.pushMaxDelayMs ?? PUSH_MAX_DELAY_MS,
      pullIntervalMs: opts.pullIntervalMs ?? PULL_INTERVAL_MS,
      retryDelaysMs: opts.retryDelaysMs ?? RETRY_DELAYS_MS,
    };
  }

  /** @returns {{ state: 'disabled'|'idle'|'syncing'|'error'|'offline', message: string, pending: number, lastSyncAt: number|null }} */
  get status() { return { ...this.#status }; }

  // -------------------------------------------------------------- lifecycle

  async start() {
    if (this.#running) return;
    this.#running = true;
    this.#openChannel();
    const meta = await this.#loadMeta();
    this.#status.lastSyncAt = meta?.lastSyncAt ?? null;
    await this.#refreshPending({ silent: true });

    const cfg = this.#getConfig() || {};
    if (!(cfg.owner && cfg.repo && cfg.token)) {
      this.#setStatus({ state: 'disabled', message: '' });
      return;
    }
    this.#client = this.#createClient({ ...cfg });
    this.#verified = false;
    this.#fatal = false;
    this.#failures = 0;
    this.#setStatus({ state: 'idle', message: '' });
    this.#installListeners();
    this.#interval = setInterval(() => this.#trigger('interval'), this.#opts.pullIntervalMs);
    this.#trigger('start');
  }

  stop() {
    this.#running = false;
    this.#client = null;
    this.#abort?.abort(new DOMException('동기화를 멈췄습니다.', 'AbortError'));
    clearTimeout(this.#pushTimer);
    clearTimeout(this.#retryTimer);
    clearInterval(this.#interval);
    this.#pushTimer = this.#retryTimer = this.#interval = null;
    this.#firstDirtyAt = null;
    for (const off of this.#listeners) off();
    this.#listeners = [];
    this.#channel?.close();
    this.#channel = null;
    this.#setStatus({ state: 'disabled', message: '' });
  }

  /** Apply new settings.github: stop, then start against the (possibly different) repo. */
  async reconfigure() {
    const previous = this.#cycle;
    this.stop();
    await previous?.catch(() => {});
    await this.start();
  }

  /** Pull + push now. Never rejects for sync failures — they are reported through `status`. */
  async syncNow() {
    if (!this.#client) return this.status;
    this.#fatal = false; // the user may have fixed the cause (token, permissions) on GitHub
    await this.#retryRejected();
    await this.#runCycle('manual');
    return this.status;
  }

  /**
   * Would applying `cfg` point sync at a different repository than the one this device's data came from?
   * Returns `{ from, to, localFiles }` (targets as GitHubClient.target strings) or null. The settings screen
   * asks the user before uploading the local library to a new repository; passing `to` back as
   * `cfg.carryOver` is that consent. Without it the engine refuses to upload to the new repo.
   */
  async targetChange(cfg) {
    if (!(cfg?.owner && cfg?.repo && cfg?.token)) return null;
    const to = this.#createClient({ ...cfg }).target;
    const meta = await this.#loadMeta();
    if (!meta?.target || meta.target === to) return null;
    const localFiles = await this.#db.count('files');
    return localFiles ? { from: meta.target, to, localFiles } : null;
  }

  /** Push pending writes right away (page hidden / closing). */
  async flush() {
    if (!this.#client || this.#fatal) return;
    if (!this.#pushTimer && !this.#status.pending) return;
    clearTimeout(this.#pushTimer);
    this.#pushTimer = null;
    this.#firstDirtyAt = null;
    await this.#runCycle('flush');
  }

  // ----------------------------------------------------------------- files

  /**
   * Local copy first; otherwise the remote blob (downloaded once and cached in IndexedDB).
   * `local: true` never touches the network.
   */
  async readFile(path, { as = defaultAs(path), local = false } = {}) {
    const rec = await this.#db.get('files', path);
    if (rec && (rec.deleted || local || rec.dirty || !isTextPath(path))) return rec.deleted ? null : decode(rec.data, as, path);
    const entry = local ? null : (await this.#currentMeta())?.tree?.[path];
    if (rec) {
      // A clean copy older than the remote (a download that raced a pull): refresh it, or keep it offline.
      if (entry && rec.baseSha && entry.sha !== rec.baseSha) {
        try {
          return decode(await this.#fetchRemote(path, entry.sha), as, path);
        } catch (err) {
          console.warn('[store] refreshing a stale local copy failed; using it', path, err);
        }
      }
      return decode(rec.data, as, path);
    }
    if (!entry) return null;
    return decode(await this.#fetchRemote(path, entry.sha), as, path);
  }

  /**
   * Store locally and mark dirty. JSON files with a merge rule are merged with what is already
   * stored (another tab may have written it), so a stale writer cannot drop records. `base` (optional) is
   * the version the caller's object was derived from: with it the merge is 3-way, so fields only the stored
   * copy changed (a pull, another tab) are kept even when the caller's items carry the same or newer stamps.
   * @returns {Promise<any>} what is now stored (the merged object for mergeable JSON)
   */
  async writeFile(path, value, { base = null } = {}) {
    let data = encode(value);
    const mergeBase = base && typeof base === 'object' ? base : null;
    const merger = mergerFor(path);
    const wid = uid('w');
    let merged = null;
    let wrote = false;
    await this.#db.update('files', path, (rec) => {
      merged = null;
      wrote = false;
      let next = data;
      if (merger && typeof data === 'string' && rec && !rec.deleted && typeof rec.data === 'string') {
        const incoming = parseJson(data);
        const existing = parseJson(rec.data);
        if (incoming && existing) {
          const m = merger(incoming, existing, mergeBase);
          if (!deepEqual(m, incoming)) { merged = m; next = stringify(m); }
        }
      }
      if (rec && !rec.deleted && typeof next === 'string' && rec.data === next) return undefined; // no-op write
      wrote = true;
      return dirtyRecord(rec, path, next, wid);
    });
    data = null;
    if (wrote) await this.#afterLocalWrite([path]);
    if (merged) {
      emit(this, 'remotechange', { paths: [path], origin: 'merge' });
      return merged;
    }
    return value;
  }

  async deleteFile(path) {
    const remote = (await this.#currentMeta())?.tree?.[path] ?? null;
    let changed = false;
    await this.#db.update('files', path, (rec) => {
      if (rec?.deleted) return undefined;
      const baseSha = rec ? rec.baseSha : remote?.sha ?? null;
      if (!baseSha && !remote) {
        changed = Boolean(rec);
        return rec ? DELETE : undefined; // never left this device: nothing to propagate
      }
      changed = true;
      return { path, data: null, deleted: true, dirty: 1, baseSha, wid: uid('w'), mtime: Date.now() };
    });
    if (changed) await this.#afterLocalWrite([path]);
  }

  /** Paths under `prefix` that exist locally or remotely (pending local deletes included). */
  async listPaths(prefix) {
    const local = await this.#db.keys('files', IDBKeyRange.bound(prefix, `${prefix}\uffff`));
    const tree = (await this.#currentMeta())?.tree || {};
    const remote = Object.keys(tree).filter((p) => p.startsWith(prefix));
    return [...new Set([...local, ...remote])].sort();
  }

  // ------------------------------------------------------------- scheduling

  async #afterLocalWrite(paths) {
    this.#post({ type: 'write', paths });
    await this.#refreshPending();
    this.#schedulePush();
  }

  #schedulePush() {
    if (!this.#client || this.#fatal || !this.#status.pending) return;
    const now = Date.now();
    this.#firstDirtyAt ??= now;
    const due = Math.min(now + this.#opts.pushDelayMs, this.#firstDirtyAt + this.#opts.pushMaxDelayMs);
    clearTimeout(this.#pushTimer);
    this.#pushTimer = setTimeout(() => {
      this.#pushTimer = null;
      this.#firstDirtyAt = null;
      this.#trigger('push');
    }, Math.max(0, due - now));
  }

  /** Background trigger; errors end up in `status`, never as rejections. */
  #trigger(reason) {
    if (!this.#client || this.#fatal) return;
    const opportunistic = reason === 'interval' || reason === 'focus';
    if (opportunistic) {
      const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
      if (hidden && !this.#status.pending) return;
      if (reason === 'focus') {
        // 'focus' and 'visibilitychange' arrive together; pull once.
        if (Date.now() - this.#lastPullAt < FOCUS_PULL_MIN_GAP_MS) return;
        this.#lastPullAt = Date.now();
      }
    }
    if (reason === 'push' && typeof navigator !== 'undefined' && navigator.onLine === false) {
      this.#setStatus({ state: 'offline', message: '인터넷에 연결되어 있지 않습니다. 연결되면 자동으로 동기화합니다.' });
      return;
    }
    this.#runCycle(reason).catch((err) => console.warn('[store] sync cycle', err));
  }

  #runCycle(reason) {
    if (this.#cycle) {
      this.#again = true;
      return this.#cycle;
    }
    this.#cycle = (async () => {
      try {
        let r = reason;
        do {
          this.#again = false;
          await this.#cycleOnce(r);
          r = 'again';
        } while (this.#again && this.#client && !this.#fatal);
      } finally {
        this.#cycle = null;
      }
    })();
    return this.#cycle;
  }

  async #cycleOnce(reason) {
    const client = this.#client;
    if (!client) return;
    clearTimeout(this.#retryTimer);
    this.#retryTimer = null;
    const ac = new AbortController();
    this.#abort = ac;
    const run = async () => {
      if (client !== this.#client) return;
      // A background pull that finds nothing new should not flash "동기화 중" every two minutes.
      const quiet = (reason === 'interval' || reason === 'focus') && !this.#status.pending && this.#status.state === 'idle';
      if (!quiet) this.#setStatus({ state: 'syncing' });
      try {
        const sinceVerify = Date.now() - this.#verifiedAt;
        if (!this.#verified || sinceVerify > (this.#status.pending ? VERIFY_BEFORE_PUSH_MS : VERIFY_EVERY_MS)) {
          await this.#verify(client, ac.signal);
          this.#verified = true;
          this.#verifiedAt = Date.now();
        }
        for (let attempt = 1; ; attempt++) {
          try {
            let meta = await this.#pull(client, ac.signal);
            if (!meta.commitSha && (await this.#db.count('files', 'dirty', IDBKeyRange.only(PENDING))) && (await client.bootstrap({ signal: ac.signal }))) {
              meta = await this.#pull(client, ac.signal); // empty repo: README.md commit first, data on top
            }
            await this.#push(client, meta, ac.signal);
            break;
          } catch (err) {
            if (!(err instanceof GitHubConflictError) || attempt >= MAX_CONFLICT_RETRIES) throw err;
            console.warn('[store] push was not a fast-forward; pulling again', attempt);
            await sleep(150 * attempt + Math.random() * 250);
          }
        }
        this.#failures = 0;
        const lastSyncAt = Date.now();
        await this.#updateMeta((m) => ({ ...m, lastSyncAt }));
        this.#post({ type: 'meta' });
        this.#setStatus({ state: 'idle', message: '', lastSyncAt });
      } catch (err) {
        if (ac.signal.aborted || client !== this.#client) return;
        this.#onCycleError(err);
      } finally {
        if (this.#abort === ac) this.#abort = null;
        await this.#refreshPending();
      }
    };
    // One tab syncs at a time; background pulls skip when another tab is already syncing.
    const opportunistic = reason === 'interval' || reason === 'focus';
    await withLock(run, { wait: !opportunistic });
    if (this.#client && this.#status.pending && this.#status.state === 'idle' && !this.#pushTimer) this.#schedulePush();
  }

  #onCycleError(err) {
    const code = err?.code || '';
    const korean = /[가-힣]/.test(err?.message || '');
    const message = korean ? err.message : `동기화하지 못했습니다: ${err?.message || err}`;
    console.warn('[store] sync failed', code, err);
    if (code === 'network' || code === 'timeout') {
      this.#setStatus({ state: 'offline', message });
      this.#scheduleRetry();
    } else if (err instanceof GitHubError && err.transient) {
      this.#setStatus({ state: 'error', message });
      this.#scheduleRetry(err.retryAt);
    } else if (code === 'conflict' || code === 'integrity') {
      this.#setStatus({ state: 'error', message: '다른 기기의 변경 사항과 합치지 못했습니다. 잠시 후 다시 시도합니다.' });
      this.#scheduleRetry();
    } else {
      // Token, permission, repo or data problems: retrying will not help until the user acts.
      this.#fatal = true;
      this.#verified = false;
      this.#setStatus({ state: 'error', message });
    }
  }

  #scheduleRetry(retryAt = null) {
    const delays = this.#opts.retryDelaysMs;
    const delay = retryAt ? Math.max(1_000, retryAt - Date.now()) : delays[Math.min(this.#failures, delays.length - 1)];
    this.#failures++;
    clearTimeout(this.#retryTimer);
    this.#retryTimer = setTimeout(() => { this.#retryTimer = null; this.#trigger('retry'); }, delay);
  }

  #installListeners() {
    if (typeof window === 'undefined') return;
    const on = (target, type, fn) => {
      target.addEventListener(type, fn);
      this.#listeners.push(() => target.removeEventListener(type, fn));
    };
    on(window, 'focus', () => this.#trigger('focus'));
    on(window, 'online', () => {
      if (this.#status.state === 'offline' || this.#status.pending) this.#trigger('online');
    });
    on(window, 'offline', () => {
      if (this.#status.state !== 'error') this.#setStatus({ state: 'offline', message: '인터넷에 연결되어 있지 않습니다. 연결되면 자동으로 동기화합니다.' });
    });
    on(document, 'visibilitychange', () => {
      if (document.visibilityState === 'hidden') this.flush().catch(() => {});
      else this.#trigger('focus');
    });
    on(window, 'pagehide', () => { this.flush().catch(() => {}); });
  }

  // ---------------------------------------------------------- sync passes

  async #verify(client, signal) {
    const r = await client.checkAccess({ quick: true, signal });
    if (!r.ok) throw new GitHubError(r.message, { code: r.code || 'access' });
    if (r.repoPrivate === false) {
      const kind = r.visibility === 'internal' ? '조직 내부(Internal)' : '공개(Public)';
      throw new GitHubError(`${kind} 저장소에는 동기화하지 않습니다. 논문과 메모가 다른 사람에게 보일 수 있어 동기화를 멈췄습니다. 설정에서 비공개(Private) 저장소를 지정하세요.`, { code: 'public' });
    }
    if (r.canPush === false) throw new GitHubError(r.message, { code: 'forbidden' });
  }

  /** The user asked to sync by hand: give uploads GitHub refused earlier another chance. */
  async #retryRejected() {
    const rejected = await this.#db.indexKeys('files', 'dirty', IDBKeyRange.only(REJECTED));
    for (const path of rejected) {
      await this.#db.update('files', path, (rec) => (rec?.dirty === REJECTED ? { ...rec, dirty: PENDING, rejected: undefined } : undefined));
    }
    if (rejected.length) await this.#refreshPending();
  }

  /** Bring local files up to the remote head, merging into pending local edits. */
  async #pull(client, signal) {
    let meta = await this.#prepareMeta(client.target);
    const head = await client.getHead({ signal });
    this.#lastPullAt = Date.now();
    if (!head) {
      if (meta.commitSha) {
        // The branch vanished (deleted or the repo was emptied): re-upload everything this device has.
        console.warn('[store] remote branch is gone; re-pushing local data');
        await this.#rebaseAllLocal(meta.tree);
        meta = await this.#updateMeta((m) => ({ ...m, commitSha: null, treeSha: null, tree: {} }));
      }
      return meta;
    }
    if (head.commitSha === meta.commitSha) return meta;

    this.#setStatus({ state: 'syncing' });
    const tree = Object.fromEntries(
      [...(await client.listTree(head.treeSha, { signal }))].map(([p, v]) => [p, { sha: v.sha, size: v.size }]));
    const changed = [...new Set([...Object.keys(meta.tree), ...Object.keys(tree)])]
      .filter((p) => meta.tree[p]?.sha !== tree[p]?.sha);
    const notify = [];
    await mapLimit(changed, TRANSFER_CONCURRENCY, async (path) => {
      if (await this.#applyRemote(client, path, tree[path]?.sha ?? null, signal)) notify.push(path);
    });
    meta = await this.#updateMeta((m) => ({ ...m, commitSha: head.commitSha, treeSha: head.treeSha, tree }));
    await this.#gcBlobs(tree);
    if (notify.length) {
      notify.sort();
      emit(this, 'remotechange', { paths: notify, origin: 'remote' });
      this.#post({ type: 'write', paths: notify });
    }
    this.#post({ type: 'meta' });
    return meta;
  }

  /**
   * Reconcile one path with remote blob `sha` (null = deleted remotely).
   * @returns {Promise<boolean>} whether what readFile() returns for the path changed
   */
  async #applyRemote(client, path, sha, signal) {
    const merger = mergerFor(path);
    const text = isTextPath(path);
    for (let attempt = 0; attempt < 3; attempt++) {
      const rec = await this.#db.get('files', path);
      if (sha && rec?.baseSha === sha) return false;
      const needText = Boolean(sha && text && (rec ? !rec.deleted && (!rec.dirty || merger) : path === LIBRARY_PATH));
      const remoteText = needText ? utf8Decode(await client.readBlob(sha, { signal })) : null;

      let changed = false;
      let retry = false;
      await this.#db.update('files', path, (cur) => {
        changed = false;
        retry = false;
        if (!sha) { // deleted remotely
          if (!cur) { changed = true; return undefined; }
          if (cur.deleted || !cur.dirty) { changed = !cur.deleted; return DELETE; }
          return { ...cur, baseSha: null, base: undefined }; // local edit recreates it
        }
        if (cur?.baseSha === sha) return undefined;
        if (!cur) {
          changed = true; // lazy: readFile() will fetch the new blob on demand
          return remoteText != null && path === LIBRARY_PATH ? cleanRecord(path, remoteText, sha) : undefined;
        }
        if (cur.deleted) return { ...cur, baseSha: sha }; // a local delete wins
        if (!cur.dirty) {
          if (remoteText == null) { changed = true; return text ? (retry = true, undefined) : DELETE; }
          changed = cur.data !== remoteText;
          return cleanRecord(path, remoteText, sha);
        }
        if (!merger || typeof cur.data !== 'string') return { ...cur, baseSha: sha, base: undefined }; // local wins
        if (remoteText == null) { retry = true; return undefined; }
        const local = parseJson(cur.data);
        const remote = parseJson(remoteText);
        if (!remote) return { ...cur, baseSha: sha, base: undefined };
        if (!local) { changed = true; return cleanRecord(path, remoteText, sha); }
        const merged = merger(local, remote, cur.base != null ? parseJson(cur.base) : null);
        changed = !deepEqual(merged, local);
        if (deepEqual(merged, remote)) return cleanRecord(path, remoteText, sha);
        return { ...cur, data: stringify(merged), baseSha: sha, base: remoteText, wid: uid('w'), mtime: Date.now() };
      });
      if (!retry) return changed;
    }
    throw new GitHubError('파일이 계속 바뀌어 동기화하지 못했습니다. 잠시 후 다시 시도합니다.', { code: 'conflict' });
  }

  /**
   * Commit every dirty path — normally in one commit. Blobs are uploaded first, a few records in
   * memory at a time; a very large backlog (e.g. a whole library after a long time offline) is split
   * into commits of about COMMIT_BATCH_BYTES so a failure does not lose all uploads. PDFs go first and
   * library.json last, so other devices never see a paper whose PDF is not there yet.
   */
  async #push(client, meta, signal) {
    await this.#reconcileStale(client, meta, signal);
    const paths = (await this.#db.indexKeys('files', 'dirty', IDBKeyRange.only(PENDING)))
      .sort((x, y) => pushRank(x) - pushRank(y) || (x < y ? -1 : 1));
    let batch = [];
    let bytes = 0;
    for (let i = 0; i < paths.length; i += TRANSFER_CONCURRENCY) {
      const chunk = paths.slice(i, i + TRANSFER_CONCURRENCY);
      const items = await Promise.all(chunk.map((path) => this.#prepareItem(client, meta, path, signal)));
      for (const it of items) {
        if (!it) continue;
        batch.push(it);
        bytes += it.size;
      }
      if (bytes >= COMMIT_BATCH_BYTES && i + TRANSFER_CONCURRENCY < paths.length) {
        meta = await this.#commitBatch(client, meta, batch, signal);
        batch = [];
        bytes = 0;
      }
    }
    return batch.length ? this.#commitBatch(client, meta, batch, signal) : meta;
  }

  /**
   * A dirty data file whose sync base is not the remote's current version would overwrite the remote copy
   * (its first edit happened while the download failed, a download raced a pull, the repo was switched).
   * Merge the remote version into it first — without a base when none is known (union of items).
   */
  async #reconcileStale(client, meta, signal) {
    const stale = [];
    for (const path of await this.#db.indexKeys('files', 'dirty', IDBKeyRange.only(PENDING))) {
      const remoteSha = meta.tree[path]?.sha;
      if (!remoteSha || !mergerFor(path)) continue;
      const rec = await this.#db.get('files', path);
      if (rec?.dirty && !rec.deleted && typeof rec.data === 'string' && rec.baseSha !== remoteSha) stale.push(path);
    }
    if (!stale.length) return;
    console.warn('[store] merging the remote version into stale local edits before pushing:', stale.join(', '));
    const notify = [];
    await mapLimit(stale, TRANSFER_CONCURRENCY, async (path) => {
      if (await this.#applyRemote(client, path, meta.tree[path].sha, signal)) notify.push(path);
    });
    if (notify.length) {
      notify.sort();
      emit(this, 'remotechange', { paths: notify, origin: 'remote' });
      this.#post({ type: 'write', paths: notify });
    }
  }

  async #reject(path, wid, err) {
    console.warn('[store] GitHub refused', path, err);
    let marked = false;
    await this.#db.update('files', path, (cur) => {
      if (!cur || cur.wid !== wid || cur.dirty !== PENDING) return undefined;
      marked = true;
      return { ...cur, dirty: REJECTED, rejected: { code: err.code, message: err.message, at: Date.now() } };
    });
    if (marked) emit(this, 'rejected', { path, code: err.code, message: err.message });
  }

  /** Upload one dirty record's blob (unless the remote already has these bytes). */
  async #prepareItem(client, meta, path, signal) {
    const rec = await this.#db.get('files', path);
    if (rec?.dirty !== PENDING) return null;
    const remoteSha = meta.tree[path]?.sha ?? null;
    if (rec.deleted) return { path, wid: rec.wid, delete: true, remote: Boolean(remoteSha), size: 0 };
    const key = `${client.target}
${path}
${rec.wid}`;
    const bytes = typeof rec.data === 'string' ? utf8Encode(rec.data) : rec.data;
    let sha = this.#uploaded.get(key);
    if (!sha) {
      const localSha = await gitBlobSha(bytes);
      if (localSha === remoteSha) sha = localSha;
      else {
        try {
          sha = await client.createBlob(bytes, { signal });
        } catch (err) {
          // GitHub refuses this one file for good (too large, invalid): keep it here, sync everything else.
          if (err instanceof GitHubError && (err.code === 'too_large' || err.code === 'invalid')) {
            await this.#reject(path, rec.wid, err);
            return null;
          }
          throw err;
        }
      }
      this.#uploaded.set(key, sha);
    }
    return { path, wid: rec.wid, sha, unchanged: sha === remoteSha, text: baseTextFor(path, rec.data), size: bytes.byteLength, key };
  }

  /** Commit prepared items on top of `meta`, then mark them clean locally. Returns the new snapshot. */
  async #commitBatch(client, meta, items, signal) {
    const changes = items.filter((it) => (it.delete ? it.remote : !it.unchanged));
    let next = meta;
    if (changes.length) {
      const files = changes.map((it) => (it.delete ? { path: it.path, delete: true } : { path: it.path, sha: it.sha }));
      if (!meta.tree[README_PATH]) files.push({ path: README_PATH, text: README_TEXT }); // "created if missing"
      const res = await client.commit(files, commitMessage(changes), { parent: meta.commitSha, baseTree: meta.treeSha, signal });
      const tree = Object.fromEntries(
        [...(await client.listTree(res.treeSha, { signal }))].map(([p, v]) => [p, { sha: v.sha, size: v.size }]));
      next = await this.#updateMeta((m) => ({ ...m, commitSha: res.commitSha, treeSha: res.treeSha, tree }));
      this.#post({ type: 'meta' });
    }
    for (const it of items) {
      await this.#db.update('files', it.path, (cur) => {
        if (!cur) return undefined;
        const sha = it.delete ? null : next.tree[it.path]?.sha ?? it.sha;
        if (cur.wid !== it.wid) {
          // Written again while we pushed: still dirty, but now based on what we just pushed.
          return { ...cur, baseSha: sha, base: it.text ?? (sha ? cur.base : undefined) };
        }
        if (it.delete) return DELETE;
        return cleanRecord(it.path, cur.data, sha);
      });
      if (it.key) this.#uploaded.delete(it.key);
    }
    return next;
  }

  // ------------------------------------------------------------ local state

  async #fetchRemote(path, sha) {
    const key = `${path}\n${sha}`;
    const pending = this.#inflight.get(key);
    if (pending) return pending;
    const run = (async () => {
      if (!isTextPath(path)) {
        const cached = await this.#db.get('blobs', sha);
        if (cached) return cached;
      }
      const client = this.#client;
      if (!client) {
        throw new Error('이 파일은 아직 이 기기에 없습니다. 설정에서 GitHub 동기화를 켜면 내려받을 수 있습니다.');
      }
      const bytes = await client.readBlob(sha);
      if (!isTextPath(path)) {
        try {
          await this.#db.put('blobs', sha, bytes);
        } catch (err) {
          // e.g. storage quota: the bytes are here, so open the file anyway, just uncached.
          console.warn('[store] could not cache the downloaded file', path, err);
        }
        return bytes;
      }
      const text = utf8Decode(bytes);
      // Keep a clean local copy so later edits have a merge base and it works offline — unless a pull
      // moved the path to a newer blob while this download was in flight (that copy would be stale).
      const current = this.#meta?.tree?.[path]?.sha ?? null;
      const stored = await this.#db.update('files', path, (rec) => {
        if (current && current !== sha) return undefined;
        if (!rec) return cleanRecord(path, text, sha);
        if (!rec.dirty && !rec.deleted && rec.baseSha !== sha) return cleanRecord(path, text, sha);
        return undefined;
      });
      if (!stored) return text;
      return stored.deleted ? null : stored.data;
    })();
    this.#inflight.set(key, run);
    try {
      return await run;
    } finally {
      this.#inflight.delete(key);
    }
  }

  async #loadMeta() {
    this.#meta = (await this.#db.get('meta', META_KEY)) || null;
    return this.#meta;
  }

  /** Remote snapshot for the configured target (null when unknown or for another repo). */
  async #currentMeta() {
    const meta = this.#meta ?? (await this.#loadMeta());
    if (!meta || !this.#client || meta.target !== this.#client.target) return null;
    return meta;
  }

  /** Remote snapshot for `target`, resetting local sync bases if the repo changed. */
  async #prepareMeta(target) {
    const meta = await this.#loadMeta();
    if (meta?.target === target) return meta;
    if (meta) {
      // Data that came from another repository is uploaded to the new one only with the user's consent
      // (settings.github.carryOver, set by the settings screen after asking).
      if (meta.target && this.#getConfig()?.carryOver !== target && (await this.#db.count('files'))) {
        throw new GitHubError('동기화할 GitHub 저장소가 바뀌었습니다. 이 기기의 논문·메모를 새 저장소에 올릴지 설정 → GitHub 동기화에서 정한 뒤 다시 저장하세요.', { code: 'target_changed' });
      }
      console.warn('[store] sync target changed; re-pushing local data to', target);
      await this.#rebaseAllLocal(meta.tree);
    }
    const fresh = { target, commitSha: null, treeSha: null, tree: {}, lastSyncAt: null };
    await this.#db.put('meta', META_KEY, fresh);
    this.#meta = fresh;
    return fresh;
  }

  async #updateMeta(fn) {
    const next = await this.#db.update('meta', META_KEY, (m) => fn(m || { target: null, commitSha: null, treeSha: null, tree: {}, lastSyncAt: null }));
    this.#meta = next;
    return next;
  }

  /**
   * Forget every sync base: all local content becomes pending for the (new or emptied) remote.
   * PDFs that were only cached from the old remote (`oldTree`) become local files too, so they are
   * uploaded rather than lost. Files never downloaded to this device cannot be carried over.
   */
  async #rebaseAllLocal(oldTree = {}) {
    await this.#db.rewriteAll('files', (rec) => {
      if (rec.deleted) return DELETE;
      return { ...rec, dirty: 1, baseSha: null, base: undefined, wid: uid('w') };
    });
    const cached = new Set(await this.#db.keys('blobs'));
    for (const [path, { sha }] of Object.entries(oldTree)) {
      if (!cached.has(sha)) continue;
      const bytes = await this.#db.get('blobs', sha);
      await this.#db.update('files', path, (rec) => (rec || !bytes ? undefined : { ...cleanRecord(path, bytes, null), dirty: 1, wid: uid('w') }));
    }
    await this.#refreshPending();
  }

  /** Drop cached remote blobs that the remote tree no longer references. */
  async #gcBlobs(tree) {
    const live = new Set(Object.values(tree).map((e) => e.sha));
    for (const key of this.#inflight.keys()) live.add(key.slice(key.lastIndexOf('\n') + 1));
    for (const sha of await this.#db.keys('blobs')) {
      if (!live.has(sha)) await this.#db.del('blobs', sha);
    }
  }

  async #refreshPending({ silent = false } = {}) {
    const pending = await this.#db.count('files', 'dirty', IDBKeyRange.only(PENDING));
    const rejected = await this.#db.count('files', 'dirty', IDBKeyRange.only(REJECTED));
    if (silent) Object.assign(this.#status, { pending, rejected });
    else this.#setStatus({ pending, rejected });
  }

  #setStatus(patch) {
    const next = { ...this.#status, ...patch };
    const same = Object.keys(next).every((k) => next[k] === this.#status[k]);
    this.#status = next;
    if (!same) emit(this, 'status', this.status);
  }

  // ------------------------------------------------------- other tabs

  #openChannel() {
    if (this.#channel || typeof BroadcastChannel === 'undefined') return;
    this.#channel = new BroadcastChannel(CHANNEL_NAME);
    this.#channel.onmessage = (e) => {
      const msg = e.data;
      if (!msg || msg.from === this.#id) return;
      if (msg.type === 'meta') {
        this.#meta = null;
        this.#loadMeta().then((m) => {
          if (m?.lastSyncAt && m.lastSyncAt !== this.#status.lastSyncAt) this.#setStatus({ lastSyncAt: m.lastSyncAt });
        }).catch(() => {});
        this.#refreshPending().catch(() => {});
      } else if (msg.type === 'write' && Array.isArray(msg.paths)) {
        emit(this, 'remotechange', { paths: msg.paths, origin: 'tab' });
        this.#refreshPending().then(() => this.#schedulePush()).catch(() => {});
      }
    };
  }

  #post(msg) {
    try { this.#channel?.postMessage({ ...msg, from: this.#id }); } catch { /* channel closed */ }
  }
}

// ---------------------------------------------------------------- merging

/** Merge rule per data file; null = not mergeable (local wins, e.g. the immutable paper.pdf). */
export function mergerFor(path) {
  if (path === LIBRARY_PATH) return mergeLibrary;
  const m = /^papers\/[^/]+\/(annotations|translation|ai)\.json$/.exec(path);
  return m ? MERGERS[m[1]] : null;
}

const MERGERS = { annotations: mergeAnnotations, translation: mergeTranslation, ai: mergeAi };

// ---------------------------------------------------------------- helpers

function isTextPath(path) {
  return /\.(json|md|txt)$/i.test(path);
}

function defaultAs(path) {
  if (/\.json$/i.test(path)) return 'json';
  return isTextPath(path) ? 'text' : 'bytes';
}

function encode(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') return stringify(value);
  throw new TypeError(`writeFile: unsupported value for ${typeof value}`);
}

function decode(data, as, path) {
  if (data == null) return null;
  if (as === 'bytes') return typeof data === 'string' ? utf8Encode(data) : data;
  const text = typeof data === 'string' ? data : utf8Decode(data);
  if (as === 'text') return text;
  const obj = parseJson(text);
  if (obj === undefined) {
    console.warn('[store] unreadable JSON', path);
    throw new Error(`저장된 데이터를 읽지 못했습니다 (${path}). 파일이 손상되었을 수 있습니다.`);
  }
  return obj;
}

/** JSON.parse that returns undefined instead of throwing. */
function parseJson(text) {
  try { return JSON.parse(text); } catch { return undefined; }
}

function stringify(obj) {
  return `${JSON.stringify(obj, null, 2)}\n`;
}

/** Text to keep as the merge base after pushing a mergeable file. */
function baseTextFor(path, data) {
  return mergerFor(path) && typeof data === 'string' ? data : undefined;
}

function cleanRecord(path, data, sha) {
  return { path, data, baseSha: sha, mtime: Date.now() };
}

function dirtyRecord(rec, path, data, wid) {
  const base = !rec || rec.deleted ? undefined
    : rec.dirty ? rec.base
      : typeof rec.data === 'string' ? rec.data : undefined;
  return { path, data, dirty: 1, baseSha: rec ? rec.baseSha ?? null : null, base, wid, mtime: Date.now() };
}

/** Push order: binaries (PDFs) first, then data files, library.json last. */
function pushRank(path) {
  if (path === LIBRARY_PATH) return 2;
  return isTextPath(path) ? 1 : 0;
}

function commitMessage(changes) {
  const names = changes.map((c) => (c.delete ? `−${c.path}` : c.path));
  const more = names.length > 3 ? ` 외 ${names.length - 3}개` : '';
  return `논문 리더 동기화: ${names.slice(0, 3).join(', ')}${more}`;
}

async function withLock(fn, { wait }) {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : null;
  if (!locks?.request) return fn();
  if (wait) return locks.request(LOCK_NAME, () => fn());
  return locks.request(LOCK_NAME, { ifAvailable: true }, (lock) => (lock ? fn() : undefined));
}
