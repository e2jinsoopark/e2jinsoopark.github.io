# Paper Reader — architecture & module contracts

A Moonlight-style research-paper reader that runs as a **static site on GitHub Pages**
(no server, no build step). Korean UI. Target user: a Korean nursing researcher reading
English papers.

This file is the contract between modules. Each module is owned by one builder; builders
may only edit their own files plus add tests under `tests/<module>/`. If a contract is
unclear, implement the most reasonable reading and **write it down in
`docs/notes/<module>.md`** (decisions + any deviations) so the integrator can reconcile.

## 0. Ground rules (all modules)

- Plain ES modules (`<script type="module">`), modern evergreen browsers (Chrome/Edge/Safari 17+).
  No bundler, no npm runtime deps, no TypeScript. JSDoc types are welcome.
- Import vendored libs via `js/core/config.js → VENDOR` (pdf.js 5.4.624, marked 18, DOMPurify 3.4).
  The Anthropic SDK (`@anthropic-ai/sdk@0.131.0`) is loaded lazily from jsDelivr ESM — only in `js/ai/claude.js`.
- **Security:** PDF text and model output are untrusted. Never assign them to `innerHTML`
  except through `renderMarkdown()` (marked → DOMPurify). Use `el()` / `textContent` / `escapeHtml()`.
  No `eval`, no inline event-handler attributes. External links get `rel="noopener noreferrer" target="_blank"`.
- **No native dialogs** (`alert/confirm/prompt`) — use `ui/components.js` (modal, confirmDialog, toast).
- All user-visible strings in Korean. Light theme is the default; dark theme via `[data-theme="dark"]` on `<html>`.
- Shared helpers: `js/core/util.js` (escapeHtml, uid, hash, debounce, rafThrottle, el, safeStorage, base64…),
  `js/core/bus.js` (app event bus), `js/core/config.js`, `js/core/settings.js`. Do not duplicate these; do not edit them
  (ask the integrator via your notes file if you need a change).
- Errors: throw `Error` with a Korean, user-presentable `message`; log details with `console.warn('[module]', …)`.
- Tests: Node 24 + Playwright 1.63 are installed at `C:/Users/dindoo/Projects/pr-tools` (import from
  `C:/Users/dindoo/Projects/pr-tools/node_modules/playwright/index.mjs`). Launch with
  `chromium.launch({ channel: 'msedge' })` (Edge is installed; Chrome is not). Serve the repo with
  `python -m http.server <port>` from the repo root (run it in the background, kill it when done).
  Test PDFs (copyrighted — **never copy them into the repo, never send their text to any external API**):
  `C:/Users/dindoo/Projects/pr-fixtures/{lu2025,kiekkas2012,simwright2005,cohen1960}.pdf`
  (cohen1960 may be a scanned PDF with little/no text layer — must degrade gracefully).
- Use `?mock=1` (mock AI provider) for every automated test. Never call a paid API.

## 1. File layout & ownership

```
index.html                      UI-shell builder
css/app.css                     UI-shell builder (design tokens, layout, components)
css/viewer.css                  PDF builder (page/text-layer/overlay styles)
js/app.js                       UI-shell builder (bootstrap + hash router)
js/core/*                       integrator (frozen)
js/pdf/pdfjs.js                 PDF builder  — pdf.js loader
js/pdf/extract.js               PDF builder  — text extraction, sentences, paragraphs, references
js/pdf/viewer.js                PDF builder  — page rendering, text layer, overlays, hover/selection/links/capture
js/store/db.js                  Store builder — IndexedDB wrapper
js/store/github.js              Store builder — GitHub REST (git data API) client
js/store/sync.js                Store builder — local-first sync engine
js/store/merge.js               Store builder — merge rules for the synced JSON files (pure)
js/store/library.js             Store builder — Library model (folders, papers, per-paper data)
js/ai/providers.js              AI builder — provider registry
js/ai/claude.js                 AI builder — Claude via @anthropic-ai/sdk
js/ai/gemini.js                 AI builder — Gemini REST
js/ai/openai.js                 GPT (OpenAI) Responses API (docs/notes/openai.md)
js/ai/models.js                 automatic model choice + self-healing wrapper (docs/notes/models.md)
js/ai/mock.js                   AI builder — offline deterministic mock
js/ai/prompts.js                AI builder — all prompt text
js/ai/translator.js             AI builder — batching/caching translation orchestrator
js/ai/tasks.js                  AI builder — summarize / chat / explain / keyPoints / quickTranslate
js/ai/usage.js                  AI builder — token→USD accounting
js/ui/components.js             UI-shell builder — toast, modal, confirmDialog, popover, contextMenu, renderMarkdown, spinner
js/ui/icons.js                  UI-shell builder — inline SVG icons
js/ui/library-view.js           UI-shell builder
js/ui/reader-view.js            UI-shell builder — reader layout, toolbar, split pane, wiring viewer↔pane↔translator, feature host
js/ui/translation-pane.js       UI-shell builder
js/ui/settings-view.js          UI-shell builder
js/features/index.js            Features builder — exports panels + installReaderFeatures
js/features/*.js                Features builder (summary, chat, notes, related, selection-menu, citations, explain, autohighlight)
vendor/*                        frozen
```

## 2. Data model

### 2.1 Sentence ids & document text (`js/pdf/extract.js`)

`SEG_VERSION` (exported number, start at 1) — bump whenever segmentation output changes.

```js
/** @typedef {{
 *   segVersion: number,
 *   numPages: number,
 *   text: string,                    // whole-document logical text (see rules below)
 *   pages: PageInfo[],
 *   sentences: Sentence[],           // reading order
 *   sentenceById: Map<string, Sentence>,
 *   paragraphs: Paragraph[],
 *   references: Reference[],         // parsed bibliography, [] if none
 *   meta: { title: string, authors: string, year: number|null, abstract: string },
 *   hasTextLayer: boolean,           // false for scanned PDFs (≈ no extractable text)
 * }} PaperDoc
 *
 * PageInfo  = { pageNumber, width, height /* PDF units at scale 1 */, textStart, textEnd /* offsets into doc.text */ }
 * Sentence  = { sid, start, end /* [start,end) in doc.text */, text /* = doc.text.slice(start,end).trim() */,
 *               page /* first page */, pages: number[], pid, kind }
 *   sid     = `p${page}-${n}`  (n = 0-based index among sentences that START on that page)
 *   kind    ∈ 'body' | 'heading' | 'caption' | 'reference' | 'furniture'   // furniture = running headers/footers/page numbers/line numbers
 * Paragraph = { pid /* `p${page}-g${n}` */, page, sids: string[], kind }
 * Reference = { index /* 0-based */, n: number|null /* printed number like 12 */, text, start, end, page, bbox: {x,y,w,h} /* PDF units, page of `page` */ }
 */
export async function extractDocument(pdf, { onProgress } = {}) → PaperDoc
export async function quickMeta(pdf) → { title, authors, year, pages }   // fast: metadata + first page only
export function docOffsetToPage(doc, offset) → pageNumber
```

Logical text rules (must be deterministic for a given PDF + SEG_VERSION):
- Built page by page from `page.getTextContent()` items, in pdf.js order (good enough for most two-column papers).
- Between items on the same line insert a single space only if neither side already has whitespace and the
  horizontal gap > ~0.15 × font size. At line ends (`hasEOL` or y-jump): if the line ends with a hyphen and the
  next line starts with a lowercase letter → drop the hyphen and join; else insert one space.
- Paragraph breaks are represented by `\n\n` in `doc.text` (synthetic chars). Pages are separated by `\n\n`.
- Collapse runs of whitespace to one space. Synthetic characters map to no PDF glyph.
- Keep a reverse map so the viewer can go from (page, itemIndex, charOffsetInItem) ↔ doc offset.
  Expose it as `doc._map = { charPage: Int32Array, charItem: Int32Array, charOff: Int32Array }` (−1 for synthetic chars)
  and `doc._itemToDoc[page][itemIndex] = Int32Array` (doc offset per char of the item's `str`, −1 if dropped).
  Only `viewer.js` uses these (same owner).

Segmentation: `Intl.Segmenter('en', {granularity:'sentence'})` per paragraph, then repair false splits after
academic abbreviations (et al., e.g., i.e., Fig./Figs., Eq./Eqs., Ref./Refs., Sec., Tab., No., Vol., pp., p., vs., cf.,
approx., ca., Dr., Prof., Inc., Ltd., Jr., St., U.S., single capital initials like "J. Smith", "(n = 3)."),
never merge across paragraphs, split sentences > 700 chars at "; " if possible.
Kinds: heading = short line(s) with larger or bold font and no terminal period; caption = starts with
/^(Fig(ure)?\.?|Table|Scheme)\s*\d+/i; reference = everything after a heading matching
/^(references|bibliography|literature cited|works cited|참고문헌)$/i; furniture = text repeated at the same
top/bottom position on ≥ 3 pages, bare page numbers, journal running heads, line numbers.
`meta`: title from PDF info (if sane) else largest-font text on page 1; abstract = paragraph(s) after an
"Abstract" heading (or first long paragraph on page 1), max 2000 chars.

### 2.2 Per-paper data files (persisted by `Library.savePaperData`)

```js
// kind 'translation'
{ version: 1, targetLang: 'ko', segVersion, updatedAt,
  items: { [sid]: { h: hash(sentence.text), t: '번역문', m: 'claude-haiku-5-5' } } }
// A cached item is valid only if items[sid].h === hash(currentSentence.text).

// kind 'annotations'
{ version: 1, updatedAt,
  items: [ { id, anchor: { start, end } /* doc offsets */, quote, color: 'yellow'|'green'|'blue'|'pink',
             note: '', createdAt, updatedAt, deleted?: true } ] }

// kind 'ai'
{ version: 1, updatedAt,
  summary?: { markdown, model, createdAt },
  keyPoints?: { items: [{ sid, category: 'contribution'|'method'|'result'|'limitation'|'definition' }], model, createdAt },
  chat?: [ { id, role: 'user'|'assistant', content, ts } ],
  explanations?: [ { id, kind: 'text'|'image', quote?, markdown, model, createdAt } ],
  related?: { s2PaperId, items: [...], fetchedAt } }
```

### 2.3 Library (`library.json`)

```js
{ version: 1, updatedAt,
  folders: [ { id, name, parentId: string|null, createdAt, updatedAt, deleted?: true } ],
  papers:  [ { id, title, authors, year, fileName, size, pages, folderId: string|null, starred: false,
               addedAt, updatedAt, lastOpenedAt, translatedCount: 0, sentenceCount: 0, s2PaperId?: string,
               deleted?: true } ] }
```
Deletions are tombstones (`deleted: true` + new `updatedAt`) so they sync; the UI hides them.

### 2.4 GitHub data repo layout (private repo, e.g. `owner/paper-library`)

```
library.json
papers/<paperId>/paper.pdf
papers/<paperId>/translation.json
papers/<paperId>/annotations.json
papers/<paperId>/ai.json
README.md   (created if missing: explains this repo is app data)
```

## 3. Module contracts

### 3.1 `js/pdf/pdfjs.js`
```js
export async function getPdfjs() → pdfjsLib            // imports VENDOR.pdfjs once, sets GlobalWorkerOptions.workerSrc
export async function loadPdf(bytes /* Uint8Array */) → PDFDocumentProxy   // pass a COPY to pdf.js (it transfers the buffer)
```

### 3.2 `js/pdf/viewer.js`
```js
export class PdfViewer extends EventTarget {
  constructor(container /* scrollable element, owned by viewer */, { pdf, doc })
  async init()                              // page placeholders at fit-width; lazy-render near viewport (IntersectionObserver)
  get zoom(); setZoom(scale | 'fit-width'); zoomIn(); zoomOut()
  get currentPage(); scrollToPage(n)
  scrollToSentence(sid, { block = 'center', flash = true } = {})
  scrollToOffset(docOffset)
  scrollToPdfPoint(page, x, y)              // PDF user-space coords (origin bottom-left), used for internal links
  setHoverSentence(sid | null)              // translucent fill
  setActiveSentence(sid | null)             // pinned outline
  /** Named mark layers, redrawn on zoom/render. mark = { id, start, end, color, style: 'fill'|'underline', title? } */
  setMarks(layer /* 'annotations' | 'auto' | 'search' */, marks)
  getSentenceRects(sid) → [{ page, x, y, w, h }]   // CSS px relative to the page box at current zoom
  getSelectionAnchor() → { start, end, text, rect /* client DOMRect */ } | null
  setRegionCapture(on)                      // crosshair drag on a page → 'regioncapture'
  setTranslationOverlay(map /* Map<sid,string> */ | null)   // layout-preserving translation: paint Korean over each paragraph box
  async renderRegion(page, { x, y, w, h } /* PDF units, origin top-left */, cssWidth) → HTMLCanvasElement  // previews
  destroy()
}
// events (CustomEvent detail):
// 'sentencehover' {sid|null}   'sentenceclick' {sid}   'pagechange' {page}
// 'selectionchange' {anchor|null}          // after mouseup / keyboard selection settles
// 'linkhover' {kind:'internal'|'external', clientRect, target?: {page, x, y}, url?}   'linkleave' {}
// 'regioncapture' {page, rect /* PDF units, top-left origin */, dataUrl /* PNG, ≥ 2× resolution */}
// 'rendered' {page}
// 'visiblesentences' {sids}                // throttled; sentences currently in viewport (for scroll sync)
```
Implementation notes: canvas at devicePixelRatio; pdf.js `TextLayer` (verify `textDivs` ↔ items mapping on the
pinned version, or build your own span layer); compute sentence rects with DOM `Range.getClientRects()` over the
text-layer spans, store them in PDF units so zoom only rescales; merge rects per line; hit-test on pointermove
(rAF-throttled). Link annotations from `page.getAnnotations()` (subtype Link; resolve named/explicit dests with
`pdf.getDestination` + `pdf.getPageIndex`). Unrender canvases far from the viewport to bound memory. Must cope
with 0-text (scanned) pages: render canvas only, no sentences.

### 3.3 `js/store/*`
```js
// db.js — IndexedDB 'paper-reader' v1; stores: 'files' (key = repo path), 'meta' (key/value), 'blobs' (key = git sha)
export const db = { get(store,key), put(store,key,val), del(store,key), keys(store), getAll(store), clear(store) }

// github.js
export class GitHubClient {
  constructor({ owner, repo, branch = 'main', token })
  async checkAccess() → { ok, repoPrivate, canPush, message }       // Korean message on failure
  async getHead() → { commitSha, treeSha }
  async listTree(treeSha) → Map<path, { sha, size }>                 // recursive
  async readBlob(sha) → Uint8Array
  async commit(files /* [{ path, bytes?: Uint8Array, text?: string, delete?: true }] */, message, { parent }) → { commitSha, treeSha }
        // blobs → tree(base_tree) → commit → PATCH ref (force:false); throws GitHubConflictError on non-fast-forward
}
export class GitHubConflictError extends Error {}

// sync.js — local-first: every write lands in IndexedDB immediately and marks the path dirty;
// a debounced push (≈3 s) commits dirty paths in one commit; pull on start, on window focus, every 2 min.
// Merge on conflict: library.json and annotations.json merge per item id (newer updatedAt wins; tombstones win ties);
// translation.json merges items (union, keep local on equal sid); ai.json shallow-merges top-level keys by updatedAt;
// paper.pdf immutable.
export class SyncEngine extends EventTarget {
  constructor({ db, getConfig /* () => settings.github */ })
  get status() → { state: 'disabled'|'idle'|'syncing'|'error'|'offline', message, pending /* dirty count */, lastSyncAt }
  async start(); stop(); async syncNow()
  async readFile(path, { as: 'text'|'bytes'|'json' }) → value | null   // local first, then remote (cached)
  async writeFile(path, value /* string | Uint8Array | object (→ JSON) */)
  async deleteFile(path)
  // events: 'status' (detail = status), 'remotechange' { paths }
}

// library.js
export class Library extends EventTarget {
  static async open({ settings }) → Library          // creates db + SyncEngine; resumes sync if settings.isSyncReady()
  get folders(); get papers()                         // tombstones filtered, papers sorted by addedAt desc
  getPaper(id); getFolder(id)
  createFolder(name, parentId = null) → folder; renameFolder(id, name); moveFolder(id, parentId); deleteFolder(id) // papers inside move to parent
  async addPaper(bytes, { fileName, folderId = null, meta }) → paper    // meta from quickMeta(); rejects > LIMITS.maxPdfBytes
  updatePaper(id, patch); movePaper(id, folderId); deletePaper(id)
  async getPdf(id) → Uint8Array
  async getPaperData(id, kind /* 'translation'|'annotations'|'ai' */) → object | null
  async savePaperData(id, kind, obj)                  // sets obj.updatedAt
  get sync() → SyncEngine
  async reconfigureSync()                             // call after GitHub settings change
  // events: 'change' { reason }, 'syncstatus' (status)
}
```

### 3.4 `js/ai/*`
```js
// providers.js
export function getProvider(id = settings.get().provider) → Provider
// Provider = {
//   id, label,
//   async complete({ model, system /* string | [{text, cache?: true}] */, messages /* [{role, content: string | Part[]}] */,
//                    json?: JSONSchema, maxTokens, effort?: 'low'|'medium'|'high', signal }) → { text, json?, usage }
//   async *stream({ ...same, no json }) → yields { type:'text', text } … finally { type:'done', usage }
//   async listModels() → [{ id, label }]          newest first
//   async testKey() → { ok, message, models? }
//   pickDefaultModel(models, kind /* 'translate' | 'assist' */) → id;  isLegacyModel(id) → boolean
// }  Part = { type:'text', text } | { type:'image', mediaType:'image/png', data /* base64 */ }
// getProvider() wraps the provider (js/ai/models.js): automatic model choice, one retry on another model when the
// configured one answers not_found (err.model). Providers: relay, claude, openai, gemini, mock.
// A model the key / invite code cannot use (missing, retired, not allowed for the code, needs a verified OpenAI
// organization) must be thrown as not_found WITH err.model; such models are skipped by the automatic choice for 30 days
// per key (localStorage STORAGE_KEYS.models, a fingerprint of the key, never the key).
// usage = { model, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens }

// claude.js: lazy `import(VENDOR.anthropicSdk)`; new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
//   json → output_config.format = { type: 'json_schema', schema } (schemas need additionalProperties:false + required);
//   effort → output_config.effort; never send `thinking` (models default to adaptive); stream via client.messages.stream();
//   system blocks with cache:true get cache_control {type:'ephemeral'}; check stop_reason ('refusal', 'max_tokens');
//   use typed SDK errors (Anthropic.AuthenticationError, RateLimitError, …) to build Korean messages.
// gemini.js: fetch https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent (header x-goog-api-key),
//   :streamGenerateContent?alt=sse for streams, responseMimeType 'application/json' + responseSchema for json,
//   GET /v1beta/models for listModels (filter generateContent-capable).
// mock.js: no network. translate → '〔번역〕 ' + the source text; json schemas answered with plausible fake data;
//   stream yields a canned Korean answer word by word with small delays.

// usage.js
export function costUsd(usage) → number
export function recordUsage(usage, { paperId, task }) → void       // monthly totals in localStorage (STORAGE_KEYS.usage)
export function usageSummary() → { month: 'YYYY-MM', usd, calls, byModel: {...} }

// translator.js
export class Translator extends EventTarget {
  constructor({ doc, cached /* translation obj | null */, save /* async (obj) => void, debounced by caller ok */ })
  get translations() → Map<sid, string>          // valid cached + new
  get progress() → { done, total, costUsd }       // total = translatable sentences (body|heading|caption; reference only if settings.translate.translateReferences)
  async translateAll({ startPage = 1 } = {})      // pages ≥ startPage first, then the rest; concurrency from settings
  async translatePages(pageNumbers)
  async translateSids(sids)
  cancel()
  // events: 'update' { sids }, 'progress' (progress), 'error' { message, fatal }, 'done' {}
}
// Batching: consecutive translatable sentences, ≤ LIMITS.translateBatchMaxSentences and ≤ translateBatchMaxChars,
// each request carries the paper title+abstract and glossary in a stable (cacheable) system prompt, plus the
// 2 preceding source sentences as read-only context. Output via JSON schema {translations:[{id,ko}]};
// verify every id; retry missing ids once; on hard failure mark them failed (no infinite retries).

// tasks.js — all return Korean markdown; may cite sentences as [p3-12] which the UI turns into links
export async function summarize(doc, { signal }) → { markdown, usage }
export async function* chat(doc, history, question, { signal, quote }) → yields text chunks; last yield { done:true, usage }
export async function* explain(doc, { quote, imageDataUrl, nearSid }, { signal }) → same stream protocol
export async function keyPoints(doc, { signal }) → { items: [{ sid, category }], usage }
export async function quickTranslate(text, { signal }) → { text, usage }
```

### 3.5 `js/ui/*` (shell) and the feature host
```js
// components.js
export function toast(message, { kind = 'info'|'success'|'error', timeout = 3500 } = {})
export function modal({ title, body /* Node */, actions: [{ label, kind: 'primary'|'danger'|'default', onClick }] , onClose }) → { close }
export function confirmDialog(message, { okLabel = '확인', danger = false } = {}) → Promise<boolean>
export function promptDialog(message, { value = '', placeholder } = {}) → Promise<string|null>
export function popover(anchorRect /* DOMRect */, content /* Node */, { placement = 'bottom', onClose, className } = {}) → { close, el, update(rect) }
export function contextMenu(items /* [{ label, icon?, onClick, danger?, disabled? } | 'sep'] */, x, y) → { close }
export async function renderMarkdown(md, { sentenceLinks = true } = {}) → DocumentFragment
       // marked → DOMPurify; when sentenceLinks, text like [p3-12] becomes <a class="sid-link" data-sid="p3-12">
export function spinner(size = 16) → HTMLElement

// reader-view.js — creates, for an open paper, a FeatureContext passed to features:
// ctx = {
//   paper, doc, pdf, viewer /* PdfViewer */, pane /* TranslationPane */, translator /* Translator */,
//   library, settings, bus,
//   getAi() → aiObj, saveAi(patch) → Promise   // merges into kind 'ai' and saves
//   addToolbarButton({ id, icon, title, toggle?: boolean, onClick(active) }) → { setActive(bool), el }
//   openPanel(id)                    // switch right-pane tab
//   jumpToSentence(sid)              // scroll both panes + flash
//   signal                           // AbortSignal aborted when the paper closes
// }
// translation-pane.js
export class TranslationPane extends EventTarget {
  constructor(container, { doc })
  setTranslations(map /* Map<sid,string> */); update(sids)
  setStatus(sid, 'pending'|'failed')
  setHoverSentence(sid|null); setActiveSentence(sid|null)
  scrollToSentence(sid, { block = 'center', flash = true } = {})
  setMarks(layer, marks)               // same shape as viewer; marks map to whole sentences here
  // events: 'sentencehover' {sid|null}, 'sentenceclick' {sid}
}
```
Right pane tabs: **번역** (TranslationPane, owned by shell) | 요약 | 채팅 | 메모 | 관련 논문 (panels from features).
Hover sync: viewer 'sentencehover' → pane.setHoverSentence and vice-versa; click → the other side scrolls to it.
Optional scroll sync (settings.ui.syncScroll): viewer 'visiblesentences' → pane scrolls to keep the first visible sentence in view.

### 3.6 `js/features/index.js`
```js
export const panels = [ { id: 'summary'|'chat'|'notes'|'related', title, icon, mount(container, ctx) → { onShow?(), destroy?() } } ]
export function installReaderFeatures(ctx) → { dispose() }
// installs: selection menu (하이라이트 4색 / 메모 / AI 설명 / 번역 / 채팅에 질문 / 복사),
// citation & internal-link previews (viewer 'linkhover'; target inside doc.references → reference card with optional
// Semantic Scholar lookup; otherwise a renderRegion() preview of the target area), region capture explain (toolbar
// button "그림·표 설명"), auto highlight (toolbar toggle "핵심 밑줄", keyPoints cached in ai.keyPoints → viewer.setMarks('auto')),
// annotations rendering (viewer.setMarks('annotations') + pane.setMarks('annotations')).
```

## 4. UX summary

- **Library** (`#/`): left folder tree (전체 / 최근 읽음 / 즐겨찾기 / user folders, nested, drag-drop papers onto folders,
  context menu: 새 폴더·이름 바꾸기·삭제), main list with search + sort, PDF upload button and drop zone (multiple files),
  per-paper progress (번역 %), sync status chip (GitHub 동기화: 꺼짐/동기화 중/완료/오류).
- **Reader** (`#/paper/<id>`): toolbar (← 라이브러리, 제목, 페이지 n/N, 확대/축소/폭 맞춤, 보기: 원문|나란히|번역 겹쳐보기,
  번역 시작(전체/이 페이지)+진행률+비용, 핵심 밑줄, 그림·표 설명, 설정), split view with draggable divider (PDF left, tabs right).
- **Settings** (`#/settings`): AI provider (초대 코드 / Claude / GPT / Gemini), API key (password field + 테스트), models
  (자동 선택 from the key's live list, or a user pick), GitHub sync
  (owner/repo/branch/token + 연결 테스트 + how-to text for a fine-grained token with Contents read/write on ONE repo),
  translation options (용어집, 전문용어 영어 병기, 참고문헌 번역 여부), theme/font size, this month's usage/cost,
  "이 기기에서 키·토큰 지우기".
