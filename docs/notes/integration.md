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

## Review fixes (2026-10-18)

A five-lens review (security, data, pdf, ai, ux) was worked through; module notes describe the new behaviour.
Cross-module changes:

| Area | Change |
|---|---|
| `store/merge.js` (new), `store/sync.js`, `store/library.js` | Merge rules moved to a pure module. Combined records get `updatedAt = max + 1`; ai.json merges `chat`/`explanations` by id; translation.json is always a union. Library memory keeps a merge base and serializes reads/writes. Stale sync bases are merged before a push; refused uploads are skipped and named; repo switches need consent (`settings.github.carryOver`). `Library.updatePaperData` (read-modify-write), `syncTargetChange`, `storagePersisted`, `wipeLocalData`. |
| `ui/reader-view.js` ↔ store | `ctx.saveAi` is a read-modify-write; ai.json remote changes reload `getAi()` and emit bus `'paper:ai-change'` (chat and summary panels listen). Translation load failures are retried, saves flush on page hide and every ≤ 5 s, a failed save stops the translator. |
| `features/annotations.js` ↔ store | Imports `mergeRecords` from `store/merge.js` (3-way merge against the last stored version); highlights carry `seg` and are re-anchored by quote. |
| `ai/translator.js` ↔ reader | Fatal errors release sentences (one fatal `'error'`, no failed sids); `'update'` may carry `warned` and `translator.warnings` (fidelity) → pane `check` marks. Mock translations are now `'〔번역〕 ' + full source text`; `mockControl.translateWith` / `failWhen` support content-specific tests. |
| `core/settings.js` | Follows other tabs (`storage` event, `settings:change` with `external: true` → `app.js` reconfigures sync); `set()` merges into what is stored; `/tests/` pages off localhost are forced to mock. |
| `core/config.js` | `LIMITS.maxPdfBytes` 70 MB; prices for fallback models. |
| `index.html` | CSP narrowed to the exact jsDelivr paths (SDK 0.131.0 and its three pinned dependencies, Pretendard v1.3.9); jsDelivr removed from `connect-src`. |
| `ui/components.js` | `renderMarkdown`: explicit tag/attribute allow-list (no class/id/data-*/aria-*), raw HTML in model output escaped. |
| `app.js` | `#/settings/<section>` deep links. |

Deferred (not done here):
- **Vendoring the Anthropic SDK with an integrity check** — needs the bundle (and its three dependencies) downloaded
  into `vendor/`; the CSP now allows only those exact package versions. Do it when a download can be approved.
- **Dedicated hosting origin** — a deployment choice (see README › 배포); the app warns when it runs on a shared
  `*.github.io/<project>/` origin.
- **pdf.js `PagesMapper` listener leak** — in the frozen vendor file (see pdf notes).
- **Translator batches in flight on 중지/close** are still aborted (their input may be billed); summaries and key
  points now finish and are saved.

Regression tests added: `tests/store/unit.test.mjs` (tie stamps, ai unions, segVersion union, internal repos, classic
tokens, protected branch), `tests/store/run.mjs` 17–20 (rename vs. touch, push after a failed download, chat on two
devices, a refused PDF) and the consent step in 16, `tests/ai/translator.test.mjs` (fatal release, URL/DOI copy,
max_tokens salvage + scaled caps, refusal bisection, fidelity, first mention, hash cache, failed save),
`tests/ai/claude.test.mjs` (credit 400, streaming fallback, chat caching), `tests/ai/unit.test.mjs` (fallback prices),
`tests/pdf/viewer.test.mjs` regressions (rotated pages via `harness.html?rotate=1:90,2:180`, page cleanup + pixel
budget, render-failure backoff), `tests/shell/run.mjs` (sanitizer classes, 연결 테스트 saves, onboarding deep link),
`tests/shell/run-real.mjs` (bad key → one toast with 설정 열기), `tests/features/run.mjs` (no auto summary, S2 consent).

## GPT and automatic model choice (2026-10-18)

Third own-key provider `openai` (“GPT (OpenAI)”, `js/ai/openai.js`, `openai.md`) and automatic model choice with
self-healing for every provider (`js/ai/models.js`, `models.md`): models are picked from each key's live list
(on key save/test, code registration, every relay visit), `getProvider()` replaces a configured model that answers
not_found and retries once (one toast). Cross-module changes: `core/settings.js` (`openai`, `autoModels`, user picks
`''` = 자동 선택, migration of old Claude/Gemini values, `model(kind, provider)`, `isAiReady()` = key saved),
`core/config.js` (`DEFAULT_MODELS.openai`), `index.html` CSP `connect-src` + `https://api.openai.com` (exact strings
in `tests/shell/run.mjs` and the relay-client CSP test updated), `app.js` (`deps.refreshModels`,
`deps.describeModelChanges`, toast on bus `'ai:model-change'`), settings cards (초대 코드 · Claude · GPT · Gemini;
invitee layout with 내 API 키 쓰기), copy that named only Claude/Gemini (onboarding, reader prompt,
`AI_NOT_READY_MESSAGE`, usage note “+ GPT·Gemini”). `tests/shell/stubs/ai-providers.js` uses the real `models.js`.
Test: `node tests/models/run.mjs`.

### Integration pass (verifier, 2026-10-18)

`openai.js` reconciled with the registry and the healing wrapper (exports, `kind`, error codes and `err.model` were
already compatible); then the model choice was attacked on purpose and these root causes fixed (regression tests in
`tests/models/run.mjs`, `tests/ai/openai.test.mjs`, `tests/relay-client/run.mjs`):

| Problem found | Fix |
|---|---|
| The not_found memory was per page load: a listed-but-unusable model was picked again after every reload (one failed request + one toast per visit; for the relay until the owner changed the code) | `models.js` remembers it per key/code fingerprint in localStorage (`STORAGE_KEYS.models`, 30 days, all tabs); an explicit pick in 설정 drops the mark |
| A heal whose model list failed (401 / offline) blocked every later heal of that model for 60 s | failed heals are shared for 5 s only |
| GPT/Gemini key with no text model: every call listed the models again and then sent a request without a model (GPT: a misleading "모델이 선택되지 않았습니다" 400; Gemini: `ids[0]` could be a TTS/image model) | concurrent model-less calls share one list; no usable model → one Korean `not_found` before any paid request; Gemini picker never returns speech/image/embedding ids and falls back to the best legacy Flash only when nothing newer exists |
| Relay 403 "이 초대 코드로는 <model>을 쓸 수 없습니다" (code changed while a tab is open) stopped the task | `not_found` with `err.model` → healed to an allowed model |
| OpenAI 403 "must be verified to use the model" was `permission` (every summary failed for unverified organizations) | `not_found` with `err.model` → healed to another GPT model; a verification message about streaming still falls back to non-streaming |
| `?mock=1` with a saved invite code: the invitee card called the real `/relay/me` | skipped in mock sessions |
| 설정 open in two tabs: a provider picked in one left the other showing the old card checked (clicking it did nothing) | the AI section re-renders on an external provider change |
| OpenAI docs drift (re-checked live) | `prompt_cache_key` before GPT-5.6; `phase: 'final_answer'` on assistant history turns for GPT-5.3+ (`openai.md`) |

## Invite-code relay (2026-10-18)

Colleagues without an API key use the owner's Cloudflare Worker (`relay/`) through invite codes. Architecture, the
test hook for a local Worker (staged site copy, production CSP untouched), the end-to-end test
(`node tests/relay-e2e/run.mjs`) and the deploy checklist: [`relay.md`](relay.md). App side: [`relay-client.md`](relay-client.md).

## 공용 서재 — shared team library (2026-10-19)

One team library for everyone with an invite code, through the relay's GitHub-compatible proxy (contract
[`docs/SHARED.md`](../SHARED.md), as built §5). Architecture, reconciliation of relay / store / UI, deploy steps,
adding a second library and the end-to-end test (`node tests/shared-e2e/run.mjs`, real app + real Worker + fake
GitHub with the personal and the team repo): [`shared.md`](shared.md).

| Area | Change at integration |
|---|---|
| `ui/library-view.js` | 최근 활동 hides commits that are no action on the shared library: `내 메모·AI 결과 동기화` (a person's own `people/<id>/` files) and `논문 정보 갱신` (progress counts only) — `QUIET_ACTIVITY`. |
| `tests/shared-e2e/run.mjs` (new) | Owner + 김간호사 + 이간호사 (two devices) against the real Worker; repo checks for personal papers, invite codes and `people/` isolation. |
