// Run every AI-module suite: node tests/ai/run-all.mjs
// Each suite starts (or reuses) the static server on port 8103 (openai: its own on 8171) and writes
// <suite>.results.json + <suite>.log to C:/Users/dindoo/Projects/pr-tools/out/ai/. No paid API is called:
// Claude/GPT/Gemini are Playwright-routed, everything else uses the offline mock provider (?mock=1).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const suites = ['unit', 'claude', 'openai', 'gemini', 'translator', 'realpdf'];
const summary = [];
for (const s of suites) {
  const res = spawnSync(process.execPath, [path.join(here, `${s}.test.mjs`)], { stdio: 'inherit' });
  summary.push({ suite: s, ok: res.status === 0 });
}
const out = 'C:/Users/dindoo/Projects/pr-tools/out/ai';
const all = suites.flatMap((s) => {
  try { return JSON.parse(fs.readFileSync(path.join(out, `${s}.results.json`), 'utf8')).map((r) => ({ suite: s, ...r })); } catch { return []; }
});
fs.writeFileSync(path.join(out, 'all.results.json'), JSON.stringify(all, null, 2));
const failed = all.filter((r) => r.result !== 'pass');
console.log(`\nAI module: ${all.length - failed.length}/${all.length} tests passed (${summary.map((s) => `${s.suite}:${s.ok ? 'ok' : 'FAIL'}`).join(' ')})`);
process.exitCode = failed.length || summary.some((s) => !s.ok) ? 1 : 0;
