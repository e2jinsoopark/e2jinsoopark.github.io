// The app's own GitHubClient (js/store/github.js) through the shared-library proxy, as 공용 서재 uses it
// (apiBase = <relay>/shared/team/gh, owner 'team', repo 'library', token = invite code): in Node (fetch) and in Edge
// on a localhost page (CORS preflights for PUT/PATCH, the ETag exposed for conditional GETs → 304).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'file:///C:/Users/dindoo/Projects/pr-tools/node_modules/playwright/index.mjs';
import { call, newCode, PAGE_PORT, personIdOfCode, TEAM_TOKEN, WORKER } from './lib.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const JS_DIR = path.join(REPO_ROOT, 'js');
const { GitHubClient, GitHubConflictError, GitHubError } = await import(pathToFileURL(path.join(JS_DIR, 'store/github.js')).href);
const FIXTURE = 'C:/Users/dindoo/Projects/pr-fixtures/lu2025.pdf'; // CC BY; read from the fixtures folder, never copied
const TEAM = ['dindoopark', 'paper-team-library'];
const API = `${WORKER}/shared/team/gh`;
const PAGE = `http://localhost:${PAGE_PORT}/`;

const codes = [];

async function person(name) {
  const { code } = await newCode({ name });
  codes.push(code);
  // personId = SHA-256(code, a line break, the person salt)[0:16] (no PERSON_ID_SECRET in the tests); salt read from D1.
  return { code, name, id: await personIdOfCode(code) };
}

/** A GitHubClient for 공용 서재 with this person's invite code. */
const client = (who, lib = 'team') => new GitHubClient({
  owner: 'team', repo: 'library', branch: 'main', token: who.code, apiBase: `${WORKER}/shared/${lib}/gh`, proxy: true,
  rateLimitMaxWaitMs: 0,
});

const libraryJson = (papers, folders = []) => JSON.stringify({ version: 1, updatedAt: Date.now(), folders, papers });

/** Static server for the page (a different origin than the Worker, like the real app): / and /js/** only. */
function startPageServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, PAGE);
    if (url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><meta charset="utf-8"><title>shared library client test</title><body>shared</body>');
      return;
    }
    const file = path.resolve(REPO_ROOT, `.${decodeURIComponent(url.pathname)}`);
    if (!file.startsWith(`${JS_DIR}${path.sep}`) || !file.endsWith('.js') || !fs.existsSync(file)) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
    res.end(fs.readFileSync(file));
  });
  return new Promise((resolve) => server.listen(PAGE_PORT, '127.0.0.1', () => resolve(server)));
}

export async function setup() {
  const server = await startPageServer();
  const browser = await chromium.launch({ channel: 'msedge' });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(PAGE);
  return { server, browser, page, errors, A: await person('김민지'), B: await person('박서준') };
}

export async function teardown({ server, browser }) {
  await browser?.close();
  await new Promise((r) => (server ? server.close(r) : r()));
}

/** Silence GitHubClient's console.warn for requests that are refused on purpose. */
async function quietly(fn) {
  const warn = console.warn;
  console.warn = () => {};
  try {
    return await fn();
  } finally {
    console.warn = warn;
  }
}

export const tests = [
  {
    name: 'GitHubClient (Node) through the proxy: checkAccess, bootstrap of an empty repo, commit, listTree without others\' files, readBlob, 304',
    fn: async ({ gh, A, B }) => {
      gh.createRepo(...TEAM, { private: true });
      const a = client(A);
      const b = client(B);
      const access = await a.checkAccess();
      assert.equal(access.ok, true, access.message);
      assert.equal(access.repoPrivate, true);
      assert.equal(access.canPush, true);
      assert.equal(access.empty, true);
      assert.equal(await a.getHead(), null);
      const pdf = new Uint8Array(fs.readFileSync(FIXTURE));
      const r1 = await a.commit([
        { path: 'papers/p_lu/paper.pdf', bytes: pdf },
        { path: 'papers/p_lu/translation.json', text: '{"version":1,"targetLang":"ko","items":{"s1":{"h":"x","t":"번역"}}}' },
        { path: `people/${A.id}/papers/p_lu/annotations.json`, text: '{"version":1,"items":[{"id":"h1","note":"A의 메모"}]}' },
        { path: 'library.json', text: libraryJson([{ id: 'p_lu', title: 'Lu 2025', folderId: 'f1' }], [{ id: 'f1', name: '중환자' }]) },
      ], '논문 추가: Lu 2025', { parent: null });
      const commits = gh.commits(...TEAM);
      // Stored with the library marker ({lib:team}, docs/SHARED.md §6); the app never shows it.
      assert.deepEqual(commits.map((c) => c.message), ['[김민지] {lib:team} 논문 추가: Lu 2025', '[김민지] {lib:team} 논문 리더 데이터 저장소 시작']);
      assert.equal(commits[0].sha, r1.commitSha);

      const full = await b.checkAccess();
      assert.equal(full.ok, true, full.message);
      assert.equal(full.foreign, false, full.message);
      const hb = await b.getHead();
      assert.equal(hb.commitSha, r1.commitSha);
      const treeB = await b.listTree(hb.treeSha);
      assert.deepEqual([...treeB.keys()].sort(), ['README.md', 'library.json', 'papers/p_lu/paper.pdf', 'papers/p_lu/translation.json']);
      const bytes = await b.readBlob(treeB.get('papers/p_lu/paper.pdf').sha);
      assert.equal(Buffer.compare(Buffer.from(bytes), Buffer.from(pdf)), 0);
      const treeA = await a.listTree(hb.treeSha);
      assert.ok(treeA.has(`people/${A.id}/papers/p_lu/annotations.json`));

      const mark = gh.log.length;
      const again = await b.getHead();
      assert.equal(again.commitSha, hb.commitSha);
      const sent = gh.log.slice(mark);
      assert.deepEqual(sent.map((e) => [e.method, e.status]), [['GET', 304]], JSON.stringify(sent.map((e) => `${e.method} ${e.path} ${e.status}`)));
      assert.match(sent[0].headers['if-none-match'] || '', /^"[0-9a-f]{40}"$/);
      return `bootstrap + commit by A (${pdf.byteLength} B PDF); B lists ${treeB.size} shared files (not A's notes), PDF bytes identical; 2nd getHead → one GET answered 304`;
    },
  },
  {
    name: 'GitHubClient conflicts: a stale parent (proxy 409) and a non-fast-forward at the ref update (GitHub 422) both become GitHubConflictError; re-pull + retry succeeds',
    fn: async ({ gh, A, B }) => {
      const a = client(A);
      const b = client(B);
      const h1 = await a.getHead();
      const hb = await b.getHead();
      const rb = await b.commit([{ path: `people/${B.id}/papers/p_lu/ai.json`, text: '{"version":1,"summary":{"markdown":"B의 요약"}}' }], '요약 저장', {
        parent: hb.commitSha, baseTree: hb.treeSha,
      });
      const stale = await quietly(() => a.commit([{ path: 'library.json', text: libraryJson([{ id: 'p_lu', title: 'Lu 2025 (A)', folderId: 'f1' }], [{ id: 'f1', name: '중환자' }]) }], '제목 수정', {
        parent: h1.commitSha, baseTree: h1.treeSha,
      }).then(() => null, (err) => err));
      assert.ok(stale instanceof GitHubConflictError, String(stale));
      assert.equal(stale.cause?.status, 409);
      assert.equal(headSha(gh), rb.commitSha, 'the stale commit did not land');

      const h2 = await a.getHead();
      const pause = gh.pauseNext({ method: 'PATCH', path: /\/git\/refs\/heads\/main$/ });
      const pending = quietly(() => a.commit([{ path: `people/${A.id}/papers/p_lu/annotations.json`, text: '{"version":1,"items":[]}' }], '메모 정리', {
        parent: h2.commitSha, baseTree: h2.treeSha,
      }).then(() => null, (err) => err));
      await pause.hit;
      gh.commitFiles(...TEAM, { 'papers/p_lu/translation.json': '{"version":1,"items":{"s2":{"t":"다른 기기"}}}' }, { message: '[박서준] 번역' });
      pause.release();
      const nonFf = await pending;
      assert.ok(nonFf instanceof GitHubConflictError, String(nonFf));
      assert.equal(nonFf.cause?.status, 422);
      assert.equal(nonFf.cause?.ghMessage, 'Update is not a fast forward');

      const h3 = await a.getHead();
      const r3 = await a.commit([{ path: `people/${A.id}/papers/p_lu/annotations.json`, text: '{"version":1,"items":[]}' }], '메모 정리', {
        parent: h3.commitSha, baseTree: h3.treeSha,
      });
      assert.equal(headSha(gh), r3.commitSha);
      const files = gh.files(...TEAM);
      assert.ok(files.has(`people/${B.id}/papers/p_lu/ai.json`), 'B\'s file survives A\'s commits');
      assert.equal(gh.readFile(...TEAM, 'papers/p_lu/translation.json').toString(), '{"version":1,"items":{"s2":{"t":"다른 기기"}}}');
      return `stale parent → GitHubConflictError (409 "${stale.cause.ghMessage}"); paused PATCH + other push → GitHubConflictError (422); retry → ${r3.commitSha.slice(0, 7)}`;
    },
  },
  {
    name: 'GitHubClient refusals keep the proxy\'s Korean messages: other person\'s file / deleting a PDF → forbidden, full library → too_large, disabled code → auth',
    fn: async ({ gh, A, B }) => {
      const a = client(A);
      const h = await a.getHead();
      const opts = { parent: h.commitSha, baseTree: h.treeSha };
      const other = await quietly(() => a.commit([{ path: `people/${B.id}/papers/p_lu/ai.json`, text: '{}' }], 'x', opts).then(() => null, (e) => e));
      assert.ok(other instanceof GitHubError && other.code === 'forbidden' && /다른 사람/.test(other.message), String(other));
      const del = await quietly(() => a.commit([{ path: 'papers/p_lu/paper.pdf', delete: true }], 'x', opts).then(() => null, (e) => e));
      assert.ok(del instanceof GitHubError && del.code === 'forbidden' && /지울 수 없/.test(del.message), String(del));
      assert.equal(headSha(gh), h.commitSha);

      gh.createRepo('dindoopark', 'paper-small-library', { private: true });
      gh.commitFiles('dindoopark', 'paper-small-library', { 'library.json': '{}', 'papers/p1/paper.pdf': fs.readFileSync(FIXTURE).subarray(0, 900_000) });
      const big = new Uint8Array(fs.readFileSync(FIXTURE));
      const full = await quietly(() => client(A, 'small').createBlob(big).then(() => null, (e) => e));
      assert.ok(full instanceof GitHubError && full.code === 'too_large' && /저장 공간/.test(full.message), String(full));

      const off = await person('그만둔 동료');
      await call(`/relay/admin/codes/${off.code}`, { method: 'PATCH', admin: true, body: { active: false } });
      const refused = await quietly(() => client(off).checkAccess());
      assert.equal(refused.ok, false);
      assert.equal(refused.code, 'auth');
      assert.match(refused.message, /사용이 중지/);
      return `forbidden "${other.message}"; too_large "${full.message}"; disabled → auth "${refused.message}"`;
    },
  },
  {
    name: 'GitHubClient on a truncated tree walks it level by level; the walk is filtered exactly like the recursive listing',
    fn: async ({ gh, A, B }) => {
      const b = client(B);
      // A head tree the Worker has never listed (it would otherwise serve its complete cached index).
      gh.commitFiles(...TEAM, { 'papers/p_two/translation.json': '{"version":1,"items":{}}', [`people/${B.id}/papers/p_two/ai.json`]: '{"version":1}' },
        { message: '[박서준] 번역' });
      const visible = [...gh.files(...TEAM)]
        .filter(([p]) => !p.startsWith('people/') || p.startsWith(`people/${B.id}/`))
        .map(([p, f]) => [p, f.sha]).sort();
      gh.setTruncateRecursive(2);
      let walked;
      const mark = gh.log.length;
      try {
        const h = await b.getHead();
        walked = [...(await b.listTree(h.treeSha))].map(([p, f]) => [p, f.sha]).sort();
      } finally {
        gh.setTruncateRecursive(0);
      }
      assert.deepEqual(walked, visible);
      assert.ok(walked.some(([p]) => p.startsWith(`people/${B.id}/`)));
      assert.ok(!walked.some(([p]) => p.startsWith(`people/${A.id}`)));
      const levels = gh.log.slice(mark).filter((e) => e.method === 'GET' && /\/git\/trees\//.test(e.path) && !e.query).length;
      assert.ok(levels >= 3, `walked ${levels} levels`);
      return `${walked.length} files via ${levels} level listings, identical to the recursive listing; no people/${A.id}`;
    },
  },
  {
    name: 'GitHubClient in Edge (localhost page → Worker): bootstrap (PUT preflight), commit (PATCH preflight), 304 via the exposed ETag, readBlob',
    fn: async ({ gh, page, errors, A, B }) => {
      gh.createRepo(...TEAM, { private: true });
      const pdf = fs.readFileSync(FIXTURE);
      const mark = gh.log.length;
      const r = await page.evaluate(async ({ api, code, me, pdfB64, lib }) => {
        const { GitHubClient } = await import('/js/store/github.js');
        const c = new GitHubClient({ owner: 'team', repo: 'library', token: code, apiBase: api, proxy: true, rateLimitMaxWaitMs: 0 });
        const access = await c.checkAccess();
        const pdf = Uint8Array.from(atob(pdfB64), (ch) => ch.charCodeAt(0));
        const first = await c.commit([
          { path: 'papers/p_lu/paper.pdf', bytes: pdf }, { path: 'library.json', text: lib },
          { path: `people/${me}/papers/p_lu/ai.json`, text: '{"version":1}' },
        ], '브라우저에서 논문 추가', { parent: null });
        const h1 = await c.getHead();
        const h2 = await c.getHead();
        const tree = await c.listTree(h2.treeSha);
        const bytes = await c.readBlob(tree.get('papers/p_lu/paper.pdf').sha);
        const second = await c.commit([{ path: `people/${me}/papers/p_lu/annotations.json`, text: '{"version":1,"items":[]}' }], '브라우저에서 메모', {
          parent: h2.commitSha, baseTree: h2.treeSha,
        });
        return { access: { ok: access.ok, empty: access.empty, message: access.message }, first: first.commitSha, same: h1.commitSha === h2.commitSha,
          size: bytes.byteLength, second: second.commitSha, paths: [...tree.keys()].sort() };
      }, { api: API, code: A.code, me: A.id, pdfB64: pdf.toString('base64'), lib: libraryJson([{ id: 'p_lu', title: 'Lu 2025' }]) });
      assert.equal(r.access.ok, true, r.access.message);
      assert.equal(r.access.empty, true);
      assert.equal(r.size, pdf.length);
      assert.ok(r.same);
      assert.deepEqual(r.paths, ['README.md', 'library.json', 'papers/p_lu/paper.pdf', `people/${A.id}/papers/p_lu/ai.json`]);
      assert.equal(headSha(gh), r.second);
      assert.deepEqual(gh.commits(...TEAM).map((c) => c.message),
        ['[김민지] {lib:team} 브라우저에서 메모', '[김민지] {lib:team} 브라우저에서 논문 추가', '[김민지] {lib:team} 논문 리더 데이터 저장소 시작']);
      const refGets = gh.log.slice(mark).filter((e) => e.method === 'GET' && e.path.endsWith('/git/ref/heads/main'));
      assert.ok(refGets.some((e) => e.status === 304 && e.headers['if-none-match']), 'the page sent If-None-Match (ETag exposed) and got 304');
      assert.ok(gh.log.slice(mark).some((e) => e.method === 'PUT' && e.status === 201), 'README bootstrap went through');
      // B, in Node, sees the browser's shared files but not A's notes.
      const treeB = await client(B).listTree((await client(B).getHead()).treeSha);
      assert.ok(!([...treeB.keys()].some((p) => p.startsWith('people/'))));
      assert.deepEqual(errors.filter((e) => !/the server responded with a status of 40[49]/.test(e)), []);
      return `in Edge: bootstrap + 2 commits, 304 on the 2nd getHead, PDF ${r.size} B read back; console: ${errors.length} expected 404/409 lines`;
    },
  },
  {
    name: 'GitHubClient with rootPrefix through /shared/mine/gh (a code library, docs/CODE-LIBRARIES.md): an empty repo is bootstrapped at the root, files land under codes/<id>/, listings are relative; another code sees none of it',
    fn: async ({ gh, A, B }) => {
      gh.createRepo(...TEAM, { private: true });
      const libA = (await call('/shared', { headers: { authorization: `Bearer ${A.code}` } })).json.libraryId;
      assert.match(libA || '', /^[0-9a-f]{16}$/);
      const root = `codes/${libA}/`;
      const mine = (who, prefix) => new GitHubClient({
        owner: 'team', repo: 'library', branch: 'main', token: who.code, apiBase: `${WORKER}/shared/mine/gh`, proxy: true,
        rateLimitMaxWaitMs: 0, rootPrefix: prefix,
      });
      const a = mine(A, root);
      const r = await a.commit([
        { path: 'papers/p_own/paper.pdf', bytes: new Uint8Array(fs.readFileSync(FIXTURE)) },
        { path: `people/${A.id}/papers/p_own/annotations.json`, text: '{"version":1,"items":[]}' },
        { path: 'library.json', text: libraryJson([{ id: 'p_own', title: '내 코드 서재 논문' }]) },
      ], '논문 추가', { parent: null });
      const files = [...gh.files(...TEAM).keys()].sort();
      assert.deepEqual(files, ['README.md', `${root}library.json`, `${root}papers/p_own/paper.pdf`, `${root}people/${A.id}/papers/p_own/annotations.json`]);
      assert.deepEqual(gh.commits(...TEAM).map((c) => c.message), [`[김민지] {lib:${libA}} 논문 추가`, `[김민지] {lib:${libA}} 논문 리더 데이터 저장소 시작`]);
      const h = await a.getHead();
      assert.equal(h.commitSha, r.commitSha);
      assert.deepEqual([...(await a.listTree(h.treeSha)).keys()].sort(), ['library.json', 'papers/p_own/paper.pdf', `people/${A.id}/papers/p_own/annotations.json`]);
      // B: its own code library (another prefix) and 전체 공용 서재 are both empty of A's files.
      const libB = (await call('/shared', { headers: { authorization: `Bearer ${B.code}` } })).json.libraryId;
      const hb = await mine(B, `codes/${libB}/`).getHead();
      assert.deepEqual([...(await mine(B, `codes/${libB}/`).listTree(hb.treeSha)).keys()], []);
      assert.deepEqual([...(await client(B).listTree(hb.treeSha)).keys()], ['README.md']);
      return `bootstrap through /shared/mine/gh → README.md at the root, 3 files under ${root}; commits “${gh.commits(...TEAM)[0].message}”; B lists nothing of it (own library, team)`;
    },
  },
  {
    name: 'GitHubClient round trips: GitHub never saw an invite code, only the Worker\'s token',
    fn: async ({ gh }) => {
      for (const e of gh.log) {
        const everything = [e.path, e.query, JSON.stringify(e.headers), e.body?.toString('latin1') ?? ''].join('\n');
        for (const code of codes) assert.ok(!everything.includes(code), `invite code reached GitHub: ${e.method} ${e.path}`);
        assert.equal(e.headers.authorization, `Bearer ${TEAM_TOKEN}`);
      }
      return `${gh.log.length} GitHub requests checked against ${codes.length} codes`;
    },
  },
];

function headSha(gh) {
  return gh.repo(...TEAM).refs.get('heads/main');
}
