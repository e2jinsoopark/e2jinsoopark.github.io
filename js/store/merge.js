// Merge rules for the synced JSON files (pure functions, no I/O). Used by the sync engine and by in-memory
// models (Library, AnnotationStore) that reconcile their state with stored versions.

const MAX_AI_CHAT = 200;
const MAX_AI_EXPLANATIONS = 100;

/** library.json: folders and papers merge per item id. */
export function mergeLibrary(local, remote, base = null) {
  return {
    ...remote,
    ...local,
    version: 1,
    updatedAt: newerTime(local.updatedAt, remote.updatedAt),
    folders: mergeRecords(local.folders, remote.folders, base?.folders),
    papers: mergeRecords(local.papers, remote.papers, base?.papers),
  };
}

/** annotations.json: items merge per id (tombstones included). */
export function mergeAnnotations(local, remote, base = null) {
  return {
    ...remote,
    ...local,
    version: 1,
    updatedAt: newerTime(local.updatedAt, remote.updatedAt),
    items: mergeRecords(local.items, remote.items, base?.items),
  };
}

/**
 * translation.json: union of items. On a sid present on both sides the higher segmentation version wins
 * (a sid can name a different sentence after resegmentation), local on a tie. Nothing is dropped wholesale:
 * every reader validates items by `h === hash(sentence.text)`, so items from either version stay usable.
 */
export function mergeTranslation(local, remote) {
  if ((local.targetLang || 'ko') !== (remote.targetLang || 'ko')) return local;
  const ls = Number(local.segVersion) || 0;
  const rs = Number(remote.segVersion) || 0;
  const li = isObject(local.items) ? local.items : {};
  const ri = isObject(remote.items) ? remote.items : {};
  return {
    ...remote,
    ...local,
    segVersion: ls || rs ? Math.max(ls, rs) : local.segVersion ?? remote.segVersion,
    updatedAt: newerTime(local.updatedAt, remote.updatedAt),
    items: rs > ls ? { ...li, ...ri } : { ...ri, ...li },
  };
}

/**
 * ai.json, per top-level key:
 * - `chat` and `explanations` are lists of records with ids: union by id (nothing another device or tab
 *   appended is lost), in time order, capped. `chatClearedAt` (max of both) drops messages from before a clear.
 * - other keys (summary, keyPoints, related, …): with a base, a key changed on one side only takes that side;
 *   a key changed on both sides takes the value with the newer createdAt/fetchedAt, else the newer file's.
 */
export function mergeAi(local, remote, base = null) {
  const localNewer = toMillis(local.updatedAt) >= toMillis(remote.updatedAt);
  const out = { version: 1, updatedAt: newerTime(local.updatedAt, remote.updatedAt) };
  const keys = new Set([...Object.keys(remote), ...Object.keys(local)]);
  for (const k of ['version', 'updatedAt', 'chat', 'explanations', 'chatClearedAt']) keys.delete(k);
  for (const k of keys) {
    const lv = local[k];
    const rv = remote[k];
    let v;
    if (deepEqual(lv, rv)) v = lv;
    else if (base && deepEqual(lv, base[k])) v = rv;
    else if (base && deepEqual(rv, base[k])) v = lv;
    else if (lv === undefined) v = rv;
    else if (rv === undefined) v = lv;
    else {
      const ls = valueStamp(lv);
      const rs = valueStamp(rv);
      v = ls && rs && ls !== rs ? (ls > rs ? lv : rv) : localNewer ? lv : rv;
    }
    if (v !== undefined) out[k] = v;
  }
  const cleared = Math.max(toMillis(local.chatClearedAt), toMillis(remote.chatClearedAt));
  if (cleared) out.chatClearedAt = cleared;
  const chat = unionById(local.chat, remote.chat, { stamp: 'ts', after: cleared, cap: MAX_AI_CHAT });
  if (chat) out.chat = chat;
  const explanations = unionById(local.explanations, remote.explanations, { stamp: 'createdAt', cap: MAX_AI_EXPLANATIONS });
  if (explanations) out.explanations = explanations;
  return out;
}

/** When an ai.json value (summary, keyPoints, related) was produced. */
function valueStamp(v) {
  return isObject(v) ? toMillis(v.createdAt ?? v.fetchedAt ?? v.updatedAt) : 0;
}

/**
 * Union of two record lists by id (local wins on the same id), in time order (stable: ties keep list order),
 * dropping records stamped at or before `after`, keeping the newest `cap`. Undefined when neither is a list.
 */
function unionById(local, remote, { stamp, after = 0, cap = Infinity }) {
  if (!Array.isArray(local) && !Array.isArray(remote)) return undefined;
  const byId = new Map();
  const order = [];
  const add = (item, overwrite) => {
    if (!item || typeof item !== 'object') return;
    const id = item.id != null ? `id:${item.id}` : `json:${JSON.stringify(item)}`;
    if (!byId.has(id)) order.push(id);
    if (overwrite || !byId.has(id)) byId.set(id, item);
  };
  for (const item of Array.isArray(remote) ? remote : []) add(item, false);
  for (const item of Array.isArray(local) ? local : []) add(item, true);
  const list = order.map((id, i) => ({ item: byId.get(id), i, t: toMillis(byId.get(id)[stamp]) }))
    .filter((x) => !after || x.t > after)
    .sort((a, b) => a.t - b.t || a.i - b.i)
    .map((x) => x.item);
  return list.length > cap ? list.slice(list.length - cap) : list;
}


/**
 * Merge two lists of `{ id, updatedAt, deleted? }` records.
 * Without a base version of an item the newer `updatedAt` wins (a tombstone wins a tie, then local).
 * With one, fields changed on only one side are kept from that side (so a rename on one device and
 * a move on another both survive), and fields changed on both sides take the newer item's value.
 */
export function mergeRecords(local, remote, base = null) {
  const valid = (x) => x && typeof x === 'object' && x.id != null;
  const l = Array.isArray(local) ? local.filter(valid) : [];
  const r = Array.isArray(remote) ? remote.filter(valid) : [];
  const remoteById = new Map(r.map((x) => [x.id, x]));
  const baseById = Array.isArray(base) ? new Map(base.filter(valid).map((x) => [x.id, x])) : null;
  const out = [];
  const seen = new Set();
  for (const item of l) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    const other = remoteById.get(item.id);
    out.push(other ? mergeItem(item, other, baseById?.get(item.id) ?? null) : item);
  }
  for (const item of r) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
  }
  return out;
}

function mergeItem(l, r, b) {
  if (deepEqual(l, r)) return l;
  const lt = toMillis(l.updatedAt);
  const rt = toMillis(r.updatedAt);
  const winner = lt > rt ? l : rt > lt ? r : r.deleted && !l.deleted ? r : l;
  if (!b) return winner;
  const out = {};
  for (const k of new Set([...Object.keys(l), ...Object.keys(r)])) {
    if (k === 'updatedAt') continue;
    const lv = l[k];
    const rv = r[k];
    const v = deepEqual(lv, rv) ? lv : deepEqual(lv, b[k]) ? rv : deepEqual(rv, b[k]) ? lv : winner[k];
    if (v !== undefined) out[k] = v;
  }
  // A result identical to the newest side is that side's record. A combination of both sides gets a stamp
  // newer than either: a later merge without a base (another tab, the in-memory library, an annotation
  // store) then prefers the combined record instead of reverting one side's fields on a stamp tie.
  const max = Math.max(lt, rt);
  for (const side of [winner, l, r]) {
    if (toMillis(side.updatedAt) === max && sameFields(out, side)) return side;
  }
  out.updatedAt = max + 1;
  return out;
}

/** Equal apart from updatedAt. */
function sameFields(out, item) {
  const { updatedAt, ...rest } = item;
  return deepEqual(out, rest);
}

/** Structural equality for JSON values; a key holding `undefined` counts as absent. */
export function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  const ka = Object.keys(a).filter((k) => a[k] !== undefined);
  const kb = Object.keys(b).filter((k) => b[k] !== undefined);
  return ka.length === kb.length && ka.every((k) => deepEqual(a[k], b[k]));
}

/** Epoch ms from a number or an ISO string (0 when missing). */
export function toMillis(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : 0;
  }
  return 0;
}

function newerTime(a, b) {
  return toMillis(a) >= toMillis(b) ? a ?? b : b;
}

function isObject(v) {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}
