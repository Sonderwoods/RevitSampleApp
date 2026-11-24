# UI review: visual redesign of the web app (Nov 2026)

**Brief (product owner).** "UI - make it look apple": the design language of current macOS/iPadOS productivity apps
and apple.com tools, without copying any Apple product, logo, icon or other asset.

**Scope.** `Web/styles.css` (rewritten as one token-based stylesheet), `Web/report.css`, `Web/index.html` (head, logo
markup), `Web/manifest.webmanifest`, `Web/sw.js` (cache name), small class swaps in `Web/js/dhm.js`, the icon stroke
weight in `Web/js/util.js`. No behaviour, wording, DOM ids, data hooks or `js/hooks.js` API changed. The WPF theme
(`Shared/Cloudburst.UI/Themes/Theme.xaml`) got colour values only and was not compiled (see the end).

**Method.** `python3 Web/serve.py 8471`, Playwright at 1440 × 900, 1280 × 720 / 1280 × 800 and 390 × 844, in
`colorScheme: light` and `dark`: start page, every step, quick check, a full simulation running and done, the Danger
layer, saving options A and B, compare (difference and side by side), the report dialog, the location/terrain-source
sheet (Denmark and world), a real site with no terrain, phone layout. Three critique rounds on the screenshots;
contrast measured by a script over every visible DOM text run (below).

## Before / after

Before was dark only, so the before column is the dark original. Images in [ui/](ui/) are 1×, quantised to 256
colours to keep the repo small (slight banding on the map); the README screenshots in `Web/screenshots/` are 2× and
lossless.

| Before | After, light | After, dark |
| --- | --- | --- |
| ![](ui/before-start.png) | ![](ui/after-start-light.png) | ![](ui/after-start-dark.png) |
| ![](ui/before-workspace-hint.png) | ![](ui/after-workspace-hint-light.png) | ![](ui/after-workspace-hint-dark.png) |
| ![](ui/before-compare.png) | ![](ui/after-compare-light.png) | ![](ui/after-compare-dark.png) |
| ![](ui/before-report.png) | ![](ui/after-report-light.png) | ![](ui/after-report-dark.png) |
| ![](ui/before-dhm.png) | ![](ui/after-dhm-light.png) | ![](ui/after-dhm-dark.png) |
| ![](ui/before-real-site.png) | ![](ui/after-real-site-light.png) | ![](ui/after-real-site-dark.png) |
| ![](ui/before-phone-workspace.png) | ![](ui/after-phone-workspace-light.png) | ![](ui/after-phone-workspace-dark.png) |

## What was un-Apple about the previous look, and why

1. **A web font from a CDN** (Inter via jsDelivr) in an offline PWA: a blocked request on every load, and a typeface
   that is not the platform's. Apple tools use the system font, which also matches the host OS on Windows.
2. **Dark navy only.** No light theme, no `prefers-color-scheme`; navy-tinted greys (`#0e1828`, `#132033`…) instead
   of neutral greys. Apple's neutral surfaces let the one accent and the data colours carry the colour.
3. **Many accents and gradients.** Blue-gradient primary buttons with glow shadows, orange "accent" buttons, a
   gradient headline, gradient big numbers, gradient step numbers, gradient progress with a sweep. Apple uses flat
   fills and one tint; emphasis comes from weight and size.
4. **Borders everywhere.** Every card, tile, step, input and chip had a 1 px border, often on top of a filled
   background. Apple separates with space, surface contrast and 0.5 px hairlines.
5. **No type scale.** 25 different sizes (9.5–40 px, 10.5 / 11 / 11.5 / 12 / 12.5 / 13 / 13.5 …), uppercase tracked
   eyebrows, 750-weight titles. Now seven sizes on a scale, sentence-case eyebrows, tight tracking only on large titles.
6. **Controls looked bespoke.** Segmented controls with accent-filled selected segments, rectangular buttons of
   36 px, toggles of 24 × 14 px, unstyled native selects and checkboxes, form labels in uppercase small caps.
7. **Contrast was never measured**; muted text `#7f93ad` on `#132033` was about 4.6:1 but `#5d7391`-style text and
   orange-on-orange tags were below AA.
8. **Inline styles in the location sheet** (`style="height:30px;font-size:12px"`, a hard-coded `#e0a030`), and the
   UX pass's functional CSS appended as a second stylesheet at the end, overriding earlier rules (`.hero`, `.presets`,
   `.preset`, `.step-head`, `.caption`, `.legend` were each defined twice).
9. **Phone layout overlapped itself**: with `min-height: 0` on the panels inside a fixed-height grid, the results
   column was drawn over the steps column below 1050 px.

## Design tokens now in force

All in one `:root` block at the top of `Web/styles.css`, light values first and dark values in one
`@media (prefers-color-scheme: dark)` override. **Do not put a colour, radius, shadow or duration anywhere else**;
`report.css` uses the same tokens. Data colours (map ramps in `js/colors.js`, stack-bar and swatch colours set inline
by `app.js`) are deliberately not tokens and were not changed.

| Group | Tokens | Rule |
| --- | --- | --- |
| Font | `--font` (SF Pro Text → Segoe UI Variable → system-ui), `--font-display` (titles ≥ 17 px), `--mono` | No web fonts. |
| Type scale | `--fs-2xs` 10.5 · `--fs-xs` 11 · `--fs-sm` 12 · `--fs-md` 13 (body) · `--fs-lg` 15 · `--fs-xl` 17 · `--fs-2xl` 22 · `--fs-3xl` 28 · `--fs-hero` 36–60 | Pick from the scale; no new sizes. |
| Tracking | `--track-tight` −0.028em (≥ 28 px), `--track-title` −0.014em (17–22 px), `--track-body` | Tight tracking only on large titles. |
| Figures | `font-variant-numeric: tabular-nums` | On every number that can change (tiles, tables, legends, chips, progress). |
| Space | `--sp-1`…`--sp-12` (4 px grid) | |
| Radius | `--r-xs` 6 · `--r-sm` 8 (fields) · `--r-md` 10 (insets, segmented) · `--r-lg` 14 (cards, steps, tiles) · `--r-xl` 18 (gallery cards, hint) · `--r-2xl` 22 (sheets) · `--r-pill` | Nested radius = outer − padding. |
| Neutrals | `--bg`, `--surface`, `--surface-sheet`, `--fill`, `--fill-2`, `--fill-3`, `--separator`, `--separator-strong` | Fills are translucent greys so they work on any surface. |
| Text | `--label`, `--label-2`, `--muted` | `--muted` is the faintest text allowed (AA). |
| Accent | `--accent` (fill), `--accent-hover`, `--accent-active`, `--on-accent`, `--accent-text` (links, tinted text), `--accent-soft`, `--accent-ring` (focus halo) | One accent: water blue `#0a6fd1`. |
| Status | `--good`, `--bad`, `--warn` (+ `-soft` fills, `--good-dot`) | Status text always has a word or icon too. |
| Options | `--opt-a`, `--opt-b` (+ `-soft`) | A is blue, B is amber, as in the report. |
| Materials | `--glass`, `--glass-solid`, `--glass-border`, `--glass-text-2`, `--bg-glass`, `--popover`, `--hud`, `--blur` | Translucent, with a solid fallback. |
| Controls | `--field-bg`, `--field-border`, `--seg-thumb`, `--seg-thumb-text`, `--seg-on-text`, `--knob`, `--chevron-down` | |
| Shadows | `--shadow-card`, `--shadow-raised`, `--shadow-pop`, `--shadow-sheet`, `--shadow-control`, `--shadow-knob`, `--shadow-float` | Dark theme uses hairline rings instead of drop shadows. |
| Motion | `--ease`, `--ease-out`, `--dur-1` 120 ms, `--dur-2` 200 ms, `--dur-3` 320 ms | |
| Data constants | `--map-stage` `#0b1320` (equals `BG` in `js/mapview.js`), `--data-flow`, `--data-pond`, `--data-spill`, `--data-halo`, `--brand-1/2` | Same in both themes. |

## Component rules

* **Buttons** are pills. `.btn` (grey fill), `.btn.primary` (accent fill, white text), `.btn.ghost` (= grey), `.btn.accent`
  (tinted), `.small`, `.wide`. **One `.primary` per view** (per step / sheet). Hover darkens, press scales to 0.97,
  disabled is 40 % opacity and keeps its title/tooltip with the reason.
* **Mode switches are segmented controls** (`.segctl`, `.subseg`, `.rpt-seg`): grey track, raised thumb for the
  selected segment, bold label. Map layer switches use the same thumb inside the glass bar.
* **Settings are grouped inset lists**: steps and result cards are white groups on the grey page (iOS grouped style);
  inside them, lists (rain presets, surfaces, options, report options) are `--fill-2` insets with hairline separators.
* **Fields and selects** share one rule (8 px radius, 1 px `--field-border` at ≥ 3:1, accent border + 3 px ring on
  focus, drawn chevron for selects). Any new `input`, `select` or `textarea` gets it without a class.
* **Switches** are 30 × 18 px with a white knob; on = accent.
* **Disclosure** (`details.advanced`) uses a drawn chevron that rotates, in accent text.
* **Banners**: info = `--fill-2`; warning = `--warn-soft` with `--warn` text and an icon (`.stale`, `.step-warn`);
  verdicts and hot/good tiles are tinted backgrounds with the figure in the status colour **and** a sentence/icon.
* **Floating over the map**: `.glass` (translucent, 20 px blur, saturate 180 %); tooltips and search results use
  `--popover`; toasts are a dark HUD capsule in both themes.
* **Sheets** (location dialog, report dialog): 22 px radius, no header rule, round grey close button, footer with the
  primary button rightmost.
* **Icons**: the existing self-drawn 24 px line set in `js/util.js` (now 1.75 stroke to sit with 13 px text). No icon
  font, no emoji. The logo is a white drop on a blue rounded square drawn in `index.html` (no Apple asset).
* **Map stage stays dark in both themes.** The canvas (`js/mapview.js`) paints its own navy background, building
  labels and pond labels designed for it; a light chrome around a dark viewing stage is the Photos/Final Cut
  convention, and it keeps the data ramps' look unchanged.
* **Motion**: 120–320 ms, ease-out for things that arrive; `prefers-reduced-motion` turns transitions and animations
  off; `prefers-reduced-transparency` and missing `backdrop-filter` switch materials to solid colours.
* **Touch**: under `(pointer: coarse)` buttons, segments, toggles and fields grow to 36–44 px.

## Contrast (WCAG 2.1 AA), measured

A Playwright script walked every visible DOM text node in 11 states (start, start bottom, location sheet, workspace
with hint, steps 3–6, retention open, compare, report dialog, real site without terrain) in both themes, composited
each element's background chain (translucent fills over their parents, glass over the map stage) and computed the
ratio. **Result: 1 173 text runs per theme, 0 below AA** (4.5:1, or 3:1 for ≥ 24 px / ≥ 18.7 px bold). Disabled /
inert controls are excluded as WCAG allows. Canvas-drawn text (map labels, scale bar) is not in the DOM and was not
measured; it is white on dark pills.

Key token pairs:

| Pair | Light | Dark |
| --- | --- | --- |
| `--label` on `--surface` | 16.8 | 15.4 |
| `--label-2` on `--surface` | 10.0 | 11.2 |
| `--muted` on `--surface` / on `--bg` | 5.07 / 4.66 | 6.54 / 7.33 |
| `--accent-text` on `--surface` / on `--accent-soft` | 5.93 / 5.18 | 7.55 / 6.01 |
| white on `--accent` / on `--accent-hover` | 4.99 / 6.04 | 4.99 / 6.04 |
| `--bad` on `--bad-soft` | 5.02 | 5.74 |
| `--good` on `--good-soft` | 5.40 | 7.14 |
| `--warn` on `--warn-soft` | 5.72 | 7.38 |
| `--glass-text-2` on glass over the map | 7.44 | 8.94 |
| white on selected segment thumb (dark) | – | 6.75 |
| Non-text: `--field-border` on field, focus ring on background | 3.30, 5.44 | 3.90, 7.55 |

Smallest measured values in the UI: muted 4.66 (light) / 5.58 (dark), legend 4.86 / 7.11, buttons 4.99.
Known weak spot: the selected segment is distinguished from the track by a white thumb and bold text (Apple's
pattern) rather than a 3:1 boundary; `aria-pressed` carries the state for assistive tech.

## Verification

* `node --test Web/tests/*.test.mjs`: 31/31 pass.
* `node tools/report-e2e.cjs http://localhost:8471/ <out> en`: single (9 pages, dynamic run) and comparison
  (11 pages) PDFs generated through the restyled dialog; app numbers equal report-model numbers; difference-map sign
  checks pass.
* Playwright walkthrough in both themes: example site → quick check → full simulation (4 m and 2 m cells) to
  completion → Danger layer → save A → swap asphalt → save B → compare (both modes) → report dialog. No page errors
  and no console errors other than the blocked CDN requests (Leaflet, three.js, tiles).

## What remains

* **WPF panel** (`Shared/Cloudburst.UI`): only colour values in `Themes/Theme.xaml` were aligned with the dark tokens
  (neutral greys, flat `#0A6FD1` primary instead of the cyan→blue gradient whose cyan end gave white text ~2.6:1,
  `#63B3FF` accent text, status colours). Keys, brushes and templates are unchanged. **Uncompiled and unseen.** A
  Windows developer should: build and look at the panel in Rhino and Revit; check `B.TextFaint` text (now `#7C7C82`,
  about 4.0:1 on `Surface`) and raise it if it carries information; consider a light variant keyed to the host theme
  (Revit is light by default), radii 8 → 10/14 for cards and pill buttons (`CornerRadius` = half the height) to match
  the web; and replace remaining hard-coded colours in `CloudburstPanel.xaml` (8 literals) with theme keys.
* **Views I could not see** (CDNs blocked in the sandbox): the Leaflet map in the location sheet (its controls and
  attribution use Leaflet's own CSS; our sheet frames it), the 3D view (three.js canvas), and therefore the timebar
  over the 3D view. Styled by reading only.
* **Phone (≈ 390 px)**: works and does not overlap, but it is a stacked desktop layout, not a phone design. The map
  chrome scrolls horizontally, the legend and first-run note cover much of a 68 vh map, and the engine chip shrinks
  to its dot. A real phone layout (bottom sheet for steps/results, legend as a chip) needs markup/JS changes.
* **Manifest** colours are single values (`#f5f5f7`); the dark splash screen of an installed app is therefore light.
  The page sets `theme-color` per scheme.
* **Canvas-drawn UI** in `js/mapview.js` (scale bar, north arrow, pond labels, building labels, swipe handle) and the
  PNG export in `app.js` keep their dark styling and `Inter, system-ui` canvas fonts (Inter now falls back to the
  system font). Moving those to tokens would need the canvas to read CSS variables, i.e. a JS change.
* The legend's collapse control is a text glyph (`▾` / `Legend ▸`) set in `app.js`; left as is.
