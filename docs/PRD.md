# PRD: Rainwater / Cloudburst Simulator for Rhino and Grasshopper

Nov 23, 2026 · @Mathias Sønderskov Schaltz

## How to use this PRD

This document is a self-contained brief for a new chat that will design and build the tool. It needs no other context. Start with Milestone 1 and confirm the assumptions below before writing code.

Assumptions made while drafting, to confirm or change:

- [ ] The tool is a Rhino 8 / Grasshopper plugin written in C# on RhinoCommon.
- [ ] The GPU solver uses ComputeSharp (DirectX 12) or ILGPU (CUDA/OpenCL). A CPU fallback is required.
- [ ] The first target is Danish projects: DHM terrain, Spildevandskomiteen rain, Danish runoff coefficients.
- [ ] Typical domain is a site or neighbourhood, 0.1–2 km², on a 0.5–1 m grid.
- [ ] Results are for screening and design comparison, not for permit or compliance evidence.
- [ ] The plugin is standalone. Whether it joins an existing plugin suite is an open question.

## Summary and problem

The tool shows designers where rainwater flows and ponds on a site during peak rain, and how a design change alters that. It runs inside Rhino/Grasshopper, where the terrain and buildings are already being modelled.

Today, flood checks happen late. Designers send a scheme to an engineer, who runs SCALGO Live or MIKE and returns a map days later. Terrain, paving and planting decisions are made without feedback on runoff.

The tool closes that gap with two models:

1. **Instant model.** A static terrain analysis that shows flow paths and ponding (bluespots) for a given rain depth. It updates on every geometry change.
2. **Dynamic model.** A GPU 2D shallow-water solver that adds water depth over time, velocity and hazard. It runs on demand in about one to five minutes.

Each surface in the model carries a material from a palette. The material sets how much rain infiltrates, how much is stored and how fast water flows over it.

## Goals, non-goals and users

**Users**

- Architects and landscape architects in early design. They assign materials, pick a rain event and read maps. They are not hydrologists.
- Computational designers. They wire the components into Grasshopper definitions and compare design options.
- Engineers reviewing the scheme. They need to see every assumption and export the setup to their own tools.

**Goals**

- Show flow paths, ponding extent, depth and volume within 1 second of a geometry change (instant model).
- Show maximum depth, velocity, hazard and timing for a full rain event within 5 minutes for 1 km² at 1 m (dynamic model).
- Let a designer assign materials from a palette with sensible defaults, and override any value.
- Compare two design options with a difference map and a volume balance.
- Report the retention volume needed to meet a municipal discharge limit.
- State all assumptions on every output.

**Non-goals**

- Compliance-grade sewer modelling. No pipe network in Milestones 1–2.
- River, coastal or groundwater flooding.
- Water quality.
- Replacing SCALGO Live or MIKE. The tool screens options before those are used.

## Scope and milestones

Build in three milestones. Each one is usable on its own.

| Milestone | Delivers | Method | Speed target | Done when |
| --- | --- | --- | --- | --- |
| M1 Instant | Grid builder, material palette, flow paths, bluespot depth/extent/volume, spill order, retention panel | Priority-flood, depression hierarchy, fill–spill–merge, MFD flow accumulation | Under 1 s for 1 M cells on CPU | Bluespot extents match SCALGO Live for the same terrain and rain depth |
| M2 Dynamic | Depth and velocity over time, max maps, hazard, probes, option comparison | Local-inertial 2D shallow water on GPU, per-cell infiltration | Under 5 min for 1 km² at 1 m, 6-hour event | Passes the benchmark tests in the validation section, mass error under 0.1 % |
| M3 Coupling (optional) | Sewer surcharge locations, export to engineer tools | SWMM 5 DLL stepped with the 2D grid, or export of rasters for MIKE+ / SCALGO | Not interactive | Round-trip of one test site |

M1 and M2 share the same grid, material map and rain inputs. M2 must not require any input that M1 does not already have, except the rain time series.

## Functional requirements

### Inputs

| ID | Requirement |
| --- | --- |
| IN-1 | Import terrain as GeoTIFF or ASCII grid (DHM/Terræn 0.4 m), or sample a Rhino mesh/surface. Resample to a user-set cell size, default 1 m. |
| IN-2 | Stamp design geometry onto the grid: new terrain meshes replace heights; building footprints become blocks of at least +5 m. |
| IN-3 | Accept polylines as walls or kerbs with a height (default +0.10 m), and as channels or culverts cut into the grid. |
| IN-4 | Accept polygons that remove bridge decks from the terrain. DHM/Terræn includes bridge decks, which act as false dams. |
| IN-5 | Assign a material to each closed curve or mesh face. Unassigned cells get a default material. Later regions override earlier ones. |
| IN-6 | Assign a soil class (Danish JB 1–11) per region, default JB-6, with a compacted/loose switch. |
| IN-7 | Rain input: (a) depth in mm for M1; (b) time series for M2 from a built-in generator (CDS, box rain) or a CSV. |
| IN-8 | Climate factor multiplier, default 1.4 for T = 100 years, 1.3 for T = 10, 1.2 for T = 2. |
| IN-9 | Sewer assumption per region: none, initial loss (default 34 mm combined, 29 mm separate), or constant capacity in mm/h. Applies to sealed surfaces only. |
| IN-10 | Roof drainage per building: to sewer (default), to ground at the footprint edge, or to a named LAR element. |
| IN-11 | Boundary condition per domain edge: open (default), closed, or fixed water level. |
| IN-12 | Antecedent moisture: dry, moist (default), wet. |

### Simulation

| ID | Requirement |
| --- | --- |
| SIM-1 | M1 computes effective rain per cell from material and soil, then routes it with fill–spill–merge. |
| SIM-2 | M1 reports, per bluespot: volume, max depth, area, contributing area, and the rain depth at which it spills. |
| SIM-3 | M2 solves depth and flow per cell with an adaptive time step and reports progress. It can be cancelled. |
| SIM-4 | M2 applies interception and depression storage as an initial bucket, then infiltration each step, then the sewer loss. |
| SIM-5 | M2 tracks a mass balance: rain in, infiltrated, to sewer, out of boundary, stored. It reports the error. |
| SIM-6 | LAR elements are supported as materials or objects: green roof, permeable paving, rain garden, swale, soakaway, basin with throttled outlet. |
| SIM-7 | An ensemble mode runs 3–5 parameter sets (moisture, infiltration low/central/high) and reports the fraction of runs above a depth threshold. |

### Outputs

| ID | Requirement |
| --- | --- |
| OUT-1 | Max depth map with classes 0–10, 10–20, 20–30, 30–50, over 50 cm. The 10 cm threshold is highlighted. |
| OUT-2 | Flow paths as curves, weighted by upstream volume. |
| OUT-3 | Max velocity and hazard map. Hazard = h · (v + 0.5). Flag h · v above 0.5 m²/s. |
| OUT-4 | Time slider for depth in M2, and time-to-peak per cell. |
| OUT-5 | Probes: depth and flow time series at user points and across user lines. |
| OUT-6 | Building flags: water level at each façade against a threshold height. |
| OUT-7 | Option comparison: difference in max depth between two runs, and change in total flooded volume. |
| OUT-8 | Retention panel: reduced area (sum of C · A), peak flow by the rational method, and required storage in m³ for a discharge limit in l/s/ha. |
| OUT-9 | Every map carries a caption with rain event, climate factor, sewer assumption, cell size and the words "screening model". |
| OUT-10 | Export depth, velocity, roughness and terrain rasters as GeoTIFF, and results as a coloured Rhino mesh. |

### User interface

- Grasshopper components grouped as: Grid, Materials, Rain, Solve Instant, Solve Dynamic, Results, Compare.
- The palette is a JSON file shipped with the plugin. Users can copy and edit it per project.
- The dynamic solver runs off the UI thread and writes results to a cache keyed by a hash of its inputs.

## Technical specification

### Grid and data layout

One uniform square grid holds everything. Per-cell arrays, float32 unless noted:

- `z` terrain height after stamping buildings, kerbs and cuts (m)
- `h` water depth (m); `qx`, `qy` unit flow on east and north cell faces (m²/s)
- `n` Manning roughness; `fc`, `f0`, `k` Horton parameters; `Ia` initial loss (m); `C` runoff coefficient
- `F` cumulative infiltration (m); `sewer` remaining sewer loss (m)
- `hmax`, `vmax`, `hvmax`, `tpeak` running maxima
- Mass-balance totals in float64

### Per-cell water balance

```latex
\frac{dh}{dt} = P(t) - f(t) - q_{sewer} + \frac{q_{x,in} - q_{x,out}}{\Delta x} + \frac{q_{y,in} - q_{y,out}}{\Delta y}
```

Rain first fills the initial-loss bucket `Ia` (interception plus depression storage). Only the excess enters the balance.

### Infiltration

Default is modified Horton, driven by cumulative infiltration F rather than clock time, so capacity does not decay while it is dry.

```latex
f(t) = f_c + (f_0 - f_c)\, e^{-k t}
```

Actual infiltration per step is the smaller of capacity and available water (rain plus ponded depth). Moisture setting: dry uses f0, moist uses f0 / 3, wet uses fc only.

Expert option is Green-Ampt, with Ks, suction head ψ and moisture deficit Δθ from soil texture:

```latex
f = K_s \left( 1 + \frac{\psi\, \Delta\theta}{F} \right)
```

For M1 and sanity checks, the SCS Curve Number gives event runoff depth Q from rain depth P (mm), with Ia = λS and λ = 0.2:

```latex
Q = \frac{(P - I_a)^2}{P - I_a + S}, \qquad S = \frac{25400}{CN} - 254
```

### M1 instant model

1. Effective rain per cell: `R = max(0, min(C_event · P, P − Ia) − sewer)`, where `C_event` is the cloudburst coefficient from the palette (blended sand → clay by the soil's clay weight), or the CN formula, and `sewer` is the sewer loss on sewer-connected cells (sealed surfaces; not open water). `C_event` already contains interception, depression storage and infiltration, so it applies to the whole rain depth; `Ia` only bounds the loss from below (runoff never exceeds `P − Ia`). *Changed from the earlier `max(0, P − Ia) · C_event`, which counted the initial loss twice (green roofs ran off about 20 % less in M1 than in M2); see finding F5 in docs/physics-permeability.md.*
2. Priority-flood to find depressions. Build the depression hierarchy (Barnes, Callaghan and Wickert 2021).
3. Fill–spill–merge: route each cell's volume downslope, fill depressions, spill overflow to the neighbour, merge when both are full.
4. Bluespot depth = filled water surface minus terrain.
5. Flow paths: multiple-flow-direction accumulation of R over the filled surface. Draw cells above a volume threshold.

Reference implementations: RichDEM and WhiteboxTools.

### M2 dynamic model

Local-inertial form of the 2D shallow-water equations (Bates et al. 2010, stabilised by de Almeida et al. 2012) on a staggered grid. η = h + z is the water surface level. Flow depth at a face:

```latex
h_f = \max(\eta_i, \eta_{i+1}) - \max(z_i, z_{i+1})
```

Face flux update with semi-implicit Manning friction:

```latex
q^{t+\Delta t} = \frac{q^{t} - g\, h_f\, \Delta t\, \dfrac{\eta_{i+1} - \eta_i}{\Delta x}}{1 + g\, \Delta t\, n^2\, \dfrac{|q^{t}|}{h_f^{7/3}}}
```

Depth update:

```latex
h^{t+\Delta t} = h^{t} + \Delta t \left[ \frac{q_{x,in} - q_{x,out}}{\Delta x} + \frac{q_{y,in} - q_{y,out}}{\Delta y} + P - f - q_{sewer} \right]
```

Adaptive time step, with α = 0.7 by default (range 0.2–0.7):

```latex
\Delta t = \alpha\, \frac{\Delta x}{\sqrt{g\, h_{max}}}
```

Each step is two GPU kernels: face fluxes, then cell depths. A reduction finds `h_max` for the next time step.

Rules the solver must follow:

- **Wet/dry.** If `h_f` is below 1 mm, set the face flux to zero.
- **No negative depth.** Scale a cell's outflows down if they exceed the water it holds.
- **Steep slopes.** Limit the Froude number at a face to 1. Local-inertial is unreliable in supercritical flow.
- **de Almeida weighting.** Replace `q^t` in the numerator with `θ·q_i + (1−θ)/2·(q_{i−1} + q_{i+1})`, θ = 0.8, to damp oscillations.
- **Depth-dependent roughness (optional).** `n(h) = n_deep + (n_sheet − n_deep)·exp(−h / 0.025)`.
- **Run length.** Rain duration plus 2 hours, so ponds settle.

### Sewer

- Default: initial loss. Sealed cells in sewered regions lose the first 34 mm (combined) or 29 mm (separate) of rain. This is the SCALGO Live convention.
- Alternative: constant capacity sink in mm/h on sealed, sewered cells.
- M3: step the SWMM 5 DLL alongside the grid and exchange water at manholes with weir/orifice formulas. Itzï is the reference design.

### LAR elements

| Element | Representation | Defaults |
| --- | --- | --- |
| Extensive green roof | Initial loss, then high runoff | Ia 15 mm; C 0.5–0.6 normal rain, 0.8 cloudburst |
| Blue-green roof | Storage bucket with throttled outlet | 40–80 mm storage; outlet in l/s/ha |
| Permeable paving | High-infiltration cell with sub-base storage | f 250 mm/h long-term; storage 30–60 mm; a clogged setting with C 0.9 |
| Rain garden | Terrain depression plus infiltration | Ponding 150–300 mm; media 100 mm/h; subsoil from soil class |
| Swale | Channel cut in terrain plus infiltration | n 0.1; side slopes 1:3 |
| Soakaway (faskine) | Point sink with volume and rate | Rate = K × side area; K from soil |
| Basin | Terrain depression with throttled outlet | Outlet 1–2 l/s/ha |

### Retention panel

Reduced area is the sum of C · A over all surfaces. Required storage is the worst case over rain durations d, for intensity i(d, T) and permitted outflow Q\_out:

```latex
V = \max_{d} \left[ \left( i(d,T)\, A_{red} - Q_{out} \right) d \right] \cdot f_{safety}
```

Unit conversions: 1 mm/h = 2.78 l/s/ha; 1 µm/s = 3.6 mm/h. Label the result "indicative".

## Material palette

Ship this table as the default palette file. Every value is a default that the user can override.

Column meanings:

- **C normal**: Danish administrative runoff coefficient (afløbskoefficient), used for reduced area and the retention panel.
- **C cloudburst**: effective coefficient for rains of 50–100 years, used by M1. These are engineering estimates, not standard values.
- **n**: Manning roughness for flow 5–30 cm deep (s/m^(1/3)). Manning number M = 1/n.
- **f**: long-term infiltration rate at the surface (mm/h). Use as Horton fc, with f0 = 3–4 × fc.
- **Ia**: initial loss, depression storage plus interception (mm).

For soil-dependent rows, values are given as sand / clay. M2 should take infiltration from the soil table in the next section instead, when a soil class is set.

### Roofs

| Material | C normal | C cloudburst | n | f (mm/h) | Ia (mm) | Note |
| --- | --- | --- | --- | --- | --- | --- |
| Pitched roof, tile or metal | 1.0 | 1.0 | 0.013 | 0 | 0.5 |  |
| Flat bitumen roof | 1.0 | 1.0 | 0.015 | 0 | 2 | Up to 5 mm if gravel-ballasted |
| Extensive green roof, sedum 4–10 cm | 0.5–0.6 | 0.8 | 0.10 | substrate-limited | 15 | Near 1.0 once saturated; some municipalities require 1.0 |
| Intensive green roof, 25–50 cm | 0.3 | 0.5 | 0.15 | substrate-limited | 50 |  |
| Blue-green roof | storage | storage | 0.05 | 0 | 40–80 storage | Model as tank plus throttled outlet |

Buildings are obstacles in the terrain. Roof rain goes to the sewer, the footprint edge or a LAR element. It never ponds on the building block.

### Hard surfaces

| Material | C normal | C cloudburst | n | f (mm/h) | Ia (mm) | Note |
| --- | --- | --- | --- | --- | --- | --- |
| Asphalt | 1.0 | 1.0 | 0.016 | 0 | 1.5 |  |
| Concrete | 1.0 | 1.0 | 0.015 | 0 | 1 |  |
| Concrete pavers or slabs, sand joints | 0.8 | 0.9 | 0.018 | 2 | 2 | Joints close up in extreme rain |
| Granite setts, cobbles | 0.8 | 0.85–0.9 | 0.025 | 5 | 3 |  |
| Permeable pavers | 0.6–0.8 | 0.3 draining, 0.9 clogged | 0.020 | 250 | 3 | Sub-base storage 30–60 mm; varies by municipality |
| Porous asphalt | 0.6–0.8 | 0.3–0.9 | 0.016 | 250 | 3 | Clogs over time |
| Grass-reinforcement pavers | 0.4–0.6 | 0.4 / 0.7 | 0.035 | 30 / 10 | 4 | Behaves like compacted lawn |
| Loose gravel | 0.6 | 0.6 | 0.025 | 20–100 | 4 | 0.3 in some municipalities |
| Compacted gravel (stabilgrus) | 0.5 | 0.8 | 0.022 | 2–10 | 2 | Near-sealed when wet |
| Rubber playground surface, sealed | 1.0 | 1.0 | 0.015 | 0 | 1 | Porous type: treat as porous asphalt |
| Timber decking | as ground below | as ground below | 0.030 | ground below | 1 | Model the ground underneath |

### Green and natural surfaces

| Material | C normal | C cloudburst (sand / clay) | n | f (mm/h) (sand / clay) | Ia (mm) | Note |
| --- | --- | --- | --- | --- | --- | --- |
| Lawn, flat, compacted urban | 0.1 | 0.2 / 0.6 | 0.035 | 25 / 5 | 4 | The key uncertain surface |
| Lawn, sloped over 5 % | 0.1 | 0.3 / 0.7 | 0.035 | 25 / 5 | 2.5 | Do not also raise C in M2; the terrain handles slope |
| Park lawn, good condition | 0.1 | 0.1 / 0.5 | 0.040 | 50 / 10 | 5 |  |
| Meadow, tall grass | 0.1 | 0.05 / 0.4 | 0.080 | 100 / 20 | 6 |  |
| Shrubs, planting beds | 0.1 | 0.05 / 0.3 | 0.100 | 150 / 25 | 8 |  |
| Forest, dense trees | 0.1 | 0.0 / 0.3 | 0.150 | 500 / 20 | 10 |  |
| Bare soil | 0.1–0.3 | 0.4 / 0.8 | 0.025 | 15 / 2 | 2 | Surface crusts |
| Agricultural land | 0.1 | 0.3 / 0.7 | 0.060 | 20 / 5 | 5 |  |
| Rain garden | 0 | 0 until full, then 1.0 | 0.100 | media 100 | ponding 150–300 |  |
| Swale | 0 | low until full | 0.100 | 5–50 | channel storage |  |
| Water surface | 1.0 | 1.0 | 0.030 | 0 | 0 | Fixed-level boundary if large |
| Wetland | 0.1 | 0.9 | 0.100 | 0–1 | freeboard | Saturated |

The administrative value of 0.1 for green areas holds for normal rain only. Compacted lawn on clay sheds most of a cloudburst.

## Soil table and rain defaults (Denmark)

### Horton parameters by Danish soil class

Values are fc / f0 in mm/h, from the SCALGO Live Denmark model report (Gade and Lerer 2022). Use "compacted" for urban lawns and verges. Use "loose" for forest, unmown meadow and new planting beds. Decay constant k = 5 per hour for all classes.

| JB | Soil | Compacted fc / f0 | Loose fc / f0 |
| --- | --- | --- | --- |
| 1 | Coarse sand | 30 / 120 | 1000 / 4000 |
| 2 | Fine sand | 25 / 100 | 500 / 2000 |
| 3 | Coarse clayey sand | 21 / 85 | 150 / 500 |
| 4 | Fine clayey sand | 20 / 80 | 120 / 500 |
| 5 | Coarse sandy clay | 12 / 50 | 30 / 200 |
| 6 | Fine sandy clay | 9 / 47 | 25 / 100 |
| 7 | Clay | 5 / 20 | 20 / 50 |
| 8 | Heavy clay | 0.5 / 2 | 2 / 20 |
| 9 | Very heavy clay | 0.01 / 0.1 | 0 / 1 |
| 10 | Silt | 20 / 80 | 50 / 250 |
| 11 | Humus | 22 / 100 | 200 / 2000 |

Where groundwater is within 1 m of the surface, set infiltration to zero after the first few millimetres.

### Rain events to ship

| Event | Depth | Shape | Use |
| --- | --- | --- | --- |
| T = 10 years | about 35 mm × 1.3 = 45.5 mm | 4-hour CDS, 1-minute blocks, peak about 194 mm/h (252 mm/h with the climate factor) | Everyday design check |
| T = 100 years | about 59 mm × 1.4 = 83 mm | 4-hour CDS, 1-minute blocks, peak about 327 mm/h (457 mm/h with the climate factor) | Cloudburst default |
| "2011 test" | 120 mm (range 100–135 mm) | Box rain over 2 hours, 60 mm/h | Stress test, Copenhagen 2 July 2011 |
| Box 83 mm | 83 mm | Box rain over 4 hours, about 21 mm/h | Same volume as T = 100 without the peak |
| Custom | user depth and duration | Box rain or CSV | Any |

Depths are for Odense from the Skrift 30 regional model, before the climate factor. Regenerate them for the site with the current Spildevandskomiteen tool; Skrift 32 replaces the Skrift 30 model.

How the CDS is built (`Shared/cloudburst-core/src/rain.rs`, pinned by the test `preset_peaks_and_depths_are_pinned`):

- IDF: an **indicative** two-parameter curve `i(d, T) = 240 · (T/10)^0.227 / (d + 5)^0.835` µm/s, d in minutes. It is calibrated only so that the 4-hour depths match the table above (34.96 mm at T = 10, 58.97 mm at T = 100). It is not the Skrift 30/32 regional model and must not be quoted as such.
- Alternating blocks of **1 minute** over 4 hours, the 1-minute block at the centre (peak position 0.5), the series scaled so its total equals the preset depth.
- The climate factor multiplies every block (depth and peak alike). The peak in the table is therefore `i(1 min, T)` scaled to the depth, then × climate factor.

The peak figures in earlier versions of this table (151 and 231 mm/h) could not be reproduced from this IDF at any single block length (they would need a 3-minute block for T = 10 but a 4-minute one for T = 100, or 6 and 9 minutes if the climate factor were included), so they were not derived from the curve the tool uses; they were corrected to what the code produces (review finding F14). The 1-minute block was kept because it is the usual time resolution of Danish CDS rains: the Spildevandskomiteen regional models give intensities down to 1-minute durations and CDS rains for pipe and surface models are normally generated at that resolution. For comparison, the same T = 100 storm averaged over 5 minutes peaks at about 213 mm/h (298 mm/h with the climate factor) and over 10 minutes at about 152 mm/h (213 mm/h).

Sensitivity: on the built-in school yard (2 m cells, T = 100, combined sewer, moist soil) replacing the 1-minute peak by a 5- or 10-minute one changes infiltration by under 1 % and water leaving the site by under 0.5 %; the area deeper than 10 cm changes by up to 9 %. Infiltration-excess on permeable surfaces and the first minutes of ponding are where the peak matters; totals are governed by depth and duration.

CDS rain concentrates the peak. Surface flooding depends more on total volume and duration, so always run a box rain as well.

### Service levels to test against

- Copenhagen cloudburst target: at most 10 cm of water on terrain in a 100-year rain.
- Skrift 27: sewer surcharge to terrain at most once in 10 years (combined) or 5 years (separate).
- Typical municipal design intensity: 110 l/s/ha (separate) or 140 l/s/ha (combined) for a 10-minute rain.

### Data sources

- Terrain: Danmarks Højdemodel, DHM/Terræn 0.4 m, from Dataforsyningen. Buildings are removed; bridge decks are included.
- Building footprints, kerbs and bridges: GeoDanmark.
- Soil class: Aarhus University topsoil texture map (JB classes). Deeper geology: GEUS jordartskort.
- Sewered areas and system type: municipal spildevandsplan.

## Validation, acceptance criteria and performance targets

### Tests the solver must pass

| Test | What it checks | Pass criterion |
| --- | --- | --- |
| Lake at rest | Still water over uneven terrain stays still | Velocities remain zero to float precision |
| Tilted plane, steady rain | Sheet flow against the kinematic-wave solution | Outflow within 5 % at steady state |
| Rain-on-grid mass balance | Conservation | Error under 0.1 % of rain volume |
| UK Environment Agency Test 2 | Filling of floodplain depressions | Final levels within the range of published packages |
| UK Environment Agency Test 8A | Rain plus point inflow in an urban area | Depth series at probes within the range of published packages |
| M1 against SCALGO Live | Bluespot extent for the same terrain and rain depth | Extents match visually; volumes within 10 % |
| M1 against M2 | Final ponding from M2 against M1 for a box rain | Bluespot volumes within 15 % where flow is slow |

The Environment Agency tests come from report SC120002 (Néelz and Pender 2013).

### Performance targets

| Case | Target |
| --- | --- |
| M1, 1 M cells, CPU | Under 1 s |
| M1, 4 M cells, CPU | Under 5 s |
| M2, 1 M cells, 6-hour event, mid-range GPU | Under 5 min |
| M2 CPU fallback, 250 k cells | Under 10 min |
| Grid rebuild after a geometry edit | Under 0.5 s for the changed region |

### Acceptance for each milestone

- [ ] M1: a designer can import DHM tiles, stamp a design, assign materials and see bluespots and flow paths update live.
- [ ] M1: the retention panel reproduces a hand calculation for a test site.
- [ ] M2: all solver tests above pass and are part of an automated test suite.
- [ ] M2: two design options can be compared with a difference map.
- [ ] All outputs carry the assumptions caption.

## Risks, caveats and open questions

### Risks

| Risk | Effect | Mitigation |
| --- | --- | --- |
| Infiltration on compacted urban soil is poorly known | Runoff from green areas wrong by a factor of 3–8 | Soil-class table, moisture setting, ensemble mode |
| Bridges left in the terrain | False dams and deep ponds upstream | Bridge cut-out polygons, warning when none are set |
| Missing culverts and underpasses | False ponding or false dryness | Culvert polylines, checklist in the UI |
| Kerbs lost when resampling | Wrong flow along streets | Cell size of 0.5 m or less in streets, kerb lines as walls |
| Thin water films in rain-on-grid | Instability and mass loss | Semi-implicit friction, 1 mm dry threshold, flux limiting |
| Uniform sewer loss hides weak points | Hotspots missed | State it on every map; M3 coupling for detailed design |
| Results read as compliance evidence | Misuse | "Screening model" caption; show ranges |

### Caveats on the numbers

- Cloudburst coefficients, deep-flow Manning values and the depth-dependent roughness formula are engineering estimates. Calibrate them against a MIKE run where possible.
- Municipal runoff coefficients differ. Gravel is 0.3 in some municipalities and 0.6 in others. Use the local spildevandsplan for permit numbers.
- Rain depths are from the Skrift 30 model. Regenerate with the Skrift 32 tool.
- The permeable-paving and rain-garden rates attributed to CIRIA C753 came from secondary sources and need checking.

### Open questions

- [ ] Standalone plugin, or a module in an existing plugin suite?
- [ ] Which GPU backend: DirectX 12 compute, CUDA, or both?
- [ ] Should DHM tiles download automatically for a site boundary, or be imported manually?
- [ ] Is a Revit route needed (materials from Revit topography and floors)?
- [ ] Is a web viewer for results needed, for sharing with clients?
- [ ] Which test site and which reference result (SCALGO, MIKE) will be used for calibration?
- [ ] Should M3 target SWMM coupling or export to the engineer's tools?

### References

- Bates, Horritt and Fewtrell (2010), local-inertial formulation; de Almeida et al. (2012), stabilisation.
- Barnes, Callaghan and Wickert (2021), Fill–Spill–Merge.
- Guidolin et al. (2016), CADDIES WCA2D cellular automata, as a simpler alternative solver.
- Gade and Lerer (2022), pixel-based rainfall–runoff model in SCALGO Live Denmark v1.03.
- Spildevandskomiteen Skrift 27, 30, 31, 32.
- EPA SWMM 5 reference manuals; USDA TR-55; Rawls, Brakensiek and Miller (1983).
- Néelz and Pender (2013), Environment Agency report SC120002.
- Code to read: LISFLOOD-FP, Itzï, landlab OverlandFlow, RichDEM, WhiteboxTools.
