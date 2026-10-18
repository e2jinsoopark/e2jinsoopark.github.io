// Test hook: run the real app against a local relay Worker without loosening the production CSP.
// stageTestSite() builds the site the way .github/workflows/pages.yml does (the same `cp -r` list: index.html, css,
// js, vendor) into a scratch folder outside the repo, then applies the two edits the deploy checklist
// (docs/notes/relay.md) makes once the Worker URL is known:
//   index.html         → the Worker origin appended to the CSP connect-src
//   js/core/config.js  → RELAY_DEFAULT_URL set to the Worker URL
// so the test also proves those two edits are enough. Each edit must apply exactly once, or staging throws.
// The staged folder is served by `python -m http.server`: the page then has a real loopback address. (A document
// answered by Playwright route interception has none, and Chromium's Local Network Access check refuses its
// requests to 127.0.0.1.)
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** The paths the Pages workflow copies into the published site, read from the workflow itself. */
export function publishedPaths(repo) {
  const workflow = readFileSync(join(repo, '.github/workflows/pages.yml'), 'utf8');
  const m = /^\s*cp -r ([^\n]+?) _site\/\s*$/m.exec(workflow);
  if (!m) throw new Error('pages.yml: no "cp -r … _site/" line found');
  return m[1].trim().split(/\s+/);
}

/** index.html with `origin` added to connect-src. */
export function testIndexHtml(repo, origin) {
  const html = readFileSync(join(repo, 'index.html'), 'utf8');
  const found = html.match(/connect-src [^;"]*/g) || [];
  if (found.length !== 1) throw new Error(`index.html: expected one connect-src directive, found ${found.length}`);
  return html.replace(/(connect-src [^;"]*)/, `$1 ${origin}`);
}

/** js/core/config.js with RELAY_DEFAULT_URL = `url`. */
export function testConfigJs(repo, url) {
  const js = readFileSync(join(repo, 'js/core/config.js'), 'utf8');
  const re = /^export const RELAY_DEFAULT_URL = '[^']*';$/gm;
  const found = js.match(re) || [];
  if (found.length !== 1) throw new Error(`js/core/config.js: expected one RELAY_DEFAULT_URL line, found ${found.length}`);
  return js.replace(re, `export const RELAY_DEFAULT_URL = '${url}';`);
}

/**
 * Stage the published files with the two deploy edits into `dir` (emptied first).
 * @param {{ repo: string, dir: string, workerUrl: string }} opts
 * @returns {string[]} the staged top-level paths
 */
export function stageTestSite({ repo, dir, workerUrl }) {
  const paths = publishedPaths(repo);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  for (const p of paths) cpSync(join(repo, p), join(dir, p), { recursive: true });
  writeFileSync(join(dir, 'index.html'), testIndexHtml(repo, new URL(workerUrl).origin));
  writeFileSync(join(dir, 'js/core/config.js'), testConfigJs(repo, workerUrl));
  return paths;
}
