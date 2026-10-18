// PDF viewer: lazy page rendering, pdf.js text layer, sentence geometry, hover/selection/link
// hit-testing, mark layers, translation overlay and region capture.
//
// Geometry convention: everything cached is in "PDF units, top-left origin" = viewport coordinates
// at scale 1 (what doc.pages[].width/height use). On-screen positions are percentages of the page
// box, so zooming only changes the page size (one CSS variable) and never invalidates caches.
import { getPdfjs } from './pdfjs.js';
import { emit } from '../core/bus.js';
import { clamp, debounce, el, rafThrottle } from '../core/util.js';

const ZOOM_MIN = 0.25;
const ZOOM_MAX = 5;
const ZOOM_STEP = 1.15;
// Fit-width never enlarges past this: in full-width layouts a 612 pt page would otherwise reach 230 %+.
const FIT_WIDTH_MAX = 1.6;
const PAGE_PADDING = 16; // px around the page column (matches .pdfv-pages padding)
const RENDER_CONCURRENCY = 2;
const MAX_LIVE_CANVASES = 10; // pages keeping a rendered canvas
const MAX_LIVE_TEXT_LAYERS = 24; // pages keeping text-layer DOM (geometry is cached separately)
const MAX_CANVAS_PIXELS = 16_777_216;
const CAPTURE_MAX_PX = 4096;
const MARK_LAYERS = ['annotations', 'auto', 'search'];
const MARK_COLORS = new Set(['yellow', 'green', 'blue', 'pink', 'red', 'purple', 'orange', 'gray']);
const OVERLAY_KINDS = new Set(['body', 'heading', 'caption', 'reference']);

/**
 * @typedef {{x:number, y:number, w:number, h:number}} Box  PDF units, top-left origin
 * @typedef {{id:string, start:number, end:number, color?:string, style?:'fill'|'underline', title?:string}} Mark
 * @typedef {{
 *   n:number, width:number, height:number, el:HTMLElement, canvas:HTMLCanvasElement|null,
 *   hlLayer:HTMLElement, markLayers:Record<string,HTMLElement>, textLayerEl:HTMLElement, transLayer:HTMLElement,
 *   textLayer:any, textLayerScale:number, endOfContent?:HTMLElement, renderTask:any, renderedScale:number,
 *   rendering:boolean, near:boolean, sentRects:Map<string,Box[]>|null, hitRects:Array<Box & {sid:string, si:number}>,
 *   hl:{hover:HTMLElement[], active:HTMLElement[]}, markRects:Map<string,Map<string,Box[]>>,
 *   links:Array<object>|null, spanIndex:WeakMap<Element,number>|null
 * }} PageView
 */

export class PdfViewer extends EventTarget {
  /**
   * @param {HTMLElement} container scrollable element; the viewer owns its content
   * @param {{pdf:any, doc:object}} opts PDFDocumentProxy + PaperDoc from extractDocument()
   */
  constructor(container, { pdf, doc }) {
    super();
    this.container = container;
    this.pdf = pdf;
    this.doc = doc;
    this._zoom = 1;
    this._zoomMode = 'fit-width';
    /** @type {PageView[]} */
    this._pages = [];
    this._hoverSid = null;
    this._activeSid = null;
    /** @type {Map<string, Mark[]>} */
    this._marks = new Map(MARK_LAYERS.map((l) => [l, []]));
    /** @type {Map<string,string>|null} */
    this._overlay = null;
    this._capture = false;
    this._currentPage = 1;
    this._visibleKey = '';
    this._lastSelectionKey = '';
    this._hoverLink = null;
    this._pendingFlash = new Map(); // page → sid to flash once that page has geometry
    this._activeRenders = 0;
    this._charSentence = null;
    this._destroyed = false;
    this._abort = new AbortController();
    this._lib = null;
  }

  // ------------------------------------------------------------------------------------------
  // Lifecycle
  // ------------------------------------------------------------------------------------------

  /** Build page placeholders at fit-width and start lazy rendering near the viewport. */
  async init() {
    this._lib = await getPdfjs();
    const root = this.container;
    root.classList.add('pdfv-root');
    if (!root.hasAttribute('tabindex')) root.tabIndex = 0;
    root.replaceChildren();
    this._pagesEl = el('div', { class: 'pdfv-pages' });
    root.append(this._pagesEl);
    this._pages = this.doc.pages.map((info) => this._createPageView(info));
    this._pagesEl.append(...this._pages.map((pv) => pv.el));
    this._zoom = this._fitWidthScale();
    this._applyZoomVar();

    this._io = new IntersectionObserver((entries) => this._onIntersect(entries), {
      root,
      rootMargin: '150% 0px 150% 0px',
    });
    for (const pv of this._pages) this._io.observe(pv.el);
    this._bindEvents();
    this._updateCurrentPage();
  }

  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    this._abort.abort();
    this._io?.disconnect();
    this._ro?.disconnect();
    this._rerender?.cancel();
    this._emitVisibleSentencesThrottled?.cancel();
    for (const pv of this._pages) {
      pv.renderTask?.cancel();
      pv.textLayer?.cancel();
      this._releaseCanvas(pv);
    }
    this.container.replaceChildren();
    this.container.classList.remove('pdfv-root', 'pdfv-capturing', 'pdfv-overlay-on', 'pdfv-link-hover');
    this._pages = [];
  }

  // ------------------------------------------------------------------------------------------
  // Zoom & navigation
  // ------------------------------------------------------------------------------------------

  get zoom() { return this._zoom; }

  /** @param {number|'fit-width'} scale */
  setZoom(scale) {
    if (scale === 'fit-width') {
      this._zoomMode = 'fit-width';
      scale = this._fitWidthScale();
    } else {
      this._zoomMode = 'manual';
    }
    const z = clamp(Number(scale) || 1, ZOOM_MIN, ZOOM_MAX);
    if (Math.abs(z - this._zoom) < 1e-3) return;
    const anchor = this._scrollAnchor();
    this._zoom = z;
    this._applyZoomVar();
    this._restoreAnchor(anchor);
    this._rerender();
    emit(this, 'zoomchange', { zoom: z, mode: this._zoomMode });
  }

  zoomIn() { this.setZoom(Math.round(this._zoom * ZOOM_STEP * 100) / 100); }

  zoomOut() { this.setZoom(Math.round((this._zoom / ZOOM_STEP) * 100) / 100); }

  get currentPage() { return this._currentPage; }

  scrollToPage(n) {
    const pv = this._pages[clamp(n, 1, this._pages.length) - 1];
    if (!pv) return;
    this.container.scrollTop = pv.el.offsetTop - PAGE_PADDING / 2;
  }

  /**
   * @param {string} sid
   * @param {{block?:'center'|'start'|'nearest', flash?:boolean}} [opts]
   */
  scrollToSentence(sid, { block = 'center', flash = true } = {}) {
    const s = this.doc.sentenceById.get(sid);
    if (!s) return;
    const pv = this._pages[s.page - 1];
    const rects = pv.sentRects?.get(sid) || this._approxRects(s.page, s.start, s.end);
    if (rects.length) {
      const top = Math.min(...rects.map((r) => r.y));
      const bottom = Math.max(...rects.map((r) => r.y + r.h));
      this._scrollToPageY(pv, top, bottom, block);
    } else {
      this.scrollToPage(s.page);
    }
    if (flash) {
      if (pv.sentRects) this._flash(sid);
      else this._pendingFlash.set(s.page, sid);
    }
  }

  scrollToOffset(docOffset) {
    const hit = this._locateOffset(docOffset);
    if (!hit) return;
    const box = this._itemBox(hit.page, hit.item);
    this._scrollToPageY(this._pages[hit.page - 1], box.y, box.y + box.h, 'center');
  }

  /** Scroll so a PDF user-space point (origin bottom-left, as in link destinations) is near the top. */
  async scrollToPdfPoint(page, x, y) {
    const pv = this._pages[page - 1];
    if (!pv) return;
    const pt = await this._userToTopLeft(page, x, y);
    const z = this._pageScale(pv);
    this.container.scrollTop = pv.el.offsetTop + pt.y * z - 24;
    if (pt.x != null && this._pagesEl.scrollWidth > this.container.clientWidth) {
      this.container.scrollLeft = pv.el.offsetLeft + pt.x * z - 24;
    }
  }

  // ------------------------------------------------------------------------------------------
  // Highlights, marks, overlay
  // ------------------------------------------------------------------------------------------

  setHoverSentence(sid) {
    sid = sid || null;
    if (sid === this._hoverSid) return;
    this._hoverSid = sid;
    this._refreshHighlight('hover');
    this._syncOverlayHover();
  }

  setActiveSentence(sid) {
    sid = sid || null;
    if (sid === this._activeSid) return;
    this._activeSid = sid;
    this._refreshHighlight('active');
  }

  /**
   * @param {'annotations'|'auto'|'search'} layer
   * @param {Mark[]} marks
   */
  setMarks(layer, marks) {
    if (!this._marks.has(layer)) this._marks.set(layer, []);
    this._marks.set(layer, Array.isArray(marks) ? marks.filter((m) => m && m.end > m.start) : []);
    for (const pv of this._pages) if (pv.sentRects) this._drawMarks(pv, layer);
  }

  /**
   * Rects of a sentence in CSS px relative to each page box at the current zoom. Pages that were never
   * rendered fall back to item-box estimates (whole text items, proportional within an item).
   * @returns {{page:number, x:number, y:number, w:number, h:number}[]}
   */
  getSentenceRects(sid) {
    const s = this.doc.sentenceById.get(sid);
    if (!s) return [];
    const out = [];
    for (const page of s.pages.length ? s.pages : [s.page]) {
      const pv = this._pages[page - 1];
      const rects = pv.sentRects ? pv.sentRects.get(sid) || [] : this._approxRects(page, s.start, s.end);
      const z = this._pageScale(pv);
      for (const r of rects) out.push({ page, x: r.x * z, y: r.y * z, w: r.w * z, h: r.h * z });
    }
    return out;
  }

  /** The current DOM selection inside the text layers, mapped to doc offsets. */
  getSelectionAnchor() {
    const sel = document.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
    const range = sel.getRangeAt(0);
    if (!this.container.contains(range.commonAncestorContainer)) return null;
    let start = this._boundaryToDoc(range.startContainer, range.startOffset, 'start');
    let end = this._boundaryToDoc(range.endContainer, range.endOffset, 'end');
    if (start == null || end == null || end <= start) return null;
    const text = this.doc.text;
    while (start < end && /\s/.test(text[start])) start++;
    while (end > start && /\s/.test(text[end - 1])) end--;
    if (end <= start) return null;
    return { start, end, text: text.slice(start, end), rect: range.getBoundingClientRect() };
  }

  setRegionCapture(on) {
    this._capture = Boolean(on);
    this.container.classList.toggle('pdfv-capturing', this._capture);
    if (!this._capture) this._cancelCaptureDrag();
  }

  /** @param {Map<string,string>|null} map sid → Korean translation; null turns the overlay off */
  setTranslationOverlay(map) {
    this._overlay = map && map.size ? map : null;
    this.container.classList.toggle('pdfv-overlay-on', Boolean(this._overlay));
    for (const pv of this._pages) if (pv.sentRects) this._drawOverlay(pv);
  }

  /**
   * Render part of a page to a canvas (previews, captures).
   * @param {number} page
   * @param {Box} rect PDF units, top-left origin
   * @param {number} [cssWidth] display width in CSS px; backing store is ≥ 2× that
   * @returns {Promise<HTMLCanvasElement>}
   */
  async renderRegion(page, { x, y, w, h }, cssWidth = w * this._zoom) {
    const proxy = await this.pdf.getPage(page);
    const density = Math.max(2, window.devicePixelRatio || 1);
    let scale = (cssWidth * density) / Math.max(1, w);
    scale = Math.min(scale, CAPTURE_MAX_PX / Math.max(1, w, h));
    const viewport = proxy.getViewport({ scale, offsetX: -x * scale, offsetY: -y * scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.ceil(w * scale));
    canvas.height = Math.max(1, Math.ceil(h * scale));
    canvas.style.width = `${cssWidth}px`;
    canvas.style.height = `${(cssWidth * h) / Math.max(1, w)}px`;
    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await proxy.render({ canvasContext: ctx, viewport, background: '#ffffff' }).promise;
    return canvas;
  }

  // ------------------------------------------------------------------------------------------
  // Pages: DOM, zoom, scheduling
  // ------------------------------------------------------------------------------------------

  _createPageView(info) {
    const n = info.pageNumber;
    const pageEl = el('div', {
      class: 'pdfv-page',
      dataset: { page: n },
      style: { width: `calc(var(--scale-factor) * ${info.width}px)`, height: `calc(var(--scale-factor) * ${info.height}px)` },
      'aria-label': `${n}쪽`,
    });
    const hlLayer = el('div', { class: 'pdfv-hl-layer', 'aria-hidden': 'true' });
    const markLayers = {};
    for (const layer of MARK_LAYERS) markLayers[layer] = el('div', { class: `pdfv-mark-layer pdfv-mark-layer--${layer}`, 'aria-hidden': 'true' });
    const textLayerEl = el('div', { class: 'textLayer' });
    const transLayer = el('div', { class: 'pdfv-trans-layer' });
    pageEl.append(...Object.values(markLayers), hlLayer, textLayerEl, transLayer);
    return {
      n,
      width: info.width,
      height: info.height,
      el: pageEl,
      canvas: null,
      hlLayer,
      markLayers,
      textLayerEl,
      transLayer,
      textLayer: null,
      textLayerScale: 0,
      renderTask: null,
      renderedScale: 0,
      rendering: false,
      near: false,
      sentRects: null, // Map<sid, Box[]> once the text layer has been measured
      hitRects: [],
      hl: { hover: [], active: [] }, // highlight elements currently drawn
      markRects: new Map(), // layer → Map<markId, Box[]>
      links: null,
      spanIndex: null,
    };
  }

  /** Zoom is one CSS variable; page boxes, text layers and overlays all derive from it. */
  _applyZoomVar() {
    this._pagesEl.style.setProperty('--scale-factor', String(this._zoom));
  }

  _fitWidthScale() {
    const maxWidth = Math.max(...this.doc.pages.map((p) => p.width), 1);
    const avail = (this.container.clientWidth || 800) - 2 * PAGE_PADDING;
    return clamp(avail / maxWidth, ZOOM_MIN, FIT_WIDTH_MAX);
  }

  /** CSS px per PDF unit for a page box (exact, from layout). */
  _pageScale(pv) {
    return pv.el.offsetWidth / pv.width || this._zoom;
  }

  _scrollAnchor() {
    const top = this.container.scrollTop;
    const pv = this._pageAt(top + 1) || this._pages[0];
    return {
      pv,
      frac: (top - pv.el.offsetTop) / Math.max(1, pv.el.offsetHeight),
      xFrac: (this.container.scrollLeft + this.container.clientWidth / 2) / Math.max(1, this._pagesEl.scrollWidth),
    };
  }

  _restoreAnchor({ pv, frac, xFrac }) {
    this.container.scrollTop = pv.el.offsetTop + frac * pv.el.offsetHeight;
    this.container.scrollLeft = xFrac * this._pagesEl.scrollWidth - this.container.clientWidth / 2;
  }

  _pageAt(y) {
    const pages = this._pages;
    let lo = 0;
    let hi = pages.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (pages[mid].el.offsetTop <= y) lo = mid;
      else hi = mid - 1;
    }
    return pages[lo];
  }

  _onIntersect(entries) {
    for (const e of entries) {
      const pv = this._pages[Number(e.target.dataset.page) - 1];
      if (pv) pv.near = e.isIntersecting;
    }
    this._pump();
  }

  /** Start renders for near pages (closest to the current page first), then evict far ones. */
  _pump() {
    if (this._destroyed) return;
    const wanted = this._pages
      .filter((pv) => pv.near && !pv.rendering && pv.renderedScale !== this._zoom)
      .sort((a, b) => Math.abs(a.n - this._currentPage) - Math.abs(b.n - this._currentPage));
    while (this._activeRenders < RENDER_CONCURRENCY && wanted.length) {
      const pv = wanted.shift();
      this._activeRenders++;
      this._renderPage(pv)
        .catch((err) => {
          if (err?.name !== 'RenderingCancelledException' && err?.name !== 'AbortException') {
            console.warn('[pdf] page render failed', pv.n, err);
          }
        })
        .finally(() => {
          this._activeRenders--;
          this._pump();
        });
    }
    this._evict();
  }

  async _renderPage(pv) {
    pv.rendering = true;
    try {
      const page = await this.pdf.getPage(pv.n);
      if (this._destroyed) return;
      // pdf.js text layers size themselves from the raw page box × --total-scale-factor.
      pv.el.style.setProperty('--user-unit', String(page.userUnit || 1));
      const scale = this._zoom;
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.className = 'pdfv-canvas';
      let outScale = window.devicePixelRatio || 1;
      const pixels = viewport.width * viewport.height * outScale * outScale;
      if (pixels > MAX_CANVAS_PIXELS) outScale = Math.sqrt(MAX_CANVAS_PIXELS / (viewport.width * viewport.height));
      canvas.width = Math.floor(viewport.width * outScale);
      canvas.height = Math.floor(viewport.height * outScale);
      const ctx = canvas.getContext('2d', { alpha: false });
      pv.renderTask = page.render({
        canvasContext: ctx,
        viewport,
        transform: outScale !== 1 ? [outScale, 0, 0, outScale, 0, 0] : null,
      });
      await pv.renderTask.promise;
      pv.renderTask = null;
      if (this._destroyed) return;
      // Swap in the new canvas only when complete: zooming never shows a blank page.
      if (pv.canvas) this._releaseCanvas(pv);
      pv.canvas = canvas;
      pv.el.prepend(canvas);
      pv.renderedScale = scale;

      if (!pv.textLayer) await this._buildTextLayer(pv, page, viewport);
      else if (pv.textLayerScale !== scale) {
        pv.textLayer.update({ viewport });
        pv.textLayerScale = scale;
      }
      if (!pv.links) this._loadLinks(pv, page);
      emit(this, 'rendered', { page: pv.n });
      this._emitVisibleSentences();
    } finally {
      pv.rendering = false;
    }
  }

  async _buildTextLayer(pv, page, viewport) {
    let textContent;
    try {
      // Same call as extract.js: item indices must line up with doc._itemToDoc.
      textContent = await page.getTextContent();
    } catch (err) {
      console.warn('[pdf] getTextContent failed', pv.n, err);
      textContent = { items: [], styles: {} };
    }
    pv.textLayerEl.replaceChildren();
    // pdf.js measures glyph widths on a hidden canvas whose lang is the PDF's language, then stretches
    // each span to the PDF width. The spans must resolve the same generic font: under the app's
    // <html lang="ko"> (or lang="" on a Korean-locale system) "serif" becomes Batang instead of Times
    // and every span ends up 10–20% too wide. An explicit language on both sides keeps them identical.
    textContent.lang ||= 'en';
    pv.textLayerEl.setAttribute('lang', textContent.lang);
    const textLayer = new this._lib.TextLayer({ textContentSource: textContent, container: pv.textLayerEl, viewport });
    await textLayer.render();
    if (this._destroyed) return;
    pv.textLayer = textLayer;
    pv.textLayerScale = viewport.scale;
    pv.endOfContent = el('div', { class: 'endOfContent' });
    pv.textLayerEl.append(pv.endOfContent);
    pv.spanIndex = new WeakMap();
    textLayer.textDivs.forEach((span, i) => pv.spanIndex.set(span, i));
    if (!pv.sentRects) this._measurePage(pv);
    this._drawPageDecorations(pv);
  }

  _releaseCanvas(pv) {
    if (!pv.canvas) return;
    pv.canvas.width = 0;
    pv.canvas.height = 0;
    pv.canvas.remove();
    pv.canvas = null;
  }

  /** Bound memory: drop canvases / text layers of pages far from the viewport. */
  _evict() {
    const live = this._pages.filter((pv) => pv.canvas && !pv.near && !pv.rendering);
    const liveCount = this._pages.filter((pv) => pv.canvas).length;
    if (liveCount > MAX_LIVE_CANVASES) {
      live.sort((a, b) => Math.abs(b.n - this._currentPage) - Math.abs(a.n - this._currentPage));
      for (const pv of live.slice(0, liveCount - MAX_LIVE_CANVASES)) {
        this._releaseCanvas(pv);
        pv.renderedScale = 0;
      }
    }
    const withText = this._pages.filter((pv) => pv.textLayer && !pv.near && !pv.rendering);
    const textCount = this._pages.filter((pv) => pv.textLayer).length;
    if (textCount > MAX_LIVE_TEXT_LAYERS) {
      withText.sort((a, b) => Math.abs(b.n - this._currentPage) - Math.abs(a.n - this._currentPage));
      for (const pv of withText.slice(0, textCount - MAX_LIVE_TEXT_LAYERS)) {
        pv.textLayer.cancel();
        pv.textLayer = null;
        pv.textLayerEl.replaceChildren();
        pv.spanIndex = null;
        this._releaseCanvas(pv);
        pv.renderedScale = 0;
      }
    }
  }

  // ------------------------------------------------------------------------------------------
  // Geometry
  // ------------------------------------------------------------------------------------------

  /** doc offset → sentence index (Int32Array, −1 outside sentences). */
  _sentenceIndexOfChar() {
    if (!this._charSentence) {
      const arr = new Int32Array(this.doc.text.length).fill(-1);
      this.doc.sentences.forEach((s, k) => arr.fill(k, s.start, s.end));
      this._charSentence = arr;
    }
    return this._charSentence;
  }

  /** Runs of consecutive chars of one text item inside [start, end) on `page`. */
  _runs(page, start, end) {
    const { charPage, charItem, charOff } = this.doc._map;
    const text = this.doc.text;
    const runs = [];
    let cur = null;
    for (let d = start; d < end; d++) {
      if (charPage[d] !== page || text.charCodeAt(d) <= 32) continue;
      const item = charItem[d];
      const off = charOff[d];
      if (cur && cur.item === item && off === cur.b) cur.b = off + 1;
      else runs.push((cur = { item, a: off, b: off + 1 }));
    }
    return runs;
  }

  /**
   * Measure text-layer ranges → boxes in PDF units, merged per line.
   * Along the text direction the Range rects are exact; across it they cover the fallback font's
   * whole content area (taller than the glyphs and shifted down), so that extent is taken from the
   * span box, which pdf.js places on the PDF glyphs.
   */
  _measureRuns(pv, runs, pageBox, k) {
    const divs = pv.textLayer?.textDivs;
    if (!divs) return [];
    const range = document.createRange();
    const byAxis = { h: [], v: [], other: [] };
    const spanBoxes = new Map();
    for (const { item, a, b } of runs) {
      const span = divs[item];
      const node = span?.firstChild;
      if (!node || node.nodeType !== Node.TEXT_NODE || !span.isConnected) continue;
      let sb = spanBoxes.get(item);
      if (!sb) spanBoxes.set(item, (sb = { rect: span.getBoundingClientRect(), axis: spanAxis(span) }));
      const len = node.length;
      range.setStart(node, Math.min(a, len));
      range.setEnd(node, Math.min(b, len));
      for (const r of range.getClientRects()) {
        if (r.width < 0.3 || r.height < 0.3) continue;
        let { left, top, width, height } = r;
        if (sb.axis === 'h') ({ top, height } = sb.rect);
        else if (sb.axis === 'v') ({ left, width } = sb.rect);
        byAxis[sb.axis].push({ x: (left - pageBox.left) / k, y: (top - pageBox.top) / k, w: width / k, h: height / k });
      }
    }
    // Vertical text (landscape tables) is merged in a transposed frame: its "lines" are columns.
    const transpose = (b) => ({ x: b.y, y: b.x, w: b.h, h: b.w });
    return [
      ...mergeLineBoxes(byAxis.h),
      ...mergeLineBoxes(byAxis.v.map(transpose)).map(transpose),
      ...byAxis.other,
    ];
  }

  /** Compute every sentence's boxes on a page once its text layer exists. */
  _measurePage(pv) {
    const itemToDoc = this.doc._itemToDoc?.[pv.n];
    const divs = pv.textLayer.textDivs;
    pv.sentRects = new Map();
    pv.hitRects = [];
    if (!itemToDoc || divs.length !== itemToDoc.length
      || divs.some((d, i) => d.textContent.length !== (itemToDoc[i]?.length ?? 0))) {
      console.warn('[pdf] text layer does not match extracted items on page', pv.n, divs.length, itemToDoc?.length);
      return;
    }
    const info = this.doc.pages[pv.n - 1];
    const charSentence = this._sentenceIndexOfChar();
    const pageBox = pv.el.getBoundingClientRect();
    const k = pageBox.width / pv.width;
    // Group the page's chars by sentence, then measure each sentence's runs.
    const bySentence = new Map();
    const { charPage, charItem, charOff } = this.doc._map;
    const text = this.doc.text;
    for (let d = info.textStart; d < info.textEnd; d++) {
      if (charPage[d] !== pv.n) continue;
      const si = charSentence[d];
      if (si < 0 || text.charCodeAt(d) <= 32) continue; // spaces never define geometry
      let runs = bySentence.get(si);
      if (!runs) bySentence.set(si, (runs = []));
      const last = runs[runs.length - 1];
      if (last && last.item === charItem[d] && last.b === charOff[d]) last.b++;
      else runs.push({ item: charItem[d], a: charOff[d], b: charOff[d] + 1 });
    }
    for (const [si, runs] of bySentence) {
      const sid = this.doc.sentences[si].sid;
      const boxes = this._measureRuns(pv, runs, pageBox, k);
      if (!boxes.length) continue;
      pv.sentRects.set(sid, boxes);
      for (const b of boxes) pv.hitRects.push({ sid, si, ...b });
    }
  }

  /** Estimated boxes for chars on a page without measured geometry (item boxes, proportional split). */
  _approxRects(page, start, end) {
    const g = this.doc._geom?.[page];
    if (!g) return [];
    const boxes = [];
    for (const { item, a, b } of this._runs(page, start, end)) {
      const len = this.doc._itemToDoc[page][item].length || 1;
      const o = item * 4;
      boxes.push({ x: g[o] + (g[o + 2] * a) / len, y: g[o + 1], w: (g[o + 2] * (b - a)) / len, h: g[o + 3] });
    }
    return mergeLineBoxes(boxes);
  }

  _itemBox(page, item) {
    const g = this.doc._geom[page];
    const o = item * 4;
    return { x: g[o], y: g[o + 1], w: g[o + 2], h: g[o + 3] };
  }

  /** Nearest mapped char at/after (or before) a doc offset. */
  _locateOffset(offset) {
    const { charPage, charItem } = this.doc._map;
    const n = charPage.length;
    for (let d = clamp(offset, 0, n - 1), back = d; d < n || back >= 0; d++, back--) {
      if (d < n && charPage[d] > 0) return { page: charPage[d], item: charItem[d] };
      if (back >= 0 && charPage[back] > 0) return { page: charPage[back], item: charItem[back] };
    }
    return null;
  }

  async _userToTopLeft(page, x, y) {
    const proxy = await this.pdf.getPage(page);
    const vp = proxy.getViewport({ scale: 1 });
    const view = proxy.view;
    const ux = x ?? view[0];
    const uy = y ?? view[3];
    const [px, py] = vp.convertToViewportPoint(ux, uy);
    return { x: x == null ? null : px, y: py };
  }

  _scrollToPageY(pv, top, bottom, block) {
    const z = this._pageScale(pv);
    const viewH = this.container.clientHeight;
    const absTop = pv.el.offsetTop + top * z;
    const absBottom = pv.el.offsetTop + bottom * z;
    let target;
    if (block === 'start') target = absTop - 24;
    else if (block === 'nearest') {
      const cur = this.container.scrollTop;
      if (absTop >= cur + 24 && absBottom <= cur + viewH - 24) return;
      target = absTop < cur + 24 ? absTop - 24 : absBottom - viewH + 24;
    } else target = (absTop + absBottom) / 2 - viewH / 2;
    this.container.scrollTop = Math.max(0, target);
  }

  // ------------------------------------------------------------------------------------------
  // Drawing
  // ------------------------------------------------------------------------------------------

  _drawPageDecorations(pv) {
    this._drawHighlight(pv, 'hover');
    this._drawHighlight(pv, 'active');
    for (const layer of this._marks.keys()) this._drawMarks(pv, layer);
    this._drawOverlay(pv);
    const pending = this._pendingFlash.get(pv.n);
    if (pending) {
      this._pendingFlash.delete(pv.n);
      this._flash(pending);
    }
  }

  /** Redraw the hover or active highlight on every page that shows it now or should. */
  _refreshHighlight(kind) {
    const sid = kind === 'hover' ? this._hoverSid : this._activeSid;
    const pages = new Set(sid ? this.doc.sentenceById.get(sid)?.pages ?? [] : []);
    for (const pv of this._pages) if (pv.hl[kind].length || pages.has(pv.n)) this._drawHighlight(pv, kind);
  }

  _drawHighlight(pv, kind) {
    for (const node of pv.hl[kind]) node.remove();
    pv.hl[kind] = [];
    const sid = kind === 'hover' ? this._hoverSid : this._activeSid;
    if (!sid || !pv.sentRects) return;
    for (const r of pv.sentRects.get(sid) || []) {
      const node = this._boxEl(pv, r, `pdfv-hl pdfv-hl--${kind}`);
      pv.hlLayer.append(node);
      pv.hl[kind].push(node);
    }
  }

  _flash(sid) {
    const s = this.doc.sentenceById.get(sid);
    if (!s) return;
    for (const n of s.pages.length ? s.pages : [s.page]) {
      const pv = this._pages[n - 1];
      for (const r of pv.sentRects?.get(sid) || []) {
        const node = this._boxEl(pv, r, 'pdfv-hl pdfv-hl--flash');
        node.addEventListener('animationend', () => node.remove(), { once: true });
        setTimeout(() => node.remove(), 2000);
        pv.hlLayer.append(node);
      }
    }
  }

  _boxEl(pv, r, className) {
    return el('div', {
      class: className,
      style: {
        left: `${(r.x / pv.width) * 100}%`,
        top: `${(r.y / pv.height) * 100}%`,
        width: `${(r.w / pv.width) * 100}%`,
        height: `${(r.h / pv.height) * 100}%`,
      },
    });
  }

  _drawMarks(pv, layer) {
    const host = pv.markLayers[layer];
    if (!host) return;
    host.replaceChildren();
    const marks = this._marks.get(layer) || [];
    if (!marks.length || !pv.sentRects) return;
    const info = this.doc.pages[pv.n - 1];
    let cache = pv.markRects.get(layer);
    if (!cache || cache.size > 2000) pv.markRects.set(layer, (cache = new Map())); // search marks churn
    let pageBox = null;
    for (const m of marks) {
      if (m.end <= info.textStart || m.start >= info.textEnd) continue;
      const key = `${m.start}:${m.end}`; // geometry depends on the range only
      let boxes = cache.get(key);
      if (!boxes) {
        if (!pv.textLayer) continue;
        pageBox ??= pv.el.getBoundingClientRect();
        boxes = this._measureRuns(pv, this._runs(pv.n, Math.max(m.start, info.textStart), Math.min(m.end, info.textEnd)), pageBox, pageBox.width / pv.width);
        cache.set(key, boxes);
      }
      const style = m.style === 'underline' ? 'underline' : 'fill';
      const color = MARK_COLORS.has(m.color) ? m.color : 'yellow';
      for (const r of boxes) {
        const node = this._boxEl(pv, r, `pdfv-mark pdfv-mark--${style} pdfv-mark--${color}`);
        node.dataset.markId = m.id;
        if (m.title) node.title = m.title;
        host.append(node);
      }
    }
  }

  /** Paint Korean text over each paragraph box (layout-preserving translation view). */
  _drawOverlay(pv) {
    pv.transLayer.replaceChildren();
    if (!this._overlay || !pv.sentRects) return;
    for (const group of this._paragraphBoxes(pv)) {
      const parts = group.sentences.map((s) => ({ s, t: this._overlay.get(s.sid) }));
      // Regions holding only the tail of a sentence written on the previous page get a marker.
      const tailOnly = !parts.length && group.covered.some((s) => this._overlay.has(s.sid));
      if (!tailOnly && !parts.some((p) => p.t)) continue;
      const box = el('div', {
        class: `pdfv-tbox pdfv-tbox--${group.kind}`,
        style: {
          left: `${(group.box.x / pv.width) * 100}%`,
          top: `${(group.box.y / pv.height) * 100}%`,
          width: `${(group.box.w / pv.width) * 100}%`,
          height: `${(group.box.h / pv.height) * 100}%`,
        },
      });
      parts.forEach(({ s, t }, k) => {
        if (k) box.append(' ');
        box.append(el('span', { class: t ? 'pdfv-tsent' : 'pdfv-tsent pdfv-tsent--missing', dataset: { sid: s.sid } }, t || s.text));
      });
      if (tailOnly) {
        const sid = group.covered.find((s) => this._overlay.has(s.sid)).sid;
        box.append(el('span', { class: 'pdfv-tsent pdfv-tsent--tail', dataset: { sid } }, '(앞 쪽에서 이어짐)'));
      }
      pv.transLayer.append(box);
      fitText(box, group.lineHeight);
    }
    this._syncOverlayHover();
  }

  /**
   * Paragraph regions on a page: a paragraph's line boxes split into vertically contiguous columns.
   * Each sentence is listed once, in the region holding most of its area on this page.
   */
  _paragraphBoxes(pv) {
    const groups = [];
    const pids = new Set([...pv.sentRects.keys()].map((sid) => this.doc.sentenceById.get(sid).pid));
    for (const para of this.doc.paragraphs) {
      if (!pids.has(para.pid) || !OVERLAY_KINDS.has(para.kind)) continue;
      const lines = [];
      for (const sid of para.sids) for (const r of pv.sentRects.get(sid) || []) lines.push({ sid, ...r });
      if (!lines.length) continue;
      lines.sort((a, b) => a.x - b.x || a.y - b.y);
      const regions = [];
      for (const r of lines) {
        const reg = regions.find((g) => r.x < g.x1 && r.x + r.w > g.x0 - 2 && r.y <= g.y1 + 2.2 * r.h && r.y + r.h >= g.y0 - 2.2 * r.h);
        if (reg) {
          reg.x0 = Math.min(reg.x0, r.x); reg.x1 = Math.max(reg.x1, r.x + r.w);
          reg.y0 = Math.min(reg.y0, r.y); reg.y1 = Math.max(reg.y1, r.y + r.h);
          reg.items.push(r);
        } else {
          regions.push({ x0: r.x, x1: r.x + r.w, y0: r.y, y1: r.y + r.h, items: [r] });
        }
      }
      const home = new Map();
      for (const sid of para.sids) {
        let best = null;
        let bestArea = 0;
        for (const reg of regions) {
          const area = reg.items.filter((i) => i.sid === sid).reduce((a, i) => a + i.w * i.h, 0);
          if (area > bestArea) { best = reg; bestArea = area; }
        }
        if (best) home.set(sid, best);
      }
      for (const reg of regions) {
        // A sentence spanning pages is written once, on its first page.
        const own = para.sids
          .filter((sid) => home.get(sid) === reg && this.doc.sentenceById.get(sid).page === pv.n)
          .map((sid) => this.doc.sentenceById.get(sid));
        const covered = [...new Set(reg.items.map((i) => i.sid))].map((sid) => this.doc.sentenceById.get(sid));
        const heights = reg.items.map((i) => i.h).sort((a, b) => a - b);
        groups.push({
          kind: para.kind,
          box: { x: reg.x0 - 1, y: reg.y0 - 1, w: reg.x1 - reg.x0 + 2, h: reg.y1 - reg.y0 + 2 },
          lineHeight: heights[heights.length >> 1] || 10,
          sentences: own,
          covered,
        });
      }
    }
    return groups;
  }

  _syncOverlayHover() {
    for (const pv of this._pages) {
      for (const n of pv.transLayer.querySelectorAll('.pdfv-tsent--hover')) n.classList.remove('pdfv-tsent--hover');
    }
    if (!this._overlay || !this._hoverSid) return;
    for (const n of this.container.querySelectorAll(`.pdfv-tsent[data-sid="${CSS.escape(this._hoverSid)}"]`)) {
      n.classList.add('pdfv-tsent--hover');
    }
  }

  // ------------------------------------------------------------------------------------------
  // Events
  // ------------------------------------------------------------------------------------------

  _bindEvents() {
    const opts = { signal: this._abort.signal };
    const root = this.container;
    const onScroll = rafThrottle(() => {
      this._updateCurrentPage();
      this._emitVisibleSentencesThrottled();
    });
    root.addEventListener('scroll', onScroll, { ...opts, passive: true });
    const onMove = rafThrottle((e) => this._onPointerMove(e));
    root.addEventListener('pointermove', (e) => {
      if (this._dragCapture) this._updateCaptureDrag(e);
      else onMove(e);
    }, opts);
    root.addEventListener('pointerleave', () => this._setHoverFromPointer(null, null), opts);
    root.addEventListener('pointerdown', (e) => this._onPointerDown(e), opts);
    root.addEventListener('pointerup', (e) => this._onPointerUp(e), opts);
    root.addEventListener('click', (e) => this._onClick(e), opts);
    root.addEventListener('keyup', () => this._emitSelectionSoon(), opts);
    root.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this._dragCapture) this._cancelCaptureDrag();
    }, opts);
    root.addEventListener('copy', (e) => this._onCopy(e), opts);
    root.addEventListener('wheel', (e) => this._onWheel(e), { ...opts, passive: false });
    const onDocSelection = debounce(() => this._emitSelection(), 250);
    document.addEventListener('selectionchange', onDocSelection, opts);
    this._bindSelectionHelper(opts);
    this._ro = new ResizeObserver(debounce(() => {
      if (this._zoomMode === 'fit-width' && !this._destroyed) this.setZoom('fit-width');
    }, 120));
    this._ro.observe(root);
    this._rerender = debounce(() => this._pump(), 150);
    this._emitVisibleSentencesThrottled = debounce(() => this._emitVisibleSentences(), 120);
  }

  /**
   * Port of pdf.js TextLayerBuilder's selection helper: while selecting, the .endOfContent block is
   * moved right after the selection focus so drags through gaps (or starting at a line's first glyph)
   * extend the selection sensibly instead of collapsing it or jumping to the end of the page.
   */
  _bindSelectionHelper(opts) {
    let pointerDown = false;
    let prevRange = null;
    const reset = (pv) => {
      if (!pv.endOfContent) return;
      pv.textLayerEl.append(pv.endOfContent);
      pv.endOfContent.style.width = '';
      pv.endOfContent.style.height = '';
      pv.textLayerEl.classList.remove('selecting');
    };
    const resetAll = () => this._pages.forEach(reset);
    document.addEventListener('pointerdown', () => { pointerDown = true; }, opts);
    document.addEventListener('pointerup', () => { pointerDown = false; resetAll(); }, opts);
    window.addEventListener('blur', () => { pointerDown = false; resetAll(); }, opts);
    document.addEventListener('keyup', () => { if (!pointerDown) resetAll(); }, opts);
    document.addEventListener('selectionchange', () => {
      const sel = document.getSelection();
      if (!sel || sel.rangeCount === 0) {
        resetAll();
        return;
      }
      const range = sel.getRangeAt(0);
      if (!this.container.contains(range.commonAncestorContainer) && !range.intersectsNode(this.container)) return;
      for (const pv of this._pages) {
        if (!pv.textLayer) continue;
        if (range.intersectsNode(pv.textLayerEl)) pv.textLayerEl.classList.add('selecting');
        else reset(pv);
      }
      const modifyStart = prevRange && (range.compareBoundaryPoints(Range.END_TO_END, prevRange) === 0
        || range.compareBoundaryPoints(Range.START_TO_END, prevRange) === 0);
      let anchor = modifyStart ? range.startContainer : range.endContainer;
      if (anchor.nodeType === Node.TEXT_NODE) anchor = anchor.parentNode;
      if (!modifyStart && range.endOffset === 0) {
        do {
          while (anchor && !anchor.previousSibling && this.container.contains(anchor)) anchor = anchor.parentNode;
          anchor = anchor?.previousSibling;
        } while (anchor && !anchor.childNodes.length);
      }
      const layer = anchor?.parentElement?.closest('.textLayer');
      const pv = layer && this._pages.find((p) => p.textLayerEl === layer);
      if (pv?.endOfContent && anchor.parentElement) {
        pv.endOfContent.style.width = layer.style.width;
        pv.endOfContent.style.height = layer.style.height;
        anchor.parentElement.insertBefore(pv.endOfContent, modifyStart ? anchor : anchor.nextSibling);
      }
      prevRange = range.cloneRange();
    }, opts);
  }

  _updateCurrentPage() {
    if (!this._pages.length) return;
    const mid = this.container.scrollTop + this.container.clientHeight * 0.35;
    const pv = this._pageAt(mid);
    if (pv && pv.n !== this._currentPage) {
      this._currentPage = pv.n;
      emit(this, 'pagechange', { page: pv.n });
    }
  }

  /** Page view + PDF-unit point under a client position. */
  _pointToPage(clientX, clientY, target) {
    const pageEl = target?.closest?.('.pdfv-page') || document.elementsFromPoint(clientX, clientY).find((n) => n.classList?.contains('pdfv-page'));
    if (!pageEl || !this.container.contains(pageEl)) return null;
    const pv = this._pages[Number(pageEl.dataset.page) - 1];
    const box = pageEl.getBoundingClientRect();
    const k = box.width / pv.width;
    return { pv, x: (clientX - box.left) / k, y: (clientY - box.top) / k, box, k };
  }

  _onPointerMove(e) {
    if (this._destroyed || this._capture) return;
    const hit = this._pointToPage(e.clientX, e.clientY, e.target);
    if (!hit) {
      this._setHoverFromPointer(null, null);
      return;
    }
    // Translation overlay: the Korean span under the pointer names the sentence.
    const tsent = e.target?.closest?.('.pdfv-tsent');
    const sid = tsent ? tsent.dataset.sid : this._hitSentence(hit.pv, hit.x, hit.y);
    this._setHoverFromPointer(sid, hit);
  }

  _setHoverFromPointer(sid, hit) {
    if ((sid || null) !== this._hoverSid) {
      this.setHoverSentence(sid);
      emit(this, 'sentencehover', { sid: sid || null });
    }
    const link = hit ? this._hitLink(hit.pv, hit.x, hit.y) : null;
    if (link !== this._hoverLink) {
      if (this._hoverLink) emit(this, 'linkleave', {});
      this._hoverLink = link;
      this.container.classList.toggle('pdfv-link-hover', Boolean(link));
      if (link) {
        const r = link.rect;
        const clientRect = new DOMRect(hit.box.left + r.x * hit.k, hit.box.top + r.y * hit.k, r.w * hit.k, r.h * hit.k);
        const detail = { kind: link.kind, clientRect };
        if (link.kind === 'internal') detail.target = link.target;
        else detail.url = link.url;
        emit(this, 'linkhover', detail);
      }
    }
  }

  /** Sentence whose (vertically padded) line box contains the point; nearest line wins. */
  _hitSentence(pv, x, y) {
    let best = null;
    let bestDist = Infinity;
    for (const r of pv.hitRects) {
      if (x < r.x - 1 || x > r.x + r.w + 1) continue;
      const pad = r.h * 0.35;
      if (y < r.y - pad || y > r.y + r.h + pad) continue;
      const dist = Math.abs(y - (r.y + r.h / 2));
      if (dist < bestDist) { best = r; bestDist = dist; }
    }
    return best ? best.sid : null;
  }

  _hitLink(pv, x, y) {
    if (!pv.links) return null;
    return pv.links.find((l) => x >= l.rect.x && x <= l.rect.x + l.rect.w && y >= l.rect.y && y <= l.rect.y + l.rect.h
      && (l.kind === 'external' || l.target)) || null;
  }

  _onPointerDown(e) {
    if (this._capture && e.button === 0) {
      const hit = this._pointToPage(e.clientX, e.clientY, e.target);
      if (!hit) return;
      e.preventDefault();
      this._startCaptureDrag(e, hit);
      return;
    }
    const layer = e.target?.closest?.('.textLayer');
    if (layer) layer.classList.add('selecting');
    this._downAt = { x: e.clientX, y: e.clientY };
  }

  _onPointerUp(e) {
    if (this._dragCapture) {
      this._finishCaptureDrag(e);
      return;
    }
    for (const n of this.container.querySelectorAll('.textLayer.selecting')) n.classList.remove('selecting');
    this._emitSelectionSoon();
  }

  _onClick(e) {
    if (this._capture) return;
    const moved = this._downAt && Math.hypot(e.clientX - this._downAt.x, e.clientY - this._downAt.y) > 4;
    const sel = document.getSelection();
    if (moved || (sel && !sel.isCollapsed && this.container.contains(sel.anchorNode))) return;
    const hit = this._pointToPage(e.clientX, e.clientY, e.target);
    if (!hit) return;
    const link = this._hitLink(hit.pv, hit.x, hit.y);
    if (link) {
      e.preventDefault();
      if (link.kind === 'internal') {
        this.scrollToPdfPoint(link.target.page, link.target.x, link.target.y).catch((err) => console.warn('[pdf] link jump failed', err));
      } else {
        window.open(link.url, '_blank', 'noopener,noreferrer');
      }
      return;
    }
    const markEl = this._markAt(e.clientX, e.clientY);
    if (markEl) {
      emit(this, 'markclick', { layer: markEl.layer, id: markEl.id, clientRect: markEl.rect });
    }
    const tsent = e.target?.closest?.('.pdfv-tsent');
    const sid = tsent ? tsent.dataset.sid : this._hitSentence(hit.pv, hit.x, hit.y);
    if (sid) emit(this, 'sentenceclick', { sid });
  }

  /** Mark under a client point (marks are pointer-transparent, so hit-test their boxes). */
  _markAt(clientX, clientY) {
    for (const layer of MARK_LAYERS) {
      for (const node of this.container.querySelectorAll(`.pdfv-mark-layer--${layer} .pdfv-mark`)) {
        const r = node.getBoundingClientRect();
        if (clientX >= r.left && clientX <= r.right && clientY >= r.top - 2 && clientY <= r.bottom + 2) {
          return { layer, id: node.dataset.markId, rect: r };
        }
      }
    }
    return null;
  }

  _onWheel(e) {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    const now = performance.now();
    if (now - (this._lastWheelZoom || 0) < 60) return;
    this._lastWheelZoom = now;
    if (e.deltaY < 0) this.zoomIn();
    else if (e.deltaY > 0) this.zoomOut();
  }

  _onCopy(e) {
    const anchor = this.getSelectionAnchor();
    if (!anchor || !e.clipboardData) return;
    // De-hyphenated, reflowed text instead of the text layer's raw line breaks.
    e.clipboardData.setData('text/plain', anchor.text.replace(/\n\n/g, '\n'));
    e.preventDefault();
  }

  _emitSelectionSoon() {
    setTimeout(() => this._emitSelection(), 0);
  }

  _emitSelection() {
    if (this._destroyed) return;
    const anchor = this.getSelectionAnchor();
    const key = anchor ? `${anchor.start}:${anchor.end}` : '';
    if (key === this._lastSelectionKey) return;
    this._lastSelectionKey = key;
    emit(this, 'selectionchange', { anchor });
  }

  /**
   * Map a DOM selection boundary inside a text layer to a doc offset.
   * edge 'start' → first mapped char at/after the boundary; 'end' → one past the last char before it.
   */
  _boundaryToDoc(node, offset, edge) {
    // Resolve the boundary to (element, char offset within its text).
    let span;
    let charOff;
    if (node.nodeType === Node.TEXT_NODE) {
      span = node.parentElement;
      charOff = offset;
    } else {
      const child = edge === 'start' ? node.childNodes[offset] : node.childNodes[offset - 1];
      if (child) {
        span = child.nodeType === Node.ELEMENT_NODE ? child : child.parentElement;
        charOff = edge === 'start' ? 0 : (child.textContent || '').length;
      } else {
        span = node;
        charOff = edge === 'start' ? (node.textContent || '').length : 0;
      }
    }
    const layerEl = span?.closest?.('.textLayer');
    if (!layerEl) return null;
    const pv = this._pages.find((p) => p.textLayerEl === layerEl);
    if (!pv?.textLayer) return null;
    let item = pv.spanIndex.get(span);
    if (item == null) {
      // <br>, endOfContent or the layer itself: use the neighbouring span in the selection direction.
      let sib = span;
      if (span === layerEl) {
        const kids = layerEl.children;
        sib = edge === 'start' ? kids[0] : kids[kids.length - 1];
        if (sib && pv.spanIndex.has(sib)) item = pv.spanIndex.get(sib);
      }
      while (sib && item == null) {
        sib = edge === 'start' ? sib.nextElementSibling : sib.previousElementSibling;
        if (sib && pv.spanIndex.has(sib)) item = pv.spanIndex.get(sib);
      }
      if (item == null) return null;
      charOff = edge === 'start' ? 0 : pv.textLayer.textDivs[item].textContent.length;
    }
    const maps = this.doc._itemToDoc[pv.n];
    if (edge === 'start') {
      for (let i = item, k = charOff; i < maps.length; i++, k = 0) {
        for (; k < maps[i].length; k++) if (maps[i][k] >= 0) return maps[i][k];
      }
      return null;
    }
    for (let i = item, k = charOff - 1; i >= 0; i--) {
      for (; k >= 0; k--) if (maps[i][k] >= 0) return maps[i][k] + 1;
      k = (maps[i - 1]?.length ?? 0) - 1;
    }
    return null;
  }

  _emitVisibleSentences() {
    if (this._destroyed) return;
    const top = this.container.scrollTop;
    const bottom = top + this.container.clientHeight;
    const indices = [];
    for (const pv of this._pages) {
      const pTop = pv.el.offsetTop;
      const pBottom = pTop + pv.el.offsetHeight;
      if (pBottom < top || pTop > bottom) continue;
      const z = this._pageScale(pv);
      if (pv.sentRects) {
        for (const r of pv.hitRects) {
          const y0 = pTop + r.y * z;
          if (y0 + r.h * z >= top && y0 <= bottom) indices.push(r.si);
        }
      } else {
        const info = this.doc.pages[pv.n - 1];
        const cs = this._sentenceIndexOfChar();
        for (let d = info.textStart; d < info.textEnd; d++) if (cs[d] >= 0 && (indices.length === 0 || indices[indices.length - 1] !== cs[d])) indices.push(cs[d]);
      }
    }
    const sids = [...new Set(indices)].sort((a, b) => a - b).map((i) => this.doc.sentences[i].sid);
    const key = sids.join(',');
    if (key === this._visibleKey) return;
    this._visibleKey = key;
    emit(this, 'visiblesentences', { sids });
  }

  // ------------------------------------------------------------------------------------------
  // Links
  // ------------------------------------------------------------------------------------------

  async _loadLinks(pv, page) {
    pv.links = [];
    let annots = [];
    try {
      annots = await page.getAnnotations({ intent: 'display' });
    } catch (err) {
      console.warn('[pdf] getAnnotations failed', pv.n, err);
      return;
    }
    const vp = page.getViewport({ scale: 1 });
    const links = [];
    for (const a of annots) {
      if (a.subtype !== 'Link' || !Array.isArray(a.rect)) continue;
      const [x1, y1, x2, y2] = vp.convertToViewportRectangle(a.rect);
      const rect = { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) };
      if (rect.w < 1 || rect.h < 1) continue;
      const url = a.url || a.unsafeUrl || '';
      if (url && /^(https?:|mailto:)/i.test(url)) links.push({ kind: 'external', rect, url });
      else if (a.dest) links.push({ kind: 'internal', rect, dest: a.dest, target: null });
    }
    await Promise.all(links.filter((l) => l.kind === 'internal').map(async (l) => {
      l.target = await this._resolveDest(l.dest).catch(() => null);
    }));
    pv.links = links;
  }

  /** Destination → { page, x, y (user space, bottom-left origin), pt (PDF units, top-left), refIndex?, sid? } */
  async _resolveDest(dest) {
    this._destCache ??= new Map();
    const key = typeof dest === 'string' ? dest : JSON.stringify(dest);
    if (this._destCache.has(key)) return this._destCache.get(key);
    const promise = (async () => {
      const explicit = typeof dest === 'string' ? await this.pdf.getDestination(dest) : dest;
      if (!Array.isArray(explicit) || !explicit.length) return null;
      const ref = explicit[0];
      let index = null;
      if (ref && typeof ref === 'object') index = await this.pdf.getPageIndex(ref);
      else if (Number.isInteger(ref)) index = ref;
      if (index == null || index < 0 || index >= this.pdf.numPages) return null;
      const page = index + 1;
      const mode = explicit[1]?.name;
      let x = null;
      let y = null;
      if (mode === 'XYZ') [x, y] = [explicit[2], explicit[3]];
      else if (mode === 'FitH' || mode === 'FitBH') y = explicit[2];
      else if (mode === 'FitV' || mode === 'FitBV') x = explicit[2];
      else if (mode === 'FitR') [x, y] = [explicit[2], explicit[5]];
      const pt = await this._userToTopLeft(page, x, y);
      const target = { page, x, y, pt: { x: pt.x ?? 0, y: pt.y } };
      const refIndex = this._referenceAt(page, target.pt);
      if (refIndex != null) target.refIndex = refIndex;
      const sid = this._sentenceNear(page, target.pt);
      if (sid) target.sid = sid;
      return target;
    })();
    this._destCache.set(key, promise);
    return promise;
  }

  /** Index into doc.references of the entry a destination point lands on (top of the entry). */
  _referenceAt(page, pt) {
    let best = null;
    let bestDist = Infinity;
    for (const r of this.doc.references) {
      if (r.page !== page || !r.bbox.w) continue;
      const b = r.bbox;
      if (pt.x != null && pt.x > 0 && (pt.x < b.x - 30 || pt.x > b.x + b.w)) continue;
      const dist = pt.y < b.y ? b.y - pt.y : pt.y > b.y + b.h ? (pt.y - b.y - b.h) * 3 : 0;
      if (dist < bestDist) { best = r.index; bestDist = dist; }
    }
    return bestDist <= 24 ? best : null;
  }

  /** First sentence starting at/after a point on a page, using item geometry. */
  _sentenceNear(page, pt) {
    const g = this.doc._geom?.[page];
    const maps = this.doc._itemToDoc?.[page];
    if (!g || !maps) return null;
    let bestOffset = -1;
    let bestScore = Infinity;
    for (let i = 0; i < maps.length; i++) {
      const first = maps[i].find((d) => d >= 0);
      if (first == null) continue;
      const o = i * 4;
      const dy = g[o + 1] + g[o + 3] - pt.y;
      if (dy < -1) continue; // above the point
      const dx = pt.x ? Math.max(0, pt.x - (g[o] + g[o + 2]), g[o] - pt.x - 200) : 0;
      const score = dy + dx;
      if (score < bestScore) { bestScore = score; bestOffset = first; }
    }
    if (bestOffset < 0) return null;
    const si = this._sentenceIndexOfChar()[bestOffset];
    return si >= 0 ? this.doc.sentences[si].sid : null;
  }

  // ------------------------------------------------------------------------------------------
  // Region capture
  // ------------------------------------------------------------------------------------------

  _startCaptureDrag(e, hit) {
    const rectEl = el('div', { class: 'pdfv-capture-rect' });
    hit.pv.el.append(rectEl);
    this._dragCapture = { pv: hit.pv, x0: hit.x, y0: hit.y, x1: hit.x, y1: hit.y, rectEl };
    this.container.setPointerCapture?.(e.pointerId);
    this._positionCaptureRect();
  }

  _updateCaptureDrag(e) {
    const d = this._dragCapture;
    const box = d.pv.el.getBoundingClientRect();
    const k = box.width / d.pv.width;
    d.x1 = clamp((e.clientX - box.left) / k, 0, d.pv.width);
    d.y1 = clamp((e.clientY - box.top) / k, 0, d.pv.height);
    this._positionCaptureRect();
  }

  _positionCaptureRect() {
    const d = this._dragCapture;
    const r = { x: Math.min(d.x0, d.x1), y: Math.min(d.y0, d.y1), w: Math.abs(d.x1 - d.x0), h: Math.abs(d.y1 - d.y0) };
    Object.assign(d.rectEl.style, {
      left: `${(r.x / d.pv.width) * 100}%`,
      top: `${(r.y / d.pv.height) * 100}%`,
      width: `${(r.w / d.pv.width) * 100}%`,
      height: `${(r.h / d.pv.height) * 100}%`,
    });
    return r;
  }

  async _finishCaptureDrag(e) {
    this._updateCaptureDrag(e);
    const d = this._dragCapture;
    const rect = this._positionCaptureRect();
    this._cancelCaptureDrag();
    const z = this._pageScale(d.pv);
    if (rect.w * z < 8 || rect.h * z < 8) return;
    try {
      const canvas = await this.renderRegion(d.pv.n, rect, rect.w * z);
      emit(this, 'regioncapture', { page: d.pv.n, rect, dataUrl: canvas.toDataURL('image/png') });
    } catch (err) {
      console.warn('[pdf] region capture failed', err);
    }
  }

  _cancelCaptureDrag() {
    this._dragCapture?.rectEl.remove();
    this._dragCapture = null;
  }
}

/** Text direction of a pdf.js text-layer span: 'h' (upright/upside down), 'v' (±90°) or 'other'. */
function spanAxis(span) {
  const rotate = parseFloat(span.style.getPropertyValue('--rotate')) || 0;
  const a = ((rotate % 180) + 180) % 180;
  if (a < 1 || a > 179) return 'h';
  if (Math.abs(a - 90) < 1) return 'v';
  return 'other';
}

/**
 * Merge boxes that sit on the same line and touch (word/item fragments) into one box per line run.
 * @param {Box[]} boxes
 * @returns {Box[]}
 */
function mergeLineBoxes(boxes) {
  boxes.sort((a, b) => a.y - b.y || a.x - b.x);
  const out = [];
  for (const b of boxes) {
    let merged = false;
    for (let k = out.length - 1; k >= 0 && k >= out.length - 4; k--) {
      const o = out[k];
      const overlapY = Math.min(o.y + o.h, b.y + b.h) - Math.max(o.y, b.y);
      if (overlapY < 0.5 * Math.min(o.h, b.h)) continue;
      const h = Math.max(o.h, b.h);
      if (b.x > o.x + o.w + h || b.x + b.w < o.x - h) continue;
      const x0 = Math.min(o.x, b.x);
      const y0 = Math.min(o.y, b.y);
      o.w = Math.max(o.x + o.w, b.x + b.w) - x0;
      o.h = Math.max(o.y + o.h, b.y + b.h) - y0;
      o.x = x0;
      o.y = y0;
      merged = true;
      break;
    }
    if (!merged) out.push({ ...b });
  }
  return out;
}

/**
 * Shrink a translation box's font until the text fits (binary search). The size is expressed in
 * PDF units through --total-scale-factor, so the fit survives zooming without re-measuring.
 */
function fitText(box, lineHeightPdf) {
  const apply = (size) => { box.style.fontSize = `calc(var(--total-scale-factor) * ${size.toFixed(2)}px)`; };
  const fits = () => box.scrollHeight <= box.clientHeight + 1;
  let hi = Math.max(4, lineHeightPdf * 0.82);
  apply(hi);
  if (box.clientHeight === 0 || fits()) return;
  let lo = 2.5;
  for (let k = 0; k < 7; k++) {
    const mid = (lo + hi) / 2;
    apply(mid);
    if (fits()) lo = mid;
    else hi = mid;
  }
  apply(lo);
}
