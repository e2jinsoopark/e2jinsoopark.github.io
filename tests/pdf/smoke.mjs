// Quick visual smoke test: open one fixture in the harness, outline sentences on pages 1–2, screenshot.
//   node tests/pdf/smoke.mjs [fixture] (server must be running on :8101)
import { chromium } from 'file:///C:/Users/dindoo/Projects/pr-tools/node_modules/playwright/index.mjs';

const name = process.argv[2] || 'lu2025';
const OUT = 'C:/Users/dindoo/Projects/pr-tools/out/pdf';
const browser = await chromium.launch({ channel: 'msedge' });
const page = await browser.newPage({ viewport: { width: 1100, height: 1400 } });
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
await page.goto('http://127.0.0.1:8101/tests/pdf/harness.html?mock=1');
await page.setInputFiles('#file', `C:/Users/dindoo/Projects/pr-fixtures/${name}.pdf`);
await page.waitForFunction(() => window.__state === 'ready' || window.__state === 'error', null, { timeout: 30000 });
const state = await page.evaluate(() => ({ state: window.__state, error: window.__error, timing: window.__timing }));
console.log(state);
await page.evaluate(() => window.__waitRendered([1, 2]));
await page.evaluate(() => window.__outlineSentences([1, 2]));
await page.screenshot({ path: `${OUT}/smoke-${name}.png`, fullPage: false });
console.log(logs.slice(0, 20).join('\n'));
await browser.close();
