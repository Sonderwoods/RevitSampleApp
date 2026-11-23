# Sample terrain files

Real Danish sample sites need DHM/Terræn terrain, which requires a free Datafordeler API key from
https://portal.datafordeler.dk/hjem (MitID/NemID or e-mail login), see ../docs/DHM_API_KEY.md:

```bash
python3 tools/fetch_dhm.py --apikey YOUR_API_KEY
```

This writes `dk_taasinge.tif`, `dk_skt_kjeld.tif`, `dk_enghaveparken.tif`, `dk_kongens_nytorv.tif`, `dk_odense.tif`
here (EPSG:25832, 0.4 m). Check the data licence before redistributing them. Synthetic samples need no files.
