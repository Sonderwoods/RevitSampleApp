//! OUT-8 retention panel: reduced area, rational-method peak, required storage for a discharge limit. Indicative.

use crate::grid::Grid;
use crate::hydro::{derive, Scenario};
use crate::rain::idf_um_s;

#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
pub struct RetentionInput {
    /// Return period T, years.
    pub return_period: f64,
    pub climate_factor: f64,
    /// Permitted discharge, l/s/ha (of total area).
    pub discharge_l_s_ha: f64,
    /// Safety factor (default 1.2).
    pub safety_factor: f64,
    /// Rational-method duration, minutes (default 10).
    pub rational_duration_min: f64,
}

#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
pub struct RetentionResult {
    pub total_area_m2: f64,
    pub reduced_area_m2: f64,
    pub mean_c: f64,
    /// Rational peak flow, l/s.
    pub peak_flow_l_s: f64,
    /// Permitted outflow, l/s.
    pub outflow_l_s: f64,
    pub required_storage_m3: f64,
    pub critical_duration_min: f64,
}

pub fn reduced_area(g: &Grid) -> (f64, f64) {
    let hy = derive(g, &Scenario::default());
    let a = g.cell_area();
    let mut total = 0.0;
    let mut red = 0.0;
    for k in 0..g.len() {
        if g.active[k] == 0 {
            continue;
        }
        total += a;
        red += hy.c_normal[k] as f64 * a;
    }
    (total, red)
}

pub fn compute(total_area_m2: f64, reduced_area_m2: f64, inp: &RetentionInput) -> RetentionResult {
    let t = if inp.return_period > 0.0 { inp.return_period } else { 10.0 };
    let cf = if inp.climate_factor > 0.0 { inp.climate_factor } else { 1.0 };
    let sf = if inp.safety_factor > 0.0 { inp.safety_factor } else { 1.2 };
    let d_rat = if inp.rational_duration_min > 0.0 { inp.rational_duration_min } else { 10.0 };
    let q_out = inp.discharge_l_s_ha.max(0.0) * total_area_m2 / 10_000.0 / 1000.0; // m³/s
    let mut best = (0.0, 0.0);
    let mut d = 5.0;
    while d <= 72.0 * 60.0 {
        let i = idf_um_s(d, t) * 1e-6 * cf; // m/s
        let v = (i * reduced_area_m2 - q_out) * d * 60.0;
        if v > best.0 {
            best = (v, d);
        }
        d += if d < 120.0 { 5.0 } else { 30.0 };
    }
    let i_rat = idf_um_s(d_rat, t) * 1e-6 * cf;
    RetentionResult {
        total_area_m2,
        reduced_area_m2,
        mean_c: if total_area_m2 > 0.0 { reduced_area_m2 / total_area_m2 } else { 0.0 },
        peak_flow_l_s: i_rat * reduced_area_m2 * 1000.0,
        outflow_l_s: q_out * 1000.0,
        required_storage_m3: best.0.max(0.0) * sf,
        critical_duration_min: best.1,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn hand_calculation_1ha_sealed() {
        // 1 ha fully sealed, T=10, CF 1.3, 1 l/s/ha → storage ≈ max_d (i·A − Q)·d·1.2
        let r = compute(10_000.0, 10_000.0, &RetentionInput { return_period: 10.0, climate_factor: 1.3, discharge_l_s_ha: 1.0, safety_factor: 1.2, rational_duration_min: 10.0 });
        // hand check at the critical duration
        let d = r.critical_duration_min;
        let i = idf_um_s(d, 10.0) * 1e-6 * 1.3;
        let hand = (i * 10_000.0 - 0.001) * d * 60.0 * 1.2;
        assert!((hand - r.required_storage_m3).abs() < 1e-6);
        assert!(r.required_storage_m3 > 300.0 && r.required_storage_m3 < 1500.0, "{}", r.required_storage_m3);
        assert!(r.peak_flow_l_s > 200.0);
    }
}
