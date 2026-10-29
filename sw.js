// 브루 카드 서비스 워커: 앱 셸 cache-first. 파일을 바꾸면 VERSION을 올린다.
const VERSION = 'v2';
const PREFIX = 'brew-card-';
const CACHE = PREFIX + VERSION;
const SHELL = ['./', './index.html', './manifest.webmanifest', './icon.svg', './icon-180.png',
  './library.html', './library.js', './brew-core.js', './library.webmanifest'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith(PREFIX) && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    try {
      const res = await fetch(req);
      if (res.ok && url.pathname.startsWith(new URL('./', self.location).pathname)) cache.put(req, res.clone());
      return res;
    } catch (err) {
      // 오프라인에서 캐시에 없는 페이지를 열면 브루 카드 홈으로
      if (req.mode === 'navigate') return (await cache.match('./')) || (await cache.match('./index.html')) || Response.error();
      throw err;
    }
  })());
});
