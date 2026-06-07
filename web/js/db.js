/* db.js — IndexedDB ラッパー。オフライン時のローカルデータストア。
   stores:
     events : 予定（_dirty=true は未同期のローカル変更）
     meta   : key/value（lastSync, currentUser, users など） */

const DB_NAME = "schedule-db";
const DB_VERSION = 1;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("events")) {
        db.createObjectStore("events", { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains("meta")) {
        db.createObjectStore("meta", { keyPath: "key" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(db, store, mode) {
  return db.transaction(store, mode).objectStore(store);
}

function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

const DB = {
  _db: null,
  async ready() {
    if (!this._db) this._db = await openDB();
    return this._db;
  },

  // ---- meta ----
  async getMeta(key, fallback = null) {
    const db = await this.ready();
    const row = await reqToPromise(tx(db, "meta", "readonly").get(key));
    return row ? row.value : fallback;
  },
  async setMeta(key, value) {
    const db = await this.ready();
    return reqToPromise(tx(db, "meta", "readwrite").put({ key, value }));
  },

  // ---- events ----
  async getAllEvents() {
    const db = await this.ready();
    const all = await reqToPromise(tx(db, "events", "readonly").getAll());
    return all.filter((e) => !e.deleted);
  },
  async getEvent(id) {
    const db = await this.ready();
    return reqToPromise(tx(db, "events", "readonly").get(id));
  },
  async putEvent(ev) {
    const db = await this.ready();
    return reqToPromise(tx(db, "events", "readwrite").put(ev));
  },
  async getDirty() {
    const db = await this.ready();
    const all = await reqToPromise(tx(db, "events", "readonly").getAll());
    return all.filter((e) => e._dirty);
  },
  // サーバーから来た正データで上書き（_dirty を立てない）
  async mergeFromServer(events) {
    const db = await this.ready();
    const store = tx(db, "events", "readwrite");
    for (const ev of events) {
      const local = await reqToPromise(store.get(ev.id));
      // ローカルに未同期の新しい変更があれば、サーバーが古い場合は維持
      if (local && local._dirty && local.updated_at > ev.updated_at) continue;
      store.put({ ...ev, _dirty: false });
    }
  },
};

window.DB = DB;
