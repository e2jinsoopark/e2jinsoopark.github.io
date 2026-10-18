// Test harness for the PDF module: open a PDF from <input type=file>, extract, show it in PdfViewer.
// Exposes window.__pdf / __doc / __viewer / __events and a few debug helpers for Playwright.
import { loadPdf } from '../../js/pdf/pdfjs.js';
import { extractDocument } from '../../js/pdf/extract.js';
import { PdfViewer } from '../../js/pdf/viewer.js';

const $ = (sel) => document.querySelector(sel);
const status = $('#status');
const EVENTS = ['sentencehover', 'sentenceclick', 'pagechange', 'selectionchange', 'linkhover', 'linkleave',
  'regioncapture', 'rendered', 'visiblesentences', 'zoomchange', 'markclick'];

window.__events = [];
window.__state = 'idle';

async function open(file) {
  window.__state = 'loading';
  window.__viewer?.destroy();
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const t0 = performance.now();
    const pdf = await loadPdf(bytes);
    simulateRotation(pdf);
    countCleanups(pdf);
    const t1 = performance.now();
    const doc = await extractDocument(pdf);
    const t2 = performance.now();
    const viewer = new PdfViewer($('#viewer'), { pdf, doc });
    for (const type of EVENTS) {
      viewer.addEventListener(type, (e) => {
        const d = e.detail || {};
        // Keep the log small and serialisable (dataUrl / DOMRect summarised).
        const entry = { type, t: performance.now() };
        for (const [k, v] of Object.entries(d)) {
          if (k === 'dataUrl') entry.dataUrlPrefix = String(v).slice(0, 30), entry.dataUrlLength = String(v).length;
          else if (v instanceof DOMRect) entry[k] = { x: v.x, y: v.y, w: v.width, h: v.height };
          else if (k === 'anchor' && v) entry.anchor = { start: v.start, end: v.end, text: v.text };
          else entry[k] = v;
        }
        window.__events.push(entry);
      });
    }
    await viewer.init();
    Object.assign(window, { __pdf: pdf, __doc: doc, __viewer: viewer });
    window.__timing = { loadMs: t1 - t0, extractMs: t2 - t1 };
    status.textContent = `${doc.numPages}쪽 · 문장 ${doc.sentences.length}개 · 추출 ${(t2 - t1).toFixed(0)}ms`;
    window.__state = 'ready';
  } catch (err) {
    console.error(err);
    status.textContent = `오류: ${err.message}`;
    window.__state = 'error';
    window.__error = err.message;
  }
}

/**
 * `?rotate=1:90,2:180` makes those pages behave as if the PDF had /Rotate on them (pdf.js takes the default
 * viewport rotation from page.rotate), so rotated-page handling can be tested with the normal fixtures.
 */
function simulateRotation(pdf) {
  const spec = new URLSearchParams(location.search).get('rotate');
  if (!spec) return;
  const rot = new Map(spec.split(',').map((p) => p.split(':').map(Number)));
  const orig = pdf.getPage.bind(pdf);
  pdf.getPage = async (n) => {
    const page = await orig(n);
    if (rot.has(n) && !page.__rotated) {
      const deg = (page.rotate + rot.get(n)) % 360;
      Object.defineProperty(page, 'rotate', { get: () => deg, configurable: true });
      page.__rotated = true;
    }
    return page;
  };
}

/** window.__cleanups: page numbers whose pdf.js resources the viewer released (PDFPageProxy.cleanup()). */
function countCleanups(pdf) {
  window.__cleanups = [];
  const orig = pdf.getPage.bind(pdf);
  pdf.getPage = async (n) => {
    const page = await orig(n);
    if (!page.__counted) {
      const cleanup = page.cleanup.bind(page);
      page.cleanup = (...args) => { window.__cleanups.push(n); return cleanup(...args); };
      page.__counted = true;
    }
    return page;
  };
}

$('#file').addEventListener('change', (e) => {
  const file = e.target.files?.[0];
  if (file) open(file);
});
$('#zoom-in').addEventListener('click', () => window.__viewer?.zoomIn());
$('#zoom-out').addEventListener('click', () => window.__viewer?.zoomOut());
$('#fit').addEventListener('click', () => window.__viewer?.setZoom('fit-width'));

/** Wait until the given pages have been rendered (text layer measured). */
window.__waitRendered = (pages, timeoutMs = 15000) => new Promise((resolve, reject) => {
  const viewer = window.__viewer;
  const pending = new Set(pages.filter((n) => !viewer._pages[n - 1].sentRects));
  if (!pending.size) return resolve(true);
  const timer = setTimeout(() => reject(new Error(`timeout waiting for pages ${[...pending]}`)), timeoutMs);
  viewer.addEventListener('rendered', function onRendered(e) {
    pending.delete(e.detail.page);
    if (!pending.size && pages.every((n) => viewer._pages[n - 1].sentRects)) {
      clearTimeout(timer);
      viewer.removeEventListener('rendered', onRendered);
      resolve(true);
    }
  });
});

/** Outline every sentence on the given pages in alternating colours (debug screenshots). */
window.__outlineSentences = (pages) => {
  const viewer = window.__viewer;
  const colors = ['#e11d48', '#2563eb', '#16a34a', '#d97706', '#7c3aed'];
  for (const node of document.querySelectorAll('.dbg-box')) node.remove();
  let k = 0;
  for (const s of window.__doc.sentences) {
    if (!s.pages.some((p) => pages.includes(p))) continue;
    const color = s.kind === 'furniture' ? '#9ca3af' : colors[k++ % colors.length];
    for (const r of viewer.getSentenceRects(s.sid)) {
      if (!pages.includes(r.page)) continue;
      const pageEl = viewer._pages[r.page - 1].el;
      const box = document.createElement('div');
      box.className = 'dbg-box';
      Object.assign(box.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px`, borderColor: color, background: `${color}14` });
      pageEl.append(box);
    }
  }
};

window.__clearOutlines = () => { for (const node of document.querySelectorAll('.dbg-box')) node.remove(); };

/** Deterministic PRNG for reproducible samples. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
const norm = (s) => s.toLowerCase().normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, '');

/** Text-layer span (page view + item index) at a client point, or null. */
function spanAt(x, y) {
  const viewer = window.__viewer;
  for (const node of document.elementsFromPoint(x, y)) {
    const layer = node.closest?.('.textLayer');
    if (!layer || node === layer) continue;
    const pv = viewer._pages.find((p) => p.textLayerEl === layer);
    const item = pv?.spanIndex?.get(node);
    if (item != null) return { pv, item, node };
  }
  return null;
}

/** Doc offset of the caret position at a client point (via the text layer), or null. */
function caretDocOffset(x, y) {
  const viewer = window.__viewer;
  const range = document.caretRangeFromPoint?.(x, y);
  const node = range?.startContainer;
  if (!node || node.nodeType !== Node.TEXT_NODE) return null;
  const span = node.parentElement;
  const layer = span?.closest('.textLayer');
  const pv = layer && viewer._pages.find((p) => p.textLayerEl === layer);
  const item = pv?.spanIndex?.get(span);
  if (item == null) return null;
  const map = window.__doc._itemToDoc[pv.n][item];
  for (let k = range.startOffset; k < map.length; k++) if (map[k] >= 0) return map[k];
  for (let k = range.startOffset - 1; k >= 0; k--) if (map[k] >= 0) return map[k] + 1;
  return null;
}

/**
 * Alignment evidence for random sentences on rendered pages: sample points along every computed line
 * box, then (a) the words of the text-layer spans under those points must contain the sentence's words,
 * (b) the caret position under each point must map back into the sentence's doc range.
 */
window.__alignmentCheck = async ({ count = 30, seed = 1, kinds = ['body', 'heading', 'caption'], pages = null } = {}) => {
  const viewer = window.__viewer;
  const doc = window.__doc;
  const rand = mulberry32(seed);
  const pool = doc.sentences.filter((s) => kinds.includes(s.kind) && s.text.length >= 12
    && (!pages || pages.includes(s.page)) && viewer._pages[s.page - 1].sentRects?.has(s.sid));
  const picked = [];
  while (picked.length < Math.min(count, pool.length)) {
    const s = pool[Math.floor(rand() * pool.length)];
    if (!picked.includes(s)) picked.push(s);
  }
  const results = [];
  for (const s of picked) {
    viewer.scrollToSentence(s.sid, { flash: false, block: 'center' });
    await frame();
    let spanText = '';
    const seen = new Set();
    let points = 0;
    let caretHits = 0;
    for (const page of s.pages) {
      const pv = viewer._pages[page - 1];
      for (const r of pv.sentRects?.get(s.sid) || []) {
        // Bring this line box into view (sentences may continue in another column or page).
        let box = pv.el.getBoundingClientRect();
        let k = box.width / pv.width;
        let y = box.top + (r.y + r.h / 2) * k;
        if (y < 60 || y > innerHeight - 20) {
          viewer.container.scrollTop += y - innerHeight / 2;
          await frame();
          box = pv.el.getBoundingClientRect();
          k = box.width / pv.width;
          y = box.top + (r.y + r.h / 2) * k;
        }
        // Sample along the line's long axis (rotated table text runs vertically).
        const vertical = r.h > r.w * 1.5;
        const across = (vertical ? r.w : r.h) * k;
        const step = Math.max(3, across * 0.5);
        const from = vertical ? box.top + r.y * k + 2 : box.left + r.x * k + 2;
        const to = vertical ? box.top + (r.y + r.h) * k - 1 : box.left + (r.x + r.w) * k - 1;
        const cx = box.left + (r.x + r.w / 2) * k;
        for (let t = from; t < to; t += step) {
          const [x, yy] = vertical ? [cx, t] : [t, y];
          if (yy < 0 || yy > innerHeight) continue;
          const hit = spanAt(x, yy);
          if (hit && !seen.has(hit.node)) {
            seen.add(hit.node);
            spanText += ` ${hit.node.textContent}`;
          }
          const d = caretDocOffset(x, yy);
          points++;
          if (d != null && d >= s.start - 2 && d <= s.end + 2) caretHits++;
        }
      }
    }
    const words = (s.text.match(/\p{L}{3,}/gu) || []).map(norm);
    const hay = norm(spanText);
    const found = words.filter((w) => hay.includes(w)).length;
    results.push({ sid: s.sid, words: words.length, recall: words.length ? found / words.length : 1, points, caretRate: points ? caretHits / points : 0, text: s.text.slice(0, 80) });
  }
  const n = results.length || 1;
  return {
    sampled: results.length,
    wordMatchRate: results.filter((r) => r.recall >= 0.9).length / n,
    meanWordRecall: results.reduce((a, r) => a + r.recall, 0) / n,
    caretPointRate: results.reduce((a, r) => a + r.points * r.caretRate, 0) / Math.max(1, results.reduce((a, r) => a + r.points, 0)),
    sentencesCaretOk: results.filter((r) => r.caretRate >= 0.95).length / n,
    worst: [...results].sort((a, b) => a.recall + a.caretRate - b.recall - b.caretRate).slice(0, 4),
  };
};

/** DOM boundary (text node, offset) for a doc offset, if that page's text layer is live. */
function domBoundary(d) {
  const viewer = window.__viewer;
  const { charPage, charItem, charOff } = window.__doc._map;
  const pv = viewer._pages[charPage[d] - 1];
  const span = pv?.textLayer?.textDivs[charItem[d]];
  return span?.firstChild ? { node: span.firstChild, offset: charOff[d] } : null;
}

/** Programmatic DOM selection from doc offset a (inclusive) to b (exclusive). */
window.__selectDocRange = (a, b) => {
  const start = domBoundary(a);
  const last = domBoundary(b - 1);
  if (!start || !last) return null;
  const sel = document.getSelection();
  sel.setBaseAndExtent(start.node, start.offset, last.node, last.offset + 1);
  return sel.toString();
};

/** Render every page (scrolling through) so links and geometry are loaded everywhere. */
window.__renderAll = async () => {
  const viewer = window.__viewer;
  for (const pv of viewer._pages) {
    viewer.scrollToPage(pv.n);
    await window.__waitRendered([pv.n]);
    for (let k = 0; k < 50 && pv.links === null; k++) await new Promise((r) => setTimeout(r, 20));
  }
  return viewer._pages.map((pv) => ({ page: pv.n, links: pv.links?.length ?? null }));
};

window.__linkSummary = async () => {
  const viewer = window.__viewer;
  const all = viewer._pages.flatMap((pv) => (pv.links || []).map((l) => ({ page: pv.n, ...l })));
  // Internal targets resolve asynchronously; give them a moment.
  for (let k = 0; k < 50 && all.some((l) => l.kind === 'internal' && l.target === null); k++) {
    await new Promise((r) => setTimeout(r, 20));
  }
  const fresh = viewer._pages.flatMap((pv) => (pv.links || []).map((l) => ({ page: pv.n, ...l })));
  return {
    total: fresh.length,
    internal: fresh.filter((l) => l.kind === 'internal').length,
    internalResolved: fresh.filter((l) => l.kind === 'internal' && l.target).length,
    toReference: fresh.filter((l) => l.target?.refIndex != null).length,
    external: fresh.filter((l) => l.kind === 'external').length,
    sample: fresh.slice(0, 3).map((l) => ({ page: l.page, kind: l.kind, rect: l.rect, target: l.target, url: l.url })),
  };
};
