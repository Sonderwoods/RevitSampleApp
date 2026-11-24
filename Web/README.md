# Cloudburst web app


## Start it (Windows)

Double-click **`Cloudburst Web.bat`** in the repo root. It starts `serve.py` and opens the browser.
`Cloudburst Web (app window).bat` opens it in a chromeless Edge/Chrome app window instead.
Close the console window to stop the server.

## Install as an app (Edge / Chrome)

The app is a PWA (manifest + service worker), and `http://localhost` counts as a secure origin, so with the server
running: Edge → `…` menu → **Apps → Install this site as an app** (Chrome: install icon in the address bar).
You then get a Start-menu entry, a taskbar icon and its own window. The app shell and the engine are cached, so the
synthetic samples also work offline. The server must still run for DHM downloads, and the port must stay the same
(the installed app is tied to `localhost:8123`).
Tauri or Electron would only be needed for a single installer `.exe` that doesn't need Python.

## API key for real terrain

Real Danish terrain needs a free **Datafordeler API key** from **https://portal.datafordeler.dk/hjem**
(log in with MitID/NemID or e-mail). Step by step: [../docs/DHM_API_KEY.md](../docs/DHM_API_KEY.md).

## GitHub Pages

`.github/workflows/pages.yml` publishes `Web/` as a static site. One-time setup in the repository: Settings → Pages →
Source **GitHub Actions**. If you deploy from a non-default branch, allow that branch under Settings → Environments →
github-pages. On Pages, DHM downloads go straight from the browser to Datafordeler. If the browser blocks that (CORS),
use the desktop app or `Cloudburst Web.bat`.

## Pick a location (DHM terrain from an API key)

Run the app with `python serve.py` (not `python -m http.server`). It serves the files and relays DHM requests to
Datafordeler/Dataforsyningen, so the browser's CORS rules don't block the download.

On the start page, under **Your own site**, click **Find a place in Denmark**:
1. Search an address (OpenStreetMap search) or click the map to place the square, then pick its size.
2. Paste a **Datafordeler API key** or a **Dataforsyningen token**. If you tick "Remember", it is kept only in your browser.
3. Click **Download terrain & open**. DHM/Terræn is downloaded as a GeoTIFF and opened as a new site.

The same dialog has a **Terrain source** list. Outside Denmark (start page: **Find a place outside Denmark**) it
offers keyless global elevation: **AWS Terrain Tiles** (works anywhere, also on GitHub Pages) and **Copernicus DEM
GLO-30** (needs `serve.py` or the desktop app). Both are 10–30 m and the dialog marks them *not suitable for site
screening*: use them for an overview, and upload a national LiDAR terrain for real work. Tick **Add buildings & land
cover from OpenStreetMap** to get building footprints, surface materials from land use / roads, and bridge cut-outs.
Sources, licences and limits: [../docs/map-sources.md](../docs/map-sources.md).

Real-site cards (Tåsinge Plads, …) open a page with a **Download terrain…** button and a drop zone for a terrain
file. The key is never written to disk by the server and is not logged.

## Terrain files

Drop or choose a **GeoTIFF** (any common variant: tiled or striped, LZW/Deflate/PackBits, int16/float32/float64,
BigTIFF, Cloud Optimized), an **Esri ASCII grid** (`.asc`) or a gridded **XYZ** file (`.xyz`, `.csv`, `.txt`). The
terrain is decoded in the browser, reprojected when it is in lat/lon or Web Mercator, and averaged onto the 1–8 m grid
(every source pixel counts; the old path sampled one pixel per cell). Nothing is uploaded anywhere. LAS/LAZ point clouds
must be gridded to GeoTIFF first.

`serve.py` also relays Copernicus DEM tiles (`/proxy/copernicus/…`, with HTTP range requests) and the Overpass API
(`/proxy/overpass`), to fixed upstreams only.

Tests for the import modules: `node --test Web/tests/*.test.mjs` (fixtures: `python3 tools/make_terrain_fixtures.py`).

## How the app is laid out (for contributors)

The workspace's left panel is the job in six numbered steps: **Site → Rain → Surfaces & drainage → Run → Compare
designs → Export** (`#step-site`, `#step-rain`, `#step-surfaces`, `#step-run`, `#step-compare`, `#step-export`). The map
is in the middle, results on the right. New site sources and export actions are added through `js/hooks.js`
(`addSiteSource`, `addExportAction`), not by editing `app.js`. Plain-language explanations of technical terms live in
`js/terms.js`. The UX review is in [../docs/reviews/ux-review.md](../docs/reviews/ux-review.md).
