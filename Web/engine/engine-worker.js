// Module Web Worker hosting the wasm engine. Messages: {id, cmd, args} → {id, ok, result | error} and {id, progress}.
import { CloudburstEngine, rainPresets } from './cloudburst-wasm.js';

let engine = null;
let currentId = 0;
const grids = new Map(); // gridId -> grid
let nextGrid = 1;

const strip = (g) => ({ gridId: g.gridId, nx: g.nx, ny: g.ny, x0: g.x0, y0: g.y0, dx: g.dx, terrainZ: g.terrainZ, z: g.z, material: g.material, building: g.building, active: g.active, warnings: g.warnings });

const handlers = {
  async init({ wasmUrl }) {
    engine = await CloudburstEngine.load(wasmUrl, {
      onProgress: (fraction, timeS, hMax, elapsedS) => { postMessage({ id: currentId, progress: { fraction, timeS, hMax, elapsedS } }); return true; },
    });
    return { version: engine.version(), palette: engine.palette, samples: engine.samples(), presets: rainPresets(engine), scenario: engine.defaultScenario() };
  },
  sample({ id }) { return engine.sample(id); },
  buildGrid({ site, settings }) {
    const g = engine.buildGrid(site, settings);
    g.gridId = nextGrid++; grids.set(g.gridId, g);
    return strip(g);
  },
  freeGrid({ gridId }) { const g = grids.get(gridId); if (g) { engine.freeGrid(g); grids.delete(gridId); } return true; },
  runInstant({ gridId, scenario }) { return engine.runInstant(grids.get(gridId), scenario); },
  runDynamic({ gridId, scenario, rain, probes }) { return engine.runDynamic(grids.get(gridId), scenario, rain, probes || []); },
  retention({ gridId, input }) { return engine.retention(grids.get(gridId), input); },
  rainCds({ returnPeriod, durationMin, depthMm }) { return engine.rainCds(returnPeriod, durationMin, depthMm); },
  rainBox({ depthMm, durationMin }) { return engine.rainBox(depthMm, durationMin); },
};

const transferables = (v, out = []) => {
  if (!v || typeof v !== 'object') return out;
  if (ArrayBuffer.isView(v)) { out.push(v.buffer); return out; }
  for (const k in v) transferables(v[k], out);
  return out;
};

self.onmessage = async (ev) => {
  const { id, cmd, args } = ev.data;
  currentId = id;
  try {
    const result = await handlers[cmd](args || {});
    const keep = cmd === 'buildGrid' || cmd === 'init' ? [] : transferables(result);
    postMessage({ id, ok: true, result }, keep);
  } catch (e) {
    postMessage({ id, ok: false, error: String(e && e.message ? e.message : e) });
  }
};
