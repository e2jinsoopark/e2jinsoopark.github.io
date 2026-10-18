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
- `POST /relay/admin/codes` `{ name, allowedModels?, dailyLimitUsd? }` → `{ code, ... }`. Code format: `PR-XXXX-XXXX`
  (Crockford base32, crypto-random, no ambiguous chars). Defaults from `DEFAULT_MODELS` / `DEFAULT_DAILY_LIMIT_USD`.
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
  the library. Invalid code → clear Korean error and a way to retry.
- **초대 코드 관리 (관리자)** section in settings (collapsed; visible always, usable only with an admin token): list codes
  with today/month usage, totals; create (name, daily limit $, models: "Haiku만" / "Haiku + Sonnet"); copy code; copy
  invite message (Korean text with the join link `https://e2jinsoopark.github.io/#/join/<CODE>` and one-line instructions);
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
