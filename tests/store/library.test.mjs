// Store module — Library with several instances (docs/SHARED.md §3.1), in Node: in-memory databases
// (tests/store/memory-db.mjs), and for the network scenarios the fake GitHub behind the fake relay
// (tests/store/fake-relay.mjs, which enforces the relay's path/people/base rules).
//   node tests/store/library.test.mjs
// Results: C:/Users/dindoo/Projects/pr-tools/out/store/library.results.json
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { memoryDb } from './memory-db.mjs';
import { startFakeGitHub } from './fake-github.mjs';
import { personIdOf, startFakeRelay } from './fake-relay.mjs';
import { Library, TRASH_RETENTION_DAYS, dataPath, openSharedLibrary, personIdFor, sharedDbName } from '../../js/store/library.js';
import { gitBlobSha } from '../../js/store/github.js';

const OUT = 'C:/Users/dindoo/Projects/pr-tools/out/store';
mkdirSync(OUT, { recursive: true });
const results = [];
const opened = [];
const DAY = 24 * 60 * 60 * 1000;
// Nothing may leave the machine: any non-loopback request fails here (and is recorded) before it is sent.
const external = [];
const loopbackFetch = globalThis.fetch;
globalThis.fetch = (url, init) => {
  const href = String(url?.url ?? url);
  if (!/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])[:/]/.test(href)) {
    external.push(href);
    return Promise.reject(new TypeError(`blocked non-loopback request in tests: ${href}`));
  }
  return loopbackFetch(url, init);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
function assert(cond, msg) { if (!cond) throw new Error(msg); }
async function rejects(fn, re, what) {
  try { await fn(); } catch (err) {
    assert(re instanceof RegExp ? re.test(err.message) : err instanceof re, `${what}: unexpected error ${err?.name}: ${err?.message}`);
    return err.message;
  }
  throw new Error(`${what}: expected a rejection`);
}
async function waitFor(fn, timeout = 8000, what = 'condition') {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error(`timeout waiting for ${what}`);
    await sleep(20);
  }
}
const filter = process.argv[2] || '';
async function test(name, fn) {
  if (filter && !name.includes(filter)) return;
  const t0 = Date.now();
  try {
    const evidence = await fn();
    results.push({ name, result: 'pass', evidence: String(evidence ?? 'ok'), ms: Date.now() - t0 });
    console.log(`PASS  ${name}  (${Date.now() - t0} ms)\n      ${evidence ?? ''}`);
  } catch (err) {
    results.push({ name, result: 'fail', evidence: err?.stack || String(err), ms: Date.now() - t0 });
    console.log(`FAIL  ${name}\n      ${err?.stack || err}`);
  }
}

/** Synthetic PDF bytes: %PDF header + deterministic pseudo-random body (as tests/store/harness.js). */
function makePdf(seed, size = 6000) {
  const out = new Uint8Array(size);
  out.set(new TextEncoder().encode('%PDF-1.7\n%synthetic test file\n'));
  let x = seed >>> 0 || 1;
  for (let i = 32; i < size; i++) {
    x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0;
    out[i] = x & 0xff;
  }
  return out;
}

let dbSeq = 0;
const freshDb = (tag) => memoryDb(`t-${tag}-${++dbSeq}`);
async function track(promise) { const lib = await promise; opened.push(lib); return lib; }
const openMine = (db = freshDb('mine'), extra = {}) => track(Library.open({ db, ...extra }));
const openShared = (db = freshDb('shared'), extra = {}) => track(Library.open({
  db, id: 'shared:team', personalPrefix: 'people/abcd/', retainPdfOnDelete: true, shared: true, personName: '김동료', ...extra,
}));
const fileKeys = (db) => [...db.stores.files.keys()].sort();
const storedLibrary = (db) => JSON.parse(db.stores.files.get('library.json').data);
const bytesEqual = (a, b) => a.byteLength === b.byteLength && a.every((v, i) => v === b[i]);

async function waitSync(lib, { state = 'idle', pending = 0, timeout = 15000 } = {}) {
  await lib.whenSaved();
  const t0 = Date.now();
  for (;;) {
    const st = lib.sync.status;
    if (st.state === state && (pending == null || st.pending === pending)) return st;
    if (Date.now() - t0 > timeout) throw new Error(`timeout waiting for ${state}/${pending}: ${JSON.stringify(st)}`);
    await sleep(20);
  }
}

try {
  // ------------------------------------------------------------- local only
  await test('내 서재 (defaults): same repo paths as before; delete removes the files; tombstone gets deletedAt + deletedBy 나; 휴지통 lists folders only', async () => {
    const db = freshDb('mine-defaults');
    const lib = await openMine(db);
    assert(lib.id === 'mine' && lib.label === '내 서재' && !lib.shared && lib.personalPrefix === '' && !lib.retainPdfOnDelete && lib.personName === '나', 'defaults');
    const f = lib.createFolder('섬망 연구');
    const g = lib.createFolder('예방', f.id);
    const p = await lib.addPaper(makePdf(1), { fileName: 'a.pdf', folderId: g.id, meta: { title: 'A paper' } });
    for (const kind of ['translation', 'annotations', 'ai']) await lib.savePaperData(p.id, kind, { version: 1, items: kind === 'annotations' ? [] : {} });
    await lib.whenSaved();
    const paths = fileKeys(db);
    const expected = ['library.json', ...['ai.json', 'annotations.json', 'paper.pdf', 'translation.json'].map((x) => `papers/${p.id}/${x}`)];
    assert(paths.join() === expected.join(), `paths: ${paths}`);
    assert(lib.dataPath(p.id, 'annotations') === `papers/${p.id}/annotations.json` && dataPath(p.id, 'ai') === `papers/${p.id}/ai.json`, 'dataPath');
    assert(/^[0-9a-f]{64}$/.test(lib.getPaper(p.id).sha256), 'sha256 recorded on add');

    lib.deleteFolder(g.id); // as before: its contents move to the parent (rewritten in library.json)
    await lib.whenSaved();
    assert(storedLibrary(db).papers[0].folderId === f.id, 'deleteFolder in 내 서재 rewrites children');
    lib.deletePaper(p.id);
    await waitFor(() => fileKeys(db).join() === 'library.json', 3000, 'paper files deleted');
    const tomb = storedLibrary(db).papers[0];
    assert(tomb.deleted === true && tomb.deletedBy === '나' && Math.abs(tomb.deletedAt - Date.now()) < 5000, JSON.stringify(tomb));
    const trash = lib.trash();
    assert(trash.length === 1 && trash[0].kind === 'folder' && trash[0].id === g.id && trash[0].deletedBy === '나', JSON.stringify(trash));
    const refused = await rejects(() => lib.restore(p.id), /복구할 수 없습니다/, 'restore of a 내 서재 paper');
    const back = await lib.restore(g.id);
    assert(back.id === g.id && back.parentId === f.id && lib.trash().length === 0, `restored folder ${JSON.stringify(back)}`);
    return `paths [${paths.map((x) => x.replace(p.id, '<id>')).join(', ')}]; tombstone {deleted, deletedAt, deletedBy:'나'}; 휴지통 = [folder 예방]; paper restore: “${refused}”; folder restored under 섬망 연구`;
  });

  await test('공용 서재 instance: annotations/ai under people/<id>/, PDF + translation shared; delete only tombstones; 휴지통 shows who; restore brings everything back', async () => {
    const db = freshDb('shared-paths');
    const lib = await openShared(db);
    assert(lib.id === 'shared:team' && lib.label === '공용 서재' && lib.shared && lib.retainPdfOnDelete && lib.personName === '김동료', 'options');
    const p = await lib.addPaper(makePdf(2), { fileName: 'b.pdf', meta: { title: 'B paper' } });
    await lib.savePaperData(p.id, 'translation', { version: 1, targetLang: 'ko', segVersion: 1, items: { 'p1-0': { h: 'h', t: '번역' } } });
    await lib.savePaperData(p.id, 'annotations', { version: 1, items: [{ id: 'a1', anchor: { start: 0, end: 3 }, quote: 'q', color: 'yellow', note: '내 메모', createdAt: 1, updatedAt: 1 }] });
    await lib.savePaperData(p.id, 'ai', { version: 1, summary: { markdown: '요약', createdAt: 1 } });
    await lib.whenSaved();
    const expected = ['library.json', `papers/${p.id}/paper.pdf`, `papers/${p.id}/translation.json`, `people/abcd/papers/${p.id}/ai.json`, `people/abcd/papers/${p.id}/annotations.json`];
    assert(fileKeys(db).join() === expected.join(), `paths: ${fileKeys(db)}`);
    assert(lib.dataPath(p.id, 'ai') === `people/abcd/papers/${p.id}/ai.json` && lib.dataPath(p.id, 'translation') === `papers/${p.id}/translation.json`, 'dataPath');
    assert(lib.getPaper(p.id).addedBy === '김동료', 'addedBy');
    let protectedField = lib.updatePaper(p.id, { addedBy: '누군가', deletedBy: 'x', sha256: 'y' });
    assert(protectedField.addedBy === '김동료' && !protectedField.deletedBy && protectedField.sha256 !== 'y', 'protected fields');

    lib.deletePaper(p.id);
    await lib.whenSaved();
    await sleep(50);
    assert(fileKeys(db).join() === expected.join(), `files must stay: ${fileKeys(db)}`);
    const [item] = lib.trash();
    assert(item?.kind === 'paper' && item.id === p.id && item.name === 'B paper' && item.deletedBy === '김동료' && !item.expired
      && item.expiresAt === item.deletedAt + TRASH_RETENTION_DAYS * DAY && Object.isFrozen(item), JSON.stringify(item));
    const save = await rejects(() => lib.savePaperData(p.id, 'annotations', { version: 1, items: [] }), /삭제되었습니다/, 'save on a deleted paper');
    const back = await lib.restore(p.id);
    const ann = await lib.getPaperData(p.id, 'annotations');
    const raw = storedLibrary(db).papers[0];
    await lib.whenSaved();
    const stored = storedLibrary(db).papers[0];
    assert(back.id === p.id && lib.papers.length === 1 && lib.trash().length === 0 && ann.items[0].note === '내 메모', 'restored');
    assert(!('deleted' in stored) && !('deletedAt' in stored) && !('deletedBy' in stored) && stored.updatedAt > raw.updatedAt - 1, JSON.stringify(stored));
    return `paths [${expected.map((x) => x.replace(p.id, '<id>')).join(', ')}]; after delete all 5 files kept, 휴지통 item by ${item.deletedBy}, expires +${TRASH_RETENTION_DAYS}d; save refused: “${save}”; restored with its notes`;
  });

  await test('공용 서재 folders: deleting keeps contents pointing at the folder (shown in the parent); restore brings it back with them; restoring a paper revives deleted folders above it', async () => {
    const db = freshDb('shared-folders');
    const lib = await openShared(db);
    const F = lib.createFolder('F');
    const G = lib.createFolder('G', F.id);
    const P = await lib.addPaper(makePdf(3), { fileName: 'p.pdf', folderId: G.id, meta: { title: 'P' } });
    const Q = await lib.addPaper(makePdf(4), { fileName: 'q.pdf', folderId: F.id, meta: { title: 'Q' } });
    const R = await lib.addPaper(makePdf(5), { fileName: 'r.pdf', folderId: G.id, meta: { title: 'R' } });
    lib.deleteFolder(G.id);
    await lib.whenSaved();
    const raw = Object.fromEntries(storedLibrary(db).papers.map((p) => [p.id, p.folderId]));
    assert(lib.getPaper(P.id).folderId === F.id && lib.getPaper(R.id).folderId === F.id && raw[P.id] === G.id, `shown in parent, raw kept: ${JSON.stringify(raw)}`);
    await lib.restore(G.id);
    assert(lib.getPaper(P.id).folderId === G.id && lib.getPaper(R.id).folderId === G.id && lib.getFolder(G.id).parentId === F.id, 'folder came back with contents');

    // P deleted while in G; then G and F deleted: restoring P revives F and G.
    lib.deletePaper(P.id);
    lib.deleteFolder(G.id);
    lib.deleteFolder(F.id);
    assert(lib.folders.length === 0 && lib.getPaper(Q.id).folderId === null, 'all folders gone');
    const restoredP = await lib.restore(P.id);
    assert(restoredP.folderId === G.id && lib.getFolder(G.id)?.parentId === F.id && lib.getFolder(F.id), `chain revived: ${JSON.stringify(lib.folders)}`);
    assert(lib.getPaper(Q.id).folderId === F.id && lib.getPaper(R.id).folderId === G.id, 'the revived folders show their contents again');

    // R deleted while shown in F (its folder G already deleted): restore puts it back in F, G stays deleted.
    lib.deleteFolder(G.id);
    lib.deletePaper(R.id);
    const restoredR = await lib.restore(R.id);
    assert(restoredR.folderId === F.id && !lib.getFolder(G.id), `R back where it was shown: ${JSON.stringify(restoredR)}`);
    const trash = lib.trash().map((t) => `${t.kind}:${t.name}`);
    assert(trash.join() === 'folder:G', `trash ${trash}`);
    return `delete G → P,R shown in F (raw folderId still G) → restore G → back in G; P restored after G and F were deleted → F, G revived; R deleted after G → restored into F; 휴지통 now [${trash}]`;
  });

  await test('휴지통 window: folders for 30 days, old tombstones without deletedAt use updatedAt, expired papers listed until their files are purged, a purged paper cannot be restored', async () => {
    const db = freshDb('trash-window');
    const now = Date.now();
    const lib0 = {
      version: 1,
      updatedAt: now,
      folders: [
        { id: 'f_old', name: '오래된 폴더', parentId: null, createdAt: 1, updatedAt: now - 40 * DAY, deleted: true, deletedAt: now - 40 * DAY, deletedBy: '박동료' },
        { id: 'f_legacy', name: '예전 삭제', parentId: null, createdAt: 1, updatedAt: now - DAY, deleted: true },
      ],
      papers: [
        { id: 'p_expired', title: '만료', fileName: 'e.pdf', folderId: null, addedAt: 1, updatedAt: now - 35 * DAY, deleted: true, deletedAt: now - 35 * DAY, deletedBy: '김동료' },
        { id: 'p_purged', title: '비워짐', fileName: 'x.pdf', folderId: null, addedAt: 1, updatedAt: now - 50 * DAY, deleted: true, deletedAt: now - 50 * DAY },
      ],
    };
    await db.put('files', 'library.json', { path: 'library.json', data: JSON.stringify(lib0), baseSha: null, mtime: now });
    await db.put('files', 'papers/p_expired/paper.pdf', { path: 'papers/p_expired/paper.pdf', data: makePdf(9), baseSha: null, mtime: now });
    const lib = await openShared(db);
    const trash = lib.trash();
    const ids = trash.map((t) => t.id);
    assert(ids.join() === 'f_legacy,p_expired', `trash: ${ids}`);
    const legacy = trash.find((t) => t.id === 'f_legacy');
    const expired = trash.find((t) => t.id === 'p_expired');
    assert(legacy.deletedAt === now - DAY && legacy.deletedBy === null && expired.expired === true && expired.deletedBy === '김동료', JSON.stringify(trash));
    await db.del('files', 'papers/p_expired/paper.pdf'); // the admin purge removed the files
    const msg = await rejects(() => lib.restore('p_expired'), /보관 기간/, 'restore of a purged paper');
    assert(lib.trash().map((t) => t.id).join() === 'f_legacy', 'purged paper leaves the 휴지통');
    const missing = await rejects(() => lib.restore('nope'), /휴지통에서 찾을 수 없습니다/, 'unknown id');
    return `listed [${ids}] (40-day-old folder hidden, file-less paper hidden, 35-day-old paper expired=true); after purge: “${msg}”; unknown: “${missing}”`;
  });

  // ------------------------------------------------------------------- copy
  await test('copyPaperTo: PDF, translation and bibliographic fields — never notes, AI data or the star; same PDF again → existing paper moved, missing sentences added; tombstoned duplicate restored', async () => {
    const mineDb = freshDb('copy-mine');
    const sharedDb = freshDb('copy-shared');
    const mine = await openMine(mineDb);
    const shared = await openShared(sharedDb);
    const bytes = makePdf(21, 9000);
    const p = await mine.addPaper(bytes, { fileName: 'lu2025.pdf', meta: { title: 'Lu 2025', authors: 'Lu, X.', year: 2025, pages: 12 } });
    mine.updatePaper(p.id, { starred: true, translatedCount: 2, sentenceCount: 40, s2PaperId: 's2-123', lastOpenedAt: Date.now() });
    await mine.savePaperData(p.id, 'translation', { version: 1, targetLang: 'ko', segVersion: 1, items: { 'p1-0': { h: 'h0', t: '번역 0' }, 'p1-1': { h: 'h1', t: '번역 1' } } });
    await mine.savePaperData(p.id, 'annotations', { version: 1, items: [{ id: 'm1', anchor: { start: 0, end: 2 }, quote: 'x', color: 'blue', note: '비밀 메모', createdAt: 1, updatedAt: 1 }] });
    await mine.savePaperData(p.id, 'ai', { version: 1, summary: { markdown: '내 요약', createdAt: 1 } });
    const target = shared.createFolder('섬망');

    const r = await mine.copyPaperTo(shared, p.id, { folderId: target.id });
    const c = r.paper;
    assert(r.copied && !r.existing && c.id !== p.id, JSON.stringify(r));
    assert(c.title === 'Lu 2025' && c.authors === 'Lu, X.' && c.year === 2025 && c.pages === 12 && c.fileName === 'lu2025.pdf'
      && c.folderId === target.id && c.starred === false && c.lastOpenedAt === null && c.translatedCount === 2 && c.sentenceCount === 40
      && c.s2PaperId === 's2-123' && c.sha256 === sha256(bytes) && c.size === bytes.byteLength, JSON.stringify(c));
    assert(bytesEqual(await shared.getPdf(c.id), bytes), 'PDF bytes');
    const tr = await shared.getPaperData(c.id, 'translation');
    assert(Object.keys(tr.items).join() === 'p1-0,p1-1', JSON.stringify(tr));
    assert((await shared.getPaperData(c.id, 'annotations')) === null && (await shared.getPaperData(c.id, 'ai')) === null, 'notes/AI must not be copied');
    await shared.whenSaved();
    const sharedFiles = fileKeys(sharedDb).filter((k) => k.includes(c.id));
    assert(sharedFiles.join() === `papers/${c.id}/paper.pdf,papers/${c.id}/translation.json`, `target files: ${sharedFiles}`);
    assert(mine.papers.length === 1 && (await mine.getPaperData(p.id, 'annotations')).items[0].note === '비밀 메모', 'source untouched');

    // Same PDF again into another folder: no duplicate; the existing paper moves; a sentence translated since is added.
    await mine.savePaperData(p.id, 'translation', { ...(await mine.getPaperData(p.id, 'translation')), items: { ...tr.items, 'p2-0': { h: 'h2', t: '번역 2' } } });
    const other = shared.createFolder('다른 폴더');
    const r2 = await mine.copyPaperTo(shared, p.id, { folderId: other.id });
    assert(r2.existing && r2.moved && !r2.copied && r2.paper.id === c.id && r2.paper.folderId === other.id && r2.translationAdded === 1 && shared.papers.length === 1, JSON.stringify(r2));
    assert(Object.keys((await shared.getPaperData(c.id, 'translation')).items).sort().join() === 'p1-0,p1-1,p2-0', 'translation union');
    const r3 = await mine.copyPaperTo(shared, p.id);
    assert(r3.existing && !r3.moved && r3.translationAdded === 0 && r3.paper.folderId === other.id, `top-level copy of an existing paper leaves it: ${JSON.stringify(r3)}`);
    // Another source record with the same bytes maps to the same paper.
    const p2 = await mine.addPaper(bytes.slice(), { fileName: 'again.pdf', meta: { title: '다시 올린 Lu' } });
    const r4 = await mine.copyPaperTo(shared, p2.id, { folderId: other.id });
    assert(r4.existing && r4.paper.id === c.id && shared.papers.length === 1, JSON.stringify(r4));
    // In the target's 휴지통: restored (files were kept) into the requested folder, not copied again.
    shared.deletePaper(c.id);
    const r5 = await mine.copyPaperTo(shared, p.id, { folderId: target.id });
    assert(r5.restored && r5.existing && r5.paper.id === c.id && r5.paper.folderId === target.id && shared.trash().length === 0, JSON.stringify(r5));
    return `copied: title/authors/year/pages/fileName/s2PaperId/translatedCount kept, starred=false, files [paper.pdf, translation.json] only; again → moved=${r2.moved}, +${r2.translationAdded} sentence; top level → left in place; re-uploaded bytes → same paper; from 휴지통 → restored=${r5.restored}`;
  });

  await test('copy dedupe also finds a target paper stored before sha256 existed (same size + git blob sha)', async () => {
    const sharedDb = freshDb('legacy-shared');
    const bytes = makePdf(31, 7000);
    const now = Date.now();
    const legacy = { id: 'p_legacy', title: '예전 논문', fileName: 'old.pdf', size: bytes.byteLength, folderId: null, starred: false, addedAt: 1, updatedAt: 1 };
    await sharedDb.put('files', 'library.json', { path: 'library.json', data: JSON.stringify({ version: 1, updatedAt: 1, folders: [], papers: [legacy] }), baseSha: null, mtime: now });
    // a pushed copy: clean, its sync base is the git blob sha
    await sharedDb.put('files', 'papers/p_legacy/paper.pdf', { path: 'papers/p_legacy/paper.pdf', data: bytes, baseSha: await gitBlobSha(bytes), mtime: now });
    const shared = await openShared(sharedDb);
    const mine = await openMine();
    const p = await mine.addPaper(bytes, { fileName: 'same.pdf' });
    const r = await mine.copyPaperTo(shared, p.id);
    assert(r.existing && r.paper.id === 'p_legacy' && shared.papers.length === 1, JSON.stringify(r));
    // a local-only (dirty) legacy copy is hashed instead
    await sharedDb.put('files', 'papers/p_legacy/paper.pdf', { path: 'papers/p_legacy/paper.pdf', data: bytes, dirty: 1, baseSha: null, wid: 'w1', mtime: now });
    const r2 = await mine.copyPaperTo(shared, p.id);
    assert(r2.existing && r2.paper.id === 'p_legacy', JSON.stringify(r2));
    return 'clean legacy copy matched by its baseSha, dirty one by hashing its bytes; no duplicate added';
  });

  await test('copyFolderTo: the whole subtree, papers deduplicated (also within the run), copying again reuses folders; progress; a failing paper is reported and the rest continue; abort', async () => {
    const mineDb = freshDb('tree-mine');
    const mine = await openMine(mineDb);
    const shared = await openShared();
    const F = mine.createFolder('ICU');
    const G = mine.createFolder('CAUTI', F.id);
    const H = mine.createFolder('2024', G.id);
    mine.createFolder('다른 곳'); // outside the subtree
    const A = await mine.addPaper(makePdf(41), { fileName: 'a.pdf', folderId: F.id, meta: { title: 'A' } });
    const B = await mine.addPaper(makePdf(42), { fileName: 'b.pdf', folderId: G.id, meta: { title: 'B' } });
    const C = await mine.addPaper(makePdf(43), { fileName: 'c.pdf', folderId: H.id, meta: { title: 'C' } });
    const D = await mine.addPaper(makePdf(41), { fileName: 'a-copy.pdf', folderId: G.id, meta: { title: 'A again' } }); // same bytes as A
    await mine.addPaper(makePdf(44), { fileName: 'e.pdf', meta: { title: 'E (top level)' } });
    await mine.savePaperData(B.id, 'translation', { version: 1, targetLang: 'ko', segVersion: 1, items: { 'p1-0': { h: 'h', t: 'B 번역' } } });
    await mine.savePaperData(B.id, 'annotations', { version: 1, items: [{ id: 'n', anchor: { start: 0, end: 1 }, quote: 'q', color: 'pink', note: '내 것', createdAt: 1, updatedAt: 1 }] });
    // A colleague already uploaded C's PDF into another shared folder.
    const X = shared.createFolder('동료 폴더');
    const x = await shared.addPaper(makePdf(43), { fileName: 'colleague.pdf', folderId: X.id, meta: { title: 'C (동료)' } });

    const progress = [];
    const res = await mine.copyFolderTo(shared, F.id, { onProgress: (e) => progress.push(`${e.done}/${e.total}`) });
    const icu = res.folder;
    const cauti = shared.folders.find((f) => f.parentId === icu.id);
    const y2024 = shared.folders.find((f) => f.parentId === cauti?.id);
    assert(icu.name === 'ICU' && icu.parentId === null && cauti?.name === 'CAUTI' && y2024?.name === '2024', JSON.stringify(shared.folders));
    assert(!shared.folders.some((f) => f.name === '다른 곳') && !shared.papers.some((p) => p.title.startsWith('E')), 'nothing outside the subtree');
    assert(res.folders.created === 3 && res.folders.reused === 0, JSON.stringify(res.folders));
    assert(res.papers.total === 4 && res.papers.copied === 2 && res.papers.existing === 2 && res.papers.moved === 1 && res.papers.failed.length === 0, JSON.stringify(res.papers));
    const byTitle = Object.fromEntries(shared.papers.map((p) => [p.title, p]));
    assert(byTitle.A.folderId === icu.id && byTitle.B.folderId === cauti.id && shared.getPaper(x.id).folderId === y2024.id && !byTitle['A again'], `placement: ${JSON.stringify(shared.papers.map((p) => [p.title, p.folderId]))}`);
    assert((await shared.getPaperData(byTitle.B.id, 'translation')).items['p1-0'].t === 'B 번역' && (await shared.getPaperData(byTitle.B.id, 'annotations')) === null, 'translation yes, notes no');
    assert(progress.join() === '0/4,1/4,2/4,3/4,4/4', progress.join());

    const again = await mine.copyFolderTo(shared, F.id);
    assert(again.folders.created === 0 && again.folders.reused === 3 && again.papers.copied === 0 && again.papers.existing === 4 && again.papers.moved === 0 && shared.papers.length === 3, JSON.stringify(again));

    mineDb.stores.files.delete(`papers/${C.id}/paper.pdf`); // C's PDF is unreadable on this device now
    const intoX = await mine.copyFolderTo(shared, G.id, { parentId: X.id });
    assert(intoX.papers.failed.length === 1 && intoX.papers.failed[0].id === C.id && /PDF/.test(intoX.papers.failed[0].message) && intoX.papers.total === 3, JSON.stringify(intoX.papers));
    assert(intoX.folder.parentId === X.id && intoX.folders.created === 2, JSON.stringify(intoX));
    const ac = new AbortController();
    ac.abort();
    await rejects(() => mine.copyFolderTo(shared, F.id, { signal: ac.signal }), /abort/i, 'aborted copy');
    await rejects(() => mine.copyFolderTo(mine, F.id), /같은 서재/, 'copy into itself');
    return `created ICU/CAUTI/2024; papers copied=2 existing=2 (A again → A, C → colleague's paper moved into 2024) moved=1; progress ${progress.join(' ')}; second run: reused 3 folders, 0 copied; failure reported: “${intoX.papers.failed[0].message.slice(0, 50)}…”`;
  });

  // ------------------------------------------------------------- isolation
  await test('two Library instances in one process are isolated (own database, lock, channel, journal); a second engine on the same database does hear its writes', async () => {
    const dbMine = freshDb('iso-mine');
    const dbShared = freshDb('iso-shared');
    const mine = await openMine(dbMine);
    const shared = await openShared(dbShared);
    const heard = { mine: [], shared: [] };
    mine.sync.addEventListener('remotechange', (e) => heard.mine.push(e.detail));
    shared.sync.addEventListener('remotechange', (e) => heard.shared.push(e.detail));
    mine.createFolder('내 폴더');
    shared.createFolder('공용 폴더');
    await mine.addPaper(makePdf(51), { fileName: 'm.pdf' });
    await Promise.all([mine.whenSaved(), shared.whenSaved()]);
    await sleep(150);
    assert(mine.folders.map((f) => f.name).join() === '내 폴더' && shared.folders.map((f) => f.name).join() === '공용 폴더', 'folders');
    assert(shared.papers.length === 0 && !fileKeys(dbShared).some((k) => k.startsWith('papers/')), 'shared has no paper');
    assert(heard.mine.length === 0 && heard.shared.length === 0, `cross-library notifications: ${JSON.stringify(heard)}`);
    // Sanity: the channel works — a second Library on the SAME database hears the first one's writes.
    const mine2 = await openMine(dbMine);
    const heard2 = [];
    mine2.sync.addEventListener('remotechange', (e) => heard2.push(e.detail));
    mine.createFolder('두 번째');
    await mine.whenSaved();
    await waitFor(() => mine2.folders.some((f) => f.name === '두 번째'), 3000, 'the same-database instance to update');
    assert(heard2.some((d) => d.origin === 'tab') && heard.shared.length === 0, JSON.stringify(heard2));
    return `내 서재 [내 폴더 + 1 paper] / 공용 서재 [공용 폴더]; 0 cross notifications; same-database instance got ${heard2.filter((d) => d.origin === 'tab').length} tab notification(s)`;
  });

  await test('Library.open({ shared: true }) never falls back to the personal settings.github, and its client is always in proxy mode (a bad address → config error, no request at all)', async () => {
    const seen = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (url, init) => { seen.push(String(url)); return realFetch(url, init); };
    try {
      const settings = { get: () => ({ github: { owner: 'me', repo: 'paper-library', branch: 'main', token: 'ghp_personal', apiBase: 'http://127.0.0.1:9/' } }) };
      const noCfg = await track(Library.open({ db: freshDb('harden-1'), settings, id: 'shared:team', shared: true, retainPdfOnDelete: true, personalPrefix: 'people/abcd/' }));
      noCfg.createFolder('x');
      await noCfg.whenSaved();
      await noCfg.sync.syncNow();
      assert(noCfg.sync.status.state === 'disabled' && seen.length === 0, `shared without getConfig: ${JSON.stringify(noCfg.sync.status)}, requests ${seen}`);
      const bad = await track(Library.open({
        db: freshDb('harden-2'), id: 'shared:team', shared: true, retainPdfOnDelete: true, personalPrefix: 'people/abcd/',
        getConfig: () => ({ owner: 'team', repo: 'library', branch: 'main', token: 'PR-AAAA-BBBB', apiBase: 'ftp://relay.example/shared/team/gh' }),
      }));
      await bad.sync.syncNow();
      const st = bad.sync.status;
      assert(st.state === 'error' && /서버 주소가 올바르지 않습니다/.test(st.message) && seen.length === 0, `${JSON.stringify(st)}; requests ${seen}`);
      return `no getConfig → sync disabled (settings.github ignored); invalid proxy address → “${st.message}”; requests made: ${seen.length}`;
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  await test('validation: library id and personal prefix; openSharedLibrary refuses a bad relay address or code before any request; personId matches the relay\'s rule', async () => {
    await rejects(() => Library.open({ db: freshDb('v'), id: 'theirs' }), TypeError, 'bad id');
    await rejects(() => Library.open({ db: freshDb('v'), id: 'shared:team', personalPrefix: '../x/' }), TypeError, 'bad prefix');
    const bad = [];
    for (const relayUrl of ['http://relay.example.com', 'javascript:alert(1)', 'https://user:pw@relay.example', '', 'https://relay.example/?x=1']) {
      bad.push(await rejects(() => openSharedLibrary({ relayUrl, code: 'PR-AAAA-BBBB', db: freshDb('v') }), /서버 주소가 올바르지 않습니다/, `relayUrl ${relayUrl}`));
    }
    const noCode = await rejects(() => openSharedLibrary({ relayUrl: 'https://relay.example', code: '  ', db: freshDb('v') }), /초대 코드가 없습니다/, 'empty code');
    const badCode = await rejects(() => openSharedLibrary({ relayUrl: 'https://relay.example', code: 'hello', db: freshDb('v') }), /형식이 올바르지 않습니다/, 'malformed code');
    const pid = await personIdFor('pr abcd efgh');
    assert(pid === (await personIdFor('PR-ABCD-EFGH')) && pid === personIdOf('PR-ABCD-EFGH') && /^[0-9a-f]{16}$/.test(pid), pid);
    let relayCheck = 'relay/src/codes.js not importable (relay builder working) — compared with the fake relay only';
    try {
      const { normalizeCode } = await import('../../relay/src/codes.js');
      assert(normalizeCode('pr-oili-1234') === 'PR-0111-1234' && (await personIdFor('pr-oili-1234')) === personIdOf(normalizeCode('pr-oili-1234')), 'relay normalisation differs');
      relayCheck = 'same normalisation as relay/src/codes.js (pr-oili-1234 → PR-0111-1234)';
    } catch (err) {
      if (/normalisation differs/.test(err.message)) throw err;
    }
    assert(sharedDbName('team', pid) === `paper-reader-shared-team-${pid}`, 'db name');
    return `bad relay URLs refused (${bad.length}): “${bad[0]}”; “${noCode}”; “${badCode}”; personId ${pid}; ${relayCheck}`;
  });

  // ------------------------------------------------------- through the relay
  const gh = await startFakeGitHub({ port: 0 });
  const TEAM_TOKEN = 'ghp_team_secret_token';
  gh.addToken(TEAM_TOKEN, { write: true });
  gh.createRepo('dindoopark', 'paper-team-library', { private: true }); // empty: the first push bootstraps it
  gh.addToken('ghp_owner_token', { write: true });
  gh.createRepo('me', 'paper-library', { private: true, files: { 'README.md': 'mine' } });
  const relay = await startFakeRelay({ github: gh, owner: 'dindoopark', repo: 'paper-team-library', token: TEAM_TOKEN });
  const CODE_A = 'PR-AAAA-BBBB';
  const CODE_B = 'PR-CCCC-DDDD';
  const CODE_O = 'PR-EEEE-FFFF';
  const pidA = relay.addCode(CODE_A, '김동료');
  const pidB = relay.addCode(CODE_B, '박동료');
  relay.addCode(CODE_O, '주인');
  const team = () => [...gh.files('dindoopark', 'paper-team-library').keys()].sort();
  const teamJson = (path) => JSON.parse(gh.readFile('dindoopark', 'paper-team-library', path).toString('utf8'));
  const syncOptions = { pushDelayMs: 40, pushMaxDelayMs: 200, pullIntervalMs: 600_000, retryDelaysMs: [300, 600, 1200] };
  const openViaRelay = (code, name, tag) => track(openSharedLibrary({ relayUrl: relay.url, code, name, db: freshDb(tag), syncOptions }));
  const refused = () => relay.log.filter((e) => e.status === 403);
  let A;
  let B;
  let lu;
  let folder;

  try {
    await test('via the relay: A\'s folders, paper and translation reach B; A\'s notes and AI data do not; the empty team repo is bootstrapped; the invite code never reaches GitHub', async () => {
      A = await openViaRelay(CODE_A, '김동료', 'netA');
      folder = A.createFolder('섬망 연구');
      const bytes = makePdf(61, 30_000);
      lu = await A.addPaper(bytes, { fileName: 'lu2025.pdf', folderId: folder.id, meta: { title: 'Lu 2025' } });
      await A.savePaperData(lu.id, 'translation', { version: 1, targetLang: 'ko', segVersion: 1, items: { 'p1-0': { h: 'h0', t: '〔번역〕 A' } } });
      await A.savePaperData(lu.id, 'annotations', { version: 1, items: [{ id: 'ann_A', anchor: { start: 0, end: 5 }, quote: 'q', color: 'yellow', note: 'A 메모', createdAt: 1, updatedAt: 1 }] });
      await A.savePaperData(lu.id, 'ai', { version: 1, summary: { markdown: 'A 요약', createdAt: 1 } });
      await A.flush();
      await waitSync(A);
      const expected = ['README.md', 'library.json', `papers/${lu.id}/paper.pdf`, `papers/${lu.id}/translation.json`,
        `people/${pidA}/papers/${lu.id}/ai.json`, `people/${pidA}/papers/${lu.id}/annotations.json`].sort();
      assert(team().join() === expected.join(), `team repo: ${team()}`);
      assert(refused().length === 0, `relay refused: ${JSON.stringify(refused())}`);
      const tokens = new Set(gh.log.map((e) => e.token));
      assert(!tokens.has(CODE_A) && [...tokens].every((t) => t === TEAM_TOKEN || t === 'ghp_owner_token'), `tokens seen by GitHub: ${[...tokens]}`);

      B = await openViaRelay(CODE_B, '박동료', 'netB');
      await B.sync.syncNow();
      await waitSync(B);
      assert(B.getFolder(folder.id)?.name === '섬망 연구' && B.getPaper(lu.id)?.folderId === folder.id, 'B sees folder + paper');
      assert(bytesEqual(await B.getPdf(lu.id), bytes), 'B gets the PDF');
      assert((await B.getPaperData(lu.id, 'translation')).items['p1-0'].t === '〔번역〕 A', 'B reuses the translation');
      assert((await B.getPaperData(lu.id, 'annotations')) === null && (await B.getPaperData(lu.id, 'ai')) === null, 'B must not see A\'s notes/AI');
      assert((await B.sync.listPaths('people/')).length === 0, 'B\'s tree has no people/ entries of A');
      await B.savePaperData(lu.id, 'annotations', { version: 1, items: [{ id: 'ann_B', anchor: { start: 9, end: 12 }, quote: 'b', color: 'blue', note: 'B 메모', createdAt: 2, updatedAt: 2 }] });
      await B.flush();
      await waitSync(B);
      await A.sync.syncNow();
      const aAnn = (await A.getPaperData(lu.id, 'annotations')).items.map((i) => i.id);
      assert(team().includes(`people/${pidB}/papers/${lu.id}/annotations.json`) && aAnn.join() === 'ann_A', `A's notes: ${aAnn}`);
      return `team repo [${team().map((p) => p.replace(lu.id, '<id>').replace(pidA, '<A>').replace(pidB, '<B>')).join(', ')}]; B: folder+paper+PDF+translation yes, annotations/ai null; A still sees only its own notes; 0 refusals; GitHub saw only the team token`;
    });

    await test('via the relay: B deletes → A sees it in the 휴지통 with B\'s name → A restores → B sees it again; the PDF never leaves the repo', async () => {
      B.deletePaper(lu.id);
      await B.flush();
      await waitSync(B);
      assert(team().includes(`papers/${lu.id}/paper.pdf`) && team().includes(`papers/${lu.id}/translation.json`), 'files kept in the repo');
      assert(teamJson('library.json').papers.find((p) => p.id === lu.id).deletedBy === '박동료', 'tombstone has deletedBy');
      await A.sync.syncNow();
      await waitSync(A);
      const item = A.trash().find((t) => t.id === lu.id);
      assert(!A.getPaper(lu.id) && item?.deletedBy === '박동료' && item.kind === 'paper', JSON.stringify(A.trash()));
      const back = await A.restore(lu.id);
      await A.flush();
      await waitSync(A);
      await B.sync.syncNow();
      await waitSync(B);
      assert(back.folderId === folder.id && B.getPaper(lu.id)?.folderId === folder.id && (await B.getPdf(lu.id)).byteLength === 30_000, 'restored everywhere');
      assert(refused().length === 0, `relay refused: ${JSON.stringify(refused())}`);
      return `A's 휴지통: “${item.name}” deleted by ${item.deletedBy}; restored into 섬망 연구 on both; paper.pdf + translation.json stayed in the repo throughout`;
    });

    await test('via the relay: concurrent pushes — a commit on a stale head is answered 409, A re-pulls, merges and retries; both folders land', async () => {
      const pause = gh.pauseNext({ method: 'POST', path: /\/git\/blobs$/ }); // hold A's upload between its pull and its commit
      A.createFolder('A가 만든 폴더');
      const aPush = A.flush();
      await pause.hit;
      B.createFolder('B가 만든 폴더');
      await B.flush();
      await waitSync(B);
      relay.clearLog();
      pause.release();
      await aPush;
      await waitSync(A);
      const stale = relay.log.filter((e) => e.status === 409 && e.code === CODE_A);
      const names = teamJson('library.json').folders.filter((f) => !f.deleted).map((f) => f.name);
      assert(stale.length >= 1, `expected a 409 for A: ${JSON.stringify(relay.log.map((e) => `${e.method} ${e.path.split('/gh')[1]} ${e.status}`))}`);
      assert(names.includes('A가 만든 폴더') && names.includes('B가 만든 폴더'), `folders: ${names}`);
      return `409 on ${stale.map((e) => `${e.method} ${e.path.split('/gh/repos/team/library')[1]}`).join(', ')}; repo folders [${names.join(', ')}]`;
    });

    await test('via the relay: commit messages say who did what (최근 활동), without person ids or codes', async () => {
      const res = await fetch(`${relay.url}/shared/team/activity?limit=30`, { headers: { Authorization: `Bearer ${CODE_A}` } });
      const { items } = await res.json();
      const lines = items.map((i) => `[${i.who}] ${i.summary}`);
      const has = (who, re) => items.some((i) => i.who === who && re.test(i.summary));
      assert(has('김동료', /논문 추가 ‘Lu 2025’/) && has('김동료', /폴더 만듦 ‘섬망 연구’/), lines.join('\n'));
      assert(has('김동료', /번역 ‘Lu 2025’/), lines.join('\n'));
      assert(has('박동료', /논문 삭제 ‘Lu 2025’/) && has('김동료', /복구 ‘Lu 2025’/) && has('박동료', /폴더 만듦 ‘B가 만든 폴더’/), lines.join('\n'));
      assert(has('박동료', /내 메모·AI 결과 동기화/), lines.join('\n'));
      assert(!lines.some((l) => /people\/|PR-|library\.json/.test(l)), lines.join('\n'));
      return lines.slice(0, 8).join(' | ');
    });

    await test('via the relay: a stopped invite code → status error with the relay\'s Korean message and no retry storm; works again after 지금 동기화', async () => {
      relay.setActive(CODE_B, false);
      relay.clearLog();
      B.createFolder('중지된 코드로');
      await B.flush();
      const st = await waitSync(B, { state: 'error', pending: null });
      const n1 = relay.log.filter((e) => e.code === CODE_B).length;
      await sleep(1500);
      const n2 = relay.log.filter((e) => e.code === CODE_B).length;
      assert(st.message === '초대 코드가 올바르지 않거나 사용이 중지되었습니다.' && n1 === n2 && n1 <= 2, `${st.message} · requests ${n1} → ${n2}`);
      relay.setActive(CODE_B, true);
      await B.sync.syncNow();
      await waitSync(B);
      assert(teamJson('library.json').folders.some((f) => f.name === '중지된 코드로'), 'pushed after re-enabling');
      return `“${st.message}”; ${n1} request(s), none in the next 1.5 s; after re-enabling, 지금 동기화 pushed the pending change`;
    });

    await test('app-style call (js/app.js): openSharedLibrary with getConfig, dbName, personName and the library name as `name` — proxy mode is forced, deletedBy/addedBy use personName', async () => {
      const CODE_C = 'PR-GGGG-HHHH';
      const pidC = relay.addCode(CODE_C, '최동료');
      const apiBase = `${relay.url}/shared/team/gh`;
      let code = CODE_C;
      const C = await track(openSharedLibrary({
        settings: { get: () => ({}) },
        id: 'shared:team',
        label: '공용 서재',
        dbName: `paper-reader-shared-team-${pidC}`,
        db: freshDb('app-style'),
        // like app.js #syncConfig: no `proxy` flag
        getConfig: () => ({ owner: 'team', repo: 'library', branch: 'main', token: code, apiBase, carryOver: `${apiBase}/team/library#main` }),
        personalPrefix: `people/${pidC}/`,
        retainPdfOnDelete: true,
        shared: true,
        personName: '최동료',
        lib: 'team',
        name: '공용 서재',
        personId: pidC,
        syncOptions,
      }));
      assert(C.personalPrefix === `people/${pidC}/` && C.personName === '최동료' && C.label === '공용 서재', 'options');
      await C.sync.syncNow();
      await waitSync(C);
      const p = await C.addPaper(makePdf(81), { fileName: 'c.pdf', meta: { title: 'C의 논문' } });
      await C.flush();
      await waitSync(C);
      C.deletePaper(p.id);
      await C.flush();
      await waitSync(C);
      const rec = teamJson('library.json').papers.find((x) => x.id === p.id);
      assert(rec.addedBy === '최동료' && rec.deletedBy === '최동료', JSON.stringify(rec));
      code = 'PR-ZZZZ-ZZZZ'; // a code the relay does not know: proxy-mode wording, not "GitHub 토큰"
      await C.reconfigureSync();
      await C.sync.syncNow();
      const st = C.sync.status;
      assert(st.state === 'error' && /초대 코드가 올바르지 않거나/.test(st.message), JSON.stringify(st));
      return `addedBy/deletedBy = ${rec.addedBy}; unknown code → “${st.message}”`;
    });

    await test('owner copies a folder from 내 서재 (personal repo, paths unchanged) into 공용 서재: PDFs + translations land in the team repo, never personal files; a duplicate is mapped', async () => {
      const mine = await track(Library.open({
        db: freshDb('owner-mine'),
        getConfig: () => ({ owner: 'me', repo: 'paper-library', branch: 'main', token: 'ghp_owner_token', apiBase: gh.url }),
        syncOptions,
      }));
      const O = await openViaRelay(CODE_O, '주인', 'owner-shared');
      await O.sync.syncNow();
      await waitSync(O);
      const icu = mine.createFolder('ICU');
      const cauti = mine.createFolder('CAUTI', icu.id);
      const q1 = await mine.addPaper(makePdf(71, 20_000), { fileName: 'q1.pdf', folderId: icu.id, meta: { title: 'Q1' } });
      const q2 = await mine.addPaper(makePdf(61, 30_000), { fileName: 'lu-mine.pdf', folderId: cauti.id, meta: { title: 'Lu (내 사본)' } }); // = Lu 2025
      await mine.savePaperData(q1.id, 'translation', { version: 1, targetLang: 'ko', segVersion: 1, items: { 'p1-0': { h: 'q', t: 'Q1 번역' } } });
      await mine.savePaperData(q1.id, 'annotations', { version: 1, items: [{ id: 'o1', anchor: { start: 0, end: 1 }, quote: 'o', color: 'green', note: '주인 메모', createdAt: 1, updatedAt: 1 }] });
      await mine.flush();
      await waitSync(mine);
      const minePaths = [...gh.files('me', 'paper-library').keys()].filter((p) => p.includes(q1.id)).sort();
      assert(minePaths.join() === ['annotations.json', 'paper.pdf', 'translation.json'].map((f) => `papers/${q1.id}/${f}`).join(), `personal repo paths: ${minePaths}`);

      const res = await mine.copyFolderTo(O, icu.id);
      await O.flush();
      await waitSync(O);
      assert(res.papers.copied === 1 && res.papers.existing === 1 && res.papers.moved === 1, JSON.stringify(res.papers));
      const lib = teamJson('library.json');
      const icuT = lib.folders.find((f) => f.name === 'ICU' && !f.deleted);
      const cautiT = lib.folders.find((f) => f.name === 'CAUTI' && f.parentId === icuT?.id);
      const q1T = lib.papers.find((p) => p.title === 'Q1');
      assert(icuT && cautiT && q1T?.folderId === icuT.id && lib.papers.find((p) => p.id === lu.id).folderId === cautiT.id, JSON.stringify(lib));
      assert(team().includes(`papers/${q1T.id}/paper.pdf`) && team().includes(`papers/${q1T.id}/translation.json`), 'files of the copy');
      assert(!team().some((p) => p.startsWith('people/') && p.includes(q1T.id)), `personal files copied: ${team().filter((p) => p.includes(q1T.id))}`);
      assert(teamJson(`papers/${q1T.id}/translation.json`).items['p1-0'].t === 'Q1 번역', 'translation in the team repo');
      const { items } = await (await fetch(`${relay.url}/shared/team/activity?limit=5`, { headers: { Authorization: `Bearer ${CODE_O}` } })).json();
      assert(items.some((i) => i.who === '주인' && /폴더 복사 ‘ICU’ \(내 서재에서, 논문 2편\)/.test(i.summary)), JSON.stringify(items));
      assert(refused().length === 0, `relay refused: ${JSON.stringify(refused())}`);
      return `personal repo keeps papers/<id>/annotations.json; team repo got ICU/CAUTI, Q1 (pdf + translation, no notes), Lu 2025 mapped into CAUTI; activity “[주인] ${items.find((i) => i.who === '주인').summary}”`;
    });
  } finally {
    await relay.close();
    await gh.close();
  }
} finally {
  for (const lib of opened) await lib.close().catch(() => {});
}

writeFileSync(`${OUT}/library.results.json`, JSON.stringify({ results, external }, null, 2));
const failed = results.filter((r) => r.result !== 'pass').length;
console.log(`\nstore library: ${results.length - failed}/${results.length} passed · blocked external requests: ${external.length}${external.length ? ` (${external.join(', ')})` : ''}`);
process.exitCode = failed || external.length ? 1 : 0;
