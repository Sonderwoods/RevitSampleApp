// Promise API for the UI. Instant work runs in a persistent worker; each dynamic run gets its own worker so it can be
// cancelled instantly (terminate). Usage:
//   const cb = await CloudburstClient.create();           // cb.info.samples, cb.info.presets, cb.info.palette
//   const grid = await cb.buildGrid({ sample: 'demo_block' }, { cellSize: 1 });
//   const inst = await cb.runInstant(grid, { rainDepthMm: 59, climateFactor: 1.4 });
//   const run = cb.runDynamic({ sample: 'demo_block' }, { cellSize: 2 }, scenario, rainMmH, probes, p => ...);
//   run.cancel(); const dyn = await run.result;   // dyn.grid is the grid used for the run
const base = new URL('.', import.meta.url);

class WorkerRpc {
  constructor() {
    this.w = new Worker(new URL('engine-worker.js', base), { type: 'module' });
    this.seq = 0; this.pending = new Map();
    this.w.onmessage = (ev) => {
      const { id, ok, result, error, progress } = ev.data;
      const p = this.pending.get(id); if (!p) return;
      if (progress) { p.onProgress && p.onProgress(progress); return; }
      this.pending.delete(id);
      ok ? p.resolve(result) : p.reject(new Error(error));
    };
    this.w.onerror = (e) => { for (const p of this.pending.values()) p.reject(new Error(e.message || 'worker error')); this.pending.clear(); };
  }
  call(cmd, args, onProgress) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject, onProgress }); this.w.postMessage({ id, cmd, args }); });
  }
  terminate() { this.w.terminate(); for (const p of this.pending.values()) p.reject(new Error('cancelled')); this.pending.clear(); }
}

export class CloudburstClient {
  static async create() {
    const c = new CloudburstClient();
    c.wasmUrl = new URL('cloudburst_core.wasm', base).href;
    c.rpc = new WorkerRpc();
    c.info = await c.rpc.call('init', { wasmUrl: c.wasmUrl });
    return c;
  }
  sample(id) { return this.rpc.call('sample', { id }); }
  buildGrid(site, settings) { return this.rpc.call('buildGrid', { site, settings }); }
  freeGrid(grid) { return this.rpc.call('freeGrid', { gridId: grid.gridId }); }
  runInstant(grid, scenario) { return this.rpc.call('runInstant', { gridId: grid.gridId, scenario }); }
  retention(grid, input) { return this.rpc.call('retention', { gridId: grid.gridId, input }); }
  rainCds(returnPeriod, durationMin, depthMm) { return this.rpc.call('rainCds', { returnPeriod, durationMin, depthMm }); }
  rainBox(depthMm, durationMin) { return this.rpc.call('rainBox', { depthMm, durationMin }); }

  /** Dynamic run in a dedicated worker. Returns { result: Promise, cancel() }. result resolves to {grid, ...dynamic}. */
  runDynamic(site, settings, scenario, rainMmH, probes, onProgress) {
    const rpc = new WorkerRpc();
    let cancelled = false;
    const result = (async () => {
      await rpc.call('init', { wasmUrl: this.wasmUrl });
      const grid = await rpc.call('buildGrid', { site, settings });
      const dyn = await rpc.call('runDynamic', { gridId: grid.gridId, scenario, rain: Array.from(rainMmH), probes }, onProgress);
      rpc.terminate();
      return { grid, ...dyn };
    })().catch((e) => { rpc.terminate(); throw cancelled ? new Error('cancelled') : e; });
    return { result, cancel: () => { cancelled = true; rpc.terminate(); } };
  }
}
