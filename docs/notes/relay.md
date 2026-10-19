# Invite-code relay — integration notes

Colleagues use the reader **without their own API key**: they open an invite link (or paste a code), and the app
sends its Claude requests to the owner's Cloudflare Worker, which checks the code, enforces daily budgets, forwards
to Anthropic with the owner's key and records usage. Contract: [`docs/RELAY.md`](../RELAY.md). Worker details and
deploy commands: [`relay/README.md`](../../relay/README.md). App-side details: [`relay-client.md`](relay-client.md).

## Architecture

```
 colleague's browser (app on https://e2jinsoopark.github.io)
   │  settings.relay.code = PR-XXXX-XXXX (localStorage; arrived via #/join/<CODE>, a fragment no server sees)
   │
   │  x-api-key: PR-XXXX-XXXX  (Anthropic SDK with baseURL = RELAY_DEFAULT_URL; or plain fetch for /relay/*)
   ▼
 Cloudflare Worker "paper-relay"  (relay/src/index.js)
   │  CORS: echo Origin only if in ALLOWED_ORIGINS
   │  code → D1 (one read: the code + today's spend for it and for all codes, Asia/Seoul day)
   │  model allowlist · max_tokens cap · 6 MB body · billed-extra features refused · budgets → 401/403/400/413/429
   │
   │  x-api-key: ANTHROPIC_API_KEY (Worker secret), anthropic-version, anthropic-beta, content-type — nothing else
   ▼
 api.anthropic.com/v1/messages[?beta=true]
   │  JSON or SSE, passed back unchanged and unbuffered (TransformStream); usage read on the way through
   ▼
 D1 usage upsert after the reply has finished (ctx.waitUntil), priced with relay/src/pricing.js (= js/core/config.js PRICES)
```

| Endpoint | Who | What |
|---|---|---|
| `POST /v1/messages` (`?beta=true`) | code | Anthropic Messages API, forwarded |
| `GET /v1/models` | code | the code's allowed models |
| `GET /relay/me` | code | name, allowed models, today's spend / limit, reset time — 설정 → 초대 코드 card, 사용량, join screen |
| `/relay/admin/codes`, `/relay/admin/codes/:code` (`PATCH`, `DELETE`), `/relay/admin/usage` | admin token | 설정 → 초대 코드 관리 (관리자): make, stop, edit, delete codes |

App side: `js/ai/relay.js` (provider = `makeClaudeProvider` from `js/ai/claude.js` with the Worker as `baseURL` and
the code as `apiKey`; `/relay/me`; admin client; invite links), `js/core/settings.js` (`relay` settings,
`relayUrl()`, models per code), `js/ui/settings-view.js` (초대 코드 card, 사용량, 초대 코드 관리, `#/join/<CODE>`
screen), `js/app.js` (join route, one quiet `/relay/me` per visit). Translation defaults to Haiku 5.5; 요약·채팅 to
Sonnet 5.5 when the code allows it, else Haiku 5.5 (`DEFAULT_MODELS.relay` in `js/core/config.js`).

## Decisions made at integration

The two halves were built in parallel from RELAY.md and checked against each other with the real Worker
(`tests/relay-e2e`). No request/response shape needed changing. Settled points:

- **Retry hint.** The Worker exposes `x-should-retry`, `retry-after`, `retry-after-ms` in addition to the contract's
  `request-id, x-relay-today-usd, x-relay-limit-usd`, so the SDK sees `x-should-retry: false` on a budget 429 and
  sends the request once. The client's fetch wrapper that marks Korean 429s as not retryable stays as a safeguard
  (it changes nothing when the header is visible); the end-to-end test shows each refused request body sent once.
- **Unlisted origin.** 403 without CORS headers: the browser reports a network error, which the app shows as
  "초대 코드 서버에 연결할 수 없습니다…". `ALLOWED_ORIGINS` must therefore contain the app's origin.
- **Refused features** (403): server tools, `mcp_servers`, `container`, `speed` other than standard, explicit
  `fallbacks` lists — billed beyond tokens or able to pick models outside the allowlist. The app uses none of them
  (only `fallbacks: 'default'` on Sonnet/Opus, which passes).
- **Admin API shapes** the client relies on: create answers 201 with the full record; `createdAt`/`lastUsedAt` are
  ISO strings; the usage report lists every day newest first, zero days included (the UI shows only days with use).
- **Wording.** Onboarding step 1, the reader's "AI 연결이 필요합니다" dialog and `AI_NOT_READY_MESSAGE` mention the
  invite code next to API keys.

## Test hook: the local Worker without a looser CSP

`index.html`'s CSP is a static `<meta>`; `connect-src` lists only the production hosts, so a page from the repo cannot
reach `wrangler dev` on `127.0.0.1:8787`, and production must not list loopback addresses. The end-to-end test
therefore builds a **staged copy of the site** (`tests/relay-e2e/test-site.mjs`):

1. copy exactly what `.github/workflows/pages.yml` publishes (its `cp -r index.html css js vendor _site/` line is
   read from the workflow) into `C:/Users/dindoo/Projects/pr-tools/out/relay-e2e/site`;
2. apply the two deploy edits to the copy: the Worker origin appended to `connect-src` in `index.html`, and
   `RELAY_DEFAULT_URL` in `js/core/config.js` set to the Worker URL (each must match exactly once, or staging fails);
3. serve the copy with `python -m http.server 8160`.

The repo files are never modified, and the test doubles as a check that those two edits are all a deployment needs.
Why not Playwright route interception for `index.html` (as `tests/relay-client` does): a document answered by
`route.fulfill` has no network address, and Chromium's Local Network Access check then refuses its requests to
`127.0.0.1` ("Permission was denied for this request to access the `loopback` address space"). `tests/relay-client`
is unaffected because its relay (`https://relay.test`) is route-intercepted too.

## Tests

| Command | Ports | What |
|---|---|---|
| `node relay/test/run.mjs` | 8787, 8788, 8789 | Worker: unit (prices = app prices, KST calendar, codes, SSE meter), HTTP against `wrangler dev` with a fake upstream and `TEST_MODE=1` clock, real SDK in Edge |
| `node tests/relay-client/run.mjs` | 8150 | App against a contract fake reached by route interception of `https://relay.test` |
| `node tests/relay-e2e/run.mjs [--headed]` | 8160, 8787, 8788 | Real app + real Worker (`wrangler dev`, fresh local D1) + fake Anthropic (`tests/relay-e2e/fake-anthropic.mjs`) |
| `node tests/onboarding/worker-e2e.mjs [--headed]` | 8222–8224, 8787 | First screen, custom codes, 홈 화면에 추가 and the failed-attempt limiter with the real Worker, Edge + WebKit (iPhone 15) ([`onboarding.md`](onboarding.md)) |
| `node tests/code-delete/run.mjs [--headed]` | 8232–8234, 8787 | 초대 코드 삭제 with the real Worker on a database shaped like the deployed one, fake GitHub + fake Anthropic (below) |
| `node tests/code-libs/run.mjs [--headed]` | 8243–8245, 8787 | 코드별 서재: the split migration and deleting a code with its library deleted or moved, real Worker ([`docs/CODE-LIBRARIES.md`](../CODE-LIBRARIES.md) §7) |

`relay/test`, `tests/relay-e2e`, `tests/shared-e2e`, `tests/onboarding/worker-e2e.mjs`, `tests/code-delete/run.mjs` and
`tests/code-libs/run.mjs` all start `wrangler dev` on 8787 (inspector 9339): run them one after the other. `relay/test` runs on a migrated
database (`test/legacy-schema.sql` = the schema before code deletion with two old codes, then `schema.sql` twice; the
`code-delete` suite covers deletion, salts and the migration) and reads the Worker's D1 file read-only with
`node:sqlite` (Node 22.5+; one ExperimentalWarning per run). Neither calls the real API;
`wrangler dev` needs no Cloudflare login. Secrets for the tests are fake and passed as `--var`, so no
`relay/.dev.vars` is needed (`.dev.vars` and `.wrangler/` are git-ignored in `relay/.gitignore` and the root
`.gitignore`). The e2e test refuses to start when something already listens on 8160.

`tests/relay-e2e/run.mjs` scenario (results and screenshots in `pr-tools/out/relay-e2e/`):

1. Owner, 설정 → 초대 코드 관리: a wrong admin token is refused with "관리자 토큰이 올바르지 않습니다." and not saved;
   the right one is checked against the Worker, saved and not shown again.
2. Owner creates 김동료 (Haiku만, $0.05/day) and 박동료 (Haiku + Sonnet, $0.50/day) in the UI and copies the invite
   message (`https://e2jinsoopark.github.io/#/join/<CODE>`).
3. Colleague, fresh browser context with no key: the join link's fragment → straight to the library (no welcome screen
   since 2026-10-19), provider = relay, code and name stored.
4. Upload `lu2025.pdf` (from `pr-fixtures`, read in the browser) → 이 페이지만 번역 (1쪽): the fake answers each batch
   with schema-valid JSON (`〔중계 번역〕 ` + source); one browser POST and one upstream call per batch.
5. Hover sync pane → PDF and PDF → pane on a relay-translated sentence.
6. 요약 (Haiku-only code → Haiku, non-stream) and 채팅 (SSE, deltas arrive one by one).
7. The Worker's booked dollars equal the fake's reported tokens priced with the same table; the admin list shows them.
8. The fake reports +90K input tokens per batch; 이어서 번역 runs into the $0.05 limit and stops once: one toast
   "오늘 사용 한도($0.05)를 모두 썼습니다. 내일 오전 0시(한국 시간)에 다시 열립니다. (번역을 멈췄습니다.)", no failed or
   pending sentences, each refused body sent once.
9. Owner raises the limit to $1.00 in the UI → 이어서 번역 runs to 번역 완료.
10. The colleague's 초대 코드 card and 사용량 show the Worker's numbers.
11. Owner stops the code (the question says the code also leaves the colleague's devices) → 채팅 shows "초대 코드가
    올바르지 않거나 사용이 중지되었습니다."; since code deletion (2026-10-19) the device then forgets the code with one toast
    "초대 코드가 더 이상 쓰이지 않아요. 새 코드를 넣어 주세요." (the colleague has a 내 서재 paper: no first screen) and 설정's
    초대 코드 card is empty; `/relay/me` 401; nothing is forwarded.
12. 박동료's link: both models offered, 요약·채팅 model = Sonnet; its stream goes upstream as `?beta=true` with
    `anthropic-beta: server-side-fallback-2026-07-01`, booked on Sonnet.
13. 날짜별 사용량 lists today with Haiku and Sonnet; every upstream call carried only the owner key (no invite code,
    admin token, cookie, origin or browser-access header).

### Deleting a code (`tests/code-delete/run.mjs`, 2026-10-19)

The real Worker on a local D1 shaped like the deployed one after this update (old schema without `person_salt` + two
old codes, then `schema.sql` twice), production vars, fake GitHub (team repo) and fake Anthropic; staged site on
8232; Edge; results and screenshots in `pr-tools/out/code-delete/e2e/` (11 steps, last run 11/11):

1. Owner, 설정 → 초대 코드 관리: `EICU2-TEST` (코드 직접 정하기) and a random code (김간호사). The column did not exist
   before; the Worker added it on that first creation; both new codes have 32-hex salts, the old ones NULL;
   `GET /shared` personId = SHA-256(code + "\n" + salt) for the new code, the saltless one for an old code.
2. EICU2-TEST holder (join link) uploads lu2025.pdf to 공용 서재, 이 페이지만 번역 through the relay (90K extra input
   tokens per batch → a visible spend), a highlight and a 요약 → `people/<holder>/…/annotations.json` + `ai.json`.
3. 김간호사 (random code) sees paper + translation with 0 translation calls, not the holder's notes, highlights her own.
4. Owner 삭제 → the dialog (title, two lines) → GitHub refuses the deletion's tree once → the Worker's 502 text as the
   toast; dialog and row stay, the code is active again in D1, `/relay/me` 200, the holder's files are still there.
5. 삭제 again → `{ deleted: true, purgedFiles: 2 }`, row gone, "삭제했습니다."; exactly one new commit
   `[관리자] {lib:team} 초대 코드 삭제에 따라 개인 기록 정리` (library marker since code libraries,
   `docs/CODE-LIBRARIES.md`) deleting the holder's 2 files; paper.pdf, translation.json and 김간호사's
   file kept; D1: no code row, no `shared_trees` of the holder (김간호사's kept), usage renamed `deleted:<ISO>:EICU2-TEST`;
   오늘 전체 / 이번 달 전체 unchanged; row "삭제된 코드 이번 달 $0.02" = the holder's month.
6. The holder's open app (in 공용 서재): its next request (지금 동기화) → the proxy's 401 → the first screen with
   "초대 코드가 더 이상 쓰이지 않아요. 새 코드를 넣어 주세요." (not red, no `aria-invalid`), code/name/models cleared, no request
   with that code in the next 5 s.
7. Owner makes `EICU2-TEST` again → a new salt and personId; `/relay/me` today $0 / 0 requests; its row $0; the
   삭제된 코드 row stays.
8. A new browser with it: the paper and translation (0 calls), no old highlight, notes or summary; its own database.
9. The holder's own browser opens the old invite link again (a browser tab tries a refused code once) → `/relay/me`
   200 → 공용 서재 → no old highlight; the old local database is left unused; the refused-code list is empty again.
10. 김간호사 unaffected: a sync (200s), her file kept, 최근 활동 lists "관리자 · 초대 코드 삭제에 따라 개인 기록 정리" (the API
    line has no code or personId), `/relay/me` 200.
11. No console / page / CSP problems, no native dialog, no escaped request; upstream calls carried only the owner key.

## Deploy checklist

Once, by the owner (Cloudflare free plan is enough). Worker first, then the app.

**Worker** — in `relay/`, as in `relay/README.md`:

1. `npx wrangler login`
2. `npx wrangler d1 create paper-relay` → put the printed id into `relay/wrangler.jsonc` `"database_id"` (replacing
   `00000000-0000-0000-0000-000000000000`; the binding name stays `DB`). The id is not a secret.
3. `npx wrangler d1 execute paper-relay --remote --file schema.sql`
4. `npx wrangler secret put ANTHROPIC_API_KEY` (a key made for this server) and `npx wrangler secret put ADMIN_TOKEN`
   (16+ random characters).
5. Check `vars` in `relay/wrangler.jsonc`: `ALLOWED_ORIGINS` contains `https://e2jinsoopark.github.io`; limits as
   wanted (`GLOBAL_DAILY_LIMIT_USD` caps the owner's daily cost). **Never set `TEST_MODE`** in production.
6. `npx wrangler deploy` → note the URL `https://paper-relay.<account>.workers.dev`; opening it shows
   `{"service":"paper-relay","ok":true}`.

**App** — three edits with that URL (origin only, no trailing slash, no path):

1. `js/core/config.js`: `export const RELAY_DEFAULT_URL = '';` → `export const RELAY_DEFAULT_URL = 'https://paper-relay.<account>.workers.dev';`
2. `index.html`, the `Content-Security-Policy` `<meta>` (line 6): in `connect-src`, append
   ` https://paper-relay.<account>.workers.dev` after `https://api.semanticscholar.org`.
3. `tests/shell/run.mjs`: the `CSP` constant holds that exact meta content — append the same origin there.

Then run `node tests/relay-client/run.mjs` (its first test fails unless `connect-src` lists exactly that one extra
origin), `node tests/shell/run.mjs` and `node tests/relay-e2e/run.mjs` (it stages its own copy with the local
Worker, whatever `RELAY_DEFAULT_URL` holds). Commit and push to `main`: the Pages workflow publishes `index.html`,
`css`, `js` and `vendor` only (`relay/`, `tests/`, `docs/` are never published).

**Updating a deployed Worker** (e.g. custom codes and the failed-attempt limiter, 2026-10-19): run
`npx wrangler d1 execute paper-relay --remote --file schema.sql` **first** (it is idempotent: adds the `auth_failures`
table and the `codes_by_key` index), **then** `npx wrangler deploy`. The other way round, every invite-code request
answers 500 until the schema is applied. Then check `https://paper-relay.<account>.workers.dev/` and one `/relay/me`
with a real code.

**Updating a deployed Worker for code deletion** (삭제, person salts — `docs/RELAY.md` §5). Exact order, in `relay/`:

1. `npx wrangler d1 execute paper-relay --remote --file schema.sql` — harmless (every statement `IF NOT EXISTS`);
   it matters only if an earlier update's tables (`auth_failures`, `codes_by_key`, `shared_trees`) are not on the remote
   database yet. It does not add `codes.person_salt` to the existing table: SQLite/D1 has no `ADD COLUMN IF NOT EXISTS`,
   so the Worker adds the column itself on its first code creation (`relay/src/db.js ensureSaltColumn`).
2. `npx wrangler deploy` — **the Worker before the app** (an old Worker's CORS preflight has no `DELETE`: the new
   app's 삭제 would show "초대 코드 서버에 연결할 수 없습니다").
3. `https://paper-relay.<account>.workers.dev/` → `{"service":"paper-relay","ok":true}`; `/relay/me` with an existing
   code → 200 (existing codes keep their personId and 공용 서재 notes: no salt).
4. With the app as it is: 설정 → 초대 코드 관리 → make a throwaway code (`삭제 시험`), then
   `npx wrangler d1 execute paper-relay --remote --command "SELECT code, person_salt IS NOT NULL AS salted FROM codes ORDER BY created_at DESC LIMIT 3"`
   → `salted` = 1 for that code only.
5. Push the app to `main` (GitHub Pages). No CSP / `RELAY_DEFAULT_URL` change.
6. In the published app: the throwaway code's **삭제** → dialog → 삭제 → "삭제했습니다.", the row is gone.

Rolling the Worker back (`npx wrangler rollback`) keeps the data usable (the old Worker ignores `person_salt` and the
`deleted:…` usage rows), but codes made after this update would map to their saltless personId — an empty 공용 서재
note folder — until the new Worker is deployed again; the old Worker's totals leave out deleted codes' usage.

**First use** — on the owner's device: 설정 → 초대 코드 관리 (관리자) → 관리 화면 열기 → admin token → create a code
→ 초대 메시지 복사 → open the link in a private window → translate one page → the code's row shows the spend.

## Known limits

- Budgets are checked before forwarding and booked after the reply, so requests already in flight can pass the
  limit: in two e2e runs (3 parallel batches of ≈ $0.01) a $0.05 code ended at $0.066 and $0.076. With normal batches
  (≈ $0.001 on Haiku) the overshoot is a few cents at most; `GLOBAL_DAILY_LIMIT_USD` bounds the total.
- In `wrangler dev`, a browser abort did not reach the upstream (the reply ran to the end and was booked in full);
  on Cloudflare, an abort may stop the stream early and book only the usage seen so far. Not verified in production.
- Each request body is parsed in full on the Worker; very large image requests (그림·표 설명) may exceed the free
  plan's per-request CPU time. Not measured.
- `ALLOWED_ORIGINS` includes `http://localhost:*` and `http://127.0.0.1:*` (per the contract): a local page that
  knows a code can use it. The code itself is the secret; stop a leaked code in 초대 코드 관리.
- **Stopped and deleted codes look the same to a device** (401 "초대 코드가 올바르지 않거나…": the Worker never says which,
  so a guesser cannot learn that a word was a code). The app forgets a saved code on that 401, so 중지 also clears the
  code on colleagues' devices; after 다시 사용 they open the invite link or paste the code again (the 중지 question says
  so). A device that asks during the second or so a deletion runs (the code is switched off first) forgets it too,
  even if the deletion then fails with 502.
- A deleted code counts as an unknown code in the failed-attempt limiter (a stopped one does not). The app stops
  asking after the first 401; only many outdated tabs on one hospital IP could add up.
- What a deleted code's holder already has on the device (their 공용 서재 IndexedDB copy, incl. their notes and cached
  PDFs) stays there until 이 기기의 데이터 모두 지우기; the app no longer opens it (a new code means a new personId and
  database). Deliberately not auto-wiped: a misconfigured relay answering 401 to everyone must not erase every cache.
- A request still running when its code is deleted is booked after the deletion under the bare code; it shows under
  삭제된 코드, unless the same letters are made into a code again on that day, which then gets it.
