// Store module — Node-level tests: merge rules (pure) and GitHubClient against the fake server.
//   node tests/store/unit.test.mjs
// Results: C:/Users/dindoo/Projects/pr-tools/out/store/unit.results.json
import { mkdirSync, writeFileSync } from 'node:fs';
import { startFakeGitHub } from './fake-github.mjs';
import { GitHubClient, GitHubConflictError, gitBlobSha } from '../../js/store/github.js';
import { deepEqual, mergeAi, mergeAnnotations, mergeLibrary, mergeRecords, mergeTranslation, mergerFor } from '../../js/store/sync.js';
import { dataPath, paperPath } from '../../js/store/library.js';

const OUT = 'C:/Users/dindoo/Projects/pr-tools/out/store';
mkdirSync(OUT, { recursive: true });
const results = [];
// Nothing may leave the machine: any non-loopback request fails here (and is recorded) before it is sent.
const external = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (url, init) => {
  const href = String(url?.url ?? url);
  if (!/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])[:/]/.test(href)) {
    external.push(href);
    return Promise.reject(new TypeError(`blocked non-loopback request in tests: ${href}`));
  }
  return realFetch(url, init);
};

function assert(cond, msg) { if (!cond) throw new Error(msg); }
async function test(name, fn) {
  try {
    const evidence = await fn();
    results.push({ name, result: 'pass', evidence: String(evidence ?? 'ok') });
    console.log(`PASS  ${name}  — ${evidence ?? ''}`);
  } catch (err) {
    results.push({ name, result: 'fail', evidence: err?.stack || String(err) });
    console.log(`FAIL  ${name}  — ${err?.stack || err}`);
  }
}

// ------------------------------------------------------------------ merges

await test('mergeRecords: newer updatedAt wins, tombstone wins ties, union of ids', () => {
  const l = [{ id: 'a', name: 'L', updatedAt: 2 }, { id: 'b', name: 'Lb', updatedAt: 5 }, { id: 'c', updatedAt: 3 }];
  const r = [{ id: 'a', name: 'R', updatedAt: 3 }, { id: 'b', name: 'Rb', updatedAt: 5, deleted: true }, { id: 'd', updatedAt: 1 }];
  const m = mergeRecords(l, r);
  const by = Object.fromEntries(m.map((x) => [x.id, x]));
  assert(by.a.name === 'R', 'remote newer should win');
  assert(by.b.deleted === true, 'tombstone should win tie');
  assert(by.c && by.d, 'union');
  return `ids=${m.map((x) => x.id).join(',')}`;
});

await test('mergeRecords with base: rename on one side + move on the other both survive; delete is sticky', () => {
  const base = [{ id: 'f', name: 'Old', parentId: null, updatedAt: 1 }, { id: 'p', title: 'T', folderId: null, updatedAt: 1 }];
  const l = [{ id: 'f', name: 'New', parentId: null, updatedAt: 5 }, { id: 'p', title: 'T', folderId: null, deleted: true, updatedAt: 3 }];
  const r = [{ id: 'f', name: 'Old', parentId: 'x', updatedAt: 4 }, { id: 'p', title: 'T', folderId: null, translatedCount: 9, updatedAt: 6 }];
  const m = Object.fromEntries(mergeRecords(l, r, base).map((x) => [x.id, x]));
  assert(m.f.name === 'New' && m.f.parentId === 'x', `field-level merge failed: ${JSON.stringify(m.f)}`);
  assert(m.p.deleted === true && m.p.translatedCount === 9, `delete should stick: ${JSON.stringify(m.p)}`);
  // Combined from both sides -> stamped newer than either, so it supersedes both in later base-less merges.
  assert(m.p.updatedAt === 7 && m.f.updatedAt === 6, `combined stamp: ${JSON.stringify(m)}`);
  return JSON.stringify(m.f);
});

await test('mergeLibrary / mergeAnnotations keep both sides\' items', () => {
  const lib = mergeLibrary({ version: 1, updatedAt: 2, folders: [{ id: 'a', updatedAt: 1 }], papers: [] },
    { version: 1, updatedAt: 3, folders: [], papers: [{ id: 'p', updatedAt: 1 }] });
  assert(lib.folders.length === 1 && lib.papers.length === 1 && lib.updatedAt === 3, JSON.stringify(lib));
  const ann = mergeAnnotations({ version: 1, items: [{ id: 'x', updatedAt: 1 }] }, { version: 1, items: [{ id: 'y', updatedAt: 1 }] });
  assert(ann.items.map((i) => i.id).sort().join() === 'x,y', 'annotation union');
  return 'ok';
});

await test('mergeTranslation: union, local wins per sid; another segVersion is unioned too (higher wins a shared sid)', () => {
  const m = mergeTranslation({ segVersion: 1, items: { s1: { t: 'L' }, s2: { t: 'L2' } } }, { segVersion: 1, items: { s1: { t: 'R' }, s3: { t: 'R3' } } });
  assert(m.items.s1.t === 'L' && m.items.s2 && m.items.s3, JSON.stringify(m));
  // Regression (segversion-wholesale-replace): an old-code tab (segVersion 1) must not discard the paid
  // translations of the other file, nor the other way round. Readers validate every item by hash.
  const v = mergeTranslation({ segVersion: 1, items: { a: { t: 'old-a' }, c: { t: 'old-c' } } }, { segVersion: 2, items: { b: { t: 'new-b' }, c: { t: 'new-c' } } });
  assert(v.items.a && v.items.b && v.items.c.t === 'new-c' && v.segVersion === 2, `union across segVersions: ${JSON.stringify(v)}`);
  const w = mergeTranslation({ segVersion: 2, items: { c: { t: 'new-c' } } }, { segVersion: 1, items: { a: { t: 'old-a' }, c: { t: 'old-c' } } });
  assert(w.items.a && w.items.c.t === 'new-c' && w.segVersion === 2, JSON.stringify(w));
  return JSON.stringify(v.items);
});

await test('mergeTranslation: `terms` (established term renderings) union by key, local wins a shared key, absent stays absent', () => {
  const local = { segVersion: 1, items: {}, terms: { 'endotracheal tube': { en: 'endotracheal tube (ETT)', ko: '기관내관' } } };
  const remote = { segVersion: 1, items: {}, terms: { 'endotracheal tube': { en: 'endotracheal tube', ko: '기관튜브' }, 'skin tear': { en: 'skin tear', ko: '피부 찢김' } } };
  const m = mergeTranslation(local, remote);
  assert(m.terms['endotracheal tube'].ko === '기관내관' && m.terms['skin tear'].ko === '피부 찢김', JSON.stringify(m.terms));
  const old = mergeTranslation({ segVersion: 1, items: { a: { t: 'A' } } }, remote); // an older file without terms
  assert(old.terms && Object.keys(old.terms).length === 2, `remote terms kept: ${JSON.stringify(old)}`);
  const none = mergeTranslation({ segVersion: 1, items: {} }, { segVersion: 1, items: {} });
  assert(!('terms' in none), 'no terms field invented');
  return JSON.stringify(m.terms);
});

await test('regression library-tie-reverts-remote-fields: a 3-way-merged item supersedes both sides (no revert on the next write)', () => {
  // Laptop renamed P at t=2000; the desktop touched P (lastOpenedAt) at t=3000 before pulling.
  const base = { version: 1, folders: [], papers: [{ id: 'P', title: 'Old', lastOpenedAt: 1000, updatedAt: 1000 }] };
  const desktop = { version: 1, folders: [], papers: [{ id: 'P', title: 'Old', lastOpenedAt: 3000, updatedAt: 3000 }] };
  const laptop = { version: 1, folders: [], papers: [{ id: 'P', title: 'New', lastOpenedAt: 1000, updatedAt: 2000 }] };
  const stored = mergeLibrary(desktop, laptop, base); // what the pull stores on the desktop
  const p = stored.papers[0];
  assert(p.title === 'New' && p.lastOpenedAt === 3000 && p.updatedAt === 3001, `pull merge: ${JSON.stringify(p)}`);
  // The in-memory library (still the pre-pull object) merging without a base must not keep 'Old' on a tie,
  // and the next base-less write of that stale memory must not revert the stored rename either.
  const absorbed = mergeLibrary(desktop, stored, null).papers[0];
  assert(absorbed.title === 'New' && absorbed.lastOpenedAt === 3000, `absorb kept the stale title: ${JSON.stringify(absorbed)}`);
  // With the base the library now passes, a newer local edit of another field keeps the remote rename too.
  const later = { version: 1, folders: [], papers: [{ id: 'P', title: 'Old', lastOpenedAt: 4000, updatedAt: 4000 }] };
  const w2 = mergeLibrary(later, stored, desktop).papers[0];
  assert(w2.title === 'New' && w2.lastOpenedAt === 4000, `3-way with base: ${JSON.stringify(w2)}`);
  return JSON.stringify({ stored: p, later: w2 });
});

await test('mergeAi: one-sided key changes survive (3-way), both-sided → newer file', () => {
  const base = { version: 1, updatedAt: 1, summary: { markdown: 'old' }, chat: [] };
  const l = { version: 1, updatedAt: 5, summary: { markdown: 'new' }, chat: [] };
  const r = { version: 1, updatedAt: 6, summary: { markdown: 'old' }, chat: [{ id: 'm1' }] };
  const m = mergeAi(l, r, base);
  assert(m.summary.markdown === 'new' && m.chat.length === 1, JSON.stringify(m));
  const noBase = mergeAi(l, r, null);
  assert(noBase.summary.markdown === 'old', 'without base the newer file wins shared keys');
  return JSON.stringify(m);
});

await test('regression stale-ai-snapshot-overwrites: mergeAi unions chat/explanations by id (even without a base); clears stick', () => {
  const office = { version: 1, updatedAt: 9, chat: [{ id: 'm1', role: 'user', ts: 1 }, { id: 'm3', role: 'user', ts: 30 }], explanations: [{ id: 'x1', createdAt: 5 }] };
  const home = { version: 1, updatedAt: 8, chat: [{ id: 'm1', role: 'user', ts: 1 }, { id: 'm2', role: 'user', ts: 20 }], explanations: [{ id: 'x2', createdAt: 6 }] };
  const m = mergeAi(office, home, null);
  assert(m.chat.map((x) => x.id).join() === 'm1,m2,m3', `chat union in time order: ${JSON.stringify(m.chat)}`);
  assert(m.explanations.map((x) => x.id).join() === 'x1,x2', JSON.stringify(m.explanations));
  const cleared = mergeAi({ version: 1, updatedAt: 50, chat: [], chatClearedAt: 40 }, home, home);
  assert(cleared.chat.length === 0 && cleared.chatClearedAt === 40, `clear must not be undone by the union: ${JSON.stringify(cleared)}`);
  const after = mergeAi(cleared, { ...home, chat: [...home.chat, { id: 'm9', ts: 45 }] }, null);
  assert(after.chat.map((x) => x.id).join() === 'm9', `messages after the clear survive: ${JSON.stringify(after.chat)}`);
  // Both sides regenerated the summary: the newer createdAt wins regardless of the file stamps (clock skew).
  const s = mergeAi({ version: 1, updatedAt: 100, summary: { markdown: 'B', createdAt: 9_999_000 } },
    { version: 1, updatedAt: 10_000_000, summary: { markdown: 'A', createdAt: 9_000_000 } }, null);
  assert(s.summary.markdown === 'B', JSON.stringify(s));
  return `union=${m.chat.map((x) => x.id)}; cleared=${cleared.chat.length}`;
});

await test('paths: personal prefix only moves annotations/ai; mergerFor gives people/<id>/… files the same merge rules', () => {
  const pre = 'people/0123456789abcdef/';
  assert(dataPath('p_1', 'translation', pre) === 'papers/p_1/translation.json' && paperPath('p_1', 'paper.pdf') === 'papers/p_1/paper.pdf', 'shared files');
  assert(dataPath('p_1', 'annotations', pre) === `${pre}papers/p_1/annotations.json` && dataPath('p_1', 'ai', pre) === `${pre}papers/p_1/ai.json`, 'personal files');
  assert(dataPath('p_1', 'annotations') === 'papers/p_1/annotations.json', '내 서재 unchanged');
  let threw = false;
  try { dataPath('p_1', 'notes'); } catch { threw = true; }
  assert(threw, 'unknown kind');
  const rules = {
    'library.json': mergeLibrary,
    'papers/p_1/annotations.json': mergeAnnotations,
    'papers/p_1/translation.json': mergeTranslation,
    'papers/p_1/ai.json': mergeAi,
    [`${pre}papers/p_1/annotations.json`]: mergeAnnotations,
    [`${pre}papers/p_1/ai.json`]: mergeAi,
    'papers/p_1/paper.pdf': null,
    [`${pre}papers/p_1/paper.pdf`]: null,
    'people/x/library.json': null,
    'README.md': null,
  };
  for (const [path, rule] of Object.entries(rules)) assert(mergerFor(path) === rule, `mergerFor(${path})`);
  return `${Object.keys(rules).length} paths mapped to the expected merge rule`;
});

// ------------------------------------------------------- GitHub client

const fake = await startFakeGitHub({ port: 0 });
fake.addToken('good', { write: true });
fake.addToken('reader', { write: false });
fake.createRepo('me', 'lib', { private: true });
fake.createRepo('me', 'pub', { private: false, files: { 'a.txt': 'x' } });
fake.createRepo('me', 'thesis', { private: true, files: { 'chapter1.md': '# 1', 'library.json': '{}' } });
const client = (o = {}) => new GitHubClient({ owner: 'me', repo: 'lib', token: 'good', apiBase: fake.url, rateLimitMaxWaitMs: 5000, ...o });

try {
  await test('checkAccess: bad token → 401 Korean message', async () => {
    const r = await client({ token: 'nope' }).checkAccess();
    assert(!r.ok && /토큰/.test(r.message) && r.code === 'auth', JSON.stringify(r));
    return r.message;
  });
  await test('checkAccess: unknown repo → 404 Korean message', async () => {
    const r = await client({ repo: 'missing' }).checkAccess();
    assert(!r.ok && /찾을 수 없거나/.test(r.message), JSON.stringify(r));
    return r.message;
  });
  await test('checkAccess: public repo → repoPrivate=false with warning', async () => {
    const r = await client({ repo: 'pub' }).checkAccess();
    assert(r.ok && r.repoPrivate === false && /공개/.test(r.message), JSON.stringify(r));
    return r.message;
  });
  await test('checkAccess: enterprise "internal" repo is not private', async () => {
    fake.createRepo('me', 'org-internal', { private: true, visibility: 'internal' });
    const r = await client({ repo: 'org-internal' }).checkAccess();
    assert(r.ok && r.repoPrivate === false && r.visibility === 'internal' && /내부/.test(r.message), JSON.stringify(r));
    return r.message;
  });
  await test('checkAccess: classic ghp_ token → broad-token warning', async () => {
    fake.addToken('ghp_classic', { write: true });
    const r = await client({ repo: 'thesis', token: 'ghp_classic' }).checkAccess();
    assert(r.ok && r.broadToken === true && /Classic 토큰/.test(r.message), JSON.stringify(r));
    return r.message;
  });
  await test('checkAccess: read-only token → canPush=false (write probe)', async () => {
    const r = await client({ repo: 'thesis', token: 'reader' }).checkAccess();
    assert(r.ok && r.canPush === false && /Read and write/.test(r.message), JSON.stringify(r));
    return r.message;
  });
  await test('checkAccess: repo with unrelated files → foreign warning', async () => {
    const r = await client({ repo: 'thesis' }).checkAccess();
    assert(r.ok && r.foreign === true && /관계없는 파일/.test(r.message), JSON.stringify(r));
    return r.message;
  });
  await test('checkAccess: empty private repo → ok, empty', async () => {
    const r = await client().checkAccess();
    assert(r.ok && r.repoPrivate && r.canPush && r.empty, JSON.stringify(r));
    return r.message;
  });
  await test('checkAccess: invalid owner name → Korean message, no request', async () => {
    const before = fake.log.length;
    const r = await client({ owner: 'bad owner' }).checkAccess();
    assert(!r.ok && /소유자/.test(r.message) && fake.log.length === before, JSON.stringify(r));
    return r.message;
  });

  await test('empty repo: getHead → null; commit bootstraps README (409 → contents API) then commits', async () => {
    const c = client();
    assert((await c.getHead()) === null, 'expected null head');
    const res = await c.commit([{ path: 'library.json', text: '{"version":1}' }, { path: 'papers/p1/paper.pdf', bytes: new Uint8Array([37, 80, 68, 70, 45]) }], 'first', { parent: null });
    const commits = fake.commits('me', 'lib');
    assert(commits.length === 2 && commits[1].changed.join() === 'README.md', JSON.stringify(commits));
    assert(commits[0].changed.join() === 'library.json,papers/p1/paper.pdf', JSON.stringify(commits[0]));
    const head = await c.getHead();
    assert(head.commitSha === res.commitSha && head.treeSha === res.treeSha, 'head mismatch');
    const tree = await c.listTree(head.treeSha);
    assert([...tree.keys()].sort().join() === 'README.md,library.json,papers/p1/paper.pdf', [...tree.keys()].join());
    return `commits=${commits.length} tree=${[...tree.keys()].join(',')}`;
  });

  await test('getHead uses ETag: unchanged branch → 304', async () => {
    const c = client();
    await c.getHead();
    fake.clearLog();
    await c.getHead();
    const ref = fake.log.filter((e) => e.path.includes('/git/ref/'));
    assert(ref.length === 1 && ref[0].status === 304 && fake.log.length === 1, JSON.stringify(fake.log));
    return 'second getHead = one 304 request';
  });

  await test('readBlob: raw bytes verified by sha; 1 MB random round-trips', async () => {
    const c = client();
    const bytes = new Uint8Array(1 << 20);
    for (let i = 0; i < bytes.length; i += 65536) crypto.getRandomValues(bytes.subarray(i, i + 65536));
    const head = await c.getHead();
    const res = await c.commit([{ path: 'big.bin', bytes }], 'big', { parent: head.commitSha });
    const tree = await c.listTree(res.treeSha);
    const sha = tree.get('big.bin').sha;
    assert(sha === (await gitBlobSha(bytes)), 'blob sha mismatch');
    const back = await c.readBlob(sha);
    assert(back.length === bytes.length && back.every((b, i) => b === bytes[i]), 'bytes differ');
    return `sha=${sha.slice(0, 10)} size=${back.length}`;
  });

  await test('commit on a stale parent → GitHubConflictError (422 non-fast-forward)', async () => {
    const c = client();
    const head = await c.getHead();
    fake.commitFiles('me', 'lib', { 'other.txt': 'from another device' });
    let caught = null;
    try { await c.commit([{ path: 'x.txt', text: 'x' }], 'stale', { parent: head.commitSha, baseTree: head.treeSha }); } catch (err) { caught = err; }
    assert(caught instanceof GitHubConflictError, `expected conflict, got ${caught}`);
    const patch = fake.log.filter((e) => e.method === 'PATCH').at(-1);
    assert(patch.status === 422, 'fake should have answered 422');
    return caught.message;
  });

  await test('commit to a protected branch (422 rule violation) → fatal "protected", not an endless conflict', async () => {
    const c = client();
    const head = await c.getHead();
    fake.failNext({ method: 'PATCH', path: /\/git\/refs\/heads\//, status: 422, body: { message: 'Repository rule violations found. Changes must be made through a pull request.' } });
    let caught = null;
    try { await c.commit([{ path: 'y.txt', text: 'y' }], 'protected', { parent: head.commitSha, baseTree: head.treeSha }); } catch (err) { caught = err; }
    assert(caught && !(caught instanceof GitHubConflictError) && caught.code === 'protected' && /보호 규칙/.test(caught.message), String(caught));
    return caught.message;
  });

  await test('rate limit: 429 retry-after:1 is waited out; 403 with far reset throws rate_limit + retryAt', async () => {
    const c = client();
    fake.failNext({ method: 'GET', path: /\/git\/ref\//, status: 429, headers: { 'Retry-After': '1' }, body: { message: 'You have exceeded a secondary rate limit' } });
    const t0 = Date.now();
    const head = await c.getHead();
    const waited = Date.now() - t0;
    assert(head && waited >= 1000, `should wait ≥1s (waited ${waited})`);
    const reset = Math.floor(Date.now() / 1000) + 3600;
    fake.failNext({ path: /\/git\/ref\//, status: 403, headers: { 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset': String(reset) }, body: { message: 'API rate limit exceeded' } });
    let caught = null;
    try { await client().getHead(); } catch (err) { caught = err; }
    assert(caught?.code === 'rate_limit' && caught.retryAt >= reset * 1000 - 1000 && /한도/.test(caught.message), String(caught));
    return `waited ${waited} ms; then: ${caught.message}`;
  });

  await test('proxy mode (공용 서재): relay\'s Korean messages shown as is, invite-code wording otherwise; a stale base (409/422 on trees/commits) is a conflict; an invalid address never falls back to api.github.com', async () => {
    const proxy = (o = {}) => new GitHubClient({ owner: 'me', repo: 'lib', token: 'good', apiBase: fake.url, rateLimitMaxWaitMs: 5000, proxy: true, ...o });
    const own = await proxy({ token: 'nope' }).checkAccess({ quick: true });
    assert(!own.ok && own.code === 'auth' && /초대 코드가 올바르지 않거나/.test(own.message), JSON.stringify(own));
    fake.failNext({ method: 'GET', path: /\/repos\/me\/lib$/, status: 401, body: { message: '초대 코드가 올바르지 않거나 사용이 중지되었습니다.' } });
    const relayMsg = await proxy().checkAccess({ quick: true });
    assert(relayMsg.message === '초대 코드가 올바르지 않거나 사용이 중지되었습니다.', relayMsg.message);
    fake.failNext({ method: 'POST', path: /\/git\/blobs$/, status: 403, body: { message: '공용 서재에 둘 수 없는 경로입니다: x' } });
    let caught = null;
    try { await proxy().createBlob(new Uint8Array([1])); } catch (err) { caught = err; }
    assert(caught?.code === 'forbidden' && caught.message === '공용 서재에 둘 수 없는 경로입니다: x', String(caught));

    const head = await proxy().getHead();
    const conflicts = [];
    for (const [path, status] of [[/\/git\/trees$/, 409], [/\/git\/commits$/, 409], [/\/git\/commits$/, 422]]) {
      fake.failNext({ method: 'POST', path, status, body: { message: 'stale' } });
      let err = null;
      try { await proxy().commit([{ path: 'z.txt', text: 'z' }], 'm', { parent: head.commitSha, baseTree: head.treeSha }); } catch (e) { err = e; }
      assert(err instanceof GitHubConflictError, `${status} on ${path}: ${err}`);
      conflicts.push(`${status} ${path.source.replace(/\\/g, '')}`);
    }
    fake.failNext({ method: 'POST', path: /\/git\/trees$/, status: 409, body: { message: 'Git Repository is empty.' } });
    let plain = null;
    try { await client().commit([{ path: 'z.txt', text: 'z' }], 'm', { parent: head.commitSha, baseTree: head.treeSha }); } catch (e) { plain = e; }
    assert(plain && !(plain instanceof GitHubConflictError) && plain.code === 'empty', `GitHub mode keeps its meaning: ${plain}`);

    const before = fake.log.length;
    const badBase = proxy({ apiBase: 'https://user:pw@relay.example/x' });
    const bad = await badBase.checkAccess({ quick: true });
    assert(badBase.apiBase === '' && !bad.ok && /서버 주소가 올바르지 않습니다/.test(bad.message) && fake.log.length === before, JSON.stringify(bad));
    for (const apiBase of [undefined, '', 'https://api.github.com', 'https://uploads.github.com/x']) {
      let cfgErr = null;
      try { await proxy({ apiBase }).getHead(); } catch (e) { cfgErr = e; }
      assert(cfgErr?.code === 'config', `proxy apiBase ${apiBase}: ${cfgErr}`);
    }
    assert(fake.log.length === before && external.length === 0, `requests: ${fake.log.length - before}, external ${external}`);
    return `401 → “${own.message}”; conflicts: ${conflicts.join(', ')}; invalid / missing / GitHub address → config error, 0 requests`;
  });

  await test('5xx is retried; server down → network error (Korean)', async () => {
    fake.failNext({ path: /\/git\/ref\//, status: 502, count: 1 });
    assert(await client().getHead(), 'should recover after one 502');
    fake.setDown(true);
    let caught = null;
    try { await client().getHead(); } catch (err) { caught = err; }
    fake.setDown(false);
    assert(caught?.code === 'network' && /인터넷|접속/.test(caught.message), String(caught));
    return caught.message;
  });
} finally {
  await fake.close();
}

writeFileSync(`${OUT}/unit.results.json`, JSON.stringify(results, null, 2));
const failed = results.filter((r) => r.result !== 'pass').length;
console.log(`\nstore unit: ${results.length - failed}/${results.length} passed · blocked external requests: ${external.length}${external.length ? ` (${external.join(', ')})` : ''}`);
process.exitCode = failed || external.length ? 1 : 0;
