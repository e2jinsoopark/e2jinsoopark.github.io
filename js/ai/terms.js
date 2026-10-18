// Per-paper running term map: the Korean rendering this paper's translations established for each recurring
// technical term ("endotracheal tube (ETT)" → "기관내관"). Batches are translated separately (and in parallel), so
// without it a model drifts between synonyms from page to page (기관내 튜브 / 기관내관 / 기관튜브, 욕창 / 압박손상).
//
// - Every answer reports the renderings it used (TRANSLATION_SCHEMA `terms`); an entry is kept only when its English
//   occurs in that batch's source and its Korean occurs in that batch's accepted translations. First one wins.
// - Later batches get the established terms that occur in them (`<terms>` in the user message, after the cached
//   prefix) as binding guidance. Matching spells out the paper's abbreviations both ways, so "endotracheal tube
//   holder" is found in "ETT holders" (papers abbreviate compounds after the first mention) and vice versa.
//   A user-glossary entry overrides a term (it is never sent while the glossary covers it).
// - Persisted in translation.json as `terms: { [key]: { en, ko } }` (an object keyed by the normalised English, so two
//   copies merge by key union like `items`).
import { MAX_NEW_TERMS_PER_ANSWER } from './prompts.js';

export const MAX_TERMS = 200;
const MAX_EN_CHARS = 80;
const MAX_EN_WORDS = 8;
const MAX_KO_CHARS = 40;
const HANGUL = /[가-힣]/;

/**
 * Normalised word list for matching: split on everything that is not a letter or digit, lower case, plural folded
 * ("ETTs" → ett, "injuries" → injury, "dislodgements" → dislodgement; "status", "analysis", "process" kept).
 */
export function normWords(text) {
  const out = [];
  for (const tok of String(text ?? '').normalize('NFKC').match(/[A-Za-z0-9]+/g) || []) {
    if (/^[A-Z][A-Z0-9]+s$/.test(tok)) { out.push(tok.slice(0, -1).toLowerCase()); continue; } // ICUs, MDRPIs
    out.push(singular(tok.toLowerCase()));
  }
  return out;
}

function singular(w) {
  if (w.length <= 3 || /\d/.test(w)) return w;
  if (w.endsWith('ies')) return `${w.slice(0, -3)}y`;
  if (/(?:ss|us|is)$/.test(w)) return w;
  if (/(?:ches|shes|xes|sses)$/.test(w)) return w.slice(0, -2);
  if (w.endsWith('s')) return w.slice(0, -1);
  return w;
}

/**
 * Match keys of an English term: the phrase without a trailing "(ABBR)", and the abbreviation if there is one.
 * @returns {{ key: string, abbr: string }}
 */
export function termKeys(en) {
  const text = clean(en);
  const m = /^(.*?)\s*\(([^()]{1,20})\)$/.exec(text);
  const main = m && m[1] ? m[1] : text;
  const abbr = m && /^[A-Za-z][A-Za-z0-9-]{1,11}$/.test(m[2].trim()) ? normWords(m[2]).join(' ') : '';
  return { key: normWords(main).join(' '), abbr };
}

/** The phrase of an English term without its trailing "(ABBR)". */
function mainPhrase(en) {
  const text = clean(en);
  const m = /^(.*?)\s*\(([^()]{1,20})\)$/.exec(text);
  return m && m[1] ? m[1] : text;
}

/**
 * The paper's abbreviations as written ("ETT" → "endotracheal tube"), from terms "phrase (ABBR)". Only abbreviations
 * with two or more capitals, matched case-sensitively, so "odds ratio (OR)" never expands the word "or".
 * @param {Iterable<{ en: string }>} terms
 */
function abbreviations(terms) {
  const out = new Map();
  for (const t of terms) {
    const m = /^(.*?)\s*\(([A-Za-z][A-Za-z0-9-]{1,11})\)$/.exec(clean(t?.en));
    if (m && m[1] && (m[2].match(/[A-Z]/g) || []).length >= 2 && !out.has(m[2])) out.set(m[2], m[1]);
  }
  return out;
}

/** `text` with every known abbreviation (also its plural, "ETTs") spelled out: "ETT holders" → "endotracheal tube holders". */
function expand(text, abbrs) {
  const s = String(text ?? '');
  if (!abbrs.size) return s;
  return s.normalize('NFKC').replace(/[A-Za-z0-9]+/g, (tok) => abbrs.get(tok) ?? (tok.endsWith('s') ? abbrs.get(tok.slice(0, -1)) : undefined) ?? tok);
}

/** Normalised words of `text` for phrase search, plus (after a separator) the same with abbreviations spelled out. */
function haystack(text, abbrs) {
  const plain = normWords(text).join(' ');
  return abbrs.size ? ` ${plain} | ${normWords(expand(text, abbrs)).join(' ')} ` : ` ${plain} `;
}

/** True when the term — its phrase, its phrase with abbreviations spelled out, or its abbreviation — is in `hay`. */
function occurs(hay, en, abbrs) {
  const { key, abbr } = termKeys(en);
  if (key && hay.includes(` ${key} `)) return true;
  if (abbr && hay.includes(` ${abbr} `)) return true;
  const spelled = abbrs.size ? normWords(expand(mainPhrase(en), abbrs)).join(' ') : '';
  return Boolean(spelled && spelled !== key && hay.includes(` ${spelled} `));
}

/** Keys of the user glossary's English terms (a glossary entry overrides any established term it covers). */
export function glossaryKeys(glossary) {
  const keys = [];
  for (const g of Array.isArray(glossary) ? glossary : []) {
    if (!g || !String(g.src || '').trim() || !String(g.tgt || '').trim()) continue;
    const { key, abbr } = termKeys(g.src);
    if (key) keys.push(key);
    if (abbr) keys.push(abbr);
  }
  return keys;
}

export class TermMap {
  constructor() {
    /** @type {Map<string, { en: string, ko: string }>} main key → term, in the order they were established */
    this._terms = new Map();
    /** @type {Map<string, string>} main key or abbreviation → main key */
    this._index = new Map();
  }

  get size() {
    return this._terms.size;
  }

  /** All terms in the order they were established (copies). */
  list() {
    return [...this._terms.values()].map((t) => ({ ...t }));
  }

  /** The Korean rendering established for an English term (any inflection, or its abbreviation), or null. */
  lookup(en) {
    const { key, abbr } = termKeys(en);
    const main = this._index.get(key) ?? (abbr ? this._index.get(abbr) : undefined);
    return main ? this._terms.get(main).ko : null;
  }

  /**
   * Take in terms from a translation file (`terms` object, or a list of { en, ko }). Known terms are kept (first
   * one wins). Returns how many were added.
   */
  load(stored) {
    if (!stored || typeof stored !== 'object') return 0;
    let added = 0;
    for (const t of Array.isArray(stored) ? stored : Object.values(stored)) if (this._add(t)) added++;
    return added;
  }

  /**
   * Record the renderings one translation answer reported. An entry is kept only if its English occurs in the
   * batch's source text, its Korean occurs in one of the batch's accepted translations, it is not known yet and the
   * glossary does not cover it. Returns the added terms.
   * @param {unknown} reported  the answer's `terms` array (untrusted model output)
   * @param {{ source: string, translations: string[], glossary?: string[] }} batch
   */
  note(reported, { source, translations, glossary = [] }) {
    const added = [];
    if (!Array.isArray(reported) || !translations.length) return added;
    const candidates = reported.slice(0, MAX_NEW_TERMS_PER_ANSWER * 2).map(sanitize).filter(Boolean);
    const abbrs = abbreviations([...this._terms.values(), ...candidates]);
    const hay = haystack(source, abbrs);
    const korean = translations.join('\n').replace(/\s+/g, '');
    for (const term of candidates) {
      if (added.length >= MAX_NEW_TERMS_PER_ANSWER) break;
      const { key, abbr } = termKeys(term.en);
      if (!occurs(hay, term.en, abbrs)) continue; // not in this batch
      if (!korean.includes(term.ko.replace(/\s+/g, ''))) continue; // not what the translations actually say
      if (covered(key, abbr, glossary)) continue;
      if (this._add(term)) added.push(term);
    }
    return added;
  }

  /**
   * Established terms that occur in `text` (and that the glossary does not override), in the order they were
   * established, at most `max`.
   */
  relevant(text, { glossary = [], max = Infinity } = {}) {
    const abbrs = abbreviations(this._terms.values());
    const hay = haystack(text, abbrs);
    const out = [];
    for (const [key, term] of this._terms) {
      if (out.length >= max) break;
      const { abbr } = termKeys(term.en);
      if (!occurs(hay, term.en, abbrs)) continue;
      if (covered(key, abbr, glossary)) continue;
      out.push({ ...term });
    }
    return out;
  }

  /** `terms` for translation.json, or undefined when there are none. */
  toJSON() {
    if (!this._terms.size) return undefined;
    return Object.fromEntries([...this._terms].map(([key, t]) => [key, { ...t }]));
  }

  _add(raw) {
    if (this._terms.size >= MAX_TERMS) return false;
    const term = sanitize(raw);
    if (!term) return false;
    const { key, abbr } = termKeys(term.en);
    if (!key || this._index.has(key) || (abbr && this._index.has(abbr))) return false;
    this._terms.set(key, term);
    this._index.set(key, key);
    if (abbr) this._index.set(abbr, key);
    return true;
  }
}

/** A glossary key equal to the term's key or abbreviation, or contained in the term as a phrase, overrides it. */
function covered(key, abbr, glossary) {
  if (!glossary.length) return false;
  const padded = ` ${key} `;
  return glossary.some((g) => g === key || (abbr && g === abbr) || padded.includes(` ${g} `));
}

/** { en, ko } from untrusted input: one line each, sane lengths, Korean with Hangul, no trailing "(English)". */
function sanitize(t) {
  if (!t || typeof t !== 'object') return null;
  const en = clean(t.en);
  const ko = clean(t.ko).replace(/\s*\([^()]*[A-Za-z][^()]*\)$/, '').trim();
  if (!/[A-Za-z]{2,}/.test(en) || en.length > MAX_EN_CHARS || en.split(' ').length > MAX_EN_WORDS) return null;
  if (!HANGUL.test(ko) || ko.length > MAX_KO_CHARS) return null;
  return { en, ko };
}

function clean(s) {
  return String(s ?? '').replace(/[<>→]/g, ' ').replace(/\s+/g, ' ').trim();
}
