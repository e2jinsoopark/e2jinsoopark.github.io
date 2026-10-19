// Pure text helpers for matching papers across PubMed, Europe PMC, Crossref and the open PDF:
// title normalisation and similarity, significant words for title searches, reference ↔ title word
// overlap, and plain text from the light HTML some APIs put in titles and abstracts.

const STOP_WORDS = new Set([
  'a', 'an', 'the', 'of', 'in', 'on', 'for', 'and', 'or', 'to', 'with', 'by', 'at', 'from', 'as', 'is', 'are',
  'was', 'were', 'be', 'been', 'its', 'it', 'into', 'vs', 'versus', 'via', 'than', 'that', 'this', 'these', 'their',
  'among', 'after', 'during', 'between', 'without', 'within', 'over', 'under', 'do', 'does', 'not', 'no', 'can',
]);

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…' };

/** Decode the HTML entities APIs leave in text (named basics + numeric). */
export function decodeEntities(s) {
  return String(s ?? '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code) => {
    if (code[0] === '#') {
      const n = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[code.toLowerCase()] ?? m;
  });
}

/**
 * Plain text from light markup (<i>, <sup>, <h4>…</h4> section labels, <br>, <p>): tags dropped, entities
 * decoded. Section headings become "Label: " at the start of a new line. The result is text only and is
 * always rendered with textContent.
 */
export function plainText(s) {
  return decodeEntities(String(s ?? '')
    .replace(/<h\d[^>]*>\s*([\s\S]*?)\s*<\/h\d>/gi, (_, label) => `\n${label.replace(/<[^>]*>/g, '').replace(/[:\s]+$/, '')}: `)
    .replace(/<br\s*\/?>|<\/p>|<\/div>|<\/li>/gi, '\n')
    .replace(/<[^>]*>/g, ''))
    .split('\n').map((line) => line.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');
}

/** Lower-case letters and digits only (accents folded), single spaces. */
export function normalizeTitle(s) {
  return plainText(s).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

export function titleWords(s) {
  const n = normalizeTitle(s);
  return n ? n.split(' ') : [];
}

/** Content words (no stop words, ≥ 3 letters or a number), unique, in title order. */
export function significantWords(s, max = 10) {
  const out = [];
  for (const w of titleWords(s)) {
    if (STOP_WORDS.has(w) || (w.length < 3 && !/^\d+$/.test(w)) || out.includes(w)) continue;
    out.push(w);
    if (out.length >= max) break;
  }
  return out;
}

function bigrams(s) {
  const t = s.replace(/ /g, '');
  const m = new Map();
  for (let i = 0; i < t.length - 1; i++) {
    const g = t.slice(i, i + 2);
    m.set(g, (m.get(g) || 0) + 1);
  }
  return m;
}

/**
 * Title similarity in [0, 1]: Sørensen–Dice over character bigrams of the normalised titles. A title of
 * ≥ 5 words that is the start of the other (a PDF title without its subtitle) counts as 0.9.
 */
export function titleSimilarity(a, b) {
  const x = normalizeTitle(a);
  const y = normalizeTitle(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const A = bigrams(x);
  const B = bigrams(y);
  let total = 0;
  let shared = 0;
  for (const n of A.values()) total += n;
  for (const n of B.values()) total += n;
  for (const [g, n] of A) shared += Math.min(n, B.get(g) || 0);
  const dice = total ? (2 * shared) / total : 0;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  const prefix = short.split(' ').length >= 5 && (long === short || long.startsWith(`${short} `)) ? 0.9 : 0;
  return Math.max(dice, prefix);
}

/**
 * Share of a candidate title's normalised content words that occur in `text` (e.g. a bibliography entry).
 * Titles with no content words share nothing.
 */
export function wordOverlap(title, text) {
  const words = titleWords(title).filter((w) => !STOP_WORDS.has(w));
  if (!words.length) return 0;
  const pool = new Set(titleWords(text));
  return words.filter((w) => pool.has(w)).length / words.length;
}

/**
 * The article title inside a bibliography entry, when its style marks it: a quoted title (“Title,” —
 * AMA/ACS/IEEE) or the sentence after "(Year)." (APA/Harvard). Null when the style does not mark it
 * (Vancouver "Authors. Title. Journal."), so callers fall back to the whole entry.
 */
export function referenceTitle(text) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  const ok = (s) => (s && s.length >= 15 && significantWords(s).length >= 3 ? s : null);
  const quoted = t.match(/[“"]([^”"]{15,400}?)[,.]?[”"]/);
  if (quoted && ok(quoted[1].trim())) return quoted[1].trim().replace(/[,.]$/, '');
  const apa = t.match(/\((?:1[89]|20)\d{2}[a-z]?(?:, [^)]*)?\)\.?\s*(.+?[.?!])(?=\s|$)/);
  if (apa && ok(apa[1].trim())) return apa[1].trim().replace(/\.$/, '');
  return null;
}

/** Four-digit years (1800–2099) mentioned in a text. */
export function yearsIn(text) {
  return [...String(text ?? '').matchAll(/(?<!\d)(1[89]\d{2}|20\d{2})(?!\d)/g)].map((m) => Number(m[1]));
}

/** First DOI in a text, without trailing punctuation. */
export function findDoi(text) {
  const m = String(text ?? '').match(/\b(10\.\d{4,9}\/[^\s"<>]+)/i);
  return m ? m[1].replace(/[.,;)\]]+$/, '') : null;
}

/** First 4-digit year in a date-like string ("2004 Apr 14", "2022-10-03"), or null. */
export function yearOf(v) {
  if (Number.isInteger(v)) return v;
  const m = String(v ?? '').match(/(1[89]\d{2}|20\d{2})/);
  return m ? Number(m[1]) : null;
}

export const sameDoi = (a, b) => Boolean(a && b) && String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
