// Store module — Node-level tests: merge rules (pure) and GitHubClient against the fake server.
//   node tests/store/unit.test.mjs
// Results: C:/Users/dindoo/Projects/pr-tools/out/store/unit.results.json
import { mkdirSync, writeFileSync } from 'node:fs';
import { startFakeGitHub } from './fake-github.mjs';
import { GitHubClient, GitHubConflictError, gitBlobSha } from '../../js/store/github.js';
import { deepEqual, mergeAi, mergeAnnotations, mergeLibrary, mergeRecords, mergeTranslation } from '../../js/store/sync.js';

const OUT = 'C:/Users/dindoo/Projects/pr-tools/out/store';
mkdirSync(OUT, { recursive: true });
const results = [];

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
  assert(m.p.deleted === true && m.p.translatedCount === 9 && m.p.updatedAt === 6, `delete should stick: ${JSON.stringify(m.p)}`);
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

await test('mergeTranslation: union, local wins per sid, newer segVersion replaces', () => {
  const m = mergeTranslation({ segVersion: 1, items: { s1: { t: 'L' }, s2: { t: 'L2' } } }, { segVersion: 1, items: { s1: { t: 'R' }, s3: { t: 'R3' } } });
  assert(m.items.s1.t === 'L' && m.items.s2 && m.items.s3, JSON.stringify(m));
  const v = mergeTranslation({ segVersion: 1, items: { a: 1 } }, { segVersion: 2, items: { b: 1 } });
  assert(deepEqual(v.items, { b: 1 }), 'segVersion 2 should replace');
  return 'ok';
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
console.log(`\nstore unit: ${results.length - failed}/${results.length} passed`);
process.exitCode = failed ? 1 : 0;
