// Batching / caching translation orchestrator for one open paper (SPEC 3.4).
//
// - Cache: items[sid] is reused only while items[sid].h === hash(sentence.text).
// - Queue: every translate*() call puts its sentences at the FRONT of one shared queue (latest request first,
//   reading order within it); a pool of workers (settings.translate.concurrency) drains it in batches.
// - Batches: queued sentences in reading order, ≤ LIMITS.translateBatchMaxSentences and ≤ translateBatchMaxChars.
//   Each request = stable cached system prompt (rules + title/abstract/glossary) + 2 preceding source sentences
//   + the paper's established terms that occur in the batch (after the cached prefix, see terms.js).
// - The first batch of a cold run goes alone so it writes the prompt cache; the other workers start after it.
// - Ids missing from a response are retried once; a batch cut by max_tokens is split in half. Then: failed.
// - A translation that is still the English source (no Hangul although the sentence has words to translate) is
//   re-requested once, then marked failed (retryable) - never counted as done.
import { emit } from '../core/bus.js';
import { LIMITS } from '../core/config.js';
import { settings } from '../core/settings.js';
import { clamp, hash } from '../core/util.js';
import { aiError, getProvider, isAbort } from './providers.js';
import { MAX_TERMS_PER_REQUEST, TRANSLATION_SCHEMA, translationSystem, translationUserMessage } from './prompts.js';
import { glossaryKeys, TermMap } from './terms.js';
import { addUsage, costUsd, emptyUsage, recordUsage } from './usage.js';

const BASE_KINDS = ['body', 'heading', 'caption'];
const CONTEXT_SENTENCES = 2;
// max_tokens per batch scales with the batch: a normal answer needs ~0.5 token per source char plus JSON overhead;
// hitting a cap 2.5× that (+ room for adaptive thinking) means the model is looping, so the overrun costs little
// and the batch is split early. Never above the old fixed 16K.
const BATCH_MIN_TOKENS = 4000;
const BATCH_MAX_TOKENS = 16000;
const MAX_CONSECUTIVE_FAILURES = 3;
const MAX_CONCURRENCY = 8;
const CACHE_WARM_MS = 4 * 60 * 1000; // prompt cache lives 5 min after the last request that used it
// Sentences without any word (numbers, symbols, "p < .05") are copied as their own translation, no API call.
const HAS_WORD = /[A-Za-z]{2,}/;
// …and so are sentences that are only a URL, DOI or e-mail address (plus a label like "E-mail:" or "doi:").
const IDENTIFIERS = /\b(?:https?:\/\/|www\.)\S+|\bdoi:\s*\S+|\b10\.\d{4,9}\/\S+|[\w.+-]+@[\w-]+(?:\.[\w-]+)+|\b\d{4}-\d{4}-\d{4}-\d{3}[\dX]\b/gi;
const ID_LABELS = /\b(?:e-?mail|email|doi|url|orcid|https?|www|available\s+(?:at|from)|retrieved\s+from|accessed(?:\s+on)?)\b/gi;
// Errors that every following batch would hit too: a daily quota, or a 400 (all batches share one request shape;
// e.g. an exhausted API credit balance is reported as a 400).
const RUN_STOPPING_CODES = new Set(['quota', 'bad_request']);
const MAX_INTRODUCED_TERMS = 80;
const HANGUL = /[가-힣]/;
// Chinese characters or kana in a Korean answer whose source has none: a model slip (Haiku 5.5 wrote 文献 for 문헌,
// 중症 for 중증 in real runs). Korean nursing prose does not use hanja, so it is re-requested once like other problems.
const FOREIGN_SCRIPT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
const UNTRANSLATED_MESSAGE = '영어 그대로 돌아온 번역은 실패로 표시했습니다. 문장 옆 ‘다시 시도’로 다시 번역하거나, 설정에서 번역 모델을 바꿔 보세요.';

// -- "has words to translate" (hasWordsToTranslate) --
// Lower-case words that do not make a line translatable: name particles and title connectors ("Nursing in
// Critical Care", "van der Berg"), units, statistics and Latin abbreviations.
const NON_CONTENT = new Set([
  'of', 'and', 'the', 'in', 'for', 'on', 'at', 'to', 'with', 'by', 'from', 'an', 'via', 'de', 'del', 'della', 'der', 'den',
  'van', 'von', 'du', 'la', 'le', 'da', 'di', 'dos', 'das', 'el', 'al', 'bin', 'ibn', 'et', 'und', 'zu', 'y',
  'mg', 'kg', 'ml', 'dl', 'mmhg', 'cm', 'mm', 'kcal', 'mmol', 'mol', 'min', 'hr', 'hrs', 'sec', 'ms', 'wk', 'wks', 'yr', 'yrs',
  'mo', 'iu', 'ng', 'pg', 'df', 'sd', 'se', 'ci', 'or', 'rr', 'ns', 'ln', 'log', 'exp', 'max', 'vs', 'cf', 'ie', 'eg', 'etc',
  'ca', 'approx', 'pp', 'vol', 'no', 'ed', 'eds',
]);
// Words that make a line prose in any capitalisation ("WHAT IS KNOWN ABOUT THIS TOPIC"); never part of names.
const PROSE_WORDS = new Set(['is', 'are', 'was', 'were', 'be', 'been', 'has', 'have', 'had', 'this', 'that', 'these',
  'those', 'which', 'what', 'who', 'how', 'why', 'not', 'than', 'between', 'about', 'there', 'its', 'we', 'our', 'they',
  'their', 'can', 'may', 'should', 'would', 'could', 'will']);
// Capitalised words that always have a Korean rendering: section headings, front-matter labels, affiliation units and
// months. Words that also occur in journal or institution names (Research, Review, Studies, Clinical, Hospital,
// University, Institute, Center, Nursing, Care) are deliberately absent, so a name kept in English is not "untranslated".
const LABEL_WORDS = new Set([
  'abstract', 'introduction', 'background', 'method', 'methods', 'methodology', 'results', 'discussion', 'conclusion',
  'conclusions', 'limitations', 'implications', 'acknowledgement', 'acknowledgements', 'acknowledgment', 'acknowledgments',
  'references', 'appendix', 'keywords', 'keyword', 'correspondence', 'corresponding', 'received', 'revised', 'accepted',
  'funding', 'department', 'division', 'faculty', 'january', 'february', 'march', 'april', 'june', 'july',
  'august', 'september', 'october', 'november', 'december',
]);
// Two-word labels ("open access", "School of Nursing", "META-ANALYSIS") on the lower-cased words.
const LABEL_PHRASES = /\b(?:open access|school of|college of|meta analysis|original article|research article|review article|conflicts? of interest|author contributions?|data availability|ethics statement|supporting information)\b/;
// A "Label:" at the start of the line or after a "|" separator (Keywords:, Correspondence:, Received:, Background:).
const LABEL_COLON = /(?:^|\|)\s*[A-Za-z][A-Za-z-]*(?:\s+[A-Za-z][A-Za-z-]*){0,3}\s*:(?!\/)/;

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

    /** @type {Map<string, { h: string, t: string, m: string, w?: string }>} persisted entries (w: fidelity warning) */
    this._items = new Map();
    /** @type {Map<string, string>} everything shown: persisted + copied */
    this._map = new Map();
    this._failed = new Set();
    /** English terms already given in parentheses in this paper's translations (first-mention rule across batches). */
    this._introduced = [];
    this._introducedSet = new Set();
    /** Korean renderings this paper's translations established for recurring terms (sent to later batches). */
    this._terms = new TermMap();
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
    let translated = 0; // done by the model (cached or new), i.e. excluding sentences copied as-is
    for (const sid of sids) {
      if (this._map.has(sid)) {
        done++;
        if (this._items.has(sid)) translated++;
      } else if (this._failed.has(sid)) failed++;
    }
    return {
      done, translated, total: sids.length, costUsd: this._costUsd, failed,
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

  /**
   * Sentences whose accepted translation failed a fidelity check twice (numbers missing, no Korean, far too
   * short), with the reason — shown to the reader as "compare with the original". Map<sid, reason>.
   */
  get warnings() {
    const out = new Map();
    for (const [sid, it] of this._items) if (it.w && this._map.get(sid) === it.t) out.set(sid, it.w);
    return out;
  }

  /** Established term renderings of this paper, in the order they were established: [{ en, ko }]. */
  get terms() {
    return this._terms.list();
  }

  /**
   * Translation data file contents (SPEC 2.2 kind 'translation'). `terms` (optional, added 2026-10-18) holds the
   * established renderings `{ [key]: { en, ko } }`; older readers ignore it.
   */
  toJSON() {
    const out = {
      version: 1,
      targetLang: this._targetLang,
      segVersion: this.doc?.segVersion ?? null,
      updatedAt: Date.now(),
      items: Object.fromEntries(this._items),
    };
    const terms = this._terms.toJSON();
    if (terms) out.terms = terms;
    return out;
  }

  /**
   * Take in translations from a newer copy of the translation file (another device or tab synced it).
   * Sentences already translated here are kept; queued ones are skipped by the workers once present.
   * Emits 'update' and 'progress' when anything was added. Returns the added sids.
   */
  mergeCached(cached) {
    const added = [];
    if (this._sameLang(cached)) this._terms.load(cached.terms);
    for (const [sid, item, bad] of this._validCachedItems(cached)) {
      if (bad || this._map.has(sid)) continue;
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
    const context = this._contextFor(sids[0]);
    const glossary = glossaryKeys(settings.get().translate?.glossary);
    const source = [...context, ...items].map((x) => x.text).join('\n');
    let result;
    try {
      result = await this._provider().complete({
        task: 'translate',
        model,
        system: translationSystem(this.doc, settings.get().translate || {}),
        messages: [{
          role: 'user',
          content: translationUserMessage({
            items, context, introduced: this._introducedTerms(),
            terms: this._terms.relevant(source, { glossary, max: MAX_TERMS_PER_REQUEST }),
            retry: attempt > 1,
          }),
        }],
        json: TRANSLATION_SCHEMA,
        maxTokens: batchMaxTokens(items),
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
    const rejected = new Set();
    const accepted = this._accept(result.json?.translations, sids, result.usage?.model || model, signal, { lastTry: attempt > 1, rejected });
    if (accepted.size) {
      this._terms.note(result.json?.terms, {
        source: items.map((it) => it.text).join('\n'),
        translations: [...accepted].map((sid) => this._map.get(sid)),
        glossary,
      });
      await this._persist();
    }
    this._emitProgress();
    const missing = sids.filter((sid) => !accepted.has(sid));
    if (!missing.length) return;
    if (signal.aborted || this._stopped) {
      this._release(missing, signal);
      return;
    }
    if (attempt === 1) {
      console.warn('[ai] translation missing or implausible ids, retrying once:', missing.join(' '));
      return this._translateBatch(missing, signal, 2);
    }
    const untranslated = missing.filter((sid) => rejected.has(sid));
    const lost = missing.filter((sid) => !rejected.has(sid));
    if (untranslated.length) {
      console.warn('[ai] translation still English after a retry, marked failed:', untranslated.join(' '));
      this._fail(untranslated, aiError(UNTRANSLATED_MESSAGE, { code: 'parse' }), signal);
    }
    if (lost.length) this._fail(lost, aiError(`일부 문장(${lost.length}개)의 번역을 받지 못했습니다. 해당 문장을 다시 번역해 보세요.`, { code: 'parse' }), signal);
  }

  async _handleBatchError(err, sids, signal, attempt) {
    if (isAbort(err, signal)) {
      this._release(sids, signal);
      return;
    }
    // A runaway answer (max_tokens) or a refusal is usually caused by one sentence: keep what was finished,
    // then bisect so only the offending sentence ends up failed instead of the whole batch.
    if ((err?.code === 'max_tokens' || err?.code === 'refusal') && sids.length > 1) {
      let rest = sids;
      if (err.code === 'max_tokens' && err.partialText) {
        const salvaged = this._accept(salvageTranslations(err.partialText), sids, err.usage?.model || settings.model('translate'), signal);
        if (salvaged.size) {
          await this._persist();
          this._emitProgress();
          rest = sids.filter((sid) => !salvaged.has(sid));
        }
      }
      if (!rest.length) return;
      if (rest.length < sids.length) return this._translateBatch(rest, signal, attempt);
      const half = Math.ceil(rest.length / 2);
      await this._translateBatch(rest.slice(0, half), signal, attempt);
      if (!signal.aborted && !this._stopped) await this._translateBatch(rest.slice(half), signal, attempt);
      else this._release(rest.slice(half), signal);
      return;
    }
    if (err?.code === 'parse' && attempt === 1) return this._translateBatch(sids, signal, 2);
    if (err?.fatal || RUN_STOPPING_CODES.has(err?.code)) {
      // Every batch would fail the same way (bad key, no credit, no access, a 400): stop at once and leave the
      // sentences untranslated, not "failed" — a per-sentence retry cannot help until the setup is fixed.
      this._release(sids, signal);
      const message = err?.fatal ? err.message : `${err.message} (번역을 멈췄습니다.)`;
      this._report(aiError(message, { code: err?.code || 'unknown', fatal: true }), [], true, true);
      this._stopRun({ cancelled: false });
      return;
    }
    if (err?.code === 'refusal') {
      this._fail(sids, aiError(`${err.message} 거절된 문장은 설정에서 번역 모델을 Claude Sonnet 5.5로 바꾸면 번역될 수 있습니다.`, { code: 'refusal' }), signal);
      return;
    }
    const contentSpecific = ['max_tokens', 'parse'].includes(err?.code);
    if (!contentSpecific) this._consecutiveFailures++;
    if (contentSpecific || this._consecutiveFailures < MAX_CONSECUTIVE_FAILURES) {
      this._fail(sids, err, signal);
      return;
    }
    this._fail(sids, aiError(`${err.message} (연속으로 실패해 번역을 멈췄습니다. 잠시 후 다시 시작해 주세요.)`, { code: err.code }), signal, { force: true });
    this._stopRun({ cancelled: false });
  }

  /**
   * Validate a response: known ids of this batch with non-empty text, first occurrence wins. A translation that
   * looks unfaithful (still English, numbers missing, far too short) is left out on the first try so it is
   * re-requested once. On the last try a translation that is still English is rejected (added to `rejected`; the
   * caller marks it failed); any other problem is kept with a warning (`w`) the reader shows.
   */
  _accept(translations, sids, model, signal, { lastTry = true, rejected = null } = {}) {
    const want = new Set(sids);
    const got = new Set();
    const warned = [];
    for (const tr of Array.isArray(translations) ? translations : []) {
      const id = typeof tr?.id === 'string' ? tr.id.trim() : '';
      const ko = typeof tr?.ko === 'string' ? tr.ko.trim() : '';
      if (!want.has(id) || got.has(id) || !ko) continue;
      const s = this._byId.get(id);
      const problem = fidelityProblem(s, ko);
      if (problem && !lastTry) continue;
      if (problem === 'untranslated') { rejected?.add(id); continue; }
      const item = { h: hash(s.text), t: ko, m: model };
      if (problem) { item.w = problem; warned.push(id); }
      this._items.set(id, item);
      this._map.set(id, ko);
      this._noteIntroduced(ko);
      if (this._inflight.get(id) === signal) this._inflight.delete(id);
      this._failed.delete(id);
      got.add(id);
    }
    if (got.size) {
      emit(this, 'update', warned.length ? { sids: [...got], warned } : { sids: [...got] });
      for (const id of got) this._settle(id);
    }
    return got;
  }

  /** Remember English terms the translations already gave in parentheses, e.g. 섬망(delirium). */
  _noteIntroduced(ko) {
    for (const m of ko.matchAll(/[가-힣][^()]{0,30}\(([A-Za-z][A-Za-z ,'/-]{2,60})\)/g)) {
      const term = m[1].trim().replace(/,\s*$/, '');
      const key = term.toLowerCase();
      if (!term || this._introducedSet.has(key)) continue;
      this._introducedSet.add(key);
      this._introduced.push(term);
      if (this._introduced.length > MAX_INTRODUCED_TERMS) this._introducedSet.delete(this._introduced.shift().toLowerCase());
    }
  }

  _introducedTerms() {
    return settings.get().translate?.keepTermsInEnglish === false ? [] : [...this._introduced];
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

  /**
   * Hand the translation file to the caller. A failing save (e.g. browser storage full) stops the run: going on
   * would keep paying for translations that cannot be kept.
   */
  async _persist() {
    if (!this._save) return;
    try {
      await this._save(this.toJSON());
    } catch (err) {
      console.warn('[ai] saving translations failed', err);
      if (this._stopped) return;
      const detail = /[가-힣]/.test(err?.message || '') ? ` (${err.message})` : '';
      this._report(aiError(`번역 결과를 저장하지 못해 번역을 멈췄습니다. 브라우저 저장 공간을 확인한 뒤 다시 시작해 주세요.${detail}`, { code: 'storage', fatal: true }), [], true, true);
      this._stopRun({ cancelled: false });
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

  /**
   * The sentences just before `sid` (skipping furniture), oldest first, with their Korean translation when there
   * is one (so terminology stays consistent with what the reader already sees).
   */
  _contextFor(sid) {
    const out = [];
    for (let i = (this._docIndex.get(sid) ?? 0) - 1; i >= 0 && out.length < CONTEXT_SENTENCES; i--) {
      const s = this._sentences[i];
      if (s.kind === 'furniture' || !s.text) continue;
      const ko = this._items.get(s.sid)?.t;
      out.unshift(ko ? { sid: s.sid, text: s.text, ko } : { sid: s.sid, text: s.text });
    }
    return out;
  }

  _loadCache(cached) {
    if (this._sameLang(cached)) this._terms.load(cached.terms);
    for (const [sid, item, bad] of this._validCachedItems(cached)) {
      // Saved before an English answer counted as a failure: shown as failed (retryable), not as done.
      if (bad) { this._failed.add(sid); continue; }
      this._items.set(sid, item);
      this._map.set(sid, item.t);
      this._noteIntroduced(item.t);
    }
  }

  _sameLang(cached) {
    return Boolean(cached && typeof cached === 'object') && (!cached.targetLang || cached.targetLang === this._targetLang);
  }

  /**
   * Cache items that still match the current sentence text (and target language), as [sid, item, bad]. A sid whose
   * stored item does not match falls back to any stored item with the same text hash (a resegmentation shifted the
   * sids). `bad`: the stored translation is still the English source (fidelityProblem 'untranslated').
   */
  *_validCachedItems(cached) {
    if (!cached || typeof cached.items !== 'object' || cached.items === null) return;
    if (!this._sameLang(cached)) return;
    let byHash = null;
    for (const s of this._sentences) {
      const h = hash(s.text);
      let it = cached.items[s.sid];
      if (!(it && typeof it.t === 'string' && it.t && it.h === h)) {
        byHash ??= hashIndex(cached.items);
        it = byHash.get(h);
      }
      if (!it) continue;
      const item = it.w ? { h, t: it.t, m: it.m || '', w: it.w } : { h, t: it.t, m: it.m || '' };
      yield [s.sid, item, s.kind !== 'furniture' && fidelityProblem(s, it.t) === 'untranslated'];
    }
  }

  _copyWordless() {
    for (const s of this._sentences) {
      if (s.kind !== 'furniture' && s.text && !this._map.has(s.sid) && isCopyAsIs(s.text)) this._map.set(s.sid, s.text);
    }
  }
}

/** Nothing to translate: no word at all, or only URLs / DOIs / e-mail addresses (and their labels). */
export function isCopyAsIs(text) {
  if (!HAS_WORD.test(text)) return true;
  const rest = text.replace(IDENTIFIERS, ' ');
  if (rest === text) return false;
  return !HAS_WORD.test(rest.replace(ID_LABELS, ' '));
}

/** max_tokens for a batch, from its size (see BATCH_MIN_TOKENS). */
function batchMaxTokens(items) {
  const chars = items.reduce((n, it) => n + it.text.length, 0);
  const expected = chars * 0.5 + items.length * 20;
  return clamp(Math.round(expected * 2.5 + 3000), BATCH_MIN_TOKENS, BATCH_MAX_TOKENS);
}

/** The complete {"id","ko"} objects in a JSON answer that was cut off by max_tokens. */
function salvageTranslations(text) {
  const out = [];
  const re = /\{\s*"id"\s*:\s*"((?:[^"\\]|\\.)*)"\s*,\s*"ko"\s*:\s*"((?:[^"\\]|\\.)*)"\s*\}/g;
  for (const m of String(text || '').matchAll(re)) {
    try { out.push({ id: JSON.parse(`"${m[1]}"`), ko: JSON.parse(`"${m[2]}"`) }); } catch { /* malformed escape */ }
  }
  return out;
}

/** Map text hash → first valid cached item with that hash. */
function hashIndex(items) {
  const out = new Map();
  for (const it of Object.values(items)) {
    if (it && typeof it.t === 'string' && it.t && typeof it.h === 'string' && !out.has(it.h)) out.set(it.h, it);
  }
  return out;
}

/**
 * True when a sentence has words a Korean translation must render, so an answer without any Hangul is still the
 * English source. False for copy-as-is content (URLs, DOIs, e-mail addresses, numbers) and for lines of names only
 * (author lists, a journal title such as "Nursing in Critical Care", "Taipei, Taiwan", "RCT"). Signals, in order:
 * a "Label:" (Keywords:, Correspondence:, Received:), a prose word in any case, a heading / front-matter / affiliation
 * word or month, a two-word label (open access, School of), any other lower-case word.
 */
export function hasWordsToTranslate(text) {
  if (isCopyAsIs(text)) return false;
  const rest = String(text).replace(IDENTIFIERS, ' ').replace(ID_LABELS, ' ');
  if (LABEL_COLON.test(rest)) return true;
  if (LABEL_PHRASES.test(rest.toLowerCase().replace(/[^a-z]+/g, ' '))) return true;
  for (const token of rest.match(/[A-Za-z][A-Za-z’']*/g) || []) {
    const word = token.toLowerCase().replace(/[’'].*$/, '');
    if (word.length < 2) continue;
    if (PROSE_WORDS.has(word) || LABEL_WORDS.has(word)) return true;
    if (token[0] >= 'a' && token[0] <= 'z' && !NON_CONTENT.has(word)) return true;
  }
  return false;
}

/**
 * Cheap checks that a translation is usable: it is not still the English source (no Hangul although the sentence
 * has words to translate: 'untranslated', never accepted as done); no Chinese characters or kana crept in ('script');
 * every multi-digit number / decimal of the source is still there; a long sentence is not cut to a fragment.
 * Returns a short reason, or null.
 */
export function fidelityProblem(sentence, ko) {
  const text = sentence?.text || '';
  if (sentence?.kind === 'reference' || isCopyAsIs(text)) return null;
  if (!HANGUL.test(ko) && hasWordsToTranslate(text)) return 'untranslated';
  if (FOREIGN_SCRIPT.test(ko) && !FOREIGN_SCRIPT.test(text)) return 'script';
  // Number tokens with their decimal point (".05" and "0.05" compare equal); single digits are skipped (often
  // written as Korean words); thousands separators are ignored.
  const nums = (s) => (s.replace(/(\d),(?=\d{3}\b)/g, '$1').match(/\.?\d+(?:\.\d+)*/g) || [])
    .map((n) => n.replace(/^0+(?=[\d.])/, '')).filter((n) => n.replace('.', '').length >= 2);
  const have = new Map();
  for (const n of nums(ko)) have.set(n, (have.get(n) || 0) + 1);
  for (const n of nums(text)) {
    const c = have.get(n) || 0;
    if (!c) return 'numbers';
    have.set(n, c - 1);
  }
  if (text.length > 80 && ko.length < text.length * 0.2) return 'short';
  return null;
}
