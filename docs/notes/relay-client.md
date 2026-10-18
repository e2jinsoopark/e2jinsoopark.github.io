# Invite-code relay — app client

The app side of [`docs/RELAY.md`](../RELAY.md) §2: colleagues use the reader with an invite code instead of their own
API key. The worker (`relay/`) is documented in `relay/README.md`.

## Pieces

| File | What |
|---|---|
| `js/core/config.js` | `RELAY_DEFAULT_URL` (the deployed worker, `''` until then), `APP_PUBLIC_URL` (invite links), `DEFAULT_MODELS.relay`. |
| `js/core/settings.js` | `relay: { url, code, adminToken, name, allowedModels, translateModel, assistModel }`. `url: ''` means `RELAY_DEFAULT_URL`, so a moved worker reaches everyone who never typed an address. `settings.relayUrl()`; `settings.model(kind)` and `isAiReady()` handle `'relay'`. |
| `js/ai/claude.js` | `makeClaudeProvider({ id, label, auth, missingKeyMessage, describeError })`. `claudeProvider` is one instance (requests unchanged); per-provider client cache and fallback-beta memory. `auth()` may return `baseURL` and `fetch`. |
| `js/ai/relay.js` | `relayProvider` = the Claude provider with `baseURL = settings.relayUrl()`, `apiKey = code`. `fetchMe` / `refreshMe` / `registerInviteCode` / `saveInviteCode` / `saveRelayUrl`, admin client `listCodes` / `createCode` / `updateCode` / `usage`, `inviteLink` / `inviteMessage`, `normalizeInviteCode` / `isInviteCode`, `isRelayOriginAllowed` (reads the page CSP). |
| `js/ai/providers.js` | Registers `relay`; `export * as relay from './relay.js'`, so `app.js` gets the helpers with the dynamically loaded AI modules (`deps.relay`) — no static import of AI code from the UI. |
| `js/ui/settings-view.js` | AI section: 초대 코드 card first (“키 없이 쓰기 (초대 코드)”): 서버 주소, 초대 코드 (테스트 → “홍길동님 · 오늘 $0.03 / $0.50 · 모델: Haiku 5.5”), model selects limited to the code's models. For an invitee (code saved) the invite card shows the name and today's usage and the own-key cards (Claude · GPT · Gemini) sit under **내 API 키 쓰기**; switching keeps the code, the invite card switches back in one click (`models.md`). 사용량 shows `/relay/me` while the relay is selected. New section **초대 코드 관리 (관리자)** (`#set-invites`, collapsed). `mountJoinView` for `#/join/<CODE>`. |
| `js/app.js` | Route `#/join/<CODE>`; `deps.relay`; one quiet `/relay/me` per visit for relay users (keeps allowed models current). |

## Behaviour

- **Models.** `/relay/me.allowedModels` is remembered in `settings.relay.allowedModels`; `refreshMe()` (every visit,
  테스트) and `registerInviteCode()` pick the models from it with the Claude rule (`relay.autoModels`: newest Haiku for
  translation, newest Sonnet else Haiku for summaries/chat — see `models.md`), so a code that gains or loses Sonnet
  is followed. Unknown (before the first check) → Haiku 5.5. A saved choice the code no longer allows falls back to
  자동 선택. A 403 from the relay re-reads `/relay/me` in the background. Anthropic's 404 "model: …" passed through
  the relay is `not_found` with `err.model` (self-healing retries once on the code's other model); the relay's own
  404s keep the server-address message.
- **Join link** `#/join/<CODE>` (code normalized: case, spaces, dashes, a pasted whole link, Crockford O→0 / I,L→1):
  the code is checked with `/relay/me` *before* anything is saved; then provider = `relay`, the code, name and models
  are stored, the hash is replaced by `#/` (the code leaves the address bar and history) and a welcome screen
  names the person. Bad code → error screen with 다시 시도 / 코드 직접 입력 / 라이브러리로, settings untouched.
  Malformed code → format error, no request.
- **Errors.** The relay's own answers have Korean messages and are shown as they are: 401 → `auth` (fatal),
  403 → `permission` (fatal), 429 → `quota` (stops a translation run once, like Gemini's daily quota; “내일 다시” is
  added if the message lacks it). A 403 that names the requested model (“이 초대 코드로는 <model>을 쓸 수
  없습니다.” — the owner removed it while this tab still asks for it) is `not_found` with `err.model` instead (still
  fatal, same message), so `getProvider()` switches to an allowed model and retries once (`models.md`). Answers passed through from Anthropic about the *owner's* key or credit → “초대해
  준 분에게 알려 주세요” (`server`, fatal). Connection failures say whether the page CSP blocked the address.
- **No retries on a relay refusal.** The SDK honours `x-should-retry: false`, but a cross-origin response hides
  headers that are not in `Access-Control-Expose-Headers`. The Worker in `relay/` exposes `x-should-retry` (verified
  by `tests/relay-e2e`); the relay provider also passes the SDK a `fetch` that marks a 429 with a Korean error
  message as `x-should-retry: false` (Anthropic's own English 429s stay retryable), so a Worker exposing only the
  contract's minimum (`request-id, x-relay-*`, as `fake-relay.mjs` does) is not retried either.
- **Admin.** The token field is a password field; the token is checked with `GET /relay/admin/codes` before it is
  saved, the input is cleared, and afterwards only “관리자 토큰 저장됨 · 지우기” is shown. Nothing is requested
  until the panel is opened. List (today / this month / total per code, totals), create (이름, 하루 한도, Haiku만 /
  Haiku + Sonnet), copy code, copy invite message (3 lines with `https://e2jinsoopark.github.io/#/join/<CODE>`),
  중지 / 다시 사용 (confirm on 중지), 한도·모델 수정 (dialog; validated like the worker: name 1–40, $0–20),
  날짜별 사용량 (30 days). The 키·토큰 지우기 button also clears the invite code and admin token.

## CSP and deploying the worker

`index.html`'s CSP is a static `<meta>`; a page cannot widen it at runtime. While `RELAY_DEFAULT_URL` is `''`
nothing is added (production CSP unchanged). The full deploy checklist (Worker and app) is in
[`relay.md`](relay.md#deploy-checklist). When the worker is deployed:

1. `js/core/config.js`: `export const RELAY_DEFAULT_URL = 'https://<worker>.<account>.workers.dev';`
2. `index.html`: append the same origin to `connect-src` (after `https://api.semanticscholar.org`).
3. `tests/shell/run.mjs`: the `CSP` constant holds the exact meta string — append the origin there too.
4. Worker vars: `ALLOWED_ORIGINS` must contain `https://e2jinsoopark.github.io`.
5. `node tests/relay-client/run.mjs` — its first test fails while config and `index.html` disagree (missing origin
   or any extra entry).

Another server address typed in 설정 is blocked by the browser unless it is in `connect-src`; 설정 says so under
서버 주소 (`isRelayOriginAllowed`). Local worker testing (`wrangler dev` on `127.0.0.1:8787`) therefore uses a staged
test copy of the site (`tests/relay-e2e/test-site.mjs`, see [`relay.md`](relay.md#test-hook-the-local-worker-without-a-looser-csp)),
never a looser production CSP.

## Tests

```
node tests/relay-client/run.mjs
```

Edge via Playwright 1.63; `python -m http.server 8150` if nothing listens. The real app and the real Anthropic SDK
(jsDelivr) talk to `tests/relay-client/fake-relay.mjs`, a contract-faithful fake (CORS echo + restricted expose list,
Anthropic-shaped Korean errors, `x-should-retry: false`, JSON + SSE, admin API) reached by route interception of
`https://relay.test`. `index.html` is answered with a test copy whose `connect-src` adds `https://relay.test`; every
other external request is aborted and fails the test (the SDK bundle passes, the font stylesheet is stubbed).
Covered: strict production CSP, helpers, request shape (x-api-key = code, beta stream), error mapping and no 429
retry, translator stop on 429, settings card + usage panel, join welcome / error / retry / malformed, admin flows,
reader toast on the daily limit. Results and screenshots: `C:/Users/dindoo/Projects/pr-tools/out/relay-client/`.
