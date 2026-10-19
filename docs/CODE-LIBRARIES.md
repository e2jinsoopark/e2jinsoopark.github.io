# Code libraries ("<name> 서재" per invite code) — design, migration, deploy

Owner's request (2026-10-19): "[공용서재]의 개념은 좋은데 다들 자기 논문들 보이는 게 싫을 수 있어서 초대코드별로 초대코드만의
[공용서재]가 보이게 가능해? 지금도 이미 공용서재에 두 개의 초대코드 사람이 1개씩 올려놨는데, 이것도 자동으로 분류해주나?"

Decisions (owner):
- **Every invite code gets its own library**, "<code name> 서재", seen only by the holders of that code. Several people
  sharing one code share its library (and its notes, as before).
- The library everyone with a code sees stays, renamed **전체 공용 서재**.
- Deleting a code asks what happens to its library: **delete it with the code** (default) or **move it to another code**.
- The papers already in the shared library are sorted by an **admin migration** (plan first, then apply), not silently.

Builds on [`SHARED.md`](SHARED.md) (the shared library and its proxy rules) and [`RELAY.md`](RELAY.md) §5 (code deletion).
Korean, for the owner: [`README.md`](../README.md) › 공용 서재, [`relay/README.md`](../relay/README.md) › 코드별 서재.

## 1. Storage: one repo, two kinds of library

Everything stays in the private team repo `dindoopark/paper-team-library`, behind the same Worker token.

```
library.json, papers/<paperId>/…, people/<personId>/…        전체 공용 서재 (lib 'team')  — every active code
codes/<libraryId>/library.json                                 one code's library (lib 'mine') — only its holders
codes/<libraryId>/papers/<paperId>/{paper.pdf,translation.json}
codes/<libraryId>/people/<personId>/papers/<paperId>/{annotations,ai}.json
README.md                                                      bootstrap of an empty repo (root only)
```

- `libraryId` = 16 random hex, D1 `codes.library_id` (unique index `codes_by_library`). A code made after this update gets
  one at creation; an older code gets one the first time it is needed (its first `GET /shared`, the split, or as the
  target of a move). Like `person_salt`, the columns (`library_id`, `library_max_bytes`) are added to an existing
  database by the Worker itself (`relay/src/db.js ensureCodeColumns`), so `schema.sql` stays re-runnable.
- Inside a code library the rules are exactly the team library's, under the prefix: shared `library.json`, immutable
  PDFs, deletes only as tombstones (휴지통), `people/<me>/` per person.

## 2. Relay (`relay/src/shared.js`, `shared-paths.js`, `code-libraries.js`)

| | `/shared/team/gh/…` (전체 공용 서재) | `/shared/mine/gh/…` (the caller's code library) |
|---|---|---|
| library root | `''` | `codes/<the caller's libraryId>/` |
| listings (recursive and level by level) | everything except `codes/` and other people's `people/<x>` | only the way down (`''`, `codes`, `codes/<id>`) and what is under the root, minus other people's `people/<x>` |
| writes (`POST git/trees`) | team allowlist; anything under `codes/` → 403 | the same allowlist, every path prefixed with the root; anything else → 403 |
| blobs named in a tree | uploaded **by this person through this library** in the last hour (isolate memory, else D1 `shared_trees` `lib = 'blob:team'`), or at a path visible here; else 409, decided before GitHub sees the sha | same, `lib = 'blob:code:<libraryId>'` |
| blob reads | a blob at a path visible here, listed here recently, or uploaded **by this person to this library** | same |
| trees made here (`shared_trees.lib`) | `team` | `code:<libraryId>` — a tree made through one library cannot be committed through the other |

- The client keeps its library's own paths everywhere (IndexedDB keys, events, commit descriptions); only
  `GitHubClient({ rootPrefix })` adds `codes/<libraryId>/` to repo paths. `base_tree`/parents are the whole repo's head:
  both libraries move the same branch, and a push that lost the race gets 409/422 and is retried as before.
- **`GET /shared`** → `{ libraries: [{ id: 'mine', name: '<code name> 서재', kind: 'code' }, { id: 'team', name: '전체 공용 서재',
  kind: 'team' }], personId, name, libraryId }`. There is no URL for another code's library.
- **Commit messages** are `[<name>] {lib:team} …` or `[<name>] {lib:<libraryId>} …`; a server commit that changes several
  libraries has one `{lib:…} …` line per library. The marker is written only by the Worker (a client's marker is
  dropped), `GET /shared/<lib>/activity` returns only that library's lines (reading up to 3 pages of 100 commits), and no
  answer to the app carries it: `GET git/commits` of another library's commit has an empty message. Commits without a
  marker (made before this update) belong to 전체 공용 서재.
- **Size caps**: each code library has its own cap (`CODE_LIBRARY_MAX_BYTES`, default 500 MB; per code
  `PATCH /relay/admin/codes/<code>/library { maxBytes }`) on top of the repo-wide `maxBytes`. Over it a PDF gets 413
  "<name> 서재의 저장 공간이 부족해…".
- **Purge** (`POST /relay/admin/shared/team/purge`, 휴지통 → 30일 지난 항목 비우기 in 전체 공용 서재) empties the 휴지통 of every
  library in the repo, one 최근 활동 line per library.

## 3. App

- **Store** (`js/store/*`, [`docs/notes/store.md`](notes/store.md) › Code libraries): `Library.open({ rootPrefix })`;
  `openSharedLibrary({ lib: 'mine', libraryId })` → apiBase `<relay>/shared/mine/gh`, rootPrefix `codes/<libraryId>/`,
  IndexedDB `paper-reader-shared-mine-<libraryId>-<personId>` (전체 공용 서재 keeps `paper-reader-shared-team-<personId>`).
  `mergeLibrary` with a base drops a record the base had and one side no longer has: clients only tombstone (and the
  relay refuses a push that drops a record), so such a record was moved out by the split, and a device with an
  unsaved edit must not push it back.
- **Sidebar** (`js/ui/library-view.js`): 내 서재 (only when it has papers or folders, for the owner, or when opened on
  purpose), then **<name> 서재** (lock icon, `#/s/mine…`; an invitee's `#/` lands here until they use another one, uiState
  `homeLibrary`), then **전체 공용 서재** (`#/s/team…`). Each has its tree, counts, sync chip, 휴지통 and 최근 활동. An empty code
  library says "이 초대 코드를 가진 사람만 볼 수 있어요.".
- **다른 서재로 복사…** on every paper and folder (and drag onto another library): a picker of the other open libraries,
  then the folder. PDF + translation only, deduplicated by sha256; notes, AI results and stars never travel.
- **Reader badge**: "<name> 서재 · 이 코드만 보는 서재" or "전체 공용 서재 · 번역은 모두와 공유, 메모는 나만".
- `js/features/annotations.js` now reloads on the library's own annotation path (`library.dataPath`), so a highlight
  made on another device of the same code shows without reopening the paper (also in 전체 공용 서재).

## 4. Deleting a code (`DELETE /relay/admin/codes/<code>?library=delete|move&to=<code>`)

설정 → 초대 코드 관리 → 삭제 → the dialog shows the code library's paper count (`GET /relay/admin/codes/<code>/library`) and
two choices: **서재도 함께 삭제** (default, `library=delete`) or **다른 코드로 옮기기** + a list of the other codes
(`library=move&to=<code>`, the button reads 옮기고 삭제).

- `delete`: every file under `codes/<A>/` goes.
- `move`: `codes/<A>/**` moves to `codes/<B>/`: library.json records merged by id (folders and papers keep their ids; a
  clashing id gets a new `f_…`/`p_…` id and every reference follows), files moved with the (new) ids, and the deleted
  holder's notes (`people/<pA>/…`, salted and saltless ids) become B's holder's (`people/<pB>/…`), so giving a person a
  new code keeps their library and notes.
- In the same commit: the holder's notes in 전체 공용 서재 are removed (as before). One server commit for the repo, made
  after every other `SHARED_LIBRARIES` repo is clean; any GitHub failure → 502 and the code library is untouched (the
  code is switched on again); then the D1 rows go.
- Answer: `{ deleted: true, purgedFiles, library?: { action, papers, files, renamed? } }` (`library` only when the code's
  library had files). Bad `library` / missing `to` / `to` = itself → 400; unknown `to` → 404.

## 5. Migration: split 전체 공용 서재 by uploader (admin, once)

`POST /relay/admin/shared/team/split-by-uploader { dryRun }` — in the app: 설정 → 초대 코드 관리 → **전체 공용 서재 논문을 올린
사람 서재로 나누기** (the plan in a dialog first, then **N편 옮기기**).

A paper moves when it is **not in the 휴지통** and its `addedBy` equals the name of **exactly one** existing code (active or
stopped). For each:
- its `papers/<id>/*` (PDF, translation) and that code holder's `people/<p>/papers/<id>/*` notes move into
  `codes/<libraryId>/`, the notes under the holder's current personId;
- its record is copied into the code library's library.json, inside folders of the same names and nesting (a live
  folder with that name at that place is reused), and **removed** from the team library.json (a move, not a tombstone);
- folders the moves left empty in 전체 공용 서재 are tombstoned (`deletedBy` 관리자, restorable for 30 days).

Stays in 전체 공용 서재: papers in the 휴지통, papers whose uploader matches no code or several codes, papers without
`addedBy`, and other people's notes on a moved paper (kept, no longer reachable in the app). The dry run answers
`{ moves: [{ paperId, title, toCode, folderPath }], skipped: [{ paperId, title, reason }] }` and writes nothing; the apply is
one commit `[관리자] {lib:team} 올린 사람의 코드 서재로 나누기` (+ one `{lib:<id>} 전체 공용 서재에서 논문 N편 옮겨 옴` line per
receiving library) and adds `commitSha`. A second run finds nothing to move.

Production today (2026-10-19) — codes NV, 6기, 봄당, 봄당테스트 (stopped), 관리자 비교테스트; 전체 공용 서재 with folder 찬영:

| paper | addedBy | result |
|---|---|---|
| Lessons in biostatistics | 봄당테스트 | stays (in the 휴지통) |
| Moral Sensitivity in Psychiatric Practice | 봄당 | → 봄당 서재, top level, with 봄당's highlights and AI results |
| Procedures Performed by Advanced Practice Provider | 6기 | → 6기 서재, folder 찬영, with 6기's AI results |
| (folder 찬영) | | empty → 휴지통 of 전체 공용 서재 |

## 6. Deploy order (owner, once)

In `relay/` (Korean click path: [`relay/README.md`](../relay/README.md) › 코드별 서재):

1. `npx wrangler d1 execute paper-relay --remote --file schema.sql` — harmless; the new `codes` columns and the
   `codes_by_library` index are added by the Worker itself when first needed.
2. `npx wrangler deploy` — **the Worker first**. (`SHARED_LIBRARIES` now names the team library 전체 공용 서재;
   `CODE_LIBRARY_MAX_BYTES` is 500 MB.)
3. Check: `curl -H "Authorization: Bearer <a code>" https://paper-relay.<account>.workers.dev/shared` → `libraries` lists
   `mine` and `team`, and `libraryId` is 16 hex.
4. Publish the app right after (push to `main`; GitHub Pages). Until then an open old app shows "<name> 서재" as an
   empty library whose saves the Worker refuses (403, nothing is written); a reload with the new app fixes it.
5. Let colleagues' open apps reload once (an old app with an unsaved library edit could otherwise put a moved paper's
   record back into 전체 공용 서재 without its files).
6. In the published app: 설정 → 초대 코드 관리 → **전체 공용 서재 논문을 올린 사람 서재로 나누기** → check the plan (today:
   2 moves, 1 skipped) → **2편 옮기기**. (Same as `POST /relay/admin/shared/team/split-by-uploader` with
   `{"dryRun":true}`, then `{"dryRun":false}`.)

Rollback (`npx wrangler rollback`) keeps the data intact (the old Worker refuses writes under `codes/`: they are outside
its layout), but it does **not** keep code libraries private: the old Worker does not hide `codes/` from 전체 공용 서재's
listings, so every code could read every code library through it, and the app would not show them. Roll back only
briefly, or not after the split.

## 7. Tests

| Command | Ports | What |
|---|---|---|
| `node tests/code-libs/run.mjs [--headed]` | 8243–8245, 8787 | **Real app + real Worker** on a D1 shaped like production (legacy schema, five codes, no library ids) and a team repo seeded as production is today; scenario below |
| `node relay/test/run.mjs` (suites `code-libs-unit`, `code-libs`, …) | 8787–8789, 8792 | Worker: isolation (reads, writes, fresh uploads), markers and activity, caps, delete/move, split, purge |
| `node tests/store/code-libs.test.mjs`, `run-code-libs.mjs` | –, 8241 | store: rootPrefix, lib 'mine', copies across three libraries, merges after a split |
| `node tests/shared-ui/code-libs.mjs` | 8242 | UI details (sidebar, copy picker, dialogs, dark, 390 px) against the fake relay |

`tests/code-libs/run.mjs` (13 steps; any console error, page error, CSP violation, native dialog, request outside the app /
Worker / jsDelivr SDK, `{lib:` in an answer to the app, or invite code reaching GitHub fails the run):
1. The Worker adds `library_id` on NV's first `GET /shared` → `[NV 서재 (code), 전체 공용 서재 (team)]`; 봄당테스트 (stopped) 401.
2. 봄당 joins → `#/s/mine` "봄당 서재" (empty line), no 내 서재; highlights and summarises Moral in 전체 공용 서재.
3. 6기 summarises Procedures (in 찬영); NV highlights Moral (green) and sees none of 봄당's notes.
4. Owner: the split dialog shows exactly Moral → 봄당 서재 · 최상위, Procedures → 6기 서재 · 찬영, Lessons skipped (휴지통에
   있음); nothing written; apply → one 3-line commit; 찬영 tombstoned by 관리자; NV's note stays at the root.
5. 봄당: Moral in 봄당 서재 with the old yellow highlight (not NV's green) and the summary, badge "봄당 서재 · 이 코드만 보는
   서재"; 전체 공용 서재 empty; the Worker lists 봄당 only `codes/<봄당>/`.
6. 6기: 찬영 / Procedures in 6기 서재 with its summary.
7. 봄당 uploads cohen1960 to 봄당 서재 → 6기 and NV see it nowhere (UI, Worker listings, blob → 404 through both endpoints).
8. 봄당 → 다른 서재로 복사… → 전체 공용 서재 (same blob, no notes) → 6기 and NV see it.
9. 최근 활동: 봄당 서재 = 봄당's upload + 관리자's move-in line; 6기 서재 = its move-in line; 전체 공용 서재 = the split, the copy
   and the old lines, never a code library's line.
10. Delete 봄당 → 다른 코드로 옮기기 → NV ("논문 2편" in the dialog): one commit; NV 서재 has both papers, NV sees the yellow
    highlight and the summary in Moral.
11. Delete 6기 with 서재도 함께 삭제 ("논문 1편"): `codes/<6기>/` gone in one commit; root files unchanged.
12. A code named `<img src=x onerror=…>` joins; its sidebar and empty line show the name as text; it adds a folder named
    `<b onmouseover=…>폴더</b>{lib:team}` to 전체 공용 서재 → NV's sidebar and 최근 활동 show both as text, the marker is
    dropped from the commit, nothing runs.
13. No problems, no refused `/shared` request, no code in any GitHub request.

Found and fixed at integration: the Worker's "uploaded by this person" memory for blob reads was per repo, not per
person — a blob just uploaded to one code's library could be read by any code that asked for its sha (also through
전체 공용 서재). It is now keyed by person and library (`TeamRepo.uploadedBy`), with a regression test in
`relay/test/code-libs.test.mjs` (isolation: fresh uploads).

### Adversarial isolation review (2026-10-19)

Tried against the Worker (`relay/test/code-libs.test.mjs`, `code-libs-unit.test.mjs`) and the app (`tests/code-libs`):

| Attack | Result |
|---|---|
| Name another library's blob in a tree (`POST git/trees` with a sha computed from a published PDF's bytes, or a leaked sha of another library's `library.json` / notes) | **Fixed.** GitHub accepted any blob of the repo: 201 for a PDF some other library (or the history) holds vs 422 for one nobody has — an existence oracle — and the Worker even read that `library.json` to compare it. Now every named blob must be uploaded by the caller through this library or visible in it (table above); one 409 for all. Test: *isolation (blob existence)* (16 probes, all the same answer, 0 GitHub reads/trees). |
| A code name of 31–40 characters outside the BMP (emoji: up to 80 UTF-16 units) | **Fixed.** `commitLines` read `[name]` only up to 60 units, so such a code's commits fell to 전체 공용 서재: its paper titles in everyone's 최근 활동 and `GET git/commits`, nothing in its own. Now up to 200. Tests: unit (commit markers), *markers: a code named with 40 emoji*. |
| Code deletion with a library when another `SHARED_LIBRARIES` repo fails | **Fixed.** The host repo went first, so a later failure left the code (switched back on) with its library already moved/deleted. The host repo now goes last. Test: *DELETE with a library: the repo that holds the code library goes last*. |
| Paths: `codes/<id>x/`, upper-case id, `..`, `./`, `//`, trailing `/`, leading `/`, `%2e%2e`, Cyrillic `о` in `codes`, `people/<me>/../<other>` | Refuted: `classifyIn` needs the exact root and the exact layout (ids `[A-Za-z0-9_-]`) → 403 (*isolation (writes)*). |
| URLs: `/shared/mine%2F..%2Fteam/…`, `/shared/MINE/…`, `%00`, `repos/Team/…`, trailing `/` or `%2F` after a sha | Refuted: no route → 404, GitHub not asked (*GET /shared*). |
| Tree shas of other prefixes (from commits, listings, history) | Refuted: a tree is listed only at a path visible to the caller in this library (the head, a head of the last 10 min, one listed to them, or one they made here), filtered by that path; same sha = same content. A commit only uses a tree this person made through this library on the head (*isolation (reads)*, *(writes)*). |
| Moving files between prefixes in one commit; deleting another library's files | Refuted: every entry must lie under the library's root; deletions only of `people/<me>/` (*isolation (writes)*). |
| `library.json` naming other libraries' ids or paths | Refuted: the Worker never resolves paths from records; the app builds `papers/<id>/…` under its own root and reads blobs only through visibility-checked reads; with the fix above a tree cannot take in another library's `library.json` either. |
| Admin endpoints with an invite code (split dry run that lists every title, delete with move, library report) | Refuted: 401, nothing in the answer, nothing reaches GitHub (*GET /shared*). |
| `{lib:…}` in a client's commit message, folder or paper title | Refuted: dropped from the client's text before the Worker writes its own marker; never at a line start (*markers and 최근 활동*, e2e step 12). |
| Another code's libraryId / personId in any answer | Refuted (*no secret crosses*); a libraryId alone would grant nothing (the Worker derives the root from the caller's own code). |
| XSS through code, library, folder names or commit lines | Refuted: the app never parses HTML (`el()` makes text nodes and refuses `html`; no `innerHTML` in `js/`) — e2e step 12 runs a markup-named code and folder. |
| Timing and aggregate size | Accepted: every library moves one branch, so commit times (not contents) of other libraries are visible as head changes; a repo-wide 413 shows the repo's total size. |

## 8. Known limits

- The split is a move: a device with an **unsaved** edit to a moved paper's notes at that moment pushes them to the old
  place (전체 공용 서재's `people/<me>/`); the code library has the version from before. Deploy step 5 keeps this rare.
- Other people's notes on a moved paper stay in 전체 공용 서재 with no record (kept, not shown).
- Code libraries have no file-count cap of their own (the repo's `maxFiles` applies) and no purge of their own: 휴지통 →
  30일 지난 항목 비우기 in 전체 공용 서재 empties every library's 휴지통.
- Every library moves the one branch: other libraries' engines re-pull (one filtered listing), and concurrent pushes
  across libraries retry on 409/422 as within one library.
- 즐겨찾기 / 최근 읽음 of a code library are per browser under the id `mine`; a paper moved by the split loses its star.
- Per-code size checks read a head up to 10 s old per isolate: the cap is approximate, like the repo-wide cap.
- With several `SHARED_LIBRARIES` repos, code deletion handles the others first (in config order, one commit each) and
  the repo holding code libraries last; production has one.
- 전체 공용 서재's 최근 활동 keeps the lines written before the split (e.g. `[봄당] 논문 추가 ‘Moral …’`): titles of papers that now
  live in a code library stay readable there (they were shared when written). Hiding them would mean hiding the team
  library's older activity as a whole — the owner's call, not done.
- An app opened before the update that uploaded a file through the old Worker and commits it through the new one gets
  409 "이 서재에 올린 기록이 없는 파일이 있어…" until it is reloaded (the new app uploads again by itself; deploy step 4
  reloads open apps anyway).
- The size caps count only blobs that look like a PDF or are over 8 MB (as before code libraries): a code holder who
  disguises files can still go past their code's cap. They are guards against accidents, not against a colleague.
