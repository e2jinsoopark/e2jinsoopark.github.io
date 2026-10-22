// Library multi-select and folder UX, end to end on the real library view + real store (tests/library-select/harness.*):
//   node tests/library-select/run.mjs      (starts `python -m http.server 8261` if nothing is listening, stops it after)
// Desktop in Edge, phones as Pixel 7 (Edge, touch) and iPhone 15 (WebKit, touch). A 60-paper 내 서재 and a 공용 서재
// (휴지통) on in-memory sync engines that record every write: a batch = one library.json write = one sync commit.
// Nothing leaves the page (no GitHub, relay or AI host is contacted; any such request fails the run).
// Results + screenshots: C:/Users/dindoo/Projects/pr-tools/out/select/.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, devices, webkit } from 'file:///C:/Users/dindoo/Projects/pr-tools/node_modules/playwright/index.mjs';

const PORT = 8261;
const BASE = `http://127.0.0.1:${PORT}`;
const H = `${BASE}/tests/library-select/harness.html?mock=1`;
const OUT = 'C:/Users/dindoo/Projects/pr-tools/out/select';
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

mkdirSync(OUT, { recursive: true });
const results = [];
const problems = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function assert(cond, msg) { if (!cond) throw new Error(msg); }
function assertEqual(a, b, msg) {
  const ja = JSON.stringify(a);
  const jb = JSON.stringify(b);
  if (ja !== jb) throw new Error(`${msg}: got ${ja}, want ${jb}`);
}

async function test(name, fn) {
  const t0 = Date.now();
  const before = problems.length;
  try {
    const evidence = await fn();
    const fresh = problems.slice(before);
    if (fresh.length) throw new Error(`console/page problems during the test:\n  ${fresh.join('\n  ')}`);
    results.push({ name, result: 'pass', evidence: String(evidence ?? 'ok'), ms: Date.now() - t0 });
    console.log(`PASS  ${name}  (${Date.now() - t0} ms)\n      ${evidence ?? ''}`);
  } catch (err) {
    results.push({ name, result: 'fail', evidence: err?.stack || String(err), ms: Date.now() - t0 });
    console.log(`FAIL  ${name}\n      ${err?.stack || err}`);
  }
}

async function waitFor(fn, timeout = 5000, what = 'condition') {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error(`timeout waiting for ${what}`);
    await sleep(50);
  }
}

async function serverUp() {
  try { return (await fetch(`${BASE}/tests/library-select/harness.html`)).ok; } catch { return false; }
}

let server = null;
if (!(await serverUp())) {
  server = spawn('python', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], { cwd: REPO, stdio: 'ignore' });
  await waitFor(serverUp, 10000, 'python http.server');
}

const edge = await chromium.launch({ channel: 'msedge' });
let wk = null;
try { wk = await webkit.launch(); } catch (err) { console.log(`(WebKit not available: ${err.message})`); }

/** One browser context; every request outside the local server is aborted and counted as a problem. */
async function open(browser, name, { query = '', hash = '#/', context = {} } = {}) {
  const ctx = await browser.newContext({ locale: 'ko-KR', colorScheme: 'light', viewport: { width: 1400, height: 860 }, ...context });
  await ctx.route(/^https?:\/\/(?!127\.0\.0\.1:8261\/)/, (route) => {
    problems.push(`${name}: external request ${route.request().url()}`);
    return route.abort();
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => problems.push(`${name}: pageerror ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') problems.push(`${name}: console.error ${m.text()}`); });
  page.on('dialog', (d) => { problems.push(`${name}: native dialog ${d.type()} ${d.message()}`); d.dismiss().catch(() => {}); });
  await page.goto(`${H}${query}${hash}`);
  await page.waitForFunction(() => window.__lsel?.ready && document.querySelector('.paper-row'));
  return { ctx, page };
}

const row = (id) => `.paper-row[data-id="${id}"]`;
const shot = (target, file, opts = {}) => target.screenshot({ path: `${OUT}/${file}.png`, ...opts });
const selectedIds = (page) => page.$$eval('.paper-row.is-selected', (els) => els.map((e) => e.dataset.id));
const countText = (page) => page.$eval('.lib-count-text', (e) => e.textContent.trim());
const allBox = (page) => page.$eval('.lib-select-all-check', (e) => ({ checked: e.checked, indeterminate: e.indeterminate }));
const libState = (page, which = 'mine') => page.evaluate((w) => window.__lsel.state(w), which);
const writes = (page, which = 'mine') => page.evaluate((w) => window.__lsel.writes(w), which);
const paperOf = async (page, id, which = 'mine') => (await libState(page, which)).papers.find((p) => p.id === id);
const folderNamed = async (page, name, which = 'mine') => (await libState(page, which)).folders.find((f) => f.name === name);
const sideItem = (page, lib, id) => page.locator(`.lib-sec[data-lib="${lib}"] .tree-item[data-folder="${id}"]`);
const sideAll = (page, lib) => page.locator(`.lib-sec[data-lib="${lib}"] .tree-item`, { hasText: '전체' }).first();
const clearToasts = (page) => page.evaluate(() => document.querySelectorAll('.toast').forEach((t) => t.remove()));
async function toastWith(page, text) {
  await page.waitForFunction((t) => [...document.querySelectorAll('.toast')].some((e) => e.textContent.includes(t)), text, { timeout: 8000 });
  return page.locator('.toast', { hasText: text }).last();
}
async function answerPrompt(page, value) {
  const input = page.locator('.modal-backdrop input[type="text"]').last();
  await input.waitFor();
  await input.fill(value);
  await input.press('Enter');
  await page.waitForFunction(() => !document.querySelector('.modal-backdrop'));
}
async function noModal(page) { await page.waitForFunction(() => !document.querySelector('.modal-backdrop')); }
const pickerLabels = (page) => page.$$eval('.modal .folder-picker .menu-item .menu-label', (els) => els.map((e) => e.textContent.trim()));

try {
  // ======================================================================= desktop
  {
    const { page } = await open(edge, 'desktop');

    await test('desktop: select 3 papers with their checkboxes → tri-state 전체 선택, count, action bar', async () => {
      const before = await page.$eval(`${row('p_01')} .paper-check`, (e) => getComputedStyle(e).opacity);
      await page.hover(row('p_01'));
      await page.waitForTimeout(200);
      const onHover = await page.$eval(`${row('p_01')} .paper-check`, (e) => getComputedStyle(e).opacity);
      for (const id of ['p_01', 'p_03', 'p_05']) await page.locator(`${row(id)} .paper-check`).click();
      const ids = await selectedIds(page);
      const box = await allBox(page);
      const count = await countText(page);
      const bar = await page.$$eval('.sel-actions .sel-btn', (els) => els.map((b) => b.getAttribute('aria-label')));
      const visible = await page.isVisible('.sel-actions');
      const sticky = await page.$eval('.lib-listbar', (e) => getComputedStyle(e).position);
      await page.waitForTimeout(150);
      await shot(page, 'desktop-01-three-selected');
      assertEqual(ids, ['p_01', 'p_03', 'p_05'], 'selected rows');
      assert(before === '0' && onHover === '1', `checkbox opacity before/hover ${before}/${onHover}`);
      assert(box.indeterminate && !box.checked, `전체 선택 ${JSON.stringify(box)}`);
      assert(count.startsWith('3편 선택됨'), count);
      assertEqual(bar, ['폴더로 이동…', '다른 서재로 복사…', '즐겨찾기', '삭제', '선택 해제'], 'action bar');
      assert(visible && sticky === 'sticky', `bar visible=${visible} position=${sticky}`);
      return `rows ${ids}; 전체 선택 indeterminate; “${count}”; bar [${bar.join(' · ')}] (sticky at the top of the list); checkbox hidden until hover (${before}→${onHover})`;
    });

    await test('desktop: Shift+click selects a range (checkbox and row body); Esc clears', async () => {
      await page.keyboard.press('Escape');
      assertEqual(await selectedIds(page), [], 'Esc cleared');
      const hash0 = await page.evaluate(() => location.hash);
      await page.locator(`${row('p_02')} .paper-check`).click();
      await page.locator(`${row('p_06')} .paper-check`).click({ modifiers: ['Shift'] });
      const range1 = await selectedIds(page);
      await page.locator(`${row('p_08')} .paper-link`).click({ modifiers: ['Shift'] });
      const range2 = await selectedIds(page);
      const hash1 = await page.evaluate(() => location.hash);
      const pages = await page.context().pages().length;
      // Shift+click on a selected checkbox unselects the range back to the anchor
      await page.locator(`${row('p_07')} .paper-check`).click({ modifiers: ['Shift'] });
      const range3 = await selectedIds(page);
      await page.keyboard.press('Escape');
      const after = await selectedIds(page);
      assertEqual(range1, ['p_02', 'p_03', 'p_04', 'p_05', 'p_06'], 'checkbox range');
      assertEqual(range2, ['p_02', 'p_03', 'p_04', 'p_05', 'p_06', 'p_07', 'p_08'], 'row-body range');
      assertEqual(range3, ['p_02', 'p_03', 'p_04', 'p_05', 'p_06'], 'Shift+click on a selected row unselects back to the anchor');
      assert(hash0 === hash1 && pages === 1, `Shift+click opened something: ${hash1}, pages ${pages}`);
      assertEqual(after, [], 'Esc');
      return `p_02 then Shift p_06 → ${range1.length} rows; Shift on p_08's row → ${range2.length} (no paper opened, no new window); Shift on p_07 (selected) → back to ${range3.length}; Esc → none`;
    });

    await test('desktop: 전체 선택 with a search filter selects only the matches; Ctrl+A in the list selects all shown', async () => {
      await page.fill('.lib-search', 'Delirium');
      await page.waitForFunction(() => document.querySelectorAll('.paper-row').length === 5);
      const shown = await page.$$eval('.paper-row', (els) => els.map((e) => e.dataset.id));
      await page.locator('.lib-select-all').click();
      const sel = await selectedIds(page);
      const box = await allBox(page);
      const count = await countText(page);
      await shot(page, 'desktop-02-select-all-search');
      await page.fill('.lib-search', '');
      await page.waitForFunction(() => document.querySelectorAll('.paper-row').length === 60);
      const kept = await selectedIds(page);
      const box2 = await allBox(page);
      await page.keyboard.press('Escape');
      await page.locator(`${row('p_10')} .paper-check`).focus();
      await page.keyboard.press('Control+a');
      const all = (await selectedIds(page)).length;
      const box3 = await allBox(page);
      await page.locator('.lib-select-all').click(); // all → none
      const none = (await selectedIds(page)).length;
      assertEqual(sel, shown, 'select all = the 5 matches');
      assert(box.checked && !box.indeterminate && count.startsWith('5편 선택됨'), `${JSON.stringify(box)} ${count}`);
      assertEqual(kept, shown, 'selection kept when the filter is cleared');
      assert(box2.indeterminate, 'indeterminate over the full list');
      assert(all === 60 && box3.checked && none === 0, `Ctrl+A ${all}, box ${JSON.stringify(box3)}, then none ${none}`);
      return `“Delirium” → 5 rows, 전체 선택 → [${sel}] (checked, “${count}”); filter cleared → still 5 (box indeterminate); Ctrl+A → 60; 전체 선택 again → 0`;
    });

    await test('desktop: selection survives sorting and scrolling; clicking a row still opens the paper; leaving clears it', async () => {
      for (const id of ['p_09', 'p_33']) await page.locator(`${row(id)} .paper-check`).click();
      await page.selectOption('.lib-sort', 'title');
      await page.waitForTimeout(150);
      await page.locator('.lib-content').evaluate((e) => { e.scrollTop = e.scrollHeight; });
      await page.waitForTimeout(100);
      const afterSort = await selectedIds(page);
      const barTop = await page.$eval('.lib-listbar-inner', (e) => Math.round(e.getBoundingClientRect().top));
      const headerBottom = await page.$eval('.lib-header', (e) => Math.round(e.getBoundingClientRect().bottom));
      await shot(page, 'desktop-03-sticky-bar-scrolled');
      await page.selectOption('.lib-sort', 'added');
      await page.locator(`${row('p_09')} .paper-link`).click();
      await page.waitForSelector('.harness-reader');
      const opened = await page.evaluate(() => location.hash);
      await page.goBack();
      await page.waitForSelector('.paper-row');
      const back = await selectedIds(page);
      assertEqual([...afterSort].sort(), ['p_09', 'p_33'], 'kept after sort + scroll');
      assert(barTop >= headerBottom && barTop - headerBottom < 24, `sticky bar top ${barTop} vs header ${headerBottom}`);
      assert(opened === '#/paper/p_09', opened);
      assertEqual(back, [], 'cleared after leaving the library');
      return `2 selected kept through 제목 sort + scroll to the end (bar stuck at y=${barTop}, header ends ${headerBottom}); row click opened ${opened}; back → selection cleared`;
    });

    let made = null;
    await test('desktop: 폴더로 이동… → picker tree, 새 폴더 made inline inside a nested folder, 옮기기 = one batch (one write), 되돌리기', async () => {
      for (const id of ['p_01', 'p_02', 'p_04']) await page.locator(`${row(id)} .paper-check`).click();
      await page.locator('.sel-move').click();
      await page.waitForSelector('.move-dialog .folder-picker');
      const labels = await pickerLabels(page);
      const here = await page.locator('.move-dialog .menu-item.is-root .folder-pick-here').textContent();
      await page.locator('.move-dialog .folder-picker label', { hasText: '섬망' }).click();
      await page.locator('.move-dialog .btn', { hasText: '새 폴더' }).click();
      const placeholder = await page.getAttribute('.move-dialog .folder-pick-name', 'placeholder');
      const nameLabel = await page.getAttribute('.move-dialog .folder-pick-name', 'aria-label');
      await page.fill('.move-dialog .folder-pick-name', '선택 테스트');
      await page.press('.move-dialog .folder-pick-name', 'Enter');
      await page.waitForFunction(() => [...document.querySelectorAll('.move-dialog .folder-picker .menu-item')].some((l) => l.textContent.includes('선택 테스트') && l.querySelector('input').checked));
      made = await folderNamed(page, '선택 테스트');
      const delir = await folderNamed(page, '섬망');
      await shot(page.locator('.move-dialog'), 'desktop-04-picker-new-folder');
      await page.waitForTimeout(200);
      const w0 = await writes(page);
      await page.locator('.move-dialog .modal-footer .btn', { hasText: '옮기기' }).click();
      await noModal(page);
      const t = await toastWith(page, '3편을 ‘선택 테스트’로 옮겼습니다');
      await page.waitForTimeout(300);
      const w1 = await writes(page);
      const moved = await Promise.all(['p_01', 'p_02', 'p_04'].map((id) => paperOf(page, id)));
      const selAfter = await selectedIds(page);
      await shot(page, 'desktop-05-moved-toast');
      const moveText = (await t.textContent()).replace('되돌리기', '').trim();
      await t.locator('.btn', { hasText: '되돌리기' }).click();
      await toastWith(page, '3편을 원래 폴더로 되돌렸습니다');
      await page.waitForTimeout(300);
      const w2 = await writes(page);
      const undone = await Promise.all(['p_01', 'p_02', 'p_04'].map((id) => paperOf(page, id)));
      assert(labels[0] === '최상위 (폴더 없음)' && here === '지금 위치', `picker root ${labels[0]} / ${here}`);
      assertEqual(labels.slice(1), ['기타', '중환자 간호', '기계환기', '섬망', '평가 도구', '통계'], 'full tree (expanded)');
      assert(placeholder === '하위 폴더 이름' && nameLabel === '‘섬망’ 안에 만들 폴더 이름', `${placeholder} / ${nameLabel}`);
      assert(made && made.parentId === delir.id, `new folder under 섬망: ${JSON.stringify(made)}`);
      assert(moved.every((p) => p.folderId === made.id), `moved ${moved.map((p) => p.folderId)}`);
      assert(w1 - w0 === 1, `library.json writes for the move: ${w1 - w0}`);
      assertEqual(selAfter, [], 'selection cleared after the move');
      assert(undone.every((p) => p.folderId === null) && w2 - w1 === 1, `undo ${undone.map((p) => p.folderId)} writes ${w2 - w1}`);
      return `picker [${labels.join(' / ')}]; ‘선택 테스트’ made inside 섬망 and picked; 3 papers moved with ${w1 - w0} library.json write (one commit); toast “${moveText}”; 되돌리기 → back to the top (${w2 - w1} write)`;
    });

    await test('desktop: dragging a selected row moves the whole selection; an unselected row moves alone', async () => {
      await clearToasts(page);
      for (const id of ['p_05', 'p_06', 'p_07']) await page.locator(`${row(id)} .paper-check`).click();
      const w0 = await writes(page);
      await page.locator(row('p_06')).dragTo(sideItem(page, 'mine', 'f_stats'));
      const t = await toastWith(page, '3편을 ‘통계’로 옮겼습니다');
      await page.waitForTimeout(300);
      const w1 = await writes(page);
      const three = await Promise.all(['p_05', 'p_06', 'p_07'].map((id) => paperOf(page, id)));
      for (const id of ['p_09', 'p_10']) await page.locator(`${row(id)} .paper-check`).click();
      await page.locator(row('p_11')).dragTo(sideItem(page, 'mine', 'f_misc'));
      await toastWith(page, '’을(를) ‘기타’ 폴더로 옮겼습니다');
      const single = await paperOf(page, 'p_11');
      const others = await Promise.all(['p_09', 'p_10'].map((id) => paperOf(page, id)));
      const stillSelected = await selectedIds(page);
      await page.keyboard.press('Escape');
      assert(three.every((p) => p.folderId === 'f_stats'), `selection drop ${three.map((p) => p.folderId)}`);
      assert(w1 - w0 === 1, `writes ${w1 - w0}`);
      assert(single.folderId === 'f_misc' && others.every((p) => p.folderId === null), 'unselected drag moved only itself');
      assertEqual(stillSelected, ['p_09', 'p_10'], 'the selection stays');
      return `p_05–p_07 selected, p_06 dropped on 통계 → all three moved (${w1 - w0} write; “${(await t.textContent()).trim()}”); unselected p_11 → 기타 alone; p_09/p_10 stay selected`;
    });

    await test('desktop: 즐겨찾기 for the selection toggles all (one write each way)', async () => {
      await clearToasts(page);
      for (const id of ['p_12', 'p_13', 'p_14']) await page.locator(`${row(id)} .paper-check`).click();
      const w0 = await writes(page);
      await page.locator('.sel-star').click();
      await toastWith(page, '3편을 즐겨찾기에 추가했습니다');
      await page.waitForTimeout(250);
      const w1 = await writes(page);
      const on = await Promise.all(['p_12', 'p_13', 'p_14'].map((id) => paperOf(page, id)));
      const label = await page.getAttribute('.sel-star', 'aria-label');
      await page.locator('.sel-star').click();
      await toastWith(page, '3편을 즐겨찾기에서 뺐습니다');
      await page.waitForTimeout(250);
      const off = await Promise.all(['p_12', 'p_13', 'p_14'].map((id) => paperOf(page, id)));
      const w2 = await writes(page);
      await page.keyboard.press('Escape');
      assert(on.every((p) => p.starred) && off.every((p) => !p.starred), 'stars');
      assert(label === '즐겨찾기 해제', label);
      assert(w1 - w0 === 1 && w2 - w1 === 1, `writes ${w1 - w0}/${w2 - w1}`);
      return `3 starred in one write → button “${label}” → 3 unstarred in one write`;
    });

    await test('desktop: 다른 서재로 복사… copies the selection (PDF already there reused by sha256) with progress', async () => {
      await clearToasts(page);
      const teamBefore = await libState(page, 'team');
      const pdfsBefore = await page.evaluate(() => [...window.__lsel.syncs.team.files.keys()].filter((k) => k.endsWith('/paper.pdf')).length);
      for (const id of ['p_03', 'p_15', 'p_16']) await page.locator(`${row(id)} .paper-check`).click();
      await page.locator('.sel-copy').click();
      await page.waitForSelector('.copy-dialog .folder-picker');
      const message = (await page.textContent('.copy-dialog .modal-message')).trim();
      await page.locator('.copy-dialog .folder-picker label', { hasText: '공동 자료' }).click();
      await page.locator('.copy-dialog .modal-footer .btn', { hasText: '복사' }).click();
      const t = await toastWith(page, '논문 3편을 전체 공용 서재 ‘공동 자료’ 폴더에 복사했습니다');
      const teamAfter = await libState(page, 'team');
      const pdfsAfter = await page.evaluate(() => [...window.__lsel.syncs.team.files.keys()].filter((k) => k.endsWith('/paper.pdf')).length);
      const added = teamAfter.papers.filter((p) => !teamBefore.papers.some((q) => q.id === p.id));
      const text = (await t.textContent()).trim();
      await shot(page, 'desktop-06-copied');
      await page.keyboard.press('Escape');
      assert(message === '논문 3편을 복사할 서재와 폴더를 고르세요.', message);
      assert(added.length === 2 && added.every((p) => p.folderId === 't_common'), `added ${JSON.stringify(added.map((p) => [p.title, p.folderId]))}`);
      assert(pdfsAfter - pdfsBefore === 2, `PDF uploads ${pdfsAfter - pdfsBefore}`);
      assert(/이미 있던 1편은 폴더에만 넣음/.test(text), text);
      return `“${message}” → ${added.length} new papers in ‘공동 자료’, ${pdfsAfter - pdfsBefore} PDFs uploaded (p_03 matched t_p03 by sha256); toast “${text.replace(/\s+/g, ' ')}”`;
    });

    await test('desktop: 삭제 of the selection in 내 서재 asks once with the count (no 휴지통), one batch', async () => {
      await clearToasts(page);
      for (const id of ['p_17', 'p_18']) await page.locator(`${row(id)} .paper-check`).click();
      const w0 = await writes(page);
      await page.locator('.sel-delete').click();
      const msg = (await page.textContent('.modal .modal-message')).trim();
      await page.locator('.modal-footer .btn-danger').click();
      await toastWith(page, '논문 2편을 삭제했습니다');
      await page.waitForTimeout(300);
      const w1 = await writes(page);
      const gone = !(await paperOf(page, 'p_17')) && !(await paperOf(page, 'p_18'));
      const files = await page.evaluate(() => [...window.__lsel.syncs.mine.files.keys()].filter((k) => /p_1[78]/.test(k)));
      assert(/^논문 2편을 라이브러리에서 삭제할까요\?/.test(msg), msg);
      assert(gone && !files.length, `still there: ${files}`);
      assert(w1 - w0 === 1, `writes ${w1 - w0}`);
      return `“${msg.replace(/\n/g, ' ')}” → both deleted with ${w1 - w0} library.json write, their files removed`;
    });

    await test('desktop: in 공용 서재 삭제 moves the selection to the 휴지통 (30일) and 되돌리기 restores it; switching library clears the selection', async () => {
      await clearToasts(page);
      await page.locator(`${row('p_20')} .paper-check`).click();
      await sideAll(page, 'shared:team').click();
      await page.waitForFunction(() => location.hash === '#/s/team' && document.querySelectorAll('.paper-row').length >= 4);
      const carried = await selectedIds(page);
      for (const id of ['t_a', 't_b', 't_c']) await page.locator(`${row(id)} .paper-check`).click();
      const w0 = await writes(page, 'team');
      await page.locator('.sel-delete').click();
      const title = (await page.textContent('.modal .modal-title')).trim();
      const msg = (await page.textContent('.modal .modal-message')).trim();
      await shot(page, 'desktop-07-shared-delete-confirm');
      await page.locator('.modal-footer .btn', { hasText: '휴지통으로 이동' }).click();
      const t = await toastWith(page, '논문 3편을 휴지통으로 옮겼습니다');
      await page.waitForTimeout(300);
      const w1 = await writes(page, 'team');
      const trash = await page.evaluate(() => window.__lsel.trash('team'));
      await t.locator('.btn', { hasText: '되돌리기' }).click();
      await toastWith(page, '논문 3편을 복구했습니다');
      const back = await Promise.all(['t_a', 't_b', 't_c'].map((id) => paperOf(page, id, 'team')));
      assertEqual(carried, [], 'selection cleared on library change');
      assert(title === '전체 공용 서재에서 3편 삭제' && /^논문 3편을 휴지통으로 이동합니다\. 30일 안에 복구할 수 있습니다\./.test(msg), `${title} / ${msg}`);
      assert(trash.filter((x) => x.kind === 'paper' && x.deletedBy === '김동료').length === 3, JSON.stringify(trash));
      assert(w1 - w0 === 1, `writes ${w1 - w0}`);
      assert(back.every(Boolean), 'restored');
      return `“${title}”: “${msg.replace(/\n/g, ' ')}” → 3 tombstones by 김동료 in one write; 되돌리기 → all 3 back`;
    });

    await test('desktop: single paper ⋯ → 폴더로 이동… keeps its 이동 button; 제목 바꾸기 renames in every library', async () => {
      await clearToasts(page);
      await page.locator(`${row('t_c')} button[aria-label="논문 메뉴"]`).click();
      const items = await page.$$eval('.menu .menu-item', (els) => els.map((e) => e.textContent.trim()));
      await page.locator('.menu .menu-item', { hasText: '제목 바꾸기' }).click();
      await answerPrompt(page, '팀 논문 C (제목 수정)');
      await page.waitForFunction(() => [...document.querySelectorAll('.paper-title')].some((e) => e.textContent === '팀 논문 C (제목 수정)'));
      const renamed = (await paperOf(page, 't_c', 'team')).title;
      await page.locator(`${row('t_c')} button[aria-label="논문 메뉴"]`).click();
      await page.locator('.menu .menu-item', { hasText: '폴더로 이동' }).click();
      const buttons = await page.$$eval('.move-dialog .modal-footer .btn', (els) => els.map((e) => e.textContent.trim()));
      await page.locator('.move-dialog .folder-picker label', { hasText: '프로토콜' }).click();
      await page.locator('.modal-footer button', { hasText: '이동' }).last().click();
      await noModal(page);
      const moved = (await paperOf(page, 't_c', 'team')).folderId;
      assert(items.includes('제목 바꾸기') && items.includes('폴더로 이동…'), `menu ${items}`);
      assert(renamed === '팀 논문 C (제목 수정)', renamed);
      assertEqual(buttons, ['취소', '이동'], 'single move buttons');
      assert(moved === 't_sub', `moved to ${moved}`);
      return `menu [${items.join(', ')}]; 제목 바꾸기 → “${renamed}” (공용 서재); 폴더로 이동… → [${buttons}] → 프로토콜`;
    });

    await test('desktop: folder ⋯ menu → 새 하위 폴더; header 새 하위 폴더 + dashed + 하위 폴더 chip; upload goes into the open folder', async () => {
      await clearToasts(page);
      await sideAll(page, 'mine').click();
      await page.waitForFunction(() => location.hash === '#/');
      const r = page.locator('.lib-sec[data-lib="mine"] .tree-row', { has: page.locator('.tree-item[data-folder="f_misc"]') });
      const hidden = await r.locator('.tree-more').evaluate((e) => getComputedStyle(e).opacity);
      await r.hover();
      await page.waitForTimeout(200);
      const shown = await r.locator('.tree-more').evaluate((e) => getComputedStyle(e).opacity);
      const aria = await r.locator('.tree-more').getAttribute('aria-label');
      await shot(page, 'desktop-08-folder-more-hover');
      await r.locator('.tree-more').click();
      const items = await page.$$eval('.menu .menu-item', (els) => els.map((e) => `${e.textContent.trim()}${e.disabled ? ' (off)' : ''}`));
      await shot(page, 'desktop-09-folder-menu');
      await page.locator('.menu .menu-item', { hasText: '새 하위 폴더' }).click();
      await answerPrompt(page, '하위 A');
      await page.waitForFunction(() => document.querySelector('.lib-title')?.textContent === '하위 A');
      const sub = await folderNamed(page, '하위 A');
      const headerBtn = await page.isVisible('.lib-subfolder-btn');
      const chip = (await page.textContent('.subfolder-add')).trim();
      await shot(page, 'desktop-10-open-folder');
      await page.locator('.subfolder-add').click();
      await answerPrompt(page, '하위 B');
      await page.waitForFunction(() => document.querySelector('.lib-title')?.textContent === '하위 B');
      const subB = await folderNamed(page, '하위 B');
      await page.locator('.lib-subfolder-btn').click();
      await answerPrompt(page, '하위 C');
      await page.waitForFunction(() => document.querySelector('.lib-title')?.textContent === '하위 C');
      const subC = await folderNamed(page, '하위 C');
      await page.setInputFiles('.lib-header input[type=file]', [{ name: 'into-folder.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n% upload into the open folder\n') }]);
      await toastWith(page, '추가했습니다');
      const up = (await libState(page)).papers.find((p) => p.fileName === 'into-folder.pdf');
      const crumbs = (await page.textContent('.lib-crumbs')).replace(/\s+/g, ' ').trim();
      assert(hidden === '0' && shown === '1' && aria === '폴더 메뉴', `⋯ ${hidden}/${shown} ${aria}`);
      assertEqual(items, ['새 하위 폴더', '이름 바꾸기', '다른 폴더 안으로 옮기기…', '최상위로 옮기기 (off)', '다른 서재로 복사…', '삭제'], 'folder menu');
      assert(sub?.parentId === 'f_misc' && subB?.parentId === sub.id && subC?.parentId === subB.id, 'nested subfolders');
      assert(headerBtn && chip === '하위 폴더', `header ${headerBtn}, chip ${chip}`);
      assert(up?.folderId === subC.id, `upload into ${up?.folderId}`);
      return `⋯ (aria “${aria}”) hidden→shown on hover; menu [${items.join(', ')}]; 기타 › 하위 A (menu) › 하위 B (dashed chip) › 하위 C (header button); PDF upload landed in 하위 C; crumbs “${crumbs}”`;
    });

    await test('desktop: 다른 폴더 안으로 옮기기… excludes the folder and its subfolders; a drop into its own subfolder is refused', async () => {
      await clearToasts(page);
      const r = page.locator('.lib-sec[data-lib="mine"] .tree-row', { has: page.locator('.tree-item[data-folder="f_icu"]') });
      await r.hover();
      await r.locator('.tree-more').click();
      await page.locator('.menu .menu-item', { hasText: '다른 폴더 안으로 옮기기…' }).click();
      await page.waitForSelector('.move-dialog .folder-picker');
      const labels = await pickerLabels(page);
      await page.locator('.move-dialog .folder-picker label', { hasText: '기타' }).click();
      await page.locator('.move-dialog .modal-footer .btn', { hasText: '옮기기' }).click();
      await noModal(page);
      const t = await toastWith(page, '‘중환자 간호’ 폴더를 ‘기타’ 안으로 옮겼습니다');
      const icu = await folderNamed(page, '중환자 간호');
      // 기타 is now an ancestor of 섬망: dropping 기타 onto 섬망 must not happen.
      await page.locator('.lib-sec[data-lib="mine"] .tree-row', { has: page.locator('.tree-item[data-folder="f_icu"]') }).locator('.tree-toggle').click().catch(() => {});
      await sideItem(page, 'mine', 'f_delir').waitFor();
      await sideItem(page, 'mine', 'f_misc').dragTo(sideItem(page, 'mine', 'f_delir'));
      await page.waitForTimeout(300);
      const misc = await folderNamed(page, '기타');
      const refused = await page.evaluate(() => { try { window.__lsel.mine.moveFolder('f_misc', 'f_delir'); return 'moved'; } catch (err) { return err.message; } });
      await t.locator('.btn', { hasText: '되돌리기' }).click();
      await page.waitForTimeout(200);
      const icuBack = await folderNamed(page, '중환자 간호');
      assert(!labels.some((l) => ['중환자 간호', '섬망', '평가 도구', '기계환기', '선택 테스트'].includes(l)), `picker shows the subtree: ${labels}`);
      assert(labels.includes('기타') && labels.includes('통계'), `picker ${labels}`);
      assert(icu.parentId === 'f_misc', `moved ${icu.parentId}`);
      assert(misc.parentId === null, `기타 moved into its own subfolder: ${misc.parentId}`);
      assert(/자기 자신이나 하위 폴더/.test(refused), refused);
      assert(icuBack.parentId === null, '되돌리기');
      return `picker [${labels.join(' / ')}] (no 중환자 간호 subtree); moved into 기타; drag 기타 → 섬망 refused (store: “${refused}”); 되돌리기 → top level again`;
    });

    await test('desktop: deep folders — the open folder’s ancestors expand, indentation stops after 6 levels', async () => {
      await clearToasts(page);
      const ids = await page.evaluate(() => {
        const lib = window.__lsel.mine;
        let parent = null;
        const out = [];
        for (let i = 1; i <= 8; i++) { parent = lib.createFolder(`깊이 ${i}`, parent).id; out.push(parent); }
        return out;
      });
      await page.waitForTimeout(150);
      await sideItem(page, 'mine', ids[0]).click();
      for (let i = 2; i <= 8; i++) {
        await page.locator('.subfolder:not(.subfolder-add)', { hasText: `깊이 ${i}` }).click();
        await page.waitForFunction((n) => document.querySelector('.lib-title')?.textContent === n, `깊이 ${i}`);
      }
      const tree = await page.$$eval('.lib-sec[data-lib="mine"] .tree-item.is-folder', (els) => els
        .filter((e) => /^깊이/.test(e.querySelector('.tree-label').textContent))
        .map((e) => ({ name: e.querySelector('.tree-label').textContent, depth: e.style.getPropertyValue('--depth'), pad: getComputedStyle(e).paddingLeft, current: e.getAttribute('aria-current') })));
      await shot(page, 'desktop-11-deep-tree');
      assertEqual(tree.map((x) => x.depth), ['0', '1', '2', '3', '4', '5', '6', '6'], 'capped depth');
      assert(tree[7].current === 'true' && tree[6].pad === tree[7].pad, JSON.stringify(tree.slice(5)));
      return `8 nested folders all visible (ancestors expanded); --depth ${tree.map((x) => x.depth).join(',')}; padding ${tree[5].pad} / ${tree[6].pad} / ${tree[7].pad}`;
    });
    await page.context().close();
  }

  // ------------------------------------------------------------- picker search, one library, dark
  await test('desktop: picker with >15 folders has a search box (matches + ancestors), Esc clears the search first', async () => {
    const { page } = await open(edge, 'picker-search', { query: '&folders=20&libs=one' });
    await page.locator(`${row('p_01')} .paper-check`).click();
    const bar = await page.$$eval('.sel-actions .sel-btn', (els) => els.map((b) => b.getAttribute('aria-label')));
    await page.locator('.sel-move').click();
    await page.waitForSelector('.move-dialog .folder-pick-search input');
    const focused = await page.evaluate(() => document.activeElement?.type);
    const all = (await pickerLabels(page)).length;
    await page.fill('.move-dialog .folder-pick-search input', '평가');
    const found = await pickerLabels(page);
    const marks = await page.$$eval('.move-dialog .folder-picker mark', (els) => els.map((e) => e.textContent));
    await shot(page.locator('.move-dialog'), 'desktop-12-picker-search');
    await page.keyboard.press('Escape');
    const stillOpen = await page.isVisible('.move-dialog');
    const cleared = (await pickerLabels(page)).length;
    await page.keyboard.press('Escape');
    await noModal(page);
    await page.context().close();
    assert(!bar.includes('다른 서재로 복사…'), `copy shown with one library: ${bar}`);
    assert(focused === 'search', `focus ${focused}`);
    assertEqual(found, ['최상위 (폴더 없음)', '중환자 간호', '섬망', '평가 도구'], 'search shows matches with their ancestors');
    assertEqual(marks, ['평가'], 'match highlighted');
    assert(stillOpen && cleared === all, `Esc: open=${stillOpen} rows ${cleared}/${all}`);
    return `26 folders → search box focused; “평가” → [${found.join(' › ')}] (mark “${marks}”); Esc cleared the search (dialog stays), second Esc closed it; one library → no 복사 in the bar`;
  });

  await test('desktop 1024/900: count line scrolls away until selecting; short labels in the bar; Ctrl+A with nothing focused; header on one line with a folder open; 로 after an abbreviation', async () => {
    const { page } = await open(edge, 'narrow', { context: { viewport: { width: 1024, height: 768 } } });
    const position = () => page.$eval('.lib-listbar', (e) => getComputedStyle(e).position);
    const idle = await position();
    await page.locator(`${row('p_01')} .paper-check`).click();
    await page.mouse.move(1000, 700);
    await page.waitForTimeout(150);
    const selecting = await position();
    const shorts = await page.$$eval('.sel-actions .sel-btn', (els) => els.map((b) => [getComputedStyle(b.querySelector('.sel-short')).display, getComputedStyle(b.querySelector('.btn-label')).display, b.querySelector('.sel-short').textContent]));
    const fits = await page.$eval('.lib-listbar-inner', (e) => e.scrollWidth <= e.clientWidth && e.querySelector('.lib-count-text').scrollWidth <= e.querySelector('.lib-count-text').clientWidth);
    await shot(page, 'desktop-14-1024-short-labels');
    // 선택 해제 from the keyboard: the bar hides, the focus lands on 전체 선택 (not on nothing).
    await page.locator('.sel-clear').focus();
    await page.keyboard.press('Enter');
    const focusAfterClear = await page.evaluate(() => document.activeElement?.className || '');
    await page.locator(`${row('p_01')} .paper-check`).click();
    // Safari does not focus a clicked checkbox: Ctrl/Cmd+A with nothing focused still selects every row shown.
    await page.evaluate(() => document.activeElement?.blur());
    await page.keyboard.press('Control+a');
    const all = (await selectedIds(page)).length;
    await page.keyboard.press('Escape');
    const none = (await selectedIds(page)).length;
    // 로/으로 after an abbreviation (NAVA → 나바로)
    await page.evaluate(() => window.__lsel.mine.createFolder('NAVA', null));
    for (const id of ['p_02', 'p_03']) await page.locator(`${row(id)} .paper-check`).click();
    await page.locator('.sel-move').click();
    await page.locator('.move-dialog .folder-picker label', { hasText: 'NAVA' }).click();
    await page.locator('.move-dialog .modal-footer .btn', { hasText: '옮기기' }).click();
    await noModal(page);
    const moved = (await (await toastWith(page, '2편을 ‘NAVA’')).textContent()).replace('되돌리기', '').trim();
    await clearToasts(page);
    // A folder open: '새 하위 폴더' icon-only, PDF 추가 stays on the controls' line (1024 and 900 wide).
    await page.locator('.lib-sec[data-lib="mine"] .tree-item[data-folder="f_stats"]').click();
    await page.mouse.move(1000, 700);
    await page.waitForTimeout(200);
    const lines = async () => page.$$eval('.lib-actions > *', (els) => [...new Set(els.filter((e) => !e.hidden && e.offsetParent && e.tagName !== 'INPUT')
      .map((e) => Math.round(e.getBoundingClientRect().top + e.getBoundingClientRect().height / 2)))]);
    const at1024 = await lines();
    const sub = await page.$eval('.lib-subfolder-btn', (e) => [Math.round(e.getBoundingClientRect().width), getComputedStyle(e.querySelector('.btn-label')).display]);
    // the folder just clicked keeps its count (its ⋯ shows on hover or keyboard focus, not after a mouse click)
    const side = await page.$eval('.lib-sec[data-lib="mine"] .tree-row:has(> .tree-item[data-folder="f_stats"])', (r) => [getComputedStyle(r.querySelector('.tree-count')).visibility, getComputedStyle(r.querySelector('.tree-more')).opacity]);
    await shot(page, 'desktop-15-1024-folder-header');
    await page.setViewportSize({ width: 900, height: 760 });
    await page.waitForTimeout(200);
    const at900 = await lines();
    await shot(page, 'desktop-16-900-folder-header');
    await page.context().close();
    assert(idle === 'static' && selecting === 'sticky', `count line position ${idle} → ${selecting}`);
    assert(shorts.every(([s, l]) => s !== 'none' && l === 'none'), `labels ${JSON.stringify(shorts)}`);
    assertEqual(shorts.map((x) => x[2]), ['이동', '복사', '즐겨찾기', '삭제', '해제'], 'short labels');
    assert(fits, 'action bar fits at 1024');
    assert(all === 60 && none === 0, `Ctrl+A ${all}, Esc ${none}`);
    assert(focusAfterClear.includes('lib-select-all-check'), `focus after 선택 해제: ${focusAfterClear}`);
    assert(moved.startsWith('2편을 ‘NAVA’로 옮겼습니다'), moved);
    assert(at1024.length === 1 && at900.length === 1, `header lines 1024 ${at1024} / 900 ${at900}`);
    assert(sub[0] <= 36 && sub[1] === 'none', `새 하위 폴더 ${sub}`);
    assertEqual(side, ['visible', '0'], 'clicked folder keeps its count');
    return `count line static → sticky; bar [${shorts.map((x) => x[2]).join(' · ')}] fits; 선택 해제 by keyboard → focus on 전체 선택; Ctrl+A (nothing focused) → ${all}, Esc → ${none}; “${moved}”; folder header on one line at 1024 and 900 (새 하위 폴더 ${sub[0]}px icon-only); clicked folder keeps its count`;
  });

  await test('desktop dark theme: action bar and selected rows keep the 갈피 tokens', async () => {
    const { page } = await open(edge, 'dark', { context: { colorScheme: 'dark' } });
    await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
    for (const id of ['p_02', 'p_03']) await page.locator(`${row(id)} .paper-check`).click();
    await page.mouse.move(5, 5);
    await page.waitForTimeout(150);
    await shot(page, 'desktop-13-dark-selected');
    const c = await page.$eval(`${row('p_02')} .paper-check`, (e) => getComputedStyle(e).backgroundColor);
    await page.context().close();
    assert(c === 'rgb(204, 156, 131)', `checked box ${c}`);
    return `checked box ${c} (latte accent); screenshot desktop-13-dark-selected.png`;
  });

  // ======================================================================= phones
  const phones = [['Pixel 7', edge, 'pixel']];
  if (wk) phones.push(['iPhone 15', wk, 'iphone']);
  for (const [profile, browser, tag] of phones) {
    const { ctx, page } = await open(browser, tag, { context: { ...devices[profile] } });
    const cdp = browser === edge ? await ctx.newCDPSession(page) : null;
    /** Hold a touch on `selector` for `ms` (CDP touch on Chromium; touch pointer events on WebKit). */
    const longPress = async (selector, ms = 700) => {
      const box = await page.locator(selector).first().boundingBox();
      const x = box.x + box.width / 2;
      const y = box.y + Math.min(box.height / 2, 20);
      if (cdp) {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
        await page.waitForTimeout(ms);
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      } else {
        await page.evaluate(({ selector, x, y }) => {
          const target = document.elementFromPoint(x, y) || document.querySelector(selector);
          const init = { bubbles: true, cancelable: true, composed: true, pointerType: 'touch', isPrimary: true, pointerId: 7, clientX: x, clientY: y };
          document.dispatchEvent(new PointerEvent('pointerdown', { ...init, bubbles: false })); // the view's own pointer tracking
          target.dispatchEvent(new PointerEvent('pointerdown', init));
          window.__lpTarget = target;
          window.__lpInit = init;
        }, { selector, x, y });
        await page.waitForTimeout(ms);
        await page.evaluate(() => window.__lpTarget.dispatchEvent(new PointerEvent('pointerup', window.__lpInit)));
      }
      await page.waitForTimeout(150);
    };

    await test(`${profile}: checkboxes always shown, rows not draggable, long press starts selecting, taps toggle, bottom action bar`, async () => {
      const vp = page.viewportSize();
      const opacity = await page.$eval(`${row('p_01')} .paper-check`, (e) => getComputedStyle(e).opacity);
      const draggable = await page.getAttribute(row('p_01'), 'draggable');
      const hash0 = await page.evaluate(() => location.hash);
      await longPress(`${row('p_02')} .paper-title`);
      const afterPress = await selectedIds(page);
      const hash1 = await page.evaluate(() => location.hash);
      const menus = await page.locator('.menu').count();
      await page.locator(`${row('p_03')} .paper-link`).tap();
      await page.locator(`${row('p_04')} .paper-pick`).tap();
      await page.waitForTimeout(150);
      const afterTaps = await selectedIds(page);
      const hash2 = await page.evaluate(() => location.hash);
      const bar = await page.locator('.sel-actions').boundingBox();
      const shorts = await page.$$eval('.sel-actions .sel-short', (els) => els.map((e) => e.textContent));
      const pad = await page.$eval('.lib-content', (e) => parseFloat(getComputedStyle(e).paddingBottom));
      const overflow = await page.evaluate(() => document.scrollingElement.scrollWidth - window.innerWidth);
      await shot(page, `${tag}-01-selecting`);
      await page.locator(`${row('p_03')} .paper-link`).tap(); // untoggle
      const afterUntap = await selectedIds(page);
      assert(opacity === '1', `checkbox opacity ${opacity}`);
      assert(draggable === 'false', `draggable ${draggable}`);
      assertEqual(afterPress, ['p_02'], 'long press selected the row');
      assert(hash0 === hash1 && hash1 === hash2 && menus === 0, `no paper opened / no menu (${hash1}, ${hash2}, menus ${menus})`);
      assertEqual(afterTaps, ['p_02', 'p_03', 'p_04'], 'taps toggled');
      assert(Math.abs(bar.y + bar.height - vp.height) <= 2 && bar.width >= vp.width - 1, `bar ${JSON.stringify(bar)} viewport ${JSON.stringify(vp)}`);
      assertEqual(shorts, ['이동', '복사', '즐겨찾기', '삭제', '해제'], 'bottom bar labels');
      assert(pad >= 80 && overflow <= 0, `padding ${pad}, overflow ${overflow}`);
      assertEqual(afterUntap, ['p_02', 'p_04'], 'tap again unselects');
      return `checkbox opacity 1, draggable=false; long press → [${afterPress}] (no reader, no menu); taps → [${afterTaps}]; bottom bar ${Math.round(bar.width)}×${Math.round(bar.height)} at y=${Math.round(bar.y)} [${shorts.join(' · ')}]; list padded ${pad}px; no horizontal scroll`;
    });

    await test(`${profile}: the folder picker works by touch (이동 → 통계 → 옮기기)`, async () => {
      await page.locator('.sel-move').tap();
      await page.waitForSelector('.move-dialog .folder-picker');
      const dlg = await page.locator('.move-dialog').boundingBox();
      const vp = page.viewportSize();
      await shot(page, `${tag}-02-picker`);
      await page.locator('.move-dialog .folder-picker label', { hasText: '통계' }).tap();
      await page.locator('.move-dialog .modal-footer .btn', { hasText: '옮기기' }).tap();
      await noModal(page);
      await toastWith(page, '2편을 ‘통계’로 옮겼습니다');
      const toastBox = await page.locator('.toast').last().boundingBox();
      const moved = await Promise.all(['p_02', 'p_04'].map((id) => paperOf(page, id)));
      const sel = await selectedIds(page);
      assert(dlg.x >= 0 && dlg.x + dlg.width <= vp.width && dlg.y >= 0 && dlg.y + dlg.height <= vp.height, `dialog ${JSON.stringify(dlg)}`);
      assert(moved.every((p) => p.folderId === 'f_stats'), 'moved');
      assertEqual(sel, [], 'selection cleared');
      return `dialog ${Math.round(dlg.width)}×${Math.round(dlg.height)} fits ${vp.width}×${vp.height}; 2 papers → 통계; toast at y=${Math.round(toastBox.y)}`;
    });

    await test(`${profile}: drawer — ⋯ on every folder, long press opens the folder menu; header 새 하위 폴더 is icon-only`, async () => {
      await clearToasts(page);
      await page.locator('.lib-menu-btn').tap();
      await page.waitForTimeout(350);
      const more = await page.$$eval('.lib-sec[data-lib="mine"] .tree-more', (els) => els.map((e) => getComputedStyle(e).opacity));
      await shot(page, `${tag}-03-drawer`);
      await page.locator('.lib-sec[data-lib="mine"] .tree-row', { has: page.locator('.tree-item[data-folder="f_misc"]') }).locator('.tree-more').tap();
      const items = await page.$$eval('.menu .menu-item', (els) => els.map((e) => e.textContent.trim()));
      await page.keyboard.press('Escape');
      await page.waitForTimeout(100);
      await longPress('.lib-sec[data-lib="mine"] .tree-item[data-folder="f_stats"]');
      const pressItems = await page.$$eval('.menu .menu-item', (els) => els.map((e) => e.textContent.trim()));
      const selectedFolder = await page.evaluate(() => document.querySelector('.lib-title')?.textContent);
      await shot(page, `${tag}-04-folder-longpress-menu`);
      await page.keyboard.press('Escape');
      await page.locator('.lib-sec[data-lib="mine"] .tree-item[data-folder="f_stats"]').tap();
      await page.waitForFunction(() => document.querySelector('.lib-title')?.textContent === '통계');
      await page.waitForTimeout(250);
      const btn = await page.locator('.lib-subfolder-btn').boundingBox();
      const label = await page.$eval('.lib-subfolder-btn .btn-label', (e) => getComputedStyle(e).display);
      const overflow = await page.evaluate(() => [document.scrollingElement, document.querySelector('.lib-header')].map((e) => e.scrollWidth - e.clientWidth));
      await shot(page, `${tag}-05-folder-open`);
      assert(more.length >= 3 && more.every((o) => o === '1'), `⋯ opacity ${more}`);
      assert(items.includes('다른 폴더 안으로 옮기기…') && pressItems.includes('새 하위 폴더'), `menus ${items} / ${pressItems}`);
      assert(selectedFolder !== '통계', 'the long press did not open the folder');
      assert(label === 'none' && btn.width <= 36, `header button ${label} ${btn.width}`);
      assert(overflow.every((o) => o <= 1), `overflow ${overflow}`);
      return `⋯ shown on ${more.length} folders; ⋯ tap → [${items.join(', ')}]; long press on 통계 → menu (folder not opened); open folder → 새 하위 폴더 icon-only (${Math.round(btn.width)}px), no overflow`;
    });
    await ctx.close();
  }
  if (!wk) results.push({ name: 'iPhone 15 (WebKit)', result: 'skipped', evidence: 'WebKit could not be launched' });
} finally {
  await edge.close();
  await wk?.close();
  if (server) server.kill();
  writeFileSync(`${OUT}/results.json`, JSON.stringify({ results, problems }, null, 2));
  const failed = results.filter((r) => r.result === 'fail').length;
  console.log(`\n${results.filter((r) => r.result === 'pass').length}/${results.length} passed${problems.length ? `; problems: ${problems.length}` : ''}. Results: ${OUT}/results.json`);
  process.exitCode = failed ? 1 : 0;
}
