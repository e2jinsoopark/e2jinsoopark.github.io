# Shared team library ("공용 서재") — contract

Decisions by the owner (2026-10-19):
- **One** shared library for everyone who has an invite code (designed so more libraries can be added later).
- **Everyone is equal**: any invite-code user can create/rename/move/delete folders and add/move/delete papers.
- **Shared**: folders, papers (PDF), translations. **Per person**: highlights/notes (annotations), AI data (summary, chat,
  explanations, key points).
- Safety nets because everyone can delete: **휴지통** (tombstoned items restorable for 30 days; PDFs are kept until
  purge), **최근 활동** (who added/moved/deleted what), and the git history of the team repo.
- The owner keeps "내 서재" (their personal GitHub repo, unchanged) and can **copy** papers/folders into 공용 서재.
- Invitees see 공용 서재 by default.

## 1. Storage: a private GitHub repo behind the relay

Team repo: `dindoopark/paper-team-library` (private, created). The Worker holds a fine-grained token for it
(secret `TEAM_GITHUB_TOKEN`, Contents read/write on that repo only). Browsers never see that token; they
authenticate to the relay with their invite code. The app re-uses its existing local-first `SyncEngine` +
`GitHubClient` + merge rules by pointing a second GitHubClient at a GitHub-API-compatible proxy on the relay.

Repo layout (same as the personal repo, plus a per-person area):
```
library.json                                   shared (folders, papers, tombstones)
papers/<paperId>/paper.pdf                     shared, immutable
papers/<paperId>/translation.json             shared (union-merged)
people/<personId>/papers/<paperId>/annotations.json   per person
people/<personId>/papers/<paperId>/ai.json            per person
README.md
```
`personId` = first 16 hex chars of SHA-256(invite code, normalised). Never put the code itself in a path.
(As built: HMAC-SHA-256 with `PERSON_ID_SECRET` when that secret is set; "normalised" = the code as stored — `PR-XXXX-XXXX`,
or an owner-chosen code as the owner spelled it, e.g. `EICU2-2026` — so every spelling of a code, and everyone sharing a
group code, is one person. `docs/RELAY.md` §4. Since code deletion, 2026-10-19: a code made from then on also mixes in
its own random salt (`codes.person_salt`), so a custom code deleted and made again is a new person; older codes keep
their saltless id. `docs/RELAY.md` §5.)

## 2. Relay additions (`relay/`)

Config: vars `SHARED_LIBRARIES` = JSON `[{"id":"team","name":"공용 서재","repo":"dindoopark/paper-team-library","branch":"main","maxBytes":4000000000}]`,
`GITHUB_API_BASE` (default `https://api.github.com`; tests point it at `tests/store/fake-github.mjs`). Secret `TEAM_GITHUB_TOKEN`.
Access: every **active** invite code may use every library in `SHARED_LIBRARIES` (a `code_libraries` table can restrict
this later — design the code so adding it is local). Auth header: the invite code as `Authorization: Bearer <code>`
(that is what GitHubClient sends as its token).

### 2.1 GitHub-compatible proxy: `/shared/<lib>/gh/...`
The client uses `apiBase = <relay>/shared/<lib>/gh`, `owner = 'team'`, `repo = 'library'`. The Worker accepts ONLY these
routes (anything else → 404 in GitHub's JSON error shape) and maps `/repos/team/library/...` to the real repo:

| Method & path (after `/shared/<lib>/gh`) | Rule |
|---|---|
| `GET /repos/team/library` | Return a sanitised repo object: `{ name, full_name: 'team/library', private: true, visibility: 'private', default_branch, permissions: { pull: true, push: true } }` |
| `GET /repos/team/library/git/ref/heads/<branch>` | pass through (incl. `If-None-Match` / `ETag` / 304) |
| `GET .../git/commits/<sha>` | pass through |
| `GET .../git/trees/<sha>[?recursive=1]` | pass through but **remove every entry under `people/` except `people/<me>/`** (also the `people/<other>` tree entries themselves) |
| `GET .../git/blobs/<sha>` | pass through (raw media type honoured). Blob shas of other people's files are never listed, so they are not discoverable |
| `POST .../git/blobs` | stream through; reject bodies > 100 MB; when adding a PDF would push the library over `maxBytes` → 413 Korean message |
| `POST .../git/trees` | **must** have `base_tree` equal to the current head's tree (or a tree the client got from this proxy in the last 10 min). Every entry path must match the allowlist: `library.json`, `papers/<id>/paper.pdf`, `papers/<id>/translation.json`, `people/<me>/papers/<id>/(annotations|ai).json`. Deletions (`sha: null`) allowed only under `people/<me>/`. `<id>` = `[A-Za-z0-9_-]{1,64}`. Otherwise 403 Korean message |
| `POST .../git/commits` | `parents` must be exactly `[current head]`; the Worker rewrites `message` to `[<code name>] <original first line>` (keep it ≤ 200 chars) |
| `PATCH .../git/refs/heads/<branch>` | `force` must be false; pass through (422 non-fast-forward passes through unchanged) |
| `POST .../git/refs` | only when the branch does not exist yet |
| `PUT .../contents/README.md` | only when the repo is empty (bootstrap) |
Never forward the invite code; inject `Authorization: Bearer <TEAM_GITHUB_TOKEN>`, `Accept`, `X-GitHub-Api-Version: 2022-11-28`,
`User-Agent: paper-relay`. Pass rate-limit headers through. CORS as for the rest of the relay (+ `If-None-Match` allowed,
`ETag` exposed).

### 2.2 Other shared endpoints
- `GET /shared` → `{ libraries: [{ id, name }], personId, name }` for the calling code.
- `GET /shared/<lib>/activity?limit=50` → `{ items: [{ ts, who, summary }] }` from the repo's recent commits
  (who = the `[name]` prefix; never expose emails or tokens).
- Admin (`Authorization: Bearer <ADMIN_TOKEN>`): `GET /relay/admin/shared/<lib>/stats` → `{ bytes, papers, people }`;
  `POST /relay/admin/shared/<lib>/purge` → server-side commit that deletes `papers/<id>/*` of papers tombstoned more than
  30 days ago (and removes those tombstones' files only; tombstone records stay in library.json).

## 3. App changes

### 3.1 Store (`js/store/*`)
- `Library.open()` gains an options object so several libraries can coexist:
  `{ id: 'mine' | 'shared:<lib>', label, dbName /* IndexedDB name, e.g. 'paper-reader-shared-team' */, getConfig /* () => github cfg incl. apiBase */,
     personalPrefix /* '' for mine, 'people/<personId>/' for shared */, retainPdfOnDelete /* true for shared */, shared: boolean }`.
  The existing personal library keeps its current DB name and behaviour (no migration).
- Paths: `annotations` and `ai` files live at `${personalPrefix}papers/<id>/<kind>.json`; `paper.pdf` and
  `translation.json` stay shared. Merge rules unchanged.
- `retainPdfOnDelete`: deleting a paper/folder only tombstones; files stay. New `Library.trash()` → tombstoned folders and
  papers with `deletedAt`, `deletedBy` (name), and `restore(id)` that un-tombstones (and the parent folder if needed).
  Tombstone records gain `deletedBy` (from the relay `name` for shared, '나' for mine).
- `Library.copyPaperTo(otherLibrary, paperId, { folderId })` and `copyFolderTo(otherLibrary, folderId, { parentId })`
  (recursive; copies PDF + translation.json; never personal files; keeps titles/meta; skips papers whose PDF sha256
  already exists in the target, mapping them into the target folder instead).
- `db.js`: support multiple database names.

### 3.2 UI
- Library sidebar: two sections — **내 서재** (existing tree) and **공용 서재** (shown when a relay invite code is saved;
  for invitees it is selected by default). Each section has its own folder tree, counts, sync chip, 휴지통 and (for shared)
  최근 활동.
- Routes: `#/paper/<id>` (내 서재, unchanged) and `#/s/<lib>/paper/<id>` (공용 서재); `#/s/<lib>` opens the shared library;
  `#/s/<lib>/trash`, `#/s/<lib>/activity`.
- Paper/folder context menus in 내 서재: **공용 서재로 복사…** (choose target folder). In 공용 서재: the normal actions
  (everyone equal). Deleting in 공용 서재 asks once ("휴지통으로 이동합니다. 30일 안에 복구할 수 있습니다").
- 휴지통 view: items with who/when, **복구**; admin (owner with admin token) also sees **30일 지난 항목 비우기**.
- 최근 활동 view: list from `/shared/<lib>/activity`.
- Reader works unchanged with either library (ctx.library is the library the paper belongs to). In 공용 서재 the reader shows
  a small badge "공용 서재 · 번역은 모두와 공유, 메모는 나만".
- Settings → GitHub 동기화 stays for 내 서재; a short 공용 서재 status block shows the connected team library and person name.

## 4. Tests
Relay: unit + http tests against `tests/store/fake-github.mjs` (GITHUB_API_BASE) — path allowlist, people/ filtering, base_tree
and parents rules, force=false, size cap, activity, admin stats/purge, wrong/disabled code. App: store unit tests for options,
paths, trash/restore, copy; browser e2e: owner (personal fake repo + shared), invitee A and invitee B on fresh contexts —
A creates folders, uploads, translates (mock / fake Anthropic), annotates; B sees folders/papers/translation instantly reused
(0 translate calls) but NOT A's notes; B deletes a paper → A sees it in 휴지통 with B's name → A restores; owner copies a folder
from 내 서재 into 공용 서재; activity lists the actions with names.

## 5. As built (integration, 2026-10-19)

Verified end to end with the real Worker (`tests/shared-e2e/run.mjs`; details in `docs/notes/shared.md`). Precisions on
top of §1–§4:
- **One library for all codes.** Every active code opens the same library (`team`); `GET /shared` lists libraries only
  while `TEAM_GITHUB_TOKEN` is set. Restricting libraries per code is local to `librariesFor()` in `relay/src/shared.js`.
- **Conflict vs refusal.** A stale or unknown `base_tree` and a single parent that is not the head → **409** (the client
  re-pulls, merges and retries, like a 422 on the ref). Rule violations → **403** (missing `base_tree`, wrong parent
  count, paths, other people's files, PDF changes, deletions outside `people/<me>/`, `force`, unknown body keys).
  "A tree the client got in the last 10 min" = the tree of a commit that was the head within 10 min (first parents
  walked back, ≤ 20 commits).
- **Commits** must use a tree this person created through the proxy on top of that head's tree (D1 table
  `shared_trees`, so the deploy re-runs `schema.sql`); otherwise a stale tree could revert other people's files.
  `POST git/refs` likewise needs a parentless commit of a tree this person built without a base.
- **Allowlist is exact:** `README.md` only through the empty-repo bootstrap (`PUT contents/README.md`), never in a tree;
  an existing `paper.pdf` cannot get different bytes; only files (mode `100644`, blob) — no inline content, symlinks
  or subtrees.
- **Size cap:** blobs that look like a PDF, or are over 8 MB, are refused with 413 (Korean) when they would push the
  head tree past `maxBytes` (size ≈ Content-Length × 3/4); JSON always saves. `POST git/blobs` without
  Content-Length → 411; bodies over 100 MB → 413; refused bodies are read before answering.
- **File-count cap (security):** a library also has `maxFiles` (default 50 000) checked on `POST git/trees` from the
  base tree's file count plus this batch's net additions → 403 (Korean) when exceeded, so one code cannot fill the repo
  (and GitHub's tree) cheaply with countless tiny per-paper JSON files.
- **Blob reads are authorised (security):** `GET git/blobs/<sha>` serves a blob only when it sits at a path visible to
  the caller in the current (or a last-10-min) head tree, was listed to them level-by-level in the last 10 min, or was
  uploaded by them; otherwise 404, and GitHub is not asked for it. Other people's `people/<other>/` blob shas are never
  listed anyway — this closes the gap of a sha learned some other way.
- **Blobs named in a tree are proven (security, 2026-10-19):** every blob sha in a `POST git/trees` must be one the
  caller uploaded through **this** library (this isolate's memory, else a D1 `shared_trees` row with
  `lib = 'blob:<lib>'`, kept 1 h) or one already at a path visible to them in it (base tree, or listed level by level);
  otherwise **409** "이 서재에 올린 기록이 없는 파일이 있어…", decided before GitHub (or the Worker) touches the blob — the
  same answer whether or not the repo has it. GitHub accepts any blob of the repo in a tree, so without this a tree
  would tell whether another library (or the history) holds a file whose bytes one can guess (a published PDF), and
  copy another library's file in by its sha. The app re-uploads a blob after 45 min (`js/store/sync.js`).
- **library.json integrity (security):** `POST git/trees` parses the new `library.json` (and the base's) as the client
  does; a record (folder or paper) present in the base may not vanish from the new file → 403 (Korean). Deletes must be
  tombstones (휴지통, restorable 30 days); nothing is wiped without a recoverable trail. A corrupt `library.json`
  (unparseable, not the list shape, or ≥ 32 MB) → 422.
- **GET git/commits** returns only sha, tree, parents, the scrubbed message and dates (no names or e-mails).
  Person ids (`people/<16 hex>`) and invite codes are scrubbed from every commit message and activity line.
- **Errors from GitHub:** the team token refused (401, non-rate-limit 403) → 502 with a Korean message naming
  `TEAM_GITHUB_TOKEN`; a repo that is not private, or no token → 503; rate limits pass through with their headers.
- **Admin:** stats also return `maxBytes`; purge returns `{ purged: [paperId], files, freedBytes, commitSha }` and also
  deletes everyone's `people/*/papers/<id>/*` of the purged papers (commit `[관리자] 휴지통 비우기: …`).
- **Purge is history-proof (security):** a tombstone's `deletedAt`/`updatedAt` is client-written, so purge also reads
  `library.json` as of the newest commit at least 30 days old (GitHub committer dates): a paper is purged only when it
  was already tombstoned there with the same deletion time. A fresh tombstone with a back-dated `deletedAt`, or any
  paper when no commit is yet 30 days old, is kept — so a client cannot rush the permanent deletion of a paper and
  everyone's notes on it.
- **Activity cannot be spoofed quiet (security):** the commit message becomes the 최근 활동 line, so a client may use a
  summary the app hides (`내 메모·AI 결과 동기화`, `논문 정보 갱신`) only when the tree really is that quiet — no new/changed
  translation or PDF, nothing outside the layout, any `library.json` change limited to progress counts (one's own
  `people/<me>/` files are always hidden). A loud change labelled with a hidden summary gets the Worker's own visible
  summary (`공용 서재 변경: …`). `who` is null for commits not made through the proxy. The same two strings are the app's
  `QUIET_ACTIVITY` in `js/ui/library-view.js` — keep the two lists identical.
- **Store:** the database is `paper-reader-shared-<lib>-<personId>` (per person). Papers also carry `sha256` (copy
  dedupe) and, in 공용 서재, `addedBy`. A copied PDF the target already has is not uploaded again; that paper is moved
  into the chosen folder and gains the sentences it lacks. Shared commit messages describe the batch in Korean.
- **UI:** also `#/trash` (내 서재's 휴지통: folders only, since 내 서재 deletes a paper's files). 즐겨찾기 and 최근 읽음 in
  공용 서재 are per person and per browser. Settings → 공용 서재 is `#set-shared` (`#/settings/shared`).
- **Deleting an invite code (2026-10-19, `docs/RELAY.md` §5):** the Worker removes everything under that code's
  `people/<personId>/` in every library (one `[관리자] 초대 코드 삭제에 따라 개인 기록 정리` commit per library that has such
  files; 최근 활동 shows who `관리자`), then the code. Shared files (`library.json`, PDFs, translations) stay. GitHub
  unreachable → 502 and the code stays (no orphaned notes). The holder's devices forget the code on the next 401.

## 6. Code libraries (2026-10-19)

Owner: "초대코드별로 초대코드만의 [공용서재]가 보이게". Every invite code now also has its **own library** ("<code name>
서재", URL id `mine`, repo folder `codes/<libraryId>/` of the same team repo), seen only by that code's holders; the
library of §1–§5 stays as **전체 공용 서재** (`team`). This changes, on top of §1–§5:
- `GET /shared` → `{ libraries: [{ id: 'mine', name: '<code name> 서재', kind: 'code' }, { id: 'team', name: '전체 공용 서재',
  kind: 'team' }], personId, name, libraryId }`.
- Commit messages carry a library marker (`[name] {lib:team|<libraryId>} …`) that only the Worker writes and never sends to
  the app; 최근 활동 is per library.
- Invitees land in their code library; the copy menu is **다른 서재로 복사…** between any two libraries.
- `DELETE /relay/admin/codes/:code` takes `?library=delete|move&to=<code>`; a one-time admin migration splits the papers
  already in 전체 공용 서재 into their uploaders' code libraries.
Design, migration and deploy order: [`docs/CODE-LIBRARIES.md`](CODE-LIBRARIES.md).
