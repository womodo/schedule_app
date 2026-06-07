/* Service Worker — アプリ本体をキャッシュしてオフラインでも起動できるようにする。
   ※ API(/api/*) はキャッシュしない。データは IndexedDB がオフラインの真実とする。 */

const CACHE = "schedule_app-v20";

// オフライン起動に必要な「アプリの殻(App Shell)」
const APP_SHELL = [
  "/",
  "/index.html",
  "/manifest.json",
  "/css/style.css",
  "/js/holidays.js",
  "/js/db.js",
  "/js/api.js",
  "/js/sync.js",
  "/js/app.js",
  "/icons/icon.svg",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // API はキャッシュ介入しない（必ずネットワーク、失敗はアプリ側で処理）
  if (url.pathname.startsWith("/api/")) return;

  // 画面遷移(ナビゲーション)は network-first → 失敗時にキャッシュした殻を返す
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req).catch(() => caches.match("/index.html"))
    );
    return;
  }

  // それ以外(静的アセット)は cache-first
  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((resp) => {
        if (resp.ok && url.origin === self.location.origin) {
          const copy = resp.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return resp;
      });
    })
  );
});

// Background Sync 対応ブラウザでは、復帰時にクライアントへ同期を促す
self.addEventListener("sync", (event) => {
  if (event.tag === "sync-events") {
    event.waitUntil(
      self.clients.matchAll().then((clients) =>
        clients.forEach((c) => c.postMessage({ type: "do-sync" }))
      )
    );
  }
});
