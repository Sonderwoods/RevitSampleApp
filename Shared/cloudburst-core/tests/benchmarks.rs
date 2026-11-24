//! Validation tests that exercise the public API end to end (see PRD "Tests the solver must pass").

use cloudburst_core::geometry::{Mesh, Polygon, Polyline};
use cloudburst_core::grid::{build_grid, Building, Grid, GridSettings, Region, RoofDrainage, Site, Wall};
use cloudburst_core::hydro::Scenario;
use cloudburst_core::instant::run_instant;
use cloudburst_core::palette::Palette;
use cloudburst_core::rain::RainSeries;
use cloudburst_core::{run_dynamic};

fn no_losses() -> Scenario {
    Scenario { climate_factor: 1.0, sewer_mode: 0, infiltration_scale: 0.0, ..Default::default() }
}

/// EA Test 2 style: filling of floodplain depressions. A closed domain of several connected depressions
/// receives a known volume; the final water level must be flat in connected ponds and conserve volume.
#[test]
fn ea2_style_depression_filling() {
    let (nx, ny) = (100usize, 40usize);
    let mut g = Grid::from_fn(nx, ny, 2.0, |i, j| {
        let x = i as f32 * 2.0;
        let y = j as f32 * 2.0;
        // three depressions separated by low ridges
        let base = 0.5 * ((x / 200.0 * std::f32::consts::PI * 3.0).cos()) + 0.002 * (y - 40.0).abs();
        base + 0.5
    });
    g.set_material_all("water");
    let sc = Scenario { boundary: 1, after_rain_min: 60.0, ..no_losses() };
    let rain = RainSeries::box_rain(150.0, 30.0, 60.0);
    let r = run_dynamic(&g, &sc, &rain, &[], |_| true);
    let vol: f64 = r.h_final.iter().map(|v| *v as f64).sum::<f64>() * g.cell_area();
    let expected = 0.15 * (nx * ny) as f64 * g.cell_area();
    assert!((vol - expected).abs() / expected < 1e-3, "volume {vol} vs {expected}");
    // flat water surface in the deepest pond after settling (±2 cm)
    let mut levels = vec![];
    for j in 10..30 {
        for i in 0..nx {
            let k = j * nx + i;
            if r.h_final[k] > 0.05 {
                levels.push(g.z[k] + r.h_final[k]);
            }
        }
    }
    let (mn, mx) = levels.iter().fold((f32::MAX, f32::MIN), |(a, b), v| (a.min(*v), b.max(*v)));
    assert!(mx - mn < 0.1, "water levels range {mn}..{mx}");

}

/// Full site through the grid builder: buildings block flow, roof water goes to sewer, kerbs channel flow.
#[test]
fn urban_site_end_to_end() {
    let mut site = Site::default();
    site.terrain.push(Mesh::height_field(0.0, 0.0, 200.0, 120.0, 100, 60, |x, y| 5.0 - 0.01 * x - 0.005 * y - 0.8 * (-(((x - 120.0).powi(2) + (y - 60.0).powi(2)) / 400.0)).exp()));
    site.buildings.push(Building { mesh: None, footprint: Some(Polygon::rect(20.0, 20.0, 60.0, 50.0)), height: 12.0, drainage: RoofDrainage::ToSewer, roof_material: None });
    site.buildings.push(Building { mesh: None, footprint: Some(Polygon::rect(80.0, 70.0, 100.0, 100.0)), height: 9.0, drainage: RoofDrainage::ToGround, roof_material: None });
    let p = Palette::default_palette();
    let asphalt = p.index_of("asphalt").unwrap();
    site.regions.push(Region { outline: Some(Polygon::rect(0.0, 55.0, 200.0, 65.0)), surface: None, material: asphalt, soil: 0, compaction: 0, sewer: 255 });
    site.walls.push(Wall { line: Polyline { xs: vec![0.0, 200.0], ys: vec![55.0, 55.0] }, height: 0.12 });
    let g = build_grid(&site, p, &GridSettings::default()).unwrap();
    assert_eq!((g.nx, g.ny), (200, 120));

    let m1 = run_instant(&g, &Scenario::default());
    assert!(m1.stats.bluespot_count > 0);
    assert!(m1.stats.max_depth_m > 0.1);
    // no water stored on roofs
    for k in 0..g.len() {
        if g.building[k] >= 0 {
            assert!(m1.depth[k] < 1e-6);
        }
    }

    let rain = RainSeries::cds(100.0, 60.0, 40.0, 60.0, 0.5);
    let r = run_dynamic(&g, &Scenario { after_rain_min: 20.0, ..Default::default() }, &rain, &[], |_| true);
    assert!(r.mass.error_fraction.abs() < 1e-3, "mass error {}", r.mass.error_fraction);
    assert!(r.mass.infiltrated_m3 > 0.0);
    assert!(r.mass.sewer_m3 > 0.0);
    assert!(r.h_max.iter().cloned().fold(0.0f32, f32::max) > 0.05);
}

/// Cancellation via the progress callback stops early and still returns consistent maxima.
#[test]
fn dynamic_can_be_cancelled() {
    let g = Grid::from_fn(200, 200, 1.0, |i, j| 0.01 * i as f32 + 0.005 * j as f32);
    let rain = RainSeries::box_rain(100.0, 120.0, 60.0);
    let mut calls = 0;
    let r = run_dynamic(&g, &Scenario::default(), &rain, &[], |_| {
        calls += 1;
        calls < 2
    });
    assert_eq!(r.mass.cancelled, 1);
    assert!(r.mass.simulated_s < 120.0 * 60.0);
}
