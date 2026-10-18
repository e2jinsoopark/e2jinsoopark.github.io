// Right-hand translation pane: the document's paragraphs, one span[data-sid] per sentence.
// Translated sentences show Korean; untranslated ones show the greyed original (pending / failed states).
import { emit } from '../core/bus.js';
import { settings } from '../core/settings.js';
import { el, rafThrottle } from '../core/util.js';
import { icon } from './icons.js';

const NAMED_MARK_COLORS = new Set(['yellow', 'green', 'blue', 'pink', 'orange', 'purple', 'red', 'grey']);
const FLASH_MS = 1400;

/**
 * Whether a sentence is meant to be translated (mirrors Translator.progress.total):
 * body | heading | caption, plus reference when settings.translate.translateReferences.
 */
export function isTranslatableSentence(sentence) {
  if (!sentence) return false;
  if (sentence.kind === 'reference') return Boolean(settings.get().translate?.translateReferences);
  return sentence.kind === 'body' || sentence.kind === 'heading' || sentence.kind === 'caption';
}

/**
 * @typedef {{ id: string, start: number, end: number, color?: string, style?: 'fill'|'underline', title?: string }} Mark
 */

export class TranslationPane extends EventTarget {
  /** @type {HTMLElement} */ #root;
  #doc;
  /** @type {Map<string, string>} */ #translations = new Map();
  /** @type {Map<string, 'pending'|'failed'>} */ #status = new Map();
  /** @type {Map<string, HTMLElement>} */ #spans = new Map();
  /** @type {Map<string, Map<string, Mark>>} layer → sid → mark */ #marks = new Map();
  #hoverSid = null;
  #activeSid = null;
  #emittedHover = null;
  #flashTimers = new Map();
  #sortedSentences = null;
  #listeners = [];

  /**
   * @param {HTMLElement} container  scrollable host owned by the pane
   * @param {{ doc: import('../pdf/extract.js').PaperDoc }} opts
   */
  constructor(container, { doc }) {
    super();
    this.#root = container;
    this.#doc = doc;
    container.classList.add('tp-root');
    container.setAttribute('lang', 'ko');
    this.#render();
    this.#bindEvents();
  }

  /**
   * Replace the translation map (sid → Korean) and refresh every sentence.
   * `repaint: false` only swaps the map (follow with update(sids) for the sentences that changed).
   */
  setTranslations(map, { repaint = true } = {}) {
    this.#translations = map instanceof Map ? map : new Map(Object.entries(map || {}));
    if (!repaint) return;
    for (const sid of this.#translations.keys()) this.#status.delete(sid);
    for (const sid of this.#spans.keys()) this.#paint(sid);
  }

  /** Re-render the given sentences from the current map (all when omitted). */
  update(sids) {
    const list = sids ? [...sids] : [...this.#spans.keys()];
    for (const sid of list) {
      if (this.#translations.has(sid)) this.#status.delete(sid);
      this.#paint(sid);
    }
  }

  /** @param {string} sid @param {'pending'|'failed'|null} status  null clears the status */
  setStatus(sid, status) {
    if (status === 'pending' || status === 'failed') this.#status.set(sid, status);
    else this.#status.delete(sid);
    this.#paint(sid);
  }

  /** Sentences currently marked failed. */
  get failedSids() {
    return [...this.#status].filter(([, s]) => s === 'failed').map(([sid]) => sid);
  }

  setHoverSentence(sid) {
    if (sid === this.#hoverSid) return;
    this.#spans.get(this.#hoverSid)?.classList.remove('is-hover');
    this.#hoverSid = sid || null;
    this.#spans.get(this.#hoverSid)?.classList.add('is-hover');
  }

  setActiveSentence(sid) {
    if (sid === this.#activeSid) return;
    this.#spans.get(this.#activeSid)?.classList.remove('is-active');
    this.#activeSid = sid || null;
    const span = this.#spans.get(this.#activeSid);
    span?.classList.add('is-active');
  }

  /** Scroll the pane (only the pane, never the page) so `sid` is visible. */
  scrollToSentence(sid, { block = 'center', flash = true, behavior = 'smooth' } = {}) {
    const span = this.#spans.get(sid);
    if (!span) return false;
    const top = this.#targetScrollTop(span, block);
    this.#root.scrollTo({ top, behavior: prefersReducedMotion() ? 'auto' : behavior });
    if (flash) this.#flash(sid, span);
    return true;
  }

  /** Scroll only if `sid` is not already comfortably visible. Returns true if it scrolled. */
  revealSentence(sid, { block = 'center', behavior = 'smooth' } = {}) {
    const span = this.#spans.get(sid);
    if (!span || this.isSentenceVisible(sid)) return false;
    return this.scrollToSentence(sid, { block, flash: false, behavior });
  }

  /** True when the sentence's first line is inside the pane's viewport. */
  isSentenceVisible(sid) {
    const span = this.#spans.get(sid);
    if (!span) return false;
    const box = this.#root.getBoundingClientRect();
    const r = span.getClientRects()[0] || span.getBoundingClientRect();
    return r.bottom > box.top + 8 && r.top < box.bottom - 8;
  }

  /**
   * Show marks (same shape as the viewer's). Here a mark colours every sentence it overlaps.
   * @param {string} layer  'annotations' | 'auto' | 'search' | …
   * @param {Mark[]} marks
   */
  setMarks(layer, marks) {
    const prev = this.#marks.get(layer);
    const next = new Map();
    for (const mark of marks || []) {
      for (const sid of this.#sidsInRange(mark.start, mark.end)) next.set(sid, mark);
    }
    this.#marks.set(layer, next);
    const touched = new Set([...(prev?.keys() || []), ...next.keys()]);
    for (const sid of touched) this.#paintMarks(sid);
  }

  /** The span element for a sentence (for features that need positioning). */
  getSentenceElement(sid) {
    return this.#spans.get(sid) || null;
  }

  destroy() {
    for (const [type, fn, opts] of this.#listeners) this.#root.removeEventListener(type, fn, opts);
    this.#listeners = [];
    for (const t of this.#flashTimers.values()) clearTimeout(t);
    this.#root.replaceChildren();
    this.#root.classList.remove('tp-root');
  }

  // -------------------------------------------------------------------------

  #render() {
    const doc = this.#doc;
    const frag = document.createDocumentFragment();
    this.#spans.clear();
    if (!doc?.sentences?.length) {
      frag.append(this.#emptyNotice(doc));
      this.#root.replaceChildren(frag);
      return;
    }
    const article = el('article', { class: 'tp-doc' });
    let lastPage = null;
    for (const para of doc.paragraphs || []) {
      if (para.kind === 'furniture') continue;
      const sentences = para.sids.map((sid) => doc.sentenceById.get(sid)).filter((s) => s && s.kind !== 'furniture');
      if (!sentences.length) continue;
      if (para.page !== lastPage) {
        article.append(el('div', { class: 'tp-page', 'data-page': para.page, 'aria-hidden': 'true' }, `${para.page}쪽`));
        lastPage = para.page;
      }
      const block = el(para.kind === 'heading' ? 'h3' : 'p', { class: `tp-para tp-kind-${para.kind}`, 'data-pid': para.pid });
      sentences.forEach((s, i) => {
        const span = el('span', { class: `tp-s tp-kind-${s.kind}`, 'data-sid': s.sid });
        this.#spans.set(s.sid, span);
        this.#paint(s.sid);
        if (i) block.append(' ');
        block.append(span);
      });
      article.append(block);
    }
    frag.append(article);
    this.#root.replaceChildren(frag);
  }

  #emptyNotice(doc) {
    const scanned = doc && doc.hasTextLayer === false;
    return el('div', { class: 'tp-empty' },
      icon(scanned ? 'image' : 'file-text', { size: 28 }),
      el('p', { class: 'tp-empty-title' }, scanned ? '텍스트를 추출할 수 없는 PDF입니다' : '표시할 문장이 없습니다'),
      el('p', { class: 'tp-empty-text' }, scanned
        ? '스캔한 이미지로 된 PDF라 번역과 문장 연동을 사용할 수 없습니다. 왼쪽에서 원문은 그대로 볼 수 있습니다.'
        : '이 문서에서 본문 문장을 찾지 못했습니다.'));
  }

  /** Render one sentence's text + state classes. */
  #paint(sid) {
    const span = this.#spans.get(sid);
    if (!span) return;
    const sentence = this.#doc.sentenceById.get(sid);
    const translated = this.#translations.get(sid);
    const status = translated ? null : this.#status.get(sid) || null;
    const translatable = isTranslatableSentence(sentence);
    span.classList.toggle('is-translated', Boolean(translated));
    span.classList.toggle('is-untranslated', !translated && translatable);
    span.classList.toggle('is-source-only', !translated && !translatable);
    span.classList.toggle('is-pending', status === 'pending');
    span.classList.toggle('is-failed', status === 'failed');
    span.removeAttribute('aria-busy');
    if (translated) {
      span.replaceChildren(translated);
      span.removeAttribute('lang');
    } else {
      span.replaceChildren(sentence?.text || '');
      span.setAttribute('lang', 'en');
      if (status === 'pending') span.setAttribute('aria-busy', 'true');
      if (status === 'failed') {
        span.append(el('button', {
          type: 'button', class: 'tp-retry', 'data-retry': sid,
          title: '번역에 실패했습니다. 다시 시도', 'aria-label': '이 문장 다시 번역',
        }, icon('rotate-ccw', { size: 13 }), el('span', {}, '다시 시도')));
      }
    }
    this.#paintMarks(sid);
  }

  #paintMarks(sid) {
    const span = this.#spans.get(sid);
    if (!span) return;
    const titles = [];
    for (const [layer, bySid] of this.#marks) {
      const mark = bySid.get(sid);
      const attr = `m${layer.replace(/[^a-z0-9]/gi, '').replace(/^./, (c) => c.toUpperCase())}`;
      if (!mark) {
        delete span.dataset[attr];
        span.style.removeProperty(`--m-${layer}`);
        continue;
      }
      span.dataset[attr] = mark.style === 'underline' ? 'underline' : 'fill';
      span.style.setProperty(`--m-${layer}`, markColor(mark.color, mark.style));
      if (mark.title) titles.push(mark.title);
    }
    if (titles.length) span.title = titles.join('\n');
    else span.removeAttribute('title');
  }

  #sidsInRange(start, end) {
    if (!this.#sortedSentences) {
      this.#sortedSentences = [...(this.#doc.sentences || [])].sort((a, b) => a.start - b.start);
    }
    const list = this.#sortedSentences;
    // first sentence whose end > start
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid].end <= start) lo = mid + 1; else hi = mid;
    }
    const out = [];
    for (let i = lo; i < list.length && list[i].start < end; i++) {
      if (this.#spans.has(list[i].sid)) out.push(list[i].sid);
    }
    return out;
  }

  #targetScrollTop(span, block) {
    const box = this.#root.getBoundingClientRect();
    const r = span.getBoundingClientRect();
    const offsetTop = r.top - box.top + this.#root.scrollTop;
    if (block === 'start') return Math.max(0, offsetTop - 16);
    if (block === 'end') return Math.max(0, offsetTop + r.height - this.#root.clientHeight + 16);
    return Math.max(0, offsetTop - (this.#root.clientHeight - Math.min(r.height, this.#root.clientHeight)) / 2);
  }

  #flash(sid, span) {
    clearTimeout(this.#flashTimers.get(sid));
    span.classList.remove('is-flash');
    void span.offsetWidth; // restart the animation
    span.classList.add('is-flash');
    this.#flashTimers.set(sid, setTimeout(() => { span.classList.remove('is-flash'); this.#flashTimers.delete(sid); }, FLASH_MS));
  }

  #on(type, fn, opts) {
    this.#root.addEventListener(type, fn, opts);
    this.#listeners.push([type, fn, opts]);
  }

  #bindEvents() {
    const hover = rafThrottle((sid) => {
      if (sid === this.#emittedHover) return;
      this.#emittedHover = sid;
      this.setHoverSentence(sid);
      emit(this, 'sentencehover', { sid });
    });
    this.#on('pointerover', (e) => {
      if (e.pointerType === 'touch') return;
      const span = /** @type {Element} */ (e.target).closest?.('.tp-s');
      hover(span ? span.dataset.sid : null);
    });
    this.#on('pointerleave', () => hover(null));
    this.#on('click', (e) => {
      const target = /** @type {Element} */ (e.target);
      const retry = target.closest('.tp-retry');
      if (retry) {
        e.stopPropagation();
        emit(this, 'retry', { sids: [retry.dataset.retry] });
        return;
      }
      const span = target.closest('.tp-s');
      if (!span) return;
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed && this.#root.contains(sel.anchorNode)) return; // user is selecting text
      const sid = span.dataset.sid;
      this.setActiveSentence(sid);
      emit(this, 'sentenceclick', { sid });
    });
  }
}

function markColor(color, style) {
  const name = String(color || 'yellow');
  if (NAMED_MARK_COLORS.has(name)) return `var(--mark-${name}${style === 'underline' ? '-line' : ''})`;
  if (typeof CSS !== 'undefined' && CSS.supports?.('color', name)) return name;
  return 'var(--mark-yellow)';
}

function prefersReducedMotion() {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}
