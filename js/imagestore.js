// Original image files, keyed by imageId, in IndexedDB so images survive a reload.
// Annotations stay in localStorage (state.js); this only holds the pixels. Every function
// resolves quietly when IndexedDB is unavailable, and the app falls back to re-dropping files.
const DB_NAME = 'annotater-images';
const STORE = 'images';

let dbPromise = null;

function openDb() {
  if (!globalThis.indexedDB) return Promise.resolve(null);
  dbPromise ??= new Promise((resolve) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      console.warn('IndexedDB unavailable', req.error);
      resolve(null);
    };
  });
  return dbPromise;
}

async function run(mode, fn) {
  const db = await openDb();
  if (!db) return undefined;
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(req?.result);
    tx.onerror = tx.onabort = () => reject(tx.error);
  });
}

export const putImage = (imageId, blob) => run('readwrite', (s) => s.put(blob, imageId));
export const getImage = (imageId) => run('readonly', (s) => s.get(imageId));

export function deleteImages(imageIds) {
  if (!imageIds.length) return Promise.resolve();
  return run('readwrite', (s) => imageIds.forEach((id) => s.delete(id))).catch((e) => console.warn('Could not delete stored images', e));
}

// Ask the browser not to evict our data under storage pressure. Best effort.
export const requestPersistence = () => navigator.storage?.persist?.().catch(() => false);
