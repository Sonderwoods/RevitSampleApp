// Print-resolution map rasters for the PDF report. Each map is rendered off-screen at a fixed extent and DPI, so the
// same world extent and colour scale can be used for every option (side-by-side and difference maps line up exactly).
// Vector furniture (legend, scale bar, north arrow, bluespot numbers) is drawn by report-pdf.js on top of the image.
import { DEPTH, VELOCITY, HAZARD, DIFF } from './colors.js';
import { baseCanvas, buildingsCanvas, overlayCanvas, materialCanvas } from './raster.js';
import { MapView } from './mapview.js';

export const PRINT_DPI = 220; // >= 200 dpi at printed size (brief); 220 keeps A4 maps at ~1.5–2.3 k px
const MM_PER_IN = 25.4;
const CSS_DPI = 96; // line widths / label sizes in mapview.js are in CSS px

const withMin = (ramp, min) => ({ ...ramp, min, index: (v) => (v >= min ? ramp.index(v) : -1) });
export const RAMPS = { depth: DEPTH, dynDepth: withMin(DEPTH, 0.03), velocity: VELOCITY, hazard: HAZARD, diff: DIFF };

/** World extent of a grid. */
export function gridExtent(g) { return { x0: g.x0, y0: g.y0, x1: g.x0 + g.nx * g.dx, y1: g.y0 + g.ny * g.dx }; }
/** Union of several extents (side-by-side maps share one). */
export function unionExtent(list) {
  return list.reduce((a, e) => ({ x0: Math.min(a.x0, e.x0), y0: Math.min(a.y0, e.y0), x1: Math.max(a.x1, e.x1), y1: Math.max(a.y1, e.y1) }));
}
/** Largest map box (mm) with the extent's aspect ratio that fits in maxW × maxH. */
export function fitBox(extent, maxW, maxH) {
  const aspect = (extent.y1 - extent.y0) / (extent.x1 - extent.x0);
  let w = maxW, h = maxW * aspect;
  if (h > maxH) { h = maxH; w = maxH / aspect; }
  return { w, h, mmPerM: w / (extent.x1 - extent.x0) };
}

const baseCache = new WeakMap();
function baseFor(grid, palette) {
  if (!baseCache.has(grid)) baseCache.set(grid, baseCanvas(grid, palette));
  return baseCache.get(grid);
}

/**
 * Scene for one map (same shape mapview.js draws). layer: depth | dynDepth | velocity | hazard | materials | diff.
 * `diff` = { grid, values, proposal } (proposal = record whose base/buildings are drawn under the change).
 */
function sceneFor(layer, rec, palette, diff) {
  const src = layer === 'diff' ? diff.proposal : rec;
  const g = src.grid;
  const scene = {
    grid: g, base: src.base || baseFor(g, palette),
    buildingsVec: src.buildingsVec || null, buildingsRaster: src.buildingsVec ? null : (src.buildingsRaster || buildingsCanvas(g)),
  };
  if (layer === 'depth') { scene.overlay = overlayCanvas(g, rec.instant.depth, DEPTH); scene.paths = rec.instant.paths; }
  else if (layer === 'materials') scene.overlay = materialCanvas(g, palette);
  else if (layer === 'diff') { scene.overlay = overlayCanvas(diff.grid, diff.values, DIFF, { alpha: 240 }); scene.overlayGrid = diff.grid; }
  else {
    const d = rec.dyn; const wet = (k) => d.hMax[k] >= 0.03;
    scene.overlayGrid = d.grid;
    if (layer === 'dynDepth') scene.overlay = overlayCanvas(d.grid, d.hMax, RAMPS.dynDepth);
    else if (layer === 'velocity') scene.overlay = overlayCanvas(d.grid, d.vMax, VELOCITY, { mask: wet });
    else if (layer === 'hazard') scene.overlay = overlayCanvas(d.grid, d.hazard, HAZARD, { mask: wet });
  }
  return scene;
}

/**
 * Render a map to a JPEG data URL at print resolution.
 * @returns {{ dataUrl, pxW, pxH, wMm, hMm, extent, mmPerM, toMm(x,y) }}
 */
export function renderMap({ layer, rec, palette, extent, wMm, hMm, dpi = PRINT_DPI, diff = null, showPaths = true, quality = 0.86 }) {
  const pxW = Math.round((wMm / MM_PER_IN) * dpi), pxH = Math.round((hMm / MM_PER_IN) * dpi);
  const c = document.createElement('canvas'); c.width = pxW; c.height = pxH;
  const ctx = c.getContext('2d');
  const s = dpi / CSS_DPI; // CSS px → device px, so label sizes and line widths print at their on-screen size
  const W = pxW / s, H = pxH / s;
  const cam = { cx: (extent.x0 + extent.x1) / 2, cy: (extent.y0 + extent.y1) / 2, k: W / (extent.x1 - extent.x0) };
  const scene = sceneFor(layer, rec, palette, diff);
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, pxW, pxH);
  try {
    // Reuse the app's own drawing (buildings, smoothed flow paths) without a live, event-bound MapView.
    const mv = Object.create(MapView.prototype);
    Object.assign(mv, { scenes: [], mode: 'single', showPaths: showPaths && !!scene.paths, showLabels: false, animatePaths: false, highlight: null, request() {} });
    mv.setScenes([scene]);
    ctx.setTransform(s, 0, 0, s, 0, 0);
    mv.draw(ctx, W, H, cam, 0, { exportMode: true });
  } catch (e) {
    console.warn('report map: falling back to plain composite', e);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    plainComposite(ctx, scene, extent, pxW, pxH);
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const mmPerM = wMm / (extent.x1 - extent.x0);
  return {
    dataUrl: c.toDataURL('image/jpeg', quality), pxW, pxH, wMm, hMm, extent, mmPerM, dpi,
    toMm: (x, y) => [(x - extent.x0) * mmPerM, (extent.y1 - y) * mmPerM],
  };
}

function plainComposite(ctx, scene, e, W, H) {
  const k = W / (e.x1 - e.x0);
  const put = (img, g) => { if (img) ctx.drawImage(img, (g.x0 - e.x0) * k, (e.y1 - (g.y0 + g.ny * g.dx)) * k, g.nx * g.dx * k, g.ny * g.dx * k); };
  ctx.imageSmoothingEnabled = true;
  put(scene.base, scene.grid); put(scene.overlay, scene.overlayGrid || scene.grid); put(scene.buildingsRaster || buildingsCanvas(scene.grid), scene.grid);
}

/** A "nice" scale-bar length (m) close to targetM. */
export function niceLength(targetM) {
  const p = Math.pow(10, Math.floor(Math.log10(targetM)));
  return [1, 2, 5, 10].map((m) => m * p).reduce((a, b) => (Math.abs(b - targetM) < Math.abs(a - targetM) ? b : a));
}
