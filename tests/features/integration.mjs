// Integration pass: the same harness, but with the REAL js/ui/components.js, the REAL
// js/ai/tasks.js (mock provider via ?mock=1 — no network) and css/app.css. Viewer, pane and
// library stay stubbed (the viewer/store modules are not required for these features).
//   node tests/features/integration.mjs
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const { chromium } = await import(pathToFileURL('C:/Users/dindoo/Projects/pr-tools/node_modules/playwright/index.mjs').href);

const PORT = 8105;
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = 'C:/Users/dindoo/Projects/pr-tools/out/features';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
mkdirSync(OUT, { recursive: true });

for (const f of ['js/ui/components.js', 'js/ai/tasks.js', 'css/app.css']) {
  if (!existsSync(resolve(ROOT, f))) { console.log(`SKIP integration: ${f} not written yet`); process.exit(0); }
}

async function serverUp() { try { return (await fetch(`${BASE}/docs/SPEC.md`)).ok; } catch { return false; } }
let server = null;
if (!(await serverUp())) {
  server = spawn('python', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], { cwd: ROOT, stdio: 'ignore' });
  for (let i = 0; i < 50 && !(await serverUp()); i++) await new Promise((r) => setTimeout(r, 100));
}

const results = [];
const assert = (c, m) => { if (!c) throw new Error(`assert: ${m}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function test(name, fn) {
  try {
    const ev = await fn();
    results.push({ name, ok: true });
    console.log(`PASS ${name} — ${ev ?? ''}`);
  } catch (err) {
    results.push({ name, ok: false });
    console.log(`FAIL ${name}\n  ${err.stack || err}`);
  }
}

const browser = await chromium.launch({ channel: 'msedge' });
async function open(extra = '') {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|ERR_FAILED/.test(m.text())) errors.push(m.text()); });
  await page.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.abort());
  await page.goto(`${BASE}/tests/features/harness.html?mock=1&reset=1&real=components,tasks&css=app${extra}`);
  await page.waitForSelector('body[data-ready="1"]', { timeout: 10000 });
  return { page, ctx, errors };
}
const shot = (page, name) => page.screenshot({ path: `${OUT}/${name}.png` });
const selectText = (page, needle, len) => page.evaluate(({ needle, len }) => {
  const s = __h.doc.sentences.find((x) => x.text.includes(needle));
  const start = s.start + s.text.indexOf(needle);
  __h.viewer.selectRange(start, start + (len ?? needle.length));
  return { start, end: start + (len ?? needle.length) };
}, { needle, len });

await test('integration: selection menu in real popover, highlight, edit menu, real toast undo', async () => {
  const { page, ctx, errors } = await open();
  const sel = await selectText(page, 'We evaluated whether a nurse-led early mobilization protocol');
  await page.waitForSelector('.popover .pf-selmenu');
  const oneRow = await page.$eval('.popover .pf-selmenu', (m) => m.getBoundingClientRect().height < 48);
  await shot(page, 'i01-selection-menu-real');
  await page.click('.pf-selmenu [data-color="green"]');
  await page.waitForFunction(() => __h.session.annotations.items.length === 1);
  const pt = await page.evaluate(({ start, end }) => {
    const r = __h.viewer.rangeRects(start, end)[0];
    const b = r.pageEl.getBoundingClientRect();
    return { x: b.left + r.x + 20, y: b.top + r.y + r.h / 2 };
  }, sel);
  await page.mouse.click(pt.x, pt.y);
  await page.waitForSelector('.popover .pf-selmenu--mark');
  await page.click('.pf-selmenu--mark [data-action="delete"]');
  await page.waitForSelector('.toast .toast-action');
  await sleep(250);
  await shot(page, 'i02-undo-toast-real');
  await page.click('.toast .toast-action');
  await page.waitForFunction(() => __h.session.annotations.items.length === 1);
  assert(oneRow, 'selection toolbar fits on one row inside the shell popover');
  assert(!errors.length, errors.join('\n'));
  await ctx.close();
  return 'real popover hosts the one-row menu; delete → real toast 실행 취소 → restored';
});

await test('integration: quick translate + chat streaming through real tasks (mock provider)', async () => {
  const { page, ctx, errors } = await open();
  await selectText(page, 'Nurses are well placed to lead mobility', 100);
  await page.waitForSelector('.pf-selmenu');
  await page.click('.pf-selmenu [data-action="translate"]');
  await page.waitForFunction(() => {
    const b = document.querySelector('.pf-qt__body');
    return b && !b.querySelector('.pf-loading') && b.textContent.trim().length > 0;
  }, null, { timeout: 8000 });
  const qt = await page.textContent('.pf-qt__body');
  await shot(page, 'i03-quick-translate-real');
  await page.keyboard.press('Escape');
  await page.click('#tabs [data-tab="chat"]');
  await page.fill('.pf-chat__input', '이 연구의 주요 결과는?');
  await page.press('.pf-chat__input', 'Enter');
  const samples = await page.evaluate(async () => {
    const out = [];
    const t0 = performance.now();
    while (performance.now() - t0 < 15000) {
      const b = [...document.querySelectorAll('.pf-msg--assistant .pf-msg__body')].at(-1);
      out.push(b ? b.textContent.length : -1);
      if (!document.querySelector('.pf-msg.is-streaming') && out.length > 3) break;
      await new Promise((r) => setTimeout(r, 40));
    }
    return out;
  });
  await page.waitForFunction(() => __h.library.data['paper1/ai']?.chat?.length === 2, null, { timeout: 5000 });
  const stored = await page.evaluate(() => __h.library.data['paper1/ai'].chat[1]);
  await shot(page, 'i04-chat-real');
  const distinct = new Set(samples.filter((n) => n > 0)).size;
  assert(qt.trim().length > 0, 'translation shown');
  assert(distinct >= 3, `incremental: ${samples.join(',')}`);
  assert(stored.content.length > 0 && stored.model === 'mock', JSON.stringify(stored).slice(0, 200));
  assert(!errors.length, errors.join('\n'));
  await ctx.close();
  return `translation "${qt.trim().slice(0, 30)}…"; chat streamed ${distinct} distinct lengths; stored model=${stored.model}`;
});

await test('integration: summary + key-sentence underlines through real tasks', async () => {
  const { page, ctx, errors } = await open('&tab=summary');
  await page.click('[data-action="generate"]'); // summaries are made on request only (no paid call on first view)
  await page.waitForFunction(() => document.querySelector('.pf-summary__body')?.textContent.trim().length > 20, null, { timeout: 10000 });
  const heads = await page.$$eval('.pf-summary__body h2, .pf-summary__body h3', (h) => h.map((x) => x.textContent));
  const chips = await page.$$eval('.pf-summary__body .pf-sid', (a) => a.length);
  await shot(page, 'i05-summary-real');
  await page.click('[data-id="auto-highlight"]');
  await page.waitForFunction(() => __h.library.data['paper1/ai']?.keyPoints, null, { timeout: 10000 });
  const marks = await page.evaluate(() => __h.viewer.calls.filter((c) => c.fn === 'setMarks' && c.args[0] === 'auto').at(-1)?.args[1] ?? []);
  await sleep(200);
  await shot(page, 'i06-autohighlight-real');
  assert(!errors.length, errors.join('\n'));
  await ctx.close();
  return `summary headings [${heads.join(' / ')}], ${chips} sid chips; keyPoints → ${marks.length} underline marks`;
});

await test('integration: explanation card + citation card in real popover', async () => {
  const { page, ctx, errors } = await open();
  await selectText(page, 'Delirium is a frequent and costly complication', 100);
  await page.waitForSelector('.pf-selmenu');
  await page.click('.pf-selmenu [data-action="explain"]');
  await page.waitForFunction(() => __h.library.data['paper1/ai']?.explanations?.length === 1, null, { timeout: 10000 });
  await shot(page, 'i07-explain-real');
  await page.keyboard.press('Escape');
  await page.hover('.sv-link[data-token="[2]"]');
  await page.waitForSelector('.popover .pf-cite--ref');
  await shot(page, 'i08-citation-real');
  assert(!errors.length, errors.join('\n'));
  await ctx.close();
  return 'explanation streamed + saved; reference card inside shell popover';
});

await browser.close();
if (server) server.kill();
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} integration checks passed`);
process.exitCode = failed ? 1 : 0;
