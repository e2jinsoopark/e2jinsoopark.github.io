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
  #listening = new AbortController();

  /**
   * Open the local library and resume sync when GitHub is configured (the first pull runs in the
   * background; 'change' fires when remote data arrives).
   * @param {{ settings?: { get(): any }, db?: object, sync?: SyncEngine, syncOptions?: object }} opts
   */
  static async open({ settings, db = defaultDb, sync, syncOptions } = {}) {
    await db.ready?.();
    const engine = sync || new SyncEngine({ db, getConfig: () => settings?.get?.().github ?? null, ...syncOptions });
    const library = new Library(engine);
    await library.#load();
    await engine.start();
    return library;
  }

  /** Use Library.open(). */
  constructor(sync) {
    super();
    this.#sync = sync;
    this.#data = normalizeLibrary(null);
  }

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

  /** Persist a per-paper data file (SPEC §2.2); sets `obj.updatedAt`. */
  async savePaperData(id, kind, obj) {
    assertKind(kind);
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new TypeError('savePaperData: obj must be an object');
    obj.updatedAt = Date.now();
    obj.version ??= 1;
    await this.#sync.writeFile(paperPath(id, `${kind}.json`), obj);
    emit(this, 'change', { reason: 'data', paperId: id, kind });
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
    const journal = safeStorage.get(JOURNAL_KEY, null);
    if (journal?.data) {
      // The previous page closed before its last changes reached IndexedDB.
      this.#data = normalizeLibrary(mergeLibrary(normalizeLibrary(journal.data), this.#data, null));
      this.#rev++;
      await this.#persist();
      if (this.#savedRev === this.#rev) safeStorage.remove(JOURNAL_KEY);
    }
    const { signal } = this.#listening;
    this.#sync.addEventListener('status', (e) => emit(this, 'syncstatus', e.detail), { signal });
    this.#sync.addEventListener('remotechange', (e) => {
      this.#onRemoteChange(e.detail).catch((err) => console.warn('[store] remote change', err));
    }, { signal });
    if (typeof window !== 'undefined') {
      // Leaving or backgrounding the page: keep a synchronous copy of unsaved changes, and push what
      // is pending now instead of waiting for the debounce.
      const flush = () => {
        if (this.#rev !== this.#savedRev) safeStorage.set(JOURNAL_KEY, { at: Date.now(), data: this.#data });
        this.flush().catch((err) => console.warn('[store] flush', err));
      };
      window.addEventListener('pagehide', flush, { signal });
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(); }, { signal });
    }
    this.#gcDeletedPapers().catch((err) => console.warn('[store] gc', err));
  }

  async #onRemoteChange({ paths = [], origin } = {}) {
    if (!paths.includes(LIBRARY_PATH) || origin === 'merge') return;
    const stored = await this.#sync.readFile(LIBRARY_PATH, { as: 'json' });
    if (stored) this.#absorb(stored, 'remote');
    await this.#gcDeletedPapers();
  }

  /** Merge another version of library.json into memory (memory wins ties). */
  #absorb(other, reason) {
    const merged = mergeLibrary(this.#data, normalizeLibrary(other), null);
    if (deepEqual(merged, this.#data)) return;
    this.#data = normalizeLibrary(merged);
    this.#view = null;
    emit(this, 'change', { reason });
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
      try {
        const stored = await this.#sync.writeFile(LIBRARY_PATH, snapshot);
        this.#savedRev = Math.max(this.#savedRev, rev);
        if (stored !== snapshot) this.#absorb(stored, 'merge'); // another tab had changes we did not see
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

let persistRequested = false;
/** Ask once, when the first PDF is stored, that local-first data not be evicted under storage pressure. */
function requestPersistentStorage() {
  if (persistRequested) return;
  persistRequested = true;
  try { navigator.storage?.persist?.().catch(() => {}); } catch { /* unsupported */ }
}
