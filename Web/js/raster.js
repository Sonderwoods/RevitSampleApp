// Turns engine grids/results into canvases (one pixel per cell, row 0 = NORTH) that the map view scales.
import { hexToRgb } from './colors.js';

function canvasFor(nx, ny) {
  const c = document.createElement('canvas'); c.width = nx; c.height = ny; return c;
}

let matRgbCache = null;
function materialRgb(palette) {
  if (!matRgbCache || matRgbCache.palette !== palette) {
    matRgbCache = { palette, rgb: palette.materials.map((m) => hexToRgb(m.color || '#999999')) };
  }
  return matRgbCache.rgb;
}

/**
 * Base map: hypsometric tint × hillshade, optional material tint. Buildings are NOT drawn here (see buildingsCanvas).
 * materialMix 0..1 blends material colours in.
 */
export function baseCanvas(grid, palette, materialMix = 0.22) {
  const { nx, ny, dx, terrainZ: z, material } = grid;
  const n = nx * ny;
  // robust elevation range (2–98 %)
  const sample = [];
  const step = Math.max(1, Math.floor(n / 4000));
  for (let k = 0; k < n; k += step) if (isFinite(z[k])) sample.push(z[k]);
  sample.sort((a, b) => a - b);
  const zlo = sample[Math.floor(sample.length * 0.02)] ?? 0, zhi = sample[Math.floor(sample.length * 0.98)] ?? 1;
  const zr = Math.max(0.5, zhi - zlo);
  const lo = [196, 207, 212], hi = [238, 233, 222];
  const mats = materialRgb(palette);
  const zf = 3.0; // vertical exaggeration for shading flat urban terrain
  const L = [-0.5, 0.5, 0.7071]; // light from NW
  const c = canvasFor(nx, ny); const ctx = c.getContext('2d');
  const img = ctx.createImageData(nx, ny); const d = img.data;
  for (let j = 0; j < ny; j++) {
    const jn = Math.min(ny - 1, j + 1), js = Math.max(0, j - 1);
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      const ie = Math.min(nx - 1, i + 1), iw = Math.max(0, i - 1);
      const zc = z[k];
      const dzdx = ((z[j * nx + ie] - z[j * nx + iw]) / ((ie - iw) * dx || 1)) * zf;
      const dzdy = ((z[jn * nx + i] - z[js * nx + i]) / ((jn - js) * dx || 1)) * zf;
      const len = Math.hypot(dzdx, dzdy, 1);
      let shade = (-dzdx * L[0] - dzdy * L[1] + L[2]) / len; // 0.707 when flat
      shade = 0.62 + 0.55 * shade;
      const t = Math.max(0, Math.min(1, (zc - zlo) / zr));
      let r = lo[0] + (hi[0] - lo[0]) * t, g = lo[1] + (hi[1] - lo[1]) * t, b = lo[2] + (hi[2] - lo[2]) * t;
      const m = mats[material[k]];
      if (m && materialMix > 0) { r += (m[0] - r) * materialMix; g += (m[1] - g) * materialMix; b += (m[2] - b) * materialMix; }
      const o = ((ny - 1 - j) * nx + i) * 4;
      d[o] = r * shade; d[o + 1] = g * shade; d[o + 2] = b * shade; d[o + 3] = isFinite(zc) && grid.active[k] ? 255 : 90;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

/** Building mask (used when no vector footprints exist, e.g. uploaded terrain, and for thumbnails). */
export function buildingsCanvas(grid) {
  const { nx, ny, building, z, terrainZ } = grid;
  const c = canvasFor(nx, ny); const ctx = c.getContext('2d');
  const img = ctx.createImageData(nx, ny); const d = img.data;
  let any = false;
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const k = j * nx + i; if (building[k] < 0) continue; any = true;
    const ht = Math.max(0, z[k] - terrainZ[k]);
    const v = 62 + Math.min(30, ht * 1.4);
    const o = ((ny - 1 - j) * nx + i) * 4;
    d[o] = v; d[o + 1] = v + 5; d[o + 2] = v + 13; d[o + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return any ? c : null;
}

/**
 * Classified overlay. `values` is a per-cell array; `ramp.index(v)` → class (or -1). Water is never drawn on buildings.
 * The field is bilinearly up-sampled (to ~0.5 m pixels) before classification, so class boundaries are smooth curves
 * instead of cell staircases when zoomed in.
 */
export function overlayCanvas(grid, values, ramp, { alpha = 235, mask = null, upsample = true } = {}) {
  const { nx, ny, building, dx } = grid;
  let u = upsample ? Math.max(1, Math.min(4, Math.round(dx / 0.5))) : 1;
  while (u > 1 && nx * ny * u * u > 2_400_000) u--;
  const W = nx * u, H = ny * u;
  const c = canvasFor(W, H); const ctx = c.getContext('2d');
  const img = ctx.createImageData(W, H); const d = img.data;
  const rgb = ramp.rgb;
  if (u === 1) {
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      if (building[k] >= 0 || (mask && !mask(k))) continue;
      const ci = ramp.index(values[k]); if (ci < 0) continue;
      const col = rgb[ci]; const o = ((ny - 1 - j) * nx + i) * 4;
      d[o] = col[0]; d[o + 1] = col[1]; d[o + 2] = col[2]; d[o + 3] = alpha;
    }
  } else {
    const val = (i, j) => { const k = j * nx + i; return building[k] >= 0 ? NaN : values[k]; };
    for (let py = 0; py < H; py++) {
      const fj = (H - py - 0.5) / u - 0.5; // cell-centre coordinates, j = 0 south
      let j0 = Math.floor(fj); const ty = fj - j0; j0 = Math.max(0, Math.min(ny - 1, j0)); const j1 = Math.min(ny - 1, j0 + 1);
      const jn = Math.max(0, Math.min(ny - 1, Math.round(fj)));
      for (let px = 0; px < W; px++) {
        const fi = (px + 0.5) / u - 0.5;
        const inr = Math.max(0, Math.min(nx - 1, Math.round(fi)));
        const kn = jn * nx + inr;
        if (building[kn] >= 0 || (mask && !mask(kn))) continue;
        let i0 = Math.floor(fi); const tx = fi - i0; i0 = Math.max(0, Math.min(nx - 1, i0)); const i1 = Math.min(nx - 1, i0 + 1);
        // bilinear, ignoring building neighbours (renormalised weights)
        let sw = 0, sv = 0, v;
        v = val(i0, j0); if (v === v) { const w = (1 - tx) * (1 - ty); sw += w; sv += w * v; }
        v = val(i1, j0); if (v === v) { const w = tx * (1 - ty); sw += w; sv += w * v; }
        v = val(i0, j1); if (v === v) { const w = (1 - tx) * ty; sw += w; sv += w * v; }
        v = val(i1, j1); if (v === v) { const w = tx * ty; sw += w; sv += w * v; }
        if (sw <= 0) continue;
        const ci = ramp.index(sv / sw); if (ci < 0) continue;
        const col = rgb[ci]; const o = (py * W + px) * 4;
        d[o] = col[0]; d[o + 1] = col[1]; d[o + 2] = col[2]; d[o + 3] = alpha;
      }
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

/** Strong material map (Materials layer). */
export function materialCanvas(grid, palette) {
  const { nx, ny, material } = grid; const mats = materialRgb(palette);
  const c = canvasFor(nx, ny); const ctx = c.getContext('2d');
  const img = ctx.createImageData(nx, ny); const d = img.data;
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const k = j * nx + i; const m = mats[material[k]]; if (!m) continue;
    const o = ((ny - 1 - j) * nx + i) * 4;
    d[o] = m[0]; d[o + 1] = m[1]; d[o + 2] = m[2]; d[o + 3] = 200;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

/** Materials present on the grid sorted by area (for the legend). */
export function materialsPresent(grid, palette) {
  const cnt = new Map();
  for (let k = 0; k < grid.material.length; k++) if (grid.building[k] < 0) cnt.set(grid.material[k], (cnt.get(grid.material[k]) || 0) + 1);
  return [...cnt.entries()].sort((a, b) => b[1] - a[1]).slice(0, 9)
    .map(([idx, c]) => ({ ...palette.materials[idx], areaM2: c * grid.dx * grid.dx })).filter((m) => m.id);
}

/** Sample `values` of grid `g` at world (x, y); returns undefined outside. */
export function sampleAt(g, values, x, y) {
  const i = Math.floor((x - g.x0) / g.dx), j = Math.floor((y - g.y0) / g.dx);
  if (i < 0 || j < 0 || i >= g.nx || j >= g.ny) return undefined;
  return values[j * g.nx + i];
}
export function cellAt(g, x, y) {
  const i = Math.floor((x - g.x0) / g.dx), j = Math.floor((y - g.y0) / g.dx);
  if (i < 0 || j < 0 || i >= g.nx || j >= g.ny) return -1;
  return j * g.nx + i;
}

/** Difference (B − A) on A's grid, sampling B by world coordinates (handles different cell sizes). */
export function differenceArray(gA, dA, gB, dB) {
  const out = new Float32Array(gA.nx * gA.ny);
  const same = gA.nx === gB.nx && gA.ny === gB.ny && gA.dx === gB.dx && gA.x0 === gB.x0 && gA.y0 === gB.y0;
  for (let j = 0; j < gA.ny; j++) for (let i = 0; i < gA.nx; i++) {
    const k = j * gA.nx + i;
    let b;
    if (same) b = dB[k];
    else b = sampleAt(gB, dB, gA.x0 + (i + 0.5) * gA.dx, gA.y0 + (j + 0.5) * gA.dx) ?? 0;
    const bb = gB.building && (same ? gB.building[k] >= 0 : false);
    out[k] = (b || 0) * (bb ? 0 : 1) - (dA[k] || 0);
  }
  return out;
}
