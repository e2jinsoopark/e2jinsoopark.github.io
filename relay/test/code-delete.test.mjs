// HTTP tests of invite-code deletion (DELETE /relay/admin/codes/<code>) and person salts against `wrangler dev` + the
// fake GitHub (tests/store/fake-github.mjs on 8792) + the fake Anthropic upstream: the deleted person's people/<id>/
// files leave every shared library in one "[관리자] …" commit per library (nothing else touched), GitHub failures keep
// the code, the deleted code is refused everywhere, a custom code made again is a new person, legacy (saltless) codes
// keep their personId, the schema step is idempotent, and usage history stays in the totals.
// The Worker's D1 here was migrated from the schema of before code deletion (lib.mjs migratedDatabase).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  applySql, call, close, d1Rows, LEGACY_CODES, newCode, OUT_DIR, personIdOf, personIdOfCode, saltOf, sendMessage, sqlRows,
  waitForRequests,
} from './lib.mjs';
import { CODE_DELETE_MESSAGE, CODE_DELETE_SUMMARY, QUIET_SUMMARIES } from '../src/shared-paths.js';

const TEAM = ['dindoopark', 'paper-team-library'];
const SMALL = ['dindoopark', 'paper-small-library'];
const LAB = ['dindoopark', 'lab-library'];
const BAD_CODE = '초대 코드가 올바르지 않거나 사용이 중지되었습니다.';
const IP = '198.51.100.201'; // this suite's own limiter bucket
const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(3000, 'p')]);
const SHARED_FILES = {
  'README.md': '# 논문 리더 데이터 저장소\n',
  'library.json': JSON.stringify({
    version: 1, updatedAt: 1, folders: [], papers: [{ id: 'p1', title: 'Sepsis' }, { id: 'p2', title: 'Delirium' }],
  }),
  'papers/p1/paper.pdf': PDF,
  'papers/p1/translation.json': '{"version":1,"items":{}}',
};

/** A person's files: annotations + ai for each paper. */
const notesOf = (id, papers = ['p1']) => Object.fromEntries(papers.flatMap((p) => [
  [`people/${id}/papers/${p}/annotations.json`, JSON.stringify({ version: 1, items: [{ id: `${id}-${p}` }] })],
  [`people/${id}/papers/${p}/ai.json`, JSON.stringify({ version: 1, summary: { markdown: `${id} 요약` } })],
]));

const shaMap = (gh, repo) => new Map([...gh.files(...repo)].map(([p, f]) => [p, f.sha]));
const under = (map, id) => [...map.keys()].filter((p) => p.startsWith(`people/${id}/`));
const headOf = (gh, [o, n]) => {
  const repo = gh.repo(o, n);
  const commit = repo.refs.get('heads/main');
  return { commit, tree: commit && repo.get(commit, 'commit').tree };
};

/** Every path of `before` except the removed ones is still there with the same content; nothing was added. */
function onlyRemoved(before, after, removed) {
  const want = new Map([...before].filter(([p]) => !removed.includes(p)));
  assert.deepEqual([...after].sort(), [...want].sort());
}

const del = (code, opts = {}) => call(`/relay/admin/codes/${encodeURIComponent(code)}`, { method: 'DELETE', admin: true, ...opts });
const list = (now) => call('/relay/admin/codes', { admin: true, now });
const withCode = (pathname, code, opts = {}) => call(pathname, { code, ip: IP, ...opts });
const proxy = (code, sub, opts = {}) => withCode(`/shared/team/gh/repos/team/library${sub}`, code, opts);

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

/** A new code through the admin API; its personId from the salt the Worker stored (no PERSON_ID_SECRET in tests). */
async function person(name, fields = {}) {
  const { code } = await newCode({ name, ...fields });
  return { code, name, id: await personIdOfCode(code) };
}

/** Upload a JSON blob and make a tree through the proxy as `who` (a shared_trees row for that person). */
async function treeVia(gh, who, filePath) {
  const content = Buffer.from(JSON.stringify({ version: 1, by: who.name })).toString('base64');
  const blob = await proxy(who.code, '/git/blobs', { method: 'POST', body: { encoding: 'base64', content } });
  assert.equal(blob.status, 201, blob.text);
  const tree = await proxy(who.code, '/git/trees', {
    method: 'POST',
    body: { base_tree: headOf(gh, TEAM).tree, tree: [{ path: filePath, mode: '100644', type: 'blob', sha: blob.json.sha }] },
  });
  assert.equal(tree.status, 201, tree.text);
  return tree.json.sha;
}

export async function setup({ gh }) {
  const A = await person('김삭제');
  const B = await person('박남음');
  const legacy = { code: LEGACY_CODES.generated, id: personIdOf(LEGACY_CODES.generated) };
  const legacyGroup = { code: LEGACY_CODES.custom, id: personIdOf(LEGACY_CODES.custom) };
  gh.createRepo(...TEAM, { private: true });
  gh.commitFiles(...TEAM, {
    ...SHARED_FILES, ...notesOf(A.id, ['p1', 'p2']), ...notesOf(B.id), ...notesOf(legacy.id), ...notesOf(legacyGroup.id),
  }, { message: 'initial' });
  gh.createRepo(...SMALL, { private: true });
  gh.commitFiles(...SMALL, {
    ...SHARED_FILES, [`people/${A.id}/papers/p1/ai.json`]: '{"version":1}', ...notesOf(B.id),
  }, { message: 'initial' });
  gh.createRepo(...LAB, { private: false });
  gh.commitFiles(...LAB, { ...SHARED_FILES, ...notesOf(B.id) }, { message: 'initial' });
  return { A, B, legacy, legacyGroup };
}

export const tests = [
  {
    name: 'schema: schema.sql runs twice on a new and on an old database; the Worker adds person_salt itself (legacy rows NULL, new codes 128-bit)',
    fn: async ({ schemaSteps }) => {
      // The Worker under test runs on a database made with the old schema, then schema.sql twice (run.mjs).
      assert.deepEqual(schemaSteps, ['test/legacy-schema.sql', 'schema.sql', 'schema.sql']);
      const base = path.join(OUT_DIR, 'schema-check');
      fs.rmSync(base, { recursive: true, force: true });
      const fresh = path.join(base, 'new');
      applySql(fresh, 'schema.sql');
      applySql(fresh, 'schema.sql');
      const freshColumns = sqlRows(fresh, 'PRAGMA table_info(codes)').map((c) => c.name);
      assert.ok(freshColumns.includes('person_salt'), freshColumns.join());
      const old = path.join(base, 'old');
      applySql(old, 'test/legacy-schema.sql');
      applySql(old, 'schema.sql');
      assert.ok(!sqlRows(old, 'PRAGMA table_info(codes)').some((c) => c.name === 'person_salt'),
        'CREATE TABLE IF NOT EXISTS cannot add a column to an existing table');
      sqlRows(old, 'ALTER TABLE codes ADD COLUMN person_salt TEXT'); // what src/db.js ensureSaltColumn does once
      applySql(old, 'schema.sql'); // and schema.sql still runs after it
      assert.throws(() => sqlRows(old, 'ALTER TABLE codes ADD COLUMN person_salt TEXT'), /duplicate column/i,
        'a second ALTER fails — why the ALTER is not in schema.sql');
      const live = (await d1Rows('PRAGMA table_info(codes)')).map((c) => c.name);
      assert.ok(live.includes('person_salt'), `the running Worker added the column: ${live.join()}`);
      const legacy = await d1Rows('SELECT code, person_salt FROM codes WHERE code IN (?, ?) ORDER BY code',
        LEGACY_CODES.custom, LEGACY_CODES.generated);
      assert.deepEqual(legacy, [{ code: LEGACY_CODES.custom, person_salt: null }, { code: LEGACY_CODES.generated, person_salt: null }]);
      const salted = await d1Rows("SELECT COUNT(*) AS n, SUM(length(person_salt) = 32 AND person_salt NOT GLOB '*[^0-9a-f]*') AS ok "
        + 'FROM codes WHERE person_salt IS NOT NULL');
      const unsalted = await d1Rows('SELECT code FROM codes WHERE person_salt IS NULL ORDER BY code');
      assert.deepEqual(unsalted.map((r) => r.code), [LEGACY_CODES.custom, LEGACY_CODES.generated], 'every code made by the Worker has a salt');
      assert.ok(salted[0].n > 0 && salted[0].ok === salted[0].n, JSON.stringify(salted));
      await reconnect(); // the Worker sat idle while wrangler ran: drop a keep-alive socket it may have closed
      return `new DB: schema.sql ×2, codes has person_salt; old DB: legacy → schema.sql → ALTER → schema.sql OK (2nd ALTER: duplicate column); `
        + `live DB: column added by the Worker, ${salted[0].n} codes with 32-hex salts, 2 legacy codes NULL`;
    },
  },
  {
    name: 'legacy codes (no salt) keep their personId and see their old notes; new codes get a salted one',
    fn: async ({ legacy, legacyGroup, A }) => {
      const gen = await withCode('/shared', 'pr 01dc 0de5');
      assert.equal(gen.status, 200, gen.text);
      assert.equal(gen.json.personId, legacy.id);
      assert.equal(legacy.id, personIdOf(LEGACY_CODES.generated), 'SHA-256 of the stored code, as before');
      const group = await withCode('/shared', 'old ward 7b');
      assert.equal(group.json?.personId, legacyGroup.id, group.text);
      // The legacy person still sees their own notes through the proxy.
      const ref = await proxy(LEGACY_CODES.generated, '/git/ref/heads/main');
      const commit = await proxy(LEGACY_CODES.generated, `/git/commits/${ref.json.object.sha}`);
      const tree = await proxy(LEGACY_CODES.generated, `/git/trees/${commit.json.tree.sha}?recursive=1`);
      const mine = tree.json.tree.filter((e) => e.type === 'blob' && e.path.startsWith('people/')).map((e) => e.path);
      assert.deepEqual(mine.sort(), Object.keys(notesOf(legacy.id)).sort());
      const a = await withCode('/shared', A.code);
      assert.equal(a.json.personId, personIdOf(A.code, await saltOf(A.code)));
      assert.notEqual(a.json.personId, personIdOf(A.code), 'a new code is not keyed on the code alone');
      return `${LEGACY_CODES.generated} → ${legacy.id}, ${LEGACY_CODES.custom} → ${legacyGroup.id} (unchanged); new ${A.code} → ${a.json.personId}`;
    },
  },
  {
    name: 'DELETE: only that person\'s people/<id>/ files go, one "[관리자] …" commit per library that had any; D1 row and shared_trees rows go, usage stays',
    fn: async ({ gh, fake, A, B }) => {
      const now = '2032-11-03T10:00:00+09:00';
      await treeVia(gh, A, `people/${A.id}/papers/p1/ai.json`);
      await treeVia(gh, B, `people/${B.id}/papers/p1/ai.json`);
      // One tree, and the proof of the blob uploaded for it (lib 'blob:team': what lets a tree name it).
      assert.deepEqual((await d1Rows('SELECT lib FROM shared_trees WHERE person = ? ORDER BY lib', A.id)).map((r) => r.lib), ['blob:team', 'team']);
      const sent = await sendMessage({ code: A.code, now, headers: { 'cf-connecting-ip': IP } });
      assert.equal(sent.status, 200, sent.text);
      const booked = await waitForRequests(A.code, 1, { now });
      assert.ok(fake.requests.length > 0);
      const before = { team: shaMap(gh, TEAM), small: shaMap(gh, SMALL), lab: shaMap(gh, LAB) };
      const commitsBefore = { team: gh.commits(...TEAM).length, small: gh.commits(...SMALL).length, lab: gh.commits(...LAB).length };
      const doomed = { team: under(before.team, A.id), small: under(before.small, A.id) };
      assert.equal(doomed.team.length, 4);
      assert.equal(doomed.small.length, 1);
      assert.equal(under(before.lab, A.id).length, 0);

      // Any spelling of the code, as PATCH.
      const res = await del(A.code.toLowerCase().replace(/-/g, ' '));
      assert.equal(res.status, 200, res.text);
      assert.deepEqual(res.json, { deleted: true, purgedFiles: 5 });

      const after = { team: shaMap(gh, TEAM), small: shaMap(gh, SMALL), lab: shaMap(gh, LAB) };
      onlyRemoved(before.team, after.team, doomed.team);
      onlyRemoved(before.small, after.small, doomed.small);
      assert.deepEqual([...after.lab], [...before.lab]);
      assert.equal(under(after.team, B.id).length, 2, 'the other person\'s notes stay');
      for (const [key, repo] of [['team', TEAM], ['small', SMALL]]) {
        const commits = gh.commits(...repo);
        assert.equal(commits.length, commitsBefore[key] + 1, `${key}: one commit`);
        assert.equal(commits[0].message, CODE_DELETE_MESSAGE);
        assert.deepEqual(commits[0].deleted, [...doomed[key]].sort());
        assert.deepEqual(commits[0].changed, commits[0].deleted, 'nothing but deletions');
        assert.ok(!commits[0].message.includes(A.id));
      }
      assert.equal(gh.commits(...LAB).length, commitsBefore.lab, 'lab: nothing there, no commit');

      // 최근 활동 shows the admin line (a summary the app does not hide), with no person id.
      const activity = await withCode('/shared/team/activity', B.code);
      assert.equal(activity.status, 200, activity.text);
      assert.deepEqual(activity.json.items[0].who, '관리자');
      assert.deepEqual(activity.json.items[0].summary, CODE_DELETE_SUMMARY);
      assert.ok(!QUIET_SUMMARIES.has(activity.json.items[0].summary));
      assert.ok(!/[0-9a-f]{16}/.test(JSON.stringify(activity.json)), activity.text);

      // D1: the code row and its shared_trees rows are gone; B's stay; the usage row is kept as history.
      assert.deepEqual(await d1Rows('SELECT code FROM codes WHERE code = ?', A.code), []);
      assert.equal((await d1Rows('SELECT COUNT(*) AS n FROM shared_trees WHERE person = ?', A.id))[0].n, 0);
      assert.ok((await d1Rows('SELECT COUNT(*) AS n FROM shared_trees WHERE person = ?', B.id))[0].n >= 1);
      assert.deepEqual(await d1Rows('SELECT code FROM usage WHERE code = ?', A.code), []);
      const history = await d1Rows("SELECT code, day, requests, usd FROM usage WHERE code LIKE 'deleted:%' AND code LIKE ?", `%:${A.code}`);
      assert.equal(history.length, 1, JSON.stringify(history));
      assert.match(history[0].code, new RegExp(`^deleted:\\d{4}-\\d\\d-\\d\\dT[^:]+:\\d\\d:[\\d.]+Z:${A.code}$`));
      assert.equal(history[0].requests, 1);
      assert.ok(close(history[0].usd, booked.usd, 1e-6), `${history[0].usd} vs ${booked.usd}`); // the report rounds to 1e-6
      assert.ok(!(await list()).json.codes.some((c) => c.code === A.code));
      return `purgedFiles 5 (team 4, small 1, lab none); commits "${CODE_DELETE_MESSAGE}"; activity ${activity.json.items[0].who}: `
        + `${activity.json.items[0].summary}; usage kept as ${history[0].code}`;
    },
  },
  {
    name: 'a deleted code → 401 on /relay/me, /v1/*, /shared, activity and the proxy (nothing forwarded); PATCH/DELETE → 404',
    fn: async ({ gh, fake, A }) => {
      const upstream = fake.requests.length;
      const github = gh.log.length;
      const checks = [
        ['/relay/me', {}], ['/v1/models', {}], ['/shared', {}], ['/shared/team/activity', {}],
        ['/v1/messages', { method: 'POST', body: { model: 'claude-haiku-5-5', max_tokens: 10, messages: [{ role: 'user', content: '안녕' }] } }],
      ];
      for (const [pathname, opts] of checks) {
        for (const spelling of [A.code, A.code.toLowerCase()]) {
          const res = await withCode(pathname, spelling, opts);
          assert.equal(res.status, 401, `${pathname}: ${res.status} ${res.text}`);
          assert.equal(res.json?.error?.type, 'authentication_error');
          assert.equal(res.json.error.message, BAD_CODE);
        }
      }
      const viaProxy = await call('/shared/team/gh/repos/team/library/git/ref/heads/main', {
        headers: { authorization: `Bearer ${A.code}` }, ip: IP,
      });
      assert.equal(viaProxy.status, 401, viaProxy.text);
      assert.equal(viaProxy.json?.message, BAD_CODE);
      assert.equal(fake.requests.length, upstream, 'nothing forwarded to Anthropic');
      assert.equal(gh.log.length, github, 'nothing sent to GitHub');
      const patch = await call(`/relay/admin/codes/${A.code}`, { method: 'PATCH', admin: true, body: { active: true } });
      assert.equal(patch.status, 404, patch.text);
      const again = await del(A.code);
      assert.equal(again.status, 404, again.text);
      assert.match(again.json.error.message, /찾을 수 없습니다/);
      return `${checks.length} endpoints × 2 spellings + proxy → 401 "${BAD_CODE}"; PATCH/DELETE again → 404`;
    },
  },
  {
    name: 'GitHub down → 502 (Korean), the code stays as it was (active, works, notes kept); a failure in the last library (the host, done last) → 502, the retry finishes',
    fn: async ({ gh }) => {
      const D = await person('최다운');
      const off = await person('정중지');
      assert.equal((await call(`/relay/admin/codes/${off.code}`, { method: 'PATCH', admin: true, body: { active: false } })).status, 200);
      gh.commitFiles(...TEAM, { ...notesOf(D.id), ...notesOf(off.id) }, { message: 'seed D' });
      const commits = gh.commits(...TEAM).length;
      let down;
      let offDown;
      gh.setDown(true);
      try {
        down = await del(D.code);
        offDown = await del(off.code);
      } finally {
        gh.setDown(false);
      }
      assert.equal(down.status, 502, down.text);
      assert.equal(down.json?.error?.type, 'api_error');
      assert.match(down.json.error.message, /공용 서재\(GitHub\)에 연결하지 못해.*다시 삭제해 주세요/);
      assert.equal(offDown.status, 502, offDown.text);
      const codes = (await list()).json.codes;
      assert.equal(codes.find((c) => c.code === D.code)?.active, true, 'kept, and switched back on');
      assert.equal(codes.find((c) => c.code === off.code)?.active, false, 'a stopped code stays stopped');
      const me = await withCode('/relay/me', D.code);
      assert.equal(me.status, 200, me.text);
      assert.equal(under(shaMap(gh, TEAM), D.id).length, 2);
      assert.equal(gh.commits(...TEAM).length, commits);

      // GitHub fails on the last library's commit (the repo that holds the code libraries goes after every other
      // library): the other library is cleaned, the code is kept; the retry cleans the last one only (the other has
      // nothing left: no second commit there).
      const E = await person('한부분');
      gh.commitFiles(...TEAM, notesOf(E.id), { message: 'seed E team' });
      gh.commitFiles(...SMALL, notesOf(E.id), { message: 'seed E small' });
      const smallCommits = gh.commits(...SMALL).length;
      gh.failNext({ method: 'POST', path: /paper-team-library\/git\/commits$/, status: 500 });
      const partial = await del(E.code);
      assert.equal(partial.status, 502, partial.text);
      assert.equal(under(shaMap(gh, SMALL), E.id).length, 0, 'the other library cleaned first');
      assert.equal(under(shaMap(gh, TEAM), E.id).length, 2, 'the host library (last) not yet');
      assert.equal((await list()).json.codes.find((c) => c.code === E.code)?.active, true);
      const retry = await del(E.code);
      assert.equal(retry.status, 200, retry.text);
      assert.deepEqual(retry.json, { deleted: true, purgedFiles: 2 });
      assert.equal(under(shaMap(gh, TEAM), E.id).length, 0);
      assert.equal(gh.commits(...SMALL).length, smallCommits + 1, 'small: only the first attempt\'s commit');

      const finish = await del(D.code);
      assert.equal(finish.status, 200, finish.text);
      assert.deepEqual(finish.json, { deleted: true, purgedFiles: 2 });
      assert.equal((await del(off.code)).status, 200);
      return `down → 502 "${down.json.error.message}"; D active again + /relay/me 200; partial failure (host library, done last) → 502, retry → purgedFiles 2 in team only`;
    },
  },
  {
    name: 'a push landing during the delete (422 on the ref) → planned again from the new head: the raced note goes too, the other change stays',
    fn: async ({ gh }) => {
      const G = await person('경쟁자');
      gh.commitFiles(...TEAM, notesOf(G.id), { message: 'seed G' });
      const hold = gh.pauseNext({ method: 'PATCH', path: /paper-team-library\/git\/refs\/heads\/main$/ });
      const pending = del(G.code);
      await hold.hit;
      // Someone else's push (and G's own last write that raced the switch-off) lands first.
      gh.commitFiles(...TEAM, {
        [`people/${G.id}/papers/p2/ai.json`]: '{"version":1,"raced":true}',
        'papers/p2/translation.json': '{"version":1,"items":{"raced":true}}',
      }, { message: '[이간호사] 번역 ‘Delirium’' });
      const racedHead = headOf(gh, TEAM).commit;
      hold.release();
      const res = await pending;
      assert.equal(res.status, 200, res.text);
      assert.deepEqual(res.json, { deleted: true, purgedFiles: 3 });
      const files = shaMap(gh, TEAM);
      assert.equal(under(files, G.id).length, 0);
      assert.ok(files.has('papers/p2/translation.json'), 'the other push is kept');
      const [top] = gh.commits(...TEAM);
      assert.equal(top.message, CODE_DELETE_MESSAGE);
      assert.deepEqual(top.parents, [racedHead]);
      const refs = gh.log.filter((e) => e.method === 'PATCH' && /paper-team-library\/git\/refs/.test(e.path)).slice(-2);
      assert.deepEqual(refs.map((e) => e.status), [422, 200]);
      return 'ref 422 → re-planned on the raced head → 3 files in one commit on top of it';
    },
  },
  {
    name: 'a very large repo (GitHub truncates the recursive listing): the person\'s folder is found level by level',
    fn: async ({ gh, B }) => {
      const H = await person('대용량');
      const many = Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`papers/q${i}/translation.json`, `{"n":${i}}`]));
      gh.commitFiles(...TEAM, { ...many, ...notesOf(H.id, ['p1', 'p2']) }, { message: 'seed H' });
      const before = shaMap(gh, TEAM);
      const doomed = under(before, H.id);
      const mark = gh.log.length;
      gh.setTruncateRecursive(12);
      let res;
      try {
        res = await del(H.code);
      } finally {
        gh.setTruncateRecursive(0);
      }
      assert.equal(res.status, 200, res.text);
      assert.deepEqual(res.json, { deleted: true, purgedFiles: 4 });
      onlyRemoved(before, shaMap(gh, TEAM), doomed);
      assert.equal(under(shaMap(gh, TEAM), B.id).length, 2);
      const walked = gh.log.slice(mark).filter((e) => e.method === 'GET' && /paper-team-library\/git\/trees\//.test(e.path));
      assert.ok(walked.some((e) => !e.query.includes('recursive')), 'non-recursive listings (the walk) were made');
      return `${doomed.length} files found through ${walked.length} tree listings (recursive one truncated at 12)`;
    },
  },
  {
    name: 'a custom code deleted and made again is a new person: new salt and personId, no old notes, old usage not attached',
    fn: async ({ gh }) => {
      const now = '2033-02-10T11:00:00+09:00';
      const first = await newCode({ name: '7병동', code: 'round7-team' }, now);
      assert.equal(first.code, 'ROUND7-TEAM');
      const salt1 = await saltOf(first.code);
      const pid1 = personIdOf(first.code, salt1);
      assert.equal((await withCode('/shared', 'round7team')).json?.personId, pid1);
      const sent = await sendMessage({ code: 'ROUND7-TEAM', now, headers: { 'cf-connecting-ip': IP } });
      assert.equal(sent.status, 200, sent.text);
      await waitForRequests(first.code, 1, { now });
      gh.commitFiles(...TEAM, notesOf(pid1), { message: 'seed round7' });
      const res = await del('Round7 Team');
      assert.deepEqual(res.json, { deleted: true, purgedFiles: 2 });

      const again = await newCode({ name: '7병동', code: 'round7 team' }, now);
      assert.equal(again.code, 'ROUND7-TEAM');
      const salt2 = await saltOf(again.code);
      assert.notEqual(salt2, salt1);
      const pid2 = personIdOf(again.code, salt2);
      assert.notEqual(pid2, pid1);
      const info = await withCode('/shared', 'ROUND7-TEAM');
      assert.equal(info.json?.personId, pid2, info.text);
      const ref = await proxy('ROUND7-TEAM', '/git/ref/heads/main');
      const commit = await proxy('ROUND7-TEAM', `/git/commits/${ref.json.object.sha}`);
      const tree = await proxy('ROUND7-TEAM', `/git/trees/${commit.json.tree.sha}?recursive=1`);
      assert.equal(tree.status, 200, tree.text);
      assert.deepEqual(tree.json.tree.filter((e) => e.path.startsWith('people/')), [], 'no notes of anyone, old ones gone');
      assert.equal(under(shaMap(gh, TEAM), pid1).length, 0);
      const me = await withCode('/relay/me', 'ROUND7-TEAM', { now });
      assert.equal(me.status, 200, me.text);
      assert.equal(me.json.todayUsd, 0, 'the old code\'s spend today does not count against the new one');
      assert.equal(me.json.todayRequests, 0);
      const record = (await list(now)).json.codes.find((c) => c.code === 'ROUND7-TEAM');
      assert.deepEqual([record.totalRequests, record.totalUsd, record.active], [0, 0, true]);
      return `ROUND7-TEAM: personId ${pid1} → ${pid2}; new person sees no people/ files; usage starts at 0`;
    },
  },
  {
    name: 'totals: a deleted code\'s usage stays in todayTotalUsd / monthTotalUsd and the usage report, and shows as deletedUsage',
    fn: async () => {
      const now = '2033-05-20T10:00:00+09:00';
      const X = await newCode({ name: '사용후삭제' }, now);
      for (let i = 0; i < 2; i++) {
        const sent = await sendMessage({ code: X.code, now, headers: { 'cf-connecting-ip': IP } });
        assert.equal(sent.status, 200, sent.text);
      }
      const day = await waitForRequests(X.code, 2, { now });
      const before = (await list(now)).json;
      const mine = before.codes.find((c) => c.code === X.code);
      assert.ok(mine.todayUsd > 0 && close(mine.todayUsd, day.usd, 1e-9), JSON.stringify(mine));
      const report = async () => (await call('/relay/admin/usage?days=1', { admin: true, now })).json.days[0];
      const usageBefore = await report();

      assert.deepEqual((await del(X.code)).json, { deleted: true, purgedFiles: 0 });
      const after = (await list(now)).json;
      assert.ok(!after.codes.some((c) => c.code === X.code));
      assert.ok(close(after.todayTotalUsd, before.todayTotalUsd, 2e-6), `${after.todayTotalUsd} vs ${before.todayTotalUsd}`);
      assert.ok(close(after.monthTotalUsd, before.monthTotalUsd, 2e-6), `${after.monthTotalUsd} vs ${before.monthTotalUsd}`);
      assert.ok(close(after.deletedUsage.todayUsd - before.deletedUsage.todayUsd, mine.todayUsd, 2e-6), JSON.stringify(after.deletedUsage));
      assert.ok(close(after.deletedUsage.monthUsd - before.deletedUsage.monthUsd, mine.monthUsd, 2e-6));
      assert.equal(after.deletedUsage.totalRequests - before.deletedUsage.totalRequests, 2);
      assert.deepEqual(Object.keys(after.deletedUsage).sort(), ['monthUsd', 'todayUsd', 'totalRequests', 'totalUsd']);
      const usageAfter = await report();
      assert.ok(close(usageAfter.usd, usageBefore.usd, 2e-6) && usageAfter.requests === usageBefore.requests);
      return `month total ${after.monthTotalUsd} unchanged; deletedUsage ${JSON.stringify(after.deletedUsage)}`;
    },
  },
  {
    name: 'deleting a legacy (saltless) group code removes its old people/<sha256(code)>/ folder; the other legacy code is untouched',
    fn: async ({ gh, legacy, legacyGroup }) => {
      const before = shaMap(gh, TEAM);
      const doomed = under(before, legacyGroup.id);
      assert.equal(doomed.length, 2);
      const res = await del('old ward 7b');
      assert.equal(res.status, 200, res.text);
      assert.deepEqual(res.json, { deleted: true, purgedFiles: 2 });
      onlyRemoved(before, shaMap(gh, TEAM), doomed);
      const still = await withCode('/shared', LEGACY_CODES.generated);
      assert.equal(still.json?.personId, legacy.id, still.text);
      assert.equal(under(shaMap(gh, TEAM), legacy.id).length, 2);
      assert.equal((await withCode('/relay/me', 'OLD-WARD-7B')).status, 401);
      return `${LEGACY_CODES.custom} (personId ${legacyGroup.id}) deleted with 2 files; ${LEGACY_CODES.generated} still ${legacy.id}`;
    },
  },
  {
    name: 'CORS: the app may send DELETE (preflight lists it; the answer carries the CORS headers)',
    fn: async () => {
      const victim = await newCode({ name: '브라우저삭제' });
      const origin = 'http://localhost:5173';
      const pre = await call(`/relay/admin/codes/${victim.code}`, {
        method: 'OPTIONS', origin,
        headers: { 'access-control-request-method': 'DELETE', 'access-control-request-headers': 'authorization' },
      });
      assert.equal(pre.status, 204);
      assert.match(pre.headers.get('access-control-allow-methods'), /\bDELETE\b/);
      assert.equal(pre.headers.get('access-control-allow-origin'), origin);
      const res = await del(victim.code, { origin });
      assert.equal(res.status, 200, res.text);
      assert.equal(res.headers.get('access-control-allow-origin'), origin);
      const wrong = await call(`/relay/admin/codes/${victim.code}`, { method: 'DELETE', admin: 'wrong-token-0123456789abcdef', ip: '198.51.100.202' });
      assert.equal(wrong.status, 401, wrong.text);
      return `preflight allow-methods "${pre.headers.get('access-control-allow-methods')}"; wrong admin token → 401`;
    },
  },
];
