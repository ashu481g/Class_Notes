// Tiny IndexedDB key-value store. Everything for the current lecture (source file,
// clean audio, partial/complete transcript, notes, slide deck, voice clips, video)
// is kept here until a new input file is chosen, so a reload or crash loses nothing.

const DB = "lecture-notes-studio";
const STORE = "kv";

let dbPromise: Promise<IDBDatabase> | null = null;

function db(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    // Ask the browser not to evict our data under storage pressure.
    navigator.storage?.persist?.().catch(() => {});
  }
  return dbPromise;
}

function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  return db().then(
    (d) =>
      new Promise<T>((resolve, reject) => {
        const req = fn(d.transaction(STORE, mode).objectStore(STORE));
        req.onsuccess = () => resolve(req.result as T);
        req.onerror = () => reject(req.error);
      }),
  );
}

export const cache = {
  get: <T>(key: string) => run<T | undefined>("readonly", (s) => s.get(key)).catch(() => undefined),
  set: (key: string, value: unknown) => run<void>("readwrite", (s) => s.put(value, key)).catch(() => {}),
  del: (key: string) => run<void>("readwrite", (s) => s.delete(key)).catch(() => {}),
  clear: () => run<void>("readwrite", (s) => s.clear()).catch(() => {}),
};

/** Short stable hash for cache keys (FNV-1a). */
export function hash(text: string) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}
