// 첫 화면 · 초대 코드 붙여넣기 · 홈 화면에 추가 · 코드 직접 정하기 (docs/notes/onboarding.md), end to end:
//   node tests/onboarding/run.mjs [--headed]     (starts `python -m http.server 8221` if nothing is listening; PR_TEST_PORT=… for another port)
// Edge (Chromium) for desktop and Android (Pixel 7 emulation), and WebKit with the iPhone 15 profile for iOS Safari
// (install once: node C:/Users/dindoo/Projects/pr-tools/node_modules/playwright/cli.js install webkit). WebKit is
// Safari's engine, not Safari: the home-screen web clip itself (which address iOS saves, its separate storage) can
// only be checked on a real iPhone — here a fresh context with `navigator.standalone = true` stands in for it.
// The real app talks to https://relay.test, route-intercepted: /relay/me, /v1/*, /relay/admin/* → tests/relay-client/
// fake-relay.mjs (custom codes matched by key, 409, the failed-attempt limiter — relay/src/codes.js rules), and
// /shared* → tests/store/fake-relay.mjs in front of tests/store/fake-github.mjs (공용 서재). index.html is answered with
// a TEST COPY whose CSP connect-src also lists https://relay.test. No paid API, no real relay, no GitHub.
// Results + screenshots: C:/Users/dindoo/Projects/pr-tools/out/onboarding/.
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, devices, webkit } from 'file:///C:/Users/dindoo/Projects/pr-tools/node_modules/playwright/index.mjs';
import { codeKey, validateCodeInput, validateCustomCode } from '../../relay/src/codes.js';
import { ADMIN_TOKEN, CODE_FAIL_LIMIT, CODES, createFakeRelay, RELAY_URL, TOO_MANY_MESSAGE } from '../relay-client/fake-relay.mjs';
import { startFakeGitHub } from '../store/fake-github.mjs';
import { startFakeRelay as startTeamRelay } from '../store/fake-relay.mjs';

const PORT = Number(process.env.PR_TEST_PORT) || 8221;
const ORIGIN = `http://localhost:${PORT}`;
const APP = `${ORIGIN}/index.html`;
const OUT = 'C:/Users/dindoo/Projects/pr-tools/out/onboarding';
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SETTINGS_KEY = 'pr.settings.v1';
const HEADED = process.argv.includes('--headed');
const CUSTOM = 'ICU-2TEAM'; // a group code the owner chose (it opens 공용 서재 too, like any active code)
/** Invite-code rules as test vectors, shared with the Worker's tests (relay/test/codes-unit.test.mjs). */
const VECTORS = JSON.parse(readFileSync(`${REPO}/relay/test/code-vectors.json`, 'utf8'));
const KAKAO = (code, name = '홍길동') => `[갈피 초대] ${name}님\nhttps://e2jinsoopark.github.io/#/join/${code}\n코드: ${code}`;

mkdirSync(OUT, { recursive: true });
const results = [];
const problems = [];
const expectedRefusals = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function assert(cond, msg) { if (!cond) throw new Error(msg); }
function assertEqual(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg}: expected ${e}, got ${a}`);
}

async function test(name, fn) {
  const t0 = Date.now();
  const before = problems.length;
  try {
    const evidence = await fn();
    const fresh = problems.slice(before);
    if (fresh.length) throw new Error(`console/page/CSP problems during the test:\n  ${fresh.join('\n  ')}`);
    results.push({ name, result: 'pass', evidence: String(evidence ?? 'ok'), ms: Date.now() - t0 });
    console.log(`PASS  ${name}  (${Date.now() - t0} ms)\n      ${evidence ?? ''}`);
  } catch (err) {
    results.push({ name, result: 'fail', evidence: err?.stack || String(err), ms: Date.now() - t0 });
    console.log(`FAIL  ${name}\n      ${err?.stack || err}`);
  }
}

async function serverUp() {
  try { return (await fetch(`http://127.0.0.1:${PORT}/index.html`)).ok; } catch { return false; }
}

/** index.html with https://relay.test added to connect-src — served only to the test browsers. */
function testCopyOfIndex() {
  const html = readFileSync(`${REPO}/index.html`, 'utf8');
  const out = html.replace(/(connect-src [^;"]*)/, `$1 ${RELAY_URL}`);
  if (out === html) throw new Error('could not find connect-src in index.html');
  return out;
}
const INDEX = testCopyOfIndex();

// ------------------------------------------------------------------ servers

let server = null;
if (!(await serverUp())) {
  server = spawn('python', ['-m', 'http.server', String(PORT)], { cwd: REPO, stdio: 'ignore', windowsHide: true });
  for (let i = 0; i < 80 && !(await serverUp()); i++) await sleep(100);
  if (!(await serverUp())) throw new Error('static server did not start');
}
const github = await startFakeGitHub({ port: 0 });
const TEAM = { owner: 'dindoopark', repo: 'paper-team-library', token: 'ghp_team_test_token' };
github.addToken(TEAM.token, { write: true, repos: [`${TEAM.owner}/${TEAM.repo}`] });
github.createRepo(TEAM.owner, TEAM.repo, { private: true, files: { 'README.md': '# 공용 서재' } });
const team = await startTeamRelay({ github, owner: TEAM.owner, repo: TEAM.repo, token: TEAM.token, lib: 'team', libName: '공용 서재' });
team.addCode(CODES.haiku, '홍길동');
team.addCode(CODES.sonnet, '김간호');
team.addCode(CUSTOM, '응급중환자실팀');

const edge = await chromium.launch({ channel: 'msedge', headless: !HEADED });
let wk = null;
try { wk = await webkit.launch({ headless: !HEADED }); } catch (err) { console.log(`WebKit unavailable: ${err.message.split('\n')[0]}`); }

/** A relay for one test: the codes' own endpoints (fake-relay.mjs) + 공용 서재 for the codes the team fake knows. */
function makeRelay() {
  const fake = createFakeRelay();
  fake.db.set(CUSTOM, { ...fake.db.get(CODES.haiku), code: CUSTOM, name: '응급중환자실팀', todayUsd: 0, todayRequests: 0 });
  const route = async (r) => {
    const req = r.request();
    const url = new URL(req.url());
    if (url.pathname === '/shared' || url.pathname.startsWith('/shared/')) {
      const presented = /^Bearer (.+)$/.exec(req.headers().authorization || '')?.[1] || '';
      if (req.method() !== 'OPTIONS' && !team.has(presented)) {
        // A code made during a test (admin): no team library behind it on this test server → the app shows none.
        return r.fulfill({
          status: 404, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' },
          body: JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: '요청한 주소를 찾을 수 없습니다.' } }),
        });
      }
      try {
        const response = await r.fetch({ url: `${team.url}${url.pathname}${url.search}` });
        return r.fulfill({ response });
      } catch {
        return r.abort('connectionfailed');
      }
    }
    return fake.handle(r);
  };
  return { fake, route, me: () => fake.calls.filter((c) => c.path === '/relay/me').length };
}

/**
 * One browser context = one device. `engine`: 'edge' | 'webkit'; `profile`: a Playwright device name; `standalone`:
 * the page believes it runs as an installed / home-screen app. Records console errors, page errors, CSP violations,
 * escaped requests, and whether the first screen / a welcome screen was ever shown (window.__seen).
 */
async function device({ engine = 'edge', profile = null, viewport = null, seed = { relay: { url: RELAY_URL } }, theme = null,
  relay = makeRelay(), standalone = false, clipboard = false, name = 'device' } = {}) {
  const browser = engine === 'webkit' ? wk : edge;
  if (!browser) throw new Error('WebKit is not installed');
  const base = profile ? { ...devices[profile] } : {};
  delete base.defaultBrowserType;
  const ctx = await browser.newContext({ ...base, ...(viewport ? { viewport } : {}), locale: 'ko-KR', colorScheme: 'light', reducedMotion: 'reduce' });
  if (clipboard) await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: ORIGIN });
  const external = [];
  await ctx.route(new RegExp(String.raw`^https?:\/\/(?!localhost:${PORT}\/|relay\.test\/)`), (route) => {
    const url = route.request().url();
    if (url.startsWith('https://cdn.jsdelivr.net/gh/orioncactus/pretendard')) {
      return route.fulfill({ status: 200, contentType: 'text/css', body: '/* font stub (offline test) */' });
    }
    external.push(url);
    problems.push(`${name}: external request blocked ${url}`);
    return route.abort();
  });
  await ctx.route(new RegExp(String.raw`^http:\/\/localhost:${PORT}\/index\.html(?:\?.*)?$`), (route) => route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: INDEX }));
  await ctx.route(`${RELAY_URL}/**`, relay.route);
  const fullSeed = theme ? { ...seed, ui: { ...(seed?.ui || {}), theme } } : seed;
  await ctx.addInitScript(({ key, seed, standalone }) => {
    try { if (seed && !localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify(seed)); } catch { /* blocked */ }
    window.__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => {
      window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`);
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
      // An installed app: iOS's navigator.standalone and the display-mode media query.
      try { Object.defineProperty(Navigator.prototype, 'standalone', { get: () => true, configurable: true }); } catch { /* ignore */ }
      const mm = window.matchMedia.bind(window);
      window.matchMedia = (q) => (/display-mode:\s*standalone/.test(q)
        ? { matches: true, media: q, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; } }
        : mm(q));
    }
  }, { key: SETTINGS_KEY, seed: fullSeed, standalone });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => problems.push(`${name}: pageerror ${e.message}`));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const text = m.text();
    const where = String(m.location()?.url || '');
    // The browser logs every non-2xx answer; the relay's refusals (401/404/409/429) are what these tests ask for.
    if (/^Failed to load resource/.test(text) && where.startsWith(RELAY_URL)) { expectedRefusals.push(`${name}: ${text} ${where}`); return; }
    problems.push(`${name}: console.error ${text}`);
  });
  return { ctx, page, relay, external, name };
}

/**
 * The app's code rules (js/ai/relay.js, imported in Node) against the Worker's (relay/src/codes.js) on `count` random
 * strings built from the characters that matter (P/R, O/I/L/U, digits, hyphens, dash look-alikes, full-width, Hangul,
 * spaces, tabs, other punctuation): a presented code must be read alike (valid or not, same key, same kind) and a
 * chosen code accepted with the same spelling or refused by both.
 */
async function appEqualsWorker(count) {
  const R = await import(new URL('../../js/ai/relay.js', import.meta.url).href);
  const alphabet = ['A', 'B', 'C', 'E', 'P', 'R', 'I', 'O', 'L', 'U', 'Z', '0', '1', '2', '9', '-', ' ', '\t', '_', '.', '%', '/',
    '–', '—', '－', 'ｐ', 'Ｒ', '１', '　', '가', 'e', 'r', 'o'];
  let seed = 20261019; // mulberry32: the same strings on every run
  const rand = (n) => {
    seed = (seed + 0x6D2B79F5) >>> 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) % n;
  };
  const word = (n) => Array.from({ length: n }, () => alphabet[rand(alphabet.length)]).join('');
  const samples = new Set();
  for (let i = 0; samples.size < count && i < count * 4; i++) samples.add(rand(2) ? word(3 + rand(14)) : `PR${word(8 + rand(4))}`);
  const mismatches = [];
  for (const s of samples) {
    const w = codeKey(s);
    const n = R.normalizeInviteCode(s);
    const a = R.isInviteCode(n) ? { key: R.inviteCodeKey(s), generated: R.isGeneratedCode(n) } : null;
    if (JSON.stringify(w && { key: w.key, generated: w.generated }) !== JSON.stringify(a)) mismatches.push(`presented ${JSON.stringify(s)}: worker ${JSON.stringify(w)} app ${JSON.stringify(a)}`);
    const wc = s.trim() ? validateCustomCode(s) : { code: validateCodeInput({ name: 'x', code: s }, { partial: false, defaults: { allowedModels: ['claude-haiku-5-5'], dailyLimitUsd: 1 } }).value?.code ?? '' };
    const ac = R.checkCustomCode(s);
    if (Boolean(wc.error) !== Boolean(ac.error) || (!wc.error && wc.code !== ac.code)) mismatches.push(`chosen ${JSON.stringify(s)}: worker ${JSON.stringify(wc)} app ${JSON.stringify(ac)}`);
    if (mismatches.length > 20) break;
  }
  return { samples: samples.size, mismatches };
}

const shot = (target, file, opts = {}) => target.screenshot({ path: `${OUT}/${file}.png`, ...opts });
const stored = (page) => page.evaluate((key) => JSON.parse(localStorage.getItem(key) || '{}'), SETTINGS_KEY);
const hashOf = (page) => page.evaluate(() => location.hash);
const seen = (page) => page.evaluate(() => window.__seen);
const overflow = (page) => page.evaluate(() => [document.scrollingElement, ...document.querySelectorAll('.start, .start-card, .library, .lib-header')]
  .filter((e) => e && e.scrollWidth > e.clientWidth + 1).map((e) => `${e.className || e.nodeName} ${e.scrollWidth}>${e.clientWidth}`));
const errorLine = (page) => page.evaluate(() => document.querySelector('.start-error')?.textContent || '');

async function gate(page) {
  await page.waitForSelector('.start:not(.is-quiet) .start-input', { timeout: 30000 });
}
async function sharedReady(page) {
  await page.waitForSelector('.lib-sec[data-lib="shared:team"] .lib-sec-body .lib-nav-heading', { timeout: 30000 });
}
/** Paste text into the first screen's input the way a browser does (a ClipboardEvent with the text). */
function paste(page, text) {
  return page.evaluate((text) => {
    const input = document.querySelector('.start-input');
    input.focus();
    const dt = new DataTransfer();
    dt.setData('text/plain', text);
    const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
    const handled = !input.dispatchEvent(ev);
    if (!handled) input.value += text; // what the browser would do (it never happens for an invite message here)
    return { handled, value: input.value };
  }, text);
}
/** The browser's install prompt, offered (Chromium's beforeinstallprompt) — with prompt()/userChoice like the real one. */
function offerInstallPrompt(page, outcome = 'accepted') {
  return page.evaluate((outcome) => {
    const e = new Event('beforeinstallprompt', { cancelable: true });
    window.__prompted = 0;
    e.prompt = async () => { window.__prompted++; };
    e.userChoice = Promise.resolve({ outcome, platform: 'web' });
    window.dispatchEvent(e);
    return e.defaultPrevented;
  }, outcome);
}
const visibleInstall = (page) => page.$$eval('.install-btn', (els) => els.filter((e) => e.offsetParent !== null)
  .map((e) => (e.classList.contains('lib-install-head') ? 'header' : 'sidebar')));

// ---------------------------------------------------------------------------------------------------------------

try {
  await test('codes: the shared vectors (relay/test/code-vectors.json) hold for the app in Edge and WebKit; app = Worker on 40,000 random strings; the 3-line invite message', async () => {
    const engines = [['edge', null], ...(wk ? [['webkit', 'iPhone 15']] : [])];
    const lines = [];
    for (const [engine, profile] of engines) {
      const d = await device({ engine, profile, name: `codes-${engine}` });
      await d.page.goto(`${APP}#/settings`);
      await d.page.waitForSelector('.settings');
      const r = await d.page.evaluate(async (V) => {
        const R = await import('/js/ai/relay.js');
        const wrong = [];
        for (const v of V.presented.cases) {
          const code = R.normalizeInviteCode(v.in);
          const valid = R.isInviteCode(code);
          const got = valid ? { kind: R.isGeneratedCode(code) ? 'generated' : 'custom', code, key: R.inviteCodeKey(v.in) } : { kind: null };
          const want = v.kind === null ? { kind: null } : { kind: v.kind, code: v.code, key: v.key };
          if (JSON.stringify(got) !== JSON.stringify(want)) wrong.push(`presented ${JSON.stringify(v.in)}: ${JSON.stringify(got)}`);
        }
        for (const v of V.chosen.cases) {
          const c = R.checkCustomCode(v.in);
          const ok = v.blank ? c.code === '' && !c.error
            : v.code !== undefined ? c.code === v.code
              : Boolean(c.error && c.error.includes(V.chosen.refusalPatterns[v.refused]));
          if (!ok) wrong.push(`chosen ${JSON.stringify(v.in)}: ${JSON.stringify(c)}`);
        }
        for (const v of V.pasted.cases) {
          const got = R.extractInviteCode(v.in);
          if (got !== v.code) wrong.push(`pasted ${JSON.stringify(v.in)}: ${JSON.stringify(got)}`);
        }
        return {
          wrong,
          message: R.inviteMessage({ code: 'PR-7K3M-Q9XD', name: '김간호사' }),
          anonymous: R.inviteMessage({ code: 'ICU-2TEAM' }),
        };
      }, VECTORS);
      assertEqual(r.wrong, [], `${engine}: vectors the app disagrees with`);
      assertEqual(r.message, '[갈피 초대] 김간호사님\nhttps://e2jinsoopark.github.io/#/join/PR-7K3M-Q9XD\n코드: PR-7K3M-Q9XD', 'invite message');
      assertEqual(r.anonymous.split('\n'), ['[갈피 초대]', 'https://e2jinsoopark.github.io/#/join/ICU-2TEAM', '코드: ICU-2TEAM'], 'invite message without a name');
      lines.push(`${engine}${profile ? ` (${profile})` : ''}: ${VECTORS.presented.cases.length} presented + ${VECTORS.chosen.cases.length} chosen + ${VECTORS.pasted.cases.length} pasted vectors hold`);
      if (engine === 'edge') lines.push(`message:\n        ${r.message.replace(/\n/g, '\n        ')}`);
      await d.ctx.close();
    }
    // The Worker side of the same table is relay/test/codes-unit.test.mjs; here: both sides on random strings.
    const differential = await appEqualsWorker(40000);
    assertEqual(differential.mismatches, [], 'app ≠ Worker');
    lines.push(`app (js/ai/relay.js in Node) = Worker (relay/src/codes.js) on ${differential.samples} random strings (presented + chosen)`);
    return lines.join('; ');
  });

  await test('first screen: a fresh visitor gets the mark, ONE input, 시작 and one link — nothing else (390, 412, 1440 × light/dark)', async () => {
    const shots = [];
    const sizes = [
      { label: 'iphone-390x844', viewport: { width: 390, height: 844 } },
      { label: 'android-412x915', profile: 'Pixel 7' },
      { label: 'desktop-1440x900', viewport: { width: 1440, height: 900 } },
    ];
    let content = null;
    for (const size of sizes) {
      for (const theme of ['light', 'dark']) {
        const d = await device({ name: `gate-${size.label}-${theme}`, profile: size.profile || null, viewport: size.viewport || null, theme });
        await d.page.goto(`${APP}#/`);
        await gate(d.page);
        await d.page.evaluate(() => document.fonts?.ready);
        const c = await d.page.evaluate(() => {
          const s = document.querySelector('.start');
          return {
            text: s.innerText.split('\n').map((x) => x.trim()).filter(Boolean),
            inputs: s.querySelectorAll('input, textarea, select').length,
            buttons: [...s.querySelectorAll('button')].filter((b) => b.offsetParent).map((b) => b.textContent.trim()),
            paragraphs: [...s.querySelectorAll('p')].filter((p) => p.textContent.trim()).length,
            images: [...s.querySelectorAll('img')].map((i) => i.getAttribute('src').split('/').pop()),
            placeholder: s.querySelector('.start-input').placeholder,
            install: document.querySelectorAll('.install-btn').length,
            theme: document.documentElement.dataset.theme,
            title: document.title,
            focused: document.activeElement?.classList.contains('start-input') || false,
          };
        });
        content ||= c;
        assertEqual(c.text, ['갈피', '초대 코드', '시작', '내 API 키로 쓰기'], `${size.label} ${theme} text`);
        assertEqual([c.inputs, c.buttons, c.paragraphs, c.install], [1, ['시작', '내 API 키로 쓰기'], 0, 0], `${size.label} ${theme} controls`);
        assertEqual(c.theme, theme, 'theme');
        assertEqual(await overflow(d.page), [], `${size.label} horizontal overflow`);
        await shot(d.page, `gate-${size.label}-${theme}`);
        shots.push(`gate-${size.label}-${theme}${c.focused ? ' (focused)' : ''}`);
        await d.ctx.close();
      }
    }
    return `text [${content.text.join(' | ')}], placeholder “${content.placeholder}”, mark ${content.images.join(',')}, no paragraphs, no install button, title “${content.title}”; screenshots: ${shots.join(', ')}`;
  });

  await test('first screen: errors are one short line under the input; text without a code sends nothing', async () => {
    const d = await device({ name: 'gate-errors', viewport: { width: 390, height: 844 } });
    const { page } = d;
    await page.goto(`${APP}#/`);
    await gate(page);
    await page.click('.start-go');
    const empty = await errorLine(page);
    await page.fill('.start-input', '안녕하세요 반가워요');
    assertEqual(await errorLine(page), '', 'typing clears the error');
    await page.press('.start-input', 'Enter');
    const chatter = await errorLine(page);
    const meBefore = d.relay.me();
    assertEqual(meBefore, 0, 'requests for text without a code');
    await page.fill('.start-input', 'pr-zzzz-zzzz');
    await page.click('.start-go');
    await page.waitForFunction(() => document.querySelector('.start-error')?.textContent);
    const unknown = await errorLine(page);
    const box = await page.$eval('.start-error', (e) => ({ h: e.getBoundingClientRect().height, lh: parseFloat(getComputedStyle(e).lineHeight), below: e.getBoundingClientRect().top >= document.querySelector('.start-input').getBoundingClientRect().bottom }));
    const s = await stored(page);
    await shot(page, 'gate-error-390');
    assertEqual([empty, chatter, unknown], ['초대 코드를 넣어 주세요', '코드를 찾을 수 없어요', '코드를 찾을 수 없어요'], 'error lines');
    assert(box.below && box.h <= box.lh * 1.2, `error line box ${JSON.stringify(box)}`);
    assertEqual(d.relay.me(), 1, '/relay/me calls');
    assert(!s.relay?.code && s.provider !== 'relay', `settings changed by a bad code: ${JSON.stringify(s)}`);
    assertEqual(await page.getAttribute('.start-input', 'aria-invalid'), 'true', 'aria-invalid');
    // The relay unreachable: a short line too (not the long settings-oriented message).
    await d.ctx.route(`${RELAY_URL}/relay/me`, (r) => (r.request().method() === 'OPTIONS' ? r.fallback() : r.abort('connectionrefused')));
    await page.fill('.start-input', CODES.haiku);
    await page.click('.start-go');
    await page.waitForFunction(() => document.querySelector('.start-error')?.textContent && !document.querySelector('.start-go').disabled);
    const offline = await errorLine(page);
    assertEqual(offline, '서버에 연결할 수 없어요. 인터넷 연결을 확인해 주세요', 'unreachable relay');
    await d.ctx.close();
    return `empty → “${empty}”; chatter → “${chatter}” (0 requests); PR-ZZZZ-ZZZZ → “${unknown}” (1 request, ${box.h}px tall, under the input); settings untouched; relay unreachable → “${offline}”`;
  });

  await test('Android: paste the whole invite message → 시작 → 공용 서재 at once (no welcome); 홈 화면에 추가 in the header', async () => {
    const d = await device({ name: 'android-join', profile: 'Pixel 7' });
    const { page } = d;
    await page.goto(`${APP}#/`);
    await gate(page);
    const p = await paste(page, KAKAO(CODES.haiku));
    assertEqual(p, { handled: true, value: CODES.haiku }, 'paste → the code only');
    await page.click('.start-go');
    await page.waitForSelector('.library', { timeout: 30000 });
    await sharedReady(page);
    await page.waitForFunction(() => location.hash === '#/s/team');
    const s = await stored(page);
    const sw = await seen(page);
    const toastText = await page.locator('.toast').first().innerText().catch(() => '');
    const install = await visibleInstall(page);
    await page.waitForTimeout(300);
    await shot(page, 'library-after-join-android-412');
    assertEqual([s.provider, s.relay.code, s.relay.name], ['relay', CODES.haiku, '홍길동'], 'stored');
    assertEqual(sw.welcome, false, 'a welcome screen was shown');
    assert(/초대 코드를 등록했어요/.test(toastText), `toast: ${toastText}`);
    assertEqual(install, ['header'], 'visible 홈 화면에 추가 buttons');
    assertEqual(await overflow(page), [], 'horizontal overflow');
    await d.ctx.close();
    return `paste → input “${p.value}”; 시작 → #/s/team (공용 서재) directly, toast “${toastText.trim()}”, no welcome screen; stored relay ${s.relay.code} (${s.relay.name}); 홈 화면에 추가 in the header`;
  });

  await test('Android install: hint without a prompt; the browser prompt when offered (once); gone after install, in the app and after 버튼 숨기기', async () => {
    const seed = { provider: 'relay', relay: { url: RELAY_URL, code: CODES.haiku, name: '홍길동', allowedModels: ['claude-haiku-5-5'] } };
    const d = await device({ name: 'android-install', profile: 'Pixel 7', seed });
    const { page } = d;
    await page.goto(`${APP}#/`);
    await sharedReady(page);
    const manifest = await page.$$eval('link[rel="manifest"]', (els) => els.map((e) => e.href));
    const m = await page.evaluate(async (href) => { const r = await fetch(href); return { status: r.status, json: await r.json() }; }, manifest[0]);
    await page.click('.lib-install-head');
    const hint = (await page.locator('.install-popover').innerText()).replace(/\s+/g, ' ').trim();
    await shot(page, 'install-hint-android-412');
    await page.keyboard.press('Escape');
    const prevented = await offerInstallPrompt(page, 'accepted');
    await page.click('.lib-install-head');
    await page.waitForFunction(() => window.__prompted === 1);
    await page.waitForFunction(() => [...document.querySelectorAll('.install-btn')].every((b) => b.hidden));
    const popoverAfterPrompt = await page.locator('.install-popover').count();
    await page.reload();
    await sharedReady(page);
    const afterReload = await visibleInstall(page);
    assertEqual(manifest, [`${ORIGIN}/manifest.webmanifest`], 'manifest link (Chromium)');
    assertEqual([m.status, m.json.start_url, m.json.display], [200, './', 'standalone'], 'manifest');
    assertEqual(hint, '브라우저 메뉴 ⋮ → 홈 화면에 추가 버튼 숨기기', 'hint popover');
    assertEqual([prevented, popoverAfterPrompt, afterReload], [true, 0, []], 'prompt prevented (no mini-infobar), no hint after it, hidden after install');
    await d.ctx.close();

    // 버튼 숨기기 is remembered; an installed app (display-mode: standalone) never shows the button.
    const h = await device({ name: 'android-hide', profile: 'Pixel 7', seed });
    await h.page.goto(`${APP}#/`);
    await sharedReady(h.page);
    await h.page.click('.lib-install-head');
    await h.page.click('.install-tip-hide');
    const hidden = await visibleInstall(h.page);
    await h.page.reload();
    await sharedReady(h.page);
    const hiddenAfterReload = await visibleInstall(h.page);
    await h.ctx.close();
    const a = await device({ name: 'android-standalone', profile: 'Pixel 7', seed, standalone: true });
    await a.page.goto(`${APP}#/`);
    await sharedReady(a.page);
    await offerInstallPrompt(a.page);
    const inApp = await visibleInstall(a.page);
    await a.ctx.close();
    assertEqual([hidden, hiddenAfterReload, inApp], [[], [], []], 'hidden after 버튼 숨기기 / reload / in the app');
    return `manifest injected (${m.json.start_url}, ${m.json.display}); no prompt → “${hint}”; prompt offered → preventDefault, click → prompt() once → accepted → button gone (also after reload); 버튼 숨기기 remembered; standalone → no button`;
  });

  await test('desktop: no button without an install prompt; with one, a small button in the sidebar footer above 설정', async () => {
    const seed = { provider: 'relay', relay: { url: RELAY_URL, code: CODES.haiku, name: '홍길동', allowedModels: ['claude-haiku-5-5'] } };
    const d = await device({ name: 'desktop-install', viewport: { width: 1440, height: 900 }, seed });
    const { page } = d;
    await page.goto(`${APP}#/`);
    await sharedReady(page);
    const before = await visibleInstall(page);
    await offerInstallPrompt(page, 'dismissed');
    const after = await visibleInstall(page);
    const footer = await page.$$eval('.lib-sidebar-footer .btn', (els) => els.filter((e) => e.offsetParent).map((e) => e.textContent.trim()));
    await page.waitForTimeout(200);
    await shot(page, 'library-desktop-install-1440');
    await page.click('.lib-install-side');
    await page.waitForFunction(() => window.__prompted === 1);
    await page.waitForFunction(() => [...document.querySelectorAll('.install-btn')].every((b) => b.hidden));
    assertEqual([before, after, footer], [[], ['sidebar'], ['홈 화면에 추가', '설정']], 'desktop buttons');
    await d.ctx.close();
    return `no prompt → no button; prompt offered → sidebar footer [${footer.join(' | ')}]; declined → the button leaves (a desktop browser has no menu hint)`;
  });

  await test('join link: registers and lands in the library; the same link again opens straight to it; chosen codes match any spelling', async () => {
    const relay = makeRelay();
    const d = await device({ name: 'join', viewport: { width: 390, height: 844 }, relay });
    const { page } = d;
    await page.goto(`${APP}#/join/${CODES.haiku.toLowerCase()}`);
    await sharedReady(page);
    await page.waitForFunction(() => location.hash === '#/s/team');
    const first = { hash: await hashOf(page), seen: await seen(page), me: relay.me(), stored: (await stored(page)).relay.code };
    await page.goto('about:blank');
    await page.goto(`${APP}#/join/${CODES.haiku}`);
    await sharedReady(page);
    const again = { hash: await hashOf(page), seen: await seen(page), me: relay.me() };
    assertEqual([first.stored, first.seen.welcome, first.me], [CODES.haiku, false, 1], 'first open');
    assertEqual([again.seen.start, again.me, again.hash], [false, 1, '#/s/team'], 'opened again: no first screen, no request, library');
    await d.ctx.close();

    const c = await device({ name: 'join-custom', viewport: { width: 390, height: 844 }, relay });
    await c.page.goto(`${APP}#/join/icu2team`);
    await sharedReady(c.page);
    await c.page.waitForFunction(() => location.hash === '#/s/team');
    const custom = { hash: await hashOf(c.page), code: (await stored(c.page)).relay.code, name: (await stored(c.page)).relay.name };
    const meAfterCustom = relay.me();
    await c.page.goto('about:blank');
    await c.page.goto(`${APP}#/join/ICU-2TEAM`);
    await sharedReady(c.page);
    const customAgain = { seen: await seen(c.page), me: relay.me(), hash: await hashOf(c.page) };
    assertEqual([custom.hash, custom.code, custom.name], ['#/s/team', 'ICU2TEAM', '응급중환자실팀'], 'custom code joined → 공용 서재 (typed spelling kept; the relay matches by key)');
    assertEqual([customAgain.seen.start, customAgain.me, customAgain.hash], [false, meAfterCustom, '#/s/team'], 'ICU-2TEAM = icu2team: silent');
    await c.ctx.close();
    return `#/join/${CODES.haiku.toLowerCase()} → ${first.hash} (1 /relay/me, no welcome); again → ${again.hash} with no first screen and no request; #/join/icu2team → “${custom.name}” (${custom.code}); #/join/ICU-2TEAM afterwards → silent`;
  });

  await test('join link with a wrong code: the first screen with the code and the error line; 내 API 키로 쓰기 / 돌아가기', async () => {
    const d = await device({ name: 'join-bad', viewport: { width: 390, height: 844 } });
    const { page } = d;
    await page.goto(`${APP}#/join/PR-ZZZZ-ZZZZ`);
    await gate(page);
    await page.waitForFunction(() => document.querySelector('.start-error')?.textContent);
    const r = { value: await page.inputValue('.start-input'), error: await errorLine(page), link: await page.innerText('.start-link') };
    await shot(page, 'join-error-390');
    const s = await stored(page);
    await page.click('.start-link');
    await page.waitForSelector('.settings');
    const settingsHash = await hashOf(page);
    await page.locator('.settings-header .btn').first().click();
    await gate(page);
    const back = await hashOf(page);
    assertEqual([r.value, r.error, r.link], ['PR-ZZZZ-ZZZZ', '코드를 찾을 수 없어요', '내 API 키로 쓰기'], 'join error');
    assert(!s.relay?.code, `a bad code was saved: ${JSON.stringify(s.relay)}`);
    assertEqual([settingsHash, back], ['#/settings/ai', '#/'], 'link → 설정 → 뒤로 → first screen');
    await d.ctx.close();

    const k = await device({ name: 'join-bad-own-key', viewport: { width: 390, height: 844 }, seed: { relay: { url: RELAY_URL }, claude: { apiKey: 'sk-ant-own' }, provider: 'claude' } });
    await k.page.goto(`${APP}#/join/hello-world`);
    await gate(k.page);
    await k.page.waitForFunction(() => document.querySelector('.start-error')?.textContent);
    const ownLink = await k.page.innerText('.start-link');
    await k.page.click('.start-link');
    await k.page.waitForSelector('.library');
    const ownHash = await hashOf(k.page);
    const ks = await stored(k.page);
    assertEqual([ownLink, ownHash, ks.provider, ks.claude.apiKey], ['돌아가기', '#/', 'claude', 'sk-ant-own'], 'someone with an own key');
    await k.ctx.close();
    return `#/join/PR-ZZZZ-ZZZZ → input “${r.value}”, “${r.error}”, settings untouched; 내 API 키로 쓰기 → ${settingsHash} → 뒤로 → first screen; with an own key: “${ownLink}” → ${ownHash}, key kept`;
  });

  await test('too many wrong codes: the relay\'s 429 message in the error line; a generated code still works meanwhile', async () => {
    const relay = makeRelay();
    const d = await device({ name: 'limiter', viewport: { width: 390, height: 844 }, relay });
    const { page } = d;
    await page.goto(`${APP}#/`);
    await gate(page);
    for (let i = 0; i < CODE_FAIL_LIMIT - 1; i++) relay.fake.failures.push({ at: Date.now(), guess: `GUESS${i}` });
    await page.fill('.start-input', 'WRONG-CODE-1');
    await page.click('.start-go');
    await page.waitForFunction(() => document.querySelector('.start-error')?.textContent);
    const twentieth = await errorLine(page);
    await page.fill('.start-input', 'WRONG-CODE-2');
    await page.click('.start-go');
    await page.waitForFunction((m) => document.querySelector('.start-error')?.textContent === m, TOO_MANY_MESSAGE);
    const limited = await errorLine(page);
    await shot(page, 'gate-too-many-390');
    await page.fill('.start-input', 'icu-2team');
    await page.click('.start-go');
    await page.waitForFunction(() => document.querySelector('.start-error')?.textContent && !document.querySelector('.start-go').disabled);
    const customDuring = await errorLine(page);
    await page.fill('.start-input', CODES.haiku);
    await page.click('.start-go');
    await page.waitForSelector('.library', { timeout: 30000 });
    assertEqual([twentieth, limited, customDuring], ['코드를 찾을 수 없어요', TOO_MANY_MESSAGE, TOO_MANY_MESSAGE], 'error lines');
    await d.ctx.close();
    return `failure #${CODE_FAIL_LIMIT} → “${twentieth}”; #${CODE_FAIL_LIMIT + 1} → “${limited}”; a chosen code is refused alike while it lasts; ${CODES.haiku} (generated) → library`;
  });

  if (wk) {
    await test('iPhone (WebKit): no manifest, apple meta; join; 홈 화면에 추가 puts #/join/<CODE> in the address + “공유 → 홈 화면에 추가”; the home-screen app registers once, silently', async () => {
      const relay = makeRelay();
      const d = await device({ engine: 'webkit', profile: 'iPhone 15', name: 'ios-safari', relay });
      const { page } = d;
      await page.goto(`${APP}#/`);
      await gate(page);
      const head = await page.evaluate(() => ({
        manifest: document.querySelectorAll('link[rel="manifest"]').length,
        capable: document.querySelector('meta[name="apple-mobile-web-app-capable"]')?.content,
        title: document.querySelector('meta[name="apple-mobile-web-app-title"]')?.content,
        icon: document.querySelector('link[rel="apple-touch-icon"]')?.getAttribute('href'),
      }));
      await shot(page, 'ios-gate-iphone15');
      await page.fill('.start-input', KAKAO(CODES.haiku)); // WebKit: typed/filled text (line breaks dropped) is read the same way
      await page.click('.start-go');
      await sharedReady(page);
      await page.waitForFunction(() => location.hash === '#/s/team');
      const install = await visibleInstall(page);
      await page.waitForTimeout(300);
      await shot(page, 'ios-library-iphone15');
      await page.click('.lib-install-head');
      await page.waitForSelector('.install-popover');
      const tip = (await page.locator('.install-popover .install-tip-text').innerText()).replace(/\s+/g, ' ').trim();
      const savedAddress = await page.evaluate(() => location.href);
      await shot(page, 'ios-popover-iphone15');
      assertEqual(head, { manifest: 0, capable: 'yes', title: '갈피', icon: 'assets/brand/icon-180.png' }, 'iOS head');
      assertEqual(install, ['header'], 'install button');
      assertEqual(new URL(savedAddress).hash, `#/join/${CODES.haiku}`, 'address after 홈 화면에 추가');
      assertEqual(tip, '공유 → 홈 화면에 추가', 'popover');
      await d.ctx.close();

      // The home-screen app: its own (empty) storage, started at the address it was saved from.
      const meBefore = relay.me();
      const app = await device({ engine: 'webkit', profile: 'iPhone 15', name: 'ios-home-screen', relay, standalone: true });
      await app.page.goto(savedAddress);
      await sharedReady(app.page);
      await app.page.waitForFunction(() => location.hash === '#/s/team');
      const firstLaunch = { seen: await seen(app.page), me: relay.me() - meBefore, code: (await stored(app.page)).relay?.code, install: await visibleInstall(app.page) };
      await shot(app.page, 'ios-home-screen-first-launch');
      await app.page.goto('about:blank');
      await app.page.goto(savedAddress);
      await sharedReady(app.page);
      const secondLaunch = { seen: await seen(app.page), me: relay.me() - meBefore, hash: await hashOf(app.page) };
      assertEqual([firstLaunch.seen.startForm, firstLaunch.seen.welcome, firstLaunch.me, firstLaunch.code, firstLaunch.install],
        [false, false, 1, CODES.haiku, []], 'first launch: quiet registration, no form, no welcome, no install button');
      assertEqual([secondLaunch.seen.start, secondLaunch.me, secondLaunch.hash], [false, 1, '#/s/team'], 'next launch: nothing in between');
      await app.ctx.close();
      return `no <link rel=manifest>, apple-mobile-web-app-capable=yes, title 갈피; join → #/s/team; 홈 화면에 추가 → address ${new URL(savedAddress).hash}, popover “${tip}”; home-screen app (empty storage, standalone) → quiet register (1 request) → 공용 서재; next launch → straight in, 0 requests`;
    });
  } else {
    results.push({ name: 'iPhone (WebKit)', result: 'skipped', evidence: 'WebKit is not installed' });
  }

  await test('admin: 코드 직접 정하기 — checked as typed, sent as `code`, 409 when taken; invite message = title, link, 코드:', async () => {
    const relay = makeRelay();
    const d = await device({ name: 'admin', viewport: { width: 1280, height: 1000 }, relay, clipboard: true,
      seed: { relay: { url: RELAY_URL, adminToken: ADMIN_TOKEN } } });
    const { page } = d;
    await page.goto(`${APP}#/settings/invites`);
    await page.locator('#set-invites summary', { hasText: '관리 화면 열기' }).click();
    await page.waitForSelector('#set-invites .relay-code');
    const field = page.locator('#set-invites input[aria-label="코드 직접 정하기"]');
    const label = (await page.locator('#set-invites .relay-custom .field-label').innerText()).trim();
    const note = (await page.locator('#relay-custom-hint').innerText()).trim();
    const posts = () => relay.fake.calls.filter((c) => c.method === 'POST' && c.path === '/relay/admin/codes');
    const tryCustom = async (value) => {
      await field.fill(value);
      await page.locator('#set-invites .btn', { hasText: '코드 만들기' }).click();
      await sleep(100);
      return (await page.locator('#set-invites .relay-custom .field-error').innerText()).trim();
    };
    await page.fill('#set-invites input[aria-label="이름"]', '응급중환자실팀');
    const refusals = [await tryCustom('PR-ABCD-EFGH'), await tryCustom('admins'), await tryCustom('123456'), await tryCustom('icu')];
    await page.setViewportSize({ width: 1280, height: 1400 });
    await shot(page.locator('#set-invites .subsection').first(), 'admin-custom-code-error');
    assertEqual(posts().length, 0, 'POSTs for refused codes');
    await field.fill('eicu 2team');
    await field.blur();
    const shown = await field.inputValue();
    await shot(page.locator('#set-invites .subsection').first(), 'admin-custom-code-field');
    await page.locator('#set-invites .btn', { hasText: '코드 만들기' }).click();
    await page.waitForSelector('#set-invites .relay-created');
    const created = await page.locator('#set-invites .relay-created code').innerText();
    const body = posts().at(-1).body;
    await page.locator('#set-invites .relay-created .btn', { hasText: '초대 메시지 복사' }).click();
    await page.waitForSelector('.toast >> text=초대 메시지를 복사했습니다');
    const message = (await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, '\n'); // the Windows clipboard says CRLF
    // taken (another spelling of the same key) → the Worker's 409 message
    await page.fill('#set-invites input[aria-label="이름"]', '중복');
    await field.fill('eicu2team');
    await page.locator('#set-invites .btn', { hasText: '코드 만들기' }).click();
    await page.waitForSelector('#set-invites .subsection .test-result.is-error');
    const taken = (await page.locator('#set-invites .subsection .test-result.is-error').first().innerText()).trim();
    // blank → a random code, no `code` in the body
    await page.fill('#set-invites input[aria-label="이름"]', '박간호');
    await field.fill('');
    await page.locator('#set-invites .btn', { hasText: '코드 만들기' }).click();
    await page.waitForFunction(() => /박간호님/.test(document.querySelector('#set-invites .relay-created')?.textContent || ''));
    const blankBody = posts().at(-1).body;
    const listed = await page.$$eval('#set-invites .relay-code-value', (els) => els.map((e) => e.textContent));
    assertEqual([label, note], ['코드 직접 정하기 (선택)', '여러 명이 같은 코드를 쓰면 메모와 사용 한도도 함께 씁니다.'], 'field label and note');
    assert(refusals.every(Boolean), `refusals: ${JSON.stringify(refusals)}`);
    assertEqual([shown, created, body.code, body.name], ['EICU-2TEAM', 'EICU-2TEAM', 'EICU-2TEAM', '응급중환자실팀'], 'created');
    assertEqual(message, '[갈피 초대] 응급중환자실팀님\nhttps://e2jinsoopark.github.io/#/join/EICU-2TEAM\n코드: EICU-2TEAM', 'invite message');
    assert(taken.startsWith('이미 있는 코드입니다'), `409: ${taken}`);
    assert(!('code' in blankBody) && listed.includes('EICU-2TEAM'), `blank body ${JSON.stringify(blankBody)}; listed ${listed}`);
    await d.ctx.close();

    // The copied message pasted on a fresh phone: in.
    const p = await device({ name: 'admin-invitee', profile: 'Pixel 7', relay });
    await p.page.goto(`${APP}#/`);
    await gate(p.page);
    await paste(p.page, message);
    const pastedValue = await p.page.inputValue('.start-input');
    await p.page.click('.start-go');
    await p.page.waitForSelector('.library', { timeout: 30000 });
    const ps = await stored(p.page);
    assertEqual([pastedValue, ps.relay.code, ps.relay.name], ['EICU-2TEAM', 'EICU-2TEAM', '응급중환자실팀'], 'pasted custom invite');
    await p.ctx.close();
    return `“${label}” + “${note}”; refused before sending: ${refusals.map((x) => `“${x.slice(0, 22)}…”`).join(', ')}; “eicu 2team” → ${shown} → POST code ${body.code} → created; message:\n        ${message.replace(/\n/g, '\n        ')}\n      eicu2team again → “${taken}”; blank → random (no code sent); message pasted on a phone → in`;
  });

  await test('no console errors, page errors, CSP violations or escaped requests', async () => {
    assert(!problems.length, problems.join('\n'));
    return `0 problems; relay refusals the browser logged (asked for by the tests): ${expectedRefusals.length}`;
  });
} finally {
  writeFileSync(`${OUT}/results.json`, JSON.stringify(results, null, 2));
  await edge.close();
  await wk?.close();
  await team.close();
  await github.close();
  server?.kill();
  const failed = results.filter((r) => r.result === 'fail');
  console.log(`\nonboarding: ${results.filter((r) => r.result === 'pass').length}/${results.length} passed${failed.length ? ` — FAILED: ${failed.map((f) => f.name).join(' | ')}` : ''}`);
  process.exitCode = failed.length ? 1 : 0;
}
