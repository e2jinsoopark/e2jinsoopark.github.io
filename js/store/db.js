// IndexedDB wrapper: database 'paper-reader' v1.
//   files  key = repo path (e.g. 'papers/p_x/paper.pdf') → file record (see sync.js); index 'dirty'
//   meta   key/value (sync snapshot, settings that must not live in localStorage)
//   blobs  key = git blob sha → Uint8Array (content fetched from GitHub, e.g. PDFs opened on another device)
// Every helper opens its own short transaction; `update()` is the atomic read-modify-write primitive.

const DB_NAME = 'paper-reader';
const DB_VERSION = 1;
export const STORES = Object.freeze(['files', 'meta', 'blobs']);

/** Returned from an `update()` mutator to delete the record. */
export const DELETE = Symbol('db.delete');

let opening = null;

function open() {
  opening ??= new Promise((resolve, reject) => {
    let req;
    try {
      if (typeof indexedDB === 'undefined') throw new Error('indexedDB is not available');
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (err) {
      reject(storageError(err));
      return;
    }
    req.onupgradeneeded = () => {
      const idb = req.result;
      if (!idb.objectStoreNames.contains('files')) {
        // Clean records omit `dirty`, so the index only lists paths waiting to be pushed.
        idb.createObjectStore('files').createIndex('dirty', 'dirty');
      }
      if (!idb.objectStoreNames.contains('meta')) idb.createObjectStore('meta');
      if (!idb.objectStoreNames.contains('blobs')) idb.createObjectStore('blobs');
    };
    req.onsuccess = () => {
      const idb = req.result;
      // Another tab is upgrading the schema: let it, and reopen lazily on the next call.
      idb.onversionchange = () => { idb.close(); opening = null; };
      idb.onclose = () => { opening = null; };
      resolve(idb);
    };
    req.onerror = () => reject(storageError(req.error));
    req.onblocked = () => console.warn('[store] IndexedDB open is blocked by another tab');
  });
  opening.catch(() => { opening = null; });
  return opening;
}

/** Korean, user-presentable error for an IndexedDB failure (details go to the console). */
function storageError(cause) {
  console.warn('[store] IndexedDB', cause);
  const name = cause?.name || '';
  const message = name === 'QuotaExceededError'
    ? '브라우저 저장 공간이 부족합니다. 사용하지 않는 논문을 삭제하거나 브라우저 저장 공간을 확보한 뒤 다시 시도하세요.'
    : '브라우저 저장소(IndexedDB)를 사용할 수 없습니다. 시크릿 창이거나 사이트 데이터 저장이 차단되어 있는지 확인하세요.';
  const err = new Error(message, { cause });
  err.code = name === 'QuotaExceededError' ? 'quota' : 'storage';
  return err;
}

/**
 * Run `body(objectStore)` inside one transaction and resolve with its result once the
 * transaction commits (so a resolved write is durable).
 */
async function run(store, mode, body) {
  const idb = await open();
  return new Promise((resolve, reject) => {
    let tx;
    try {
      tx = idb.transaction(store, mode);
    } catch (err) {
      reject(storageError(err));
      return;
    }
    let result;
    let thrown = null;
    let requestError = null;
    tx.oncomplete = () => resolve(result);
    tx.onabort = () => reject(thrown || storageError(requestError || tx.error));
    // A failed request (e.g. "Failed to read large IndexedDB value") must abort the transaction: calling
    // preventDefault() here would cancel the abort, and the caller would resolve as if nothing was stored.
    tx.onerror = (e) => { requestError ??= e.target?.error ?? null; };
    // Errors thrown by callers' code (e.g. an update() mutator) abort the transaction and are rethrown as is.
    const guard = (fn) => (...args) => {
      try {
        return fn(...args);
      } catch (err) {
        thrown = err;
        try { tx.abort(); } catch { /* already finished */ }
        return undefined;
      }
    };
    guard(body)(tx.objectStore(store), (value) => { result = value; }, guard);
  });
}

/** Read a single request's result into the transaction result. */
const readInto = (makeRequest) => (os, done) => {
  const req = makeRequest(os);
  req.onsuccess = () => done(req.result);
};

export const db = {
  get(store, key) {
    return run(store, 'readonly', readInto((os) => os.get(key)));
  },
  put(store, key, val) {
    return run(store, 'readwrite', (os) => { os.put(val, key); });
  },
  del(store, key) {
    return run(store, 'readwrite', (os) => { os.delete(key); });
  },
  /** Primary keys, optionally limited by an IDBKeyRange. */
  keys(store, query) {
    return run(store, 'readonly', readInto((os) => os.getAllKeys(query)));
  },
  getAll(store, query) {
    return run(store, 'readonly', readInto((os) => os.getAll(query)));
  },
  clear(store) {
    return run(store, 'readwrite', (os) => { os.clear(); });
  },

  /** Primary keys of the records whose `index` matches `query` (all indexed records by default). */
  indexKeys(store, index, query) {
    return run(store, 'readonly', readInto((os) => os.index(index).getAllKeys(query)));
  },
  count(store, index, query) {
    return run(store, 'readonly', readInto((os) => (index ? os.index(index) : os).count(query)));
  },

  /**
   * Atomic read-modify-write. `mutate(current | undefined)` runs synchronously inside the
   * transaction and returns the new value, `undefined` (leave as is) or `DELETE`.
   * Resolves with the stored value (or undefined) after the transaction commits.
   */
  update(store, key, mutate) {
    return run(store, 'readwrite', (os, done, guard) => {
      const req = os.get(key);
      req.onsuccess = guard(() => {
        const next = mutate(req.result);
        if (next === undefined) { done(req.result); return; }
        if (next === DELETE) { os.delete(key); done(undefined); return; }
        os.put(next, key);
        done(next);
      });
    });
  },

  /** Visit every record with a cursor; `visit(value, key)` may return a new value, DELETE or undefined. */
  rewriteAll(store, visit) {
    return run(store, 'readwrite', (os, done, guard) => {
      let changed = 0;
      const req = os.openCursor();
      req.onsuccess = guard(() => {
        const cursor = req.result;
        if (!cursor) { done(changed); return; }
        const next = visit(cursor.value, cursor.primaryKey);
        if (next === DELETE) { cursor.delete(); changed++; } else if (next !== undefined) { cursor.update(next); changed++; }
        cursor.continue();
      });
    });
  },

  /** Throws the Korean storage error if IndexedDB cannot be opened. */
  async ready() {
    await open();
  },

  /** Close the connection and delete the whole database (this device's library, cached PDFs, sync state). */
  async destroy() {
    try { (await opening)?.close(); } catch { /* not open */ }
    opening = null;
    await new Promise((resolve, reject) => {
      const req = indexedDB.deleteDatabase(DB_NAME);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(storageError(req.error));
      // Other tabs hold the database open: their onversionchange closes it, then the delete completes.
      req.onblocked = () => console.warn('[store] database delete is waiting for other tabs to close it');
    });
  },
};
