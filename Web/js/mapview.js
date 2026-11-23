// 2D map: pan/zoom canvas that composites scene layers (base hillshade, results overlay, buildings, flow paths,
// bluespot labels) in world coordinates (metres, y north). No external dependencies.
import { clamp } from './util.js';

const BG = '#0b1320';

export class MapView {
  constructor(canvas, { onHover, onLeave, onClick } = {}) {
    this.canvas = canvas; this.ctx = canvas.getContext('2d');
    this.cam = { cx: 0, cy: 0, k: 1 };
    this.scenes = []; this.mode = 'single'; this.swipe = 0.5;
    this.showPaths = true; this.showLabels = true; this.animatePaths = true;
    this.onHover = onHover; this.onLeave = onLeave; this.onClick = onClick;
    this.highlight = null; this.anim = null; this._raf = 0; this._t0 = performance.now();
    this._bindEvents();
    this.ro = new ResizeObserver(() => this.resize()); this.ro.observe(canvas.parentElement);
    this.resize();
  }

  // ---------- scenes
  /** scene: {grid, base, overlay?, overlayGrid?, buildingsRaster?, buildingsVec?, paths?, labels?, tag?} */
  setScenes(scenes, mode = 'single') {
    this.scenes = scenes.filter(Boolean); this.mode = this.scenes.length > 1 ? mode : 'single';
    for (const s of this.scenes) if (s.paths && !s._pathCache) s._pathCache = buildPathCache(s.paths, s.grid);
    this.request();
  }
  setPaths(scene, paths) { scene.paths = paths; if (scene._pathsSrc !== paths) { scene._pathsSrc = paths; scene._pathCache = paths ? buildPathCache(paths, scene.grid) : null; } this.request(); }

  extent() {
    const g = this.scenes[0] && this.scenes[0].grid; if (!g) return null;
    return { xmin: g.x0, ymin: g.y0, xmax: g.x0 + g.nx * g.dx, ymax: g.y0 + g.ny * g.dx };
  }
  fit(animate = false, pad = 0.08) {
    const e = this.extent(); if (!e) return;
    const W = this.W, H = this.H;
    const k = Math.min(W / ((e.xmax - e.xmin) * (1 + 2 * pad)), H / ((e.ymax - e.ymin) * (1 + 2 * pad)));
    const target = { cx: (e.xmin + e.xmax) / 2, cy: (e.ymin + e.ymax) / 2, k };
    if (animate) this.flyTo(target); else { this.cam = target; this.request(); }
  }
  flyTo(target, ms = 650) {
    const from = { ...this.cam }; const t0 = performance.now();
    const lk0 = Math.log(from.k), lk1 = Math.log(target.k ?? from.k);
    this.anim = (now) => {
      const t = clamp((now - t0) / ms, 0, 1); const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      this.cam = { cx: from.cx + (target.cx - from.cx) * e, cy: from.cy + (target.cy - from.cy) * e, k: Math.exp(lk0 + (lk1 - lk0) * e) };
      if (t >= 1) this.anim = null;
    };
    this.request();
  }
  zoomBy(f, sx = this.W / 2, sy = this.H / 2) {
    const [wx, wy] = this.toWorld(sx, sy);
    const k = clamp(this.cam.k * f, this.minK(), 60);
    this.cam.k = k;
    this.cam.cx = wx - (sx - this.W / 2) / k; this.cam.cy = wy + (sy - this.H / 2) / k;
    this.request();
  }
  minK() { const e = this.extent(); if (!e) return 0.01; return 0.3 * Math.min(this.W / (e.xmax - e.xmin), this.H / (e.ymax - e.ymin)); }
  toWorld(sx, sy) { return [this.cam.cx + (sx - this.W / 2) / this.cam.k, this.cam.cy - (sy - this.H / 2) / this.cam.k]; }
  toScreen(x, y, cam = this.cam, W = this.W, H = this.H) { return [W / 2 + (x - cam.cx) * cam.k, H / 2 - (y - cam.cy) * cam.k]; }

  resize() {
    const r = this.canvas.parentElement.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const first = !this.W;
    this.W = Math.max(50, r.width); this.H = Math.max(50, r.height); this.dpr = dpr;
    this.canvas.width = Math.round(this.W * dpr); this.canvas.height = Math.round(this.H * dpr);
    this.canvas.style.width = `${this.W}px`; this.canvas.style.height = `${this.H}px`;
    if (first && this.scenes.length) this.fit();
    this.request();
  }

  request() { if (!this._raf) this._raf = requestAnimationFrame((t) => this._frame(t)); }
  _frame(now) {
    this._raf = 0;
    if (this.anim) this.anim(now);
    const ctx = this.ctx; ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.draw(ctx, this.W, this.H, this.cam, now);
    const pathsAnimating = this.showPaths && this.animatePaths && this.scenes.some((s) => s._pathCache) && !document.hidden;
    if (this.anim || pathsAnimating || this.highlight) this.request();
  }

  // ---------- drawing (also used for PNG export)
  draw(ctx, W, H, cam, now = performance.now(), { exportMode = false } = {}) {
    ctx.save();
    ctx.fillStyle = BG; ctx.fillRect(0, 0, W, H);
    if (!exportMode) this._drawGridPattern(ctx, W, H, cam);
    const scenes = this.scenes;
    if (!scenes.length) { ctx.restore(); return; }
    if (this.mode === 'swipe' && scenes[1]) {
      const sx = Math.round(W * this.swipe);
      ctx.save(); ctx.beginPath(); ctx.rect(0, 0, sx, H); ctx.clip(); this._drawScene(ctx, scenes[0], W, H, cam, now, exportMode); ctx.restore();
      ctx.save(); ctx.beginPath(); ctx.rect(sx, 0, W - sx, H); ctx.clip(); this._drawScene(ctx, scenes[1], W, H, cam, now, exportMode); ctx.restore();
      this._drawSwipeHandle(ctx, sx, H, scenes);
    } else this._drawScene(ctx, scenes[0], W, H, cam, now, exportMode);
    if (!exportMode) this._drawScaleNorth(ctx, W, H, cam);
    ctx.restore();
  }

  _drawGridPattern(ctx, W, H) {
    ctx.fillStyle = 'rgba(120,160,210,0.055)';
    for (let x = 12; x < W; x += 24) for (let y = 12; y < H; y += 24) ctx.fillRect(x, y, 1.2, 1.2);
  }

  _imgRect(g, cam, W, H) {
    const [x0, y1] = this.toScreen(g.x0, g.y0 + g.ny * g.dx, cam, W, H);
    return [x0, y1, g.nx * g.dx * cam.k, g.ny * g.dx * cam.k];
  }

  _drawScene(ctx, s, W, H, cam, now, exportMode) {
    const g = s.grid;
    const [ix, iy, iw, ih] = this._imgRect(g, cam, W, H);
    // site card shadow
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.55)'; ctx.shadowBlur = 28; ctx.shadowOffsetY = 8;
    ctx.fillStyle = '#c9d1d6'; ctx.fillRect(ix, iy, iw, ih);
    ctx.restore();
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(s.base, ix, iy, iw, ih);
    if (s.overlay) {
      const og = s.overlayGrid || g; const [ox, oy, ow, oh] = this._imgRect(og, cam, W, H);
      const pxPerCell = og.dx * cam.k;
      ctx.imageSmoothingEnabled = s.overlay.width > og.nx || pxPerCell < 6; // up-sampled overlays always smooth
      ctx.globalAlpha = s.overlayAlpha ?? 1;
      ctx.drawImage(s.overlay, ox, oy, ow, oh);
      ctx.globalAlpha = 1; ctx.imageSmoothingEnabled = true;
    }
    this._drawBuildings(ctx, s, cam, W, H);
    if (this.showPaths && s._pathCache && !s.hidePaths) this._drawPaths(ctx, s._pathCache, cam, W, H, now, exportMode);
    if (this.showLabels && s.labels) this._drawLabels(ctx, s.labels, cam, W, H);
    if (this.highlight && this.highlight.scene === s) this._drawHighlight(ctx, cam, W, H, now);
    // thin frame
    ctx.strokeStyle = 'rgba(255,255,255,0.18)'; ctx.lineWidth = 1; ctx.strokeRect(ix + 0.5, iy + 0.5, iw - 1, ih - 1);
  }

  _drawBuildings(ctx, s, cam, W, H) {
    const k = cam.k;
    if (s.buildingsVec && s.buildingsVec.length) {
      // shadows first (cast to SE, proportional to height, clamped)
      ctx.save();
      for (const b of s.buildingsVec) {
        const off = clamp(b.height * 0.22 * k, 1, 26);
        ctx.fillStyle = 'rgba(20,28,40,0.28)';
        ctx.beginPath();
        b.xs.forEach((x, i) => { const [sx, sy] = this.toScreen(x, b.ys[i], cam, W, H); i ? ctx.lineTo(sx + off, sy + off) : ctx.moveTo(sx + off, sy + off); });
        ctx.closePath(); ctx.fill();
      }
      for (const b of s.buildingsVec) {
        ctx.beginPath();
        b.xs.forEach((x, i) => { const [sx, sy] = this.toScreen(x, b.ys[i], cam, W, H); i ? ctx.lineTo(sx, sy) : ctx.moveTo(sx, sy); });
        ctx.closePath();
        const v = Math.round(58 + Math.min(26, b.height * 1.2));
        ctx.fillStyle = `rgb(${v},${v + 6},${v + 15})`; ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,0.22)'; ctx.lineWidth = 1; ctx.stroke();
      }
      if (k > 2.2) {
        ctx.font = '600 11px Inter, system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        for (const b of s.buildingsVec) {
          const cx = b.xs.reduce((a, v) => a + v, 0) / b.xs.length, cy = b.ys.reduce((a, v) => a + v, 0) / b.ys.length;
          const [sx, sy] = this.toScreen(cx, cy, cam, W, H);
          ctx.fillStyle = 'rgba(255,255,255,0.75)'; ctx.fillText(b.name || '', sx, sy - 7);
          ctx.fillStyle = 'rgba(255,255,255,0.45)'; ctx.font = '500 10px Inter, system-ui, sans-serif'; ctx.fillText(`${b.height} m`, sx, sy + 7);
          ctx.font = '600 11px Inter, system-ui, sans-serif';
        }
      }
      ctx.restore();
    } else if (s.buildingsRaster) {
      const [ix, iy, iw, ih] = this._imgRect(s.grid, cam, W, H);
      ctx.save();
      ctx.shadowColor = 'rgba(20,28,40,0.45)'; ctx.shadowOffsetX = clamp(2 * k, 1, 10); ctx.shadowOffsetY = clamp(2 * k, 1, 10); ctx.shadowBlur = 4;
      ctx.imageSmoothingEnabled = s.grid.dx * k < 4;
      ctx.drawImage(s.buildingsRaster, ix, iy, iw, ih);
      ctx.restore();
    }
  }

  _drawPaths(ctx, cache, cam, W, H, now, exportMode) {
    ctx.save();
    ctx.setTransform(...this._worldTransform(ctx, cam, W, H));
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    const k = cam.k; const zoomW = clamp(Math.sqrt(k / 2), 0.75, 1.8);
    for (const b of cache.buckets) { ctx.strokeStyle = 'rgba(255,255,255,0.42)'; ctx.lineWidth = (b.w * zoomW + 1.6) / k; ctx.stroke(b.path); }
    for (const b of cache.buckets) { ctx.strokeStyle = 'rgba(24,104,214,0.95)'; ctx.lineWidth = (b.w * zoomW) / k; ctx.stroke(b.path); }
    if (!exportMode && this.animatePaths && cache.flow) {
      const off = ((now - this._t0) / 1000) * 22; // px/s along the flow direction
      ctx.setLineDash([4 / k, 14 / k]); ctx.lineDashOffset = -off / k;
      ctx.strokeStyle = 'rgba(214,240,255,0.9)'; ctx.lineWidth = 1.3 / k; ctx.stroke(cache.flow);
    }
    ctx.restore();
  }
  _worldTransform(ctx, cam, W, H) {
    const t = ctx.getTransform(); // includes dpr scaling
    const s = t.a; // uniform scale
    return [s * cam.k, 0, 0, -s * cam.k, t.e + s * (W / 2 - cam.cx * cam.k), t.f + s * (H / 2 + cam.cy * cam.k)];
  }

  _drawLabels(ctx, labels, cam, W, H) {
    ctx.save();
    ctx.font = '600 11.5px Inter, system-ui, sans-serif'; ctx.textBaseline = 'middle';
    const placed = [];
    for (const L of labels) {
      const [sx, sy] = this.toScreen(L.x, L.y, cam, W, H);
      if (sx < -50 || sy < -50 || sx > W + 50 || sy > H + 50) continue;
      const tw = ctx.measureText(L.text).width; const bw = tw + 22, bh = 22;
      const bx = sx + 8, by = sy - bh - 8;
      if (placed.some((p) => bx < p[0] + p[2] && bx + bw > p[0] && by < p[1] + p[3] && by + bh > p[1])) continue;
      placed.push([bx, by, bw, bh]);
      // leader + dot
      ctx.strokeStyle = 'rgba(11,19,32,0.85)'; ctx.lineWidth = 1.2; ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(bx + 6, by + bh); ctx.stroke();
      ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(sx, sy, 3.6, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = L.spills ? '#f59e0b' : '#0b1320'; ctx.beginPath(); ctx.arc(sx, sy, 2.2, 0, Math.PI * 2); ctx.fill();
      ctx.shadowColor = 'rgba(0,0,0,0.35)'; ctx.shadowBlur = 8; ctx.shadowOffsetY = 2;
      ctx.fillStyle = 'rgba(11,19,32,0.88)'; roundRect(ctx, bx, by, bw, bh, 11); ctx.fill();
      ctx.shadowColor = 'transparent';
      ctx.fillStyle = L.spills ? '#f59e0b' : '#4fa8e0'; ctx.beginPath(); ctx.arc(bx + 10, by + bh / 2, 3, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#eef5ff'; ctx.fillText(L.text, bx + 17, by + bh / 2 + 0.5);
    }
    ctx.restore();
  }

  _drawHighlight(ctx, cam, W, H, now) {
    const hl = this.highlight; const [sx, sy] = this.toScreen(hl.x, hl.y, cam, W, H);
    const age = now - hl.t0; if (age < 0) return;
    const fade = clamp(1 - (age - 3200) / 600, 0, 1); if (fade <= 0) { this.highlight = null; return; }
    ctx.globalAlpha = fade;
    const r0 = Math.max(10, hl.r * cam.k);
    const t = ((now - hl.t0) % 1300) / 1300;
    ctx.save();
    ctx.strokeStyle = `rgba(255,255,255,${0.9 * (1 - t)})`; ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.arc(sx, sy, r0 + t * 22, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,0.95)'; ctx.setLineDash([5, 4]); ctx.lineWidth = 1.6;
    ctx.beginPath(); ctx.arc(sx, sy, r0, 0, Math.PI * 2); ctx.stroke();
    ctx.restore(); ctx.globalAlpha = 1;
  }

  _drawSwipeHandle(ctx, sx, H, scenes) {
    ctx.save();
    ctx.fillStyle = 'rgba(255,255,255,0.95)'; ctx.fillRect(sx - 1, 0, 2, H);
    ctx.shadowColor = 'rgba(0,0,0,0.4)'; ctx.shadowBlur = 10;
    ctx.beginPath(); ctx.arc(sx, H / 2, 17, 0, Math.PI * 2); ctx.fillStyle = '#fff'; ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.strokeStyle = '#0b1320'; ctx.lineWidth = 2; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.beginPath(); ctx.moveTo(sx - 5, H / 2 - 5); ctx.lineTo(sx - 10, H / 2); ctx.lineTo(sx - 5, H / 2 + 5);
    ctx.moveTo(sx + 5, H / 2 - 5); ctx.lineTo(sx + 10, H / 2); ctx.lineTo(sx + 5, H / 2 + 5); ctx.stroke();
    ctx.font = '700 12px Inter, system-ui, sans-serif'; ctx.textBaseline = 'middle';
    const tag = (text, x, align, color) => {
      const tw = ctx.measureText(text).width + 20; const bx = align === 'right' ? x - tw : x;
      ctx.fillStyle = 'rgba(11,19,32,0.86)'; roundRect(ctx, bx, 64, tw, 26, 13); ctx.fill();
      ctx.fillStyle = color; ctx.textAlign = 'left'; ctx.fillText(text, bx + 10, 77.5);
    };
    tag(scenes[0].tag || 'A', sx - 12, 'right', '#cfe6ff');
    tag(scenes[1].tag || 'B', sx + 12, 'left', '#cfe6ff');
    ctx.restore();
  }

  _drawScaleNorth(ctx, W, H, cam) {
    // scale bar
    const target = 110 / cam.k; const p = Math.pow(10, Math.floor(Math.log10(target)));
    const nice = [1, 2, 5, 10].map((m) => m * p).reduce((a, b) => (Math.abs(b - target) < Math.abs(a - target) ? b : a));
    const len = nice * cam.k; const x = W - len - 92, y = H - (this.bottomInset ?? 26);
    ctx.save();
    ctx.fillStyle = 'rgba(11,19,32,0.82)'; roundRect(ctx, x - 12, y - 22, len + 24 + 56, 36, 10); ctx.fill(); ctx.strokeStyle = 'rgba(148,178,220,0.18)'; ctx.lineWidth = 1; ctx.stroke();
    ctx.fillStyle = '#e6eef8'; ctx.fillRect(x, y, len / 2, 4); ctx.fillStyle = 'rgba(230,238,248,0.35)'; ctx.fillRect(x + len / 2, y, len / 2, 4);
    ctx.strokeStyle = '#e6eef8'; ctx.lineWidth = 1; ctx.strokeRect(x + 0.5, y + 0.5, len - 1, 3.5);
    ctx.font = '600 10.5px Inter, system-ui, sans-serif'; ctx.textBaseline = 'alphabetic'; ctx.fillStyle = '#e6eef8';
    ctx.textAlign = 'left'; ctx.fillText('0', x - 2, y - 6); ctx.textAlign = 'right'; ctx.fillText(`${nice >= 1000 ? nice / 1000 + ' km' : nice + ' m'}`, x + len + 2, y - 6);
    // north arrow
    const nx = x + len + 34, ny = y - 4;
    ctx.beginPath(); ctx.moveTo(nx, ny - 12); ctx.lineTo(nx + 6, ny + 6); ctx.lineTo(nx, ny + 2); ctx.closePath(); ctx.fillStyle = '#e6eef8'; ctx.fill();
    ctx.beginPath(); ctx.moveTo(nx, ny - 12); ctx.lineTo(nx - 6, ny + 6); ctx.lineTo(nx, ny + 2); ctx.closePath(); ctx.fillStyle = 'rgba(230,238,248,0.45)'; ctx.fill();
    ctx.textAlign = 'center'; ctx.font = '700 9.5px Inter, system-ui, sans-serif'; ctx.fillStyle = '#e6eef8'; ctx.fillText('N', nx + 14, ny + 4);
    ctx.restore();
  }

  /** Render the full extent to a PNG-ready canvas. */
  renderExport(widthPx = 2000) {
    const e = this.extent(); const aspect = (e.ymax - e.ymin) / (e.xmax - e.xmin);
    const W = widthPx, H = Math.round(widthPx * aspect);
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const ctx = c.getContext('2d');
    const cam = { cx: (e.xmin + e.xmax) / 2, cy: (e.ymin + e.ymax) / 2, k: W / (e.xmax - e.xmin) };
    this.draw(ctx, W, H, cam, performance.now(), { exportMode: true });
    const bi = this.bottomInset; this.bottomInset = 26; this._drawScaleNorth(ctx, W, H, cam); this.bottomInset = bi;
    return c;
  }

  // ---------- interaction
  _bindEvents() {
    const c = this.canvas; let drag = null;
    c.addEventListener('wheel', (e) => {
      e.preventDefault(); this.anim = null;
      const r = c.getBoundingClientRect();
      this.zoomBy(Math.exp(-e.deltaY * (e.deltaMode ? 0.05 : 0.0016)), e.clientX - r.left, e.clientY - r.top);
    }, { passive: false });
    c.addEventListener('pointerdown', (e) => {
      const r = c.getBoundingClientRect(); const sx = e.clientX - r.left;
      c.setPointerCapture(e.pointerId); this.anim = null;
      if (this.mode === 'swipe' && Math.abs(sx - this.W * this.swipe) < 22) drag = { swipe: true };
      else drag = { x: e.clientX, y: e.clientY, cx: this.cam.cx, cy: this.cam.cy, moved: false };
      c.classList.add('dragging');
    });
    c.addEventListener('pointermove', (e) => {
      const r = c.getBoundingClientRect(); const sx = e.clientX - r.left, sy = e.clientY - r.top;
      if (drag && drag.swipe) { this.swipe = clamp(sx / this.W, 0.03, 0.97); this.request(); return; }
      if (drag) {
        const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
        if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
        this.cam.cx = drag.cx - dx / this.cam.k; this.cam.cy = drag.cy + dy / this.cam.k; this.request();
      }
      c.style.cursor = this.mode === 'swipe' && Math.abs(sx - this.W * this.swipe) < 22 ? 'ew-resize' : (drag ? 'grabbing' : 'crosshair');
      if (this.onHover) { const [wx, wy] = this.toWorld(sx, sy); this.onHover(wx, wy, sx, sy, sx > this.W * this.swipe ? 1 : 0); }
    });
    const end = (e) => {
      if (drag && !drag.swipe && !drag.moved && this.onClick) { const r = c.getBoundingClientRect(); this.onClick(...this.toWorld(e.clientX - r.left, e.clientY - r.top)); }
      drag = null; c.classList.remove('dragging');
    };
    c.addEventListener('pointerup', end); c.addEventListener('pointercancel', end);
    c.addEventListener('pointerleave', () => this.onLeave && this.onLeave());
    c.addEventListener('dblclick', (e) => { const r = c.getBoundingClientRect(); this.zoomBy(2, e.clientX - r.left, e.clientY - r.top); });
  }
}

export function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}

/** Chaikin-smooth a packed [x,y,z,vol] path into [x,y,vol] triples (removes the D8 staircase look). */
function smoothPath(p, iters = 2) {
  let pts = [];
  for (let v = 0; v + 3 < p.length; v += 4) pts.push([p[v], p[v + 1], p[v + 3]]);
  for (let it = 0; it < iters && pts.length > 2; it++) {
    const out = [pts[0]];
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      out.push([0.75 * a[0] + 0.25 * b[0], 0.75 * a[1] + 0.25 * b[1], a[2]], [0.25 * a[0] + 0.75 * b[0], 0.25 * a[1] + 0.75 * b[1], b[2]]);
    }
    out.push(pts[pts.length - 1]); pts = out;
  }
  return pts;
}
export const pathWidth = (vol) => clamp(0.6 + 2.2 * Math.log10(vol / 15), 0.6, 6.5);

/** Group path segments into width buckets of world-space Path2Ds (log volume → width). */
function buildPathCache(paths, grid) {
  const buckets = new Map();
  let vmax = 0; for (const p of paths) for (let v = 3; v < p.length; v += 4) if (p[v] > vmax) vmax = p[v];
  const minVol = Math.max(25, vmax * 0.012);
  // segments hugging the grid edge are boundary artefacts (water leaving the model) – skip them
  const e = grid ? { x0: grid.x0 + 1.6 * grid.dx, y0: grid.y0 + 1.6 * grid.dx, x1: grid.x0 + (grid.nx - 1.6) * grid.dx, y1: grid.y0 + (grid.ny - 1.6) * grid.dx } : null;
  const inside = (q) => !e || (q[0] > e.x0 && q[0] < e.x1 && q[1] > e.y0 && q[1] < e.y1);
  const flow = new Path2D(); let anyFlow = false;
  for (const p of paths) {
    const pts = smoothPath(p);
    let started = false;
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i], b = pts[i + 1]; const vol = Math.max(a[2], b[2]);
      if (!(vol >= minVol) || (!inside(a) && !inside(b))) { started = false; continue; }
      const w = Math.round(pathWidth(vol) * 2) / 2;
      let bk = buckets.get(w); if (!bk) { bk = new Path2D(); buckets.set(w, bk); }
      bk.moveTo(a[0], a[1]); bk.lineTo(b[0], b[1]);
      if (vol > Math.max(120, minVol * 3)) {
        if (!started) { flow.moveTo(a[0], a[1]); started = true; anyFlow = true; }
        flow.lineTo(b[0], b[1]);
      } else started = false;
    }
  }
  return { buckets: [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([w, path]) => ({ w, path })), flow: anyFlow ? flow : null };
}
