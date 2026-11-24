// Colour classes for every map layer (OUT-1 conventions) + legend descriptions.

export const hexToRgb = (hex) => {
  const v = parseInt(hex.replace('#', ''), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
};

/** A classed ramp: values < min are transparent, then colours[k] for breaks[k-1] <= v < breaks[k]. */
function classed(id, title, unit, min, breaks, colors, labels, extra = {}) {
  const rgb = colors.map(hexToRgb);
  return {
    id, title, unit, min, breaks, colors, labels, rgb, ...extra,
    index(v) {
      if (!(v >= min)) return -1;
      let k = 0; while (k < breaks.length && v >= breaks[k]) k++;
      return k;
    },
  };
}

export const DEPTH = classed('depth', 'Water depth', 'cm', 0.01, [0.10, 0.20, 0.30, 0.50],
  ['#B9E3F7', '#4FA8E0', '#1F78C8', '#0D4FA0', '#08306B'],
  ['0–10', '10–20', '20–30', '30–50', '> 50']);

export const VELOCITY = classed('velocity', 'Fastest water speed', 'm/s', 0.05, [0.25, 0.5, 1, 2],
  ['#FFF3B0', '#FFD166', '#F4A259', '#E76F51', '#9B2226'],
  ['0.05–0.25', '0.25–0.5', '0.5–1', '1–2', '> 2']);

export const HAZARD = classed('hazard', 'Danger to people', 'h·(v+0.5), m²/s', 0.0001, [0.5, 0.75, 1.25, 2],
  ['#DDEFC4', '#FFE08A', '#F6A04D', '#E04F39', '#7B1E7A'],
  ['Low  (< 0.5)', 'Caution  (0.5–0.75)', 'Danger for some  (0.75–1.25)', 'Danger for most  (1.25–2)', 'Danger for all  (> 2)']);

export const TPEAK = classed('tpeak', 'Time until deepest', 'min after rain starts', 0, [30, 60, 90, 120, 180],
  ['#FDE725', '#7AD151', '#22A884', '#2A788E', '#414487', '#440154'],
  ['0–30', '30–60', '60–90', '90–120', '120–180', '> 180']);

/** Total infiltration per cell over the event (dynamic model), mm; includes water that entered a sub-base. */
export const INFIL = classed('infil', 'Soaked into the ground', 'mm', 1, [10, 25, 50, 100],
  ['#E5F5E0', '#A1D99B', '#5AAE61', '#238B45', '#00441B'],
  ['1–10', '10–25', '25–50', '50–100', '> 100']);

/** Difference B − A in metres: green drier, red wetter. */
export const DIFF = {
  id: 'diff', title: 'Change in depth, B vs A', unit: 'cm',
  colors: ['#1B7837', '#5AAE61', '#A6DBA0', '#F4A582', '#D6604D', '#B2182B'],
  labels: ['Drier by > 20', 'Drier by 10–20', 'Drier by 1–10', 'Wetter by 1–10', 'Wetter by 10–20', 'Wetter by > 20'],
  index(d) {
    if (!(Math.abs(d) >= 0.01)) return -1;
    if (d < -0.2) return 0; if (d < -0.1) return 1; if (d < 0) return 2;
    if (d <= 0.1) return 3; if (d <= 0.2) return 4; return 5;
  },
};
DIFF.rgb = DIFF.colors.map(hexToRgb);

export const LAYERS = {
  depth: { ramp: DEPTH, label: 'Depth', needsDynamic: false, tip: 'How deep the water gets' },
  velocity: { ramp: VELOCITY, label: 'Speed', needsDynamic: true, tip: 'How fast the water runs (full simulation only)' },
  hazard: { ramp: HAZARD, label: 'Danger', needsDynamic: true, tip: 'Danger to people from depth and speed (full simulation only)' },
  tpeak: { ramp: TPEAK, label: 'Timing', needsDynamic: true, tip: 'Minutes until the water is deepest (full simulation only)' },
  infil: { ramp: INFIL, label: 'Soaked in', needsDynamic: true, tip: 'How much rain soaked into the ground or a sub-base, in mm (full simulation only)' },
  materials: { ramp: null, label: 'Surfaces', needsDynamic: false, tip: 'The surface materials the model uses' },
};
