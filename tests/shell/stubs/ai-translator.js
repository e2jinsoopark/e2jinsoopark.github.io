// Test stub for js/ai/translator.js — deterministic, offline. p3-4 and p3-5 fail on the first attempt only.
import { emit } from '/js/core/bus.js';
import { settings } from '/js/core/settings.js';
import { hash } from '/js/core/util.js';
import { koFor } from './ko.js';

const failOnce = new Set(['p3-4', 'p3-5']);
const BATCH = 6;
const DELAY = Number(new URLSearchParams(location.search).get('trdelay') || 90);

export class Translator extends EventTarget {
  constructor({ doc, cached, save }) {
    super();
    this.doc = doc;
    this.save = save;
    this.map = new Map();
    this.cost = 0;
    this.cancelled = false;
    this.calls = [];
    for (const [sid, item] of Object.entries(cached?.items || {})) {
      const s = doc.sentenceById.get(sid);
      if (s && item.h === hash(s.text)) this.map.set(sid, item.t);
    }
    window.__stubTranslator = this;
  }

  #translatable(s) {
    if (s.kind === 'reference') return settings.get().translate.translateReferences;
    return ['body', 'heading', 'caption'].includes(s.kind);
  }

  get translations() { return this.map; }
  get progress() {
    const all = this.doc.sentences.filter((s) => this.#translatable(s));
    return { done: all.filter((s) => this.map.has(s.sid)).length, total: all.length, costUsd: this.cost };
  }

  async translateAll({ startPage = 1 } = {}) {
    this.calls.push(['translateAll', startPage]);
    const list = this.doc.sentences.filter((s) => this.#translatable(s) && !this.map.has(s.sid));
    const ordered = [...list.filter((s) => s.page >= startPage), ...list.filter((s) => s.page < startPage)];
    return this.#run(ordered.map((s) => s.sid));
  }
  async translatePages(pages) {
    this.calls.push(['translatePages', pages]);
    return this.#run(this.doc.sentences.filter((s) => pages.includes(s.page) && this.#translatable(s) && !this.map.has(s.sid)).map((s) => s.sid));
  }
  async translateSids(sids) {
    this.calls.push(['translateSids', sids]);
    return this.#run(sids.filter((sid) => !this.map.has(sid)));
  }
  cancel() { this.calls.push(['cancel']); this.cancelled = true; }

  async #run(sids) {
    this.cancelled = false;
    for (let i = 0; i < sids.length; i += BATCH) {
      if (this.cancelled) break;
      await new Promise((r) => setTimeout(r, DELAY));
      if (this.cancelled) break;
      const batch = sids.slice(i, i + BATCH);
      const done = [];
      for (const sid of batch) {
        if (failOnce.has(sid)) { failOnce.delete(sid); continue; }
        this.map.set(sid, koFor(this.doc.sentenceById.get(sid), i));
        done.push(sid);
      }
      this.cost += 0.0007 * batch.length;
      emit(this, 'update', { sids: batch });
      emit(this, 'progress', this.progress);
      this.save?.(this.#serialize());
    }
    emit(this, 'done', {});
  }

  #serialize() {
    const items = {};
    for (const [sid, t] of this.map) items[sid] = { h: hash(this.doc.sentenceById.get(sid).text), t, m: 'mock' };
    return { version: 1, targetLang: 'ko', segVersion: 1, items };
  }
}
