# Invite-code relay — app client

The app side of [`docs/RELAY.md`](../RELAY.md) §2: colleagues use the reader with an invite code instead of their own
API key. The worker (`relay/`) is documented in `relay/README.md`.

## Pieces

| File | What |
|---|---|
| `js/core/config.js` | `RELAY_DEFAULT_URL` (the deployed worker, `''` until then), `APP_PUBLIC_URL` (invite links), `DEFAULT_MODELS.relay`. |
| `js/core/settings.js` | `relay: { url, code, adminToken, name, allowedModels, translateModel, assistModel }`. `url: ''` means `RELAY_DEFAULT_URL`, so a moved worker reaches everyone who never typed an address. `settings.relayUrl()`; `settings.model(kind)` and `isAiReady()` handle `'relay'`. |
| `js/ai/claude.js` | `makeClaudeProvider({ id, label, auth, missingKeyMessage, describeError })`. `claudeProvider` is one instance (requests unchanged); per-provider client cache and fallback-beta memory. `auth()` may return `baseURL` and `fetch`. |
| `js/ai/relay.js` | `relayProvider` = the Claude provider with `baseURL = settings.relayUrl()`, `apiKey = code`. `fetchMe` / `refreshMe` / `registerInviteCode` / `saveInviteCode` / `saveRelayUrl`, admin client `listCodes` / `createCode` / `updateCode` / `deleteCode` / `usage`, `reportRefusedCode` (→ `relay:code-refused`), `inviteLink` / `inviteMessage`, `normalizeInviteCode` / `isInviteCode`, `isRelayOriginAllowed` (reads the page CSP). |
| `js/ai/providers.js` | Registers `relay`; `export * as relay from './relay.js'`, so `app.js` gets the helpers with the dynamically loaded AI modules (`deps.relay`) — no static import of AI code from the UI. |
| `js/ui/settings-view.js` | AI section: 초대 코드 card first (“키 없이 쓰기 (초대 코드)”): 서버 주소, 초대 코드 (테스트 → “홍길동님 · 오늘 $0.03 / $0.50 · 모델: Haiku 5.5”), model selects limited to the code's models. For an invitee (code saved) the invite card shows the name and today's usage and the own-key cards (Claude · GPT · Gemini) sit under **내 API 키 쓰기**; switching keeps the code, the invite card switches back in one click (`models.md`). 사용량 shows `/relay/me` while the relay is selected. New section **초대 코드 관리 (관리자)** (`#set-invites`, collapsed). (`#/join/<CODE>` is `js/ui/start-view.js` since the first screen, [`onboarding.md`](onboarding.md).) |
| `js/app.js` | Route `#/join/<CODE>`; `deps.relay`; one quiet `/relay/me` per visit for relay users (keeps allowed models current); `forgetRefusedCode` (a deleted / stopped saved code, below). |

## Behaviour

- **Models.** `/relay/me.allowedModels` is remembered in `settings.relay.allowedModels`; `refreshMe()` (every visit,
  테스트) and `registerInviteCode()` pick the models from it with the Claude rule (`relay.autoModels`: newest Haiku for
  translation, newest Sonnet else Haiku for summaries/chat — see `models.md`), so a code that gains or loses Sonnet
  is followed. Unknown (before the first check) → Haiku 5.5. A saved choice the code no longer allows falls back to
  자동 선택. A 403 from the relay re-reads `/relay/me` in the background. Anthropic's 404 "model: …" passed through
  the relay is `not_found` with `err.model` (self-healing retries once on the code's other model); the relay's own
  404s keep the server-address message.
- **Join link** `#/join/<CODE>` (code read like a pasted one: case, spaces, dashes, a whole link or invite message,
  generated codes with Crockford O→0 / I,L→1, chosen codes as spelled — [`onboarding.md`](onboarding.md) §2–3; the rules are one table shared with the Worker's tests, `relay/test/code-vectors.json`):
  the code is checked with `/relay/me` *before* anything is saved; then provider = `relay`, the code, name and models
  are stored, the hash is replaced by `#/` (the code leaves the address bar and history) and the library opens
  (공용 서재 for invitees) — **no welcome screen** since 2026-10-19. The code already saved (same key) → straight to
  the library, no request. Bad code → the first screen with the code and one error line ("코드를 찾을 수 없어요"),
  settings untouched; a code that cannot exist → the same line, no request.
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
  Haiku + Sonnet, optional **코드 직접 정하기**), copy code, copy invite message (`[갈피 초대] ○○님` / the join link /
  `코드: <CODE>`),
  중지 / 다시 사용 (confirm on 중지), 한도·모델 수정 (dialog; validated like the worker: name 1–40, $0–20),
  **삭제** (below), 날짜별 사용량 (30 days). The 키·토큰 지우기 button also clears the invite code and admin token.

## Deleting a code (2026-10-19)

Owner: "초대코드 중지는 있는데 삭제는 없네?". The Worker side is `DELETE /relay/admin/codes/:code` → `{ deleted: true,
purgedFiles }` (the code's `people/<personId>/` files go first, one commit per team library; GitHub unreachable → 502
with a Korean message and the code is kept; see `docs/RELAY.md`). App side:

- **설정 → 초대 코드 관리**: every row ends in **삭제** (danger-coloured ghost button) after 중지 / 다시 사용. One dialog
  (`modal`, not a native one): title `‘<name>’ 코드를 삭제할까요?`, two lines — 이 코드로는 더 이상 들어올 수 없고, 이 코드로
  남긴 하이라이트·메모·AI 기록도 함께 지워집니다. / 공용 서재의 논문·폴더·번역과 사용 비용 기록은 그대로 남습니다. — buttons
  취소 (focused, so Enter never deletes) and **삭제** (danger, "삭제하는 중…" while the request runs). The request runs
  inside the dialog: an error (the Worker's 502 message, a network failure) is a toast and the dialog stays, so 삭제 can
  be pressed again. Success → the row goes, toast **삭제했습니다.**, the list reloads quietly (no loading flash).
  404 (deleted in another tab/device) → the row goes, "이미 삭제된 코드입니다.". 405 (a Worker deployed before deleting
  existed) → "초대 코드 서버가 아직 코드 삭제를 지원하지 않습니다. 서버(Worker)를 새 버전으로 배포한 뒤 다시 시도해 주세요."
- **Totals**: 오늘 전체 / 이번 달 전체 keep deleted codes' usage (the Worker keeps the usage rows). Under the list one
  muted dashed row **삭제된 코드 · 이번 달 $x.xx**, only when > 0. `relay.listCodes()` returns `deletedMonthUsd` /
  `deletedTodayUsd`: the Worker's `deletedUsage.monthUsd` / `.todayUsd` when it sends them, else what the totals hold
  beyond the listed codes (≥ $0.005).
- `relay.deleteCode(code)` (90 s timeout: GitHub commits). CORS: the Worker's preflight must list `DELETE` in
  `Access-Control-Allow-Methods` (the fake does).

**A device whose saved code was deleted (or stopped)** — the relay answers its code with 401 "초대 코드가 올바르지
않거나…" on `/relay/me`, `/shared`, `/shared/<lib>/activity`, the 공용 서재 proxy (sync status error with that message) or
`/v1/messages`:
- `relay.reportRefusedCode(code)` emits `relay:code-refused` only for the **saved** code and only if it **worked here
  before** (its name / allowed models came from the relay). A code being tried — first screen, join link, a code just
  typed in 설정 (`saveInviteCode` forgets name and models) — only shows its error where it was typed.
- `js/app.js forgetRefusedCode`: clears `relay.code / name / allowedModels / model choices` and the remembered
  `GET /shared` list, so nothing asks with that code again (no loop: tested — 1–2 requests in total, none after); 공용
  서재 closes and leaves the sidebar. Then:
  - nothing else set up (`needsGate`: no own key, no GitHub library, nothing in 내 서재) → `#/` → the **first screen with
    one line** in the error line's place, not red (`.start-error.is-notice`, `--warning`), no `aria-invalid`, gone on
    typing: **초대 코드가 더 이상 쓰이지 않아요. 새 코드를 넣어 주세요.** In 설정 at that moment: a toast now, the line on
    the way out.
  - own API key / GitHub library / papers in 내 서재 → a **toast** with the same words; the own setup stays (provider
    `relay` → the first own key's provider), a 공용 서재 address → `#/`.
  - 설정 redraws its AI cards and usage (`relay:code-cleared`).
- The forgotten code's key goes to `localStorage 'pr.relay.refused.v1'` (last 20; removed again when that code is
  accepted later; wiped with the other `pr.*` keys). In an **installed / home-screen app** (`isStandalone()`) a
  `#/join/<that code>` link — an iPhone home-screen app starts at it on every launch — sends nothing for it: the first
  screen with the line (nothing else set up) or straight to the library (a new code / own key). **In a browser tab** a
  join link is opened on purpose, so it is tried once (decided at integration): a stopped code switched on again, or a
  chosen code the owner made again with the same letters, works from the old invite link; a dead one gets the ordinary
  "코드를 찾을 수 없어요" line. Typing or pasting a code on the first screen always tries it.
- Note: the Worker answers a **stopped** code with the same 401 as a deleted one (no oracle), so 중지 now also makes
  the colleague's device forget the code; after 다시 사용 they open the invite link or paste the code once more. The 중지
  question says so: "…중지하면 이 코드로는 바로 번역·요약·채팅·공용 서재를 쓸 수 없고, 쓰던 기기에서도 코드가 빠집니다.
  ‘다시 사용’으로 되돌리면 초대 링크나 코드를 한 번 더 넣으면 됩니다."
- A device that asks in the second or so while a deletion runs (the Worker switches the code off first) also forgets
  it; if that deletion then fails (502, the code is switched back on), that colleague opens the invite link again.

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
node tests/relay-client/run.mjs           # PR_TEST_PORT=8231 to serve on another port
node tests/onboarding/code-delete.mjs     # 초대 코드 삭제: admin 삭제 + dialog + 502/405/404 + 삭제된 코드 row; a device whose
                                          # code was deleted (first screen line, toast with an own key, proxy 401 mid-session,
                                          # iPhone home-screen relaunch at the dead join link); port 8231;
                                          # screenshots C:/Users/dindoo/Projects/pr-tools/out/code-delete/app/
node tests/code-delete/run.mjs            # the same with the REAL Worker + fake GitHub (ports 8232–8234 + 8787):
                                          # docs/notes/relay.md › Deleting a code
```

Edge via Playwright 1.63; `python -m http.server 8150` if nothing listens. The real app and the real Anthropic SDK
(jsDelivr) talk to `tests/relay-client/fake-relay.mjs`, a contract-faithful fake (CORS echo + restricted expose list,
Anthropic-shaped Korean errors, `x-should-retry: false`, JSON + SSE, admin API) reached by route interception of
`https://relay.test`. `index.html` is answered with a test copy whose `connect-src` adds `https://relay.test`; every
other external request is aborted and fails the test (the SDK bundle passes, the font stylesheet is stubbed).
Covered: strict production CSP, helpers, request shape (x-api-key = code, beta stream), error mapping and no 429
retry, translator stop on 429, settings card + usage panel, join link → library / error / retry / malformed, admin flows,
reader toast on the daily limit. Results and screenshots: `C:/Users/dindoo/Projects/pr-tools/out/relay-client/`.
