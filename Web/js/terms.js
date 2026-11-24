// Plain-language explanations for the technical terms the UI cannot avoid. One place, so the wording stays consistent.
import { h } from './util.js';

export const TERMS = {
  bluespot: 'A low spot where rainwater collects and stands (hydrologists call it a "bluespot"). When it is full, it overflows into the next one downhill.',
  returnPeriod: '"100-year rain" (T = 100) is a storm so heavy it happens on average once every 100 years. Copenhagen designs cloudburst solutions for this one.',
  climate: 'Future rain is heavier. The climate factor scales today\'s rain up, e.g. × 1.4 = 40 % more rain for a 100-year storm (Danish practice).',
  designRain: 'The total rain that falls on the site in this storm, after the climate factor. This is what the model pours onto the terrain.',
  sewer: 'Paved areas and roofs drain to a sewer, which takes the first part of the rain (34 mm combined / 29 mm separate) before water starts running on the surface.',
  moisture: 'How wet the ground is before the storm. Wet ground soaks up less rain, so more of it runs off.',
  instant: 'Quick check: fills every low spot with the rain that reaches it and shows where the rest flows. Updates instantly, but has no timing or speed.',
  dynamic: 'Full simulation: water moves over the terrain minute by minute (2D shallow-water model). Adds water speed, danger to people and timing. Takes about a minute.',
  hazard: 'Danger to people wading through water, from depth and speed (UK method: depth × (speed + 0.5)). Above 0.75 some people, above 1.25 most people are at risk.',
  tpeak: 'How long after the rain starts the water is deepest at each spot. Short times mean little warning.',
  target: 'Copenhagen\'s cloudburst goal: no more than 10 cm of water on terrain in a 100-year rain.',
  flowPaths: 'Lines show where surface water runs. Thicker lines carry more water.',
  cellSize: 'The simulation divides the site into square cells. Smaller cells show more detail but take longer (2 m is a good start).',
  massError: 'Rain in should equal water out plus water stored. The difference is the numerical error; under 0.1 % is good.',
  retention: 'How much storage (m³) the site needs if it may only release a fixed amount of water to the sewer (the municipality\'s discharge limit, in litres per second per hectare). Box-rain method, safety factor 1.2.',
  surfaces: 'Each surface decides how much rain soaks in, how much it holds and how fast water runs over it. Swap a material to test a design change, e.g. asphalt to permeable pavers.',
  options: 'Save the current result as an option, change something (rain, surfaces, drainage), save again, and compare the two side by side.',
};

/** A small focusable "?" that shows the explanation on hover or keyboard focus (and to screen readers). */
export function help(key, text = TERMS[key]) {
  return h('span.help', { tabIndex: 0, role: 'note', 'aria-label': text, dataset: { tip: text } }, '?');
}

/**
 * One floating tooltip for every element with data-tip (hover or keyboard focus). It lives at document level, so
 * scrolling panels never clip it, and it is kept inside the window.
 */
export function installTips() {
  const tip = h('div.tip-layer', { role: 'tooltip', 'aria-hidden': 'true' });
  document.body.append(tip);
  let cur = null;
  const show = (el) => {
    cur = el; tip.textContent = el.dataset.tip; tip.classList.add('show');
    const r = el.getBoundingClientRect(); const tw = tip.offsetWidth, th = tip.offsetHeight;
    const x = Math.max(8, Math.min(window.innerWidth - tw - 8, r.left + r.width / 2 - tw / 2));
    const below = r.bottom + 8 + th < window.innerHeight;
    tip.style.transform = `translate(${Math.round(x)}px, ${Math.round(below ? r.bottom + 8 : r.top - th - 8)}px)`;
  };
  const hide = () => { cur = null; tip.classList.remove('show'); };
  const find = (e) => (e.target instanceof Element ? e.target.closest('[data-tip]') : null);
  document.addEventListener('mouseover', (e) => { const el = find(e); if (el && el.dataset.tip) { if (el !== cur) show(el); } else if (cur) hide(); });
  document.addEventListener('focusin', (e) => { const el = find(e); if (el && el.dataset.tip) show(el); else hide(); });
  document.addEventListener('focusout', hide);
  document.addEventListener('scroll', hide, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hide(); });
}

/** A label followed by its help mark. */
export function term(label, key) {
  return h('span.term', label, help(key));
}
