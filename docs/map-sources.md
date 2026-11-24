# Map sources: terrain and site context

Where Cloudburst's terrain, buildings and surface materials come from, how good each source is for cloudburst
screening, and how to add another one. Code: `Web/js/sources/` (registry, readers, fetchers), `Web/js/dhm.js` (the
"find a place" dialog), `Web/serve.py` (local relay), `tools/fetch_dhm.py` (command line),
`Shared/cloudburst-core/src/raster.rs` (the engine's own file reader, used by Rhino/Revit).

> **Screening needs a bare-earth terrain (DTM) of about 1 m or finer.** Water in a cloudburst follows kerbs, gutters,
> ramps and courtyard openings that are 10–30 cm high and 1–3 m wide. A 25–30 m global DEM cannot see any of them; it
> only shows which way the whole neighbourhood drains. The app labels every source with a suitability rating and says
> so when a coarse source is used.

## Sources

| Source | Coverage | Native resolution | Vertical | Model | CRS / datum | Licence & attribution | Key | Browser | Suitability | Verified |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **DHM/Terræn** (`dk-dhm`) – Klimadatastyrelsen (formerly SDFI) via Datafordeler WCS or Dataforsyningen WCS | Denmark | 0.4 m | ≈ 5 cm | DTM: buildings removed, **bridge decks kept** | EPSG:25832, DVR90 | Free Danish geodata terms; attribution "Contains data from Klimadatastyrelsen, Danmarks Højdemodel" | Yes (free) | Local relay `serve.py` or desktop app; direct only if the service sends CORS | **Good** | Documentation + mocked WCS only (no key available) |
| **Your own file** (`upload`): GeoTIFF / BigTIFF / COG, Esri ASCII `.asc`, gridded XYZ | Anywhere | as supplied | as supplied | as supplied | from GeoTIFF keys or `.prj`; lat/lon and Web Mercator are reprojected to UTM | the data owner's | No | Works offline | Good if a ≤ 1 m DTM | Synthetic fixtures (10 TIFF variants, ASC, XYZ) in Chromium and Node |
| **AWS Terrain Tiles** (`terrain-tiles`) – Mapzen/Tilezen Joerd, Terrarium PNG | Global | mosaic, reported per download from `x-amz-meta-x-imagery-sources`: EU-DEM 25 m / SRTM 30 m in most of Europe, Kartverket 10 m in Norway, 3DEP 3–10 m in the US, EA LiDAR 2 m in England | metres (EU-DEM ≈ 7 m RMSE) | mostly DTM-ish, partly surface | Web Mercator → local UTM; mostly EGM96 | Mixed open licences, attribution required: [joerd attribution](https://github.com/tilezen/joerd/blob/master/docs/attribution.md) | No | Yes (CORS) – works on GitHub Pages | **Not suitable** below 10 m; overview only | **Live** (Copenhagen → EU-DEM 25 m; Oslo → Kartverket 10 m) |
| **Copernicus DEM GLO-30** (`copernicus-glo30`) – ESA/Airbus, AWS Open Data COGs | Global | 30 m (1″) | ≈ 4 m abs. | **DSM** (radar: buildings/trees partly in it) | EPSG:4326 → local UTM; EGM2008 | Copernicus DEM licence, attribution "© DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA; all rights reserved" | No | Only through `serve.py` (`/proxy/copernicus/…`) or the desktop app: the bucket has no CORS | **Not suitable**; overview / sanity check | **Live** (direct and through `serve.py`, HTTP range reads: 1.1 MB for a 400 m site) |
| **OpenStreetMap** (`osm`) via Overpass API – buildings, land cover, roads, bridges | Global, quality varies | vector | – | footprints, polygons, buffered lines | WGS84 → terrain CRS | ODbL 1.0: "© OpenStreetMap contributors"; share-alike for derived databases | No | Yes (CORS), or `serve.py` `/proxy/overpass` | Footprints: good in DK cities. Materials: partial (gardens/yards rarely mapped) | Recorded-style fixture only: **Overpass was unreachable from the development sandbox** |
| Synthetic samples (engine `samples.rs`) | – | 1 m | exact | design model | local metres | MIT (this repo) | No | Offline | Demo only | Existing tests |
| Rhino / Revit model geometry (`RhinoHost.cs`, `RevitHost.cs`) | the model | mesh density | model | whatever is modelled: meshes/surfaces (Rhino), Toposolid/topography/floors/imports (Revit) | model units → metres | – | No | – | Good if modelled well | Not changed (no dotnet here) |
| DHM files in Rhino/Revit ("Import DHM terrain", engine `raster.rs`) | – | as the file | – | – | from the file | – | – | – | – | Rust unit tests on the fixtures |

Every terrain source in the app carries this metadata in `Web/js/sources/registry.js` (`SOURCES`): `nativeResM`,
`verticalAccuracyM`, `model`, `crs`, `verticalDatum`, `licence`, `attribution`, `licenceUrl`, `keyRequired`,
`browser`, `status` (`live` / `fixtures` / `docs`), `note`. `suitability(source, {cellSize, nativeResM})` returns
`good | fair | poor | unsuitable` with a sentence for the user (≤ 1 m good; ≤ 2.5 m fair; ≤ 10 m poor; coarser
unsuitable; a DSM is at most "poor").

### Reviewed but not implemented

| Candidate | Why not (yet) |
| --- | --- |
| Norway – Kartverket hoydedata NHM DTM 1 m (WCS, keyless) | Host blocked in the development sandbox; coverage ids and CORS unverified. Upload a GeoTIFF from hoydedata.no meanwhile. Terrain Tiles already uses Kartverket 10 m. |
| Netherlands – AHN4 0.5 m (PDOK WCS, keyless) | Not reachable from the sandbox; would slot in as a WCS source like DHM. |
| England – EA LiDAR composite DTM 1 m (keyless) | Same. |
| Sweden – Lantmäteriet Markhöjdmodell 1 m | Needs an API key / agreement. |
| Denmark – GeoDanmark / BBR buildings | Authoritative footprints; needs the Datafordeler key and a WFS client. OSM is used instead. |
| OpenTopography global DEM API | Needs a key; same 30 m data as Copernicus. |
| LAS / LAZ point clouds | LAZ needs a decompressor; grid them first (PDAL, CloudCompare, `lasgrid`) to GeoTIFF. |

## How terrain reaches the engine (web app)

1. **Read** (`readTerrainFile`, `tiff.js`, `textgrid.js`): classic TIFF and BigTIFF, II/MM, strips or tiles, chunky or
   planar bands (band 1), uint/int/float 8–64 bit, no compression / LZW / Deflate / PackBits, predictor 1/2/3,
   `ModelPixelScale`+`ModelTiepoint` or a non-rotated `ModelTransformation` (south-up files are flipped), PixelIsPoint,
   EPSG of the projected/geographic CRS, linear and vertical units (feet → metres), vertical CRS (DVR90, EGM96, …),
   `GDAL_NODATA`. Files without a NoData tag: heights below −1000 m or above 9000 m (−9999, −32768, −3.4e38 fills) are
   no-data, with a warning. Reading is lazy (`BlobSource`, `HttpRangeSource`), so only the needed strips/tiles are
   decoded; windows over 40 M pixels are cut to the central part with a warning. JPEG/LERC/ZSTD/WebP compression and
   rotated rasters fail with an explanation. Overviews are ignored on purpose (GDAL's default overviews are nearest
   neighbour).
2. **Reproject** (`gridops.reproject`) only when the raster is geographic or Web Mercator: to EPSG:25832 inside Denmark,
   otherwise the local WGS84 UTM zone (Krüger series, mm-accurate; ETRS89 ≡ WGS84 at < 1 m). Metric projected files
   stay in their own CRS.
3. **Aggregate** (`gridops.aggregate`) to the grid cell size (1/2/4/8 m, the same rule as the app: the smallest under
   900 000 cells), on a grid snapped to multiples of the cell size. Each cell uses **all** source pixels whose centres
   fall in it; cells with < 50 % data are no-data (inactive). Methods: `mean` (default: unbiased bluespot volumes),
   `min` (keeps gutters and channels connected), `max` (keeps kerbs and low walls as barriers), `nearest` (comparison
   only). Coarser sources are interpolated bilinearly instead, with a warning.
4. **Encode** (`gridops.engineRaster` + `tiff.writeGeoTiff`) at half the cell size so that the engine's cell centres
   land exactly on the prepared values (test: "engine receives exactly the prepared cell values").
5. OSM buildings / surfaces / bridge cut-outs (when fetched) are added to the site description; the app draws the
   footprints as vector buildings.

`prepareSiteDesc(siteDesc, info)` does steps 1–5 and is called once from `loadGrid` in `app.js`. Context that must
survive the app's `{terrainBytes}` hand-over (source info, OSM layers) is attached to the byte array with
`attachContext(bytes, …)`; bytes produced by `prepareSiteDesc` are recognised and never re-aggregated.

### Danish product choice

DHM/Terræn is the right base model: a 0.4 m DTM with buildings removed. Two things the user must add:
**buildings** (water flows around them; OSM footprints are added automatically when the box is ticked, or model them)
and **bridge cut-outs** (DHM keeps bridge decks, which act as dams across the road or stream below; OSM `man_made=bridge`
areas and `bridge=yes` road/rail lines are turned into cut-outs automatically). DHM/Overflade (surface model) is
offered but is not for flow. A hydrologically adapted model (bridges and culverts opened, as used for the official
"bluespot" maps) would be better still; whether the WCS offers one, and under which name, is not documented here, so
the dialog has **List products** (GetCapabilities) and flags names that look hydrological. `fetch_dhm.py --list` /
`--hydro` do the same. The service path is `…/DHMNedboer/dhm_wcs/…` – its coverage list is the place to check.

## Adding a source

1. Write a fetcher in `Web/js/sources/<name>.js` that returns a raster object
   `{width, height, data: Float32Array (row 0 = north, NaN = no data), x0, yTop, dx, dy, epsg, kind, verticalCrs, warnings, meta}`.
   Reuse `readGeoTiff` (with `HttpRangeSource` for COGs) or `parseAsciiGrid`.
2. Add a metadata entry to `SOURCES` in `registry.js` (all fields; set `status` honestly) and a branch in
   `fetchTerrain`. If the browser cannot reach it (no CORS), add a fixed-upstream route to `serve.py` (never a generic
   proxy) and use it when `hasProxy()` is true.
3. If it needs its own entry on the start page, register it with `addSiteSource` from `js/hooks.js` in
   `Web/js/sources/ui.js` (see `world-terrain`). Sources that fit the map dialog only need to be in `SOURCES`: the
   dialog's source list is built from it.
4. Add tests to `Web/tests/sources.test.mjs` (mock `fetchFn`) and a row to the table above.

Run the tests: `node --test Web/tests/*.test.mjs` (fixtures: `python3 tools/make_terrain_fixtures.py`),
`python3 tools/test_fetch_dhm.py`, `cd Shared/cloudburst-core && cargo test --release`.

## Known limitations

* The engine stores everything in one metric CRS per site; the 2D map has no background tiles, so a wrong CRS shows
  only as misplaced OSM footprints. Files with an unknown or non-UTM CRS (e.g. British National Grid) are used in their
  own metres and cannot be combined with OSM.
* Vertical datums are reported, not converted. Fine for one source per site (flow depends on relative heights); do not
  mix sources (e.g. DVR90 terrain with an EGM2008 DEM) in one site.
* OSM materials: blocks with unmapped yards keep the default material; road widths are typical values per road class;
  building heights default to 8 m (the engine raises anything lower than +5 m anyway).
* Terrain Tiles and Copernicus are 25–30 m. The app says so, but it does not stop anyone using them.
* The Rhino/Revit "Import DHM terrain" path meshes each file separately: neighbouring DHM tiles leave a gap of one
  pixel (× step) between them, whose cells become inactive (no rain on them, height copied from a neighbour). Mosaic
  files first (`fetch_dhm.py` now delivers one mosaicked file per area).

## Review findings

Ranked by severity. "Fixed" means fixed in code with a test.

| # | Finding | Severity | Status |
| --- | --- | --- | --- |
| 1 | **The engine's GeoTIFF reader ignored all georeferencing and NoData.** `raster.rs` looked the GeoTIFF tags up as `Tag::Unknown(33550)` etc., but the `tiff` crate stores them under named variants (`ModelPixelScaleTag`, …), so every lookup failed silently: every GeoTIFF (DHM included) was read as 1 m pixels at origin (0, 0). A 0.4 m DHM became a site 2.5 × too large with slopes 2.5 × too flat (flow paths, velocities and the dynamic model all affected), was placed at the wrong location (Rhino/Revit imports far from the model), and `GDAL_NODATA` was never applied (−9999 fill would become deep pits). | Critical | **Fixed** in `raster.rs` (+ ModelTransformation, south-up, PixelIsPoint, NaN NoData); Rust test on the fixtures. `Web/engine/cloudburst_core.wasm` rebuilt. The **Windows DLL in `Shared/cloudburst-core/prebuilt/win-x64/` is NOT rebuilt** (no mingw here). |
| 2 | Point sampling: 0.4 m DHM was meshed at full resolution and the engine sampled it at 1 m cell centres (≈ nearest neighbour). Kerbs and gutters were hit or missed at random; results shifted with the extent. | High | **Fixed** (web): aggregation with mean/min/max in `gridops.aggregate`, exact alignment. Hosts still point-sample (C#/Rust `TerrainFileStep` = every n-th pixel). |
| 3 | Memory: full-resolution meshing in wasm (a 1500 m DHM square = 14 M pixels → ≈ 700 MB of mesh) plus retries at 1/2/4/8 m. | High | **Fixed** (web): the engine gets a raster at the grid cell size; one build. |
| 4 | Grid origin shifted by half a source pixel and the outer half pixel lost (the engine's grid starts at the first pixel centre). | Medium | **Fixed** (web) by the alignment encoding. |
| 5 | DHM bbox not snapped to the 0.4 m lattice (server resampled half a pixel off; requested pixel size not exact for most sizes), no tiling (1500 m at 0.4 m = 3750 px per side, likely above the WCS limit). | Medium | **Fixed**: snap to 8 m, tiles ≤ 2000 px, seamless mosaic (web and `fetch_dhm.py`). |
| 6 | "0.8 / 1.6 m" options are server-side resampling (WCS nearest neighbour by default), not averaging. | Medium | Labelled "server-resampled"; 0.4 m + client aggregation remains the default. |
| 7 | No buildings for real sites: DTM without buildings means water flows straight through blocks. | High | **Fixed** when the OSM box is ticked (footprints with courtyards kept open). Uploaded files: not yet (UI wiring, see below). |
| 8 | Every cell of a real site got the default material (lawn), under-estimating runoff in cities. | High | **Partly fixed**: OSM land cover / roads / parking / water → palette materials. Unmapped yards still default. |
| 9 | Bridge decks in DHM act as dams; cut-outs had to be drawn by hand and the web engine glue could not take them. | Medium | **Fixed**: OSM bridges → `bridgeCuts`, passed by `cloudburst-wasm.js` to `cb_site_add_bridge_cut`. |
| 10 | Geographic (lat/lon) or Web Mercator uploads were treated as metres (cells of 0.0001 "m"). | High | **Fixed**: reprojected to UTM. |
| 11 | Formats: tiled/compressed/BigTIFF/multi-band handled only as far as the `tiff` crate goes (2-band files failed); no XYZ. | Medium | **Fixed** (web): own reader, all variants above; XYZ added. |
| 12 | Files without a NoData tag: −9999 passed the engine's validity range (−1e4 … 1e5). | Medium | **Fixed** (web: heuristic with warning). Rust keeps its range check. |
| 13 | Denmark only; no keyless option elsewhere. | Medium | **Added** Terrain Tiles (CORS, live) and Copernicus GLO-30 (relay, live), both labelled unsuitable for site screening; uploads cover national LiDAR. |
| 14 | No source metadata, licence or attribution anywhere in the UI. | Medium | **Fixed** in the registry and the dialog; `info.attribution` is set on every fetched site. Not yet printed in map captions/reports (UI). |
| 15 | Error messages: HTML/XML service exceptions were shown raw; CORS failure message only for DHM. | Low | **Fixed**: readable messages, key-rejected detection, product-not-offered detection. |
| 16 | Seams between separately imported DHM tiles in Rhino/Revit (inactive one-cell strips). | Low–Medium | Not fixed (C#/engine change); mitigated by `fetch_dhm.py` mosaics. |
| 17 | GDAL_NODATA "nan" would have made every cell invalid in the engine once tags were read. | Low | **Fixed** with #1. |
| 18 | DHM product: DHM/Terræn is correct for a DTM; a hydrologically adapted product is not used. | Info | "List products" / `--hydro` let the user pick one if offered; unverified. |
