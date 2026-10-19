// Store module — browser tests for each invite code's own library (lib 'mine', the repo folder codes/<libraryId>/)
// next to 전체 공용 서재 and 내 서재, in Edge (real IndexedDB + js/store/*), plus a WebKit (Safari engine) device.
// 내 서재 syncs to a personal repo on the in-process fake GitHub; both relay libraries go through the fake relay in
// code-library mode (tests/store/fake-relay.mjs { codeLibraries: true }: allowlist under codes/<libraryId>/, people/
// isolation, codes/ hidden from 전체 공용 서재, per-library activity) to one team repo. Each browser context is one
// person/device. No external host is contacted.
//   node tests/store/run-code-libs.mjs [name filter]   (serves the repo with `python -m http.server 8241` if nothing listens)
// Results: C:/Users/dindoo/Projects/pr-tools/out/code-libs/store-browser.results.json
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, webkit } from 'file:///C:/Users/dindoo/Projects/pr-tools/node_modules/playwright/index.mjs';
import { startFakeGitHub } from './fake-github.mjs';
import { startFakeRelay } from './fake-relay.mjs';

const PORT = 8241;
const BASE = `http://127.0.0.1:${PORT}`;
const H = `${BASE}/tests/store/harness.html`;
const OUT = 'C:/Users/dindoo/Projects/pr-tools/out/code-libs';
const FIXTURES = 'C:/Users/dindoo/Projects/pr-fixtures';
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const TEAM = { owner: 'dindoopark', repo: 'paper-team-library', token: 'ghp_team_secret_for_tests' };
const MINE = { owner: 'me', repo: 'paper-library', token: 'ghp_owner_personal_token' };
const CODES = { X: 'PR-3333-CCCC', Y: 'PR-2222-BBBB' };
const NAMES = { X: '봄당', Y: '6기' };
const SYNC = { pushDelayMs: 200, pushMaxDelayMs: 1000, pullIntervalMs: 600_000, retryDelaysMs: [500, 1000, 2000] };

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
  try { return (await fetch(H)).ok; } catch { return false; }
}
let server = null;
if (!(await serverUp())) {
  server = spawn('python', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], { cwd: REPO_ROOT, stdio: 'ignore' });
  await waitFor(serverUp, 8000, 'python http.server');
}

const gh = await startFakeGitHub({ port: 0 });
gh.addToken(TEAM.token, { write: true });
gh.addToken(MINE.token, { write: true });
gh.createRepo(TEAM.owner, TEAM.repo, { private: true, files: { 'README.md': 'team' } });
gh.createRepo(MINE.owner, MINE.repo, { private: true, files: { 'README.md': 'mine' } });
const relay = await startFakeRelay({ github: gh, ...TEAM, codeLibraries: true, libName: '전체 공용 서재' });
const pid = Object.fromEntries(Object.entries(CODES).map(([k, code]) => [k, relay.addCode(code, NAMES[k])]));
const libId = { X: relay.libraryIdOf(CODES.X), Y: relay.libraryIdOf(CODES.Y) };
const repoFiles = () => [...gh.files(TEAM.owner, TEAM.repo).keys()].sort();
const repoJson = (path) => JSON.parse(gh.readFile(TEAM.owner, TEAM.repo, path).toString('utf8'));
const mineFiles = () => [...gh.files(MINE.owner, MINE.repo).keys()].sort();
const GH_MINE = { owner: MINE.owner, repo: MINE.repo, branch: 'main', token: MINE.token, apiBase: gh.url };
const strip = (s) => String(s).replaceAll(libId.X, '<libX>').replaceAll(libId.Y, '<libY>').replaceAll(pid.X, '<pX>').replaceAll(pid.Y, '<pY>');
const edge = await chromium.launch({ channel: 'msedge', args: ['--host-resolver-rules=MAP api.github.com 127.0.0.1, MAP *.github.com 127.0.0.1'] });
let safari = null;

async function device(name, browser = edge) {
  const ctx = await browser.newContext({ locale: 'ko-KR' });
  await ctx.route(/^https?:\/\/(?!127\.0\.0\.1[:/])/, (route) => { external.push(route.request().url()); return route.abort(); });
  await ctx.route('**/__fixture__/*.pdf', (route) => {
    const file = new URL(route.request().url()).pathname.split('/').pop();
    return route.fulfill({ path: `${FIXTURES}/${file}`, contentType: 'application/pdf' });
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => pageErrors.push(`${name}: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(`${name}: ${m.text()}`); });
  await page.goto(H);
  await page.waitForFunction(() => window.__harnessReady);
  return { name, ctx, page, ev: (fn, arg) => page.evaluate(fn, arg) };
}
/**
 * Open both relay libraries of `who` the way the app does: GET /shared, then openSharedLibrary per listed library.
 * Harness keys: 'code' = the code library (lib 'mine'), 'team' = 전체 공용 서재; 'mine' stays 내 서재 (window.__lib).
 */
async function openRelayLibs(d, who) {
  return d.ev(async ({ relayUrl, code, sync }) => {
    const info = await window.__sharedInfo(relayUrl, code);
    const out = { info };
    for (const l of info.libraries) {
      const key = l.id === 'mine' ? 'code' : l.id;
      out[key] = await window.__openShared({
        key, lib: l.id, libraryId: info.libraryId, personId: info.personId, name: info.name, label: l.name, relayUrl, code, syncOptions: sync,
      });
      await window.__L(key).sync.syncNow();
      await window.__waitLib(key);
    }
    return out;
  }, { relayUrl: relay.url, code: CODES[who], sync: SYNC });
}
const syncLib = async (d, key) => { await d.ev((k) => window.__L(k).sync.syncNow(), key); return d.ev((k) => window.__waitLib(k), key); };
const pushLib = async (d, key) => { await d.ev((k) => window.__L(k).flush(), key); return d.ev((k) => window.__waitLib(k), key); };
const activity = async (code, lib) => (await (await fetch(`${relay.url}/shared/${lib}/activity?limit=50`, { headers: { Authorization: `Bearer ${code}` } })).json()).items;

let X;
let X2;
let Y;
const ids = {};
const DB = {
  mine: (who) => `paper-reader-shared-mine-${libId[who]}-${pid[who]}`,
  team: (who) => `paper-reader-shared-team-${pid[who]}`,
};

try {
  await test('one page, three libraries: 내 서재 (paper-reader → personal repo), 봄당 서재 (its own database → codes/<libX>/ of the team repo) and 전체 공용 서재 (its own database → the repo root); keys stay library-relative; no lock, channel or tab event crosses libraries', async () => {
    X = await device('X');
    await X.ev(({ gh, sync }) => window.__boot({ github: gh, syncOptions: sync }), { gh: GH_MINE, sync: SYNC });
    const opened = await openRelayLibs(X, 'X');
    assert(opened.info.libraries.map((l) => l.id).join() === 'mine,team' && opened.code.label === '봄당 서재' && opened.code.rootPrefix === `codes/${libId.X}/`
      && opened.team.label === '전체 공용 서재' && opened.team.rootPrefix === '', JSON.stringify(opened));
    const made = await X.ev(async () => {
      const personal = window.__lib;
      const team = window.__L('team');
      const codeLib = window.__L('code');
      const pf = personal.createFolder('ICU');
      const pp = await personal.addPaper(await window.__fixture('lu2025'), { fileName: 'lu2025.pdf', folderId: pf.id, meta: { title: 'Lu 2025' } });
      await personal.savePaperData(pp.id, 'translation', { version: 1, targetLang: 'ko', segVersion: 1, items: { 'p1-0': { h: 'h0', t: '〔번역〕 내 서재' } } });
      await personal.savePaperData(pp.id, 'annotations', { version: 1, items: [{ id: 'mp', anchor: { start: 0, end: 2 }, quote: 'l', color: 'yellow', note: '내 서재 메모', createdAt: 1, updatedAt: 1 }] });
      const cf = codeLib.createFolder('봄당 폴더');
      const cp = await codeLib.addPaper(window.__makePdf(30_000, 11), { fileName: 'moral.pdf', folderId: cf.id, meta: { title: 'Moral Sensitivity' } });
      await codeLib.savePaperData(cp.id, 'annotations', { version: 1, items: [{ id: 'cx', anchor: { start: 0, end: 4 }, quote: 'm', color: 'green', note: '봄당 메모', createdAt: 1, updatedAt: 1 }] });
      await codeLib.savePaperData(cp.id, 'translation', { version: 1, targetLang: 'ko', segVersion: 1, items: { 'p1-0': { h: 'm0', t: '〔번역〕 봄당' } } });
      const tf = team.createFolder('공용 폴더');
      const tp = await team.addPaper(window.__makePdf(20_000, 12), { fileName: 'team.pdf', folderId: tf.id, meta: { title: '공용 논문' } });
      await Promise.all([personal.flush(), codeLib.flush(), team.flush()]);
      return { pf: pf.id, pp: pp.id, cf: cf.id, cp: cp.id, tf: tf.id, tp: tp.id };
    });
    Object.assign(ids, made);
    await X.ev(() => Promise.all([window.__waitSync(), window.__waitLib('team'), window.__waitLib('code')]));
    const state = await X.ev(async ({ mineDb, teamDb }) => ({
      dbs: await window.__idbNames(),
      personal: await window.__filesOf('paper-reader'),
      code: await window.__filesOf(mineDb),
      team: await window.__filesOf(teamDb),
      tabEvents: [window.__events.remote, window.__eventsBy.code.remote, window.__eventsBy.team.remote].map((list) => list.filter((e) => e.origin === 'tab').length),
      codeRemotePaths: window.__eventsBy.code.remote.flatMap((e) => e.paths),
    }), { mineDb: DB.mine('X'), teamDb: DB.team('X') });
    assert(['paper-reader', DB.mine('X'), DB.team('X')].every((n) => state.dbs.includes(n)), `databases: ${strip(state.dbs)}`);
    assert(state.code.every((k) => !k.startsWith('codes/')) && state.code.includes('library.json') && state.code.includes(`people/${pid.X}/papers/${ids.cp}/annotations.json`), `code library keys: ${strip(state.code)}`);
    assert(!state.code.some((k) => k.includes(ids.tp) || k.includes(ids.pp)) && !state.team.some((k) => k.includes(ids.cp) || k.includes(ids.pp)) && !state.personal.some((k) => k.includes(ids.cp) || k.includes(ids.tp)), 'each database holds only its own library');
    assert(state.tabEvents.every((n) => n === 0) && state.codeRemotePaths.every((p) => !p.startsWith('codes/')), `tab events ${state.tabEvents}; paths ${state.codeRemotePaths}`);
    const files = repoFiles();
    const code = files.filter((p) => p.startsWith(`codes/${libId.X}/`)).map((p) => p.slice(`codes/${libId.X}/`.length));
    assert(code.join() === ['library.json', `papers/${ids.cp}/paper.pdf`, `papers/${ids.cp}/translation.json`, `people/${pid.X}/papers/${ids.cp}/annotations.json`].join(), `code folder: ${strip(code)}`);
    assert(files.includes(`papers/${ids.tp}/paper.pdf`) && files.includes('library.json') && !files.some((p) => p.includes(ids.pp)), `team root: ${strip(files)}`);
    assert(!mineFiles().some((p) => p.startsWith('codes/') || p.startsWith('people/')) && mineFiles().includes(`papers/${ids.pp}/annotations.json`), `personal repo: ${mineFiles()}`);
    assert(repoJson(`codes/${libId.X}/library.json`).papers[0].addedBy === '봄당' && !relay.log.some((e) => e.status === 403), 'addedBy / no refusals');
    return `IndexedDB [${strip(state.dbs.join(', '))}]; code library repo folder [${strip(code.join(', ')).replaceAll(ids.cp, '<id>')}]; team root has 공용 논문 only; 0 cross-library tab events`;
  });

  await test('copy in the page across all three libraries: 내 서재 → 봄당 서재 (folder), 봄당 서재 → 전체 공용 서재, 전체 공용 서재 → 봄당 서재 (same PDF: no upload, moved into the chosen folder), 봄당 서재 → 내 서재 — never notes', async () => {
    relay.clearLog();
    const res = await X.ev(async ({ pf, cp, cf }) => {
      const personal = window.__lib;
      const codeLib = window.__L('code');
      const team = window.__L('team');
      const r1 = await personal.copyFolderTo(codeLib, pf);
      await codeLib.flush();
      const r2 = await codeLib.copyPaperTo(team, cp);
      await team.flush();
      const r3 = await team.copyPaperTo(codeLib, r2.paper.id, { folderId: r1.folder.id });
      await codeLib.flush();
      const r4 = await codeLib.copyPaperTo(personal, cp, { folderId: null });
      await personal.flush();
      let refused = '';
      try { await codeLib.copyPaperTo(codeLib, cp); } catch (err) { refused = err.message; }
      return {
        r1: { folder: r1.folder.id, papers: r1.papers }, r2: { id: r2.paper.id, copied: r2.copied }, r3: { id: r3.paper.id, existing: r3.existing, moved: r3.moved, copied: r3.copied },
        r4: { id: r4.paper.id, copied: r4.copied }, refused, cf,
        codeFolderOf: codeLib.getPaper(cp)?.folderId,
        luInCode: codeLib.papers.find((p) => p.title === 'Lu 2025')?.id,
      };
    }, { pf: ids.pf, cp: ids.cp, cf: ids.cf });
    await X.ev(() => Promise.all([window.__waitSync(), window.__waitLib('team')]));
    await syncLib(X, 'team');
    await waitFor(() => repoFiles().includes(`codes/${libId.X}/papers/${res.luInCode}/paper.pdf`), 10000, 'Lu copy in the code folder');
    assert(res.r1.papers.copied === 1 && res.r2.copied && res.r3.existing && res.r3.moved && !res.r3.copied && res.r3.id === ids.cp && res.codeFolderOf === res.r1.folder && res.r4.copied, JSON.stringify(res));
    assert(/같은 서재 안으로는 복사할 수 없습니다/.test(res.refused), res.refused);
    const files = repoFiles();
    const codePrefix = `codes/${libId.X}/`;
    assert(files.includes(`${codePrefix}papers/${res.luInCode}/translation.json`) && !files.some((p) => p.includes('people/') && p.includes(res.luInCode)), 'Lu copied with translation, without 내 서재 notes');
    assert(files.includes(`papers/${res.r2.id}/paper.pdf`) && files.includes(`papers/${res.r2.id}/translation.json`) && !files.some((p) => p.startsWith('people/') && p.includes(res.r2.id)), 'Moral copied into the team root without notes');
    assert(sha256(gh.readFile(TEAM.owner, TEAM.repo, `papers/${res.r2.id}/paper.pdf`)) === sha256(gh.readFile(TEAM.owner, TEAM.repo, `${codePrefix}papers/${ids.cp}/paper.pdf`)), 'same PDF bytes');
    assert(mineFiles().includes(`papers/${res.r4.id}/paper.pdf`) && mineFiles().includes(`papers/${res.r4.id}/translation.json`) && !mineFiles().includes(`papers/${res.r4.id}/annotations.json`), 'Moral copied into 내 서재 without notes');
    const r3Uploads = relay.log.filter((e) => e.method === 'POST' && e.path.endsWith('/git/blobs') && e.path.includes('/shared/mine/') && e.bytesIn > 25_000);
    assert(r3Uploads.length === 1, `code library PDF uploads in this test (Lu only): ${r3Uploads.length}`);
    const codeAct = (await activity(CODES.X, 'mine')).map((i) => i.summary);
    const teamAct = (await activity(CODES.X, 'team')).map((i) => i.summary);
    assert(codeAct.some((s) => /폴더 복사 ‘ICU’ \(내 서재에서, 논문 1편\)/.test(s)) && codeAct.some((s) => /논문 이동 ‘Moral Sensitivity’ → ‘ICU’/.test(s)), codeAct.join(' | '));
    assert(teamAct.some((s) => /논문 추가 ‘Moral Sensitivity’ \(봄당 서재에서 복사\)/.test(s)) && !teamAct.some((s) => /ICU/.test(s)), teamAct.join(' | '));
    return `copied: ICU (Lu 2025), Moral → team, team → code library mapped onto the existing Moral (moved into ICU, 0 extra PDF uploads), Moral → 내 서재; same library refused (“${res.refused}”); activity: ${codeAct.slice(0, 2).join(' | ')}`;
  });

  await test('X\'s second browser (same code) gets 봄당 서재 with X\'s notes; Y\'s browser (another code) has its own empty code library and 전체 공용 서재 — nothing of 봄당 서재 in its databases', async () => {
    X2 = await device('X2');
    const o2 = await openRelayLibs(X2, 'X');
    const x2 = await X2.ev(async (cp) => {
      const lib = window.__L('code');
      return { titles: lib.papers.map((p) => p.title).sort(), ann: (await lib.getPaperData(cp, 'annotations'))?.items?.[0]?.note ?? null, pdf: await window.__sha256(await lib.getPdf(cp)) };
    }, ids.cp);
    assert(o2.info.libraryId === libId.X && x2.titles.join() === 'Lu 2025,Moral Sensitivity' && x2.ann === '봄당 메모', JSON.stringify(x2));
    assert(x2.pdf === sha256(gh.readFile(TEAM.owner, TEAM.repo, `codes/${libId.X}/papers/${ids.cp}/paper.pdf`)), 'PDF');

    Y = await device('Y');
    const oy = await openRelayLibs(Y, 'Y');
    const y = await Y.ev(async ({ mineDb, teamDb }) => ({
      code: window.__dumpLib('code'),
      team: window.__dumpLib('team'),
      codeKeys: await window.__filesOf(mineDb),
      teamKeys: await window.__filesOf(teamDb),
      dbs: await window.__idbNames(),
    }), { mineDb: DB.mine('Y'), teamDb: DB.team('Y') });
    assert(oy.code.label === '6기 서재' && y.code.papers.length === 0 && y.code.folders.length === 0, JSON.stringify(y.code));
    assert(y.team.papers.map((p) => p.title).sort().join() === 'Moral Sensitivity,공용 논문', `Y team: ${y.team.papers.map((p) => p.title)}`);
    assert(![...y.codeKeys, ...y.teamKeys].some((k) => k.startsWith('codes') || k.includes(ids.cp) || k.includes(pid.X)), `Y databases: ${strip([...y.codeKeys, ...y.teamKeys])}`);
    assert(y.dbs.includes(DB.mine('Y')) && !y.dbs.includes(DB.mine('X')), strip(y.dbs));
    return `X2: [${x2.titles.join(', ')}] + “${x2.ann}”; Y: 6기 서재 empty, 전체 공용 서재 [${y.team.papers.map((p) => p.title).join(', ')}], no codes/ or X data in [${strip(y.dbs.filter((n) => n.startsWith('paper-reader')).join(', '))}]`;
  });

  await test('휴지통 in 봄당 서재 across browsers: X deletes → X2 sees it with X\'s name → X2 restores → X sees it again; the PDF never leaves codes/<libX>/; Y never sees any of it', async () => {
    await X.ev((cp) => window.__L('code').deletePaper(cp), ids.cp);
    await pushLib(X, 'code');
    assert(repoFiles().includes(`codes/${libId.X}/papers/${ids.cp}/paper.pdf`), 'PDF kept');
    await syncLib(X2, 'code');
    const trash = await X2.ev(() => window.__dumpLib('code').trash);
    const item = trash.find((t) => t.id === ids.cp);
    assert(item?.kind === 'paper' && item.deletedBy === '봄당', JSON.stringify(trash));
    await X2.ev((cp) => window.__L('code').restore(cp), ids.cp);
    await pushLib(X2, 'code');
    await syncLib(X, 'code');
    const back = await X.ev((cp) => window.__L('code').getPaper(cp)?.title ?? null, ids.cp);
    await syncLib(Y, 'code');
    const yTrash = await Y.ev(() => window.__dumpLib('code'));
    assert(back === 'Moral Sensitivity' && yTrash.trash.length === 0 && yTrash.papers.length === 0, JSON.stringify({ back, yTrash }));
    const lines = (await activity(CODES.X, 'mine')).map((i) => `[${i.who}] ${i.summary}`);
    assert(lines.some((l) => l === '[봄당] 논문 삭제 ‘Moral Sensitivity’') && lines.some((l) => l === '[봄당] 복구 ‘Moral Sensitivity’'), lines.join(' | '));
    assert(!(await activity(CODES.Y, 'mine')).some((i) => /Moral/.test(i.summary)), 'Y\'s activity must not show 봄당 서재');
    return `X2's 휴지통: “${item.name}” · ${item.deletedBy}; restored on X; Y: nothing; activity ${lines.slice(0, 2).join(' | ')}`;
  });

  await test('changes made right before a reload survive in all three libraries (own journal keys), and each reopens from its own database', async () => {
    await X.ev(() => Promise.all([window.__waitSync(), window.__waitLib('code'), window.__waitLib('team')]));
    await X.page.evaluate(({ pf, cf, tf }) => {
      window.__lib.renameFolder(pf, 'ICU (새로고침 직전)');
      window.__L('code').renameFolder(cf, '봄당 폴더 (새로고침 직전)');
      window.__L('team').renameFolder(tf, '공용 폴더 (새로고침 직전)');
      window.dispatchEvent(new Event('pagehide'));
      location.reload();
    }, ids).catch(() => {});
    await X.page.waitForFunction(() => window.__harnessReady);
    const journals = await X.ev(() => Object.keys(localStorage).filter((k) => k.startsWith('pr.store.libraryJournal')).sort());
    await X.ev(({ sync }) => window.__boot({ syncOptions: sync }), { sync: SYNC });
    await openRelayLibs(X, 'X');
    const names = await X.ev(({ pf, cf, tf }) => ({
      personal: window.__lib.getFolder(pf)?.name, code: window.__L('code').getFolder(cf)?.name, team: window.__L('team').getFolder(tf)?.name,
    }), ids);
    assert(names.personal === 'ICU (새로고침 직전)' && names.code === '봄당 폴더 (새로고침 직전)' && names.team === '공용 폴더 (새로고침 직전)', JSON.stringify(names));
    const allowed = new Set(['pr.store.libraryJournal.v1', `pr.store.libraryJournal.v1:${DB.mine('X')}`, `pr.store.libraryJournal.v1:${DB.team('X')}`]);
    assert(journals.every((k) => allowed.has(k)), `journal keys: ${strip(journals)}`);
    await X.ev(() => Promise.all([window.__lib.flush(), window.__L('code').flush(), window.__L('team').flush()]));
    await X.ev(() => Promise.all([window.__waitSync(), window.__waitLib('code'), window.__waitLib('team')]));
    assert(repoJson(`codes/${libId.X}/library.json`).folders.find((f) => f.id === ids.cf)?.name === '봄당 폴더 (새로고침 직전)'
      && repoJson('library.json').folders.find((f) => f.id === ids.tf)?.name === '공용 폴더 (새로고침 직전)', 'pushed');
    return `after reload: ${JSON.stringify(names)}; journal keys at reload [${strip(journals.join(', ')) || 'none — IndexedDB writes had completed'}]`;
  });

  await test('WebKit (Safari engine, as on iPhone): Y\'s second device opens 6기 서재 + 전체 공용 서재, adds a paper with notes to its code library; Edge Y sees it, X does not', async () => {
    try {
      safari = await webkit.launch();
    } catch (err) {
      throw new Error(`WebKit could not start: ${err.message}`);
    }
    const W = await device('Y-webkit', safari);
    const o = await openRelayLibs(W, 'Y');
    const w = await W.ev(async () => {
      const lib = window.__L('code');
      const p = await lib.addPaper(window.__makePdf(15_000, 21), { fileName: 'proc.pdf', meta: { title: 'Procedures (iPhone)' } });
      await lib.savePaperData(p.id, 'ai', { version: 1, summary: { markdown: '6기 요약', createdAt: 1 } });
      await lib.flush();
      return { id: p.id, team: window.__dumpLib('team').papers.length, dbs: await window.__idbNames() };
    });
    await W.ev(() => window.__waitLib('code'));
    assert(o.code.label === '6기 서재' && w.team === 2 && w.dbs.includes(DB.mine('Y')), JSON.stringify({ o, w }));
    assert(repoFiles().includes(`codes/${libId.Y}/papers/${w.id}/paper.pdf`) && repoFiles().includes(`codes/${libId.Y}/people/${pid.Y}/papers/${w.id}/ai.json`), 'in 6기 folder');
    await syncLib(Y, 'code');
    const y = await Y.ev(async (id) => ({ title: window.__L('code').getPaper(id)?.title, ai: (await window.__L('code').getPaperData(id, 'ai'))?.summary?.markdown }), w.id);
    await syncLib(X, 'code');
    const x = await X.ev(() => window.__L('code').papers.map((p) => p.title));
    assert(y.title === 'Procedures (iPhone)' && y.ai === '6기 요약' && !x.includes('Procedures (iPhone)'), JSON.stringify({ y, x }));
    await W.ctx.close();
    return `WebKit wrote codes/<libY>/papers/<id>/paper.pdf + people/<pY>/…/ai.json; Edge Y reads it with the summary; X's 봄당 서재 [${x.join(', ')}]`;
  });
} finally {
  await edge.close();
  if (safari) await safari.close();
  await relay.close();
  await gh.close();
  if (server) server.kill();
}

const leaked = gh.log.filter((e) => Object.values(CODES).includes(e.token));
const out = {
  results, pageErrors, consoleErrors: consoleErrors.slice(0, 60), external, inviteCodesSeenByGitHub: leaked.length,
  relayRefusals: relay.log.filter((e) => e.status === 403).map((e) => `${e.method} ${strip(e.path)}`),
};
writeFileSync(`${OUT}/store-browser.results.json`, JSON.stringify(out, null, 2));
const failed = results.filter((r) => r.result !== 'pass').length;
console.log(`console errors (expected: 409 answers on stale bases, 404 probes): ${consoleErrors.length}`);
console.log(`\nstore code libraries (browser): ${results.length - failed}/${results.length} passed · page errors: ${pageErrors.length} · blocked external: ${external.length} · invite codes seen by GitHub: ${leaked.length} · relay refusals: ${out.relayRefusals.length}`);
if (pageErrors.length) console.log(pageErrors.join('\n'));
process.exitCode = failed || pageErrors.length || leaked.length || external.length || out.relayRefusals.length ? 1 : 0;
