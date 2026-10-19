// Pure-module tests of code libraries (docs/SHARED.md §6): the path rules per library root, commit markers, and the
// planning of library delete / move and of the split by uploader (src/shared-paths.js, src/code-libraries.js). No servers.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { applySplit, planLibraryDelete, planLibraryMove, planSplit, SPLIT_SKIP } from '../src/code-libraries.js';
import { DEFAULT_CODE_LIBRARY_MAX_BYTES, hostLibrary, parseSharedLibraries, readConfig } from '../src/config.js';
import { hasSharedTree, insertSharedBlob, insertSharedTree, SHARED_TREE_KEEP_MS, uploadedBlobs } from '../src/db.js';
import {
  adminMessage, checkTreeEntries, classifyIn, clientSummary, codeRoot, commitLines, commitMessageFor, filterEntries,
  markerOf, messageFor, parseCommitLine, scrubText, visibleIn,
} from '../src/shared-paths.js';

const ME = 'a1b2c3d4e5f60718';
const OTHER = '0f1e2d3c4b5a6978';
const LIB = '1234567890abcdef';
const LIB2 = 'fedcba0987654321';
const ROOT = codeRoot(LIB);
const SHA = 'a'.repeat(40);
const SHA2 = 'b'.repeat(40);
const NOW = Date.parse('2026-10-19T12:00:00Z');
const file = (path, sha = SHA) => ({ path, mode: '100644', type: 'blob', sha });
const files = (paths) => new Map(paths.map((p, i) => [p, { sha: (i + 1).toString(16).padStart(40, '0'), size: 10 }]));

/**
 * A D1-shaped database on an in-memory SQLite with relay/schema.sql (prepare → bind → run / all / first, batch):
 * enough for the shared_trees helpers of src/db.js.
 */
async function memoryD1() {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  db.exec(fs.readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  const statement = (sql, args = []) => ({
    bind: (...next) => statement(sql, next),
    run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...args).changes) } }),
    all: async () => ({ results: db.prepare(sql).all(...args).map((r) => ({ ...r })) }),
    first: async () => { const r = db.prepare(sql).get(...args); return r ? { ...r } : null; },
  });
  return { prepare: (sql) => statement(sql), batch: async (list) => { const out = []; for (const st of list) out.push(await st.run()); return out; }, raw: db };
}

export const tests = [
  {
    name: 'code libraries: upload proofs (D1) — per person and library, an hour long, never read as a tree; many shas in one query',
    fn: async () => {
      const db = await memoryD1();
      const sha = (n) => n.toString(16).padStart(40, '0');
      await insertSharedBlob(db, { lib: `code:${LIB}`, sha: sha(1), person: ME, now: NOW });
      await insertSharedBlob(db, { lib: `code:${LIB}`, sha: sha(1), person: ME, now: NOW + 5 }); // again: one row
      await insertSharedBlob(db, { lib: 'team', sha: sha(2), person: ME, now: NOW });
      const got = (lib, person, since, shas = [sha(1), sha(2), sha(3)]) => uploadedBlobs(db, { lib, shas, person, since });
      assert.deepEqual([...await got(`code:${LIB}`, ME, NOW - 1)], [sha(1)]);
      assert.deepEqual([...await got('team', ME, NOW - 1)], [sha(2)]);
      assert.deepEqual([...await got(`code:${LIB2}`, ME, NOW - 1)], [], 'another library');
      assert.deepEqual([...await got(`code:${LIB}`, OTHER, NOW - 1)], [], 'another person');
      assert.deepEqual([...await got(`code:${LIB}`, ME, NOW + 6)], [], 'too old');
      assert.equal(await hasSharedTree(db, { lib: `code:${LIB}`, tree: sha(1), person: ME, since: 0 }), false, 'a proof is not a tree');
      assert.equal(await hasSharedTree(db, { lib: `code:${LIB}`, tree: sha(1), base: '', person: ME, since: 0 }), false);
      const many = Array.from({ length: 205 }, (_, i) => sha(1000 + i));
      for (const s of many.filter((_, i) => i % 2 === 0)) await insertSharedBlob(db, { lib: 'team', sha: s, person: OTHER, now: NOW });
      assert.equal((await uploadedBlobs(db, { lib: 'team', shas: many, person: OTHER, since: 0 })).size, 103);
      // Pruned with the trees after SHARED_TREE_KEEP_MS.
      await insertSharedTree(db, { lib: 'team', tree: sha(9), base: '', person: ME, now: NOW + SHARED_TREE_KEEP_MS + 10 });
      assert.deepEqual(db.raw.prepare("SELECT lib, tree FROM shared_trees WHERE lib LIKE 'blob:%'").all(), []);
      return 'proofs keyed by library and person, 1 h, not trees; 205 shas in one query; pruned with the trees';
    },
  },
  {
    name: 'code libraries: visibleIn — the team root never shows codes/; a code library shows only the way down and its own folder',
    fn: () => {
      for (const p of ['', 'library.json', 'papers/p1/paper.pdf', 'people', `people/${ME}`, `people/${ME}/papers/p1/ai.json`]) {
        assert.ok(visibleIn(p, '', ME), p);
      }
      for (const p of ['codes', `codes/${LIB}`, `codes/${LIB}/library.json`, `people/${OTHER}`]) {
        assert.ok(!visibleIn(p, '', ME), p);
      }
      assert.ok(visibleIn('codesx', '', ME), 'only the codes folder itself is hidden, not a lookalike name');
      for (const p of ['', 'codes', `codes/${LIB}`, `${ROOT}library.json`, `${ROOT}papers/q1/paper.pdf`, `${ROOT}people`,
        `${ROOT}people/${ME}`, `${ROOT}people/${ME}/papers/q1/ai.json`]) {
        assert.ok(visibleIn(p, ROOT, ME), p);
      }
      for (const p of ['library.json', 'papers', 'papers/p1/paper.pdf', 'people', `people/${ME}`, 'README.md',
        `codes/${LIB2}`, `codes/${LIB2}/library.json`, `${ROOT}people/${OTHER}`, `${ROOT}people/${OTHER}/papers/q1/ai.json`,
        `codes/${LIB}x`, `codes/${LIB.slice(0, 15)}`]) {
        assert.ok(!visibleIn(p, ROOT, ME), p);
      }
      const rootListing = [{ path: 'README.md', type: 'blob', sha: SHA }, { path: 'codes', type: 'tree', sha: SHA },
        { path: 'library.json', type: 'blob', sha: SHA }, { path: 'papers', type: 'tree', sha: SHA }];
      assert.deepEqual(filterEntries(rootListing, '', ME).map((e) => e.path), ['README.md', 'library.json', 'papers']);
      assert.deepEqual(filterEntries(rootListing, '', ME, ROOT).map((e) => e.path), ['codes']);
      const codesListing = [{ path: LIB, type: 'tree', sha: SHA }, { path: LIB2, type: 'tree', sha: SHA2 }];
      assert.deepEqual(filterEntries(codesListing, 'codes', ME, ROOT).map((e) => e.path), [LIB]);
      assert.deepEqual(filterEntries(codesListing, 'codes', ME), []);
      return 'team root hides codes/; code root shows root → codes → its id only, its own people/<me>';
    },
  },
  {
    name: 'code libraries: tree entries — only paths under the library root with the team rules; the team root refuses codes/',
    fn: () => {
      const base = new Map([[`${ROOT}papers/q1/paper.pdf`, { sha: SHA }], [`${ROOT}people/${ME}/papers/q1/ai.json`, { sha: SHA }]]);
      const ok = checkTreeEntries([
        file(`${ROOT}library.json`), file(`${ROOT}papers/q2/paper.pdf`), file(`${ROOT}papers/q2/translation.json`),
        file(`${ROOT}people/${ME}/papers/q2/annotations.json`), { ...file(`${ROOT}people/${ME}/papers/q1/ai.json`), sha: null },
        file(`${ROOT}papers/q1/paper.pdf`, SHA),
      ], { me: ME, baseFiles: base, root: ROOT });
      assert.ok(ok.entries, ok.error);
      const bad = [
        file('library.json'), file('papers/p1/paper.pdf'), file(`people/${ME}/papers/p1/ai.json`),
        file(`codes/${LIB2}/library.json`), file(`${ROOT}people/${OTHER}/papers/q1/ai.json`), file(`${ROOT}README.md`),
        file(`${ROOT}papers/q1/paper.pdf`, SHA2), { ...file(`${ROOT}papers/q1/paper.pdf`), sha: null },
        { ...file(`${ROOT}library.json`), sha: null }, file(`${ROOT}../library.json`), file(`codes/${LIB}//library.json`),
        file(`codes/${LIB}x/library.json`), file(`${ROOT.toUpperCase()}library.json`), file(`${ROOT}codes/${LIB}/library.json`),
      ];
      for (const e of bad) assert.ok(checkTreeEntries([e], { me: ME, baseFiles: base, root: ROOT }).error, `${e.path} ${e.sha}`);
      for (const p of [`${ROOT}library.json`, `codes/${LIB}/papers/q1/paper.pdf`, 'codes/library.json']) {
        assert.match(checkTreeEntries([file(p)], { me: ME, baseFiles: null }).error, /둘 수 없는/, p);
      }
      assert.deepEqual(classifyIn(`${ROOT}papers/q1/paper.pdf`, ROOT), { kind: 'pdf', paperId: 'q1' });
      assert.equal(classifyIn('papers/q1/paper.pdf', ROOT), null);
      return `${bad.length} paths refused in a code library; codes/ refused in the team library`;
    },
  },
  {
    name: 'code libraries: commit markers — written by the Worker only, parsed per library, never in a summary',
    fn: () => {
      assert.equal(commitMessageFor('가람', '논문 추가 ‘X’', 'team'), '[가람] {lib:team} 논문 추가 ‘X’');
      assert.equal(commitMessageFor('가람', `{lib:${LIB2}} 논문 추가`, LIB), `[가람] {lib:${LIB}} 논문 추가`);
      assert.equal(commitMessageFor('가람', '{ lib : team }', LIB), `[가람] {lib:${LIB}}`);
      assert.equal(clientSummary('{lib:team}내 메모·AI  결과 동기화\n둘째'), '내 메모·AI 결과 동기화');
      const long = commitMessageFor('가람', '가'.repeat(400), LIB);
      assert.equal([...long].length, 200);
      assert.deepEqual(commitLines(`[가람] {lib:${LIB}} 폴더 만듦`), { who: '가람', lines: [{ marker: LIB, summary: '폴더 만듦' }] });
      assert.deepEqual(commitLines('[김] 예전 커밋'), { who: '김', lines: [{ marker: 'team', summary: '예전 커밋' }] });
      assert.deepEqual(commitLines('initial'), { who: null, lines: [{ marker: 'team', summary: 'initial' }] });
      const admin = adminMessage([{ marker: 'team', summary: '정리' }, { marker: LIB, summary: '옮겨 옴' }]);
      assert.equal(admin, `[관리자] {lib:team} 정리\n{lib:${LIB}} 옮겨 옴`);
      assert.deepEqual(commitLines(admin).lines, [{ marker: 'team', summary: '정리' }, { marker: LIB, summary: '옮겨 옴' }]);
      assert.equal(messageFor(admin, LIB), '[관리자] 옮겨 옴');
      assert.equal(messageFor(admin, LIB2), '');
      assert.equal(messageFor(`[가람] {lib:${LIB}} 논문 추가 ‘비밀 제목’`, 'team'), '', 'another library\'s title never shows');
      assert.equal(messageFor('[가람] 예전 커밋', 'team'), '[가람] 예전 커밋');
      assert.deepEqual(parseCommitLine(`[가람] {lib:${LIB}} people/${ME}/papers/q1/ai.json`), { who: '가람', summary: 'people/…/papers/q1/ai.json' });
      // A name of 40 characters outside the BMP (80 UTF-16 units) is still read as the name: the line stays its library's.
      const flowers = '🌸'.repeat(40);
      const emojiName = commitMessageFor(flowers, '논문 추가 ‘비밀 제목’', LIB);
      assert.deepEqual(commitLines(emojiName), { who: flowers, lines: [{ marker: LIB, summary: '논문 추가 ‘비밀 제목’' }] });
      assert.equal(messageFor(emojiName, 'team'), '');
      assert.equal(messageFor(emojiName, LIB), `[${flowers}] 논문 추가 ‘비밀 제목’`);
      assert.equal(scrubText(`codes/${LIB}/papers/q1`), 'codes/…/papers/q1');
      assert.equal(markerOf(''), 'team');
      assert.equal(markerOf(ROOT), LIB);
      return `${admin.replace('\n', ' ⏎ ')}`;
    },
  },
  {
    name: 'code libraries: config — "mine" is never a SHARED_LIBRARIES id; the "team" entry hosts code libraries; cap default 500 MB',
    fn: () => {
      const libs = parseSharedLibraries([{ id: 'mine', repo: 'a/b' }, { id: 'lab', repo: 'a/lab' }, { id: 'team', repo: 'a/team' }]);
      assert.deepEqual(libs.map((l) => l.id), ['lab', 'team']);
      assert.equal(hostLibrary({ sharedLibraries: libs }).id, 'team');
      assert.equal(hostLibrary({ sharedLibraries: libs.slice(0, 1) }).id, 'lab');
      assert.equal(hostLibrary({ sharedLibraries: [] }), null);
      assert.equal(readConfig({}).codeLibraryMaxBytes, DEFAULT_CODE_LIBRARY_MAX_BYTES);
      assert.equal(DEFAULT_CODE_LIBRARY_MAX_BYTES, 500_000_000);
      assert.equal(readConfig({ CODE_LIBRARY_MAX_BYTES: '2000000' }).codeLibraryMaxBytes, 2_000_000);
      assert.equal(readConfig({ CODE_LIBRARY_MAX_BYTES: '12' }).codeLibraryMaxBytes, DEFAULT_CODE_LIBRARY_MAX_BYTES);
      return 'mine refused; host = team (else first); CODE_LIBRARY_MAX_BYTES default 500000000';
    },
  },
  {
    name: 'split plan on today\'s production shape: Moral → 봄당, Procedures → 6기 (folder 찬영), Lessons stays (휴지통)',
    fn: () => {
      const library = productionLibrary();
      const plan = planSplit({ library, codes: PRODUCTION_CODES });
      assert.deepEqual(plan.moves, [
        { paperId: 'p_moral', title: 'Moral Sensitivity in Psychiatric Practice', toCode: '봄당', folderPath: '', code: 'BOMDANG-01' },
        { paperId: 'p_proc', title: 'Procedures Performed by Advanced Practice Provider', toCode: '6기', folderPath: '찬영', code: 'GEN6-2026' },
      ]);
      assert.deepEqual(plan.skipped, [{ paperId: 'p_lessons', title: 'Lessons in biostatistics', reason: SPLIT_SKIP.trashed }]);
      const twice = planSplit({ library, codes: [...PRODUCTION_CODES, { code: 'BOMDANG-02', name: '봄당' }] });
      assert.deepEqual(twice.skipped.map((s) => [s.paperId, s.reason]), [['p_lessons', SPLIT_SKIP.trashed], ['p_moral', SPLIT_SKIP.manyCodes]]);
      const odd = planSplit({
        library: { papers: [{ id: 'a', title: 'A' }, { id: 'b', addedBy: '없는 이름' }, { id: '../x', addedBy: '봄당' }, { id: 'c', addedBy: ' 봄당' }] },
        codes: PRODUCTION_CODES,
      });
      assert.deepEqual(odd.moves, []);
      assert.deepEqual(odd.skipped.map((s) => s.reason), [SPLIT_SKIP.noUploader, SPLIT_SKIP.noCode, SPLIT_SKIP.badId, SPLIT_SKIP.noCode]);
      return `moves ${plan.moves.map((m) => `${m.paperId}→${m.toCode}${m.folderPath ? `/${m.folderPath}` : ''}`).join(', ')}; skipped p_lessons`;
    },
  },
  {
    name: 'split apply: records leave the team library, folders recreated by name, holder notes move under the current personId, empty 찬영 tombstoned',
    fn: () => {
      const library = productionLibrary();
      const repoFiles = files([
        'library.json', 'papers/p_moral/paper.pdf', 'papers/p_moral/translation.json', 'papers/p_proc/paper.pdf',
        'papers/p_lessons/paper.pdf', `people/${BOM}/papers/p_moral/ai.json`, `people/${BOM}/papers/p_moral/annotations.json`,
        `people/${GEN}/papers/p_proc/ai.json`, `people/${NV}/papers/p_moral/ai.json`, `people/${BOM_OLD}/papers/p_moral/ai.json`,
      ]);
      const { moves } = planSplit({ library, codes: PRODUCTION_CODES });
      const targets = new Map([
        ['BOMDANG-01', { root: codeRoot(LIB), marker: LIB, library: null, personIds: [BOM, BOM_OLD], personId: BOM }],
        ['GEN6-2026', { root: codeRoot(LIB2), marker: LIB2, library: null, personIds: [GEN], personId: GEN }],
      ]);
      const out = applySplit({ library, files: repoFiles, moves, targets, now: NOW });
      assert.deepEqual(out.team.papers.map((p) => p.id), ['p_lessons']);
      const chan = out.team.folders.find((f) => f.id === 'f_chan');
      assert.deepEqual([chan.deleted, chan.deletedBy, chan.deletedAt], [true, '관리자', NOW]);
      assert.deepEqual(out.tombstoned, ['f_chan']);
      const bom = out.libraries.get(codeRoot(LIB));
      assert.deepEqual(bom.papers.map((p) => [p.id, p.folderId, p.addedBy]), [['p_moral', null, '봄당']]);
      assert.deepEqual(bom.folders, []);
      const gen = out.libraries.get(codeRoot(LIB2));
      assert.deepEqual(gen.folders.map((f) => [f.id, f.name, f.parentId]), [['f_chan', '찬영', null]]);
      assert.deepEqual(gen.papers.map((p) => [p.id, p.folderId]), [['p_proc', 'f_chan']]);
      const moved = new Map(out.entries.filter((e) => e.sha).map((e) => [e.path, e.sha]));
      const gone = out.entries.filter((e) => !e.sha).map((e) => e.path).sort();
      assert.deepEqual([...moved.keys()].sort(), [
        `${codeRoot(LIB)}papers/p_moral/paper.pdf`, `${codeRoot(LIB)}papers/p_moral/translation.json`,
        `${codeRoot(LIB)}people/${BOM}/papers/p_moral/ai.json`, `${codeRoot(LIB)}people/${BOM}/papers/p_moral/annotations.json`,
        `${codeRoot(LIB2)}papers/p_proc/paper.pdf`, `${codeRoot(LIB2)}people/${GEN}/papers/p_proc/ai.json`,
      ].sort());
      assert.equal(moved.get(`${codeRoot(LIB)}people/${BOM}/papers/p_moral/ai.json`), repoFiles.get(`people/${BOM}/papers/p_moral/ai.json`).sha);
      assert.ok(!gone.includes(`people/${NV}/papers/p_moral/ai.json`), 'another person\'s note stays');
      assert.ok(!gone.includes(`people/${BOM_OLD}/papers/p_moral/ai.json`), 'a duplicate under an old person id is not lost');
      assert.deepEqual(gone, ['papers/p_moral/paper.pdf', 'papers/p_moral/translation.json', 'papers/p_proc/paper.pdf',
        `people/${BOM}/papers/p_moral/ai.json`, `people/${BOM}/papers/p_moral/annotations.json`, `people/${GEN}/papers/p_proc/ai.json`].sort());
      assert.deepEqual([...out.counts], [['BOMDANG-01', 1], ['GEN6-2026', 1]]);
      // A target library that already has a folder 찬영 at the top and a paper p_proc: the folder is reused, the paper renamed.
      const busy = applySplit({
        library, files: repoFiles, moves: moves.filter((m) => m.code === 'GEN6-2026'), now: NOW,
        targets: new Map([['GEN6-2026', { root: codeRoot(LIB2), marker: LIB2, personIds: [GEN], personId: GEN,
          library: { version: 1, folders: [{ id: 'f_mine', name: '찬영', parentId: null }], papers: [{ id: 'p_proc', title: '다른 논문' }] } }]]),
      });
      const lib2 = busy.libraries.get(codeRoot(LIB2));
      assert.deepEqual(lib2.folders.map((f) => f.id), ['f_mine']);
      const added = lib2.papers[1];
      assert.match(added.id, /^p_[0-9a-z]{8}$/);
      assert.equal(added.folderId, 'f_mine');
      assert.ok(busy.entries.some((e) => e.path === `${codeRoot(LIB2)}papers/${added.id}/paper.pdf`));
      return `team keeps [p_lessons], 찬영 tombstoned; 6 files moved; a clashing p_proc became ${added.id} in the existing 찬영`;
    },
  },
  {
    name: 'library move: records merged by id, clashing folder/paper ids renamed with their references, notes become the target holder\'s',
    fn: () => {
      const A = codeRoot(LIB);
      const B = codeRoot(LIB2);
      const from = {
        version: 1,
        folders: [{ id: 'f1', name: 'ICU', parentId: null }, { id: 'f2', name: '섬망', parentId: 'f1' }],
        papers: [{ id: 'p1', title: 'A의 p1', folderId: 'f2' }, { id: 'p2', title: 'A의 p2', folderId: 'f1' },
          { id: 'p3', title: '휴지통', deleted: true }],
      };
      const to = { version: 1, extra: 'B', folders: [{ id: 'f1', name: 'B 폴더' }], papers: [{ id: 'p1', title: 'B의 p1' }] };
      const repoFiles = files([
        `${A}library.json`, `${A}papers/p1/paper.pdf`, `${A}papers/p2/paper.pdf`, `${A}papers/p2/translation.json`,
        `${A}people/${OTHER}/papers/p1/ai.json`, `${A}people/${OTHER}/papers/p2/annotations.json`,
        `${B}library.json`, `${B}papers/p1/paper.pdf`, `${B}papers/p9/paper.pdf`, `${B}people/${ME}/papers/p1/ai.json`,
      ]);
      const plan = planLibraryMove({
        files: repoFiles, fromRoot: A, toRoot: B, from, to, personMap: new Map([[OTHER, ME]]), now: NOW,
      });
      assert.equal(plan.papers, 2);
      assert.equal(plan.folders, 2);
      assert.equal(plan.renamed, 2, 'f1 and p1 clash');
      const folders = new Map(plan.library.folders.map((f) => [f.name, f]));
      const newF1 = folders.get('ICU').id;
      assert.notEqual(newF1, 'f1');
      assert.equal(folders.get('섬망').id, 'f2');
      assert.equal(folders.get('섬망').parentId, newF1);
      assert.equal(plan.library.extra, 'B');
      const papers = new Map(plan.library.papers.map((p) => [p.title, p]));
      const newP1 = papers.get('A의 p1').id;
      assert.match(newP1, /^p_[0-9a-z]{8}$/);
      assert.equal(papers.get('A의 p1').folderId, 'f2');
      assert.deepEqual([papers.get('A의 p2').id, papers.get('A의 p2').folderId], ['p2', newF1]);
      assert.equal(papers.get('B의 p1').id, 'p1');
      assert.ok(papers.get('휴지통').deleted);
      const writes = plan.entries.filter((e) => e.sha).map((e) => e.path).sort();
      assert.deepEqual(writes, [
        `${B}papers/${newP1}/paper.pdf`, `${B}papers/p2/paper.pdf`, `${B}papers/p2/translation.json`,
        `${B}people/${ME}/papers/${newP1}/ai.json`, `${B}people/${ME}/papers/p2/annotations.json`,
      ].sort());
      const deletes = plan.entries.filter((e) => !e.sha).map((e) => e.path).sort();
      assert.deepEqual(deletes, [...repoFiles.keys()].filter((p) => p.startsWith(A)).sort());
      assert.equal(planLibraryMove({ files: repoFiles, fromRoot: codeRoot('0'.repeat(16)), toRoot: B, from: null, to, personMap: new Map(), now: NOW }), null);
      assert.deepEqual(planLibraryDelete(repoFiles, A), [...repoFiles.keys()].filter((p) => p.startsWith(A)).sort());
      return `f1 → ${newF1}, p1 → ${newP1}; ${writes.length} files moved, notes ${OTHER} → ${ME}`;
    },
  },
];

const BOM = '1111111111111111';
const BOM_OLD = '1111111111111112';
const GEN = '2222222222222222';
const NV = '3333333333333333';
/** Codes as production has them (names; the codes are invented): 봄당테스트 is stopped. */
const PRODUCTION_CODES = [
  { code: 'NV-2026-A', name: 'NV' }, { code: 'GEN6-2026', name: '6기' }, { code: 'BOMDANG-01', name: '봄당' },
  { code: 'BOMDANG-TEST', name: '봄당테스트', active: 0 }, { code: 'ADMIN-CMP-1', name: '관리자 비교테스트' },
];

/** library.json shaped like the production team library on 2026-10-19 (titles and uploaders; ids invented). */
function productionLibrary() {
  return {
    version: 1,
    updatedAt: NOW - 1000,
    folders: [{ id: 'f_chan', name: '찬영', parentId: null, createdAt: NOW - 5000, updatedAt: NOW - 5000 }],
    papers: [
      { id: 'p_lessons', title: 'Lessons in biostatistics', addedBy: '봄당테스트', folderId: null, deleted: true, deletedAt: NOW - 3000, deletedBy: '봄당테스트', updatedAt: NOW - 3000 },
      { id: 'p_moral', title: 'Moral Sensitivity in Psychiatric Practice', addedBy: '봄당', folderId: null, updatedAt: NOW - 2000 },
      { id: 'p_proc', title: 'Procedures Performed by Advanced Practice Provider', addedBy: '6기', folderId: 'f_chan', updatedAt: NOW - 1500 },
    ],
  };
}
