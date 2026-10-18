// Store module — browser tests for several libraries (docs/SHARED.md §3.1): real IndexedDB + js/store/* in Edge.
// 내 서재 syncs to a personal repo on the in-process fake GitHub; 공용 서재 goes through the fake relay
// (tests/store/fake-relay.mjs: path allowlist, people/ filtering, stale-base 409, message rewrite) to a team repo
// on the same fake. Each browser context is one person/device. No external host is contacted.
//   node tests/store/run-shared.mjs      (serves the repo with `python -m http.server 8193` if nothing listens)
// Results: C:/Users/dindoo/Projects/pr-tools/out/store/shared-results.json
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'file:///C:/Users/dindoo/Projects/pr-tools/node_modules/playwright/index.mjs';
import { startFakeGitHub } from './fake-github.mjs';
import { startFakeRelay } from './fake-relay.mjs';

const PORT = 8193;
const BASE = `http://127.0.0.1:${PORT}`;
const H = `${BASE}/tests/store/harness.html`;
const OUT = 'C:/Users/dindoo/Projects/pr-tools/out/store';
const FIXTURES = 'C:/Users/dindoo/Projects/pr-fixtures';
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const TEAM = { owner: 'dindoopark', repo: 'paper-team-library', token: 'ghp_team_secret_for_tests' };
const MINE = { owner: 'me', repo: 'paper-library', token: 'ghp_owner_personal_token' };
const CODES = { O: 'PR-0WNE-R111', A: 'PR-AAAA-BBBB', B: 'PR-CCCC-DDDD' };
const NAMES = { O: '주인', A: '김동료', B: '박동료' };
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
gh.createRepo(TEAM.owner, TEAM.repo, { private: true }); // empty: bootstrapped by the first push
gh.createRepo(MINE.owner, MINE.repo, { private: true, files: { 'README.md': 'mine' } });
const relay = await startFakeRelay({ github: gh, owner: TEAM.owner, repo: TEAM.repo, token: TEAM.token });
const pid = Object.fromEntries(Object.entries(CODES).map(([k, code]) => [k, relay.addCode(code, NAMES[k])]));
const teamFiles = () => [...gh.files(TEAM.owner, TEAM.repo).keys()].sort();
const teamJson = (path) => JSON.parse(gh.readFile(TEAM.owner, TEAM.repo, path).toString('utf8'));
const mineFiles = () => [...gh.files(MINE.owner, MINE.repo).keys()].sort();
const GH_MINE = { owner: MINE.owner, repo: MINE.repo, branch: 'main', token: MINE.token, apiBase: gh.url };
const browser = await chromium.launch({ channel: 'msedge', args: ['--host-resolver-rules=MAP api.github.com 127.0.0.1, MAP *.github.com 127.0.0.1'] });

async function device(name) {
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
const openTeam = (d, who) => d.ev((o) => window.__openShared(o), { key: 'team', relayUrl: relay.url, code: CODES[who], name: NAMES[who], syncOptions: SYNC });
const syncTeam = async (d) => { await d.ev(() => window.__L('team').sync.syncNow()); return d.ev(() => window.__waitLib('team')); };
const pushTeam = async (d) => { await d.ev(() => window.__L('team').flush()); return d.ev(() => window.__waitLib('team')); };

let O;
let A;
let B;
const ids = {};

try {
  await test('one page, two libraries at once: 내 서재 (IndexedDB paper-reader → personal repo, paths unchanged) and 공용 서재 (its own IndexedDB → team repo via the relay); no data, lock or channel shared', async () => {
    O = await device('owner');
    await O.ev(({ gh, sync }) => window.__boot({ github: gh, syncOptions: sync }), { gh: GH_MINE, sync: SYNC });
    const info = await openTeam(O, 'O');
    assert(info.id === 'shared:team' && info.prefix === `people/${pid.O}/`, JSON.stringify(info));
    const made = await O.ev(async () => {
      const mine = window.__L('mine');
      const team = window.__L('team');
      const icu = mine.createFolder('ICU');
      const lu = await mine.addPaper(await window.__fixture('lu2025'), { fileName: 'lu2025.pdf', folderId: icu.id, meta: { title: 'Lu 2025' } });
      await mine.savePaperData(lu.id, 'annotations', { version: 1, items: [{ id: 'mo', anchor: { start: 0, end: 4 }, quote: 'q', color: 'yellow', note: '주인 메모', createdAt: 1, updatedAt: 1 }] });
      await mine.savePaperData(lu.id, 'translation', { version: 1, targetLang: 'ko', segVersion: 1, items: { 'p1-0': { h: 'h0', t: '〔번역〕 주인' } } });
      const tf = team.createFolder('공용 폴더');
      const tp = await team.addPaper(window.__makePdf(40_000, 7), { fileName: 'team.pdf', folderId: tf.id, meta: { title: '공용 논문' } });
      await team.savePaperData(tp.id, 'annotations', { version: 1, items: [{ id: 'to', anchor: { start: 0, end: 2 }, quote: 't', color: 'green', note: '공용 서재의 내 메모', createdAt: 1, updatedAt: 1 }] });
      await Promise.all([mine.flush(), team.flush()]);
      return { icu: icu.id, lu: lu.id, tf: tf.id, tp: tp.id };
    });
    Object.assign(ids, made);
    await O.ev(() => window.__waitSync());
    await O.ev(() => window.__waitLib('team'));
    const state = await O.ev(async ({ teamDb }) => ({
      dbs: await window.__idbNames(),
      mine: window.__dumpLib('mine'),
      team: window.__dumpLib('team'),
      mineFiles: await window.__filesOf('paper-reader'),
      teamFiles: await window.__filesOf(teamDb),
      tabEvents: { mine: window.__events.remote.filter((e) => e.origin === 'tab').length, team: window.__eventsBy.team.remote.filter((e) => e.origin === 'tab').length },
    }), { teamDb: `paper-reader-shared-team-${pid.O}` });
    assert(state.dbs.includes('paper-reader') && state.dbs.includes(`paper-reader-shared-team-${pid.O}`), `databases: ${state.dbs}`);
    assert(state.mine.folders.map((f) => f.name).join() === 'ICU' && state.team.folders.map((f) => f.name).join() === '공용 폴더', 'folders');
    assert(!state.mineFiles.some((k) => k.includes(ids.tp)) && !state.teamFiles.some((k) => k.includes(ids.lu)), 'IndexedDB contents are separate');
    assert(state.tabEvents.mine === 0 && state.tabEvents.team === 0, `cross-library tab notifications: ${JSON.stringify(state.tabEvents)}`);
    const mf = mineFiles().filter((p) => p.includes(ids.lu));
    assert(mf.join() === ['annotations.json', 'paper.pdf', 'translation.json'].map((f) => `papers/${ids.lu}/${f}`).join(), `personal repo: ${mf}`);
    assert(!mineFiles().some((p) => p.startsWith('people/')), 'personal repo has no people/');
    const tfiles = teamFiles();
    assert(tfiles.includes(`papers/${ids.tp}/paper.pdf`) && tfiles.includes(`people/${pid.O}/papers/${ids.tp}/annotations.json`) && !tfiles.some((p) => p.includes(ids.lu)), `team repo: ${tfiles}`);
    assert(!relay.log.some((e) => e.status === 403), 'relay refused something');

    // Reload: both reopen from their own databases.
    await O.page.reload();
    await O.page.waitForFunction(() => window.__harnessReady);
    await O.ev(({ sync }) => window.__boot({ syncOptions: sync }), { sync: SYNC });
    await openTeam(O, 'O');
    const after = await O.ev(() => ({ mine: window.__dumpLib('mine'), team: window.__dumpLib('team') }));
    assert(after.mine.papers.map((p) => p.title).join() === 'Lu 2025' && after.team.papers.map((p) => p.title).join() === '공용 논문', JSON.stringify(after));
    assert(after.team.papers[0].addedBy === '주인', 'addedBy');
    return `IndexedDB [${state.dbs.join(', ')}]; 내 서재 → ${MINE.owner}/${MINE.repo} papers/<id>/{annotations,paper,translation}; 공용 서재 → team repo papers/<id>/paper.pdf + people/<owner>/papers/<id>/annotations.json; 0 cross-library tab events; after reload each library reopened with its own data`;
  });

  await test('invitee A uploads, translates and annotates; invitee B (fresh browser) gets folders, paper, PDF and translation (0 translation work) but not A\'s notes', async () => {
    A = await device('A');
    await openTeam(A, 'A');
    await syncTeam(A);
    const a = await A.ev(async () => {
      const team = window.__L('team');
      const f = team.createFolder('섬망 연구');
      const bytes = await window.__fixture('kiekkas2012');
      const p = await team.addPaper(bytes, { fileName: 'kiekkas2012.pdf', folderId: f.id, meta: { title: 'Kiekkas 2012' } });
      await team.savePaperData(p.id, 'translation', { version: 1, targetLang: 'ko', segVersion: 1, items: { 'p1-0': { h: 'k0', t: '〔번역〕 키에카스 0' }, 'p1-1': { h: 'k1', t: '〔번역〕 키에카스 1' } } });
      await team.savePaperData(p.id, 'annotations', { version: 1, items: [{ id: 'ann_A', anchor: { start: 3, end: 9 }, quote: 'a', color: 'pink', note: 'A만의 메모', createdAt: 1, updatedAt: 1 }] });
      await team.savePaperData(p.id, 'ai', { version: 1, chat: [{ id: 'c1', role: 'user', content: 'A 질문', ts: 1 }] });
      await team.flush();
      return { folder: f.id, paper: p.id, sha: await window.__sha256(bytes) };
    });
    Object.assign(ids, { kFolder: a.folder, kPaper: a.paper, kSha: a.sha });
    await A.ev(() => window.__waitLib('team'));

    B = await device('B');
    await openTeam(B, 'B');
    await syncTeam(B);
    const b = await B.ev(async (id) => {
      const team = window.__L('team');
      return {
        dump: window.__dumpLib('team'),
        sha: await window.__sha256(await team.getPdf(id)),
        tr: await team.getPaperData(id, 'translation'),
        ann: await team.getPaperData(id, 'annotations'),
        ai: await team.getPaperData(id, 'ai'),
        people: await team.sync.listPaths('people/'),
      };
    }, a.paper);
    assert(b.dump.folders.some((f) => f.id === a.folder && f.name === '섬망 연구') && b.dump.papers.some((p) => p.id === a.paper && p.folderId === a.folder && p.addedBy === '김동료'), JSON.stringify(b.dump));
    assert(b.sha === a.sha && Object.keys(b.tr.items).join() === 'p1-0,p1-1', 'PDF + translation');
    assert(b.ann === null && b.ai === null, `B must not see A's notes/AI: ${JSON.stringify({ ann: b.ann, ai: b.ai })}`);
    assert(b.people.every((p) => p.startsWith(`people/${pid.B}/`)), `B's view of people/: ${b.people}`);
    return `B sees ‘섬망 연구’ / ‘Kiekkas 2012’ (added by 김동료), PDF sha256 ${a.sha.slice(0, 12)}… identical, ${Object.keys(b.tr.items).length} translated sentences reused; annotations/ai = null; people/ entries visible to B: ${b.people.length}`;
  });

  await test('B deletes the paper → A sees it in the 휴지통 with B\'s name → A restores it → B sees it again; the PDF stayed in the team repo', async () => {
    await B.ev((id) => window.__L('team').deletePaper(id), ids.kPaper);
    await pushTeam(B);
    assert(teamFiles().includes(`papers/${ids.kPaper}/paper.pdf`), 'PDF kept');
    await syncTeam(A);
    const trash = await A.ev(() => window.__dumpLib('team').trash);
    const item = trash.find((t) => t.id === ids.kPaper);
    assert(item?.kind === 'paper' && item.deletedBy === '박동료' && item.name === 'Kiekkas 2012', JSON.stringify(trash));
    await A.ev((id) => window.__L('team').restore(id), ids.kPaper);
    await pushTeam(A);
    await syncTeam(B);
    const back = await B.ev((id) => ({ p: window.__L('team').getPaper(id) }), ids.kPaper);
    assert(back.p?.folderId === ids.kFolder, JSON.stringify(back));
    const annA = await A.ev((id) => window.__L('team').getPaperData(id, 'annotations'), ids.kPaper);
    assert(annA.items[0].note === 'A만의 메모', 'A keeps its notes through delete + restore');
    return `A's 휴지통: “${item.name}” · ${item.deletedBy}; restored into 섬망 연구 on A and B; A's notes intact; papers/<id>/paper.pdf present throughout`;
  });

  await test('owner copies a folder from 내 서재 into 공용 서재 (in the page): PDFs + translations reach the team repo, never notes; a PDF A already uploaded is mapped, not duplicated', async () => {
    const res = await O.ev(async ({ icu }) => {
      const mine = window.__L('mine');
      const team = window.__L('team');
      await team.sync.syncNow();
      const k = await mine.addPaper(await window.__fixture('kiekkas2012'), { fileName: 'k-mine.pdf', folderId: icu, meta: { title: 'Kiekkas (내 사본)' } });
      await mine.savePaperData(k.id, 'annotations', { version: 1, items: [{ id: 'mk', anchor: { start: 0, end: 1 }, quote: 'k', color: 'blue', note: '주인 메모 2', createdAt: 1, updatedAt: 1 }] });
      const progress = [];
      const r = await mine.copyFolderTo(team, icu, { onProgress: (e) => progress.push(`${e.done}/${e.total}`) });
      await team.flush();
      return { folders: r.folders, papers: r.papers, folder: r.folder?.id, progress, team: window.__dumpLib('team') };
    }, { icu: ids.icu });
    await O.ev(() => window.__waitLib('team'));
    assert(res.folders.created === 1 && res.papers.copied === 1 && res.papers.existing === 1 && res.papers.moved === 1 && res.papers.failed.length === 0, JSON.stringify(res));
    const lib = teamJson('library.json');
    const icuT = lib.folders.find((f) => f.id === res.folder);
    const luT = lib.papers.find((p) => p.title === 'Lu 2025' && !p.deleted);
    assert(icuT?.name === 'ICU' && luT?.folderId === icuT.id && lib.papers.find((p) => p.id === ids.kPaper).folderId === icuT.id, JSON.stringify(lib));
    assert(lib.papers.filter((p) => !p.deleted).length === 3, `no duplicates: ${lib.papers.map((p) => p.title)}`);
    assert(teamFiles().includes(`papers/${luT.id}/paper.pdf`) && teamFiles().includes(`papers/${luT.id}/translation.json`), 'Lu 2025 files');
    assert(sha256(gh.readFile(TEAM.owner, TEAM.repo, `papers/${luT.id}/paper.pdf`)) === sha256(gh.readFile(MINE.owner, MINE.repo, `papers/${ids.lu}/paper.pdf`)), 'PDF bytes');
    assert(!teamFiles().some((p) => p.startsWith('people/') && p.includes(luT.id)), 'owner notes must not be copied');
    assert(teamJson(`papers/${luT.id}/translation.json`).items['p1-0'].t === '〔번역〕 주인', 'translation copied');
    // A sees the copied folder and the moved paper.
    await syncTeam(A);
    const seen = await A.ev(({ folder, k }) => ({ f: window.__L('team').getFolder(folder)?.name, k: window.__L('team').getPaper(k)?.folderId }), { folder: res.folder, k: ids.kPaper });
    assert(seen.f === 'ICU' && seen.k === res.folder, JSON.stringify(seen));
    return `ICU copied (folders created ${res.folders.created}); Lu 2025 copied with its translation (no notes); Kiekkas (same PDF as A's upload) mapped → moved into ICU; progress ${res.progress.join(' ')}; A sees it`;
  });

  await test('최근 활동: the team repo\'s commits read as who did what', async () => {
    const res = await fetch(`${relay.url}/shared/team/activity?limit=30`, { headers: { Authorization: `Bearer ${CODES.A}` } });
    const { items } = await res.json();
    const lines = items.map((i) => `[${i.who}] ${i.summary}`);
    const has = (who, re) => items.some((i) => i.who === who && re.test(i.summary));
    assert(has('김동료', /폴더 만듦 ‘섬망 연구’/) && has('김동료', /논문 추가 ‘Kiekkas 2012’/), lines.join('\n'));
    assert(has('박동료', /논문 삭제 ‘Kiekkas 2012’/) && has('김동료', /복구 ‘Kiekkas 2012’/), lines.join('\n'));
    assert(has('주인', /폴더 복사 ‘ICU’ \(내 서재에서, 논문 2편\)/), lines.join('\n'));
    assert(!lines.some((l) => /people\/|PR-|library\.json/.test(l)), lines.join('\n'));
    return lines.slice(0, 6).join(' | ');
  });

  await test('changes made right before a reload survive in both libraries (each has its own page-hide journal key)', async () => {
    await O.ev(() => Promise.all([window.__waitSync(), window.__waitLib('team')]));
    // Page hidden while both writes are still on their way to IndexedDB: each library journals under its own key.
    const forced = await O.ev(async ({ icu, tf }) => {
      window.__L('mine').renameFolder(icu, 'ICU (숨기기 직전)');
      window.__L('team').renameFolder(tf, '공용 폴더 (숨기기 직전)');
      window.dispatchEvent(new Event('pagehide'));
      const keys = Object.keys(localStorage).filter((k) => k.startsWith('pr.store.libraryJournal')).sort();
      const team = JSON.parse(localStorage.getItem(keys.find((k) => k.includes(':')) || 'null') || 'null');
      await Promise.all([window.__L('mine').whenSaved(), window.__L('team').whenSaved()]);
      const left = Object.keys(localStorage).filter((k) => k.startsWith('pr.store.libraryJournal'));
      return { keys, teamFolder: team?.data?.folders?.find((f) => f.id === tf)?.name, left };
    }, { icu: ids.icu, tf: ids.tf });
    assert(forced.keys.join() === ['pr.store.libraryJournal.v1', `pr.store.libraryJournal.v1:paper-reader-shared-team-${pid.O}`].join(), `journal keys: ${forced.keys}`);
    assert(forced.teamFolder === '공용 폴더 (숨기기 직전)' && forced.left.length === 0, JSON.stringify(forced));
    await O.page.evaluate(({ icu, tf }) => {
      window.__L('mine').renameFolder(icu, 'ICU (새로고침 직전)');
      window.__L('team').renameFolder(tf, '공용 폴더 (새로고침 직전)');
      location.reload();
    }, { icu: ids.icu, tf: ids.tf }).catch(() => {});
    await O.page.waitForFunction(() => window.__harnessReady);
    const journals = await O.ev(() => Object.keys(localStorage).filter((k) => k.startsWith('pr.store.libraryJournal')).sort());
    await O.ev(({ sync }) => window.__boot({ syncOptions: sync }), { sync: SYNC });
    await openTeam(O, 'O');
    const names = await O.ev(({ icu, tf }) => ({ mine: window.__L('mine').getFolder(icu)?.name, team: window.__L('team').getFolder(tf)?.name }), { icu: ids.icu, tf: ids.tf });
    assert(names.mine === 'ICU (새로고침 직전)' && names.team === '공용 폴더 (새로고침 직전)', JSON.stringify(names));
    const allowed = new Set(['pr.store.libraryJournal.v1', `pr.store.libraryJournal.v1:paper-reader-shared-team-${pid.O}`]);
    assert(journals.every((k) => allowed.has(k)), `journal keys: ${journals}`);
    await O.ev(() => Promise.all([window.__L('mine').flush(), window.__L('team').flush()]));
    await O.ev(() => Promise.all([window.__waitSync(), window.__waitLib('team')]));
    assert(teamJson('library.json').folders.find((f) => f.id === ids.tf)?.name === '공용 폴더 (새로고침 직전)', 'team pushed');
    assert(JSON.parse(gh.readFile(MINE.owner, MINE.repo, 'library.json').toString('utf8')).folders.find((f) => f.id === ids.icu)?.name === 'ICU (새로고침 직전)', 'mine pushed');
    return `forced page-hide: journals [${forced.keys.join(', ')}], removed once saved; reload right after renames: both kept and pushed (journal keys at reload: [${journals.join(', ') || 'none — the IndexedDB writes had completed'}])`;
  });
} finally {
  await browser.close();
  await relay.close();
  await gh.close();
  if (server) server.kill();
}

const leaked = gh.log.filter((e) => Object.values(CODES).includes(e.token));
const out = { results, pageErrors, consoleErrors: consoleErrors.slice(0, 50), external, inviteCodesSeenByGitHub: leaked.length, relayRefusals: relay.log.filter((e) => e.status === 403).length };
writeFileSync(`${OUT}/shared-results.json`, JSON.stringify(out, null, 2));
const failed = results.filter((r) => r.result !== 'pass').length;
console.log(`console errors (expected: 409 answers on the empty team repo and stale bases): ${consoleErrors.length}`);
console.log(`\nstore shared (browser): ${results.length - failed}/${results.length} passed · page errors: ${pageErrors.length} · blocked external: ${external.length} · invite codes seen by GitHub: ${leaked.length} · relay refusals: ${out.relayRefusals}`);
if (pageErrors.length) console.log(pageErrors.join('\n'));
process.exitCode = failed || pageErrors.length || leaked.length || external.length ? 1 : 0;
