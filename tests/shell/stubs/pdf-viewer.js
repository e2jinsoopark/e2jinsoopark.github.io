// Test stub for js/pdf/viewer.js — draws "pages" as white boxes with one span per sentence.
// It does NOT highlight on its own hover: the reader must call setHoverSentence, which the tests verify.
import { emit } from '/js/core/bus.js';
import { rafThrottle } from '/js/core/util.js';

const PAGE_W = 612;
const PAGE_H = 792;

export class PdfViewer extends EventTarget {
  constructor(container, { pdf, doc }) {
    super();
    this.container = container;
    this.pdf = pdf;
    this.doc = doc;
    this._zoom = 1;
    this._page = 1;
    this._spans = new Map();
    this._pages = [];
    this._hover = null;
    this._active = null;
    this._lastHover = undefined;
    this.calls = [];
    window.__stubViewer = this;
  }

  async init() {
    this.calls.push(['init']);
    await new Promise((r) => setTimeout(r, 60));
    const root = document.createElement('div');
    root.className = 'sv-root';
    for (let p = 1; p <= this.doc.numPages; p++) {
      const page = document.createElement('div');
      page.className = 'sv-page';
      page.dataset.page = String(p);
      for (const para of this.doc.paragraphs.filter((g) => g.page === p)) {
        const block = document.createElement(para.kind === 'heading' ? 'h4' : 'p');
        block.className = `sv-para sv-${para.kind}`;
        for (const sid of para.sids) {
          const s = this.doc.sentenceById.get(sid);
          const span = document.createElement('span');
          span.className = 'sv-s';
          span.dataset.sid = sid;
          span.textContent = s.text;
          this._spans.set(sid, span);
          block.append(span, ' ');
        }
        page.append(block);
      }
      this._pages.push(page);
      root.append(page);
    }
    this.container.replaceChildren(root);
    this.root = root;
    this.setZoom('fit-width');

    const hover = rafThrottle((sid) => {
      if (sid === this._lastHover) return;
      this._lastHover = sid;
      emit(this, 'sentencehover', { sid });
    });
    root.addEventListener('pointermove', (e) => hover(e.target.closest?.('.sv-s')?.dataset.sid ?? null));
    root.addEventListener('pointerleave', () => hover(null));
    root.addEventListener('click', (e) => {
      const sid = e.target.closest?.('.sv-s')?.dataset.sid;
      if (sid) emit(this, 'sentenceclick', { sid });
    });
    this.container.addEventListener('scroll', rafThrottle(() => this._onScroll()));
    for (let p = 1; p <= this.doc.numPages; p++) emit(this, 'rendered', { page: p });
  }

  get zoom() { return this._zoom; }
  setZoom(scale) {
    this.calls.push(['setZoom', scale]);
    if (scale === 'fit-width') {
      const w = this.container.clientWidth || 800;
      scale = Math.max(0.3, (w - 40) / PAGE_W);
    }
    this._zoom = Math.min(4, Math.max(0.25, Number(scale) || 1));
    if (this.root) this.root.style.setProperty('--sv-zoom', String(this._zoom));
    for (const page of this._pages) {
      page.style.width = `${PAGE_W * this._zoom}px`;
      page.style.minHeight = `${PAGE_H * this._zoom}px`;
    }
  }
  zoomIn() { this.calls.push(['zoomIn']); this.setZoom(this._zoom * 1.1); }
  zoomOut() { this.calls.push(['zoomOut']); this.setZoom(this._zoom / 1.1); }

  get currentPage() { return this._page; }
  scrollToPage(n) {
    this.calls.push(['scrollToPage', n]);
    const page = this._pages[n - 1];
    if (!page) return;
    this.container.scrollTo({ top: page.offsetTop - 12 });
    this._setPage(n);
  }

  scrollToSentence(sid, { block = 'center', flash = true } = {}) {
    this.calls.push(['scrollToSentence', sid]);
    const span = this._spans.get(sid);
    if (!span) return;
    const box = this.container.getBoundingClientRect();
    const r = span.getBoundingClientRect();
    const top = r.top - box.top + this.container.scrollTop - (block === 'center' ? box.height / 2 - r.height / 2 : 16);
    this.container.scrollTo({ top });
    if (flash) {
      span.classList.add('sv-flash');
      setTimeout(() => span.classList.remove('sv-flash'), 1200);
    }
  }
  scrollToOffset(offset) {
    const s = this.doc.sentences.find((x) => offset >= x.start && offset < x.end);
    if (s) this.scrollToSentence(s.sid);
  }
  scrollToPdfPoint(page) { this.scrollToPage(page); }

  setHoverSentence(sid) {
    this.calls.push(['setHoverSentence', sid]);
    this._spans.get(this._hover)?.classList.remove('sv-hover');
    this._hover = sid;
    this._spans.get(sid)?.classList.add('sv-hover');
  }
  setActiveSentence(sid) {
    this.calls.push(['setActiveSentence', sid]);
    this._spans.get(this._active)?.classList.remove('sv-active');
    this._active = sid;
    this._spans.get(sid)?.classList.add('sv-active');
  }

  setMarks(layer, marks) {
    this.calls.push(['setMarks', layer, marks.length]);
    for (const span of this._spans.values()) delete span.dataset[`m${layer}`];
    for (const m of marks) {
      for (const s of this.doc.sentences) {
        if (s.end > m.start && s.start < m.end) this._spans.get(s.sid).dataset[`m${layer}`] = m.color || 'yellow';
      }
    }
  }

  getSentenceRects(sid) {
    const span = this._spans.get(sid);
    if (!span) return [];
    const page = span.closest('.sv-page');
    const pr = page.getBoundingClientRect();
    return [...span.getClientRects()].map((r) => ({ page: Number(page.dataset.page), x: r.left - pr.left, y: r.top - pr.top, w: r.width, h: r.height }));
  }

  getSelectionAnchor() { return null; }
  setRegionCapture(on) { this.calls.push(['setRegionCapture', on]); this.container.classList.toggle('sv-capture', Boolean(on)); }

  setTranslationOverlay(map) {
    this.calls.push(['setTranslationOverlay', map ? map.size : null]);
    this.overlay = map;
    for (const [sid, span] of this._spans) {
      const ko = map?.get(sid);
      span.textContent = ko || this.doc.sentenceById.get(sid).text;
      span.classList.toggle('sv-ko', Boolean(ko));
    }
  }

  async renderRegion() { return document.createElement('canvas'); }

  destroy() {
    this.calls.push(['destroy']);
    this.destroyed = true;
    this.container.replaceChildren();
  }

  _setPage(n) {
    if (n === this._page) return;
    this._page = n;
    emit(this, 'pagechange', { page: n });
  }

  _onScroll() {
    const box = this.container.getBoundingClientRect();
    let page = 1;
    for (const p of this._pages) {
      const r = p.getBoundingClientRect();
      if (r.top - box.top <= box.height * 0.4) page = Number(p.dataset.page);
    }
    this._setPage(page);
    const visible = [];
    for (const [sid, span] of this._spans) {
      const r = span.getBoundingClientRect();
      if (r.bottom > box.top && r.top < box.bottom) visible.push(sid);
      if (visible.length > 30) break;
    }
    emit(this, 'visiblesentences', { sids: visible });
  }
}
