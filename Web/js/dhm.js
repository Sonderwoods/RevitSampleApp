// "New site from a map": pick a location, choose a terrain source (DHM with a key, or a keyless global DEM), optionally
// add OpenStreetMap buildings / land cover, and open it. The fetching, reprojection and metadata live in
// js/sources/ (registry.js); this file is only the dialog. An API key stays in the browser (optionally remembered in
// localStorage) and is sent only to the official WCS endpoint (directly, or through the local relay serve.py).

import { h, toast, icon } from './util.js';
import { DHM_PROVIDERS as PROVIDERS, DHM_COVERAGES, fetchDhmTiles, listDhmCoverages, hasProxy } from './sources/dhm.js';
import { readGeoTiff, writeGeoTiff } from './sources/tiff.js';
import { mosaic } from './sources/gridops.js';
import { tmForward } from './sources/proj.js';
import { getSource, listSources, fetchTerrain, fetchOsmContext, attachContext, suitability } from './sources/registry.js';

export { hasProxy };

const LS = { key: 'cb.dhm.key', provider: 'cb.dhm.provider', osm: 'cb.src.osm' };
const store = {
  get(k) { try { return localStorage.getItem(k) || ''; } catch { return ''; } },
  set(k, v) { try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch { /* private mode */ } },
};

/** WGS84 → ETRS89 / UTM zone 32N (EPSG:25832). Kept for existing callers; see sources/proj.js. */
export function latLonToUtm32(lat, lon) { return tmForward(lat, lon, { lon0: 9 }); }

/** Download DHM for an EPSG:25832 bbox as ONE GeoTIFF (tiled, snapped, mosaicked). Kept for existing callers. */
export async function fetchDhm(bbox, { provider, key, res = 0.4, coverage = 'dhm_terraen' }) {
  const tiles = await fetchDhmTiles(bbox, { provider, key, res, coverage });
  if (tiles.length === 1) return tiles[0].bytes;
  const parts = []; for (const t of tiles) parts.push(await readGeoTiff(t.bytes));
  return writeGeoTiff({ ...mosaic(parts), epsg: 25832 });
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

async function geocode(q, dkOnly) {
  const u = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6${dkOnly ? '&countrycodes=dk' : ''}&q=${encodeURIComponent(q)}`;
  const r = await fetch(u, { headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error(`Search failed (${r.status})`);
  return (await r.json()).map((x) => ({ name: x.display_name, lat: +x.lat, lon: +x.lon }));
}

// Suitability level → CSS class (.suit-good/.suit-fair/.suit-poor/.suit-unsuitable in styles.css).
const SUIT_CLASS = { good: 'suit-good', fair: 'suit-fair', poor: 'suit-poor', unsuitable: 'suit-unsuitable' };

/**
 * Open the picker. `onTerrain({bytes, info})` is called with a GeoTIFF in the site's metric CRS and a sample-like
 * info object (plus sourceId, epsg, attribution, suitability; OSM layers ride along via registry.attachContext).
 * `initial` may contain {lat, lon, size, name, sourceId}.
 */
export async function openDhmPicker(onTerrain, initial = {}) {
  const state = {
    lat: initial.lat ?? 55.6761, lon: initial.lon ?? 12.5683, size: initial.size ?? 400, res: 0.4, coverage: 'dhm_terraen',
    name: initial.name || '', provider: store.get(LS.provider) || 'datafordeler', key: store.get(LS.key), remember: !!store.get(LS.key),
    sourceId: initial.sourceId || 'dk-dhm', osm: store.get(LS.osm) !== 'off',
  };
  const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  const isDhm = () => state.sourceId === 'dk-dhm';

  const mapEl = h('div.dhm-map', h('div.dhm-map-loading', 'Loading map…'));
  const results = h('div.dhm-results.hidden');
  const search = h('input.dhm-input', { type: 'search', placeholder: 'Search an address or place…', value: state.name });
  const sizeOut = h('b', `${state.size} m`);
  const coordOut = h('div.dhm-coord.mono');
  const status = h('div.dhm-status');
  const srcSel = h('select.dhm-input', { 'aria-label': 'Terrain source' }, ...listSources({ kind: 'terrain' }).filter((s) => s.id !== 'upload').map((s) => h('option', { value: s.id, selected: s.id === state.sourceId }, s.name)));
  const srcInfo = h('div.dhm-help');
  const keyInput = h('input.dhm-input.mono', { type: 'password', placeholder: 'Paste your API key…', value: state.key, autocomplete: 'off', spellcheck: false, 'aria-label': 'API key' });
  const remember = h('input', { type: 'checkbox', checked: state.remember });
  const provSel = h('select.dhm-input', ...Object.entries(PROVIDERS).map(([k, p]) => h('option', { value: k, selected: k === state.provider }, p.label)));
  const covSel = h('select.dhm-input', { 'aria-label': 'Product' }, ...DHM_COVERAGES.map((c) => h('option', { value: c.id }, c.label)));
  const covList = h('button.btn.ghost.small', { type: 'button', title: 'Ask the service which products this key can use (e.g. a hydrologically adapted model)' }, 'List products');
  const help = h('div.dhm-help');
  const resSel = h('select.dhm-input', { 'aria-label': 'Detail' }, ...[[0.4, '0.4 m: finest (default)'], [0.8, '0.8 m (server-resampled)'], [1.6, '1.6 m: faster, large areas (server-resampled)']].map(([v, l]) => h('option', { value: v, selected: v === state.res }, l)));
  const osmChk = h('input', { type: 'checkbox', checked: state.osm });
  const sizeIn = h('input', { type: 'range', min: 100, max: 1500, step: 50, value: state.size });
  const go = h('button.btn.primary.dhm-go', { html: `${icon('download', 15)} Download terrain & open` });
  const goWhy = h('div.dhm-why', { role: 'status' });
  const dhmOnly = [h('label', 'Detail'), resSel, h('label', 'Product'), covSel, covList, h('label', 'API key'), keyInput, provSel, h('label.dhm-check', remember, h('span', 'Remember on this device')), help];
  const note = h('div.dhm-note');
  const intro = h('p.dhm-intro');
  const title = h('h2');

  const updateInfo = () => {
    const src = getSource(state.sourceId);
    title.textContent = isDhm() ? 'Find a place in Denmark' : 'Find a place (anywhere)';
    intro.innerHTML = isDhm()
      ? '1. Search an address or click the map to place the square. 2. Paste a free API key (<a href="https://portal.datafordeler.dk/hjem" target="_blank" rel="noopener">get one at Datafordeler</a>: log in with MitID or e-mail, create an API key, copy it). 3. Download.'
      : '1. Search an address or click the map to place the square. 2. Download. No key needed – but read the resolution warning first.';
    for (const el of dhmOnly) el.style.display = isDhm() ? '' : 'none';
    coordOut.textContent = `${state.lat.toFixed(5)}°, ${state.lon.toFixed(5)}°`;
    sizeOut.textContent = `${state.size} × ${state.size} m`;
    const s = suitability(src, { cellSize: 1 });
    srcInfo.innerHTML = `<b class="${SUIT_CLASS[s.level] || ''}">${s.label}.</b> ${s.message}<br>${src.coverage} · native ${src.nativeResM ?? '?'} m · ${src.model} · ${src.verticalDatum}<br><span class="dhm-licence">Licence: ${src.licence}. ${src.attribution}</span>`;
    note.innerHTML = `${icon('pin', 13)} ${src.note}`;
    if (isDhm()) {
      const px = Math.round(state.size / state.res) ** 2;
      help.innerHTML = `${PROVIDERS[provSel.value].help}. Download ≈ ${(px * 4 / 1e6).toFixed(1)} MB.`;
    }
    const outside = src.region && !(state.lat >= src.region.south && state.lat <= src.region.north && state.lon >= src.region.west && state.lon <= src.region.east);
    const hasKey = !isDhm() || !!keyInput.value.trim();
    go.disabled = !hasKey || outside;
    goWhy.textContent = outside ? `${src.name} only covers ${src.coverage}. Pick another source for this location.` : hasKey ? '' : 'Paste your API key above to enable the download.';
  };
  provSel.onchange = updateInfo; keyInput.oninput = updateInfo;
  resSel.onchange = () => { state.res = +resSel.value; updateInfo(); };
  covSel.onchange = () => { state.coverage = covSel.value; };
  srcSel.onchange = () => { state.sourceId = srcSel.value; updateInfo(); };
  osmChk.onchange = () => { state.osm = osmChk.checked; store.set(LS.osm, state.osm ? '' : 'off'); };
  covList.onclick = async () => {
    const key = keyInput.value.trim(); if (!key) { goWhy.textContent = 'Paste your API key first.'; return; }
    status.className = 'dhm-status busy'; status.textContent = 'Asking the service for its products…';
    try {
      const list = await listDhmCoverages({ provider: provSel.value, key });
      covSel.innerHTML = '';
      for (const c of list) covSel.append(h('option', { value: c.name, selected: c.name === state.coverage }, `${c.label}${c.hydro ? ' – hydrologically adapted?' : ''}`));
      status.className = 'dhm-status ok'; status.textContent = `${list.length} products offered${list.some((c) => c.hydro) ? '; one looks hydrologically adapted (check its description before use)' : ''}.`;
    } catch (e) { status.className = 'dhm-status err'; status.textContent = `Could not list products: ${e.message}`; }
  };

  const overlay = h('div.dhm-overlay', { onclick: (e) => { if (e.target === overlay) close(); } },
    h('div.dhm-dialog',
      h('div.dhm-head',
        h('div', h('div.eyebrow', 'New site · terrain from a map'), title, intro),
        h('button.btn.ghost', { onclick: close, html: icon('x', 16), title: 'Close', 'aria-label': 'Close' })),
      h('div.dhm-body',
        h('div.dhm-left', h('div.dhm-search', search, results), mapEl, coordOut),
        h('div.dhm-right',
          h('label', 'Terrain source'), srcSel, srcInfo,
          h('label', 'Size of the square', sizeOut), sizeIn,
          ...dhmOnly,
          h('label.dhm-check', osmChk, h('span', 'Add buildings & land cover from OpenStreetMap')),
          note,
          go, goWhy, status,
          h('div.dhm-alt', { html: 'No key? Choose a keyless source above (overview only), <a href="#/site/demo_block">open an example site</a>, or drop a terrain file on the start page.' })))));
  document.body.append(overlay);
  overlay.querySelector('.dhm-alt a').addEventListener('click', close);
  updateInfo();
  (isDhm() ? keyInput : search).focus();

  // map
  let L, map, rect, marker;
  const drawRect = () => {
    updateInfo();
    if (!map) return;
    const dLat = state.size / 2 / 111320, dLon = state.size / 2 / (111320 * Math.cos((state.lat * Math.PI) / 180));
    const bounds = [[state.lat - dLat, state.lon - dLon], [state.lat + dLat, state.lon + dLon]];
    if (!rect) rect = L.rectangle(bounds, { color: '#4fa8e0', weight: 2, fillColor: '#4fa8e0', fillOpacity: 0.15 }).addTo(map);
    else rect.setBounds(bounds);
    if (!marker) marker = L.circleMarker([state.lat, state.lon], { radius: 4, color: '#fff', fillColor: '#1f78c8', fillOpacity: 1, weight: 2 }).addTo(map);
    else marker.setLatLng([state.lat, state.lon]);
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
    mapEl.append(h('div.dhm-map-loading', 'The background map could not load (offline?). Address search still places the square.'));
  }
  sizeIn.oninput = () => { state.size = +sizeIn.value; drawRect(); };

  // search
  let t = 0;
  search.oninput = () => {
    clearTimeout(t);
    const q = search.value.trim();
    if (q.length < 3) { results.classList.add('hidden'); return; }
    t = setTimeout(async () => {
      try {
        const list = await geocode(q, isDhm());
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
    const key = keyInput.value.trim(); if (isDhm() && !key) return;
    if (isDhm()) { store.set(LS.provider, provSel.value); store.set(LS.key, remember.checked ? key : ''); }
    go.disabled = true; status.className = 'dhm-status busy';
    const say = (m) => { status.textContent = m; };
    const args = { lat: state.lat, lon: state.lon, sizeM: state.size, name: state.name, onProgress: say, provider: provSel.value, key, res: state.res, coverage: state.coverage };
    try {
      let res;
      try { res = await fetchTerrain(state.sourceId, args); }
      catch (e) {
        if (!isDhm()) throw e;
        // A Datafordeler key may also be a Dataforsyningen token (and vice versa): try the other service once.
        const other = provSel.value === 'datafordeler' ? 'dataforsyningen' : 'datafordeler';
        try { res = await fetchTerrain(state.sourceId, { ...args, provider: other }); store.set(LS.provider, other); } catch { throw e; }
      }
      const { bytes, info } = res;
      if (state.osm) {
        say('Downloading OpenStreetMap buildings and land cover…');
        try {
          const osm = await fetchOsmContext(info);
          attachContext(bytes, { osm });
          info.attribution = [...(info.attribution || []), osm.attribution];
          info.description += ` OSM: ${osm.stats.buildings} buildings, ${osm.stats.surfaces} surfaces, ${osm.stats.roads} roads, ${osm.stats.bridges} bridges.`;
        } catch (e) { toast(e.message, 'error'); }
      }
      for (const w of info.warnings || []) toast(w);
      if (info.suitability && info.suitability.level === 'unsuitable') toast(`${info.suitability.label}: ${info.suitability.message}`, 'error');
      status.className = 'dhm-status ok'; say(`Received ${(bytes.length / 1e6).toFixed(1)} MB – building grid…`);
      close();
      await onTerrain({ bytes, info });
    } catch (e) {
      status.className = 'dhm-status err';
      status.textContent = /rejected|401|403/i.test(e.message) && isDhm() ? `The key was not accepted. Check that you copied the whole key, and that it is a Datafordeler API key or a Dataforsyningen token. (${e.message})` : `Download failed: ${e.message}`;
      go.disabled = false;
      toast('Terrain download failed: see the message in the dialog', 'error');
    }
  };
}
