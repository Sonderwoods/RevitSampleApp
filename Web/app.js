// Cloudburst web front-end. Static ES modules, no build step.
// Engine: Rust core compiled to WebAssembly (engine/), the same code as the Revit/Rhino plug-in DLL.
import { CloudburstClient } from './engine/engine-client.js';
import { h, $, $$, clamp, debounce, fmtInt, fmt1, fmtVol, fmtArea, fmtCm, fmtClock, fmtDuration, utm32ToLatLon, fmtLatLon, download, toast, icon } from './js/util.js';
import { DEPTH, VELOCITY, HAZARD, TPEAK, DIFF, LAYERS } from './js/colors.js';
import { baseCanvas, buildingsCanvas, overlayCanvas, materialCanvas, materialsPresent, sampleAt, cellAt, differenceArray } from './js/raster.js';
import { MapView, roundRect } from './js/mapview.js';
import { openDhmPicker } from './js/dhm.js';

// ------------------------------------------------------------------------------------------------ constants
const LOCATIONS = {
  dk_taasinge: 'Copenhagen · Østerbro',
  dk_skt_kjeld: 'Copenhagen · Østerbro',
  dk_enghaveparken: 'Copenhagen · Vesterbro',
  dk_kongens_nytorv: 'Copenhagen · Indre By',
  dk_odense: 'Odense · Munke Mose',
};
const SEWER = [
  { v: 0, label: 'None', long: 'No sewer' },
  { v: 1, label: 'Combined', sub: '34 mm', long: 'Combined sewer (34 mm)' },
  { v: 2, label: 'Separate', sub: '29 mm', long: 'Separate sewer (29 mm)' },
];
const PRESET_LABEL = { t10: 'T = 10 years', t100: 'T = 100 years', test2011: 'Cph. 2011 test', box83: 'Box 83 mm / 4 h' };
const MOIST = [{ v: 0, label: 'Dry' }, { v: 1, label: 'Moist' }, { v: 2, label: 'Wet' }];
const DURATIONS = [
  { id: 'full30', label: 'Event + 30 min', after: 30 },
  { id: 'full', label: 'Event only', after: 0 },
  { id: 'first60', label: 'First 60 min', after: 0, cut: 60 },
];
const withMin = (ramp, min) => ({ ...ramp, min, index: (v) => (v >= min ? ramp.index(v) : -1) });
const DEPTH_DYN = withMin(DEPTH, 0.03);

// ------------------------------------------------------------------------------------------------ state
const S = {
  cb: null, info: null,
  site: null, siteDesc: null, sampleJson: null, grid: null, scene: null,
  settings: { presetId: 't100', rainDepthMm: 59, climateFactor: 1.4, sewerMode: 1, moisture: 1 },
  instant: null, instMs: 0, instBusy: false, instPending: false,
  layer: 'depth', source: 'instant', showPaths: true, showLabels: true,
  dyn: null, dynRun: null, dynCell: 2, dynDuration: 'full30', frame: -1, playing: 0,
  options: [], compare: null,
  retention: { dischargeLSHa: 1, returnPeriod: 10, result: null },
  view3d: false, v3: null,
  thumbs: new Map(),
};
let map = null;

// ------------------------------------------------------------------------------------------------ boot
boot().catch((e) => { console.error(e); $('#engineChip').innerHTML = '<span class="dot err"></span>Engine failed to load'; toast(`Engine failed: ${e.message}`, 'error'); });

async function boot() {
  S.cb = await CloudburstClient.create();
  S.info = S.cb.info;
  $('#engineChip').innerHTML = `<span class="dot ok"></span>Engine ${S.info.version} · WebAssembly`;
  $('#brand').onclick = () => { location.hash = '#/'; };
  renderGallery();
  setupGlobalDrop();
  $('#fileInput').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) onTerrainFile(f); });
  window.addEventListener('hashchange', route);
  await route();
  makeThumbs();
}

async function route() {
  const m = /^#\/site\/([\w-]+)/.exec(location.hash);
  if (m && S.info.samples.some((s) => s.id === m[1])) {
    if (!S.site || S.site.id !== m[1]) await openSite(m[1]);
    else showWorkspace();
  }
  else if (location.hash === '#/custom' && S.site && S.site.kind === 'custom') { /* stay */ }
  else showGallery();
}

function preset(id = S.settings.presetId) { return S.info.presets.find((p) => p.id === id) || S.info.presets[1]; }
function sampleInfo(id) { return S.info.samples.find((s) => s.id === id); }

// ------------------------------------------------------------------------------------------------ gallery
function badgeFor(s) {
  if (s.kind === 'real') return h('span.badge.real', 'Real site');
  if (s.compareWith) return h('span.badge.pair', 'Before / after pair');
  return h('span.badge.synth', 'Synthetic');
}
function realMeta(s) {
  const [x0, y0, x1, y1] = s.bbox; const ll = utm32ToLatLon((x0 + x1) / 2, (y0 + y1) / 2);
  return { ll, w: x1 - x0, hgt: y1 - y0, loc: LOCATIONS[s.id] || 'Denmark' };
}

function renderGallery() {
  const syn = $('#cardsSynthetic'), real = $('#cardsReal');
  syn.innerHTML = ''; real.innerHTML = '';
  for (const s of S.info.samples) {
    const p = S.info.presets[s.rainPreset] || S.info.presets[1];
    const thumb = h('div.thumb', h('div.shimmer'));
    thumb.dataset.sample = s.id;
    let meta;
    if (s.kind === 'real') {
      const r = realMeta(s);
      meta = h('div.card-meta', h('span.meta-item', { html: `${icon('pin', 13)} ${r.loc}` }), h('span.meta-item.mono', `${r.ll.lat.toFixed(3)}°N ${r.ll.lon.toFixed(3)}°E`));
    } else {
      meta = h('div.card-meta', h('span.meta-item', { html: `${icon('drop', 13)} ${p.name}` }));
    }
    const card = h('button.card', { onclick: () => { location.hash = `#/site/${s.id}`; }, dataset: { id: s.id } },
      thumb, badgeFor(s),
      h('div.card-body', h('h3', s.name.replace(' (real)', '')), h('p', s.description), meta));
    (s.kind === 'real' ? real : syn).append(card);
    if (s.kind === 'real') drawRealThumb(thumb, s);
  }
  // custom site card
  const drop = h('div.card.custom-card', { tabIndex: 0, onclick: () => $('#fileInput').click() },
    h('div.custom-inner',
      h('div.custom-icon', { html: icon('upload', 26) }),
      h('h3', 'Custom site'),
      h('p', 'Drop any GeoTIFF or ESRI ASCII terrain here, or click to browse.'),
      h('div.card-meta', h('span.meta-item.mono', '.tif  .tiff  .asc'))));
  const pick = h('button.card.custom-card.dhm-card', { onclick: () => openDhmPicker(openFetchedTerrain) },
    h('div.custom-inner',
      h('div.custom-icon', { html: icon('pin', 26) }),
      h('h3', 'Pick a location'),
      h('p', 'Search an address or click the map, paste your Datafordeler / Dataforsyningen key, and the DHM terrain is fetched straight into the browser.'),
      h('div.card-meta', h('span.meta-item.mono', 'DHM/Terræn · 0.4 m'))));
  real.append(pick, drop);
  const nSyn = S.info.samples.filter((s) => s.kind !== 'real').length, nReal = S.info.samples.length - nSyn;
  $('#heroStats').innerHTML = '';
  $('#heroStats').append(
    stat('Sample sites', nSyn), stat('Real DK sites', nReal),
    stat('Surface materials', S.info.palette.materials.length), stat('Rain presets', S.info.presets.length));
  function stat(l, v) { return h('div.hstat', h('b', String(v)), h('span', l)); }
}

async function makeThumbs() {
  for (const s of S.info.samples.filter((x) => x.kind !== 'real')) {
    if (S.thumbs.has(s.id)) continue;
    try {
      const p = S.info.presets[s.rainPreset] || S.info.presets[1];
      const g = await S.cb.buildGrid({ sample: s.id }, { cellSize: 1 });
      const r = await S.cb.runInstant(g, { rainDepthMm: p.depthMm, climateFactor: p.climateFactor, sewerMode: 1, moisture: 1 });
      const sj = await S.cb.sample(s.id);
      S.cb.freeGrid(g);
      const c = document.createElement('canvas'); c.width = 640; c.height = 400;
      const ctx = c.getContext('2d');
      const base = baseCanvas(g, S.info.palette, 0.3), ov = overlayCanvas(g, r.depth, DEPTH);
      ctx.fillStyle = '#0b1320'; ctx.fillRect(0, 0, c.width, c.height);
      const k = Math.max(c.width / (g.nx * g.dx), c.height / (g.ny * g.dx)); // cover
      const w = g.nx * g.dx * k, hh = g.ny * g.dx * k, ox = (c.width - w) / 2, oy = (c.height - hh) / 2;
      ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(base, ox, oy, w, hh); ctx.drawImage(ov, ox, oy, w, hh);
      const P = (x, y) => [ox + (x - g.x0) * k, oy + hh - (y - g.y0) * k];
      for (const b of sj.buildings) {
        const off = Math.min(14, b.height * 0.35);
        ctx.beginPath(); b.xs.forEach((x, i) => { const [px, py] = P(x, b.ys[i]); i ? ctx.lineTo(px + off, py + off) : ctx.moveTo(px + off, py + off); });
        ctx.fillStyle = 'rgba(20,28,40,0.28)'; ctx.fill();
      }
      for (const b of sj.buildings) {
        ctx.beginPath(); b.xs.forEach((x, i) => { const [px, py] = P(x, b.ys[i]); i ? ctx.lineTo(px, py) : ctx.moveTo(px, py); });
        const v = Math.round(58 + Math.min(26, b.height * 1.2)); ctx.fillStyle = `rgb(${v},${v + 6},${v + 15})`; ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,0.25)'; ctx.lineWidth = 1.5; ctx.stroke();
      }
      const url = c.toDataURL('image/png'); S.thumbs.set(s.id, url);
      for (const t of $$(`.thumb[data-sample="${s.id}"]`)) setThumb(t, url);
    } catch (e) { console.warn('thumb', s.id, e); }
  }
}
function setThumb(el, url) {
  el.innerHTML = ''; const img = h('img', { src: url, alt: '' }); el.append(img);
  requestAnimationFrame(() => img.classList.add('in'));
}

function drawRealThumb(el, s) {
  const c = document.createElement('canvas'); c.width = 640; c.height = 400; const ctx = c.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, 640, 400); g.addColorStop(0, '#12304f'); g.addColorStop(1, '#0a1626');
  ctx.fillStyle = g; ctx.fillRect(0, 0, 640, 400);
  // procedural, per-site "dark map": rotated city blocks + terrain contours (no network needed)
  let seed = [...s.id].reduce((acc, ch) => (acc * 31 + ch.charCodeAt(0)) % 233280, 7);
  const rnd = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280);
  ctx.save(); ctx.translate(320, 200); ctx.rotate((rnd() - 0.5) * 0.9);
  const bw = 46 + rnd() * 30, bh = 34 + rnd() * 26, st = 11 + rnd() * 6;
  for (let x = -520; x < 520; x += bw + st) for (let y = -420; y < 420; y += bh + st) {
    if (rnd() < 0.12) continue; // parks / squares
    const park = rnd() < 0.1;
    ctx.fillStyle = park ? 'rgba(90,174,97,0.14)' : 'rgba(124,196,242,0.07)';
    ctx.strokeStyle = 'rgba(124,196,242,0.14)'; ctx.lineWidth = 1;
    roundRect(ctx, x, y, bw, bh, 4); ctx.fill(); ctx.stroke();
  }
  ctx.restore();
  const bumps = Array.from({ length: 4 }, () => [rnd() * 640, rnd() * 400, 90 + rnd() * 170, rnd() > 0.5 ? 1 : -1]);
  const f = (x, y) => bumps.reduce((acc, [bx, by, r, sg]) => acc + sg * Math.exp(-((x - bx) ** 2 + (y - by) ** 2) / (r * r)), 0) + y / 700;
  ctx.lineWidth = 1.2; ctx.strokeStyle = 'rgba(124,196,242,0.22)';
  for (let lev = -1; lev <= 1.6; lev += 0.15) {
    ctx.beginPath();
    for (let y = 0; y < 400; y += 6) for (let x = 0; x < 640; x += 6) {
      const a0 = f(x, y) - lev, b0 = f(x + 6, y) - lev, d0 = f(x, y + 6) - lev;
      if (a0 * b0 < 0) { const t = a0 / (a0 - b0); ctx.moveTo(x + t * 6, y); ctx.lineTo(x + t * 6 + 0.6, y + 3); }
      if (a0 * d0 < 0) { const t = a0 / (a0 - d0); ctx.moveTo(x, y + t * 6); ctx.lineTo(x + 3, y + t * 6 + 0.6); }
    }
    ctx.stroke();
  }
  // bbox frame + pin
  ctx.strokeStyle = 'rgba(124,196,242,0.7)'; ctx.setLineDash([8, 6]); ctx.lineWidth = 2; ctx.strokeRect(200, 105, 240, 190); ctx.setLineDash([]);
  ctx.fillStyle = 'rgba(79,168,224,0.18)'; ctx.beginPath(); ctx.arc(320, 200, 42, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#4FA8E0'; ctx.beginPath(); ctx.arc(320, 182, 16, Math.PI, 0); ctx.lineTo(320, 214); ctx.closePath(); ctx.fill();
  ctx.fillStyle = '#0b1320'; ctx.beginPath(); ctx.arc(320, 182, 6, 0, Math.PI * 2); ctx.fill();
  ctx.font = '600 20px Inter, system-ui, sans-serif'; ctx.fillStyle = 'rgba(207,230,255,0.85)';
  ctx.fillText(`EPSG:25832  ${s.bbox[2] - s.bbox[0]} × ${s.bbox[3] - s.bbox[1]} m`, 24, 376);
  el.innerHTML = ''; el.append(c); c.classList.add('in');
}

function showWorkspace() {
  $('#gallery').classList.add('hidden'); $('#workspace').classList.remove('hidden');
  if (map) { map.resize(); map.request(); }
}
function showGallery() {
  stopPlay();
  $('#gallery').classList.remove('hidden'); $('#workspace').classList.add('hidden');
  $('#crumbs').innerHTML = '';
  if (S.view3d) toggle3D(false);
}

// ------------------------------------------------------------------------------------------------ workspace
async function openSite(id, custom = null) {
  closeSite();
  const info = custom ? custom.info : sampleInfo(id);
  S.site = { id, kind: custom ? 'custom' : info.kind, info, name: info.name.replace(' (real)', '') };
  const p = S.info.presets[info.rainPreset] || S.info.presets[1];
  Object.assign(S.settings, { presetId: p.id, rainDepthMm: p.depthMm, climateFactor: p.climateFactor });
  $('#gallery').classList.add('hidden'); $('#workspace').classList.remove('hidden');
  $('#crumbs').innerHTML = '';
  $('#crumbs').append(h('a', { href: '#/', html: `${icon('back', 14)} Samples` }), h('span.sep', '/'), h('span.cur', S.site.name), badgeFor({ ...info, kind: S.site.kind === 'custom' ? 'real' : info.kind }));
  ensureMap();
  renderLeft(); renderRight(); renderMapChrome();
  if (S.site.kind === 'synthetic') {
    S.sampleJson = await S.cb.sample(id);
    S.siteDesc = { sample: id };
    await loadGrid();
  } else if (custom) {
    S.siteDesc = { terrainBytes: custom.bytes };
    await loadGrid();
  } else {
    showSiteDrop();
    tryAutoLoadDhm(info);
  }
}

function closeSite() {
  stopPlay();
  if (S.dynRun) { S.dynRun.cancel(); S.dynRun = null; }
  if (S.grid) S.cb.freeGrid(S.grid).catch(() => {});
  Object.assign(S, { site: null, siteDesc: null, sampleJson: null, grid: null, scene: null, instant: null, dyn: null, frame: -1, source: 'instant', compare: null, options: [], layer: 'depth', matCanvas: null });
  S.retention.result = null;
  if (map) map.setScenes([]);
  $('#siteDrop').classList.add('hidden');
}

function ensureMap() {
  if (map) return;
  map = new MapView($('#map'), { onHover, onLeave: () => $('#tooltip').classList.add('hidden') });
  window.__map = map;
}

async function loadGrid() {
  setBusy(true, 'Building grid…');
  let grid = null, lastErr = null;
  const site = S.site;
  for (const cellSize of S.site.kind === 'synthetic' ? [1] : [1, 2, 4, 8]) {
    try {
      grid = await S.cb.buildGrid(S.siteDesc, { cellSize });
      if (grid.nx * grid.ny > 900000 && cellSize < 8) { S.cb.freeGrid(grid); grid = null; continue; }
      break;
    } catch (e) { lastErr = e; }
  }
  if (S.site !== site) { if (grid) S.cb.freeGrid(grid); return; }
  if (!grid) { setBusy(false); toast(`Could not read terrain: ${lastErr ? lastErr.message : 'unknown error'}`, 'error'); showSiteDrop(); return; }
  S.grid = grid;
  $('#siteDrop').classList.add('hidden');
  const base = baseCanvas(grid, S.info.palette);
  S.scene = { grid, base, buildingsVec: S.sampleJson ? S.sampleJson.buildings : null, buildingsRaster: S.sampleJson ? null : buildingsCanvas(grid) };
  map.setScenes([S.scene]); map.fit();
  if (S.view3d && S.v3) S.v3.setSite(grid, base, S.scene.buildingsVec);
  renderLeft(); renderRight(); renderMapChrome();
  await runInstantNow();
  computeRetention();
}

// ---------- real sites
function showSiteDrop() {
  const el = $('#siteDrop'); const s = S.site.info; el.innerHTML = ''; el.classList.remove('hidden');
  const isReal = s.bbox;
  const card = h('div.site-card');
  if (isReal) {
    const r = realMeta(s);
    card.append(
      h('div.eyebrow', 'Real site · terrain required'),
      h('h2', S.site.name),
      h('p.muted', s.description),
      h('div.loc-grid',
        h('div', h('label', 'Location'), h('b', { html: `${icon('pin', 14)} ${r.loc}` })),
        h('div', h('label', 'WGS84'), h('b.mono', fmtLatLon(r.ll))),
        h('div', h('label', 'Extent (EPSG:25832)'), h('b.mono', `${s.bbox[0]}, ${s.bbox[1]} → ${s.bbox[2]}, ${s.bbox[3]}`)),
        h('div', h('label', 'Size'), h('b', `${r.w} × ${r.hgt} m`))));
  }
  const dz = h('div.dropzone', { onclick: () => $('#fileInput').click() },
    h('div.dz-icon', { html: icon('upload', 28) }),
    h('div.dz-title', 'Drop DHM GeoTIFF / ASC here'),
    h('div.dz-sub', 'or click to browse'),
    s.dhmFile ? h('div.dz-file', { html: `${icon('file', 14)} <span class="mono">${s.dhmFile}</span>` }) : null);
  card.append(dz);
  if (isReal) {
    const [x0, y0, x1, y1] = s.bbox; const ll = utm32ToLatLon((x0 + x1) / 2, (y0 + y1) / 2);
    card.append(h('button.btn.primary.fetch-dhm', {
      html: `${icon('download', 15)} Fetch terrain with API key`,
      onclick: () => openDhmPicker(async ({ bytes }) => { S.siteDesc = { terrainBytes: bytes }; await loadGrid(); },
        { lat: ll.lat, lon: ll.lon, size: Math.round(x1 - x0), name: S.site.name }),
    }));
  }
  if (s.dhmFile) card.append(h('div.hint', { html: `${icon('terminal', 14)} <span>Produce it with <code>tools/fetch_dhm.py</code> (Dataforsyningen token, DHM/Terræn 0.4 m). Files placed in <code>Web/data/</code> load automatically.</span>` }));
  el.append(card);
  for (const ev of ['dragenter', 'dragover']) dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('over'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('over'));
}

async function tryAutoLoadDhm(info) {
  if (!info.dhmFile) return;
  try {
    const list = await fetch('data/', { cache: 'no-store' });
    if (!list.ok) return;
    const html = await list.text();
    if (!html.includes(`"${info.dhmFile}"`) && !html.includes(`>${info.dhmFile}<`)) return;
    const res = await fetch(`data/${info.dhmFile}`);
    if (!res.ok || S.site?.info !== info) return;
    toast(`Loaded data/${info.dhmFile}`);
    S.siteDesc = { terrainBytes: new Uint8Array(await res.arrayBuffer()) };
    await loadGrid();
  } catch { /* no data folder: fine */ }
}

function setupGlobalDrop() {
  let depth = 0;
  window.addEventListener('dragenter', (e) => { e.preventDefault(); depth++; document.body.classList.add('dragging-file'); });
  window.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; document.body.classList.remove('dragging-file'); } });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault(); depth = 0; document.body.classList.remove('dragging-file'); $$('.dropzone').forEach((d) => d.classList.remove('over'));
    const f = e.dataTransfer.files && e.dataTransfer.files[0]; if (f) onTerrainFile(f);
  });
}

async function openFetchedTerrain({ bytes, info }) {
  history.replaceState(null, '', '#/custom');
  await openSite('custom', { info, bytes });
}

async function onTerrainFile(file) {
  if (!/\.(tif|tiff|asc|txt)$/i.test(file.name)) { toast('Please drop a GeoTIFF (.tif) or ESRI ASCII (.asc) terrain file', 'error'); return; }
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (S.site && S.site.kind === 'real' && !S.grid) {
    S.siteDesc = { terrainBytes: bytes };
    toast(`Reading ${file.name}…`);
    await loadGrid();
    return;
  }
  const info = { id: 'custom', name: file.name.replace(/\.[^.]+$/, ''), description: `Uploaded terrain: ${file.name} (${fmt1(file.size / 1e6)} MB)`, kind: 'custom', rainPreset: 1, bbox: null, dhmFile: null, compareWith: null };
  history.replaceState(null, '', '#/custom');
  await openSite('custom', { info, bytes });
}

// ------------------------------------------------------------------------------------------------ instant model
function scenarioInstant() {
  const s = S.settings;
  return { rainDepthMm: s.rainDepthMm, climateFactor: s.climateFactor, sewerMode: s.sewerMode, moisture: s.moisture, minDepth: 0.01 };
}
const scheduleInstant = debounce(() => runInstantNow(), 90);

async function runInstantNow() {
  if (!S.grid) return;
  if (S.instBusy) { S.instPending = true; return; }
  S.instBusy = true; setBusy(true);
  const grid = S.grid; const t0 = performance.now();
  try {
    const r = await S.cb.runInstant(grid, scenarioInstant());
    if (grid !== S.grid) return;
    S.instant = r; S.instMs = performance.now() - t0;
    refreshMap(); updateResults(); renderCaption();
    pulseLive();
  } catch (e) { console.error(e); toast(`Instant model failed: ${e.message}`, 'error'); }
  finally {
    S.instBusy = false;
    if (S.instPending) { S.instPending = false; runInstantNow(); } else setBusy(false);
  }
}

function settingsChanged() {
  scheduleInstant(); renderCaption(); updateRainSummary(); updateDynStale();
  computeRetentionDebounced();
}

// ------------------------------------------------------------------------------------------------ map layers
function topBluespots(r, n = 6) {
  return [...r.bluespots].filter((b) => b.volumeM3 >= 1).sort((a, b) => b.volumeM3 - a.volumeM3).slice(0, n);
}

function activeLayerData() {
  // returns {grid, overlay, values (for 3D water depth), min}
  const L = S.layer;
  if (L === 'materials') {
    if (!S.matCanvas) S.matCanvas = materialCanvas(S.grid, S.info.palette);
    return { grid: S.grid, overlay: S.matCanvas, depth: S.source === 'dynamic' && S.dyn ? S.dyn.hMax : S.instant && S.instant.depth, wgrid: S.source === 'dynamic' && S.dyn ? S.dyn.grid : S.grid, min: 0.01 };
  }
  if (S.source === 'dynamic' && S.dyn) {
    const d = S.dyn; const g = d.grid; const hM = d.hMax;
    const depth = S.frame >= 0 ? d.frames[S.frame] : hM;
    const wet = (k) => hM[k] >= 0.03;
    if (L === 'depth') return { grid: g, overlay: overlayCanvas(g, depth, DEPTH_DYN), depth, min: 0.03 };
    if (L === 'velocity') return { grid: g, overlay: overlayCanvas(g, d.vMax, VELOCITY, { mask: wet }), depth: hM, min: 0.03 };
    if (L === 'hazard') return { grid: g, overlay: overlayCanvas(g, d.hazard, HAZARD, { mask: wet }), depth: hM, min: 0.03 };
    if (L === 'tpeak') {
      if (!d.tPeakMin) { d.tPeakMin = new Float32Array(d.tPeak.length); for (let k = 0; k < d.tPeak.length; k++) d.tPeakMin[k] = d.tPeak[k] / 60; }
      return { grid: g, overlay: overlayCanvas(g, d.tPeakMin, TPEAK, { mask: wet }), depth: hM, min: 0.03 };
    }
  }
  if (!S.instant) return { grid: S.grid, overlay: null };
  return { grid: S.grid, overlay: overlayCanvas(S.grid, S.instant.depth, DEPTH), depth: S.instant.depth, min: 0.01 };
}

function refreshMap() {
  if (!map || !S.scene) return;
  if (S.compare) { renderCompareScenes(); renderLegend(); return; }
  const d = activeLayerData();
  const sc = S.scene;
  sc.overlay = d.overlay; sc.overlayGrid = d.grid;
  sc.labels = S.source === 'instant' && S.instant && S.layer === 'depth'
    ? topBluespots(S.instant).map((b) => ({ x: b.x, y: b.y, spills: b.spills, text: `${fmtVol(b.volumeM3)} m³ · ${Math.round(b.maxDepthM * 100)} cm` }))
    : null;
  map.showPaths = S.showPaths; map.showLabels = S.showLabels;
  map.setPaths(sc, S.instant ? S.instant.paths : null);
  map.setScenes([sc]);
  if (S.view3d && S.v3) S.v3.setWater(d.wgrid || d.grid, d.depth, d.overlay, d.min || 0.01);
  renderLegend();
}

// ------------------------------------------------------------------------------------------------ map chrome
function renderMapChrome() {
  const seg = $('#layerSeg'); seg.innerHTML = '';
  if (S.compare) {
    seg.append(h('span.seg-label', 'Compare'));
    for (const [id, label, ic] of [['swipe', 'Swipe', 'swipe'], ['diff', 'Difference', 'diff']]) {
      seg.append(h(`button.seg-btn${S.compare.mode === id ? '.on' : ''}`, { html: `${icon(ic, 14)} ${label}`, onclick: () => { S.compare.mode = id; renderMapChrome(); refreshMap(); } }));
    }
  } else {
    const src = h('div.subseg');
    for (const [id, label] of [['instant', 'Instant'], ['dynamic', 'Dynamic']]) {
      const dis = id === 'dynamic' && !S.dyn;
      src.append(h(`button.seg-btn.src${S.source === id ? '.on' : ''}${dis ? '.dis' : ''}`, {
        title: dis ? 'Run a dynamic simulation first' : '', html: `${icon(id === 'instant' ? 'bolt' : 'wave', 14)} ${label}`,
        onclick: () => { if (dis) { toast('Run a dynamic simulation first (left panel, step 3)'); return; } setSource(id); },
      }));
    }
    seg.append(src, h('span.vsep'));
    for (const [id, L] of Object.entries(LAYERS)) {
      const dis = L.needsDynamic && !(S.dyn && S.source === 'dynamic');
      seg.append(h(`button.seg-btn${S.layer === id ? '.on' : ''}${dis ? '.dis' : ''}`, {
        dataset: { layer: id }, title: dis ? 'Needs dynamic results' : '', textContent: L.label,
        onclick: () => {
          if (dis) { if (S.dyn) { setSource('dynamic'); setLayer(id); } else toast(`${L.label} needs a dynamic simulation, run it in step 3`); return; }
          setLayer(id);
        },
      }));
    }
  }
  const tb = $('#toggleBar'); tb.innerHTML = '';
  tb.append(toggleBtn('Flow paths', S.showPaths, (v) => { S.showPaths = v; map.showPaths = v; map.request(); }, 'wave'),
    toggleBtn('Labels', S.showLabels, (v) => { S.showLabels = v; map.showLabels = v; map.request(); }, 'target'));
  tb.classList.toggle('hidden', !!S.compare);
  const vs = $('#viewSeg'); vs.innerHTML = '';
  vs.append(h(`button${!S.view3d ? '.on' : ''}`, { title: 'Top-down map', html: `${icon('map', 16)}2D`, onclick: () => toggle3D(false) }),
    h(`button${S.view3d ? '.on' : ''}`, { title: '3D view (three.js)', html: `${icon('cube', 16)}3D`, onclick: () => toggle3D(true) }));
  vs.classList.toggle('hidden', !!S.compare);
  const ex = $('#exportBar'); ex.innerHTML = '';
  ex.append(h('button', { title: 'Download current layer as PNG', html: `${icon('image', 16)}PNG`, onclick: exportPNG }),
    h('button', { title: 'Download results (stats + bluespots) as JSON', html: `${icon('json', 16)}JSON`, onclick: exportJSON }));
  const zb = $('#zoomBar'); zb.innerHTML = '';
  zb.append(h('button', { title: 'Zoom in', html: icon('plus', 16), onclick: () => map.zoomBy(1.5) }),
    h('button', { title: 'Zoom out', html: icon('minus', 16), onclick: () => map.zoomBy(1 / 1.5) }),
    h('button', { title: 'Fit site', html: icon('fit', 16), onclick: () => map.fit(true) }));
  zb.classList.toggle('hidden', S.view3d);
  renderTimebar(); renderLegend(); renderCaption();
}
function toggleBtn(label, on, fn, ic) {
  const b = h(`button.tog${on ? '.on' : ''}`, { html: `<span class="sw"></span>${label}` });
  b.onclick = () => { const v = !b.classList.contains('on'); b.classList.toggle('on', v); fn(v); };
  return b;
}
function setLayer(id) { S.layer = id; renderMapChrome(); refreshMap(); }
function setSource(src) {
  S.source = src;
  if (src === 'instant' && LAYERS[S.layer].needsDynamic) S.layer = 'depth';
  stopPlay(); renderMapChrome(); refreshMap(); updateResults();
}

function renderLegend() {
  const el = $('#legend'); el.innerHTML = '';
  let ramp = null, title = '', note = '';
  if (S.compare) {
    if (S.compare.mode === 'diff') { ramp = DIFF; title = DIFF.title; note = 'green = drier in B · red = wetter in B'; }
    else { ramp = DEPTH; title = 'Water depth'; note = 'A left · B right · hidden < 1 cm'; }
  } else if (S.layer === 'materials') {
    if (!S.grid) return;
    el.append(h('div.lg-title', 'Surface materials'));
    for (const m of materialsPresent(S.grid, S.info.palette)) el.append(h('div.lg-row', h('span.sw', { style: { background: m.color } }), h('span', m.name), h('span.lg-val', fmtArea(m.areaM2))));
    el.append(h('div.lg-row', h('span.sw', { style: { background: '#4a5260' } }), h('span', 'Buildings')));
    return;
  } else {
    const dyn = S.source === 'dynamic' && S.dyn;
    ramp = LAYERS[S.layer].ramp; title = ramp.title;
    if (S.layer === 'depth') { title = dyn ? (S.frame >= 0 ? `Water depth at ${fmtClock(S.dyn.frameTimes[S.frame])}` : 'Maximum water depth') : 'Water depth (bluespots full)'; note = dyn ? 'hidden < 3 cm' : 'hidden < 1 cm'; }
    else note = 'max over event · where depth ≥ 3 cm';
  }
  el.append(h('div.lg-title', title, h('span.lg-unit', ramp.unit)));
  ramp.colors.forEach((c, i) => el.append(h('div.lg-row', h('span.sw', { style: { background: c } }), h('span', ramp.labels[i]))));
  if (note) el.append(h('div.lg-note', note));
  if (!S.compare && S.showPaths && S.instant) el.append(h('div.lg-row.extra', h('span.sw.line'), h('span', 'Flow path · width ∝ log volume')));
  if (!S.compare && S.showLabels && S.source === 'instant' && S.layer === 'depth') el.append(h('div.lg-row.extra', h('span.sw.dot'), h('span', 'Bluespot'), h('span.sw.dot.spill'), h('span', 'spills')));
}

function captionText() {
  const s = S.settings; const p = preset();
  const design = s.rainDepthMm * s.climateFactor;
  const parts = [`${p.name.replace(' (cloudburst)', '')}: ${fmtInt(s.rainDepthMm)} mm × ${s.climateFactor.toFixed(2)} = ${fmtInt(design)} mm`,
    SEWER[s.sewerMode].long, `${MOIST[s.moisture].label} soil`];
  const cell = S.source === 'dynamic' && S.dyn ? S.dyn.grid.dx : (S.grid ? S.grid.dx : 1);
  parts.push(`cell ${cell} m`);
  if (S.source === 'dynamic' && S.dyn) parts.push('dynamic 2D'); else parts.push('instant bluespot');
  return parts.join(' · ');
}
function renderCaption() {
  const el = $('#caption');
  if (!S.grid) { el.innerHTML = ''; return; }
  const text = S.compare ? `Compare: A = ${S.compare.a.name} · B = ${S.compare.b.name}` : captionText();
  el.innerHTML = '';
  el.append(h('span', text), h('b.warn', 'SCREENING MODEL – not for compliance'));
}

// ---------- hover tooltip
function onHover(x, y, sx, sy, side) {
  const tt = $('#tooltip');
  if (!S.grid || S.view3d) { tt.classList.add('hidden'); return; }
  const rows = [];
  if (S.compare) {
    const { a, b } = S.compare;
    const ka = cellAt(a.grid, x, y); if (ka < 0) { tt.classList.add('hidden'); return; }
    const da = a.depth[ka], db = sampleAt(b.grid, b.depth, x, y) ?? 0;
    rows.push(['Elevation', `${a.grid.terrainZ[ka].toFixed(2)} m`]);
    rows.push([`A · ${a.short}`, fmtCm(da)], [`B · ${b.short}`, fmtCm(db)]);
    const dd = db - da; rows.push(['Change', `<span class="${dd > 0.005 ? 'up' : dd < -0.005 ? 'down' : ''}">${dd >= 0 ? '+' : '−'}${Math.abs(Math.round(dd * 100))} cm</span>`]);
  } else {
    const g = S.grid; const k = cellAt(g, x, y);
    if (k < 0) { tt.classList.add('hidden'); return; }
    rows.push(['Elevation', `${g.terrainZ[k].toFixed(2)} m`]);
    if (g.building[k] >= 0) {
      const b = S.sampleJson && S.sampleJson.buildings[g.building[k]];
      rows.push(['Building', b ? `${b.name} · ${b.height} m` : `${(g.z[k] - g.terrainZ[k]).toFixed(1)} m`]);
    } else {
      const m = S.info.palette.materials[g.material[k]];
      rows.push(['Surface', m ? m.name : '–']);
      if (S.source === 'dynamic' && S.dyn) {
        const dg = S.dyn.grid; const kd = cellAt(dg, x, y);
        if (kd >= 0) {
          if (S.frame >= 0) rows.push([`Depth @ ${fmtClock(S.dyn.frameTimes[S.frame])}`, fmtCm(S.dyn.frames[S.frame][kd])]);
          rows.push(['Max depth', fmtCm(S.dyn.hMax[kd])], ['Max velocity', `${S.dyn.vMax[kd].toFixed(2)} m/s`],
            ['Hazard', S.dyn.hazard[kd].toFixed(2)], ['Time to peak', S.dyn.hMax[kd] >= 0.03 ? `${Math.round(S.dyn.tPeak[kd] / 60)} min` : '–']);
        }
      } else if (S.instant) {
        const d = S.instant.depth[k]; rows.push(['Depth', d >= 0.01 ? fmtCm(d) : 'dry']);
        const acc = S.instant.accumulation[k]; if (acc > 0.5) rows.push(['Flow through', `${fmtVol(acc)} m³`]);
        const lab = S.instant.labels ? S.instant.labels[k] : -1;
        if (lab >= 0) { const bs = S.instant.bluespots.find((b) => b.id === lab); if (bs && bs.volumeM3 >= 1) rows.push(['Bluespot', `${fmtVol(bs.volumeM3)} m³${bs.spills ? ' · spills' : ''}`]); }
      }
    }
  }
  tt.innerHTML = rows.map(([k, v]) => `<div class="tt-row"><span>${k}</span><b>${v}</b></div>`).join('');
  tt.classList.remove('hidden');
  const W = map.W, H = map.H; const tw = tt.offsetWidth, th = tt.offsetHeight;
  tt.style.transform = `translate(${sx + 16 + tw > W ? sx - tw - 14 : sx + 16}px, ${sy + 16 + th > H ? sy - th - 12 : sy + 16}px)`;
}

// ------------------------------------------------------------------------------------------------ left panel
function renderLeft() {
  const el = $('#leftPanel'); el.innerHTML = '';
  const s = S.settings;
  el.append(h('div.panel-head', h('div.eyebrow', 'Scenario'), h('h2', S.site ? S.site.name : '')));

  // 1 rain
  const presets = h('div.presets');
  for (const p of S.info.presets) {
    const peak = Math.max(...p.intensity);
    presets.append(h(`button.preset${p.id === s.presetId ? '.on' : ''}`, {
      dataset: { preset: p.id },
      onclick: () => {
        Object.assign(s, { presetId: p.id, rainDepthMm: p.depthMm, climateFactor: p.climateFactor });
        $$('.preset', el).forEach((b) => b.classList.toggle('on', b.dataset.preset === p.id));
        syncSliders(); settingsChanged();
      },
    }, h('div.pre-top', h('span.pre-name', PRESET_LABEL[p.id] || p.name)),
    h('div.hyeto', { html: hyetoSvg(p.intensity) }),
    h('div.pre-foot', h('span', `${fmtInt(p.depthMm * p.climateFactor)} mm`), h('span.muted', `${p.durationMin / 60} h · peak ${fmtInt(peak * p.climateFactor)} mm/h`))));
  }
  el.append(step(1, 'Rain event', 'drop',
    presets,
    slider('rainDepth', 'Rain depth', 10, 150, 1, s.rainDepthMm, (v) => `${fmtInt(v)} mm`, (v) => { s.rainDepthMm = v; settingsChanged(); }),
    slider('climate', 'Climate factor', 1, 1.6, 0.05, s.climateFactor, (v) => `× ${v.toFixed(2)}`, (v) => { s.climateFactor = v; settingsChanged(); }),
    h('div.rain-summary#rainSummary')));
  updateRainSummary();

  // 2 drainage & soil
  el.append(step(2, 'Drainage & soil', 'layers',
    h('label.field-label', 'Sewer system'),
    segControl(SEWER.map((o) => ({ v: o.v, html: `${o.label}${o.sub ? `<small>${o.sub}</small>` : ''}` })), s.sewerMode, (v) => { s.sewerMode = v; settingsChanged(); }, 'sewer'),
    h('label.field-label', 'Soil moisture'),
    segControl(MOIST.map((o) => ({ v: o.v, html: o.label })), s.moisture, (v) => { s.moisture = v; settingsChanged(); }, 'moisture')));

  // 3 dynamic
  const dynBox = h('div#dynBox');
  el.append(step(3, 'Dynamic simulation', 'wave',
    h('p.step-note', '2D shallow-water run over time: velocities, hazard and time to peak.'),
    h('label.field-label', 'Cell size'),
    segControl([1, 2, 4].map((v) => ({ v, html: `${v} m` })), S.dynCell, (v) => { S.dynCell = v; renderDynBox(); }, 'dyncell'),
    h('label.field-label', 'Duration'),
    segControl(DURATIONS.map((d) => ({ v: d.id, html: d.label })), S.dynDuration, (v) => { S.dynDuration = v; renderDynBox(); }, 'dyndur'),
    dynBox));
  renderDynBox();
  el.classList.toggle('locked', !!S.compare); if (S.compare) el.scrollTop = 0;
  if (S.compare) el.append(h('div.panel-lock', h('div', h('b', 'Comparing options'), h('p', 'The map shows saved options. Exit compare to keep editing.'), h('button.btn.primary', { onclick: exitCompare }, 'Exit compare'))));
}

function step(n, title, ic, ...body) {
  return h('section.step', h('div.step-head', h('span.step-n', String(n)), h('h3', title)), h('div.step-body', ...body));
}
function slider(id, label, min, max, stepv, value, fmt, onInput) {
  const out = h('output', fmt(value));
  const inp = h('input', { type: 'range', min, max, step: stepv, value, id: `sl-${id}` });
  const paint = () => inp.style.setProperty('--p', `${((inp.value - min) / (max - min)) * 100}%`);
  paint();
  inp.addEventListener('input', () => { const v = +inp.value; out.textContent = fmt(v); paint(); onInput(v); });
  inp._set = (v) => { inp.value = v; out.textContent = fmt(+v); paint(); };
  return h('div.slider', h('div.sl-head', h('label', { htmlFor: `sl-${id}` }, label), out), inp);
}
function syncSliders() { $('#sl-rainDepth')._set(S.settings.rainDepthMm); $('#sl-climate')._set(S.settings.climateFactor); }
function segControl(opts, value, onChange, name) {
  const wrap = h('div.segctl', { dataset: { name } });
  for (const o of opts) {
    const b = h(`button${o.v === value ? '.on' : ''}`, { html: o.html, dataset: { v: String(o.v) } });
    b.onclick = () => { $$('button', wrap).forEach((x) => x.classList.toggle('on', x === b)); onChange(o.v); };
    wrap.append(b);
  }
  return wrap;
}
function hyetoSvg(arr, w = 132, hgt = 34, bars = 40) {
  const n = arr.length; const per = n / bars; const vals = [];
  for (let b = 0; b < bars; b++) { let m = 0; for (let i = Math.floor(b * per); i < Math.floor((b + 1) * per); i++) m = Math.max(m, arr[i] || 0); vals.push(m); }
  const mx = Math.max(...vals) || 1; const bw = w / bars;
  return `<svg viewBox="0 0 ${w} ${hgt}" preserveAspectRatio="none" width="100%" height="${hgt}">${vals.map((v, i) => {
    const hh = Math.max(1, (v / mx) * (hgt - 2)); return `<rect x="${(i * bw + 0.4).toFixed(2)}" y="${(hgt - hh).toFixed(2)}" width="${(bw - 0.8).toFixed(2)}" height="${hh.toFixed(2)}" rx="0.8"/>`;
  }).join('')}</svg>`;
}
function areaSvg(arr, w, hgt) {
  const mx = Math.max(...arr) || 1; const n = arr.length;
  let dpath = `M0 ${hgt}`;
  arr.forEach((v, i) => { const y = (hgt - 1 - (v / mx) * (hgt - 3)).toFixed(2); dpath += ` L${((i / n) * w).toFixed(2)} ${y} L${(((i + 1) / n) * w).toFixed(2)} ${y}`; });
  dpath += ` L${w} ${hgt} Z`;
  return `<svg viewBox="0 0 ${w} ${hgt}" preserveAspectRatio="none" width="100%" height="${hgt}"><path d="${dpath}"/></svg>`;
}
function updateRainSummary() {
  const el = $('#rainSummary'); if (!el) return;
  const s = S.settings; const design = s.rainDepthMm * s.climateFactor;
  el.innerHTML = `<span>Design rain</span><b>${fmtInt(design)} mm</b><span class="muted">${fmtInt(s.rainDepthMm)} mm × ${s.climateFactor.toFixed(2)} climate</span>`;
}

// ---------- dynamic
function dynamicRain() {
  const p = preset(); const s = S.settings; const dur = DURATIONS.find((d) => d.id === S.dynDuration);
  const scale = s.rainDepthMm / p.depthMm;
  let rain = Array.from(p.intensity, (v) => v * scale);
  if (dur.cut) rain = rain.slice(0, dur.cut);
  return { rain, after: dur.after, totalMin: rain.length + dur.after };
}
function estimateRunS() {
  if (!S.grid) return 0;
  const { totalMin } = dynamicRain(); const c = S.dynCell;
  const cells = (S.grid.nx * S.grid.dx / c) * (S.grid.ny * S.grid.dx / c);
  return 7.5e-6 * cells * totalMin * (2 / c);
}
function settingsKey() { return JSON.stringify({ ...S.settings, cell: S.dynCell, dur: S.dynDuration }); }

function renderDynBox() {
  const box = $('#dynBox'); if (!box) return; box.innerHTML = '';
  if (S.dynRun) {
    box.append(h('div.progress-card',
      h('div.pc-head', h('span.spinner'), h('b#dynPct', 'Starting…'), h('span.muted#dynEta', '')),
      h('div.bar', h('div.fill#dynFill')),
      h('div.pc-meta', h('span#dynSim', ''), h('span#dynH', '')),
      h('button.btn.ghost.small', { onclick: cancelDynamic, html: `${icon('stop', 12)} Cancel` })));
    return;
  }
  const est = estimateRunS();
  box.append(h('button.btn.primary.wide#runDyn', { onclick: startDynamic, disabled: !S.grid, html: `${icon('play', 14)} ${S.dyn ? 'Re-run' : 'Run'} dynamic simulation` }),
    h('div.est', { html: `${icon('clock', 13)} Estimated ${est < 60 ? `≈ ${Math.max(2, Math.round(est))} s` : `≈ ${Math.round(est / 60)} min`} · ${dynamicRain().totalMin} min simulated` }));
  if (S.dyn) {
    const m = S.dyn.mass;
    box.append(h('div.dyn-done', { html: `${icon('check', 14)} Done in ${fmt1(m.elapsedS)} s · ${fmtInt(m.steps)} steps · ${S.dyn.frames.length} frames` }));
    box.append(h('div.stale#dynStale.hidden', { html: `${icon('alert', 13)} Settings changed since this run` }));
    updateDynStale();
  }
}
function updateDynStale() { const el = $('#dynStale'); if (el && S.dyn) el.classList.toggle('hidden', S.dyn.key === settingsKey()); renderDynBoxEst(); }
function renderDynBoxEst() { if (!S.dynRun && $('#runDyn')) { const est = estimateRunS(); const e = $('.est'); if (e) e.innerHTML = `${icon('clock', 13)} Estimated ${est < 60 ? `≈ ${Math.max(2, Math.round(est))} s` : `≈ ${Math.round(est / 60)} min`} · ${dynamicRain().totalMin} min simulated`; } }

function startDynamic() {
  if (!S.grid || S.dynRun) return;
  const { rain, after, totalMin } = dynamicRain();
  const outInt = Math.max(60, Math.round((totalMin * 60) / 48 / 60) * 60);
  const scenario = { ...scenarioInstant(), afterRainMin: after, outputIntervalS: outInt, maxFrames: 120 };
  const key = settingsKey(); const site = S.site;
  const run = S.cb.runDynamic(S.siteDesc, { cellSize: S.dynCell }, scenario, rain, [], (p) => {
    if (S.dynRun !== run) return;
    const f = clamp(p.fraction, 0, 1); const eta = f > 0.02 ? (p.elapsedS * (1 - f)) / f : NaN;
    const pct = $('#dynPct'); if (!pct) return;
    pct.textContent = `${Math.round(f * 100)} %`;
    $('#dynFill').style.width = `${f * 100}%`;
    $('#dynEta').textContent = isFinite(eta) ? `${fmtDuration(eta)} left` : 'estimating…';
    $('#dynSim').textContent = `t = ${fmtClock(p.timeS)} / ${fmtClock(totalMin * 60)}`;
    $('#dynH').textContent = `max depth ${fmtCm(p.hMax)}`;
  });
  S.dynRun = run; renderDynBox();
  run.result.then((res) => {
    if (S.dynRun !== run || S.site !== site) return;
    S.dynRun = null;
    res.key = key; res.rain = rain; res.totalMin = totalMin;
    S.dyn = res; S.frame = -1; S.source = 'dynamic';
    renderDynBox(); renderMapChrome(); refreshMap(); updateResults();
    toast(`Dynamic run finished in ${fmt1(res.mass.elapsedS)} s`, 'ok');
  }).catch((e) => {
    if (S.dynRun === run) { S.dynRun = null; renderDynBox(); }
    if (!/cancel/.test(e.message)) { console.error(e); toast(`Dynamic run failed: ${e.message}`, 'error'); }
  });
}
function cancelDynamic() { if (S.dynRun) { S.dynRun.cancel(); S.dynRun = null; renderDynBox(); toast('Simulation cancelled'); } }

// ---------- time bar
function renderTimebar() {
  const tb = $('#timebar');
  const show = S.dyn && S.source === 'dynamic' && !S.compare && S.layer === 'depth';
  tb.classList.toggle('hidden', !show); $('#mapwrap').classList.toggle('has-time', !!show);
  if (map) { map.bottomInset = show ? 128 : 58; map.request(); }
  if (!show) return;
  tb.innerHTML = '';
  const d = S.dyn; const n = d.frames.length;
  const play = h('button.play', { html: icon(S.playing ? 'pause' : 'play', 16), title: 'Play', onclick: togglePlay });
  const totalS = d.totalMin * 60;
  const rainSvg = h('div.tb-rain', { html: areaSvg(d.rain.concat(new Array(Math.max(0, d.totalMin - d.rain.length)).fill(0)), 400, 26) });
  const inp = h('input#timeSlider', { type: 'range', min: 0, max: n - 1, step: 1, value: S.frame < 0 ? n - 1 : S.frame });
  const label = h('div.tb-time');
  const maxBtn = h(`button.tog.small${S.frame < 0 ? '.on' : ''}`, { html: '<span class="sw"></span>Max envelope' });
  const upd = () => {
    const t = S.frame < 0 ? null : d.frameTimes[S.frame];
    label.innerHTML = t == null ? `<b>Max</b><span>over ${fmtClock(totalS)}</span>` : `<b>${fmtClock(t)}</b><span>of ${fmtClock(totalS)}</span>`;
    const f = S.frame < 0 ? 1 : t / totalS;
    rainSvg.style.setProperty('--p', `${f * 100}%`);
    inp.style.setProperty('--p', `${((S.frame < 0 ? n - 1 : S.frame) / Math.max(1, n - 1)) * 100}%`);
    maxBtn.classList.toggle('on', S.frame < 0);
  };
  inp.addEventListener('input', () => { S.frame = +inp.value; upd(); refreshMap(); });
  maxBtn.onclick = () => { stopPlay(); S.frame = S.frame < 0 ? n - 1 : -1; inp.value = S.frame < 0 ? n - 1 : S.frame; upd(); refreshMap(); };
  tb.append(play, h('div.tb-track', rainSvg, inp), label, maxBtn);
  tb._upd = upd; upd();
}
function togglePlay() {
  if (S.playing) { stopPlay(); return; }
  const d = S.dyn; if (!d) return;
  if (S.frame < 0 || S.frame >= d.frames.length - 1) S.frame = 0;
  S.playing = setInterval(() => {
    if (!S.dyn) return stopPlay();
    S.frame++;
    if (S.frame >= S.dyn.frames.length - 1) { S.frame = S.dyn.frames.length - 1; stopPlay(); }
    const inp = $('#timeSlider'); if (inp) inp.value = S.frame;
    $('#timebar')._upd && $('#timebar')._upd(); refreshMap();
  }, 140);
  $('#timebar .play').innerHTML = icon('pause', 16);
}
function stopPlay() { if (S.playing) { clearInterval(S.playing); S.playing = 0; } const b = $('#timebar .play'); if (b) b.innerHTML = icon('play', 16); }

// ------------------------------------------------------------------------------------------------ right panel
function renderRight() {
  const el = $('#rightPanel'); el.innerHTML = '';
  el.append(h('div.panel-head.row', h('div', h('div.eyebrow', 'Results'), h('h2#resTitle', 'Instant screening')), h('span.live#live', h('span.dot'), h('span#liveText', 'Live'))));
  el.append(h('div#resBody'));
  updateResults();
}

function tile(label, value, unit, cls = '', sub = '') {
  return h(`div.tile${cls}`, h('div.t-label', label), h('div.t-val', h('span.num', value), h('span.unit', unit)), sub ? h('div.t-sub', { html: sub }) : null);
}

function updateResults() {
  const body = $('#resBody'); if (!body) return;
  if (S.compare) { renderCompareResults(body); return; }
  if (!S.grid) {
    body.innerHTML = '';
    body.append(h('div.empty', h('div.empty-ic', { html: icon(S.site && S.site.kind === 'real' ? 'upload' : 'drop', 28) }), h('p', S.site && S.site.kind === 'real' ? 'Add terrain to start screening.' : 'Preparing site…')));
    return;
  }
  const dyn = S.source === 'dynamic' && S.dyn;
  $('#resTitle').textContent = dyn ? 'Dynamic simulation' : 'Instant screening';
  $('#liveText').textContent = dyn ? `${fmt1(S.dyn.mass.elapsedS)} s run` : `Live · ${Math.round(S.instMs)} ms`;
  $('#live').classList.toggle('dyn', !!dyn);
  const scrollTop = body.scrollTop;
  body.innerHTML = '';
  const cell2 = (g) => g.dx * g.dx;
  if (dyn) {
    const d = S.dyn; const g = d.grid; let maxD = 0, maxV = 0, a10 = 0, wet = 0;
    for (let k = 0; k < d.hMax.length; k++) {
      if (g.building[k] >= 0) continue; const hv = d.hMax[k];
      if (hv > maxD) maxD = hv; if (hv >= 0.03) { wet++; if (d.vMax[k] > maxV) maxV = d.vMax[k]; } if (hv > 0.1) a10++;
    }
    const area10 = a10 * cell2(g);
    body.append(h('div.tiles',
      tile('Water on site (end)', fmtVol(d.mass.storedM3), 'm³'),
      tile('Area > 10 cm', fmtInt(area10), 'm²', area10 > 0 ? '.hot' : '.good', targetText(area10)),
      tile('Max depth', Math.round(maxD * 100), 'cm'),
      tile('Max velocity', maxV.toFixed(2), 'm/s', '', `wet area ${fmtArea(wet * cell2(g))}`)));
    body.append(massCard(d.mass));
  } else if (S.instant) {
    const st = S.instant.stats;
    body.append(h('div.tiles',
      tile('Flooded volume', fmtVol(st.storedVolumeM3), 'm³', '', `in ${fmtArea(st.floodedAreaM2)} ponded`),
      tile('Area > 10 cm', fmtInt(st.areaOver10CmM2), 'm²', st.areaOver10CmM2 > 0 ? '.hot' : '.good', targetText(st.areaOver10CmM2)),
      tile('Max depth', Math.round(st.maxDepthM * 100), 'cm'),
      tile('Bluespots', fmtInt(st.bluespotCount), '', '', `<span class="spill-dot"></span>${fmtInt(st.spillingCount)} spilling`)));
    body.append(balanceCard(st));
  }
  if (S.instant) body.append(bluespotCard());
  body.append(retentionCard());
  body.append(optionsCard());
  updateRetentionCard();
  body.scrollTop = scrollTop;
}
function targetText(a) {
  return a > 0 ? `<span class="tgt bad" title="Copenhagen cloudburst target: max 10 cm water on terrain in a 100-year event">${icon('alert', 12)} Above Cph. 10 cm target</span>` : `<span class="tgt ok" title="Copenhagen cloudburst target: max 10 cm water on terrain in a 100-year event">${icon('check', 12)} Meets Cph. 10 cm target</span>`;
}

function stackBar(parts, total) {
  const bar = h('div.stack');
  for (const p of parts) if (p.v > 0) bar.append(h('div.seg', { style: { width: `${(p.v / total) * 100}%`, background: p.c }, title: `${p.l}: ${fmtVol(p.v)} m³` }));
  const leg = h('div.stack-leg');
  for (const p of parts) leg.append(h('div', h('span.sw', { style: { background: p.c } }), h('span', p.l), h('b', `${fmtVol(p.v)} m³`), h('span.muted', `${Math.round((p.v / total) * 100)} %`)));
  return [bar, leg];
}
function balanceCard(st) {
  const lost = Math.max(0, st.rainVolumeM3 - st.effectiveVolumeM3);
  return h('div.card2', h('div.c-head', h('h4', 'Where the rain goes'), h('span.muted', `${fmtVol(st.rainVolumeM3)} m³ rain`)),
    ...stackBar([
      { l: 'Sewer, infiltration, losses', v: lost, c: '#3b4b63' },
      { l: 'Ponds in bluespots', v: st.storedVolumeM3, c: '#1F78C8' },
      { l: 'Leaves the site', v: st.outflowVolumeM3, c: '#7cc4f2' },
    ], st.rainVolumeM3));
}
function massCard(m) {
  const total = m.rainM3 + (m.initialWaterM3 || 0);
  return h('div.card2', h('div.c-head', h('h4', 'Mass balance'), h('span.muted', `${fmtVol(m.rainM3)} m³ rain · error ${Math.abs(m.errorFraction) * 100 < 0.001 ? '< 0.001' : (Math.abs(m.errorFraction) * 100).toFixed(3)} %`)),
    ...stackBar([
      { l: 'Initial loss', v: m.initialLossM3, c: '#56657c' },
      { l: 'Infiltrated', v: m.infiltratedM3, c: '#5AAE61' },
      { l: 'Sewer', v: m.sewerM3, c: '#8b7fd6' },
      { l: 'Left boundary', v: m.boundaryOutM3, c: '#7cc4f2' },
      { l: 'On site at end', v: m.storedM3, c: '#1F78C8' },
    ], total));
}

function bluespotCard() {
  const top = topBluespots(S.instant, 8);
  const tbl = h('table.bs');
  tbl.append(h('thead', h('tr', h('th', '#'), h('th.r', 'Volume'), h('th.r', 'Depth'), h('th.r', 'Area'), h('th', ''))));
  const tb = h('tbody');
  top.forEach((b, i) => {
    const tr = h('tr', { onclick: () => zoomToBluespot(b, tr), title: 'Zoom to bluespot' },
      h('td', h('span.rank', String(i + 1))), h('td.r', `${fmtVol(b.volumeM3)} m³`), h('td.r', fmtCm(b.maxDepthM)), h('td.r', fmtArea(b.areaM2)),
      h('td', b.spills ? h('span.pill.spill', 'spills') : h('span.pill.fill', `${Math.round((b.volumeM3 / Math.max(1e-9, b.capacityM3)) * 100)} %`)));
    tb.append(tr);
  });
  tbl.append(tb);
  return h('div.card2', h('div.c-head', h('h4', 'Largest bluespots'), h('span.muted', 'click to zoom')), top.length ? tbl : h('p.muted', 'No bluespots above 1 m³.'));
}
function zoomToBluespot(b, tr) {
  $$('table.bs tr.sel').forEach((x) => x.classList.remove('sel')); tr && tr.classList.add('sel');
  if (S.view3d) toggle3D(false);
  const r = Math.sqrt(b.areaM2 / Math.PI);
  const k = clamp(Math.min(map.W, map.H) / (Math.max(r, 8) * 7), map.cam.k, 30);
  map.highlight = { x: b.x, y: b.y, r, t0: performance.now() + 450, scene: S.scene };
  map.flyTo({ cx: b.x, cy: b.y, k });
}

// ---------- retention
const computeRetentionDebounced = debounce(() => computeRetention(), 200);
async function computeRetention() {
  if (!S.grid) return;
  const grid = S.grid;
  try {
    const r = await S.cb.retention(grid, { returnPeriod: S.retention.returnPeriod, climateFactor: S.settings.climateFactor, dischargeLSHa: S.retention.dischargeLSHa, safetyFactor: 1.2 });
    if (grid !== S.grid) return;
    S.retention.result = r; updateRetentionCard();
  } catch (e) { console.warn('retention', e); }
}
function retentionCard() {
  const R = S.retention;
  const inp = h('input.num', { type: 'number', min: 0.1, max: 50, step: 0.1, value: R.dischargeLSHa });
  inp.addEventListener('input', () => { const v = +inp.value; if (v > 0) { R.dischargeLSHa = v; computeRetentionDebounced(); } });
  return h('div.card2.retention', h('div.c-head', h('h4', 'Retention volume'), h('span.chip.tiny', 'indicative')),
    h('div.ret-in',
      h('label', 'Allowed discharge', h('div.inwrap', inp, h('span', 'l/s/ha'))),
      h('label', 'Return period', segControl([5, 10, 20].map((v) => ({ v, html: `T${v}` })), R.returnPeriod, (v) => { R.returnPeriod = v; computeRetention(); }, 'rp'))),
    h('div.ret-out#retOut'));
}
function updateRetentionCard() {
  const el = $('#retOut'); const r = S.retention.result; if (!el || !r) return;
  el.innerHTML = '';
  el.append(h('div.big', h('span.num', fmtInt(r.requiredStorageM3)), h('span.unit', 'm³')),
    h('div.ret-sub', 'required storage (box rain method, safety factor 1.2)'),
    h('div.kv', h('span', 'Reduced area'), h('b', `${fmtArea(r.reducedAreaM2)}  (C ${r.meanC.toFixed(2)})`)),
    h('div.kv', h('span', 'Outflow'), h('b', `${fmt1(r.outflowLS)} l/s`)),
    h('div.kv', h('span', 'Critical duration'), h('b', r.criticalDurationMin >= 120 ? `${fmt1(r.criticalDurationMin / 60)} h` : `${fmtInt(r.criticalDurationMin)} min`)));
}

// ------------------------------------------------------------------------------------------------ options & compare
function optionsCard() {
  const card = h('div.card2', h('div.c-head', h('h4', 'Options & compare'), h('span.muted', `${S.options.length} saved`)));
  const pair = S.site && S.site.info.compareWith && sampleInfo(S.site.info.compareWith);
  if (pair) {
    const nm = shortName(pair.name);
    card.append(h('button.btn.accent.wide#pairBtn', { onclick: comparePair, html: `${icon('compare', 15)} Compare with ‘${nm}’` }));
  }
  const list = h('div.opts');
  S.options.forEach((o, i) => list.append(h('div.opt', h('span.opt-letter', String.fromCharCode(65 + i)), h('div.opt-txt', h('b', o.name), h('span', o.caption)),
    h('button.icon-btn', { title: 'Remove', html: icon('x', 14), onclick: () => { S.options.splice(i, 1); updateResults(); } }))));
  card.append(list);
  card.append(h('div.row-btns',
    h('button.btn.ghost', { onclick: saveOption, disabled: !S.instant, html: `${icon('save', 14)} Save as option` }),
    h('button.btn.ghost', { onclick: () => enterCompare(S.options[S.options.length - 2], S.options[S.options.length - 1], 'swipe'), disabled: S.options.length < 2, html: `${icon('compare', 14)} Compare last two` })));
  return card;
}
function shortName(name) { const m = /[–-]\s*(.+)$/.exec(name); return (m ? m[1] : name).replace(/\s*\(.*\)/, '').trim(); }

function snapshot(name, grid, sampleJson, inst, base) {
  return {
    id: Math.random().toString(36).slice(2), name, short: shortName(name), caption: captionText(),
    grid, base: base || baseCanvas(grid, S.info.palette), buildingsVec: sampleJson ? sampleJson.buildings : null,
    buildingsRaster: sampleJson ? null : buildingsCanvas(grid), depth: inst.depth, stats: inst.stats, bluespots: inst.bluespots, paths: inst.paths,
  };
}
function saveOption() {
  if (!S.instant) return;
  const letter = String.fromCharCode(65 + S.options.length);
  const p = preset();
  S.options.push(snapshot(`${S.site.name} – ${letter}: ${p.name.replace(' (cloudburst)', '')}, ${SEWER[S.settings.sewerMode].label.toLowerCase()}`, S.grid, S.sampleJson, S.instant, S.scene.base));
  toast(`Saved option ${letter}. Change a setting and save another to compare.`, 'ok');
  updateResults();
}

async function comparePair() {
  const other = sampleInfo(S.site.info.compareWith); if (!other || !S.instant) return;
  const btn = $('#pairBtn'); if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Running both options…'; }
  try {
    const cur = snapshot(S.site.info.name, S.grid, S.sampleJson, S.instant, S.scene.base);
    const g2 = await S.cb.buildGrid({ sample: other.id }, { cellSize: S.grid.dx });
    const sj2 = await S.cb.sample(other.id);
    const r2 = await S.cb.runInstant(g2, scenarioInstant());
    S.cb.freeGrid(g2);
    const oth = snapshot(other.name, g2, sj2, r2);
    const beforeFirst = /before/.test(S.site.id) || !/before/.test(other.id);
    const [a, b] = beforeFirst ? [cur, oth] : [oth, cur];
    S.options = S.options.filter((o) => o.name !== a.name && o.name !== b.name).concat([a, b]);
    enterCompare(a, b, 'diff');
  } catch (e) { console.error(e); toast(`Compare failed: ${e.message}`, 'error'); updateResults(); }
}

function enterCompare(a, b, mode = 'swipe') {
  if (!a || !b) return;
  if (S.view3d) toggle3D(false);
  stopPlay();
  S.compare = { a, b, mode };
  renderLeft(); renderMapChrome(); refreshMap(); updateResults(); renderCaption();
  map.fit(true);
}
function exitCompare() {
  S.compare = null; map.highlight = null;
  renderLeft(); renderMapChrome(); refreshMap(); updateResults(); renderCaption();
}
function sceneFromOption(o, tag) {
  const sc = { grid: o.grid, base: o.base, buildingsVec: o.buildingsVec, buildingsRaster: o.buildingsRaster, overlay: overlayCanvas(o.grid, o.depth, DEPTH), tag, paths: null };
  return sc;
}
function renderCompareScenes() {
  const { a, b, mode } = S.compare;
  if (mode === 'diff') {
    if (!S.compare.diff) S.compare.diff = differenceArray(a.grid, a.depth, b.grid, b.depth);
    // draw B's buildings/base (the proposal) with the change overlaid
    const sc = { grid: b.grid, base: b.base, buildingsVec: b.buildingsVec, buildingsRaster: b.buildingsRaster, overlay: overlayCanvas(a.grid, S.compare.diff, DIFF, { alpha: 240 }), overlayGrid: a.grid };
    map.setScenes([sc]);
  } else {
    map.setScenes([sceneFromOption(a, `A · ${a.short}`), sceneFromOption(b, `B · ${b.short}`)], 'swipe');
  }
}
function renderCompareResults(body) {
  const { a, b } = S.compare; body.innerHTML = '';
  $('#resTitle').textContent = 'Compare options'; $('#liveText').textContent = 'B − A';
  const rows = [
    ['Flooded volume', a.stats.storedVolumeM3, b.stats.storedVolumeM3, (v) => `${fmtVol(v)} m³`, true],
    ['Area > 10 cm', a.stats.areaOver10CmM2, b.stats.areaOver10CmM2, (v) => `${fmtInt(v)} m²`, true],
    ['Flooded area', a.stats.floodedAreaM2, b.stats.floodedAreaM2, (v) => fmtArea(v), true],
    ['Max depth', a.stats.maxDepthM, b.stats.maxDepthM, (v) => fmtCm(v), true],
    ['Leaves the site', a.stats.outflowVolumeM3, b.stats.outflowVolumeM3, (v) => `${fmtVol(v)} m³`, true],
    ['Bluespots', a.stats.bluespotCount, b.stats.bluespotCount, (v) => fmtInt(v), false],
  ];
  const dv = b.stats.storedVolumeM3 - a.stats.storedVolumeM3, da = b.stats.areaOver10CmM2 - a.stats.areaOver10CmM2;
  const pct = (x, y) => (x > 0 ? Math.round(((y - x) / x) * 100) : 0);
  body.append(h('div.tiles',
    h(`div.tile${dv <= 0 ? '.good' : '.hot'}`, h('div.t-label', 'Δ Flooded volume'), h('div.t-val', h('span.num', `${dv > 0 ? '+' : '−'}${fmtVol(Math.abs(dv))}`), h('span.unit', 'm³')), h('div.t-sub', `${pct(a.stats.storedVolumeM3, b.stats.storedVolumeM3)} % vs A`)),
    h(`div.tile${da <= 0 ? '.good' : '.hot'}`, h('div.t-label', 'Δ Area > 10 cm'), h('div.t-val', h('span.num', `${da > 0 ? '+' : '−'}${fmtInt(Math.abs(da))}`), h('span.unit', 'm²')), h('div.t-sub', `${pct(a.stats.areaOver10CmM2, b.stats.areaOver10CmM2)} % vs A`))));
  const tbl = h('table.cmp', h('thead', h('tr', h('th', ''), h('th.r', h('span.opt-letter.sm', 'A')), h('th.r', h('span.opt-letter.sm.b', 'B')), h('th.r', 'Δ'))));
  const tb = h('tbody');
  for (const [l, x, y, f, lowerBetter] of rows) {
    const d = y - x; const cls = Math.abs(d) < 1e-6 ? '' : (d < 0) === lowerBetter ? 'down' : 'up';
    tb.append(h('tr', h('td', l), h('td.r', f(x)), h('td.r', f(y)), h(`td.r.${cls || 'eq'}`, Math.abs(d) < 1e-6 ? '–' : `${d > 0 ? '+' : '−'}${f(Math.abs(d))}`)));
  }
  tbl.append(tb);
  body.append(h('div.card2', h('div.c-head', h('h4', 'A vs B')),
    h('div.cmp-names', h('div', h('span.opt-letter.sm', 'A'), h('span', a.name)), h('div', h('span.opt-letter.sm.b', 'B'), h('span', b.name))), tbl));
  body.append(h('div.row-btns',
    h('button.btn.ghost', { onclick: () => { S.compare = { a: b, b: a, mode: S.compare.mode }; refreshMap(); updateResults(); renderCaption(); }, html: `${icon('swipe', 14)} Swap A/B` }),
    h('button.btn.primary', { onclick: exitCompare, html: `${icon('x', 14)} Exit compare` })));
}

// ------------------------------------------------------------------------------------------------ 3D
async function toggle3D(on) {
  if (on === S.view3d) return;
  if (on) {
    if (!S.grid) return;
    try {
      setBusy(true, 'Loading 3D…');
      const { load3D, View3D } = await import('./js/view3d.js');
      await load3D();
      if (!S.v3) S.v3 = new View3D($('#view3d'));
      S.view3d = true;
      $('#view3d').classList.remove('hidden'); $('#map').classList.add('hidden-soft');
      S.v3.setSite(S.grid, S.scene.base, S.scene.buildingsVec);
      S.v3.start();
      refreshMap();
    } catch (e) {
      console.warn('3D unavailable', e); toast('3D view needs three.js from the CDN, which is unavailable. The 2D view still works.', 'error');
      S.view3d = false;
    } finally { setBusy(false); }
  } else {
    S.view3d = false; if (S.v3) S.v3.stop();
    $('#view3d').classList.add('hidden'); $('#map').classList.remove('hidden-soft');
  }
  renderMapChrome();
}

// ------------------------------------------------------------------------------------------------ export
function legendItems() {
  if (S.compare) return S.compare.mode === 'diff' ? { title: DIFF.title, ramp: DIFF } : { title: 'Water depth (cm)', ramp: DEPTH };
  if (S.layer === 'materials') return { title: 'Surface materials', mats: materialsPresent(S.grid, S.info.palette) };
  const r = LAYERS[S.layer].ramp; return { title: `${$('#legend .lg-title')?.firstChild?.textContent || r.title} (${r.unit})`, ramp: r };
}
function exportPNG() {
  if (!S.grid) return;
  if (S.view3d && S.v3) {
    S.v3.renderer.render(S.v3.scene, S.v3.camera);
    S.v3.renderer.domElement.toBlob((b) => download(`cloudburst-${S.site.id}-3d.png`, b));
    return;
  }
  const mapC = map.renderExport(2000);
  const W = mapC.width, head = 96, foot = 150; const c = document.createElement('canvas'); c.width = W; c.height = mapC.height + head + foot;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#0b1320'; ctx.fillRect(0, 0, W, c.height);
  ctx.drawImage(mapC, 0, head);
  ctx.fillStyle = '#e8f1fb'; ctx.font = '700 34px Inter, system-ui, sans-serif'; ctx.fillText(`${S.site.name}`, 40, 56);
  ctx.fillStyle = '#8fa6c2'; ctx.font = '500 20px Inter, system-ui, sans-serif';
  const L = legendItems(); ctx.fillText(L.title, 40, 84);
  let x = 40; const y = head + mapC.height + 36;
  ctx.font = '600 18px Inter, system-ui, sans-serif';
  const items = L.ramp ? L.ramp.colors.map((col, i) => [col, L.ramp.labels[i]]) : L.mats.map((m) => [m.color, m.name]);
  for (const [col, lab] of items) {
    const tw = ctx.measureText(lab).width;
    if (x + tw + 60 > W) break;
    ctx.fillStyle = col; roundRect(ctx, x, y - 16, 26, 20, 4); ctx.fill();
    ctx.fillStyle = '#dbe7f5'; ctx.fillText(lab, x + 34, y); x += tw + 66;
  }
  ctx.font = '500 18px Inter, system-ui, sans-serif'; ctx.fillStyle = '#8fa6c2';
  ctx.fillText(S.compare ? `A = ${S.compare.a.name}  ·  B = ${S.compare.b.name}` : captionText(), 40, y + 46);
  ctx.font = '800 18px Inter, system-ui, sans-serif'; ctx.fillStyle = '#f6a04d'; ctx.fillText('SCREENING MODEL – not for compliance', 40, y + 80);
  ctx.textAlign = 'right'; ctx.fillStyle = '#5d7391'; ctx.font = '500 16px Inter, system-ui, sans-serif';
  ctx.fillText(`Cloudburst ${S.info.version} · ${new Date().toISOString().slice(0, 10)}`, W - 40, y + 80);
  c.toBlob((b) => download(`cloudburst-${S.site.id}-${S.compare ? 'compare' : S.layer}.png`, b));
}
function exportJSON() {
  if (!S.grid) return;
  const round = (o) => JSON.parse(JSON.stringify(o, (k, v) => (typeof v === 'number' ? Math.round(v * 1000) / 1000 : v)));
  const out = {
    tool: 'Cloudburst web', engine: S.info.version, generated: new Date().toISOString(), disclaimer: 'SCREENING MODEL – not for compliance',
    site: { id: S.site.id, name: S.site.name, kind: S.site.kind, bbox: S.site.info.bbox || null, grid: { nx: S.grid.nx, ny: S.grid.ny, x0: S.grid.x0, y0: S.grid.y0, cellSize: S.grid.dx } },
    scenario: { ...S.settings, rainPreset: preset().name, designDepthMm: S.settings.rainDepthMm * S.settings.climateFactor, sewer: SEWER[S.settings.sewerMode].long, moisture: MOIST[S.settings.moisture].label, caption: captionText() },
    instant: S.instant ? { stats: S.instant.stats, bluespots: [...S.instant.bluespots].sort((a, b) => b.volumeM3 - a.volumeM3).filter((b) => b.volumeM3 >= 0.1) } : null,
    dynamic: S.dyn ? { cellSize: S.dyn.grid.dx, mass: S.dyn.mass, frames: S.dyn.frames.length, simulatedMin: S.dyn.totalMin } : null,
    retention: S.retention.result ? { input: { dischargeLSHa: S.retention.dischargeLSHa, returnPeriod: S.retention.returnPeriod, safetyFactor: 1.2 }, ...S.retention.result } : null,
    options: S.options.map((o) => ({ name: o.name, caption: o.caption, stats: o.stats })),
  };
  download(`cloudburst-${S.site.id}-results.json`, JSON.stringify(round(out), null, 2));
}

// ------------------------------------------------------------------------------------------------ misc
function setBusy(on, text = 'Computing…') {
  const b = $('#mapBusy'); b.classList.toggle('show', on); b.querySelector('span').textContent = text;
}
function pulseLive() { const l = $('#live'); if (!l) return; l.classList.remove('pulse'); void l.offsetWidth; l.classList.add('pulse'); }

// debug / test hooks
window.__cb = S;

// installable app (PWA): register the service worker when served over http(s)
if ('serviceWorker' in navigator && location.protocol.startsWith('http') && !window.__TAURI__) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
