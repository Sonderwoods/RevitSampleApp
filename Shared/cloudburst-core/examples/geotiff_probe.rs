//! Print how the engine reads terrain rasters (georeferencing, size, no-data):
//! `cargo run --release --example geotiff_probe -- file.tif other.asc`
fn main() {
    for p in std::env::args().skip(1) {
        match cloudburst_core::raster::Raster::load(&p) {
            Ok(r) => println!("{p}: {}x{} x0 {} y_top {} dx {} dy {} nodata {:?} first {}", r.nx, r.ny, r.x0, r.y_top, r.dx, r.dy, r.nodata, r.data[0]),
            Err(e) => println!("{p}: ERR {e}"),
        }
    }
}
