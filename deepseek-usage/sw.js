'use strict';

// 只缓存本应用自己的静态文件，让它离线也能打开。
// 跨域请求（也就是带着 API Key 的余额接口）一律不拦截、不缓存。
// 改了静态文件清单时，把版本号 +1。
const CACHE = 'dsu-v1';
const SHELL = [
  './',
  'index.html',
  'style.css',
  'app.js',
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png',
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

// stale-while-revalidate：先给缓存，后台更新，下次打开就是新版。
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  if (new URL(req.url).origin !== self.location.origin) return;

  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(req, { ignoreSearch: true });
    const network = fetch(req, { cache: 'no-cache' })
      .then((res) => { if (res.ok && res.type === 'basic') cache.put(req, res.clone()); return res; })
      .catch(() => null);
    if (cached) { e.waitUntil(network); return cached; }
    return (await network) || (req.mode === 'navigate' ? cache.match('index.html') : Response.error());
  })());
});
