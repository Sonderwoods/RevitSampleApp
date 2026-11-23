# Cloudburst web app


## Pick a location (DHM terrain from an API key)

Run the app with `python serve.py` (not `python -m http.server`). It serves the files and relays DHM requests to
Datafordeler/Dataforsyningen, so the browser's CORS rules don't block the download.

On the start page, click **Pick a location**:
1. Search an address (OpenStreetMap search) or click the map to place the square, then pick its size.
2. Paste a **Datafordeler API key** or a **Dataforsyningen token**. If you tick "Remember", it is kept only in your browser.
3. Click **Fetch terrain & open**. DHM/Terræn is downloaded as a GeoTIFF and opened as a new site.

Real-site cards (Tåsinge Plads, …) also have a **Fetch terrain with API key** button. The key is never written to
disk by the server and is not logged.
