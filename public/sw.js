// Only this app's directory/cache is managed: other Pages sites share the origin.
const SCOPE = self.registration.scope;
const PREFIX = `w3ds-shell:${SCOPE}:`;
const CACHE = `${PREFIX}v2`;
const INDEX = new URL('index.html', SCOPE).href;
const SHELL = ['./', 'index.html', 'manifest.webmanifest', 'icons/icon.svg'].map((path) => new URL(path, SCOPE).href);

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key.startsWith(PREFIX) && key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || !url.href.startsWith(SCOPE)) return;

  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      try {
        const response = await fetch(request);
        if (response.ok) {
          // Refresh the offline shell after a deploy, not only when sw.js changes.
          event.waitUntil(cache.put(INDEX, response.clone()).catch(() => undefined));
        }
        return response;
      } catch {
        return (await cache.match(INDEX)) || Response.error();
      }
    })());
    return;
  }

  const isBuildAsset = url.href.startsWith(new URL('assets/', SCOPE).href);
  if (!isBuildAsset && !SHELL.includes(url.href)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(request);
    if (hit) return hit;
    const response = await fetch(request);
    if (response.ok && isBuildAsset) {
      event.waitUntil(cache.put(request, response.clone()).catch(() => undefined));
    }
    return response;
  })());
});
