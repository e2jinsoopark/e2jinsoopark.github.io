// Readable titles from PDF metadata strings. Pure (no DOM, no pdf.js), so the library can repair stored titles
// on load and Node tests can run it.
//
// Two ways a title arrives garbled:
//  - as the literal PDF hex string, e.g. '<C3D6C1BEB3EDB9AE2E687770>' (EUC-KR bytes of '최종논문.hwp');
//  - as bytes that pdf.js read as PDFDocEncoding because the string had no BOM (EUC-KR or UTF-8 bytes
//    → 'ÃÖÁ¾³í¹®.hwp').
// Both are turned back into bytes and decoded as UTF-16 (BOM), UTF-8, then EUC-KR. A title that is still a file
// name or a code ('G09_McGrath2020_ICS_NTSP_TrachCareGuidance', '최종논문') is reported as such, so the
// caller can prefer the title printed on page 1.

/** A stored title that is nothing but a PDF hex string (the library repairs these on load). */
export const HEX_TITLE_RE = /^<[0-9A-Fa-f]{4,}>$/;

/** A PDF hex string: '<' hex digits (whitespace allowed, as in PDF) '>'. */
const HEX_STRING_RE = /^<([0-9A-Fa-f\s]{4,})>$/;
/** Extensions of document files whose names end up as PDF titles. */
const FILE_EXT_RE = /\.(?:pdf|hwpx?|hwt|docx?|dotx?|docm|pptx?|ppsx?|xlsx?|rtf|odt|odp|txt|tex|dvi|ps|pages|key|indd|qxd)$/i;
/** "Microsoft Word - 최종논문.hwp", "Microsoft PowerPoint - …" (the printer driver's job name). */
const APP_PREFIX_RE = /^microsoft\s+(?:office\s+)?(?:word|powerpoint|excel)\s*-\s+/i;
/** Control characters and invisible marks a title never needs. */
const JUNK_RE = /[\u0000-\u001F\u007F-\u009F\u00AD\u200B-\u200D\u2060\uFEFF\uFFFD]/g;
/** Names a document gets from its author, not its title ('최종논문', 'manuscript_v2', 'Document1'). */
const GENERIC_NAME_RE = new RegExp(
  '^(?:'
  + '(?:최종|수정|제출|초안|완성|심사|인쇄|발표|원|새)*(?:학위)?(?:논문|원고|보고서|자료|파일|문서|계획서|초록|본문|본|발표자료)(?:최종|수정|제출|완성|본|용)*'
  + '|(?:최종|수정|제출|초안|완성)+(?:본|판|안)?'
  + '|(?:final|draft|revised|new|untitled|camera|full)*'
  + '(?:manuscript|paper|thesis|dissertation|document|doc|article|fulltext|text|main|title|untitled|draft|final|print|proof|ready|submission|preprint|accepted)'
  + '(?:final|draft|revised|version|ver|copy|proof|clean|tracked|marked)*'
  + ')$', 'i');

/** Titles that say nothing at all: dropped, so the caller falls back to page 1 or the file name. */
const PLACEHOLDER_RE = /^(?:untitled(?:\s*document)?|document\s*\d*|title|no title|제목\s*없음|새\s*문서\s*\d*|문서\s*\d*|microsoft\s+(?:word|powerpoint|excel)(?:\s*-.*)?)$/i;

/**
 * pdf.js decodes a PDF string without a BOM as PDFDocEncoding: Latin-1 except these bytes (its
 * PDFStringTranslateTable). Reversed here so the original bytes can be recovered.
 */
const PDFDOC_SPECIAL = new Map([
  [0x02d8, 0x18], [0x02c7, 0x19], [0x02c6, 0x1a], [0x02d9, 0x1b], [0x02dd, 0x1c], [0x02db, 0x1d], [0x02da, 0x1e], [0x02dc, 0x1f],
  [0x2022, 0x80], [0x2020, 0x81], [0x2021, 0x82], [0x2026, 0x83], [0x2014, 0x84], [0x2013, 0x85], [0x0192, 0x86], [0x2044, 0x87],
  [0x2039, 0x88], [0x203a, 0x89], [0x2212, 0x8a], [0x2030, 0x8b], [0x201e, 0x8c], [0x201c, 0x8d], [0x201d, 0x8e], [0x2018, 0x8f],
  [0x2019, 0x90], [0x201a, 0x91], [0x2122, 0x92], [0xfb01, 0x93], [0xfb02, 0x94], [0x0141, 0x95], [0x0152, 0x96], [0x0160, 0x97],
  [0x0178, 0x98], [0x017d, 0x99], [0x0131, 0x9a], [0x0142, 0x9b], [0x0153, 0x9c], [0x0161, 0x9d], [0x017e, 0x9e], [0x20ac, 0xa0],
]);

const decoders = new Map();
/** A fatal TextDecoder, or null where the runtime lacks the encoding. */
function decoder(label) {
  if (!decoders.has(label)) {
    let d = null;
    try { d = new TextDecoder(label, { fatal: true }); } catch { d = null; }
    decoders.set(label, d);
  }
  return decoders.get(label);
}

function tryDecode(label, bytes) {
  const d = decoder(label);
  if (!d) return null;
  try { return d.decode(bytes); } catch { return null; }
}

/** Bytes of a PDF hex string body ('C3 D6 …'); an odd final digit counts as followed by 0 (PDF rule). */
export function hexToBytes(hex) {
  const digits = String(hex).replace(/[^0-9A-Fa-f]/g, '');
  const out = new Uint8Array(Math.ceil(digits.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = parseInt((digits.slice(2 * i, 2 * i + 2) + '0').slice(0, 2), 16);
  return out;
}

/** The bytes pdf.js read for a PDFDocEncoding string, or null when it holds other characters (real Unicode). */
export function pdfDocBytes(s) {
  const str = String(s ?? '');
  const out = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    const b = c <= 0xff ? c : PDFDOC_SPECIAL.get(c);
    if (b === undefined) return null;
    out[i] = b;
  }
  return out;
}

/** Readable text: no control characters (tabs and line breaks aside), at least one letter or digit. */
function readable(s) {
  return typeof s === 'string' && !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\uFFFD]/.test(s) && /[\p{L}\p{N}]/u.test(s);
}

/**
 * EUC-KR as it appears in Korean document titles: every two-byte character is from KS X 1001 (lead and trail
 * 0xA1–0xFE) and at least half are Hangul syllables (lead 0xB0–0xC8). Latin-1 text with accents ('Résumé',
 * 'Façade') fails this, so it is never "repaired" into Hangul.
 */
function plainEucKr(bytes) {
  let pairs = 0;
  let hangul = 0;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b < 0x80) continue;
    const t = bytes[i + 1];
    if (b < 0xa1 || b > 0xfe || t === undefined || t < 0xa1 || t > 0xfe) return false;
    pairs++;
    if (b >= 0xb0 && b <= 0xc8) hangul++;
    i++;
  }
  return pairs > 0 && hangul * 2 >= pairs;
}

/**
 * Decode the bytes of a text string: UTF-16 with a BOM, UTF-8, then EUC-KR (the first that yields readable text).
 * `strict` (bytes that pdf.js already read as Latin-1): accept EUC-KR only when it looks like Korean text.
 * @param {Uint8Array} bytes
 * @param {{ strict?: boolean }} [opts]
 * @returns {string|null}
 */
export function decodeTextBytes(bytes, { strict = false } = {}) {
  if (!bytes?.length) return null;
  const [b0, b1, b2] = bytes;
  if ((b0 === 0xfe && b1 === 0xff) || (b0 === 0xff && b1 === 0xfe)) {
    const s = tryDecode(b0 === 0xfe ? 'utf-16be' : 'utf-16le', bytes.subarray(2, 2 + ((bytes.length - 2) & ~1)));
    const text = s?.replace(/\x1b[^\x1b]*(?:\x1b|$)/g, ''); // language escapes (as pdf.js drops them)
    return readable(text) ? text : null;
  }
  const body = b0 === 0xef && b1 === 0xbb && b2 === 0xbf ? bytes.subarray(3) : bytes;
  if (body.every((b) => b < 0x80)) {
    const s = latin1(body);
    return readable(s) ? s : null;
  }
  const utf8 = tryDecode('utf-8', body);
  if (readable(utf8)) return utf8;
  if (strict && !plainEucKr(body)) return null;
  const euckr = tryDecode('euc-kr', body);
  return readable(euckr) ? euckr : null;
}

function latin1(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return s;
}

const BYTE_TO_PDFDOC = new Map([...PDFDOC_SPECIAL].map(([c, b]) => [b, c]));
/** Bytes read as PDFDocEncoding, as pdf.js does for a string without a BOM. */
function pdfDocString(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(BYTE_TO_PDFDOC.get(b) ?? b);
  return s;
}

/**
 * Undo a wrong decoding of a title. A PDF hex string ('<C3D6…>') is decoded from its bytes (UTF-16 BOM, UTF-8,
 * EUC-KR, else PDFDocEncoding); text that pdf.js read as PDFDocEncoding but holds UTF-8 or EUC-KR bytes
 * ('ÃÖÁ¾³í¹®') is re-decoded. Anything else is returned as is. Returns '' for a hex string that is not text.
 */
export function decodePdfString(raw) {
  const s = String(raw ?? '').trim();
  const hex = HEX_STRING_RE.exec(s);
  if (hex) {
    const bytes = hexToBytes(hex[1]);
    const text = decodeTextBytes(bytes);
    if (text != null) return text;
    const doc = pdfDocString(bytes);
    return readable(doc) ? doc : '';
  }
  const bytes = pdfDocBytes(s);
  if (!bytes || bytes.every((b) => b < 0x80)) return s;
  return decodeTextBytes(bytes, { strict: true }) ?? s;
}

/** 'C:\\논문\\최종논문.hwp' → '최종논문.hwp' (only for something that ends like a file name). */
function baseName(s) {
  return FILE_EXT_RE.test(s) && /[\\/]/.test(s) ? s.replace(/^.*[\\/]/, '') : s;
}

/** 'a.hwp.pdf' → 'a' (never down to nothing). */
function stripExtensions(s) {
  let out = s;
  for (let k = 0; k < 3 && FILE_EXT_RE.test(out); k++) {
    const next = out.replace(FILE_EXT_RE, '').trim();
    if (!next) break;
    out = next;
  }
  return out;
}

const collapse = (s) => String(s ?? '').replace(JUNK_RE, ' ').replace(/\s+/g, ' ').trim();

/**
 * A PDF Info Title as the library should show it: decoded, without the printer's "Microsoft Word - " and
 * without file extensions. `fileLike` is true when it came from or still is a file name or a code — then the
 * title printed on page 1 is the better choice.
 * @returns {{ title: string, fileLike: boolean }}
 */
export function readPdfTitle(raw) {
  let s = collapse(decodePdfString(String(raw ?? '')));
  let named = false;
  if (APP_PREFIX_RE.test(s)) {
    s = collapse(decodePdfString(s.replace(APP_PREFIX_RE, ''))); // "Microsoft Word - <C3D6…>"
    named = true;
  }
  const base = baseName(s);
  const stripped = stripExtensions(base);
  if (base !== s || stripped !== base) named = true;
  const title = PLACEHOLDER_RE.test(stripped) ? '' : stripped;
  return { title, fileLike: !title || named || looksLikeFileName(title) };
}

/** {@link readPdfTitle}'s text only. */
export function decodePdfTitle(raw) {
  return readPdfTitle(raw).title;
}

/**
 * Is this a file name or a code rather than a paper title?
 * 'G09_McGrath2020_ICS_NTSP_TrachCareGuidance', 'E41_KimEunji2021_SNU_석사_EICU_VAP', '최종논문', 'manuscript_v2',
 * '1-s2.0-S0964339720300123-main', '2021_03', 'paper.pdf' → true; 'Delirium in the ICU', '중환자실 간호사의 섬망
 * 인식' → false.
 */
export function looksLikeFileName(raw) {
  const s = collapse(raw);
  if (!s) return true;
  if (FILE_EXT_RE.test(s)) return true;
  if (!/\p{L}/u.test(s)) return true; // digits, underscores, punctuation only
  if (/^(?:pii|doi)\b|^10\.\d{4,}\//i.test(s)) return true;
  const compact = s.toLowerCase().replace(/[\s_.()[\]-]+/g, '').replace(/(?:ver|rev|v)?\d+$/, '');
  if (!compact || GENERIC_NAME_RE.test(compact)) return true;
  const words = s.split(' ');
  const underscores = (s.match(/_/g) || []).length;
  if (underscores >= 2 || (underscores && words.length < 3)) return true;
  if (words.length === 1) {
    // One token: a code ('G09', 'ijerph-17-01234'), CamelCase joined words ('KimEunji', 'TrachCareGuidance') or a
    // long run without spaces.
    if (/\d/.test(s) || /\p{Ll}\p{Lu}/u.test(s) || s.length > 30) return true;
  }
  // Short runs of codes: 'G09 E41', 'SNU 2021'.
  if (words.length <= 3 && words.every((w) => /^(?:\p{Lu}{1,5}\d+\p{L}?|\d+|\p{Lu}{2,6})$/u.test(w)) && /\d/.test(s)) return true;
  return false;
}
