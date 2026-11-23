# Cloudburst web app


## Start it (Windows)

Double-click **`Cloudburst Web.bat`** in the repo root. It starts `serve.py` and opens the browser.
`Cloudburst Web (app window).bat` opens it in a chromeless Edge/Chrome app window instead.
Close the console window to stop the server.

## Install as an app (Edge / Chrome)

The app is a PWA (manifest + service worker), and `http://localhost` counts as a secure origin, so with the server
running: Edge → `…` menu → **Apps → Install this site as an app** (Chrome: install icon in the address bar).
You then get a Start-menu entry, a taskbar icon and its own window. The app shell and the engine are cached, so the
synthetic samples also work offline. The server must still run for DHM downloads, and the port must stay the same
(the installed app is tied to `localhost:8123`).
Tauri or Electron would only be needed for a single installer `.exe` that doesn't need Python.

## Pick a location (DHM terrain from an API key)

Run the app with `python serve.py` (not `python -m http.server`). It serves the files and relays DHM requests to
Datafordeler/Dataforsyningen, so the browser's CORS rules don't block the download.

On the start page, click **Pick a location**:
1. Search an address (OpenStreetMap search) or click the map to place the square, then pick its size.
2. Paste a **Datafordeler API key** or a **Dataforsyningen token**. If you tick "Remember", it is kept only in your browser.
3. Click **Fetch terrain & open**. DHM/Terræn is downloaded as a GeoTIFF and opened as a new site.

Real-site cards (Tåsinge Plads, …) also have a **Fetch terrain with API key** button. The key is never written to
disk by the server and is not logged.
