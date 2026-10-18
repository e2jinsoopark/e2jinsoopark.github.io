// Stub PdfViewer: renders the synthetic doc as HTML "pages" and implements the viewer
// contract (SPEC 3.2) closely enough to drive the features: events, marks, selection
// anchors, link hover, renderRegion, region capture. Every API call is recorded in `calls`.

const LINKS = [
  { token: '[1]', kind: 'internal', target: { page: 3, x: 72, y: 792 - 118 } },
  { token: '[2]', kind: 'internal', target: { page: 3, x: 74, y: 792 - 176 } },
  { token: 'Figure 1', kind: 'internal', target: { page: 2, x: 72, y: 792 - 300 } },
  { token: 'https://example.org/guideline', kind: 'external', url: 'https://example.org/guideline' },
];

const FILL = { yellow: 'rgba(255, 212, 59, .45)', green: 'rgba(105, 219, 124, .40)', blue: 'rgba(116, 192, 252, .40)', pink: 'rgba(250, 162, 193, .50)' };

export class StubViewer extends EventTarget {
  constructor(container, { doc }) {
    super();
    this.container = container;
    this.doc = doc;
    this.calls = [];
    this.marks = {};
    this.nodes = []; // [{ node: Text, start, end }] in doc order
    this.zoomValue = 1;
    this.capture = false;
    this.hoverSid = null;
    this.render();
    this.wire();
  }

  record(fn, ...args) { this.calls.push({ fn, args: JSON.parse(JSON.stringify(args ?? null)) }); }

  get zoom() { return this.zoomValue; }
  get currentPage() { return 1; }

  render() {
    const { doc } = this;
    this.container.replaceChildren();
    this.pageEls = [];
    for (const page of doc.pages) {
      const pageEl = document.createElement('div');
      pageEl.className = 'sv-page';
      pageEl.dataset.page = page.pageNumber;
      pageEl.style.width = `${page.width * this.zoomValue}px`;
      pageEl.style.minHeight = `${page.height * 0.62}px`;
      const marksEl = document.createElement('div');
      marksEl.className = 'sv-marks';
      pageEl.append(marksEl);
      for (const para of doc.paragraphs.filter((p) => p.page === page.pageNumber)) {
        const p = document.createElement(para.kind === 'heading' ? 'h3' : 'p');
        p.className = `sv-para sv-${para.kind}`;
        para.sids.forEach((sid, i) => {
          if (i > 0) p.append(document.createTextNode(' '));
          p.append(this.sentenceEl(doc.sentenceById.get(sid)));
        });
        pageEl.append(p);
      }
      if (page.pageNumber === 2) {
        const fig = document.createElement('div');
        fig.className = 'sv-figure';
        fig.textContent = '[그림 1 자리]';
        pageEl.insertBefore(fig, pageEl.querySelector('.sv-caption'));
      }
      this.container.append(pageEl);
      this.pageEls.push(pageEl);
    }
  }

  /** Sentence span; link tokens become hoverable spans. Text nodes are registered with doc offsets. */
  sentenceEl(s) {
    const span = document.createElement('span');
    span.className = 'sv-s';
    span.dataset.sid = s.sid;
    let rest = s.text;
    let offset = s.start;
    while (rest) {
      const hits = LINKS.map((l) => ({ l, i: rest.indexOf(l.token) })).filter((h) => h.i >= 0).sort((a, b) => a.i - b.i);
      const hit = hits[0];
      const plain = hit ? rest.slice(0, hit.i) : rest;
      if (plain) { span.append(this.textNode(plain, offset)); offset += plain.length; }
      if (!hit) break;
      const link = document.createElement('span');
      link.className = `sv-link sv-link--${hit.l.kind}`;
      link.dataset.token = hit.l.token;
      link.append(this.textNode(hit.l.token, offset));
      link.addEventListener('pointerenter', () => this.emit('linkhover', {
        kind: hit.l.kind, clientRect: link.getBoundingClientRect(), target: hit.l.target, url: hit.l.url,
      }));
      link.addEventListener('pointerleave', () => this.emit('linkleave', {}));
      span.append(link);
      offset += hit.l.token.length;
      rest = rest.slice(hit.i + hit.l.token.length);
    }
    return span;
  }

  textNode(str, start) {
    const node = document.createTextNode(str);
    this.nodes.push({ node, start, end: start + str.length });
    return node;
  }

  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }

  wire() {
    this.container.addEventListener('pointermove', (e) => {
      const sid = e.target.closest?.('.sv-s')?.dataset.sid ?? null;
      if (sid !== this.hoverSid) { this.hoverSid = sid; this.emit('sentencehover', { sid }); }
    });
    this.container.addEventListener('mouseup', () => setTimeout(() => this.reportSelection(), 0));
    this.container.addEventListener('click', (e) => {
      const sid = e.target.closest?.('.sv-s')?.dataset.sid;
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed) return;
      // Like the real viewer: marks are pointer-transparent, so clicks on them are hit-tested and
      // reported as 'markclick' before the sentence click.
      const mark = [...this.container.querySelectorAll('.sv-mark')].find((m) => {
        const r = m.getBoundingClientRect();
        return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top - 2 && e.clientY <= r.bottom + 2;
      });
      if (mark) this.emit('markclick', { layer: mark.dataset.layer, id: mark.dataset.markId, clientRect: mark.getBoundingClientRect() });
      if (sid) this.emit('sentenceclick', { sid });
    });
  }

  reportSelection() {
    const anchor = this.getSelectionAnchor();
    this.emit('selectionchange', { anchor });
  }

  offsetOf(node, offset) {
    const hit = this.nodes.find((n) => n.node === node);
    if (hit) return hit.start + offset;
    // Element boundary: use the first registered text node at/after that child.
    const child = node.childNodes?.[offset];
    if (child) {
      const walker = document.createTreeWalker(child, NodeFilter.SHOW_TEXT);
      for (let t = child.nodeType === 3 ? child : walker.nextNode(); t; t = walker.nextNode()) {
        const n = this.nodes.find((x) => x.node === t);
        if (n) return n.start;
      }
    }
    return null;
  }

  getSelectionAnchor() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
    const range = sel.getRangeAt(0);
    if (!this.container.contains(range.commonAncestorContainer)) return null;
    let start = this.offsetOf(range.startContainer, range.startOffset);
    let end = this.offsetOf(range.endContainer, range.endOffset);
    if (start == null || end == null || end <= start) return null;
    const raw = this.doc.text.slice(start, end);
    start += raw.length - raw.trimStart().length;
    end -= raw.length - raw.trimEnd().length;
    return { start, end, text: this.doc.text.slice(start, end).replace(/\s+/g, ' '), rect: range.getBoundingClientRect() };
  }

  /** Test helper: select doc range [start, end) as a real DOM selection and report it. */
  selectRange(start, end) {
    const a = this.nodes.find((n) => start >= n.start && start < n.end);
    const b = this.nodes.find((n) => end > n.start && end <= n.end);
    const range = document.createRange();
    range.setStart(a.node, start - a.start);
    range.setEnd(b.node, end - b.start);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    this.reportSelection();
  }

  rangeRects(start, end) {
    const rects = [];
    for (const n of this.nodes) {
      if (n.end <= start || n.start >= end) continue;
      const r = document.createRange();
      r.setStart(n.node, Math.max(0, start - n.start));
      r.setEnd(n.node, Math.min(n.end, end) - n.start);
      const pageEl = n.node.parentElement.closest('.sv-page');
      const base = pageEl.getBoundingClientRect();
      for (const cr of r.getClientRects()) {
        rects.push({ pageEl, page: Number(pageEl.dataset.page), x: cr.left - base.left, y: cr.top - base.top, w: cr.width, h: cr.height });
      }
    }
    return rects;
  }

  // --- contract API ---

  setMarks(layer, marks) {
    this.record('setMarks', layer, marks);
    this.marks[layer] = marks;
    this.paintMarks();
  }

  paintMarks() {
    for (const pageEl of this.pageEls) pageEl.querySelector('.sv-marks').replaceChildren();
    for (const [layer, marks] of Object.entries(this.marks)) {
      for (const m of marks) {
        for (const r of this.rangeRects(m.start, m.end)) {
          const d = document.createElement('div');
          d.className = `sv-mark sv-mark--${m.style}`;
          d.dataset.layer = layer;
          d.dataset.markId = m.id;
          Object.assign(d.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` });
          if (m.style === 'underline') d.style.borderBottom = `2.5px solid ${m.color}`;
          else d.style.background = FILL[m.color] ?? m.color;
          r.pageEl.querySelector('.sv-marks').append(d);
        }
      }
    }
  }

  setHoverSentence(sid) {
    this.record('setHoverSentence', sid);
    this.container.querySelectorAll('.sv-s.is-hover').forEach((e) => e.classList.remove('is-hover'));
    if (sid) this.container.querySelector(`.sv-s[data-sid="${sid}"]`)?.classList.add('is-hover');
  }

  setActiveSentence(sid) { this.record('setActiveSentence', sid); }

  scrollToSentence(sid, opts = {}) {
    this.record('scrollToSentence', sid, opts);
    const el = this.container.querySelector(`.sv-s[data-sid="${sid}"]`);
    el?.scrollIntoView({ block: 'center' });
    if (opts.flash !== false && el) { el.classList.add('is-flash'); setTimeout(() => el.classList.remove('is-flash'), 900); }
  }

  scrollToOffset(offset) { this.record('scrollToOffset', offset); }
  scrollToPdfPoint(page, x, y) { this.record('scrollToPdfPoint', page, x, y); this.pageEls[page - 1]?.scrollIntoView(); }

  getSentenceRects(sid) {
    const s = this.doc.sentenceById.get(sid);
    if (!s) return [];
    return this.rangeRects(s.start, s.end).map(({ page, x, y, w, h }) => ({ page, x, y, w, h }));
  }

  setRegionCapture(on) {
    this.record('setRegionCapture', on);
    this.capture = on;
    this.container.classList.toggle('sv-capturing', on);
  }

  setTranslationOverlay(map) { this.record('setTranslationOverlay', map ? map.size : null); }

  async renderRegion(page, rect, cssWidth) {
    this.record('renderRegion', page, rect, cssWidth);
    await new Promise((r) => setTimeout(r, 80));
    const dpr = 2;
    const cssH = Math.round(cssWidth * (rect.h / rect.w));
    const c = document.createElement('canvas');
    c.width = cssWidth * dpr;
    c.height = cssH * dpr;
    c.style.width = `${cssWidth}px`;
    const g = c.getContext('2d');
    g.scale(dpr, dpr);
    g.fillStyle = '#fff';
    g.fillRect(0, 0, cssWidth, cssH);
    g.fillStyle = '#222';
    g.font = 'bold 13px sans-serif';
    g.fillText(page === 2 ? 'Figure 1. Mobility levels' : `Page ${page}`, 14, 22);
    if (page === 2) {
      const bars = [0.35, 0.55, 0.75, 0.95];
      bars.forEach((v, i) => {
        g.fillStyle = ['#91a7ff', '#748ffc', '#5c7cfa', '#4263eb'][i];
        const bh = (cssH - 70) * v;
        g.fillRect(30 + i * 90, cssH - 30 - bh, 60, bh);
        g.fillStyle = '#444';
        g.font = '11px sans-serif';
        g.fillText(`Level ${i + 1}`, 34 + i * 90, cssH - 12);
      });
    } else {
      g.fillStyle = '#999';
      for (let y = 40; y < cssH - 8; y += 14) g.fillRect(14, y, cssWidth - 28 - ((y * 7) % 60), 6);
    }
    return c;
  }

  /** Test helper: simulate the user dragging a region on page 2. */
  async fakeCapture() {
    const rect = { x: 60, y: 260, w: 420, h: 220 };
    const canvas = await this.renderRegion(2, rect, 420);
    this.emit('regioncapture', { page: 2, rect, dataUrl: canvas.toDataURL('image/png') });
  }

  destroy() { this.record('destroy'); }
}
