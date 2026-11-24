// Extension points of the web UI. Other modules add entries here instead of editing app.js.
//
//   import { addSiteSource, addExportAction } from './js/hooks.js';
//
// Site sources appear on the start page under "Your own site" (DOM: #siteSources .source-cards) and in the
// workspace's "Site" step under "Change site". Export actions appear in the workspace's "Export" step
// (DOM: #step-export .export-actions), primary actions first.
//
// Site source:   { id, title, description, icon?, tag?, order?, open(ctx) }
//                open(ctx) gets the context below; it should end with ctx.openTerrain({ bytes, info }).
// Export action: { id, label, description?, icon?, primary?, order?, enabled?(ctx) -> true | 'reason why not',
//                  run(ctx) }
// ctx (built in app.js): { state, site, grid, instant, dynamic, compare, options, settings, captionText(),
//                         legend(), map, engine, openTerrain({bytes, info}), toast(msg, kind) }

const sources = [];
const exports = [];
export const hooks = new EventTarget();

function upsert(list, item) {
  if (!item || !item.id) throw new Error('hook entries need an id');
  const i = list.findIndex((x) => x.id === item.id);
  if (i >= 0) list[i] = item; else list.push(item);
  list.sort((a, b) => (a.order ?? 50) - (b.order ?? 50));
  hooks.dispatchEvent(new Event('change'));
}

export function addSiteSource(source) { upsert(sources, source); }
export function addExportAction(action) { upsert(exports, action); }
export function siteSources() { return sources.slice(); }
export function exportActions() { return exports.slice().sort((a, b) => (b.primary ? 1 : 0) - (a.primary ? 1 : 0)); }
