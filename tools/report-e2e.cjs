// End-to-end check of the PDF report in headless Chromium (Playwright). Not part of the app.
//   python3 Web/serve.py 8411 &      then      node tools/report-e2e.cjs http://localhost:8411/ out-dir [en|da]
// Produces out-dir/single.pdf and out-dir/comparison.pdf through the real UI (PDF button → dialog → Download) and
// prints the numbers the app holds next to the ones in the report model, plus the difference-map sign checks.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const base = process.argv[2] || 'http://localhost:8411/';
const out = path.resolve(process.argv[3] || 'report-e2e');
const lang = process.argv[4] || 'en';
fs.mkdirSync(out, { recursive: true });
const log = (...a) => console.log(...a);

async function openSite(p, id) {
  await p.goto(`${base}#/site/${id}`);
  await p.waitForFunction((sid) => window.__cb && window.__cb.site && window.__cb.site.id === sid && window.__cb.instant && window.__cb.retention.result, id, { timeout: 90000 });
}
async function fillDialog(p, kind) {
  await p.click('[data-export="report"]');
  await p.waitForSelector('#reportDlg');
  await p.click(`#reportDlg .rpt-seg button[data-lang="${lang}"]`);
  await p.click(`#reportDlg .rpt-seg button[data-kind="${kind}"]`);
  const fields = { name: 'Skolegården – klimatilpasning', address: 'Eksempelvej 12, 5000 Odense C', matrikel: '1234a Odense Bygrunde', client: 'Example Municipality (sample data)',
    author: 'A. Landscape Architect', company: 'Example Studio ApS', date: '2026-11-24', revision: 'B' };
  for (const [k, v] of Object.entries(fields)) await p.fill(`#reportDlg [data-field="${k}"]`, v);
  await p.fill('#reportDlg [data-field="notes"]', kind === 'comparison'
    ? 'Option B replaces part of the asphalt with a rain garden and permeable paving (sample "School yard – after (LAR)"). Example report generated from built-in sample data.'
    : 'Example report generated from built-in sample data.');
}
async function download(p, file) {
  const [dl] = await Promise.all([p.waitForEvent('download', { timeout: 180000 }), p.click('#rptGo')]);
  await dl.saveAs(path.join(out, file));
  await p.click('#reportDlg .rpt-x');
}

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 }, acceptDownloads: true, locale: lang === 'da' ? 'da-DK' : 'en-GB' });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => log('PAGE ERROR', e.message));
  p.on('console', (m) => { if (m.type() === 'error' && !/ERR_TUNNEL|Failed to load resource/.test(m.text())) log('console', m.text()); });

  // ---------- single report with a dynamic run (school yard after, 2 m dynamic grid)
  await openSite(p, 'school_after');
  await p.click('#step-run details.advanced summary'); // "Simulation settings"
  await p.click('.segctl[data-name="dyncell"] button[data-v="2"]');
  await p.click('#runDyn');
  await p.waitForFunction(() => window.__cb.dyn && !window.__cb.dynRun, null, { timeout: 300000 });
  await fillDialog(p, 'single');
  await download(p, `single-${lang}.pdf`);
  const single = await p.evaluate(() => {
    const S = window.__cb; const m = window.__cbReportLast.model; const o = m.options[0];
    return { app: { stats: S.instant.stats, mass: S.dyn.mass, ret: S.retention.result }, model: { instant: o.instant, dynamic: o.dynamic, retention: o.retention, summary: m.summary }, pages: window.__cbReportLast.pages, maps: window.__cbReportLast.mapsInfo };
  });
  log('SINGLE pages', single.pages, 'maps', JSON.stringify(single.maps));
  log('  app ponded', single.app.stats.storedVolumeM3.toFixed(1), 'model', single.model.instant.pondedM3.toFixed(1));
  log('  app leaves', single.app.stats.outflowVolumeM3.toFixed(1), 'model', single.model.instant.leavesSiteM3.toFixed(1));
  log('  app area>10 (engine)', single.app.stats.areaOver10CmM2, 'model (from depth array)', single.model.instant.areaOverM2[10]);
  log('  app maxDepth', single.app.stats.maxDepthM.toFixed(3), 'model', single.model.instant.maxDepthM.toFixed(3));
  log('  dyn boundaryOut', single.app.mass.boundaryOutM3.toFixed(1), 'model', single.model.dynamic.leavesSiteM3.toFixed(1), 'mass err %', single.model.dynamic.massErrorPct);
  log('  retention storage', single.app.ret.requiredStorageM3.toFixed(1), 'model', single.model.retention.requiredStorageM3.toFixed(1));
  fs.writeFileSync(path.join(out, `single-${lang}.json`), JSON.stringify(single, null, 1));

  // ---------- comparison: school yard before (A) vs after with LAR (B), via the app's own pair compare
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

  // ---------- known-answer sign test: same site, A = T100 (82.6 mm), B = 15 mm → B can only be drier (all B − A <= 0)
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
  log('  input differences flagged:', JSON.stringify(known.inputDiff));
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
