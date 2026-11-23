//! # cloudburst-core
//!
//! Rainwater / cloudburst screening engine shared by the Rhino 8, Grasshopper and Revit 2026 plugins
//! (through the C ABI in [`ffi`]) and usable from Rust directly (server, CLI, wasm).
//!
//! * [`grid`] — site description → uniform raster (terrain, buildings, kerbs, materials, soils).
//! * [`instant`] — M1: priority-flood bluespots, fill–spill routing, MFD flow paths. < 1 s for 1 M cells.
//! * [`dynamic`] — M2: local-inertial 2D shallow-water solver, rain-on-grid, Horton infiltration, sewer loss.
//! * [`rain`] — indicative Danish IDF, CDS and box rain.
//! * [`retention`] — reduced area, rational peak and required storage.
//!
//! Screening model — not for permit or compliance evidence.

pub mod dynamic;
pub mod ffi;
pub mod geometry;
pub mod grid;
pub mod hydro;
pub mod instant;
pub mod palette;
pub mod rain;
pub mod raster;
pub mod retention;

pub use dynamic::{run_dynamic, DynamicResult, MassBalance};
pub use grid::{build_grid, Grid, GridSettings, Site};
pub use hydro::Scenario;
pub use instant::{run_instant, InstantResult};
pub use rain::RainSeries;
