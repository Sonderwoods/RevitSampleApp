// Buildings for real Danish sites.
//   Footprints: OpenStreetMap (Overpass API, no key, CORS-enabled). Denmark is fully mapped (GeoDanmark/BBR imports).
//   Heights:    measured from Danmarks Højdemodel – DHM/Overflade (surface, incl. roofs) minus DHM/Terræn (ground),
//               downloaded with the same Datafordeler key as the terrain. Fallback: OSM height / building:levels tags.
// All coordinates returned are EPSG:25832 (same as the DHM GeoTIFFs), ready for the engine's `buildings` input.

import { latLonToUtm32 } from './dhm.js';
import { utm32ToLatLon } from './util.js';

const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
const SKIP = new Set(['no', 'roof', 'carport', 'construction', 'ruins', 'canopy']);
export const DEFAULT_HEIGHT = 8;
const MIN_HEIGHT = 2.5;

/** Footprints inside an EPSG:25832 bbox → [{xs, ys, name, tagHeight, id}], clipped to the bbox. */
export async function fetchOsmBuildings(bbox) {
  const [x0, y0, x1, y1] = bbox;
  const corners = [[x0, y0], [x1, y0], [x0, y1], [x1, y1]].map(([x, y]) => utm32ToLatLon(x, y));
  const s = Math.min(...corners.map((c) => c.lat)), n = Math.max(...corners.map((c) => c.lat));
  const w = Math.min(...corners.map((c) => c.lon)), e = Math.max(...corners.map((c) => c.lon));
  const b = `${s.toFixed(6)},${w.toFixed(6)},${n.toFixed(6)},${e.toFixed(6)}`;
  const q = `[out:json][timeout:90];(way["building"](${b});relation["building"]["type"="multipolygon"](${b}););out tags geom;`;
  let lastErr = null;
  for (const url of OVERPASS) {
    try {
      const r = await fetch(url, { method: 'POST', body: new URLSearchParams({ data: q }) });
      if (!r.ok) { lastErr = new Error(`OpenStreetMap buildings: HTTP ${r.status}`); continue; }
      return parseOverpass(await r.json(), bbox);
    } catch (err) { lastErr = err; }
  }
  throw lastErr || new Error('OpenStreetMap buildings unavailable');
}

/** Overpass JSON (out tags geom) → clipped EPSG:25832 footprints. Exported for tests. */
export function parseOverpass(json, bbox) {
  const out = [];
  for (const el of json.elements || []) {
    const t = el.tags || {};
    if (SKIP.has(t.building) || t.location === 'underground' || +t.layer < 0) continue;
    let rings = [];
    if (el.type === 'way' && el.geometry) rings = [el.geometry];
    else if (el.type === 'relation' && el.members) rings = stitch(el.members.filter((m) => m.type === 'way' && m.role !== 'inner' && m.geometry).map((m) => m.geometry));
    for (const ring of rings) {
      const pts = ring.map((p) => latLonToUtm32(p.lat, p.lon)).map(({ E, N }) => [E, N]);
      if (pts.length > 1 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1]) pts.pop();
      const c = clipRect(pts, bbox);
      if (c.length < 3 || Math.abs(area(c)) < 4) continue;
      out.push({ id: `${el.type}/${el.id}`, name: t.name || t['addr:street'] && `${t['addr:street']} ${t['addr:housenumber'] || ''}`.trim() || '', xs: c.map((p) => +p[0].toFixed(2)), ys: c.map((p) => +p[1].toFixed(2)), tagHeight: tagHeight(t) });
    }
  }
  return out;
}

function tagHeight(t) {
  const hv = parseFloat(String(t.height || '').replace(',', '.'));
  if (isFinite(hv) && hv > 0) return hv;
  const lv = parseFloat(t['building:levels']);
  if (isFinite(lv) && lv > 0) return lv * 3 + (t['roof:shape'] && t['roof:shape'] !== 'flat' ? 2 : 0.5);
  return null;
}

/** Join open outer ways of a multipolygon into closed rings. */
function stitch(ways) {
  const key = (p) => `${p.lat},${p.lon}`;
  const rings = [], open = [];
  for (const w of ways) (key(w[0]) === key(w[w.length - 1]) ? rings : open).push(w.slice());
  while (open.length) {
    let cur = open.shift(), grown = true;
    while (key(cur[0]) !== key(cur[cur.length - 1]) && grown) {
      grown = false;
      for (let i = 0; i < open.length; i++) {
        const w = open[i], end = key(cur[cur.length - 1]);
        if (key(w[0]) === end) cur = cur.concat(w.slice(1));
        else if (key(w[w.length - 1]) === end) cur = cur.concat(w.slice().reverse().slice(1));
        else continue;
        open.splice(i, 1); grown = true; break;
      }
    }
    if (key(cur[0]) === key(cur[cur.length - 1])) rings.push(cur);
  }
  return rings;
}

function area(p) { let a = 0; for (let i = 0, j = p.length - 1; i < p.length; j = i++) a += (p[j][0] + p[i][0]) * (p[j][1] - p[i][1]); return a / 2; }

/** Sutherland–Hodgman clip of a polygon to an axis-aligned rectangle. */
function clipRect(poly, [x0, y0, x1, y1]) {
  const edges = [[(p) => p[0] >= x0, (a, b) => [x0, a[1] + (b[1] - a[1]) * (x0 - a[0]) / (b[0] - a[0])]],
    [(p) => p[0] <= x1, (a, b) => [x1, a[1] + (b[1] - a[1]) * (x1 - a[0]) / (b[0] - a[0])]],
    [(p) => p[1] >= y0, (a, b) => [a[0] + (b[0] - a[0]) * (y0 - a[1]) / (b[1] - a[1]), y0]],
    [(p) => p[1] <= y1, (a, b) => [a[0] + (b[0] - a[0]) * (y1 - a[1]) / (b[1] - a[1]), y1]]];
  let out = poly;
  for (const [inside, cut] of edges) {
    const src = out; out = [];
    for (let i = 0; i < src.length; i++) {
      const a = src[(i + src.length - 1) % src.length], b = src[i];
      if (inside(b)) { if (!inside(a)) out.push(cut(a, b)); out.push(b); }
      else if (inside(a)) out.push(cut(a, b));
    }
    if (!out.length) break;
  }
  return out;
}

/**
 * Give every footprint a height. `dtm` and `dsm` are engine grids (same extent and cell size) built from DHM/Terræn and
 * DHM/Overflade; either may be null. Height = 90th percentile of (surface − ground) over cells inside the footprint.
 * Returns {buildings, measured, tagged, defaulted}.
 */
export function assignHeights(buildings, dtm, dsm) {
  let measured = 0, tagged = 0, defaulted = 0;
  const ok = dtm && dsm && dtm.nx === dsm.nx && dtm.ny === dsm.ny && Math.abs(dtm.x0 - dsm.x0) < 1e-6 && Math.abs(dtm.y0 - dsm.y0) < 1e-6;
  const res = buildings.map((b) => {
    let hgt = ok ? measure(b, dtm, dsm) : null;
    if (hgt != null) measured++;
    else if (b.tagHeight) { hgt = b.tagHeight; tagged++; }
    else { hgt = DEFAULT_HEIGHT; defaulted++; }
    return { name: b.name, id: b.id, xs: b.xs, ys: b.ys, height: Math.round(Math.max(MIN_HEIGHT, hgt) * 10) / 10 };
  });
  return { buildings: res, measured, tagged, defaulted };
}

function measure(b, dtm, dsm) {
  const { nx, ny, x0, y0, dx } = dtm;
  const minX = Math.min(...b.xs), maxX = Math.max(...b.xs), minY = Math.min(...b.ys), maxY = Math.max(...b.ys);
  const i0 = Math.max(0, Math.floor((minX - x0) / dx)), i1 = Math.min(nx - 1, Math.floor((maxX - x0) / dx));
  const j0 = Math.max(0, Math.floor((minY - y0) / dx)), j1 = Math.min(ny - 1, Math.floor((maxY - y0) / dx));
  const d = [];
  const sample = (k) => { const v = dsm.terrainZ[k] - dtm.terrainZ[k]; if (isFinite(v) && Math.abs(v) < 400) d.push(v); };
  for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
    const x = x0 + (i + 0.5) * dx, y = y0 + (j + 0.5) * dx;
    if (inside(x, y, b.xs, b.ys)) sample(j * nx + i);
  }
  if (!d.length) { // footprint smaller than a cell: use the cell under its centroid
    const cx = b.xs.reduce((a, v) => a + v, 0) / b.xs.length, cy = b.ys.reduce((a, v) => a + v, 0) / b.ys.length;
    const i = Math.floor((cx - x0) / dx), j = Math.floor((cy - y0) / dx);
    if (i >= 0 && j >= 0 && i < nx && j < ny) sample(j * nx + i);
  }
  if (!d.length) return null;
  d.sort((a, c) => a - c);
  const p90 = d[Math.min(d.length - 1, Math.floor(d.length * 0.9))];
  return p90 >= 1.5 ? p90 : null; // not visible in the surface model (demolished / not built yet)
}

function inside(x, y, xs, ys) {
  let c = false;
  for (let i = 0, j = xs.length - 1; i < xs.length; j = i++) {
    if ((ys[i] > y) !== (ys[j] > y) && x < ((xs[j] - xs[i]) * (y - ys[i])) / (ys[j] - ys[i]) + xs[i]) c = !c;
  }
  return c;
}
