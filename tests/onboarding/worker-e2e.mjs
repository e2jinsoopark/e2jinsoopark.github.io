// 첫 화면 · 맞춤 코드 · 홈 화면에 추가 · 시도 제한, end to end with the REAL relay Worker (docs/notes/onboarding.md):
//   node tests/onboarding/worker-e2e.mjs [--headed]
// Starts, and stops again:
//   - a fake GitHub on 127.0.0.1:8223 (tests/store/fake-github.mjs) holding the team repo of relay/wrangler.jsonc
//     SHARED_LIBRARIES (dindoopark/paper-team-library), reached only by the Worker through GITHUB_API_BASE;
//   - a fake Anthropic API on 127.0.0.1:8224 (tests/relay-e2e/fake-anthropic.mjs; nothing here translates, it is there
//     so that no request could ever reach the real API);
//   - the relay Worker under `wrangler dev` on 127.0.0.1:8787 (relay/test/lib.mjs: fresh local D1 with relay/schema.sql)
//     with the production vars of relay/wrangler.jsonc plus GITHUB_API_BASE, UPSTREAM_URL and fake secrets; no TEST_MODE;
//   - `python -m http.server 8222` serving a staged copy of the site (tests/relay-e2e/test-site.mjs: the files
//     pages.yml publishes + the two deploy edits; the repo files stay untouched).
// Browsers: Edge (desktop and Pixel 7 emulation) and WebKit with the iPhone 15 profile. Each device sends its own
// CF-Connecting-IP (added by route interception; wrangler dev passes a client-sent one through, Cloudflare sets it
// itself in production), so the failed-attempt limiter sees separate callers. No paid API, no real GitHub, no real
// relay, nothing deployed.
// Scenario: the owner makes EICU2-2026 (코드 직접 정하기) and a random code in the UI and copies both invite messages;
// a fresh Edge pastes the WHOLE random-code message into the first screen → 공용 서재; a fresh iPhone types
// "eicu2-2026" → 공용 서재, 홈 화면에 추가 → #/join/EICU2-2026 in the address + one-line popover, no manifest; the
// home-screen app (new storage, standalone) starts at that address twice: silent registration, then nothing at all;
// Android gets the manifest and a beforeinstallprompt-driven button; 21 wrong codes from one IP → 429 on the 21st
// while EICU2-2026 still opens from another IP (and a generated code from the same IP).
// Results + screenshots: C:/Users/dindoo/Projects/pr-tools/out/onboarding/worker-e2e/.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, devices, webkit } from 'file:///C:/Users/dindoo/Projects/pr-tools/node_modules/playwright/index.mjs';
import { freshDatabase, personIdOf, portInUse, saltOf, startWrangler } from '../../relay/test/lib.mjs';
import { startFakeAnthropic } from '../relay-e2e/fake-anthropic.mjs';
import { stageTestSite } from '../relay-e2e/test-site.mjs';
import { startFakeGitHub } from '../store/fake-github.mjs';

const APP_PORT = 8222;
const GITHUB_PORT = 8223;
const UPSTREAM_PORT = 8224;
const APP = `http://127.0.0.1:${APP_PORT}`;
const WORKER = 'http://127.0.0.1:8787'; // relay/test/lib.mjs starts wrangler dev here
const OUT = 'C:/Users/dindoo/Projects/pr-tools/out/onboarding/worker-e2e';
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SETTINGS_KEY = 'pr.settings.v1';
const OWNER_KEY = 'sk-ant-onboarding-e2e-fake-owner-key-0000';
const ADMIN_TOKEN = 'onboarding-e2e-admin-token-0123456789abcdef';
const TEAM = { owner: 'dindoopark', repo: 'paper-team-library', token: 'github_pat_team_onboarding_e2e_0123456789' };
const CUSTOM = 'EICU2-2026';
const TOO_MANY = '시도가 너무 많습니다. 잠시 후 다시 시도해 주세요.';
const NOT_FOUND = '코드를 찾을 수 없어요';
const IP = {
  owner: '198.51.100.10', kim: '198.51.100.11', iphone: '198.51.100.12', home: '198.51.100.13', android: '198.51.100.14',
  guesser: '203.0.113.66', other: '203.0.113.77', node: '198.51.100.99',
};
const headed = process.argv.includes('--headed');

mkdirSync(OUT, { recursive: true });
const results = [];
const problems = []; // page errors, unexpected console errors, CSP violations, escaped requests, native dialogs
const expectedRefusals = []; // the browsers' "Failed to load resource" for the Worker's 401 / 409 / 429 the tests ask for
const sdkFetches = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** The Worker's local D1 (freshDatabase): read-only checks of the person salts it stored. */
const STATE_DIR = join(OUT, 'state');

function assert(cond, msg) { if (!cond) throw new Error(msg); }
function assertEqual(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg}: expected ${e}, got ${a}`);
}

let blocked = null; // first failed step: the steps after it are skipped (they build on it)

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
    if (!always) blocked ||= name;
    results.push({ name, result: 'fail', evidence: err?.stack || String(err), ms: Date.now() - t0 });
    console.log(`FAIL  ${name}\n      ${err?.stack || err}`);
  }
}

async function waitFor(fn, { timeout = 15000, interval = 150, what = 'condition' } = {}) {
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

/** The Worker from Node (no Origin header): admin API or an invite code; `ip` → CF-Connecting-IP. */
async function worker(path, { admin = false, code = null, ip = IP.node } = {}) {
  const headers = { 'cf-connecting-ip': ip };
  if (admin) headers.authorization = `Bearer ${ADMIN_TOKEN}`;
  if (code) headers.authorization = `Bearer ${code}`;
  const res = await fetch(`${WORKER}${path}`, { headers });
  let body = null;
  try { body = await res.json(); } catch { /* not JSON */ }
  return { status: res.status, body, headers: res.headers };
}

async function appUp() {
  try { return (await fetch(`${APP}/index.html`)).ok; } catch { return false; }
}

async function serveSite(dir) {
  if (await appUp() || await portInUse(APP_PORT)) throw new Error(`port ${APP_PORT} is already in use; stop that server first`);
  const proc = spawn('python', ['-m', 'http.server', String(APP_PORT), '--bind', '127.0.0.1'], { cwd: dir, stdio: 'ignore', windowsHide: true });
  await waitFor(appUp, { timeout: 8000, what: 'python http.server' });
  return proc;
}

// ------------------------------------------------------------------------------------------------- browsers

let edge = null;
let wk = null;

/**
 * One browser context = one device (its own storage). `engine` 'edge' | 'webkit'; `profile` a Playwright device;
 * `ip` the CF-Connecting-IP its Worker requests carry; `standalone` = an installed / home-screen app
 * (navigator.standalone and display-mode: standalone). Only the staged app and the Worker may be reached (the
 * pinned SDK bundle on jsDelivr would pass, and is recorded); anything else is aborted and reported.
 * `log`: every Worker response (not preflights) with its status and retry headers.
 */
async function device(name, { engine = 'edge', profile = null, viewport = null, seed = null, ip, standalone = false, clipboard = false } = {}) {
  const browser = engine === 'webkit' ? wk : edge;
  if (!browser) throw new Error(`${engine} is not available`);
  const base = profile ? { ...devices[profile] } : {};
  delete base.defaultBrowserType;
  const ctx = await browser.newContext({
    ...base, ...(viewport ? { viewport } : {}), locale: 'ko-KR', colorScheme: 'light', reducedMotion: 'reduce',
  });
  if (clipboard) await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: APP });
  await ctx.route(/^https?:\/\/(?!127\.0\.0\.1:(?:8222|8787)\/)/, (route) => {
    const url = route.request().url();
    if (url.startsWith('https://cdn.jsdelivr.net/gh/orioncactus/pretendard')) {
      return route.fulfill({ status: 200, contentType: 'text/css', body: '/* font stub (offline test) */' });
    }
    if (url.startsWith('https://cdn.jsdelivr.net/npm/')) { sdkFetches.push(`${name}: ${url}`); return route.continue(); }
    problems.push(`${name}: external request blocked ${url}`);
    return route.abort();
  });
  await ctx.route(`${WORKER}/**`, (route) => route.continue({ headers: { ...route.request().headers(), 'cf-connecting-ip': ip } }));
  await ctx.addInitScript(({ key, seed, standalone }) => {
    try { if (seed && !localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify(seed)); } catch { /* blocked */ }
    document.addEventListener('securitypolicyviolation', (e) => {
      console.error(`[csp] ${e.violatedDirective} blocked ${e.blockedURI}`);
    });
    // What was ever on screen: the first screen (with its form, or quiet), a welcome message.
    window.__seen = { start: false, startForm: false, welcome: false };
    new MutationObserver(() => {
      const s = document.querySelector('.start');
      if (s) {
        window.__seen.start = true;
        if (!s.classList.contains('is-quiet')) window.__seen.startForm = true;
      }
      if (document.querySelector('.message-screen.tone-success')) window.__seen.welcome = true;
    }).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
    if (standalone) {
      try { Object.defineProperty(Navigator.prototype, 'standalone', { get: () => true, configurable: true }); } catch { /* ignore */ }
      const mm = window.matchMedia.bind(window);
      window.matchMedia = (q) => (/display-mode:\s*standalone/.test(q)
        ? { matches: true, media: q, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; } }
        : mm(q));
    }
  }, { key: SETTINGS_KEY, seed, standalone });
  const page = await ctx.newPage();
  const log = [];
  page.on('response', (res) => {
    const req = res.request();
    if (!req.url().startsWith(WORKER) || req.method() === 'OPTIONS') return;
    const h = res.headers();
    log.push({ method: req.method(), path: new URL(req.url()).pathname, status: res.status(), retry: h['x-should-retry'] ?? null, after: h['retry-after'] ?? null });
  });
  page.on('pageerror', (e) => problems.push(`${name}: pageerror ${e.message}`));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const where = String(m.location()?.url || '');
    if (/Failed to load resource/.test(m.text()) && where.startsWith(WORKER)) {
      expectedRefusals.push(`${name}: ${m.text()} ${where.replace(/\?.*$/, '')}`);
      return;
    }
    problems.push(`${name}: console.error ${m.text()}`);
  });
  page.on('dialog', (d) => {
    problems.push(`${name}: native ${d.type()} dialog “${d.message()}”`);
    d.dismiss().catch(() => {});
  });
  return { name, ctx, page, log };
}

const shot = (page, file) => page.screenshot({ path: `${OUT}/${file}.png` });
const stored = (page) => page.evaluate((key) => JSON.parse(localStorage.getItem(key) || '{}'), SETTINGS_KEY);
const hashOf = (page) => page.evaluate(() => location.hash);
const seen = (page) => page.evaluate(() => window.__seen);
const errorLine = (page) => page.evaluate(() => document.querySelector('.start-error')?.textContent || '');
const me = (log) => log.filter((r) => r.path === '/relay/me');
const visibleInstall = (page) => page.$$eval('.install-btn', (els) => els.filter((e) => e.offsetParent !== null)
  .map((e) => (e.classList.contains('lib-install-head') ? 'header' : 'sidebar')));

async function firstScreen(page) {
  await page.waitForSelector('.start:not(.is-quiet) .start-input', { timeout: 30000 });
}
async function sharedReady(page) {
  await page.waitForSelector('.lib-sec[data-lib="shared:mine"] .lib-sec-body .lib-nav-heading', { timeout: 30000 });
  await page.waitForSelector('.lib-sec[data-lib="shared:team"] .lib-sec-body .lib-nav-heading', { timeout: 30000 });
}
/** The code's own library ('<name> 서재', #/s/mine) is the open place — an invitee's home since code libraries. */
async function inSharedLibrary(page) {
  await page.waitForSelector('.library', { timeout: 30000 });
  await sharedReady(page);
  await page.waitForFunction(() => location.hash === '#/s/mine', null, { timeout: 15000 });
}
/** Submit the first screen and wait for its answer: the library, or an error line with 시작 enabled again. */
async function submitAndWait(page) {
  await page.click('.start-go');
  await page.waitForFunction(() => document.querySelector('.library')
    || (document.querySelector('.start-error')?.textContent && !document.querySelector('.start-go')?.disabled), null, { timeout: 30000 });
  return errorLine(page);
}

// ===================================================================================================== run

let server = null;
let gh = null;
let fake = null;
let stopWrangler = () => {};
const state = {};
const people = [];

try {
  const staged = stageTestSite({ repo: REPO, dir: join(OUT, 'site'), workerUrl: WORKER });
  server = await serveSite(join(OUT, 'site'));
  console.log(`staged ${staged.join(', ')} with RELAY_DEFAULT_URL = ${WORKER} → ${APP}`);
  gh = await startFakeGitHub({ port: GITHUB_PORT });
  gh.addToken(TEAM.token, { write: true, repos: [`${TEAM.owner}/${TEAM.repo}`] });
  gh.createRepo(TEAM.owner, TEAM.repo, { private: true, files: { 'README.md': '# 공용 서재\n' } });
  fake = await startFakeAnthropic({ port: UPSTREAM_PORT });
  const stateDir = STATE_DIR;
  freshDatabase(stateDir);
  stopWrangler = await startWrangler({
    stateDir,
    logFile: join(OUT, 'wrangler.log'),
    // Production vars of relay/wrangler.jsonc (ALLOWED_ORIGINS, SHARED_LIBRARIES, limits) plus the fakes and fake secrets.
    vars: { UPSTREAM_URL: fake.url, ANTHROPIC_API_KEY: OWNER_KEY, ADMIN_TOKEN, GITHUB_API_BASE: gh.url, TEAM_GITHUB_TOKEN: TEAM.token },
  });
  edge = await chromium.launch({ channel: 'msedge', headless: !headed, slowMo: headed ? 40 : 0 });
  try { wk = await webkit.launch({ headless: !headed }); } catch (err) { console.log(`WebKit unavailable: ${err.message.split('\n')[0]}`); }

  await step('owner: 설정 → 초대 코드 관리 makes EICU2-2026 (코드 직접 정하기) and a random code; 409 for another spelling; both 3-line messages copied', async () => {
    const owner = await device('owner', { viewport: { width: 1280, height: 1000 }, seed: { relay: { adminToken: ADMIN_TOKEN } }, ip: IP.owner, clipboard: true });
    people.push(owner);
    const { page } = owner;
    await page.goto(`${APP}/index.html#/settings/invites`);
    await page.locator('#set-invites summary', { hasText: '관리 화면 열기' }).click();
    await page.waitForSelector('#set-invites .relay-codes >> text=아직 만든 초대 코드가 없습니다', { timeout: 15000 });
    const name = page.locator('#set-invites input[aria-label="이름"]');
    const custom = page.locator('#set-invites input[aria-label="코드 직접 정하기"]');
    const create = page.locator('#set-invites .btn', { hasText: '코드 만들기' });
    const copyMessage = async () => {
      await page.locator('#set-invites .relay-created .btn', { hasText: '초대 메시지 복사' }).click();
      await page.waitForSelector('.toast >> text=초대 메시지를 복사했습니다');
      const text = (await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, '\n');
      await page.locator('.toast').first().waitFor({ state: 'detached', timeout: 10000 }).catch(() => {});
      return text;
    };
    await name.fill('응급중환자실팀');
    await custom.fill(CUSTOM);
    await create.click();
    await page.waitForSelector('#set-invites .relay-created >> text=응급중환자실팀님의 초대 코드를 만들었습니다');
    const createdCustom = (await page.locator('#set-invites .relay-created code').innerText()).trim();
    state.customMessage = await copyMessage();
    // Another spelling of the same key → the Worker's 409, shown as it is.
    await name.fill('중복');
    await custom.fill('eicu2 2026');
    await create.click();
    await page.waitForSelector('#set-invites .subsection .test-result.is-error');
    const taken = (await page.locator('#set-invites .subsection .test-result.is-error').first().innerText()).trim();
    // Blank → a random PR-XXXX-XXXX.
    await name.fill('김간호사');
    await custom.fill('');
    await create.click();
    await page.waitForSelector('#set-invites .relay-created >> text=김간호사님의 초대 코드를 만들었습니다');
    state.random = (await page.locator('#set-invites .relay-created code').innerText()).trim();
    state.randomMessage = await copyMessage();
    await page.waitForFunction((codes) => codes.every((c) => document.querySelector(`.relay-code[data-code="${c}"]`)), [CUSTOM, state.random]);
    await page.setViewportSize({ width: 1280, height: 1500 });
    await shot(page, 'worker-e2e-01-admin');
    const { body } = await worker('/relay/admin/codes', { admin: true });
    const byCode = Object.fromEntries(body.codes.map((c) => [c.code, c]));
    assertEqual(createdCustom, CUSTOM, 'created custom code');
    assert(/^PR-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/.test(state.random), `random code ${state.random}`);
    assertEqual([byCode[CUSTOM]?.name, byCode[CUSTOM]?.active, byCode[state.random]?.name, body.codes.length], ['응급중환자실팀', true, '김간호사', 2], 'codes in D1');
    assert(taken.startsWith('이미 있는 코드입니다'), `409 line: ${taken}`);
    assertEqual(state.customMessage.split('\n'), ['[갈피 초대] 응급중환자실팀님', `https://e2jinsoopark.github.io/#/join/${CUSTOM}`, `코드: ${CUSTOM}`], 'custom invite message');
    assertEqual(state.randomMessage.split('\n'), ['[갈피 초대] 김간호사님', `https://e2jinsoopark.github.io/#/join/${state.random}`, `코드: ${state.random}`], 'random invite message');
    return `${CUSTOM} (응급중환자실팀) and ${state.random} (김간호사) in D1 as made in the UI; “eicu2 2026” → “${taken}”; messages:\n        ${state.customMessage.replace(/\n/g, ' ⏎ ')}\n        ${state.randomMessage.replace(/\n/g, ' ⏎ ')}`;
  });

  await step('Edge, fresh browser: the WHOLE invite message pasted into the first screen → 시작 → 공용 서재 (no welcome)', async () => {
    const kim = await device('kim', { viewport: { width: 1440, height: 900 }, ip: IP.kim, clipboard: true });
    people.push(kim);
    const { page, log } = kim;
    await page.goto(`${APP}/`);
    await firstScreen(page);
    // A real paste (Ctrl+V from the clipboard), as someone copying the KakaoTalk message does.
    await page.evaluate((text) => navigator.clipboard.writeText(text), state.randomMessage);
    await page.focus('.start-input');
    await page.keyboard.press('Control+V');
    let how = 'Ctrl+V';
    const pasted = await page.waitForFunction(() => document.querySelector('.start-input').value, null, { timeout: 3000 })
      .then((h) => h.jsonValue()).catch(() => '');
    if (!pasted) throw new Error('Ctrl+V did not paste into the first screen');
    const value = await page.inputValue('.start-input');
    await shot(page, 'worker-e2e-02-pasted');
    await page.click('.start-go');
    await inSharedLibrary(page);
    const s = await stored(page);
    const sw = await seen(page);
    await page.waitForTimeout(300);
    await shot(page, 'worker-e2e-03-kim-shared');
    assertEqual(value, state.random, 'input after pasting the message');
    assertEqual([s.provider, s.relay?.code, s.relay?.name], ['relay', state.random, '김간호사'], 'stored');
    assertEqual(sw.welcome, false, 'a welcome screen was shown');
    assertEqual(me(log).map((r) => r.status), [200], '/relay/me answers');
    assert(log.some((r) => r.path === '/shared' && r.status === 200), `GET /shared: ${JSON.stringify(log)}`);
    how += `; input “${value}”`;
    return `${how}; 시작 → #/s/mine (the code’s own 서재) from the real Worker; stored ${s.relay.code} (${s.relay.name}); Worker calls ${log.map((r) => `${r.method} ${r.path} ${r.status}`).slice(0, 4).join(', ')}…`;
  });

  if (wk) {
    await step('iPhone (WebKit): bare site → first screen → types “eicu2-2026” → 공용 서재; 홈 화면에 추가 → #/join/EICU2-2026 + one-line popover; no manifest', async () => {
      const phone = await device('iphone-safari', { engine: 'webkit', profile: 'iPhone 15', ip: IP.iphone });
      people.push(phone);
      const { page, log } = phone;
      await page.goto(`${APP}/`);
      await firstScreen(page);
      const head = await page.evaluate(() => ({
        manifest: document.querySelectorAll('link[rel="manifest"]').length,
        capable: document.querySelector('meta[name="apple-mobile-web-app-capable"]')?.content,
        title: document.querySelector('meta[name="apple-mobile-web-app-title"]')?.content,
        icon: document.querySelector('link[rel="apple-touch-icon"]')?.getAttribute('href'),
      }));
      await page.locator('.start-input').pressSequentially('eicu2-2026', { delay: 20 });
      await shot(page, 'worker-e2e-04-iphone-typed');
      await page.click('.start-go');
      await inSharedLibrary(page);
      const s = await stored(page);
      const install = await visibleInstall(page);
      await page.click('.lib-install-head');
      await page.waitForSelector('.install-popover');
      const tip = (await page.locator('.install-popover .install-tip-text').innerText()).replace(/\s+/g, ' ').trim();
      state.saved = await page.evaluate(() => location.href);
      const manifestAfter = await page.evaluate(() => document.querySelectorAll('link[rel="manifest"]').length);
      await page.waitForTimeout(300);
      await shot(page, 'worker-e2e-05-iphone-popover');
      assertEqual(head, { manifest: 0, capable: 'yes', title: '갈피', icon: 'assets/brand/icon-180.png' }, 'iOS head');
      assertEqual([s.provider, s.relay?.code, s.relay?.name], ['relay', CUSTOM, '응급중환자실팀'], 'stored');
      assertEqual(me(log).map((r) => r.status), [200], '/relay/me answers');
      assertEqual(install, ['header'], 'install button');
      assertEqual([new URL(state.saved).hash, tip, manifestAfter], [`#/join/${CUSTOM}`, '공유 → 홈 화면에 추가', 0], 'after 홈 화면에 추가');
      return `no <link rel=manifest>, apple-mobile-web-app-capable=yes, title 갈피, icon-180; typed eicu2-2026 → stored ${s.relay.code} (${s.relay.name}) → #/s/mine; 홈 화면에 추가 → address ${new URL(state.saved).hash}, popover “${tip}”, still no manifest`;
    });

    await step('iPhone home-screen app (new storage, standalone) launched at #/join/EICU2-2026 twice: silent registration → 공용 서재, then straight in; never a form or a welcome', async () => {
      const home = await device('ios-home-screen', { engine: 'webkit', profile: 'iPhone 15', ip: IP.home, standalone: true });
      people.push(home);
      const { page, log } = home;
      const launches = [];
      for (let n = 1; n <= 2; n++) {
        if (n > 1) await page.goto('about:blank');
        const before = me(log).length;
        await page.goto(state.saved);
        await inSharedLibrary(page);
        await page.waitForTimeout(400); // a late request would show up here
        launches.push({ seen: await seen(page), me: me(log).slice(before).map((r) => r.status), hash: await hashOf(page), install: await visibleInstall(page) });
        await shot(page, `worker-e2e-06-home-screen-launch-${n}`);
      }
      const s = await stored(page);
      assertEqual(launches[0], { seen: { start: true, startForm: false, welcome: false }, me: [200], hash: '#/s/mine', install: [] }, 'first launch (quiet registration)');
      assertEqual(launches[1], { seen: { start: false, startForm: false, welcome: false }, me: [], hash: '#/s/mine', install: [] }, 'second launch');
      assertEqual([s.provider, s.relay?.code], ['relay', CUSTOM], 'stored in the home-screen app');
      return `launch 1: quiet screen only (mark + spinner), 1 × /relay/me 200 → #/s/mine; launch 2: no screen, 0 requests → #/s/mine; no install button in the app; stored ${s.relay.code}`;
    });
  } else {
    results.push({ name: 'iPhone (WebKit) steps', result: 'skipped', evidence: 'WebKit is not installed' });
  }

  await step('Android (Edge, Pixel 7): join link → 공용 서재; manifest injected; 홈 화면에 추가 → the browser\'s install prompt (beforeinstallprompt) → gone after install', async () => {
    const android = await device('android', { profile: 'Pixel 7', ip: IP.android });
    people.push(android);
    const { page } = android;
    const fragment = state.customMessage.match(/#\/join\/\S+/)[0];
    await page.goto(`${APP}/${fragment}`);
    await inSharedLibrary(page);
    const manifest = await page.$$eval('link[rel="manifest"]', (els) => els.map((e) => e.href));
    const m = await page.evaluate(async (href) => { const r = await fetch(href); return { status: r.status, json: await r.json() }; }, manifest[0]);
    const before = await visibleInstall(page);
    const prevented = await page.evaluate(() => {
      const e = new Event('beforeinstallprompt', { cancelable: true });
      window.__prompted = 0;
      e.prompt = async () => { window.__prompted++; };
      e.userChoice = Promise.resolve({ outcome: 'accepted', platform: 'web' });
      window.dispatchEvent(e);
      return e.defaultPrevented;
    });
    await page.waitForTimeout(200);
    await shot(page, 'worker-e2e-07-android-library');
    await page.click('.lib-install-head');
    await page.waitForFunction(() => window.__prompted === 1);
    await page.waitForFunction(() => [...document.querySelectorAll('.install-btn')].every((b) => b.hidden));
    const popovers = await page.locator('.install-popover').count();
    assertEqual(manifest, [`${APP}/manifest.webmanifest`], 'manifest link');
    assertEqual([m.status, m.json.start_url, m.json.display], [200, './', 'standalone'], 'manifest');
    assertEqual([before, prevented, popovers], [['header'], true, 0], 'install button, prompt kept (no mini-infobar), no hint after the prompt');
    return `#/join/${CUSTOM} → #/s/mine; <link rel=manifest> ${manifest[0].replace(APP, '')} (start_url ${m.json.start_url}, ${m.json.display}); button in the header; beforeinstallprompt preventDefault'ed → click → prompt() once → accepted → button gone`;
  });

  await step('limiter: 21 wrong codes from one IP → the 21st is the Worker\'s 429 line; EICU2-2026 still opens from another IP; the same IP: custom refused, generated code works', async () => {
    const guesser = await device('guesser', { viewport: { width: 390, height: 844 }, ip: IP.guesser });
    people.push(guesser);
    const { page, log } = guesser;
    await page.goto(`${APP}/`);
    await firstScreen(page);
    const lines = [];
    for (let i = 1; i <= 21; i++) {
      await page.fill('.start-input', `MISS-CODE-${String(i).padStart(2, '0')}`);
      lines.push(await submitAndWait(page));
    }
    await shot(page, 'worker-e2e-08-too-many');
    const answers = me(log).map((r) => r.status);
    const last = me(log).at(-1);
    // Another IP (a colleague elsewhere) is not affected.
    const other = await device('other-ip', { viewport: { width: 390, height: 844 }, ip: IP.other });
    people.push(other);
    await other.page.goto(`${APP}/`);
    await firstScreen(other.page);
    await other.page.fill('.start-input', 'eicu2 2026');
    await other.page.click('.start-go');
    await inSharedLibrary(other.page);
    const otherStored = (await stored(other.page)).relay?.code;
    // The same IP while blocked: a custom code is refused like a guess (otherwise 200-vs-429 would reveal it), a
    // generated code (40 random bits) still works.
    await page.fill('.start-input', CUSTOM);
    const customSameIp = await submitAndWait(page);
    await page.fill('.start-input', state.random);
    await page.click('.start-go');
    await inSharedLibrary(page);
    assertEqual(lines.slice(0, 20), Array(20).fill(NOT_FOUND), 'lines 1–20');
    assertEqual(lines[20], TOO_MANY, 'line 21');
    assertEqual(answers.slice(0, 21), [...Array(20).fill(401), 429], 'Worker answers 1–21');
    assertEqual([last.retry, Number(last.after) > 0 && Number(last.after) <= 600], ['false', true], '429 headers');
    assertEqual([otherStored, customSameIp], ['EICU2-2026', TOO_MANY], 'other IP / custom code on the blocked IP');
    return `#1–20 → “${NOT_FOUND}” (401); #21 → “${lines[20]}” (429, x-should-retry ${last.retry}, retry-after ${last.after}s); other IP: “eicu2 2026” → 공용 서재 (stored ${otherStored}); blocked IP: ${CUSTOM} → “${customSameIp}”, ${state.random} (generated) → 공용 서재`;
  });

  await step('personId: every spelling of EICU2-2026 is one person in 공용 서재 (SHA-256 of the stored code + its person salt)', async () => {
    const spellings = ['EICU2-2026', 'eicu22026', 'Eicu2 2026', 'eicu2--2026'];
    const ids = [];
    for (const code of spellings) {
      const r = await worker('/shared', { code });
      assertEqual(r.status, 200, `GET /shared with “${code}”`);
      ids.push(r.body.personId);
    }
    const random = await worker('/shared', { code: state.random.toLowerCase() });
    assertEqual(new Set(ids).size, 1, 'one personId');
    // Codes made since code deletion (2026-10-19) carry a random person salt (codes.person_salt, docs/RELAY.md §5).
    const salts = [await saltOf(CUSTOM, STATE_DIR), await saltOf(state.random, STATE_DIR)];
    assert(salts.every((x) => /^[0-9a-f]{32}$/.test(x || '')) && salts[0] !== salts[1], `person salts ${JSON.stringify(salts)}`);
    assertEqual([ids[0], random.body.personId], [personIdOf(CUSTOM, salts[0]), personIdOf(state.random, salts[1])], 'personId = SHA-256(stored code, newline, salt)');
    return `${spellings.map((s) => `“${s}”`).join(', ')} → people/${ids[0]}; ${state.random.toLowerCase()} → people/${random.body.personId} (each = SHA-256 of the stored code and its own 128-bit salt)`;
  });

  await step('no console errors, page errors, CSP violations, native dialogs or escaped requests; nothing reached the (fake) Anthropic API', async () => {
    assert(!problems.length, problems.join('\n'));
    assertEqual(fake.calls.length, 0, 'upstream calls');
    return `0 problems; ${expectedRefusals.length} refusals the browsers logged (asked for); ${sdkFetches.length} SDK bundle fetches; 0 upstream calls`;
  }, { always: true });
} catch (err) {
  results.push({ name: 'test environment', result: 'fail', evidence: err?.stack || String(err) });
  console.log(`SETUP FAILED: ${err?.stack || err}`);
} finally {
  writeFileSync(`${OUT}/results.json`, JSON.stringify(results, null, 2));
  for (const p of people) await p.ctx.close().catch(() => {});
  await edge?.close().catch(() => {});
  await wk?.close().catch(() => {});
  stopWrangler();
  await fake?.close().catch(() => {});
  await gh?.close().catch(() => {});
  server?.kill();
  const passed = results.filter((r) => r.result === 'pass').length;
  const failed = results.filter((r) => r.result === 'fail');
  const skipped = results.filter((r) => r.result === 'skipped');
  console.log(`\nonboarding worker-e2e: ${passed}/${results.length} passed${failed.length ? ` — FAILED: ${failed.map((f) => f.name).join(' | ')}` : ''}${skipped.length ? ` (${skipped.length} skipped)` : ''}`);
  process.exitCode = failed.length || skipped.length ? 1 : 0;
}
