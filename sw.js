// 「修正したのに反映されない」への対処。
// GitHub Pages は JS/CSS を max-age=600 で配信するため、更新を出しても
// 最大10分間は端末に残った古いファイルが使われていた（iOSはタブを閉じても消えない）。
//
// ここではネットワーク優先にする。毎回サーバーを見に行き、取れたらそれを返して
// キャッシュも更新する。通信できないときだけキャッシュを返す（機内・電波なしの保険）。
//
// ただし fetch(req) だけでは足りない。SW の中の fetch は元のリクエストの cache 設定を
// 引き継ぐため、既定のままだと端末のHTTPキャッシュを見に行って max-age=600 の間は
// 古いファイルを返す（＝「ネットワーク優先」と書いてあるのに更新が10分届かない）。
// 実測でも、既定では3回取得してサーバーへのリクエストは1回だった。
// cache:"no-cache" で毎回サーバーに確認させる。変わっていなければ304が返るので転送量は増えない。
const CACHE = "tencho-v2";

// 新しい sw.js を置いたらすぐ差し替える（古いSWが居座って更新が届かないのを防ぐ）
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(
  caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim())
));

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  // Supabase など別オリジンへの通信には一切触らない
  if (new URL(req.url).origin !== self.location.origin) return;

  e.respondWith(
    fetch(req, { cache: "no-cache" })
      .then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || Promise.reject(new Error("offline"))))
  );
});
