// Library model (SPEC §2.3): folders, papers and per-paper data files on top of the sync engine.
// Mutations are synchronous for the UI; library.json is written to IndexedDB right after each one
// (coalesced) and pushed to GitHub by the SyncEngine. Deletions are tombstones so they sync.
import { emit } from '../core/bus.js';
import { LIMITS } from '../core/config.js';
import { formatBytes, safeStorage, uid } from '../core/util.js';
import { db as defaultDb } from './db.js';
import { SyncEngine, deepEqual, mergeLibrary, toMillis } from './sync.js';

const LIBRARY_PATH = 'library.json';
/** Synchronous last-resort copy of unsaved library changes, written when the page is hidden or closed. */
const JOURNAL_KEY = 'pr.store.libraryJournal.v1';
const DATA_KINDS = new Set(['translation', 'annotations', 'ai']);
const MAX_NAME_LENGTH = 200;
/** Fields of a paper that only the library itself may change. */
const PROTECTED_PAPER_FIELDS = new Set(['id', 'addedAt', 'updatedAt', 'deleted', 'size']);

/** Repo path of one of a paper's files ('paper.pdf', 'translation.json', …). */
export const paperPath = (paperId, file) => `papers/${paperId}/${file}`;

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

  /**
   * Open the local library and resume sync when GitHub is configured (the first pull runs in the
   * background; 'change' fires when remote data arrives).
   * @param {{ settings?: { get(): any }, db?: object, sync?: SyncEngine, syncOptions?: object }} opts
   */
  static async open({ settings, db = defaultDb, sync, syncOptions } = {}) {
    await db.ready?.();
    const engine = sync || new SyncEngine({ db, getConfig: () => settings?.get?.().github ?? null, ...syncOptions });
    const library = new Library(engine, db);
    await library.#load();
    // Local-first data must not be evicted under storage pressure — on every device, not only the one that
    // added the PDFs (a reading-only device may hold unpushed notes and translations).
    library.#persisted = requestPersistentStorage();
    await engine.start();
    return library;
  }

  /** Use Library.open(). */
  constructor(sync, db = defaultDb) {
    super();
    this.#sync = sync;
    this.#db = db;
    this.#data = normalizeLibrary(null);
  }

  #db;

  // ------------------------------------------------------------------ reads

  /** Live folders (tombstones hidden). A parent that was deleted resolves to its nearest live ancestor. */
  get folders() { return this.#ensureView().folders; }

  /** Live papers, newest first. A folder that was deleted resolves to its nearest live ancestor. */
  get papers() { return this.#ensureView().papers; }

  getPaper(id) { return this.#ensureView().paperById.get(id) ?? null; }
  getFolder(id) { return this.#ensureView().folderById.get(id) ?? null; }

  get sync() { return this.#sync; }

  // ---------------------------------------------------------------- folders

  createFolder(name, parentId = null) {
    const clean = cleanName(name, '폴더 이름');
    const parent = parentId == null ? null : this.#requireFolder(parentId).id;
    const now = Date.now();
    const folder = { id: uid('f'), name: clean, parentId: parent, createdAt: now, updatedAt: now };
    this.#data.folders.push(folder);
    this.#changed('folder');
    return this.getFolder(folder.id);
  }

  renameFolder(id, name) {
    const clean = cleanName(name, '폴더 이름');
    const folder = this.#rawFolder(id);
    if (folder.name === clean) return;
    folder.name = clean;
    touch(folder);
    this.#changed('folder');
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
  }

  /** Tombstone the folder; its subfolders and papers move up to its parent. */
  deleteFolder(id) {
    const folder = this.#rawFolder(id);
    const view = this.#ensureView();
    const newParent = view.folderById.get(id).parentId;
    for (const f of this.#data.folders) {
      if (!f.deleted && f.id !== id && view.folderById.get(f.id)?.parentId === id) { f.parentId = newParent; touch(f); }
    }
    for (const p of this.#data.papers) {
      if (!p.deleted && view.paperById.get(p.id)?.folderId === id) { p.folderId = newParent; touch(p); }
    }
    folder.deleted = true;
    touch(folder);
    this.#changed('folder');
  }

  // ----------------------------------------------------------------- papers

  /**
   * Store the PDF locally, then add the paper record.
   * @param {Uint8Array|ArrayBuffer} bytes
   * @param {{ fileName?: string, folderId?: string|null, meta?: { title?, authors?, year?, pages? } }} opts
   */
  async addPaper(bytes, { fileName = '', folderId = null, meta = {} } = {}) {
    const pdf = toBytes(bytes);
    if (!pdf.byteLength) throw new Error('빈 파일은 추가할 수 없습니다.');
    if (pdf.byteLength > LIMITS.maxPdfBytes) {
      throw new Error(`파일이 너무 큽니다 (${formatBytes(pdf.byteLength)}). 최대 ${formatBytes(LIMITS.maxPdfBytes)}까지 추가할 수 있습니다.`);
    }
    if (!looksLikePdf(pdf)) throw new Error('PDF 파일이 아닙니다. 손상되었거나 다른 형식의 파일일 수 있습니다.');
    if (folderId != null) this.#requireFolder(folderId);

    const id = uid('p');
    await this.#sync.writeFile(paperPath(id, 'paper.pdf'), pdf);
    requestPersistentStorage();
    const now = Date.now();
    const name = String(fileName || '').trim();
    const paper = {
      id,
      title: cleanText(meta?.title) || name.replace(/\.pdf$/i, '') || '제목 없음',
      authors: cleanText(meta?.authors),
      year: cleanYear(meta?.year),
      fileName: name || `${id}.pdf`,
      size: pdf.byteLength,
      pages: Number.isInteger(meta?.pages) && meta.pages > 0 ? meta.pages : 0,
      folderId: folderId != null && this.getFolder(folderId) ? folderId : null,
      starred: false,
      addedAt: now,
      updatedAt: now,
      lastOpenedAt: null,
      translatedCount: 0,
      sentenceCount: 0,
    };
    this.#data.papers.push(paper);
    this.#changed('paper');
    return this.getPaper(id);
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
    Object.assign(paper, changes);
    touch(paper);
    this.#changed('paper');
    return this.getPaper(id);
  }

  movePaper(id, folderId) {
    return this.updatePaper(id, { folderId: folderId ?? null });
  }

  /** Tombstone the paper and delete its PDF, translation, annotations and AI data. */
  deletePaper(id) {
    const paper = this.#rawPaper(id);
    paper.deleted = true;
    touch(paper);
    this.#changed('paper');
    this.#deletePaperFiles(id).catch((err) => console.warn('[store] delete paper files', id, err));
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
    assertKind(kind);
    const value = await this.#sync.readFile(paperPath(id, `${kind}.json`), { as: 'json' });
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
    const stored = await this.#sync.writeFile(paperPath(id, `${kind}.json`), obj, { base });
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
      const current = await this.#sync.readFile(paperPath(id, `${kind}.json`), { as: 'json' });
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
   * Remove everything this device stores for the app: the library, PDFs, translations, notes, AI results and
   * sync state (IndexedDB), and the unsaved-change journal. Nothing is deleted on GitHub. The page should be
   * reloaded afterwards.
   */
  async wipeLocalData() {
    this.#listening.abort();
    this.#sync.stop();
    await this.#writeChain.catch(() => {});
    safeStorage.remove(JOURNAL_KEY);
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
    const journal = safeStorage.get(JOURNAL_KEY, null);
    if (journal?.data) {
      // The previous page closed before its last changes reached IndexedDB. The journal carries the stored
      // version those changes were made on, so the replay is a 3-way merge (it cannot revert newer fields).
      const base = journal.base ? normalizeLibrary(journal.base) : null;
      this.#data = normalizeLibrary(mergeLibrary(normalizeLibrary(journal.data), this.#data, base));
      this.#rev++;
      await this.#persist();
      if (this.#savedRev === this.#rev) safeStorage.remove(JOURNAL_KEY);
    }
    const { signal } = this.#listening;
    this.#sync.addEventListener('status', (e) => emit(this, 'syncstatus', e.detail), { signal });
    this.#sync.addEventListener('remotechange', (e) => {
      this.#onRemoteChange(e.detail).catch((err) => console.warn('[store] remote change', err));
    }, { signal });
    this.#sync.addEventListener('rejected', (e) => this.#onRejected(e.detail), { signal });
    if (typeof window !== 'undefined') {
      // Leaving or backgrounding the page: keep a synchronous copy of unsaved changes, and push what
      // is pending now instead of waiting for the debounce.
      const flush = () => {
        if (this.#rev !== this.#savedRev) {
          safeStorage.set(JOURNAL_KEY, { at: Date.now(), rev: this.#rev, data: this.#data, base: this.#base });
          this.#journalWritten = true;
        }
        this.flush().catch((err) => console.warn('[store] flush', err));
      };
      window.addEventListener('pagehide', flush, { signal });
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(); }, { signal });
    }
    this.#gcDeletedPapers().catch((err) => console.warn('[store] gc', err));
  }

  async #onRemoteChange({ paths = [], origin } = {}) {
    if (!paths.includes(LIBRARY_PATH) || origin === 'merge') return;
    // Reads and writes of library.json go through one chain, so stored versions are absorbed in the order
    // IndexedDB holds them (an older write result can never overwrite a newer pulled version in memory).
    const step = this.#writeChain.then(async () => {
      const stored = await this.#sync.readFile(LIBRARY_PATH, { as: 'json' });
      if (stored) this.#absorb(stored, 'remote');
    });
    this.#writeChain = step.catch((err) => console.warn('[store] reading library.json failed', err));
    await step;
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

  /** GitHub refused to store one file (e.g. a PDF over its size limit): say which paper, keep syncing the rest. */
  #onRejected({ path, code, message } = {}) {
    const m = /^papers\/([^/]+)\/([^/]+)$/.exec(path || '');
    const paper = m ? this.#data.papers.find((p) => p.id === m[1]) : null;
    const what = paper ? `‘${paper.title || paper.fileName}’의 ${m[2] === 'paper.pdf' ? 'PDF' : '데이터'}` : path;
    const why = code === 'too_large' ? '파일이 너무 커서' : 'GitHub가 받아 주지 않아';
    emit(this, 'error', {
      message: `${what}를 ${why} GitHub에 올리지 못했습니다. 이 기기에는 그대로 남아 있고, 나머지는 계속 동기화됩니다.${paper ? ' 다른 기기에서도 보려면 더 작은 PDF로 다시 추가하세요.' : ''}`,
      error: Object.assign(new Error(message || ''), { code }),
      path,
    });
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
          safeStorage.remove(JOURNAL_KEY);
          this.#journalWritten = false;
        }
      } catch (err) {
        console.warn('[store] saving library.json failed', err);
        emit(this, 'error', { message: err?.message || '라이브러리를 저장하지 못했습니다.', error: err });
      }
    });
    return this.#writeChain;
  }

  /** Remove leftover files of tombstoned papers (e.g. edited on another device while being deleted). */
  async #gcDeletedPapers() {
    for (const paper of this.#data.papers) {
      if (!paper.deleted) continue;
      for (const path of await this.#sync.listPaths(`papers/${paper.id}/`)) await this.#sync.deleteFile(path);
    }
  }

  async #deletePaperFiles(id) {
    for (const path of await this.#sync.listPaths(`papers/${id}/`)) await this.#sync.deleteFile(path);
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
