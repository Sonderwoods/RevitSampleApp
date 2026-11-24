// Terrain / context source registry: metadata for every source, one fetch API, and the step that turns any raster
// into the terrain the engine gets (reproject → aggregate → exact-alignment GeoTIFF). UI-free; see docs/map-sources.md.
//
//   listSources({lat, lon})                    → sources with metadata, filtered to those covering the point
//   suitability(sourceOrId, {cellSize, nativeResM})  → {level: good|fair|poor|unsuitable, label, message}
//   fetchTerrain(id, {lat, lon, sizeM, ...})   → {bytes (GeoTIFF), raster, info}   (bytes can go straight to the app)
//   readTerrainFile(fileOrBytes, {name})       → raster (GeoTIFF / BigTIFF / COG, Esri ASCII .asc, XYZ)
//   fetchOsmContext(info|raster)              → {buildings, surfaces, bridgeCuts, stats}
//   prepareSiteDesc(siteDesc, info?)          → engine site description (the app.js hook in loadGrid)

import { readGeoTiff, writeGeoTiff, BlobSource, BytesSource } from './tiff.js';
import { parseAsciiGrid, parseXyz } from './textgrid.js';
import { crsFromEpsg, analysisCrsFor, squareBbox, bboxToLatLon } from './proj.js';
import { aggregate, reproject, targetGrid, engineRaster, mosaic, stats } from './gridops.js';
import { fetchDhmTiles, hasProxy } from './dhm.js';
import { fetchTerrarium } from './terrarium.js';
import { fetchCopernicus, COPERNICUS_BASE } from './copernicus.js';
import { fetchOverpass, osmToSite, OSM_ATTRIBUTION } from './osm.js';

/** Grid cell sizes the app tries, and its cell cap (keep in sync with loadGrid in app.js). */
export const CELL_SIZES = [1, 2, 4, 8];
export const MAX_CELLS = 900000;

/**
 * Every source. `status` says how it was verified: 'live' = data seen coming back from the real service during
 * development; 'fixtures' = tested only against synthetic files / recorded responses; 'docs' = coded against the
 * provider's documentation only. Keep these honest.
 */
export const SOURCES = [
  {
    id: 'dk-dhm', kind: 'terrain', name: 'Danmarks Højdemodel – DHM/Terræn', provider: 'Klimadatastyrelsen (formerly SDFI) via Datafordeler / Dataforsyningen',
    coverage: 'Denmark', region: { south: 54.4, west: 7.9, north: 57.9, east: 15.3 }, nativeResM: 0.4, verticalAccuracyM: 0.05,
    model: 'DTM', hydroConditioned: false, crs: 'EPSG:25832 (ETRS89 / UTM 32N)', verticalDatum: 'DVR90',
    licence: 'Free Danish geodata terms – attribution required', attribution: 'Contains data from Klimadatastyrelsen (formerly SDFI), Danmarks Højdemodel – DHM/Terræn',
    licenceUrl: 'https://sdfi.dk/data-om-danmark/vilkaar-for-data', keyRequired: true, keyHelp: 'Free Datafordeler API key (portal.datafordeler.dk) or Dataforsyningen token.',
    browser: 'via local relay or desktop app (CORS not guaranteed)', status: 'docs',
    note: 'The right product for Danish screening. Buildings are removed (add them from OSM or the CAD model) and bridge decks are kept (cut them out, IN-4). A hydrologically adapted variant may be offered by the service: use "List products".',
  },
  {
    id: 'upload', kind: 'terrain', name: 'Your own file (GeoTIFF / ASCII grid / XYZ)', provider: 'Local file – nothing is uploaded anywhere',
    coverage: 'Anywhere', region: null, nativeResM: null, verticalAccuracyM: null, model: 'as supplied', hydroConditioned: null,
    crs: 'from the file (GeoTIFF keys or .prj); lat/lon and Web Mercator are reprojected to UTM', verticalDatum: 'as supplied',
    licence: 'Yours / the data owner\'s', attribution: '', keyRequired: false, browser: 'works offline', status: 'fixtures',
    note: 'Best option outside Denmark: national LiDAR DTMs (Norway hoydedata.no, Sweden Lantmäteriet, Finland NLS, Netherlands AHN, England EA, …) downloaded as GeoTIFF or .asc.',
  },
  {
    id: 'terrain-tiles', kind: 'terrain', name: 'AWS Terrain Tiles (Mapzen / Tilezen)', provider: 'AWS Open Data – elevation-tiles-prod',
    coverage: 'Global', region: null, nativeResM: 30, nativeResNote: 'mosaic: 25–30 m in most of Europe (EU-DEM / SRTM), 2–10 m in a few countries; reported per download',
    verticalAccuracyM: 7, model: 'DTM-ish (SRTM/EU-DEM are partly surface models)', hydroConditioned: false, crs: 'Web Mercator tiles → reprojected to local UTM',
    verticalDatum: 'mixed, mostly EGM96 geoid', licence: 'Mixed open licences of the source datasets – attribution required',
    attribution: 'Terrain Tiles (Mapzen/Tilezen, AWS Open Data): SRTM, GMTED2010 & 3DEP courtesy USGS; EU-DEM produced using Copernicus data; ETOPO1 NOAA; and national datasets',
    licenceUrl: 'https://github.com/tilezen/joerd/blob/master/docs/attribution.md', keyRequired: false, browser: 'yes (CORS)', status: 'live',
    note: 'A regional overview only. At 25–30 m every street, kerb and courtyard is invisible: do NOT use it for site-scale cloudburst screening.',
  },
  {
    id: 'copernicus-glo30', kind: 'terrain', name: 'Copernicus DEM GLO-30', provider: 'ESA / Airbus via AWS Open Data (copernicus-dem-30m)',
    coverage: 'Global', region: null, nativeResM: 30, verticalAccuracyM: 4, model: 'DSM (buildings and trees partly included)', hydroConditioned: false,
    crs: 'EPSG:4326 → reprojected to local UTM', verticalDatum: 'EGM2008 geoid',
    licence: 'Copernicus DEM licence (free, attribution required)', attribution: '© DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA; all rights reserved',
    licenceUrl: 'https://spacedata.copernicus.eu/documents/20123/121286/CSCDA_ESA_Mission-specific+Annex_31_Oct_22.pdf', keyRequired: false,
    browser: 'only via the local relay (serve.py) or desktop app – the bucket has no CORS', status: 'live',
    note: 'Regional overview / sanity check only. 30 m posting and a surface model: unsuitable for site-scale screening.',
  },
  {
    id: 'osm', kind: 'context', name: 'OpenStreetMap buildings, land cover and bridges', provider: 'Overpass API (overpass-api.de, fallback kumi.systems)',
    coverage: 'Global (quality varies)', region: null, nativeResM: null, model: 'vector', crs: 'WGS84 → terrain CRS',
    licence: 'ODbL 1.0 – attribution; share-alike for derived databases', attribution: OSM_ATTRIBUTION, licenceUrl: 'https://www.openstreetmap.org/copyright',
    keyRequired: false, browser: 'yes (CORS), or via the local relay', status: 'fixtures',
    note: 'Footprints block water; landuse/roads set the surface material (permeability). Unmapped private gardens and yards keep the default material.',
  },
];

/** Candidate sources reviewed but NOT implemented (documented in docs/map-sources.md). */
export const CANDIDATES = [
  { name: 'Norway – Kartverket hoydedata (NHM DTM 1 m)', note: 'Keyless WCS; CORS and coverage ids unverified (host blocked in development). Download a GeoTIFF from hoydedata.no and upload it meanwhile.' },
  { name: 'Netherlands – AHN4 0.5 m DTM (PDOK WCS)', note: 'Keyless; not reachable from the development sandbox.' },
  { name: 'England – EA LiDAR composite DTM 1 m', note: 'Keyless WCS; not reachable from the development sandbox.' },
  { name: 'Sweden – Lantmäteriet Markhöjdmodell 1 m', note: 'Needs an API key / agreement.' },
  { name: 'Denmark – GeoDanmark / BBR buildings', note: 'Authoritative footprints and roof data; needs the same Datafordeler key. OSM is used instead.' },
  { name: 'OpenTopography global DEM API', note: 'Needs a free API key; same 30 m data as Copernicus.' },
];

export const getSource = (id) => SOURCES.find((s) => s.id === id) || null;

const inRegion = (r, lat, lon) => !r || (lat >= r.south && lat <= r.north && lon >= r.west && lon <= r.east);

/** Sources (metadata objects), optionally only those covering lat/lon. */
export function listSources({ lat, lon, kind } = {}) {
  return SOURCES.filter((s) => (!kind || s.kind === kind) && (lat == null || inRegion(s.region, lat, lon)));
}

/** How fit a terrain is for site-scale cloudburst screening. */
export function suitability(src, { cellSize = 1, nativeResM } = {}) {
  const s = typeof src === 'string' ? getSource(src) : src;
  const res = nativeResM ?? (s && s.nativeResM);
  const dsm = s && /DSM/.test(s.model || '');
  let level, message;
  if (res == null) { level = 'fair'; message = 'Resolution unknown – check that the file is a bare-earth terrain model (DTM) of 2 m or finer.'; }
  else if (res <= 1) { level = 'good'; message = `Native ${res} m: kerbs, gutters and courtyards can be resolved.`; }
  else if (res <= 2.5) { level = 'fair'; message = `Native ${res} m: streets and blocks are resolved, kerbs and gutters are not – stamp them as walls/channels.`; }
  else if (res <= 10) { level = 'poor'; message = `Native ${res} m: only the broad catchment shape is right. Flow paths along streets and bluespots in courtyards are not reliable.`; }
  else { level = 'unsuitable'; message = `Native ${res} m: NOT adequate for site-scale cloudburst screening. Use it only for a regional overview; get a ≤ 1 m LiDAR terrain for the site.`; }
  if (dsm) { message += ' It is a surface model (buildings/trees partly included), so flow paths are distorted.'; if (level === 'good' || level === 'fair') level = 'poor'; }
  if (res != null && cellSize < res / 2) message += ` The ${cellSize} m grid only interpolates between ${res} m samples – it adds no detail.`;
  const label = { good: 'Good for site screening', fair: 'Usable with care', poor: 'Overview only', unsuitable: 'Not suitable for site screening' }[level];
  return { level, label, message };
}

/** Attribution lines for a set of source ids (for captions and reports). */
export function attributionFor(ids) {
  return [...new Set(ids)].map(getSource).filter((s) => s && s.attribution).map((s) => s.attribution);
}

// ------------------------------------------------------------------------------------------------ reading files

/** Read a terrain file: GeoTIFF/BigTIFF (by magic bytes), otherwise Esri ASCII grid or XYZ text. */
export async function readTerrainFile(input, { name = '', epsg = 0, maxPixels, clipToMax = true } = {}) {
  const isBlob = typeof Blob !== 'undefined' && input instanceof Blob;
  const src = isBlob ? new BlobSource(input) : new BytesSource(input);
  const head = await src.read(0, 4);
  if ((head[0] === 0x49 && head[1] === 0x49) || (head[0] === 0x4d && head[1] === 0x4d)) {
    const r = await readGeoTiff(src, { maxPixels, clipToMax });
    if (epsg && !r.epsg) r.epsg = epsg;
    return r;
  }
  const bytes = isBlob ? new Uint8Array(await input.arrayBuffer()) : (input instanceof Uint8Array ? input : new Uint8Array(input));
  if (bytes.length > 600e6) throw new Error('Text terrain files over 600 MB are not supported – convert to GeoTIFF.');
  const text = new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.length, 2000)));
  if (/^\s*ncols\b/im.test(text)) return parseAsciiGrid(bytes, { epsg });
  if (/^\s*-?\d+(\.\d+)?[\s,;]+-?\d+(\.\d+)?[\s,;]+-?\d+/m.test(text)) return parseXyz(bytes, { epsg });
  throw new Error(`${name || 'File'}: not a GeoTIFF, Esri ASCII grid or XYZ file. LAS/LAZ point clouds must be gridded first (e.g. PDAL or CloudCompare → GeoTIFF).`);
}

// ------------------------------------------------------------------------------------------------ fetching

/** Native resolution in metres of a raster (degrees converted at its centre latitude). */
export function nativeResM(r) {
  if (r.kind === 'geographic') { const lat = r.yTop - (r.height * r.dy) / 2; return Math.round(Math.max(r.dy * 111320, r.dx * 111320 * Math.cos((lat * Math.PI) / 180)) * 10) / 10; }
  if (r.epsg === 3857) { const ll = crsFromEpsg(3857).toLatLon(r.x0, r.yTop); return Math.round(r.dx * Math.cos((ll.lat * Math.PI) / 180) * 10) / 10; }
  return Math.round(Math.max(r.dx, r.dy) * 1000) / 1000;
}

/**
 * Fetch terrain for a square of `sizeM` around lat/lon from source `id`.
 * opts: {provider, key, res, coverage} for dk-dhm; {fetchFn} for tests; onProgress(text).
 * Returns {bytes: GeoTIFF in the analysis CRS, raster, info} where info is a sample-like object the app understands
 * plus {sourceId, epsg, bbox, attribution, suitability, nativeResM, warnings}.
 */
export async function fetchTerrain(id, { lat, lon, sizeM = 400, name = '', onProgress, fetchFn, ...opts } = {}) {
  const src = getSource(id); if (!src || src.kind !== 'terrain' || id === 'upload') throw new Error(`Unknown terrain source "${id}".`);
  const crs = id === 'dk-dhm' ? crsFromEpsg(25832) : analysisCrsFor(lat, lon);
  const bbox = squareBbox(lat, lon, sizeM, crs, 8);
  const bbLL = bboxToLatLon(bbox, crs);
  const pad = 0.0005; // degrees, so interpolation at the edges has data
  const bbPad = { south: bbLL.south - pad, west: bbLL.west - pad, north: bbLL.north + pad, east: bbLL.east + pad };
  let raster, extra = {};
  const say = (t) => onProgress && onProgress(t);
  if (id === 'dk-dhm') {
    say('Downloading DHM…');
    const res = opts.res || 0.4;
    const tiles = await fetchDhmTiles(bbox, { provider: opts.provider, key: opts.key, res, coverage: opts.coverage || 'dhm_terraen', fetchFn, onProgress: (d, n) => say(`Downloading DHM tile ${d}/${n}…`) });
    const parts = [];
    for (const t of tiles) parts.push(await readGeoTiff(t.bytes));
    raster = mosaic(parts);
    if (!raster.epsg) raster.epsg = 25832;
    extra = { coverage: opts.coverage || 'dhm_terraen', requestedResM: res };
  } else if (id === 'terrain-tiles') {
    say('Downloading Terrain Tiles…');
    raster = await fetchTerrarium(bbPad, { targetResM: 5, fetchFn, onProgress: (d, n) => say(`Terrain tile ${d}/${n}…`) });
    extra = { datasets: raster.meta.datasets, zoom: raster.meta.zoom };
  } else if (id === 'copernicus-glo30') {
    say('Downloading Copernicus DEM…');
    const base = !fetchFn && typeof window !== 'undefined' && !window.__TAURI__ && await hasProxy() ? 'proxy/copernicus' : COPERNICUS_BASE;
    raster = await fetchCopernicus(bbPad, { base, fetchFn });
  }
  const nres = id === 'terrain-tiles' && raster.meta.bestNativeResM ? raster.meta.bestNativeResM : (id === 'dk-dhm' ? Math.max(0.4, opts.res || 0.4) : (src.nativeResM ?? nativeResM(raster)));
  // Deliver everything in the analysis CRS at a sensible pixel size: reproject now (the result is a plain metric GeoTIFF).
  let out = raster;
  if (raster.epsg !== crs.epsg) {
    say('Reprojecting…');
    const d = Math.max(1, Math.min(8, Math.pow(2, Math.round(Math.log2(Math.max(1, Math.min(nres, sizeM / 400)))))));
    const t = { x0: bbox[0], y0: bbox[1], nx: Math.round((bbox[2] - bbox[0]) / d), ny: Math.round((bbox[3] - bbox[1]) / d), d };
    const vals = reproject(raster, crsFromEpsg(raster.epsg), t, crs);
    out = southUpToRaster(t, vals, crs.epsg);
    out.warnings = raster.warnings || [];
  }
  const st = stats(out.data);
  if (st.valid === 0) throw new Error('The source returned no valid heights for this area (outside its coverage, or all no-data).');
  const warnings = [...(out.warnings || [])];
  if (st.nodataFraction > 0.02) warnings.push(`${(st.nodataFraction * 100).toFixed(0)} % of the area has no data (sea, voids or outside coverage); those cells are inactive.`);
  const suit = suitability(src, { nativeResM: nres });
  const label = name || `Site at ${lat.toFixed(4)}°, ${lon.toFixed(4)}°`;
  const info = {
    id: 'custom', name: label, kind: 'custom', rainPreset: 1, bbox: bbox.map(Math.round), dhmFile: null, compareWith: null,
    description: `${src.name}, ${sizeM} × ${sizeM} m around ${lat.toFixed(5)}°, ${lon.toFixed(5)}° (${crs.name}). ${suit.label}: native ${nres} m.`,
    sourceId: id, epsg: crs.epsg, crsName: crs.name, center: { lat, lon }, sizeM, nativeResM: nres, suitability: suit,
    attribution: attributionFor([id]), warnings, verticalDatum: raster.verticalCrs || src.verticalDatum, ...extra,
  };
  const bytes = writeGeoTiff({ ...out, epsg: crs.epsg });
  attachContext(bytes, { info });
  return { bytes, raster: out, info };
}

function southUpToRaster(t, vals, epsg) {
  const { nx, ny, d } = t; const data = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++) data.set(vals.subarray(j * nx, (j + 1) * nx), (ny - 1 - j) * nx);
  return { width: nx, height: ny, data, x0: t.x0, yTop: t.y0 + ny * d, dx: d, dy: d, epsg, kind: 'projected' };
}

/** Buildings / land cover / bridges from OSM for a terrain (info from fetchTerrain, or a raster with a known CRS). */
export async function fetchOsmContext(infoOrRaster, { fetchFn } = {}) {
  let crs, bbox;
  if (infoOrRaster.bbox && infoOrRaster.epsg) { crs = crsFromEpsg(infoOrRaster.epsg); bbox = infoOrRaster.bbox; }
  else { const r = infoOrRaster; crs = crsFromEpsg(r.epsg); bbox = [r.x0, r.yTop - r.height * r.dy, r.x0 + r.width * r.dx, r.yTop]; }
  if (!crs || crs.kind !== 'projected' || crs.notMetric) throw new Error('The terrain has no known metric CRS, so OpenStreetMap data cannot be placed on it.');
  const ll = bboxToLatLon(bbox, crs);
  const useProxy = !fetchFn && await hasProxy();
  const json = await fetchOverpass(ll, { fetchFn, useProxy });
  return { ...osmToSite(json, (la, lo) => crs.fromLatLon(la, lo), bbox), attribution: OSM_ATTRIBUTION };
}

// ------------------------------------------------------------------------------------------------ app hook

const contexts = new WeakMap();
/** Remember extra context (info, OSM layers) for a terrain byte array, so it survives the app's {terrainBytes} hand-over. */
export function attachContext(bytes, ctx) { if (bytes && typeof bytes === 'object') contexts.set(bytes, { ...(contexts.get(bytes) || {}), ...ctx }); }
export function contextOf(bytes) { return (bytes && contexts.get(bytes)) || null; }

/** Smallest of CELL_SIZES whose grid stays under MAX_CELLS (the same rule as app.js loadGrid). */
export function chooseCellSize(widthM, heightM, { sizes = CELL_SIZES, maxCells = MAX_CELLS } = {}) {
  for (const d of sizes) if (Math.ceil(widthM / d) * Math.ceil(heightM / d) <= maxCells) return d;
  return sizes[sizes.length - 1];
}

/**
 * Prepare terrain for the engine: decode, reproject (geographic / Web Mercator → UTM), aggregate to the grid cell
 * size with `method`, and encode so the engine's cells receive exactly these values.
 * Returns {bytes, grid: {x0, y0, nx, ny, d}, values, epsg, crs, cellSize, method, nativeResM, warnings, stats}.
 */
export async function prepareTerrain(input, { name = '', method = 'mean', cellSize, bbox = null, maxCells = MAX_CELLS, nativeResM: knownRes = null } = {}) {
  const r = input && input.data && input.width ? input : await readTerrainFile(input, { name });
  const warnings = [...(r.warnings || [])];
  let crs = crsFromEpsg(r.epsg);
  let work = r, workCrs = crs;
  if (r.kind === 'geographic' || (crs && crs.notMetric)) {
    const from = crs || crsFromEpsg(4326);
    const c = from.toLatLon(r.x0 + (r.width * r.dx) / 2, r.yTop - (r.height * r.dy) / 2);
    workCrs = analysisCrsFor(c.lat, c.lon);
    const bb = [Infinity, Infinity, -Infinity, -Infinity];
    for (const [x, y] of [[r.x0, r.yTop], [r.x0 + r.width * r.dx, r.yTop], [r.x0, r.yTop - r.height * r.dy], [r.x0 + r.width * r.dx, r.yTop - r.height * r.dy]]) {
      const ll = from.toLatLon(x, y); const p = workCrs.fromLatLon(ll.lat, ll.lon);
      bb[0] = Math.min(bb[0], p.E); bb[1] = Math.min(bb[1], p.N); bb[2] = Math.max(bb[2], p.E); bb[3] = Math.max(bb[3], p.N);
    }
    const nres = nativeResM(r);
    const d = cellSize || chooseCellSize(bb[2] - bb[0], bb[3] - bb[1], { maxCells });
    // shrink inward by one source pixel so no edge cell straddles the (rotated) source boundary
    const inset = nres;
    const t = { x0: Math.ceil((bb[0] + inset) / d) * d, y0: Math.ceil((bb[1] + inset) / d) * d, d, nx: 0, ny: 0 };
    t.nx = Math.floor((bb[2] - inset - t.x0) / d); t.ny = Math.floor((bb[3] - inset - t.y0) / d);
    if (t.nx < 2 || t.ny < 2) throw new Error('Terrain area is too small.');
    const vals = reproject(r, from, t, workCrs);
    warnings.push(`Reprojected from ${from.name} to ${workCrs.name}.`);
    return finish(t, vals, workCrs, nres, 'reproject (bilinear)');
  }
  if (!crs && r.epsg) warnings.push(`CRS EPSG:${r.epsg} is not one this app can place on a map (it is used as-is, in its own metres).`);
  if (!r.epsg && r.kind !== 'geographic') warnings.push('The file has no CRS: coordinates are used as metres; the site cannot be placed on a map or combined with OpenStreetMap data.');
  const nres = nativeResM(r);
  let t = null;
  for (const d of cellSize ? [cellSize] : CELL_SIZES) { t = targetGrid(work, d, bbox); if (t.nx * t.ny <= maxCells) break; }
  const vals = aggregate(work, t, method);
  return finish(t, vals, workCrs, nres, method);

  function finish(t, vals, c, nres2, how) {
    const st = stats(vals);
    if (!st.valid) throw new Error('The terrain has no valid heights (all no-data).');
    if (st.nodataFraction > 0.02) warnings.push(`${(st.nodataFraction * 100).toFixed(0)} % of the grid has no terrain data; those cells are inactive.`);
    const realRes = knownRes || nres2;
    if (realRes > t.d * 1.5) warnings.push(`Terrain data (${realRes} m) is coarser than the ${t.d} m grid: values between samples are interpolated, not measured.`);
    const epsg = c ? c.epsg : r.epsg || 0;
    const bytes = writeGeoTiff(engineRaster(t, vals, epsg));
    return { bytes, grid: t, values: vals, epsg, crs: c, cellSize: t.d, method: how, nativeResM: knownRes || nres2, warnings: [...new Set(warnings)], stats: st, verticalDatum: r.verticalCrs || null };
  }
}

/**
 * The app hook: turn {terrainBytes} into the engine description. Keeps any other fields (buildings, surfaces, …),
 * adds OSM buildings/surfaces/bridge cuts when they were attached to the bytes (picker), and returns
 * {terrainBytes, prepared, buildings?, surfaces?, bridgeCuts?}. Build the grid with cellSize = prepared.cellSize.
 */
export async function prepareSiteDesc(siteDesc, info = null) {
  if (!siteDesc || !siteDesc.terrainBytes || siteDesc.prepared) return siteDesc;
  const ctx = contextOf(siteDesc.terrainBytes) || {};
  // Bytes we produced ourselves (the app rebuilds {terrainBytes} after design changes): never re-aggregate them.
  if (ctx.preparedDesc) return { ...ctx.preparedDesc, ...siteDesc, prepared: ctx.preparedDesc.prepared };
  const inf = ctx.info || info || {};
  const p = await prepareTerrain(siteDesc.terrainBytes, { method: (inf.terrainOptions && inf.terrainOptions.method) || 'mean', name: inf.name, nativeResM: inf.nativeResM || null });
  // `prepared` travels to the engine worker with the description, so it must be plain, cloneable data (no functions).
  const out = { ...siteDesc, terrainBytes: p.bytes, prepared: { ...p, bytes: undefined, values: undefined, crs: p.crs ? { epsg: p.crs.epsg, name: p.crs.name } : null, sourceId: inf.sourceId || 'upload', attribution: [...(inf.attribution || []), ...(ctx.osm ? [ctx.osm.attribution] : [])], suitability: suitability(getSource(inf.sourceId || 'upload'), { cellSize: p.cellSize, nativeResM: inf.nativeResM ?? p.nativeResM }) } };
  if (ctx.osm) {
    out.buildings = [...(siteDesc.buildings || []), ...ctx.osm.buildings];
    out.surfaces = [...(siteDesc.surfaces || []), ...ctx.osm.surfaces];
    out.bridgeCuts = [...(siteDesc.bridgeCuts || []), ...ctx.osm.bridgeCuts];
    out.prepared.osm = ctx.osm.stats;
  }
  attachContext(p.bytes, { preparedDesc: out });
  return out;
}
