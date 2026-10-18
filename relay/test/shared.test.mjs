// HTTP tests of the shared library (공용 서재, docs/SHARED.md §2) against `wrangler dev` + the fake GitHub
// (tests/store/fake-github.mjs on 8792): every allow/deny rule of the GitHub proxy, people/ filtering, the size
// cap, activity, admin stats/purge, upstream failures, CORS — and that no secret crosses (team token → browser,
// invite code → GitHub).
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import http from 'node:http';
import { ADMIN_TOKEN, call, newCode, TEAM_TOKEN, WORKER_PORT } from './lib.mjs';

const TEAM = ['dindoopark', 'paper-team-library'];
const SMALL = ['dindoopark', 'paper-small-library'];
const LAB = ['dindoopark', 'lab-library'];
const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;
const KOREAN = /[가-힣]/;
const README_TEXT = '# 논문 리더 데이터 저장소\n\n이 저장소는 논문 리더 앱이 관리합니다.\n';

/** Every response the proxy gave in this suite (for the token leak check) and every invite code made here. */
const seen = [];
const codes = [];

const personOf = (code) => createHash('sha256').update(code).digest('hex').slice(0, 16);
const gitSha = (buf) => createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${buf.length}\0`), buf])).digest('hex');
const PDF = (n, fill = 'a') => Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(Math.max(0, n - 9), fill)]);
const libraryJson = (papers) => JSON.stringify({ version: 1, updatedAt: 1, folders: [], papers });
const file = (path, sha, extra = {}) => ({ path, mode: '100644', type: 'blob', sha, ...extra });

async function person(name) {
  const { code } = await newCode({ name });
  codes.push(code);
  return { code, name, id: personOf(code) };
}

/** A Worker request, recorded in `seen`. `code` → Authorization: Bearer (as GitHubClient sends its token). */
async function req(path, { code, method = 'GET', body, headers = {}, now, origin } = {}) {
  const h = { ...headers };
  if (code) h.authorization = `Bearer ${code}`;
  const res = await call(path, { method, body, headers: h, now, origin });
  seen.push({ path, status: res.status, headers: [...res.headers].map(([k, v]) => `${k}: ${v}`).join('\n'), text: res.text });
  return res;
}

/** The proxy for library `lib`: /shared/<lib>/gh/repos/team/library<path>. */
const proxy = (lib, path, opts) => req(`/shared/${lib}/gh/repos/team/library${path}`, opts);

/** A request with a raw (un-normalised) request target, as a hand-written client could send it. */
function rawRequest(target, { method = 'GET', headers = {}, body = null, chunks = null } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: WORKER_PORT, method, path: target, headers }, (res) => {
      const parts = [];
      res.on('data', (c) => parts.push(c));
      res.on('end', () => {
        const text = Buffer.concat(parts).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* not JSON */ }
        seen.push({ path: target, status: res.statusCode, headers: JSON.stringify(res.headers), text });
        resolve({ status: res.statusCode, headers: res.headers, text, json });
        r.destroy();
      });
    });
    r.on('error', reject);
    if (chunks) {
      for (const c of chunks) r.write(c);
      r.end();
    } else {
      r.end(body ?? undefined);
    }
  });
}

/** GitHub-shaped error ({ message }) with the given status; returns the message. */
function ghErr(res, status, re = KOREAN) {
  assert.equal(res.status, status, `${res.status} ${res.text}`);
  assert.equal(typeof res.json?.message, 'string', res.text);
  if (re) assert.match(res.json.message, re);
  return res.json.message;
}

const headOf = (gh, [o, n] = TEAM, branch = 'main') => {
  const repo = gh.repo(o, n);
  const commit = repo.refs.get(`heads/${branch}`);
  return { commit, tree: commit && repo.get(commit, 'commit').tree };
};

/** Sha of the subtree at `path` of the head tree, read from the fake's objects. */
function treeAt(gh, path, [o, n] = TEAM) {
  const repo = gh.repo(o, n);
  let sha = headOf(gh, [o, n]).tree;
  for (const part of path.split('/')) sha = repo.get(sha, 'tree').entries.find((e) => e.name === part).sha;
  return sha;
}

const count = (gh, method, re) => gh.log.filter((e) => e.method === method && re.test(e.path)).length;

/** Fresh team repo with shared files and per-person files of A and B; returns the head commit. */
function seed(gh, A, B, extra = {}, repo = TEAM) {
  gh.createRepo(...repo, { private: true });
  return gh.commitFiles(...repo, {
    'README.md': README_TEXT,
    'library.json': libraryJson([{ id: 'p1', title: 'Sepsis' }]),
    'papers/p1/paper.pdf': PDF(2000),
    'papers/p1/translation.json': '{"version":1,"items":{}}',
    [`people/${A.id}/papers/p1/annotations.json`]: '{"version":1,"items":[{"id":"a"}]}',
    [`people/${B.id}/papers/p1/annotations.json`]: '{"version":1,"items":[{"id":"b"}]}',
    [`people/${B.id}/papers/p1/ai.json`]: '{"version":1,"summary":{"markdown":"B만 보는 요약"}}',
    ...extra,
  }, { message: 'initial' });
}

/** POST git/blobs as GitHubClient sends it. */
function upload(code, bytes, lib = 'team') {
  const body = JSON.stringify({ encoding: 'base64', content: Buffer.from(bytes).toString('base64') });
  return proxy(lib, '/git/blobs', { code, method: 'POST', body, headers: { 'content-type': 'application/json' } });
}

async function blobSha(code, bytes, lib = 'team') {
  const res = await upload(code, bytes, lib);
  assert.equal(res.status, 201, res.text);
  return res.json.sha;
}

const postTree = (code, body, opts = {}) => proxy(opts.lib || 'team', '/git/trees', { code, method: 'POST', body, now: opts.now });
const postCommit = (code, body, opts = {}) => proxy(opts.lib || 'team', '/git/commits', { code, method: 'POST', body, now: opts.now });
const patchRef = (code, body, lib = 'team') => proxy(lib, '/git/refs/heads/main', { code, method: 'PATCH', body });

/** tree → commit → ref through the proxy, as one GitHubClient.commit(); returns the new head. */
async function commitVia(gh, who, entries, message) {
  const head = headOf(gh);
  const tree = await postTree(who.code, { base_tree: head.tree, tree: entries });
  assert.equal(tree.status, 201, tree.text);
  const commit = await postCommit(who.code, { message, tree: tree.json.sha, parents: [head.commit] });
  assert.equal(commit.status, 201, commit.text);
  const ref = await patchRef(who.code, { sha: commit.json.sha, force: false });
  assert.equal(ref.status, 200, ref.text);
  return commit.json.sha;
}

export async function setup() {
  return { A: await person('김민지'), B: await person('박서준') };
}

export const tests = [
  {
    name: 'GET /shared: libraries, personId = sha256(code)[0:16], name; no / wrong / disabled code → 401 (nothing sent to GitHub)',
    fn: async ({ A, gh }) => {
      const mark = gh.log.length;
      const res = await req('/shared', { code: A.code });
      assert.equal(res.status, 200, res.text);
      assert.deepEqual(res.json, {
        libraries: [{ id: 'team', name: '공용 서재' }, { id: 'small', name: '작은 서재' }, { id: 'lab', name: '연구실 서재' }],
        personId: A.id, name: '김민지',
      });
      const typed = await req('/shared', { headers: { 'x-api-key': A.code.toLowerCase().replace(/-/g, ' ') } });
      assert.equal(typed.json?.personId, A.id, typed.text);
      for (const opts of [{}, { code: 'PR-ZZZZ-ZZZZ' }, { code: 'hello' }]) {
        const r = await req('/shared', opts);
        assert.equal(r.status, 401, r.text);
        assert.equal(r.json?.error?.type, 'authentication_error');
        assert.match(r.json.error.message, KOREAN);
      }
      const off = await person('중지된 동료');
      const patched = await call(`/relay/admin/codes/${off.code}`, { method: 'PATCH', admin: true, body: { active: false } });
      assert.equal(patched.status, 200, patched.text);
      assert.equal((await req('/shared', { code: off.code })).status, 401);
      assert.equal((await req('/shared/team/activity', { code: off.code })).status, 401);
      const viaProxy = ghErr(await proxy('team', '', { code: off.code }), 401, /사용이 중지/);
      ghErr(await proxy('team', '/git/ref/heads/main', { code: 'PR-ZZZZ-ZZZZ' }), 401);
      ghErr(await proxy('team', '/git/ref/heads/main', {}), 401, /초대 코드가 없습니다/);
      assert.equal(gh.log.length, mark, 'nothing may reach GitHub');
      return `personId ${A.id}; typed variant normalised; disabled code via proxy → 401 "${viaProxy}"`;
    },
  },
  {
    name: 'GET /repos/team/library: sanitised repo object; a library whose repo is public is refused (503)',
    fn: async ({ A, B, gh }) => {
      seed(gh, A, B);
      gh.createRepo(...LAB, { private: false });
      gh.commitFiles(...LAB, { 'library.json': '{}' });
      const res = await proxy('team', '', { code: A.code });
      assert.equal(res.status, 200, res.text);
      assert.deepEqual(res.json, {
        name: 'library', full_name: 'team/library', private: true, visibility: 'private', default_branch: 'main',
        permissions: { pull: true, push: true },
      });
      assert.ok(!res.text.includes('dindoopark') && !res.text.includes('paper-team-library'), res.text);
      const lab = ghErr(await proxy('lab', '', { code: A.code }), 503, /비공개/);
      return `team → sanitised; lab (public) → 503 "${lab}"`;
    },
  },
  {
    name: 'only the listed routes: other owners/repos/branches, methods, encodings, traversal and lookalikes → 404, nothing forwarded',
    fn: async ({ A, B, gh }) => {
      seed(gh, A, B);
      const H = headOf(gh);
      const base = '/shared/team/gh/repos';
      const cases = [
        ['GET', `${base}/dindoopark/paper-team-library`],
        ['GET', `${base}/dindoopark/paper-team-library/git/ref/heads/main`],
        ['GET', `${base}/Team/library`],
        ['GET', `${base}/team/Library`],
        ['GET', `${base}/team/library.git`],
        ['GET', `${base}/team/library2/git/ref/heads/main`],
        ['GET', `${base}/team/librаry/git/ref/heads/main`], // Cyrillic а
        ['GET', `${base}/tеam/library`], // Cyrillic е
        ['GET', `${base}/team/library/git/ref/heads/other`],
        ['GET', `${base}/team/library/git/ref/heads/Main`],
        ['GET', `${base}/team/library/git/refs`],
        ['GET', `${base}/team/library/git/refs/heads/main`],
        ['DELETE', `${base}/team/library/git/refs/heads/main`],
        ['POST', `${base}/team/library/git/refs/heads/main`],
        ['PATCH', `${base}/team/library/git/refs/heads/other`],
        ['GET', `${base}/team/library/contents/library.json`],
        ['PUT', `${base}/team/library/contents/library.json`],
        ['DELETE', `${base}/team/library/contents/README.md`],
        ['GET', `${base}/team/library/contents/README.md`],
        ['GET', `${base}/team/library/git/trees/${H.tree.toUpperCase()}`],
        ['GET', `${base}/team/library/git/trees/${H.tree}/`],
        ['GET', `${base}/team/library/git/blobs/${H.tree.slice(1)}`],
        ['DELETE', `${base}/team/library/git/blobs/${H.tree}`],
        ['POST', `${base}/team/library/git/tags`],
        ['POST', `${base}/team/library/merges`],
        ['GET', `${base}/team/library/commits`],
        ['GET', `${base}/team/library/collaborators`],
        ['PATCH', `${base}/team/library`],
        ['DELETE', `${base}/team/library`],
        ['GET', `${base}/team`],
        ['GET', '/shared/team/gh/user'],
        ['GET', '/shared/team/gh'],
        ['GET', '/shared/nope/gh/repos/team/library'],
        ['GET', '/shared/TEAM/gh/repos/team/library'],
      ];
      const raw = [
        `${base}/team/library/../../dindoopark/paper-team-library/git/ref/heads/main`,
        `${base}/team/library/%2e%2e/%2e%2e/dindoopark/paper-team-library/git/ref/heads/main`,
        `${base}/team/library/%2E%2E/%2E%2E/dindoopark/paper-team-library`,
        `${base}/team%2flibrary/git/ref/heads/main`,
        `${base}/team/library%2f..%2f..%2fdindoopark%2fpaper-team-library`,
        `${base}/team/library/git/ref/heads/%6Dain`,
        `${base}/team/library/git/ref/heads/main%00`,
        `${base}/team/library/git/ref/heads/main/..%2fother`,
        `${base}/team/library\\..\\..\\dindoopark\\paper-team-library`,
        `${base}/team/library\\..\\..\\dindoopark\\paper-team-library\\git\\ref\\heads\\main`,
        '/shared/%74eam/gh/repos/team/library',
        '/shared/team/gh/repos/team/library/git/ref/heads/main/../../../../../../dindoopark/paper-team-library/git/ref/heads/main',
      ];
      const mark = gh.log.length;
      for (const [method, path] of cases) ghErr(await req(path, { code: A.code, method, body: method === 'GET' || method === 'DELETE' ? undefined : {} }), 404);
      for (const target of raw) {
        const r = await rawRequest(target, { headers: { authorization: `Bearer ${A.code}` } });
        assert.equal(r.status, 404, `${target} → ${r.status} ${r.text}`);
      }
      const reached = gh.log.slice(mark).map((e) => `${e.method} ${e.path}`);
      assert.deepEqual(reached, [], 'nothing may be forwarded');
      return `${cases.length} routes + ${raw.length} raw request targets → 404, 0 forwarded`;
    },
  },
  {
    name: 'tree listings hide other people: recursive and level-by-level, people/<other> trees unreachable, their blob shas never listed',
    fn: async ({ A, B, gh }) => {
      seed(gh, A, B);
      const H = headOf(gh);
      const listing = async (who, sha, recursive) => {
        const r = await proxy('team', `/git/trees/${sha}${recursive ? '?recursive=1' : ''}`, { code: who.code });
        assert.equal(r.status, 200, r.text);
        return r;
      };
      const recA = await listing(A, H.tree, true);
      const pathsA = recA.json.tree.map((e) => e.path);
      assert.ok(pathsA.includes(`people/${A.id}/papers/p1/annotations.json`) && pathsA.includes('people') && pathsA.includes(`people/${A.id}`));
      assert.ok(pathsA.includes('papers/p1/paper.pdf') && pathsA.includes('papers/p1/translation.json') && pathsA.includes('library.json'));
      assert.deepEqual(pathsA.filter((p) => p.startsWith(`people/${B.id}`)), []);
      assert.ok(!recA.text.includes(B.id), 'B\'s person id must not be listed to A');
      const bFiles = [...gh.files(...TEAM)].filter(([p]) => p.startsWith(`people/${B.id}/`)).map(([, f]) => f.sha);
      for (const sha of bFiles) assert.ok(!recA.text.includes(sha), 'B\'s blob shas must not be listed to A');
      assert.ok(recA.json.tree.every((e) => !('url' in e)), 'entries are reduced to path/mode/type/sha/size');
      const pathsB = (await listing(B, H.tree, true)).json.tree.map((e) => e.path);
      assert.ok(pathsB.includes(`people/${B.id}/papers/p1/ai.json`));
      assert.deepEqual(pathsB.filter((p) => p.startsWith(`people/${A.id}`)), []);

      const rootA = await listing(A, H.tree, false);
      assert.deepEqual(rootA.json.tree.map((e) => e.path), ['README.md', 'library.json', 'papers', 'people']);
      const peopleSha = rootA.json.tree.find((e) => e.path === 'people').sha;
      assert.deepEqual((await listing(A, peopleSha, false)).json.tree.map((e) => e.path), [A.id]);
      assert.deepEqual((await listing(B, peopleSha, false)).json.tree.map((e) => e.path), [B.id]);
      assert.deepEqual((await listing(A, peopleSha, true)).json.tree.map((e) => e.path).filter((p) => p.startsWith(B.id)), []);
      assert.deepEqual((await listing(A, treeAt(gh, 'papers'), false)).json.tree.map((e) => e.path), ['p1']);
      assert.deepEqual((await listing(A, treeAt(gh, `people/${A.id}/papers/p1`), false)).json.tree.map((e) => e.path), ['annotations.json']);
      const denied = [`people/${B.id}`, `people/${B.id}/papers`, `people/${B.id}/papers/p1`];
      for (const path of denied) {
        for (const q of ['', '?recursive=1']) ghErr(await proxy('team', `/git/trees/${treeAt(gh, path)}${q}`, { code: A.code }), 404, null);
      }
      ghErr(await proxy('team', `/git/trees/${'f'.repeat(40)}`, { code: A.code }), 404, null);
      return `A sees ${pathsA.length} entries (own people/${A.id} only), people/ tree lists [${A.id}] to A and [${B.id}] to B; `
        + `${denied.length} subtrees of B → 404 (recursive and not)`;
    },
  },
  {
    name: 'POST git/trees base_tree: missing → 403, unknown → 409, current → 201, a head of the last 10 min → 201, older → 409',
    fn: async ({ A, B, gh }) => {
      seed(gh, A, B);
      const H1 = headOf(gh);
      const sha = await blobSha(A.code, Buffer.from(libraryJson([{ id: 'p1', title: 'Sepsis 2' }])));
      const entries = [file('library.json', sha)];
      const trees = () => count(gh, 'POST', /\/git\/trees$/);
      const mark = trees();
      const missing = ghErr(await postTree(A.code, { tree: entries }), 403, /base_tree/);
      ghErr(await postTree(A.code, { base_tree: 'not-a-sha', tree: entries }), 403);
      ghErr(await postTree(A.code, { base_tree: H1.tree, tree: entries, extra: true }), 403, /extra/);
      const unknown = ghErr(await postTree(A.code, { base_tree: 'f'.repeat(40), tree: entries }), 409);
      ghErr(await postTree(A.code, { base_tree: treeAt(gh, 'papers'), tree: entries }), 409);
      assert.equal(trees(), mark, 'refused trees are not forwarded');
      assert.equal((await postTree(A.code, { base_tree: H1.tree, tree: entries })).status, 201);
      gh.commitFiles(...TEAM, { 'papers/p1/translation.json': '{"version":1,"items":{"s1":{"t":"번역"}}}' }, { message: '[박서준] 번역' });
      const H2 = headOf(gh);
      assert.equal((await postTree(A.code, { base_tree: H1.tree, tree: entries })).status, 201, 'H1 was the head a moment ago');
      const later = Date.now() + 11 * MIN;
      const stale = ghErr(await postTree(A.code, { base_tree: H1.tree, tree: entries }, { now: later }), 409);
      assert.equal((await postTree(A.code, { base_tree: H2.tree, tree: entries }, { now: later })).status, 201);
      return `no base → 403 "${missing}"; unknown → 409 "${unknown}"; H1 after H2 → 201, 11 min later → 409 "${stale}"`;
    },
  },
  {
    name: 'POST git/trees paths: other person\'s files, deleting shared files, replacing a PDF, traversal, lookalikes, symlinks, subtrees, inline content → 403',
    fn: async ({ A, B, gh }) => {
      seed(gh, A, B);
      const H = headOf(gh);
      const json = await blobSha(A.code, Buffer.from('{"version":1,"items":[]}'));
      const pdf = await blobSha(A.code, PDF(1500, 'z'));
      const denied = [
        [file(`people/${B.id}/papers/p1/annotations.json`, json), /다른 사람/],
        [file(`people/${B.id}/papers/p1/ai.json`, null), /다른 사람/],
        [file(`people/${B.id}/papers/p9/ai.json`, json), /다른 사람/],
        [file('papers/p1/paper.pdf', null), /지울 수 없/],
        [file('papers/p1/translation.json', null), /지울 수 없/],
        [file('library.json', null), /지울 수 없/],
        [file('README.md', null), /둘 수 없는/],
        [file('papers/p1', null), /둘 수 없는/],
        [file(`people/${A.id}`, null), /둘 수 없는/],
        [file('papers/p1/paper.pdf', pdf), /PDF/],
        [file('README.md', json), /둘 수 없는/],
        [file('papers/../library.json', json), /둘 수 없는/],
        [file('papers/%2e%2e/library.json', json), /둘 수 없는/],
        [file('papers\\p1\\paper.pdf', pdf), /둘 수 없는/],
        [file(`people/${A.id}/../${B.id}/papers/p1/ai.json`, json), /둘 수 없는/],
        [file(`people/${A.id}/papers/../../${B.id}/papers/p1/ai.json`, json), /둘 수 없는/],
        [file('ｌibrary.json', json), /둘 수 없는/],
        [file('librаry.json', json), /둘 수 없는/],
        [file('papers/p1/paper.pdf ', pdf), /둘 수 없는/],
        [file('papers/p１/paper.pdf', pdf), /둘 수 없는/],
        [file('.github/workflows/run.yml', json), /둘 수 없는/],
        [file('library.json', json, { mode: '120000' }), /일반 파일/],
        [file('library.json', json, { mode: '100755' }), /일반 파일/],
        [{ path: 'papers', mode: '040000', type: 'tree', sha: treeAt(gh, 'papers') }, /둘 수 없는/],
        [{ path: 'papers/p2/paper.pdf', mode: '040000', type: 'tree', sha: treeAt(gh, 'papers') }, /일반 파일/],
        [{ path: 'library.json', mode: '160000', type: 'commit', sha: H.commit }, /일반 파일/],
        [{ path: 'library.json', mode: '100644', type: 'blob', content: '{}' }, /형식/],
      ];
      const trees = () => count(gh, 'POST', /\/git\/trees$/);
      const mark = trees();
      for (const [entry, re] of denied) {
        const r = await postTree(A.code, { base_tree: H.tree, tree: [file(`people/${A.id}/papers/p1/ai.json`, json), entry] });
        ghErr(r, 403, re);
      }
      assert.equal(trees(), mark, 'refused trees are not forwarded');
      const before = gh.files(...TEAM);
      const libWithP2 = await blobSha(A.code, Buffer.from(libraryJson([{ id: 'p1', title: 'Sepsis' }, { id: 'p2', title: 'ARDS' }])));
      await commitVia(gh, A, [
        file('library.json', libWithP2), file('papers/p2/paper.pdf', pdf), file('papers/p2/translation.json', json),
        file('papers/p1/paper.pdf', before.get('papers/p1/paper.pdf').sha), // the same bytes again: allowed
        file(`people/${A.id}/papers/p1/ai.json`, json), file(`people/${A.id}/papers/p1/annotations.json`, null),
      ], '논문 추가');
      const after = gh.files(...TEAM);
      assert.equal(after.get('papers/p2/paper.pdf')?.sha, pdf);
      assert.equal(after.has(`people/${A.id}/papers/p1/annotations.json`), false);
      for (const [p, f] of before) if (p.startsWith(`people/${B.id}/`)) assert.equal(after.get(p)?.sha, f.sha, `${p} must survive`);
      assert.equal(after.get('papers/p1/paper.pdf').sha, before.get('papers/p1/paper.pdf').sha);
      return `${denied.length} refused (403, not forwarded); allowed commit added papers/p2, deleted own annotations, kept B's files`;
    },
  },
  {
    name: 'POST git/commits: parents must be [current head], tree made here by this person on that head; message → "[name] first line"',
    fn: async ({ A, B, gh }) => {
      seed(gh, A, B);
      const H1 = headOf(gh);
      const json = await blobSha(A.code, Buffer.from(libraryJson([{ id: 'p1', title: 'A의 제목' }])));
      const t1 = (await postTree(A.code, { base_tree: H1.tree, tree: [file('library.json', json)] })).json.sha;
      const commits = () => count(gh, 'POST', /\/git\/commits$/);
      const mark = commits();
      ghErr(await postCommit(A.code, { message: 'x', tree: t1, parents: [] }), 403, /부모/);
      ghErr(await postCommit(A.code, { message: 'x', tree: t1, parents: [H1.commit, H1.commit] }), 403, /부모/);
      ghErr(await postCommit(A.code, { message: 'x', tree: t1, parents: ['zz'] }), 403);
      ghErr(await postCommit(A.code, { message: 'x', tree: t1 }), 403);
      ghErr(await postCommit(A.code, { message: 'x', tree: t1, parents: ['f'.repeat(40)] }), 409);
      ghErr(await postCommit(A.code, { message: 'x', tree: 'f'.repeat(40), parents: [H1.commit] }), 403, /트리/);
      ghErr(await postCommit(B.code, { message: 'x', tree: t1, parents: [H1.commit] }), 403, /트리/);
      ghErr(await postCommit(A.code, { message: 'x', tree: t1, parents: [H1.commit], author: { name: 'x', email: 'x@y' } }), 403, /author/);
      assert.equal(commits(), mark, 'refused commits are not forwarded');

      // Someone else pushes: a tree built on the old head must not be committed on top of the new one (that would
      // silently revert their change), and the old head is no longer a valid parent.
      gh.commitFiles(...TEAM, { [`people/${B.id}/papers/p1/ai.json`]: '{"version":1,"summary":{"markdown":"B 새 요약"}}' }, { message: '[박서준] 요약' });
      const H2 = headOf(gh);
      const revert = ghErr(await postCommit(A.code, { message: 'x', tree: t1, parents: [H2.commit] }), 403, /트리/);
      ghErr(await postCommit(A.code, { message: 'x', tree: H1.tree, parents: [H2.commit] }), 403, /트리/);
      const stale = ghErr(await postCommit(A.code, { message: 'x', tree: t1, parents: [H1.commit] }), 409);
      assert.equal(commits(), mark);

      const t2 = (await postTree(A.code, { base_tree: H2.tree, tree: [file('library.json', json)] })).json.sha;
      const long = `제목 수정 ${'가'.repeat(300)}`;
      const ok = await postCommit(A.code, { message: `논문 제목 바꿈: people/${A.id}/papers/p1/ai.json\n둘째 줄`, tree: t2, parents: [H2.commit] });
      assert.equal(ok.status, 201, ok.text);
      assert.equal(ok.json.message, '[김민지] 논문 제목 바꿈: people/…/papers/p1/ai.json');
      assert.equal(gh.repo(...TEAM).get(ok.json.sha, 'commit').message, ok.json.message);
      assert.ok(!ok.text.includes('fake@example.test'));
      const empty = await postCommit(A.code, { message: long, tree: H2.tree, parents: [H2.commit] });
      assert.equal(empty.status, 201, empty.text);
      assert.equal([...empty.json.message].length, 200);
      return `[] / 2 parents / author → 403; stale parent → 409 "${stale}"; old tree on new head → 403 "${revert}"; message "${ok.json.message}"`;
    },
  },
  {
    name: 'PATCH git/refs: force refused (403), not a fast-forward → GitHub\'s 422 unchanged, wrong branch → 404',
    fn: async ({ A, B, gh }) => {
      seed(gh, A, B);
      const H1 = headOf(gh);
      const json = await blobSha(A.code, Buffer.from('{"version":1,"items":[{"id":"a2"}]}'));
      const tree = (await postTree(A.code, { base_tree: H1.tree, tree: [file(`people/${A.id}/papers/p1/annotations.json`, json)] })).json.sha;
      const c = (await postCommit(A.code, { message: '메모', tree, parents: [H1.commit] })).json.sha;
      const patches = () => count(gh, 'PATCH', /\/git\/refs\//);
      const mark = patches();
      const force = ghErr(await patchRef(A.code, { sha: c, force: true }), 403, /force/);
      ghErr(await patchRef(A.code, { sha: c, force: 'true' }), 403, /force/);
      ghErr(await patchRef(A.code, { sha: c, force: 1 }), 403, /force/);
      ghErr(await patchRef(A.code, { sha: c, force: false, extra: 1 }), 403);
      ghErr(await proxy('team', '/git/refs/heads/other', { code: A.code, method: 'PATCH', body: { sha: c } }), 404);
      assert.equal(patches(), mark, 'refused ref updates are not forwarded');
      gh.commitFiles(...TEAM, { 'papers/p1/translation.json': '{"version":1,"items":{"s2":{}}}' }, { message: '[박서준] 번역' });
      const H2 = headOf(gh);
      const nonFf = await patchRef(A.code, { sha: c, force: false });
      ghErr(nonFf, 422, null);
      assert.equal(nonFf.json.message, 'Update is not a fast forward');
      assert.equal(headOf(gh).commit, H2.commit);
      const tree2 = (await postTree(A.code, { base_tree: H2.tree, tree: [file(`people/${A.id}/papers/p1/annotations.json`, json)] })).json.sha;
      const c2 = (await postCommit(A.code, { message: '메모', tree: tree2, parents: [H2.commit] })).json.sha;
      const ok = await patchRef(A.code, { sha: c2 });
      assert.equal(ok.status, 200, ok.text);
      assert.deepEqual(ok.json, { ref: 'refs/heads/main', object: { sha: c2, type: 'commit' } });
      assert.equal(headOf(gh).commit, c2);
      assert.equal(gh.files(...TEAM).get(`people/${B.id}/papers/p1/ai.json`)?.sha, gitSha(Buffer.from('{"version":1,"summary":{"markdown":"B만 보는 요약"}}')));
      return `force → 403 "${force}"; non-fast-forward → 422 "${nonFf.json.message}"; fast-forward → 200`;
    },
  },
  {
    name: 'empty repo: only the README bootstrap (PUT contents/README.md); a repo without the branch: no base_tree, parents [], POST refs once',
    fn: async ({ A, B, gh }) => {
      gh.createRepo(...TEAM, { private: true });
      ghErr(await proxy('team', '/git/ref/heads/main', { code: A.code }), 409, /empty/);
      const probe = await proxy('team', '/git/blobs', { code: A.code, method: 'POST', body: { content: '', encoding: 'utf-8' } });
      ghErr(probe, 409, null); // what GitHubClient.checkAccess() expects of an empty repo
      ghErr(await postTree(A.code, { tree: [] }), 409, null);
      ghErr(await postCommit(A.code, { message: 'x', tree: 'a'.repeat(40), parents: [] }), 409, null);
      const content = Buffer.from(README_TEXT).toString('base64');
      ghErr(await proxy('team', '/contents/README.md', { code: A.code, method: 'PUT', body: { message: 'x', content, branch: 'other' } }), 403);
      ghErr(await proxy('team', '/contents/README.md', { code: A.code, method: 'PUT', body: { message: 'x', content, sha: 'a'.repeat(40) } }), 403);
      ghErr(await proxy('team', '/contents/README.md', { code: A.code, method: 'PUT', body: { message: 'x', content: '<html>' } }), 422);
      const boot = await proxy('team', '/contents/README.md', {
        code: A.code, method: 'PUT', body: { message: '논문 리더 데이터 저장소 시작', content, branch: 'main' },
      });
      assert.equal(boot.status, 201, boot.text);
      assert.equal(boot.json.commit.sha, headOf(gh).commit);
      assert.equal(gh.commits(...TEAM)[0].message, '[김민지] 논문 리더 데이터 저장소 시작');
      const again = ghErr(await proxy('team', '/contents/README.md', { code: A.code, method: 'PUT', body: { message: 'x', content } }), 422);

      // A non-empty repo whose branch does not exist yet.
      gh.createRepo(...TEAM, { private: true });
      gh.commitFiles(...TEAM, { 'README.md': README_TEXT }, { branch: 'other' });
      ghErr(await proxy('team', '/git/ref/heads/main', { code: A.code }), 404, null);
      const json = await blobSha(A.code, Buffer.from(libraryJson([])));
      const otherTree = gh.repo(...TEAM).get(gh.repo(...TEAM).refs.get('heads/other'), 'commit').tree;
      ghErr(await postTree(A.code, { base_tree: otherTree, tree: [file('library.json', json)] }), 403, /브랜치/);
      ghErr(await postTree(A.code, { tree: [file('library.json', json), file(`people/${A.id}/papers/p1/ai.json`, null)] }), 403);
      const tree = await postTree(A.code, { tree: [file('library.json', json)] });
      assert.equal(tree.status, 201, tree.text);
      ghErr(await postCommit(A.code, { message: 'x', tree: otherTree, parents: [] }), 403, /트리/);
      const commit = await postCommit(A.code, { message: '시작', tree: tree.json.sha, parents: [] });
      assert.equal(commit.status, 201, commit.text);
      ghErr(await proxy('team', '/git/refs', { code: A.code, method: 'POST', body: { ref: 'refs/heads/other', sha: commit.json.sha } }), 403);
      const otherHead = gh.repo(...TEAM).refs.get('heads/other');
      ghErr(await proxy('team', '/git/refs', { code: A.code, method: 'POST', body: { ref: 'refs/heads/main', sha: otherHead } }), 403, /트리/);
      ghErr(await proxy('team', '/git/refs', { code: B.code, method: 'POST', body: { ref: 'refs/heads/main', sha: commit.json.sha } }), 403, /트리/);
      ghErr(await proxy('team', '/git/refs', { code: A.code, method: 'POST', body: { ref: 'refs/heads/main', sha: commit.json.sha, force: true } }), 403);
      const ref = await proxy('team', '/git/refs', { code: A.code, method: 'POST', body: { ref: 'refs/heads/main', sha: commit.json.sha } });
      assert.equal(ref.status, 201, ref.text);
      assert.equal(headOf(gh).commit, commit.json.sha);
      ghErr(await proxy('team', '/git/refs', { code: A.code, method: 'POST', body: { ref: 'refs/heads/main', sha: commit.json.sha } }), 422, null);
      return `empty → 409 everywhere but the README PUT (201, then 422 "${again}"); missing branch → tree without base, parents [], POST refs 201 then 422`;
    },
  },
  {
    name: 'size cap: a PDF (or any blob over 8 MB) that would pass maxBytes → 413 before upload; JSON still saves; > 100 MB / no length refused',
    fn: async ({ A, gh }) => {
      gh.createRepo(...SMALL, { private: true });
      gh.commitFiles(...SMALL, { 'library.json': libraryJson([]), 'papers/p1/paper.pdf': PDF(700_000) }, { message: 'initial' });
      const blobs = () => count(gh, 'POST', /\/git\/blobs$/);
      const mark = blobs();
      const full = ghErr(await upload(A.code, PDF(400_000, 'b'), 'small'), 413, /저장 공간/);
      assert.match(full, /MB/);
      const utf8 = JSON.stringify({ encoding: 'utf-8', content: `%PDF-1.4 ${'x'.repeat(600_000)}` });
      ghErr(await proxy('small', '/git/blobs', { code: A.code, method: 'POST', body: utf8, headers: { 'content-type': 'application/json' } }), 413, /저장 공간/);
      const big = Buffer.alloc(9 * 1024 * 1024, 'q');
      ghErr(await upload(A.code, big, 'small'), 413, /저장 공간/);
      assert.equal(blobs(), mark, 'refused uploads are not forwarded');
      const fine = PDF(200_000, 'c');
      assert.equal(await blobSha(A.code, fine, 'small'), gitSha(fine));
      const note = Buffer.from(JSON.stringify({ version: 1, items: Array.from({ length: 500 }, (_, i) => ({ id: `n${i}`, note: '메모'.repeat(20) })) }));
      assert.equal(await blobSha(A.code, note, 'small'), gitSha(note));
      gh.createRepo(...TEAM, { private: true });
      gh.commitFiles(...TEAM, { 'library.json': libraryJson([]) });
      assert.equal(await blobSha(A.code, big, 'team'), gitSha(big), 'a big blob fits a library with room');

      const before = blobs();
      // An honest body one byte over 100 MB (a lying Content-Length only makes the local dev server wait for it).
      const n = 100 * 1024 * 1024 + 1;
      const body = Buffer.alloc(n, 'A');
      body.write('{"encoding":"base64","content":"JVBERi0x', 0);
      body.write('"}', n - 2);
      const huge = await proxy('team', '/git/blobs', { code: A.code, method: 'POST', body, headers: { 'content-type': 'application/json' } });
      ghErr(huge, 413, /100MB/);
      const chunked = await rawRequest('/shared/small/gh/repos/team/library/git/blobs', {
        method: 'POST', chunks: ['{"encoding":"base64",', '"content":"JVBERi0x"}'],
        headers: { authorization: `Bearer ${A.code}`, 'content-type': 'application/json' },
      });
      ghErr(chunked, 411);
      assert.equal(blobs(), before);
      return `400 KB PDF on 700 KB of 1 MB → 413 "${full}"; 200 KB PDF and 85 KB JSON → 201; 9 MB blob 413 (small) / 201 (team); `
        + `100 MB + 1 B body → ${huge.status}; chunked → 411`;
    },
  },
  {
    name: 'GET /shared/<lib>/activity: newest first, who = the code\'s name, no e-mail addresses, person ids or tokens',
    fn: async ({ A, B, gh }) => {
      seed(gh, A, B);
      const json = await blobSha(A.code, Buffer.from(libraryJson([{ id: 'p1', title: 'Sepsis' }, { id: 'p2', title: 'ARDS' }])));
      await commitVia(gh, A, [file('library.json', json)], '논문 추가: ARDS');
      const note = await blobSha(B.code, Buffer.from('{"version":1,"items":[{"id":"b2"}]}'));
      await commitVia(gh, B, [file(`people/${B.id}/papers/p1/annotations.json`, note)], `논문 리더 동기화: people/${B.id}/papers/p1/annotations.json`);
      const res = await req('/shared/team/activity?limit=10', { code: A.code });
      assert.equal(res.status, 200, res.text);
      const { items } = res.json;
      assert.deepEqual(items.map((i) => [i.who, i.summary]), [
        ['박서준', '논문 리더 동기화: people/…/papers/p1/annotations.json'],
        ['김민지', '논문 추가: ARDS'],
        [null, 'initial'],
      ]);
      assert.ok(items.every((i) => Number.isFinite(Date.parse(i.ts))), JSON.stringify(items));
      assert.deepEqual(Object.keys(items[0]).sort(), ['summary', 'ts', 'who']);
      for (const secret of ['fake@example.test', 'Fake Owner', 'fake-owner', A.id, B.id, TEAM_TOKEN, A.code, B.code]) {
        assert.ok(!res.text.includes(secret), `activity leaks ${secret}`);
      }
      assert.equal((await req('/shared/team/activity?limit=1', { code: B.code })).json.items.length, 1);
      assert.equal((await req('/shared/nope/activity', { code: A.code })).status, 404);
      assert.equal((await req('/shared/team/activity', { code: A.code, method: 'POST', body: {} })).status, 405);
      return items.map((i) => `${i.who ?? '—'}: ${i.summary}`).join(' | ');
    },
  },
  {
    name: 'admin: stats { bytes, papers, people } and purge (one commit deleting files of papers trashed > 30 days ago; tombstones stay)',
    fn: async ({ A, B, gh }) => {
      const now = Date.now();
      const library = libraryJson([
        { id: 'p_live', title: '살아 있음', updatedAt: now - 90 * DAY },
        { id: 'p_new', title: '5일 전 삭제', deleted: true, deletedAt: now - 5 * DAY, updatedAt: now - 5 * DAY },
        { id: 'p_old', title: '31일 전 삭제', deleted: true, deletedAt: now - 31 * DAY, updatedAt: now - 31 * DAY },
        { id: 'p_old2', title: '오래전 삭제', deleted: true, updatedAt: now - 40 * DAY },
      ]);
      gh.createRepo(...TEAM, { private: true });
      const files = { 'README.md': README_TEXT, 'library.json': library };
      for (const id of ['p_live', 'p_new', 'p_old', 'p_old2']) {
        files[`papers/${id}/paper.pdf`] = PDF(3000, id.at(-1));
        files[`papers/${id}/translation.json`] = `{"version":1,"items":{},"id":"${id}"}`;
      }
      files[`people/${A.id}/papers/p_old/annotations.json`] = '{"version":1,"items":[]}';
      files[`people/${B.id}/papers/p_old/ai.json`] = '{"version":1}';
      files[`people/${B.id}/papers/p_live/ai.json`] = '{"version":1,"x":1}';
      // The tombstones must already be 30+ days old in history — purge no longer trusts a client-written deletedAt
      // on its own (see the back-dated-deletedAt test), so this snapshot is committed 60 days ago.
      gh.commitFiles(...TEAM, files, { message: 'initial', time: now - 60 * DAY });
      const tree = gh.files(...TEAM);
      const sizes = new Map([...tree.keys()].map((p) => [p, gh.readFile(...TEAM, p).length]));
      const size = (p) => sizes.get(p);
      const total = [...tree.keys()].reduce((s, p) => s + size(p), 0);

      const stats = await call('/relay/admin/shared/team/stats', { admin: true });
      assert.equal(stats.status, 200, stats.text);
      assert.deepEqual(stats.json, { bytes: total, papers: 4, people: 2, maxBytes: 4_000_000_000 });
      assert.equal((await call('/relay/admin/shared/team/stats', { admin: 'wrong-admin-token-0123456789' })).status, 401);
      assert.equal((await call('/relay/admin/shared/team/stats', { headers: { authorization: `Bearer ${A.code}` } })).status, 401);
      assert.equal((await call('/relay/admin/shared/nope/stats', { admin: true })).status, 404);
      assert.equal((await call('/relay/admin/shared/team/purge', { admin: true })).status, 405);

      const doomed = [...tree.keys()].filter((p) => /\/p_old2?\//.test(p)).sort();
      const purge = await call('/relay/admin/shared/team/purge', { method: 'POST', admin: true, body: {} });
      assert.equal(purge.status, 200, purge.text);
      assert.deepEqual(purge.json.purged, ['p_old', 'p_old2']);
      assert.equal(purge.json.files, doomed.length);
      assert.equal(purge.json.freedBytes, doomed.reduce((s, p) => s + size(p), 0));
      const after = gh.files(...TEAM);
      for (const p of doomed) assert.ok(!after.has(p), `${p} must be deleted`);
      for (const [p, f] of tree) if (!doomed.includes(p)) assert.equal(after.get(p)?.sha, f.sha, `${p} must stay`);
      const [last] = gh.commits(...TEAM);
      assert.equal(last.sha, purge.json.commitSha);
      assert.equal(last.message, `[관리자] 휴지통 비우기: 30일 지난 논문 2개의 파일 ${doomed.length}개 삭제`);
      assert.deepEqual(last.changed, doomed);
      const again = await call('/relay/admin/shared/team/purge', { method: 'POST', admin: true, body: {} });
      assert.deepEqual(again.json, { purged: [], files: 0, freedBytes: 0, commitSha: null });
      assert.equal(gh.commits(...TEAM).length, 2);
      const act = await req('/shared/team/activity?limit=1', { code: A.code });
      assert.equal(act.json.items[0].who, '관리자');
      const statsAfter = await call('/relay/admin/shared/team/stats', { admin: true });
      assert.equal(statsAfter.json.papers, 2);
      return `stats ${JSON.stringify(stats.json)}; purge removed ${doomed.length} files of p_old, p_old2 (${purge.json.freedBytes} B); second purge no-op`;
    },
  },
  {
    name: 'upstream: GitHub refusing the team token → 502 (not the code\'s fault); rate limits and 5xx pass through with GitHub\'s headers',
    fn: async ({ A, B, gh }) => {
      seed(gh, A, B);
      const ref = /\/git\/ref\/heads\/main$/;
      gh.failNext({ method: 'GET', path: ref, status: 401, body: { message: 'Bad credentials' } });
      const auth = ghErr(await proxy('team', '/git/ref/heads/main', { code: A.code }), 502, /TEAM_GITHUB_TOKEN/);
      gh.failNext({ method: 'GET', path: ref, status: 403, body: { message: 'Resource not accessible by personal access token' } });
      ghErr(await proxy('team', '/git/ref/heads/main', { code: A.code }), 502, /관리자/);
      const reset = String(Math.floor(Date.now() / 1000) + 600);
      gh.failNext({ method: 'GET', path: ref, status: 403, headers: { 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset': reset }, body: { message: 'API rate limit exceeded for user ID 1.' } });
      const limited = await proxy('team', '/git/ref/heads/main', { code: A.code });
      ghErr(limited, 403, /rate limit/);
      assert.equal(limited.headers.get('x-ratelimit-remaining'), '0');
      assert.equal(limited.headers.get('x-ratelimit-reset'), reset);
      gh.failNext({ method: 'GET', path: ref, status: 429, headers: { 'Retry-After': '7' }, body: { message: 'secondary rate limit' } });
      const secondary = await proxy('team', '/git/ref/heads/main', { code: A.code });
      assert.equal(secondary.status, 429);
      assert.equal(secondary.headers.get('retry-after'), '7');
      gh.failNext({ method: 'GET', path: /\/git\/commits\//, status: 503, body: { message: 'Service unavailable' } });
      const commitSha = headOf(gh).commit;
      ghErr(await proxy('team', `/git/commits/${'e'.repeat(40)}`, { code: A.code }), 503, null);
      const normal = await proxy('team', '/git/ref/heads/main', { code: A.code });
      assert.equal(normal.status, 200);
      assert.equal(normal.headers.get('x-ratelimit-limit'), '5000');
      assert.match(normal.headers.get('etag') || '', /^"[0-9a-f]{40}"$/);
      const commit = await proxy('team', `/git/commits/${commitSha}`, { code: A.code });
      assert.equal(commit.status, 200, commit.text);
      assert.deepEqual(Object.keys(commit.json).sort(), ['author', 'committer', 'message', 'parents', 'sha', 'tree']);
      assert.ok(!commit.text.includes('fake@example.test') && !commit.text.includes('Fake Owner'), commit.text);
      gh.setDown(true);
      let down;
      try {
        down = ghErr(await proxy('team', '/git/ref/heads/main', { code: A.code }), 502, /연결하지 못했습니다/);
      } finally {
        gh.setDown(false);
      }
      return `401 → 502 "${auth}"; rate limit 403/429 passed with headers; 503 passed; GitHub down → 502 "${down}"; commit without names/e-mails`;
    },
  },
  {
    name: 'CORS: the proxy preflight allows PUT and If-None-Match; ETag and rate-limit headers are exposed; unlisted origins refused',
    fn: async ({ A, B, gh }) => {
      seed(gh, A, B);
      const origin = 'http://localhost:5173';
      const requested = 'authorization, content-type, if-none-match, x-github-api-version';
      const pre = await call('/shared/team/gh/repos/team/library/contents/README.md', {
        method: 'OPTIONS', origin, headers: { 'access-control-request-method': 'PUT', 'access-control-request-headers': requested },
      });
      assert.equal(pre.status, 204);
      assert.equal(pre.headers.get('access-control-allow-origin'), origin);
      assert.equal(pre.headers.get('access-control-allow-methods'), 'GET, POST, PATCH, PUT, OPTIONS');
      assert.equal(pre.headers.get('access-control-allow-headers'), requested);
      const v1 = await call('/v1/messages', { method: 'OPTIONS', origin, headers: { 'access-control-request-method': 'POST' } });
      assert.equal(v1.headers.get('access-control-allow-methods'), 'GET, POST, PATCH, OPTIONS');
      const res = await req('/shared/team/gh/repos/team/library/git/ref/heads/main', { code: A.code, origin });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('access-control-allow-origin'), origin);
      const exposed = (res.headers.get('access-control-expose-headers') || '').split(/,\s*/);
      for (const h of ['etag', 'x-ratelimit-remaining', 'x-ratelimit-reset', 'retry-after']) assert.ok(exposed.includes(h), `${h} not exposed`);
      const bad = await req('/shared/team/gh/repos/team/library', { code: A.code, origin: 'https://evil.example' });
      assert.equal(bad.status, 403);
      assert.equal(bad.headers.get('access-control-allow-origin'), null);
      return `preflight methods "${pre.headers.get('access-control-allow-methods')}"; exposed ${exposed.filter((h) => /etag|ratelimit/.test(h)).join(', ')}`;
    },
  },
  {
    name: 'GET git/blobs: only blobs shown to the caller; another person\'s people/<other> blob → 404 (never fetched)',
    fn: async ({ A, B, gh }) => {
      seed(gh, A, B);
      const files = gh.files(...TEAM);
      const sha = (p) => files.get(p).sha;
      const getBlob = (code, s) => proxy('team', `/git/blobs/${s}`, { code, headers: { accept: 'application/vnd.github.raw' } });
      // Shared files (PDF, translation, library) are readable by anyone with a code — they sit at a shared path.
      assert.equal((await getBlob(A.code, sha('papers/p1/paper.pdf'))).status, 200);
      assert.equal((await getBlob(B.code, sha('papers/p1/translation.json'))).status, 200);
      assert.equal((await getBlob(A.code, sha('library.json'))).status, 200);
      // Each person reads their own highlights/notes and AI.
      assert.equal((await getBlob(A.code, sha(`people/${A.id}/papers/p1/annotations.json`))).status, 200);
      assert.equal((await getBlob(B.code, sha(`people/${B.id}/papers/p1/ai.json`))).status, 200);
      // Even with the exact blob sha, one person cannot read another's people/<other>/ blob, and the read is not
      // forwarded to GitHub as a blob fetch (the only protection must not be that the sha is hard to find).
      const mark = gh.log.length;
      const forbidden = [
        [A.code, sha(`people/${B.id}/papers/p1/annotations.json`)],
        [A.code, sha(`people/${B.id}/papers/p1/ai.json`)],
        [B.code, sha(`people/${A.id}/papers/p1/annotations.json`)],
      ];
      for (const [code, s] of forbidden) ghErr(await getBlob(code, s), 404, null);
      ghErr(await getBlob(A.code, 'd'.repeat(40)), 404, null); // a blob that is nowhere in the repo
      const fetched = gh.log.slice(mark).filter((e) => e.method === 'GET' && /\/git\/blobs\/[0-9a-f]{40}$/.test(e.path));
      assert.deepEqual(fetched, [], 'a blob the caller may not see must not be fetched from GitHub');
      return `shared + own blobs 200; ${forbidden.length} cross-person blob shas → 404 and 0 forwarded`;
    },
  },
  {
    name: 'POST git/trees: a library.json that drops a record (not a tombstone) → 403; tombstoning or adding is allowed',
    fn: async ({ A, B, gh }) => {
      // base library.json has a folder f1 and a paper p1.
      seed(gh, A, B, { 'library.json': JSON.stringify({ version: 1, updatedAt: 1, folders: [{ id: 'f1', name: 'ICU' }], papers: [{ id: 'p1', title: 'Sepsis', folderId: 'f1' }] }) });
      const H = headOf(gh);
      const lib = (folders, papers) => JSON.stringify({ version: 1, updatedAt: Date.now(), folders, papers });
      const treeFor = async (folders, papers) => {
        const sha = await blobSha(A.code, Buffer.from(lib(folders, papers)));
        return postTree(A.code, { base_tree: H.tree, tree: [file('library.json', sha)] });
      };
      const P1 = { id: 'p1', title: 'Sepsis', folderId: 'f1' };
      const F1 = { id: 'f1', name: 'ICU' };
      const trees = () => count(gh, 'POST', /\/git\/trees$/);
      const mark = trees();
      // p1 vanishes from the list → refused (a delete must be a tombstone so 휴지통 can restore it).
      const dropPaper = ghErr(await treeFor([F1], []), 403, /휴지통/);
      // f1 vanishes → refused too.
      ghErr(await treeFor([], [P1]), 403, /휴지통/);
      assert.equal(trees(), mark, 'a tree that drops records is not forwarded to GitHub');
      // Tombstoning (keeping the record) and adding are allowed.
      const tomb = await treeFor([F1], [{ ...P1, deleted: true, deletedAt: Date.now(), updatedAt: Date.now() }]);
      assert.equal(tomb.status, 201, tomb.text);
      const add = await treeFor([F1], [P1, { id: 'p2', title: 'ARDS' }]);
      assert.equal(add.status, 201, add.text);
      // A corrupt library.json is refused (every client must be able to read it).
      const badSha = await blobSha(A.code, Buffer.from('not json'));
      ghErr(await postTree(A.code, { base_tree: H.tree, tree: [file('library.json', badSha)] }), 422, /library\.json/);
      return `drop paper/folder → 403 "${dropPaper}" (0 forwarded); tombstone and add → 201; corrupt → 422`;
    },
  },
  {
    name: 'POST git/commits: a loud change labelled as a hidden summary gets the Worker\'s visible summary; a real quiet change keeps it',
    fn: async ({ A, B, gh }) => {
      const activity = async () => (await req('/shared/team/activity?limit=1', { code: A.code })).json.items[0];
      // (1) A real delete labelled '논문 정보 갱신' (which the app hides) → the Worker writes a visible summary.
      seed(gh, A, B);
      await commitVia(gh, A, [file('library.json',
        await blobSha(A.code, Buffer.from(libraryJson([{ id: 'p1', title: 'Sepsis', deleted: true, deletedAt: Date.now(), updatedAt: Date.now() }]))))],
      '논문 정보 갱신');
      const spoofDelete = await activity();
      assert.equal(spoofDelete.who, '김민지');
      assert.notEqual(spoofDelete.summary, '논문 정보 갱신');
      assert.match(spoofDelete.summary, /공용 서재 변경.*삭제/);
      // (2) Adding a paper labelled '내 메모·AI 결과 동기화' → also made visible.
      seed(gh, A, B);
      await commitVia(gh, A, [file('library.json',
        await blobSha(A.code, Buffer.from(libraryJson([{ id: 'p1', title: 'Sepsis' }, { id: 'p2', title: 'ARDS' }]))))],
      '내 메모·AI 결과 동기화');
      assert.match((await activity()).summary, /공용 서재 변경.*추가/);
      // (3) A genuine progress-count update may keep '논문 정보 갱신' (app hides it).
      seed(gh, A, B);
      await commitVia(gh, A, [file('library.json',
        await blobSha(A.code, Buffer.from(libraryJson([{ id: 'p1', title: 'Sepsis', translatedCount: 5, sentenceCount: 10 }]))))],
      '논문 정보 갱신');
      assert.equal((await activity()).summary, '논문 정보 갱신');
      // (4) A genuine own-notes write may keep '내 메모·AI 결과 동기화'.
      seed(gh, A, B);
      await commitVia(gh, A, [file(`people/${A.id}/papers/p1/annotations.json`,
        await blobSha(A.code, Buffer.from('{"version":1,"items":[{"id":"h1"}]}')))],
      '내 메모·AI 결과 동기화');
      assert.equal((await activity()).summary, '내 메모·AI 결과 동기화');
      return `mislabelled delete → "${spoofDelete.summary}"; add → made visible; real progress / own-notes keep their hidden summary`;
    },
  },
  {
    name: 'POST git/trees: a library may not hold more than its file cap (stops cheap exhaustion with countless tiny files)',
    fn: async ({ A, gh }) => {
      gh.createRepo(...SMALL, { private: true }); // maxFiles 8 in the test config
      gh.commitFiles(...SMALL, { 'library.json': libraryJson([]) }); // 1 file
      const H = headOf(gh, SMALL);
      const sha = await blobSha(A.code, Buffer.from('{"version":1,"items":[]}'), 'small');
      const notes = (n) => Array.from({ length: n }, (_, i) => file(`people/${A.id}/papers/p${i}/annotations.json`, sha));
      const over = ghErr(await postTree(A.code, { base_tree: H.tree, tree: notes(8) }, { lib: 'small' }), 403, /파일 수/);
      const trees = () => count(gh, 'POST', /\/git\/trees$/);
      const mark = trees();
      ghErr(await postTree(A.code, { base_tree: H.tree, tree: notes(20) }, { lib: 'small' }), 403, /파일 수/);
      assert.equal(trees(), mark, 'an over-cap tree is not forwarded to GitHub');
      const ok = await postTree(A.code, { base_tree: H.tree, tree: notes(7) }, { lib: 'small' }); // 1 + 7 = 8, at the cap
      assert.equal(ok.status, 201, ok.text);
      return `1 + 8 files > cap 8 → 403 "${over}"; 1 + 7 = 8 → 201; over-cap not forwarded`;
    },
  },
  {
    name: 'admin purge: a back-dated deletedAt is not trusted — only tombstones already 30+ days old in history are purged',
    fn: async ({ A, B, gh }) => {
      const now = Date.parse('2026-10-19T00:00:00Z');
      gh.createRepo(...TEAM, { private: true });
      // 60 days ago: p_old is tombstoned, p_live is alive.
      gh.commitFiles(...TEAM, {
        'README.md': README_TEXT,
        'library.json': libraryJson([
          { id: 'p_old', title: '오래', deleted: true, deletedAt: now - 60 * DAY, updatedAt: now - 60 * DAY },
          { id: 'p_live', title: '살아있음' },
        ]),
        'papers/p_old/paper.pdf': PDF(3000, 'o'),
        'papers/p_live/paper.pdf': PDF(3000, 'l'),
        [`people/${B.id}/papers/p_old/ai.json`]: '{"version":1}',
      }, { message: '[관리자] 초기', time: now - 60 * DAY });
      // Today: an attacker tombstones p_live with a deletedAt faked to 40 days ago.
      gh.commitFiles(...TEAM, {
        'library.json': libraryJson([
          { id: 'p_old', title: '오래', deleted: true, deletedAt: now - 60 * DAY, updatedAt: now - 60 * DAY },
          { id: 'p_live', title: '살아있음', deleted: true, deletedAt: now - 40 * DAY, updatedAt: now - 40 * DAY },
        ]),
      }, { message: '[공격자] 삭제', time: now });
      const purge = await call('/relay/admin/shared/team/purge', { method: 'POST', admin: true, body: {}, now });
      assert.equal(purge.status, 200, purge.text);
      assert.deepEqual(purge.json.purged, ['p_old']); // not p_live
      const after = gh.files(...TEAM);
      assert.ok(!after.has('papers/p_old/paper.pdf') && !after.has(`people/${B.id}/papers/p_old/ai.json`), 'p_old purged');
      assert.ok(after.has('papers/p_live/paper.pdf'), 'back-dated p_live kept (not yet 30 days old in history)');
      // Nothing is purgeable yet when there is no commit 30 days old (first push today).
      gh.createRepo(...SMALL, { private: true });
      gh.commitFiles(...SMALL, {
        'library.json': libraryJson([{ id: 'p_x', title: 'X', deleted: true, deletedAt: now - 99 * DAY, updatedAt: now - 99 * DAY }]),
        'papers/p_x/paper.pdf': PDF(1000, 'x'),
      }, { message: '[사용자] 오늘', time: now });
      const none = await call('/relay/admin/shared/small/purge', { method: 'POST', admin: true, body: {}, now });
      assert.deepEqual(none.json.purged, []);
      assert.ok(gh.files(...SMALL).has('papers/p_x/paper.pdf'), 'no old-enough commit → nothing purged');
      return 'purged [p_old]; back-dated p_live and a freshly-pushed old tombstone kept';
    },
  },
  {
    name: 'no secret crosses: TEAM_GITHUB_TOKEN never in a response; invite codes never reach GitHub; GitHub sees only the Worker\'s headers',
    fn: async ({ gh }) => {
      for (const r of seen) {
        assert.ok(!r.text.includes(TEAM_TOKEN) && !r.headers.includes(TEAM_TOKEN), `team token in the response to ${r.path}`);
        assert.ok(!r.text.includes(ADMIN_TOKEN), `admin token in the response to ${r.path}`);
      }
      const allowedHeaders = new Set(['authorization', 'accept', 'x-github-api-version', 'user-agent', 'content-type',
        'content-length', 'if-none-match', 'host', 'connection', 'accept-encoding', 'cf-worker', 'accept-language', 'sec-fetch-mode',
        'transfer-encoding']);
      const extra = new Set();
      for (const e of gh.log) {
        const everything = [e.path, e.query, JSON.stringify(e.headers), e.body?.toString('latin1') ?? ''].join('\n');
        for (const code of codes) assert.ok(!everything.includes(code), `invite code ${code} reached GitHub: ${e.method} ${e.path}`);
        assert.ok(!/PR-[0-9A-Z]{4}-[0-9A-Z]{4}/.test(everything), `something code-like reached GitHub: ${e.method} ${e.path}`);
        assert.equal(e.headers.authorization, `Bearer ${TEAM_TOKEN}`, `${e.method} ${e.path}`);
        assert.equal(e.headers['user-agent'], 'paper-relay');
        assert.equal(e.headers['x-github-api-version'], '2022-11-28');
        assert.ok(!('x-api-key' in e.headers) && !('origin' in e.headers) && !('cookie' in e.headers), JSON.stringify(e.headers));
        for (const h of Object.keys(e.headers)) if (!allowedHeaders.has(h)) extra.add(h);
      }
      assert.deepEqual([...extra], [], `unexpected headers sent to GitHub: ${[...extra].join(', ')}`);
      return `${seen.length} responses without the team token; ${gh.log.length} GitHub requests with only the Worker's token (${codes.length} codes checked)`;
    },
  },
];
