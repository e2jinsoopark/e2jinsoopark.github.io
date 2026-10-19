// PubMed E-utilities (keyless): ESearch, ESummary, ELink neighbours (PubMed's own "similar articles"),
// EFetch abstracts. Requests carry tool=galpi and no e-mail; scholarly-net.js keeps them ≤ 3 per second.
import { buildUrl, scholarlyGet, ScholarlyError } from './scholarly-net.js';
import { plainText, yearOf } from './textmatch.js';

const EUTILS = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/';
const TOOL = 'galpi';

export const pubmedUrl = (pmid) => `https://pubmed.ncbi.nlm.nih.gov/${encodeURIComponent(pmid)}/`;
export const pmcUrl = (pmcid) => `https://pmc.ncbi.nlm.nih.gov/articles/${encodeURIComponent(pmcid)}/`;
export const doiUrl = (doi) => `https://doi.org/${String(doi).trim().split('/').map(encodeURIComponent).join('/')}`;
export const isPmid = (v) => /^\d{1,9}$/.test(String(v ?? '').trim());

function eutils(endpoint, params) {
  return buildUrl(`${EUTILS}${endpoint}.fcgi`, { db: 'pubmed', ...params, tool: TOOL });
}

/** NCBI sometimes answers 200 with { error } (e.g. a rate-limit note); treat that as a failure. */
function checkBody(data) {
  const msg = data?.error || data?.esearchresult?.ERROR;
  if (!msg) return data;
  if (/rate limit/i.test(String(msg))) throw new ScholarlyError('PubMed가 잠시 바쁩니다. 잠시 후 다시 시도해 주세요.', { status: 429, service: 'pubmed', code: 'rate' });
  throw new ScholarlyError('PubMed 요청에 실패했습니다.', { service: 'pubmed' });
}

/** @returns {Promise<string[]>} PMIDs for a PubMed query, in PubMed's order. */
export async function esearch(term, { retmax = 5, signal } = {}) {
  const data = checkBody(await scholarlyGet('pubmed', eutils('esearch', { term, retmode: 'json', retmax }), { signal }));
  const ids = data?.esearchresult?.idlist;
  return Array.isArray(ids) ? ids.map(String) : [];
}

/** A PubMed ESummary record → the shared paper shape (see scholarly.js). */
export function fromSummary(rec) {
  const ids = Array.isArray(rec?.articleids) ? rec.articleids : [];
  const idOf = (type) => ids.find((a) => a?.idtype === type)?.value ?? null;
  const doi = idOf('doi');
  let pmcid = idOf('pmc');
  // "pmc-id: PMC123;embargo-date: 2027/01/01;" — not free to read before the embargo ends.
  const embargo = String(idOf('pmcid') ?? '').match(/embargo-date:\s*(\d{4})\/(\d{2})\/(\d{2})/);
  if (embargo && Date.parse(`${embargo[1]}-${embargo[2]}-${embargo[3]}`) > Date.now()) pmcid = null;
  const pmid = String(rec?.uid ?? '');
  const date = String(rec?.sortpubdate ?? '').slice(0, 10) || String(rec?.pubdate ?? '');
  return {
    pmid,
    doi: doi || null,
    pmcid: pmcid || null,
    title: plainText(rec?.title).replace(/\.$/, ''),
    authors: (Array.isArray(rec?.authors) ? rec.authors : [])
      .filter((a) => !a?.authtype || a.authtype === 'Author').map((a) => String(a?.name ?? '').trim()).filter(Boolean),
    journal: String(rec?.source || rec?.fulljournalname || '').trim(),
    year: yearOf(rec?.pubdate) ?? yearOf(rec?.sortpubdate),
    date,
    hasAbstract: Array.isArray(rec?.attributes) ? rec.attributes.includes('Has Abstract') : null,
    citationCount: null,
    abstract: '',
    freeUrl: pmcid ? pmcUrl(pmcid) : null,
    url: pmid ? pubmedUrl(pmid) : null,
    source: 'pubmed',
  };
}

/** @returns {Promise<Map<string, object>>} pmid → paper (records PubMed could not summarise are left out). */
export async function esummary(pmids, { signal } = {}) {
  const list = [...new Set((pmids || []).map(String).filter(isPmid))];
  const out = new Map();
  if (!list.length) return out;
  const data = checkBody(await scholarlyGet('pubmed', eutils('esummary', { id: list.join(','), retmode: 'json' }), { signal }));
  const result = data?.result || {};
  for (const uid of list) {
    const rec = result[uid];
    if (rec && !rec.error && rec.uid) out.set(uid, fromSummary(rec));
  }
  return out;
}

/**
 * PubMed similar articles (ELink cmd=neighbor_score, pubmed_pubmed) for each PMID, in one request
 * (one `id` parameter per PMID keeps one linkset per source).
 * @returns {Promise<Map<string, { pmid: string, score: number }[]>>} source pmid → neighbours, best first, self excluded
 */
export async function neighbors(pmids, { signal, timeoutMs } = {}) {
  const list = [...new Set((pmids || []).map(String).filter(isPmid))];
  const out = new Map();
  if (!list.length) return out;
  const url = eutils('elink', { dbfrom: 'pubmed', cmd: 'neighbor_score', linkname: 'pubmed_pubmed', id: list, retmode: 'json' });
  const data = checkBody(await scholarlyGet('pubmed', url, { signal, timeoutMs: timeoutMs ?? (list.length > 1 ? 30000 : 20000) }));
  for (const set of data?.linksets || []) {
    const src = String(set?.ids?.[0] ?? '');
    if (!src) continue;
    const db = (set.linksetdbs || []).find((d) => d?.linkname === 'pubmed_pubmed');
    const links = (db?.links || [])
      .map((l) => (typeof l === 'object' ? { pmid: String(l.id), score: Number(l.score) || 0 } : { pmid: String(l), score: 0 }))
      .filter((l) => l.pmid && l.pmid !== src);
    links.sort((a, b) => b.score - a.score);
    out.set(src, links);
  }
  for (const id of list) if (!out.has(id)) out.set(id, []);
  return out;
}

/** Abstract text of one PubMed record via EFetch (XML), "Label: text" per structured section; '' if none. */
export async function efetchAbstract(pmid, { signal } = {}) {
  if (!isPmid(pmid)) return '';
  const xml = await scholarlyGet('pubmed', eutils('efetch', { id: pmid, rettype: 'abstract', retmode: 'xml' }), { signal, as: 'text' });
  return xml ? abstractFromPubmedXml(xml) : '';
}

export function abstractFromPubmedXml(xml) {
  let docXml;
  try {
    docXml = new DOMParser().parseFromString(String(xml), 'text/xml');
  } catch { return ''; }
  if (docXml.querySelector('parsererror')) return '';
  const parts = [...docXml.querySelectorAll('Abstract > AbstractText')].map((n) => {
    const text = n.textContent.replace(/\s+/g, ' ').trim();
    let label = (n.getAttribute('Label') || '').trim();
    if (label && label === label.toUpperCase()) label = label.charAt(0) + label.slice(1).toLowerCase(); // CONTEXT → Context
    return text ? (label ? `${label}: ${text}` : text) : '';
  }).filter(Boolean);
  return parts.join('\n');
}
