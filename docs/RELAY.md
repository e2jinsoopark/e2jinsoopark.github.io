# Invite-code relay ("초대 코드 서버") — contract

Goal: colleagues of the owner use the paper reader **without their own API key**. They paste an invite code
(or open an invite link); the app sends Claude requests to a small **Cloudflare Worker** that holds the
owner's Anthropic API key as a secret, checks the code, enforces limits, forwards to Anthropic and records
usage. The owner manages codes from the app's settings (admin token).

Two parts, built in parallel:

| Part | Files | Owner |
|---|---|---|
| Worker | `relay/` (src/index.js, schema.sql, wrangler.jsonc, README.md, tests) | relay builder |
| App client | `js/ai/claude.js`, `js/ai/providers.js`, `js/ai/relay.js` (new), `js/ui/settings-view.js`, `js/app.js` (join route), `js/core/config.js` (`RELAY_DEFAULT_URL`), `index.html` (CSP), `css/app.css`, tests | app builder |

`relay/` is NOT published to GitHub Pages (the Pages workflow copies only index.html, css, js, vendor).

## 1. Worker HTTP API

Base URL: `https://<worker>.<account>.workers.dev` (unknown until deploy; local dev: `http://127.0.0.1:8787`).
All JSON. Error bodies use **Anthropic's error shape** so the Anthropic SDK maps them to its typed errors:
`{ "type": "error", "error": { "type": "<type>", "message": "<Korean, user-presentable>" } }`.
Quota/denial responses set `x-should-retry: false` (the Anthropic SDK honours it, so no wasted retries).

### Auth
- Invite code: header `x-api-key: <code>` (this is what the Anthropic SDK sends as `apiKey`), or `Authorization: Bearer <code>`.
- Admin: `Authorization: Bearer <ADMIN_TOKEN>` on `/relay/admin/*` only. Compare in constant time.
- Unknown/disabled code → 401 `authentication_error` ("초대 코드가 올바르지 않거나 사용이 중지되었습니다.").

### CORS
- `Access-Control-Allow-Origin`: echo the request `Origin` only if it is in `ALLOWED_ORIGINS` (comma list; entries may be
  exact origins or `http://localhost:*` / `http://127.0.0.1:*` patterns). Otherwise no CORS headers (browser blocks;
  as built: 403 `permission_error` without CORS headers, nothing forwarded).
- Preflight `OPTIONS`: 204, `Access-Control-Allow-Methods: GET, POST, PATCH, OPTIONS`,
  `Access-Control-Allow-Headers`: echo `Access-Control-Request-Headers` (the SDK sends x-stainless-* headers,
  anthropic-version, anthropic-beta, anthropic-dangerous-direct-browser-access, x-api-key, content-type),
  `Access-Control-Max-Age: 86400`, `Vary: Origin`.
- Expose: `request-id, x-relay-today-usd, x-relay-limit-usd, x-should-retry, retry-after, retry-after-ms` (as built:
  the retry headers are exposed so the browser SDK sees `x-should-retry: false` and does not retry a budget 429).

### `POST /v1/messages` (also with `?beta=true`, which the SDK uses for `client.beta.messages.*`)
1. Validate code; body ≤ 6 MB; JSON with `model`, `max_tokens`, `messages`.
2. `model` must be in the code's `allowed_models` → else 403 `permission_error` ("이 초대 코드로는 <model>을 쓸 수 없습니다.").
3. `max_tokens` ≤ `MAX_TOKENS_CAP` (default 32000) → else 400 `invalid_request_error`.
4. Budget check: today's USD for this code < `daily_limit_usd`, and today's total for all codes < `GLOBAL_DAILY_LIMIT_USD`
   → else 429 `rate_limit_error` with Korean message ("오늘 사용 한도($0.50)를 모두 썼습니다. 내일 오전 0시(한국 시간)에 다시 열립니다.")
   plus `x-should-retry: false`. "Today" is the **Asia/Seoul calendar day**.
5. Forward to `${UPSTREAM_URL}/v1/messages` (+ original query string) with headers: `x-api-key: env.ANTHROPIC_API_KEY`,
   `anthropic-version` (from client, default `2023-06-01`), `anthropic-beta` (from client, if present), `content-type`.
   Never forward the invite code, cookies, or `anthropic-dangerous-direct-browser-access`.
6. Return the upstream status, body and relevant headers unchanged (streaming SSE passes through without buffering).
7. Record usage after the response finishes (`ctx.waitUntil`): non-stream → parse JSON `usage`; stream → parse SSE
   `message_start.message.usage` + final `message_delta.usage`; also count `usage.iterations`/fallback parts if present.
   Cost via the price table (same as `js/core/config.js PRICES`; unknown models priced as Sonnet 5.5). Failed upstream
   calls (4xx/5xx) record a request but no tokens.

### `GET /v1/models`
Returns `{ data: [{ type: 'model', id, display_name, created_at }], has_more: false, first_id, last_id }` for the code's
allowed models only (the app's Claude "test key" and model list use this).

### `GET /relay/me`
`{ name, allowedModels: string[], dailyLimitUsd, todayUsd, todayRequests, resetsAt /* ISO, next 00:00 KST */ }`.

### Admin
- `GET /relay/admin/codes` → `{ codes: [{ code, name, active, allowedModels, dailyLimitUsd, createdAt, lastUsedAt,
  todayUsd, monthUsd /* KST calendar month */, totalUsd, totalRequests }], todayTotalUsd, monthTotalUsd, globalDailyLimitUsd }`
- `POST /relay/admin/codes` `{ name, code?, allowedModels?, dailyLimitUsd? }` → `{ code, ... }`. Code format: `PR-XXXX-XXXX`
  (Crockford base32, crypto-random, no ambiguous chars), or the owner's own `code` (custom code, §4).
  Defaults from `DEFAULT_MODELS` / `DEFAULT_DAILY_LIMIT_USD`.
- `PATCH /relay/admin/codes/:code` `{ name?, active?, allowedModels?, dailyLimitUsd? }` → updated record.
- `GET /relay/admin/usage?days=30` → `{ days: [{ day, usd, requests, byModel: {...} }] }`.
- Validation: name 1–40 chars; dailyLimitUsd 0–20; allowedModels ⊆ `KNOWN_MODELS`
  (`claude-haiku-5-5`, `claude-sonnet-5-5`, `claude-opus-5-5`).
- Admin bodies must be valid UTF-8 (strict decode; a CP949 body from a Korean Windows console → 400
  `invalid_request_error` with a Korean hint), and a name containing U+FFFD, a lone surrogate or a control
  character → 400 (create and patch). A name that was stored broken before is repaired by a `PATCH` with a new name.

### Config (wrangler)
Secrets: `ANTHROPIC_API_KEY`, `ADMIN_TOKEN`.
Vars: `ALLOWED_ORIGINS` ("https://e2jinsoopark.github.io,http://localhost:*,http://127.0.0.1:*"),
`UPSTREAM_URL` ("https://api.anthropic.com"; tests point it at a fake), `DEFAULT_MODELS` ("claude-haiku-5-5"),
`DEFAULT_DAILY_LIMIT_USD` ("0.5"), `GLOBAL_DAILY_LIMIT_USD` ("5"), `MAX_TOKENS_CAP` ("32000").
Binding: D1 `DB`. Schema in `relay/schema.sql`:
```sql
CREATE TABLE IF NOT EXISTS codes (code TEXT PRIMARY KEY, name TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1,
  allowed_models TEXT NOT NULL, daily_limit_usd REAL NOT NULL, created_at INTEGER NOT NULL, last_used_at INTEGER);
CREATE TABLE IF NOT EXISTS usage (code TEXT NOT NULL, day TEXT NOT NULL, model TEXT NOT NULL,
  requests INTEGER NOT NULL DEFAULT 0, input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0, cache_write_tokens INTEGER NOT NULL DEFAULT 0, usd REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (code, day, model));
```
Free-plan friendly: one D1 read for code+budget per request, one upsert per finished request.

## 2. App client

- New provider id **`relay`** ("초대 코드"). Settings: `relay: { url, code, adminToken }` (url defaults to
  `RELAY_DEFAULT_URL` from config; adminToken only on the owner's devices).
- `js/ai/claude.js` accepts an optional `baseURL`; the relay provider = the Claude provider with
  `baseURL = settings.relay.url`, `apiKey = settings.relay.code`. Same request shapes, streaming, errors.
- Models for relay: from `GET /relay/me` `allowedModels`; translate model defaults to Haiku 5.5; assist model defaults to
  Sonnet 5.5 if allowed, else Haiku 5.5. `settings.model(kind)` must work for `relay`.
- Settings → AI: a third card **초대 코드** (shown first, labelled "키 없이 쓰기"): 서버 주소 (prefilled), 초대 코드, 테스트 →
  "홍길동님 · 오늘 $0.03 / $0.50 · 모델: Haiku 5.5". Usage panel shows relay usage from `/relay/me` (not local estimates).
- **Join link**: `#/join/<CODE>` (fragment, never sent to a server) → sets provider `relay` + code, calls `/relay/me`,
  shows a Korean welcome ("○○님, 초대 코드가 등록되었습니다. 이제 키 없이 번역·요약·채팅을 쓸 수 있습니다."), then goes to
  the library. Invalid code → clear Korean error and a way to retry. *(Superseded 2026-10-19: no welcome screen — the join
  link and the first screen go straight to the library; `docs/notes/onboarding.md`.)*
- **초대 코드 관리 (관리자)** section in settings (collapsed; visible always, usable only with an admin token): list codes
  with today/month usage, totals; create (name, daily limit $, models: "Haiku만" / "Haiku + Sonnet"); copy code; copy
  invite message (Korean text with the join link `https://e2jinsoopark.github.io/#/join/<CODE>` and one-line instructions;
  since 2026-10-19 exactly `[갈피 초대] ○○님` / the link / `코드: <CODE>`);
  disable/enable; edit limit. Never show the admin token after saving (password field + 지우기).
- Errors from the relay (401/403/429 with Korean messages) are shown as-is; a 429 quota stops a translation run once
  (fatal for the run, like Gemini's daily quota) with "내일 다시" guidance — no failed-sentence spam.
- CSP `connect-src` gets the relay origin (`RELAY_DEFAULT_URL`'s origin) only — never loopback addresses. Decided at
  integration: tests against a local Worker stage a copy of the published files with the two deploy edits and serve
  it from a local server (`tests/relay-e2e/test-site.mjs`); see `docs/notes/relay.md` (test hook, deploy checklist).

## 3. As built (integration, 2026-10-18)

Additions and precisions on top of §1–§2, verified end to end with the real Worker (`tests/relay-e2e/run.mjs`):
- Refused with 403 `permission_error` because they are billed beyond tokens or could pick other models: server tools
  (`tools` entries with a `type` other than `custom`), `mcp_servers`, `container`, `speed` ≠ `standard`, a `fallbacks`
  list (`fallbacks: "default"` is allowed and each fallback attempt is priced at its own model's rates).
- No code at all → 401 `authentication_error` "초대 코드가 없습니다. 설정에서 초대 코드를 입력해 주세요."
- `POST /relay/admin/codes` → 201. `createdAt` / `lastUsedAt` are ISO strings (`lastUsedAt` null until first use).
  `GET /relay/admin/usage` lists every KST day of the window newest first (zero days included), `byModel` values are
  `{ usd, requests, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens }`, optional `&code=PR-…` filter.
- `GET /` → `{ service: 'paper-relay', ok: true }` (deploy check). `/v1/models` also takes `limit`, `after_id`, `before_id`.
- Admin is refused (401) while `ADMIN_TOKEN` is shorter than 16 characters. `TEST_MODE=1` (tests only) lets the
  `x-relay-test-now` header move the clock — never set in production.
- App: the 초대 코드 관리 section is `#set-invites` (deep link `#/settings/invites`), separate from the AI section.

## 4. Custom codes and the failed-attempt limiter (2026-10-19)

**Two kinds of code** (`relay/src/codes.js`):

| | generated | custom |
|---|---|---|
| made by | `POST /relay/admin/codes` without `code` (or `""`, spaces, `null`) | `POST … { "code": "eicu-2026" }` |
| shape | `PR-XXXX-XXXX`, Crockford base32, 40 random bits | 6–24 characters of A–Z, 0–9 and single hyphens |
| stored as | `PR-XXXX-XXXX` | upper case with the owner's hyphens: `EICU-2026` (NFKC first, so full-width input works; spaces and dash look-alikes → one hyphen; leading/trailing hyphens dropped) |
| typed I / L / O | read as 1 / 1 / 0 | never replaced (an O stays an O) |

- **Matching** (both kinds): by the key = letters and digits only, case-insensitive, NFKC-folded, hyphens / spaces / dash
  look-alikes ignored. `eicu 2026`, `EICU2026` and `Eicu-2026` all open `EICU-2026`. Header values must be Latin-1
  (fetch refuses others), so clients send the folded form; path segments and `?code=` may be full-width.
- **Reserved shape**: anything that is `PR` + 8 letters/digits once spaces and hyphens are dropped is a generated code
  (looked up with the O/I/L reading) and is refused as a custom code — so the O/I/L reading never touches a custom code.
- **Create errors** (400 `invalid_request_error`, Korean): characters other than A–Z/0–9/hyphen/space, length, the
  generated shape, a reserved word (`RESERVED_CODES`, compared without hyphens: ADMIN…, TEST, PASSWORD, TEAM, GALPI, …),
  too easy (one repeated character, or a piece of 0123456789 / A–Z / QWERTY rows, forwards or backwards).
  Same key as an existing code, in any case or hyphenation → **409** `invalid_request_error` "이미 있는 코드입니다…"
  (unique index `codes_by_key` on `replace(code, '-', '')`). `PATCH` with `code` → 400: a code cannot be renamed.
- Admin `PATCH /relay/admin/codes/:code` and `GET /relay/admin/usage?code=` accept any spelling of either kind.
- **personId** = first 16 hex chars of HMAC-SHA-256(`PERSON_ID_SECRET`, stored code) (plain SHA-256 without the secret):
  unchanged for generated codes; for a custom code keyed on its stored form, so every spelling — and everyone sharing
  a group code — is one person in 공용 서재 (shared notes) and shares one daily limit.

**Failed-attempt limiter** (`relay/src/limiter.js`, `relay/src/auth.js`):

- Caller = `CF-Connecting-IP` (an IPv6 address counts as its /64; IPv4-mapped IPv6 as the IPv4). Two buckets per caller:
  invite codes (every endpoint that takes one: `/v1/messages`, `/v1/models`, `/relay/me`, `/shared`,
  `/shared/<lib>/activity`, `/shared/<lib>/gh/*` — one shared counter) **20** failures, admin token **10** failures.
  Fixed window of **10 minutes** from the first failure.
- Counted: a presented code that matches no code (malformed ones included); a wrong admin token. Not counted: nothing
  presented; a code that exists but is disabled (still 401 — a stopped colleague's old device keeps polling and must
  not lock out the hospital network); the same wrong value as the previous failure (a stuck client). Successes never
  count and never reset the counter.
- Bucket full → **429** `rate_limit_error` "시도가 너무 많습니다. 잠시 후 다시 시도해 주세요." with `x-should-retry: false` and
  `retry-after: <seconds until the window ends>`; the GitHub proxy answers the same in GitHub's shape
  (`{ message, documentation_url }`). Budget 429s never carry `retry-after` — that is how a client tells
  "wait a few minutes" from "tomorrow". Nothing is forwarded upstream or to GitHub.
- While the bucket is full, an existing active **generated** code keeps working (guessing 40 random bits is hopeless, so
  colleagues behind the same NAT are not locked out); a **custom** code is refused like a guess (otherwise 200-vs-429
  would reveal which word is a code). Admin: even the right token is refused until the window ends.
- Atomic: the failure count and the code lookup are one D1 batch (one transaction, D1 runs one at a time), so a burst
  of parallel guesses gets exactly 20 answers (tested with 60 parallel requests). A successful lookup writes nothing;
  one D1 round trip per request as before.
- Storage: D1 table `auth_failures` (`schema.sql`). **Deploy order: run `schema.sql` on the remote database first, then
  `wrangler deploy`** — the new Worker's lookup query needs the table (without it every code request is a 500).
- Tests: `node relay/test/run.mjs codes` (wrangler dev passes a client-sent `CF-Connecting-IP` through — checked with
  wrangler 4.145 — and the clock is moved with `x-relay-test-now` under `TEST_MODE=1`); unit tests in
  `relay/test/codes-unit.test.mjs`.
- App note: `js/ai/relay.js` adds "내일 다시" only to a 429 whose message mentions 한도 and not "잠시 후", so keep the
  limiter's message containing "잠시 후" (or tell 429s apart by `retry-after`, which CORS exposes).
