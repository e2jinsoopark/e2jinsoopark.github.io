// In-memory stand-in for js/store/db.js (same API), so Library + SyncEngine run in Node tests.
// Values are structured-cloned on the way in and out, as IndexedDB does. Also installs a minimal
// IDBKeyRange (bound / only), which sync.js uses for key ranges.
import { DELETE } from '../../js/store/db.js';

export function installKeyRange() {
  if (globalThis.IDBKeyRange) return;
  globalThis.IDBKeyRange = {
    bound: (lower, upper) => ({ includes: (k) => k >= lower && k <= upper }),
    only: (value) => ({ includes: (k) => k === value }),
  };
}

/** A fresh, empty database called `name` (the name scopes the engine's lock and channel, as in the browser). */
export function memoryDb(name) {
  installKeyRange();
  const stores = { files: new Map(), meta: new Map(), blobs: new Map() };
  const clone = (v) => (v === undefined ? undefined : structuredClone(v));
  const match = (query, key) => !query || query.includes(key);
  const indexed = (store, index, query) => [...stores[store]]
    .filter(([, v]) => v && v[index] !== undefined && match(query, v[index]))
    .map(([k]) => k)
    .sort();
  return {
    name,
    /** Raw access for assertions (do not mutate). */
    stores,
    async get(store, key) { return clone(stores[store].get(key)); },
    async put(store, key, val) { stores[store].set(key, clone(val)); },
    async del(store, key) { stores[store].delete(key); },
    async keys(store, query) { return [...stores[store].keys()].filter((k) => match(query, k)).sort(); },
    async getAll(store, query) {
      return [...stores[store]].filter(([k]) => match(query, k)).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, v]) => clone(v));
    },
    async clear(store) { stores[store].clear(); },
    async indexKeys(store, index, query) { return indexed(store, index, query); },
    async count(store, index, query) {
      if (!index) return [...stores[store].keys()].filter((k) => match(query, k)).length;
      return indexed(store, index, query).length;
    },
    async update(store, key, mutate) {
      const next = mutate(clone(stores[store].get(key)));
      if (next === undefined) return clone(stores[store].get(key));
      if (next === DELETE) { stores[store].delete(key); return undefined; }
      stores[store].set(key, clone(next));
      return next;
    },
    async rewriteAll(store, visit) {
      let changed = 0;
      for (const [k, v] of [...stores[store]]) {
        const next = visit(clone(v), k);
        if (next === DELETE) { stores[store].delete(k); changed++; } else if (next !== undefined) { stores[store].set(k, clone(next)); changed++; }
      }
      return changed;
    },
    async ready() {},
    async destroy() { for (const s of Object.values(stores)) s.clear(); },
  };
}
