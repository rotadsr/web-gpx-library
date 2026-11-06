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

  function newUid() {
    return (crypto.randomUUID && crypto.randomUUID()) ||
      'r-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  /**
   * Save (insert or update) a route. Returns the record's id.
   * Every record carries a stable `uid` (survives export/import, unlike the
   * local autoincrement id) so incremental backups can track it as one file.
   */
  function saveRoute(route) {
    return new Promise((resolve, reject) => {
      const tx    = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      const data  = { ...route, updatedAt: new Date().toISOString() };
      delete data._parsed; // transient in-memory cache of GPXParser.parse(); never persist a stale shape
      if (!data.createdAt) data.createdAt = data.updatedAt;

      let req;
      if (typeof data.id === 'number') {
        // In-memory copies may predate uids; keep the stored one rather than dropping it.
        const getReq = store.get(data.id);
        getReq.onsuccess = e => {
          const existing = e.target.result;
          if (!data.uid) data.uid = (existing && existing.uid) || newUid();
          req = store.put(data);
          req.onsuccess = ev => resolve(ev.target.result);
          req.onerror   = ev => reject(ev.target.error);
        };
        getReq.onerror = e => reject(e.target.error);
      } else {
        const d = { ...data };
        delete d.id;
        if (!d.uid) d.uid = newUid();
        req = store.add(d);
        req.onsuccess = e => resolve(e.target.result);
        req.onerror   = e => reject(e.target.error);
      }
    });
  }

  /** Give records saved before uids existed one. Doesn't touch updatedAt. */
  function ensureUids() {
    return new Promise((resolve, reject) => {
      const tx  = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      const req = store.openCursor();
      req.onsuccess = e => {
        const cursor = e.target.result;
        if (!cursor) return;
        if (!cursor.value.uid) cursor.update({ ...cursor.value, uid: newUid() });
        cursor.continue();
      };
      req.onerror = e => reject(e.target.error);
      tx.oncomplete = () => resolve();
      tx.onerror    = e => reject(e.target.error);
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

  /**
   * Serialize the full library to a JSON string for download.
   * @param {object} extra  - additional top-level collections to bundle in
   *                          (e.g. { places, placeCategories }); routes always
   *                          carry their own per-route data (e.g. logbook) as-is.
   */
  async function exportLibrary(extra = {}) {
    const routes = await getAllRoutes();
    return JSON.stringify({
      version:    1,
      exportedAt: new Date().toISOString(),
      routes,
      ...extra,
    }, null, 2);
  }

  /**
   * Import routes (and any bundled extra collections) from a JSON string.
   * @param {string} jsonString  - serialized library (from exportLibrary)
   * @param {'merge'|'overwrite'} mode
   * @param {function} [onExtra] - called with the full parsed object (minus
   *                               routes handling, which Storage owns) so the
   *                               caller can apply its own collections (e.g.
   *                               places/placeCategories) — not invoked when
   *                               jsonString is a bare routes array.
   * @returns {number} count of routes imported
   */
  async function importLibrary(jsonString, mode, onExtra) {
    let data;
    try {
      data = JSON.parse(jsonString);
    } catch {
      throw new Error('Invalid JSON file');
    }

    const isBareArray = Array.isArray(data);
    const routes = isBareArray ? data : (data.routes || []);
    const hasExtra = !isBareArray && data && (data.places || data.placeCategories);
    if (!routes.length && !hasExtra) throw new Error('No routes found in file');

    if (mode === 'overwrite') {
      await clearAll();
    }

    const seenUids = new Set(mode === 'overwrite' ? [] : (await getAllRoutes()).map(r => r.uid));
    let count = 0;
    for (const route of routes) {
      const r = { ...route };
      delete r.id; // always insert as new record to avoid key conflicts
      if (r.uid && seenUids.has(r.uid)) delete r.uid; // merged duplicate: gets a fresh uid
      if (r.uid) seenUids.add(r.uid);
      await saveRoute(r);
      count++;
    }

    if (typeof onExtra === 'function' && !isBareArray) onExtra(data);

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

  return { init, saveRoute, ensureUids, getAllRoutes, deleteRoute, exportLibrary, importLibrary };
})();
