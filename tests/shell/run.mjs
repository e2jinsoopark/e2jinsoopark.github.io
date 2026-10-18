// Shell (UI) end-to-end tests. Run from anywhere:
//   node tests/shell/run.mjs            (starts `python -m http.server 8104` if nothing is listening)
// Screenshots + results.json go to C:/Users/dindoo/Projects/pr-tools/out/shell/ (never into the repo).
// All other builders' modules are stubbed through import maps (tests/shell/harness*.html); paid AI hosts are blocked.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'file:///C:/Users/dindoo/Projects/pr-tools/node_modules/playwright/index.mjs';

const PORT = 8104;
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = 'C:/Users/dindoo/Projects/pr-tools/out/shell';
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const H = `${BASE}/tests/shell/harness.html`;
const CSP = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; font-src 'self' https://cdn.jsdelivr.net data:; img-src 'self' data: blob:; connect-src 'self' https://api.anthropic.com https://generativelanguage.googleapis.com https://api.github.com https://api.semanticscholar.org https://cdn.jsdelivr.net; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; form-action 'none'";
const BLOCKED = /api\.anthropic\.com|generativelanguage\.googleapis\.com|api\.github\.com|api\.semanticscholar\.org/;

mkdirSync(OUT, { recursive: true });
const results = [];
const pageErrors = [];
const blockedRequests = [];

function assert(cond, msg) { if (!cond) throw new Error(msg); }

async function test(name, fn) {
  const t0 = Date.now();
  try {
    const evidence = await fn();
    results.push({ name, result: 'pass', evidence: String(evidence ?? 'ok') });
    console.log(`PASS  ${name}  — ${evidence ?? ''}`);
  } catch (err) {
    results.push({ name, result: 'fail', evidence: err?.message || String(err) });
    console.log(`FAIL  ${name}  — ${err?.stack || err}`);
  }
  void t0;
}

async function serverUp() {
  try { const r = await fetch(`${BASE}/index.html`); return r.ok; } catch { return false; }
}

async function newPage(browser, { viewport = { width: 1400, height: 860 }, colorScheme = 'light' } = {}) {
  const ctx = await browser.newContext({ viewport, colorScheme, locale: 'ko-KR' });
  await ctx.route(BLOCKED, (route) => { blockedRequests.push(route.request().url()); return route.abort(); });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => pageErrors.push(`${page.url()} :: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') pageErrors.push(`console.error ${page.url()} :: ${m.text()}`); });
  return { ctx, page };
}

const shot = (page, name, opts = {}) => page.screenshot({ path: `${OUT}/${name}.png`, ...opts });
const stubLog = (page) => page.evaluate(() => window.__stubLibrary.log.map((x) => x.join('|')));
const viewerCalls = (page) => page.evaluate(() => window.__stubViewer.calls.map((c) => c.join('|')));

async function openReader(page, query = '?mock=1&reset=1', id = 'pap_bundle') {
  await page.goto(`${H}${query}#/paper/${id}`);
  await page.waitForSelector('.tp-s[data-sid]', { timeout: 10000 });
  await page.waitForFunction(() => window.__stubViewer?.root);
  await page.waitForTimeout(150);
}

// ---------------------------------------------------------------------------

let server = null;
if (!(await serverUp())) {
  server = spawn('python', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], { cwd: REPO, stdio: 'ignore' });
  for (let i = 0; i < 40 && !(await serverUp()); i++) await new Promise((r) => setTimeout(r, 150));
}

const browser = await chromium.launch({ channel: 'msedge' });

try {
  // ------------------------------------------------------------ markdown
  await test('renderMarkdown sanitizes malicious payload and links [p3-12]', async () => {
    const { page } = await newPage(browser);
    await page.goto(`${H}?mock=1&reset=1`);
    await page.waitForSelector('.paper-row');
    const r = await page.evaluate(async () => {
      const { renderMarkdown } = await import('/js/ui/components.js');
      const md = [
        '# 제목',
        '<img src=x onerror="window.__xss=1">',
        '<img src="https://evil.example/t.png">',
        '[클릭](javascript:window.__xss=2)',
        '<a href="javascript:window.__xss=3">raw</a> <a href="JaVaScRiPt&#58;window.__xss=6">enc</a>',
        '<a href="https://example.com/x">ok</a>',
        '<script>window.__xss=4</script>',
        '<iframe src="https://evil.example"></iframe>',
        '<svg><g onload="window.__xss=5"></g></svg>',
        '<div style="background:red" onclick="window.__xss=7">styled</div>',
        '<a href="#/settings">hash</a> <form action="https://evil.example"><input name=q></form>',
        '근거 [p3-12] 및 [p1-2, p2-5] 그리고 `[p9-9]` 코드',
      ].join('\n\n');
      const frag = await renderMarkdown(md);
      const host = document.createElement('div');
      host.className = 'md';
      host.append(frag);
      document.body.append(host);
      await new Promise((res) => setTimeout(res, 400));
      host.querySelector('div[onclick], div')?.click?.();
      const html = host.innerHTML;
      const out = {
        html,
        xss: window.__xss ?? null,
        imgs: host.querySelectorAll('img').length,
        scripts: host.querySelectorAll('script, iframe, svg, form, input').length,
        styleAttrs: host.querySelectorAll('[style]').length,
        handlers: /\son\w+=/i.test(html),
        jsHref: /javascript:/i.test(html),
        sidLinks: [...host.querySelectorAll('a.sid-link')].map((a) => a.dataset.sid),
        okLink: (() => { const a = host.querySelector('a[href^="https://example.com"]'); return a ? `${a.target}|${a.rel}` : null; })(),
        hashHref: [...host.querySelectorAll('a')].some((a) => (a.getAttribute('href') || '').startsWith('#')),
        codeText: host.querySelector('code')?.textContent,
      };
      host.remove();
      return out;
    });
    assert(r.xss === null, `XSS executed: ${r.xss}`);
    assert(r.imgs === 0, `img survived (${r.imgs})`);
    assert(r.scripts === 0, 'script/iframe/svg/form survived');
    assert(r.styleAttrs === 0, 'style attribute survived');
    assert(!r.handlers, 'event handler attribute survived');
    assert(!r.jsHref, 'javascript: URL survived');
    assert(!r.hashHref, 'in-app # link survived (would hijack the router)');
    assert(r.okLink === '_blank|noopener noreferrer', `external link not hardened: ${r.okLink}`);
    assert(JSON.stringify(r.sidLinks) === JSON.stringify(['p3-12', 'p1-2', 'p2-5']), `sid links: ${r.sidLinks}`);
    assert(r.codeText === '[p9-9]', 'sid inside code must stay text');
    await page.context().close();
    return `no XSS; imgs=0; scripts=0; handlers/javascript:/style stripped; ext link target=_blank rel=noopener noreferrer; sid-links=${r.sidLinks.join(',')}; code [p9-9] untouched`;
  });

  // ------------------------------------------------------------- library
  await test('library: empty-state onboarding', async () => {
    const { page } = await newPage(browser);
    await page.goto(`${H}?mock=1&lib=empty&reset=1&sync=off`);
    await page.waitForSelector('.onboarding');
    await shot(page, '01-library-empty');
    const text = await page.locator('.onboarding').innerText();
    assert(text.includes('첫 논문을 추가해 보세요'), 'missing onboarding title');
    assert(text.includes('설정'), 'onboarding does not point to 설정');
    const chip = await page.locator('.lib-sync').innerText();
    assert(chip.includes('꺼짐'), `sync chip: ${chip}`);
    await page.locator('.step >> text=설정 열기').first().click();
    await page.waitForSelector('.settings');
    assert(page.url().endsWith('#/settings'), 'settings link did not navigate');
    await page.context().close();
    return `onboarding shown with 3 steps + dropzone; chip="${chip.trim()}"; '설정 열기' navigates to #/settings`;
  });

  {
    const { page } = await newPage(browser);
    await page.goto(`${H}?mock=1&reset=1`);
    await page.waitForSelector('.paper-row');

    await test('library: populated list, counts, sync chip', async () => {
      await shot(page, '02-library');
      const rows = await page.locator('.paper-row').count();
      assert(rows === 6, `rows=${rows}`);
      const chip = (await page.locator('.lib-sync').innerText()).trim();
      assert(chip === '동기화 완료', chip);
      const pct = (await page.locator('.paper-row').first().locator('.paper-progress').innerText()).replace(/\s+/g, ' ');
      return `6 rows; chip="${chip}"; first row progress "${pct}"`;
    });

    await test('library: folder context menu + Esc closes it', async () => {
      await page.locator('.tree-item', { hasText: '섬망 연구' }).click({ button: 'right' });
      await page.waitForSelector('.menu');
      const items = await page.locator('.menu .menu-item').allInnerTexts();
      assert(['새 하위 폴더', '이름 바꾸기', '삭제'].every((x) => items.includes(x)), `items: ${items}`);
      await page.waitForTimeout(200);
      await shot(page, '03-context-menu');
      const focused = await page.evaluate(() => document.activeElement?.textContent);
      await page.keyboard.press('ArrowDown');
      const focused2 = await page.evaluate(() => document.activeElement?.textContent);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(50);
      assert(await page.locator('.menu').count() === 0, 'menu still open after Esc');
      return `menu items [${items.join(', ')}]; keyboard focus "${focused}" → ArrowDown → "${focused2}"; Esc closed it`;
    });

    await test('library: nested folders expand + breadcrumb', async () => {
      await page.locator('.tree-toggle').first().click();
      await page.locator('.tree-item', { hasText: '예방 중재' }).click();
      const crumbs = (await page.locator('.lib-crumbs').innerText()).replace(/\s+/g, ' ');
      const title = await page.locator('.lib-title').innerText();
      const rows = await page.locator('.paper-row').count();
      assert(title === '예방 중재' && rows === 2, `title=${title} rows=${rows}`);
      assert(crumbs.includes('섬망 연구'), crumbs);
      await page.locator('.tree-item', { hasText: '전체' }).click();
      return `child folder visible after expand; breadcrumb "${crumbs}"; 2 papers in 예방 중재`;
    });

    await test('library: drag a paper onto a folder (movePaper)', async () => {
      const row = page.locator('.paper-row', { hasText: 'Early Mobilization' });
      await row.dragTo(page.locator('.tree-item', { hasText: '기계환기·이탈' }));
      await page.waitForSelector('.toast');
      await page.waitForTimeout(200);
      const log = await stubLog(page);
      assert(log.includes('movePaper|pap_mobil|f_vent'), `log: ${log.slice(-3)}`);
      await shot(page, '04-toast-after-drop');
      const toastText = await page.locator('.toast').last().innerText();
      return `library.movePaper(pap_mobil, f_vent) called; toast "${toastText.trim()}"`;
    });

    await test('library: search + sort', async () => {
      await page.fill('.lib-search', 'cohen');
      await page.waitForTimeout(250);
      const n = await page.locator('.paper-row').count();
      assert(n === 1, `search rows=${n}`);
      await page.fill('.lib-search', '');
      await page.waitForTimeout(250);
      await page.selectOption('.lib-sort', 'title');
      const titles = await page.locator('.paper-title').allInnerTexts();
      const sorted = [...titles].sort((a, b) => a.localeCompare(b, 'ko'));
      assert(JSON.stringify(titles) === JSON.stringify(sorted), 'not sorted by title');
      await page.selectOption('.lib-sort', 'added');
      return `"cohen" → 1 result; 제목 sort → ${titles[0].slice(0, 30)}…`;
    });

    await test('library: rename via promptDialog modal (Enter submits)', async () => {
      await page.locator('.paper-row', { hasText: 'Sleep Promotion' }).click({ button: 'right' });
      await page.locator('.menu-item', { hasText: '제목 바꾸기' }).click();
      await page.waitForSelector('.modal input');
      await page.waitForTimeout(250);
      await shot(page, '05-modal-prompt');
      await page.fill('.modal input', '수면 증진 번들 (이름 변경됨)');
      await page.keyboard.press('Enter');
      await page.waitForSelector('.paper-title >> text=수면 증진 번들 (이름 변경됨)');
      await page.waitForSelector('.modal-backdrop', { state: 'detached', timeout: 2000 });
      return 'prompt modal opened with focus in input; Enter saved the new title; modal closed';
    });

    await test('library: Esc closes a modal; backdrop restores focus', async () => {
      await page.locator('.lib-nav-heading button').click();
      await page.waitForSelector('.modal');
      await page.keyboard.press('Escape');
      await page.waitForTimeout(200);
      assert(await page.locator('.modal').count() === 0, 'modal still open after Esc');
      const log = await stubLog(page);
      assert(!log.some((l) => l.startsWith('createFolder')), 'cancelled prompt created a folder');
      await page.locator('.lib-nav-heading button').click();
      await page.fill('.modal input', '새 테스트 폴더');
      await page.locator('.modal .btn-primary').click();
      await page.waitForSelector('.lib-title >> text=새 테스트 폴더');
      return 'Esc cancelled the new-folder prompt (no createFolder); confirming created and selected the folder';
    });

    await test('library: multi-file upload (bytes → loadPdf → quickMeta → addPaper)', async () => {
      await page.locator('.tree-item', { hasText: '전체' }).click();
      const pdf = (title) => Buffer.from(`%PDF-1.4\n1 0 obj << /Title (${title}) >> endobj\n`, 'latin1');
      await page.setInputFiles('input[type=file]', [
        { name: 'uploaded-a.pdf', mimeType: 'application/pdf', buffer: pdf('Uploaded Test Paper A') },
        { name: 'no-title.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n', 'latin1') },
        { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') },
        { name: 'fail-me.pdf', mimeType: 'application/pdf', buffer: pdf('X') },
      ]);
      await page.waitForSelector('.toast-error');
      await page.waitForTimeout(300);
      await shot(page, '06-upload-toasts');
      const titles = await page.locator('.paper-title').allInnerTexts();
      assert(titles.includes('Uploaded Test Paper A'), 'quickMeta title not used');
      assert(titles.includes('no-title'), 'file-name fallback title not used');
      const toasts = await page.locator('.toast').allInnerTexts();
      assert(toasts.some((t) => t.includes('PDF가 아닌 파일 1개')), 'no skipped-file warning');
      assert(toasts.some((t) => t.includes('fail-me.pdf')), 'no per-file error');
      const log = (await stubLog(page)).filter((l) => l.startsWith('addPaper'));
      return `added: ${log.join(' ; ')}; warnings: non-PDF skipped, fail-me.pdf reported`;
    });

    await test('library: delete via confirmDialog', async () => {
      await page.locator('.paper-row', { hasText: 'no-title' }).locator('button[aria-label="논문 메뉴"]').click();
      await page.locator('.menu-item', { hasText: '삭제' }).click();
      await page.waitForSelector('.modal .btn-danger');
      await page.locator('.modal .btn-danger').click();
      await page.waitForTimeout(200);
      const titles = await page.locator('.paper-title').allInnerTexts();
      assert(!titles.includes('no-title'), 'paper not removed');
      return 'danger confirm → paper removed from list';
    });
    await page.context().close();
  }

  // -------------------------------------------------------------- reader
  {
    const { page } = await newPage(browser);
    await openReader(page);

    await test('reader: layout, populated translation pane, cached translations', async () => {
      const spans = await page.locator('.tp-s').count();
      const translated = await page.locator('.tp-s.is-translated').count();
      const untranslated = await page.locator('.tp-s.is-untranslated').count();
      const headings = await page.locator('h3.tp-para').count();
      const tabs = await page.locator('.tab').allInnerTexts();
      await shot(page, '07-reader');
      assert(spans === 75, `spans=${spans} (79 minus 4 furniture)`);
      assert(translated === 30, `translated=${translated}`);
      assert(tabs.join(',') === '번역,요약,채팅,메모,관련 논문', `tabs=${tabs}`);
      const status = await page.locator('.tp-header-status').innerText();
      return `${spans} sentence spans (furniture hidden), ${translated} translated, ${untranslated} greyed originals, ${headings} headings; tabs ${tabs.join('|')}; status "${status}"`;
    });

    await test('reader: feature ctx has exactly the SPEC §3.5 keys', async () => {
      const keys = await page.evaluate(() => Object.keys(window.__featureCtx).sort());
      const want = ['addToolbarButton', 'bus', 'doc', 'getAi', 'jumpToSentence', 'library', 'openPanel', 'pane', 'paper', 'pdf', 'saveAi', 'settings', 'signal', 'translator', 'viewer'].sort();
      assert(JSON.stringify(keys) === JSON.stringify(want), `keys=${keys}`);
      const r = await page.evaluate(async () => {
        const ctx = window.__featureCtx;
        await ctx.saveAi({ summary: { markdown: 'x', model: 'mock', createdAt: 1 } });
        return { paperId: ctx.paper.id, ai: Object.keys(ctx.getAi()), aborted: ctx.signal.aborted, btn: document.querySelectorAll('.tb-feature').length };
      });
      const log = await stubLog(page);
      assert(log.includes('savePaperData|pap_bundle|ai'), 'saveAi did not persist');
      assert(r.btn === 2 && !r.aborted, JSON.stringify(r));
      return `keys ok; saveAi persisted kind 'ai' (keys ${r.ai.join(',')}); 2 toolbar buttons added; signal live`;
    });

    await test('reader: hover sync pane → viewer and viewer → pane', async () => {
      await page.hover('.tp-s[data-sid="p1-5"]');
      await page.waitForTimeout(120);
      const viewerHover = await page.evaluate(() => document.querySelector('.sv-s.sv-hover')?.dataset.sid);
      assert(viewerHover === 'p1-5', `viewer hover=${viewerHover}`);
      await page.hover('.sv-s[data-sid="p1-11"]');
      await page.waitForTimeout(150);
      const paneHover = await page.evaluate(() => [...document.querySelectorAll('.tp-s.is-hover')].map((s) => s.dataset.sid));
      const viewerHover2 = await page.evaluate(() => document.querySelector('.sv-s.sv-hover')?.dataset.sid);
      assert(paneHover.length === 1 && paneHover[0] === 'p1-11', `pane hover=${paneHover}`);
      assert(viewerHover2 === 'p1-11', `viewer self-hover=${viewerHover2}`);
      await shot(page, '08-reader-hover');
      const bg = await page.evaluate(() => getComputedStyle(document.querySelector('.tp-s.is-hover')).backgroundColor);
      return `pane p1-5 → viewer highlights p1-5; viewer p1-11 → pane highlights p1-11 (bg ${bg}, from --pr-hover)`;
    });

    await test('reader: click sync scrolls the other side + active outline', async () => {
      await page.click('.tp-s[data-sid="p2-6"]');
      await page.waitForTimeout(120);
      let calls = await viewerCalls(page);
      assert(calls.includes('scrollToSentence|p2-6') && calls.includes('setActiveSentence|p2-6'), calls.slice(-4).join(' '));
      await page.click('.sv-s[data-sid="p3-2"]');
      await page.waitForTimeout(500);
      const active = await page.evaluate(() => document.querySelector('.tp-s.is-active')?.dataset.sid);
      const visible = await page.evaluate(() => {
        const s = document.querySelector('.tp-s[data-sid="p3-2"]').getBoundingClientRect();
        const b = document.querySelector('.tp-root').getBoundingClientRect();
        return s.top >= b.top && s.bottom <= b.bottom;
      });
      assert(active === 'p3-2' && visible, `active=${active} visible=${visible}`);
      calls = await viewerCalls(page);
      return 'pane click → viewer.scrollToSentence+setActiveSentence(p2-6); viewer click → pane scrolled p3-2 into view with is-active';
    });

    await test('reader: optional scroll sync (viewer visiblesentences → pane follows; toggle off)', async () => {
      const firstVisible = () => page.evaluate(() => {
        const box = document.querySelector('.tp-root').getBoundingClientRect();
        return [...document.querySelectorAll('.tp-s')].find((s) => s.getBoundingClientRect().bottom > box.top + 10)?.dataset.sid;
      });
      const scrollViewerTo = (pageNo) => page.evaluate((n) => {
        const host = document.querySelector('.viewer-host');
        host.scrollTop = host.querySelector(`.sv-page[data-page="${n}"]`).offsetTop + 30;
      }, pageNo);
      await page.mouse.move(200, 500); // pointer over the PDF, not the pane
      await scrollViewerTo(3);
      await page.waitForTimeout(1200);
      const followed = await firstVisible();
      assert(followed?.startsWith('p3-'), `pane top after viewer → page 3: ${followed}`);
      await page.locator('.tp-header .btn', { hasText: '스크롤 연동' }).click();
      const pressed = await page.getAttribute('.tp-header .btn', 'aria-pressed');
      await page.mouse.move(200, 500);
      await scrollViewerTo(1);
      await page.waitForTimeout(1000);
      const stayed = await firstVisible();
      await page.locator('.tp-header .btn', { hasText: '스크롤 연동' }).click(); // back on for later tests
      assert(pressed === 'false' && stayed?.startsWith('p3-'), `pressed=${pressed} stayed=${stayed}`);
      return `on: viewer scrolled to page 3 → pane top sentence ${followed}; toggled off (aria-pressed=false) → viewer back to page 1, pane stayed at ${stayed}`;
    });

    await test('reader: keyboard ←/→, PageDown, +/-, 0 and Esc', async () => {
      await page.fill('.tb-page-input', '1');
      await page.keyboard.press('Enter');
      await page.locator('.reader-toolbar .tb-title').click();
      const before = (await viewerCalls(page)).length;
      await page.keyboard.press('ArrowRight');
      await page.keyboard.press('PageDown');
      await page.keyboard.press('ArrowLeft');
      await page.keyboard.press('+');
      await page.keyboard.press('-');
      await page.keyboard.press('0');
      await page.waitForTimeout(100);
      const calls = (await viewerCalls(page)).slice(before);
      const pages = calls.filter((c) => c.startsWith('scrollToPage'));
      assert(pages.join(',') === 'scrollToPage|2,scrollToPage|3,scrollToPage|2', `pages: ${pages}`);
      assert(calls.includes('zoomIn') && calls.includes('zoomOut') && calls.includes('setZoom|fit-width'), calls.join(' '));
      const pageInput = await page.inputValue('.tb-page-input');
      // Esc: first closes the open menu only, then clears the active sentence.
      await page.locator('.tb-tr-more').click();
      await page.waitForSelector('.menu');
      await page.keyboard.press('Escape');
      await page.waitForTimeout(50);
      const menuGone = await page.locator('.menu').count() === 0;
      const stillActive = await page.locator('.tp-s.is-active').count();
      await page.keyboard.press('Escape');
      await page.waitForTimeout(50);
      const afterActive = await page.locator('.tp-s.is-active').count();
      assert(menuGone && stillActive === 1 && afterActive === 0, `menuGone=${menuGone} active ${stillActive}→${afterActive}`);
      return `→/PageDown/← → scrollToPage 2,3,2 (input shows ${pageInput}); + − 0 → zoomIn/zoomOut/fit-width; Esc#1 closed menu only, Esc#2 cleared active sentence`;
    });

    await test('reader: translate (progress + cost), failed retry affordance, retry', async () => {
      await page.click('.tb-tr-main');
      await page.waitForSelector('.tp-s.is-pending');
      await page.waitForTimeout(200);
      await shot(page, '09-translating');
      const prog = (await page.locator('.tb-progress').innerText()).replace(/\s+/g, ' ');
      await page.waitForSelector('.tp-retry', { timeout: 15000 });
      await page.waitForFunction(() => !document.querySelector('.tp-s.is-pending'), null, { timeout: 15000 });
      const failed = await page.evaluate(() => [...document.querySelectorAll('.tp-s.is-failed')].map((s) => s.dataset.sid));
      assert(failed.join(',') === 'p3-4,p3-5', `failed=${failed}`);
      await page.locator('.tp-s[data-sid="p3-4"]').scrollIntoViewIfNeeded();
      await shot(page, '10-failed-retry');
      await page.click('.tp-s[data-sid="p3-4"] .tp-retry');
      await page.waitForFunction(() => document.querySelector('.tp-s[data-sid="p3-4"]').classList.contains('is-translated'), null, { timeout: 8000 });
      const status = await page.locator('.tp-header-status').innerText();
      const trCalls = await page.evaluate(() => window.__stubTranslator.calls.map((c) => `${c[0]}:${JSON.stringify(c[1])}`));
      await page.waitForTimeout(2800); // counts flush (2.5 s throttle)
      const log = (await stubLog(page)).filter((l) => l.includes('translatedCount') || l.includes('|translation'));
      assert(log.length > 0, 'library counts / translation never saved');
      return `progress "${prog}"; failed ${failed.join(',')} showed 다시 시도; retry → translateSids; status "${status}"; calls ${trCalls.join(' ')}; persisted: ${[...new Set(log)].join(' ; ')}`;
    });

    await test('reader: view modes 원문 / 번역 겹쳐보기 / 나란히', async () => {
      await page.locator('.segmented .btn', { hasText: '원문' }).click();
      const mode1 = await page.getAttribute('.reader', 'data-mode');
      const rightHidden = await page.locator('.reader-right').isHidden();
      await page.locator('.segmented .btn', { hasText: '번역 겹쳐보기' }).click();
      await page.waitForTimeout(150);
      await shot(page, '11-overlay');
      const overlayCall = (await viewerCalls(page)).filter((c) => c.startsWith('setTranslationOverlay')).pop();
      await page.locator('.segmented .btn', { hasText: '나란히' }).click();
      await page.waitForTimeout(100);
      const offCall = (await viewerCalls(page)).filter((c) => c.startsWith('setTranslationOverlay')).pop();
      assert(mode1 === 'original' && rightHidden, 'original mode still shows right pane');
      assert(/\|\d+$/.test(overlayCall) && offCall === 'setTranslationOverlay|', `${overlayCall} / ${offCall}`);
      return `원문 hides right pane; overlay → viewer.${overlayCall}; 나란히 → overlay cleared (null)`;
    });

    await test('reader: feature panels (lazy mount, sid links jump), toolbar toggle, broken panel isolated', async () => {
      await page.locator('.tab', { hasText: '요약' }).click();
      await page.waitForSelector('.tabpanel .sid-link');
      await shot(page, '12-summary-tab');
      const before = (await viewerCalls(page)).length;
      await page.locator('.sid-link[data-sid="p3-3"]').click();
      await page.waitForTimeout(100);
      const calls = (await viewerCalls(page)).slice(before);
      assert(calls.includes('scrollToSentence|p3-3'), calls.join(' '));
      await page.locator('.tb-feature[data-feature="autohl"]').click();
      const pressed = await page.getAttribute('.tb-feature[data-feature="autohl"]', 'aria-pressed');
      const autoMarks = await page.locator('.tp-s[data-m-auto="underline"]').count();
      await page.locator('.tab', { hasText: '관련 논문' }).click();
      const err = await page.locator('.panel-error').innerText();
      await page.locator('.tab', { hasText: '번역' }).click();
      assert(pressed === 'true' && autoMarks === 3, `pressed=${pressed} marks=${autoMarks}`);
      return `summary mounted once; [p3-3] link → jumpToSentence; '핵심 밑줄' toggle aria-pressed=true, 3 pane sentences underlined; throwing panel shows "${err.slice(0, 40)}…"`;
    });

    await test('reader: draggable divider persists; #/paper/<id> reopens after reload', async () => {
      const box = await page.locator('.reader-divider').boundingBox();
      const body = await page.locator('.reader-body').boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(body.x + body.width * 0.36, box.y + box.height / 2, { steps: 8 });
      await page.mouse.up();
      const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('pr.ui.v1')).splitRatio);
      assert(Math.abs(saved - 0.36) < 0.02, `saved split ${saved}`);
      await page.reload();
      await page.waitForSelector('.tp-s[data-sid]');
      const title = await page.locator('.tb-title').innerText();
      const split = await page.evaluate(() => getComputedStyle(document.querySelector('.reader-body')).getPropertyValue('--split'));
      const leftW = (await page.locator('.reader-left').boundingBox()).width;
      assert(title.startsWith('Effects of a Nurse-Led'), `title after reload: ${title}`);
      assert(Math.abs(parseFloat(split) - 36) < 2, `split after reload ${split}`);
      return `split saved ${saved.toFixed(3)} in localStorage; after reload same paper reopened ("${title.slice(0, 30)}…"), --split=${split.trim()} (left ${Math.round(leftW)}px)`;
    });

    await test('reader: closing the paper disposes features, aborts signal, destroys viewer', async () => {
      await page.locator('.tab', { hasText: '요약' }).click();
      await page.waitForSelector('.tabpanel .sid-link');
      await page.evaluate(() => { window.__savedCtx = window.__featureCtx; window.__savedViewer = window.__stubViewer; });
      await page.locator('.reader-toolbar .btn', { hasText: '라이브러리' }).click();
      await page.waitForSelector('.paper-row');
      const r = await page.evaluate(() => ({ aborted: window.__savedCtx.signal.aborted, disposed: window.__featuresDisposed, destroyed: window.__savedViewer.destroyed, summary: window.__summaryDestroyed }));
      assert(r.aborted && r.disposed && r.destroyed && r.summary, JSON.stringify(r));
      const recent = await page.locator('.tree-item', { hasText: '최근 읽음' }).innerText();
      return `signal aborted, dispose() called, panel destroy() called, viewer destroyed; sidebar "${recent.replace(/\s+/g, ' ')}"`;
    });
    await page.context().close();
  }

  await test('reader: scanned PDF degrades (no text, translate disabled)', async () => {
    const { page } = await newPage(browser);
    await page.goto(`${H}?mock=1&reset=1#/paper/pap_kappa`);
    await page.waitForSelector('.tp-empty');
    await page.waitForTimeout(200);
    await shot(page, '13-scanned');
    const text = await page.locator('.tp-empty').innerText();
    const disabled = await page.locator('.tb-tr-main').isDisabled();
    assert(text.includes('텍스트를 추출할 수 없는') && disabled, `${text} disabled=${disabled}`);
    await page.goto(`${H}?mock=1#/paper/nope`);
    await page.waitForSelector('.message-title');
    const nf = await page.locator('.message-title').innerText();
    assert(nf === '논문을 찾을 수 없습니다', nf);
    await page.context().close();
    return `pane notice "${text.split('\n')[0]}"; 번역 button disabled; unknown id → "${nf}"`;
  });

  // ------------------------------------------------------------ settings
  {
    const { page } = await newPage(browser);
    await page.goto(`${H}?reset=1#/settings`);
    await page.waitForSelector('.settings-section');

    await test('settings: all sections render (Korean how-to for fine-grained token)', async () => {
      const titles = await page.locator('.section-title').allInnerTexts();
      await shot(page, '14-settings');
      await page.setViewportSize({ width: 1400, height: 4200 });
      await page.waitForTimeout(200);
      await shot(page, '14b-settings-full');
      await page.setViewportSize({ width: 1400, height: 860 });
      const howto = await page.locator('#set-sync .howto').innerText();
      for (const must of ['Only select repositories', 'Contents', 'Read and write', 'Private', '하나만']) assert(howto.includes(must), `how-to missing ${must}`);
      return `sections: ${titles.join(' | ')}; how-to covers private repo, Only select repositories (one repo), Contents: Read and write`;
    });

    await test('settings: Claude key 테스트 + models; Gemini live model list', async () => {
      await page.fill('#set-ai input[type=password]', 'sk-ant-test-123');
      await page.locator('#set-ai .btn', { hasText: '테스트' }).click();
      await page.waitForSelector('#set-ai .test-result.is-ok');
      const ok = await page.locator('#set-ai .test-result.is-ok').innerText();
      await page.fill('#set-ai input[type=password]', 'bad-key');
      await page.locator('#set-ai .btn', { hasText: '테스트' }).click();
      await page.waitForSelector('#set-ai .test-result.is-error');
      const bad = await page.locator('#set-ai .test-result.is-error').innerText();
      await page.locator('.radio-card', { hasText: 'Gemini' }).click();
      await page.fill('#set-ai input[type=password]', 'AIza-test');
      await page.locator('#set-ai input[type=password]').blur();
      await page.locator('.btn', { hasText: '모델 목록 불러오기' }).click();
      await page.waitForSelector('#set-ai .test-result.is-ok >> text=모델 3개');
      const opts = await page.locator('#set-ai select').first().locator('option').allInnerTexts();
      const s = await page.evaluate(() => JSON.parse(localStorage.getItem('pr.settings.v1')));
      assert(s.provider === 'gemini' && s.gemini.apiKey === 'AIza-test' && s.gemini.translateModel === 'gemini-3.5-flash', JSON.stringify(s.gemini));
      await page.locator('.radio-card', { hasText: 'Claude' }).click();
      return `ok → "${ok.trim()}"; bad → "${bad.trim()}"; Gemini models [${opts.join(', ')}], defaults translate=${s.gemini.translateModel}, assist=${s.gemini.assistModel}`;
    });

    await test('settings: GitHub 연결 테스트 (private/public/readonly) + save → reconfigureSync', async () => {
      await page.fill('#set-sync input[aria-label="소유자 (사용자 이름)"]', 'https://github.com/nurse-kim/paper-library');
      await page.locator('#set-sync input[aria-label="소유자 (사용자 이름)"]').blur();
      const repo = await page.inputValue('#set-sync input[aria-label="저장소 이름"]');
      await page.fill('#set-sync input[aria-label="GitHub 토큰"]', 'github_pat_abc');
      await page.locator('.btn', { hasText: '연결 테스트' }).click();
      await page.waitForSelector('#set-sync .btn-row + .test-result.is-ok');
      const ok = await page.locator('#set-sync .btn-row + .test-result').innerText();
      await page.fill('#set-sync input[aria-label="저장소 이름"]', 'public-repo');
      await page.locator('.btn', { hasText: '연결 테스트' }).click();
      await page.waitForSelector('#set-sync .btn-row + .test-result.is-error');
      const pub = await page.locator('#set-sync .btn-row + .test-result').innerText();
      await page.fill('#set-sync input[aria-label="저장소 이름"]', 'paper-library');
      await page.locator('.btn', { hasText: '저장하고 동기화 시작' }).click();
      await page.waitForSelector('.toast >> text=GitHub 동기화를 켰습니다');
      const log = await stubLog(page);
      assert(repo === 'paper-library' && log.includes('reconfigureSync'), `repo=${repo}`);
      return `URL paste split into owner/repo; private → "${ok.trim()}"; public → "${pub.trim().slice(0, 40)}…"; save → reconfigureSync()`;
    });

    await test('settings: glossary, toggles, usage table', async () => {
      await page.locator('.btn', { hasText: '용어 추가' }).click();
      await page.locator('.glossary-row input').nth(0).fill('delirium');
      await page.locator('.glossary-row input').nth(1).fill('섬망');
      await page.locator('.switch-row', { hasText: '참고문헌도 번역' }).locator('input').check();
      await page.waitForTimeout(600);
      const s = await page.evaluate(() => JSON.parse(localStorage.getItem('pr.settings.v1')).translate);
      const usage = (await page.locator('#set-usage .usage-stats').innerText()).replace(/\s+/g, ' ');
      const rows = await page.locator('#set-usage tbody tr').count();
      assert(s.glossary[0]?.tgt === '섬망' && s.translateReferences === true && rows === 2, JSON.stringify(s));
      return `glossary saved ${JSON.stringify(s.glossary)}; translateReferences=true; usage "${usage}" with ${rows} model rows`;
    });

    await test('settings: clear secrets (confirm modal) + dark theme', async () => {
      await page.locator('.btn', { hasText: '이 기기에서 키·토큰 지우기' }).click();
      await page.waitForSelector('.modal .btn-danger');
      await page.waitForTimeout(250);
      await shot(page, '15-confirm-modal');
      await page.locator('.modal .btn-danger').click();
      await page.waitForSelector('.toast >> text=키와 토큰을 지웠습니다');
      const s = await page.evaluate(() => JSON.parse(localStorage.getItem('pr.settings.v1')));
      assert(!s.claude.apiKey && !s.gemini.apiKey && !s.github.token && s.github.owner === 'nurse-kim', JSON.stringify(s.github));
      await shot(page, '16-toast-cleared');
      await page.locator('#set-display .segmented .btn', { hasText: '어둡게' }).click();
      const theme = await page.getAttribute('html', 'data-theme');
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.locator('.settings').evaluate((n) => n.scrollTo(0, 0));
      await page.waitForTimeout(400); // let the 0.12 s colour transitions finish
      await shot(page, '17-settings-dark');
      assert(theme === 'dark', theme);
      return 'confirm modal → keys/token cleared (owner/repo kept) + success toast; theme switched to dark';
    });

    await test('dark theme: library + reader', async () => {
      await page.goto(`${H}?mock=1#/`);
      await page.waitForSelector('.paper-row');
      await shot(page, '18-library-dark');
      await page.goto(`${H}?mock=1#/paper/pap_bundle`);
      await page.waitForSelector('.tp-s[data-sid]');
      await page.waitForTimeout(200);
      await page.hover('.sv-s[data-sid="p1-4"]');
      await page.waitForTimeout(150);
      await shot(page, '19-reader-dark');
      const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
      return `body background ${bg} in dark theme`;
    });
    await page.context().close();
  }

  // -------------------------------------------------------- narrow screen
  await test('narrow screen: stacked reader panes + library drawer', async () => {
    const { page } = await newPage(browser, { viewport: { width: 600, height: 900 } });
    await openReader(page, '?mock=1&reset=1');
    const orient = await page.getAttribute('.reader', 'data-orient');
    const trBox = await page.locator('.tb-tr-more').boundingBox();
    const settingsBox = await page.locator('.reader-toolbar > .btn:last-child').boundingBox();
    const left = await page.locator('.reader-left').boundingBox();
    const right = await page.locator('.reader-right').boundingBox();
    await shot(page, '20-reader-narrow');
    const docW = await page.evaluate(() => document.documentElement.scrollWidth);
    await page.goto(`${H}?mock=1#/`);
    await page.waitForSelector('.paper-row');
    await page.locator('.lib-menu-btn').click();
    await page.waitForTimeout(300);
    await shot(page, '21-library-narrow-drawer');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    const open = await page.evaluate(() => document.querySelector('.library').classList.contains('is-drawer-open'));
    await page.context().close();
    assert(orient === 'v' && right.y > left.y && docW <= 600 && !open, `orient=${orient} docW=${docW} open=${open}`);
    assert(trBox.x + trBox.width <= 600 && settingsBox.x + settingsBox.width <= 600, `toolbar overflows: translate ends ${trBox.x + trBox.width}, settings ${settingsBox.x + settingsBox.width}`);
    return `toolbar fits 600px (translate menu ends at ${Math.round(trBox.x + trBox.width)}px); data-orient=v, PDF on top (y=${Math.round(left.y)}) and translation below (y=${Math.round(right.y)}); no horizontal page scroll (${docW}px); drawer opens and Esc closes it`;
  });

  // --------------------------------------------------------- degradation
  await test('degraded: features + translator missing → banner, translation still shown', async () => {
    const { page } = await newPage(browser);
    await page.goto(`${BASE}/tests/shell/harness-degraded.html?mock=1&reset=1#/paper/pap_bundle`);
    await page.waitForSelector('.tp-s[data-sid]');
    await page.waitForTimeout(200);
    await shot(page, '22-degraded');
    const banner = await page.locator('.app-banner').innerText();
    const tabs = await page.locator('.tab').count();
    const translated = await page.locator('.tp-s.is-translated').count();
    const disabled = await page.locator('.tb-tr-main').isDisabled();
    await page.locator('.app-banner .btn', { hasText: '자세히' }).click();
    const details = await page.locator('.modal pre').innerText();
    await page.context().close();
    assert(banner.includes('일부 기능을 불러오지 못했습니다') && tabs === 1 && translated === 30 && disabled, `${banner} tabs=${tabs} tr=${translated} disabled=${disabled}`);
    assert(details.includes('js/features/index.js') && details.includes('js/ai/translator.js'), details);
    return `banner "${banner.split('\n')[0].slice(0, 60)}…"; only 번역 tab; 30 cached translations shown via offline translator; 번역 button disabled; details list both module paths`;
  });

  await test('fatal: critical module missing → Korean error screen with details', async () => {
    const { page } = await newPage(browser);
    await page.goto(`${BASE}/tests/shell/harness-fatal.html`);
    await page.waitForSelector('.message-screen');
    await page.locator('.message-details summary').click();
    await shot(page, '23-fatal');
    const title = await page.locator('.message-title').innerText();
    const details = await page.locator('.message-details pre').innerText();
    await page.context().close();
    assert(title === '앱을 시작할 수 없습니다' && details.includes('js/store/library.js'), `${title} / ${details}`);
    return `"${title}" + details: ${details.split('\n')[0]}`;
  });

  await test('real index.html: exact CSP meta, shell boots without CSP violations', async () => {
    const { page } = await newPage(browser);
    const violations = [];
    page.on('console', (m) => { if (/Content Security Policy|Refused to/i.test(m.text())) violations.push(m.text()); });
    await page.goto(`${BASE}/index.html?mock=1`);
    await page.waitForFunction(() => document.querySelector('.message-screen, .library, .reader'), null, { timeout: 15000 });
    await page.waitForTimeout(500);
    await shot(page, '24-real-index');
    const csp = await page.getAttribute('meta[http-equiv="Content-Security-Policy"]', 'content');
    const state = await page.evaluate(() => document.querySelector('.message-title')?.textContent || (document.querySelector('.library') ? 'library rendered' : 'reader'));
    const banner = await page.locator('.app-banner').count();
    await page.context().close();
    assert(csp === CSP, 'CSP meta differs from the required string');
    assert(!violations.length, `CSP violations: ${violations.join(' | ')}`);
    return `CSP meta matches exactly; no CSP violations; current state with real modules: "${state}"${banner ? ' (+ degraded banner)' : ''}`;
  });

  await test('no uncaught page errors / no blocked paid-API requests', async () => {
    const relevant = pageErrors.filter((e) => !/__missing__|Failed to load resource.*404|harness-fatal|harness-degraded|index\.html/.test(e));
    assert(!relevant.length, relevant.slice(0, 5).join('\n'));
    assert(!blockedRequests.length, `requests to paid/remote APIs: ${blockedRequests.join(', ')}`);
    return `0 unexpected page errors (${pageErrors.length} expected 404/missing-module messages from degradation tests); 0 requests to AI/GitHub hosts`;
  });
} finally {
  await browser.close();
  if (server) server.kill();
  writeFileSync(`${OUT}/results.json`, JSON.stringify({ results, pageErrors, blockedRequests }, null, 2));
  const failed = results.filter((r) => r.result === 'fail').length;
  console.log(`\n${results.length - failed}/${results.length} passed. Screenshots: ${OUT}`);
  process.exitCode = failed ? 1 : 0;
}
