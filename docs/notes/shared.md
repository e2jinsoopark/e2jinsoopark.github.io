# 공용 서재 (shared team library) — integration notes

One team library that **everyone with an invite code** uses, everyone with the same rights; folders, papers (PDF) and
translations are shared, highlights/notes and AI data are per person. Contract: [`docs/SHARED.md`](../SHARED.md)
(§5 lists what was settled while building). Worker side and the owner's one-time setup in Korean:
[`relay/README.md`](../../relay/README.md) › 공용 서재 켜기. Store side: [`store.md`](store.md) › Several libraries.
User-facing explanation (Korean): [`README.md`](../../README.md) › 공용 서재.

There is **one** 공용 서재 per server, not one per invite code: every active code opens the same library ('team').
What belongs to a code (= a person) is `people/<personId>/`: that person's highlights, notes and AI results.

## Architecture

```
 each person's browser (app on https://e2jinsoopark.github.io)
 │
 ├─ 내 서재   Library 'mine'         IndexedDB 'paper-reader'
 │            GitHubClient → https://api.github.com, the owner's own fine-grained token → personal repo (unchanged)
 │
 └─ 공용 서재 Library 'shared:team'  IndexedDB 'paper-reader-shared-team-<personId>'  (js/store/library.js openSharedLibrary)
              GitHubClient { proxy: true, apiBase: <relay>/shared/team/gh, owner 'team', repo 'library',
                             token = the invite code }       same SyncEngine + merge rules as 내 서재
      │  Authorization: Bearer PR-XXXX-XXXX
      ▼
 Cloudflare Worker paper-relay (relay/src/shared.js, shared-paths.js, github.js)
      │  code → D1 codes (active?) · personId = SHA-256(code)[0:16] · only the 11 routes of SHARED.md §2.1
      │  reads: tree listings without people/<other>/ · writes: path allowlist, base_tree = head, parents = [head],
      │  no force, PDFs immutable, deletes only of own people/<me>/ files · commit message → "[name] …"
      │  D1 shared_trees: trees made through the proxy (a commit must use a tree this person built on that head)
      │  Authorization: Bearer TEAM_GITHUB_TOKEN (Worker secret) · X-GitHub-Api-Version · User-Agent: paper-relay
      ▼
 GitHub dindoopark/paper-team-library (private)
      library.json                                         folders, papers, tombstones (deletedAt, deletedBy)
      papers/<paperId>/paper.pdf                           shared, immutable
      papers/<paperId>/translation.json                   shared (union-merged)
      people/<personId>/papers/<paperId>/annotations.json  that person only
      people/<personId>/papers/<paperId>/ai.json           that person only
      README.md                                            made by the first push into an empty repo
```

Other shared endpoints: `GET /shared` (libraries, personId, name — the app opens one Library per listed library),
`GET /shared/<lib>/activity` (최근 활동, from the commit messages), admin `GET /relay/admin/shared/<lib>/stats` and
`POST /relay/admin/shared/<lib>/purge` (설정 → 공용 서재 용량 확인, 휴지통 → 30일 지난 항목 비우기).

| | shared with everyone | per person |
|---|---|---|
| folders (create, rename, move, delete → 휴지통) | yes | |
| papers: PDF, title/meta, folder, delete → 휴지통 | yes | |
| translation (`translation.json`) | yes — one person translates, everyone reuses it (0 calls) | |
| highlights + notes (`annotations.json`) | | yes, synced across that person's devices |
| AI summary, chat, explanations, key points (`ai.json`) | | yes, synced across that person's devices |
| 즐겨찾기, 최근 읽음 | | yes, this browser only (`uiState 'sharedLocal'`) |

## Reconciliation (relay ↔ store ↔ UI ↔ SHARED.md)

The three parts were built in parallel from SHARED.md and checked against each other with the real Worker
(`tests/shared-e2e/run.mjs`). No request or response shape had to change. Settled points:

- **Status codes.** A stale `base_tree` (not the head's tree, nor a head of the last 10 min) and a single parent that
  is not the head get **409**; the client (`GitHubClient` proxy mode) treats 409/422 on `POST git/trees` and
  `git/commits` as a conflict → re-pull, merge, retry. Rule violations (missing `base_tree`, wrong parent count,
  paths, other people's files, PDF changes, deletions outside `people/<me>/`, `force`) get **403** and are shown to
  the user without retry. In the e2e run the browsers got 409 only from the empty repo before its bootstrap, 422 only
  from the deliberately held concurrent push (which then merged and landed), and no 403 at all.
- **Empty team repo.** Works as created on GitHub (no README needed): the first push sends
  `PUT contents/README.md` through the proxy (allowed only while the repo is empty); the commit reads
  `[<name>] 논문 리더 데이터 저장소 시작` in 최근 활동.
- **Database per person.** `paper-reader-shared-<lib>-<personId>` (contract example: `paper-reader-shared-team`), so
  two codes used in one browser never mix notes. app.js and the store build the same name; 이 기기의 데이터 모두
  지우기 deletes every `paper-reader-shared-*` database.
- **personId** is computed the same way in three places (relay `personIdFor`, store `personIdFor`, the e2e test);
  `tests/store/library.test.mjs` cross-checks the store against `relay/src/codes.js`. The app takes the relay's
  `GET /shared` value.
- **Deletes keep files** (`retainPdfOnDelete`): tombstones carry `deletedAt` and `deletedBy` (the code's name). A
  deleted folder's contents stay visible in its parent and come back with it. Restore un-tombstones parent folders
  too. Purge (admin) deletes `papers/<id>/*` and everyone's `people/*/papers/<id>/*` of papers tombstoned more than
  30 days ago; the tombstone records stay.
- **Copy from 내 서재** (`copyPaperTo` / `copyFolderTo`): PDF + translation + title/meta only, never annotations,
  ai, star or last-opened. A PDF that is already in 공용 서재 (same sha256, or size + git blob sha for older records)
  is not uploaded again; that paper is placed into the chosen folder instead (SHARED.md: "mapping them into the target
  folder"). This moves it for everyone — the toast says "이미 있던 N편은 폴더에만 넣음".
- **최근 활동** comes from commit messages: the store writes a short Korean description of the batch
  (`폴더 만듦 ‘…’ · 논문 추가 ‘…’`, `번역 ‘…’`, `논문 삭제 ‘…’`, `복구 ‘…’`, `폴더 복사 ‘…’ (내 서재에서, 논문 2편)`), the
  Worker prefixes `[<name>] ` and strips person ids and codes; the activity endpoint returns `{ ts, who, summary }`
  without e-mails or logins. **Integration change:** the view hides commits that are not an action on the shared
  library — `내 메모·AI 결과 동기화` (only that person's `people/<id>/` files) and `논문 정보 갱신` (only the progress
  counts in library.json) — via `QUIET_ACTIVITY` in `js/ui/library-view.js`. They stay in the repo history; others
  need not see when someone took notes.
- **Admin** = whoever has the admin token saved (the owner). Purge answers `{ purged: [ids], files, freedBytes,
  commitSha }` (the app reads `purged.length`, `freedBytes`); stats `{ bytes, papers, people, maxBytes }`.

UI decisions (from the UI builder, kept):
- Invitee = code saved + no GitHub sync of their own + AI provider 초대 코드. Their `#/` goes to `#/s/<lib>` until they
  choose 내 서재 in the sidebar; 내 서재 starts folded while empty. A first visit without a remembered library list
  waits up to 2.5 s for `GET /shared`; a late answer still moves an untouched `#/` to 공용 서재.
- The last `GET /shared` answer is remembered (`localStorage 'pr.shared.v1'`, keyed by a fingerprint of server + code),
  so 공용 서재 opens from the device's copy at once and offline.
- Routes `#/s/<lib>`, `#/s/<lib>/trash`, `#/s/<lib>/activity`, `#/s/<lib>/paper/<id>`, plus `#/trash` for 내 서재's 휴지통
  (folders only: 내 서재 deletes a paper's files with it).
- The reader badge shows "공용 서재 · 번역은 모두와 공유, 메모는 나만" in full only at ≥ 1680 px; narrower it shows
  "공용 서재" with the full text in its tooltip / aria-label. The reader no longer writes `lastOpenedAt` into a shared
  record, reloads `ai.json` on remote changes under `people/<me>/`, and waits for an in-progress first sync (≤ 30 s)
  before saying "논문을 찾을 수 없습니다" (also in 내 서재).
- Deleting in 공용 서재 asks once ("…휴지통으로 이동합니다. 30일 안에 복구할 수 있습니다"), the toast offers 되돌리기.
  Dragging a 내 서재 paper/folder onto 공용 서재 asks once, then copies.
- A server without `/shared` (404) or without libraries for the code hides the section; a network failure or 401 with
  no remembered list shows the section with the error and 다시 시도.

## Deploy (owner, once)

The app needs **no change**: the shared proxy is on the relay origin that `RELAY_DEFAULT_URL` and the CSP
`connect-src` already name (`https://paper-relay.e2jinsoopark.workers.dev`). Until the Worker is redeployed, the old
Worker answers `GET /shared` with 404 and the app simply shows no 공용 서재.

In `relay/` (details and screenshots-free click path in `relay/README.md` › 공용 서재 켜기):

1. GitHub → Settings → Developer settings → Fine-grained tokens → Generate: Repository access **only**
   `dindoopark/paper-team-library` (private), Permissions → **Contents: Read and write**.
2. `npx wrangler secret put TEAM_GITHUB_TOKEN` (paste the `github_pat_…`).
3. `npx wrangler d1 execute paper-relay --remote --file schema.sql` — adds the `shared_trees` table (existing tables
   are untouched).
4. `SHARED_LIBRARIES` is already in `relay/wrangler.jsonc` `vars` (a JSON array:
   `[{ "id": "team", "name": "공용 서재", "repo": "dindoopark/paper-team-library", "branch": "main", "maxBytes": 4000000000 }]`)
   next to `GITHUB_API_BASE: "https://api.github.com"`; check repo, branch and size cap.
5. `npx wrangler deploy`.
6. Check: `curl -H "Authorization: Bearer PR-XXXX-XXXX" https://paper-relay.e2jinsoopark.workers.dev/shared` →
   `{"libraries":[{"id":"team","name":"공용 서재"}],"personId":"…","name":"…"}`. (`libraries` stays `[]` while
   `TEAM_GITHUB_TOKEN` is missing.)

Then on the owner's device: 설정 → 초대 코드 관리 → make a code with your own name → open its join link in your browser
(내 서재's GitHub sync stays; the AI provider becomes 초대 코드 — pick your own key again in 설정 → AI 번역 if you
prefer) → the sidebar shows 내 서재 and 공용 서재 → 논문·폴더 메뉴 → 공용 서재로 복사…. Colleagues just open their join
links. Never set `TEST_MODE` in production.

## Adding a second library later

1. Create another **private** repo (e.g. `dindoopark/lab-library`; it may stay empty) and add it to the **same**
   fine-grained token (GitHub → the token → Repository access → add the repo; Contents: Read and write). The Worker
   uses one `TEAM_GITHUB_TOKEN` for all libraries.
2. Add an entry to `SHARED_LIBRARIES` in `relay/wrangler.jsonc`:
   `{ "id": "lab", "name": "연구실 서재", "repo": "dindoopark/lab-library", "branch": "main", "maxBytes": 2000000000 }`.
   `id`: lowercase letters, digits, `-`, ≤ 32 characters; never rename it later (it is in URLs `#/s/<id>`, IndexedDB
   names and the D1 `shared_trees` rows). `name` is what the sidebar shows and may change.
3. `npx wrangler deploy`. Nothing changes in the app: `GET /shared` lists both, the sidebar gets a second 공용 서재
   section, the copy dialog asks which library, 휴지통 / 최근 활동 / purge / stats are per library.
4. Today every active code sees every library. To give a library to some codes only, change `librariesFor(row,
   config)` in `relay/src/shared.js` — the only place that decides it — e.g. with a table
   `code_libraries (code TEXT NOT NULL, lib TEXT NOT NULL, PRIMARY KEY (code, lib))` in `schema.sql`, read together
   with the code row, and admin endpoints to grant/revoke. `GET /shared`, the proxy and activity already go through it.
5. Removing an entry hides that library (the app closes it; data already on devices stays until 이 기기의 데이터 모두
   지우기; the repo keeps everything).

## Tests

| Command | Ports | What |
|---|---|---|
| `node tests/shared-e2e/run.mjs [--headed]` | 8195 (site), 8196 (fake GitHub), 8787, 8788, 9339 | **Real app + real Worker** (`wrangler dev`, production vars + `GITHUB_API_BASE` → fake GitHub serving the personal and the team repo, each with its own token) + fake Anthropic; scenario below |
| `node tests/shared-ui/run.mjs` | 8194 | UI details against `tests/store/fake-relay.mjs` (route-intercepted `https://relay.test`), mock AI |
| `node tests/store/library.test.mjs` / `run-shared.mjs` | – / 8193 | store: several libraries, 휴지통, copy, through the fake relay |
| `node relay/test/run.mjs shared shared-client` | 8787–8789, 8792, 9339 | Worker rules over HTTP, and `GitHubClient` through it (Node + Edge) |

`relay/test`, `tests/relay-e2e` and `tests/shared-e2e` all use 8787/8788 (and wrangler's inspector 9339): run them one
after the other. None of them calls a paid API or contacts the real GitHub or the deployed relay; the staged site
(`tests/relay-e2e/test-site.mjs`) adds the local Worker to a copy of `index.html`'s CSP, the repo files are untouched.
Results and screenshots: `C:/Users/dindoo/Projects/pr-tools/out/shared-e2e/` (`results.json` also holds every browser →
Worker request with its status).

`tests/shared-e2e/run.mjs` scenario (17 checks; any console error, page error, CSP violation, native dialog or request
outside the app / Worker / jsDelivr SDK / fake GitHub fails the step):
1. Owner, 설정 → 초대 코드 관리: codes for 김간호사, 이간호사 and the owner (박진수), checked in D1.
2. Owner opens their own join link: home stays 내 서재 (GitHub sync), the sidebar adds an empty 공용 서재;
   `GET /shared` → `[{ id: 'team', name: '공용 서재' }]`, personId = SHA-256(code)[0:16].
3. Owner's 내 서재: folder ‘섬망 연구’ (kiekkas2012, simwright2005) + cohen1960 at the top, synced to the personal repo.
4. ‘섬망 연구’ → 공용 서재로 복사…: the empty team repo is bootstrapped through the Worker, both PDFs are byte-identical,
   no `people/` files, commits `[박진수] …`.
5. 김간호사, fresh browser, join link → `#/s/team` with the owner's folder and papers, 내 서재 folded.
6. 김간호사: folder ‘ICU 섬망’, uploads lu2025.pdf (addedBy, sha256 recorded).
7. 김간호사: reader badge, 이 페이지만 번역 through the relay (owner key upstream only) → `papers/<id>/translation.json`;
   a yellow highlight → `people/<김>/papers/<id>/annotations.json`.
8. 이간호사, fresh browser: sees both folders and the paper, the translation with **0** upstream translation calls and
   0 browser `/v1/messages`, **no** highlight marks or notes of 김간호사.
9. 이간호사 highlights her own sentence (green, `people/<이>/…`), deletes the paper → one question → tombstone
   `deletedBy: 이간호사`, PDF / translation / 김간호사's notes kept.
10. 김간호사: 휴지통 row "이간호사 · 오늘 hh:mm 삭제 · 30일 남음" → 복구 → back in ‘ICU 섬망’.
11. 최근 활동: 박진수 폴더 복사, 김간호사 폴더 만듦 · 논문 추가, 번역, 복구, 이간호사 논문 삭제; the API answer has no codes,
    person ids or e-mails.
12. Same moment: 김간호사's ref update is held at the fake GitHub while 이간호사's commit lands; released, it gets
    GitHub's 422 through the Worker → her engine re-pulls, merges library.json and retries (→ 200); both new folders
    and everything before them survive, both sidebars show both.
13. 이간호사 on a second fresh browser (same code): her green highlight is there, 김간호사's is not; her device's
    IndexedDB has no `people/<김>/` path; 0 translation calls.
14. Team repo: no blob, id, title or file name of the 내 서재-only paper (cohen1960) in any object or commit; the
    personal repo has no 공용 서재 files.
15. No invite code in any git object of the team repo, nor in any request the fake GitHub received (headers, URL,
    body); every team-repo request carried `TEAM_GITHUB_TOKEN`, `User-Agent: paper-relay`, API version 2022-11-28 and
    no browser headers.
16. `people/` isolation through the Worker: each person's recursive listing shows only their own `people/<id>`; the
    `people/` tree lists only the caller; 이간호사's subtree asked for by its sha → 404; 김간호사's device has no file of
    이간호사.
17. Every browser → Worker `/shared` request: no 401/403/404/413/5xx; statuses 200/201/304, 409 (empty repo before the bootstrap) and 422 (step 12) only.
    Requests Chromium reports as cancelled (`net::ERR_ABORTED`) are listed, not failed: a 304 has no body, and in some
    runs the second device's PDF download is reported cancelled after its 200 answer while the reader opens the paper
    normally (no second request is made).

## Security hardening (adversarial review, 2026-10-19)

The Worker's shared proxy was reviewed as an open proxy any invite-code holder can drive. Fixes, all with
regression tests in `relay/test/shared*.test.mjs` (see SHARED.md §5 for the enforced rules):

- **Blob reads authorised** (`getBlob` → `blobVisible`): a blob is served only when the caller was shown it (a path
  visible to them in the current / last-10-min head, a recent level-by-level listing, or their own upload); other
  people's `people/<other>/` blobs are never served even with a guessed/leaked sha, and such a read is not forwarded.
- **library.json may not drop records** (`createTree` + `compareLibraries`): a folder/paper the base had cannot vanish
  from the new file — deletes must be tombstones (휴지통). This removes the "wipe with no recoverable trail" path.
- **Hidden-summary spoofing blocked** (`createCommit` + `summariseBatch`): a loud change cannot be labelled with a
  summary the app hides; it gets the Worker's own `공용 서재 변경: …`. Genuine own-notes / progress commits keep theirs.
- **File-count cap** (`maxFiles`, default 50 000): stops filling the repo (and GitHub's tree) cheaply with tiny files.
- **Purge is history-proof** (`confirmedPurgeIds` + `commitBefore`): a client-written, back-dated `deletedAt` no longer
  rushes permanent deletion; only tombstones already 30 days old in an actually-old commit are purged.

Refuted (no change): invite codes / `TEAM_GITHUB_TOKEN` / `ADMIN_TOKEN` never cross (leak tests pass); route, path,
encoding, lookalike, symlink/submodule and traversal rules already reject escalation; force-push / history rewrite are
already refused; the UI builds every name/title/activity string with `el()` text nodes and `.textContent`/`.title`
(model output goes through DOMPurify), so names/titles/activity cannot inject HTML.

## Known limits

- **No per-code rate limit on the shared proxy.** A valid code can make many proxy requests; each is a GitHub
  subrequest, so one code could burn the Worker's GitHub rate limit or the free-plan request budget (a denial of
  service, not a data leak or a cheap size-exhaustion — those are capped). Per-code throttling would need a D1 write
  per request; it is not added here. GitHub's own rate-limit answers still pass through.
- **personId** is 64 bits of SHA-256 over a code with 40 bits of entropy: whoever sees a personId can find the code
  by brute force. The Worker hides other people's ids in listings, commit messages and activity; the owner sees them
  in the repo. A later revision could use an HMAC with a server secret (would change every personId → new paths).
- Size cap is approximate (concurrent uploads can overshoot `maxBytes`; JSON files always save so deletes work).
- Worker caches are per isolate; at GitHub's truncated-tree limit (≈100k entries) a level-by-level walk that crosses
  isolates can 404 once and is retried on the next sync. CPU time on the free plan for big listings not measured.
- 즐겨찾기 / 최근 읽음 in 공용 서재 do not follow a person to another device.
- A folder made inside the copy dialog stays even when the copy is cancelled.
- A reader recomputing a paper's progress counts writes them to the shared library.json once (`논문 정보 갱신`,
  hidden in 최근 활동).
- A stopped (중지) code is refused at once (401) for 공용 서재 too, but what that person already downloaded stays on
  their device, and their `people/<id>/` files stay in the repo.
- 최근 활동 reads the last 50 commits; older history is only in the repo.
