// "Export report" for authorities: dialog, adapters from app state to report records, and the generate pipeline
// (records → report-model.js → report-pdf.js). Hooked into app.js with two small, marked lines:
//   1. import { reportOptionMeta } from './js/report.js';   (importing registers the export action via js/hooks.js)
//   2. snapshot() stores `report: reportOptionMeta(S, grid, sampleJson, { settingsKey })` so a saved option
//      remembers the inputs, dynamic run and retention it was saved with.
// The report uses the app's own saved options (step 5) – there is no separate option state here.
// Everything else (UI, CSS) lives in this file and in report-*.js / report.css.
import { translator, LANGS } from './report-i18n.js';
import { addExportAction } from './hooks.js';
// The model and PDF modules are loaded on first use, so a problem in them can never stop the app itself from loading.
const lazy = { model: () => import('./report-model.js'), pdf: () => import('./report-pdf.js') };

const STORE_KEY = 'cloudburst.report.v1';
const RET_SAFETY = 1.2; // app.js computeRetention() uses a fixed safety factor of 1.2

function ensureCss() {
  if (document.getElementById('report-css')) return;
  const l = document.createElement('link'); l.id = 'report-css'; l.rel = 'stylesheet'; l.href = new URL('../report.css', import.meta.url).href;
  document.head.append(l);
}

// ------------------------------------------------------------------------------------------------ state → records
function siteInfoOf(S) {
  const i = S.site.info || {};
  return { id: S.site.id, name: S.site.name, kind: S.site.kind, description: i.description || '', bbox: i.bbox || null, dhmFile: i.dhmFile || null };
}
let appSettingsKey = null; // app.js settingsKey(), handed over by the snapshot hook
/** Same inputs as app.js settingsKey(); only used until the snapshot hook has handed over the real one. */
const fallbackKey = (S) => JSON.stringify({ ...S.settings, cell: S.dynCell, dur: S.dynDuration, swap: S.surfaceSwap, ground: S.groundMaterial });
/** The dynamic result, if it was run with the current inputs (a stale run must not be reported against them). */
function freshDyn(S, hooks) {
  if (!S.dyn) return null;
  const key = (hooks && hooks.settingsKey) || appSettingsKey || (() => fallbackKey(S));
  try { return S.dyn.key !== key() ? null : S.dyn; } catch { return S.dyn; }
}
/** Settings plus the surface design changes (step 3), copied so later edits do not change a saved option. */
function settingsOf(S) {
  return { ...S.settings, surfaceSwap: { ...(S.surfaceSwap || {}) }, groundMaterial: S.groundMaterial || null };
}
function retentionNow(S) {
  if (!S.retention || !S.retention.result) return null;
  return { input: { dischargeLSHa: S.retention.dischargeLSHa, returnPeriod: S.retention.returnPeriod, climateFactor: S.settings.climateFactor, safetyFactor: RET_SAFETY }, result: { ...S.retention.result } };
}

/**
 * Called from app.js snapshot(): what a saved option needs to be reported later (inputs at save time, the dynamic run
 * and retention if they belong to this grid). Cheap: arrays are referenced, not copied.
 */
export function reportOptionMeta(S, grid, sampleJson, hooks) {
  if (hooks && hooks.settingsKey) appSettingsKey = hooks.settingsKey;
  const current = grid === S.grid;
  const otherInfo = sampleJson && sampleJson.info;
  return {
    createdAt: new Date().toISOString(),
    settings: current ? settingsOf(S) : { ...S.settings, surfaceSwap: {}, groundMaterial: null },
    site: current || !otherInfo ? siteInfoOf(S) : { id: otherInfo.id, name: otherInfo.name, kind: otherInfo.kind, description: otherInfo.description || '', bbox: otherInfo.bbox || null, dhmFile: otherInfo.dhmFile || null },
    siteDesc: current ? S.siteDesc : otherInfo ? { sample: otherInfo.id } : null,
    dyn: current ? freshDyn(S, hooks) : null,
    retention: current ? retentionNow(S) : null,
  };
}

function recordFromCurrent(S, hooks) {
  if (!S.grid || !S.instant) throw new Error('No result yet: open a site and let the instant model run first.');
  return {
    id: 'current', name: S.site.name, createdAt: new Date().toISOString(), site: siteInfoOf(S), settings: settingsOf(S),
    preset: S.info.presets.find((p) => p.id === S.settings.presetId) || null,
    grid: S.grid, instant: S.instant, base: S.scene && S.scene.base, buildingsVec: S.sampleJson ? S.sampleJson.buildings : null,
    dyn: freshDyn(S, hooks), retention: retentionNow(S), siteDesc: S.siteDesc, palette: S.info.palette,
  };
}

function recordFromOption(S, o) {
  const m = o.report || {};
  const settings = m.settings || null;
  return {
    id: o.id, name: o.name, createdAt: m.createdAt || null, site: m.site || siteInfoOf(S), settings,
    preset: settings ? S.info.presets.find((p) => p.id === settings.presetId) || null : null,
    grid: o.grid, instant: { stats: o.stats, depth: o.depth, bluespots: o.bluespots, paths: o.paths }, base: o.base, buildingsVec: o.buildingsVec, buildingsRaster: o.buildingsRaster,
    dyn: m.dyn || null, retention: m.retention || null, siteDesc: m.siteDesc || null, palette: S.info.palette, legacyCaption: o.caption,
  };
}

/** Options saved before report.js existed (or from a pair run) may lack retention: compute it with the engine. */
async function ensureRetention(S, rec, input) {
  if (rec.retention || !input || !S.cb) return;
  let g = null;
  try {
    if (rec.grid === S.grid) g = S.grid;
    else if (rec.siteDesc) g = await S.cb.buildGrid(rec.siteDesc, { cellSize: rec.grid.dx });
    if (!g) return;
    const r = await S.cb.retention(g, { returnPeriod: input.returnPeriod, climateFactor: input.climateFactor, dischargeLSHa: input.dischargeLSHa, safetyFactor: input.safetyFactor });
    rec.retention = { input: { ...input }, result: r };
  } catch (e) { console.warn('report: retention for option failed', e); }
  finally { if (g && g !== S.grid) S.cb.freeGrid(g).catch(() => {}); }
}

/**
 * Build records for a report. sources: ['current'] or option ids (first = baseline A).
 */
export async function buildRecords(S, sources, hooks) {
  const recs = sources.map((src) => {
    if (src === 'current') return recordFromCurrent(S, hooks);
    const o = S.options.find((x) => x.id === src); if (!o) throw new Error('Saved option not found');
    return recordFromOption(S, o);
  });
  const retInput = recs.find((r) => r.retention)?.retention.input || (S.retention ? { dischargeLSHa: S.retention.dischargeLSHa, returnPeriod: S.retention.returnPeriod, climateFactor: S.settings.climateFactor, safetyFactor: RET_SAFETY } : null);
  for (const r of recs) await ensureRetention(S, r, retInput);
  recs.forEach((r, i) => { r.letter = String.fromCharCode(65 + i); });
  return recs;
}

/** Records → model → PDF. Returns { model, blob, pages }. */
export async function generateReport(S, { kind, sources, project, lang }, hooks) {
  const records = await buildRecords(S, sources, hooks);
  const [{ buildReportModel }, { renderPdf }] = await Promise.all([lazy.model(), lazy.pdf()]);
  const { model, internals } = buildReportModel({ kind, records, project, lang, tool: { engineVersion: S.info.version } });
  const pdf = await renderPdf({ model, internals, records, palette: S.info.palette });
  return { model, ...pdf };
}

function fileBase(model) {
  const slug = (model.project.name || model.site.name || 'site').toLowerCase().normalize('NFKD').replace(/[^\w]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  return `cloudburst-${model.kind === 'comparison' ? 'comparison' : 'report'}-${slug}-${(model.project.date || model.generatedAt).slice(0, 10)}${model.project.revision ? `-rev${model.project.revision}` : ''}`;
}
function save(name, blob) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
  document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

// ------------------------------------------------------------------------------------------------ dialog
function load() { try { return JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch { return {}; } }
function store(v) { try { localStorage.setItem(STORE_KEY, JSON.stringify(v)); } catch { /* private mode */ } }
function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) { if (v == null || v === false) continue; if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else if (k === 'text') e.textContent = v; else e.setAttribute(k, v === true ? '' : v); }
  kids.flat().forEach((c) => c != null && e.append(c instanceof Node ? c : document.createTextNode(String(c))));
  return e;
}

/** Open the export dialog. hooks: { settingsKey(), saveOption() } from app.js. */
export function openReportDialog(S, hooks = {}) {
  ensureCss();
  lazy.pdf().then((m) => m.loadJsPdf()).catch(() => {}); // warm the modules and the PDF library while the user types
  document.getElementById('reportDlg')?.remove();
  const saved = load();
  const st = {
    lang: saved.lang || ((navigator.language || '').startsWith('da') ? 'da' : 'en'),
    kind: S.compare || (S.options && S.options.length >= 2 && saved.kind === 'comparison') ? 'comparison' : 'single',
    project: { name: '', address: '', matrikel: '', client: '', author: '', company: '', date: new Date().toISOString().slice(0, 10), revision: '', notes: '', ...(saved.project || {}) },
    single: 'current', picked: [],
  };
  if (!saved.project || !saved.project.date) st.project.date = new Date().toISOString().slice(0, 10);
  const opts = () => S.options || [];
  st.picked = S.compare ? [S.compare.a.id, S.compare.b.id] : opts().slice(-2).map((o) => o.id);

  const overlay = el('div', { class: 'rpt-overlay', id: 'reportDlg', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'rptTitle' });
  const card = el('div', { class: 'rpt-card' });
  overlay.append(card);
  const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

  function render() {
    const t = translator(st.lang);
    card.innerHTML = '';
    card.append(el('div', { class: 'rpt-head' }, el('h2', { id: 'rptTitle', text: t('dlgTitle') }), el('button', { class: 'rpt-x', 'aria-label': t('dlgCancel'), onclick: close, text: '×' })));
    const body = el('div', { class: 'rpt-body' });
    // type + language
    const typeSeg = el('div', { class: 'rpt-seg' }, ...[['single', t('dlgSingle')], ['comparison', t('dlgCompare')]].map(([v, l]) =>
      el('button', { class: st.kind === v ? 'on' : '', 'data-kind': v, onclick: () => { st.kind = v; render(); }, text: l })));
    const langSeg = el('div', { class: 'rpt-seg' }, ...LANGS.map((L) => el('button', { class: st.lang === L.id ? 'on' : '', 'data-lang': L.id, onclick: () => { st.lang = L.id; render(); }, text: L.label })));
    body.append(el('div', { class: 'rpt-row2' }, el('label', { class: 'rpt-lab' }, t('dlgType'), typeSeg), el('label', { class: 'rpt-lab' }, t('dlgLanguage'), langSeg)));
    // source
    if (st.kind === 'single') {
      const sel = el('select', { class: 'rpt-in', id: 'rptSource', onchange: (e) => { st.single = e.target.value; } },
        el('option', { value: 'current', text: `${t('dlgCurrent')}${S.dyn && freshDyn(S, hooks) ? ' (instant + dynamic)' : ''}` }),
        ...opts().map((o, i) => el('option', { value: o.id, text: `${String.fromCharCode(65 + i)} · ${o.name}` })));
      sel.value = st.single; body.append(el('label', { class: 'rpt-lab' }, t('dlgSource'), sel));
    } else {
      const list = el('div', { class: 'rpt-opts', id: 'rptOpts' });
      if (opts().length < 2) list.append(el('p', { class: 'rpt-note warn', text: t('dlgNoOptions') }));
      opts().forEach((o, i) => {
        const idx = st.picked.indexOf(o.id);
        const cb = el('input', { type: 'checkbox', 'data-id': o.id, checked: idx >= 0, onchange: (e) => { if (e.target.checked) st.picked.push(o.id); else st.picked = st.picked.filter((x) => x !== o.id); render(); } });
        list.append(el('label', { class: 'rpt-opt' }, cb, el('span', { class: 'rpt-letter', text: idx >= 0 ? String.fromCharCode(65 + idx) : '·' }), el('span', { class: 'rpt-optname', text: `${o.name}` }),
          el('span', { class: 'rpt-optmeta', text: `${o.report && o.report.dyn ? 'instant + dynamic' : 'instant'} · #${String.fromCharCode(65 + i)}` })));
      });
      if (hooks.saveOption && S.instant) list.append(el('button', { class: 'rpt-btn ghost small', onclick: () => { hooks.saveOption(); st.picked.push(opts()[opts().length - 1].id); render(); }, text: `+ ${t('dlgSaveCurrent')}` }));
      body.append(el('label', { class: 'rpt-lab' }, t('dlgOptions'), list));
    }
    // project fields
    const P = st.project; const fld = (k, label, attrs = {}) => el('label', { class: 'rpt-lab' }, label, el('input', { class: 'rpt-in', 'data-field': k, value: P[k] || '', oninput: (e) => { P[k] = e.target.value; }, ...attrs }));
    body.append(el('h3', { class: 'rpt-sub', text: t('dlgProject') }),
      el('div', { class: 'rpt-grid' }, fld('name', t('project')), fld('address', t('address')), fld('matrikel', t('matrikel')), fld('client', t('client')),
        fld('author', t('author')), fld('company', t('company')), fld('date', t('date'), { type: 'date' }), fld('revision', t('revision'))),
      el('label', { class: 'rpt-lab' }, t('notes'), el('textarea', { class: 'rpt-in', 'data-field': 'notes', rows: 3, placeholder: t('dlgNotesPh'), oninput: (e) => { P.notes = e.target.value; } }, P.notes || '')),
      el('p', { class: 'rpt-note', text: t('dlgDisclaimer') }));
    card.append(body);
    const status = el('span', { class: 'rpt-status', id: 'rptStatus' });
    const canGo = st.kind === 'single' ? !!(S.instant || opts().length) : st.picked.length >= 2;
    const go = async (asJson) => {
      store({ lang: st.lang, kind: st.kind, project: st.project });
      const sources = st.kind === 'single' ? [st.single] : st.picked.slice();
      status.textContent = t('dlgWorking'); card.classList.add('busy');
      try {
        if (asJson) {
          const recs = await buildRecords(S, sources, hooks);
          const { buildReportModel, modelToJson } = await lazy.model();
          const { model } = buildReportModel({ kind: st.kind, records: recs, project: st.project, lang: st.lang, tool: { engineVersion: S.info.version } });
          save(`${fileBase(model)}.json`, new Blob([modelToJson(model)], { type: 'application/json' }));
        } else {
          const r = await generateReport(S, { kind: st.kind, sources, project: st.project, lang: st.lang }, hooks);
          window.__cbReportLast = r;
          save(`${fileBase(r.model)}.pdf`, r.blob);
        }
        status.textContent = t('dlgDone');
      } catch (e) { console.error(e); status.textContent = `${e.message}`; status.classList.add('err'); }
      finally { card.classList.remove('busy'); }
    };
    card.append(el('div', { class: 'rpt-foot' }, status,
      el('button', { class: 'rpt-btn ghost', onclick: close, text: t('dlgCancel') }),
      el('button', { class: 'rpt-btn ghost', id: 'rptJson', disabled: !canGo, onclick: () => go(true), text: t('dlgJson') }),
      el('button', { class: 'rpt-btn primary', id: 'rptGo', disabled: !canGo, onclick: () => go(false), text: t('dlgDownload') })));
  }
  render();
  document.body.append(overlay);
  return { close };
}

// ------------------------------------------------------------------------------------------------ registration
addExportAction({
  id: 'report', primary: true, order: 5, icon: 'file',
  label: 'Screening report (PDF)',
  description: 'For the municipality or utility: inputs, maps, water balance, method and limitations. One result, or option A vs B.',
  enabled: (ctx) => (ctx.grid && ctx.instant ? true : 'Load a site first'),
  run: (ctx) => openReportDialog(ctx.state, {}),
});

// test / automation hook (used by the Playwright verification, see docs/reports.md)
window.__cbReport = { generateReport, buildRecords, openReportDialog, buildReportModel: async (...a) => (await lazy.model()).buildReportModel(...a) };
