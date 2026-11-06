// 브루 카드 서비스 워커: 앱 셸 cache-first.
// VERSION은 손으로 올리지 않는다. deploy-viewer.sh가 배포할 때 뷰어 파일 내용의 해시로 바꿔 넣는다.
const VERSION = 'd31c7c446e6a';
const PREFIX = 'brew-card-';
const CACHE = PREFIX + VERSION;
const SHELL = ['./', './index.html', './card.js', './pwa.js', './manifest.webmanifest', './icon.svg', './icon-180.png',
  './library.html', './library.js', './brew-core.js', './library.webmanifest'];

self.addEventListener('install', (e) => {
  // 브라우저 HTTP 캐시에 남은 옛 파일이 섞이지 않게 늘 서버에서 새로 받는다 (GitHub Pages는 10분 캐시)
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
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
  if (/^(localhost|127\.0\.0\.1)$/.test(url.hostname)) return; // 로컬 확인 때는 늘 새 파일
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
