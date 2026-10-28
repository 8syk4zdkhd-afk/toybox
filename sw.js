/*
  TOYBOX — sw.js (the "service worker")
  A little helper that keeps a copy of the app on your phone,
  so ToyBox opens even with no internet.
  It always tries the internet first, so you get the newest version when online.
  (Your songs aren't here: they're saved separately and never leave your phone.)
*/

const CACHE = 'toybox-v22';
const FILES = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './storage.js',
  './covers.js',
  './cloud.js',
  './facts-worker.js',
  './stretch-worker.js',
  './manifest.json',
  './icons/toybox-icon-180-v5.png',
  './icons/toybox-icon-192-v5.png',
  './icons/toybox-icon-512-v5.png',
  './icons/toybox-favicon-v5.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;

  event.respondWith((async () => {
    const saved = await caches.match(request, { ignoreSearch: true });

    // Ask the internet for the newest copy, and save it for next time.
    const fresh = fetch(new Request(request.url, { cache: 'no-cache', credentials: 'same-origin' }))
      .then(async (response) => {
        if (response.ok) {
          const cache = await caches.open(CACHE);
          await cache.put(request.url, response.clone());
        }
        return response;
      });

    if (!saved) {
      return fresh.catch(() => caches.match('./index.html'));
    }
    // Slow or no internet? Use the saved copy after 3 seconds.
    const wait = new Promise((resolve) => setTimeout(() => resolve(saved), 3000));
    return Promise.race([fresh.catch(() => saved), wait]);
  })());
});
