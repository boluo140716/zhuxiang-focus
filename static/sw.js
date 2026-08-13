/* 篆香 Service Worker：静态资源离线缓存 */
const CACHE = "yizhuxiang-v80";
const ASSETS = [
  "/", "/index.html", "/app.js?v=80", "/style.css?v=80",
  "/manifest.webmanifest", "/icons/icon-192.png", "/icons/icon-512.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  const url = new URL(e.request.url);
  if (url.pathname.startsWith("/api/")) return;  // 接口永不缓存
  // 网络优先：在线永远拿最新，离线回退缓存
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((cache) => cache.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request).then((hit) => {
        if (hit) return hit;
        if (e.request.mode === "navigate") return caches.match("/index.html");
        return Response.error();
      }))
  );
});
