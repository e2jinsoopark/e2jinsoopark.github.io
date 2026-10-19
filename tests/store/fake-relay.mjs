// Test double of the relay's shared-library endpoints (docs/SHARED.md §2.1–§2.2), in front of the fake GitHub
// (tests/store/fake-github.mjs). It enforces the contract's rules so store tests catch a client that would be
// refused by the real Worker: path allowlist, deletes only under people/<me>/, people/ filtering of trees,
// base_tree / parents on the current head (stale → 409), force:false, README only on an empty repo, message
// rewrite `[name] …`, and never forwarding the invite code. The integrator tests against the real Worker.
//
// With `codeLibraries: true` it also serves each invite code's own library (the code-library contract,
// 2026-10-19): `/shared/mine/gh/...` works in the repo folder `codes/<libraryId>/` of the same team repo
// (allowlist mirrored under that folder, people/ isolation inside it, nothing outside it in listings or blob
// reads), `/shared/<team>/gh/...` hides the whole `codes/` subtree and refuses writes there, commit messages
// become `[name] {lib:<team|libraryId>} …`, and `/shared/<lib>/activity` lists only that library's commits
// (marker removed). Both: library.json records may only be tombstoned, never dropped; an existing paper.pdf
// never changes; blobs are served only when the caller was shown them or uploaded them.
//
//   const relay = await startFakeRelay({ github: fake, owner: 'dindoopark', repo: 'paper-team-library', token: 'ghp_team',
//                                        codeLibraries: true, libName: '전체 공용 서재' });
//   relay.addCode('PR-AAAA-BBBB', '김동료');          // → personId; relay.libraryIdOf(code) → its library folder id
//   → openSharedLibrary({ relayUrl: relay.url, code: 'PR-AAAA-BBBB', lib: 'mine', libraryId, ... })
import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';
import { codeKey, validateCustomCode } from '../../relay/src/codes.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, Accept, X-GitHub-Api-Version, If-None-Match',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, PUT, OPTIONS',
  'Access-Control-Expose-Headers': 'ETag, Retry-After, X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset',
  'Access-Control-Max-Age': '600',
};
const ID = '[A-Za-z0-9_-]{1,64}';
const PASS_HEADERS = ['etag', 'content-type', 'retry-after', 'x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset'];
const RECENT_MS = 600_000;
/** The relay's marker of which library a commit belongs to: `[name] {lib:<team|libraryId>} summary`. */
const MARKER_RE = /^\{lib:([A-Za-z0-9_-]{1,64})\}\s?/;
export const CODE_LIBRARY = 'mine';

/** A GENERATED code's canonical form ("PR-XXXX-XXXX"), or '' (relay/src/codes.js normalizeCode). */
export function normalizeCode(raw) {
  const parsed = codeKey(raw);
  return parsed?.generated ? parsed.code : '';
}

/**
 * The stored form of a code, as the Worker keeps it: a generated code canonical, a custom (owner-chosen) code as
 * validateCustomCode spells it ("eicu2 2026" → "EICU2-2026"). '' when it cannot be a code.
 */
export function storedCode(raw) {
  const parsed = codeKey(raw);
  if (!parsed) return '';
  return parsed.generated ? parsed.code : (validateCustomCode(String(raw)).code || '');
}

/** personId (SHARED.md §1, without PERSON_ID_SECRET): SHA-256 of the stored code, first 16 hex characters. */
export const personIdOf = (code) => createHash('sha256').update(storedCode(code)).digest('hex').slice(0, 16);

/** Is `inner` (a path inside one library: its root or its code folder) a file the library may hold, for person `me`? */
export function allowedLibraryPath(inner, me) {
  return inner === 'library.json'
    || new RegExp(`^papers/${ID}/(paper\\.pdf|translation\\.json)$`).test(inner)
    || new RegExp(`^people/${me}/papers/${ID}/(annotations|ai)\\.json$`).test(inner);
}

export async function startFakeRelay({
  github, owner, repo, token, branch = 'main', lib = 'team', libName = '공용 서재', codeLibraries = false,
  codeMaxBytes = 500 * 1024 * 1024, port = 0, host = '127.0.0.1',
}) {
  const codes = new Map(); // code key (letters and digits, relay/src/codes.js codeKey) → { code, name, personId, active, libraryId }
  const recentTrees = new Map(); // tree sha → time it was handed to (or made by) a client
  const recentRoots = new Map(); // root tree sha → time (heads and trees made through the proxy)
  const uploads = new Map(); // `${personId}\n${blob sha}` → time (blobs a person uploaded)
  const listed = new Map(); // `${personId}\n${blob sha}` → time (blobs shown in a level-by-level listing)
  const log = [];
  const ghBase = `${github.url}/repos/${owner}/${repo}`;

  const repoObj = () => github.repo(owner, repo);
  const head = () => repoObj().refs.get(`heads/${branch}`) ?? null;
  const headTree = () => {
    const h = head();
    return h ? repoObj().get(h, 'commit').tree : null;
  };
  const recent = (map, key) => (map.get(key) ?? 0) > Date.now() - RECENT_MS;

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      console.error('[fake-relay]', err);
      if (!res.headersSent) json(res, 500, { message: `fake relay error: ${err.message}` });
    });
  });
  const sockets = new Set();
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });

  /** The library a request is for: { id, marker, root ('' or 'codes/<libraryId>'), name }; null when unknown. */
  function libraryFor(id, who) {
    if (id === lib) return { id, marker: lib, root: '', name: libName, kind: 'team' };
    if (codeLibraries && id === CODE_LIBRARY && who.libraryId) {
      return { id, marker: who.libraryId, root: `codes/${who.libraryId}`, name: `${who.name} 서재`, kind: 'code' };
    }
    return null;
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://relay');
    if (req.method === 'OPTIONS') { res.writeHead(204, CORS); res.end(); return; }
    const body = await readBody(req);
    const raw = /^Bearer (.+)$/i.exec(req.headers.authorization || '')?.[1]?.trim() || '';
    const who = codes.get(codeKey(raw)?.key ?? '');
    const entry = { method: req.method, path: url.pathname, query: url.search, status: 0, code: raw, at: Date.now(), bytesIn: body.length };
    log.push(entry);
    const reply = (status, data, headers) => { entry.status = status; json(res, status, data, headers); };
    if (!who || !who.active) { reply(401, { message: '초대 코드가 올바르지 않거나 사용이 중지되었습니다.' }); return; }

    if (url.pathname === '/shared' && req.method === 'GET') {
      if (!codeLibraries) {
        reply(200, { libraries: [{ id: lib, name: libName }], personId: who.personId, name: who.name });
        return;
      }
      reply(200, {
        libraries: [{ id: CODE_LIBRARY, name: `${who.name} 서재`, kind: 'code' }, { id: lib, name: libName, kind: 'team' }],
        personId: who.personId,
        name: who.name,
        libraryId: who.libraryId,
      });
      return;
    }
    let m = /^\/shared\/([A-Za-z0-9_-]{1,64})\/activity$/.exec(url.pathname);
    if (m && req.method === 'GET') {
      const target = libraryFor(m[1], who);
      if (!target) { reply(404, { message: 'Not Found' }); return; }
      const limit = Math.min(200, Number(url.searchParams.get('limit')) || 50);
      const items = [];
      for (const c of github.commits(owner, repo, branch)) {
        if (items.length >= limit) break;
        const first = c.message.split('\n')[0];
        const named = /^\[([^\]]+)\]\s?(.*)$/.exec(first);
        let summary = named ? named[2] : first;
        const mark = MARKER_RE.exec(summary);
        // Commits without a marker (from before code libraries, server commits) belong to the team library.
        const of = mark ? mark[1] : lib;
        if (of !== target.marker) continue;
        if (mark) summary = summary.slice(mark[0].length);
        items.push({ ts: c.time ?? null, who: named ? named[1] : null, summary });
      }
      reply(200, { items });
      return;
    }
    m = /^\/shared\/([A-Za-z0-9_-]{1,64})\/gh\/repos\/team\/library(\/.*)?$/.exec(url.pathname);
    const L = m ? libraryFor(m[1], who) : null;
    if (!L) { reply(404, { message: 'Not Found' }); return; }
    const rest = m[2] || '';
    const me = who.personId;
    const deny = (message) => reply(403, { message });
    const stale = () => reply(409, { message: '다른 사람이 먼저 저장했습니다. 다시 받아서 합칩니다.' });
    /** Path inside this library (relative to its folder), or null when the repo path lies outside it. */
    const inner = (path) => (!L.root ? (path === 'codes' || path.startsWith('codes/') ? null : path)
      : path.startsWith(`${L.root}/`) ? path.slice(L.root.length + 1) : null);
    /** May the caller see repo path `path` (file or directory) in listings? */
    const visible = (path) => {
      if (L.root && (path === L.root || L.root.startsWith(`${path}/`))) return true; // the way down to the folder
      const i = inner(path);
      return i !== null && visibleTo(i, me);
    };

    if (rest === '' && req.method === 'GET') {
      reply(200, { name: 'library', full_name: 'team/library', private: true, visibility: 'private', default_branch: branch, permissions: { pull: true, push: true } });
      return;
    }
    if (/^\/git\/ref\/heads\/(.+)$/.test(rest) && req.method === 'GET') {
      const out = await upstream('GET', rest, null, req.headers);
      if (out.status === 200) {
        const sha = JSON.parse(out.body.toString('utf8'))?.object?.sha;
        const c = sha && repoObj().get(sha, 'commit');
        if (c) recentRoots.set(c.tree, Date.now());
      }
      send(res, entry, out);
      return;
    }
    if (/^\/git\/commits\/[0-9a-f]{40}$/.test(rest) && req.method === 'GET') { await forward(req, res, entry, rest, body); return; }
    if ((m = /^\/git\/blobs\/([0-9a-f]{40})$/.exec(rest)) && req.method === 'GET') {
      if (!blobVisible(m[1], me, visible)) { reply(404, { message: 'Not Found' }); return; }
      await forward(req, res, entry, rest, body);
      return;
    }
    if ((m = /^\/git\/trees\/([0-9a-f]{40})$/.exec(rest)) && req.method === 'GET') {
      const where = locateTree(m[1]).filter((p) => p === '' || visible(p));
      if (!where.length) { reply(404, { message: 'Not Found' }); return; }
      const out = await upstream('GET', `${rest}${url.search}`, null, req.headers);
      if (out.status !== 200) { send(res, entry, out); return; }
      const data = JSON.parse(out.body.toString('utf8'));
      const at = where[0];
      data.tree = (data.tree || []).filter((e) => visible(at ? `${at}/${e.path}` : e.path));
      if (!url.searchParams.has('recursive')) {
        for (const e of data.tree) if (e.type === 'blob') listed.set(`${me}\n${e.sha}`, Date.now());
      }
      recentTrees.set(m[1], Date.now());
      reply(200, data);
      return;
    }
    if (rest === '/git/blobs' && req.method === 'POST') {
      if (body.length > 100 * 1024 * 1024) { reply(413, { message: '파일이 너무 큽니다 (최대 100 MB).' }); return; }
      if (L.root) {
        const content = parse(body).content || '';
        const approx = Math.floor((content.length * 3) / 4);
        const pdfish = /^JVBERi0/.test(content) || approx > 8 * 1024 * 1024;
        if (pdfish && folderBytes(L.root) + approx > (who.maxBytes ?? codeMaxBytes)) {
          const cap = who.maxBytes ?? codeMaxBytes;
          const size = cap >= 1024 * 1024 ? `${Math.round(cap / 1024 / 1024)} MB` : `${Math.round(cap / 1024)} KB`;
          reply(413, { message: `${L.name}의 용량(${size})을 넘어 더 올릴 수 없습니다.` });
          return;
        }
      }
      const out = await upstream('POST', rest, body, req.headers);
      if (out.status === 201) uploads.set(`${me}\n${JSON.parse(out.body.toString('utf8')).sha}`, Date.now());
      send(res, entry, out);
      return;
    }
    if (rest === '/git/trees' && req.method === 'POST') {
      const data = parse(body);
      const current = headTree();
      if (current && data.base_tree !== current && !recent(recentRoots, data.base_tree)) { stale(); return; }
      const base = data.base_tree ? repoObj().flatten(data.base_tree) : new Map();
      for (const e of data.tree || []) {
        const keys = Object.keys(e).filter((k) => !['path', 'mode', 'type', 'sha'].includes(k));
        if (keys.length) { deny(`트리 항목 형식이 올바르지 않습니다: ${JSON.stringify(e)}`); return; }
        const i = typeof e.path === 'string' ? inner(e.path) : null;
        if (i === null || !allowedLibraryPath(i, me)) { deny(`${L.name}에 둘 수 없는 경로입니다: ${e.path}`); return; }
        if (e.sha === null && !i.startsWith(`people/${me}/`)) { deny(`${L.name}에서는 이 파일을 지울 수 없습니다(삭제는 휴지통으로만 합니다): ${e.path}`); return; }
        if (/\/paper\.pdf$/.test(i) && base.has(e.path) && base.get(e.path).sha !== e.sha) { deny(`이미 있는 PDF는 바꿀 수 없습니다: ${e.path}`); return; }
        if (i === 'library.json' && e.sha) {
          const dropped = droppedRecords(base.get(e.path)?.sha, e.sha);
          if (dropped === null) { reply(422, { message: 'library.json을 읽을 수 없습니다.' }); return; }
          if (dropped.length) { deny(`서재 목록에서 항목을 지울 수 없습니다(삭제는 휴지통으로만 합니다): ${dropped.join(', ')}`); return; }
        }
      }
      const out = await upstream('POST', rest, body, req.headers);
      if (out.status === 201) {
        const sha = JSON.parse(out.body.toString('utf8')).sha;
        recentTrees.set(sha, Date.now());
        recentRoots.set(sha, Date.now());
      }
      send(res, entry, out);
      return;
    }
    if (rest === '/git/commits' && req.method === 'POST') {
      const data = parse(body);
      const h = head();
      const parents = Array.isArray(data.parents) ? data.parents : [];
      if (h ? !(parents.length === 1 && parents[0] === h) : parents.length) { stale(); return; }
      // The client's first line, without anything that looks like the relay's own library marker.
      const first = String(data.message || '').split(/\r?\n/)[0].replace(/\{\s*lib\s*:[^}]*\}\s?/gi, '');
      data.message = codeLibraries ? `[${who.name}] {lib:${L.marker}} ${first}`.slice(0, 200) : `[${who.name}] ${first}`.slice(0, 200);
      entry.message = data.message;
      send(res, entry, await upstream('POST', rest, Buffer.from(JSON.stringify(data)), req.headers));
      return;
    }
    if (/^\/git\/refs\/heads\/(.+)$/.test(rest) && req.method === 'PATCH') {
      if (parse(body).force) { deny('강제 덮어쓰기는 허용되지 않습니다.'); return; }
      await forward(req, res, entry, rest, body);
      return;
    }
    if (rest === '/git/refs' && req.method === 'POST') {
      if (head()) { deny('브랜치가 이미 있습니다.'); return; }
      await forward(req, res, entry, rest, body);
      return;
    }
    if (rest === '/contents/README.md' && req.method === 'PUT') {
      if (!repoObj().empty) { deny('README.md는 빈 저장소를 시작할 때만 만들 수 있습니다.'); return; }
      await forward(req, res, entry, rest, body);
      return;
    }
    reply(404, { message: 'Not Found' });
  }

  /** Repo paths ('' = the root) where tree `sha` sits in the head or a recent root tree. */
  function locateTree(sha) {
    const repoNow = repoObj();
    const out = new Set();
    const roots = new Set([headTree(), ...[...recentRoots.keys()].filter((k) => recent(recentRoots, k))].filter(Boolean));
    const walk = (treeSha, prefix, depth) => {
      if (treeSha === sha) out.add(prefix);
      if (depth > 12) return;
      for (const e of repoNow.get(treeSha, 'tree')?.entries || []) {
        if (e.type === 'tree') walk(e.sha, prefix ? `${prefix}/${e.name}` : e.name, depth + 1);
      }
    };
    for (const r of roots) walk(r, '', 0);
    return [...out];
  }

  /** Blob `sha` sits at a path visible to the caller in the head or a recent root, was listed to them, or is theirs. */
  function blobVisible(sha, me, visible) {
    if (recent(uploads, `${me}\n${sha}`) || recent(listed, `${me}\n${sha}`)) return true;
    const roots = new Set([headTree(), ...[...recentRoots.keys()].filter((k) => recent(recentRoots, k))].filter(Boolean));
    for (const r of roots) {
      for (const [path, f] of repoObj().flatten(r)) if (f.sha === sha && visible(path)) return true;
    }
    return false;
  }

  /** Approximate bytes of the files under repo folder `root` in the head. */
  function folderBytes(root) {
    const t = headTree();
    if (!t) return 0;
    let n = 0;
    for (const [path, f] of repoObj().flatten(t)) if (path.startsWith(`${root}/`)) n += repoObj().get(f.sha, 'blob')?.data.length ?? 0;
    return n;
  }

  /** Ids of folders/papers in library.json blob `before` that blob `after` no longer has; null when unreadable. */
  function droppedRecords(before, after) {
    const read = (sha) => {
      const b = sha && repoObj().get(sha, 'blob');
      if (!b) return undefined;
      try { return JSON.parse(b.data.toString('utf8')); } catch { return null; }
    };
    const next = read(after);
    if (!next || !Array.isArray(next.folders) || !Array.isArray(next.papers)) return next === undefined ? [] : null;
    const prev = read(before);
    if (!prev || !Array.isArray(prev.folders) || !Array.isArray(prev.papers)) return [];
    const ids = new Set([...next.folders, ...next.papers].map((x) => x?.id));
    return [...prev.folders, ...prev.papers].map((x) => x?.id).filter((id) => id && !ids.has(id));
  }

  async function upstream(method, rest, body, headers) {
    const h = {
      Authorization: `Bearer ${token}`, // never the invite code
      Accept: headers.accept || 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'paper-relay',
    };
    if (headers['if-none-match']) h['If-None-Match'] = headers['if-none-match'];
    if (body) h['Content-Type'] = 'application/json';
    const r = await fetch(`${ghBase}${rest}`, { method, headers: h, body: body && body.length ? body : undefined });
    const out = { status: r.status, headers: {}, body: Buffer.from(await r.arrayBuffer()) };
    for (const k of PASS_HEADERS) if (r.headers.has(k)) out.headers[k] = r.headers.get(k);
    return out;
  }

  async function forward(req, res, entry, rest, body) {
    send(res, entry, await upstream(req.method, rest, body.length ? body : null, req.headers));
  }

  function send(res, entry, out) {
    entry.status = out.status;
    res.writeHead(out.status, { ...CORS, ...out.headers });
    res.end(out.status === 304 ? undefined : out.body);
  }

  await new Promise((resolve) => server.listen(port, host, resolve));
  const actualPort = server.address().port;
  const rowOf = (code) => {
    const row = codes.get(codeKey(code)?.key ?? '');
    if (!row) throw new Error(`unknown code: ${code}`);
    return row;
  };
  return {
    url: `http://${host}:${actualPort}`,
    log,
    /**
     * Register an invite code; returns its personId. `libraryId`: its own library's folder id (default: 16 random
     * hex, as the Worker makes them); `maxBytes`: that library's size cap (default `codeMaxBytes`).
     */
    addCode(code, name, { active = true, libraryId, maxBytes } = {}) {
      const stored = storedCode(code);
      if (!stored) throw new Error(`not an invite code: ${code}`);
      const personId = personIdOf(stored);
      codes.set(codeKey(stored).key, { code: stored, name, personId, active, libraryId: libraryId || randomBytes(8).toString('hex'), maxBytes });
      return personId;
    },
    setActive(code, active) { rowOf(code).active = active; },
    /** The folder id of a code's own library (`codes/<libraryId>/`). */
    libraryIdOf(code) { return rowOf(code).libraryId; },
    /** Repo files of a code's own library, relative to its folder. */
    codeFiles(code) {
      const root = `codes/${rowOf(code).libraryId}/`;
      return [...github.files(owner, repo, branch).keys()].filter((p) => p.startsWith(root)).map((p) => p.slice(root.length)).sort();
    },
    /** Is this code (any spelling) registered here? */
    has(code) { return codes.has(codeKey(code)?.key ?? ''); },
    clearLog() { log.length = 0; },
    close() {
      for (const s of sockets) s.destroy();
      return new Promise((r) => server.close(() => r()));
    },
  };
}

/** Tree entry paths a person may see: everything except other people's people/<x> directories. */
function visibleTo(path, me) {
  if (path === 'people' || !path.startsWith('people/')) return true;
  const slash = path.indexOf('/', 7);
  return (slash === -1 ? path.slice(7) : path.slice(7, slash)) === me;
}

function parse(body) {
  try { return JSON.parse(body.toString('utf8') || '{}'); } catch { return {}; }
}

function json(res, status, data, headers = {}) {
  const payload = Buffer.from(JSON.stringify(data ?? null));
  res.writeHead(status, { ...CORS, 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': payload.length, ...headers });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
