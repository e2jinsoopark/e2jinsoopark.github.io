// Test double of the relay's shared-library endpoints (docs/SHARED.md §2.1–§2.2), in front of the fake GitHub
// (tests/store/fake-github.mjs). It enforces the contract's rules so store tests catch a client that would be
// refused by the real Worker: path allowlist, deletes only under people/<me>/, people/ filtering of trees,
// base_tree / parents on the current head (stale → 409), force:false, README only on an empty repo, message
// rewrite `[name] …`, and never forwarding the invite code. The integrator tests against the real Worker.
//
//   const relay = await startFakeRelay({ github: fake, owner: 'dindoopark', repo: 'paper-team-library', token: 'ghp_team' });
//   relay.addCode('PR-AAAA-BBBB', '김동료');
//   → openSharedLibrary({ relayUrl: relay.url, code: 'PR-AAAA-BBBB', ... })
import { createHash } from 'node:crypto';
import http from 'node:http';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, Accept, X-GitHub-Api-Version, If-None-Match',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, PUT, OPTIONS',
  'Access-Control-Expose-Headers': 'ETag, Retry-After, X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset',
  'Access-Control-Max-Age': '600',
};
const ID = '[A-Za-z0-9_-]{1,64}';
const PASS_HEADERS = ['etag', 'content-type', 'retry-after', 'x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset'];

/** Same normalisation as relay/src/codes.js normalizeCode. */
export function normalizeCode(raw) {
  const compact = String(raw || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
  if (compact.length !== 10 || !compact.startsWith('PR')) return '';
  const body = compact.slice(2).replace(/O/g, '0').replace(/[IL]/g, '1');
  const code = `PR-${body.slice(0, 4)}-${body.slice(4)}`;
  return /^PR-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/.test(code) ? code : '';
}

export const personIdOf = (code) => createHash('sha256').update(normalizeCode(code)).digest('hex').slice(0, 16);

export async function startFakeRelay({ github, owner, repo, token, branch = 'main', lib = 'team', libName = '공용 서재', port = 0, host = '127.0.0.1' }) {
  const codes = new Map(); // normalised code → { name, personId, active }
  const recentTrees = new Map(); // tree sha → time it was handed to a client
  const log = [];
  const ghBase = `${github.url}/repos/${owner}/${repo}`;

  const repoObj = () => github.repo(owner, repo);
  const head = () => repoObj().refs.get(`heads/${branch}`) ?? null;
  const headTree = () => {
    const h = head();
    return h ? repoObj().get(h, 'commit').tree : null;
  };

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      console.error('[fake-relay]', err);
      if (!res.headersSent) json(res, 500, { message: `fake relay error: ${err.message}` });
    });
  });
  const sockets = new Set();
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });

  async function handle(req, res) {
    const url = new URL(req.url, 'http://relay');
    if (req.method === 'OPTIONS') { res.writeHead(204, CORS); res.end(); return; }
    const body = await readBody(req);
    const raw = /^Bearer (.+)$/i.exec(req.headers.authorization || '')?.[1]?.trim() || '';
    const who = codes.get(normalizeCode(raw));
    const entry = { method: req.method, path: url.pathname, query: url.search, status: 0, code: raw, at: Date.now(), bytesIn: body.length };
    log.push(entry);
    const reply = (status, data, headers) => { entry.status = status; json(res, status, data, headers); };
    if (!who || !who.active) { reply(401, { message: '초대 코드가 올바르지 않거나 사용이 중지되었습니다.' }); return; }

    if (url.pathname === '/shared' && req.method === 'GET') {
      reply(200, { libraries: [{ id: lib, name: libName }], personId: who.personId, name: who.name });
      return;
    }
    if (url.pathname === `/shared/${lib}/activity` && req.method === 'GET') {
      const limit = Math.min(200, Number(url.searchParams.get('limit')) || 50);
      const items = github.commits(owner, repo, branch).slice(0, limit).map((c) => {
        const m = /^\[([^\]]+)\]\s?(.*)$/.exec(c.message.split('\n')[0]);
        return { ts: c.time ?? null, who: m ? m[1] : null, summary: m ? m[2] : c.message.split('\n')[0] };
      });
      reply(200, { items });
      return;
    }
    const prefix = `/shared/${lib}/gh/repos/team/library`;
    if (!url.pathname.startsWith(prefix)) { reply(404, { message: 'Not Found' }); return; }
    const rest = url.pathname.slice(prefix.length);
    const me = who.personId;
    const deny = (message) => reply(403, { message });
    const stale = () => reply(409, { message: '다른 사람이 먼저 저장했습니다. 다시 받아서 합칩니다.' });
    let m;

    if (rest === '' && req.method === 'GET') {
      reply(200, { name: 'library', full_name: 'team/library', private: true, visibility: 'private', default_branch: branch, permissions: { pull: true, push: true } });
      return;
    }
    if ((m = /^\/git\/ref\/heads\/(.+)$/.exec(rest)) && req.method === 'GET') { await forward(req, res, entry, rest, body); return; }
    if (/^\/git\/commits\/[0-9a-f]{40}$/.test(rest) && req.method === 'GET') { await forward(req, res, entry, rest, body); return; }
    if ((m = /^\/git\/blobs\/[0-9a-f]{40}$/.exec(rest)) && req.method === 'GET') { await forward(req, res, entry, rest, body); return; }
    if ((m = /^\/git\/trees\/([0-9a-f]{40})$/.exec(rest)) && req.method === 'GET') {
      const out = await upstream('GET', `${rest}${url.search}`, null, req.headers);
      if (out.status !== 200) { send(res, entry, out); return; }
      const data = JSON.parse(out.body.toString('utf8'));
      const recursive = url.searchParams.has('recursive');
      const isPeopleTree = !recursive && peopleTreeSha() === m[1];
      data.tree = (data.tree || []).filter((e) => (isPeopleTree ? e.path === me : visibleTo(e.path, me)));
      recentTrees.set(m[1], Date.now());
      reply(200, data);
      return;
    }
    if (rest === '/git/blobs' && req.method === 'POST') {
      if (body.length > 100 * 1024 * 1024) { reply(413, { message: '파일이 너무 큽니다 (최대 100 MB).' }); return; }
      await forward(req, res, entry, rest, body);
      return;
    }
    if (rest === '/git/trees' && req.method === 'POST') {
      const data = parse(body);
      const current = headTree();
      if (current && data.base_tree !== current && !(recentTrees.get(data.base_tree) > Date.now() - 600_000)) { stale(); return; }
      for (const e of data.tree || []) {
        const keys = Object.keys(e).filter((k) => !['path', 'mode', 'type', 'sha'].includes(k));
        if (keys.length) { deny(`트리 항목 형식이 올바르지 않습니다: ${JSON.stringify(e)}`); return; }
        const allowed = e.path === 'library.json'
          || new RegExp(`^papers/${ID}/(paper\\.pdf|translation\\.json)$`).test(e.path)
          || new RegExp(`^people/${me}/papers/${ID}/(annotations|ai)\\.json$`).test(e.path);
        if (!allowed) { deny(`공용 서재에 둘 수 없는 경로입니다: ${e.path}`); return; }
        if (e.sha === null && !e.path.startsWith(`people/${me}/`)) { deny(`공용 서재에서는 이 파일을 지울 수 없습니다(삭제는 휴지통으로만 합니다): ${e.path}`); return; }
      }
      const out = await upstream('POST', rest, body, req.headers);
      if (out.status === 201) recentTrees.set(JSON.parse(out.body.toString('utf8')).sha, Date.now());
      send(res, entry, out);
      return;
    }
    if (rest === '/git/commits' && req.method === 'POST') {
      const data = parse(body);
      const h = head();
      const parents = Array.isArray(data.parents) ? data.parents : [];
      if (h ? !(parents.length === 1 && parents[0] === h) : parents.length) { stale(); return; }
      const first = String(data.message || '').split(/\r?\n/)[0];
      data.message = `[${who.name}] ${first}`.slice(0, 200);
      entry.message = data.message;
      send(res, entry, await upstream('POST', rest, Buffer.from(JSON.stringify(data)), req.headers));
      return;
    }
    if ((m = /^\/git\/refs\/heads\/(.+)$/.exec(rest)) && req.method === 'PATCH') {
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

  function peopleTreeSha() {
    const t = headTree();
    return t ? repoObj().get(t, 'tree').entries.find((e) => e.name === 'people' && e.type === 'tree')?.sha ?? null : null;
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
  return {
    url: `http://${host}:${actualPort}`,
    log,
    /** Register an invite code; returns its personId. */
    addCode(code, name, { active = true } = {}) {
      const normal = normalizeCode(code);
      if (!normal) throw new Error(`not an invite code: ${code}`);
      const personId = personIdOf(normal);
      codes.set(normal, { name, personId, active });
      return personId;
    },
    setActive(code, active) { codes.get(normalizeCode(code)).active = active; },
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
