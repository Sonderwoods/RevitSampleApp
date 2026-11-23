//! Sample projects shared by every front-end (Rhino, Revit, standalone, web).
//!
//! * Synthetic sites are generated here (terrain height field + buildings + surfaces + kerbs) and need no data.
//! * Real Danish sites are catalogue entries (EPSG:25832 bounding box) whose terrain is fetched from
//!   Danmarks Højdemodel with `tools/fetch_dhm.py` (needs a Dataforsyningen token) and imported as GeoTIFF.

use crate::geometry::{Mesh, Polygon, Polyline};
use crate::grid::{Building, Region, RoofDrainage, Site, Wall};
use crate::palette::Palette;
use serde::Serialize;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SampleInfo {
    pub id: &'static str,
    pub name: &'static str,
    pub description: &'static str,
    /// "synthetic" or "real".
    pub kind: &'static str,
    /// Suggested rain preset index (0 T10, 1 T100, 2 2011 test, 3 box).
    pub rain_preset: i32,
    /// Real sites: EPSG:25832 bbox [minx, miny, maxx, maxy].
    pub bbox: Option<[f64; 4]>,
    /// Real sites: suggested DHM file name produced by tools/fetch_dhm.py.
    pub dhm_file: Option<&'static str>,
    /// Sample to compare against (before/after pairs).
    pub compare_with: Option<&'static str>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SampleBuilding {
    pub name: String,
    pub xs: Vec<f64>,
    pub ys: Vec<f64>,
    pub height: f64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SampleSurface {
    pub material: String,
    pub xs: Vec<f64>,
    pub ys: Vec<f64>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SampleLine {
    pub xs: Vec<f64>,
    pub ys: Vec<f64>,
    pub height: f64,
}

/// A generated sample: regular height field (south-up, index j*nx+i, vertex grid) and vector inputs, metres.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SampleSite {
    pub info: SampleInfo,
    pub x0: f64,
    pub y0: f64,
    /// Vertex spacing of the height field.
    pub step: f64,
    pub nx: usize,
    pub ny: usize,
    pub z: Vec<f32>,
    pub buildings: Vec<SampleBuilding>,
    pub surfaces: Vec<SampleSurface>,
    pub kerbs: Vec<SampleLine>,
}

pub fn catalogue() -> Vec<SampleInfo> {
    let syn = |id, name, description, rain_preset, compare_with| SampleInfo { id, name, description, kind: "synthetic", rain_preset, bbox: None, dhm_file: None, compare_with };
    let real = |id, name, description, bbox: [f64; 4], dhm_file| SampleInfo { id, name, description, kind: "real", rain_preset: 2, bbox: Some(bbox), dhm_file: Some(dhm_file), compare_with: None };
    vec![
        syn("demo_block", "Urban block", "300 × 200 m block: street with kerbs, sunken plaza, park pond, six buildings.", 1, None),
        syn("residential_street", "Sloping residential street", "250 × 160 m: houses on a 2 % slope, gardens, a street sag that collects runoff from the whole hill.", 1, None),
        syn("school_before", "School yard – before", "180 × 140 m asphalt school yard against a sports hall: water ponds at the façade.", 1, Some("school_after")),
        syn("school_after", "School yard – after (LAR)", "Same yard with rain gardens, permeable paving and a lawn swale. Compare with ‘before’.", 1, Some("school_before")),
        syn("city_plaza", "City plaza (10 cm target)", "Flat paved plaza enclosed by perimeter blocks: breaks the Copenhagen 10 cm target in a 100-year rain.", 2, None),
        syn("valley_cascade", "Valley neighbourhood", "400 × 250 m valley with a chain of hollows that fill and spill into each other.", 1, None),
        real("dk_taasinge", "Tåsinge Plads, Østerbro (real)", "Climate-adapted square in Copenhagen's climate quarter. Terrain: DHM/Terræn 0.4 m.", [724410.0, 6179030.0, 724810.0, 6179430.0], "dk_taasinge.tif"),
        real("dk_skt_kjeld", "Skt. Kjelds Plads (real)", "Cloudburst-adapted roundabout and green streets, Østerbro.", [724606.0, 6179385.0, 725006.0, 6179785.0], "dk_skt_kjeld.tif"),
        real("dk_enghaveparken", "Enghaveparken, Vesterbro (real)", "Park redesigned as a 24,000 m³ cloudburst reservoir.", [722489.0, 6174434.0, 722989.0, 6174934.0], "dk_enghaveparken.tif"),
        real("dk_kongens_nytorv", "Kongens Nytorv (real)", "Dense historic centre, flooded 2 July 2011.", [725197.0, 6176115.0, 725597.0, 6176515.0], "dk_kongens_nytorv.tif"),
        real("dk_odense", "Odense, Munke Mose (real)", "River valley park next to the city centre (rain statistics are for Odense).", [587350.0, 6139090.0, 587850.0, 6139590.0], "dk_odense.tif"),
    ]
}

fn bump(x: f64, y: f64, cx: f64, cy: f64, r: f64) -> f64 {
    let d2 = ((x - cx).powi(2) + (y - cy).powi(2)) / (r * r);
    if d2 > 6.0 {
        0.0
    } else {
        (-d2).exp()
    }
}

fn rect(x0: f64, y0: f64, x1: f64, y1: f64) -> (Vec<f64>, Vec<f64>) {
    (vec![x0, x1, x1, x0], vec![y0, y0, y1, y1])
}

struct Gen {
    s: SampleSite,
}

impl Gen {
    fn new(info: SampleInfo, w: f64, h: f64, step: f64, f: impl Fn(f64, f64) -> f64) -> Gen {
        let nx = (w / step).round() as usize + 1;
        let ny = (h / step).round() as usize + 1;
        let mut z = Vec::with_capacity(nx * ny);
        for j in 0..ny {
            for i in 0..nx {
                z.push(f(i as f64 * step, j as f64 * step) as f32);
            }
        }
        Gen { s: SampleSite { info, x0: 0.0, y0: 0.0, step, nx, ny, z, buildings: vec![], surfaces: vec![], kerbs: vec![] } }
    }
    fn building(&mut self, name: &str, x0: f64, y0: f64, x1: f64, y1: f64, h: f64) -> &mut Self {
        let (xs, ys) = rect(x0, y0, x1, y1);
        self.s.buildings.push(SampleBuilding { name: name.into(), xs, ys, height: h });
        self
    }
    fn surface(&mut self, m: &str, x0: f64, y0: f64, x1: f64, y1: f64) -> &mut Self {
        let (xs, ys) = rect(x0, y0, x1, y1);
        self.s.surfaces.push(SampleSurface { material: m.into(), xs, ys });
        self
    }
    fn kerb(&mut self, xs: Vec<f64>, ys: Vec<f64>, h: f64) -> &mut Self {
        self.s.kerbs.push(SampleLine { xs, ys, height: h });
        self
    }
}

/// Terrain of the original demo block (identical to Cloudburst.Net DemoSite.TerrainZ).
pub fn demo_block_z(x: f64, y: f64) -> f64 {
    let mut z = 10.0 - 0.009 * x - 0.004 * y;
    z -= 1.2 * (-((y - 70.0 - 0.15 * x) / 22.0).powi(2)).exp();
    z -= 1.4 * bump(x, y, 205.0, 135.0, 30.0);
    z -= 0.9 * bump(x, y, 95.0, 150.0, 20.0);
    z += 0.8 * bump(x, y, 40.0, 30.0, 35.0);
    z -= 0.45 * bump(x, y, 150.0, 103.0, 12.0);
    z -= 0.5 * bump(x, y, 80.0, 55.0, 16.0);
    z -= 0.6 * bump(x, y, 265.0, 45.0, 22.0);
    if y > 95.0 && y < 111.0 {
        z -= 0.12;
    }
    z + 0.05 * (x * 0.21).sin() * (y * 0.17).cos()
}

pub fn generate(id: &str) -> Option<SampleSite> {
    let info = catalogue().into_iter().find(|s| s.id == id && s.kind == "synthetic")?;
    let site = match id {
        "demo_block" => {
            let mut g = Gen::new(info, 300.0, 200.0, 2.0, demo_block_z);
            g.building("Block A", 20.0, 120.0, 70.0, 175.0, 15.0)
                .building("Block B", 120.0, 125.0, 160.0, 180.0, 12.0)
                .building("School", 20.0, 20.0, 60.0, 75.0, 9.0)
                .building("Tower", 100.0, 25.0, 140.0, 70.0, 18.0)
                .building("Hall", 170.0, 20.0, 235.0, 60.0, 10.0)
                .building("Block C", 255.0, 120.0, 290.0, 185.0, 14.0);
            g.surface("asphalt", 0.0, 95.0, 300.0, 111.0)
                .surface("pavers", 0.0, 89.0, 300.0, 95.0)
                .surface("pavers", 0.0, 111.0, 300.0, 117.0)
                .surface("concrete", 75.0, 130.0, 115.0, 170.0)
                .surface("park_lawn", 180.0, 110.0, 245.0, 165.0)
                .surface("rain_garden", 195.0, 125.0, 215.0, 145.0)
                .surface("asphalt", 60.0, 20.0, 95.0, 80.0)
                .surface("meadow", 240.0, 20.0, 300.0, 80.0)
                .surface("shrubs", 0.0, 0.0, 20.0, 89.0);
            g.kerb(vec![0.0, 300.0], vec![95.0, 95.0], 0.1).kerb(vec![0.0, 300.0], vec![111.0, 111.0], 0.1);
            g.s
        }
        "residential_street" => {
            // hill falling north → south at 2 %, street along y = 40 with a sag at x = 140
            let f = |x: f64, y: f64| {
                let mut z = 8.0 + 0.02 * y + 0.004 * (x - 125.0).abs();
                z -= 0.5 * bump(x, y, 140.0, 40.0, 25.0);
                if y > 32.0 && y < 46.0 {
                    z -= 0.1 + 0.02 * ((y - 39.0) / 7.0).powi(2) * -1.0;
                }
                z + 0.03 * (x * 0.3).sin() * (y * 0.23).cos()
            };
            let mut g = Gen::new(info, 250.0, 160.0, 1.0, f);
            for (k, x) in [15.0, 55.0, 95.0, 155.0, 195.0].iter().enumerate() {
                g.building(&format!("House N{}", k + 1), *x, 70.0, x + 24.0, 82.0, 7.0);
                g.building(&format!("House S{}", k + 1), *x, 8.0, x + 22.0, 20.0, 7.0);
                g.surface("lawn_compacted", *x - 8.0, 55.0, x + 32.0, 120.0);
            }
            g.building("Terrace", 30.0, 125.0, 220.0, 140.0, 10.0);
            g.surface("asphalt", 0.0, 32.0, 250.0, 46.0)
                .surface("pavers", 0.0, 46.0, 250.0, 50.0)
                .surface("pavers", 0.0, 28.0, 250.0, 32.0)
                .surface("asphalt", 0.0, 100.0, 250.0, 108.0)
                .surface("shrubs", 0.0, 140.0, 250.0, 160.0);
            for &x in &[45.0, 85.0, 125.0, 185.0, 225.0] {
                g.surface("concrete", x, 50.0, x + 4.0, 70.0); // driveways
            }
            g.kerb(vec![0.0, 250.0], vec![32.0, 32.0], 0.12).kerb(vec![0.0, 250.0], vec![46.0, 46.0], 0.12);
            g.s
        }
        "school_before" | "school_after" => {
            let after = id == "school_after";
            let f = move |x: f64, y: f64| {
                let mut z = 5.0 + 0.008 * x + 0.003 * y;
                z -= 0.5 * bump(x, y, 58.0, 55.0, 20.0); // yard low point against the hall façade
                if after {
                    z += 0.45 * bump(x, y, 58.0, 55.0, 20.0); // regraded away from the façade
                    z -= 0.35 * bump(x, y, 95.0, 55.0, 9.0); // rain garden 1
                    z -= 0.35 * bump(x, y, 130.0, 95.0, 10.0); // rain garden 2
                    if (y - 30.0).abs() < 4.0 && x > 70.0 && x < 170.0 {
                        z -= 0.3 * (1.0 - ((y - 30.0) / 4.0).powi(2)); // swale
                    }
                }
                z + 0.02 * (x * 0.4).sin() * (y * 0.31).cos()
            };
            let mut g = Gen::new(info, 180.0, 140.0, 1.0, f);
            g.building("School", 10.0, 90.0, 80.0, 130.0, 12.0).building("Sports hall", 20.0, 20.0, 50.0, 80.0, 9.0);
            g.surface("asphalt", 50.0, 10.0, 180.0, 90.0).surface("lawn_compacted", 80.0, 90.0, 180.0, 140.0).surface("pavers", 0.0, 80.0, 90.0, 90.0);
            if after {
                g.surface("rain_garden", 86.0, 46.0, 104.0, 64.0)
                    .surface("rain_garden", 120.0, 85.0, 140.0, 105.0)
                    .surface("permeable_pavers", 50.0, 40.0, 85.0, 90.0)
                    .surface("swale", 70.0, 26.0, 170.0, 34.0)
                    .surface("shrubs", 150.0, 40.0, 180.0, 90.0);
            }
            g.s
        }
        "city_plaza" => {
            let f = |x: f64, y: f64| {
                let mut z = 3.0 + 0.0015 * x + 0.001 * y;
                z -= 0.3 * bump(x, y, 110.0, 90.0, 35.0); // gentle dish
                z + 0.01 * (x * 0.5).sin()
            };
            let mut g = Gen::new(info, 220.0, 180.0, 1.0, f);
            g.building("North block", 0.0, 150.0, 220.0, 180.0, 22.0)
                .building("West block", 0.0, 30.0, 40.0, 150.0, 22.0)
                .building("East block", 180.0, 30.0, 220.0, 150.0, 22.0)
                .building("South-west", 0.0, 0.0, 95.0, 22.0, 18.0)
                .building("South-east", 125.0, 0.0, 220.0, 22.0, 18.0);
            g.surface("setts", 40.0, 22.0, 180.0, 150.0).surface("concrete", 80.0, 60.0, 140.0, 120.0).surface("asphalt", 95.0, 0.0, 125.0, 30.0);
            g.kerb(vec![95.0, 125.0], vec![24.0, 24.0], 0.08);
            g.s
        }
        "valley_cascade" => {
            let f = |x: f64, y: f64| {
                let mut z = 12.0 - 0.012 * x + 0.00012 * (y - 125.0).powi(2) * 3.0;
                for (k, cx) in [70.0, 160.0, 250.0, 330.0].iter().enumerate() {
                    z -= (0.6 + 0.15 * k as f64) * bump(x, y, *cx, 125.0 + 10.0 * (k as f64 - 1.5), 24.0);
                }
                z + 0.04 * (x * 0.13).sin() * (y * 0.19).cos()
            };
            let mut g = Gen::new(info, 400.0, 250.0, 2.0, f);
            for (k, x) in [20.0, 110.0, 200.0, 290.0].iter().enumerate() {
                g.building(&format!("Row N{}", k + 1), *x, 185.0, x + 50.0, 200.0, 9.0);
                g.building(&format!("Row S{}", k + 1), *x + 10.0, 50.0, x + 60.0, 65.0, 9.0);
            }
            g.surface("asphalt", 0.0, 210.0, 400.0, 218.0).surface("asphalt", 0.0, 32.0, 400.0, 40.0).surface("park_lawn", 0.0, 80.0, 400.0, 170.0).surface("meadow", 140.0, 95.0, 380.0, 155.0);
            g.s
        }
        _ => return None,
    };
    Some(site)
}

impl SampleSite {
    pub fn terrain_mesh(&self) -> Mesh {
        let mut verts = Vec::with_capacity(self.nx * self.ny * 3);
        for j in 0..self.ny {
            for i in 0..self.nx {
                verts.extend_from_slice(&[self.x0 + i as f64 * self.step, self.y0 + j as f64 * self.step, self.z[j * self.nx + i] as f64]);
            }
        }
        let mut tris = Vec::with_capacity((self.nx - 1) * (self.ny - 1) * 6);
        for j in 0..self.ny - 1 {
            for i in 0..self.nx - 1 {
                let a = (j * self.nx + i) as u32;
                let (b, c, d) = (a + 1, a + 1 + self.nx as u32, a + self.nx as u32);
                tris.extend_from_slice(&[a, b, c, a, c, d]);
            }
        }
        Mesh::new(verts, tris)
    }

    pub fn to_site(&self, palette: &Palette) -> Site {
        let mut site = Site::default();
        site.terrain.push(self.terrain_mesh());
        for b in &self.buildings {
            site.buildings.push(Building { mesh: None, footprint: Some(Polygon::new(b.xs.clone(), b.ys.clone())), height: b.height, drainage: RoofDrainage::ToSewer, roof_material: None });
        }
        for s in &self.surfaces {
            let m = palette.index_of(&s.material).unwrap_or_else(|| palette.default_index());
            site.regions.push(Region { outline: Some(Polygon::new(s.xs.clone(), s.ys.clone())), surface: None, material: m, soil: 0, compaction: 0, sewer: 255 });
        }
        for k in &self.kerbs {
            site.walls.push(Wall { line: Polyline { xs: k.xs.clone(), ys: k.ys.clone() }, height: k.height });
        }
        site
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::grid::{build_grid, GridSettings};
    use crate::hydro::Scenario;
    use crate::instant::run_instant;

    #[test]
    fn every_synthetic_sample_builds_and_floods() {
        let p = Palette::default_palette();
        for info in catalogue().iter().filter(|s| s.kind == "synthetic") {
            let s = generate(info.id).unwrap();
            let g = build_grid(&s.to_site(&p), p.clone(), &GridSettings::default()).unwrap();
            let r = run_instant(&g, &Scenario::default());
            eprintln!("{:20} {:>4}×{:<4} bluespots {:>3} stored {:>6.0} m³ max {:.2} m paths {}", info.id, g.nx, g.ny, r.stats.bluespot_count, r.stats.stored_volume_m3, r.stats.max_depth_m, r.paths.len());
            assert!(r.stats.bluespot_count > 0, "{} has no bluespots", info.id);
        }
    }

    #[test]
    fn lar_reduces_school_flooding() {
        let p = Palette::default_palette();
        let run = |id: &str| {
            let s = generate(id).unwrap();
            let g = build_grid(&s.to_site(&p), p.clone(), &GridSettings::default()).unwrap();
            run_instant(&g, &Scenario::default()).stats
        };
        let (b, a) = (run("school_before"), run("school_after"));
        eprintln!("school before: {:.0} m³ >10cm {:.0} m², after: {:.0} m³ >10cm {:.0} m²", b.stored_volume_m3, b.area_over_10cm_m2, a.stored_volume_m3, a.area_over_10cm_m2);
        assert!(a.effective_volume_m3 < b.effective_volume_m3);
        assert!(b.stored_volume_m3 > 50.0);
    }
}
