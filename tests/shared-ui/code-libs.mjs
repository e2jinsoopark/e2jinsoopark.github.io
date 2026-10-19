// 코드별 서재 (one library per invite code, docs/CODE-LIBRARIES.md) — the UI end to end in Edge with the real
// app and the real store:
//   node tests/shared-ui/code-libs.mjs [--headed]     (starts `python -m http.server 8242` if nothing is listening)
//
// The relay is route-intercepted at https://relay.test:
// - /shared, /shared/<lib>/activity, /shared/<lib>/gh/... → tests/store/fake-relay.mjs with `codeLibraries: true`
//   (GET /shared → [<name> 서재 (mine, kind code), 전체 공용 서재 (team)] + libraryId; /shared/mine/gh works in the repo
//   folder codes/<libraryId>/) in front of tests/store/fake-github.mjs;
// - /relay/me and the admin API the UI calls (GET /relay/admin/codes, GET/PATCH /relay/admin/codes/:code/library,
//   DELETE /relay/admin/codes/:code?library=delete|move&to=, POST /relay/admin/shared/team/split-by-uploader) are answered
//   HERE, as the contract describes them, by server-side commits on the fake team repo. The real Worker is the relay
//   builder's (relay/test); this test is about the app.
// The team repo starts as production does today: codes NV, 6기, 봄당 (active), 봄당테스트 (stopped), 관리자 비교테스트;
// 전체 공용 서재 with folder ‘찬영’ and three papers — ‘Lessons in biostatistics’ (봄당테스트, in the 휴지통), ‘Moral
// Sensitivity in Psychiatric Practice’ (봄당, top level, with 봄당's ai.json + annotations.json) and ‘Procedures
// Performed by Advanced Practice Provider’ (6기, in ‘찬영’, with 6기's ai.json).
// index.html is served as a TEST COPY whose CSP connect-src also lists https://relay.test. AI is the offline mock
// (?mock=1). Fixture PDFs are read from C:/Users/dindoo/Projects/pr-fixtures. Any console error, page error, CSP
// violation, native dialog or request outside the app fails the run. No paid API, no real relay, no real GitHub.
// Results + screenshots: C:/Users/dindoo/Projects/pr-tools/out/code-libs/.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'file:///C:/Users/dindoo/Projects/pr-tools/node_modules/playwright/index.mjs';
import { routeGitHubToFake, startFakeGitHub } from '../store/fake-github.mjs';
import { startFakeRelay } from '../store/fake-relay.mjs';

const PORT = 8242;
const ORIGIN = `http://localhost:${PORT}`;
const APP = `${ORIGIN}/index.html?mock=1`;
const OUT = 'C:/Users/dindoo/Projects/pr-tools/out/code-libs';
const FIXTURES = 'C:/Users/dindoo/Projects/pr-fixtures';
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const RELAY_URL = 'https://relay.test';
const SETTINGS_KEY = 'pr.settings.v1';
const UI_KEY = 'pr.ui.v1';
const SHARED_CACHE_KEY = 'pr.shared.v1';
const ADMIN_TOKEN = 'admin-token-for-tests-0123456789';
const TEAM = { owner: 'dindoopark', repo: 'paper-team-library', token: 'ghp_team_test_token' };
const MINE = { owner: 'owner-me', repo: 'paper-library', token: 'ghp_owner_test_token' };
const TEAM_NAME = '전체 공용 서재';
const CODE_MAX_BYTES = 500_000_000; // the Worker's default (CODE_LIBRARY_MAX_BYTES)
const DAY = 86_400_000;
const HEADED = process.argv.includes('--headed');
// Production today (2026-10-19): five codes, one stopped. The owner uses ‘관리자 비교테스트’ on their own device.
const CODES = {
  nv: { code: 'PR-NV2K-7M4Q', name: 'NV' },
  six: { code: 'PR-6G1K-3T8W', name: '6기' },
  bom: { code: 'PR-B0MD-4NG5', name: '봄당' },
  bomTest: { code: 'PR-B0MT-5ST6', name: '봄당테스트', active: false },
  admin: { code: 'PR-ADM1-N7XZ', name: '관리자 비교테스트' },
};
const TITLES = {
  lessons: 'Lessons in biostatistics',
  moral: 'Moral Sensitivity in Psychiatric Practice',
  proc: 'Procedures Performed by Advanced Practice Provider',
};

mkdirSync(OUT, { recursive: true });
const results = [];
const problems = [];
const refusals = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function assert(cond, msg) { if (!cond) throw new Error(msg); }
function assertEqual(actual, expected, what) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${what}: expected ${e}, got ${a}`);
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
const relay = await startFakeRelay({
  github, owner: TEAM.owner, repo: TEAM.repo, token: TEAM.token, lib: 'team', libName: TEAM_NAME, codeLibraries: true, codeMaxBytes: CODE_MAX_BYTES,
});

/** The Worker's view of the codes (D1): code → { code, name, active, personId, libraryId, createdAt }. */
const registry = new Map();
for (const c of Object.values(CODES)) {
  const personId = relay.addCode(c.code, c.name, { active: c.active !== false });
  registry.set(c.code, { code: c.code, name: c.name, active: c.active !== false, personId, libraryId: relay.libraryIdOf(c.code), createdAt: Date.now() - 20 * DAY });
}
const P = (k) => registry.get(CODES[k].code).personId;
const L = (k) => registry.get(CODES[k].code).libraryId;

const teamFiles = () => github.files(TEAM.owner, TEAM.repo);
const readBuf = (path) => github.readFile(TEAM.owner, TEAM.repo, path);
const readJson = (path) => {
  const b = readBuf(path);
  return b ? JSON.parse(b.toString('utf8')) : null;
};
const commitTeam = (files, message) => github.commitFiles(TEAM.owner, TEAM.repo, files, { message });
const fixture = (name) => `${FIXTURES}/${name}.pdf`;
const pdfBytes = (name) => readFileSync(fixture(name));
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

// ---------------------------------------------------------------- seed (production shape)

const T0 = Date.now() - 6 * DAY;
function paperRecord(id, title, addedBy, folderId, bytes, extra = {}) {
  return {
    id, title, authors: '', year: 2024, fileName: `${id}.pdf`, size: bytes.length, pages: 1, folderId, starred: false,
    addedAt: T0, updatedAt: T0, lastOpenedAt: null, translatedCount: 0, sentenceCount: 0, sha256: sha256(bytes), addedBy, ...extra,
  };
}
const seedPdfs = { p_lessons: pdfBytes('simwright2005'), p_moral: pdfBytes('lu2025'), p_proc: pdfBytes('kiekkas2012') };
const teamLibrary = {
  version: 1,
  updatedAt: T0 + DAY,
  folders: [{ id: 'f_chanyeong', name: '찬영', parentId: null, createdAt: T0, updatedAt: T0 }],
  papers: [
    paperRecord('p_lessons', TITLES.lessons, '봄당테스트', null, seedPdfs.p_lessons, { deleted: true, deletedAt: T0 + DAY, deletedBy: '봄당테스트', updatedAt: T0 + DAY }),
    paperRecord('p_moral', TITLES.moral, '봄당', null, seedPdfs.p_moral),
    paperRecord('p_proc', TITLES.proc, '6기', 'f_chanyeong', seedPdfs.p_proc),
  ],
};
const json = (o) => JSON.stringify(o, null, 2);
commitTeam({
  'library.json': json(teamLibrary),
  'papers/p_lessons/paper.pdf': seedPdfs.p_lessons,
  'papers/p_moral/paper.pdf': seedPdfs.p_moral,
  'papers/p_moral/translation.json': json({ version: 1, targetLang: 'ko', items: {} }),
  'papers/p_proc/paper.pdf': seedPdfs.p_proc,
  [`people/${P('bom')}/papers/p_moral/ai.json`]: json({ version: 1, updatedAt: T0, summary: { text: '봄당의 요약', createdAt: T0 } }),
  [`people/${P('bom')}/papers/p_moral/annotations.json`]: json({ version: 1, updatedAt: T0, items: [] }),
  [`people/${P('six')}/papers/p_proc/ai.json`]: json({ version: 1, updatedAt: T0, summary: { text: '6기의 요약', createdAt: T0 } }),
}, '[봄당] {lib:team} 논문 추가 ‘Moral Sensitivity in Psychiatric Practice’');

// ---------------------------------------------------------------- the admin API (contract), on the fake repo

const adminCalls = [];
const LIB_FILE = /^papers\/([A-Za-z0-9_-]{1,64})\/(paper\.pdf|translation\.json)$/;
const emptyLibrary = () => ({ version: 1, updatedAt: Date.now(), folders: [], papers: [] });
let idSeq = 0;
const newId = (prefix) => `${prefix}_moved${(++idSeq).toString(36)}${Date.now().toString(36).slice(-4)}`;

/** GET /relay/admin/codes/<code>/library (as the Worker answers it). */
function codeLibraryReport(row) {
  const root = `codes/${row.libraryId}/`;
  let bytes = 0;
  let files = 0;
  for (const [path] of teamFiles()) if (path.startsWith(root)) { bytes += readBuf(path)?.length || 0; files++; }
  const lib = readJson(`${root}library.json`);
  const papers = lib?.papers || [];
  return {
    code: row.code, name: row.name, libraryId: row.libraryId, papers: papers.filter((p) => !p.deleted).length,
    trashed: papers.filter((p) => p.deleted).length, files, bytes, maxBytes: row.maxBytes ?? CODE_MAX_BYTES,
  };
}

function listCodes() {
  const codes = [...registry.values()].map((r) => ({
    code: r.code, name: r.name, active: r.active, allowedModels: ['claude-haiku-5-5'], dailyLimitUsd: 0.5,
    createdAt: new Date(r.createdAt).toISOString(), lastUsedAt: null, todayUsd: 0, monthUsd: 0, totalUsd: 0, totalRequests: 0,
  }));
  return { codes, todayTotalUsd: 0, monthTotalUsd: 0, globalDailyLimitUsd: 5, deletedUsage: { todayUsd: 0, monthUsd: 0, totalUsd: 0, totalRequests: 0 } };
}

/** Names of the folder chain of `folderId` (root first), through deleted folders too. */
function folderChain(lib, folderId) {
  const byId = new Map((lib.folders || []).map((f) => [f.id, f]));
  const out = [];
  const seen = new Set();
  let f = folderId ? byId.get(folderId) : null;
  while (f && !seen.has(f.id)) { seen.add(f.id); out.unshift(f); f = f.parentId ? byId.get(f.parentId) : null; }
  return out;
}

/** POST /relay/admin/shared/team/split-by-uploader { dryRun } (docs/CODE-LIBRARIES.md §5). */
function splitByUploader(dryRun) {
  const lib = readJson('library.json') || emptyLibrary();
  const byName = new Map();
  for (const r of registry.values()) byName.set(r.name, [...(byName.get(r.name) || []), r]);
  const moves = [];
  const skipped = [];
  for (const p of lib.papers) {
    const owners = byName.get(p.addedBy || '') || [];
    if (p.deleted) skipped.push({ paperId: p.id, title: p.title, reason: '휴지통에 있음' });
    else if (!p.addedBy) skipped.push({ paperId: p.id, title: p.title, reason: '올린 사람 기록 없음' });
    else if (owners.length > 1) skipped.push({ paperId: p.id, title: p.title, reason: '같은 이름의 코드가 여러 개' });
    else if (!owners.length) skipped.push({ paperId: p.id, title: p.title, reason: '같은 이름의 코드 없음' });
    else moves.push({ paperId: p.id, title: p.title, toCode: owners[0].name, folderPath: folderChain(lib, p.folderId).map((f) => f.name).join(' / '), row: owners[0] });
  }
  const plan = { moves: moves.map(({ row, ...m }) => m), skipped };
  if (dryRun || !moves.length) return plan;
  const files = {};
  const now = Date.now();
  const touched = new Map(); // libraryId → its library.json (being built)
  const moved = new Set();
  for (const m of moves) {
    const root = `codes/${m.row.libraryId}/`;
    const target = touched.get(m.row.libraryId) || readJson(`${root}library.json`) || emptyLibrary();
    touched.set(m.row.libraryId, target);
    // Recreate the folder path (names and nesting), reusing a live folder of the same name in the same place.
    let parentId = null;
    for (const f of folderChain(lib, lib.papers.find((p) => p.id === m.paperId).folderId)) {
      const same = target.folders.find((x) => !x.deleted && (x.parentId ?? null) === parentId && x.name === f.name);
      const id = same ? same.id : (target.folders.some((x) => x.id === f.id) ? newId('f') : f.id);
      if (!same) target.folders.push({ id, name: f.name, parentId, createdAt: now, updatedAt: now });
      parentId = id;
    }
    const record = lib.papers.find((p) => p.id === m.paperId);
    target.papers.push({ ...record, folderId: parentId, updatedAt: now });
    for (const [path] of teamFiles()) {
      const own = path.startsWith(`papers/${m.paperId}/`) && LIB_FILE.test(path);
      const notes = path.startsWith(`people/${m.row.personId}/papers/${m.paperId}/`);
      if (!own && !notes) continue;
      files[`${root}${path}`] = readBuf(path);
      files[path] = null;
    }
    moved.add(m.paperId);
  }
  for (const [libraryId, target] of touched) {
    target.updatedAt = now;
    files[`codes/${libraryId}/library.json`] = json(target);
  }
  // The records leave 전체 공용 서재 (a move, not a tombstone); folders left empty go to the 휴지통.
  const onPath = new Set(moves.flatMap((m) => folderChain(lib, lib.papers.find((p) => p.id === m.paperId)?.folderId).map((f) => f.id)));
  lib.papers = lib.papers.filter((p) => !moved.has(p.id));
  const live = (f) => !f.deleted;
  let changed = true;
  while (changed) {
    changed = false;
    for (const f of lib.folders.filter(live)) {
      const hasPaper = lib.papers.some((p) => !p.deleted && p.folderId === f.id);
      const hasChild = lib.folders.some((x) => live(x) && x.parentId === f.id);
      if (!hasPaper && !hasChild && onPath.has(f.id)) {
        Object.assign(f, { deleted: true, deletedAt: now, deletedBy: '관리자', updatedAt: now });
        changed = true;
      }
    }
  }
  lib.updatedAt = now;
  files['library.json'] = json(lib);
  const commitSha = commitTeam(files, '[관리자] {lib:team} 올린 사람의 코드 서재로 나누기');
  return { ...plan, commitSha };
}

/** DELETE /relay/admin/codes/:code?library=delete|move&to=<code> (docs/CODE-LIBRARIES.md §4). */
function deleteCode(codeRaw, params) {
  const row = [...registry.values()].find((r) => r.code.replace(/-/g, '') === String(codeRaw).toUpperCase().replace(/-/g, ''));
  if (!row) return { status: 404, body: { type: 'error', error: { type: 'not_found_error', message: '초대 코드를 찾을 수 없습니다.' } } };
  const mode = params.get('library') || 'delete';
  const to = mode === 'move' ? [...registry.values()].find((r) => r.code === params.get('to') && r !== row) : null;
  if (mode === 'move' && !to) return { status: 400, body: { type: 'error', error: { type: 'invalid_request_error', message: '서재를 옮길 코드를 찾을 수 없습니다.' } } };
  const root = `codes/${row.libraryId}/`;
  const files = {};
  let movedPapers = 0;
  if (to) {
    const dst = `codes/${to.libraryId}/`;
    const src = readJson(`${root}library.json`) || emptyLibrary();
    const target = readJson(`${dst}library.json`) || emptyLibrary();
    const taken = new Set([...target.folders, ...target.papers].map((x) => x.id));
    const remap = new Map();
    for (const x of [...src.folders, ...src.papers]) remap.set(x.id, taken.has(x.id) ? newId(x.id.startsWith('f') ? 'f' : 'p') : x.id);
    for (const f of src.folders) target.folders.push({ ...f, id: remap.get(f.id), parentId: f.parentId ? remap.get(f.parentId) ?? null : null });
    for (const p of src.papers) target.papers.push({ ...p, id: remap.get(p.id), folderId: p.folderId ? remap.get(p.folderId) ?? null : null });
    movedPapers = src.papers.filter((p) => !p.deleted).length;
    for (const [path] of teamFiles()) {
      if (!path.startsWith(root) || path === `${root}library.json`) continue;
      const inner = path.slice(root.length);
      let m = /^papers\/([^/]+)\/(.+)$/.exec(inner);
      if (m) files[`${dst}papers/${remap.get(m[1]) || m[1]}/${m[2]}`] = readBuf(path);
      m = new RegExp(`^people/${row.personId}/papers/([^/]+)/(.+)$`).exec(inner);
      if (m) files[`${dst}people/${to.personId}/papers/${remap.get(m[1]) || m[1]}/${m[2]}`] = readBuf(path);
    }
    target.updatedAt = Date.now();
    files[`${dst}library.json`] = json(target);
  }
  let purgedFiles = 0;
  for (const [path] of teamFiles()) {
    if (path.startsWith(root)) files[path] = null;
    if (path.startsWith(`people/${row.personId}/`)) { files[path] = null; purgedFiles++; }
  }
  if (Object.keys(files).length) commitTeam(files, `[관리자] {lib:${to ? to.libraryId : 'team'}} 초대 코드 삭제에 따라 ${to ? '서재 옮김' : '서재 정리'}`);
  registry.delete(row.code);
  relay.setActive(row.code, false); // gone for every endpoint
  return { status: 200, body: { deleted: true, purgedFiles, library: { action: to ? 'move' : 'delete', papers: movedPapers, files: Object.keys(files).length } } };
}

async function relayRoute(route) {
  const req = route.request();
  const url = new URL(req.url());
  const cors = {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': req.headers()['access-control-request-headers'] || 'authorization, content-type',
    'access-control-allow-methods': 'GET, POST, PATCH, PUT, DELETE, OPTIONS',
    'access-control-expose-headers': 'ETag, Retry-After',
  };
  if (url.pathname.startsWith('/shared')) {
    try {
      const response = await route.fetch({ url: `${relay.url}${url.pathname}${url.search}` });
      return route.fulfill({ response });
    } catch {
      return route.abort('connectionfailed').catch(() => {});
    }
  }
  if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
  const reply = (status, body) => route.fulfill({ status, headers: cors, contentType: 'application/json', body: JSON.stringify(body) });
  const auth = /^Bearer (.+)$/.exec(req.headers().authorization || '')?.[1] || req.headers()['x-api-key'] || '';
  if (url.pathname === '/relay/me') {
    const row = [...registry.values()].find((r) => r.active && r.code.replace(/-/g, '') === auth.toUpperCase().replace(/-/g, ''));
    if (!row) return reply(401, { type: 'error', error: { type: 'authentication_error', message: '초대 코드가 올바르지 않거나 사용이 중지되었습니다.' } });
    return reply(200, { name: row.name, allowedModels: ['claude-haiku-5-5'], dailyLimitUsd: 0.5, todayUsd: 0, todayRequests: 0, resetsAt: new Date(Date.now() + DAY).toISOString() });
  }
  if (!url.pathname.startsWith('/relay/admin/')) return reply(404, { type: 'error', error: { type: 'not_found_error', message: '요청한 주소를 찾을 수 없습니다.' } });
  let body = null;
  try { body = req.postData() ? JSON.parse(req.postData()) : null; } catch { body = null; }
  adminCalls.push({ method: req.method(), path: url.pathname, search: url.search, body, auth });
  if (auth !== ADMIN_TOKEN) return reply(401, { type: 'error', error: { type: 'authentication_error', message: '관리자 토큰이 올바르지 않습니다.' } });
  if (url.pathname === '/relay/admin/codes' && req.method() === 'GET') return reply(200, listCodes());
  const lib = /^\/relay\/admin\/codes\/([^/]+)\/library$/.exec(url.pathname);
  if (lib) {
    const row = [...registry.values()].find((r) => r.code === decodeURIComponent(lib[1]));
    if (!row) return reply(404, { type: 'error', error: { type: 'not_found_error', message: '초대 코드를 찾을 수 없습니다.' } });
    if (req.method() === 'GET') return reply(200, codeLibraryReport(row));
    if (req.method() === 'PATCH') {
      const max = body?.maxBytes;
      if (!(max === null || (Number.isInteger(max) && max >= 1_000_000 && max <= 100_000_000_000))) {
        return reply(400, { type: 'error', error: { type: 'invalid_request_error', message: '서재 용량(maxBytes)이 올바르지 않습니다.' } });
      }
      row.maxBytes = max;
      return reply(200, { code: row.code, name: row.name, libraryId: row.libraryId, maxBytes: max ?? CODE_MAX_BYTES });
    }
  }
  const del = /^\/relay\/admin\/codes\/([^/]+)$/.exec(url.pathname);
  if (del && req.method() === 'DELETE') {
    const r = deleteCode(decodeURIComponent(del[1]), url.searchParams);
    return reply(r.status, r.body);
  }
  if (url.pathname === '/relay/admin/shared/team/split-by-uploader' && req.method() === 'POST') {
    return reply(200, splitByUploader(body?.dryRun !== false));
  }
  if (url.pathname === '/relay/admin/shared/team/stats' && req.method() === 'GET') {
    const lib = readJson('library.json');
    return reply(200, { bytes: 1, papers: (lib?.papers || []).filter((p) => !p.deleted).length, people: 2, maxBytes: 4_000_000_000 });
  }
  return reply(404, { type: 'error', error: { type: 'not_found_error', message: '요청한 주소를 찾을 수 없습니다.' } });
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
  headless: !HEADED,
  args: ['--host-resolver-rules=MAP api.github.com 127.0.0.1, MAP *.github.com 127.0.0.1, MAP relay.test 127.0.0.1'],
});

/** The remembered GET /shared answer's fingerprint (js/app.js fingerprint()). */
const fingerprintOf = (code) => createHash('sha256').update(`pr-shared\n${RELAY_URL}\n${code}`).digest().subarray(0, 12).toString('hex');

/** One browser context = one person's device. `storage`: extra localStorage entries set before the first load. */
async function device(name, seed, { viewport = { width: 1440, height: 900 }, storage = {} } = {}) {
  const ctx = await browser.newContext({ locale: 'ko-KR', viewport, colorScheme: 'light' });
  const external = [];
  await ctx.route(new RegExp(`^https?:\\/\\/(?!localhost:${PORT}\\/)`), (route) => {
    const url = route.request().url();
    if (url.startsWith('https://cdn.jsdelivr.net/gh/orioncactus/pretendard')) {
      return route.fulfill({ status: 200, contentType: 'text/css', body: '/* font stub (offline test) */' });
    }
    external.push(url);
    problems.push(`${name}: external request blocked ${url}`);
    return route.abort();
  });
  await routeGitHubToFake(ctx, github.url);
  await ctx.route(`${RELAY_URL}/**`, relayRoute);
  await ctx.route(new RegExp(`^http:\\/\\/localhost:${PORT}\\/index\\.html(?:\\?.*)?$`), (route) => route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: INDEX }));
  await ctx.addInitScript(({ key, seed, storage }) => {
    try {
      if (seed && !localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify(seed));
      for (const [k, v] of Object.entries(storage)) if (!localStorage.getItem(k)) localStorage.setItem(k, JSON.stringify(v));
    } catch { /* blocked */ }
    document.addEventListener('securitypolicyviolation', (e) => console.error(`[csp] ${e.violatedDirective} blocked ${e.blockedURI}`));
    for (const fn of ['alert', 'confirm', 'prompt']) window[fn] = () => { console.error(`[native ${fn}]`); return null; };
  }, { key: SETTINGS_KEY, seed, storage });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => problems.push(`${name}: pageerror ${e.message}`));
  page.on('dialog', (d) => { problems.push(`${name}: native dialog ${d.type()}`); d.dismiss().catch(() => {}); });
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const text = m.text();
    const where = String(m.location()?.url || '');
    // Conflicts the app expects while several people push (409/422 → re-pull, merge, retry).
    if (/^Failed to load resource/.test(text) && (where.startsWith(RELAY_URL) || where.startsWith('https://api.github.com'))) {
      refusals.push(`${name}: ${text} ${where.replace(/\?.*$/, '')}`);
      return;
    }
    problems.push(`${name}: console.error ${text}`);
  });
  return { name, ctx, page, external };
}

const shot = (target, file, opts = {}) => target.screenshot({ path: `${OUT}/${file}.png`, ...opts });
const hashOf = (page) => page.evaluate(() => location.hash);
const sec = (page, key) => page.locator(`.lib-sec[data-lib="${key}"]`);
const rowTitles = (page) => page.$$eval('.paper-row .paper-title', (els) => els.map((e) => e.textContent.trim()));

async function booted(page) {
  await page.waitForFunction(() => document.querySelector('.library, .reader, .settings, .message-screen'), null, { timeout: 30000 });
}

/** Both libraries behind the relay have opened (their trees are shown). */
async function relayLibsReady(page) {
  await page.waitForSelector('.lib-sec[data-lib="shared:mine"] .lib-sec-body .lib-nav-heading', { timeout: 30000 });
  await page.waitForSelector('.lib-sec[data-lib="shared:team"] .lib-sec-body .lib-nav-heading', { timeout: 30000 });
}

/** Sidebar sections as data. */
const sections = (page) => page.$$eval('.lib-sec', (els) => els.map((s) => ({
  key: s.dataset.lib,
  label: s.querySelector('.lib-sec-label')?.textContent,
  icon: [...(s.querySelector('.lib-sec-toggle')?.querySelectorAll('svg') || [])].map((g) => g.getAttribute('class')).find((c) => !/lib-sec-chevron/.test(c)) || '',
  all: s.querySelector('.tree-item .tree-count')?.textContent ?? null,
  folders: [...s.querySelectorAll('.tree-item.is-folder')].map((x) => `${x.querySelector('.tree-label').textContent}=${x.querySelector('.tree-count').textContent}`),
  chip: s.querySelector('.lib-sec-sync')?.getAttribute('aria-label') || '',
  extras: [...s.querySelectorAll('.lib-nav-extra .tree-label')].map((x) => x.textContent),
  current: s.classList.contains('is-current'),
})));

/** Click a section's sync chip and wait until it is not busy. */
async function syncSection(page, key) {
  await page.locator(`.lib-sec-sync[data-lib="${key}"]`).click();
  await page.waitForFunction((k) => {
    const c = document.querySelector(`.lib-sec-sync[data-lib="${k}"]`);
    return c && !c.classList.contains('is-busy');
  }, key, { timeout: 20000 });
}

async function uploadFiles(page, names) {
  await page.setInputFiles('input[type=file]', names.map(fixture));
  await page.waitForFunction(() => [...document.querySelectorAll('.toast')].some((t) => /추가했습니다/.test(t.textContent)), null, { timeout: 60000 });
}

async function openAdmin(page) {
  await page.goto(`${APP}#/`); // a fresh settings view (its admin panel starts closed)
  await page.waitForSelector('.library');
  await page.goto(`${APP}#/settings/invites`);
  await page.locator('#set-invites summary', { hasText: '관리 화면 열기' }).click();
  await page.waitForSelector('#set-invites .relay-code[data-code]', { timeout: 20000 });
}

const seeds = {
  owner: {
    github: { owner: MINE.owner, repo: MINE.repo, branch: 'main', token: MINE.token },
    relay: { url: RELAY_URL, code: CODES.admin.code, name: CODES.admin.name, adminToken: ADMIN_TOKEN },
  },
  invitee: (k) => ({ provider: 'relay', relay: { url: RELAY_URL, code: CODES[k].code, name: CODES[k].name, allowedModels: ['claude-haiku-5-5'] } }),
};
const ids = {};

// ===================================================================== tests

try {
  const O = await device('owner', seeds.owner);
  const op = O.page;

  await test('owner: three sections in order — 내 서재, ‘관리자 비교테스트 서재’, 전체 공용 서재 — each with tree, counts, sync chip, 휴지통 (+ 최근 활동)', async () => {
    await op.goto(`${APP}#/`);
    await booted(op);
    await relayLibsReady(op);
    assert(await hashOf(op) === '#/', `owner home is 내 서재, got ${await hashOf(op)}`);
    await uploadFiles(op, ['cohen1960']);
    await op.waitForFunction(() => document.querySelectorAll('.paper-row').length === 1, null, { timeout: 60000 });
    ids.cohenTitle = (await op.locator('.paper-row .paper-title').first().textContent()).trim();
    await sec(op, 'shared:team').locator('.tree-item', { hasText: '전체' }).click();
    await op.waitForFunction(() => location.hash === '#/s/team' && document.querySelectorAll('.paper-row').length === 2, null, { timeout: 30000 });
    const teamRows = await rowTitles(op);
    await sec(op, 'mine').locator('.tree-item', { hasText: '전체' }).click();
    await op.waitForFunction(() => location.hash === '#/');
    await op.waitForFunction(() => {
      const chips = [...document.querySelectorAll('.lib-sec-sync')];
      return chips.length === 3 && chips.every((c) => /동기화 완료/.test(c.getAttribute('aria-label') || ''));
    }, null, { timeout: 30000 });
    const s = await sections(op);
    await shot(op, 'owner-sidebar');
    assertEqual(s.map((x) => x.key), ['mine', 'shared:mine', 'shared:team'], 'section order');
    assertEqual(s.map((x) => x.label), ['내 서재', `${CODES.admin.name} 서재`, TEAM_NAME], 'labels');
    assert(/icon-library/.test(s[0].icon) && /icon-lock/.test(s[1].icon) && /icon-users/.test(s[2].icon), `icons ${s.map((x) => x.icon)}`);
    assertEqual(s.map((x) => x.all), ['1', '0', '2'], 'counts (전체)');
    assertEqual(s.map((x) => x.folders), [[], [], ['찬영=1']], 'trees');
    assertEqual(s.map((x) => x.extras), [['휴지통'], ['최근 활동', '휴지통'], ['최근 활동', '휴지통']], 'extras');
    assert(s.every((x) => /동기화 완료/.test(x.chip)), `chips ${s.map((x) => x.chip)}`);
    assert(teamRows.includes(TITLES.moral) && teamRows.includes(TITLES.proc) && !teamRows.includes(TITLES.lessons), `team rows ${teamRows}`);
    return s.map((x) => `${x.label}(${x.icon.replace(/^icon /, '')}, 전체 ${x.all}, 폴더 [${x.folders}], ${x.extras.join('/')}, “${x.chip}”)`).join(' | ');
  });

  await test('owner: ‘다른 서재로 복사…’ lists the other libraries; a 내 서재 paper goes into the code library only (codes/<libraryId>/)', async () => {
    const row = op.locator('.paper-row').first();
    ids.cohenMine = await row.getAttribute('data-id');
    await row.locator('button[aria-label="논문 메뉴"]').click();
    const menu = await op.$$eval('.menu .menu-item', (els) => els.map((e) => e.textContent.trim()));
    await op.locator('.menu .menu-item', { hasText: '다른 서재로 복사…' }).click();
    await op.waitForSelector('.copy-dialog .folder-picker');
    const read = () => op.evaluate(() => ({
      title: document.querySelector('.copy-dialog .modal-title')?.textContent,
      targets: [...document.querySelectorAll('.copy-dialog .copy-libs .btn')].map((b) => ({ label: b.textContent.trim(), lib: b.dataset.lib, pressed: b.getAttribute('aria-pressed') })),
      root: document.querySelector('.copy-dialog .folder-picker .menu-label')?.textContent,
      note: document.querySelector('.copy-dialog .note')?.textContent.trim(),
    }));
    const first = await read();
    await op.locator('.copy-dialog .copy-libs .btn', { hasText: TEAM_NAME }).click();
    const team = await read();
    await op.locator('.copy-dialog .copy-libs .btn', { hasText: `${CODES.admin.name} 서재` }).click();
    const back = await read();
    await shot(op.locator('.copy-dialog'), 'copy-picker');
    await shot(op, 'copy-picker-page');
    await op.locator('.copy-dialog .modal-footer .btn', { hasText: '복사' }).click();
    await op.waitForFunction((name) => [...document.querySelectorAll('.toast')].some((t) => t.textContent.includes(`${name} 서재 최상위에 복사했습니다`)), CODES.admin.name, { timeout: 30000 });
    const toastText = (await op.locator('.toast', { hasText: '복사했습니다' }).last().textContent()).replace(/\s+/g, ' ').trim();
    await op.locator('.toast .btn', { hasText: '보기' }).last().click();
    await op.waitForFunction(() => location.hash === '#/s/mine' && document.querySelectorAll('.paper-row').length === 1, null, { timeout: 10000 });
    const root = `codes/${L('admin')}/`;
    await waitFor(() => (readJson(`${root}library.json`)?.papers || []).length === 1, 30000, 'the copy pushed into codes/<libraryId>/');
    const copied = readJson(`${root}library.json`).papers[0];
    const files = [...teamFiles().keys()];
    const commits = github.commits(TEAM.owner, TEAM.repo).map((c) => c.message.split('\n')[0]);
    assertEqual(first.targets.map((t) => [t.label, t.lib, t.pressed]), [[`${CODES.admin.name} 서재`, 'shared:mine', 'true'], [TEAM_NAME, 'shared:team', 'false']], 'targets (the code library first)');
    assert(first.title === '다른 서재로 복사' && menu.includes('다른 서재로 복사…'), `title ${first.title}; menu ${menu}`);
    assert(first.root === `${CODES.admin.name} 서재 (최상위)` && /이 초대 코드를 가진 사람만/.test(first.note), JSON.stringify(first));
    assert(team.root === `${TEAM_NAME} (최상위)` && /전체 공용 서재의 모든 사람/.test(team.note) && team.targets[1].pressed === 'true', JSON.stringify(team));
    assert(back.targets[0].pressed === 'true' && /하이라이트·메모·AI 결과는 복사되지 않/.test(back.note), JSON.stringify(back));
    assert(files.includes(`${root}papers/${copied.id}/paper.pdf`) && !files.includes(`papers/${copied.id}/paper.pdf`), `files ${files.filter((f) => f.includes(copied.id))}`);
    assert(!files.some((f) => f.startsWith(`${root}people/`)), 'personal files copied');
    assert(commits.some((m) => m.startsWith(`[${CODES.admin.name}] {lib:${L('admin')}}`)), `commits ${commits.slice(0, 3)}`);
    ids.copied = copied.id;
    return `targets [${first.targets.map((t) => `${t.label}${t.pressed === 'true' ? '✓' : ''}`).join(', ')}]; root “${first.root}”; note “${first.note}” → (전체 공용 서재) “${team.note}”; toast “${toastText}”; → #/s/mine; repo ${root}papers/${copied.id}/paper.pdf, commit “${commits[0]}”`;
  });

  // ------------------------------------------------------------------ invitee 봄당
  const B = await device('bomdang', seeds.invitee('bom'));
  const bp = B.page;

  await test('invitee 봄당: #/ opens ‘봄당 서재’ (empty: one line) then 전체 공용 서재; no 내 서재; the owner’s code library is not there', async () => {
    await bp.goto(`${APP}#/`);
    await booted(bp);
    await relayLibsReady(bp);
    await bp.waitForFunction(() => location.hash === '#/s/mine', null, { timeout: 10000 });
    await bp.waitForFunction(() => document.querySelectorAll('.lib-sec-sync.is-ok').length === 2, null, { timeout: 30000 });
    const s = await sections(bp);
    const empty = await bp.evaluate(() => ({
      title: document.querySelector('.shared-intro h2')?.textContent,
      lines: [...document.querySelectorAll('.shared-intro .onboarding-hero p')].map((p) => p.textContent),
      facts: document.querySelectorAll('.shared-intro .shared-facts li').length,
      dropzone: Boolean(document.querySelector('.shared-intro .dropzone')),
      crumbs: document.querySelector('.lib-crumbs').textContent,
    }));
    await shot(bp, 'invitee-sidebar');
    assertEqual(s.map((x) => [x.key, x.label, x.current]), [['shared:mine', '봄당 서재', true], ['shared:team', TEAM_NAME, false]], 'sections');
    assertEqual(s.map((x) => x.all), ['0', '2'], 'counts');
    assertEqual(empty.lines, ['이 초대 코드를 가진 사람만 볼 수 있어요.'], 'empty state: one line');
    assert(empty.title === '봄당 서재에 첫 논문을 올려 보세요' && empty.facts === 0 && empty.dropzone && empty.crumbs === '봄당 서재', JSON.stringify(empty));
    return `#/ → #/s/mine; sections ${s.map((x) => `${x.label}${x.current ? '(현재)' : ''} 전체 ${x.all}`).join(' | ')}; empty state “${empty.title}” / “${empty.lines[0]}”`;
  });

  // ------------------------------------------------------------------ invitee 6기, with a list remembered before code libraries
  const S = await device('6gi', seeds.invitee('six'), {
    storage: { [SHARED_CACHE_KEY]: { fp: fingerprintOf(CODES.six.code), libraries: [{ id: 'team', name: '공용 서재' }], personId: P('six'), name: '6기', at: Date.now() - DAY } },
  });
  const sp = S.page;

  await test('invitee 6기 who used 공용 서재 before code libraries (remembered list without kinds): #/ still lands in ‘6기 서재’', async () => {
    await sp.goto(`${APP}#/`);
    await booted(sp);
    await relayLibsReady(sp);
    await sp.waitForFunction(() => location.hash === '#/s/mine', null, { timeout: 10000 });
    const s = await sections(sp);
    const cache = await sp.evaluate((k) => JSON.parse(localStorage.getItem(k) || 'null'), SHARED_CACHE_KEY);
    assertEqual(s.map((x) => x.label), ['6기 서재', TEAM_NAME], 'sections');
    assert(cache?.v === 2 && cache.libraryId === L('six') && cache.libraries.map((l) => l.kind).join() === 'code,team', JSON.stringify(cache));
    return `#/ → ${await hashOf(sp)}; sections [${s.map((x) => x.label)}]; remembered list now v${cache.v} with kinds [${cache.libraries.map((l) => `${l.id}:${l.kind}`)}] and libraryId`;
  });

  // ------------------------------------------------------------------ admin: split 전체 공용 서재 by uploader
  await test('admin: ‘전체 공용 서재 논문을 올린 사람 서재로 나누기’ shows the dry-run plan in a dialog, then moves in one commit', async () => {
    await openAdmin(op);
    const before = github.commits(TEAM.owner, TEAM.repo).length;
    await op.locator('#set-invites .relay-split-btn').click();
    await op.waitForSelector('.split-dialog .split-list');
    const plan = await op.evaluate(() => ({
      title: document.querySelector('.split-dialog .modal-title').textContent,
      message: document.querySelector('.split-dialog .modal-message').textContent,
      moves: [...document.querySelectorAll('.split-dialog .split-list:not(.split-skipped .split-list) .split-row')].map((r) => `${r.querySelector('.split-title').textContent} → ${r.querySelector('.split-where').textContent}`),
      skipped: document.querySelector('.split-dialog .split-skipped summary')?.textContent,
      skippedRows: [...document.querySelectorAll('.split-dialog .split-skipped .split-row')].map((r) => `${r.querySelector('.split-title').textContent}: ${r.querySelector('.split-where').textContent}`),
      buttons: [...document.querySelectorAll('.split-dialog .modal-footer .btn')].map((b) => b.textContent.trim()),
      focused: document.activeElement?.textContent?.trim(),
    }));
    await op.locator('.split-dialog .split-skipped summary').click();
    await shot(op.locator('.split-dialog'), 'split-dry-run');
    await shot(op, 'split-dry-run-page');
    const dry = adminCalls.filter((c) => c.path === '/relay/admin/shared/team/split-by-uploader');
    assertEqual(github.commits(TEAM.owner, TEAM.repo).length, before, 'the dry run wrote nothing');
    await op.locator('.split-dialog .modal-footer .btn-primary').click();
    await op.waitForSelector('.toast >> text=논문 2편을 올린 사람 서재로 옮겼습니다.', { timeout: 20000 });
    await op.waitForSelector('.split-dialog', { state: 'detached' });
    const calls = adminCalls.filter((c) => c.path === '/relay/admin/shared/team/split-by-uploader').map((c) => [c.method, c.body?.dryRun, c.auth === ADMIN_TOKEN]);
    const team = readJson('library.json');
    const bom = readJson(`codes/${L('bom')}/library.json`);
    const six = readJson(`codes/${L('six')}/library.json`);
    const files = [...teamFiles().keys()];
    const last = github.commits(TEAM.owner, TEAM.repo)[0];
    assertEqual(plan.title, '올린 사람 서재로 나누기', 'dialog title');
    assertEqual(plan.message, '논문 2편을 올린 사람의 코드 서재로 옮깁니다.', 'plan line');
    assertEqual(plan.moves.sort(), [`${TITLES.moral} → 봄당 서재최상위`, `${TITLES.proc} → 6기 서재찬영`].sort(), 'moves');
    assertEqual([plan.skipped, plan.skippedRows], ['그대로 두는 논문 1편', [`${TITLES.lessons}: 휴지통에 있음`]], 'skipped');
    assertEqual([plan.buttons, plan.focused], [['취소', '2편 옮기기'], '취소'], 'buttons');
    assertEqual(dry.map((c) => [c.method, c.body?.dryRun]), [['POST', true]], 'the dry run request');
    assertEqual(calls, [['POST', true, true], ['POST', false, true]], 'dry run, then apply (admin token)');
    // 전체 공용 서재: the two records moved out (not tombstoned), 찬영 in the 휴지통, Lessons stays deleted.
    assert(!team.papers.some((p) => p.id === 'p_moral' || p.id === 'p_proc'), `team papers ${team.papers.map((p) => p.id)}`);
    assert(team.papers.find((p) => p.id === 'p_lessons')?.deleted === true, 'Lessons stays (tombstoned)');
    assert(team.folders.find((f) => f.name === '찬영')?.deleted === true, '찬영 tombstoned');
    // 봄당 서재: Moral + 봄당's notes; 6기 서재: Procedures inside ‘찬영’ + 6기's notes.
    assert(bom.papers.map((p) => `${p.id}:${p.folderId}`).join() === 'p_moral:null', JSON.stringify(bom));
    const chan = six.folders.find((f) => f.name === '찬영');
    assert(chan && six.papers.map((p) => `${p.id}:${p.folderId}`).join() === `p_proc:${chan.id}`, JSON.stringify(six));
    for (const f of [`codes/${L('bom')}/papers/p_moral/paper.pdf`, `codes/${L('bom')}/papers/p_moral/translation.json`, `codes/${L('bom')}/people/${P('bom')}/papers/p_moral/ai.json`,
      `codes/${L('bom')}/people/${P('bom')}/papers/p_moral/annotations.json`, `codes/${L('six')}/papers/p_proc/paper.pdf`, `codes/${L('six')}/people/${P('six')}/papers/p_proc/ai.json`]) {
      assert(files.includes(f), `missing ${f}`);
    }
    assert(!files.some((f) => /^papers\/p_(moral|proc)\//.test(f) || /^people\/[^/]+\/papers\/p_(moral|proc)\//.test(f)), 'files left at the root');
    assertEqual(last.message, '[관리자] {lib:team} 올린 사람의 코드 서재로 나누기', 'one commit');
    return `dialog “${plan.title}”: “${plan.message}” [${plan.moves.join(' | ')}], “${plan.skipped}” [${plan.skippedRows}], buttons [${plan.buttons}] (focus ${plan.focused}); requests ${JSON.stringify(calls)}; commit “${last.message}”`;
  });

  await test('after the split: 봄당 sees ‘Moral …’ in 봄당 서재 (reader badge: this code only); 전체 공용 서재 has no live paper and no ‘찬영’; 6기 has ‘찬영’ with ‘Procedures …’', async () => {
    await syncSection(bp, 'shared:mine');
    await syncSection(bp, 'shared:team');
    await bp.waitForFunction((t) => [...document.querySelectorAll('.paper-row .paper-title')].some((e) => e.textContent.trim() === t), TITLES.moral, { timeout: 20000 });
    await bp.waitForFunction(() => document.querySelector('.lib-sec[data-lib="shared:team"] .tree-item .tree-count')?.textContent === '0', null, { timeout: 20000 });
    const s = await sections(bp);
    await shot(bp, 'invitee-after-split');
    await bp.locator('.paper-row', { hasText: TITLES.moral }).locator('.paper-link').click();
    await bp.waitForFunction(() => location.hash.startsWith('#/s/mine/paper/p_moral'), null, { timeout: 10000 });
    await bp.waitForSelector('.tb-shared', { timeout: 30000 });
    const badge = { text: (await bp.locator('.tb-shared').textContent()).trim(), title: await bp.locator('.tb-shared').getAttribute('title'), cls: await bp.locator('.tb-shared').getAttribute('class') };
    await bp.waitForFunction(() => document.querySelector('.pdfv-page canvas') || document.querySelector('.reader .message-screen'), null, { timeout: 60000 });
    const readerError = await bp.$('.reader .message-screen');
    await shot(bp, 'reader-code-badge');
    await bp.locator('.reader-toolbar .tb-back').click();
    await bp.waitForFunction(() => location.hash === '#/s/mine' && document.querySelector('.library'));
    // 6기
    await syncSection(sp, 'shared:team');
    await syncSection(sp, 'shared:mine');
    await sp.waitForFunction(() => document.querySelector('.lib-sec[data-lib="shared:team"] .tree-item .tree-count')?.textContent === '0', null, { timeout: 20000 });
    await sp.waitForFunction(() => [...document.querySelectorAll('.lib-sec[data-lib="shared:mine"] .tree-item.is-folder .tree-label')].some((e) => e.textContent === '찬영'), null, { timeout: 20000 });
    const six = await sections(sp);
    assert(!readerError, `reader error: ${readerError ? await readerError.textContent() : ''}`);
    assertEqual(s.map((x) => [x.key, x.all, x.folders]), [['shared:mine', '1', []], ['shared:team', '0', []]], '봄당 sections');
    assert(badge.text === '봄당 서재 · 이 코드만 보는 서재' && /이 초대 코드를 가진 사람만/.test(badge.title) && /is-code/.test(badge.cls), JSON.stringify(badge));
    assertEqual(six.map((x) => [x.key, x.all, x.folders]), [['shared:mine', '1', ['찬영=1']], ['shared:team', '0', []]], '6기 sections');
    return `봄당: ${s.map((x) => `${x.label} 전체 ${x.all} [${x.folders}]`).join(' | ')}; reader badge “${badge.text}”; 6기: ${six.map((x) => `${x.label} 전체 ${x.all} [${x.folders}]`).join(' | ')}`;
  });

  await test('전체 공용 서재 휴지통 and 최근 활동 after the split: ‘찬영’ (관리자) and ‘Lessons…’; the split listed under 관리자', async () => {
    await sec(bp, 'shared:team').locator('.tree-item.is-trash').click();
    await bp.waitForFunction(() => location.hash === '#/s/team/trash');
    await bp.waitForSelector('.trash-row[data-kind="folder"]', { timeout: 15000 });
    const trash = await bp.$$eval('.trash-row', (els) => els.map((e) => `${e.dataset.kind}:${e.querySelector('.trash-name').textContent}:${e.querySelector('.trash-who')?.textContent || ''}`));
    const admin = await bp.locator('.trash-admin').count();
    await sec(bp, 'shared:team').locator('.tree-item.is-activity').click();
    await bp.waitForSelector('.activity-item', { timeout: 15000 });
    const activity = await bp.$$eval('.activity-item .activity-text', (els) => els.map((e) => e.textContent.replace(/\s+/g, ' ').trim()));
    await sec(bp, 'shared:mine').locator('.tree-item.is-activity').click();
    await bp.waitForFunction(() => location.hash === '#/s/mine/activity');
    await bp.waitForSelector('.activity .activity-item, .lib-content .empty-state h2', { timeout: 15000 });
    const mineActivity = await bp.$$eval('.activity-item .activity-text', (els) => els.map((e) => e.textContent.replace(/\s+/g, ' ').trim()));
    assert(trash.includes('folder:찬영:관리자') && trash.some((t) => t.startsWith(`paper:${TITLES.lessons}:봄당테스트`)), `trash ${trash}`);
    assert(admin === 0, 'an invitee sees the purge');
    assert(activity.some((t) => /^관리자 올린 사람의 코드 서재로 나누기/.test(t)) && !activity.some((t) => /\{lib:/.test(t)), `team activity ${activity}`);
    assert(!mineActivity.some((t) => /관리자 비교테스트/.test(t)), `봄당 서재 activity shows another code's library: ${mineActivity}`);
    return `휴지통 [${trash}]; 최근 활동 (전체 공용 서재) [${activity.slice(0, 3).join(' | ')}]; 봄당 서재 최근 활동 ${mineActivity.length} entries`;
  });

  // ------------------------------------------------------------------ admin: delete a code (its library deleted or moved)
  await test('admin 수정: the code library’s size cap (MB) next to limit and models — GET …/library, PATCH …/library { maxBytes }', async () => {
    await openAdmin(op);
    const rowSel = `#set-invites .relay-code[data-code="${CODES.six.code}"]`;
    await op.locator(`${rowSel} .btn`, { hasText: '한도·모델 수정' }).click();
    await op.waitForSelector('.relay-edit-dialog .relay-lib-cap:not([hidden])', { timeout: 15000 });
    const before = await op.evaluate(() => {
      const f = document.querySelector('.relay-edit-dialog .relay-lib-cap');
      return { label: f.querySelector('.field-label').textContent, value: f.querySelector('input').value, info: f.querySelector('.field-hint').textContent };
    });
    await shot(op.locator('.relay-edit-dialog'), 'edit-cap');
    await op.fill('.relay-edit-dialog .relay-lib-cap input', '800');
    await op.locator('.relay-edit-dialog .modal-footer .btn-primary').click();
    await op.waitForSelector('.toast >> text=초대 코드를 수정했습니다.', { timeout: 10000 });
    const calls = adminCalls.filter((c) => c.path === `/relay/admin/codes/${CODES.six.code}/library`).map((c) => [c.method, c.body]);
    assertEqual([before.label, before.value], ['서재 용량 (MB)', '500'], 'cap field');
    assert(/^‘6기 서재’ · 논문 1편 · .+ MB 사용 중$/.test(before.info), before.info);
    assertEqual(calls, [['GET', null], ['PATCH', { maxBytes: 800_000_000 }]], 'library requests');
    assertEqual(registry.get(CODES.six.code).maxBytes, 800_000_000, 'cap stored');
    return `field “${before.label}” = ${before.value}, “${before.info}”; 800 → ${calls.map(([m, b]) => `${m}${b ? ` ${JSON.stringify(b)}` : ''}`).join(', ')}`;
  });

  await test('admin 삭제: the dialog asks about the code’s library — 서재도 함께 삭제 (default, paper count) or 다른 코드로 옮기기 + a code', async () => {
    // 봄당테스트 (stopped) has a library of its own with one paper and its notes.
    const bt = `codes/${L('bomTest')}/`;
    const old = pdfBytes('simwright2005');
    commitTeam({
      [`${bt}library.json`]: json({ version: 1, updatedAt: T0, folders: [{ id: 'f_bt', name: '시험', parentId: null, createdAt: T0, updatedAt: T0 }],
        papers: [paperRecord('p_bt1', 'Old practice paper', '봄당테스트', 'f_bt', old)] }),
      [`${bt}papers/p_bt1/paper.pdf`]: old,
      [`${bt}people/${P('bomTest')}/papers/p_bt1/annotations.json`]: json({ version: 1, updatedAt: T0, items: [] }),
    }, `[봄당테스트] {lib:${L('bomTest')}} 폴더 만듦 ‘시험’ · 논문 추가 ‘Old practice paper’`);
    await openAdmin(op);
    const rowSel = `#set-invites .relay-code[data-code="${CODES.bomTest.code}"]`;
    await op.locator(`${rowSel} .btn`, { hasText: '삭제' }).click();
    await op.waitForSelector('.relay-delete-dialog .relay-lib-choice');
    // The paper count arrives from GET /relay/admin/codes/<code>/library.
    await op.waitForFunction(() => /논문 1편/.test(document.querySelector('.relay-delete-dialog .radio-card .radio-desc')?.textContent || ''), null, { timeout: 15000 });
    const read = () => op.evaluate(() => {
      const m = document.querySelector('.relay-delete-dialog');
      return {
        title: m.querySelector('.modal-title').textContent,
        lines: [...m.querySelectorAll('.modal-body p')].map((p) => p.textContent),
        legend: m.querySelector('legend').textContent,
        choices: [...m.querySelectorAll('.radio-card')].map((c) => `${c.querySelector('input').checked ? '●' : '○'} ${c.querySelector('.radio-title').textContent} — ${c.querySelector('.radio-desc').textContent}`),
        options: [...m.querySelectorAll('select option')].map((o) => o.textContent),
        danger: m.querySelector('.modal-footer .btn-danger').textContent.trim(),
        focused: document.activeElement?.textContent?.trim(),
      };
    });
    const first = await read();
    await op.selectOption('.relay-delete-dialog select', CODES.bom.code);
    const chosen = await read();
    await shot(op.locator('.relay-delete-dialog'), 'delete-modal');
    await shot(op, 'delete-modal-page');
    await op.locator('.relay-delete-dialog .modal-footer .btn-danger').click();
    await op.waitForSelector('.toast >> text=삭제했습니다. 서재는 ‘봄당’ 코드로 옮겼습니다.', { timeout: 20000 });
    await op.waitForFunction((sel) => !document.querySelector(sel), rowSel, { timeout: 10000 });
    const del = adminCalls.filter((c) => c.method === 'DELETE').map((c) => `${c.path}${c.search}`);
    const files = [...teamFiles().keys()];
    const bom = readJson(`codes/${L('bom')}/library.json`);
    assertEqual(first.title, '‘봄당테스트’ 코드를 삭제할까요?', 'title');
    assertEqual(first.lines, ['이 코드로는 더 이상 들어올 수 없고, 전체 공용 서재에 남긴 하이라이트·메모·AI 기록도 지워집니다.', '전체 공용 서재의 논문·폴더·번역과 사용 비용 기록은 그대로 남습니다.'], 'lines');
    assertEqual(first.legend, '봄당테스트 서재', 'legend');
    assertEqual(first.choices, ['● 서재도 함께 삭제 — 논문 1편과 폴더·번역·메모가 함께 지워집니다.', '○ 다른 코드로 옮기기 — 논문·폴더·번역과 이 코드의 메모를 고른 코드의 서재로 옮깁니다.'], 'choices');
    assert(first.options.length === 4 && first.options.some((o) => o.startsWith('봄당 · ')), `options ${first.options}`);
    assertEqual([first.danger, first.focused], ['삭제', '취소'], 'default button + focus');
    assertEqual([chosen.choices.map((c) => c[0]), chosen.danger], [['○', '●'], '옮기고 삭제'], 'after picking 봄당');
    assertEqual(del, [`/relay/admin/codes/${CODES.bomTest.code}?library=move&to=${CODES.bom.code}`], 'DELETE request');
    assert(!files.some((f) => f.startsWith(bt)), 'the code library folder is gone');
    assert(bom.papers.some((p) => p.id === 'p_bt1') && bom.folders.some((f) => f.name === '시험'), JSON.stringify(bom));
    assert(files.includes(`codes/${L('bom')}/people/${P('bom')}/papers/p_bt1/annotations.json`), 'the holder’s notes moved to 봄당');
    // 봄당's device: the moved folder and paper appear in 봄당 서재.
    await bp.goto(`${APP}#/s/mine`);
    await relayLibsReady(bp);
    await syncSection(bp, 'shared:mine');
    await bp.waitForFunction(() => [...document.querySelectorAll('.lib-sec[data-lib="shared:mine"] .tree-item.is-folder .tree-label')].some((e) => e.textContent === '시험'), null, { timeout: 20000 });
    const s = await sections(bp);
    return `dialog “${first.title}” / legend “${first.legend}” / [${first.choices.join(' | ')}] / options [${first.options}] / [취소 | ${first.danger}] (focus ${first.focused}); 봄당 picked → [${chosen.choices.map((c) => c.slice(0, 1))}] “${chosen.danger}”; ${del[0]}; 봄당 서재 now 전체 ${s[0].all} [${s[0].folders}]`;
  });

  await test('admin 삭제 with the default choice: DELETE …?library=delete removes the code library', async () => {
    const rowSel = `#set-invites .relay-code[data-code="${CODES.nv.code}"]`;
    await op.waitForSelector(rowSel);
    await op.locator(`${rowSel} .btn`, { hasText: '삭제' }).click();
    await op.waitForSelector('.relay-delete-dialog .relay-lib-choice');
    await op.waitForFunction(() => /논문 0편/.test(document.querySelector('.relay-delete-dialog .radio-card .radio-desc')?.textContent || ''), null, { timeout: 15000 });
    const choice = await op.$$eval('.relay-delete-dialog .radio-card', (els) => els.map((c) => `${c.querySelector('input').checked ? '●' : '○'} ${c.querySelector('.radio-desc').textContent}`));
    await op.locator('.relay-delete-dialog .modal-footer .btn-danger', { hasText: '삭제' }).click();
    await op.waitForSelector('.toast >> text=삭제했습니다.', { timeout: 20000 });
    await op.waitForFunction((sel) => !document.querySelector(sel), rowSel, { timeout: 10000 });
    const del = adminCalls.filter((c) => c.method === 'DELETE').map((c) => `${c.path}${c.search}`).at(-1);
    assertEqual(del, `/relay/admin/codes/${CODES.nv.code}?library=delete`, 'DELETE request');
    assert(choice[0].startsWith('● 논문 0편'), `choices ${choice}`);
    return `choices [${choice}]; ${del}; row gone`;
  });

  // ------------------------------------------------------------------ home choice, narrow screen
  await test('invitee picks 전체 공용 서재: #/ opens it next time; picking 봄당 서재 again brings #/ back', async () => {
    await sec(bp, 'shared:team').locator('.tree-item', { hasText: '전체' }).click();
    await bp.waitForFunction(() => location.hash === '#/s/team');
    await bp.goto(`${APP}#/`);
    await relayLibsReady(bp);
    await bp.waitForFunction(() => location.hash === '#/s/team', null, { timeout: 5000 });
    await sec(bp, 'shared:mine').locator('.tree-item', { hasText: '전체' }).click();
    await bp.waitForFunction(() => location.hash === '#/s/mine');
    await bp.goto(`${APP}#/`);
    await relayLibsReady(bp);
    await bp.waitForFunction(() => location.hash === '#/s/mine', null, { timeout: 5000 });
    const home = await bp.evaluate((k) => JSON.parse(localStorage.getItem(k) || '{}').homeLibrary, UI_KEY);
    assertEqual(home, 'shared:mine', 'remembered home');
    return '전체 공용 서재 chosen → #/ → #/s/team; 봄당 서재 chosen → #/ → #/s/mine';
  });

  await test('settings → 공용 서재: both libraries with who sees them; the owner’s size check is for 전체 공용 서재 only', async () => {
    await bp.goto(`${APP}#/settings/shared`);
    await bp.waitForSelector('#set-shared .shared-lib[data-lib="team"]');
    const rows = await bp.$$eval('#set-shared .shared-lib', (els) => els.map((e) => `${e.querySelector('.shared-lib-head b').textContent}|${e.querySelector('.badge').textContent}`));
    const noteText = (await bp.locator('#set-shared .note').last().textContent()).trim();
    await shot(bp.locator('#set-shared'), 'settings-shared');
    await op.goto(`${APP}#/settings/shared`);
    await op.waitForSelector('#set-shared .btn >> text=용량 확인');
    await op.locator('#set-shared .btn', { hasText: '용량 확인' }).click();
    await op.waitForSelector('#set-shared .shared-admin-stats .stat');
    const stats = await op.$$eval('#set-shared .shared-admin-stats .usage-stats', (els) => els.map((e) => e.textContent.replace(/\s+/g, ' ').trim()));
    const statCalls = adminCalls.filter((c) => /\/stats$/.test(c.path)).map((c) => c.path);
    assertEqual(rows, ['봄당 서재|이 초대 코드만', `${TEAM_NAME}|초대받은 모든 사람`], 'rows');
    assert(/‘봄당 서재’는 이 초대 코드를 가진 사람만/.test(noteText), noteText);
    assert(stats.length === 1 && stats[0].startsWith(`${TEAM_NAME} 용량`) && statCalls.every((p) => p === '/relay/admin/shared/team/stats'), `stats ${stats} / ${statCalls}`);
    return `rows [${rows}]; note “${noteText.slice(0, 60)}…”; owner stats [${stats}] via ${[...new Set(statCalls)]}`;
  });

  await test('narrow screen (390 px): both sections in the drawer; the copy and delete dialogs fit; no horizontal scroll', async () => {
    await bp.setViewportSize({ width: 390, height: 844 });
    await bp.goto(`${APP}#/s/mine`);
    await relayLibsReady(bp);
    await bp.locator('.lib-menu-btn').click();
    await sleep(300);
    const drawer = await bp.evaluate(() => ({ scroll: document.documentElement.scrollWidth, width: innerWidth, open: document.querySelector('.library').classList.contains('is-drawer-open') }));
    await shot(bp, 'invitee-narrow-drawer');
    await bp.keyboard.press('Escape');
    await bp.locator('.sidebar-scrim').click({ force: true }).catch(() => {});
    const row = bp.locator('.paper-row').first();
    await row.locator('button[aria-label="논문 메뉴"]').click();
    await bp.locator('.menu .menu-item', { hasText: '다른 서재로 복사…' }).click();
    await bp.waitForSelector('.copy-dialog .folder-picker');
    await sleep(200);
    const dialog = await bp.evaluate(() => {
      const m = document.querySelector('.copy-dialog');
      return { w: m.getBoundingClientRect().width, scroll: m.scrollWidth, client: m.clientWidth, targets: [...m.querySelectorAll('.copy-libs .btn')].map((b) => b.textContent.trim()) };
    });
    await shot(bp, 'copy-picker-narrow');
    await bp.locator('.copy-dialog .modal-footer .btn', { hasText: '취소' }).click();
    await bp.setViewportSize({ width: 1440, height: 900 });
    assert(drawer.open && drawer.scroll <= drawer.width, JSON.stringify(drawer));
    assert(dialog.w <= 390 && dialog.scroll <= dialog.client + 1 && dialog.targets.join() === TEAM_NAME, JSON.stringify(dialog));
    return `drawer open, scrollWidth ${drawer.scroll} ≤ ${drawer.width}; copy dialog ${Math.round(dialog.w)} px, targets [${dialog.targets}]`;
  });

  await test('dark theme: the sections, the lock and the delete dialog use the theme tokens', async () => {
    await op.goto(`${APP}#/`);
    await relayLibsReady(op);
    await op.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
    await sleep(150);
    const colors = await op.evaluate(() => ({
      lock: getComputedStyle(document.querySelector('.lib-sec[data-lib="shared:mine"] .lib-sec-toggle .icon-lock')).color,
      users: getComputedStyle(document.querySelector('.lib-sec[data-lib="shared:team"] .lib-sec-toggle .icon-users')).color,
      sidebar: getComputedStyle(document.querySelector('.lib-sidebar')).backgroundColor,
    }));
    await shot(op, 'owner-sidebar-dark');
    await openAdmin(op);
    await op.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
    await op.locator(`#set-invites .relay-code[data-code="${CODES.six.code}"] .btn`, { hasText: '삭제' }).click();
    await op.waitForSelector('.relay-delete-dialog .relay-lib-choice');
    const card = await op.evaluate(() => getComputedStyle(document.querySelector('.relay-lib-choice .radio-card')).backgroundColor);
    await shot(op.locator('.relay-delete-dialog'), 'delete-modal-dark');
    await op.locator('.relay-delete-dialog .modal-footer .btn', { hasText: '취소' }).click();
    await op.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
    assertEqual([colors.lock, colors.users, colors.sidebar], ['rgb(221, 180, 157)', 'rgb(140, 199, 154)', 'rgb(29, 24, 20)'], 'dark: lock (--accent-text), people (--success), sidebar (--sidebar-bg)');
    assert(card !== 'rgb(255, 253, 249)', `delete dialog card stays light in dark: ${card}`);
    return `lock ${colors.lock}, people ${colors.users}, sidebar ${colors.sidebar}; dialog card ${card}`;
  });

  await test('no console errors, page errors, CSP violations, native dialogs or escaped requests', async () => {
    for (const d of [O, B, S]) {
      if (d.external.length) problems.push(`${d.name}: external ${d.external.join(', ')}`);
    }
    assert(!problems.length, problems.join('\n'));
    return `0 problems; HTTP refusals the app expects (conflicts) logged by Chromium: ${refusals.length}`;
  });
  for (const d of [O, B, S]) await d.ctx.close();
} finally {
  await browser.close();
  await relay.close();
  await github.close();
  if (server) server.kill();
  const failed = results.filter((r) => r.result !== 'pass');
  writeFileSync(`${OUT}/results.json`, JSON.stringify({ results, expectedHttpRefusals: refusals, adminCalls }, null, 2));
  console.log(`\ncode-libs: ${results.length - failed.length}/${results.length} passed${failed.length ? ` — FAILED: ${failed.map((f) => f.name).join(' | ')}` : ''}`);
  console.log(`results + screenshots: ${OUT}`);
  process.exitCode = failed.length ? 1 : 0;
}
