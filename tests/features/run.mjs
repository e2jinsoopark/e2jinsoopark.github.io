// Features test runner: drives tests/features/harness.html (stub viewer/pane/library/tasks/
// components, mock provider) in Edge via Playwright and writes screenshots to pr-tools/out.
//   node tests/features/run.mjs [filter]
// Serves the repo with `python -m http.server 8105` unless something already answers there.
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const { chromium } = await import(pathToFileURL('C:/Users/dindoo/Projects/pr-tools/node_modules/playwright/index.mjs').href);

const PORT = 8105;
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = 'C:/Users/dindoo/Projects/pr-tools/out/features';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const FILTER = process.argv[2] || '';
mkdirSync(OUT, { recursive: true });

// ---------- server ----------
async function serverUp() {
  try { return (await fetch(`${BASE}/docs/SPEC.md`)).ok; } catch { return false; }
}
let server = null;
if (!(await serverUp())) {
  server = spawn('python', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], { cwd: ROOT, stdio: 'ignore' });
  for (let i = 0; i < 50 && !(await serverUp()); i++) await new Promise((r) => setTimeout(r, 100));
}

// ---------- tiny test framework ----------
const results = [];
function assert(cond, msg) { if (!cond) throw new Error(`assert: ${msg}`); }
async function test(name, fn) {
  if (FILTER && !name.includes(FILTER)) return;
  const t0 = Date.now();
  try {
    const evidence = await fn();
    results.push({ name, result: 'pass', evidence: String(evidence ?? '') });
    console.log(`PASS ${name} (${Date.now() - t0} ms) — ${evidence ?? ''}`);
  } catch (err) {
    results.push({ name, result: 'fail', evidence: err.stack || String(err) });
    console.log(`FAIL ${name}\n  ${err.stack || err}`);
  }
}

// ---------- Semantic Scholar fixtures (served by page.route; nothing leaves the machine) ----------
const S2 = {
  match: {
    data: [{
      paperId: 'S2MATCH', title: 'Early Mobilization and Delirium in Mechanically Ventilated Adults: A Nurse-Led Protocol',
      year: 2024, authors: [{ name: 'H. Kim' }, { name: 'J. Lee' }], url: 'https://www.semanticscholar.org/paper/S2MATCH',
      externalIds: { DOI: '10.0000/test.1' }, abstract: 'Synthetic abstract.', citationCount: 12, matchScore: 210,
    }],
  },
  recs: {
    recommendedPapers: [
      ['Sedation interruption and early mobility bundles in the ICU', 2022, 41],
      ['Nurse-driven delirium screening with CAM-ICU: a multicenter cohort', 2021, 88],
      ['Barriers to early mobilization: a qualitative study of ICU nurses', 2023, 17],
      ['Effect of ABCDEF bundle adherence on ventilator-free days', 2020, 230],
      ['Accidental extubation during mobilization: incidence and prevention', 2019, 54],
    ].map(([title, year, citationCount], i) => ({
      paperId: `REC${i}`, title, year, citationCount, url: `https://www.semanticscholar.org/paper/REC${i}`,
      authors: [{ name: 'A. Author' }, { name: 'B. Writer' }, { name: 'C. Third' }, { name: 'D. Fourth' }],
      abstract: i === 3 ? null : `Background: synthetic abstract number ${i + 1} describing a study of critically ill adults. Methods and results are invented for testing the 관련 논문 panel layout across several lines of text so that clamping is visible.`,
    })),
  },
  ref1: {
    paperId: 'REF1', title: 'Delirium as a predictor of mortality in mechanically ventilated patients in the intensive care unit',
    year: 2004, venue: 'JAMA', citationCount: 3100, authors: [{ name: 'E. W. Ely' }, { name: 'A. Shintani' }, { name: 'B. Truman' }, { name: 'T. Speroff' }],
    url: 'https://www.semanticscholar.org/paper/REF1', abstract: 'Synthetic abstract for the reference card test.',
  },
};

/** mode: 'ok' | '429' */
async function routeS2(page, { mode = 'ok', log = [] } = {}) {
  await page.route('https://api.semanticscholar.org/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    log.push({ path: url.pathname, query: url.search, apiKey: req.headers()['x-api-key'] ?? null });
    const json = (status, body) => route.fulfill({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });
    if (mode === '429') return json(429, { message: 'Too Many Requests' });
    if (url.pathname === '/graph/v1/paper/search/match') return json(200, S2.match);
    if (url.pathname.startsWith('/recommendations/v1/papers/forpaper/')) return json(200, S2.recs);
    if (url.pathname.startsWith('/graph/v1/paper/DOI:10.1001/jama.291.14.1753')) return json(200, S2.ref1);
    return json(404, { error: 'not found' });
  });
}

const browser = await chromium.launch({ channel: 'msedge' });

async function open({ query = 'mock=1&reset=1', tab, s2 = {}, viewport = { width: 1440, height: 900 }, context } = {}) {
  const ctx = context ?? await browser.newContext({ viewport, permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|ERR_FAILED/.test(m.text())) errors.push(m.text()); });
  await page.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.abort()); // no real external traffic
  await routeS2(page, s2);
  await page.goto(`${BASE}/tests/features/harness.html?${query}${tab ? `&tab=${tab}` : ''}`);
  await page.waitForSelector('body[data-ready="1"]', { timeout: 10000 });
  return { page, ctx, errors };
}

const shot = (page, name, opts = {}) => page.screenshot({ path: `${OUT}/${name}.png`, ...opts });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Select `len` chars starting at `needle` in the stub viewer (real DOM selection + selectionchange). */
async function selectText(page, needle, len) {
  return page.evaluate(({ needle, len }) => {
    const s = __h.doc.sentences.find((x) => x.text.includes(needle));
    const start = s.start + s.text.indexOf(needle);
    const end = start + (len ?? needle.length);
    __h.viewer.selectRange(start, end);
    return { start, end, sid: s.sid };
  }, { needle, len });
}

const lastMarks = (page, who, layer) => page.evaluate(({ who, layer }) => {
  const c = __h[who].calls.filter((x) => x.fn === 'setMarks' && x.args[0] === layer).at(-1);
  return c ? c.args[1] : null;
}, { who, layer });

const taskCalls = (page, fn) => page.evaluate((fn) => (window.__taskCalls || []).filter((c) => c.fn === fn).length, fn);

// =====================================================================================

await test('boot: installs toolbar buttons and pushes annotation layers', async () => {
  const { page, ctx, errors } = await open();
  await page.waitForFunction(() => __h.viewer.calls.some((c) => c.fn === 'setMarks' && c.args[0] === 'annotations'));
  const buttons = await page.$$eval('#tools button', (bs) => bs.map((b) => b.textContent));
  assert(buttons.includes('핵심 밑줄') && buttons.includes('그림·표 설명'), `toolbar buttons: ${buttons}`);
  const v = await lastMarks(page, 'viewer', 'annotations');
  const p = await lastMarks(page, 'pane', 'annotations');
  assert(Array.isArray(v) && Array.isArray(p), 'initial empty layers pushed to viewer and pane');
  assert(await page.evaluate(() => !!document.getElementById('pr-features-css')), 'styles injected');
  assert(!errors.length, `page errors: ${errors}`);
  await ctx.close();
  return `toolbar=[${buttons.join(', ')}], viewer/pane annotations layers initialised (${v.length}/${p.length} marks), no page errors`;
});

await test('annotations store: CRUD, tombstones, round-trip, merge rules, no clobber after failed load', async () => {
  const { page, ctx } = await open();
  const r = await page.evaluate(async () => {
    const { AnnotationStore, annotationMarks } = await import('/js/features/annotations.js');
    const mem = {};
    let failNext = 0;
    const lib = {
      async getPaperData(id, kind) {
        if (failNext > 0) { failNext -= 1; throw new Error('fail'); }
        return mem[`${id}/${kind}`] ? structuredClone(mem[`${id}/${kind}`]) : null;
      },
      async savePaperData(id, kind, obj) { obj.updatedAt = Date.now(); mem[`${id}/${kind}`] = structuredClone(obj); },
    };
    const out = {};
    const s1 = new AnnotationStore({ library: lib, paperId: 'u1', saveDelay: 10 });
    await s1.ready;
    const a = s1.add({ start: 10, end: 30, quote: '  hello   world ', color: 'green' });
    const b = s1.add({ start: 40, end: 60, quote: 'second', color: 'not-a-color' });
    s1.update(a.id, { note: '메모 A' });
    s1.remove(b.id);
    await s1.flush();
    const saved = mem['u1/annotations'];
    out.savedCount = saved.items.length;
    out.savedTomb = saved.items.find((x) => x.id === b.id)?.deleted === true;
    out.normalized = { quote: saved.items.find((x) => x.id === a.id).quote, color: saved.items.find((x) => x.id === b.id).color };
    out.version = saved.version;

    const s2 = new AnnotationStore({ library: lib, paperId: 'u1', saveDelay: 10 });
    await s2.ready;
    out.reloadLive = s2.items.map((x) => [x.id === a.id, x.note, x.color]);
    out.reloadRecords = s2.records.length;
    out.getDeleted = s2.get(b.id);
    out.marks = annotationMarks(s2.items);
    const tomb = s2.records.find((x) => x.id === b.id);
    const restored = s2.restore(b.id);
    out.restoreNewer = restored.updatedAt > tomb.updatedAt && !('deleted' in restored);
    await s2.flush();
    const s3 = new AnnotationStore({ library: lib, paperId: 'u1' });
    await s3.ready;
    out.afterRestore = s3.items.length;

    // merge rules
    const cur = s3.get(a.id);
    out.olderIgnored = s3.merge([{ ...cur, note: 'old', updatedAt: cur.updatedAt - 1000 }]) === false && s3.get(a.id).note === '메모 A';
    out.newerWins = s3.merge([{ ...cur, note: 'remote', updatedAt: cur.updatedAt + 1000 }]) === true && s3.get(a.id).note === 'remote';
    const cur2 = s3.get(a.id);
    s3.merge([{ ...cur2, deleted: true, updatedAt: cur2.updatedAt }]);
    out.tieTombstoneWins = s3.get(a.id) === null;
    try { s3.add({ start: 5, end: 5 }); out.badRange = 'no throw'; } catch (e) { out.badRange = e.message; }


    // failed initial read must not clobber the stored file
    mem['u9/annotations'] = { version: 1, items: [{ id: 'keep', anchor: { start: 1, end: 4 }, quote: 'x', color: 'blue', note: '', createdAt: 1, updatedAt: 1 }] };
    failNext = 1;
    const s4 = new AnnotationStore({ library: lib, paperId: 'u9', saveDelay: 10 });
    await s4.ready;
    s4.add({ start: 7, end: 9, quote: 'y' });
    await s4.flush();
    out.noClobber = mem['u9/annotations'].items.map((x) => x.id).includes('keep') && mem['u9/annotations'].items.length === 2;
    return out;
  });
  assert(r.savedCount === 2 && r.savedTomb, 'tombstone persisted alongside live item');
  assert(r.normalized.quote === 'hello world' && r.normalized.color === 'yellow', `normalisation ${JSON.stringify(r.normalized)}`);
  assert(r.reloadLive.length === 1 && r.reloadLive[0][0] && r.reloadLive[0][1] === '메모 A' && r.reloadLive[0][2] === 'green', `round-trip ${JSON.stringify(r.reloadLive)}`);
  assert(r.reloadRecords === 2 && r.getDeleted === null, 'tombstone kept in records, hidden from get()');
  assert(r.restoreNewer && r.afterRestore === 2, 'restore beats tombstone and persists');
  assert(r.olderIgnored && r.newerWins && r.tieTombstoneWins, `merge rules ${JSON.stringify(r)}`);
  assert(/범위/.test(r.badRange), 'invalid range rejected with Korean message');
  assert(r.marks.length === 1 && r.marks[0].style === 'fill' && r.marks[0].title === '메모 A', 'mark shape');
  assert(r.noClobber, 'failed load did not clobber stored annotations');
  await ctx.close();
  return `saved 2 records incl. tombstone; reload → 1 live (note+colour kept); restore → 2; merge: older ignored, newer wins, tie→tombstone; bad range → "${r.badRange}"; failed-load save kept remote item`;
});

await test('selection menu: highlight pushes marks to viewer and pane, persists', async () => {
  const { page, ctx, errors } = await open();
  const sel = await selectText(page, 'We evaluated whether a nurse-led early mobilization protocol');
  await page.waitForSelector('.pf-selmenu');
  const labels = await page.$$eval('.pf-selmenu button', (bs) => bs.map((b) => b.textContent || b.getAttribute('aria-label')));
  await shot(page, '03-selection-menu');
  await page.click('.pf-selmenu [data-color="green"]');
  await page.waitForFunction(() => __h.session.annotations.items.length === 1);
  const v = await lastMarks(page, 'viewer', 'annotations');
  const p = await lastMarks(page, 'pane', 'annotations');
  assert(v.length === 1 && v[0].start === sel.start && v[0].end === sel.end && v[0].color === 'green' && v[0].style === 'fill', `viewer mark ${JSON.stringify(v)}`);
  assert(p.length === 1 && p[0].id === v[0].id, 'pane got the same mark');
  assert(!(await page.$('.pf-selmenu')), 'menu closed after highlighting');
  await page.waitForFunction(() => __h.library.data['paper1/annotations']?.items?.length === 1, null, { timeout: 3000 });
  await shot(page, '04-highlight-applied');
  assert(!errors.length, `page errors: ${errors}`);
  await ctx.close();
  return `menu buttons: ${labels.join(' | ')}; mark {start:${v[0].start}, end:${v[0].end}, color:green} on viewer+pane; saved annotations.json`;
});

await test('highlight click → edit menu → delete with undo toast → restore', async () => {
  const { page, ctx } = await open();
  const sel = await selectText(page, 'Delirium occurred in 28%', 40);
  await page.waitForSelector('.pf-selmenu');
  await page.click('.pf-selmenu [data-color="pink"]');
  const box = await page.evaluate(({ start, end }) => {
    const r = __h.viewer.rangeRects(start, end)[0];
    const base = r.pageEl.getBoundingClientRect();
    return { x: base.left + r.x + r.w / 2, y: base.top + r.y + r.h / 2 };
  }, sel);
  await page.mouse.click(box.x, box.y);
  await page.waitForSelector('.pf-selmenu--mark');
  await shot(page, '05-highlight-edit-menu');
  await page.click('.pf-selmenu--mark [data-color="blue"]');
  await page.waitForFunction(() => __h.session.annotations.items[0]?.color === 'blue');
  await page.mouse.click(box.x, box.y);
  await page.waitForSelector('.pf-selmenu--mark');
  await page.click('.pf-selmenu--mark [data-action="delete"]');
  await page.waitForSelector('.toast .toast-action');
  const afterDelete = await page.evaluate(() => ({ live: __h.session.annotations.items.length, tomb: __h.session.annotations.records[0]?.deleted }));
  const vDel = await lastMarks(page, 'viewer', 'annotations');
  await sleep(300); // let the toast's entry animation finish
  await shot(page, '06-undo-toast');
  await page.click('.toast .toast-action');
  await page.waitForFunction(() => __h.session.annotations.items.length === 1);
  const vRestored = await lastMarks(page, 'viewer', 'annotations');
  await page.waitForFunction(() => __h.library.data['paper1/annotations']?.items?.[0] && !__h.library.data['paper1/annotations'].items[0].deleted, null, { timeout: 3000 });
  assert(afterDelete.live === 0 && afterDelete.tomb === true && vDel.length === 0, 'delete tombstoned and cleared marks');
  assert(vRestored.length === 1 && vRestored[0].color === 'blue', 'undo restored the mark');
  await ctx.close();
  return 'click on highlight opened edit menu (colour → blue), delete → tombstone + empty marks + undo toast, 실행 취소 → restored & saved';
});

await test('selection menu: 메모 creates highlight with note (mark title = note)', async () => {
  const { page, ctx } = await open();
  await selectText(page, 'Protocol adherence was highest', 50);
  await page.waitForSelector('.pf-selmenu');
  await page.click('.pf-selmenu [data-action="note"]');
  await page.waitForSelector('.pf-noteedit textarea');
  await page.fill('.pf-noteedit textarea', '허들 운영 방식 확인하기');
  await shot(page, '07-note-editor');
  await page.click('.pf-noteedit [data-action="save-note"]');
  await page.waitForFunction(() => __h.session.annotations.items[0]?.note === '허들 운영 방식 확인하기');
  const v = await lastMarks(page, 'viewer', 'annotations');
  assert(v[0].title === '허들 운영 방식 확인하기' && v[0].color === 'yellow', `mark ${JSON.stringify(v[0])}`);
  await ctx.close();
  return 'note editor saved note; viewer mark title carries it';
});

await test('selection menu: 번역 shows quickTranslate result in a popover', async () => {
  const { page, ctx } = await open();
  await selectText(page, 'Nurses are well placed to lead mobility', 100);
  await page.waitForSelector('.pf-selmenu');
  await page.click('.pf-selmenu [data-action="translate"]');
  await page.waitForFunction(() => document.querySelector('.pf-qt__body')?.textContent.includes('〔빠른 번역〕'));
  const calls = await page.evaluate(() => window.__taskCalls.filter((c) => c.fn === 'quickTranslate').map((c) => c.text));
  await shot(page, '08-quick-translate');
  assert(calls.length === 1 && calls[0].startsWith('Nurses are well placed'), 'quickTranslate called with the selection');
  await ctx.close();
  return `quickTranslate("${calls[0].slice(0, 40)}…") rendered via renderMarkdown in popover`;
});

await test('selection menu: 복사 puts the selection on the clipboard', async () => {
  const { page, ctx } = await open();
  const sel = await selectText(page, 'Adults ventilated for more than 48 hours were eligible.');
  await page.waitForSelector('.pf-selmenu');
  await page.click('.pf-selmenu [data-action="copy"]');
  await page.waitForFunction(() => window.__toasts.some((t) => t.message === '복사했습니다.'));
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  const menuClosed = !(await page.$('.pf-selmenu'));
  assert(clip === 'Adults ventilated for more than 48 hours were eligible.', `clipboard "${clip}"`);
  assert(menuClosed, 'menu closes after copy');
  await ctx.close();
  return `clipboard = "${clip}" (doc range ${sel.start}–${sel.end}), toast 복사했습니다.`;
});

await test('chat: quote prefill, incremental streaming, chips, persistence, stop, clear, sanitisation', async () => {
  const { page, ctx, errors } = await open();
  await selectText(page, 'Delirium was assessed twice daily with the CAM-ICU', 50);
  await page.waitForSelector('.pf-selmenu');
  await page.click('.pf-selmenu [data-action="ask"]');
  await page.waitForSelector('.pf-chat__quote:not([hidden])');
  const tab = await page.evaluate(() => __h.activeTab);
  assert(tab === 'chat', 'chat panel opened');
  await page.fill('.pf-chat__input', '이 평가 방법의 의미는?');
  await shot(page, '09-chat-quote');
  await page.click('[data-action="send"]');
  const samples = await page.evaluate(async () => {
    const out = [];
    const t0 = performance.now();
    while (performance.now() - t0 < 8000) {
      const b = [...document.querySelectorAll('.pf-msg--assistant .pf-msg__body')].at(-1);
      out.push(b ? b.textContent.length : -1);
      if (!document.querySelector('.pf-msg.is-streaming') && out.length > 3) break;
      await new Promise((r) => setTimeout(r, 30));
    }
    return out;
  });
  const distinct = [...new Set(samples.filter((n) => n > 0))];
  const monotonic = samples.every((n, i) => i === 0 || n >= samples[i - 1] || samples[i - 1] === -1);
  assert(distinct.length >= 5 && monotonic, `incremental render samples ${samples.join(',')}`);
  const chips = await page.$$eval('.pf-msg--assistant .pf-sid', (as) => as.map((a) => [a.dataset.sid, a.textContent]));
  assert(chips.length === 4, `citation chips ${JSON.stringify(chips)}`);
  await shot(page, '10-chat-answer');
  await page.click('.pf-msg--assistant .pf-sid >> nth=1');
  const jumps = await page.evaluate(() => __h.jumps);
  assert(jumps.includes(chips[1][0]), 'chip click jumped to sentence');
  let stored = await page.evaluate(() => __h.library.data['paper1/ai']?.chat);
  assert(stored?.length === 2 && stored[0].role === 'user' && stored[0].quote?.includes('CAM-ICU') && stored[1].role === 'assistant' && stored[1].content.includes('28%'), 'persisted exchange with quote');
  const chatCall = await page.evaluate(() => window.__taskCalls.find((c) => c.fn === 'chat'));
  assert(chatCall.quote?.includes('CAM-ICU') && chatCall.history.length === 0, 'quote passed to tasks.chat');

  // stop mid-stream keeps the partial answer
  await page.evaluate(() => { window.__chunkDelay = 120; });
  await page.fill('.pf-chat__input', '두 번째 질문');
  await page.press('.pf-chat__input', 'Enter');
  await sleep(700);
  await page.click('[data-action="stop"]');
  await page.waitForSelector('.pf-msg__note');
  await page.waitForFunction(() => __h.library.data['paper1/ai']?.chat?.length === 4);
  stored = await page.evaluate(() => __h.library.data['paper1/ai'].chat);
  const second = await page.evaluate(() => window.__taskCalls.filter((c) => c.fn === 'chat')[1]);
  assert(stored[3].stopped === true && stored[3].content.length > 0 && stored[3].content.length < stored[1].content.length, 'partial answer stored as stopped');
  assert(second.history.length === 2 && second.history[0].content.startsWith('> '), 'history (with quote folded in) sent on next turn');

  // reload → history comes back
  await page.evaluate(() => { window.__chunkDelay = 20; });
  await page.goto(`${BASE}/tests/features/harness.html?mock=1&tab=chat`);
  await page.waitForSelector('body[data-ready="1"]');
  await page.waitForFunction(() => document.querySelectorAll('.pf-msg').length === 4);
  await shot(page, '11-chat-reloaded');

  // sanitisation of hostile model output
  await page.fill('.pf-chat__input', 'xss test');
  await page.press('.pf-chat__input', 'Enter');
  await page.waitForFunction(() => document.querySelectorAll('.pf-msg').length === 6 && !document.querySelector('.pf-msg.is-streaming'), null, { timeout: 8000 });
  const xss = await page.evaluate(() => {
    const b = [...document.querySelectorAll('.pf-msg--assistant .pf-msg__body')].at(-1);
    return {
      flag: window.__xss ?? null,
      onerror: !!b.querySelector('[onerror],[onclick]'), script: !!b.querySelector('script'),
      jsHref: [...b.querySelectorAll('a')].some((a) => (a.getAttribute('href') || '').startsWith('javascript')),
      ext: [...b.querySelectorAll('a[href^="https"]')].map((a) => `${a.target}|${a.rel}`),
    };
  });
  assert(xss.flag === null && !xss.onerror && !xss.script && !xss.jsHref, `sanitised ${JSON.stringify(xss)}`);
  assert(xss.ext.every((x) => x === '_blank|noopener noreferrer'), 'external links get rel/target');

  // clear history (confirmDialog)
  await page.click('[data-action="clear"]');
  await page.click('.stub-modal button[data-kind="danger"]');
  await page.waitForFunction(() => __h.library.data['paper1/ai'].chat.length === 0);
  await page.waitForSelector('.pf-chat__intro');
  assert(!errors.length, `page errors: ${errors}`);
  await ctx.close();
  return `streamed ${distinct.length} distinct partial lengths (${samples.slice(0, 12).join(',')}…); 4 sid chips, click → jump ${chips[1][0]}; ai.chat persisted (quote kept), stop → partial stored with stopped:true, reload → 4 bubbles, hostile HTML neutralised, clear → []`;
});

await test('summary panel: no paid call on first view, 요약 만들기 → sections+toc, chips jump, cache on reopen', async () => {
  const { page, ctx, errors } = await open({ tab: 'summary' });
  // Regression (summary-autostart-paid-call): opening the tab shows the idle card; nothing is generated yet.
  await page.waitForSelector('[data-action="generate"]');
  await page.waitForTimeout(300);
  assert((await taskCalls(page, 'summarize')) === 0, 'opening the 요약 tab must not call the AI');
  await page.click('[data-action="generate"]');
  await page.waitForFunction(() => document.querySelectorAll('.pf-summary__body h2').length === 6, null, { timeout: 5000 });
  const heads = await page.$$eval('.pf-summary__body h2', (hs) => hs.map((h) => h.textContent));
  const toc = await page.$$eval('.pf-toc .pf-chip', (cs) => cs.length);
  const chips = await page.$$eval('.pf-summary__body .pf-sid', (as) => as.length);
  const missing = await page.$$eval('.pf-summary__body .pf-sid-missing', (as) => as.length);
  await shot(page, '12-summary');
  await page.click('.pf-summary__body .pf-sid >> nth=2');
  const jumps = await page.evaluate(() => __h.jumps);
  const saved = await page.evaluate(() => __h.library.data['paper1/ai']?.summary);
  assert(heads.join('|') === '한 줄 요약|연구 목적|연구 방법|주요 결과|제한점|임상·연구적 시사점', `headings ${heads}`);
  assert(toc === 6 && chips >= 9 && missing === 1, `toc ${toc}, chips ${chips}, missing ${missing}`);
  assert(jumps.length === 1 && saved?.markdown && saved.model === 'mock', 'jump + saved');
  await page.goto(`${BASE}/tests/features/harness.html?mock=1&tab=summary`);
  await page.waitForSelector('body[data-ready="1"]');
  await page.waitForSelector('.pf-summary__body h2');
  const again = await taskCalls(page, 'summarize');
  assert(again === 0, 'cached summary reused without a new call');
  // regenerate
  await page.click('[data-action="regenerate"]');
  await page.waitForFunction(() => (window.__taskCalls || []).filter((c) => c.fn === 'summarize').length === 1);
  await page.waitForSelector('.pf-summary__body h2');
  assert(!errors.length, `page errors: ${errors}`);
  await ctx.close();
  return `5 sections (${heads.join(' / ')}), ${toc} toc chips, ${chips} sid chips, 1 unknown sid defused, chip → jump ${jumps[0]}; reopen used cache (0 calls); 다시 만들기 → 1 call`;
});

async function seedAnnotations(page) {
  await page.evaluate(() => {
    const st = __h.session.annotations;
    const add = (needle, len, color, note = '') => {
      const s = __h.doc.sentences.find((x) => x.text.includes(needle));
      const start = s.start + s.text.indexOf(needle);
      return st.add({ start, end: start + len, quote: __h.doc.text.slice(start, start + len), color, note });
    };
    add('Delirium is a frequent and costly', 60, 'yellow', '서론 첫 문장 — 섬망 부담 근거로 인용');
    add('Delirium occurred in 28%', 86, 'green', '주요 결과: 위험비 0.68');
    add('Protocol adherence was highest', 78, 'blue');
    add('Delirium was assessed twice daily', 70, 'green');
    add('A key limitation is that blinding', 70, 'pink', '평가자 눈가림 불가 — 한계로 정리');
  });
}

await test('notes panel: grouped by page, colour filter, jump, edit note, delete+undo', async () => {
  const { page, ctx, errors } = await open();
  await seedAnnotations(page);
  await page.click('#tabs [data-tab="notes"]');
  await page.waitForSelector('.pf-note');
  const groups = await page.$$eval('.pf-notes__page', (hs) => hs.map((h) => h.textContent));
  await shot(page, '13-notes');
  await page.click('.pf-filter [data-color="green"]');
  const greens = await page.$$eval('.pf-note', (ns) => ns.map((n) => n.className));
  assert(greens.length === 2 && greens.every((c) => c.includes('pf-note--green')), `filter ${greens}`);
  await page.click('.pf-filter [data-color="all"]');
  await page.click('.pf-note >> nth=2');
  const jumps = await page.evaluate(() => __h.jumps);
  await page.click('.pf-note >> nth=2 >> [data-action="edit"]');
  await page.fill('.pf-note textarea', '실무 적용 가능성 높음');
  await page.click('.pf-note [data-action="save"]');
  await page.waitForFunction(() => __h.session.annotations.items.some((a) => a.note === '실무 적용 가능성 높음'));
  const count0 = await page.$$eval('.pf-note', (ns) => ns.length);
  await page.click('.pf-note >> nth=0 >> [data-action="delete"]');
  await page.waitForFunction((n) => document.querySelectorAll('.pf-note').length === n - 1, count0);
  await page.click('.toast .toast-action');
  await page.waitForFunction((n) => document.querySelectorAll('.pf-note').length === n, count0);
  assert(groups.length === 2 && groups[0].startsWith('1쪽') && groups[1].startsWith('2쪽'), `groups ${groups}`);
  assert(jumps.length === 1, 'click → jump');
  assert(!errors.length, `page errors: ${errors}`);
  await ctx.close();
  return `groups ${groups.join(' & ')}, green filter → 2, click → jump ${jumps[0]}, note edited, delete → undo restored ${count0} items`;
});

await test('related panel: match → recommendations, s2PaperId stored, cache, api key header', async () => {
  const log = [];
  const { page, ctx, errors } = await open({ s2: { log } });
  await page.evaluate(() => __h.ctx.settings.set({ semanticScholar: { apiKey: 'test-key-123' } }));
  await page.click('#tabs [data-tab="related"]');
  // Regression (third-party-flows-not-disclosed): nothing is sent until the user agrees once.
  await page.waitForSelector('[data-action="s2-consent"]');
  assert(log.length === 0, `no Semantic Scholar request before consent (${log.length})`);
  await page.click('[data-action="s2-consent"]');
  await page.waitForSelector('.pf-related__item');
  const titles = await page.$$eval('.pf-related__title', (ts) => ts.map((t) => t.textContent));
  const updates = await page.evaluate(() => __h.library.updates);
  const cached = await page.waitForFunction(() => __h.library.data['paper1/ai']?.related?.items?.length === 5).then(() => true);
  const links = await page.$$eval('.pf-related__title a', (as) => as.every((a) => a.target === '_blank' && a.rel === 'noopener noreferrer'));
  await page.click('.pf-related__item >> nth=0 >> [data-action="translate"]');
  await page.waitForFunction(() => document.querySelector('.pf-related__ko')?.textContent.includes('〔빠른 번역〕'));
  await shot(page, '14-related');
  const before = log.length;
  await page.goto(`${BASE}/tests/features/harness.html?mock=1&tab=related`);
  await page.waitForSelector('body[data-ready="1"]');
  await page.waitForSelector('.pf-related__item');
  assert(log.length === before, 'reopen served from ai.related cache');
  assert(titles.length === 5 && log[0].path.endsWith('/search/match') && log[1].path.includes('/forpaper/S2MATCH'), `calls ${JSON.stringify(log)}`);
  assert(log.every((l) => l.apiKey === 'test-key-123'), 'x-api-key sent');
  assert(new URLSearchParams(log[0].query).get('fields') === 'title,year,authors,url,externalIds,abstract,citationCount', 'match fields');
  assert(new URLSearchParams(log[1].query).get('limit') === '20', 'limit=20');
  assert(updates.length === 1 && updates[0].patch.s2PaperId === 'S2MATCH', 'updatePaper(s2PaperId)');
  assert(cached && links, 'cached & safe links');
  assert(!errors.length, `page errors: ${errors}`);
  await ctx.close();
  return `GET ${log[0].path} → ${log[1].path}; 5 items; updatePaper({s2PaperId:'S2MATCH'}); ai.related cached (reopen made 0 requests); x-api-key sent; abstract translated`;
});

await test('related panel: 429 → friendly Korean retry message', async () => {
  const log = [];
  const { page, ctx } = await open({ s2: { mode: '429', log } });
  await page.click('#tabs [data-tab="related"]');
  await page.click('[data-action="s2-consent"]');
  await page.waitForSelector('.pf-error-box', { timeout: 6000 });
  const msg = await page.textContent('.pf-error-box p');
  await shot(page, '15-related-429');
  assert(msg.includes('429') && msg.includes('다시 시도'), msg);
  assert(log.length === 2, `one automatic retry (${log.length} requests)`);
  await ctx.close();
  return `message: "${msg}" (auto-retried once, then 다시 시도 button)`;
});

await test('citation card: [1] → reference card, Semantic Scholar lookup, grace delay hover', async () => {
  const log = [];
  const { page, ctx } = await open({ s2: { log } });
  await page.hover('.sv-link[data-token="[1]"]');
  await page.waitForSelector('.pf-cite--ref');
  const head = await page.textContent('.pf-cite--ref .pf-pop__head');
  const text = await page.textContent('.pf-cite__text');
  await shot(page, '16-citation-card');
  await page.click('[data-action="s2-search"]');
  await page.waitForSelector('.pf-cite__paper');
  const title = await page.textContent('.pf-cite__title');
  await shot(page, '17-citation-s2');
  // grace: leave the link, enter the popover → stays open
  const pop = await page.$eval('.pf-pop--cite', (e) => { const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + 20 }; });
  await page.mouse.move(pop.x, pop.y);
  await sleep(600);
  const stillOpen = !!(await page.$('.pf-pop--cite'));
  await page.mouse.move(5, 880);
  await sleep(500);
  const closed = !(await page.$('.pf-pop--cite'));
  // [2] resolves to the second entry
  await page.hover('.sv-link[data-token="[2]"]');
  await page.waitForSelector('.pf-cite--ref');
  const head2 = await page.textContent('.pf-cite--ref .pf-pop__head');
  assert(head.startsWith('참고문헌 1') && text.includes('Ely EW'), `card ${head} / ${text}`);
  assert(title.startsWith('Delirium as a predictor') && log[0].path.startsWith('/graph/v1/paper/DOI:10.1001/jama.291.14.1753'), `lookup ${title} ${JSON.stringify(log)}`);
  assert(stillOpen && closed, `grace hover open=${stillOpen} closed=${closed}`);
  assert(head2.startsWith('참고문헌 2'), head2);
  await ctx.close();
  return `hover [1] → "${head}" card; 검색 → DOI lookup "${title.slice(0, 40)}…"; popover survives moving into it, hides after leaving; [2] → "${head2}"`;
});

await test('preview popover: internal non-reference link renders target region; external link card', async () => {
  const { page, ctx } = await open();
  await page.hover('.sv-page[data-page="1"] .sv-link[data-token="Figure 1"]');
  await page.waitForSelector('.pf-cite--preview canvas');
  const call = await page.evaluate(() => __h.viewer.calls.find((c) => c.fn === 'renderRegion'));
  await shot(page, '18-preview-popover');
  await page.click('.pf-cite--preview [data-action="goto"]');
  const goto = await page.evaluate(() => __h.viewer.calls.find((c) => c.fn === 'scrollToPdfPoint'));
  await page.mouse.move(5, 880);
  await sleep(500);
  await page.hover('.sv-link--external');
  await page.waitForSelector('.pf-cite--external');
  const ext = await page.textContent('.pf-cite--external');
  assert(call.args[0] === 2 && call.args[2] === 440 && call.args[1].w > 0 && call.args[1].h > 0, `renderRegion ${JSON.stringify(call)}`);
  assert(goto && goto.args[0] === 2, 'goto scrolls to target');
  assert(ext.includes('example.org'), ext);
  await ctx.close();
  return `renderRegion(page 2, ${JSON.stringify(call.args[1])}, 440) shown; 이 위치로 이동 → scrollToPdfPoint(2, …); external card shows host`;
});

await test('explain: text selection → streaming side card, saved to ai.explanations', async () => {
  const { page, ctx, errors } = await open();
  await selectText(page, 'Delirium is a frequent and costly complication', 100);
  await page.waitForSelector('.pf-selmenu');
  await page.click('.pf-selmenu [data-action="explain"]');
  await page.waitForSelector('.pf-explain');
  const mid = await page.evaluate(async () => {
    await new Promise((r) => setTimeout(r, 250));
    return document.querySelector('.pf-explain__answer').textContent.length;
  });
  await page.waitForFunction(() => __h.library.data['paper1/ai']?.explanations?.length === 1, null, { timeout: 8000 });
  const final = await page.$eval('.pf-explain__answer', (e) => e.textContent.length);
  const saved = await page.evaluate(() => __h.library.data['paper1/ai'].explanations[0]);
  const call = await page.evaluate(() => window.__taskCalls.find((c) => c.fn === 'explain'));
  await shot(page, '19-explain-text');
  assert(mid > 0 && mid < final, `streamed ${mid} → ${final}`);
  assert(saved.kind === 'text' && saved.quote.startsWith('Delirium is a frequent') && saved.model === 'mock', JSON.stringify(saved));
  assert(call.nearSid === 'p1-2', `nearSid ${call.nearSid}`);
  assert(await page.$('.pf-explain .pf-sid'), 'sid chip in explanation');
  // regenerate twice mid-stream: only the last stream may paint or be saved
  const fullText = await page.$eval('.pf-explain__answer', (e) => e.textContent);
  await page.click('.pf-explain [data-action="regenerate"]');
  await sleep(120);
  await page.evaluate(() => document.querySelector('.pf-explain [data-action="regenerate"]').disabled = false);
  await page.click('.pf-explain [data-action="regenerate"]');
  await page.waitForFunction(() => __h.library.data['paper1/ai']?.explanations?.length === 2, null, { timeout: 8000 });
  await sleep(300);
  const regenText = await page.$eval('.pf-explain__answer', (e) => e.textContent);
  const regenStatus = await page.$eval('.pf-explain__status', (e) => e.textContent);
  assert(regenText === fullText && regenStatus === '', `regenerate race: "${regenText.slice(0, 40)}" status "${regenStatus}"`);
  await page.keyboard.press('Escape');
  assert(!(await page.$('.pf-explain')), 'Esc closes card');
  assert(!errors.length, `page errors: ${errors}`);
  await ctx.close();
  return `streamed ${mid}→${final} chars, nearSid=${call.nearSid}, saved {kind:text, model:mock}; double 다시 생성 mid-stream → one clean answer, 2 saved; Esc closes`;
});

await test('explain: 그림·표 설명 toggle → region capture → image explanation', async () => {
  const { page, ctx } = await open();
  await page.click('#tools [data-id="explain-region"]');
  const on = await page.evaluate(() => __h.viewer.calls.filter((c) => c.fn === 'setRegionCapture').map((c) => c.args[0]));
  await page.evaluate(() => __h.viewer.fakeCapture());
  await page.waitForSelector('.pf-explain__figure img');
  await page.waitForFunction(() => __h.library.data['paper1/ai']?.explanations?.length === 1, null, { timeout: 8000 });
  const calls = await page.evaluate(() => __h.viewer.calls.filter((c) => c.fn === 'setRegionCapture').map((c) => c.args[0]));
  const active = await page.getAttribute('#tools [data-id="explain-region"]', 'aria-pressed');
  const exp = await page.evaluate(() => window.__taskCalls.find((c) => c.fn === 'explain'));
  const captionSid = await page.evaluate(() => __h.doc.sentences.find((s) => s.kind === 'caption').sid);
  const saved = await page.evaluate(() => __h.library.data['paper1/ai'].explanations[0]);
  await shot(page, '20-explain-image');
  assert(on.join() === 'true' && calls.join() === 'true,false' && active === 'false', `capture toggling ${calls} ${active}`);
  assert(exp.hasImage && exp.nearSid === captionSid, `explain call ${JSON.stringify(exp)} (caption ${captionSid})`);
  assert(saved.kind === 'image' && saved.page === 2 && !('imageDataUrl' in saved), JSON.stringify(saved));
  await ctx.close();
  return `setRegionCapture(true) → capture → setRegionCapture(false), button reset; explain(image, nearSid=${exp.nearSid} = Figure 1 caption); saved {kind:image, page:2}`;
});

await test('auto highlight: keyPoints once, underline marks by category, legend filter, toggle off, cached reopen', async () => {
  const { page, ctx, errors } = await open();
  await page.click('#tools [data-id="auto-highlight"]');
  await page.waitForSelector('.pf-kp-chip');
  const v = await lastMarks(page, 'viewer', 'auto');
  const p = await lastMarks(page, 'pane', 'auto');
  const legend = await page.$$eval('.pf-kp-chip', (cs) => cs.map((c) => c.textContent));
  await shot(page, '21-autohighlight');
  await page.click('.pf-kp-chip[data-category="result"]');
  const filtered = await lastMarks(page, 'viewer', 'auto');
  await page.click('#tools [data-id="auto-highlight"]');
  const off = await lastMarks(page, 'viewer', 'auto');
  const legendGone = !(await page.$('.pf-kp-legend'));
  const pref = await page.evaluate(() => __h.ctx.settings.get().ui.showAutoHighlights);
  await page.click('#tools [data-id="auto-highlight"]');
  await page.waitForSelector('.pf-kp-chip');
  const calls = await taskCalls(page, 'keyPoints');
  const saved = await page.evaluate(() => __h.library.data['paper1/ai'].keyPoints);
  assert(v.length === 6 && v.every((m) => m.style === 'underline' && ['purple', 'blue', 'green', 'red', 'orange'].includes(m.color)), `marks ${JSON.stringify(v)}`);
  assert(p.length === 6, 'pane auto layer');
  assert(filtered.length === 4 && off.length === 0 && legendGone && pref === false, `filter ${filtered.length}, off ${off.length}`);
  assert(calls === 1 && saved.items.length === 6, `keyPoints calls ${calls}`);
  // reopen: setting on + cache → shown without a call
  await page.goto(`${BASE}/tests/features/harness.html?mock=1`);
  await page.waitForSelector('body[data-ready="1"]');
  await page.waitForSelector('.pf-kp-chip');
  const reopenMarks = await lastMarks(page, 'viewer', 'auto');
  const reopenCalls = await taskCalls(page, 'keyPoints');
  assert(reopenMarks.length === 6 && reopenCalls === 0, 'cached reopen');
  assert(!errors.length, `page errors: ${errors}`);
  await ctx.close();
  return `6 underline marks (2 invalid items dropped) on viewer+pane, legend [${legend.join(', ')}], hide 결과 → 4, off → [], pref saved; re-on → still 1 keyPoints call; reopen shows cached marks with 0 calls`;
});

await test('lifecycle: closing the paper aborts streams and disposes UI', async () => {
  const { page, ctx } = await open({ tab: 'chat' });
  await page.evaluate(() => { window.__chunkDelay = 150; });
  await page.fill('.pf-chat__input', '긴 답변 부탁');
  await page.press('.pf-chat__input', 'Enter');
  await sleep(500);
  await page.click('#tools [data-id="auto-highlight"]');
  await page.waitForSelector('.pf-kp-legend');
  const lenAtClose = await page.evaluate(() => {
    __h.closePaper();
    return [...document.querySelectorAll('.pf-msg--assistant .pf-msg__body')].at(-1).textContent.length;
  });
  await sleep(800);
  const lenAfter = await page.$eval('.pf-msg--assistant .pf-msg__body', (b) => b.textContent.length);
  const legend = await page.$('.pf-kp-legend');
  await page.evaluate(() => __h.viewer.selectRange(10, 40));
  const menu = await page.$('.pf-selmenu');
  assert(lenAfter <= lenAtClose + 8, `stream kept growing ${lenAtClose} → ${lenAfter}`);
  assert(!legend && !menu, 'legend removed, selection menu no longer installed');
  await ctx.close();
  return `answer length ${lenAtClose} at close → ${lenAfter} after 800 ms; legend removed; no selection menu after dispose`;
});

await test('no AI key: panels show settings gate instead of calling the API', async () => {
  const { page, ctx } = await open({ query: 'reset=1', tab: 'summary' });
  await page.waitForSelector('.pf-summary a[href="#/settings"]');
  await page.click('#tabs [data-tab="chat"]');
  await page.waitForSelector('.pf-chat a[href="#/settings"]');
  await shot(page, '22-no-key-gate');
  const calls = await page.evaluate(() => (window.__taskCalls || []).length);
  assert(calls === 0, 'no task calls without a key');
  await ctx.close();
  return 'summary + chat show 설정 열기 gate; 0 task calls';
});

await test('dark theme renders panels legibly', async () => {
  const { page, ctx } = await open({ query: 'mock=1&reset=1&theme=dark', tab: 'summary' });
  await page.click('[data-action="generate"]'); // summaries are made on request only
  await page.waitForSelector('.pf-summary__body h2');
  await seedAnnotations(page);
  await selectText(page, 'Staffing shortages were the most frequently', 60);
  await page.waitForSelector('.pf-selmenu');
  await shot(page, '23-dark-summary');
  await page.keyboard.press('Escape');
  await page.click('#tabs [data-tab="notes"]');
  await page.waitForSelector('.pf-note');
  await shot(page, '24-dark-notes');
  const bg = await page.$eval('.pf-panel', (e) => getComputedStyle(e).backgroundColor);
  assert(bg === 'rgb(29, 33, 39)', bg);
  await ctx.close();
  return `dark panel background ${bg}`;
});

await test('narrow viewport: chat composer and panels fit', async () => {
  const { page, ctx } = await open({ viewport: { width: 900, height: 760 }, tab: 'chat' });
  await page.fill('.pf-chat__input', '연구 방법을 요약해 줘');
  await page.press('.pf-chat__input', 'Enter');
  await page.waitForFunction(() => document.querySelectorAll('.pf-msg').length === 2 && !document.querySelector('.pf-msg.is-streaming'), null, { timeout: 8000 });
  await shot(page, '25-narrow-chat');
  const overflow = await page.$eval('.pf-chat', (e) => e.scrollWidth - e.clientWidth);
  assert(overflow <= 0, `horizontal overflow ${overflow}px`);
  await ctx.close();
  return 'no horizontal overflow at 900px window';
});

await browser.close();
if (server) server.kill();

const failed = results.filter((r) => r.result === 'fail');
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exitCode = failed.length ? 1 : 0;
