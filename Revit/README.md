# Cloudburst for Revit 2026

Revit 2026 add-in for the Cloudburst rainwater / cloudburst flood screening tool. It hosts the shared WPF UI
(`Shared/Cloudburst.UI`) in a dockable pane and implements `ICloudburstHost` with the Revit API. The engine is
`Shared/Cloudburst.Net` with the native Rust core `cloudburst_core.dll`.

## Build

```bash
dotnet build Revit/Cloudburst.Revit -c Release
```

This works on Windows and on Linux (Linux only compiles: `EnableWindowsTargeting` is set in `Directory.Build.props`).
The Revit API comes from the `Nice3point.Revit.Api.RevitAPI/RevitAPIUI 2026.*` reference packages, so you don't need Revit to build.
The output folder `bin/Release/net8.0-windows/` contains:

| File | What it is |
|---|---|
| `Cloudburst.Revit.dll` | the add-in (App, commands, RevitHost) |
| `Cloudburst.Net.dll` | the engine wrapper |
| `Cloudburst.UI.dll` | the shared WPF panel |
| `cloudburst_core.dll` | the native engine (x64 Windows) |
| `Cloudburst.addin` | the manifest (it points to `Cloudburst\Cloudburst.Revit.dll`) |
| `install.ps1` | the per-user installer |

## Install

Close Revit, then use one of these:

* `powershell -ExecutionPolicy Bypass -File Revit\Cloudburst.Revit\bin\Release\net8.0-windows\install.ps1`
* `dotnet build Revit/Cloudburst.Revit -c Release -p:DeployToRevit=true` (Windows only)

Both copy `Cloudburst.addin` to `%AppData%\Autodesk\Revit\Addins\2026\` and the DLLs to
`%AppData%\Autodesk\Revit\Addins\2026\Cloudburst\`. To remove the add-in, run `install.ps1 -Uninstall`.
The first time Revit starts with the add-in, it asks whether to load it. Choose **Always Load**.

## Ribbon: tab **Cloudburst**, panel **Rainwater**

| Button | Action |
|---|---|
| **Cloudburst** | Show or hide the dockable Cloudburst panel (right side, about 400 px wide). Works without an open project. |
| **Demo site** | Build the 300 × 200 m demo block, centred on the project origin, and register it as the current picks. It creates a Toposolid terrain (from points on a 4 m grid), 6 buildings as Generic Model DirectShapes, coloured surface-material outlines and kerb lines draped on the terrain. It also opens or zooms the `{3D}` view. Running it again replaces the previous demo. |
| **Clear preview** | Delete the result preview (DirectShapes tagged `CloudburstPreview`). Baked results stay. |
| **Window** | Fallback: opens the same UI as a modeless floating window owned by Revit. |

**Use the Revit model** (button at the top of *Site geometry*) fills in the site without picking:

* **Terrain**: every Toposolid (not its sub-divisions) and legacy topography.
* **Buildings**: roofs, floors and walls, plus masses and generic models (context buildings). Roofs and floors give the building tops, walls the outline. Parts lower than the
  *building minimum height* above the terrain (ground slabs, low walls) are not treated as buildings.
* **Surface materials**: the Revit material of the top face of each Toposolid and sub-division, and of each roof
  (e.g. a green roof), matched to the Cloudburst palette by name (English and Danish keywords). So the workflow is:
  give the toposolid, its sub-divisions and the roofs the right Revit materials, then press the button.
* It reads what is visible in the active 3D or plan view (phases, design options, hidden elements and section boxes are
  respected). From any other view it reads the whole model.
* **Linked models are always included**: every loaded Revit link (visible in that view) is read in full and placed with
  the link's position, including links nested inside links. Unloaded links are skipped with a log message.
* If no terrain is found, the message lists what the model and each link contain (toposolids, topography, masses …).

Picking by hand still works and overrides it. For terrain, buildings and surfaces you can also pick a **linked model**:
it stands for all the terrain / buildings / toposolids inside that link. How each pick role works in Revit:

* **Terrain / design terrain**: select Toposolids, legacy topography, floors, DirectShapes or imported DWG/IFC meshes. The add-in uses the faces that point up.
* **Buildings**: select walls, roofs, floors, masses, generic models, families or DirectShapes. The add-in uses the full solid geometry.
* **Surfaces**: select floors, Toposolids or sub-divisions, roofs or DirectShapes. It uses the top-face triangles. The material comes from the top-face material name, then the type name, then the element name, then the category, matched with the palette keywords (English and Danish). If nothing matches, it uses the palette default. Picks accumulate. Picking an element again replaces its material.
* **Walls / kerbs**: select model or detail lines (height comes from the UI) or walls (their location line, with the same height).
* **Bridge cuts / boundary**: select closed loops of model lines (they are chained automatically) or floors (their outline is used).
* **Probes**: click points with `PickPoint` and press Esc to finish. A plan view works best. In 3D views a work plane is added automatically.
* **Preselection**: if you select elements before you click a pick button, the add-in uses the valid ones straight away. **Esc** cancels a pick and keeps the previous picks.

Results:

* **Preview**: one transaction ("Cloudburst preview", so Ctrl+Z works). It creates one DirectShape per colour class. Grid cells in the same row run with the same class merge into one rectangle. Above 60 k cells, runs from neighbouring rows also merge.
* Each class gets a material `Cloudburst <ramp> <class>` with the class colour and 15 % transparency. The active view also gets a solid-fill colour override, so colours show in plan and hidden-line views too.
* Flow paths become 3 DirectShapes of lines (minor, medium and major flow, in blue with increasing line weight).
* Bluespot labels are added as TextNotes only when the active view is a plan view.
* **Bake**: the same output in a "Cloudburst bake" transaction. The elements are named and commented with the caption and a timestamp, and **Clear preview** does not remove them.

## A 2-minute demo script

1. Open any project that has a Toposolid type (any default template works). Click **Cloudburst ▸ Demo site**. The 3D view opens and shows the terrain, buildings, coloured surface outlines and kerbs. The panel opens on the right.
2. In the panel, the summaries show Terrain, Buildings, Surfaces and Walls as filled in. Pick a rain event (e.g. T = 100 years, CF 1.3).
3. Run the **instant (bluespot)** model. A blue depth map appears on the terrain in a few seconds: light blue below 10 cm, strong blue above. Orbit the 3D view to show the ponds in the sunken plaza, the street low point and the park.
4. Switch the layer to **Flow paths** to show the thick blue lines that run into the bluespots.
5. Run the **dynamic** model and show max depth, hazard and time to peak.
6. Optionally, raise the kerb height or pick a floor as permeable paving, re-run and compare options.
7. Click **Bake** to keep the result in the model, or **Clear preview** to remove it.

Things to point out during the demo: Ctrl+Z undoes a preview, everything is ordinary Revit elements (Generic Models), and the caption states the assumptions ("SCREENING MODEL – not for compliance").

## Architecture

* `App.cs`: `IExternalApplication`. It creates the ribbon (icons drawn in code), the `RevitBridge` ExternalEvent and the `RevitHost`, and registers the dockable pane (`IDockablePaneProvider` → `new CloudburstPanel(host)`).
* `RevitBridge.cs`: async bridge into the Revit API context. It is a queue of `Func<UIApplication, T>` items drained by one `ExternalEvent` handler, and each item completes a `TaskCompletionSource`. Every API call from the UI goes through it.
* `RevitHost.cs`: `ICloudburstHost`. It handles picking, summaries, site collection (feet → metres), preview, bake and the demo.
* `GeometryReader.cs`: element geometry → `TriangleMesh` / `Polygon2` / `Polyline3`.
* `PreviewWriter.cs`: `ResultVisual` → DirectShapes (TessellatedShapeBuilder), materials and overrides.
* `DemoBuilder.cs`: builds the demo site with Toposolid.Create, DirectShapes and draped lines.
* Log file: `%TEMP%\Cloudburst\revit.log`.

## Limitations / known gaps

* None of this has been run inside Revit yet: it is compiled against the reference assemblies only. Smoke-test it before the demo.
* The add-in uses Revit internal coordinates (feet → metres, no rotation). **TODO**: an optional shared-coordinates / survey point transform.
* Material colour overrides go on the view that was active when the preview was made. Other views show the material colours (shaded) only.
* Preview rectangles are flat per merged run, so on steep terrain small steps (≤ 8 cm) can appear. That is fine for screening.
* If `Toposolid.Create` fails (e.g. there is no Toposolid type in the template), the demo terrain falls back to a DirectShape mesh. The analysis still uses the exact in-memory demo terrain.
* The demo's surface regions are in-memory polygons drawn as coloured outlines. They are not real Toposolid sub-divisions or floors.
* Probes are stored on `RevitHost.Probes`. `ICloudburstHost` has no member to pass them to the engine yet.
* Picks hold element ids from the active document. Elements deleted after picking are skipped, with a log message.
* Very large terrains (millions of triangles) are read in full. Use a boundary to limit the analysis.
