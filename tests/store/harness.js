// Browser side of the store tests. One page = one device: real IndexedDB, real Library/SyncEngine,
// GitHub replaced by tests/store/fake-github.mjs through settings.github.apiBase.
const events = { status: [], change: [], remote: [], errors: [] };
window.__events = events;

/** Open the Library; `github` (if given) is saved into settings first (persisted across reloads). */
window.__boot = async ({ github = null, syncOptions } = {}) => {
  const { settings } = await import('/js/core/settings.js');
  if (github) settings.set({ github });
  const { Library } = await import('/js/store/library.js');
  const lib = await Library.open({ settings, syncOptions });
  lib.addEventListener('syncstatus', (e) => events.status.push({ at: Date.now(), ...e.detail }));
  lib.addEventListener('change', (e) => events.change.push({ at: Date.now(), ...e.detail }));
  lib.addEventListener('error', (e) => events.errors.push(e.detail.message));
  lib.sync.addEventListener('remotechange', (e) => events.remote.push({ at: Date.now(), ...e.detail }));
  window.__lib = lib;
  window.__settings = settings;
  return lib.sync.status;
};

/** Point sync at a repo (or turn it off with null) the way the settings screen does. */
window.__configure = async (github) => {
  window.__settings.set({ github: github || { owner: '', repo: '', token: '' } });
  await window.__lib.reconfigureSync();
  return window.__lib.sync.status;
};

/** Wait until the sync status matches (default: idle with nothing pending). */
window.__waitSync = async ({ state = 'idle', pending = 0, timeout = 20000 } = {}) => {
  const lib = window.__lib;
  await lib.whenSaved();
  const t0 = Date.now();
  for (;;) {
    const st = lib.sync.status;
    if (st.state === state && (pending == null || st.pending === pending)) return st;
    if (Date.now() - t0 > timeout) throw new Error(`timeout waiting for ${state}/${pending}: ${JSON.stringify(st)}`);
    await new Promise((r) => setTimeout(r, 50));
  }
};

window.__sha256 = async (bytes) => {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('');
};

/** Synthetic PDF-like bytes: a %PDF header + deterministic pseudo-random body (xorshift). */
window.__makePdf = (size, seed = 1) => {
  const out = new Uint8Array(size);
  out.set(new TextEncoder().encode('%PDF-1.7\n%synthetic test file\n'));
  let x = seed >>> 0 || 1;
  for (let i = 32; i < size; i++) {
    x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0;
    out[i] = x & 0xff;
  }
  return out;
};

/** Fetch a fixture PDF (served by the test runner through route interception, never stored in the repo). */
window.__fixture = async (name) => new Uint8Array(await (await fetch(`/__fixture__/${name}.pdf`)).arrayBuffer());

window.__dump = () => {
  const lib = window.__lib;
  return {
    folders: lib.folders.map((f) => ({ id: f.id, name: f.name, parentId: f.parentId })),
    papers: lib.papers.map((p) => ({ id: p.id, title: p.title, folderId: p.folderId, starred: p.starred, size: p.size })),
    status: lib.sync.status,
  };
};

/** Raw rows of the IndexedDB 'files' store, without the data payloads. */
window.__localFiles = async () => {
  const { db } = await import('/js/store/db.js');
  const keys = await db.keys('files');
  const out = {};
  for (const k of keys) {
    const r = await db.get('files', k);
    out[k] = { dirty: Boolean(r.dirty), deleted: Boolean(r.deleted), baseSha: r.baseSha, size: r.data?.length ?? r.data?.byteLength ?? 0 };
  }
  return out;
};

window.__blobKeys = async () => {
  const { db } = await import('/js/store/db.js');
  return db.keys('blobs');
};

// ---------------------------------------------------------------- several libraries in one page (SHARED.md §3.1)

/** Extra libraries by key (e.g. 'team'); 'mine' is window.__lib from __boot. Events per key. */
window.__libs = {};
window.__eventsBy = {};
window.__L = (key = 'mine') => (key === 'mine' ? window.__lib : window.__libs[key]);

/**
 * Open a relay library through the (fake) relay with openSharedLibrary(): 공용 서재 by default, or the code's own
 * library with `lib: 'mine'` and GET /shared's `libraryId` (plus `personId` / `label` as the app passes them).
 */
window.__openShared = async ({ key = 'team', relayUrl, code, name, syncOptions, lib: libId, libraryId, personId, label } = {}) => {
  const { openSharedLibrary } = await import('/js/store/library.js');
  const extra = Object.fromEntries(Object.entries({ lib: libId, libraryId, personId, label }).filter(([, v]) => v !== undefined));
  const lib = await openSharedLibrary({ relayUrl, code, name, syncOptions, ...extra });
  const ev = { status: [], change: [], remote: [], errors: [] };
  lib.addEventListener('syncstatus', (e) => ev.status.push({ at: Date.now(), ...e.detail }));
  lib.addEventListener('change', (e) => ev.change.push({ at: Date.now(), ...e.detail }));
  lib.addEventListener('error', (e) => ev.errors.push(e.detail.message));
  lib.sync.addEventListener('remotechange', (e) => ev.remote.push({ at: Date.now(), ...e.detail }));
  window.__libs[key] = lib;
  window.__eventsBy[key] = ev;
  return { id: lib.id, label: lib.label, prefix: lib.personalPrefix, rootPrefix: lib.rootPrefix, status: lib.sync.status };
};

/** GET /shared of the (fake) relay for `code`, as the app asks it. */
window.__sharedInfo = async (relayUrl, code) => (await fetch(`${relayUrl}/shared`, { headers: { Authorization: `Bearer ${code}` } })).json();

window.__waitLib = async (key, { state = 'idle', pending = 0, timeout = 20000 } = {}) => {
  const lib = window.__L(key);
  await lib.whenSaved();
  const t0 = Date.now();
  for (;;) {
    const st = lib.sync.status;
    if (st.state === state && (pending == null || st.pending === pending)) return st;
    if (Date.now() - t0 > timeout) throw new Error(`timeout waiting for ${key} ${state}/${pending}: ${JSON.stringify(st)}`);
    await new Promise((r) => setTimeout(r, 50));
  }
};

window.__dumpLib = (key) => {
  const lib = window.__L(key);
  return {
    folders: lib.folders.map((f) => ({ id: f.id, name: f.name, parentId: f.parentId })),
    papers: lib.papers.map((p) => ({ id: p.id, title: p.title, folderId: p.folderId, addedBy: p.addedBy ?? null })),
    trash: lib.trash().map((t) => ({ kind: t.kind, id: t.id, name: t.name, deletedBy: t.deletedBy, deletedAt: t.deletedAt })),
    status: lib.sync.status,
  };
};

/** IndexedDB database names on this origin. */
window.__idbNames = async () => (await indexedDB.databases()).map((d) => d.name).sort();

/** Keys of the 'files' store of IndexedDB database `name`. */
window.__filesOf = async (name) => {
  const { openDatabase } = await import('/js/store/db.js');
  return openDatabase(name).keys('files');
};

window.__harnessReady = true;
