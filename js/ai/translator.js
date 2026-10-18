// Batching / caching translation orchestrator for one open paper (SPEC 3.4).
//
// - Cache: items[sid] is reused only while items[sid].h === hash(sentence.text).
// - Queue: every translate*() call puts its sentences at the FRONT of one shared queue (latest request first,
//   reading order within it); a pool of workers (settings.translate.concurrency) drains it in batches.
// - Batches: queued sentences in reading order, ≤ LIMITS.translateBatchMaxSentences and ≤ translateBatchMaxChars.
//   Each request = stable cached system prompt (rules + title/abstract/glossary) + 2 preceding source sentences.
// - The first batch of a cold run goes alone so it writes the prompt cache; the other workers start after it.
// - Ids missing from a response are retried once; a batch cut by max_tokens is split in half. Then: failed.
import { emit } from '../core/bus.js';
import { LIMITS } from '../core/config.js';
import { settings } from '../core/settings.js';
import { clamp, hash } from '../core/util.js';
import { aiError, getProvider, isAbort } from './providers.js';
import { TRANSLATION_SCHEMA, translationSystem, translationUserMessage } from './prompts.js';
import { addUsage, costUsd, emptyUsage, recordUsage } from './usage.js';

const BASE_KINDS = ['body', 'heading', 'caption'];
const CONTEXT_SENTENCES = 2;
const BATCH_MAX_TOKENS = 16000;
const MAX_CONSECUTIVE_FAILURES = 3;
const MAX_CONCURRENCY = 8;
const CACHE_WARM_MS = 4 * 60 * 1000; // prompt cache lives 5 min after the last request that used it
// Sentences without any word (numbers, symbols, "p < .05") are copied as their own translation, no API call.
const HAS_WORD = /[A-Za-z]{2,}/;
// Errors that every following batch would hit too: a daily quota, or a 400 (all batches share one request shape;
// e.g. an exhausted API credit balance is reported as a 400).
const RUN_STOPPING_CODES = new Set(['quota', 'bad_request']);

/**
 * @typedef {{ done: number, total: number, costUsd: number, failed: number, pending: number, running: boolean }} Progress
 */
export class Translator extends EventTarget {
  /**
   * @param {{ doc: object, cached?: object|null, save?: (obj: object) => Promise<void>|void,
   *           provider?: object, paperId?: string }} opts  provider/paperId are optional additions
   *           (provider defaults to getProvider() at request time; paperId tags recorded usage).
   */
  constructor({ doc, cached = null, save = null, provider = null, paperId = null }) {
    super();
    this.doc = doc;
    this._save = save;
    this._providerOverride = provider;
    this._paperId = paperId;
    this._targetLang = settings.get().translate?.targetLang || 'ko';

    this._sentences = doc?.sentences || [];
    this._byId = new Map(this._sentences.map((s) => [s.sid, s]));
    this._docIndex = new Map(this._sentences.map((s, i) => [s.sid, i]));

    /** @type {Map<string, { h: string, t: string, m: string }>} persisted entries */
    this._items = new Map();
    /** @type {Map<string, string>} everything shown: persisted + copied */
    this._map = new Map();
    this._failed = new Set();
    /** @type {Map<string, AbortSignal>} sid → signal of the run that sent it (stale runs must not touch it) */
    this._inflight = new Map();
    this._queue = [];
    this._queued = new Set();
    this._waiters = [];

    this._workers = 0;
    this._controller = null;
    this._runActive = false; // a 'done' event is owed
    this._stopped = false; // set by cancel() / a fatal error; cleared by the next translate*() call
    this._consecutiveFailures = 0;
    this._lastResponseAt = 0;
    this._costUsd = 0;
    this._usage = emptyUsage();
    this._reportedErrors = new Set();

    this._loadCache(cached);
    this._copyWordless();
  }

  /** sid → Korean text for every valid cached or newly translated sentence. Do not mutate. */
  get translations() {
    return this._map;
  }

  /** @returns {Progress} */
  get progress() {
    const sids = this._translatableSids();
    let done = 0;
    let failed = 0;
    for (const sid of sids) {
      if (this._map.has(sid)) done++;
      else if (this._failed.has(sid)) failed++;
    }
    return {
      done, total: sids.length, costUsd: this._costUsd, failed,
      pending: this._queue.length + this._inflight.size, running: this.running,
    };
  }

  /** True while any batch is queued or in flight. */
  get running() {
    return this._workers > 0 || this._queue.length > 0;
  }

  /** Token totals of this session's translation requests. */
  get usage() {
    return { ...this._usage };
  }

  /** 'done' | 'pending' | 'failed' | null for one sentence. */
  statusOf(sid) {
    if (this._map.has(sid)) return 'done';
    if (this._inflight.has(sid) || this._queued.has(sid)) return 'pending';
    if (this._failed.has(sid)) return 'failed';
    return null;
  }

  /** Translation data file contents (SPEC 2.2 kind 'translation'). */
  toJSON() {
    return {
      version: 1,
      targetLang: this._targetLang,
      segVersion: this.doc?.segVersion ?? null,
      updatedAt: Date.now(),
      items: Object.fromEntries(this._items),
    };
  }

  /**
   * Take in translations from a newer copy of the translation file (another device or tab synced it).
   * Sentences already translated here are kept; queued ones are skipped by the workers once present.
   * Emits 'update' and 'progress' when anything was added. Returns the added sids.
   */
  mergeCached(cached) {
    const added = [];
    for (const [sid, item] of this._validCachedItems(cached)) {
      if (this._map.has(sid)) continue;
      this._items.set(sid, item);
      this._map.set(sid, item.t);
      this._failed.delete(sid);
      added.push(sid);
    }
    if (added.length) {
      emit(this, 'update', { sids: added });
      emit(this, 'progress', this.progress);
    }
    return added;
  }

  /** Translate every translatable sentence: pages ≥ startPage first, then the pages before it. */
  async translateAll({ startPage = 1 } = {}) {
    const sids = this._translatableSids();
    const page = (sid) => this._byId.get(sid).page;
    const ordered = [...sids.filter((sid) => page(sid) >= startPage), ...sids.filter((sid) => page(sid) < startPage)];
    return this._request(ordered);
  }

  /** Translate the translatable sentences that start on the given pages (in the given page order). */
  async translatePages(pageNumbers) {
    const kinds = this._kinds();
    const sids = [];
    for (const p of pageNumbers || []) {
      for (const s of this._sentences) if (s.page === p && kinds.has(s.kind)) sids.push(s.sid);
    }
    return this._request(sids);
  }

  /** Translate specific sentences (any kind except furniture), e.g. to retry failed ones. */
  async translateSids(sids) {
    const valid = (sids || []).filter((sid) => this._byId.has(sid) && this._byId.get(sid).kind !== 'furniture');
    return this._request(valid);
  }

  /** Stop: abort in-flight requests and drop the queue. Already translated sentences are kept. */
  cancel() {
    this._stopRun({ cancelled: true });
  }

  // ───────────────────────────── queue ─────────────────────────────

  async _request(sids) {
    if (!this._runActive) {
      this._reportedErrors.clear();
      this._consecutiveFailures = 0;
    }
    this._stopped = false;
    this._runActive = true;
    const wanted = [...new Set(sids)].filter((sid) => !this._map.has(sid));
    for (const sid of wanted) this._failed.delete(sid);
    this._enqueueFront(wanted.filter((sid) => !this._inflight.has(sid)));
    const waitFor = new Set(wanted);
    const done = waitFor.size ? new Promise((resolve) => this._waiters.push({ sids: waitFor, resolve })) : null;
    this._emitProgress();
    this._pump();
    if (!this._workers && !this._queue.length && !this._inflight.size) this._finish({ cancelled: false });
    await done;
    return this.progress;
  }

  _enqueueFront(sids) {
    if (!sids.length) return;
    const front = new Set(sids);
    this._queue = [...sids, ...this._queue.filter((sid) => !front.has(sid))];
    for (const sid of sids) this._queued.add(sid);
  }

  _dropQueue() {
    const dropped = this._queue;
    this._queue = [];
    this._queued.clear();
    for (const sid of dropped) this._settle(sid);
  }

  /** A sentence left the queue for good (translated, failed or dropped): resolve callers waiting on it. */
  _settle(sid) {
    if (!this._waiters.length) return;
    this._waiters = this._waiters.filter((w) => {
      w.sids.delete(sid);
      if (w.sids.size) return true;
      w.resolve();
      return false;
    });
  }

  _concurrency() {
    const n = Number(settings.get().translate?.concurrency) || LIMITS.translateConcurrency;
    return clamp(Math.round(n), 1, MAX_CONCURRENCY);
  }

  /**
   * Allowed parallel workers: 1 until a response has come back recently (so the first request writes the prompt
   * cache and the parallel ones read it), then the configured concurrency.
   */
  _limit() {
    return Date.now() - this._lastResponseAt < CACHE_WARM_MS ? this._concurrency() : 1;
  }

  _pump() {
    if (this._stopped || !this._queue.length) return;
    if (!this._controller) this._controller = new AbortController();
    const signal = this._controller.signal;
    while (this._workers < this._limit() && this._queue.length) {
      this._workers++;
      this._worker(signal);
    }
  }

  async _worker(signal) {
    let counted = true;
    try {
      while (!signal.aborted && !this._stopped) {
        if (this._workers > this._limit()) { this._workers--; counted = false; break; } // concurrency lowered
        const batch = this._nextBatch(signal);
        if (!batch) break;
        await this._translateBatch(batch, signal, 1);
        this._pump(); // scale up once the cache is warm
      }
    } catch (err) {
      console.warn('[ai] translator worker crashed', err); // defensive: _translateBatch handles its own errors
    } finally {
      if (counted) this._workers--;
      // Workers of a cancelled run may still be unwinding when a new run starts: they hand over to it.
      if (!this._stopped && this._queue.length) this._pump();
      else if (!this._workers && !this._inflight.size) this._finish({ cancelled: false });
    }
  }

  /** End the current run: resolve every waiting caller and emit 'done' (once per run). */
  _finish({ cancelled, stopped = false }) {
    this._dropQueue();
    for (const w of this._waiters) w.resolve();
    this._waiters = [];
    this._emitProgress();
    if (!this._runActive) return;
    this._runActive = false;
    emit(this, 'done', { cancelled, stopped, progress: this.progress });
  }

  /**
   * Next batch: queue head onward, in reading order, within the sentence/char limits. A batch never jumps backwards
   * (priority wrap-around) or over more than one page (a prioritised page is not padded with unrelated text).
   */
  _nextBatch(signal) {
    const maxSentences = LIMITS.translateBatchMaxSentences;
    const maxChars = LIMITS.translateBatchMaxChars;
    const batch = [];
    let chars = 0;
    let lastIndex = -1;
    let lastPage = 0;
    while (this._queue.length && batch.length < maxSentences) {
      const sid = this._queue[0];
      if (this._map.has(sid) || this._inflight.has(sid)) { // translated by another request meanwhile
        this._queue.shift();
        this._queued.delete(sid);
        if (this._map.has(sid)) this._settle(sid);
        continue;
      }
      const { text, page } = this._byId.get(sid);
      const index = this._docIndex.get(sid);
      if (batch.length && (chars + text.length > maxChars || index < lastIndex || page > lastPage + 1)) break;
      this._queue.shift();
      this._queued.delete(sid);
      this._inflight.set(sid, signal);
      batch.push(sid);
      chars += text.length;
      lastIndex = index;
      lastPage = page;
    }
    return batch.length ? batch : null;
  }

  // ───────────────────────────── one batch ─────────────────────────────

  async _translateBatch(sids, signal, attempt) {
    emit(this, 'pending', { sids });
    const model = settings.model('translate');
    const items = sids.map((sid) => {
      const s = this._byId.get(sid);
      return { sid, kind: s.kind, text: s.text };
    });
    let result;
    try {
      result = await this._provider().complete({
        task: 'translate',
        model,
        system: translationSystem(this.doc, settings.get().translate || {}),
        messages: [{ role: 'user', content: translationUserMessage({ items, context: this._contextFor(sids[0]) }) }],
        json: TRANSLATION_SCHEMA,
        maxTokens: BATCH_MAX_TOKENS,
        effort: 'low',
        signal,
      });
    } catch (err) {
      if (err?.usage) {
        this._lastResponseAt = Date.now();
        this._addCost(err.usage);
      }
      return this._handleBatchError(err, sids, signal, attempt);
    }
    this._lastResponseAt = Date.now();
    this._consecutiveFailures = 0;
    this._addCost(result.usage);
    const accepted = this._accept(result.json?.translations, sids, result.usage?.model || model, signal);
    if (accepted.size) await this._persist();
    this._emitProgress();
    const missing = sids.filter((sid) => !accepted.has(sid));
    if (!missing.length) return;
    if (signal.aborted) {
      this._release(missing, signal);
      return;
    }
    if (attempt === 1) {
      console.warn('[ai] translation missing ids, retrying once:', missing.join(' '));
      return this._translateBatch(missing, signal, 2);
    }
    this._fail(missing, aiError(`일부 문장(${missing.length}개)의 번역을 받지 못했습니다. 해당 문장을 다시 번역해 보세요.`, { code: 'parse' }), signal);
  }

  async _handleBatchError(err, sids, signal, attempt) {
    if (isAbort(err, signal)) {
      this._release(sids, signal);
      return;
    }
    if (err?.code === 'max_tokens' && sids.length > 1) {
      const half = Math.ceil(sids.length / 2);
      await this._translateBatch(sids.slice(0, half), signal, attempt);
      if (!signal.aborted && !this._stopped) await this._translateBatch(sids.slice(half), signal, attempt);
      else this._release(sids.slice(half), signal);
      return;
    }
    if (err?.code === 'parse' && attempt === 1) return this._translateBatch(sids, signal, 2);
    if (err?.fatal) {
      this._fail(sids, err, signal, { fatal: true });
      this._stopRun({ cancelled: false });
      return;
    }
    const contentSpecific = ['refusal', 'max_tokens', 'parse'].includes(err?.code);
    if (!contentSpecific) this._consecutiveFailures++;
    const stopNow = !contentSpecific
      && (RUN_STOPPING_CODES.has(err?.code) || this._consecutiveFailures >= MAX_CONSECUTIVE_FAILURES);
    if (!stopNow) {
      this._fail(sids, err, signal);
      return;
    }
    const why = RUN_STOPPING_CODES.has(err?.code) ? '번역을 멈췄습니다' : '연속으로 실패해 번역을 멈췄습니다. 잠시 후 다시 시작해 주세요';
    this._fail(sids, aiError(`${err.message} (${why}.)`, { code: err.code }), signal, { force: true });
    this._stopRun({ cancelled: false });
  }

  /** Validate a response: known ids of this batch with non-empty text, first occurrence wins. */
  _accept(translations, sids, model, signal) {
    const want = new Set(sids);
    const got = new Set();
    for (const tr of Array.isArray(translations) ? translations : []) {
      const id = typeof tr?.id === 'string' ? tr.id.trim() : '';
      const ko = typeof tr?.ko === 'string' ? tr.ko.trim() : '';
      if (!want.has(id) || got.has(id) || !ko) continue;
      const s = this._byId.get(id);
      this._items.set(id, { h: hash(s.text), t: ko, m: model });
      this._map.set(id, ko);
      if (this._inflight.get(id) === signal) this._inflight.delete(id);
      this._failed.delete(id);
      got.add(id);
    }
    if (got.size) {
      emit(this, 'update', { sids: [...got] });
      for (const id of got) this._settle(id);
    }
    return got;
  }

  _fail(sids, err, signal, { fatal = false, force = false } = {}) {
    const owned = sids.filter((sid) => this._inflight.get(sid) === signal);
    for (const sid of owned) {
      this._inflight.delete(sid);
      this._failed.add(sid);
    }
    if (!owned.length && !fatal && !force) return;
    if (owned.length) emit(this, 'update', { sids: [], failed: owned });
    this._report(err, owned, fatal, force);
    for (const sid of owned) this._settle(sid);
    this._emitProgress();
  }

  /** In-flight sentences returned to "not translated" (cancel). */
  _release(sids, signal) {
    for (const sid of sids) {
      if (this._inflight.get(sid) !== signal) continue;
      this._inflight.delete(sid);
      this._settle(sid);
    }
  }

  /** Abort in-flight requests, drop the queue and end the run now (unwinding workers then exit quietly). */
  _stopRun({ cancelled }) {
    this._stopped = true;
    this._controller?.abort();
    this._controller = null;
    this._inflight.clear(); // their requests are aborted; the unwinding batches no longer own these sentences
    this._finish({ cancelled, stopped: !cancelled });
  }

  /** Emit 'error' once per distinct message per run (a network outage should not raise 50 toasts). */
  _report(err, sids, fatal, force = false) {
    const message = err?.message || '번역 중 알 수 없는 오류가 발생했습니다.';
    if (!force && this._reportedErrors.has(message)) return;
    this._reportedErrors.add(message);
    emit(this, 'error', { message, fatal: Boolean(fatal), code: err?.code || 'unknown', sids: [...sids] });
  }

  async _persist() {
    if (!this._save) return;
    try {
      await this._save(this.toJSON());
    } catch (err) {
      console.warn('[ai] saving translations failed', err);
      this._report(aiError('번역 결과를 저장하지 못했습니다. 저장 공간이나 동기화 상태를 확인해 주세요.', { code: 'unknown' }), [], false);
    }
  }

  _addCost(usage) {
    this._costUsd += costUsd(usage);
    this._usage = addUsage(this._usage, usage);
    recordUsage(usage, { paperId: this._paperId, task: 'translate' });
  }

  _emitProgress() {
    emit(this, 'progress', this.progress);
  }

  // ───────────────────────────── helpers ─────────────────────────────

  _provider() {
    return this._providerOverride || getProvider();
  }

  _kinds() {
    const kinds = new Set(BASE_KINDS);
    if (settings.get().translate?.translateReferences) kinds.add('reference');
    return kinds;
  }

  _translatableSids() {
    const kinds = this._kinds();
    return this._sentences.filter((s) => kinds.has(s.kind)).map((s) => s.sid);
  }

  /** The source text of the sentences just before `sid` (skipping furniture), oldest first. */
  _contextFor(sid) {
    const out = [];
    for (let i = (this._docIndex.get(sid) ?? 0) - 1; i >= 0 && out.length < CONTEXT_SENTENCES; i--) {
      const s = this._sentences[i];
      if (s.kind !== 'furniture' && s.text) out.unshift({ sid: s.sid, text: s.text });
    }
    return out;
  }

  _loadCache(cached) {
    for (const [sid, item] of this._validCachedItems(cached)) {
      this._items.set(sid, item);
      this._map.set(sid, item.t);
    }
  }

  /** Cache items that still match the current sentence text (and target language). */
  *_validCachedItems(cached) {
    if (!cached || typeof cached.items !== 'object' || cached.items === null) return;
    if (cached.targetLang && cached.targetLang !== this._targetLang) return;
    for (const s of this._sentences) {
      const it = cached.items[s.sid];
      if (it && typeof it.t === 'string' && it.t && it.h === hash(s.text)) yield [s.sid, { h: it.h, t: it.t, m: it.m || '' }];
    }
  }

  _copyWordless() {
    for (const s of this._sentences) {
      if (s.kind !== 'furniture' && s.text && !this._map.has(s.sid) && !HAS_WORD.test(s.text)) this._map.set(s.sid, s.text);
    }
  }
}
