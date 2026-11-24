// Registers the map-source entries with the app through js/hooks.js (no markup in index.html / app.js).
// The built-in "Find a place in Denmark" (DHM) and "Upload a terrain file" cards are registered by app.js; both are
// backed by js/sources/ (the picker in js/dhm.js uses registry.fetchTerrain, uploads go through prepareSiteDesc).
import { addSiteSource } from '../hooks.js';
import { openDhmPicker } from '../dhm.js';

addSiteSource({
  id: 'world-terrain', order: 15, icon: 'pin', title: 'Find a place outside Denmark', tag: 'No key · 25–30 m: overview only',
  description: 'Global open elevation (AWS Terrain Tiles, Copernicus DEM) plus OpenStreetMap buildings. Too coarse for site-scale screening: for real projects upload a national LiDAR terrain file instead.',
  open: (ctx) => openDhmPicker(ctx.openTerrain, { sourceId: 'terrain-tiles', lat: 59.9139, lon: 10.7522 }),
});
