// Keyless 관련 논문 / reference-card lookups (PubMed E-utilities, Europe PMC, Crossref; Semantic Scholar
// only as a fallback), driven through tests/features/harness.html in Edge with every API intercepted
// by canned responses built from real samples (scholarly-routes.mjs). Screenshots → pr-tools/out/related.
//   node tests/features/related-pubmed.mjs [filter]
// Serves the repo with `python -m http.server 8211` unless something already answers there.
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { FX, HARNESS_PMID, maxInWindow, routeScholarly } from './scholarly-routes.mjs';

const { chromium } = await import(pathToFileURL('C:/Users/dindoo/Projects/pr-tools/node_modules/playwright/index.mjs').href);

const PORT = 8211;
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = 'C:/Users/dindoo/Projects/pr-tools/out/related';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const FILTER = process.argv[2] || '';
mkdirSync(OUT, { recursive: true });

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
  if (FILTER && !name.includes(FILTER)) return;
  const t0 = Date.now();
  try {
    const ev = await fn();
    results.push({ name, ok: true });
    console.log(`PASS ${name} (${Date.now() - t0} ms) — ${ev ?? ''}`);
  } catch (err) {
    results.push({ name, ok: false });
    console.log(`FAIL ${name}\n  ${err.stack || err}`);
  }
}

// Semantic Scholar (fallback only): match / recommendations / DOI lookups.
const S2 = {
  match: { data: [{ paperId: 'S2X', title: 'A locally circulated nursing QI report on huddles', year: 2023, authors: [{ name: 'Q. Writer' }], url: 'https://www.semanticscholar.org/paper/S2X', externalIds: {}, abstract: 'Synthetic.', citationCount: 2 }] },
  recs: { recommendedPapers: [1, 2, 3].map((i) => ({ paperId: `S2R${i}`, title: `Semantic Scholar recommendation ${i}`, year: 2020 + i, authors: [{ name: 'R. Author' }], url: `https://www.semanticscholar.org/paper/S2R${i}`, abstract: null, citationCount: i * 10, externalIds: { DOI: `10.0000/s2r${i}` }, venue: 'Synthetic Journal' })) },
};
async function routeS2(page, { log = [], match = false } = {}) {
  await page.route('https://api.semanticscholar.org/**', async (route) => {
    const url = new URL(route.request().url());
    log.push({ host: 's2', path: url.pathname, params: Object.fromEntries(url.searchParams), t: Date.now() });
    const json = (status, body) => route.fulfill({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });
    if (match && url.pathname === '/graph/v1/paper/search/match') return json(200, S2.match);
    if (match && url.pathname.startsWith('/recommendations/v1/papers/forpaper/')) return json(200, S2.recs);
    return json(404, { error: 'Title match not found' });
  });
}

const browser = await chromium.launch({ channel: 'msedge' });

async function open({ query = 'mock=1&reset=1', tab, viewport = { width: 1440, height: 900 }, mode = {}, s2Match = false, consent = false, theme } = {}) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  const errors = [];
  const log = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|ERR_FAILED/.test(m.text())) errors.push(m.text()); });
  await page.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.abort()); // nothing real leaves the machine
  await routeS2(page, { log, match: s2Match });
  await routeScholarly(page, { log, mode });
  if (consent) await page.addInitScript(() => localStorage.setItem('pr.features.scholarConsent.v1', 'true'));
  await page.goto(`${BASE}/tests/features/harness.html?${query}${tab ? `&tab=${tab}` : ''}${theme ? `&theme=${theme}` : ''}`);
  await page.waitForSelector('body[data-ready="1"]', { timeout: 10000 });
  return { page, context, errors, log };
}
const shot = (page, name, opts = {}) => page.screenshot({ path: `${OUT}/${name}.png`, ...opts });
const relatedShot = async (page, name) => {
  const box = await page.$('#right');
  await box.screenshot({ path: `${OUT}/${name}.png` });
};

// ------------------------------------------------------------------------------------ units

await test('textmatch: normalisation, similarity, words, plain text, DOI', async () => {
  const { page, context } = await open();
  const r = await page.evaluate(async () => {
    const t = await import('/js/features/textmatch.js');
    return {
      same: t.titleSimilarity('Delirium as a predictor of mortality in mechanically ventilated patients in the intensive care unit.', 'Delirium as a Predictor of Mortality in Mechanically Ventilated Patients in the Intensive Care Unit'),
      subtitle: t.titleSimilarity('Early physical and occupational therapy in mechanically ventilated, critically ill patients', 'Early physical and occupational therapy in mechanically ventilated, critically ill patients: a randomised controlled trial'),
      other: t.titleSimilarity('Delirium as a predictor of mortality in mechanically ventilated patients', 'Motoric subtypes of delirium in mechanically ventilated surgical and trauma intensive care unit patients'),
      words: t.significantWords('Early Mobilization and Delirium in Mechanically Ventilated Adults: A Nurse-Led Protocol'),
      overlap: t.wordOverlap('Motoric subtypes of delirium in mechanically ventilated surgical and trauma intensive care unit patients', 'Ely EW, Shintani A. Delirium as a predictor of mortality in mechanically ventilated patients in the intensive care unit. JAMA. 2004'),
      plain: t.plainText('<h4>Context</h4>In the ICU, delirium &amp; coma<h4>Objective</h4>To <i>determine</i> outcomes.'),
      doi: t.findDoi('Crit Care Med. 2020; https://doi.org/10.1016/S2213-2600(20)30552-X.'),
      accent: t.normalizeTitle('Évaluation précoce — São Paulo'),
    };
  });
  assert(r.same === 1, `same ${r.same}`);
  assert(r.subtitle >= 0.85, `subtitle ${r.subtitle}`);
  assert(r.other < 0.85, `other ${r.other}`);
  assert(r.words.join(' ') === 'early mobilization delirium mechanically ventilated adults nurse led protocol', r.words.join(' '));
  assert(r.overlap > 0.6 && r.overlap < 0.7, `overlap ${r.overlap}`);
  assert(r.plain === 'Context: In the ICU, delirium & coma\nObjective: To determine outcomes.', JSON.stringify(r.plain));
  assert(r.doi === '10.1016/S2213-2600(20)30552-X', r.doi);
  assert(r.accent === 'evaluation precoce sao paulo', r.accent);
  await context.close();
  return `same=1, subtitle=${r.subtitle.toFixed(2)}, unrelated=${r.other.toFixed(2)}, overlap=${r.overlap.toFixed(2)}, EPMC <h4> → "Context: …" lines`;
});

await test('crossref: query.bibliographic hits accepted only when clearly ahead and ≥ 60 % title words (real samples)', async () => {
  const { page, context } = await open();
  const r = await page.evaluate(async (fx) => {
    const { pickReferenceHit } = await import('/js/features/crossref.js');
    const refs = [
      'Ely EW, Shintani A, Truman B, et al. Delirium as a predictor of mortality in mechanically ventilated patients in the intensive care unit. JAMA. 2004;291(14):1753-1762.',
      'Schweickert WD, Pohlman MC, Pohlman AS, et al. Early physical and occupational therapy in mechanically ventilated, critically ill patients: a randomised controlled trial. Lancet. 2009;373(9678):1874-1882.',
      'Park J, Kim S. Nurse-led mobility huddles in intensive care: a quality improvement study. J Crit Care Nurs. 2022;15(2):101-110.',
    ];
    const out = [fx.ref1, fx.ref2, fx.ref3].map((d, i) => pickReferenceHit(d.message.items, refs[i]));
    // Two plausible, different works with near-equal scores → ambiguous → rejected.
    const items = structuredClone(fx.ref1.message.items);
    items[1] = { ...items[1], title: ['Delirium as a predictor of mortality in mechanically ventilated patients in the intensive care unit: a reanalysis'], issued: { 'date-parts': [[2004]] }, score: items[0].score * 0.97 };
    const ambiguous = pickReferenceHit(items, refs[0]);
    return { dois: out.map((h) => h?.doi ?? null), first: out[0], ambiguous };
  }, FX.crossref);
  assert(r.dois[0] === '10.1001/jama.291.14.1753', r.dois[0]);
  assert(r.dois[1] === '10.1016/s0140-6736(09)60658-9', r.dois[1]);
  assert(r.dois[2] === null, `ref3 ${r.dois[2]}`);
  assert(r.ambiguous === null, 'near-tie rejected');
  assert(r.first.authors[0] === 'Ely EW' && r.first.journal === 'JAMA' && r.first.year === 2004 && r.first.citationCount === 2547, JSON.stringify(r.first));
  await context.close();
  return `ref1 → ${r.dois[0]}, ref2 → ${r.dois[1]} (Japanese 2018 near-duplicate ignored), ref3 → no match, near-tie → rejected`;
});

await test('crossref: 48 real answers (lu2025 + kiekkas2012 references) → right DOI or refusal; a commentary quoting the entry is refused', async () => {
  const { page, context } = await open();
  const cases = FX.crossrefCalibration.cases;
  const r = await page.evaluate(async (cases) => {
    const { pickReferenceHit } = await import('/js/features/crossref.js');
    const { referenceTitle } = await import('/js/features/textmatch.js');
    return {
      picks: cases.map((c) => pickReferenceHit(c.items, c.text.slice(0, 400))?.doi ?? null),
      titles: [
        referenceTitle('10. R. Kaplow and M. Bookbinder, “Comparison of Four Endotracheal Tube Holders,” Heart & Lung 23, no. 1 (1994): 59–66.'),
        referenceTitle('Coppolo DP, May JJ. (1990). Self-extubations: a 12-month experience. Chest; 98: 165–169.'),
        referenceTitle('Ely EW, Shintani A. Delirium as a predictor of mortality. JAMA. 2004;291:1753-62.'),
      ],
      // Errata / replies carry the work's title words but are not the work.
      erratum: pickReferenceHit([{ DOI: '10.1/err', title: ['Correction to: Endotracheal Tube Nursing Care: Current Evidence'], score: 120, type: 'journal-article', issued: { 'date-parts': [[2022]] } }],
        '1. F. A. M. Saad, H. Ahmed, “Endotracheal Tube Nursing Care: Current Evidence,” Mansoura Nursing Journal 9 (2022): 177–187.'),
      supplement: pickReferenceHit([{ DOI: '10.1/comp', title: ['Endotracheal Tube Nursing Care: Current Evidence'], score: 120, type: 'component', issued: { 'date-parts': [[2022]] } }],
        '1. F. A. M. Saad, H. Ahmed, “Endotracheal Tube Nursing Care: Current Evidence,” Mansoura Nursing Journal 9 (2022): 177–187.'),
    };
  }, cases);
  const wrong = cases.filter((c, i) => (r.picks[i] || null) !== (c.expect || null)).map((c) => `${c.id}: ${r.picks[cases.indexOf(c)]} ≠ ${c.expect}`);
  const truth = cases.filter((c) => c.doi && c.expect);
  const kaplow = cases.find((c) => c.id === 'lu10');
  assert(!wrong.length, wrong.join('; '));
  assert(truth.every((c) => c.expect.toLowerCase() === c.doi.toLowerCase()), 'every accepted lu2025 pick equals the printed DOI');
  assert(r.picks[cases.indexOf(kaplow)] === null && /^Spotlight article/.test(kaplow.items[0].title[0]), 'Kaplow 1994 → the 1995 commentary is refused');
  assert(r.titles[0] === 'Comparison of Four Endotracheal Tube Holders' && r.titles[1] === 'Self-extubations: a 12-month experience' && r.titles[2] === null, JSON.stringify(r.titles));
  assert(r.erratum === null && r.supplement === null, 'notices and supplement files are not the work');
  await context.close();
  const accepted = r.picks.filter(Boolean).length;
  return `${accepted}/48 matched (${truth.length} equal to the DOI printed in lu2025), ${48 - accepted} refused (lu10 commentary, lu12 abstract, lu13 book, lu14, ki14); erratum / component refused`;
});

await test('network: NCBI 429 without CORS headers (its real answer) is retried after 2 s, 4 s; persistent → busy message; offline → fails fast', async () => {
  const a = await open({ tab: 'related', consent: true, mode: { ncbi429NoCors: 'once' } });
  await a.page.waitForSelector('.pf-related__item', { timeout: 15000 });
  const recovered = await a.page.$$eval('.pf-related__item', (x) => x.length);
  const ta = a.log.filter((l) => l.host === 'ncbi').map((l) => l.t);
  await a.context.close();
  const b = await open({ tab: 'related', consent: true, mode: { ncbi429NoCors: 'always' } });
  await b.page.waitForSelector('.pf-error-box', { timeout: 15000 });
  const msg = await b.page.textContent('.pf-error-box p');
  const tb = b.log.filter((l) => l.host === 'ncbi').map((l) => l.t);
  const retryBtn = await b.page.$('.pf-error-box [data-action="retry"]');
  // offline: no retries, the connection message at once (Crossref unrouted → the catch-all aborts it)
  await b.page.unroute('https://api.crossref.org/**');
  await b.context.setOffline(true);
  const off = await b.page.evaluate(async () => {
    const { scholarlyGet } = await import('/js/features/scholarly-net.js');
    const t0 = performance.now();
    const e = await scholarlyGet('crossref', 'https://api.crossref.org/works?query.bibliographic=x&rows=3').then(() => null, (err) => err);
    return { ms: performance.now() - t0, message: e?.message, code: e?.code };
  });
  await b.context.close();
  assert(recovered === 20 && ta[1] - ta[0] >= 1900, `recovered after one CORS-less 429 (${recovered}, retry after ${ta[1] - ta[0]} ms)`);
  assert(tb.length === 3 && tb[1] - tb[0] >= 1900 && tb[2] - tb[1] >= 3900, `attempts ${tb.map((t) => t - tb[0])}`);
  assert(msg.startsWith('PubMed에 연결하지 못했습니다') && msg.includes('잠시 후 다시 시도해 주세요') && !msg.includes('인터넷 연결을 확인'), msg);
  assert(retryBtn, '다시 시도 button');
  assert(off.code === 'network' && off.message.includes('인터넷 연결을 확인') && off.ms < 1500, JSON.stringify(off));
  return `once → retried after ${ta[1] - ta[0]} ms, 20 items; always → attempts +${tb.map((t) => t - tb[0]).join('/+')} ms → "${msg}"; offline → "${off.message}" in ${Math.round(off.ms)} ms`;
});

await test('Semantic Scholar fallback: its CORS-less 429 (a failed fetch) is retried once', async () => {
  const { page, context } = await open();
  let n = 0;
  await page.route('https://api.semanticscholar.org/**', async (route) => {
    n += 1;
    // First answer: 429 the browser may not read (foreign ACAO — route.fulfill would add ours otherwise).
    if (n === 1) return route.fulfill({ status: 429, contentType: 'application/json', headers: { 'access-control-allow-origin': 'https://not-this-page.invalid' }, body: '{"message":"Too Many Requests"}' });
    return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ paperId: 'S2DOI', title: 'Endotracheal Tube Nursing Care: Current Evidence', year: 2022, authors: [{ name: 'F. Saad' }], externalIds: { DOI: '10.21608/mnj.2022.259016' }, citationCount: 8 }) });
  });
  const r = await page.evaluate(async () => {
    const { paperByDoi } = await import('/js/features/s2.js');
    const t0 = performance.now();
    const p = await paperByDoi('10.21608/mnj.2022.259016');
    return { id: p?.paperId, ms: Math.round(performance.now() - t0) };
  });
  assert(r.id === 'S2DOI' && n === 2 && r.ms >= 1100, JSON.stringify({ ...r, n }));
  await context.close();
  return `blocked 429 → retried after ${r.ms} ms → ${r.id}`;
});

await test('reference lookup: printed DOI cut at a line break → Crossref → right DOI; DOI only Crossref knows → Crossref record; commentary refused → S2', async () => {
  const { page, context, log } = await open();
  const texts = {
    cut: '6. J. P. Radua, “PRISMA 2020—An Updated Checklist for Systematic Reviews and Meta-Analyses,” Neuroscience and Biobehavioral Reviews 124 (2021): 324–325, https://doi.org/10.1016/j.neubiorev.2021. 02.016.',
    notIndexed: '1. F. A. M. Saad, H. Ahmed, N. Rezk, and N. A. Kandeel, “Endotracheal Tube Nursing Care: Current Evidence,” Mansoura Nursing Journal 9, no. 1 (2022): 177–187, https://doi.org/10.21608/mnj.2022.259016.',
    commentary: '10. R. Kaplow and M. Bookbinder, “Comparison of Four Endotracheal Tube Holders,” Heart & Lung 23, no. 1 (1994): 59–66.',
  };
  const out = {};
  for (const [k, text] of Object.entries(texts)) {
    const n = log.length;
    const p = await page.evaluate(async (t) => {
      const { lookupReference } = await import('/js/features/scholarly.js');
      return lookupReference(t);
    }, text);
    out[k] = { doi: p?.doi ?? null, sources: p?.sources ?? null, title: p?.title ?? null, hosts: log.slice(n).map((l) => (l.host === 's2' ? `s2:${l.path.split('/')[3]}` : l.host)) };
  }
  assert(out.cut.doi === '10.1016/j.neubiorev.2021.02.016' && out.cut.sources[0] === 'Crossref', JSON.stringify(out.cut));
  assert(out.cut.hosts.join() === 'epmc,ncbi,s2:paper,crossref,epmc,ncbi', out.cut.hosts.join());
  assert(out.notIndexed.doi === '10.21608/mnj.2022.259016' && out.notIndexed.sources.join() === 'Crossref' && out.notIndexed.title === 'Endotracheal Tube Nursing Care: Current Evidence', JSON.stringify(out.notIndexed));
  assert(out.notIndexed.hosts.join() === 'epmc,ncbi,s2:paper,crossref', `same DOI is not looked up twice: ${out.notIndexed.hosts.join()}`);
  assert(out.commentary.doi === null && out.commentary.hosts.join() === 'crossref,s2:paper', JSON.stringify(out.commentary));
  await context.close();
  return `cut DOI → ${out.cut.hosts.join(' → ')} → ${out.cut.doi}; not in PubMed/EPMC/S2 → ${out.notIndexed.sources} record; Kaplow 1994 → commentary refused → S2 → not found`;
});

await test('rate limiter: ≤ 3 starts per 1.1 s, FIFO, aborted waiters leave the queue', async () => {
  const { page, context } = await open();
  const r = await page.evaluate(async () => {
    const { RateLimiter } = await import('/js/features/scholarly-net.js');
    const lim = new RateLimiter({ max: 3, windowMs: 1100 });
    const t0 = performance.now();
    const starts = [];
    const ctl = new AbortController();
    const aborted = lim.acquire(ctl.signal).then(() => 'started', (e) => e.name);
    ctl.abort();
    await Promise.all(Array.from({ length: 7 }, (_, i) => lim.acquire().then(() => starts.push({ i, t: Math.round(performance.now() - t0) }))));
    return { starts, aborted: await aborted };
  });
  const ts = r.starts.map((s) => s.t);
  let worst = 0;
  for (let i = 0; i < ts.length; i++) worst = Math.max(worst, ts.filter((t) => t >= ts[i] && t < ts[i] + 1000).length);
  assert(worst <= 3, `max ${worst} starts in 1 s: ${ts}`);
  assert(r.starts.map((s) => s.i).join() === '0,1,2,3,4,5,6', 'FIFO');
  assert(r.aborted === 'AbortError', r.aborted);
  await context.close();
  return `start times ${ts.join(', ')} ms (≤ 3 per second), aborted waiter → AbortError`;
});

await test('network: timeout and caller abort give a Korean error / AbortError', async () => {
  const { page, context } = await open({ mode: { ncbiDelayMs: 1500 } });
  const r = await page.evaluate(async () => {
    const { scholarlyGet } = await import('/js/features/scholarly-net.js');
    const url = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=x&retmode=json&tool=galpi';
    const timeout = await scholarlyGet('pubmed', url, { timeoutMs: 300 }).then(() => null, (e) => ({ name: e.name, code: e.code, message: e.message }));
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 200);
    const abort = await scholarlyGet('pubmed', url, { signal: ctl.signal }).then(() => null, (e) => e.name);
    return { timeout, abort };
  });
  assert(r.timeout?.code === 'timeout' && r.timeout.message.startsWith('PubMed 응답이 늦어'), JSON.stringify(r.timeout));
  assert(r.abort === 'AbortError', r.abort);
  await context.close();
  return `timeout → "${r.timeout.message}"; ctx.signal abort → AbortError`;
});

await test('identify: DOI → PubMed, title validated by ESummary similarity + year, page-1 DOI of another paper rejected', async () => {
  const { page, context, log } = await open();
  const r = await page.evaluate(async () => {
    const { identifyPaper } = await import('/js/features/scholarly.js');
    const byDoi = await identifyPaper({ doi: '10.1001/jama.291.14.1753', title: 'Delirium as a predictor of mortality' });
    const byTitle = await identifyPaper({ title: 'Early Mobilization and Delirium in Mechanically Ventilated Adults: A Nurse-Led Protocol', year: 2024 });
    const wrongYear = await identifyPaper({ title: 'Early Mobilization and Delirium in Mechanically Ventilated Adults: A Nurse-Led Protocol', year: 2015 });
    // The first DOI on page 1 is a cited paper's (Ely 2004): it must not become the open paper.
    const citedDoi = await identifyPaper({ doi: '10.1001/jama.291.14.1753', doiFromText: true, title: 'Early Mobilization and Delirium in Mechanically Ventilated Adults: A Nurse-Led Protocol', year: 2024 });
    // …but when the extracted title finds nothing, the page-1 DOI is still the best guess.
    const badTitle = await identifyPaper({ doi: '10.1001/jama.291.14.1753', doiFromText: true, title: 'Journal of Critical Care Volume 3 Issue 2 Original Research' });
    const typedPmid = await identifyPaper({ query: '19446324' });
    const none = await identifyPaper({ title: 'An unpublished ward quality report' });
    return { byDoi: [byDoi?.pmid, byDoi?.via, byDoi?.journal, byDoi?.authors?.[0]], byTitle: [byTitle?.pmid, byTitle?.via], wrongYear, citedDoi: [citedDoi?.pmid, citedDoi?.via], badTitle: badTitle?.pmid, typedPmid: typedPmid?.pmid, none };
  });
  const ncbi = log.filter((l) => l.host === 'ncbi');
  assert(r.byDoi.join() === '15082703,doi,JAMA,Ely EW', r.byDoi.join());
  assert(r.byTitle.join() === `${HARNESS_PMID},title`, r.byTitle.join());
  assert(r.wrongYear === null, 'year mismatch rejected');
  assert(r.citedDoi.join() === `${HARNESS_PMID},title`, r.citedDoi.join());
  assert(r.badTitle === '15082703', `page-1 DOI kept when the title finds nothing (${r.badTitle})`);
  assert(r.typedPmid === '19446324', r.typedPmid);
  assert(r.none === null, 'not found');
  assert(ncbi.every((l) => l.params.tool === 'galpi' && !('email' in l.params) && !('api_key' in l.params)), 'tool=galpi, no email / api_key');
  assert(ncbi.find((l) => l.path === 'esearch.fcgi').params.term === '"10.1001/jama.291.14.1753"[doi]', ncbi[0].params.term);
  assert(log.some((l) => l.host === 'epmc' && /^TITLE:"/.test(l.params.query)), 'Europe PMC title search as second chance');
  await context.close();
  return `DOI → 15082703; title → ${HARNESS_PMID} (decoy 15082703 rejected by similarity); wrong year → null; cited DOI on page 1 → title match; ${ncbi.length} NCBI calls all tool=galpi`;
});

// ------------------------------------------------------------------------------------ panel

await test('panel: consent first, then PubMed similar articles with Europe PMC counts, pmid stored, cached', async () => {
  const { page, context, errors, log } = await open();
  await page.click('#tabs [data-tab="related"]');
  await page.waitForSelector('[data-action="scholar-consent"]');
  const consentText = await page.textContent('.pf-related__consent');
  await sleep(300);
  assert(log.length === 0, `nothing sent before consent (${log.length})`);
  await relatedShot(page, 'r01-consent');
  await page.click('[data-action="scholar-consent"]');
  await page.waitForSelector('.pf-related__item');
  const items = await page.$$eval('.pf-related__item', (lis) => lis.map((li) => ({
    pmid: li.dataset.pmid,
    title: li.querySelector('.pf-related__title').textContent,
    meta: [...li.querySelectorAll('.pf-related__meta')].map((m) => m.textContent),
    links: [...li.querySelectorAll('.pf-linkbadge')].map((a) => ({ kind: a.dataset.link, href: a.href, rel: a.rel, target: a.target })),
  })));
  const source = await page.textContent('.pf-related__source');
  const match = await page.textContent('.pf-related__match');
  await page.waitForFunction(() => __h.library.data['paper1/ai']?.related?.items?.length === 20);
  const ai = await page.evaluate(() => __h.library.data['paper1/ai'].related);
  const updates = await page.evaluate(() => __h.library.updates);
  await relatedShot(page, 'r02-panel-pubmed');
  await shot(page, 'r02-full');
  const seq = log.map((l) => (l.host === 'ncbi' ? l.path.replace('.fcgi', '') : l.host === 'epmc' ? `epmc:${l.params.resultType}` : l.host));
  const ncbiMax = maxInWindow(log, 'ncbi');
  const elink = log.find((l) => l.path === 'elink.fcgi');
  const epmc = log.find((l) => l.host === 'epmc');
  // reopen: cache, no requests
  const before = log.length;
  await page.goto(`${BASE}/tests/features/harness.html?mock=1&tab=related`);
  await page.waitForSelector('body[data-ready="1"]');
  await page.waitForSelector('.pf-related__item');
  await sleep(200);
  const firstFree = items.find((i) => i.links.some((l) => l.kind === 'free'));
  assert(consentText.includes('PubMed(미국 국립의학도서관)') && consentText.includes('Europe PMC') && consentText.includes('Crossref') && consentText.includes('Semantic Scholar') && consentText.includes('API 키는 필요 없습니다'), consentText);
  assert(seq.join(' ') === 'esearch esummary elink esummary epmc:lite', seq.join(' '));
  assert(elink.params.cmd === 'neighbor_score' && elink.params.linkname === 'pubmed_pubmed' && elink.ids.join() === HARNESS_PMID, JSON.stringify(elink.params));
  assert(/^\(EXT_ID:\d+( OR EXT_ID:\d+){20}\) AND SRC:MED$/.test(epmc.params.query), `one batched Europe PMC query for 20 + base: ${epmc.params.query.slice(0, 80)}`);
  assert(items.length === 20 && items[0].pmid === '16137350', `20 items, best neighbour first (${items[0]?.pmid})`);
  assert(items[0].title.startsWith('Intensive care unit delirium is an independent predictor'), items[0].title);
  assert(items[0].meta.join(' | ').includes('Crit Care · 2005 · 인용 371회'), items[0].meta.join(' | '));
  assert(items.every((i) => i.links.some((l) => l.kind === 'pubmed') && i.links.every((l) => l.rel.includes('noopener') && l.target === '_blank')), 'PubMed links, noopener');
  assert(firstFree && /pmc\.ncbi\.nlm\.nih\.gov\/articles\/PMC\d+\/$/.test(firstFree.links.find((l) => l.kind === 'free').href), 'free full text → PMC');
  assert(source.trim() === '출처: PubMed 유사 논문 · 인용 수 Europe PMC', source);
  assert(match.includes('기준 논문 (PubMed)') && match.includes('Early Mobilization and Delirium'), match);
  assert(updates.length === 1 && updates[0].patch.pmid === HARNESS_PMID && updates[0].patch.doi === '10.0000/synthetic.2024.001', JSON.stringify(updates));
  assert(ai.source === 'pubmed' && ai.pmid === HARNESS_PMID && ai.items[0].citationCount === 371 && ai.items[0].citationSource === 'Europe PMC', JSON.stringify(ai).slice(0, 300));
  assert(ncbiMax <= 3, `NCBI requests within 1 s: ${ncbiMax}`);
  assert(log.length === before, `reopen served from ai.related (${log.length - before} requests)`);
  assert(!errors.length, errors.join('\n'));
  await context.close();
  return `consent → ${seq.join(' → ')}; 20 cards, base paper + 20 in one Europe PMC query; updatePaper({pmid:${HARNESS_PMID}, doi}); ≤ ${ncbiMax} NCBI req/s; reopen 0 requests`;
});

await test('panel: sort 관련도 / 최신순 / 인용순 (remembered), abstract lazily from Europe PMC, EFetch fallback, translate', async () => {
  const { page, context, errors, log } = await open({ tab: 'related', consent: true });
  await page.waitForSelector('.pf-related__item');
  const years = () => page.$$eval('.pf-related__item', (lis) => lis.map((li) => Number(li.querySelector('.pf-related__meta:not(.pf-related__authors)').textContent.match(/\b(19|20)\d{2}\b/)?.[0] ?? 0)));
  const cites = () => page.$$eval('.pf-related__item', (lis) => lis.map((li) => Number(li.querySelector('.pf-related__cites')?.textContent.match(/\d+/)?.[0] ?? -1)));
  await page.click('[data-action="sort"][data-sort="recent"]');
  const ys = await years();
  await page.click('[data-action="sort"][data-sort="cited"]');
  const cs = await cites();
  const remembered = await page.evaluate(() => localStorage.getItem('pr.features.relatedSort.v1'));
  await page.click('[data-action="sort"][data-sort="relevance"]');
  const n0 = log.length;
  // 36205994 (JAMA Netw Open 2022): Europe PMC core has the abstract
  const li = '.pf-related__item[data-pmid="36205994"]';
  await page.click(`${li} [data-action="abstract"]`);
  await page.waitForSelector(`${li} .pf-related__absbox strong`);
  const abs = await page.$eval(`${li} .pf-related__absbox`, (b) => ({ labels: [...b.querySelectorAll('strong')].map((s) => s.textContent), text: b.textContent }));
  const absReq = log.slice(n0).map((l) => `${l.host}:${l.params.resultType || l.path}`);
  await page.click(`${li} [data-action="translate"]`);
  await page.waitForFunction((sel) => document.querySelector(`${sel} .pf-related__ko`)?.textContent.includes('〔빠른 번역〕'), li);
  await page.$eval(li, (e) => e.scrollIntoView({ block: 'start' }));
  await relatedShot(page, 'r03-abstract');
  // 18784563: no Europe PMC core fixture → EFetch → no abstract
  const n1 = log.length;
  const li2 = '.pf-related__item[data-pmid="18784563"]';
  await page.click(`${li2} [data-action="abstract"]`);
  await page.waitForFunction((sel) => document.querySelector(`${sel} .pf-related__absbox`)?.textContent.includes('초록이 없습니다'), li2);
  const fallbackReq = log.slice(n1).map((l) => (l.host === 'ncbi' ? l.path : `${l.host}:${l.params.resultType}`));
  await page.waitForFunction(() => __h.library.data['paper1/ai']?.related?.items?.find((p) => p.pmid === '36205994')?.abstract?.startsWith('Importance:'));
  for (let i = 0; i < ys.length - 1; i++) assert(ys[i] >= ys[i + 1], `recent order ${ys}`);
  for (let i = 0; i < cs.length - 1; i++) assert(cs[i] >= cs[i + 1], `cited order ${cs}`);
  assert(remembered === '"cited"', remembered);
  assert(abs.labels.slice(0, 2).join() === 'Importance: ,Objective: ', abs.labels.join('|'));
  assert(absReq.join() === 'epmc:core', absReq.join());
  assert(fallbackReq.join() === 'epmc:core,efetch.fcgi', fallbackReq.join());
  assert(!errors.length, errors.join('\n'));
  await context.close();
  return `최신순 ${ys.slice(0, 4).join(',')}…; 인용순 ${cs.slice(0, 4).join(',')}…; 초록 via ${absReq} (labels ${abs.labels.slice(0, 3).join('')}…), cached; missing → ${fallbackReq.join(' → ')}`;
});

await test('panel: 이 폴더 기준 추천 aggregates neighbour scores over the folder (one ELink request), resolves pmids once', async () => {
  const { page, context, errors, log } = await open({ query: 'mock=1&reset=1&folder=1', tab: 'related', consent: true });
  await page.waitForSelector('.pf-related__item');
  const n0 = log.length;
  await page.click('[data-action="folder"]');
  await page.waitForSelector('.pf-related__folder');
  await page.waitForSelector('.pf-related__item');
  const head = await page.textContent('.pf-related__folder');
  const source = await page.textContent('.pf-related__source');
  const items = await page.$$eval('.pf-related__item', (lis) => lis.map((li) => ({ pmid: li.dataset.pmid, meta: li.textContent })));
  const reqs = log.slice(n0);
  const elinks = reqs.filter((l) => l.path === 'elink.fcgi');
  const updates = await page.evaluate(() => __h.library.updates);
  await page.waitForFunction(() => __h.library.data['paper1/ai']?.related?.folder?.items?.length > 0);
  const folder = await page.evaluate(() => __h.library.data['paper1/ai'].related.folder);
  await relatedShot(page, 'r04-folder');
  // back to this paper: no new requests; folder again: cache
  const n1 = log.length;
  await page.click('[data-action="folder"]');
  await page.waitForSelector('.pf-related__match:not(.pf-related__folder)');
  await page.click('[data-action="folder"]');
  await page.waitForSelector('.pf-related__folder');
  await sleep(200);
  const inFolder = new Set([HARNESS_PMID, '19446324', '15082703']);
  assert(elinks.length === 1 && elinks[0].ids.sort().join() === ['15082703', '19446324', HARNESS_PMID].sort().join() && elinks[0].params.cmd === 'neighbor_score', JSON.stringify(elinks.map((e) => e.ids)));
  assert(head.includes('‘섬망 연구’ 폴더의 논문 4편') && head.includes('PubMed에서 찾은 3편'), head);
  assert(source.includes('폴더 논문 3편 기준'), source);
  assert(items.length === 20 && items.every((i) => !inFolder.has(i.pmid)), 'folder papers excluded');
  assert(items.some((i) => i.meta.includes('폴더 논문 2편과 관련')), 'shared neighbours marked');
  assert(updates.some((u) => u.id === 'paper3' && u.patch.pmid === '15082703') && !updates.some((u) => u.id === 'paper4'), JSON.stringify(updates));
  assert(folder.sources.length === 4 && folder.sources.find((s) => s.id === 'paper4').pmid === null, JSON.stringify(folder.sources));
  assert(log.length === n1, `toggling back and forth served from cache (${log.length - n1} requests)`);
  assert(maxInWindow(log, 'ncbi') <= 3, 'NCBI ≤ 3/s');
  assert(!errors.length, errors.join('\n'));
  await context.close();
  return `${reqs.length} requests (paper3 found by title, paper4 not found, paper2 stored pmid) → 1 ELink for 3 PMIDs → 20 recommendations; cached in ai.related.folder`;
});

await test('panel: PubMed 429 → back-off retries, then 「PubMed가 잠시 바쁩니다」 with 다시 시도; a single 429 recovers', async () => {
  const a = await open({ tab: 'related', consent: true, mode: { ncbi429: 'always' } });
  await a.page.waitForSelector('.pf-error-box', { timeout: 12000 });
  const msg = await a.page.textContent('.pf-error-box p');
  const tries = a.log.filter((l) => l.host === 'ncbi').map((l) => l.t);
  await relatedShot(a.page, 'r05-429');
  await a.context.close();
  const b = await open({ tab: 'related', consent: true, mode: { ncbi429: 'once' } });
  await b.page.waitForSelector('.pf-related__item', { timeout: 12000 });
  const n = await b.page.$$eval('.pf-related__item', (x) => x.length);
  await b.context.close();
  assert(msg === 'PubMed가 잠시 바쁩니다. 잠시 후 다시 시도해 주세요.', msg);
  assert(tries.length === 3 && tries[1] - tries[0] >= 900 && tries[2] - tries[1] >= 1800, `attempts ${tries.map((t) => t - tries[0])}`);
  assert(n === 20, `recovered after one 429 (${n})`);
  return `3 attempts at +${tries.map((t) => t - tries[0]).join('/+')} ms → "${msg}"; one 429 → recovered (${n} items)`;
});

await test('panel: Europe PMC down → list still shown without counts; not in PubMed → Semantic Scholar fallback; typed PMID', async () => {
  const a = await open({ tab: 'related', consent: true, mode: { epmcDown: true } });
  await a.page.waitForSelector('.pf-related__item');
  const src = await a.page.textContent('.pf-related__source');
  const cites = await a.page.$$eval('.pf-related__cites', (x) => x.length);
  await a.context.close();
  // Rematch with a title PubMed / Europe PMC do not know → Semantic Scholar
  const b = await open({ tab: 'related', consent: true, s2Match: true });
  await b.page.waitForSelector('.pf-related__item');
  await b.page.click('[data-action="rematch"]');
  await b.page.fill('.pf-related__search input', 'A locally circulated nursing QI report on huddles');
  await b.page.click('[data-action="search"]');
  await b.page.waitForSelector('.pf-related__source[data-source="s2"]');
  const s2src = await b.page.textContent('.pf-related__source');
  const s2items = await b.page.$$eval('.pf-related__item', (x) => x.length);
  const s2log = b.log.filter((l) => l.host === 's2').map((l) => l.path);
  await relatedShot(b.page, 'r06-s2-fallback');
  // typed PMID → PubMed again
  await b.page.click('[data-action="rematch"]');
  await b.page.fill('.pf-related__search input', '19446324');
  await b.page.click('[data-action="search"]');
  await b.page.waitForFunction(() => document.querySelector('.pf-related__match')?.textContent.includes('Early physical and occupational therapy'));
  const stored = await b.page.evaluate(() => __h.library.paper.pmid);
  await b.context.close();
  // Nothing anywhere → not-found form (S2 404 is not an error screen)
  const c = await open({ tab: 'related', consent: true });
  await c.page.waitForSelector('.pf-related__item');
  await c.page.click('[data-action="rematch"]');
  await c.page.fill('.pf-related__search input', 'Totally unknown manuscript title words');
  await c.page.click('[data-action="search"]');
  await c.page.waitForFunction(() => document.querySelector('.pf-related__search .pf-empty__title')?.textContent.includes('PubMed에서 이 논문을 찾지 못했습니다'));
  await c.context.close();
  assert(src.includes('인용 수를 불러오지 못했습니다') && cites === 0, `${src} / ${cites}`);
  assert(s2src.includes('Semantic Scholar 추천') && s2items === 3, `${s2src} / ${s2items}`);
  assert(s2log[0] === '/graph/v1/paper/search/match' && s2log[1].startsWith('/recommendations/v1/papers/forpaper/S2X'), s2log.join());
  assert(stored === '19446324', stored);
  return `EPMC 500 → 20 items, "${src.trim()}"; unknown title → S2 (${s2log.join(' → ')}); PMID 19446324 typed → stored; nothing found → form`;
});

await test('panel: legacy Semantic Scholar cache still renders; dark theme', async () => {
  const { page, context, errors } = await open({ query: 'mock=1&reset=1', tab: 'related', theme: 'dark' });
  await page.evaluate(async () => {
    await __h.ctx.saveAi({ related: { s2PaperId: 'S2OLD', paper: { paperId: 'S2OLD', title: 'Old matched title', year: 2024, authors: ['H. Kim'], url: 'https://www.semanticscholar.org/paper/S2OLD', citationCount: 3 }, items: [{ paperId: 'O1', title: 'Old recommendation', year: 2021, authors: ['A. Author', 'B. Writer'], url: 'https://www.semanticscholar.org/paper/O1', abstract: 'Old abstract.', citationCount: 5, venue: 'Old J' }], fetchedAt: Date.now() } });
  });
  await page.goto(`${BASE}/tests/features/harness.html?mock=1&tab=related&theme=dark`);
  await page.waitForSelector('.pf-related__item');
  const src = await page.textContent('.pf-related__source');
  const t = await page.textContent('.pf-related__item');
  await relatedShot(page, 'r07-legacy-dark');
  assert(src.includes('이전에 찾은 결과'), src);
  assert(t.includes('Old recommendation') && t.includes('Old J · 2021') && t.includes('인용 5회'), t);
  assert(!errors.length, errors.join('\n'));
  await context.close();
  return `legacy ai.related (no source) → "${src.trim()}"`;
});

await test('panel: real Europe PMC / NCBI text is rendered as text, never HTML', async () => {
  const { page, context } = await open({ tab: 'related', consent: true });
  await page.waitForSelector('.pf-related__item');
  const r = await page.evaluate(async () => {
    const { fromSummary } = await import('/js/features/pubmed.js');
    const p = fromSummary({ uid: '1', title: '<img src=x onerror="window.__xss=1">Bold <b>claim</b>.', authors: [{ name: '<script>x</script>', authtype: 'Author' }], pubdate: '2020', articleids: [] });
    return { title: p.title, author: p.authors[0] };
  });
  const injected = await page.evaluate(() => document.querySelectorAll('.pf-related img, .pf-related script, .pf-related b').length);
  assert(r.title === 'Bold claim' && !r.title.includes('<'), r.title);
  assert(injected === 0 && !(await page.evaluate(() => window.__xss)), 'no markup from API text');
  await context.close();
  return `"${r.title}" (tags stripped, rendered with textContent)`;
});

await test('panel: narrow window (900 px) — tools wrap, no horizontal overflow', async () => {
  const { page, context } = await open({ query: 'mock=1&reset=1&folder=1', tab: 'related', consent: true, viewport: { width: 900, height: 760 } });
  await page.waitForSelector('.pf-related__item');
  const overflow = await page.$eval('.pf-related .pf-panel__scroll', (e) => e.scrollWidth - e.clientWidth);
  await relatedShot(page, 'r10-narrow');
  assert(overflow <= 0, `horizontal overflow ${overflow}px`);
  await context.close();
  return 'no horizontal overflow at 900 px';
});

// ------------------------------------------------------------------------------------ citation card

await test('citation card: consent once, then DOI → Europe PMC; no-DOI entry → Crossref → Europe PMC; unknown → S2 → not found', async () => {
  const { page, context, errors, log } = await open();
  await page.hover('.sv-link[data-token="[1]"]');
  await page.waitForSelector('.pf-cite--ref');
  await sleep(300);
  assert(log.length === 0, 'no lookup before consent');
  await page.click('[data-action="ref-lookup"]');
  await page.waitForSelector('[data-action="scholar-consent"]');
  const consent = await page.textContent('.pf-cite__consent');
  await page.click('[data-action="scholar-consent"]');
  await page.waitForSelector('.pf-cite__paper');
  const card1 = await page.$eval('.pf-cite__paper', (p) => ({
    title: p.querySelector('.pf-cite__title').textContent, text: p.textContent,
    labels: [...p.querySelectorAll('.pf-cite__abs strong')].map((s) => s.textContent),
    links: [...p.querySelectorAll('.pf-linkbadge')].map((a) => [a.dataset.link, a.href]),
  }));
  const req1 = log.map((l) => `${l.host}:${l.params.query || l.params.term || l.path}`);
  await shot(page, 'r08-citation-doi');
  await page.mouse.move(5, 880);
  await sleep(500);
  // [2]: no DOI in the entry → Crossref; looked up automatically now that consent was given
  const n2 = log.length;
  await page.hover('.sv-link[data-token="[2]"]');
  await page.waitForSelector('.pf-cite__paper', { timeout: 8000 });
  const card2 = await page.$eval('.pf-cite__paper', (p) => ({ text: p.textContent, links: [...p.querySelectorAll('.pf-linkbadge')].map((a) => a.dataset.link) }));
  const req2 = log.slice(n2);
  const cr = req2.find((l) => l.host === 'crossref');
  await shot(page, 'r09-citation-crossref');
  const popBox = await page.$eval('.pf-pop--cite', (e) => e.getBoundingClientRect().toJSON());
  await page.screenshot({ path: `${OUT}/r09-citation-crossref-card.png`, clip: { x: Math.max(0, popBox.x - 8), y: Math.max(0, popBox.y - 8), width: popBox.width + 16, height: popBox.height + 16 } });
  // reopen [1] → cached, no request
  await page.mouse.move(5, 880);
  await sleep(500);
  const n3 = log.length;
  await page.hover('.sv-link[data-token="[1]"]');
  await page.waitForSelector('.pf-cite__paper');
  const cachedReqs = log.length - n3;
  assert(consent.includes('PubMed(미국 국립의학도서관)·Europe PMC·Crossref·Semantic Scholar'), consent);
  assert(card1.title.startsWith('Delirium as a predictor of mortality') && card1.text.includes('Ely EW') && card1.text.includes('JAMA · 2004') && card1.text.includes('인용 1999회'), card1.text.slice(0, 200));
  assert(card1.labels[0] === 'Context: ', card1.labels.join('|'));
  assert(card1.links.map((l) => l[0]).join() === 'pubmed,doi' && card1.links[1][1] === 'https://doi.org/10.1001/jama.291.14.1753', JSON.stringify(card1.links));
  assert(card1.text.includes('출처: Europe PMC'), 'source line');
  assert(req1.length === 1 && req1[0] === 'epmc:DOI:"10.1001/jama.291.14.1753"', req1.join());
  assert(cr && cr.params.rows === '3' && cr.params['query.bibliographic'].startsWith('[2] Schweickert WD') && !('mailto' in cr.params), JSON.stringify(cr?.params));
  assert(req2.map((l) => l.host).join() === 'crossref,epmc', req2.map((l) => l.host).join());
  assert(card2.text.includes('Early physical and occupational therapy') && card2.text.includes('인용 2112회') && card2.links.join() === 'free,pubmed,doi' && card2.text.includes('출처: Crossref → Europe PMC'), card2.text.slice(0, 300));
  assert(cachedReqs === 0, `cached (${cachedReqs})`);
  // [3] (not cited in the body text, so looked up directly): Crossref has nothing convincing →
  // Semantic Scholar (404 here) → null, shown as "찾지 못했습니다"
  const n4 = log.length;
  const ref3 = await page.evaluate(async () => {
    const { lookupReference } = await import('/js/features/scholarly.js');
    return lookupReference(__h.doc.references[2].text);
  });
  const req4 = log.slice(n4).map((l) => l.host);
  assert(ref3 === null && req4.join() === 'crossref,s2', `${JSON.stringify(ref3)} ${req4.join()}`);
  assert(!errors.length, errors.join('\n'));
  await context.close();
  return `[1] DOI → Europe PMC only (abstract, 인용 1999회); [2] Crossref (rows=3, no mailto) → Europe PMC (무료 전문); [1] again cached; [3] Crossref rejected → S2 → 찾지 못했습니다`;
});

await test('citation card: a lookup still running when the card closes is dropped (no queued requests)', async () => {
  const { page, context, log } = await open({ consent: true, mode: { crossrefDelayMs: 1200 } });
  // Hover [2] and leave immediately: the Crossref call may start, but the Europe PMC step must not follow.
  await page.hover('.sv-link[data-token="[2]"]');
  await page.waitForSelector('.pf-cite--ref');
  await page.mouse.move(5, 880);
  await sleep(2500);
  const hosts = log.map((l) => l.host);
  const cached = await page.evaluate(() => __h.session.refLookups.size);
  assert(!hosts.includes('epmc') && cached === 0, `${hosts.join()} / cached ${cached}`);
  await context.close();
  return `requests after closing: [${hosts.join(', ')}], nothing cached`;
});

await browser.close();
if (server) server.kill();
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} related-pubmed checks passed`);
process.exitCode = failed ? 1 : 0;
