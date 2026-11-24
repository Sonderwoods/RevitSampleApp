// Text elevation formats: Esri ASCII grid (.asc) and gridded XYZ (.xyz / .txt / .csv: "x y z" per line).
// Both return the same north-up raster object as tiff.js readGeoTiff (NaN = no data). No CRS is stored in these
// formats, so `epsg` is 0 unless the caller supplies one (opts.epsg) or a .prj sidecar was parsed by the caller.

const decoder = typeof TextDecoder !== 'undefined' ? new TextDecoder() : null;
const asText = (input) => (typeof input === 'string' ? input : decoder.decode(input));

/** Esri ASCII grid. Accepts xllcorner/xllcenter, optional NODATA_value, dx/dy instead of cellsize, comma decimals not allowed. */
export function parseAsciiGrid(input, opts = {}) {
  const text = asText(input);
  const hdr = {}; let pos = 0; const warnings = [];
  for (;;) {
    const m = /^[ \t]*([A-Za-z_]+)[ \t]+([^\s]+)[^\n]*\n?/.exec(text.slice(pos, pos + 200));
    if (!m) break;
    hdr[m[1].toLowerCase()] = Number(m[2]); pos += m[0].length;
  }
  const nx = hdr.ncols | 0, ny = hdr.nrows | 0;
  const dx = hdr.cellsize ?? hdr.dx, dy = hdr.cellsize ?? hdr.dy ?? dx;
  if (!(nx > 0 && ny > 0 && dx > 0)) throw new Error('Not an Esri ASCII grid (ncols / nrows / cellsize missing).');
  let x0 = hdr.xllcorner, y0 = hdr.yllcorner;
  if (x0 === undefined && hdr.xllcenter !== undefined) x0 = hdr.xllcenter - dx / 2;
  if (y0 === undefined && hdr.yllcenter !== undefined) y0 = hdr.yllcenter - dy / 2;
  if (x0 === undefined || y0 === undefined) throw new Error('ASCII grid has no xllcorner/xllcenter or yllcorner/yllcenter.');
  const nd = hdr.nodata_value;
  const data = new Float32Array(nx * ny).fill(NaN);
  let k = 0, i = pos; const L = text.length;
  while (k < nx * ny && i < L) {
    while (i < L && text.charCodeAt(i) <= 32) i++;
    let j = i; while (j < L && text.charCodeAt(j) > 32) j++;
    if (j > i) {
      const v = Number(text.slice(i, j));
      data[k++] = Number.isFinite(v) && (nd === undefined || Math.abs(v - nd) > 1e-9) && v > -1000 && v < 9000 ? v : NaN;
    }
    i = j;
  }
  if (k < nx * ny) throw new Error(`ASCII grid is truncated: ${k} of ${nx * ny} values.`);
  if (nd === undefined) warnings.push('ASCII grid has no NODATA_value; values below -1000 m were treated as no data.');
  const deg = Math.abs(x0) <= 180 && Math.abs(y0) <= 90 && dx < 0.01;
  if (deg && !opts.epsg) warnings.push('Cell size and origin look like degrees: assuming WGS84 lat/lon (EPSG:4326).');
  return { width: nx, height: ny, data, x0, yTop: y0 + ny * dy, dx, dy, epsg: opts.epsg || (deg ? 4326 : 0), kind: deg ? 'geographic' : (opts.epsg ? 'projected' : 'unknown'), verticalCrs: null, warnings, meta: { format: 'Esri ASCII grid', nodata: nd ?? null } };
}

/**
 * Gridded XYZ points ("x y z", separators: space, tab, comma, semicolon; header lines are skipped).
 * Points are assumed to lie on a regular grid (cell centres); the spacing is the most common x step.
 * Irregular point clouds (raw LiDAR) are binned to that spacing by mean, which is only adequate when dense.
 */
export function parseXyz(input, opts = {}) {
  const text = asText(input);
  const xs = [], ys = [], zs = [];
  for (const line of text.split(/\r?\n/)) {
    const p = line.trim().split(/[\s,;]+/);
    if (p.length < 3) continue;
    const x = Number(p[0]), y = Number(p[1]), z = Number(p[2]);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
    xs.push(x); ys.push(y); zs.push(z);
  }
  if (xs.length < 4) throw new Error('No "x y z" points found.');
  const step = opts.cellSize || modalStep(xs) || modalStep(ys);
  if (!(step > 0)) throw new Error('Could not detect the XYZ grid spacing.');
  let minx = Infinity, maxx = -Infinity, miny = Infinity, maxy = -Infinity;
  for (let k = 0; k < xs.length; k++) { minx = Math.min(minx, xs[k]); maxx = Math.max(maxx, xs[k]); miny = Math.min(miny, ys[k]); maxy = Math.max(maxy, ys[k]); }
  const nx = Math.round((maxx - minx) / step) + 1, ny = Math.round((maxy - miny) / step) + 1;
  if (nx * ny > 60e6) throw new Error(`XYZ grid would be ${nx} × ${ny} cells; too large.`);
  const sum = new Float64Array(nx * ny), cnt = new Uint32Array(nx * ny);
  for (let k = 0; k < xs.length; k++) {
    const i = Math.round((xs[k] - minx) / step), r = Math.round((maxy - ys[k]) / step);
    const v = zs[k]; if (v < -1000 || v > 9000) continue;
    sum[r * nx + i] += v; cnt[r * nx + i]++;
  }
  const data = new Float32Array(nx * ny); let filled = 0;
  for (let k = 0; k < data.length; k++) { data[k] = cnt[k] ? sum[k] / cnt[k] : NaN; if (cnt[k]) filled++; }
  const warnings = [];
  if (filled < data.length * 0.98) warnings.push(`XYZ points fill ${((100 * filled) / data.length).toFixed(0)} % of a ${step} m grid; gaps are no data.`);
  const deg = Math.abs(minx) <= 180 && Math.abs(maxy) <= 90 && step < 0.01;
  return { width: nx, height: ny, data, x0: minx - step / 2, yTop: maxy + step / 2, dx: step, dy: step, epsg: opts.epsg || (deg ? 4326 : 0), kind: deg ? 'geographic' : (opts.epsg ? 'projected' : 'unknown'), verticalCrs: null, warnings, meta: { format: 'XYZ', points: xs.length } };
}

function modalStep(v) {
  const n = Math.min(v.length, 20000); const counts = new Map();
  for (let k = 1; k < n; k++) {
    const d = Math.abs(v[k] - v[k - 1]); if (!(d > 0)) continue;
    const key = +d.toPrecision(6); counts.set(key, (counts.get(key) || 0) + 1);
  }
  let best = 0, bc = 0; for (const [d, c] of counts) if (c > bc || (c === bc && d < best)) { best = d; bc = c; }
  return best;
}

/** Read the EPSG code out of a .prj (WKT) sidecar, when it says so; otherwise 0. */
export function epsgFromPrj(wkt) {
  const s = asText(wkt);
  const auth = /AUTHORITY\["EPSG",\s*"?(\d+)"?\]\s*\]\s*$/i.exec(s.trim()) || /ID\["EPSG",\s*(\d+)\]\s*\]\s*$/i.exec(s.trim());
  if (auth) return +auth[1];
  const utm = /UTM[_ ]zone[_ ](\d+)([NS])/i.exec(s);
  if (utm) { const z = +utm[1]; return /ETRS/i.test(s) ? 25800 + z : (utm[2].toUpperCase() === 'N' ? 32600 : 32700) + z; }
  if (/GEOGCS/i.test(s) && !/PROJCS/i.test(s)) return 4326;
  return 0;
}
