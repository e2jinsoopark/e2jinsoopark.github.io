// Store module — each invite code's own library ('mine', the repo folder codes/<libraryId>/) next to 전체 공용 서재
// ('team', the repo root), in Node: in-memory databases (tests/store/memory-db.mjs) and the fake relay in code-library
// mode (tests/store/fake-relay.mjs { codeLibraries: true }) in front of the fake GitHub. Covers rootPrefix, the 'mine'
// library of openSharedLibrary, separate databases, copy between any two libraries, 휴지통, per-library activity and
// the layout the relay's split-by-uploader migration produces (production data shape).
//   node tests/store/code-libs.test.mjs [name filter]
// Results: C:/Users/dindoo/Projects/pr-tools/out/code-libs/store-node.results.json
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { memoryDb } from './memory-db.mjs';
import { startFakeGitHub } from './fake-github.mjs';
import { personIdOf, startFakeRelay } from './fake-relay.mjs';
import { CODE_LIBRARY, Library, codeLibraryPrefix, openSharedLibrary, sharedDbName } from '../../js/store/library.js';
import { GitHubClient, gitBlobSha } from '../../js/store/github.js';
import { SyncEngine } from '../../js/store/sync.js';

const OUT = 'C:/Users/dindoo/Projects/pr-tools/out/code-libs';
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
    return err;
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
const bytesEqual = (a, b) => a.byteLength === b.byteLength && a.every((v, i) => v === b[i]);

let dbSeq = 0;
const freshDb = (tag) => memoryDb(`c-${tag}-${++dbSeq}`);
async function track(promise) { const lib = await promise; opened.push(lib); return lib; }
const fileKeys = (db) => [...db.stores.files.keys()].sort();

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
const syncOptions = { pushDelayMs: 40, pushMaxDelayMs: 200, pullIntervalMs: 600_000, retryDelaysMs: [300, 600, 1200] };

try {
  // ------------------------------------------------------------- local only
  await test('Library.open({ rootPrefix }): validated; library paths, IndexedDB keys and dataPath stay the library\'s own; repoPath() adds the folder; the engine\'s client gets rootPrefix + label, no README, and a "carry my own data" carryOver names the folder', async () => {
    const seen = [];
    const db = freshDb('root-local');
    const cfg = { owner: 'team', repo: 'library', branch: 'main', token: 'PR-AAAA-BBBB', apiBase: 'http://127.0.0.1:9/shared/mine/gh' };
    const lib = await track(Library.open({
      db, id: 'shared:mine', label: '봄당 서재', shared: true, retainPdfOnDelete: true, personalPrefix: 'people/abcd/', personName: '봄당',
      rootPrefix: 'codes/0123456789abcdef/',
      getConfig: () => ({ ...cfg, carryOver: `${cfg.apiBase}/team/library#main` }),
      syncOptions: { ...syncOptions, createClient: (c) => { seen.push(c); return new GitHubClient(c); } },
    }));
    lib.sync.stop(); // nothing listens on :9 — only the configuration matters here
    const p = await lib.addPaper(makePdf(1), { fileName: 'a.pdf', meta: { title: 'A' } });
    await lib.savePaperData(p.id, 'ai', { version: 1, summary: { markdown: 's', createdAt: 1 } });
    await lib.whenSaved();
    const keys = fileKeys(db);
    assert(keys.join() === ['library.json', `papers/${p.id}/paper.pdf`, `people/abcd/papers/${p.id}/ai.json`].join(), `IndexedDB keys: ${keys}`);
    assert(lib.rootPrefix === 'codes/0123456789abcdef/' && lib.repoPath('library.json') === 'codes/0123456789abcdef/library.json'
      && lib.dataPath(p.id, 'ai') === `people/abcd/papers/${p.id}/ai.json`, 'paths');
    const c = seen[0];
    const client = new GitHubClient(c);
    assert(c.rootPrefix === 'codes/0123456789abcdef/' && c.proxy === true && c.label === '봄당 서재', JSON.stringify(c));
    assert(c.carryOver === client.target && client.target.endsWith('#main:codes/0123456789abcdef/'), `carryOver ${c.carryOver} vs ${client.target}`);
    for (const bad of ['codes/x', '../codes/x/', 'codes/x y/', '/codes/x/']) {
      await rejects(() => Library.open({ db: freshDb('bad'), rootPrefix: bad }), /invalid rootPrefix/, `rootPrefix ${bad}`);
    }
    return `IndexedDB [${keys.map((k) => k.replace(p.id, '<id>')).join(', ')}]; repoPath(library.json) = ${lib.repoPath('library.json')}; client { rootPrefix, proxy, label: ${c.label} }; carryOver = …${c.carryOver.slice(-30)}`;
  });

  await test('openSharedLibrary lib \'mine\': needs GET /shared\'s libraryId (Korean error otherwise); own database name per library and person; apiBase …/shared/mine/gh; folder codes/<libraryId>/; default label', async () => {
    const pid = '1111222233334444';
    const noId = await rejects(() => openSharedLibrary({ relayUrl: 'http://127.0.0.1:9', code: 'PR-AAAA-BBBB', lib: CODE_LIBRARY, personId: pid, db: freshDb('m') }), /서재 정보를 받지 못했습니다/, 'no libraryId');
    await rejects(() => openSharedLibrary({ relayUrl: 'http://127.0.0.1:9', code: 'PR-AAAA-BBBB', lib: 'mine', libraryId: '../x', personId: pid, db: freshDb('m') }), /서재 정보를 받지 못했습니다/, 'bad libraryId');
    assert(sharedDbName('mine', pid, 'abcdef0123456789') === `paper-reader-shared-mine-abcdef0123456789-${pid}`, 'db name (mine)');
    assert(sharedDbName('team', pid) === `paper-reader-shared-team-${pid}`, 'db name (team) unchanged');
    let threw = false;
    try { sharedDbName('mine', pid); } catch { threw = true; }
    assert(threw && codeLibraryPrefix('abcdef0123456789') === 'codes/abcdef0123456789/', 'mine without libraryId / prefix');
    const seen = [];
    const lib = await track(openSharedLibrary({
      relayUrl: 'http://127.0.0.1:9/', code: 'pr aaaa bbbb', lib: 'mine', libraryId: 'abcdef0123456789', personId: pid, name: '봄당',
      db: freshDb('m-ok'), syncOptions: { ...syncOptions, createClient: (c) => { seen.push(c); return new GitHubClient(c); } },
    }));
    lib.sync.stop();
    const c = seen[0];
    assert(lib.id === 'shared:mine' && lib.label === '초대 코드 서재' && lib.rootPrefix === 'codes/abcdef0123456789/' && lib.personalPrefix === `people/${pid}/` && lib.shared && lib.retainPdfOnDelete, 'getters');
    assert(c.apiBase === 'http://127.0.0.1:9/shared/mine/gh' && c.token === 'PR-AAAA-BBBB' && c.rootPrefix === 'codes/abcdef0123456789/' && c.carryOver === new GitHubClient(c).target, JSON.stringify(c));
    return `“${noId.message}”; db paper-reader-shared-mine-<libraryId>-<personId>; apiBase ${c.apiBase}; carryOver …${c.carryOver.slice(-34)}`;
  });

  await test('regression empty-repo-race: a write that lands after the pull found the repo empty is uploaded after the README bootstrap, never as a blob into the empty repo (409 → fatal “저장소가 비어 있습니다”)', async () => {
    const g = await startFakeGitHub({ port: 0 });
    try {
      g.addToken('ghp_race', { write: true });
      g.createRepo('me', 'empty-race', { private: true });
      const base = freshDb('race');
      let engine = null;
      let injected = false;
      // The first look at the dirty index happens after the pull saw an empty repo with nothing pending: a write
      // lands right then (in the browser: the page adding a paper while the start-up sync runs).
      const db = {
        ...base,
        async indexKeys(store, index, query) {
          if (!injected && store === 'files' && index === 'dirty') {
            injected = true;
            await engine.writeFile('library.json', { version: 1, updatedAt: 1, folders: [{ id: 'f1', name: '첫 폴더', parentId: null, updatedAt: 1 }], papers: [] });
          }
          return base.indexKeys(store, index, query);
        },
      };
      engine = new SyncEngine({ db, getConfig: () => ({ owner: 'me', repo: 'empty-race', token: 'ghp_race', apiBase: g.url }), ...syncOptions });
      await engine.start();
      await waitFor(() => engine.status.state === 'error' || (engine.status.state === 'idle' && engine.status.pending === 0 && injected && g.files('me', 'empty-race').size), 8000, 'push');
      engine.stop();
      const st = engine.status;
      const files = [...g.files('me', 'empty-race').keys()].sort();
      const empties = g.log.filter((e) => e.status === 409 && e.method === 'POST');
      assert(injected && files.join() === 'README.md,library.json' && empties.length === 0, `status ${JSON.stringify(st)}; files ${files}; 409 on POST: ${empties.map((e) => e.path)}`);
      return `write injected between pull and push; repo [${files.join(', ')}]; 0 POST answered 409`;
    } finally {
      await g.close();
    }
  });

  await test('regression upload-proof-expiry: the relay accepts in a tree only blobs this person uploaded through that library in the last hour — the engine uploads again when its upload is 45+ min old, and after the conflict retries run out', async () => {
    const g = await startFakeGitHub({ port: 0 });
    const realNow = Date.now;
    let engine = null;
    try {
      g.addToken('ghp_proof', { write: true });
      g.createRepo('me', 'proof', { private: true, files: { 'README.md': 'x' } });
      engine = new SyncEngine({
        db: freshDb('proof'), getConfig: () => ({ owner: 'me', repo: 'proof', token: 'ghp_proof', apiBase: g.url, proxy: true }), ...syncOptions,
      });
      await engine.start();
      await waitFor(() => engine.status.state === 'idle', 8000, 'first sync');
      const uploads = () => g.log.filter((e) => e.method === 'POST' && /\/git\/blobs$/.test(e.path) && e.status === 201).length;
      const landed = (path) => () => engine.status.state === 'idle' && engine.status.pending === 0 && g.files('me', 'proof').has(path);
      // 1. The relay refuses the tree (409, as for a blob it has no upload proof of) through every conflict retry.
      let mark = uploads();
      g.failNext({ method: 'POST', path: /\/git\/trees$/, status: 409, body: { message: '이 서재에 올린 기록이 없는 파일이 있어 저장할 수 없습니다.' }, count: 4 });
      await engine.writeFile('papers/p1/translation.json', { version: 1, items: { a: 1 } });
      await waitFor(landed('papers/p1/translation.json'), 15000, 'push after the conflicts');
      const afterConflicts = uploads() - mark;
      // 2. A push that failed (GitHub 502 ×3) is retried 46 min later: the upload is too old to reuse.
      mark = uploads();
      g.failNext({ method: 'POST', path: /\/git\/trees$/, status: 502, count: 3 });
      await engine.writeFile('papers/p2/translation.json', { version: 1, items: { b: 2 } });
      await waitFor(() => engine.status.state === 'error', 15000, 'the failed push');
      Date.now = () => realNow() + 46 * 60_000;
      await waitFor(landed('papers/p2/translation.json'), 15000, 'push 46 min later');
      const afterWait = uploads() - mark;
      assert(afterConflicts === 2 && afterWait === 2, `uploads: after the conflicts ${afterConflicts}, 46 min later ${afterWait} (each should be 2)`);
      return 'conflict retries exhausted → uploaded again (2 uploads); retried 46 min later → uploaded again (2 uploads)';
    } finally {
      Date.now = realNow;
      engine?.stop();
      await g.close();
    }
  });

  // ------------------------------------------------------- through the relay
  const gh = await startFakeGitHub({ port: 0 });
  const TEAM = { owner: 'dindoopark', repo: 'paper-team-library', token: 'ghp_team_secret_token' };
  gh.addToken(TEAM.token, { write: true });
  gh.createRepo(TEAM.owner, TEAM.repo, { private: true }); // empty: the first push (through a code library) bootstraps it
  gh.addToken('ghp_owner_token', { write: true });
  gh.createRepo('me', 'paper-library', { private: true, files: { 'README.md': 'mine' } });
  const relay = await startFakeRelay({ github: gh, ...TEAM, codeLibraries: true, libName: '전체 공용 서재' });
  const X = 'PR-AAAA-BBBB';
  const Y = 'PR-CCCC-DDDD';
  const pX = relay.addCode(X, '봄당');
  const pY = relay.addCode(Y, '6기');
  const libX = relay.libraryIdOf(X);
  const libY = relay.libraryIdOf(Y);
  const repoFiles = () => [...gh.files(TEAM.owner, TEAM.repo).keys()].sort();
  const repoJson = (path) => JSON.parse(gh.readFile(TEAM.owner, TEAM.repo, path).toString('utf8'));
  const refused = () => relay.log.filter((e) => e.status === 403);
  const sharedInfo = async (code, r = relay) => (await fetch(`${r.url}/shared`, { headers: { Authorization: `Bearer ${code}` } })).json();
  /** Opens a library the way the app does: GET /shared, then openSharedLibrary with its libraryId, personId, name. */
  async function openLib(code, lib, tag, { r = relay, so = syncOptions, db } = {}) {
    const info = await sharedInfo(code, r);
    const entry = info.libraries.find((l) => l.id === lib);
    assert(entry, `GET /shared has no ${lib}: ${JSON.stringify(info)}`);
    const library = await track(openSharedLibrary({
      relayUrl: r.url, code, lib, libraryId: info.libraryId, personId: info.personId, name: info.name, label: entry.name,
      db: db || freshDb(tag), syncOptions: so,
    }));
    await library.sync.syncNow();
    await waitSync(library);
    return library;
  }
  const activity = async (code, lib) => {
    const res = await fetch(`${relay.url}/shared/${lib}/activity?limit=50`, { headers: { Authorization: `Bearer ${code}` } });
    return (await res.json()).items;
  };
  const strip = (s) => s.replaceAll(libX, '<libX>').replaceAll(libY, '<libY>').replaceAll(pX, '<pX>').replaceAll(pY, '<pY>');
  let Xm; let Xt; let Ym; let Yt; let X2m;
  let xdb;
  let paper1;
  let folderX;
  const pdf1 = makePdf(101, 24_000);

  try {
    await test('GET /shared lists the code library (‘<name> 서재’, libraryId) before 전체 공용 서재; X\'s paper, translation and notes land under codes/<libX>/ only (the empty repo is bootstrapped through /shared/mine); its database keys and events stay library-relative', async () => {
      const info = await sharedInfo(X);
      assert(info.libraries.map((l) => `${l.id}:${l.name}:${l.kind}`).join() === 'mine:봄당 서재:code,team:전체 공용 서재:team' && info.libraryId === libX && info.personId === pX, JSON.stringify(info));
      xdb = freshDb('Xm');
      Xm = await openLib(X, 'mine', 'Xm', { db: xdb });
      Xt = await openLib(X, 'team', 'Xt');
      assert(Xm.label === '봄당 서재' && Xm.rootPrefix === `codes/${libX}/` && Xt.rootPrefix === '' && Xt.label === '전체 공용 서재', 'labels / prefixes');
      folderX = Xm.createFolder('봄당 폴더');
      paper1 = await Xm.addPaper(pdf1, { fileName: 'moral.pdf', folderId: folderX.id, meta: { title: 'Moral Sensitivity' } });
      await Xm.savePaperData(paper1.id, 'translation', { version: 1, targetLang: 'ko', segVersion: 1, items: { 'p1-0': { h: 'h0', t: '〔번역〕 봄당' } } });
      await Xm.savePaperData(paper1.id, 'annotations', { version: 1, items: [{ id: 'ann_X', anchor: { start: 0, end: 4 }, quote: 'q', color: 'yellow', note: '봄당 메모', createdAt: 1, updatedAt: 1 }] });
      await Xm.savePaperData(paper1.id, 'ai', { version: 1, summary: { markdown: '봄당 요약', createdAt: 1 } });
      await Xm.flush();
      await waitSync(Xm);
      const files = repoFiles();
      const expected = ['README.md', ...['library.json', `papers/${paper1.id}/paper.pdf`, `papers/${paper1.id}/translation.json`,
        `people/${pX}/papers/${paper1.id}/ai.json`, `people/${pX}/papers/${paper1.id}/annotations.json`].map((p) => `codes/${libX}/${p}`)].sort();
      assert(files.join() === expected.join(), `repo: ${strip(files.join())}`);
      assert(relay.codeFiles(X).length === 5 && !files.includes('library.json'), 'nothing at the root');
      assert(fileKeys(xdb).every((k) => !k.startsWith('codes/')) && fileKeys(xdb).includes('library.json'), `IndexedDB keys: ${fileKeys(xdb)}`);
      assert((await Xt.sync.listPaths('')).every((p) => !p.startsWith('codes')) && Xt.papers.length === 0, 'team library sees nothing of codes/');
      assert(refused().length === 0, `relay refused: ${JSON.stringify(refused())}`);
      return `repo [${strip(files.join(', ')).replaceAll(paper1.id, '<id>')}]; IndexedDB keys relative (${fileKeys(xdb).length}); 전체 공용 서재 empty`;
    });

    await test('same code on another device shares the code library and its notes; another code (Y) never sees it — not in its own library, not in 전체 공용 서재, not by tree or blob sha', async () => {
      const remote = [];
      const db2 = freshDb('X2m');
      X2m = await track(openSharedLibrary({ relayUrl: relay.url, code: X, lib: 'mine', libraryId: libX, personId: pX, name: '봄당', label: '봄당 서재', db: db2, syncOptions }));
      X2m.sync.addEventListener('remotechange', (e) => remote.push(...e.detail.paths));
      await X2m.sync.syncNow();
      await waitSync(X2m);
      assert(X2m.getPaper(paper1.id)?.folderId === folderX.id && bytesEqual(await X2m.getPdf(paper1.id), pdf1), 'second device: paper + PDF');
      assert((await X2m.getPaperData(paper1.id, 'annotations')).items[0].note === '봄당 메모' && (await X2m.getPaperData(paper1.id, 'ai')).summary.markdown === '봄당 요약', 'same code = same notes');
      assert(remote.includes('library.json') && remote.every((p) => !p.startsWith('codes/')), `remotechange paths: ${remote}`);

      Ym = await openLib(Y, 'mine', 'Ym');
      Yt = await openLib(Y, 'team', 'Yt');
      assert(Ym.papers.length === 0 && Ym.folders.length === 0 && Yt.papers.length === 0, 'Y sees nothing of X');
      assert((await Ym.sync.listPaths('')).length === 0 && (await Yt.sync.listPaths('')).every((p) => !p.startsWith('codes')), 'Y trees');
      const pdfSha = await gitBlobSha(pdf1);
      const get = async (lib, rest) => (await fetch(`${relay.url}/shared/${lib}/gh/repos/team/library${rest}`, { headers: { Authorization: `Bearer ${Y}` } })).status;
      const repoNow = gh.repo(TEAM.owner, TEAM.repo);
      const headTree = repoNow.get(repoNow.refs.get('heads/main'), 'commit').tree;
      const codesTree = repoNow.get(headTree, 'tree').entries.find((e) => e.name === 'codes').sha;
      const xTree = repoNow.get(codesTree, 'tree').entries.find((e) => e.name === libX).sha;
      const probes = {
        blobViaMine: await get('mine', `/git/blobs/${pdfSha}`),
        blobViaTeam: await get('team', `/git/blobs/${pdfSha}`),
        codesViaTeam: await get('team', `/git/trees/${codesTree}`),
        xFolderViaMine: await get('mine', `/git/trees/${xTree}`),
      };
      assert(Object.values(probes).every((s) => s === 404), JSON.stringify(probes));
      const yRoot = await (await fetch(`${relay.url}/shared/mine/gh/repos/team/library/git/trees/${headTree}?recursive=1`, { headers: { Authorization: `Bearer ${Y}` } })).json();
      const xTeam = await (await fetch(`${relay.url}/shared/team/gh/repos/team/library/git/trees/${headTree}?recursive=1`, { headers: { Authorization: `Bearer ${X}` } })).json();
      assert(yRoot.tree.map((e) => e.path).join() === 'codes' && xTeam.tree.map((e) => e.path).join() === 'README.md', `listings: Y mine [${yRoot.tree.map((e) => e.path)}], X team [${xTeam.tree.map((e) => e.path)}]`);
      return `X's 2nd device: folder, paper, PDF, notes, AI; remotechange [${remote.join(', ')}]; Y: 0 papers in both libraries; probes ${JSON.stringify(probes)}; Y's mine listing of the root = [codes], X's team listing = [README.md]`;
    });

    await test('code library and 전체 공용 서재 side by side: commits of one move the shared branch under the other (409 → re-pull → retry), both land; 최근 활동 is per library and never shows the {lib:…} marker', async () => {
      const pause = gh.pauseNext({ method: 'POST', path: /\/git\/blobs$/ }); // hold Y's upload between its pull and its commit
      const yFolder = Ym.createFolder('6기 폴더');
      await Ym.addPaper(makePdf(202, 9000), { fileName: 'proc.pdf', folderId: yFolder.id, meta: { title: 'Procedures' } });
      const yPush = Ym.flush();
      await pause.hit;
      Xt.createFolder('공용 폴더');
      await Xt.flush();
      await waitSync(Xt);
      relay.clearLog();
      pause.release();
      await yPush;
      await waitSync(Ym);
      const stale = relay.log.filter((e) => e.status === 409 && e.code === Y);
      assert(stale.length >= 1, `expected a 409 for Y: ${relay.log.map((e) => `${e.method} ${e.path.split('/gh')[1]} ${e.status}`).join(' | ')}`);
      assert(repoJson('library.json').folders.some((f) => f.name === '공용 폴더') && repoJson(`codes/${libY}/library.json`).folders.some((f) => f.name === '6기 폴더'), 'both landed');
      await Xm.sync.syncNow();
      await waitSync(Xm);
      assert(Xm.folders.map((f) => f.name).join() === '봄당 폴더' && Xm.papers.length === 1, 'X\'s code library unchanged by the others');

      const xMine = await activity(X, 'mine');
      const yMine = await activity(Y, 'mine');
      const team = await activity(X, 'team');
      const lines = (items) => items.map((i) => `[${i.who}] ${i.summary}`);
      assert(xMine.length && xMine.every((i) => i.who === '봄당') && lines(xMine).some((l) => /폴더 만듦 ‘봄당 폴더’ · 논문 추가 ‘Moral Sensitivity’/.test(l)), lines(xMine).join(' | '));
      assert(yMine.length && yMine.every((i) => i.who === '6기') && lines(yMine).some((l) => /6기 폴더/.test(l)), lines(yMine).join(' | '));
      assert(lines(team).some((l) => l === '[봄당] 폴더 만듦 ‘공용 폴더’') && !lines(team).some((l) => /봄당 폴더|6기 폴더|Moral|Procedures/.test(l)), lines(team).join(' | '));
      assert(![...xMine, ...yMine, ...team].some((i) => /\{lib|codes\/|people\/|PR-/.test(i.summary)), 'marker / paths / codes leaked into activity');
      const raw = gh.commits(TEAM.owner, TEAM.repo).map((c) => c.message);
      assert(raw.some((m) => m.startsWith(`[봄당] {lib:${libX}} `)) && raw.some((m) => m.startsWith('[봄당] {lib:team} ')), `commit messages: ${strip(raw.join(' | '))}`);
      return `409 for Y on ${stale.map((e) => e.path.split('/gh/repos/team/library')[1]).join(', ')}; X mine: ${lines(xMine).slice(0, 2).join(' | ')}; Y mine: ${lines(yMine)[0]}; team: ${lines(team)[0]}`;
    });

    let personal;
    await test('copy between any two libraries: 내 서재 → code library, code library → 전체 공용 서재, 전체 공용 서재 → code library (same PDF: no second upload, moved into the chosen folder), code library → 내 서재 — PDF + translation only, never notes', async () => {
      personal = await track(Library.open({
        db: freshDb('personal'),
        getConfig: () => ({ owner: 'me', repo: 'paper-library', branch: 'main', token: 'ghp_owner_token', apiBase: gh.url }),
        syncOptions,
      }));
      const icu = personal.createFolder('ICU');
      const q1 = await personal.addPaper(makePdf(303, 12_000), { fileName: 'q1.pdf', folderId: icu.id, meta: { title: 'Q1' } });
      await personal.savePaperData(q1.id, 'translation', { version: 1, targetLang: 'ko', segVersion: 1, items: { 'p1-0': { h: 'q', t: 'Q1 번역' } } });
      await personal.savePaperData(q1.id, 'annotations', { version: 1, items: [{ id: 'o1', anchor: { start: 0, end: 1 }, quote: 'o', color: 'green', note: '내 서재 메모', createdAt: 1, updatedAt: 1 }] });
      await personal.flush();
      await waitSync(personal);

      // 1. 내 서재 → code library
      const r1 = await personal.copyFolderTo(Xm, icu.id);
      await Xm.flush();
      await waitSync(Xm);
      const q1X = Xm.papers.find((p) => p.title === 'Q1');
      const icuX = Xm.folders.find((f) => f.name === 'ICU');
      assert(r1.papers.copied === 1 && q1X?.folderId === icuX?.id, JSON.stringify(r1));
      const xFiles = relay.codeFiles(X);
      assert(xFiles.includes(`papers/${q1X.id}/paper.pdf`) && xFiles.includes(`papers/${q1X.id}/translation.json`) && !xFiles.some((p) => p.startsWith('people/') && p.includes(q1X.id)), `code library files: ${xFiles}`);

      // 2. code library → 전체 공용 서재
      const r2 = await Xm.copyPaperTo(Xt, paper1.id);
      await Xt.flush();
      await waitSync(Xt);
      assert(r2.copied && repoFiles().includes(`papers/${r2.paper.id}/paper.pdf`) && repoFiles().includes(`papers/${r2.paper.id}/translation.json`), 'copied into the team root');
      assert(!repoFiles().some((p) => p.startsWith('people/') && p.includes(r2.paper.id)) && r2.paper.addedBy === '봄당', 'no notes copied; addedBy');

      // 3. 전체 공용 서재 → code library: the same PDF is already there → no upload, moved into the chosen folder
      relay.clearLog();
      const r3 = await Xt.copyPaperTo(Xm, r2.paper.id, { folderId: icuX.id });
      await Xm.flush();
      await waitSync(Xm);
      const uploads = relay.log.filter((e) => e.method === 'POST' && e.path.endsWith('/git/blobs') && e.bytesIn > 20_000);
      assert(r3.existing && r3.moved && !r3.copied && r3.paper.id === paper1.id && Xm.getPaper(paper1.id).folderId === icuX.id && uploads.length === 0, `${JSON.stringify(r3)} uploads ${uploads.length}`);

      // 4. code library → 내 서재
      const r4 = await Xm.copyPaperTo(personal, paper1.id);
      await personal.flush();
      await waitSync(personal);
      const mineRepo = [...gh.files('me', 'paper-library').keys()];
      assert(r4.copied && mineRepo.includes(`papers/${r4.paper.id}/paper.pdf`) && mineRepo.includes(`papers/${r4.paper.id}/translation.json`)
        && !mineRepo.some((p) => p.startsWith('codes/') || p.startsWith('people/')) && !mineRepo.includes(`papers/${r4.paper.id}/annotations.json`), `personal repo: ${mineRepo}`);
      assert(bytesEqual(await personal.getPdf(r4.paper.id), pdf1), 'PDF bytes in 내 서재');

      // A second Library instance on the same database is the same library: refused.
      const twin = await track(Library.open({ db: xdb, id: 'shared:mine', shared: true, retainPdfOnDelete: true, personalPrefix: `people/${pX}/`, rootPrefix: `codes/${libX}/` }));
      await rejects(() => Xm.copyPaperTo(twin, paper1.id), /같은 서재 안으로는 복사할 수 없습니다/, 'same library, second instance');
      await twin.close();

      const xAct = (await activity(X, 'mine')).map((i) => i.summary);
      const tAct = (await activity(X, 'team')).map((i) => i.summary);
      assert(xAct.some((s) => /폴더 복사 ‘ICU’ \(내 서재에서, 논문 1편\)/.test(s)) && tAct.some((s) => /논문 추가 ‘Moral Sensitivity’ \(봄당 서재에서 복사\)/.test(s)), `${xAct.join(' | ')} // ${tAct.join(' | ')}`);
      assert(refused().length === 0, `relay refused: ${JSON.stringify(refused())}`);
      return `1 ${JSON.stringify(r1.papers)}; 2 copied → team papers/<id>; 3 existing+moved, 0 uploads; 4 copied → personal repo; activity “${xAct.find((s) => /폴더 복사/.test(s))}” / “${tAct.find((s) => /복사/.test(s))}”`;
    });

    await test('휴지통 in the code library: delete only tombstones (the PDF stays under codes/<libX>/), the other device sees who deleted it and restores it; the relay refuses dropped records, a changed PDF, other people\'s notes, another code\'s folder and codes/ through 전체 공용 서재', async () => {
      Xm.deletePaper(paper1.id);
      await Xm.flush();
      await waitSync(Xm);
      assert(relay.codeFiles(X).includes(`papers/${paper1.id}/paper.pdf`), 'PDF kept');
      assert(repoJson(`codes/${libX}/library.json`).papers.find((p) => p.id === paper1.id).deletedBy === '봄당', 'tombstone');
      await X2m.sync.syncNow();
      await waitSync(X2m);
      const item = X2m.trash().find((t) => t.id === paper1.id);
      assert(item?.kind === 'paper' && item.deletedBy === '봄당' && !X2m.getPaper(paper1.id), JSON.stringify(X2m.trash()));
      await X2m.restore(paper1.id);
      await X2m.flush();
      await waitSync(X2m);
      await Xm.sync.syncNow();
      await waitSync(Xm);
      assert(Xm.getPaper(paper1.id) && !repoJson(`codes/${libX}/library.json`).papers.find((p) => p.id === paper1.id).deleted, 'restored');

      const raw = (code, lib, rootPrefix) => new GitHubClient({ owner: 'team', repo: 'library', token: code, apiBase: `${relay.url}/shared/${lib}/gh`, proxy: true, rootPrefix });
      const attempt = async (client, files) => {
        const head = await client.getHead();
        try { await client.commit(files, 'x', { parent: head.commitSha, baseTree: head.treeSha }); } catch (err) { return err; }
        return null;
      };
      const mineX = raw(X, 'mine', `codes/${libX}/`);
      const cases = {
        droppedRecords: await attempt(mineX, [{ path: 'library.json', text: JSON.stringify({ version: 1, folders: [], papers: [] }) }]),
        changedPdf: await attempt(mineX, [{ path: `papers/${paper1.id}/paper.pdf`, bytes: makePdf(999, 7000) }]),
        othersNotes: await attempt(mineX, [{ path: `people/${pY}/papers/${paper1.id}/ai.json`, text: '{}' }]),
        otherCodeFolder: await attempt(raw(X, 'mine', `codes/${libY}/`), [{ path: 'library.json', text: '{"version":1,"folders":[],"papers":[]}' }]),
        codesViaTeam: await attempt(raw(X, 'team', ''), [{ path: `codes/${libX}/papers/zz/translation.json`, text: '{}' }]),
      };
      const summary = Object.fromEntries(Object.entries(cases).map(([k, e]) => [k, e ? `${e.code} ${e.status}` : 'accepted']));
      assert(Object.values(cases).every((e) => e?.code === 'forbidden' && e.status === 403), JSON.stringify(summary));
      return `휴지통 “${item.name}” · ${item.deletedBy}; restored on both devices; relay: ${Object.entries(cases).map(([k, e]) => `${k} → 403 “${e.message.slice(0, 32)}…”`).join('; ')}`;
    });

    await test('a repo too big for one listing (GitHub truncates it): a fresh device walks its code library level by level through the relay and gets exactly its own folder; 전체 공용 서재 still shows nothing of codes/', async () => {
      gh.setTruncateRecursive(4);
      relay.clearLog();
      let X3;
      let Y3;
      try {
        X3 = await openLib(X, 'mine', 'X3');
        Y3 = await openLib(Y, 'team', 'Y3');
      } finally {
        gh.setTruncateRecursive(0);
      }
      const want = Xm.papers.map((p) => p.id).sort().join();
      const levels = relay.log.filter((e) => e.code === X && /\/git\/trees\/[0-9a-f]{40}$/.test(e.path) && !e.query.includes('recursive'));
      assert(X3.papers.map((p) => p.id).sort().join() === want && X3.folders.length === Xm.folders.length, `X3 papers: ${X3.papers.map((p) => p.title)}`);
      assert(levels.length >= 3 && levels.every((e) => e.status === 200), `level-by-level requests: ${levels.map((e) => e.status)}`);
      const yPaths = await Y3.sync.listPaths('');
      assert(yPaths.every((p) => !p.startsWith('codes')) && Y3.papers.every((p) => !Xm.getPaper(p.id) || p.title !== 'Q1'), `Y3 paths: ${strip(yPaths.join())}`);
      return `X3: ${X3.papers.length} papers, ${X3.folders.length} folders via ${levels.length} level-by-level listings; Y3 (전체 공용 서재): [${yPaths.map((p) => p.replace(/p_[a-z0-9]+/, '<id>')).join(', ')}]`;
    });

    await test('code library size cap: a PDF that would push it past its maxBytes is refused (413), kept on this device and named; the rest keeps syncing', async () => {
      const Z = 'PR-EEEE-FFFF';
      relay.addCode(Z, '작은 코드', { maxBytes: 40_000 });
      const Zm = await openLib(Z, 'mine', 'Zm');
      const errors = [];
      Zm.addEventListener('error', (e) => errors.push(e.detail.message));
      await Zm.addPaper(makePdf(401, 30_000), { fileName: 'fits.pdf', meta: { title: '들어가는 논문' } });
      await Zm.flush();
      await waitSync(Zm);
      const big = await Zm.addPaper(makePdf(402, 30_000), { fileName: 'big.pdf', meta: { title: '넘치는 논문' } });
      Zm.createFolder('그래도 동기화');
      await Zm.flush();
      await waitSync(Zm, { pending: 0 });
      const files = relay.codeFiles(Z);
      assert(!files.includes(`papers/${big.id}/paper.pdf`) && JSON.parse(gh.readFile(TEAM.owner, TEAM.repo, `codes/${relay.libraryIdOf(Z)}/library.json`)).folders.some((f) => f.name === '그래도 동기화'), `files ${files}`);
      assert(Zm.sync.status.rejected === 1 && errors.some((m) => /넘치는 논문/.test(m) && /작은 코드 서재/.test(m) && /용량/.test(m)), `${JSON.stringify(Zm.sync.status)} ${errors}`);
      assert(bytesEqual(await Zm.getPdf(big.id), makePdf(402, 30_000)), 'kept locally');
      return errors.find((m) => /넘치는/.test(m));
    });
  } finally {
    await relay.close();
  }

  // ------------------------------------------- after the split (production data shape)
  await test('after the relay\'s split-by-uploader (production shape): 봄당\'s code library has Moral at the top with its notes, 6기\'s has folder 찬영 with Procedures and its AI data; 전체 공용 서재 keeps Lessons in the 휴지통 and 찬영 tombstoned; a device with unsaved edits (even of a moved record) drops the moved records instead of pushing them back', async () => {
    const T2 = { owner: 'dindoopark', repo: 'paper-team-prod', token: 'ghp_team_prod_token' };
    gh.addToken(T2.token, { write: true });
    gh.createRepo(T2.owner, T2.repo, { private: true });
    const r2 = await startFakeRelay({ github: gh, ...T2, codeLibraries: true, libName: '전체 공용 서재' });
    try {
      const C = { NV: 'PR-1111-AAAA', G6: 'PR-2222-BBBB', BOM: 'PR-3333-CCCC', BOMT: 'PR-4444-DDDD', ADM: 'PR-5555-EEEE' };
      const p = {
        NV: r2.addCode(C.NV, 'NV'), G6: r2.addCode(C.G6, '6기'), BOM: r2.addCode(C.BOM, '봄당'),
        BOMT: r2.addCode(C.BOMT, '봄당테스트', { active: false }), ADM: r2.addCode(C.ADM, '관리자 비교테스트'),
      };
      const lib = { G6: r2.libraryIdOf(C.G6), BOM: r2.libraryIdOf(C.BOM) };
      const pdfs = { less: makePdf(501, 8000), moral: makePdf(502, 9000), proc: makePdf(503, 10_000) };
      const t0 = Date.now() - 3 * DAY;
      const rec = (id, title, addedBy, bytes, extra = {}) => ({
        id, title, authors: '', year: 2024, fileName: `${id}.pdf`, size: bytes.byteLength, pages: 3, folderId: null, starred: false,
        addedAt: t0, updatedAt: t0, lastOpenedAt: null, translatedCount: 0, sentenceCount: 0, sha256: sha256(bytes), addedBy, ...extra,
      });
      const chan = { id: 'f_chan', name: '찬영', parentId: null, createdAt: t0, updatedAt: t0 };
      const lessons = rec('p_less', 'Lessons in biostatistics', '봄당테스트', pdfs.less, { deleted: true, deletedAt: t0 + 1000, deletedBy: '봄당테스트', updatedAt: t0 + 1000 });
      const moral = rec('p_moral', 'Moral Sensitivity in Psychiatric Practice', '봄당', pdfs.moral);
      const proc = rec('p_proc', 'Procedures Performed by Advanced Practice Provider', '6기', pdfs.proc, { folderId: 'f_chan' });
      const j = (o) => `${JSON.stringify(o, null, 2)}\n`;
      const moralAi = j({ version: 1, summary: { markdown: '봄당의 요약', createdAt: t0 }, updatedAt: t0 });
      const moralAnn = j({ version: 1, items: [{ id: 'ann_b', anchor: { start: 0, end: 5 }, quote: 'Moral', color: 'yellow', note: '봄당 메모', createdAt: t0, updatedAt: t0 }], updatedAt: t0 });
      const procAi = j({ version: 1, summary: { markdown: '6기의 요약', createdAt: t0 }, updatedAt: t0 });
      gh.commitFiles(T2.owner, T2.repo, {
        'README.md': 'team',
        'library.json': j({ version: 1, updatedAt: t0, folders: [chan], papers: [lessons, moral, proc] }),
        'papers/p_less/paper.pdf': Buffer.from(pdfs.less),
        'papers/p_moral/paper.pdf': Buffer.from(pdfs.moral),
        'papers/p_proc/paper.pdf': Buffer.from(pdfs.proc),
        [`people/${p.BOM}/papers/p_moral/ai.json`]: moralAi,
        [`people/${p.BOM}/papers/p_moral/annotations.json`]: moralAnn,
        [`people/${p.G6}/papers/p_proc/ai.json`]: procAi,
      }, { message: '[봄당] 논문 추가 ‘Moral…’' });

      // 봄당's device had 전체 공용 서재 open before the split, read its notes, and has an unsaved edit when it happens.
      const bomDb = freshDb('bom-team');
      const slow = { ...syncOptions, pushDelayMs: 60_000, pushMaxDelayMs: 120_000 };
      const bomTeam = await openLib(C.BOM, 'team', 'bom-team', { r: r2, so: slow, db: bomDb });
      assert(bomTeam.papers.map((x) => x.id).sort().join() === 'p_moral,p_proc' && (await bomTeam.getPaperData('p_moral', 'annotations')).items[0].note === '봄당 메모', 'before the split');
      bomTeam.createFolder('봄당 새 폴더');
      bomTeam.updatePaper('p_moral', { title: 'Moral (분리 직전에 고침)' }); // an edit of a record the split is about to move
      await bomTeam.whenSaved();

      // The relay's split (docs: POST /relay/admin/shared/team/split-by-uploader), as one server-side commit.
      const now = Date.now();
      const B = `codes/${lib.BOM}/`;
      const G = `codes/${lib.G6}/`;
      gh.commitFiles(T2.owner, T2.repo, {
        'library.json': j({ version: 1, updatedAt: now, folders: [{ ...chan, deleted: true, deletedAt: now, deletedBy: '관리자', updatedAt: now }], papers: [lessons] }),
        'papers/p_moral/paper.pdf': null,
        'papers/p_proc/paper.pdf': null,
        [`people/${p.BOM}/papers/p_moral/ai.json`]: null,
        [`people/${p.BOM}/papers/p_moral/annotations.json`]: null,
        [`people/${p.G6}/papers/p_proc/ai.json`]: null,
        [`${B}library.json`]: j({ version: 1, updatedAt: now, folders: [], papers: [moral] }),
        [`${B}papers/p_moral/paper.pdf`]: Buffer.from(pdfs.moral),
        [`${B}people/${p.BOM}/papers/p_moral/ai.json`]: moralAi,
        [`${B}people/${p.BOM}/papers/p_moral/annotations.json`]: moralAnn,
        [`${G}library.json`]: j({ version: 1, updatedAt: now, folders: [chan], papers: [proc] }),
        [`${G}papers/p_proc/paper.pdf`]: Buffer.from(pdfs.proc),
        [`${G}people/${p.G6}/papers/p_proc/ai.json`]: procAi,
      }, { message: '[관리자] {lib:team} 올린 사람의 코드 서재로 나누기' });

      await bomTeam.flush();
      await waitSync(bomTeam);
      const teamLib = JSON.parse(gh.readFile(T2.owner, T2.repo, 'library.json').toString('utf8'));
      assert(teamLib.papers.map((x) => x.id).join() === 'p_less' && teamLib.folders.some((f) => f.name === '봄당 새 폴더') && teamLib.folders.find((f) => f.id === 'f_chan').deleted, `team library.json after 봄당's push: ${JSON.stringify(teamLib)}`);
      assert(bomTeam.papers.length === 0 && !fileKeys(bomDb).some((k) => k.includes('p_moral') || k.includes('p_proc')), `봄당's team device: ${bomTeam.papers.map((x) => x.id)} / ${fileKeys(bomDb)}`);

      const bomMine = await openLib(C.BOM, 'mine', 'bom-mine', { r: r2 });
      const g6Mine = await openLib(C.G6, 'mine', 'g6-mine', { r: r2 });
      const g6Team = await openLib(C.G6, 'team', 'g6-team', { r: r2 });
      const nvMine = await openLib(C.NV, 'mine', 'nv-mine', { r: r2 });
      const m = bomMine.getPaper('p_moral');
      assert(m && m.folderId === null && bomMine.papers.length === 1 && bytesEqual(await bomMine.getPdf('p_moral'), pdfs.moral), 'Moral in 봄당 서재');
      assert((await bomMine.getPaperData('p_moral', 'annotations')).items[0].note === '봄당 메모' && (await bomMine.getPaperData('p_moral', 'ai')).summary.markdown === '봄당의 요약', '봄당 notes follow');
      const chanG = g6Mine.folders.find((f) => f.name === '찬영');
      assert(chanG && g6Mine.getPaper('p_proc')?.folderId === chanG.id && (await g6Mine.getPaperData('p_proc', 'ai')).summary.markdown === '6기의 요약', '6기: 찬영/Procedures + AI');
      assert(g6Team.papers.length === 0 && g6Team.folders.map((f) => f.name).join() === '봄당 새 폴더', `6기 team: ${g6Team.folders.map((f) => f.name)}`);
      const trash = g6Team.trash().map((t) => `${t.kind}:${t.name}:${t.deletedBy}`);
      assert(trash.includes('folder:찬영:관리자') && trash.includes('paper:Lessons in biostatistics:봄당테스트'), trash.join(' | '));
      assert(nvMine.papers.length === 0 && nvMine.folders.length === 0, 'NV sees no one else\'s library');
      const teamAct = await (await fetch(`${r2.url}/shared/team/activity`, { headers: { Authorization: `Bearer ${C.NV}` } })).json();
      assert(teamAct.items.some((i) => i.who === '관리자' && i.summary === '올린 사람의 코드 서재로 나누기'), JSON.stringify(teamAct.items));
      const stopped = await (await fetch(`${r2.url}/shared`, { headers: { Authorization: `Bearer ${C.BOMT}` } })).status;
      assert(stopped === 401, `stopped code: ${stopped}`);
      return `team library.json papers [p_less] + folders [찬영 (tombstoned), 봄당 새 폴더]; 봄당 서재: Moral (top level) + notes; 6기 서재: 찬영/Procedures + ai; team 휴지통 [${trash.join(', ')}]; activity “[관리자] 올린 사람의 코드 서재로 나누기”`;
    } finally {
      await r2.close();
    }
  });
  await gh.close();
} finally {
  for (const lib of opened) await lib.close().catch(() => {});
}

writeFileSync(`${OUT}/store-node.results.json`, JSON.stringify({ results, external }, null, 2));
const failed = results.filter((r) => r.result !== 'pass').length;
console.log(`\nstore code libraries: ${results.length - failed}/${results.length} passed · blocked external requests: ${external.length}${external.length ? ` (${external.join(', ')})` : ''}`);
process.exitCode = failed || external.length ? 1 : 0;
