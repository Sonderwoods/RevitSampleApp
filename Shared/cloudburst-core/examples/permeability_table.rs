//! Instant (M1) vs dynamic (M2) loss model per material, at point scale (no run-on, no sewer).
//! `cargo run --release --example permeability_table` prints the Markdown table quoted in docs/physics-permeability.md.
//!
//! M1 effective coefficient: min(C·P, P − Ia) / P (`instant::effective_rain`, what the instant model applies).
//! M2 point runoff fraction: one cell running the solver's own loss kernel (`infiltration::point_runoff`) with the
//! parameters `hydro::derive` gives it; every drop that does not infiltrate runs off at once.

use cloudburst_core::grid::Grid;
use cloudburst_core::hydro::{derive, Scenario};
use cloudburst_core::infiltration::{point_runoff, CellInf};
use cloudburst_core::instant::effective_rain;
use cloudburst_core::palette::soil;
use cloudburst_core::RainSeries;

fn main() {
    let cf = 1.4;
    let rain = RainSeries::cds(100.0, 240.0, 59.0, 60.0, 0.5);
    let p_mm = rain.depth_mm() * cf;
    println!("Rain: T = 100 CDS, 4 h, {:.1} mm (59 mm × 1.4), peak {:.0} mm/h. M2 dt = 5 s, run to 6 h.\n", p_mm, rain.peak_mm_h() * cf);
    println!("| Material | JB | M1 min(C·P, P−Ia)/P | M2 dry | M2 moist | M2 wet | M2 moist infiltrated (mm) | sub-base peak fill (moist) |");
    println!("| --- | --- | --- | --- | --- | --- | --- | --- |");
    let base = Grid::from_fn(1, 1, 1.0, |_, _| 0.0);
    for m in &base.palette.materials {
        for jb in [2u8, 7u8] {
            let mut g = base.clone();
            g.set_material_all(&m.id);
            g.soil[0] = jb;
            let mut frac = [0.0; 3];
            let mut inf_moist = 0.0;
            let mut fill = 0.0;
            let mut ia = 0.0;
            for moisture in 0..3 {
                let h = derive(&g, &Scenario { sewer_mode: 0, moisture, climate_factor: cf, ..Default::default() });
                let c = CellInf { fc: h.fc[0], f0: h.f0[0], store_cap: h.store_cap[0], drain: h.drain[0], limited: h.limited[0] != 0, f_cap: h.f_cap[0] };
                let r = point_runoff(&c, h.ia[0] as f64, h.k as f64, 5.0, 6.0 * 3600.0, |t| rain.at_m_s(t) * cf);
                frac[moisture as usize] = r.runoff_mm / r.rain_mm;
                if moisture == 1 {
                    inf_moist = r.infiltrated_mm;
                    fill = r.store_peak_fill;
                    ia = h.ia[0] as f64 * 1e3;
                }
            }
            let m1 = effective_rain(p_mm, m.c_cloudburst(soil(jb).clay), ia, 0.0) / p_mm;
            let fill_s = if !m.subsoil_limited { "–".into() } else if m.storage_mm > 0.0 { format!("{:.0} %", fill * 100.0) } else { "no storage".into() };
            println!("| {} | {} | {:.2} | {:.2} | {:.2} | {:.2} | {:.1} | {} |", m.name, jb, m1, frac[0], frac[1], frac[2], inf_moist, fill_s);
        }
    }
}
