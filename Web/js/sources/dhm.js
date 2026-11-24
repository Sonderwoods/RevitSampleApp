// Danmarks Højdemodel (DHM) over WCS 1.0.0 – Datafordeler API key or Dataforsyningen token.
//
// Fixes over the first version (see docs/map-sources.md, "Review findings"):
//  * the bbox is snapped to the DHM pixel lattice (multiples of 8 m covers 0.4 / 0.8 / 1.6 m), so the server returns
//    native pixels instead of resampling them half a pixel off, and the pixel size is exactly the one requested;
//  * large areas are fetched as tiles of at most 2000 × 2000 px and mosaicked without seams (WCS servers cap sizes);
//  * the coverage (product) can be chosen, and listCoverages() reads GetCapabilities so a hydrologically adapted
//    product can be picked if the service offers one (none is assumed: names are not documented in this repo).

export const DHM_PROVIDERS = {
  datafordeler: { label: 'Datafordeler API key', url: 'https://wcs.datafordeler.dk/DHMNedboer/dhm_wcs/1.0.0/WCS', param: 'apikey', help: 'Get a free API key at <a href="https://portal.datafordeler.dk/hjem" target="_blank" rel="noopener">portal.datafordeler.dk</a> (log in with MitID/NemID or e-mail)' },
  dataforsyningen: { label: 'Dataforsyningen token', url: 'https://api.dataforsyningen.dk/dhm_wcs_DAF', param: 'token', help: 'dataforsyningen.dk → Log ind → Mine tokens' },
};

export const DHM_COVERAGES = [
  { id: 'dhm_terraen', label: 'DHM/Terræn – terrain (buildings removed, bridge decks kept)', model: 'DTM' },
  { id: 'dhm_overflade', label: 'DHM/Overflade – surface incl. buildings and trees (not for flow)', model: 'DSM' },
];

/** Max pixels per side of one WCS request. */
export const DHM_MAX_TILE_PX = 2000;
export const DHM_SNAP_M = 8;

/** Snap an EPSG:25832 bbox outward to the DHM lattice. */
export function snapDhmBbox(bbox, snap = DHM_SNAP_M) {
  return [Math.floor(bbox[0] / snap) * snap, Math.floor(bbox[1] / snap) * snap, Math.ceil(bbox[2] / snap) * snap, Math.ceil(bbox[3] / snap) * snap];
}

/** Split a snapped bbox into request tiles (each ≤ maxPx pixels per side, edges on the pixel lattice). */
export function dhmTiles(bbox, res, maxPx = DHM_MAX_TILE_PX) {
  const span = Math.floor(maxPx * res / DHM_SNAP_M) * DHM_SNAP_M; // tile edges stay on the snap lattice
  const tiles = [];
  for (let y = bbox[1]; y < bbox[3] - 1e-6; y += span) for (let x = bbox[0]; x < bbox[2] - 1e-6; x += span) {
    const x1 = Math.min(bbox[2], x + span), y1 = Math.min(bbox[3], y + span);
    tiles.push({ bbox: [x, y, x1, y1], width: Math.round((x1 - x) / res), height: Math.round((y1 - y) / res) });
  }
  return tiles;
}

export const isTiff = (b) => b.length > 4 && ((b[0] === 0x49 && b[1] === 0x49) || (b[0] === 0x4d && b[1] === 0x4d));

let proxyP = null;
/** True when the page is served by Web/serve.py (which relays requests and avoids CORS problems). */
export function hasProxy() {
  if (typeof window === 'undefined') return Promise.resolve(false);
  if (window.__TAURI__) return Promise.resolve(false);
  if (!proxyP) proxyP = fetch('proxy/ping', { cache: 'no-store' }).then((r) => r.ok).catch(() => false);
  return proxyP;
}

function cleanError(text, status) {
  let msg = text;
  try { const j = JSON.parse(text.replace(/^HTTP \d+: /, '')); msg = j.detail || j.title || j.message || text; } catch { /* xml / text */ }
  msg = msg.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  if (status === 401 || status === 403) return `Key rejected (${status}). Check that it is a ${status === 403 ? 'valid key with access to DHM' : 'current key'}. ${msg}`.trim();
  if (/InvalidParameterValue|coverage/i.test(msg) && /not|unknown|invalid/i.test(msg)) return `The service does not offer this product: ${msg}`;
  return msg || `HTTP ${status}`;
}

/** One WCS GetCoverage request → GeoTIFF bytes. */
export async function dhmRequest(q, provider, { fetchFn } = {}) {
  const p = DHM_PROVIDERS[provider] || DHM_PROVIDERS.datafordeler;
  const pid = provider in DHM_PROVIDERS ? provider : 'datafordeler';
  const tauri = typeof window !== 'undefined' && window.__TAURI__ && window.__TAURI__.core;
  if (tauri && !fetchFn) {
    try {
      const buf = new Uint8Array(await tauri.invoke('fetch_dhm', { provider: pid, query: q.toString() }));
      if (!isTiff(buf)) throw new Error(new TextDecoder().decode(buf.slice(0, 400)));
      return buf;
    } catch (e) {
      const m = String(e && e.message ? e.message : e); const st = /^HTTP (\d+)/.exec(m);
      throw new Error(cleanError(m, st ? +st[1] : 0));
    }
  }
  const f = fetchFn || fetch;
  const viaProxy = !fetchFn && await hasProxy();
  const url = viaProxy ? `proxy/${pid}?${q}` : `${p.url}?${q}`;
  let r;
  try { r = await f(url); } catch {
    throw new Error(`The browser blocked the request to ${new URL(p.url).host} (CORS or offline). Use the Cloudburst desktop app, or run the web app locally with "Cloudburst Web.bat" / "python serve.py" – both download DHM without this restriction.`);
  }
  const buf = new Uint8Array(await r.arrayBuffer());
  if (!r.ok || !isTiff(buf)) throw new Error(cleanError(new TextDecoder().decode(buf.slice(0, 600)), r.status));
  return buf;
}

/**
 * Download DHM for an EPSG:25832 bbox. Returns an array of {bbox, bytes} GeoTIFF tiles (mosaic with gridops.mosaic
 * after decoding). onProgress(done, total).
 */
export async function fetchDhmTiles(bbox, { provider, key, res = 0.4, coverage = 'dhm_terraen', onProgress, fetchFn } = {}) {
  if (!key || !key.trim()) throw new Error('An API key or token is required for DHM.');
  const sb = snapDhmBbox(bbox);
  const tiles = dhmTiles(sb, res);
  if (tiles.length > 16) throw new Error(`Area too large (${tiles.length} WCS tiles). Pick a smaller area or a coarser resolution.`);
  const out = [];
  for (const [n, t] of tiles.entries()) {
    const q = new URLSearchParams({ service: 'WCS', request: 'GetCoverage', version: '1.0.0', coverage, crs: 'EPSG:25832', bbox: t.bbox.join(','), width: t.width, height: t.height, format: 'GTiff' });
    q.set((DHM_PROVIDERS[provider] || DHM_PROVIDERS.datafordeler).param, key.trim());
    out.push({ bbox: t.bbox, bytes: await dhmRequest(q, provider, { fetchFn }) });
    if (onProgress) onProgress(n + 1, tiles.length);
  }
  return out;
}

/** GetCapabilities → coverage names offered for this key (to find e.g. a hydrologically adapted product). */
export async function listDhmCoverages({ provider, key, fetchFn } = {}) {
  const p = DHM_PROVIDERS[provider] || DHM_PROVIDERS.datafordeler;
  const q = new URLSearchParams({ service: 'WCS', request: 'GetCapabilities', version: '1.0.0' });
  q.set(p.param, key.trim());
  const f = fetchFn || fetch;
  const viaProxy = !fetchFn && await hasProxy();
  const pid = provider in DHM_PROVIDERS ? provider : 'datafordeler';
  const r = await f(viaProxy ? `proxy/${pid}?${q}` : `${p.url}?${q}`);
  const text = await r.text();
  if (!r.ok) throw new Error(cleanError(text, r.status));
  return parseWcsCapabilities(text);
}

/** Parse WCS 1.0.0 capabilities: [{name, label, hydro}] (hydro = name/label suggests a hydrologically adapted model). */
export function parseWcsCapabilities(xml) {
  const out = [];
  for (const block of xml.split(/<(?:wcs:)?CoverageOfferingBrief[ >]/).slice(1)) {
    const name = /<(?:wcs:)?name>([^<]+)</.exec(block), label = /<(?:wcs:)?label>([^<]+)</.exec(block);
    if (!name) continue;
    const s = `${name[1]} ${label ? label[1] : ''}`;
    out.push({ name: name[1].trim(), label: label ? label[1].trim() : name[1].trim(), hydro: /hydro|tilpas|nedb|bluespot/i.test(s) });
  }
  return out;
}
