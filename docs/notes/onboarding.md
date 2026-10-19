# First screen, invite codes you can paste, 홈 화면에 추가, chosen codes — app side

Owner's request (2026-10-19): "그냥 깔끔하게 첫 화면에 코드만 넣게 … 홈 화면 추가방법만 간단하게 버튼 … 최대한 심플하게",
"홈화면 추가시 바로 담기게", "그룹별 맞춤코드 — 코드 자체를 사용자 지정으로". The Worker side (custom codes, key matching,
the failed-attempt limiter) is [`docs/RELAY.md`](../RELAY.md) §4; this note is the app.

| File | What |
|---|---|
| `js/ui/start-view.js` (new) | the first screen: the 'g' mark + 갈피, ONE input (초대 코드), 시작, one link. Also the join link's screen. |
| `js/ui/install.js` (new) | the 홈 화면에 추가 button, the browser's install events, the web app manifest (not on iOS). |
| `js/app.js` | `setupInstall()` first thing in `boot()`; router: first screen (`needsGate`), join link, silent re-join; `SharedLibraries.settled()`. |
| `js/ai/relay.js` | `extractInviteCode`, `inviteCodeKey`, `isGeneratedCode`, `checkCustomCode`, both kinds in `normalizeInviteCode` / `isInviteCode`, the new `inviteMessage`, idempotent `registerInviteCode`, `createCode({ code })`. |
| `js/ui/settings-view.js` | 초대 코드 관리 → 새 초대 코드: **코드 직접 정하기 (선택)**; the old join/welcome screen (`mountJoinView`) is gone. |
| `js/ui/library-view.js` | the button in the sidebar footer (above 설정) and, on phones, in the header. |
| `js/ui/components.js` | popovers and context menus are measured while transparent instead of `visibility: hidden` (WebKit fix, below). |
| `js/ui/icons.js` | `square-plus`, `share`. |
| `index.html` | no static `<link rel="manifest">`; `apple-mobile-web-app-capable` (+ `mobile-web-app-capable`, so Chromium does not warn). |
| `relay/test/code-vectors.json` (new) | the code rules as one table, checked by the Worker's and the app's tests (§3). |
| `tests/onboarding/run.mjs`, `tests/onboarding/worker-e2e.mjs` (new) | fakes (Edge + WebKit) / the real Worker end to end (Tests, below). |

## 1. The first screen

Shown instead of the library (any library or paper route) to a **fresh visitor**: no usable AI (`settings.isAiReady()`
false, no saved Claude/GPT/Gemini key, no invite code — `?mock=1` counts as AI), nothing in 내 서재 and no GitHub sync
(`needsGate()` in `js/app.js`). Someone whose library has papers or folders, or who syncs, always gets the library, AI
or not. 설정 and `#/join/…` are never gated.

Content, nothing else: the mark (`icon-192.png`), "갈피", label 초대 코드, the input (placeholder
`PR-XXXX-XXXX 또는 받은 메시지를 붙여넣기`), 시작, and **내 API 키로 쓰기** (→ `#/settings/ai`; its 뒤로 comes back to the first
screen). No paragraphs, no browser advice, no install button. 16 px input text (iOS Safari would zoom on focus);
desktop focuses the input, touch devices do not (the keyboard would cover the screen).

Errors: one short line under the input (`role="alert"`, the input gets `aria-invalid`), cleared on typing:
- nothing typed → 초대 코드를 넣어 주세요
- no code in the text, a malformed code (no request), or the relay's 401 → **코드를 찾을 수 없어요**
- anything else → the relay's own Korean message, e.g. the limiter's 429 "시도가 너무 많습니다. 잠시 후 다시 시도해 주세요."
  or "초대 코드 서버에 연결할 수 없습니다…".

Success: the code is saved (`registerInviteCode`), the screen waits up to 2.5 s for `GET /shared` (`deps.shared.settled()`,
so an invitee lands in 공용 서재, not in an empty 내 서재 first), shows the toast "초대 코드를 등록했어요." and replaces the
address with `#/` (the router then sends an invitee to `#/s/<lib>`). No welcome screen. While it registers the router
does not re-route on the settings change (`busy()`); otherwise a code or key arriving some other way (another tab,
설정) makes the first screen give way by itself.

### Join link `#/join/<CODE>`

- The code the browser already has (compared by key, so `ICU-2TEAM` = `icu2team`): the router replaces the address
  with `#/` and opens the library — no screen in between, no request (`registerInviteCode` returns `unchanged`; it only
  switches the provider back to 초대 코드 when no other AI setup works). `refreshRelayIdentity` is skipped for join
  routes, so a re-launch makes no `/relay/me` call.
- Another code: the first screen with the code filled in, registering at once (button "확인 중…"). Error → the same
  screen with the error line; the link is **내 API 키로 쓰기** for a fresh visitor, **돌아가기** (→ `#/`) for someone who
  already has a working setup. Settings stay untouched until the relay accepts the code.
- In an installed / home-screen app (`isStandalone()`) the join screen is **quiet**: only the mark and a spinner while
  registering; the form appears only if registering fails.

## 2. Paste anything

`relay.extractInviteCode(text)` takes, in this order: `#/join/<code>` in a link → a `코드: <code>` line → a
`PR-XXXX-XXXX` pattern (any case, spaces or dash look-alikes inside) → the trimmed text itself as a chosen code (one line
only). The first candidate that is a valid code wins; '' when there is none. A single-line input strips the line
breaks of a pasted message (`…김간호사님https://…/#/join/PR-7K3M-Q9XD코드: PR-7K3M-Q9XD`), so a code is read only as far
as letters, digits, hyphens and `%`-escapes go. The first screen's `paste` handler puts just the code into the input;
시작 extracts again from whatever is there (typed, autofilled, WebKit `fill`). Settings → 초대 코드 accepts the same
(its normalize step uses `extractInviteCode`).

## 3. Two kinds of code (as the Worker reads them)

| | generated | chosen by the owner |
|---|---|---|
| shape | `PR-XXXX-XXXX`, Crockford base32 | 6–24 of A–Z, 0–9, single hyphens (`ICU-2TEAM`) |
| recognised by | "PR" + 8 letters/digits once **every other character** is dropped (spaces, dashes, dots, Hangul…: `코드: PR-7K3M-9QXA` and `PR.7K3M.9QXA` are generated codes) | everything else made of A–Z/0–9/hyphen/space |
| app's spelling | upper case, `PR-XXXX-XXXX`, typed O → 0, I/L → 1 | NFKC (full-width letters from a Korean keyboard), upper case, spaces and dash look-alikes → one hyphen, no hyphen at the ends; **no letter replaced** |
| a presented code is valid if | the shape above with Crockford letters only (a `U` left over → no code, nothing sent) | letters+digits 4–24 long (the shortest chosen code `A-B-CD` has 4) and not the generated shape |

The Worker matches **by key** (letters and digits only) and keeps a chosen code as the owner spelled it, so the app
keeps a typed chosen code as typed (folded): `icu 2team` is saved as `ICU-2TEAM`, `icu2team` as `ICU2TEAM`, both open the
same code (`inviteCodeKey` compares them). The generated shape is reserved for generated codes, which is why the O/I/L
reading can never change a chosen code. Only ASCII leaves the app (header values must be Latin-1).

`checkCustomCode` (admin field) mirrors `relay/src/codes.js validateCustomCode`: characters, generated shape, length
6–24 with hyphens, the same `RESERVED_CODES` list (compared without hyphens), "too easy" (one repeated character, a piece
of 0123456789 / A–Z / QWERTY rows, either direction). The Worker has the final say (400 / 409 with Korean messages,
shown as they are).

**One rule table for both sides: [`relay/test/code-vectors.json`](../../relay/test/code-vectors.json)** — presented codes
(kind, app spelling, key), chosen codes (stored spelling or the reason for a refusal, matched by the same Korean words
on both sides: 영문·숫자·하이픈 / PR-XXXX-XXXX 모양 / 6~24자 / 이 단어 / 너무 쉬운), blank = random, and (app only) what is
taken out of pasted text. `relay/test/codes-unit.test.mjs` checks the Worker against it; `tests/onboarding/run.mjs`
checks `js/ai/relay.js` against it in Edge **and** WebKit, and runs both modules in Node on 40,000 seeded random strings
(P/R, O/I/L/U, dash look-alikes, full-width, Hangul, punctuation) — any disagreement fails. Change a rule in the table
first. At integration this differential found two real mismatches, now fixed in the app: it sent `PR-ABCU-…` (U is not
Crockford — the Worker reads no code there and counts a failure) and refused `PR.7K3M.9QXA` / `코드: PR-…` typed as one
string (the Worker reads those as the generated code).

## 4. Invite message (초대 메시지 복사)

Exactly a short title and two content lines:
```
[갈피 초대] 김간호사님
https://e2jinsoopark.github.io/#/join/PR-7K3M-Q9XD
코드: PR-7K3M-Q9XD
```
(`[갈피 초대]` alone without a name.) The `코드:` line is what a home-screen app, another browser or a KakaoTalk in-app
browser user pastes into the first screen — the whole message works too.

## 5. 홈 화면에 추가

One small ghost button with the `square-plus` icon: in the library sidebar footer above 설정; at ≤ 860 px (the sidebar is
a drawer) in the library header next to the title instead. Shown only in a browser tab (`display-mode: standalone /
fullscreen / minimal-ui / window-controls-overlay` and `navigator.standalone` hide it) and until hidden.

| where | the click |
|---|---|
| Chromium with an install prompt (`beforeinstallprompt`, kept with `preventDefault()` — no mini-infobar) | `prompt()`; accepted (or `appinstalled`) → hidden for good in this browser. A prompt is used once; declined on a phone → the hint below |
| Android / other phone browsers without a prompt (e.g. after declining, Samsung Internet, in-app browsers) | one-line popover **브라우저 메뉴 ⋮ → 홈 화면에 추가** |
| iPhone / iPad (also iPadOS's "Macintosh" UA with touch; every iOS browser is WebKit) | see below — popover **공유 [share glyph] → 홈 화면에 추가** |
| desktop without a prompt | no button (nothing useful to say) |

Every popover has a small **버튼 숨기기** (remembered per browser in `pr.ui.v1` `installHidden`, also set after an install).

### iPhone / iPad — honest status: built for, but not verified on, a real device

iOS home-screen apps have **their own storage, separate from Safari**, so a code saved in Safari is not there when the
home-screen app starts. The code therefore travels in the saved address:
1. On iOS the page exposes **no web app manifest** (`js/ui/install.js` injects `<link rel="manifest">` only on other
   systems; index.html no longer has it), so Safari uses the page's current address for the home-screen icon, with
   `apple-touch-icon` (icon-180), `apple-mobile-web-app-title` 갈피 and `apple-mobile-web-app-capable` yes.
2. The button puts `#/join/<CODE>` into the address bar (`history.replaceState`, only when an invite code is saved — the
   code becomes visible there) and shows the popover. The person then uses Safari's share → 홈 화면에 추가.
3. The home-screen app starts at `…/#/join/<CODE>` with empty storage: quiet registration (one `/relay/me`), then the
   library (공용 서재). Every later launch starts at the same address: the code is already saved → straight to the
   library, no screen, no request.

**Confirmed on the owner's real iPhone (2026-10-19):** after 홈 화면에 추가 in Safari, the home-screen icon opened
straight into 공용 서재 without asking for the code — the `#/join/<CODE>` web-clip address carries the code into the
home-screen app's separate storage as designed.

What only a real iPhone can confirm (WebKit in Playwright is Safari's engine, not Safari; `tests/onboarding/run.mjs`
and `tests/onboarding/worker-e2e.mjs` stand in for the home-screen app with a fresh WebKit context (iPhone 15 profile),
`navigator.standalone = true` and `display-mode: standalone`):
- that Safari keeps the `#/join/…` fragment in the saved web-clip address (expected; it has kept fragments), and that
  without a manifest it uses the current address (iOS 16.4+ may prefer a manifest's `start_url` — the reason the
  manifest is withheld on iOS);
- that the icon opens as a web app (no Safari bars) with only `apple-mobile-web-app-capable` and no manifest (iOS 26's
  "웹 앱으로 열기" switch in the add sheet should be on), and that `navigator.standalone` is then true (it hides the button
  and makes the join screen quiet);
- where 홈 화면에 추가 is: iOS 26 Safari puts 공유 under the ⋯ button of the address bar; older iOS has it in the
  bottom bar. The popover names the steps, not the place;
- Chrome for iOS has its own share button (top right) but the same storage rule;
- Safari never says that the icon was added (no `appinstalled` on iOS): the button stays in the Safari tab until
  버튼 숨기기.
A person who adds the icon WITHOUT pressing the button gets whatever address was in the bar (e.g. `#/s/team`): the
home-screen app then shows the first screen, where the invite message (or its `코드:` line) is pasted once.

**Real-iPhone check (5 minutes, once before telling colleagues):**
1. Safari: open an invite link (or type the code on the first screen) → 공용 서재 opens.
2. Tap **홈 화면에 추가** → the popover “공유 → 홈 화면에 추가”; tap the address bar: it ends in `#/join/<CODE>`.
3. 공유 → 홈 화면에 추가 (iOS 26: ⋯ → 공유 → 홈 화면에 추가; leave "웹 앱으로 열기" on) → 추가.
4. Tap the new icon: no Safari bars; the 갈피 mark with a spinner for a moment, then 공용 서재 and "초대 코드를 등록했어요.".
   If the first screen with the input appears instead, the fragment did not survive (or a start address was used) —
   paste the 코드 line once, and report it: the fallback works, the design assumption does not.
5. Swipe the app away and open it again: straight into 공용 서재, nothing in between; no 홈 화면에 추가 button inside.
6. Optional: the same on an iPad, and in Chrome for iOS.

Android: an installed app (WebAPK) shares Chrome's storage, so `start_url` `./` is enough there.

## 6. Admin: 코드 직접 정하기

설정 → 초대 코드 관리 → 새 초대 코드: an optional field **코드 직접 정하기 (선택)** (placeholder "비워 두면 자동 (예: ICU-2TEAM)",
monospace) with one note under it: **여러 명이 같은 코드를 쓰면 메모와 사용 한도도 함께 씁니다.** Checked as typed (`checkCustomCode`),
shown as it will be saved on blur (`eicu 2team` → `EICU-2TEAM`); a refusal is one red line under the field and nothing is
sent. 코드 만들기 sends `code` only when the field is not blank (blank = random `PR-XXXX-XXXX` as before). The Worker's 409
("이미 있는 코드입니다(대소문자와 하이픈은 구분하지 않습니다)…") and 400 messages appear in the form's result line.

## 7. WebKit: blank popovers and menus (fixed in components.js)

`popover()` and `contextMenu()` hid the node with `visibility: hidden` while measuring it and switched it back in the
same task. WebKit (Playwright 1.63, iPhone profile) kept the **children** computed as hidden: an empty white box — on
an iPhone every popover and context menu of the app would have been blank. They are now measured with `opacity: 0`
(not inherited, so nothing stale). Chromium behaves the same as before (shell tests pass).

## Tests

```
node relay/test/run.mjs unit             # the Worker against relay/test/code-vectors.json (+ the other unit tests)
node tests/onboarding/run.mjs            # port 8221; fakes; Edge + WebKit (iPhone 15); 12 checks
node tests/onboarding/worker-e2e.mjs     # ports 8222–8224 + wrangler dev 8787; the REAL Worker; Edge + WebKit; 8 steps
node tests/relay-client/run.mjs          # join link / invite message / helpers updated for the new behaviour
```
`tests/onboarding/run.mjs` (no paid API, no real relay, no GitHub; relay.test route-intercepted, 공용 서재 through
`tests/store/fake-relay.mjs` + `fake-github.mjs`, which now knows owner-chosen codes too; any console error, page error,
CSP violation or escaped request fails): the shared code vectors in Edge and WebKit + the 40,000-string app = Worker
differential + the 3-line message; first screen content at 390×844, 412×915 (Pixel 7) and 1440×900 × light/dark; error
lines and no request for text without a code; Android paste of the whole message → 공용 서재 directly; Android install
(hint, prompt once, hidden after install / in the app / after 버튼 숨기기, manifest injected); desktop (button only with a
prompt); join link + silent re-open + a chosen code in another spelling (→ 공용 서재); wrong join code (link text per
setup); the limiter's 429 line and a generated code still working; iPhone (no manifest, apple meta, `#/join/<CODE>` in
the address, popover text, home-screen app quiet first launch and silent next launch); admin 코드 직접 정하기 (refusals
unsent, spelling, POST body, 409, blank → random, the 3-line message pasted on a phone). Screenshots:
`C:/Users/dindoo/Projects/pr-tools/out/onboarding/`.

`tests/onboarding/worker-e2e.mjs` — the same flows against the **real Worker** (`wrangler dev`, fresh local D1, production
vars of `relay/wrangler.jsonc` incl. `SHARED_LIBRARIES`, `GITHUB_API_BASE` → fake GitHub, `UPSTREAM_URL` → fake Anthropic,
no `TEST_MODE`) and a staged copy of the site (`tests/relay-e2e/test-site.mjs`). Each device sends its own
`CF-Connecting-IP` (route interception; `wrangler dev` passes it through):
1. owner, 설정 → 초대 코드 관리: `EICU2-2026` (코드 직접 정하기) and a blank field → random `PR-…`; `eicu2 2026` → the Worker's
   409 line; both copied messages are exactly title / link / `코드:`;
2. fresh Edge: the whole random-code message pasted with a real Ctrl+V → the input holds the code → 시작 → 공용 서재;
3. fresh WebKit iPhone 15: bare site → first screen (no manifest, apple meta) → types `eicu2-2026` → 공용 서재 (stored
   `EICU2-2026`); 홈 화면에 추가 → address `#/join/EICU2-2026`, popover “공유 → 홈 화면에 추가”, still no manifest;
4. home-screen app (new WebKit context, standalone) at that address, launched twice: quiet screen + one `/relay/me` →
   공용 서재; then no screen and no request; never the form, never a welcome, no install button;
5. Android (Edge, Pixel 7): join link → 공용 서재, `<link rel=manifest>` injected (`start_url ./`, standalone), header
   button; a simulated `beforeinstallprompt` is kept (`preventDefault`), the click calls `prompt()` once → gone;
6. limiter: 21 different wrong codes from one IP → 20 × "코드를 찾을 수 없어요" (401), the 21st "시도가 너무 많습니다. 잠시 후 다시
   시도해 주세요." (429, `x-should-retry: false`, `retry-after`); another IP opens `eicu2 2026` meanwhile; the blocked IP
   is refused `EICU2-2026` but gets in with the generated code;
7. personId: `EICU2-2026`, `eicu22026`, `Eicu2 2026`, `eicu2--2026` → one `people/<id>` = SHA-256(`EICU2-2026`);
8. no console / page / CSP problems, no native dialog, no escaped request, 0 calls to the (fake) Anthropic API.
Results and screenshots: `C:/Users/dindoo/Projects/pr-tools/out/onboarding/worker-e2e/`.

## Known limits

- iPhone/iPad: not verified on a real device — see the 5-minute check in §5.
- The first screen's success toast names nobody (a group code's name may be a team name).
- `needsGate` reads 내 서재 as opened at boot; a library that only appears after a later sync (no GitHub settings yet)
  cannot exist, so this is consistent.
- After the iPhone button the address bar shows `#/join/<CODE>` until the next navigation inside the app (the code is
  visible to someone looking over the shoulder; it is the same code as in the invite message).
- On a shared hospital IP, someone typing 20 wrong codes within 10 minutes blocks owner-chosen codes from that IP for up
  to 10 minutes (generated `PR-…` codes keep working) — the Worker's choice, `docs/RELAY.md` §4. The first screen then
  shows the Worker's "잠시 후 다시 시도해 주세요" line.
- `js/store/library.js` `personIdFor(code)` (a fallback used only when no personId is passed) still knows generated codes
  only; the app always passes the personId from `GET /shared`, so owner-chosen codes work (worker-e2e step 3–7).
- The app's modules already used regex lookbehind before this change (`js/ui/components.js`), so iOS Safari older than
  16.4 cannot run 갈피 at all; not new, not addressed.
