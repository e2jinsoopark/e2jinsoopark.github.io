// In-memory fake of the GitHub REST endpoints used by js/store/github.js, for tests only.
// Real git object hashing (blob/tree/commit SHA-1), CORS, 409 on empty repos, 422 on non-fast-forward,
// ETag/304 on refs, rate-limit and outage simulation, the commit list (GET /repos/:o/:r/commits) and truncated
// recursive tree listings on request. Never talks to the real GitHub.
//
//   import { startFakeGitHub } from './fake-github.mjs';
//   const fake = await startFakeGitHub({ port: 8112 });
//   fake.addToken('ghp_test', { write: true });
//   fake.createRepo('me', 'papers', { private: true });            // empty repo (no commits)
//   → point the app at it: settings.github.apiBase = fake.url  (or routeGitHubToFake(context, fake.url))
//
// CLI (manual testing): node tests/store/fake-github.mjs --port 8112 --token ghp_test --repo me/papers
import { createHash } from 'node:crypto';
import http from 'node:http';
import { pathToFileURL } from 'node:url';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, Accept, X-GitHub-Api-Version, If-None-Match',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, PUT, DELETE, OPTIONS',
  'Access-Control-Expose-Headers': 'ETag, Retry-After, X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset, X-RateLimit-Used, X-RateLimit-Resource',
  'Access-Control-Max-Age': '600',
};

const sha1 = (buf) => createHash('sha1').update(buf).digest('hex');

function gitObject(type, body) {
  const buf = Buffer.concat([Buffer.from(`${type} ${body.length}\0`), body]);
  return sha1(buf);
}

class HttpError extends Error {
  constructor(status, message, headers = {}) {
    super(message);
    this.status = status;
    this.headers = headers;
  }
}

/** One repo's git objects and refs. */
class Repo {
  constructor(owner, name, { private: isPrivate = true, push = true, visibility = null } = {}) {
    this.owner = owner;
    this.name = name;
    this.private = isPrivate;
    this.visibility = visibility; // e.g. 'internal' (enterprise): private === true but visible to the org
    this.push = push;
    this.objects = new Map(); // sha → { type, data?: Buffer, entries?: [...], tree?, parents?, message? }
    this.refs = new Map(); // 'heads/main' → commit sha
  }

  get empty() { return this.refs.size === 0; }

  putBlob(buf) {
    const sha = gitObject('blob', buf);
    if (!this.objects.has(sha)) this.objects.set(sha, { type: 'blob', data: buf });
    return sha;
  }

  /** entries: [{ name, mode, sha, type }] */
  putTree(entries) {
    const sorted = [...entries].sort((a, b) => {
      const ka = a.type === 'tree' ? `${a.name}/` : a.name;
      const kb = b.type === 'tree' ? `${b.name}/` : b.name;
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
    const body = Buffer.concat(sorted.map((e) => Buffer.concat([
      Buffer.from(`${e.type === 'tree' ? '40000' : e.mode} ${e.name}\0`), Buffer.from(e.sha, 'hex'),
    ])));
    const sha = gitObject('tree', body);
    if (!this.objects.has(sha)) this.objects.set(sha, { type: 'tree', entries: sorted });
    return sha;
  }

  putCommit({ tree, parents, message, time = Math.floor(Date.now() / 1000) }) {
    const lines = [`tree ${tree}`, ...parents.map((p) => `parent ${p}`),
      `author Fake <fake@example.test> ${time} +0000`, `committer Fake <fake@example.test> ${time} +0000`, '', message];
    const sha = gitObject('commit', Buffer.from(lines.join('\n')));
    if (!this.objects.has(sha)) this.objects.set(sha, { type: 'commit', tree, parents, message, time });
    return sha;
  }

  get(sha, type) {
    const o = this.objects.get(sha);
    if (!o || (type && o.type !== type)) return null;
    return o;
  }

  /** Flatten a tree to Map<path, { mode, sha }> (blobs only). */
  flatten(treeSha, prefix = '', out = new Map()) {
    const tree = this.get(treeSha, 'tree');
    if (!tree) return out;
    for (const e of tree.entries) {
      const path = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.type === 'tree') this.flatten(e.sha, path, out);
      else out.set(path, { mode: e.mode, sha: e.sha });
    }
    return out;
  }

  /** Build nested trees from Map<path, { mode, sha }>; returns the root sha. */
  buildTree(files) {
    const root = new Map();
    for (const [path, f] of files) {
      const parts = path.split('/');
      let node = root;
      for (const dir of parts.slice(0, -1)) {
        if (!node.has(dir) || !(node.get(dir) instanceof Map)) node.set(dir, new Map());
        node = node.get(dir);
      }
      node.set(parts.at(-1), f);
    }
    const write = (node) => this.putTree([...node].map(([name, v]) => (v instanceof Map
      ? { name, type: 'tree', mode: '040000', sha: write(v) }
      : { name, type: 'blob', mode: v.mode || '100644', sha: v.sha })));
    return write(root);
  }

  isAncestor(ancestor, sha) {
    const seen = new Set();
    const stack = [sha];
    while (stack.length) {
      const cur = stack.pop();
      if (cur === ancestor) return true;
      if (seen.has(cur)) continue;
      seen.add(cur);
      stack.push(...(this.get(cur, 'commit')?.parents || []));
    }
    return false;
  }
}

export async function startFakeGitHub({ port = 0, host = '127.0.0.1', latencyMs = 0 } = {}) {
  const repos = new Map(); // 'owner/name' → Repo
  const tokens = new Map(); // token → { write, repos: Set|null }
  const log = [];
  const faults = []; // { method, re, status, headers, body, count }
  const pauses = []; // { method, re, release: Promise, resolveHit }
  const state = { down: false, latencyMs, rateRemaining: 5000, truncateRecursive: 0 };

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (!res.headersSent) send(res, 500, { message: `fake server error: ${err.message}` });
      console.error('[fake-github]', err);
    });
  });
  const sockets = new Set();
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  server.keepAliveTimeout = 1000;

  async function handle(req, res) {
    const url = new URL(req.url, 'http://fake');
    const path = url.pathname;
    if (state.down) { req.socket.destroy(); return; }
    if (req.method === 'OPTIONS') { res.writeHead(204, CORS); res.end(); return; }
    const body = await readBody(req);
    if (state.latencyMs) await new Promise((r) => setTimeout(r, state.latencyMs));
    const token = /^(?:Bearer|token) (.+)$/i.exec(req.headers.authorization || '')?.[1]?.trim() ?? null;
    const entry = { method: req.method, path, query: url.search, status: 0, at: Date.now(), bytesIn: body.length, token };
    // Raw request headers and body for leak checks (not enumerable, so JSON dumps of the log stay small).
    Object.defineProperty(entry, 'headers', { value: { ...req.headers }, enumerable: false });
    Object.defineProperty(entry, 'body', { value: body, enumerable: false });
    log.push(entry);

    for (const p of pauses) {
      if (!p.used && p.method === req.method && p.re.test(path)) {
        p.used = true;
        p.resolveHit();
        await p.release;
      }
    }
    const fault = faults.find((f) => f.count > 0 && (!f.method || f.method === req.method) && f.re.test(path)
      && body.length >= (f.minBodyBytes || 0));
    if (fault) {
      fault.count--;
      entry.status = fault.status;
      entry.fault = true;
      send(res, fault.status, fault.body || { message: 'fault injected' }, fault.headers || {});
      return;
    }
    try {
      const out = await route(req, url, body);
      entry.status = out.status;
      if (out.raw) {
        res.writeHead(out.status, { ...CORS, ...rateHeaders(), 'Content-Type': 'application/vnd.github.raw', ...(out.headers || {}) });
        res.end(out.raw);
      } else if (out.status === 304) {
        res.writeHead(304, { ...CORS, ...(out.headers || {}) });
        res.end();
      } else {
        send(res, out.status, out.json, out.headers);
      }
    } catch (err) {
      if (!(err instanceof HttpError)) throw err;
      entry.status = err.status;
      entry.error = err.message;
      send(res, err.status, { message: err.message, documentation_url: 'https://docs.github.com/rest' }, err.headers);
    }
  }

  function rateHeaders() {
    state.rateRemaining = Math.max(1, state.rateRemaining - 1);
    return {
      'X-RateLimit-Limit': '5000',
      'X-RateLimit-Remaining': String(state.rateRemaining),
      'X-RateLimit-Reset': String(Math.floor(Date.now() / 1000) + 3600),
      'X-RateLimit-Resource': 'core',
    };
  }

  function send(res, status, json, headers = {}) {
    const payload = Buffer.from(JSON.stringify(json ?? null));
    res.writeHead(status, { ...CORS, ...rateHeaders(), 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': payload.length, ...headers });
    res.end(payload);
  }

  function auth(req) {
    const m = /^Bearer (.+)$/i.exec(req.headers.authorization || '') || /^token (.+)$/i.exec(req.headers.authorization || '');
    const tok = m && tokens.get(m[1].trim());
    if (!tok) throw new HttpError(401, 'Bad credentials');
    return tok;
  }

  function repoFor(tok, owner, name) {
    const repo = repos.get(`${owner}/${name}`.toLowerCase());
    if (!repo || (tok.repos && !tok.repos.has(`${owner}/${name}`.toLowerCase()))) throw new HttpError(404, 'Not Found');
    return repo;
  }

  function requireWrite(tok, repo) {
    if (!tok.write || !repo.push) throw new HttpError(403, 'Resource not accessible by personal access token');
  }

  function requireNonEmpty(repo) {
    if (repo.empty) throw new HttpError(409, 'Git Repository is empty.');
  }

  async function route(req, url, body) {
    const m = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(url.pathname);
    if (!m) throw new HttpError(404, 'Not Found');
    const tok = auth(req);
    const repo = repoFor(tok, decodeURIComponent(m[1]), decodeURIComponent(m[2]));
    const rest = m[3] || '';
    const json = () => {
      try { return JSON.parse(body.toString('utf8') || '{}'); } catch { throw new HttpError(400, 'Problems parsing JSON'); }
    };
    const method = req.method;
    let mm;

    if (rest === '' && method === 'GET') {
      return {
        status: 200,
        json: {
          name: repo.name, full_name: `${repo.owner}/${repo.name}`, private: repo.private,
          visibility: repo.visibility ?? (repo.private ? 'private' : 'public'), default_branch: 'main', size: repo.empty ? 0 : 1,
          permissions: { admin: repo.push && tok.write, maintain: repo.push && tok.write, push: repo.push, triage: true, pull: true },
        },
      };
    }

    if ((mm = /^\/git\/ref\/heads\/(.+)$/.exec(rest)) && method === 'GET') {
      requireNonEmpty(repo);
      const branch = decodeURIComponent(mm[1]);
      const sha = repo.refs.get(`heads/${branch}`);
      if (!sha) throw new HttpError(404, 'Not Found');
      const etag = `"${sha}"`;
      if (req.headers['if-none-match'] === etag) return { status: 304, headers: { ETag: etag } };
      return { status: 200, headers: { ETag: etag }, json: { ref: `refs/heads/${branch}`, object: { sha, type: 'commit' } } };
    }

    if ((mm = /^\/git\/commits\/([0-9a-f]{40})$/.exec(rest)) && method === 'GET') {
      const c = repo.get(mm[1], 'commit');
      if (!c) throw new HttpError(404, 'Not Found');
      return { status: 200, json: { sha: mm[1], tree: { sha: c.tree }, parents: c.parents.map((sha) => ({ sha })), message: c.message, ...signature(c) } };
    }

    if (rest === '/commits' && method === 'GET') {
      requireNonEmpty(repo);
      const ref = url.searchParams.get('sha') || 'main';
      let sha = /^[0-9a-f]{40}$/.test(ref) ? ref : repo.refs.get(`heads/${ref}`);
      if (!sha || !repo.get(sha, 'commit')) throw new HttpError(404, 'Not Found');
      const perPage = Math.min(100, Math.max(1, Number(url.searchParams.get('per_page')) || 30));
      // GitHub filters by committer date: `until` = at or before, `since` = after. Commits are newest first.
      const until = url.searchParams.get('until');
      const since = url.searchParams.get('since');
      const untilMs = until ? Date.parse(until) : null;
      const sinceMs = since ? Date.parse(since) : null;
      const list = [];
      while (sha && list.length < perPage) {
        const c = repo.get(sha, 'commit');
        const ms = c.time * 1000;
        const keep = (untilMs === null || ms <= untilMs) && (sinceMs === null || ms > sinceMs);
        if (keep) {
          list.push({
            sha, commit: { message: c.message, tree: { sha: c.tree }, ...signature(c) },
            author: { login: 'fake-owner', id: 1 }, committer: { login: 'fake-owner', id: 1 },
            parents: c.parents.map((p) => ({ sha: p })),
          });
        }
        sha = c.parents[0];
      }
      return { status: 200, json: list };
    }

    if ((mm = /^\/git\/trees\/([0-9a-f]{40})$/.exec(rest)) && method === 'GET') {
      const t = repo.get(mm[1], 'tree');
      if (!t) throw new HttpError(404, 'Not Found');
      const recursive = url.searchParams.has('recursive');
      const tree = [];
      const walk = (sha, prefix) => {
        for (const e of repo.get(sha, 'tree').entries) {
          const path = prefix ? `${prefix}/${e.name}` : e.name;
          if (e.type === 'tree') {
            tree.push({ path, mode: '040000', type: 'tree', sha: e.sha });
            if (recursive) walk(e.sha, path);
          } else {
            tree.push({ path, mode: e.mode, type: 'blob', sha: e.sha, size: repo.get(e.sha, 'blob').data.length });
          }
        }
      };
      walk(mm[1], '');
      if (recursive && state.truncateRecursive && tree.length > state.truncateRecursive) {
        return { status: 200, json: { sha: mm[1], tree: tree.slice(0, state.truncateRecursive), truncated: true } };
      }
      return { status: 200, json: { sha: mm[1], tree, truncated: false } };
    }

    if ((mm = /^\/git\/blobs\/([0-9a-f]{40})$/.exec(rest)) && method === 'GET') {
      const b = repo.get(mm[1], 'blob');
      if (!b) throw new HttpError(404, 'Not Found');
      if (/application\/vnd\.github\.raw/.test(req.headers.accept || '')) return { status: 200, raw: b.data };
      const b64 = b.data.toString('base64').replace(/.{60}/g, '$&\n');
      return { status: 200, json: { sha: mm[1], size: b.data.length, content: b64, encoding: 'base64' } };
    }

    if (rest === '/git/blobs' && method === 'POST') {
      requireWrite(tok, repo);
      requireNonEmpty(repo);
      const { content = '', encoding = 'utf-8' } = json();
      const buf = encoding === 'base64' ? Buffer.from(content, 'base64') : Buffer.from(content, 'utf8');
      return { status: 201, json: { sha: repo.putBlob(buf) } };
    }

    if (rest === '/git/trees' && method === 'POST') {
      requireWrite(tok, repo);
      requireNonEmpty(repo);
      const { base_tree: baseTree, tree = [] } = json();
      let files = new Map();
      if (baseTree) {
        if (!repo.get(baseTree, 'tree')) throw new HttpError(422, 'Invalid tree info');
        files = repo.flatten(baseTree);
      }
      for (const e of tree) {
        if (e.sha === null) {
          if (!files.has(e.path)) throw new HttpError(422, `tree.path ${e.path} does not exist in base_tree`);
          files.delete(e.path);
          for (const p of [...files.keys()]) if (p.startsWith(`${e.path}/`)) files.delete(p);
        } else if (typeof e.content === 'string') {
          files.set(e.path, { mode: e.mode || '100644', sha: repo.putBlob(Buffer.from(e.content, 'utf8')) });
        } else {
          if (!repo.get(e.sha, 'blob')) throw new HttpError(422, `tree.sha ${e.sha} is not a valid blob`);
          files.set(e.path, { mode: e.mode || '100644', sha: e.sha });
        }
      }
      const sha = repo.buildTree(files);
      return { status: 201, json: { sha, tree: repo.get(sha, 'tree').entries.map((e) => ({ path: e.name, type: e.type, sha: e.sha })), truncated: false } };
    }

    if (rest === '/git/commits' && method === 'POST') {
      requireWrite(tok, repo);
      requireNonEmpty(repo);
      const { message = '', tree, parents = [] } = json();
      if (!repo.get(tree, 'tree')) throw new HttpError(422, 'Tree SHA does not exist');
      for (const p of parents) if (!repo.get(p, 'commit')) throw new HttpError(422, 'Parent SHA does not exist or is not a commit object');
      const sha = repo.putCommit({ tree, parents, message });
      return { status: 201, json: { sha, tree: { sha: tree }, parents: parents.map((s) => ({ sha: s })), message, ...signature(repo.get(sha, 'commit')) } };
    }

    if ((mm = /^\/git\/refs\/heads\/(.+)$/.exec(rest)) && method === 'PATCH') {
      requireWrite(tok, repo);
      const ref = `heads/${decodeURIComponent(mm[1])}`;
      const { sha, force = false } = json();
      const cur = repo.refs.get(ref);
      if (!cur) throw new HttpError(422, 'Reference does not exist');
      if (!repo.get(sha, 'commit')) throw new HttpError(422, 'Object does not exist');
      if (!force && !repo.isAncestor(cur, sha)) throw new HttpError(422, 'Update is not a fast forward');
      repo.refs.set(ref, sha);
      return { status: 200, json: { ref: `refs/${ref}`, object: { sha, type: 'commit' } } };
    }

    if (rest === '/git/refs' && method === 'POST') {
      requireWrite(tok, repo);
      requireNonEmpty(repo);
      const { ref, sha } = json();
      const name = String(ref || '').replace(/^refs\//, '');
      if (!/^heads\/.+/.test(name)) throw new HttpError(422, 'Reference name must start with refs/heads/');
      if (repo.refs.has(name)) throw new HttpError(422, 'Reference already exists');
      if (!repo.get(sha, 'commit')) throw new HttpError(422, 'Object does not exist');
      repo.refs.set(name, sha);
      return { status: 201, json: { ref: `refs/${name}`, object: { sha, type: 'commit' } } };
    }

    if ((mm = /^\/contents\/(.+)$/.exec(rest)) && method === 'PUT') {
      requireWrite(tok, repo);
      const path = decodeURIComponent(mm[1]);
      const { message = '', content = '', branch = 'main', sha: givenSha } = json();
      const ref = `heads/${branch}`;
      const head = repo.refs.get(ref);
      const files = head ? repo.flatten(repo.get(head, 'commit').tree) : new Map();
      if (files.has(path) && files.get(path).sha !== givenSha) throw new HttpError(422, '"sha" wasn\'t supplied.');
      const blob = repo.putBlob(Buffer.from(content, 'base64'));
      files.set(path, { mode: '100644', sha: blob });
      const tree = repo.buildTree(files);
      const commit = repo.putCommit({ tree, parents: head ? [head] : [], message });
      repo.refs.set(ref, commit);
      return { status: 201, json: { content: { path, sha: blob }, commit: { sha: commit, tree: { sha: tree } } } };
    }

    throw new HttpError(404, 'Not Found');
  }

  await new Promise((resolve) => server.listen(port, host, resolve));
  const actualPort = server.address().port;

  const api = {
    url: `http://${host}:${actualPort}`,
    port: actualPort,
    log,
    addToken(token, { write = true, repos: only = null } = {}) {
      tokens.set(token, { write, repos: only ? new Set(only.map((r) => r.toLowerCase())) : null });
    },
    createRepo(owner, name, opts = {}) {
      const repo = new Repo(owner, name, opts);
      repos.set(`${owner}/${name}`.toLowerCase(), repo);
      if (opts.files) api.commitFiles(owner, name, opts.files, { message: 'initial' });
      return repo;
    },
    repo(owner, name) { return repos.get(`${owner}/${name}`.toLowerCase()); },
    /** Server-side commit (simulates another client). files: { path: string|Buffer|null }. `time` (epoch ms) sets the
     * committer date, so tests can place a commit in the past. */
    commitFiles(owner, name, files, { branch = 'main', message = 'server commit', time } = {}) {
      const repo = api.repo(owner, name);
      const ref = `heads/${branch}`;
      const head = repo.refs.get(ref);
      const flat = head ? repo.flatten(repo.get(head, 'commit').tree) : new Map();
      for (const [path, v] of Object.entries(files)) {
        if (v === null) flat.delete(path);
        else flat.set(path, { mode: '100644', sha: repo.putBlob(Buffer.isBuffer(v) ? v : Buffer.from(v)) });
      }
      const opts = { tree: repo.buildTree(flat), parents: head ? [head] : [], message };
      if (time !== undefined) opts.time = Math.floor(time / 1000);
      const commit = repo.putCommit(opts);
      repo.refs.set(ref, commit);
      return commit;
    },
    /** Commits on a branch, newest first, with the paths each changed relative to its first parent. */
    commits(owner, name, branch = 'main') {
      const repo = api.repo(owner, name);
      const out = [];
      let sha = repo.refs.get(`heads/${branch}`);
      while (sha) {
        const c = repo.get(sha, 'commit');
        const now = repo.flatten(c.tree);
        const before = c.parents[0] ? repo.flatten(repo.get(c.parents[0], 'commit').tree) : new Map();
        const changed = [...new Set([...now.keys(), ...before.keys()])].filter((p) => now.get(p)?.sha !== before.get(p)?.sha).sort();
        out.push({ sha, message: c.message, parents: c.parents, changed, deleted: changed.filter((p) => !now.has(p)), time: c.time * 1000 });
        sha = c.parents[0];
      }
      return out;
    },
    files(owner, name, branch = 'main') {
      const repo = api.repo(owner, name);
      const head = repo.refs.get(`heads/${branch}`);
      return head ? repo.flatten(repo.get(head, 'commit').tree) : new Map();
    },
    readFile(owner, name, path, branch = 'main') {
      const f = api.files(owner, name, branch).get(path);
      return f ? api.repo(owner, name).get(f.sha, 'blob').data : null;
    },
    /** Make the next `count` matching requests fail. */
    failNext({ method = null, path = /./, status = 500, headers = {}, body = null, count = 1, minBodyBytes = 0 } = {}) {
      faults.push({ method, re: path instanceof RegExp ? path : new RegExp(path), status, headers, body, count, minBodyBytes });
    },
    /** Hold the next matching request until release() is called. hit resolves when it arrives. */
    pauseNext({ method, path }) {
      let release;
      let resolveHit;
      const hit = new Promise((r) => { resolveHit = r; });
      pauses.push({ method, re: path instanceof RegExp ? path : new RegExp(path), release: new Promise((r) => { release = r; }), resolveHit, used: false });
      return { hit, release: () => release() };
    },
    setDown(down) {
      state.down = down;
      if (down) for (const s of sockets) s.destroy();
    },
    setLatency(ms) { state.latencyMs = ms; },
    /** Recursive tree listings longer than `n` entries come back truncated (0 = never), like GitHub's huge trees. */
    setTruncateRecursive(n) { state.truncateRecursive = n; },
    clearLog() { log.length = 0; },
    close() {
      for (const s of sockets) s.destroy();
      return new Promise((r) => server.close(() => r()));
    },
  };
  return api;
}

/** Author/committer as GitHub reports them (name, e-mail, ISO date). */
function signature(c) {
  const who = { name: 'Fake Owner', email: 'fake@example.test', date: new Date(c.time * 1000).toISOString() };
  return { author: { ...who }, committer: { ...who } };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * Forward a Playwright context's https://api.github.com/** traffic to the fake server, so the real
 * app (whose CSP only allows api.github.com) can run against it unchanged.
 */
export async function routeGitHubToFake(context, fakeUrl) {
  await context.route(/^https:\/\/api\.github\.com\//, async (route) => {
    const req = route.request();
    const url = req.url().replace(/^https:\/\/api\.github\.com/, fakeUrl);
    try {
      const response = await route.fetch({ url });
      await route.fulfill({ response });
    } catch {
      await route.abort('connectionfailed');
    }
  });
}

// ------------------------------------------------------------------- CLI

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const arg = (name, def) => {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : def;
  };
  const fake = await startFakeGitHub({ port: Number(arg('port', 8112)) });
  const token = arg('token', 'ghp_fake_token');
  const [owner, name] = arg('repo', 'me/paper-library').split('/');
  fake.addToken(token, { write: true });
  fake.createRepo(owner, name, { private: true });
  console.log(`fake GitHub at ${fake.url} · token ${token} · empty private repo ${owner}/${name}`);
}
