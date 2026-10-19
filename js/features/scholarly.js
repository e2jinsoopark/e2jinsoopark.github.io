// Keyless paper lookups for the 관련 논문 panel and the reference card, PubMed first:
//   identify the open paper (DOI → PubMed, title → PubMed, then Europe PMC),
//   similar articles (PubMed ELink neighbours) with citation counts and free full text (Europe PMC),
//   folder-wide recommendations (neighbour scores summed over the folder's papers),
//   bibliography entry → printed DOI or Crossref DOI → Europe PMC / PubMed (abstract, citations),
//   and Semantic Scholar only when none of these found anything.
//
// Shared paper shape (ai.related items, reference card):
//   { pmid, doi, pmcid, title, authors: string[], journal, year, date /* sortable */, hasAbstract, abstract,
//     citationCount, citationSource?, freeUrl, url, source: 'pubmed'|'europepmc'|'crossref'|'s2', score?, paperId? }
import { safeStorage } from '../core/util.js';
import { crossrefMatch } from './crossref.js';
import { epmcBatch, epmcCore, epmcSearch, fromEpmc } from './europepmc.js';
import { doiUrl, efetchAbstract, esearch, esummary, isPmid, neighbors, pubmedUrl } from './pubmed.js';
import {
  matchPaper as s2MatchPaper, matchReference as s2MatchReference, normalizePaper, paperByDoi as s2PaperByDoi,
  recommendations as s2Recommendations,
} from './s2.js';
import { findDoi, sameDoi, significantWords, titleSimilarity } from './textmatch.js';

export { findDoi } from './textmatch.js';

// --- consent -------------------------------------------------------------------------------

/** Remembered once per browser: the user agreed that titles / references are looked up on these services. */
export const CONSENT_KEY = 'pr.features.scholarConsent.v1';
export const CONSENT_SERVICES = 'PubMed(미국 국립의학도서관)·Europe PMC·Crossref·Semantic Scholar';
export const CONSENT_TEXT = `논문 제목·DOI나 참고문헌 문구를 ${CONSENT_SERVICES}로 보내 관련 논문과 참고문헌 정보를 찾습니다. `
  + 'API 키는 필요 없습니다. 한 번 동의하면 이 브라우저에서는 다시 묻지 않습니다.';

export const hasConsent = () => safeStorage.get(CONSENT_KEY, false) === true;
export const grantConsent = () => safeStorage.set(CONSENT_KEY, true);

// --- identify the open paper ----------------------------------------------------------------

export const TITLE_MATCH = 0.85;
const DOI_TEXT_MATCH = 0.6;
const MAX_TITLE_WORDS = 10;

const yearOk = (want, got) => !want || !got || Math.abs(want - got) <= 1;

/** Europe PMC as a second chance only: if it is unreachable, carry on as "not found there". */
async function epmcSecondChance(query, signal) {
  try {
    return await epmcSearch(query, { resultType: 'lite', pageSize: 5, signal });
  } catch (err) {
    if (signal?.aborted) throw err;
    console.warn('[features] Europe PMC lookup failed', err);
    return [];
  }
}

/** DOI of the open paper: doc.meta / stored record first, else the first DOI printed on its first two pages. */
export function paperDoi(doc, paper) {
  const known = doc?.meta?.doi || paper?.doi;
  if (known) return { doi: String(known).trim(), fromText: false };
  const end = doc?.pages?.[1]?.textEnd ?? doc?.pages?.[0]?.textEnd ?? 20000;
  const doi = findDoi(String(doc?.text ?? '').slice(0, Math.min(end, 40000)));
  return doi ? { doi, fromText: true } : { doi: null, fromText: false };
}

function best(records, title, year) {
  let top = null;
  let topSim = 0;
  for (const rec of records) {
    const sim = titleSimilarity(title, rec.title);
    if (sim >= TITLE_MATCH && sim > topSim && yearOk(year, rec.year)) { top = rec; topSim = sim; }
  }
  return top;
}

async function byTitle(title, year, signal) {
  const words = significantWords(title, MAX_TITLE_WORDS);
  if (words.length >= 2) {
    const term = (ws) => ws.map((w) => `${w}[ti]`).join(' AND ');
    let ids = await esearch(term(words), { retmax: 5, signal });
    if (!ids.length && words.length > 6) ids = await esearch(term(words.slice(0, 6)), { retmax: 5, signal });
    if (ids.length) {
      const hit = best([...(await esummary(ids, { signal })).values()], title, year);
      if (hit) return { ...hit, via: 'title' };
    }
  }
  // Second chance: Europe PMC's title phrase search (also lists PubMed records).
  const phrase = String(title).replace(/["\\]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 250);
  if (phrase.length < 12) return null;
  const list = (await epmcSecondChance(`TITLE:"${phrase}"`, signal)).map(fromEpmc);
  const hit = best(list.filter((r) => r.pmid), title, year);
  return hit ? { ...hit, via: 'title' } : null;
}

async function byDoi(doi, signal) {
  const ids = await esearch(`"${doi.replace(/"/g, '')}"[doi]`, { retmax: 2, signal });
  if (ids.length) {
    const recs = await esummary(ids, { signal });
    const hit = [...recs.values()].find((r) => sameDoi(r.doi, doi)) || (ids.length === 1 && !recs.get(ids[0])?.doi ? recs.get(ids[0]) : null);
    if (hit) return hit;
  }
  const [r] = (await epmcSecondChance(`DOI:"${doi.replace(/"/g, '')}"`, signal))
    .filter((x) => x.pmid && sameDoi(x.doi, doi));
  return r ? fromEpmc(r) : null;
}

/**
 * Find the open paper in PubMed. `query` (typed by the user) may be a PMID, a DOI or a title.
 * @returns {Promise<object|null>} paper (shared shape) with `via: 'pmid'|'doi'|'title'`, or null
 */
export async function identifyPaper({ title = '', year = null, doi = null, doiFromText = false, pmid = null, query = null } = {}, { signal } = {}) {
  if (query != null) {
    const q = String(query).trim();
    if (isPmid(q)) pmid = q;
    else if (findDoi(q)) { doi = findDoi(q); doiFromText = false; }
    else { title = q; doi = null; year = null; }
  }
  if (pmid) {
    const rec = (await esummary([pmid], { signal })).get(String(pmid));
    return rec ? { ...rec, via: 'pmid' } : null;
  }
  let doubtful = null;
  if (doi) {
    const hit = await byDoi(doi, signal);
    // A DOI printed on page 1 may belong to a cited paper: prefer it only if the titles agree, else try the
    // title first and fall back to the DOI (the extracted title itself may be wrong; 기준 논문 shows the match).
    if (hit && (!doiFromText || !title || titleSimilarity(title, hit.title) >= DOI_TEXT_MATCH)) return { ...hit, via: 'doi' };
    doubtful = hit;
  }
  const found = title ? await byTitle(title, year, signal) : null;
  return found || (doubtful ? { ...doubtful, via: 'doi' } : null);
}

// --- related papers ---------------------------------------------------------------------------

export const RELATED_LIMIT = 20;
const FOLDER_TOP_PER_SOURCE = 100;

/** Add Europe PMC citation counts and free full-text links to papers (best effort: failures leave them as is). */
export async function enrichWithEpmc(papers, { signal } = {}) {
  if (!papers.length) return { papers, ok: true };
  try {
    const { byPmid, byDoi } = await epmcBatch({ pmids: papers.map((p) => p.pmid).filter(Boolean), dois: papers.filter((p) => !p.pmid && p.doi).map((p) => p.doi) }, { signal });
    return {
      ok: true,
      papers: papers.map((p) => {
        const e = (p.pmid && byPmid.get(p.pmid)) || (p.doi && byDoi.get(p.doi.toLowerCase())) || null;
        if (!e) return p;
        const counted = e.citationCount != null;
        return {
          ...p,
          citationCount: counted ? e.citationCount : p.citationCount,
          citationSource: counted ? 'Europe PMC' : p.citationSource,
          freeUrl: e.freeUrl || p.freeUrl,
          pmcid: p.pmcid || e.pmcid,
          doi: p.doi || e.doi,
        };
      }),
    };
  } catch (err) {
    if (signal?.aborted) throw err;
    console.warn('[features] Europe PMC enrichment failed', err);
    return { papers, ok: false };
  }
}

async function summarise(ranked, signal) {
  const recs = await esummary(ranked.map((r) => r.pmid), { signal });
  return ranked.map((r) => (recs.get(r.pmid) ? { ...recs.get(r.pmid), score: r.score, ...(r.folderHits ? { folderHits: r.folderHits } : {}) } : null)).filter(Boolean);
}

/**
 * PubMed similar articles of one PMID (top 20 by neighbour score), with Europe PMC counts. `self` (the
 * matched paper) is enriched in the same Europe PMC query.
 */
export async function relatedForPmid(pmid, { signal, limit = RELATED_LIMIT, self = null } = {}) {
  const links = (await neighbors([pmid], { signal })).get(String(pmid)) || [];
  const items = await summarise(links.slice(0, limit), signal);
  const { papers, ok } = await enrichWithEpmc(self ? [self, ...items] : items, { signal });
  return { items: self ? papers.slice(1) : papers, self: self ? papers[0] : null, citations: ok };
}

/**
 * Recommendations for a set of PMIDs (a folder): each source's neighbour scores are scaled to its best
 * neighbour (= 1) and summed; papers already in the set are left out.
 */
export function aggregateNeighbors(linkMap, exclude = []) {
  const skip = new Set([...exclude, ...linkMap.keys()].map(String));
  const total = new Map();
  for (const links of linkMap.values()) {
    const top = links[0]?.score || 1;
    for (const l of links.slice(0, FOLDER_TOP_PER_SOURCE)) {
      if (skip.has(l.pmid)) continue;
      const t = total.get(l.pmid) || { pmid: l.pmid, score: 0, folderHits: 0 };
      t.score += l.score / top;
      t.folderHits += 1;
      total.set(l.pmid, t);
    }
  }
  return [...total.values()].sort((a, b) => b.score - a.score || b.folderHits - a.folderHits);
}

export async function relatedForPmids(pmids, { signal, limit = RELATED_LIMIT } = {}) {
  const linkMap = await neighbors(pmids, { signal });
  const ranked = aggregateNeighbors(linkMap).slice(0, limit).map((r) => ({ pmid: r.pmid, score: Math.round(r.score * 1000) / 1000, folderHits: r.folderHits }));
  const items = await summarise(ranked, signal);
  const { papers, ok } = await enrichWithEpmc(items, { signal });
  return { items: papers, citations: ok };
}

/** Semantic Scholar fallback when PubMed / Europe PMC do not know the paper. */
export async function s2Related({ title, pmid = null, apiKey = '', signal } = {}) {
  let matched = null;
  let id = pmid ? `PMID:${pmid}` : null;
  if (!id) {
    matched = title ? await s2MatchPaper(title, { apiKey, signal }) : null;
    if (!matched) return null;
    id = matched.paperId;
  }
  const items = await s2Recommendations(id, { apiKey, signal });
  return { s2PaperId: matched?.paperId ?? null, paper: matched ? fromS2(matched) : null, items: items.map(fromS2) };
}

/** Semantic Scholar paper (s2.normalizePaper shape or raw) → the shared shape. */
export function fromS2(p) {
  // Raw API objects carry authors as { name }; s2.normalizePaper() output carries plain names.
  const n = typeof p?.authors?.[0] === 'object' ? normalizePaper(p) : { ...normalizePaper(p), authors: Array.isArray(p?.authors) ? p.authors.map(String) : [] };
  const pmid = n.externalIds?.PubMed ? String(n.externalIds.PubMed) : null;
  const doi = n.externalIds?.DOI ? String(n.externalIds.DOI) : null;
  return {
    paperId: n.paperId, pmid, doi, pmcid: null, title: n.title, authors: n.authors, journal: n.venue || '', year: n.year,
    date: n.year ? String(n.year) : '', hasAbstract: Boolean(n.abstract), abstract: n.abstract || '', citationCount: n.citationCount,
    citationSource: 'Semantic Scholar', freeUrl: null, url: n.url, source: 's2',
  };
}

/** Abstract for a paper: Europe PMC (core) first, then PubMed EFetch. '' when there is none. */
export async function fetchAbstract(p, { signal } = {}) {
  if (p?.abstract) return p.abstract;
  let text = '';
  try {
    text = (await epmcCore({ pmid: p?.pmid, doi: p?.doi }, { signal }))?.abstract || '';
  } catch (err) {
    if (signal?.aborted || !p?.pmid) throw err;
    console.warn('[features] Europe PMC abstract failed, trying PubMed', err);
  }
  if (!text && p?.pmid) text = await efetchAbstract(p.pmid, { signal });
  return text;
}

// --- bibliography entries ----------------------------------------------------------------------

/** A paper with abstract and citation count for a DOI: Europe PMC, else PubMed. Null if neither has it. */
export async function paperByDoi(doi, { signal } = {}) {
  const e = await epmcCore({ doi }, { signal });
  if (e) return { ...e, sources: ['Europe PMC'] };
  const ids = await esearch(`"${doi.replace(/"/g, '')}"[doi]`, { retmax: 2, signal });
  const rec = ids.length ? [...(await esummary(ids, { signal })).values()].find((r) => sameDoi(r.doi, doi)) : null;
  if (!rec) return null;
  const abstract = rec.hasAbstract === false ? '' : await efetchAbstract(rec.pmid, { signal }).catch((err) => {
    if (signal?.aborted) throw err;
    return '';
  });
  return { ...rec, abstract, sources: ['PubMed'] };
}

/** A Semantic Scholar fallback call whose failure (429, network) means "not found there". */
async function s2Quietly(call, signal) {
  try {
    return await call();
  } catch (err) {
    if (signal?.aborted) throw err;
    console.warn('[features] Semantic Scholar fallback failed', err);
    return null;
  }
}

/**
 * Metadata for a bibliography entry:
 *   1. a DOI printed in the entry → Europe PMC / PubMed; if neither knows it, Semantic Scholar by that exact
 *      DOI (journals PubMed does not index);
 *   2. otherwise — no DOI, or one nobody knows because the PDF cut it at a line break ("…2021. 02.016") —
 *      Crossref (query.bibliographic on the whole entry) → Europe PMC / PubMed, else Crossref's own record;
 *   3. Semantic Scholar's title match only if nothing matched.
 * @returns {Promise<object|null>} paper (shared shape) with `sources: string[]`, or null
 */
export async function lookupReference(refText, { signal, s2ApiKey = '' } = {}) {
  const s2opts = { apiKey: s2ApiKey, signal };
  const textDoi = findDoi(refText);
  if (textDoi) {
    const found = await paperByDoi(textDoi, { signal });
    if (found) return found;
    const s2 = await s2Quietly(() => s2PaperByDoi(textDoi, s2opts), signal);
    if (s2) return { ...fromS2(s2), sources: ['Semantic Scholar'] };
  }
  const cr = await crossrefMatch(refText, { signal });
  if (cr) {
    const found = sameDoi(cr.doi, textDoi) ? null : await paperByDoi(cr.doi, { signal });
    return found ? { ...found, sources: ['Crossref', ...found.sources] } : { ...cr, sources: ['Crossref'] };
  }
  const s2 = await s2Quietly(() => s2MatchReference(refText, s2opts), signal);
  return s2 ? { ...fromS2(s2), sources: ['Semantic Scholar'] } : null;
}

/** Links for a paper card: 무료 전문, PubMed, DOI (and Semantic Scholar for its own results). */
export function paperLinks(p) {
  const links = [];
  if (p?.freeUrl) links.push({ kind: 'free', label: '무료 전문', href: p.freeUrl });
  if (p?.pmid) links.push({ kind: 'pubmed', label: 'PubMed', href: pubmedUrl(p.pmid) });
  if (p?.doi) links.push({ kind: 'doi', label: 'DOI', href: doiUrl(p.doi) });
  if (p?.source === 's2' && p.url) links.push({ kind: 's2', label: 'Semantic Scholar', href: p.url });
  return links;
}

/** Primary link for a title: PubMed, else DOI, else the source's own page. */
export const primaryUrl = (p) => (p?.pmid ? pubmedUrl(p.pmid) : p?.doi ? doiUrl(p.doi) : p?.url || null);
