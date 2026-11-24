# Sample terrain files

Real Danish sample sites need DHM/Terræn terrain, which requires a free Datafordeler API key from
https://portal.datafordeler.dk/hjem (MitID/NemID or e-mail login), see ../docs/DHM_API_KEY.md:

```bash
python3 tools/fetch_dhm.py --apikey YOUR_API_KEY
```

This writes `dk_taasinge.tif`, `dk_skt_kjeld.tif`, `dk_enghaveparken.tif`, `dk_kongens_nytorv.tif`, `dk_odense.tif`
here (EPSG:25832, 0.4 m). Check the data licence before redistributing them. Synthetic samples need no files.

## Test fixtures

`fixtures/` holds tiny synthetic terrain files (37 × 23 px, z = 10 + 0.1·col − 0.05·row, one no-data pixel) in many
GeoTIFF variants plus `.asc` and `.xyz`, written by `python3 tools/make_terrain_fixtures.py`. They are used by
`Web/tests/sources.test.mjs` and the Rust `raster` tests. They contain no real data.

`fetch_dhm.py` snaps the bbox to the DHM 0.4 m lattice, fetches large areas in tiles and writes one mosaicked file
(`--list` shows the products for a key, `--hydro` prefers a hydrologically adapted one if offered).
