// node Web/engine/test-node.mjs — smoke test of the wasm engine binding
import { readFileSync } from 'node:fs';
import { CloudburstEngine, rainPresets } from './cloudburst-wasm.js';
const url = new URL('./cloudburst_core.wasm', import.meta.url);
let last = 0;
const e = await CloudburstEngine.load(readFileSync(url), { onProgress: (f) => { last = f; return true; } });
console.log('engine', e.version(), 'materials', e.palette.materials.length);
const samples = e.samples();
console.log('samples', samples.map((s) => s.id).join(', '));
const presets = rainPresets(e);
for (const s of samples.filter((s) => s.kind === 'synthetic')) {
  const t0 = performance.now();
  const g = e.buildGrid({ sample: s.id });
  const r = e.runInstant(g, { rainDepthMm: 59, climateFactor: 1.4 });
  console.log(`${s.id.padEnd(20)} ${g.nx}x${g.ny} bluespots ${r.stats.bluespotCount} stored ${r.stats.storedVolumeM3.toFixed(0)} m3 paths ${r.paths.length} ${(performance.now() - t0).toFixed(0)} ms`);
  e.freeGrid(g);
}
const g = e.buildGrid({ sample: 'school_before' });
const t0 = performance.now();
const d = e.runDynamic(g, { afterRainMin: 10 }, presets[2].intensity.slice(0, 20), [100]);
console.log(`dynamic school 20 min: ${(performance.now() - t0).toFixed(0)} ms, steps ${d.mass.steps}, mass err ${d.mass.errorFraction.toExponential(2)}, frames ${d.frames.length}, progress ${last.toFixed(2)}, probe samples ${d.probes[0].length}`);
const inf = d.infiltrated.reduce((a, b) => a + b, 0) * g.dx * g.dx;
console.log(`permeability: infiltrated ${d.permeability.infiltratedM3.toFixed(1)} m3 (per-cell sum ${inf.toFixed(1)}), sub-base cells ${d.permeability.subbaseCells}, full ${d.permeability.subbaseFullCells}, stored ${d.permeability.subbaseStoredM3.toFixed(1)} m3`);
if (Math.abs(inf - d.mass.infiltratedM3) > 1e-3 * Math.max(1, inf) || Math.abs(d.permeability.infiltratedM3 - d.mass.infiltratedM3) > 1e-9) throw new Error('infiltration fields disagree');
e.setInfiltrationCap(g, new Float32Array(g.nx * g.ny).fill(1));
const dc = e.runDynamic(g, { afterRainMin: 0 }, presets[2].intensity.slice(0, 20), []);
console.log(`capped at 1 mm: max cell infiltration ${(Math.max(...dc.infiltrated) * 1000).toFixed(3)} mm, capped cells ${dc.permeability.cappedCells}`);
if (Math.max(...dc.infiltrated) > 0.001 + 1e-6 || dc.permeability.cappedCells === 0) throw new Error('infiltration cap not applied');
e.setInfiltrationCap(g, []);
console.log('retention', JSON.stringify(e.retention(g)));
const tif = e.sample('city_plaza'); console.log('sample json keys', Object.keys(tif).join(','), tif.z.length);
