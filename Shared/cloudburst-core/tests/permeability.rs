//! Permeability physics against closed-form answers, mass balance with infiltration on, and tables pinned to their
//! other copies (PRD soil table, .NET palette class). See docs/physics-permeability.md.

use cloudburst_core::grid::Grid;
use cloudburst_core::hydro::{derive, Scenario};
use cloudburst_core::infiltration::{horton_cumulative, point_runoff, CellInf};
use cloudburst_core::instant::effective_rain;
use cloudburst_core::palette::{soil, Palette, HORTON_K_PER_HOUR, SOILS};
use cloudburst_core::{run_dynamic, RainSeries};
use std::path::PathBuf;

fn sc(moisture: i32) -> Scenario {
    Scenario { climate_factor: 1.0, sewer_mode: 0, moisture, boundary: 1, after_rain_min: 0.0, infiltration_scale: 1.0, ..Default::default() }
}

/// Flat, closed 8×8 grid of one material whose infiltration is `f` mm/h (f0 = 3.5 f) with initial loss `ia` mm.
fn flat_with(f: f64, ia: f64) -> Grid {
    let mut g = Grid::from_fn(8, 8, 1.0, |_, _| 0.0);
    g.set_material_all("gravel_compacted");
    let i = g.palette.index_of("gravel_compacted").unwrap();
    let m = &mut g.palette.materials[i];
    m.infiltration_sand = f;
    m.infiltration_clay = f;
    m.initial_loss_mm = ia;
    m.storage_mm = 0.0;
    m.use_soil_table = false;
    m.subsoil_limited = false;
    g
}

fn mean_depth_mm(v: &[f32]) -> f64 {
    v.iter().map(|x| *x as f64).sum::<f64>() / v.len() as f64 * 1e3
}

#[test]
fn rain_below_fc_never_ponds() {
    // 10 mm/h on a surface with fc 10, f0 35 mm/h (dry) for 2 h: everything past Ia infiltrates.
    let g = flat_with(10.0, 2.0);
    let r = run_dynamic(&g, &sc(0), &RainSeries::box_rain(18.0, 120.0, 60.0), &[], |_| true);
    assert!(r.h_max.iter().all(|&h| h < 1e-6), "max ponding {} m", r.h_max.iter().cloned().fold(0.0, f32::max));
    let n = g.len() as f64;
    assert!((r.mass.infiltrated_m3 / n * 1e3 - 16.0).abs() < 0.01, "{:?}", r.mass);
}

#[test]
fn ponding_above_fc_matches_closed_form_wet() {
    // Wet soil: capacity is fc = 10 mm/h from the start. 40 mm/h for 1 h, Ia 2 mm (filled after 3 min).
    // h(T) = i·T − Ia − fc·(T − Ia/i) = 40 − 2 − 10·0.95 = 28.5 mm.
    let g = flat_with(10.0, 2.0);
    let r = run_dynamic(&g, &sc(2), &RainSeries::box_rain(40.0, 60.0, 60.0), &[], |_| true);
    let h = mean_depth_mm(&r.h_final);
    assert!((h - 28.5).abs() < 0.05, "ponded {h:.3} mm, expected 28.5");
    assert!(r.mass.error_fraction.abs() < 1e-5, "{:?}", r.mass);
}

#[test]
fn ponding_above_f0_matches_horton_integral_dry() {
    // Dry soil: f0 = 35, fc = 10 mm/h, k = 5/h; i = 40 mm/h > f0 so the cell is ponded once Ia is full and
    // F follows the analytic Horton integral: h(T) = i·T − Ia − F_H(T − Ia/i).
    let g = flat_with(10.0, 2.0);
    let r = run_dynamic(&g, &sc(0), &RainSeries::box_rain(40.0, 60.0, 60.0), &[], |_| true);
    let k = HORTON_K_PER_HOUR;
    let f_h = horton_cumulative(10.0, 35.0, k, 0.95); // mm with t in hours
    let expect = 38.0 - f_h;
    let h = mean_depth_mm(&r.h_final);
    assert!((h - expect).abs() < 0.05, "ponded {h:.3} mm, expected {expect:.3}");
    let inf = r.infiltrated.iter().map(|v| *v as f64).sum::<f64>() / g.len() as f64 * 1e3;
    assert!((inf - f_h).abs() < 0.05, "F {inf:.3} mm vs analytic {f_h:.3}");
}

#[test]
fn permeable_paving_subbase_fills_on_heavy_clay() {
    // Permeable pavers (surface 250 mm/h, Ia 3 mm, 45 mm sub-base) on JB8 compacted (subsoil 0.5 mm/h).
    // 100 mm in 1 h: accepted = 45 + 0.5·(1 − 0.03) mm, the rest ponds.
    let mut g = Grid::from_fn(8, 8, 1.0, |_, _| 0.0);
    g.set_material_all("permeable_pavers");
    g.soil.iter_mut().for_each(|s| *s = 8);
    let r = run_dynamic(&g, &sc(1), &RainSeries::box_rain(100.0, 60.0, 60.0), &[], |_| true);
    let expect = 100.0 - 3.0 - 45.0 - 0.5 * 0.97;
    let h = mean_depth_mm(&r.h_final);
    assert!((h - expect).abs() < 0.1, "ponded {h:.3} mm, expected {expect:.3}");
    let p = r.permeability;
    assert_eq!(p.subbase_cells, 64);
    assert_eq!(p.subbase_full_cells, 64);
    assert!((p.subbase_capacity_m3 - 64.0 * 0.045).abs() < 1e-6);
    assert!((p.subbase_stored_m3 + p.subbase_drained_m3 - p.infiltrated_m3).abs() < 1e-4, "{p:?}");
    assert!(r.mass.error_fraction.abs() < 1e-5);
}

#[test]
fn permeable_paving_on_sand_does_not_fill() {
    // Same paving on JB1 compacted (subsoil 30 mm/h), 60 mm in 1 h: room never runs out, nothing ponds.
    let mut g = Grid::from_fn(8, 8, 1.0, |_, _| 0.0);
    g.set_material_all("permeable_pavers");
    g.soil.iter_mut().for_each(|s| *s = 1);
    let r = run_dynamic(&g, &sc(1), &RainSeries::box_rain(60.0, 60.0, 60.0), &[], |_| true);
    assert!(r.h_max.iter().all(|&h| h < 1e-6));
    assert_eq!(r.permeability.subbase_full_cells, 0);
    let peak = r.subbase_fill_max.iter().cloned().fold(0.0, f32::max);
    assert!(peak > 0.5 && peak < 0.75, "peak fill {peak}");
}

#[test]
fn high_groundwater_cap_stops_infiltration() {
    let mut g = Grid::from_fn(8, 8, 1.0, |_, _| 0.0);
    g.set_material_all("lawn_compacted");
    g.soil.iter_mut().for_each(|s| *s = 1);
    assert!(g.set_infiltration_cap(&vec![5.0; 64]));
    let r = run_dynamic(&g, &sc(0), &RainSeries::box_rain(30.0, 60.0, 60.0), &[], |_| true);
    let fmax = r.infiltrated.iter().cloned().fold(0.0, f32::max) as f64 * 1e3;
    let fmin = r.infiltrated.iter().cloned().fold(1.0, f32::min) as f64 * 1e3;
    assert!((fmax - 5.0).abs() < 1e-3 && (fmin - 5.0).abs() < 1e-3, "{fmin} .. {fmax}");
    assert_eq!(r.permeability.capped_cells, 64);
    // lawn Ia 4 mm, so 30 − 4 − 5 mm ponds
    assert!((mean_depth_mm(&r.h_final) - 21.0).abs() < 0.01);
    assert!(!g.clone().set_infiltration_cap(&[1.0, 2.0]));
}

#[test]
fn mass_balance_closes_with_infiltration_on() {
    // Sloped site, open edges, lawn on JB6 + permeable paving strip on JB8 + capped corner, CDS-like rain + after-rain.
    let (nx, ny) = (60usize, 40usize);
    let mut g = Grid::from_fn(nx, ny, 1.0, |i, j| 0.01 * i as f32 + 0.15 * ((j as f32) * 0.3).sin() + 0.1 * ((i as f32) * 0.21).cos());
    let pp = g.palette.index_of("permeable_pavers").unwrap() as u16;
    let ra = g.palette.index_of("rain_garden").unwrap() as u16;
    for j in 0..ny {
        for i in 0..nx {
            let k = j * nx + i;
            if (20..26).contains(&i) {
                g.material[k] = pp;
                g.soil[k] = 8;
            }
            if (40..44).contains(&i) && (10..20).contains(&j) {
                g.material[k] = ra;
            }
        }
    }
    let caps: Vec<f32> = (0..g.len()).map(|k| if k % nx < 10 && k / nx < 10 { 3.0 } else { -1.0 }).collect();
    g.set_infiltration_cap(&caps);
    let s = Scenario { boundary: 0, after_rain_min: 30.0, moisture: 0, ..sc(0) };
    let rain = RainSeries::cds(100.0, 120.0, 80.0, 60.0, 0.4);
    let r = run_dynamic(&g, &s, &rain, &[], |_| true);
    let m = r.mass;
    assert!(m.infiltrated_m3 > 0.1 * m.rain_m3, "{m:?}");
    eprintln!("mass balance with infiltration: rain {:.2} m3, Ia {:.2}, infiltrated {:.2}, out {:.2}, stored {:.2}, error {:.2e}", m.rain_m3, m.initial_loss_m3, m.infiltrated_m3, m.boundary_out_m3, m.stored_m3, m.error_fraction);
    assert!(m.error_fraction.abs() < 1e-4, "mass error {:e}: {m:?}", m.error_fraction);
    // the reported infiltrated volume is the per-cell cumulative infiltration summed
    let per_cell: f64 = r.infiltrated.iter().map(|v| *v as f64).sum();
    assert!((per_cell - m.infiltrated_m3).abs() / m.infiltrated_m3 < 1e-4, "{per_cell} vs {}", m.infiltrated_m3);
    assert_eq!(r.permeability.capped_cells, 100);
}

#[test]
fn dynamic_runoff_converges_when_time_step_is_halved() {
    // The solver's dt is adaptive, so halve it through α: totals must agree to within a few tenths of a percent.
    let mut g = Grid::from_fn(30, 10, 1.0, |i, _| 0.02 * (30 - i) as f32);
    g.set_material_all("lawn_compacted");
    let rain = RainSeries::cds(100.0, 60.0, 50.0, 60.0, 0.4);
    let run = |alpha: f64| run_dynamic(&g, &Scenario { alpha, boundary: 0, closed_edges: 1 | 4 | 8, after_rain_min: 10.0, ..sc(0) }, &rain, &[], |_| true).mass;
    let (a, b) = (run(0.6), run(0.3));
    let rel = (a.infiltrated_m3 - b.infiltrated_m3).abs() / b.infiltrated_m3;
    eprintln!("alpha 0.6: {} steps, infiltrated {:.4} m3; alpha 0.3: {} steps, infiltrated {:.4} m3; rel diff {rel:.2e}", a.steps, a.infiltrated_m3, b.steps, b.infiltrated_m3);
    assert!(rel < 5e-3, "infiltration {} vs {} ({rel:e})", a.infiltrated_m3, b.infiltrated_m3);
}

#[test]
fn open_water_gets_no_sewer_loss() {
    let mut g = Grid::from_fn(2, 1, 1.0, |_, _| 0.0);
    g.material[0] = g.palette.index_of("water").unwrap() as u16;
    g.material[1] = g.palette.index_of("asphalt").unwrap() as u16;
    let h = derive(&g, &Scenario { sewer_mode: 1, ..Default::default() });
    assert_eq!(h.sewer_ia[0], 0.0);
    assert!((h.sewer_ia[1] - 0.034).abs() < 1e-7);
}

#[test]
fn subbase_storage_is_not_double_counted_as_initial_loss() {
    let mut g = Grid::from_fn(1, 1, 1.0, |_, _| 0.0);
    g.set_material_all("permeable_pavers");
    let h = derive(&g, &Scenario::default());
    assert!((h.ia[0] - 0.003).abs() < 1e-7);
    assert!((h.store_cap[0] - 0.045).abs() < 1e-7);
    assert_eq!(h.limited[0], 1);
    // drains at the JB6 compacted fc (default soil)
    assert!((h.drain[0] as f64 - 9.0 / 3.6e6).abs() < 1e-12);
}

fn repo_file(rel: &str) -> String {
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(rel);
    std::fs::read_to_string(&p).unwrap_or_else(|e| panic!("{}: {e}", p.display()))
}

#[test]
fn soil_table_matches_prd() {
    // Pins palette::SOILS to the "Horton parameters by Danish soil class" table in docs/PRD.md.
    let prd = repo_file("../../docs/PRD.md");
    let mut rows = 0;
    for line in prd.lines() {
        let cells: Vec<&str> = line.split('|').map(|c| c.trim()).filter(|c| !c.is_empty()).collect();
        if cells.len() != 4 {
            continue;
        }
        let Ok(jb) = cells[0].parse::<u8>() else { continue };
        let pair = |s: &str| -> (f64, f64) {
            let v: Vec<f64> = s.split('/').map(|x| x.trim().parse().unwrap()).collect();
            (v[0], v[1])
        };
        let (cfc, cf0) = pair(cells[2]);
        let (lfc, lf0) = pair(cells[3]);
        let s = soil(jb);
        assert_eq!((s.compacted_fc, s.compacted_f0, s.loose_fc, s.loose_f0), (cfc, cf0, lfc, lf0), "JB{jb} differs from PRD");
        rows += 1;
    }
    assert_eq!(rows, SOILS.len());
    assert!(prd.contains("Decay constant k = 5 per hour"));
    assert_eq!(HORTON_K_PER_HOUR, 5.0);
}

#[test]
fn palette_is_physically_consistent() {
    let p = Palette::default_palette();
    for m in &p.materials {
        for c in [m.c_normal, m.c_cloudburst_sand, m.c_cloudburst_clay] {
            assert!((0.0..=1.0).contains(&c), "{}: C {c}", m.id);
        }
        assert!(m.infiltration_sand >= 0.0 && m.infiltration_clay >= 0.0 && m.initial_loss_mm >= 0.0 && m.storage_mm >= 0.0, "{}", m.id);
        assert!(m.infiltration_sand >= m.infiltration_clay, "{}: sand slower than clay", m.id);
        assert!(m.c_cloudburst_sand <= m.c_cloudburst_clay, "{}: sand sheds more than clay", m.id);
        assert!(m.manning_n > 0.0 && m.manning_n < 0.5, "{}", m.id);
        if m.subsoil_limited {
            assert!(!m.use_soil_table && !m.sealed, "{}: sub-base surfaces take the surface rate from the palette", m.id);
        }
    }
    for s in SOILS.iter() {
        assert!(s.compacted_f0 >= s.compacted_fc && s.loose_f0 >= s.loose_fc, "JB{}", s.jb);
    }
}

#[test]
fn dotnet_palette_class_knows_every_palette_field() {
    // Cloudburst.Net round-trips the palette JSON (MaterialPalette.ToJson → cb_grid_build). A field missing from the
    // C# class is silently dropped, so every key used in palette.json must have a JsonPropertyName there.
    let cs = repo_file("../Cloudburst.Net/Materials/MaterialPalette.cs");
    let json: serde_json::Value = serde_json::from_str(&repo_file("data/palette.json")).unwrap();
    let mut keys = std::collections::BTreeSet::new();
    for m in json["materials"].as_array().unwrap() {
        for k in m.as_object().unwrap().keys() {
            keys.insert(k.clone());
        }
    }
    for k in json.as_object().unwrap().keys() {
        keys.insert(k.clone());
    }
    for k in keys {
        assert!(cs.contains(&format!("JsonPropertyName(\"{k}\")")), "MaterialPalette.cs lacks palette field \"{k}\"");
    }
}

#[test]
fn instant_and_dynamic_agree_where_only_initial_loss_acts() {
    // For surfaces that do not infiltrate (roofs incl. green/blue-green, asphalt, concrete, water), the instant
    // model's min(C·P, P − Ia) and the dynamic loss kernel must give the same runoff for the T = 100 design rain.
    let rain = RainSeries::cds(100.0, 240.0, 59.0, 60.0, 0.5);
    let cf = 1.4;
    let p_mm = rain.depth_mm() * cf;
    let base = Grid::from_fn(1, 1, 1.0, |_, _| 0.0);
    let mut checked = 0;
    for m in base.palette.materials.iter().filter(|m| m.infiltration_sand == 0.0 && m.infiltration_clay == 0.0 && !m.use_soil_table && !m.subsoil_limited) {
        let mut g = base.clone();
        g.set_material_all(&m.id);
        let h = derive(&g, &Scenario { sewer_mode: 0, ..Default::default() });
        let c = CellInf { fc: h.fc[0], f0: h.f0[0], store_cap: h.store_cap[0], drain: h.drain[0], limited: false, f_cap: h.f_cap[0] };
        let r = point_runoff(&c, h.ia[0] as f64, h.k as f64, 5.0, 6.0 * 3600.0, |t| rain.at_m_s(t) * cf);
        let m1 = effective_rain(p_mm, m.c_cloudburst(0.5), h.ia[0] as f64 * 1e3, 0.0);
        assert!((m1 - r.runoff_mm).abs() / p_mm < 0.03, "{}: M1 {m1:.1} mm vs M2 {:.1} mm", m.id, r.runoff_mm);
        checked += 1;
    }
    assert!(checked >= 7, "{checked}");
}
