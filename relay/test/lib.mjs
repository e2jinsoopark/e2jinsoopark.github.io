// Shared helpers for the relay tests: local `wrangler dev` with a throwaway D1, HTTP helpers, a tiny test runner.
// Everything the tests write goes to C:/Users/dindoo/Projects/pr-tools/out/relay/.
import { spawn, spawnSync } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PR_TOOLS = process.env.PR_TOOLS || 'C:/Users/dindoo/Projects/pr-tools';
// RELAY_OUT_DIR: another place for results, logs and the throwaway D1 state (default pr-tools/out/relay).
export const OUT_DIR = process.env.RELAY_OUT_DIR || path.join(PR_TOOLS, 'out/relay');
export const RELAY_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** The test Worker's local D1 state (run.mjs); d1Rows reads it. */
export const STATE_DIR = path.join(OUT_DIR, 'state');
const WRANGLER = path.join(PR_TOOLS, 'node_modules/wrangler/bin/wrangler.js');

export const WORKER_PORT = 8787;
export const UPSTREAM_PORT = 8788;
export const PAGE_PORT = 8789;
export const GITHUB_PORT = 8792;
export const WORKER = `http://127.0.0.1:${WORKER_PORT}`;
export const ADMIN_TOKEN = 'test-admin-token-0123456789abcdef';
export const REAL_KEY = 'sk-ant-relay-test-owner-key-0000';
export const GLOBAL_LIMIT_USD = 1;
/** The Worker's (fake) fine-grained token for the team repos on the fake GitHub. */
export const TEAM_TOKEN = 'github_pat_team_test_token_0123456789';
/** Shared libraries of the test Worker: the team library, a small one (size cap) and one whose repo is public. */
export const SHARED_LIBRARIES = [
  { id: 'team', name: '공용 서재', repo: 'dindoopark/paper-team-library', branch: 'main', maxBytes: 4_000_000_000 },
  { id: 'small', name: '작은 서재', repo: 'dindoopark/paper-small-library', branch: 'main', maxBytes: 1_000_000, maxFiles: 8 },
  { id: 'lab', name: '연구실 서재', repo: 'dindoopark/lab-library', branch: 'main' },
];

/** Vars for the test Worker (override wrangler.jsonc; secrets are fake). */
export const TEST_VARS = {
  UPSTREAM_URL: `http://127.0.0.1:${UPSTREAM_PORT}`,
  ANTHROPIC_API_KEY: REAL_KEY,
  ADMIN_TOKEN,
  TEST_MODE: '1',
  GLOBAL_DAILY_LIMIT_USD: String(GLOBAL_LIMIT_USD),
  GITHUB_API_BASE: `http://127.0.0.1:${GITHUB_PORT}`,
  TEAM_GITHUB_TOKEN: TEAM_TOKEN,
  SHARED_LIBRARIES: JSON.stringify(SHARED_LIBRARIES),
};

const wranglerEnv = { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1', NO_COLOR: '1' };

/** True when something already listens on `port`. */
export function portInUse(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
  });
}

/** Fresh local D1 state with the schema applied. */
export function freshDatabase(stateDir) {
  fs.rmSync(stateDir, { recursive: true, force: true });
  applySql(stateDir, 'schema.sql');
}

/**
 * A local D1 as a deployment made before code deletion (2026-10-19) has it after the update's schema step:
 * test/legacy-schema.sql (the schema of that time — codes without person_salt — and two codes made back then, see
 * LEGACY_CODES), then today's schema.sql applied twice, which must succeed both times. The Worker adds
 * codes.person_salt itself on its first code creation (src/db.js ensureSaltColumn). The relay tests run on this.
 * @returns {string[]} the files applied, in order
 */
export function migratedDatabase(stateDir) {
  fs.rmSync(stateDir, { recursive: true, force: true });
  const steps = ['test/legacy-schema.sql', 'schema.sql', 'schema.sql'];
  for (const file of steps) applySql(stateDir, file);
  return steps;
}

/** Codes inserted by test/legacy-schema.sql: made before person salts, so their personId is the saltless one. */
export const LEGACY_CODES = { generated: 'PR-01DC-0DE5', custom: 'OLD-WARD-7B' };

/** Run a SQL file (relative to relay/) on a local D1 state with `wrangler d1 execute`. */
export function applySql(stateDir, file) {
  const res = spawnSync(process.execPath, [WRANGLER, 'd1', 'execute', 'paper-relay', '--local', '--persist-to', stateDir,
    '--file', file], { cwd: RELAY_DIR, env: wranglerEnv, encoding: 'utf8' });
  if (res.status !== 0) throw new Error(`${file} apply failed:\n${res.stdout}\n${res.stderr}`);
}

/** Run one SQL command on a local D1 state (not the running Worker's) with `wrangler d1 execute --json`. */
export function sqlRows(stateDir, command) {
  const res = spawnSync(process.execPath, [WRANGLER, 'd1', 'execute', 'paper-relay', '--local', '--persist-to', stateDir,
    '--command', command, '--json'], { cwd: RELAY_DIR, env: wranglerEnv, encoding: 'utf8' });
  if (res.status !== 0) throw new Error(`${command} failed:\n${res.stdout}\n${res.stderr}`);
  return JSON.parse(res.stdout)[0].results;
}

/**
 * Read-only query on the running test Worker's local D1 (the SQLite file wrangler dev keeps under STATE_DIR), for
 * what the HTTP API does not show (person salts, usage history rows, shared_trees). Never writes.
 */
export function d1Rows(sql, ...params) {
  return d1RowsAt(STATE_DIR, sql, ...params);
}

/** d1Rows on another local D1 state (e.g. an end-to-end test's own `freshDatabase(stateDir)`). */
export async function d1RowsAt(stateDir, sql, ...params) {
  const { DatabaseSync } = await import('node:sqlite');
  const dir = path.join(stateDir, 'v3/d1/miniflare-D1DatabaseObject');
  const file = fs.readdirSync(dir).find((n) => /^[0-9a-f]{64}\.sqlite$/.test(n));
  if (!file) throw new Error(`no D1 database in ${dir}`);
  const db = new DatabaseSync(path.join(dir, file), { readOnly: true });
  try {
    return db.prepare(sql).all(...params).map((row) => ({ ...row }));
  } finally {
    db.close();
  }
}

/**
 * personId as the Worker derives it (src/shared-paths.js personIdFor), computed independently: the first 16 hex of
 * SHA-256 (HMAC-SHA-256 with `secret`) of the stored code, or of code + '\n' + salt for a code with a person salt.
 */
export function personIdOf(code, salt = null, secret = '') {
  const hash = secret ? createHmac('sha256', secret) : createHash('sha256');
  return hash.update(salt ? `${code}\n${salt}` : code).digest('hex').slice(0, 16);
}

/** The person salt the test Worker stored for `code` (the stored spelling; null for a legacy code). */
export async function saltOf(code, stateDir = STATE_DIR) {
  const [row] = await d1RowsAt(stateDir, 'SELECT person_salt FROM codes WHERE code = ?', code);
  if (!row) throw new Error(`no code ${code} in D1`);
  return row.person_salt ?? null;
}

/**
 * personId of a code of a running test Worker (the tests set no PERSON_ID_SECRET), from its stored salt. End-to-end
 * tests pass their own state dir: `await personIdOfCode('EICU-2026', stateDir)`.
 */
export async function personIdOfCode(code, stateDir = STATE_DIR) {
  return personIdOf(code, await saltOf(code, stateDir));
}

/** Start `wrangler dev` on WORKER_PORT; resolves once it answers. Returns stop(). */
export async function startWrangler({ stateDir, vars = TEST_VARS, logFile }) {
  if (await portInUse(WORKER_PORT)) throw new Error(`port ${WORKER_PORT} is already in use`);
  const args = [WRANGLER, 'dev', '--port', String(WORKER_PORT), '--ip', '127.0.0.1', '--inspector-port', '9339',
    '--persist-to', stateDir, '--show-interactive-dev-session=false', '--log-level', 'info'];
  for (const [k, v] of Object.entries(vars)) args.push('--var', `${k}:${v}`);
  const log = fs.createWriteStream(logFile);
  const proc = spawn(process.execPath, args, { cwd: RELAY_DIR, env: wranglerEnv, windowsHide: true });
  proc.stdout.pipe(log);
  proc.stderr.pipe(log);
  const stop = () => killTree(proc);
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) throw new Error(`wrangler dev exited early (code ${proc.exitCode}); see ${logFile}`);
    try {
      const res = await fetch(`${WORKER}/`);
      if (res.ok) return stop;
    } catch { /* not up yet */ }
    await sleep(300);
  }
  stop();
  throw new Error(`wrangler dev did not start; see ${logFile}`);
}

function killTree(proc) {
  if (proc.exitCode !== null) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
  else proc.kill('SIGTERM');
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll `fn` until it returns a truthy value (returned) or the timeout passes (throws with the last value). */
export async function waitFor(fn, { timeout = 8000, interval = 100, what = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await sleep(interval);
  }
  throw new Error(`timed out waiting for ${what} (last: ${JSON.stringify(last)})`);
}

/**
 * Call the Worker. `code` → x-api-key, `admin` → Bearer admin token (true = the right one), `now` → test clock,
 * `ip` → CF-Connecting-IP (wrangler dev passes a client-sent one through; Cloudflare sets it itself in production).
 * @returns {Promise<{ status: number, headers: Headers, text: string, json: any }>}
 */
export async function call(pathname, { method = 'GET', code, admin, headers = {}, body, now, origin, signal, ip } = {}) {
  const h = { ...headers };
  if (ip) h['cf-connecting-ip'] = ip;
  if (code) h['x-api-key'] = code;
  if (admin) h.authorization = `Bearer ${admin === true ? ADMIN_TOKEN : admin}`;
  if (now) h['x-relay-test-now'] = now;
  if (origin) h.origin = origin;
  let payload = body;
  if (body !== undefined && typeof body !== 'string' && !(body instanceof Uint8Array)) {
    payload = JSON.stringify(body);
    h['content-type'] ||= 'application/json';
  }
  const res = await fetch(`${WORKER}${pathname}`, { method, headers: h, body: payload, signal });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { status: res.status, headers: res.headers, text, json };
}

/** POST /v1/messages with a minimal valid body (merged with `params`). */
export function sendMessage({ code, params = {}, now, headers, query = '' } = {}) {
  return call(`/v1/messages${query}`, {
    method: 'POST', code, now, headers,
    body: { model: 'claude-haiku-5-5', max_tokens: 1024, messages: [{ role: 'user', content: '안녕' }], ...params },
  });
}

/** Create a code through the admin API; returns the record. */
export async function newCode(fields = {}, now) {
  const res = await call('/relay/admin/codes', { method: 'POST', admin: true, now, body: { name: '테스트', ...fields } });
  if (res.status !== 201) throw new Error(`create code failed: ${res.status} ${res.text}`);
  return res.json;
}

/** Usage report for one code over `days` ending at `now`. */
export async function usageFor(code, { now, days = 1 } = {}) {
  const res = await call(`/relay/admin/usage?days=${days}&code=${encodeURIComponent(code)}`, { admin: true, now });
  if (res.status !== 200) throw new Error(`usage failed: ${res.status} ${res.text}`);
  return res.json;
}

/** Wait until the code's usage on the day of `now` shows `requests` requests; returns that day's entry. */
export function waitForRequests(code, requests, { now, timeout = 8000 } = {}) {
  return waitFor(async () => {
    const { days } = await usageFor(code, { now });
    return days[0].requests >= requests ? days[0] : null;
  }, { timeout, what: `${requests} recorded request(s) for ${code}` });
}

export const close = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

/**
 * Run `tests` ({ name, fn(ctx) → evidence string }) in order; returns [{ name, result, evidence, ms }].
 * A failing test does not stop the suite.
 */
export async function runTests(suite, tests, ctx, logLine) {
  const results = [];
  for (const t of tests) {
    const started = Date.now();
    try {
      const evidence = await t.fn(ctx);
      results.push({ suite, name: t.name, result: 'pass', evidence: String(evidence ?? ''), ms: Date.now() - started });
      logLine(`  PASS ${t.name} (${Date.now() - started} ms)\n       ${evidence ?? ''}`);
    } catch (err) {
      results.push({ suite, name: t.name, result: 'fail', evidence: String(err?.stack || err), ms: Date.now() - started });
      logLine(`  FAIL ${t.name}\n       ${err?.stack || err}`);
    }
  }
  return results;
}
