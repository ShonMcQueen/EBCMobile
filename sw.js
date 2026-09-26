// Сервис-воркер: хранит файлы приложения на телефоне, чтобы оно открывалось без интернета.
// При изменении кода увеличьте номер версии — телефон подтянет новые файлы.
const CACHE = 'mobile-ebc-v2';
const ASSETS = [
  './', 'index.html', 'app.js', 'worker.js', 'config.js', 'zip.min.js',
  'manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Сначала отдаём сохранённую копию (быстро и без интернета), параллельно тихо обновляем её из сети.
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(
    caches.match(req, { ignoreSearch: true }).then(hit => {
      const net = fetch(req).then(res => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(req, copy));
        }
        return res;
      }).catch(() => hit);
      return hit || net;
    })
  );
});
