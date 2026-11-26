/* Service worker — lets the app shell load offline and keeps map tiles you've viewed.
 * Bump VERSION whenever the precache list changes. */
const VERSION = 'v2';
const SHELL_CACHE = 'gpxlib-shell-' + VERSION;
const TILE_CACHE  = 'gpxlib-tiles-' + VERSION;
const MAX_TILES   = 1500;

const SHELL = [
  './', 'index.html', 'style.css',
  'js/util.js', 'js/storage.js', 'js/gpxParser.js', 'js/gpxEdit.js', 'js/trackCreator.js', 'js/mapManager.js',
  'js/multiRoute.js', 'js/activities.js', 'js/places.js', 'js/view3d.js', 'js/theme-init.js', 'js/app.js',
];
const CDN = [
  'https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.css',
  'https://cdn.jsdelivr.net/npm/maplibre-gl@4/dist/maplibre-gl.css',
  'https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.js',
  'https://cdn.jsdelivr.net/npm/leaflet.heat@0.2.0/dist/leaflet-heat.js',
  'https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js',
  'https://cdn.jsdelivr.net/npm/maplibre-gl@4/dist/maplibre-gl.js',
  'https://cdn.jsdelivr.net/npm/qrcodejs@1.0.0/qrcode.min.js',
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then(async cache => {
      await cache.addAll(SHELL);
      // CDN files are best-effort: a failure here must not block installing the shell.
      await Promise.all(CDN.map(u => cache.add(u).catch(() => {})));
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => ![SHELL_CACHE, TILE_CACHE].includes(k)).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

async function staleWhileRevalidate(request) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(request, { ignoreSearch: true });
  const network = fetch(request).then(resp => {
    if (resp && resp.ok) cache.put(request, resp.clone());
    return resp;
  }).catch(() => null);
  return cached || (await network) || Response.error();
}

async function trimTiles(cache) {
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - MAX_TILES; i++) await cache.delete(keys[i]); // oldest first
}

async function tileCacheFirst(request) {
  const cache = await caches.open(TILE_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  try {
    const resp = await fetch(request);
    // Tile servers are cross-origin, so successful responses are usually opaque (status 0).
    if (resp && (resp.ok || resp.type === 'opaque')) {
      cache.put(request, resp.clone()).then(() => trimTiles(cache)).catch(() => {});
    }
    return resp;
  } catch (err) {
    return Response.error();
  }
}

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).catch(() => caches.match('index.html', { ignoreSearch: true }).then(r => r || caches.match('./')))
    );
    return;
  }
  if (url.origin === self.location.origin || url.hostname === 'cdn.jsdelivr.net') {
    event.respondWith(staleWhileRevalidate(req));
    return;
  }
  if (req.destination === 'image') {
    event.respondWith(tileCacheFirst(req));
  }
  // Everything else (Nominatim, GitHub, Open-Meteo, BRouter, Overpass…) goes straight to the network.
});
