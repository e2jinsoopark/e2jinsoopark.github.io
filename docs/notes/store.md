# Store module — notes (js/store/*)

Owner files: `db.js`, `github.js`, `sync.js`, `library.js`. Tests: `tests/store/*`.
Nothing outside these was touched.

| File | Role |
|---|---|
| `db.js` | IndexedDB `paper-reader` v1: `files` (key = repo path, index `dirty`), `meta`, `blobs` (key = git sha). SPEC API plus atomic `update()`. |
| `merge.js` | The merge rules (pure functions). `sync.js` re-exports them; `features/annotations.js` uses `mergeRecords`. |
| `github.js` | `GitHubClient` (Git Data API), `GitHubError`, `GitHubConflictError`, `gitBlobSha()`. |
| `sync.js` | `SyncEngine` (local-first, debounced push, pull, merge) and the merge functions. |
| `library.js` | `Library` (SPEC §2.3 / §3.3) on top of the engine. |

## Contract additions (all backward compatible)

**db.js**: `DELETE` (sentinel), `update(store, key, fn)` (atomic read-modify-write: `fn` returns the new value, `undefined` = unchanged, `DELETE`), `indexKeys(store, index)`, `count(store, index?)`, `rewriteAll(store, fn)`, `ready()`. IndexedDB failures throw a Korean `Error` (`code: 'storage' | 'quota'`).

**GitHubClient**
- Constructor also takes `apiBase` (default `https://api.github.com`; only `https:` or loopback `http:` is accepted), `fetch`, and `rateLimitMaxWaitMs` (default 60 s).
- Getters: `owner`, `repo`, `branch`, `apiBase`, `target` (repo identity without the token).
- `checkAccess({ quick = false })` returns the SPEC fields plus `code`, `empty`, `branchExists`, `foreign`, `defaultBranch`.
  - The full check is for the 설정 screen. It creates a 0-byte blob to prove write access, because fine-grained tokens report the *user's* `permissions.push`, not the token's. It also warns (`foreign: true`) when the repo root holds unrelated files, which suggests the wrong repo.
  - `quick` skips both. The engine uses it at every sync start.
  - Results: `ok:false` for a bad token (401), not found / no access (404), 403, or network problems. `ok:true, repoPrivate:false` for a public repo, with a warning `message`. `ok:true, canPush:false` for a read-only token. On success `message` is a Korean summary, and the shell shows it as is.
- `commit(files, message, { parent, baseTree })`. A file may be `{ path, sha }` (blob already uploaded). The result also has `blobs` (path → sha).
  - With `parent: null`, an empty repo is first bootstrapped (README.md via `PUT /contents`, because the Git Data API answers 409). A repo without the branch gets `POST /git/refs`.
  - A 422 on the ref update becomes `GitHubConflictError`.
- `bootstrap()` and `createBlob(bytes)` are public.
- Errors are `GitHubError` with a Korean `message`, `code` (`auth | forbidden | not_found | rate_limit | conflict | empty | invalid | too_large | server | network | timeout | config | integrity`), `status`, `retryAt` and `transient`. `GitHubConflictError` extends it.

**SyncEngine**
- Constructor options: `createClient` and timing (`pushDelayMs` 3000, `pushMaxDelayMs` 30000, `pullIntervalMs` 120000, `retryDelaysMs` [5, 15, 30, 60, 120] s).
- `readFile(path, { as, local })`. With `local: true` it never touches the network.
- `writeFile()` resolves with what is stored. For mergeable JSON this is the merged object (see multi-tab below).
- Extra methods: `flush()` (push now), `reconfigure()`, `listPaths(prefix)`.
- `syncNow()` **never rejects** for sync failures. It resolves with `status`, and failures show up in `status` / the `'status'` event.
- `'remotechange'` detail is `{ paths, origin: 'remote' | 'tab' | 'merge' }`.

**Library**
- `Library.open({ settings, db?, sync?, syncOptions? })`.
- Extra methods: `whenSaved()` (library.json is in IndexedDB), `flush()` (save, then push now), `close()`.
- `updatePaper` / `movePaper` return the updated paper.
- `paperPath(id, file)` is exported.
- `'error'` event `{ message, error }` when saving library.json to IndexedDB fails (e.g. quota). **The shell does not listen yet; suggest a toast.**
- Returned folders/papers are **frozen snapshots**, rebuilt after each change. `folderId` / `parentId` are already resolved: a reference to a deleted folder points to its nearest live ancestor, and parent cycles from concurrent moves are broken deterministically.
- `updatePaper` ignores `id/addedAt/updatedAt/deleted/size`, validates `folderId` (must be a live folder) and `title` (non-empty), and skips no-op patches (no commit).
- **Hex-title repair (2026-10-22).** Some older uploads stored their PDF Info Title as a raw hex string, e.g. `<C3D6C1BEB3EDB9AE2E687770>`. The library replaces such a title with its decoded text (`decodePdfTitle` from `js/pdf/pdf-text.js`, here `최종논문`) or, when the bytes are not text, with the file name.
  - It checks on load and after a remote library.json arrives. No PDF is parsed.
  - The fix is written back once, with a `touch`. Tombstones are fixed too.
  - Shared libraries note `제목 복구 ‘…’` for the commit message.
  - Tested in `tests/pdf/title-decode.test.mjs`.
- `addPaper` also rejects data without `%PDF-` in the first 1 KB. `deletePaper` also deletes the paper's four files from the repo, as the UI's confirm text promises; tombstoned papers' leftover files are removed again after every remote change.

## Decisions

- **Local record** (`files` store): `{ path, data, dirty?: 1, deleted?: true, baseSha, base?, wid, mtime }`.
  - `baseSha` is the remote blob the content descends from.
  - `base` is that blob's text, kept only while dirty, for 3-way merges.
  - `wid` identifies the write, so a push never marks a newer write as clean.
- **Lazy remote.** `library.json` is downloaded on every remote change. Everything else is fetched on first `readFile`:
  - PDFs are cached in `blobs` by sha and pruned when they leave the remote tree.
  - Text files are cached as clean `files` records, so later edits have a merge base and work offline.
  - A cached clean text file is refreshed on pull.
- **Merges.**
  - *library.json / annotations.json*, per item id: newer `updatedAt` wins, and a tombstone wins a tie. When the common base version of an item is known (always after the first sync), the merge is per field: a rename on A and a move on B both survive. A delete on one side sticks even if the other side edited another field.
  - *translation.json*: union of items, local wins per sid; on a sid both sides have, the higher `segVersion` wins. Nothing is dropped wholesale: readers validate every item by its text hash.
  - *ai.json*: `chat` and `explanations` are unions by record id (time order, capped at 200 / 100); a clear sets `chatClearedAt` (max of both sides wins). Other keys: 3-way with the base (a key changed on one side only takes that side); changed on both sides → the value with the newer `createdAt`/`fetchedAt`, else the newer file's.
  - A record merged field by field from both sides gets `updatedAt = max(both) + 1`, so it supersedes both in any later merge that has no base (the in-memory library, another tab, an annotation store). Without this, a tie kept the stale side and the next write reverted the other device's change.
  - *paper.pdf* and other files: local wins.
- **Push.**
  - Debounce 3 s, at most 30 s after the first pending write, and immediately on `visibilitychange→hidden` / `pagehide`.
  - Normally one commit. A backlog over ~48 MB is split into several commits, so a failure does not throw away every upload.
  - PDFs go first and `library.json` last, so no device sees a paper before its PDF.
  - A blob whose git sha already matches the remote is not uploaded. Uploaded shas are reused across conflict retries
    for up to 45 min (`UPLOAD_REUSE_MS`: the relay accepts in a tree only blobs uploaded through that library in the
    last hour), and forgotten when the conflict retries run out, so the next attempt uploads again.
  - `README.md` is added to a commit when missing.
  - Non-fast-forward → re-pull, merge, retry (4 attempts with jitter).
- **Pull.** On start, on window focus or tab show (at most every 15 s), every 2 min (skipped while hidden unless writes are pending), on `online`, and before every push.
  - An unchanged branch costs one conditional `GET …/git/ref` answered 304 (not rate-limited).
  - A background pull that finds nothing does not flash "동기화 중".
- **Status** (`disabled | idle | syncing | error | offline`):
  - Network failure or timeout → `offline`, retried after 5 / 15 / 30 / 60 / 120 s or on `online`.
  - Rate limit → `error` with the reset time, retried then. Waits up to 60 s are slept through inside the client.
  - 5xx → retried twice in the client, then `error` with backoff.
  - Bad token, no access or permission, public repo → `error`, **no automatic retry** until 지금 동기화 or a settings change. This avoids a request storm with a revoked token.
- **Safety.**
  - Sync refuses a public repo at every start, not only on the settings screen.
  - The token goes only to `apiBase` (`credentials:'omit'`, `referrerPolicy:'no-referrer'`).
  - Downloaded blobs are verified against their git sha.
  - The raw media type is requested; the JSON/base64 envelope is accepted as a fallback.
- **Multi-tab.**
  - A Web Lock (`paper-reader-sync`) makes one tab sync at a time.
  - A BroadcastChannel tells other tabs which paths changed, so they reload (`origin:'tab'`).
  - `writeFile` merges mergeable JSON with what is already stored, so a stale tab cannot drop another tab's records.
- **Losing the page.** Library changes are written to IndexedDB immediately. If the page is hidden or closed while a write is unconfirmed, a synchronous copy goes to `localStorage['pr.store.libraryJournal.v1']`, which the next `Library.open` merges and removes. In the reload test the journal is what saved the change.
- **Switching repo** needs consent: when `meta.target` is another repo and this device has data, the engine stops with `code: 'target_changed'` (fatal, nothing uploaded) unless `settings.github.carryOver` equals the new target. `SyncEngine.targetChange(cfg)` / `Library.syncTargetChange(cfg)` tell the settings screen, which asks 올리기 / 이 기기 데이터 지우고 시작 / 취소. With consent (or when the remote branch was deleted) all local data, including PDFs only cached from the old repo, becomes pending and is pushed to the new target.
- **Stale sync base before a push**: a dirty mergeable file whose `baseSha` is not the remote's current sha (its first edit happened while the download failed, a download raced a pull, a repo switch) is merged with the remote version before it is uploaded (`#reconcileStale`). A download that finishes after a pull moved the path to a newer blob is not cached as a clean copy, and `readFile` refreshes a clean copy whose sha is behind the tree.
- **A file GitHub refuses** (413 / 422 on its blob) is marked `dirty: 2` ("rejected"), skipped, and reported (`'rejected'` event → Library `'error'` naming the paper); everything else keeps syncing. `status.rejected` counts them; 지금 동기화 retries them. `LIMITS.maxPdfBytes` is 70 MB so the base64 JSON body stays under GitHub's 100 MB.
- **Library memory** keeps `#base` (the stored version memory was last reconciled with): remote versions are absorbed 3-way (or simply replace memory when nothing is unsaved), writes pass the base to `writeFile`, and reads/writes of library.json share one chain so versions are absorbed in order. The page-hide journal stores its base too and is removed once the write it covers has landed.
- `Library.updatePaperData(id, kind, mutate)` is a read-modify-write on what is stored now (a failed read throws instead of overwriting). The reader's `saveAi` uses it. `savePaperData(id, kind, obj, { base })` stamps `updatedAt = max(now, base.updatedAt + 1)` and returns what is stored; it refuses papers that were deleted (tombstoned).
- The repo must be `visibility: 'private'` (an enterprise `internal` repo is refused); the quick check is repeated every 10 min and at most 60 s before a push. Classic `ghp_`/`repo`-scope tokens get a warning. A 422 on the ref update that names a protection rule is a fatal `protected` error, not an endless conflict.
- Blob downloads have a 60 s stall watchdog and uploads a size-based timeout (both → `timeout`, retried with backoff).
- IndexedDB request errors abort their transaction (no `preventDefault`), so a failed read can no longer resolve as "no record".
- `navigator.storage.persist()` is requested on every `Library.open` (`storagePersisted()` reports the answer; 설정 shows a warning when it was denied). A downloaded PDF that cannot be cached (quota) still opens.
- `Library.wipeLocalData()` stops sync and deletes the IndexedDB database (설정 → 이 기기의 데이터 모두 지우기).
- Commit messages are Korean, e.g. `논문 리더 동기화: library.json, papers/p_x/annotations.json 외 2개`.

## Test hooks — pointing the app at the fake server

- **Real app (`index.html`, CSP limits `connect-src` to api.github.com):** in Playwright,
  `await routeGitHubToFake(context, fake.url)` from `tests/store/fake-github.mjs`. It forwards `https://api.github.com/**` to the fake. Then just put owner/repo/token into the 설정 screen or into `localStorage['pr.settings.v1'].github`.
  - The browser is launched with `--host-resolver-rules=MAP api.github.com 127.0.0.1`, so nothing can reach the real GitHub even by accident.
- **Pages without that CSP (or `bypassCSP: true`):** set `settings.github.apiBase = 'http://127.0.0.1:<port>'`. It is persisted with the other GitHub settings, and the engine passes it to `GitHubClient`. The settings screen's 연결 테스트 builds its own client without it, so use route forwarding for that button.
- **Manual:** `node tests/store/fake-github.mjs --port 8112 --token ghp_fake_token --repo me/paper-library` starts an empty private repo.
  - In Node, the fake also offers `commitFiles` (simulate another device), `commits`, `files`, `readFile`, `failNext({status, headers})` (401/403/429/5xx), `pauseNext` (hold a request), `setDown(true)` (connection reset) and a request `log` (with the token used).

## How to test

```
node tests/store/unit.test.mjs     # 26 checks: merges, paths, GitHubClient (incl. proxy mode) vs fake (Node)
node tests/store/library.test.mjs  # 17 checks: several Library instances, 휴지통, copy; fake relay + fake GitHub (Node)
node tests/store/run.mjs           # 20 browser scenarios in Edge (python -m http.server 8102, fake on 8112)
node tests/store/run-shared.mjs    # 6 browser scenarios: 내 서재 + 공용 서재 in one page, invitees A/B, copy, activity (8193)
```
Results go to `C:/Users/dindoo/Projects/pr-tools/out/store/` (`unit.results.json`, `library.results.json`, `results.json`,
`shared-results.json`, `app-*.png`). Fixture PDFs are served by route interception and never copied into the repo. Every
non-loopback request is aborted and recorded (browser: Playwright routes; Node suites: a `fetch` guard).

## Findings for the integrator / other builders

> Integration status: items 1 and 3 are resolved (error toast in `app.js`; the reader merges synced `translation.json`) — see `integration.md`.

1. `library.js` surfaces IndexedDB save failures only through the `'error'` event. Suggest `library.addEventListener('error', e => toast(e.detail.message, {kind:'error'}))` in `app.js`.
2. `reader-view` keeps `ai` in memory and saves the whole object. If two devices change the same `ai` key of the same paper at once, the later save wins for that key (shallow merge per SPEC). The other keys survive.
3. Reader views do not reload `translation.json` on `remotechange`. Concurrent translations of the same paper on two devices still merge (union), but the other device's new sentences appear only after reopening.
4. `checkAccess()` success messages now carry notes: empty repo, branch to be created, unrelated files. `settings-view` already shows `r.message`.

## Known limitations

- After switching repos, files this device never downloaded (PDFs/data of papers never opened here) stay only in the old repo.
- Tombstones are never purged. `library.json` grows by one small record per deleted folder or paper.
- An upload interrupted by a page reload starts over: uploaded-blob shas are remembered only per session, though big backlogs are committed in ~48 MB steps.

## Several libraries: 내 서재 + 공용 서재 (docs/SHARED.md §3.1, 2026-10-19)

내 서재 is unchanged: `Library.open({ settings })` → id `'mine'`, IndexedDB `paper-reader`, Web Lock / BroadcastChannel
`paper-reader-sync`, journal `pr.store.libraryJournal.v1`, repo paths as before, deletes remove the paper's files.
The 20 original browser scenarios run unchanged.

**API**
- `db.js`: `openDatabase(name)` (same API as `db`; one shared wrapper per name), `DEFAULT_DB_NAME`, `db.name`.
- `Library.open({ …, id, label, dbName, getConfig, personalPrefix, retainPdfOnDelete, shared, personName })`.
  Getters `id`, `label`, `shared`, `personalPrefix`, `retainPdfOnDelete`, `personName`; `dataPath(paperId, kind)`.
  Any database other than `paper-reader` gets its own lock, channel and journal names (`…:<dbName>`), so two libraries
  in one page never lock, notify or journal for each other.
- `shared: true` hardening: the engine never falls back to `settings.github`, and its client always runs in **proxy
  mode** (even when `getConfig` omits `proxy`); no README.md is added to commits (the proxy allows only data paths).
- `openSharedLibrary({ relayUrl, code, lib = 'team', personId?, personName | name, label })` → apiBase
  `<relay>/shared/<lib>/gh`, owner `team`, repo `library`, token = normalised code (an owner-chosen code such as
  `EICU2-2026` is passed as saved; the relay matches it by key), prefix `people/<personId>/`,
  `retainPdfOnDelete`, IndexedDB `sharedDbName(lib, personId)` = `paper-reader-shared-<lib>-<personId>` (one per person:
  switching codes on a device never mixes two people's notes or pushes one person's files with the other's code),
  `carryOver` = its own target (a changed relay address carries the data over without asking). It also accepts the
  app's `Library.open`-style call (`getConfig`, `dbName`, `personName`; `name` then is the library name and ignored for
  deletedBy). `personIdFor(code)` / `normalizeInviteCode(code)` repeat relay/src/codes.js (cross-checked in a test).
  `personIdFor` is only a fallback for callers that pass no personId and knows only the saltless, secret-less id: the
  Worker's personId uses `PERSON_ID_SECRET` and, for codes made since 2026-10-19, a per-code salt (`docs/RELAY.md` §5),
  so the app always passes `GET /shared`'s `personId`.
- `trash()` (sync) → frozen items `{ ...record, kind: 'folder'|'paper', name, deletedAt, deletedBy, expiresAt, expired }`,
  newest first. Folders: 30 days. Papers: only where deletes keep files (공용 서재), also after 30 days (`expired`) until the
  purge removes their PDF (then hidden; detected after each pull). 내 서재 lists folders only (its papers' files are gone).
- `async restore(id)` un-tombstones the item and every deleted folder above it; Korean errors for unknown ids, 내 서재
  papers and purged papers.
- `copyPaperTo(target, id, { folderId })` → `{ paper, copied, existing, moved, restored, translationAdded }`;
  `copyFolderTo(target, id, { parentId, onProgress, signal })` → `{ folder, folders: { created, reused }, papers: { total,
  copied, existing, moved, restored, failed[] } }`.

**Decisions**
- Paths: `annotations`/`ai` at `${personalPrefix}papers/<id>/<kind>.json`; `paper.pdf`, `translation.json` shared.
  `mergerFor` accepts the `people/<id>/` prefix (same rules; merge.js untouched).
- `retainPdfOnDelete`: deletePaper/deleteFolder only tombstone. A deleted folder's contents keep pointing at it (shown in
  the parent through the existing nearest-live-ancestor rule), so restoring the folder brings them back; a deleted item
  stores the place it was shown (`folderId`/`parentId` resolved at deletion), so restore puts it back there.
- Tombstones carry `deletedAt` and `deletedBy` (`personName`; '나' in 내 서재). 공용 서재 papers carry `addedBy`.
  `addedBy`, `deletedAt`, `deletedBy`, `sha256` are protected from `updatePaper`.
- New papers carry `sha256` (copy dedupe). Records from before have none: they match by size + git blob sha.
- Copy: PDF + translation + title/authors/year/pages/fileName/s2PaperId/counts; never annotations, ai, `starred`,
  `lastOpenedAt`. Same PDF already in the target → that paper is moved into `folderId` (when given; restored first if it is
  in the target's 휴지통) and sentences it lacks are added to its translation (union, target wins). `copyFolderTo` reuses a
  same-named folder in the same place (copying again is idempotent) and never moves a paper it placed itself in this run.
- 최근 활동: the shared engine's commit messages describe the batch — e.g. `폴더 만듦 ‘섬망 연구’ · 논문 추가 ‘Lu 2025’ ·
  번역 ‘Lu 2025’`, `논문 삭제 ‘…’`, `복구 ‘…’`, `폴더 복사 ‘ICU’ (내 서재에서, 논문 2편)`, `내 메모·AI 결과 동기화`
  (personal files only) — ≤ 170 characters, never paths, person ids or codes. The relay prefixes `[name] `. 내 서재 keeps
  its file-list messages.
- GitHubClient `proxy: true`: the relay's Korean messages are shown as they are (401 fallback: "초대 코드가 올바르지
  않거나…"); 409/422 on `POST git/trees` or `git/commits` is a `GitHubConflictError` (re-pull, merge, retry); an invalid,
  missing or `*.github.com` apiBase is a config error with **no request** (the code can never reach api.github.com).

**For the relay builder / integrator**
1. The client treats **409 or 422** on `POST …/git/trees` (stale base_tree) and `POST …/git/commits` (parents ≠ head) as
   "someone pushed first" and retries; a 403 there is fatal (shown to the user, no retry) — keep 403 for real allowlist
   violations only. Korean `message` texts in GitHub's error shape are shown verbatim.
2. The bootstrap `PUT contents/README.md` message is `논문 리더 데이터 저장소 시작` (the fake relay lists it with `who: null`).
3. `tests/store/fake-relay.mjs` emulates §2.1–§2.2 (allowlist, people/ filtering, base/parents → 409, force, README only
   when empty, `[name] ` rewrite, `GET /shared`, `/activity`) for store tests; the real Worker remains the reference.
4. 공용 서재 writes `translatedCount`/`sentenceCount` to the shared library.json; a commit with only such fields reads
   `논문 정보 갱신` in 최근 활동.
5. **Test incident (fixed):** one run of the new proxy-mode unit test, before the fix, sent one `GET /repos/me/lib` with the
   fake token `good` to the real api.github.com (`apiBase: undefined` fell back to the constructor default). The default
   is gone in proxy mode, GitHub hosts are refused as a proxy, and both Node suites now block every non-loopback request.

## Code libraries: each invite code's own library (2026-10-19)

Owner decision: 전체 공용 서재 stays (lib `team`, the team repo's root); every invite code also gets its own library
(lib `mine`), visible only to holders of that code, kept in the folder `codes/<libraryId>/` of the **same** team repo.
Whole design, migration and deploy order: [`docs/CODE-LIBRARIES.md`](../CODE-LIBRARIES.md).

**API**
- `GitHubClient({ …, rootPrefix, label })`: `rootPrefix` (`''` or segments like `codes/<libraryId>/`, `ROOT_PREFIX_RE`)
  makes `listTree()` return only the blobs under that folder, keyed relative to it (a truncated listing is walked level by
  level only along the way down), and `commit()` take library paths and write `rootPrefix + path` (`..`, `.`, empty or
  absolute segments → `config` error, no request). Head, trees, `base_tree` and parents stay the whole repo's; an empty
  repo is still bootstrapped with README.md at the root; `target` gains `:<rootPrefix>`. `label` names the library in
  proxy-mode fallback messages (default `공용 서재`). A bad prefix is a config error with no request.
- `Library.open({ …, rootPrefix })`: validated; passed to the engine's client config (with `label`; no README ever).
  A `carryOver` equal to the folder-less target is upgraded to this library's own target. Getter `rootPrefix`,
  `repoPath(path)` (= rootPrefix + path).
- `openSharedLibrary({ lib: 'mine', libraryId, … })` (`CODE_LIBRARY = 'mine'`): apiBase `<relay>/shared/mine/gh`,
  `rootPrefix = codeLibraryPrefix(libraryId)` = `codes/<libraryId>/`, IndexedDB
  `sharedDbName('mine', personId, libraryId)` = `paper-reader-shared-mine-<libraryId>-<personId>`, default label
  `초대 코드 서재` (the app passes GET /shared's `name`, e.g. `봄당 서재`), `carryOver` = its own target. A missing or
  malformed `libraryId` → Korean error before any request. `lib: 'team'` is unchanged.

**Decisions**
- **Paths stay the library's own everywhere in the app**: IndexedDB keys, `dataPath()`, `listPaths()`, `'remotechange'`
  paths and commit-message descriptions are `library.json`, `papers/<id>/…`, `people/<id>/…`; only GitHubClient maps
  to repo paths. reader-view / annotations / library-view need no path changes for the code library.
- Copy works between **any two** libraries (내 서재, a code library, 전체 공용 서재) with the existing
  `copyPaperTo` / `copyFolderTo` (PDF + translation, sha256 dedupe, never notes). A second instance on the same
  database and id counts as the same library (refused).
- Trash / restore unchanged (the code library tombstones like 공용 서재).
- **Moves are honoured in merges** (`merge.js`): `mergeLibrary` with a base drops a record that the base has and one
  side no longer has (`mergeRecords(…, { removals: true })`), even when the other side edited it meanwhile. Clients only
  tombstone (and the relay refuses a push that drops a record), so such a record was moved out by the relay's
  split-by-uploader (or a code-library move); without this, a device with an unsaved library edit, a stale tab, the
  page-hide journal or the reader's progress counts would merge it back and push a broken record (files gone) to
  전체 공용 서재. Base-less merges, tombstones and annotations are unchanged.
- The commit summary never contains `{lib:` (the relay's library marker is neutralised as `{lib `).
- **Empty-repo race fixed** (`sync.js`): the README bootstrap is decided on exactly the paths about to be uploaded
  (inside `#push`), not on a pending count taken before; a write landing between the pull and the push used to upload
  a blob into the empty repo → 409 → fatal "저장소가 비어 있습니다" (seen once in `run-shared.mjs`; regression test
  `code-libs.test.mjs` › empty-repo-race fails on the old engine).

**Fake relay** (`tests/store/fake-relay.mjs`, `startFakeRelay({ …, codeLibraries: true, codeMaxBytes })`; default off so
other suites keep the old `GET /shared`): `addCode(code, name, { libraryId, maxBytes })`, `libraryIdOf(code)`,
`codeFiles(code)`. `/shared/mine/gh` works under `codes/<libraryId>/` (allowlist mirrored, people/ isolation inside it,
listings — recursive and level by level — and blob reads hide everything else); `/shared/<team>/gh` hides `codes/` and
refuses writes there; commit messages `[name] {lib:<team|libraryId>} …`; `/shared/<lib>/activity` per library, marker
removed (unmarked commits = team). In both modes now: library.json records may only be tombstoned (403), an existing
paper.pdf cannot change (403), blobs are served only when visible / listed / uploaded by the caller (else 404),
`base_tree` must be the head's tree or a head / proxy-made tree of the last 10 min (409).

**For the relay builder / integrator** (all four confirmed against the real Worker at integration:
`relay/test/shared-client.test.mjs` › rootPrefix through /shared/mine/gh, `tests/code-libs/run.mjs`)
1. The client sends library-relative paths through `/shared/mine/gh` **already prefixed** with `codes/<libraryId>/`
   (tree entry paths in `POST git/trees`), uses the whole repo's head tree as `base_tree`, and reads the whole-repo
   recursive listing of the head (expects it filtered to `codes`, `codes/<libraryId>` and below).
2. A code library in an **empty** team repo bootstraps it with `PUT contents/README.md` through `/shared/mine/gh` — allow
   it there as on `/shared/team/gh` (only while the repo is empty), or the first push of a fresh deployment fails.
3. The client never writes `{lib:`; the Worker adds the marker after `[name] `.
4. `GET /shared` must return `libraryId` whenever a `mine` library is listed (the store refuses to open it without one).

**Known limits**
- Notes of a moved paper that were **not yet synced** when the split ran (`people/<me>/papers/<id>/…` dirty on a device)
  are pushed to the old place (전체 공용 서재's `people/<me>/`), not into the code library; the code library has the
  version from before. An edit to a moved record made during the split is dropped with the record.
- Every library's commit moves the one branch, so engines of other libraries re-pull (one filtered listing) and
  concurrent pushes across libraries retry on 409/422 as within one library.
- (Fixed at integration) `features/annotations.js` reloaded on `remotechange` only for `papers/<id>/annotations.json`;
  it now uses `ctx.library.dataPath(id, 'annotations')` (`people/<me>/…` in 공용 서재 and code libraries), so a highlight
  from another device of the same code shows without reopening the paper.

**Tests**
```
node tests/store/unit.test.mjs        # 28: + rootPrefix client (listing, commit, target, truncated walk, refusals), merge removals
node tests/store/code-libs.test.mjs   # 11 (Node): rootPrefix, lib 'mine', isolation, cross-library 409, activity, copy ×4,
                                      #    휴지통 + relay refusals, truncated listing, size cap, post-split production shape, empty-repo race
node tests/store/run-code-libs.mjs    # 6 (Edge + WebKit, port 8241): three libraries in one page, copy across all three,
                                      #    same code on 2 browsers, other code, 휴지통, reload journals, iPhone engine
```
Results: `C:/Users/dindoo/Projects/pr-tools/out/code-libs/` (`store-node.results.json`, `store-browser.results.json`).
