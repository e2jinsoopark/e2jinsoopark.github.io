// Shared helpers for the relay tests: local `wrangler dev` with a throwaway D1, HTTP helpers, a tiny test runner.
// Everything the tests write goes to C:/Users/dindoo/Projects/pr-tools/out/relay/.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PR_TOOLS = process.env.PR_TOOLS || 'C:/Users/dindoo/Projects/pr-tools';
export const OUT_DIR = path.join(PR_TOOLS, 'out/relay');
export const RELAY_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WRANGLER = path.join(PR_TOOLS, 'node_modules/wrangler/bin/wrangler.js');

export const WORKER_PORT = 8787;
export const UPSTREAM_PORT = 8788;
export const PAGE_PORT = 8789;
export const WORKER = `http://127.0.0.1:${WORKER_PORT}`;
export const ADMIN_TOKEN = 'test-admin-token-0123456789abcdef';
export const REAL_KEY = 'sk-ant-relay-test-owner-key-0000';
export const GLOBAL_LIMIT_USD = 1;

/** Vars for the test Worker (override wrangler.jsonc; secrets are fake). */
export const TEST_VARS = {
  UPSTREAM_URL: `http://127.0.0.1:${UPSTREAM_PORT}`,
  ANTHROPIC_API_KEY: REAL_KEY,
  ADMIN_TOKEN,
  TEST_MODE: '1',
  GLOBAL_DAILY_LIMIT_USD: String(GLOBAL_LIMIT_USD),
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
  const res = spawnSync(process.execPath, [WRANGLER, 'd1', 'execute', 'paper-relay', '--local', '--persist-to', stateDir,
    '--file', 'schema.sql'], { cwd: RELAY_DIR, env: wranglerEnv, encoding: 'utf8' });
  if (res.status !== 0) throw new Error(`schema apply failed:\n${res.stdout}\n${res.stderr}`);
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
 * Call the Worker. `code` → x-api-key, `admin` → Bearer admin token (true = the right one), `now` → test clock.
 * @returns {Promise<{ status: number, headers: Headers, text: string, json: any }>}
 */
export async function call(pathname, { method = 'GET', code, admin, headers = {}, body, now, origin, signal } = {}) {
  const h = { ...headers };
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
