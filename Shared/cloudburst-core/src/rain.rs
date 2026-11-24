//! Rain events: indicative Danish IDF, Chicago Design Storm (alternating block) and box rain.
//! Calibrated to the PRD defaults (Odense, Skrift 30): T=10 → ~35 mm / 4 h, T=100 → ~59 mm / 4 h, before climate factor.
//! Regenerate site values with the Spildevandskomiteen Skrift 32 tool for real projects.

/// Mean intensity i(d,T) in µm/s for duration d minutes and return period T years (indicative).
pub fn idf_um_s(duration_min: f64, return_period: f64) -> f64 {
    let a = 240.0 * (return_period.max(0.5) / 10.0).powf(0.227);
    a / (duration_min.max(1.0) + 5.0).powf(0.835)
}

/// Depth (mm) for duration d and return period T, before climate factor.
pub fn idf_depth_mm(duration_min: f64, return_period: f64) -> f64 {
    idf_um_s(duration_min, return_period) * 1e-3 * duration_min * 60.0
}

#[derive(Clone, Debug)]
pub struct RainSeries {
    /// Intensity per step, mm/h, before climate factor.
    pub intensity_mm_h: Vec<f64>,
    pub step_s: f64,
}

impl RainSeries {
    pub fn duration_s(&self) -> f64 {
        self.intensity_mm_h.len() as f64 * self.step_s
    }
    pub fn depth_mm(&self) -> f64 {
        self.intensity_mm_h.iter().sum::<f64>() * self.step_s / 3600.0
    }
    pub fn peak_mm_h(&self) -> f64 {
        self.intensity_mm_h.iter().cloned().fold(0.0, f64::max)
    }
    /// Intensity in m/s at time t (before climate factor).
    #[inline]
    pub fn at_m_s(&self, t: f64) -> f64 {
        if t < 0.0 || self.step_s <= 0.0 {
            return 0.0;
        }
        let k = (t / self.step_s) as usize;
        self.intensity_mm_h.get(k).map(|v| v / 3.6e6).unwrap_or(0.0)
    }

    pub fn box_rain(depth_mm: f64, duration_min: f64, step_s: f64) -> RainSeries {
        let n = ((duration_min * 60.0 / step_s).round() as usize).max(1);
        let i = depth_mm / (n as f64 * step_s / 3600.0);
        RainSeries { intensity_mm_h: vec![i; n], step_s }
    }

    /// Chicago Design Storm via alternating blocks from the IDF, scaled to `depth_mm` (if > 0).
    /// `peak_position` 0..1 (0.5 = centred, Danish practice ~0.4–0.5).
    pub fn cds(return_period: f64, duration_min: f64, depth_mm: f64, step_s: f64, peak_position: f64) -> RainSeries {
        let n = ((duration_min * 60.0 / step_s).round() as usize).max(1);
        let step_min = step_s / 60.0;
        let mut incr: Vec<f64> = (1..=n).map(|k| idf_depth_mm(k as f64 * step_min, return_period) - idf_depth_mm((k - 1) as f64 * step_min, return_period)).collect();
        incr[0] = idf_depth_mm(step_min, return_period);
        let mut blocks = vec![0.0; n];
        let peak = ((n as f64 - 1.0) * peak_position.clamp(0.0, 1.0)).round() as i64;
        let (mut left, mut right) = (peak - 1, peak + 1);
        blocks[peak as usize] = incr[0];
        let mut put_right = true;
        for &d in incr.iter().skip(1) {
            let r_ok = right < n as i64;
            let l_ok = left >= 0;
            if (put_right && r_ok) || !l_ok {
                if r_ok {
                    blocks[right as usize] = d;
                    right += 1;
                }
            } else {
                blocks[left as usize] = d;
                left -= 1;
            }
            put_right = !put_right;
        }
        let total: f64 = blocks.iter().sum();
        let scale = if depth_mm > 0.0 && total > 0.0 { depth_mm / total } else { 1.0 };
        RainSeries { intensity_mm_h: blocks.iter().map(|d| d * scale * 3600.0 / step_s).collect(), step_s }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn idf_matches_prd_defaults() {
        let d10 = idf_depth_mm(240.0, 10.0);
        let d100 = idf_depth_mm(240.0, 100.0);
        assert!((d10 - 35.0).abs() < 3.0, "T10 4h = {d10}");
        assert!((d100 - 59.0).abs() < 4.0, "T100 4h = {d100}");
    }
    #[test]
    fn cds_conserves_depth_and_peaks() {
        let r = RainSeries::cds(100.0, 240.0, 59.0, 60.0, 0.5);
        assert!((r.depth_mm() - 59.0).abs() < 1e-6);
        assert!(r.peak_mm_h() > 100.0);
        let b = RainSeries::box_rain(100.0, 120.0, 60.0);
        assert!((b.depth_mm() - 100.0).abs() < 1e-9);
        assert!((b.peak_mm_h() - 50.0).abs() < 1e-9);
    }

    /// Pins the four rain presets the apps ship (Web/engine/cloudburst-wasm.js rainPresets, .NET RainEvent.Presets()):
    /// total depth and peak 1-minute intensity, before and after the climate factor. Review finding F14
    /// (docs/physics-permeability.md): the CDS uses 1-minute alternating blocks on purpose (Danish practice, docs/PRD.md
    /// "Design rain"), so the T = 100 peak is ~327 mm/h before and ~457 mm/h after the 1.4 climate factor. A change to the
    /// IDF, the block length or the scaling must update these numbers AND the PRD table deliberately.
    #[test]
    fn preset_peaks_and_depths_are_pinned() {
        // (name, series, depth before CF mm, peak before CF mm/h); climate factors 1.3 / 1.4 / 1.0 / 1.0
        let presets = [
            ("t10", RainSeries::cds(10.0, 240.0, 35.0, 60.0, 0.5), 35.0, 193.73),
            ("t100", RainSeries::cds(100.0, 240.0, 59.0, 60.0, 0.5), 59.0, 326.58),
            ("test2011", RainSeries::box_rain(120.0, 120.0, 60.0), 120.0, 60.0),
            ("box83", RainSeries::box_rain(83.0, 240.0, 60.0), 83.0, 20.75),
        ];
        for (name, r, depth, peak) in presets {
            assert!((r.depth_mm() - depth).abs() < 1e-6, "{name}: depth {}", r.depth_mm());
            assert!((r.peak_mm_h() - peak).abs() < 0.05, "{name}: peak {}", r.peak_mm_h());
            assert_eq!(r.step_s, 60.0, "{name}: 1-minute blocks");
        }
        // with climate factor, as shown in the apps and the PDF report
        let t100 = RainSeries::cds(100.0, 240.0, 59.0, 60.0, 0.5);
        assert!((t100.peak_mm_h() * 1.4 - 457.2).abs() < 0.1);
        assert!((t100.depth_mm() * 1.4 - 82.6).abs() < 1e-6);
        let t10 = RainSeries::cds(10.0, 240.0, 35.0, 60.0, 0.5);
        assert!((t10.peak_mm_h() * 1.3 - 251.85).abs() < 0.1);
        // peak sits at the centre (peak_position 0.5 → block 120 of 240)
        let k = t100.intensity_mm_h.iter().position(|&v| v == t100.peak_mm_h()).unwrap();
        assert_eq!(k, 120);
        // averaged over longer windows the same storm is much flatter (the sensitivity the report mentions)
        let five = RainSeries::cds(100.0, 240.0, 59.0, 300.0, 0.5);
        assert!((five.peak_mm_h() - 213.2).abs() < 0.2, "5-min block peak {}", five.peak_mm_h());
        let ten = RainSeries::cds(100.0, 240.0, 59.0, 600.0, 0.5);
        assert!((ten.peak_mm_h() - 152.0).abs() < 0.2, "10-min block peak {}", ten.peak_mm_h());
    }
}
