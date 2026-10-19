# Features module — notes for the integrator

Owner: features builder. Files: `js/features/*.js`, tests in `tests/features/`.

## What is here

| File | Role |
|---|---|
| `index.js` | `panels` (요약 / 채팅 / 메모 / 관련 논문) and `installReaderFeatures(ctx) → { dispose }`. Also re-exports `getSession`. |
| `session.js` | Per-open-paper state shared by panels and installers (annotation store, chat quote hand-off, reference lookups, the open explanation card). Keyed by `ctx.signal`. |
| `annotations.js` | `AnnotationStore` (CRUD + tombstones + debounced `savePaperData(id,'annotations',…)`), `annotationMarks()`, `removeWithUndo()`, `installAnnotationMarks()` (pushes `setMarks('annotations')` to viewer **and** pane, reloads on sync `remotechange`). |
| `selection-menu.js` | Menu on PDF selection (4 colours / 메모 / AI 설명 / 번역 / 채팅에 질문 / 복사) and on an existing highlight (색 / 메모 / AI 설명 / 채팅에 질문 / 복사 / 삭제). |
| `citations.js` | `linkhover` previews: reference card (+ keyless lookup: DOI or Crossref → Europe PMC / PubMed; Semantic Scholar only if nothing matched), `renderRegion` preview for other internal links, external-link card. 140 ms show delay, 280 ms hide grace. |
| `explain.js` | Text explanation and toolbar toggle "그림·표 설명" (region capture → image explanation). Saves to `ai.explanations`. |
| `autohighlight.js` | Toolbar toggle "핵심 밑줄": `tasks.keyPoints` once, cached in `ai.keyPoints`, underline marks per category + filterable legend. |
| `summary.js`, `chat.js`, `notes.js`, `related.js` | The four panels. `related.js` = PubMed similar articles + "이 폴더 기준 추천". |
| `scholarly.js` | Keyless lookups used by 관련 논문 and the reference card: consent, `identifyPaper`, `relatedForPmid(s)`, `fetchAbstract`, `lookupReference`, link helpers. |
| `pubmed.js` | E-utilities client: ESearch, ESummary, ELink `neighbor_score`, EFetch abstract (`tool=galpi`, no e-mail). |
| `europepmc.js` | Europe PMC search: one batched query for citation counts / free full text, `resultType=core` abstracts. |
| `crossref.js` | Crossref `query.bibliographic` matching of bibliography entries (public pool, no `mailto`). |
| `scholarly-net.js` | Shared fetch for the three: per-service rate limiter, timeouts, abort, 429 back-off, Korean errors. |
| `textmatch.js` | Pure helpers: title normalisation / similarity, significant words, word overlap, plain text from API HTML, DOI regex. |
| `paper-bits.js`, `related-styles.js` | Abstract paragraphs + link badges shared by panel and card; their extra CSS (injected like `styles.js`). |
| `s2.js` | Semantic Scholar client, now only the fallback (match, recommendations, DOI/title lookup, 15 s timeout, one auto-retry on 429). |
| `shared.js` | Helpers: signals, sentence/page lookup, markdown decoration (sid chips), streaming painter, clipboard. |
| `ui-bits.js` | Draggable floating side card (explanations). |
| `styles.js` | Injected feature CSS (`pf-*` classes). |

## Decisions and deviations

1. **Shared state between panels and installers.** The shell mounts panels and calls `installReaderFeatures` separately, in any order. Both call `getSession(ctx)`, a WeakMap keyed by `ctx.signal`. Copies of ctx still share one session, as long as they carry the same signal. The session is disposed (pending annotation saves flushed) when the signal aborts.
2. **CSS lives in JS.** Features own no stylesheet, so `styles.js` injects `<style id="pr-features-css">` once.
   - The `--pf-*` tokens resolve to the shell's tokens (`--surface`, `--text-3`, `--accent`, `--mark-*` …), with built-in fallbacks.
   - `.popover.pf-pop` overrides the shell popover's 400px max-width and its padding, so the selection toolbar fits on one row.
   - If you'd rather move this CSS into `css/app.css`, copy the CSS string and delete `ensureStyles()` calls.
3. **Undo toast** uses `components.toast(msg, { action: { label, onClick }, timeout: 6000 })`. `action` is the shell's extension of the SPEC signature; it is used only by `removeWithUndo`.
4. **Clicks on an existing highlight.** The viewer contract has no mark-click event, so detection works like this:
   - First, listen for an optional `markclick` `{ layer, id, clientRect }`. **Proposal for the viewer: emit it.**
   - Otherwise, on `sentenceclick` with no text selection: `document.elementsFromPoint` at the last pointerdown, looking for `[data-mark-id]` (or `[data-layer="annotations"] [data-id]`).
   - Failing that, open the annotation with the largest overlap with the clicked sentence.
5. **Coordinates.** `linkhover.target` is PDF user space (origin bottom-left, same as `scrollToPdfPoint`) and is converted with `page.height − y`.
   - `Reference.bbox` is assumed to be **top-left origin**, like `renderRegion`/`regioncapture`. **Extract/viewer builders: please confirm.**
   - A target matches the reference whose bbox top is nearest, within x ±24 and y −18…+4 PDF units.
6. **Auto-highlight marks.** They use `style: 'underline'` and a *named* colour per category: contribution purple, method blue, result green, limitation red, definition orange.
   - The pane already maps names to `--mark-<name>-line`, and they are valid CSS colour keywords anyway. **Viewer: please map these names too.**
   - The 'auto' layer is also pushed to the pane (the spec only mentioned the viewer). Marks carry an extra `category` field.
7. **`settings.ui.showAutoHighlights`.** It is the remembered toggle state: toggling writes it. When it is on, cached key points are shown automatically on open. A paid `keyPoints` call happens **only** on an explicit click. Toggling off while analysis runs lets it finish and cache (the cost is already spent).
8. **Timestamps** written by features are epoch ms (`Date.now()`). Merges accept ISO strings too (`toMillis`).
9. **Additive data fields** (all optional):
   - chat messages: `quote`, `model`, `stopped`
   - explanations: `page` (image kind; the image itself is not stored)
   - `ai.related`: `{ source: 'pubmed'|'s2', pmid?, doi?, s2PaperId?, paper, items, citations?, fallback?, fetchedAt, folder? }` — `items`/`paper` use the shared paper shape (`scholarly.js` header); `folder = { key, folderId, sources: [{ id, pmid, tried }], items, citations, fetchedAt }`. Old caches (no `source`) still render as Semantic Scholar results.
   - library paper record: `pmid`, `doi` (set once by 관련 논문; `s2PaperId` only for the S2 fallback)
   - auto marks: `category`
10. **`paperId` is passed to every `tasks.*` call** (usage accounting in the real `tasks.js`). The `model` returned by tasks is stored with summaries, chat answers, explanations and key points.
11. **Chat persistence.**
    - Only finished exchanges are stored.
    - Stop keeps the partial answer (`stopped: true`). Stopping before any text arrives drops the turn and puts the question back in the input.
    - Failures are not stored; a 다시 시도 button is offered.
    - A quote is folded into later history turns as a `> quote` blockquote.
    - Up to 200 messages are stored; `tasks.js` trims what it sends.
12. **Summary** is generated only when asked (요약 만들기 / 다시 만들기) — opening the tab never makes a paid call. A summary in flight keeps running when the paper closes and is saved; one made on another device or tab appears via the reader's `paper:ai-change` bus event. Key points likewise finish and cache after the paper closes; stored key points carry their sentence's text hash and are dropped when it no longer matches.
12b. **Chat** messages from another tab/device appear live (`paper:ai-change`); clearing records `chatClearedAt` (chat merges by id).
12c. **Highlights** store `seg` (segmentation version); on load the quote is checked against `doc.text` at the stored offsets and re-anchored by searching the quote when it moved (not found → `lost`, not drawn). AnnotationStore merges 3-way against the last stored version, retries failed saves with backoff, and flushes when the page is hidden.
12d. **Missing AI key** → one warning toast with 설정 열기 (`notifyAiNotReady`), never a stacked error; the quick-translate popover shows the gate and no copy button.
12e. **Consent.** One consent per browser (`pr.features.scholarConsent.v1`) covers PubMed(미국 국립의학도서관)·Europe PMC·Crossref·Semantic Scholar, for both 관련 논문 and reference cards. Nothing is sent before it. The old S2-only consent key is not carried over (different recipients).
13. **Related papers (keyless, PubMed first).**
    - Fetched lazily on the first show of the tab. The paper is identified once and `pmid`/`doi` are stored on the paper record (`library.updatePaper`).
    - Identification: DOI (doc.meta / record, else first DOI on pages 1–2) → ESearch `"<doi>"[doi]`, the ESummary DOI must agree; a page-1 DOI whose title disagrees (< 0.6) is only used if the title search finds nothing. Title → ESearch `w1[ti] AND …` (≤ 10 content words, retry with 6) → ESummary, accepted at normalised Dice similarity ≥ 0.85 (a ≥ 5-word prefix = subtitle omitted counts 0.9) and year ±1 when known; Europe PMC `TITLE:"…"` as a second chance. The user can type a title, DOI or PMID in "다른 논문으로 다시 찾기".
    - List: ELink `cmd=neighbor_score` (pubmed_pubmed) → top 20 → ESummary → one Europe PMC query for the 20 + the base paper (`citedByCount`, PMC / OA links). Cards: title, first three authors, journal · year, 인용 n회, badges 무료 전문 / PubMed / DOI (`rel="noopener noreferrer"`), 초록 보기 (Europe PMC core, else EFetch; cached into `ai.related`), 초록 번역. Sort 관련도 / 최신순 / 인용순 (remembered per browser). Source line `출처: PubMed 유사 논문 · 인용 수 Europe PMC`.
    - Europe PMC failing only drops the counts (source line says so). Not in PubMed / Europe PMC → Semantic Scholar match + recommendations (`source: 's2'`); S2 failures there count as "not found", never an error screen. Zero PubMed neighbours → S2 recommendations for `PMID:<pmid>`.
    - 이 폴더 기준 추천: up to 10 papers of the paper's folder (this one, then most recently opened). Missing PMIDs are resolved by title once (stored on those records; misses remembered in the cache), one ELink request with one `id` per PMID, each source's scores scaled to its best neighbour and summed, folder papers excluded, top 20. Cached in `ai.related.folder` keyed by the folder's paper ids.
    - Robustness: NCBI ≤ 3 request starts per 1.5 s (client limiter, shared by panel and cards; 3 per 1.1 s still drew a live 429 because the first request's connection setup bunches arrivals at NCBI), Crossref 1 per 1.1 s (its public pool answers `x-rate-limit-limit: 1`), Europe PMC 5/s; 15 s timeout per request (ELink 20–30 s); 429/502/503/504 → two retries with Retry-After or 1 s / 2 s back-off; then `PubMed가 잠시 바쁩니다. 잠시 후 다시 시도해 주세요.` with 다시 시도. **NCBI sends its 429 without `Access-Control-Allow-Origin`** (checked 2026-10-19), so in a browser a rate-limited request is only a failed fetch: a failed fetch while `navigator.onLine` is therefore retried the same way (everyone waits, 2 s then 4 s) before `PubMed에 연결하지 못했습니다. 서버가 잠시 바쁘거나 네트워크가 막혀 있을 수 있습니다. 잠시 후 다시 시도해 주세요.`; offline fails at once with `…인터넷 연결을 확인해 주세요.` (Colleagues behind one hospital IP share NCBI's 3/s.) Requests go out with `credentials: 'omit'`, `referrerPolicy: 'no-referrer'`, no key, no e-mail.
13b. **Reference card lookup.** (1) A DOI printed in the entry → Europe PMC core (abstract, citations, free full text) → PubMed (ESummary + EFetch) → Semantic Scholar by that exact DOI (journals PubMed does not index). (2) No DOI, or one nobody knows — PDFs often cut it at a line break (`…neubiorev.2021. 02.016`) — → Crossref `query.bibliographic` on the whole entry (rows=3) → Europe PMC / PubMed for that DOI, else Crossref's own record. (3) Semantic Scholar title match only if nothing matched. Crossref's top hit must share ≥ 60 % of its title's content words with the entry's title — the quoted `“Title,”` or the sentence after `(Year).` when the style marks it (`textmatch.referenceTitle`), else the whole entry — or be ≥ 0.85 similar to that title; match a year in the entry (±1); not be a notice about the work (Correction to / Erratum / Reply / Comment on / Re: / Spotlight article…) or a `component` / `peer-review` record; and beat any other plausible hit with a different title by ≥ 1.15× score. Calibrated on 48 real answers (`fixtures/scholarly/crossref-calibration.json`: every reference of lu2025, whose printed DOIs are the ground truth, and 30 of kiekkas2012): 43 right, 5 refused, 0 wrong — before the title-span rule lu2025's Kaplow 1994 matched a 1995 commentary whose title quotes it. After consent the card looks up on hover; a lookup still running when its card closes is aborted (sweeping across citations queues nothing); finished lookups are cached per entry (`session.refLookups`).
14. **Sentence chips.** `.sid-link` text becomes `p.N` and its tooltip shows the sentence; unknown ids become plain text.
    - Feature handlers call `stopPropagation` so the reader view's root-level `.sid-link` delegation doesn't jump twice.
    - Hovering a chip highlights the sentence in both panes.
15. **The annotation store never writes before a successful read.** This prevents overwriting the synced file after a transient read error; it retries the read before saving.
16. **Region capture data URL** must match `data:image/(png|jpeg|webp);base64,`.
17. **Explanation card** is a non-modal, draggable floating card, docked bottom-right (over the translation pane, clear of toolbar and tabs). Only one is open at a time; Esc closes it.
18. **Panel icons** use names from `ui/icons.js`: `sparkles`, `message`, `note`, `book-open`. **Toolbar icons:** `underline`, `image`.

## Known limitations / for other modules

> Integration status: the summary headings, Korean bold, highlight-click and citation-coordinate items below are resolved — see `integration.md`.

- **Summary headings.** `prompts.js` asks for 한 줄 요약 / 연구 배경과 목적 / 연구 방법 / 주요 결과 / 결론 및 시사점 / 제한점. The features brief asked for 연구 목적 / 방법 / 주요 결과 / 한계 / 임상·연구적 시사점. The panel is heading-agnostic (its TOC is built from whatever `##` headings come back), so aligning is a one-line prompt change for the AI builder if wanted.
- **Bold before Hangul.** `**41%**에서` is not bolded by marked: the CommonMark flanking rule blocks bold that ends in punctuation directly before Hangul, and model output often has this. A fix belongs in `renderMarkdown` (components).
- **Translation-pane selection.** Selecting text in the pane opens no menu: the pane contract has no selection event, and annotations anchor to PDF doc offsets.
- **Highlight-click fallback.** The sentence-overlap fallback (item 4) can open the edit menu when the click lands on the unhighlighted part of a partially highlighted sentence. A viewer `markclick` event removes this.
- **CSP.** The app's `connect-src` must list `https://eutils.ncbi.nlm.nih.gov`, `https://www.ebi.ac.uk` and `https://api.crossref.org` (plus the existing `https://api.semanticscholar.org`). Verified 2026-10-19 with the real app (`index.html` served with exactly these added, no other CSP change) on lu2025 + kiekkas2012 against the live services: no CSP violation, PMIDs 41131854 / 23577947, 20 similar papers each, folder view, reference cards, abort on close. The tests themselves never call the services.
- **Playwright cannot fake a CORS-less response with `route.fulfill`**: it adds the page's origin when `Access-Control-Allow-Origin` is missing (playwright#12929). `scholarly-routes.mjs` (`ncbi429NoCors`) sends a foreign origin instead, which the browser rejects the same way.
- **Settings.** The "Semantic Scholar API 키 (선택)" field is no longer needed for anything but the fallback.
- **Stub viewer only.** The real `js/pdf/viewer.js` did not exist while this was built. Everything was tested against a stub that follows SPEC §3.2, plus an integration pass with the real `components.js`, real `tasks.js` (mock provider) and `css/app.css`.

## How to test

```
# all feature tests (stub viewer/pane/library/tasks/components, mock provider, S2 intercepted)
node tests/features/run.mjs            # optional filter: node tests/features/run.mjs chat
# integration: real components.js + real tasks.js (mock provider) + css/app.css
node tests/features/integration.mjs
# keyless 관련 논문 / reference card (PubMed, Europe PMC, Crossref intercepted; port 8211)
node tests/features/related-pubmed.mjs   # optional filter, screenshots → pr-tools/out/related/
```

- `tests/features/fixtures/scholarly/` holds trimmed real responses (curl, keyless, 2026-10-19); `scholarly-routes.mjs` serves them with `page.route` and gives the harness paper a synthetic PMID (39990001) whose neighbours are PMID 15082703's. `harness.html?folder=1` puts the paper in a folder with three more papers.

- Both runners start `python -m http.server 8105` if nothing is listening there, and stop it afterwards.
- Screenshots go to `C:/Users/dindoo/Projects/pr-tools/out/features/`.
- Harness by hand: `http://127.0.0.1:8105/tests/features/harness.html?mock=1&reset=1`. Parameters:
  - `tab=summary|chat|notes|related`
  - `theme=dark`
  - `real=components,tasks` (use the real modules)
  - `css=app` (load the shell stylesheet)
- `window.__h` exposes ctx, viewer/pane call logs, library data and session.
