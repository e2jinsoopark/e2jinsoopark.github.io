// Invite-code relay — app client (docs/RELAY.md §2), end to end in Edge:
//   node tests/relay-client/run.mjs     (starts `python -m http.server 8150` if nothing is listening)
// The real app (index.html, real modules, the real Anthropic SDK from jsDelivr) talks to tests/relay-client/fake-relay.mjs
// through Playwright route interception of https://relay.test. index.html is answered with a TEST COPY whose CSP
// connect-src also lists https://relay.test (the browser checks CSP before any route sees the request); the real file
// stays strict, which the first test checks. No paid API is called: every other external request is aborted, except
// the SDK bundle (cdn.jsdelivr.net/npm/) and the font stylesheet (stubbed).
// Results + screenshots: C:/Users/dindoo/Projects/pr-tools/out/relay-client/.
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'file:///C:/Users/dindoo/Projects/pr-tools/node_modules/playwright/index.mjs';
import { ADMIN_TOKEN, CODES, createFakeRelay, RELAY_URL } from './fake-relay.mjs';

const PORT = 8150;
const ORIGIN = `http://localhost:${PORT}`;
const APP = `${ORIGIN}/index.html`;
const OUT = 'C:/Users/dindoo/Projects/pr-tools/out/relay-client';
const FIXTURES = 'C:/Users/dindoo/Projects/pr-fixtures';
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SETTINGS_KEY = 'pr.settings.v1';
const STRICT_CONNECT_SRC = ["'self'", 'https://api.anthropic.com', 'https://api.openai.com', 'https://generativelanguage.googleapis.com', 'https://api.github.com', 'https://api.semanticscholar.org', 'https://eutils.ncbi.nlm.nih.gov', 'https://www.ebi.ac.uk', 'https://api.crossref.org'];
const HAIKU_LABEL = 'Claude Haiku 5.5 (빠름·저렴)';

mkdirSync(OUT, { recursive: true });
const results = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function assert(cond, msg) { if (!cond) throw new Error(msg); }
function assertEqual(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg}: expected ${e}, got ${a}`);
}

async function test(name, fn) {
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
  try { return (await fetch(`${ORIGIN}/index.html`)).ok; } catch { return false; }
}

/** index.html with https://relay.test added to connect-src — served only to the test browser. */
function testCopyOfIndex() {
  const html = readFileSync(`${REPO}/index.html`, 'utf8');
  const out = html.replace(/(connect-src [^;"]*)/, `$1 ${RELAY_URL}`);
  if (out === html) throw new Error('could not find connect-src in index.html');
  return out;
}

/**
 * One browser context = one device, with its own fake relay. Seeds localStorage settings before the app starts.
 * Records page errors, CSP violations, unexpected console errors and every external request that was blocked.
 */
async function device({ seed = { relay: { url: RELAY_URL } }, viewport = { width: 1280, height: 900 }, clipboard = false } = {}) {
  const fake = createFakeRelay();
  const ctx = await browser.newContext({ locale: 'ko-KR', viewport, colorScheme: 'light' });
  if (clipboard) await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: ORIGIN });
  const problems = [];
  const external = [];
  const indexHtml = testCopyOfIndex();
  await ctx.route(/^https?:\/\/(?!localhost:8150\/|relay\.test\/)/, (route) => {
    const url = route.request().url();
    if (url.startsWith('https://cdn.jsdelivr.net/gh/orioncactus/pretendard')) {
      return route.fulfill({ status: 200, contentType: 'text/css', body: '/* font stub (offline test) */' });
    }
    if (url.startsWith('https://cdn.jsdelivr.net/npm/')) return route.continue(); // the pinned SDK bundle + its deps
    external.push(url);
    return route.abort();
  });
  await ctx.route(/^http:\/\/localhost:8150\/index\.html(?:\?.*)?$/, (route) => route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: indexHtml }));
  await ctx.route(`${RELAY_URL}/**`, fake.handle);
  await ctx.addInitScript(({ key, seed }) => {
    try { if (seed && !localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify(seed)); } catch { /* blocked */ }
    window.__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => {
      window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`);
      console.error(`[csp] ${e.violatedDirective} blocked ${e.blockedURI}`);
    });
  }, { key: SETTINGS_KEY, seed });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => problems.push(`pageerror ${e.message}`));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    // Chromium logs every non-2xx answer; the relay's refusals (and aborted requests) are expected here.
    if (/^Failed to load resource/.test(m.text()) && String(m.location()?.url || '').startsWith(RELAY_URL)) return;
    problems.push(`console.error ${m.text()}`);
  });
  const done = async () => {
    await ctx.close();
    assert(!external.length, `external requests blocked: ${external.join(', ')}`);
    assert(!problems.length, `console/page/CSP problems:\n  ${problems.join('\n  ')}`);
  };
  return { ctx, page, fake, problems, external, done };
}

const shot = (target, file, opts = {}) => target.screenshot({ path: `${OUT}/${file}.png`, ...opts });
const stored = (page) => page.evaluate((key) => JSON.parse(localStorage.getItem(key) || '{}'), SETTINGS_KEY);
const posts = (fake, path = '/v1/messages') => fake.calls.filter((c) => c.method === 'POST' && c.path === path);

async function booted(page) {
  await page.waitForFunction(() => document.querySelector('.library, .reader, .settings, .message-screen'), null, { timeout: 30000 });
}

/** Set settings inside the page (the app's own settings module). */
function setSettings(page, patch) {
  return page.evaluate(async (patch) => {
    const { settings } = await import('/js/core/settings.js');
    settings.set(patch);
  }, patch);
}

// ---------------------------------------------------------------------------------------------------------------

let server = null;
if (!(await serverUp())) {
  server = spawn('python', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], { cwd: REPO, stdio: 'ignore', windowsHide: true });
  for (let i = 0; i < 60 && !(await serverUp()); i++) await sleep(100);
  if (!(await serverUp())) throw new Error('static server did not start');
}
const browser = await chromium.launch({ channel: 'msedge' });

try {
  await test('CSP: the real index.html stays strict while RELAY_DEFAULT_URL is empty (and must list it once set)', async () => {
    const html = readFileSync(`${REPO}/index.html`, 'utf8');
    const csp = /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html)?.[1] || '';
    const connect = csp.split(';').map((s) => s.trim()).find((s) => s.startsWith('connect-src '))?.split(/\s+/).slice(1) || [];
    const { RELAY_DEFAULT_URL } = await import(pathToFileURL(`${REPO}/js/core/config.js`).href);
    if (!RELAY_DEFAULT_URL) {
      assertEqual(connect, STRICT_CONNECT_SRC, 'connect-src');
      return `RELAY_DEFAULT_URL = '' → connect-src is exactly [${connect.join(' ')}] (no relay origin, no localhost)`;
    }
    const origin = new URL(RELAY_DEFAULT_URL).origin;
    assert(connect.includes(origin), `connect-src lacks the relay origin ${origin}: ${connect.join(' ')}`);
    assertEqual(connect.filter((s) => !STRICT_CONNECT_SRC.includes(s)), [origin], 'extra connect-src entries');
    return `RELAY_DEFAULT_URL = ${RELAY_DEFAULT_URL} → connect-src lists ${origin} and nothing else extra`;
  });

  await test('helpers: code normalization, invite link/message, settings.model()/isAiReady() for relay, CSP check', async () => {
    const d = await device();
    await d.page.goto(`${APP}#/`);
    await booted(d.page);
    const r = await d.page.evaluate(async () => {
      const R = await import('/js/ai/relay.js');
      const { settings } = await import('/js/core/settings.js');
      const out = {};
      out.norm = ['pr-7k3m-9qxa', ' PR 7K3M 9QXA ', 'PR7K3MOQXL', 'https://e2jinsoopark.github.io/#/join/PR-7K3M-9QXA', 'PR–7K3M–9QXA', 'hello']
        .map((c) => `${R.normalizeInviteCode(c)}:${R.isInviteCode(R.normalizeInviteCode(c))}`);
      out.link = R.inviteLink('PR-7K3M-9QXA');
      out.msg = R.inviteMessage({ code: 'PR-7K3M-9QXA', name: '홍길동', dailyLimitUsd: 0.5 });
      settings.set({ provider: 'relay', relay: { code: '', allowedModels: [] } });
      out.readyNoCode = settings.isAiReady();
      settings.set({ relay: { code: 'PR-7K3M-9QXA', allowedModels: ['claude-haiku-5-5'], assistModel: 'claude-sonnet-5-5' } });
      out.haikuOnly = [settings.model('translate'), settings.model('assist'), settings.isAiReady()];
      settings.set({ relay: { allowedModels: ['claude-haiku-5-5', 'claude-sonnet-5-5'], assistModel: '' } });
      out.both = [settings.model('translate'), settings.model('assist')];
      settings.set({ relay: { assistModel: 'claude-haiku-5-5' } });
      out.bothSavedHaiku = settings.model('assist');
      settings.set({ relay: { allowedModels: [], assistModel: '' } });
      out.unknown = [settings.model('translate'), settings.model('assist')];
      out.csp = ['https://relay.test', 'https://evil.example', 'http://127.0.0.1:8787'].map((u) => R.isRelayOriginAllowed(u));
      settings.set({ relay: { url: '' } });
      out.noUrl = [settings.relayUrl(), settings.isAiReady()];
      out.defaultUrl = (await import('/js/core/config.js')).RELAY_DEFAULT_URL.replace(/\/+$/, '');
      return out;
    });
    assertEqual(r.norm, ['PR-7K3M-9QXA:true', 'PR-7K3M-9QXA:true', 'PR-7K3M-0QX1:true', 'PR-7K3M-9QXA:true', 'PR-7K3M-9QXA:true', 'HELLO:false'], 'normalize');
    assertEqual(r.link, 'https://e2jinsoopark.github.io/#/join/PR-7K3M-9QXA', 'invite link');
    assert(r.msg.includes('https://e2jinsoopark.github.io/#/join/PR-7K3M-9QXA') && r.msg.includes('홍길동님') && r.msg.includes('키 없이 쓰기')
      && r.msg.split('\n').length === 3, `invite message: ${r.msg}`);
    assertEqual(r.readyNoCode, false, 'ready without a code');
    assertEqual(r.haikuOnly, ['claude-haiku-5-5', 'claude-haiku-5-5', true], 'Haiku-only code (saved Sonnet ignored)');
    assertEqual(r.both, ['claude-haiku-5-5', 'claude-sonnet-5-5'], 'Haiku + Sonnet code defaults');
    assertEqual(r.bothSavedHaiku, 'claude-haiku-5-5', 'saved allowed choice');
    assertEqual(r.unknown, ['claude-haiku-5-5', 'claude-haiku-5-5'], 'unknown allowed models');
    assertEqual(r.csp, [true, false, false], 'isRelayOriginAllowed under the test CSP');
    // A saved '' means RELAY_DEFAULT_URL: no address at all until the Worker is deployed, the default one after.
    assertEqual(r.noUrl, r.defaultUrl ? [r.defaultUrl, true] : ['', false], 'saved address cleared');
    await d.done();
    return `normalize ${r.norm.join(' ')}; Haiku-only → assist ${r.haikuOnly[1]}; Haiku+Sonnet → assist ${r.both[1]}; unknown → ${r.unknown.join('/')}; CSP allowed ${r.csp.join('/')}; invite message:\n        ${r.msg.replace(/\n/g, '\n        ')}`;
  });

  await test('provider: complete() → POST relay /v1/messages with the code as x-api-key; Claude provider still api.anthropic.com', async () => {
    const d = await device({ seed: { provider: 'relay', relay: { url: RELAY_URL, code: CODES.haiku } } });
    const anthropic = [];
    await d.ctx.route('https://api.anthropic.com/**', async (route) => {
      const req = route.request();
      const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS' };
      if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
      anthropic.push({ url: req.url(), key: req.headers()['x-api-key'] });
      return route.fulfill({ status: 200, headers: cors, contentType: 'application/json', body: JSON.stringify({ id: 'm', type: 'message', role: 'assistant', model: 'claude-haiku-5-5', content: [{ type: 'text', text: 'direct' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }) });
    });
    await d.page.goto(`${APP}#/`);
    await booted(d.page);
    const r = await d.page.evaluate(async () => {
      const { getProvider } = await import('/js/ai/providers.js');
      const { claudeProvider } = await import('/js/ai/claude.js');
      const { settings } = await import('/js/core/settings.js');
      const relay = getProvider();
      const res = await relay.complete({ model: 'claude-haiku-5-5', system: [{ text: 'You translate.', cache: true }], messages: [{ role: 'user', content: '안녕' }], maxTokens: 1000, effort: 'low' });
      const models = await relay.listModels();
      settings.set({ claude: { apiKey: 'sk-ant-test-0000' } });
      const direct = await claudeProvider.complete({ model: 'claude-haiku-5-5', messages: [{ role: 'user', content: 'hi' }], maxTokens: 100 });
      return { id: relay.id, text: res.text, usage: res.usage, models: models.map((m) => m.id), direct: direct.text };
    });
    const c = posts(d.fake)[0];
    assert(c, 'no POST /v1/messages reached the relay');
    assertEqual(r.id, 'relay', 'active provider');
    assertEqual(c.search, '', 'query string (Haiku: no beta)');
    assertEqual(c.headers['x-api-key'], CODES.haiku, 'x-api-key');
    assertEqual(c.headers['anthropic-version'], '2023-06-01', 'anthropic-version');
    assert(!c.headers['anthropic-beta'], 'unexpected anthropic-beta on Haiku');
    assertEqual([c.body.model, c.body.max_tokens, c.body.output_config], ['claude-haiku-5-5', 1000, { effort: 'low' }], 'body');
    assertEqual(c.body.system[0].cache_control, { type: 'ephemeral' }, 'system cache_control');
    assertEqual(r.text, '요약입니다. 이 논문은 중환자실 간호를 다룹니다.', 'text');
    assertEqual(r.usage, { model: 'claude-haiku-5-5', inputTokens: 1200, outputTokens: 80, cacheReadTokens: 0, cacheWriteTokens: 0 }, 'usage');
    assertEqual(r.models, ['claude-haiku-5-5'], '/v1/models (allowed models only)');
    assertEqual(anthropic.map((a) => [a.url, a.key]), [['https://api.anthropic.com/v1/messages', 'sk-ant-test-0000']], 'Claude provider unchanged');
    assert(!c.headers.cookie && c.headers['anthropic-dangerous-direct-browser-access'] === 'true', 'browser headers');
    await d.done();
    return `POST ${RELAY_URL}${c.path} x-api-key=${c.headers['x-api-key']} anthropic-version=${c.headers['anthropic-version']}; body keys ${Object.keys(c.body).join(',')}; /v1/models → ${r.models}; Claude provider → ${anthropic[0].url} with its own key`;
  });

  await test('provider: Sonnet stream → ?beta=true + fallback beta header, SSE text deltas, usage', async () => {
    const d = await device({ seed: { provider: 'relay', relay: { url: RELAY_URL, code: CODES.sonnet } } });
    await d.page.goto(`${APP}#/`);
    await booted(d.page);
    const r = await d.page.evaluate(async () => {
      const { getProvider } = await import('/js/ai/providers.js');
      const chunks = [];
      let done = null;
      for await (const ev of getProvider().stream({ model: 'claude-sonnet-5-5', messages: [{ role: 'user', content: '요약해 줘' }], maxTokens: 32000, effort: 'medium' })) {
        if (ev.type === 'text') chunks.push(ev.text);
        else done = ev;
      }
      return { chunks, done };
    });
    const c = posts(d.fake)[0];
    assertEqual(c.search, '?beta=true', 'beta query');
    assert(String(c.headers['anthropic-beta']).includes('server-side-fallback-2026-07-01'), `anthropic-beta: ${c.headers['anthropic-beta']}`);
    assertEqual([c.body.stream, c.body.fallbacks, c.body.max_tokens], [true, 'default', 32000], 'stream body');
    assertEqual(r.chunks.join(''), '요약입니다. 이 논문은 중환자실 간호를 다룹니다.', 'streamed text');
    assertEqual([r.done.usage.model, r.done.usage.outputTokens, r.done.stopReason], ['claude-sonnet-5-5', 80, 'end_turn'], 'done event');
    await d.done();
    return `POST ${c.path}${c.search} anthropic-beta=${c.headers['anthropic-beta']}; ${r.chunks.length} deltas → “${r.chunks.join('')}”; usage out=${r.done.usage.outputTokens}`;
  });

  await test('errors: relay 401/403/429 shown as-is (codes auth/not_found(model)/quota), 429 not retried, 403 re-reads /relay/me, owner-side and network failures', async () => {
    const d = await device({ seed: { provider: 'relay', relay: { url: RELAY_URL, code: CODES.haiku } } });
    await d.page.goto(`${APP}#/`);
    await booted(d.page);
    const run = (code, model = 'claude-haiku-5-5') => d.page.evaluate(async ({ code, model }) => {
      const { getProvider } = await import('/js/ai/providers.js');
      const { settings } = await import('/js/core/settings.js');
      settings.set({ provider: 'relay', relay: { code } });
      const t0 = performance.now();
      try {
        await getProvider().complete({ model, messages: [{ role: 'user', content: 'x' }], maxTokens: 100 });
        return { ok: true };
      } catch (e) {
        return { code: e.code, fatal: e.fatal, status: e.status, model: e.model ?? null, message: e.message, ms: Math.round(performance.now() - t0) };
      }
    }, { code, model });
    const stopped = await run(CODES.stopped);
    const meBefore = d.fake.calls.filter((c) => c.path === '/relay/me').length;
    const sonnet = await run(CODES.haiku, 'claude-sonnet-5-5');
    await sleep(300);
    const meAfter = d.fake.calls.filter((c) => c.path === '/relay/me').length;
    const before429 = posts(d.fake).length;
    const spent = await run(CODES.spent);
    const tries429 = posts(d.fake).length - before429;
    const ownerKey = await run(CODES.ownerKey);
    const ownerCredit = await run(CODES.ownerCredit);
    // What the SDK can see of a relay refusal across origins: x-should-retry is not in Access-Control-Expose-Headers.
    const raw = await d.page.evaluate(async ({ url, code }) => {
      const res = await fetch(`${url}/v1/messages`, { method: 'POST', headers: { 'x-api-key': code, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'claude-haiku-5-5', max_tokens: 10, messages: [{ role: 'user', content: 'x' }] }) });
      return { status: res.status, shouldRetry: res.headers.get('x-should-retry'), requestId: res.headers.get('request-id') };
    }, { url: RELAY_URL, code: CODES.spent });
    await d.ctx.route(`${RELAY_URL}/v1/**`, (route) => route.abort('connectionrefused'));
    const offline = await run(CODES.haiku);

    assertEqual([stopped.code, stopped.fatal, stopped.message], ['auth', true, '초대 코드가 올바르지 않거나 사용이 중지되었습니다.'], '401');
    // A model the code does not allow is not_found with the model (getProvider() would switch a configured model to an
    // allowed one; this request named it explicitly, so it is not replaced), with the relay's own message.
    assertEqual([sonnet.code, sonnet.fatal, sonnet.status, sonnet.model, sonnet.message], ['not_found', true, 403, 'claude-sonnet-5-5', '이 초대 코드로는 claude-sonnet-5-5을 쓸 수 없습니다.'], '403');
    assert(meAfter === meBefore + 1, `403 should re-read /relay/me once (${meBefore} → ${meAfter})`);
    assertEqual([spent.code, spent.status, spent.message], ['quota', 429, '오늘 사용 한도($0.50)를 모두 썼습니다. 내일 오전 0시(한국 시간)에 다시 열립니다.'], '429');
    assertEqual(tries429, 1, 'POSTs for one 429 (x-should-retry: false is not exposed by CORS; the client must still not retry)');
    assertEqual([raw.status, raw.shouldRetry, Boolean(raw.requestId)], [429, null, true], 'cross-origin view of a 429');
    assert(spent.ms < 3000, `429 took ${spent.ms} ms (retries?)`);
    assertEqual([ownerKey.code, ownerKey.fatal], ['server', true], 'upstream 401');
    assert(/초대해 준 분에게 알려 주세요/.test(ownerKey.message) && /초대해 준 분에게/.test(ownerCredit.message), `owner messages: ${ownerKey.message} | ${ownerCredit.message}`);
    assertEqual(offline.code, 'network', 'connection refused');
    assert(/초대 코드 서버에 연결할 수 없습니다/.test(offline.message), offline.message);
    await d.done();
    return `401 → ${stopped.code} “${stopped.message}”; 403 → ${sonnet.code} “${sonnet.message}” (+1 /relay/me); 429 → ${spent.code} in ${spent.ms} ms, ${tries429} request (page sees x-should-retry=${raw.shouldRetry}, request-id visible); upstream 401 → ${ownerKey.code}/fatal “${ownerKey.message}”; credit → “${ownerCredit.message.slice(0, 30)}…”; offline → “${offline.message}”`;
  });

  await test('translator: a relay 429 stops the run once — one fatal error, no failed sentences, ≤ concurrency requests', async () => {
    const d = await device({ seed: { provider: 'relay', relay: { url: RELAY_URL, code: CODES.spent, allowedModels: ['claude-haiku-5-5'] }, translate: { concurrency: 3 } } });
    await d.page.goto(`${APP}#/`);
    await booted(d.page);
    const r = await d.page.evaluate(async () => {
      const { Translator } = await import('/js/ai/translator.js');
      const { buildSyntheticDoc } = await import('/tests/ai/synth.js');
      const t = new Translator({ doc: buildSyntheticDoc() });
      const errors = [];
      const failed = [];
      t.addEventListener('error', (e) => errors.push(e.detail));
      t.addEventListener('update', (e) => failed.push(...(e.detail?.failed || [])));
      const t0 = performance.now();
      const progress = await t.translateAll();
      return { errors, failed, done: progress.done, ms: Math.round(performance.now() - t0) };
    });
    const sent = posts(d.fake).length;
    assertEqual(r.errors.length, 1, `error events ${JSON.stringify(r.errors)}`);
    const e = r.errors[0];
    assertEqual([e.code, e.fatal, e.sids.length], ['quota', true, 0], 'the one error');
    assert(e.message.startsWith('오늘 사용 한도($0.50)를 모두 썼습니다. 내일 오전 0시(한국 시간)에 다시 열립니다.') && e.message.includes('번역을 멈췄습니다'), e.message);
    assertEqual(r.failed.length, 0, 'failed sentences');
    assert(sent >= 1 && sent <= 3, `requests sent: ${sent}`);
    await d.done();
    return `${sent} request(s) in ${r.ms} ms → 1 error {code: ${e.code}, fatal: ${e.fatal}} “${e.message}”; 0 failed sentences (${r.done} number/URL-only sentences copied without AI)`;
  });

  await test('settings: 초대 코드 card is first; 테스트 → “홍길동님 · 오늘 $0.03 / $0.50 · 모델: Haiku 5.5”; selectors show only allowed models; usage from /relay/me', async () => {
    const d = await device();
    const { page } = d;
    await page.goto(`${APP}#/settings`);
    await page.waitForSelector('.settings');
    const cards = await page.locator('#set-ai .radio-card .radio-title').allInnerTexts();
    assertEqual(cards[0], '키 없이 쓰기 (초대 코드)', 'first card');
    await page.locator('.radio-card', { hasText: '키 없이 쓰기' }).click();
    const url = await page.inputValue('#set-ai input[aria-label="서버 주소"]');
    // An address outside the page CSP is saved but flagged; the default one clears the warning.
    await page.fill('#set-ai input[aria-label="서버 주소"]', 'https://other.example/');
    await page.locator('#set-ai input[aria-label="서버 주소"]').press('Enter');
    await page.waitForSelector('#set-ai .test-result.is-error >> text=보안 정책(CSP connect-src)');
    assertEqual((await stored(page)).relay.url, 'https://other.example', 'custom address saved');
    await page.fill('#set-ai input[aria-label="서버 주소"]', `${RELAY_URL}/`);
    await page.locator('#set-ai input[aria-label="서버 주소"]').press('Enter');
    await page.waitForFunction(() => !document.querySelector('#set-ai .test-result.is-error'));
    assertEqual((await stored(page)).relay.url, RELAY_URL, 'address normalized');
    await page.fill('#set-ai input[aria-label="초대 코드"]', 'pr-7k3m-9qxa');
    await page.locator('#set-ai .btn', { hasText: '테스트' }).click();
    await page.waitForSelector('#set-ai .test-result.is-ok');
    const ok = (await page.locator('#set-ai .test-result.is-ok').innerText()).trim();
    assertEqual(ok, '홍길동님 · 오늘 $0.03 / $0.50 · 모델: Haiku 5.5', 'test result');
    const codeValue = await page.inputValue('#set-ai input[aria-label="초대 코드"]');
    const selects = await page.$$eval('#set-ai select', (els) => els.map((s) => ({ label: s.getAttribute('aria-label'), disabled: s.disabled, options: [...s.options].map((o) => o.textContent) })));
    assertEqual(selects.map((s) => [s.disabled, s.options]), [[true, [HAIKU_LABEL]], [true, [HAIKU_LABEL]]], 'Haiku-only selectors');
    const hint = await page.locator('#set-ai .price-hint').innerText();
    await page.waitForFunction(() => /\$0\.03 \/ \$0\.50/.test(document.querySelector('#set-usage')?.textContent || ''));
    const usageText = (await page.locator('#set-usage').innerText()).replace(/\s+/g, ' ');
    assert(usageText.includes('4회') && usageText.includes('오늘 (한국 시간)') && !usageText.includes('예상 비용'), `usage panel: ${usageText}`);
    const s = await stored(page);
    assertEqual([s.provider, s.relay.code, s.relay.name, s.relay.allowedModels, s.relay.url], ['relay', 'PR-7K3M-9QXA', '홍길동', ['claude-haiku-5-5'], RELAY_URL], 'stored');
    const assist = await page.evaluate(async () => (await import('/js/core/settings.js')).settings.model('assist'));
    assertEqual(assist, 'claude-haiku-5-5', 'assist model on a Haiku-only code');
    await shot(page.locator('#set-ai'), 'relay-settings-card');
    await shot(page.locator('#set-usage'), 'relay-usage');

    // A Haiku + Sonnet code: both models offered, assist defaults to Sonnet.
    await page.fill('#set-ai input[aria-label="초대 코드"]', CODES.sonnet);
    await page.locator('#set-ai .btn', { hasText: '테스트' }).click();
    await page.waitForSelector('#set-ai .test-result.is-ok >> text=김간호님');
    const both = await page.$$eval('#set-ai select', (els) => els.map((s) => ({ disabled: s.disabled, value: s.value, n: s.options.length })));
    assertEqual(both, [{ disabled: false, value: 'claude-haiku-5-5', n: 2 }, { disabled: false, value: 'claude-sonnet-5-5', n: 2 }], 'Haiku + Sonnet selectors');
    const s2 = await stored(page);
    assertEqual([s2.relay.code, s2.relay.name, s2.relay.translateModel, s2.relay.assistModel], [CODES.sonnet, '김간호', '', ''], 'code switch resets choices');
    await d.done();
    return `cards [${cards.join(' | ')}]; 서버 주소 prefilled “${url}”; typed pr-7k3m-9qxa → ${codeValue}; “${ok}”; Haiku-only: both selects disabled [${HAIKU_LABEL}], hint “${hint.slice(0, 40)}…”; usage “${usageText.slice(0, 90)}…”; Sonnet code → assist ${both[1].value}`;
  });

  await test('join link #/join/<CODE>: welcome with the name → library; code saved, removed from the address bar', async () => {
    const d = await device({ seed: { relay: { url: RELAY_URL }, claude: { apiKey: 'sk-ant-own-key' } } });
    const { page } = d;
    await page.goto(`${APP}#/join/${CODES.haiku.toLowerCase()}`);
    await page.waitForSelector('.message-screen.tone-success');
    const title = await page.locator('.message-title').innerText();
    const text = await page.locator('.message-text').innerText();
    const hash = await page.evaluate(() => location.hash);
    assertEqual(title, '환영합니다, 홍길동님', 'title');
    assert(text.startsWith('홍길동님, 초대 코드가 등록되었습니다. 이제 키 없이 번역·요약·채팅을 쓸 수 있습니다.'), text);
    assert(text.includes('하루 한도 $0.50') && text.includes('Haiku 5.5') && text.includes('원래 쓰던 API 키는 그대로'), text);
    assertEqual(hash, '#/', 'address bar after joining');
    const s = await stored(page);
    assertEqual([s.provider, s.relay.code, s.relay.name, s.claude.apiKey], ['relay', CODES.haiku, '홍길동', 'sk-ant-own-key'], 'stored');
    await shot(page, 'relay-join-welcome');
    await page.locator('.message-actions .btn', { hasText: '논문 읽으러 가기' }).click();
    await page.waitForSelector('.library');
    const step1 = await page.locator('.step').first().getAttribute('class');
    assert(/is-done/.test(step1), `onboarding step 1: ${step1}`);
    await d.done();
    return `“${title}” / “${text.split('\n')[0]}”; hash → ${hash}; stored provider=relay code=${s.relay.code}; own Claude key kept; 논문 읽으러 가기 → library (step 1 done)`;
  });

  await test('join link: unknown code → Korean error, settings untouched, 다시 시도 succeeds once the code exists; malformed code → no request', async () => {
    const d = await device();
    const { page, fake } = d;
    await page.goto(`${APP}#/join/PR-ZZZZ-ZZZZ`);
    await page.waitForSelector('.message-screen.tone-error');
    const title = await page.locator('.message-title').innerText();
    const text = await page.locator('.message-text').innerText();
    const actions = await page.locator('.message-actions .btn').allInnerTexts();
    assertEqual(title, '초대 코드를 확인하지 못했습니다', 'title');
    assert(text.startsWith('초대 코드가 올바르지 않거나 사용이 중지되었습니다.'), text);
    assertEqual(actions, ['다시 시도', '코드 직접 입력', '라이브러리로'], 'actions');
    const s = await stored(page);
    assert(s.provider !== 'relay' && !s.relay?.code, `settings changed by a bad code: ${JSON.stringify(s)}`);
    await shot(page, 'relay-join-error');
    fake.db.set('PR-ZZZZ-ZZZZ', { ...fake.db.get(CODES.haiku), code: 'PR-ZZZZ-ZZZZ', name: '새동료', todayUsd: 0, todayRequests: 0 });
    await page.locator('.message-actions .btn', { hasText: '다시 시도' }).click();
    await page.waitForSelector('.message-screen.tone-success');
    const retried = await page.locator('.message-title').innerText();
    assertEqual(retried, '환영합니다, 새동료님', 'after retry');

    const before = fake.calls.length;
    await page.goto(`${APP}#/join/hello`);
    await page.waitForSelector('.message-screen.tone-error');
    const bad = await page.locator('.message-title').innerText();
    assertEqual(bad, '초대 링크가 올바르지 않습니다', 'malformed title');
    const relayCallsForBad = fake.calls.slice(before).filter((c) => c.path === '/relay/me' && c.headers['x-api-key'] === 'HELLO').length;
    assertEqual(relayCallsForBad, 0, 'requests for a malformed code');
    await d.done();
    return `“${title}” — “${text.split('\n')[0]}” [${actions.join(' | ')}], settings untouched; 다시 시도 → “${retried}”; #/join/hello → “${bad}” without a request`;
  });

  await test('admin: 초대 코드 관리 collapsed; token checked, saved, never shown; codes with today/month usage; create, copy, disable, edit limit, usage, 지우기', async () => {
    const d = await device({ clipboard: true, viewport: { width: 1280, height: 1000 } });
    const { page, fake } = d;
    await page.goto(`${APP}#/settings/invites`);
    await page.waitForSelector('#set-invites');
    const initiallyOpen = await page.$eval('#set-invites details.relay-admin', (e) => e.open);
    assertEqual(initiallyOpen, false, 'collapsed at first');
    const adminCallsBeforeOpen = fake.calls.filter((c) => c.path.startsWith('/relay/admin/')).length;
    assertEqual(adminCallsBeforeOpen, 0, 'admin requests before opening');
    await page.locator('#set-invites summary', { hasText: '관리 화면 열기' }).click();
    const tokenInput = page.locator('#set-invites input[aria-label="관리자 토큰"]');
    assertEqual(await tokenInput.getAttribute('type'), 'password', 'token field type');
    await tokenInput.fill('wrong-token');
    await page.locator('#set-invites .btn', { hasText: '확인하고 저장' }).click();
    await page.waitForSelector('#set-invites .test-result.is-error');
    const wrong = (await page.locator('#set-invites .test-result.is-error').innerText()).trim();
    assertEqual(wrong, '관리자 토큰이 올바르지 않습니다.', 'wrong token');
    assertEqual((await stored(page)).relay?.adminToken || '', '', 'wrong token not saved');
    await tokenInput.fill(ADMIN_TOKEN);
    await page.locator('#set-invites .btn', { hasText: '확인하고 저장' }).click();
    await page.waitForSelector('#set-invites .relay-code');
    const leaked = await page.evaluate((t) => document.documentElement.outerHTML.includes(t)
      || [...document.querySelectorAll('input, textarea')].some((i) => i.value.includes(t)), ADMIN_TOKEN);
    assertEqual(leaked, false, 'admin token visible in the page');
    assertEqual((await stored(page)).relay.adminToken, ADMIN_TOKEN, 'token saved');
    const rows = await page.locator('#set-invites .relay-code').count();
    const hong = (await page.locator(`.relay-code[data-code="${CODES.haiku}"]`).innerText()).replace(/\s+/g, ' ');
    for (const must of ['홍길동', '사용 중', '모델 Haiku만', '하루 한도 $0.50', '오늘 $0.03', '이번 달 $1.20', '누적 $3.40 · 120회']) assert(hong.includes(must), `row lacks ${must}: ${hong}`);
    const totals = (await page.locator('#set-invites .relay-codes .usage-stats').innerText()).replace(/\s+/g, ' ');
    assert(totals.includes('$0.65 / $5.00') && totals.includes('5 / 6개'), `totals: ${totals}`);
    const stoppedRow = await page.locator(`.relay-code[data-code="${CODES.stopped}"]`).innerText();
    assert(stoppedRow.includes('중지됨'), stoppedRow);

    // create: name + daily limit + Haiku + Sonnet
    await page.fill('#set-invites input[aria-label="이름"]', '최간호');
    await page.fill('#set-invites input[aria-label="하루 한도 (달러)"]', '0.8');
    await page.locator('#set-invites .relay-create .segmented .btn', { hasText: 'Haiku + Sonnet' }).click();
    await page.locator('#set-invites .btn', { hasText: '코드 만들기' }).click();
    await page.waitForSelector('#set-invites .relay-created');
    const create = posts(fake, '/relay/admin/codes').at(-1);
    assertEqual(create.body, { name: '최간호', dailyLimitUsd: 0.8, allowedModels: ['claude-haiku-5-5', 'claude-sonnet-5-5'] }, 'create body');
    assertEqual(create.headers.authorization, `Bearer ${ADMIN_TOKEN}`, 'admin auth header');
    const newCode = await page.locator('#set-invites .relay-created code').innerText();
    await page.locator('#set-invites .relay-created .btn', { hasText: '초대 메시지 복사' }).click();
    await page.waitForSelector('.toast >> text=초대 메시지를 복사했습니다');
    const invite = await page.evaluate(() => navigator.clipboard.readText());
    assert(invite.includes(`https://e2jinsoopark.github.io/#/join/${newCode}`) && invite.includes('최간호님') && invite.includes('설정 → AI 번역'), `invite: ${invite}`);
    await page.locator(`.relay-code[data-code="${CODES.haiku}"] .btn`, { hasText: '코드 복사' }).click();
    await page.waitForFunction(async (code) => (await navigator.clipboard.readText()) === code, CODES.haiku);
    await page.waitForFunction((c) => document.querySelector(`.relay-code[data-code="${c}"]`), newCode);
    await page.setViewportSize({ width: 1280, height: 2600 }); // the whole section fits: no scroll-container artefacts
    await page.waitForTimeout(150);
    await shot(page.locator('#set-invites'), 'relay-admin');
    await page.setViewportSize({ width: 1280, height: 1000 });

    // disable → enable
    await page.locator(`.relay-code[data-code="${CODES.haiku}"] .btn`, { hasText: '중지' }).click();
    await page.locator('.modal-footer .btn', { hasText: '중지' }).click();
    await page.waitForFunction((c) => /중지됨/.test(document.querySelector(`.relay-code[data-code="${c}"]`)?.textContent || ''), CODES.haiku);
    await page.locator(`.relay-code[data-code="${CODES.haiku}"] .btn`, { hasText: '다시 사용' }).click();
    await page.waitForFunction((c) => /사용 중/.test(document.querySelector(`.relay-code[data-code="${c}"]`)?.textContent || ''), CODES.haiku);
    const patches = fake.calls.filter((c) => c.method === 'PATCH').map((c) => [c.path, c.body]);
    assertEqual(patches, [[`/relay/admin/codes/${CODES.haiku}`, { active: false }], [`/relay/admin/codes/${CODES.haiku}`, { active: true }]], 'disable/enable PATCHes');

    // edit limit: out of range is explained and keeps the dialog; a valid one PATCHes only the limit
    await page.locator(`.relay-code[data-code="${CODES.haiku}"] .btn`, { hasText: '한도·모델 수정' }).click();
    await page.fill('.modal input[aria-label="하루 한도 (달러)"]', '25');
    await page.locator('.modal-footer .btn', { hasText: '저장' }).click();
    await page.waitForSelector('.toast >> text=하루 한도는 $0~$20 사이로 입력해 주세요.');
    await page.fill('.modal input[aria-label="하루 한도 (달러)"]', '1.5');
    await page.locator('.modal-footer .btn', { hasText: '저장' }).click();
    await page.waitForFunction(() => !document.querySelector('.modal-backdrop'));
    await page.waitForFunction((c) => /하루 한도 \$1\.50/.test(document.querySelector(`.relay-code[data-code="${c}"]`)?.textContent || ''), CODES.haiku);
    const edit = fake.calls.filter((c) => c.method === 'PATCH').at(-1);
    assertEqual(edit.body, { dailyLimitUsd: 1.5 }, 'edit PATCH body');

    // usage by day
    await page.locator('#set-invites summary', { hasText: '날짜별 사용량' }).click();
    await page.waitForSelector('#set-invites .data-table tbody tr');
    const usageRows = await page.locator('#set-invites .data-table tbody tr').allInnerTexts();
    assert(usageRows.length === 2 && /Haiku 5\.5 \$0\.45 · Sonnet 5\.5 \$0\.80/.test(usageRows.join(' ')), `usage rows: ${usageRows}`);

    // 지우기
    await page.locator('#set-invites .relay-token .btn', { hasText: '지우기' }).click();
    await page.waitForSelector('#set-invites input[aria-label="관리자 토큰"]');
    assertEqual((await stored(page)).relay.adminToken, '', 'token cleared');
    await d.done();
    return `collapsed, 0 admin requests until opened; wrong token → “${wrong}” (not saved); token saved, not in DOM; ${rows} codes; 홍길동 row “${hong.slice(0, 80)}…”; totals “${totals}”; created ${newCode} (Haiku + Sonnet, $0.80); invite message copied (${invite.split('\n').length} lines); disable/enable/edit PATCHes ok; usage ${usageRows.length} days; 지우기 → token removed`;
  });

  await test('narrow screen (375 px): relay card, admin list and join screens have no horizontal overflow', async () => {
    const d = await device({ seed: { provider: 'relay', relay: { url: RELAY_URL, code: CODES.haiku, adminToken: ADMIN_TOKEN } }, viewport: { width: 375, height: 800 } });
    const { page } = d;
    const overflow = () => page.evaluate(() => [document.scrollingElement, ...document.querySelectorAll('.settings, .message-screen')]
      .filter((e) => e && e.scrollWidth > e.clientWidth + 1).map((e) => `${e.className || e.nodeName} ${e.scrollWidth}>${e.clientWidth}`));
    await page.goto(`${APP}#/settings`);
    await page.waitForSelector('#set-ai .test-result.is-ok');
    await page.locator('#set-invites summary').click();
    await page.waitForSelector('#set-invites .relay-code');
    const settingsOverflow = await overflow();
    await shot(page, 'relay-narrow-settings', { fullPage: false });
    await page.goto(`${APP}#/join/PR-ZZZZ-ZZZZ`);
    await page.waitForSelector('.message-screen.tone-error');
    const joinOverflow = await overflow();
    assertEqual([...settingsOverflow, ...joinOverflow], [], 'horizontal overflow');
    await d.done();
    return 'settings (relay detail + open admin list) and join error screen fit 375 px';
  });

  await test('reader: the daily limit stops 번역 시작 with one Korean toast, no failed sentences (error state)', async () => {
    const d = await device({
      seed: { provider: 'relay', relay: { url: RELAY_URL, code: CODES.spent, name: '이한도', allowedModels: ['claude-haiku-5-5'] } },
      viewport: { width: 1440, height: 900 },
    });
    const { page, fake } = d;
    await page.goto(`${APP}#/`);
    await page.waitForSelector('.library');
    await page.setInputFiles('.lib-actions input[type=file]', [`${FIXTURES}/simwright2005.pdf`]);
    await page.waitForFunction(() => document.querySelectorAll('.paper-row').length === 1, null, { timeout: 60000 });
    await page.waitForFunction(() => !document.querySelector('.lib-actions .btn[disabled]'), null, { timeout: 60000 });
    const id = await page.$eval('.paper-row', (e) => e.dataset.id);
    await page.goto(`${APP}#/paper/${encodeURIComponent(id)}`);
    await page.waitForSelector('.tp-s[data-sid]', { timeout: 60000 });
    await page.waitForFunction(() => document.querySelector('.pdfv-page canvas'), null, { timeout: 30000 });
    await page.locator('.tb-tr-main').click();
    await page.waitForSelector('.toast-error >> text=오늘 사용 한도', { timeout: 20000 });
    await sleep(1500);
    const toasts = await page.$$eval('.toast', (els) => els.map((e) => e.querySelector('.toast-msg')?.textContent || ''));
    const failed = await page.locator('.tp-s.is-failed').count();
    const label = await page.locator('.tb-tr-main .btn-label').innerText();
    const sent = posts(fake).length;
    await shot(page, 'relay-reader-quota');
    const quotaToasts = toasts.filter((t) => t.includes('오늘 사용 한도'));
    assertEqual(quotaToasts.length, 1, `quota toasts ${JSON.stringify(toasts)}`);
    assert(quotaToasts[0].includes('내일 오전 0시') && quotaToasts[0].includes('번역을 멈췄습니다'), quotaToasts[0]);
    assertEqual(failed, 0, 'failed sentences');
    assert(sent >= 1 && sent <= 3, `requests: ${sent}`);
    await d.done();
    return `${sent} request(s); toasts ${JSON.stringify(toasts)}; ${failed} failed sentences; button “${label}”`;
  });
} finally {
  writeFileSync(`${OUT}/results.json`, JSON.stringify(results, null, 2));
  await browser.close();
  server?.kill();
  const failed = results.filter((r) => r.result !== 'pass');
  console.log(`\nrelay-client: ${results.length - failed.length}/${results.length} passed${failed.length ? ` — FAILED: ${failed.map((f) => f.name).join(' | ')}` : ''}`);
  process.exitCode = failed.length ? 1 : 0;
}
