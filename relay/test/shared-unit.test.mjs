// Pure-module tests of the shared library rules (src/shared-paths.js, config parsing, PDF sniffing). No servers.
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { parseSharedLibraries, DEFAULT_SHARED_MAX_BYTES, DEFAULT_SHARED_MAX_FILES } from '../src/config.js';
import {
  checkTreeEntries, classifyPath, commitMessageFor, compareLibraries, confirmedPurgeIds, describeSharedChange,
  filterEntries, paperFiles, parseCommitLine, parseLibrary, personIdFor, purgeablePaperIds, scrubText, visibleTo,
} from '../src/shared-paths.js';
import { looksLikePdf } from '../src/shared.js';

const ME = 'a1b2c3d4e5f60718';
const OTHER = '0f1e2d3c4b5a6978';
const SHA = 'a'.repeat(40);
const SHA2 = 'b'.repeat(40);
const file = (path, sha = SHA, extra = {}) => ({ path, mode: '100644', type: 'blob', sha, ...extra });
const DAY = 24 * 60 * 60 * 1000;

/** Paths a person must never be able to write (traversal, encodings, lookalikes, other people, outside the layout). */
const BAD_PATHS = [
  `people/${OTHER}/papers/p1/annotations.json`,
  `people/${OTHER}/papers/p1/ai.json`,
  'papers/../library.json',
  `papers/../people/${OTHER}/papers/p1/annotations.json`,
  `people/${ME}/../${OTHER}/papers/p1/ai.json`,
  'papers/p1/../../README.md',
  'papers/%2e%2e/paper.pdf',
  'papers/%2E%2E/p1/paper.pdf',
  'papers\\p1\\paper.pdf',
  'papers/p1\\..\\..\\library.json',
  '/library.json',
  './library.json',
  'library.json/',
  ' library.json',
  'library.json ',
  'Library.json',
  'ｌibrary.json', // fullwidth l
  'library․json', // one dot leader
  'librаry.json', // Cyrillic а
  'papers/p1/paper.pdf\u0000.json',
  'papers/p1/paper.pdf\n',
  'papers/pé/paper.pdf',
  'papers/p１/paper.pdf', // fullwidth digit
  `papers/${'x'.repeat(65)}/paper.pdf`,
  'papers//paper.pdf',
  'papers/p1/annotations.json',
  'papers/p1/ai.json',
  'papers/p1/other.json',
  'papers/p1',
  'papers',
  `people/${ME}/papers/p1/translation.json`,
  `people/${ME}/papers/p1/paper.pdf`,
  `people/${ME.toUpperCase()}/papers/p1/ai.json`,
  `people/${ME}x/papers/p1/ai.json`,
  `people/${ME}`,
  'README.md',
  '.github/workflows/x.yml',
  '.gitattributes',
];

export const tests = [
  {
    name: 'shared: personId = first 16 hex chars of SHA-256(normalised code)',
    fn: async () => {
      const code = 'PR-ABCD-EFGH';
      const expected = createHash('sha256').update(code).digest('hex').slice(0, 16);
      assert.equal(await personIdFor(code), expected);
      assert.match(expected, /^[0-9a-f]{16}$/);
      assert.notEqual(await personIdFor('PR-ABCD-EFGJ'), expected);
      // With the server secret it is an HMAC: not derivable from the code alone.
      const keyed = createHmac('sha256', 's3cret').update(code).digest('hex').slice(0, 16);
      assert.equal(await personIdFor(code, 's3cret'), keyed);
      assert.notEqual(keyed, expected);
      return `${code} → ${expected} (HMAC ${keyed})`;
    },
  },
  {
    name: 'shared: path layout (library.json, papers/<id>/{paper.pdf,translation.json}, people/<id>/papers/<id>/{annotations,ai}.json)',
    fn: () => {
      assert.deepEqual(classifyPath('library.json'), { kind: 'library' });
      assert.deepEqual(classifyPath('papers/p_k3j9x2ab/paper.pdf'), { kind: 'pdf', paperId: 'p_k3j9x2ab' });
      assert.deepEqual(classifyPath('papers/A-z_09/translation.json'), { kind: 'translation', paperId: 'A-z_09' });
      assert.deepEqual(classifyPath(`people/${ME}/papers/p1/ai.json`), { kind: 'personal', person: ME, paperId: 'p1' });
      assert.deepEqual(classifyPath(`papers/${'x'.repeat(64)}/paper.pdf`), { kind: 'pdf', paperId: 'x'.repeat(64) });
      for (const p of BAD_PATHS) {
        const c = classifyPath(p);
        assert.ok(c === null || c.kind === 'readme' || (c.kind === 'personal' && c.person === OTHER), `${JSON.stringify(p)} → ${JSON.stringify(c)}`);
      }
      return `${BAD_PATHS.length} malformed / foreign paths classified as outside the layout (or other person / README)`;
    },
  },
  {
    name: 'shared: tree entries — allowlist, own people/ only, deletions only under people/<me>/, PDFs immutable',
    fn: () => {
      const base = new Map([['papers/p1/paper.pdf', { sha: SHA }], ['library.json', { sha: SHA2 }]]);
      const ok = checkTreeEntries([
        file('library.json'), file('papers/p2/paper.pdf'), file('papers/p1/paper.pdf', SHA), file('papers/p1/translation.json'),
        file(`people/${ME}/papers/p1/annotations.json`), file(`people/${ME}/papers/p1/ai.json`, null),
        { path: 'library.json', mode: '100644', sha: SHA2 }, // type may be omitted
      ], { me: ME, baseFiles: base });
      assert.ok(ok.entries, ok.error);
      assert.equal(ok.entries.length, 7);
      assert.ok(ok.entries.every((e) => e.type === 'blob' && e.mode === '100644'));

      const refuse = (entries, baseFiles = base) => {
        const r = checkTreeEntries(entries, { me: ME, baseFiles });
        assert.ok(r.error && /[가-힣]/.test(r.error), `${JSON.stringify(entries)} → ${JSON.stringify(r)}`);
        return r.error;
      };
      for (const p of BAD_PATHS) refuse([file(p)]);
      const deletions = ['papers/p1/paper.pdf', 'papers/p1/translation.json', 'library.json', 'README.md',
        `people/${OTHER}/papers/p1/ai.json`, `people/${ME}`, `people/${ME}/papers/p1`, 'papers/p1', 'papers'];
      for (const p of deletions) refuse([file(p, null)]);
      const pdfMsg = refuse([file('papers/p1/paper.pdf', SHA2)]);
      assert.match(pdfMsg, /PDF/);
      refuse([file('papers/p1/translation.json', 'A'.repeat(40))]);
      refuse([file('papers/p1/translation.json', 'z'.repeat(40))]);
      refuse([file('papers/p1/translation.json', SHA.slice(1))]);
      refuse([file('library.json', SHA, { mode: '100755' })]);
      refuse([file('library.json', SHA, { mode: '120000' })]);
      refuse([file('library.json', SHA, { mode: '160000', type: 'commit' })]);
      refuse([file('papers', SHA, { mode: '040000', type: 'tree' })]);
      refuse([{ path: 'library.json', mode: '100644', type: 'blob', content: '{}' }]);
      refuse([{ path: 'library.json', mode: '100644', type: 'blob', sha: SHA, content: '{}' }]);
      refuse([{ path: 'library.json', mode: '100644', type: 'blob' }]);
      refuse([null]);
      refuse(['library.json']);
      refuse('library.json');
      refuse({ path: 'library.json' });
      // Without a base (the branch does not exist yet) nothing can be deleted, not even own files.
      refuse([file(`people/${ME}/papers/p1/ai.json`, null)], null);
      assert.ok(checkTreeEntries([file('papers/p1/paper.pdf', SHA2)], { me: ME, baseFiles: null }).entries);
      return `allowed 7 entries; refused ${BAD_PATHS.length} paths, ${deletions.length} deletions, PDF overwrite ("${pdfMsg}"), bad sha/mode/type/content`;
    },
  },
  {
    name: 'shared: listings hide people/<other> and everything under it (any prefix)',
    fn: () => {
      const entries = [
        { path: 'library.json', type: 'blob', sha: SHA, size: 10, url: 'https://api.github.com/repos/owner/repo/x' },
        { path: 'papers', type: 'tree', sha: SHA },
        { path: 'people', type: 'tree', sha: SHA },
        { path: `people/${ME}`, type: 'tree', sha: SHA },
        { path: `people/${ME}/papers/p1/ai.json`, type: 'blob', sha: SHA, size: 3 },
        { path: `people/${OTHER}`, type: 'tree', sha: SHA2 },
        { path: `people/${OTHER}/papers/p1/ai.json`, type: 'blob', sha: SHA2, size: 3 },
      ];
      const root = filterEntries(entries, '', ME).map((e) => e.path);
      assert.deepEqual(root, ['library.json', 'papers', 'people', `people/${ME}`, `people/${ME}/papers/p1/ai.json`]);
      assert.equal(filterEntries(entries, '', ME)[0].url, undefined);
      const people = [{ path: ME, type: 'tree', sha: SHA }, { path: OTHER, type: 'tree', sha: SHA2 }];
      assert.deepEqual(filterEntries(people, 'people', ME).map((e) => e.path), [ME]);
      assert.deepEqual(filterEntries([{ path: 'papers/p1/ai.json', type: 'blob', sha: SHA2 }], `people/${OTHER}`, ME), []);
      assert.deepEqual(filterEntries([{ path: 'p1', type: 'tree', sha: SHA }], 'papers', ME).length, 1);
      assert.ok(visibleTo('people', ME) && visibleTo(`people/${ME}`, ME) && !visibleTo(`people/${OTHER}`, ME));
      assert.ok(!visibleTo(`people/${OTHER}/papers`, ME) && visibleTo('papers/p1', ME));
      return `root keeps ${root.length}/${entries.length}; people/ tree keeps only ${ME}`;
    },
  },
  {
    name: 'shared: commit message "[<name>] <first line>" (≤ 200 chars, no person ids / codes / brackets in the name)',
    fn: () => {
      assert.equal(commitMessageFor('김민지', '논문 추가: Sepsis\n\n자세한 설명'), '[김민지] 논문 추가: Sepsis');
      assert.equal(commitMessageFor('김민지', ''), '[김민지]');
      assert.equal(commitMessageFor('김민지', undefined), '[김민지]');
      assert.equal(commitMessageFor('[관리]자', 'x'), '[(관리)자] x');
      assert.equal(commitMessageFor('김민지', '[관리자] 휴지통 비우기'), '[김민지] [관리자] 휴지통 비우기');
      const leak = commitMessageFor('김민지', `논문 리더 동기화: people/${ME}/papers/p1/annotations.json, PR-ABCD-EFGH`);
      assert.ok(!leak.includes(ME) && !leak.includes('PR-ABCD-EFGH'), leak);
      assert.equal(scrubText('Proceedings PRODUCTION'), 'Proceedings PRODUCTION');
      const long = commitMessageFor('김민지', '가'.repeat(500));
      assert.equal([...long].length, 200);
      assert.ok(long.endsWith('…'));
      assert.deepEqual(parseCommitLine('[김민지] 논문 추가: Sepsis'), { who: '김민지', summary: '논문 추가: Sepsis' });
      assert.deepEqual(parseCommitLine('[(관리)자] x'), { who: '(관리)자', summary: 'x' });
      assert.deepEqual(parseCommitLine('Initial commit\n\nbody'), { who: null, summary: 'Initial commit' });
      assert.deepEqual(parseCommitLine(`[김] people/${ME}/papers/p1/ai.json`), { who: '김', summary: 'people/…/papers/p1/ai.json' });
      return `"${leak}"`;
    },
  },
  {
    name: 'shared: purge picks papers tombstoned > 30 days ago (deletedAt, else updatedAt) and all their files',
    fn: () => {
      const now = Date.parse('2026-10-19T00:00:00Z');
      const library = {
        papers: [
          { id: 'p_old', deleted: true, deletedAt: now - 31 * DAY, updatedAt: now },
          { id: 'p_old2', deleted: true, updatedAt: now - 40 * DAY },
          { id: 'p_iso', deleted: true, deletedAt: new Date(now - 45 * DAY).toISOString() },
          { id: 'p_new', deleted: true, deletedAt: now - 5 * DAY },
          { id: 'p_live', updatedAt: now - 90 * DAY },
          { id: '../evil', deleted: true, deletedAt: now - 90 * DAY },
          { id: 'p_none', deleted: true },
        ],
      };
      const ids = purgeablePaperIds(library, now, 30 * DAY);
      assert.deepEqual(ids, ['p_old', 'p_old2', 'p_iso']);
      assert.deepEqual(purgeablePaperIds(null, now, 30 * DAY), []);
      const files = paperFiles([
        'library.json', 'papers/p_old/paper.pdf', 'papers/p_old/translation.json', 'papers/p_old_x/paper.pdf',
        `people/${ME}/papers/p_old/ai.json`, `people/${OTHER}/papers/p_old/annotations.json`, 'papers/p_new/paper.pdf',
      ], ids);
      assert.deepEqual(files, ['papers/p_old/paper.pdf', 'papers/p_old/translation.json',
        `people/${ME}/papers/p_old/ai.json`, `people/${OTHER}/papers/p_old/annotations.json`]);
      return `ids ${ids.join(', ')}; ${files.length} files`;
    },
  },
  {
    name: 'shared: SHARED_LIBRARIES parsing (JSON string or array; malformed entries skipped)',
    fn: () => {
      const one = { id: 'team', name: '공용 서재', repo: 'dindoopark/paper-team-library', branch: 'main', maxBytes: 4000000000, maxFiles: 1234 };
      assert.deepEqual(parseSharedLibraries(JSON.stringify([one])), [one]);
      assert.deepEqual(parseSharedLibraries([one]), [one]);
      assert.deepEqual(parseSharedLibraries([{ id: 'lab', repo: 'a/b' }]),
        [{ id: 'lab', name: '공용 서재', repo: 'a/b', branch: 'main', maxBytes: DEFAULT_SHARED_MAX_BYTES, maxFiles: DEFAULT_SHARED_MAX_FILES }]);
      assert.deepEqual(parseSharedLibraries(''), []);
      assert.deepEqual(parseSharedLibraries(undefined), []);
      const bad = [{ id: 'Team', repo: 'a/b' }, { id: 'x', repo: 'a/b/c' }, { id: 'y', repo: '../b' },
        { id: 'z', repo: 'a/b', branch: '../main' }, { id: 'team', repo: 'a/c' }, { id: '', repo: 'a/b' }];
      const errors = console.error;
      const logged = [];
      console.error = (...args) => logged.push(args.join(' '));
      try {
        assert.deepEqual(parseSharedLibraries('not json'), []);
        assert.deepEqual(parseSharedLibraries([one, ...bad]).map((l) => l.id), ['team']);
      } finally {
        console.error = errors;
      }
      assert.equal(logged.length, 1 + bad.length);
      return 'string and array forms; 6 malformed entries skipped';
    },
  },
  {
    name: 'shared: parseLibrary reads records as clients do (object with a non-empty string id; corrupt → invalid)',
    fn: () => {
      const enc = (o) => new TextEncoder().encode(typeof o === 'string' ? o : JSON.stringify(o));
      const ok = parseLibrary(enc({
        version: 1, name: '공용', folders: [{ id: 'f1', name: 'A' }, { id: 'f1', name: 'dup' }, { name: 'no id' }, 7],
        papers: [{ id: 'p1', title: 'X' }, null, { id: '' }],
      }));
      assert.ok(ok.value, 'valid');
      assert.deepEqual([...ok.value.folders.keys()], ['f1']); // first wins, no-id / dup / non-object dropped
      assert.deepEqual([...ok.value.papers.keys()], ['p1']);
      assert.equal(ok.value.top.name, '공용');
      for (const bad of ['not json', '[]', '"x"', '123', 'null']) assert.ok(parseLibrary(enc(bad)).invalid, bad);
      assert.ok(parseLibrary(new Uint8Array([0xff, 0xfe, 0x00])).invalid, 'non-UTF-8 → invalid');
      return 'records keyed by id (first wins); arrays, scalars and non-UTF-8 are invalid';
    },
  },
  {
    name: 'shared: compareLibraries — dropped records, add/delete/restore/change counts, quiet = progress counts only',
    fn: () => {
      const lib = (folders, papers, top = {}) => parseLibrary(new TextEncoder().encode(JSON.stringify({ ...top, folders, papers }))).value;
      const base = lib([{ id: 'f1', name: 'A' }], [
        { id: 'p1', title: 'X', translatedCount: 0, sentenceCount: 10, updatedAt: 1 },
        { id: 'p2', title: 'Y', deleted: true, deletedAt: 5, updatedAt: 5 },
      ]);
      // A dropped record (p2 gone from the list) is reported — a delete must stay as a tombstone.
      const dropped = compareLibraries(base, lib([{ id: 'f1', name: 'A' }], [{ id: 'p1', title: 'X', translatedCount: 0, sentenceCount: 10, updatedAt: 1 }]));
      assert.equal(dropped.dropped.length, 1);
      assert.equal(dropped.quiet, false);
      // Only progress counts move → quiet (what '논문 정보 갱신' is allowed to hide).
      const quiet = compareLibraries(base, lib([{ id: 'f1', name: 'A' }], [
        { id: 'p1', title: 'X', translatedCount: 7, sentenceCount: 10, updatedAt: 9 },
        { id: 'p2', title: 'Y', deleted: true, deletedAt: 5, updatedAt: 5 },
      ], { updatedAt: 9 }));
      assert.deepEqual([quiet.dropped.length, quiet.quiet, quiet.added, quiet.deleted, quiet.restored, quiet.changed], [0, true, 0, 0, 0, 0]);
      // A title change is loud; a new paper is an add; a tombstone is a delete; untombstoning is a restore.
      const loud = compareLibraries(base, lib([{ id: 'f1', name: 'A' }], [
        { id: 'p1', title: 'X2', translatedCount: 0, sentenceCount: 10, updatedAt: 20 },
        { id: 'p2', title: 'Y', updatedAt: 21 },
        { id: 'p3', title: 'Z', updatedAt: 22 },
      ]));
      assert.deepEqual([loud.quiet, loud.added, loud.restored, loud.changed], [false, 1, 1, 1]);
      const newDelete = compareLibraries(base, lib([{ id: 'f1', name: 'A' }], [
        { id: 'p1', title: 'X', deleted: true, deletedAt: 30, updatedAt: 30 },
        { id: 'p2', title: 'Y', deleted: true, deletedAt: 5, updatedAt: 5 },
      ]));
      assert.deepEqual([newDelete.deleted, newDelete.quiet], [1, false]);
      // No base (first library.json): records are adds, nothing dropped.
      const first = compareLibraries(null, lib([], [{ id: 'p1', title: 'X' }]));
      assert.deepEqual([first.dropped.length, first.added], [0, 1]);
      return `drop → ${dropped.dropped[0]}; progress-only quiet; title/add/restore loud; new delete counted`;
    },
  },
  {
    name: 'shared: describeSharedChange gives a visible Korean summary (used when a client mislabels a loud change)',
    fn: () => {
      assert.match(describeSharedChange({ library: { added: 2, deleted: 1, restored: 0, changed: 0, quiet: false } }), /공용 서재 변경.*추가 2.*삭제 1/);
      assert.match(describeSharedChange({ translations: 3 }), /번역 3편/);
      assert.match(describeSharedChange({ pdfs: 1 }), /PDF 1개/);
      assert.equal(describeSharedChange({}), '공용 서재 변경');
      return 'counts and translations/PDFs named in Korean';
    },
  },
  {
    name: 'shared: confirmedPurgeIds purges only tombstones already that old in the before-snapshot (back-dated deletedAt not trusted)',
    fn: () => {
      const now = Date.parse('2026-10-19T00:00:00Z');
      const DAY = 24 * 60 * 60 * 1000;
      const current = { papers: [
        { id: 'p_real', deleted: true, deletedAt: now - 40 * DAY }, // genuinely old, in the old snapshot
        { id: 'p_backdated', deleted: true, deletedAt: now - 40 * DAY }, // tombstoned just now, deletedAt faked old
        { id: 'p_moved', deleted: true, deletedAt: now - 40 * DAY }, // old snapshot had a different deletedAt
      ] };
      const before = { papers: [
        { id: 'p_real', deleted: true, deletedAt: now - 40 * DAY },
        { id: 'p_moved', deleted: true, deletedAt: now - 2 * DAY },
      ] };
      assert.deepEqual(confirmedPurgeIds(current, before, now, 30 * DAY), ['p_real']);
      // With no before-snapshot (no commit is 30 days old yet) nothing is purged.
      assert.deepEqual(confirmedPurgeIds(current, null, now, 30 * DAY), []);
      // The age filter still applies: a tombstone younger than 30 days is never purged even if in the old snapshot.
      const young = { papers: [{ id: 'p_young', deleted: true, deletedAt: now - 5 * DAY }] };
      assert.deepEqual(confirmedPurgeIds(young, young, now, 30 * DAY), []);
      return 'only p_real (old in both snapshots with the same deletion time); back-dated and no-snapshot → none';
    },
  },
  {
    name: 'shared: POST git/blobs bodies are recognised as PDFs (base64 or utf-8 content, either key order)',
    fn: () => {
      const enc = (s) => new TextEncoder().encode(s);
      const b64 = Buffer.from('%PDF-1.7\n%âãÏÓ').toString('base64');
      assert.ok(looksLikePdf(enc(`{"encoding":"base64","content":"${b64}`)));
      assert.ok(looksLikePdf(enc(`{ "content" : "${b64}", "encoding": "base64" }`)));
      assert.ok(looksLikePdf(enc('{"content":"%PDF-1.4 text","encoding":"utf-8"}')));
      assert.ok(!looksLikePdf(enc(`{"encoding":"base64","content":"${Buffer.from('{"version":1}').toString('base64')}"}`)));
      assert.ok(!looksLikePdf(enc('{"content":"","encoding":"utf-8"}')));
      assert.ok(!looksLikePdf(enc('{"encoding":"base64"')));
      return 'PDF prefixes found; JSON and empty blobs are not PDFs';
    },
  },
];
