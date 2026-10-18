// Highlights & notes of one paper: CRUD with tombstones, debounced persistence through
// Library.savePaperData(id, 'annotations', …), and rendering as viewer/pane mark layers.
import { emit } from '../core/bus.js';
import { debounce, uid } from '../core/util.js';
import { toast } from '../ui/components.js';
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
  if (raw.deleted) item.deleted = true;
  return item;
}

/**
 * Events: 'change' { reason: 'load'|'add'|'update'|'remove'|'restore'|'remote', item? }, 'error' { message, error }.
 */
export class AnnotationStore extends EventTarget {
  /** @type {Map<string, Annotation>} */
  #byId = new Map();
  #loaded = false;
  #loadError = null;
  #ready = null;
  #dirty = false;
  #saving = Promise.resolve();
  #saveSoon;

  constructor({ library, paperId, saveDelay = SAVE_DELAY_MS }) {
    super();
    this.library = library;
    this.paperId = paperId;
    this.#saveSoon = debounce(() => { this.#persist(); }, saveDelay);
  }

  get loaded() { return this.#loaded; }

  /** Resolves once stored annotations have been read (never rejects; see 'error'). */
  get ready() {
    this.#ready ??= this.reload();
    return this.#ready;
  }

  /** (Re)read the stored file and merge it with in-memory state. */
  async reload() {
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
   * Merge records from elsewhere (stored file, remote sync) by id.
   * @returns {boolean} whether anything changed
   */
  merge(records, { silent = false } = {}) {
    let changed = false;
    for (const raw of records) {
      const item = sanitize(raw);
      if (!item) continue;
      const cur = this.#byId.get(item.id);
      if (!cur || supersedes(item, cur)) {
        this.#byId.set(item.id, item);
        changed = true;
      }
    }
    if (changed && !silent) this.#changed('remote');
    return changed;
  }

  toJSON() {
    return { version: 1, updatedAt: Date.now(), items: this.records };
  }

  /** Write pending changes now (e.g. when the paper closes). */
  async flush() {
    this.#saveSoon.cancel();
    if (this.#dirty) await this.#persist();
    else await this.#saving;
  }

  dispose() {
    this.#saveSoon.cancel();
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
    const run = async () => {
      // Never write before the stored file has been read: that would drop records we never saw.
      await this.ready;
      if (this.#loadError) {
        await this.reload();
        if (this.#loadError) throw this.#loadError;
      }
      await this.library.savePaperData(this.paperId, 'annotations', this.toJSON());
    };
    this.#saving = this.#saving.then(run).catch((err) => {
      console.warn('[features] annotations save failed', err);
      this.#dirty = true;
      emit(this, 'error', { message: '하이라이트를 저장하지 못했습니다. 잠시 후 다시 시도합니다.', error: err });
    });
    return this.#saving;
  }
}

/** Mark objects for PdfViewer/TranslationPane.setMarks('annotations', …). */
export function annotationMarks(items) {
  return items.map((a) => {
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
}
