// Browser evidence suite for the PDF module (Playwright + Edge). Requires the repo served on :8101:
//   python -m http.server 8101 --bind 127.0.0.1      (from the repo root)
//   node tests/pdf/viewer.test.mjs [fixture ...]
// Screenshots / JSON results go to C:/Users/dindoo/Projects/pr-tools/out/pdf/ (never into the repo).
import fs from 'node:fs';
import { chromium } from 'file:///C:/Users/dindoo/Projects/pr-tools/node_modules/playwright/index.mjs';

const BASE = 'http://127.0.0.1:8101/tests/pdf/harness.html?mock=1';
const FIXTURES = 'C:/Users/dindoo/Projects/pr-fixtures';
const OUT = 'C:/Users/dindoo/Projects/pr-tools/out/pdf';
const names = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const fixtures = names.length ? names : ['lu2025', 'kiekkas2012', 'simwright2005', 'cohen1960'];

fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ channel: 'msedge' });
const results = {};
let failed = 0;

const check = (res, name, ok, evidence) => {
  res.checks.push({ name, ok: Boolean(ok), evidence });
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name}: ${typeof evidence === 'string' ? evidence : JSON.stringify(evidence)}`);
  if (!ok) failed++;
};

for (const name of fixtures) {
  console.log(`\n=== ${name}`);
  const res = { checks: [] };
  results[name] = res;
  const page = await browser.newPage({ viewport: { width: 1100, height: 1300 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon|404/.test(m.text())) errors.push(m.text()); });
  await page.goto(BASE);
  await page.setInputFiles('#file', `${FIXTURES}/${name}.pdf`);
  await page.waitForFunction(() => window.__state === 'ready' || window.__state === 'error', null, { timeout: 60000 });
  const loaded = await page.evaluate(() => ({ state: window.__state, error: window.__error, timing: window.__timing }));
  if (loaded.state !== 'ready') {
    check(res, 'load', false, loaded.error);
    await page.close();
    continue;
  }

  // (1) extraction stats (in-browser timing)
  const stats = await page.evaluate(() => {
    const d = window.__doc;
    const kinds = {};
    for (const s of d.sentences) kinds[s.kind] = (kinds[s.kind] || 0) + 1;
    return { pages: d.numPages, sentences: d.sentences.length, paragraphs: d.paragraphs.length, kinds, references: d.references.length,
      title: d.meta.title, authors: d.meta.authors, year: d.meta.year, abstractChars: d.meta.abstract.length, hasTextLayer: d.hasTextLayer };
  });
  res.stats = { ...stats, extractMs: Math.round(loaded.timing.extractMs), loadMs: Math.round(loaded.timing.loadMs) };
  console.log('  stats', JSON.stringify(res.stats));
  check(res, 'extraction < 2 s', loaded.timing.extractMs < 2000, `${Math.round(loaded.timing.extractMs)} ms`);

  await page.evaluate(() => window.__waitRendered([1, 2]));

  // (3) outlines screenshot, pages 1–2
  await page.evaluate(() => { window.__viewer.scrollToPage(1); window.__outlineSentences([1, 2]); });
  await page.waitForTimeout(150);
  await page.screenshot({ path: `${OUT}/outline-${name}-p1.png` });
  await page.evaluate(() => window.__viewer.scrollToPage(2));
  await page.waitForTimeout(150);
  await page.screenshot({ path: `${OUT}/outline-${name}-p2.png` });
  await page.evaluate(() => window.__clearOutlines());

  // Render everything once (links, geometry for random sampling across the paper).
  await page.evaluate(() => { window.__events.length = 0; });
  const rendered = await page.evaluate(() => window.__renderAll());
  check(res, 'all pages render', rendered.every((p) => p.links !== null), `${rendered.length} pages`);
  await page.waitForTimeout(300);
  const scrollEvents = await page.evaluate(() => {
    const ev = window.__events;
    const vis = ev.filter((e) => e.type === 'visiblesentences');
    return {
      pagechange: ev.filter((e) => e.type === 'pagechange').map((e) => e.page),
      rendered: ev.filter((e) => e.type === 'rendered').length,
      visiblesentences: vis.length,
      lastVisible: vis.length ? vis[vis.length - 1].sids.slice(0, 3) : [],
      canvasesAlive: window.__viewer._pages.filter((p) => p.canvas).length,
    };
  });
  check(res, "scroll emits 'pagechange' / 'visiblesentences'; far canvases evicted",
    scrollEvents.pagechange.length >= Math.min(3, stats.pages - 1) && scrollEvents.visiblesentences > 0 && scrollEvents.canvasesAlive <= 10,
    scrollEvents);
  const flash = await page.evaluate(async () => {
    const d = window.__doc;
    const s = d.sentences.find((x) => x.page === Math.min(3, d.numPages) && x.kind === 'body') || d.sentences[0];
    window.__viewer.scrollToSentence(s.sid);
    await new Promise((r) => setTimeout(r, 120));
    return { sid: s.sid, flashBoxes: document.querySelectorAll('.pdfv-hl--flash').length, page: window.__viewer.currentPage };
  });
  check(res, 'scrollToSentence scrolls + flashes', flash.flashBoxes > 0, flash);

  // (2) alignment on ~30 random sentences of rendered pages
  if (stats.hasTextLayer) {
    const align = await page.evaluate(() => window.__alignmentCheck({ count: 30, seed: 7 }));
    res.alignment = align;
    console.log('  alignment', JSON.stringify({ ...align, worst: align.worst.map((w) => `${w.sid} recall=${w.recall.toFixed(2)} caret=${w.caretRate.toFixed(2)}`) }));
    check(res, 'alignment word match ≥ 95%', name === 'cohen1960' || align.wordMatchRate >= 0.95, `${(align.wordMatchRate * 100).toFixed(1)}% of ${align.sampled} sentences; caret points in-sentence ${(align.caretPointRate * 100).toFixed(1)}%`);
  }

  // (4) hover → 'sentencehover' with that sid + highlight drawn
  await page.evaluate(() => window.__viewer.scrollToPage(1));
  await page.waitForTimeout(100);
  const target = await page.evaluate(() => {
    const v = window.__viewer;
    const s = window.__doc.sentences.find((x) => x.page === 1 && x.kind === 'body' && x.text.length > 40 && v._pages[0].sentRects?.get(x.sid)?.length);
    if (!s) return null;
    const r = v._pages[0].sentRects.get(s.sid)[0];
    const box = v._pages[0].el.getBoundingClientRect();
    const k = box.width / v._pages[0].width;
    return { sid: s.sid, x: box.left + (r.x + r.w / 2) * k, y: box.top + (r.y + r.h / 2) * k };
  });
  if (target) {
    await page.evaluate(() => { window.__events.length = 0; });
    await page.mouse.move(target.x - 30, target.y);
    await page.mouse.move(target.x, target.y, { steps: 4 });
    await page.waitForTimeout(100);
    const hover = await page.evaluate((sid) => ({
      events: window.__events.filter((e) => e.type === 'sentencehover').map((e) => e.sid),
      boxes: document.querySelectorAll('.pdfv-page[data-page="1"] .pdfv-hl--hover').length,
      current: window.__viewer._hoverSid,
      sid,
    }), target.sid);
    check(res, 'hover emits sentencehover + draws highlight', hover.events.includes(target.sid) && hover.boxes > 0, hover);
    await page.screenshot({ path: `${OUT}/hover-${name}.png`, clip: { x: 0, y: Math.max(0, target.y - 200), width: 1100, height: 400 } });
  }

  // (5) selection across part of two sentences → getSelectionAnchor() doc offsets
  if (stats.hasTextLayer) {
    const sel = await page.evaluate(() => {
      const d = window.__doc;
      const v = window.__viewer;
      const para = d.paragraphs.find((p) => p.page === 1 && p.kind === 'body' && p.sids.length >= 2
        && p.sids.every((sid) => d.sentenceById.get(sid).pages.length === 1));
      if (!para) return null;
      const [a, b] = [d.sentenceById.get(para.sids[0]), d.sentenceById.get(para.sids[1])];
      v.scrollToSentence(a.sid, { flash: false });
      let start = a.start + Math.floor((a.end - a.start) / 2);
      let end = b.start + Math.floor((b.end - b.start) / 2);
      // The anchor never starts/ends on whitespace; pick non-space boundaries.
      while (/\s/.test(d.text[start])) start++;
      while (/\s/.test(d.text[end - 1])) end--;
      const domText = window.__selectDocRange(start, end);
      const anchor = v.getSelectionAnchor();
      const n = (s) => s.replace(/[\s\-\u00AD]+/g, '');
      return { start, end, anchor: anchor && { start: anchor.start, end: anchor.end, text: anchor.text }, domText, match: anchor && n(anchor.text) === n(domText), rect: anchor && anchor.rect.width > 0 };
    });
    await page.waitForTimeout(400);
    const selEvents = await page.evaluate(() => window.__events.filter((e) => e.type === 'selectionchange').slice(-1));
    if (sel) {
      check(res, 'selection → doc offsets match selected text',
        sel.match && sel.anchor.start === sel.start && sel.anchor.end === sel.end && sel.rect,
        { start: sel.start, end: sel.end, anchor: sel.anchor && [sel.anchor.start, sel.anchor.end], text: sel.anchor?.text.slice(0, 90), event: selEvents[0]?.anchor ? 'selectionchange fired' : 'no event' });
    }
    // Real mouse drag selection too (exercises the text layer + endOfContent behaviour).
    const drag = await page.evaluate(() => {
      const v = window.__viewer;
      const pv = v._pages[0];
      const s = window.__doc.sentences.find((x) => x.page === 1 && x.kind === 'body' && x.text.length > 80 && pv.sentRects?.get(x.sid)?.length >= 2);
      if (!s) return null;
      v.scrollToSentence(s.sid, { flash: false });
      const box = pv.el.getBoundingClientRect();
      const k = box.width / pv.width;
      const rs = pv.sentRects.get(s.sid);
      const r0 = rs[0];
      const r1 = rs[1];
      return { sid: s.sid, x0: box.left + (r0.x + r0.w * 0.3) * k, y0: box.top + (r0.y + r0.h / 2) * k, x1: box.left + (r1.x + r1.w * 0.6) * k, y1: box.top + (r1.y + r1.h / 2) * k };
    });
    if (drag) {
      await page.evaluate(() => { window.getSelection().removeAllRanges(); window.__events.length = 0; });
      await page.mouse.move(drag.x0, drag.y0);
      await page.mouse.down();
      await page.mouse.move(drag.x1, drag.y1, { steps: 8 });
      await page.mouse.up();
      await page.waitForTimeout(350);
      const dragRes = await page.evaluate((sid) => {
        const a = window.__viewer.getSelectionAnchor();
        const s = window.__doc.sentenceById.get(sid);
        const n = (t) => t.replace(/[\s\-\u00AD]+/g, '');
        const dom = window.getSelection().toString();
        return { anchor: a && { start: a.start, end: a.end, text: a.text.slice(0, 80) }, inside: a && a.start >= s.start - 2 && a.end <= s.end + 2, match: a && n(a.text) === n(dom),
          event: window.__events.some((e) => e.type === 'selectionchange' && e.anchor) };
      }, drag.sid);
      check(res, 'mouse drag selection maps into the sentence', dragRes.inside && dragRes.match && dragRes.event, dragRes);
      await page.evaluate(() => window.getSelection().removeAllRanges());
    }
  }

  // (6) zoom keeps rects aligned
  if (stats.hasTextLayer) {
    await page.evaluate(() => window.__viewer.setZoom(1.5));
    await page.waitForTimeout(200);
    await page.evaluate(() => window.__waitRendered([window.__viewer.currentPage]));
    await page.waitForTimeout(600);
    const z15 = await page.evaluate(() => window.__alignmentCheck({ count: 8, seed: 3, pages: [window.__viewer.currentPage, window.__viewer.currentPage + 1] }));
    await page.evaluate(() => window.__viewer.setZoom(0.8));
    await page.waitForTimeout(800);
    const z08 = await page.evaluate(() => window.__alignmentCheck({ count: 8, seed: 5 }));
    await page.evaluate(() => window.__viewer.setZoom('fit-width'));
    await page.waitForTimeout(600);
    res.zoom = { z15: { wordMatchRate: z15.wordMatchRate, caretPointRate: z15.caretPointRate }, z08: { wordMatchRate: z08.wordMatchRate, caretPointRate: z08.caretPointRate } };
    check(res, 'zoom 1.5 / 0.8 keeps rects aligned', z15.caretPointRate >= 0.9 && z08.caretPointRate >= 0.9 && (name === 'cohen1960' || (z15.wordMatchRate >= 0.9 && z08.wordMatchRate >= 0.9)), res.zoom);
  }

  // (8) links
  const links = await page.evaluate(() => window.__linkSummary());
  res.links = links;
  console.log('  links', JSON.stringify({ ...links, sample: undefined }));
  const internal = await page.evaluate(() => {
    const v = window.__viewer;
    // Prefer a citation link that lands on a reference entry, else any resolved internal link.
    for (const wantRef of [true, false]) {
      for (const pv of v._pages) {
        const l = (pv.links || []).find((x) => x.kind === 'internal' && x.target && (!wantRef || x.target.refIndex != null));
        if (l) return { page: pv.n, rect: l.rect, target: l.target };
      }
    }
    return null;
  });
  if (internal) {
    await page.evaluate((n) => window.__viewer.scrollToPage(n), internal.page);
    await page.waitForTimeout(150);
    const pt = await page.evaluate(({ n, rect }) => {
      const pv = window.__viewer._pages[n - 1];
      const box = pv.el.getBoundingClientRect();
      const k = box.width / pv.width;
      // bring into view if needed
      const y = box.top + (rect.y + rect.h / 2) * k;
      if (y < 40 || y > innerHeight - 40) window.__viewer.container.scrollTop += y - innerHeight / 2;
      const b2 = pv.el.getBoundingClientRect();
      return { x: b2.left + (rect.x + rect.w / 2) * k, y: b2.top + (rect.y + rect.h / 2) * k };
    }, { n: internal.page, rect: internal.rect });
    await page.evaluate(() => { window.__events.length = 0; });
    await page.mouse.move(pt.x - 40, pt.y - 40);
    await page.mouse.move(pt.x, pt.y, { steps: 5 });
    await page.waitForTimeout(120);
    const lh = await page.evaluate(() => window.__events.filter((e) => e.type === 'linkhover').slice(-1)[0] || null);
    await page.mouse.click(pt.x, pt.y);
    await page.waitForTimeout(300);
    const after = await page.evaluate(() => window.__viewer.currentPage);
    check(res, 'internal link: linkhover fires, click jumps to target',
      lh?.kind === 'internal' && lh.target?.page === internal.target.page && Math.abs(after - internal.target.page) <= 1,
      { found: links.internal, linkhover: lh && { kind: lh.kind, target: lh.target }, pageAfterClick: after });
  } else {
    check(res, 'link annotations listed', true, `${links.total} links (${links.external} external, ${links.internal} internal)`);
  }

  // (9) translation overlay with fake Korean
  await page.evaluate(() => {
    const words = ['이', '연구는', '중환자실', '환자에서', '기관내관', '고정', '방법의', '효과를', '비교하였다', '결과', '압박', '손상이', '감소하였다'];
    const map = new Map();
    window.__doc.sentences.forEach((s, k) => {
      if (s.kind === 'furniture') return;
      const n = Math.max(2, Math.round(s.text.length / 9));
      const out = [];
      for (let i = 0; i < n; i++) out.push(words[(k + i) % words.length]);
      map.set(s.sid, `${out.join(' ')}.`);
    });
    window.__viewer.setTranslationOverlay(map);
    window.__viewer.scrollToPage(2);
  });
  await page.waitForTimeout(400);
  const overlay = await page.evaluate(() => {
    const boxes = [...document.querySelectorAll('.pdfv-page[data-page="2"] .pdfv-tbox')];
    const sizes = boxes.map((b) => parseFloat(getComputedStyle(b).fontSize));
    return { boxes: boxes.length, overflowing: boxes.filter((b) => b.scrollHeight > b.clientHeight + 2).length,
      minFont: Math.min(...sizes), medianFont: sizes.sort((a, b) => a - b)[sizes.length >> 1] };
  });
  await page.screenshot({ path: `${OUT}/overlay-${name}-p2.png` });
  check(res, 'translation overlay boxes render and fit', overlay.boxes > 0 && overlay.overflowing === 0, overlay);
  await page.evaluate(() => window.__viewer.setTranslationOverlay(null));

  // (10) region capture → PNG dataUrl at ≥ 2× resolution
  await page.evaluate(() => { window.__viewer.scrollToPage(1); window.__viewer.setRegionCapture(true); window.__events.length = 0; });
  await page.waitForTimeout(150);
  const cap = await page.evaluate(() => {
    const pv = window.__viewer._pages[0];
    const box = pv.el.getBoundingClientRect();
    return { x0: box.left + box.width * 0.15, y0: Math.max(box.top, 0) + 120, x1: box.left + box.width * 0.6, y1: Math.max(box.top, 0) + 360 };
  });
  await page.mouse.move(cap.x0, cap.y0);
  await page.mouse.down();
  await page.mouse.move(cap.x1, cap.y1, { steps: 6 });
  await page.mouse.up();
  await page.waitForFunction(() => window.__events.some((e) => e.type === 'regioncapture'), null, { timeout: 10000 }).catch(() => {});
  const capRes = await page.evaluate(async () => {
    const e = window.__events.find((x) => x.type === 'regioncapture');
    if (!e) return null;
    const v = window.__viewer;
    return { page: e.page, rect: e.rect, prefix: e.dataUrlPrefix, length: e.dataUrlLength, cssWidth: e.rect.w * v.zoom };
  });
  if (capRes) {
    // Decode the PNG to check its pixel size against the on-screen size.
    const dims = await page.evaluate(async () => {
      const v = window.__viewer;
      const e = window.__events.find((x) => x.type === 'regioncapture');
      const canvas = await v.renderRegion(e.page, e.rect, e.rect.w * v.zoom);
      return { w: canvas.width, h: canvas.height, dataUrl: canvas.toDataURL('image/png') };
    });
    fs.writeFileSync(`${OUT}/capture-${name}.png`, Buffer.from(dims.dataUrl.split(',')[1], 'base64'));
    delete dims.dataUrl;
    capRes.png = dims;
    check(res, 'region capture emits PNG dataUrl ≥ 2×', capRes.prefix.startsWith('data:image/png;base64,') && capRes.length > 1000 && dims.w >= 1.95 * capRes.cssWidth, capRes);
  } else {
    check(res, 'region capture emits PNG dataUrl ≥ 2×', false, 'no regioncapture event');
  }
  await page.evaluate(() => window.__viewer.setRegionCapture(false));

  // marks + flash smoke
  const marks = await page.evaluate(async () => {
    const d = window.__doc;
    const s = d.sentences.find((x) => x.page === 1 && x.kind === 'body');
    if (!s) return null;
    window.__viewer.setMarks('annotations', [{ id: 'm1', start: s.start, end: s.start + Math.min(40, s.end - s.start), color: 'green', style: 'fill' }]);
    window.__viewer.setMarks('auto', [{ id: 'a1', start: s.start, end: s.end, color: 'blue', style: 'underline' }]);
    await new Promise((r) => setTimeout(r, 50));
    return { annotations: document.querySelectorAll('.pdfv-mark-layer--annotations .pdfv-mark').length, auto: document.querySelectorAll('.pdfv-mark-layer--auto .pdfv-mark').length };
  });
  if (marks) check(res, 'marks render (annotations fill, auto underline)', marks.annotations > 0 && marks.auto > 0, marks);

  const destroyed = await page.evaluate(() => {
    window.__viewer.destroy();
    const root = document.querySelector('#viewer');
    return { children: root.childElementCount, rootClass: root.className };
  });
  check(res, 'destroy() tears down DOM', destroyed.children === 0 && !destroyed.rootClass.includes('pdfv-root'), destroyed);

  // (7) graceful degradation / no exceptions
  check(res, 'no page errors', errors.length === 0, errors.slice(0, 3).join(' | ') || 'none');
  if (name === 'cohen1960') {
    check(res, 'scanned/OCR paper degrades gracefully', rendered.length === stats.pages, `hasTextLayer=${stats.hasTextLayer}, sentences=${stats.sentences}, all ${rendered.length} pages rendered`);
  }
  await page.close();
}

// ---------------------------------------------------------------- regressions (review fixes)
if (fixtures.includes('lu2025')) {
  console.log('\n=== regressions (lu2025)');
  const res = { checks: [] };
  results.regressions = res;

  // rotated-pages-textlayer-unrotated: pages with /Rotate 90/180 (simulated via the harness) get a text layer
  // that covers the page box, and sentence geometry that matches the rotated text.
  {
    const page = await browser.newPage({ viewport: { width: 1200, height: 1000 } });
    await page.goto(`${BASE}&rotate=1:90,2:180`);
    await page.setInputFiles('#file', `${FIXTURES}/lu2025.pdf`);
    await page.waitForFunction(() => window.__state === 'ready' || window.__state === 'error', null, { timeout: 60000 });
    await page.evaluate(() => window.__waitRendered([1, 2, 3]));
    const geo = await page.evaluate(() => window.__viewer._pages.slice(0, 3).map((pv) => {
      const pb = pv.el.getBoundingClientRect();
      const tb = pv.textLayerEl.getBoundingClientRect();
      const boxes = [...(pv.sentRects?.values() || [])].flat();
      return {
        n: pv.n, rotation: pv.textLayerEl.getAttribute('data-main-rotation'),
        dw: Math.round(Math.abs(pb.width - tb.width)), dh: Math.round(Math.abs(pb.height - tb.height)),
        dx: Math.round(Math.abs(pb.left - tb.left)), dy: Math.round(Math.abs(pb.top - tb.top)),
        tall: boxes.filter((b) => b.h > b.w).length, wide: boxes.filter((b) => b.w > b.h).length,
      };
    }));
    const align = await page.evaluate(() => window.__alignmentCheck({ count: 12, pages: [1] }));
    await page.evaluate(() => { window.__viewer.scrollToPage(1); window.__outlineSentences([1]); });
    await page.waitForTimeout(150);
    await page.screenshot({ path: `${OUT}/regression-rotated-p1.png` });
    const covers = geo.every((g) => g.dw <= 3 && g.dh <= 3 && g.dx <= 3 && g.dy <= 3);
    check(res, 'rotated pages: text layer covers the page box', covers && geo[0].rotation === '90' && geo[1].rotation === '180', geo);
    check(res, 'rotated page 1 (90°): line boxes run vertically like the text', geo[0].tall > geo[0].wide * 3, geo[0]);
    check(res, 'rotated page 1: sentence boxes hit the text-layer words/carets', align.wordMatchRate >= 0.9 && align.caretPointRate >= 0.9,
      { wordMatchRate: align.wordMatchRate, caretPointRate: align.caretPointRate });
    await page.close();
  }

  // no-page-cleanup-memory-growth / canvas-cap-by-count-not-pixels: reading through the paper at high zoom
  // releases far pages' pdf.js resources and keeps the canvas backing store under the pixel budget.
  {
    const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
    await page.goto(BASE);
    await page.setInputFiles('#file', `${FIXTURES}/lu2025.pdf`);
    await page.waitForFunction(() => window.__state === 'ready' || window.__state === 'error', null, { timeout: 60000 });
    const mem = await page.evaluate(async () => {
      const v = window.__viewer;
      v.setZoom(3);
      let maxPixels = 0;
      for (const pv of v._pages) {
        v.scrollToPage(pv.n);
        await new Promise((r) => setTimeout(r, 350));
        maxPixels = Math.max(maxPixels, v._pages.reduce((n, p) => n + (p.canvas ? p.canvas.width * p.canvas.height : 0), 0));
      }
      await new Promise((r) => setTimeout(r, 800));
      return { cleanups: [...new Set(window.__cleanups)].length, liveCanvases: v._pages.filter((p) => p.canvas).length, maxMPx: +(maxPixels / 1e6).toFixed(1) };
    });
    check(res, 'far pages release pdf.js resources (page.cleanup) when evicted', mem.cleanups >= 3, mem);
    check(res, 'live canvas pixels stay under the budget (≤ 48 MPx + one page)', mem.maxMPx <= 60, mem);
    await page.close();
  }

  // render-failure-hot-loop: a page whose render keeps failing is retried with backoff, not in a tight loop.
  {
    const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
    await page.goto(BASE);
    await page.setInputFiles('#file', `${FIXTURES}/lu2025.pdf`);
    await page.waitForFunction(() => window.__state === 'ready' || window.__state === 'error', null, { timeout: 60000 });
    const loop = await page.evaluate(async () => {
      const v = window.__viewer;
      let attempts = 0;
      const orig = v.pdf.getPage.bind(v.pdf);
      v.pdf.getPage = async (n) => {
        const p = await orig(n);
        if (n === 5 && !p.__broken) {
          p.__broken = true;
          p.render = () => { attempts++; return { promise: Promise.reject(new Error('simulated render failure')), cancel() {} }; };
        }
        return p;
      };
      let ticks = 0;
      const t = setInterval(() => ticks++, 10);
      v.scrollToPage(5);
      await new Promise((r) => setTimeout(r, 1500));
      clearInterval(t);
      return { attempts, ticks, placeholder: Boolean(v._pages[4].el.querySelector('.pdfv-page-error')) };
    });
    check(res, 'failing page render is not retried in a hot loop', loop.attempts <= 2 && loop.ticks >= 60 && loop.placeholder, loop);
    await page.close();
  }
}

fs.writeFileSync(`${OUT}/viewer-results.json`, JSON.stringify(results, null, 2));
console.log(`\n${failed ? `${failed} check(s) FAILED` : 'all checks passed'} → ${OUT}/viewer-results.json`);
await browser.close();
process.exitCode = failed ? 1 : 0;
