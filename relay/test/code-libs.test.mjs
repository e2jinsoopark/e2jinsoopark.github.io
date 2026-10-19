// HTTP tests of each invite code's own library (docs/SHARED.md §6) against `wrangler dev` + the fake GitHub
// (tests/store/fake-github.mjs on 8792): the library_id migration, GET /shared, isolation of codes/<id>/ through
// /shared/mine/gh and of the team library through /shared/team/gh (reads, writes, blobs), commit markers and 최근 활동
// per library, the per-code size cap, code deletion with ?library=delete and ?library=move (id clashes, notes, 502
// safety), the split by uploader on today's production shape, and the purge of code libraries' 휴지통.
// The Worker's D1 here was migrated from the schema of before code deletion (lib.mjs migratedDatabase); this suite
// runs before code-delete, while the two legacy codes still have no library id.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  applySql, call, d1Rows, LEGACY_CODES, newCode, OUT_DIR, personIdOf, personIdOfCode, sqlRows, TEAM_TOKEN,
} from './lib.mjs';
import { CODE_DELETE_SUMMARY } from '../src/shared-paths.js';

const TEAM = ['dindoopark', 'paper-team-library'];
const SMALL = ['dindoopark', 'paper-small-library'];
const LAB = ['dindoopark', 'lab-library'];
const IP = '198.51.100.210'; // this suite's own limiter bucket
const DAY = 24 * 60 * 60 * 1000;
const KOREAN = /[가-힣]/;
const HEX16 = /^[0-9a-f]{16}$/;

/** Every answer a code got in this suite: { who (code), text } — for the leak checks at the end. */
const seen = [];
const people = [];

const gitSha = (buf) => createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${buf.length}\0`), buf])).digest('hex');
const PDF = (n, fill) => Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(Math.max(0, n - 9), fill)]);
const lib = (papers, folders = []) => JSON.stringify({ version: 1, updatedAt: 1, folders, papers });
const file = (p, sha) => ({ path: p, mode: '100644', type: 'blob', sha });
const note = (who, extra = '') => JSON.stringify({ version: 1, items: [{ id: `${who}${extra}` }] });

/** A new code through the admin API: its personId (salt from D1) and its library id (made at creation). */
async function person(name) {
  const { code } = await newCode({ name });
  const [row] = await d1Rows('SELECT library_id FROM codes WHERE code = ?', code);
  const p = { code, name, id: await personIdOfCode(code), lib: row.library_id, root: `codes/${row.library_id}/` };
  people.push(p);
  return p;
}

/** A Worker request with an invite code (Authorization: Bearer, as GitHubClient sends it), recorded in `seen`. */
async function req(pathname, { code, method = 'GET', body, headers = {}, now } = {}) {
  const h = { ...headers };
  if (code) h.authorization = `Bearer ${code}`;
  const res = await call(pathname, { method, body, headers: h, now, ip: IP });
  if (code) seen.push({ who: code, path: pathname, status: res.status, text: res.text, headers: [...res.headers].join('\n') });
  return res;
}

/** The proxy of library `which` ('mine' or 'team'): /shared/<which>/gh/repos/team/library<sub>. */
const proxy = (which, sub, opts) => req(`/shared/${which}/gh/repos/team/library${sub}`, opts);
const admin = (pathname, opts = {}) => call(pathname, { admin: true, ...opts });

function ghErr(res, status, re = KOREAN) {
  assert.equal(res.status, status, `${res.status} ${res.text}`);
  assert.equal(typeof res.json?.message, 'string', res.text);
  if (re) assert.match(res.json.message, re);
  return res.json.message;
}

const headOf = (gh) => {
  const repo = gh.repo(...TEAM);
  const commit = repo.refs.get('heads/main');
  return { commit, tree: commit && repo.get(commit, 'commit').tree };
};

function treeAt(gh, p) {
  const repo = gh.repo(...TEAM);
  let sha = headOf(gh).tree;
  for (const part of p.split('/')) sha = repo.get(sha, 'tree').entries.find((e) => e.name === part).sha;
  return sha;
}

const shaMap = (gh) => new Map([...gh.files(...TEAM)].map(([p, f]) => [p, f.sha]));
const readJson = (gh, p) => JSON.parse(gh.readFile(...TEAM, p).toString('utf8'));
const count = (gh, method, re) => gh.log.filter((e) => e.method === method && re.test(e.path)).length;

/** POST git/blobs as GitHubClient sends it. `now`: the test clock (a later one makes the Worker re-read the head). */
async function upload(code, bytes, which, now) {
  const body = JSON.stringify({ encoding: 'base64', content: Buffer.from(bytes).toString('base64') });
  return proxy(which, '/git/blobs', { code, method: 'POST', body, headers: { 'content-type': 'application/json' }, now });
}

async function blobSha(code, bytes, which) {
  const res = await upload(code, bytes, which);
  assert.equal(res.status, 201, res.text);
  return res.json.sha;
}

const postTree = (who, which, entries, base) => proxy(which, '/git/trees', { code: who.code, method: 'POST', body: { base_tree: base, tree: entries } });

/** tree → commit → ref through library `which`, as one GitHubClient.commit(); returns the new head. */
async function commitVia(gh, who, which, entries, message) {
  const head = headOf(gh);
  const tree = await postTree(who, which, entries, head.tree);
  assert.equal(tree.status, 201, tree.text);
  const commit = await proxy(which, '/git/commits', { code: who.code, method: 'POST', body: { message, tree: tree.json.sha, parents: [head.commit] } });
  assert.equal(commit.status, 201, commit.text);
  const ref = await proxy(which, '/git/refs/heads/main', { code: who.code, method: 'PATCH', body: { sha: commit.json.sha, force: false } });
  assert.equal(ref.status, 200, ref.text);
  return commit.json;
}

async function listing(who, which, sha, recursive) {
  const r = await proxy(which, `/git/trees/${sha}${recursive ? '?recursive=1' : ''}`, { code: who.code });
  assert.equal(r.status, 200, r.text);
  return r;
}

const activity = async (who, which, limit = 20) => {
  const r = await req(`/shared/${which}/activity?limit=${limit}`, { code: who.code });
  assert.equal(r.status, 200, r.text);
  return r.json.items;
};

/** A fresh team repo: the team library plus the code libraries of A and B, each with notes. */
function seed(gh, A, B, extra = {}, opts = {}) {
  gh.createRepo(...TEAM, { private: true });
  return gh.commitFiles(...TEAM, {
    'README.md': '# 논문 리더 데이터 저장소\n',
    'library.json': lib([{ id: 'p1', title: '공용 논문' }]),
    'papers/p1/paper.pdf': PDF(2000, 't'),
    'papers/p1/translation.json': '{"version":1,"items":{"t":1}}',
    [`people/${A.id}/papers/p1/annotations.json`]: note(A.name, 'team'),
    [`${A.root}library.json`]: lib([{ id: 'q1', title: '가람 비밀 논문' }]),
    [`${A.root}papers/q1/paper.pdf`]: PDF(2100, 'a'),
    [`${A.root}papers/q1/translation.json`]: '{"version":1,"items":{"a":1}}',
    [`${A.root}people/${A.id}/papers/q1/ai.json`]: note(A.name, 'ai'),
    [`${B.root}library.json`]: lib([{ id: 'r1', title: '나래 비밀 논문' }]),
    [`${B.root}papers/r1/paper.pdf`]: PDF(2200, 'b'),
    [`${B.root}people/${B.id}/papers/r1/ai.json`]: note(B.name, 'ai'),
    ...extra,
  }, { message: 'initial', ...opts });
}

/** One request to the Worker that tolerates a stale keep-alive socket (Node's fetch fails once on a closed one). */
async function reconnect() {
  for (let i = 0; ; i++) {
    try {
      return await call('/');
    } catch (err) {
      if (i >= 2) throw err;
    }
  }
}

export async function setup({ gh }) {
  // Code deletion walks every library of SHARED_LIBRARIES: give the other two repos a state of their own.
  gh.createRepo(...SMALL, { private: true });
  gh.createRepo(...LAB, { private: false });
  return { A: await person('가람'), B: await person('나래') };
}

export const tests = [
  {
    name: 'library_id: new codes get one at creation; legacy codes none until their first GET /shared (then stable); the Worker added the columns and the unique index; schema.sql still runs twice',
    fn: async ({ A, B }) => {
      const columns = (await d1Rows('PRAGMA table_info(codes)')).map((c) => c.name);
      assert.ok(columns.includes('library_id') && columns.includes('library_max_bytes'), columns.join());
      assert.ok((await d1Rows('PRAGMA index_list(codes)')).some((i) => i.name === 'codes_by_library' && i.unique === 1));
      assert.match(A.lib, HEX16);
      assert.match(B.lib, HEX16);
      assert.notEqual(A.lib, B.lib);
      const legacyBefore = await d1Rows('SELECT code, library_id FROM codes WHERE code IN (?, ?) ORDER BY code',
        LEGACY_CODES.custom, LEGACY_CODES.generated);
      assert.deepEqual(legacyBefore.map((r) => r.library_id), [null, null], JSON.stringify(legacyBefore));
      // The admin report of a code that never opened its library: no id, zeros, nothing written.
      const report = await admin(`/relay/admin/codes/${encodeURIComponent('old ward 7b')}/library`);
      assert.equal(report.status, 200, report.text);
      assert.deepEqual(report.json, {
        code: LEGACY_CODES.custom, name: '예전 그룹', libraryId: null, papers: 0, trashed: 0, files: 0, bytes: 0, maxBytes: 500_000_000,
      });
      const first = await req('/shared', { code: 'pr 01dc 0de5' });
      assert.equal(first.status, 200, first.text);
      assert.match(first.json.libraryId, HEX16);
      assert.equal(first.json.personId, personIdOf(LEGACY_CODES.generated), 'the personId of a legacy code is unchanged');
      const again = await req('/shared', { code: LEGACY_CODES.generated });
      assert.equal(again.json.libraryId, first.json.libraryId);
      const stored = await d1Rows('SELECT library_id FROM codes WHERE code = ?', LEGACY_CODES.generated);
      assert.equal(stored[0].library_id, first.json.libraryId);
      assert.equal((await d1Rows('SELECT library_id FROM codes WHERE code = ?', LEGACY_CODES.custom))[0].library_id, null);
      // schema.sql on a new and on an old database (twice each); the Worker's ALTERs, then schema.sql once more.
      const base = path.join(OUT_DIR, 'schema-check-code-libs');
      fs.rmSync(base, { recursive: true, force: true });
      const fresh = path.join(base, 'new');
      applySql(fresh, 'schema.sql');
      applySql(fresh, 'schema.sql');
      const freshColumns = sqlRows(fresh, 'PRAGMA table_info(codes)').map((c) => c.name);
      assert.ok(['person_salt', 'library_id', 'library_max_bytes'].every((c) => freshColumns.includes(c)), freshColumns.join());
      const old = path.join(base, 'old');
      applySql(old, 'test/legacy-schema.sql');
      applySql(old, 'schema.sql');
      applySql(old, 'schema.sql');
      assert.ok(!sqlRows(old, 'PRAGMA table_info(codes)').some((c) => c.name === 'library_id'));
      for (const sql of ['ALTER TABLE codes ADD COLUMN person_salt TEXT', 'ALTER TABLE codes ADD COLUMN library_id TEXT',
        'ALTER TABLE codes ADD COLUMN library_max_bytes INTEGER', 'CREATE UNIQUE INDEX IF NOT EXISTS codes_by_library ON codes (library_id)']) {
        sqlRows(old, sql); // what src/db.js ensureCodeColumns does once
      }
      applySql(old, 'schema.sql');
      await reconnect(); // the Worker sat idle while wrangler ran: drop a keep-alive socket it may have closed
      return `A ${A.lib}, B ${B.lib}; legacy ${LEGACY_CODES.generated} → ${first.json.libraryId} on its first GET /shared (stable), `
        + `${LEGACY_CODES.custom} still none; schema.sql OK on new/old databases`;
    },
  },
  {
    name: 'GET /shared: the code\'s own library first ("<name> 서재", kind code), then the team libraries; libraryId = its codes/<id>/',
    fn: async ({ A, B, gh }) => {
      const mark = gh.log.length;
      const res = await req('/shared', { code: A.code });
      assert.equal(res.status, 200, res.text);
      assert.deepEqual(res.json, {
        libraries: [
          { id: 'mine', name: '가람 서재', kind: 'code' }, { id: 'team', name: '전체 공용 서재', kind: 'team' },
          { id: 'small', name: '작은 서재', kind: 'team' }, { id: 'lab', name: '연구실 서재', kind: 'team' },
        ],
        personId: A.id, name: '가람', libraryId: A.lib,
      });
      const typed = await req('/shared', { code: B.code.toLowerCase().replace(/-/g, ' ') });
      assert.equal(typed.json.libraryId, B.lib);
      assert.equal(gh.log.length, mark, 'GET /shared asks GitHub nothing');
      for (const bad of ['/shared/mine', '/shared/mine/gh', `/shared/${A.lib}/gh/repos/team/library`, `/shared/code:${A.lib}/activity`,
        // Address tricks: another library through an encoded path, case, a NUL, another owner, a trailing slash.
        '/shared/mine%2F..%2Fteam/gh/repos/team/library', '/shared/team%2F..%2Fmine/activity', '/shared/MINE/gh/repos/team/library',
        '/shared/mine%00/gh/repos/team/library', `/shared/mine/gh/repos/team/library/git/trees/${'a'.repeat(40)}/`,
        '/shared/mine/gh/repos/Team/library', `/shared/mine/gh/repos/team/library/git/blobs/${'a'.repeat(40)}%2F`]) {
        assert.equal((await req(bad, { code: A.code })).status, 404, bad);
      }
      assert.equal(gh.log.length, mark, 'none of them reached GitHub');
      // The owner's endpoints (the split's plan names every title and code; a move takes another code's library) need
      // the admin token: an invite code is refused there and learns nothing.
      const ip = '198.51.100.212';
      const asCode = (pathname, opts) => call(pathname, { ...opts, headers: { authorization: `Bearer ${A.code}` }, ip });
      const refused = [
        await asCode('/relay/admin/shared/team/split-by-uploader', { method: 'POST', body: { dryRun: true } }),
        await asCode(`/relay/admin/codes/${B.code}?library=move&to=${A.code}`, { method: 'DELETE' }),
        await asCode(`/relay/admin/codes/${B.code}/library`),
      ];
      assert.deepEqual(refused.map((r) => r.status), [401, 401, 401], refused.map((r) => r.text).join(' | '));
      assert.ok(refused.every((r) => !r.text.includes(B.lib) && !r.text.includes('나래') && !r.text.includes('moves')));
      assert.equal((await d1Rows('SELECT code FROM codes WHERE code = ?', B.code)).length, 1, 'B is still there');
      assert.equal(gh.log.length, mark, 'nothing reached GitHub');
      return `libraries ${res.json.libraries.map((l) => `${l.id}:${l.name}`).join(', ')}; libraryId ${res.json.libraryId}`;
    },
  },
  {
    name: 'isolation (reads): mine lists only its codes/<id>/ (recursive and level by level), team lists nothing under codes/; other trees and blobs → 404, never fetched',
    fn: async ({ A, B, gh }) => {
      seed(gh, A, B);
      const H = headOf(gh);
      const all = [...gh.files(...TEAM).keys()];
      const recA = await listing(A, 'mine', H.tree, true);
      const pathsA = recA.json.tree.map((e) => e.path);
      const wantA = [...all.filter((p) => p.startsWith(A.root)), 'codes', `codes/${A.lib}`];
      assert.ok(wantA.every((p) => pathsA.includes(p)), `missing: ${wantA.filter((p) => !pathsA.includes(p))}`);
      assert.ok(pathsA.every((p) => p === 'codes' || p === `codes/${A.lib}` || p.startsWith(A.root)), pathsA.join());
      assert.ok(!recA.text.includes(B.lib) && !recA.text.includes(B.id), 'nothing of B');
      assert.deepEqual((await listing(A, 'mine', H.tree, false)).json.tree.map((e) => e.path), ['codes']);
      assert.deepEqual((await listing(A, 'mine', treeAt(gh, 'codes'), false)).json.tree.map((e) => e.path), [A.lib]);
      assert.deepEqual((await listing(B, 'mine', treeAt(gh, 'codes'), false)).json.tree.map((e) => e.path), [B.lib]);
      assert.deepEqual((await listing(A, 'mine', treeAt(gh, `codes/${A.lib}`), false)).json.tree.map((e) => e.path).sort(),
        ['library.json', 'papers', 'people']);
      const teamRec = await listing(A, 'team', H.tree, true);
      assert.ok(teamRec.json.tree.every((e) => !e.path.startsWith('codes')), 'team: no codes/');
      assert.ok(!teamRec.text.includes(A.lib) && !teamRec.text.includes(B.lib));
      assert.deepEqual((await listing(A, 'team', H.tree, false)).json.tree.map((e) => e.path), ['README.md', 'library.json', 'papers', 'people']);
      const files = gh.files(...TEAM);
      const sha = (p) => files.get(p).sha;
      const mark = gh.log.length;
      const denied = [
        ['mine', A, treeAt(gh, `codes/${B.lib}`)], ['mine', A, treeAt(gh, 'papers')], ['mine', A, treeAt(gh, 'people')],
        ['mine', B, treeAt(gh, `codes/${A.lib}`)], ['team', A, treeAt(gh, 'codes')], ['team', A, treeAt(gh, `codes/${A.lib}`)],
        ['team', B, treeAt(gh, `codes/${A.lib}/papers`)],
      ];
      for (const [which, who, s] of denied) {
        for (const q of ['', '?recursive=1']) ghErr(await proxy(which, `/git/trees/${s}${q}`, { code: who.code }), 404, null);
      }
      const blob = (which, who, s) => proxy(which, `/git/blobs/${s}`, { code: who.code, headers: { accept: 'application/vnd.github.raw' } });
      assert.equal((await blob('mine', A, sha(`${A.root}papers/q1/paper.pdf`))).status, 200);
      assert.equal((await blob('mine', A, sha(`${A.root}people/${A.id}/papers/q1/ai.json`))).status, 200);
      assert.equal((await blob('team', A, sha('papers/p1/paper.pdf'))).status, 200);
      const forbidden = [
        ['mine', A, `${B.root}papers/r1/paper.pdf`], ['mine', A, `${B.root}library.json`], ['mine', A, 'papers/p1/paper.pdf'],
        ['mine', A, 'library.json'], ['mine', B, `${A.root}people/${A.id}/papers/q1/ai.json`],
        ['team', A, `${A.root}papers/q1/paper.pdf`], ['team', B, `${A.root}library.json`], ['team', A, `${B.root}people/${B.id}/papers/r1/ai.json`],
      ];
      const blobsBefore = count(gh, 'GET', /\/git\/blobs\/[0-9a-f]{40}$/);
      for (const [which, who, p] of forbidden) ghErr(await blob(which, who, sha(p)), 404, null);
      assert.equal(count(gh, 'GET', /\/git\/blobs\/[0-9a-f]{40}$/), blobsBefore, 'a blob the caller may not see is not fetched');
      const treesListed = gh.log.slice(mark).filter((e) => e.method === 'GET' && /\/git\/trees\//.test(e.path)).map((e) => e.path);
      assert.ok(!denied.some(([, , s]) => treesListed.some((p) => p.endsWith(s))), 'a refused tree is not listed by GitHub either');
      return `A mine: ${pathsA.length} entries (codes/${A.lib}/ only); team: no codes/; ${denied.length} trees × 2 and ${forbidden.length} blobs → 404, 0 fetched`;
    },
  },
  {
    name: 'isolation (fresh uploads): a blob one person just uploaded to their code library is readable by them there only — not by another code, not through 전체 공용 서재 (the Worker\'s upload memory is per person and library)',
    fn: async ({ A, B, gh }) => {
      seed(gh, A, B);
      const bytes = PDF(2300, 'u');
      const sha = await blobSha(A.code, bytes, 'mine');
      assert.equal(sha, gitSha(bytes));
      const blob = (which, who) => proxy(which, `/git/blobs/${sha}`, { code: who.code, headers: { accept: 'application/vnd.github.raw' } });
      const before = count(gh, 'GET', /\/git\/blobs\/[0-9a-f]{40}$/);
      const refused = [];
      for (const [which, who] of [['team', A], ['mine', B], ['team', B]]) refused.push([which, who.name, (await blob(which, who)).status]);
      assert.equal(count(gh, 'GET', /\/git\/blobs\/[0-9a-f]{40}$/), before, 'a refused blob is not fetched');
      const own = await blob('mine', A);
      assert.equal(own.status, 200, own.text);
      // B uploading the very same bytes to B's own library may read them there (B has them), still not through team.
      assert.equal(await blobSha(B.code, bytes, 'mine'), sha);
      const bOwn = (await blob('mine', B)).status;
      const bTeam = (await blob('team', B)).status;
      assert.deepEqual(refused, [['team', '가람', 404], ['mine', '나래', 404], ['team', '나래', 404]]);
      assert.deepEqual([bOwn, bTeam], [200, 404]);
      return `uploaded by 가람 to 가람 서재: 가람 mine 200; 가람 team, 나래 mine, 나래 team → 404 (not fetched); after 나래 uploads the same bytes: 나래 mine 200, team 404`;
    },
  },
  {
    name: 'isolation (blob existence): a tree names only blobs the person uploaded through that library or can see in it — another library\'s file, a deleted one and one that exists nowhere get the same refusal, and neither GitHub nor the Worker looks at them',
    fn: async ({ A, B, gh }) => {
      seed(gh, A, B);
      const files = gh.files(...TEAM);
      const sha = (p) => files.get(p).sha;
      // 가람 has the bytes of a published PDF and asks whether some library holds it (GitHub accepts in a tree any blob
      // of the repo): 나래's PDF, the same bytes deleted from 나래's library, the team PDF named in 가람's own library,
      // a PDF nobody uploaded — and, as if their shas had leaked, 나래's library.json and 나래's notes.
      const bPdf = PDF(2200, 'b');
      assert.equal(gitSha(bPdf), sha(`${B.root}papers/r1/paper.pdf`));
      const probes = [
        ['mine', A, `${A.root}papers/z1/paper.pdf`, gitSha(bPdf)],
        ['mine', A, `${A.root}papers/z1/paper.pdf`, gitSha(PDF(2200, 'n'))],
        ['mine', A, `${A.root}papers/z1/translation.json`, gitSha(bPdf)],
        ['mine', A, `${A.root}papers/z1/paper.pdf`, sha('papers/p1/paper.pdf')],
        ['mine', A, `${A.root}library.json`, sha(`${B.root}library.json`)],
        ['mine', A, `${A.root}people/${A.id}/papers/q1/ai.json`, sha(`${B.root}people/${B.id}/papers/r1/ai.json`)],
        ['team', B, 'papers/z2/paper.pdf', sha(`${A.root}papers/q1/paper.pdf`)],
        ['team', B, 'papers/z2/paper.pdf', gitSha(PDF(2100, 'n'))],
      ];
      const ask = async () => {
        const answers = [];
        for (const [which, who, p, s] of probes) {
          const r = await postTree(who, which, [file(p, s)], headOf(gh).tree);
          answers.push(`${r.status} ${r.json?.message}`);
        }
        return answers;
      };
      const reads = () => count(gh, 'GET', /\/git\/blobs\/[0-9a-f]{40}$/);
      const trees = () => count(gh, 'POST', /\/git\/trees$/);
      const mark = [reads(), trees()];
      const answers = await ask();
      // Now 나래's PDF is only in the history (deleted from the head): still the same answer.
      gh.commitFiles(...TEAM, { [`${B.root}papers/r1/paper.pdf`]: null }, { message: `[나래] {lib:${B.lib}} 정리` });
      answers.push(...await ask());
      assert.equal(new Set(answers).size, 1, `the answers differ: ${answers.join(' | ')}`);
      assert.match(answers[0], /^409 .*다시 올린/);
      assert.deepEqual([reads(), trees()], mark, 'no blob read, no tree sent to GitHub');
      // Allowed: a blob the person can already see in that library (at another path), and bytes they upload there.
      const H = headOf(gh);
      const reuse = await postTree(A, 'mine', [file(`${A.root}papers/z3/paper.pdf`, sha(`${A.root}papers/q1/paper.pdf`))], H.tree);
      assert.equal(reuse.status, 201, reuse.text);
      assert.equal(await blobSha(A.code, bPdf, 'mine'), gitSha(bPdf));
      const own = await postTree(A, 'mine', [file(`${A.root}papers/z1/paper.pdf`, gitSha(bPdf))], H.tree);
      assert.equal(own.status, 201, own.text);
      // The proof outlives this isolate: stored in D1 for the person and library (pruned with the trees after 1 h).
      const proof = await d1Rows("SELECT lib, person, base FROM shared_trees WHERE tree = ? AND lib LIKE 'blob:%'", gitSha(bPdf));
      assert.deepEqual(proof, [{ lib: `blob:code:${A.lib}`, person: A.id, base: '' }]);
      return `${answers.length} probes → all "${answers[0]}" (0 GitHub reads/trees); own visible blob and own upload → 201; proof row ${proof[0].lib}`;
    },
  },
  {
    name: 'isolation (writes): mine writes only under its own root with the team rules; the team endpoint refuses codes/; a tree is committed only through the library it was made in',
    fn: async ({ A, B, gh }) => {
      seed(gh, A, B);
      const H = headOf(gh);
      const json = await blobSha(A.code, Buffer.from('{"version":1,"items":[{"id":"x"}]}'), 'mine');
      const pdf = await blobSha(A.code, PDF(1500, 'z'), 'mine');
      const libA2 = await blobSha(A.code, Buffer.from(lib([{ id: 'q1', title: '가람 비밀 논문' }, { id: 'q2', title: '가람 둘' }])), 'mine');
      const trees = () => count(gh, 'POST', /\/git\/trees$/);
      const mark = trees();
      const refusedMine = [
        file('library.json', libA2), file('papers/p9/paper.pdf', pdf), file(`people/${A.id}/papers/p1/ai.json`, json),
        file(`${B.root}library.json`, libA2), file(`${B.root}papers/r9/paper.pdf`, pdf), file(`${A.root}people/${B.id}/papers/q1/ai.json`, json),
        file(`${A.root}README.md`, json), file(`${A.root}papers/q1/paper.pdf`, pdf), file(`${A.root}papers/q1/paper.pdf`, null),
        file(`${A.root}library.json`, null), file(`${A.root}papers/q1/translation.json`, null), file(`codes/${A.lib}x/library.json`, json),
        file(`${A.root}../${B.lib}/library.json`, json), file(`codes/${A.lib.toUpperCase()}/library.json`, json),
        file(`${A.root}library.json/`, libA2), file(`codes//${A.lib}/library.json`, libA2), file(`${A.root}./library.json`, libA2),
        file(`${A.root}papers/../../${B.lib}/papers/r1/paper.pdf`, pdf), file(`${A.root}papers/%2e%2e/translation.json`, json),
        file(`/${A.root}library.json`, libA2), file(`${A.root.replace('codes', 'cоdes')}library.json`, libA2), // Cyrillic о
        file(`${A.root}people/${A.id}/../${B.id}/papers/r1/ai.json`, json),
      ];
      for (const e of refusedMine) ghErr(await postTree(A, 'mine', [e], H.tree), 403);
      const dropped = await blobSha(A.code, Buffer.from(lib([])), 'mine');
      ghErr(await postTree(A, 'mine', [file(`${A.root}library.json`, dropped)], H.tree), 403, /휴지통/);
      for (const e of [file(`${A.root}library.json`, libA2), file(`codes/${A.lib}/papers/q2/paper.pdf`, pdf), file('codes/README.md', json)]) {
        ghErr(await postTree(A, 'team', [e], H.tree), 403, /둘 수 없는/);
      }
      assert.equal(trees(), mark, 'refused trees are not forwarded');
      // A tree made through the team library cannot be committed through mine (or the other way round). (A blob is
      // named in a library's tree only after its upload through that library: the same bytes once more for team.)
      assert.equal(await blobSha(A.code, Buffer.from('{"version":1,"items":[{"id":"x"}]}'), 'team'), json);
      const viaTeam = await postTree(A, 'team', [file(`people/${A.id}/papers/p1/ai.json`, json)], H.tree);
      const viaMine = await postTree(A, 'mine', [file(`${A.root}people/${A.id}/papers/q1/annotations.json`, json)], H.tree);
      assert.equal(viaTeam.status, 201, viaTeam.text);
      assert.equal(viaMine.status, 201, viaMine.text);
      ghErr(await proxy('mine', '/git/commits', { code: A.code, method: 'POST', body: { message: 'x', tree: viaTeam.json.sha, parents: [H.commit] } }), 403, /트리/);
      ghErr(await proxy('team', '/git/commits', { code: A.code, method: 'POST', body: { message: 'x', tree: viaMine.json.sha, parents: [H.commit] } }), 403, /트리/);
      ghErr(await proxy('mine', '/git/commits', { code: B.code, method: 'POST', body: { message: 'x', tree: viaMine.json.sha, parents: [H.commit] } }), 403, /트리/);
      assert.deepEqual(viaMine.json.tree.map((e) => e.path), ['codes'], 'the answer lists only the way down');
      // An allowed commit in A's library.
      const done = await commitVia(gh, A, 'mine', [
        file(`${A.root}library.json`, libA2), file(`${A.root}papers/q2/paper.pdf`, pdf),
        file(`${A.root}people/${A.id}/papers/q2/ai.json`, json), file(`${A.root}people/${A.id}/papers/q1/ai.json`, null),
      ], '논문 추가 ‘가람 둘’');
      const after = gh.files(...TEAM);
      assert.equal(after.get(`${A.root}papers/q2/paper.pdf`)?.sha, pdf);
      assert.ok(!after.has(`${A.root}people/${A.id}/papers/q1/ai.json`));
      assert.ok(after.has(`${B.root}people/${B.id}/papers/r1/ai.json`) && after.has('papers/p1/paper.pdf'));
      assert.equal(done.message, '[가람] 논문 추가 ‘가람 둘’');
      assert.equal(gh.repo(...TEAM).get(done.sha, 'commit').message, `[가람] {lib:${A.lib}} 논문 추가 ‘가람 둘’`);
      return `${refusedMine.length} paths refused through mine, codes/ refused through team, cross-library trees refused; commit stored as "[가람] {lib:${A.lib}} …"`;
    },
  },
  {
    name: 'markers and 최근 활동: each library lists only its own lines (also past 100 commits of others); markers and other titles never reach a client',
    fn: async ({ A, B, gh }) => {
      seed(gh, A, B);
      const teamLib = await blobSha(A.code, Buffer.from(lib([{ id: 'p1', title: '공용 논문' }, { id: 'p2', title: '공용 둘' }])), 'team');
      await commitVia(gh, A, 'team', [file('library.json', teamLib)], '논문 추가 ‘공용 둘’');
      const aLib = await blobSha(A.code, Buffer.from(lib([{ id: 'q1', title: '가람 비밀 논문' }, { id: 'q2', title: '가람 둘' }])), 'mine');
      const aCommit = await commitVia(gh, A, 'mine', [file(`${A.root}library.json`, aLib)], '논문 추가 ‘가람 둘’');
      const bLib = await blobSha(B.code, Buffer.from(lib([{ id: 'r1', title: '나래 비밀 논문' }, { id: 'r2', title: '나래 둘' }])), 'mine');
      await commitVia(gh, B, 'mine', [file(`${B.root}library.json`, bLib)], '논문 추가 ‘나래 둘’');
      // A client may not steer its commit into another library's activity with a marker of its own.
      const aLib3 = await blobSha(A.code, Buffer.from(lib([{ id: 'q1', title: '가람 비밀 논문' }, { id: 'q2', title: '가람 둘' }, { id: 'q3', title: '셋' }])), 'mine');
      const spoof = await commitVia(gh, A, 'mine', [file(`${A.root}library.json`, aLib3)], `{lib:${B.lib}} {lib:team}논문 추가 ‘셋’`);
      // A loud change labelled with a summary the app hides (marker in front of it) gets the Worker's summary.
      const aLib4 = await blobSha(A.code, Buffer.from(lib([{ id: 'q1', title: '가람 비밀 논문' }, { id: 'q2', title: '가람 둘' }])), 'mine');
      ghErr(await postTree(A, 'mine', [file(`${A.root}library.json`, aLib4)], headOf(gh).tree), 403, /휴지통/);
      const aLib5 = await blobSha(A.code, Buffer.from(lib([{ id: 'q1', title: '가람 비밀 논문' }, { id: 'q2', title: '가람 둘', deleted: true, deletedAt: Date.now(), updatedAt: Date.now() }, { id: 'q3', title: '셋' }])), 'mine');
      await commitVia(gh, A, 'mine', [file(`${A.root}library.json`, aLib5)], '{lib:team}논문  정보 갱신');
      const team = await activity(A, 'team');
      assert.deepEqual(team.map((i) => [i.who, i.summary]), [['가람', '논문 추가 ‘공용 둘’'], [null, 'initial']]);
      const mineA = await activity(A, 'mine');
      assert.deepEqual(mineA.map((i) => [i.who, i.summary]), [
        ['가람', '공용 서재 변경: 폴더·논문 기록 변경(삭제 1)'], ['가람', '논문 추가 ‘셋’'], ['가람', '논문 추가 ‘가람 둘’'],
      ]);
      const mineB = await activity(B, 'mine');
      assert.deepEqual(mineB.map((i) => [i.who, i.summary]), [['나래', '논문 추가 ‘나래 둘’']]);
      assert.equal(gh.repo(...TEAM).get(spoof.sha, 'commit').message, `[가람] {lib:${A.lib}} 논문 추가 ‘셋’`);
      // GET git/commits: another library's commit shows no message.
      const viaTeam = await proxy('team', `/git/commits/${aCommit.sha}`, { code: B.code });
      assert.equal(viaTeam.status, 200, viaTeam.text);
      assert.equal(viaTeam.json.message, '');
      assert.equal((await proxy('mine', `/git/commits/${aCommit.sha}`, { code: A.code })).json.message, '[가람] 논문 추가 ‘가람 둘’');
      assert.equal((await proxy('mine', `/git/commits/${aCommit.sha}`, { code: B.code })).json.message, '');
      // 150 commits of the team library on top: A's own lines are still found on the next pages.
      for (let i = 0; i < 150; i++) gh.commitFiles(...TEAM, { 'papers/p1/translation.json': `{"version":1,"items":{"n":${i}}}` }, { message: `[다른 사람] {lib:team} 번역 ${i}` });
      const deep = await activity(A, 'mine', 2);
      assert.deepEqual(deep.map((i) => i.summary), ['공용 서재 변경: 폴더·논문 기록 변경(삭제 1)', '논문 추가 ‘셋’']);
      assert.equal((await activity(A, 'team', 5)).length, 5);
      for (const r of seen) assert.ok(!r.text.includes('{lib:'), `a marker reached a client: ${r.path}`);
      return `team [${team.map((i) => i.summary).join(' | ')}]; A [${mineA.map((i) => i.summary).join(' | ')}]; B [${mineB[0].summary}]; paging past 150 commits OK`;
    },
  },
  {
    name: 'markers: a code named with 40 emoji (80 UTF-16 units) still has its commits in its own library — never in 전체 공용 서재\'s 최근 활동 or commit messages',
    fn: async ({ A, B, gh }) => {
      seed(gh, A, B);
      const E = await person('🌸'.repeat(40));
      const libE = await blobSha(E.code, Buffer.from(lib([{ id: 'e1', title: '꽃 비밀 논문' }])), 'mine');
      const done = await commitVia(gh, E, 'mine', [file(`${E.root}library.json`, libE)], '논문 추가 ‘꽃 비밀 논문’');
      assert.equal(gh.repo(...TEAM).get(done.sha, 'commit').message, `[${E.name}] {lib:${E.lib}} 논문 추가 ‘꽃 비밀 논문’`);
      assert.equal(done.message, `[${E.name}] 논문 추가 ‘꽃 비밀 논문’`);
      const team = await activity(A, 'team');
      assert.ok(!JSON.stringify(team).includes('꽃 비밀 논문'), `in 전체 공용 서재: ${JSON.stringify(team)}`);
      assert.deepEqual((await activity(E, 'mine')).map((i) => [i.who, i.summary]), [[E.name, '논문 추가 ‘꽃 비밀 논문’']]);
      for (const who of [A, E]) assert.equal((await proxy('team', `/git/commits/${done.sha}`, { code: who.code })).json.message, '');
      return `"${[...done.message].slice(0, 8).join('')}…" in its own 최근 활동 only; team: [${team.map((i) => i.summary).join(' | ')}]`;
    },
  },
  {
    name: 'per-code size cap: the admin sets 1 MB for one code → its PDF over the cap 413 (its library\'s name); the team and other codes unaffected; report and validation',
    fn: async ({ A, B, gh }) => {
      seed(gh, A, B, { [`${A.root}papers/q1/paper.pdf`]: PDF(700_000, 'a') });
      // Reads may use a head up to 10 s old (per isolate); the first upload runs 11 s later so it sees this seed.
      const later = String(Date.now() + 11_000);
      const set = await admin(`/relay/admin/codes/${A.code}/library`, { method: 'PATCH', body: { maxBytes: 1_000_000 } });
      assert.equal(set.status, 200, set.text);
      assert.deepEqual(set.json, { code: A.code, name: '가람', libraryId: A.lib, maxBytes: 1_000_000 });
      const blobs = () => count(gh, 'POST', /\/git\/blobs$/);
      const mark = blobs();
      const full = ghErr(await upload(A.code, PDF(400_000, 'c'), 'mine', later), 413, /가람 서재의 저장 공간/);
      assert.match(full, /MB/);
      assert.equal(blobs(), mark, 'a refused upload is not forwarded');
      assert.equal((await upload(A.code, PDF(400_000, 'c'), 'team')).status, 201, 'the team library has room');
      assert.equal((await upload(B.code, PDF(400_000, 'd'), 'mine')).status, 201, 'B\'s library has the default cap');
      assert.equal((await upload(A.code, Buffer.from(JSON.stringify({ version: 1, items: Array(2000).fill('메모') })), 'mine')).status, 201, 'JSON always saves');
      const files = gh.files(...TEAM);
      const own = [...files.keys()].filter((p) => p.startsWith(A.root));
      const report = await admin(`/relay/admin/codes/${A.code.toLowerCase()}/library`);
      assert.equal(report.status, 200, report.text);
      assert.deepEqual(report.json, {
        code: A.code, name: '가람', libraryId: A.lib, papers: 1, trashed: 0, files: own.length,
        bytes: own.reduce((s, p) => s + gh.readFile(...TEAM, p).length, 0), maxBytes: 1_000_000,
      });
      for (const body of [{ maxBytes: 999_999 }, { maxBytes: 'x' }, { maxBytes: 1.5e6 + 0.5 }, { maxBytes: 1_000_000, name: 'x' }, {}, []]) {
        const r = await admin(`/relay/admin/codes/${A.code}/library`, { method: 'PATCH', body });
        assert.equal(r.status, 400, `${JSON.stringify(body)} → ${r.status}`);
        assert.match(r.json.error.message, /maxBytes/);
      }
      assert.equal((await admin('/relay/admin/codes/PR-ZZZZ-ZZZZ/library')).status, 404);
      assert.equal((await admin(`/relay/admin/codes/${A.code}/library`, { method: 'POST', body: {} })).status, 405);
      assert.equal((await call(`/relay/admin/codes/${A.code}/library`, { headers: { authorization: `Bearer ${A.code}` }, ip: IP })).status, 401);
      const reset = await admin(`/relay/admin/codes/${A.code}/library`, { method: 'PATCH', body: { maxBytes: null } });
      assert.equal(reset.json.maxBytes, 500_000_000);
      assert.equal((await upload(A.code, PDF(400_000, 'e'), 'mine')).status, 201, 'back to the default cap');
      return `1 MB cap → 413 "${full}"; team/B/JSON 201; report ${JSON.stringify(report.json)}; null → 500 MB`;
    },
  },
  {
    name: 'DELETE ?library=delete (the default): the code library and its team notes go in one commit; nothing else is touched',
    fn: async ({ A, B, gh }) => {
      const C = await person('다솜');
      seed(gh, A, B, {
        [`people/${C.id}/papers/p1/ai.json`]: note('다솜', 'team'),
        [`${C.root}library.json`]: lib([{ id: 's1', title: '다솜 하나' }, { id: 's2', title: '다솜 둘' }, { id: 's3', title: '버림', deleted: true }]),
        [`${C.root}papers/s1/paper.pdf`]: PDF(1800, 's'),
        [`${C.root}papers/s1/translation.json`]: '{"version":1,"items":{"s":1}}',
        [`${C.root}people/${C.id}/papers/s1/ai.json`]: note('다솜', 'ai'),
      });
      assert.equal((await req('/shared', { code: C.code })).json.libraryId, C.lib);
      const before = shaMap(gh);
      const commits = gh.commits(...TEAM).length;
      const doomed = [...before.keys()].filter((p) => p.startsWith(C.root) || p.startsWith(`people/${C.id}/`)).sort();
      const res = await admin(`/relay/admin/codes/${C.code}`, { method: 'DELETE' });
      assert.equal(res.status, 200, res.text);
      assert.deepEqual(res.json, { deleted: true, purgedFiles: 1, library: { action: 'delete', papers: 2, files: 4 } });
      const after = shaMap(gh);
      assert.deepEqual([...after].sort(), [...before].filter(([p]) => !doomed.includes(p)).sort());
      const all = gh.commits(...TEAM);
      assert.equal(all.length, commits + 1, 'one commit');
      assert.deepEqual(all[0].deleted, doomed);
      assert.equal(all[0].message, `[관리자] {lib:team} ${CODE_DELETE_SUMMARY}\n{lib:${C.lib}} 코드 삭제로 서재 비움`);
      const top = (await activity(A, 'team'))[0];
      assert.deepEqual([top.who, top.summary], ['관리자', CODE_DELETE_SUMMARY]);
      assert.equal((await activity(A, 'mine')).some((i) => i.who === '관리자'), false, 'not in another code\'s activity');
      assert.deepEqual(await d1Rows('SELECT code FROM codes WHERE code = ?', C.code), []);
      return `${doomed.length} files (library ${4}, team notes 1) in one commit; ${JSON.stringify(res.json)}`;
    },
  },
  {
    name: 'DELETE ?library=move&to=…: records merged (clashing ids renamed), files moved, notes become the target holder\'s; one commit; the target sees it all',
    fn: async ({ A, B, gh }) => {
      const D = await person('라온');
      const E = await person('마루');
      const dNote1 = note('라온', 'p1');
      const dNote2 = note('라온', 'p2');
      seed(gh, A, B, {
        [`people/${D.id}/papers/p1/annotations.json`]: note('라온', 'team'),
        [`${D.root}library.json`]: lib(
          [{ id: 'p1', title: '라온 하나', folderId: 'f2' }, { id: 'p2', title: '라온 둘', folderId: 'f1' }],
          [{ id: 'f1', name: 'ICU', parentId: null }, { id: 'f2', name: '섬망', parentId: 'f1' }],
        ),
        [`${D.root}papers/p1/paper.pdf`]: PDF(1700, '1'),
        [`${D.root}papers/p2/paper.pdf`]: PDF(1700, '2'),
        [`${D.root}papers/p2/translation.json`]: '{"version":1,"items":{"p2":1}}',
        [`${D.root}people/${D.id}/papers/p1/ai.json`]: dNote1,
        [`${D.root}people/${D.id}/papers/p2/annotations.json`]: dNote2,
        [`${E.root}library.json`]: lib([{ id: 'p1', title: '마루 하나' }], [{ id: 'f1', name: '마루 폴더', parentId: null }]),
        [`${E.root}papers/p1/paper.pdf`]: PDF(1700, 'e'),
        [`${E.root}people/${E.id}/papers/p1/ai.json`]: note('마루', 'p1'),
      });
      const before = shaMap(gh);
      const commits = gh.commits(...TEAM).length;
      const res = await admin(`/relay/admin/codes/${D.code}?library=move&to=${encodeURIComponent(E.code.toLowerCase().replace(/-/g, ' '))}`, { method: 'DELETE' });
      assert.equal(res.status, 200, res.text);
      assert.deepEqual(res.json, { deleted: true, purgedFiles: 1, library: { action: 'move', papers: 2, files: 5, renamed: 2 } });
      const after = shaMap(gh);
      assert.equal([...after.keys()].filter((p) => p.startsWith(D.root) || p.startsWith(`people/${D.id}/`)).length, 0);
      const merged = readJson(gh, `${E.root}library.json`);
      const folders = new Map(merged.folders.map((f) => [f.name, f]));
      const icu = folders.get('ICU').id;
      assert.notEqual(icu, 'f1');
      assert.deepEqual([folders.get('섬망').id, folders.get('섬망').parentId], ['f2', icu]);
      assert.equal(folders.get('마루 폴더').id, 'f1');
      const papers = new Map(merged.papers.map((p) => [p.title, p]));
      const p1 = papers.get('라온 하나').id;
      assert.match(p1, /^p_[0-9a-z]{8}$/);
      assert.deepEqual([papers.get('라온 하나').folderId, papers.get('라온 둘').id, papers.get('라온 둘').folderId], ['f2', 'p2', icu]);
      assert.equal(papers.get('마루 하나').id, 'p1');
      const moved = {
        [`${E.root}papers/${p1}/paper.pdf`]: before.get(`${D.root}papers/p1/paper.pdf`),
        [`${E.root}papers/p2/paper.pdf`]: before.get(`${D.root}papers/p2/paper.pdf`),
        [`${E.root}papers/p2/translation.json`]: before.get(`${D.root}papers/p2/translation.json`),
        [`${E.root}people/${E.id}/papers/${p1}/ai.json`]: gitSha(Buffer.from(dNote1)),
        [`${E.root}people/${E.id}/papers/p2/annotations.json`]: gitSha(Buffer.from(dNote2)),
      };
      for (const [p, sha] of Object.entries(moved)) assert.equal(after.get(p), sha, p);
      for (const [p, sha] of before) {
        if (p.startsWith(D.root) || p.startsWith(`people/${D.id}/`) || p === `${E.root}library.json`) continue;
        assert.equal(after.get(p), sha, `${p} must stay`);
      }
      const [top, ...rest] = gh.commits(...TEAM);
      assert.equal(rest.length, commits, 'one commit');
      assert.equal(top.message, `[관리자] {lib:team} ${CODE_DELETE_SUMMARY}\n{lib:${E.lib}} 삭제된 코드의 서재에서 논문 2편 옮겨 옴`);
      // The target holder sees everything through their own library; activity says what happened.
      const H = headOf(gh);
      const rec = (await listing(E, 'mine', H.tree, true)).json.tree.map((e) => e.path);
      for (const p of Object.keys(moved)) assert.ok(rec.includes(p), p);
      const noteBlob = await proxy('mine', `/git/blobs/${after.get(`${E.root}people/${E.id}/papers/${p1}/ai.json`)}`, { code: E.code, headers: { accept: 'application/vnd.github.raw' } });
      assert.equal(noteBlob.text, dNote1);
      const mineE = (await activity(E, 'mine'))[0];
      assert.deepEqual([mineE.who, mineE.summary], ['관리자', '삭제된 코드의 서재에서 논문 2편 옮겨 옴']);
      assert.equal((await activity(A, 'team'))[0].summary, CODE_DELETE_SUMMARY);
      return `p1 → ${p1}, f1 → ${icu}; 5 files moved, 2 notes now ${E.id}'s; ${JSON.stringify(res.json.library)}`;
    },
  },
  {
    name: 'DELETE with a library: bad parameters → 400/404 and nothing changes; GitHub down or a failing commit → 502, code back on, both libraries untouched; the retry completes',
    fn: async ({ A, B, gh }) => {
      const F = await person('바다');
      const G = await person('사랑');
      seed(gh, A, B, {
        [`people/${F.id}/papers/p1/ai.json`]: note('바다', 'team'),
        [`${F.root}library.json`]: lib([{ id: 'u1', title: '바다 하나' }]),
        [`${F.root}papers/u1/paper.pdf`]: PDF(1600, 'u'),
      });
      const before = shaMap(gh);
      const commits = gh.commits(...TEAM).length;
      const unchanged = async (what) => {
        assert.deepEqual([...shaMap(gh)].sort(), [...before].sort(), `${what}: files`);
        assert.equal(gh.commits(...TEAM).length, commits, `${what}: commits`);
        const row = (await admin('/relay/admin/codes')).json.codes.find((c) => c.code === F.code);
        assert.equal(row?.active, true, `${what}: the code is there and on`);
        assert.equal((await req('/relay/me', { code: F.code })).status, 200);
      };
      const del = (query) => admin(`/relay/admin/codes/${F.code}${query}`, { method: 'DELETE' });
      const bad = [['?library=keep', 400], ['?library=move', 400], ['?library=move&to=PR-ZZZZ-ZZZZ', 404], [`?library=move&to=${F.code}`, 400],
        ['?library=move&to=%E2%80%94', 404]];
      for (const [query, status] of bad) {
        const r = await del(query);
        assert.equal(r.status, status, `${query} → ${r.status} ${r.text}`);
        assert.match(r.json.error.message, KOREAN);
      }
      await unchanged('bad parameters');
      gh.setDown(true);
      let down;
      try {
        down = await del(`?library=move&to=${G.code}`);
      } finally {
        gh.setDown(false);
      }
      assert.equal(down.status, 502, down.text);
      assert.match(down.json.error.message, /다시 삭제해 주세요/);
      await unchanged('GitHub down');
      gh.failNext({ method: 'POST', path: /paper-team-library\/git\/commits$/, status: 500 });
      const failing = await del(`?library=move&to=${G.code}`);
      assert.equal(failing.status, 502, failing.text);
      await unchanged('a failing commit');
      const retry = await del(`?library=move&to=${G.code}`);
      assert.equal(retry.status, 200, retry.text);
      assert.deepEqual(retry.json, { deleted: true, purgedFiles: 1, library: { action: 'move', papers: 1, files: 1, renamed: 0 } });
      const after = shaMap(gh);
      assert.equal(after.get(`${G.root}papers/u1/paper.pdf`), before.get(`${F.root}papers/u1/paper.pdf`));
      assert.deepEqual(readJson(gh, `${G.root}library.json`).papers.map((p) => p.title), ['바다 하나']);
      return `${bad.length} bad requests refused; down → 502 "${down.json.error.message}"; failing commit → 502; retry moved 1 paper`;
    },
  },
  {
    name: 'DELETE with a library: the repo that holds the code library goes last — a failure in another shared library → 502, the code back on and its library untouched; the retry completes',
    fn: async ({ A, B, gh }) => {
      const H = await person('하늘');
      const J = await person('조약돌');
      seed(gh, A, B, {
        [`people/${H.id}/papers/p1/ai.json`]: note('하늘', 'team'),
        [`${H.root}library.json`]: lib([{ id: 'h1', title: '하늘 하나' }]),
        [`${H.root}papers/h1/paper.pdf`]: PDF(1700, 'h'),
        [`${H.root}people/${H.id}/papers/h1/ai.json`]: note('하늘', 'ai'),
      });
      gh.commitFiles(...SMALL, { 'library.json': lib([]), [`people/${H.id}/papers/s1/ai.json`]: note('하늘', 'small') }, { message: 'small' });
      try {
        const before = shaMap(gh);
        const commits = gh.commits(...TEAM).length;
        gh.failNext({ method: 'POST', path: /paper-small-library\/git\/commits$/, status: 500 });
        const del = () => admin(`/relay/admin/codes/${H.code}?library=move&to=${J.code}`, { method: 'DELETE' });
        const failing = await del();
        assert.equal(failing.status, 502, failing.text);
        assert.deepEqual([...shaMap(gh)].sort(), [...before].sort(), 'the team repo (and 하늘\'s library in it) is untouched');
        assert.equal(gh.commits(...TEAM).length, commits);
        assert.ok(gh.files(...SMALL).has(`people/${H.id}/papers/s1/ai.json`));
        const row = (await admin('/relay/admin/codes')).json.codes.find((c) => c.code === H.code);
        assert.equal(row?.active, true, 'the code is back on');
        assert.equal((await req('/shared', { code: H.code })).json.libraryId, H.lib, 'with its own library');
        const retry = await del();
        assert.equal(retry.status, 200, retry.text);
        assert.deepEqual(retry.json, { deleted: true, purgedFiles: 2, library: { action: 'move', papers: 1, files: 2, renamed: 0 } });
        const after = shaMap(gh);
        assert.equal(after.get(`${J.root}papers/h1/paper.pdf`), before.get(`${H.root}papers/h1/paper.pdf`));
        assert.ok(after.has(`${J.root}people/${J.id}/papers/h1/ai.json`));
        assert.ok(![...after.keys()].some((p) => p.startsWith(H.root) || p.includes(H.id)));
        assert.ok(![...gh.files(...SMALL).keys()].some((p) => p.includes(H.id)));
        return 'small fails first → 502, team repo unchanged, code on with its library; retry: small purged, then the library moved';
      } finally {
        gh.createRepo(...SMALL, { private: true }); // as setup left it: empty
      }
    },
  },
  {
    name: 'split by uploader on today\'s production shape: dry run = the exact plan (nothing written), apply = one commit, a re-run moves nothing',
    fn: async ({ gh }) => {
      const nv = await person('NV');
      const gen6 = await person('6기');
      const bom = await person('봄당');
      const bomTest = await person('봄당테스트');
      await person('관리자 비교테스트');
      assert.equal((await admin(`/relay/admin/codes/${bomTest.code}`, { method: 'PATCH', body: { active: false } })).status, 200);
      const now = Date.now();
      const library = {
        version: 1, updatedAt: now - 5000,
        folders: [{ id: 'f_chan', name: '찬영', parentId: null, createdAt: now - 9000, updatedAt: now - 9000 }],
        papers: [
          { id: 'p_lessons', title: 'Lessons in biostatistics', addedBy: '봄당테스트', folderId: null, deleted: true, deletedAt: now - 8000, deletedBy: '봄당테스트', updatedAt: now - 8000 },
          { id: 'p_moral', title: 'Moral Sensitivity in Psychiatric Practice', addedBy: '봄당', folderId: null, sha256: 'ab'.repeat(32), updatedAt: now - 7000 },
          { id: 'p_proc', title: 'Procedures Performed by Advanced Practice Provider', addedBy: '6기', folderId: 'f_chan', updatedAt: now - 6000 },
        ],
      };
      gh.createRepo(...TEAM, { private: true });
      gh.commitFiles(...TEAM, {
        'README.md': '# 논문 리더 데이터 저장소\n',
        'library.json': JSON.stringify(library),
        'papers/p_lessons/paper.pdf': PDF(1500, 'l'),
        'papers/p_moral/paper.pdf': PDF(1500, 'm'),
        'papers/p_moral/translation.json': '{"version":1,"items":{"m":1}}',
        'papers/p_proc/paper.pdf': PDF(1500, 'p'),
        'papers/p_proc/translation.json': '{"version":1,"items":{"p":1}}',
        [`people/${bom.id}/papers/p_moral/ai.json`]: note('봄당', 'ai'),
        [`people/${bom.id}/papers/p_moral/annotations.json`]: note('봄당', 'ann'),
        [`people/${gen6.id}/papers/p_proc/ai.json`]: note('6기', 'ai'),
        [`people/${nv.id}/papers/p_moral/ai.json`]: note('NV', 'ai'),
      }, { message: '[봄당] 논문 추가', time: now - 2 * DAY });
      const before = shaMap(gh);
      const commits = gh.commits(...TEAM).length;
      const plan = {
        moves: [
          { paperId: 'p_moral', title: 'Moral Sensitivity in Psychiatric Practice', toCode: '봄당', folderPath: '' },
          { paperId: 'p_proc', title: 'Procedures Performed by Advanced Practice Provider', toCode: '6기', folderPath: '찬영' },
        ],
        skipped: [{ paperId: 'p_lessons', title: 'Lessons in biostatistics', reason: '휴지통에 있음' }],
      };
      const split = (body) => admin('/relay/admin/shared/team/split-by-uploader', { method: 'POST', body });
      const dry = await split({ dryRun: true });
      assert.equal(dry.status, 200, dry.text);
      assert.deepEqual(dry.json, plan);
      assert.deepEqual((await split({})).json, plan, 'dryRun defaults to true');
      assert.equal(gh.commits(...TEAM).length, commits, 'the dry run writes nothing');
      const apply = await split({ dryRun: false });
      assert.equal(apply.status, 200, apply.text);
      assert.deepEqual(apply.json, { ...plan, commitSha: headOf(gh).commit });
      const all = gh.commits(...TEAM);
      assert.equal(all.length, commits + 1, 'one commit');
      assert.equal(all[0].message, `[관리자] {lib:team} 올린 사람의 코드 서재로 나누기\n{lib:${bom.lib}} 전체 공용 서재에서 논문 1편 옮겨 옴\n`
        + `{lib:${gen6.lib}} 전체 공용 서재에서 논문 1편 옮겨 옴`);
      const after = shaMap(gh);
      const want = {
        [`${bom.root}papers/p_moral/paper.pdf`]: before.get('papers/p_moral/paper.pdf'),
        [`${bom.root}papers/p_moral/translation.json`]: before.get('papers/p_moral/translation.json'),
        [`${bom.root}people/${bom.id}/papers/p_moral/ai.json`]: before.get(`people/${bom.id}/papers/p_moral/ai.json`),
        [`${bom.root}people/${bom.id}/papers/p_moral/annotations.json`]: before.get(`people/${bom.id}/papers/p_moral/annotations.json`),
        [`${gen6.root}papers/p_proc/paper.pdf`]: before.get('papers/p_proc/paper.pdf'),
        [`${gen6.root}papers/p_proc/translation.json`]: before.get('papers/p_proc/translation.json'),
        [`${gen6.root}people/${gen6.id}/papers/p_proc/ai.json`]: before.get(`people/${gen6.id}/papers/p_proc/ai.json`),
      };
      for (const [p, sha] of Object.entries(want)) assert.equal(after.get(p), sha, p);
      const gone = ['papers/p_moral/paper.pdf', 'papers/p_moral/translation.json', 'papers/p_proc/paper.pdf', 'papers/p_proc/translation.json',
        `people/${bom.id}/papers/p_moral/ai.json`, `people/${bom.id}/papers/p_moral/annotations.json`, `people/${gen6.id}/papers/p_proc/ai.json`];
      for (const p of gone) assert.ok(!after.has(p), `${p} moved`);
      for (const p of ['papers/p_lessons/paper.pdf', `people/${nv.id}/papers/p_moral/ai.json`, 'README.md']) assert.equal(after.get(p), before.get(p), `${p} stays`);
      const team = readJson(gh, 'library.json');
      assert.deepEqual(team.papers.map((p) => p.id), ['p_lessons']);
      assert.deepEqual(team.folders.map((f) => [f.id, f.name, f.deleted, f.deletedBy]), [['f_chan', '찬영', true, '관리자']]);
      assert.deepEqual(readJson(gh, `${bom.root}library.json`).papers.map((p) => [p.id, p.title, p.folderId, p.addedBy, p.sha256]),
        [['p_moral', 'Moral Sensitivity in Psychiatric Practice', null, '봄당', 'ab'.repeat(32)]]);
      const g = readJson(gh, `${gen6.root}library.json`);
      assert.deepEqual(g.folders.map((f) => [f.name, f.parentId, f.deleted ?? false]), [['찬영', null, false]]);
      assert.deepEqual(g.papers.map((p) => [p.id, p.folderId]), [['p_proc', g.folders[0].id]]);
      // Through the proxy: each code sees its own papers and notes; the team library shows neither.
      const H = headOf(gh);
      const bomTree = (await listing(bom, 'mine', H.tree, true)).json.tree.map((e) => e.path);
      assert.ok(bomTree.includes(`${bom.root}people/${bom.id}/papers/p_moral/annotations.json`) && bomTree.includes(`${bom.root}papers/p_moral/paper.pdf`));
      const nvTeam = (await listing(nv, 'team', H.tree, true)).json.tree.map((e) => e.path);
      assert.ok(!nvTeam.some((p) => p.includes('p_moral/paper') || p.includes('p_proc')), nvTeam.join());
      assert.ok(nvTeam.includes(`people/${nv.id}/papers/p_moral/ai.json`), 'NV\'s own note on Moral stays in the team library');
      const nvMine = (await listing(nv, 'mine', H.tree, true)).json.tree;
      assert.deepEqual(nvMine.map((e) => e.path), ['codes'], 'NV\'s own library is empty: only the way down');
      const teamTop = (await activity(nv, 'team'))[0];
      assert.deepEqual([teamTop.who, teamTop.summary], ['관리자', '올린 사람의 코드 서재로 나누기']);
      const bomTop = (await activity(bom, 'mine'))[0];
      assert.deepEqual([bomTop.who, bomTop.summary], ['관리자', '전체 공용 서재에서 논문 1편 옮겨 옴']);
      // A re-run: nothing more to move, no commit.
      const again = await split({ dryRun: false });
      assert.deepEqual(again.json, { moves: [], skipped: plan.skipped, commitSha: null });
      assert.deepEqual((await split({ dryRun: true })).json, { moves: [], skipped: plan.skipped });
      assert.equal(gh.commits(...TEAM).length, commits + 1);
      return `plan ${plan.moves.map((m) => `${m.paperId}→${m.toCode}${m.folderPath ? `/${m.folderPath}` : ''}`).join(', ')}; apply ${apply.json.commitSha.slice(0, 7)}; `
        + '찬영 tombstoned, Lessons kept; re-run: 0 moves, no commit';
    },
  },
  {
    name: 'split: a target code from before code libraries gets its library id on the apply (not on the dry run), its old-style notes come along; refusals',
    fn: async ({ gh }) => {
      const legacyId = personIdOf(LEGACY_CODES.custom); // OLD-WARD-7B: saltless personId, no library id yet
      gh.createRepo(...TEAM, { private: true });
      gh.commitFiles(...TEAM, {
        'library.json': lib([{ id: 'w1', title: '예전 그룹 논문', addedBy: '예전 그룹' }, { id: 'w2', title: '아무도', addedBy: '없는 사람' }]),
        'papers/w1/paper.pdf': PDF(1500, 'w'),
        [`people/${legacyId}/papers/w1/ai.json`]: note('예전 그룹', 'ai'),
      }, { message: 'initial' });
      const split = (body, opts = {}) => admin('/relay/admin/shared/team/split-by-uploader', { method: 'POST', body, ...opts });
      const dry = await split({ dryRun: true });
      assert.deepEqual(dry.json.moves.map((m) => [m.paperId, m.toCode]), [['w1', '예전 그룹']]);
      assert.deepEqual(dry.json.skipped, [{ paperId: 'w2', title: '아무도', reason: '같은 이름의 코드 없음' }]);
      assert.equal((await d1Rows('SELECT library_id FROM codes WHERE code = ?', LEGACY_CODES.custom))[0].library_id, null, 'the dry run writes nothing');
      const apply = await split({ dryRun: false });
      assert.equal(apply.status, 200, apply.text);
      const libId = (await d1Rows('SELECT library_id FROM codes WHERE code = ?', LEGACY_CODES.custom))[0].library_id;
      assert.match(libId ?? '', HEX16);
      const files = gh.files(...TEAM);
      assert.ok(files.has(`codes/${libId}/papers/w1/paper.pdf`) && files.has(`codes/${libId}/people/${legacyId}/papers/w1/ai.json`));
      const shared = await req('/shared', { code: 'old ward 7b' });
      assert.equal(shared.json.libraryId, libId, 'the code opens the library the split made');
      // Refusals: another library (no code libraries there), the wrong method, a bad body.
      assert.equal((await admin('/relay/admin/shared/small/split-by-uploader', { method: 'POST', body: {} })).status, 400);
      assert.equal((await admin('/relay/admin/shared/team/split-by-uploader')).status, 405);
      assert.equal((await split({ dryRun: 'no' })).status, 400);
      assert.equal((await split('[1]')).status, 400);
      assert.equal((await split({}, { admin: 'wrong-admin-token-0123456789', ip: '198.51.100.211' })).status, 401);
      return `OLD-WARD-7B got library ${libId} on the apply; w1 and its saltless-id note moved; refusals 400/405/401`;
    },
  },
  {
    name: 'purge also empties each code library\'s 휴지통 (tombstoned 30+ days in history): one commit, one 최근 활동 line per library',
    fn: async ({ A, B, gh }) => {
      const now = Date.now();
      gh.createRepo(...TEAM, { private: true });
      gh.commitFiles(...TEAM, {
        'library.json': lib([{ id: 'p_old', title: '오래', deleted: true, deletedAt: now - 40 * DAY, updatedAt: now - 40 * DAY }, { id: 'p_live', title: '살아있음' }]),
        'papers/p_old/paper.pdf': PDF(1500, 'o'),
        'papers/p_live/paper.pdf': PDF(1500, 'v'),
        [`${A.root}library.json`]: lib([{ id: 'q_old', title: '가람 오래', deleted: true, deletedAt: now - 45 * DAY, updatedAt: now - 45 * DAY }, { id: 'q_new', title: '가람 새로', deleted: true, deletedAt: now - 2 * DAY, updatedAt: now - 2 * DAY }]),
        [`${A.root}papers/q_old/paper.pdf`]: PDF(1500, 'q'),
        [`${A.root}people/${A.id}/papers/q_old/ai.json`]: note('가람', 'old'),
        [`${A.root}papers/q_new/paper.pdf`]: PDF(1500, 'n'),
        [`${B.root}library.json`]: lib([{ id: 'r_live', title: '나래 살아있음' }]),
        [`${B.root}papers/r_live/paper.pdf`]: PDF(1500, 'r'),
      }, { message: 'initial', time: now - 60 * DAY });
      const before = shaMap(gh);
      const res = await admin('/relay/admin/shared/team/purge', { method: 'POST', body: {} });
      assert.equal(res.status, 200, res.text);
      assert.deepEqual(res.json.purged, ['p_old', 'q_old']);
      assert.equal(res.json.files, 3);
      const after = shaMap(gh);
      for (const p of ['papers/p_old/paper.pdf', `${A.root}papers/q_old/paper.pdf`, `${A.root}people/${A.id}/papers/q_old/ai.json`]) assert.ok(!after.has(p), p);
      assert.equal([...before.keys()].filter((p) => !after.has(p)).length, 3, 'nothing else');
      assert.equal(gh.commits(...TEAM)[0].message, `[관리자] {lib:team} 휴지통 비우기: 30일 지난 논문 1개의 파일 1개 삭제\n`
        + `{lib:${A.lib}} 휴지통 비우기: 30일 지난 논문 1개의 파일 2개 삭제`);
      const top = (await activity(A, 'mine'))[0];
      assert.deepEqual([top.who, top.summary], ['관리자', '휴지통 비우기: 30일 지난 논문 1개의 파일 2개 삭제']);
      assert.equal((await activity(B, 'mine')).length, 0, 'B\'s library had nothing to purge');
      return `purged ${res.json.purged.join(', ')} (${res.json.files} files) in one commit with lines for team and ${A.lib}`;
    },
  },
  {
    name: 'no secret crosses: no team token, no marker, and no other code\'s library id or person id in any answer a code got',
    fn: async () => {
      for (const r of seen) {
        assert.ok(!r.text.includes(TEAM_TOKEN) && !r.headers.includes(TEAM_TOKEN), `team token in ${r.path}`);
        assert.ok(!r.text.includes('{lib:'), `marker in ${r.path}`);
        // Refusals may quote the path the caller sent (a test made up another library's path); answers may not.
        const who = people.find((p) => p.code === r.who || p.code.toLowerCase().replace(/-/g, ' ') === r.who.toLowerCase().replace(/-/g, ' '));
        if (!who || r.status >= 400) continue;
        for (const other of people) {
          if (other === who) continue;
          assert.ok(!r.text.includes(other.lib), `${other.name}'s library id in an answer to ${who.name}: ${r.path}`);
          assert.ok(!r.text.includes(other.id), `${other.name}'s person id in an answer to ${who.name}: ${r.path}`);
        }
      }
      const ok = seen.filter((r) => r.status < 400).length;
      return `${seen.length} answers (${ok} successful, checked for other codes' ids) to ${people.length} codes`;
    },
  },
];
