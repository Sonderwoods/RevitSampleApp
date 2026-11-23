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

export const VELOCITY = classed('velocity', 'Max velocity', 'm/s', 0.05, [0.25, 0.5, 1, 2],
  ['#FFF3B0', '#FFD166', '#F4A259', '#E76F51', '#9B2226'],
  ['0.05–0.25', '0.25–0.5', '0.5–1', '1–2', '> 2']);

export const HAZARD = classed('hazard', 'Flood hazard  h·(v+0.5)', 'm²/s', 0.0001, [0.5, 0.75, 1.25, 2],
  ['#DDEFC4', '#FFE08A', '#F6A04D', '#E04F39', '#7B1E7A'],
  ['< 0.5  low', '0.5–0.75  caution', '0.75–1.25  danger for some', '1.25–2  danger for most', '> 2  danger for all']);

export const TPEAK = classed('tpeak', 'Time to peak depth', 'min', 0, [30, 60, 90, 120, 180],
  ['#FDE725', '#7AD151', '#22A884', '#2A788E', '#414487', '#440154'],
  ['0–30', '30–60', '60–90', '90–120', '120–180', '> 180']);

/** Difference B − A in metres: green drier, red wetter. */
export const DIFF = {
  id: 'diff', title: 'Depth change  B − A', unit: 'cm',
  colors: ['#1B7837', '#5AAE61', '#A6DBA0', '#F4A582', '#D6604D', '#B2182B'],
  labels: ['< −20 drier', '−20 to −10', '−10 to −1', '+1 to +10', '+10 to +20', '> +20 wetter'],
  index(d) {
    if (!(Math.abs(d) >= 0.01)) return -1;
    if (d < -0.2) return 0; if (d < -0.1) return 1; if (d < 0) return 2;
    if (d <= 0.1) return 3; if (d <= 0.2) return 4; return 5;
  },
};
DIFF.rgb = DIFF.colors.map(hexToRgb);

export const LAYERS = {
  depth: { ramp: DEPTH, label: 'Depth', needsDynamic: false },
  velocity: { ramp: VELOCITY, label: 'Velocity', needsDynamic: true },
  hazard: { ramp: HAZARD, label: 'Hazard', needsDynamic: true },
  tpeak: { ramp: TPEAK, label: 'Time to peak', needsDynamic: true },
  materials: { ramp: null, label: 'Materials', needsDynamic: false },
};
