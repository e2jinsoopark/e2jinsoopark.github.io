// 공용 서재 UI (docs/SHARED.md §3.2), end to end in Edge with the real app, the real store and three people:
//   node tests/shared-ui/run.mjs     (starts `python -m http.server 8194` if nothing is listening)
//
// The owner (내 서재 synced to a fake personal repo + the invite code + the admin token), invitee 김동료 and invitee
// 이동료 each get a fresh browser context. The team library goes through tests/store/fake-relay.mjs (the contract's
// GitHub-compatible proxy, /shared and activity) in front of tests/store/fake-github.mjs, reached by route
// interception of https://relay.test; the admin purge/stats endpoints are answered here. index.html is served as a
// TEST COPY whose CSP connect-src also lists https://relay.test (the real file stays strict). AI is the offline mock
// (?mock=1). Fixture PDFs are read from C:/Users/dindoo/Projects/pr-fixtures (never copied into the repo); every
// other external request is aborted and fails the run. Results + screenshots: C:/Users/dindoo/Projects/pr-tools/out/shared-ui/.
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'file:///C:/Users/dindoo/Projects/pr-tools/node_modules/playwright/index.mjs';
import { routeGitHubToFake, startFakeGitHub } from '../store/fake-github.mjs';
import { startFakeRelay } from '../store/fake-relay.mjs';

const PORT = 8194;
const ORIGIN = `http://localhost:${PORT}`;
const APP = `${ORIGIN}/index.html?mock=1`;
const OUT = 'C:/Users/dindoo/Projects/pr-tools/out/shared-ui';
const FIXTURES = 'C:/Users/dindoo/Projects/pr-fixtures';
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const RELAY_URL = 'https://relay.test';
const SETTINGS_KEY = 'pr.settings.v1';
const ADMIN_TOKEN = 'admin-token-for-tests-0123456789';
const TEAM = { owner: 'dindoopark', repo: 'paper-team-library', token: 'ghp_team_test_token' };
const MINE = { owner: 'owner-me', repo: 'paper-library', token: 'ghp_owner_test_token' };
const CODES = { owner: 'PR-7K3M-9QXA', kim: 'PR-2B4C-6D8E', lee: 'PR-3F5G-7H9J', park: 'PR-4K6M-8N0P' };
const NAMES = { owner: '박진수', kim: '김동료', lee: '이동료', park: '박신입' };
const DAY = 86_400_000;
const SHARED_NOTE = '번역은 모두와 공유, 메모는 나만';

mkdirSync(OUT, { recursive: true });
const results = [];
const problems = [];
const expected404 = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function assert(cond, msg) { if (!cond) throw new Error(msg); }

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

async function waitFor(fn, timeout = 15000, what = 'condition') {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error(`timeout waiting for ${what}`);
    await sleep(100);
  }
}

async function serverUp() {
  try { return (await fetch(`${ORIGIN}/index.html`)).ok; } catch { return false; }
}

// ------------------------------------------------------------------ servers

let server = null;
if (!(await serverUp())) {
  server = spawn('python', ['-m', 'http.server', String(PORT)], { cwd: REPO_ROOT, stdio: 'ignore' });
  await waitFor(serverUp, 10000, 'python http.server');
}
const github = await startFakeGitHub({ port: 0 });
github.addToken(MINE.token, { write: true, repos: [`${MINE.owner}/${MINE.repo}`] });
github.addToken(TEAM.token, { write: true, repos: [`${TEAM.owner}/${TEAM.repo}`] });
github.createRepo(MINE.owner, MINE.repo, { private: true, files: { 'README.md': '# paper-library' } });
github.createRepo(TEAM.owner, TEAM.repo, { private: true, files: { 'README.md': '# 공용 서재' } });
const relay = await startFakeRelay({ github, owner: TEAM.owner, repo: TEAM.repo, token: TEAM.token, lib: 'team', libName: '공용 서재' });
for (const [k, code] of Object.entries(CODES)) relay.addCode(code, NAMES[k]);

const teamFiles = () => github.files(TEAM.owner, TEAM.repo);
const teamJson = (path) => {
  const b = github.readFile(TEAM.owner, TEAM.repo, path);
  return b ? JSON.parse(b.toString('utf8')) : null;
};
const teamPdfs = () => [...teamFiles().keys()].filter((p) => /^papers\/[^/]+\/paper\.pdf$/.test(p));
const teamPaper = (title) => (teamJson('library.json')?.papers || []).find((p) => (p.title || '').includes(title));

/** /relay/admin/shared/<lib>/stats and /purge (the store's fake relay does not serve the admin API). */
const adminCalls = [];
async function adminRoute(route, req, url) {
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization, content-type', 'access-control-allow-methods': 'GET, POST, OPTIONS' };
  if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
  adminCalls.push({ method: req.method(), path: url.pathname, auth: req.headers().authorization || '' });
  const reply = (status, body) => route.fulfill({ status, headers: cors, contentType: 'application/json', body: JSON.stringify(body) });
  if (req.headers().authorization !== `Bearer ${ADMIN_TOKEN}`) {
    return reply(401, { type: 'error', error: { type: 'authentication_error', message: '관리자 토큰이 올바르지 않습니다.' } });
  }
  const m = /^\/relay\/admin\/shared\/team\/(stats|purge)$/.exec(url.pathname);
  if (!m) return reply(404, { type: 'error', error: { type: 'not_found_error', message: '요청한 주소를 찾을 수 없습니다.' } });
  const files = teamFiles();
  if (m[1] === 'stats') {
    let bytes = 0;
    for (const path of files.keys()) bytes += github.readFile(TEAM.owner, TEAM.repo, path)?.length || 0;
    const people = new Set([...files.keys()].map((p) => /^people\/([^/]+)\//.exec(p)?.[1]).filter(Boolean));
    return reply(200, { bytes, papers: teamPdfs().length, people: people.size, maxBytes: 4_000_000_000 });
  }
  const lib = teamJson('library.json') || { papers: [] };
  const old = (lib.papers || []).filter((p) => p.deleted && Date.now() - (p.deletedAt || p.updatedAt || 0) > 30 * DAY).map((p) => p.id);
  const paths = [...files.keys()].filter((p) => old.some((id) => p.startsWith(`papers/${id}/`) || p.includes(`/papers/${id}/`)));
  const purged = old.filter((id) => paths.some((p) => p.includes(`papers/${id}/`)));
  let freedBytes = 0;
  for (const p of paths) freedBytes += github.readFile(TEAM.owner, TEAM.repo, p)?.length || 0;
  const commitSha = paths.length
    ? github.commitFiles(TEAM.owner, TEAM.repo, Object.fromEntries(paths.map((p) => [p, null])), { message: `[관리자] 휴지통 비우기: 30일 지난 논문 ${purged.length}개의 파일 ${paths.length}개 삭제` })
    : null;
  return reply(200, { purged, files: paths.length, freedBytes, commitSha });
}

/** index.html with https://relay.test added to connect-src — served only to the test browser. */
function testCopyOfIndex() {
  const html = readFileSync(`${REPO_ROOT}/index.html`, 'utf8');
  const out = html.replace(/(connect-src [^;"]*)/, `$1 ${RELAY_URL}`);
  if (out === html) throw new Error('could not find connect-src in index.html');
  return out;
}
const INDEX = testCopyOfIndex();

const browser = await chromium.launch({
  channel: 'msedge',
  args: ['--host-resolver-rules=MAP api.github.com 127.0.0.1, MAP *.github.com 127.0.0.1, MAP relay.test 127.0.0.1'],
});

/**
 * One browser context = one person's device. `relayDown()` makes the relay unreachable (connection failure) until
 * `relayUp()`. Console errors, page errors and CSP violations are collected; Chromium's own "Failed to load
 * resource" lines for answers the app expects (409/422 conflicts while several people push) are kept as evidence.
 */
async function device(name, seed, { viewport = { width: 1440, height: 900 } } = {}) {
  const ctx = await browser.newContext({ locale: 'ko-KR', viewport, colorScheme: 'light' });
  let down = false;
  const external = [];
  await ctx.route(/^https?:\/\/(?!localhost:8194\/)/, (route) => {
    const url = route.request().url();
    if (url.startsWith('https://cdn.jsdelivr.net/gh/orioncactus/pretendard')) {
      return route.fulfill({ status: 200, contentType: 'text/css', body: '/* font stub (offline test) */' });
    }
    external.push(url);
    problems.push(`${name}: external request blocked ${url}`);
    return route.abort();
  });
  await routeGitHubToFake(ctx, github.url);
  await ctx.route(`${RELAY_URL}/**`, async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (down) return route.abort('connectionfailed');
    if (url.pathname.startsWith('/relay/admin/shared/')) return adminRoute(route, req, url);
    try {
      const response = await route.fetch({ url: `${relay.url}${url.pathname}${url.search}` });
      await route.fulfill({ response });
    } catch {
      await route.abort('connectionfailed');
    }
  });
  await ctx.route(/^http:\/\/localhost:8194\/index\.html(?:\?.*)?$/, (route) => route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: INDEX }));
  await ctx.addInitScript(({ key, seed }) => {
    try { if (seed && !localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify(seed)); } catch { /* blocked */ }
    window.__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => {
      window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`);
      console.error(`[csp] ${e.violatedDirective} blocked ${e.blockedURI}`);
    });
  }, { key: SETTINGS_KEY, seed });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => problems.push(`${name}: pageerror ${e.message}`));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const text = m.text();
    const where = String(m.location()?.url || '');
    if (/^Failed to load resource/.test(text) && (where.startsWith(RELAY_URL) || where.startsWith('https://api.github.com'))) {
      expected404.push(`${name}: ${text} ${where.replace(/\?.*$/, '')}`);
      return;
    }
    problems.push(`${name}: console.error ${text}`);
  });
  return {
    name, ctx, page, external,
    relayDown() { down = true; },
    relayUp() { down = false; },
  };
}

const shot = (target, file, opts = {}) => target.screenshot({ path: `${OUT}/${file}.png`, ...opts });
const fixture = (name) => `${FIXTURES}/${name}.pdf`;
const hashOf = (page) => page.evaluate(() => location.hash);
const sec = (page, key) => page.locator(`.lib-sec[data-lib="${key}"]`);
const rowTitles = (page) => page.$$eval('.paper-row .paper-title', (els) => els.map((e) => e.textContent.trim()));

async function booted(page) {
  await page.waitForFunction(() => document.querySelector('.library, .reader, .settings, .message-screen'), null, { timeout: 30000 });
}

/** The team library section has opened (its tree is shown). */
async function sharedReady(page) {
  await page.waitForSelector('.lib-sec[data-lib="shared:team"] .lib-sec-body .lib-nav-heading', { timeout: 30000 });
}

async function answerPrompt(page, value) {
  const input = page.locator('.modal-backdrop input[type="text"], .modal-backdrop input:not([type])').last();
  await input.waitFor();
  await input.fill(value);
  await input.press('Enter');
}

/** Click the toast action whose label is `label` (the newest toast first). */
async function toastAction(page, label) {
  await page.locator('.toast .btn', { hasText: label }).last().click();
}

async function syncShared(page) {
  const chip = page.locator('.lib-sec-sync[data-lib="shared:team"]');
  await chip.click();
  await page.waitForFunction(() => {
    const c = document.querySelector('.lib-sec-sync[data-lib="shared:team"]');
    return c && !c.classList.contains('is-busy');
  }, null, { timeout: 20000 });
}

async function uploadFiles(page, names) {
  await page.setInputFiles('input[type=file]', names.map(fixture));
  await page.waitForFunction((n) => [...document.querySelectorAll('.toast')].some((t) => /추가했습니다/.test(t.textContent)) || n === 0, names.length, { timeout: 60000 });
}

/** A real file drop on the list (DataTransfer with a File built from the fixture bytes). */
async function dropFile(page, name, selector = '.lib-main') {
  const b64 = readFileSync(fixture(name)).toString('base64');
  await page.evaluate(({ b64, name, selector }) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const file = new File([bytes], `${name}.pdf`, { type: 'application/pdf' });
    const dt = new DataTransfer();
    dt.items.add(file);
    const target = document.querySelector(selector);
    for (const type of ['dragenter', 'dragover', 'drop']) target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
  }, { b64, name, selector });
}

async function waitForReader(page) {
  await page.waitForFunction(() => document.querySelector('.tp-s[data-sid], .tp-empty, .reader .message-screen'), null, { timeout: 60000 });
  const error = await page.$('.reader .message-screen');
  if (error) throw new Error(`reader error: ${(await error.textContent()).trim()}`);
  await page.waitForFunction(() => document.querySelector('.pdfv-page canvas'), null, { timeout: 30000 });
}

const seeds = {
  owner: {
    github: { owner: MINE.owner, repo: MINE.repo, branch: 'main', token: MINE.token },
    relay: { url: RELAY_URL, code: CODES.owner, name: NAMES.owner, adminToken: ADMIN_TOKEN },
  },
  invitee: (who) => ({ provider: 'relay', relay: { url: RELAY_URL, code: CODES[who], name: NAMES[who] } }),
};

const ids = {};

// ===================================================================== tests

try {
  const O = await device('owner', seeds.owner);
  const op = O.page;

  await test('owner: sidebar has 내 서재 and 공용 서재, each with its own tree, counts and sync chip', async () => {
    await op.goto(`${APP}#/`);
    await booted(op);
    await sharedReady(op);
    assert(await hashOf(op) === '#/', `owner home is 내 서재, got ${await hashOf(op)}`);
    // 내 서재: a folder with lu2025, kiekkas2012 at the top level
    await sec(op, 'mine').locator('.lib-nav-heading button').click();
    await answerPrompt(op, '섬망 연구');
    await op.waitForSelector('.lib-title >> text=섬망 연구');
    await uploadFiles(op, ['lu2025']);
    await op.waitForFunction(() => document.querySelectorAll('.paper-row').length === 1, null, { timeout: 60000 });
    await sec(op, 'mine').locator('.tree-item', { hasText: '전체' }).click();
    await uploadFiles(op, ['kiekkas2012']);
    await op.waitForFunction(() => document.querySelectorAll('.paper-row').length === 2, null, { timeout: 60000 });
    const rows = await op.$$eval('.paper-row', (els) => els.map((e) => ({ id: e.dataset.id, title: e.querySelector('.paper-title').textContent })));
    const sections = await op.$$eval('.lib-sec', (els) => els.map((s) => ({
      key: s.dataset.lib,
      label: s.querySelector('.lib-sec-label')?.textContent,
      all: s.querySelector('.tree-item .tree-count')?.textContent,
      folders: [...s.querySelectorAll('.tree-item.is-folder .tree-label')].map((x) => x.textContent),
      chip: s.querySelector('.lib-sec-sync')?.getAttribute('aria-label') || '',
      extras: [...s.querySelectorAll('.lib-nav-extra .tree-label')].map((x) => x.textContent),
    })));
    await op.waitForFunction(() => /동기화 완료/.test(document.querySelector('.lib-sync')?.textContent || ''), null, { timeout: 30000 });
    await shot(op, 'owner-sidebar');
    const [mine, team] = sections;
    assert(sections.length === 2 && mine.key === 'mine' && team.key === 'shared:team', JSON.stringify(sections));
    assert(mine.label === '내 서재' && team.label === '공용 서재', `labels ${mine.label} / ${team.label}`);
    assert(mine.all === '2' && team.all === '0', `counts 내 서재 ${mine.all}, 공용 서재 ${team.all}`);
    assert(mine.folders.join() === '섬망 연구' && team.folders.length === 0, `trees ${mine.folders} / ${team.folders}`);
    assert(/내 서재/.test(mine.chip) && /공용 서재/.test(team.chip), `chips “${mine.chip}” / “${team.chip}”`);
    assert(team.extras.join() === '최근 활동,휴지통' && mine.extras.join() === '휴지통', `extras ${mine.extras} / ${team.extras}`);
    ids.luMine = rows.find((r) => /gamif|lu/i.test(r.title))?.id || rows.at(-1).id;
    ids.titles = Object.fromEntries(rows.map((r) => [r.id, r.title]));
    return `sections ${sections.map((s) => `${s.label}(전체 ${s.all}, 폴더 [${s.folders}], ${s.extras.join('/')}, chip “${s.chip}”)`).join(' | ')}`;
  });

  let luTitle = '';
  await test('owner: ‘공용 서재로 복사…’ picks a target folder (one made in the picker) and copies PDF + translation only', async () => {
    await sec(op, 'mine').locator('.tree-item.is-folder', { hasText: '섬망 연구' }).click();
    const row = op.locator('.paper-row').first();
    luTitle = (await row.locator('.paper-title').textContent()).trim();
    ids.luMine = await row.getAttribute('data-id');
    await row.locator('button[aria-label="논문 메뉴"]').click();
    await op.locator('.menu .menu-item', { hasText: '공용 서재로 복사…' }).click();
    await op.waitForSelector('.copy-dialog .folder-picker');
    const before = await op.$$eval('.copy-dialog .folder-picker .menu-label', (els) => els.map((e) => e.textContent));
    await op.locator('.copy-dialog .btn', { hasText: '새 폴더' }).click();
    await answerPrompt(op, '팀 섬망 자료');
    await op.waitForFunction(() => [...document.querySelectorAll('.copy-dialog .folder-picker .menu-item')].some((l) => l.textContent.includes('팀 섬망 자료') && l.querySelector('input').checked));
    const note = (await op.locator('.copy-dialog .note').textContent()).trim();
    await shot(op, 'copy-picker');
    await shot(op.locator('.copy-dialog'), 'copy-picker-dialog');
    await op.locator('.copy-dialog .modal-footer .btn', { hasText: '복사' }).click();
    await op.waitForFunction(() => [...document.querySelectorAll('.toast')].some((t) => /공용 서재 ‘팀 섬망 자료’ 폴더에 복사했습니다/.test(t.textContent)), null, { timeout: 30000 });
    const toastText = await op.locator('.toast', { hasText: '복사했습니다' }).last().textContent();
    await toastAction(op, '공용 서재에서 보기');
    await op.waitForFunction(() => location.hash === '#/s/team' && document.querySelector('.lib-title')?.textContent === '팀 섬망 자료', null, { timeout: 10000 });
    const shared = await rowTitles(op);
    await waitFor(() => teamPdfs().length === 1 && teamPaper(luTitle.slice(0, 20)), 30000, 'the copy pushed to the team repo');
    const files = [...teamFiles().keys()];
    const commits = github.commits(TEAM.owner, TEAM.repo).map((c) => c.message.split('\n')[0]);
    assert(before[0] === '공용 서재 (최상위)', `picker root ${before}`);
    assert(/하이라이트·메모·AI 결과는 복사되지 않/.test(note), note);
    assert(shared.length === 1 && shared[0] === luTitle, `shared rows ${shared}`);
    assert(!files.some((p) => p.startsWith('people/')), `personal files in the team repo: ${files}`);
    assert(commits.some((m) => m.startsWith(`[${NAMES.owner}]`) && /논문 추가/.test(m)), `commits ${commits}`);
    ids.lu = teamPaper(luTitle.slice(0, 20)).id;
    return `picker [${before.join(' | ')}] + new folder ‘팀 섬망 자료’ (checked); toast “${toastText.trim().replace(/\s+/g, ' ')}”; 공용 서재 rows [${shared}]; team repo ${files.join(', ')}; commit “${commits[0]}”`;
  });

  await test('owner: copying a 내 서재 folder reuses the PDF already in 공용 서재 (no second upload)', async () => {
    await sec(op, 'mine').locator('.tree-item', { hasText: '전체' }).click();
    await op.waitForFunction(() => location.hash === '#/');
    await sec(op, 'mine').locator('.tree-item.is-folder', { hasText: '섬망 연구' }).click({ button: 'right' });
    await op.locator('.menu .menu-item', { hasText: '공용 서재로 복사…' }).click();
    await op.waitForSelector('.copy-dialog .folder-picker');
    const message = (await op.locator('.copy-dialog .modal-message').textContent()).trim();
    await op.locator('.copy-dialog .modal-footer .btn', { hasText: '복사' }).click();
    await op.waitForFunction(() => [...document.querySelectorAll('.toast')].some((t) => /‘섬망 연구’ 폴더를 공용 서재 최상위에 복사했습니다/.test(t.textContent)), null, { timeout: 30000 });
    const toastText = (await op.locator('.toast', { hasText: '폴더를 공용 서재' }).last().textContent()).replace(/\s+/g, ' ').trim();
    const team = await sec(op, 'shared:team').locator('.tree-item.is-folder').evaluateAll((els) => els.map((e) => `${e.querySelector('.tree-label').textContent}=${e.querySelector('.tree-count').textContent}`));
    await waitFor(() => (teamJson('library.json')?.folders || []).some((f) => f.name === '섬망 연구' && !f.deleted), 30000, 'folder pushed');
    assert(/이미 있던 1편은 폴더에만 넣음/.test(toastText), toastText);
    assert(teamPdfs().length === 1, `team PDFs ${teamPdfs()}`);
    assert(team.includes('섬망 연구=1'), `shared tree ${team}`);
    return `dialog “${message}”; toast “${toastText}”; 공용 서재 tree [${team}]; team repo PDFs ${teamPdfs().length}`;
  });

  // ------------------------------------------------------------------ invitee 김동료
  const K = await device('kim', seeds.invitee('kim'));
  const kp = K.page;

  await test('invitee: #/ opens 공용 서재 by default; 내 서재 is folded away', async () => {
    await kp.goto(`${APP}#/`);
    await booted(kp);
    await sharedReady(kp);
    await kp.waitForFunction(() => document.querySelectorAll('.paper-row').length >= 1, null, { timeout: 30000 });
    const hash = await hashOf(kp);
    const st = await kp.evaluate(() => ({
      mineExpanded: document.querySelector('.lib-sec[data-lib="mine"] .lib-sec-toggle')?.getAttribute('aria-expanded'),
      current: document.querySelector('.lib-sec.is-current')?.dataset.lib,
      crumbs: document.querySelector('.lib-crumbs').textContent,
      title: document.querySelector('.lib-title').textContent,
      folders: [...document.querySelectorAll('.lib-sec[data-lib="shared:team"] .tree-item.is-folder .tree-label')].map((e) => e.textContent),
      chip: document.querySelector('.lib-sync').textContent,
    }));
    await kp.waitForFunction(() => /동기화 완료/.test(document.querySelector('.lib-sync')?.textContent || ''), null, { timeout: 20000 });
    await shot(kp, 'invitee-default');
    assert(hash === '#/s/team', `invitee home ${hash}`);
    assert(st.mineExpanded === 'false' && st.current === 'shared:team', JSON.stringify(st));
    assert(st.crumbs === '공용 서재' && st.title === '전체', JSON.stringify(st));
    assert(st.folders.includes('팀 섬망 자료') && st.folders.includes('섬망 연구'), `folders ${st.folders}`);
    return `#/ → ${hash}; 내 서재 aria-expanded=${st.mineExpanded}; current ${st.current}; header “${st.crumbs} / ${st.title}”; folders [${st.folders}]`;
  });

  await test('invitee: upload (file input) and drag-drop work in 공용 서재', async () => {
    await sec(kp, 'shared:team').locator('.lib-nav-heading button').click();
    await answerPrompt(kp, '간호 중재');
    await kp.waitForSelector('.lib-title >> text=간호 중재');
    await uploadFiles(kp, ['kiekkas2012']);
    await kp.waitForFunction(() => document.querySelectorAll('.paper-row').length === 1, null, { timeout: 60000 });
    const firstToast = (await kp.locator('.toast', { hasText: '추가했습니다' }).last().textContent()).replace(/\s+/g, ' ');
    await dropFile(kp, 'simwright2005');
    await kp.waitForFunction(() => document.querySelectorAll('.paper-row').length === 2, null, { timeout: 60000 });
    const titles = await rowTitles(kp);
    await waitFor(() => teamPdfs().length === 3, 30000, 'both uploads pushed');
    const lib = teamJson('library.json');
    const folder = lib.folders.find((f) => f.name === '간호 중재');
    const inFolder = lib.papers.filter((p) => p.folderId === folder?.id && !p.deleted).length;
    assert(/공용 서재에 추가했습니다/.test(firstToast), firstToast);
    assert(inFolder === 2, `papers in 간호 중재 on the server: ${inFolder}`);
    ids.kiekkas = lib.papers.find((p) => p.folderId === folder.id && /kiekkas|nurs|alarm/i.test(`${p.fileName} ${p.title}`))?.id
      || lib.papers.find((p) => p.fileName === 'kiekkas2012.pdf')?.id;
    ids.kiekkasTitle = lib.papers.find((p) => p.id === ids.kiekkas)?.title;
    return `toast “${firstToast.trim()}”; rows [${titles.map((t) => t.slice(0, 40))}]; server: ${teamPdfs().length} PDFs, ${inFolder} papers in ‘간호 중재’`;
  });

  await test('reader: a 공용 서재 paper shows the badge, translates (mock) into the shared translation.json, back returns to 공용 서재', async () => {
    await sec(kp, 'shared:team').locator('.tree-item', { hasText: '전체' }).click();
    await kp.locator('.paper-row', { hasText: luTitle.slice(0, 30) }).locator('.paper-link').click();
    await kp.waitForFunction((id) => location.hash === `#/s/team/paper/${id}`, ids.lu, { timeout: 10000 });
    await waitForReader(kp);
    const badge = (await kp.locator('.tb-shared').textContent()).trim();
    const badgeTitle = await kp.locator('.tb-shared').getAttribute('title');
    await kp.locator('.tb-tr-more').click();
    await kp.locator('.menu .menu-item', { hasText: '이 페이지만 번역' }).click();
    await kp.waitForFunction(() => document.querySelectorAll('.tp-s.is-translated').length > 5 && !document.querySelector('.tp-s.is-pending'), null, { timeout: 60000 });
    const translated = await kp.$$eval('.tp-s.is-translated', (els) => els.length);
    await shot(kp, 'reader-shared-badge');
    await waitFor(() => teamFiles().has(`papers/${ids.lu}/translation.json`), 30000, 'translation.json pushed to papers/<id>/');
    await kp.locator('.reader-toolbar .tb-back').click();
    await kp.waitForFunction(() => location.hash === '#/s/team' && document.querySelector('.library'));
    assert(badge === `공용 서재 · ${SHARED_NOTE}`, `badge “${badge}”`);
    assert(/메모·AI 요약·채팅은 다른 사람에게 보이지 않습니다/.test(badgeTitle || ''), badgeTitle);
    return `#/s/team/paper/${ids.lu}; badge “${badge}”; ${translated} sentences translated (mock) → papers/${ids.lu}/translation.json on the server; 라이브러리 → #/s/team`;
  });

  // ------------------------------------------------------------------ invitee 이동료
  const L = await device('lee', seeds.invitee('lee'));
  const lp = L.page;

  await test('another invitee reuses the shared translation (0 translate calls)', async () => {
    await lp.goto(`${APP}#/s/team/paper/${encodeURIComponent(ids.lu)}`);
    await waitForReader(lp);
    await lp.waitForFunction(() => document.querySelectorAll('.tp-s.is-translated').length > 5, null, { timeout: 30000 });
    const st = await lp.evaluate(async () => {
      const { mockControl } = await import('/js/ai/mock.js');
      return { translated: document.querySelectorAll('.tp-s.is-translated').length, calls: mockControl.requests.filter((r) => r.task === 'translate').length };
    });
    assert(st.calls === 0, `이동료 made ${st.calls} translate calls`);
    return `이동료 sees ${st.translated} translated sentences of ‘${luTitle.slice(0, 30)}…’ with ${st.calls} translate calls`;
  });

  await test('delete in 공용 서재 asks once: “휴지통으로 이동합니다. 30일 안에 복구할 수 있습니다”', async () => {
    await lp.goto(`${APP}#/`);
    await lp.waitForFunction(() => location.hash === '#/s/team' && document.querySelectorAll('.paper-row').length >= 3, null, { timeout: 30000 });
    const row = lp.locator(`.paper-row[data-id="${ids.kiekkas}"]`);
    await row.locator('button[aria-label="논문 메뉴"]').click();
    await lp.locator('.menu .menu-item', { hasText: '삭제' }).click();
    await lp.waitForSelector('.modal .modal-message');
    const text = (await lp.locator('.modal .modal-message').textContent()).trim();
    const title = (await lp.locator('.modal .modal-title').textContent()).trim();
    const ok = (await lp.locator('.modal-footer .btn-danger').textContent()).trim();
    await shot(lp.locator('.modal'), 'delete-confirm');
    await lp.locator('.modal-footer .btn-danger').click();
    await lp.waitForFunction(() => !document.querySelector('.modal-backdrop'), null, { timeout: 3000 });
    await lp.waitForFunction((id) => !document.querySelector(`.paper-row[data-id="${id}"]`), ids.kiekkas);
    const toastText = (await lp.locator('.toast', { hasText: '휴지통으로 옮겼습니다' }).last().textContent()).trim();
    const modals = await lp.locator('.modal').count();
    await waitFor(() => teamJson('library.json').papers.find((p) => p.id === ids.kiekkas)?.deleted === true, 30000, 'tombstone pushed');
    const tomb = teamJson('library.json').papers.find((p) => p.id === ids.kiekkas);
    assert(text.includes('휴지통으로 이동합니다. 30일 안에 복구할 수 있습니다'), text);
    assert(ok === '휴지통으로 이동' && modals === 0, `button ${ok}, modals left ${modals}`);
    assert(tomb.deletedBy === NAMES.lee && teamFiles().has(`papers/${ids.kiekkas}/paper.pdf`), `tombstone ${JSON.stringify({ by: tomb.deletedBy, at: tomb.deletedAt })}; pdf kept ${teamFiles().has(`papers/${ids.kiekkas}/paper.pdf`)}`);
    return `“${title}”: “${text.replace(/\n/g, ' / ')}” [${ok}] → one dialog; toast “${toastText.replace(/\s+/g, ' ')}”; server tombstone deletedBy=${tomb.deletedBy}, PDF kept`;
  });

  await test('휴지통: 김동료 sees who deleted it and when, and restores it', async () => {
    await syncShared(kp);
    await kp.waitForFunction((id) => !document.querySelector(`.paper-row[data-id="${id}"]`), ids.kiekkas, { timeout: 20000 });
    await sec(kp, 'shared:team').locator('.tree-item.is-trash').click();
    await kp.waitForFunction(() => location.hash === '#/s/team/trash');
    await kp.waitForSelector(`.trash-row[data-id="${ids.kiekkas}"]`);
    const row = kp.locator(`.trash-row[data-id="${ids.kiekkas}"]`);
    const meta = (await row.locator('.paper-meta').textContent()).replace(/\s+/g, ' ').trim();
    const hasAdmin = await kp.locator('.trash-admin').count();
    await shot(kp, 'trash');
    await row.locator('.btn', { hasText: '복구' }).click();
    await kp.waitForFunction(() => [...document.querySelectorAll('.toast')].some((t) => /복구했습니다/.test(t.textContent)));
    await kp.waitForFunction((id) => !document.querySelector(`.trash-row[data-id="${id}"]`), ids.kiekkas);
    await sec(kp, 'shared:team').locator('.tree-item.is-folder', { hasText: '간호 중재' }).click();
    await kp.waitForFunction((id) => document.querySelector(`.paper-row[data-id="${id}"]`), ids.kiekkas);
    await waitFor(() => !teamJson('library.json').papers.find((p) => p.id === ids.kiekkas)?.deleted, 30000, 'restore pushed');
    assert(meta.includes(NAMES.lee) && /오늘 \d\d:\d\d 삭제/.test(meta) && /30일 남음/.test(meta), `meta “${meta}”`);
    assert(hasAdmin === 0, 'an invitee sees the admin purge');
    return `trash row “${meta}”; no admin button for 김동료; 복구 → back in ‘간호 중재’ and pushed`;
  });

  await test('최근 활동 lists who added, deleted and restored what', async () => {
    await sec(kp, 'shared:team').locator('.tree-item.is-activity').click();
    await kp.waitForFunction(() => location.hash === '#/s/team/activity');
    await kp.waitForSelector('.activity-item', { timeout: 15000 });
    const items = await kp.$$eval('.activity-item', (els) => els.map((e) => e.querySelector('.activity-text').textContent.replace(/\s+/g, ' ').trim()));
    const day = await kp.$eval('.activity-day-title', (e) => e.textContent);
    await shot(kp, 'activity');
    const has = (re) => items.some((t) => re.test(t));
    assert(day === '오늘', `day group ${day}`);
    assert(has(new RegExp(`^${NAMES.owner}`)) && has(new RegExp(`^${NAMES.kim}`)) && has(new RegExp(`^${NAMES.lee}`)), `names in ${items}`);
    assert(has(/논문 삭제/) && has(/복구/) && has(/논문 추가/), `actions in ${items}`);
    assert(has(/^김동료\s?나/), `own entries marked 나: ${items}`);
    return `${items.length} entries under “${day}”: ${items.slice(0, 6).join(' | ')}`;
  });

  await test('공용 서재 folder delete: contents stay visible; 복구 brings the folder back with its paper', async () => {
    await kp.goto(`${APP}#/s/team`);
    await sharedReady(kp);
    const folder = sec(kp, 'shared:team').locator('.tree-item.is-folder', { hasText: '섬망 연구' });
    await folder.click();
    await kp.waitForFunction(() => document.querySelector('.lib-title')?.textContent === '섬망 연구');
    const inside = await rowTitles(kp);
    await folder.click({ button: 'right' });
    await kp.locator('.menu .menu-item', { hasText: '삭제' }).click();
    await kp.waitForSelector('.modal .modal-message');
    const text = (await kp.locator('.modal .modal-message').textContent()).trim();
    await kp.locator('.modal-footer .btn-danger', { hasText: '휴지통으로 이동' }).click();
    await kp.waitForFunction(() => !document.querySelector('.modal-backdrop'));
    await kp.waitForFunction(() => document.querySelector('.lib-title')?.textContent === '전체');
    const topLevel = await rowTitles(kp);
    await toastAction(kp, '되돌리기');
    await kp.waitForFunction(() => [...document.querySelectorAll('.lib-sec[data-lib="shared:team"] .tree-item.is-folder .tree-label')].some((e) => e.textContent === '섬망 연구'), null, { timeout: 5000 });
    await sec(kp, 'shared:team').locator('.tree-item.is-folder', { hasText: '섬망 연구' }).click();
    const back = await rowTitles(kp);
    assert(text.includes('휴지통으로 이동합니다. 30일 안에 복구할 수 있습니다') && text.includes('삭제되지 않고 최상위에 보이며'), text);
    assert(inside.length === 1 && topLevel.includes(inside[0]) && back.join() === inside.join(), `inside ${inside} / top ${topLevel.length} / back ${back}`);
    return `“${text.replace(/\n/g, ' / ')}”; its paper stayed listed (전체); 되돌리기 → folder back with [${back.map((t) => t.slice(0, 30))}]`;
  });

  await test('owner (admin token): ‘30일 지난 항목 비우기’ removes files of papers deleted over 30 days ago', async () => {
    // A paper someone deleted 40 days ago (written straight into the team repo, as an old commit would have).
    const lib = teamJson('library.json');
    const old = Date.now() - 40 * DAY;
    lib.papers.push({ id: 'p_oldtrial', title: 'Old Trial 2019', authors: 'X. Old', year: 2019, fileName: 'old.pdf', size: 1200, pages: 1, folderId: null, starred: false,
      addedAt: old - DAY, updatedAt: old, deleted: true, deletedAt: old, deletedBy: NAMES.kim, lastOpenedAt: null, translatedCount: 0, sentenceCount: 0 });
    github.commitFiles(TEAM.owner, TEAM.repo, { 'library.json': JSON.stringify(lib, null, 2), 'papers/p_oldtrial/paper.pdf': '%PDF-1.4\n% old trial\n' }, { message: `[${NAMES.kim}] 논문 삭제 ‘Old Trial 2019’` });
    await op.goto(`${APP}#/s/team/trash`);
    await sharedReady(op);
    await syncShared(op);
    await op.waitForSelector('.trash-old', { timeout: 20000 });
    const summary = (await op.locator('.trash-old > summary').textContent()).trim();
    const admin = (await op.locator('.trash-admin').textContent()).replace(/\s+/g, ' ').trim();
    await shot(op, 'trash-admin');
    await op.locator('.trash-admin .btn', { hasText: '30일 지난 항목 비우기' }).click();
    await op.waitForSelector('.modal .modal-message');
    const confirmText = (await op.locator('.modal .modal-message').textContent()).trim();
    await op.locator('.modal-footer .btn-danger', { hasText: '비우기' }).click();
    await op.waitForFunction(() => [...document.querySelectorAll('.toast')].some((t) => /논문 1편의 파일을 지웠습니다/.test(t.textContent)), null, { timeout: 20000 });
    const toastText = (await op.locator('.toast', { hasText: '파일을 지웠습니다' }).last().textContent()).trim();
    const call = adminCalls.find((c) => c.path === '/relay/admin/shared/team/purge');
    await syncShared(op);
    await op.waitForFunction(() => !document.querySelector('.trash-row[data-id="p_oldtrial"]'), null, { timeout: 20000 });
    assert(summary === '30일 지난 항목 1개', summary);
    assert(call?.method === 'POST' && call.auth === `Bearer ${ADMIN_TOKEN}`, JSON.stringify(call));
    assert(!teamFiles().has('papers/p_oldtrial/paper.pdf') && teamFiles().has(`papers/${ids.kiekkas}/paper.pdf`), 'purge removed the wrong files');
    return `“${summary}”; admin box “${admin.slice(0, 80)}…”; confirm “${confirmText.split('\n')[0]}”; POST /relay/admin/shared/team/purge with the admin token; toast “${toastText}”; the item left the 휴지통`;
  });

  await test('settings: 공용 서재 status block names the team library and the person', async () => {
    await kp.goto(`${APP}#/settings/shared`);
    await kp.waitForSelector('#set-shared .shared-lib');
    await kp.waitForFunction(() => /동기화 완료/.test(document.querySelector('#set-shared .shared-lib .test-result')?.textContent || ''), null, { timeout: 20000 });
    const text = (await kp.locator('#set-shared').textContent()).replace(/\s+/g, ' ');
    const nav = await kp.locator('.settings-nav .btn', { hasText: '공용 서재' }).count();
    const adminKim = await kp.locator('#set-shared .btn', { hasText: '용량 확인' }).count();
    await shot(kp.locator('#set-shared'), 'settings-shared');
    // the owner can see the size
    await op.goto(`${APP}#/settings/shared`);
    await op.waitForSelector('#set-shared .btn >> text=용량 확인');
    await op.locator('#set-shared .btn', { hasText: '용량 확인' }).click();
    await op.waitForSelector('#set-shared .shared-admin-stats .stat');
    const stats = (await op.locator('#set-shared .shared-admin-stats').textContent()).replace(/\s+/g, ' ');
    assert(text.includes('공용 서재') && text.includes('team') && text.includes(`내 이름${NAMES.kim}`), text.slice(0, 300));
    assert(nav === 1 && adminKim === 0, `nav ${nav}, admin for 김동료 ${adminKim}`);
    assert(/논문\s?3편/.test(stats) && /사람/.test(stats), stats);
    return `김동료: “${text.slice(0, 160).trim()}…”; owner stats “${stats.trim()}”`;
  });

  await test('내 서재 휴지통: a deleted folder is listed (삭제한 사람 ‘나’) and restored', async () => {
    await op.goto(`${APP}#/`);
    await sharedReady(op);
    await sec(op, 'mine').locator('.lib-nav-heading button').click();
    await answerPrompt(op, '임시 폴더');
    await op.waitForSelector('.lib-title >> text=임시 폴더');
    await sec(op, 'mine').locator('.tree-item.is-folder', { hasText: '임시 폴더' }).click({ button: 'right' });
    await op.locator('.menu .menu-item', { hasText: '삭제' }).click();
    await op.waitForSelector('.modal .modal-message');
    const text = (await op.locator('.modal .modal-message').textContent()).trim();
    await op.locator('.modal-footer .btn-danger').click();
    await op.waitForFunction(() => !document.querySelector('.modal-backdrop'));
    await sec(op, 'mine').locator('.tree-item.is-trash').click();
    await op.waitForFunction(() => location.hash === '#/trash');
    await op.waitForSelector('.trash-row[data-kind="folder"]');
    const meta = (await op.locator('.trash-row[data-kind="folder"] .paper-meta').first().textContent()).replace(/\s+/g, ' ').trim();
    const intro = (await op.locator('.trash > .note').textContent()).trim();
    await shot(op, 'trash-mine');
    await op.locator('.trash-row[data-kind="folder"] .btn', { hasText: '복구' }).first().click();
    await op.waitForFunction(() => [...document.querySelectorAll('.toast')].some((t) => /‘임시 폴더’을\(를\) 복구했습니다/.test(t.textContent)));
    const back = await sec(op, 'mine').locator('.tree-item.is-folder .tree-label').allTextContents();
    assert(/폴더를 삭제할까요/.test(text) && !/휴지통으로 이동합니다/.test(text), text);
    assert(meta.startsWith('나') && /오늘 \d\d:\d\d 삭제/.test(meta), meta);
    assert(back.includes('임시 폴더'), `내 서재 folders ${back}`);
    return `내 서재 confirm “${text.split('\n')[0]}”; #/trash row “${meta}”; note “${intro.slice(0, 60)}…”; 복구 → folders [${back}]`;
  });

  await test('routes: #/s/team/activity and #/s/team/trash deep links; unknown library; device without a code', async () => {
    await kp.goto(`${APP}#/s/team/activity`);
    await kp.waitForSelector('.activity-item', { timeout: 20000 });
    const activityTitle = await kp.locator('.lib-title').textContent();
    await kp.goto(`${APP}#/s/team/trash`);
    await kp.waitForSelector('.trash');
    const trashTitle = await kp.locator('.lib-title').textContent();
    await kp.goto(`${APP}#/s/nope`);
    await kp.waitForSelector('.empty-state h2');
    const unknown = await kp.locator('.empty-state h2').textContent();
    const C = await device('no-code', {});
    await C.page.goto(`${APP}#/s/team`);
    await C.page.waitForSelector('.empty-state h2');
    const off = await C.page.locator('.empty-state h2').textContent();
    const sections = await C.page.locator('.lib-sec').count();
    await C.page.goto(`${APP}#/s/team/paper/p_x`);
    await C.page.waitForSelector('.reader .message-screen .message-title');
    const readerOff = await C.page.locator('.message-title').textContent();
    await C.ctx.close();
    assert(activityTitle === '최근 활동' && trashTitle === '휴지통', `${activityTitle} / ${trashTitle}`);
    assert(unknown === '이 공용 서재를 찾을 수 없습니다', unknown);
    assert(off === '공용 서재에 연결되어 있지 않습니다' && sections === 0 && readerOff === '공용 서재에 연결되어 있지 않습니다', `${off} / sections ${sections} / ${readerOff}`);
    return `deep links → “${activityTitle}”, “${trashTitle}”; #/s/nope → “${unknown}”; no code: sidebar sections ${sections}, #/s/team → “${off}”, reader → “${readerOff}”`;
  });

  await test('invitee picks 내 서재: #/ stays there; 공용 서재 click goes back', async () => {
    await kp.goto(`${APP}#/s/team`);
    await sharedReady(kp);
    await sec(kp, 'mine').locator('.lib-sec-toggle').click();
    await sec(kp, 'mine').locator('.tree-item', { hasText: '전체' }).click();
    await kp.waitForFunction(() => location.hash === '#/' && document.querySelector('.lib-sec.is-current')?.dataset.lib === 'mine');
    await kp.goto(`${APP}#/`);
    await sharedReady(kp);
    await sleep(300);
    const after = await hashOf(kp);
    await sec(kp, 'shared:team').locator('.tree-item', { hasText: '전체' }).click();
    await kp.waitForFunction(() => location.hash === '#/s/team');
    await kp.goto(`${APP}#/`);
    await sharedReady(kp);
    await kp.waitForFunction(() => location.hash === '#/s/team', null, { timeout: 5000 });
    assert(after === '#/', `after choosing 내 서재, #/ went to ${after}`);
    return `내 서재 chosen → reload #/ stays ${after}; 공용 서재 chosen again → #/ → #/s/team`;
  });

  await test('first visit with the relay unreachable: the 공용 서재 section says so; 다시 시도 connects', async () => {
    const P = await device('park', seeds.invitee('park'));
    P.relayDown();
    await P.page.goto(`${APP}#/`);
    await booted(P.page);
    await P.page.waitForSelector('.lib-sec[data-lib="shared:"] .lib-sec-state.is-error', { timeout: 20000 });
    const text = (await P.page.locator('.lib-sec-state.is-error').textContent()).replace(/\s+/g, ' ').trim();
    await shot(P.page, 'shared-offline');
    P.relayUp();
    await P.page.locator('.lib-sec-state .btn', { hasText: '다시 시도' }).click();
    await sharedReady(P.page);
    await P.page.waitForFunction(() => location.hash === '#/s/team' || document.querySelector('.lib-sec[data-lib="shared:team"]'), null, { timeout: 10000 });
    const hash = await hashOf(P.page);
    await P.ctx.close();
    assert(/초대 코드 서버에 연결할 수 없습니다/.test(text), text);
    return `error state “${text}”; after 다시 시도 the section opened (hash ${hash})`;
  });

  await test('drag a 내 서재 paper onto a 공용 서재 folder: one question, then copied (PDF already there → placed, not uploaded)', async () => {
    await op.goto(`${APP}#/`);
    await sharedReady(op);
    await sec(op, 'mine').locator('.tree-item', { hasText: '전체' }).click();
    const row = op.locator('.paper-row', { hasText: ids.kiekkasTitle.slice(0, 30) });
    const pdfsBefore = teamPdfs().length;
    await row.dragTo(sec(op, 'shared:team').locator('.tree-item.is-folder', { hasText: '팀 섬망 자료' }));
    await op.waitForSelector('.modal .modal-message');
    const text = (await op.locator('.modal .modal-message').textContent()).trim();
    await op.locator('.modal-footer .btn-primary', { hasText: '복사' }).click();
    await op.waitForFunction(() => [...document.querySelectorAll('.toast')].some((t) => /새로 올리지 않고 ‘팀 섬망 자료’ 폴더에 두었습니다/.test(t.textContent)), null, { timeout: 30000 });
    const toastText = (await op.locator('.toast', { hasText: '새로 올리지 않고' }).last().textContent()).trim();
    const mineRows = await rowTitles(op);
    assert(/공용 서재의 ‘팀 섬망 자료’ 폴더로 복사할까요/.test(text), text);
    assert(teamPdfs().length === pdfsBefore && mineRows.length === 2, `team PDFs ${pdfsBefore} → ${teamPdfs().length}; 내 서재 rows ${mineRows.length}`);
    return `confirm “${text.split('\n')[0]}”; toast “${toastText}”; team PDFs ${pdfsBefore} → ${teamPdfs().length}; 내 서재 keeps its ${mineRows.length} papers`;
  });

  await test('dark theme: both sections, 휴지통 and 최근 활동 use the theme tokens', async () => {
    await op.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
    await op.goto(`${APP}#/s/team/activity`);
    await op.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
    await op.waitForSelector('.activity-item', { timeout: 20000 });
    await op.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
    await sleep(200);
    const bg = await op.evaluate(() => getComputedStyle(document.querySelector('.activity-list')).backgroundColor);
    await shot(op, 'dark-activity');
    await op.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
    assert(bg === 'rgb(24, 27, 33)', `activity list background ${bg}`);
    return `activity list background ${bg} (--surface, dark)`;
  });

  await test('narrow screen: sections in the drawer, no horizontal scroll', async () => {
    await kp.setViewportSize({ width: 390, height: 820 });
    await kp.goto(`${APP}#/s/team`);
    await sharedReady(kp);
    await kp.locator('.lib-menu-btn').click();
    await sleep(300);
    const st = await kp.evaluate(() => ({ scroll: document.documentElement.scrollWidth, width: innerWidth, open: document.querySelector('.library').classList.contains('is-drawer-open') }));
    await shot(kp, 'narrow-drawer');
    await kp.keyboard.press('Escape');
    await kp.setViewportSize({ width: 1440, height: 900 });
    assert(st.open && st.scroll <= st.width, JSON.stringify(st));
    return `drawer open at 390px, scrollWidth ${st.scroll} ≤ ${st.width}`;
  });

  for (const d of [O, K, L]) {
    const csp = await d.page.evaluate(() => window.__csp?.length || 0).catch(() => 0);
    if (csp) problems.push(`${d.name}: ${csp} CSP violations`);
    if (d.external.length) problems.push(`${d.name}: external ${d.external.join(', ')}`);
    await d.ctx.close();
  }
  await test('no console errors, page errors, CSP violations or escaped requests', async () => {
    assert(!problems.length, problems.join('\n'));
    return `0 problems; expected HTTP refusals logged by Chromium: ${expected404.length}`;
  });
} finally {
  await browser.close();
  await relay.close();
  await github.close();
  if (server) server.kill();
  const failed = results.filter((r) => r.result !== 'pass');
  writeFileSync(`${OUT}/results.json`, JSON.stringify({ results, expectedHttpRefusals: expected404 }, null, 2));
  console.log(`\nshared-ui: ${results.length - failed.length}/${results.length} passed${failed.length ? ` — FAILED: ${failed.map((f) => f.name).join(' | ')}` : ''}`);
  console.log(`results + screenshots: ${OUT}`);
  process.exitCode = failed.length ? 1 : 0;
}
