// Europe PMC REST search (keyless): citation counts, open-access / free full-text links and abstracts for
// PubMed records, in one batched query for a list of PMIDs or DOIs.
import { doiUrl, pmcUrl, pubmedUrl } from './pubmed.js';
import { buildUrl, scholarlyGet } from './scholarly-net.js';
import { plainText, sameDoi, yearOf } from './textmatch.js';

const SEARCH = 'https://www.ebi.ac.uk/europepmc/webservices/rest/search';

export async function epmcSearch(query, { resultType = 'lite', pageSize = 25, signal } = {}) {
  const data = await scholarlyGet('europepmc', buildUrl(SEARCH, { query, format: 'json', resultType, pageSize }), { signal });
  const list = data?.resultList?.result;
  return Array.isArray(list) ? list : [];
}

const quoteDoi = (doi) => `"${String(doi).replace(/"/g, '')}"`;

/** Free-to-read full text: an OA / free link in fullTextUrlList (core), else a PMC copy that is live. */
export function freeFullTextUrl(r) {
  const links = r?.fullTextUrlList?.fullTextUrl;
  if (Array.isArray(links)) {
    const rank = (u) => (u.site === 'PubMedCentral' ? 0 : u.site === 'Europe_PMC' ? 1 : 2);
    const free = links.filter((u) => (u?.availabilityCode === 'OA' || u?.availabilityCode === 'F') && typeof u.url === 'string')
      .sort((a, b) => rank(a) - rank(b) || (a.documentStyle === 'html' ? -1 : 1));
    if (free.length) return free[0].url;
  }
  if (r?.pmcid && (r.inPMC === 'Y' || r.inEPMC === 'Y' || r.isOpenAccess === 'Y')) return pmcUrl(r.pmcid);
  return null;
}

/** A Europe PMC result (lite or core) → the shared paper shape. */
export function fromEpmc(r) {
  const pmid = r?.pmid ? String(r.pmid) : null;
  const authors = Array.isArray(r?.authorList?.author)
    ? r.authorList.author.map((a) => String(a?.fullName || a?.collectiveName || '').trim()).filter(Boolean)
    : String(r?.authorString ?? '').replace(/\.$/, '').split(/,\s*/).map((s) => s.trim()).filter(Boolean);
  const j = r?.journalInfo?.journal;
  const doi = r?.doi ? String(r.doi) : null;
  const cited = Number(r?.citedByCount);
  return {
    pmid,
    doi,
    pmcid: r?.pmcid ? String(r.pmcid) : null,
    title: plainText(r?.title).replace(/\.$/, ''),
    authors,
    journal: String(j?.isoabbreviation || j?.medlineAbbreviation || r?.journalTitle || j?.title || r?.bookOrReportDetails?.publisher || '').trim(),
    year: yearOf(r?.pubYear) ?? yearOf(r?.firstPublicationDate),
    date: String(r?.firstPublicationDate ?? '').replace(/-/g, '/'),
    hasAbstract: typeof r?.abstractText === 'string' ? Boolean(r.abstractText.trim()) : null,
    citationCount: r?.citedByCount != null && r.citedByCount !== '' && Number.isFinite(cited) ? cited : null,
    citationSource: 'Europe PMC',
    abstract: typeof r?.abstractText === 'string' ? plainText(r.abstractText) : '',
    freeUrl: freeFullTextUrl(r),
    url: pmid ? pubmedUrl(pmid) : doi ? doiUrl(doi) : (r?.source && r?.id ? `https://europepmc.org/article/${encodeURIComponent(r.source)}/${encodeURIComponent(r.id)}` : null),
    source: 'europepmc',
  };
}

/**
 * Europe PMC facts for many papers in one query.
 * @param {{ pmids?: string[], dois?: string[] }} ids
 * @returns {Promise<{ byPmid: Map<string, object>, byDoi: Map<string, object> }>} (DOI keys lower-cased)
 */
export async function epmcBatch({ pmids = [], dois = [] }, { signal } = {}) {
  const p = [...new Set(pmids.map(String).filter(Boolean))];
  const d = [...new Set(dois.map((x) => String(x).toLowerCase()).filter(Boolean))];
  const byPmid = new Map();
  const byDoi = new Map();
  if (!p.length && !d.length) return { byPmid, byDoi };
  const clauses = [];
  if (p.length) clauses.push(`(${p.map((id) => `EXT_ID:${id}`).join(' OR ')}) AND SRC:MED`);
  if (d.length) clauses.push(`(${d.map((x) => `DOI:${quoteDoi(x)}`).join(' OR ')})`);
  const query = clauses.length > 1 ? clauses.map((c) => `(${c})`).join(' OR ') : clauses[0];
  const list = await epmcSearch(query, { resultType: 'lite', pageSize: Math.min(100, p.length + d.length + 5), signal });
  for (const r of list) {
    const info = fromEpmc(r);
    if (info.pmid && !byPmid.has(info.pmid)) byPmid.set(info.pmid, info);
    if (info.doi && !byDoi.has(info.doi.toLowerCase())) byDoi.set(info.doi.toLowerCase(), info);
  }
  return { byPmid, byDoi };
}

/**
 * One record with its abstract (resultType=core) by PMID, else by DOI; null when Europe PMC has none.
 * (Europe PMC holds every PubMed record, so a PMID it lacks is not looked up again by DOI.)
 */
export async function epmcCore({ pmid, doi } = {}, { signal } = {}) {
  let r = null;
  if (pmid) [r] = await epmcSearch(`EXT_ID:${pmid} AND SRC:MED`, { resultType: 'core', pageSize: 1, signal });
  else if (doi) {
    const list = await epmcSearch(`DOI:${quoteDoi(doi)}`, { resultType: 'core', pageSize: 3, signal });
    r = list.find((x) => sameDoi(x.doi, doi) && x.source === 'MED') || list.find((x) => sameDoi(x.doi, doi)) || null;
  }
  return r ? fromEpmc(r) : null;
}
