// 앱 셸만 캐시. /api 와 카카오맵(교차 출처)은 항상 네트워크.
const CACHE = 'traffic-map-v6';
const SHELL = [
  '/', '/index.html', '/app.js', '/style.css', '/manifest.webmanifest',
  '/icon.svg', '/icon-192.png', '/icon-512.png', '/icon-maskable-512.png', '/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request)));
});
