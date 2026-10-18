// Minimal Playwright test runner for the AI module (Node side).
// Serves the repo root with `python -m http.server`, runs each test in a fresh browser context (Edge),
// and writes results + logs to C:/Users/dindoo/Projects/pr-tools/out/ai/.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'file:///C:/Users/dindoo/Projects/pr-tools/node_modules/playwright/index.mjs';

export const PORT = 8103;
export const ORIGIN = `http://localhost:${PORT}`;
export const OUT_DIR = 'C:/Users/dindoo/Projects/pr-tools/out/ai';
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** Start the static server unless one already answers on PORT. Returns a stop() function. */
export async function startServer() {
  if (await isUp()) return () => {};
  const proc = spawn('python', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], {
    cwd: REPO_ROOT, stdio: 'ignore', windowsHide: true,
  });
  for (let i = 0; i < 50 && !(await isUp()); i++) await new Promise((r) => setTimeout(r, 100));
  if (!(await isUp())) throw new Error('static server did not start');
  return () => proc.kill();
}

async function isUp() {
  try {
    const res = await fetch(`${ORIGIN}/tests/ai/harness.html`);
    return res.ok;
  } catch {
    return false;
  }
}

/** CORS headers a cross-origin mocked API response needs (fetch from http://localhost → https://api…). */
export const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'access-control-expose-headers': '*',
};

/**
 * Route `pattern` and record every non-preflight request as { method, url, headers, body }.
 * `handler(req, n)` returns { status?, headers?, json? , body?, contentType?, abort?, delayMs? }.
 */
export async function recordRoute(page, pattern, handler) {
  const calls = [];
  await page.route(pattern, async (route) => {
    const request = route.request();
    if (request.method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: CORS });
      return;
    }
    const raw = request.postData();
    let body = null;
    try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }
    const call = { method: request.method(), url: request.url(), headers: request.headers(), body };
    calls.push(call);
    const res = (await handler(call, calls.length)) || {};
    if (res.delayMs) await new Promise((r) => setTimeout(r, res.delayMs));
    if (res.abort) {
      await route.abort(res.abort).catch(() => {});
      return;
    }
    await route.fulfill({
      status: res.status || 200,
      headers: { ...CORS, ...(res.headers || {}) },
      contentType: res.contentType || 'application/json',
      body: res.json !== undefined ? JSON.stringify(res.json) : res.body ?? '',
    }).catch(() => {}); // the page may have aborted the request meanwhile
  });
  return calls;
}

/** Build an SSE body from [eventName, dataObject] pairs. */
export function sse(events, { crlf = false } = {}) {
  const nl = crlf ? '\r\n' : '\n';
  return events.map(([event, data]) => `${event ? `event: ${event}${nl}` : ''}data: ${JSON.stringify(data)}${nl}${nl}`).join('');
}

/**
 * Run tests sequentially, each with a fresh context + page opened on the harness.
 * test = { name, query?: string, fn: async ({ page, context, log }) => evidence-string | void }
 */
export async function runSuite(suiteName, tests) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stop = await startServer();
  const browser = await chromium.launch({ channel: 'msedge' });
  const results = [];
  const logLines = [];
  try {
    for (const t of tests) {
      const context = await browser.newContext();
      const page = await context.newPage();
      const consoleLines = [];
      page.on('console', (m) => consoleLines.push(`[${m.type()}] ${m.text()}`));
      page.on('pageerror', (e) => consoleLines.push(`[pageerror] ${e.message}`));
      const started = Date.now();
      let result;
      try {
        await page.goto(`${ORIGIN}/tests/ai/harness.html${t.query ?? ''}`);
        await page.waitForFunction(() => window.__harnessReady === true);
        const evidence = await t.fn({ page, context, log: (s) => logLines.push(`  ${t.name}: ${s}`) });
        result = { name: t.name, result: 'pass', evidence: String(evidence ?? 'ok'), ms: Date.now() - started };
      } catch (err) {
        result = { name: t.name, result: 'fail', evidence: String(err?.stack || err), ms: Date.now() - started };
      }
      results.push(result);
      const mark = result.result === 'pass' ? 'PASS' : 'FAIL';
      console.log(`${mark} ${suiteName} › ${t.name} (${result.ms} ms)${result.result === 'pass' ? `\n     ${result.evidence}` : `\n${result.evidence}`}`);
      if (result.result !== 'pass' && consoleLines.length) console.log(`     console:\n       ${consoleLines.slice(-15).join('\n       ')}`);
      logLines.push(`${mark} ${t.name}`, ...consoleLines.map((l) => `    ${l}`));
      await context.close();
    }
  } finally {
    await browser.close();
    stop();
  }
  fs.writeFileSync(path.join(OUT_DIR, `${suiteName}.results.json`), JSON.stringify(results, null, 2));
  fs.writeFileSync(path.join(OUT_DIR, `${suiteName}.log`), logLines.join('\n'));
  const failed = results.filter((r) => r.result !== 'pass').length;
  console.log(`\n${suiteName}: ${results.length - failed}/${results.length} passed`);
  return { results, failed };
}
