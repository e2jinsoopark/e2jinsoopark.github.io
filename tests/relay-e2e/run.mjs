// Invite-code relay, end to end with the REAL Worker (docs/RELAY.md, docs/notes/relay.md):
//   node tests/relay-e2e/run.mjs [--headed]
// Starts, and stops again: a fake Anthropic API on 127.0.0.1:8788 (fake-anthropic.mjs, in this process), the relay
// Worker under `wrangler dev` on 127.0.0.1:8787 (fresh local D1 with relay/schema.sql, fake owner key and admin token
// as --var, so no relay/.dev.vars is needed) and `python -m http.server 8160` serving a staged copy of the site
// (test-site.mjs: the files pages.yml publishes, plus the two deploy edits — Worker origin in connect-src and
// RELAY_DEFAULT_URL — in pr-tools/out/relay-e2e/site; the repo files stay untouched). Edge runs that app with the
// real Anthropic SDK from jsDelivr.
// Scenario: the owner creates two codes in 설정 → 초대 코드 관리; a colleague in a fresh browser (no API key) opens the
// join link, uploads lu2025.pdf (read in the browser; its sentences go only to the local fake), translates through the
// relay, uses hover sync, 요약 and 채팅, runs into the $0.05 daily limit, continues after the owner raises it, and
// gets a clear message once the code is stopped. No paid API is called and nothing is deployed.
// Results + screenshots: C:/Users/dindoo/Projects/pr-tools/out/relay-e2e/.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'file:///C:/Users/dindoo/Projects/pr-tools/node_modules/playwright/index.mjs';
import { formatUsd } from '../../js/core/util.js';
import { freshDatabase, startWrangler } from '../../relay/test/lib.mjs';
import { startFakeAnthropic, SUMMARY_HEADINGS, TRANSLATION_PREFIX } from './fake-anthropic.mjs';
import { stageTestSite } from './test-site.mjs';

const APP_PORT = 8160;
const UPSTREAM_PORT = 8788;
const APP_ORIGIN = `http://127.0.0.1:${APP_PORT}`;
const WORKER = 'http://127.0.0.1:8787'; // relay/test/lib.mjs starts wrangler dev here
const OUT = 'C:/Users/dindoo/Projects/pr-tools/out/relay-e2e';
const FIXTURE = 'C:/Users/dindoo/Projects/pr-fixtures/lu2025.pdf';
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SETTINGS_KEY = 'pr.settings.v1';
const OWNER_KEY = 'sk-ant-e2e-fake-owner-key-0000';
const ADMIN_TOKEN = 'e2e-admin-token-0123456789abcdef';
const BAD_CODE_MESSAGE = '초대 코드가 올바르지 않거나 사용이 중지되었습니다.';
const QUOTA_MESSAGE = '오늘 사용 한도($0.05)를 모두 썼습니다. 내일 오전 0시(한국 시간)에 다시 열립니다. (번역을 멈췄습니다.)';
// Added to every translation batch's reported input tokens while the budget is being used up (≈ $0.009 per batch on
// Haiku 5.5, still under its 100K long-context threshold).
const PRICEY_BATCH_TOKENS = 90_000;
const headed = process.argv.includes('--headed');

mkdirSync(OUT, { recursive: true });
const results = [];
const problems = []; // page errors, unexpected console errors, CSP violations, blocked requests, native dialogs
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (s) => createHash('sha1').update(String(s ?? '')).digest('hex').slice(0, 12);

function assert(cond, msg) { if (!cond) throw new Error(msg); }
function assertEqual(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg}: expected ${e}, got ${a}`);
}

let blocked = null; // first failed step: the scenario steps after it are skipped (they build on it)

/** One scenario step. `always`: runs even after an earlier failure (it does not build on the steps before). */
async function step(name, fn, { always = false } = {}) {
  if (blocked && !always) {
    results.push({ name, result: 'skipped', evidence: `skipped: “${blocked}” failed` });
    console.log(`SKIP  ${name}`);
    return;
  }
  const t0 = Date.now();
  const before = problems.length;
  try {
    const evidence = await fn();
    const fresh = problems.slice(before);
    if (fresh.length) throw new Error(`console/CSP/network problems during the step:\n  ${fresh.join('\n  ')}`);
    results.push({ name, result: 'pass', evidence: String(evidence ?? 'ok'), ms: Date.now() - t0 });
    console.log(`PASS  ${name}  (${Date.now() - t0} ms)\n      ${evidence ?? ''}`);
  } catch (err) {
    blocked ||= name;
    results.push({ name, result: 'fail', evidence: err?.stack || String(err), ms: Date.now() - t0 });
    console.log(`FAIL  ${name}\n      ${err?.stack || err}`);
  }
}

async function waitFor(fn, { timeout = 10000, interval = 100, what = 'condition' } = {}) {
  const t0 = Date.now();
  let last;
  for (;;) {
    last = await fn();
    if (last) return last;
    if (Date.now() - t0 > timeout) throw new Error(`timeout waiting for ${what} (last: ${JSON.stringify(last)})`);
    await sleep(interval);
  }
}

// ------------------------------------------------------------------------------------------------- servers

/** The Worker's admin API, called from Node (no Origin header) to check what the UI did. */
async function admin(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${WORKER}${path}`, {
    method,
    headers: { authorization: `Bearer ${ADMIN_TOKEN}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`admin ${method} ${path} → ${res.status} ${JSON.stringify(data)}`);
  return data;
}

async function codeRecord(code) {
  const { codes } = await admin('/relay/admin/codes');
  const c = codes.find((x) => x.code === code);
  assert(c, `code ${code} not listed by the Worker`);
  return c;
}

async function relayMe(code) {
  const res = await fetch(`${WORKER}/relay/me`, { headers: { 'x-api-key': code } });
  return { status: res.status, body: await res.json() };
}

async function appUp() {
  try { return (await fetch(`${APP_ORIGIN}/index.html`)).ok; } catch { return false; }
}

/** Serve the staged site; refuses to reuse whatever else might already answer on the port. */
async function serveSite(dir) {
  if (await appUp()) throw new Error(`port ${APP_PORT} is already in use; stop that server first`);
  const proc = spawn('python', ['-m', 'http.server', String(APP_PORT), '--bind', '127.0.0.1'], { cwd: dir, stdio: 'ignore', windowsHide: true });
  await waitFor(appUp, { timeout: 8000, what: 'python http.server' });
  return proc;
}

// ------------------------------------------------------------------------------------------------- browser

/**
 * One browser context = one device. Only the app, the Worker and the pinned SDK bundle (jsDelivr /npm/) may be
 * reached; anything else is aborted and reported. Every browser → Worker response is logged in `relayLog`.
 */
async function device(name, { clipboard = false, viewport = { width: 1440, height: 900 } } = {}) {
  const ctx = await browser.newContext({ locale: 'ko-KR', viewport, colorScheme: 'light' });
  if (clipboard) await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: APP_ORIGIN });
  await ctx.route(/^https?:\/\/(?!127\.0\.0\.1:(?:8160|8787)\/)/, (route) => {
    const url = route.request().url();
    if (url.startsWith('https://cdn.jsdelivr.net/gh/orioncactus/pretendard')) {
      return route.fulfill({ status: 200, contentType: 'text/css', body: '/* font stub (offline test) */' });
    }
    if (url.startsWith('https://cdn.jsdelivr.net/npm/')) return route.continue(); // the pinned SDK bundle + deps
    problems.push(`${name}: external request blocked ${url}`);
    return route.abort();
  });
  await ctx.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (e) => {
      console.error(`[csp] ${e.violatedDirective} blocked ${e.blockedURI}`);
    });
  });
  const page = await ctx.newPage();
  const relayLog = [];
  page.on('response', (res) => {
    const req = res.request();
    if (!req.url().startsWith(WORKER) || req.method() === 'OPTIONS') return;
    const u = new URL(req.url());
    relayLog.push({ method: req.method(), path: u.pathname, search: u.search, status: res.status(), body: sha(req.postData()), at: Date.now() });
  });
  page.on('requestfailed', (req) => {
    if (!req.url().startsWith(WORKER)) return;
    const u = new URL(req.url());
    relayLog.push({ method: req.method(), path: u.pathname, search: u.search, status: 'failed', error: req.failure()?.errorText, body: sha(req.postData()), at: Date.now() });
  });
  page.on('pageerror', (e) => problems.push(`${name}: pageerror ${e.message}`));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    // Chromium logs every non-2xx answer; the relay's refusals (wrong token, budget, stopped code) are expected.
    if (/^Failed to load resource/.test(m.text()) && String(m.location()?.url || '').startsWith(WORKER)) return;
    problems.push(`${name}: console.error ${m.text()}`);
  });
  page.on('dialog', (d) => {
    problems.push(`${name}: native ${d.type()} dialog “${d.message()}”`);
    d.dismiss().catch(() => {});
  });
  return { name, ctx, page, relayLog };
}

const shot = (target, file, opts = {}) => target.screenshot({ path: `${OUT}/${file}.png`, ...opts });
const stored = (page) => page.evaluate((key) => JSON.parse(localStorage.getItem(key) || '{}'), SETTINGS_KEY);
const messagePosts = (log, from = 0) => log.slice(from).filter((r) => r.method === 'POST' && r.path === '/v1/messages');

async function waitForReader(page) {
  await page.waitForFunction(() => document.querySelector('.tp-s[data-sid], .tp-empty, .reader .message-screen'), null, { timeout: 60000 });
  const error = await page.$('.reader .message-screen');
  if (error) throw new Error(`reader error: ${(await error.textContent()).trim()}`);
  await page.waitForFunction(() => !document.querySelector('.reader-left .reader-loading'), null, { timeout: 30000 });
  await page.waitForFunction(() => document.querySelector('.pdfv-page canvas'), null, { timeout: 30000 });
  await sleep(500);
}

/** Translation state of the open reader. */
function readerState(page) {
  return page.evaluate(() => ({
    translated: document.querySelectorAll('.tp-s.is-translated').length,
    pending: document.querySelectorAll('.tp-s.is-pending').length,
    failed: document.querySelectorAll('.tp-s.is-failed').length,
    label: document.querySelector('.tb-tr-main .btn-label')?.textContent || '',
    status: document.querySelector('.tp-header-status')?.textContent?.trim() || '',
  }));
}

const toasts = (page) => page.$$eval('.toast', (els) => els.map((e) => ({ kind: [...e.classList].find((c) => c.startsWith('toast-')), text: e.querySelector('.toast-msg')?.textContent || '' })));

/** Hover a pane sentence with real mouse moves; resolves once the pane marks it .is-hover. */
async function hoverPaneSpan(page, sid) {
  await page.evaluate((sid) => {
    const span = document.querySelector(`.tp-s[data-sid="${sid}"]`);
    const host = document.querySelector('.tp-host').getBoundingClientRect();
    const r = span.getClientRects()[0];
    if (r.top < host.top + 8 || r.bottom > host.bottom - 8) span.scrollIntoView({ block: 'center' });
  }, sid);
  const r = await page.evaluate((sid) => {
    const rect = document.querySelector(`.tp-s[data-sid="${sid}"]`).getClientRects()[0];
    return { x: rect.left, y: rect.top, w: rect.width, h: rect.height };
  }, sid);
  await page.mouse.move(r.x + r.w / 2, r.y - 40);
  await page.mouse.move(r.x + Math.min(r.w / 2, 40), r.y + r.h / 2, { steps: 4 });
  await page.waitForFunction((s) => document.querySelector(`.tp-s.is-hover[data-sid="${s}"]`), sid, { timeout: 3000 });
}

/** Text of the PDF text-layer spans under the viewer's hover highlight boxes. */
function wordsUnderHover(page) {
  return page.evaluate(() => {
    const boxes = [...document.querySelectorAll('.pdfv-hl--hover')].map((n) => n.getBoundingClientRect());
    const seen = new Set();
    let text = '';
    for (const r of boxes) {
      for (let i = 1; i < 12; i++) {
        for (const node of document.elementsFromPoint(r.left + (r.width * i) / 12, r.top + r.height / 2)) {
          if (node.matches?.('.textLayer span') && !node.querySelector('span') && !seen.has(node)) {
            seen.add(node);
            text += ` ${node.textContent}`;
          }
        }
      }
    }
    return { boxes: boxes.map((r) => ({ x: r.left, y: r.top, w: r.width, h: r.height })), text: text.trim() };
  });
}

const words = (s) => String(s).toLowerCase().match(/[a-z]{3,}/g) || [];
function wordOverlap(sentence, found) {
  const want = words(sentence);
  const have = new Set(words(found));
  return want.length ? want.filter((w) => have.has(w)).length / want.length : 1;
}

/** Ask a chat question in the open reader; returns the last assistant bubble once it stopped streaming. */
async function askChat(page, question) {
  await page.locator('.tab[data-tab="chat"]').click();
  await page.waitForSelector('.pf-chat__input');
  const before = await page.locator('.pf-msg--assistant').count();
  await page.locator('.pf-chat__input').fill(question);
  await page.locator('[data-action="send"]').click();
  const lengths = [];
  for (let i = 0; i < 200; i++) {
    const st = await page.evaluate((before) => {
      const all = document.querySelectorAll('.pf-msg--assistant');
      const msg = all.length > before ? all[all.length - 1] : null;
      return msg ? { len: msg.textContent.length, streaming: msg.classList.contains('is-streaming') } : null;
    }, before);
    if (st) lengths.push(st.len);
    if (st && !st.streaming && st.len > 0) break;
    await sleep(40);
  }
  const last = page.locator('.pf-msg--assistant').last();
  return {
    lengths,
    error: await last.evaluate((n) => n.classList.contains('pf-msg--error')),
    text: (await last.locator('.pf-msg__body').innerText()).trim(),
    chips: await last.locator('.pf-sid').count(),
  };
}

// ===================================================================================================== run

let server = null;
let fake = null;
let stopWrangler = () => {};
let browser = null;
const state = {};

try {
  const staged = stageTestSite({ repo: REPO, dir: join(OUT, 'site'), workerUrl: WORKER });
  server = await serveSite(join(OUT, 'site'));
  console.log(`staged ${staged.join(', ')} with RELAY_DEFAULT_URL = ${WORKER} → ${APP_ORIGIN}`);
  fake = await startFakeAnthropic({ port: UPSTREAM_PORT });
  const stateDir = join(OUT, 'state');
  freshDatabase(stateDir);
  stopWrangler = await startWrangler({
    stateDir,
    logFile: join(OUT, 'wrangler.log'),
    // Production vars from relay/wrangler.jsonc (ALLOWED_ORIGINS, limits, models) plus the fake upstream and secrets.
    vars: { UPSTREAM_URL: fake.url, ANTHROPIC_API_KEY: OWNER_KEY, ADMIN_TOKEN },
  });
  browser = await chromium.launch({ channel: 'msedge', headless: !headed, slowMo: headed ? 40 : 0 });

  const owner = await device('owner', { clipboard: true, viewport: { width: 1280, height: 1000 } });
  const colleague = await device('colleague');

  await step('admin: wrong admin token → clear Korean message, not saved; the right one is checked, saved and never shown', async () => {
    const { page } = owner;
    await page.goto(`${APP_ORIGIN}/index.html#/settings/invites`);
    await page.waitForSelector('#set-invites');
    await page.locator('#set-invites summary', { hasText: '관리 화면 열기' }).click();
    const token = page.locator('#set-invites input[aria-label="관리자 토큰"]');
    await token.fill('wrong-admin-token-0000000000');
    await page.locator('#set-invites .btn', { hasText: '확인하고 저장' }).click();
    await page.waitForSelector('#set-invites .test-result.is-error');
    const wrong = (await page.locator('#set-invites .test-result.is-error').innerText()).trim();
    assertEqual(wrong, '관리자 토큰이 올바르지 않습니다.', 'wrong token message');
    assertEqual((await stored(page)).relay?.adminToken || '', '', 'wrong token stored');
    const refused = owner.relayLog.filter((r) => r.path === '/relay/admin/codes' && r.status === 401).length;
    await token.fill(ADMIN_TOKEN);
    await page.locator('#set-invites .btn', { hasText: '확인하고 저장' }).click();
    await page.waitForSelector('#set-invites .relay-codes >> text=아직 만든 초대 코드가 없습니다');
    const leaked = await page.evaluate((t) => document.documentElement.outerHTML.includes(t)
      || [...document.querySelectorAll('input, textarea')].some((i) => i.value.includes(t)), ADMIN_TOKEN);
    assertEqual(leaked, false, 'admin token visible in the page');
    assertEqual((await stored(page)).relay.adminToken, ADMIN_TOKEN, 'token saved');
    const address = await page.evaluate(async () => (await import('/js/core/settings.js')).settings.relayUrl());
    assertEqual(address, WORKER, 'server address (RELAY_DEFAULT_URL of the test copy)');
    return `“${wrong}” (Worker answered 401 ×${refused}, nothing stored); right token → empty code list from the real Worker at ${address}; token not in the DOM`;
  });

  await step('admin: create two codes in the UI (김동료: Haiku만, $0.05/day; 박동료: Haiku + Sonnet, $0.50/day); invite message copied', async () => {
    const { page } = owner;
    const create = async (name, limit, set) => {
      await page.fill('#set-invites input[aria-label="이름"]', name);
      await page.fill('#set-invites input[aria-label="하루 한도 (달러)"]', limit);
      await page.locator('#set-invites .relay-create .segmented .btn', { hasText: new RegExp(`^${set.replace(/[+]/g, '\\+')}$`) }).click();
      await page.locator('#set-invites .btn', { hasText: '코드 만들기' }).click();
      await page.waitForSelector(`#set-invites .relay-created >> text=${name}님의 초대 코드를 만들었습니다`);
      return (await page.locator('#set-invites .relay-created code').innerText()).trim();
    };
    state.code1 = await create('김동료', '0.05', 'Haiku만');
    await page.locator('#set-invites .relay-created .btn', { hasText: '초대 메시지 복사' }).click();
    await page.waitForSelector('.toast >> text=초대 메시지를 복사했습니다');
    state.invite = await page.evaluate(() => navigator.clipboard.readText());
    state.code2 = await create('박동료', '0.5', 'Haiku + Sonnet');
    await page.waitForFunction((codes) => codes.every((c) => document.querySelector(`.relay-code[data-code="${c}"]`)), [state.code1, state.code2]);
    const link = `https://e2jinsoopark.github.io/#/join/${state.code1}`;
    assert(/^PR-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/.test(state.code1) && state.code1 !== state.code2, `codes ${state.code1} ${state.code2}`);
    assert(state.invite.includes(link) && state.invite.includes('김동료님') && state.invite.includes('하루 한도 $0.05'), `invite message: ${state.invite}`);
    const c1 = await codeRecord(state.code1);
    const c2 = await codeRecord(state.code2);
    assertEqual([c1.name, c1.active, c1.allowedModels, c1.dailyLimitUsd], ['김동료', true, ['claude-haiku-5-5'], 0.05], 'code 1 in the Worker');
    assertEqual([c2.name, c2.active, c2.allowedModels, c2.dailyLimitUsd], ['박동료', true, ['claude-haiku-5-5', 'claude-sonnet-5-5'], 0.5], 'code 2 in the Worker');
    return `${state.code1} (Haiku만, $0.05) and ${state.code2} (Haiku + Sonnet, $0.50) stored in D1 as created; invite message:\n        ${state.invite.replace(/\n/g, '\n        ')}`;
  });

  await step('colleague: a fresh browser (no API key) opens the join link → welcome by name → library', async () => {
    const { page } = colleague;
    const fragment = state.invite.match(/#\/join\/\S+/)[0];
    await page.goto(`${APP_ORIGIN}/${fragment}`); // the invite link's fragment on the local copy of the app
    await page.waitForSelector('.message-screen.tone-success', { timeout: 30000 });
    const title = await page.locator('.message-title').innerText();
    const text = await page.locator('.message-text').innerText();
    const hash = await page.evaluate(() => location.hash);
    assertEqual(title, '환영합니다, 김동료님', 'welcome title');
    assert(text.startsWith('김동료님, 초대 코드가 등록되었습니다. 이제 키 없이 번역·요약·채팅을 쓸 수 있습니다.') && text.includes('하루 한도 $0.05') && text.includes('Haiku 5.5'), text);
    assertEqual(hash, '#/', 'address bar after joining');
    const s = await stored(page);
    assertEqual([s.provider, s.relay.code, s.relay.name, s.relay.allowedModels, s.claude?.apiKey || '', s.gemini?.apiKey || ''],
      ['relay', state.code1, '김동료', ['claude-haiku-5-5'], '', ''], 'stored settings');
    await shot(page, 'e2e-relay-01-join-welcome');
    await page.locator('.message-actions .btn', { hasText: '논문 읽으러 가기' }).click();
    await page.waitForSelector('.library');
    const step1 = await page.locator('.step').first().innerText();
    assert(step1.includes('초대 코드로 연결되어 있습니다') && /is-done/.test(await page.locator('.step').first().getAttribute('class')), `onboarding step 1: ${step1}`);
    return `“${title}” — “${text.split('\n')[0]}”; hash → ${hash}; stored provider=relay, code=${s.relay.code}, no Claude/Gemini key; library step 1: “${step1.replace(/\s+/g, ' ')}”`;
  });

  await step('colleague: upload lu2025.pdf, 이 페이지만 번역 (1쪽) → sentences fill through the relay (Haiku, owner key upstream)', async () => {
    const { page } = colleague;
    await page.setInputFiles('.lib-actions input[type=file]', [FIXTURE]);
    await page.waitForFunction(() => document.querySelectorAll('.paper-row').length === 1, null, { timeout: 60000 });
    await page.waitForFunction(() => !document.querySelector('.lib-actions .btn[disabled]'), null, { timeout: 60000 });
    state.paperId = await page.$eval('.paper-row', (e) => e.dataset.id);
    await page.goto(`${APP_ORIGIN}/index.html#/paper/${encodeURIComponent(state.paperId)}`);
    await waitForReader(page);
    const before = await readerState(page);
    const logFrom = colleague.relayLog.length;
    await page.locator('.tb-tr-more').click();
    await page.locator('.menu .menu-item', { hasText: '이 페이지만 번역' }).click();
    const samples = [];
    const s = await waitFor(async () => {
      const st = await readerState(page);
      samples.push(st.translated);
      return st.translated > 0 && st.pending === 0 && st.label !== '번역 중…' ? st : null;
    }, { timeout: 60000, interval: 120, what: 'page 1 translated' });
    await page.waitForSelector('.toast >> text=번역을 마쳤습니다.');
    const shown = await page.$$eval('.tp-s.is-translated[data-sid]', (els) => els.map((e) => ({ sid: e.dataset.sid, text: e.textContent })));
    const calls = fake.calls.filter((c) => c.kind === 'translate');
    const posted = messagePosts(colleague.relayLog, logFrom);
    const ids = calls.flatMap((c) => c.ids);
    const sent = new Set(ids);
    // Sentences that are only a URL/DOI or a number are shown as they are, without a request.
    const asIs = shown.filter((x) => !sent.has(x.sid));
    assert(sent.size > 3 && shown.filter((x) => sent.has(x.sid)).every((x) => x.text.startsWith(TRANSLATION_PREFIX))
      && shown.filter((x) => sent.has(x.sid)).length === sent.size, `pane texts for the sent sentences: ${JSON.stringify(shown.slice(0, 3))}`);
    assert(asIs.every((x) => /^(https?:\/\/\S+|[\d\s.,:;()%+\-–]+)$/.test(x.text.trim())), `translated without a request: ${JSON.stringify(asIs)}`);
    assertEqual(s.failed, 0, 'failed sentences');
    assertEqual(s.label, '이어서 번역', 'button after a page-only run');
    assert(calls.length >= 1 && calls.every((c) => c.model === 'claude-haiku-5-5' && c.search === '' && c.headers['x-api-key'] === OWNER_KEY), `upstream calls ${JSON.stringify(calls.map((c) => [c.model, c.search]))}`);
    assertEqual(posted.map((r) => r.status), calls.map(() => 200), 'browser → Worker POST /v1/messages statuses (one per upstream call: no retries)');
    assert(ids.every((id) => /^p1-/.test(id)), `sent ids outside page 1: ${ids.filter((id) => !/^p1-/.test(id))}`);
    await shot(page, 'e2e-relay-02-page1-translated');
    return `${before.translated} → ${s.translated} translated (samples ${[...new Set(samples)].join('→')}); ${calls.length} batch(es) of ${ids.length} page-1 sentences, each one browser POST → 200 and one upstream call with the owner key; shown as is: ${asIs.map((x) => x.text).join(', ') || '-'}; status “${s.status}”`;
  });

  await step('hover sync still works on relay-translated sentences (pane → PDF boxes, PDF → pane)', async () => {
    const { page } = colleague;
    const sid = await page.evaluate(() => {
      const h = document.querySelector('.tp-host').getBoundingClientRect();
      return [...document.querySelectorAll('.tp-s.is-translated.tp-kind-body[data-sid^="p1-"]')]
        .filter((s) => s.textContent.length > 80)
        .find((s) => { const r = s.getBoundingClientRect(); return r.top > h.top + 20 && r.bottom < h.bottom - 20; })?.dataset.sid;
    });
    assert(sid, 'no translated page-1 sentence visible in the pane');
    const paneText = await page.$eval(`.tp-s[data-sid="${sid}"]`, (e) => e.textContent);
    await hoverPaneSpan(page, sid);
    await page.waitForSelector('.pdfv-hl--hover');
    await page.evaluate(() => {
      const hl = document.querySelector('.pdfv-hl--hover').getBoundingClientRect();
      const v = document.querySelector('.viewer-host').getBoundingClientRect();
      if (hl.top < v.top + 20 || hl.bottom > v.bottom - 20) document.querySelector('.pdfv-hl--hover').scrollIntoView({ block: 'center' });
    });
    await sleep(300);
    await hoverPaneSpan(page, sid);
    const under = await wordsUnderHover(page);
    const overlap = wordOverlap(paneText.slice(TRANSLATION_PREFIX.length), under.text);
    assert(overlap >= 0.85, `PDF words under the hover boxes cover ${Math.round(overlap * 100)}% of the sentence (“${under.text.slice(0, 100)}”)`);
    await shot(page, 'e2e-relay-03-hover');
    const b = under.boxes[0];
    await page.mouse.move(5, 300);
    await page.waitForFunction((s) => !document.querySelector(`.tp-s.is-hover[data-sid="${s}"]`), sid);
    await page.mouse.move(b.x + b.w / 2, b.y + b.h / 2, { steps: 5 });
    await page.waitForFunction((s) => document.querySelector(`.tp-s.is-hover[data-sid="${s}"]`), sid, { timeout: 3000 });
    await page.mouse.move(5, 300);
    return `${sid}: pane → PDF ${under.boxes.length} box(es) over ${Math.round(overlap * 100)}% of its words; PDF box → pane .is-hover`;
  });

  await step('요약 through the relay: Haiku-only code → Haiku 5.5, six headings rendered with sentence chips', async () => {
    const { page } = colleague;
    const from = fake.calls.length;
    await page.locator('.tab[data-tab="summary"]').click();
    await page.locator('[data-action="generate"]').click();
    await page.waitForFunction((n) => document.querySelectorAll('.pf-summary__body h2').length >= n, SUMMARY_HEADINGS.length, { timeout: 30000 });
    const info = await page.evaluate(() => ({
      heads: [...document.querySelectorAll('.pf-summary__body h2')].map((h) => h.textContent.trim()),
      bold: [...document.querySelectorAll('.pf-summary__body strong')].map((b) => b.textContent),
      chips: document.querySelectorAll('.pf-summary__body .pf-sid').length,
    }));
    const calls = fake.calls.slice(from);
    assertEqual(info.heads, SUMMARY_HEADINGS, 'headings');
    assert(info.chips >= 3 && info.bold.includes('41%'), `chips ${info.chips}, bold ${info.bold}`);
    assertEqual(calls.map((c) => [c.kind, c.model, Boolean(c.body.stream), c.search]), [['summary', 'claude-haiku-5-5', false, '']], 'upstream calls');
    await shot(page, 'e2e-relay-04-summary');
    return `${info.heads.join(' / ')}; ${info.chips} chips; one upstream call ${calls[0].model} (non-stream), ${calls[0].usage.input_tokens} in / ${calls[0].usage.output_tokens} out`;
  });

  await step('채팅 streams through the relay (SSE passthrough, deltas arrive one by one)', async () => {
    const { page } = colleague;
    const from = fake.calls.length;
    const r = await askChat(page, '이 연구의 대상은 누구인가요?');
    const calls = fake.calls.slice(from);
    assert(!r.error, `chat error: ${r.text}`);
    assert(r.text.startsWith('중계 서버를 거친 답변입니다. 이 연구는 중환자실 간호사를 대상으로 수행되었습니다'), r.text);
    assert(new Set(r.lengths).size >= 3, `answer did not stream (lengths ${r.lengths.join(',')})`);
    assert(r.chips >= 1, 'no sentence chip in the answer');
    assertEqual(calls.map((c) => [c.kind, c.model, c.body.stream, c.closedEarly]), [['chat', 'claude-haiku-5-5', true, false]], 'upstream calls');
    await shot(page, 'e2e-relay-05-chat');
    return `“${r.text}” streamed in ${new Set(r.lengths).size} distinct lengths (${r.lengths.filter((v, i, a) => a.indexOf(v) === i).slice(0, 6).join('→')}…); ${r.chips} chip(s)`;
  });

  await step('usage: the Worker booked exactly the upstream-reported tokens; the admin list shows it', async () => {
    const calls = fake.calls.length; // everything so far came from code 1
    const expectedUsd = fake.calls.reduce((s, c) => s + c.usd, 0);
    const c1 = await waitFor(async () => {
      const c = await codeRecord(state.code1);
      return c.totalRequests === calls ? c : null;
    }, { timeout: 10000, what: `${calls} requests booked for code 1` });
    assert(Math.abs(c1.todayUsd - expectedUsd) <= 2e-6, `Worker today $${c1.todayUsd} vs upstream-reported $${expectedUsd}`);
    assert(c1.lastUsedAt, 'lastUsedAt not stamped');
    const { page } = owner;
    await page.locator('#set-invites .relay-codes .btn', { hasText: '새로 고침' }).click();
    await page.waitForFunction(([c, n]) => (document.querySelector(`.relay-code[data-code="${c}"]`)?.textContent || '').includes(`${n}회`), [state.code1, calls]);
    const row = (await page.locator(`.relay-code[data-code="${state.code1}"]`).innerText()).replace(/\s+/g, ' ');
    for (const must of [`오늘 ${formatUsd(c1.todayUsd)}`, `이번 달 ${formatUsd(c1.monthUsd)}`, `· ${calls}회`, '마지막 사용', '하루 한도 $0.05', '모델 Haiku만']) {
      assert(row.includes(must), `row lacks “${must}”: ${row}`);
    }
    const totals = (await page.locator('#set-invites .relay-codes .usage-stats').innerText()).replace(/\s+/g, ' ');
    assert(totals.includes(`${formatUsd(c1.todayUsd)} / $5.00`) && totals.includes('2 / 2개'), `totals: ${totals}`);
    await page.setViewportSize({ width: 1280, height: 2000 });
    await shot(page.locator('#set-invites'), 'e2e-relay-06-admin-usage');
    await page.setViewportSize({ width: 1280, height: 1000 });
    state.phase1Usd = c1.todayUsd;
    return `${calls} requests, Worker $${c1.todayUsd} = upstream-reported $${expectedUsd.toFixed(6)}; admin row “${row.slice(0, 120)}…”; totals “${totals}”`;
  });

  await step('budget: the $0.05 limit stops 이어서 번역 once with the Korean message — no failed sentences, no retries', async () => {
    const { page } = colleague;
    await page.locator('.tab[data-tab="translation"]').click();
    fake.control.extraInputTokens = PRICEY_BATCH_TOKENS;
    const logFrom = colleague.relayLog.length;
    const callsFrom = fake.calls.length;
    const before = await readerState(page);
    assertEqual(before.label, '이어서 번역', 'button before');
    await page.locator('.tb-tr-main').click();
    await page.waitForSelector('.toast-error >> text=오늘 사용 한도', { timeout: 60000 });
    await sleep(2500); // let the batches that were in flight settle
    const after = await readerState(page);
    const shown = await toasts(page);
    const posts = messagePosts(colleague.relayLog, logFrom);
    const refused = posts.filter((r) => r.status === 429);
    // A retry would send the identical body again and get another answer.
    const sameBody = refused.filter((r) => posts.filter((p) => p.body === r.body && p.status !== 'failed').length > 1);
    const c1 = await codeRecord(state.code1);
    const forwarded = fake.calls.slice(callsFrom);
    await shot(page, 'e2e-relay-07-budget-stop');
    const quota = shown.filter((t) => t.text.includes('오늘 사용 한도'));
    assertEqual(quota.map((t) => [t.kind, t.text]), [['toast-error', QUOTA_MESSAGE]], 'quota toasts');
    assert(!shown.some((t) => /번역하지 못했습니다/.test(t.text)), `failed-sentence toast: ${JSON.stringify(shown)}`);
    assertEqual([after.failed, after.pending, after.label], [0, 0, '이어서 번역'], 'pane after the stop');
    assert(after.translated > before.translated, `nothing translated before the limit (${before.translated} → ${after.translated})`);
    assert(refused.length >= 1 && refused.length <= 3, `429s seen by the browser: ${refused.length} (concurrency is 3)`);
    assertEqual(sameBody.length, 0, 'a refused request body sent again (SDK retry)');
    assert(forwarded.every((c) => c.kind === 'translate'), 'unexpected upstream calls');
    assert(c1.todayUsd >= 0.05, `Worker today $${c1.todayUsd} < $0.05`);
    state.stoppedAt = after.translated;
    return `${before.translated} → ${after.translated} translated; ${forwarded.length} batch(es) forwarded, then ${refused.length} × 429 (each body sent once); Worker today $${c1.todayUsd}; one toast “${quota[0].text}”; 0 failed / 0 pending; button “${after.label}”`;
  });

  await step('owner raises the limit to $1.00 in the UI → 이어서 번역 continues to 번역 완료', async () => {
    const { page } = owner;
    await page.locator(`.relay-code[data-code="${state.code1}"] .btn`, { hasText: '한도·모델 수정' }).click();
    await page.fill('.modal input[aria-label="하루 한도 (달러)"]', '1');
    await page.locator('.modal-footer .btn', { hasText: '저장' }).click();
    await page.waitForFunction(() => !document.querySelector('.modal-backdrop'));
    await page.waitForFunction((c) => /하루 한도 \$1\.00/.test(document.querySelector(`.relay-code[data-code="${c}"]`)?.textContent || ''), state.code1);
    assertEqual((await codeRecord(state.code1)).dailyLimitUsd, 1, 'Worker limit');
    fake.control.extraInputTokens = 0;
    const c = colleague.page;
    const logFrom = colleague.relayLog.length;
    await c.locator('.tb-tr-main').click();
    const s = await waitFor(async () => {
      const st = await readerState(c);
      return st.label === '번역 완료' || (st.failed && st.label !== '번역 중…') ? st : null;
    }, { timeout: 180000, interval: 250, what: '번역 완료' });
    const posts = messagePosts(colleague.relayLog, logFrom);
    assertEqual([s.label, s.failed, s.pending], ['번역 완료', 0, 0], 'reader after the run');
    assert(posts.length > 0 && posts.every((r) => r.status === 200), `POST statuses ${[...new Set(posts.map((r) => r.status))]}`);
    await page.waitForTimeout(300);
    await shot(c, 'e2e-relay-08-translation-complete');
    return `limit $1.00 saved (PATCH from the UI); ${state.stoppedAt} → ${s.translated} translated in ${posts.length} more request(s), all 200; “${s.status}”`;
  });

  await step('colleague settings: 초대 코드 card and 사용량 show the Worker’s numbers for today', async () => {
    const { page } = colleague;
    const me = (await relayMe(state.code1)).body;
    await page.evaluate(() => { location.hash = '#/settings'; });
    await page.waitForSelector('#set-ai .test-result.is-ok', { timeout: 15000 });
    const card = (await page.locator('#set-ai .test-result.is-ok').innerText()).trim();
    const expected = `김동료님 · 오늘 ${formatUsd(me.todayUsd)} / $1.00 · 모델: Haiku 5.5`;
    assertEqual(card, expected, 'status line');
    await page.waitForFunction((t) => (document.querySelector('#set-usage')?.textContent || '').includes(t), `${formatUsd(me.todayUsd)} / $1.00`);
    const usage = (await page.locator('#set-usage').innerText()).replace(/\s+/g, ' ');
    assert(usage.includes(`${me.todayRequests}회`) && usage.includes('오늘 (한국 시간)'), `usage panel: ${usage}`);
    await shot(page.locator('#set-usage'), 'e2e-relay-09-colleague-usage');
    return `“${card}”; 사용량 “${usage.slice(0, 90)}…” (Worker: $${me.todayUsd}, ${me.todayRequests} requests)`;
  });

  await step('stopped code → clear Korean message (settings 테스트 and 채팅), nothing forwarded', async () => {
    const { page } = owner;
    await page.locator(`.relay-code[data-code="${state.code1}"] .btn`, { hasText: '중지' }).click();
    await page.locator('.modal-footer .btn', { hasText: '중지' }).click();
    await page.waitForFunction((c) => /중지됨/.test(document.querySelector(`.relay-code[data-code="${c}"]`)?.textContent || ''), state.code1);
    assertEqual((await codeRecord(state.code1)).active, false, 'Worker active flag');
    const c = colleague.page;
    const callsFrom = fake.calls.length;
    await c.locator('#set-ai .btn', { hasText: '테스트' }).click();
    await c.waitForSelector('#set-ai .test-result.is-error');
    const test = (await c.locator('#set-ai .test-result.is-error').innerText()).trim();
    assertEqual(test, BAD_CODE_MESSAGE, 'settings 테스트');
    await c.goto(`${APP_ORIGIN}/index.html#/paper/${encodeURIComponent(state.paperId)}`);
    await waitForReader(c);
    const r = await askChat(c, '결론을 알려 주세요.');
    assert(r.error && r.text.includes(BAD_CODE_MESSAGE), `chat bubble: error=${r.error} “${r.text}”`);
    assertEqual(fake.calls.length, callsFrom, 'upstream calls for a stopped code');
    await shot(c, 'e2e-relay-10-stopped-code');
    return `중지 → Worker active=false; 테스트 → “${test}”; 채팅 → “${r.text}”; 0 upstream calls`;
  });

  await step('Haiku + Sonnet code: join link, Sonnet offered and used for 요약·채팅 (beta fallback header via the Worker)', async () => {
    const other = await device('colleague-2');
    const { page } = other;
    await page.goto(`${APP_ORIGIN}/#/join/${state.code2}`);
    await page.waitForSelector('.message-screen.tone-success', { timeout: 30000 });
    const text = await page.locator('.message-text').innerText();
    assert(text.includes('Haiku 5.5, Sonnet 5.5') && text.includes('하루 한도 $0.50'), text);
    await page.evaluate(() => { location.hash = '#/settings'; });
    await page.waitForSelector('#set-ai .test-result.is-ok', { timeout: 15000 });
    const selects = await page.$$eval('#set-ai select', (els) => els.map((s) => ({ disabled: s.disabled, value: s.value, n: s.options.length })));
    assertEqual(selects, [{ disabled: false, value: 'claude-haiku-5-5', n: 2 }, { disabled: false, value: 'claude-sonnet-5-5', n: 2 }], 'model selectors');
    const from = fake.calls.length;
    const r = await page.evaluate(async () => {
      const { getProvider } = await import('/js/ai/providers.js');
      const { settings } = await import('/js/core/settings.js');
      let text = '';
      for await (const ev of getProvider().stream({ model: settings.model('assist'), messages: [{ role: 'user', content: '요약해 주세요.' }], maxTokens: 32000, effort: 'medium' })) {
        if (ev.type === 'text') text += ev.text;
      }
      return { model: settings.model('assist'), text };
    });
    const call = fake.calls[from];
    assertEqual(fake.calls.length - from, 1, 'upstream calls');
    assertEqual([r.model, call.model, call.search, call.body.fallbacks, call.body.stream], ['claude-sonnet-5-5', 'claude-sonnet-5-5', '?beta=true', 'default', true], 'Sonnet request');
    assert(String(call.headers['anthropic-beta']).includes('server-side-fallback-2026-07-01'), `anthropic-beta ${call.headers['anthropic-beta']}`);
    assert(r.text.startsWith('중계 서버를 거친 답변입니다.'), r.text);
    const usage = await waitFor(async () => {
      const { days } = await admin(`/relay/admin/usage?days=1&code=${state.code2}`);
      return days[0].byModel['claude-sonnet-5-5'] ? days[0] : null;
    }, { what: 'Sonnet usage booked for code 2' });
    await other.ctx.close();
    return `welcome “${text.split('\n')[1]}”; selectors Haiku/Sonnet enabled, assist = ${r.model}; stream → upstream ${call.path}${call.search} anthropic-beta=${call.headers['anthropic-beta']}; booked ${JSON.stringify(usage.byModel)}`;
  }, { always: true });

  await step('admin: 날짜별 사용량 lists today with Haiku and Sonnet', async () => {
    const { page } = owner;
    await page.locator('#set-invites summary', { hasText: '날짜별 사용량' }).click();
    await page.waitForSelector('#set-invites .data-table tbody tr');
    const rows = await page.locator('#set-invites .data-table tbody tr').allInnerTexts();
    const { days } = await admin('/relay/admin/usage?days=30');
    assertEqual(rows.length, 1, 'usage rows (one day)');
    assert(rows[0].includes(days[0].day) && /Haiku 5\.5 \$/.test(rows[0]) && /Sonnet 5\.5 \$/.test(rows[0]) && rows[0].includes(String(days[0].requests)), `row ${rows[0]}`);
    return `“${rows[0].replace(/\s+/g, ' ')}” (Worker: ${days[0].day} $${days[0].usd}, ${days[0].requests} requests)`;
  }, { always: true });

  await step('upstream hygiene over the whole run: owner key only, no invite code / admin token / browser headers forwarded', async () => {
    assert(fake.calls.length > 0, 'no upstream calls');
    const secrets = [state.code1, state.code2, ADMIN_TOKEN].filter(Boolean);
    const bad = [];
    for (const c of fake.calls) {
      if (c.headers['x-api-key'] !== OWNER_KEY) bad.push(`#${c.n} x-api-key ${c.headers['x-api-key']}`);
      for (const h of ['authorization', 'cookie', 'origin', 'referer', 'anthropic-dangerous-direct-browser-access']) if (c.headers[h]) bad.push(`#${c.n} ${h}`);
      if (Object.keys(c.headers).some((h) => h.startsWith('x-stainless'))) bad.push(`#${c.n} x-stainless-*`);
      const all = `${JSON.stringify(c.headers)}${JSON.stringify(c.body)}`;
      for (const s of secrets) if (all.includes(s)) bad.push(`#${c.n} contains ${s}`);
    }
    assertEqual(bad, [], 'upstream header/body problems');
    const names = [...new Set(fake.calls.flatMap((c) => Object.keys(c.headers)))].sort();
    const kinds = fake.calls.reduce((m, c) => ({ ...m, [c.kind]: (m[c.kind] || 0) + 1 }), {});
    return `${fake.calls.length} upstream calls (${Object.entries(kinds).map(([k, v]) => `${k} ${v}`).join(', ')}), headers seen: ${names.join(', ')}`;
  }, { always: true });
} catch (err) {
  results.push({ name: 'test environment', result: 'fail', evidence: err?.stack || String(err) });
  console.log(`SETUP FAILED: ${err?.stack || err}`);
} finally {
  writeFileSync(`${OUT}/results.json`, JSON.stringify(results, null, 2));
  await browser?.close();
  stopWrangler();
  await fake?.close();
  server?.kill();
  const failed = results.filter((r) => r.result === 'fail');
  const skipped = results.filter((r) => r.result === 'skipped');
  const passed = results.length - failed.length - skipped.length;
  console.log(`\nrelay-e2e: ${passed}/${results.length} passed${failed.length ? ` — FAILED: ${failed.map((f) => f.name).join(' | ')}` : ''}${skipped.length ? ` (${skipped.length} skipped)` : ''}`);
  process.exitCode = failed.length || skipped.length ? 1 : 0;
}
