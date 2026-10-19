# Shell (UI) module — notes

Files: `index.html`, `css/app.css`, `js/app.js`, `js/ui/{components,icons,library-view,reader-view,translation-pane,settings-view}.js`.
Tests: `tests/shell/` (stubs, harness pages, Playwright runners). Nothing outside these was touched.

Since 2026-10-19 also `js/ui/start-view.js` (the first screen a fresh visitor gets, and the join link's screen) and
`js/ui/install.js` (홈 화면에 추가) — see [`onboarding.md`](onboarding.md). `popover()` / `contextMenu()` measure their node
with `opacity: 0` instead of `visibility: hidden` (WebKit left the children hidden: blank popovers on an iPhone).

## How app.js talks to the views

```js
mountLibraryView(container, { deps, navigate })                 → { destroy() }
mountReaderView(container, { paperId, deps, navigate })         → { destroy() }
mountSettingsView(container, { deps, navigate, backHref })      → { destroy() }
// deps = { library, loadPdf, extractDocument, quickMeta, PdfViewer, Translator, getProvider,
//          usage /* module */, GitHubClient, features: { panels, installReaderFeatures } | null, failures }
```
Views never import other builders' modules; `js/app.js` imports them by their SPEC paths with dynamic
`import()` + `Promise.allSettled`, checks the expected exports, and injects them. That is also what makes the
views testable with stubs (import maps in `tests/shell/harness*.html`).

## Degradation (a module fails to load or lacks an export)

| Missing | Behaviour |
|---|---|
| `js/store/library.js` (critical) or `Library.open` throws | Korean full-screen error “앱을 시작할 수 없습니다 / 라이브러리를 열 수 없습니다” + `자세한 정보` (module path + error) + 다시 시도 |
| any other module | yellow banner “일부 기능을 불러오지 못했습니다: …” with 자세히 (modal listing paths/errors) |
| pdf modules | library works; upload shows a Korean error toast; opening a paper shows an error screen |
| `js/ai/translator.js` | reader uses an internal `OfflineTranslator`: still shows valid cached translations, 번역 button disabled |
| `js/features/index.js` | reader shows only the 번역 tab, no feature toolbar buttons |
| providers / github / usage | settings test buttons / usage section show a Korean “모듈을 불러오지 못했습니다” |
A panel whose `mount()` throws only breaks its own tab (`.panel-error`); a throwing `installReaderFeatures` → toast.

## Contract additions (all backward compatible — documented so other modules may use them)

**components.js**
- `toast()` returns `{ close, update(message, kind?), el }`; extra opt `action: { label, onClick }`; `kind` also `'warning'`; `timeout: 0` = sticky.
- `modal()` action semantics: the modal closes after `onClick({ close })` resolves **unless it returns `false`**; a thrown error is shown as an error toast and the modal stays open. Extra opts `size: 'sm'|'md'|'lg'`, `className`, per-action `autofocus`.
- `confirmDialog` / `promptDialog` accept `title` (and `cancelLabel` / `okLabel`). Enter submits a prompt.
- `popover()` extra opts: `ignoreOutside: Element[]` (e.g. the anchor button, so a toggle click does not close+reopen), `role`, `label`. Placements: `bottom|top|left|right` with optional `-start|-end`.
- `contextMenu()` items may be `{ note: '…' }` (small print line). Arrow keys/Home/End/Enter work; Esc/Tab close.
- One overlay stack: Esc and outside-pointerdown close only the topmost overlay. Exported helpers: `hasOpenLayer()`, `closeAllLayers()` (called on every route change).
- `renderMarkdown()` uses a **private DOMPurify instance** (`DOMPurify(window)`), so hooks added elsewhere cannot weaken it. Strips style/id/name/forms/iframes/svg, allows only `http(s):`/`mailto:` links (+ `target=_blank rel="noopener noreferrer"`), removes `#…` links (they would hijack the hash router) and every `<img>` that is not a `data:image/*`. `[p3-12]`, `[p1-2, p2-5]` → `<a class="sid-link" data-sid="…" role="link" tabindex="0">` (no href); text inside `code`/`pre`/`a` is left alone. Tables are wrapped in `.md-table-wrap`. Put the fragment in an element with class `md` for styling.
- Also exported: `button`, `iconButton`, `progressBar`, `messageScreen`, `uiState` (per-browser UI prefs in `localStorage['pr.ui.v1']`).

**icons.js** — `icon(name, { size, className, title, strokeWidth })`, `ICON_NAMES`, `hasIcon`, `resolveIcon(spec)`.
`addToolbarButton({ icon })` and `panels[].icon` accept an icon name, a DOM Node, or a short text glyph.
Names used by js/features today (`underline`, `image`, `message`, `note`, `book-open`, `sparkles`) all exist.

**TranslationPane**
- `setTranslations(map, { repaint = true })` — `repaint:false` only swaps the map (follow with `update(sids)`).
- `setStatus(sid, null)` clears a status. Extra: `failedSids`, `revealSentence(sid)` (scrolls only if off-screen),
  `isSentenceVisible(sid)`, `getSentenceElement(sid)`, `destroy()`.
- Extra event `'retry' { sids }` (the 다시 시도 pill on a failed sentence). The reader turns it into `translator.translateSids`.
- Rendering: `doc.paragraphs` in order, `n쪽` page dividers, `heading` paragraphs as `<h3>`, captions boxed,
  furniture hidden, references shown as greyed source text unless `settings.translate.translateReferences`.
  Untranslated = original text greyed (`lang="en"`); `pending` pulses; `failed` = wavy red underline + 다시 시도.
- Marks: a mark colours every sentence it overlaps; `data-m-<layer>="fill|underline"` + CSS var `--m-<layer>`.
  Colours: `yellow green blue pink orange purple red grey` (theme-aware tokens) or any valid CSS colour.
  Styled layers: `annotations`, `auto`, `search` (outline). Mark `title`s become the span tooltip.

**FeatureContext** (`reader-view.js`) has exactly the SPEC §3.5 keys (verified by a test). Details:
`paper` is a getter (always the current library record); `saveAi(patch)` shallow-merges top-level keys into the
`ai` object and saves through a serialized chain (each call's promise rejects if *its* save failed);
`openPanel(id)` switches to the 나란히 view if needed; panels mount lazily on first show (mount may return a
promise), `onShow()` on every show, `destroy()` on close; `signal` aborts when the paper closes, then
`dispose()` is also called.

## Reader behaviour

- View modes: **원문** = PDF only · **나란히** = split · **번역 겹쳐보기** = PDF full width with `viewer.setTranslationOverlay(translations)` (refreshed, debounced, as translations arrive; cleared with `null` when leaving).
- Hover sync: either side's `sentencehover` → `setHoverSentence` on **both** sides (works whether or not the viewer self-highlights). Click → the other side scrolls (center + flash) and both get `setActiveSentence`. `[p3-12]` links anywhere in the reader jump on click/Enter and highlight on hover.
- Scroll sync (`settings.ui.syncScroll`, toggle in the pane header): viewer `visiblesentences` → the first visible sentence is aligned to the pane top; suppressed for 1.2 s after the user scrolls the pane and while the pointer is over the right side. Hovering a PDF sentence for 350 ms also reveals it in the pane if it is off-screen.
- Keyboard (not while typing / while an overlay is open): ←/→ and PageUp/PageDown = page (PageUp/Down scroll the pane natively when focus is in it), `+`/`=`, `-`, `0` = zoom in / out / fit width, Esc = close overlay first, then clear the active sentence. Divider: ←/→ (↑/↓ when stacked), Home/End, Enter = reset; double-click = 50/50. Tabs: ←/→/Home/End.
- Persisted per browser (`pr.ui.v1`): `splitRatio`, `splitRatioV` (stacked), `viewMode`, `readerTab`, `lastPages` (last page per paper, 60 newest), `library` (selected folder, sort, expanded folders).
- `#/paper/<id>` survives reload (same paper, last page, split).
- Narrow screens (≤ 860 px): panes stack (PDF on top), divider becomes horizontal; toolbar labels collapse progressively (1180 / 980 / 860 / 640 px). Library sidebar becomes a drawer (☰, Esc closes).
- Translation controls: 번역 시작 / 이어서 번역 / 번역 완료 + ▾ menu (전체 번역 현재 페이지부터, 이 페이지만, 실패한 문장 다시 번역, 중지, model + this month's usage). Progress bar, %, running cost (`progress.costUsd`), stop button. If `settings.isAiReady()` is false → modal pointing to 설정.
  Requested sentences are marked `pending` up front; at the end each is resolved via `translator.statusOf(sid)` when that optional method exists (real Translator), otherwise untranslated = failed. Also uses the optional `'pending'` event and `update.detail.failed`. A retry may run while a full translation is running; a second full run may not.
- Persistence: translation saves are debounced 1.5 s but never held back more than 5 s, flushed on close and when the page is hidden (pagehide / visibilitychange); a failed save is handed back to the translator, which stops the run. `ctx.saveAi(patch)` is a read-modify-write on the stored ai.json (`library.updatePaperData`); ai.json changes from other tabs/devices reload `getAi()` and emit `bus` `'paper:ai-change'`. A paper deleted on another device stops the translator and saving.
- Fatal AI errors (bad key, no credit, no access) show one toast with 설정 열기 and no failed-sentence toast; 이 페이지만 번역 sends exactly the sentences it marks pending; translations that failed a fidelity check get a dotted underline (`check` mark layer).
- Library counts: `translatedCount`/`sentenceCount` (= `progress.done/total`) are pushed to the library every ≤ 2.5 s and on close; `lastOpenedAt` on open.

## Settings

`#/settings/<section>` (e.g. `#/settings/sync`) opens at that section; the onboarding steps use it.
연결 테스트 now saves on success (like the AI 테스트) and starts sync; leaving with unsaved GitHub fields asks first.
Saving a repo different from the one this device's data came from asks 올리기 / 이 기기 데이터 지우고 시작 / 취소
(see store notes: `carryOver`). 보안·데이터 has **이 기기의 데이터 모두 지우기** (IndexedDB + every `pr.*` key) and warns
when the app runs on a shared `*.github.io/<project>/` origin or persistent storage was denied. Usage shows
"비용 미집계" for unpriced (Gemini) models and model labels instead of ids.
Settings follow other tabs (`storage` event); `settings.set()` merges into what is stored now. Test harness pages
under `/tests/` always use the mock provider when not served from localhost.
AI keys save on change (blur/Enter); 테스트 saves first, then `getProvider(id).testKey()`. Gemini models come
from `getProvider('gemini').listModels()` (auto-loaded when a key exists); empty model fields get defaults
(first `flash` model → 번역, first `pro` model → 요약·채팅). GitHub fields save only with **저장하고 동기화 시작**:
the shell runs `checkAccess()` first and refuses public repos (`repoPrivate === false`) and read-only tokens
(`canPush === false`), then `settings.set({ github })` + `library.reconfigureSync()`. Pasting
`https://github.com/owner/repo` or `owner/repo` into either box fills both. Clearing all three fields + save turns sync off.
**이 기기에서 키·토큰 지우기** (confirm) blanks every API key and the GitHub token (owner/repo/branch kept) and calls `reconfigureSync()`.
`settings.ui.theme` additionally accepts `'system'` (follows `prefers-color-scheme`). With `?mock=1` the provider radios are disabled.

## Design tokens shared with the viewer (css/app.css `:root`, redefined under `[data-theme='dark']`)

`--pr-hover` rgba(245,176,65,.34) (warm amber) · `--pr-active` (mocha tint) · `--pr-active-ring` (outline colour) · `--pr-flash` ·
`--mark-{yellow,green,blue,pink,orange,purple,red,grey}` (fills) and `--mark-*-line` (underline colours) ·
`--viewer-bg` · `--tp-font-size` (= `settings.ui.fontSize`, set by app.js).
css/viewer.css keeps its own `--pdfv-*` values (pages are white in both themes): amber hover, mocha active ring,
a Mocha Mousse text selection (`--pdfv-selection`, instead of pdf.js's system AccentColor) and warm overlay text
(`--pdfv-overlay-fg`, `--pdfv-overlay-muted` ≥ 5.3:1 on both overlay papers).

## Brand: 갈피 (GALPI)

- Owner-made artwork in `assets/brand/` (full-bleed squares on mocha #8C6250): `icon-{32,64,180,192,512}.png`,
  `icon-maskable-512.png`, `galpi-wordmark-1254.webp` / `wordmark-600.png`, `galpi-g-1254.webp`. `index.html` links the
  favicons, the apple-touch icon and `manifest.webmanifest`; the Pages workflow publishes `assets/` and the manifest.
- `brandImage(kind, { size, className, alt })` (components.js) — `'mark'` (sidebar), `'mark-lg'` (first screen), `'wordmark'`
  (onboarding hero; the join welcome screen is gone since 2026-10-19); URLs are resolved from the module, so harness pages under `/tests/` work too.
  `messageScreen({ brand: 'wordmark'|'mark' })` shows the artwork instead of the icon.
- Theme: warm paper + mocha ink. One accent (`--accent` = the icon's mocha; latte `#cc9c83` in dark) for primary
  buttons, the current place, links, focus (`--focus-ring` = Pantone Mocha Mousse #A47864) and progress. Bookmark
  ribbon (`--ribbon`, `--ribbon-clip`) only on the current sidebar item, the selected reader tab and empty states.
  All text tokens ≥ 4.5:1 on the surfaces they are used on (focus ring, ribbon, icons ≥ 3:1).
- `theme-color`: `#f7f3ec` / `#191411` (index.html per `prefers-color-scheme`; app.js `applyTheme()` sets every
  theme-color meta to the app's own theme). Internal ids, storage keys (`pr.*`), database names, repo names and the
  data repository's commit messages (js/store) still say "paper reader" / "논문 리더" on purpose.

## Findings for the integrator / other builders

> Integration status: items 1–3 are resolved (viewer root position, mock-session settings, fit-width cap) — see `integration.md`.

1. **Fixed here:** `css/viewer.css` gives `.pdfv-root` `position: relative`, which (same specificity, loaded later)
   collapsed the reader's absolutely positioned viewer host to 32 px — the PDF was invisible. The shell now uses
   `.reader .reader-left > .viewer-host { position: absolute; inset: 0 }`.
2. **Core (js/core/settings.js, frozen):** with `?mock=1`, `current.provider` is overwritten in place, so the first
   `settings.set()` of that session persists `provider: 'mock'` to localStorage; the user then stays on the mock
   provider even without `?mock=1`. Suggest persisting the stored provider instead of the session override.
3. With fit-width in 원문/겹쳐보기 (full window width) the real viewer zooms to ~230 % on a 1440 px screen.
   Consider capping the fit-width scale (e.g. max page width ≈ 1000 px) in `viewer.js`.
4. Playwright on Windows: import it as `file:///C:/Users/dindoo/Projects/pr-tools/node_modules/playwright/index.mjs`
   (a bare `C:/…` path is rejected by Node's ESM loader).

## Known limitations

- Library list is not virtualised (fine for hundreds of papers); no multi-select. Paper rows are not
  keyboard-draggable — the row menu (⋯, right-click, Shift+F10) has **폴더로 이동…** as the keyboard path.
- The translation pane renders every sentence at once (fine for a few thousand sentences).
- 번역 겹쳐보기 hides the right pane; opening a panel switches back to 나란히.
- Dark-theme users may see a brief light flash on load (the CSP forbids an inline theme script).

## How to test

```bash
node tests/shell/run.mjs            # 34 checks, all deps stubbed (import maps); starts python -m http.server 8104 if needed
node tests/shell/run-real.mjs lu2025   # integration smoke: real js/pdf, js/ai (mock provider), js/features;
                                        # only js/store/* stubbed; fixture PDF served by route interception
```
Screenshots and `results.json` go to `C:/Users/dindoo/Projects/pr-tools/out/shell/`. Paid/remote API hosts are
blocked by route in both runners. Manual: open `tests/shell/harness.html?mock=1` (params: `lib=empty`,
`sync=off|error|offline`, `reset=1`, `trdelay=<ms>`); `harness-degraded.html` and `harness-fatal.html` show the
degradation paths.
