// Text extraction: pdf.js text items → logical document text with a reversible char map,
// paragraphs, sentences (stable sids), references and basic metadata.
// Pure computation (no DOM access), so it also runs under Node for tests.

/** Bump whenever the produced text / sentence boundaries change (invalidates cached translations by sid). */
export const SEG_VERSION = 1;

/**
 * @typedef {{pageNumber:number, width:number, height:number, textStart:number, textEnd:number}} PageInfo
 * @typedef {{sid:string, start:number, end:number, text:string, page:number, pages:number[], pid:string, kind:string}} Sentence
 * @typedef {{pid:string, page:number, sids:string[], kind:string}} Paragraph
 * @typedef {{index:number, n:number|null, text:string, start:number, end:number, page:number,
 *            bbox:{x:number,y:number,w:number,h:number}}} Reference
 */

// ---------------------------------------------------------------------------------------------
// Character classes & patterns
// ---------------------------------------------------------------------------------------------

/** Invisible / junk code units that never reach doc.text (control chars, soft hyphen, ZW chars, PUA, U+FFFD). */
const DROP_CHAR = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u00AD\u200B-\u200D\u2060\uFEFF\uFFFD\uE000-\uF8FF]/;
const WS_CHAR = /\s/;
const HYPHENS = new Set(['-', '\u2010', '\u2011']);
const DASHES = new Set(['–', '—']);
/**
 * Sentence-final punctuation, optionally followed by closing quotes/brackets, or by superscript citation
 * digits ("…in the ICU.12") — but not a decimal number ("p < 0.05").
 */
const TERMINAL_RE = /(?:[.!?][)"'”’\]]*|[^\d\s][.!?][)"'”’\]]*\d{1,3}(?:\s?[,–-]\s?\d{1,3})*)$/;
const CAPTION_RE = /^(fig(ure)?s?\.?|tab(le|\.)|scheme|chart|box|graph|plate|exhibit|supplementa(l|ry)\s+(fig(ure)?|table))\s*(S?\d+|[IVX]{1,5})[a-z]?\b/i;
const CAPTION_PUNCT_RE = /^\S+\.?\s*(S?\d+|[IVX]{1,5})[a-z]?\s*[.:|—–-]/i;
const REF_HEADING_RE = /^(references?|bibliography|literature cited|works cited|reference list|cited literature|참고\s*문헌)$/i;
const END_REF_RE = /^(appendix|appendices|supplementa|supporting information|acknowledg|funding|conflicts? of interest|declarations?|competing interests?|author contributions?|data availability|ethics|abbreviations|biograph|about the authors?)/i;
const ABSTRACT_HEADING_RE = /^(abstract|summary)$/i;
/** Standard section names: a line holding only one of these never continues into the next line. */
const SECTION_NAME_RE = /^(abstract|summary|introduction|background|methods?|materials and methods|results|discussion|conclusions?|references|bibliography|acknowledge?ments?|limitations|appendix|참고\s*문헌|초록)$/i;
const SECTION_NUMBER_RE = /^((\d+(\.\d+)*|[IVX]{1,5}|[A-Z])\s*[.|:)]?\s+)/;
const PAGE_NUMBER_RE = /^(page\s*)?[-–]?\s*\d{1,4}\s*[-–]?(\s*(of|\/)\s*\d{1,4})?$/i;
const FUNCTION_WORDS = new Set(['a', 'an', 'the', 'of', 'in', 'on', 'at', 'to', 'for', 'from', 'by', 'with', 'and', 'or',
  'nor', 'but', 'as', 'than', 'that', 'which', 'who', 'whose', 'whom', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'has', 'have', 'had', 'not', 'into', 'onto', 'between', 'among', 'during', 'within', 'without', 'via', 'per', 'its',
  'their', 'our', 'this', 'these', 'those', 'such', 'both', 'either', 'neither', 'if', 'when', 'while', 'whether', 'also']);
/** Abbreviations after which Intl.Segmenter's sentence break is false. Case-sensitive entries are listed separately. */
const ABBREV_END_RE = /(?:^|[\s(\[])(?:et\s+al|e\.\s?g|i\.\s?e|[Ff]igs?|[Ee]qs?|[Rr]efs?|[Ss]ecs?|[Tt]abs?|[Vv]ols?|pp|[Pp]|vs|[Cc]f|approx|[Cc]a|resp|incl|[Cc]h|[Nn]os?|Dr|Prof|Mr|Mrs|Ms|Inc|Ltd|Co|Corp|Jr|Sr|St|Dept|Univ|[Ee]d|[Ee]ds|Suppl|U\.S|U\.K|E\.U)\.$/;
const INITIAL_END_RE = /(?:^|[\s(])(\p{Lu}[\p{Ll}'’-]+|\p{Lu}\.)\s+\p{Lu}\.$/u;
const CITATION_AFTER_PERIOD_RE = /([\p{Ll})\]])\.(\d{1,3}(?:\s?[,–-]\s?\d{1,3})*)\s+(?=[\p{Lu}(])/gu;

const MAX_SENTENCE_CHARS = 700;
const ABSTRACT_MAX_CHARS = 2000;
const PAGE_CONCURRENCY = 4;

// ---------------------------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------------------------

/**
 * Extract the whole document. Deterministic for a given PDF + SEG_VERSION.
 * @param {any} pdf PDFDocumentProxy
 * @param {{onProgress?: (p:{phase:'text'|'done', done:number, total:number}) => void}} [opts]
 *   Called once per page read (done/total pages), then once with phase 'done'.
 * @returns {Promise<object>} PaperDoc (see docs/SPEC.md §2.1)
 */
export async function extractDocument(pdf, { onProgress } = {}) {
  const numPages = pdf.numPages;
  const [info, pages] = await Promise.all([
    readInfo(pdf),
    loadPages(pdf, numPages, (done) => onProgress?.({ phase: 'text', done, total: numPages })),
  ]);

  pages.forEach((p) => { p.lines = buildLines(p); });
  markFurniture(pages);
  const stats = computeStats(pages);
  for (const p of pages) p.blocks = buildBlocks(p, stats);
  const blocks = pages.flatMap((p) => p.blocks);
  blocks.forEach((b) => finishBlock(b));
  classifyBlocks(blocks, stats, numPages);
  mergeDropCaps(pages, stats);
  mergeContinuations(pages, stats);

  const lexicon = buildLexicon(pages);
  const sink = new TextSink(pages);
  const ordered = emitDocument(pages, sink, lexicon);
  const text = sink.parts.join('');
  const map = sink.toMap();

  const doc = {
    segVersion: SEG_VERSION,
    numPages,
    text,
    pages: pageInfos(pages, map.charPage, text.length),
    sentences: [],
    sentenceById: new Map(),
    paragraphs: [],
    references: [],
    meta: { title: '', authors: '', year: null, abstract: '' },
    hasTextLayer: false,
    _map: map,
    _itemToDoc: sink.itemToDoc,
    _geom: buildGeometry(pages),
  };
  buildParagraphs(doc, ordered);
  doc.references = buildReferences(doc);
  doc.hasTextLayer = hasRealText(doc, numPages);
  doc.meta = buildMeta(info, pages, ordered, doc, stats);
  onProgress?.({ phase: 'done', done: numPages, total: numPages });
  return doc;
}

/**
 * Fast metadata for the library list: PDF info + first page only.
 * @param {any} pdf PDFDocumentProxy
 * @returns {Promise<{title:string, authors:string, year:number|null, pages:number}>}
 */
export async function quickMeta(pdf) {
  const [info, pages] = await Promise.all([readInfo(pdf), loadPages(pdf, Math.min(1, pdf.numPages))]);
  pages.forEach((p) => { p.lines = buildLines(p); });
  markFurniture(pages);
  const stats = computeStats(pages);
  for (const p of pages) p.blocks = buildBlocks(p, stats);
  const blocks = pages.flatMap((p) => p.blocks);
  blocks.forEach((b) => finishBlock(b));
  classifyBlocks(blocks, stats, pdf.numPages);
  const title = pickTitle(info, blocks, stats);
  return {
    title: title.text,
    authors: pickAuthors(info, blocks, title),
    year: pickYear(info, pages),
    pages: pdf.numPages,
  };
}

/**
 * Page number (1-based) containing a doc offset; synthetic separators belong to the preceding page.
 * @param {{pages: PageInfo[]}} doc
 * @param {number} offset
 */
export function docOffsetToPage(doc, offset) {
  const pages = doc.pages;
  let lo = 0;
  let hi = pages.length - 1;
  let ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (pages[mid].textStart <= offset) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return pages[ans]?.pageNumber ?? 1;
}

// ---------------------------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------------------------

async function readInfo(pdf) {
  try {
    const m = await pdf.getMetadata();
    return m?.info || {};
  } catch {
    return {};
  }
}

/** Load pages 1..count with bounded concurrency; returns page records in order. */
async function loadPages(pdf, count, onPage) {
  const pages = new Array(count);
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < count) {
      const index = next++;
      pages[index] = await loadPage(pdf, index + 1);
      onPage?.(++done);
    }
  };
  await Promise.all(Array.from({ length: Math.min(PAGE_CONCURRENCY, count) }, worker));
  // A page pdf.js could not load gets the size of its nearest loaded neighbour (an empty page, no text).
  pages.forEach((p, i) => {
    if (!p.failed) return;
    const near = pages.slice(0, i).reverse().find((q) => !q.failed) || pages.slice(i + 1).find((q) => !q.failed);
    if (near) { p.width = near.width; p.height = near.height; }
  });
  return pages;
}

async function loadPage(pdf, pageNumber) {
  let page;
  try {
    page = await pdf.getPage(pageNumber);
  } catch (err) {
    // One damaged page must not make the whole paper unopenable: it becomes an empty page.
    console.warn('[pdf] getPage failed on page', pageNumber, err);
    return { pageNumber, width: 612, height: 792, items: [], lines: [], blocks: [], failed: true };
  }
  const vp = page.getViewport({ scale: 1 });
  let tc;
  try {
    // Must match the viewer's call exactly: the item order/indices are the contract between the two.
    tc = await page.getTextContent();
  } catch (err) {
    console.warn('[pdf] getTextContent failed on page', pageNumber, err);
    tc = { items: [], styles: {} };
  }
  return {
    pageNumber,
    width: vp.width,
    height: vp.height,
    items: normalizeItems(tc, vp.transform),
    lines: [],
    blocks: [],
  };
}

/** Matrix product, same convention as pdf.js Util.transform. */
function mul(a, b) {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}

/**
 * Text items in viewport space at scale 1 (PDF units, top-left origin, y = baseline).
 * Keeps one record per pdf.js item so record.i === index into textContent.items === textDivs index.
 */
function normalizeItems(tc, vpTransform) {
  const styles = tc.styles || {};
  const items = [];
  tc.items.forEach((it, i) => {
    if (typeof it.str !== 'string') return; // marked content (not requested; defensive)
    const m = mul(vpTransform, it.transform);
    const sx = Math.hypot(m[0], m[1]);
    const fs = Math.hypot(m[2], m[3]) || sx || 1;
    const dirX = sx ? m[0] / sx : 1;
    const dirY = sx ? m[1] / sx : 0;
    const style = styles[it.fontName] || {};
    const vis = stripDropped(it.str);
    const rotated = Boolean(style.vertical) || Math.abs(dirY) > 0.12 || dirX < 0;
    const width = style.vertical ? (it.height || 0) : (it.width || 0);
    items.push({
      i,
      str: it.str,
      x: m[4],
      y: m[5],
      w: width,
      fs,
      dirX,
      dirY,
      asc: style.ascent > 0 && style.ascent < 1.5 ? style.ascent : 0.8,
      font: it.fontName || '',
      eol: Boolean(it.hasEOL),
      rotated,
      empty: vis.length === 0,
      ws: vis.length > 0 && /^\s+$/.test(vis),
      vis,
      lineNo: false,
      dup: false,
    });
  });
  markLineNumberItems(items);
  return items;
}

function stripDropped(s) {
  let out = '';
  for (const ch of s) if (!DROP_CHAR.test(ch)) out += ch;
  return out;
}

/**
 * Manuscript line numbers: many bare integers at one x position outside the text column,
 * mostly increasing down the page. They are isolated into their own (furniture) lines.
 */
function markLineNumberItems(items) {
  const digits = items.filter((it) => !it.rotated && /^\s*\d{1,4}\s*$/.test(it.vis));
  if (digits.length < 8) return;
  const buckets = new Map();
  for (const it of digits) {
    const key = Math.round(it.x / 4);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(it);
  }
  const textItems = items.filter((it) => !it.rotated && /\p{L}{2}/u.test(it.vis));
  if (!textItems.length) return;
  const textLeft = Math.min(...textItems.map((it) => it.x));
  const textRight = Math.max(...textItems.map((it) => it.x + it.w));
  for (const group of buckets.values()) {
    if (group.length < 8) continue;
    const x = group[0].x;
    const outside = x < textLeft - 2 || x > textRight - 2 * group[0].fs;
    if (!outside) continue;
    const sorted = [...group].sort((a, b) => a.y - b.y);
    let increasing = 0;
    for (let k = 1; k < sorted.length; k++) if (Number(sorted[k].vis) > Number(sorted[k - 1].vis)) increasing++;
    if (increasing >= 0.7 * (sorted.length - 1)) group.forEach((it) => { it.lineNo = true; });
  }
}

// ---------------------------------------------------------------------------------------------
// Lines
// ---------------------------------------------------------------------------------------------

/** Group a page's items (pdf.js order) into visual lines. */
function buildLines(page) {
  const lines = [];
  let cur = null;
  const close = () => {
    if (cur && cur.textItems.length) lines.push(finishLine(cur, page.pageNumber));
    cur = null;
  };
  for (const it of page.items) {
    if (it.empty) {
      if (it.eol) close();
      continue;
    }
    if (it.lineNo) {
      close();
      cur = newLine(it);
      close();
      continue;
    }
    if (it.ws) {
      if (cur) cur.items.push(it);
      if (it.eol) close();
      continue;
    }
    if (cur && isDuplicate(cur, it)) {
      it.dup = true;
      continue;
    }
    if (cur && startsNewLine(cur, it)) close();
    if (!cur) cur = newLine(it);
    else addToLine(cur, it);
    if (it.eol) close();
  }
  close();
  return lines;
}

function newLine(it) {
  return { items: [it], textItems: it.ws ? [] : [it], ref: it, rotated: it.rotated, lineNo: it.lineNo };
}

function addToLine(line, it) {
  line.items.push(it);
  line.textItems.push(it);
  if (it.fs > line.ref.fs * 1.05 && it.vis.trim().length >= 2) line.ref = it;
}

/** Fake-bold overprint: the same string drawn again at (almost) the same spot. */
function isDuplicate(line, it) {
  const recent = line.textItems.slice(-3);
  return recent.some((p) => p.vis === it.vis && it.vis.trim().length > 0
    && Math.abs(p.x - it.x) < 0.2 * it.fs && Math.abs(p.y - it.y) < 0.2 * it.fs);
}

function startsNewLine(line, it) {
  if (it.rotated !== line.rotated) return true;
  const ref = line.ref;
  if (it.rotated && (Math.abs(it.dirX - ref.dirX) > 0.05 || Math.abs(it.dirY - ref.dirY) > 0.05)) return true;
  const h = Math.max(ref.fs, it.fs);
  // Offset perpendicular to the text direction (baseline distance).
  const perp = -(it.x - ref.x) * ref.dirY + (it.y - ref.y) * ref.dirX;
  if (Math.abs(perp) > 0.55 * h) return true;
  const last = line.textItems[line.textItems.length - 1];
  const along = alongGap(last, it);
  if (along < -2 * h) return true; // jumped back: next line / overprint elsewhere
  if (along > 3 * h) return true; // far to the right: separate region (table cell, other column, header part)
  return false;
}

/** Distance along the text direction from the end of `a` to the start of `b`. */
function alongGap(a, b) {
  const endX = a.x + a.w * a.dirX;
  const endY = a.y + a.w * a.dirY;
  return (b.x - endX) * a.dirX + (b.y - endY) * a.dirY;
}

/**
 * Line geometry is kept in the text's own frame (u along the baseline, v perpendicular, pointing down
 * the page for upright text) so rotated content such as landscape tables is grouped like normal text.
 * For upright text u = x and v = y. bx0…by1 is the page-space bounding box.
 */
function finishLine(raw, pageNumber) {
  const t = raw.textItems;
  const { dirX, dirY } = raw.ref;
  const u = (x, y) => x * dirX + y * dirY;
  let x0 = Infinity;
  let x1 = -Infinity;
  let bx0 = Infinity;
  let by0 = Infinity;
  let bx1 = -Infinity;
  let by1 = -Infinity;
  for (const it of t) {
    const ex = it.x + it.w * it.dirX;
    const ey = it.y + it.w * it.dirY;
    x0 = Math.min(x0, u(it.x, it.y), u(ex, ey));
    x1 = Math.max(x1, u(it.x, it.y), u(ex, ey));
    bx0 = Math.min(bx0, it.x, ex);
    bx1 = Math.max(bx1, it.x, ex);
    by0 = Math.min(by0, it.y - it.fs, ey - it.fs);
    by1 = Math.max(by1, it.y, ey);
  }
  const fsCount = new Map();
  const fontCount = new Map();
  for (const it of t) {
    const n = it.vis.replace(/\s/g, '').length;
    const fsKey = Math.round(it.fs * 4) / 4;
    fsCount.set(fsKey, (fsCount.get(fsKey) || 0) + n);
    fontCount.set(it.font, (fontCount.get(it.font) || 0) + n);
  }
  const lastRaw = [...raw.items].reverse().find((it) => it.str.length > 0);
  const line = {
    page: pageNumber,
    items: raw.items,
    rotated: raw.rotated,
    dirKey: raw.rotated ? `${Math.round(dirX * 10)},${Math.round(dirY * 10)}` : 'h',
    lineNo: raw.lineNo,
    x0,
    x1,
    y: -raw.ref.x * dirY + raw.ref.y * dirX,
    bx0,
    by0,
    bx1,
    by1,
    fs: argmax(fsCount),
    font: argmax(fontCount),
    furniture: raw.lineNo,
    softHyphen: Boolean(lastRaw && /\u00AD\s*$/.test(lastRaw.str)),
    joinBefore: '',
    text: '',
    chars: 0,
  };
  line.text = lineText(line);
  line.chars = line.text.replace(/\s/g, '').length;
  return line;
}

function argmax(counts) {
  let best = null;
  let bestN = -1;
  for (const [k, n] of counts) {
    if (n > bestN) { best = k; bestN = n; }
  }
  return best;
}

/** Whether a synthetic space goes between two adjacent items on one line. */
function needsGapSpace(prev, it) {
  return alongGap(prev, it) > 0.15 * Math.max(prev.fs, it.fs);
}

/**
 * Walk a line's visible characters exactly as they will be emitted.
 * @param {object} line
 * @param {{char(ch:string, item:number, off:number):void, space(item:number, off:number):void}} out
 */
function walkLine(line, out) {
  let prev = null;
  let prevText = null;
  const items = line.items;
  for (let n = 0; n < items.length; n++) {
    const it = items[n];
    if (it.dup || it.empty) continue;
    if (it.ws && prevText && !hasRealGapAfter(items, n, prevText)) continue; // zero-width " " item
    if (prev && !it.ws && !prev.ws && needsGapSpace(prev, it)) out.space(-1, -1);
    const s = it.str;
    for (let k = 0; k < s.length; k++) {
      const ch = s[k];
      if (DROP_CHAR.test(ch)) continue;
      if (WS_CHAR.test(ch)) out.space(it.i, k);
      else out.char(ch, it.i, k);
    }
    prev = it;
    if (!it.ws) prevText = it;
  }
}

/**
 * pdf.js sometimes emits standalone " " items where the glyphs actually touch ("10.1097/ WON.").
 * Such a space is kept only if the next text item really starts after a visible gap.
 */
function hasRealGapAfter(items, n, prevText) {
  for (let k = n + 1; k < items.length; k++) {
    const next = items[k];
    if (next.dup || next.empty || next.ws) continue;
    return alongGap(prevText, next) > 0.08 * Math.max(prevText.fs, next.fs);
  }
  return true; // trailing whitespace: harmless, collapsed at the line end
}

/** Plain text of a line (for heuristics), whitespace-collapsed. */
function lineText(line) {
  let s = '';
  let pendingSpace = false;
  walkLine(line, {
    char(ch) {
      if (pendingSpace && s) s += ' ';
      pendingSpace = false;
      s += ch;
    },
    space() { pendingSpace = true; },
  });
  return s;
}

// ---------------------------------------------------------------------------------------------
// Furniture (running heads/feet, page numbers, margin stamps, line numbers)
// ---------------------------------------------------------------------------------------------

function furnitureKey(text) {
  return text.toLowerCase().replace(/\d+/g, '#').replace(/[^\p{L}#]+/gu, ' ').trim();
}

function inBand(line, page) {
  if (line.rotated) return false;
  const top = line.y - line.fs;
  return line.y < page.height * 0.1 || top > page.height * 0.9;
}

function markFurniture(pages) {
  const pagesByKey = new Map();
  for (const p of pages) {
    for (const line of p.lines) {
      if (line.furniture || (!line.rotated && !inBand(line, p)) || CAPTION_RE.test(line.text)) continue;
      const textKey = furnitureKey(line.text);
      if (!textKey) continue;
      const pos = line.rotated ? 'rot:' : line.by1 < p.height / 2 ? 'top:' : 'bottom:';
      const key = pos + textKey;
      if (!pagesByKey.has(key)) pagesByKey.set(key, new Set());
      pagesByKey.get(key).add(p.pageNumber);
      line.furnitureKey = key;
    }
  }
  const minRepeats = pages.length >= 3 ? 3 : 2;
  const repeatedKeys = [...pagesByKey].filter(([, set]) => set.size >= minRepeats).map(([key]) => key);
  // A one-off variant of a running head/foot ("… Nurses • Vol 18 No 3" on page 1) contains a repeated key.
  const containsRepeated = (key) => repeatedKeys.some((r) => {
    const [pos, text] = [r.slice(0, r.indexOf(':') + 1), r.slice(r.indexOf(':') + 1)];
    return text.length >= 12 && key.startsWith(pos) && key.includes(text);
  });
  for (const p of pages) {
    const rotatedShare = rotatedCharShare(p);
    for (const line of p.lines) {
      if (line.furniture) continue;
      const repeated = line.furnitureKey
        && (pagesByKey.get(line.furnitureKey).size >= minRepeats || containsRepeated(line.furnitureKey));
      if (line.rotated) {
        // Margin stamps ("Downloaded from …") and stray rotated labels are furniture; a rotated
        // landscape table or figure page is content.
        const inSideMargin = line.bx1 < p.width * 0.1 || line.bx0 > p.width * 0.9;
        if (repeated || inSideMargin || (rotatedShare < 0.3 && line.chars < 40)) line.furniture = true;
        continue;
      }
      const bareNumber = PAGE_NUMBER_RE.test(line.text.trim()) && inBand(line, p);
      if (bareNumber || repeated) line.furniture = true;
    }
  }
}

function rotatedCharShare(page) {
  let rotated = 0;
  let all = 0;
  for (const l of page.lines) {
    all += l.chars;
    if (l.rotated) rotated += l.chars;
  }
  return all ? rotated / all : 0;
}

// ---------------------------------------------------------------------------------------------
// Document statistics
// ---------------------------------------------------------------------------------------------

function computeStats(pages) {
  const sizeCount = new Map();
  for (const p of pages) {
    for (const l of p.lines) {
      if (l.furniture) continue;
      const key = Math.round(l.fs * 2) / 2;
      sizeCount.set(key, (sizeCount.get(key) || 0) + l.chars);
    }
  }
  const bodySize = argmax(sizeCount) || 10;
  const fontCount = new Map();
  const spacingCount = new Map();
  for (const p of pages) {
    let prev = null;
    for (const l of p.lines) {
      if (l.furniture) { prev = null; continue; }
      const isBody = Math.abs(l.fs - bodySize) <= 0.35 * Math.max(1, bodySize / 10) + 0.25;
      if (isBody) fontCount.set(l.font, (fontCount.get(l.font) || 0) + l.chars);
      if (prev && isBody && Math.abs(prev.fs - l.fs) < 0.5) {
        const dy = l.y - prev.y;
        if (dy > 0.8 * bodySize && dy < 2.6 * bodySize && overlapRatio(prev, l) > 0.3) {
          const key = Math.round(dy * 2) / 2;
          spacingCount.set(key, (spacingCount.get(key) || 0) + 1);
        }
      }
      prev = l;
    }
  }
  const spacing = argmax(spacingCount) || bodySize * 1.2;
  // OCR text layers (scans) use one invisible font with noisy sizes: font cues are meaningless there.
  const fonts = new Set();
  const widthCount = new Map();
  for (const p of pages) {
    for (const l of p.lines) {
      if (l.furniture) continue;
      fonts.add(l.font);
      if (Math.abs(l.fs - bodySize) < 0.5) {
        const key = Math.round((l.x1 - l.x0) / 4) * 4;
        widthCount.set(key, (widthCount.get(key) || 0) + 1);
      }
    }
  }
  return {
    bodySize,
    mainFont: argmax(fontCount) || '',
    spacingRatio: spacing / bodySize,
    singleFont: fonts.size <= 1,
    columnWidth: argmax(widthCount) || 0, // typical full body line (one column)
  };
}

function overlapRatio(a, b) {
  const ov = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
  const minW = Math.max(1, Math.min(a.x1 - a.x0, b.x1 - b.x0));
  return ov / minW;
}

// ---------------------------------------------------------------------------------------------
// Blocks (paragraph candidates)
// ---------------------------------------------------------------------------------------------

function newBlock(line) {
  return { page: line.page, lines: [line], left: line.x0, right: line.x1, kind: 'body', text: '', fs: line.fs,
    font: line.font, merged: false, spansTo: line.page };
}

function buildBlocks(page, stats) {
  const blocks = [];
  let cur = null;
  for (const line of page.lines) {
    if (line.furniture) {
      if (cur) blocks.push(cur);
      cur = null;
      const b = newBlock(line);
      b.kind = 'furniture';
      blocks.push(b);
      continue;
    }
    if (cur && breaksBlock(cur, line, stats)) {
      blocks.push(cur);
      cur = null;
    }
    if (!cur) {
      cur = newBlock(line);
    } else {
      cur.lines.push(line);
      cur.left = Math.min(cur.left, line.x0);
      cur.right = Math.max(cur.right, line.x1);
    }
  }
  if (cur) blocks.push(cur);
  return blocks;
}

/** Whether line C starts a new block after block B. */
function breaksBlock(B, C, stats) {
  const P = B.lines[B.lines.length - 1];
  if (P.dirKey !== C.dirKey) return true;
  const fs = Math.max(P.fs, C.fs);
  const minFs = Math.min(P.fs, C.fs);
  const dy = C.y - P.y;
  if (dy < 0.3 * minFs) return true; // moved up (new column) or same baseline (separate region)
  if (dy > P.fs * stats.spacingRatio * 1.3 + 0.05 * fs) return true; // vertical gap
  const rel = Math.abs(P.fs - C.fs) / fs;
  if (rel > 0.15) return true;
  if (rel > 0.06 && P.font !== C.font) return true;
  const width = Math.max(1, Math.min(B.right - B.left, C.x1 - C.x0));
  const overlap = Math.min(B.right, C.x1) - Math.max(B.left, C.x0);
  if (overlap < 0.5 * width) return true; // different column
  const pText = P.text;
  const pTerminal = TERMINAL_RE.test(pText);
  const indent = C.x0 - P.x0;
  if (pTerminal && indent > 0.7 * fs && indent < 8 * fs) return true; // first-line indent
  const right = Math.max(B.right, C.x1);
  if (pTerminal && right - P.x1 > 2.5 * fs && C.x0 <= B.left + 0.7 * fs) return true; // short last line
  if (B.lines.length === 1 && P.font !== C.font && !pTerminal && pText.length < 100
    && P.x1 - P.x0 < 0.7 * (right - B.left) && /^[\p{Lu}\d]/u.test(pText)) return true; // heading line
  if (B.lines.length >= 2) {
    const first = B.lines[0];
    const second = B.lines[1];
    if (second.x0 - first.x0 > 0.7 * fs && Math.abs(C.x0 - first.x0) < 0.5 * fs) return true; // hanging indent
  }
  if (pTerminal && /^(\[\d{1,3}\]|\d{1,3}\.\s|[•▪◦●■]\s?)/.test(C.text)) return true; // list / numbered entry
  if (B.lines.length === 1 && SECTION_NAME_RE.test(stripSectionNumber(pText))) return true; // "REFERENCES"
  return false;
}

/** Compute text preview and dominant font/size of a block. */
function finishBlock(b) {
  b.text = b.lines.map((l) => l.text).join(' ');
  const fsCount = new Map();
  const fontCount = new Map();
  for (const l of b.lines) {
    const key = Math.round(l.fs * 4) / 4;
    fsCount.set(key, (fsCount.get(key) || 0) + l.chars);
    fontCount.set(l.font, (fontCount.get(l.font) || 0) + l.chars);
  }
  b.fs = argmax(fsCount) || b.lines[0].fs;
  b.font = argmax(fontCount) || b.lines[0].font;
  b.left = Math.min(...b.lines.map((l) => l.x0));
  b.right = Math.max(...b.lines.map((l) => l.x1));
}

// ---------------------------------------------------------------------------------------------
// Block kinds
// ---------------------------------------------------------------------------------------------

function stripSectionNumber(text) {
  return text.replace(SECTION_NUMBER_RE, '').replace(/[\s:.]+$/, '').trim();
}

function letterCount(s) {
  return (s.match(/\p{L}/gu) || []).length;
}

function isCaption(b, stats) {
  const t = b.text;
  if (!CAPTION_RE.test(t)) return false;
  if (CAPTION_PUNCT_RE.test(t)) return true;
  return b.font !== stats.mainFont || Math.abs(b.fs - stats.bodySize) > 0.5;
}

function isHeading(b, stats) {
  const t = b.text.trim();
  if (b.lines.length > 3 || t.length > 200 || !/\p{L}{3}/u.test(t)) return false; // "Po Pc" = math
  if (/^\p{Ll}/u.test(t)) return false;
  if (/[.,;]$/.test(t) || /\.["”’)]?$/.test(t)) return false;
  if (stats.singleFont) {
    // Scanned text layer: only a clearly larger size or an all-caps short line marks a heading.
    const letters = t.replace(/[^\p{L}]/gu, '');
    const caps = letters.length >= 4 && letters === letters.toUpperCase();
    return b.lines.length <= 2 && t.length <= 100 && (b.fs >= stats.bodySize * 1.25 || caps);
  }
  const bigger = b.fs >= stats.bodySize * 1.08;
  if (bigger) return true;
  if (b.fs < stats.bodySize * 0.9) return false;
  const short = t.length <= 120 && b.lines.length <= 2;
  if (!short || /[?!]$/.test(t)) return false;
  const letters = t.replace(/[^\p{L}]/gu, '');
  const caps = letters.length >= 3 && letters === letters.toUpperCase();
  if (b.font !== stats.mainFont || caps) return true;
  return /^(\d+(\.\d+)*\.?|[IVX]{1,5}\.)\s+\p{Lu}/u.test(t) && t.length <= 90 && b.lines.length === 1;
}

/**
 * A short bold line directly above a paragraph of the same size (back-matter headings such as
 * "Conflicts of Interest" are often set in the small back-matter font, not the body size).
 */
function isRunningHeading(b, next, stats) {
  if (!next || stats.singleFont || next.kind !== 'body' || b.lines.length !== 1) return false;
  const t = b.text.trim();
  if (t.length > 80 || TERMINAL_RE.test(t) || /[,;:]$/.test(t) || !/^[\p{Lu}\d]/u.test(t)) return false;
  return b.font !== next.font && Math.abs(b.fs - next.fs) < 0.5 && next.text.length > t.length;
}

/** Assign kind to every block; 'reference' for everything after the references heading. */
function classifyBlocks(blocks, stats, numPages) {
  for (const b of blocks) {
    if (b.kind === 'furniture') continue;
    if (letterCount(b.text) < 2) b.kind = 'furniture';
    else if (isCaption(b, stats)) b.kind = 'caption';
    else if (isHeading(b, stats)) b.kind = 'heading';
    else b.kind = 'body';
  }
  const content = blocks.filter((b) => b.kind !== 'furniture');
  content.forEach((b, k) => {
    if (b.kind === 'body' && isRunningHeading(b, content[k + 1], stats)) b.kind = 'heading';
    // "Table 2." on its own line, title in the next block (set off from the body type).
    const prev = content[k - 1];
    if (b.kind === 'body' && prev?.kind === 'caption' && prev.text.length <= 20 && prev.page === b.page
      && (Math.abs(b.fs - stats.bodySize) > 0.5 || b.font !== stats.mainFont)) b.kind = 'caption';
  });
  let inRefs = false;
  for (const b of content) {
    const name = stripSectionNumber(b.text);
    if (b.kind === 'heading' && REF_HEADING_RE.test(name) && (b.page > 1 || numPages <= 2)) {
      inRefs = true;
      b.isRefHeading = true;
      continue;
    }
    // "Appendix." / "Acknowledgments" after the list ends it (often set like a run-in heading).
    if (inRefs && b.text.length <= 60 && END_REF_RE.test(name) && b.kind !== 'caption') {
      inRefs = false;
      b.kind = 'heading';
      continue;
    }
    if (inRefs && (b.kind === 'body' || b.kind === 'heading')) b.kind = 'reference';
  }
}

// ---------------------------------------------------------------------------------------------
// Merges: drop caps and paragraphs that continue across columns / pages / interruptions
// ---------------------------------------------------------------------------------------------

function mergeDropCaps(pages, stats) {
  for (const p of pages) {
    const bs = p.blocks;
    for (let k = 0; k < bs.length - 1; k++) {
      const d = bs[k];
      if (d.merged || d.lines.length !== 1 || d.fs < 2 * stats.bodySize) continue;
      if (!/^\p{Lu}{1,2}$/u.test(d.text.trim())) continue;
      const q = bs.slice(k + 1).find((b) => !b.merged && b.kind !== 'furniture');
      if (!q || q.kind !== 'body' || !/^\p{Ll}/u.test(q.text)) continue;
      q.lines[0].joinBefore = 'none';
      q.lines.unshift(d.lines[0]);
      q.text = d.text.trim() + q.text;
      d.merged = true;
    }
    p.blocks = bs.filter((b) => !b.merged);
  }
}

function isOpenEnded(b) {
  const t = b.text.trim();
  if (!t) return false;
  if (!TERMINAL_RE.test(t)) return true;
  return ABBREV_END_RE.test(t); // ends with "et al." / "e.g." etc.
}

function continuesInto(p, q) {
  const end = p.text.trim();
  const start = q.text.trim();
  if (/^\p{Ll}/u.test(start)) return true;
  if (/[,;(\-–—/&]$/.test(end)) return true;
  const lastWord = (end.match(/(\p{L}+)$/u) || [])[1];
  if (lastWord && FUNCTION_WORDS.has(lastWord.toLowerCase())) return true;
  if (/[\p{L}\d]$/u.test(end) && /^[\d([]/u.test(start)) return true;
  return false;
}

/** Same kind, direction and type size (OCR layers have noisy sizes, so they get more slack). */
function bodyLike(q, p, stats) {
  const tolerance = stats.singleFont ? 0.15 : 0.06;
  return q.kind === p.kind && q.lines[0].dirKey === p.lines[0].dirKey
    && Math.abs(q.fs - p.fs) / Math.max(q.fs, p.fs) <= tolerance;
}

/**
 * Join a paragraph that ends mid-sentence with the next body block of the same style,
 * skipping interruptions (furniture, captions, footnotes, side boxes) in between.
 * At most one page boundary per paragraph, so every page keeps a contiguous text range.
 */
function mergeContinuations(pages, stats) {
  const order = pages.flatMap((p) => p.blocks);
  const pagesWithTail = new Set();
  for (let k = 0; k < order.length; k++) {
    const p = order[k];
    if (p.merged || (p.kind !== 'body' && p.kind !== 'reference')) continue;
    let guard = 0;
    while (isOpenEnded(p) && guard++ < 6) {
      const q = findContinuation(order, k, p, stats);
      if (!q) break;
      const lastPage = p.lines[p.lines.length - 1].page;
      if (q.page !== lastPage) {
        // Crossing into the next page: only one paragraph per page may do so, and only once.
        if (p.spansTo !== p.page || pagesWithTail.has(p.page) || q.page !== lastPage + 1) break;
        pagesWithTail.add(p.page);
      }
      p.lines.push(...q.lines);
      p.text = `${p.text} ${q.text}`;
      p.right = Math.max(p.right, q.right);
      p.spansTo = Math.max(p.spansTo, q.page);
      q.merged = true;
    }
  }
  for (const pg of pages) pg.blocks = pg.blocks.filter((b) => !b.merged);
}

function findContinuation(order, k, p, stats) {
  const startPage = p.lines[p.lines.length - 1].page;
  // Only same-style interruptions (floats set in the body font) count against the limit; furniture,
  // captions and other type sizes are skipped freely within this page and the next.
  let skippedSameStyle = 0;
  let afterHeading = false;
  for (let j = k + 1; j < order.length && skippedSameStyle <= 12; j++) {
    const q = order[j];
    if (q.merged) continue;
    if (q.page > startPage + 1) return null;
    if (q.kind === 'heading') {
      // A heading usually starts a new section, but sidebars ("Impact Statements") carry their own
      // headings; past one, only an unmistakable lowercase continuation is accepted.
      afterHeading = true;
      continue;
    }
    if (q.kind === 'furniture' || q.kind === 'caption' || !bodyLike(q, p, stats)) continue;
    if (q.page === startPage && precedesInReading(q.lines[0], p.lines[p.lines.length - 1])) {
      skippedSameStyle++;
      continue;
    }
    const qText = q.text.trim();
    const lowercaseStart = /^\p{Ll}/u.test(qText);
    if (afterHeading && !lowercaseStart) return null;
    const flow = isFlowBlock(q, stats);
    if ((!lowercaseStart && !flow) || (!flow && /^\p{Ll}\s+\p{Lu}/u.test(qText))) {
      skippedSameStyle++; // table cell / figure label in the body font, or a table footnote ("a Hypothetical data")
      continue;
    }
    return continuesInto(p, q) ? q : null;
  }
  return null;
}

/** Running text: some line spans (nearly) the typical column width. */
function isFlowBlock(b, stats) {
  if (!stats.columnWidth) return true;
  return b.lines.some((l) => l.x1 - l.x0 >= 0.8 * stats.columnWidth);
}

/**
 * Column-major reading order on one page: is line `a` read before line `b`? Used to skip boxes and
 * floats that the content stream draws late but that sit earlier on the page (top-left sidebars).
 */
function precedesInReading(a, b) {
  if (overlapRatio(a, b) > 0.3) return a.y < b.y; // same column: above comes first
  return a.x1 <= b.x0 + 1; // a whole column to the left
}

// ---------------------------------------------------------------------------------------------
// De-hyphenation lexicon
// ---------------------------------------------------------------------------------------------

const WORD_RE = /\p{L}[\p{L}\p{M}'’]*(?:-\p{L}[\p{L}\p{M}'’]*)*/gu;

/** Word sets used to decide whether a line-final hyphen is a real hyphen. */
function buildLexicon(pages) {
  const words = new Map();
  const compounds = new Set();
  for (const p of pages) {
    let prevEndsHyphen = false;
    for (const line of p.lines) {
      if (line.furniture) continue;
      const tokens = line.text.match(WORD_RE) || [];
      const endsHyphen = /[-\u2010\u2011]$/.test(line.text);
      tokens.forEach((tok, idx) => {
        if (prevEndsHyphen && idx === 0) return; // fragment after a line-end hyphen
        if (endsHyphen && idx === tokens.length - 1) return; // fragment before it
        const lower = tok.toLowerCase();
        if (lower.includes('-')) {
          // Store adjacent pairs so "intention-" + "to-treat" finds "intention-to".
          const parts = lower.split('-');
          for (let n = 0; n + 1 < parts.length; n++) compounds.add(`${parts[n]}-${parts[n + 1]}`);
          for (const part of parts) words.set(part, (words.get(part) || 0) + 1);
        } else {
          words.set(lower, (words.get(lower) || 0) + 1);
        }
      });
      prevEndsHyphen = endsHyphen;
    }
  }
  return { words, compounds };
}

/** 'keep' → real hyphen ("meta-analysis"), 'drop' → typesetting hyphenation ("interven-tion"). */
function hyphenDecision(left, right, lex) {
  const l = left.toLowerCase();
  const r = right.toLowerCase();
  if (lex.compounds.has(`${l}-${r}`)) return 'keep';
  if (lex.words.has(l + r)) return 'drop';
  if (l.length >= 3 && r.length >= 4 && lex.words.has(l) && lex.words.has(r)) return 'keep';
  return 'drop';
}

// ---------------------------------------------------------------------------------------------
// Emission: blocks → doc.text + reversible map
// ---------------------------------------------------------------------------------------------

class TextSink {
  constructor(pages) {
    /** @type {string[]} one UTF-16 code unit per entry */
    this.parts = [];
    this.cPage = [];
    this.cItem = [];
    this.cOff = [];
    this.pending = null;
    /** itemToDoc[pageNumber][itemIndex] = Int32Array(str.length) of doc offsets (−1 = dropped) */
    this.itemToDoc = [null];
    for (const p of pages) {
      const arrs = [];
      for (const it of p.items) arrs[it.i] = new Int32Array(it.str.length).fill(-1);
      this.itemToDoc[p.pageNumber] = arrs;
    }
  }

  get length() { return this.parts.length; }

  lastChar() { return this.parts.length ? this.parts[this.parts.length - 1] : ''; }

  charAt(k) { return this.parts[k] ?? ''; }

  push(ch, page, item, off) {
    const k = this.parts.length;
    this.parts.push(ch);
    this.cPage.push(page);
    this.cItem.push(item);
    this.cOff.push(off);
    if (item >= 0) this.itemToDoc[page][item][off] = k;
  }

  char(ch, page, item, off) {
    if (this.pending) {
      const s = this.pending;
      this.pending = null;
      this.push(' ', s.page, s.item, s.off);
    }
    this.push(ch, page, item, off);
  }

  /** Request a space; runs of whitespace collapse to the first one, none at a paragraph start. */
  space(page = -1, item = -1, off = -1) {
    if (this.pending) return;
    const last = this.lastChar();
    if (last === '' || last === '\n' || last === ' ') return;
    this.pending = item >= 0 ? { page, item, off } : { page: -1, item: -1, off: -1 };
  }

  dropPending() { this.pending = null; }

  paragraphBreak() {
    this.pending = null;
    if (!this.parts.length || this.lastChar() === '\n') return;
    this.push('\n', -1, -1, -1);
    this.push('\n', -1, -1, -1);
  }

  /** Remove the last emitted char (used to drop a line-end hyphen). */
  pop() {
    const k = this.parts.length - 1;
    if (k < 0) return;
    if (this.cItem[k] >= 0) this.itemToDoc[this.cPage[k]][this.cItem[k]][this.cOff[k]] = -1;
    this.parts.pop();
    this.cPage.pop();
    this.cItem.pop();
    this.cOff.pop();
  }

  toMap() {
    return {
      charPage: Int32Array.from(this.cPage),
      charItem: Int32Array.from(this.cItem),
      charOff: Int32Array.from(this.cOff),
    };
  }
}

/**
 * Emit pages in order. Within a page: furniture first, then blocks in pdf.js order, with the
 * block that continues onto the next page (if any) last, so the continuation stays contiguous.
 * @returns {object[]} blocks in emission order, each with .start/.end doc offsets
 */
function emitDocument(pages, sink, lex) {
  const ordered = [];
  for (const p of pages) {
    const furniture = p.blocks.filter((b) => b.kind === 'furniture');
    const rest = p.blocks.filter((b) => b.kind !== 'furniture');
    const tail = rest.find((b) => b.spansTo > b.page);
    const seq = [...furniture, ...rest.filter((b) => b !== tail), ...(tail ? [tail] : [])];
    for (const b of seq) {
      sink.paragraphBreak();
      b.start = sink.length;
      emitBlock(b, sink, lex);
      sink.dropPending();
      b.end = sink.length;
      if (b.end > b.start) ordered.push(b);
    }
  }
  sink.dropPending();
  return ordered;
}

function emitBlock(block, sink, lex) {
  block.lines.forEach((line, k) => {
    if (k > 0) joinLines(block.lines[k - 1], line, sink, lex);
    const page = line.page;
    walkLine(line, {
      char: (ch, item, off) => sink.char(ch, page, item, off),
      space: (item, off) => sink.space(page, item, off),
    });
  });
}

/** Line-break join rule: de-hyphenate, keep compound hyphens, otherwise one space. */
function joinLines(prev, line, sink, lex) {
  sink.dropPending();
  if (line.joinBefore === 'none' || prev.softHyphen) return;
  const last = sink.lastChar();
  const next = line.text;
  if (HYPHENS.has(last)) {
    const left = trailingWord(sink);
    const right = (next.match(/^[\p{L}\p{M}]+/u) || [''])[0];
    if (!left) { sink.space(); return; }
    if (/^\p{Ll}/u.test(right)) {
      if (hyphenDecision(left, right, lex) === 'drop') sink.pop();
      return;
    }
    if (/^[\p{Lu}\d]/u.test(next)) return; // "non-" + "RCTs", "COVID-" + "19"
    sink.space();
    return;
  }
  if (DASHES.has(last) && sink.charAt(sink.length - 2) !== ' ') return;
  if (last === '/' && /^\S/.test(next)) return;
  sink.space();
}

/** Letters immediately before the final (hyphen) char. */
function trailingWord(sink) {
  let k = sink.length - 2;
  let s = '';
  while (k >= 0 && /[\p{L}\p{M}]/u.test(sink.charAt(k))) s = sink.charAt(k--) + s;
  return s;
}

function pageInfos(pages, charPage, length) {
  const starts = new Map();
  for (let k = 0; k < charPage.length; k++) {
    const pg = charPage[k];
    if (pg > 0 && !starts.has(pg)) starts.set(pg, k);
  }
  const infos = [];
  let cursor = 0;
  for (const p of pages) {
    const start = starts.has(p.pageNumber) ? Math.max(cursor, starts.get(p.pageNumber)) : cursor;
    infos.push({ pageNumber: p.pageNumber, width: p.width, height: p.height, textStart: start, textEnd: start });
    cursor = start;
  }
  for (let k = 0; k < infos.length; k++) {
    infos[k].textEnd = k + 1 < infos.length ? infos[k + 1].textStart : length;
  }
  return infos;
}

/** Axis-aligned item boxes per page: Float32Array [x, top, w, h] × items, PDF units, top-left origin. */
function buildGeometry(pages) {
  const geom = [null];
  for (const p of pages) {
    const n = p.items.length ? p.items[p.items.length - 1].i + 1 : 0;
    const g = new Float32Array(n * 4);
    for (const it of p.items) {
      const ax = it.x - it.fs * it.asc * -it.dirY; // top-left corner of the glyph box
      const ay = it.y - it.fs * it.asc * it.dirX;
      const bx = ax + it.w * it.dirX;
      const by = ay + it.w * it.dirY;
      const cx = ax + it.fs * -it.dirY;
      const cy = ay + it.fs * it.dirX;
      const xs = [ax, bx, cx, bx + cx - ax];
      const ys = [ay, by, cy, by + cy - ay];
      const x = Math.min(...xs);
      const y = Math.min(...ys);
      g.set([x, y, Math.max(...xs) - x, Math.max(...ys) - y], it.i * 4);
    }
    geom[p.pageNumber] = g;
  }
  return geom;
}

/** A text layer worth using: enough non-furniture text (scanned PDFs often carry only margin stamps). */
function hasRealText(doc, numPages) {
  let n = 0;
  for (const s of doc.sentences) {
    if (s.kind === 'furniture') continue;
    for (let k = s.start; k < s.end; k++) if (!WS_CHAR.test(doc.text[k])) n++;
  }
  return n >= Math.min(2000, Math.max(200, 80 * numPages));
}

// ---------------------------------------------------------------------------------------------
// Paragraphs & sentences
// ---------------------------------------------------------------------------------------------

let segmenter = null;
function getSegmenter() {
  segmenter ??= new Intl.Segmenter('en', { granularity: 'sentence' });
  return segmenter;
}

function buildParagraphs(doc, ordered) {
  const { text } = doc;
  const charPage = doc._map.charPage;
  const paraCount = new Map();
  const sentCount = new Map();
  const pageAt = (start, end) => {
    for (let k = start; k < end; k++) if (charPage[k] > 0) return charPage[k];
    return docOffsetToPage(doc, start);
  };
  for (const b of ordered) {
    const page = pageAt(b.start, b.end);
    const n = paraCount.get(page) || 0;
    paraCount.set(page, n + 1);
    const pid = `p${page}-g${n}`;
    const para = { pid, page, sids: [], kind: b.kind };
    const spans = b.kind === 'reference'
      ? splitReferenceEntries(text, b.start, b.end)
      : segmentSentences(text, b.start, b.end);
    for (const [s, e] of spans) {
      const sPage = pageAt(s, e);
      const idx = sentCount.get(sPage) || 0;
      sentCount.set(sPage, idx + 1);
      const pagesSet = new Set();
      for (let k = s; k < e; k++) if (charPage[k] > 0) pagesSet.add(charPage[k]);
      const sentence = {
        sid: `p${sPage}-${idx}`,
        start: s,
        end: e,
        text: text.slice(s, e),
        page: sPage,
        pages: [...pagesSet].sort((x, y) => x - y),
        pid,
        kind: b.kind,
      };
      doc.sentences.push(sentence);
      doc.sentenceById.set(sentence.sid, sentence);
      para.sids.push(sentence.sid);
    }
    b.pid = pid;
    if (para.sids.length) doc.paragraphs.push(para);
  }
}

/** Trim whitespace off [s, e). Returns null when empty. */
function trimSpan(text, s, e) {
  while (s < e && WS_CHAR.test(text[s])) s++;
  while (e > s && WS_CHAR.test(text[e - 1])) e--;
  return e > s ? [s, e] : null;
}

/**
 * Sentence spans in paragraph [start, end): Intl.Segmenter, then academic repairs.
 * @returns {Array<[number, number]>}
 */
function segmentSentences(text, start, end) {
  const para = text.slice(start, end);
  let spans = [];
  for (const seg of getSegmenter().segment(para)) {
    const span = trimSpan(text, start + seg.index, start + seg.index + seg.segment.length);
    if (span) spans.push(span);
  }
  spans = splitAfterCitations(text, spans);
  spans = repairFalseBreaks(text, spans);
  return spans.flatMap(([s, e]) => splitLong(text, s, e));
}

/** "…in the ICU.12 Patients…" → break after the superscript citation digits. */
function splitAfterCitations(text, spans) {
  const out = [];
  for (const [s, e] of spans) {
    let from = s;
    const chunk = text.slice(s, e);
    CITATION_AFTER_PERIOD_RE.lastIndex = 0;
    let m;
    while ((m = CITATION_AFTER_PERIOD_RE.exec(chunk))) {
      const cut = s + m.index + m[1].length + 1 + m[2].length;
      const span = trimSpan(text, from, cut);
      if (span && cut - from > 20) {
        out.push(span);
        from = cut;
      }
    }
    const rest = trimSpan(text, from, e);
    if (rest) out.push(rest);
  }
  return out;
}

function repairFalseBreaks(text, spans) {
  const out = [];
  for (const span of spans) {
    const prev = out[out.length - 1];
    if (prev && shouldJoin(text.slice(prev[0], prev[1]), text.slice(span[0], span[1]))) prev[1] = span[1];
    else out.push([span[0], span[1]]);
  }
  // A leading fragment without letters (e.g. "3).") joins the next sentence.
  if (out.length > 1 && letterCount(text.slice(out[0][0], out[0][1])) === 0) {
    out[1][0] = out[0][0];
    out.shift();
  }
  return out;
}

function shouldJoin(prev, cur) {
  if (ABBREV_END_RE.test(prev)) return true;
  if (INITIAL_END_RE.test(prev) && /^\p{Lu}/u.test(cur) && !/(^|\s)[AI]\.$/.test(prev)) return true;
  if (/^\p{Ll}/u.test(cur)) return true; // segmenter broke before a lowercase continuation
  if (letterCount(cur) === 0) return true; // "3)." / "[12]."
  if (/^[)\]},;:]/.test(cur)) return true;
  return false;
}

/** Split sentences longer than MAX_SENTENCE_CHARS at the "; " nearest to the middle. */
function splitLong(text, s, e) {
  if (e - s <= MAX_SENTENCE_CHARS) return [[s, e]];
  const chunk = text.slice(s, e);
  const mid = chunk.length / 2;
  let best = -1;
  for (let k = chunk.indexOf('; '); k !== -1; k = chunk.indexOf('; ', k + 1)) {
    if (best === -1 || Math.abs(k - mid) < Math.abs(best - mid)) best = k;
  }
  if (best === -1) return [[s, e]];
  const a = trimSpan(text, s, s + best + 1);
  const b = trimSpan(text, s + best + 1, e);
  return [...(a ? splitLong(text, a[0], a[1]) : []), ...(b ? splitLong(text, b[0], b[1]) : [])];
}

/**
 * Reference paragraphs: one sentence per entry. A paragraph that starts with an entry number and
 * contains the following numbers in sequence ("12. … 13. …" or "[12] … [13] …") is split per entry.
 */
function splitReferenceEntries(text, start, end) {
  const chunk = text.slice(start, end);
  const first = chunk.match(/^\s*(\[(\d{1,3})\]|(\d{1,3})\.)\s/);
  const cuts = [];
  if (first) {
    const bracket = Boolean(first[2]);
    let expect = Number(first[2] || first[3]);
    cuts.push(0);
    const re = bracket ? /(^|\s)\[(\d{1,3})\]\s/g : /(^|\s)(\d{1,3})\.\s+(?=\p{Lu})/gu;
    re.lastIndex = first[0].length;
    let m;
    while ((m = re.exec(chunk))) {
      if (Number(m[2]) !== expect + 1) continue;
      expect += 1;
      cuts.push(m.index + m[1].length);
    }
  }
  if (cuts.length < 2) {
    const span = trimSpan(text, start, end);
    return span ? splitLong(text, span[0], span[1]) : [];
  }
  const spans = [];
  cuts.forEach((c, k) => {
    const span = trimSpan(text, start + c, k + 1 < cuts.length ? start + cuts[k + 1] : end);
    if (span) spans.push(span);
  });
  return spans;
}

// ---------------------------------------------------------------------------------------------
// References
// ---------------------------------------------------------------------------------------------

function buildReferences(doc) {
  const refs = [];
  for (const para of doc.paragraphs) {
    if (para.kind !== 'reference') continue;
    for (const sid of para.sids) {
      const s = doc.sentenceById.get(sid);
      const num = s.text.match(/^\[?(\d{1,3})(?:[\].]\s|\s+(?=\p{Lu}))/u);
      refs.push({
        index: refs.length,
        n: num ? Number(num[1]) : null,
        text: s.text,
        start: s.start,
        end: s.end,
        page: s.page,
        bbox: rangeBox(doc, s.start, s.end, s.page),
      });
    }
  }
  return refs;
}

/** Union of item boxes for the chars of [start, end) that lie on `page`. */
function rangeBox(doc, start, end, page) {
  const { charPage, charItem } = doc._map;
  const g = doc._geom[page];
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  let lastItem = -1;
  for (let k = start; k < end; k++) {
    if (charPage[k] !== page || charItem[k] === lastItem) continue;
    lastItem = charItem[k];
    const o = lastItem * 4;
    x0 = Math.min(x0, g[o]);
    y0 = Math.min(y0, g[o + 1]);
    x1 = Math.max(x1, g[o] + g[o + 2]);
    y1 = Math.max(y1, g[o + 1] + g[o + 3]);
  }
  if (x0 === Infinity) return { x: 0, y: 0, w: 0, h: 0 };
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

// ---------------------------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------------------------

function buildMeta(info, pages, ordered, doc, stats) {
  const firstPageBlocks = pages[0]?.blocks || [];
  const title = pickTitle(info, firstPageBlocks, stats);
  return {
    title: title.text,
    authors: pickAuthors(info, firstPageBlocks, title),
    year: pickYear(info, pages.slice(0, 2)),
    abstract: pickAbstract(doc, ordered),
  };
}

function cleanSpaces(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

function saneInfoTitle(t) {
  if (t.length < 8 || t.length > 400 || !/\s/.test(t)) return false;
  if (/\.(pdf|docx?|tex|dvi|ps|indd|qxd|rtf)$/i.test(t)) return false;
  if (/^(untitled|title|microsoft\s+word|document\d*|manuscript|pii|doi|s\d{4}|\d)/i.test(t)) return false;
  return letterCount(t) >= 0.5 * t.length;
}

/** @returns {{text:string, block:object|null}} */
function pickTitle(info, blocks, stats) {
  const fromInfo = cleanSpaces(info?.Title);
  const candidates = blocks.filter((b) => b.kind !== 'furniture' && !b.merged
    && letterCount(b.text) >= 10 && /\s/.test(b.text.trim()) && !/^\p{Ll}/u.test(b.text.trim())
    && b.fs > stats.bodySize && b.text.length <= 400);
  let block = null;
  for (const b of candidates) if (!block || b.fs > block.fs + 0.1) block = b;
  if (saneInfoTitle(fromInfo)) {
    const infoKey = normalizeForCompare(fromInfo);
    const match = candidates.find((b) => {
      const key = normalizeForCompare(b.text);
      return key.includes(infoKey.slice(0, 30)) || (key.length >= 10 && infoKey.startsWith(key));
    });
    return { text: fromInfo, block: match || block };
  }
  if (!block) return { text: fromInfo && letterCount(fromInfo) > 3 ? fromInfo : '', block: null };
  // A title broken into several blocks (centered lines) — join same-size neighbours.
  const idx = blocks.indexOf(block);
  let text = block.text;
  for (let k = idx + 1; k < blocks.length; k++) {
    const b = blocks[k];
    if (b.kind === 'furniture') continue;
    if (Math.abs(b.fs - block.fs) > 0.3 || b.font !== block.font) break;
    text += ` ${b.text}`;
  }
  return { text: cleanSpaces(text.replace(/[\d*†‡§¶]+$/, '')), block };
}

function normalizeForCompare(s) {
  return s.toLowerCase().replace(/[^\p{L}\d]+/gu, '');
}

function saneInfoAuthor(a) {
  if (!a || a.length > 300 || letterCount(a) < 3) return false;
  return !/(admin|user|owner|microsoft|adobe|acrobat|pdf|elsevier|springer|wiley|@|\bhp\b|unknown)/i.test(a);
}

/** @param {{text:string, block:object|null}} title */
function pickAuthors(info, blocks, title) {
  const fromInfo = cleanSpaces(info?.Author);
  if (saneInfoAuthor(fromInfo)) return fromInfo;
  const titleBlock = title.block;
  const start = titleBlock ? blocks.indexOf(titleBlock) + 1 : 0;
  const titleKey = normalizeForCompare(title.text);
  for (let k = Math.max(0, start); k < Math.min(blocks.length, start + 8); k++) {
    const b = blocks[k];
    if (b.kind === 'furniture' || b === titleBlock) continue;
    if (titleKey && titleKey.includes(normalizeForCompare(b.text))) continue; // rest of a split title
    // Whole block first ("A, B and C" over two lines), then line by line ("JACOB COHEN" / "New York University").
    for (const text of [b.text, ...b.lines.map((l) => l.text)]) {
      const names = parseAuthorNames(text);
      if (names) return names;
    }
  }
  return '';
}

/** "Shu-Fen Lu 1,2 | Wen-Ju Yang 1 | …" → "Shu-Fen Lu, Wen-Ju Yang, …"; null when it doesn't look like names. */
function parseAuthorNames(text) {
  if (text.length > 400 || /[:@]|https?:|\b(university|department|hospital|abstract|keywords?)\b/i.test(text)) return null;
  const cleaned = text.replace(/\d+(?:\s*,\s*\d+)*|[*†‡§¶✉]/g, ' ');
  const tokens = cleaned.split(/\s*(?:[|,;&]|\band\b)\s*/i).map(cleanSpaces).filter(Boolean);
  if (!tokens.length) return null;
  const nameRe = /^(\p{Lu}[\p{L}'’.-]*|\p{Lu}\.)(\s+(\p{Lu}[\p{L}'’.-]*|\p{Lu}\.|de|van|von|der|da|di|la|le|del))*$/u;
  const names = tokens.filter((t) => nameRe.test(t) && t.split(/\s+/).length >= 2 && t.split(/\s+/).length <= 5);
  if (!names.length || names.length < 0.6 * tokens.length) return null;
  return names.map((n) => (n === n.toUpperCase() ? titleCase(n) : n)).join(', ');
}

function titleCase(s) {
  return s.toLowerCase().replace(/(^|[\s'’-])(\p{L})/gu, (m, a, b) => a + b.toUpperCase());
}

/** Publication year from © lines, publication dates, the info Subject and running heads; null if unsure. */
function pickYear(info, pages) {
  const scores = new Map();
  const add = (year, score) => {
    const y = Number(year);
    if (y < 1800 || y > 2100) return;
    scores.set(y, Math.max(scores.get(y) || 0, score) + 0.01);
  };
  const scrub = (s) => s.replace(/\b(doi:?\s*|https?:\/\/|www\.)\S+/gi, ' ').replace(/\b10\.\d{4,}\/\S+/g, ' ');
  for (const m of scrub(String(info?.Subject || '')).matchAll(/\b(1[89]\d\d|20\d\d)\b/g)) add(m[1], 4);
  for (const p of pages) {
    for (const line of p.lines) {
      const t = scrub(line.text);
      for (const m of t.matchAll(/©\s*(?:copyright\s*)?(1[89]\d\d|20\d\d)/gi)) add(m[1], 5);
      for (const m of t.matchAll(/\b(published|accepted|available online|first published)\b[^0-9]{0,40}(?:\d{1,2}\s+\p{L}+\.?\s+)?(1[89]\d\d|20\d\d)/giu)) add(m[2], 4.5);
      // Journal citation line: "Phys Ther. 2005;85:257–268", "Nursing in Critical Care, 2025; 30:e70196"
      for (const m of t.matchAll(/\b(1[89]\d\d|20\d\d)\s*;\s*\d+\s*[:(]/g)) add(m[1], 4);
      const band = line.furniture || inBand(line, p);
      if (band || p.pageNumber === 1) {
        for (const m of t.matchAll(/\b(1[89]\d\d|20\d\d)\b(?![\d.]*%)/g)) add(m[1], line.furniture ? 3 : band ? 2.5 : 1);
      }
    }
  }
  let best = null;
  let bestScore = 0;
  for (const [y, s] of scores) {
    if (s > bestScore || (s === bestScore && y > best)) { best = y; bestScore = s; }
  }
  return bestScore >= 2 ? best : null;
}

/** Paragraph(s) after an "Abstract" heading (or the first long paragraph on page 1), ≤ 2000 chars. */
function pickAbstract(doc, ordered) {
  const paras = ordered;
  let k = paras.findIndex((b) => b.kind === 'heading' && ABSTRACT_HEADING_RE.test(stripSectionNumber(b.text)));
  let parts = [];
  let firstFs = null;
  if (k !== -1) {
    for (let j = k + 1; j < paras.length && parts.join(' ').length < ABSTRACT_MAX_CHARS; j++) {
      const b = paras[j];
      if (b.kind === 'heading' || b.kind === 'reference') break;
      if (b.kind !== 'body') continue;
      firstFs ??= b.fs;
      if (Math.abs(b.fs - firstFs) / firstFs > 0.12) continue;
      parts.push(doc.text.slice(b.start, b.end));
      if (b.page > paras[k].page + 1) break;
    }
  }
  if (!parts.length) {
    const labeled = paras.find((b) => b.kind === 'body' && /^abstract\b/i.test(b.text));
    if (labeled) parts = [doc.text.slice(labeled.start, labeled.end).replace(/^abstract\b[\s.:—–-]*/i, '')];
  }
  if (!parts.length) {
    const firstPage = paras.filter((b) => b.kind === 'body' && b.page === 1);
    const long = firstPage.find((b) => b.end - b.start >= 400)
      || firstPage.reduce((best, b) => (!best || b.end - b.start > best.end - best.start ? b : best), null);
    if (long && long.end - long.start >= 200) parts = [doc.text.slice(long.start, long.end)];
  }
  return truncateAtSentence(cleanSpaces(parts.join(' ')), ABSTRACT_MAX_CHARS);
}

function truncateAtSentence(s, max) {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const lastStop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('? '), cut.lastIndexOf('! '));
  return lastStop > max * 0.6 ? cut.slice(0, lastStop + 1) : `${cut.trimEnd()}…`;
}
