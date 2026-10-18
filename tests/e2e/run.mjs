// End-to-end tests of the real app (index.html) in Edge: library, reader, translation (mock provider),
// hover sync, features, settings, reload, and two-device sync against the fake GitHub server.
//   node tests/e2e/run.mjs     (starts `python -m http.server 8110` if nothing is listening)
// The last test takes the visual-QA screenshot matrix (library / reader / overlay / settings × 2 themes × 2 sizes).
// Results + screenshots: C:/Users/dindoo/Projects/pr-tools/out/integrate/. Fixture PDFs are read from
// C:/Users/dindoo/Projects/pr-fixtures and handed to the file input (never copied into the repo). Every
// non-loopback request is aborted; api.github.com is forwarded to the in-process fake.
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'file:///C:/Users/dindoo/Projects/pr-tools/node_modules/playwright/index.mjs';
import { routeGitHubToFake, startFakeGitHub } from '../store/fake-github.mjs';

const PORT = 8110;
const BASE = `http://127.0.0.1:${PORT}`;
const APP = `${BASE}/index.html?mock=1`;
const OUT = 'C:/Users/dindoo/Projects/pr-tools/out/integrate';
const FIXTURES = 'C:/Users/dindoo/Projects/pr-fixtures';
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const TOKEN = 'ghp_e2e_test_token';
const OWNER = 'me';
const REPO = 'paper-library';

mkdirSync(OUT, { recursive: true });
const results = [];
const problems = []; // console errors, page errors, CSP violations, escaped requests
const external = [];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function assert(cond, msg) { if (!cond) throw new Error(msg); }

async function test(name, fn) {
  const t0 = Date.now();
  const before = problems.length;
  try {
    const evidence = await fn();
    const fresh = problems.slice(before);
    if (fresh.length) throw new Error(`console/CSP problems during the test:\n  ${fresh.join('\n  ')}`);
    results.push({ name, result: 'pass', evidence: String(evidence ?? 'ok'), ms: Date.now() - t0 });
    console.log(`PASS  ${name}  (${Date.now() - t0} ms)\n      ${evidence ?? ''}`);
  } catch (err) {
    results.push({ name, result: 'fail', evidence: err?.stack || String(err), ms: Date.now() - t0 });
    console.log(`FAIL  ${name}\n      ${err?.stack || err}`);
  }
}

async function serverUp() {
  try { return (await fetch(`${BASE}/index.html`)).ok; } catch { return false; }
}
async function waitFor(fn, timeout = 10000, what = 'condition') {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error(`timeout waiting for ${what}`);
    await sleep(50);
  }
}

let server = null;
if (!(await serverUp())) {
  server = spawn('python', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], { cwd: REPO_ROOT, stdio: 'ignore' });
  await waitFor(serverUp, 8000, 'python http.server');
}
const fake = await startFakeGitHub({ port: 0 });
fake.addToken(TOKEN, { write: true });
// Initialised with a README, as the in-app how-to tells users to do ("Add a README file"). The empty-repo
// path (409 → README bootstrap) is covered by tests/store; Chromium logs those 409s as console errors.
fake.createRepo(OWNER, REPO, { private: true, files: { 'README.md': '# paper-library' } });
const repoJson = (path) => JSON.parse(fake.readFile(OWNER, REPO, path).toString('utf8'));
const repoHas = (path) => fake.files(OWNER, REPO).has(path);

// Even a request that escaped every route could not reach the real GitHub.
const browser = await chromium.launch({
  channel: 'msedge',
  args: ['--host-resolver-rules=MAP api.github.com 127.0.0.1, MAP *.github.com 127.0.0.1'],
});

/**
 * One browser context = one device. Records console errors, page errors and CSP violations.
 * @param {string} name
 * @param {{ viewport?: {width:number,height:number}, colorScheme?: 'light'|'dark', github?: boolean }} [opts]
 */
async function device(name, { viewport = { width: 1440, height: 900 }, colorScheme = 'light', github = false } = {}) {
  const ctx = await browser.newContext({ locale: 'ko-KR', viewport, colorScheme, acceptDownloads: false });
  await ctx.route(/^https?:\/\/(?!127\.0\.0\.1[:/])/, (route) => {
    const url = route.request().url();
    // The web font stylesheet is cosmetic; answer it locally instead of failing the request.
    if (url.startsWith('https://cdn.jsdelivr.net/gh/orioncactus/pretendard')) {
      return route.fulfill({ status: 200, contentType: 'text/css', body: '/* font stub (offline test) */' });
    }
    external.push(`${name}: ${url}`);
    problems.push(`${name}: external request blocked ${url}`);
    return route.abort();
  });
  if (github) await routeGitHubToFake(ctx, fake.url);
  await ctx.addInitScript(() => {
    window.__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => {
      window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`);
      console.error(`[csp] ${e.violatedDirective} blocked ${e.blockedURI}`);
    });
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => problems.push(`${name}: pageerror ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`${name}: console.error ${m.text()}`);
  });
  return { name, ctx, page };
}

const fixture = (name) => `${FIXTURES}/${name}.pdf`;
const shot = (page, file, opts = {}) => page.screenshot({ path: `${OUT}/${file}.png`, ...opts });

/** Wait until the app has booted on the current route. */
async function booted(page) {
  await page.waitForFunction(() => document.querySelector('.library, .reader, .settings, .message-screen'), null, { timeout: 30000 });
}

async function openLibrary(page) {
  await page.goto(`${APP}#/`);
  await booted(page);
  await page.waitForSelector('.library');
}

/** Answer the shell's promptDialog. */
async function answerPrompt(page, value) {
  const input = page.locator('.modal-backdrop input').last();
  await input.waitFor();
  await input.fill(value);
  await input.press('Enter');
  await page.waitForFunction(() => !document.querySelector('.modal-backdrop'));
}

async function confirmModal(page, label) {
  await page.locator('.modal-footer button', { hasText: label }).last().click();
  await page.waitForFunction(() => !document.querySelector('.modal-backdrop'));
}

function folderItem(page, name) {
  return page.locator('.tree-item.is-folder', { has: page.locator('.tree-label', { hasText: new RegExp(`^${name}$`) }) });
}

async function contextMenuOn(page, locator, item) {
  await locator.click({ button: 'right' });
  await page.locator('.menu .menu-item', { hasText: item }).first().click();
}

async function libraryState(page) {
  return page.evaluate(async () => {
    const raw = await new Promise((res, rej) => {
      const req = indexedDB.open('paper-reader');
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction('files', 'readonly');
        const get = tx.objectStore('files').get('library.json');
        get.onsuccess = () => res(get.result);
        get.onerror = () => rej(get.error);
      };
      req.onerror = () => rej(req.error);
    });
    const data = typeof raw?.data === 'string' ? JSON.parse(raw.data) : raw?.data;
    return data || null;
  });
}

const rowTitles = (page) => page.$$eval('.paper-row .paper-title', (els) => els.map((e) => e.textContent.trim()));

// ----------------------------------------------------------------------------------------- reader

async function waitForReader(page) {
  await page.waitForFunction(() => document.querySelector('.tp-s[data-sid], .tp-empty, .reader .message-screen'), null, { timeout: 60000 });
  const error = await page.$('.reader .message-screen');
  if (error) throw new Error(`reader error: ${(await error.textContent()).trim()}`);
  await page.waitForFunction(() => !document.querySelector('.reader-left .reader-loading'), null, { timeout: 30000 });
  await page.waitForFunction(() => document.querySelector('.pdfv-page canvas'), null, { timeout: 30000 });
  await settle(page);
}

/** Wait until neither pane is scrolling (scroll sync animates the pane after the PDF moves). */
async function settle(page, quietMs = 400) {
  let last = '';
  let since = Date.now();
  const t0 = Date.now();
  while (Date.now() - since < quietMs && Date.now() - t0 < 5000) {
    const now = await page.evaluate(() => ['.tp-host', '.viewer-host'].map((q) => document.querySelector(q)?.scrollTop ?? -1).join(','));
    if (now !== last) { last = now; since = Date.now(); }
    await sleep(60);
  }
}

/** Jump the viewer to a page with the toolbar's page box and wait until it has rendered. */
async function gotoPage(page, n) {
  await page.locator('.tb-page-input').fill(String(n));
  await page.locator('.tb-page-input').press('Enter');
  await page.waitForFunction((n) => document.querySelector(`.pdfv-page[data-page="${n}"] canvas`), n, { timeout: 10000 });
  await settle(page);
}

/** A repo-path record from the app's IndexedDB 'files' store, parsed as JSON. */
async function fileJson(page, path) {
  return page.evaluate(async (path) => {
    const rec = await new Promise((res, rej) => {
      const req = indexedDB.open('paper-reader');
      req.onsuccess = () => {
        const get = req.result.transaction('files', 'readonly').objectStore('files').get(path);
        get.onsuccess = () => res(get.result);
        get.onerror = () => rej(get.error);
      };
      req.onerror = () => rej(req.error);
    });
    if (!rec || rec.deleted) return null;
    const d = rec.data;
    if (typeof d === 'string') return JSON.parse(d);
    if (d instanceof Uint8Array || d instanceof ArrayBuffer) return JSON.parse(new TextDecoder().decode(d));
    return d ?? null;
  }, path);
}

/** Wait until the pane marks `sid` with `cls`; on timeout report what the pane and viewer show instead. */
async function expectPaneClass(page, sid, cls, timeout = 3000, point = null) {
  try {
    await page.waitForFunction(([s, c]) => document.querySelector(`.tp-s.${c}[data-sid="${s}"]`), [sid, cls], { timeout });
  } catch {
    const state = await page.evaluate(([c, pt]) => ({
      pane: [...document.querySelectorAll(`.tp-s.${c}`)].map((e) => e.dataset.sid),
      hl: document.querySelectorAll('.pdfv-hl--hover').length,
      active: document.querySelectorAll('.pdfv-hl--active').length,
      at: pt ? document.elementsFromPoint(pt.x, pt.y).slice(0, 6).map((n) => `${n.tagName}.${[...n.classList].join('.')}:${(n.textContent || '').slice(0, 30)}`) : null,
    }), [cls, point]);
    await shot(page, `e2e-fail-${cls}-${sid}`);
    throw new Error(`pane .${cls} expected on ${sid}, found ${JSON.stringify(state)} point ${JSON.stringify(point)}`);
  }
}

/** Text of the PDF text-layer spans under the viewer's current hover highlight boxes. */
async function wordsUnderHover(page, kind = 'hover') {
  return page.evaluate((kind) => {
    const boxes = [...document.querySelectorAll(`.pdfv-hl--${kind}`)].map((n) => n.getBoundingClientRect());
    const seen = new Set();
    let text = '';
    for (const r of boxes) {
      for (let i = 1; i < 12; i++) {
        const x = r.left + (r.width * i) / 12;
        const y = r.top + r.height / 2;
        for (const node of document.elementsFromPoint(x, y)) {
          if (node.matches?.('.textLayer span') && !node.querySelector('span') && !seen.has(node)) {
            seen.add(node);
            text += ` ${node.textContent}`;
          }
        }
      }
    }
    return { boxes: boxes.map((r) => ({ x: r.left, y: r.top, w: r.width, h: r.height })), text: text.trim() };
  }, kind);
}

const words = (s) => (String(s).toLowerCase().match(/[a-z]{3,}/g) || []);
function wordOverlap(sentence, found) {
  const want = words(sentence);
  const have = new Set(words(found));
  if (!want.length) return 1;
  return want.filter((w) => have.has(w)).length / want.length;
}

/** First pane sentence (body, English, visible in the pane) whose PDF counterpart is on screen. */
async function pickPaneSentence(page, { minLen = 60, page: pdfPage = null } = {}) {
  return page.evaluate(({ minLen, pdfPage }) => {
    const host = document.querySelector('.tp-host');
    const hr = host.getBoundingClientRect();
    for (const span of document.querySelectorAll('.tp-s.tp-kind-body[data-sid]')) {
      const sid = span.dataset.sid;
      if (pdfPage && !sid.startsWith(`p${pdfPage}-`)) continue;
      if (span.textContent.length < minLen) continue;
      const r = span.getBoundingClientRect();
      if (r.top < hr.top + 10 || r.bottom > hr.bottom - 10) continue;
      return { sid, text: span.textContent };
    }
    return null;
  }, { minLen, pdfPage });
}

async function hoverPaneSpan(page, sid) {
  await page.evaluate((sid) => {
    const span = document.querySelector(`.tp-s[data-sid="${sid}"]`);
    const host = document.querySelector('.tp-host').getBoundingClientRect();
    const r = span.getClientRects()[0];
    if (r.top < host.top + 8 || r.bottom > host.bottom - 8) span.scrollIntoView({ block: 'center' });
  }, sid);
  // An inline span that starts mid-line has a bounding box wider than its first line fragment, so aim
  // at the first fragment's own rect. A real pointer move: from outside the pane text into the span.
  const r = await page.evaluate((sid) => {
    const rect = document.querySelector(`.tp-s[data-sid="${sid}"]`).getClientRects()[0];
    return { x: rect.left, y: rect.top, w: rect.width, h: rect.height };
  }, sid);
  await page.mouse.move(r.x + r.w / 2, r.y - 40);
  await page.mouse.move(r.x + Math.min(r.w / 2, 40), r.y + r.h / 2, { steps: 4 });
  await expectPaneClass(page, sid, 'is-hover', 2000, { x: r.x + Math.min(r.w / 2, 40), y: r.y + r.h / 2 });
}

/** Library ids of the uploaded fixtures, by file name without .pdf. */
const paperIds = {};

// ===================================================================================== tests

try {
  const A = await device('A', { github: true });
  const { page } = A;

  await test('boot: empty library state, no console errors, no CSP violations', async () => {
    await openLibrary(page);
    await page.waitForSelector('.onboarding');
    const title = await page.title();
    const text = (await page.textContent('.lib-main')).replace(/\s+/g, ' ');
    assert(/논문 PDF를 이곳에 끌어다 놓으세요/.test(text), 'empty-state drop zone');
    const chip = (await page.textContent('.lib-sync')).trim();
    assert(/꺼짐/.test(chip), `sync chip ${chip}`);
    await shot(page, 'e2e-01-empty-library');
    const csp = await page.evaluate(() => window.__csp.length);
    assert(csp === 0, 'CSP violations');
    return `title “${title}”, onboarding shown, sync chip “${chip}”, 0 CSP violations`;
  });

  await test('folders: create nested, rename, move, delete', async () => {
    await page.locator('.lib-nav-heading button').click();
    await answerPrompt(page, '중환자 간호');
    await page.waitForSelector('.tree-item.is-folder');
    await contextMenuOn(page, folderItem(page, '중환자 간호'), '새 하위 폴더');
    await answerPrompt(page, '섬망');
    await contextMenuOn(page, folderItem(page, '중환자 간호'), '새 하위 폴더');
    await answerPrompt(page, '임시 폴더');
    await page.locator('.lib-nav-heading button').click();
    await answerPrompt(page, '통계 방법');
    await page.waitForFunction(() => document.querySelectorAll('.tree-item.is-folder').length === 4);
    // rename
    await contextMenuOn(page, folderItem(page, '섬망'), '이름 바꾸기');
    await answerPrompt(page, '섬망 연구');
    await folderItem(page, '섬망 연구').waitFor();
    // move '통계 방법' under '중환자 간호' by drag-drop, then back to top level via the menu
    await folderItem(page, '통계 방법').dragTo(folderItem(page, '중환자 간호'));
    let lib = await waitFor(async () => {
      const l = await libraryState(page);
      const stats = l?.folders.find((f) => f.name === '통계 방법' && !f.deleted);
      const parent = l?.folders.find((f) => f.name === '중환자 간호');
      return stats && parent && stats.parentId === parent.id ? l : null;
    }, 5000, 'folder drag-drop move');
    await contextMenuOn(page, folderItem(page, '통계 방법'), '최상위로 옮기기');
    lib = await waitFor(async () => {
      const l = await libraryState(page);
      return l?.folders.find((f) => f.name === '통계 방법' && !f.deleted && f.parentId == null) ? l : null;
    }, 5000, 'folder moved to top');
    // delete
    await contextMenuOn(page, folderItem(page, '임시 폴더'), '삭제');
    await confirmModal(page, '폴더 삭제');
    lib = await waitFor(async () => {
      const l = await libraryState(page);
      return l?.folders.find((f) => f.name === '임시 폴더')?.deleted ? l : null;
    }, 5000, 'folder tombstone');
    const live = lib.folders.filter((f) => !f.deleted);
    const names = live.map((f) => {
      const parent = live.find((p) => p.id === f.parentId);
      return parent ? `${parent.name}/${f.name}` : f.name;
    }).sort();
    assert(names.join('|') === '중환자 간호|중환자 간호/섬망 연구|통계 방법', `folders ${names}`);
    const ui = await page.$$eval('.tree-item.is-folder .tree-label', (els) => els.map((e) => e.textContent));
    assert(!ui.includes('임시 폴더'), 'deleted folder hidden');
    await shot(page, 'e2e-02-folders');
    return `IndexedDB library.json folders: ${names.join(', ')}; ‘임시 폴더’ tombstoned (deleted:true) and hidden; drag-drop + menu moves both applied`;
  });

  await test('upload lu2025 + kiekkas2012 + cohen1960 via the file input', async () => {
    await page.locator('.tree-item', { hasText: '전체' }).first().click();
    await page.setInputFiles('.lib-actions input[type=file]', [fixture('lu2025'), fixture('kiekkas2012'), fixture('cohen1960')]);
    await page.waitForFunction(() => document.querySelectorAll('.paper-row').length === 3, null, { timeout: 60000 });
    await page.waitForFunction(() => !document.querySelector('.lib-actions .btn[disabled]'), null, { timeout: 60000 });
    const titles = await rowTitles(page);
    const lib = await libraryState(page);
    for (const p of lib.papers) paperIds[p.fileName.replace(/\.pdf$/, '')] = p.id;
    assert(lib.papers.length === 3 && lib.papers.every((p) => p.size > 0 && p.pages > 0), 'papers stored with size/pages');
    await shot(page, 'e2e-03-uploaded');
    return `rows: ${titles.map((t) => `“${t.slice(0, 50)}”`).join(', ')}; pages ${lib.papers.map((p) => p.pages).join('/')}`;
  });

  await test('move papers into folders: drag-drop and 폴더로 이동… menu', async () => {
    const luRow = page.locator(`.paper-row[data-id="${paperIds.lu2025}"]`);
    // drag-drop lu2025 onto '섬망 연구' (a nested folder: expand its parent first)
    const parentRow = page.locator('.tree-row', { has: folderItem(page, '중환자 간호') });
    const toggle = parentRow.locator('.tree-toggle');
    if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
    await luRow.dragTo(folderItem(page, '섬망 연구'));
    await waitFor(async () => {
      const l = await libraryState(page);
      const f = l.folders.find((x) => x.name === '섬망 연구');
      return l.papers.find((p) => p.id === paperIds.lu2025)?.folderId === f.id;
    }, 5000, 'drag-drop move');
    // menu move kiekkas2012 → 통계 방법
    const kRow = page.locator(`.paper-row[data-id="${paperIds.kiekkas2012}"]`);
    await kRow.locator('button[aria-label="논문 메뉴"]').click();
    await page.locator('.menu .menu-item', { hasText: '폴더로 이동' }).click();
    await page.locator('.folder-picker label', { hasText: '통계 방법' }).click();
    await confirmModal(page, '이동');
    const lib = await waitFor(async () => {
      const l = await libraryState(page);
      const f = l.folders.find((x) => x.name === '통계 방법');
      return l.papers.find((p) => p.id === paperIds.kiekkas2012)?.folderId === f.id ? l : null;
    }, 5000, 'menu move');
    await folderItem(page, '섬망 연구').click();
    const inFolder = await rowTitles(page);
    await folderItem(page, '중환자 간호').click();
    const counts = await page.$$eval('.tree-item.is-folder', (els) => els.map((e) => `${e.querySelector('.tree-label').textContent}=${e.querySelector('.tree-count').textContent}`));
    await shot(page, 'e2e-04-moved');
    await page.locator('.tree-item', { hasText: '전체' }).first().click();
    assert(inFolder.length === 1, `섬망 연구 holds ${inFolder}`);
    return `섬망 연구 → [${inFolder.map((t) => t.slice(0, 40))}], counts ${counts.join(', ')}; kiekkas folderId = 통계 방법 (${lib.papers.length} papers)`;
  });

  await test('open lu2025: PDF left, translation pane right, no errors', async () => {
    await page.goto(`${APP}#/paper/${encodeURIComponent(paperIds.lu2025)}`);
    await waitForReader(page);
    const layout = await page.evaluate(() => {
      const l = document.querySelector('.reader-left').getBoundingClientRect();
      const r = document.querySelector('.reader-right').getBoundingClientRect();
      const pg = document.querySelector('.pdfv-page').getBoundingClientRect();
      return { left: [l.left, l.width], right: [r.left, r.width], page: [pg.width, pg.height], spans: document.querySelectorAll('.tp-s[data-sid]').length, tab: document.querySelector('.tab[aria-selected="true"]').textContent };
    });
    assert(layout.left[0] < layout.right[0] && layout.right[1] > 300 && layout.page[0] > 300, `layout ${JSON.stringify(layout)}`);
    assert(layout.spans > 300, 'pane sentences');
    await shot(page, 'e2e-05-reader');
    return `left pane x=${Math.round(layout.left[0])} w=${Math.round(layout.left[1])}, right pane x=${Math.round(layout.right[0])} w=${Math.round(layout.right[1])}, page ${Math.round(layout.page[0])}×${Math.round(layout.page[1])}px, ${layout.spans} pane sentences, tab “${layout.tab}”`;
  });

  await test('hover sync both ways with real mouse moves (pane → PDF geometry, PDF → pane)', async () => {
    const picked = await pickPaneSentence(page, { minLen: 80, page: 1 });
    assert(picked, 'no visible page-1 body sentence in the pane');
    await hoverPaneSpan(page, picked.sid);
    await page.waitForSelector('.pdfv-hl--hover');
    const under = await wordsUnderHover(page);
    const overlap = wordOverlap(picked.text, under.text);
    await shot(page, 'e2e-06-hover-pane-to-pdf');
    assert(overlap >= 0.85, `PDF words under the hover boxes match ${Math.round(overlap * 100)}% of “${picked.text.slice(0, 80)}” (got “${under.text.slice(0, 120)}”)`);
    // PDF → pane: move the real pointer onto the middle of the drawn box.
    const b = under.boxes[0];
    await page.mouse.move(b.x + b.w / 2, b.y + b.h / 2, { steps: 6 });
    await page.waitForFunction((sid) => document.querySelector(`.tp-s.is-hover[data-sid="${sid}"]`), picked.sid, { timeout: 3000 });
    const paneHover = await page.$$eval('.tp-s.is-hover', (els) => els.map((e) => e.dataset.sid));
    // A second sentence further down the page: hover in the pane, then come back from the PDF side.
    const second = await page.evaluate((sid) => {
      const spans = [...document.querySelectorAll('.tp-s.tp-kind-body[data-sid^="p1-"]')].filter((s) => s.textContent.length > 60);
      const i = spans.findIndex((s) => s.dataset.sid === sid);
      return spans[i + 2]?.dataset.sid || null;
    }, picked.sid);
    let secondNote = 'n/a';
    if (second) {
      await hoverPaneSpan(page, second);
      await page.waitForFunction(() => document.querySelector('.pdfv-hl--hover'));
      const u2 = await wordsUnderHover(page);
      const r = u2.boxes.at(-1);
      await page.mouse.move(r.x + r.w / 2, r.y + r.h / 2, { steps: 5 });
      await page.waitForFunction((sid) => document.querySelector(`.tp-s.is-hover[data-sid="${sid}"]`), second, { timeout: 3000 });
      secondNote = `${second} (${u2.boxes.length} boxes, ${Math.round(wordOverlap(await page.textContent(`.tp-s[data-sid="${second}"]`), u2.text) * 100)}% words) ok`;
    }
    await shot(page, 'e2e-07-hover-pdf-to-pane');
    await page.mouse.move(5, 300);
    return `${picked.sid}: ${under.boxes.length} box(es), ${Math.round(overlap * 100)}% of the sentence's words under them; PDF hover → pane .is-hover [${paneHover}]; second sentence ${secondNote}`;
  });

  await test('click sync: PDF click → pane scrolls + active; pane click → PDF scrolls + active outline', async () => {
    await gotoPage(page, 3);
    const target = await page.evaluate(() => {
      const spans = [...document.querySelectorAll('.tp-s.tp-kind-body[data-sid^="p3-"]')].filter((s) => s.textContent.length > 80);
      return spans[3]?.dataset.sid;
    });
    await page.evaluate((sid) => document.querySelector(`.tp-s[data-sid="${sid}"]`).scrollIntoView({ block: 'center' }), target);
    await hoverPaneSpan(page, target);
    await page.waitForSelector('.pdfv-hl--hover');
    const box = (await wordsUnderHover(page)).boxes[0];
    // Scroll the pane away so the click has to bring the sentence back.
    await page.evaluate(() => { document.querySelector('.tp-host').scrollTop = 0; });
    await page.mouse.move(box.x + box.w / 2, box.y + box.h / 2, { steps: 3 });
    await page.mouse.down();
    await page.mouse.up();
    await expectPaneClass(page, target, 'is-active', 4000, { x: box.x + box.w / 2, y: box.y + box.h / 2, box });
    await page.waitForFunction((sid) => {
      const span = document.querySelector(`.tp-s.is-active[data-sid="${sid}"]`);
      if (!span) return false;
      const r = span.getBoundingClientRect();
      const h = document.querySelector('.tp-host').getBoundingClientRect();
      return r.top >= h.top && r.bottom <= h.bottom;
    }, target, { timeout: 4000 });
    // Pane side: a sentence on page 7.
    const far = await page.evaluate(() => [...document.querySelectorAll('.tp-s.tp-kind-body[data-sid^="p7-"]')].find((s) => s.textContent.length > 60)?.dataset.sid);
    await page.evaluate((sid) => document.querySelector(`.tp-s[data-sid="${sid}"]`).scrollIntoView({ block: 'center' }), far);
    await page.locator(`.tp-s[data-sid="${far}"]`).click();
    await page.waitForFunction(() => document.querySelector('.tb-page-input').value === '7', null, { timeout: 5000 });
    await page.waitForSelector('.pdfv-page[data-page="7"] .pdfv-hl--active', { timeout: 8000 });
    const activeInView = await page.evaluate(() => {
      const r = document.querySelector('.pdfv-hl--active').getBoundingClientRect();
      const v = document.querySelector('.viewer-host').getBoundingClientRect();
      return r.top >= v.top && r.bottom <= v.bottom;
    });
    assert(activeInView, 'active outline not inside the PDF viewport');
    await shot(page, 'e2e-08-click-sync');
    return `PDF click on ${target} → pane scrolled it into view with .is-active; pane click on ${far} → PDF page 7, active outline visible`;
  });

  await test('zoom keeps hover alignment (zoom in ×2, then fit width)', async () => {
    await page.locator('button[aria-label="확대 (+)"]').click();
    await page.locator('button[aria-label="확대 (+)"]').click();
    await sleep(600);
    const zoomLabel = (await page.textContent('.tb-zoom-label')).trim();
    await gotoPage(page, 2);
    const picked = await page.evaluate(() => {
      const spans = [...document.querySelectorAll('.tp-s.tp-kind-body[data-sid^="p2-"]')].filter((s) => s.textContent.length > 80);
      return spans[1] ? { sid: spans[1].dataset.sid, text: spans[1].textContent } : null;
    });
    await page.evaluate((sid) => document.querySelector(`.tp-s[data-sid="${sid}"]`).scrollIntoView({ block: 'center' }), picked.sid);
    await hoverPaneSpan(page, picked.sid);
    await page.waitForSelector('.pdfv-hl--hover');
    // The highlight may be off-screen in the zoomed viewer: bring it into view, then hover again.
    await page.evaluate(() => document.querySelector('.pdfv-hl--hover').scrollIntoView({ block: 'center', inline: 'center' }));
    await sleep(400);
    await hoverPaneSpan(page, picked.sid);
    await page.waitForSelector('.pdfv-hl--hover');
    const under = await wordsUnderHover(page);
    const overlap = wordOverlap(picked.text, under.text);
    await shot(page, 'e2e-09-zoomed-hover');
    assert(overlap >= 0.85, `zoomed overlap ${Math.round(overlap * 100)}% (“${under.text.slice(0, 100)}”)`);
    await page.locator('button[aria-label="폭 맞춤 (0)"]').click();
    await sleep(400);
    const fitLabel = (await page.textContent('.tb-zoom-label')).trim();
    return `zoom ${zoomLabel}: ${Math.round(overlap * 100)}% of ${picked.sid}'s words under its hover boxes; back to fit width (${fitLabel})`;
  });

  await test('translate (mock): pane fills progressively, progress + cost update, saved', async () => {
    await page.evaluate(async () => {
      const { mockControl } = await import('/js/ai/mock.js');
      mockControl.latencyMs = 120;
      mockControl.reportModel = 'claude-haiku-5-5'; // price the fake usage so the cost display is exercised
    });
    await gotoPage(page, 1);
    await page.locator('.tb-tr-main').click();
    const samples = [];
    const t0 = Date.now();
    for (;;) {
      const s = await page.evaluate(() => ({
        done: document.querySelectorAll('.tp-s.is-translated').length,
        pending: document.querySelectorAll('.tp-s.is-pending').length,
        pct: document.querySelector('.tb-pct')?.textContent || '',
        cost: document.querySelector('.tb-cost')?.textContent || '',
        label: document.querySelector('.tb-tr-main .btn-label')?.textContent || '',
        status: document.querySelector('.tp-header-status')?.textContent || '',
      }));
      samples.push(s);
      if (s.label === '번역 완료') break;
      if (Date.now() - t0 > 90000) throw new Error(`translation did not finish: ${JSON.stringify(s)}`);
      await sleep(150);
    }
    const growing = samples.filter((s, i) => i && s.done > samples[i - 1].done).length;
    const mid = samples[Math.floor(samples.length / 2)];
    const last = samples.at(-1);
    assert(growing >= 3, `pane did not fill progressively (${growing} growth steps)`);
    assert(/\$/.test(last.status) || /\$/.test(mid.cost), `cost never shown: ${JSON.stringify(last)}`);
    const shown = await page.$$eval('.tp-s.is-translated.tp-kind-body', (els) => els.map((e) => e.textContent));
    const sample = shown.find((t) => /^〔번역〕/.test(t));
    assert(sample, `mock translation text ${shown.slice(0, 3)}`);
    // A sentence that is only a DOI/URL is shown as is (never sent for translation).
    const doiAsIs = shown.find((t) => /^https?:\/\/doi\.org\/\S+$/.test(t));
    await shot(page, 'e2e-10-translated');
    const saved = await waitFor(async () => Object.keys((await fileJson(page, `papers/${paperIds.lu2025}/translation.json`))?.items || {}).length, 8000, 'translation.json saved');
    return `${samples.length} samples, ${growing} growth steps; midway ${mid.done} translated / pct ${mid.pct} / cost “${mid.cost}”; end “${last.status.trim()}”; translation.json holds ${saved} items; DOI-only sentence shown as is: ${doiAsIs || '(none)'}`;
  });

  await test('hover sync after translation (Korean pane spans ↔ PDF)', async () => {
    await page.evaluate(() => { document.querySelector('.tp-host').scrollTop = 0; });
    await gotoPage(page, 1);
    const sid = await page.evaluate(() => {
      const h = document.querySelector('.tp-host').getBoundingClientRect();
      return [...document.querySelectorAll('.tp-s.is-translated.tp-kind-body[data-sid^="p1-"]')]
        .find((s) => { const r = s.getBoundingClientRect(); return r.top > h.top + 20 && r.bottom < h.bottom - 20; })?.dataset.sid;
    });
    assert(sid, 'no translated page-1 sentence visible in the pane');
    await hoverPaneSpan(page, sid);
    await page.waitForSelector('.pdfv-hl--hover');
    await page.evaluate(() => {
      const hl = document.querySelector('.pdfv-hl--hover').getBoundingClientRect();
      const v = document.querySelector('.viewer-host').getBoundingClientRect();
      if (hl.top < v.top + 20 || hl.bottom > v.bottom - 20) document.querySelector('.pdfv-hl--hover').scrollIntoView({ block: 'center' });
    });
    await sleep(300);
    await hoverPaneSpan(page, sid);
    const under = await wordsUnderHover(page);
    const b = under.boxes[0];
    await page.mouse.move(b.x + b.w / 2, b.y + b.h / 2, { steps: 5 });
    await expectPaneClass(page, sid, 'is-hover', 3000, { x: b.x + b.w / 2, y: b.y + b.h / 2, box: b });
    await shot(page, 'e2e-11-hover-translated');
    await page.mouse.move(5, 300);
    return `${sid}: pane → PDF ${under.boxes.length} box(es); PDF → pane .is-hover`;
  });

  await test('번역 겹쳐보기: Korean painted over the PDF, hover works, fit-width capped', async () => {
    await page.locator('.segmented button', { hasText: '번역 겹쳐보기' }).click();
    await page.waitForSelector('.pdfv-tsent', { timeout: 8000 });
    await sleep(600);
    const info = await page.evaluate(() => ({
      spans: document.querySelectorAll('.pdfv-tsent').length,
      korean: [...document.querySelectorAll('.pdfv-tsent')].filter((s) => /〔번역〕/.test(s.textContent)).length,
      zoom: document.querySelector('.tb-zoom-label').textContent.trim(),
      rightHidden: getComputedStyle(document.querySelector('.reader-right')).display === 'none',
      pageW: document.querySelector('.pdfv-page').getBoundingClientRect().width,
    }));
    const zoomPct = parseInt(info.zoom, 10);
    assert(info.korean > 10, `overlay korean spans ${info.korean}`);
    assert(zoomPct <= 160, `fit-width zoom ${info.zoom} exceeds the 160% cap`);
    const t = await page.evaluate(() => {
      const v = document.querySelector('.viewer-host').getBoundingClientRect();
      const span = [...document.querySelectorAll('.pdfv-tsent')].find((s) => {
        const r = s.getClientRects()[0];
        return r && /〔번역〕/.test(s.textContent) && r.top > v.top + 150 && r.bottom < v.bottom - 20 && r.width > 30;
      });
      const r = span.getClientRects()[0];
      return { sid: span.dataset.sid, x: r.left, y: r.top, width: r.width, height: r.height };
    });
    await page.mouse.move(t.x + Math.min(20, t.width / 2), t.y + t.height / 2, { steps: 4 });
    await sleep(300);
    const hovered = await page.evaluate(() => document.querySelectorAll('.pdfv-tsent--hover, .pdfv-hl--hover').length);
    await shot(page, 'e2e-12-overlay');
    await page.mouse.move(5, 300);
    await page.locator('.segmented button', { hasText: '나란히' }).click();
    await page.waitForFunction(() => !document.querySelector('.pdfv-tsent'));
    assert(hovered > 0, 'overlay hover drew nothing');
    return `${info.spans} overlay spans (${info.korean} Korean), zoom ${info.zoom} (cap 160%), page ${Math.round(info.pageW)}px wide, right pane hidden=${info.rightHidden}, hover on ${t.sid} → ${hovered} highlighted element(s)`;
  });

  await test('select text → selection menu → highlight → shown on both panes and in 메모', async () => {
    await gotoPage(page, 2);
    // Drag across a long text-layer span on page 2 (a real mouse selection).
    const span = await page.evaluate(() => {
      const v = document.querySelector('.viewer-host').getBoundingClientRect();
      const spans = [...document.querySelectorAll('.pdfv-page[data-page="2"] .textLayer span')]
        .filter((s) => !s.querySelector('span') && s.textContent.length > 50 && /^[A-Za-z]/.test(s.textContent))
        .map((s) => ({ s, r: s.getBoundingClientRect() }))
        .filter(({ r }) => r.top > v.top + 80 && r.bottom < v.bottom - 80 && r.width > 150);
      const { s, r } = spans[2] || spans[0];
      return { text: s.textContent, x: r.left, y: r.top, w: r.width, h: r.height };
    });
    await page.mouse.move(span.x + 3, span.y + span.h / 2);
    await page.mouse.down();
    await page.mouse.move(span.x + span.w * 0.5, span.y + span.h / 2, { steps: 5 });
    await page.mouse.move(span.x + span.w - 3, span.y + span.h / 2, { steps: 5 });
    await page.mouse.up();
    await page.waitForSelector('.pf-selmenu', { timeout: 4000 });
    await shot(page, 'e2e-13-selection-menu');
    await page.locator('.pf-selmenu [data-color="green"]').click();
    await page.waitForSelector('.pdfv-mark-layer--annotations .pdfv-mark', { timeout: 4000 });
    await page.waitForSelector('.tp-s[data-m-annotations]', { timeout: 4000 });
    const marks = await page.evaluate(() => ({
      viewer: document.querySelectorAll('.pdfv-mark-layer--annotations .pdfv-mark').length,
      pane: [...document.querySelectorAll('.tp-s[data-m-annotations]')].map((e) => e.dataset.sid),
    }));
    await shot(page, 'e2e-14-highlight');
    // Click the highlight: the viewer reports 'markclick' → edit menu.
    const m = await page.locator('.pdfv-mark-layer--annotations .pdfv-mark').first().boundingBox();
    await page.mouse.click(m.x + m.width / 2, m.y + m.height / 2);
    await page.waitForSelector('.pf-selmenu--mark', { timeout: 3000 });
    await page.keyboard.press('Escape');
    await page.locator('.tab[data-tab="notes"]').click();
    await page.waitForSelector('.pf-note', { timeout: 4000 });
    const note = await page.$eval('.pf-note', (n) => ({ color: [...n.classList].find((c) => c.startsWith('pf-note--')), quote: n.querySelector('.pf-note__quote')?.textContent || n.textContent }));
    await shot(page, 'e2e-15-notes');
    const saved = await waitFor(async () => (await fileJson(page, `papers/${paperIds.lu2025}/annotations.json`))?.items?.length, 5000, 'annotations saved');
    assert(note.color === 'pf-note--green', `note colour ${note.color}`);
    assert(wordOverlap(note.quote, span.text) > 0.6, `note quote “${note.quote.slice(0, 80)}” vs selection “${span.text.slice(0, 80)}”`);
    await page.locator('.tab[data-tab="translation"]').click();
    return `selected “${span.text.slice(0, 50)}…”; ${marks.viewer} PDF mark box(es), pane sentences [${marks.pane}] marked; highlight click → edit menu (markclick); 메모 lists it (green); annotations.json has ${saved} item(s)`;
  });

  await test('채팅 (mock stream) with a sentence-citation chip that jumps', async () => {
    await page.locator('.tab[data-tab="chat"]').click();
    await page.waitForSelector('.pf-chat__input');
    await page.locator('.pf-chat__input').fill('이 연구의 주요 결과를 요약해 주세요.');
    await page.locator('[data-action="send"]').click();
    const lengths = [];
    for (let i = 0; i < 80; i++) {
      const st = await page.evaluate(() => {
        const msg = [...document.querySelectorAll('.pf-msg--assistant')].at(-1);
        return msg ? { len: msg.textContent.length, streaming: msg.classList.contains('is-streaming') } : null;
      });
      if (st) lengths.push(st.len);
      if (st && !st.streaming && st.len > 0) break;
      await sleep(60);
    }
    const chips = await page.$$eval('.pf-msg--assistant .pf-sid', (as) => as.map((a) => a.dataset.sid));
    assert(chips.length > 0, 'no sentence chips in the answer');
    assert(new Set(lengths).size >= 3, `answer did not stream (${lengths.join(',')})`);
    await page.locator('.pf-msg--assistant .pf-sid').first().click();
    const sid = chips[0];
    await expectPaneClass(page, sid, 'is-active', 4000);
    const page0 = sid.match(/^p(\d+)-/)[1];
    await page.waitForFunction((n) => document.querySelector('.tb-page-input').value === n, page0, { timeout: 4000 });
    await page.waitForSelector('.pdfv-hl--active', { timeout: 6000 });
    await shot(page, 'e2e-16-chat');
    return `answer streamed in ${lengths.length} samples (lengths ${lengths.slice(0, 4).join('→')}…${lengths.at(-1)}); chips [${chips}]; click → ${sid} active in pane, PDF on page ${page0} with active outline`;
  });

  await test('요약: generated once, aligned headings, Korean bold rendered', async () => {
    await page.locator('.tab[data-tab="summary"]').click();
    await page.locator('[data-action="generate"]').click(); // generated only on request (no paid call on first view)
    await page.waitForFunction(() => document.querySelectorAll('.pf-summary__body h2').length >= 5, null, { timeout: 15000 });
    const info = await page.evaluate(() => ({
      heads: [...document.querySelectorAll('.pf-summary__body h2')].map((h) => h.textContent.trim()),
      bold: [...document.querySelectorAll('.pf-summary__body strong')].map((b) => b.textContent),
      raw: /\*\*/.test(document.querySelector('.pf-summary__body').textContent),
      chips: document.querySelectorAll('.pf-summary__body .pf-sid').length,
    }));
    await shot(page, 'e2e-17-summary');
    assert(info.heads.join('|') === '한 줄 요약|연구 목적|연구 방법|주요 결과|제한점|임상·연구적 시사점', `headings ${info.heads}`);
    assert(info.bold.includes('41%') && !info.raw, `bold before Hangul: ${JSON.stringify(info.bold)} raw**=${info.raw}`);
    const saved = await waitFor(async () => (await fileJson(page, `papers/${paperIds.lu2025}/ai.json`))?.summary?.markdown, 5000, 'ai.summary saved');
    return `headings ${info.heads.join(' / ')}; <strong>${info.bold.join(', ')}</strong> (the **41%**에서 case); ${info.chips} sentence chips; ai.json summary saved (${saved.length} chars)`;
  });


  await test('renderMarkdown: bold next to Hangul renders, sanitizing unchanged', async () => {
    const out = await page.evaluate(async () => {
      const { renderMarkdown } = await import('/js/ui/components.js');
      const html = async (md) => {
        const box = document.createElement('div');
        box.append(await renderMarkdown(md));
        return box.innerHTML;
      };
      return {
        pct: await html('섬망은 **41%**에서 발생했다 [p3-12].'),
        paren: await html('값은**(n = 3)**이다'),
        plain: await html('**plain** text, a ** b ** c'),
        evil: await html('**<img src=x onerror=alert(1)>**에서 **[링크](javascript:alert(1))**로 <script>alert(1)</script>'),
        evilDom: await (async () => {
          const box = document.createElement('div');
          box.append(await renderMarkdown('**<img src=x onerror=alert(1)>**에서 **[링크](javascript:alert(1))**로 <script>alert(1)</script>'));
          return { elements: box.querySelectorAll('img, script, [onerror]').length, jsHref: [...box.querySelectorAll('a')].some((a) => /javascript:/i.test(a.getAttribute('href') || '')) };
        })(),
      };
    });
    assert(/<strong>41%<\/strong>에서/.test(out.pct) && /class="sid-link"/.test(out.pct), out.pct);
    assert(/<strong>\(n = 3\)<\/strong>이다/.test(out.paren), out.paren);
    assert(/<strong>plain<\/strong>/.test(out.plain) && /a \*\* b \*\* c/.test(out.plain), out.plain);
    // Raw HTML in model output is shown as text (escaped), never as elements.
    assert(out.evilDom.elements === 0 && !out.evilDom.jsHref && !/<script|<img|javascript:/i.test(out.evil), out.evil);
    return `“**41%**에서” → ${out.pct.match(/<strong>[^<]*<\/strong>에서/)[0]}; “**(n = 3)**이다” bold; “a ** b ** c” left alone; hostile input → ${out.evil.replace(/\s+/g, ' ').slice(0, 90)}`;
  });
  await test('핵심 밑줄: key points underlined on the PDF and in the pane', async () => {
    await page.locator('.tab[data-tab="translation"]').click();
    await page.locator('[data-feature="auto-highlight"]').click();
    await page.waitForFunction(() => document.querySelectorAll('.pdfv-mark-layer--auto .pdfv-mark').length > 0 || document.querySelectorAll('.tp-s[data-m-auto]').length > 0, null, { timeout: 15000 });
    await gotoPage(page, 1);
    const n = await page.evaluate(() => ({
      pdf: document.querySelectorAll('.pdfv-mark-layer--auto .pdfv-mark').length,
      pane: document.querySelectorAll('.tp-s[data-m-auto]').length,
      pressed: document.querySelector('[data-feature="auto-highlight"]').getAttribute('aria-pressed'),
    }));
    assert(n.pane > 0 && n.pressed === 'true', JSON.stringify(n));
    await shot(page, 'e2e-18-keypoints');
    const saved = await waitFor(async () => (await fileJson(page, `papers/${paperIds.lu2025}/ai.json`))?.keyPoints?.items?.length, 5000, 'keyPoints saved');
    return `${n.pane} pane sentences underlined, ${n.pdf} PDF underline boxes on rendered pages, toggle pressed; ai.keyPoints has ${saved} items`;
  });

  await test('그림·표 설명: region capture → streamed image explanation card', async () => {
    await gotoPage(page, 1);
    await page.locator('[data-feature="explain-region"]').click();
    await page.waitForFunction(() => document.querySelector('.pdfv-capturing'));
    const pb = await page.locator('.pdfv-page[data-page="1"]').boundingBox();
    const v = await page.locator('.viewer-host').boundingBox();
    const x0 = pb.x + pb.width * 0.08;
    const y0 = Math.max(pb.y, v.y) + 140;
    await page.mouse.move(x0, y0);
    await page.mouse.down();
    await page.mouse.move(x0 + 200, y0 + 90, { steps: 8 });
    await page.mouse.move(x0 + 420, y0 + 220, { steps: 8 });
    await page.mouse.up();
    await page.waitForSelector('.pf-card', { timeout: 5000 });
    await page.waitForFunction(() => (document.querySelector('.pf-card .pf-explain__answer')?.textContent || '').length > 40
      && !document.querySelector('.pf-card.is-streaming'), null, { timeout: 15000 });
    const card = await page.evaluate(() => ({
      img: document.querySelector('.pf-card img')?.src?.slice(0, 22) || '',
      text: document.querySelector('.pf-card .pf-explain__answer').textContent.slice(0, 60),
      capturing: Boolean(document.querySelector('.pdfv-capturing')),
    }));
    await shot(page, 'e2e-19-region-explain');
    await page.keyboard.press('Escape');
    const saved = await waitFor(async () => (await fileJson(page, `papers/${paperIds.lu2025}/ai.json`))?.explanations?.length, 6000, 'explanation saved');
    return `card image ${card.img}…, answer “${card.text}…”, capture mode after: ${card.capturing}; ai.explanations ${saved}`;
  });

  await test('citation / internal-link previews on lu2025 (reference card + region preview)', async () => {
    const pdfB64 = readFileSync(fixture('lu2025')).toString('base64');
    // Link rectangles straight from the PDF (pdf.js in the page), in PDF units at scale 1, top-left origin.
    const links = await page.evaluate(async (b64) => {
      const { getPdfjs } = await import('/js/pdf/pdfjs.js');
      const lib = await getPdfjs();
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const pdf = await lib.getDocument({ data: bytes }).promise;
      const out = [];
      for (let n = 2; n <= 6; n++) {
        const pg = await pdf.getPage(n);
        const vp = pg.getViewport({ scale: 1 });
        for (const a of await pg.getAnnotations()) {
          if (a.subtype !== 'Link' || !a.dest) continue;
          const [x1, y1, x2, y2] = vp.convertToViewportRectangle(a.rect);
          out.push({ page: n, x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1), vw: vp.width });
        }
      }
      await pdf.destroy();
      return out;
    }, pdfB64);
    assert(links.length > 10, `only ${links.length} internal links on pages 2–6`);
    const seen = {};
    let tries = 0;
    for (const l of links) {
      if (seen.ref && seen.preview) break;
      if (tries++ > 30) break;
      await gotoPage(page, l.page);
      await page.evaluate(({ page: n, y, vw }) => {
        const el = document.querySelector(`.pdfv-page[data-page="${n}"]`);
        const k = el.getBoundingClientRect().width / vw;
        const host = document.querySelector('.viewer-host');
        host.scrollTop = el.offsetTop + y * k - host.clientHeight / 2;
      }, l);
      await sleep(350);
      const pt = await page.evaluate(({ page: n, x, y, w, h, vw }) => {
        const r = document.querySelector(`.pdfv-page[data-page="${n}"]`).getBoundingClientRect();
        const k = r.width / vw;
        return { x: r.left + (x + w / 2) * k, y: r.top + (y + h / 2) * k };
      }, l);
      await page.mouse.move(pt.x - 60, pt.y + 30);
      await page.mouse.move(pt.x, pt.y, { steps: 4 });
      const kind = await page.waitForSelector('.pf-pop--cite', { timeout: 1500 })
        .then(() => page.evaluate(() => (document.querySelector('.pf-cite--ref') ? 'ref' : document.querySelector('.pf-cite--preview') ? 'preview' : 'other')))
        .catch(() => null);
      if (kind && !seen[kind]) {
        if (kind === 'preview') await page.waitForSelector('.pf-cite__canvas', { timeout: 5000 });
        seen[kind] = await page.evaluate(() => document.querySelector('.pf-pop--cite').textContent.replace(/\s+/g, ' ').slice(0, 90));
        await shot(page, `e2e-20-cite-${kind}`);
      }
      await page.mouse.move(5, 300);
      await page.waitForFunction(() => !document.querySelector('.pf-pop--cite'), null, { timeout: 2000 }).catch(() => {});
    }
    assert(seen.ref, 'no reference card shown');
    assert(seen.preview, 'no region preview shown');
    return `${links.length} internal links on pp.2–6 (pdf.js); reference card “${seen.ref}”; preview “${seen.preview}”`;
  });

  await test('settings: save, then restore after reload (provider not persisted as mock)', async () => {
    await page.locator('.reader-toolbar button[aria-label="설정"]').click();
    await page.waitForSelector('.settings');
    await page.locator('.settings button', { hasText: '용어 추가' }).click();
    await page.locator('[aria-label="1번 영어 용어"]').fill('delirium');
    await page.locator('[aria-label="1번 한국어 번역어"]').fill('섬망');
    await page.locator('input[aria-label="참고문헌도 번역"]').click();
    await page.locator('select[aria-label="동시 요청 수"]').selectOption('4');
    await page.evaluate(() => {
      const r = document.querySelector('input[aria-label="번역 글자 크기"]');
      r.value = '17';
      r.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.locator('.settings .segmented button', { hasText: '어둡게' }).click();
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
    await sleep(700); // glossary (400 ms) and font size (150 ms) saves are debounced
    await shot(page, 'e2e-21-settings-dark');
    await page.reload();
    await page.waitForSelector('.settings');
    const ui = await page.evaluate(() => ({
      gloss: [document.querySelector('[aria-label="1번 영어 용어"]')?.value, document.querySelector('[aria-label="1번 한국어 번역어"]')?.value],
      refs: document.querySelector('input[aria-label="참고문헌도 번역"]').checked,
      conc: document.querySelector('select[aria-label="동시 요청 수"]').value,
      size: document.querySelector('input[aria-label="번역 글자 크기"]').value,
      theme: document.documentElement.dataset.theme,
      fontVar: getComputedStyle(document.documentElement).getPropertyValue('--tp-font-size').trim(),
      stored: JSON.parse(localStorage.getItem('pr.settings.v1')),
    }));
    assert(ui.gloss.join('=') === 'delirium=섬망' && ui.refs && ui.conc === '4' && ui.size === '17' && ui.theme === 'dark' && ui.fontVar === '17px', JSON.stringify(ui));
    assert(ui.stored.provider !== 'mock', `provider persisted as ${ui.stored.provider}`);
    // Restore the defaults the rest of the run expects.
    await page.locator('input[aria-label="참고문헌도 번역"]').click();
    await page.locator('.settings .segmented button', { hasText: '밝게' }).click();
    await page.evaluate(() => {
      const r = document.querySelector('input[aria-label="번역 글자 크기"]');
      r.value = '15';
      r.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await sleep(300);
    return `after reload: glossary ${ui.gloss.join(' = ')}, 참고문헌 번역 ${ui.refs}, 동시 요청 ${ui.conc}, 글자 ${ui.size}px (--tp-font-size ${ui.fontVar}), theme ${ui.theme}; stored provider “${ui.stored.provider}” (mock stays session-only)`;
  });

  await test('reload on #/paper/<id>: same paper reopens, translations + annotations persist, no re-translation', async () => {
    await page.goto(`${APP}#/paper/${encodeURIComponent(paperIds.lu2025)}`);
    await waitForReader(page);
    await page.reload();
    await waitForReader(page);
    await page.waitForFunction(() => document.querySelectorAll('.tp-s.is-translated').length > 400, null, { timeout: 10000 });
    const st = await page.evaluate(async () => {
      const { mockControl } = await import('/js/ai/mock.js');
      return {
        hash: location.hash,
        title: document.querySelector('.tb-title').textContent,
        translated: document.querySelectorAll('.tp-s.is-translated').length,
        label: document.querySelector('.tb-tr-main .btn-label').textContent,
        annotated: [...document.querySelectorAll('.tp-s[data-m-annotations]')].map((e) => e.dataset.sid),
        auto: document.querySelectorAll('.tp-s[data-m-auto]').length,
        translateCalls: mockControl.requests.filter((r) => r.task === 'translate').length,
      };
    });
    assert(st.translated === 448 && st.label === '번역 완료' && st.annotated.length > 0 && st.translateCalls === 0, JSON.stringify(st));
    await shot(page, 'e2e-22-reloaded');
    return `${st.hash} → “${st.title.slice(0, 40)}…”, ${st.translated} translated spans, button “${st.label}”, annotations on [${st.annotated}], ${st.auto} key-point sentences, ${st.translateCalls} translate calls after reload`;
  });

  await test('regression untranslated-counted-done (reader): a stored translation that is still English opens as failed with 다시 시도; the retry translates it', async () => {
    const path = `papers/${paperIds.lu2025}/translation.json`;
    // What an older version saved for a front-matter line the model left in English (kept as done, with a warning).
    const sid = await page.evaluate(async (path) => {
      const idb = await new Promise((res, rej) => { const r = indexedDB.open('paper-reader'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
      const rec = await new Promise((res, rej) => { const g = idb.transaction('files').objectStore('files').get(path); g.onsuccess = () => res(g.result); g.onerror = () => rej(g.error); });
      const file = JSON.parse(typeof rec.data === 'string' ? rec.data : new TextDecoder().decode(rec.data));
      const [id, item] = Object.entries(file.items).find(([, it]) => /^〔번역〕 [A-Z][a-z]+ [a-z]+ [a-z]+ [a-z]+/.test(it.t));
      item.t = item.t.replace(/^〔번역〕 /, '');
      item.w = 'untranslated';
      await new Promise((res, rej) => {
        const tx = idb.transaction('files', 'readwrite');
        tx.objectStore('files').put({ ...rec, data: JSON.stringify(file), dirty: 1, mtime: Date.now() }, path);
        tx.oncomplete = res; tx.onerror = () => rej(tx.error);
      });
      idb.close();
      return id;
    }, path);
    await page.reload();
    await waitForReader(page);
    const span = page.locator(`.tp-s.is-failed[data-sid="${sid}"]`);
    await span.waitFor({ timeout: 10000 });
    const before = await page.evaluate((sid) => ({
      translated: document.querySelectorAll('.tp-s.is-translated').length,
      failed: [...document.querySelectorAll('.tp-s.is-failed')].map((e) => e.dataset.sid),
      retry: Boolean(document.querySelector(`.tp-s[data-sid="${sid}"] .tp-retry`)),
      lang: document.querySelector(`.tp-s[data-sid="${sid}"]`).getAttribute('lang'),
      status: document.querySelector('.tp-header-status')?.textContent || '',
    }), sid);
    assert(before.translated === 447 && before.failed.length === 1 && before.failed[0] === sid && before.retry && before.lang === 'en', JSON.stringify(before));
    await shot(page, 'e2e-23-english-failed');
    await span.locator('.tp-retry').click();
    await page.waitForFunction((sid) => document.querySelector(`.tp-s.is-translated[data-sid="${sid}"]`), sid, { timeout: 10000 });
    const after = await page.evaluate(async (sid) => {
      const { mockControl } = await import('/js/ai/mock.js');
      const out = {
        text: document.querySelector(`.tp-s[data-sid="${sid}"]`).textContent,
        failed: document.querySelectorAll('.tp-s.is-failed').length,
        sent: mockControl.requests.filter((r) => r.task === 'translate').map((r) => r.ids),
      };
      mockControl.reset(); // later tests count this page's translate calls from zero (as after a reload)
      return out;
    }, sid);
    assert(/^〔번역〕/.test(after.text) && after.failed === 0 && JSON.stringify(after.sent) === JSON.stringify([[sid]]), JSON.stringify(after));
    const saved = await waitFor(async () => {
      const f = await fileJson(page, path);
      return f?.items?.[sid]?.t?.startsWith('〔번역〕') ? f.items[sid] : null;
    }, 8000, 'retried translation saved');
    return `${sid} opened as failed (lang=en, 다시 시도, status “${before.status.trim()}”); retry sent only [${after.sent}] → “${after.text.slice(0, 40)}…”, saved without warning=${!saved.w}`;
  });

  // -------------------------------------------------------------------------------- sync

  /** Fill the GitHub form in 설정 and press 저장하고 동기화 시작. */
  async function enableSync(p) {
    await p.goto(`${APP}#/settings`);
    await p.waitForSelector('.settings');
    await p.locator('input[aria-label="소유자 (사용자 이름)"]').fill(OWNER);
    await p.locator('input[aria-label="저장소 이름"]').fill(REPO);
    await p.locator('input[aria-label="GitHub 토큰"]').fill(TOKEN);
    await p.locator('.settings button', { hasText: '저장하고 동기화 시작' }).click();
    await p.waitForFunction(() => [...document.querySelectorAll('.test-result')].some((e) => /저장했습니다/.test(e.textContent)), null, { timeout: 20000 });
  }

  await test('sync: device A pushes library, PDFs, translation, annotations and AI data to the private repo', async () => {
    await enableSync(page);
    await waitFor(() => repoHas(`papers/${paperIds.lu2025}/annotations.json`) && repoHas('library.json')
      && repoHas(`papers/${paperIds.cohen1960}/paper.pdf`), 30000, 'A pushed everything');
    await page.goto(`${APP}#/`);
    await page.waitForFunction(() => /동기화 완료/.test(document.querySelector('.lib-sync')?.textContent || ''), null, { timeout: 20000 });
    const lu = paperIds.lu2025;
    const files = [...fake.files(OWNER, REPO).keys()].sort();
    const tr = repoJson(`papers/${lu}/translation.json`);
    const ann = repoJson(`papers/${lu}/annotations.json`);
    const ai = repoJson(`papers/${lu}/ai.json`);
    const lib = repoJson('library.json');
    // 448 translatable sentences; ones that are only a URL/DOI are shown as is and not stored.
    assert(Object.keys(tr.items).length >= 440 && Object.keys(tr.items).length <= 448 && ann.items.length === 1 && ai.summary && ai.keyPoints,
      `repo contents: ${Object.keys(tr.items).length} translation items, ${ann.items.length} annotations, ai keys ${Object.keys(ai)}`);
    assert(lib.papers.length === 3 && lib.folders.length === 4, `library.json ${lib.papers.length} papers ${lib.folders.length} folders`);
    await shot(page, 'e2e-23-sync-A');
    return `${files.length} files in me/${REPO}: ${files.map((f) => f.replace(/papers\/[^/]+\//, 'papers/…/')).filter((v, i, a) => a.indexOf(v) === i).join(', ')}; translation.json ${Object.keys(tr.items).length} items, annotations ${ann.items.length}, ai keys [${Object.keys(ai).join(',')}]; ${fake.commits(OWNER, REPO).length} commit(s)`;
  });

  let B = null;
  await test('sync: device B (fresh browser) sees the library, PDF fetched lazily, cached translation + annotations, no re-translation', async () => {
    B = await device('B', { github: true });
    const pb = B.page;
    await openLibrary(pb);
    await enableSync(pb);
    await pb.goto(`${APP}#/`);
    await pb.waitForFunction(() => document.querySelectorAll('.paper-row').length === 3, null, { timeout: 30000 });
    const folders = await pb.$$eval('.tree-item.is-folder .tree-label', (els) => els.map((e) => e.textContent));
    const lu = paperIds.lu2025;
    const pdfSha = fake.files(OWNER, REPO).get(`papers/${lu}/paper.pdf`).sha;
    const blobGets = () => fake.log.filter((e) => e.method === 'GET' && e.path.endsWith(`/git/blobs/${pdfSha}`)).length;
    const before = blobGets();
    await pb.goto(`${APP}#/paper/${encodeURIComponent(lu)}`);
    await waitForReader(pb);
    await pb.waitForFunction(() => document.querySelectorAll('.tp-s.is-translated').length === 448, null, { timeout: 15000 });
    await pb.waitForSelector('.tp-s[data-m-annotations]', { timeout: 10000 });
    await gotoPage(pb, 2);
    await pb.waitForSelector('.pdfv-mark-layer--annotations .pdfv-mark', { timeout: 8000 });
    await pb.locator('.tab[data-tab="summary"]').click();
    await pb.waitForFunction(() => document.querySelectorAll('.pf-summary__body h2').length >= 5, null, { timeout: 10000 });
    const st = await pb.evaluate(async () => {
      const { mockControl } = await import('/js/ai/mock.js');
      return {
        label: document.querySelector('.tb-tr-main .btn-label').textContent,
        calls: mockControl.requests.map((r) => r.task),
      };
    });
    const after = blobGets();
    await shot(pb, 'e2e-24-sync-B-reader');
    assert(before === 0 && after === 1, `PDF blob GETs before open ${before}, after ${after}`);
    assert(st.label === '번역 완료' && st.calls.length === 0, `B made AI calls: ${st.calls}`);
    return `B library: 3 papers, folders [${folders}]; lu2025 PDF blob GETs ${before} → ${after} on open; 448 cached translations shown, annotation marks on PDF + pane, cached 요약 shown; AI calls on B: ${st.calls.length}`;
  });


  await test('sync: sentences translated on B appear in A\'s open reader without re-translating', async () => {
    const c = paperIds.cohen1960;
    await page.goto(`${APP}#/paper/${encodeURIComponent(c)}`);
    await waitForReader(page);
    const before = await page.evaluate(() => document.querySelectorAll('.tp-s.is-translated').length);
    const pb = B.page;
    await pb.goto(`${APP}#/paper/${encodeURIComponent(c)}`);
    await waitForReader(pb);
    await pb.locator('.tb-tr-main').click();
    await pb.waitForFunction(() => document.querySelector('.tb-tr-main .btn-label')?.textContent === '번역 완료', null, { timeout: 60000 });
    const onB = await pb.evaluate(() => document.querySelectorAll('.tp-s.is-translated').length);
    await waitFor(() => repoHas(`papers/${c}/translation.json`), 20000, 'B pushed translation.json');
    // A gets the change on its next pull; a window focus is what triggers it for a user coming back.
    const t0 = Date.now();
    await waitFor(async () => {
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      return page.evaluate((n) => document.querySelectorAll('.tp-s.is-translated').length >= n, onB);
    }, 45000, 'A shows B\'s translations');
    const st = await page.evaluate(async () => {
      const { mockControl } = await import('/js/ai/mock.js');
      return {
        translated: document.querySelectorAll('.tp-s.is-translated').length,
        label: document.querySelector('.tb-tr-main .btn-label').textContent,
        calls: mockControl.requests.filter((r) => r.task === 'translate').length,
      };
    });
    await shot(page, 'e2e-26-live-merge-A');
    assert(st.label === '번역 완료' && st.calls === 0, `A button ${st.label}, A translate calls ${st.calls}`);
    return `cohen1960: A showed ${before} translated, B translated ${onB}; A's open pane updated to ${st.translated} after a focus-triggered pull (${Math.round((Date.now() - t0) / 1000)} s), button “${st.label}”, A translate calls ${st.calls}`;
  });
  await test('sync: a delete on B propagates to A', async () => {
    const pb = B.page;
    const k = paperIds.kiekkas2012;
    await pb.goto(`${APP}#/`);
    await pb.waitForSelector(`.paper-row[data-id="${k}"]`);
    await pb.locator(`.paper-row[data-id="${k}"] button[aria-label="논문 메뉴"]`).click();
    await pb.locator('.menu .menu-item', { hasText: '삭제' }).click();
    await confirmModal(pb, '삭제');
    await pb.waitForFunction((id) => !document.querySelector(`.paper-row[data-id="${id}"]`), k);
    await waitFor(() => repoJson('library.json').papers.find((p) => p.id === k)?.deleted === true, 20000, 'B pushed the tombstone');
    const pdfGone = !repoHas(`papers/${k}/paper.pdf`);
    // A: 지금 동기화 from the library chip.
    await page.goto(`${APP}#/`);
    await page.waitForSelector(`.paper-row[data-id="${k}"]`).catch(() => {});
    await page.locator('.lib-sync').click();
    await page.waitForFunction((id) => !document.querySelector(`.paper-row[data-id="${id}"]`), k, { timeout: 20000 });
    const rows = await rowTitles(page);
    const localPdf = await fileJson(page, `papers/${k}/annotations.json`);
    await shot(page, 'e2e-25-sync-A-after-delete');
    return `B deleted kiekkas2012 → library.json tombstone pushed, repo paper.pdf removed=${pdfGone}; A after 지금 동기화 lists [${rows.map((t) => t.slice(0, 30))}]; A local annotations for it: ${localPdf === null ? 'none' : 'present'}`;
  });
  await B?.ctx.close();

  // ------------------------------------------------------------------------- visual QA

  await test('visual QA matrix: library / reader (나란히 + hover) / overlay / settings × light, dark × 1440×900, 1024×768', async () => {
    const files = [];
    const setTheme = (theme) => page.evaluate((theme) => {
      const s = JSON.parse(localStorage.getItem('pr.settings.v1') || '{}');
      s.ui = { ...(s.ui || {}), theme };
      localStorage.setItem('pr.settings.v1', JSON.stringify(s));
    }, theme);
    const overflow = [];
    const checkOverflow = async (label) => {
      const o = await page.evaluate(() => ({ w: document.documentElement.scrollWidth, vw: innerWidth }));
      if (o.w > o.vw + 1) overflow.push(`${label}: ${o.w}>${o.vw}`);
    };
    for (const theme of ['light', 'dark']) {
      await setTheme(theme);
      for (const [w, h] of [[1440, 900], [1024, 768]]) {
        await page.setViewportSize({ width: w, height: h });
        const tag = `${theme}-${w}`;
        await page.goto(`${APP}#/`);
        await page.reload();
        await page.waitForSelector('.paper-row');
        await page.waitForFunction((t) => document.documentElement.dataset.theme === t, theme);
        await sleep(300);
        await shot(page, `qa-${tag}-library`); files.push(`qa-${tag}-library`);
        await checkOverflow(`${tag} library`);

        await page.goto(`${APP}#/paper/${encodeURIComponent(paperIds.lu2025)}`);
        await waitForReader(page);
        await page.locator('.tab[data-tab="translation"]').click();
        await gotoPage(page, 1);
        const sid = await page.evaluate(() => {
          const hr = document.querySelector('.tp-host').getBoundingClientRect();
          return [...document.querySelectorAll('.tp-s.tp-kind-body[data-sid^="p1-"]')]
            .find((s) => { const r = s.getClientRects()[0]; return r && r.top > hr.top + 60 && r.bottom < hr.bottom - 20; })?.dataset.sid;
        });
        if (sid) await hoverPaneSpan(page, sid);
        await sleep(250);
        await shot(page, `qa-${tag}-reader-hover`); files.push(`qa-${tag}-reader-hover`);
        await checkOverflow(`${tag} reader`);

        await page.locator('.segmented button', { hasText: '번역 겹쳐보기' }).click();
        await page.waitForSelector('.pdfv-tsent', { timeout: 8000 });
        await sleep(500);
        await page.mouse.move(5, h - 5);
        await shot(page, `qa-${tag}-overlay`); files.push(`qa-${tag}-overlay`);
        await page.locator('.segmented button', { hasText: '나란히' }).click();

        await page.goto(`${APP}#/settings`);
        await page.waitForSelector('.settings');
        await sleep(200);
        await shot(page, `qa-${tag}-settings`); files.push(`qa-${tag}-settings`);
        await checkOverflow(`${tag} settings`);
      }
    }
    await setTheme('light');
    await page.setViewportSize({ width: 1440, height: 900 });
    assert(!overflow.length, `horizontal page overflow: ${overflow.join(', ')}`);
    return `${files.length} screenshots (qa-*.png); no horizontal page overflow`;
  });
} finally {
  writeFileSync(`${OUT}/e2e-results.json`, JSON.stringify({ results, problems, external }, null, 2));
  await browser.close();
  await fake.close?.();
  server?.kill();
  const failed = results.filter((r) => r.result === 'fail').length;
  console.log(`\n${results.length - failed}/${results.length} passed${problems.length ? `; problems: ${problems.length}` : ''}`);
  process.exitCode = failed ? 1 : 0;
}
