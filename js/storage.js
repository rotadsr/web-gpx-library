/**
 * Storage — IndexedDB wrapper for the GPX Library.
 * Stores route records (metadata + full GPX XML) persistently in the browser.
 */

const Storage = (() => {

  const DB_NAME    = 'gpx-library';
  const DB_VERSION = 1;
  const STORE      = 'routes';

  let db = null;

  function init() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);

      req.onupgradeneeded = e => {
        const database = e.target.result;
        if (!database.objectStoreNames.contains(STORE)) {
          database.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
        }
      };

      req.onsuccess = e => {
        db = e.target.result;
        resolve();
      };

      req.onerror = e => reject(e.target.error);
    });
  }

  /** Save (insert or update) a route. Returns the record's id. */
  function saveRoute(route) {
    return new Promise((resolve, reject) => {
      const tx    = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      const data  = { ...route, updatedAt: new Date().toISOString() };
      if (!data.createdAt) data.createdAt = data.updatedAt;

      let req;
      if (typeof data.id === 'number') {
        req = store.put(data);
      } else {
        const d = { ...data };
        delete d.id;
        req = store.add(d);
      }

      req.onsuccess = e => resolve(e.target.result);
      req.onerror   = e => reject(e.target.error);
    });
  }

  function getAllRoutes() {
    return new Promise((resolve, reject) => {
      const tx  = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).getAll();
      req.onsuccess = e => resolve(e.target.result);
      req.onerror   = e => reject(e.target.error);
    });
  }

  function deleteRoute(id) {
    return new Promise((resolve, reject) => {
      const tx  = db.transaction(STORE, 'readwrite');
      const req = tx.objectStore(STORE).delete(id);
      req.onsuccess = () => resolve();
      req.onerror   = e => reject(e.target.error);
    });
  }

  /** Serialize the full library to a JSON string for download. */
  async function exportLibrary() {
    const routes = await getAllRoutes();
    return JSON.stringify({
      version:    1,
      exportedAt: new Date().toISOString(),
      routes,
    }, null, 2);
  }

  /**
   * Import routes from a JSON string.
   * @param {string} jsonString  - serialized library (from exportLibrary)
   * @param {'merge'|'overwrite'} mode
   * @returns {number} count of routes imported
   */
  async function importLibrary(jsonString, mode) {
    let data;
    try {
      data = JSON.parse(jsonString);
    } catch {
      throw new Error('Invalid JSON file');
    }

    const routes = Array.isArray(data) ? data : (data.routes || []);
    if (!routes.length) throw new Error('No routes found in file');

    if (mode === 'overwrite') {
      await clearAll();
    }

    let count = 0;
    for (const route of routes) {
      const r = { ...route };
      delete r.id; // always insert as new record to avoid key conflicts
      await saveRoute(r);
      count++;
    }
    return count;
  }

  function clearAll() {
    return new Promise((resolve, reject) => {
      const tx  = db.transaction(STORE, 'readwrite');
      const req = tx.objectStore(STORE).clear();
      req.onsuccess = () => resolve();
      req.onerror   = e => reject(e.target.error);
    });
  }

  return { init, saveRoute, getAllRoutes, deleteRoute, exportLibrary, importLibrary };
})();
