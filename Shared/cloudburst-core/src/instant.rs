//! M1 instant model: priority-flood (Barnes 2014) → bluespots, MFD flow accumulation over the filled surface,
//! fill–spill routing of effective rain through the bluespot cascade, partial water levels, flow paths.
//! Runs in O(n log n); ~0.2–0.5 s for 1 M cells.

use crate::grid::Grid;
use crate::hydro::{derive, Scenario};
use std::cmp::Ordering;
use std::collections::{BinaryHeap, VecDeque};

#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
pub struct Bluespot {
    pub id: i32,
    pub cell_count: i32,
    /// 1 when the bluespot overflows to downstream.
    pub spills: i32,
    pub _pad: i32,
    /// Footprint of the full bluespot, m².
    pub area_m2: f64,
    /// Capacity to the spill level, m³.
    pub capacity_m3: f64,
    /// Water stored for this rain, m³.
    pub volume_m3: f64,
    /// Max depth for this rain, m.
    pub max_depth_m: f64,
    /// Max depth if full, m.
    pub full_depth_m: f64,
    /// Wetted area for this rain, m².
    pub wet_area_m2: f64,
    /// Contributing area (all upstream cells), m².
    pub contributing_area_m2: f64,
    /// Rain depth (mm, after climate factor) at which the bluespot starts to spill. Indicative.
    pub spill_rain_mm: f64,
    /// Water level for this rain, m.
    pub level_z: f64,
    /// Spill level, m.
    pub spill_z: f64,
    /// Deepest point, world m.
    pub x: f64,
    pub y: f64,
}

pub struct InstantResult {
    /// Ponding depth per cell, m.
    pub depth: Vec<f32>,
    /// Flow volume passing each cell, m³.
    pub accumulation: Vec<f32>,
    /// Bluespot id per cell (−1 = none).
    pub label: Vec<i32>,
    pub bluespots: Vec<Bluespot>,
    /// Flow paths as (x,y,z,accum) quadruples per path.
    pub paths: Vec<Vec<[f64; 4]>>,
    pub stats: InstantStats,
}

#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
pub struct InstantStats {
    pub rain_volume_m3: f64,
    pub effective_volume_m3: f64,
    pub stored_volume_m3: f64,
    pub outflow_volume_m3: f64,
    pub flooded_area_m2: f64,
    pub area_over_10cm_m2: f64,
    pub max_depth_m: f64,
    pub elapsed_ms: f64,
    pub bluespot_count: i32,
    pub spilling_count: i32,
}

#[derive(Copy, Clone, PartialEq)]
struct Node(f32, u32);
impl Eq for Node {}
impl Ord for Node {
    fn cmp(&self, o: &Self) -> Ordering {
        o.0.partial_cmp(&self.0).unwrap_or(Ordering::Equal).then_with(|| o.1.cmp(&self.1))
    }
}
impl PartialOrd for Node {
    fn partial_cmp(&self, o: &Self) -> Option<Ordering> {
        Some(self.cmp(o))
    }
}

const DI: [i64; 8] = [1, 1, 0, -1, -1, -1, 0, 1];
const DJ: [i64; 8] = [0, 1, 1, 1, 0, -1, -1, -1];

/// Priority-flood result: filled surface, parent (flow target) and pop order.
pub struct Flood {
    pub w: Vec<f32>,
    pub parent: Vec<i32>,
    pub order: Vec<u32>,
}

pub fn priority_flood(g: &Grid) -> Flood {
    let (nx, ny, n) = (g.nx, g.ny, g.len());
    let z = &g.z;
    let mut w = vec![f32::NAN; n];
    let mut parent = vec![-1i32; n];
    let mut order = Vec::with_capacity(n);
    let mut done = vec![false; n];
    let mut heap = BinaryHeap::with_capacity(2 * (nx + ny));
    let mut pit: VecDeque<u32> = VecDeque::new();
    for j in 0..ny {
        for i in 0..nx {
            if i == 0 || j == 0 || i == nx - 1 || j == ny - 1 {
                let k = j * nx + i;
                done[k] = true;
                w[k] = z[k];
                heap.push(Node(z[k], k as u32));
            }
        }
    }
    loop {
        let c = if let Some(c) = pit.pop_front() {
            c
        } else if let Some(Node(_, c)) = heap.pop() {
            c
        } else {
            break;
        };
        order.push(c);
        let c = c as usize;
        let (ci, cj) = ((c % nx) as i64, (c / nx) as i64);
        let wc = w[c];
        for d in 0..8 {
            let (ii, jj) = (ci + DI[d], cj + DJ[d]);
            if ii < 0 || jj < 0 || ii >= nx as i64 || jj >= ny as i64 {
                continue;
            }
            let m = jj as usize * nx + ii as usize;
            if done[m] {
                continue;
            }
            done[m] = true;
            parent[m] = c as i32;
            if z[m] <= wc {
                w[m] = wc;
                pit.push_back(m as u32);
            } else {
                w[m] = z[m];
                heap.push(Node(z[m], m as u32));
            }
        }
    }
    Flood { w, parent, order }
}

/// M1 effective rain depth (m) on one cell for rain depth `p`, cloudburst coefficient `c`, initial loss `ia` and sewer
/// loss `sewer` (all m). `c` is an event coefficient on the whole depth (it already contains interception, depression
/// storage and infiltration), so it is not applied on top of P − Ia, which counted Ia twice. Ia stays a lower bound
/// on the loss (runoff ≤ P − Ia) and the sewer loss acts on what is left. docs/physics-permeability.md.
pub fn effective_rain(p: f64, c: f64, ia: f64, sewer: f64) -> f64 {
    ((p * c).min(p - ia) - sewer).max(0.0)
}

pub fn run_instant(g: &Grid, sc: &Scenario) -> InstantResult {
    let t0 = crate::sys::Clock::now();
    let (nx, ny, n) = (g.nx, g.ny, g.len());
    let a = g.cell_area();
    let hy = derive(g, sc);
    let fl = priority_flood(g);
    let (w, parent, order) = (&fl.w, &fl.parent, &fl.order);
    let z = &g.z;

    // rank (pop position) for entry detection
    let mut rank = vec![0u32; n];
    for (r, &c) in order.iter().enumerate() {
        rank[c as usize] = r as u32;
    }

    // --- effective rain per cell (m³)
    let p = sc.rain_depth_mm * sc.climate_factor / 1000.0;
    let mut stats = InstantStats::default();
    let mut runoff = vec![0f64; n];
    for k in 0..n {
        if g.active[k] == 0 {
            continue;
        }
        let sewer = hy.sewer_ia[k] as f64 + hy.sewer_rate[k] as f64 * 4.0 * 3600.0;
        let r = effective_rain(p, hy.c_cb[k] as f64, hy.ia[k] as f64, sewer);
        runoff[k] = r * a;
        stats.rain_volume_m3 += p * a;
        stats.effective_volume_m3 += r * a;
    }

    // --- label bluespots (4-connected components of filled cells)
    let eps = 1e-4f32;
    let min_d = sc.min_depth.max(0.0) as f32;
    let mut label = vec![-1i32; n];
    let mut spots: Vec<(Vec<u32>, usize)> = vec![]; // cells, entry cell
    for s in 0..n {
        if label[s] >= 0 || w[s] - z[s] <= eps {
            continue;
        }
        let id = spots.len() as i32;
        let mut cells = vec![s as u32];
        label[s] = id;
        let mut q = 0;
        let mut entry = s;
        while q < cells.len() {
            let c = cells[q] as usize;
            q += 1;
            if rank[c] < rank[entry] {
                entry = c;
            }
            let (ci, cj) = ((c % nx) as i64, (c / nx) as i64);
            for d in [0usize, 2, 4, 6] {
                let (ii, jj) = (ci + DI[d], cj + DJ[d]);
                if ii < 0 || jj < 0 || ii >= nx as i64 || jj >= ny as i64 {
                    continue;
                }
                let m = jj as usize * nx + ii as usize;
                if label[m] < 0 && w[m] - z[m] > eps && (w[m] - w[c]).abs() < 1e-5 {
                    label[m] = id;
                    cells.push(m as u32);
                }
            }
        }
        spots.push((cells, entry));
    }
    // entry = first popped cell of the component; all component cells are popped after it.
    let ns = spots.len();
    let mut is_entry = vec![-1i32; n];
    for (id, (_, e)) in spots.iter().enumerate() {
        is_entry[*e] = id as i32;
    }
    let mut capacity = vec![0f64; ns];
    for (id, (cells, _)) in spots.iter().enumerate() {
        capacity[id] = cells.iter().map(|&c| (w[c as usize] - z[c as usize]) as f64 * a).sum();
    }

    // --- routing in reverse pop order (topological), MFD on the filled surface
    let mut flow = runoff.clone();
    let mut unit = vec![a; n]; // contributing area pass (no storage)
    let mut pool = vec![0f64; ns];
    let mut pool_area = vec![0f64; ns];
    let mut accum = vec![0f32; n];
    let mut main_recv = vec![-1i32; n];
    let mut outflow = 0.0;
    let diag = std::f32::consts::SQRT_2 * g.dx as f32;
    for &c in order.iter().rev() {
        let c = c as usize;
        let b = label[c];
        if b >= 0 {
            let bi = b as usize;
            pool[bi] += flow[c];
            pool_area[bi] += unit[c];
            if is_entry[c] == b {
                let over = (pool[bi] - capacity[bi]).max(0.0);
                let pc = parent[c];
                accum[c] = over as f32;
                if pc >= 0 {
                    flow[pc as usize] += over;
                    unit[pc as usize] += pool_area[bi];
                    main_recv[c] = pc;
                } else {
                    outflow += over;
                }
            }
            continue;
        }
        accum[c] = flow[c] as f32;
        let (ci, cj) = ((c % nx) as i64, (c / nx) as i64);
        let wc = w[c];
        let mut wsum = 0f32;
        let mut wts = [0f32; 8];
        let mut best = (-1i32, 0f32);
        for d in 0..8 {
            let (ii, jj) = (ci + DI[d], cj + DJ[d]);
            if ii < 0 || jj < 0 || ii >= nx as i64 || jj >= ny as i64 {
                continue;
            }
            let m = jj as usize * nx + ii as usize;
            let drop = wc - w[m];
            if drop > 1e-6 {
                let dist = if d % 2 == 1 { diag } else { g.dx as f32 };
                let s = (drop / dist).powf(1.1) * if d % 2 == 1 { 0.7071 } else { 1.0 };
                wts[d] = s;
                wsum += s;
                if s > best.1 {
                    best = (m as i32, s);
                }
            }
        }
        if wsum > 0.0 {
            for d in 0..8 {
                if wts[d] > 0.0 {
                    let m = ((cj + DJ[d]) as usize) * nx + (ci + DI[d]) as usize;
                    let f = (wts[d] / wsum) as f64;
                    flow[m] += flow[c] * f;
                    unit[m] += unit[c] * f;
                }
            }
            main_recv[c] = best.0;
        } else if parent[c] >= 0 {
            let pc = parent[c] as usize;
            flow[pc] += flow[c];
            unit[pc] += unit[c];
            main_recv[c] = pc as i32;
        } else {
            outflow += flow[c];
        }
    }

    // --- water levels per bluespot
    let mut depth = vec![0f32; n];
    let mut bluespots = Vec::with_capacity(ns);
    for (id, (cells, _)) in spots.iter().enumerate() {
        let cap = capacity[id];
        let vol = pool[id].min(cap);
        let spill_z = w[cells[0] as usize] as f64;
        let mut zs: Vec<f32> = cells.iter().map(|&c| z[c as usize]).collect();
        zs.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let level = if vol >= cap - 1e-9 {
            spill_z
        } else {
            // find L with sum(max(0, L - z_i))·a = vol
            let mut cum = 0f64;
            let mut lvl = zs[0] as f64;
            let mut found = false;
            for i in 0..zs.len() {
                let next = if i + 1 < zs.len() { zs[i + 1] as f64 } else { spill_z };
                let width = (i + 1) as f64 * a;
                let seg = (next - zs[i] as f64).max(0.0) * width;
                // volume at level zs[i] is cum; at level next is cum + seg
                if cum + seg >= vol {
                    lvl = zs[i] as f64 + (vol - cum) / width;
                    found = true;
                    break;
                }
                cum += seg;
            }
            if found {
                lvl
            } else {
                spill_z
            }
        };
        let mut wet = 0.0;
        let mut maxd = 0f64;
        let mut deepest = cells[0] as usize;
        for &c in cells {
            let c = c as usize;
            let d = (level - z[c] as f64).max(0.0);
            if d > 0.0 {
                depth[c] = d as f32;
                if d >= min_d as f64 {
                    wet += a;
                }
            }
            if z[c] < z[deepest] {
                deepest = c;
            }
            maxd = maxd.max(d);
        }
        let full_depth = spill_z - z[deepest] as f64;
        let contrib = pool_area[id];
        let mean_loss = 0.005; // ~ typical Ia, mm → m
        let spill_mm = if contrib > 0.0 { (cap / contrib + mean_loss) * 1000.0 } else { f64::INFINITY };
        bluespots.push(Bluespot {
            id: id as i32,
            cell_count: cells.len() as i32,
            spills: (pool[id] > cap) as i32,
            _pad: 0,
            area_m2: cells.len() as f64 * a,
            capacity_m3: cap,
            volume_m3: vol,
            max_depth_m: maxd,
            full_depth_m: full_depth,
            wet_area_m2: wet,
            contributing_area_m2: contrib,
            spill_rain_mm: spill_mm,
            level_z: level,
            spill_z,
            x: g.cx(deepest % nx),
            y: g.cy(deepest / nx),
        });
    }

    // --- stats
    for k in 0..n {
        let d = depth[k];
        if d >= min_d {
            stats.flooded_area_m2 += a;
        }
        if d >= 0.1 {
            stats.area_over_10cm_m2 += a;
        }
        stats.max_depth_m = stats.max_depth_m.max(d as f64);
    }
    stats.stored_volume_m3 = bluespots.iter().map(|b| b.volume_m3).sum();
    stats.outflow_volume_m3 = outflow;
    stats.bluespot_count = bluespots.iter().filter(|b| b.max_depth_m >= min_d as f64).count() as i32;
    stats.spilling_count = bluespots.iter().filter(|b| b.spills == 1).count() as i32;

    // --- flow paths
    let paths = trace_paths(g, &fl, &label, &accum, &main_recv, &depth);
    stats.elapsed_ms = t0.ms();
    InstantResult { depth, accumulation: accum, label, bluespots, paths, stats }
}

/// Trace main flow lines from cells whose accumulated volume exceeds a threshold.
fn trace_paths(g: &Grid, fl: &Flood, label: &[i32], accum: &[f32], recv: &[i32], depth: &[f32]) -> Vec<Vec<[f64; 4]>> {
    let n = g.len();
    let mut sorted: Vec<f32> = accum.iter().cloned().filter(|v| *v > 0.0).collect();
    if sorted.is_empty() {
        return vec![];
    }
    sorted.sort_by(|a, b| b.partial_cmp(a).unwrap());
    // threshold: top ~2.5 % of cells, at least 2 m³
    let idx = ((sorted.len() as f64) * 0.025) as usize;
    let thr = sorted[idx.min(sorted.len() - 1)].max(2.0);
    let mut visited = vec![false; n];
    let mut paths = vec![];
    for &c in fl.order.iter().rev() {
        let c = c as usize;
        if visited[c] || accum[c] < thr || label[c] >= 0 || g.building[c] >= 0 {
            continue;
        }
        let mut pts = vec![];
        let mut k = c as i32;
        let mut guard = 0;
        while k >= 0 && guard < 100_000 {
            guard += 1;
            let ku = k as usize;
            let (i, j) = (ku % g.nx, ku / g.nx);
            let zz = g.z[ku] as f64 + depth[ku] as f64;
            pts.push([g.cx(i), g.cy(j), zz, accum[ku] as f64]);
            if visited[ku] || label[ku] >= 0 {
                break;
            }
            visited[ku] = true;
            k = recv[ku];
        }
        if pts.len() >= 3 {
            paths.push(chaikin(&pts));
        }
    }
    paths
}

fn chaikin(p: &[[f64; 4]]) -> Vec<[f64; 4]> {
    let mut out = Vec::with_capacity(p.len() * 2);
    out.push(p[0]);
    for w in p.windows(2) {
        let (a, b) = (w[0], w[1]);
        let q = [0.75 * a[0] + 0.25 * b[0], 0.75 * a[1] + 0.25 * b[1], 0.75 * a[2] + 0.25 * b[2], a[3]];
        let r = [0.25 * a[0] + 0.75 * b[0], 0.25 * a[1] + 0.75 * b[1], 0.25 * a[2] + 0.75 * b[2], b[3]];
        out.push(q);
        out.push(r);
    }
    out.push(*p.last().unwrap());
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::grid::Grid;

    /// Bowl: a single depression with an analytic capacity.
    fn bowl() -> Grid {
        let mut g = Grid::from_fn(41, 41, 1.0, |i, j| {
            let (x, y) = (i as f32 - 20.0, j as f32 - 20.0);
            let r = (x * x + y * y).sqrt();
            if r < 10.0 {
                -1.0 + r * 0.1
            } else {
                -(r - 10.0) * 0.01
            }
        });
        g.set_material_all("asphalt");
        g
    }

    #[test]
    fn priority_flood_fills_bowl_to_rim() {
        let g = bowl();
        let f = priority_flood(&g);
        let c = 20 * 41 + 20;
        assert!(f.w[c] >= -0.05 && f.w[c] <= 0.02, "filled level {}", f.w[c]);
        assert_eq!(f.order.len(), g.len());
    }

    #[test]
    fn small_rain_partially_fills_large_rain_spills() {
        let g = bowl();
        let mut sc = Scenario { climate_factor: 1.0, sewer_mode: 0, ..Default::default() };
        let full = run_instant(&g, &Scenario { rain_depth_mm: 1000.0, ..sc });
        assert_eq!(full.bluespots.len(), 1);
        let b = full.bluespots[0];
        assert_eq!(b.spills, 1);
        assert!((b.volume_m3 - b.capacity_m3).abs() < 1e-6);
        // capacity of a cone of radius 10, depth 1 ≈ π r² h / 3 ≈ 105 m³
        assert!(b.capacity_m3 > 80.0 && b.capacity_m3 < 130.0, "cap {}", b.capacity_m3);

        sc.rain_depth_mm = 20.0; // 20 mm · 1681 m² · (1 − Ia) ≈ 31 m³ < capacity
        let part = run_instant(&g, &sc);
        let p = part.bluespots[0];
        assert_eq!(p.spills, 0);
        // conservation: everything not stored leaves the domain
        let s = part.stats;
        assert!((s.stored_volume_m3 + s.outflow_volume_m3 - s.effective_volume_m3).abs() < 1e-6);
        // the cone's catchment is its own footprint (π·10²) — outside slopes away
        let expected = std::f64::consts::PI * 100.0 * (0.020 - 0.0015);
        assert!((p.volume_m3 - expected).abs() / expected < 0.15, "stored {} vs {}", p.volume_m3, expected);
        let stored: f64 = part.depth.iter().map(|d| *d as f64).sum::<f64>() * g.cell_area();
        assert!((stored - p.volume_m3).abs() / p.volume_m3 < 0.01);
        assert!(p.max_depth_m < b.max_depth_m);
    }

    #[test]
    fn cascade_spills_into_downstream_bluespot() {
        // two pits on a slope: upstream pit overflows into downstream pit
        let mut g = Grid::from_fn(60, 20, 1.0, |i, j| {
            let base = 3.0 - i as f32 * 0.05;
            let p1 = if (i as i32 - 15).abs() < 4 && (j as i32 - 10).abs() < 4 { -0.3 } else { 0.0 };
            let p2 = if (i as i32 - 40).abs() < 6 && (j as i32 - 10).abs() < 6 { -1.0 } else { 0.0 };
            base + p1 + p2
        });
        g.set_material_all("asphalt");
        let r = run_instant(&g, &Scenario { rain_depth_mm: 80.0, climate_factor: 1.0, sewer_mode: 0, ..Default::default() });
        assert!(r.bluespots.len() >= 2);
        let total_in = r.stats.effective_volume_m3;
        let total_out = r.stats.stored_volume_m3 + r.stats.outflow_volume_m3;
        assert!((total_in - total_out).abs() / total_in < 1e-6, "in {total_in} out {total_out}");
        assert!(!r.paths.is_empty());
    }

    #[test]
    fn million_cells_under_budget() {
        let g = Grid::from_fn(1000, 1000, 1.0, |i, j| {
            let (x, y) = (i as f32 * 0.05, j as f32 * 0.05);
            (x.sin() * y.cos()) * 2.0 + i as f32 * 0.002
        });
        let r = run_instant(&g, &Scenario::default());
        eprintln!("1M instant: {:.0} ms, {} bluespots", r.stats.elapsed_ms, r.bluespots.len());
        assert!(r.stats.elapsed_ms < 5000.0);
    }
}
