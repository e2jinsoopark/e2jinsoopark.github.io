# Store module — notes (js/store/*)

Owner files: `db.js`, `github.js`, `sync.js`, `library.js`. Tests: `tests/store/*`.
Nothing outside these was touched.

| File | Role |
|---|---|
| `db.js` | IndexedDB `paper-reader` v1: `files` (key = repo path, index `dirty`), `meta`, `blobs` (key = git sha). SPEC API plus atomic `update()`. |
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
  - *translation.json*: union of items, local wins per sid; a higher `segVersion` replaces the lower one wholesale.
  - *ai.json*: per top-level key, 3-way with the base (a key changed on one side only takes that side); otherwise the newer file's value.
  - *paper.pdf* and other files: local wins.
- **Push.**
  - Debounce 3 s, at most 30 s after the first pending write, and immediately on `visibilitychange→hidden` / `pagehide`.
  - Normally one commit. A backlog over ~48 MB is split into several commits, so a failure does not throw away every upload.
  - PDFs go first and `library.json` last, so no device sees a paper before its PDF.
  - A blob whose git sha already matches the remote is not uploaded. Uploaded shas are reused across conflict retries.
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
- **Switching repo** (or the remote branch being deleted): all local data, including PDFs only cached from the old repo, becomes pending and is pushed to the new target.
- `navigator.storage.persist()` is requested once, when the first PDF is stored.
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
node tests/store/unit.test.mjs   # 18 checks: merges + GitHubClient vs fake (Node)
node tests/store/run.mjs         # 16 browser scenarios in Edge (python -m http.server 8102, fake on 8112)
```
Results go to `C:/Users/dindoo/Projects/pr-tools/out/store/` (`unit.results.json`, `results.json`, `app-*.png`).
Fixture PDFs are served by route interception and never copied into the repo. Every non-loopback request is aborted and recorded.

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
