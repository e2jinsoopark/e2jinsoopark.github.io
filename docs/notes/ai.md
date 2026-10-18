# AI module — notes (js/ai/*)

Owner files: `providers.js`, `claude.js`, `gemini.js`, `mock.js`, `prompts.js`, `terms.js`, `translator.js`, `tasks.js`, `usage.js`.
Tests: `tests/ai/*` (run `node tests/ai/run-all.mjs`; output goes to `C:/Users/dindoo/Projects/pr-tools/out/ai/`).

## Contract additions (backwards compatible)

- **Provider results** also carry `stopReason` (`'end_turn' | 'max_tokens' | …`) and, for `complete()`, `model`.
  The stream's final event is `{ type: 'done', usage, stopReason }`.
- **Provider options** may include `task` (`'translate' | 'summary' | 'chat' | 'explain' | 'keyPoints' | 'quickTranslate'`).
  Real providers ignore it; the mock uses it to pick canned answers.
- **Errors**: every provider/task throws `aiError()` from `providers.js` — an `Error` with a Korean `message` plus
  `code` (`no_key | auth | permission | billing | not_found | bad_request | rate_limit | quota | server | network |
  timeout | aborted | refusal | max_tokens | parse | unknown`) and `fatal` (true for no_key/auth/permission/billing/
  not_found). Cancellation has `name === 'AbortError'`, `code === 'aborted'`. Errors after a billed response
  (refusal, max_tokens, parse) carry `usage`.
- **Usage**: `usage.parts` (optional) lists per-attempt usage when Claude's server-side fallback re-ran a request on
  another model; `costUsd()` prices each part at its own model's rates and `recordUsage()` books each part under its
  model. Extra exports: `emptyUsage`, `addUsage`, `priceFor`, `monthKey`, `clearUsage`. `recordUsage` emits
  `bus` event `'usage:change'` `{ usage, usd, summary }`. `usageSummary()` also returns `byTask` and `byPaper`.
- **Translator**
  - constructor also accepts `provider` (test injection; default `getProvider()` per request) and `paperId`
    (tags recorded usage — **reader-view should pass `paperId: paper.id`**).
  - `progress` also has `failed`, `pending`, `running`. Extra getters/methods: `running`, `usage`, `statusOf(sid)`
    (`'done'|'pending'|'failed'|null`), `toJSON()` (the translation data file, with the optional `terms`), `terms`
    (the paper's established renderings `[{ en, ko }]`, see *Term map*), `warnings`.
  - A sentence whose stored translation is still the English source is `failed` right after construction
    (`statusOf`, `progress.failed`); reader-view marks those in the pane when the paper opens.
  - events: `'update'` `{ sids, failed? }` (failed sentences come as `{ sids: [], failed: [...] }`),
    `'pending'` `{ sids }` when a batch is sent, `'error'` `{ message, fatal, code, sids }`,
    `'done'` `{ cancelled, stopped, progress }` (`stopped` = ended by an error, not by the user).
  - `translateAll/translatePages/translateSids` resolve with the final `progress` (also on cancel — they never reject).
- **tasks**: options also accept `paperId` (usage tagging). `summarize`/`keyPoints` also return `model`;
  the stream's final `{ done: true, usage, model }`. Exported helpers: `normalizeHistory`, `selectKeyPoints`.
- **mock.js** exports `mockControl` (latency, dropped ids, injected failures, request log, max concurrency seen) for tests;
  `mockControl.termsWith(req)` sets the `terms` of translation answers (default `[]`), and each logged request has the
  `terms` it was sent (`<terms>`) and `retry`.
- **prompts.js** also exports `NURSING_TERMINOLOGY`, `MAX_TERMS_PER_REQUEST` (60), `MAX_NEW_TERMS_PER_ANSWER` (10);
  `translationUserMessage({ items, context, introduced, terms, retry })` and its parser return `terms` / `retry`.
  **translator.js** also exports `hasWordsToTranslate(text)`, `fidelityProblem(sentence, ko)`, `isCopyAsIs(text)`.
  **terms.js**: `TermMap`, `normWords`, `termKeys`, `glossaryKeys`, `MAX_TERMS` (200).
- **Model helpers** (2026-10-18, see `models.md`): every real provider also has `pickDefaultModel(models, kind)`
  (`'translate'` = fast/cheap tier, `'assist'` = stronger tier) and `isLegacyModel(id)`; `testKey()` may return the
  live list as `models`. A model the key/code cannot use (missing, retired, not allowed for the invite code, needing a
  verified OpenAI organization) is `not_found` **with `err.model`**. `getProvider()` returns the
  provider wrapped by `js/ai/models.js` (automatic model choice, self-healing on not_found); `rawProvider()` is the
  plain one; `refreshModels(id)` reads the key's list and picks the models. Providers: `relay`, `claude`, `openai`
  (`openai.js`, see `openai.md`), `gemini`, `mock`. Tasks return / stream the model that answered (`res.model`,
  `done.model`).
- **claude.js** exports `loadSdk`, `buildParams`, `resetClaudeState`, `isFallbackBetaDisabled`, `FALLBACK_BETA`;
  **gemini.js** exports `buildBody`, `toGeminiSchema`, `GEMINI_BASE`, `pickGeminiModel`, `isLegacyGeminiModel`;
  **claude.js** also `pickClaudeModel`, `isLegacyClaudeModel`. **providers.js** exports `PROVIDER_OPTIONS`,
  `AI_ERROR_CODES`, `aiError`, `isAbort`, `throwIfAborted`, `rawProvider`, `refreshModels`, `describeModelChanges`.

## Decisions

- **Claude request shape** (verified byte-for-byte in `tests/ai/claude.test.mjs`): `system` is always an array of
  text blocks; blocks marked `cache: true` get `cache_control: {type:'ephemeral'}`; JSON via
  `output_config.format = {type:'json_schema', schema}`; depth via `output_config.effort` (`low` for translation,
  key points and quick translate; `medium` for summary/chat/explain); never `thinking`, `temperature`, `top_p/k`.
  SDK `maxRetries: 3`. Non-streaming `max_tokens` is capped at 20 000 (the SDK refuses larger non-streaming requests).
- **Server-side refusal fallback**: non-streaming Sonnet 5.5 / Opus 5.5 calls go through
  `client.beta.messages.create({..., betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default'})`. If that
  request is a `BadRequestError`, the identical request is sent once without the beta; only if *that* succeeds is the
  beta remembered as rejected (module memory, per page load). This avoids matching error text: a genuinely bad
  request fails twice and is reported as `bad_request`. Streams (chat/explain) use it too
  (`client.beta.messages.stream`); a 400 before the first event retries the stream without it. Haiku has no
  server-side fallback.
- **Stop reasons**: `refusal` → Korean `refusal` error (with `category`), never retried. `max_tokens` on a JSON
  request → `max_tokens` error (translator splits the batch in half); on text → returned with
  `stopReason: 'max_tokens'` and tasks append a Korean "잘렸습니다" note.
- **Error mapping** uses SDK classes only (`instanceof`, most specific first: abort → timeout → connection → 401 →
  403 → 404 → 429 → 400 → 5xx → 402/413 by `status`). The API's own message is appended to 400 errors as `상세:`
  because it is the only useful diagnosis (e.g. "prompt is too long", "credit balance is too low").
- **Prompt caching**: translation system = `[rules + nursing terminology (~8.6K chars), title + abstract + glossary
  (cache:true)]`, identical for every batch of a paper (asserted in tests) and comfortably above the 512-token minimum.
  Assist tasks share one system = `[assist rules + nursing terminology + glossary, whole paper as "[sid] sentence"
  lines (cache:true)]`, so summary, chat, explain and key points on the same model reuse one cache entry.
  Per-request content — including the growing `<introduced>` and `<terms>` lists — lives only in the user message.
- **Translator scheduling**: one shared queue; each `translate*()` call puts its sentences at the front (latest
  request first, reading order within it) — so "translate this page" during a full run jumps the queue.
  A batch never goes backwards in reading order and never spans more than one page boundary gap (`page > last + 1`
  breaks it), so a prioritised page is not padded with unrelated text and the 2-sentence context stays meaningful.
  Gaps of already-translated sentences inside the same region are allowed (that is how "consecutive" is read).
- **Cache warm-up**: a cold run sends its first batch alone; the other workers start once a response has arrived
  (cache written), so parallel batches read the cached prefix instead of each paying the 1.25× write. "Warm" lasts
  4 minutes after the last response (cache TTL is 5 min).
- **Failure policy**: missing ids → retried once in a batch of just those ids, then `failed`. JSON parse error →
  retried once. `max_tokens` → the finished `{id, ko}` entries of the cut-off answer are kept, the rest is
  bisected; a batch's `max_tokens` scales with its size (4K–16K) so a runaway costs little. Refusal → bisected the
  same way, so only the refused sentence fails (with a hint to switch the translation model). Fatal
  (auth, permission, billing, not_found, no key) or `bad_request`/`quota` → the run stops at once. Other transient
  errors (rate limit after SDK retries, 5xx, network) fail their batch; 3 in a row stop the run. `'error'` is emitted
  once per distinct message per run (no toast storms).
- **Fidelity checks** on every accepted translation: it must not be still the English source, multi-digit numbers
  of the source must survive, a long sentence must not shrink below 20 %. A failing answer is re-requested once (the
  retry's user message says the segments came back missing, incomplete or in English). If the retry is still English
  the sentence is **failed** — not saved, not shown, counted in `progress.failed`, one `'error'` per run ("영어 그대로
  돌아온 번역은 실패로 표시했습니다 …"), `'update' { failed }` so the pane shows 다시 시도. Other problems on the retry are kept
  with `items[sid].w` (warning) and the pane marks them ("원문과 비교").
- **"Still English"** (2026-10-18, regression untranslated-counted-done: Haiku returned the Lu 2025 affiliations,
  Keywords, Correspondence and Received/Accepted lines unchanged and they counted as done) = no Hangul in the answer
  while `hasWordsToTranslate(source)`: not copy-as-is, and one of: a `Label:` at the start or after `|`; a prose word
  in any case (is, was, this, what, …); a heading / front-matter / affiliation word or month (Abstract, Keywords,
  Correspondence, Received, Department, Division, Faculty, January…); a two-word label (open access, School of,
  College of, meta-analysis, conflict of interest…); any other lower-case word except name particles (of, in, van,
  der…), units and statistics (mg, df, CI…). So author lists, journal titles ("Nursing in Critical Care",
  "International Journal of Nursing Studies"), "© 2025 The Author(s).", "Taipei, Taiwan", "RCT", URLs and numbers may
  come back as they are. Words that also occur in journal or institution names (Research, Review, Studies, Clinical,
  Hospital, University, Institute, Nursing, Care) are deliberately not signals. Checked offline against all 138 real
  Haiku/Sonnet answers of that run (pages 1–2): exactly Haiku's four front-matter lines are flagged. References are exempt.
  A stored item that is still English (files written before this rule) loads as failed; `mergeCached` skips it.
- **Front matter rule** in the translation prompt: labels, keywords, dates and affiliation unit words/places are
  translated (Keywords 주요어, Correspondence 교신저자, Received 접수일, Department of Nursing 간호부/간호학과, "Taipei,
  Taiwan" 대만 타이베이); institution names (hospital, university, company), person names, journal names, e-mail
  addresses, URLs and DOIs stay in their original form.
- **Term map** (`terms.js`, regression term-drift: Haiku wrote ETT as 기관내 튜브 / 기관내관 / 기관튜브 / 기관삽관(ETT) and
  MDRPI as 욕창 / 압박손상 on different pages). `TRANSLATION_SCHEMA` has a required (strict-mode) but possibly empty
  `terms: [{ en, ko }]`: the Korean the answer used for recurring technical terms not yet established. An entry is
  kept only if its English (phrase or "(ABBR)", plural-folded: ETTs → ett, injuries → injury) occurs in the batch's
  source and its Korean (a trailing "(English)" stripped) occurs in one of the batch's accepted translations; the
  first rendering of a concept wins, ≤ 10 per answer, ≤ 200 per paper. Every later batch gets the established terms
  that occur in its sentences or context (≤ 60) as `<terms>` "en → ko" lines in the user message — after the cached
  prefix, so the system prompt stays byte-identical — and the rules make them binding. The user glossary wins: a term
  whose key or abbreviation equals a glossary entry, or that contains a glossary phrase, is never sent (and not
  recorded). Answers without `terms` (older fakes) are fine. Saved as `translation.json` `terms: { [normalised English]:
  { en, ko } }` (only when non-empty), loaded on open and by `mergeCached`; `js/store/merge.js` unions it by key (local
  wins), like `items`. Old files have no `terms`; old readers ignore it.
- **Nursing terminology** (`NURSING_TERMINOLOGY`, ~1.8K chars, in the cached prefix of the translation, quick-translate
  and assist prompts so the pane, summary, chat and explanations agree): devices (기관내관, 비위관, 고정기구, 고정,
  접착테이프); device repositioning = 위치 변경 / 재위치 — never 체위변경, which is only for turning the patient;
  dislodgement 이탈, unplanned extubation 계획되지 않은 발관; MDRPI = 의료기기 관련 욕창; skin tear 피부 찢김; plus the
  previous list (섬망, 낙상, 신체보호대, 기계환기, research and statistics terms). **욕창, not 압력손상**, for pressure
  injury: (1) the Korean nursing literature uses 욕창 for both pressure ulcer and pressure injury, including the device
  subtype — e.g. 구미지·심영아·강인순, 「중환자실 의료기기 관련 욕창의 위험요인」, *Journal of Korean Academy of Nursing*
  49(1):36, 2019 (https://synapse.koreamed.org/upload/synapsedata/pdfdata/0006jkan/jkan-49-36.pdf: 64 × 욕창, 압력손상
  once and only as a description), and the 울산대 간호학 석사논문 「중환자실 환자의 의료기기 관련 욕창 특성과 위험요인」
  (https://oak.ulsan.ac.kr/handle/2021.oak/9738); (2) hospital nursing manuals use the same term (checked in one
  tertiary-hospital ICU manual: "의료기기 관련 욕창 예방"); (3) in Korean critical-care
  texts 압력손상 also means barotrauma ("기흉 같은 압력손상"), so it would be ambiguous in exactly these papers. The task
  brief suggested 압력손상; the evidence points the other way, so 욕창 is used everywhere (one rendering) and switching is
  a one-line change in `NURSING_TERMINOLOGY` (prompts.js).
- **First mention across batches**: each request lists English terms earlier translations already gave in
  parentheses (`<introduced>`) and the Korean of the context sentences (`<context_ko>`).
- **Cache by hash**: a sid whose stored item does not match falls back to any stored item with the same text hash.
- **A failed save** (storage full) stops the run; **fatal / run-stopping errors** (no key, auth, billing, 400, quota)
  release the sentences (not "failed") and emit one fatal error.
- **Wordless sentences** (no `[A-Za-z]{2,}`: "3.5 ± 3.1", lone numbers) and sentences that are only a URL, DOI,
  e-mail address or ORCID (plus a label like "E-mail:") are "translated" locally as themselves,
  never sent, and count as done. They are not written to the translation file (re-derived on load).
- **Cache file**: `toJSON()` writes only items valid for the current doc (stale hashes are dropped). Items are
  accepted only when `items[sid].h === hash(sentence.text)` and `targetLang` matches.
- **Key points**: model output is validated (existing body/caption sid, known category, no duplicates), sorted in
  reading order and, above 25, thinned evenly so marks stay spread across the paper.
- **Gemini**: `responseSchema` = JSON schema converted to the OpenAPI subset (whitelisted keywords, upper-case
  types, `nullable`, `propertyOrdering`; `additionalProperties` stripped). `effort` is ignored (thinking config is
  model-specific). Thought parts are dropped from text; `thoughtsTokenCount` is counted as output. Retries: 5xx
  (×2, backoff) and 429 only when `RetryInfo.retryDelay ≤ 20 s` (per-minute limits); a 429 without it (daily free-tier
  quota) fails at once with a Korean message about the free tier's daily quota and stops the translation run.
  The key is sent only as `x-goog-api-key`, never in the URL. Gemini and GPT usage is not priced (`isPriced()` false;
  the UI shows "비용 미집계" instead of $0). A newer Claude model missing from `PRICES` (e.g. a new Haiku picked
  automatically) is estimated at its family's known rates (Haiku/Sonnet/Opus 5.5).
- **Claude errors**: a 400 "credit balance is too low" is `billing` (fatal, Korean text with the Max-credit hint).
  `testKey()` says the credit balance is not checked. Requests get a timeout from their output size (2–10 min) and
  `maxRetries: 2`. Chat turns ask for automatic caching of the conversation tail (`cache_control` top level), and the
  history is trimmed in chunks of 10 (≤ 30 messages) so the cached prefix stays stable.
- **Pricing**: fallback targets (claude-opus-4-8, claude-opus-5, claude-sonnet-5) are in `PRICES`; another unknown
  `claude-*` model is priced at the requested model's rates (`usage.requestedModel`). Usage of stopped/failed streams
  and of refused/cut-off summaries and key points is recorded too.
- **Assist prompts** carry the user's glossary and the English-terms setting. Key points use effort `medium` like the
  other assist tasks (the JSON format may still keep it from sharing their cache entry).

## Integrator requests

> Integration status: `reader-view` passes `paperId`; `Translator.mergeCached(cached)` was added for synced translation files; summary headings were aligned — see `integration.md`.

- `config.js PRICES`: Claude Opus 5.5 cache reads are **$0.20/MTok (0.05×)**, not 0.1× (Anthropic price table, cached
  2026-10-06). `usage.js` handles this with a local `CACHE_READ_OVERRIDES` table; `PRICES[m].cacheRead` /
  `PRICES[m].cacheWrite` (absolute USD/MTok), if added to config, take precedence — moving the value there would make
  config the single source of truth.
- `reader-view.js`: pass `paperId` to `new Translator({ ..., paperId })` and to tasks (`{ paperId }`) so the usage
  screen can show per-paper cost (optional).
- Done outside the AI files (2026-10-18, translation-quality fixes): `js/store/merge.js` `mergeTranslation` unions
  `terms` by key (local wins; tested in `tests/store/unit.test.mjs`); `js/ui/reader-view.js` `#seedFailedStatus()`
  marks the sentences the translator reports as failed right after it is created (stored English answers), so the
  pane shows 다시 시도 and "실패한 문장 다시 번역 (n)" counts them; `docs/SPEC.md` §2.2/§3.3/§3.4 describe `terms` and
  the still-English rule.

## Known limitations

- Monthly usage is per browser (localStorage), as specified; it is an estimate from the API's `usage` fields, not
  the bill. Gemini cost is shown as $0.
- Mid-stream refusals (chat/explain) throw after partial text was already yielded; the UI keeps the partial text.
- The fallback-beta rejection memory is per page load; the first Sonnet/Opus call after a reload re-probes once
  (400s are not billed).
- Very long papers are cut at 600 000 chars of `[sid] sentence` lines for assist tasks (a note tells the model);
  translation is unaffected (batched).

## How to test

```
node tests/ai/run-all.mjs        # all suites (≈20 s); or a single suite, e.g. node tests/ai/translator.test.mjs
```
- `unit` — usage math (Haiku short/long rates incl. cache-inclusive threshold, Sonnet/Opus, parts), monthly totals,
  prompt formats/parsers, strict schemas, tasks with the mock; the still-English classifier (front matter vs name-only
  lines), the nursing terminology in all three cached prefixes, `<terms>` sanitising, `TermMap` matching/merging.
- `claude` — the real SDK 0.131.0 loaded from jsDelivr in Edge; `https://api.anthropic.com/**` is routed by Playwright,
  exact request bodies/headers asserted, canned JSON and SSE (`message_start … message_stop`) returned.
- `gemini` — routed `generativelanguage.googleapis.com`, JSON + SSE, pagination, 429/quota, key errors, safety.
- `translator` — synthetic 12-page, 313-sentence PaperDoc with the mock: limits, priority, hash cache, retry,
  max_tokens split, cancel, concurrency cap, cost totals, fatal/transient stops, cached prefix + context; term map
  across batches (binding `<terms>`, unchanged system prefix, saved/reloaded/merged, glossary wins); English answers
  → failed after one retry, name-only lines accepted, stored English loads as failed, 다시 시도 → done.
- `realpdf` — the four fixture PDFs through `js/pdf/extract.js` + Translator/tasks with the mock (fixtures are
  served by a Playwright route, never copied; nothing leaves the browser).
