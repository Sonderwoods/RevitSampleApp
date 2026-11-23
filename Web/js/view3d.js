// Optional 3D view (three.js from the CDN via the import map). Loaded lazily; if the CDN is unreachable the app keeps
// working in 2D and reports that 3D is unavailable.
let THREE = null, OrbitControls = null;

export async function load3D() {
  if (THREE) return true;
  const t = await import('three');
  const oc = await import('three/addons/controls/OrbitControls.js');
  THREE = t; OrbitControls = oc.OrbitControls;
  return true;
}

export class View3D {
  constructor(container) {
    this.container = container;
    const r = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    r.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    r.shadowMap.enabled = true; r.shadowMap.type = THREE.PCFSoftShadowMap;
    r.outputColorSpace = THREE.SRGBColorSpace;
    container.append(r.domElement); this.renderer = r;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color('#0b1320');
    this.scene.fog = new THREE.Fog('#0b1320', 600, 1600);
    this.camera = new THREE.PerspectiveCamera(40, 1, 1, 5000);
    this.controls = new OrbitControls(this.camera, r.domElement);
    this.controls.enableDamping = true; this.controls.maxPolarAngle = Math.PI * 0.47;
    this.scene.add(new THREE.HemisphereLight('#dbe9ff', '#3a3f46', 1.35));
    const sun = new THREE.DirectionalLight('#fff4e0', 1.9); sun.position.set(-200, 300, -150); sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048); this.sun = sun; this.scene.add(sun); this.scene.add(sun.target);
    this.group = new THREE.Group(); this.scene.add(this.group);
    this.ve = 2; // vertical exaggeration
    this.ro = new ResizeObserver(() => this.resize()); this.ro.observe(container);
    this.running = false; this.resize();
  }

  resize() {
    const w = this.container.clientWidth || 800, h = this.container.clientHeight || 600;
    this.renderer.setSize(w, h); this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
  }
  start() { if (this.running) return; this.running = true; const loop = () => { if (!this.running) return; this.controls.update(); this.renderer.render(this.scene, this.camera); requestAnimationFrame(loop); }; loop(); }
  stop() { this.running = false; }

  _clear() {
    for (const o of [...this.group.children]) { this.group.remove(o); o.traverse((m) => { m.geometry && m.geometry.dispose(); if (m.material) { m.material.map && m.material.map.dispose(); m.material.dispose(); } }); }
    this.water = null;
  }

  /** Terrain (textured with the 2D base map) + extruded buildings. */
  setSite(grid, baseCanvas, buildingsVec) {
    this._clear();
    this.grid = grid;
    const { nx, ny, dx, terrainZ } = grid;
    let zmin = Infinity; for (const v of terrainZ) if (v < zmin) zmin = v;
    this.zmin = zmin; this.cx = grid.x0 + nx * dx / 2; this.cy = grid.y0 + ny * dx / 2;
    const terrain = this._surface(grid, (k) => terrainZ[k], 0);
    const tex = new THREE.CanvasTexture(baseCanvas); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8;
    const mesh = new THREE.Mesh(terrain, new THREE.MeshStandardMaterial({ map: tex, roughness: 0.95, metalness: 0 }));
    mesh.receiveShadow = true; this.group.add(mesh);
    // skirt / base slab
    const W = nx * dx, H = ny * dx;
    const slab = new THREE.Mesh(new THREE.BoxGeometry(W, 4, H), new THREE.MeshStandardMaterial({ color: '#1b2636', roughness: 1 }));
    slab.position.set(0, -2.05 - 0.5, 0); this.group.add(slab);
    // buildings
    const bmat = new THREE.MeshStandardMaterial({ color: '#c9ced6', roughness: 0.8 });
    if (buildingsVec && buildingsVec.length) {
      for (const b of buildingsVec) {
        const shape = new THREE.Shape(b.xs.map((x, i) => new THREE.Vector2(x - this.cx, (b.ys[i] - this.cy))));
        let zb = Infinity;
        b.xs.forEach((x, i) => { const z = this._zAt(x, b.ys[i]); if (z < zb) zb = z; });
        if (!isFinite(zb)) zb = zmin;
        const geo = new THREE.ExtrudeGeometry(shape, { depth: b.height * this.ve * 0.5 + (0.6), bevelEnabled: false });
        geo.rotateX(-Math.PI / 2);
        const m = new THREE.Mesh(geo, bmat); m.position.y = (zb - zmin) * this.ve - 0.5;
        m.castShadow = true; m.receiveShadow = true; this.group.add(m);
      }
    } else {
      // raster buildings as instanced boxes on a coarse lattice
      const s = Math.max(1, Math.ceil(Math.sqrt(nx * ny / 40000)));
      const cells = [];
      for (let j = 0; j < ny; j += s) for (let i = 0; i < nx; i += s) { const k = j * nx + i; if (grid.building[k] >= 0) cells.push(k); }
      if (cells.length) {
        const inst = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), bmat, cells.length);
        const m4 = new THREE.Matrix4();
        cells.forEach((k, n) => {
          const i = k % nx, j = (k / nx) | 0; const h = Math.max(3, grid.z[k] - terrainZ[k]) * this.ve * 0.5;
          m4.makeScale(dx * s, h, dx * s);
          m4.setPosition(grid.x0 + (i + 0.5 * s) * dx - this.cx, (terrainZ[k] - zmin) * this.ve + h / 2, -(grid.y0 + (j + 0.5 * s) * dx - this.cy));
          inst.setMatrixAt(n, m4);
        });
        inst.castShadow = true; inst.receiveShadow = true; this.group.add(inst);
      }
    }
    const span = Math.max(W, H);
    this.sun.position.set(-span * 0.6, span * 0.9, -span * 0.45);
    const sc = this.sun.shadow.camera; sc.left = -span * 0.75; sc.right = span * 0.75; sc.top = span * 0.75; sc.bottom = -span * 0.75; sc.far = span * 4; sc.updateProjectionMatrix();
    this.scene.fog.near = span * 1.6; this.scene.fog.far = span * 4;
    this.camera.position.set(span * 0.22, span * 0.78, span * 1.02); this.controls.target.set(0, 0, 0); this.controls.update();
  }

  _zAt(x, y) {
    const g = this.grid; const i = Math.min(g.nx - 1, Math.max(0, Math.floor((x - g.x0) / g.dx))), j = Math.min(g.ny - 1, Math.max(0, Math.floor((y - g.y0) / g.dx)));
    return g.terrainZ[j * g.nx + i];
  }

  /** Regular mesh over grid cells (decimated to ≤ ~300 per side); height(k) in model metres. */
  _surface(grid, height, lift) {
    const { nx, ny, dx } = grid;
    const s = Math.max(1, Math.ceil(Math.max(nx, ny) / 300));
    const cols = Math.floor((nx - 1) / s) + 1, rows = Math.floor((ny - 1) / s) + 1;
    const pos = new Float32Array(cols * rows * 3), uv = new Float32Array(cols * rows * 2);
    const keys = new Int32Array(cols * rows);
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const i = Math.min(nx - 1, c * s), j = Math.min(ny - 1, r * s); const k = j * nx + i; const v = r * cols + c;
      keys[v] = k;
      pos[v * 3] = grid.x0 + (i + 0.5) * dx - this.cx;
      pos[v * 3 + 1] = (height(k) - this.zmin) * this.ve + lift;
      pos[v * 3 + 2] = -(grid.y0 + (j + 0.5) * dx - this.cy);
      uv[v * 2] = (i + 0.5) / nx; uv[v * 2 + 1] = (j + 0.5) / ny;
    }
    const idx = [];
    for (let r = 0; r < rows - 1; r++) for (let c = 0; c < cols - 1; c++) {
      const a = r * cols + c, b = a + 1, d = a + cols, e = d + 1;
      idx.push(a, b, d, b, e, d); // counter-clockwise seen from above
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setIndex(idx); geo.computeVertexNormals();
    geo.userData.keys = keys;
    return geo;
  }

  /** Water surface = terrain + depth on grid `wg` (may differ from the site grid), textured with the overlay. */
  setWater(wg, depth, overlayCanvas, minDepth = 0.01) {
    // dry cells sit on the terrain; the (transparent) texture alpha defines the smooth water edge
    const hz = (k) => { const d = depth ? depth[k] : 0; return wg.building[k] < 0 && d > 0 ? wg.terrainZ[k] + d : wg.terrainZ[k]; };
    if (this.water && this.water.userData.grid === wg) {
      const pos = this.water.geometry.attributes.position; const keys = this.water.geometry.userData.keys;
      for (let v = 0; v < keys.length; v++) pos.array[v * 3 + 1] = (hz(keys[v]) - this.zmin) * this.ve + 0.08;
      pos.needsUpdate = true; this.water.geometry.computeVertexNormals();
      const t = this.water.material.map; t.image = overlayCanvas; t.needsUpdate = true;
      return;
    }
    if (this.water) { this.group.remove(this.water); this.water.geometry.dispose(); this.water.material.map.dispose(); this.water.material.dispose(); }
    if (!overlayCanvas) { this.water = null; return; }
    const geo = this._surface(wg, hz, 0.08);
    const tex = new THREE.CanvasTexture(overlayCanvas); tex.colorSpace = THREE.SRGBColorSpace; tex.magFilter = THREE.LinearFilter;
    const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ map: tex, transparent: true, opacity: 0.95, roughness: 0.25, metalness: 0.05, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 }));
    m.userData.grid = wg; m.receiveShadow = true; this.water = m; this.group.add(m);
  }

  dispose() { this.stop(); this._clear(); this.ro.disconnect(); this.renderer.dispose(); this.renderer.domElement.remove(); }
}
