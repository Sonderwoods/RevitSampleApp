//! Performance check against the PRD targets.
//! cargo run --release --example bench [-- cells_dynamic minutes]

use cloudburst_core::grid::Grid;
use cloudburst_core::hydro::Scenario;
use cloudburst_core::instant::run_instant;
use cloudburst_core::rain::RainSeries;
use cloudburst_core::run_dynamic;
use std::time::Instant;

fn terrain(n: usize) -> Grid {
    let mut g = Grid::from_fn(n, n, 1.0, |i, j| {
        let (x, y) = (i as f32, j as f32);
        10.0 - 0.004 * x - 0.002 * y + 0.8 * (x * 0.031).sin() * (y * 0.027).cos() + 0.05 * (x * 0.4).sin()
    });
    g.set_material_all("lawn_compacted");
    g
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let dyn_side: usize = args.get(1).and_then(|s| s.parse().ok()).unwrap_or(500);
    let minutes: f64 = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(30.0);
    println!("threads: {}", rayon::current_num_threads());

    for side in [1000usize, 2000] {
        let g = terrain(side);
        let t = Instant::now();
        let r = run_instant(&g, &Scenario::default());
        println!("M1 instant {:>4}×{:<4} ({:>4.1} M cells): {:>6.0} ms  bluespots {:>5}  paths {:>4}  target < {} s", side, side, (side * side) as f64 / 1e6, t.elapsed().as_secs_f64() * 1000.0, r.bluespots.len(), r.paths.len(), if side == 1000 { 1 } else { 5 });
    }

    let g = terrain(dyn_side);
    let rain = RainSeries::cds(100.0, minutes, 0.0, 60.0, 0.5);
    let sc = Scenario { after_rain_min: 0.0, ..Default::default() };
    let t = Instant::now();
    let r = run_dynamic(&g, &sc, &rain, &[], |_| true);
    let el = t.elapsed().as_secs_f64();
    let cells = (dyn_side * dyn_side) as f64;
    let rate = cells * r.mass.steps as f64 / el / 1e6;
    println!(
        "M2 dynamic {}×{} ({:.2} M cells), {:.0} min simulated: {:.1} s, {} steps, {:.0} M cell-steps/s, mass error {:.2e}",
        dyn_side, dyn_side, cells / 1e6, minutes, el, r.mass.steps, rate, r.mass.error_fraction
    );
    // extrapolate the PRD target case: 1 M cells, 6 h event + 2 h, with the same mean dt
    let mean_dt = r.mass.simulated_s / r.mass.steps as f64;
    let est = 1e6 * (8.0 * 3600.0 / mean_dt) / (rate * 1e6);
    println!("   → estimated 1 M cells × 8 h at mean dt {:.2} s: {:.0} s on this CPU (target: < 300 s on GPU)", mean_dt, est);
}
