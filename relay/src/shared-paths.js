// Pure rules of the shared library ("공용 서재", docs/SHARED.md §1–§2): which repo paths a person may see, write and
// delete, how tree listings are filtered, and how commit messages are rewritten. No I/O here (unit-tested).
//
//   library.json                                         shared
//   papers/<paperId>/paper.pdf                           shared, immutable
//   papers/<paperId>/translation.json                    shared
//   people/<personId>/papers/<paperId>/annotations.json  only that person
//   people/<personId>/papers/<paperId>/ai.json           only that person
//   README.md                                            created once (bootstrap)

export const LIBRARY_PATH = 'library.json';
export const README_PATH = 'README.md';
export const PERSON_ID_RE = /^[0-9a-f]{16}$/;
const ID = '[A-Za-z0-9_-]{1,64}';
const SHARED_FILE_RE = new RegExp(`^papers/(${ID})/(paper\\.pdf|translation\\.json)$`);
const PERSONAL_FILE_RE = new RegExp(`^people/([0-9a-f]{16})/papers/(${ID})/(annotations|ai)\\.json$`);
const PAPER_ID_RE = new RegExp(`^${ID}$`);
const SHA_RE = /^[0-9a-f]{40}$/;
const ENTRY_KEYS = new Set(['path', 'mode', 'type', 'sha']);
const MAX_ENTRIES = 20_000;
const COMMIT_MESSAGE_MAX = 200;
const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/g;
// Person ids (a hash of the invite code: only 40 bits of code behind 64 bits of hash, so never show one to others)
// and invite codes that a client put into a commit message.
const PERSON_IN_TEXT = /people\/[0-9a-f]{16}(?![0-9a-f])/gi;
const CODE_IN_TEXT = /\bPR-?[0-9A-HJKMNP-TV-Z]{4}-?[0-9A-HJKMNP-TV-Z]{4}\b/g;

/**
 * personId = first 16 hex chars of HMAC-SHA-256(secret, normalised invite code). Codes have only ~40 bits, so a plain
 * hash would let anyone who sees a personId (e.g. in the team repo) recover the code by brute force; the server-side
 * secret (PERSON_ID_SECRET) prevents that. Without a secret (local tests) it falls back to plain SHA-256.
 */
export async function personIdFor(code, secret = '') {
  const data = new TextEncoder().encode(code);
  let digest;
  if (secret) {
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    digest = await crypto.subtle.sign('HMAC', key, data);
  } else {
    digest = await crypto.subtle.digest('SHA-256', data);
  }
  return Array.from(new Uint8Array(digest).slice(0, 8), (b) => b.toString(16).padStart(2, '0')).join('');
}

export const isPaperId = (id) => typeof id === 'string' && PAPER_ID_RE.test(id);

/**
 * What a repo file path is.
 * @returns {{ kind: 'library' | 'readme' | 'pdf' | 'translation' | 'personal', paperId?: string, person?: string }
 *           | null} null for anything outside the layout
 */
export function classifyPath(path) {
  if (typeof path !== 'string') return null;
  if (path === LIBRARY_PATH) return { kind: 'library' };
  if (path === README_PATH) return { kind: 'readme' };
  let m = SHARED_FILE_RE.exec(path);
  if (m) return { kind: m[2] === 'paper.pdf' ? 'pdf' : 'translation', paperId: m[1] };
  m = PERSONAL_FILE_RE.exec(path);
  if (m) return { kind: 'personal', person: m[1], paperId: m[2] };
  return null;
}

/**
 * Whether `path` (a file or directory, relative to the repo root) may appear in `me`'s tree listings:
 * everything except other people's `people/<other>` directories and what is under them.
 */
export function visibleTo(path, me) {
  if (path === 'people' || !path.startsWith('people/')) return true;
  const slash = path.indexOf('/', 7);
  return (slash === -1 ? path.slice(7) : path.slice(7, slash)) === me;
}

/**
 * Tree listing entries (paths relative to the listed tree, which sits at `prefix` in the repo) that `me` may see.
 * Each kept entry is reduced to GitHub's documented fields.
 */
export function filterEntries(entries, prefix, me) {
  const out = [];
  for (const e of Array.isArray(entries) ? entries : []) {
    if (!e || typeof e.path !== 'string') continue;
    const full = prefix ? `${prefix}/${e.path}` : e.path;
    if (!visibleTo(full, me)) continue;
    const entry = { path: e.path, mode: e.mode, type: e.type, sha: e.sha };
    if (e.size !== undefined) entry.size = e.size;
    out.push(entry);
  }
  return out;
}

/**
 * Validate the `tree` array of a POST git/trees body for person `me`.
 * - Writes: library.json, papers/<id>/paper.pdf (new, or the same bytes again: PDFs are immutable),
 *   papers/<id>/translation.json, people/<me>/papers/<id>/(annotations|ai).json. (README.md is created only by the
 *   bootstrap of an empty repo, PUT contents/README.md.)
 * - Deletions (sha: null) only of people/<me>/papers/<id>/(annotations|ai).json.
 * - Entries are plain files: { path, mode: '100644', type: 'blob', sha } and nothing else (no inline content, no
 *   symlinks, submodules or subtrees).
 * @param {any} entries
 * @param {{ me: string, baseFiles: Map<string, { sha: string }> | null }} opts baseFiles = the base tree's files
 *        (null when the branch does not exist yet, i.e. there is no base)
 * @returns {{ entries: { path: string, mode: string, type: string, sha: string | null }[] } | { error: string }}
 */
export function checkTreeEntries(entries, { me, baseFiles }) {
  if (!Array.isArray(entries)) return { error: '트리 항목(tree)은 배열이어야 합니다.' };
  if (entries.length > MAX_ENTRIES) return { error: `한 번에 바꿀 수 있는 파일은 ${MAX_ENTRIES}개까지입니다.` };
  const out = [];
  for (const e of entries) {
    if (!e || typeof e !== 'object' || Array.isArray(e) || Object.keys(e).some((k) => !ENTRY_KEYS.has(k))) {
      return { error: `트리 항목 형식이 올바르지 않습니다: ${shown(e)}` };
    }
    const { path, sha } = e;
    const where = classifyPath(path);
    if (!where || where.kind === 'readme') return { error: `공용 서재에 둘 수 없는 경로입니다: ${shown(path)}` };
    if (e.mode !== '100644' || (e.type !== undefined && e.type !== 'blob')) {
      return { error: `일반 파일(mode 100644, blob)만 저장할 수 있습니다: ${shown(path)}` };
    }
    if (where.kind === 'personal' && where.person !== me) {
      return { error: `다른 사람의 하이라이트·메모·AI 기록은 바꿀 수 없습니다: ${shown(path)}` };
    }
    if (sha === null) {
      if (!baseFiles || where.kind !== 'personal') {
        return { error: `공용 서재에서는 이 파일을 지울 수 없습니다(삭제는 휴지통으로만 합니다): ${shown(path)}` };
      }
    } else if (typeof sha !== 'string' || !SHA_RE.test(sha)) {
      return { error: `파일 sha가 올바르지 않습니다: ${shown(path)}` };
    } else if (baseFiles) {
      const existing = baseFiles.get(path);
      if (where.kind === 'pdf' && existing && existing.sha !== sha) {
        return { error: `이미 올라간 논문 PDF는 바꿀 수 없습니다: ${shown(path)}` };
      }
    }
    out.push({ path, mode: '100644', type: 'blob', sha });
  }
  return { entries: out };
}

/** Text without person ids, invite codes and control characters. */
export function scrubText(text) {
  return String(text ?? '').replace(CONTROL_CHARS, ' ').replace(PERSON_IN_TEXT, 'people/…').replace(CODE_IN_TEXT, '(초대 코드)');
}

/** The name as written into commit messages: no brackets (they delimit the name), no control characters. */
function messageName(name) {
  return String(name ?? '').replace(CONTROL_CHARS, ' ').replace(/\[/g, '(').replace(/\]/g, ')').trim() || '이름 없음';
}

/** `[<code name>] <first line of the client's message>`, at most 200 characters. */
export function commitMessageFor(name, message) {
  const first = scrubText(String(message ?? '').split(/\r\n|\r|\n/)[0]).replace(/\s+/g, ' ').trim();
  const text = first ? `[${messageName(name)}] ${first}` : `[${messageName(name)}]`;
  const chars = [...text];
  return chars.length <= COMMIT_MESSAGE_MAX ? text : `${chars.slice(0, COMMIT_MESSAGE_MAX - 1).join('')}…`;
}

/** { who, summary } of a commit message written by commitMessageFor (who is null for other commits). */
export function parseCommitLine(message) {
  const first = scrubText(String(message ?? '').split(/\r\n|\r|\n/)[0]).trim();
  const m = /^\[([^\]]{1,60})\]\s?(.*)$/.exec(first);
  return m ? { who: m[1], summary: m[2] } : { who: null, summary: first };
}

/**
 * Ids of papers tombstoned in library.json more than `maxAgeMs` before `now` (time of deletion: `deletedAt`, else the
 * tombstone's `updatedAt`). Only ids that fit the repo layout.
 */
export function purgeablePaperIds(library, now, maxAgeMs) {
  const papers = Array.isArray(library?.papers) ? library.papers : [];
  const ids = [];
  for (const p of papers) {
    if (!p || p.deleted !== true || !isPaperId(p.id)) continue;
    const at = deletedTime(p);
    if (Number.isFinite(at) && at > 0 && at < now - maxAgeMs && !ids.includes(p.id)) ids.push(p.id);
  }
  return ids;
}

/**
 * Of the age-eligible ids (`purgeablePaperIds`), those a purge may actually delete: the tombstone's deletion time
 * (`deletedAt`, else `updatedAt`) must be written by a client, so by itself it cannot prove a paper has been in the
 * 휴지통 for 30 days. `before` is library.json as of the newest commit at least `maxAgeMs` old (committer dates are
 * GitHub's, null when there is no such commit): an id is kept only when it was already tombstoned there with the same
 * deletion time — so a fresh tombstone with a back-dated `deletedAt` is not purged until it is genuinely that old.
 */
export function confirmedPurgeIds(library, before, now, maxAgeMs) {
  const earlier = new Map();
  for (const p of Array.isArray(before?.papers) ? before.papers : []) {
    if (p && p.deleted === true && isPaperId(p.id) && !earlier.has(p.id)) earlier.set(p.id, deletedTime(p));
  }
  const current = new Map();
  for (const p of Array.isArray(library?.papers) ? library.papers : []) {
    if (p && isPaperId(p.id) && !current.has(p.id)) current.set(p.id, deletedTime(p));
  }
  return purgeablePaperIds(library, now, maxAgeMs).filter((id) => earlier.get(id) === current.get(id));
}

function deletedTime(p) {
  return toMillis(p.deletedAt ?? p.updatedAt);
}

// ───────────────────────────── library.json changes ─────────────────────────────

/**
 * Commit summaries the app hides in 최근 활동 (js/ui/library-view.js QUIET_ACTIVITY — keep the two lists the same).
 * The Worker lets a commit carry one only when its tree really is that quiet: a person's own people/<me>/ files, or
 * library.json changes limited to progress counts. Anything else with such a summary gets the Worker's own.
 */
export const PERSONAL_SUMMARY = '내 메모·AI 결과 동기화';
export const QUIET_LIBRARY_SUMMARY = '논문 정보 갱신';
export const QUIET_SUMMARIES = new Set([PERSONAL_SUMMARY, QUIET_LIBRARY_SUMMARY]);
/** Record fields whose change alone is not an action on the shared library (progress counts, per-person UI). */
const QUIET_RECORD_FIELDS = new Set(['updatedAt', 'translatedCount', 'sentenceCount', 'pages', 'lastOpenedAt', 'starred']);
const QUIET_TOP_FIELDS = new Set(['version', 'updatedAt', 'folders', 'papers']);

/**
 * Parse a library.json blob as every client reads it (js/store/library.js normalizeLibrary): records are objects
 * with a non-empty string id; anything else in `folders` / `papers` is ignored by clients.
 * @param {Uint8Array} bytes
 * @returns {{ value: { top: Record<string, any>, folders: Map<string, any>, papers: Map<string, any> } } | { invalid: true }}
 */
export function parseLibrary(bytes) {
  let raw;
  try {
    raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return { invalid: true };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { invalid: true };
  const records = (list) => {
    const out = new Map();
    for (const x of Array.isArray(list) ? list : []) {
      if (x && typeof x === 'object' && !Array.isArray(x) && typeof x.id === 'string' && x.id && !out.has(x.id)) out.set(x.id, x);
    }
    return out;
  };
  return { value: { top: raw, folders: records(raw.folders), papers: records(raw.papers) } };
}

/**
 * What a new library.json changes against the one it replaces (`base` null: there was none).
 * - `dropped`: records of `base` missing from `next` (a delete must be a tombstone, which the 휴지통 can restore).
 * - counts of added, deleted (newly tombstoned), restored and otherwise changed records.
 * - `quiet`: only progress counts (QUIET_RECORD_FIELDS) and the file's own stamps changed.
 */
export function compareLibraries(base, next) {
  const out = { dropped: [], added: 0, deleted: 0, restored: 0, changed: 0, quiet: true };
  const empty = { top: {}, folders: new Map(), papers: new Map() };
  const b = base ?? empty;
  for (const key of new Set([...Object.keys(b.top), ...Object.keys(next.top)])) {
    if (!QUIET_TOP_FIELDS.has(key) && !sameJson(b.top[key], next.top[key])) out.quiet = false;
  }
  for (const kind of ['folders', 'papers']) {
    for (const [id, record] of b[kind]) {
      if (!next[kind].has(id)) out.dropped.push(`${kind === 'papers' ? '논문' : '폴더'} ${shown(record.title ?? record.name ?? id)}`);
    }
    for (const [id, record] of next[kind]) {
      const old = b[kind].get(id);
      if (!old) {
        out.added++;
        out.quiet = false;
        continue;
      }
      const was = old.deleted === true;
      const is = record.deleted === true;
      if (!was && is) out.deleted++;
      else if (was && !is) out.restored++;
      let loud = was !== is;
      for (const key of new Set([...Object.keys(old), ...Object.keys(record)])) {
        if (!QUIET_RECORD_FIELDS.has(key) && !sameJson(old[key], record[key])) loud = true;
      }
      if (loud) {
        out.quiet = false;
        if (was === is) out.changed++;
      }
    }
  }
  if (out.dropped.length) out.quiet = false;
  return out;
}

/**
 * The Worker's own summary of a tree's shared changes (used instead of a quiet summary the change does not fit).
 * @param {{ library?: ReturnType<typeof compareLibraries> | null, translations?: number, pdfs?: number }} change
 */
export function describeSharedChange({ library = null, translations = 0, pdfs = 0 }) {
  const parts = [];
  if (library) {
    const counts = [
      library.added && `추가 ${library.added}`, library.deleted && `삭제 ${library.deleted}`,
      library.restored && `복구 ${library.restored}`, library.changed && `수정 ${library.changed}`,
    ].filter(Boolean);
    parts.push(counts.length ? `폴더·논문 기록 변경(${counts.join(' · ')})` : '폴더·논문 기록 변경');
  }
  if (translations) parts.push(`번역 ${translations}편`);
  if (pdfs) parts.push(`PDF ${pdfs}개`);
  return parts.length ? `공용 서재 변경: ${parts.join(' · ')}` : '공용 서재 변경';
}

function sameJson(a, b) {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === b.length && a.every((v, i) => sameJson(v, b[i]));
  const ka = Object.keys(a).filter((k) => a[k] !== undefined);
  const kb = Object.keys(b).filter((k) => b[k] !== undefined);
  return ka.length === kb.length && ka.every((k) => sameJson(a[k], b[k]));
}

/** Files of the given papers among `paths`: papers/<id>/* and everyone's people/<x>/papers/<id>/*. */
export function paperFiles(paths, ids) {
  const wanted = new Set(ids);
  return [...paths].filter((path) => {
    const m = /^papers\/([^/]+)\//.exec(path) || /^people\/[^/]+\/papers\/([^/]+)\//.exec(path);
    return Boolean(m && wanted.has(m[1]));
  });
}

function toMillis(v) {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v) return /^\d+$/.test(v) ? Number(v) : Date.parse(v);
  return Number.NaN;
}

function shown(value) {
  let text;
  try {
    text = JSON.stringify(value);
  } catch {
    text = String(value);
  }
  text = String(text ?? '').replace(CONTROL_CHARS, ' ');
  return text.length > 120 ? `${text.slice(0, 117)}…` : text;
}
