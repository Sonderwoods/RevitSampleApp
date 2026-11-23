//! Material palette (palette.json) and Danish JB soil table.

use serde::{Deserialize, Serialize};

pub const DEFAULT_PALETTE_JSON: &str = include_str!("../data/palette.json");

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Material {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub category: String,
    pub c_normal: f64,
    pub c_cloudburst_sand: f64,
    pub c_cloudburst_clay: f64,
    pub manning_n: f64,
    pub infiltration_sand: f64,
    pub infiltration_clay: f64,
    pub initial_loss_mm: f64,
    #[serde(default)]
    pub sealed: bool,
    #[serde(default)]
    pub use_soil_table: bool,
    #[serde(default = "yes")]
    pub compacted: bool,
    #[serde(default)]
    pub storage_mm: f64,
    #[serde(default)]
    pub ponding_mm: f64,
    #[serde(default)]
    pub color: String,
    #[serde(default)]
    pub keywords: Vec<String>,
}

fn yes() -> bool {
    true
}

impl Material {
    pub fn c_cloudburst(&self, clay: f64) -> f64 {
        lerp(self.c_cloudburst_sand, self.c_cloudburst_clay, clay)
    }
    pub fn infiltration(&self, clay: f64) -> f64 {
        lerp(self.infiltration_sand, self.infiltration_clay, clay)
    }
}

fn lerp(a: f64, b: f64, t: f64) -> f64 {
    a + (b - a) * t.clamp(0.0, 1.0)
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Palette {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub version: i32,
    #[serde(default)]
    pub default_material: String,
    pub materials: Vec<Material>,
}

impl Palette {
    pub fn default_palette() -> Palette {
        Palette::from_json(DEFAULT_PALETTE_JSON).expect("embedded palette is valid")
    }
    pub fn from_json(json: &str) -> Result<Palette, String> {
        serde_json::from_str(json).map_err(|e| format!("Palette JSON error: {e}"))
    }
    pub fn index_of(&self, id: &str) -> Option<usize> {
        self.materials.iter().position(|m| m.id.eq_ignore_ascii_case(id) || m.name.eq_ignore_ascii_case(id))
    }
    pub fn default_index(&self) -> usize {
        self.index_of(&self.default_material).unwrap_or(0)
    }
    /// Keyword match on free text (layer, Revit material…), English + Danish.
    pub fn guess(&self, text: &str) -> Option<usize> {
        let t = text.to_lowercase();
        if let Some(i) = self.index_of(&t) {
            return Some(i);
        }
        let mut best = None;
        let mut best_len = 0;
        for (i, m) in self.materials.iter().enumerate() {
            for k in &m.keywords {
                if k.len() > best_len && t.contains(&k.to_lowercase()) {
                    best = Some(i);
                    best_len = k.len();
                }
            }
        }
        best
    }
}

/// Horton fc/f0 (mm/h) per JB class, compacted and loose (Gade & Lerer 2022), and clay fraction 0..1.
#[derive(Clone, Copy, Debug)]
pub struct Soil {
    pub jb: u8,
    pub compacted_fc: f64,
    pub compacted_f0: f64,
    pub loose_fc: f64,
    pub loose_f0: f64,
    pub clay: f64,
}

pub const HORTON_K_PER_HOUR: f64 = 5.0;

pub const SOILS: [Soil; 11] = [
    Soil { jb: 1, compacted_fc: 30.0, compacted_f0: 120.0, loose_fc: 1000.0, loose_f0: 4000.0, clay: 0.0 },
    Soil { jb: 2, compacted_fc: 25.0, compacted_f0: 100.0, loose_fc: 500.0, loose_f0: 2000.0, clay: 0.05 },
    Soil { jb: 3, compacted_fc: 21.0, compacted_f0: 85.0, loose_fc: 150.0, loose_f0: 500.0, clay: 0.2 },
    Soil { jb: 4, compacted_fc: 20.0, compacted_f0: 80.0, loose_fc: 120.0, loose_f0: 500.0, clay: 0.3 },
    Soil { jb: 5, compacted_fc: 12.0, compacted_f0: 50.0, loose_fc: 30.0, loose_f0: 200.0, clay: 0.6 },
    Soil { jb: 6, compacted_fc: 9.0, compacted_f0: 47.0, loose_fc: 25.0, loose_f0: 100.0, clay: 0.7 },
    Soil { jb: 7, compacted_fc: 5.0, compacted_f0: 20.0, loose_fc: 20.0, loose_f0: 50.0, clay: 0.85 },
    Soil { jb: 8, compacted_fc: 0.5, compacted_f0: 2.0, loose_fc: 2.0, loose_f0: 20.0, clay: 0.95 },
    Soil { jb: 9, compacted_fc: 0.01, compacted_f0: 0.1, loose_fc: 0.0, loose_f0: 1.0, clay: 1.0 },
    Soil { jb: 10, compacted_fc: 20.0, compacted_f0: 80.0, loose_fc: 50.0, loose_f0: 250.0, clay: 0.6 },
    Soil { jb: 11, compacted_fc: 22.0, compacted_f0: 100.0, loose_fc: 200.0, loose_f0: 2000.0, clay: 0.2 },
];

pub fn soil(jb: u8) -> &'static Soil {
    &SOILS[(jb.clamp(1, 11) - 1) as usize]
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn default_palette_loads_and_guesses() {
        let p = Palette::default_palette();
        assert!(p.materials.len() > 20);
        assert_eq!(p.materials[p.guess("Road - Asfalt").unwrap()].id, "asphalt");
        assert_eq!(p.materials[p.guess("Græsplæne").unwrap()].id, "lawn_compacted");
        assert_eq!(p.materials[p.default_index()].id, "lawn_compacted");
    }
}
