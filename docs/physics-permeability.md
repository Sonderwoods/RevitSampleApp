# Cloudburst – permeability physics (infiltration, losses, LAR storage)

Status: describes the engine as of this commit (`Shared/cloudburst-core`). Written for engineers and for authorities
reading a Cloudburst report. Cloudburst is a **screening model**; nothing below makes it a design or compliance tool.

This document covers everything that decides how much rain soaks in or is held back rather than running off:
initial losses, infiltration, sub-base storage of permeable surfaces, the groundwater cap, the sewer loss as far as it
interacts with infiltration, and the runoff coefficients of the instant model. Surface hydraulics (the shallow-water
solver), rain generation and terrain are out of scope except where noted.

Code map:

| What | Where |
| --- | --- |
| Per-cell loss kernel (Horton, sub-base, cap) | `src/infiltration.rs` (`infiltrate`, `point_runoff`) |
| Order of operations in the dynamic model (M2) | `src/dynamic.rs`, kernel 4 |
| Per-cell parameters from material, soil, moisture, sewer | `src/hydro.rs` (`derive`) |
| Material palette (single source) | `data/palette.json` (embedded in the engine; .NET embeds the same file) |
| JB soil table, Horton k | `src/palette.rs` (`SOILS`, `HORTON_K_PER_HOUR`) |
| Instant model (M1) runoff | `src/instant.rs` (`effective_rain`) |
| Retention panel | `src/retention.rs` (uses only `cNormal`) |
| Tests | `src/infiltration.rs` tests, `tests/permeability.rs` |
| M1 vs M2 table generator | `examples/permeability_table.rs` |

## 1. Model as implemented

### 1.1 Units

Inside the engine all depths are metres, rates m/s, Horton k 1/s, volumes m³. Palette and soil table values are in
mm and mm/h and are converted once in `hydro::derive` (1 mm/h = 1/3.6·10⁻⁶ m/s = 2.78 l/s/ha). Per-cell state is
float32; mass totals are float64.

### 1.2 Per-cell parameters (`hydro::derive`)

For every cell the engine takes its material (the roof material on building cells), its JB soil class (default
JB 6, overridable per region) and its compaction flag (material default, overridable per region: compacted / loose).

* **Initial loss bucket Ia** = `initialLossMm` (+ `storageMm` for materials *without* a sub-base model).
* **Horton fc, f0**
  * building (roof) cells: fc = f0 = 0.
  * materials with `useSoilTable`: fc, f0 from the JB table (compacted or loose row, §3.1). The palette's
    `infiltrationSand/Clay` columns are **not used by M2** for these materials.
  * other materials: fc = linear blend of `infiltrationSand` and `infiltrationClay` by the soil's clay weight
    (§3.1, column "clay weight"); f0 = 3.5 fc (PRD: "f0 = 3–4 × fc").
  * moisture setting: dry f0 unchanged; moist f0 ← max(f0/3, fc); wet f0 ← fc (PRD rule).
  * ensemble multiplier `infiltrationScale` multiplies fc, f0 and the sub-base drainage.
* **Horton k** = 5 h⁻¹ for every cell (PRD, attributed to Gade and Lerer 2022).
* **Sub-base** (materials with `subsoilLimited`: permeable pavers, porous asphalt, clogged permeable pavers, rain
  garden): storage `S = storageMm`, drainage to the subsoil `d = fc of the JB soil` (compacted row unless the material
  or region says loose) × `infiltrationScale`.
* **Infiltration cap** `Fmax` per cell from `Grid::infiltration_cap_mm` (FFI `cb_grid_set_infiltration_cap`); none by
  default. Intended for groundwater within 1 m of the surface (PRD).
* **Sewer**: sewer-connected cells (default: `sealed` materials; open water is *not* connected) get the sewer initial
  loss (34 mm combined, 29 mm separate) or the constant-capacity sink. Roofs draining to the sewer always get a
  sewer loss (34 mm even with sewer mode "none").

### 1.3 Order of operations in one M2 time step, per cell

After the face fluxes and the positivity limiter (not covered here):

1. `h ← h + Δt/Δx·(Σ inflows − Σ outflows)`, clamped at 0.
2. Rain on the cell `p = i(t)·Δt` (left-point value of the hyetograph × climate factor; inactive cells get none).
3. **Initial-loss bucket**: `take = min(p, Ia_remaining)`; only the rest continues.
4. **Sewer initial-loss bucket** (sewer-connected cells): `take = min(p, sewer_remaining)`.
5. `h ← h + p` (net rain).
6. **Sewer capacity sink** (mode "constant capacity"): `min(rate·Δt, h)`.
7. **Infiltration** (`infiltration::infiltrate`) with available water `h` (ponded depth + run-on + this step's net rain):
   1. Horton capacity over the step (exact integral, §1.4): `ΔF_cap`.
   2. Sub-base cells: `ΔF ≤ (S − store) + d·Δt`.
   3. Cap: `ΔF ≤ Fmax − F`.
   4. `ΔF ≤ h`.
   5. `h ← h − ΔF`, `F ← F + ΔF`; sub-base cells: `store ← store + ΔF`, then `store ← store − min(store, d·Δt)`.
8. Running maxima.

Each drop is removed by exactly one of these sinks and booked to exactly one mass-balance term (initial loss, sewer,
infiltrated), so nothing is counted twice and no depth can go negative (each sink is bounded by the water present).
Note the consequences of this order, which follow the PRD ("Rain first fills the initial-loss bucket"):

* the Ia bucket only takes rain falling **on** the cell, never run-on;
* on a cell that has an initial loss, infiltration of rain starts only once Ia is full (run-on can infiltrate at any time);
* on sealed, sewered surfaces that also infiltrate (pavers, setts) the sewer loss takes rain before infiltration does.

### 1.4 Modified Horton, driven by cumulative infiltration

Horton's capacity under continuous ponding and its integral are

```
f(t) = fc + (f0 − fc)·e^(−k t)
F(t) = fc·t + (f0 − fc)/k·(1 − e^(−k t))
```

The *modified* (cumulative-infiltration, "equivalent time") form makes capacity a function of F instead of clock
time: the state is the time `tp` at which the ponded Horton curve would have infiltrated the current F, carried as
`E = e^(−k·tp)` (E = 1 at F = 0), so `f = fc + (f0 − fc)·E`. Consequences:

* capacity decays only when water actually infiltrates; it does **not** decay while the cell is dry;
* there is **no recovery**: F and E never go back while dry (adequate for a single event of a few hours; see §5).

Per step:

```
ΔF_cap = fc·Δt + (f0 − fc)/k · E · (1 − e^(−kΔt))        exact integral of the Horton curve over the step
if ΔF = ΔF_cap  (cell stayed ponded):   E ← E·e^(−kΔt)    exact
else (less water, sub-base full, cap):  E ← E·e^(−k·τ),   τ = time the curve needs to infiltrate ΔF (midpoint rate)
```

A ponded cell therefore follows the analytic F(t) for any Δt; the only error is float32 round-off (measured
≤ 3.5·10⁻⁴ relative over 4 h with Δt = 0.5 s, ≤ 4·10⁻⁵ for Δt ≥ 1 s). `e^(−kΔt)` is computed once per step.

Actual infiltration is always the minimum of capacity and available water (rain on the cell + ponded depth +
run-on), as the PRD requires.

Behaviour at extreme Δt: M2's Δt is ≤ 5 s during rain and ≤ 10 s afterwards (CFL); the Horton update is exact for any
Δt when ponded, and second-order in Δt when water-limited. Very small Δt only costs float32 round-off as quoted above.

### 1.5 Sub-base reservoirs (permeable paving, porous asphalt, rain-garden media)

```
entry over a step   ΔF ≤ min( Horton capacity of the surface,  (S − store) + d·Δt,  Fmax − F,  h )
store ← store + ΔF − min(store + ΔF, d·Δt)
```

* `S` is finite (`storageMm`); the sub-base starts **empty** whatever the moisture setting.
* While `store < S` the surface rate (e.g. 250 mm/h for permeable pavers) governs entry.
* Once full, the surface accepts no more than the subsoil drains (`d` = JB fc, e.g. 9 mm/h on JB 6 compacted,
  0.5 mm/h on JB 8 compacted); the excess ponds or runs off like on any other surface.
* After rain, the sub-base keeps draining at `d`. Water in the sub-base is already booked as "infiltrated" (it has
  left the surface); `PermeabilityStats` splits it into "still in sub-base" and "drained to subsoil".
* There is no underdrain/outlet pipe, no lateral flow inside the sub-base, and no return of sub-base water to the
  surface.

### 1.6 Groundwater cap

`F ≤ Fmax` per cell. The PRD says "where groundwater is within 1 m of the surface, set infiltration to zero after the
first few millimetres". The engine applies whatever cap the caller provides; it ships **no default number** and no
groundwater map. Not yet exposed in any UI.

### 1.7 Instant model (M1)

```
R = max(0,  min(C·P,  P − Ia) − sewer_loss)          C = cloudburst coefficient, blended sand→clay by clay weight
```

`C` (`cCloudburstSand/Clay`) is an event coefficient on the **whole** rain depth: it already contains interception,
depression storage and infiltration. The initial loss stays a lower bound on the loss (runoff never exceeds P − Ia).
The sewer loss is `sewer initial loss + capacity × 4 h` (fixed 4 h). M1 does not use the JB Horton table at all.

Deviation from the original PRD (now updated to this formula): the PRD wrote `R = max(0, P − Ia)·C_event`. Applied literally that subtracts Ia and then
applies a coefficient that already accounts for it; for green roofs it halved the runoff of the dynamic model
(§2). See finding F5.

### 1.8 Retention panel

Reduced area = Σ `cNormal`·A. Infiltration, Ia and soils play no part. Unchanged by this review.

### 1.9 Outputs related to permeability

| Output | Where | Meaning |
| --- | --- | --- |
| `MassBalance.infiltrated_m3`, `.initial_loss_m3`, `.sewer_m3` | `cb_dynamic_mass` (layout unchanged) | totals over the run |
| `MassBalance.error_fraction` | same | (rain + initial water − Ia − infiltrated − sewer − boundary out − stored)/(rain + initial water); **includes** infiltration |
| `PermeabilityStats` | `cb_dynamic_permeability` (new) | infiltrated, still in sub-bases, drained to subsoil, sub-base capacity, Ia, counts of sub-base cells / cells whose sub-base filled (≥ 99 %) / capped cells |
| per-cell cumulative infiltration F (m) | `cb_dynamic_copy(which = 6)` (new) | map of where water soaked in |
| per-cell peak sub-base fill (0–1) | `cb_dynamic_copy(which = 7)` (new) | map of permeable surfaces that ran full |

Web (`Web/engine/cloudburst-wasm.js`): `runDynamic` now also returns `infiltrated`, `subbaseFillMax` and
`permeability`; `setInfiltrationCap(grid, capsMm)` sets the cap.

## 2. Instant vs dynamic, per material (point scale)

`cargo run --release --example permeability_table` runs one cell of each material through the **solver's own loss
kernel** with the parameters `hydro::derive` gives it, for the T = 100 design rain (4 h CDS, 59 mm × 1.4 = 82.6 mm,
1-minute blocks), with no run-on and no sewer: every drop that does not infiltrate runs off at once. That is the
point-scale runoff coefficient; on a real site run-on and ponding raise infiltration in hollows. Output of this commit:

| Material | JB | M1 min(C·P, P−Ia)/P | M2 dry | M2 moist | M2 wet | M2 moist infiltrated (mm) | sub-base peak fill (moist) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Pitched roof, tile or metal | 2 | 0.99 | 0.99 | 0.99 | 0.99 | 0.0 | – |
| Flat bitumen roof | 2 | 0.98 | 0.98 | 0.98 | 0.98 | 0.0 | – |
| Extensive green roof (sedum) | 2 | 0.80 | 0.82 | 0.82 | 0.82 | 0.0 | – |
| Intensive green roof | 2 | 0.39 | 0.39 | 0.39 | 0.39 | 0.0 | – |
| Blue-green roof | 2 | 0.27 | 0.27 | 0.27 | 0.27 | 0.0 | – |
| Asphalt | 2 | 0.98 | 0.98 | 0.98 | 0.98 | 0.0 | – |
| Concrete | 2 | 0.99 | 0.99 | 0.99 | 0.99 | 0.0 | – |
| Concrete pavers, sand joints | 2 | 0.90 | 0.88 | 0.89 | 0.89 | 7.1 | – |
| Granite setts, cobbles | 2 | 0.88 | 0.75 | 0.76 | 0.77 | 16.5 | – |
| Permeable pavers | 2 | 0.30 | 0.00 | 0.05 | 0.07 | 75.2 | 79 % |
| Permeable pavers | 7 | 0.30 | 0.22 | 0.22 | 0.22 | 61.3 | 100 % |
| Porous asphalt | 2 | 0.40 | 0.12 | 0.12 | 0.12 | 69.5 | 100 % |
| Porous asphalt | 7 | 0.40 | 0.40 | 0.40 | 0.40 | 46.3 | 100 % |
| Permeable pavers, clogged (old, silted up) | 2 | 0.90 | 0.87 | 0.88 | 0.88 | 6.7 | 0 % |
| Grass-reinforcement pavers | 2 | 0.42 | 0.39 | 0.46 | 0.46 | 40.8 | – |
| Grass-reinforcement pavers | 7 | 0.66 | 0.57 | 0.60 | 0.60 | 29.1 | – |
| Loose gravel | 2 | 0.60 | 0.21 | 0.33 | 0.33 | 51.6 | – |
| Loose gravel | 7 | 0.60 | 0.42 | 0.48 | 0.48 | 39.2 | – |
| Compacted gravel (stabilgrus) | 2 | 0.80 | 0.64 | 0.65 | 0.65 | 26.7 | – |
| Compacted gravel (stabilgrus) | 7 | 0.80 | 0.82 | 0.84 | 0.84 | 11.4 | – |
| Timber decking | 2 | 0.32 | 0.43 | 0.48 | 0.49 | 41.6 | – |
| Timber decking | 7 | 0.55 | 0.75 | 0.77 | 0.77 | 18.4 | – |
| Lawn, flat, compacted urban | 2 | 0.22 | 0.41 | 0.48 | 0.49 | 38.7 | – |
| Lawn, flat, compacted urban | 7 | 0.54 | 0.74 | 0.76 | 0.76 | 15.8 | – |
| Lawn, sloped > 5 % | 2 | 0.32 | 0.42 | 0.48 | 0.49 | 40.2 | – |
| Lawn, sloped > 5 % | 7 | 0.64 | 0.75 | 0.76 | 0.77 | 17.0 | – |
| Park lawn, good condition | 2 | 0.12 | 0.41 | 0.48 | 0.49 | 37.8 | – |
| Park lawn, good condition | 7 | 0.44 | 0.73 | 0.76 | 0.76 | 15.0 | – |
| Meadow, tall grass | 2 | 0.07 | 0.00 | 0.00 | 0.00 | 76.6 | – |
| Meadow, tall grass | 7 | 0.35 | 0.50 | 0.53 | 0.53 | 33.2 | – |
| Shrubs, planting beds | 2 | 0.06 | 0.00 | 0.00 | 0.00 | 74.6 | – |
| Shrubs, planting beds | 7 | 0.26 | 0.49 | 0.53 | 0.53 | 31.2 | – |
| Forest, dense trees | 2 | 0.01 | 0.00 | 0.00 | 0.00 | 72.6 | – |
| Forest, dense trees | 7 | 0.26 | 0.48 | 0.53 | 0.53 | 29.2 | – |
| Bare soil | 2 | 0.42 | 0.42 | 0.48 | 0.49 | 40.7 | – |
| Bare soil | 7 | 0.74 | 0.75 | 0.76 | 0.77 | 17.4 | – |
| Agricultural land | 2 | 0.32 | 0.00 | 0.00 | 0.00 | 77.6 | – |
| Agricultural land | 7 | 0.64 | 0.50 | 0.53 | 0.53 | 34.2 | – |
| Rain garden | 2 | 0.00 | 0.06 | 0.22 | 0.23 | 54.7 | no storage |
| Rain garden | 7 | 0.00 | 0.53 | 0.53 | 0.53 | 29.2 | no storage |
| Swale | 2 | 0.11 | 0.24 | 0.36 | 0.37 | 44.7 | – |
| Swale | 7 | 0.27 | 0.57 | 0.61 | 0.62 | 23.8 | – |
| Detention basin | 2 | 0.22 | 0.49 | 0.53 | 0.53 | 33.7 | – |
| Detention basin | 7 | 0.46 | 0.75 | 0.77 | 0.77 | 14.1 | – |
| Water surface | 2 | 1.00 | 1.00 | 1.00 | 1.00 | 0.0 | – |
| Wetland | 2 | 0.88 | 0.86 | 0.86 | 0.86 | 1.3 | – |

(Rows that do not depend on soil are shown once.) How to read it:

* **Non-infiltrating surfaces** (roofs including green and blue-green, asphalt, concrete, water): M1 and M2 agree to
  within 0.02. This is pinned by the test `instant_and_dynamic_agree_where_only_initial_loss_acts`.
* **Soil-table surfaces** (lawns, bare soil, decking, meadow, shrubs, forest, agricultural): M1 and M2 disagree by up
  to 0.3. On compacted soils M2 sheds **more** than M1's coefficients suggest (lawn on JB 2: 0.48 vs 0.22), because
  the 1-minute CDS peak (457 mm/h) far exceeds every compacted capacity. On loose sand M2 sheds nothing. M1's
  coefficients and M2's Horton table come from different sources (§3) and have not been reconciled; this is the main
  uncertainty of the tool and the PRD names it as such ("factor 3–8"). Use the moisture setting and the infiltration
  scale to bracket it.
* **Within M2, palette distinctions between soil-table materials vanish**: park lawn, compacted lawn, sloped lawn,
  bare soil and decking all use the same compacted JB row and differ only in Ia; meadow, shrubs, forest and
  agricultural land share the loose row. Their palette `f` values are not used by M2.
* **Rain garden / swale / basin**: point-scale numbers are not meaningful for elements whose purpose is to receive
  run-on and pond it in a depression. Their M1 coefficient (0 for a rain garden) assumes the element never overflows.

## 3. Parameter tables and their sources

### 3.1 JB soil classes (Horton fc / f0, mm/h; k = 5 h⁻¹)

Source: PRD table, attributed there to the SCALGO Live Denmark model report (Gade and Lerer 2022). The engine table
(`palette::SOILS`) is **pinned to the PRD table by the test `soil_table_matches_prd`**, which parses `docs/PRD.md`.
The primary source (Gade and Lerer 2022) has **not** been checked in this review: unverified.

| JB | Soil | Compacted fc / f0 | Loose fc / f0 | Clay weight (engine, for blending palette sand/clay columns) |
| --- | --- | --- | --- | --- |
| 1 | Coarse sand | 30 / 120 | 1000 / 4000 | 0.00 |
| 2 | Fine sand | 25 / 100 | 500 / 2000 | 0.05 |
| 3 | Coarse clayey sand | 21 / 85 | 150 / 500 | 0.20 |
| 4 | Fine clayey sand | 20 / 80 | 120 / 500 | 0.30 |
| 5 | Coarse sandy clay | 12 / 50 | 30 / 200 | 0.60 |
| 6 | Fine sandy clay | 9 / 47 | 25 / 100 | 0.70 |
| 7 | Clay | 5 / 20 | 20 / 50 | 0.85 |
| 8 | Heavy clay | 0.5 / 2 | 2 / 20 | 0.95 |
| 9 | Very heavy clay | 0.01 / 0.1 | 0 / 1 | 1.00 |
| 10 | Silt | 20 / 80 | 50 / 250 | 0.60 |
| 11 | Humus | 22 / 100 | 200 / 2000 | 0.20 |

Remarks:

* The "clay weight" is an engineering blending factor chosen in this code base, not a clay content; it is
  unverified and has no published source.
* JB 9: loose fc (0) is lower than compacted fc (0.01). Loosening should not reduce capacity; this looks like a
  transcription or rounding issue in the PRD table. Its effect is negligible (both ≈ 0). Not changed; to confirm
  against Gade and Lerer (2022).
* Plausibility against textbook saturated conductivities (Rawls, Brakensiek and Miller 1983, as recalled: sand
  ≈ 236 mm/h, sandy loam ≈ 22 mm/h, clay ≈ 0.6 mm/h; **quoted from memory, verify against the paper's table before
  citing**): the loose JB 1–2 rows (500–1000 mm/h) are 2–4 × higher than textbook sand, and the compacted clay rows
  (JB 5–7: 5–12 mm/h) are about an order of magnitude higher than textbook clay matrix conductivity. Such values are
  possible for macroporous Danish clay tills and well-structured topsoils, but they are not verified here. The
  compacted rows are the ones that matter for urban sites.
* k = 5 h⁻¹ for all classes is from the PRD; unverified.

### 3.2 Material palette (`data/palette.json`)

C normal = administrative runoff coefficient (retention panel only). C cloudburst = M1 event coefficient, sand / clay.
f = palette surface rate, mm/h (M2 uses it as fc with f0 = 3.5 fc, except for soil-table materials). Ia and storage in mm.

| id | C normal | C cloudburst | n | f | Ia | storage | M2 treatment |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `roof_pitched` | 1 | 1 | 0.013 | 0 | 0.5 | 0 | sealed |
| `roof_flat` | 1 | 1 | 0.015 | 0 | 2 | 0 | sealed |
| `roof_green_ext` | 0.55 | 0.8 | 0.1 | 0 | 15 | 0 | sealed; Ia only |
| `roof_green_int` | 0.3 | 0.5 | 0.15 | 0 | 50 | 0 | sealed; Ia only |
| `roof_bluegreen` | 0.2 | 0.3 | 0.05 | 0 | 60 | 0 | sealed; Ia only (no outlet) |
| `asphalt` | 1 | 1 | 0.016 | 0 | 1.5 | 0 | sealed |
| `concrete` | 1 | 1 | 0.015 | 0 | 1 | 0 | sealed |
| `pavers` | 0.8 | 0.9 | 0.018 | 2 | 2 | 0 | sealed (sewered), infiltrates |
| `setts` | 0.8 | 0.88 | 0.025 | 5 | 3 | 0 | sealed (sewered), infiltrates |
| `permeable_pavers` | 0.7 | 0.3 | 0.02 | 250 | 3 | 45 | sub-base → subsoil (compacted JB row) |
| `porous_asphalt` | 0.7 | 0.4 | 0.016 | 250 | 3 | 30 | sub-base → subsoil (compacted JB row) |
| `permeable_pavers_clogged` (new) | 0.8 | 0.9 | 0.02 | 2 | 3 | 45 | sub-base → subsoil (compacted JB row) |
| `grass_pavers` | 0.5 | 0.4 / 0.7 | 0.035 | 30 / 10 | 4 | 0 | palette rate |
| `gravel_loose` | 0.6 | 0.6 | 0.025 | 60 / 20 | 4 | 0 | palette rate |
| `gravel_compacted` | 0.5 | 0.8 | 0.022 | 10 / 2 | 2 | 0 | palette rate |
| `rubber` | 1 | 1 | 0.015 | 0 | 1 | 0 | sealed |
| `decking` | 0.3 | 0.3 / 0.6 | 0.03 | 25 / 5 | 1 | 0 | soil table, compacted |
| `lawn_compacted` | 0.1 | 0.2 / 0.6 | 0.035 | 25 / 5 | 4 | 0 | soil table, compacted |
| `lawn_sloped` | 0.1 | 0.3 / 0.7 | 0.035 | 25 / 5 | 2.5 | 0 | soil table, compacted |
| `park_lawn` | 0.1 | 0.1 / 0.5 | 0.04 | 50 / 10 | 5 | 0 | soil table, compacted |
| `meadow` | 0.1 | 0.05 / 0.4 | 0.08 | 100 / 20 | 6 | 0 | soil table, loose |
| `shrubs` | 0.1 | 0.05 / 0.3 | 0.1 | 150 / 25 | 8 | 0 | soil table, loose |
| `forest` | 0.1 | 0 / 0.3 | 0.15 | 500 / 20 | 10 | 0 | soil table, loose |
| `bare_soil` | 0.2 | 0.4 / 0.8 | 0.025 | 15 / 2 | 2 | 0 | soil table, compacted |
| `agricultural` | 0.1 | 0.3 / 0.7 | 0.06 | 20 / 5 | 5 | 0 | soil table, loose |
| `rain_garden` | 0 | 0 | 0.1 | 100 | 10 | 0 | media 100 mm/h → subsoil (loose JB row); `pondingMm` 200 not applied |
| `swale` | 0 | 0.1 / 0.3 | 0.1 | 50 / 5 | 8 | 0 | palette rate; `pondingMm` 150 not applied |
| `basin` | 0 | 0.2 / 0.5 | 0.06 | 20 / 2 | 5 | 0 | palette rate; `pondingMm` 500 not applied |
| `water` | 1 | 1 | 0.03 | 0 | 0 | 0 | sealed, **not** sewer-connected |
| `wetland` | 0.1 | 0.9 | 0.1 | 0.5 | 10 | 0 | palette rate |

Sources and checks:

* Every value above that the PRD tables give was checked against `docs/PRD.md` ("Material palette"): all are equal
  to the PRD value or lie inside the PRD range. Values the PRD does **not** give, chosen in the code base:
  blue-green roof C 0.2 / 0.3 (PRD: "storage"); timber decking C and f (PRD: "as ground below"); swale C, f;
  detention basin row (not in the PRD material table); porous asphalt storage 30 mm (this review: the lower end of the
  PRD's 30–60 mm permeable-paving range, applied by analogy, **unverified**); rain-garden Ia 10 mm (the PRD's Ia column
  says "ponding 150–300", which is a terrain depression, not a bucket); clogged permeable pavers (this review: C 0.9 is
  the PRD's clogged value, f 2 mm/h and C normal 0.8 are taken from "concrete pavers, sand joints", **unverified**).
* PRD itself: "C cloudburst … engineering estimates, not standard values"; "the permeable-paving and rain-garden
  rates attributed to CIRIA C753 came from secondary sources and need checking". Not checked in this review.
* Danish administrative coefficients (C normal): the values (roofs/asphalt/concrete 1.0, paving 0.8, gravel 0.5–0.6,
  green 0.1) are of the order commonly used in Danish spildevandsplaner; they were **not** checked against the text of
  Spildevandskomiteen Skrift 27/30/31 in this review. Municipal values differ (PRD: gravel 0.3–0.6); permit numbers
  must come from the local spildevandsplan.
* The palette is a single file: the Rust engine embeds `data/palette.json`, `Cloudburst.Net` embeds the same file
  (`Cloudburst.Net.csproj`), and the web app reads it from the wasm engine (`cb_default_palette_json`). The soil table
  exists only in Rust. The .NET class `SurfaceMaterial` re-serialises the palette when calling the engine, so every
  palette field must exist there; the test `dotnet_palette_class_knows_every_palette_field` enforces it.

## 4. What is and is not validated

Automated (`cargo test --release`, all passing at this commit):

| Test | Closed form / check | Result |
| --- | --- | --- |
| `infiltration::ponded_cumulative_matches_analytic_for_any_dt` | ponded F vs `fc·t + (f0−fc)/k·(1−e^(−kt))`, Δt 0.5–600 s, 4 h, JB 6 dry | max rel. dev. 3.5·10⁻⁴ (Δt 0.5 s, float32), 7.5·10⁻⁸ (Δt 600 s) |
| `infiltration::capacity_does_not_decay_while_dry` | state unchanged over 2 h dry; capacity equals Newton-inverted f(F) | pass |
| `infiltration::rain_below_fc_gives_zero_runoff` | i < fc ⇒ runoff 0 | exactly 0 |
| `infiltration::water_limited_converges_with_dt_halving` | triangular storm, Δt 20 → 1.25 s | point runoff varies < 1·10⁻⁴ mm |
| `infiltration::subbase_fills_then_limits_to_subsoil_rate` | accepted = S + d·(T − Ia/i) | within 0.02 mm |
| `infiltration::infiltration_cap_is_exact` | F = Fmax | within 10⁻⁴ mm |
| `permeability::rain_below_fc_never_ponds` (full M2) | no ponding, F = P − Ia | pass |
| `permeability::ponding_above_fc_matches_closed_form_wet` | h = i·T − Ia − fc·(T − Ia/i) = 28.5 mm | within 0.05 mm |
| `permeability::ponding_above_f0_matches_horton_integral_dry` | h = i·T − Ia − F_Horton(T − Ia/i) | within 0.05 mm (the previous Horton form gave 2.4 mm less ponding) |
| `permeability::permeable_paving_subbase_fills_on_heavy_clay` | h = P − Ia − S − d·(T − Ia/i) | within 0.1 mm; all cells report full |
| `permeability::permeable_paving_on_sand_does_not_fill` | no ponding, peak fill 50–75 % | pass |
| `permeability::high_groundwater_cap_stops_infiltration` | F = 5 mm everywhere | pass |
| `permeability::mass_balance_closes_with_infiltration_on` | sloped site, open edges, lawn + sub-base + caps, CDS | error −3.0·10⁻⁷; Σ per-cell F = reported infiltrated volume |
| `permeability::dynamic_runoff_converges_when_time_step_is_halved` | α 0.6 vs 0.3 (Δt halved) | infiltrated volume differs 2.0·10⁻³ relative |
| `permeability::instant_and_dynamic_agree_where_only_initial_loss_acts` | M1 vs M2 on non-infiltrating surfaces | within 3 % of P |
| `permeability::soil_table_matches_prd`, `dotnet_palette_class_knows_every_palette_field`, `palette_is_physically_consistent`, `open_water_gets_no_sewer_loss`, `subbase_storage_is_not_double_counted_as_initial_loss` | table pinning and invariants | pass |

These verify that the equations are **solved correctly**. They do not show that the **parameters** are right.

Not validated:

* No comparison with measured infiltration, field runoff, SCALGO Live, MIKE or any calibrated model has been made.
* No parameter value in §3 has been checked against its primary source in this review.
* Green-Ampt and SCS Curve Number (PRD expert options) are not implemented.

## 5. Known limitations (as implemented)

1. **No recovery** of infiltration capacity between or within events; F only increases. Acceptable for one event of a
   few hours; not for continuous or multi-day simulation.
2. **Initial loss only from direct rain**; depressions and interception never fill from run-on, and infiltration of
   direct rain waits until the bucket is full.
3. **Sub-base**: starts empty for every moisture setting; no underdrain, outlet or lateral flow; drains at the JB
   soil fc, which is a stand-in for a measured subsoil hydraulic conductivity. Danish LAR design uses site-measured
   values; use the infiltration scale or the soil class to bracket.
4. **Rain gardens, swales, basins**: ponding storage only exists if the depression is modelled in the terrain;
   `pondingMm` is informational. Rain-garden media pore storage is neglected (conservative).
5. **Blue-green and green roofs** are initial-loss buckets that never drain; no throttled outlet. Fine for the peak of
   one event; wrong for back-to-back events.
6. **Soil-table materials** lose their palette distinctions in M2 (§2).
7. **Groundwater**: only a per-cell cap supplied by the caller; no default value, no groundwater map, no
   saturation-excess runoff or rising water table.
8. **Infiltration-excess only**: infiltration depends on the design-storm peak. The CDS generator uses 1-minute
   blocks (T = 100 peak 457 mm/h after climate factor), now also what the PRD states (F14). Measured on the school yard
   the event totals are insensitive to the block length (a 5- or 10-minute peak changes infiltration by < 1 %); the
   wet area over 10 cm changes by up to 9 %. Infiltration-excess is still the only runoff mechanism modelled.
9. **Float32** per-cell state: relative accuracy of F ~10⁻⁴ over long runs at small Δt.
10. M1's sewer loss uses a fixed 4 h for the capacity sink, regardless of rain duration.

## 6. Review findings

Severity: **High** = changes results materially in a non-conservative direction; **Medium** = material but bounded
or conservative; **Low** = small effect, bookkeeping or documentation.

| # | Finding | Severity | Status |
| --- | --- | --- | --- |
| F1 | **Horton not driven by cumulative infiltration correctly.** Capacity was `fc + (f0−fc)·e^(−k·F/f0)`, i.e. the equivalent time was taken as F/f0 instead of inverting the Horton integral. Under ponding this overstates capacity (JB 6 compacted, dry: +41 % at 1 h, F +27 %; JB 2 compacted dry: +25 %, F +20 %; moist setting +2–5 %). Under-predicts runoff. | High (dry setting), Low (moist, the default) | Fixed: exact equivalent-time form (§1.4), tests against the analytic integral. |
| F2 | **Permeable surfaces were bottomless.** Sub-base storage was added to the initial-loss bucket (filled only by rain falling on the paving, never by run-on, never draining), and the 250 mm/h surface rate was applied forever on any soil. Permeable paving or porous asphalt on clay therefore never filled; it shed water only when the rain intensity exceeded 250 mm/h, whatever the soil. | High | Fixed: sub-base reservoir draining to the JB subsoil fc (§1.5). On the school LAR sample the dynamic model's total losses (Ia + infiltration) fall from 861 to 626 m³ and boundary outflow rises from 822 to 1042 m³ (T = 100 CDS, default settings). |
| F3 | **No clogged permeable-paving state** although the PRD asks for one (C 0.9). | Medium | Fixed: `permeable_pavers_clogged` appended to the palette (values partly unverified, §3.2). |
| F4 | **High-groundwater cut-off missing** (PRD: zero infiltration after the first few mm). | Medium | Engine support added (per-cell cap, FFI, wasm). Not fixed end-to-end: no default value, no groundwater data, no UI. |
| F5 | **M1 double-counted the initial loss**: `(P − Ia)·C` with C already an event coefficient. Green roofs: M1 0.65 vs M2 0.82; intensive 0.20 vs 0.39; blue-green 0.08 vs 0.27. Also subtracted the 45 mm permeable-paving sub-base before applying C 0.3. | Medium (non-conservative for green roofs) | Fixed: `min(C·P, P − Ia)` (§1.7), pinned against M2 by a test. M1 sample results change by ≤ 6 m³ (demo 376 → 380 m³, residential street 92 → 98 m³). The PRD (M1 step 1) now states this formula. |
| F6 | **Open water lost 34 mm to the sewer** in the default sewer mode because "sealed" implied "sewered". | Low | Fixed: `sewerConnected` (default = sealed; false for water). |
| F7 | Mass balance: infiltration **was** tracked exactly and **was** included in the reported error. Now also tested with infiltration, sub-bases and caps active (error 3·10⁻⁷). | – | No defect. |
| F8 | Units (mm/h → m/s, k h⁻¹ → s⁻¹), limiting by available water (rain + ponded + run-on), moisture rule, no negative depths: correct. | – | No defect. |
| F9 | Time-step dependence: old explicit update was first order with k·Δt ≤ 0.014; acceptable. The new update is exact when ponded and second order otherwise. | – | Improved with F1. |
| F10 | **M1 and M2 disagree strongly on soil surfaces** (§2), and M2 ignores the palette rates of soil-table materials, so e.g. park lawn = compacted lawn in M2. | Medium | Not fixed (parameter reconciliation needs a reference, e.g. a calibrated SCALGO/MIKE run). Documented. |
| F11 | `pondingMm` (rain garden 200, swale 150, basin 500 mm) is never applied. | Low | Not fixed by design (ponding must be terrain); documented in code and here. |
| F12 | JB 9 loose fc (0) < compacted fc (0.01). | Low | Not fixed; flagged for checking against the source. |
| F13 | Blue-green roof is a lost bucket with no throttled outlet; green roofs never drain; no recovery of capacity. | Low (single event) | Not fixed; documented (§5). |
| F14 | Design-storm peak (1-minute CDS blocks, 457 mm/h for T = 100 × 1.4) is about twice the PRD's quoted peak; infiltration-excess results on permeable surfaces depend directly on it. Rain generation is outside this review's scope. | Medium | Resolved as a PRD inconsistency, not a code defect: the 1-minute CDS is kept (Danish practice); the PRD's 151/231 mm/h could not be reproduced from the tool's IDF at any block length and now quote 252/457 mm/h with the block length, IDF and scaling spelled out (PRD "Rain events to ship"). Peaks and depths of all four presets pinned by `rain::tests::preset_peaks_and_depths_are_pinned`. Sensitivity (school yard, 2 m, T = 100): a 5- or 10-minute block changes infiltration < 1 %, outflow < 0.5 %, area > 10 cm up to 9 %. The IDF stays labelled indicative. |
| F15 | The .NET palette class would have silently dropped any new palette field on its JSON round trip. | Low | Fixed for the new fields; pinned by a test. |
