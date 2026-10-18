# Integration notes

Cross-module changes made while wiring the modules together, and how the whole app is tested.
Module notes (`pdf.md`, `ai.md`, `shell.md`, `features.md`, `store.md`) still describe each module;
where they list an open item that is resolved here, this file is the current state.

## Changes across module boundaries

| Area | Change |
|---|---|
| `features/citations.js` | `findReferenceAt` / `previewRegion` use the viewer's `target.refIndex` and `target.pt` (top-left PDF units, crop-box correct) and fall back to `page.height − target.y` only without them. Fixes reference matching on PDFs whose page box does not start at 0 (simwright2005 starts at 9,9). |
| `features/selection-menu.js` | Highlight clicks come from the viewer's `markclick`. The sentence-overlap fallback was removed: it opened the edit menu when the click landed on the unhighlighted part of a partly highlighted sentence. `[data-mark-id]` elements under the pointer are still honoured (viewers that draw clickable marks). `tests/features/stubs/viewer.js` now emits `markclick` like the real viewer. |
| `ai/prompts.js`, `ai/mock.js`, `features/summary.js` | Summary sections are **한 줄 요약 / 연구 목적 / 연구 방법 / 주요 결과 / 제한점 / 임상·연구적 시사점** everywhere (prompt, mock answer, panel hint, features stub). |
| `ui/components.js` | `renderMarkdown` registers a marked inline extension: a `**bold**` run that touches a CJK character on either side (`**41%**에서`, `값은**(n = 3)**이다`) is tokenized as `strong` even where CommonMark's flanking rule refuses. It produces an ordinary `strong` token, so escaping, DOMPurify and link hardening are unchanged. |
| `pdf/viewer.js` | Fit-width never goes above 1.6 (`FIT_WIDTH_MAX`); 원문 and 번역 겹쳐보기 no longer zoom to ~230 % on wide screens. |
| `css/viewer.css` | `.pdfv-root { position: relative }` moved into `:where(.pdfv-root)` (zero specificity), so a host's own positioning always wins. The shell's override stays as is. |
| `ai/translator.js` | New `mergeCached(cached)`: adds still-valid items from a newer translation file without touching sentences translated here; emits `update` + `progress`; returns the added sids. |
| `ui/reader-view.js` | Passes `paperId` to `Translator` (per-paper usage). On sync `remotechange` for the open paper's `translation.json` it reloads the file and calls `translator.mergeCached()`, so sentences translated on another device appear without reopening. |
| `app.js` | Toasts the Library's `error` event (IndexedDB save failures such as quota). |
| `features/autohighlight.js` | The 핵심 밑줄 legend is placed inside the PDF pane and never wider than it (at 1024 px it used to cover the right pane's tab bar and swallow clicks); it follows pane resizes. |
| `features/explain.js` | The “drag a region” hint is a sticky toast closed when capture ends, instead of lingering 3.5 s after the capture. |
| `css/app.css` | Spacing between the test-mode note and the provider cards in 설정. |
| `js/core/settings.js` | (Changed before this pass, noted for completeness) `?mock=1` is session-only; `settings.isMockSession` tells views. `settings-view` needed no change. |

## End-to-end test

```
node tests/e2e/run.mjs
```

Runs the real `index.html?mock=1` in Edge (Playwright 1.63 from `C:/Users/dindoo/Projects/pr-tools`), serving the
repo with `python -m http.server 8110` if nothing listens there. GitHub is the in-process fake from
`tests/store/fake-github.mjs` (random port), reached through `routeGitHubToFake`; every other non-loopback request is
aborted (the Pretendard font stylesheet is answered with an empty stub). Fixture PDFs are given to the file input from
`C:/Users/dindoo/Projects/pr-fixtures`. Any console error, page error or CSP violation fails the test that produced it.
Results and screenshots: `C:/Users/dindoo/Projects/pr-tools/out/integrate/` (`e2e-results.json`, `e2e-*.png`, `qa-*.png`).

The fake repo starts with a README (as the in-app how-to asks). Syncing to an *empty* repo works (covered by
`tests/store/run.mjs`), but Chromium logs the API's expected 409 answers as console errors.
