// Raster operations between "file rasters" and the engine grid.
//
// Raster object (north-up, as read from files):  {width, height, data: Float32Array (NaN = no data), x0, yTop, dx, dy, epsg}
// Target grid (south-up, like the engine):        {x0, y0, nx, ny, d}   cell (i, j) centre = (x0 + (i+.5)d, y0 + (j+.5)d)
//
// Why aggregation matters: the engine samples its input terrain at cell centres. Fed a 0.4 m DHM raster on a 1 m grid
// that is point sampling (≈ nearest neighbour): every 0.15 m kerb and every gutter is hit or missed at random
// depending on where the cell centres fall, which makes flow paths and bluespot volumes jitter between runs with
// different extents. Here each target cell is computed from ALL source pixels whose centres fall inside it:
//   mean     (default) unbiased bluespot volumes, smooths sub-cell kerbs/gutters away (stamp kerbs explicitly)
//   min      keeps gutters / channels connected, but lowers ridges and kerbs (more water escapes)
//   max      keeps kerbs and walls as barriers, but closes narrow channels (more ponding)
//   nearest  the pixel at the cell centre (the old behaviour; only for comparison)
// When the source is coarser than the target cell, values are interpolated bilinearly instead.

export const METHODS = {
  mean: 'Mean of all source pixels in the cell (recommended)',
  min: 'Minimum – keeps gutters and channels open',
  max: 'Maximum – keeps kerbs and low walls as barriers',
  nearest: 'Nearest pixel (point sampling, for comparison only)',
};

/** Bilinear sample of a north-up raster at world (x, y); NaN-aware (renormalised weights), NaN outside. */
export function sampleBilinear(r, x, y) {
  const fx = (x - r.x0) / r.dx - 0.5, fy = (r.yTop - y) / r.dy - 0.5;
  const i0 = Math.floor(fx), j0 = Math.floor(fy);
  if (fx < -0.5 || fy < -0.5 || fx > r.width - 0.5 || fy > r.height - 0.5) return NaN;
  const tx = fx - i0, ty = fy - j0; let sw = 0, sv = 0;
  for (let dj = 0; dj <= 1; dj++) {
    const j = Math.min(r.height - 1, Math.max(0, j0 + dj));
    const wy = dj ? ty : 1 - ty; if (wy <= 0) continue;
    for (let di = 0; di <= 1; di++) {
      const i = Math.min(r.width - 1, Math.max(0, i0 + di));
      const w = (di ? tx : 1 - tx) * wy; if (w <= 0) continue;
      const v = r.data[j * r.width + i];
      if (v === v) { sw += w; sv += w * v; }
    }
  }
  return sw > 1e-9 ? sv / sw : NaN;
}

/**
 * Target grid covering `bbox` (or the raster extent), cell size d, snapped INWARD to multiples of d so every cell is
 * fully covered by data and grids from different sources line up.
 */
export function targetGrid(r, d, bbox = null) {
  let [x0, y0, x1, y1] = [r.x0, r.yTop - r.height * r.dy, r.x0 + r.width * r.dx, r.yTop];
  if (bbox) { x0 = Math.max(x0, bbox[0]); y0 = Math.max(y0, bbox[1]); x1 = Math.min(x1, bbox[2]); y1 = Math.min(y1, bbox[3]); }
  const e = 1e-6;
  const gx0 = Math.ceil(x0 / d - e) * d, gy0 = Math.ceil(y0 / d - e) * d;
  const nx = Math.floor((x1 - gx0) / d + e), ny = Math.floor((y1 - gy0) / d + e);
  if (nx < 2 || ny < 2) throw new Error('Terrain area is too small for the chosen cell size.');
  return { x0: gx0, y0: gy0, nx, ny, d };
}

/**
 * Resample a north-up raster in the SAME CRS onto target grid t (south-up Float32Array, NaN = no data).
 * minCoverage: fraction of valid pixels a cell needs (default 0.5), otherwise NaN.
 */
export function aggregate(r, t, method = 'mean', { minCoverage = 0.5 } = {}) {
  const { nx, ny, d } = t; const n = nx * ny;
  const out = new Float32Array(n).fill(NaN);
  const coarse = r.dx > d * 0.75 || r.dy > d * 0.75;
  if (coarse || method === 'nearest') {
    for (let j = 0; j < ny; j++) {
      const y = t.y0 + (j + 0.5) * d;
      for (let i = 0; i < nx; i++) {
        const x = t.x0 + (i + 0.5) * d;
        if (coarse) out[j * nx + i] = sampleBilinear(r, x, y);
        else {
          const c = Math.floor((x - r.x0) / r.dx), rr = Math.floor((r.yTop - y) / r.dy);
          if (c >= 0 && rr >= 0 && c < r.width && rr < r.height) out[j * nx + i] = r.data[rr * r.width + c];
        }
      }
    }
    return out;
  }
  const sum = new Float64Array(n), cnt = new Uint32Array(n), tot = new Uint32Array(n);
  const ext = method === 'min' || method === 'max' ? new Float32Array(n).fill(method === 'min' ? Infinity : -Infinity) : null;
  // column → target i lookup
  const colI = new Int32Array(r.width);
  for (let c = 0; c < r.width; c++) { const i = Math.floor((r.x0 + (c + 0.5) * r.dx - t.x0) / d); colI[c] = i >= 0 && i < nx ? i : -1; }
  for (let rr = 0; rr < r.height; rr++) {
    const j = Math.floor((r.yTop - (rr + 0.5) * r.dy - t.y0) / d);
    if (j < 0 || j >= ny) continue;
    const base = rr * r.width, jb = j * nx;
    for (let c = 0; c < r.width; c++) {
      const i = colI[c]; if (i < 0) continue;
      const k = jb + i; tot[k]++;
      const v = r.data[base + c]; if (v !== v) continue;
      cnt[k]++; sum[k] += v;
      if (ext) ext[k] = method === 'min' ? Math.min(ext[k], v) : Math.max(ext[k], v);
    }
  }
  for (let k = 0; k < n; k++) {
    if (!tot[k] || cnt[k] < tot[k] * minCoverage || !cnt[k]) continue;
    out[k] = ext ? ext[k] : sum[k] / cnt[k];
  }
  return out;
}

/**
 * Resample a raster in ANOTHER CRS onto target grid t in `toCrs`. `fromCrs`/`toCrs` are proj.js CRS objects.
 * Source coordinates of each target cell centre are computed exactly on a coarse lattice and bilinearly interpolated
 * in between (projection distortion across a site is far below a millimetre at that spacing).
 * Downsampling is done by averaging an s×s set of sub-samples per cell, where s follows the resolution ratio.
 */
export function reproject(r, fromCrs, t, toCrs) {
  const { nx, ny, d } = t; const out = new Float32Array(nx * ny).fill(NaN);
  const step = 16; // lattice spacing in cells
  const lx = Math.ceil(nx / step) + 1, ly = Math.ceil(ny / step) + 1;
  const LX = new Float64Array(lx * ly), LY = new Float64Array(lx * ly);
  for (let b = 0; b < ly; b++) for (let a = 0; a < lx; a++) {
    const x = t.x0 + Math.min(nx, a * step) * d, y = t.y0 + Math.min(ny, b * step) * d;
    const ll = toCrs.toLatLon(x, y); const p = fromCrs.fromLatLon(ll.lat, ll.lon);
    LX[b * lx + a] = p.E; LY[b * lx + a] = p.N;
  }
  const src = (x, y) => { // target world (x,y) → source coords via lattice
    const fa = (x - t.x0) / d / step, fb = (y - t.y0) / d / step;
    const a = Math.min(lx - 2, Math.max(0, Math.floor(fa))), b = Math.min(ly - 2, Math.max(0, Math.floor(fb)));
    // cells at the far edge map onto a shorter last lattice span
    const ax = Math.min(nx, a * step), ax1 = Math.min(nx, (a + 1) * step), by = Math.min(ny, b * step), by1 = Math.min(ny, (b + 1) * step);
    const u = ax1 > ax ? ((x - t.x0) / d - ax) / (ax1 - ax) : 0, v = by1 > by ? ((y - t.y0) / d - by) / (by1 - by) : 0;
    const k00 = b * lx + a, k10 = k00 + 1, k01 = k00 + lx, k11 = k01 + 1;
    return [
      (1 - u) * (1 - v) * LX[k00] + u * (1 - v) * LX[k10] + (1 - u) * v * LX[k01] + u * v * LX[k11],
      (1 - u) * (1 - v) * LY[k00] + u * (1 - v) * LY[k10] + (1 - u) * v * LY[k01] + u * v * LY[k11],
    ];
  };
  // sub-sampling factor: source pixel size in target metres
  const p0 = src(t.x0, t.y0), p1 = src(t.x0 + d, t.y0);
  const srcPerCell = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) / Math.max(r.dx, 1e-12);
  const s = Math.max(1, Math.min(8, Math.round(srcPerCell)));
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    let sv = 0, sc = 0;
    for (let b = 0; b < s; b++) for (let a = 0; a < s; a++) {
      const [x, y] = src(t.x0 + (i + (a + 0.5) / s) * d, t.y0 + (j + (b + 0.5) / s) * d);
      const v = sampleBilinear(r, x, y); if (v === v) { sv += v; sc++; }
    }
    if (sc * 2 >= s * s) out[j * nx + i] = sv / sc;
  }
  return out;
}

/** Mosaic north-up rasters with the same pixel size and CRS into one (later rasters fill only no-data cells). */
export function mosaic(rasters) {
  if (rasters.length === 1) return rasters[0];
  const { dx, dy } = rasters[0];
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const r of rasters) {
    if (Math.abs(r.dx - dx) > 1e-9 * dx || Math.abs(r.dy - dy) > 1e-9 * dy) throw new Error('Cannot mosaic rasters with different pixel sizes.');
    x0 = Math.min(x0, r.x0); x1 = Math.max(x1, r.x0 + r.width * r.dx); y1 = Math.max(y1, r.yTop); y0 = Math.min(y0, r.yTop - r.height * r.dy);
  }
  const W = Math.round((x1 - x0) / dx), H = Math.round((y1 - y0) / dy);
  const data = new Float32Array(W * H).fill(NaN);
  const warnings = [];
  for (const r of rasters) {
    const oc = (r.x0 - x0) / dx, orr = (y1 - r.yTop) / dy;
    if (Math.abs(oc - Math.round(oc)) > 0.01 || Math.abs(orr - Math.round(orr)) > 0.01) warnings.push('Mosaic tiles are not pixel-aligned; nearest alignment used.');
    const c0 = Math.round(oc), r0 = Math.round(orr);
    for (let rr = 0; rr < r.height; rr++) for (let c = 0; c < r.width; c++) {
      const v = r.data[rr * r.width + c]; if (v !== v) continue;
      const k = (r0 + rr) * W + c0 + c; if (data[k] !== data[k]) data[k] = v;
    }
    if (r.warnings) warnings.push(...r.warnings);
  }
  return { ...rasters[0], width: W, height: H, data, x0, yTop: y1, warnings: [...new Set(warnings)] };
}

/** Statistics of a grid array (ignores NaN). */
export function stats(a) {
  let min = Infinity, max = -Infinity, n = 0, s = 0;
  for (let k = 0; k < a.length; k++) { const v = a[k]; if (v !== v) continue; n++; s += v; if (v < min) min = v; if (v > max) max = v; }
  return { min, max, mean: n ? s / n : NaN, valid: n, nodata: a.length - n, nodataFraction: a.length ? (a.length - n) / a.length : 1 };
}

/**
 * Encode a south-up target grid as the GeoTIFF the engine expects so that the engine's cell centres land EXACTLY on
 * our values. The engine meshes pixel centres and samples that mesh at the centres of a grid whose origin is the
 * first pixel centre. So we emit a raster at half the cell size whose pixel centres sit on cell corners and cell
 * centres: odd pixels carry the cell values, even pixels the average of their neighbours (only used to close triangles).
 * Build the engine grid with cellSize = t.d to get our values back unchanged.
 * Returns a north-up raster object (pass it to writeGeoTiff).
 */
export function engineRaster(t, values, epsg = 0) {
  const { nx, ny, d } = t; const W = 2 * nx + 1, H = 2 * ny + 1;
  const data = new Float32Array(W * H).fill(NaN);
  // odd/odd = cell centres (north-up row index: R = 2*(ny-1-j)+1)
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) data[(2 * (ny - 1 - j) + 1) * W + 2 * i + 1] = values[j * nx + i];
  for (let R = 0; R < H; R++) for (let C = 0; C < W; C++) {
    if (R & 1 && C & 1) continue;
    let s = 0, c = 0;
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
      const r2 = R + dr, c2 = C + dc; if (r2 < 0 || c2 < 0 || r2 >= H || c2 >= W || !(r2 & 1) || !(c2 & 1)) continue;
      const v = data[r2 * W + c2]; if (v === v) { s += v; c++; }
    }
    if (c) data[R * W + C] = s / c;
  }
  const h = d / 2;
  return { width: W, height: H, data, x0: t.x0 - h / 2, yTop: t.y0 + ny * d + h / 2, dx: h, dy: h, epsg };
}
