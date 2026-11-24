// Buildings, surface materials and bridges from OpenStreetMap (Overpass API), converted to the engine's site
// description ({buildings, surfaces, bridgeCuts}) in the terrain's metric CRS. Keyless; © OpenStreetMap contributors (ODbL).
//
// What it gives the engine:
//  * buildings  – footprints (outer ring; courtyards kept open via a keyhole seam) → blocks that water flows around.
//    Height: `height`, else `building:levels` × 3 m, else 8 m (the engine raises anything lower than +5 m anyway).
//  * surfaces   – palette material per polygon from landuse / natural / leisure / amenity=parking / area:highway,
//    and road / path lines buffered by a typical width. Later entries override earlier ones (same as the engine).
//    `surface=*` refines the material where tagged. Areas OSM does not describe keep the default material.
//  * bridgeCuts – man_made=bridge areas and buffered bridge=yes ways (IN-4). DHM/Terræn keeps bridge decks, which
//    act as false dams across the flow path below.
// Known gaps (OSM, not this code): private gardens / paving inside blocks are rarely mapped, so urban blocks are
// often left at the default material; road widths are typical values, not measured.

export const OVERPASS_ENDPOINTS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
export const OSM_ATTRIBUTION = '© OpenStreetMap contributors (ODbL)';

/** Overpass QL for a lat/lon box. */
export function overpassQuery({ south, west, north, east }, timeout = 60) {
  const b = `(${south.toFixed(6)},${west.toFixed(6)},${north.toFixed(6)},${east.toFixed(6)})`;
  return `[out:json][timeout:${timeout}];
(
  way["building"]${b}; relation["building"]["type"="multipolygon"]${b};
  way["landuse"]${b}; relation["landuse"]["type"="multipolygon"]${b};
  way["natural"]${b}; relation["natural"]["type"="multipolygon"]${b};
  way["leisure"]${b}; relation["leisure"]["type"="multipolygon"]${b};
  way["amenity"="parking"]${b}; way["area:highway"]${b}; way["place"="square"]${b};
  way["highway"]${b}; way["railway"~"^(rail|tram|light_rail)$"]${b};
  way["man_made"="bridge"]${b}; way["water"]${b}; way["waterway"~"^(riverbank|dock)$"]${b};
);
out geom;`;
}

/** Fetch raw Overpass JSON (tries the local relay first when available, then public endpoints). */
export async function fetchOverpass(bboxLL, { fetchFn, endpoints = OVERPASS_ENDPOINTS, useProxy = false } = {}) {
  const f = fetchFn || fetch;
  const body = 'data=' + encodeURIComponent(overpassQuery(bboxLL));
  const urls = useProxy ? ['proxy/overpass', ...endpoints] : endpoints;
  let last = null;
  for (const u of urls) {
    try {
      const r = await f(u, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
      if (r.status === 429 || r.status === 504) { last = new Error(`Overpass busy (HTTP ${r.status})`); continue; }
      if (!r.ok) { last = new Error(`Overpass HTTP ${r.status}`); continue; }
      return await r.json();
    } catch (e) { last = e; }
  }
  throw new Error(`OpenStreetMap data could not be downloaded (${last ? last.message : 'no endpoint'}). The terrain still works without it.`);
}

// ------------------------------------------------------------------------------------------------ tag → material

const SURFACE = {
  asphalt: 'asphalt', concrete: 'concrete', 'concrete:plates': 'concrete', 'concrete:lanes': 'concrete', paved: 'asphalt',
  paving_stones: 'pavers', sett: 'setts', cobblestone: 'setts', unhewn_cobblestone: 'setts', bricks: 'pavers',
  grass_paver: 'grass_pavers', gravel: 'gravel_loose', pebblestone: 'gravel_loose', fine_gravel: 'gravel_compacted', compacted: 'gravel_compacted',
  unpaved: 'gravel_compacted', dirt: 'bare_soil', earth: 'bare_soil', ground: 'bare_soil', mud: 'bare_soil', sand: 'bare_soil',
  grass: 'lawn_compacted', wood: 'decking', rubber: 'rubber', tartan: 'rubber', artificial_turf: 'rubber', metal: 'concrete',
};
const LANDUSE = {
  grass: 'park_lawn', village_green: 'park_lawn', recreation_ground: 'park_lawn', cemetery: 'park_lawn', meadow: 'meadow',
  forest: 'forest', orchard: 'shrubs', vineyard: 'shrubs', allotments: 'shrubs', plant_nursery: 'shrubs', farmland: 'agricultural',
  farmyard: 'gravel_compacted', industrial: 'concrete', commercial: 'concrete', retail: 'concrete', garages: 'asphalt', railway: 'gravel_loose',
  construction: 'bare_soil', brownfield: 'bare_soil', greenfield: 'meadow', landfill: 'bare_soil', basin: 'basin', reservoir: 'water',
  flowerbed: 'shrubs', greenery: 'shrubs',
};
const NATURAL = { water: 'water', wetland: 'wetland', wood: 'forest', scrub: 'shrubs', heath: 'shrubs', grassland: 'meadow', sand: 'bare_soil', beach: 'bare_soil', bare_rock: 'concrete', mud: 'wetland' };
const LEISURE = { park: 'park_lawn', garden: 'park_lawn', golf_course: 'park_lawn', dog_park: 'lawn_compacted', nature_reserve: null, pitch: 'lawn_compacted', playground: 'lawn_compacted', track: 'rubber', sports_centre: null, stadium: null, swimming_pool: 'water' };
// typical carriageway / path widths (m) and default material
const HIGHWAY = {
  motorway: [14, 'asphalt'], trunk: [12, 'asphalt'], primary: [10, 'asphalt'], secondary: [8, 'asphalt'], tertiary: [7, 'asphalt'],
  motorway_link: [6, 'asphalt'], trunk_link: [6, 'asphalt'], primary_link: [6, 'asphalt'], secondary_link: [6, 'asphalt'], tertiary_link: [6, 'asphalt'],
  unclassified: [6, 'asphalt'], residential: [6, 'asphalt'], living_street: [5, 'pavers'], service: [4, 'asphalt'], pedestrian: [4, 'pavers'],
  busway: [7, 'asphalt'], road: [6, 'asphalt'], track: [3, 'gravel_compacted'], footway: [2, 'pavers'], cycleway: [2, 'asphalt'],
  path: [1.5, 'gravel_compacted'], bridleway: [2, 'gravel_compacted'], steps: [2, 'concrete'], corridor: [0, null], proposed: [0, null], construction: [0, null],
};

/** Material id for a closed area's tags, with a priority (higher = drawn later = wins). null = ignore. */
export function areaMaterial(t) {
  const surf = t.surface && SURFACE[t.surface];
  if (t['area:highway'] || t.place === 'square' || (t.highway && (t.area === 'yes' || t.highway === 'pedestrian') && t.area !== 'no')) return { material: surf || (t.highway === 'pedestrian' || t.place === 'square' ? 'pavers' : 'asphalt'), priority: 5 };
  if (t.amenity === 'parking') return { material: surf || 'asphalt', priority: 4 };
  if (t.natural === 'water' || t.water || t.waterway === 'riverbank' || t.waterway === 'dock' || t.landuse === 'reservoir') return { material: 'water', priority: 6 };
  if (t.leisure && t.leisure in LEISURE) {
    const m = surf || LEISURE[t.leisure]; return m ? { material: m, priority: t.leisure === 'pitch' || t.leisure === 'playground' || t.leisure === 'track' ? 3 : 2 } : null;
  }
  if (t.natural && NATURAL[t.natural]) return { material: NATURAL[t.natural], priority: 2 };
  if (t.landuse && LANDUSE[t.landuse]) return { material: surf || LANDUSE[t.landuse], priority: 1 };
  return null;
}

// ------------------------------------------------------------------------------------------------ geometry helpers

function ringArea(xs, ys) { let a = 0; for (let i = 0, j = xs.length - 1; i < xs.length; j = i++) a += (xs[j] + xs[i]) * (ys[j] - ys[i]); return a / 2; }

/** Sutherland–Hodgman clip of a ring to an axis-aligned rectangle [x0, y0, x1, y1]. */
export function clipRing(xs, ys, [x0, y0, x1, y1]) {
  let px = xs, py = ys;
  const edges = [[(x) => x >= x0, (ax, ay, bx, by) => [x0, ay + ((by - ay) * (x0 - ax)) / (bx - ax)], 0], [(x) => x <= x1, (ax, ay, bx, by) => [x1, ay + ((by - ay) * (x1 - ax)) / (bx - ax)], 0],
    [(y) => y >= y0, (ax, ay, bx, by) => [ax + ((bx - ax) * (y0 - ay)) / (by - ay), y0], 1], [(y) => y <= y1, (ax, ay, bx, by) => [ax + ((bx - ax) * (y1 - ay)) / (by - ay), y1], 1]];
  for (const [inside, cut, axis] of edges) {
    const ox = [], oy = []; const n = px.length; if (!n) break;
    for (let i = 0; i < n; i++) {
      const ax = px[(i + n - 1) % n], ay = py[(i + n - 1) % n], bx = px[i], by = py[i];
      const ain = inside(axis ? ay : ax), bin = inside(axis ? by : bx);
      if (bin) { if (!ain) { const [cx, cy] = cut(ax, ay, bx, by); ox.push(cx); oy.push(cy); } ox.push(bx); oy.push(by); }
      else if (ain) { const [cx, cy] = cut(ax, ay, bx, by); ox.push(cx); oy.push(cy); }
    }
    px = ox; py = oy;
  }
  return px.length >= 3 && Math.abs(ringArea(px, py)) > 1e-6 ? { xs: px, ys: py } : null;
}

/**
 * Merge an outer ring and inner rings into ONE ring with zero-width seams ("keyhole"), so even-odd rasterisation
 * (which the engine uses for footprints and regions) leaves courtyards and holes open.
 */
export function keyhole(outer, inners) {
  if (!inners.length) return outer;
  let xs = outer.xs.slice(), ys = outer.ys.slice();
  for (const h of inners) {
    // connect the hole's first vertex to the nearest outer vertex
    let best = 0, bd = Infinity;
    for (let k = 0; k < xs.length; k++) { const d = (xs[k] - h.xs[0]) ** 2 + (ys[k] - h.ys[0]) ** 2; if (d < bd) { bd = d; best = k; } }
    const nx = [...xs.slice(0, best + 1), ...h.xs, h.xs[0], xs[best], ...xs.slice(best + 1)];
    const ny = [...ys.slice(0, best + 1), ...h.ys, h.ys[0], ys[best], ...ys.slice(best + 1)];
    xs = nx; ys = ny;
  }
  return { xs, ys };
}

/** Join way segments (arrays of [x,y]) into closed rings. */
function assembleRings(segs) {
  const rings = []; const pool = segs.map((s) => s.slice());
  const same = (a, b) => Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9;
  while (pool.length) {
    let ring = pool.shift();
    let guard = 0;
    while (!same(ring[0], ring[ring.length - 1]) && guard++ < 10000) {
      const end = ring[ring.length - 1];
      const k = pool.findIndex((s) => same(s[0], end) || same(s[s.length - 1], end));
      if (k < 0) break;
      const s = pool.splice(k, 1)[0];
      ring = ring.concat(same(s[0], end) ? s.slice(1) : s.slice(0, -1).reverse());
    }
    if (ring.length >= 4 && same(ring[0], ring[ring.length - 1])) rings.push(ring.slice(0, -1));
  }
  return rings;
}

/** Buffer a polyline into one quad per segment (rectangles; joins overlap). */
function bufferLine(xs, ys, width) {
  const out = []; const hw = width / 2;
  for (let k = 1; k < xs.length; k++) {
    const dx = xs[k] - xs[k - 1], dy = ys[k] - ys[k - 1], L = Math.hypot(dx, dy); if (L < 1e-6) continue;
    const ux = dx / L, uy = dy / L, nx = -uy * hw, ny = ux * hw, ex = ux * hw * 0.5, ey = uy * hw * 0.5; // small overlap at joints
    const ax = xs[k - 1] - ex, ay = ys[k - 1] - ey, bx = xs[k] + ex, by = ys[k] + ey;
    out.push({ xs: [ax + nx, bx + nx, bx - nx, ax - nx], ys: [ay + ny, by + ny, by - ny, ay - ny] });
  }
  return out;
}

const num = (v) => { const m = /^\s*(-?\d+(?:[.,]\d+)?)/.exec(String(v ?? '')); return m ? parseFloat(m[1].replace(',', '.')) : NaN; };

export function buildingHeight(t) {
  const h = num(t.height); if (h > 0) return Math.round(h * 10) / 10;
  const lv = num(t['building:levels']); if (lv > 0) return Math.round((lv * 3 + (num(t['roof:levels']) > 0 ? num(t['roof:levels']) * 2 : 0)) * 10) / 10;
  return 8;
}

/**
 * Convert Overpass JSON to the engine site description. `project(lat, lon) → {E, N}` maps to the terrain CRS,
 * `clip` = [x0, y0, x1, y1] in that CRS (features are clipped to it, with a small margin).
 */
export function osmToSite(json, project, clip) {
  const margin = 2; const box = [clip[0] - margin, clip[1] - margin, clip[2] + margin, clip[3] + margin];
  const P = (g) => { const p = project(g.lat, g.lon); return [p.E, p.N]; };
  const buildings = [], areas = [], lines = [], bridgeCuts = [];
  const stats = { buildings: 0, surfaces: 0, roads: 0, bridges: 0, skippedBuildingParts: 0 };
  const polysOf = (el) => {
    if (el.type === 'way' && el.geometry && el.geometry.length >= 4) {
      const g = el.geometry; const closed = g[0].lat === g[g.length - 1].lat && g[0].lon === g[g.length - 1].lon;
      if (!closed) return [];
      const r = g.slice(0, -1).map(P); return [{ outer: { xs: r.map((p) => p[0]), ys: r.map((p) => p[1]) }, inners: [] }];
    }
    if (el.type === 'relation' && el.members) {
      const outer = assembleRings(el.members.filter((m) => m.type === 'way' && m.geometry && m.role !== 'inner').map((m) => m.geometry.map(P)));
      const inner = assembleRings(el.members.filter((m) => m.type === 'way' && m.geometry && m.role === 'inner').map((m) => m.geometry.map(P)));
      const toRing = (r) => ({ xs: r.map((p) => p[0]), ys: r.map((p) => p[1]) });
      const inside = (pt, ring) => { let c = false; for (let i = 0, j = ring.xs.length - 1; i < ring.xs.length; j = i++) { if ((ring.ys[i] > pt[1]) !== (ring.ys[j] > pt[1]) && pt[0] < ring.xs[i] + ((ring.xs[j] - ring.xs[i]) * (pt[1] - ring.ys[i])) / (ring.ys[j] - ring.ys[i])) c = !c; } return c; };
      return outer.map(toRing).map((o) => ({ outer: o, inners: inner.map(toRing).filter((h) => inside([h.xs[0], h.ys[0]], o)) }));
    }
    return [];
  };
  const clipPoly = ({ outer, inners }) => {
    const o = clipRing(outer.xs, outer.ys, box); if (!o) return null;
    return keyhole(o, inners.map((h) => clipRing(h.xs, h.ys, box)).filter(Boolean));
  };
  for (const el of json.elements || []) {
    const t = el.tags || {};
    if (t.building && t.building !== 'no' && t.building !== 'roof' && !t['building:part']) {
      if (t.location === 'underground' || num(t.layer) < 0) continue;
      for (const p of polysOf(el)) { const r = clipPoly(p); if (r) { buildings.push({ name: t.name || t['addr:street'] && `${t['addr:street']} ${t['addr:housenumber'] || ''}`.trim() || '', xs: r.xs, ys: r.ys, height: buildingHeight(t), osmId: `${el.type}/${el.id}` }); stats.buildings++; } }
      continue;
    }
    if (t.man_made === 'bridge') { for (const p of polysOf(el)) { const r = clipPoly(p); if (r) { bridgeCuts.push({ xs: r.xs, ys: r.ys, osmId: `${el.type}/${el.id}` }); stats.bridges++; } } continue; }
    const am = areaMaterial(t);
    if (am) {
      const polys = polysOf(el);
      if (polys.length) {
        for (const p of polys) { const r = clipPoly(p); if (r) areas.push({ ...am, xs: r.xs, ys: r.ys, area: Math.abs(ringArea(r.xs, r.ys)), osmId: `${el.type}/${el.id}` }); }
        continue;
      }
    }
    if (el.type === 'way' && el.geometry && (t.highway || t.railway)) {
      if (t.tunnel && t.tunnel !== 'no') continue;
      if (t.highway && t.area === 'yes') continue;
      const [w0, defMat] = t.highway ? (HIGHWAY[t.highway] || [0, null]) : [t.railway === 'rail' ? 4 : 3, 'gravel_loose'];
      const width = num(t.width) > 0 ? num(t.width) : w0;
      if (!(width > 0) || !defMat) continue;
      const pts = el.geometry.map(P); const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
      const material = (t.surface && SURFACE[t.surface]) || (t.railway === 'tram' ? 'setts' : defMat);
      const quads = bufferLine(xs, ys, width).map((q) => clipRing(q.xs, q.ys, box)).filter(Boolean);
      if (t.bridge && t.bridge !== 'no') { for (const q of quads) bridgeCuts.push({ ...q, osmId: `way/${el.id}` }); stats.bridges++; continue; }
      for (const q of quads) lines.push({ material, priority: t.highway && ['footway', 'path', 'cycleway', 'steps', 'track', 'bridleway'].includes(t.highway) ? 7 : 8, xs: q.xs, ys: q.ys, area: 0 });
      stats.roads++;
    }
  }
  // big areas first, roads last: later regions override earlier ones in the engine
  areas.sort((a, b) => a.priority - b.priority || b.area - a.area);
  lines.sort((a, b) => a.priority - b.priority);
  const surfaces = [...areas, ...lines].map(({ material, xs, ys }) => ({ material, xs, ys }));
  stats.surfaces = areas.length;
  return { buildings, surfaces, bridgeCuts, stats };
}
