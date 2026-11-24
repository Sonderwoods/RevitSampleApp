// End-to-end check of the PDF report in headless Chromium (Playwright). Not part of the app.
//   python3 Web/serve.py 8411 &      then      node tools/report-e2e.cjs http://localhost:8411/ out-dir [en|da] [sections]
// sections (comma list, default all): single, pair, known, swap, upload
// Produces PDFs through the real UI (PDF button → dialog → Download) and prints the numbers the app holds next to the
// ones in the report model, plus the difference-map sign checks:
//   single-<lang>.pdf          school yard after (LAR), instant + dynamic (2 m)
//   comparison-<lang>.pdf      school yard before vs after, via the app's own pair compare
//   swap-single-<lang>.pdf     school yard before with asphalt → permeable pavers, instant + dynamic
//   swap-comparison-<lang>.pdf A as drawn vs B asphalt → permeable pavers, both with a dynamic run (saved options)
//   swap-three-<lang>.pdf      A as drawn, B permeable pavers, C clogged permeable pavers (three options in one report)
//   upload-coarse-<lang>.pdf   samples/fixtures/int16_pred2_deflate_geographic.tif (~31 m): "not suitable" cover warning
//   upload-osm-<lang>.pdf      samples/fixtures/tiled_deflate_pred3_be.tif (0.4 m, EPSG:25832) + OpenStreetMap context;
//                              Overpass is answered by a recorded fixture through page.route (no network needed)
// When pdftotext is installed, key phrases are also checked in the PDF text.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const base = process.argv[2] || 'http://localhost:8411/';
const out = path.resolve(process.argv[3] || 'report-e2e');
const lang = process.argv[4] || 'en';
const sections = new Set((process.argv[5] || 'single,pair,known,swap,upload').split(','));
const root = path.resolve(__dirname, '..');
fs.mkdirSync(out, { recursive: true });
const log = (...a) => console.log(...a);
let failures = 0;
const check = (ok, msg) => { if (!ok) { failures++; log('  FAIL', msg); } else log('  ok  ', msg); };
const close = (a, b, tol = 0.051) => a != null && b != null && Math.abs(a - b) <= tol * Math.max(1, Math.abs(a));

async function openSite(p, id) {
  await p.goto(`${base}#/site/${id}`);
  await p.waitForFunction((sid) => window.__cb && window.__cb.site && window.__cb.site.id === sid && window.__cb.instant && window.__cb.retention.result, id, { timeout: 90000 });
}
/** Open the dialog, pick type and language, fill the project fields. pick: option ids in order (comparison) or a source id (single). */
async function fillDialog(p, kind, { pick = null, notes = null } = {}) {
  await p.click('[data-export="report"]');
  await p.waitForSelector('#reportDlg');
  await p.click(`#reportDlg .rpt-seg button[data-lang="${lang}"]`);
  await p.click(`#reportDlg .rpt-seg button[data-kind="${kind}"]`);
  if (kind === 'single' && pick) await p.selectOption('#rptSource', pick);
  if (kind === 'comparison' && pick) {
    for (const id of await p.$$eval('#rptOpts input[type=checkbox]:checked', (xs) => xs.map((x) => x.dataset.id))) await p.click(`#rptOpts input[data-id="${id}"]`);
    for (const id of pick) await p.click(`#rptOpts input[data-id="${id}"]`);
  }
  const fields = { name: 'Skolegården – klimatilpasning', address: 'Eksempelvej 12, 5000 Odense C', matrikel: '1234a Odense Bygrunde', client: 'Example Municipality (sample data)',
    author: 'A. Landscape Architect', company: 'Example Studio ApS', date: '2026-11-24', revision: 'B', terrainDate: '' };
  for (const [k, v] of Object.entries(fields)) await p.fill(`#reportDlg [data-field="${k}"]`, v);
  await p.fill('#reportDlg [data-field="notes"]', notes || (kind === 'comparison'
    ? 'Option B replaces part of the asphalt with a rain garden and permeable paving (sample "School yard – after (LAR)"). Example report generated from built-in sample data.'
    : 'Example report generated from built-in sample data.'));
}
async function download(p, file) {
  const [dl] = await Promise.all([p.waitForEvent('download', { timeout: 180000 }), p.click('#rptGo')]);
  await dl.saveAs(path.join(out, file));
  await p.click('#reportDlg .rpt-x');
  return path.join(out, file);
}
/** Plain text of a PDF (null when pdftotext is not installed). */
function pdfText(file) {
  const r = spawnSync('pdftotext', ['-layout', file, '-'], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout : null;
}
function expectText(file, phrases) {
  const txt = pdfText(file); if (txt == null) { log('  (pdftotext not installed: text checks skipped)'); return; }
  const flat = txt.replace(/\s+/g, ' ');
  for (const ph of phrases) check(flat.includes(ph), `${path.basename(file)} contains "${ph}"`);
}
async function runDynamic(p, cell = '2') {
  const open = await p.$eval('#step-run details.advanced', (d) => d.open).catch(() => false);
  if (!open) await p.click('#step-run details.advanced summary'); // "Simulation settings"
  await p.click(`.segctl[data-name="dyncell"] button[data-v="${cell}"]`);
  await p.evaluate(() => { window.__e2eDyn = window.__cb.dyn; });
  await p.click('#runDyn');
  await p.waitForFunction(() => window.__cb.dyn && window.__cb.dyn !== window.__e2eDyn && !window.__cb.dynRun, null, { timeout: 300000 });
}
async function swapFirst(p, from, to) {
  await p.evaluate(() => { window.__e2eInst = window.__cb.instant; });
  const sels = await p.$$('#step-surfaces select.mat-select');
  let done = false;
  for (const s of sels) {
    const label = await s.getAttribute('aria-label');
    if (label && label.includes(from)) { await s.selectOption(to); done = true; break; }
  }
  if (!done) throw new Error(`no surface select for ${from}`);
  await p.waitForFunction(() => window.__cb.instant && window.__cb.instant !== window.__e2eInst && !window.__cb.instBusy, null, { timeout: 60000 });
}
async function saveOption(p) {
  const n = await p.evaluate(() => window.__cb.options.length);
  await p.click('#step-compare button:has-text("Save as option")');
  await p.waitForFunction((k) => window.__cb.options.length === k + 1, n);
  return p.evaluate(() => window.__cb.options[window.__cb.options.length - 1].id);
}
const T = lang === 'da'
  ? { subbase: '* Bærelag:', jb: 'fra JB-jordtabellen', still: 'heraf stadig i bærelag', full: 'Bærelagsceller der blev fyldt', notSuitable: 'IKKE egnet til screening', osm: 'OpenStreetMap', minCP: 'min(C·P, P - Ia)', groundwater: 'grundvandsstand', recovery: 'genetablering af nedsivningsevnen', peak: 'blokke på 1 minut', terrainDate: 'Terrænets dato' }
  : { subbase: '* Sub-base:', jb: 'from JB soil table', still: 'of which still in sub-bases', full: 'Sub-base cells that ran full', notSuitable: 'NOT suitable for site screening', osm: 'OpenStreetMap', minCP: 'min(C·P, P - Ia)', groundwater: 'High groundwater', recovery: 'No recovery of infiltration capacity', peak: '1-minute blocks', terrainDate: 'Terrain date' };

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 }, acceptDownloads: true, locale: lang === 'da' ? 'da-DK' : 'en-GB' });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => { failures++; log('PAGE ERROR', e.message); });
  p.on('console', (m) => { if (m.type() === 'error' && !/ERR_TUNNEL|Failed to load resource/.test(m.text())) log('console', m.text()); });

  // ---------- single report with a dynamic run (school yard after, 2 m dynamic grid)
  if (sections.has('single')) {
    await openSite(p, 'school_after');
    await runDynamic(p, '2');
    await fillDialog(p, 'single');
    const f = await download(p, `single-${lang}.pdf`);
    const single = await p.evaluate(() => {
      const S = window.__cb; const m = window.__cbReportLast.model; const o = m.options[0];
      return { app: { stats: S.instant.stats, mass: S.dyn.mass, perm: S.dyn.permeability, ret: S.retention.result }, model: { instant: o.instant, dynamic: o.dynamic, retention: o.retention, summary: m.summary, surfaces: o.surfaces }, pages: window.__cbReportLast.pages, maps: window.__cbReportLast.mapsInfo };
    });
    log('SINGLE pages', single.pages, 'maps', JSON.stringify(single.maps));
    log('  app ponded', single.app.stats.storedVolumeM3.toFixed(1), 'model', single.model.instant.pondedM3.toFixed(1));
    log('  app leaves', single.app.stats.outflowVolumeM3.toFixed(1), 'model', single.model.instant.leavesSiteM3.toFixed(1));
    log('  app area>10 (engine)', single.app.stats.areaOver10CmM2, 'model (from depth array)', single.model.instant.areaOverM2[10]);
    log('  app maxDepth', single.app.stats.maxDepthM.toFixed(3), 'model', single.model.instant.maxDepthM.toFixed(3));
    log('  dyn boundaryOut', single.app.mass.boundaryOutM3.toFixed(1), 'model', single.model.dynamic.leavesSiteM3.toFixed(1), 'mass err %', single.model.dynamic.massErrorPct);
    log('  retention storage', single.app.ret.requiredStorageM3.toFixed(1), 'model', single.model.retention.requiredStorageM3.toFixed(1));
    const P = single.model.dynamic.permeability;
    log('  sub-base: app', JSON.stringify(single.app.perm), '\n            model', JSON.stringify(P));
    check(P && P.subbaseCells === single.app.perm.subbaseCells && close(P.subbaseStoredM3, single.app.perm.subbaseStoredM3, 1e-9), 'sub-base figures carried into the model');
    check(single.model.surfaces.rows.some((r) => r.subsoilLimited && r.storageMm > 0), 'surfaces table has a sub-base material (permeable pavers)');
    expectText(f, [T.subbase, T.jb, T.still, T.full, T.minCP, T.groundwater, T.recovery, T.peak]);
    fs.writeFileSync(path.join(out, `single-${lang}.json`), JSON.stringify(single, null, 1));
  }

  // ---------- comparison: school yard before (A) vs after with LAR (B), via the app's own pair compare
  if (sections.has('pair')) {
    await openSite(p, 'school_before');
    await p.click('#pairBtn');
    await p.waitForFunction(() => window.__cb.compare && window.__cb.options.length >= 2, null, { timeout: 90000 });
    await fillDialog(p, 'comparison');
    await download(p, `comparison-${lang}.pdf`);
    const cmp = await p.evaluate(() => {
      const S = window.__cb; const m = window.__cbReportLast.model; const { a, b } = S.compare;
      // sign check: at A's deepest cell B − A must be negative if B (LAR) is drier there
      let kMax = 0; for (let k = 0; k < a.depth.length; k++) if (a.depth[k] > a.depth[kMax]) kMax = k;
      return { names: [a.name, b.name], appA: a.stats, appB: b.stats, model: m.comparison, summary: m.summary, deepestA: { depthA: a.depth[kMax], depthB: b.depth[kMax] }, pages: window.__cbReportLast.pages };
    });
    log('COMPARISON pages', cmp.pages, cmp.names.join(' vs '));
    const row = (id) => cmp.model.rows.find((r) => r.id === id);
    for (const id of ['pondedM3', 'leavesSiteM3', 'areaOver10M2', 'maxDepthCm', 'requiredStorageM3']) { const r = row(id); log(`  ${id}`, r.values.map((v) => v.toFixed(1)).join(' / '), 'delta', r.deltas[1].toFixed(1), `${(r.deltaPct[1] || 0).toFixed(1)} %`); }
    log('  app A ponded', cmp.appA.storedVolumeM3.toFixed(1), 'B', cmp.appB.storedVolumeM3.toFixed(1));
    log('  deepest cell of A: depth A', cmp.deepestA.depthA.toFixed(3), 'B', cmp.deepestA.depthB.toFixed(3), '→ B − A', (cmp.deepestA.depthB - cmp.deepestA.depthA).toFixed(3));
    log('  diffStats', JSON.stringify(cmp.model.diffStats));
    fs.writeFileSync(path.join(out, `comparison-${lang}.json`), JSON.stringify(cmp, null, 1));
  }

  // ---------- known-answer sign test: same site, A = T100 (82.6 mm), B = 15 mm → B can only be drier (all B − A <= 0)
  if (sections.has('known')) {
    if (!(await p.evaluate(() => window.__cb && window.__cb.grid))) await openSite(p, 'school_before');
    const known = await p.evaluate(async () => {
      const S = window.__cb; const R = window.__cbReport;
      const site = S.site.id;
      const grid = S.grid;
      const r100 = await S.cb.runInstant(grid, { rainDepthMm: 59, climateFactor: 1.4, sewerMode: 1, moisture: 1, minDepth: 0.01 });
      const r10 = await S.cb.runInstant(grid, { rainDepthMm: 15, climateFactor: 1.0, sewerMode: 1, moisture: 1, minDepth: 0.01 });
      const mk = (id, name, r, presetId, depth, cf) => ({ id, name, site: { id: site, name: S.site.name, kind: 'synthetic' }, settings: { presetId, rainDepthMm: depth, climateFactor: cf, sewerMode: 1, moisture: 1 },
        preset: S.info.presets.find((p) => p.id === presetId), grid, instant: r, palette: S.info.palette, letter: id });
      const { model, internals } = await R.buildReportModel({ kind: 'comparison', records: [mk('A', 'T100', r100, 't100', 59, 1.4), mk('B', '15 mm', r10, 't10', 15, 1.0)], lang: 'en' });
      const d = internals.diffs[0].diff; let pos = 0, neg = 0; for (const v of d) { if (v > 1e-6) pos++; else if (v < -1e-6) neg++; }
      return { stats: model.comparison.diffStats[0], pos, neg, inputDiff: model.comparison.inputDifferences[0], summary: model.summary.slice(0, 3) };
    });
    log('KNOWN ANSWER (15 mm vs 82.6 mm on the same grid): cells B>A', known.pos, 'cells B<A', known.neg, 'wetter area', known.stats.wetterAreaM2, 'drier area', known.stats.drierAreaM2);
    check(known.pos === 0 && known.neg > 0, 'B (less rain) is nowhere wetter than A');
    log('  input differences flagged:', JSON.stringify(known.inputDiff));
  }

  // ---------- surface swap through the UI: rain change, asphalt → permeable pavers → clogged, dynamic runs, saved options
  if (sections.has('swap')) {
    await openSite(p, 'school_before');
    // change the rain (T = 10 and back to the cloudburst) – the quick check must follow
    const v100 = await p.evaluate(() => window.__cb.instant.stats.rainVolumeM3);
    await p.click('button.preset[data-preset="t10"]');
    await p.waitForFunction((v) => window.__cb.instant && Math.abs(window.__cb.instant.stats.rainVolumeM3 - v) > 1, v100);
    const v10 = await p.evaluate(() => window.__cb.instant.stats.rainVolumeM3);
    await p.click('button.preset[data-preset="t100"]');
    await p.waitForFunction((v) => window.__cb.instant && Math.abs(window.__cb.instant.stats.rainVolumeM3 - v) < 0.01, v100);
    log('SWAP rain on site T100', v100.toFixed(1), 'm³, T10', v10.toFixed(1), 'm³');
    check(v10 < v100, 'quick check follows the rain change');
    const q0 = await p.evaluate(() => window.__cb.instant.stats);
    await runDynamic(p, '2');
    const idA = await saveOption(p);
    // B: asphalt → permeable pavers (a surface swap the report agent never exercised)
    await swapFirst(p, 'Asphalt', 'permeable_pavers');
    const q1 = await p.evaluate(() => window.__cb.instant.stats);
    check(await p.evaluate(() => [...document.querySelectorAll('.water-note')].some((e) => /sub-base/.test(e.textContent))), 'Surfaces step explains the sub-base');
    await runDynamic(p, '2');
    const dynB = await p.evaluate(() => ({ mass: window.__cb.dyn.mass, perm: window.__cb.dyn.permeability }));
    check(await p.evaluate(() => !!document.querySelector('.c-foot.subbase')), 'results panel shows the sub-base lines');
    const idB = await saveOption(p);
    // C: the clogged variant of the same surface
    await swapFirst(p, 'Asphalt', 'permeable_pavers_clogged');
    const q2 = await p.evaluate(() => window.__cb.instant.stats);
    await runDynamic(p, '2');
    const dynC = await p.evaluate(() => ({ mass: window.__cb.dyn.mass, perm: window.__cb.dyn.permeability }));
    const idC = await saveOption(p);
    log('  quick check effective runoff: as drawn', q0.effectiveVolumeM3.toFixed(1), 'pavers', q1.effectiveVolumeM3.toFixed(1), 'clogged', q2.effectiveVolumeM3.toFixed(1));
    log('  dynamic B (pavers):  infiltrated', dynB.mass.infiltratedM3.toFixed(1), 'out', dynB.mass.boundaryOutM3.toFixed(1), 'sub-base still', dynB.perm.subbaseStoredM3.toFixed(1), 'drained', dynB.perm.subbaseDrainedM3.toFixed(1), 'full', dynB.perm.subbaseFullCells, '/', dynB.perm.subbaseCells);
    log('  dynamic C (clogged): infiltrated', dynC.mass.infiltratedM3.toFixed(1), 'out', dynC.mass.boundaryOutM3.toFixed(1), 'sub-base still', dynC.perm.subbaseStoredM3.toFixed(1), 'drained', dynC.perm.subbaseDrainedM3.toFixed(1), 'full', dynC.perm.subbaseFullCells, '/', dynC.perm.subbaseCells);
    check(q1.effectiveVolumeM3 < q0.effectiveVolumeM3 && q2.effectiveVolumeM3 > q1.effectiveVolumeM3, 'pavers reduce and clogging raises the quick-check runoff');
    check(dynC.mass.infiltratedM3 < dynB.mass.infiltratedM3 && dynC.mass.boundaryOutM3 > dynB.mass.boundaryOutM3, 'clogged pavers infiltrate less and send more water off site');
    // the app's own compare view (last two options), then back to editing before the reports
    await p.click('#step-compare button.btn.primary:has-text("Compare")');
    await p.waitForFunction(() => !!window.__cb.compare, null, { timeout: 60000 });
    log('  app compare view:', await p.evaluate(() => `${window.__cb.compare.a.name} vs ${window.__cb.compare.b.name}`));
    // single report of option B (saved), comparison A vs B, three options
    await fillDialog(p, 'single', { pick: idB, notes: 'Option B: asphalt replaced by permeable pavers on a 45 mm sub-base. Example report from built-in sample data.' });
    const fs1 = await download(p, `swap-single-${lang}.pdf`);
    const ms = await p.evaluate(() => window.__cbReportLast.model);
    const pB = ms.options[0].dynamic.permeability;
    check(pB && close(pB.subbaseStoredM3, dynB.perm.subbaseStoredM3, 1e-9) && pB.subbaseFullCells === dynB.perm.subbaseFullCells, 'saved option B keeps its own sub-base figures');
    check(ms.options[0].inputs.design.some((d) => /Permeable pavers/.test(d.to)), 'design change listed in the report');
    expectText(fs1, [T.subbase, T.still, T.full]);
    await fillDialog(p, 'comparison', { pick: [idA, idB], notes: 'Option B replaces the asphalt with permeable pavers (surface swap in the app). Example report from built-in sample data.' });
    const fc = await download(p, `swap-comparison-${lang}.pdf`);
    const mc = await p.evaluate(() => window.__cbReportLast.model);
    log('  SWAP COMPARISON pages', await p.evaluate(() => window.__cbReportLast.pages), 'basis', mc.comparison.basis, 'input diffs', JSON.stringify(mc.comparison.inputDifferences));
    check(mc.comparison.basis === 'dynamic', 'compared on the dynamic model');
    check(mc.comparison.inputDifferences[0].fields.length === 0, 'A and B differ only in the design');
    const rr = (id) => mc.comparison.rows.find((r) => r.id === id);
    for (const id of ['leavesSiteM3', 'dynLeavesSiteM3', 'dynInfiltratedM3', 'dynAreaOver10M2']) { const r = rr(id); if (r) log(`  ${id}`, r.values.map((v) => v.toFixed(1)).join(' / '), 'delta', (r.deltas[1] ?? 0).toFixed(1)); }
    check(rr('dynInfiltratedM3').deltas[1] > 0, 'B infiltrates more than A');
    log('  diffStats', JSON.stringify(mc.comparison.diffStats[0]));
    expectText(fc, [T.subbase, T.still]);
    await fillDialog(p, 'comparison', { pick: [idA, idB, idC], notes: 'Three options: as drawn, permeable pavers, clogged permeable pavers. Example report from built-in sample data.' });
    const f3 = await download(p, `swap-three-${lang}.pdf`);
    const m3 = await p.evaluate(() => ({ model: window.__cbReportLast.model, pages: window.__cbReportLast.pages }));
    log('  THREE OPTIONS pages', m3.pages, 'letters', m3.model.options.map((o) => `${o.letter}:${o.inputs.design.map((d) => d.to).join('+') || 'as drawn'}`).join(' | '));
    check(m3.model.options.length === 3 && m3.model.comparison.diffStats.length === 2, 'three options, two difference maps');
    expectText(f3, ['Permeable pavers, clogged (old, silted up)']);
    fs.writeFileSync(path.join(out, `swap-${lang}.json`), JSON.stringify({ q0, q1, q2, dynB, dynC, comparison: mc.comparison, three: m3.model.comparison }, null, 1));
  }

  // ---------- uploaded terrain: coarse file (cover warning) and a fine file with OpenStreetMap context
  if (sections.has('upload')) {
    const { crsFromEpsg } = await import(path.join(root, 'Web/js/sources/proj.js'));
    const crs = crsFromEpsg(25832); const ll = (E, N) => { const q = crs.toLatLon(E, N); return { lat: q.lat, lon: q.lon }; };
    const sq = (x0, y0, w, hh) => [[x0, y0], [x0 + w, y0], [x0 + w, y0 + hh], [x0, y0 + hh], [x0, y0]].map(([x, y]) => ll(x, y));
    // recorded-style Overpass answer for the fixture's 15 × 9 m extent (E 724410–724425, N 6179421–6179430)
    const overpass = { elements: [
      { type: 'way', id: 1, tags: { building: 'yes', 'building:levels': '2' }, geometry: sq(724412, 6179424, 4, 3) },
      { type: 'way', id: 2, tags: { leisure: 'park' }, geometry: sq(724417, 6179421, 6, 8) },
      { type: 'way', id: 3, tags: { amenity: 'parking', surface: 'asphalt' }, geometry: sq(724410, 6179421, 6, 2.5) },
    ] };
    let overpassHits = 0;
    await p.route(/overpass/, (r) => { overpassHits++; r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(overpass) }); });
    await p.goto(`${base}#/`);
    await p.setInputFiles('#fileInput', path.join(root, 'samples/fixtures/int16_pred2_deflate_geographic.tif'));
    await p.waitForFunction(() => window.__cb && window.__cb.instant && window.__cb.site.kind === 'custom' && window.__cb.retention.result, null, { timeout: 90000 });
    check(await p.evaluate(() => /Not suitable/.test(document.querySelector('#step-site').textContent)), 'Site step warns that the coarse terrain is not suitable');
    check(await p.evaluate(() => /NOT for site screening/.test(document.querySelector('#caption').textContent)), 'map caption flags the coarse terrain');
    await fillDialog(p, 'single', { notes: 'Uploaded test fixture (1 arc-second, about 31 m). Example of the coarse-terrain warning.' });
    const fu = await download(p, `upload-coarse-${lang}.pdf`);
    const mu = await p.evaluate(() => window.__cbReportLast.model);
    log('UPLOAD coarse: suitability', JSON.stringify(mu.options[0].site.suitability), 'terrainWarnings', JSON.stringify(mu.terrainWarnings));
    check(mu.terrainWarnings.length === 1 && mu.terrainWarnings[0].level === 'unsuitable', 'model carries the cover warning');
    expectText(fu, [T.notSuitable, T.terrainDate]);
    await p.setInputFiles('#fileInput', path.join(root, 'samples/fixtures/tiled_deflate_pred3_be.tif'));
    await p.waitForFunction(() => window.__cb && window.__cb.instant && /tiled/.test(window.__cb.site.name) && window.__cb.retention.result, null, { timeout: 90000 });
    await p.click('#step-site details.advanced summary');
    await p.click('.segctl[data-name="terrainMethod"] button[data-v="min"]');
    await p.waitForFunction(() => window.__cb.siteDesc.prepared && window.__cb.siteDesc.prepared.method === 'min' && window.__cb.instant, null, { timeout: 60000 });
    await p.click('#addOsm');
    await p.waitForFunction(() => window.__cb.siteDesc.prepared && window.__cb.siteDesc.prepared.osm && window.__cb.instant && window.__cb.retention.result, null, { timeout: 60000 });
    log('  OSM via fixture: Overpass requests', overpassHits, 'stats', JSON.stringify(await p.evaluate(() => window.__cb.siteDesc.prepared.osm)));
    await fillDialog(p, 'single', { notes: 'Uploaded test fixture (0.4 m, EPSG:25832) with OpenStreetMap buildings and land cover (recorded test response).' });
    await p.fill('#reportDlg [data-field="terrainDate"]', 'Test fixture, generated 2026');
    const fo = await download(p, `upload-osm-${lang}.pdf`);
    const mo = await p.evaluate(() => window.__cbReportLast.model);
    const so = mo.options[0].site;
    log('  site in model', JSON.stringify({ crs: so.crs, source: so.source, suitability: so.suitability }));
    check(so.source && so.source.osm && so.source.osm.buildings === 1 && so.source.attribution.some((a) => /OpenStreetMap/.test(a)), 'OSM stats and attribution in the report model');
    check(so.source.method === 'min' && so.source.nativeResM === 0.4 && /25832/.test(so.crs), 'method, resolution and CRS in the report model');
    check(mo.terrainWarnings.length === 0, 'no cover warning for a 0.4 m terrain');
    expectText(fo, [T.osm, 'Test fixture, generated 2026', 'EPSG:25832']);
  }
  await browser.close();
  log(failures ? `${failures} check(s) FAILED` : 'all checks passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
