# AI module — notes (js/ai/*)

Owner files: `providers.js`, `claude.js`, `gemini.js`, `mock.js`, `prompts.js`, `translator.js`, `tasks.js`, `usage.js`.
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
    (`'done'|'pending'|'failed'|null`), `toJSON()` (the translation data file).
  - events: `'update'` `{ sids, failed? }` (failed sentences come as `{ sids: [], failed: [...] }`),
    `'pending'` `{ sids }` when a batch is sent, `'error'` `{ message, fatal, code, sids }`,
    `'done'` `{ cancelled, stopped, progress }` (`stopped` = ended by an error, not by the user).
  - `translateAll/translatePages/translateSids` resolve with the final `progress` (also on cancel — they never reject).
- **tasks**: options also accept `paperId` (usage tagging). `summarize`/`keyPoints` also return `model`;
  the stream's final `{ done: true, usage, model }`. Exported helpers: `normalizeHistory`, `selectKeyPoints`.
- **mock.js** exports `mockControl` (latency, dropped ids, injected failures, request log, max concurrency seen) for tests.
- **claude.js** exports `loadSdk`, `buildParams`, `resetClaudeState`, `isFallbackBetaDisabled`, `FALLBACK_BETA`;
  **gemini.js** exports `buildBody`, `toGeminiSchema`, `GEMINI_BASE`. **providers.js** exports `PROVIDER_OPTIONS`,
  `AI_ERROR_CODES`, `aiError`, `isAbort`, `throwIfAborted`.

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
  request fails twice and is reported as `bad_request`. Streams (chat/explain) do not use the beta. Haiku has no
  server-side fallback.
- **Stop reasons**: `refusal` → Korean `refusal` error (with `category`), never retried. `max_tokens` on a JSON
  request → `max_tokens` error (translator splits the batch in half); on text → returned with
  `stopReason: 'max_tokens'` and tasks append a Korean "잘렸습니다" note.
- **Error mapping** uses SDK classes only (`instanceof`, most specific first: abort → timeout → connection → 401 →
  403 → 404 → 429 → 400 → 5xx → 402/413 by `status`). The API's own message is appended to 400 errors as `상세:`
  because it is the only useful diagnosis (e.g. "prompt is too long", "credit balance is too low").
- **Prompt caching**: translation system = `[rules (~4.9K chars), title + abstract + glossary (cache:true)]`, identical
  for every batch of a paper (asserted in tests) and comfortably above the 512-token minimum. Assist tasks share one
  system = `[assist rules, whole paper as "[sid] sentence" lines (cache:true)]`, so summary, chat, explain and key
  points on the same model reuse one cache entry. Per-request content lives only in the user message.
- **Translator scheduling**: one shared queue; each `translate*()` call puts its sentences at the front (latest
  request first, reading order within it) — so "translate this page" during a full run jumps the queue.
  A batch never goes backwards in reading order and never spans more than one page boundary gap (`page > last + 1`
  breaks it), so a prioritised page is not padded with unrelated text and the 2-sentence context stays meaningful.
  Gaps of already-translated sentences inside the same region are allowed (that is how "consecutive" is read).
- **Cache warm-up**: a cold run sends its first batch alone; the other workers start once a response has arrived
  (cache written), so parallel batches read the cached prefix instead of each paying the 1.25× write. "Warm" lasts
  4 minutes after the last response (cache TTL is 5 min).
- **Failure policy**: missing ids → retried once in a batch of just those ids, then `failed`. JSON parse error →
  retried once. `max_tokens` → halves, recursively, down to single sentences. Refusal → failed, no retry. Fatal
  (auth, permission, billing, not_found, no key) or `bad_request`/`quota` → the run stops at once. Other transient
  errors (rate limit after SDK retries, 5xx, network) fail their batch; 3 in a row stop the run. `'error'` is emitted
  once per distinct message per run (no toast storms).
- **Wordless sentences** (no `[A-Za-z]{2,}`: "3.5 ± 3.1", lone numbers) are "translated" locally as themselves,
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
  The key is sent only as `x-goog-api-key`, never in the URL. Gemini usage is priced at $0 (no Gemini prices in config).

## Integrator requests

- `config.js PRICES`: Claude Opus 5.5 cache reads are **$0.20/MTok (0.05×)**, not 0.1× (Anthropic price table, cached
  2026-10-06). `usage.js` handles this with a local `CACHE_READ_OVERRIDES` table; `PRICES[m].cacheRead` /
  `PRICES[m].cacheWrite` (absolute USD/MTok), if added to config, take precedence — moving the value there would make
  config the single source of truth.
- `reader-view.js`: pass `paperId` to `new Translator({ ..., paperId })` and to tasks (`{ paperId }`) so the usage
  screen can show per-paper cost (optional).

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
  prompt formats/parsers, strict schemas, tasks with the mock.
- `claude` — the real SDK 0.131.0 loaded from jsDelivr in Edge; `https://api.anthropic.com/**` is routed by Playwright,
  exact request bodies/headers asserted, canned JSON and SSE (`message_start … message_stop`) returned.
- `gemini` — routed `generativelanguage.googleapis.com`, JSON + SSE, pagination, 429/quota, key errors, safety.
- `translator` — synthetic 12-page, 313-sentence PaperDoc with the mock: limits, priority, hash cache, retry,
  max_tokens split, cancel, concurrency cap, cost totals, fatal/transient stops, cached prefix + context.
- `realpdf` — the four fixture PDFs through `js/pdf/extract.js` + Translator/tasks with the mock (fixtures are
  served by a Playwright route, never copied; nothing leaves the browser).
