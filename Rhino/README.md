# Cloudburst for Rhino 8 and Grasshopper

Rhino 8 plug-in (`Cloudburst.Rhino.rhp`) and Grasshopper components (`Cloudburst.Grasshopper.gha`) for the
Cloudburst rainwater / cloudburst flood screening tool. Both use the shared engine (`Shared/Cloudburst.Net` with the
Rust `cloudburst_core.dll`); the Rhino plug-in also hosts the shared WPF UI (`Shared/Cloudburst.UI`).

```
Rhino/
  Common/RhinoConvert.cs          Rhino geometry <-> Cloudburst types (metres), native dll preloader. Linked into both projects.
  Cloudburst.Rhino/               .rhp: plug-in, commands, RhinoHost (ICloudburstHost), display conduit
  Cloudburst.Grasshopper/         .gha: goo types, icons, 9 components
  dist/<Configuration>/           everything in one folder after a build (rhp, gha, Cloudburst.*.dll, cloudburst_core.dll)
```

## Build

Requires the .NET 8 SDK (builds `net7.0-windows`; on Linux/macOS `EnableWindowsTargeting` is already set in
`Directory.Build.props`). The native engine must have been built first
(`Shared/cloudburst-core/target/x86_64-pc-windows-gnu/release/cloudburst_core.dll` or the `-msvc` equivalent).

```bash
dotnet build Rhino/Cloudburst.Rhino/Cloudburst.Rhino.csproj -c Release
dotnet build Rhino/Cloudburst.Grasshopper/Cloudburst.Grasshopper.csproj -c Release
```

Each build copies its output to `Rhino/dist/Release/`:

| File | What |
|---|---|
| `Cloudburst.Rhino.rhp` | Rhino plug-in |
| `Cloudburst.Grasshopper.gha` | Grasshopper components |
| `Cloudburst.Net.dll` | managed engine wrapper |
| `Cloudburst.UI.dll` | shared WPF UI |
| `cloudburst_core.dll` | native engine (only Windows system DLLs as dependencies) |

The native DLL flows from `Cloudburst.Net.csproj` (`None` item with `CopyToOutputDirectory`). At run time
`Cloudburst.Net` resolves it from its own folder; in addition the plug-in and the .gha preload it from their
folder, so **keep all files in one folder**.

## Install

**Yak package (easiest)**: drag `cloudburst-<version>-…-win.yak` (from the GitHub release, or built with
`./Rhino/pack-yak.ps1` after `./build.ps1`) onto a Rhino 8 window and restart Rhino. It installs the plug-in, the
Grasshopper components and the engine DLLs together under `%AppData%\McNeel\Rhinoceros\packages\8.0\cloudburst`.
Command line: `"C:\Program Files\Rhino 8\System\Yak.exe" install cloudburst-<version>-…-win.yak`. Remove any manually
installed copy first, so the plug-in is not registered twice. The manifest is `Rhino/yak/manifest.yml`.

**Rhino plug-in**: drag `Cloudburst.Rhino.rhp` onto a Rhino 8 window, or *Tools → Options → Plug-ins → Install…*
(PlugInManager). It loads at start-up and prints `Cloudburst … loaded (engine x.y.z)` on the command line.

**Grasshopper** (either):
- copy `Cloudburst.Grasshopper.gha`, `Cloudburst.Net.dll` and `cloudburst_core.dll` into the Grasshopper
  Components folder (*File → Special Folders → Components Folder*) and restart Rhino; or
- keep the `.gha` next to the `.rhp` (e.g. `Rhino/dist/Release`) and add that folder with the
  `GrasshopperDeveloperSettings` command (untick *Memory load \*.GHA assemblies using COFF byte arrays*).

The components appear under the **Cloudburst** tab: `1 Grid`, `2 Materials`, `3 Rain`, `4 Solve`, `5 Results`, `6 Compare`.

## Commands

| Command | |
|---|---|
| `Cloudburst` | Opens (or brings to front) the Cloudburst window. Closing the window only hides it; state is kept for the session. |
| `CloudburstDemo` | Builds the 300 × 200 m demo block on layers `Cloudburst Demo::…` (terrain mesh, building extrusions, surface outlines per material, kerbs) and registers it as the current picks. Re-running replaces the previous demo. |
| `CloudburstClear` | Removes the result preview from the viewports. |

Notes:
- All units are converted: the engine works in metres, the document can be in mm, cm, m, ft …
- Picks are stored as user text (`cloudburst.role`, `cloudburst.material`, `cloudburst.height`) on the objects,
  so they survive saving and are restored when the file is reopened. Surfaces without an explicit material are
  guessed from user text → object name → layer path → render material (English and Danish keywords).
- *Bake* writes the current result to `Cloudburst::<title>` (mesh with vertex colours, `Flow paths`, `Labels`,
  `Legend` sublayers) in one undo step.

## Grasshopper components

| Sub | Component | Inputs → outputs |
|---|---|---|
| 1 Grid | Build Grid | terrain, design terrain, buildings, regions, walls + kerb height, bridge cuts, boundary, cell size, soil, palette file → Grid, info, material preview mesh |
| 2 Materials | Material Palette | (palette file) → ids, names, colours, C sand/clay, Manning n |
| 2 Materials | Material Region | geometry + material id/name + soil class → Region |
| 3 Rain | Rain Event | preset 0–3 or custom depth/duration/shape, T, CF → Rain, info, time/intensity lists for charting |
| 4 Solve | Solve Instant | grid, rain, sewer, moisture, min depth → result, depth mesh, flow paths, bluespots (points, volume, depth, area, spill rain), stats |
| 4 Solve | Solve Dynamic | grid, rain, **Run**, after-rain minutes, probes → result, max-depth mesh, mass balance, probe series (tree), probe times. Runs in the background with progress under the component; changing inputs cancels the run. |
| 4 Solve | Retention | grid, T, CF, l/s/ha, safety → reduced area, peak l/s, required m³ |
| 5 Results | Result Layer | result + Depth/DepthAtTime/Velocity/Hazard/TimeToPeak/FlowAccumulation + frame → mesh, legend, colours, title, caption |
| 6 Compare | Compare Options | result A, result B → difference mesh, volumes, change, areas > 10 cm |

## 2-minute demo script

**Rhino (≈ 75 s)**
1. New file (Large Objects – Meters). Type `Cloudburst` – the window opens docked next to the viewport.
2. Click **Demo site** (or type `CloudburstDemo`): terrain, six buildings, street with kerbs, plaza, park and
   rain garden appear, coloured by material; the viewport zooms to the site. *"These are ordinary Rhino objects –
   in a real project you pick your own terrain, buildings and surfaces, the material is guessed from layer names."*
3. **Build grid** (1 m cells) → **Instant** with *T = 100 years (cloudburst)*: blue bluespots appear at the water
   surface, labelled with volume and depth; flow paths in blue get thicker downstream. Point at the legend card
   (top-left) and the *SCREENING MODEL* caption (bottom-left).
4. Change the rain to *2011 test* – the instant result updates in about a second.
5. Start the **Dynamic** run; while it runs, orbit the model (Rhino stays responsive). Switch the layer to
   *Hazard* and *Time to peak*.
6. **Bake** – the result becomes layers `Cloudburst::…` with a legend, ready for layouts.

**Grasshopper (≈ 45 s)** – have a definition ready:
`Build Grid` (terrain = demo terrain mesh, buildings = extrusions, regions from `Material Region` per surface
layer) → `Rain Event` (preset slider 0–3) → `Solve Instant` → `Result Layer`.
1. Drag the preset slider: bluespots and stats update live.
2. Move a building or draw a closed curve as a new rain garden (`Material Region`, material `rain_garden`) and wire
   both solve results into `Compare Options`: green = drier, red = wetter, with the volume change.
3. Toggle `Run` on `Solve Dynamic`: the percentage counts up under the component while the canvas stays usable.

## Known limitations

- Compare takes two results (instant or dynamic) – not raw meshes.
- Probe times are reconstructed (the engine samples every 60 s; `Cloudburst.Net` does not expose probe times).
- Large grids (> 1.5 M cells) skip the Grasshopper material preview mesh.
