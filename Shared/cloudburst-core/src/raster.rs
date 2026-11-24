//! Terrain raster import (IN-1: DHM/Terræn GeoTIFF, Esri ASCII grid) and ASCII grid export (OUT-10).

use crate::geometry::Mesh;
use std::fs::File;
use std::io::{BufRead, BufReader, BufWriter, Write};
use std::path::Path;
use tiff::decoder::{Decoder, DecodingResult};
use tiff::tags::Tag;

/// North-up raster. Row 0 is the northern row (as stored in files).
#[derive(Clone, Debug)]
pub struct Raster {
    pub nx: usize,
    pub ny: usize,
    /// West edge.
    pub x0: f64,
    /// North edge.
    pub y_top: f64,
    pub dx: f64,
    pub dy: f64,
    pub data: Vec<f32>,
    pub nodata: Option<f32>,
}

impl Raster {
    #[inline]
    pub fn valid(&self, v: f32) -> bool {
        !v.is_nan() && self.nodata.map(|nd| (v - nd).abs() > 1e-6).unwrap_or(true) && v > -1e4 && v < 1e5
    }

    pub fn load(path: &str) -> Result<Raster, String> {
        let lower = path.to_lowercase();
        if lower.ends_with(".asc") || lower.ends_with(".txt") {
            read_ascii(path)
        } else {
            read_geotiff(path)
        }
    }

    /// Triangulate pixel centres (2 triangles per cell), sampling every `step` pixels; NoData cells are skipped.
    pub fn to_mesh(&self, step: usize) -> Mesh {
        let step = step.max(1);
        let cols: Vec<usize> = (0..self.nx).step_by(step).collect();
        let rows: Vec<usize> = (0..self.ny).step_by(step).collect();
        let mut verts = Vec::with_capacity(cols.len() * rows.len() * 3);
        let mut idx = vec![u32::MAX; cols.len() * rows.len()];
        for (rj, &r) in rows.iter().enumerate() {
            for (ci, &c) in cols.iter().enumerate() {
                let v = self.data[r * self.nx + c];
                if self.valid(v) {
                    idx[rj * cols.len() + ci] = (verts.len() / 3) as u32;
                    verts.extend_from_slice(&[self.x0 + (c as f64 + 0.5) * self.dx, self.y_top - (r as f64 + 0.5) * self.dy, v as f64]);
                }
            }
        }
        let mut tris = Vec::new();
        let w = cols.len();
        for rj in 0..rows.len().saturating_sub(1) {
            for ci in 0..w.saturating_sub(1) {
                let a = idx[rj * w + ci];
                let b = idx[rj * w + ci + 1];
                let c = idx[(rj + 1) * w + ci + 1];
                let d = idx[(rj + 1) * w + ci];
                if a != u32::MAX && b != u32::MAX && c != u32::MAX {
                    tris.extend_from_slice(&[a, c, b]);
                }
                if a != u32::MAX && c != u32::MAX && d != u32::MAX {
                    tris.extend_from_slice(&[a, d, c]);
                }
            }
        }
        Mesh::new(verts, tris)
    }
}

pub fn read_ascii(path: &str) -> Result<Raster, String> {
    let f = File::open(path).map_err(|e| format!("{path}: {e}"))?;
    parse_ascii(BufReader::new(f), path)
}

/// Load from memory (browser uploads). TIFF is detected by its magic bytes, anything else is parsed as ASCII grid.
pub fn from_bytes(bytes: &[u8], name: &str) -> Result<Raster, String> {
    if bytes.len() > 4 && (&bytes[0..2] == b"II" || &bytes[0..2] == b"MM") {
        decode_tiff(std::io::Cursor::new(bytes), name)
    } else {
        parse_ascii(BufReader::new(bytes), name)
    }
}

fn parse_ascii<R: BufRead>(mut rd: R, path: &str) -> Result<Raster, String> {
    let (mut nx, mut ny, mut x0, mut y0, mut dx, mut nodata, mut center) = (0usize, 0usize, 0.0, 0.0, 1.0, None, false);
    let mut line = String::new();
    let mut data = Vec::new();
    loop {
        line.clear();
        if rd.read_line(&mut line).map_err(|e| e.to_string())? == 0 {
            break;
        }
        let mut it = line.split_whitespace();
        let Some(key) = it.next() else { continue };
        let k = key.to_lowercase();
        let val = it.next();
        match k.as_str() {
            "ncols" => nx = val.and_then(|v| v.parse().ok()).unwrap_or(0),
            "nrows" => ny = val.and_then(|v| v.parse().ok()).unwrap_or(0),
            "xllcorner" | "xllcenter" => {
                x0 = val.and_then(|v| v.parse().ok()).unwrap_or(0.0);
                center |= k == "xllcenter"
            }
            "yllcorner" | "yllcenter" => y0 = val.and_then(|v| v.parse().ok()).unwrap_or(0.0),
            "cellsize" => dx = val.and_then(|v| v.parse().ok()).unwrap_or(1.0),
            "nodata_value" => nodata = val.and_then(|v| v.parse().ok()),
            _ => {
                data.extend(line.split_whitespace().filter_map(|v| v.parse::<f32>().ok()));
                break;
            }
        }
    }
    for l in rd.lines() {
        let l = l.map_err(|e| e.to_string())?;
        data.extend(l.split_whitespace().filter_map(|v| v.parse::<f32>().ok()));
    }
    if nx == 0 || ny == 0 || data.len() < nx * ny {
        return Err(format!("{path}: invalid ASCII grid ({} values for {}×{})", data.len(), nx, ny));
    }
    if center {
        x0 -= dx / 2.0;
        y0 -= dx / 2.0;
    }
    data.truncate(nx * ny);
    Ok(Raster { nx, ny, x0, y_top: y0 + ny as f64 * dx, dx, dy: dx, data, nodata })
}

pub fn read_geotiff(path: &str) -> Result<Raster, String> {
    let f = File::open(path).map_err(|e| format!("{path}: {e}"))?;
    decode_tiff(BufReader::new(f), path)
}

fn decode_tiff<R: std::io::Read + std::io::Seek>(reader: R, path: &str) -> Result<Raster, String> {
    let mut dec = Decoder::new(reader).map_err(|e| format!("{path}: {e}"))?.with_limits(tiff::decoder::Limits::unlimited());
    let (w, h) = dec.dimensions().map_err(|e| e.to_string())?;
    let scale = dec.get_tag_f64_vec(Tag::ModelPixelScaleTag).ok();
    let tie = dec.get_tag_f64_vec(Tag::ModelTiepointTag).ok();
    let nodata = dec.get_tag_ascii_string(Tag::GdalNodata).ok().and_then(|s| s.trim_matches(char::from(0)).trim().parse::<f32>().ok());
    let img = dec.read_image().map_err(|e| format!("{path}: {e}"))?;
    let data: Vec<f32> = match img {
        DecodingResult::F32(v) => v,
        DecodingResult::F64(v) => v.into_iter().map(|x| x as f32).collect(),
        DecodingResult::I16(v) => v.into_iter().map(|x| x as f32).collect(),
        DecodingResult::U16(v) => v.into_iter().map(|x| x as f32).collect(),
        DecodingResult::I32(v) => v.into_iter().map(|x| x as f32).collect(),
        DecodingResult::U32(v) => v.into_iter().map(|x| x as f32).collect(),
        DecodingResult::U8(v) => v.into_iter().map(|x| x as f32).collect(),
        _ => return Err(format!("{path}: unsupported sample format")),
    };
    let (nx, ny) = (w as usize, h as usize);
    let (dx, dy) = scale.as_ref().map(|s| (s[0], s.get(1).copied().unwrap_or(s[0]))).unwrap_or((1.0, 1.0));
    let (x0, y_top) = tie.as_ref().filter(|t| t.len() >= 6).map(|t| (t[3] - t[0] * dx, t[4] + t[1] * dy)).unwrap_or((0.0, ny as f64 * dy));
    if data.len() < nx * ny {
        return Err(format!("{path}: multi-band or tiled layout not supported ({} values)", data.len()));
    }
    let bands = data.len() / (nx * ny);
    let data: Vec<f32> = if bands > 1 { data.into_iter().step_by(bands).take(nx * ny).collect() } else { data };
    Ok(Raster { nx, ny, x0, y_top, dx, dy, data, nodata })
}

/// Write a south-up grid array (index j*nx+i, j=0 south) as an Esri ASCII grid.
pub fn write_ascii(path: &Path, nx: usize, ny: usize, x0: f64, y0: f64, dx: f64, values: &[f32], nodata: f32) -> std::io::Result<()> {
    let mut w = BufWriter::new(File::create(path)?);
    writeln!(w, "ncols {nx}\nnrows {ny}\nxllcorner {x0}\nyllcorner {y0}\ncellsize {dx}\nNODATA_value {nodata}")?;
    for j in (0..ny).rev() {
        let row: Vec<String> = (0..nx).map(|i| {
            let v = values[j * nx + i];
            if v.is_nan() { format!("{nodata}") } else { format!("{v:.3}") }
        }).collect();
        writeln!(w, "{}", row.join(" "))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ascii_roundtrip_and_mesh() {
        let dir = std::env::temp_dir().join("cb_raster_test");
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("t.asc");
        let vals: Vec<f32> = (0..20).map(|k| k as f32 * 0.1).collect();
        write_ascii(&p, 5, 4, 1000.0, 2000.0, 0.4, &vals, -9999.0).unwrap();
        let r = read_ascii(p.to_str().unwrap()).unwrap();
        assert_eq!((r.nx, r.ny), (5, 4));
        assert!((r.y_top - 2001.6).abs() < 1e-9);
        // file row 0 = north = values row j=3
        assert!((r.data[0] - 1.5).abs() < 1e-6);
        let m = r.to_mesh(1);
        assert_eq!(m.tris.len() / 3, 4 * 3 * 2);
        let b = m.bounds();
        assert!((b.min_x - 1000.2).abs() < 1e-9);
    }

    /// GeoTIFF georeferencing must be read: tiff 0.9 maps 33550/33922/42113 to named tags, so `Tag::Unknown(..)` never matched
    /// and every DHM raster opened at (0, 0) with 1 m pixels.
    #[test]
    fn geotiff_georeference_and_nodata() {
        use tiff::encoder::{colortype::Gray32Float, TiffEncoder};
        let mut buf = std::io::Cursor::new(Vec::new());
        {
            let mut enc = TiffEncoder::new(&mut buf).unwrap();
            let mut img = enc.new_image::<Gray32Float>(3, 2).unwrap();
            img.encoder().write_tag(Tag::ModelPixelScaleTag, &[0.4f64, 0.4, 0.0][..]).unwrap();
            img.encoder().write_tag(Tag::ModelTiepointTag, &[0.0f64, 0.0, 0.0, 724410.0, 6179430.0, 0.0][..]).unwrap();
            img.encoder().write_tag(Tag::GdalNodata, "-9999").unwrap();
            img.write_data(&[1.0f32, 2.0, 3.0, 4.0, 5.0, -9999.0]).unwrap();
        }
        let r = from_bytes(buf.get_ref(), "t.tif").unwrap();
        assert_eq!((r.nx, r.ny), (3, 2));
        assert!((r.x0 - 724410.0).abs() < 1e-9 && (r.y_top - 6179430.0).abs() < 1e-9);
        assert!((r.dx - 0.4).abs() < 1e-12 && (r.dy - 0.4).abs() < 1e-12);
        assert_eq!(r.nodata, Some(-9999.0));
    }
}
