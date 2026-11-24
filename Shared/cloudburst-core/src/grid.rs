//! Site description → uniform raster (IN-1 … IN-6). Scan-conversion instead of ray casting keeps rebuilds interactive.

use crate::geometry::{Bounds, Mesh, Polygon, Polyline};
use crate::palette::Palette;
use std::collections::{HashMap, HashSet, VecDeque};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(i32)]
pub enum RoofDrainage {
    ToSewer = 0,
    ToGround = 1,
}

#[derive(Clone, Debug)]
pub struct Building {
    pub mesh: Option<Mesh>,
    pub footprint: Option<Polygon>,
    pub height: f64,
    pub drainage: RoofDrainage,
    /// Palette index of the roof material, or None for the default roof.
    pub roof_material: Option<usize>,
}

#[derive(Clone, Debug)]
pub struct Region {
    pub outline: Option<Polygon>,
    pub surface: Option<Mesh>,
    pub material: usize,
    /// 0 = keep default.
    pub soil: u8,
    /// 0 default, 1 compacted, 2 loose.
    pub compaction: u8,
    /// 255 = scenario default.
    pub sewer: u8,
}

#[derive(Clone, Debug)]
pub struct Wall {
    pub line: Polyline,
    pub height: f64,
}

#[derive(Clone, Debug, Default)]
pub struct Site {
    pub terrain: Vec<Mesh>,
    pub design_terrain: Vec<Mesh>,
    pub buildings: Vec<Building>,
    pub regions: Vec<Region>,
    pub walls: Vec<Wall>,
    pub bridge_cuts: Vec<Polygon>,
    pub boundary: Option<Polygon>,
}

impl Site {
    pub fn bounds(&self) -> Bounds {
        let mut b = Bounds::empty();
        for m in self.terrain.iter().chain(self.design_terrain.iter()) {
            b.union(&m.bounds());
        }
        if let Some(bd) = &self.boundary {
            b = if b.is_valid() { b.intersect(&bd.bounds()) } else { bd.bounds() };
        }
        b
    }
}

#[repr(C)]
#[derive(Clone, Copy, Debug)]
pub struct GridSettings {
    pub cell_size: f64,
    pub building_min_height: f64,
    pub max_cells: i32,
    pub default_soil: i32,
    /// −1 = palette default.
    pub default_material: i32,
    /// 1 = use roof geometry heights when higher than min height.
    pub use_roof_height: i32,
}

impl Default for GridSettings {
    fn default() -> Self {
        GridSettings { cell_size: 1.0, building_min_height: 5.0, max_cells: 2_000_000, default_soil: 6, default_material: -1, use_roof_height: 0 }
    }
}

/// Row-major raster; index = j*nx + i; (0,0) is the south-west cell.
#[derive(Clone, Debug)]
pub struct Grid {
    pub nx: usize,
    pub ny: usize,
    pub x0: f64,
    pub y0: f64,
    pub dx: f64,
    pub terrain_z: Vec<f32>,
    pub z: Vec<f32>,
    pub material: Vec<u16>,
    pub building: Vec<i32>,
    pub soil: Vec<u8>,
    pub compaction: Vec<u8>,
    pub sewer: Vec<u8>,
    pub active: Vec<u8>,
    pub building_drainage: Vec<RoofDrainage>,
    pub building_roof_material: Vec<Option<usize>>,
    /// Optional cap on cumulative infiltration per cell, mm (negative = no cap). Empty = no caps. Used for high
    /// groundwater (PRD: infiltration stops after the first few millimetres). Set with `set_infiltration_cap`.
    pub infiltration_cap_mm: Vec<f32>,
    pub palette: Palette,
    pub warnings: Vec<String>,
}

impl Grid {
    pub fn new(nx: usize, ny: usize, x0: f64, y0: f64, dx: f64, palette: Palette) -> Grid {
        let n = nx * ny;
        let def = palette.default_index() as u16;
        Grid {
            nx,
            ny,
            x0,
            y0,
            dx,
            terrain_z: vec![0.0; n],
            z: vec![0.0; n],
            material: vec![def; n],
            building: vec![-1; n],
            soil: vec![6; n],
            compaction: vec![0; n],
            sewer: vec![255; n],
            active: vec![1; n],
            building_drainage: vec![],
            building_roof_material: vec![],
            infiltration_cap_mm: vec![],
            palette,
            warnings: vec![],
        }
    }

    /// Simple grid from a height function (tests).
    pub fn from_fn(nx: usize, ny: usize, dx: f64, f: impl Fn(usize, usize) -> f32) -> Grid {
        let mut g = Grid::new(nx, ny, 0.0, 0.0, dx, Palette::default_palette());
        for j in 0..ny {
            for i in 0..nx {
                let v = f(i, j);
                g.terrain_z[j * nx + i] = v;
                g.z[j * nx + i] = v;
            }
        }
        g
    }

    #[inline]
    pub fn len(&self) -> usize {
        self.nx * self.ny
    }
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
    #[inline]
    pub fn cell_area(&self) -> f64 {
        self.dx * self.dx
    }
    #[inline]
    pub fn cx(&self, i: usize) -> f64 {
        self.x0 + (i as f64 + 0.5) * self.dx
    }
    #[inline]
    pub fn cy(&self, j: usize) -> f64 {
        self.y0 + (j as f64 + 0.5) * self.dx
    }
    pub fn cell_at(&self, x: f64, y: f64) -> Option<usize> {
        let i = ((x - self.x0) / self.dx).floor();
        let j = ((y - self.y0) / self.dx).floor();
        if i < 0.0 || j < 0.0 || i >= self.nx as f64 || j >= self.ny as f64 {
            None
        } else {
            Some(j as usize * self.nx + i as usize)
        }
    }

    /// Set the material for every cell (tests).
    /// Cap cumulative infiltration (mm) per cell; negative or NaN = no cap. `caps.len()` must equal the cell count,
    /// an empty slice clears all caps. Returns false on a length mismatch.
    pub fn set_infiltration_cap(&mut self, caps_mm: &[f32]) -> bool {
        if caps_mm.is_empty() {
            self.infiltration_cap_mm.clear();
            return true;
        }
        if caps_mm.len() != self.len() {
            return false;
        }
        self.infiltration_cap_mm = caps_mm.iter().map(|&v| if v.is_nan() || v < 0.0 { -1.0 } else { v }).collect();
        true
    }

    pub fn set_material_all(&mut self, id: &str) {
        let m = self.palette.index_of(id).expect("material") as u16;
        self.material.iter_mut().for_each(|v| *v = m);
    }
}

// ---------------------------------------------------------------- rasterization

/// Visit each cell whose centre is inside a triangle; passes interpolated z.
pub fn raster_mesh(g: &Grid, mesh: &Mesh, mut visit: impl FnMut(usize, f64)) {
    let v = &mesh.verts;
    let dx = g.dx;
    for t in mesh.tris.chunks_exact(3) {
        let (a, b, c) = (t[0] as usize * 3, t[1] as usize * 3, t[2] as usize * 3);
        if a + 2 >= v.len() || b + 2 >= v.len() || c + 2 >= v.len() {
            continue;
        }
        let (ax, ay, az) = (v[a], v[a + 1], v[a + 2]);
        let (bx, by, bz) = (v[b], v[b + 1], v[b + 2]);
        let (cx, cy, cz) = (v[c], v[c + 1], v[c + 2]);
        let det = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
        if det.abs() < 1e-12 {
            continue;
        }
        let inv = 1.0 / det;
        let min_x = ax.min(bx).min(cx);
        let max_x = ax.max(bx).max(cx);
        let min_y = ay.min(by).min(cy);
        let max_y = ay.max(by).max(cy);
        let i0 = (((min_x - g.x0) / dx - 0.5).ceil()).max(0.0) as i64;
        let i1 = (((max_x - g.x0) / dx - 0.5).floor()).min(g.nx as f64 - 1.0) as i64;
        let j0 = (((min_y - g.y0) / dx - 0.5).ceil()).max(0.0) as i64;
        let j1 = (((max_y - g.y0) / dx - 0.5).floor()).min(g.ny as f64 - 1.0) as i64;
        if i0 > i1 || j0 > j1 {
            continue;
        }
        const EPS: f64 = -1e-9;
        for j in j0..=j1 {
            let py = g.y0 + (j as f64 + 0.5) * dx;
            for i in i0..=i1 {
                let px = g.x0 + (i as f64 + 0.5) * dx;
                let l1 = ((by - cy) * (px - cx) + (cx - bx) * (py - cy)) * inv;
                if l1 < EPS {
                    continue;
                }
                let l2 = ((cy - ay) * (px - cx) + (ax - cx) * (py - cy)) * inv;
                if l2 < EPS {
                    continue;
                }
                let l3 = 1.0 - l1 - l2;
                if l3 < EPS {
                    continue;
                }
                visit(j as usize * g.nx + i as usize, l1 * az + l2 * bz + l3 * cz);
            }
        }
    }
}

/// Visit each cell whose centre lies inside the polygon (even-odd scanline).
pub fn raster_polygon(g: &Grid, p: &Polygon, mut visit: impl FnMut(usize)) {
    let n = p.xs.len();
    if n < 3 {
        return;
    }
    let b = p.bounds();
    let dx = g.dx;
    let j0 = (((b.min_y - g.y0) / dx - 0.5).ceil()).max(0.0) as i64;
    let j1 = (((b.max_y - g.y0) / dx - 0.5).floor()).min(g.ny as f64 - 1.0) as i64;
    let mut xs: Vec<f64> = Vec::with_capacity(16);
    for j in j0..=j1 {
        let py = g.y0 + (j as f64 + 0.5) * dx;
        xs.clear();
        let mut c = n - 1;
        for a in 0..n {
            let (ya, yc) = (p.ys[a], p.ys[c]);
            if (ya > py) != (yc > py) {
                xs.push(p.xs[a] + (py - ya) * (p.xs[c] - p.xs[a]) / (yc - ya));
            }
            c = a;
        }
        xs.sort_by(|a, b| a.partial_cmp(b).unwrap());
        for k in (0..xs.len().saturating_sub(1)).step_by(2) {
            let i0 = (((xs[k] - g.x0) / dx - 0.5).ceil()).max(0.0) as i64;
            let i1 = (((xs[k + 1] - g.x0) / dx - 0.5).floor()).min(g.nx as f64 - 1.0) as i64;
            for i in i0..=i1 {
                visit(j as usize * g.nx + i as usize);
            }
        }
    }
}

/// Visit cells touched by a polyline, 4-connected so water cannot leak through diagonals.
pub fn raster_polyline(g: &Grid, l: &Polyline, mut visit: impl FnMut(usize)) {
    let mut last: Option<(usize, usize)> = None;
    for s in 1..l.xs.len().min(l.ys.len()) {
        let (x0, y0, x1, y1) = (l.xs[s - 1], l.ys[s - 1], l.xs[s], l.ys[s]);
        let len = ((x1 - x0).powi(2) + (y1 - y0).powi(2)).sqrt();
        let steps = ((len / (g.dx * 0.25)).ceil() as usize).max(1);
        for k in 0..=steps {
            let t = k as f64 / steps as f64;
            let (x, y) = (x0 + (x1 - x0) * t, y0 + (y1 - y0) * t);
            let i = ((x - g.x0) / g.dx).floor();
            let j = ((y - g.y0) / g.dx).floor();
            if i < 0.0 || j < 0.0 || i >= g.nx as f64 || j >= g.ny as f64 {
                last = None;
                continue;
            }
            let (i, j) = (i as usize, j as usize);
            if last == Some((i, j)) {
                continue;
            }
            if let Some((li, lj)) = last {
                if li != i && lj != j {
                    visit(lj * g.nx + i);
                }
            }
            visit(j * g.nx + i);
            last = Some((i, j));
        }
    }
}

// ---------------------------------------------------------------- builder

pub fn build_grid(site: &Site, palette: Palette, s: &GridSettings) -> Result<Grid, String> {
    let t0 = crate::sys::Clock::now();
    if site.terrain.is_empty() && site.design_terrain.is_empty() {
        return Err("Select a terrain first.".into());
    }
    let b = site.bounds();
    if !b.is_valid() {
        return Err("Terrain has no horizontal extent.".into());
    }
    let mut dx = s.cell_size.max(0.05);
    let mut warnings = vec![];
    let max_cells = if s.max_cells > 0 { s.max_cells as f64 } else { 2e6 };
    if b.width() / dx * (b.height() / dx) > max_cells {
        let nd = ((b.width() * b.height() / max_cells).sqrt() * 10.0).ceil() / 10.0;
        warnings.push(format!("Cell size raised from {:.2} m to {:.2} m to stay under {} cells.", dx, nd, max_cells as i64));
        dx = nd;
    }
    let nx = ((b.width() / dx).ceil() as usize).max(2);
    let ny = ((b.height() / dx).ceil() as usize).max(2);
    let mut g = Grid::new(nx, ny, b.min_x, b.min_y, dx, palette);
    g.warnings = warnings;
    let n = g.len();

    // 1. terrain: highest surface wins; design terrain replaces.
    let mut z = vec![f32::NAN; n];
    for m in &site.terrain {
        raster_mesh(&g, m, |k, zz| {
            if z[k].is_nan() || zz as f32 > z[k] {
                z[k] = zz as f32
            }
        });
    }
    if !site.design_terrain.is_empty() {
        let mut d = vec![f32::NAN; n];
        for m in &site.design_terrain {
            raster_mesh(&g, m, |k, zz| {
                if d[k].is_nan() || zz as f32 > d[k] {
                    d[k] = zz as f32
                }
            });
        }
        for k in 0..n {
            if !d[k].is_nan() {
                z[k] = d[k];
            }
        }
    }
    let holes = z.iter().filter(|v| v.is_nan()).count();
    if holes == n {
        return Err("Terrain does not cover any cell. Is it a horizontal mesh/surface?".into());
    }
    for k in 0..n {
        if z[k].is_nan() {
            g.active[k] = 0;
        }
    }
    if holes > 0 {
        fill_holes(&g, &mut z);
    }
    if let Some(bd) = &site.boundary {
        let mut inside = vec![false; n];
        raster_polygon(&g, bd, |k| inside[k] = true);
        for k in 0..n {
            if !inside[k] {
                g.active[k] = 0;
            }
        }
    }
    g.terrain_z = z;

    // 2. bridge cut-outs
    for cut in &site.bridge_cuts {
        cut_bridge(&mut g, cut);
    }
    if site.bridge_cuts.is_empty() {
        g.warnings.push("No bridge cut-outs set; DHM bridge decks act as false dams.".into());
    }
    g.z = g.terrain_z.clone();

    // 3. materials, soil, sewer
    let def_mat = if s.default_material >= 0 && (s.default_material as usize) < g.palette.materials.len() { s.default_material as u16 } else { g.palette.default_index() as u16 };
    let def_soil = s.default_soil.clamp(1, 11) as u8;
    g.material.iter_mut().for_each(|v| *v = def_mat);
    g.soil.iter_mut().for_each(|v| *v = def_soil);
    for r in &site.regions {
        let mat = r.material.min(g.palette.materials.len() - 1) as u16;
        let mut cells = vec![];
        if let Some(o) = &r.outline {
            raster_polygon(&g, o, |k| cells.push(k));
        }
        if let Some(m) = &r.surface {
            raster_mesh(&g, m, |k, _| cells.push(k));
        }
        for k in cells {
            g.material[k] = mat;
            if r.soil > 0 {
                g.soil[k] = r.soil.clamp(1, 11);
            }
            if r.compaction > 0 {
                g.compaction[k] = r.compaction;
            }
            if r.sewer != 255 {
                g.sewer[k] = r.sewer;
            }
        }
    }

    // 4. buildings → blocks
    for (bi, bld) in site.buildings.iter().enumerate() {
        g.building_drainage.push(bld.drainage);
        g.building_roof_material.push(bld.roof_material);
        let minh = s.building_min_height as f32;
        let use_roof = s.use_roof_height != 0;
        let mut roof: HashMap<usize, f64> = HashMap::new();
        if let Some(m) = &bld.mesh {
            raster_mesh(&g, m, |k, zz| {
                let e = roof.entry(k).or_insert(zz);
                if zz > *e {
                    *e = zz
                }
            });
        }
        if let Some(fp) = &bld.footprint {
            let h = bld.height;
            let tz = &g.terrain_z;
            let mut cells = vec![];
            raster_polygon(&g, fp, |k| cells.push(k));
            for k in cells {
                roof.insert(k, tz[k] as f64 + h);
            }
        }
        for (k, rz) in roof {
            let mut top = g.terrain_z[k] + minh;
            if use_roof {
                top = top.max(rz as f32);
            }
            g.z[k] = g.z[k].max(top);
            g.building[k] = bi as i32;
        }
    }

    // 5. walls / kerbs (+) and channels (−)
    for w in &site.walls {
        let mut seen = HashSet::new();
        let h = w.height as f32;
        let mut cells = vec![];
        raster_polyline(&g, &w.line, |k| {
            if seen.insert(k) {
                cells.push(k)
            }
        });
        for k in cells {
            if g.building[k] >= 0 {
                continue;
            }
            g.z[k] = if h >= 0.0 { g.z[k].max(g.terrain_z[k] + h) } else { g.terrain_z[k] + h };
        }
    }
    g.warnings.push(format!("Grid {}×{} @ {:.2} m built in {} ms.", nx, ny, dx, t0.ms() as i64));
    Ok(g)
}

fn fill_holes(g: &Grid, z: &mut [f32]) {
    let (nx, ny) = (g.nx, g.ny);
    let mut q: VecDeque<usize> = (0..z.len()).filter(|&k| !z[k].is_nan()).collect();
    while let Some(k) = q.pop_front() {
        let (i, j) = (k % nx, k / nx);
        let nb = [(i + 1, j), (i.wrapping_sub(1), j), (i, j + 1), (i, j.wrapping_sub(1))];
        for (ii, jj) in nb {
            if ii >= nx || jj >= ny {
                continue;
            }
            let m = jj * nx + ii;
            if z[m].is_nan() {
                z[m] = z[k];
                q.push_back(m);
            }
        }
    }
}

fn cut_bridge(g: &mut Grid, cut: &Polygon) {
    let mut cells = vec![];
    raster_polygon(g, cut, |k| cells.push(k));
    if cells.is_empty() {
        return;
    }
    let inside: HashSet<usize> = cells.iter().copied().collect();
    let mut min = f32::MAX;
    for &k in &cells {
        let (i, j) = ((k % g.nx) as i64, (k / g.nx) as i64);
        for dj in -1..=1 {
            for di in -1..=1 {
                let (ii, jj) = (i + di, j + dj);
                if ii < 0 || jj < 0 || ii >= g.nx as i64 || jj >= g.ny as i64 {
                    continue;
                }
                let m = jj as usize * g.nx + ii as usize;
                if !inside.contains(&m) {
                    min = min.min(g.terrain_z[m]);
                }
            }
        }
    }
    if min < f32::MAX {
        for k in cells {
            g.terrain_z[k] = g.terrain_z[k].min(min);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_grid_with_building_and_region() {
        let mut site = Site::default();
        site.terrain.push(Mesh::height_field(0.0, 0.0, 100.0, 50.0, 10, 5, |x, _| x * 0.01));
        site.buildings.push(Building { mesh: None, footprint: Some(Polygon::rect(10.0, 10.0, 20.0, 20.0)), height: 8.0, drainage: RoofDrainage::ToSewer, roof_material: None });
        let p = Palette::default_palette();
        let asphalt = p.index_of("asphalt").unwrap();
        site.regions.push(Region { outline: Some(Polygon::rect(50.0, 0.0, 60.0, 50.0)), surface: None, material: asphalt, soil: 0, compaction: 0, sewer: 255 });
        site.walls.push(Wall { line: Polyline { xs: vec![70.0, 70.0], ys: vec![0.0, 50.0] }, height: 0.1 });
        let g = build_grid(&site, p, &GridSettings::default()).unwrap();
        assert_eq!((g.nx, g.ny), (100, 50));
        let k = g.cell_at(15.0, 15.0).unwrap();
        assert_eq!(g.building[k], 0);
        assert!((g.z[k] - g.terrain_z[k] - 5.0).abs() < 1e-4);
        let a = g.cell_at(55.0, 25.0).unwrap();
        assert_eq!(g.material[a] as usize, asphalt);
        let w = g.cell_at(70.2, 25.0).unwrap();
        assert!((g.z[w] - g.terrain_z[w] - 0.1).abs() < 1e-4);
        // terrain interpolation
        let t = g.cell_at(40.5, 2.0).unwrap();
        assert!((g.terrain_z[t] - 0.405).abs() < 1e-3);
    }
}
