// 초대 코드 삭제, end to end with the REAL relay Worker and the real app (docs/RELAY.md §5, docs/notes/relay.md):
//   node tests/code-delete/run.mjs [--headed]
// Starts, and stops again:
//   - a fake GitHub on 127.0.0.1:8233 (tests/store/fake-github.mjs) holding the team repo of relay/wrangler.jsonc
//     SHARED_LIBRARIES (dindoopark/paper-team-library), reached only by the Worker through GITHUB_API_BASE;
//   - a fake Anthropic API on 127.0.0.1:8234 (tests/relay-e2e/fake-anthropic.mjs; translations and the summary);
//   - the relay Worker under `wrangler dev` on 127.0.0.1:8787 on a local D1 shaped like the DEPLOYED one after this
//     update (relay/test/lib.mjs migratedDatabase: the schema from before code deletion, no codes.person_salt, two old
//     codes, then today's schema.sql twice), with the production vars of relay/wrangler.jsonc plus GITHUB_API_BASE,
//     UPSTREAM_URL and fake secrets; no TEST_MODE;
//   - `python -m http.server 8232` serving a staged copy of the site (tests/relay-e2e/test-site.mjs).
// Edge only. No paid API, no real GitHub, no real relay, nothing deployed.
// Scenario: the owner makes EICU2-TEST (코드 직접 정하기) and a random code in the UI (the Worker adds person_salt to the
// old database on that first creation); the EICU2-TEST holder joins, uploads lu2025.pdf to 공용 서재, translates page 1
// through the relay, highlights a sentence and makes a 요약; the random-code holder (김간호사) sees paper + translation
// (0 calls) but not those notes and highlights her own; the owner presses 삭제 → GitHub refuses once (502: code, notes
// kept) → 삭제 again → gone. The holder's open app lands on the first screen with the one line on its next request; the
// team repo has no people/<holder>/ files but the paper and translation; the owner makes EICU2-TEST again → a new
// person: a new browser and the holder's own browser see the paper but not the old highlight or summary; 김간호사 is
// unaffected; the totals keep the deleted code's spend, shown as one 삭제된 코드 row.
// Results + screenshots: C:/Users/dindoo/Projects/pr-tools/out/code-delete/e2e/.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'file:///C:/Users/dindoo/Projects/pr-tools/node_modules/playwright/index.mjs';
import { d1RowsAt, LEGACY_CODES, migratedDatabase, personIdOf, portInUse, startWrangler } from '../../relay/test/lib.mjs';
import { startFakeAnthropic, TRANSLATION_PREFIX } from '../relay-e2e/fake-anthropic.mjs';
import { stageTestSite } from '../relay-e2e/test-site.mjs';
import { startFakeGitHub } from '../store/fake-github.mjs';

const APP_PORT = 8232;
const GITHUB_PORT = 8233;
const UPSTREAM_PORT = 8234;
const APP = `http://127.0.0.1:${APP_PORT}`;
const WORKER = 'http://127.0.0.1:8787'; // relay/test/lib.mjs starts wrangler dev here
const OUT = 'C:/Users/dindoo/Projects/pr-tools/out/code-delete/e2e';
const STATE_DIR = join(OUT, 'state');
const FIXTURES = 'C:/Users/dindoo/Projects/pr-fixtures';
const UPLOADED = 'lu2025';
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SETTINGS_KEY = 'pr.settings.v1';
const OWNER_KEY = 'sk-ant-code-delete-e2e-fake-owner-key-0000';
const ADMIN_TOKEN = 'code-delete-e2e-admin-token-0123456789abcdef';
const TEAM = { owner: 'dindoopark', repo: 'paper-team-library', token: 'github_pat_team_code_delete_e2e_0123456789' };
const CUSTOM = 'EICU2-TEST';
const NAMES = { team: '응급중환자실2', kim: '김간호사' };
const GONE = '초대 코드가 더 이상 쓰이지 않아요. 새 코드를 넣어 주세요.';
const BAD_CODE = '초대 코드가 올바르지 않거나 사용이 중지되었습니다.';
const DELETE_FAILED = '공용 서재(GitHub)에 연결하지 못해 이 코드의 개인 기록을 지우지 못했습니다. 코드는 그대로 두었으니 잠시 후 다시 삭제해 주세요.';
// The Worker marks which library a commit changed ({lib:team}, docs/CODE-LIBRARIES.md); 최근 활동 never shows it.
const ADMIN_COMMIT = '[관리자] {lib:team} 초대 코드 삭제에 따라 개인 기록 정리';
const IP = { owner: '198.51.100.20', holder: '198.51.100.21', kim: '198.51.100.22', fresh: '198.51.100.23', node: '198.51.100.99' };
const headed = process.argv.includes('--headed');

mkdirSync(OUT, { recursive: true });
const results = [];
const problems = []; // page errors, unexpected console errors, CSP violations, escaped requests, native dialogs
const expectedRefusals = []; // Chromium's "Failed to load resource" for the Worker's 401/409/502 the scenario asks for
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function assert(cond, msg) { if (!cond) throw new Error(msg); }
function assertEqual(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg}: expected ${e}, got ${a}`);
}
/** js/core/util.js formatUsd. */
const usd = (v) => (!v ? '$0' : v < 0.01 ? `$${v.toFixed(4)}` : `$${v.toFixed(2)}`);
const keyOf = (code) => String(code || '').toUpperCase().replace(/[^0-9A-Z]/g, '');

let blocked = null; // first failed step: the steps after it are skipped (they build on it)

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

/** The Worker from Node (no Origin header): `admin` → the admin token, `code` → Bearer invite code. */
async function worker(path, { admin = false, code = null, method = 'GET', ip = IP.node } = {}) {
  const headers = { 'cf-connecting-ip': ip };
  if (admin) headers.authorization = `Bearer ${ADMIN_TOKEN}`;
  if (code) headers.authorization = `Bearer ${code}`;
  const res = await fetch(`${WORKER}${path}`, { method, headers });
  let body = null;
  try { body = await res.json(); } catch { /* not JSON */ }
  return { status: res.status, body };
}

async function appUp() {
  try { return (await fetch(`${APP}/index.html`)).ok; } catch { return false; }
}

async function serveSite(dir) {
  if (await appUp() || await portInUse(APP_PORT)) throw new Error(`port ${APP_PORT} is already in use; stop that server first`);
  const proc = spawn('python', ['-m', 'http.server', String(APP_PORT), '--bind', '127.0.0.1'], { cwd: dir, stdio: 'ignore', windowsHide: true });
  await waitFor(appUp, { timeout: 8000, what: 'python http.server' });
  return proc;
}

// ------------------------------------------------------------------------------------------------- team repo / D1

let gh = null;
const teamFiles = () => gh.files(TEAM.owner, TEAM.repo);
const teamJson = (path) => {
  const b = gh.readFile(TEAM.owner, TEAM.repo, path);
  return b ? JSON.parse(b.toString('utf8')) : null;
};
const teamCommits = () => gh.commits(TEAM.owner, TEAM.repo);
const peopleFiles = (pid) => [...teamFiles().keys()].filter((p) => p.startsWith(`people/${pid}/`)).sort();
const d1 = (sql, ...params) => d1RowsAt(STATE_DIR, sql, ...params);

// ------------------------------------------------------------------------------------------------- browser

let browser = null;

/**
 * One browser context = one device (its own storage). Only the staged app and the Worker may be reached (the pinned
 * SDK bundle on jsDelivr passes); anything else is aborted and reported. Every browser → Worker request (not
 * preflights) is logged with the invite code it carried and its status. `ip` → CF-Connecting-IP.
 */
async function device(name, { seed = null, ip, viewport = { width: 1440, height: 900 } } = {}) {
  const ctx = await browser.newContext({ locale: 'ko-KR', viewport, colorScheme: 'light', reducedMotion: 'reduce' });
  await ctx.route(/^https?:\/\/(?!127\.0\.0\.1:(?:8232|8787)\/)/, (route) => {
    const url = route.request().url();
    if (url.startsWith('https://cdn.jsdelivr.net/gh/orioncactus/pretendard')) {
      return route.fulfill({ status: 200, contentType: 'text/css', body: '/* font stub (offline test) */' });
    }
    if (url.startsWith('https://cdn.jsdelivr.net/npm/')) return route.continue(); // the pinned SDK bundle + deps
    problems.push(`${name}: external request blocked ${url}`);
    return route.abort();
  });
  await ctx.route(`${WORKER}/**`, (route) => route.continue({ headers: { ...route.request().headers(), 'cf-connecting-ip': ip } }));
  await ctx.addInitScript(({ key, seed }) => {
    try { if (seed && !localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify(seed)); } catch { /* blocked */ }
    document.addEventListener('securitypolicyviolation', (e) => {
      console.error(`[csp] ${e.violatedDirective} blocked ${e.blockedURI}`);
    });
  }, { key: SETTINGS_KEY, seed });
  const page = await ctx.newPage();
  const log = [];
  const entries = new WeakMap();
  page.on('request', (req) => {
    if (!req.url().startsWith(WORKER) || req.method() === 'OPTIONS') return;
    const h = req.headers();
    const entry = {
      method: req.method(), path: new URL(req.url()).pathname, at: Date.now(), status: null,
      code: h['x-api-key'] || (/^Bearer (.+)$/.exec(h.authorization || '')?.[1] ?? ''),
    };
    entries.set(req, entry);
    log.push(entry);
  });
  page.on('response', (res) => { const e = entries.get(res.request()); if (e) e.status = res.status(); });
  page.on('requestfailed', (req) => { const e = entries.get(req); if (e && e.status === null) e.status = 'failed'; });
  page.on('pageerror', (e) => problems.push(`${name}: pageerror ${e.message}`));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const where = String(m.location()?.url || '');
    if (/^Failed to load resource/.test(m.text()) && where.startsWith(WORKER)) {
      expectedRefusals.push(`${name}: ${m.text()} ${where.replace(/\?.*$/, '')}`);
      return;
    }
    problems.push(`${name}: console.error ${m.text()}`);
  });
  page.on('dialog', (d) => {
    problems.push(`${name}: native ${d.type()} dialog “${d.message()}”`);
    d.dismiss().catch(() => {});
  });
  /** Requests that carried `code` (any spelling). */
  const withCode = (code) => log.filter((r) => keyOf(r.code) === keyOf(code));
  return { name, ctx, page, log, withCode };
}

const shot = (target, file, opts = {}) => target.screenshot({ path: `${OUT}/${file}.png`, ...opts });
const stored = (page) => page.evaluate((key) => JSON.parse(localStorage.getItem(key) || '{}'), SETTINGS_KEY);
const toastTexts = (page) => page.$$eval('.toast .toast-msg', (els) => els.map((e) => e.textContent.replace(/\s+/g, ' ').trim()));
const sec = (page, key) => page.locator(`.lib-sec[data-lib="${key}"]`);

async function sharedReady(page) {
  await page.waitForSelector('.lib-sec[data-lib="shared:team"] .lib-sec-body .lib-nav-heading', { timeout: 30000 });
}
/**
 * 전체 공용 서재 is the open place. An invitee lands in their code's own library (#/s/mine, docs/CODE-LIBRARIES.md)
 * — or where they were last (#/s/team) — and goes on to 전체 공용 서재 from the sidebar.
 */
async function inSharedLibrary(page) {
  await page.waitForSelector('.library', { timeout: 30000 });
  await sharedReady(page);
  await page.waitForFunction(() => location.hash === '#/s/mine' || location.hash === '#/s/team', null, { timeout: 15000 });
  if (await page.evaluate(() => location.hash === '#/s/mine')) {
    await page.locator('.lib-sec[data-lib="shared:team"] .tree-item', { hasText: '전체' }).click();
    await page.waitForFunction(() => location.hash === '#/s/team', null, { timeout: 10000 });
  }
}
/** 공용 서재 sync chip → 지금 동기화, then wait until it is idle again. */
async function syncShared(page) {
  await page.locator('.lib-sec-sync[data-lib="shared:team"]').click();
  await page.waitForFunction(() => {
    const c = document.querySelector('.lib-sec-sync[data-lib="shared:team"]');
    return c && !c.classList.contains('is-busy');
  }, null, { timeout: 30000 });
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
    label: document.querySelector('.tb-tr-main .btn-label')?.textContent || '',
    marks: document.querySelectorAll('.pdfv-mark-layer--annotations .pdfv-mark').length,
    paneMarked: document.querySelectorAll('.tp-s[data-m-annotations]').length,
  }));
}

/** Highlight one long text-layer span of page 1 with a real mouse drag → selection menu → colour; the selected text. */
async function highlightOnPage1(page, pick, color) {
  const span = await page.evaluate((pick) => {
    const v = document.querySelector('.viewer-host').getBoundingClientRect();
    const spans = [...document.querySelectorAll('.pdfv-page[data-page="1"] .textLayer span')]
      .filter((s) => !s.querySelector('span') && s.textContent.length > 40 && /^[A-Za-z]/.test(s.textContent))
      .map((s) => ({ s, r: s.getBoundingClientRect() }))
      .filter(({ r }) => r.top > v.top + 60 && r.bottom < v.bottom - 60 && r.width > 150);
    const hit = spans[Math.min(pick, spans.length - 1)];
    return hit ? { text: hit.s.textContent, x: hit.r.left, y: hit.r.top, w: hit.r.width, h: hit.r.height } : null;
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

/** The 메모 tab's notes (count), then back to 번역. */
async function noteCount(page) {
  await page.locator('.tab[data-tab="notes"]').click();
  await sleep(400);
  const n = await page.locator('.pf-note').count();
  await page.locator('.tab[data-tab="translation"]').click();
  return n;
}

/** Open the uploaded paper from the 공용 서재 list and wait for the reader. */
async function openPaper(page, paperId, title) {
  await page.locator('.paper-row', { hasText: title.slice(0, 30) }).locator('.paper-link').click();
  await page.waitForFunction((id) => location.hash === `#/s/team/paper/${id}`, paperId, { timeout: 10000 });
  await waitForReader(page);
}

/** What another person sees in the reader of the paper: translation reused, no marks, no notes, no stored summary. */
async function readerViewOfOthers(page, translated) {
  const st = await waitFor(async () => {
    const s = await readerState(page);
    return s.translated >= translated ? s : null;
  }, { timeout: 30000, what: 'the shared translation shown' });
  await sleep(1500); // annotations (and any wrong request) would show up here
  const after = await readerState(page);
  const notes = await noteCount(page);
  await page.locator('.tab[data-tab="summary"]').click();
  await sleep(500);
  const summary = await page.locator('.pf-summary__body h2').count();
  await page.locator('.tab[data-tab="translation"]').click();
  return { translated: st.translated, marks: after.marks, paneMarked: after.paneMarked, notes, summary };
}

const translateCalls = () => fake.calls.filter((c) => c.kind === 'translate');

// ------------------------------------------------------------------------------------------------- owner UI

async function openAdmin(page) {
  await page.goto('about:blank'); // a fresh load (the same address would only change the fragment)
  await page.goto(`${APP}/index.html#/settings/invites`);
  await page.locator('#set-invites summary', { hasText: '관리 화면 열기' }).click();
  await page.waitForSelector('#set-invites .relay-code[data-code]', { timeout: 15000 });
}

async function createCode(page, name, custom) {
  await page.fill('#set-invites input[aria-label="이름"]', name);
  await page.fill('#set-invites input[aria-label="코드 직접 정하기"]', custom);
  await page.locator('#set-invites .btn', { hasText: '코드 만들기' }).click();
  await page.waitForSelector(`#set-invites .relay-created >> text=${name}님의 초대 코드를 만들었습니다`, { timeout: 15000 });
  const code = (await page.locator('#set-invites .relay-created code').innerText()).trim();
  await page.waitForSelector(`#set-invites .relay-code[data-code="${code}"]`, { timeout: 15000 });
  return code;
}

const statText = (page, label) => page.locator('#set-invites .stat', { hasText: label }).innerText().then((t) => t.replace(/\s+/g, ' ').trim());
const rowCodes = (page) => page.$$eval('#set-invites .relay-code[data-code]', (els) => els.map((e) => e.dataset.code));

async function dismissToasts(page) {
  for (const x of await page.$$('.toast .toast-close')) await x.click().catch(() => {});
  await page.waitForTimeout(250);
}

// ===================================================================================================== run

let server = null;
let fake = null;
let stopWrangler = () => {};
const state = {};
const people = [];

try {
  const staged = stageTestSite({ repo: REPO, dir: join(OUT, 'site'), workerUrl: WORKER });
  server = await serveSite(join(OUT, 'site'));
  console.log(`staged ${staged.join(', ')} with RELAY_DEFAULT_URL = ${WORKER} → ${APP}`);
  gh = await startFakeGitHub({ port: GITHUB_PORT });
  gh.addToken(TEAM.token, { write: true, repos: [`${TEAM.owner}/${TEAM.repo}`] });
  gh.createRepo(TEAM.owner, TEAM.repo, { private: true, files: { 'README.md': '# 공용 서재\n' } });
  fake = await startFakeAnthropic({ port: UPSTREAM_PORT });
  // Every translation batch also reports 90K extra input tokens (≈ $0.009 on Haiku 5.5): the EICU2-TEST holder's
  // spend is a visible amount in 초대 코드 관리 and in the 삭제된 코드 row after the deletion.
  fake.control.extraInputTokens = 90_000;
  state.schemaSteps = migratedDatabase(STATE_DIR);
  state.columnsBefore = (await d1('PRAGMA table_info(codes)')).map((c) => c.name);
  stopWrangler = await startWrangler({
    stateDir: STATE_DIR,
    logFile: join(OUT, 'wrangler.log'),
    // Production vars of relay/wrangler.jsonc (ALLOWED_ORIGINS, SHARED_LIBRARIES, limits) plus the fakes and fake secrets.
    vars: { UPSTREAM_URL: fake.url, ANTHROPIC_API_KEY: OWNER_KEY, ADMIN_TOKEN, GITHUB_API_BASE: gh.url, TEAM_GITHUB_TOKEN: TEAM.token },
  });
  browser = await chromium.launch({ channel: 'msedge', headless: !headed, slowMo: headed ? 40 : 0 });

  const owner = await device('owner', { seed: { relay: { adminToken: ADMIN_TOKEN } }, ip: IP.owner, viewport: { width: 1280, height: 1600 } });
  people.push(owner);
  const op = owner.page;

  await step('owner, on a database from before code deletion: 설정 → 초대 코드 관리 makes EICU2-TEST (코드 직접 정하기) and a random code; the Worker adds codes.person_salt and salts both', async () => {
    await openAdmin(op);
    const before = await rowCodes(op);
    state.codes = { team: await createCode(op, NAMES.team, CUSTOM), kim: await createCode(op, NAMES.kim, '') };
    const columns = (await d1('PRAGMA table_info(codes)')).map((c) => c.name);
    const rows = await d1('SELECT code, person_salt FROM codes ORDER BY code');
    const salt = Object.fromEntries(rows.map((r) => [r.code, r.person_salt]));
    state.salt = { team: salt[CUSTOM], kim: salt[state.codes.kim] };
    state.pid = { team: personIdOf(CUSTOM, state.salt.team), kim: personIdOf(state.codes.kim, state.salt.kim) };
    const shared = await worker('/shared', { code: 'eicu2 test' });
    const legacy = await worker('/shared', { code: LEGACY_CODES.custom });
    await shot(op, 'code-delete-e2e-01-admin-created');
    assertEqual(state.schemaSteps, ['test/legacy-schema.sql', 'schema.sql', 'schema.sql'], 'schema steps');
    assert(!state.columnsBefore.includes('person_salt'), `person_salt before the Worker ran: ${state.columnsBefore}`);
    assert(columns.includes('person_salt'), `columns after the first creation: ${columns}`);
    assertEqual(before.sort(), [LEGACY_CODES.custom, LEGACY_CODES.generated].sort(), 'codes listed before (the two old ones)');
    assertEqual(state.codes.team, CUSTOM, 'custom code');
    assert(/^PR-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/.test(state.codes.kim), `random code ${state.codes.kim}`);
    assert([state.salt.team, state.salt.kim].every((s) => /^[0-9a-f]{32}$/.test(s || '')) && state.salt.team !== state.salt.kim, `salts ${JSON.stringify(state.salt)}`);
    assertEqual([salt[LEGACY_CODES.generated], salt[LEGACY_CODES.custom]], [null, null], 'old codes keep no salt');
    assertEqual([shared.status, shared.body?.personId], [200, state.pid.team], 'GET /shared personId of EICU2-TEST = SHA-256(code, newline, salt)');
    assertEqual([legacy.status, legacy.body?.personId], [200, personIdOf(LEGACY_CODES.custom)], 'an old code keeps its saltless personId');
    return `codes ${CUSTOM} (${NAMES.team}) and ${state.codes.kim} (${NAMES.kim}) made in the UI; person_salt column absent before, added by the Worker; salts ${state.salt.team.slice(0, 8)}…, ${state.salt.kim.slice(0, 8)}…; old codes NULL; people/${state.pid.team} (salted), old ${LEGACY_CODES.custom} → people/${legacy.body.personId} (unchanged)`;
  });

  const holder = await device('holder', { ip: IP.holder });
  people.push(holder);
  const hp = holder.page;

  await step('EICU2-TEST holder (fresh browser, join link): uploads lu2025.pdf to 공용 서재, 이 페이지만 번역 through the relay, highlights a sentence, 요약 → people/<id>/ annotations.json + ai.json', async () => {
    await hp.goto(`${APP}/#/join/${CUSTOM}`);
    await inSharedLibrary(hp);
    const s = await stored(hp);
    assertEqual([s.provider, s.relay?.code, s.relay?.name], ['relay', CUSTOM, NAMES.team], 'stored after the join link');
    await hp.setInputFiles('.lib-actions input[type=file]', [`${FIXTURES}/${UPLOADED}.pdf`]);
    await hp.waitForFunction(() => document.querySelectorAll('.paper-row').length === 1, null, { timeout: 60000 });
    const lib = await waitFor(() => {
      const l = teamJson('library.json');
      const p = l?.papers?.find((x) => x.fileName === `${UPLOADED}.pdf` && !x.deleted);
      return p && teamFiles().has(`papers/${p.id}/paper.pdf`) ? p : null;
    }, { timeout: 60000, what: 'paper + PDF pushed' });
    state.paper = { id: lib.id, title: lib.title };
    await openPaper(hp, state.paper.id, state.paper.title);
    const callsFrom = fake.calls.length;
    await hp.locator('.tb-tr-more').click();
    await hp.locator('.menu .menu-item', { hasText: '이 페이지만 번역' }).click();
    const st = await waitFor(async () => {
      const x = await readerState(hp);
      return x.translated > 5 && x.pending === 0 && x.label !== '번역 중…' ? x : null;
    }, { timeout: 90000, interval: 200, what: 'page 1 translated' });
    await hp.waitForSelector('.toast >> text=번역을 마쳤습니다.', { timeout: 15000 });
    const calls = fake.calls.slice(callsFrom).filter((c) => c.kind === 'translate');
    const sent = new Set(calls.flatMap((c) => c.ids));
    await waitFor(() => {
      const t = teamJson(`papers/${state.paper.id}/translation.json`);
      return t && [...sent].every((sid) => t.items?.[sid]?.t?.startsWith(TRANSLATION_PREFIX)) ? t : null;
    }, { timeout: 45000, what: 'translation.json pushed (shared path)' });
    state.translated = st.translated;
    state.quote = await highlightOnPage1(hp, 1, 'yellow');
    // 요약 (one non-streaming Haiku call through the relay) → ai.json under people/<holder>/.
    await hp.locator('.tab[data-tab="summary"]').click();
    await hp.locator('[data-action="generate"]').click();
    await hp.waitForFunction(() => document.querySelectorAll('.pf-summary__body h2').length >= 3, null, { timeout: 30000 });
    await hp.locator('.tab[data-tab="translation"]').click();
    const files = await waitFor(() => {
      const f = peopleFiles(state.pid.team);
      return f.length === 2 ? f : null;
    }, { timeout: 45000, what: 'annotations.json + ai.json pushed under people/<holder>/' });
    const ann = teamJson(`people/${state.pid.team}/papers/${state.paper.id}/annotations.json`);
    assertEqual(files, [`people/${state.pid.team}/papers/${state.paper.id}/ai.json`, `people/${state.pid.team}/papers/${state.paper.id}/annotations.json`], 'holder files');
    assertEqual(ann.items.filter((a) => !a.deleted).map((a) => a.color), ['yellow'], 'the highlight');
    assert(calls.length >= 1 && calls.every((c) => c.headers['x-api-key'] === OWNER_KEY), `upstream ${calls.length} call(s)`);
    await shot(hp, 'code-delete-e2e-02-holder-highlight');
    await hp.locator('.reader-toolbar .tb-back').click();
    await hp.waitForFunction(() => location.hash === '#/s/team' && document.querySelector('.library'), null, { timeout: 10000 });
    await sharedReady(hp);
    return `#/join/${CUSTOM} → 공용 서재; papers/${state.paper.id}/paper.pdf + translation.json (${st.translated} sentences, ${calls.length} batch(es) on the owner key); highlight “${state.quote.slice(0, 40)}…”; 요약 → ${files.join(', ')}; back in the 공용 서재 list`;
  });

  const kim = await device('kim', { ip: IP.kim });
  people.push(kim);
  const kp = kim.page;

  await step('김간호사 (random code, fresh browser): sees the paper and its translation (0 translation calls), not the holder\'s highlight or summary; highlights her own sentence', async () => {
    await kp.goto(`${APP}/#/join/${state.codes.kim}`);
    await inSharedLibrary(kp);
    const translateFrom = translateCalls().length;
    await openPaper(kp, state.paper.id, state.paper.title);
    const view = await readerViewOfOthers(kp, state.translated);
    state.kimQuote = await highlightOnPage1(kp, 4, 'green');
    const files = await waitFor(() => {
      const f = peopleFiles(state.pid.kim);
      return f.length === 1 ? f : null;
    }, { timeout: 45000, what: '김간호사 annotations pushed' });
    await kp.locator('.reader-toolbar .tb-back').click();
    await kp.waitForFunction(() => location.hash === '#/s/team' && document.querySelector('.library'), null, { timeout: 10000 });
    await sharedReady(kp);
    assertEqual(translateCalls().length - translateFrom, 0, 'translation calls for 김간호사');
    assertEqual([view.marks, view.paneMarked, view.notes, view.summary], [0, 0, 0, 0], 'the holder\'s highlight / notes / summary visible to 김간호사');
    assertEqual(files, [`people/${state.pid.kim}/papers/${state.paper.id}/annotations.json`], '김간호사 files');
    return `${view.translated} translated sentences shown, 0 translation calls; 0 marks, 0 notes, no summary of the holder; her green highlight → ${files[0]}`;
  });

  await step('owner: 삭제 on EICU2-TEST while GitHub refuses (502): the Worker\'s Korean message, the dialog and the code stay, the holder\'s notes stay, the code works again', async () => {
    await openAdmin(op); // fresh list: the holder's spend
    state.before = {
      month: await statText(op, '이번 달 전체'),
      today: await statText(op, '오늘 전체'),
      list: (await worker('/relay/admin/codes', { admin: true })).body,
    };
    const holderRow = state.before.list.codes.find((c) => c.code === CUSTOM);
    state.holderMonthUsd = holderRow.monthUsd;
    assert(holderRow.monthUsd >= 0.01, `the holder's spend is visible: ${JSON.stringify(holderRow)}`);
    await op.locator(`#set-invites .relay-code[data-code="${CUSTOM}"] .relay-code-delete`).click();
    await op.waitForSelector('.modal');
    const modal = await op.evaluate(() => {
      const m = document.querySelector('.modal');
      return {
        title: m.querySelector('.modal-title').textContent,
        lines: [...m.querySelectorAll('.modal-body p')].map((p) => p.textContent),
        choices: [...m.querySelectorAll('.radio-card')].map((c) => `${c.querySelector('input').checked ? '●' : '○'} ${c.querySelector('.radio-title').textContent}`),
        buttons: [...m.querySelectorAll('.modal-footer .btn')].map((b) => b.textContent.trim()),
      };
    });
    // GitHub refuses the deletion commit's tree once (nobody else is writing now).
    gh.failNext({ method: 'POST', path: /\/repos\/dindoopark\/paper-team-library\/git\/trees$/, status: 502, body: { message: 'Server Error' } });
    const deleteRes = op.waitForResponse((r) => r.request().method() === 'DELETE' && r.url().includes('/relay/admin/codes/'), { timeout: 60000 });
    await op.locator('.modal-footer .btn-danger').click();
    const res = await deleteRes;
    const failed = { status: res.status(), body: await res.json().catch(() => null) };
    await op.waitForSelector('.toast-error', { timeout: 15000 });
    const toast = (await op.locator('.toast-error .toast-msg').last().innerText()).trim();
    const kept = {
      dialog: await op.locator('.modal').count(),
      row: await op.locator(`#set-invites .relay-code[data-code="${CUSTOM}"]`).count(),
      inD1: (await d1('SELECT code, active FROM codes WHERE code = ?', CUSTOM)).map((r) => [r.code, r.active]),
      files: peopleFiles(state.pid.team).length,
      me: (await worker('/relay/me', { code: CUSTOM })).status,
    };
    await shot(op, 'code-delete-e2e-03-github-refused');
    assertEqual(modal.title, `‘${NAMES.team}’ 코드를 삭제할까요?`, 'dialog title');
    // Since code libraries the dialog also asks what happens to the code's own library (default: 서재도 함께 삭제).
    assertEqual(modal.lines, ['이 코드로는 더 이상 들어올 수 없고, 전체 공용 서재에 남긴 하이라이트·메모·AI 기록도 지워집니다.', '전체 공용 서재의 논문·폴더·번역과 사용 비용 기록은 그대로 남습니다.'], 'dialog lines');
    assertEqual(modal.choices, ['● 서재도 함께 삭제', '○ 다른 코드로 옮기기'], 'dialog choices');
    assertEqual(modal.buttons, ['취소', '삭제'], 'dialog buttons');
    assertEqual([failed.status, failed.body?.error?.message], [502, DELETE_FAILED], 'Worker answer');
    assertEqual(toast, DELETE_FAILED, 'toast');
    assertEqual(kept, { dialog: 1, row: 1, inD1: [[CUSTOM, 1]], files: 2, me: 200 }, 'after the refused try');
    return `dialog “${modal.title}” + 2 lines; GitHub 502 on POST git/trees → Worker 502 “${failed.body.error.message.slice(0, 40)}…” as the toast; dialog open, row listed, code active in D1, /relay/me 200, people/<holder>/ still 2 files`;
  });

  await step('owner: 삭제 again → row gone, “삭제했습니다.”; {deleted, purgedFiles: 2}; team repo keeps paper + translation + 김간호사\'s notes; one [관리자] commit; D1 code + shared_trees gone, usage kept; totals unchanged + 삭제된 코드 row', async () => {
    const deleteRes = op.waitForResponse((r) => r.request().method() === 'DELETE' && r.url().includes('/relay/admin/codes/'), { timeout: 90000 });
    const headBefore = teamCommits()[0].sha;
    await op.locator('.modal-footer .btn-danger').click();
    const res = await deleteRes;
    const answer = { status: res.status(), body: await res.json().catch(() => null) };
    await op.waitForSelector('.toast >> text=삭제했습니다.', { timeout: 15000 });
    await op.waitForSelector('.modal', { state: 'detached' });
    await op.waitForSelector('#set-invites .relay-code.is-deleted-total', { timeout: 15000 });
    await op.waitForFunction((c) => !document.querySelector(`#set-invites .relay-code[data-code="${c}"]`), CUSTOM);
    const commits = teamCommits();
    const newCommits = commits.slice(0, commits.findIndex((c) => c.sha === headBefore));
    const files = [...teamFiles().keys()];
    const usageRows = await d1('SELECT code, requests, usd FROM usage ORDER BY code');
    const after = {
      month: await statText(op, '이번 달 전체'),
      today: await statText(op, '오늘 전체'),
      deletedRow: (await op.locator('#set-invites .relay-code.is-deleted-total').innerText()).replace(/\s+/g, ' ').trim(),
      rows: await rowCodes(op),
      list: (await worker('/relay/admin/codes', { admin: true })).body,
    };
    await dismissToasts(op);
    await shot(op.locator('#set-invites'), 'code-delete-e2e-04-admin-deleted');
    assertEqual(answer, { status: 200, body: { deleted: true, purgedFiles: 2 } }, 'DELETE answer');
    assertEqual(peopleFiles(state.pid.team), [], 'people/<holder>/ files left');
    assert(files.includes(`papers/${state.paper.id}/paper.pdf`) && files.includes(`papers/${state.paper.id}/translation.json`) && files.includes('library.json'), `shared files ${files}`);
    assertEqual(peopleFiles(state.pid.kim).length, 1, '김간호사\'s notes');
    assertEqual(newCommits.map((c) => [c.message, c.deleted.length, c.changed.length]), [[ADMIN_COMMIT, 2, 2]], 'commits made by the deletion (message, deleted, changed)');
    assertEqual(await d1('SELECT code FROM codes WHERE code = ?', CUSTOM), [], 'code row');
    assertEqual(await d1('SELECT person FROM shared_trees WHERE person = ?', state.pid.team), [], 'shared_trees rows of the holder');
    assert((await d1('SELECT person FROM shared_trees WHERE person = ?', state.pid.kim)).length > 0, '김간호사\'s shared_trees rows kept');
    const history = usageRows.filter((r) => /^deleted:\d{4}-\d\d-\d\dT[\d:.]+Z:EICU2-TEST$/.test(r.code));
    assert(history.length >= 1 && !usageRows.some((r) => r.code === CUSTOM), `usage rows ${JSON.stringify(usageRows)}`);
    assertEqual([after.month, after.today], [state.before.month, state.before.today], 'totals (deleted spend kept)');
    assert(Math.abs(after.list.deletedUsage.monthUsd - state.holderMonthUsd) < 2e-6, `deletedUsage ${JSON.stringify(after.list.deletedUsage)} ≠ the holder's month ${state.holderMonthUsd}`);
    assertEqual(after.deletedRow, `삭제된 코드 이번 달 ${usd(state.holderMonthUsd)}`, '삭제된 코드 row');
    assert(!after.rows.includes(CUSTOM) && after.rows.includes(state.codes.kim), `rows ${after.rows}`);
    return `200 ${JSON.stringify(answer.body)}; commit “${newCommits[0].message}” deleting ${newCommits[0].deleted.join(', ')}; paper.pdf, translation.json, 김간호사's file kept; D1: no code, no shared_trees of the holder, usage as ${history.map((h) => h.code).join(', ')}; ${after.month} and ${after.today} as before; row “${after.deletedRow}”`;
  });

  await step('holder\'s open app (공용 서재, untouched since): the next request (지금 동기화) → 401 → code forgotten → the first screen with the one line; no request loop', async () => {
    const n0 = holder.withCode(CUSTOM).length;
    // (The engine also pulls by itself every 2 minutes; if that came first, the first screen is already there.)
    const how = (await hp.locator('.start .start-error.is-notice').count()) ? 'the engine\'s own 2-minute pull' : '지금 동기화';
    if (how === '지금 동기화') await hp.locator('.lib-sec-sync[data-lib="shared:team"]').click();
    await hp.waitForSelector('.start .start-error.is-notice', { timeout: 30000 });
    const refused = holder.withCode(CUSTOM).slice(how === '지금 동기화' ? n0 : 0).filter((r) => r.status !== 200 && r.status !== 304);
    const line = (await hp.locator('.start-error').innerText()).trim();
    const s = await stored(hp);
    const hash = await hp.evaluate(() => location.hash);
    const invalid = await hp.locator('.start-input').getAttribute('aria-invalid');
    await hp.evaluate(() => document.fonts?.ready);
    await shot(hp, 'code-delete-e2e-05-holder-first-screen');
    const n1 = holder.withCode(CUSTOM).length;
    await sleep(5000);
    const later = holder.withCode(CUSTOM).slice(n1);
    const toasts = await toastTexts(hp);
    assert(refused.length >= 1 && refused.every((r) => r.status === 401), `requests after the deletion: ${JSON.stringify(refused)}`);
    assert(refused.some((r) => r.path.startsWith('/shared/team/gh/')), `the proxy was not asked: ${JSON.stringify(refused)}`);
    assertEqual([line, invalid, hash], [GONE, null, '#/'], 'first screen');
    assertEqual([s.relay?.code, s.relay?.name, s.relay?.allowedModels], ['', '', []], 'code forgotten');
    assertEqual(later, [], 'requests with the deleted code in the next 5 s');
    assert(!toasts.includes(GONE), `toast on the first screen: ${toasts}`);
    return `${how}: ${refused.map((r) => `${r.method} ${r.path} ${r.status}`).join(', ')} → first screen at #/ “${line}” (not red, no aria-invalid); code, name, models cleared; 0 requests with ${CUSTOM} in the next 5 s`;
  });

  await step('owner: makes EICU2-TEST again → a new salt and personId; its row starts at $0; the 삭제된 코드 row stays', async () => {
    await createCode(op, NAMES.team, CUSTOM);
    const [row] = await d1('SELECT person_salt FROM codes WHERE code = ?', CUSTOM);
    state.newPid = personIdOf(CUSTOM, row.person_salt);
    const shared = await worker('/shared', { code: CUSTOM });
    const me = await worker('/relay/me', { code: CUSTOM });
    const meta = (await op.locator(`#set-invites .relay-code[data-code="${CUSTOM}"] .relay-code-meta`).innerText()).replace(/\s+/g, ' ');
    const deletedRow = (await op.locator('#set-invites .relay-code.is-deleted-total').innerText()).replace(/\s+/g, ' ').trim();
    assert(/^[0-9a-f]{32}$/.test(row.person_salt) && row.person_salt !== state.salt.team, `new salt ${row.person_salt}`);
    assert(state.newPid !== state.pid.team, 'same personId as the deleted code');
    assertEqual([shared.status, shared.body?.personId], [200, state.newPid], 'GET /shared');
    assertEqual([me.status, me.body?.todayUsd, me.body?.todayRequests], [200, 0, 0], '/relay/me of the new code (old usage not attached)');
    assert(/오늘 \$0 /.test(`${meta} `) && /이번 달 \$0 /.test(`${meta} `), `new row ${meta}`);
    assertEqual(deletedRow, `삭제된 코드 이번 달 ${usd(state.holderMonthUsd)}`, '삭제된 코드 row');
    return `people/${state.pid.team} → people/${state.newPid}; /relay/me today $0 / 0 requests; row “${meta.slice(0, 80)}…”; “${deletedRow}”`;
  });

  await step('new browser with the re-made EICU2-TEST: sees the paper and its translation (0 calls), NOT the old highlight or summary', async () => {
    const fresh = await device('fresh', { ip: IP.fresh });
    people.push(fresh);
    const fp = fresh.page;
    await fp.goto(`${APP}/#/join/${CUSTOM}`);
    await inSharedLibrary(fp);
    const translateFrom = translateCalls().length;
    await openPaper(fp, state.paper.id, state.paper.title);
    const view = await readerViewOfOthers(fp, state.translated);
    const info = await fp.evaluate(async () => (await indexedDB.databases()).map((d) => d.name).filter((n) => n.startsWith('paper-reader-shared-team-')));
    await shot(fp, 'code-delete-e2e-06-recreated-new-browser');
    assertEqual(translateCalls().length - translateFrom, 0, 'translation calls');
    assertEqual([view.marks, view.paneMarked, view.notes, view.summary], [0, 0, 0, 0], 'old highlight / notes / summary');
    assertEqual(info, [`paper-reader-shared-team-${state.newPid}`], 'local database');
    return `${view.translated} translated sentences, 0 translation calls; 0 marks, 0 notes, no summary; database ${info[0]}`;
  });

  await step('the holder\'s own browser opens the old invite link #/join/EICU2-TEST again (a browser tab tries a refused code once) → 공용 서재 → the paper without the old highlight (a new person, a new local database)', async () => {
    const refusedBefore = await hp.evaluate(() => JSON.parse(localStorage.getItem('pr.relay.refused.v1') || '[]'));
    const n0 = holder.withCode(CUSTOM).length;
    await hp.goto(`${APP}/#/join/${CUSTOM}`);
    await inSharedLibrary(hp);
    const joinRequests = holder.withCode(CUSTOM).slice(n0).filter((r) => r.path === '/relay/me').map((r) => r.status);
    assertEqual(refusedBefore, ['EICU2TEST'], 'refused-code list before');
    assertEqual(joinRequests, [200], '/relay/me for the join link');
    const translateFrom = translateCalls().length;
    await openPaper(hp, state.paper.id, state.paper.title);
    const view = await readerViewOfOthers(hp, state.translated);
    const dbs = await hp.evaluate(async () => (await indexedDB.databases()).map((d) => d.name).filter((n) => n.startsWith('paper-reader-shared-team-')).sort());
    const refusedKeys = await hp.evaluate(() => JSON.parse(localStorage.getItem('pr.relay.refused.v1') || '[]'));
    await shot(hp, 'code-delete-e2e-07-holder-again');
    await hp.locator('.reader-toolbar .tb-back').click();
    assertEqual(translateCalls().length - translateFrom, 0, 'translation calls');
    assertEqual([view.marks, view.paneMarked, view.notes, view.summary], [0, 0, 0, 0], 'old highlight / notes / summary on the same device');
    assertEqual(dbs, [`paper-reader-shared-team-${state.pid.team}`, `paper-reader-shared-team-${state.newPid}`].sort(), 'local databases (the old one is left, unused)');
    assertEqual(refusedKeys, [], 'refused-code list after the code worked again');
    return `refused list ${JSON.stringify(refusedBefore)}; #/join/${CUSTOM} → /relay/me ${joinRequests} → 공용 서재; ${view.translated} sentences, 0 calls; 0 marks / notes / summary; databases ${dbs.join(', ')} (the old one unused)`;
  });

  await step('김간호사 (random code) unaffected: a sync works, her highlight is there, 최근 활동 shows “관리자 · 초대 코드 삭제에 따라 개인 기록 정리”', async () => {
    const n0 = kim.log.length;
    await syncShared(kp);
    const chip = await kp.locator('.lib-sec-sync[data-lib="shared:team"]').getAttribute('aria-label');
    await sec(kp, 'shared:team').locator('.tree-item.is-activity').click();
    await kp.waitForFunction(() => location.hash === '#/s/team/activity');
    await kp.waitForSelector('.activity-item', { timeout: 20000 });
    const items = await kp.$$eval('.activity-item', (els) => els.map((e) => e.textContent.replace(/\s+/g, ' ').trim()));
    const api = await worker('/shared/team/activity?limit=10', { code: state.codes.kim });
    const me = await worker('/relay/me', { code: state.codes.kim });
    const s = await stored(kp);
    const statuses = kim.log.slice(n0).map((r) => r.status);
    await shot(kp, 'code-delete-e2e-08-kim-activity');
    await kp.evaluate(() => { location.hash = '#/s/team'; });
    assertEqual([s.relay?.code, me.status, await kp.locator('.start').count()], [state.codes.kim, 200, 0], 'code kept, /relay/me, no first screen');
    assert(statuses.every((x) => x === 200 || x === 304), `김간호사's requests after the deletion: ${statuses}`);
    assertEqual(peopleFiles(state.pid.kim).length, 1, 'her file');
    const adminItems = api.body.items.filter((i) => i.who === '관리자').map((i) => i.summary);
    assertEqual([api.status, adminItems], [200, ['초대 코드 삭제에 따라 개인 기록 정리']], 'activity API: the admin\'s line');
    assert(items.some((t) => t.includes('관리자') && t.includes('초대 코드 삭제에 따라 개인 기록 정리')), `activity rows ${JSON.stringify(items)}`);
    assert(!JSON.stringify(api.body).includes(state.pid.team) && !JSON.stringify(api.body).includes(CUSTOM), 'activity leaks the personId or the code');
    return `sync chip “${chip}”; requests ${statuses.join(',')}; activity “${items.find((t) => t.includes('관리자'))}”; /relay/me 200; her highlight file kept`;
  });

  await step('no console errors, page errors, CSP violations, native dialogs or escaped requests; every upstream call carried only the owner key', async () => {
    assert(!problems.length, problems.join('\n'));
    assert(fake.calls.every((c) => c.headers['x-api-key'] === OWNER_KEY && !c.headers.authorization), 'upstream headers');
    return `0 problems; ${expectedRefusals.length} refusals the browsers logged (asked for); ${fake.calls.length} upstream calls (owner key only)`;
  }, { always: true });
} catch (err) {
  results.push({ name: 'test environment', result: 'fail', evidence: err?.stack || String(err) });
  console.log(`SETUP FAILED: ${err?.stack || err}`);
} finally {
  writeFileSync(`${OUT}/results.json`, JSON.stringify(results, null, 2));
  for (const p of people) await p.ctx.close().catch(() => {});
  await browser?.close().catch(() => {});
  stopWrangler();
  await fake?.close().catch(() => {});
  await gh?.close().catch(() => {});
  server?.kill();
  const passed = results.filter((r) => r.result === 'pass').length;
  const failed = results.filter((r) => r.result === 'fail');
  const skipped = results.filter((r) => r.result === 'skipped');
  console.log(`\ncode-delete e2e: ${passed}/${results.length} passed${failed.length ? ` — FAILED: ${failed.map((f) => f.name).join(' | ')}` : ''}${skipped.length ? ` (${skipped.length} skipped)` : ''}`);
  process.exitCode = failed.length || skipped.length ? 1 : 0;
}
