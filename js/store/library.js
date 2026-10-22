// Library model (SPEC §2.3): folders, papers and per-paper data files on top of the sync engine.
// Mutations are synchronous for the UI; library.json is written to IndexedDB right after each one
// (coalesced) and pushed to GitHub by the SyncEngine. Deletions are tombstones so they sync.
//
// Several libraries can be open at once (docs/SHARED.md §3.1): 내 서재 (id 'mine', IndexedDB 'paper-reader',
// the owner's GitHub repo — unchanged) and the relay's libraries (openSharedLibrary(): each with its own
// IndexedDB, the relay's GitHub-compatible proxy, each person's notes and AI data under `people/<personId>/`,
// deletes that only tombstone so the 휴지통 can restore them): 전체 공용 서재 (lib 'team', the team repo's root)
// and the invite code's own library (lib 'mine', the folder `codes/<libraryId>/` of the same repo).
//
// Paths: every path this module, the engine, IndexedDB and the 'remotechange' events use is the library's own
// ('library.json', 'papers/<id>/…', 'people/<id>/…'). A library kept in a folder of the repo (`rootPrefix`) is
// mapped to repo paths (rootPrefix + path) only by GitHubClient, so readers and features work unchanged.
import { emit } from '../core/bus.js';
import { LIMITS } from '../core/config.js';
import { formatBytes, safeStorage, uid, utf8Encode } from '../core/util.js';
import { db as defaultDb, DEFAULT_DB_NAME, openDatabase } from './db.js';
import { GitHubClient, ROOT_PREFIX_RE, gitBlobSha } from './github.js';
import { SyncEngine, deepEqual, mergeLibrary, mergeTranslation, toMillis } from './sync.js';
import { HEX_TITLE_RE, decodePdfTitle } from '../pdf/pdf-text.js';

const LIBRARY_PATH = 'library.json';
/** Synchronous last-resort copy of unsaved library changes, written when the page is hidden or closed. */
const JOURNAL_KEY = 'pr.store.libraryJournal.v1';
const DATA_KINDS = new Set(['translation', 'annotations', 'ai']);
const MAX_NAME_LENGTH = 200;
/** Fields of a paper that only the library itself may change. */
const PROTECTED_PAPER_FIELDS = new Set(['id', 'addedAt', 'addedBy', 'updatedAt', 'deleted', 'deletedAt', 'deletedBy', 'size', 'sha256']);
/** Deleted items stay restorable this long (the shared library's purge removes older papers' files). */
export const TRASH_RETENTION_DAYS = 30;
const TRASH_RETENTION_MS = TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000;
const LIBRARY_ID_RE = /^(?:mine|shared:[A-Za-z0-9_-]{1,64})$/;
const PERSONAL_PREFIX_RE = /^people\/[A-Za-z0-9_-]{1,64}\/$/;
const SHARED_LIB_RE = /^[A-Za-z0-9_-]{1,64}$/;
const PERSON_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** An invite code's own library (GET /shared `libraryId`, D1 codes.library_id): its folder is `codes/<libraryId>/`. */
const LIBRARY_KEY_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** The relay's library of the caller's invite code (GET /shared lists it as id 'mine'). */
export const CODE_LIBRARY = 'mine';
/** First line of a commit message (the relay prefixes `[name] ` and keeps ≤ 200 characters). */
const MAX_COMMIT_SUMMARY = 170;
const MAX_ACTIONS = 100;

/** Sync messages of a relay library, named by its label ('전체 공용 서재', '봄당 서재', …). */
const sharedTexts = (label) => Object.freeze({
  noClient: `이 파일은 아직 이 기기에 없습니다. ${label}에 연결되면 내려받을 수 있습니다.`,
  targetChanged: `${label} 서버가 바뀌어 동기화를 멈췄습니다. 설정 → 초대 코드를 확인하세요.`,
});

/** Repo path of one of a paper's shared files ('paper.pdf', 'translation.json', …). */
export const paperPath = (paperId, file) => `papers/${paperId}/${file}`;

/**
 * Repo path of a paper's data file: translation.json is shared; annotations.json and ai.json live under the
 * library's personal prefix ('' in 내 서재, 'people/<personId>/' in 공용 서재).
 * @param {'translation'|'annotations'|'ai'} kind
 */
export function dataPath(paperId, kind, personalPrefix = '') {
  assertKind(kind);
  return kind === 'translation' ? paperPath(paperId, 'translation.json') : `${personalPrefix}${paperPath(paperId, `${kind}.json`)}`;
}

export class Library extends EventTarget {
  #sync;
  #data;
  #view = null;
  #writeChain = Promise.resolve();
  #writeQueued = false;
  #rev = 0; // bumped by every change
  #savedRev = 0; // last change known to be in IndexedDB
  /**
   * The stored library.json that memory was last reconciled with (read, written or absorbed). Memory is this
   * plus local edits, so it is the common ancestor for 3-way merges with any later stored version: a field
   * that only the stored copy changed (a pull, another tab) is taken even when both items carry equal stamps.
   */
  #base = null;
  #journalWritten = false;
  #listening = new AbortController();
  #persisted = null;
  #id;
  #label;
  #shared;
  #prefix;
  #retainPdf;
  #personName;
  #journalKey;
  #root;
  /** Shared library: what this device changed since the last push, for the commit message (최근 활동). */
  #actions = [];
  #muted = 0;
  /** Shared library: tombstoned papers whose files are gone (purged after 30 days) — not restorable. */
  #purged = new Set();
  #purgeCheck = 0; // only the latest check's answer is applied

  /**
   * Open a library and resume sync when it is configured (the first pull runs in the background; 'change'
   * fires when remote data arrives). Without options this is 내 서재, exactly as before.
   * @param {{ settings?: { get(): any }, db?: object, sync?: SyncEngine, syncOptions?: object,
   *           id?: string, label?: string, dbName?: string, getConfig?: () => object|null,
   *           personalPrefix?: string, retainPdfOnDelete?: boolean, shared?: boolean,
   *           personName?: string | (() => string), rootPrefix?: string }} opts
   *   id: 'mine' or 'shared:<lib>'. dbName: the IndexedDB database (default 'paper-reader').
   *   getConfig: the GitHub config for the engine, incl. apiBase (내 서재 default: settings.github; a shared library
   *     has no default and always uses it in proxy mode).
   *   personalPrefix: '' or 'people/<personId>/' — where annotations.json and ai.json live.
   *   rootPrefix: '' (the repo root) or the repo folder the whole library lives in, e.g. 'codes/<libraryId>/':
   *     every repo path is rootPrefix + path (library.json, papers/…, the personalPrefix paths). Paths seen by
   *     callers (dataPath, 'remotechange') stay the library's own; see repoPath(). Applied to the engine's config,
   *     so it has no effect on a `sync` engine passed in.
   *   retainPdfOnDelete: deletes only tombstone (files stay, 휴지통 can restore papers).
   *   personName: who deletes (tombstones' deletedBy); default '나' for a personal library.
   */
  static async open({
    settings, db, sync, syncOptions, id = 'mine', label, dbName, getConfig, personalPrefix = '',
    retainPdfOnDelete = false, shared = false, personName, rootPrefix = '',
  } = {}) {
    if (!LIBRARY_ID_RE.test(String(id))) throw new TypeError(`invalid library id: ${id}`);
    if (personalPrefix && !PERSONAL_PREFIX_RE.test(personalPrefix)) throw new TypeError(`invalid personalPrefix: ${personalPrefix}`);
    if (rootPrefix && !ROOT_PREFIX_RE.test(rootPrefix)) throw new TypeError(`invalid rootPrefix: ${rootPrefix}`);
    const display = String(label || (shared ? '공용 서재' : '내 서재'));
    const database = db || (dbName ? openDatabase(dbName) : defaultDb);
    const name = database.name || dbName || '';
    // 내 서재 keeps the Web Lock, BroadcastChannel and journal names it always had; any other database has
    // its own, so two libraries in one page never lock, notify or journal for each other.
    const scope = name ? (name === DEFAULT_DB_NAME ? '' : name) : (id === 'mine' ? '' : id);
    await database.ready?.();
    let library = null;
    // A shared library syncs only through the relay's proxy: never the personal settings.github, and always in
    // proxy mode (the invite code must not be sent to api.github.com, stale bases are conflicts).
    const sharedConfig = () => {
      const c = getConfig?.();
      return c ? { label: display, ...c, proxy: true } : null;
    };
    const baseConfig = shared ? sharedConfig : getConfig || (() => settings?.get?.().github ?? null);
    // The library's folder is part of its identity (GitHubClient.target), so a config can never point the same
    // local data at another folder of the repo without the engine's repo-switch consent.
    const engineConfig = rootPrefix ? () => {
      const c = baseConfig();
      if (!c) return null;
      const out = { ...c, rootPrefix };
      // A carryOver naming this config's repo without the folder (e.g. app.js's "always carry my own data over")
      // means this library's own target.
      if (c.carryOver && c.carryOver === new GitHubClient({ ...c, rootPrefix: '' }).target) out.carryOver = new GitHubClient(out).target;
      return out;
    } : baseConfig;
    const engine = sync || new SyncEngine({
      db: database,
      getConfig: engineConfig,
      scope,
      addReadme: !shared && !rootPrefix,
      describeCommit: shared ? (changes) => library?.#describeCommit(changes) ?? null : null,
      texts: shared ? sharedTexts(display) : undefined,
      ...syncOptions,
    });
    library = new Library(engine, database, {
      id, label: display, shared, personalPrefix, retainPdfOnDelete, personName, rootPrefix,
      journalKey: scope ? `${JOURNAL_KEY}:${scope}` : JOURNAL_KEY,
    });
    await library.#load();
    // Local-first data must not be evicted under storage pressure — on every device, not only the one that
    // added the PDFs (a reading-only device may hold unpushed notes and translations).
    library.#persisted = requestPersistentStorage();
    await engine.start();
    await library.#refreshPurged().catch((err) => console.warn('[store] trash check', err));
    return library;
  }

  /** Use Library.open(). */
  constructor(sync, db = defaultDb, options = {}) {
    super();
    this.#sync = sync;
    this.#db = db;
    this.#data = normalizeLibrary(null);
    const shared = Boolean(options.shared);
    this.#id = options.id || 'mine';
    this.#label = String(options.label || (shared ? '공용 서재' : '내 서재'));
    this.#shared = shared;
    this.#prefix = options.personalPrefix || '';
    this.#retainPdf = Boolean(options.retainPdfOnDelete);
    this.#personName = options.personName ?? (shared ? '' : '나');
    this.#journalKey = options.journalKey || JOURNAL_KEY;
    this.#root = options.rootPrefix || '';
  }

  #db;

  // ------------------------------------------------------------------ reads

  /** 'mine' or 'shared:<lib>'. */
  get id() { return this.#id; }
  /** Display name ('내 서재', '공용 서재'). */
  get label() { return this.#label; }
  get shared() { return this.#shared; }
  /** '' or 'people/<personId>/' (where this person's annotations.json and ai.json live). */
  get personalPrefix() { return this.#prefix; }
  get retainPdfOnDelete() { return this.#retainPdf; }
  /** Name written into tombstones' deletedBy (null when unknown). */
  get personName() { return this.#who(); }
  /** '' or the repo folder this library lives in (e.g. 'codes/<libraryId>/' for an invite code's library). */
  get rootPrefix() { return this.#root; }

  /**
   * Repo path of one of this library's paths (rootPrefix + path) — what the GitHub repo holds. Everything else
   * (dataPath(), listPaths(), 'remotechange' paths, IndexedDB keys) uses the library's own paths.
   */
  repoPath(path) { return `${this.#root}${path}`; }

  /** Live folders (tombstones hidden). A parent that was deleted resolves to its nearest live ancestor. */
  get folders() { return this.#ensureView().folders; }

  /** Live papers, newest first. A folder that was deleted resolves to its nearest live ancestor. */
  get papers() { return this.#ensureView().papers; }

  getPaper(id) { return this.#ensureView().paperById.get(id) ?? null; }
  getFolder(id) { return this.#ensureView().folderById.get(id) ?? null; }

  get sync() { return this.#sync; }

  /** Repo path of this library's `kind` file for a paper (see dataPath). */
  dataPath(paperId, kind) { return dataPath(paperId, kind, this.#prefix); }

  // ---------------------------------------------------------------- folders

  createFolder(name, parentId = null) {
    const clean = cleanName(name, '폴더 이름');
    const parent = parentId == null ? null : this.#requireFolder(parentId).id;
    const now = Date.now();
    const folder = { id: uid('f'), name: clean, parentId: parent, createdAt: now, updatedAt: now };
    this.#data.folders.push(folder);
    this.#changed('folder');
    this.#note(`폴더 만듦 ${q(clean)}`);
    return this.getFolder(folder.id);
  }

  renameFolder(id, name) {
    const clean = cleanName(name, '폴더 이름');
    const folder = this.#rawFolder(id);
    if (folder.name === clean) return;
    const old = folder.name;
    folder.name = clean;
    touch(folder);
    this.#changed('folder');
    this.#note(`폴더 이름 변경 ${q(old)} → ${q(clean)}`);
  }

  moveFolder(id, parentId) {
    const folder = this.#rawFolder(id);
    const parent = parentId == null ? null : this.#requireFolder(parentId).id;
    if (parent && (parent === id || this.#isInside(parent, id))) {
      throw new Error('폴더를 자기 자신이나 하위 폴더 안으로 옮길 수 없습니다.');
    }
    if (this.getFolder(id).parentId === parent && folder.parentId === parent) return;
    folder.parentId = parent;
    touch(folder);
    this.#changed('folder');
    this.#note(`폴더 이동 ${q(folder.name)} → ${parent ? q(this.getFolder(parent)?.name) : '최상위'}`);
  }

  /**
   * Tombstone the folder; its subfolders and papers show up in its parent. 내 서재 moves them there (as
   * always); a library that retains deleted items leaves them pointing at the folder, so restore() brings
   * the folder back with its contents.
   */
  deleteFolder(id) {
    const folder = this.#rawFolder(id);
    const view = this.#ensureView();
    const newParent = view.folderById.get(id).parentId;
    if (!this.#retainPdf) {
      for (const f of this.#data.folders) {
        if (!f.deleted && f.id !== id && view.folderById.get(f.id)?.parentId === id) { f.parentId = newParent; touch(f); }
      }
      for (const p of this.#data.papers) {
        if (!p.deleted && view.paperById.get(p.id)?.folderId === id) { p.folderId = newParent; touch(p); }
      }
    } else if ((folder.parentId ?? null) !== newParent) {
      folder.parentId = newParent; // restore() puts it back where it was shown
    }
    this.#tombstone(folder);
    this.#changed('folder');
    this.#note(`폴더 삭제 ${q(folder.name)}`);
  }

  // ----------------------------------------------------------------- papers

  /**
   * Store the PDF locally, then add the paper record.
   * @param {Uint8Array|ArrayBuffer} bytes
   * @param {{ fileName?: string, folderId?: string|null, meta?: { title?, authors?, year?, pages? } }} opts
   */
  async addPaper(bytes, { fileName = '', folderId = null, meta = {} } = {}) {
    const pdf = checkedPdf(bytes);
    if (folderId != null) this.#requireFolder(folderId);
    const name = String(fileName || '').trim();
    const paper = await this.#insertPaper(pdf, {
      title: cleanText(meta?.title) || name.replace(/\.pdf$/i, '') || '제목 없음',
      authors: cleanText(meta?.authors),
      year: cleanYear(meta?.year),
      fileName: name,
      pages: meta?.pages,
      folderId,
    });
    this.#note(`논문 추가 ${q(paper.title)}`);
    return paper;
  }

  updatePaper(id, patch = {}) {
    const paper = this.#rawPaper(id);
    const changes = {};
    for (const [key, raw] of Object.entries(patch || {})) {
      if (PROTECTED_PAPER_FIELDS.has(key) || raw === undefined) continue;
      let value = raw;
      if (key === 'folderId') value = raw == null ? null : this.#requireFolder(raw).id;
      else if (key === 'title') value = cleanName(raw, '제목');
      if (!deepEqual(paper[key], value)) changes[key] = value;
    }
    if (!Object.keys(changes).length) return this.getPaper(id);
    const oldTitle = paper.title;
    Object.assign(paper, changes);
    touch(paper);
    this.#changed('paper');
    if ('title' in changes) this.#note(`제목 변경 ${q(oldTitle)} → ${q(changes.title)}`);
    if ('folderId' in changes) {
      this.#note(`논문 이동 ${q(paper.title)} → ${changes.folderId ? q(this.getFolder(changes.folderId)?.name) : '최상위'}`);
    }
    return this.getPaper(id);
  }

  movePaper(id, folderId) {
    return this.updatePaper(id, { folderId: folderId ?? null });
  }

  /**
   * Tombstone the paper. 내 서재 also deletes its PDF, translation, annotations and AI data; a library that
   * retains deleted items keeps every file, so the paper can be restored from the 휴지통.
   */
  deletePaper(id) {
    const paper = this.#rawPaper(id);
    if (this.#retainPdf) {
      const shown = this.#ensureView().paperById.get(id)?.folderId ?? null;
      if ((paper.folderId ?? null) !== shown) paper.folderId = shown; // restore() puts it back where it was shown
    }
    this.#tombstone(paper);
    this.#changed('paper');
    this.#note(`논문 삭제 ${q(paper.title || paper.fileName)}`);
    if (!this.#retainPdf) this.#deletePaperFiles(id).catch((err) => console.warn('[store] delete paper files', id, err));
  }

  /** The PDF bytes: the local copy, or downloaded once from GitHub (then cached). */
  async getPdf(id) {
    if (!this.getPaper(id)) throw new Error('논문을 찾을 수 없습니다.');
    let bytes;
    try {
      bytes = await this.#sync.readFile(paperPath(id, 'paper.pdf'), { as: 'bytes' });
    } catch (err) {
      console.warn('[store] getPdf', id, err);
      throw new Error(`PDF 파일을 내려받지 못했습니다. ${err?.message || ''}`.trim(), { cause: err });
    }
    if (!bytes?.byteLength) {
      throw new Error('PDF 파일을 찾을 수 없습니다. 이 논문을 추가한 기기에서 아직 동기화하지 않았을 수 있습니다.');
    }
    return bytes;
  }

  /** @param {'translation'|'annotations'|'ai'} kind */
  async getPaperData(id, kind) {
    const value = await this.#sync.readFile(this.dataPath(id, kind), { as: 'json' });
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  }

  /**
   * Persist a per-paper data file (SPEC §2.2); sets `obj.updatedAt`. `base` (optional) is the stored version
   * `obj` was derived from: the write then merges 3-way with what is stored now, and the stamp is kept newer
   * than the base's (a device whose clock is behind still wins for its own fresh edits).
   * @returns {Promise<object>} what is stored now (may include records merged from another tab or device)
   */
  async savePaperData(id, kind, obj, { base = null } = {}) {
    assertKind(kind);
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new TypeError('savePaperData: obj must be an object');
    this.#assertNotDeleted(id);
    obj.updatedAt = Math.max(Date.now(), toMillis(base?.updatedAt) + 1);
    obj.version ??= 1;
    const stored = await this.#sync.writeFile(this.dataPath(id, kind), obj, { base });
    emit(this, 'change', { reason: 'data', paperId: id, kind });
    return stored;
  }

  /**
   * Read-modify-write of a per-paper data file: `mutate(current)` receives a copy of what is stored now
   * ({ version: 1 } when there is none) and returns the new object (or undefined to leave it). A failed read
   * throws instead of writing over data this device could not see. Calls for one paper/kind run in order.
   * @returns {Promise<object|null>} the stored object
   */
  updatePaperData(id, kind, mutate) {
    assertKind(kind);
    const key = `${id}\n${kind}`;
    const prev = this.#dataChains.get(key) || Promise.resolve();
    const run = prev.catch(() => {}).then(async () => {
      const current = await this.#sync.readFile(this.dataPath(id, kind), { as: 'json' });
      const base = current && typeof current === 'object' && !Array.isArray(current) ? current : null;
      const next = mutate(structuredClone(base || { version: 1 }));
      if (next === undefined) return base;
      return this.savePaperData(id, kind, next, { base });
    });
    this.#dataChains.set(key, run);
    run.finally(() => { if (this.#dataChains.get(key) === run) this.#dataChains.delete(key); }).catch(() => {});
    return run;
  }

  #dataChains = new Map();

  // ------------------------------------------------------------------ trash

  /**
   * The 휴지통: deleted folders and papers that restore() can bring back, most recently deleted first.
   * Each item is a frozen snapshot of the record plus `kind` ('folder'|'paper'), `name` (folder name or
   * paper title), `deletedAt` (ms), `deletedBy` (name or null), `expiresAt` (deletedAt + 30 days) and
   * `expired`. Folders are listed for 30 days. Papers are listed only where deletes keep the files (공용 서재)
   * — also after 30 days, `expired`, until the purge removes their files. 내 서재 deletes a paper's files
   * with it, so its papers cannot be restored and are not listed.
   */
  trash() {
    const now = Date.now();
    const items = [];
    const when = (x) => toMillis(x.deletedAt) || toMillis(x.updatedAt);
    for (const f of this.#data.folders) {
      if (!f.deleted) continue;
      const at = when(f);
      if (now - at > TRASH_RETENTION_MS) continue;
      items.push(trashItem('folder', f, f.name, at, false));
    }
    if (this.#retainPdf) {
      for (const p of this.#data.papers) {
        if (!p.deleted || this.#purged.has(p.id)) continue;
        const at = when(p);
        items.push(trashItem('paper', p, p.title || p.fileName || '제목 없음', at, now - at > TRASH_RETENTION_MS));
      }
    }
    items.sort((a, b) => b.deletedAt - a.deletedAt || String(a.id).localeCompare(String(b.id)));
    return Object.freeze(items);
  }

  /**
   * Bring a deleted folder or paper back. A folder or paper whose folder was deleted too gets that folder
   * (and its deleted ancestors) back as well. Throws a Korean error when the item cannot be restored
   * (not in the 휴지통, or its files are gone).
   * @returns {Promise<object>} the restored folder or paper (live snapshot)
   */
  async restore(id) {
    let found = this.#tombstoned(id);
    if (!found) {
      const live = this.getPaper(id) || this.getFolder(id);
      if (live) return live;
      throw new Error('휴지통에서 찾을 수 없습니다. 이미 복구되었거나 휴지통을 비웠을 수 있습니다.');
    }
    if (found.kind === 'paper') {
      if (!this.#retainPdf) throw new Error('이 논문은 파일까지 삭제되어 복구할 수 없습니다.');
      if (!(await this.#sync.exists(paperPath(id, 'paper.pdf')))) {
        this.#setPurged(new Set([...this.#purged, id]));
        throw new Error('보관 기간이 지나 PDF가 비워진 논문이라 복구할 수 없습니다.');
      }
      found = this.#tombstoned(id); // memory may have changed while we looked
      if (!found) {
        const live = this.getPaper(id);
        if (live) return live;
        throw new Error('휴지통에서 찾을 수 없습니다. 이미 복구되었거나 휴지통을 비웠을 수 있습니다.');
      }
    }
    this.#revive(found);
    this.#changed('restore');
    this.#note(`복구 ${q(found.kind === 'paper' ? found.item.title || found.item.fileName : found.item.name)}`);
    return found.kind === 'paper' ? this.getPaper(id) : this.getFolder(id);
  }

  // ------------------------------------------------------------------- copy

  /**
   * Copy a paper into another library (e.g. 내 서재 → 공용 서재): the PDF and the shared translation, title and
   * bibliographic fields — never this person's notes or AI data. When the target already has the same PDF
   * (sha256), nothing is duplicated: that paper is put into `folderId` instead (restored first when it is
   * in the target's 휴지통), and sentences translated here that it lacks are added to its translation.
   * @param {Library} target
   * @param {string} paperId
   * @param {{ folderId?: string|null }} opts  folderId: a live folder of the target (null = top level)
   * @returns {Promise<{ paper: object, copied: boolean, existing: boolean, moved: boolean, restored: boolean,
   *                     translationAdded: number }>}
   */
  copyPaperTo(target, paperId, { folderId = null } = {}) {
    return this.#copyPaper(target, paperId, { folderId });
  }

  /** copyPaperTo(); `placed`: target papers a running copyFolderTo() already put somewhere (not moved again). */
  async #copyPaper(target, paperId, { folderId = null, placed = null } = {}) {
    this.#assertTarget(target);
    const src = this.getPaper(paperId);
    if (!src) throw new Error('복사할 논문을 찾을 수 없습니다. 삭제되었을 수 있습니다.');
    if (folderId != null) target.#requireFolder(folderId);
    const title = src.title || src.fileName || '제목 없음';
    const pdf = await this.getPdf(paperId);
    const sha256 = await sha256Hex(pdf);
    let translation;
    try {
      translation = await this.getPaperData(paperId, 'translation');
    } catch (err) {
      throw new Error(`‘${clip(title)}’의 번역을 읽지 못해 복사하지 않았습니다. ${err?.message || ''}`.trim(), { cause: err });
    }

    const existing = await target.#findPdf(sha256, pdf);
    if (existing) {
      const keep = placed?.has(existing.id) && !existing.deleted;
      return target.#adoptCopy(existing, { folderId: keep ? null : folderId, translation, from: this.label });
    }

    const paper = await target.#insertPaper(pdf, {
      title: src.title,
      authors: src.authors,
      year: src.year,
      fileName: src.fileName,
      pages: src.pages,
      folderId,
      translatedCount: translation ? src.translatedCount : 0,
      sentenceCount: src.sentenceCount,
      s2PaperId: src.s2PaperId,
      pmid: src.pmid,
      doi: src.doi,
    }, { sha256 });
    if (translation) await target.savePaperData(paper.id, 'translation', structuredClone(translation));
    target.#note(`논문 추가 ${q(paper.title)} (${this.label}에서 복사)`);
    return { paper: target.getPaper(paper.id), copied: true, existing: false, moved: false, restored: false, translationAdded: 0 };
  }

  /**
   * Copy a folder with its subfolders and papers into another library, under `parentId` (null = top level).
   * A target folder with the same name in the same place is reused, so copying again only adds what is new.
   * Papers are copied one at a time as copyPaperTo() does (PDF + translation, deduplicated by sha256); a paper
   * that fails is reported in `papers.failed` and the rest continue.
   * @param {Library} target
   * @param {{ parentId?: string|null, onProgress?: (p: { done: number, total: number, title: string }) => void,
   *           signal?: AbortSignal }} opts
   * @returns {Promise<{ folder: object, folders: { created: number, reused: number },
   *                     papers: { total: number, copied: number, existing: number, moved: number, restored: number,
   *                               failed: { id: string, title: string, message: string }[] } }>}
   */
  async copyFolderTo(target, folderId, { parentId = null, onProgress, signal } = {}) {
    this.#assertTarget(target);
    const root = this.getFolder(folderId);
    if (!root) throw new Error('복사할 폴더를 찾을 수 없습니다. 삭제되었을 수 있습니다.');
    if (parentId != null) target.#requireFolder(parentId);
    signal?.throwIfAborted();

    // Snapshot of the source subtree (live folders and papers), depth first.
    const children = new Map();
    for (const f of this.folders) {
      if (!children.has(f.parentId)) children.set(f.parentId, []);
      children.get(f.parentId).push(f);
    }
    const papersIn = new Map();
    for (const p of this.papers) {
      if (!papersIn.has(p.folderId)) papersIn.set(p.folderId, []);
      papersIn.get(p.folderId).push(p);
    }
    const folders = [];
    const papers = [];
    const seen = new Set();
    const walk = (f) => {
      if (seen.has(f.id)) return;
      seen.add(f.id);
      folders.push(f);
      papers.push(...[...(papersIn.get(f.id) || [])].sort((a, b) => toMillis(a.addedAt) - toMillis(b.addedAt)));
      for (const c of [...(children.get(f.id) || [])].sort((a, b) => a.name.localeCompare(b.name, 'ko'))) walk(c);
    };
    walk(root);

    const result = {
      folder: null,
      folders: { created: 0, reused: 0 },
      papers: { total: papers.length, copied: 0, existing: 0, moved: 0, restored: 0, failed: [] },
    };
    const mapped = new Map(); // source folder id → target folder id
    target.#muted++;
    try {
      for (const f of folders) {
        const parent = f.id === root.id ? parentId ?? null : mapped.get(f.parentId) ?? null;
        const same = target.folders.find((x) => (x.parentId ?? null) === parent && x.name === f.name);
        if (same) {
          mapped.set(f.id, same.id);
          result.folders.reused++;
        } else {
          mapped.set(f.id, target.createFolder(f.name, parent).id);
          result.folders.created++;
        }
      }
      let done = 0;
      const placed = new Set(); // a PDF twice in the subtree stays where its first copy went
      onProgress?.({ done, total: papers.length, title: '' });
      for (const p of papers) {
        signal?.throwIfAborted();
        try {
          const r = await this.#copyPaper(target, p.id, { folderId: mapped.get(p.folderId) ?? null, placed });
          if (r.paper) placed.add(r.paper.id);
          if (r.copied) result.papers.copied++;
          if (r.existing) result.papers.existing++;
          if (r.moved) result.papers.moved++;
          if (r.restored) result.papers.restored++;
        } catch (err) {
          if (err?.name === 'AbortError') throw err;
          console.warn('[store] copy paper', p.id, err);
          result.papers.failed.push({ id: p.id, title: p.title || p.fileName || '', message: err?.message || String(err) });
        }
        done++;
        onProgress?.({ done, total: papers.length, title: p.title || p.fileName || '' });
      }
    } finally {
      target.#muted--;
      const placedCount = result.papers.copied + result.papers.existing;
      if (mapped.size) target.#note(`폴더 복사 ${q(root.name)} (${this.label}에서, 논문 ${placedCount}편)`);
    }
    result.folder = target.getFolder(mapped.get(root.id));
    return result;
  }

  // ------------------------------------------------------------------ misc

  /** Would `cfg` (settings.github) sync this device's data into a different repository? See SyncEngine. */
  async syncTargetChange(cfg) {
    const info = await this.#sync.targetChange?.(cfg);
    if (!info) return null;
    return { ...info, papers: this.papers.length };
  }

  /** Whether the browser granted persistent storage (null: unknown / not supported). */
  async storagePersisted() {
    return (await this.#persisted) ?? null;
  }

  /**
   * Remove everything this device stores for this library: folders and papers, PDFs, translations, notes,
   * AI results and sync state (its IndexedDB database), and the unsaved-change journal. Nothing is deleted
   * on GitHub. The page should be reloaded afterwards.
   */
  async wipeLocalData() {
    this.#listening.abort();
    this.#sync.stop();
    await this.#writeChain.catch(() => {});
    safeStorage.remove(this.#journalKey);
    this.#data = normalizeLibrary(null);
    this.#base = null;
    this.#view = null;
    if (this.#db?.destroy) await this.#db.destroy();
  }

  #assertNotDeleted(id) {
    const raw = this.#data.papers.find((p) => p.id === id);
    if (raw?.deleted) throw new Error('이 논문은 삭제되었습니다(다른 기기에서 삭제했을 수 있습니다). 변경 내용을 저장하지 않았습니다.');
  }

  /** Call after settings.github changed (turns sync on/off or switches repo). */
  async reconfigureSync() {
    await this.#sync.reconfigure();
  }

  /** Resolves when every library change made so far is stored in IndexedDB. */
  whenSaved() {
    return this.#writeChain;
  }

  /** Store pending changes locally, then push them now instead of after the debounce. */
  async flush() {
    await this.#writeChain;
    await this.#sync.flush();
  }

  /** Stop syncing and wait for pending local writes (tests, teardown). */
  async close() {
    await this.#writeChain;
    this.#listening.abort();
    this.#sync.stop();
  }

  // -------------------------------------------------------------- internals

  async #load() {
    let stored = null;
    try {
      stored = await this.#sync.readFile(LIBRARY_PATH, { as: 'json', local: true });
    } catch (err) {
      // Unreadable local copy: start empty; the merge-on-write in the sync engine keeps nothing worse.
      console.warn('[store] library.json unreadable', err);
    }
    this.#data = normalizeLibrary(stored);
    this.#base = normalizeLibrary(stored);
    const journal = safeStorage.get(this.#journalKey, null);
    if (journal?.data) {
      // The previous page closed before its last changes reached IndexedDB. The journal carries the stored
      // version those changes were made on, so the replay is a 3-way merge (it cannot revert newer fields).
      const base = journal.base ? normalizeLibrary(journal.base) : null;
      this.#data = normalizeLibrary(mergeLibrary(normalizeLibrary(journal.data), this.#data, base));
      this.#rev++;
      await this.#persist();
      if (this.#savedRev === this.#rev) safeStorage.remove(this.#journalKey);
    }
    this.#repairTitles();
    const { signal } = this.#listening;
    this.#sync.addEventListener('status', (e) => {
      // Nothing pending: every action noted so far has been pushed (by this tab or another one).
      if (e.detail?.pending === 0 && this.#actions.length) this.#actions = this.#actions.filter((a) => a.rev > this.#savedRev);
      emit(this, 'syncstatus', e.detail);
    }, { signal });
    this.#sync.addEventListener('remotechange', (e) => {
      this.#onRemoteChange(e.detail).catch((err) => console.warn('[store] remote change', err));
    }, { signal });
    this.#sync.addEventListener('rejected', (e) => this.#onRejected(e.detail), { signal });
    if (typeof window !== 'undefined') {
      // Leaving or backgrounding the page: keep a synchronous copy of unsaved changes, and push what
      // is pending now instead of waiting for the debounce.
      const flush = () => {
        if (this.#rev !== this.#savedRev) {
          safeStorage.set(this.#journalKey, { at: Date.now(), rev: this.#rev, data: this.#data, base: this.#base });
          this.#journalWritten = true;
        }
        this.flush().catch((err) => console.warn('[store] flush', err));
      };
      window.addEventListener('pagehide', flush, { signal });
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(); }, { signal });
    }
    // (A library that keeps deleted files checks its 휴지통 in open(), once the engine knows the remote tree.)
    if (!this.#retainPdf) this.#gcDeletedPapers().catch((err) => console.warn('[store] gc', err));
  }

  async #onRemoteChange({ paths = [], origin } = {}) {
    if (!paths.includes(LIBRARY_PATH) || origin === 'merge') {
      // e.g. the shared library's purge removed old papers' files (library.json unchanged)
      if (this.#retainPdf && paths.some((p) => /^papers\/[^/]+\/paper\.pdf$/.test(p))) await this.#refreshPurged();
      return;
    }
    // Reads and writes of library.json go through one chain, so stored versions are absorbed in the order
    // IndexedDB holds them (an older write result can never overwrite a newer pulled version in memory).
    const step = this.#writeChain.then(async () => {
      const stored = await this.#sync.readFile(LIBRARY_PATH, { as: 'json' });
      if (stored) this.#absorb(stored, 'remote');
    });
    this.#writeChain = step.catch((err) => console.warn('[store] reading library.json failed', err));
    await step;
    this.#repairTitles();
    await this.#gcDeletedPapers();
  }

  /**
   * Take in a newer stored version of library.json. Without unsaved local changes it simply replaces memory
   * (the stored copy already holds every saved local change, merged 3-way by the sync engine). Otherwise it
   * is merged 3-way against the version memory was last reconciled with.
   */
  #absorb(other, reason) {
    const stored = normalizeLibrary(other);
    const unsaved = this.#rev !== this.#savedRev;
    // Always a fresh copy: memory's records are mutated in place by edits, the base must never change.
    const merged = normalizeLibrary(unsaved ? mergeLibrary(this.#data, stored, this.#base) : stored);
    this.#base = stored;
    if (deepEqual(merged, this.#data)) return;
    this.#data = merged;
    this.#view = null;
    emit(this, 'change', { reason });
  }

  /**
   * Titles stored as a raw PDF hex string ('<C3D6C1BEB3EDB9AE2E687770>', an Info Title older versions could not
   * read) get their decoded title ('최종논문') written back, once: no PDF is parsed. One that is not text falls
   * back to the file name. Runs on load and when another device's library.json arrives.
   */
  #repairTitles() {
    const fixed = [];
    for (const p of this.#data.papers) {
      if (typeof p.title !== 'string' || !HEX_TITLE_RE.test(p.title.trim())) continue;
      const fromFile = decodePdfTitle(p.fileName);
      const title = (decodePdfTitle(p.title) || (HEX_TITLE_RE.test(fromFile) ? '' : fromFile)).slice(0, MAX_NAME_LENGTH).trim();
      if (!title || title === p.title) continue;
      p.title = title;
      touch(p);
      fixed.push(p);
    }
    if (!fixed.length) return;
    this.#changed('paper');
    for (const p of fixed) if (!p.deleted) this.#note(`제목 복구 ${q(p.title)}`);
  }

  /** GitHub refused to store one file (e.g. a PDF over its size limit): say which paper, keep syncing the rest. */
  #onRejected({ path, code, message } = {}) {
    const m = /^(?:people\/[^/]+\/)?papers\/([^/]+)\/([^/]+)$/.exec(path || '');
    const paper = m ? this.#data.papers.find((p) => p.id === m[1]) : null;
    const what = paper ? `‘${paper.title || paper.fileName}’의 ${m[2] === 'paper.pdf' ? 'PDF' : '데이터'}` : path;
    let text;
    if (this.#shared) {
      const why = code === 'too_large' ? '파일이 너무 커서' : '서버가 받아 주지 않아';
      const detail = /[가-힣]/.test(message || '') ? ` (${message})` : '';
      text = `${what}를 ${why} ${this.#label}에 올리지 못했습니다${detail}. 이 기기에는 그대로 남아 있고, 나머지는 계속 동기화됩니다.`;
    } else {
      const why = code === 'too_large' ? '파일이 너무 커서' : 'GitHub가 받아 주지 않아';
      text = `${what}를 ${why} GitHub에 올리지 못했습니다. 이 기기에는 그대로 남아 있고, 나머지는 계속 동기화됩니다.${paper ? ' 다른 기기에서도 보려면 더 작은 PDF로 다시 추가하세요.' : ''}`;
    }
    emit(this, 'error', { message: text, error: Object.assign(new Error(message || ''), { code }), path });
  }

  #changed(reason) {
    this.#data.updatedAt = Date.now();
    this.#rev++;
    this.#view = null;
    this.#persist();
    emit(this, 'change', { reason });
  }

  /** Write library.json; writes requested while one is in flight collapse into one more write. */
  #persist() {
    if (this.#writeQueued) return this.#writeChain;
    this.#writeQueued = true;
    this.#writeChain = this.#writeChain.then(async () => {
      this.#writeQueued = false;
      const rev = this.#rev;
      const snapshot = structuredClone(this.#data);
      const base = this.#base;
      try {
        // 3-way against the version memory came from: a pull or another tab that changed a field since is
        // kept even if this write's items carry equal or newer stamps.
        const stored = await this.#sync.writeFile(LIBRARY_PATH, snapshot, { base });
        this.#savedRev = Math.max(this.#savedRev, rev);
        if (stored !== snapshot) this.#absorb(stored, 'merge'); // another tab or device had changes we did not see
        else if (this.#base === base) this.#base = snapshot;
        if (this.#journalWritten && this.#savedRev === this.#rev) {
          // Everything the journal held is in IndexedDB now; a stale journal must not replay days later.
          safeStorage.remove(this.#journalKey);
          this.#journalWritten = false;
        }
      } catch (err) {
        console.warn('[store] saving library.json failed', err);
        emit(this, 'error', { message: err?.message || '라이브러리를 저장하지 못했습니다.', error: err });
      }
    });
    return this.#writeChain;
  }

  /**
   * Write the PDF, then add the paper record (fields already validated by the caller).
   * @returns {Promise<object>} the new paper (snapshot)
   */
  async #insertPaper(pdf, fields, { sha256 = null } = {}) {
    const id = uid('p');
    const digest = sha256 || (await sha256Hex(pdf));
    await this.#sync.writeFile(paperPath(id, 'paper.pdf'), pdf);
    requestPersistentStorage();
    const now = Date.now();
    const folderId = fields.folderId != null && this.getFolder(fields.folderId) ? fields.folderId : null;
    const paper = {
      id,
      title: fields.title || '제목 없음',
      authors: cleanText(fields.authors),
      year: cleanYear(fields.year),
      fileName: String(fields.fileName || '').trim() || `${id}.pdf`,
      size: pdf.byteLength,
      pages: Number.isInteger(fields.pages) && fields.pages > 0 ? fields.pages : 0,
      folderId,
      starred: false,
      addedAt: now,
      updatedAt: now,
      lastOpenedAt: null,
      translatedCount: count(fields.translatedCount),
      sentenceCount: count(fields.sentenceCount),
      sha256: digest,
    };
    if (typeof fields.s2PaperId === 'string' && fields.s2PaperId) paper.s2PaperId = fields.s2PaperId;
    // Scholarly ids resolved by 관련 논문 (js/features/scholarly.js); copied so the target never looks them up again.
    if (typeof fields.pmid === 'string' && /^\d{1,10}$/.test(fields.pmid)) paper.pmid = fields.pmid;
    if (typeof fields.doi === 'string' && /^10\.\d{4,9}\/\S{1,200}$/.test(fields.doi)) paper.doi = fields.doi;
    const who = this.#shared ? this.#who() : null;
    if (who) paper.addedBy = who; // 공용 서재 shows who added a paper
    this.#data.papers.push(paper);
    this.#changed('paper');
    return this.getPaper(id);
  }

  /**
   * A paper of this library with the same PDF (sha256; for records from before sha256 was stored: same size
   * and git blob sha): a live one first, else one in the 휴지통 whose files are still there.
   * @returns {Promise<{ id: string, deleted: boolean } | null>}
   */
  async #findPdf(sha256, pdf) {
    const live = [];
    const dead = [];
    let gitSha = null;
    for (const p of this.#data.papers) {
      let same = p.sha256 === sha256;
      if (!same && !p.sha256 && (!p.size || p.size === pdf.byteLength)) {
        gitSha ??= await gitBlobSha(pdf);
        same = (await this.#sync.blobSha(paperPath(p.id, 'paper.pdf'))) === gitSha;
      }
      if (same) (p.deleted ? dead : live).push(p);
    }
    if (live.length) {
      live.sort((a, b) => toMillis(a.addedAt) - toMillis(b.addedAt));
      return { id: live[0].id, deleted: false };
    }
    if (!this.#retainPdf) return null;
    for (const p of dead) {
      if (!this.#purged.has(p.id) && (await this.#sync.exists(paperPath(p.id, 'paper.pdf')))) return { id: p.id, deleted: true };
    }
    return null;
  }

  /** copyPaperTo() found the PDF here already: place that paper, and add the translated sentences it lacks. */
  async #adoptCopy({ id, deleted }, { folderId, translation, from }) {
    let restored = false;
    let moved = false;
    if (deleted) {
      const found = this.#tombstoned(id);
      if (found) {
        this.#revive(found, { folderId });
        this.#changed('restore');
        this.#note(`복구 ${q(found.item.title)} (${from}에서 복사)`);
        restored = true;
      }
    } else if (folderId != null && (this.getPaper(id)?.folderId ?? null) !== folderId) {
      this.movePaper(id, folderId);
      moved = true;
    }
    let translationAdded = 0;
    if (translation?.items && typeof translation.items === 'object' && Object.keys(translation.items).length) {
      try {
        await this.updatePaperData(id, 'translation', (cur) => {
          const merged = mergeTranslation(cur, translation);
          const before = Object.keys(cur.items || {}).length;
          translationAdded = Object.keys(merged.items || {}).length - before;
          const termsAdded = Object.keys(merged.terms || {}).length - Object.keys(cur.terms || {}).length;
          return translationAdded > 0 || termsAdded > 0 ? merged : undefined;
        });
      } catch (err) {
        translationAdded = 0;
        console.warn('[store] adding the translation to an existing paper failed', id, err);
      }
    }
    return { paper: this.getPaper(id), copied: false, existing: true, moved, restored, translationAdded };
  }

  #assertTarget(target) {
    if (!(target instanceof Library) || !(#data in target)) throw new TypeError('copy target must be a Library');
    // A second instance of this library (same IndexedDB) is the same library.
    if (target === this || (target.#db === this.#db && target.#id === this.#id)) {
      throw new Error('같은 서재 안으로는 복사할 수 없습니다. 옮기기를 사용하세요.');
    }
  }

  /** Mark deleted, with when and by whom (for the 휴지통). */
  #tombstone(item) {
    item.deleted = true;
    item.deletedAt = Date.now();
    const who = this.#who();
    if (who) item.deletedBy = who;
    else delete item.deletedBy;
    touch(item);
  }

  /** { kind, item } of a tombstoned folder or paper. */
  #tombstoned(id) {
    const f = this.#data.folders.find((x) => x.id === id && x.deleted);
    if (f) return { kind: 'folder', item: f };
    const p = this.#data.papers.find((x) => x.id === id && x.deleted);
    return p ? { kind: 'paper', item: p } : null;
  }

  /**
   * Un-tombstone `found.item` and the deleted folders above it. `folderId` (papers only, a live folder)
   * places the paper there instead of where it was.
   */
  #revive({ kind, item }, { folderId = null } = {}) {
    if (kind === 'paper' && folderId != null) {
      item.folderId = folderId;
    } else {
      const seen = new Set([item.id]);
      for (let cur = kind === 'paper' ? item.folderId : item.parentId; cur != null && !seen.has(cur);) {
        seen.add(cur);
        const f = this.#data.folders.find((x) => x.id === cur);
        if (!f || !f.deleted) break;
        untomb(f);
        cur = f.parentId;
      }
    }
    untomb(item);
  }

  #who() {
    const v = typeof this.#personName === 'function' ? this.#personName() : this.#personName;
    const s = typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, 60) : '';
    return s || null;
  }

  /** Shared library: remember what changed, for the next commit message (who did what, 최근 활동). */
  #note(text) {
    if (!this.#shared || this.#muted) return;
    this.#actions.push({ text, rev: this.#rev });
    if (this.#actions.length > MAX_ACTIONS) this.#actions.splice(0, this.#actions.length - MAX_ACTIONS);
  }

  /** The commit message for a batch of the shared library's changes (the relay prefixes `[name] `). */
  #describeCommit(changes) {
    const paths = changes.map((c) => c.path);
    const parts = [];
    if (paths.includes(LIBRARY_PATH)) {
      for (const a of this.#actions) if (a.rev <= this.#savedRev) parts.push(a.text);
    }
    const translated = [];
    let pdfs = 0;
    let personal = 0;
    for (const p of paths) {
      const m = /^papers\/([^/]+)\/translation\.json$/.exec(p);
      if (m) translated.push(m[1]);
      else if (/^papers\/[^/]+\/paper\.pdf$/.test(p)) pdfs++;
      else if (this.#prefix && p.startsWith(this.#prefix)) personal++;
    }
    for (const id of translated) {
      const paper = this.#data.papers.find((x) => x.id === id);
      parts.push(`번역 ${q(paper?.title || paper?.fileName || id)}`);
    }
    if (!parts.length) {
      if (paths.includes(LIBRARY_PATH)) parts.push('논문 정보 갱신');
      else if (pdfs) parts.push(`PDF ${pdfs}개 올림`);
      else if (personal) parts.push('내 메모·AI 결과 동기화');
      else return null;
    }
    // '{lib:…}' is the relay's marker of which library a commit belongs to (최근 활동 per library); a title can
    // never imitate it.
    return joinLimited([...new Set(parts)], MAX_COMMIT_SUMMARY).replace(/\{\s*lib\s*:/gi, '{lib ');
  }

  /** Shared library: which deleted papers lost their files (not restorable, hidden from the 휴지통). */
  async #refreshPurged() {
    if (!this.#retainPdf) return;
    const check = ++this.#purgeCheck;
    const next = new Set();
    for (const p of this.#data.papers) {
      if (p.deleted && !(await this.#sync.exists(paperPath(p.id, 'paper.pdf')))) next.add(p.id);
    }
    if (check === this.#purgeCheck) this.#setPurged(next);
  }

  #setPurged(next) {
    if (next.size === this.#purged.size && [...next].every((id) => this.#purged.has(id))) return;
    this.#purged = next;
    emit(this, 'change', { reason: 'trash' });
  }

  /** Remove leftover files of tombstoned papers (e.g. edited on another device while being deleted). */
  async #gcDeletedPapers() {
    if (this.#retainPdf) {
      await this.#refreshPurged();
      return;
    }
    for (const paper of this.#data.papers) {
      if (paper.deleted) await this.#deletePaperFiles(paper.id);
    }
  }

  async #deletePaperFiles(id) {
    for (const prefix of new Set([paperPath(id, ''), `${this.#prefix}${paperPath(id, '')}`])) {
      for (const path of await this.#sync.listPaths(prefix)) await this.#sync.deleteFile(path);
    }
  }

  #rawFolder(id) {
    const f = this.#data.folders.find((x) => x.id === id && !x.deleted);
    if (!f) throw new Error('폴더를 찾을 수 없습니다. 다른 기기에서 삭제되었을 수 있습니다.');
    return f;
  }

  #rawPaper(id) {
    const p = this.#data.papers.find((x) => x.id === id && !x.deleted);
    if (!p) throw new Error('논문을 찾을 수 없습니다. 다른 기기에서 삭제되었을 수 있습니다.');
    return p;
  }

  #requireFolder(id) {
    const f = this.getFolder(id);
    if (!f) throw new Error('대상 폴더를 찾을 수 없습니다. 다른 기기에서 삭제되었을 수 있습니다.');
    return f;
  }

  /** Is folder `id` somewhere below folder `ancestorId`? */
  #isInside(id, ancestorId) {
    const view = this.#ensureView();
    const seen = new Set();
    for (let cur = view.folderById.get(id)?.parentId ?? null; cur && !seen.has(cur); cur = view.folderById.get(cur)?.parentId ?? null) {
      if (cur === ancestorId) return true;
      seen.add(cur);
    }
    return false;
  }

  /** Read-only, normalised snapshot of the live data; rebuilt after every change. */
  #ensureView() {
    if (this.#view) return this.#view;
    const all = new Map(this.#data.folders.map((f) => [f.id, f]));
    // Nearest live folder at or above `id` (tombstones keep their parentId for exactly this).
    const resolve = (id) => {
      const seen = new Set();
      for (let cur = id ?? null; cur != null && !seen.has(cur); cur = all.get(cur)?.parentId ?? null) {
        seen.add(cur);
        const f = all.get(cur);
        if (!f) return null;
        if (!f.deleted) return cur;
      }
      return null;
    };
    const live = this.#data.folders.filter((f) => !f.deleted);
    const parentOf = new Map(live.map((f) => [f.id, resolve(f.parentId)]));
    breakCycles(parentOf);

    const folders = live.map((f) => Object.freeze({ ...f, parentId: parentOf.get(f.id) ?? null }));
    const papers = this.#data.papers
      .filter((p) => !p.deleted)
      .map((p) => Object.freeze({ ...p, folderId: resolve(p.folderId) }))
      .sort((a, b) => toMillis(b.addedAt) - toMillis(a.addedAt) || String(a.id).localeCompare(String(b.id)));
    this.#view = {
      folders: Object.freeze(folders),
      papers: Object.freeze(papers),
      folderById: new Map(folders.map((f) => [f.id, f])),
      paperById: new Map(papers.map((p) => [p.id, p])),
    };
    return this.#view;
  }
}

// ------------------------------------------------------- shared library

/**
 * Canonical invite code ("pr abcd efgh" → "PR-ABCD-EFGH"), or '' when it cannot be one. Same rules as the
 * relay's normalizeCode (relay/src/codes.js): Crockford base32, typed I/L → 1 and O → 0.
 */
export function normalizeInviteCode(raw) {
  const compact = String(raw || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
  if (compact.length !== 10 || !compact.startsWith('PR')) return '';
  const body = compact.slice(2).replace(/O/g, '0').replace(/[IL]/g, '1');
  const code = `PR-${body.slice(0, 4)}-${body.slice(4)}`;
  return /^PR-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/.test(code) ? code : '';
}

/** personId (docs/SHARED.md §1): the first 16 hex characters of SHA-256 of the normalised invite code. */
export async function personIdFor(code) {
  const normal = normalizeInviteCode(code);
  if (!normal) throw new Error('초대 코드 형식이 올바르지 않습니다. PR-XXXX-XXXX 형식의 코드를 입력하세요.');
  return (await sha256Hex(utf8Encode(normal))).slice(0, 16);
}

/**
 * IndexedDB name of a relay library on this device: one per library and person (invite code) —
 * 'paper-reader-shared-team-<personId>', and for the code's own library (lib 'mine') also per library:
 * 'paper-reader-shared-mine-<libraryId>-<personId>' (a code moved to another library never mixes the two).
 */
export function sharedDbName(lib, personId, libraryId = '') {
  if (lib === CODE_LIBRARY) {
    if (!LIBRARY_KEY_RE.test(String(libraryId || ''))) throw new TypeError(`invalid libraryId: ${libraryId}`);
    return `paper-reader-shared-${lib}-${libraryId}-${personId}`;
  }
  return `paper-reader-shared-${lib}-${personId}`;
}

/** Repo folder of an invite code's own library: 'codes/<libraryId>/'. */
export function codeLibraryPrefix(libraryId) {
  const key = String(libraryId ?? '').trim();
  if (!LIBRARY_KEY_RE.test(key)) throw new Error('이 초대 코드의 서재 정보를 받지 못했습니다. 잠시 후 다시 시도하세요.');
  return `codes/${key}/`;
}

/**
 * Open a relay library (docs/SHARED.md) through the relay's GitHub-compatible proxy (`<relayUrl>/shared/<lib>/gh`,
 * owner 'team', repo 'library', the invite code as token), with this person's notes and AI data under
 * `people/<personId>/`, deletes that only tombstone (휴지통) and its own IndexedDB database (sharedDbName()).
 * - lib 'team' (default): 전체 공용 서재, the team repo's root — every active code sees it.
 * - lib 'mine': the invite code's own library, the folder `codes/<libraryId>/` of the same repo (`libraryId` from
 *   GET /shared) — only holders of that code see it. Every repo path is `codes/<libraryId>/` + path.
 * @param {{ relayUrl?: string, code?: string, lib?: string, libraryId?: string, rootPrefix?: string,
 *           personId?: string, name?: string | (() => string), personName?: string | (() => string), label?: string,
 *           branch?: string, getConfig?: () => object|null, dbName?: string, db?: object, syncOptions?: object }} opts
 *   relayUrl + code: the server address and invite code (settings.relay). Or `getConfig` instead: a function
 *   returning the proxy config `{ owner, repo, branch, token, apiBase, carryOver? }` that follows settings
 *   changes (it is always used as a proxy config: the code never goes to api.github.com, whatever apiBase says).
 *   libraryId: required for lib 'mine' (GET /shared `libraryId`). rootPrefix: another library's folder (rare;
 *   lib 'mine' derives it from libraryId).
 *   personId: from the relay's GET /shared (computed from the code when omitted). personName (or `name`): the
 *   person's name from GET /shared, written into tombstones' deletedBy and papers' addedBy.
 *   label: the library's name (GET /shared `name`, e.g. '전체 공용 서재', '봄당 서재').
 * @returns {Promise<Library>}
 */
export async function openSharedLibrary({
  relayUrl, code, lib = 'team', libraryId, rootPrefix, personId, name, personName, label, branch = 'main', getConfig,
  dbName, db, syncOptions,
} = {}) {
  if (!SHARED_LIB_RE.test(String(lib))) throw new TypeError(`invalid shared library id: ${lib}`);
  const codeLibrary = lib === CODE_LIBRARY;
  const root = codeLibrary ? codeLibraryPrefix(libraryId) : String(rootPrefix ?? '');
  const libraryKey = codeLibrary ? root.slice('codes/'.length, -1) : '';
  if (root && !ROOT_PREFIX_RE.test(root)) throw new TypeError(`invalid rootPrefix: ${root}`);
  const display = String(label || (codeLibrary ? '초대 코드 서재' : '공용 서재'));
  let configFn;
  let pid = personId == null || personId === '' ? '' : String(personId);
  if (typeof getConfig === 'function') {
    configFn = () => {
      const c = getConfig();
      return c ? { ...c, proxy: true } : null;
    };
    if (!pid) pid = await personIdFor(getConfig()?.token ?? code);
  } else {
    const base = normalizeRelayUrl(relayUrl);
    if (!base) throw new Error('초대 코드 서버 주소가 올바르지 않습니다. 설정 → 초대 코드에서 서버 주소를 확인하세요.');
    const token = normalizeInviteCode(code) || String(code ?? '').trim();
    if (!token) throw new Error('초대 코드가 없습니다. 설정에서 초대 코드를 입력해 주세요.');
    if (!pid) pid = await personIdFor(token);
    const apiBase = `${base}/shared/${lib}/gh`;
    const cfg = { owner: 'team', repo: 'library', branch, token, apiBase, proxy: true };
    // Same person (code) and library: data cached here always belongs to this library, even when the relay's
    // address changes, so the engine may push it there without asking (GitHubClient.target format).
    cfg.carryOver = new GitHubClient({ ...cfg, rootPrefix: root }).target;
    configFn = () => ({ ...cfg });
  }
  if (!PERSON_ID_RE.test(pid)) throw new TypeError(`invalid personId: ${pid}`);
  return Library.open({
    id: `shared:${lib}`,
    label: display,
    dbName: db ? undefined : dbName || sharedDbName(lib, pid, libraryKey),
    db,
    getConfig: configFn,
    personalPrefix: `people/${pid}/`,
    rootPrefix: root,
    retainPdfOnDelete: true,
    shared: true,
    personName: personName !== undefined ? personName : name ?? '',
    syncOptions,
  });
}

/** Relay origin (+ optional path) without a trailing slash: https, or http on a loopback address; '' if invalid. */
function normalizeRelayUrl(raw) {
  const s = String(raw ?? '').trim().replace(/\/+$/, '');
  try {
    const u = new URL(s);
    const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
    if ((u.protocol === 'https:' || (u.protocol === 'http:' && loopback)) && !u.search && !u.hash && !u.username && !u.password) return s;
  } catch { /* invalid */ }
  return '';
}

// ---------------------------------------------------------------- helpers

/**
 * Concurrent moves on two devices can produce a parent cycle (A inside B, B inside A).
 * Detach the folder with the smallest id in each cycle so every device shows the same tree.
 */
function breakCycles(parentOf) {
  const done = new Set();
  for (const start of parentOf.keys()) {
    const path = [];
    const onPath = new Set();
    let cur = start;
    while (cur != null && !done.has(cur) && !onPath.has(cur)) {
      path.push(cur);
      onPath.add(cur);
      cur = parentOf.get(cur) ?? null;
    }
    if (cur != null && onPath.has(cur)) {
      const cycle = path.slice(path.indexOf(cur));
      parentOf.set(cycle.reduce((a, b) => (String(a) < String(b) ? a : b)), null);
    }
    for (const id of path) done.add(id);
  }
}

function normalizeLibrary(raw) {
  const isRecord = (x) => x && typeof x === 'object' && typeof x.id === 'string' && x.id;
  return {
    ...(raw && typeof raw === 'object' ? raw : {}),
    version: 1,
    updatedAt: raw?.updatedAt ?? 0,
    folders: Array.isArray(raw?.folders) ? raw.folders.filter(isRecord).map((f) => ({ ...f })) : [],
    papers: Array.isArray(raw?.papers) ? raw.papers.filter(isRecord).map((p) => ({ ...p })) : [],
  };
}

/** Bump updatedAt, strictly increasing so two edits in one millisecond still order correctly. */
function touch(item) {
  item.updatedAt = Math.max(Date.now(), toMillis(item.updatedAt) + 1);
}

/** Back from the 휴지통. */
function untomb(item) {
  delete item.deleted;
  delete item.deletedAt;
  delete item.deletedBy;
  touch(item);
}

function trashItem(kind, record, name, deletedAt, expired) {
  return Object.freeze({
    ...record,
    kind,
    name,
    deletedAt,
    deletedBy: typeof record.deletedBy === 'string' && record.deletedBy ? record.deletedBy : null,
    expiresAt: deletedAt + TRASH_RETENTION_MS,
    expired,
  });
}

/** ‘title’ for activity text (clipped). */
function q(text) {
  return `‘${clip(text)}’`;
}

function clip(text, max = 40) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** "a · b · c 외 2건", at most `max` characters. */
function joinLimited(parts, max) {
  let out = '';
  for (let i = 0; i < parts.length; i++) {
    const next = out ? `${out} · ${parts[i]}` : parts[i];
    const rest = parts.length - i - 1;
    const tail = rest ? ` 외 ${rest}건` : '';
    if (out && (next + tail).length > max) return `${out} 외 ${parts.length - i}건`;
    out = next;
  }
  return out.length > max ? `${out.slice(0, max - 1)}…` : out;
}

function count(v) {
  return Number.isInteger(v) && v > 0 ? v : 0;
}

function cleanName(name, label) {
  const s = String(name ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s) throw new Error(`${label}을(를) 입력하세요.`);
  if (s.length > MAX_NAME_LENGTH) throw new Error(`${label}이(가) 너무 깁니다 (최대 ${MAX_NAME_LENGTH}자).`);
  return s;
}

function cleanText(v) {
  return typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, 1000) : '';
}

function cleanYear(v) {
  const n = Number(v);
  return Number.isInteger(n) && n >= 1000 && n <= 9999 ? n : null;
}

/** PDF bytes that addPaper accepts (Korean errors otherwise). */
function checkedPdf(bytes) {
  const pdf = toBytes(bytes);
  if (!pdf.byteLength) throw new Error('빈 파일은 추가할 수 없습니다.');
  if (pdf.byteLength > LIMITS.maxPdfBytes) {
    throw new Error(`파일이 너무 큽니다 (${formatBytes(pdf.byteLength)}). 최대 ${formatBytes(LIMITS.maxPdfBytes)}까지 추가할 수 있습니다.`);
  }
  if (!looksLikePdf(pdf)) throw new Error('PDF 파일이 아닙니다. 손상되었거나 다른 형식의 파일일 수 있습니다.');
  return pdf;
}

function toBytes(bytes) {
  if (bytes instanceof Uint8Array) return bytes;
  if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
  if (ArrayBuffer.isView(bytes)) return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  throw new Error('PDF 데이터를 읽지 못했습니다.');
}

/** "%PDF-" within the first 1 KB (the PDF spec tolerates leading junk). */
function looksLikePdf(u8) {
  const head = u8.subarray(0, Math.min(1024, u8.byteLength));
  for (let i = 0; i + 4 < head.length; i++) {
    if (head[i] === 0x25 && head[i + 1] === 0x50 && head[i + 2] === 0x44 && head[i + 3] === 0x46 && head[i + 4] === 0x2d) return true;
  }
  return false;
}

async function sha256Hex(bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}

function assertKind(kind) {
  if (!DATA_KINDS.has(kind)) throw new TypeError(`unknown paper data kind: ${kind}`);
}

let persistPromise = null;
/**
 * Ask (once per page) that local-first data not be evicted under storage pressure.
 * @returns {Promise<boolean|null>} granted, or null when unsupported
 */
function requestPersistentStorage() {
  persistPromise ??= (async () => {
    try {
      if (!navigator.storage?.persist) return null;
      if (await navigator.storage.persisted?.()) return true;
      return Boolean(await navigator.storage.persist());
    } catch { return null; }
  })();
  return persistPromise;
}
