// Canned PubMed E-utilities / Europe PMC / Crossref / Semantic Scholar answers for Playwright
// (page.route), built from real responses fetched with curl (tests/features/fixtures/scholarly/,
// keyless, 2026-10-19). Nothing leaves the machine.
//
// The harness paper ("Early Mobilization and Delirium … A Nurse-Led Protocol", invented) is given the
// synthetic PMID 39990001: its ESummary record is a real record re-labelled, and its neighbours are the
// real neighbours of PMID 15082703 (Ely 2004 JAMA, the harness's reference [1]).
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures/scholarly');
const load = (f) => JSON.parse(readFileSync(resolve(DIR, f), 'utf8'));
const text = (f) => readFileSync(resolve(DIR, f), 'utf8');

export const HARNESS_PMID = '39990001';
export const HARNESS_TITLE = 'Early Mobilization and Delirium in Mechanically Ventilated Adults: A Nurse-Led Protocol';

export const FX = {
  esearchDoi: load('esearch-doi.json'),
  esearchNone: load('esearch-none.json'),
  summaries: load('esummary-records.json'),
  elink: { '15082703': load('elink-15082703.json'), '19446324': load('elink-19446324.json') },
  lite: load('epmc-lite-records.json'),
  core: {
    '15082703': load('epmc-core-15082703.json'),
    '36205994': load('epmc-core-36205994.json'),
    '19446324': load('epmc-core-19446324.json'),
  },
  efetch: { '15082703': text('efetch-15082703.xml') },
  crossref: { ref1: load('crossref-ref1.json'), ref2: load('crossref-ref2.json'), ref3: load('crossref-ref3.json') },
  /** 48 real query.bibliographic answers (lu2025 + kiekkas2012 references) with the expected pick. */
  crossrefCalibration: load('crossref-calibration.json'),
  ncbi429: load('ncbi-429.json'),
};

// Synthetic record for the harness paper, in ESummary's real shape.
FX.summaries[HARNESS_PMID] = {
  ...structuredClone(FX.summaries['15082703']),
  uid: HARNESS_PMID, title: `${HARNESS_TITLE}.`, sorttitle: HARNESS_TITLE.toLowerCase(), pubdate: '2024 Mar', sortpubdate: '2024/03/01 00:00',
  source: 'J Crit Care Nurs', fulljournalname: 'Journal of critical care nursing (synthetic)',
  authors: [{ name: 'Kim H', authtype: 'Author', clusterid: '' }, { name: 'Lee J', authtype: 'Author', clusterid: '' }, { name: 'Park S', authtype: 'Author', clusterid: '' }],
  articleids: [{ idtype: 'pubmed', idtypen: 1, value: HARNESS_PMID }, { idtype: 'doi', idtypen: 3, value: '10.0000/synthetic.2024.001' }],
};

function esearchResult(ids, term) {
  return { header: { type: 'esearch', version: '0.3' }, esearchresult: { count: String(ids.length), retmax: String(ids.length), retstart: '0', idlist: ids, translationset: [], querytranslation: term } };
}

function esummaryResult(ids) {
  const result = { uids: [] };
  for (const id of ids) {
    if (FX.summaries[id]) { result.uids.push(id); result[id] = FX.summaries[id]; }
  }
  return { header: { type: 'esummary', version: '0.3' }, result };
}

function elinkResult(ids) {
  const linksets = ids.map((id) => {
    const src = id === HARNESS_PMID ? FX.elink['15082703'] : FX.elink[id];
    if (!src) return { dbfrom: 'pubmed', ids: [id] };
    const set = structuredClone(src.linksets[0]);
    set.ids = [id];
    return set;
  });
  return { header: { type: 'elink', version: '0.3' }, linksets };
}

function epmcResult(results, query, resultType) {
  return {
    version: '6.9', hitCount: results.length, nextCursorMark: 'AoE=', request: { queryString: query, resultType, cursorMark: '*', pageSize: 25, sort: '', synonym: false },
    resultList: { result: results },
  };
}

function epmcAnswer(query, resultType) {
  const pmids = [...query.matchAll(/EXT_ID:(\d+)/g)].map((m) => m[1]);
  const dois = [...query.matchAll(/DOI:"([^"]+)"/g)].map((m) => m[1].toLowerCase());
  const byDoi = (doi) => Object.values(FX.lite).find((r) => String(r.doi).toLowerCase() === doi);
  if (resultType === 'core') {
    const id = pmids[0] || byDoi(dois[0] || '')?.pmid || (dois[0] === '10.1001/jama.291.14.1753' ? '15082703' : null);
    const core = id && FX.core[id];
    return core ? structuredClone(core) : epmcResult([], query, 'core');
  }
  const out = [];
  for (const id of pmids) if (FX.lite[id]) out.push(FX.lite[id]);
  for (const d of dois) { const r = byDoi(d); if (r && !out.includes(r)) out.push(r); }
  return epmcResult(out, query, 'lite');
}

function esearchAnswer(term) {
  const t = term.toLowerCase();
  if (t.includes('[doi]')) {
    if (t.includes('10.1001/jama.291.14.1753')) return FX.esearchDoi;
    if (t.includes('10.1016/s0140-6736(09)60658-9')) return esearchResult(['19446324'], term);
    return FX.esearchNone;
  }
  if (t.includes('[ti]')) {
    // The real index has a decoy-looking hit next to the right one: the client must check titles.
    if (t.includes('mobilization[ti]') && t.includes('nurse[ti]')) return esearchResult(['15082703', HARNESS_PMID], term);
    if (t.includes('delirium[ti]') && t.includes('predictor[ti]')) return esearchResult(['15082703'], term);
  }
  return FX.esearchNone;
}

const crossrefList = (items) => ({ status: 'ok', 'message-type': 'work-list', 'message-version': '1.0.0', message: { facets: {}, 'total-results': items.length, items, 'items-per-page': 3, query: { 'start-index': 0, 'search-terms': null } } });

function crossrefAnswer(q) {
  if (/Ely EW/.test(q)) return FX.crossref.ref1;
  if (/Schweickert/.test(q)) return FX.crossref.ref2;
  if (/Park J, Kim S/.test(q)) return FX.crossref.ref3;
  // A calibration entry, with or without the DOI the PDF printed at its end.
  const entry = FX.crossrefCalibration.cases.find((c) => q.startsWith(c.text.replace(/\.$/, '').slice(0, 120)));
  return crossrefList(entry ? entry.items : []);
}

/**
 * Route every scholarly API for `page` (or a BrowserContext).
 * @param {{ log?: object[], mode?: { ncbi429?: 'always'|'once', ncbi429NoCors?: 'always'|'once', epmcDown?: boolean, noNeighbors?: boolean, ncbiDelayMs?: number, crossrefDelayMs?: number } }} [opts]
 *   log receives { host, path, params, t } for every request (t = Date.now() on arrival).
 *   ncbi429NoCors answers 429 the way NCBI really does (2026-10-19): Retry-After but no
 *   Access-Control-Allow-Origin, so the page only sees a failed fetch. (route.fulfill adds the page's
 *   origin when the header is missing — playwright#12929 — so a foreign origin stands in for "none".)
 */
export async function routeScholarly(page, { log = [], mode = {} } = {}) {
  let ncbi429Left = mode.ncbi429 === 'once' ? 1 : mode.ncbi429 === 'always' ? Infinity : 0;
  let ncbiNoCorsLeft = mode.ncbi429NoCors === 'once' ? 1 : mode.ncbi429NoCors === 'always' ? Infinity : 0;
  const cors = { 'access-control-allow-origin': '*' };
  // A request the page aborted meanwhile cannot be fulfilled any more: ignore that.
  const json = (route, status, body, extra = {}) => route.fulfill({ status, contentType: 'application/json; charset=UTF-8', headers: { ...cors, ...extra }, body: JSON.stringify(body) }).catch(() => {});

  await page.route('https://eutils.ncbi.nlm.nih.gov/**', async (route) => {
    const url = new URL(route.request().url());
    const params = Object.fromEntries(url.searchParams);
    const ids = url.searchParams.getAll('id').flatMap((v) => v.split(','));
    log.push({ host: 'ncbi', path: url.pathname.split('/').pop(), params, ids, t: Date.now() });
    if (mode.ncbiDelayMs) await new Promise((r) => setTimeout(r, mode.ncbiDelayMs));
    if (ncbi429Left > 0) {
      ncbi429Left -= 1;
      return json(route, 429, FX.ncbi429, { 'x-ratelimit-limit': '3', 'x-ratelimit-remaining': '0' });
    }
    if (ncbiNoCorsLeft > 0) {
      ncbiNoCorsLeft -= 1;
      return route.fulfill({
        status: 429, contentType: 'application/json; charset=UTF-8', body: JSON.stringify(FX.ncbi429),
        headers: { 'retry-after': '2', 'access-control-expose-headers': 'X-RateLimit-Limit,X-RateLimit-Remaining,Retry-After', 'access-control-allow-origin': 'https://not-this-page.invalid' },
      }).catch(() => {});
    }
    const ep = url.pathname.split('/').pop();
    if (ep === 'esearch.fcgi') return json(route, 200, esearchAnswer(params.term || ''));
    if (ep === 'esummary.fcgi') return json(route, 200, esummaryResult(ids));
    if (ep === 'elink.fcgi') return json(route, 200, mode.noNeighbors ? { header: { type: 'elink', version: '0.3' }, linksets: ids.map((id) => ({ dbfrom: 'pubmed', ids: [id] })) } : elinkResult(ids));
    if (ep === 'efetch.fcgi') {
      const body = FX.efetch[ids[0]] ?? '<?xml version="1.0" ?>\n<PubmedArticleSet></PubmedArticleSet>\n';
      return route.fulfill({ status: 200, contentType: 'text/xml; charset=UTF-8', headers: cors, body }).catch(() => {});
    }
    return json(route, 400, { error: 'unknown endpoint' });
  });

  await page.route('https://www.ebi.ac.uk/europepmc/**', async (route) => {
    const url = new URL(route.request().url());
    const params = Object.fromEntries(url.searchParams);
    log.push({ host: 'epmc', path: url.pathname, params, t: Date.now() });
    if (mode.epmcDown) return json(route, 500, { error: 'down' });
    return json(route, 200, epmcAnswer(params.query || '', params.resultType || 'lite'));
  });

  await page.route('https://api.crossref.org/**', async (route) => {
    const url = new URL(route.request().url());
    const params = Object.fromEntries(url.searchParams);
    log.push({ host: 'crossref', path: url.pathname, params, t: Date.now() });
    if (mode.crossrefDelayMs) await new Promise((r) => setTimeout(r, mode.crossrefDelayMs));
    return json(route, 200, crossrefAnswer(params['query.bibliographic'] || ''), { 'x-rate-limit-limit': '1', 'x-rate-limit-interval': '1s', 'x-api-pool': 'public-array' });
  });
}

/** Max number of `host` requests that arrived within any `windowMs` window. */
export function maxInWindow(log, host, windowMs = 1000) {
  const ts = log.filter((l) => l.host === host).map((l) => l.t).sort((a, b) => a - b);
  let best = 0;
  for (let i = 0, j = 0; i < ts.length; i++) {
    while (ts[i] - ts[j] >= windowMs) j++;
    best = Math.max(best, i - j + 1);
  }
  return best;
}
