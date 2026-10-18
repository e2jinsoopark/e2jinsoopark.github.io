# Features module — notes for the integrator

Owner: features builder. Files: `js/features/*.js`, tests in `tests/features/`.

## What is here

| File | Role |
|---|---|
| `index.js` | `panels` (요약 / 채팅 / 메모 / 관련 논문) and `installReaderFeatures(ctx) → { dispose }`. Also re-exports `getSession`. |
| `session.js` | Per-open-paper state shared by panels and installers (annotation store, chat quote hand-off, reference lookups, the open explanation card). Keyed by `ctx.signal`. |
| `annotations.js` | `AnnotationStore` (CRUD + tombstones + debounced `savePaperData(id,'annotations',…)`), `annotationMarks()`, `removeWithUndo()`, `installAnnotationMarks()` (pushes `setMarks('annotations')` to viewer **and** pane, reloads on sync `remotechange`). |
| `selection-menu.js` | Menu on PDF selection (4 colours / 메모 / AI 설명 / 번역 / 채팅에 질문 / 복사) and on an existing highlight (색 / 메모 / AI 설명 / 채팅에 질문 / 복사 / 삭제). |
| `citations.js` | `linkhover` previews: reference card (+ lazy Semantic Scholar lookup), `renderRegion` preview for other internal links, external-link card. 140 ms show delay, 280 ms hide grace. |
| `explain.js` | Text explanation and toolbar toggle "그림·표 설명" (region capture → image explanation). Saves to `ai.explanations`. |
| `autohighlight.js` | Toolbar toggle "핵심 밑줄": `tasks.keyPoints` once, cached in `ai.keyPoints`, underline marks per category + filterable legend. |
| `summary.js`, `chat.js`, `notes.js`, `related.js` | The four panels. |
| `s2.js` | Semantic Scholar client (match, recommendations, DOI/title lookup, Korean errors, one auto-retry on 429). |
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
   - `ai.related.paper`: matched S2 metadata
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
12e. **관련 논문** asks once (per browser) before sending the title to Semantic Scholar.
13. **Related papers.**
    - Fetched lazily on the first show of the tab; a stored `s2PaperId` is reused.
    - "다른 논문으로 다시 찾기" lets the user fix a wrong title match.
    - On 429: one silent retry after 1.2 s, then a Korean message with 다시 시도.
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
- **Semantic Scholar not called live.** Tests intercept all `api.semanticscholar.org` requests. The `x-api-key` header triggers a CORS preflight; S2 is assumed to allow it.
- **Stub viewer only.** The real `js/pdf/viewer.js` did not exist while this was built. Everything was tested against a stub that follows SPEC §3.2, plus an integration pass with the real `components.js`, real `tasks.js` (mock provider) and `css/app.css`.

## How to test

```
# all feature tests (stub viewer/pane/library/tasks/components, mock provider, S2 intercepted)
node tests/features/run.mjs            # optional filter: node tests/features/run.mjs chat
# integration: real components.js + real tasks.js (mock provider) + css/app.css
node tests/features/integration.mjs
```

- Both runners start `python -m http.server 8105` if nothing is listening there, and stop it afterwards.
- Screenshots go to `C:/Users/dindoo/Projects/pr-tools/out/features/`.
- Harness by hand: `http://127.0.0.1:8105/tests/features/harness.html?mock=1&reset=1`. Parameters:
  - `tab=summary|chat|notes|related`
  - `theme=dark`
  - `real=components,tasks` (use the real modules)
  - `css=app` (load the shell stylesheet)
- `window.__h` exposes ctx, viewer/pane call logs, library data and session.
