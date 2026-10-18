// Store module — browser tests: real IndexedDB + js/store/* in Edge, GitHub replaced by the in-process
// fake (tests/store/fake-github.mjs). Each browser context is one device.
//   node tests/store/run.mjs            (starts `python -m http.server 8102` if nothing is listening)
// Results + screenshots: C:/Users/dindoo/Projects/pr-tools/out/store/. Fixture PDFs are served by route
// interception from C:/Users/dindoo/Projects/pr-fixtures (never copied into the repo). No external host is contacted.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'file:///C:/Users/dindoo/Projects/pr-tools/node_modules/playwright/index.mjs';
import { routeGitHubToFake, startFakeGitHub } from './fake-github.mjs';

const PORT = 8102;
const FAKE_PORT = 8112;
const BASE = `http://127.0.0.1:${PORT}`;
const H = `${BASE}/tests/store/harness.html`;
const OUT = 'C:/Users/dindoo/Projects/pr-tools/out/store';
const FIXTURES = 'C:/Users/dindoo/Projects/pr-fixtures';
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const TOKEN = 'ghp_store_test_token';
const OWNER = 'me';
const REPO = 'paper-library';

mkdirSync(OUT, { recursive: true });
const results = [];
const pageErrors = [];
const consoleErrors = [];
const external = [];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
function assert(cond, msg) { if (!cond) throw new Error(msg); }
async function waitFor(fn, timeout = 10000, what = 'condition') {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error(`timeout waiting for ${what}`);
    await sleep(40);
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

async function serverUp() {
  try { return (await fetch(`${BASE}/tests/store/harness.html`)).ok; } catch { return false; }
}

let server = null;
if (!(await serverUp())) {
  server = spawn('python', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], { cwd: REPO_ROOT, stdio: 'ignore' });
  await waitFor(serverUp, 8000, 'python http.server');
}
const fake = await startFakeGitHub({ port: FAKE_PORT });
fake.addToken(TOKEN, { write: true });
fake.createRepo(OWNER, REPO, { private: true }); // empty: no commits yet
const GH = { owner: OWNER, repo: REPO, branch: 'main', token: TOKEN, apiBase: fake.url };
const repoJson = (path) => JSON.parse(fake.readFile(OWNER, REPO, path).toString('utf8'));
// Belt and braces: even a request that escaped every route could not reach the real GitHub.
const browser = await chromium.launch({ channel: 'msedge', args: ['--host-resolver-rules=MAP api.github.com 127.0.0.1, MAP *.github.com 127.0.0.1'] });

async function device(name, { harness = true } = {}) {
  const ctx = await browser.newContext({ locale: 'ko-KR', viewport: { width: 1360, height: 860 } });
  // Nothing may leave the machine: every non-loopback request is aborted (and recorded).
  await ctx.route(/^https?:\/\/(?!127\.0\.0\.1[:/])/, (route) => { external.push(route.request().url()); return route.abort(); });
  await ctx.route('**/__fixture__/*.pdf', (route) => {
    const file = new URL(route.request().url()).pathname.split('/').pop();
    return route.fulfill({ path: `${FIXTURES}/${file}`, contentType: 'application/pdf' });
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => pageErrors.push(`${name}: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(`${name}: ${m.text()}`); });
  if (harness) {
    await page.goto(H);
    await page.waitForFunction(() => window.__harnessReady);
  }
  return { name, ctx, page, ev: (fn, arg) => page.evaluate(fn, arg) };
}

async function reload(dev) {
  await dev.page.reload();
  await dev.page.waitForFunction(() => window.__harnessReady);
}

const patches = (status) => fake.log.filter((e) => e.method === 'PATCH' && (status == null || e.status === status));
let A;
let B;
let a; // ids created on A
let bPaper;
let tie = null; // devices H, I and a paper shared by the regression scenarios below

try {
  // ------------------------------------------------------------------ 1
  await test('offline-first: library, PDF and paper data persist across reload with sync off', async () => {
    const X = await device('X');
    await X.ev(() => window.__boot());
    const made = await X.ev(async () => {
      const lib = window.__lib;
      const f = lib.createFolder('섬망 연구');
      const sub = lib.createFolder('예방 중재', f.id);
      const bytes = window.__makePdf(200_000, 7);
      const p = await lib.addPaper(bytes, { fileName: 'offline.pdf', folderId: sub.id, meta: { title: 'Offline paper', authors: 'K. Kim', year: 2024, pages: 3 } });
      lib.updatePaper(p.id, { starred: true });
      await lib.savePaperData(p.id, 'annotations', { version: 1, items: [{ id: 'a1', anchor: { start: 0, end: 5 }, quote: 'hello', color: 'yellow', note: '메모', createdAt: 1, updatedAt: Date.now() }] });
      await lib.whenSaved();
      return { f: f.id, sub: sub.id, id: p.id, sha: await window.__sha256(bytes) };
    });
    await reload(X);
    const after = await X.ev(async (id) => {
      await window.__boot();
      const lib = window.__lib;
      const pdf = await lib.getPdf(id);
      return { dump: window.__dump(), sha: await window.__sha256(pdf), ann: await lib.getPaperData(id, 'annotations'), status: lib.sync.status };
    }, made.id);
    const sub = after.dump.folders.find((f) => f.id === made.sub);
    const paper = after.dump.papers[0];
    assert(after.dump.folders.length === 2 && sub?.parentId === made.f, `folders: ${JSON.stringify(after.dump.folders)}`);
    assert(paper.id === made.id && paper.starred && paper.folderId === made.sub, `paper: ${JSON.stringify(paper)}`);
    assert(after.sha === made.sha, 'PDF bytes changed across reload');
    assert(after.ann?.items?.[0]?.note === '메모', 'annotations lost');
    assert(after.status.state === 'disabled' && after.status.pending === 3, `status: ${JSON.stringify(after.status)}`);
    await X.ctx.close();
    return `after reload: 2 folders (nested), 1 starred paper in subfolder, PDF sha256 ${after.sha.slice(0, 12)}… identical, annotations intact; status=${after.status.state}, pending=${after.status.pending} (library.json, paper.pdf, annotations.json)`;
  });

  // ------------------------------------------------------------------ 2
  await test('first sync: one commit with library.json + paper.pdf + data files (empty repo bootstrapped via README)', async () => {
    A = await device('A');
    await A.ev(() => window.__boot());
    a = await A.ev(async () => {
      const lib = window.__lib;
      const f = lib.createFolder('섬망 연구');
      const bytes = await window.__fixture('lu2025');
      const p = await lib.addPaper(bytes, { fileName: 'lu2025.pdf', folderId: f.id, meta: { title: 'Lu 2025', pages: 12 } });
      const now = Date.now();
      await lib.savePaperData(p.id, 'translation', { version: 1, targetLang: 'ko', segVersion: 1, items: { 'p1-0': { h: 'deadbeef', t: '〔번역〕 제목', m: 'mock' } } });
      await lib.savePaperData(p.id, 'annotations', { version: 1, items: [{ id: 'ann_a0', anchor: { start: 10, end: 40 }, quote: 'q', color: 'green', note: '', createdAt: now, updatedAt: now }] });
      await lib.savePaperData(p.id, 'ai', { version: 1, summary: { markdown: '## 한 줄 요약\n테스트', model: 'mock', createdAt: now } });
      await lib.whenSaved();
      return { folderId: f.id, paperId: p.id, sha: await window.__sha256(bytes), size: bytes.byteLength };
    });
    fake.clearLog();
    await A.ev((gh) => window.__configure(gh), GH);
    const st = await A.ev(() => window.__waitSync());
    const commits = fake.commits(OWNER, REPO);
    const expected = ['library.json', ...['ai.json', 'annotations.json', 'paper.pdf', 'translation.json'].map((f) => `papers/${a.paperId}/${f}`)].sort();
    assert(commits.length === 2, `expected README bootstrap + 1 data commit, got ${commits.length}: ${JSON.stringify(commits.map((c) => c.changed))}`);
    assert(commits[1].changed.join() === 'README.md', `bootstrap: ${commits[1].changed}`);
    assert(commits[0].changed.join() === expected.join(), `data commit: ${commits[0].changed}`);
    assert(sha256(fake.readFile(OWNER, REPO, `papers/${a.paperId}/paper.pdf`)) === a.sha, 'repo PDF differs');
    const lib = repoJson('library.json');
    assert(lib.papers[0].id === a.paperId && lib.folders[0].name === '섬망 연구', 'library.json content');
    const empty409 = fake.log.some((e) => e.status === 409);
    assert(empty409 && st.pending === 0, `409=${empty409} pending=${st.pending}`);
    return `409 on empty repo → README via contents API, then ONE commit "${commits[0].message}" with [${commits[0].changed.join(', ')}]; lu2025.pdf ${a.size} B sha256 matches`;
  });

  // ------------------------------------------------------------------ 3
  await test('device B (fresh context) pulls the library and downloads the PDF only when opened', async () => {
    B = await device('B');
    fake.clearLog();
    await B.ev((gh) => window.__boot({ github: gh }), GH);
    await B.ev(() => window.__waitSync());
    const pdfSha = fake.files(OWNER, REPO).get(`papers/${a.paperId}/paper.pdf`).sha;
    const pdfGets = () => fake.log.filter((e) => e.method === 'GET' && e.path.endsWith(`/git/blobs/${pdfSha}`)).length;
    const dump = await B.ev(() => window.__dump());
    assert(dump.papers.length === 1 && dump.papers[0].id === a.paperId && dump.papers[0].title === 'Lu 2025', JSON.stringify(dump));
    assert(dump.folders[0]?.id === a.folderId && dump.papers[0].folderId === a.folderId, 'folder');
    const beforeOpen = pdfGets();
    const got = await B.ev(async (id) => {
      const pdf = await window.__lib.getPdf(id);
      const again = await window.__lib.getPdf(id);
      return { sha: await window.__sha256(pdf), same: again.byteLength === pdf.byteLength, ann: await window.__lib.getPaperData(id, 'annotations') };
    }, a.paperId);
    const afterOpen = pdfGets();
    assert(beforeOpen === 0 && afterOpen === 1, `blob GETs before=${beforeOpen} after=${afterOpen}`);
    assert(got.sha === a.sha && got.same, 'PDF bytes differ');
    assert(got.ann?.items?.some((i) => i.id === 'ann_a0'), 'annotations not pulled');
    await reload(B);
    const cached = await B.ev(async (id) => { await window.__boot(); return window.__sha256(await window.__lib.getPdf(id)); }, a.paperId);
    assert(cached === a.sha && pdfGets() === 1, `after reload the PDF must come from IndexedDB (GETs=${pdfGets()})`);
    await B.ev(() => window.__waitSync());
    fake.clearLog();
    await B.ev(() => window.__lib.sync.syncNow());
    const refGets = fake.log.filter((e) => e.path.includes('/git/ref/'));
    assert(refGets.length === 1 && refGets[0].status === 304 && fake.log.length === 1, `unchanged pull: ${JSON.stringify(fake.log.map((e) => `${e.method} ${e.path} ${e.status}`))}`);
    return `library pulled (1 folder, 1 paper); PDF blob GETs: 0 before open → 1 after getPdf, still 1 after a 2nd getPdf and after reload (cached by sha in IndexedDB); sha256 identical; an unchanged pull costs one conditional GET answered 304`;
  });

  // ------------------------------------------------------------------ 4
  await test('concurrent edits merge: rename folder on A, add paper on B, both annotate the same paper (422 → re-pull → merge → retry)', async () => {
    fake.clearLog();
    const pause = fake.pauseNext({ method: 'PATCH', path: /\/git\/refs\/heads\// });
    const [, b] = await Promise.all([
      A.ev(async ({ folderId, paperId }) => {
        const lib = window.__lib;
        lib.renameFolder(folderId, '섬망 연구 (A에서 수정)');
        const ann = await lib.getPaperData(paperId, 'annotations');
        ann.items.push({ id: 'ann_A', anchor: { start: 100, end: 120 }, quote: 'from A', color: 'yellow', note: 'A 메모', createdAt: Date.now(), updatedAt: Date.now() });
        await lib.savePaperData(paperId, 'annotations', ann);
        await lib.whenSaved();
      }, a),
      B.ev(async ({ paperId }) => {
        const lib = window.__lib;
        const bytes = await window.__fixture('kiekkas2012');
        const p = await lib.addPaper(bytes, { fileName: 'kiekkas2012.pdf', meta: { title: 'Kiekkas 2012' } });
        const ann = await lib.getPaperData(paperId, 'annotations');
        ann.items.push({ id: 'ann_B', anchor: { start: 200, end: 230 }, quote: 'from B', color: 'blue', note: 'B 메모', createdAt: Date.now(), updatedAt: Date.now() });
        await lib.savePaperData(paperId, 'annotations', ann);
        await lib.whenSaved();
        return { paperId: p.id };
      }, a),
    ]);
    bPaper = b.paperId;
    // Whichever device's PATCH arrives first is held; the other one lands; then the held one hits 422.
    const syncs = [A.ev(() => window.__lib.sync.syncNow()), B.ev(() => window.__lib.sync.syncNow())];
    await pause.hit;
    await waitFor(() => patches(200).length >= 1, 15000, 'the other device to push');
    pause.release();
    await Promise.all(syncs);
    await A.ev(() => window.__waitSync());
    await B.ev(() => window.__waitSync());
    for (const d of [A, B]) {
      await d.ev(() => window.__lib.sync.syncNow());
      await d.ev(() => window.__waitSync());
    }
    assert(patches(422).length >= 1, `expected a 422 non-fast-forward, PATCH log: ${JSON.stringify(patches().map((e) => e.status))}`);
    const view = (d) => d.ev(async (paperId) => ({ dump: window.__dump(), ann: (await window.__lib.getPaperData(paperId, 'annotations')).items.map((i) => i.id).sort() }), a.paperId);
    const [va, vb] = [await view(A), await view(B)];
    for (const [n, v] of [['A', va], ['B', vb]]) {
      assert(v.dump.folders.find((f) => f.id === a.folderId)?.name === '섬망 연구 (A에서 수정)', `${n}: rename lost ${JSON.stringify(v.dump.folders)}`);
      assert(v.dump.papers.map((p) => p.id).sort().join() === [a.paperId, bPaper].sort().join(), `${n}: papers ${JSON.stringify(v.dump.papers)}`);
      assert(v.ann.join() === 'ann_A,ann_B,ann_a0', `${n}: annotations ${v.ann}`);
    }
    const repoAnn = repoJson(`papers/${a.paperId}/annotations.json`).items.map((i) => i.id).sort();
    assert(repoAnn.join() === 'ann_A,ann_B,ann_a0', `repo annotations ${repoAnn}`);
    return `PATCH statuses ${JSON.stringify(patches().map((e) => e.status))}; both devices: folder renamed, papers=[Lu 2025, Kiekkas 2012], annotations=[${va.ann}]; repo annotations.json=[${repoAnn}]`;
  });

  // ------------------------------------------------------------------ 5
  await test('tombstoned deletes propagate (paper + folder; folder contents move to parent)', async () => {
    const sub = await A.ev(({ folderId, paperId }) => {
      const s = window.__lib.createFolder('하위 폴더', folderId);
      window.__lib.movePaper(paperId, s.id);
      return s.id;
    }, a);
    await A.ev(() => window.__lib.flush());
    await A.ev(() => window.__waitSync());
    await B.ev(() => window.__lib.sync.syncNow());
    const mid = await B.ev(() => window.__dump());
    assert(mid.papers.find((p) => p.id === a.paperId)?.folderId === sub, 'B should see the paper in the subfolder');
    const bFilesBefore = Object.keys(await B.ev(() => window.__localFiles())).filter((p) => p.startsWith(`papers/${bPaper}/`));

    await A.ev(({ sub: s, bPaper: id }) => { window.__lib.deleteFolder(s); window.__lib.deletePaper(id); }, { sub, bPaper });
    await A.ev(() => new Promise((r) => setTimeout(r, 300)));
    await A.ev(() => window.__lib.flush());
    await A.ev(() => window.__waitSync());
    await B.ev(() => window.__lib.sync.syncNow());
    await B.ev(() => window.__waitSync());

    const dB = await B.ev(() => window.__dump());
    assert(!dB.papers.some((p) => p.id === bPaper), 'deleted paper still visible on B');
    assert(!dB.folders.some((f) => f.id === sub), 'deleted folder still visible on B');
    assert(dB.papers.find((p) => p.id === a.paperId)?.folderId === a.folderId, 'paper should move up to the parent folder');
    const tree = [...fake.files(OWNER, REPO).keys()];
    assert(!tree.some((p) => p.startsWith(`papers/${bPaper}/`)), `repo still has files of the deleted paper: ${tree}`);
    const lib = repoJson('library.json');
    assert(lib.papers.find((p) => p.id === bPaper)?.deleted === true && lib.folders.find((f) => f.id === sub)?.deleted === true, 'tombstones missing in library.json');
    const bFilesAfter = Object.keys(await B.ev(() => window.__localFiles())).filter((p) => p.startsWith(`papers/${bPaper}/`));
    assert(bFilesBefore.length > 0 && bFilesAfter.length === 0, `B local files before=${bFilesBefore.length} after=${bFilesAfter.length}`);
    const last = fake.commits(OWNER, REPO)[0];
    return `commit "${last.message}" deleted [${last.deleted.join(', ')}]; library.json keeps tombstones (paper+folder deleted:true); on B the paper/folder are gone, its ${bFilesBefore.length} local files removed, Lu 2025 moved to the parent folder`;
  });

  // ------------------------------------------------------------------ 6
  await test('10 MB PDF round-trips byte-identical (A → GitHub → B)', async () => {
    const big = await A.ev(async () => {
      const bytes = window.__makePdf(10 * 1024 * 1024, 42);
      const p = await window.__lib.addPaper(bytes, { fileName: 'big.pdf', meta: { title: '10MB synthetic' } });
      await window.__lib.flush();
      return { id: p.id, sha: await window.__sha256(bytes), size: bytes.byteLength };
    });
    await A.ev(() => window.__waitSync({ timeout: 60000 }));
    const repoBytes = fake.readFile(OWNER, REPO, `papers/${big.id}/paper.pdf`);
    assert(repoBytes.length === big.size && sha256(repoBytes) === big.sha, 'repo copy differs');
    await B.ev(() => window.__lib.sync.syncNow());
    const t0 = Date.now();
    const got = await B.ev(async (id) => {
      const pdf = await window.__lib.getPdf(id);
      return { sha: await window.__sha256(pdf), size: pdf.byteLength };
    }, big.id);
    assert(got.sha === big.sha && got.size === big.size, `B got ${got.size} B sha ${got.sha}`);
    return `${big.size} bytes; sha256 ${big.sha.slice(0, 16)}… identical on A, in the repo blob and on B (download+verify ${Date.now() - t0} ms)`;
  });

  // ------------------------------------------------------------------ 7
  await test('bad token → status "error" with a Korean message, no retry storm, local writes still work', async () => {
    const C = await device('C');
    fake.clearLog();
    await C.ev((gh) => window.__boot({ github: gh }), { ...GH, token: 'ghp_wrong_token' });
    const st = await C.ev(() => window.__waitSync({ state: 'error', pending: null }));
    assert(/[가-힣]/.test(st.message) && /토큰/.test(st.message), st.message);
    const fromC = () => fake.log.filter((e) => e.token === 'ghp_wrong_token');
    const n1 = fromC().length;
    await C.ev(() => { window.__lib.createFolder('오프라인 폴더'); return window.__lib.whenSaved(); });
    await C.page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await sleep(6500);
    const n2 = fromC().length;
    const st2 = await C.ev(() => window.__lib.sync.status);
    assert(n1 === 1 && fromC()[0].status === 401, `first request: ${JSON.stringify(fromC())}`);
    assert(n2 === n1 && st2.state === 'error' && st2.pending === 1, `requests ${n1}→${n2}, status ${JSON.stringify(st2)}`);
    await C.ctx.close();
    return `message: “${st.message}”; ${n1} request (GET repo → 401), none in the next 6.5 s despite a local write and a focus event; local change kept (pending=1)`;
  });

  // ------------------------------------------------------------------ 8
  await test('server down → "offline", then automatic recovery when it is back', async () => {
    fake.setDown(true);
    await A.ev(() => { window.__events.status.length = 0; });
    await A.ev((paperId) => window.__lib.updatePaper(paperId, { starred: true }), a.paperId);
    const off = await A.ev(() => window.__waitSync({ state: 'offline', pending: null, timeout: 15000 }));
    assert(off.pending >= 1 && /[가-힣]/.test(off.message), JSON.stringify(off));
    await sleep(1000);
    fake.setDown(false);
    const t0 = Date.now();
    const st = await A.ev(() => window.__waitSync({ timeout: 40000 }));
    const recoveredMs = Date.now() - t0;
    const lib = repoJson('library.json');
    assert(lib.papers.find((p) => p.id === a.paperId)?.starred === true, 'change did not reach the repo');
    const states = await A.ev(() => window.__events.status.map((s) => s.state).filter((s, i, arr) => s !== arr[i - 1]));
    assert(states.includes('offline') && states.at(-1) === 'idle' && st.pending === 0, states.join('→'));
    return `states ${states.join(' → ')}; offline message “${off.message}”, pending ${off.pending}; recovered ${recoveredMs} ms after the server came back (scheduled retry), change pushed`;
  });

  // ------------------------------------------------------------------ 9
  await test('pending writes are flushed when the page is hidden, and survive an immediate reload', async () => {
    await A.ev(() => window.__waitSync());
    fake.clearLog();
    const t = await A.ev((folderId) => {
      window.__lib.renameFolder(folderId, '숨기기 직전 이름');
      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
      return Date.now();
    }, a.folderId);
    await waitFor(() => patches(200).length >= 1, 2500, 'a push right after hiding (debounce is 3 s)');
    const pushedAfter = fake.log.find((e) => e.method === 'PATCH' && e.status === 200).at - t;
    await A.ev(() => { delete document.visibilityState; });
    await A.ev(() => window.__waitSync());
    assert(repoJson('library.json').folders.find((f) => f.id === a.folderId)?.name === '숨기기 직전 이름', 'hidden flush did not push');

    // Rename and reload in the same task: the change must not be lost (IndexedDB write, or the
    // pagehide journal), and it is pushed after the reload.
    await A.page.evaluate((folderId) => {
      window.__lib.renameFolder(folderId, '새로고침 직전 이름');
      location.reload();
    }, a.folderId).catch(() => {});
    await A.page.waitForFunction(() => window.__harnessReady);
    const journal = await A.ev(() => Boolean(localStorage.getItem('pr.store.libraryJournal.v1')));
    const name = await A.ev(async (folderId) => { await window.__boot(); return window.__lib.getFolder(folderId)?.name; }, a.folderId);
    assert(name === '새로고침 직전 이름', `after reload the folder is “${name}”`);
    const journalLeft = await A.ev(() => Boolean(localStorage.getItem('pr.store.libraryJournal.v1')));
    await A.ev(() => window.__waitSync());
    assert(repoJson('library.json').folders.find((f) => f.id === a.folderId)?.name === '새로고침 직전 이름', 'not pushed after reload');
    return `hidden → commit landed ${pushedAfter} ms after the change (debounce would wait 3000 ms); rename + immediate reload → kept locally (pagehide journal ${journal ? 'written and replayed' : 'not needed: IndexedDB write had completed'}, journal left after boot: ${journalLeft}) and pushed after restart`;
  });

  // ----------------------------------------------------------------- 10
  await test('real app (index.html) against the fake via route forwarding: library pulled, PDF opens, connection test', async () => {
    const D = await device('D', { harness: false });
    await routeGitHubToFake(D.ctx, fake.url);
    const settingsSeed = { github: { owner: OWNER, repo: REPO, branch: 'main', token: TOKEN } };
    await D.page.addInitScript((s) => {
      if (!localStorage.getItem('pr.settings.v1')) localStorage.setItem('pr.settings.v1', JSON.stringify(s));
    }, settingsSeed);
    const optionsSeen = [];
    D.page.on('request', (r) => { if (r.method() === 'OPTIONS') optionsSeen.push(r.url()); });
    fake.clearLog();
    await D.page.goto(`${BASE}/index.html?mock=1#/`);
    await D.page.waitForFunction(() => document.querySelectorAll('.paper-row').length >= 2, null, { timeout: 30000 });
    await D.page.waitForFunction(() => /동기화 완료/.test(document.querySelector('.lib-sync')?.textContent || ''), null, { timeout: 30000 });
    const rows = await D.page.$$eval('.paper-row', (els) => els.map((e) => e.textContent.replace(/\s+/g, ' ').slice(0, 60)));
    await D.page.screenshot({ path: `${OUT}/app-library.png` });

    await D.page.goto(`${BASE}/index.html?mock=1#/paper/${encodeURIComponent(a.paperId)}`);
    await D.page.waitForFunction(() => document.querySelector('.tp-s[data-sid], .tp-empty, .message-screen'), null, { timeout: 60000 });
    await D.page.waitForTimeout(800);
    const readerError = await D.page.$('.message-screen');
    await D.page.screenshot({ path: `${OUT}/app-reader.png` });
    assert(!readerError, 'reader showed an error screen');
    const pdfSha = fake.files(OWNER, REPO).get(`papers/${a.paperId}/paper.pdf`).sha;
    assert(fake.log.some((e) => e.path.endsWith(`/git/blobs/${pdfSha}`) && e.status === 200), 'PDF was not fetched from the fake');

    await D.page.goto(`${BASE}/index.html?mock=1#/settings`);
    await D.page.getByRole('button', { name: '연결 테스트' }).click();
    await D.page.waitForFunction(() => [...document.querySelectorAll('.test-result')].some((e) => /연결되었습니다|저장소/.test(e.textContent)), null, { timeout: 15000 });
    await D.page.waitForTimeout(400);
    const testText = await D.page.evaluate(() => [...document.querySelectorAll('.test-result')].map((e) => e.textContent.trim()).filter(Boolean).join(' | '));
    await D.page.screenshot({ path: `${OUT}/app-settings.png`, fullPage: false });
    const gh = external.filter((u) => u.includes('api.github.com'));
    assert(/연결되었습니다/.test(testText), `connection test: ${testText}`);
    assert(gh.length === 0, `requests escaped to the real api.github.com: ${gh.slice(0, 3)}`);
    await D.ctx.close();
    return `rows=${JSON.stringify(rows)}; reader opened Lu 2025 with the PDF fetched from the fake; settings test: “${testText.slice(0, 120)}”; OPTIONS preflights seen by the page: ${optionsSeen.length} (fulfilled by Playwright/fake), 0 requests to the real GitHub`;
  });
  // ----------------------------------------------------------------- 11
  await test('addPaper rejects files over LIMITS.maxPdfBytes and non-PDF data (Korean errors, nothing stored)', async () => {
    const r = await A.ev(async () => {
      const { LIMITS } = await import('/js/core/config.js');
      const before = { papers: window.__lib.papers.length, pending: window.__lib.sync.status.pending };
      const errs = {};
      try { await window.__lib.addPaper(new Uint8Array(LIMITS.maxPdfBytes + 1), { fileName: 'huge.pdf' }); } catch (e) { errs.big = e.message; }
      try { await window.__lib.addPaper(new TextEncoder().encode('hello, not a pdf'), { fileName: 'x.pdf' }); } catch (e) { errs.notPdf = e.message; }
      await window.__lib.whenSaved();
      return { errs, before, after: { papers: window.__lib.papers.length, pending: window.__lib.sync.status.pending } };
    });
    assert(/너무 큽니다/.test(r.errs.big || '') && /PDF 파일이 아닙니다/.test(r.errs.notPdf || ''), JSON.stringify(r.errs));
    assert(r.after.papers === r.before.papers && r.after.pending === r.before.pending, JSON.stringify(r));
    return `“${r.errs.big}” · “${r.errs.notPdf}”`;
  });

  // ----------------------------------------------------------------- 12
  await test('two tabs on one device: simultaneous edits from a stale tab are merged, the other tab updates live', async () => {
    const T = await device('T');
    await T.ev((gh) => window.__boot({ github: gh }), GH);
    await T.ev(() => window.__waitSync());
    const tab2 = await T.ctx.newPage();
    tab2.on('pageerror', (e) => pageErrors.push(`T2: ${e.message}`));
    await tab2.goto(H);
    await tab2.waitForFunction(() => window.__harnessReady);
    await tab2.evaluate(() => window.__boot());
    await tab2.evaluate(() => window.__waitSync());
    await Promise.all([
      T.ev(() => { window.__lib.createFolder('탭1 폴더'); return window.__lib.whenSaved(); }),
      tab2.evaluate(() => { window.__lib.createFolder('탭2 폴더'); return window.__lib.whenSaved(); }),
    ]);
    const names = (pg) => pg.evaluate(() => window.__lib.folders.map((f) => f.name).sort());
    await waitFor(async () => {
      const [n1, n2] = [await names(T.page), await names(tab2)];
      return n1.includes('탭1 폴더') && n1.includes('탭2 폴더') && n2.includes('탭1 폴더') && n2.includes('탭2 폴더');
    }, 5000, 'both tabs to show both folders');
    await T.ev(() => window.__lib.flush());
    await T.ev(() => window.__waitSync());
    await tab2.evaluate(() => window.__waitSync());
    const repoNames = repoJson('library.json').folders.filter((f) => !f.deleted).map((f) => f.name);
    assert(repoNames.includes('탭1 폴더') && repoNames.includes('탭2 폴더'), `repo folders: ${repoNames}`);
    const remoteEvents = await T.ev(() => window.__events.remote.filter((e) => e.origin === 'tab').length);
    await T.ctx.close();
    return `both tabs list [${await Promise.resolve(repoNames.join(', '))}]; tab-to-tab notifications received: ${remoteEvents}`;
  });

  // ----------------------------------------------------------------- 13
  await test('public repo: sync refuses to upload (status error, Korean warning), repo untouched', async () => {
    fake.createRepo(OWNER, 'public-papers', { private: false, files: { 'README.md': 'public' } });
    const P = await device('P');
    await P.ev((gh) => window.__boot({ github: gh }), { ...GH, repo: 'public-papers' });
    await P.ev(() => { window.__lib.createFolder('비밀 폴더'); return window.__lib.whenSaved(); });
    const st = await P.ev(() => window.__waitSync({ state: 'error', pending: null }));
    await sleep(3500);
    const commits = fake.commits(OWNER, 'public-papers');
    assert(/공개/.test(st.message) && commits.length === 1, `${st.message} · commits ${commits.length}`);
    await P.ctx.close();
    return `“${st.message}”; repo still has only its initial commit`;
  });

  // ----------------------------------------------------------------- 14
  await test('existing repo, missing branch: branch created with README.md + data in one root commit', async () => {
    fake.createRepo(OWNER, 'shared', { private: true, files: { 'README.md': 'someone else' } });
    const E = await device('E');
    await E.ev(() => window.__boot());
    await E.ev(() => { window.__lib.createFolder('브랜치 테스트'); return window.__lib.whenSaved(); });
    await E.ev((gh) => window.__configure(gh), { ...GH, repo: 'shared', branch: 'papers' });
    await E.ev(() => window.__waitSync());
    const commits = fake.commits(OWNER, 'shared', 'papers');
    const main = fake.commits(OWNER, 'shared', 'main');
    assert(commits.length === 1 && commits[0].parents.length === 0, JSON.stringify(commits));
    assert(commits[0].changed.join() === 'README.md,library.json', commits[0].changed.join());
    assert(main.length === 1, 'main must be untouched');
    await E.ctx.close();
    return `refs/heads/papers created (POST /git/refs) with [${commits[0].changed.join(', ')}]; main untouched`;
  });
  // ----------------------------------------------------------------- 15
  await test('large backlog (3 × 18 MB offline) is pushed in size-bounded commits, PDFs before library.json', async () => {
    fake.createRepo(OWNER, 'bulk', { private: true });
    const F = await device('F');
    await F.ev(() => window.__boot());
    const made = await F.ev(async () => {
      const out = [];
      for (let i = 0; i < 3; i++) {
        const bytes = window.__makePdf(18 * 1024 * 1024, 100 + i);
        const p = await window.__lib.addPaper(bytes, { fileName: `bulk${i}.pdf` });
        out.push({ id: p.id, sha: await window.__sha256(bytes) });
      }
      await window.__lib.whenSaved();
      return out;
    });
    await F.ev((gh) => window.__configure(gh), { ...GH, repo: 'bulk' });
    await F.ev(() => window.__waitSync({ timeout: 120000 }));
    const commits = fake.commits(OWNER, 'bulk').reverse().map((c) => c.changed);
    assert(commits.length === 3 && commits[0].join() === 'README.md', JSON.stringify(commits));
    assert(commits[1].length === 3 && commits[1].every((p) => p.endsWith('paper.pdf')), `PDF commit: ${commits[1]}`);
    assert(commits[2].join() === 'library.json', `last commit: ${commits[2]}`);
    for (const m of made) assert(sha256(fake.readFile(OWNER, 'bulk', `papers/${m.id}/paper.pdf`)) === m.sha, 'bulk PDF differs');
    await F.ctx.close();
    return `commits oldest→newest: ${commits.map((c) => `[${c.map((p) => p.replace(/^papers\/[^/]+\//, '…/')).join(', ')}]`).join(' → ')}; all 3 PDFs byte-identical`;
  });
  // ----------------------------------------------------------------- 16
  await test('switching to another repo re-uploads this device\'s library, including PDFs only cached from the old repo', async () => {
    fake.createRepo(OWNER, 'second', { private: true });
    const before = await B.ev(() => window.__dump());
    // Regression (repo-switch-reuploads-all-local-data): without the user's consent nothing is uploaded.
    const info = await B.ev((gh) => window.__lib.syncTargetChange(gh), { ...GH, repo: 'second' });
    assert(info && info.localFiles > 0 && info.papers === before.papers.length && /second#main$/.test(info.to), `targetChange: ${JSON.stringify(info)}`);
    await B.ev((gh) => window.__configure(gh), { ...GH, repo: 'second' });
    const refused = await B.ev(() => window.__waitSync({ state: 'error', pending: null }));
    assert(/저장소가 바뀌었/.test(refused.message) && fake.files(OWNER, 'second').size === 0, `without consent: ${JSON.stringify(refused)}, files=${fake.files(OWNER, 'second').size}`);
    await B.ev((gh) => window.__configure(gh), { ...GH, repo: 'second', carryOver: info.to });
    await B.ev(() => window.__waitSync({ timeout: 60000 }));
    const files = [...fake.files(OWNER, 'second').keys()];
    const lib = repoJson('library.json');
    const second = JSON.parse(fake.readFile(OWNER, 'second', 'library.json').toString('utf8'));
    const livePapers = second.papers.filter((p) => !p.deleted).map((p) => p.id).sort();
    for (const p of before.papers) {
      assert(files.includes(`papers/${p.id}/paper.pdf`), `PDF of ${p.title} not carried over: ${files}`);
      assert(sha256(fake.readFile(OWNER, 'second', `papers/${p.id}/paper.pdf`)) === sha256(fake.readFile(OWNER, REPO, `papers/${p.id}/paper.pdf`)), 'PDF differs');
    }
    assert(livePapers.join() === before.papers.map((p) => p.id).sort().join(), `papers ${livePapers}`);
    assert(lib.papers.length >= livePapers.length, 'old repo untouched');
    return `without consent: “${refused.message}” and 0 files uploaded; with consent the second repo has ${files.length} files: [${files.map((p) => p.replace(/^papers\/[^/]+\//, '…/')).join(', ')}]; ${before.papers.length} PDFs byte-identical to the old repo`;
  });

  // ----------------------------------------------------------------- 17
  await test('regression library-tie-reverts-remote-fields: a rename on one device survives the other device touching the paper before its pull', async () => {
    fake.createRepo(OWNER, 'tie', { private: true });
    const TIE = { ...GH, repo: 'tie' };
    const H = await device('H');
    const I = await device('I');
    await H.ev((gh) => window.__boot({ github: gh }), TIE);
    const pid = await H.ev(async () => {
      const p = await window.__lib.addPaper(window.__makePdf(30_000, 41), { fileName: 'tie.pdf', meta: { title: 'Old title' } });
      await window.__lib.flush();
      return p.id;
    });
    await H.ev(() => window.__waitSync());
    tie = { H, I, pid };
    await I.ev((gh) => window.__boot({ github: gh }), TIE);
    await I.ev(() => window.__waitSync());
    // Laptop (H) renames and pushes; the desktop (I) opens the paper (lastOpenedAt) before its pull lands.
    await H.ev((id) => { window.__lib.updatePaper(id, { title: 'New title' }); return window.__lib.flush(); }, pid);
    await H.ev(() => window.__waitSync());
    await I.ev((id) => { window.__lib.updatePaper(id, { lastOpenedAt: Date.now() + 5 }); return window.__lib.whenSaved(); }, pid);
    await I.ev(() => window.__lib.sync.syncNow());
    await I.ev(() => window.__waitSync());
    const afterPull = await I.ev((id) => window.__lib.getPaper(id).title, pid);
    // Any later write on I (here: a star and a new folder) must not push the stale title back.
    await I.ev((id) => { window.__lib.updatePaper(id, { starred: true }); window.__lib.createFolder('나중 폴더'); return window.__lib.flush(); }, pid);
    await I.ev(() => window.__waitSync());
    await H.ev(() => window.__lib.sync.syncNow());
    await H.ev(() => window.__waitSync());
    const repoPaper = JSON.parse(fake.readFile(OWNER, 'tie', 'library.json').toString('utf8')).papers.find((p) => p.id === pid);
    const onH = await H.ev((id) => window.__lib.getPaper(id), pid);
    const onI = await I.ev((id) => window.__lib.getPaper(id), pid);
    assert(afterPull === 'New title', `I still shows ${afterPull} after its pull`);
    assert(repoPaper.title === 'New title' && repoPaper.starred === true && repoPaper.lastOpenedAt, `repo: ${JSON.stringify(repoPaper)}`);
    assert(onH.title === 'New title' && onH.starred && onI.title === 'New title' && onI.lastOpenedAt === onH.lastOpenedAt, `devices: ${JSON.stringify({ onH, onI })}`);
    return `I after pull: “${afterPull}”; repo after I's next write: title “${repoPaper.title}”, starred=${repoPaper.starred}, lastOpenedAt kept`;
  });

  // ----------------------------------------------------------------- 18
  await test('regression blind-push-stale-base: a data file written after a failed download is merged with the remote copy, not pushed over it', async () => {
    const { H, I, pid } = tie;
    await H.ev(async (id) => {
      await window.__lib.savePaperData(id, 'translation', { version: 1, targetLang: 'ko', segVersion: 1, items: { 'p1-0': { h: 'h0', t: '첫 문장', m: 'mock' }, 'p1-1': { h: 'h1', t: '둘째 문장', m: 'mock' } } });
      await window.__lib.flush();
    }, pid);
    await H.ev(() => window.__waitSync());
    await I.ev(() => window.__lib.sync.syncNow());
    await I.ev(() => window.__waitSync());
    // I has never downloaded translation.json; GitHub fails the download (3 × 500 → the client gives up) …
    fake.failNext({ method: 'GET', path: /\/git\/blobs\//, status: 500, count: 3 });
    const readErr = await I.ev(async (id) => { try { await window.__lib.getPaperData(id, 'translation'); return null; } catch (err) { return err.message; } }, pid);
    // … so the reader starts empty and saves only its own new sentence.
    await I.ev(async (id) => {
      await window.__lib.savePaperData(id, 'translation', { version: 1, targetLang: 'ko', segVersion: 1, items: { 'p2-0': { h: 'h2', t: 'I에서 번역', m: 'mock' } } });
    }, pid);
    await I.ev(() => window.__lib.sync.syncNow());
    await I.ev(() => window.__waitSync());
    const repoItems = Object.keys(JSON.parse(fake.readFile(OWNER, 'tie', `papers/${pid}/translation.json`).toString('utf8')).items).sort();
    const local = Object.keys((await I.ev((id) => window.__lib.getPaperData(id, 'translation'), pid)).items).sort();
    assert(readErr && /[가-힣]/.test(readErr), `download should have failed: ${readErr}`);
    assert(repoItems.join() === 'p1-0,p1-1,p2-0', `repo translation.json items: ${repoItems}`);
    assert(local.join() === 'p1-0,p1-1,p2-0', `I local items: ${local}`);
    return `download failed (“${readErr.slice(0, 60)}…”); after I's push the repo has [${repoItems}] (H's sentences kept)`;
  });

  // ----------------------------------------------------------------- 19
  await test('regression stale-ai-snapshot-overwrites: chat messages appended on two devices before syncing both survive', async () => {
    const { H, I, pid } = tie;
    const append = (d, msg) => d.ev(({ id, m }) => window.__lib.updatePaperData(id, 'ai', (ai) => ({ ...ai, chat: [...(ai.chat || []), m] })), { id: pid, m: msg });
    await append(H, { id: 'mH', role: 'user', content: 'H 질문', ts: Date.now() });
    await append(I, { id: 'mI', role: 'user', content: 'I 질문', ts: Date.now() + 1 });
    await H.ev(() => window.__lib.flush());
    await H.ev(() => window.__waitSync());
    await I.ev(() => window.__lib.flush());
    await I.ev(() => window.__waitSync());
    await H.ev(() => window.__lib.sync.syncNow());
    const repoChat = JSON.parse(fake.readFile(OWNER, 'tie', `papers/${pid}/ai.json`).toString('utf8')).chat.map((m) => m.id);
    const onH = (await H.ev((id) => window.__lib.getPaperData(id, 'ai'), pid)).chat.map((m) => m.id);
    assert(repoChat.join() === 'mH,mI' && onH.join() === 'mH,mI', `repo chat ${repoChat}, H chat ${onH}`);
    return `repo ai.json chat=[${repoChat}], H=[${onH}]`;
  });

  // ----------------------------------------------------------------- 20
  await test('regression one-bad-file-blocks-sync: a PDF GitHub refuses (413) is kept locally and named; everything else still syncs', async () => {
    const { H } = tie;
    await H.ev(() => { window.__events.errors.length = 0; });
    const ids = await H.ev(async () => {
      const big = await window.__lib.addPaper(window.__makePdf(60_000, 51), { fileName: 'huge-scan.pdf', meta: { title: 'Huge scan' } });
      await window.__lib.whenSaved();
      return { big: big.id };
    });
    fake.failNext({ method: 'POST', path: /\/git\/blobs$/, status: 413, count: 1, minBodyBytes: 50_000 }); // the PDF, not library.json
    await H.ev(() => window.__lib.flush());
    const st = await H.ev(() => window.__waitSync({ timeout: 20000 }));
    const errors = await H.ev(() => window.__events.errors);
    const repoLib = JSON.parse(fake.readFile(OWNER, 'tie', 'library.json').toString('utf8'));
    const pdfInRepo = fake.files(OWNER, 'tie').has(`papers/${ids.big}/paper.pdf`);
    assert(st.state === 'idle' && st.pending === 0 && st.rejected === 1, `status: ${JSON.stringify(st)}`);
    assert(repoLib.papers.some((p) => p.id === ids.big) && !pdfInRepo, `library.json synced=${repoLib.papers.some((p) => p.id === ids.big)}, pdf in repo=${pdfInRepo}`);
    assert(errors.some((m) => /Huge scan/.test(m) && /너무 커서/.test(m)), `error event: ${JSON.stringify(errors)}`);
    const local = await H.ev((id) => window.__lib.getPdf(id).then((b) => b.byteLength), ids.big);
    assert(local === 60_000, 'the refused PDF must stay readable locally');
    // A manual sync retries it (here GitHub accepts it now).
    await H.ev(() => window.__lib.sync.syncNow());
    const st2 = await H.ev(() => window.__waitSync());
    assert(st2.rejected === 0 && fake.files(OWNER, 'tie').has(`papers/${ids.big}/paper.pdf`), `retry: ${JSON.stringify(st2)}`);
    return `status after the 413: idle, pending 0, rejected 1; library.json pushed; message: “${errors.find((m) => /Huge scan/.test(m))}”; 지금 동기화 retried and uploaded it`;
  });
} finally {
  await browser.close();
  await fake.close();
  if (server) server.kill();
}

const out = { results, pageErrors, consoleErrors: consoleErrors.slice(0, 50), external };
console.log(`console errors (expected: failed loads during the 401/409/422/offline scenarios):\n  ${consoleErrors.slice(0, 20).join('\n  ')}`);
console.log('blocked external requests:', external);
writeFileSync(`${OUT}/results.json`, JSON.stringify(out, null, 2));
const failed = results.filter((r) => r.result !== 'pass').length;
console.log(`\nstore browser: ${results.length - failed}/${results.length} passed · page errors: ${pageErrors.length} · console errors: ${consoleErrors.length} · blocked external: ${external.length}`);
if (pageErrors.length) console.log(pageErrors.join('\n'));
process.exitCode = failed || pageErrors.length ? 1 : 0;
