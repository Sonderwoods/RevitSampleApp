//! Per-cell infiltration: modified Horton driven by cumulative infiltration F, an optional sub-base reservoir that
//! drains to the subsoil (permeable paving, porous asphalt, rain-garden media) and an optional cap on F (high
//! groundwater). One kernel, [`infiltrate`], used by the dynamic solver (M2) and by the point-scale model
//! [`point_runoff`] that the tests and `examples/permeability_table.rs` use. See docs/physics-permeability.md.
//!
//! ## Modified Horton
//!
//! Horton's capacity under continuous ponding is `f(t) = fc + (f0 − fc)·e^(−k t)`, with cumulative
//! `F(t) = fc·t + (f0 − fc)/k·(1 − e^(−k t))`. The *modified* form makes capacity a function of F, not of clock time:
//! the state is the equivalent ponding time `tp` with `F(tp) = F`, stored as `E = e^(−k tp)` so that the capacity is
//! `f = fc + (f0 − fc)·E`. Capacity therefore only decays when water actually infiltrates and does not decay while dry.
//!
//! Over a step of length dt the infiltration *capacity* volume is the exact integral of the Horton curve,
//! `ΔF_cap = fc·dt + (f0 − fc)/k·E·(1 − e^(−k dt))`, so a ponded cell follows the analytic F(t) for any dt.
//! When less than that infiltrates (not enough water, sub-base full, cap reached), `tp` advances by the time the
//! Horton curve needs to infiltrate the smaller amount (midpoint estimate, second order in dt).
//!
//! All quantities SI: depths in m, rates in m/s, k in 1/s.

/// Per-cell infiltration parameters (SI).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct CellInf {
    /// Horton long-term capacity fc, m/s.
    pub fc: f32,
    /// Horton initial capacity f0 (moisture adjusted, ≥ fc), m/s.
    pub f0: f32,
    /// Sub-base storage, m (only with `limited`).
    pub store_cap: f32,
    /// Sub-base drainage into the subsoil, m/s (only with `limited`).
    pub drain: f32,
    /// True for an engineered surface on a sub-base: entry is limited by sub-base room + subsoil drainage.
    pub limited: bool,
    /// Maximum cumulative infiltration F, m (`f32::INFINITY` = no cap). High groundwater.
    pub f_cap: f32,
}

/// Per-cell state.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct InfState {
    /// Cumulative infiltration through the surface, m.
    pub f: f32,
    /// e^(−k·tp): Horton state, 1 at F = 0.
    pub e: f32,
    /// Water currently held in the sub-base, m.
    pub store: f32,
}

impl Default for InfState {
    fn default() -> Self {
        InfState { f: 0.0, e: 1.0, store: 0.0 }
    }
}

/// Result of one step for one cell.
#[derive(Clone, Copy, Debug, Default)]
pub struct InfStep {
    /// Water removed from the surface (into soil or sub-base), m.
    pub infiltrated: f32,
    /// Water passed from the sub-base to the subsoil, m (sub-base cells only; already counted in an earlier or this
    /// step's `infiltrated`, so never add it to the mass balance a second time).
    pub drained: f32,
}

/// Cumulative Horton infiltration under continuous ponding for `t` seconds (analytic).
pub fn horton_cumulative(fc: f64, f0: f64, k: f64, t: f64) -> f64 {
    let df = (f0 - fc).max(0.0);
    if k <= 0.0 {
        return f0.max(fc) * t;
    }
    fc * t + df / k * (1.0 - (-k * t).exp())
}

/// Horton capacity f as a function of cumulative infiltration F (modified Horton), by inverting `horton_cumulative`
/// with Newton's method. Reference implementation for tests; the solver carries `E` instead.
pub fn horton_capacity_at(fc: f64, f0: f64, k: f64, f_cum: f64) -> f64 {
    let df = (f0 - fc).max(0.0);
    if df <= 0.0 || k <= 0.0 {
        return f0.max(fc);
    }
    // solve F(t) = f_cum for t ≥ 0; F is increasing and concave, Newton from below converges monotonically.
    let mut t = f_cum / f0.max(1e-300);
    for _ in 0..60 {
        let g = horton_cumulative(fc, f0, k, t) - f_cum;
        let d = fc + df * (-k * t).exp();
        let nt = t - g / d.max(1e-300);
        if (nt - t).abs() <= 1e-12 * (1.0 + t.abs()) {
            t = nt;
            break;
        }
        t = nt;
    }
    fc + df * (-k * t.max(0.0)).exp()
}

/// One infiltration step for one cell.
///
/// * `avail` — water on the surface that may infiltrate this step (ponded depth plus this step's net rain), m.
/// * `dt` — step, s. `k` — Horton decay, 1/s. `ekdt` — `exp(−k·dt)` (precomputed once per step).
///
/// Order inside the step: surface capacity (Horton) → limited by sub-base room + subsoil drainage → limited by the
/// F cap → limited by available water; then the sub-base drains for the full step.
#[inline(always)]
pub fn infiltrate(avail: f32, dt: f32, k: f32, ekdt: f32, p: &CellInf, s: &mut InfState) -> InfStep {
    let mut out = InfStep::default();
    let df = (p.f0 - p.fc).max(0.0);
    let horton = df > 0.0 && k > 0.0;
    if avail > 0.0 && (p.fc > 0.0 || p.f0 > 0.0) {
        // exact Horton capacity over the step from the current state
        let cap = p.fc * dt + if horton { df / k * s.e * (1.0 - ekdt) } else { 0.0 };
        let mut lim = cap;
        if p.limited {
            lim = lim.min((p.store_cap - s.store).max(0.0) + p.drain * dt);
        }
        lim = lim.min((p.f_cap - s.f).max(0.0));
        let inf = lim.min(avail).max(0.0);
        if inf > 0.0 {
            if horton {
                if inf >= cap * (1.0 - 1e-6) {
                    s.e *= ekdt;
                } else {
                    // time the Horton curve needs to infiltrate `inf`, midpoint rate
                    let r0 = p.fc + df * s.e;
                    let tau0 = inf / r0;
                    let rm = p.fc + df * s.e * (-0.5 * k * tau0).exp();
                    let tau = (inf / rm).min(dt);
                    s.e *= (-k * tau).exp();
                }
            }
            s.f += inf;
            if p.limited {
                s.store += inf;
            }
            out.infiltrated = inf;
        }
    }
    if p.limited && s.store > 0.0 {
        let d = (p.drain * dt).min(s.store);
        s.store -= d;
        out.drained = d;
    }
    out
}

/// Point-scale losses without run-on: what one cell does with a rain series when every drop that does not infiltrate
/// runs off at once (sheet flow on a slope). Rain fills the initial-loss bucket first, then infiltrates.
#[derive(Clone, Copy, Debug, Default)]
pub struct PointResult {
    pub rain_mm: f64,
    pub initial_loss_mm: f64,
    pub infiltrated_mm: f64,
    pub runoff_mm: f64,
    /// Sub-base content at the end, mm.
    pub store_end_mm: f64,
    /// Peak sub-base fill, 0..1 (0 without sub-base).
    pub store_peak_fill: f64,
}

/// Runs [`infiltrate`] on one cell. `rain_m_s(t)` gives the intensity at time t; integrates to `t_end` with step `dt`.
pub fn point_runoff(p: &CellInf, ia_m: f64, k: f64, dt: f64, t_end: f64, rain_m_s: impl Fn(f64) -> f64) -> PointResult {
    let mut s = InfState::default();
    let mut ia = ia_m as f32;
    let mut r = PointResult::default();
    let ekdt = (-k * dt).exp() as f32;
    let mut t = 0.0;
    while t < t_end - 1e-9 {
        let step = dt.min(t_end - t);
        let ek = if step == dt { ekdt } else { (-k * step).exp() as f32 };
        let mut w = (rain_m_s(t) * step) as f32;
        r.rain_mm += w as f64 * 1e3;
        let take = w.min(ia).max(0.0);
        ia -= take;
        w -= take;
        r.initial_loss_mm += take as f64 * 1e3;
        let st = infiltrate(w, step as f32, k as f32, ek, p, &mut s);
        r.infiltrated_mm += st.infiltrated as f64 * 1e3;
        r.runoff_mm += (w - st.infiltrated) as f64 * 1e3;
        if p.limited && p.store_cap > 0.0 {
            r.store_peak_fill = r.store_peak_fill.max((s.store / p.store_cap) as f64);
        }
        t += step;
    }
    r.store_end_mm = s.store as f64 * 1e3;
    r
}

#[cfg(test)]
mod tests {
    use super::*;
    const MMH: f64 = 1.0 / 3.6e6;

    fn horton(fc_mmh: f64, f0_mmh: f64) -> CellInf {
        CellInf { fc: (fc_mmh * MMH) as f32, f0: (f0_mmh * MMH) as f32, f_cap: f32::INFINITY, ..Default::default() }
    }

    #[test]
    fn ponded_cumulative_matches_analytic_for_any_dt() {
        // JB6 compacted, dry: fc 9, f0 47 mm/h, k 5/h, unlimited ponded water for 4 h.
        let (fc, f0, k): (f64, f64, f64) = (9.0 * MMH, 47.0 * MMH, 5.0 / 3600.0);
        let p = horton(9.0, 47.0);
        for &dt in &[0.5, 1.0, 5.0, 10.0, 60.0, 600.0] {
            let mut s = InfState::default();
            let ek = (-k * dt).exp() as f32;
            let mut t = 0.0;
            let mut max_rel = 0.0f64;
            while t < 4.0 * 3600.0 - 1e-9 {
                infiltrate(1.0, dt as f32, k as f32, ek, &p, &mut s);
                t += dt;
                let exact = horton_cumulative(fc, f0, k, t);
                max_rel = max_rel.max(((s.f as f64) - exact).abs() / exact);
            }
            // exact per step; what remains is float32 round-off accumulated over 4 h / dt steps
            eprintln!("ponded Horton, dt {dt:>5} s: max relative deviation of F from analytic {max_rel:.2e}");
            assert!(max_rel < 1e-3, "dt {dt}: F deviates {max_rel:e} from the analytic Horton integral");
            // capacity carried in E equals the Newton-inverted capacity at the same F
            let cap_state = p.fc as f64 + (p.f0 - p.fc) as f64 * s.e as f64;
            let cap_ref = horton_capacity_at(fc, f0, k, s.f as f64);
            assert!((cap_state - cap_ref).abs() / cap_ref < 1e-4, "dt {dt}: {cap_state:e} vs {cap_ref:e}");
        }
    }

    #[test]
    fn rain_below_fc_gives_zero_runoff() {
        let p = horton(10.0, 35.0);
        let r = point_runoff(&p, 0.002, 5.0 / 3600.0, 5.0, 4.0 * 3600.0, |_| 9.0 * MMH);
        assert_eq!(r.runoff_mm, 0.0);
        assert!((r.rain_mm - 36.0).abs() < 1e-3);
        assert!((r.initial_loss_mm + r.infiltrated_mm - r.rain_mm).abs() < 1e-3);
    }

    #[test]
    fn capacity_does_not_decay_while_dry() {
        // 10 mm/h for 30 min, dry for 2 h, then ponded: capacity must resume where F left it.
        let (k, dt): (f64, f64) = (5.0 / 3600.0, 5.0);
        let p = horton(9.0, 47.0);
        let mut s = InfState::default();
        let ek = (-k * dt).exp() as f32;
        for _ in 0..360 {
            infiltrate((10.0 * MMH * dt) as f32, dt as f32, k as f32, ek, &p, &mut s);
        }
        let (f1, e1) = (s.f, s.e);
        for _ in 0..1440 {
            infiltrate(0.0, dt as f32, k as f32, ek, &p, &mut s);
        }
        assert_eq!((s.f, s.e), (f1, e1));
        let cap_ref = horton_capacity_at(9.0 * MMH, 47.0 * MMH, k, f1 as f64);
        let cap = p.fc as f64 + (p.f0 - p.fc) as f64 * e1 as f64;
        assert!((cap - cap_ref).abs() / cap_ref < 2e-3, "{cap:e} vs {cap_ref:e}");
    }

    #[test]
    fn water_limited_converges_with_dt_halving() {
        // CDS-like triangular rain peaking at 120 mm/h, dry JB6 compacted: alternately water- and capacity-limited.
        let p = horton(9.0, 47.0);
        let rain = |t: f64| {
            let x = t / 7200.0;
            (if x < 0.4 { x / 0.4 } else { (1.0 - x) / 0.6 }).max(0.0) * 120.0 * MMH
        };
        let runs: Vec<f64> = [20.0, 10.0, 5.0, 2.5, 1.25].iter().map(|&dt| point_runoff(&p, 0.004, 5.0 / 3600.0, dt, 7200.0, rain).runoff_mm).collect();
        let diffs: Vec<f64> = runs.windows(2).map(|w| (w[0] - w[1]).abs()).collect();
        eprintln!("point runoff (mm) for dt 20, 10, 5, 2.5, 1.25 s: {runs:?}");
        for w in diffs.windows(2) {
            assert!(w[1] <= w[0] * 0.75 + 1e-4, "not converging: {runs:?}");
        }
        assert!(diffs.last().unwrap() < &0.01, "{runs:?}");
    }

    #[test]
    fn subbase_fills_then_limits_to_subsoil_rate() {
        // permeable paving: surface 250 mm/h, 45 mm sub-base on heavy clay draining 0.5 mm/h; 100 mm in 1 h.
        let p = CellInf { fc: (250.0 * MMH) as f32, f0: (875.0 * MMH) as f32, store_cap: 0.045, drain: (0.5 * MMH) as f32, limited: true, f_cap: f32::INFINITY };
        let r = point_runoff(&p, 0.003, 5.0 / 3600.0, 1.0, 3600.0, |_| 100.0 * MMH);
        // accepted = storage + drainage from the moment water first reaches the sub-base (after Ia, t = 3/100 h)
        let expect_inf = 45.0 + 0.5 * (1.0 - 0.03);
        assert!((r.infiltrated_mm - expect_inf).abs() < 0.02, "{r:?}");
        assert!((r.runoff_mm - (100.0 - 3.0 - expect_inf)).abs() < 0.02, "{r:?}");
        assert!(r.store_peak_fill > 0.999);
        // same paving on coarse sand (30 mm/h drainage), 60 mm/h: the sub-base never fills, no runoff
        let p2 = CellInf { drain: (30.0 * MMH) as f32, ..p };
        let r2 = point_runoff(&p2, 0.003, 5.0 / 3600.0, 1.0, 3600.0, |_| 60.0 * MMH);
        assert_eq!(r2.runoff_mm, 0.0);
        assert!(r2.store_peak_fill < 0.7, "{r2:?}");
    }

    #[test]
    fn infiltration_cap_is_exact() {
        let p = CellInf { f_cap: 0.005, ..horton(25.0, 100.0) };
        let r = point_runoff(&p, 0.0, 5.0 / 3600.0, 5.0, 3600.0, |_| 30.0 * MMH);
        assert!((r.infiltrated_mm - 5.0).abs() < 1e-4, "{r:?}");
        assert!((r.runoff_mm - 25.0).abs() < 1e-3);
    }
}
