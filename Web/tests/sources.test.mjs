// node --test Web/tests/            (fixtures: python3 tools/make_terrain_fixtures.py → samples/fixtures/)
// Offline tests of the terrain / context import modules in Web/js/sources/. No network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readGeoTiff, writeGeoTiff, HttpRangeSource } from '../js/sources/tiff.js';
import { parseAsciiGrid, parseXyz, epsgFromPrj } from '../js/sources/textgrid.js';
import { tmForward, tmInverse, crsFromEpsg, analysisCrsFor, squareBbox } from '../js/sources/proj.js';
import { aggregate, targetGrid, engineRaster, mosaic, reproject, sampleBilinear } from '../js/sources/gridops.js';
import { snapDhmBbox, dhmTiles, parseWcsCapabilities, fetchDhmTiles } from '../js/sources/dhm.js';
import { decodePng, describeImagerySources, fetchTerrarium } from '../js/sources/terrarium.js';
import { osmToSite, keyhole, clipRing, areaMaterial, buildingHeight } from '../js/sources/osm.js';
import { prepareTerrain, prepareSiteDesc, suitability, listSources, SOURCES, readTerrainFile, attachContext, fetchTerrain } from '../js/sources/registry.js';
import { latLonToUtm32 } from '../js/dhm.js';
import { utm32ToLatLon } from '../js/util.js';
import { CloudburstEngine } from '../engine/cloudburst-wasm.js';

const FIX = fileURLToPath(new URL('../../samples/fixtures/', import.meta.url));
const fx = (n) => new Uint8Array(readFileSync(FIX + n));
const W = 37, H = 23, X0 = 724410, YTOP = 6179430, DX = 0.4;
const z = (c, r) => 10 + 0.1 * c - 0.05 * r;
const near = (a, b, tol = 1e-4, msg = '') => assert.ok(Math.abs(a - b) <= tol, `${msg} ${a} vs ${b}`);

// ------------------------------------------------------------------------------------------------ GeoTIFF variants
function checkStandard(r, name, { tolZ = 1e-4 } = {}) {
  assert.equal(r.width, W, name); assert.equal(r.height, H, name);
  near(r.x0, X0, 1e-6, `${name} x0`); near(r.yTop, YTOP, 1e-6, `${name} yTop`); near(r.dx, DX, 1e-9, `${name} dx`);
  for (const [c, rr] of [[0, 0], [7, 5], [36, 22], [20, 0], [0, 22], [17, 16]]) near(r.data[rr * W + c], z(c, rr), tolZ, `${name} z(${c},${rr})`);
  assert.ok(Number.isNaN(r.data[2 * W + 3]), `${name} nodata pixel`);
}

test('GeoTIFF: uncompressed float32 strips, LE, GDAL_NODATA, EPSG + DVR90 keys', async () => {
  const r = await readGeoTiff(fx('strip_f32_le.tif'));
  checkStandard(r, 'strip');
  assert.equal(r.epsg, 25832); assert.equal(r.kind, 'projected'); assert.equal(r.verticalCrs, 'DVR90');
});
test('GeoTIFF: tiled, Deflate + floating-point predictor, big-endian, PixelIsPoint', async () => {
  const r = await readGeoTiff(fx('tiled_deflate_pred3_be.tif'));
  checkStandard(r, 'tiled-pred3-be');
  assert.equal(r.meta.pixelIsPoint, true); assert.equal(r.meta.tiled, true); assert.equal(r.meta.littleEndian, false);
});
test('GeoTIFF: int16 + horizontal predictor + Deflate, geographic CRS, nodata -32768', async () => {
  const r = await readGeoTiff(fx('int16_pred2_deflate_geographic.tif'));
  assert.equal(r.epsg, 4326); assert.equal(r.kind, 'geographic');
  for (const [c, rr] of [[0, 0], [7, 5], [36, 22]]) near(r.data[rr * W + c], z(c, rr) * 10, 0.5); // Python rounds half to even
  assert.ok(Number.isNaN(r.data[2 * W + 3]));
  near(r.dx, 1 / 3600, 1e-12);
});
test('GeoTIFF: BigTIFF, tiled, PackBits, float64', async () => {
  const r = await readGeoTiff(fx('bigtiff_tiled_packbits_f64.tif'));
  checkStandard(r, 'bigtiff'); assert.equal(r.meta.bigTiff, true);
});
test('GeoTIFF: LZW written by libtiff (Pillow)', async () => {
  const r = await readGeoTiff(fx('pillow_lzw_f32.tif'));
  checkStandard(r, 'lzw'); assert.equal(r.meta.compression, 5);
});
test('GeoTIFF: planar configuration 2 and chunky 2-band (band 1 used), heuristic nodata', async () => {
  const p = await readGeoTiff(fx('planar2_f32.tif')); checkStandard(p, 'planar2');
  const c = await readGeoTiff(fx('chunky2_deflate_f32.tif')); checkStandard(c, 'chunky2');
  assert.ok(c.warnings.some((w) => /no NoData tag/.test(w)));
});
test('GeoTIFF: ModelTransformation, south-up rows, feet → metres', async () => {
  const r = await readGeoTiff(fx('feet_transform_southup.tif'));
  near(r.x0, X0, 1e-6); near(r.yTop, YTOP, 1e-6); near(r.dx, DX, 1e-9);
  for (const [c, rr] of [[0, 0], [7, 5], [36, 22]]) near(r.data[rr * W + c], z(c, rr), 1e-4);
  assert.ok(Number.isNaN(r.data[(H - 3) * W + 3]), 'nodata pixel flipped with the rows');
});
test('GeoTIFF: bbox window reads only the overlapping part', async () => {
  const r = await readGeoTiff(fx('tiled_deflate_pred3_be.tif'), { bbox: [X0 + 4, YTOP - 4, X0 + 8, YTOP - 2] });
  assert.ok(r.width < W && r.height < H);
  const c = Math.round((r.x0 - X0) / DX), rr = Math.round((YTOP - r.yTop) / DX);
  near(r.data[0], z(c, rr));
});
test('GeoTIFF: size limit and clear errors', async () => {
  await assert.rejects(readGeoTiff(fx('strip_f32_le.tif'), { maxPixels: 100 }), /pixel limit/);
  const r = await readGeoTiff(fx('strip_f32_le.tif'), { maxPixels: 100, clipToMax: true });
  assert.ok(r.width * r.height <= 100 && r.warnings.some((w) => /central/.test(w)));
  const jpeg = fx('strip_f32_le.tif').slice(); // patch Compression=1 → 7 (JPEG)
  const dv = new DataView(jpeg.buffer); const ifd = dv.getUint32(4, true); const n = dv.getUint16(ifd, true);
  for (let e = 0; e < n; e++) if (dv.getUint16(ifd + 2 + e * 12, true) === 259) dv.setUint16(ifd + 2 + e * 12 + 8, 7, true);
  await assert.rejects(readGeoTiff(jpeg), /JPEG.*not supported/);
  await assert.rejects(readGeoTiff(new TextEncoder().encode('<html>Unauthorized</html>')), /Not a TIFF/);
});
test('GeoTIFF writer round-trips (and is readable by the reader)', async () => {
  const data = new Float32Array(6 * 4).map((_, k) => k * 0.5); data[5] = NaN;
  const r = await readGeoTiff(writeGeoTiff({ width: 6, height: 4, data, x0: 100, yTop: 200, dx: 2, dy: 2, epsg: 25833 }));
  assert.equal(r.epsg, 25833); near(r.x0, 100); near(r.yTop, 200); assert.ok(Number.isNaN(r.data[5])); near(r.data[23], 11.5);
});
test('HttpRangeSource reads a COG-style file through Range requests', async () => {
  const bytes = fx('tiled_deflate_pred3_be.tif'); let calls = 0;
  const fetchFn = async (url, { headers }) => {
    calls++; const m = /bytes=(\d+)-(\d+)/.exec(headers.Range); const s = +m[1], e = Math.min(bytes.length - 1, +m[2]);
    const body = bytes.slice(s, e + 1);
    return { status: 206, headers: new Map([['Content-Range', `bytes ${s}-${e}/${bytes.length}`]]), arrayBuffer: async () => body.buffer };
  };
  const r = await readGeoTiff(new HttpRangeSource('x', { fetchFn, block: 256 }));
  checkStandard(r, 'range'); assert.ok(calls > 1);
});

// ------------------------------------------------------------------------------------------------ text formats
test('Esri ASCII grid with xllcenter and NODATA_value', () => {
  const r = parseAsciiGrid(fx('grid_center.asc')); checkStandard(r, 'asc');
});
test('XYZ points → grid (spacing detected)', () => {
  const r = parseXyz(fx('points.xyz')); checkStandard(r, 'xyz');
});
test('.prj sidecar → EPSG', () => {
  assert.equal(epsgFromPrj('PROJCS["ETRS89 / UTM zone 32N",GEOGCS["ETRS89"],UNIT["metre",1],AUTHORITY["EPSG","25832"]]'), 25832);
  assert.equal(epsgFromPrj('PROJCS["ETRS_1989_UTM_Zone_33N",GEOGCS["GCS_ETRS_1989"]]'), 25833);
});

// ------------------------------------------------------------------------------------------------ CRS
test('Transverse Mercator agrees with the existing UTM32 helpers and round-trips', () => {
  for (const [lat, lon] of [[55.6761, 12.5683], [57.05, 9.92], [54.9, 8.2], [55.1, 14.9]]) {
    const a = tmForward(lat, lon, { lon0: 9 }), b = latLonToUtm32(lat, lon);
    near(a.E, b.E, 0.05, 'E'); near(a.N, b.N, 0.05, 'N');
    const ll = tmInverse(a.E, a.N, { lon0: 9 }); near(ll.lat, lat, 1e-9); near(ll.lon, lon, 1e-9);
    const u = utm32ToLatLon(a.E, a.N); near(u.lat, lat, 1e-5); near(u.lon, lon, 1e-5);
  }
  // Independent check on the central meridian: N = k0 · meridian arc (numerical integration on GRS80)
  const a = 6378137, f = 1 / 298.257222101, e2 = f * (2 - f); let M = 0; const steps = 20000, phi = (56 * Math.PI) / 180;
  for (let k = 0; k < steps; k++) { const p = ((k + 0.5) / steps) * phi; M += (a * (1 - e2)) / Math.pow(1 - e2 * Math.sin(p) ** 2, 1.5) * (phi / steps); }
  const c = crsFromEpsg(25832).fromLatLon(56, 9); near(c.E, 500000, 1e-6); near(c.N, 0.9996 * M, 0.01);
  assert.equal(analysisCrsFor(59.91, 10.75).epsg, 32632); assert.equal(analysisCrsFor(55.4, 15.0).epsg, 25832); assert.equal(analysisCrsFor(-33.9, 151.2).epsg, 32756);
  const bb = squareBbox(55.7, 12.57, 400, crsFromEpsg(25832), 8); assert.ok(bb.every((v) => v % 8 === 0) && bb[2] - bb[0] >= 400);
});

// ------------------------------------------------------------------------------------------------ resampling
test('aggregate: mean / min / max / nearest from 0.4 m to 2 m', async () => {
  const r = await readGeoTiff(fx('strip_f32_le.tif'));
  const t = targetGrid(r, 2);
  assert.equal(t.x0 % 2, 0); assert.ok(t.x0 >= X0 && t.y0 >= YTOP - H * DX);
  const mean = aggregate(r, t, 'mean'), mn = aggregate(r, t, 'min'), mx = aggregate(r, t, 'max');
  // cell (0,0) (south-west) covers source pixels whose centres fall inside it; expected mean of the plane = value at its centroid
  for (let k = 0; k < mean.length; k++) { assert.ok(mn[k] <= mean[k] + 1e-6 && mean[k] <= mx[k] + 1e-6); }
  const cx = t.x0 + 1, cy = t.y0 + 1; const c = (cx - X0) / DX - 0.5, rr = (YTOP - cy) / DX - 0.5;
  near(mean[0], z(c, rr), 1e-4, 'planar mean = centre value');
});
test('aggregate: a 0.15 m-wide kerb survives max, a gutter survives min, nearest is hit-or-miss', () => {
  // 0.1 m source, 1 m target; a kerb +0.15 m along x = 3.3–3.4 (one source column), gutter -0.15 at x = 6.6–6.7
  const w = 100, h = 20, data = new Float32Array(w * h).fill(5);
  for (let r = 0; r < h; r++) { data[r * w + 33] = 5.15; data[r * w + 66] = 4.85; }
  const ras = { width: w, height: h, data, x0: 0, yTop: 2, dx: 0.1, dy: 0.1 };
  const t = targetGrid(ras, 1);
  const mx = aggregate(ras, t, 'max'), mn = aggregate(ras, t, 'min'), mean = aggregate(ras, t, 'mean'), nn = aggregate(ras, t, 'nearest');
  near(mx[3], 5.15); near(mn[6], 4.85); near(mean[3], 5.015); near(nn[3], 5); // the centre sample misses the kerb entirely
});
test('aggregate: cells with < 50 % data are no-data', () => {
  const data = new Float32Array(10 * 10).fill(1); for (let k = 0; k < 60; k++) data[k] = NaN; // top 6 rows missing
  const t = targetGrid({ width: 10, height: 10, data, x0: 0, yTop: 1, dx: 0.1, dy: 0.1 }, 0.5);
  const v = aggregate({ width: 10, height: 10, data, x0: 0, yTop: 1, dx: 0.1, dy: 0.1 }, t, 'mean');
  assert.equal(v[0], 1); assert.ok(Number.isNaN(v[2]) || Number.isNaN(v[3]));
});
test('mosaic: two adjacent DHM-like tiles join without a seam', () => {
  const mk = (x0) => ({ width: 10, height: 5, data: new Float32Array(50).map((_, k) => x0 + (k % 10) * 0.4), x0, yTop: 100, dx: 0.4, dy: 0.4 });
  const m = mosaic([mk(0), mk(4)]);
  assert.equal(m.width, 20); assert.ok(!m.data.some(Number.isNaN)); near(m.data[10], 4);
});
test('reproject: lat/lon raster onto UTM keeps a plane a plane', () => {
  const crsLL = crsFromEpsg(4326), utm = crsFromEpsg(25832);
  const w = 60, h = 40, dx = 1 / 3600; const x0 = 12.56, yTop = 55.705;
  const p = (lon, lat) => { const q = utm.fromLatLon(lat, lon); return 0.01 * (q.E - 724000) + 0.02 * (q.N - 6179000); };
  const data = new Float32Array(w * h); for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) data[r * w + c] = p(x0 + (c + 0.5) * dx, yTop - (r + 0.5) * dx);
  const ras = { width: w, height: h, data, x0, yTop, dx, dy: dx };
  const c0 = utm.fromLatLon(55.7, 12.57);
  const t = { x0: Math.round(c0.E) - 100, y0: Math.round(c0.N) - 100, nx: 50, ny: 50, d: 4 };
  const v = reproject(ras, crsLL, t, utm);
  const e = 0.01 * (t.x0 + 2 - 724000) + 0.02 * (t.y0 + 2 - 6179000);
  near(v[0], e, 0.02, 'plane value'); void sampleBilinear;
});

// ------------------------------------------------------------------------------------------------ engine alignment
test('engine receives exactly the prepared cell values (no half-cell shift, no extra smoothing)', async () => {
  const eng = await CloudburstEngine.load(readFileSync(new URL('../engine/cloudburst_core.wasm', import.meta.url)));
  const p = await prepareTerrain(fx('strip_f32_le.tif'), { cellSize: 1 });
  const g = eng.buildGrid({ terrainBytes: p.bytes }, { cellSize: p.cellSize });
  assert.equal(g.nx, p.grid.nx); assert.equal(g.ny, p.grid.ny); near(g.x0, p.grid.x0, 1e-9); near(g.y0, p.grid.y0, 1e-9);
  let worst = 0; for (let k = 0; k < p.values.length; k++) if (p.values[k] === p.values[k]) worst = Math.max(worst, Math.abs(g.terrainZ[k] - p.values[k]));
  assert.ok(worst < 1e-5, `max difference ${worst}`);
  eng.freeGrid(g);
  // the old path (raw 0.4 m bytes) shifts the grid origin by half a source pixel
  const old = eng.buildGrid({ terrainBytes: fx('strip_f32_le.tif') }, { cellSize: 1 });
  near(old.x0, X0 + DX / 2, 1e-9, 'old engine path origin = first pixel centre'); eng.freeGrid(old);
});
test('prepareSiteDesc: decodes, aggregates, carries OSM context attached to the bytes', async () => {
  const bytes = fx('grid_center.asc');
  attachContext(bytes, { info: { sourceId: 'upload', name: 't' }, osm: { buildings: [{ xs: [1, 2, 2], ys: [1, 1, 2], height: 9 }], surfaces: [], bridgeCuts: [], stats: { buildings: 1 }, attribution: 'osm' } });
  const sd = await prepareSiteDesc({ terrainBytes: bytes });
  assert.ok(sd.prepared && sd.prepared.cellSize === 1 && sd.buildings.length === 1 && sd.prepared.attribution.includes('osm'));
  assert.equal(sd.prepared.suitability.level, 'good');
  const again = await prepareSiteDesc(sd); assert.equal(again, sd, 'idempotent');
});
test('prepareTerrain: geographic raster is reprojected to metric UTM', async () => {
  const p = await prepareTerrain(fx('int16_pred2_deflate_geographic.tif'));
  assert.equal(p.epsg, 25832); assert.ok(p.warnings.some((w) => /Reprojected/.test(w)));
  assert.ok(p.grid.nx >= 600 && p.grid.nx <= 650, `nx ${p.grid.nx}`); // 37 × 1″ of longitude at 55.7° ≈ 645 m, 1 m cells
});
test('readTerrainFile rejects LAS / unknown formats with guidance', async () => {
  await assert.rejects(readTerrainFile(new TextEncoder().encode('LASF....'), { name: 'a.las' }), /LAS\/LAZ/);
});

// ------------------------------------------------------------------------------------------------ DHM
test('DHM: bbox snapping, tiling without gaps, capabilities parsing', () => {
  assert.deepEqual(snapDhmBbox([724410.3, 6179030.9, 724810.1, 6179430]), [724408, 6179024, 724816, 6179432]);
  const tiles = dhmTiles([0, 0, 1600, 1200], 0.4);
  assert.equal(tiles.length, 4); assert.ok(tiles.every((t) => t.width <= 2000 && t.height <= 2000 && t.bbox.every((v) => v % 8 === 0)));
  const area = tiles.reduce((a, t) => a + (t.bbox[2] - t.bbox[0]) * (t.bbox[3] - t.bbox[1]), 0); assert.equal(area, 1600 * 1200);
  const caps = parseWcsCapabilities('<WCS_Capabilities><ContentMetadata><CoverageOfferingBrief><name>dhm_terraen</name><label>DHM Terræn</label></CoverageOfferingBrief><CoverageOfferingBrief><name>dhm_hydro</name><label>Hydrologisk tilpasset</label></CoverageOfferingBrief></ContentMetadata></WCS_Capabilities>');
  assert.deepEqual(caps.map((c) => [c.name, c.hydro]), [['dhm_terraen', false], ['dhm_hydro', true]]);
});
test('DHM: key errors and HTML error pages become readable messages; tiles are requested on the lattice', async () => {
  const seen = [];
  const ok = writeGeoTiff({ width: 20, height: 20, data: new Float32Array(400).fill(3), x0: 0, yTop: 8, dx: 0.4, dy: 0.4, epsg: 25832 });
  const fetchFn = async (url) => { seen.push(url); return { ok: true, status: 200, arrayBuffer: async () => ok.buffer }; };
  const t = await fetchDhmTiles([100.2, 200.1, 107.9, 207.7], { provider: 'datafordeler', key: 'K', fetchFn });
  assert.equal(t.length, 1); assert.match(seen[0], /bbox=96%2C200%2C112%2C208/); assert.match(seen[0], /width=40&height=20/); assert.match(seen[0], /apikey=K/);
  const bad = async () => ({ ok: false, status: 401, arrayBuffer: async () => new TextEncoder().encode('{"title":"Unauthorized","detail":"Invalid API key"}').buffer });
  await assert.rejects(fetchDhmTiles([0, 0, 8, 8], { provider: 'datafordeler', key: 'x', fetchFn: bad }), /Key rejected \(401\).*Invalid API key/);
  const html = async () => ({ ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode('<ServiceExceptionReport><ServiceException>Coverage not found</ServiceException></ServiceExceptionReport>').buffer });
  await assert.rejects(fetchDhmTiles([0, 0, 8, 8], { provider: 'datafordeler', key: 'x', fetchFn: html }), /Coverage not found/);
});
test('fetchTerrain(dk-dhm) with a mocked WCS: mosaics tiles and returns an EPSG:25832 GeoTIFF + info', async () => {
  const fetchFn = async (url) => {
    const q = new URL(url).searchParams; const [x0, , , y1] = q.get('bbox').split(',').map(Number); const w = +q.get('width'), h = +q.get('height');
    const data = new Float32Array(w * h).map((_, k) => 2 + ((x0 + (k % w) * 0.4) - 724000) * 0.001);
    return { ok: true, status: 200, arrayBuffer: async () => writeGeoTiff({ width: w, height: h, data, x0, yTop: y1, dx: 0.4, dy: 0.4, epsg: 25832 }).buffer };
  };
  const { bytes, info, raster } = await fetchTerrain('dk-dhm', { lat: 55.7, lon: 12.57, sizeM: 900, provider: 'datafordeler', key: 'K', fetchFn });
  assert.equal(info.epsg, 25832); assert.equal(info.suitability.level, 'good'); assert.ok(raster.width >= 2250);
  const r = await readGeoTiff(bytes); assert.equal(r.epsg, 25832);
  for (let c = 1; c < r.width; c++) assert.ok(Math.abs(r.data[c] - r.data[c - 1] - 0.0004) < 1e-4, 'no seam between WCS tiles');
});

// ------------------------------------------------------------------------------------------------ Terrain Tiles
test('Terrarium: PNG decode + height formula + imagery source description', async () => {
  // build a 256×256 RGB PNG (filter 0) encoding h = 12.5 m, compressed with CompressionStream
  const raw = new Uint8Array(256 * (1 + 256 * 3));
  const v = 12.5 + 32768; const R = Math.floor(v / 256), G = Math.floor(v) % 256, B = Math.round((v % 1) * 256);
  for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) raw.set([R, G, B], y * 769 + 1 + x * 3);
  const comp = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer());
  const chunk = (type, data) => { const out = new Uint8Array(12 + data.length); const dv = new DataView(out.buffer); dv.setUint32(0, data.length); out.set(new TextEncoder().encode(type), 4); out.set(data, 8); return out; };
  const ihdr = new Uint8Array(13); new DataView(ihdr.buffer).setUint32(0, 256); new DataView(ihdr.buffer).setUint32(4, 256); ihdr.set([8, 2, 0, 0, 0], 8);
  const png = new Uint8Array([...[137, 80, 78, 71, 13, 10, 26, 10], ...chunk('IHDR', ihdr), ...chunk('IDAT', comp), ...chunk('IEND', new Uint8Array(0))]);
  const d = await decodePng(png); assert.equal(d.width, 256); assert.deepEqual([...d.rgba.slice(0, 3)], [R, G, B]);
  const fetchFn = async () => ({ ok: true, status: 200, headers: new Map([['x-amz-meta-x-imagery-sources', 'eudem/eudem_dem_5deg_n55e010.tif, srtm/N55E012.tif']]), arrayBuffer: async () => png.buffer });
  const r = await fetchTerrarium({ south: 55.7, west: 12.57, north: 55.704, east: 12.577 }, { fetchFn, zoom: 15 });
  near(r.data[0], 12.5, 1e-9); assert.equal(r.meta.bestNativeResM, 25); assert.deepEqual(r.meta.datasets, ['EU-DEM (Copernicus)', 'SRTM']);
  assert.deepEqual(describeImagerySources('3dep/x.tif,gmted/y.tif').bestResM, 3);
});
test('fetchTerrain(terrain-tiles) is honest about resolution', async () => {
  const s = suitability('terrain-tiles', { cellSize: 1, nativeResM: 25 });
  assert.equal(s.level, 'unsuitable'); assert.match(s.message, /NOT adequate/);
  assert.equal(suitability('copernicus-glo30', { cellSize: 1 }).level, 'unsuitable');
  assert.equal(suitability('dk-dhm', { cellSize: 1 }).level, 'good');
  assert.equal(suitability(null, { nativeResM: 2 }).level, 'fair');
  assert.ok(listSources({ lat: 59.9, lon: 10.7 }).every((x) => x.id !== 'dk-dhm'));
  assert.ok(listSources({ lat: 55.7, lon: 12.5 }).some((x) => x.id === 'dk-dhm'));
  for (const s of SOURCES) assert.ok(s.licence && s.status && 'keyRequired' in s && s.coverage, s.id);
});

// ------------------------------------------------------------------------------------------------ OSM
test('OSM: buildings (with courtyard), land cover, roads, bridges → engine description', () => {
  const crs = crsFromEpsg(25832);
  const c = crs.fromLatLon(55.7, 12.57); const ll = (dx, dy) => crs.toLatLon(c.E + dx, c.N + dy);
  const g = (pts) => pts.map(([x, y]) => { const p = ll(x, y); return { lat: p.lat, lon: p.lon }; });
  const sq = (x0, y0, s) => g([[x0, y0], [x0 + s, y0], [x0 + s, y0 + s], [x0, y0 + s], [x0, y0]]);
  const json = { elements: [
    { type: 'relation', id: 1, tags: { building: 'apartments', 'building:levels': '5', type: 'multipolygon' }, members: [
      { type: 'way', role: 'outer', geometry: g([[0, 0], [60, 0], [60, 60]]) }, { type: 'way', role: 'outer', geometry: g([[60, 60], [0, 60], [0, 0]]) },
      { type: 'way', role: 'inner', geometry: sq(20, 20, 20) }] },
    { type: 'way', id: 2, tags: { leisure: 'park' }, geometry: sq(-100, -100, 80) },
    { type: 'way', id: 3, tags: { amenity: 'parking', surface: 'paving_stones' }, geometry: sq(100, 0, 30) },
    { type: 'way', id: 4, tags: { highway: 'residential' }, geometry: g([[-150, 80], [150, 80]]) },
    { type: 'way', id: 5, tags: { highway: 'primary', bridge: 'yes' }, geometry: g([[-50, -150], [-50, -120]]) },
    { type: 'way', id: 6, tags: { highway: 'footway', tunnel: 'yes' }, geometry: g([[0, -10], [10, -10]]) },
    { type: 'way', id: 7, tags: { landuse: 'residential' }, geometry: sq(-200, -200, 400) },
    { type: 'way', id: 8, tags: { building: 'yes' }, geometry: sq(500, 500, 10) }, // outside the clip box
  ] };
  const s = osmToSite(json, (la, lo) => crs.fromLatLon(la, lo), [c.E - 160, c.N - 160, c.E + 160, c.N + 160]);
  assert.equal(s.buildings.length, 1); assert.equal(s.buildings[0].height, 15);
  // the courtyard centre must be OUTSIDE the keyholed footprint (even-odd)
  const inside = (x, y, r) => { let k = false; for (let i = 0, j = r.xs.length - 1; i < r.xs.length; j = i++) if ((r.ys[i] > y) !== (r.ys[j] > y) && x < r.xs[i] + ((r.xs[j] - r.xs[i]) * (y - r.ys[i])) / (r.ys[j] - r.ys[i])) k = !k; return k; };
  assert.equal(inside(c.E + 30, c.N + 30, s.buildings[0]), false, 'courtyard open'); assert.equal(inside(c.E + 10, c.N + 10, s.buildings[0]), true, 'block solid');
  assert.deepEqual(s.surfaces.map((x) => x.material).slice(0, 2), ['park_lawn', 'pavers']);
  assert.ok(s.surfaces.some((x) => x.material === 'asphalt'), 'road buffered'); assert.equal(s.bridgeCuts.length, 1);
  assert.ok(s.surfaces.every((x) => x.xs.every((v) => v >= c.E - 162.1 && v <= c.E + 162.1)), 'clipped');
  assert.equal(s.stats.roads, 1, 'tunnel skipped, bridge separate');
});
test('OSM helpers: keyhole, clipping, tag mapping, heights', () => {
  const k = keyhole({ xs: [0, 10, 10, 0], ys: [0, 0, 10, 10] }, [{ xs: [4, 6, 6, 4], ys: [4, 4, 6, 6] }]); assert.equal(k.xs.length, 10);
  assert.equal(clipRing([0, 10, 10, 0], [0, 0, 10, 10], [20, 20, 30, 30]), null);
  assert.equal(clipRing([0, 10, 10, 0], [0, 0, 10, 10], [5, 5, 30, 30]).xs.length, 4);
  assert.equal(areaMaterial({ landuse: 'residential' }), null); assert.equal(areaMaterial({ natural: 'water' }).material, 'water');
  assert.equal(areaMaterial({ leisure: 'pitch', surface: 'artificial_turf' }).material, 'rubber');
  assert.equal(buildingHeight({ height: '12,5 m' }), 12.5); assert.equal(buildingHeight({}), 8);
});
