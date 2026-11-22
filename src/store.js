// Autosave to IndexedDB so a refresh doesn't lose work. Everything stays on this device.
const DB = 'spritesheetviewer', STORE = 'kv';

function open() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

export async function put(key, value) {
  try {
    const db = await open();
    await new Promise((res, rej) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(value, key);
      tx.oncomplete = res; tx.onerror = () => rej(tx.error);
    });
    db.close();
    return true;
  } catch { return false; }
}

export async function get(key) {
  try {
    const db = await open();
    const v = await new Promise((res, rej) => {
      const r = db.transaction(STORE).objectStore(STORE).get(key);
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
    db.close();
    return v;
  } catch { return undefined; }
}
