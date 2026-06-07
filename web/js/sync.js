/* sync.js — オフライン↔オンライン同期エンジン。
   方針:
     1. ローカルの未同期変更(_dirty)を push
     2. since 以降にサーバーで更新された予定を pull → IndexedDB へマージ
     3. lastSync を更新
   競合は updated_at による Last-Write-Wins（サーバー・クライアント両方で判定）。 */

const Sync = {
  _running: false,
  _online: navigator.onLine,
  listeners: new Set(),

  onChange(fn) {
    this.listeners.add(fn);
  },
  _emit(status) {
    this.listeners.forEach((fn) => fn(status, this._online));
  },

  async run() {
    if (this._running) return;
    this._running = true;
    this._emit("syncing");
    try {
      const since = (await DB.getMeta("lastSync", 0)) || 0;
      const dirty = await DB.getDirty();
      // サーバーへ送る形に整形（内部フラグ _dirty は除外）
      const changes = dirty.map(({ _dirty, ...ev }) => ev);

      const res = await API.sync(since, changes);

      // push 成功した分は _dirty を解除（サーバー返却データで上書きされる）
      await DB.mergeFromServer(res.events);
      // push したがサーバー応答に含まれない可能性に備え、明示的にクリーン化
      for (const ev of dirty) {
        const fresh = await DB.getEvent(ev.id);
        if (fresh && fresh._dirty && fresh.updated_at <= ev.updated_at) {
          await DB.putEvent({ ...fresh, _dirty: false });
        }
      }

      if (res.users) await DB.setMeta("users", res.users);
      if (res.tags) await DB.setMeta("tags", res.tags);
      await DB.setMeta("lastSync", res.server_time);

      this._online = true;
      this._emit("synced");
      return res;
    } catch (err) {
      if (err.code === 401) {
        this._emit("unauthorized");
        throw err;
      }
      // ネットワーク不通 → オフライン扱い。ローカル変更は保持される。
      this._online = false;
      this._emit("offline");
    } finally {
      this._running = false;
    }
  },

  // 変更を保存してすぐ同期を試みる（オフラインでもローカルには確実に残る）
  async saveAndSync(event) {
    event.updated_at = Date.now();
    event._dirty = true;
    await DB.putEvent(event);
    // Background Sync 登録（対応ブラウザのみ。未対応でも下の run() で同期）
    if ("serviceWorker" in navigator && "SyncManager" in window) {
      try {
        const reg = await navigator.serviceWorker.ready;
        await reg.sync.register("sync-events");
      } catch (_) {}
    }
    this.run();
  },

  start() {
    window.addEventListener("online", () => {
      this._online = true;
      this.run();
    });
    window.addEventListener("offline", () => {
      this._online = false;
      this._emit("offline");
    });
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") this.run();
    });
    // SW からの同期要求
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.addEventListener("message", (e) => {
        if (e.data && e.data.type === "do-sync") this.run();
      });
    }
    // 定期同期（オンライン時のみ意味を持つ）
    setInterval(() => {
      if (navigator.onLine) this.run();
    }, 30000);
  },
};

window.Sync = Sync;
