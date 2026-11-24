// AWS Open Data "Terrain Tiles" (Mapzen/Tilezen Joerd), Terrarium PNG encoding: height = R*256 + G + B/256 − 32768 m.
// Keyless, global, served with CORS (works from GitHub Pages). Web Mercator 256 px tiles, zoom 0–15.
//
// The tiles are a MOSAIC of national/global DEMs. Which ones a tile uses is reported in the S3 header
// x-amz-meta-x-imagery-sources (exposed to browsers), so we can tell the user the real native resolution: in most
// of Europe it is EU-DEM (25 m) / SRTM (30 m) – NOT adequate for site-scale cloudburst screening. Better data exists
// in a few places (US 3DEP 1/9″ ≈ 3 m, England EA LiDAR 2 m, …).

import { mercForward, mercInverse } from './proj.js';

export const TERRARIUM_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';

/** Known source datasets (prefix of the x-amz-meta-x-imagery-sources entries) → approximate native resolution in m. */
export const TERRARIUM_DATASETS = {
  '3dep': { name: 'USGS 3DEP', res: 3 }, ned19: { name: 'USGS NED 1/9″', res: 3 }, ned13: { name: 'USGS NED 1/3″', res: 10 }, ned: { name: 'USGS NED', res: 10 },
  uk_lidar: { name: 'Environment Agency LiDAR (England)', res: 2 }, 'data.gov.uk': { name: 'Environment Agency LiDAR', res: 2 },
  austria: { name: 'DGM Österreich', res: 10 }, kartverket: { name: 'Kartverket', res: 10 }, linz: { name: 'LINZ New Zealand', res: 8 },
  arcticdem: { name: 'ArcticDEM', res: 5 }, ga: { name: 'Geoscience Australia', res: 5 }, cdem: { name: 'Canada CDEM', res: 20 },
  eudem: { name: 'EU-DEM (Copernicus)', res: 25 }, srtm: { name: 'SRTM', res: 30 }, inegi: { name: 'INEGI Mexico', res: 15 },
  gmted: { name: 'GMTED2010', res: 250 }, etopo1: { name: 'ETOPO1', res: 1800 },
};

export function describeImagerySources(header) {
  const names = new Set(); let best = Infinity;
  for (const part of String(header || '').split(/\s*,\s*/).filter(Boolean)) {
    const key = part.split('/')[0].toLowerCase();
    const ds = TERRARIUM_DATASETS[key] || Object.entries(TERRARIUM_DATASETS).find(([k]) => key.startsWith(k))?.[1];
    if (ds) { names.add(ds.name); best = Math.min(best, ds.res); } else names.add(key);
  }
  return { datasets: [...names], bestResM: Number.isFinite(best) ? best : null };
}

// ------------------------------------------------------------------------------------------------ PNG (RGB/RGBA 8-bit)

async function inflate(u8) {
  const stream = new Blob([u8]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Minimal PNG decoder: 8-bit greyscale/RGB/RGBA/palette, non-interlaced. Returns {width, height, rgba}. */
export async function decodePng(u8) {
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < 8; i++) if (u8[i] !== sig[i]) throw new Error('Not a PNG file.');
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.length);
  let pos = 8, W = 0, H = 0, depth = 0, ctype = 0, interlace = 0, plte = null; const idat = [];
  while (pos < u8.length) {
    const len = dv.getUint32(pos); const type = String.fromCharCode(...u8.subarray(pos + 4, pos + 8));
    const data = u8.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') { W = dv.getUint32(pos + 8); H = dv.getUint32(pos + 12); depth = u8[pos + 16]; ctype = u8[pos + 17]; interlace = u8[pos + 20]; }
    else if (type === 'PLTE') plte = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (depth !== 8 || interlace) throw new Error('Unsupported PNG (needs 8-bit, non-interlaced).');
  const ch = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ctype]; if (!ch) throw new Error('Unsupported PNG colour type.');
  const all = new Uint8Array(idat.reduce((a, b) => a + b.length, 0)); let o = 0; for (const c of idat) { all.set(c, o); o += c.length; }
  const raw = await inflate(all);
  const stride = W * ch; const px = new Uint8Array(W * H * ch);
  for (let y = 0; y < H; y++) {
    const f = raw[y * (stride + 1)]; const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = px.subarray(y * stride, (y + 1) * stride), prev = y ? px.subarray((y - 1) * stride, y * stride) : null;
    for (let i = 0; i < stride; i++) {
      const a = i >= ch ? cur[i - ch] : 0, b = prev ? prev[i] : 0, c = prev && i >= ch ? prev[i - ch] : 0;
      let v = src[i];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      cur[i] = v & 0xff;
    }
  }
  const rgba = new Uint8Array(W * H * 4);
  for (let k = 0; k < W * H; k++) {
    if (ctype === 2 || ctype === 6) { rgba[k * 4] = px[k * ch]; rgba[k * 4 + 1] = px[k * ch + 1]; rgba[k * 4 + 2] = px[k * ch + 2]; rgba[k * 4 + 3] = ctype === 6 ? px[k * ch + 3] : 255; }
    else if (ctype === 3) { const p = px[k] * 3; rgba[k * 4] = plte[p]; rgba[k * 4 + 1] = plte[p + 1]; rgba[k * 4 + 2] = plte[p + 2]; rgba[k * 4 + 3] = 255; }
    else { const g = px[k * ch]; rgba[k * 4] = rgba[k * 4 + 1] = rgba[k * 4 + 2] = g; rgba[k * 4 + 3] = ctype === 4 ? px[k * ch + 1] : 255; }
  }
  return { width: W, height: H, rgba };
}

// ------------------------------------------------------------------------------------------------ tiles

const TILE = 256, WORLD = 2 * Math.PI * 6378137;

/** Zoom whose pixel size at `lat` is ≤ targetM (capped at 15). */
export function terrariumZoom(lat, targetM) {
  for (let z = 0; z <= 15; z++) if ((WORLD * Math.cos((lat * Math.PI) / 180)) / (TILE * 2 ** z) <= targetM) return z;
  return 15;
}

/**
 * Fetch the tiles covering a lat/lon box and return ONE north-up raster in Web Mercator metres (EPSG:3857), plus
 * the datasets the tiles were built from. bboxLL = {south, west, north, east}.
 */
export async function fetchTerrarium(bboxLL, { zoom, targetResM = 5, fetchFn, url = TERRARIUM_URL, onProgress, maxTiles = 64 } = {}) {
  const f = fetchFn || fetch;
  const lat = (bboxLL.south + bboxLL.north) / 2;
  const z = zoom ?? terrariumZoom(lat, targetResM);
  const n = 2 ** z;
  const tx = (lon) => ((lon + 180) / 360) * n;
  const ty = (la) => ((1 - Math.log(Math.tan((la * Math.PI) / 180) + 1 / Math.cos((la * Math.PI) / 180)) / Math.PI) / 2) * n;
  const x0 = Math.floor(tx(bboxLL.west)), x1 = Math.floor(tx(bboxLL.east)), y0 = Math.floor(ty(bboxLL.north)), y1 = Math.floor(ty(bboxLL.south));
  const count = (x1 - x0 + 1) * (y1 - y0 + 1);
  if (count > maxTiles) throw new Error(`Area needs ${count} terrain tiles at zoom ${z}; pick a smaller area.`);
  const W = (x1 - x0 + 1) * TILE, H = (y1 - y0 + 1) * TILE;
  const data = new Float32Array(W * H).fill(NaN);
  const sources = new Set(); let done = 0; const failures = [];
  const jobs = [];
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) jobs.push([x, y]);
  await Promise.all(jobs.map(async ([x, y]) => {
    const u = url.replace('{z}', z).replace('{x}', x).replace('{y}', y);
    let r;
    try { r = await f(u); } catch (e) { failures.push(`${z}/${x}/${y}: ${e.message || e}`); return; }
    if (!r.ok) { failures.push(`${z}/${x}/${y}: HTTP ${r.status}`); return; }
    const hdr = r.headers && r.headers.get ? r.headers.get('x-amz-meta-x-imagery-sources') : null;
    if (hdr) for (const s of hdr.split(/\s*,\s*/)) if (s) sources.add(s);
    const png = await decodePng(new Uint8Array(await r.arrayBuffer()));
    const ox = (x - x0) * TILE, oy = (y - y0) * TILE;
    for (let j = 0; j < TILE; j++) for (let i = 0; i < TILE; i++) {
      const p = (j * png.width + i) * 4;
      const v = png.rgba[p] * 256 + png.rgba[p + 1] + png.rgba[p + 2] / 256 - 32768;
      data[(oy + j) * W + ox + i] = v < -1000 ? NaN : v; // ocean bathymetry/voids are not terrain for screening
    }
    if (onProgress) onProgress(++done, jobs.length);
  }));
  if (failures.length === jobs.length) throw new Error(`Terrain Tiles download failed (${failures[0]}). Check the internet connection.`);
  // tile pixel → Web Mercator metres
  const px = WORLD / (TILE * n);
  const mx0 = -WORLD / 2 + x0 * TILE * px, myTop = WORLD / 2 - y0 * TILE * px;
  const desc = describeImagerySources([...sources].join(','));
  const warnings = failures.length ? [`${failures.length} of ${jobs.length} terrain tiles could not be downloaded; those areas are no data.`] : [];
  return { width: W, height: H, data, x0: mx0, yTop: myTop, dx: px, dy: px, epsg: 3857, kind: 'projected', verticalCrs: 'EGM96 geoid (mostly)', warnings,
    meta: { zoom: z, tiles: jobs.length, pixelM: px * Math.cos((lat * Math.PI) / 180), imagerySources: [...sources], datasets: desc.datasets, bestNativeResM: desc.bestResM } };
}

export { mercForward, mercInverse };
