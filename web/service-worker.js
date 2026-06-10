/* 撤去用 Service Worker。
   このアプリは Service Worker を廃止しました（常にサーバーの最新を表示）。
   既にインストール済みの端末は、次回アクセス時にこの版へ更新され、
   自分自身を登録解除し、旧キャッシュを全削除してから通常のページに戻ります。
   ※ /service-worker.js は no-cache 配信なので、既存クライアントもすぐ更新されます。 */

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // 旧キャッシュを全削除
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
      // 自分自身を登録解除（以降このページは SW なしで動く）
      await self.registration.unregister();
      // 制御中のウィンドウをリロードして SW なしの状態に切り替える
      const clients = await self.clients.matchAll({ type: "window" });
      clients.forEach((c) => c.navigate(c.url));
    })()
  );
});

/* fetch には一切介入しない（キャッシュせず、常にネットワーク＝サーバーの最新を使う）。 */
