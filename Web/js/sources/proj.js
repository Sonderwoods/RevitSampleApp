// Coordinate reference systems for terrain import. No dependencies, works in the browser and in Node.
//
// * Transverse Mercator in both directions with the Krüger series (4th order, mm-accurate within a UTM zone).
// * UTM zones (ETRS89 EPSG:258zz, WGS84 EPSG:326zz/327zz), SWEREF99 TM (EPSG:3006), Web Mercator (EPSG:3857).
// * ETRS89 and WGS84 are treated as identical. They differ by < 1 m in 2026, which is far below what matters for
//   placing OpenStreetMap footprints on a terrain grid; all *analysis* happens in one metric CRS anyway.

const GRS80 = { a: 6378137, f: 1 / 298.257222101 };
const WGS84 = { a: 6378137, f: 1 / 298.257223563 };
const D2R = Math.PI / 180;

function tmParams(ell) {
  const n = ell.f / (2 - ell.f), n2 = n * n, n3 = n2 * n, n4 = n3 * n;
  return {
    e: Math.sqrt(ell.f * (2 - ell.f)),
    A: (ell.a / (1 + n)) * (1 + n2 / 4 + n4 / 64),
    alpha: [n / 2 - (2 * n2) / 3 + (5 * n3) / 16 + (41 * n4) / 180, (13 * n2) / 48 - (3 * n3) / 5 + (557 * n4) / 1440, (61 * n3) / 240 - (103 * n4) / 140, (49561 * n4) / 161280],
    beta: [n / 2 - (2 * n2) / 3 + (37 * n3) / 96 - n4 / 360, n2 / 48 + n3 / 15 - (437 * n4) / 1440, (17 * n3) / 480 - (37 * n4) / 840, (4397 * n4) / 161280],
    delta: [2 * n - (2 * n2) / 3 - 2 * n3 + (116 * n4) / 45, (7 * n2) / 3 - (8 * n3) / 5 - (227 * n4) / 45, (56 * n3) / 15 - (136 * n4) / 35, (4279 * n4) / 630],
  };
}
const P_GRS80 = tmParams(GRS80), P_WGS84 = tmParams(WGS84);

/** Transverse Mercator forward: lat/lon degrees → {E, N} metres. */
export function tmForward(lat, lon, { lon0, k0 = 0.9996, fe = 500000, fn = 0, ell = 'GRS80' }) {
  const p = ell === 'WGS84' ? P_WGS84 : P_GRS80;
  const phi = lat * D2R, dl = (lon - lon0) * D2R;
  const s = Math.sin(phi);
  const t = Math.sinh(Math.atanh(s) - p.e * Math.atanh(p.e * s));
  const xi = Math.atan2(t, Math.cos(dl)), eta = Math.atanh(Math.sin(dl) / Math.sqrt(1 + t * t));
  let E = eta, N = xi;
  for (let j = 1; j <= 4; j++) {
    E += p.alpha[j - 1] * Math.cos(2 * j * xi) * Math.sinh(2 * j * eta);
    N += p.alpha[j - 1] * Math.sin(2 * j * xi) * Math.cosh(2 * j * eta);
  }
  return { E: fe + k0 * p.A * E, N: fn + k0 * p.A * N };
}

/** Transverse Mercator inverse: {E, N} metres → {lat, lon} degrees. */
export function tmInverse(E, N, { lon0, k0 = 0.9996, fe = 500000, fn = 0, ell = 'GRS80' }) {
  const p = ell === 'WGS84' ? P_WGS84 : P_GRS80;
  const xi = (N - fn) / (k0 * p.A), eta = (E - fe) / (k0 * p.A);
  let xp = xi, ep = eta;
  for (let j = 1; j <= 4; j++) {
    xp -= p.beta[j - 1] * Math.sin(2 * j * xi) * Math.cosh(2 * j * eta);
    ep -= p.beta[j - 1] * Math.cos(2 * j * xi) * Math.sinh(2 * j * eta);
  }
  const chi = Math.asin(Math.sin(xp) / Math.cosh(ep));
  let phi = chi;
  for (let j = 1; j <= 4; j++) phi += p.delta[j - 1] * Math.sin(2 * j * chi);
  return { lat: phi / D2R, lon: lon0 + Math.atan2(Math.sinh(ep), Math.cos(xp)) / D2R };
}

const R_MERC = 6378137;
export function mercForward(lat, lon) { return { E: R_MERC * lon * D2R, N: R_MERC * Math.log(Math.tan(Math.PI / 4 + (lat * D2R) / 2)) }; }
export function mercInverse(E, N) { return { lat: (2 * Math.atan(Math.exp(N / R_MERC)) - Math.PI / 2) / D2R, lon: E / R_MERC / D2R }; }

/** Standard UTM zone for a longitude (the Norway/Svalbard exceptions are irrelevant at site scale). */
export function utmZoneFor(lon) { return Math.max(1, Math.min(60, Math.floor((lon + 180) / 6) + 1)); }

/**
 * Describe an EPSG code. Returns {epsg, kind: 'projected'|'geographic', name, units, toLatLon(x,y), fromLatLon(lat,lon)}
 * or null when the code is not one we can transform (the raster is then still usable, but cannot be placed on a map).
 */
export function crsFromEpsg(epsg) {
  epsg = Number(epsg);
  if (!epsg) return null;
  if (epsg === 4326 || epsg === 4258 || epsg === 4937 || epsg === 4979) {
    return { epsg, kind: 'geographic', name: epsg === 4258 ? 'ETRS89 (lat/lon)' : 'WGS84 (lat/lon)', units: 'degree', toLatLon: (x, y) => ({ lat: y, lon: x }), fromLatLon: (lat, lon) => ({ E: lon, N: lat }) };
  }
  if (epsg === 3857 || epsg === 900913) {
    return { epsg: 3857, kind: 'projected', name: 'Web Mercator', units: 'metre', notMetric: true, toLatLon: (x, y) => mercInverse(x, y), fromLatLon: (lat, lon) => mercForward(lat, lon) };
  }
  let tm = null, name = '';
  if (epsg >= 25801 && epsg <= 25860) { const z = epsg - 25800; tm = { lon0: z * 6 - 183, ell: 'GRS80' }; name = `ETRS89 / UTM zone ${z}N`; }
  else if (epsg >= 32601 && epsg <= 32660) { const z = epsg - 32600; tm = { lon0: z * 6 - 183, ell: 'WGS84' }; name = `WGS 84 / UTM zone ${z}N`; }
  else if (epsg >= 32701 && epsg <= 32760) { const z = epsg - 32700; tm = { lon0: z * 6 - 183, ell: 'WGS84', fn: 10000000 }; name = `WGS 84 / UTM zone ${z}S`; }
  else if (epsg === 3006) { tm = { lon0: 15, ell: 'GRS80' }; name = 'SWEREF99 TM'; }
  else if (epsg >= 3040 && epsg <= 3051) { const z = epsg - 3040 + 28; tm = { lon0: z * 6 - 183, ell: 'GRS80' }; name = `ETRS89 / ETRS-TM${z}`; } // = UTM 28…35
  if (!tm) return null;
  return { epsg, kind: 'projected', name, units: 'metre', toLatLon: (x, y) => tmInverse(x, y, tm), fromLatLon: (lat, lon) => tmForward(lat, lon, tm) };
}

/** The metric CRS a site should be analysed in: EPSG:25832 inside Denmark (DHM's CRS), otherwise the local UTM zone. */
export function analysisCrsFor(lat, lon) {
  const inDk = lat > 54.4 && lat < 57.9 && lon > 7.9 && lon < 15.3;
  if (inDk) return crsFromEpsg(25832);
  return crsFromEpsg(lat >= 0 ? 32600 + utmZoneFor(lon) : 32700 + utmZoneFor(lon));
}

/** Square of `sizeM` metres around lat/lon in `crs`, snapped outward to multiples of `snap` metres. */
export function squareBbox(lat, lon, sizeM, crs, snap = 8) {
  const { E, N } = crs.fromLatLon(lat, lon); const r = sizeM / 2;
  return [Math.floor((E - r) / snap) * snap, Math.floor((N - r) / snap) * snap, Math.ceil((E + r) / snap) * snap, Math.ceil((N + r) / snap) * snap];
}

/** Lat/lon bounding box of a projected bbox (corners plus edge midpoints, so it also covers TM curvature). */
export function bboxToLatLon(bbox, crs) {
  const [x0, y0, x1, y1] = bbox; let s = 90, w = 180, n = -90, e = -180;
  for (const fx of [0, 0.5, 1]) for (const fy of [0, 0.5, 1]) {
    const { lat, lon } = crs.toLatLon(x0 + (x1 - x0) * fx, y0 + (y1 - y0) * fy);
    s = Math.min(s, lat); n = Math.max(n, lat); w = Math.min(w, lon); e = Math.max(e, lon);
  }
  return { south: s, west: w, north: n, east: e };
}
