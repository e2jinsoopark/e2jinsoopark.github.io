// Minimal Semantic Scholar client (Graph + Recommendations APIs), browser fetch, Korean errors.
// Only a fallback now: PubMed / Europe PMC / Crossref (scholarly.js) answer first and need no key.
import { anySignal, isAbortError, sleepAbortable } from './shared.js';
import { findDoi, referenceTitle } from './textmatch.js';

export { findDoi };

const BASE = 'https://api.semanticscholar.org';
const TIMEOUT_MS = 15000;
const MATCH_FIELDS = 'title,year,authors,url,externalIds,abstract,citationCount';
const REC_FIELDS = 'title,year,authors,url,externalIds,abstract,citationCount,venue';
const REF_FIELDS = 'title,year,authors,url,externalIds,abstract,citationCount,venue';
const MAX_QUERY = 300;

export const RATE_LIMIT_MESSAGE = 'Semantic Scholar가 잠시 바쁩니다(429). 1~2분 뒤 다시 시도해 주세요.';

export class S2Error extends Error {
  constructor(message, { status = 0 } = {}) {
    super(message);
    this.name = 'S2Error';
    this.status = status;
  }
}

function statusMessage(status, hasKey) {
  if (status === 429) return RATE_LIMIT_MESSAGE;
  if (status === 401 || status === 403) {
    return hasKey ? 'Semantic Scholar API 키가 올바르지 않습니다. 설정에서 키를 확인해 주세요.'
      : 'Semantic Scholar가 요청을 거부했습니다. 잠시 후 다시 시도해 주세요.';
  }
  if (status >= 500) return 'Semantic Scholar 서버에 문제가 있습니다. 잠시 후 다시 시도해 주세요.';
  return `Semantic Scholar 요청에 실패했습니다 (${status}).`;
}

/**
 * GET a Semantic Scholar endpoint. Resolves to parsed JSON, or null on 404.
 * One quick automatic retry on 429 (or a failed fetch while online, which is how a CORS-less 429 looks),
 * then a friendly S2Error.
 */
export async function s2Get(path, params = {}, { apiKey = '', signal, retry = true } = {}) {
  const url = new URL(path, BASE);
  for (const [k, v] of Object.entries(params)) if (v != null && v !== '') url.searchParams.set(k, String(v));
  const headers = { Accept: 'application/json' };
  if (apiKey) headers['x-api-key'] = apiKey;
  const timer = new AbortController();
  const t = setTimeout(() => timer.abort(), TIMEOUT_MS);
  const timedOut = () => !signal?.aborted && timer.signal.aborted;
  let res;
  try {
    try {
      res = await fetch(url, { headers, signal: anySignal(signal, timer.signal), credentials: 'omit', referrerPolicy: 'no-referrer' });
    } catch (err) {
      if (timedOut()) throw new S2Error('Semantic Scholar 응답이 늦어 중단했습니다. 잠시 후 다시 시도해 주세요.');
      if (isAbortError(err, signal)) throw err;
      const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
      // The keyless pool answers 429 without CORS headers (seen 2026-10-19), which the browser reports as a
      // failed fetch: retry once like a 429.
      if (!offline && retry) {
        clearTimeout(t);
        await sleepAbortable(1200, signal);
        return s2Get(path, params, { apiKey, signal, retry: false });
      }
      console.warn('[features] s2 fetch failed', err);
      throw new S2Error(offline
        ? 'Semantic Scholar에 연결하지 못했습니다. 인터넷 연결을 확인해 주세요.'
        : 'Semantic Scholar에 연결하지 못했습니다. 서버가 잠시 바쁘거나 네트워크가 막혀 있을 수 있습니다.');
    }
    if (res.status === 429 && retry) {
      clearTimeout(t);
      await sleepAbortable(1200, signal);
      return s2Get(path, params, { apiKey, signal, retry: false });
    }
    if (res.status === 404) return null;
    if (!res.ok) throw new S2Error(statusMessage(res.status, Boolean(apiKey)), { status: res.status });
    try {
      return await res.json();
    } catch (err) {
      if (isAbortError(err, signal) && !timedOut()) throw err;
      throw new S2Error('Semantic Scholar 응답을 읽지 못했습니다.', { status: res.status });
    }
  } finally {
    clearTimeout(t);
  }
}

/** Plain, compact query text (the match endpoint dislikes punctuation soup and very long input). */
export function cleanQuery(text) {
  return String(text ?? '').replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_QUERY);
}

/** @returns {{ paperId, title, year, authors: string[], url, abstract, citationCount, externalIds, venue }} */
export function normalizePaper(p) {
  return {
    paperId: p?.paperId ?? null,
    title: String(p?.title ?? '').trim(),
    year: Number.isFinite(p?.year) ? p.year : null,
    authors: Array.isArray(p?.authors) ? p.authors.map((a) => String(a?.name ?? '')).filter(Boolean) : [],
    url: p?.url || (p?.paperId ? `https://www.semanticscholar.org/paper/${p.paperId}` : null),
    abstract: typeof p?.abstract === 'string' ? p.abstract.trim() : '',
    citationCount: Number.isFinite(p?.citationCount) ? p.citationCount : null,
    externalIds: p?.externalIds && typeof p.externalIds === 'object' ? p.externalIds : null,
    venue: typeof p?.venue === 'string' ? p.venue : '',
  };
}

/** "Kim J, Lee S, Park H 외" */
export function formatAuthors(names, max = 3) {
  if (!names?.length) return '';
  return names.length > max ? `${names.slice(0, max).join(', ')} 외` : names.join(', ');
}

/** Best title match for a query, or null when Semantic Scholar has no match. */
export async function matchPaper(query, opts = {}) {
  const q = cleanQuery(query);
  if (!q) return null;
  const data = await s2Get('/graph/v1/paper/search/match', { query: q, fields: MATCH_FIELDS }, opts);
  const hit = data?.data?.[0];
  return hit?.paperId ? normalizePaper(hit) : null;
}

/** Up to 20 recommended papers for a Semantic Scholar paper id. */
export async function recommendations(paperId, opts = {}) {
  const data = await s2Get(`/recommendations/v1/papers/forpaper/${encodeURIComponent(paperId)}`,
    { fields: REC_FIELDS, limit: 20 }, opts);
  return (data?.recommendedPapers || []).filter((p) => p?.paperId).map(normalizePaper);
}

/**
 * Guess the article title inside a bibliography entry (quoted “Title,” or APA/Harvard "(2019). Title."
 * via textmatch.referenceTitle, else Vancouver "Authors. Title. Journal. 2019;"), falling back to the
 * cleaned entry.
 */
export function guessReferenceTitle(text) {
  const marked = referenceTitle(text);
  if (marked) return marked.slice(0, MAX_QUERY);
  const t = String(text ?? '').replace(/\s+/g, ' ').trim().replace(/^\[?\d{1,3}[\].)]?\s+/, '');
  const parts = t.split(/\.\s+/);
  if (parts.length >= 3 && parts[1].length >= 15) return parts[1];
  return t.slice(0, MAX_QUERY);
}

/** Exact DOI lookup (no guessing); null when Semantic Scholar does not know the DOI. */
export async function paperByDoi(doi, opts = {}) {
  if (!doi) return null;
  const path = String(doi).split('/').map(encodeURIComponent).join('/'); // the API expects literal slashes
  const byDoi = await s2Get(`/graph/v1/paper/DOI:${path}`, { fields: REF_FIELDS }, opts);
  return byDoi?.paperId ? normalizePaper(byDoi) : null;
}

/** Best title match for a bibliography entry (its guessed title), or null. */
export function matchReference(refText, opts = {}) {
  return matchPaper(guessReferenceTitle(refText), opts);
}

/** Metadata for a bibliography entry: DOI lookup first, then title match. Null when not found. */
export async function lookupReference(refText, opts = {}) {
  const doi = findDoi(refText);
  if (doi) {
    const hit = await paperByDoi(doi, opts);
    if (hit) return hit;
  }
  return matchReference(refText, opts);
}
