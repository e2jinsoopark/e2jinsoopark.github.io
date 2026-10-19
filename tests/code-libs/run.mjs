// 코드별 서재 (one library per invite code, docs/CODE-LIBRARIES.md), end to end with the REAL relay Worker and the
// real app:
//   node tests/code-libs/run.mjs [--headed]
// Starts, and stops again:
//   - a fake GitHub on 127.0.0.1:8244 (tests/store/fake-github.mjs) holding the team repo of relay/wrangler.jsonc
//     SHARED_LIBRARIES (dindoopark/paper-team-library), reached only by the Worker through GITHUB_API_BASE. It starts as
//     production does today (2026-10-19): 전체 공용 서재 with folder ‘찬영’ and three papers — ‘Lessons in biostatistics’
//     (봄당테스트, in the 휴지통), ‘Moral Sensitivity in Psychiatric Practice’ (봄당, top level) and ‘Procedures Performed
//     by Advanced Practice Provider’ (6기, in ‘찬영’) — committed the way the Worker before code libraries wrote them
//     (no {lib:…} markers);
//   - a fake Anthropic API on 127.0.0.1:8245 (tests/relay-e2e/fake-anthropic.mjs; the 요약 calls);
//   - the relay Worker under `wrangler dev` on 127.0.0.1:8787 on a local D1 shaped like the deployed one: the schema from
//     before code deletion (relay/test/lib.mjs migratedDatabase), then the codes of production — NV, 6기, 봄당 (active),
//     봄당테스트 (stopped), 관리자 비교테스트 — without library ids (two with person salts, as codes made after the
//     code-deletion update have them); production vars of relay/wrangler.jsonc plus GITHUB_API_BASE, UPSTREAM_URL and
//     fake secrets; no TEST_MODE;
//   - `python -m http.server 8243` serving a staged copy of the site (tests/relay-e2e/test-site.mjs).
// Edge only. No paid API, no real GitHub, no real relay, nothing deployed.
// Scenario: 봄당, 6기 and NV join (each lands in their own '<name> 서재'); 봄당 highlights and summarises ‘Moral …’ and
// 6기 summarises ‘Procedures …’ in 전체 공용 서재 (NV highlights ‘Moral …’ too); the owner runs 설정 → 초대 코드 관리 →
// ‘전체 공용 서재 논문을 올린 사람 서재로 나누기’ (plan: 2 moves, 1 skipped tombstone) and applies it; 봄당 finds ‘Moral …’
// with the old highlight and summary in 봄당 서재 and nothing of 6기; 6기 finds ‘Procedures …’ in ‘찬영’ in 6기 서재;
// 전체 공용 서재 keeps neither; 봄당's new upload stays invisible to 6기 and NV; 봄당 copies it to 전체 공용 서재 (then
// everyone sees it); 최근 활동 per library; the owner deletes 봄당 moving its library to NV (NV gets the papers and the
// notes) and deletes 6기 with its library (codes/<id>/ gone); a code named like markup joins and adds a folder named
// like markup (with a library marker) to 전체 공용 서재 — shown as text to it and to NV, nothing runs.
// Results + screenshots: C:/Users/dindoo/Projects/pr-tools/out/code-libs/e2e/.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'file:///C:/Users/dindoo/Projects/pr-tools/node_modules/playwright/index.mjs';
import { applySql, d1RowsAt, migratedDatabase, personIdOf, portInUse, startWrangler } from '../../relay/test/lib.mjs';
import { startFakeAnthropic } from '../relay-e2e/fake-anthropic.mjs';
import { stageTestSite } from '../relay-e2e/test-site.mjs';
import { startFakeGitHub } from '../store/fake-github.mjs';

const APP_PORT = 8243;
const GITHUB_PORT = 8244;
const UPSTREAM_PORT = 8245;
const APP = `http://127.0.0.1:${APP_PORT}`;
const WORKER = 'http://127.0.0.1:8787'; // relay/test/lib.mjs starts wrangler dev here
const OUT = 'C:/Users/dindoo/Projects/pr-tools/out/code-libs/e2e';
const STATE_DIR = join(OUT, 'state');
const FIXTURES = 'C:/Users/dindoo/Projects/pr-fixtures';
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SETTINGS_KEY = 'pr.settings.v1';
const OWNER_KEY = 'sk-ant-code-libs-e2e-fake-owner-key-0000';
const ADMIN_TOKEN = 'code-libs-e2e-admin-token-0123456789abcdef';
const TEAM = { owner: 'dindoopark', repo: 'paper-team-library', token: 'github_pat_team_code_libs_e2e_0123456789' };
const TEAM_NAME = '전체 공용 서재';
const DAY = 86_400_000;
// Production today: five codes, one stopped (generated shape, Crockford letters). Salts: codes made after the
// code-deletion update have one; the others keep their saltless personId.
const CODES = {
  nv: { code: 'PR-NV2K-7M4Q', name: 'NV', salt: null },
  six: { code: 'PR-6G1K-3T8W', name: '6기', salt: '6a1c0e9b2d4f68a1c3e5b7d9f0a2c4e6' },
  bom: { code: 'PR-B0MD-4NG5', name: '봄당', salt: 'b0d4e6f8a1c3e5b7d9f0a2c4e6b8d0f2' },
  bomTest: { code: 'PR-B0MT-5ST6', name: '봄당테스트', salt: null, active: false },
  admin: { code: 'PR-ADM1-N7XZ', name: '관리자 비교테스트', salt: null },
};
const PID = Object.fromEntries(Object.entries(CODES).map(([k, c]) => [k, personIdOf(c.code, c.salt)]));
const TITLES = {
  lessons: 'Lessons in biostatistics',
  moral: 'Moral Sensitivity in Psychiatric Practice',
  proc: 'Procedures Performed by Advanced Practice Provider',
};
const IDS = { lessons: 'p_1essons0', moral: 'p_m0ra1sen', proc: 'p_pr0cedur', chanyeong: 'f_chany30n' };
const PDF = { lessons: 'simwright2005', moral: 'lu2025', proc: 'kiekkas2012', upload: 'cohen1960' };
const IP = { owner: '198.51.100.40', bom: '198.51.100.41', six: '198.51.100.42', nv: '198.51.100.43', markup: '198.51.100.44', node: '198.51.100.99' };
const headed = process.argv.includes('--headed');

mkdirSync(OUT, { recursive: true });
const results = [];
const problems = []; // page errors, unexpected console errors, CSP violations, escaped requests, native dialogs, leaks
const expectedRefusals = []; // Chromium's "Failed to load resource" for answers the app expects (304, 409/422 + retry)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function assert(cond, msg) { if (!cond) throw new Error(msg); }
function assertEqual(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg}: expected ${e}, got ${a}`);
}

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
async function worker(path, { admin = false, code = null, method = 'GET', body, accept, ip = IP.node } = {}) {
  const headers = { 'cf-connecting-ip': ip };
  if (admin) headers.authorization = `Bearer ${ADMIN_TOKEN}`;
  if (code) headers.authorization = `Bearer ${code}`;
  if (accept) headers.accept = accept;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${WORKER}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, body: json, text };
}

/** Every repo path the code's holder can list through /shared/<lib>/gh (recursive listing of the head tree). */
async function listedThrough(lib, code) {
  const base = `/shared/${lib}/gh/repos/team/library`;
  const ref = await worker(`${base}/git/ref/heads/main`, { code });
  const commit = await worker(`${base}/git/commits/${ref.body.object.sha}`, { code });
  const tree = await worker(`${base}/git/trees/${commit.body.tree.sha}?recursive=1`, { code });
  return tree.body.tree.filter((e) => e.type === 'blob').map((e) => e.path).sort();
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
const under = (prefix) => [...teamFiles().keys()].filter((p) => p.startsWith(prefix)).sort();
const d1 = (sql, ...params) => d1RowsAt(STATE_DIR, sql, ...params);
const libraryIdOf = async (k) => (await d1('SELECT library_id FROM codes WHERE code = ?', CODES[k].code))[0]?.library_id ?? null;
const root = (libraryId) => `codes/${libraryId}/`;
const pdfBytes = (name) => readFileSync(`${FIXTURES}/${name}.pdf`);
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/** The team repo as production has it today (written by the Worker before code libraries: no {lib:…} markers). */
function seedTeamRepo() {
  const T0 = Date.now() - 3 * DAY;
  const json = (o) => `${JSON.stringify(o, null, 2)}\n`;
  const record = (id, title, addedBy, folderId, name, at, extra = {}) => {
    const bytes = pdfBytes(name);
    return {
      id, title, authors: '', year: 2024, fileName: `${name}.pdf`, size: bytes.length, pages: 0, folderId, starred: false,
      addedAt: at, updatedAt: at, lastOpenedAt: null, translatedCount: 0, sentenceCount: 0, sha256: sha256(bytes), addedBy, ...extra,
    };
  };
  const folder = { id: IDS.chanyeong, name: '찬영', parentId: null, createdAt: T0 + 2 * 3600_000, updatedAt: T0 + 2 * 3600_000 };
  const lessons = record(IDS.lessons, TITLES.lessons, '봄당테스트', null, PDF.lessons, T0);
  const moral = record(IDS.moral, TITLES.moral, '봄당', null, PDF.moral, T0 + 3600_000);
  const proc = record(IDS.proc, TITLES.proc, '6기', IDS.chanyeong, PDF.proc, T0 + 2 * 3600_000);
  const lib = (folders, papers, at) => json({ version: 1, updatedAt: at, folders, papers });
  gh.createRepo(TEAM.owner, TEAM.repo, { private: true });
  gh.commitFiles(TEAM.owner, TEAM.repo, { 'README.md': '# 논문 리더 데이터\n' }, { message: '[봄당테스트] 논문 리더 데이터 저장소 시작', time: T0 - 60_000 });
  gh.commitFiles(TEAM.owner, TEAM.repo, {
    'library.json': lib([], [lessons], T0), [`papers/${IDS.lessons}/paper.pdf`]: pdfBytes(PDF.lessons),
  }, { message: `[봄당테스트] 논문 추가 ‘${TITLES.lessons}’`, time: T0 });
  gh.commitFiles(TEAM.owner, TEAM.repo, {
    'library.json': lib([], [lessons, moral], T0 + 3600_000), [`papers/${IDS.moral}/paper.pdf`]: pdfBytes(PDF.moral),
  }, { message: `[봄당] 논문 추가 ‘${TITLES.moral}’`, time: T0 + 3600_000 });
  gh.commitFiles(TEAM.owner, TEAM.repo, {
    'library.json': lib([folder], [lessons, moral, proc], T0 + 2 * 3600_000), [`papers/${IDS.proc}/paper.pdf`]: pdfBytes(PDF.proc),
  }, { message: `[6기] 폴더 만듦 ‘찬영’ · 논문 추가 ‘${TITLES.proc}’`, time: T0 + 2 * 3600_000 });
  const gone = { ...lessons, deleted: true, deletedAt: T0 + 3 * 3600_000, deletedBy: '봄당테스트', updatedAt: T0 + 3 * 3600_000 };
  gh.commitFiles(TEAM.owner, TEAM.repo, {
    'library.json': lib([folder], [gone, moral, proc], T0 + 3 * 3600_000),
  }, { message: `[봄당테스트] 논문 삭제 ‘${TITLES.lessons}’`, time: T0 + 3 * 3600_000 });
}

/** The production codes on the legacy-shaped D1 (no library_id yet; person_salt as the code-deletion Worker adds it). */
function seedCodes() {
  const sqlText = (v) => (v === null ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);
  const rows = Object.values(CODES).map((c, i) => `(${sqlText(c.code)}, ${sqlText(c.name)}, ${c.active === false ? 0 : 1}, '["claude-haiku-5-5"]', 0.5, ${1760850000000 + i * 1000}, ${sqlText(c.salt)})`);
  const file = join(OUT, 'seed-codes.sql');
  writeFileSync(file, [
    '-- The Worker of the code-deletion update added person_salt on its first code creation (src/db.js).',
    'ALTER TABLE codes ADD COLUMN person_salt TEXT;',
    'INSERT INTO codes (code, name, active, allowed_models, daily_limit_usd, created_at, person_salt) VALUES',
    `${rows.join(',\n')};`,
    '',
  ].join('\n'));
  applySql(STATE_DIR, file);
}

// ------------------------------------------------------------------------------------------------- browser

let browser = null;

/**
 * One browser context = one device (its own storage). Only the staged app and the Worker may be reached (the pinned
 * SDK bundle on jsDelivr passes); anything else is aborted and reported. Every browser → Worker request (not
 * preflights) is logged with its status; JSON answers of /shared are scanned for the Worker's {lib:…} marker.
 */
async function device(name, { seed = null, ip, viewport = { width: 1440, height: 900 } } = {}) {
  const ctx = await browser.newContext({ locale: 'ko-KR', viewport, colorScheme: 'light', reducedMotion: 'reduce' });
  await ctx.route(new RegExp(`^https?:\\/\\/(?!127\\.0\\.0\\.1:(?:${APP_PORT}|8787)\\/)`), (route) => {
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
    const u = new URL(req.url());
    const entry = { method: req.method(), path: u.pathname, search: u.search, at: Date.now(), status: null };
    entries.set(req, entry);
    log.push(entry);
  });
  page.on('response', async (res) => {
    const e = entries.get(res.request());
    if (!e) return;
    e.status = res.status();
    // The library marker is the Worker's own bookkeeping; no answer to the app may carry it.
    if (e.path.startsWith('/shared') && !e.path.includes('/git/blobs/') && /json/.test(res.headers()['content-type'] || '')) {
      const text = await res.text().catch(() => '');
      if (text.includes('{lib:')) problems.push(`${name}: {lib:…} marker in the answer to ${e.method} ${e.path}`);
    }
  });
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
  return { name, ctx, page, log };
}

const shot = (target, file, opts = {}) => target.screenshot({ path: `${OUT}/${file}.png`, ...opts });
const sec = (page, key) => page.locator(`.lib-sec[data-lib="${key}"]`);
const rowTitles = (page) => page.$$eval('.paper-row .paper-title', (els) => els.map((e) => e.textContent.trim()));

/** The sidebar as data: [{ key, label, all, folders: ['name=count'] }]. */
const sections = (page) => page.$$eval('.lib-sec', (els) => els.map((s) => ({
  key: s.dataset.lib,
  label: s.querySelector('.lib-sec-label')?.textContent,
  all: s.querySelector('.tree-item .tree-count')?.textContent ?? null,
  folders: [...s.querySelectorAll('.tree-item.is-folder')].map((x) => `${x.querySelector('.tree-label').textContent}=${x.querySelector('.tree-count').textContent}`),
})));

/** Both libraries behind the relay are open (their trees are shown). */
async function relayLibsReady(page) {
  await page.waitForSelector('.lib-sec[data-lib="shared:mine"] .lib-sec-body .lib-nav-heading', { timeout: 30000 });
  await page.waitForSelector('.lib-sec[data-lib="shared:team"] .lib-sec-body .lib-nav-heading', { timeout: 30000 });
}

/** Wait until the sidebar's 전체 counts are `counts` ({ mine: '1', team: '0' }): a library shows once its first sync is in. */
async function waitCounts(page, counts, timeout = 30000) {
  await page.waitForFunction((want) => Object.entries(want).every(([lib, n]) =>
    document.querySelector(`.lib-sec[data-lib="shared:${lib}"] .tree-item .tree-count`)?.textContent === n), counts, { timeout });
}

/** A section's sync chip → 지금 동기화, then wait until it is idle again. */
async function syncSection(page, key) {
  await page.locator(`.lib-sec-sync[data-lib="${key}"]`).click();
  // (A quick sync may be over before the chip is looked at; otherwise wait until it is busy, then idle.)
  await page.waitForFunction((k) => document.querySelector(`.lib-sec-sync[data-lib="${k}"]`)?.classList.contains('is-busy'), key, { timeout: 2000 }).catch(() => {});
  await page.waitForFunction((k) => {
    const c = document.querySelector(`.lib-sec-sync[data-lib="${k}"]`);
    return c && !c.classList.contains('is-busy');
  }, key, { timeout: 30000 });
}

/** Open a library's 전체 list (`lib` 'mine' | 'team'). */
async function openList(page, lib) {
  await sec(page, `shared:${lib}`).locator('.tree-item', { hasText: '전체' }).click();
  await page.waitForFunction((l) => location.hash === `#/s/${l}`, lib, { timeout: 10000 });
}

async function waitForReader(page) {
  await page.waitForFunction(() => document.querySelector('.tp-s[data-sid], .tp-empty, .reader .message-screen'), null, { timeout: 60000 });
  const error = await page.$('.reader .message-screen');
  if (error) throw new Error(`reader error: ${(await error.textContent()).trim()}`);
  await page.waitForFunction(() => !document.querySelector('.reader-left .reader-loading'), null, { timeout: 30000 });
  await page.waitForFunction(() => document.querySelector('.pdfv-page canvas'), null, { timeout: 30000 });
  await sleep(500);
}

/** Open a paper from the list shown now and wait for the reader. */
async function openPaper(page, lib, paperId, title) {
  await page.locator('.paper-row', { hasText: title.slice(0, 30) }).locator('.paper-link').click();
  await page.waitForFunction(([l, id]) => location.hash === `#/s/${l}/paper/${id}`, [lib, paperId], { timeout: 10000 });
  await waitForReader(page);
}

async function backToLibrary(page, lib) {
  await page.locator('.reader-toolbar .tb-back').click();
  await page.waitForFunction((l) => location.hash.startsWith(`#/s/${l}`) && document.querySelector('.library'), lib, { timeout: 10000 });
  await relayLibsReady(page);
}

/** Highlight one long text-layer span of page 1 with a real mouse drag → selection menu → colour. */
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

/** 요약 through the relay (one non-streaming call to the fake Anthropic). */
async function summarise(page) {
  await page.locator('.tab[data-tab="summary"]').click();
  await page.locator('[data-action="generate"]').click();
  await page.waitForFunction(() => document.querySelectorAll('.pf-summary__body h2').length >= 3, null, { timeout: 30000 });
  await page.locator('.tab[data-tab="translation"]').click();
}

/** What the reader shows of this person's notes on the open paper: marks, 메모 colours, a stored summary. */
async function readerNotes(page, { wantMarks = 0 } = {}) {
  if (wantMarks) {
    await page.waitForFunction((n) => document.querySelectorAll('.pdfv-mark-layer--annotations .pdfv-mark').length >= n, wantMarks, { timeout: 20000 });
  } else {
    await sleep(1500); // annotations (and any wrong request) would show up here
  }
  const marks = await page.locator('.pdfv-mark-layer--annotations .pdfv-mark').count();
  await page.locator('.tab[data-tab="notes"]').click();
  await sleep(400);
  const colors = await page.$$eval('.pf-note', (els) => els.map((e) => /pf-note--(\w+)/.exec(e.className)?.[1] || '?'));
  await page.locator('.tab[data-tab="summary"]').click();
  await sleep(500);
  const summary = await page.locator('.pf-summary__body h2').count();
  await page.locator('.tab[data-tab="translation"]').click();
  return { marks, colors, summary };
}

const summaryCalls = () => fake.calls.filter((c) => c.kind === 'summary');
/** Commit summaries the app hides in 최근 활동 (js/ui/library-view.js QUIET_ACTIVITY). */
const QUIET = new Set(['내 메모·AI 결과 동기화', '논문 정보 갱신']);

/** GET /shared/<lib>/activity for a code: "who summary" lines, newest first, without the quiet ones the app hides. */
async function activityApi(lib, code) {
  const res = await worker(`/shared/${lib}/activity?limit=50`, { code });
  if (res.status !== 200) throw new Error(`activity ${lib}: ${res.status} ${res.text}`);
  if (res.text.includes('{lib:')) throw new Error(`activity ${lib} carries a library marker: ${res.text}`);
  return res.body.items.filter((i) => !QUIET.has(i.summary)).map((i) => `${i.who} ${i.summary}`);
}

// ------------------------------------------------------------------------------------------------- owner UI

async function openAdmin(page) {
  await page.goto('about:blank'); // a fresh load (the same address would only change the fragment)
  await page.goto(`${APP}/index.html#/settings/invites`);
  await page.locator('#set-invites summary', { hasText: '관리 화면 열기' }).click();
  await page.waitForSelector('#set-invites .relay-code[data-code]', { timeout: 15000 });
}

/** Activity rows of a library in the UI (its 최근 활동 page), as "who summary" text. */
async function activityRows(page, lib) {
  await sec(page, `shared:${lib}`).locator('.tree-item.is-activity').click();
  await page.waitForFunction((l) => location.hash === `#/s/${l}/activity`, lib);
  // (The loading state is an .empty-state with role=status; wait for the list or a real empty / error state.)
  await page.waitForSelector('.activity-item, .lib-content .empty-state:not([role="status"])', { timeout: 20000 });
  return page.$$eval('.activity-item .activity-text', (els) => els.map((e) => e.textContent.replace(/\s+/g, ' ').trim()));
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
  seedTeamRepo();
  fake = await startFakeAnthropic({ port: UPSTREAM_PORT });
  state.schemaSteps = migratedDatabase(STATE_DIR);
  seedCodes();
  stopWrangler = await startWrangler({
    stateDir: STATE_DIR,
    logFile: join(OUT, 'wrangler.log'),
    // Production vars of relay/wrangler.jsonc (ALLOWED_ORIGINS, SHARED_LIBRARIES, CODE_LIBRARY_MAX_BYTES, limits) plus the
    // fakes and fake secrets.
    vars: { UPSTREAM_URL: fake.url, ANTHROPIC_API_KEY: OWNER_KEY, ADMIN_TOKEN, GITHUB_API_BASE: gh.url, TEAM_GITHUB_TOKEN: TEAM.token },
  });
  browser = await chromium.launch({ channel: 'msedge', headless: !headed, slowMo: headed ? 40 : 0 });

  await step('production shape: 5 codes without library ids (봄당테스트 stopped), 전체 공용 서재 with ‘찬영’ and 3 papers; GET /shared lists ‘<name> 서재’ then 전체 공용 서재 and makes the library id on the first call', async () => {
    const columnsBefore = (await d1('PRAGMA table_info(codes)')).map((c) => c.name);
    const before = await d1('SELECT code, name, active FROM codes ORDER BY created_at, code');
    const lib = teamJson('library.json');
    const info = await worker('/shared', { code: CODES.nv.code });
    const stopped = await worker('/shared', { code: CODES.bomTest.code });
    const columnsAfter = (await d1('PRAGMA table_info(codes)')).map((c) => c.name);
    const ids = await d1('SELECT name, library_id FROM codes WHERE library_id IS NOT NULL');
    const nvId = await libraryIdOf('nv');
    assertEqual(state.schemaSteps, ['test/legacy-schema.sql', 'schema.sql', 'schema.sql'], 'schema steps');
    assert(columnsBefore.includes('person_salt') && !columnsBefore.includes('library_id'), `columns before the Worker ran: ${columnsBefore}`);
    assert(columnsAfter.includes('library_id') && columnsAfter.includes('library_max_bytes'), `columns after GET /shared: ${columnsAfter}`);
    assertEqual(ids.map((r) => r.name), ['NV'], 'library ids after one GET /shared (only the caller\'s)');
    assertEqual(before.map((r) => [r.name, r.active]).slice(-5), Object.values(CODES).map((c) => [c.name, c.active === false ? 0 : 1]), 'codes');
    assertEqual(lib.folders.map((f) => [f.name, Boolean(f.deleted)]), [['찬영', false]], 'team folders');
    assertEqual(lib.papers.map((p) => [p.title, p.addedBy, p.folderId, Boolean(p.deleted)]), [
      [TITLES.lessons, '봄당테스트', null, true], [TITLES.moral, '봄당', null, false], [TITLES.proc, '6기', IDS.chanyeong, false],
    ], 'team papers');
    assertEqual(info.status, 200, 'GET /shared');
    assertEqual(info.body, {
      libraries: [{ id: 'mine', name: 'NV 서재', kind: 'code' }, { id: 'team', name: TEAM_NAME, kind: 'team' }],
      personId: PID.nv, name: 'NV', libraryId: nvId,
    }, 'GET /shared for NV');
    assert(/^[0-9a-f]{16}$/.test(nvId || ''), `NV's library id ${nvId}`);
    assertEqual(stopped.status, 401, 'stopped code 봄당테스트');
    return `D1: ${before.length} codes, no library_id column; the Worker added library_id + library_max_bytes on NV's first GET /shared (NV) → ${JSON.stringify(info.body.libraries)}, libraryId ${nvId} (made now); 봄당테스트 401; team repo ${teamCommits().length} commits without markers`;
  });

  const bom = await device('봄당', { ip: IP.bom });
  const six = await device('6기', { ip: IP.six });
  const nv = await device('NV', { ip: IP.nv });
  people.push(bom, six, nv);
  const bp = bom.page;
  const sp = six.page;
  const np = nv.page;

  await step('봄당 (fresh browser, join link): lands in ‘봄당 서재’ (empty: one line who can see it), no 내 서재; 전체 공용 서재 shows ‘찬영’ and both papers; highlights + 요약 on ‘Moral …’ there', async () => {
    await bp.goto(`${APP}/#/join/${CODES.bom.code}`);
    await bp.waitForSelector('.library', { timeout: 30000 });
    await relayLibsReady(bp);
    await bp.waitForFunction(() => location.hash === '#/s/mine', null, { timeout: 15000 });
    await waitCounts(bp, { mine: '0', team: '2' });
    const empty = (await bp.locator('.shared-intro.is-code').innerText()).replace(/\s+/g, ' ').trim();
    const s = await sections(bp);
    await shot(bp, 'code-libs-e2e-01-bom-joined');
    assertEqual(s.map((x) => [x.key, x.label]), [['shared:mine', '봄당 서재'], ['shared:team', TEAM_NAME]], 'sections');
    assertEqual(s.map((x) => [x.all, x.folders]), [['0', []], ['2', ['찬영=1']]], 'counts and trees');
    assert(empty.includes('이 초대 코드를 가진 사람만 볼 수 있어요.'), `empty state “${empty}”`);
    await openList(bp, 'team');
    await openPaper(bp, 'team', IDS.moral, TITLES.moral);
    state.bomQuote = await highlightOnPage1(bp, 1, 'yellow');
    const calls0 = summaryCalls().length;
    await summarise(bp);
    const files = await waitFor(() => {
      const f = under(`people/${PID.bom}/`);
      return f.length === 2 ? f : null;
    }, { timeout: 45000, what: '봄당 annotations.json + ai.json in 전체 공용 서재' });
    await backToLibrary(bp, 'team');
    assertEqual(files, [`people/${PID.bom}/papers/${IDS.moral}/ai.json`, `people/${PID.bom}/papers/${IDS.moral}/annotations.json`], '봄당 files');
    assertEqual(summaryCalls().length - calls0, 1, '요약 calls');
    assertEqual(teamJson(files[1]).items.filter((a) => !a.deleted).map((a) => a.color), ['yellow'], 'the highlight');
    return `#/join → #/s/mine “${empty}”; sidebar ${s.map((x) => `${x.label}(${x.all}${x.folders.length ? `, ${x.folders}` : ''})`).join(' | ')}; highlight “${state.bomQuote.slice(0, 40)}…” + 요약 → ${files.join(', ')}`;
  });

  await step('6기 (fresh browser): lands in ‘6기 서재’; opens ‘Procedures …’ in ‘찬영’ of 전체 공용 서재 and makes a 요약 (ai.json); NV highlights ‘Moral …’ in 전체 공용 서재 (green)', async () => {
    await sp.goto(`${APP}/#/join/${CODES.six.code}`);
    await sp.waitForSelector('.library', { timeout: 30000 });
    await relayLibsReady(sp);
    await sp.waitForFunction(() => location.hash === '#/s/mine', null, { timeout: 15000 });
    await waitCounts(sp, { mine: '0', team: '2' });
    await sec(sp, 'shared:team').locator('.tree-item.is-folder', { hasText: '찬영' }).click();
    await sp.waitForFunction(() => document.querySelectorAll('.paper-row').length === 1, null, { timeout: 10000 });
    await openPaper(sp, 'team', IDS.proc, TITLES.proc);
    await summarise(sp);
    const sixFiles = await waitFor(() => {
      const f = under(`people/${PID.six}/`);
      return f.length === 1 ? f : null;
    }, { timeout: 45000, what: '6기 ai.json' });
    await backToLibrary(sp, 'team');
    await np.goto(`${APP}/#/join/${CODES.nv.code}`);
    await np.waitForSelector('.library', { timeout: 30000 });
    await relayLibsReady(np);
    await np.waitForFunction(() => location.hash === '#/s/mine', null, { timeout: 15000 });
    await waitCounts(np, { mine: '0', team: '2' });
    await openList(np, 'team');
    await openPaper(np, 'team', IDS.moral, TITLES.moral);
    const others = await readerNotes(np);
    state.nvQuote = await highlightOnPage1(np, 4, 'green');
    const nvFiles = await waitFor(() => {
      const f = under(`people/${PID.nv}/`);
      return f.length === 1 ? f : null;
    }, { timeout: 45000, what: 'NV annotations.json' });
    await backToLibrary(np, 'team');
    const ids = { bom: await libraryIdOf('bom'), six: await libraryIdOf('six'), nv: await libraryIdOf('nv') };
    state.lib = ids;
    assertEqual(sixFiles, [`people/${PID.six}/papers/${IDS.proc}/ai.json`], '6기 files');
    assertEqual(nvFiles, [`people/${PID.nv}/papers/${IDS.moral}/annotations.json`], 'NV files');
    assertEqual([others.marks, others.colors, others.summary], [0, [], 0], '봄당\'s notes shown to NV');
    assert(Object.values(ids).every((x) => /^[0-9a-f]{16}$/.test(x || '')) && new Set(Object.values(ids)).size === 3, `library ids ${JSON.stringify(ids)}`);
    assertEqual(under('codes/'), [], 'nothing in code libraries yet');
    return `6기 요약 → ${sixFiles[0]}; NV saw none of 봄당's notes, highlighted “${state.nvQuote.slice(0, 30)}…” → ${nvFiles[0]}; library ids 봄당 ${ids.bom}, 6기 ${ids.six}, NV ${ids.nv}`;
  });

  const owner = await device('owner', { seed: { relay: { adminToken: ADMIN_TOKEN } }, ip: IP.owner, viewport: { width: 1280, height: 1400 } });
  people.push(owner);
  const op = owner.page;

  await step('owner: 설정 → 초대 코드 관리 → ‘전체 공용 서재 논문을 올린 사람 서재로 나누기’ shows the dry-run plan (2 moves, 1 skipped tombstone, nothing written), then 2편 옮기기 applies it in one commit', async () => {
    await openAdmin(op);
    const commitsBefore = teamCommits().length;
    await op.locator('#set-invites .relay-split-btn', { hasText: '전체 공용 서재 논문을 올린 사람 서재로 나누기' }).click();
    await op.waitForSelector('.split-dialog .split-list');
    const plan = await op.evaluate(() => ({
      title: document.querySelector('.split-dialog .modal-title').textContent,
      message: document.querySelector('.split-dialog .modal-message').textContent,
      moves: [...document.querySelectorAll('.split-dialog .split-list:not(.split-skipped .split-list) .split-row')]
        .map((r) => [r.querySelector('.split-title').textContent, r.querySelector('.split-where b').textContent, r.querySelector('.split-folder').textContent]),
      skipped: [...document.querySelectorAll('.split-dialog .split-skipped .split-row')]
        .map((r) => [r.querySelector('.split-title').textContent, r.querySelector('.split-where').textContent]),
      buttons: [...document.querySelectorAll('.split-dialog .modal-footer .btn')].map((b) => b.textContent.trim()),
    }));
    await op.locator('.split-dialog .split-skipped summary').click();
    await shot(op.locator('.split-dialog'), 'code-libs-e2e-02-split-plan');
    const afterDry = teamCommits().length;
    const applied = op.waitForResponse((r) => r.url().endsWith('/relay/admin/shared/team/split-by-uploader') && r.request().postData()?.includes('false'), { timeout: 60000 });
    await op.locator('.split-dialog .modal-footer .btn-primary').click();
    const res = await applied;
    const answer = await res.json();
    await op.waitForSelector('.toast >> text=논문 2편을 올린 사람 서재로 옮겼습니다.', { timeout: 20000 });
    await op.waitForSelector('.split-dialog', { state: 'detached' });
    const commits = teamCommits();
    const team = teamJson('library.json');
    const bomLib = teamJson(`${root(state.lib.bom)}library.json`);
    const sixLib = teamJson(`${root(state.lib.six)}library.json`);
    const chan = sixLib?.folders?.find((f) => f.name === '찬영');
    assertEqual(plan.title, '올린 사람 서재로 나누기', 'dialog title');
    assertEqual(plan.message, '논문 2편을 올린 사람의 코드 서재로 옮깁니다.', 'plan line');
    assertEqual(plan.moves, [[TITLES.moral, '봄당 서재', '최상위'], [TITLES.proc, '6기 서재', '찬영']], 'planned moves');
    assertEqual(plan.skipped, [[TITLES.lessons, '휴지통에 있음']], 'skipped');
    assertEqual(plan.buttons, ['취소', '2편 옮기기'], 'buttons');
    assertEqual(afterDry, commitsBefore, 'the dry run wrote nothing');
    assertEqual([res.status(), answer.moves.length, answer.skipped.length, /^[0-9a-f]{40}$/.test(answer.commitSha)], [200, 2, 1, true], 'apply answer');
    assertEqual(commits.length, commitsBefore + 1, 'one commit');
    assertEqual(commits[0].message.split('\n'), [
      '[관리자] {lib:team} 올린 사람의 코드 서재로 나누기',
      `{lib:${state.lib.bom}} 전체 공용 서재에서 논문 1편 옮겨 옴`,
      `{lib:${state.lib.six}} 전체 공용 서재에서 논문 1편 옮겨 옴`,
    ], 'commit message (one line per library it changed)');
    // 전체 공용 서재: the two records left (a move, not a tombstone), ‘찬영’ (now empty) tombstoned, Lessons stays.
    assertEqual(team.papers.map((p) => [p.id, Boolean(p.deleted)]), [[IDS.lessons, true]], 'team papers after');
    assertEqual(team.folders.map((f) => [f.name, f.deleted, f.deletedBy]), [['찬영', true, '관리자']], 'team folders after');
    assertEqual(bomLib.papers.map((p) => [p.id, p.title, p.folderId]), [[IDS.moral, TITLES.moral, null]], '봄당 서재 library.json');
    assert(chan && sixLib.papers.map((p) => [p.id, p.title, p.folderId]).join() === [IDS.proc, TITLES.proc, chan.id].join(), `6기 서재 library.json ${JSON.stringify(sixLib)}`);
    assertEqual(under(root(state.lib.bom)), [
      `${root(state.lib.bom)}library.json`, `${root(state.lib.bom)}papers/${IDS.moral}/paper.pdf`,
      `${root(state.lib.bom)}people/${PID.bom}/papers/${IDS.moral}/ai.json`, `${root(state.lib.bom)}people/${PID.bom}/papers/${IDS.moral}/annotations.json`,
    ], '봄당 서재 files');
    assertEqual(under(root(state.lib.six)), [
      `${root(state.lib.six)}library.json`, `${root(state.lib.six)}papers/${IDS.proc}/paper.pdf`,
      `${root(state.lib.six)}people/${PID.six}/papers/${IDS.proc}/ai.json`,
    ], '6기 서재 files');
    assertEqual(under(`papers/${IDS.moral}/`).concat(under(`papers/${IDS.proc}/`), under(`people/${PID.bom}/`), under(`people/${PID.six}/`)), [], 'moved files left at the root');
    assertEqual(under(`people/${PID.nv}/`), [`people/${PID.nv}/papers/${IDS.moral}/annotations.json`], 'NV\'s own note stays in 전체 공용 서재');
    assertEqual(under(`papers/${IDS.lessons}/`), [`papers/${IDS.lessons}/paper.pdf`], 'Lessons (휴지통) kept');
    return `plan “${plan.message}” ${JSON.stringify(plan.moves)}, skipped ${JSON.stringify(plan.skipped)}, no commit by the dry run; apply → one commit “${commits[0].message.replace(/\n/g, ' ⏎ ')}”; 찬영 tombstoned by 관리자; files moved under codes/<id>/`;
  });

  await step('봄당 after the split: ‘Moral …’ in 봄당 서재 with the old yellow highlight and 요약 (not NV\'s), reader badge “봄당 서재 · 이 코드만 보는 서재”; 전체 공용 서재 has no live paper and no ‘찬영’; nothing of 6기 anywhere', async () => {
    await syncSection(bp, 'shared:mine');
    await syncSection(bp, 'shared:team');
    await waitCounts(bp, { mine: '1', team: '0' });
    const s = await sections(bp);
    await openList(bp, 'team');
    const teamRows = await rowTitles(bp);
    await openList(bp, 'mine');
    await bp.waitForFunction(() => document.querySelectorAll('.paper-row').length === 1, null, { timeout: 10000 });
    const mineRows = await rowTitles(bp);
    await openPaper(bp, 'mine', IDS.moral, TITLES.moral);
    const notes = await readerNotes(bp, { wantMarks: 1 });
    const badge = await bp.evaluate(() => document.querySelector('.reader-toolbar .tb-shared')?.getAttribute('aria-label') || '');
    await shot(bp, 'code-libs-e2e-03-bom-reader');
    await backToLibrary(bp, 'mine');
    await shot(bp, 'code-libs-e2e-04-bom-after-split');
    assertEqual(s.map((x) => [x.label, x.all, x.folders]), [['봄당 서재', '1', []], [TEAM_NAME, '0', []]], 'sidebar');
    assertEqual([mineRows, teamRows], [[TITLES.moral], []], 'lists');
    assert(notes.marks >= 1 && notes.summary >= 3, `reader notes ${JSON.stringify(notes)}`);
    assertEqual(notes.colors, ['yellow'], 'notes in 봄당 서재 (own yellow, not NV\'s green)');
    assert(badge.includes('봄당 서재') && badge.includes('이 코드만 보는 서재'), `badge “${badge}”`);
    const listed = await listedThrough('mine', CODES.bom.code);
    assert(listed.every((p) => p.startsWith(root(state.lib.bom))) && !listed.some((p) => p.includes(IDS.proc) || p.includes(`/people/${PID.nv}/`)), `봄당's listing ${listed}`);
    return `sidebar ${s.map((x) => `${x.label}=${x.all}`).join(', ')}; 봄당 서재 [${mineRows}], 전체 공용 서재 []; reader: ${notes.marks} mark(s), 메모 ${JSON.stringify(notes.colors)}, 요약 ${notes.summary} headings; badge “${badge}”; Worker listing for 봄당 ${listed.length} files, all under codes/${state.lib.bom}/`;
  });

  await step('6기 after the split: ‘찬영’ with ‘Procedures …’ in 6기 서재 and its 요약; 전체 공용 서재 without both papers; no ‘Moral …’', async () => {
    await syncSection(sp, 'shared:mine');
    await syncSection(sp, 'shared:team');
    await waitCounts(sp, { mine: '1', team: '0' });
    const s = await sections(sp);
    await sec(sp, 'shared:mine').locator('.tree-item.is-folder', { hasText: '찬영' }).click();
    await sp.waitForFunction(() => location.hash.startsWith('#/s/mine') && document.querySelectorAll('.paper-row').length === 1, null, { timeout: 10000 });
    const rows = await rowTitles(sp);
    await openPaper(sp, 'mine', IDS.proc, TITLES.proc);
    const notes = await readerNotes(sp);
    await backToLibrary(sp, 'mine');
    await shot(sp, 'code-libs-e2e-05-six-after-split');
    assertEqual(s.map((x) => [x.label, x.all, x.folders]), [['6기 서재', '1', ['찬영=1']], [TEAM_NAME, '0', []]], 'sidebar');
    assertEqual(rows, [TITLES.proc], '찬영 in 6기 서재');
    assert(notes.summary >= 3 && notes.marks === 0, `reader notes ${JSON.stringify(notes)}`);
    const listed = await listedThrough('mine', CODES.six.code);
    const team = await listedThrough('team', CODES.six.code);
    assert(listed.every((p) => p.startsWith(root(state.lib.six))), `6기's listing ${listed}`);
    assert(!team.some((p) => p.startsWith('codes/') || p.includes(IDS.moral)), `6기's team listing ${team}`);
    return `sidebar ${s.map((x) => `${x.label}=${x.all} ${x.folders}`).join(', ')}; 찬영 → [${rows}]; 요약 ${notes.summary} headings; Worker listings: mine ${listed.length} files under codes/${state.lib.six}/, team ${team.length} files (no codes/)`;
  });

  await step('봄당 uploads cohen1960 into 봄당 서재: files under codes/<봄당>/ only; 6기 and NV see it nowhere (UI after sync, Worker listings, blob read → 404)', async () => {
    await openList(bp, 'mine');
    await bp.setInputFiles('.lib-actions input[type=file]', [`${FIXTURES}/${PDF.upload}.pdf`]);
    await bp.waitForFunction(() => document.querySelectorAll('.paper-row').length === 2, null, { timeout: 60000 });
    const lib = await waitFor(() => {
      const l = teamJson(`${root(state.lib.bom)}library.json`);
      const p = l?.papers?.find((x) => x.fileName === `${PDF.upload}.pdf` && !x.deleted);
      return p && teamFiles().has(`${root(state.lib.bom)}papers/${p.id}/paper.pdf`) ? p : null;
    }, { timeout: 60000, what: 'the upload pushed into 봄당 서재' });
    state.upload = { id: lib.id, title: lib.title, sha: teamFiles().get(`${root(state.lib.bom)}papers/${lib.id}/paper.pdf`).sha };
    for (const p of [sp, np]) {
      await syncSection(p, 'shared:mine');
      await syncSection(p, 'shared:team');
    }
    // NV has not synced since the split: its 전체 공용 서재 loses both papers now.
    await waitCounts(sp, { mine: '1', team: '0' });
    await waitCounts(np, { mine: '0', team: '0' });
    const seen = {};
    for (const [k, p] of [['six', sp], ['nv', np]]) {
      await openList(p, 'mine');
      const mine = await rowTitles(p);
      await openList(p, 'team');
      const team = await rowTitles(p);
      seen[k] = { mine, team };
    }
    const probes = [];
    for (const k of ['six', 'nv']) {
      for (const lib of ['mine', 'team']) {
        const listed = await listedThrough(lib, CODES[k].code);
        probes.push([k, lib, listed.filter((x) => x.includes(state.upload.id)).length]);
        const blob = await worker(`/shared/${lib}/gh/repos/team/library/git/blobs/${state.upload.sha}`, { code: CODES[k].code });
        probes.push([k, `${lib} blob`, blob.status]);
      }
    }
    const bomBlob = await worker(`/shared/mine/gh/repos/team/library/git/blobs/${state.upload.sha}`, { code: CODES.bom.code, accept: 'application/vnd.github.raw' });
    assert(state.upload.title && !Object.values(seen).some((v) => [...v.mine, ...v.team].includes(state.upload.title)), `seen ${JSON.stringify(seen)}`);
    assertEqual(seen.six.mine, [TITLES.proc], '6기 서재 list');
    assertEqual(seen.nv, { mine: [], team: [] }, 'NV lists');
    assertEqual(probes, [['six', 'mine', 0], ['six', 'mine blob', 404], ['six', 'team', 0], ['six', 'team blob', 404],
      ['nv', 'mine', 0], ['nv', 'mine blob', 404], ['nv', 'team', 0], ['nv', 'team blob', 404]], 'Worker probes');
    assertEqual(bomBlob.status, 200, '봄당 reads its own blob');
    assertEqual(under(`papers/${state.upload.id}/`), [], 'nothing at the root');
    return `‘${state.upload.title}’ → ${root(state.lib.bom)}papers/${state.upload.id}/paper.pdf; 6기 sees ${JSON.stringify(seen.six)}, NV ${JSON.stringify(seen.nv)}; listings 0, blob 404 for both through mine and team; 봄당 200`;
  });

  await step('봄당: ‘다른 서재로 복사…’ → 전체 공용 서재 copies the upload (PDF only, no notes) → 6기 and NV see it in 전체 공용 서재; 봄당 서재 keeps its own', async () => {
    await openList(bp, 'mine');
    const row = bp.locator('.paper-row', { hasText: state.upload.title.slice(0, 30) });
    await row.locator('button[aria-label="논문 메뉴"]').click();
    await bp.locator('.menu .menu-item', { hasText: '다른 서재로 복사…' }).click();
    await bp.waitForSelector('.copy-dialog .folder-picker');
    const targets = await bp.$$eval('.copy-dialog .copy-libs .btn', (els) => els.map((b) => b.textContent.trim()));
    await bp.locator('.copy-dialog .copy-libs .btn', { hasText: TEAM_NAME }).click();
    const note = (await bp.locator('.copy-dialog .note').innerText()).trim();
    await shot(bp.locator('.copy-dialog'), 'code-libs-e2e-06-copy-picker');
    await bp.locator('.copy-dialog .modal-footer .btn', { hasText: '복사' }).click();
    const copy = await waitFor(() => {
      const p = teamJson('library.json')?.papers?.find((x) => x.sha256 && x.fileName === `${PDF.upload}.pdf` && !x.deleted);
      return p && teamFiles().has(`papers/${p.id}/paper.pdf`) ? p : null;
    }, { timeout: 60000, what: 'the copy pushed into 전체 공용 서재' });
    const copiedSha = teamFiles().get(`papers/${copy.id}/paper.pdf`).sha;
    const seen = {};
    for (const [k, p] of [['six', sp], ['nv', np]]) {
      await syncSection(p, 'shared:team');
      await openList(p, 'team');
      await p.waitForFunction((t) => [...document.querySelectorAll('.paper-row .paper-title')].some((e) => e.textContent.trim() === t), copy.title, { timeout: 20000 });
      seen[k] = await rowTitles(p);
    }
    const nvBlob = await worker(`/shared/team/gh/repos/team/library/git/blobs/${copiedSha}`, { code: CODES.nv.code, accept: 'application/vnd.github.raw' });
    await shot(np, 'code-libs-e2e-07-nv-team-copy');
    assertEqual(targets, [TEAM_NAME], 'copy targets of 봄당 (no 내 서재 for an invitee)');
    assert(/모든 사람이 함께 봅니다/.test(note), `note “${note}”`);
    assertEqual([copiedSha, copy.addedBy, copy.title], [state.upload.sha, '봄당', state.upload.title], 'the copy (same blob)');
    assertEqual(under(`people/${PID.bom}/`), [], 'no notes copied');
    assertEqual(seen, { six: [state.upload.title], nv: [state.upload.title] }, '전체 공용 서재 lists');
    assertEqual(nvBlob.status, 200, 'NV reads the copied PDF');
    assert(teamFiles().has(`${root(state.lib.bom)}papers/${state.upload.id}/paper.pdf`), '봄당 서재 keeps its paper');
    return `targets [${targets}], note “${note}”; team papers/${copy.id}/paper.pdf (same blob ${copiedSha.slice(0, 8)}…); 6기 and NV list ‘${copy.title}’ in 전체 공용 서재; NV blob 200`;
  });

  await step('최근 활동 per library: 봄당 서재 = 봄당\'s upload + the split\'s line for it; 6기 서재 = its own split line only; 전체 공용 서재 = the split, the copy and the old lines — never another code library\'s', async () => {
    const bomRows = await activityRows(bp, 'mine');
    const bomTeam = await activityRows(bp, 'team');
    const sixRows = await activityRows(sp, 'mine');
    await shot(bp, 'code-libs-e2e-08-bom-activity');
    const api = {
      bom: await activityApi('mine', CODES.bom.code),
      six: await activityApi('mine', CODES.six.code),
      nv: await activityApi('mine', CODES.nv.code),
      team: await activityApi('team', CODES.nv.code),
    };
    for (const p of [bp, sp]) await openList(p, 'mine');
    // (The app shortens long titles in its commit summaries: ‘A Coefficient of Agreement for Nominal …’.)
    const added = `봄당 논문 추가 ‘${state.upload.title.slice(0, 24)}`;
    assert(api.bom.length === 2 && api.bom[0].startsWith(added) && api.bom[1] === '관리자 전체 공용 서재에서 논문 1편 옮겨 옴', `봄당 서재 activity (API) ${JSON.stringify(api.bom)}`);
    assertEqual(api.six, ['관리자 전체 공용 서재에서 논문 1편 옮겨 옴'], '6기 서재 activity (API)');
    assertEqual(api.nv, [], 'NV 서재 activity (API)');
    assert(api.team[0].startsWith(added) && api.team[0].endsWith('(봄당 서재에서 복사)') && api.team.includes('관리자 올린 사람의 코드 서재로 나누기')
      && api.team.includes(`봄당 논문 추가 ‘${TITLES.moral}’`), `전체 공용 서재 activity (API) ${JSON.stringify(api.team)}`);
    assert(!api.team.some((t) => t.includes('옮겨 옴')), `team activity shows a code library's line: ${api.team}`);
    assertEqual(bomRows.length, 2, `봄당 서재 rows ${JSON.stringify(bomRows)}`);
    assert(bomRows[0].startsWith('봄당') && bomRows[1].startsWith('관리자') && bomRows[1].includes('옮겨 옴'), `봄당 서재 rows ${JSON.stringify(bomRows)}`);
    assert(sixRows.length === 1 && sixRows[0].startsWith('관리자'), `6기 서재 rows ${JSON.stringify(sixRows)}`);
    assert(bomTeam.some((t) => t.includes('올린 사람의 코드 서재로 나누기')) && !bomTeam.some((t) => t.includes('옮겨 옴')), `전체 공용 서재 rows ${JSON.stringify(bomTeam)}`);
    return `봄당 서재 ${JSON.stringify(bomRows)}; 6기 서재 ${JSON.stringify(sixRows)}; 전체 공용 서재 (UI) ${bomTeam.length} rows incl. the split and the copy; API team ${api.team.length} lines, none of a code library`;
  });

  // The holders of the codes deleted next close their apps (code-delete e2e covers what an open app does then).
  await bom.ctx.close();
  await six.ctx.close();

  await step('owner: 삭제 ‘봄당’ → 다른 코드로 옮기기 → NV: the dialog counts 2 papers; one commit moves 봄당 서재 into NV 서재 with 봄당\'s notes; NV sees both papers and the old yellow highlight', async () => {
    await openAdmin(op);
    await op.locator(`#set-invites .relay-code[data-code="${CODES.bom.code}"] .relay-code-delete`).click();
    await op.waitForSelector('.relay-delete-dialog .relay-lib-choice');
    await op.waitForFunction(() => /논문 2편/.test(document.querySelector('.relay-delete-dialog .radio-card .radio-desc')?.textContent || ''), null, { timeout: 15000 });
    const read = () => op.evaluate(() => {
      const m = document.querySelector('.relay-delete-dialog');
      return {
        title: m.querySelector('.modal-title').textContent,
        legend: m.querySelector('.relay-lib-choice legend').textContent,
        choices: [...m.querySelectorAll('.radio-card')].map((c) => `${c.querySelector('input').checked ? '●' : '○'} ${c.querySelector('.radio-title').textContent}`),
        firstDesc: m.querySelector('.radio-card .radio-desc').textContent,
        options: [...m.querySelectorAll('select option')].map((o) => o.textContent),
        danger: m.querySelector('.modal-footer .btn-danger').textContent.trim(),
      };
    });
    const first = await read();
    await op.selectOption('.relay-delete-dialog select', CODES.nv.code);
    const chosen = await read();
    await shot(op.locator('.relay-delete-dialog'), 'code-libs-e2e-09-delete-move');
    const head = teamCommits()[0].sha;
    const del = op.waitForResponse((r) => r.request().method() === 'DELETE' && r.url().includes('/relay/admin/codes/'), { timeout: 90000 });
    await op.locator('.relay-delete-dialog .modal-footer .btn-danger').click();
    const res = await del;
    const answer = { status: res.status(), search: new URL(res.url()).search, body: await res.json() };
    await op.waitForSelector('.toast >> text=삭제했습니다. 서재는 ‘NV’ 코드로 옮겼습니다.', { timeout: 20000 });
    const commits = teamCommits();
    const newCommits = commits.slice(0, commits.findIndex((c) => c.sha === head));
    const nvRoot = root(state.lib.nv);
    const nvLib = teamJson(`${nvRoot}library.json`);
    // NV: sync, both papers in NV 서재, Moral with the highlight 봄당 made (the notes are NV's now) and 봄당's 요약.
    await syncSection(np, 'shared:mine');
    await openList(np, 'mine');
    await np.waitForFunction(() => document.querySelectorAll('.paper-row').length === 2, null, { timeout: 30000 });
    const rows = (await rowTitles(np)).sort();
    await openPaper(np, 'mine', IDS.moral, TITLES.moral);
    const notes = await readerNotes(np, { wantMarks: 1 });
    await backToLibrary(np, 'mine');
    await shot(np, 'code-libs-e2e-10-nv-after-move');
    assertEqual(first.title, '‘봄당’ 코드를 삭제할까요?', 'dialog title');
    assertEqual([first.legend, first.choices, first.firstDesc], ['봄당 서재', ['● 서재도 함께 삭제', '○ 다른 코드로 옮기기'], '논문 2편과 폴더·번역·메모가 함께 지워집니다.'], 'dialog');
    assert(first.options.some((o) => o.startsWith('NV')) && !first.options.some((o) => o.startsWith('봄당 ·')), `options ${first.options}`);
    assertEqual([chosen.choices, chosen.danger], [['○ 서재도 함께 삭제', '● 다른 코드로 옮기기'], '옮기고 삭제'], 'after picking NV');
    assertEqual([answer.status, answer.search], [200, `?library=move&to=${CODES.nv.code}`], 'DELETE');
    assertEqual([answer.body.deleted, answer.body.library?.action, answer.body.library?.papers], [true, 'move', 2], 'DELETE answer');
    assertEqual(newCommits.length, 1, 'one commit');
    assertEqual(newCommits[0].message, `[관리자] {lib:${state.lib.nv}} 삭제된 코드의 서재에서 논문 2편 옮겨 옴`, 'commit message');
    assertEqual(under(root(state.lib.bom)), [], '봄당 서재 folder');
    assertEqual(nvLib.papers.map((p) => p.id).sort(), [IDS.moral, state.upload.id].sort(), 'NV 서재 library.json');
    assertEqual(under(`${nvRoot}people/`), [`${nvRoot}people/${PID.nv}/papers/${IDS.moral}/ai.json`, `${nvRoot}people/${PID.nv}/papers/${IDS.moral}/annotations.json`], 'notes now NV\'s');
    assertEqual(teamJson(`${nvRoot}people/${PID.nv}/papers/${IDS.moral}/annotations.json`).items.filter((a) => !a.deleted).map((a) => a.color), ['yellow'], 'the moved highlight');
    assertEqual(await d1('SELECT code FROM codes WHERE code = ?', CODES.bom.code), [], '봄당 in D1');
    assertEqual(rows, [state.upload.title, TITLES.moral].sort(), 'NV 서재 list');
    assert(notes.marks >= 1 && notes.summary >= 3, `NV reader notes ${JSON.stringify(notes)}`);
    assertEqual(notes.colors, ['yellow'], 'NV sees the moved yellow highlight');
    return `dialog ${JSON.stringify(first.choices)} “${first.firstDesc}” → NV → “${chosen.danger}”; DELETE ${answer.search} → ${JSON.stringify(answer.body)}; commit “${newCommits[0].message}”; NV 서재 [${rows}], Moral: ${notes.marks} mark(s), 메모 ${JSON.stringify(notes.colors)}, 요약 ${notes.summary}`;
  });

  await step('owner: 삭제 ‘6기’ with ‘서재도 함께 삭제’ (default, 논문 1편) → codes/<6기>/ gone entirely in one commit; 전체 공용 서재 untouched; NV 서재 activity shows only the move', async () => {
    await op.waitForSelector(`#set-invites .relay-code[data-code="${CODES.six.code}"]`, { timeout: 15000 });
    const sixRootFiles = under(root(state.lib.six));
    const teamBefore = [...teamFiles()].filter(([p]) => !p.startsWith('codes/')).map(([p, f]) => `${p}@${f.sha}`).sort();
    await op.locator(`#set-invites .relay-code[data-code="${CODES.six.code}"] .relay-code-delete`).click();
    await op.waitForSelector('.relay-delete-dialog .relay-lib-choice');
    await op.waitForFunction(() => /논문 1편/.test(document.querySelector('.relay-delete-dialog .radio-card .radio-desc')?.textContent || ''), null, { timeout: 15000 });
    const choices = await op.$$eval('.relay-delete-dialog .radio-card', (els) => els.map((c) => `${c.querySelector('input').checked ? '●' : '○'} ${c.querySelector('.radio-title').textContent}`));
    const head = teamCommits()[0].sha;
    const del = op.waitForResponse((r) => r.request().method() === 'DELETE' && r.url().includes('/relay/admin/codes/'), { timeout: 90000 });
    await op.locator('.relay-delete-dialog .modal-footer .btn-danger', { hasText: '삭제' }).click();
    const res = await del;
    const answer = { status: res.status(), search: new URL(res.url()).search, body: await res.json() };
    await op.waitForSelector('.toast >> text=삭제했습니다.', { timeout: 20000 });
    await op.waitForFunction((c) => !document.querySelector(`#set-invites .relay-code[data-code="${c}"]`), CODES.six.code, { timeout: 15000 });
    const commits = teamCommits();
    const newCommits = commits.slice(0, commits.findIndex((c) => c.sha === head));
    const teamAfter = [...teamFiles()].filter(([p]) => !p.startsWith('codes/')).map(([p, f]) => `${p}@${f.sha}`).sort();
    const nvActivity = await activityApi('mine', CODES.nv.code);
    const nvRows = await activityRows(np, 'mine');
    await shot(np, 'code-libs-e2e-11-nv-activity');
    await openList(np, 'mine');
    await shot(op.locator('#set-invites'), 'code-libs-e2e-12-admin-after');
    assertEqual(choices, ['● 서재도 함께 삭제', '○ 다른 코드로 옮기기'], 'choices');
    assertEqual([answer.status, answer.search], [200, '?library=delete'], 'DELETE');
    assertEqual([answer.body.deleted, answer.body.library?.action, answer.body.library?.papers, answer.body.library?.files], [true, 'delete', 1, sixRootFiles.length], 'DELETE answer');
    assertEqual(under(root(state.lib.six)), [], 'codes/<6기>/');
    assert(![...teamFiles().keys()].some((p) => p.includes(state.lib.six)), 'any path with 6기\'s library id');
    assertEqual(newCommits.map((c) => [c.message, c.deleted.length]), [[`[관리자] {lib:${state.lib.six}} 코드 삭제로 서재 비움`, sixRootFiles.length]], 'one commit');
    assertEqual(teamAfter, teamBefore, '전체 공용 서재 files');
    assertEqual(nvActivity, ['관리자 삭제된 코드의 서재에서 논문 2편 옮겨 옴'], 'NV 서재 activity (API)');
    assert(nvRows.length === 1 && nvRows[0].startsWith('관리자') && nvRows[0].includes('옮겨 옴'), `NV 서재 rows ${JSON.stringify(nvRows)}`);
    assertEqual(await d1('SELECT code FROM codes WHERE code = ?', CODES.six.code), [], '6기 in D1');
    return `choices ${JSON.stringify(choices)}; DELETE ${answer.search} → ${JSON.stringify(answer.body)}; commit “${newCommits[0].message}” deleting ${sixRootFiles.length} files; root files unchanged; NV 서재 activity ${JSON.stringify(nvRows)}`;
  });

  await step('a code named like markup: it joins, and its sidebar and empty line show the name as text; NV sees its folder (markup and a library marker in the name) and its commit in 전체 공용 서재 as text; nothing runs, no marker in any answer', async () => {
    const NAME = '<img src=x onerror="window.__pwned=1">';
    const FOLDER = '<b onmouseover="window.__pwned=2">폴더</b>{lib:team}';
    const made = await worker('/relay/admin/codes', { admin: true, method: 'POST', body: { name: NAME } });
    assertEqual(made.status, 201, `new code: ${made.text}`);
    state.markupCode = made.body.code;
    const markup = await device('markup', { ip: IP.markup });
    people.push(markup);
    const xp = markup.page;
    await xp.goto(`${APP}/#/join/${made.body.code}`);
    await xp.waitForSelector('.library', { timeout: 30000 });
    await relayLibsReady(xp);
    await xp.waitForFunction(() => location.hash === '#/s/mine', null, { timeout: 15000 });
    const s = await sections(xp);
    const empty = (await xp.locator('.shared-intro.is-code').innerText()).replace(/\s+/g, ' ').trim();
    // This code adds a folder to 전체 공용 서재 through the Worker, as the app sends it (blob → tree → commit → ref).
    const base = '/shared/team/gh/repos/team/library';
    const code = made.body.code;
    const ref = await worker(`${base}/git/ref/heads/main`, { code, ip: IP.markup });
    const head = await worker(`${base}/git/commits/${ref.body.object.sha}`, { code, ip: IP.markup });
    const now = Date.now();
    const library = teamJson('library.json');
    library.folders.push({ id: 'f_markup01', name: FOLDER, parentId: null, createdAt: now, updatedAt: now });
    library.updatedAt = now;
    const blob = await worker(`${base}/git/blobs`, { code, ip: IP.markup, method: 'POST', body: { encoding: 'base64', content: Buffer.from(`${JSON.stringify(library, null, 2)}\n`).toString('base64') } });
    const tree = await worker(`${base}/git/trees`, { code, ip: IP.markup, method: 'POST', body: { base_tree: head.body.tree.sha, tree: [{ path: 'library.json', mode: '100644', type: 'blob', sha: blob.body.sha }] } });
    const commit = await worker(`${base}/git/commits`, { code, ip: IP.markup, method: 'POST', body: { message: `폴더 만듦 ‘${FOLDER}’`, tree: tree.body.sha, parents: [ref.body.object.sha] } });
    const moved = await worker(`${base}/git/refs/heads/main`, { code, ip: IP.markup, method: 'PATCH', body: { sha: commit.body.sha, force: false } });
    assertEqual([blob.status, tree.status, commit.status, moved.status], [201, 201, 201, 200], 'the folder commit');
    // The marker in the client's text is dropped (the Worker writes {lib:team} itself and never sends it).
    assertEqual(commit.body.message, `[${NAME}] 폴더 만듦 ‘<b onmouseover="window.__pwned=2">폴더</b> ’`, 'the commit as the app reads it');
    await np.goto('about:blank');
    await np.goto(`${APP}/#/s/team`);
    await relayLibsReady(np);
    const folderLabel = await waitFor(async () => (await sections(np)).find((x) => x.key === 'shared:team')?.folders.find((f) => f.startsWith('<b')), { timeout: 30000, what: 'the markup folder in NV\'s 전체 공용 서재' });
    const rows = await activityRows(np, 'team');
    await shot(np, 'code-libs-e2e-13-nv-markup-names');
    const ran = [await xp.evaluate(() => window.__pwned ?? null), await np.evaluate(() => window.__pwned ?? null)];
    const tags = [await xp.evaluate(() => document.querySelectorAll('img[src="x"], b[onmouseover]').length), await np.evaluate(() => document.querySelectorAll('img[src="x"], b[onmouseover]').length)];
    assertEqual(s.map((x) => [x.key, x.label]), [['shared:mine', `${NAME} 서재`], ['shared:team', TEAM_NAME]], 'sections (as text)');
    assert(empty.includes('이 초대 코드를 가진 사람만 볼 수 있어요.'), `empty state “${empty}”`);
    assertEqual(folderLabel.slice(0, folderLabel.lastIndexOf('=')), FOLDER, 'NV\'s folder label (as text)');
    assert(rows.some((r) => r.startsWith(NAME) && r.includes('폴더 만듦')), `NV's 전체 공용 서재 activity ${JSON.stringify(rows)}`);
    assertEqual(ran, [null, null], 'script from a name ran');
    assertEqual(tags, [0, 0], 'elements from a name');
    return `sidebar “${s[0].label}”; NV folder “${folderLabel}”; activity “${rows.find((r) => r.startsWith(NAME))}”; nothing ran (${JSON.stringify(ran)}), no elements made`;
  });

  await step('no console errors, page errors, CSP violations, native dialogs, escaped requests or {lib:} markers; no refusal from the Worker; no invite code ever reached GitHub', async () => {
    const statuses = people.flatMap((p) => p.log.filter((r) => r.path.startsWith('/shared')).map((r) => r.status));
    // (null / 'failed': still in flight when the two deleted codes' apps were closed.)
    const bad = people.flatMap((p) => p.log.filter((r) => r.path.startsWith('/shared') && ![200, 201, 304, 409, 422, 'failed', null].includes(r.status)).map((r) => `${p.name} ${r.method} ${r.path} ${r.status}`));
    const codes = [...Object.values(CODES).map((c) => c.code), state.markupCode].filter(Boolean).map((c) => c.replace(/-/g, ''));
    const seenByGitHub = (r) => `${r.path}${r.query}${JSON.stringify(r.headers)}${r.bytesIn < 200_000 ? r.body?.toString('latin1') ?? '' : ''}`.toUpperCase().replace(/-/g, '');
    const leaks = gh.log.filter((r) => codes.some((c) => seenByGitHub(r).includes(c)));
    assert(!problems.length, problems.join('\n'));
    assertEqual(bad, [], 'refused /shared requests');
    assertEqual(leaks.length, 0, 'GitHub requests carrying an invite code');
    const count = (s) => statuses.filter((x) => x === s).length;
    return `0 problems; ${statuses.length} /shared requests (200 ×${count(200)}, 201 ×${count(201)}, 304 ×${count(304)}, 409 ×${count(409)}, 422 ×${count(422)}); ${expectedRefusals.length} expected refusals logged by the browsers; ${gh.log.length} GitHub requests, none with a code; ${fake.calls.length} upstream calls`;
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
  console.log(`\ncode-libs e2e: ${passed}/${results.length} passed${failed.length ? ` — FAILED: ${failed.map((f) => f.name).join(' | ')}` : ''}${skipped.length ? ` (${skipped.length} skipped)` : ''}`);
  process.exitCode = failed.length || skipped.length ? 1 : 0;
}
