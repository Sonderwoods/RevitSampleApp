// Report data model: ONE place where app results become the plain-JSON structure that the PDF is drawn from.
// No DOM and no engine calls here, so the same rules can be ported to .NET (see docs/reports.md).
//
//   const model = buildReportModel({ kind: 'single' | 'comparison', records: [rec, ...], project, lang, tool });
//
// A "record" is one result (the current one or a saved option) with its raw arrays (see report.js → recordFrom*):
//   { id, letter, name, createdAt, site, settings, preset, caption, grid, instant, dyn, dynMeta, retention, palette }
// The model holds numbers in SI units (m, m², m³, m/s, l/s) plus the metadata needed to explain them. Formatting and
// language happen in the renderer; only the generated summary sentences are stored already translated.
import { differenceArray } from './raster.js';
import { translator, numberFormat } from './report-i18n.js';

export const SCHEMA = 'cloudburst-report/1';
export const DEPTH_THRESHOLDS_CM = [10, 20, 30, 50];
const RETURN_PERIOD = { t10: 10, t100: 100 };
const SEWER_LOSS_MM = [0, 34, 29];
/** Hazard classes (OUT-3, same breaks as js/colors.js HAZARD). "danger for some" starts at 0.75 m²/s. */
const HAZARD_BREAKS = [0.5, 0.75, 1.25, 2];
const DYN_WET = 0.03; // m, the app hides dynamic depths below 3 cm
const DIFF_MIN = 0.01; // m, changes below 1 cm are treated as no change (same as js/colors.js DIFF)
/** Relative change below which a figure is reported as "essentially unchanged". */
const SAME_REL = 0.01;

// ------------------------------------------------------------------------------------------------ per record
function cellArea(g) { return g.dx * g.dx; }
function isGround(g, k) { return g.building[k] < 0 && (!g.active || g.active[k]); }

function rainOf(rec) {
  const s = rec.settings; const p = rec.preset;
  if (!s || !p) return null;
  const scale = p.depthMm > 0 ? s.rainDepthMm / p.depthMm : 1;
  const intensity = Array.from(p.intensity || [], (v) => +(v * scale * s.climateFactor).toFixed(2));
  const peak = intensity.length ? Math.max(...intensity) : null;
  const mean = intensity.length ? intensity.reduce((a, b) => a + b, 0) / intensity.length : 0;
  const isBox = intensity.length > 0 && peak <= mean * 1.02;
  return {
    presetId: p.id, presetName: p.name, returnPeriodYears: RETURN_PERIOD[p.id] ?? null,
    depthMm: s.rainDepthMm, presetDepthMm: p.depthMm, custom: Math.abs(s.rainDepthMm - p.depthMm) > 0.01,
    climateFactor: s.climateFactor, designDepthMm: s.rainDepthMm * s.climateFactor,
    durationMin: p.durationMin, peakIntensityMmH: peak, shape: isBox ? 'box' : 'cds', intensityMmH: intensity,
  };
}

function inputsOf(rec, t, nf) {
  const g = rec.grid; const s = rec.settings;
  return {
    rain: rainOf(rec),
    sewer: s ? { mode: s.sewerMode, initialLossMm: SEWER_LOSS_MM[s.sewerMode] ?? null } : null,
    moisture: s ? { mode: s.moisture } : null,
    soil: { jb: 6, source: 'engine default' },
    grid: { cellSizeM: g.dx, nx: g.nx, ny: g.ny, x0: g.x0, y0: g.y0, widthM: g.nx * g.dx, heightM: g.ny * g.dx, cells: g.nx * g.ny, warnings: [...(g.warnings || [])] },
    dynamic: rec.dyn ? { cellSizeM: rec.dyn.grid.dx, simulatedMin: (rec.dyn.mass.simulatedS || 0) / 60 } : null,
    caption: captionFor(rec, t, nf),
  };
}

/** OUT-9 caption: rain event, climate factor, sewer, soil moisture, cell size and the words "screening model". */
function captionFor(rec, t, nf) {
  const r = rainOf(rec); const s = rec.settings;
  if (!r || !s || !t) return rec.legacyCaption || null;
  const sewer = [t('sewerNone'), t('sewerCombined'), t('sewerSeparate')][s.sewerMode] || '';
  const moist = [t('moistDry'), t('moistMoist'), t('moistWet')][s.moisture] || '';
  const cell = rec.dyn ? `${nf.fixed(rec.grid.dx, 1)} m / ${nf.fixed(rec.dyn.grid.dx, 1)} m` : `${nf.fixed(rec.grid.dx, 1)} m`;
  return [`${t('presetNames')[r.presetId] || r.presetName}: ${nf.smart(r.depthMm)} mm × ${nf.fixed(r.climateFactor, 2)} = ${nf.smart(r.designDepthMm)} mm`,
    sewer.split(',')[0], `${t('moisture')}: ${moist.split(' (')[0].toLowerCase()}`, `${t('cellSize')} ${cell}`, t('screeningShort').split(' – ')[0]].join(' · ');
}

function surfacesOf(rec) {
  const g = rec.grid; const pal = rec.palette; const a = cellArea(g);
  const cnt = new Map(); let bld = 0, total = 0;
  for (let k = 0; k < g.material.length; k++) {
    if (g.active && !g.active[k]) continue;
    total++;
    if (g.building[k] >= 0) { bld++; continue; }
    cnt.set(g.material[k], (cnt.get(g.material[k]) || 0) + 1);
  }
  const rows = [...cnt.entries()].sort((x, y) => y[1] - x[1]).map(([idx, c]) => {
    const m = pal.materials[idx] || {};
    return {
      id: m.id || `#${idx}`, name: m.name || `Material ${idx}`, category: m.category || '', color: m.color || '#999999',
      areaM2: c * a, share: total ? c / total : 0, cNormal: m.cNormal, cCbSand: m.cCloudburstSand, cCbClay: m.cCloudburstClay,
      manningN: m.manningN, fSandMmH: m.infiltrationSand, fClayMmH: m.infiltrationClay, iaMm: m.initialLossMm, useSoilTable: !!m.useSoilTable, sealed: !!m.sealed,
    };
  });
  return { rows, buildingsAreaM2: bld * a, buildingsShare: total ? bld / total : 0, totalAreaM2: total * a };
}

function areasOver(g, depth, thresholdsM, maskFn) {
  const a = cellArea(g); const out = thresholdsM.map(() => 0); let wet = 0, maxD = 0;
  for (let k = 0; k < depth.length; k++) {
    if (!isGround(g, k) || (maskFn && !maskFn(k))) continue;
    const d = depth[k]; if (!(d > 0)) continue;
    if (d > maxD) maxD = d;
    for (let i = 0; i < thresholdsM.length; i++) if (d > thresholdsM[i]) out[i] += a;
  }
  return { areas: out, maxD, wet };
}

function instantFiguresOf(rec) {
  const r = rec.instant; if (!r) return null;
  const st = r.stats; const g = rec.grid;
  const ov = areasOver(g, r.depth, DEPTH_THRESHOLDS_CM.map((c) => c / 100));
  const top = [...r.bluespots].filter((b) => b.volumeM3 >= 1).sort((x, y) => y.volumeM3 - x.volumeM3).slice(0, 8)
    .map((b, i) => ({ rank: i + 1, x: b.x, y: b.y, volumeM3: b.volumeM3, maxDepthM: b.maxDepthM, areaM2: b.areaM2, spills: !!b.spills,
      fillPct: b.capacityM3 > 0 ? Math.min(100, (b.volumeM3 / b.capacityM3) * 100) : null, spillRainMm: b.spillRainMm ?? null, contributingAreaM2: b.contributingAreaM2 ?? null }));
  return {
    rainM3: st.rainVolumeM3, effectiveM3: st.effectiveVolumeM3, lossesM3: Math.max(0, st.rainVolumeM3 - st.effectiveVolumeM3),
    pondedM3: st.storedVolumeM3, leavesSiteM3: st.outflowVolumeM3, floodedAreaM2: st.floodedAreaM2,
    areaOverM2: Object.fromEntries(DEPTH_THRESHOLDS_CM.map((c, i) => [c, ov.areas[i]])),
    engineAreaOver10CmM2: st.areaOver10CmM2, maxDepthM: st.maxDepthM, bluespotCount: st.bluespotCount, spillingCount: st.spillingCount,
    topBluespots: top, minShownDepthM: 0.01,
  };
}

function dynamicFiguresOf(rec) {
  const d = rec.dyn; if (!d) return null;
  const g = d.grid; const m = d.mass; const a = cellArea(g);
  const wetMask = (k) => d.hMax[k] >= DYN_WET;
  const ov = areasOver(g, d.hMax, DEPTH_THRESHOLDS_CM.map((c) => c / 100));
  let maxV = 0, wetArea = 0, hv05 = 0; const hz = HAZARD_BREAKS.map(() => 0);
  for (let k = 0; k < d.hMax.length; k++) {
    if (!isGround(g, k) || !wetMask(k)) continue;
    wetArea += a;
    if (d.vMax[k] > maxV) maxV = d.vMax[k];
    for (let i = 0; i < HAZARD_BREAKS.length; i++) if (d.hazard[k] >= HAZARD_BREAKS[i]) hz[i] += a;
    if (d.hv && d.hv[k] > 0.5) hv05 += a;
  }
  const total = m.rainM3 + (m.initialWaterM3 || 0);
  return {
    rainM3: m.rainM3, initialWaterM3: m.initialWaterM3 || 0, initialLossM3: m.initialLossM3, infiltratedM3: m.infiltratedM3, sewerM3: m.sewerM3,
    leavesSiteM3: m.boundaryOutM3, storedEndM3: m.storedM3, massErrorPct: m.errorFraction * 100,
    massResidualM3: total - (m.initialLossM3 + m.infiltratedM3 + m.sewerM3 + m.boundaryOutM3 + m.storedM3),
    maxDepthM: ov.maxD, wetAreaM2: wetArea, areaOverM2: Object.fromEntries(DEPTH_THRESHOLDS_CM.map((c, i) => [c, ov.areas[i]])),
    maxVelocityMS: maxV, hazardAreaAtLeastM2: Object.fromEntries(HAZARD_BREAKS.map((b, i) => [b, hz[i]])), hazardDangerSomeM2: hz[1], hvOver05M2: hv05,
    simulatedMin: (m.simulatedS || 0) / 60, cellSizeM: g.dx, steps: m.steps, elapsedS: m.elapsedS, minShownDepthM: DYN_WET,
  };
}

function retentionOf(rec) {
  const R = rec.retention; if (!R || !R.result) return null;
  const r = R.result; const i = R.input || {};
  return {
    input: { dischargeLSHa: i.dischargeLSHa, returnPeriodYears: i.returnPeriod, climateFactor: i.climateFactor, safetyFactor: i.safetyFactor ?? 1.2 },
    totalAreaM2: r.totalAreaM2, reducedAreaM2: r.reducedAreaM2, meanC: r.meanC, rationalPeakLS: r.peakFlowLS,
    allowedOutflowLS: r.outflowLS, requiredStorageM3: r.requiredStorageM3, criticalDurationMin: r.criticalDurationMin,
  };
}

function siteOf(rec) {
  const s = rec.site || {}; const g = rec.grid;
  const kind = s.kind === 'synthetic' ? 'synthetic' : s.kind === 'real' ? 'real' : 'custom';
  const isDhm = kind !== 'synthetic' && (/DHM/i.test(s.description || '') || !!s.bbox || !!s.dhmFile);
  return {
    id: s.id, name: s.name, kind, description: s.description || '', bbox: s.bbox || null, dhmFile: s.dhmFile || null,
    crs: kind === 'synthetic' ? null : 'EPSG:25832 (ETRS89 / UTM 32N)', terrain: kind === 'synthetic' ? 'synthetic' : isDhm ? 'dhm' : 'upload',
    extent: { x0: g.x0, y0: g.y0, x1: g.x0 + g.nx * g.dx, y1: g.y0 + g.ny * g.dx },
  };
}

/** Everything the report says about one result. */
export function optionModel(rec, t, nf) {
  return {
    id: rec.id, letter: rec.letter, name: rec.name, createdAt: rec.createdAt || null,
    basisAvailable: rec.dyn ? ['instant', 'dynamic'] : ['instant'],
    site: siteOf(rec), inputs: inputsOf(rec, t, nf), surfaces: surfacesOf(rec),
    instant: instantFiguresOf(rec), dynamic: dynamicFiguresOf(rec), retention: retentionOf(rec),
  };
}

// ------------------------------------------------------------------------------------------------ comparison
/** Key-figure rows. `better`: which direction is an improvement for flooding ('lower'), or null when neutral. */
const ROWS_INSTANT = [
  ['rainM3', 'kfRain', 'm3', null, (o) => o.instant?.rainM3],
  ['pondedM3', 'kfPonded', 'm3', 'lower', (o) => o.instant?.pondedM3],
  ['leavesSiteM3', 'kfLeaves', 'm3', 'lower', (o) => o.instant?.leavesSiteM3, { neighbours: true }],
  ['floodedAreaM2', 'kfFlooded', 'm2', 'lower', (o) => o.instant?.floodedAreaM2],
  ['areaOver10M2', ['kfOver', { cm: 10 }], 'm2', 'lower', (o) => o.instant?.areaOverM2[10]],
  ['areaOver20M2', ['kfOver', { cm: 20 }], 'm2', 'lower', (o) => o.instant?.areaOverM2[20]],
  ['areaOver30M2', ['kfOver', { cm: 30 }], 'm2', 'lower', (o) => o.instant?.areaOverM2[30]],
  ['maxDepthCm', 'kfMaxDepth', 'cm', 'lower', (o) => (o.instant ? o.instant.maxDepthM * 100 : null)],
  ['bluespots', 'kfBluespots', '', null, (o) => o.instant?.bluespotCount],
];
const ROWS_DYNAMIC = [
  ['dynLeavesSiteM3', 'kfLeaves', 'm3', 'lower', (o) => o.dynamic?.leavesSiteM3, { neighbours: true }],
  ['dynStoredEndM3', 'kfStoredEnd', 'm3', null, (o) => o.dynamic?.storedEndM3],
  ['dynInfiltratedM3', 'kfInfiltrated', 'm3', null, (o) => o.dynamic?.infiltratedM3],
  ['dynSewerM3', 'kfSewer', 'm3', null, (o) => o.dynamic?.sewerM3],
  ['dynAreaOver10M2', ['kfOver', { cm: 10 }], 'm2', 'lower', (o) => o.dynamic?.areaOverM2[10]],
  ['dynMaxDepthCm', 'kfMaxDepth', 'cm', 'lower', (o) => (o.dynamic ? o.dynamic.maxDepthM * 100 : null)],
  ['dynMaxVelocity', 'kfMaxVel', 'ms', 'lower', (o) => o.dynamic?.maxVelocityMS],
  ['dynHazardM2', 'kfHazardHigh', 'm2', 'lower', (o) => o.dynamic?.hazardDangerSomeM2],
  ['dynHvM2', 'kfHv', 'm2', 'lower', (o) => o.dynamic?.hvOver05M2],
  ['dynMassErrorPct', 'kfMassError', 'pct', null, (o) => o.dynamic?.massErrorPct, { noDelta: true }],
];
const ROWS_RETENTION = [
  ['reducedAreaM2', 'kfReducedArea', 'm2', null, (o) => o.retention?.reducedAreaM2],
  ['rationalPeakLS', 'kfRationalPeak', 'ls', null, (o) => o.retention?.rationalPeakLS],
  ['requiredStorageM3', 'kfStorage', 'm3', null, (o) => o.retention?.requiredStorageM3],
];

function rowsFor(defs, opts, group) {
  return defs.map(([id, label, unit, better, get, extra = {}]) => {
    const values = opts.map((o) => { const v = get(o); return v == null || !isFinite(v) ? null : v; });
    const base = values[0];
    const deltas = values.map((v, i) => (i === 0 || v == null || base == null || extra.noDelta ? null : v - base));
    const deltaPct = values.map((v, i) => (i === 0 || deltas[i] == null || !(Math.abs(base) > 1e-9) ? null : (deltas[i] / Math.abs(base)) * 100));
    return { id, group, label: Array.isArray(label) ? { key: label[0], vars: label[1] } : { key: label }, unit, better, values, deltas, deltaPct, ...extra };
  }).filter((r) => r.values.some((v) => v != null));
}

function edgeMask(g, widthM) {
  const n = Math.max(1, Math.round(widthM / g.dx));
  return (k) => { const i = k % g.nx, j = (k / g.nx) | 0; return i < n || j < n || i >= g.nx - n || j >= g.ny - n; };
}

/** B − A on A's grid, plus the statistics the report quotes. Positive = more water in B. */
export function diffStats(recA, recB, basis) {
  const [gA, dA] = basis === 'dynamic' ? [recA.dyn.grid, recA.dyn.hMax] : [recA.grid, recA.instant.depth];
  const [gB, dB] = basis === 'dynamic' ? [recB.dyn.grid, recB.dyn.hMax] : [recB.grid, recB.instant.depth];
  const diff = differenceArray(gA, dA, gB, dB);
  const a = cellArea(gA); const edgeM = Math.max(5, 2 * gA.dx); const onEdge = edgeMask(gA, edgeM);
  let wet = 0, dry = 0, edgeWet = 0, edgeDry = 0, maxUp = 0, maxDown = 0, net = 0;
  for (let k = 0; k < diff.length; k++) {
    if (gA.building[k] >= 0) continue;
    const d = diff[k]; net += d * a;
    if (d >= DIFF_MIN) { wet += a; if (onEdge(k)) edgeWet += a; }
    else if (d <= -DIFF_MIN) { dry += a; if (onEdge(k)) edgeDry += a; }
    if (d > maxUp) maxUp = d; if (d < maxDown) maxDown = d;
  }
  return { diff, grid: gA, stats: { thresholdM: DIFF_MIN, wetterAreaM2: wet, drierAreaM2: dry, edgeWidthM: edgeM, edgeWetterAreaM2: edgeWet, edgeDrierAreaM2: edgeDry, maxIncreaseM: maxUp, maxDecreaseM: maxDown, netVolumeChangeM3: net } };
}

function inputDifferences(base, o, t) {
  const out = []; const A = base.inputs, B = o.inputs;
  const ra = A.rain, rb = B.rain;
  if (!ra || !rb) out.push(t('rainEvent'));
  else {
    if (ra.presetId !== rb.presetId) out.push(t('rainEvent'));
    if (Math.abs(ra.designDepthMm - rb.designDepthMm) > 0.01) out.push(t('designDepth'));
  }
  if (A.sewer?.mode !== B.sewer?.mode) out.push(t('sewer'));
  if (A.moisture?.mode !== B.moisture?.mode) out.push(t('moisture'));
  if (A.grid.cellSizeM !== B.grid.cellSizeM) out.push(t('cellSize'));
  if ((A.dynamic && B.dynamic) && A.dynamic.cellSizeM !== B.dynamic.cellSizeM) out.push(t('dynCell'));
  const ea = base.site.extent, eb = o.site.extent;
  if (Math.abs(ea.x0 - eb.x0) + Math.abs(ea.y0 - eb.y0) + Math.abs(ea.x1 - eb.x1) + Math.abs(ea.y1 - eb.y1) > 1e-6) out.push(t('extent'));
  const ta = base.retention?.input, tb = o.retention?.input;
  if (ta && tb && (ta.dischargeLSHa !== tb.dischargeLSHa || ta.returnPeriodYears !== tb.returnPeriodYears || ta.climateFactor !== tb.climateFactor)) out.push(t('secRetention'));
  return out;
}

function direction(a, b, fmt, t, unit) {
  if (a == null || b == null) return t('dirSame');
  const d = b - a;
  const tol = Math.max(Math.abs(a) * SAME_REL, unit === 'm3' ? 0.5 : unit === 'm2' ? 1 : 0.005);
  if (Math.abs(d) <= tol) return t('dirSame');
  if (!(Math.abs(a) > 1e-9)) return t('dirNew', { d: `${fmt(Math.abs(d))} ${t('units')[unit] || ''}`.trim() });
  return t(d < 0 ? 'dirDown' : 'dirUp', { d: `${fmt(Math.abs(d))} ${t('units')[unit] || ''}`.trim(), p: fmt(Math.abs((d / a) * 100)) });
}

function summaryComparison(opts, basis, diffs, t, nf) {
  const A = opts[0]; const out = [];
  const r = A.inputs.rain; const u = t('units');
  if (r) out.push(t('sumEvent', { event: t('presetNames')[r.presetId] || r.presetName, depth: nf.smart(r.depthMm), cf: nf.fixed(r.climateFactor, 2), design: nf.smart(r.designDepthMm), area: `${nf.smart(A.surfaces.totalAreaM2)} ${u.m2}` }));
  for (let i = 1; i < opts.length; i++) {
    const B = opts[i]; const a = t('optionLetter', { l: A.letter }), b = t('optionLetter', { l: B.letter });
    const diffList = inputDifferences(A, B, t);
    out.push(diffList.length ? t('inputsDiffer', { list: diffList.join(', ') }) : t('sameInputs'));
    const fa = basis === 'dynamic' ? A.dynamic : A.instant, fb = basis === 'dynamic' ? B.dynamic : B.instant;
    if (basis === 'instant') out.push(t('sumPonded', { a, b, va: nf.smart(fa.pondedM3), vb: nf.smart(fb.pondedM3), dir: direction(fa.pondedM3, fb.pondedM3, nf.smart, t, 'm3') }));
    out.push(t('sumOver10', { a, b, va: nf.smart(fa.areaOverM2[10]), vb: nf.smart(fb.areaOverM2[10]), dir: direction(fa.areaOverM2[10], fb.areaOverM2[10], nf.smart, t, 'm2') }));
    out.push(t('sumMax', { a, b, va: nf.fixed(fa.maxDepthM * 100), vb: nf.fixed(fb.maxDepthM * 100) }));
    const la = fa.leavesSiteM3, lb = fb.leavesSiteM3;
    out.push(t('sumLeaves', { a, b, va: nf.smart(la), vb: nf.smart(lb), dir: direction(la, lb, nf.smart, t, 'm3') }));
    const tol = Math.max(Math.abs(la) * SAME_REL, 0.5);
    out.push(lb - la > tol ? t('sumLeavesUp', { a, b }) : la - lb > tol ? t('sumLeavesDown', { a, b }) : t('sumLeavesSame'));
    const ds = diffs[i - 1].stats;
    out.push(t('sumEdge', { b, m: nf.fixed(ds.edgeWidthM), wet: nf.smart(ds.edgeWetterAreaM2), dry: nf.smart(ds.edgeDrierAreaM2) }));
    if (A.retention && B.retention) out.push(t('sumStorage', { a, b, va: nf.smart(A.retention.requiredStorageM3), vb: nf.smart(B.retention.requiredStorageM3) }));
  }
  out.push(t('sumCaveat'));
  return out;
}

function summarySingle(o, t, nf) {
  const out = []; const r = o.inputs.rain; const I = o.instant; const D = o.dynamic; const R = o.retention;
  if (r && I) out.push(t('sumSingle1', { event: t('presetNames')[r.presetId] || r.presetName, design: nf.smart(r.designDepthMm), cf: nf.fixed(r.climateFactor, 2), ponded: nf.smart(I.pondedM3), leaves: nf.smart(I.leavesSiteM3), rain: nf.smart(I.rainM3) }));
  if (I) out.push(t('sumSingle2', { a10: nf.smart(I.areaOverM2[10]), max: nf.fixed(I.maxDepthM * 100) }));
  if (D) out.push(t('sumSingle3', { v: nf.fixed(D.maxVelocityMS, 2), hz: nf.smart(D.hazardDangerSomeM2), err: fmtMassError(D.massErrorPct, nf) }));
  if (R) out.push(t('sumSingle4', { q: nf.smart(R.input.dischargeLSHa), t: nf.fixed(R.input.returnPeriodYears), s: nf.smart(R.requiredStorageM3) }));
  out.push(t('sumCaveat'));
  return out;
}

/** Mass error in % as printed: "< 0.001" when it is below what three decimals can show. */
export function fmtMassError(pct, nf) { return Math.abs(pct) < 0.001 ? `< ${nf.fixed(0.001, 3)}` : nf.fixed(pct, 3); }

// ------------------------------------------------------------------------------------------------ entry point
/**
 * Build the report model. Returns { model, internals } where `model` is plain JSON (safe to export/archive) and
 * `internals` holds the per-cell arrays the map renderer needs (difference arrays), never serialised.
 */
export function buildReportModel({ kind, records, project = {}, lang = 'en', tool = {}, generatedAt = new Date().toISOString() }) {
  if (!records || !records.length) throw new Error('No result to report');
  if (kind === 'comparison' && records.length < 2) throw new Error('A comparison needs at least two options');
  const t = translator(lang); const nf = numberFormat(lang);
  const opts = records.map((r) => optionModel(r, t, nf));
  const model = {
    schema: SCHEMA, kind, lang: t.lang, generatedAt,
    tool: { name: 'Cloudburst web', engineVersion: tool.engineVersion || null, ...tool },
    project: { name: '', address: '', matrikel: '', client: '', author: '', company: '', date: generatedAt.slice(0, 10), revision: '', notes: '', ...project },
    disclaimer: { short: t('screeningShort'), long: t('screeningBox') },
    site: opts[0].site,
    options: opts,
    references: { method: 'docs/physics-permeability.md', requirements: 'docs/PRD.md', reports: 'docs/reports.md' },
    comparison: null, summary: [],
  };
  const internals = { diffs: [] };
  if (kind === 'comparison') {
    const basis = records.every((r) => r.dyn) ? 'dynamic' : 'instant';
    const diffs = records.slice(1).map((r) => diffStats(records[0], r, basis));
    internals.diffs = diffs; internals.basis = basis;
    const rows = [...rowsFor(ROWS_INSTANT, opts, 'instant'), ...(basis === 'dynamic' ? rowsFor(ROWS_DYNAMIC, opts, 'dynamic') : []), ...rowsFor(ROWS_RETENTION, opts, 'retention')];
    model.comparison = {
      baseline: opts[0].letter, basis, rows,
      inputDifferences: opts.slice(1).map((o) => ({ option: o.letter, fields: inputDifferences(opts[0], o, t) })),
      diffStats: diffs.map((d, i) => ({ option: opts[i + 1].letter, ...d.stats })),
      neighbours: opts.map((o) => ({ option: o.letter, instantLeavesSiteM3: o.instant?.leavesSiteM3 ?? null, dynamicLeavesSiteM3: o.dynamic?.leavesSiteM3 ?? null })),
    };
    model.summary = summaryComparison(opts, basis, diffs, t, nf);
  } else {
    model.summary = summarySingle(opts[0], t, nf);
  }
  return { model, internals };
}

/** Rounded copy for export (keeps files small and diff-able). */
export function modelToJson(model) {
  return JSON.stringify(model, (k, v) => (typeof v === 'number' ? Math.round(v * 1000) / 1000 : v), 2);
}
