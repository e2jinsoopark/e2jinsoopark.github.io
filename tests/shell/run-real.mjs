// Integration smoke: the shell with the REAL js/pdf, js/ai (mock provider) and js/features modules.
// Only js/store/* is stubbed (tests/shell/harness-real.html). Fixture PDFs are served by route interception
// from C:/Users/dindoo/Projects/pr-fixtures (never copied into the repo). Paid/remote API hosts are blocked.
//   node tests/shell/run-real.mjs [fixture=lu2025]
import { readFileSync, writeFileSync } from 'node:fs';
import { chromium } from 'file:///C:/Users/dindoo/Projects/pr-tools/node_modules/playwright/index.mjs';

const BASE = 'http://127.0.0.1:8104';
const OUT = 'C:/Users/dindoo/Projects/pr-tools/out/shell';
const FIXTURES = 'C:/Users/dindoo/Projects/pr-fixtures';
const fixture = process.argv[2] || 'lu2025';
const log = [];
const errors = [];

const browser = await chromium.launch({ channel: 'msedge' });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'ko-KR' });
await ctx.route(/api\.anthropic\.com|generativelanguage\.googleapis\.com|api\.github\.com|api\.semanticscholar\.org/, (r) => { errors.push(`blocked ${r.request().url()}`); return r.abort(); });
await ctx.route('**/__fixture__/*.pdf', (r) => {
  const name = decodeURIComponent(new URL(r.request().url()).pathname.split('/').pop());
  return r.fulfill({ status: 200, contentType: 'application/pdf', body: readFileSync(`${FIXTURES}/${name}`) });
});
const page = await ctx.newPage();
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`${m.type()}: ${m.text().slice(0, 300)}`); });

try {
  await page.goto(`${BASE}/tests/shell/harness-real.html?mock=1&reset=1&fixture=${fixture}#/paper/pap_bundle`);
  await page.waitForFunction(() => document.querySelector('.tp-s[data-sid], .tp-empty, .message-screen'), null, { timeout: 60000 });
  await page.waitForTimeout(2500);
  const spans = await page.locator('.tp-s').count();
  log.push(`pane sentences: ${spans}; banner: ${await page.locator('.app-banner').count()}; message: ${await page.locator('.message-title').allInnerTexts()}`);
  log.push(`tabs: ${(await page.locator('.tab').allInnerTexts()).join('|')}; toolbar features: ${(await page.locator('.tb-feature').allInnerTexts()).join('|')}`);
  await page.screenshot({ path: `${OUT}/real-${fixture}-1-open.png` });
  if (spans) {
    const sid = await page.locator('.tp-s.tp-kind-body').nth(3).getAttribute('data-sid');
    await page.hover(`.tp-s[data-sid="${sid}"]`);
    await page.waitForTimeout(400);
    log.push(`hovered pane ${sid}`);
    await page.screenshot({ path: `${OUT}/real-${fixture}-2-hover-pane.png` });
    await page.click('.tb-tr-main');
    await page.waitForTimeout(4000);
    log.push(`after translate 4s: status "${await page.locator('.tp-header-status').innerText()}"`);
    await page.screenshot({ path: `${OUT}/real-${fixture}-3-translate.png` });
    const vbox = await page.locator('.viewer-host').boundingBox();
    await page.mouse.move(vbox.x + vbox.width * 0.45, vbox.y + vbox.height * 0.55);
    await page.waitForTimeout(500);
    log.push(`pane hover after viewer hover: ${await page.evaluate(() => [...document.querySelectorAll('.tp-s.is-hover')].map((s) => s.dataset.sid).join(','))}`);
    await page.screenshot({ path: `${OUT}/real-${fixture}-4-hover-viewer.png` });
    await page.locator('.segmented .btn', { hasText: '번역 겹쳐보기' }).click();
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${OUT}/real-${fixture}-5-overlay.png` });
    await page.locator('.segmented .btn', { hasText: '나란히' }).click();
    await page.locator('.tab', { hasText: '요약' }).click();
    await page.waitForTimeout(1500);
    log.push(`summary tab text: ${(await page.locator('.tabpanel:not([hidden])').innerText()).slice(0, 120).replace(/\s+/g, ' ')}`);
    await page.screenshot({ path: `${OUT}/real-${fixture}-6-summary.png` });
  } else {
    log.push(`translate button disabled: ${await page.locator('.tb-tr-main').isDisabled()}; pane: ${(await page.locator('.tp-root').innerText()).slice(0, 120)}`);
  }
  // Regression (fatal-ai-error-marks-sentences-failed): a bad key stops the run with ONE error toast that links to
  // 설정; no sentence gets a 다시 시도 pill and no "N개 문장을 번역하지 못했습니다" toast follows.
  const p2 = await ctx.newPage();
  await p2.goto(`${BASE}/tests/shell/harness-real.html?mock=1&reset=1&fixture=${fixture}#/paper/pap_bundle`);
  await p2.waitForFunction(() => document.querySelector('.tp-s[data-sid]'), null, { timeout: 60000 });
  await p2.evaluate(async () => { (await import('/js/ai/mock.js')).mockControl.failNext = [{ code: 'auth' }]; });
  await p2.click('.tb-tr-main');
  await p2.waitForSelector('.toast', { timeout: 10000 });
  await p2.waitForTimeout(1500);
  const fatal = await p2.evaluate(() => ({
    toasts: [...document.querySelectorAll('.toast')].map((t) => t.textContent.replace(/\s+/g, ' ').trim()),
    retryPills: document.querySelectorAll('.tp-retry').length,
    failed: document.querySelectorAll('.tp-s.is-failed').length,
  }));
  await p2.screenshot({ path: `${OUT}/real-${fixture}-7-bad-key.png` });
  await p2.close();
  log.push(`bad key: ${JSON.stringify(fatal)}`);
  const ok = fatal.retryPills === 0 && fatal.failed === 0 && fatal.toasts.length === 1
    && /API 키/.test(fatal.toasts[0]) && /설정 열기/.test(fatal.toasts[0]) && !fatal.toasts.some((t) => /번역하지 못했습니다/.test(t));
  if (!ok) {
    errors.push(`FAIL bad-key run: ${JSON.stringify(fatal)}`);
    process.exitCode = 1;
  }
} catch (err) {
  errors.push(`test error: ${err.message}`);
  process.exitCode = 1;
  await page.screenshot({ path: `${OUT}/real-${fixture}-error.png` }).catch(() => {});
} finally {
  await browser.close();
  writeFileSync(`${OUT}/real-${fixture}.json`, JSON.stringify({ log, errors }, null, 2));
  console.log(log.join('\n'));
  console.log(`--- ${errors.length} console warnings/errors ---\n${errors.slice(0, 25).join('\n')}`);
}
