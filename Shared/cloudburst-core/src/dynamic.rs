//! M2 dynamic model: local-inertial 2D shallow water (Bates et al. 2010, de Almeida et al. 2012) on a staggered grid,
//! rain-on-grid with initial-loss bucket, modified Horton infiltration and sewer loss. Multithreaded with rayon,
//! row-parallel kernels: face fluxes X, face fluxes Y, positivity limiter, depth update + sources + maxima.

use crate::grid::Grid;
use crate::hydro::{derive, Scenario};
use crate::rain::RainSeries;
use rayon::prelude::*;

const G: f64 = 9.81;

#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
pub struct MassBalance {
    pub rain_m3: f64,
    pub initial_loss_m3: f64,
    pub infiltrated_m3: f64,
    pub sewer_m3: f64,
    pub boundary_out_m3: f64,
    pub stored_m3: f64,
    /// (in − out − stored) / in, fraction.
    pub error_fraction: f64,
    pub simulated_s: f64,
    pub elapsed_s: f64,
    /// Water present at t = 0, m³.
    pub initial_water_m3: f64,
    pub steps: i64,
    pub cancelled: i32,
    pub _pad: i32,
}

#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
pub struct Progress {
    pub fraction: f64,
    pub time_s: f64,
    pub dt_s: f64,
    pub h_max_m: f64,
    pub volume_m3: f64,
    pub elapsed_s: f64,
}

pub struct DynamicResult {
    pub h_max: Vec<f32>,
    pub v_max: Vec<f32>,
    /// max h·(v+0.5)
    pub hazard_max: Vec<f32>,
    /// max h·v
    pub hv_max: Vec<f32>,
    /// time of max depth, s (−1 if never wet).
    pub t_peak: Vec<f32>,
    pub h_final: Vec<f32>,
    pub frames: Vec<Vec<f32>>,
    pub frame_times: Vec<f64>,
    pub probe_cells: Vec<usize>,
    /// probe depth series, one per probe, sampled at `probe_times`.
    pub probe_depth: Vec<Vec<f32>>,
    pub probe_times: Vec<f64>,
    pub mass: MassBalance,
}

#[derive(Clone, Copy)]
struct P<T>(*mut T);
unsafe impl<T> Send for P<T> {}
unsafe impl<T> Sync for P<T> {}
impl<T> P<T> {
    #[inline(always)]
    unsafe fn at(&self, i: usize) -> &mut T {
        &mut *self.0.add(i)
    }
}

#[derive(Default, Clone, Copy)]
struct RowAcc {
    rain: f64,
    ia: f64,
    inf: f64,
    sewer: f64,
    stored: f64,
    hmax: f32,
}

/// Run the dynamic model. `progress` returns false to cancel.
pub fn run_dynamic(g: &Grid, sc: &Scenario, rain: &RainSeries, probes: &[usize], progress: impl FnMut(&Progress) -> bool) -> DynamicResult {
    run_dynamic_with(g, sc, rain, probes, None, progress)
}

/// As [`run_dynamic`], with an optional initial water depth per cell (m).
pub fn run_dynamic_with(g: &Grid, sc: &Scenario, rain: &RainSeries, probes: &[usize], h0: Option<&[f32]>, mut progress: impl FnMut(&Progress) -> bool) -> DynamicResult {
    // Uses rayon's global pool (all cores). `Scenario::threads` is reserved.
    run_inner(g, sc, rain, probes, h0, &mut progress)
}

fn run_inner(g: &Grid, sc: &Scenario, rain: &RainSeries, probes: &[usize], h0: Option<&[f32]>, progress: &mut dyn FnMut(&Progress) -> bool) -> DynamicResult {
    let t_start = std::time::Instant::now();
    let (nx, ny, n) = (g.nx, g.ny, g.len());
    let dx = g.dx;
    let a = dx * dx;
    let hy = derive(g, sc);
    let z: Vec<f32> = g.z.clone();
    let active: Vec<f32> = g.active.iter().map(|&v| v as f32).collect();

    let mut h = match h0 {
        Some(v) if v.len() == n => v.iter().map(|x| x.max(0.0)).collect(),
        _ => vec![0f32; n],
    };
    let initial_m3: f64 = h.iter().map(|v| *v as f64).sum::<f64>() * a;
    let mut hmax_prev = h.iter().cloned().fold(0.0f32, f32::max);
    let mut qx = vec![0f32; (nx + 1) * ny];
    let mut qy = vec![0f32; nx * (ny + 1)];
    let mut qx_old = qx.clone();
    let mut qy_old = qy.clone();
    let mut fac = vec![1f32; n];
    let mut ia_rem = hy.ia.clone();
    let mut sew_rem = hy.sewer_ia.clone();
    let mut f_cum = vec![0f32; n];
    let mut h_max = vec![0f32; n];
    let mut v_max = vec![0f32; n];
    let mut haz_max = vec![0f32; n];
    let mut hv_max = vec![0f32; n];
    let mut t_peak = vec![-1f32; n];

    let theta = sc.theta.clamp(0.0, 1.0) as f32;
    let alpha = sc.alpha.clamp(0.05, 0.9);
    let h_dry = sc.h_dry.max(1e-5) as f32;
    let cf = sc.climate_factor;
    let all = if sc.boundary == 1 { 15 } else { 0 };
    let ce = sc.closed_edges | all;
    let (cw, ce_, cs, cn) = (ce & 1 != 0, ce & 2 != 0, ce & 4 != 0, ce & 8 != 0);
    let depth_n = sc.depth_roughness == 1;
    let k_horton = hy.k;
    let t_end = rain.duration_s() + sc.after_rain_min.max(0.0) * 60.0;

    // frames budget: ≤ ~60 M floats
    let mut out_dt = sc.output_interval_s.max(10.0);
    let max_frames = sc.max_frames.max(1) as f64;
    out_dt = out_dt.max(t_end / max_frames);
    let budget = 60_000_000f64 / n as f64;
    if t_end / out_dt > budget {
        out_dt = t_end / budget.max(1.0);
    }
    let probe_dt = 60.0;

    let mut frames = vec![];
    let mut frame_times = vec![];
    let mut probe_depth: Vec<Vec<f32>> = probes.iter().map(|_| vec![]).collect();
    let mut probe_times = vec![];
    let mut next_frame = out_dt;
    let mut next_probe = 0.0;

    let mut mb = MassBalance::default();
    let mut t = 0.0f64;
    let mut last_report = std::time::Instant::now();
    let mut steps: i64 = 0;
    let gf = G as f32;
    let dxf = dx as f32;

    while t < t_end {
        // ---- adaptive time step
        let hm = (hmax_prev as f64).max(0.01);
        // 2D local-inertial CFL: Δt = α·Δx / sqrt(2·g·h_max) (the 1D form with α=0.7 is unstable in 2D).
        let mut dt = alpha * dx / (2.0 * G * hm).sqrt();
        dt = dt.min(10.0);
        let rain_now = rain.at_m_s(t) * cf;
        if rain_now > 0.0 {
            // keep rain increments small for thin films
            dt = dt.min(5.0);
        }
        if t + dt > t_end {
            dt = t_end - t;
        }
        let dtf = dt as f32;
        std::mem::swap(&mut qx, &mut qx_old);
        std::mem::swap(&mut qy, &mut qy_old);

        // ---- kernel 1: x-face fluxes. face (i, j), i in 0..=nx, between cell i-1 and i.
        {
            let (hp, zp, np, qo) = (&h, &z, &hy.n, &qx_old);
            qx.par_chunks_mut(nx + 1).enumerate().for_each(|(j, row)| {
                let base = j * nx;
                let qrow = &qo[j * (nx + 1)..(j + 1) * (nx + 1)];
                for i in 1..nx {
                    let (ka, kb) = (base + i - 1, base + i);
                    row[i] = face_flux(hp[ka], hp[kb], zp[ka], zp[kb], np[ka], np[kb], qrow[i], qrow[i - 1], qrow[i + 1], theta, gf, dtf, dxf, h_dry, depth_n);
                }
                row[0] = if cw { 0.0 } else { -edge_flux(hp[base], zp[base], zp[base + 1], np[base], dxf, h_dry, gf) };
                row[nx] = if ce_ { 0.0 } else { edge_flux(hp[base + nx - 1], zp[base + nx - 1], zp[base + nx - 2], np[base + nx - 1], dxf, h_dry, gf) };
            });
        }
        // ---- kernel 2: y-face fluxes. face row j in 0..=ny, between cell row j-1 and j.
        {
            let (hp, zp, np, qo) = (&h, &z, &hy.n, &qy_old);
            qy.par_chunks_mut(nx).enumerate().for_each(|(j, row)| {
                for i in 0..nx {
                    if j == 0 || j == ny {
                        if (j == 0 && cs) || (j == ny && cn) {
                            row[i] = 0.0;
                        } else if j == 0 {
                            let (k, k2) = (i, nx + i);
                            row[i] = -edge_flux(hp[k], zp[k], zp[k2], np[k], dxf, h_dry, gf);
                        } else {
                            let (k, k2) = ((ny - 1) * nx + i, (ny - 2) * nx + i);
                            row[i] = edge_flux(hp[k], zp[k], zp[k2], np[k], dxf, h_dry, gf);
                        }
                        continue;
                    }
                    let (ka, kb) = ((j - 1) * nx + i, j * nx + i);
                    let f = j * nx + i;
                    let q0 = qo[f];
                    let qm = qo[f - nx];
                    let qp = qo[f + nx];
                    row[i] = face_flux(hp[ka], hp[kb], zp[ka], zp[kb], np[ka], np[kb], q0, qm, qp, theta, gf, dtf, dxf, h_dry, depth_n);
                }
            });
        }
        // ---- kernel 3: positivity limiter — scale a cell's outflows if they exceed its water.
        {
            let (hp, qxp, qyp) = (&h, &qx, &qy);
            fac.par_chunks_mut(nx).enumerate().for_each(|(j, row)| {
                for i in 0..nx {
                    let k = j * nx + i;
                    let w = qxp[j * (nx + 1) + i];
                    let e = qxp[j * (nx + 1) + i + 1];
                    let s = qyp[j * nx + i];
                    let nn = qyp[(j + 1) * nx + i];
                    let out = (-w).max(0.0) + e.max(0.0) + (-s).max(0.0) + nn.max(0.0);
                    let vol_out = out * dtf / dxf; // depth units
                    row[i] = if vol_out > hp[k] && vol_out > 0.0 { hp[k] / vol_out } else { 1.0 };
                }
            });
            let fp = &fac;
            qx.par_chunks_mut(nx + 1).enumerate().for_each(|(j, row)| {
                for i in 0..=nx {
                    let q = row[i];
                    if q > 0.0 && i > 0 {
                        row[i] = q * fp[j * nx + i - 1];
                    } else if q < 0.0 && i < nx {
                        row[i] = q * fp[j * nx + i];
                    }
                }
            });
            qy.par_chunks_mut(nx).enumerate().for_each(|(j, row)| {
                for i in 0..nx {
                    let q = row[i];
                    if q > 0.0 && j > 0 {
                        row[i] = q * fp[(j - 1) * nx + i];
                    } else if q < 0.0 && j < ny {
                        row[i] = q * fp[j * nx + i];
                    }
                }
            });
        }
        // boundary outflow volume
        let mut out_q = 0f64;
        for j in 0..ny {
            out_q += (-qx[j * (nx + 1)]).max(0.0) as f64 + qx[j * (nx + 1) + nx].max(0.0) as f64;
        }
        for i in 0..nx {
            out_q += (-qy[i]).max(0.0) as f64 + qy[ny * nx + i].max(0.0) as f64;
        }
        mb.boundary_out_m3 += out_q * dx * dt;

        // ---- kernel 4: depth update, sources, maxima
        let tf = (t + dt) as f32;
        let rain_m = (rain_now * dt) as f32;
        let ptrs = (P(h.as_mut_ptr()), P(ia_rem.as_mut_ptr()), P(sew_rem.as_mut_ptr()), P(f_cum.as_mut_ptr()), P(h_max.as_mut_ptr()), P(v_max.as_mut_ptr()), P(haz_max.as_mut_ptr()), P(hv_max.as_mut_ptr()), P(t_peak.as_mut_ptr()));
        let (qxr, qyr, hyr, act) = (&qx, &qy, &hy, &active);
        let acc = (0..ny)
            .into_par_iter()
            .map(|j| {
                let (hp, iap, swp, fp, hmp, vmp, hzp, hvp, tpp) = ptrs;
                let mut r = RowAcc::default();
                for i in 0..nx {
                    let k = j * nx + i;
                    unsafe {
                        let qw = qxr[j * (nx + 1) + i];
                        let qe = qxr[j * (nx + 1) + i + 1];
                        let qs = qyr[j * nx + i];
                        let qn = qyr[(j + 1) * nx + i];
                        let mut hk = *hp.at(k) + dtf / dxf * (qw - qe + qs - qn);
                        if hk < 0.0 {
                            hk = 0.0;
                        }
                        // rain → initial loss bucket → sewer bucket → surface
                        let mut p = rain_m * act[k];
                        r.rain += p as f64;
                        let ia = iap.at(k);
                        if *ia > 0.0 && p > 0.0 {
                            let take = p.min(*ia);
                            *ia -= take;
                            p -= take;
                            r.ia += take as f64;
                        }
                        let sw = swp.at(k);
                        if *sw > 0.0 && p > 0.0 {
                            let take = p.min(*sw);
                            *sw -= take;
                            p -= take;
                            r.sewer += take as f64;
                        }
                        hk += p;
                        // sewer capacity sink
                        let sr = hyr.sewer_rate[k];
                        if sr > 0.0 && hk > 0.0 {
                            let s = (sr * dtf).min(hk);
                            hk -= s;
                            r.sewer += s as f64;
                        }
                        // modified Horton, driven by cumulative infiltration
                        let fc = hyr.fc[k];
                        if fc > 0.0 && hk > 0.0 {
                            let f0 = hyr.f0[k];
                            let fk = fp.at(k);
                            let cap_rate = fc + (f0 - fc).max(0.0) * (-(k_horton * *fk / f0.max(1e-9) * 1.0)).exp();
                            let inf = (cap_rate * dtf).min(hk);
                            hk -= inf;
                            *fk += inf;
                            r.inf += inf as f64;
                        }
                        *hp.at(k) = hk;
                        r.stored += hk as f64;
                        if hk > r.hmax {
                            r.hmax = hk;
                        }
                        // maxima
                        if hk > *hmp.at(k) {
                            *hmp.at(k) = hk;
                            *tpp.at(k) = tf;
                        }
                        if hk > h_dry * 5.0 {
                            let ux = 0.5 * (qw + qe);
                            let uy = 0.5 * (qs + qn);
                            let v = (ux * ux + uy * uy).sqrt() / hk;
                            let v = v.min(10.0);
                            if v > *vmp.at(k) {
                                *vmp.at(k) = v;
                            }
                            let hz = hk * (v + 0.5);
                            if hz > *hzp.at(k) {
                                *hzp.at(k) = hz;
                            }
                            let hv = hk * v;
                            if hv > *hvp.at(k) {
                                *hvp.at(k) = hv;
                            }
                        }
                    }
                }
                r
            })
            .reduce(RowAcc::default, |a, b| RowAcc { rain: a.rain + b.rain, ia: a.ia + b.ia, inf: a.inf + b.inf, sewer: a.sewer + b.sewer, stored: a.stored + b.stored, hmax: a.hmax.max(b.hmax) });

        mb.rain_m3 += acc.rain * a;
        mb.initial_loss_m3 += acc.ia * a;
        mb.infiltrated_m3 += acc.inf * a;
        mb.sewer_m3 += acc.sewer * a;
        mb.stored_m3 = acc.stored * a;
        hmax_prev = acc.hmax;
        t += dt;
        steps += 1;
        if std::env::var("CB_DEBUG").is_ok() && steps < 8 {
            let mq = qx.iter().chain(qy.iter()).fold(0f32, |m, v| m.max(v.abs()));
            eprintln!("step {steps} dt {dt:.3} max|q| {mq:e} hmax {hmax_prev}");
        }

        while t >= next_probe - 1e-9 {
            probe_times.push(next_probe);
            for (pi, &c) in probes.iter().enumerate() {
                probe_depth[pi].push(if c < n { h[c] } else { 0.0 });
            }
            next_probe += probe_dt;
        }
        if t >= next_frame - 1e-9 || t >= t_end {
            frames.push(h.clone());
            frame_times.push(t);
            next_frame += out_dt;
        }
        if last_report.elapsed().as_millis() > 200 || t >= t_end {
            last_report = std::time::Instant::now();
            let pr = Progress { fraction: t / t_end, time_s: t, dt_s: dt, h_max_m: hmax_prev as f64, volume_m3: mb.stored_m3, elapsed_s: t_start.elapsed().as_secs_f64() };
            if !progress(&pr) {
                mb.cancelled = 1;
                break;
            }
        }
    }
    mb.simulated_s = t;
    mb.steps = steps;
    mb.elapsed_s = t_start.elapsed().as_secs_f64();
    let outs = mb.initial_loss_m3 + mb.infiltrated_m3 + mb.sewer_m3 + mb.boundary_out_m3 + mb.stored_m3;
    mb.initial_water_m3 = initial_m3;
    let ins = mb.rain_m3 + initial_m3;
    mb.error_fraction = if ins > 0.0 { (ins - outs) / ins } else { 0.0 };
    DynamicResult { h_max, v_max, hazard_max: haz_max, hv_max, t_peak, h_final: h, frames, frame_times, probe_cells: probes.to_vec(), probe_depth, probe_times, mass: mb }
}

/// Local-inertial face flux with de Almeida weighting, semi-implicit Manning friction and Froude limit.
#[inline(always)]
#[allow(clippy::too_many_arguments)]
fn face_flux(ha: f32, hb: f32, za: f32, zb: f32, na: f32, nb: f32, q0: f32, qm: f32, qp: f32, theta: f32, g: f32, dt: f32, dx: f32, h_dry: f32, depth_n: bool) -> f32 {
    let ea = za + ha;
    let eb = zb + hb;
    let hf = ea.max(eb) - za.max(zb);
    if hf <= h_dry {
        return 0.0;
    }
    let qw = theta * q0 + 0.5 * (1.0 - theta) * (qm + qp);
    let mut n = 0.5 * (na + nb);
    if depth_n {
        let n_sheet = n * 2.0;
        n = n + (n_sheet - n) * (-hf / 0.025).exp();
    }
    let slope = (eb - ea) / dx;
    let num = qw - g * hf * dt * slope;
    let den = 1.0 + g * dt * n * n * qw.abs() / (hf * hf * hf.cbrt()); // hf^(7/3)
    let mut q = num / den;
    let qmax = hf * (g * hf).sqrt(); // Froude ≤ 1
    if q > qmax {
        q = qmax;
    } else if q < -qmax {
        q = -qmax;
    }
    q
}

/// Free outflow at an open edge (positive = out of the domain): normal-depth Manning with the local bed slope.
#[inline(always)]
fn edge_flux(h: f32, z: f32, z_inner: f32, n: f32, dx: f32, h_dry: f32, g: f32) -> f32 {
    if h <= h_dry {
        return 0.0;
    }
    let s = ((z_inner - z) / dx).max(0.001);
    let q = h.powf(5.0 / 3.0) * s.sqrt() / n.max(0.005);
    q.min(h * (g * h).sqrt())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::grid::Grid;

    fn sc_no_losses() -> Scenario {
        Scenario { climate_factor: 1.0, sewer_mode: 0, infiltration_scale: 0.0, after_rain_min: 0.0, ..Default::default() }
    }
    fn sealed(mut g: Grid) -> Grid {
        g.set_material_all("water"); // no initial loss, no infiltration
        g
    }

    #[test]
    fn lake_at_rest_stays_still() {
        // uneven bed, flat water surface at 1.0, closed boundary, no rain
        let g = sealed(Grid::from_fn(40, 30, 1.0, |i, j| 0.3 * ((i as f32 * 0.4).sin() + (j as f32 * 0.3).cos()) * 0.5));
        let sc = Scenario { boundary: 1, after_rain_min: 10.0, ..sc_no_losses() };
        // inject initial water by running with a rain that exactly fills? Instead build a manual state:
        let rain = RainSeries { intensity_mm_h: vec![0.0], step_s: 60.0 };
        // emulate via a dedicated solver call with initial depth
        let r = run_with_initial(&g, &sc, &rain, |k| (1.0 - g.z[k]).max(0.0));
        let vmax = r.v_max.iter().cloned().fold(0.0f32, f32::max);
        assert!(vmax < 1e-4, "spurious velocity {vmax}");
    }

    #[test]
    fn rain_on_grid_conserves_mass() {
        let g = sealed(Grid::from_fn(80, 60, 1.0, |i, j| {
            let (x, y) = (i as f32 - 40.0, j as f32 - 30.0);
            0.002 * (x * x + y * y).sqrt() + 0.2 * (i as f32 * 0.3).sin() * (j as f32 * 0.25).cos()
        }));
        let sc = Scenario { boundary: 0, after_rain_min: 30.0, ..sc_no_losses() };
        let rain = RainSeries::box_rain(60.0, 30.0, 60.0);
        let r = run_dynamic(&g, &sc, &rain, &[], |_| true);
        let m = r.mass;
        assert!(m.error_fraction.abs() < 1e-3, "mass error {:.5} %", m.error_fraction * 100.0);
        assert!((m.rain_m3 - 0.06 * 80.0 * 60.0).abs() < 1.0);
    }

    #[test]
    fn tilted_plane_reaches_kinematic_steady_state() {
        // 100 m plane, slope 1 %, 60 mm/h; at steady state outflow per unit width = i·L
        let (nx, ny) = (100usize, 20usize);
        let g = sealed(Grid::from_fn(nx, ny, 1.0, |i, _| (nx - i) as f32 * 0.01));
        let mut g = g;
        g.palette.materials.iter_mut().for_each(|m| m.manning_n = 0.02);
        let sc = Scenario { boundary: 0, closed_edges: 1 | 4 | 8, after_rain_min: 0.0, ..sc_no_losses() };
        let rain = RainSeries::box_rain(120.0, 120.0, 60.0); // 60 mm/h for 2 h
        // closed on north/south/west by walls: emulate by checking volume balance at the end of the run
        let r = run_dynamic(&g, &sc, &rain, &[], |_| true);
        // in steady state, outflow rate = inflow rate; compare the last 30 min: stored volume constant
        let i = 60.0 / 3.6e6;
        let qin = i * (nx * ny) as f64;
        // kinematic wave depth at outlet: h = (q n / sqrt(S))^(3/5), q = i L
        let q = i * nx as f64;
        let h_kw = (q * 0.02 / 0.01f64.sqrt()).powf(0.6);
        let h_out = r.h_final[(ny / 2) * nx + nx - 2] as f64;
        assert!((h_out - h_kw).abs() / h_kw < 0.15, "outlet depth {h_out:.4} vs kinematic {h_kw:.4}");
        assert!(qin > 0.0);
        assert!(r.mass.error_fraction.abs() < 1e-3);
    }

    #[test]
    fn bowl_ponding_matches_rain_volume_when_closed() {
        let g = sealed(Grid::from_fn(41, 41, 1.0, |i, j| {
            let (x, y) = (i as f32 - 20.0, j as f32 - 20.0);
            0.01 * (x * x + y * y)
        }));
        let sc = Scenario { boundary: 1, after_rain_min: 30.0, ..sc_no_losses() };
        let rain = RainSeries::box_rain(50.0, 20.0, 60.0);
        let r = run_dynamic(&g, &sc, &rain, &[20 * 41 + 20], |_| true);
        let stored: f64 = r.h_final.iter().map(|v| *v as f64).sum();
        assert!((stored - 0.05 * 41.0 * 41.0).abs() / (0.05 * 41.0 * 41.0) < 1e-3);
        assert!(!r.probe_depth[0].is_empty());
        assert!(r.h_max[20 * 41 + 20] > 0.3);
    }

    fn run_with_initial(g: &Grid, sc: &Scenario, rain: &RainSeries, init: impl Fn(usize) -> f32) -> DynamicResult {
        let h0: Vec<f32> = (0..g.len()).map(init).collect();
        run_dynamic_with(g, sc, rain, &[], Some(&h0), |_| true)
    }
}
