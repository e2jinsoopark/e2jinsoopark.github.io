// 초대 코드 삭제 — app side, end to end (no paid API, no real relay, no GitHub):
//   node tests/onboarding/code-delete.mjs [--headed]     (starts `python -m http.server 8231` if nothing is listening)
// 1. 설정 → 초대 코드 관리: every code row has 삭제 next to 중지/다시 사용; one question (title ‘<name>’ 코드를 삭제할까요?,
//    two lines, 취소 focused, 삭제 danger); GitHub unreachable (502) → the Worker's Korean message, the dialog and the code
//    stay; again → DELETE /relay/admin/codes/:code, the row goes, toast 삭제했습니다.; the totals keep the deleted code's
//    usage and one muted row 삭제된 코드 shows its month; an older Worker (405) and an already deleted code (404).
// 2. A device whose saved code was deleted: /relay/me, /shared or the 공용 서재 proxy answers 401 → the code is forgotten
//    once (no request loop) → the first screen with “초대 코드가 더 이상 쓰이지 않아요. 새 코드를 넣어 주세요.”; with an own
//    API key → a toast with the same words, 내 서재 and the own key stay, 공용 서재 goes.
// 3. A code that never worked here (typed in 설정) answering 401: only the error where it was typed.
// The app talks to https://relay.test (route-intercepted): tests/relay-client/fake-relay.mjs (codes, admin, DELETE) and,
// for /shared*, tests/store/fake-relay.mjs in front of tests/store/fake-github.mjs. Edge (+ WebKit iPhone for the first
// screen). Results + screenshots: C:/Users/dindoo/Projects/pr-tools/out/code-delete/app/.
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, devices, webkit } from 'file:///C:/Users/dindoo/Projects/pr-tools/node_modules/playwright/index.mjs';
import { ADMIN_TOKEN, CODES, createFakeRelay, DELETE_FAILED_MESSAGE, RELAY_URL } from '../relay-client/fake-relay.mjs';
import { startFakeGitHub } from '../store/fake-github.mjs';
import { startFakeRelay as startTeamRelay } from '../store/fake-relay.mjs';

const PORT = Number(process.env.PR_TEST_PORT) || 8231;
const ORIGIN = `http://localhost:${PORT}`;
const APP = `${ORIGIN}/index.html`;
const OUT = 'C:/Users/dindoo/Projects/pr-tools/out/code-delete/app';
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SETTINGS_KEY = 'pr.settings.v1';
const HEADED = process.argv.includes('--headed');
const GONE = '초대 코드가 더 이상 쓰이지 않아요. 새 코드를 넣어 주세요.';
const BAD_CODE = '초대 코드가 올바르지 않거나 사용이 중지되었습니다.';
// Codes for the "deleted while in use" scenarios (Crockford: no I, L, O, U), one per scenario.
const C = { fresh: 'PR-DE1E-TE01', session: 'PR-DE1E-TE02', own: 'PR-DE1E-TE03', ios: 'PR-DE1E-TE04', settings: 'PR-DE1E-TE05', home: 'PR-DE1E-TE06' };

mkdirSync(OUT, { recursive: true });
const results = [];
const problems = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function assertEqual(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg}: expected ${e}, got ${a}`);
}
async function test(name, fn) {
  const t0 = Date.now();
  const before = problems.length;
  try {
    const evidence = await fn();
    const fresh = problems.slice(before);
    if (fresh.length) throw new Error(`console/page/CSP problems during the test:\n  ${fresh.join('\n  ')}`);
    results.push({ name, result: 'pass', evidence: String(evidence ?? 'ok'), ms: Date.now() - t0 });
    console.log(`PASS  ${name}  (${Date.now() - t0} ms)\n      ${evidence ?? ''}`);
  } catch (err) {
    results.push({ name, result: 'fail', evidence: err?.stack || String(err), ms: Date.now() - t0 });
    console.log(`FAIL  ${name}\n      ${err?.stack || err}`);
  }
}

async function serverUp() {
  try { return (await fetch(`http://127.0.0.1:${PORT}/index.html`)).ok; } catch { return false; }
}
function testCopyOfIndex() {
  const html = readFileSync(`${REPO}/index.html`, 'utf8');
  const out = html.replace(/(connect-src [^;"]*)/, `$1 ${RELAY_URL}`);
  if (out === html) throw new Error('could not find connect-src in index.html');
  return out;
}
const INDEX = testCopyOfIndex();

let server = null;
if (!(await serverUp())) {
  server = spawn('python', ['-m', 'http.server', String(PORT)], { cwd: REPO, stdio: 'ignore', windowsHide: true });
  for (let i = 0; i < 80 && !(await serverUp()); i++) await sleep(100);
  if (!(await serverUp())) throw new Error('static server did not start');
}
const github = await startFakeGitHub({ port: 0 });
const TEAM = { owner: 'dindoopark', repo: 'paper-team-library', token: 'ghp_team_test_token' };
github.addToken(TEAM.token, { write: true, repos: [`${TEAM.owner}/${TEAM.repo}`] });
github.createRepo(TEAM.owner, TEAM.repo, { private: true, files: { 'README.md': '# 공용 서재' } });
const team = await startTeamRelay({ github, owner: TEAM.owner, repo: TEAM.repo, token: TEAM.token, lib: 'team', libName: '공용 서재' });
team.addCode(CODES.haiku, '홍길동');
for (const [k, code] of Object.entries(C)) team.addCode(code, `동료${k}`);

const edge = await chromium.launch({ channel: 'msedge', headless: !HEADED });
let wk = null;
try { wk = await webkit.launch({ headless: !HEADED }); } catch (err) { console.log(`WebKit unavailable: ${err.message.split('\n')[0]}`); }

/** One relay for a test: fake-relay.mjs (codes, admin) + 공용 서재 through the team fake. Records every request. */
function makeRelay({ extraCodes = true } = {}) {
  const fake = createFakeRelay();
  if (extraCodes) for (const [k, code] of Object.entries(C)) fake.db.set(code, { ...fake.db.get(CODES.haiku), code, name: `동료${k}`, todayUsd: 0, todayRequests: 0 });
  const seen = []; // { method, path, code }
  const route = async (r) => {
    const req = r.request();
    const url = new URL(req.url());
    const h = req.headers();
    if (req.method() !== 'OPTIONS') {
      seen.push({ method: req.method(), path: url.pathname, code: h['x-api-key'] || /^Bearer (.+)$/.exec(h.authorization || '')?.[1] || '' });
    }
    if (url.pathname === '/shared' || url.pathname.startsWith('/shared/')) {
      try {
        const response = await r.fetch({ url: `${team.url}${url.pathname}${url.search}` });
        return r.fulfill({ response });
      } catch {
        return r.abort('connectionfailed');
      }
    }
    return fake.handle(r);
  };
  /** As the Worker's DELETE does: the code is gone for every endpoint (its 공용 서재 files too). */
  const remove = (code) => { fake.db.delete(code); team.setActive(code, false); };
  /** Requests that carried `code` (any endpoint). */
  const withCode = (code) => seen.filter((s) => s.code.replace(/-/g, '').toUpperCase() === code.replace(/-/g, ''));
  return { fake, route, remove, withCode, seen };
}

async function device({ seed = { relay: { url: RELAY_URL } }, viewport = { width: 1280, height: 900 }, relay = makeRelay(), name = 'device',
  engine = 'edge', profile = null, theme = null, standalone = false } = {}) {
  const browser = engine === 'webkit' ? wk : edge;
  const base = profile ? { ...devices[profile] } : { viewport };
  delete base.defaultBrowserType;
  const ctx = await browser.newContext({ ...base, locale: 'ko-KR', colorScheme: 'light', reducedMotion: 'reduce' });
  const hostRe = new RegExp(`^https?:\\/\\/(?!localhost:${PORT}\\/|relay\\.test\\/)`);
  await ctx.route(hostRe, (route) => {
    const url = route.request().url();
    if (url.startsWith('https://cdn.jsdelivr.net/gh/orioncactus/pretendard')) return route.fulfill({ status: 200, contentType: 'text/css', body: '/* font stub */' });
    problems.push(`${name}: external request blocked ${url}`);
    return route.abort();
  });
  await ctx.route(new RegExp(`^http:\\/\\/localhost:${PORT}\\/index\\.html(?:\\?.*)?$`), (route) => route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: INDEX }));
  await ctx.route(`${RELAY_URL}/**`, relay.route);
  const fullSeed = theme ? { ...seed, ui: { ...(seed?.ui || {}), theme } } : seed;
  await ctx.addInitScript(({ key, seed, standalone }) => {
    try { if (seed && !localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify(seed)); } catch { /* blocked */ }
    if (standalone) {
      // An iPhone home-screen app: navigator.standalone and display-mode: standalone.
      try { Object.defineProperty(Navigator.prototype, 'standalone', { get: () => true, configurable: true }); } catch { /* ignore */ }
      const mm = window.matchMedia.bind(window);
      window.matchMedia = (q) => (/display-mode:\s*standalone/.test(q)
        ? { matches: true, media: q, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; } }
        : mm(q));
    }
    document.addEventListener('securitypolicyviolation', (e) => console.error(`[csp] ${e.violatedDirective} blocked ${e.blockedURI}`));
    // Native dialogs are not allowed in this app.
    for (const fn of ['alert', 'confirm', 'prompt']) window[fn] = () => { console.error(`[native ${fn}]`); return null; };
  }, { key: SETTINGS_KEY, seed: fullSeed, standalone });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => problems.push(`${name}: pageerror ${e.message}`));
  page.on('dialog', (d) => { problems.push(`${name}: native dialog ${d.type()}`); d.dismiss().catch(() => {}); });
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    if (/^Failed to load resource/.test(m.text()) && String(m.location()?.url || '').startsWith(RELAY_URL)) return; // refusals asked for
    problems.push(`${name}: console.error ${m.text()}`);
  });
  return { ctx, page, relay, name };
}

const shot = (target, file, opts = {}) => target.screenshot({ path: `${OUT}/${file}.png`, ...opts });
const stored = (page) => page.evaluate((key) => JSON.parse(localStorage.getItem(key) || '{}'), SETTINGS_KEY);
const overflow = (page) => page.evaluate(() => [document.scrollingElement, ...document.querySelectorAll('.start, .start-card, .settings, .relay-code, .modal')]
  .filter((e) => e && e.scrollWidth > e.clientWidth + 1).map((e) => `${e.className || e.nodeName} ${e.scrollWidth}>${e.clientWidth}`));
const toasts = (page) => page.$$eval('.toast .toast-msg', (els) => els.map((e) => e.textContent.trim()));
const sharedSection = (page) => page.locator('.lib-sec[data-lib^="shared:"]').count();
async function openAdmin(page) {
  await page.goto(`${APP}#/settings/invites`);
  await page.locator('#set-invites summary', { hasText: '관리 화면 열기' }).click();
  await page.waitForSelector('#set-invites .relay-code[data-code]');
}
const rowCodes = (page) => page.$$eval('#set-invites .relay-code[data-code]', (els) => els.map((e) => e.dataset.code));
const deleteBtn = (page, code) => page.locator(`#set-invites .relay-code[data-code="${code}"] .btn`, { hasText: '삭제' });

try {
  await test('admin: every code row has 삭제 next to 중지/다시 사용; one question; GitHub down (502) keeps code and dialog; again → row gone, toast, totals + 삭제된 코드', async () => {
    // A tall window: the settings view scrolls inside itself, so an element screenshot shows only what is in view.
    const d = await device({ seed: { relay: { url: RELAY_URL, adminToken: ADMIN_TOKEN } }, viewport: { width: 1280, height: 2000 }, name: 'admin', relay: makeRelay({ extraCodes: false }) });
    const { page, relay } = d;
    await openAdmin(page);
    const actions = await page.$$eval('#set-invites .relay-code[data-code]', (els) => els.map((e) => [...e.querySelectorAll('.relay-code-actions .btn')].map((b) => b.textContent.trim())));
    const before = { deletedRow: await page.locator('#set-invites .relay-code.is-deleted-total').count(), month: (await page.locator('#set-invites .stat', { hasText: '이번 달 전체' }).innerText()).replace(/\s+/g, ' ') };
    await page.evaluate(() => document.fonts?.ready);
    await shot(page.locator('#set-invites'), 'admin-list-with-delete');

    // The question.
    await deleteBtn(page, CODES.haiku).click();
    await page.waitForSelector('.modal');
    const modal = await page.evaluate(() => {
      const m = document.querySelector('.modal');
      return {
        title: m.querySelector('.modal-title').textContent,
        lines: [...m.querySelectorAll('.modal-body p')].map((p) => p.textContent),
        choices: [...m.querySelectorAll('.relay-lib-choice .radio-card')].map((c) => `${c.querySelector('input').checked ? '●' : '○'} ${c.querySelector('.radio-title').textContent}`),
        buttons: [...m.querySelectorAll('.modal-footer .btn')].map((b) => [b.textContent.trim(), b.className.includes('btn-danger')]),
        focused: document.activeElement?.textContent?.trim(),
      };
    });
    const box = await page.locator('.modal').boundingBox();
    await shot(page, 'delete-confirm-modal', { clip: { x: Math.max(0, box.x - 160), y: Math.max(0, box.y - 120), width: box.width + 320, height: box.height + 240 } });
    assertEqual(modal.title, '‘홍길동’ 코드를 삭제할까요?', 'modal title');
    assertEqual(modal.lines, ['이 코드로는 더 이상 들어올 수 없고, 전체 공용 서재에 남긴 하이라이트·메모·AI 기록도 지워집니다.', '전체 공용 서재의 논문·폴더·번역과 사용 비용 기록은 그대로 남습니다.'], 'modal lines');
    // The code's own library (code libraries, 2026-10-19): 서재도 함께 삭제 (default) or 다른 코드로 옮기기.
    assertEqual(modal.choices, ['● 서재도 함께 삭제', '○ 다른 코드로 옮기기'], 'library choices');
    assertEqual(modal.buttons, [['취소', false], ['삭제', true]], 'modal buttons');
    assertEqual(modal.focused, '취소', 'focus (Enter must not delete)');

    // GitHub unreachable: the Worker's 502 message, nothing deleted, the dialog stays for another try.
    relay.fake.deletion.githubDown = true;
    await page.locator('.modal-footer .btn-danger').click();
    await page.waitForSelector(`.toast-error >> text=${DELETE_FAILED_MESSAGE}`);
    const afterFail = { modal: await page.locator('.modal').count(), row: await page.locator(`#set-invites .relay-code[data-code="${CODES.haiku}"]`).count(), inDb: relay.fake.db.has(CODES.haiku), label: (await page.locator('.modal-footer .btn-danger').innerText()).trim() };
    await shot(page, 'delete-github-down');
    assertEqual(afterFail, { modal: 1, row: 1, inDb: true, label: '삭제' }, 'after a 502');

    // Again, GitHub back: deleted.
    relay.fake.deletion.githubDown = false;
    relay.fake.deletion.files.set(CODES.haiku, 3);
    await page.locator('.modal-footer .btn-danger').click();
    await page.waitForSelector('.toast >> text=삭제했습니다.');
    await page.waitForSelector('.modal', { state: 'detached' });
    await page.waitForSelector('#set-invites .relay-code.is-deleted-total');
    const dels = relay.fake.calls.filter((c) => c.method === 'DELETE');
    const after = {
      rows: await rowCodes(page),
      deletedRow: (await page.locator('#set-invites .relay-code.is-deleted-total').innerText()).replace(/\s+/g, ' ').trim(),
      month: (await page.locator('#set-invites .stat', { hasText: '이번 달 전체' }).innerText()).replace(/\s+/g, ' '),
      today: (await page.locator('#set-invites .stat', { hasText: '오늘 전체' }).innerText()).replace(/\s+/g, ' '),
      active: (await page.locator('#set-invites .stat', { hasText: '사용 중인 코드' }).innerText()).replace(/\s+/g, ' '),
    };
    for (const x of await page.$$('.toast .toast-close')) await x.click().catch(() => {}); // earlier toasts out of the picture
    await page.waitForTimeout(300);
    await shot(page.locator('#set-invites'), 'admin-list-deleted-total');
    assert(actions.every((a) => a.includes('삭제') && a.indexOf('삭제') === a.length - 1 && (a.includes('중지') || a.includes('다시 사용'))), `row actions ${JSON.stringify(actions)}`);
    assertEqual(before.deletedRow, 0, '삭제된 코드 row while nothing is deleted');
    assertEqual(dels.map((c) => [c.path, c.search, c.headers.authorization]), [[`/relay/admin/codes/${CODES.haiku}`, '?library=delete', `Bearer ${ADMIN_TOKEN}`], [`/relay/admin/codes/${CODES.haiku}`, '?library=delete', `Bearer ${ADMIN_TOKEN}`]], 'DELETE requests (502, then 200)');
    assert(!after.rows.includes(CODES.haiku), `row still listed: ${after.rows}`);
    assertEqual(after.month, before.month, 'this month total keeps the deleted code');
    assertEqual(after.deletedRow, '삭제된 코드 이번 달 $1.20', '삭제된 코드 row');
    assertEqual(await overflow(page), [], 'horizontal overflow');

    // An older Worker without DELETE (405) and a code someone already deleted (404).
    // (The DELETE carries ?library=delete since code libraries: match the path with any query.)
    await d.ctx.route((u) => u.origin === RELAY_URL && u.pathname === `/relay/admin/codes/${CODES.sonnet}`, (r) => (r.request().method() === 'DELETE'
      ? r.fulfill({ status: 405, contentType: 'application/json', headers: { 'access-control-allow-origin': ORIGIN }, body: JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: '이 주소에서는 DELETE 요청을 쓸 수 없습니다.' } }) })
      : r.fallback()));
    await deleteBtn(page, CODES.sonnet).click();
    await page.locator('.modal-footer .btn-danger').click();
    await page.waitForSelector('.toast-error >> text=서버(Worker)를 새 버전으로 배포');
    const old = (await page.locator('.toast-error .toast-msg').last().innerText()).trim();
    await page.locator('.modal-footer .btn', { hasText: '취소' }).click();
    relay.fake.db.delete(CODES.spent); // deleted elsewhere meanwhile
    await deleteBtn(page, CODES.spent).click();
    await page.locator('.modal-footer .btn-danger').click();
    await page.waitForSelector('.toast >> text=이미 삭제된 코드입니다.');
    await page.waitForFunction((c) => !document.querySelector(`#set-invites .relay-code[data-code="${c}"]`), CODES.spent);
    // listCodes(): the Worker's deletedUsage; and from a Worker that does not send it, what the totals hold beyond the codes.
    const parsed = await page.evaluate(async () => {
      const R = await import('/js/ai/relay.js');
      const a = await R.listCodes();
      return { month: a.deletedMonthUsd, today: a.deletedTodayUsd };
    });
    await d.ctx.route(`${RELAY_URL}/relay/admin/codes`, (r) => (r.request().method() === 'GET'
      ? r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': ORIGIN }, body: JSON.stringify({
        codes: [{ code: 'PR-AAAA-BBBB', name: 'a', monthUsd: 1.1, todayUsd: 0.1 }, { code: 'PR-CCCC-DDDD', name: 'b', monthUsd: 0.4, todayUsd: 0 }],
        todayTotalUsd: 0.1, monthTotalUsd: 2.25, globalDailyLimitUsd: 5 }) })
      : r.fallback()));
    const derived = await page.evaluate(async () => {
      const R = await import('/js/ai/relay.js');
      const a = await R.listCodes();
      return { month: a.deletedMonthUsd, today: a.deletedTodayUsd };
    });
    assertEqual(parsed, { month: 1.2, today: 0.03 }, 'deletedUsage from the Worker');
    assertEqual(derived, { month: 0.75, today: 0 }, 'derived from the totals');
    await d.ctx.close();
    return `listCodes: deletedUsage → month $${parsed.month}; without it → derived $${derived.month}; rows' actions end in 삭제 (${actions[0].join(' · ')}); dialog “${modal.title}” + 2 lines, [취소 | 삭제(danger)], 취소 focused; 502 → toast “${DELETE_FAILED_MESSAGE}”, row + dialog kept; again → DELETE ${dels.at(-1).path} → row gone, “삭제했습니다.”; ${after.month}, ${after.today}, ${after.active}; row “${after.deletedRow}”; 405 → “${old}”; 404 → “이미 삭제된 코드입니다.”, row gone`;
  });

  await test('admin on a phone (390 px): the row with 삭제 and the dialog fit', async () => {
    const d = await device({ seed: { relay: { url: RELAY_URL, adminToken: ADMIN_TOKEN } }, viewport: { width: 390, height: 844 }, name: 'admin-phone', relay: makeRelay({ extraCodes: false }) });
    const { page } = d;
    await openAdmin(page);
    await page.locator(`#set-invites .relay-code[data-code="${CODES.haiku}"]`).scrollIntoViewIfNeeded();
    await shot(page.locator(`#set-invites .relay-code[data-code="${CODES.haiku}"]`), 'admin-row-390');
    const rowOverflow = await overflow(page);
    await deleteBtn(page, CODES.haiku).click();
    await page.waitForSelector('.modal');
    await page.waitForTimeout(200);
    await shot(page, 'delete-confirm-modal-390');
    const modalOverflow = await overflow(page);
    assertEqual([rowOverflow, modalOverflow], [[], []], 'overflow at 390 px');
    await d.ctx.close();
    return 'row + dialog at 390 px without horizontal overflow';
  });

  await test('deleted code on a fresh invitee device: /relay/me + /shared 401 → code forgotten once → first screen with the one line; no request loop; typing clears it; a new code → 공용 서재', async () => {
    const relay = makeRelay();
    relay.remove(C.fresh);
    const seed = { provider: 'relay', relay: { url: RELAY_URL, code: C.fresh, name: '동료fresh', allowedModels: ['claude-haiku-5-5'] } };
    const d = await device({ seed, viewport: { width: 390, height: 844 }, relay, name: 'gone-fresh' });
    const { page } = d;
    await page.goto(`${APP}#/s/team`);
    await page.waitForSelector('.start .start-error.is-notice');
    const line = await page.evaluate(() => {
      const e = document.querySelector('.start-error');
      return { text: e.textContent, invalid: document.querySelector('.start-input').getAttribute('aria-invalid'), color: getComputedStyle(e).color, h: e.getBoundingClientRect().height, lh: parseFloat(getComputedStyle(e).lineHeight) };
    });
    const s = await stored(page);
    const hash = await page.evaluate(() => location.hash);
    await page.evaluate(() => document.fonts?.ready);
    await shot(page, 'gate-code-gone-390');
    const n1 = relay.withCode(C.fresh).length;
    await sleep(4000);
    const n2 = relay.withCode(C.fresh).length;
    const toastsShown = await toasts(page);
    assertEqual(line.text, GONE, 'the line');
    assertEqual(line.invalid, null, 'aria-invalid (not an error of what was typed)');
    assert(line.h <= line.lh * 2.2, `line box ${JSON.stringify(line)}`);
    assertEqual([s.relay.code, s.relay.name, s.relay.allowedModels], ['', '', []], 'code forgotten');
    assertEqual(hash, '#/', 'address');
    assert(n1 <= 3 && n2 === n1, `requests with the deleted code: ${n1} then ${n2} (${JSON.stringify(relay.withCode(C.fresh))})`);
    assertEqual(toastsShown.filter((t) => t === GONE).length, 0, 'no toast on the first screen (the line says it)');
    assertEqual(await overflow(page), [], 'horizontal overflow');
    // Typing clears it; a working code goes on to 공용 서재.
    await page.fill('.start-input', 'P');
    const cleared = await page.locator('.start-error').innerText();
    await page.fill('.start-input', CODES.haiku);
    await page.click('.start-go');
    await page.waitForSelector('.lib-sec[data-lib="shared:team"] .lib-sec-body .lib-nav-heading', { timeout: 30000 });
    await page.waitForFunction(() => location.hash === '#/s/team');
    const s2 = await stored(page);
    assertEqual([cleared, s2.relay.code], ['', CODES.haiku], 'after typing a new code');
    await d.ctx.close();
    return `#/s/team with deleted ${C.fresh} → first screen at #/, line “${line.text}” (${line.color}, no aria-invalid, ${Math.round(line.h)}px), code/name/models cleared; ${n1} requests with the old code, none in the next 4 s; typing clears the line; ${CODES.haiku} → #/s/team`;
  });

  await test('first screen with the line: desktop 1440 light/dark, iPhone (WebKit)', async () => {
    const shots = [];
    for (const theme of ['light', 'dark']) {
      const relay = makeRelay();
      relay.remove(C.fresh);
      const seed = { provider: 'relay', relay: { url: RELAY_URL, code: C.fresh, name: '동료fresh', allowedModels: ['claude-haiku-5-5'] } };
      const d = await device({ seed, viewport: { width: 1440, height: 900 }, relay, theme, name: `gone-desktop-${theme}` });
      await d.page.goto(`${APP}#/`);
      await d.page.waitForSelector('.start .start-error.is-notice');
      await d.page.evaluate(() => document.fonts?.ready);
      await shot(d.page, `gate-code-gone-1440-${theme}`);
      shots.push(`gate-code-gone-1440-${theme}`);
      assertEqual(await overflow(d.page), [], `overflow ${theme}`);
      await d.ctx.close();
    }
    if (wk) {
      const relay = makeRelay();
      relay.remove(C.ios);
      const seed = { provider: 'relay', relay: { url: RELAY_URL, code: C.ios, name: '동료ios', allowedModels: ['claude-haiku-5-5'] } };
      const d = await device({ seed, relay, engine: 'webkit', profile: 'iPhone 15', name: 'gone-ios' });
      await d.page.goto(`${APP}#/`);
      await d.page.waitForSelector('.start .start-error.is-notice');
      const text = await d.page.locator('.start-error').innerText();
      await shot(d.page, 'gate-code-gone-iphone15');
      shots.push('gate-code-gone-iphone15');
      assertEqual(text.trim(), GONE, 'WebKit line');
      await d.ctx.close();
    }
    return `screenshots: ${shots.join(', ')}`;
  });

  await test('code deleted while 공용 서재 is open: the proxy\'s 401 on the next sync → code forgotten → first screen with the line', async () => {
    const relay = makeRelay();
    const seed = { provider: 'relay', relay: { url: RELAY_URL, code: C.session, name: '동료session', allowedModels: ['claude-haiku-5-5'] } };
    const d = await device({ seed, viewport: { width: 1280, height: 860 }, relay, name: 'gone-session' });
    const { page } = d;
    await page.goto(`${APP}#/`);
    await page.waitForSelector('.lib-sec[data-lib="shared:team"] .lib-sec-body .lib-nav-heading', { timeout: 30000 });
    await page.waitForFunction(() => location.hash === '#/s/team');
    await sleep(1500); // the first sync (pull) is done
    relay.remove(C.session); // the owner deletes it now
    const before = relay.withCode(C.session).length;
    await sleep(15_500); // the engine pulls on focus at most every 15 s
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await page.waitForSelector('.start .start-error.is-notice', { timeout: 15000 });
    const firstRefusal = relay.withCode(C.session).slice(before);
    const s = await stored(page);
    await sleep(3000);
    const later = relay.withCode(C.session).length - before;
    await shot(page, 'gate-after-proxy-401-1280');
    assert(firstRefusal.some((r) => r.path.startsWith('/shared/team/gh/')), `no proxy request after deleting: ${JSON.stringify(firstRefusal)}`);
    assertEqual([s.relay.code, (await page.locator('.start-error').innerText()).trim()], ['', GONE], 'forgotten + line');
    assert(later <= 2, `requests with the deleted code after it was deleted: ${later} ${JSON.stringify(relay.withCode(C.session).slice(before))}`);
    await d.ctx.close();
    return `in 공용 서재, code deleted → focus → ${firstRefusal.map((r) => `${r.method} ${r.path}`).join(', ')} → 401 → first screen “${GONE}”; ${later} request(s) with the old code in total afterwards`;
  });

  await test('own API key + deleted code: a toast with the same words; own key becomes the AI; 내 서재 stays; 공용 서재 gone', async () => {
    const relay = makeRelay();
    relay.remove(C.own);
    const seed = { provider: 'relay', claude: { apiKey: 'sk-ant-own-key' }, relay: { url: RELAY_URL, code: C.own, name: '동료own', allowedModels: ['claude-haiku-5-5'] } };
    const d = await device({ seed, viewport: { width: 1280, height: 860 }, relay, name: 'gone-own' });
    const { page } = d;
    await page.goto(`${APP}#/s/team`);
    await page.waitForSelector(`.toast >> text=${GONE}`, { timeout: 30000 });
    await page.waitForSelector('.library');
    await page.waitForFunction(() => location.hash === '#/');
    await page.waitForTimeout(400);
    const s = await stored(page);
    const r = { hash: await page.evaluate(() => location.hash), start: await page.locator('.start').count(), shared: await sharedSection(page), toasts: (await toasts(page)).filter((t) => t === GONE).length };
    await shot(page, 'library-toast-own-key-1280');
    assertEqual([s.relay.code, s.provider, s.claude.apiKey], ['', 'claude', 'sk-ant-own-key'], 'stored');
    assertEqual(r, { hash: '#/', start: 0, shared: 0, toasts: 1 }, 'view');
    await d.ctx.close();
    return `toast “${GONE}” (once); provider relay → claude (own key kept); #/s/team → #/ 내 서재; no 공용 서재 section; no first screen`;
  });

  await test('home-screen app that starts at #/join/<deleted code>: first launch → the line; next launches send nothing for it (the first screen with the line; after a new code → straight in)', async () => {
    const relay = makeRelay();
    const engine = wk ? 'webkit' : 'edge';
    const profile = wk ? 'iPhone 15' : null;
    const seed = { provider: 'relay', relay: { url: RELAY_URL, code: C.home, name: '동료home', allowedModels: ['claude-haiku-5-5'] } };
    const d = await device({ seed, relay, engine, profile, standalone: true, name: 'gone-home-screen', viewport: { width: 390, height: 844 } });
    const { page } = d;
    const address = `${APP}#/join/${C.home}`;
    // Used once while the code was alive (공용 서재 list remembered), then the owner deletes it.
    await page.goto(address);
    await page.waitForSelector('.lib-sec[data-lib="shared:team"] .lib-sec-body .lib-nav-heading', { timeout: 30000 });
    relay.remove(C.home);
    const n0 = relay.withCode(C.home).length;
    // Launch 1 after the deletion.
    await page.goto('about:blank');
    await page.goto(address);
    await page.waitForSelector('.start .start-error.is-notice', { timeout: 30000 });
    const launch1 = { line: (await page.locator('.start-error').innerText()).trim(), code: (await stored(page)).relay.code, requests: relay.withCode(C.home).length - n0 };
    // Launch 2: the same saved address — nothing is sent for the dead code; the first screen with the line.
    await page.goto('about:blank');
    const n1 = relay.withCode(C.home).length;
    await page.goto(address);
    await page.waitForSelector('.start .start-error.is-notice');
    await sleep(1500);
    const launch2 = { line: (await page.locator('.start-error').innerText()).trim(), value: await page.inputValue('.start-input'), quiet: await page.locator('.start.is-quiet').count(), hash: await page.evaluate(() => location.hash), requests: relay.withCode(C.home).length - n1 };
    await shot(page, 'home-screen-relaunch-dead-code');
    // A new code from the owner → 공용 서재.
    await page.fill('.start-input', CODES.haiku);
    await page.click('.start-go');
    await page.waitForSelector('.lib-sec[data-lib="shared:team"] .lib-sec-body .lib-nav-heading', { timeout: 30000 });
    // Launch 3: the old address again → straight in, no screen, no request for the dead code.
    await page.goto('about:blank');
    const n2 = relay.withCode(C.home).length;
    await page.goto(address);
    await page.waitForSelector('.lib-sec[data-lib="shared:team"] .lib-sec-body .lib-nav-heading', { timeout: 30000 });
    await sleep(1000);
    const launch3 = { start: await page.locator('.start').count(), hash: await page.evaluate(() => location.hash), requests: relay.withCode(C.home).length - n2, code: (await stored(page)).relay.code };
    assertEqual([launch1.line, launch1.code], [GONE, ''], 'launch 1');
    assert(launch1.requests <= 2, `launch 1 requests with the dead code: ${launch1.requests}`);
    assertEqual(launch2, { line: GONE, value: '', quiet: 0, hash: '#/', requests: 0 }, 'launch 2');
    assertEqual(launch3, { start: 0, hash: '#/s/team', requests: 0, code: CODES.haiku }, 'launch 3');
    await d.ctx.close();
    return `${engine}${profile ? ` (${profile}, standalone)` : ''}: launch 1 → “${launch1.line}” (${launch1.requests} request(s), code forgotten); launch 2 at #/join/${C.home} → ${launch2.hash}, empty input + the line, 0 requests; new code → 공용 서재; launch 3 at the old address → #/s/team directly, 0 requests`;
  });

  await test('a code that never worked here (typed in 설정) answering 401: only its error line — nothing forgotten, no toast, no first screen', async () => {
    const relay = makeRelay();
    relay.remove(C.settings);
    const d = await device({ seed: { relay: { url: RELAY_URL } }, relay, name: 'typo' });
    const { page } = d;
    await page.goto(`${APP}#/settings/ai`);
    await page.waitForSelector('.settings');
    await page.locator('.radio-card', { hasText: '키 없이 쓰기' }).click();
    await page.fill('#set-ai input[aria-label="초대 코드"]', C.settings);
    await page.locator('#set-ai .btn', { hasText: '테스트' }).click();
    await page.waitForSelector('#set-ai .test-result.is-error');
    const err = (await page.locator('#set-ai .test-result.is-error').innerText()).trim();
    await page.waitForTimeout(500);
    const s = await stored(page);
    const r = { code: s.relay.code, toasts: (await toasts(page)).filter((t) => t === GONE).length, settings: await page.locator('.settings').count() };
    assertEqual(err, BAD_CODE, 'error line');
    assertEqual(r, { code: C.settings, toasts: 0, settings: 1 }, 'nothing else happened');
    await d.ctx.close();
    return `typed ${C.settings} (deleted) → 테스트 → “${err}”; code stays as typed, no toast, still in 설정`;
  });

  await test('no console errors, page errors, CSP violations, native dialogs or escaped requests', async () => {
    assert(!problems.length, problems.join('\n'));
    return '0 problems';
  });
} finally {
  writeFileSync(`${OUT}/results.json`, JSON.stringify(results, null, 2));
  await edge.close();
  await wk?.close();
  await team.close();
  await github.close();
  server?.kill();
  const failed = results.filter((r) => r.result === 'fail');
  console.log(`\ncode-delete (app): ${results.filter((r) => r.result === 'pass').length}/${results.length} passed${failed.length ? ` — FAILED: ${failed.map((f) => f.name).join(' | ')}` : ''}`);
  process.exitCode = failed.length ? 1 : 0;
}
