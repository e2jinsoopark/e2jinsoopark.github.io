// Pure planning of the server-side changes to code libraries (docs/CODE-LIBRARIES.md): deleting a code's library, moving
// it into another code's library (code deletion with library=move), and splitting the team library by uploader
// (the one-time admin migration). No I/O here: the caller (shared.js) reads the head tree and library.json files,
// creates the blobs and makes one commit from the plan. Unit-tested in test/code-libs-unit.test.mjs.
//
// Records follow js/store/library.js: folders { id, name, parentId, createdAt, updatedAt, deleted?, deletedAt?,
// deletedBy? }, papers { id, title, folderId, addedBy, …, deleted?, … }; a deleted folder's contents show in its parent.
import { isPaperId, LIBRARY_PATH } from './shared-paths.js';

/** Who server-made tombstones name (deletedBy). */
export const ADMIN_NAME = '관리자';
const MAX_DEPTH = 64;

/** Skip reasons of the split (Korean, shown in the admin's plan). */
export const SPLIT_SKIP = {
  trashed: '휴지통에 있음',
  badId: '논문 id를 저장 경로로 쓸 수 없음',
  noUploader: '올린 사람 기록 없음',
  noCode: '같은 이름의 코드 없음',
  manyCodes: '같은 이름의 코드가 여러 개',
};

/** A random record id in the app's shape (js/core/util.js uid: '<prefix>_' + 8 base-36 characters), not in `taken`. */
export function freshId(prefix, taken) {
  for (;;) {
    const bytes = crypto.getRandomValues(new Uint8Array(8));
    let s = '';
    for (const b of bytes) s += (b % 36).toString(36);
    const id = `${prefix}_${s}`;
    if (!taken.has(id)) return id;
  }
}

const isRecord = (x) => x && typeof x === 'object' && !Array.isArray(x) && typeof x.id === 'string' && x.id !== '';
const listOf = (v) => (Array.isArray(v) ? v : []);

/** A library.json object as clients read it: { top, folders: record[], papers: record[] } (copies, safe to change). */
function normalise(raw) {
  const top = raw && typeof raw === 'object' && !Array.isArray(raw) ? structuredClone(raw) : {};
  return { top, folders: listOf(top.folders).filter(isRecord), papers: listOf(top.papers).filter(isRecord) };
}

/** Repo paths under `root`, relative to it. */
function relativeFiles(files, root) {
  const out = [];
  for (const path of files.keys()) if (path.startsWith(root)) out.push(path.slice(root.length));
  return out;
}

/** Paper ids that have a folder of files under papers/<id>/ or people/<x>/papers/<id>/ (relative paths). */
function paperDirs(relPaths) {
  const ids = new Set();
  for (const p of relPaths) {
    const m = /^papers\/([^/]+)\//.exec(p) || /^people\/[^/]+\/papers\/([^/]+)\//.exec(p);
    if (m) ids.add(m[1]);
  }
  return ids;
}

/** Every file of the library at `root` (the paths to delete when a code's library is deleted with it). */
export function planLibraryDelete(files, root) {
  return [...files.keys()].filter((p) => p.startsWith(root)).sort();
}

/**
 * Move the code library at `fromRoot` into the one at `toRoot` (code deletion, library=move).
 * - library.json: the target's records stay; the source's folders and papers (tombstones too) are appended with their
 *   ids, and a source id the target already uses (a record, or a paper folder of files) gets a new id; parentId /
 *   folderId follow the renames.
 * - files: papers/<id>/* and people/<p>/papers/<id>/* move under the target root with the (new) paper id; a person id
 *   in `personMap` (the deleted holder's ids) becomes its value (the target holder's), so the notes come along.
 *   A file whose destination already exists stays where it is (never overwritten, never lost).
 * @param {{ files: Map<string, { sha: string }>, fromRoot: string, toRoot: string, from: any, to: any,
 *           personMap: Map<string, string>, now: number }} opts from/to: the two library.json objects (null = none)
 * @returns {null | { entries: { path: string, sha: string | null }[], library: object | null, papers: number,
 *                    folders: number, renamed: number }} null when the source has no files; library = the target's
 *          new library.json (null when the source had none)
 */
export function planLibraryMove({ files, fromRoot, toRoot, from, to, personMap, now }) {
  const sourcePaths = [...files.keys()].filter((p) => p.startsWith(fromRoot)).sort();
  if (!sourcePaths.length) return null;
  const source = from ? normalise(from) : null;
  const target = normalise(to);
  const targetRel = relativeFiles(files, toRoot);
  const takenFolders = new Set(target.folders.map((f) => f.id));
  const takenPapers = new Set([...target.papers.map((p) => p.id), ...paperDirs(targetRel)]);
  let renamed = 0;
  const rename = (id, taken, prefix) => {
    if (!taken.has(id)) {
      taken.add(id);
      return id;
    }
    renamed++;
    const next = freshId(prefix, taken);
    taken.add(next);
    return next;
  };
  const folderMap = new Map();
  for (const f of source?.folders ?? []) if (!folderMap.has(f.id)) folderMap.set(f.id, rename(f.id, takenFolders, 'f'));
  const sourceRel = sourcePaths.map((p) => p.slice(fromRoot.length));
  const paperMap = new Map();
  for (const id of [...(source?.papers ?? []).map((p) => p.id), ...paperDirs(sourceRel)]) {
    if (!paperMap.has(id)) paperMap.set(id, rename(id, takenPapers, 'p'));
  }
  let library = null;
  let papers = 0;
  let folders = 0;
  if (source) {
    const seen = new Set();
    const movedFolders = [];
    for (const f of source.folders) {
      if (seen.has(`f:${f.id}`)) continue;
      seen.add(`f:${f.id}`);
      movedFolders.push({ ...f, id: folderMap.get(f.id), parentId: f.parentId != null ? folderMap.get(f.parentId) ?? f.parentId : f.parentId });
      if (f.deleted !== true) folders++;
    }
    const movedPapers = [];
    for (const p of source.papers) {
      if (seen.has(`p:${p.id}`)) continue;
      seen.add(`p:${p.id}`);
      movedPapers.push({ ...p, id: paperMap.get(p.id), folderId: p.folderId != null ? folderMap.get(p.folderId) ?? p.folderId : p.folderId });
      if (p.deleted !== true) papers++;
    }
    library = {
      ...target.top,
      version: 1,
      updatedAt: now,
      folders: [...listOf(target.top.folders), ...movedFolders],
      papers: [...listOf(target.top.papers), ...movedPapers],
    };
  }
  const entries = [];
  const planned = new Set();
  for (const path of sourcePaths) {
    const rel = path.slice(fromRoot.length);
    if (rel === LIBRARY_PATH) {
      if (library) entries.push({ path, sha: null }); // its records now live in the target's library.json
      continue;
    }
    let dest = rel;
    let m;
    if ((m = /^papers\/([^/]+)\/(.+)$/.exec(rel))) dest = `papers/${paperMap.get(m[1]) ?? m[1]}/${m[2]}`;
    else if ((m = /^people\/([^/]+)\/papers\/([^/]+)\/(.+)$/.exec(rel))) {
      dest = `people/${personMap.get(m[1]) ?? m[1]}/papers/${paperMap.get(m[2]) ?? m[2]}/${m[3]}`;
    }
    const full = `${toRoot}${dest}`;
    if (files.has(full) || planned.has(full)) continue;
    planned.add(full);
    entries.push({ path: full, sha: files.get(path).sha }, { path, sha: null });
  }
  return { entries, library, papers, folders, renamed };
}

/**
 * The folders from the top down to `folderId` that are not in the 휴지통 (a deleted folder's contents show in its
 * parent, so it is skipped). [] for the top level.
 */
function liveChain(folderById, folderId) {
  const chain = [];
  const seen = new Set();
  let id = folderId;
  while (id != null && !seen.has(id) && seen.size < MAX_DEPTH) {
    seen.add(id);
    const f = folderById.get(id);
    if (!f) break;
    if (f.deleted !== true) chain.unshift(f);
    id = f.parentId;
  }
  return chain;
}

/**
 * The split's plan (dry run): every paper of the team library whose `addedBy` is exactly the name of exactly one code
 * (active or stopped) and that is not in the 휴지통 moves to that code's library; the rest stay.
 * @param {{ library: any, codes: { code: string, name: string }[] }} opts library: the team library.json object
 * @returns {{ moves: { paperId: string, title: string, toCode: string, folderPath: string, code: string }[],
 *             skipped: { paperId: string, title: string, reason: string }[] }}
 *          toCode = the code's name, folderPath = its folders from the top, ' / ' between ('' = top level);
 *          `code` (the code itself) is for the Worker only, never sent.
 */
export function planSplit({ library, codes }) {
  const { folders, papers } = normalise(library);
  const folderById = new Map();
  for (const f of folders) if (!folderById.has(f.id)) folderById.set(f.id, f);
  const byName = new Map();
  for (const c of codes) {
    const list = byName.get(c.name) || [];
    list.push(c);
    byName.set(c.name, list);
  }
  const moves = [];
  const skipped = [];
  const seen = new Set();
  for (const p of papers) {
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    const title = typeof p.title === 'string' ? p.title : '';
    const skip = (reason) => skipped.push({ paperId: p.id, title, reason });
    if (p.deleted === true) { skip(SPLIT_SKIP.trashed); continue; }
    if (!isPaperId(p.id)) { skip(SPLIT_SKIP.badId); continue; }
    const uploader = typeof p.addedBy === 'string' ? p.addedBy : '';
    if (!uploader) { skip(SPLIT_SKIP.noUploader); continue; }
    const matches = byName.get(uploader) || [];
    if (!matches.length) { skip(SPLIT_SKIP.noCode); continue; }
    if (matches.length > 1) { skip(SPLIT_SKIP.manyCodes); continue; }
    const folderPath = liveChain(folderById, p.folderId).map((f) => String(f.name ?? '')).join(' / ');
    moves.push({ paperId: p.id, title, toCode: matches[0].name, folderPath, code: matches[0].code });
  }
  return { moves, skipped };
}

/**
 * The split's changes for `moves` (planSplit): the team library.json without the moved records (and with the
 * folders the moves left empty tombstoned), each target code library's library.json with the papers added — in
 * folders of the same names and nesting (an existing live folder of that name at that place is reused) — and the
 * file moves: papers/<id>/* and the holder's people/<p>/papers/<id>/* (any of `personIds`) into the code library,
 * the notes under its current personId. A paper id the target already uses gets a new id. Other people's notes on a
 * moved paper stay where they are.
 * @param {{ library: any, files: Map<string, { sha: string }>, moves: { paperId: string, code: string }[],
 *           targets: Map<string, { root: string, marker: string, library: any, personIds: string[], personId: string }>,
 *           now: number }} opts
 * @returns {{ team: object, libraries: Map<string, object>, entries: { path: string, sha: string | null }[],
 *             counts: Map<string, number>, tombstoned: string[] }} libraries by target root; counts by code
 */
export function applySplit({ library, files, moves, targets, now }) {
  const team = normalise(library);
  const folderById = new Map();
  for (const f of team.folders) if (!folderById.has(f.id)) folderById.set(f.id, f);
  const paperById = new Map();
  for (const p of team.papers) if (!paperById.has(p.id)) paperById.set(p.id, p);
  const states = new Map();
  const stateOf = (t) => {
    let s = states.get(t.root);
    if (!s) {
      const lib = normalise(t.library);
      s = {
        lib,
        papers: [],
        folders: [],
        takenPapers: new Set([...lib.papers.map((p) => p.id), ...paperDirs(relativeFiles(files, t.root))]),
        takenFolders: new Set(lib.folders.map((f) => f.id)),
        folderMap: new Map(),
      };
      states.set(t.root, s);
    }
    return s;
  };
  const entries = [];
  const planned = new Set();
  const move = (from, to) => {
    if (planned.has(to) || files.has(to)) return;
    planned.add(to);
    entries.push({ path: to, sha: files.get(from).sha }, { path: from, sha: null });
  };
  const counts = new Map();
  const moved = new Set();
  const candidates = new Set();
  const allPaths = [...files.keys()];
  for (const { paperId, code } of moves) {
    const p = paperById.get(paperId);
    const t = targets.get(code);
    if (!p || !t || moved.has(paperId)) continue;
    const s = stateOf(t);
    const newId = s.takenPapers.has(paperId) ? freshId('p', s.takenPapers) : paperId;
    s.takenPapers.add(newId);
    let parent = null;
    for (const f of liveChain(folderById, p.folderId)) {
      candidates.add(f.id);
      let mapped = s.folderMap.get(f.id);
      if (!mapped) {
        const existing = [...s.lib.folders, ...s.folders].find((x) => x.deleted !== true && x.name === f.name
          && (x.parentId ?? null) === parent);
        if (existing) mapped = existing.id;
        else {
          mapped = s.takenFolders.has(f.id) ? freshId('f', s.takenFolders) : f.id;
          s.takenFolders.add(mapped);
          s.folders.push({ id: mapped, name: f.name, parentId: parent, createdAt: f.createdAt ?? now, updatedAt: now });
        }
        s.folderMap.set(f.id, mapped);
      }
      parent = mapped;
    }
    s.papers.push({ ...structuredClone(p), id: newId, folderId: parent });
    for (const path of allPaths) {
      if (path.startsWith(`papers/${paperId}/`)) move(path, `${t.root}papers/${newId}/${path.slice(`papers/${paperId}/`.length)}`);
    }
    for (const pid of t.personIds) {
      const prefix = `people/${pid}/papers/${paperId}/`;
      for (const path of allPaths) {
        if (path.startsWith(prefix)) move(path, `${t.root}people/${t.personId}/papers/${newId}/${path.slice(prefix.length)}`);
      }
    }
    moved.add(paperId);
    counts.set(code, (counts.get(code) || 0) + 1);
  }
  // The team library: the moved records go (a move, not a tombstone); folders the moves left empty are tombstoned.
  const top = team.top;
  top.papers = listOf(top.papers).filter((p) => !(isRecord(p) && moved.has(p.id)));
  const liveFolders = listOf(top.folders).filter(isRecord);
  const tombstoned = [];
  const occupied = (id, depth = 0) => depth < MAX_DEPTH && (
    top.papers.some((p) => isRecord(p) && p.deleted !== true && p.folderId === id)
    || liveFolders.some((c) => c.parentId === id && (c.deleted !== true || occupied(c.id, depth + 1))));
  const depthOf = (id) => liveChain(folderById, id).length;
  for (const id of [...candidates].sort((a, b) => depthOf(b) - depthOf(a))) {
    const f = liveFolders.find((x) => x.id === id);
    if (!f || f.deleted === true || occupied(id)) continue;
    Object.assign(f, { deleted: true, deletedAt: now, deletedBy: ADMIN_NAME, updatedAt: now });
    tombstoned.push(id);
  }
  if (moved.size) top.updatedAt = now;
  const libraries = new Map();
  for (const [root, s] of states) {
    if (!s.papers.length) continue;
    libraries.set(root, {
      ...s.lib.top,
      version: 1,
      updatedAt: now,
      folders: [...listOf(s.lib.top.folders), ...s.folders],
      papers: [...listOf(s.lib.top.papers), ...s.papers],
    });
  }
  return { team: top, libraries, entries, counts, tombstoned };
}
