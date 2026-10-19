// Crossref (keyless, public pool, no mailto so nothing personal is sent): match a bibliography entry to
// a DOI with query.bibliographic, accepting the top hit only when it is clearly the one meant.
import { doiUrl } from './pubmed.js';
import { buildUrl, scholarlyGet } from './scholarly-net.js';
import { normalizeTitle, plainText, referenceTitle, titleSimilarity, wordOverlap, yearsIn } from './textmatch.js';

const WORKS = 'https://api.crossref.org/works';
const SELECT = 'DOI,title,score,author,issued,container-title,short-container-title,is-referenced-by-count,type';
const MAX_QUERY = 400;
/** The best hit must beat the best other plausible hit by this factor… */
export const SCORE_MARGIN = 1.15;
/** …and share at least this share of its title's words with the entry. */
export const MIN_TITLE_OVERLAP = 0.6;
/** …or, against a marked title, be this similar to it (a record title with a subtitle the entry left out). */
const TITLE_SPAN_MATCH = 0.85;

const firstOf = (v) => (Array.isArray(v) ? v[0] : v);

/** A Crossref work → the shared paper shape. */
export function fromCrossref(item) {
  const doi = item?.DOI ? String(item.DOI) : null;
  const year = item?.issued?.['date-parts']?.[0]?.[0];
  const cited = Number(item?.['is-referenced-by-count']);
  return {
    pmid: null,
    doi,
    pmcid: null,
    title: plainText(firstOf(item?.title) ?? ''),
    authors: (Array.isArray(item?.author) ? item.author : [])
      .map((a) => (a?.family ? `${a.family}${a.given ? ` ${initials(a.given)}` : ''}` : String(a?.name ?? '').trim())).filter(Boolean),
    journal: plainText(firstOf(item?.['short-container-title']) || firstOf(item?.['container-title']) || ''),
    year: Number.isInteger(year) ? year : null,
    date: Number.isInteger(year) ? String(year) : '',
    hasAbstract: null,
    citationCount: Number.isFinite(cited) ? cited : null,
    citationSource: 'Crossref',
    abstract: '',
    freeUrl: null,
    url: doi ? doiUrl(doi) : null,
    source: 'crossref',
    score: Number(item?.score) || 0,
    type: typeof item?.type === 'string' ? item.type : '',
  };
}

/** "E. Wesley" → "EW" (PubMed style). */
function initials(given) {
  return String(given).split(/[\s.-]+/).filter(Boolean).map((p) => p[0].toUpperCase()).join('');
}

/** Record types that are never the work an entry cites (supplement files, peer-review reports). */
const SKIP_TYPES = new Set(['component', 'peer-review']);
/** Notices about a work (erratum, reply, commentary…) share its title words but are not the work. */
const NOTICE = new RegExp([
  String.raw`^(?:correction|corrigendum|erratum|errata|retraction(?: note)?|expression of concern)\s*(?:to\b|for\b|:|$)`,
  String.raw`^(?:retracted|withdrawn)\s*:`,
  String.raw`^(?:reply|in reply|response)\s*(?:to\b|:|$)`,
  String.raw`^comment(?:ary)?\s*(?:on\b|:)`,
  String.raw`^re\s*:`,
  String.raw`^spotlight article\b`,
].join('|'), 'i');
const isNotice = (title) => NOTICE.test(String(title ?? '').replace(/^[\s"“‘'[(]+/, ''));

/**
 * A hit fits the entry when ≥ 60 % of its title words occur in the entry's title (or, when the style does
 * not mark the title, anywhere in the entry), and its year (if both known) is there ±1. Matching against
 * the marked title keeps out records whose title merely quotes the entry, e.g. a 1995 "Spotlight article:
 * A comparison of four endotracheal tube holders (Kaplow R, Bookbinder M. Heart Lung 1994;23:59–66)".
 */
function plausible(hit, refText, refYears, refTitle) {
  if (!hit.title || SKIP_TYPES.has(hit.type)) return false;
  if (isNotice(hit.title) && !isNotice(refTitle)) return false; // unless the entry cites the notice itself
  const fits = refTitle
    ? wordOverlap(hit.title, refTitle) >= MIN_TITLE_OVERLAP || titleSimilarity(hit.title, refTitle) >= TITLE_SPAN_MATCH
    : wordOverlap(hit.title, refText) >= MIN_TITLE_OVERLAP;
  if (!fits) return false;
  if (hit.year && refYears.length && !refYears.some((y) => Math.abs(y - hit.year) <= 1)) return false;
  return true;
}

/**
 * Pick the work a bibliography entry refers to from Crossref hits (best score first), or null.
 * The top hit must be plausible (title overlap, year, not a notice about the work) and clearly ahead: no
 * other plausible hit with a different title scores within SCORE_MARGIN of it (two records of the same
 * work are not a rival).
 */
export function pickReferenceHit(items, refText) {
  const hits = (items || []).map(fromCrossref).filter((h) => h.doi).sort((a, b) => b.score - a.score);
  const top = hits[0];
  const refYears = yearsIn(refText);
  const refTitle = referenceTitle(refText);
  if (!top || !plausible(top, refText, refYears, refTitle)) return null;
  const rival = hits.slice(1).find((h) => plausible(h, refText, refYears, refTitle) && normalizeTitle(h.title) !== normalizeTitle(top.title));
  if (rival && top.score < rival.score * SCORE_MARGIN) return null;
  return top;
}

/** Crossref match for a bibliography entry → paper (with doi) or null. */
export async function crossrefMatch(refText, { signal } = {}) {
  const q = String(refText ?? '').replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_QUERY);
  if (q.length < 12) return null;
  const data = await scholarlyGet('crossref', buildUrl(WORKS, { 'query.bibliographic': q, rows: 3, select: SELECT }), { signal });
  return pickReferenceHit(data?.message?.items, q);
}
