// Relay test runner:  node relay/test/run.mjs [unit|http|codes|sdk|shared|shared-client|code-libs|code-delete ...]
// 1. unit tests (pure modules, no servers)
// 2. a throwaway local D1 shaped like the deployed one after an update (the schema from before code deletion, then
//    today's schema.sql twice: lib.mjs migratedDatabase) + fake Anthropic upstream (8788) + fake GitHub (8792, tests/store/fake-github.mjs) +
//    `wrangler dev` (8787) with TEST_MODE=1
// 3. HTTP tests (node fetch; `codes` = custom invite codes and the failed-attempt limiter) and SDK tests (real @anthropic-ai/sdk in Edge via Playwright, page on localhost:8789)
// 4. shared library (공용 서재): HTTP tests of the GitHub proxy, then the app's GitHubClient through it (Node and Edge)
// 5. code-libs: each invite code's own library (codes/<id>/ of the team repo, /shared/mine/gh): isolation, activity per
//    library, the per-code size cap, code deletion with library=delete|move, the split by uploader, the library_id migration
// 6. code-delete: deleting an invite code (its people/<id>/ files in every shared library, D1 rows, usage history),
//    person salts and the schema migration
// Results: C:/Users/dindoo/Projects/pr-tools/out/relay/results.json (+ run.log, wrangler.log; RELAY_OUT_DIR moves them).
// No real API calls.
import fs from 'node:fs';
import path from 'node:path';
import { GITHUB_PORT, migratedDatabase, OUT_DIR, runTests, startWrangler, STATE_DIR, TEAM_TOKEN, UPSTREAM_PORT } from './lib.mjs';
import { startFakeUpstream } from './fake-upstream.mjs';
import { startFakeGitHub } from '../../tests/store/fake-github.mjs';

const only = new Set(process.argv.slice(2));
const want = (suite) => !only.size || only.has(suite);

fs.mkdirSync(OUT_DIR, { recursive: true });
const logPath = path.join(OUT_DIR, 'run.log');
fs.writeFileSync(logPath, '');
const logLine = (line) => {
  console.log(line);
  fs.appendFileSync(logPath, `${line}\n`);
};

const results = [];
if (want('unit')) {
  logLine('unit');
  const { tests } = await import('./unit.test.mjs');
  const { tests: sharedTests } = await import('./shared-unit.test.mjs');
  const { tests: codeTests } = await import('./codes-unit.test.mjs');
  const { tests: codeLibTests } = await import('./code-libs-unit.test.mjs');
  results.push(...await runTests('unit', [...tests, ...sharedTests, ...codeTests, ...codeLibTests], {}, logLine));
}

// code-libs runs before code-delete: it checks that the legacy codes have no library id until they first need one.
const SERVER_SUITES = ['http', 'codes', 'sdk', 'shared', 'shared-client', 'code-libs', 'code-delete'];
if (SERVER_SUITES.some(want)) {
  const stateDir = STATE_DIR;
  let stopWrangler = () => {};
  let fake = null;
  let gh = null;
  try {
    const schemaSteps = migratedDatabase(stateDir);
    logLine(`database: ${schemaSteps.join(' → ')} (each applied without error)`);
    fake = await startFakeUpstream({ port: UPSTREAM_PORT });
    gh = await startFakeGitHub({ port: GITHUB_PORT });
    gh.addToken(TEAM_TOKEN, { write: true });
    stopWrangler = await startWrangler({ stateDir, logFile: path.join(OUT_DIR, 'wrangler.log') });
    for (const suite of SERVER_SUITES) {
      if (!want(suite)) continue;
      logLine(suite);
      const { tests, setup, teardown } = await import(`./${suite}.test.mjs`);
      const ctx = { fake, gh, schemaSteps, ...(setup ? await setup({ gh }) : {}) };
      try {
        results.push(...await runTests(suite, tests, ctx, logLine));
      } finally {
        await teardown?.(ctx);
      }
    }
  } catch (err) {
    logLine(`SETUP FAILED: ${err?.stack || err}`);
    results.push({ suite: 'setup', name: 'test environment', result: 'fail', evidence: String(err?.stack || err) });
  } finally {
    stopWrangler();
    await fake?.close();
    await gh?.close();
  }
}

fs.writeFileSync(path.join(OUT_DIR, 'results.json'), JSON.stringify(results, null, 2));
const failed = results.filter((r) => r.result !== 'pass');
logLine(`\nrelay: ${results.length - failed.length}/${results.length} tests passed`
  + (failed.length ? ` — failed: ${failed.map((r) => `[${r.suite}] ${r.name}`).join('; ')}` : ''));
process.exitCode = failed.length ? 1 : 0;
