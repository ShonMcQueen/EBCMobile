// Сервис-воркер: хранит файлы приложения на телефоне, чтобы оно открывалось без интернета.
// Есть интернет — берём свежие файлы с сайта (и обновляем копию), нет — открываем сохранённую копию.
// При изменении кода увеличьте номер версии.
const CACHE = 'mobile-ebc-v4';
const ASSETS = [
  './', 'index.html', 'app.js', 'worker.js', 'config.js', 'zip.min.js',
  'manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png',
  'LiberationSerif-Regular.ttf', 'LiberationSerif-Bold.ttf'
];

self.addEventListener('install', e => {
  // cache: 'reload' — мимо кэша браузера, чтобы не сохранить старую версию файла
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(ASSETS.map(u => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith((async () => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 4000);
    try {
      const res = await fetch(req.url, { cache: 'no-cache', signal: ctrl.signal, credentials: 'same-origin' });
      clearTimeout(timer);
      if (res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(req.url, copy));
      }
      return res;
    } catch {
      clearTimeout(timer);
      const hit = await caches.match(req, { ignoreSearch: true });
      return hit || Response.error();
    }
  })());
});
