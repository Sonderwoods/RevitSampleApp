//! Scenario settings and per-cell hydrological parameters derived from materials, soils and sewer assumptions.

use crate::grid::{Grid, RoofDrainage};
use crate::palette::{soil, HORTON_K_PER_HOUR};

/// Scenario shared by the instant (M1) and dynamic (M2) models. C layout for FFI.
#[repr(C)]
#[derive(Clone, Copy, Debug)]
pub struct Scenario {
    /// M1 rain depth before climate factor, mm.
    pub rain_depth_mm: f64,
    /// IN-8, e.g. 1.4 for T = 100.
    pub climate_factor: f64,
    /// Capacity for SewerMode::ConstantCapacity, mm/h.
    pub sewer_capacity_mm_h: f64,
    /// Multiplier on infiltration capacity (ensemble low/central/high).
    pub infiltration_scale: f64,
    /// Local-inertial CFL coefficient α (0.2–0.7).
    pub alpha: f64,
    /// de Almeida weighting θ.
    pub theta: f64,
    /// Wet/dry threshold, m.
    pub h_dry: f64,
    /// Simulated time after rain end, minutes (default 120).
    pub after_rain_min: f64,
    /// Snapshot interval for the time slider, s.
    pub output_interval_s: f64,
    /// Instant model: minimum ponding depth to show/count, m.
    pub min_depth: f64,
    /// 0 none, 1 combined initial loss (34 mm), 2 separate (29 mm), 3 constant capacity.
    pub sewer_mode: i32,
    /// 0 dry, 1 moist, 2 wet.
    pub moisture: i32,
    /// 0 open edges, 1 closed.
    pub boundary: i32,
    /// Max stored depth frames.
    pub max_frames: i32,
    /// 1 = depth-dependent Manning n.
    pub depth_roughness: i32,
    /// Bitmask of closed edges in addition to `boundary`: 1 west, 2 east, 4 south, 8 north.
    pub closed_edges: i32,
}

impl Default for Scenario {
    fn default() -> Self {
        Scenario {
            rain_depth_mm: 59.0,
            climate_factor: 1.4,
            sewer_capacity_mm_h: 10.0,
            infiltration_scale: 1.0,
            alpha: 0.7,
            theta: 0.8,
            h_dry: 0.001,
            after_rain_min: 120.0,
            output_interval_s: 300.0,
            min_depth: 0.01,
            sewer_mode: 1,
            moisture: 1,
            boundary: 0,
            max_frames: 120,
            depth_roughness: 0,
            closed_edges: 0,
        }
    }
}

pub fn sewer_loss_mm(mode: i32) -> f64 {
    match mode {
        1 => 34.0,
        2 => 29.0,
        _ => 0.0,
    }
}

/// Per-cell parameters (SI units).
pub struct Hydro {
    pub n: Vec<f32>,
    /// Horton fc, m/s.
    pub fc: Vec<f32>,
    /// Horton f0 (moisture adjusted), m/s.
    pub f0: Vec<f32>,
    /// Initial loss bucket (interception, depression; plus `storage_mm` of materials without a sub-base model), m.
    pub ia: Vec<f32>,
    /// 1 where the cell is an engineered permeable surface on a sub-base (see `infiltration::CellInf::limited`).
    pub limited: Vec<u8>,
    /// Sub-base storage, m (limited cells only).
    pub store_cap: Vec<f32>,
    /// Sub-base drainage to the subsoil (JB soil fc × infiltration scale), m/s (limited cells only).
    pub drain: Vec<f32>,
    /// Cap on cumulative infiltration, m (`f32::INFINITY` = none). From `Grid::infiltration_cap_mm` (high groundwater).
    pub f_cap: Vec<f32>,
    /// Sewer initial loss, m (sewer-connected surfaces only).
    pub sewer_ia: Vec<f32>,
    /// Sewer sink rate, m/s.
    pub sewer_rate: Vec<f32>,
    /// Effective cloudburst runoff coefficient (M1).
    pub c_cb: Vec<f32>,
    /// Administrative runoff coefficient (retention).
    pub c_normal: Vec<f32>,
    /// Horton decay, 1/s.
    pub k: f32,
}

pub fn derive(g: &Grid, sc: &Scenario) -> Hydro {
    let n = g.len();
    let mut h = Hydro {
        n: vec![0.03; n],
        fc: vec![0.0; n],
        f0: vec![0.0; n],
        ia: vec![0.0; n],
        limited: vec![0; n],
        store_cap: vec![0.0; n],
        drain: vec![0.0; n],
        f_cap: vec![f32::INFINITY; n],
        sewer_ia: vec![0.0; n],
        sewer_rate: vec![0.0; n],
        c_cb: vec![1.0; n],
        c_normal: vec![1.0; n],
        k: (HORTON_K_PER_HOUR / 3600.0) as f32,
    };
    let mmh = 1.0 / 1000.0 / 3600.0; // mm/h → m/s
    let roof_default = g.palette.index_of("roof_flat").unwrap_or(0);
    for k in 0..n {
        let b = g.building[k];
        let mi = if b >= 0 { g.building_roof_material.get(b as usize).copied().flatten().unwrap_or(roof_default) } else { g.material[k] as usize };
        let m = &g.palette.materials[mi.min(g.palette.materials.len() - 1)];
        let s = soil(g.soil[k]);
        let clay = s.clay;
        h.n[k] = m.manning_n as f32;
        h.c_cb[k] = m.c_cloudburst(clay) as f32;
        h.c_normal[k] = m.c_normal as f32;
        let compacted = match g.compaction[k] {
            1 => true,
            2 => false,
            _ => m.compacted,
        };
        let subbase = b < 0 && m.subsoil_limited;
        h.ia[k] = ((m.initial_loss_mm + if subbase { 0.0 } else { m.storage_mm.max(0.0) }) / 1000.0) as f32;
        if subbase {
            let sub_fc = if compacted { s.compacted_fc } else { s.loose_fc };
            h.limited[k] = 1;
            h.store_cap[k] = (m.storage_mm.max(0.0) / 1000.0) as f32;
            h.drain[k] = (sub_fc * sc.infiltration_scale.max(0.0) * mmh) as f32;
        }
        if let Some(&cap) = g.infiltration_cap_mm.get(k) {
            if cap >= 0.0 && g.infiltration_cap_mm.len() == n {
                h.f_cap[k] = cap / 1000.0;
            }
        }

        let (mut fc, mut f0) = if b >= 0 {
            (0.0, 0.0)
        } else if m.use_soil_table {
            if compacted {
                (s.compacted_fc, s.compacted_f0)
            } else {
                (s.loose_fc, s.loose_f0)
            }
        } else {
            let f = m.infiltration(clay);
            (f, f * 3.5)
        };
        f0 = match sc.moisture {
            0 => f0.max(fc),
            2 => fc,
            _ => (f0 / 3.0).max(fc),
        };
        fc *= sc.infiltration_scale.max(0.0);
        f0 *= sc.infiltration_scale.max(0.0);
        h.fc[k] = (fc * mmh) as f32;
        h.f0[k] = (f0 * mmh) as f32;

        // Sewer: applies to sewer-connected surfaces (default: sealed ones; open water is not); roofs to sewer always get a loss.
        let mode = if g.sewer[k] != 255 { g.sewer[k] as i32 } else { sc.sewer_mode };
        let roof_to_sewer = b >= 0 && g.building_drainage.get(b as usize).copied().unwrap_or(RoofDrainage::ToSewer) == RoofDrainage::ToSewer;
        let to_sewer = if b >= 0 { roof_to_sewer } else { m.is_sewer_connected() };
        if to_sewer {
            match mode {
                3 => h.sewer_rate[k] = (sc.sewer_capacity_mm_h * mmh) as f32,
                1 | 2 => h.sewer_ia[k] = (sewer_loss_mm(mode) / 1000.0) as f32,
                _ => {
                    if roof_to_sewer {
                        h.sewer_ia[k] = 0.034
                    }
                }
            }
        }
    }
    h
}
