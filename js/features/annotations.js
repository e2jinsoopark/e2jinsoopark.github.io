// Highlights & notes of one paper: CRUD with tombstones, debounced persistence through
// Library.savePaperData(id, 'annotations', …), and rendering as viewer/pane mark layers.
import { emit } from '../core/bus.js';
import { debounce, uid } from '../core/util.js';
import { toast } from '../ui/components.js';
import { mergeRecords } from '../store/merge.js';
import { toMillis } from './shared.js';

export const ANNOTATION_COLORS = Object.freeze(['yellow', 'green', 'blue', 'pink']);
const SAVE_DELAY_MS = 600;

/**
 * @typedef {{ id: string, anchor: { start: number, end: number }, quote: string,
 *   color: 'yellow'|'green'|'blue'|'pink', note: string, createdAt: number, updatedAt: number,
 *   deleted?: true }} Annotation
 */

const normalizeColor = (c) => (ANNOTATION_COLORS.includes(c) ? c : 'yellow');

const byPosition = (a, b) => a.anchor.start - b.anchor.start
  || a.anchor.end - b.anchor.end
  || toMillis(a.createdAt) - toMillis(b.createdAt);

/** Same rule as the sync merge: newer updatedAt wins; on a tie the tombstone wins. */
function supersedes(candidate, current) {
  const a = toMillis(candidate.updatedAt);
  const b = toMillis(current.updatedAt);
  return a > b || (a === b && Boolean(candidate.deleted) && !current.deleted);
}

/** Coerce a stored record into a valid Annotation, or null if it is unusable. */
function sanitize(raw) {
  const start = Number(raw?.anchor?.start);
  const end = Number(raw?.anchor?.end);
  if (!raw || typeof raw.id !== 'string' || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  const item = {
    id: raw.id,
    anchor: { start, end },
    quote: String(raw.quote ?? ''),
    color: normalizeColor(raw.color),
    note: String(raw.note ?? ''),
    createdAt: raw.createdAt ?? raw.updatedAt ?? 0,
    updatedAt: raw.updatedAt ?? raw.createdAt ?? 0,
  };
  if (Number.isFinite(raw.seg)) item.seg = raw.seg;
  if (raw.deleted) item.deleted = true;
  return item;
}

const normalizeSpace = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

/**
 * Offsets are positions in doc.text, which can change when the text extraction changes (a new segmentation
 * version, a pdf.js upgrade). The quote is the source of truth: when the text at the stored offsets no longer
 * matches it, look the quote up again (nearest occurrence to the old position). Not found → `lost` (not drawn).
 */
export function reanchor(doc, item) {
  if (!doc?.text || !item.quote || item.deleted) return item;
  const { start, end } = item.anchor;
  if (normalizeSpace(doc.text.slice(start, end)) === item.quote) return item.lost ? { ...item, lost: undefined } : item;
  const pattern = item.quote.slice(0, 1000).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+');
  let best = null;
  try {
    for (const m of doc.text.matchAll(new RegExp(pattern, 'g'))) {
      if (!best || Math.abs(m.index - start) < Math.abs(best.index - start)) best = m;
    }
  } catch { /* pathological quote */ }
  if (!best) return { ...item, lost: true };
  return { ...item, anchor: { start: best.index, end: best.index + best[0].length }, lost: undefined };
}

/**
 * Events: 'change' { reason: 'load'|'add'|'update'|'remove'|'restore'|'remote', item? }, 'error' { message, error }.
 */
export class AnnotationStore extends EventTarget {
  /** @type {Map<string, Annotation>} */
  #byId = new Map();
  /** @type {Map<string, Annotation>} records as last read from / written to storage (3-way merge base) */
  #base = new Map();
  #loaded = false;
  #loadError = null;
  #ready = null;
  #dirty = false;
  #saving = Promise.resolve();
  #saveSoon;
  #retryTimer = null;
  #retryCount = 0;
  #disposed = false;

  constructor({ library, paperId, doc = null, saveDelay = SAVE_DELAY_MS }) {
    super();
    this.library = library;
    this.paperId = paperId;
    this.doc = doc;
    this.#saveSoon = debounce(() => { this.#persist(); }, saveDelay);
  }

  get loaded() { return this.#loaded; }

  /** True while changes are waiting to be written. */
  get dirty() { return this.#dirty; }

  /** Resolves once stored annotations have been read (never rejects; see 'error'). */
  get ready() {
    this.#ready ??= this.#load();
    return this.#ready;
  }

  /**
   * (Re)read the stored file and merge it with in-memory state. Queued behind pending saves, so stored
   * versions are taken in the order they were written.
   */
  reload() {
    const run = this.#saving.then(() => this.#load());
    this.#saving = run.catch(() => {});
    return run;
  }

  async #load() {
    let changed = false;
    try {
      const data = await this.library.getPaperData(this.paperId, 'annotations');
      changed = this.merge(Array.isArray(data?.items) ? data.items : [], { silent: true });
      this.#loadError = null;
    } catch (err) {
      console.warn('[features] annotations load failed', err);
      this.#loadError = err;
    }
    const first = !this.#loaded;
    this.#loaded = true;
    if (first || changed) this.#changed(first ? 'load' : 'remote');
  }

  /** Live annotations sorted by position. */
  get items() {
    return [...this.#byId.values()].filter((a) => !a.deleted).sort(byPosition);
  }

  /** All records including tombstones — what gets persisted. */
  get records() {
    return [...this.#byId.values()].sort(byPosition);
  }

  get(id) {
    const a = this.#byId.get(id);
    return a && !a.deleted ? a : null;
  }

  findExact(start, end) {
    return this.items.find((a) => a.anchor.start === start && a.anchor.end === end) ?? null;
  }

  overlapping(start, end) {
    return this.items.filter((a) => a.anchor.start < end && a.anchor.end > start);
  }

  add({ start, end, quote = '', color = 'yellow', note = '' }) {
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      throw new Error('하이라이트할 범위가 올바르지 않습니다.');
    }
    const now = Date.now();
    const item = {
      id: uid('a'), anchor: { start, end }, quote: String(quote).replace(/\s+/g, ' ').trim(),
      color: normalizeColor(color), note: String(note), createdAt: now, updatedAt: now,
    };
    if (Number.isFinite(this.doc?.segVersion)) item.seg = this.doc.segVersion;
    this.#byId.set(item.id, item);
    this.#touch('add', item);
    return item;
  }

  /** Patch color and/or note of a live annotation. */
  update(id, patch = {}) {
    const cur = this.get(id);
    if (!cur) return null;
    const next = { ...cur, updatedAt: this.#stampAfter(cur) };
    if ('color' in patch) next.color = normalizeColor(patch.color);
    if ('note' in patch) next.note = String(patch.note ?? '');
    this.#byId.set(id, next);
    this.#touch('update', next);
    return next;
  }

  /** Tombstone an annotation (kept so the deletion syncs). Returns the removed item. */
  remove(id) {
    const cur = this.get(id);
    if (!cur) return null;
    this.#byId.set(id, { ...cur, deleted: true, updatedAt: this.#stampAfter(cur) });
    this.#touch('remove', cur);
    return cur;
  }

  /** Undo a removal; the restored record gets a newer updatedAt so it beats the tombstone everywhere. */
  restore(id) {
    const cur = this.#byId.get(id);
    if (!cur?.deleted) return this.get(id);
    const { deleted, ...rest } = cur;
    const next = { ...rest, updatedAt: this.#stampAfter(cur) };
    this.#byId.set(id, next);
    this.#touch('restore', next);
    return next;
  }

  /**
   * Merge stored records (the file, a remote sync) by id. When the stored version an item was last read as
   * is known, the merge is 3-way: a field changed only in storage (color on one device) and a field changed
   * only here (note on this one) both survive, whatever the stamps say. Otherwise the newer updatedAt wins
   * (a tombstone wins a tie).
   * @returns {boolean} whether anything changed
   */
  merge(records, { silent = false } = {}) {
    let changed = false;
    for (const raw of records) {
      const clean = sanitize(raw);
      if (!clean) continue;
      const item = reanchor(this.doc, clean);
      const cur = this.#byId.get(item.id);
      const base = this.#base.get(item.id);
      let next;
      if (!cur) next = item;
      else if (base && toMillis(item.updatedAt) < toMillis(base.updatedAt)) next = null; // an older copy
      else if (base) next = reanchor(this.doc, sanitize(mergeRecords([cur], [item], [base])[0]));
      else next = supersedes(item, cur) ? item : null;
      if (!base || toMillis(item.updatedAt) >= toMillis(base.updatedAt)) this.#base.set(item.id, item);
      if (next && !sameAnnotation(next, cur)) {
        this.#byId.set(item.id, next);
        changed = true;
      }
    }
    if (changed && !silent) this.#changed('remote');
    return changed;
  }

  toJSON() {
    return { version: 1, updatedAt: Date.now(), items: this.records.map(({ lost, ...rest }) => rest) };
  }

  /** Write pending changes now (e.g. when the paper closes or the page is hidden). */
  async flush() {
    this.#saveSoon.cancel();
    clearTimeout(this.#retryTimer);
    if (this.#dirty) await this.#persist();
    else await this.#saving;
  }

  dispose() {
    this.#disposed = true;
    this.#saveSoon.cancel();
    clearTimeout(this.#retryTimer);
  }

  /** Strictly increasing per record, so quick remove→restore never ties with the tombstone. */
  #stampAfter(cur) {
    return Math.max(Date.now(), toMillis(cur.updatedAt) + 1);
  }

  #touch(reason, item) {
    this.#dirty = true;
    this.#saveSoon();
    this.#changed(reason, item);
  }

  #changed(reason, item) {
    emit(this, 'change', { reason, item });
  }

  #persist() {
    this.#dirty = false;
    clearTimeout(this.#retryTimer);
    const run = async () => {
      // Never write before the stored file has been read: that would drop records we never saw.
      await this.ready;
      if (this.#loadError) {
        await this.#load();
        if (this.#loadError) throw this.#loadError;
      }
      const base = { version: 1, items: [...this.#base.values()] };
      const stored = await this.library.savePaperData(this.paperId, 'annotations', this.toJSON(), { base });
      this.#retryCount = 0;
      // What is stored may hold records another tab or device added meanwhile; take them in (and use the
      // stored version as the base for the next merge).
      if (stored && Array.isArray(stored.items)) this.merge(stored.items);
    };
    this.#saving = this.#saving.then(run).catch((err) => {
      console.warn('[features] annotations save failed', err);
      this.#dirty = true;
      if (this.#retryCount === 0) {
        emit(this, 'error', { message: '하이라이트를 저장하지 못했습니다. 잠시 후 다시 시도합니다.', error: err });
      }
      // Try again with backoff (5 s, 15 s, 60 s, …); the error is reported once per failure streak.
      const delay = [5_000, 15_000, 60_000][Math.min(this.#retryCount, 2)];
      this.#retryCount++;
      if (!this.#disposed) this.#retryTimer = setTimeout(() => { if (this.#dirty) this.#persist(); }, delay);
    });
    return this.#saving;
  }
}

function sameAnnotation(a, b) {
  return Boolean(a && b) && a.id === b.id && a.anchor.start === b.anchor.start && a.anchor.end === b.anchor.end
    && a.quote === b.quote && a.color === b.color && a.note === b.note && toMillis(a.updatedAt) === toMillis(b.updatedAt)
    && Boolean(a.deleted) === Boolean(b.deleted);
}

/** Mark objects for PdfViewer/TranslationPane.setMarks('annotations', …). */
export function annotationMarks(items) {
  return items.filter((a) => !a.lost).map((a) => {
    const mark = { id: a.id, start: a.anchor.start, end: a.anchor.end, color: a.color, style: 'fill' };
    if (a.note) mark.title = a.note;
    return mark;
  });
}

/**
 * Delete with an undo toast; shared by the highlight menu and the notes panel.
 * Uses components.toast's `action` option (the shell's extension of the SPEC signature).
 */
export function removeWithUndo(store, id) {
  const removed = store.remove(id);
  if (!removed) return;
  toast('하이라이트를 삭제했습니다.', { timeout: 6000, action: { label: '실행 취소', onClick: () => store.restore(id) } });
}

/**
 * Keep the viewer's and pane's 'annotations' layers in sync with the store, surface save
 * errors, and pick up remote edits from the sync engine.
 */
export function installAnnotationMarks(ctx, session, { signal }) {
  const store = session.annotations;
  const push = () => {
    const marks = annotationMarks(store.items);
    ctx.viewer?.setMarks?.('annotations', marks);
    ctx.pane?.setMarks?.('annotations', marks);
  };
  store.addEventListener('change', push, { signal });
  store.addEventListener('error', (e) => toast(e.detail.message, { kind: 'error' }), { signal });
  if (store.loaded) push();
  else store.ready.then(() => { if (!signal.aborted) push(); });

  const path = `papers/${ctx.paper.id}/annotations.json`;
  ctx.library?.sync?.addEventListener?.('remotechange', (e) => {
    if (e.detail?.paths?.includes(path)) store.reload();
  }, { signal });

  // Closing the tab, reloading or the laptop sleeping must not lose a highlight typed a moment ago: write pending
  // changes as soon as the page is hidden, without waiting for the save debounce.
  const flushNow = () => { if (store.dirty) store.flush().catch((err) => console.warn('[features] annotations flush', err)); };
  window.addEventListener('pagehide', flushNow, { signal });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushNow(); }, { signal });
}
