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
