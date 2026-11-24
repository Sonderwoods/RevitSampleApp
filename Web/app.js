// Cloudburst web front-end. Static ES modules, no build step.
// Engine: Rust core compiled to WebAssembly (engine/), the same code as the Revit/Rhino plug-in DLL.
import { CloudburstClient } from './engine/engine-client.js';
import { h, $, $$, clamp, debounce, fmtInt, fmt1, fmtVol, fmtArea, fmtCm, fmtClock, fmtDuration, utm32ToLatLon, fmtLatLon, download, toast, icon } from './js/util.js';
import { DEPTH, VELOCITY, HAZARD, TPEAK, INFIL, DIFF, LAYERS } from './js/colors.js';
import { baseCanvas, buildingsCanvas, overlayCanvas, materialCanvas, materialsPresent, sampleAt, cellAt, differenceArray } from './js/raster.js';
import { MapView, roundRect } from './js/mapview.js';
import { openDhmPicker } from './js/dhm.js';
import { addSiteSource, addExportAction, siteSources, exportActions, hooks } from './js/hooks.js';
import { help, term, TERMS, installTips } from './js/terms.js';
import { reportOptionMeta } from './js/report.js'; // [report-hook] registers the PDF report export action (see js/report.js)
import { prepareSiteDesc, terrainMeta, fetchOsmContext, attachContext, contextOf } from './js/sources/registry.js'; // [map-sources hook] terrain decode/reproject/aggregate, metadata, OSM context
import './js/sources/ui.js'; // [map-sources hook] registers the extra terrain sources through js/hooks.js

// ------------------------------------------------------------------------------------------------ constants
const LOCATIONS = {
  dk_taasinge: 'Copenhagen · Østerbro',
  dk_skt_kjeld: 'Copenhagen · Østerbro',
  dk_enghaveparken: 'Copenhagen · Vesterbro',
  dk_kongens_nytorv: 'Copenhagen · Indre By',
  dk_odense: 'Odense · Munke Mose',
};
const SEWER = [
  { v: 0, label: 'No sewer', sub: 'all runs off', long: 'No sewer' },
  { v: 1, label: 'Combined', sub: 'takes 34 mm', long: 'Combined sewer (34 mm)' },
  { v: 2, label: 'Separate', sub: 'takes 29 mm', long: 'Separate sewer (29 mm)' },
];
// Plain names first, the technical term second.
const PRESET_LABEL = {
  t10: { name: 'Heavy rain', sub: '10-year storm (T = 10), 4 h' },
  t100: { name: 'Cloudburst', sub: '100-year storm (T = 100), 4 h' },
  test2011: { name: 'Copenhagen, 2 July 2011', sub: 'the real storm, 2 h' },
  box83: { name: 'Steady rain', sub: 'even intensity (box rain), 4 h' },
};
const presetName = (p) => (PRESET_LABEL[p.id] ? PRESET_LABEL[p.id].name : p.name);
const MOIST = [{ v: 0, label: 'Dry' }, { v: 1, label: 'Normal', long: 'Moist' }, { v: 2, label: 'Wet' }];
const DURATIONS = [
  { id: 'full30', label: 'Storm + 30 min', after: 30 },
  { id: 'full', label: 'Storm only', after: 0 },
  { id: 'first60', label: 'First hour', after: 0, cut: 60 },
];
const LS_HINT = 'cb.firstRunHint.dismissed';
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode: fine */ } },
};
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
  retention: { dischargeLSHa: 1, returnPeriod: 10, result: null, open: false },
  legendCollapsed: typeof window !== 'undefined' && window.innerHeight < 760,
  view3d: false, v3: null,
  thumbs: new Map(),
  surfaceSwap: {},          // original material id -> replacement id (design change on the sample's surface regions)
  groundMaterial: null,     // palette id for cells no region covers (null = engine default)
  speedK: 1,                // learned ratio actual/estimated run time, so the next estimate is honest
};
let map = null;

// ------------------------------------------------------------------------------------------------ boot
boot().catch((e) => { console.error(e); $('#engineChip').innerHTML = '<span class="dot err"></span>Engine failed to load'; toast(`Engine failed: ${e.message}`, 'error'); });

async function boot() {
  S.cb = await CloudburstClient.create();
  S.info = S.cb.info;
  $('#engineChip').innerHTML = `<span class="dot ok"></span>Engine ${S.info.version} · WebAssembly`;
  $('#brand').onclick = () => { location.hash = '#/'; };
  $('#startExample').onclick = () => { location.hash = '#/site/demo_block'; };
  registerBuiltIns(); installTips();
  hooks.addEventListener('change', () => { renderSources(); if (S.grid) renderLeft(); });
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
  if (s.kind === 'custom') return h('span.badge.real', 'Your terrain');
  if (s.kind === 'real') return h('span.badge.real', 'Real site · needs terrain');
  if (s.compareWith) return h('span.badge.pair', 'Before / after pair');
  if (s.id === 'demo_block') return h('span.badge.start', 'Start here');
  return h('span.badge.synth', 'Example');
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
      meta = h('div.card-meta', h('span.meta-item', { html: `${icon('drop', 13)} ${presetName(p)} rain` }));
    }
    const card = h('button.card', { onclick: () => { location.hash = `#/site/${s.id}`; }, dataset: { id: s.id } },
      thumb, badgeFor(s),
      h('div.card-body', h('h3', s.name.replace(' (real)', '')), h('p', s.description), meta));
    (s.kind === 'real' ? real : syn).append(card);
    if (s.kind === 'real') drawRealThumb(thumb, s);
  }
  renderSources();
}

// Built-in site sources and export actions, registered through the same hooks other modules use (js/hooks.js).
function registerBuiltIns() {
  addSiteSource({
    id: 'dhm', order: 10, icon: 'pin', title: 'Find a place in Denmark', tag: 'Needs a free API key',
    description: 'Search an address, place a square on the map, and the official terrain (DHM) is downloaded for you.',
    open: (ctx) => openDhmPicker(ctx.openTerrain),
  });
  addSiteSource({
    id: 'file', order: 20, icon: 'upload', title: 'Upload a terrain file', tag: '.tif  .tiff  .asc  .xyz',
    description: 'Drop a GeoTIFF, ESRI ASCII grid or XYZ point file (heights in metres) anywhere on this page, or click to choose one.',
    open: () => $('#fileInput').click(),
  });
  addExportAction({ id: 'png', order: 10, icon: 'image', label: 'Map image (PNG)', description: 'The current map with legend and assumptions, for slides and sketches.', run: exportPNG, enabled: () => (S.grid ? true : 'Load a site first') });
  addExportAction({ id: 'json', order: 20, icon: 'json', label: 'Results data (JSON)', description: 'All numbers, settings and saved options, for engineers and spreadsheets.', run: exportJSON, enabled: () => (S.grid ? true : 'Load a site first') });
}

/** Context handed to hook entries (site sources, export actions). */
function appContext() {
  return {
    state: S, site: S.site, grid: S.grid, instant: S.instant, dynamic: S.dyn, compare: S.compare, options: S.options, settings: S.settings,
    captionText, legend: legendItems, map, engine: S.cb, toast, openTerrain: openFetchedTerrain,
  };
}

function renderSources() {
  const wrap = $('#cardsSources'); if (!wrap) return; wrap.innerHTML = '';
  for (const src of siteSources()) {
    wrap.append(h('button.card.custom-card.source-card', { dataset: { source: src.id }, onclick: () => src.open(appContext()) },
      h('div.custom-inner',
        h('div.custom-icon', { html: icon(src.icon || 'file', 26) }),
        h('h3', src.title),
        h('p', src.description),
        src.tag ? h('div.card-meta', h('span.meta-item', src.tag)) : null)));
  }
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
  $('#crumbs').append(...[h('a', { href: '#/', html: `${icon('back', 14)} All sites` }), h('span.sep', '/'), h('span.cur', S.site.name), S.site.kind === 'synthetic' ? null : h('span.badge.real', S.site.kind === 'custom' ? 'Your terrain' : 'Real site')].filter(Boolean));
  ensureMap();
  renderLeft(); renderRight(); renderMapChrome();
  if (S.site.kind === 'synthetic') {
    S.sampleJson = await S.cb.sample(id);
    S.siteDesc = siteDescription();
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
  Object.assign(S, { site: null, siteDesc: null, sampleJson: null, grid: null, scene: null, instant: null, dyn: null, frame: -1, source: 'instant', compare: null, options: [], layer: 'depth', matCanvas: null, surfaceSwap: {}, groundMaterial: null });
  S.retention.result = null;
  if (map) map.setScenes([]);
  $('#siteDrop').classList.add('hidden');
}

function ensureMap() {
  if (map) return;
  map = new MapView($('#map'), { onHover, onLeave: () => $('#tooltip').classList.add('hidden') });
  window.__map = map;
}

/** The engine's site description: the sample (or terrain bytes) plus the user's surface swaps. */
function siteDescription() {
  if (S.site.kind === 'synthetic') {
    // Extra regions are painted after the sample's own (later regions win), so re-send every region from the first
    // swapped one onwards in the original order: otherwise a swapped region would also cover regions drawn on top of it.
    const regs = (S.sampleJson && S.sampleJson.surfaces) || [];
    const first = regs.findIndex((r) => S.surfaceSwap[r.material]);
    const surfaces = first < 0 ? [] : regs.slice(first).map((r) => (S.surfaceSwap[r.material] ? { ...r, material: S.surfaceSwap[r.material] } : r));
    return surfaces.length ? { sample: S.site.id, surfaces } : { sample: S.site.id };
  }
  // imported terrain: surfaces come from OpenStreetMap (if added); a swap replaces the whole list (later regions win)
  const base = S.site.baseSurfaces || [];
  if (base.some((r) => S.surfaceSwap[r.material])) return { terrainBytes: S.siteDesc.terrainBytes, surfaces: base.map((r) => (S.surfaceSwap[r.material] ? { ...r, material: S.surfaceSwap[r.material] } : r)) };
  return { terrainBytes: S.siteDesc.terrainBytes };
}
/** Where the terrain came from (source, resolution, CRS, suitability, attribution, OSM); null for built-in examples. */
function terrainInfo() { return S.site && S.site.kind !== 'synthetic' ? terrainMeta(S.site.info, S.siteDesc && S.siteDesc.prepared) : null; }
/** Rebuild the grid from the original terrain bytes (after a new aggregation method or added OSM context). */
async function reprocessTerrain() {
  if (!S.site || !S.site.rawTerrain) return;
  if (S.dynRun) { S.dynRun.cancel(); S.dynRun = null; }
  Object.assign(S, { dyn: null, source: 'instant', frame: -1, surfaceSwap: {}, matCanvas: null });
  S.site.baseSurfaces = null;
  S.siteDesc = { terrainBytes: S.site.rawTerrain };
  await loadGrid({ refit: false });
}
function setTerrainMethod(method) {
  const opts = { ...((S.site.info && S.site.info.terrainOptions) || {}), method };
  S.site.info = { ...S.site.info, terrainOptions: opts };
  const c = contextOf(S.site.rawTerrain); if (c && c.info) c.info.terrainOptions = opts; // fetched terrain carries its own info
  reprocessTerrain();
}
async function addOsmContext(btn) {
  const p = S.siteDesc && S.siteDesc.prepared; if (!p || !p.grid || !p.crs || !S.site.rawTerrain) return;
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Fetching OpenStreetMap…'; }
  try {
    const g = p.grid;
    const osm = await fetchOsmContext({ bbox: [g.x0, g.y0, g.x0 + g.nx * g.d, g.y0 + g.ny * g.d], epsg: p.crs.epsg });
    attachContext(S.site.rawTerrain, { osm });
    await reprocessTerrain();
    toast(`Added ${osm.stats.buildings} buildings and ${osm.stats.surfaces} surface areas from OpenStreetMap (© OpenStreetMap contributors).`, 'ok');
  } catch (e) {
    console.error(e); toast(`Could not load OpenStreetMap data: ${e.message}`, 'error');
    if (btn) { btn.disabled = false; btn.textContent = 'Add from OpenStreetMap'; }
  }
}
function gridSettings(cellSize) {
  const st = { cellSize };
  if (S.groundMaterial) st.defaultMaterial = S.info.palette.materials.findIndex((m) => m.id === S.groundMaterial);
  return st;
}
/** Rebuild the grid after a design change (surfaces), keeping the view and cell size. */
async function applyDesignChange() {
  if (!S.grid) return;
  S.siteDesc = siteDescription(); S.matCanvas = null;
  await loadGrid({ refit: false, cellSizes: [S.grid.dx] });
  renderLeft(); updateDynStale();
}

async function loadGrid({ refit = true, cellSizes = null } = {}) {
  setBusy(true, 'Building grid…');
  let grid = null, lastErr = null;
  const site = S.site; const old = S.grid;
  // [map-sources hook] begin – see js/sources/registry.js prepareSiteDesc and docs/map-sources.md
  if (S.siteDesc && S.siteDesc.terrainBytes && !S.siteDesc.prepared) {
    if (!S.site.rawTerrain) S.site.rawTerrain = S.siteDesc.terrainBytes; // original file / download, for re-aggregation and OSM
    try { S.siteDesc = await prepareSiteDesc(S.siteDesc, S.site.info); } catch (e) { lastErr = e; S.siteDesc = { ...S.siteDesc, prepared: { failed: true, warnings: [`${e.message} – trying the engine's own reader.`] } }; }
    if (S.site !== site) return;
    if (!cellSizes) for (const w of (S.siteDesc.prepared && S.siteDesc.prepared.warnings) || []) toast(w);
    if (S.site.baseSurfaces == null) S.site.baseSurfaces = S.siteDesc.surfaces || [];
  }
  const preparedCell = S.siteDesc && S.siteDesc.prepared && S.siteDesc.prepared.cellSize;
  // [map-sources hook] end
  for (const cellSize of cellSizes || (S.site.kind === 'synthetic' ? [1] : preparedCell ? [preparedCell] : [1, 2, 4, 8])) {
    try {
      grid = await S.cb.buildGrid(S.siteDesc, gridSettings(cellSize));
      if (grid.nx * grid.ny > 900000 && cellSize < 8) { S.cb.freeGrid(grid); grid = null; continue; }
      break;
    } catch (e) { lastErr = e; }
  }
  if (S.site !== site) { if (grid) S.cb.freeGrid(grid); return; }
  if (!grid) {
    setBusy(false);
    toast(`Could not read this terrain file (${lastErr ? lastErr.message : 'unknown error'}). Use a GeoTIFF or ESRI ASCII elevation file in metres.`, 'error');
    if (!old) showSiteDrop(); return;
  }
  if (old) S.cb.freeGrid(old).catch(() => {});
  S.grid = grid;
  $('#siteDrop').classList.add('hidden');
  const base = baseCanvas(grid, S.info.palette);
  const vecB = S.sampleJson ? S.sampleJson.buildings : (S.siteDesc.buildings && S.siteDesc.buildings.length ? S.siteDesc.buildings : null); // [map-sources hook] OSM footprints
  S.scene = { grid, base, buildingsVec: vecB, buildingsRaster: vecB ? null : buildingsCanvas(grid) };
  map.setScenes([S.scene]); if (refit) map.fit();
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
  card.append(h('div.eyebrow', isReal ? 'Real site · one more step' : 'Terrain needed'), h('h2', S.site.name), h('p.muted', s.description),
    h('p', 'This site needs its terrain: the ground heights the water runs over. Choose one:'));
  if (isReal) {
    const [x0, y0, x1, y1] = s.bbox; const ll = utm32ToLatLon((x0 + x1) / 2, (y0 + y1) / 2);
    card.append(h('div.choice',
      h('span.choice-n', '1'),
      h('div.choice-body',
        h('b', 'Download it from the Danish elevation model'),
        h('span.muted', { html: 'Needs a free API key from <a href="https://portal.datafordeler.dk/hjem" target="_blank" rel="noopener">Datafordeler</a> (log in with MitID or e-mail). The download takes a few seconds.' }),
        h('button.btn.primary.fetch-dhm', {
          html: `${icon('download', 15)} Download terrain…`,
          onclick: () => openDhmPicker(async ({ bytes }) => { S.siteDesc = { terrainBytes: bytes }; await loadGrid(); },
            { lat: ll.lat, lon: ll.lon, size: Math.round(x1 - x0), name: S.site.name }),
        }))));
  }
  const dz = h('div.dropzone', { tabIndex: 0, role: 'button', onclick: () => $('#fileInput').click(), onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('#fileInput').click(); } } },
    h('div.dz-icon', { html: icon('upload', 28) }),
    h('div.dz-title', 'Drop a terrain file here'),
    h('div.dz-sub', 'or click to choose · GeoTIFF (.tif), ESRI ASCII (.asc) or XYZ points (.xyz), heights in metres'),
    s.dhmFile ? h('div.dz-file', { html: `${icon('file', 14)} expected file: <span class="mono">${s.dhmFile}</span>` }) : null);
  card.append(h('div.choice', h('span.choice-n', isReal ? '2' : '1'), h('div.choice-body', h('b', 'Use a terrain file you already have'), dz)));
  card.append(h('p.muted.small', h('span', 'No key and no file? '), h('a', { href: '#/site/demo_block' }, 'Open an example site instead'), '.'));
  if (isReal) {
    const r = realMeta(s);
    card.append(h('details.advanced', h('summary', 'Location details'),
      h('div.loc-grid',
        h('div', h('label', 'Location'), h('b', { html: `${icon('pin', 14)} ${r.loc}` })),
        h('div', h('label', 'WGS84'), h('b.mono', fmtLatLon(r.ll))),
        h('div', h('label', 'Extent (EPSG:25832)'), h('b.mono', `${s.bbox[0]}, ${s.bbox[1]} → ${s.bbox[2]}, ${s.bbox[3]}`)),
        h('div', h('label', 'Size'), h('b', `${r.w} × ${r.hgt} m`))),
      s.dhmFile ? h('div.hint', { html: `${icon('terminal', 14)} <span>For developers: <code>tools/fetch_dhm.py</code> downloads this file; files placed in <code>Web/data/</code> load automatically.</span>` }) : null));
  }
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
  if (!/\.(tif|tiff|asc|txt|xyz|csv)$/i.test(file.name)) /* [map-sources hook] +xyz */ { toast(`“${file.name}” is not a terrain file. Use a GeoTIFF (.tif), ESRI ASCII (.asc) or XYZ (.xyz) elevation file.`, 'error'); return; }
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (S.site && S.site.kind === 'real' && !S.grid) {
    S.site.info = { ...S.site.info, fileName: file.name };
    S.siteDesc = { terrainBytes: bytes };
    toast(`Reading ${file.name}…`);
    await loadGrid();
    return;
  }
  const info = { id: 'custom', name: file.name.replace(/\.[^.]+$/, ''), description: `Uploaded terrain: ${file.name} (${fmt1(file.size / 1e6)} MB)`, kind: 'custom', rainPreset: 1, bbox: null, dhmFile: null, compareWith: null, fileName: file.name };
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
    const first = !S.instant;
    S.instant = r; S.instMs = performance.now() - t0;
    refreshMap(); updateResults(); renderCaption(); updateQuickStatus(); showFirstRunHint();
    if (first && !S.compare) renderLeft(); // enables Save option / Compare pair
    pulseLive();
  } catch (e) { console.error(e); toast(`The quick check failed: ${e.message}. Try another rain or reload the site.`, 'error'); }
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
    if (L === 'infil') {
      if (!d.infilMm) { d.infilMm = new Float32Array(d.infiltrated.length); for (let k = 0; k < d.infiltrated.length; k++) d.infilMm[k] = d.infiltrated[k] * 1000; }
      return { grid: g, overlay: overlayCanvas(g, d.infilMm, INFIL), depth: hM, min: 0.03 };
    }
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
    seg.append(h('span.seg-label', 'Show'));
    for (const [id, label, ic, tip] of [['diff', 'What changed', 'diff', 'One map: green where B is drier, red where B is wetter'], ['swipe', 'Side by side', 'swipe', 'A on the left, B on the right; drag the divider']]) {
      seg.append(h(`button.seg-btn${S.compare.mode === id ? '.on' : ''}`, { 'aria-pressed': String(S.compare.mode === id), dataset: { tip }, html: `${icon(ic, 14)} ${label}`, onclick: () => { S.compare.mode = id; renderMapChrome(); refreshMap(); renderLeft(); } }));
    }
  } else {
    const src = h('div.subseg', { role: 'group', 'aria-label': 'Which model' });
    for (const [id, label, tip] of [['instant', 'Quick check', TERMS.instant], ['dynamic', 'Simulation', S.dyn ? TERMS.dynamic : 'Run the full simulation first (step 4, Run)']]) {
      const dis = id === 'dynamic' && !S.dyn;
      src.append(h(`button.seg-btn.src${S.source === id ? '.on' : ''}${dis ? '.dis' : ''}`, {
        'aria-pressed': String(S.source === id), 'aria-disabled': dis ? 'true' : null, dataset: { tip }, html: `${icon(id === 'instant' ? 'bolt' : 'wave', 14)} ${label}`,
        onclick: () => { if (dis) { toast('Run the full simulation first: step 4 in the left panel.'); focusStep('run'); return; } setSource(id); },
      }));
    }
    seg.append(src, h('span.vsep'));
    for (const [id, L] of Object.entries(LAYERS)) {
      const dis = L.needsDynamic && !S.dyn;
      seg.append(h(`button.seg-btn${S.layer === id ? '.on' : ''}${dis ? '.dis' : ''}`, {
        dataset: { layer: id, tip: dis ? `${L.tip.replace(' (full simulation only)', '')}. Needs the full simulation (step 4).` : L.tip },
        'aria-pressed': String(S.layer === id), 'aria-disabled': dis ? 'true' : null, textContent: L.label,
        onclick: () => {
          if (dis) { toast(`${L.label} comes from the full simulation. Run it in step 4.`); focusStep('run'); return; }
          if (L.needsDynamic && S.source !== 'dynamic') { S.layer = id; setSource('dynamic'); return; }
          setLayer(id);
        },
      }));
    }
  }
  const tb = $('#toggleBar'); tb.innerHTML = '';
  tb.append(toggleBtn('Flow lines', S.showPaths, (v) => { S.showPaths = v; map.showPaths = v; map.request(); renderLegend(); }, TERMS.flowPaths),
    toggleBtn('Labels', S.showLabels, (v) => { S.showLabels = v; map.showLabels = v; map.request(); renderLegend(); }, 'Volume and depth of the largest ponds'));
  tb.classList.toggle('hidden', !!S.compare);
  const vs = $('#viewSeg'); vs.innerHTML = '';
  vs.append(h(`button${!S.view3d ? '.on' : ''}`, { 'aria-pressed': String(!S.view3d), title: 'Map seen from above', html: `${icon('map', 16)}2D`, onclick: () => toggle3D(false) }),
    h(`button${S.view3d ? '.on' : ''}`, { 'aria-pressed': String(S.view3d), title: '3D view: drag to orbit', html: `${icon('cube', 16)}3D`, onclick: () => toggle3D(true) }));
  vs.classList.toggle('hidden', !!S.compare);
  const zb = $('#zoomBar'); zb.innerHTML = '';
  zb.append(h('button', { title: 'Zoom in', 'aria-label': 'Zoom in', html: icon('plus', 16), onclick: () => map.zoomBy(1.5) }),
    h('button', { title: 'Zoom out', 'aria-label': 'Zoom out', html: icon('minus', 16), onclick: () => map.zoomBy(1 / 1.5) }),
    h('button', { title: 'Show the whole site', 'aria-label': 'Show the whole site', html: icon('fit', 16), onclick: () => map.fit(true) }));
  zb.classList.toggle('hidden', S.view3d);
  renderTimebar(); renderLegend(); renderCaption();
}
function toggleBtn(label, on, fn, tip) {
  const b = h(`button.tog${on ? '.on' : ''}`, { html: `<span class="sw" aria-hidden="true"></span>${label}`, 'aria-pressed': String(on), dataset: { tip } });
  b.onclick = () => { const v = !b.classList.contains('on'); b.classList.toggle('on', v); b.setAttribute('aria-pressed', String(v)); fn(v); };
  return b;
}
function setLayer(id) {
  S.layer = id; renderMapChrome(); refreshMap();
  const sb = $('#step-surfaces .row-btns .btn'); if (sb) sb.innerHTML = `${icon('layers', 13)} ${S.layer === 'materials' ? 'Show water' : 'Show surfaces on map'}`;
}
function setSource(src) {
  S.source = src;
  if (src === 'instant' && LAYERS[S.layer].needsDynamic) S.layer = 'depth';
  stopPlay(); renderMapChrome(); refreshMap(); updateResults();
}
/** Scroll a step into view and flash it (used when a disabled control points the user to it). */
function focusStep(name) {
  const st = $(`#step-${name}`); if (!st) return;
  st.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  st.classList.remove('flash'); void st.offsetWidth; st.classList.add('flash');
}

function renderLegend() {
  const el = $('#legend'); el.innerHTML = '';
  if (!S.grid) { el.classList.add('hidden'); return; }
  el.classList.remove('hidden');
  let ramp = null, title = '', note = '';
  const collapse = h('button.lg-toggle', {
    'aria-expanded': String(!S.legendCollapsed), title: S.legendCollapsed ? 'Show legend' : 'Hide legend',
    onclick: () => { S.legendCollapsed = !S.legendCollapsed; renderLegend(); },
  }, S.legendCollapsed ? 'Legend ▸' : '▾');
  if (S.compare) {
    if (S.compare.mode === 'diff') {
      ramp = DIFF; title = DIFF.title; note = 'Blank: no change of 1 cm or more';
      const d = S.compare.diff; let any = false;
      if (d) for (let k = 0; k < d.length && !any; k++) any = Math.abs(d[k]) >= 0.01;
      if (d && !any) note = 'No spot changes by 1 cm or more, so the map shows no colour. See the numbers on the right.';
    }
    else { ramp = DEPTH; title = 'Water depth (ponds filled)'; note = 'A on the left, B on the right. Shallower than 1 cm not shown.'; }
  } else if (S.layer === 'materials') {
    el.append(h('div.lg-title', h('span', 'Surface materials'), collapse));
    if (S.legendCollapsed) { el.classList.add('collapsed'); return; }
    el.classList.remove('collapsed');
    for (const m of materialsPresent(S.grid, S.info.palette)) el.append(h('div.lg-row', h('span.sw', { style: { background: m.color } }), h('span', m.name), h('span.lg-val', fmtArea(m.areaM2))));
    el.append(h('div.lg-row', h('span.sw', { style: { background: '#4a5260' } }), h('span', 'Buildings')));
    el.append(h('div.lg-note', 'Change surfaces in step 3.'));
    return;
  } else {
    const dyn = S.source === 'dynamic' && S.dyn;
    ramp = LAYERS[S.layer].ramp; title = ramp.title;
    if (S.layer === 'depth') {
      title = dyn ? (S.frame >= 0 ? `Water depth at ${fmtClock(S.dyn.frameTimes[S.frame])}` : 'Deepest water during the storm') : 'Water depth (ponds filled)';
      note = dyn ? 'Shallower than 3 cm not shown.' : 'Low spots filled with the rain that reaches them. Shallower than 1 cm not shown.';
    } else if (S.layer === 'infil') note = 'Total soaked into the ground (incl. sub-bases) over the event. Less than 1 mm not shown.';
    else note = 'Highest value during the storm, where water is 3 cm or deeper.';
  }
  el.append(h('div.lg-title', h('span', title, h('span.lg-unit', ` (${ramp.unit})`)), collapse));
  if (S.legendCollapsed) { el.classList.add('collapsed'); return; }
  el.classList.remove('collapsed');
  ramp.colors.forEach((c, i) => el.append(h('div.lg-row', h('span.sw', { style: { background: c } }), h('span', ramp.labels[i]))));
  if (note) el.append(h('div.lg-note', note));
  if (!S.compare && S.showPaths && S.instant) el.append(h('div.lg-row.extra', h('span.sw.line'), h('span', 'Flow line: thicker carries more water')));
  if (!S.compare && S.showLabels && S.source === 'instant' && S.layer === 'depth') el.append(h('div.lg-row.extra', h('span.sw.dot'), h('span', 'Pond'), h('span.sw.dot.spill'), h('span', 'full, overflows')));
}

function captionText() {
  const s = S.settings; const p = preset();
  const design = s.rainDepthMm * s.climateFactor;
  const parts = [`${presetName(p)} (${p.name.replace(' (cloudburst)', '')}): ${fmtInt(s.rainDepthMm)} mm × ${s.climateFactor.toFixed(2)} climate = ${fmtInt(design)} mm`,
    SEWER[s.sewerMode].long, `${(MOIST[s.moisture].long || MOIST[s.moisture].label).toLowerCase()} soil`];
  const nSwap = Object.keys(S.surfaceSwap || {}).length + (S.groundMaterial ? 1 : 0);
  if (nSwap) parts.push(`${nSwap} surface change${nSwap > 1 ? 's' : ''}`);
  const cell = S.source === 'dynamic' && S.dyn ? S.dyn.grid.dx : (S.grid ? S.grid.dx : 1);
  const tm = terrainInfo();
  if (tm && (tm.nativeResM != null || tm.sourceName)) {
    const lvl = tm.suitability && tm.suitability.level;
    parts.push(`terrain: ${tm.sourceId === 'upload' ? 'uploaded file' : tm.sourceName.split(/ [–(]/)[0]}${tm.nativeResM != null ? ` ${+(+tm.nativeResM).toFixed(2)} m` : ''}${lvl === 'unsuitable' ? ' (NOT for site screening)' : lvl === 'poor' ? ' (overview only)' : ''}`);
  }
  parts.push(`${cell} m grid`);
  if (S.source === 'dynamic' && S.dyn) parts.push('full simulation (2D, over time)'); else parts.push('quick check (ponds filled, no timing)');
  return parts.join(' · ');
}
function renderCaption() {
  const el = $('#caption');
  if (!S.grid) { el.innerHTML = ''; return; }
  const text = S.compare ? `Compare: A = ${S.compare.a.name} · B = ${S.compare.b.name}` : captionText();
  el.innerHTML = '';
  const tm = S.compare ? null : terrainInfo();
  el.append(h('span', text));
  if (tm && tm.attribution.length) el.append(h('span.muted.small.caption-attr', `Data: ${tm.attribution.join(' · ')}`));
  if (tm && tm.suitability && tm.suitability.level === 'unsuitable') el.append(h('b.warn', { title: tm.suitability.message }, 'TERRAIN TOO COARSE – not for site screening'));
  el.append(h('b.warn', { title: 'For comparing design options. Not for permits or compliance.' }, 'SCREENING MODEL – not for compliance'));
}

// ---------- hover tooltip
function hazardWord(v) { return v < 0.5 ? `low (${v.toFixed(2)})` : v < 0.75 ? `caution (${v.toFixed(2)})` : v < 1.25 ? `danger for some (${v.toFixed(2)})` : v < 2 ? `danger for most (${v.toFixed(2)})` : `danger for all (${v.toFixed(2)})`; }
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
          rows.push(['Deepest', fmtCm(S.dyn.hMax[kd])], ['Fastest speed', `${S.dyn.vMax[kd].toFixed(2)} m/s`],
            ['Danger to people', hazardWord(S.dyn.hazard[kd])], ['Deepest after', S.dyn.hMax[kd] >= 0.03 ? `${Math.round(S.dyn.tPeak[kd] / 60)} min` : '–']);
          if (S.dyn.infiltrated) rows.push(['Soaked in', `${fmtInt(S.dyn.infiltrated[kd] * 1000)} mm`]);
        }
      } else if (S.instant) {
        const d = S.instant.depth[k]; rows.push(['Water depth', d >= 0.01 ? fmtCm(d) : 'dry']);
        const acc = S.instant.accumulation[k]; if (acc > 0.5) rows.push(['Water running through', `${fmtVol(acc)} m³`]);
        const lab = S.instant.labels ? S.instant.labels[k] : -1;
        if (lab >= 0) { const bs = S.instant.bluespots.find((b) => b.id === lab); if (bs && bs.volumeM3 >= 1) rows.push(['Pond', `${fmtVol(bs.volumeM3)} m³${bs.spills ? ' · full, overflows' : ''}`]); }
      }
    }
  }
  tt.innerHTML = rows.map(([k, v]) => `<div class="tt-row"><span>${k}</span><b>${v}</b></div>`).join('');
  tt.classList.remove('hidden');
  const W = map.W, H = map.H; const tw = tt.offsetWidth, th = tt.offsetHeight;
  tt.style.transform = `translate(${sx + 16 + tw > W ? sx - tw - 14 : sx + 16}px, ${sy + 16 + th > H ? sy - th - 12 : sy + 16}px)`;
}

// ------------------------------------------------------------------------------------------------ left panel
// The left panel is the job, in order: Site → Rain → Surfaces → Run → Compare → Export.
// Each step is <section class="step" id="step-<name>" data-step="<name>">; a step that cannot be used yet
// carries .is-blocked and says why in .step-blocked.
const STEPS = [
  ['site', 'Site'], ['rain', 'Rain'], ['surfaces', 'Surfaces & drainage'], ['run', 'Run'], ['compare', 'Compare designs'], ['export', 'Export'],
];

function renderLeft() {
  const el = $('#leftPanel'); const scroll = el.scrollTop; el.innerHTML = '';
  el.classList.remove('locked');
  if (S.compare) { renderLeftCompare(el); return; }
  const ready = !!S.grid;
  const blocked = ready ? null : (S.site && S.site.kind === 'real' ? 'Load terrain for this site first (step 1).' : 'Preparing the site…');
  const s = S.settings;

  el.append(stepSection('site', siteSummary(), siteStepBody()));

  // 2 rain
  const presets = h('div.presets', { role: 'radiogroup', 'aria-label': 'Rain event' });
  for (const p of S.info.presets) {
    const L = PRESET_LABEL[p.id] || { name: p.name, sub: `${p.durationMin / 60} h` };
    presets.append(h(`button.preset${p.id === s.presetId ? '.on' : ''}`, {
      role: 'radio', 'aria-checked': String(p.id === s.presetId), dataset: { preset: p.id },
      title: `${L.name}: ${fmtInt(p.depthMm)} mm × climate factor ${p.climateFactor.toFixed(2)}, peak ${fmtInt(Math.max(...p.intensity) * p.climateFactor)} mm/h`,
      onclick: () => {
        Object.assign(s, { presetId: p.id, rainDepthMm: p.depthMm, climateFactor: p.climateFactor });
        $$('.preset', el).forEach((b) => { const on = b.dataset.preset === p.id; b.classList.toggle('on', on); b.setAttribute('aria-checked', String(on)); });
        syncSliders(); settingsChanged();
      },
    }, h('div.pre-txt', h('span.pre-name', L.name), h('span.pre-sub', L.sub)),
    h('div.hyeto', { html: hyetoSvg(p.intensity, 60, 22, 24) }),
    h('span.pre-mm', `${fmtInt(p.depthMm * p.climateFactor)} mm`)));
  }
  el.append(stepSection('rain', `${fmtInt(s.rainDepthMm * s.climateFactor)} mm`,
    h('p.step-note', 'Which storm should fall on the site?', help('returnPeriod')),
    presets,
    h('div.rain-summary#rainSummary'),
    h('details.advanced', h('summary', 'Adjust rain amount and climate factor'),
      h('div.adv-body',
        slider('rainDepth', 'Rain today', 10, 150, 1, s.rainDepthMm, (v) => `${fmtInt(v)} mm`, (v) => { s.rainDepthMm = v; settingsChanged(); }),
        slider('climate', 'Climate factor (future rain)', 1, 1.6, 0.05, s.climateFactor, (v) => `× ${v.toFixed(2)}`, (v) => { s.climateFactor = v; settingsChanged(); }),
        h('p.step-note', TERMS.climate))), blocked));
  updateRainSummary();

  // 3 surfaces & drainage
  el.append(stepSection('surfaces', surfaceSummary(),
    surfacesBlock(),
    h('label.field-label', term('Where do roofs and paved areas drain?', 'sewer')),
    segControl(SEWER.map((o) => ({ v: o.v, html: `${o.label}<small>${o.sub}</small>` })), s.sewerMode, (v) => { s.sewerMode = v; settingsChanged(); }, 'sewer'),
    h('label.field-label', term('Ground before the storm', 'moisture')),
    segControl(MOIST.map((o) => ({ v: o.v, html: o.label })), s.moisture, (v) => { s.moisture = v; settingsChanged(); }, 'moisture'), blocked));

  // 4 run
  el.append(stepSection('run', S.dyn ? 'Simulated' : 'Quick check',
    h('div.quick-status#quickStatus'),
    h('div.run-full',
      h('div.run-full-head', h('b', 'Full simulation'), help('dynamic')),
      h('p.step-note', 'Adds water speed, danger to people and timing. Runs in the background; you can keep working.'),
      h('div#dynBox')),
    h('details.advanced', h('summary', 'Simulation settings'),
      h('div.adv-body',
        h('label.field-label', term('Detail (cell size)', 'cellSize')),
        segControl([1, 2, 4].map((v) => ({ v, html: `${v} m<small>${v === 1 ? 'fine, slow' : v === 2 ? 'balanced' : 'coarse, fast'}</small>` })), S.dynCell, (v) => { S.dynCell = v; renderDynBox(); }, 'dyncell'),
        h('label.field-label', 'How long to simulate'),
        segControl(DURATIONS.map((d) => ({ v: d.id, html: d.label })), S.dynDuration, (v) => { S.dynDuration = v; renderDynBox(); }, 'dyndur'))), blocked));
  renderDynBox(); updateQuickStatus();

  // 5 compare
  el.append(stepSection('compare', S.options.length ? `${S.options.length} saved` : '', optionsBlock(), blocked));

  // 6 export: built-in and registered actions (js/hooks.js)
  el.append(stepSection('export', '', exportBlock(), blocked));
  el.scrollTop = scroll;
}

function stepSection(name, summary, ...body) {
  const blocked = typeof body[body.length - 1] === 'string' || body[body.length - 1] === null ? body.pop() : null;
  const n = STEPS.findIndex(([k]) => k === name) + 1; const title = STEPS[n - 1][1];
  return h(`section.step#step-${name}${blocked ? '.is-blocked' : ''}`, { dataset: { step: name }, 'aria-labelledby': `step-${name}-title` },
    h('div.step-head', h('span.step-n', String(n)), h('h3', { id: `step-${name}-title` }, title), summary ? h('span.step-sum', summary) : null),
    blocked ? h('p.step-blocked', { html: `${icon('info', 13)} ${blocked}` }) : null,
    h('div.step-body', { inert: !!blocked }, ...body));
}

function siteSummary() {
  if (!S.site) return '';
  if (!S.grid) return 'Terrain needed';
  return `${fmtInt(S.grid.nx * S.grid.dx)} × ${fmtInt(S.grid.ny * S.grid.dx)} m`;
}
function siteStepBody() {
  const out = [];
  if (S.site && S.grid) {
    const g = S.grid; const nB = S.sampleJson ? S.sampleJson.buildings.length : (S.siteDesc && S.siteDesc.buildings && S.siteDesc.buildings.length) || null;
    out.push(h('p.site-line', h('b', S.site.name), h('span.muted', [
      `${fmtInt(g.nx * g.dx)} × ${fmtInt(g.ny * g.dx)} m`, `${g.dx} m grid`,
      nB != null ? `${nB} buildings` : 'terrain only',
    ].join(' · '))));
    const tm = terrainInfo();
    if (S.site.kind !== 'synthetic' && !(tm && (tm.osm || tm.canAddOsm))) out.push(h('p.step-note', 'Terrain from a file or DHM: buildings are not in the terrain and every surface counts as one material (choose it in step 3).'));
    if (tm) out.push(...terrainBlock(tm));
    // Engine notes matter for real terrain (e.g. bridge decks); for the built-in examples they are noise.
    const notes = S.site.kind === 'synthetic' ? [] : (g.warnings || []).filter((w) => !/built in/i.test(w));
    if (notes.length) out.push(h('p.step-warn', { html: `${icon('alert', 13)} ${notes.join(' ')}` }));
  } else if (S.site && S.site.kind === 'real') {
    out.push(h('p.step-note', 'This real site needs its terrain. Use the panel on the map: fetch it with a free API key, or drop a terrain file.'));
  }
  out.push(h('div.row-btns', h('a.btn.ghost.small', { href: '#/', html: `${icon('back', 13)} Change site` })));
  return out;
}

/** Site step: terrain source, resolution, CRS, fitness for site screening, attribution, OSM context, aggregation. */
function terrainBlock(tm) {
  const out = [];
  const res = tm.nativeResM != null ? `${+(+tm.nativeResM).toFixed(2)} m` : 'unknown';
  const crs = tm.crs ? `${tm.crs.epsg ? `EPSG:${tm.crs.epsg}` : ''}${tm.crs.name ? ` ${tm.crs.name}` : ''}`.trim() : 'no coordinate system (local metres)';
  out.push(h('p.step-note.terrain-src', h('b', 'Terrain: '), `${tm.sourceName} · native resolution ${res} · ${crs}`));
  const sv = tm.suitability;
  if (sv && (sv.level === 'unsuitable' || sv.level === 'poor')) {
    out.push(h(`p.step-warn.terrain-suit.suit-${sv.level}`, { dataset: { level: sv.level }, html: `${icon('alert', 13)} <span><b>${sv.level === 'unsuitable' ? 'Not suitable for site screening.' : 'Overview only.'}</b> ${sv.message} A report made from this terrain carries this warning on its cover.</span>` }));
  } else if (sv) out.push(h('p.step-note.terrain-suit', { dataset: { level: sv.level } }, h(`b.suit-${sv.level}`, `${sv.label}. `), sv.message));
  if (tm.osm) out.push(h('p.step-note', `${tm.osm.buildings} building${tm.osm.buildings === 1 ? '' : 's'} and ${tm.osm.surfaces} surface area${tm.osm.surfaces === 1 ? '' : 's'} from OpenStreetMap; change their materials in step 3.`));
  else if (tm.canAddOsm) {
    const b = h('button.btn.ghost.small#addOsm', { title: 'Add buildings and surfaces from OpenStreetMap', onclick: () => addOsmContext(b) }, 'Add from OpenStreetMap');
    out.push(h('p.step-note', 'Buildings are not in the terrain and every surface counts as one material (step 3). Add buildings and surfaces from OpenStreetMap: footprints become obstacles and land use sets the surface materials. Needs internet; data © OpenStreetMap contributors (ODbL).'), h('div.row-btns', b));
  }
  if (tm.attribution.length) out.push(h('p.muted.small.terrain-attr', `Data: ${tm.attribution.join(' · ')}`));
  if (tm.prepared && S.site.rawTerrain) {
    const method = (S.site.info.terrainOptions && S.site.info.terrainOptions.method) || 'mean';
    const reproj = /^reproject/.test(tm.method || '');
    const why = { mean: 'Mean: the average of the terrain samples in each cell – the usual choice.', min: 'Lowest: keeps gutters, ditches and narrow channels open; kerbs and low walls get lower.', max: 'Highest: keeps kerbs, low walls and ridges as barriers; narrow channels may close.', nearest: 'Nearest: one sample per cell, no smoothing – noisy with very fine data.' };
    out.push(h('details.advanced', h('summary', 'Advanced: terrain processing'),
      h('div.adv-body',
        h('label.field-label', 'How terrain samples become one height per grid cell'),
        segControl(['mean', 'min', 'max', 'nearest'].map((v) => ({ v, html: { mean: 'Mean', min: 'Lowest', max: 'Highest', nearest: 'Nearest' }[v] })), method, (v) => setTerrainMethod(v), 'terrainMethod'),
        h('p.step-note', reproj ? 'This file was reprojected to metres, so its heights are interpolated (bilinear) and this choice does not apply.' : why[method]))));
  }
  return out;
}

// ---------- surfaces: swap the material of the site's surface regions (a design change), or the ground material
function polyArea(xs, ys) { let a = 0; for (let i = 0, j = xs.length - 1; i < xs.length; j = i++) a += (xs[j] + xs[i]) * (ys[j] - ys[i]); return Math.abs(a / 2); }
function mat(id) { return S.info.palette.materials.find((m) => m.id === id); }
function materialSelect(value, onChange, label) {
  const groups = new Map();
  for (const m of S.info.palette.materials) { if (!groups.has(m.category)) groups.set(m.category, []); groups.get(m.category).push(m); }
  const sel = h('select.mat-select', { 'aria-label': label, onchange: () => onChange(sel.value) },
    ...[...groups].map(([cat, ms]) => h('optgroup', { label: cat }, ...ms.map((m) => h('option', { value: m.id, selected: m.id === value }, m.name)))));
  return sel;
}
function surfaceGroups() {
  const regions = (S.sampleJson && S.sampleJson.surfaces) || (S.site && S.site.baseSurfaces) || [];
  const groups = new Map();
  for (const r of regions) { const g = groups.get(r.material) || { id: r.material, n: 0, area: 0 }; g.n++; g.area += polyArea(r.xs, r.ys); groups.set(r.material, g); }
  return [...groups.values()].sort((a, b) => b.area - a.area);
}
/** One line, in plain words, on what a material does with rain (sub-base, soil table, surface rate). */
function waterNote(m) {
  if (!m) return '';
  const row = m.compacted === false ? 'loose' : 'compacted';
  if (m.subsoilLimited) return m.storageMm > 0
    ? `soaks in up to ${fmtInt(Math.max(m.infiltrationSand, m.infiltrationClay))} mm/h into a ${fmtInt(m.storageMm)} mm sub-base, which drains to the subsoil at the soil's rate`
    : `soaks in, then drains to the subsoil at the soil's rate (${row} JB soil)`;
  if (m.useSoilTable) return `soaks in at the rate of the JB soil table (${row})`;
  if (m.sealed) return 'sealed: runs off, or to the sewer';
  const f = Math.max(m.infiltrationSand, m.infiltrationClay);
  return f > 0 ? `soaks in up to ${fmtInt(f)} mm/h` : 'does not soak in';
}
function surfaceSummary() {
  const n = Object.keys(S.surfaceSwap).length + (S.groundMaterial ? 1 : 0);
  return n ? `${n} change${n > 1 ? 's' : ''}` : 'As drawn';
}
function surfacesBlock() {
  const wrap = h('div.surfaces');
  const groups = surfaceGroups();
  wrap.append(h('p.step-note', 'Change a surface to test a design idea. The map updates straight away.', help('surfaces')));
  const list = h('div.surf-list');
  for (const g of groups) {
    const now = S.surfaceSwap[g.id] || g.id; const m = mat(now); const orig = mat(g.id);
    list.append(h(`div.surf-row${S.surfaceSwap[g.id] ? '.changed' : ''}`,
      h('span.sw', { style: { background: m ? m.color : '#888' } }),
      h('div.surf-txt',
        materialSelect(now, (v) => { if (v === g.id) delete S.surfaceSwap[g.id]; else S.surfaceSwap[g.id] = v; applyDesignChange(); }, `Material for ${orig ? orig.name : g.id}`),
        h('span.muted', `${fmtArea(g.area)} · ${g.n} area${g.n > 1 ? 's' : ''}${S.surfaceSwap[g.id] ? ` · was ${orig ? orig.name : g.id}` : ''}`),
        h('span.muted.small.water-note', waterNote(m)))));
  }
  const groundNow = S.groundMaterial || S.info.palette.defaultMaterial;
  const gm = mat(groundNow);
  list.append(h(`div.surf-row${S.groundMaterial ? '.changed' : ''}`,
    h('span.sw', { style: { background: gm ? gm.color : '#888' } }),
    h('div.surf-txt',
      materialSelect(groundNow, (v) => { S.groundMaterial = v === S.info.palette.defaultMaterial ? null : v; applyDesignChange(); }, 'Material for everything else'),
      h('span.muted', groups.length ? 'everything else (not drawn as a surface)' : 'the whole site'),
      h('span.muted.small.water-note', waterNote(gm)))));
  wrap.append(list);
  const btns = h('div.row-btns');
  btns.append(h('button.btn.ghost.small', { onclick: () => { setLayer(S.layer === 'materials' ? 'depth' : 'materials'); }, html: `${icon('layers', 13)} ${S.layer === 'materials' ? 'Show water' : 'Show surfaces on map'}` }));
  if (Object.keys(S.surfaceSwap).length || S.groundMaterial) {
    btns.append(h('button.btn.ghost.small', { onclick: () => { S.surfaceSwap = {}; S.groundMaterial = null; applyDesignChange(); toast('Surfaces reset to the original design'); }, html: `${icon('undo', 13)} Reset surfaces` }));
  }
  wrap.append(btns);
  return wrap;
}

// ---------- compare
function optionsBlock() {
  const wrap = h('div.options');
  const pair = S.site && S.site.info.compareWith && sampleInfo(S.site.info.compareWith);
  if (pair) {
    wrap.append(h('button.btn.accent.wide#pairBtn', { onclick: comparePair, disabled: !S.instant, html: `${icon('compare', 15)} Compare with ‘${shortName(pair.name)}’` }),
      h('p.step-note', 'This example comes with a redesigned version. Or build your own options below.'));
  }
  const list = h('div.opts');
  S.options.forEach((o, i) => list.append(h('div.opt', h('span.opt-letter', String.fromCharCode(65 + i)), h('div.opt-txt', h('b', o.name), h('span', o.caption)),
    h('button.icon-btn', { title: `Remove option ${String.fromCharCode(65 + i)}`, 'aria-label': `Remove option ${String.fromCharCode(65 + i)}`, html: icon('x', 14), onclick: () => removeOption(i) }))));
  const n = S.options.length; const next = String.fromCharCode(65 + n);
  const guide = n === 0 ? 'Save what you see now as option A. Then change the rain or a surface and save option B.'
    : n === 1 ? 'Now change something (a surface in step 3, the drainage or the rain), then save option B.'
      : 'Compare the last two options, or save more.';
  wrap.append(h('p.step-note', guide), list);
  wrap.append(h('div.row-btns',
    h('button.btn.ghost', { onclick: saveOption, disabled: !S.instant, html: `${icon('save', 14)} Save as option ${next}` }),
    n >= 2 ? h('button.btn.primary', { onclick: () => enterCompare(S.options[n - 2], S.options[n - 1], 'diff'), html: `${icon('compare', 14)} Compare ${String.fromCharCode(63 + n)} and ${String.fromCharCode(64 + n)}` }) : null));
  return wrap;
}
function removeOption(i) {
  const [o] = S.options.splice(i, 1); renderLeft();
  toast(`Removed ${o.name}`, 'info', { label: 'Undo', fn: () => { S.options.splice(i, 0, o); renderLeft(); } });
}

// ---------- export
function exportBlock() {
  const wrap = h('div.export-actions', { dataset: { hook: 'export-actions' } });
  for (const a of exportActions()) {
    const ok = a.enabled ? a.enabled(appContext()) : true;
    wrap.append(h(`button.btn.export-btn${a.primary ? '.primary' : '.ghost'}`, {
      dataset: { export: a.id }, disabled: ok !== true, title: ok === true ? (a.description || '') : ok,
      onclick: () => a.run(appContext()),
    }, h('span.exp-ic', { html: icon(a.icon || 'download', 15) }), h('span.exp-txt', h('b', a.label), a.description ? h('small', ok === true ? a.description : ok) : null)));
  }
  wrap.append(h('p.step-note.exp-note', 'Every export carries the rain, drainage and grid assumptions, and the words "screening model".'));
  return wrap;
}

function renderLeftCompare(el) {
  const { a, b } = S.compare;
  el.append(h('div.panel-head', h('div.eyebrow', 'Comparing'), h('h2', 'Option A vs option B')),
    h('section.step#step-compare.is-current', { dataset: { step: 'compare' } },
      h('div.step-head', h('span.step-n', '5'), h('h3', 'Compare designs')),
      h('div.step-body',
        h('div.cmp-names', h('div', h('span.opt-letter.sm', 'A'), h('span', a.name)), h('div', h('span.opt-letter.sm.b', 'B'), h('span', b.name))),
        h('p.step-note', S.compare.mode === 'diff' ? 'Green: drier in B. Red: wetter in B. Use the switch above the map to see both side by side.' : 'Drag the divider on the map: A on the left, B on the right.'),
        h('div.row-btns',
          h('button.btn.ghost', { onclick: () => { S.compare = { a: b, b: a, mode: S.compare.mode }; renderLeft(); refreshMap(); updateResults(); renderCaption(); }, html: `${icon('swipe', 14)} Swap A and B` }),
          h('button.btn.primary', { onclick: exitCompare, html: `${icon('x', 14)} Back to editing` })))),
    stepSection('export', '', exportBlock()));
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
  const wrap = h('div.segctl', { dataset: { name }, role: 'group' });
  for (const o of opts) {
    const b = h(`button${o.v === value ? '.on' : ''}`, { html: o.html, dataset: { v: String(o.v) }, 'aria-pressed': String(o.v === value) });
    b.onclick = () => { $$('button', wrap).forEach((x) => { x.classList.toggle('on', x === b); x.setAttribute('aria-pressed', String(x === b)); }); onChange(o.v); };
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
  el.innerHTML = '';
  el.append(h('span', term('Rain on the site', 'designRain')), h('b', `${fmtInt(design)} mm`),
    h('span.muted', `${fmtInt(s.rainDepthMm)} mm today × ${s.climateFactor.toFixed(2)} for future climate`));
  const sum = $('#step-rain .step-sum'); if (sum) sum.textContent = `${fmtInt(design)} mm`;
}
function updateQuickStatus() {
  const el = $('#quickStatus'); if (!el) return;
  el.innerHTML = '';
  if (!S.instant) { el.append(h('span.muted', 'Quick check runs as soon as the site is loaded.')); return; }
  el.append(h('span.qs-ok', { html: icon('check', 14) }), h('span', h('b', 'Quick check is live'), help('instant'), h('br'),
    h('span.muted', `Updates by itself when you change rain or surfaces (${Math.max(1, Math.round(S.instMs))} ms).`)));
}

// ---------- dynamic
function dynamicRain() {
  const p = preset(); const s = S.settings; const dur = DURATIONS.find((d) => d.id === S.dynDuration);
  const scale = s.rainDepthMm / p.depthMm;
  let rain = Array.from(p.intensity, (v) => v * scale);
  if (dur.cut) rain = rain.slice(0, dur.cut);
  return { rain, after: dur.after, totalMin: rain.length + dur.after };
}
function estimateRunRawS() {
  if (!S.grid) return 0;
  const { totalMin } = dynamicRain(); const c = S.dynCell;
  const cells = (S.grid.nx * S.grid.dx / c) * (S.grid.ny * S.grid.dx / c);
  return 7.5e-6 * cells * totalMin * (2 / c);
}
/** Estimate corrected by what the last run on this computer actually took. */
function estimateRunS() { return estimateRunRawS() * S.speedK; }
function fmtEstimate(sec) { return sec < 60 ? `about ${Math.max(5, Math.round(sec / 5) * 5)} s` : `about ${Math.round(sec / 60)} min`; }
function settingsKey() { return JSON.stringify({ ...S.settings, cell: S.dynCell, dur: S.dynDuration, swap: S.surfaceSwap, ground: S.groundMaterial }); }

function renderDynBox() {
  const box = $('#dynBox'); if (!box) return; box.innerHTML = '';
  if (S.dynRun) {
    box.append(h('div.progress-card',
      h('div.pc-head', h('span.spinner'), h('b#dynPct', 'Starting…'), h('span.muted#dynEta', '')),
      h('div.bar', { role: 'progressbar', 'aria-label': 'Simulation progress', 'aria-valuemin': 0, 'aria-valuemax': 100 }, h('div.fill#dynFill')),
      h('div.pc-meta', h('span#dynSim', ''), h('span#dynH', '')),
      h('button.btn.ghost.small', { onclick: cancelDynamic, html: `${icon('stop', 12)} Cancel` })));
    renderRunStatus();
    return;
  }
  renderRunStatus();
  const stale = S.dyn && S.dyn.key !== settingsKey();
  box.append(h('button.btn.primary.wide#runDyn', { onclick: startDynamic, disabled: !S.grid, html: `${icon('play', 14)} ${S.dyn ? (stale ? 'Run again with new settings' : 'Run again') : 'Run full simulation'}` }),
    h('div.est', { html: `${icon('clock', 13)} Takes ${fmtEstimate(estimateRunS())} · simulates ${fmtDuration(dynamicRain().totalMin * 60).replace(' 0 s', '')} of storm` }));
  if (S.dyn) {
    const m = S.dyn.mass;
    box.append(h('div.dyn-done', { html: `${icon('check', 14)} Simulated in ${fmt1(m.elapsedS)} s. Speed, danger and timing are on the map.` }));
    box.append(h(`div.stale#dynStale${stale ? '' : '.hidden'}`, { html: `${icon('alert', 13)} You changed settings after this run, so the simulation shows the old design. Run again to update it.` }));
  }
}
function updateDynStale() {
  const stale = S.dyn && S.dyn.key !== settingsKey();
  const el = $('#dynStale'); if (el) el.classList.toggle('hidden', !stale);
  if (!S.dynRun && $('#runDyn')) {
    $('#runDyn').innerHTML = `${icon('play', 14)} ${S.dyn ? (stale ? 'Run again with new settings' : 'Run again') : 'Run full simulation'}`;
    const e = $('#dynBox .est'); if (e) e.innerHTML = `${icon('clock', 13)} Takes ${fmtEstimate(estimateRunS())} · simulates ${fmtDuration(dynamicRain().totalMin * 60).replace(' 0 s', '')} of storm`;
  }
  renderCaption();
}

/** Progress pill on the map, so a running simulation is visible wherever the panel is scrolled. */
function renderRunStatus(p = null) {
  const el = $('#runStatus'); if (!el) return;
  if (!S.dynRun) { el.classList.add('hidden'); el.innerHTML = ''; return; }
  el.classList.remove('hidden');
  if (!el.firstChild) {
    el.append(h('span.spinner'), h('span.rs-txt', 'Simulating…'), h('button.btn.ghost.small', { onclick: cancelDynamic, html: `${icon('stop', 11)} Cancel` }));
  }
  if (p) el.querySelector('.rs-txt').textContent = `Full simulation ${Math.round(p.f * 100)} %${p.eta ? ` · ${p.eta} left` : ''}`;
}

function startDynamic() {
  if (!S.grid || S.dynRun) return;
  const { rain, after, totalMin } = dynamicRain();
  const outInt = Math.max(60, Math.round((totalMin * 60) / 48 / 60) * 60);
  const scenario = { ...scenarioInstant(), afterRainMin: after, outputIntervalS: outInt, maxFrames: 120 };
  const key = settingsKey(); const site = S.site; const rawEst = estimateRunRawS();
  const run = S.cb.runDynamic(S.siteDesc, gridSettings(S.dynCell), scenario, rain, [], (p) => {
    if (S.dynRun !== run) return;
    const f = clamp(p.fraction, 0, 1); const eta = f > 0.02 ? (p.elapsedS * (1 - f)) / f : NaN;
    renderRunStatus({ f, eta: isFinite(eta) ? fmtDuration(eta) : '' });
    const pct = $('#dynPct'); if (!pct) return;
    pct.textContent = `${Math.round(f * 100)} %`;
    $('#dynFill').style.width = `${f * 100}%`;
    const bar = $('#dynBox .bar'); if (bar) bar.setAttribute('aria-valuenow', Math.round(f * 100));
    $('#dynEta').textContent = isFinite(eta) ? `${fmtDuration(eta)} left` : 'estimating…';
    $('#dynSim').textContent = `storm time ${fmtClock(p.timeS)} of ${fmtClock(totalMin * 60)}`;
    $('#dynH').textContent = `deepest so far ${fmtCm(p.hMax)}`;
  });
  S.dynRun = run; renderDynBox();
  run.result.then((res) => {
    if (S.dynRun !== run || S.site !== site) return;
    S.dynRun = null;
    if (rawEst > 0 && res.mass.elapsedS > 0) S.speedK = clamp(res.mass.elapsedS / rawEst, 0.2, 10);
    res.key = key; res.rain = rain; res.totalMin = totalMin;
    S.dyn = res; S.frame = -1; S.source = 'dynamic';
    renderLeft(); renderMapChrome(); refreshMap(); updateResults();
    toast(`Full simulation done in ${fmt1(res.mass.elapsedS)} s. Try Speed, Danger and Timing above the map.`, 'ok');
  }).catch((e) => {
    if (S.dynRun === run) { S.dynRun = null; renderDynBox(); }
    if (!/cancel/.test(e.message)) { console.error(e); toast(`The simulation stopped with an error: ${e.message}. Try a coarser cell size (Run ▸ Simulation settings).`, 'error'); }
  });
}
function cancelDynamic() { if (S.dynRun) { S.dynRun.cancel(); S.dynRun = null; renderDynBox(); toast('Simulation cancelled. Your earlier results are unchanged.'); } }

// ---------- time bar
function renderTimebar() {
  const tb = $('#timebar');
  const show = S.dyn && S.source === 'dynamic' && !S.compare && S.layer === 'depth';
  tb.classList.toggle('hidden', !show); $('#mapwrap').classList.toggle('has-time', !!show);
  if (map) { map.bottomInset = show ? 128 : 58; map.request(); }
  if (!show) return;
  tb.innerHTML = '';
  const d = S.dyn; const n = d.frames.length;
  const play = h('button.play', { html: icon(S.playing ? 'pause' : 'play', 16), title: 'Play the storm', 'aria-label': 'Play the storm', onclick: togglePlay });
  const totalS = d.totalMin * 60;
  const rainSvg = h('div.tb-rain', { html: areaSvg(d.rain.concat(new Array(Math.max(0, d.totalMin - d.rain.length)).fill(0)), 400, 26) });
  const inp = h('input#timeSlider', { 'aria-label': 'Time in the storm', type: 'range', min: 0, max: n - 1, step: 1, value: S.frame < 0 ? n - 1 : S.frame });
  const label = h('div.tb-time');
  const maxBtn = h(`button.tog.small${S.frame < 0 ? '.on' : ''}`, { html: '<span class="sw"></span>Deepest overall', dataset: { tip: 'On: the deepest water at each spot during the whole storm. Off: the water at the time on the slider.' } });
  const upd = () => {
    const t = S.frame < 0 ? null : d.frameTimes[S.frame];
    label.innerHTML = t == null ? `<b>Deepest</b><span>over ${fmtClock(totalS)}</span>` : `<b>${fmtClock(t)}</b><span>of ${fmtClock(totalS)}</span>`;
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
// Regions: .panel-head (title + status chip), #resVerdict (one plain sentence), #resBody (numbers, details).
function renderRight() {
  const el = $('#rightPanel'); el.innerHTML = '';
  el.append(h('div.panel-head.row', h('div', h('div.eyebrow', 'Results'), h('h2#resTitle', 'Quick check')), h('span.live.hidden#live', { role: 'status' }, h('span.dot'), h('span#liveText', 'Live'))));
  el.append(h('div#resBody'));
  updateResults();
}

function tile(label, value, unit, cls = '', sub = '', tip = null) {
  return h(`div.tile${cls}`, h('div.t-label', label, tip ? help(tip) : null), h('div.t-val', h('span.num', value), h('span.unit', unit)), sub ? h('div.t-sub', { html: sub }) : null);
}

function updateResults() {
  const body = $('#resBody'); if (!body) return;
  if (S.compare) { renderCompareResults(body); return; }
  $('#live').classList.toggle('hidden', !S.grid);
  if (!S.grid) {
    body.innerHTML = '';
    const real = S.site && S.site.kind === 'real';
    body.append(h('div.empty', h('div.empty-ic', { html: icon(real ? 'upload' : 'drop', 28) }),
      h('p', real ? 'No terrain yet. Fetch it or drop a terrain file (see the map), and results appear here.' : 'Preparing the site…')));
    return;
  }
  const dyn = S.source === 'dynamic' && S.dyn;
  $('#resTitle').textContent = dyn ? 'Full simulation' : 'Quick check';
  $('#liveText').textContent = dyn ? `simulated in ${fmt1(S.dyn.mass.elapsedS)} s` : 'live';
  $('#live').classList.toggle('dyn', !!dyn);
  const scrollTop = body.scrollTop;
  body.innerHTML = '';
  const cell2 = (g) => g.dx * g.dx;
  if (dyn) {
    const d = S.dyn; const g = d.grid; let maxD = 0, maxV = 0, a10 = 0, wet = 0, danger = 0;
    for (let k = 0; k < d.hMax.length; k++) {
      if (g.building[k] >= 0) continue; const hv = d.hMax[k];
      if (hv > maxD) maxD = hv; if (hv >= 0.03) { wet++; if (d.vMax[k] > maxV) maxV = d.vMax[k]; if (d.hazard[k] >= 0.75) danger++; } if (hv > 0.1) a10++;
    }
    const area10 = a10 * cell2(g);
    body.append(verdict(area10, maxD, danger * cell2(g)));
    body.append(h('div.tiles',
      tile('Area deeper than 10 cm', fmtInt(area10), 'm²', area10 > 0 ? '.hot' : '.good', targetText(area10), 'target'),
      tile('Deepest water', Math.round(maxD * 100), 'cm'),
      tile('Fastest water', maxV.toFixed(2), 'm/s', '', `wet area ${fmtArea(wet * cell2(g))}`),
      tile('Still on site at the end', fmtVol(d.mass.storedM3), 'm³')));
    body.append(massCard(d.mass, d.permeability));
  } else if (S.instant) {
    const st = S.instant.stats;
    body.append(verdict(st.areaOver10CmM2, st.maxDepthM, null));
    body.append(h('div.tiles',
      tile('Area deeper than 10 cm', fmtInt(st.areaOver10CmM2), 'm²', st.areaOver10CmM2 > 0 ? '.hot' : '.good', targetText(st.areaOver10CmM2), 'target'),
      tile('Water standing in ponds', fmtVol(st.storedVolumeM3), 'm³', '', `over ${fmtArea(st.floodedAreaM2)}`),
      tile('Deepest water', Math.round(st.maxDepthM * 100), 'cm'),
      tile('Ponds', fmtInt(st.bluespotCount), '', '', 'low spots that fill up', 'bluespot')));
    body.append(balanceCard(st));
    body.append(bluespotCard());
  }
  body.append(retentionCard());
  updateRetentionCard();
  body.append(h('p.res-next', { html: nextStepText() }));
  body.scrollTop = scrollTop;
}
/** One sentence a non-hydrologist can repeat in a meeting. */
function verdict(area10, maxD, dangerArea) {
  const p = presetName(preset()).toLowerCase();
  let txt = area10 > 0
    ? `In this ${p}, <b>${fmtArea(area10)}</b> of the site gets deeper than 10 cm (deepest ${Math.round(maxD * 100)} cm).`
    : `In this ${p}, no water on the site gets deeper than 10 cm (deepest ${Math.round(maxD * 100)} cm).`;
  if (dangerArea != null) txt += dangerArea > 0 ? ` About <b>${fmtArea(dangerArea)}</b> is dangerous to wade through.` : ' Nowhere is dangerous to wade through.';
  return h(`div.verdict${area10 > 0 ? '.bad' : '.ok'}#resVerdict`, { html: txt });
}
function nextStepText() {
  if (!S.dyn) return `${icon('arrow', 13)} Next: change a surface (step 3), or run the full simulation for speed and danger (step 4).`;
  if (S.options.length < 2) return `${icon('arrow', 13)} Next: save this as an option and try a design change (step 5).`;
  return `${icon('arrow', 13)} Next: compare your options (step 5) or export (step 6).`;
}
function targetText(a) {
  return a > 0 ? `<span class="tgt bad">${icon('alert', 12)} Above Copenhagen's 10 cm goal</span>` : `<span class="tgt ok">${icon('check', 12)} Meets Copenhagen's 10 cm goal</span>`;
}

function stackBar(parts, total) {
  const bar = h('div.stack', { role: 'img', 'aria-label': parts.map((p) => `${p.l}: ${fmtVol(p.v)} cubic metres`).join(', ') });
  for (const p of parts) if (p.v > 0) bar.append(h('div.seg', { style: { width: `${(p.v / total) * 100}%`, background: p.c }, title: `${p.l}: ${fmtVol(p.v)} m³` }));
  const leg = h('div.stack-leg');
  for (const p of parts) leg.append(h('div', h('span.sw', { style: { background: p.c } }), h('span', p.l), h('b', `${fmtVol(p.v)} m³`), h('span.muted', `${Math.round((p.v / total) * 100)} %`)));
  return [bar, leg];
}
function balanceCard(st) {
  const lost = Math.max(0, st.rainVolumeM3 - st.effectiveVolumeM3);
  return h('div.card2', h('div.c-head', h('h4', 'Where the rain goes'), h('span.muted', `${fmtVol(st.rainVolumeM3)} m³ of rain`)),
    ...stackBar([
      { l: 'Taken by sewer, soil and surfaces', v: lost, c: '#3b4b63' },
      { l: 'Stands in ponds', v: st.storedVolumeM3, c: '#1F78C8' },
      { l: 'Runs off the site', v: st.outflowVolumeM3, c: '#7cc4f2' },
    ], st.rainVolumeM3));
}
function massCard(m, perm = null) {
  const total = m.rainM3 + (m.initialWaterM3 || 0);
  const err = Math.abs(m.errorFraction) * 100;
  // sub-bases (permeable paving, porous asphalt, rain gardens): their water is part of "soaked into the ground"
  const sub = perm && perm.subbaseCells > 0 ? h('div.c-foot.subbase', h('span',
    `Of the water soaked in: ${fmtVol(perm.subbaseStoredM3)} m³ still in sub-bases, ${fmtVol(perm.subbaseDrainedM3)} m³ drained to the subsoil. `,
    `Sub-base capacity ${fmtVol(perm.subbaseCapacityM3)} m³; `, h('b', `${fmtInt(perm.subbaseFullCells)} of ${fmtInt(perm.subbaseCells)}`), ' sub-base cells ran full.')) : null;
  return h('div.card2', h('div.c-head', h('h4', 'Where the rain went'), h('span.muted', `${fmtVol(m.rainM3)} m³ of rain`)),
    ...stackBar([
      { l: 'Wetted surfaces, filled hollows', v: m.initialLossM3, c: '#56657c' },
      { l: 'Soaked into the ground', v: m.infiltratedM3, c: '#5AAE61' },
      { l: 'Into the sewer', v: m.sewerM3, c: '#8b7fd6' },
      { l: 'Ran off the site edge', v: m.boundaryOutM3, c: '#7cc4f2' },
      { l: 'Still on site at the end', v: m.storedM3, c: '#1F78C8' },
    ], total),
    sub,
    h('div.c-foot', 'Book-keeping error ', h('b', err < 0.001 ? '< 0.001 %' : `${err.toFixed(3)} %`), help('massError')));
}

function bluespotCard() {
  const top = topBluespots(S.instant, 8);
  const tbl = h('table.bs');
  tbl.append(h('thead', h('tr', h('th', '#'), h('th.r', 'Volume'), h('th.r', 'Deepest'), h('th.r', 'Area'), h('th', 'Status'))));
  const tb = h('tbody');
  top.forEach((b, i) => {
    const tr = h('tr', { tabIndex: 0, onclick: () => zoomToBluespot(b, tr), onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); zoomToBluespot(b, tr); } }, title: 'Show this pond on the map' },
      h('td', h('span.rank', String(i + 1))), h('td.r', `${fmtVol(b.volumeM3)} m³`), h('td.r', fmtCm(b.maxDepthM)), h('td.r', fmtArea(b.areaM2)),
      h('td', b.spills ? h('span.pill.spill', 'full, overflows') : h('span.pill.fill', `${Math.round((b.volumeM3 / Math.max(1e-9, b.capacityM3)) * 100)} % full`)));
    tb.append(tr);
  });
  tbl.append(tb);
  return h('div.card2', h('div.c-head', h('h4', 'Largest ponds', help('bluespot')), h('span.muted', 'click a row to zoom')), top.length ? tbl : h('p.muted', 'No ponds above 1 m³. The water runs off or soaks in.'));
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
  const inp = h('input.num', { type: 'number', min: 0.1, max: 50, step: 0.1, value: R.dischargeLSHa, 'aria-label': 'Allowed discharge in litres per second per hectare' });
  inp.addEventListener('input', () => { const v = +String(inp.value).replace(',', '.'); if (v > 0) { R.dischargeLSHa = v; computeRetentionDebounced(); } });
  const det = h('details.card2.retention.advanced', { open: !!R.open, ontoggle: () => { R.open = det.open; } },
    h('summary.c-head', h('h4', 'Storage needed for a discharge limit'), h('span.chip.tiny', 'indicative')),
    h('p.step-note', TERMS.retention),
    h('div.ret-in',
      h('label', 'Allowed discharge to sewer', h('div.inwrap', inp, h('span', 'l/s per ha'))),
      h('label', 'Design storm for storage', segControl([5, 10, 20].map((v) => ({ v, html: `${v}-year` })), R.returnPeriod, (v) => { R.returnPeriod = v; computeRetention(); }, 'rp'))),
    h('div.ret-out#retOut'));
  return det;
}
function updateRetentionCard() {
  const el = $('#retOut'); const r = S.retention.result; if (!el || !r) return;
  el.innerHTML = '';
  el.append(h('div.big', h('span.num', fmtInt(r.requiredStorageM3)), h('span.unit', 'm³')),
    h('div.ret-sub', 'storage the site needs (box-rain method, safety factor 1.2)'),
    h('div.kv', h('span', 'Effective sealed area (C·A)'), h('b', `${fmtArea(r.reducedAreaM2)}  (average C ${r.meanC.toFixed(2)})`)),
    h('div.kv', h('span', 'Allowed outflow'), h('b', `${fmt1(r.outflowLS)} l/s`)),
    h('div.kv', h('span', 'Longest storm to store'), h('b', r.criticalDurationMin >= 120 ? `${fmt1(r.criticalDurationMin / 60)} h` : `${fmtInt(r.criticalDurationMin)} min`)));
}

// ------------------------------------------------------------------------------------------------ options & compare
function shortName(name) { const m = /[–-]\s*(.+)$/.exec(name); return (m ? m[1] : name).replace(/\s*\(.*\)/, '').trim(); }
/** What makes this design different from the site as drawn, in words. */
function designLabel() {
  const parts = Object.entries(S.surfaceSwap).map(([from, to]) => `${(mat(from) || { name: from }).name} → ${(mat(to) || { name: to }).name}`);
  if (S.groundMaterial) parts.push(`ground → ${(mat(S.groundMaterial) || { name: S.groundMaterial }).name}`);
  return parts.length ? parts.join(', ') : 'as drawn';
}

function snapshot(name, grid, sampleJson, inst, base, short = null) {
  return {
    id: Math.random().toString(36).slice(2), name, short: short || shortName(name), caption: captionText(),
    grid, base: base || baseCanvas(grid, S.info.palette), buildingsVec: sampleJson ? sampleJson.buildings : null,
    buildingsRaster: sampleJson ? null : buildingsCanvas(grid), depth: inst.depth, stats: inst.stats, bluespots: inst.bluespots, paths: inst.paths,
    report: reportOptionMeta(S, grid, sampleJson, { settingsKey }), // [report-hook] inputs/dynamic/retention for the PDF report
  };
}
function saveOption() {
  if (!S.instant) return;
  const letter = String.fromCharCode(65 + S.options.length);
  // The design difference first, so two options stay distinguishable when the name is cut short.
  const desc = `${designLabel()} · ${presetName(preset())}, ${SEWER[S.settings.sewerMode].label.toLowerCase()}${SEWER[S.settings.sewerMode].v ? ' sewer' : ''}`;
  S.options.push(snapshot(`Option ${letter}: ${desc}`, S.grid, S.sampleJson, S.instant, S.scene.base, `Option ${letter}`));
  toast(S.options.length === 1 ? 'Saved option A. Now change a surface or the rain, then save option B.' : `Saved option ${letter}. Ready to compare.`, 'ok');
  renderLeft(); updateResults();
  focusStep('compare');
}

async function comparePair() {
  const other = sampleInfo(S.site.info.compareWith); if (!other || !S.instant) return;
  const btn = $('#pairBtn'); if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Running the redesigned version…'; }
  try {
    const cur = snapshot(`${S.site.info.name}${Object.keys(S.surfaceSwap).length || S.groundMaterial ? ` (${designLabel()})` : ''}`, S.grid, S.sampleJson, S.instant, S.scene.base, shortName(S.site.info.name));
    const g2 = await S.cb.buildGrid({ sample: other.id }, gridSettings(S.grid.dx));
    const sj2 = await S.cb.sample(other.id);
    const r2 = await S.cb.runInstant(g2, scenarioInstant());
    S.cb.freeGrid(g2);
    const oth = snapshot(other.name, g2, sj2, r2);
    const beforeFirst = /before/.test(S.site.id) || !/before/.test(other.id);
    const [a, b] = beforeFirst ? [cur, oth] : [oth, cur];
    S.options = S.options.filter((o) => o.name !== a.name && o.name !== b.name).concat([a, b]);
    enterCompare(a, b, 'diff');
  } catch (e) { console.error(e); toast(`Could not compare: ${e.message}`, 'error'); renderLeft(); }
}

function enterCompare(a, b, mode = 'swipe') {
  if (!a || !b) return;
  if (S.view3d) toggle3D(false);
  stopPlay();
  S.compare = { a, b, mode };
  $('#firstRunHint').classList.add('hidden');
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
  $('#resTitle').textContent = 'A vs B'; $('#live').classList.add('hidden');
  const rows = [
    ['Area deeper than 10 cm', a.stats.areaOver10CmM2, b.stats.areaOver10CmM2, (v) => `${fmtInt(v)} m²`, true],
    ['Water standing in ponds', a.stats.storedVolumeM3, b.stats.storedVolumeM3, (v) => `${fmtVol(v)} m³`, true],
    ['Wet area', a.stats.floodedAreaM2, b.stats.floodedAreaM2, (v) => fmtArea(v), true],
    ['Deepest water', a.stats.maxDepthM, b.stats.maxDepthM, (v) => fmtCm(v), true],
    ['Runs off the site', a.stats.outflowVolumeM3, b.stats.outflowVolumeM3, (v) => `${fmtVol(v)} m³`, true],
    ['Ponds', a.stats.bluespotCount, b.stats.bluespotCount, (v) => fmtInt(v), false],
  ];
  const dv = b.stats.storedVolumeM3 - a.stats.storedVolumeM3, da = b.stats.areaOver10CmM2 - a.stats.areaOver10CmM2;
  const pct = (x, y) => (x > 0 ? Math.round(((y - x) / x) * 100) : 0);
  const dout = b.stats.outflowVolumeM3 - a.stats.outflowVolumeM3;
  const changes = [[da, `${fmtInt(Math.abs(da))} m² LESSMORE area deeper than 10 cm`, 1], [dv, `${fmtVol(Math.abs(dv))} m³ LESSMORE water standing in ponds`, 0.5], [dout, `${fmtVol(Math.abs(dout))} m³ LESSMORE water running off the site`, 0.5]]
    .filter(([d, , eps]) => Math.abs(d) > eps);
  const sign = Math.sign(changes.length ? changes[0][0] : 0);
  const words = changes.map(([d, t]) => t.replace('LESSMORE', d < 0 ? 'less' : 'more'));
  body.append(h(`div.verdict${!changes.length ? '' : sign < 0 ? '.ok' : '.bad'}#resVerdict`, { html: !changes.length
    ? 'B and A give practically the same result in the quick check. Try a bigger change, or run the full simulation for both.'
    : `Option B has ${words.join(', ').replace(/, ([^,]*)$/, ' and $1')}.` }));
  const sgn = (d, f) => (Math.abs(d) < 0.05 ? '±0' : `${d > 0 ? '+' : '−'}${f(Math.abs(d))}`);
  body.append(h('div.tiles',
    h(`div.tile${Math.abs(dv) < 0.5 ? '' : dv < 0 ? '.good' : '.hot'}`, h('div.t-label', 'Change in standing water'), h('div.t-val', h('span.num', sgn(dv, fmtVol)), h('span.unit', 'm³')), h('div.t-sub', `${pct(a.stats.storedVolumeM3, b.stats.storedVolumeM3)} % compared with A`)),
    h(`div.tile${Math.abs(da) < 1 ? '' : da < 0 ? '.good' : '.hot'}`, h('div.t-label', 'Change in area deeper than 10 cm'), h('div.t-val', h('span.num', sgn(da, fmtInt)), h('span.unit', 'm²')), h('div.t-sub', `${pct(a.stats.areaOver10CmM2, b.stats.areaOver10CmM2)} % compared with A`))));
  const tbl = h('table.cmp', h('thead', h('tr', h('th', ''), h('th.r', h('span.opt-letter.sm', 'A')), h('th.r', h('span.opt-letter.sm.b', 'B')), h('th.r', 'Change'))));
  const tb = h('tbody');
  for (const [l, x, y, f, lowerBetter] of rows) {
    const d = y - x; const cls = Math.abs(d) < 1e-6 ? '' : (d < 0) === lowerBetter ? 'down' : 'up';
    tb.append(h('tr', h('td', l), h('td.r', f(x)), h('td.r', f(y)), h(`td.r.${cls || 'eq'}`, Math.abs(d) < 1e-6 ? '–' : `${d > 0 ? '+' : '−'}${f(Math.abs(d))}`)));
  }
  tbl.append(tb);
  body.append(h('div.card2', h('div.c-head', h('h4', 'Numbers side by side'), h('span.muted', 'quick check, same rain')),
    h('div.cmp-names', h('div', h('span.opt-letter.sm', 'A'), h('span', a.name)), h('div', h('span.opt-letter.sm.b', 'B'), h('span', b.name))), tbl,
    h('p.step-note', 'Green: better in B. Red: worse in B.')));
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
  const r = LAYERS[S.layer].ramp; return { title: ($('#legend .lg-title > span')?.textContent || `${r.title} (${r.unit})`).trim(), ramp: r };
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
  const tmA = S.compare ? null : terrainInfo();
  if (tmA && tmA.attribution.length) { ctx.font = '500 14px Inter, system-ui, sans-serif'; ctx.fillStyle = '#8fa6c2'; ctx.fillText(`Data: ${tmA.attribution.join(' · ')}`.slice(0, 220), 40, y + 106); }
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

// ------------------------------------------------------------------------------------------------ first-run hint
/** A one-time, dismissible note over the map explaining what is on screen. Never blocks the map. */
function showFirstRunHint() {
  const el = $('#firstRunHint');
  if (!el || el.dataset.shown || store.get(LS_HINT) || S.compare) return;
  el.dataset.shown = '1'; el.innerHTML = '';
  const close = () => { el.classList.add('hidden'); store.set(LS_HINT, '1'); };
  el.append(
    h('div.fh-txt',
      h('b', 'This is where the rain goes.'),
      h('span', ' Blue areas are ponds: low spots where water collects in this storm. Blue lines show where it runs. Hover the map to read depths.'),
      h('span.fh-next', ' Try: pick another rain (step 2) or change a surface (step 3).')),
    h('button.btn.ghost.small', { onclick: close }, 'Got it'));
  el.classList.remove('hidden');
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
