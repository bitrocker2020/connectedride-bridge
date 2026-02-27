/* ══════════════════════════════════════════════════════════════
   ConnectedRide Bridge — Service Worker (sw.js)
   Cache-first strategy for shell assets, network-first for API.
   ══════════════════════════════════════════════════════════════ */

const CACHE_VERSION = 'cr-bridge-v1';
const SHELL_ASSETS  = [
  '/',
  '/index.html',
  '/styles.css',
  '/script.js',
  '/manifest.json',
];

/* ── Install: pre-cache shell ────────────────────────────────── */
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then((cache) => cache.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting())
  );
});

/* ── Activate: purge old caches ──────────────────────────────── */
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_VERSION)
          .map((key) => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

/* ── Fetch: cache-first for shell, network-first for API ─────── */
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Always go to network for Google APIs (Geocoding)
  if (url.hostname.includes('googleapis.com')) {
    event.respondWith(
      fetch(request).catch(() =>
        new Response(
          JSON.stringify({ status: 'OFFLINE', error: 'No network connection.' }),
          { headers: { 'Content-Type': 'application/json' } }
        )
      )
    );
    return;
  }

  // Cache-first for everything else (shell assets)
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((response) => {
        // Cache successful GET responses for shell assets
        if (request.method === 'GET' && response.status === 200) {
          const clone = response.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put(request, clone));
        }
        return response;
      });
    })
  );
});
