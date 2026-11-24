// Service worker: makes the app installable (Edge/Chrome "Install app") and usable offline.
// Same-origin files: network first (always fresh while developing), cache as fallback.
// Pinned CDN libraries (three.js, Leaflet, fonts): cache first. DHM relay, map tiles and search: never cached.
const CACHE = 'cloudburst-v1';
const SHELL = ['./', 'index.html', 'app.js', 'styles.css', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png',
  'engine/cloudburst-wasm.js', 'engine/engine-worker.js', 'engine/engine-client.js', 'engine/cloudburst_core.wasm',
  'js/util.js', 'js/colors.js', 'js/raster.js', 'js/mapview.js', 'js/view3d.js', 'js/dhm.js', 'js/hooks.js', 'js/terms.js',
  'js/sources/registry.js', 'js/sources/tiff.js', 'js/sources/textgrid.js', 'js/sources/proj.js', 'js/sources/gridops.js', 'js/sources/dhm.js',
  'js/sources/terrarium.js', 'js/sources/copernicus.js', 'js/sources/osm.js', 'js/sources/ui.js',
  // PDF report (js/report.js): precached so "Export report" works offline
  'js/report.js', 'js/report-model.js', 'js/report-pdf.js', 'js/report-maps.js', 'js/report-i18n.js', 'report.css', 'vendor/jspdf/jspdf.umd.min.js'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => Promise.all(SHELL.map((u) => c.add(u).catch(() => null)))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.pathname.includes('/proxy/') || /tile\.openstreetmap|nominatim|datafordeler|dataforsyningen|overpass|amazonaws/.test(url.host)) return;
  if (url.origin === location.origin) {
    e.respondWith(fetch(req).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req).then((r) => r || caches.match('index.html'))));
  } else if (/cdn\.jsdelivr\.net|unpkg\.com|fonts\./.test(url.host)) {
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok || res.type === 'opaque') { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
      return res;
    })));
  }
});
