// Translator + tasks on real papers extracted by js/pdf/extract.js, with the offline mock provider (?mock=1).
// Fixture PDFs are served from C:/Users/dindoo/Projects/pr-fixtures through a Playwright route (never copied into
// the repo); nothing leaves the browser.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { runSuite } from './lib.mjs';

const FIXTURES = 'C:/Users/dindoo/Projects/pr-fixtures';

async function serveFixtures(page) {
  await page.route('**/__fixtures/*.pdf', async (route) => {
    const name = new URL(route.request().url()).pathname.split('/').pop();
    await route.fulfill({ status: 200, contentType: 'application/pdf', body: fs.readFileSync(`${FIXTURES}/${name}`) });
  });
}

const translateFixture = (name) => async ({ page }) => {
  await serveFixtures(page);
  const r = await page.evaluate(async (file) => {
    const { loadPdf } = await import('/js/pdf/pdfjs.js');
    const { extractDocument } = await import('/js/pdf/extract.js');
    const { Translator } = await import('/js/ai/translator.js');
    const { mockControl } = await import('/js/ai/mock.js');
    const { LIMITS } = await import('/js/core/config.js');
    const T = await import('/js/ai/tasks.js');
    mockControl.reset();
    mockControl.latencyMs = 2;
    const bytes = new Uint8Array(await (await fetch(`/__fixtures/${file}`)).arrayBuffer());
    const doc = await extractDocument(await loadPdf(bytes));
    const kinds = {};
    for (const s of doc.sentences) kinds[s.kind] = (kinds[s.kind] || 0) + 1;
    const t = new Translator({ doc });
    const p = await t.translateAll({ startPage: Math.min(2, doc.numPages) });
    const reqs = mockControl.requests.filter((q) => q.task === 'translate');
    const batches = reqs.map((q) => ({ n: q.ids.length, chars: q.ids.reduce((a, id) => a + doc.sentenceById.get(id).text.length, 0) }));
    let summary = null;
    try { summary = (await T.summarize(doc)).markdown.length; } catch (e) { summary = `error:${e.code}:${e.message}`; }
    const kp = await T.keyPoints(doc).then((x) => x.items.length, (e) => `error:${e.code}`);
    return { pages: doc.numPages, hasText: doc.hasTextLayer, n: doc.sentences.length, kinds, p, batches, limits: LIMITS, summary, kp,
      firstPages: reqs.slice(0, 3).map((q) => doc.sentenceById.get(q.ids[0]).page) };
  }, name);
  assert.equal(r.p.done, r.p.total);
  assert.ok(r.batches.every((b) => b.n <= r.limits.translateBatchMaxSentences && b.chars <= r.limits.translateBatchMaxChars));
  if (r.p.total > 0) assert.equal(r.firstPages[0], Math.min(2, r.pages));
  return `${name}: ${r.pages} pages, text=${r.hasText}, ${r.n} sentences ${JSON.stringify(r.kinds)} → ${r.p.done}/${r.p.total} in ${r.batches.length} batches (max ${Math.max(0, ...r.batches.map((b) => b.n))} sent., ${Math.max(0, ...r.batches.map((b) => b.chars))} chars); summary=${r.summary}; keyPoints=${r.kp}`;
};

const tests = ['lu2025.pdf', 'kiekkas2012.pdf', 'simwright2005.pdf', 'cohen1960.pdf'].map((name) => ({
  name: `real PDF ${name}: extract → translateAll (mock) within limits, startPage=2 first; summary/keyPoints`,
  query: '?mock=1',
  fn: translateFixture(name),
}));

const { failed } = await runSuite('realpdf', tests);
process.exitCode = failed ? 1 : 0;
