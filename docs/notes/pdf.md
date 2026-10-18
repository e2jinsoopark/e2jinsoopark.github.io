# PDF module notes (`js/pdf/*`, `css/viewer.css`)

Owner files: `js/pdf/pdfjs.js`, `js/pdf/extract.js`, `js/pdf/viewer.js`, `css/viewer.css`, tests in `tests/pdf/`.
`SEG_VERSION = 1`.

## Status

All contract functions are implemented. Evidence on the four fixtures (2026-10-18, Edge via Playwright, all checks passing):

| fixture | pages | sentences | kinds (body/heading/caption/reference/furniture) | refs | extract (browser) | word match* | caret precision** |
|---|---|---|---|---|---|---|---|
| lu2025 | 13 | 604 | 393/50/5/19/137 | 19 | 160 ms | 100 % | 99.0 % |
| kiekkas2012 | 12 | 639 | 386/23/6/97/127 | 97 | 142 ms | 100 % | 99.3 % |
| simwright2005 | 12 | 931 | 372/10/16/60/473 | 60 | 137 ms | 100 % | 99.0 % |
| cohen1960 (OCR scan) | 10 | 186 | 143/2/1/8/32 | 8 | 77 ms | 100 % | 99.7 % |

\* 30 random sentences on rendered pages. For each one, points are sampled along every computed line box; the text-layer spans under them (`elementsFromPoint`) must contain ≥ 90 % of the sentence's words.
\** Share of those sample points whose `caretRangeFromPoint` position maps (via `_itemToDoc`) back into the sentence's `[start, end)`. This is a character-level alignment check.

The suite also covers hover, programmatic and mouse-drag selection, zoom 1.5 and 0.8, links (lu2025: 119 links, 91 internal and all resolved, 34 landing on reference entries), translation overlay, region capture (PNG at 2×), marks, `scrollToSentence` flash, `pagechange`/`visiblesentences`, canvas eviction and `destroy()`.

## Decisions and deviations from SPEC §2.1

1. **Page order within `doc.text`.** Each page is emitted as: furniture blocks first, then the other blocks in pdf.js order. A paragraph that continues onto the next page goes last, so it stays contiguous with its continuation.
   - When a paragraph runs across a page break, it is joined by the normal line rule (a space or de-hyphenation), **not** by `\n\n`. This is a deliberate deviation from "pages are separated by `\n\n`". Without it, every page break would split a sentence (`Sentence.pages` exists for this case).
   - Each page still occupies one contiguous range `[textStart, textEnd)`.
2. **Continuation merging.** A body paragraph that ends without terminal punctuation is joined to the next body block of the same type size and direction when that block continues it. The search skips:
   - furniture, captions and footnotes;
   - side boxes and floats that appear earlier in column-major reading order;
   - table cells set in the body font;
   - headings, but only when the next block starts in lowercase.

   At most one paragraph per page may cross into the next page, and only once. This keeps the per-page ranges contiguous.
3. **De-hyphenation.** This extends the SPEC rule. At a line-end hyphen followed by a lowercase word:
   - the hyphen is **kept** if `left-right` appears elsewhere in the document as a hyphenated pair (meta-analysis, intention-to-treat);
   - it is **dropped** if `leftright` appears as one word;
   - it is **kept** if both halves are frequent standalone words;
   - otherwise it is dropped.

   Other cases:
   - Uppercase or digit continuation ("non-" + "RCTs", "COVID-" + "19") keeps the hyphen with no space.
   - A line-final soft hyphen, en/em dash or `/` joins without a space.
4. **Dropped characters** are mapped to −1 in `_itemToDoc`. They are: control characters, soft hyphen, zero-width characters, U+FFFD, Private Use Area characters, standalone `" "` items with no visible gap ("10.1097/ WON" → "10.1097/WON"), and fake-bold overprint duplicates.
5. **Map layout.**
   - `doc._itemToDoc[pageNumber][itemIndex]`: index 0 is `null`, so page numbers are 1-based.
   - `doc._map.charPage` holds 1-based page numbers, or −1 for synthetic characters.
   - Item indices are pdf.js `getTextContent()` items with default options. These equal `TextLayer.textDivs` indices; the viewer verifies this on every page.
6. **Addition: `doc._geom[pageNumber]`.** A `Float32Array` holding `[x, top, w, h]` per item, in PDF units with top-left origin. It is used for scroll targets and estimates on pages that have not been rendered yet, and for `Reference.bbox`.
7. **Reference paragraphs** are not run through `Intl.Segmenter`. Each entry becomes one sentence. A paragraph holding consecutively numbered entries ("12. … 13. …", "[12] … [13]") is split per entry.
8. **Kinds.**
   - Blocks with fewer than 2 letters (table numbers, equation fragments) are `furniture`.
   - Rotated text is `furniture` only when it is a repeated or margin stamp ("Downloaded from …"). Landscape tables (kiekkas pp. 3–4) are content and are grouped in their own text frame.
   - Repeated running heads match on digit-normalised text. One-off variants that contain a repeated key ("… Nurses • Vol 18 No 3") also count. Caption-like lines never count as running heads.
   - A "Table 2." block on its own marks the following title block as a caption.
9. **`hasTextLayer`** is true when the non-furniture visible characters reach at least `min(2000, max(200, 80 × pages))`. **cohen1960 is not image-only:** it carries an OCR text layer, so `hasTextLayer` is `true`. Text quality there is OCR quality. Pages without any text render as canvas only.
10. **`meta`.**
    - Title: PDF Info if it looks sane; otherwise the largest multi-word block on page 1.
    - Authors: PDF Info if it looks sane; otherwise the name-like block or line after the title, with superscript markers stripped.
    - Year: scored candidates from ©, "Published/Accepted", journal citation lines, Info Subject and running heads. It is `null` when unsure (creation dates are never used).
    - Abstract: the paragraphs after an Abstract/Summary heading with the same type size; else a leading "Abstract" label; else the first long paragraph on page 1. At most 2000 characters, cut at a sentence end.
11. **`onProgress`** is called as `{ phase: 'text', done, total }` once per page read, then once as `{ phase: 'done', done: total, total }`. `reader-view.#onExtractProgress` already accepts this shape.

## Viewer additions and behaviour (SPEC §3.2)

- **Extra events:**
  - `zoomchange {zoom, mode: 'fit-width'|'manual'}`, for the toolbar's zoom percentage.
  - `markclick {layer, id, clientRect}`: marks are pointer-transparent, so clicks are hit-tested. `selection-menu.js` already listens for this.
- **`linkhover` / `target` extras.**
  - `target` keeps the SPEC fields `{page, x, y}` (user space, bottom-left origin) and adds:
    - `pt: {x, y}`: the destination in PDF units with top-left origin, exactly as `Reference.bbox` and `renderRegion` use them. It is crop-box and rotation correct.
    - `refIndex`: the index into `doc.references` when the destination lands on a reference entry.
    - `sid`: the sentence at the destination.
  - `features/citations.js` currently converts with `pageH - target.y`. That is off by the crop-box origin on PDFs whose MediaBox does not start at 0 (simwright2005 starts at 9,9). Prefer `target.pt` and `target.refIndex` when present.
- **`scrollToPdfPoint`** returns a Promise, because it needs the page proxy.
- **`setRegionCapture(true)`** stays on after a capture. The caller should turn it off, for example after `regioncapture`. Escape cancels a drag.
- **Marks.**
  - Colours: `yellow | green | blue | pink`, plus `red | purple | orange | gray`; any other value falls back to yellow.
  - Styles: `fill | underline`.
  - Geometry is measured from the text layer and cached per page in PDF units.
- **Translation overlay.**
  - Each paragraph region (split per column) is painted with the Korean text of the sentences whose larger area lies there. A sentence that crosses pages is written once, on its first page.
  - Missing translations show the English sentence in grey italics.
  - The font is shrunk until the text fits. Sizes use `--total-scale-factor`, so zooming needs no re-fit.
  - Overlay spans carry `data-sid` and drive hover and click.
- **Selection.**
  - Includes a port of pdf.js's `.endOfContent` selection helper.
  - `copy` puts the de-hyphenated `doc.text` slice on the clipboard.
  - `selectionchange` fires on pointerup, keyup, and debounced document selection changes (once per distinct anchor).
- **Zoom.** Ctrl or ⌘ + wheel / trackpad pinch zoom in proportion to the accumulated delta, once per frame, anchored at the pointer. Fit-width fits the median page width (an A0 appendix or a landscape table page overflows instead of shrinking the paper) and follows container resizes of ≥ 20 px; `.pdfv-root` reserves the scrollbar gutter. A `devicePixelRatio` change (other monitor, browser zoom) re-renders the near pages. Zoom is a single CSS variable (`--scale-factor`), and every cached geometry stays in PDF units.
- **Memory.** At most 10 live canvases **and** 48 MPx of canvas backing store, 24 live text layers; evicted pages call `page.cleanup()` (pdf.js frees their decoded images and operator lists — a 150-page scan stayed at ~650 MB GPU memory instead of 3.5 GB). A render that finishes after its page left the near zone is dropped, and leaving the zone cancels the render. Sentence geometry stays cached after eviction. Rendering is lazy (IntersectionObserver, about 1.5 viewports ahead, 2 pages at a time) and a new canvas is swapped in only when finished, so pages never flash blank on zoom.
- **Render failures** are retried after 5 s, at most twice per zoom level, with a "이 쪽을 표시하지 못했습니다" placeholder (no hot loop).
- **Rotated pages** (/Rotate 90/180/270): `.textLayer[data-main-rotation]` rules rotate pdf.js's unrotated text layer into the page box, and line merging uses span rotation + page rotation.
- **Translation overlay** redraws only pages whose sentences changed, and only near the viewport (others when they come near); paragraph geometry is computed once per page and text fitting is batched per page.
- **Links**: external links open only with Ctrl/⌘-click (the hover card has ‘새 탭에서 열기’); external link annotations covering more than 20 % of a page are ignored. Hover is re-hit-tested after a wheel scroll.
- **Extraction**: a page pdf.js cannot load becomes an empty page instead of failing the whole document.
- **Container.** The viewer adds class `pdfv-root` to the container, sets `tabindex=0` if absent, and owns its children (`destroy()` removes them).
- **`getSentenceRects` on never-rendered pages** returns estimates from item boxes, proportional within an item. It is exact once the page has rendered.

### Important finding: text-layer fonts and `<html lang="ko">`

pdf.js measures each item on a hidden canvas whose `lang` is the PDF's language, then stretches the span to the PDF width. The app's `<html lang="ko">` (and `lang=""` on a Korean-locale Windows) made the spans' generic `serif` resolve to **Batang** instead of Times. Every span came out 10–20 % too wide, so highlights drifted right.

The viewer now forces an explicit language on both sides (`textContent.lang ||= 'en'`, plus the same `lang` on the `.textLayer`).

A second issue: `Range.getClientRects()` covers the fallback font's whole content area, which is taller than the glyphs and shifted down. So line boxes take their cross-axis extent from the span box, which pdf.js places on the glyphs. Vertical (rotated) text is handled in a transposed frame.

## Known limitations

> Integration status: fit-width is capped at 1.6 and `.pdfv-root`'s `position` has zero specificity — see `integration.md`.

- **Two broken paragraph continuations,** both caused by the contiguous-page-range rule:
  - when a paragraph is interrupted by two full pages of tables (kiekkas p.2 → p.5);
  - when a paragraph would chain across three pages because the middle page is mostly a figure (lu2025 p.6 → p.8).

  The sentence is split at that point.
- **pdf.js 5.4.624 keeps every closed document alive** (`WorkerTransport` registers a `PagesMapper` listener that is never removed; ~0.3 MB per open). Not fixable from the app without patching the frozen vendor file — upgrade pdf.js when upstream fixes it.
- **Glyphs without a Unicode mapping are dropped.** For example, κ in simwright2005 comes out as "kappa ( ) statistic".
- **Tables come out as cell-level sentences** (kind `body`, or `heading` for bold cells). There is no table structure.
- **Interleaved two-column content streams are not reordered.** pdf.js order is trusted, as the SPEC says. No fixture needed reordering.
- **OCR layers (cohen1960) inherit OCR artefacts,** such as literal `&dquo;` and local reading-order glitches around equations.
- **Single-glyph spans** (superscripts, bullets) are not width-corrected by pdf.js, so their boxes can be a few pixels off. Whitespace is excluded from geometry entirely.
- **One Chromium edge case:** a drag that starts exactly on a line's first glyph boundary at one sub-pixel position produced an empty selection in a synthetic Playwright drag. ±2 px works. It is not reproducible as a user-facing issue, and the test drags from inside the line.

## How to test

```bash
# extraction only (Node 24, no browser): stats, invariants, 15 random body sentences per paper, full dumps
node tests/pdf/extract-node.mjs --samples=15 --dump          # dumps → C:/Users/dindoo/Projects/pr-tools/out/pdf/sentences-*.txt

# browser evidence suite (Edge via Playwright); serve the repo root first
python -m http.server 8101 --bind 127.0.0.1                 # from the repo root, in the background
node tests/pdf/viewer.test.mjs                               # all four fixtures; or pass fixture names
node tests/pdf/smoke.mjs lu2025                              # one outlined screenshot
```

Screenshots (`outline-*-p1/p2.png`, `hover-*.png`, `overlay-*-p2.png`, `capture-*.png`) and `viewer-results.json` go to `C:/Users/dindoo/Projects/pr-tools/out/pdf/`.

`tests/pdf/harness.html` opens any PDF via the file input and exposes `window.__pdf`, `__doc`, `__viewer`, `__events`, plus helpers (`__outlineSentences`, `__alignmentCheck`, `__selectDocRange`, `__renderAll`, `__linkSummary`).
