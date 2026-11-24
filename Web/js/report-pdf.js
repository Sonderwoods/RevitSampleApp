// PDF renderer for the screening report: draws the report model (report-model.js) with the vendored jsPDF.
// Text, tables, legends, scale bars and north arrows are vector (selectable, searchable); maps are JPEG rasters at
// PRINT_DPI of their printed size. Every page carries the header (project, revision, date) and the footer with the
// screening-model statement and "Page n of N".
import { translator, numberFormat } from './report-i18n.js';
import { fmtMassError } from './report-model.js';
import { RAMPS, renderMap, gridExtent, unionExtent, fitBox, niceLength, PRINT_DPI } from './report-maps.js';

const JSPDF_URL = new URL('../vendor/jspdf/jspdf.umd.min.js', import.meta.url).href;
let jsPdfPromise = null;
/** Load the vendored jsPDF once (classic UMD script → window.jspdf). Works offline once the service worker cached it. */
export function loadJsPdf() {
  if (window.jspdf && window.jspdf.jsPDF) return Promise.resolve(window.jspdf.jsPDF);
  if (!jsPdfPromise) {
    jsPdfPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script'); s.src = JSPDF_URL; s.async = true;
      s.onload = () => (window.jspdf && window.jspdf.jsPDF ? resolve(window.jspdf.jsPDF) : reject(new Error('jsPDF did not load')));
      s.onerror = () => { jsPdfPromise = null; reject(new Error('Could not load the PDF library (vendor/jspdf)')); };
      document.head.append(s);
    });
  }
  return jsPdfPromise;
}

// ------------------------------------------------------------------------------------------------ text safety
// The 14 standard PDF fonts use WinAnsi encoding: Danish letters, ², ³, ·, –, — and × are fine, Greek and maths are not.
const WINANSI_EXTRA = '€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ';
const REPLACE = { '≥': '>=', '≤': '<=', '→': '->', '←': '<-', '−': '-', 'Σ': 'sum', '≈': '~', '∝': '~', 'Δ': 'change ', ' ': ' ', ' ': ' ', '‑': '-' };
export function pdfText(s) {
  return String(s ?? '').replace(/[^\x20-\x7E\xA0-\xFF\n]/g, (ch) => REPLACE[ch] ?? (WINANSI_EXTRA.includes(ch) ? ch : '?'));
}

// ------------------------------------------------------------------------------------------------ colours
const C = {
  text: [27, 37, 50], muted: [90, 104, 124], faint: [150, 160, 175], line: [205, 212, 222], zebra: [244, 246, 249],
  accent: [31, 95, 153], accentSoft: [230, 240, 249], warnBg: [255, 244, 229], warnLine: [214, 128, 30], warnText: [122, 64, 0],
  good: [27, 120, 55], bad: [178, 24, 43], neighbourBg: [255, 248, 225],
};
const hex = (h) => { const v = parseInt(h.replace('#', ''), 16); return [(v >> 16) & 255, (v >> 8) & 255, v & 255]; };

// ------------------------------------------------------------------------------------------------ layout helper
class Layout {
  constructor(doc, { margin = 15, top = 20, bottom = 18 } = {}) {
    this.doc = doc; this.W = doc.internal.pageSize.getWidth(); this.H = doc.internal.pageSize.getHeight();
    this.x0 = margin; this.x1 = this.W - margin; this.cw = this.x1 - this.x0; this.tw = Math.min(this.cw, 200); this.yTop = top; this.yBot = this.H - bottom;
    this.y = top; this.pageCount = 1;
  }
  font(size = 9, style = 'normal', color = C.text) { this.doc.setFont('helvetica', style); this.doc.setFontSize(size); this.doc.setTextColor(...color); }
  lh(size) { return (size * 0.3528) * 1.32; }
  newPage() { this.doc.addPage(); this.pageCount++; this.y = this.yTop; }
  need(h) { if (this.y + h > this.yBot) { this.newPage(); return true; } return false; }
  gap(h = 3) { this.y += h; }
  text(str, x, y, opts) { this.doc.text(pdfText(str), x, y, opts); }
  split(str, w, size, style = 'normal') { this.font(size, style); return this.doc.splitTextToSize(pdfText(str), w); }
  h1(str) { this.need(14); this.font(15, 'bold', C.accent); this.text(str, this.x0, this.y + 5); this.y += 8; this.rule(C.accent, 0.5); this.y += 4; }
  h2(str) { this.need(12); this.font(11, 'bold', C.text); this.text(str, this.x0, this.y + 4); this.y += 7; }
  rule(color = C.line, w = 0.2) { this.doc.setDrawColor(...color); this.doc.setLineWidth(w); this.doc.line(this.x0, this.y, this.x1, this.y); }
  para(str, { size = 9, style = 'normal', color = C.text, w = this.tw, x = this.x0, after = 2.2 } = {}) {
    const lines = this.split(str, w, size, style); const lh = this.lh(size);
    for (const ln of lines) { this.need(lh); this.font(size, style, color); this.doc.text(ln, x, this.y + lh * 0.75); this.y += lh; }
    this.y += after;
  }
  bullets(list, { size = 9 } = {}) {
    for (const item of list) {
      const lines = this.split(item, this.tw - 5, size); const lh = this.lh(size);
      this.need(lh * Math.min(lines.length, 2));
      this.font(size, 'normal', C.text); this.doc.text('•', this.x0 + 1, this.y + lh * 0.75);
      for (const ln of lines) { this.need(lh); this.font(size, 'normal', C.text); this.doc.text(ln, this.x0 + 5, this.y + lh * 0.75); this.y += lh; }
      this.y += 0.8;
    }
    this.y += 1.5;
  }
  /** Shaded box with a bold title and wrapped body. */
  box(title, body, { bg = C.warnBg, line = C.warnLine, color = C.warnText, size = 8.5, x = this.x0, w = this.cw } = {}) {
    const lines = this.split(body, w - 8, size); const lh = this.lh(size);
    const h = 6 + 5 + lines.length * lh + 2;
    this.need(h);
    const d = this.doc; d.setFillColor(...bg); d.setDrawColor(...line); d.setLineWidth(0.6); d.rect(x, this.y, w, h, 'FD');
    d.setFillColor(...line); d.rect(x, this.y, 1.6, h, 'F');
    this.font(9.5, 'bold', color); this.text(title, x + 5, this.y + 6);
    this.font(size, 'normal', color); lines.forEach((ln, i) => d.text(ln, x + 5, this.y + 11 + i * lh));
    this.y += h + 4;
  }
  /**
   * Table. cols: [{title, w (mm, last may be omitted = rest), align: 'l'|'r'|'c'}]. rows: arrays of cells; a cell is a
   * string or {text, color, bold, bg}. Row-level options via row.opts = {bg, bold}. Repeats the header on page breaks.
   */
  table(cols, rows, { size = 8.5, header = true, x = this.x0, w = this.cw, zebra = true, padY = 1.4 } = {}) {
    const fixed = cols.reduce((a, c) => a + (c.w || 0), 0); const free = cols.filter((c) => !c.w).length;
    const widths = cols.map((c) => c.w || (w - fixed) / Math.max(1, free));
    const lh = this.lh(size);
    const drawHeader = () => {
      if (!header) return;
      const hl = cols.map((c, i) => this.split(c.title || '', widths[i] - 2.4, size - 0.5, 'bold'));
      const hh = Math.max(...hl.map((l) => l.length)) * this.lh(size - 0.5) + padY * 2;
      this.doc.setFillColor(...C.accentSoft); this.doc.rect(x, this.y, w, hh, 'F');
      let cx = x;
      cols.forEach((c, i) => {
        this.font(size - 0.5, 'bold', C.accent);
        hl[i].forEach((ln, j) => this.cellText(ln, cx, widths[i], c.align, this.y + padY + this.lh(size - 0.5) * (j + 0.75)));
        cx += widths[i];
      });
      this.y += hh;
    };
    this.need((header ? this.lh(size) + padY * 2 : 0) + lh * 2 + padY * 2); // never orphan a header
    drawHeader();
    rows.forEach((row, ri) => {
      const opts = row.opts || {};
      const cells = row.map((c) => (c != null && typeof c === 'object' ? c : { text: c ?? '' }));
      const lines = cells.map((c, i) => this.split(c.text, widths[i] - 2.4, size, c.bold || opts.bold ? 'bold' : 'normal'));
      const rh = Math.max(1, ...lines.map((l) => l.length)) * lh + padY * 2;
      if (this.y + rh > this.yBot) { this.newPage(); drawHeader(); }
      const bg = opts.bg || (zebra && ri % 2 === 1 ? C.zebra : null);
      if (bg) { this.doc.setFillColor(...bg); this.doc.rect(x, this.y, w, rh, 'F'); }
      let cx = x;
      cells.forEach((c, i) => {
        if (c.bg) { this.doc.setFillColor(...c.bg); this.doc.rect(cx, this.y, widths[i], rh, 'F'); }
        if (c.swatch) { this.doc.setFillColor(...hex(c.swatch)); this.doc.rect(cx + 1.2, this.y + padY + 0.4, 3, lh - 1.2, 'F'); }
        this.font(size, c.bold || opts.bold ? 'bold' : 'normal', c.color || C.text);
        lines[i].forEach((ln, j) => this.cellText(ln, cx + (c.swatch ? 4.5 : 0), widths[i] - (c.swatch ? 4.5 : 0), cols[i].align, this.y + padY + lh * (j + 0.75)));
        cx += widths[i];
      });
      this.doc.setDrawColor(...C.line); this.doc.setLineWidth(0.15); this.doc.line(x, this.y + rh, x + w, this.y + rh);
      this.y += rh;
    });
    this.y += 3;
  }
  cellText(ln, cx, w, align, y) {
    if (align === 'r') this.doc.text(ln, cx + w - 1.2, y, { align: 'right' });
    else if (align === 'c') this.doc.text(ln, cx + w / 2, y, { align: 'center' });
    else this.doc.text(ln, cx + 1.2, y);
  }
}

// ------------------------------------------------------------------------------------------------ formatting
function makeFmt(t, nf) {
  const u = t('units');
  const val = (v, unit) => {
    if (v == null || !isFinite(v)) return '–';
    switch (unit) {
      case 'cm': return nf.fixed(v, 0);
      case 'ms': return nf.fixed(v, 2);
      case 'pct': return nf.fixed(v, Math.abs(v) < 1 ? 3 : 1);
      case '': return nf.fixed(v, 0);
      case 'm2': return nf.fixed(v, 0);
      default: return nf.smart(v);
    }
  };
  const withUnit = (v, unit) => (v == null || !isFinite(v) ? '–' : `${val(v, unit)}${unit && u[unit] ? ` ${u[unit]}` : ''}`);
  return { val, withUnit, u };
}

// ------------------------------------------------------------------------------------------------ map figure
/** Legend block for a map layer at (x, y), width w. Returns the height used. */
function drawLegend(L, layer, t, nf, x, y, w, extra = {}) {
  const d = L.doc; let yy = y;
  const ramp = layer === 'materials' ? null : RAMPS[layer];
  const title = { depth: t('legendDepth'), dynDepth: t('legendDepth'), hazard: t('legendHazard'), velocity: t('legendVelocity'), diff: t('legendDiff', extra), materials: t('mapMaterials') }[layer];
  for (const ln of L.split(title, w, 8, 'bold')) { L.font(8, 'bold', C.text); d.text(ln, x, yy + 3); yy += 3.6; }
  yy += 1;
  const labels = ramp && t('legendLabels')[layer] ? t('legendLabels')[layer] : ramp && ramp.labels;
  const items = ramp ? ramp.colors.map((c, i) => [c, labels[i]]) : (extra.materials || []).map((m) => [m.color, m.name]);
  if (layer === 'materials' && extra.buildings) items.push(['#4a5260', extra.buildings]);
  for (const [col, lab] of items) {
    const lines = L.split(lab, w - 7, 7.5);
    d.setFillColor(...hex(col)); d.setDrawColor(...C.line); d.setLineWidth(0.1); d.rect(x, yy + 0.2, 5, 3.2, 'FD');
    L.font(7.5, 'normal', C.text); lines.forEach((ln, i) => d.text(ln, x + 7, yy + 2.7 + i * 3.2));
    yy += Math.max(4.2, lines.length * 3.2 + 1);
  }
  if (layer === 'depth' || layer === 'dynDepth') {
    yy += 1; for (const ln of L.split(t('hiddenBelow', { cm: layer === 'depth' ? 1 : 3 }), w, 7)) { L.font(7, 'normal', C.muted); d.text(ln, x, yy + 2.5); yy += 3; }
  }
  if (layer === 'depth' && extra.paths) {
    yy += 1.5;
    d.setDrawColor(24, 104, 214); d.setLineWidth(0.8); d.line(x, yy + 1.5, x + 5, yy + 1.5);
    for (const ln of L.split(t('flowPathNote'), w - 7, 7)) { L.font(7, 'normal', C.muted); d.text(ln, x + 7, yy + 2.5); yy += 3; }
  }
  if (layer === 'diff') {
    yy += 2;
    for (const [key, col] of [['diffBetter', C.good], ['diffWorse', C.bad]]) for (const ln of L.split(t(key, extra), w, 7.5, 'bold')) { L.font(7.5, 'bold', col); d.text(ln, x, yy + 2.6); yy += 3.3; }
    yy += 1;
    for (const ln of L.split(t('diffNote'), w, 7)) { L.font(7, 'normal', C.muted); d.text(ln, x, yy + 2.5); yy += 3; }
  }
  return yy - y;
}

/** Scale bar + nominal scale in the lower-left corner of the map, north arrow in the upper-right. */
function drawMapFurniture(L, map, x, y, t, nf) {
  const d = L.doc;
  const lenM = niceLength((map.wMm * 0.28) / map.mmPerM); const lenMm = lenM * map.mmPerM;
  const bx = x + 3, by = y + map.hMm - 4;
  const denom = Math.round(1000 / map.mmPerM / 10) * 10;
  const label = `${nf.fixed(0)}   ${nf.fixed(lenM / 2)}   ${nf.fixed(lenM)} m`;
  const scaleTxt = `${t('scale')} 1:${nf.fixed(denom)} (A4)`;
  L.font(7, 'normal', C.text);
  const boxW = Math.max(lenMm + 6, d.getTextWidth(pdfText(scaleTxt)) + 4);
  d.setFillColor(255, 255, 255); d.setDrawColor(...C.line); d.setLineWidth(0.15); d.rect(bx - 1.5, by - 9.5, boxW, 11.5, 'FD');
  for (let i = 0; i < 4; i++) { d.setFillColor(...(i % 2 ? [255, 255, 255] : C.text)); d.rect(bx + (i * lenMm) / 4, by - 1.6, lenMm / 4, 1.4, 'F'); }
  d.setDrawColor(...C.text); d.setLineWidth(0.2); d.rect(bx, by - 1.6, lenMm, 1.4, 'S');
  L.font(6.5, 'normal', C.text);
  d.text(pdfText(nf.fixed(0)), bx, by - 2.6, { align: 'center' }); d.text(pdfText(nf.fixed(lenM / 2)), bx + lenMm / 2, by - 2.6, { align: 'center' });
  d.text(pdfText(`${nf.fixed(lenM)} m`), bx + lenMm, by - 2.6, { align: 'center' });
  L.font(6.5, 'normal', C.muted); d.text(pdfText(scaleTxt), bx, by - 6.3);
  void label;
  // north arrow (grid north)
  const nx = x + map.wMm - 7, ny = y + 8;
  d.setFillColor(255, 255, 255); d.setDrawColor(...C.line); d.circle(nx, ny, 5, 'FD');
  d.setFillColor(...C.text); d.triangle(nx, ny - 3.8, nx + 2.2, ny + 2.6, nx, ny + 1.2, 'F');
  d.setFillColor(170, 178, 190); d.triangle(nx, ny - 3.8, nx - 2.2, ny + 2.6, nx, ny + 1.2, 'F');
  L.font(6.5, 'bold', C.text); d.text(t('north'), nx, ny + 4.7, { align: 'center' });
}

function drawBluespotMarkers(L, map, x, y, spots) {
  const d = L.doc;
  for (const b of spots) {
    const [mx, my] = map.toMm(b.x, b.y); if (mx < 0 || my < 0 || mx > map.wMm || my > map.hMm) continue;
    d.setFillColor(255, 255, 255); d.setDrawColor(...(b.spills ? [214, 128, 30] : C.text)); d.setLineWidth(b.spills ? 0.6 : 0.3);
    d.circle(x + mx, y + my, 2.1, 'FD');
    L.font(6.5, 'bold', C.text); d.text(String(b.rank), x + mx, y + my + 0.85, { align: 'center' });
  }
}

/**
 * Place a map with legend to its right (or below when narrow). spec: {layer, rec, extent, title, caption, legendExtra,
 * spots, diff, maxH}. Starts a new page if it does not fit.
 */
function mapFigure(L, ctx, spec) {
  const { t, nf, palette } = ctx;
  const legendW = spec.legendW ?? 44; const gapW = legendW ? 5 : 0;
  const maxW = (spec.w ?? L.cw) - legendW - gapW; const maxH = spec.maxH ?? (L.yBot - L.yTop - 26);
  const box = fitBox(spec.extent, maxW, maxH);
  const titleLines = L.split(spec.title, spec.w ?? L.cw, 10, 'bold');
  const need = titleLines.length * 4.5 + box.h + 14;
  if (!spec.x) L.need(need);
  const x = spec.x ?? L.x0; let y = spec.y ?? L.y;
  L.font(10, 'bold', C.text); titleLines.forEach((ln) => { L.doc.text(ln, x, y + 4); y += 4.5; }); y += 1.5;
  const map = renderMap({ layer: spec.layer, rec: spec.rec, palette, extent: spec.extent, wMm: box.w, hMm: box.h, diff: spec.diff, showPaths: spec.layer === 'depth' });
  L.doc.addImage(map.dataUrl, 'JPEG', x, y, box.w, box.h, undefined, 'FAST');
  L.doc.setDrawColor(...C.line); L.doc.setLineWidth(0.2); L.doc.rect(x, y, box.w, box.h, 'S');
  if (spec.spots) drawBluespotMarkers(L, map, x, y, spec.spots);
  drawMapFurniture(L, map, x, y, t, nf);
  const lx = x + box.w + gapW;
  const legendEnd = spec.noLegend ? y : y + drawLegend(L, spec.layer, t, nf, lx, y, legendW, spec.legendExtra || {});
  y += box.h + 1.5;
  if (spec.caption) { for (const ln of L.split(spec.caption, box.w, 7)) { L.font(7, 'normal', C.muted); L.doc.text(ln, x, y + 2.6); y += 3; } }
  if (spec.x == null) L.y = y + 4;
  ctx.mapsInfo.push({ layer: spec.layer, option: spec.rec?.letter ?? null, dpi: map.dpi, px: [map.pxW, map.pxH], mm: [+box.w.toFixed(1), +box.h.toFixed(1)] });
  return { box, endY: y, legendEnd, legendX: lx, legendW };
}

// ------------------------------------------------------------------------------------------------ sections
function projectRows(model, t) {
  const p = model.project; const g = (v) => (v && String(v).trim() ? v : t('notGiven'));
  return [[t('project'), g(p.name)], [t('address'), g(p.address)], [t('matrikel'), g(p.matrikel)], [t('client'), g(p.client)],
    [t('author'), g(p.author)], [t('company'), g(p.company)], [t('date'), g(p.date)], [t('revision'), g(p.revision)]];
}
function kvTable(L, rows, opts = {}) {
  const cell = (c, dflt) => (c != null && typeof c === 'object' ? c : { text: c ?? '', ...dflt });
  L.table([{ title: '', w: opts.kw ?? 58 }, { title: '' }], rows.map((r) => [cell(r[0], { color: C.muted }), cell(r[1])]), { header: false, zebra: false, size: opts.size ?? 8.5, ...opts });
}

function presetLabel(r, t) { return r ? (t('presetNames')[r.presetId] || r.presetName) : t('notGiven'); }
function sewerLabel(s, t) { return s == null ? t('notGiven') : [t('sewerNone'), t('sewerCombined'), t('sewerSeparate')][s.mode] ?? `mode ${s.mode}`; }
function moistLabel(m, t) { return m == null ? t('notGiven') : [t('moistDry'), t('moistMoist'), t('moistWet')][m.mode] ?? `${m.mode}`; }

function designText(o, t) {
  const d = o.inputs.design || [];
  return d.length ? d.map((x) => `${x.from || t('groundTo')} -> ${x.to}`).join('; ') : t('designAsDrawn');
}

function siteSection(L, ctx, o, size = 8.5) {
  const { t, nf, f } = ctx; const s = o.site; const g = o.inputs.grid;
  L.h2(t('secSite'));
  const kind = { synthetic: t('kindSynthetic'), real: t('kindReal'), custom: t('kindCustom') }[s.kind];
  const src = s.terrain === 'synthetic' ? t('synthTerrain') : s.terrain === 'dhm' ? `${s.description || 'DHM/Terræn'}${s.dhmFile ? ` (${s.dhmFile})` : ''}` : s.description;
  const rows = [[t('siteName'), s.name || t('notGiven')], [t('siteKind'), kind], [t('terrainSource'), src]];
  if (s.terrain !== 'synthetic') rows.push([t('terrainDate'), t('terrainDateUnknown')]);
  if (s.terrain === 'dhm') rows.push([t('attribution'), t('dhmAttribution')]);
  rows.push([t('crs'), s.crs || t('crsLocal')]);
  rows.push([t('extent'), `${nf.fixed(g.widthM)} × ${nf.fixed(g.heightM)} m = ${f.withUnit(o.surfaces.totalAreaM2, 'm2')} (${nf.fixed(o.surfaces.totalAreaM2 / 10000, 2)} ha)`]);
  rows.push([t('origin'), `E ${nf.fixed(g.x0, 1)}, N ${nf.fixed(g.y0, 1)}`]);
  rows.push([t('cellSize'), `${nf.fixed(g.cellSizeM, 2)} m · ${t('cells')} ${nf.fixed(g.cells)} (${g.nx} × ${g.ny})`]);
  if (s.bbox) rows.push(['BBOX (EPSG:25832)', s.bbox.map((v) => nf.fixed(v)).join(', ')]);
  if (g.warnings && g.warnings.length) rows.push([t('gridWarnings'), g.warnings.join(' / ')]);
  kvTable(L, rows, { size, padY: size < 8.5 ? 1.1 : 1.4 });
}

function hyetograph(L, ctx, r) {
  const { t, nf } = ctx; const d = L.doc; const arr = r.intensityMmH; if (!arr || !arr.length) return;
  const w = L.cw, h = 30; L.need(h + 12);
  const x = L.x0 + 10, y = L.y + 2, pw = w - 14;
  const mx = Math.max(...arr) || 1; const n = arr.length; const bw = pw / n;
  d.setFillColor(79, 168, 224);
  arr.forEach((v, i) => { const bh = (v / mx) * h; if (bh > 0.05) d.rect(x + i * bw, y + h - bh, Math.max(bw, 0.15), bh, 'F'); });
  d.setDrawColor(...C.text); d.setLineWidth(0.2); d.line(x, y + h, x + pw, y + h); d.line(x, y, x, y + h);
  L.font(6.5, 'normal', C.muted);
  d.text(pdfText(nf.fixed(mx)), x - 1.5, y + 2, { align: 'right' }); d.text('0', x - 1.5, y + h, { align: 'right' });
  for (let m = 0; m <= n; m += n > 180 ? 60 : 30) d.text(pdfText(`${m} ${t('units').min}`), x + m * bw, y + h + 3.5, { align: 'center' });
  L.y = y + h + 5;
  L.para(t('hyetoCaption'), { size: 7, color: C.muted });
}

function rainSection(L, ctx, o) {
  const { t, nf } = ctx; const r = o.inputs.rain; const i = o.inputs;
  L.h2(t('secRain'));
  const rows = [];
  if (r) {
    rows.push([t('rainEvent'), presetLabel(r, t)]);
    rows.push([t('returnPeriod'), r.returnPeriodYears ? t('years', { n: r.returnPeriodYears }) : t('rpNone')]);
    rows.push([t('rainDepth'), `${nf.smart(r.depthMm)} mm${r.custom ? ` – ${t('rainCustom', { d: nf.smart(r.depthMm), p: nf.smart(r.presetDepthMm) })}` : ''}`]);
    rows.push([t('climateFactor'), nf.fixed(r.climateFactor, 2)]);
    rows.push([t('designDepth'), `${nf.smart(r.designDepthMm)} mm`]);
    rows.push([t('duration'), `${nf.fixed(r.durationMin)} min`]);
    rows.push([t('rainShape'), r.shape === 'box' ? t('shapeBox') : t('shapeCds')]);
    if (r.peakIntensityMmH) rows.push([t('peakIntensity'), `${nf.fixed(r.peakIntensityMmH)} mm/h`]);
    rows.push([t('rainSource'), t('rainSourceText')]);
  }
  rows.push([t('sewer'), sewerLabel(i.sewer, t)]);
  rows.push([t('moisture'), moistLabel(i.moisture, t)]);
  rows.push([t('soil'), t('soilDefault')]);
  rows.push([t('designChanges'), designText(o, t)]);
  rows.push([t('model'), o.dynamic ? `${t('modelInstant')}; ${t('modelDynamic')}` : t('modelInstant')]);
  if (o.dynamic) rows.push([t('dynCell'), `${nf.fixed(o.dynamic.cellSizeM, 1)} m · ${t('dynSim')} ${nf.fixed(o.dynamic.simulatedMin)} min`]);
  kvTable(L, rows);
  if (r) hyetograph(L, ctx, r);
}

function surfacesTable(L, ctx, o) {
  const { t, nf, f } = ctx; const S = o.surfaces;
  const rows = S.rows.map((m) => [{ text: m.name, swatch: m.color }, f.withUnit(m.areaM2, 'm2'), `${nf.fixed(m.share * 100, 1)} %`, nf.fixed(m.cNormal ?? NaN, 2),
    `${nf.fixed(m.cCbSand ?? NaN, 2)} / ${nf.fixed(m.cCbClay ?? NaN, 2)}`, nf.fixed(m.manningN ?? NaN, 3),
    m.useSoilTable ? t('jbTable') : `${nf.smart(m.fSandMmH)} / ${nf.smart(m.fClayMmH)}`, nf.smart(m.iaMm)]);
  if (S.buildingsAreaM2 > 0) rows.push([{ text: t('buildings'), swatch: '#4a5260' }, f.withUnit(S.buildingsAreaM2, 'm2'), `${nf.fixed(S.buildingsShare * 100, 1)} %`, '', '', '', '', '']);
  L.table([{ title: t('thMaterial') }, { title: t('thArea'), w: 22, align: 'r' }, { title: t('thShare'), w: 14, align: 'r' }, { title: t('thCNormal'), w: 14, align: 'r' },
    { title: t('thCCb'), w: 24, align: 'r' }, { title: t('thManning'), w: 15, align: 'r' }, { title: t('thInfil'), w: 26, align: 'r' }, { title: t('thIa'), w: 15, align: 'r' }], rows, { size: 7.8 });
  L.para(t('surfacesNote'), { size: 7.5, color: C.muted });
}

function bluespotTable(L, ctx, I) {
  const { t, nf, f } = ctx;
  if (!I.topBluespots.length) return;
  L.h2(t('secBluespots'));
  L.table([{ title: t('thNo'), w: 12, align: 'c' }, { title: t('thVolume'), align: 'r' }, { title: t('thDepth'), align: 'r' }, { title: t('thArea'), align: 'r' },
    { title: t('thSpills'), align: 'c' }, { title: t('thSpillRain'), align: 'r' }],
  I.topBluespots.map((b) => [String(b.rank), f.withUnit(b.volumeM3, 'm3'), `${nf.fixed(b.maxDepthM * 100)} cm`, f.withUnit(b.areaM2, 'm2'),
    b.spills ? t('yes') : (b.fillPct != null ? t('fillPct', { p: nf.fixed(b.fillPct) }) : t('no')), b.spillRainMm != null ? `${nf.smart(b.spillRainMm)} mm` : '–']));
}

const BAL_COL = { loss: '#3b4b63', ponded: '#1f78c8', leaves: '#7cc4f2', ia: '#56657c', infil: '#5aae61', sewer: '#8b7fd6', stored: '#1f78c8' };

/** Water balance for one or more options: volume and share of rain per option, stacked bar per option. */
function balanceSection(L, ctx, opts, letters = null) {
  const { t, nf, f } = ctx; const multi = opts.length > 1;
  const head = (title) => [{ title }, ...opts.flatMap((o, i) => [{ title: multi ? `${letters[i]} ${t('thVolume').toLowerCase()}` : t('thVolume'), w: multi ? 28 : 35, align: 'r' }, { title: multi ? `${letters[i]} %` : t('thShareOfRain'), w: multi ? 16 : 30, align: 'r' }])];
  L.h2(t('secBalance'));
  if (opts.every((o) => o.instant)) {
    const defs = [['kfRain', 'rainM3', null], ['kfLosses', 'lossesM3', BAL_COL.loss], ['kfPonded', 'pondedM3', BAL_COL.ponded], ['kfLeaves', 'leavesSiteM3', BAL_COL.leaves]];
    L.table(head(t('modelInstant').split('(')[0].trim()), defs.map(([k, key, col], r) => {
      const row = [{ text: t(k), bold: key === 'leavesSiteM3', swatch: col }, ...opts.flatMap((o) => [f.withUnit(o.instant[key], 'm3'), r === 0 ? '100 %' : `${nf.fixed((o.instant[key] / o.instant.rainM3) * 100, 1)} %`])];
      if (key === 'leavesSiteM3') row.opts = { bg: C.neighbourBg };
      return row;
    }));
    opts.forEach((o, i) => stackBar(L, [[o.instant.lossesM3, BAL_COL.loss], [o.instant.pondedM3, BAL_COL.ponded], [o.instant.leavesSiteM3, BAL_COL.leaves]], o.instant.rainM3, multi ? letters[i] : null));
    L.para(t('balanceInstantNote'), { size: 7.5, color: C.muted });
  }
  if (opts.every((o) => o.dynamic)) {
    const defs = [['kfRain', 'rainM3', null], ['kfInitialLoss', 'initialLossM3', BAL_COL.ia], ['kfInfiltrated', 'infiltratedM3', BAL_COL.infil], ['kfSewer', 'sewerM3', BAL_COL.sewer], ['kfLeaves', 'leavesSiteM3', BAL_COL.leaves], ['kfStoredEnd', 'storedEndM3', BAL_COL.stored]];
    const tot = (o) => o.dynamic.rainM3 + o.dynamic.initialWaterM3;
    const rows = defs.map(([k, key, col], r) => {
      const row = [{ text: t(k), bold: key === 'leavesSiteM3', swatch: col }, ...opts.flatMap((o) => [f.withUnit(o.dynamic[key], 'm3'), r === 0 ? '100 %' : `${nf.fixed((o.dynamic[key] / tot(o)) * 100, 1)} %`])];
      if (key === 'leavesSiteM3') row.opts = { bg: C.neighbourBg };
      return row;
    });
    rows.push([{ text: t('kfMassError'), bold: true }, ...opts.flatMap((o) => [{ text: `${fmtMassError(o.dynamic.massErrorPct, nf)} %`, bold: true }, f.withUnit(o.dynamic.massResidualM3, 'm3')])]);
    L.table(head(t('modelDynamic').split('(')[0].trim()), rows);
    opts.forEach((o, i) => { const D = o.dynamic; stackBar(L, [[D.initialLossM3, BAL_COL.ia], [D.infiltratedM3, BAL_COL.infil], [D.sewerM3, BAL_COL.sewer], [D.leavesSiteM3, BAL_COL.leaves], [D.storedEndM3, BAL_COL.stored]], tot(o), multi ? letters[i] : null); });
    L.para(t('balanceDynNote'), { size: 7.5, color: C.muted });
  } else if (!multi || opts.some((o) => o.dynamic)) L.para(t('noDynamic'), { size: 8, color: C.muted });
}

/** Retention inputs and results for one or more options (one column per option). */
function retentionSection(L, ctx, opts, letters = null) {
  const { t, nf, f } = ctx;
  L.h2(t('secRetention'));
  if (!opts.some((o) => o.retention)) { L.para(t('retNotAvailable'), { color: C.muted }); return; }
  const v = (fn) => opts.map((o) => (o.retention ? fn(o.retention) : '–'));
  const rows = [
    [t('retInputDischarge'), ...v((R) => `${nf.smart(R.input.dischargeLSHa)} l/s/ha`)], [t('retInputT'), ...v((R) => t('years', { n: R.input.returnPeriodYears }))],
    [t('retInputCf'), ...v((R) => nf.fixed(R.input.climateFactor, 2))], [t('retInputSf'), ...v((R) => nf.fixed(R.input.safetyFactor, 2))],
    [t('kfTotalArea'), ...v((R) => f.withUnit(R.totalAreaM2, 'm2'))], [t('kfReducedArea'), ...v((R) => `${f.withUnit(R.reducedAreaM2, 'm2')} (C = ${nf.fixed(R.meanC, 2)})`)],
    [t('kfRationalPeak'), ...v((R) => `${nf.smart(R.rationalPeakLS)} l/s (10 min)`)], [t('kfAllowedOutSite'), ...v((R) => `${nf.smart(R.allowedOutflowLS)} l/s`)],
    [{ text: t('kfStorage'), bold: true }, ...v((R) => ({ text: f.withUnit(R.requiredStorageM3, 'm3'), bold: true }))],
    [t('kfCritDur'), ...v((R) => (R.criticalDurationMin >= 120 ? `${nf.fixed(R.criticalDurationMin / 60, 1)} h` : `${nf.fixed(R.criticalDurationMin)} min`))],
  ];
  if (opts.length === 1) kvTable(L, rows);
  else L.table([{ title: '' }, ...letters.map((l) => ({ title: l, w: 45, align: 'r' }))], rows.map((r) => [{ text: r[0].text || r[0], color: C.muted, bold: !!r[0].bold }, ...r.slice(1)]), { size: 8.3 });
  L.para(t('retentionNote'), { size: 7.5, color: C.muted });
}

function stackBar(L, parts, total, label = null) {
  L.need(7); const d = L.doc; const lw = label ? 14 : 0; const x0 = L.x0 + lw; let x = x0; const w = L.cw - lw;
  if (label) { L.font(7.5, 'bold', C.text); d.text(pdfText(label), L.x0, L.y + 3.2); }
  for (const [v, col] of parts) { if (!(v > 0)) continue; const pw = (v / total) * w; d.setFillColor(...hex(col)); d.rect(x, L.y, pw, 4, 'F'); x += pw; }
  d.setDrawColor(...C.line); d.setLineWidth(0.15); d.rect(x0, L.y, w, 4, 'S');
  L.y += 6;
}


function methodSection(L, ctx) {
  const { t } = ctx;
  L.h1(t('secMethod'));
  L.para(t('methodIntro'));
  L.bullets([t('methodM1'), t('methodM2'), t('methodRet')]);
  L.h2(t('assumptionsTitle')); L.bullets(t('assumptions'));
  L.h2(t('limitationsTitle')); L.bullets(t('limitations'));
  L.h2(t('secValidation')); L.para(t('validationIntro'), { size: 8.5, color: C.muted });
  L.table([{ title: t('thTest') }, { title: t('thStatus'), w: L.cw * 0.48 }], t('validation'));
}

function appendixSection(L, ctx, model) {
  const { t, nf } = ctx; const opts = model.options;
  L.h1(t('secAppendix'));
  kvTable(L, [[t('appTool'), model.tool.name], [t('appEngine'), model.tool.engineVersion || t('notGiven')], [t('appSchema'), model.schema], [t('generated'), model.generatedAt]], { size: 7.8 });
  const rows = [
    [t('appBasis'), (o) => (o.dynamic ? 'instant + dynamic' : 'instant')], [t('appCreated'), (o) => o.createdAt || t('notGiven')],
    ['presetId / depth / CF', (o) => (o.inputs.rain ? `${o.inputs.rain.presetId} / ${nf.smart(o.inputs.rain.depthMm)} mm / ${nf.fixed(o.inputs.rain.climateFactor, 2)}` : t('notGiven'))],
    ['sewerMode / moisture', (o) => `${o.inputs.sewer?.mode ?? '–'} / ${o.inputs.moisture?.mode ?? '–'}`], ['soil (JB)', (o) => `${o.inputs.soil.jb} (${o.inputs.soil.source})`],
    [t('appGridDims'), (o) => `${o.inputs.grid.nx} × ${o.inputs.grid.ny} @ ${nf.fixed(o.inputs.grid.cellSizeM, 2)} m`],
    ['engine areaOver10CmM2', (o) => (o.instant ? nf.fixed(o.instant.engineAreaOver10CmM2) : '–')],
    ['dynamic steps / compute time', (o) => (o.dynamic ? `${nf.fixed(o.dynamic.steps)} / ${nf.fixed(o.dynamic.elapsedS, 1)} s` : '–')],
    [t('appCaption'), (o) => o.inputs.caption || t('notGiven')],
  ];
  const letters = opts.map((o) => (opts.length > 1 ? t('optionLetter', { l: o.letter }) : t('thValue')));
  L.table([{ title: t('thParam'), w: 52 }, ...letters.map((l) => ({ title: l }))], rows.map(([k, fn]) => [{ text: k, color: C.muted }, ...opts.map(fn)]), { size: 7.8 });
  L.para(t('appParamsNote'), { size: 7.5, color: C.muted });
  L.para(`${t('secMethod')}: ${model.references.method} · ${model.references.requirements} · ${model.references.reports}`, { size: 7.5, color: C.muted });
  if (ctx.mapsInfo.length) L.para(`Maps: ${ctx.mapsInfo.map((m) => `${m.layer}${m.option ? ` ${m.option}` : ''} ${m.px[0]}×${m.px[1]} px for ${nf.fixed(m.mm[0])}×${nf.fixed(m.mm[1])} mm (${m.dpi} dpi)`).join('; ')}.`, { size: 7, color: C.faint });
}

function keyTiles(L, ctx, tiles) {
  const n = tiles.length; const perRow = 4; const gw = 3; const w = (L.cw - gw * (perRow - 1)) / perRow; const h = 17;
  const rowsN = Math.ceil(n / perRow); L.need(rowsN * (h + gw));
  const d = L.doc;
  tiles.forEach((tile, i) => {
    const x = L.x0 + (i % perRow) * (w + gw), y = L.y + Math.floor(i / perRow) * (h + gw);
    d.setFillColor(...(tile.hl ? C.neighbourBg : C.zebra)); d.setDrawColor(...C.line); d.setLineWidth(0.15); d.rect(x, y, w, h, 'FD');
    const lines = L.split(tile.label, w - 4, 7); L.font(7, 'normal', C.muted); lines.slice(0, 2).forEach((ln, j) => d.text(ln, x + 2, y + 4 + j * 2.9));
    L.font(13, 'bold', C.text); d.text(pdfText(tile.value), x + 2, y + h - 3);
    if (tile.tag) { L.font(6.2, 'bold', C.accent); d.text(pdfText(tile.tag), x + w - 2, y + h - 3, { align: 'right' }); }
  });
  L.y += rowsN * (h + gw) + 2;
}

// ------------------------------------------------------------------------------------------------ documents
function singleReport(L, ctx, model, rec) {
  const { t, f, nf } = ctx; const o = model.options[0]; const I = o.instant, D = o.dynamic, R = o.retention;
  // --- cover / summary
  L.font(20, 'bold', C.accent); L.text(t('docTitle'), L.x0, L.y + 7); L.y += 11;
  L.font(12, 'normal', C.text); L.text(model.project.name || o.site.name || '', L.x0, L.y + 4); L.y += 9;
  L.box(t('screeningBoxTitle'), t('screeningBox'));
  kvTable(L, projectRows(model, t), { kw: 45 });
  L.h2(t('secKeyFigures'));
  const m1 = t('tagInstant'), m2 = t('tagDynamic');
  const tiles = [
    { label: t('kfDesignDepth'), value: o.inputs.rain ? `${nf.smart(o.inputs.rain.designDepthMm)} mm` : '–' },
    { label: t('kfRain'), value: f.withUnit(I.rainM3, 'm3') },
    { label: t('kfPonded'), value: f.withUnit(I.pondedM3, 'm3'), tag: m1 },
    { label: t('kfLeaves'), value: f.withUnit(I.leavesSiteM3, 'm3'), hl: true, tag: m1 },
    { label: t('kfOver', { cm: 10 }), value: f.withUnit(I.areaOverM2[10], 'm2'), tag: m1 },
    { label: t('kfMaxDepth'), value: `${nf.fixed(I.maxDepthM * 100)} cm`, tag: m1 },
    { label: R ? t('kfStorage') : t('kfBluespots'), value: R ? f.withUnit(R.requiredStorageM3, 'm3') : nf.fixed(I.bluespotCount) },
    { label: t('cellSize'), value: `${nf.fixed(o.inputs.grid.cellSizeM, 1)} m` },
  ];
  if (D) tiles.push(
    { label: t('kfLeaves'), value: f.withUnit(D.leavesSiteM3, 'm3'), hl: true, tag: m2 },
    { label: t('kfMaxDepth'), value: `${nf.fixed(D.maxDepthM * 100)} cm`, tag: m2 },
    { label: t('kfMaxVel'), value: `${nf.fixed(D.maxVelocityMS, 2)} m/s`, tag: m2 },
    { label: t('kfMassError'), value: `${fmtMassError(D.massErrorPct, nf)} %`, tag: m2 });
  keyTiles(L, ctx, tiles);
  L.h2(t('secSummary'));
  for (const s of model.summary) L.para(s);
  if (model.project.notes) { L.h2(t('notes')); L.para(model.project.notes); }

  // --- inputs
  L.newPage(); L.h1(`${t('secSite')} · ${t('secRain')}`);
  siteSection(L, ctx, o); rainSection(L, ctx, o);
  L.newPage(); L.h1(t('secSurfaces'));
  surfacesTable(L, ctx, o);
  const ext = gridExtent(rec.grid);
  mapFigure(L, ctx, { layer: 'materials', rec, extent: ext, title: t('mapMaterials'), legendExtra: { materials: o.surfaces.rows.slice(0, 12), buildings: o.surfaces.buildingsAreaM2 > 0 ? t('buildings').split('(')[0].trim() : null }, caption: o.inputs.caption, maxH: L.yBot - L.y - 30 > 70 ? Math.min(150, L.yBot - L.y - 30) : 150 });

  // --- maps
  L.newPage(); L.h1(t('secMaps'));
  mapFigure(L, ctx, { layer: 'depth', rec, extent: ext, title: t('mapDepthInstant'), spots: I.topBluespots, legendExtra: { paths: true }, caption: o.inputs.caption, maxH: 150 });
  bluespotTable(L, ctx, I);
  if (D) {
    L.newPage();
    const half = (L.yBot - L.yTop - 30) / 2;
    mapFigure(L, ctx, { layer: 'dynDepth', rec, extent: ext, title: t('mapDepthDyn'), caption: o.inputs.caption, maxH: half });
    mapFigure(L, ctx, { layer: 'hazard', rec, extent: ext, title: t('mapHazard'), caption: o.inputs.caption, maxH: half });
    L.newPage();
    mapFigure(L, ctx, { layer: 'velocity', rec, extent: ext, title: t('mapVelocity'), caption: o.inputs.caption, maxH: half });
  }
  // --- balance, retention
  if (!D) L.newPage(); else L.need(90);
  L.h1(`${t('secBalance')} · ${t('secRetention')}`);
  balanceSection(L, ctx, [o]); retentionSection(L, ctx, [o]);
  L.newPage(); methodSection(L, ctx);
  L.newPage(); appendixSection(L, ctx, model);
}

function comparisonReport(L, ctx, model, records, internals) {
  const { t, f, nf } = ctx; const cmp = model.comparison; const opts = model.options; const A = opts[0];
  const basis = cmp.basis; const depthLayer = basis === 'dynamic' ? 'dynDepth' : 'depth';
  const letters = opts.map((o) => t('optionLetter', { l: o.letter }));
  // --- cover
  L.font(19, 'bold', C.accent); L.text(t('docTitleCompare'), L.x0, L.y + 7); L.y += 11;
  L.font(11, 'normal', C.text); L.text(model.project.name || A.site.name || '', L.x0, L.y + 4); L.y += 8;
  const colW = (L.cw - 8) / 2; const y0 = L.y;
  L.box(t('screeningBoxTitle'), t('screeningBox'), { x: L.x0 + colW + 8, w: colW });
  const yBox = L.y; L.y = y0;
  L.table([{ title: '', w: 40 }, { title: '' }], projectRows(model, t).map((r) => [{ text: r[0], color: C.muted }, r[1]]), { header: false, zebra: false, w: colW, size: 8.3 });
  L.y = Math.max(L.y, yBox);
  L.table([{ title: t('thOption'), w: 30 }, { title: '' }, { title: t('model'), w: 70 }],
    opts.map((o, i) => [{ text: `${letters[i]}${i === 0 ? ` (${t('baseline')})` : ''}`, bold: true }, o.name, o.dynamic ? 'instant + dynamic' : 'instant']), { size: 8.5 });
  L.para(basis === 'dynamic' ? t('basisDynamic') : t('basisInstant'), { size: 8.5, color: C.muted });
  L.h2(t('secCompareSummary'));
  for (const s of model.summary) L.para(s, { size: 8.5, after: 1.4 });

  // --- key figures
  L.newPage(); L.h1(t('secKeyFigures'));
  const cols = [{ title: t('thQuantity') }, ...opts.map((o, i) => ({ title: letters[i], w: 24, align: 'r' }))];
  for (let i = 1; i < opts.length; i++) cols.push({ title: t('thChange', { x: opts[i].letter, a: A.letter }), w: 26, align: 'r' }, { title: `${t('thChangePct')} ${opts[i].letter}–${A.letter}`, w: 26, align: 'r' });
  cols.push({ title: t('thUnit'), w: 14, align: 'c' });
  const groupTitle = { instant: t('modelInstant').split('(')[0].trim(), dynamic: t('modelDynamic').split('(')[0].trim(), retention: t('secRetention') };
  let lastGroup = null; const rows = [];
  for (const r of cmp.rows) {
    if (r.group !== lastGroup) { lastGroup = r.group; const gr = [{ text: groupTitle[r.group], bold: true, color: C.accent }, ...cols.slice(1).map(() => '')]; gr.opts = { bg: [250, 251, 253] }; rows.push(gr); }
    const label = r.label.vars ? t(r.label.key, r.label.vars) : t(r.label.key);
    const row = [r.neighbours ? { text: `${label} *`, bold: true } : label, ...r.values.map((v) => f.val(v, r.unit))];
    for (let i = 1; i < opts.length; i++) {
      const dv = r.deltas[i], dp = r.deltaPct[i];
      const tol = r.values[0] != null ? Math.max(Math.abs(r.values[0]) * 0.01, 1e-9) : 0;
      const col = r.better && dv != null && Math.abs(dv) > tol ? ((dv < 0) === (r.better === 'lower') ? C.good : C.bad) : C.text;
      row.push({ text: dv == null ? '–' : nf.signed(dv, (v) => f.val(v, r.unit)), color: col }, { text: dp == null ? '–' : `${nf.signed(dp, (v) => nf.fixed(v, 1))} %`, color: col });
    }
    row.push(f.u[r.unit] || '');
    if (r.neighbours) row.opts = { bg: C.neighbourBg };
    rows.push(row);
  }
  L.table(cols, rows, { size: 8.2, zebra: false });
  L.para(`* ${t('secNeighbours')}`, { size: 7.5, color: C.muted });
  // neighbours
  L.h2(t('secNeighbours'));
  L.para(t('neighboursIntro'), { size: 8.5 });
  const nrows = [];
  nrows.push([t('kfLeaves') + (basis === 'dynamic' ? ` (${t('modelDynamic').split('(')[0].trim()})` : ''), ...opts.map((o) => f.withUnit(basis === 'dynamic' ? o.dynamic.leavesSiteM3 : o.instant.leavesSiteM3, 'm3'))]);
  if (basis === 'dynamic') nrows.push([`${t('kfLeaves')} (${t('modelInstant').split('(')[0].trim()})`, ...opts.map((o) => f.withUnit(o.instant.leavesSiteM3, 'm3'))]);
  cmp.diffStats.forEach((ds, i) => {
    const b = letters[i + 1];
    nrows.push([t('diffStatsEdgeWetter', { m: nf.fixed(ds.edgeWidthM) }) + ` (${b})`, ...opts.map((_, j) => (j === i + 1 ? f.withUnit(ds.edgeWetterAreaM2, 'm2') : '–'))]);
    nrows.push([t('diffStatsEdgeDrier', { m: nf.fixed(ds.edgeWidthM) }) + ` (${b})`, ...opts.map((_, j) => (j === i + 1 ? f.withUnit(ds.edgeDrierAreaM2, 'm2') : '–'))]);
  });
  L.table([{ title: '' }, ...letters.map((l) => ({ title: l, w: 30, align: 'r' }))], nrows, { size: 8.3 });
  if (model.project.notes) { L.h2(t('notes')); L.para(model.project.notes); }

  // --- side-by-side depth maps (identical extent and colour scale)
  const ext = unionExtent(records.map((r) => gridExtent(r.grid)));
  const perPage = Math.min(opts.length, 2);
  const sideBySide = (layer, title, extraFor) => {
    for (let p = 0; p < opts.length; p += perPage) {
      L.newPage(); L.h1(title); L.para(t('sideBySideNote'), { size: 8, color: C.muted });
      const legendW = 42; const gapX = 6; const each = (L.cw - legendW - 4 - gapX * (perPage - 1)) / perPage;
      const yStart = L.y; let yEnd = yStart;
      for (let k = 0; k < perPage && p + k < opts.length; k++) {
        const i = p + k;
        const box = fitBox(ext, each, L.yBot - yStart - 22);
        const r = mapFigure(L, ctx, { layer, rec: records[i], extent: ext, title: `${letters[i]}: ${opts[i].name}`, x: L.x0 + k * (each + gapX), y: yStart, w: box.w, maxH: box.h, legendW: 0, noLegend: true, spots: layer === 'depth' ? opts[i].instant.topBluespots : null, caption: opts[i].inputs.caption });
        yEnd = Math.max(yEnd, r.endY);
      }
      drawLegend(L, layer, t, nf, L.x1 - legendW, yStart + 6, legendW, extraFor ? extraFor() : { paths: layer === 'depth' });
      L.y = yEnd + 4;
    }
  };
  sideBySide(depthLayer, t('secSideBySide'));
  if (basis === 'dynamic') sideBySide('hazard', t('mapHazard'));

  // --- difference maps
  internals.diffs.forEach((dd, i) => {
    const B = opts[i + 1]; const vars = { a: letters[0], b: letters[i + 1] };
    L.newPage(); L.h1(`${t('secDiff')}: ${letters[i + 1]} – ${letters[0]}`);
    const fig = mapFigure(L, ctx, { layer: 'diff', rec: records[i + 1], extent: ext, title: t('mapDiff', vars), diff: { grid: dd.grid, values: dd.diff, proposal: records[i + 1] }, legendExtra: vars, legendW: 62, caption: opts[i + 1].inputs.caption, maxH: L.yBot - L.y - 22 });
    const ds = cmp.diffStats[i];
    const endMap = L.y; L.y = fig.legendEnd + 4;
    L.table([{ title: t('thQuantity') }, { title: t('thValue'), w: 20, align: 'r' }], [
      [t('diffStatsDrier', vars), { text: f.withUnit(ds.drierAreaM2, 'm2'), color: C.good }],
      [t('diffStatsWetter', vars), { text: f.withUnit(ds.wetterAreaM2, 'm2'), color: C.bad }],
      [t('diffStatsMaxDown'), `${nf.signed(ds.maxDecreaseM * 100, (v) => nf.fixed(v))} cm`],
      [t('diffStatsMaxUp'), `${nf.signed(ds.maxIncreaseM * 100, (v) => nf.fixed(v))} cm`],
      [t('diffStatsEdgeWetter', { m: nf.fixed(ds.edgeWidthM) }), f.withUnit(ds.edgeWetterAreaM2, 'm2')],
      [t('diffStatsEdgeDrier', { m: nf.fixed(ds.edgeWidthM) }), f.withUnit(ds.edgeDrierAreaM2, 'm2')],
    ], { size: 7.6, x: fig.legendX, w: fig.legendW, header: false });
    L.y = Math.max(endMap, L.y);
    void B;
  });

  // --- surfaces per option
  L.newPage(); L.h1(t('secSurfacesCompare'));
  {
    const legendW = 50; const gapX = 6; const n = Math.min(opts.length, 2); const each = (L.cw - legendW - 4 - gapX * (n - 1)) / n; const yStart = L.y; let yEnd = yStart;
    for (let k = 0; k < n; k++) {
      const box = fitBox(ext, each, 68);
      const r = mapFigure(L, ctx, { layer: 'materials', rec: records[k], extent: ext, title: `${letters[k]}: ${opts[k].name}`, x: L.x0 + k * (each + gapX), y: yStart, w: box.w, maxH: box.h, legendW: 0, noLegend: true });
      yEnd = Math.max(yEnd, r.endY);
    }
    const mats = new Map(); opts.forEach((o) => o.surfaces.rows.forEach((m) => { if (!mats.has(m.id)) mats.set(m.id, m); }));
    drawLegend(L, 'materials', t, nf, L.x1 - legendW, yStart + 6, legendW, { materials: [...mats.values()].slice(0, 14), buildings: t('buildings').split('(')[0].trim() });
    L.y = yEnd + 4;
    const ids = [...mats.keys()];
    const area = (o, id) => o.surfaces.rows.find((m) => m.id === id)?.areaM2 ?? 0;
    const srows = ids.map((id) => [{ text: mats.get(id).name, swatch: mats.get(id).color }, ...opts.map((o) => f.withUnit(area(o, id), 'm2')), ...opts.slice(1).map((o) => nf.signed(area(o, id) - area(A, id), (v) => nf.fixed(v)))]);
    srows.push([{ text: t('buildings').split('(')[0].trim(), swatch: '#4a5260' }, ...opts.map((o) => f.withUnit(o.surfaces.buildingsAreaM2, 'm2')), ...opts.slice(1).map((o) => nf.signed(o.surfaces.buildingsAreaM2 - A.surfaces.buildingsAreaM2, (v) => nf.fixed(v)))]);
    L.table([{ title: t('thMaterial') }, ...letters.map((l) => ({ title: `${l} (${f.u.m2})`, w: 28, align: 'r' })), ...opts.slice(1).map((o) => ({ title: `${t('thChange', { x: o.letter, a: A.letter })} (${f.u.m2})`, w: 32, align: 'r' }))], srows, { size: 8 });
    L.para(t('surfacesNote'), { size: 7.5, color: C.muted });
  }

  // --- inputs per option
  L.newPage(); L.h1(t('secInputsCompare'));
  const inRow = (label, fn) => [label, ...opts.map(fn)];
  L.table([{ title: t('thField'), w: 62 }, ...letters.map((l) => ({ title: l }))], [
    inRow(t('rainEvent'), (o) => presetLabel(o.inputs.rain, t)),
    inRow(t('rainDepth'), (o) => (o.inputs.rain ? `${nf.smart(o.inputs.rain.depthMm)} mm` : '–')),
    inRow(t('climateFactor'), (o) => (o.inputs.rain ? nf.fixed(o.inputs.rain.climateFactor, 2) : '–')),
    inRow(t('designDepth'), (o) => (o.inputs.rain ? `${nf.smart(o.inputs.rain.designDepthMm)} mm` : '–')),
    inRow(t('designChanges'), (o) => designText(o, t)),
    inRow(t('sewer'), (o) => sewerLabel(o.inputs.sewer, t)), inRow(t('moisture'), (o) => moistLabel(o.inputs.moisture, t)), inRow(t('soil'), () => 'JB-6'),
    inRow(t('cellSize'), (o) => `${nf.fixed(o.inputs.grid.cellSizeM, 2)} m`),
    inRow(t('dynCell'), (o) => (o.dynamic ? `${nf.fixed(o.dynamic.cellSizeM, 1)} m, ${nf.fixed(o.dynamic.simulatedMin)} min` : '–')),
    inRow(t('terrainSource'), (o) => ({ synthetic: t('kindSynthetic'), dhm: 'DHM/Terræn', upload: o.site.description }[o.site.terrain])),
    inRow(t('retInputDischarge'), (o) => (o.retention ? `${nf.smart(o.retention.input.dischargeLSHa)} l/s/ha, T = ${o.retention.input.returnPeriodYears}` : '–')),
    inRow(t('appCaption'), (o) => o.inputs.caption || '–'),
  ], { size: 7.6, padY: 1.1 });
  cmp.inputDifferences.forEach((d) => L.para(d.fields.length ? t('inputsDiffer', { list: d.fields.join(', ') }) : t('sameInputs'), { size: 8.5, color: d.fields.length ? C.bad : C.muted }));
  // site of baseline
  siteSection(L, ctx, A, 7.6);

  // --- balance & retention per option
  L.newPage(); L.h1(`${t('secBalance')} · ${t('secRetention')}`);
  balanceSection(L, ctx, opts, letters); retentionSection(L, ctx, opts, letters);
  L.newPage(); methodSection(L, ctx);
  L.newPage(); appendixSection(L, ctx, model);
}

function headersFooters(doc, L, model, t) {
  const n = doc.getNumberOfPages(); const p = model.project;
  const title = model.kind === 'comparison' ? t('docTitleCompare') : t('docTitle');
  for (let i = 1; i <= n; i++) {
    doc.setPage(i);
    const left = [p.name || model.site.name, p.revision ? `${t('revision')} ${p.revision}` : null, p.date].filter(Boolean).join('  ·  ');
    doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5); doc.setTextColor(...C.muted);
    doc.text(pdfText(left), L.x0, 10); doc.text(pdfText(title), L.x1, 10, { align: 'right' });
    doc.setDrawColor(...C.line); doc.setLineWidth(0.2); doc.line(L.x0, 12, L.x1, 12);
    const fy = L.H - 10;
    doc.line(L.x0, fy - 4.2, L.x1, fy - 4.2);
    doc.setFont('helvetica', 'bold'); doc.setFontSize(7); doc.setTextColor(...C.warnText);
    const stmt = doc.splitTextToSize(pdfText(t('screeningShort')), L.cw - 30);
    stmt.forEach((ln, j) => doc.text(ln, L.x0, fy - 1 + j * 2.9));
    doc.setFont('helvetica', 'normal'); doc.setTextColor(...C.muted);
    doc.text(pdfText(`${t('page')} ${i} ${t('of')} ${n}`), L.x1, fy - 1, { align: 'right' });
    doc.setFontSize(6.5); doc.setTextColor(...C.faint);
    doc.text(pdfText(`Cloudburst ${model.tool.engineVersion || ''} · ${t('generated')} ${model.generatedAt.slice(0, 16).replace('T', ' ')}`), L.x1, fy + 2.4, { align: 'right' });
  }
}

/** FNV-1a hex digest (32 chars), used as the PDF file ID so identical models give identical files. */
function digest(str) {
  let out = '';
  for (let s = 0; s < 4; s++) { let h = 0x811c9dc5 ^ s; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); } out += (h >>> 0).toString(16).padStart(8, '0'); }
  return out.toUpperCase();
}

/**
 * Render the PDF. records = the raw records the model was built from (maps need their arrays).
 * Returns { blob, pages, mapsInfo }.
 */
export async function renderPdf({ model, internals, records, palette }) {
  const jsPDF = await loadJsPdf();
  const t = translator(model.lang); const nf = numberFormat(model.lang); const f = makeFmt(t, nf);
  const orientation = model.kind === 'comparison' ? 'landscape' : 'portrait';
  const doc = new jsPDF({ orientation, unit: 'mm', format: 'a4', compress: true, putOnlyUsedFonts: true });
  const title = model.kind === 'comparison' ? t('docTitleCompare') : t('docTitle');
  doc.setProperties({ title: pdfText(`${title} – ${model.project.name || model.site.name}`), subject: pdfText(t('screeningShort')), author: pdfText(model.project.author || ''), creator: 'Cloudburst web (jsPDF)', keywords: 'cloudburst, screening model, skybrud' });
  try { doc.setCreationDate(new Date(model.generatedAt)); doc.setFileId(digest(JSON.stringify(model))); } catch { /* older jsPDF */ }
  doc.setLanguage(model.lang === 'da' ? 'da-DK' : 'en-GB');
  const L = new Layout(doc);
  const ctx = { t, nf, f, palette, mapsInfo: [] };
  if (model.kind === 'comparison') comparisonReport(L, ctx, model, records, internals);
  else singleReport(L, ctx, model, records[0]);
  headersFooters(doc, L, model, t);
  return { blob: doc.output('blob'), pages: doc.getNumberOfPages(), mapsInfo: ctx.mapsInfo, dpi: PRINT_DPI };
}
