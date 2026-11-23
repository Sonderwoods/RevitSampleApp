# Sample terrain files

Real Danish sample sites need DHM/Terræn terrain, which requires a (free) Dataforsyningen token:

```bash
python3 tools/fetch_dhm.py --token YOUR_TOKEN
```

This writes `dk_taasinge.tif`, `dk_skt_kjeld.tif`, `dk_enghaveparken.tif`, `dk_kongens_nytorv.tif`, `dk_odense.tif`
here (EPSG:25832, 0.4 m). Check the data licence before redistributing them. Synthetic samples need no files.
