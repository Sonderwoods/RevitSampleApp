// "New site from Danmarks Højdemodel": pick a location on a map, paste an API key, fetch DHM/Terræn and open it.
// The key stays in the browser (optionally remembered in localStorage) and is sent only to the official WCS endpoint.

import { h, $, toast, icon } from './util.js';

const PROVIDERS = {
  datafordeler: { label: 'Datafordeler API key', url: 'https://wcs.datafordeler.dk/DHMNedboer/dhm_wcs/1.0.0/WCS', param: 'apikey', help: 'Get a free API key at <a href="https://portal.datafordeler.dk/hjem" target="_blank" rel="noopener">portal.datafordeler.dk</a> (log in with MitID/NemID or e-mail)' },
  dataforsyningen: { label: 'Dataforsyningen token', url: 'https://api.dataforsyningen.dk/dhm_wcs_DAF', param: 'token', help: 'dataforsyningen.dk → Log ind → Mine tokens' },
};
const LS = { key: 'cb.dhm.key', provider: 'cb.dhm.provider' };
const store = {
  get(k) { try { return localStorage.getItem(k) || ''; } catch { return ''; } },
  set(k, v) { try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch { /* private mode */ } },
};

// ---------- WGS84 → ETRS89 / UTM zone 32N (EPSG:25832)
export function latLonToUtm32(lat, lon) {
  const a = 6378137, f = 1 / 298.257222101, k0 = 0.9996, e2 = f * (2 - f), ep2 = e2 / (1 - e2);
  const lon0 = (9 * Math.PI) / 180, phi = (lat * Math.PI) / 180, lam = (lon * Math.PI) / 180;
  const N = a / Math.sqrt(1 - e2 * Math.sin(phi) ** 2), T = Math.tan(phi) ** 2, C = ep2 * Math.cos(phi) ** 2, A = Math.cos(phi) * (lam - lon0);
  const M = a * ((1 - e2 / 4 - (3 * e2 ** 2) / 64 - (5 * e2 ** 3) / 256) * phi - ((3 * e2) / 8 + (3 * e2 ** 2) / 32 + (45 * e2 ** 3) / 1024) * Math.sin(2 * phi)
    + ((15 * e2 ** 2) / 256 + (45 * e2 ** 3) / 1024) * Math.sin(4 * phi) - ((35 * e2 ** 3) / 3072) * Math.sin(6 * phi));
  const E = k0 * N * (A + ((1 - T + C) * A ** 3) / 6 + ((5 - 18 * T + T * T + 72 * C - 58 * ep2) * A ** 5) / 120) + 500000;
  const Nn = k0 * (M + N * Math.tan(phi) * ((A * A) / 2 + ((5 - T + 9 * C + 4 * C * C) * A ** 4) / 24 + ((61 - 58 * T + T * T + 600 * C - 330 * ep2) * A ** 6) / 720));
  return { E, N: Nn };
}

/** Download DHM/Terræn for an EPSG:25832 bbox. Returns GeoTIFF bytes. */
export async function fetchDhm(bbox, { provider, key, res = 0.4, coverage = 'dhm_terraen' }) {
  const p = PROVIDERS[provider] || PROVIDERS.datafordeler;
  const [x0, y0, x1, y1] = bbox.map((v) => Math.round(v));
  const width = Math.round((x1 - x0) / res), height = Math.round((y1 - y0) / res);
  const q = new URLSearchParams({ service: 'WCS', request: 'GetCoverage', version: '1.0.0', coverage, crs: 'EPSG:25832', bbox: `${x0},${y0},${x1},${y1}`, width, height, format: 'GTiff' });
  q.set(p.param, key.trim());
  // Desktop app (Tauri): download natively – no CORS, no local server.
  const tauri = typeof window !== 'undefined' && window.__TAURI__ && window.__TAURI__.core;
  if (tauri) {
    try {
      const buf = new Uint8Array(await tauri.invoke('fetch_dhm', { provider: provider in PROVIDERS ? provider : 'datafordeler', query: q.toString() }));
      if (!(buf.length > 4 && ((buf[0] === 0x49 && buf[1] === 0x49) || (buf[0] === 0x4d && buf[1] === 0x4d)))) throw new Error(new TextDecoder().decode(buf.slice(0, 300)));
      return buf;
    } catch (e) {
      let msg = String(e && e.message ? e.message : e);
      try { const j = JSON.parse(msg.replace(/^HTTP \d+: /, '')); msg = (/^HTTP (\d+)/.exec(msg) ? `Key rejected (${/^HTTP (\d+)/.exec(msg)[1]}). ` : '') + (j.detail || j.title || msg); } catch { /* plain text */ }
      throw new Error(msg);
    }
  }
  let r;
  const viaProxy = await hasProxy();
  const url = viaProxy ? `proxy/${provider in PROVIDERS ? provider : 'datafordeler'}?${q}` : `${p.url}?${q}`;
  try { r = await fetch(url); } catch (e) {
    throw new Error(`The browser blocked the request to ${new URL(p.url).host} (CORS). Use the Cloudburst desktop app, or run the web app locally with "Cloudburst Web.bat" / "python serve.py" – both download DHM without this restriction.`);
  }
  const buf = new Uint8Array(await r.arrayBuffer());
  const isTiff = buf.length > 4 && ((buf[0] === 0x49 && buf[1] === 0x49) || (buf[0] === 0x4d && buf[1] === 0x4d));
  if (!r.ok || !isTiff) {
    let msg = new TextDecoder().decode(buf.slice(0, 400));
    try { const j = JSON.parse(msg); msg = j.detail || j.title || msg; } catch { /* xml/text */ }
    if (r.status === 401 || r.status === 403) msg = `Key rejected (${r.status}). ${msg}`;
    throw new Error(msg.replace(/<[^>]+>/g, ' ').trim() || `HTTP ${r.status}`);
  }
  return buf;
}

let proxyP = null;
/** True when the page is served by Web/serve.py (which relays WCS requests and avoids CORS problems). */
export function hasProxy() {
  if (typeof window !== 'undefined' && window.__TAURI__) return Promise.resolve(false);
  if (!proxyP) proxyP = fetch('proxy/ping', { cache: 'no-store' }).then((r) => r.ok).catch(() => false);
  return proxyP;
}

// ---------- Leaflet (loaded on demand from a pinned CDN build)
let leafletP = null;
function loadLeaflet() {
  if (!leafletP) {
    leafletP = new Promise((resolve, reject) => {
      const css = document.createElement('link');
      css.rel = 'stylesheet'; css.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css'; document.head.append(css);
      import('https://unpkg.com/leaflet@1.9.4/dist/leaflet-src.esm.js').then(resolve, reject);
    });
  }
  return leafletP;
}

async function geocode(q) {
  const u = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&countrycodes=dk&q=${encodeURIComponent(q)}`;
  const r = await fetch(u, { headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error(`Search failed (${r.status})`);
  return (await r.json()).map((x) => ({ name: x.display_name, lat: +x.lat, lon: +x.lon }));
}

/**
 * Open the picker. `onTerrain({bytes, info})` is called with the downloaded GeoTIFF and a sample-like info object.
 * `initial` may contain {lat, lon, size, name, bbox}.
 */
export async function openDhmPicker(onTerrain, initial = {}) {
  const state = {
    lat: initial.lat ?? 55.6761, lon: initial.lon ?? 12.5683, size: initial.size ?? 400, res: 0.4,
    name: initial.name || '', provider: store.get(LS.provider) || 'datafordeler', key: store.get(LS.key), remember: !!store.get(LS.key),
  };
  const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);

  const mapEl = h('div.dhm-map', h('div.dhm-map-loading', 'Loading map…'));
  const results = h('div.dhm-results.hidden');
  const search = h('input.dhm-input', { type: 'search', placeholder: 'Search address or place in Denmark…', value: state.name });
  const sizeOut = h('b', `${state.size} m`);
  const coordOut = h('div.dhm-coord.mono');
  const status = h('div.dhm-status');
  const keyInput = h('input.dhm-input.mono', { type: 'password', placeholder: 'Paste key…', value: state.key, autocomplete: 'off', spellcheck: false });
  const remember = h('input', { type: 'checkbox', checked: state.remember });
  const provSel = h('select.dhm-input', ...Object.entries(PROVIDERS).map(([k, p]) => h('option', { value: k, selected: k === state.provider }, p.label)));
  const help = h('div.dhm-help');
  const resSel = h('select.dhm-input', ...[[0.4, '0.4 m (native)'], [0.8, '0.8 m'], [1.6, '1.6 m (fast, large areas)']].map(([v, l]) => h('option', { value: v, selected: v === state.res }, l)));
  const sizeIn = h('input', { type: 'range', min: 100, max: 1500, step: 50, value: state.size });
  const go = h('button.btn.primary.dhm-go', { html: `${icon('download', 15)} Fetch terrain & open` });

  const bbox = () => {
    const { E, N } = latLonToUtm32(state.lat, state.lon); const r = state.size / 2;
    return [E - r, N - r, E + r, N + r];
  };
  const updateInfo = () => {
    const b = bbox();
    coordOut.textContent = `${state.lat.toFixed(5)}°N ${state.lon.toFixed(5)}°E · EPSG:25832 ${Math.round(b[0])}, ${Math.round(b[1])} → ${Math.round(b[2])}, ${Math.round(b[3])}`;
    sizeOut.textContent = `${state.size} × ${state.size} m`;
    const px = Math.round(state.size / state.res) ** 2;
    help.innerHTML = `${PROVIDERS[provSel.value].help}. Download ≈ ${(px * 4 / 1e6).toFixed(1)} MB.`;
    go.disabled = !keyInput.value.trim();
  };
  provSel.onchange = updateInfo; keyInput.oninput = updateInfo;
  resSel.onchange = () => { state.res = +resSel.value; updateInfo(); };

  const overlay = h('div.dhm-overlay', { onclick: (e) => { if (e.target === overlay) close(); } },
    h('div.dhm-dialog',
      h('div.dhm-head',
        h('div', h('div.eyebrow', 'New site · Danmarks Højdemodel'), h('h2', 'Pick a location in Denmark')),
        h('button.btn.ghost', { onclick: close, html: icon('x', 16) })),
      h('div.dhm-body',
        h('div.dhm-left', h('div.dhm-search', search, results), mapEl, coordOut),
        h('div.dhm-right',
          h('label', 'Area', sizeOut), sizeIn,
          h('label', 'Resolution'), resSel,
          h('label', 'Credentials'), provSel, keyInput,
          h('label.dhm-check', remember, h('span', 'Remember on this device')),
          help,
          h('div.dhm-note', { html: `${icon('pin', 13)} Click the map to move the square. Terrain is DHM/Terræn: buildings are removed, bridge decks are included.` }),
          go, status))));
  document.body.append(overlay);
  updateInfo();
  keyInput.focus();

  // map
  let L, map, rect, marker;
  const drawRect = () => {
    if (!map) return;
    const b = bbox();
    // square in metres → approximate lat/lon box (fine at site scale)
    const dLat = state.size / 2 / 111320, dLon = state.size / 2 / (111320 * Math.cos((state.lat * Math.PI) / 180));
    const bounds = [[state.lat - dLat, state.lon - dLon], [state.lat + dLat, state.lon + dLon]];
    if (!rect) rect = L.rectangle(bounds, { color: '#4fa8e0', weight: 2, fillColor: '#4fa8e0', fillOpacity: 0.15 }).addTo(map);
    else rect.setBounds(bounds);
    if (!marker) marker = L.circleMarker([state.lat, state.lon], { radius: 4, color: '#fff', fillColor: '#1f78c8', fillOpacity: 1, weight: 2 }).addTo(map);
    else marker.setLatLng([state.lat, state.lon]);
    updateInfo(); void b;
  };
  try {
    L = await loadLeaflet();
    mapEl.innerHTML = '';
    map = L.map(mapEl, { zoomControl: true, attributionControl: true }).setView([state.lat, state.lon], initial.lat ? 16 : 12);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap contributors' }).addTo(map);
    map.on('click', (e) => { state.lat = e.latlng.lat; state.lon = e.latlng.lng; state.name = ''; drawRect(); });
    drawRect();
    setTimeout(() => map.invalidateSize(), 50);
  } catch (e) {
    mapEl.innerHTML = '';
    mapEl.append(h('div.dhm-map-loading', 'Map unavailable offline – search or edit coordinates still work.'));
  }
  sizeIn.oninput = () => { state.size = +sizeIn.value; drawRect(); updateInfo(); };

  // search
  let t = 0;
  search.oninput = () => {
    clearTimeout(t);
    const q = search.value.trim();
    if (q.length < 3) { results.classList.add('hidden'); return; }
    t = setTimeout(async () => {
      try {
        const list = await geocode(q);
        results.innerHTML = '';
        for (const r of list) results.append(h('button.dhm-result', { onclick: () => {
          state.lat = r.lat; state.lon = r.lon; state.name = r.name.split(',').slice(0, 2).join(','); search.value = state.name;
          results.classList.add('hidden'); if (map) map.setView([r.lat, r.lon], 16); drawRect();
        } }, r.name));
        results.classList.toggle('hidden', list.length === 0);
      } catch (e) { results.classList.add('hidden'); status.textContent = e.message; }
    }, 350);
  };

  go.onclick = async () => {
    const key = keyInput.value.trim(); if (!key) return;
    store.set(LS.provider, provSel.value);
    store.set(LS.key, remember.checked ? key : '');
    go.disabled = true; status.className = 'dhm-status busy'; status.textContent = 'Downloading DHM/Terræn…';
    const b = bbox();
    try {
      let bytes;
      try { bytes = await fetchDhm(b, { provider: provSel.value, key, res: state.res }); }
      catch (e) {
        // A Datafordeler key may also be a Dataforsyningen token (and vice versa): try the other service once.
        const other = provSel.value === 'datafordeler' ? 'dataforsyningen' : 'datafordeler';
        try { bytes = await fetchDhm(b, { provider: other, key, res: state.res }); store.set(LS.provider, other); }
        catch { throw e; }
      }
      status.className = 'dhm-status ok'; status.textContent = `Received ${(bytes.length / 1e6).toFixed(1)} MB – building grid…`;
      const name = state.name || `Site at ${state.lat.toFixed(4)}°N ${state.lon.toFixed(4)}°E`;
      const info = { id: 'custom', name, description: `DHM/Terræn ${state.res} m, ${state.size} × ${state.size} m around ${state.lat.toFixed(5)}°N ${state.lon.toFixed(5)}°E`, kind: 'custom', rainPreset: 1, bbox: b.map(Math.round), dhmFile: null, compareWith: null };
      close();
      await onTerrain({ bytes, info });
    } catch (e) {
      status.className = 'dhm-status err'; status.textContent = e.message; go.disabled = false;
      toast('DHM download failed', 'error');
    }
  };
}
