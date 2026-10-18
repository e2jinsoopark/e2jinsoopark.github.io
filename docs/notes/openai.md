# GPT (OpenAI) provider — notes (`js/ai/openai.js`)

Owner files: `js/ai/openai.js`, `tests/ai/openai.test.mjs` (registered in `tests/ai/run-all.mjs`).
Export used by `providers.js`: `openaiProvider` (id `'openai'`). It reads the key from `settings.get().openai.apiKey`.

Docs were read on **2026-10-18** at `developers.openai.com/api/docs` (the old `platform.openai.com/docs` URLs
redirect there; every page is also served as Markdown by appending `.md`). Nothing here was checked against the live
API with a real key (none exists on this machine); the request shapes follow the reference pages, and the CORS
behaviour was checked with unauthenticated curl requests.

## Why the Responses API (not Chat Completions)

| Point | Evidence (docs, 2026-10-18) |
|---|---|
| Recommended for new work | Migration guide: Chat Completions "remains supported"; "Responses is recommended for all new projects". |
| Nothing we need is missing | Responses has streaming (SSE), `text.format` json_schema with `strict`, `input_image` with base64 data URLs, `reasoning.effort`, `max_output_tokens`. |
| Prompt caching we can steer | Explicit cache breakpoints (`prompt_cache_options.mode: 'explicit'` + `prompt_cache_breakpoint` on content blocks) are documented only for Responses. They let us cache exactly the blocks marked `cache: true`, as with Claude. |
| Refusals are explicit | A refusal is its own content part (`type: 'refusal'`), and the stream has `response.refusal.delta`. |
| Usage is complete | `usage.input_tokens_details.cached_tokens` and `cache_write_tokens`; streams carry usage in `response.completed`, so no `stream_options` is needed. |
| Same model coverage | The model pages for GPT-6 Luna, GPT-6.1 Sol and GPT-5.6 Terra list both Responses and Chat Completions; tool calling on Astra and 6.1 Sol requires Responses (not needed here, but the direction is clear). |

Chat Completions would also work for our text-only requests. The deciding points are explicit cache breakpoints and
OpenAI's recommendation.

## Request shape (`buildRequest`, asserted field by field in the tests)

```js
POST https://api.openai.com/v1/responses
Authorization: Bearer <key>          // content-type: application/json; no OpenAI-Organization header
{
  model,
  input: [
    { role: 'developer', content: [ { type: 'input_text', text: rules },
                                    { type: 'input_text', text: paper, prompt_cache_breakpoint: { mode: 'explicit' } } ] },
    { role: 'user', content: [ { type: 'input_text', text } | { type: 'input_image', image_url: 'data:image/png;base64,…', detail: 'high' } ] },
    { role: 'assistant', content: 'earlier answer', phase: 'final_answer' },  // history turns as plain strings; phase on GPT-5.3+
  ],
  max_output_tokens: maxTokens + reserve,  // see below
  store: false,
  reasoning: { effort: 'low' | 'medium' | 'high' },             // only on models that accept our levels
  text: { format: { type: 'json_schema', name: 'answer', schema, strict: true } },   // json requests only
  prompt_cache_options: { mode: 'explicit' },                   // GPT-5.6+ and at least one breakpoint
  prompt_cache_key: 'pr-<fnv of the cache:true blocks>',         // before GPT-5.6, when a cache:true block exists
  stream: true,                                                  // stream() only
}
```

- **System prompt → `developer` message, not `instructions`.** The caching guide says top-level `instructions` cannot
  hold a breakpoint. The `developer` role is the one the docs' examples use.
- **`store: false` always.** Responses store by default ("Defaults to true when omitted", kept ≥ 30 days). The
  migration guide adds that Chat Completions are also stored by default for new accounts. Paper text is often
  unpublished, and we never need `previous_response_id`.
- **Token parameter:** `max_output_tokens` (Responses). It "includes visible output and reasoning tokens". The reasoning guide recommends
  reserving room for reasoning. Reasoning models therefore get `maxTokens + reserve`: 4 000 / 8 000 / 16 000 for effort
  low / medium / high, medium when no effort is given, high for `-pro` models. The total is capped at 128 000 (the
  GPT-5.6 / GPT-6 output limit). Older non-reasoning models (GPT-4.x) get exactly `maxTokens`.
- **Effort:** our `low/medium/high` map 1:1 to `reasoning.effort`. The model pages list low/medium(default)/high
  for GPT-6.1 Sol and GPT-6 Luna (plus xhigh/max; Luna also `none`). For GPT-6 Astra the guide says only that `none`
  is a 400. We never send `none`, `minimal`, `xhigh` or `max`. We send it on GPT-5+ and o3+. We do not send it on `*-pro` (fixed effort), `*-chat*`, GPT-4.x or o1. We never send
  `temperature`/`top_p`, which the GPT-6 guide says to drop when reasoning is not `none`.
- **JSON:** `strict: true`. Our schemas already use only supported keywords (object/array/string/enum, `required`,
  `additionalProperties: false`, `description`). The schema is cloned; nothing is converted.
- **Prompt caching (GPT-5.6 and later):** caching is automatic for every supported model. In the default *implicit*
  mode on GPT-5.6+, the breakpoint goes at the end of the latest user message. Cache writes cost 1.25× input there, so
  each translation batch would pay 1.25× on its unique part. We send `prompt_cache_options.mode: 'explicit'` with
  breakpoints on the `cache: true` system blocks (the paper/abstract block). For chat (`cacheMessages: true`) we add
  one on the last user `input_text`, which mirrors Claude's top-level automatic caching. The limit is 4 breakpoints
  ("up to four cache writes"). Older models get no breakpoints: they cache implicitly, with no write charge. They get
  a stable `prompt_cache_key` instead (`pr-` + FNV hash of the `cache: true` blocks): the caching guide says that
  before GPT-5.6 "prompt_cache_key is important for optimizing cache hit rates" (it routes requests sharing a prefix
  to the same cache) and that GPT-5.6+ route by themselves, so 5.6+ never get it.
- **Assistant history turns** carry `phase: 'final_answer'` on GPT-5.3 and later: the input-message schema says "For
  models like gpt-5.3-codex and beyond, when sending follow-up requests, preserve and resend phase on all assistant
  messages — dropping it can degrade performance". Our history holds only the answers the user saw (final answers).
  Older models get the plain `{ role, content }`.
- **Fallback for the cache fields:** I could not test them live. If a request carrying them gets a 400, the identical
  request is sent once without them. If that succeeds, the model is remembered (per page load) as not accepting them.
  A genuinely bad request fails twice and is reported as `bad_request` (400s are not billed). This is the same
  pattern as Claude's fallback beta.

## Responses parsing

- Text = `output[]` items of `type: 'message'`, parts `output_text`. If any message has a `phase` other than
  `commentary`, commentary messages are ignored (GPT-5.4/5.5 preambles). The same rule applies to stream deltas, via
  `response.output_item.added`.
- `status: 'incomplete'` + `incomplete_details.reason: 'max_output_tokens'` → `stopReason: 'max_tokens'`. On a JSON
  request it is a `max_tokens` error with `partialText` and `usage`, so the translator salvages and bisects.
  `reason: 'content_filter'` → `refusal`.
- A `refusal` content part (or `response.refusal.delta/done` in a stream) with no answer text, or on any JSON request
  → `refusal` error with `usage`. HTTP 400 `invalid_prompt` ("flagged as potentially violating our usage policy") is
  also `refusal`, so the translator narrows it down to one sentence instead of stopping the run.
- `status: 'failed'` / `response.failed` / stream `error` event → mapped by `error.code` (`server_error` → server,
  `rate_limit_exceeded` → rate_limit, billing codes → billing).
- A stream that ends without `response.completed|incomplete|failed` → `network` ("응답이 중간에 끊겼습니다").
- **Usage:** `inputTokens = input_tokens − cached_tokens − cache_write_tokens`, `cacheReadTokens = cached_tokens`,
  `cacheWriteTokens = cache_write_tokens`, `outputTokens = output_tokens` (reasoning tokens are billed as output).
  This follows the caching guide's cost example: ordinary input = input − cached − cache writes, and each token is
  billed at one rate. `usage.model` = the response's `model`.

## Model selection (`listModels`, `pickDefaultModel(models, kind)`, `isLegacyModel(id)`)

Live list: `GET /v1/models` → `{ data: [{ id, created, owned_by, shutdown_date }] }`. The list has no pagination,
and `shutdown_date` is documented as "null if not announced".

**Kept** (`isChatModel`): ids `gpt-<digit>…` and `o<digit>…`, plus fine-tunes (`ft:<base>:…`). **Dropped:** ids
containing a word from audio, realtime, tts, transcribe, whisper, image, search, codex, instruct, cyber, diarize,
translate, live, moderation, embedding, computer, or containing `deep-research`, `chat-latest` or `search-api`.
Everything else is dropped by the prefix rule: dall-e, sora, babbage/davinci, text-embedding-*, gpt-image-*,
gpt-realtime*, gpt-oss-*, chatgpt-*, codex-mini-latest, computer-use-preview, omni-moderation. Models whose
`shutdown_date` has passed are dropped. A dated snapshot (`-YYYY-MM-DD` or `-NNNN`) is hidden when its alias is in the
list.

**Parsing:** `gpt-6.1-sol` → version [6, 1], tier `sol`. Versions compare as tuples, so 6.10 > 6.9. `gpt-4o` sorts
after `gpt-4`. Tier words: nano < mini ≈ luna < terra < standard (no word) ≈ sol < astra; pro is separate.
`listModels()` order: GPT before o-series before fine-tunes, newest version first, then Astra, Sol, plain, Terra,
Luna, mini, nano, pro. Labels look like `GPT-6 Luna (빠름·저렴)`, `GPT-6.1 Sol (고품질)`, `GPT-4.1 (이전 세대)`,
`GPT-4o (종료 예정 2026-10-23)`.

**Picker:** the newest version inside the first non-empty tier class. No id is hard-coded as the only option.

| kind | classes tried in order |
|---|---|
| `translate` (fast/cheap) | [luna, mini] → [nano] → [terra] → [sol, plain] → [astra] |
| `assist` (standard) | [sol, plain] → [terra] → [astra] → [luna, mini] → [nano] |

These are skipped: legacy ids, `-pro`, fine-tunes, and snapshots whose alias is listed. Ties go to the models page's
current recommendation (`gpt-6-luna`, `gpt-6.1-sol`), then the class order, then alias over snapshot. If nothing
fits, the fallback order is: another non-pro chat model (e.g. `o3`), then a pro model, then the same search over
legacy models (an old project may only have `gpt-4o`), else `''`. A non-chat id is never returned.
Results on realistic lists (tested):

| list | translate | assist |
|---|---|---|
| current docs (+ deprecated, non-chat, snapshots, fine-tune) | `gpt-6-luna` | `gpt-6.1-sol` |
| GPT-5 era | `gpt-5.4-mini` | `gpt-5.5` |
| GPT-5.6 era | `gpt-5.6-luna` | `gpt-5.6-sol` |
| `gpt-7-astra` only new | `gpt-6-luna` | `gpt-6.1-sol` |
| GPT-7 Sol/Luna present | `gpt-7-luna` | `gpt-7-sol` |
| snapshots only | `gpt-5-mini-2025-08-07` | `gpt-5-2025-08-07` |
| legacy only | `gpt-4o-mini` | `gpt-4o` |
| junk only / empty | `''` | `''` |

**Legacy** (`isLegacyModel`, meaning "a new key typically cannot use it"): GPT-3.5 and GPT-4 families (4o, 4.1, 4.5),
o1*, o3-mini, o4-mini, `*-chat-latest`, `*codex*`, `*-preview`, the GPT-5.1 family, `gpt-5.4-nano` (deprecated per
the "All models" page), and any id with a `shutdown_date` in the last `listModels()`. GPT-5 / 5.2 / 5.4 / 5.5, o3 and
o3-pro are listed as current, so they are not legacy. Fine-tunes are never legacy (they belong to the user).

## Errors (`aiError` codes)

| Answer | code (fatal) | Note |
|---|---|---|
| no key | `no_key` (✓) | No request is sent. |
| 401 / `invalid_api_key` | `auth` (✓) | Separate messages for IP allow-list and "member of an organization". |
| 403 region (`unsupported_country_region_territory`) | `permission` (✓) | |
| 403 "must be verified to use the model …" | `not_found` (✓) | `err.model` set, so `getProvider()` switches to another model of the key (`models.md`); the message points to Settings → Organization → General. (`permission` when no model was requested.) |
| other 403 | `permission` (✓) | `err.model` is set. |
| 404, or `code: 'model_not_found'` at any status (403 "Project … does not have access to model …", 400) | `not_found` (✓) | `err.model` = requested id. |
| 429 `insufficient_quota` / `credit_balance_exhausted` / 402 | `billing` (✓) | Korean text pointing to platform.openai.com → Settings → Billing; ChatGPT subscriptions ≠ API credit. |
| 429 `organization_spend_limit_exceeded` / `project_spend_limit_exceeded` | `billing` (✓) | "→ Settings → Limits". |
| 429 `organization_usage_limit_exceeded` | `billing` (✓) | Limit-increase hint. |
| 429 other (`rate_limit_exceeded`, `slow_down`) | `rate_limit` | Retried, see below. |
| 400/403/422 `param: 'stream'` / "verified to stream" | — | stream() switches to one non-streaming request (remembered per model). Community reports show this as 400 `unsupported_value`, `param: 'stream'`. |
| 400 `invalid_prompt` | `refusal` | |
| 400 `context_length_exceeded` | `bad_request` | |
| other 400 / 422 / 413 | `bad_request` | The API's message is appended as `상세:`. |
| 5xx (503 `server_is_overloaded` has its own text) | `server` | |
| fetch TypeError | `network`, `auth` or `not_found` | Diagnosed, see CORS. |
| abort | `aborted` (`name: 'AbortError'`) | |
| timeout | `timeout` | |

**Retries:** at most 3 attempts. 5xx waits 1 s, then 2 s. Rate limits wait the time in OpenAI's message ("Please try
again in 1.2s"), because `Retry-After` is not in `Access-Control-Expose-Headers` and so cannot be read cross-origin.
That wait is used only when it is ≤ 20 s; with no hint the waits are 2 s, then 4 s. Billing and quota errors are
never retried ("Retrying billing, spend, or quota errors won't restore API access").

**Timeouts:** `complete()` waits 2–10 min, scaled by `max_output_tokens` (as in claude.js). A stream fails after 5 min
without any byte, because reasoning can be silent before the first delta. A diagnostic probe gets 10 s. Neither
timeout is covered by a test (it would take minutes).

## CORS: the browser may call the API directly (evidence)

`curl -X OPTIONS` with `Origin: https://e2jinsoopark.github.io` and `Access-Control-Request-Headers:
authorization,content-type` (2026-10-18):

- `/v1/responses`, `/v1/models` → `200`, `Access-Control-Allow-Origin: *`,
  `access-control-allow-headers: authorization,content-type` (echoed),
  `access-control-allow-methods: DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT`,
  `access-control-expose-headers: X-Request-ID, CF-Ray`.
- `/v1/chat/completions` → `200`, `Access-Control-Allow-Origin: https://e2jinsoopark.github.io`.
- `GET /v1/models` with no key or a bad key → `401` JSON **with** `Access-Control-Allow-Origin: *`.
- `POST /v1/responses` with no key → `401` JSON with `Access-Control-Allow-Origin: *`.
- **`POST /v1/responses` and `/v1/chat/completions` with a bad key → `401` (`content-type: text/plain`, body is the
  usual JSON) without `Access-Control-Allow-Origin`.** A browser therefore sees only a network error.

Handling: when a POST fails with a fetch TypeError (not aborted, not timed out), `diagnoseFailure()` checks the page
CSP first. If `connect-src` lacks `https://api.openai.com`, the error is the CSP message (the same CSP parser as
relay.js, `isRelayOriginAllowed(url)`). Otherwise it sends one free `GET /v1/models` with the same key. A 401/403
there → `auth`/`permission`. A 200 that does not list the requested model → `not_found` with `err.model`. Anything
else → `network`. Whether other POST errors from a valid key (404/429) carry CORS headers could not be checked
without a key; if they do not, the probe still classifies a missing model and a bad key correctly.

Playwright adds CORS headers to responses it fulfils. A CORS-less 401 could not be reproduced: it was readable in the
test browser, as the first test run showed. The test therefore produces the browser-visible effect directly
(`route.abort('failed')` → TypeError).

## Integration pass (2026-10-18): docs re-check and changes

Re-read against the live reference (`developers.openai.com/api/reference/resources/responses/methods/create.md`,
`…/responses/streaming-events.md`, `…/docs/guides/error-codes.md`, `…/docs/guides/prompt-caching.md`,
`…/docs/models.md`), same day:

| Point | Reference says | Code |
|---|---|---|
| Token cap | `max_output_tokens` — "including visible output tokens and reasoning tokens" | unchanged (reserve on reasoning models) |
| Structured output | `text.format` `{ type: 'json_schema', name, schema, strict, description? }`, name `[a-zA-Z0-9_-]{≤64}` | unchanged (`name: 'answer'`) |
| Streaming usage | `stream_options` has only `include_obfuscation`; `response.completed` carries the Response with `usage` (`input_tokens_details { cached_tokens, cache_write_tokens }`, `output_tokens_details { reasoning_tokens }`) | unchanged (no stream option; obfuscation left on, the default) |
| Stream events | `response.output_text.delta { item_id, output_index, content_index, delta, logprobs, sequence_number }`; `error { code \| null, message, param \| null, sequence_number }`; `response.refusal.delta/done`; output items carry `phase: commentary \| final_answer` | unchanged |
| Image input | `input_image { image_url (URL or data URL), file_id, detail: low \| high \| auto \| original }` | unchanged (`detail: 'high'`) |
| Error JSON | `{ error: { message, type, param, code } }`; billing codes `credit_balance_exhausted`, `*_spend_limit_exceeded`, `organization_usage_limit_exceeded` (type may stay `insufficient_quota`); 429 `slow_down`; 503 `server_is_overloaded` | unchanged |
| Caching | explicit breakpoints GPT-5.6+, ≤ 4 cache writes, `instructions` cannot hold one; before 5.6 a stable `prompt_cache_key` helps routing | **added** `prompt_cache_key` before 5.6 |
| Assistant input `phase` | "preserve and resend phase on all assistant messages" for gpt-5.3-codex and beyond | **added** on GPT-5.3+ |
| Model access needing verification | (community reports; docs only show it for image models) 403 with "must be verified" | **changed** to healable `not_found` |

CORS re-checked with curl (no key / an obviously invalid key): `POST /v1/responses` without a key → 401 with
`Access-Control-Allow-Origin: *`; with an invalid key → 401 `text/plain` **without** it; `GET /v1/models` with an
invalid key → 401 with it. Same as the builder's observation, so the `/v1/models` probe stays.

## Integrator requests

- **CSP:** `index.html connect-src` needs `https://api.openai.com`. The working tree already has it (added by the
  settings/UI work). `tests/shell/run.mjs`' `CSP` constant must match.
- **Prices:** OpenAI usage is not priced in `config.js PRICES`, so it shows as "비용 미집계", like Gemini. To price it,
  use these values from the model pages (USD / 1M tokens, 2026-10-18): `gpt-6-luna` 0.10 in / 0.01 cached / 0.125
  cache write / 0.50 out; `gpt-6.1-sol` 2.00 / 0.10 / 2.50 / 10.00; `gpt-5.6-terra` 2.00 / 0.20 / – / 12.00;
  `gpt-5.6-sol` 4.00 / 0.40 / – / 20.00. Prompts over 272K input tokens cost 2× input and cache rates and 1.5×
  output for the whole request (like Haiku's `long` card, threshold 272 000). Cache writes are billed only on
  GPT-5.6+ (1.25× input); usage already reports `cacheWriteTokens`.
- **Registry:** keep the provider registry inside `getProvider()/rawProvider()` (as it is). `openai.js` imports
  `providers.js` and `relay.js`, so a top-level `{ openai: openaiProvider }` would be read before `openai.js` finished
  evaluating when it is the first module loaded (the tests import it directly).
- `models.js hasModel()` accepts Claude-style 8-digit snapshot suffixes only. `listModels()` hides an OpenAI dated
  snapshot when its alias is listed. A user who picked `gpt-5-mini-2025-08-07` while `gpt-5-mini` exists is therefore
  "unlisted" and goes back to 자동 선택 (the alias), which is the intended outcome.

## Known limitations

- No request was made with a real key: the explicit-cache fields and the streaming-verification 400 shape follow the
  docs and the error format OpenAI uses. Both have a self-correcting fallback. The same holds for `prompt_cache_key`
  and the assistant `phase` field (documented request fields, never sent to the live API from here) and for the
  "must be verified to use the model" 403 (its status and wording come from community reports, not the reference);
  if the real answer differs, it stays a fatal `permission`/`bad_request` error as before, it just is not healed.
- Whether a valid key's 404/429 answers to `POST /v1/responses` carry CORS headers is unknown (only 401 was
  observable without a key). If they do not, a missing model and a bad key are still diagnosed by the `/v1/models`
  probe, but a quota/credit 429 would show as a network error.
- A stream stopped by the user has no usage (OpenAI reports usage only in the final event), so nothing is recorded
  for it. Claude's SDK reports partial usage.
- `Retry-After` / `x-ratelimit-*` headers are not exposed to browsers, so waits come from the error text or backoff.
- `detail: 'high'` is used for figure captures (small text in figures); it costs more image tokens than `auto`.

## How to test

```
node tests/ai/openai.test.mjs     # 17 tests, ~7 s; own server on port 8171
node tests/ai/run-all.mjs         # all AI suites (openai included)
```
Results: `C:/Users/dindoo/Projects/pr-tools/out/ai/openai.results.json` + `openai.log`.
