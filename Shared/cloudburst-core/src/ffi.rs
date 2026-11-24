//! C ABI used by the .NET wrapper (Cloudburst.Net/Native/NativeMethods.cs). All functions are panic-safe.
//! Ownership: every `*_new`/`*_run`/`*_build` handle must be released with its `*_free`.
//! Strings returned as `*mut c_char` must be released with `cb_string_free`.

#![allow(clippy::missing_safety_doc)]

use crate::dynamic::{run_dynamic, DynamicResult, MassBalance, PermeabilityStats, Progress};
use crate::geometry::{Mesh, Polygon, Polyline};
use crate::grid::{build_grid, Building, Grid, GridSettings, Region, RoofDrainage, Site, Wall};
use crate::hydro::Scenario;
use crate::instant::{run_instant, Bluespot, InstantResult, InstantStats};
use crate::palette::Palette;
use crate::rain::{idf_depth_mm, RainSeries};
use crate::retention::{compute, reduced_area, RetentionInput, RetentionResult};
use std::cell::RefCell;
use std::ffi::{c_char, c_void, CStr, CString};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::slice;

thread_local! { static LAST_ERROR: RefCell<String> = RefCell::new(String::new()); }

fn set_err(e: impl Into<String>) {
    LAST_ERROR.with(|l| *l.borrow_mut() = e.into());
}

fn guard<T>(fallback: T, f: impl FnOnce() -> Result<T, String>) -> T {
    match catch_unwind(AssertUnwindSafe(f)) {
        Ok(Ok(v)) => v,
        Ok(Err(e)) => {
            set_err(e);
            fallback
        }
        Err(p) => {
            let msg = p.downcast_ref::<&str>().map(|s| s.to_string()).or_else(|| p.downcast_ref::<String>().cloned()).unwrap_or_else(|| "panic".into());
            set_err(format!("internal error: {msg}"));
            fallback
        }
    }
}

fn to_c(s: &str) -> *mut c_char {
    CString::new(s.replace('\0', " ")).unwrap().into_raw()
}

unsafe fn s<'a, T>(p: *const T, n: i32) -> &'a [T] {
    if p.is_null() || n <= 0 {
        &[]
    } else {
        slice::from_raw_parts(p, n as usize)
    }
}

unsafe fn copy_out<T: Copy>(src: &[T], out: *mut T, len: i32) -> i32 {
    if out.is_null() || len <= 0 {
        return src.len() as i32;
    }
    let n = src.len().min(len as usize);
    std::ptr::copy_nonoverlapping(src.as_ptr(), out, n);
    n as i32
}

unsafe fn mesh(v: *const f64, nv: i32, t: *const i32, nt: i32) -> Mesh {
    Mesh::new(s(v, nv).to_vec(), s(t, nt).iter().map(|&x| x.max(0) as u32).collect())
}

unsafe fn poly(xs: *const f64, ys: *const f64, n: i32) -> Polygon {
    Polygon::new(s(xs, n).to_vec(), s(ys, n).to_vec())
}

unsafe fn palette_from(json: *const c_char) -> Result<Palette, String> {
    if json.is_null() {
        Ok(Palette::default_palette())
    } else {
        let j = CStr::from_ptr(json).to_str().map_err(|e| e.to_string())?;
        if j.trim().is_empty() {
            Ok(Palette::default_palette())
        } else {
            Palette::from_json(j)
        }
    }
}

// ------------------------------------------------------------------ misc

#[no_mangle]
pub extern "C" fn cb_version() -> *mut c_char {
    to_c(env!("CARGO_PKG_VERSION"))
}

#[no_mangle]
pub extern "C" fn cb_last_error() -> *mut c_char {
    LAST_ERROR.with(|l| to_c(&l.borrow()))
}

#[no_mangle]
pub unsafe extern "C" fn cb_string_free(p: *mut c_char) {
    if !p.is_null() {
        drop(CString::from_raw(p));
    }
}

#[no_mangle]
pub extern "C" fn cb_default_palette_json() -> *mut c_char {
    to_c(crate::palette::DEFAULT_PALETTE_JSON)
}

#[no_mangle]
pub unsafe extern "C" fn cb_material_guess(palette_json: *const c_char, text: *const c_char) -> i32 {
    guard(-1, || {
        let p = palette_from(palette_json)?;
        if text.is_null() {
            return Ok(-1);
        }
        let t = CStr::from_ptr(text).to_string_lossy();
        Ok(p.guess(&t).map(|i| i as i32).unwrap_or(-1))
    })
}

#[no_mangle]
pub extern "C" fn cb_scenario_default(out: *mut Scenario) {
    if !out.is_null() {
        unsafe { *out = Scenario::default() }
    }
}

// ------------------------------------------------------------------ memory (WebAssembly hosts)

/// Allocate `len` bytes (8-aligned) for passing arrays/strings from JavaScript. Free with cb_dealloc.
#[no_mangle]
pub extern "C" fn cb_alloc(len: i32) -> *mut u8 {
    let n = (len.max(0) as usize + 7) / 8;
    let mut v: Vec<u64> = vec![0; n.max(1)];
    let p = v.as_mut_ptr() as *mut u8;
    std::mem::forget(v);
    p
}

#[no_mangle]
pub unsafe extern "C" fn cb_dealloc(p: *mut u8, len: i32) {
    if !p.is_null() {
        let n = (len.max(0) as usize + 7) / 8;
        drop(Vec::from_raw_parts(p as *mut u64, n.max(1), n.max(1)));
    }
}

// ------------------------------------------------------------------ samples

/// JSON array of sample projects (synthetic and real Danish sites).
#[no_mangle]
pub extern "C" fn cb_samples_json() -> *mut c_char {
    to_c(&serde_json::to_string(&crate::samples::catalogue()).unwrap_or_default())
}

/// Full JSON of a synthetic sample (height field, buildings, surfaces, kerbs), or null.
#[no_mangle]
pub unsafe extern "C" fn cb_sample_json(id: *const c_char) -> *mut c_char {
    guard(std::ptr::null_mut(), || {
        let id = if id.is_null() { "" } else { CStr::from_ptr(id).to_str().unwrap_or("") };
        let s = crate::samples::generate(id).ok_or_else(|| format!("unknown sample '{id}'"))?;
        Ok(to_c(&serde_json::to_string(&s).map_err(|e| e.to_string())?))
    })
}

/// New site handle filled with a synthetic sample (free with cb_site_free).
#[no_mangle]
pub unsafe extern "C" fn cb_site_from_sample(id: *const c_char, palette_json: *const c_char) -> *mut Site {
    guard(std::ptr::null_mut(), || {
        let id = if id.is_null() { "" } else { CStr::from_ptr(id).to_str().unwrap_or("") };
        let p = palette_from(palette_json)?;
        let s = crate::samples::generate(id).ok_or_else(|| format!("unknown sample '{id}'"))?;
        Ok(Box::into_raw(Box::new(s.to_site(&p))))
    })
}

// ------------------------------------------------------------------ site

#[no_mangle]
pub extern "C" fn cb_site_new() -> *mut Site {
    Box::into_raw(Box::default())
}

#[no_mangle]
pub unsafe extern "C" fn cb_site_free(p: *mut Site) {
    if !p.is_null() {
        drop(Box::from_raw(p));
    }
}

#[no_mangle]
pub unsafe extern "C" fn cb_site_add_terrain(site: *mut Site, v: *const f64, nv: i32, t: *const i32, nt: i32, design: i32) {
    if let Some(site) = site.as_mut() {
        let m = mesh(v, nv, t, nt);
        if design != 0 {
            site.design_terrain.push(m)
        } else {
            site.terrain.push(m)
        }
    }
}

#[no_mangle]
pub unsafe extern "C" fn cb_site_add_building_mesh(site: *mut Site, v: *const f64, nv: i32, t: *const i32, nt: i32, drainage: i32, roof_material: i32) {
    if let Some(site) = site.as_mut() {
        site.buildings.push(Building {
            mesh: Some(mesh(v, nv, t, nt)),
            footprint: None,
            height: 8.0,
            drainage: if drainage == 1 { RoofDrainage::ToGround } else { RoofDrainage::ToSewer },
            roof_material: if roof_material >= 0 { Some(roof_material as usize) } else { None },
        });
    }
}

#[no_mangle]
pub unsafe extern "C" fn cb_site_add_building_footprint(site: *mut Site, xs: *const f64, ys: *const f64, n: i32, height: f64, drainage: i32, roof_material: i32) {
    if let Some(site) = site.as_mut() {
        site.buildings.push(Building {
            mesh: None,
            footprint: Some(poly(xs, ys, n)),
            height,
            drainage: if drainage == 1 { RoofDrainage::ToGround } else { RoofDrainage::ToSewer },
            roof_material: if roof_material >= 0 { Some(roof_material as usize) } else { None },
        });
    }
}

#[no_mangle]
pub unsafe extern "C" fn cb_site_add_region_polygon(site: *mut Site, xs: *const f64, ys: *const f64, n: i32, material: i32, soil: i32, compaction: i32, sewer: i32) {
    if let Some(site) = site.as_mut() {
        site.regions.push(Region { outline: Some(poly(xs, ys, n)), surface: None, material: material.max(0) as usize, soil: soil.clamp(0, 11) as u8, compaction: compaction.clamp(0, 2) as u8, sewer: if sewer < 0 { 255 } else { sewer as u8 } });
    }
}

#[no_mangle]
pub unsafe extern "C" fn cb_site_add_region_mesh(site: *mut Site, v: *const f64, nv: i32, t: *const i32, nt: i32, material: i32, soil: i32, compaction: i32, sewer: i32) {
    if let Some(site) = site.as_mut() {
        site.regions.push(Region { outline: None, surface: Some(mesh(v, nv, t, nt)), material: material.max(0) as usize, soil: soil.clamp(0, 11) as u8, compaction: compaction.clamp(0, 2) as u8, sewer: if sewer < 0 { 255 } else { sewer as u8 } });
    }
}

#[no_mangle]
pub unsafe extern "C" fn cb_site_add_wall(site: *mut Site, xs: *const f64, ys: *const f64, n: i32, height: f64) {
    if let Some(site) = site.as_mut() {
        site.walls.push(Wall { line: Polyline { xs: s(xs, n).to_vec(), ys: s(ys, n).to_vec() }, height });
    }
}

#[no_mangle]
pub unsafe extern "C" fn cb_site_add_bridge_cut(site: *mut Site, xs: *const f64, ys: *const f64, n: i32) {
    if let Some(site) = site.as_mut() {
        site.bridge_cuts.push(poly(xs, ys, n));
    }
}

#[no_mangle]
pub unsafe extern "C" fn cb_site_set_boundary(site: *mut Site, xs: *const f64, ys: *const f64, n: i32) {
    if let Some(site) = site.as_mut() {
        site.boundary = if n >= 3 { Some(poly(xs, ys, n)) } else { None };
    }
}

/// Load a terrain raster (GeoTIFF, e.g. DHM/Terræn, or Esri ASCII grid) and add it as terrain, sampled every
/// `step` pixels (1 = full resolution). Returns the number of triangles added, or −1 on error (see cb_last_error).
#[no_mangle]
pub unsafe extern "C" fn cb_site_add_terrain_file(site: *mut Site, path: *const c_char, step: i32, design: i32) -> i32 {
    guard(-1, || {
        let site = site.as_mut().ok_or("site is null")?;
        if path.is_null() {
            return Err("path is null".into());
        }
        let p = CStr::from_ptr(path).to_string_lossy().to_string();
        let r = crate::raster::Raster::load(&p)?;
        let m = r.to_mesh(step.max(1) as usize);
        let n = (m.tris.len() / 3) as i32;
        if design != 0 {
            site.design_terrain.push(m)
        } else {
            site.terrain.push(m)
        }
        Ok(n)
    })
}

/// Add terrain from an in-memory GeoTIFF / ASCII grid (browser uploads). Returns triangles added or −1.
#[no_mangle]
pub unsafe extern "C" fn cb_site_add_terrain_bytes(site: *mut Site, bytes: *const u8, len: i32, step: i32, design: i32) -> i32 {
    guard(-1, || {
        let site = site.as_mut().ok_or("site is null")?;
        let r = crate::raster::from_bytes(s(bytes, len), "upload")?;
        let m = r.to_mesh(step.max(1) as usize);
        let n = (m.tris.len() / 3) as i32;
        if design != 0 {
            site.design_terrain.push(m)
        } else {
            site.terrain.push(m)
        }
        Ok(n)
    })
}

/// Read a terrain raster and return it as a mesh (for hosts that want to bake it). Caller frees with cb_mesh_free.
#[no_mangle]
pub unsafe extern "C" fn cb_raster_to_mesh(path: *const c_char, step: i32) -> *mut Mesh {
    guard(std::ptr::null_mut(), || {
        if path.is_null() {
            return Err("path is null".into());
        }
        let p = CStr::from_ptr(path).to_string_lossy().to_string();
        let r = crate::raster::Raster::load(&p)?;
        Ok(Box::into_raw(Box::new(r.to_mesh(step.max(1) as usize))))
    })
}

/// which: 0 = vertices (f64 xyz), returns count of doubles; 1 = triangles (i32), returns count of ints.
#[no_mangle]
pub unsafe extern "C" fn cb_mesh_copy(m: *const Mesh, which: i32, out_f64: *mut f64, out_i32: *mut i32, len: i32) -> i32 {
    let Some(m) = m.as_ref() else { return 0 };
    if which == 0 {
        copy_out(&m.verts, out_f64, len)
    } else {
        let t: Vec<i32> = m.tris.iter().map(|&x| x as i32).collect();
        copy_out(&t, out_i32, len)
    }
}

#[no_mangle]
pub unsafe extern "C" fn cb_mesh_free(m: *mut Mesh) {
    if !m.is_null() {
        drop(Box::from_raw(m));
    }
}

/// Export a per-cell array (len = nx·ny, south-up) for this grid as an Esri ASCII grid (OUT-10). Returns 1 on success.
#[no_mangle]
pub unsafe extern "C" fn cb_grid_export_ascii(g: *const Grid, values: *const f32, len: i32, path: *const c_char) -> i32 {
    guard(0, || {
        let g = g.as_ref().ok_or("grid is null")?;
        if path.is_null() || (len as usize) < g.len() {
            return Err("invalid arguments".into());
        }
        let p = CStr::from_ptr(path).to_string_lossy().to_string();
        crate::raster::write_ascii(std::path::Path::new(&p), g.nx, g.ny, g.x0, g.y0, g.dx, s(values, len), -9999.0).map_err(|e| e.to_string())?;
        Ok(1)
    })
}

// ------------------------------------------------------------------ grid

#[repr(C)]
pub struct GridInfo {
    pub nx: i32,
    pub ny: i32,
    pub x0: f64,
    pub y0: f64,
    pub dx: f64,
}

#[no_mangle]
pub unsafe extern "C" fn cb_grid_build(site: *const Site, palette_json: *const c_char, settings: *const GridSettings) -> *mut Grid {
    guard(std::ptr::null_mut(), || {
        let site = site.as_ref().ok_or("site is null")?;
        let pal = palette_from(palette_json)?;
        let st = settings.as_ref().copied().unwrap_or_default();
        Ok(Box::into_raw(Box::new(build_grid(site, pal, &st)?)))
    })
}

/// Caps cumulative infiltration per cell (mm), e.g. where groundwater is within 1 m of the surface. `caps_mm` has
/// one value per cell (row-major, as `cb_grid_copy_z`); negative = no cap. `len` 0 clears all caps.
/// Returns 1 on success, 0 on a null grid or a length mismatch.
#[no_mangle]
pub unsafe extern "C" fn cb_grid_set_infiltration_cap(g: *mut Grid, caps_mm: *const f32, len: i32) -> i32 {
    guard(0, || {
        let g = g.as_mut().ok_or("grid is null")?;
        if g.set_infiltration_cap(s(caps_mm, len)) {
            Ok(1)
        } else {
            Err(format!("infiltration cap: expected {} values, got {len}", g.len()))
        }
    })
}

#[no_mangle]
pub unsafe extern "C" fn cb_grid_free(g: *mut Grid) {
    if !g.is_null() {
        drop(Box::from_raw(g));
    }
}

#[no_mangle]
pub unsafe extern "C" fn cb_grid_info(g: *const Grid, out: *mut GridInfo) -> i32 {
    match (g.as_ref(), out.as_mut()) {
        (Some(g), Some(o)) => {
            *o = GridInfo { nx: g.nx as i32, ny: g.ny as i32, x0: g.x0, y0: g.y0, dx: g.dx };
            1
        }
        _ => 0,
    }
}

/// which: 0 terrain z, 1 hydraulic z.
#[no_mangle]
pub unsafe extern "C" fn cb_grid_copy_z(g: *const Grid, which: i32, out: *mut f32, len: i32) -> i32 {
    g.as_ref().map(|g| copy_out(if which == 0 { &g.terrain_z } else { &g.z }, out, len)).unwrap_or(0)
}

#[no_mangle]
pub unsafe extern "C" fn cb_grid_copy_material(g: *const Grid, out: *mut u16, len: i32) -> i32 {
    g.as_ref().map(|g| copy_out(&g.material, out, len)).unwrap_or(0)
}

#[no_mangle]
pub unsafe extern "C" fn cb_grid_copy_building(g: *const Grid, out: *mut i32, len: i32) -> i32 {
    g.as_ref().map(|g| copy_out(&g.building, out, len)).unwrap_or(0)
}

#[no_mangle]
pub unsafe extern "C" fn cb_grid_copy_active(g: *const Grid, out: *mut u8, len: i32) -> i32 {
    g.as_ref().map(|g| copy_out(&g.active, out, len)).unwrap_or(0)
}

#[no_mangle]
pub unsafe extern "C" fn cb_grid_warnings(g: *const Grid) -> *mut c_char {
    to_c(&g.as_ref().map(|g| g.warnings.join("\n")).unwrap_or_default())
}

#[no_mangle]
pub unsafe extern "C" fn cb_grid_retention(g: *const Grid, inp: *const RetentionInput, out: *mut RetentionResult) -> i32 {
    guard(0, || {
        let g = g.as_ref().ok_or("grid is null")?;
        let inp = inp.as_ref().ok_or("input is null")?;
        let (total, red) = reduced_area(g);
        if let Some(o) = out.as_mut() {
            *o = compute(total, red, inp);
        }
        Ok(1)
    })
}

#[no_mangle]
pub unsafe extern "C" fn cb_retention(total_area_m2: f64, reduced_area_m2: f64, inp: *const RetentionInput, out: *mut RetentionResult) -> i32 {
    match (inp.as_ref(), out.as_mut()) {
        (Some(i), Some(o)) => {
            *o = compute(total_area_m2, reduced_area_m2, i);
            1
        }
        _ => 0,
    }
}

// ------------------------------------------------------------------ rain

#[no_mangle]
pub unsafe extern "C" fn cb_rain_cds(return_period: f64, duration_min: f64, depth_mm: f64, step_s: f64, peak_position: f64, out: *mut f64, cap: i32) -> i32 {
    let r = RainSeries::cds(return_period, duration_min, depth_mm, step_s.max(1.0), peak_position);
    copy_out(&r.intensity_mm_h, out, cap)
}

#[no_mangle]
pub unsafe extern "C" fn cb_rain_box(depth_mm: f64, duration_min: f64, step_s: f64, out: *mut f64, cap: i32) -> i32 {
    let r = RainSeries::box_rain(depth_mm, duration_min, step_s.max(1.0));
    copy_out(&r.intensity_mm_h, out, cap)
}

#[no_mangle]
pub extern "C" fn cb_idf_depth_mm(duration_min: f64, return_period: f64) -> f64 {
    idf_depth_mm(duration_min, return_period)
}

// ------------------------------------------------------------------ instant

#[no_mangle]
pub unsafe extern "C" fn cb_instant_run(g: *const Grid, sc: *const Scenario) -> *mut InstantResult {
    guard(std::ptr::null_mut(), || {
        let g = g.as_ref().ok_or("grid is null")?;
        let sc = sc.as_ref().copied().unwrap_or_default();
        Ok(Box::into_raw(Box::new(run_instant(g, &sc))))
    })
}

#[no_mangle]
pub unsafe extern "C" fn cb_instant_free(r: *mut InstantResult) {
    if !r.is_null() {
        drop(Box::from_raw(r));
    }
}

#[no_mangle]
pub unsafe extern "C" fn cb_instant_stats(r: *const InstantResult, out: *mut InstantStats) -> i32 {
    match (r.as_ref(), out.as_mut()) {
        (Some(r), Some(o)) => {
            *o = r.stats;
            1
        }
        _ => 0,
    }
}

/// which: 0 depth (m), 1 flow accumulation (m³).
#[no_mangle]
pub unsafe extern "C" fn cb_instant_copy(r: *const InstantResult, which: i32, out: *mut f32, len: i32) -> i32 {
    r.as_ref().map(|r| copy_out(if which == 0 { &r.depth } else { &r.accumulation }, out, len)).unwrap_or(0)
}

#[no_mangle]
pub unsafe extern "C" fn cb_instant_copy_labels(r: *const InstantResult, out: *mut i32, len: i32) -> i32 {
    r.as_ref().map(|r| copy_out(&r.label, out, len)).unwrap_or(0)
}

#[no_mangle]
pub unsafe extern "C" fn cb_instant_copy_bluespots(r: *const InstantResult, out: *mut Bluespot, len: i32) -> i32 {
    r.as_ref().map(|r| copy_out(&r.bluespots, out, len)).unwrap_or(0)
}

#[no_mangle]
pub unsafe extern "C" fn cb_instant_path_count(r: *const InstantResult) -> i32 {
    r.as_ref().map(|r| r.paths.len() as i32).unwrap_or(0)
}

/// Copies path `idx` as packed (x, y, z, volume) quadruples. Returns the number of points.
#[no_mangle]
pub unsafe extern "C" fn cb_instant_copy_path(r: *const InstantResult, idx: i32, out: *mut f64, len: i32) -> i32 {
    let Some(r) = r.as_ref() else { return 0 };
    let Some(p) = r.paths.get(idx.max(0) as usize) else { return 0 };
    let flat: Vec<f64> = p.iter().flat_map(|q| q.iter().copied()).collect();
    copy_out(&flat, out, len) / 4
}

// ------------------------------------------------------------------ dynamic

#[cfg(target_arch = "wasm32")]
#[link(wasm_import_module = "env")]
extern "C" {
    /// Provided by the JavaScript host (web worker): return 0 to cancel.
    fn cb_host_progress(fraction: f64, time_s: f64, h_max: f64, elapsed_s: f64) -> i32;
}

fn host_progress(_p: &Progress) -> bool {
    #[cfg(target_arch = "wasm32")]
    return unsafe { cb_host_progress(_p.fraction, _p.time_s, _p.h_max_m, _p.elapsed_s) != 0 };
    #[cfg(not(target_arch = "wasm32"))]
    return true;
}

pub type ProgressCallback = Option<unsafe extern "C" fn(*const Progress, *mut c_void) -> i32>;

/// Runs the dynamic model synchronously (call it from a worker thread). The callback returns 0 to cancel.
#[no_mangle]
pub unsafe extern "C" fn cb_dynamic_run(g: *const Grid, sc: *const Scenario, rain_mm_h: *const f64, n_rain: i32, rain_step_s: f64, probes: *const i32, n_probes: i32, cb: ProgressCallback, user: *mut c_void) -> *mut DynamicResult {
    guard(std::ptr::null_mut(), || {
        let g = g.as_ref().ok_or("grid is null")?;
        let sc = sc.as_ref().copied().unwrap_or_default();
        let rain = RainSeries { intensity_mm_h: s(rain_mm_h, n_rain).to_vec(), step_s: rain_step_s.max(1.0) };
        let pr: Vec<usize> = s(probes, n_probes).iter().filter(|&&p| p >= 0).map(|&p| p as usize).collect();
        let res = run_dynamic(g, &sc, &rain, &pr, |p| match cb {
            Some(f) => f(p as *const Progress, user) != 0,
            None => host_progress(p),
        });
        Ok(Box::into_raw(Box::new(res)))
    })
}

#[no_mangle]
pub unsafe extern "C" fn cb_dynamic_free(r: *mut DynamicResult) {
    if !r.is_null() {
        drop(Box::from_raw(r));
    }
}

#[no_mangle]
pub unsafe extern "C" fn cb_dynamic_mass(r: *const DynamicResult, out: *mut MassBalance) -> i32 {
    match (r.as_ref(), out.as_mut()) {
        (Some(r), Some(o)) => {
            *o = r.mass;
            1
        }
        _ => 0,
    }
}

/// Infiltration breakdown of a dynamic run (sub-base storage, drainage, caps). Returns 1 on success.
#[no_mangle]
pub unsafe extern "C" fn cb_dynamic_permeability(r: *const DynamicResult, out: *mut PermeabilityStats) -> i32 {
    match (r.as_ref(), out.as_mut()) {
        (Some(r), Some(o)) => {
            *o = r.permeability;
            1
        }
        _ => 0,
    }
}

/// which: 0 h_max, 1 v_max, 2 hazard h(v+0.5), 3 h·v, 4 t_peak (s), 5 final depth,
/// 6 cumulative infiltration (m), 7 peak sub-base fill (0..1). Unknown values return the final depth.
#[no_mangle]
pub unsafe extern "C" fn cb_dynamic_copy(r: *const DynamicResult, which: i32, out: *mut f32, len: i32) -> i32 {
    let Some(r) = r.as_ref() else { return 0 };
    let src = match which {
        0 => &r.h_max,
        1 => &r.v_max,
        2 => &r.hazard_max,
        3 => &r.hv_max,
        4 => &r.t_peak,
        6 => &r.infiltrated,
        7 => &r.subbase_fill_max,
        _ => &r.h_final,
    };
    copy_out(src, out, len)
}

#[no_mangle]
pub unsafe extern "C" fn cb_dynamic_frame_count(r: *const DynamicResult) -> i32 {
    r.as_ref().map(|r| r.frames.len() as i32).unwrap_or(0)
}

#[no_mangle]
pub unsafe extern "C" fn cb_dynamic_frame_time(r: *const DynamicResult, i: i32) -> f64 {
    r.as_ref().and_then(|r| r.frame_times.get(i.max(0) as usize).copied()).unwrap_or(0.0)
}

#[no_mangle]
pub unsafe extern "C" fn cb_dynamic_copy_frame(r: *const DynamicResult, i: i32, out: *mut f32, len: i32) -> i32 {
    r.as_ref().and_then(|r| r.frames.get(i.max(0) as usize)).map(|f| copy_out(f, out, len)).unwrap_or(0)
}

#[no_mangle]
pub unsafe extern "C" fn cb_dynamic_probe_count(r: *const DynamicResult) -> i32 {
    r.as_ref().map(|r| r.probe_depth.len() as i32).unwrap_or(0)
}

/// Probe depth series (m) sampled every 60 s; returns the number of samples.
#[no_mangle]
pub unsafe extern "C" fn cb_dynamic_copy_probe(r: *const DynamicResult, i: i32, out: *mut f32, len: i32) -> i32 {
    r.as_ref().and_then(|r| r.probe_depth.get(i.max(0) as usize)).map(|p| copy_out(p, out, len)).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ffi_roundtrip() {
        unsafe {
            let site = cb_site_new();
            let m = Mesh::height_field(0.0, 0.0, 50.0, 40.0, 10, 8, |x, y| 0.02 * ((x - 25.0).powi(2) + (y - 20.0).powi(2)).sqrt());
            let tris: Vec<i32> = m.tris.iter().map(|&t| t as i32).collect();
            cb_site_add_terrain(site, m.verts.as_ptr(), m.verts.len() as i32, tris.as_ptr(), tris.len() as i32, 0);
            let st = GridSettings::default();
            let g = cb_grid_build(site, std::ptr::null(), &st);
            assert!(!g.is_null());
            let mut info = GridInfo { nx: 0, ny: 0, x0: 0.0, y0: 0.0, dx: 0.0 };
            cb_grid_info(g, &mut info);
            assert_eq!((info.nx, info.ny), (50, 40));
            let mut sc = Scenario::default();
            cb_scenario_default(&mut sc);
            let r = cb_instant_run(g, &sc);
            let mut stats = InstantStats::default();
            cb_instant_stats(r, &mut stats);
            assert!(stats.bluespot_count >= 1);
            let mut depth = vec![0f32; 2000];
            assert_eq!(cb_instant_copy(r, 0, depth.as_mut_ptr(), 2000), 2000);
            cb_instant_free(r);
            let mut rain = vec![0f64; 64];
            let nr = cb_rain_box(20.0, 10.0, 60.0, rain.as_mut_ptr(), 64);
            sc.after_rain_min = 5.0;
            let d = cb_dynamic_run(g, &sc, rain.as_ptr(), nr, 60.0, std::ptr::null(), 0, None, std::ptr::null_mut());
            assert!(!d.is_null());
            let mut mb = MassBalance::default();
            cb_dynamic_mass(d, &mut mb);
            assert!(mb.error_fraction.abs() < 1e-3);
            cb_dynamic_free(d);
            cb_grid_free(g);
            cb_site_free(site);
            let e = cb_grid_build(std::ptr::null(), std::ptr::null(), std::ptr::null());
            assert!(e.is_null());
            let msg = cb_last_error();
            assert!(CStr::from_ptr(msg).to_str().unwrap().contains("null"));
            cb_string_free(msg);
        }
    }
}
