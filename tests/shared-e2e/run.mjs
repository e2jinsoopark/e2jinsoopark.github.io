// 공용 서재 (docs/SHARED.md), end to end with the REAL relay Worker and the real app:
//   node tests/shared-e2e/run.mjs [--headed]
// Starts, and stops again:
//   - one fake GitHub on 127.0.0.1:8196 (tests/store/fake-github.mjs) holding BOTH repos: the owner's personal repo
//     (dindoopark/paper-library, reached by the browser through route interception of https://api.github.com) and the
//     team repo (dindoopark/paper-team-library, reached only by the Worker through GITHUB_API_BASE). Each repo has its
//     own token; the team repo starts empty, so the first push bootstraps it through the proxy;
//   - a fake Anthropic API on 127.0.0.1:8788 (tests/relay-e2e/fake-anthropic.mjs);
//   - the relay Worker under `wrangler dev` on 127.0.0.1:8787 (fresh local D1 with relay/schema.sql), with the
//     production vars of relay/wrangler.jsonc (ALLOWED_ORIGINS, SHARED_LIBRARIES = the team repo) plus GITHUB_API_BASE,
//     UPSTREAM_URL and fake secrets (ANTHROPIC_API_KEY, ADMIN_TOKEN, TEAM_GITHUB_TOKEN) as --var;
//   - `python -m http.server 8195` serving a staged copy of the site (tests/relay-e2e/test-site.mjs: the files
//     pages.yml publishes + the two deploy edits; the repo files stay untouched).
// Edge runs the app with the real Anthropic SDK from jsDelivr; no paid API is called, nothing is deployed, and
// neither the real GitHub nor the real relay is ever contacted.
// Scenario: the owner creates invite codes (김간호사, 이간호사, their own), copies a 내 서재 folder with two papers into
// 공용 서재; 김간호사 (fresh browser, join link) makes a folder, uploads lu2025.pdf, translates page 1 and highlights a
// sentence; 이간호사 sees folder, paper and translation (0 translation calls) but not 김간호사's highlight, highlights
// one of her own and deletes the paper; 김간호사 finds it in 휴지통 with 이간호사's name and restores it; 최근 활동 names
// everyone; both change the library at the same moment (one push held at GitHub → 422 → merge and retry); 이간호사 on a
// second fresh browser finds her own highlight. Then the repo is checked: no 내 서재-only paper, no invite code
// anywhere, people/ isolated per person, no refusal from the Worker.
// Results + screenshots: C:/Users/dindoo/Projects/pr-tools/out/shared-e2e/.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'file:///C:/Users/dindoo/Projects/pr-tools/node_modules/playwright/index.mjs';
import { freshDatabase, startWrangler } from '../../relay/test/lib.mjs';
import { startFakeAnthropic, TRANSLATION_PREFIX } from '../relay-e2e/fake-anthropic.mjs';
import { stageTestSite } from '../relay-e2e/test-site.mjs';
import { routeGitHubToFake, startFakeGitHub } from '../store/fake-github.mjs';

const APP_PORT = 8195;
const GITHUB_PORT = 8196;
const UPSTREAM_PORT = 8788;
const APP_ORIGIN = `http://127.0.0.1:${APP_PORT}`;
const WORKER = 'http://127.0.0.1:8787'; // relay/test/lib.mjs starts wrangler dev here
const OUT = 'C:/Users/dindoo/Projects/pr-tools/out/shared-e2e';
const FIXTURES = 'C:/Users/dindoo/Projects/pr-fixtures';
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SETTINGS_KEY = 'pr.settings.v1';
const OWNER_KEY = 'sk-ant-shared-e2e-fake-owner-key-0000';
const ADMIN_TOKEN = 'shared-e2e-admin-token-0123456789abcdef';
/** The team repo of relay/wrangler.jsonc SHARED_LIBRARIES (the production value; only GitHub is faked). */
const TEAM = { owner: 'dindoopark', repo: 'paper-team-library', token: 'github_pat_team_shared_e2e_0123456789' };
const MINE = { owner: 'dindoopark', repo: 'paper-library', token: 'github_pat_owner_personal_e2e_0123456789' };
const NAMES = { owner: '박진수', kim: '김간호사', lee: '이간호사' };
const COPIED = ['kiekkas2012', 'simwright2005']; // 내 서재 folder ‘섬망 연구’ → 공용 서재
const PRIVATE = 'cohen1960'; // stays in 내 서재 only
const UPLOADED = 'lu2025'; // 김간호사 uploads it into 공용 서재 (CC BY)
const SHARED_NOTE = '번역은 모두와 공유, 메모는 나만';
const headed = process.argv.includes('--headed');

mkdirSync(OUT, { recursive: true });
const results = [];
const problems = []; // page errors, unexpected console errors, CSP violations, blocked requests, native dialogs
const expectedRefusals = []; // Chromium's "Failed to load resource" for answers the app expects (409/422/304…)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shortHash = (s) => createHash('sha1').update(String(s ?? '')).digest('hex').slice(0, 12);
const gitBlobSha = (buf) => createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${buf.length}\0`), buf])).digest('hex');

function assert(cond, msg) { if (!cond) throw new Error(msg); }
function assertEqual(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg}: expected ${e}, got ${a}`);
}

let blocked = null; // first failed step: the scenario steps after it are skipped (they build on it)

/** One scenario step. `always`: runs even after an earlier failure (it does not build on the steps before). */
async function step(name, fn, { always = false } = {}) {
  if (blocked && !always) {
    results.push({ name, result: 'skipped', evidence: `skipped: “${blocked}” failed` });
    console.log(`SKIP  ${name}`);
    return;
  }
  const t0 = Date.now();
  const before = problems.length;
  try {
    const evidence = await fn();
    const fresh = problems.slice(before);
    if (fresh.length) throw new Error(`console/CSP/network problems during the step:\n  ${fresh.join('\n  ')}`);
    results.push({ name, result: 'pass', evidence: String(evidence ?? 'ok'), ms: Date.now() - t0 });
    console.log(`PASS  ${name}  (${Date.now() - t0} ms)\n      ${evidence ?? ''}`);
  } catch (err) {
    if (!always) blocked ||= name;
    results.push({ name, result: 'fail', evidence: err?.stack || String(err), ms: Date.now() - t0 });
    console.log(`FAIL  ${name}\n      ${err?.stack || err}`);
  }
}

async function waitFor(fn, { timeout = 15000, interval = 150, what = 'condition' } = {}) {
  const t0 = Date.now();
  let last;
  for (;;) {
    last = await fn();
    if (last) return last;
    if (Date.now() - t0 > timeout) throw new Error(`timeout waiting for ${what} (last: ${JSON.stringify(last)})`);
    await sleep(interval);
  }
}

// ------------------------------------------------------------------------------------------------- servers

/** The Worker's admin API, called from Node (no Origin header). */
async function admin(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${WORKER}${path}`, {
    method,
    headers: { authorization: `Bearer ${ADMIN_TOKEN}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`admin ${method} ${path} → ${res.status} ${JSON.stringify(data)}`);
  return data;
}

/** A shared-library call to the Worker with an invite code (as the app's GitHubClient makes it). */
async function asPerson(code, path) {
  const res = await fetch(`${WORKER}${path}`, { headers: { authorization: `Bearer ${code}`, accept: 'application/vnd.github+json' } });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
}

async function appUp() {
  try { return (await fetch(`${APP_ORIGIN}/index.html`)).ok; } catch { return false; }
}

/** Serve the staged site; refuses to reuse whatever else might already answer on the port. */
async function serveSite(dir) {
  if (await appUp()) throw new Error(`port ${APP_PORT} is already in use; stop that server first`);
  const proc = spawn('python', ['-m', 'http.server', String(APP_PORT), '--bind', '127.0.0.1'], { cwd: dir, stdio: 'ignore', windowsHide: true });
  await waitFor(appUp, { timeout: 8000, what: 'python http.server' });
  return proc;
}

// ------------------------------------------------------------------------------------------------- team repo

let gh = null;
const teamFiles = () => gh.files(TEAM.owner, TEAM.repo);
const teamJson = (path) => {
  const b = gh.readFile(TEAM.owner, TEAM.repo, path);
  return b ? JSON.parse(b.toString('utf8')) : null;
};
const teamLibrary = () => teamJson('library.json') || { folders: [], papers: [] };
const teamPdfs = () => [...teamFiles().keys()].filter((p) => /^papers\/[^/]+\/paper\.pdf$/.test(p));
const teamCommits = () => (gh.repo(TEAM.owner, TEAM.repo).empty ? [] : gh.commits(TEAM.owner, TEAM.repo));
const mineFiles = () => gh.files(MINE.owner, MINE.repo);
const mineJson = (path) => {
  const b = gh.readFile(MINE.owner, MINE.repo, path);
  return b ? JSON.parse(b.toString('utf8')) : null;
};

/** personId (SHARED.md §1): the first 16 hex characters of SHA-256 of the normalised code. */
const personIdOf = (code) => createHash('sha256').update(code).digest('hex').slice(0, 16);

// ------------------------------------------------------------------------------------------------- browser

let browser = null;

/**
 * One browser context = one device. Only the staged app, the Worker, the pinned SDK bundle (jsDelivr /npm/) and the
 * fake personal GitHub (https://api.github.com, route-forwarded) may be reached; anything else is aborted and
 * reported. Every browser → Worker response is logged in `relayLog`.
 */
async function device(name, seed = null, { viewport = { width: 1440, height: 900 } } = {}) {
  const ctx = await browser.newContext({ locale: 'ko-KR', viewport, colorScheme: 'light' });
  await ctx.route(/^https?:\/\/(?!127\.0\.0\.1:(?:8195|8787)\/)/, (route) => {
    const url = route.request().url();
    if (url.startsWith('https://cdn.jsdelivr.net/gh/orioncactus/pretendard')) {
      return route.fulfill({ status: 200, contentType: 'text/css', body: '/* font stub (offline test) */' });
    }
    if (url.startsWith('https://cdn.jsdelivr.net/npm/')) return route.continue(); // the pinned SDK bundle + deps
    problems.push(`${name}: external request blocked ${url}`);
    return route.abort();
  });
  await routeGitHubToFake(ctx, gh.url); // registered last → runs first for https://api.github.com
  await ctx.addInitScript(({ key, seed }) => {
    try { if (seed && !localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify(seed)); } catch { /* blocked */ }
    document.addEventListener('securitypolicyviolation', (e) => {
      console.error(`[csp] ${e.violatedDirective} blocked ${e.blockedURI}`);
    });
  }, { key: SETTINGS_KEY, seed });
  const page = await ctx.newPage();
  const relayLog = [];
  const started = new WeakMap();
  const answered = new WeakMap(); // request → status, so a body cancelled after the answer is not counted twice
  page.on('request', (req) => { if (req.url().startsWith(WORKER)) started.set(req, Date.now()); });
  page.on('response', (res) => {
    const req = res.request();
    if (!req.url().startsWith(WORKER) || req.method() === 'OPTIONS') return;
    answered.set(req, res.status());
    const u = new URL(req.url());
    relayLog.push({ method: req.method(), path: u.pathname, search: u.search, status: res.status(), body: shortHash(req.postData()), at: Date.now() });
  });
  page.on('requestfailed', (req) => {
    if (!req.url().startsWith(WORKER)) return;
    const u = new URL(req.url());
    // A conditional GET answered 304 has no body to read: Chromium then reports the request as aborted too.
    if (answered.get(req) === 304) return;
    relayLog.push({
      method: req.method(), path: u.pathname, status: 'failed', error: req.failure()?.errorText, at: Date.now(),
      ms: Date.now() - (started.get(req) ?? Date.now()), answered: answered.get(req) ?? null,
    });
  });
  page.on('pageerror', (e) => problems.push(`${name}: pageerror ${e.message}`));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const where = String(m.location()?.url || '');
    // Chromium logs every non-2xx answer: the empty team repo's 409s, conflicts (409/422) while several people push.
    if (/^Failed to load resource/.test(m.text()) && (where.startsWith(WORKER) || where.startsWith('https://api.github.com'))) {
      expectedRefusals.push(`${name}: ${m.text()} ${where.replace(/\?.*$/, '')}`);
      return;
    }
    problems.push(`${name}: console.error ${m.text()}`);
  });
  page.on('dialog', (d) => {
    problems.push(`${name}: native ${d.type()} dialog “${d.message()}”`);
    d.dismiss().catch(() => {});
  });
  return { name, ctx, page, relayLog };
}

const shot = (target, file, opts = {}) => target.screenshot({ path: `${OUT}/${file}.png`, ...opts });
const fixture = (name) => `${FIXTURES}/${name}.pdf`;
const hashOf = (page) => page.evaluate(() => location.hash);
const sec = (page, key) => page.locator(`.lib-sec[data-lib="${key}"]`);
const rowTitles = (page) => page.$$eval('.paper-row .paper-title', (els) => els.map((e) => e.textContent.trim()));
const toastTexts = (page) => page.$$eval('.toast', (els) => els.map((e) => e.textContent.replace(/\s+/g, ' ').trim()));

/** The 공용 서재 section has opened (its folder tree is shown). */
async function sharedReady(page) {
  await page.waitForSelector('.lib-sec[data-lib="shared:team"] .lib-sec-body .lib-nav-heading', { timeout: 30000 });
}

async function answerPrompt(page, value) {
  const input = page.locator('.modal-backdrop input[type="text"], .modal-backdrop input:not([type])').last();
  await input.waitFor();
  await input.fill(value);
  await input.press('Enter');
}

/** 공용 서재 sync chip → 지금 동기화, then wait until it is idle again. */
async function syncShared(page) {
  await page.locator('.lib-sec-sync[data-lib="shared:team"]').click();
  await page.waitForFunction(() => {
    const c = document.querySelector('.lib-sec-sync[data-lib="shared:team"]');
    return c && !c.classList.contains('is-busy');
  }, null, { timeout: 30000 });
}

/** Open the join link (`#/join/<CODE>`, a fragment no server sees) and continue to the library. */
async function joinWithLink(page, code, name) {
  await page.goto(`${APP_ORIGIN}/#/join/${code}`);
  await page.waitForSelector('.message-screen.tone-success', { timeout: 30000 });
  const title = (await page.locator('.message-title').innerText()).trim();
  assertEqual(title, `환영합니다, ${name}님`, 'welcome title');
  await page.locator('.message-actions .btn', { hasText: '논문 읽으러 가기' }).click();
  await page.waitForSelector('.library', { timeout: 30000 });
  return title;
}

async function waitForReader(page) {
  await page.waitForFunction(() => document.querySelector('.tp-s[data-sid], .tp-empty, .reader .message-screen'), null, { timeout: 60000 });
  const error = await page.$('.reader .message-screen');
  if (error) throw new Error(`reader error: ${(await error.textContent()).trim()}`);
  await page.waitForFunction(() => !document.querySelector('.reader-left .reader-loading'), null, { timeout: 30000 });
  await page.waitForFunction(() => document.querySelector('.pdfv-page canvas'), null, { timeout: 30000 });
  await sleep(500);
}

function readerState(page) {
  return page.evaluate(() => ({
    translated: document.querySelectorAll('.tp-s.is-translated').length,
    pending: document.querySelectorAll('.tp-s.is-pending').length,
    failed: document.querySelectorAll('.tp-s.is-failed').length,
    label: document.querySelector('.tb-tr-main .btn-label')?.textContent || '',
    marks: document.querySelectorAll('.pdfv-mark-layer--annotations .pdfv-mark').length,
    paneMarked: [...document.querySelectorAll('.tp-s[data-m-annotations]')].map((e) => e.dataset.sid),
  }));
}

/**
 * Highlight one text-layer span of page 1 with a real mouse drag → selection menu → colour. `pick` chooses among the
 * long visible spans (different people highlight different sentences). Returns the selected text.
 */
async function highlightOnPage1(page, pick, color) {
  const span = await page.evaluate((pick) => {
    const v = document.querySelector('.viewer-host').getBoundingClientRect();
    const spans = [...document.querySelectorAll('.pdfv-page[data-page="1"] .textLayer span')]
      .filter((s) => !s.querySelector('span') && s.textContent.length > 40 && /^[A-Za-z]/.test(s.textContent))
      .map((s) => ({ s, r: s.getBoundingClientRect() }))
      .filter(({ r }) => r.top > v.top + 60 && r.bottom < v.bottom - 60 && r.width > 150);
    const hit = spans[Math.min(pick, spans.length - 1)];
    return hit ? { text: hit.s.textContent, x: hit.r.left, y: hit.r.top, w: hit.r.width, h: hit.r.height, n: spans.length } : null;
  }, pick);
  assert(span, 'no long text-layer span visible on page 1');
  await page.mouse.move(span.x + 3, span.y + span.h / 2);
  await page.mouse.down();
  await page.mouse.move(span.x + span.w * 0.5, span.y + span.h / 2, { steps: 5 });
  await page.mouse.move(span.x + span.w - 3, span.y + span.h / 2, { steps: 5 });
  await page.mouse.up();
  await page.waitForSelector('.pf-selmenu', { timeout: 5000 });
  await page.locator(`.pf-selmenu [data-color="${color}"]`).click();
  await page.waitForSelector('.pdfv-mark-layer--annotations .pdfv-mark', { timeout: 5000 });
  await page.mouse.move(5, 300);
  return span.text;
}

/** The 메모 tab's notes (colour, quote), then back to 번역. */
async function notesOf(page) {
  await page.locator('.tab[data-tab="notes"]').click();
  await sleep(400);
  const notes = await page.$$eval('.pf-note', (els) => els.map((n) => ({
    color: [...n.classList].find((c) => c.startsWith('pf-note--'))?.slice(9) || '',
    quote: (n.querySelector('.pf-note__quote')?.textContent || n.textContent || '').trim(),
  })));
  await page.locator('.tab[data-tab="translation"]').click();
  return notes;
}

const words = (s) => String(s).toLowerCase().match(/[a-z]{3,}/g) || [];
function overlap(a, b) {
  const want = words(a);
  const have = new Set(words(b));
  return want.length ? want.filter((w) => have.has(w)).length / want.length : 0;
}

/** Repo paths in one person's IndexedDB copy of the team library (`files` store keys). */
function localPaths(page, dbName) {
  return page.evaluate((name) => new Promise((resolve, reject) => {
    const req = indexedDB.open(name);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const db = req.result;
      try {
        const keys = db.transaction('files').objectStore('files').getAllKeys();
        keys.onsuccess = () => { db.close(); resolve(keys.result.map(String)); };
        keys.onerror = () => { db.close(); reject(keys.error); };
      } catch (err) { db.close(); reject(err); }
    };
  }), dbName);
}

const translateCalls = (fake) => fake.calls.filter((c) => c.kind === 'translate');
const messagePosts = (log, from = 0) => log.slice(from).filter((r) => r.method === 'POST' && r.path === '/v1/messages');

// ===================================================================================================== run

let server = null;
let fake = null;
let stopWrangler = () => {};
const state = { codes: {}, ids: {} };
const people = [];

try {
  const staged = stageTestSite({ repo: REPO, dir: join(OUT, 'site'), workerUrl: WORKER });
  server = await serveSite(join(OUT, 'site'));
  console.log(`staged ${staged.join(', ')} with RELAY_DEFAULT_URL = ${WORKER} → ${APP_ORIGIN}`);
  gh = await startFakeGitHub({ port: GITHUB_PORT });
  gh.addToken(MINE.token, { write: true, repos: [`${MINE.owner}/${MINE.repo}`] });
  gh.addToken(TEAM.token, { write: true, repos: [`${TEAM.owner}/${TEAM.repo}`] });
  gh.createRepo(MINE.owner, MINE.repo, { private: true, files: { 'README.md': '# paper-library\n' } });
  gh.createRepo(TEAM.owner, TEAM.repo, { private: true }); // empty, as freshly created on GitHub
  fake = await startFakeAnthropic({ port: UPSTREAM_PORT });
  const stateDir = join(OUT, 'state');
  freshDatabase(stateDir);
  stopWrangler = await startWrangler({
    stateDir,
    logFile: join(OUT, 'wrangler.log'),
    vars: {
      UPSTREAM_URL: fake.url, ANTHROPIC_API_KEY: OWNER_KEY, ADMIN_TOKEN,
      GITHUB_API_BASE: gh.url, TEAM_GITHUB_TOKEN: TEAM.token,
    },
  });
  browser = await chromium.launch({
    channel: 'msedge', headless: !headed, slowMo: headed ? 40 : 0,
    args: ['--host-resolver-rules=MAP api.github.com 127.0.0.1, MAP *.github.com 127.0.0.1'],
  });

  const owner = await device('owner', {
    github: { owner: MINE.owner, repo: MINE.repo, branch: 'main', token: MINE.token },
    relay: { adminToken: ADMIN_TOKEN },
  });
  people.push(owner);
  const op = owner.page;

  await step('admin: the owner creates invite codes for 김간호사, 이간호사 and themself (설정 → 초대 코드 관리)', async () => {
    await op.goto(`${APP_ORIGIN}/index.html#/settings/invites`);
    await op.waitForSelector('#set-invites');
    await op.locator('#set-invites summary', { hasText: '관리 화면 열기' }).click();
    await op.waitForSelector('#set-invites .relay-codes >> text=아직 만든 초대 코드가 없습니다', { timeout: 15000 });
    const create = async (name) => {
      await op.fill('#set-invites input[aria-label="이름"]', name);
      await op.fill('#set-invites input[aria-label="하루 한도 (달러)"]', '1');
      await op.locator('#set-invites .relay-create .segmented .btn', { hasText: /^Haiku만$/ }).click();
      await op.locator('#set-invites .btn', { hasText: '코드 만들기' }).click();
      await op.waitForSelector(`#set-invites .relay-created >> text=${name}님의 초대 코드를 만들었습니다`);
      return (await op.locator('#set-invites .relay-created code').innerText()).trim();
    };
    for (const k of ['kim', 'lee', 'owner']) state.codes[k] = await create(NAMES[k]);
    const { codes } = await admin('/relay/admin/codes');
    const listed = Object.fromEntries(codes.map((c) => [c.code, c]));
    for (const k of ['kim', 'lee', 'owner']) {
      const c = listed[state.codes[k]];
      assert(c && c.name === NAMES[k] && c.active, `code of ${NAMES[k]} in the Worker: ${JSON.stringify(c)}`);
    }
    assertEqual(new Set(Object.values(state.codes)).size, 3, 'three different codes');
    state.pid = Object.fromEntries(Object.entries(state.codes).map(([k, c]) => [k, personIdOf(c)]));
    await shot(op, 'shared-e2e-01-codes');
    return `${Object.entries(state.codes).map(([k, c]) => `${NAMES[k]} ${c} (people/${state.pid[k]})`).join(', ')} — created in the UI, stored in D1`;
  });

  await step('owner: registers their own code (join link) → home stays 내 서재; the sidebar adds an empty 공용 서재', async () => {
    const title = await joinWithLink(op, state.codes.owner, NAMES.owner);
    await sharedReady(op);
    await op.waitForFunction(() => /동기화 완료/.test(document.querySelector('.lib-sec-sync[data-lib="mine"]')?.getAttribute('aria-label') || document.querySelector('.lib-sync')?.textContent || ''), null, { timeout: 30000 });
    const sections = await op.$$eval('.lib-sec', (els) => els.map((s) => ({
      key: s.dataset.lib, label: s.querySelector('.lib-sec-label')?.textContent, all: s.querySelector('.tree-item .tree-count')?.textContent,
    })));
    const hash = await hashOf(op);
    const info = await asPerson(state.codes.owner, '/shared');
    assertEqual(hash, '#/', 'owner home');
    assertEqual(sections.map((s) => [s.key, s.label, s.all]), [['mine', '내 서재', '0'], ['shared:team', '공용 서재', '0']], 'sidebar sections');
    assertEqual([info.status, info.body.libraries, info.body.personId, info.body.name],
      [200, [{ id: 'team', name: '공용 서재' }], state.pid.owner, NAMES.owner], 'GET /shared for the owner code');
    return `“${title}”; #/ = 내 서재; sections ${sections.map((s) => `${s.label}(전체 ${s.all})`).join(' + ')}; GET /shared → ${JSON.stringify(info.body)}`;
  });

  await step(`owner: 내 서재 folder ‘섬망 연구’ with ${COPIED.join(' + ')}, ${PRIVATE} at the top level — synced to the personal repo`, async () => {
    await sec(op, 'mine').locator('.lib-nav-heading button').click();
    await answerPrompt(op, '섬망 연구');
    await op.waitForSelector('.lib-title >> text=섬망 연구');
    await op.setInputFiles('.lib-actions input[type=file]', COPIED.map(fixture));
    await op.waitForFunction((n) => document.querySelectorAll('.paper-row').length === n, COPIED.length, { timeout: 60000 });
    await sec(op, 'mine').locator('.tree-item', { hasText: '전체' }).click();
    await op.waitForFunction(() => !document.querySelector('.lib-actions .btn[disabled]'), null, { timeout: 60000 });
    await op.setInputFiles('.lib-actions input[type=file]', [fixture(PRIVATE)]);
    await op.waitForFunction((n) => document.querySelectorAll('.paper-row').length === n, COPIED.length + 1, { timeout: 60000 });
    const pdfs = await waitFor(() => {
      const lib = mineJson('library.json');
      const n = [...mineFiles().keys()].filter((p) => p.endsWith('/paper.pdf')).length;
      return lib && n === 3 && lib.papers.filter((p) => !p.deleted).length === 3 ? lib : null;
    }, { timeout: 45000, what: '3 PDFs + library.json in the personal repo' });
    const folder = pdfs.folders.find((f) => f.name === '섬망 연구');
    state.ids.mine = Object.fromEntries(pdfs.papers.map((p) => [p.fileName.replace(/\.pdf$/, ''), p.id]));
    state.titles = Object.fromEntries(pdfs.papers.map((p) => [p.fileName.replace(/\.pdf$/, ''), p.title]));
    assert(folder && COPIED.every((f) => pdfs.papers.find((p) => p.id === state.ids.mine[f])?.folderId === folder.id), `folder contents ${JSON.stringify(pdfs.papers.map((p) => [p.fileName, p.folderId]))}`);
    assert(!pdfs.papers.find((p) => p.id === state.ids.mine[PRIVATE]).folderId, `${PRIVATE} not at the top level`);
    assert(!gh.repo(TEAM.owner, TEAM.repo).refs.size, 'the team repo was touched by 내 서재');
    await shot(op, 'shared-e2e-02-owner-mine');
    return `personal repo ${MINE.owner}/${MINE.repo}: ${[...mineFiles().keys()].length} files, papers ${pdfs.papers.map((p) => `${p.fileName}${p.folderId ? ' (섬망 연구)' : ''}`).join(', ')}; team repo still empty`;
  });

  await step('owner: ‘섬망 연구’ → 공용 서재로 복사… → bootstraps the empty team repo through the Worker, copies 2 PDFs, nothing personal', async () => {
    await sec(op, 'mine').locator('.tree-item.is-folder', { hasText: '섬망 연구' }).click({ button: 'right' });
    await op.locator('.menu .menu-item', { hasText: '공용 서재로 복사…' }).click();
    await op.waitForSelector('.copy-dialog .folder-picker');
    const message = (await op.locator('.copy-dialog .modal-message').textContent()).trim();
    await op.locator('.copy-dialog .modal-footer .btn', { hasText: '복사' }).click();
    await op.waitForFunction(() => [...document.querySelectorAll('.toast')].some((t) => /‘섬망 연구’ 폴더를 공용 서재 최상위에 복사했습니다/.test(t.textContent)), null, { timeout: 60000 });
    const toast = (await toastTexts(op)).find((t) => t.includes('폴더를 공용 서재 최상위에 복사했습니다'));
    const lib = await waitFor(() => {
      const l = teamJson('library.json');
      return l && teamPdfs().length === 2 && l.papers.filter((p) => !p.deleted).length === 2 && l.folders.some((f) => f.name === '섬망 연구') ? l : null;
    }, { timeout: 60000, what: 'the copy pushed to the team repo' });
    const files = [...teamFiles().keys()].sort();
    const commits = teamCommits().map((c) => c.message);
    const folder = lib.folders.find((f) => f.name === '섬망 연구');
    state.ids.teamFolder = folder.id;
    state.ids.team = Object.fromEntries(lib.papers.map((p) => [p.fileName.replace(/\.pdf$/, ''), p.id]));
    for (const f of COPIED) {
      const bytes = readFileSync(fixture(f));
      const repoPdf = gh.readFile(TEAM.owner, TEAM.repo, `papers/${state.ids.team[f]}/paper.pdf`);
      assert(repoPdf && Buffer.compare(repoPdf, bytes) === 0, `${f}: team PDF differs from the fixture`);
      assertEqual(lib.papers.find((p) => p.id === state.ids.team[f]).folderId, folder.id, `${f} folder`);
    }
    assert(!files.some((p) => p.startsWith('people/')), `personal files in the team repo: ${files}`);
    assert(!lib.papers.some((p) => p.fileName === `${PRIVATE}.pdf`), `${PRIVATE} copied`);
    assertEqual(commits.at(-1), `[${NAMES.owner}] 논문 리더 데이터 저장소 시작`, 'bootstrap commit (oldest)');
    assert(commits.slice(0, -1).every((m) => m.startsWith(`[${NAMES.owner}] `)) && commits.some((m) => /폴더 복사 ‘섬망 연구’/.test(m)), `commits ${JSON.stringify(commits)}`);
    await op.waitForFunction(() => /2/.test([...document.querySelectorAll('.lib-sec[data-lib="shared:team"] .tree-item.is-folder')].find((e) => e.textContent.includes('섬망 연구'))?.querySelector('.tree-count')?.textContent || ''));
    await shot(op, 'shared-e2e-03-owner-copied');
    return `dialog “${message}”; toast “${toast}”; team repo ${files.join(', ')}; commits (newest first) ${commits.map((m) => `“${m}”`).join(' · ')}`;
  });

  const kim = await device('kim');
  people.push(kim);
  const kp = kim.page;

  await step('김간호사 (fresh browser, join link): 공용 서재 opens by default with the owner’s folder and its 2 papers', async () => {
    const title = await joinWithLink(kp, state.codes.kim, NAMES.kim);
    await kp.waitForFunction(() => location.hash === '#/s/team', null, { timeout: 15000 });
    await sharedReady(kp);
    const folder = sec(kp, 'shared:team').locator('.tree-item.is-folder', { hasText: '섬망 연구' });
    await folder.waitFor({ timeout: 30000 });
    await folder.click();
    await kp.waitForFunction(() => document.querySelectorAll('.paper-row').length === 2, null, { timeout: 30000 });
    const titles = await rowTitles(kp);
    const mineExpanded = await sec(kp, 'mine').locator('.lib-sec-toggle').getAttribute('aria-expanded');
    assert(COPIED.every((f) => titles.includes(state.titles[f])), `rows ${titles}`);
    assertEqual(mineExpanded, 'false', '내 서재 folded for an invitee');
    await shot(kp, 'shared-e2e-04-kim-home');
    return `“${title}” → #/s/team; ‘섬망 연구’ lists [${titles.map((t) => t.slice(0, 40))}]; 내 서재 folded`;
  });

  await step('김간호사: new folder ‘ICU 섬망’, uploads lu2025.pdf into it (shared PDF on the team repo)', async () => {
    await sec(kp, 'shared:team').locator('.lib-nav-heading button').click();
    await answerPrompt(kp, 'ICU 섬망');
    await kp.waitForSelector('.lib-title >> text=ICU 섬망');
    await kp.setInputFiles('.lib-actions input[type=file]', [fixture(UPLOADED)]);
    await kp.waitForFunction(() => document.querySelectorAll('.paper-row').length === 1, null, { timeout: 60000 });
    const toast = await waitFor(async () => (await toastTexts(kp)).find((t) => /공용 서재에 추가했습니다/.test(t)), { what: 'upload toast' });
    const lib = await waitFor(() => {
      const l = teamLibrary();
      const f = l.folders.find((x) => x.name === 'ICU 섬망' && !x.deleted);
      const p = f && l.papers.find((x) => x.folderId === f.id && x.fileName === `${UPLOADED}.pdf` && !x.deleted);
      return p && teamFiles().has(`papers/${p.id}/paper.pdf`) ? { l, f, p } : null;
    }, { timeout: 60000, what: 'folder + paper + PDF pushed' });
    state.ids.lu = lib.p.id;
    state.ids.icu = lib.f.id;
    state.luTitle = lib.p.title;
    assert(Buffer.compare(gh.readFile(TEAM.owner, TEAM.repo, `papers/${lib.p.id}/paper.pdf`), readFileSync(fixture(UPLOADED))) === 0, 'uploaded PDF differs');
    assertEqual([lib.p.addedBy, typeof lib.p.sha256], [NAMES.kim, 'string'], 'paper addedBy / sha256');
    return `toast “${toast}”; team repo papers/${lib.p.id}/paper.pdf (${readFileSync(fixture(UPLOADED)).length} B, identical), folder ‘ICU 섬망’ ${lib.f.id}, addedBy ${lib.p.addedBy}`;
  });

  await step('김간호사: opens it (공용 서재 badge), 이 페이지만 번역 through the relay → shared translation.json; highlights a sentence', async () => {
    await kp.locator('.paper-row', { hasText: state.luTitle.slice(0, 30) }).locator('.paper-link').click();
    await kp.waitForFunction((id) => location.hash === `#/s/team/paper/${id}`, state.ids.lu, { timeout: 10000 });
    await waitForReader(kp);
    const badge = (await kp.locator('.tb-shared').getAttribute('aria-label')) || '';
    const callsFrom = fake.calls.length;
    const logFrom = kim.relayLog.length;
    await kp.locator('.tb-tr-more').click();
    await kp.locator('.menu .menu-item', { hasText: '이 페이지만 번역' }).click();
    const st = await waitFor(async () => {
      const s = await readerState(kp);
      return s.translated > 5 && s.pending === 0 && s.label !== '번역 중…' ? s : null;
    }, { timeout: 90000, interval: 200, what: 'page 1 translated' });
    await kp.waitForSelector('.toast >> text=번역을 마쳤습니다.', { timeout: 15000 });
    const calls = fake.calls.slice(callsFrom).filter((c) => c.kind === 'translate');
    const posts = messagePosts(kim.relayLog, logFrom);
    const shown = await kp.$$eval('.tp-s.is-translated[data-sid]', (els) => els.map((e) => ({ sid: e.dataset.sid, text: e.textContent })));
    const sent = new Set(calls.flatMap((c) => c.ids));
    assert(calls.length >= 1 && calls.every((c) => c.model === 'claude-haiku-5-5' && c.headers['x-api-key'] === OWNER_KEY), `upstream ${JSON.stringify(calls.map((c) => c.model))}`);
    assert([...sent].every((id) => /^p1-/.test(id)), 'sentences outside page 1 sent');
    assertEqual(posts.map((r) => r.status), calls.map(() => 200), 'browser → Worker /v1/messages');
    assert(shown.filter((x) => sent.has(x.sid)).every((x) => x.text.startsWith(TRANSLATION_PREFIX)), 'pane does not show the relay translation');
    const tr = await waitFor(() => {
      const t = teamJson(`papers/${state.ids.lu}/translation.json`);
      return t && [...sent].every((sid) => t.items?.[sid]?.t?.startsWith(TRANSLATION_PREFIX)) ? t : null;
    }, { timeout: 45000, what: 'translation.json pushed (shared path)' });
    state.translated = st.translated;
    state.sentIds = [...sent];

    state.quoteKim = await highlightOnPage1(kp, 1, 'yellow');
    const ann = await waitFor(() => teamJson(`people/${state.pid.kim}/papers/${state.ids.lu}/annotations.json`), { timeout: 45000, what: '김간호사 annotations pushed under people/<her id>/' });
    const live = ann.items.filter((a) => !a.deleted);
    assert(live.length === 1 && live[0].color === 'yellow' && overlap(live[0].quote, state.quoteKim) > 0.6, `annotations ${JSON.stringify(live)}`);
    assert(!teamFiles().has(`papers/${state.ids.lu}/annotations.json`), 'annotations written to the shared path');
    await shot(kp, 'shared-e2e-05-kim-translated-highlight');
    return `badge “${badge}”; ${st.translated} sentences translated in ${calls.length} batch(es) (owner key upstream, ${posts.length} browser POSTs → 200); papers/${state.ids.lu}/translation.json has ${Object.keys(tr.items).length} items; highlight “${state.quoteKim.slice(0, 50)}…” → people/${state.pid.kim}/papers/${state.ids.lu}/annotations.json`;
  });

  const lee = await device('lee');
  people.push(lee);
  const lp = lee.page;

  await step('이간호사 (fresh browser): sees ‘ICU 섬망’ and the paper, gets the translation with ZERO translation calls, not 김간호사’s highlight', async () => {
    const title = await joinWithLink(lp, state.codes.lee, NAMES.lee);
    await lp.waitForFunction(() => location.hash === '#/s/team', null, { timeout: 15000 });
    await sharedReady(lp);
    await sec(lp, 'shared:team').locator('.tree-item.is-folder', { hasText: 'ICU 섬망' }).waitFor({ timeout: 30000 });
    const folders = await sec(lp, 'shared:team').locator('.tree-item.is-folder .tree-label').allTextContents();
    await sec(lp, 'shared:team').locator('.tree-item.is-folder', { hasText: 'ICU 섬망' }).click();
    await lp.waitForFunction(() => document.querySelectorAll('.paper-row').length === 1, null, { timeout: 30000 });
    const translateFrom = translateCalls(fake).length;
    await lp.locator('.paper-row', { hasText: state.luTitle.slice(0, 30) }).locator('.paper-link').click();
    await lp.waitForFunction((id) => location.hash === `#/s/team/paper/${id}`, state.ids.lu, { timeout: 10000 });
    await waitForReader(lp);
    const st = await waitFor(async () => {
      const s = await readerState(lp);
      return s.translated >= state.translated ? s : null;
    }, { timeout: 30000, what: 'the shared translation shown' });
    await sleep(1500); // give annotations (and any wrong translation request) time to show up
    const after = await readerState(lp);
    const notes = await notesOf(lp);
    const posts = messagePosts(lee.relayLog);
    assertEqual(translateCalls(fake).length - translateFrom, 0, 'translation calls upstream for 이간호사');
    assertEqual(posts.length, 0, '이간호사 browser POST /v1/messages');
    assertEqual([after.marks, after.paneMarked.length, notes.length], [0, 0, 0], '김간호사’s highlight visible to 이간호사 (marks, pane, 메모)');
    assert(folders.includes('ICU 섬망') && folders.includes('섬망 연구'), `folders ${folders}`);
    await shot(lp, 'shared-e2e-06-lee-reuses-translation');
    return `“${title}”; folders [${folders}]; ${st.translated} translated sentences shown, 0 upstream translation calls, 0 browser /v1/messages; 0 highlight marks, 0 notes`;
  });

  await step('이간호사: highlights a sentence of her own (people/<her id>/), then deletes the paper → one question → 휴지통 tombstone', async () => {
    state.quoteLee = await highlightOnPage1(lp, 4, 'green');
    assert(overlap(state.quoteLee, state.quoteKim) < 0.5, 'both highlighted the same text');
    const ann = await waitFor(() => teamJson(`people/${state.pid.lee}/papers/${state.ids.lu}/annotations.json`), { timeout: 45000, what: '이간호사 annotations pushed' });
    const live = ann.items.filter((a) => !a.deleted);
    assert(live.length === 1 && live[0].color === 'green' && overlap(live[0].quote, state.quoteLee) > 0.6, `annotations ${JSON.stringify(live)}`);
    const notes = await notesOf(lp);
    assert(notes.length === 1 && overlap(notes[0].quote, state.quoteLee) > 0.6, `notes ${JSON.stringify(notes)}`);

    await lp.locator('.reader-toolbar .tb-back').click();
    await lp.waitForFunction(() => location.hash === '#/s/team' && document.querySelector('.library'), null, { timeout: 10000 });
    const row = lp.locator(`.paper-row[data-id="${state.ids.lu}"]`);
    await row.waitFor({ timeout: 10000 });
    await row.locator('button[aria-label="논문 메뉴"]').click();
    await lp.locator('.menu .menu-item', { hasText: '삭제' }).click();
    await lp.waitForSelector('.modal .modal-message');
    const question = (await lp.locator('.modal .modal-message').textContent()).trim();
    await lp.locator('.modal-footer .btn-danger').click();
    await lp.waitForFunction(() => !document.querySelector('.modal-backdrop'), null, { timeout: 5000 });
    await lp.waitForFunction((id) => !document.querySelector(`.paper-row[data-id="${id}"]`), state.ids.lu);
    const tomb = await waitFor(() => {
      const p = teamLibrary().papers.find((x) => x.id === state.ids.lu);
      return p?.deleted ? p : null;
    }, { timeout: 45000, what: 'tombstone pushed' });
    assert(question.includes('휴지통으로 이동합니다. 30일 안에 복구할 수 있습니다'), question);
    assertEqual(tomb.deletedBy, NAMES.lee, 'tombstone deletedBy');
    assert(teamFiles().has(`papers/${state.ids.lu}/paper.pdf`) && teamFiles().has(`papers/${state.ids.lu}/translation.json`), 'files removed on delete');
    assert(teamFiles().has(`people/${state.pid.kim}/papers/${state.ids.lu}/annotations.json`), '김간호사’s highlight removed by 이간호사’s delete');
    return `highlight “${state.quoteLee.slice(0, 50)}…” → people/${state.pid.lee}/…; 메모 shows only hers; delete asked “${question.split('\n')[0]}” once → tombstone deletedBy=${tomb.deletedBy}; PDF, translation and 김간호사’s notes kept`;
  });

  await step('김간호사: 휴지통 shows the paper with ‘이간호사’ → 복구 → back in ‘ICU 섬망’ for everyone', async () => {
    await kp.evaluate(() => { location.hash = '#/s/team'; }); // in-app navigation, as the 라이브러리 button does
    await sharedReady(kp);
    await syncShared(kp);
    await kp.waitForFunction((id) => !document.querySelector(`.paper-row[data-id="${id}"]`), state.ids.lu, { timeout: 20000 });
    await sec(kp, 'shared:team').locator('.tree-item.is-trash').click();
    await kp.waitForFunction(() => location.hash === '#/s/team/trash');
    const row = kp.locator(`.trash-row[data-id="${state.ids.lu}"]`);
    await row.waitFor({ timeout: 20000 });
    const meta = (await row.locator('.paper-meta').textContent()).replace(/\s+/g, ' ').trim();
    await shot(kp, 'shared-e2e-07-kim-trash');
    await row.locator('.btn', { hasText: '복구' }).click();
    await kp.waitForFunction(() => [...document.querySelectorAll('.toast')].some((t) => /복구했습니다/.test(t.textContent)), null, { timeout: 15000 });
    await waitFor(() => {
      const p = teamLibrary().papers.find((x) => x.id === state.ids.lu);
      return p && !p.deleted && p.folderId === state.ids.icu;
    }, { timeout: 45000, what: 'restore pushed' });
    await sec(kp, 'shared:team').locator('.tree-item.is-folder', { hasText: 'ICU 섬망' }).click();
    await kp.waitForFunction((id) => document.querySelector(`.paper-row[data-id="${id}"]`), state.ids.lu, { timeout: 10000 });
    assert(meta.includes(NAMES.lee) && /삭제/.test(meta) && /30일 남음/.test(meta), `trash meta “${meta}”`);
    return `휴지통 row “${meta}”; 복구 → library.json untombstoned, folder ‘ICU 섬망’ again`;
  });

  await step('최근 활동 lists the changes with names (박진수 copy, 김간호사 folder/upload/translation/restore, 이간호사 delete)', async () => {
    await sec(kp, 'shared:team').locator('.tree-item.is-activity').click();
    await kp.waitForFunction(() => location.hash === '#/s/team/activity');
    await kp.waitForSelector('.activity-item', { timeout: 20000 });
    const items = await kp.$$eval('.activity-item .activity-text', (els) => els.map((e) => e.textContent.replace(/\s+/g, ' ').trim()));
    const api = await asPerson(state.codes.kim, '/shared/team/activity?limit=50');
    const raw = api.body.items.map((i) => `${i.who}: ${i.summary}`);
    const has = (who, re) => items.some((t) => t.startsWith(who) && re.test(t));
    await shot(kp, 'shared-e2e-08-activity');
    assert(has(NAMES.owner, /폴더 복사.*섬망 연구/), `owner copy in ${items.join(' | ')}`);
    assert(has(NAMES.kim, /폴더 만듦.*ICU 섬망/) && has(NAMES.kim, /논문 추가/) && has(NAMES.kim, /번역/), `김간호사 actions in ${items.join(' | ')}`);
    assert(has(NAMES.lee, /논문 삭제/) && has(NAMES.kim, /복구/), `delete/restore in ${items.join(' | ')}`);
    const leak = JSON.stringify(api.body);
    assert(!Object.values(state.codes).some((c) => leak.includes(c)) && !Object.values(state.pid).some((p) => leak.includes(p)) && !/@/.test(leak), `activity leaks: ${leak}`);
    return `${items.length} entries: ${items.slice(0, 8).join(' | ')}; Worker API (who: summary): ${raw.slice(0, 4).join(' | ')}`;
  });

  await step('same moment: 김간호사’s push is held at GitHub while 이간호사’s lands → 422 → re-pull, merge, retry; both folders survive', async () => {
    const refPath = new RegExp(`^/repos/${TEAM.owner}/${TEAM.repo}/git/refs/heads/main$`);
    const hold = gh.pauseNext({ method: 'PATCH', path: refPath });
    const kimFrom = kim.relayLog.length;
    await kp.evaluate(() => { location.hash = '#/s/team'; });
    await sharedReady(kp);
    await sec(kp, 'shared:team').locator('.lib-nav-heading button').click();
    await answerPrompt(kp, '동시 작업 김');
    await Promise.race([hold.hit, sleep(30000).then(() => { throw new Error('김간호사’s ref update never reached GitHub'); })]);
    await sec(lp, 'shared:team').locator('.lib-nav-heading button').click();
    await answerPrompt(lp, '동시 작업 이');
    await waitFor(() => teamLibrary().folders.some((f) => f.name === '동시 작업 이' && !f.deleted), { timeout: 45000, what: '이간호사’s folder landed while 김간호사’s push waits' });
    const whileHeld = teamLibrary().folders.some((f) => f.name === '동시 작업 김');
    hold.release();
    const lib = await waitFor(() => {
      const l = teamLibrary();
      const names = l.folders.filter((f) => !f.deleted).map((f) => f.name);
      return names.includes('동시 작업 김') && names.includes('동시 작업 이') ? l : null;
    }, { timeout: 45000, what: 'both folders in library.json after the retry' });
    await sec(kp, 'shared:team').locator('.tree-item.is-folder', { hasText: '동시 작업 이' }).waitFor({ timeout: 20000 });
    await syncShared(lp);
    await sec(lp, 'shared:team').locator('.tree-item.is-folder', { hasText: '동시 작업 김' }).waitFor({ timeout: 20000 });
    const refs = kim.relayLog.slice(kimFrom).filter((r) => r.method === 'PATCH' && r.path.endsWith('/git/refs/heads/main')).map((r) => r.status);
    const names = lib.folders.filter((f) => !f.deleted).map((f) => f.name);
    assertEqual(whileHeld, false, '김간호사’s folder already in the repo while her push was held');
    assert(refs[0] === 422 && refs.at(-1) === 200, `김간호사’s PATCH ref statuses ${refs}`);
    assertEqual(names.filter((n) => n.startsWith('동시 작업')).sort(), ['동시 작업 김', '동시 작업 이'], 'folders after the merge (no duplicates)');
    assert(['섬망 연구', 'ICU 섬망'].every((n) => names.includes(n)) && teamLibrary().papers.find((p) => p.id === state.ids.lu && !p.deleted), 'the merge lost earlier folders or the paper');
    const msgs = teamCommits().slice(0, 3).map((c) => c.message);
    return `PATCH ref of 김간호사 held → 이간호사’s commit landed first → released: ${refs.join(' → ')}; library.json folders [${names.join(', ')}]; both sidebars show both; latest commits ${msgs.map((m) => `“${m}”`).join(' · ')}`;
  });

  const lee2 = await device('lee-2nd-pc');
  people.push(lee2);

  await step('이간호사 on a second fresh browser (same code): her own highlight is there, 김간호사’s is not; translation reused', async () => {
    const page = lee2.page;
    const translateFrom = translateCalls(fake).length;
    await joinWithLink(page, state.codes.lee, NAMES.lee);
    await page.waitForFunction(() => location.hash === '#/s/team', null, { timeout: 15000 });
    await sharedReady(page);
    await sec(page, 'shared:team').locator('.tree-item.is-folder', { hasText: 'ICU 섬망' }).click();
    await page.locator(`.paper-row[data-id="${state.ids.lu}"] .paper-link`).click();
    await page.waitForFunction((id) => location.hash === `#/s/team/paper/${id}`, state.ids.lu, { timeout: 10000 });
    await waitForReader(page);
    await page.waitForSelector('.pdfv-mark-layer--annotations .pdfv-mark', { timeout: 30000 });
    const st = await waitFor(async () => {
      const s = await readerState(page);
      return s.translated >= state.translated ? s : null;
    }, { timeout: 30000, what: 'translation shown' });
    const notes = await notesOf(page);
    const paths = await localPaths(page, `paper-reader-shared-team-${state.pid.lee}`);
    await shot(page, 'shared-e2e-09-lee-second-pc');
    assert(notes.length === 1 && notes[0].color === 'green' && overlap(notes[0].quote, state.quoteLee) > 0.6, `notes ${JSON.stringify(notes)}`);
    assert(st.paneMarked.length >= 1, 'pane shows no highlight');
    assert(!paths.some((p) => p.includes(state.pid.kim)), `김간호사’s files on 이간호사’s device: ${paths.filter((p) => p.includes(state.pid.kim))}`);
    assertEqual(translateCalls(fake).length - translateFrom, 0, 'translation calls');
    assertEqual(messagePosts(lee2.relayLog).length, 0, 'browser /v1/messages');
    return `${st.translated} translated, 0 translation calls; ${st.marks} mark box(es), 메모 [${notes.map((n) => `${n.color}: “${n.quote.slice(0, 40)}…”`)}]; local copy has ${paths.length} paths, none under people/${state.pid.kim}/`;
  });

  // ---------------------------------------------------------------------------------------- repo checks

  await step('team repo: no 내 서재-only paper ever reached it (PDF bytes, ids, titles, file names over every object)', async () => {
    const repo = gh.repo(TEAM.owner, TEAM.repo);
    const privateBytes = readFileSync(fixture(PRIVATE));
    const privateSha = gitBlobSha(privateBytes);
    const pid = state.ids.mine?.[PRIVATE];
    assert(pid, 'no id for the 내 서재-only paper');
    const needles = [pid, `${PRIVATE}.pdf`, state.titles[PRIVATE]].filter((s) => s && s.length > 3);
    let blobs = 0;
    for (const [sha, obj] of repo.objects) {
      if (obj.type !== 'blob') continue;
      blobs++;
      assert(sha !== privateSha, `the 내 서재-only PDF is blob ${sha}`);
      const text = obj.data.toString('utf8');
      for (const n of needles) assert(!text.includes(n), `blob ${sha} mentions “${n}”`);
    }
    for (const c of teamCommits()) for (const n of needles) assert(!c.message.includes(n), `commit “${c.message}” mentions ${n}`);
    // …and nothing of 공용 서재 went into the personal repo either.
    const mine = [...mineFiles().keys()];
    assert(!mine.some((p) => p.startsWith('people/') || p.includes(state.ids.lu)), `personal repo ${mine}`);
    return `${blobs} blobs and ${teamCommits().length} commits checked: no ${PRIVATE}.pdf (git sha ${privateSha.slice(0, 10)}), id ${pid}, title or file name; personal repo has no 공용 서재 files (${mine.length} files)`;
  }, { always: true });

  await step('team repo + GitHub traffic never contain an invite code (blobs, trees, commit messages, request headers/URLs/bodies)', async () => {
    const codes = Object.values(state.codes);
    assert(codes.length === 3, 'codes missing');
    const variants = codes.flatMap((c) => [c, c.replace(/-/g, ''), c.toLowerCase()]);
    const repo = gh.repo(TEAM.owner, TEAM.repo);
    let objects = 0;
    for (const [sha, obj] of repo.objects) {
      objects++;
      const text = obj.type === 'blob' ? obj.data.toString('utf8')
        : obj.type === 'tree' ? obj.entries.map((e) => e.name).join('\n') : String(obj.message || '');
      for (const v of variants) assert(!text.includes(v), `${obj.type} ${sha} contains an invite code`);
      assert(!text.includes(ADMIN_TOKEN) && !text.includes(MINE.token), `${obj.type} ${sha} contains a token`);
    }
    const teamPath = `/repos/${TEAM.owner}/${TEAM.repo}`;
    const minePath = `/repos/${MINE.owner}/${MINE.repo}`;
    let teamRequests = 0;
    for (const e of gh.log) {
      const all = `${e.path}${e.query}${JSON.stringify(e.headers)}${e.body?.toString('utf8') || ''}`;
      for (const v of variants) assert(!all.includes(v), `GitHub request ${e.method} ${e.path} carried an invite code`);
      if (e.path.startsWith(teamPath)) {
        teamRequests++;
        assert(e.token === TEAM.token, `team repo request ${e.method} ${e.path} with token ${e.token}`);
        assertEqual([e.headers['user-agent'], e.headers['x-github-api-version']], ['paper-relay', '2022-11-28'], `headers of ${e.method} ${e.path}`);
        assert(!e.headers.origin && !e.headers.cookie, `browser headers forwarded on ${e.path}`);
      } else if (e.path.startsWith(minePath)) {
        assert(e.token === MINE.token, `personal repo request with token ${e.token}`);
      } else {
        throw new Error(`unexpected GitHub request ${e.method} ${e.path}`);
      }
    }
    return `${objects} git objects and ${gh.log.length} GitHub requests (${teamRequests} by the Worker for the team repo, all with TEAM_GITHUB_TOKEN + User-Agent paper-relay) contain none of the 3 codes`;
  }, { always: true });

  await step('people/ isolation: each person’s files only under people/<own id>/, hidden from the others through the Worker', async () => {
    const files = [...teamFiles().keys()];
    const owners = new Set(files.filter((p) => p.startsWith('people/')).map((p) => p.split('/')[1]));
    assert(owners.has(state.pid.kim) && owners.has(state.pid.lee), `people/ in the team repo: ${[...owners]}`);
    assert([...owners].every((id) => Object.values(state.pid).includes(id)), `unknown person ids ${[...owners]}`);
    const head = gh.repo(TEAM.owner, TEAM.repo).refs.get('heads/main');
    const commit = await asPerson(state.codes.kim, `/shared/team/gh/repos/team/library/git/commits/${head}`);
    const tree = commit.body.tree.sha;
    const views = {};
    for (const k of ['kim', 'lee', 'owner']) {
      const r = await asPerson(state.codes[k], `/shared/team/gh/repos/team/library/git/trees/${tree}?recursive=1`);
      assertEqual(r.status, 200, `listing for ${NAMES[k]}`);
      const ids = new Set(r.body.tree.map((e) => e.path).filter((p) => /^people\/[^/]+/.test(p)).map((p) => p.split('/')[1]));
      views[k] = [...ids];
      assert([...ids].every((id) => id === state.pid[k]), `${NAMES[k]} sees people/${[...ids]}`);
      const json = JSON.stringify(r.body);
      for (const other of Object.keys(state.pid)) if (other !== k) assert(!json.includes(state.pid[other]), `${NAMES[k]}'s listing names ${NAMES[other]}'s id`);
    }
    // The people/ tree itself, and 이간호사's subtree asked for by its sha (taken from the repo, not from a listing).
    const repo = gh.repo(TEAM.owner, TEAM.repo);
    const peopleSha = repo.get(tree, 'tree').entries.find((e) => e.name === 'people')?.sha;
    const leeSha = peopleSha && repo.get(peopleSha, 'tree').entries.find((e) => e.name === state.pid.lee)?.sha;
    assert(peopleSha && leeSha, 'no people/ or people/<이간호사>/ tree in the head');
    const peek = await asPerson(state.codes.kim, `/shared/team/gh/repos/team/library/git/trees/${peopleSha}`);
    const direct = await asPerson(state.codes.kim, `/shared/team/gh/repos/team/library/git/trees/${leeSha}?recursive=1`);
    assertEqual(peek.body.tree?.map((e) => e.path), [state.pid.kim], '김간호사’s view of people/');
    assertEqual(direct.status, 404, '김간호사 asking for 이간호사’s subtree by sha');
    const kimLocal = await localPaths(kp, `paper-reader-shared-team-${state.pid.kim}`);
    assert(!kimLocal.some((p) => p.includes(state.pid.lee)), '이간호사’s files on 김간호사’s device');
    return `team repo people/: ${[...owners].map((id) => Object.keys(state.pid).find((k) => state.pid[k] === id)).map((k) => NAMES[k]).join(', ')}; Worker listings: ${Object.entries(views).map(([k, v]) => `${NAMES[k]} → [${v.join(',') || '-'}]`).join(', ')}; people/ tree to 김간호사 = [own id]; 이간호사's subtree by sha → ${direct.status}; 김간호사's device: ${kimLocal.length} paths, none of 이간호사`;
  }, { always: true });

  await step('Worker answers to the browsers: no refusals (403/413/5xx) on /shared — only expected 409/422 conflicts and 304s', async () => {
    const all = people.flatMap((p) => p.relayLog.filter((r) => r.path.startsWith('/shared')).map((r) => ({ who: p.name, ...r })));
    // A request the page itself cancelled (net::ERR_ABORTED: the reader closed, a pull superseded) is not a refusal;
    // anything else that failed in the browser (CORS, connection) is.
    const aborted = all.filter((r) => r.status === 'failed' && r.error === 'net::ERR_ABORTED');
    const bad = all.filter((r) => (r.status === 'failed' && r.error !== 'net::ERR_ABORTED') || [401, 403, 404, 413].includes(r.status) || r.status >= 500);
    assertEqual(bad.map((r) => `${r.who} ${r.method} ${r.path} ${r.status}${r.error ? ` (${r.error})` : ''}`), [], 'refused or failed /shared requests');
    const byStatus = all.reduce((m, r) => ({ ...m, [r.status]: (m[r.status] || 0) + 1 }), {});
    const unexpected = all.filter((r) => r.status !== 'failed' && ![200, 201, 304, 409, 422].includes(r.status));
    assertEqual(unexpected.map((r) => `${r.who} ${r.method} ${r.path} ${r.status}`), [], 'unexpected statuses');
    const blobPath = (path) => {
      const sha = /\/git\/blobs\/([0-9a-f]{40})$/.exec(path)?.[1];
      if (!sha) return path.replace('/shared/team/gh/repos/team/library', '');
      const repo = gh.repo(TEAM.owner, TEAM.repo);
      for (const c of teamCommits()) for (const [p, f] of repo.flatten(repo.get(c.sha, 'commit').tree)) if (f.sha === sha) return `blob of ${p}`;
      return `blob ${sha.slice(0, 8)}`;
    };
    const cancelled = aborted.map((r) => `${r.who} ${r.method} ${blobPath(r.path)} after ${r.ms} ms${r.answered ? ` (after its ${r.answered} answer)` : ' (before an answer)'}`);
    return `${all.length} /shared requests from ${people.length} browsers: ${Object.entries(byStatus).map(([s, n]) => `${s}×${n}`).join(', ')}; cancelled by the page: ${cancelled.join(', ') || 'none'}; Chromium-logged expected refusals ${expectedRefusals.length}`;
  }, { always: true });
} catch (err) {
  results.push({ name: 'test environment', result: 'fail', evidence: err?.stack || String(err) });
  console.log(`SETUP FAILED: ${err?.stack || err}`);
} finally {
  const relayLogs = Object.fromEntries(people.map((p) => [p.name, p.relayLog.map(({ body, ...r }) => r)]));
  writeFileSync(`${OUT}/results.json`, JSON.stringify({ results, expectedRefusals, relayLogs }, null, 2));
  for (const p of people) await p.ctx.close().catch(() => {});
  await browser?.close();
  stopWrangler();
  await fake?.close();
  await gh?.close();
  server?.kill();
  const failed = results.filter((r) => r.result === 'fail');
  const skipped = results.filter((r) => r.result === 'skipped');
  const passed = results.length - failed.length - skipped.length;
  console.log(`\nshared-e2e: ${passed}/${results.length} passed${failed.length ? ` — FAILED: ${failed.map((f) => f.name).join(' | ')}` : ''}${skipped.length ? ` (${skipped.length} skipped)` : ''}`);
  console.log(`results + screenshots: ${OUT}`);
  process.exitCode = failed.length || skipped.length ? 1 : 0;
}
