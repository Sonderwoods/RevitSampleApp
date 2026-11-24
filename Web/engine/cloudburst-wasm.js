// Thin JavaScript binding over the Rust engine compiled to WebAssembly (Shared/cloudburst-core, C ABI in ffi.rs).
// Works in browsers (main thread or worker) and Node. All lengths/coordinates are metres.
// Struct layouts mirror #[repr(C)] types in Rust – keep in sync.

const SCENARIO_FIELDS_F64 = ['rainDepthMm', 'climateFactor', 'sewerCapacityMmH', 'infiltrationScale', 'alpha', 'theta', 'hDry', 'afterRainMin', 'outputIntervalS', 'minDepth'];
const SCENARIO_FIELDS_I32 = ['sewerMode', 'moisture', 'boundary', 'maxFrames', 'depthRoughness', 'closedEdges'];
const SCENARIO_SIZE = 10 * 8 + 6 * 4 + 0; // 104 (8-aligned)
const INSTANT_STATS = ['rainVolumeM3', 'effectiveVolumeM3', 'storedVolumeM3', 'outflowVolumeM3', 'floodedAreaM2', 'areaOver10CmM2', 'maxDepthM', 'elapsedMs'];
const BLUESPOT_F64 = ['areaM2', 'capacityM3', 'volumeM3', 'maxDepthM', 'fullDepthM', 'wetAreaM2', 'contributingAreaM2', 'spillRainMm', 'levelZ', 'spillZ', 'x', 'y'];
const BLUESPOT_SIZE = 16 + 12 * 8;
const MASS_F64 = ['rainM3', 'initialLossM3', 'infiltratedM3', 'sewerM3', 'boundaryOutM3', 'storedM3', 'errorFraction', 'simulatedS', 'elapsedS', 'initialWaterM3'];
// PermeabilityStats (dynamic.rs): 5 f64 then 3 i64 = 64 bytes.
const PERM_F64 = ['infiltratedM3', 'subbaseStoredM3', 'subbaseDrainedM3', 'subbaseCapacityM3', 'initialLossM3'];
const PERM_I64 = ['subbaseCells', 'subbaseFullCells', 'cappedCells'];
const RET_OUT = ['totalAreaM2', 'reducedAreaM2', 'meanC', 'peakFlowLS', 'outflowLS', 'requiredStorageM3', 'criticalDurationMin'];

export class CloudburstEngine {
  /** @param {ArrayBuffer|Uint8Array|Response|string} source wasm bytes, fetch Response, or URL */
  static async load(source, hooks = {}) {
    const e = new CloudburstEngine();
    e.onProgress = hooks.onProgress || null; // (fraction, timeS, hMax, elapsedS) => boolean (false cancels)
    const imports = {
      env: {
        cb_host_now_ms: () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
        cb_host_progress: (f, t, h, el) => (e.onProgress ? (e.onProgress(f, t, h, el) === false ? 0 : 1) : 1),
      },
    };
    let bytes = source;
    if (typeof source === 'string') bytes = await (await fetch(source)).arrayBuffer();
    else if (typeof Response !== 'undefined' && source instanceof Response) bytes = await source.arrayBuffer();
    const { instance } = await WebAssembly.instantiate(bytes, imports);
    e.x = instance.exports;
    e.paletteJson = e._takeStr(e.x.cb_default_palette_json());
    e.palette = JSON.parse(e.paletteJson);
    return e;
  }

  // ---------- memory helpers
  get _mem() { return this.x.memory.buffer; }
  _alloc(bytes) { return this.x.cb_alloc(bytes); }
  _free(p, bytes) { if (p) this.x.cb_dealloc(p, bytes); }
  _str(s) {
    const b = new TextEncoder().encode(s + '\0');
    const p = this._alloc(b.length);
    new Uint8Array(this._mem, p, b.length).set(b);
    return [p, b.length];
  }
  _takeStr(p) {
    if (!p) return '';
    const m = new Uint8Array(this._mem);
    let end = p; while (m[end] !== 0) end++;
    const s = new TextDecoder().decode(m.subarray(p, end));
    this.x.cb_string_free(p);
    return s;
  }
  _f64(arr) { const n = arr.length * 8; const p = this._alloc(n); new Float64Array(this._mem, p, arr.length).set(arr); return [p, n]; }
  _i32(arr) { const n = Math.max(4, arr.length * 4); const p = this._alloc(n); new Int32Array(this._mem, p, arr.length).set(arr); return [p, n]; }
  _err(what) { return new Error(`${what}: ${this._takeStr(this.x.cb_last_error())}`); }
  _copyOut(fn, Ctor, len) {
    const bytes = len * Ctor.BYTES_PER_ELEMENT; const p = this._alloc(bytes);
    try { fn(p, len); return new Ctor(this._mem, p, len).slice(); } finally { this._free(p, bytes); }
  }
  _scenario(sc) {
    const s = { ...this.defaultScenario(), ...sc };
    const p = this._alloc(SCENARIO_SIZE); const dv = new DataView(this._mem, p, SCENARIO_SIZE);
    SCENARIO_FIELDS_F64.forEach((k, i) => dv.setFloat64(i * 8, +s[k], true));
    SCENARIO_FIELDS_I32.forEach((k, i) => dv.setInt32(80 + i * 4, s[k] | 0, true));
    return [p, SCENARIO_SIZE];
  }

  // ---------- catalogue
  version() { return this._takeStr(this.x.cb_version()); }
  samples() { return JSON.parse(this._takeStr(this.x.cb_samples_json())); }
  sample(id) {
    const [p, n] = this._str(id);
    try { const r = this.x.cb_sample_json(p); if (!r) throw this._err('sample'); return JSON.parse(this._takeStr(r)); } finally { this._free(p, n); }
  }
  defaultScenario() {
    if (this._defSc) return { ...this._defSc };
    const p = this._alloc(SCENARIO_SIZE); this.x.cb_scenario_default(p);
    const dv = new DataView(this._mem, p, SCENARIO_SIZE); const s = {};
    SCENARIO_FIELDS_F64.forEach((k, i) => (s[k] = dv.getFloat64(i * 8, true)));
    SCENARIO_FIELDS_I32.forEach((k, i) => (s[k] = dv.getInt32(80 + i * 4, true)));
    this._free(p, SCENARIO_SIZE); this._defSc = s; return { ...s };
  }

  // ---------- rain (mm/h per 60 s step, before climate factor)
  rainCds(returnPeriod, durationMin, depthMm = 0, peakPosition = 0.5) {
    const n = Math.max(1, Math.round(durationMin));
    return this._copyOut((p, len) => this.x.cb_rain_cds(returnPeriod, durationMin, depthMm, 60, peakPosition, p, len), Float64Array, n);
  }
  rainBox(depthMm, durationMin) {
    const n = Math.max(1, Math.round(durationMin));
    return this._copyOut((p, len) => this.x.cb_rain_box(depthMm, durationMin, 60, p, len), Float64Array, n);
  }
  idfDepthMm(durationMin, returnPeriod) { return this.x.cb_idf_depth_mm(durationMin, returnPeriod); }

  // ---------- grid
  /**
   * Build a grid. `site` is either {sample: id} or a plain site description:
   * { terrainBytes?: Uint8Array (GeoTIFF/ASC), terrainStep?, buildings?: [{xs,ys,height}], surfaces?: [{material, xs, ys}], kerbs?: [{xs,ys,height}], bridgeCuts?: [{xs,ys}] }
   */
  buildGrid(site, settings = {}) {
    const st = { cellSize: 1, buildingMinHeight: 5, maxCells: 1_500_000, defaultSoil: 6, defaultMaterial: -1, useRoofHeight: 0, ...settings };
    let siteH = 0; const frees = [];
    try {
      if (site.sample) {
        const [ps, ns] = this._str(site.sample); frees.push([ps, ns]);
        siteH = this.x.cb_site_from_sample(ps, 0);
        if (!siteH) throw this._err('sample');
      } else siteH = this.x.cb_site_new();
      if (site.terrainBytes) {
        const b = site.terrainBytes; const p = this._alloc(b.length); frees.push([p, b.length]);
        new Uint8Array(this._mem, p, b.length).set(b);
        if (this.x.cb_site_add_terrain_bytes(siteH, p, b.length, site.terrainStep || 1, 0) < 0) throw this._err('terrain');
      }
      const matIndex = (id) => Math.max(0, this.palette.materials.findIndex((m) => m.id === id));
      for (const b of site.buildings || []) {
        const [px, nx] = this._f64(b.xs); const [py, ny] = this._f64(b.ys); frees.push([px, nx], [py, ny]);
        this.x.cb_site_add_building_footprint(siteH, px, py, b.xs.length, b.height || 8, 0, -1);
      }
      for (const s of site.surfaces || []) {
        const [px, nx] = this._f64(s.xs); const [py, ny] = this._f64(s.ys); frees.push([px, nx], [py, ny]);
        this.x.cb_site_add_region_polygon(siteH, px, py, s.xs.length, matIndex(s.material), 0, 0, -1);
      }
      for (const c of site.bridgeCuts || []) { // IN-4 bridge cut-outs (e.g. from OpenStreetMap, js/sources/osm.js)
        const [px, nx] = this._f64(c.xs); const [py, ny] = this._f64(c.ys); frees.push([px, nx], [py, ny]);
        this.x.cb_site_add_bridge_cut(siteH, px, py, c.xs.length);
      }
      for (const k of site.kerbs || []) {
        const [px, nx] = this._f64(k.xs); const [py, ny] = this._f64(k.ys); frees.push([px, nx], [py, ny]);
        this.x.cb_site_add_wall(siteH, px, py, k.xs.length, k.height ?? 0.1);
      }
      const gs = this._alloc(32); frees.push([gs, 32]);
      const dv = new DataView(this._mem, gs, 32);
      dv.setFloat64(0, st.cellSize, true); dv.setFloat64(8, st.buildingMinHeight, true);
      dv.setInt32(16, st.maxCells, true); dv.setInt32(20, st.defaultSoil, true); dv.setInt32(24, st.defaultMaterial, true); dv.setInt32(28, st.useRoofHeight, true);
      const g = this.x.cb_grid_build(siteH, 0, gs);
      if (!g) throw this._err('grid');
      return this._gridObject(g);
    } finally {
      if (siteH) this.x.cb_site_free(siteH);
      for (const [p, n] of frees) this._free(p, n);
    }
  }

  _gridObject(h) {
    const ip = this._alloc(32); this.x.cb_grid_info(h, ip);
    const dv = new DataView(this._mem, ip, 32);
    const g = { handle: h, nx: dv.getInt32(0, true), ny: dv.getInt32(4, true), x0: dv.getFloat64(8, true), y0: dv.getFloat64(16, true), dx: dv.getFloat64(24, true) };
    this._free(ip, 32);
    const n = g.nx * g.ny;
    g.terrainZ = this._copyOut((p, l) => this.x.cb_grid_copy_z(h, 0, p, l), Float32Array, n);
    g.z = this._copyOut((p, l) => this.x.cb_grid_copy_z(h, 1, p, l), Float32Array, n);
    g.material = this._copyOut((p, l) => this.x.cb_grid_copy_material(h, p, l), Uint16Array, n);
    g.building = this._copyOut((p, l) => this.x.cb_grid_copy_building(h, p, l), Int32Array, n);
    g.active = this._copyOut((p, l) => this.x.cb_grid_copy_active(h, p, l), Uint8Array, n);
    g.warnings = this._takeStr(this.x.cb_grid_warnings(h)).split('\n').filter(Boolean);
    return g;
  }

  freeGrid(g) { if (g && g.handle) { this.x.cb_grid_free(g.handle); g.handle = 0; } }

  // ---------- instant model (M1)
  runInstant(g, scenario = {}) {
    const [sp, sn] = this._scenario(scenario);
    const r = this.x.cb_instant_run(g.handle, sp); this._free(sp, sn);
    if (!r) throw this._err('instant');
    try {
      const n = g.nx * g.ny;
      const out = {};
      const st = this._alloc(80); this.x.cb_instant_stats(r, st);
      const dv = new DataView(this._mem, st, 80); out.stats = {};
      INSTANT_STATS.forEach((k, i) => (out.stats[k] = dv.getFloat64(i * 8, true)));
      out.stats.bluespotCount = dv.getInt32(64, true); out.stats.spillingCount = dv.getInt32(68, true);
      this._free(st, 80);
      out.depth = this._copyOut((p, l) => this.x.cb_instant_copy(r, 0, p, l), Float32Array, n);
      out.accumulation = this._copyOut((p, l) => this.x.cb_instant_copy(r, 1, p, l), Float32Array, n);
      out.labels = this._copyOut((p, l) => this.x.cb_instant_copy_labels(r, p, l), Int32Array, n);
      const nb = this.x.cb_instant_copy_bluespots(r, 0, 0);
      out.bluespots = [];
      if (nb > 0) {
        const bytes = nb * BLUESPOT_SIZE; const bp = this._alloc(bytes);
        this.x.cb_instant_copy_bluespots(r, bp, nb);
        const bv = new DataView(this._mem, bp, bytes);
        for (let i = 0; i < nb; i++) {
          const o = i * BLUESPOT_SIZE;
          const b = { id: bv.getInt32(o, true), cellCount: bv.getInt32(o + 4, true), spills: bv.getInt32(o + 8, true) === 1 };
          BLUESPOT_F64.forEach((k, j) => (b[k] = bv.getFloat64(o + 16 + j * 8, true)));
          out.bluespots.push(b);
        }
        this._free(bp, bytes);
      }
      const np = this.x.cb_instant_path_count(r);
      out.paths = [];
      for (let i = 0; i < np; i++) {
        const pts = this.x.cb_instant_copy_path(r, i, 0, 0);
        const flat = this._copyOut((p, l) => this.x.cb_instant_copy_path(r, i, p, l), Float64Array, pts * 4);
        out.paths.push(flat); // packed x,y,z,volume
      }
      return out;
    } finally { this.x.cb_instant_free(r); }
  }

  // ---------- dynamic model (M2) – blocking; run inside a Web Worker. Progress via hooks.onProgress.
  runDynamic(g, scenario, rainMmH, probes = []) {
    const [sp, sn] = this._scenario(scenario);
    const [rp, rn] = this._f64(rainMmH);
    const [pp, pn] = this._i32(probes);
    const r = this.x.cb_dynamic_run(g.handle, sp, rp, rainMmH.length, 60, pp, probes.length, 0, 0);
    this._free(sp, sn); this._free(rp, rn); this._free(pp, pn);
    if (!r) throw this._err('dynamic');
    try {
      const n = g.nx * g.ny; const out = {};
      const get = (w) => this._copyOut((p, l) => this.x.cb_dynamic_copy(r, w, p, l), Float32Array, n);
      out.hMax = get(0); out.vMax = get(1); out.hazard = get(2); out.hv = get(3); out.tPeak = get(4); out.hFinal = get(5);
      // cumulative infiltration per cell (m) and peak sub-base fill (0..1, 0 = no sub-base); docs/physics-permeability.md
      out.infiltrated = get(6); out.subbaseFillMax = get(7);
      const pp = this._alloc(64); out.permeability = {};
      if (this.x.cb_dynamic_permeability(r, pp)) {
        const pv = new DataView(this._mem, pp, 64);
        PERM_F64.forEach((k, i) => (out.permeability[k] = pv.getFloat64(i * 8, true)));
        PERM_I64.forEach((k, i) => (out.permeability[k] = Number(pv.getBigInt64(40 + i * 8, true))));
      }
      this._free(pp, 64);
      const mp = this._alloc(96); this.x.cb_dynamic_mass(r, mp);
      const dv = new DataView(this._mem, mp, 96); out.mass = {};
      MASS_F64.forEach((k, i) => (out.mass[k] = dv.getFloat64(i * 8, true)));
      out.mass.steps = Number(dv.getBigInt64(80, true)); out.mass.cancelled = dv.getInt32(88, true) === 1;
      this._free(mp, 96);
      const fc = this.x.cb_dynamic_frame_count(r);
      out.frameTimes = []; out.frames = [];
      for (let i = 0; i < fc; i++) {
        out.frameTimes.push(this.x.cb_dynamic_frame_time(r, i));
        out.frames.push(this._copyOut((p, l) => this.x.cb_dynamic_copy_frame(r, i, p, l), Float32Array, n));
      }
      const pc = this.x.cb_dynamic_probe_count(r); out.probes = [];
      for (let i = 0; i < pc; i++) {
        const len = this.x.cb_dynamic_copy_probe(r, i, 0, 0);
        out.probes.push(this._copyOut((p, l) => this.x.cb_dynamic_copy_probe(r, i, p, l), Float32Array, len));
      }
      return out;
    } finally { this.x.cb_dynamic_free(r); }
  }

  /**
   * Cap cumulative infiltration per cell in mm (e.g. groundwater within 1 m of the surface). `capsMm` has one value per
   * cell (row-major, like g.z); negative = no cap. An empty array clears the caps. Applies to later runs on this grid.
   */
  setInfiltrationCap(g, capsMm) {
    const n = capsMm.length; const bytes = Math.max(4, n * 4); const p = this._alloc(bytes);
    try {
      new Float32Array(this._mem, p, n).set(capsMm);
      if (!this.x.cb_grid_set_infiltration_cap(g.handle, p, n)) throw this._err('infiltration cap');
    } finally { this._free(p, bytes); }
  }

  // ---------- retention (OUT-8)
  retention(g, input = {}) {
    const i = { returnPeriod: 10, climateFactor: 1.3, dischargeLSHa: 1, safetyFactor: 1.2, rationalDurationMin: 10, ...input };
    const ip = this._alloc(40); const op = this._alloc(56);
    const dv = new DataView(this._mem, ip, 40);
    [i.returnPeriod, i.climateFactor, i.dischargeLSHa, i.safetyFactor, i.rationalDurationMin].forEach((v, k) => dv.setFloat64(k * 8, v, true));
    try {
      if (!this.x.cb_grid_retention(g.handle, ip, op)) throw this._err('retention');
      const ov = new DataView(this._mem, op, 56); const out = {};
      RET_OUT.forEach((k, j) => (out[k] = ov.getFloat64(j * 8, true)));
      return out;
    } finally { this._free(ip, 40); this._free(op, 56); }
  }
}

/** Rain presets shared with the desktop plug-ins (RainEvent.Presets()). */
export function rainPresets(engine) {
  return [
    { id: 't10', name: 'T = 10 years', description: '4 h CDS, 35 mm × 1.3', depthMm: 35, climateFactor: 1.3, durationMin: 240, intensity: engine.rainCds(10, 240, 35) },
    { id: 't100', name: 'T = 100 years (cloudburst)', description: '4 h CDS, 59 mm × 1.4 = 83 mm', depthMm: 59, climateFactor: 1.4, durationMin: 240, intensity: engine.rainCds(100, 240, 59) },
    { id: 'test2011', name: '2011 test (Copenhagen)', description: 'Box rain 120 mm over 2 h', depthMm: 120, climateFactor: 1.0, durationMin: 120, intensity: engine.rainBox(120, 120) },
    { id: 'box83', name: 'Box 83 mm / 4 h', description: 'Box rain, same volume as T100', depthMm: 83, climateFactor: 1.0, durationMin: 240, intensity: engine.rainBox(83, 240) },
  ];
}
