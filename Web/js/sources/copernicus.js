// Copernicus DEM GLO-30 (30 m, global) from the AWS Open Data bucket, read as Cloud Optimized GeoTIFFs with HTTP
// range requests (only the internal tiles covering the site are downloaded, typically < 1 MB).
//
// NOTE: it is a DSM (X-band radar, TanDEM-X): buildings and forest canopy are partly in it. With 30 m posting it is
// a regional overview, NOT a site-scale cloudburst terrain. The bucket sends no CORS headers, so browsers need the
// local relay (Web/serve.py → /proxy/copernicus/…); Node and the desktop app can read it directly.

import { HttpRangeSource, readGeoTiff } from './tiff.js';
import { mosaic } from './gridops.js';

export const COPERNICUS_BASE = 'https://copernicus-dem-30m.s3.amazonaws.com';

export function copernicusTileName(latFloor, lonFloor) {
  const ns = latFloor >= 0 ? 'N' : 'S', ew = lonFloor >= 0 ? 'E' : 'W';
  const la = String(Math.abs(latFloor)).padStart(2, '0'), lo = String(Math.abs(lonFloor)).padStart(3, '0');
  return `Copernicus_DSM_COG_10_${ns}${la}_00_${ew}${lo}_00_DEM`;
}

/**
 * Read GLO-30 for a lat/lon box. `base` is the bucket URL, or 'proxy/copernicus' when served by serve.py.
 * Returns a north-up raster in EPSG:4326 degrees (heights in metres, EGM2008).
 */
export async function fetchCopernicus(bboxLL, { base = COPERNICUS_BASE, fetchFn, onProgress } = {}) {
  const parts = []; const missing = []; const warnings = [];
  const tiles = [];
  for (let la = Math.floor(bboxLL.south); la <= Math.floor(bboxLL.north - 1e-12); la++) {
    for (let lo = Math.floor(bboxLL.west); lo <= Math.floor(bboxLL.east - 1e-12); lo++) tiles.push([la, lo]);
  }
  if (tiles.length > 4) throw new Error('Area spans more than 4 Copernicus 1° tiles; pick a smaller area.');
  let done = 0; let bytes = 0, requests = 0;
  for (const [la, lo] of tiles) {
    const name = copernicusTileName(la, lo);
    const src = new HttpRangeSource(`${base}/${name}/${name}.tif`, { fetchFn, block: 65536 });
    try {
      const r = await readGeoTiff(src, { bbox: [bboxLL.west, bboxLL.south, bboxLL.east, bboxLL.north] });
      parts.push(r); warnings.push(...r.warnings);
    } catch (e) {
      if (e.status === 404 || e.status === 403) missing.push(name); // no tile = open sea
      else throw new Error(`Copernicus DEM download failed: ${e.message}${base === COPERNICUS_BASE && typeof window !== 'undefined' ? ' (browsers need the local relay: run "python serve.py")' : ''}`);
    }
    bytes += src.bytes; requests += src.requests;
    if (onProgress) onProgress(++done, tiles.length);
  }
  if (!parts.length) throw new Error('No Copernicus DEM tiles cover this area (open sea?).');
  if (missing.length) warnings.push(`${missing.length} Copernicus tile(s) do not exist (sea); those areas are no data.`);
  // Tiles at different latitudes have different longitude spacing; mosaic only same-spacing parts.
  const m = parts.length === 1 ? parts[0] : mosaic(parts);
  return { ...m, epsg: 4326, kind: 'geographic', verticalCrs: 'EGM2008 geoid', warnings: [...new Set([...warnings, ...(m.warnings || [])])], meta: { ...(parts[0].meta || {}), tiles: tiles.length, bytesDownloaded: bytes, requests } };
}
