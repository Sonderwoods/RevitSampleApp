# Getting a DHM API key (real Danish terrain)

The synthetic sample sites need no key. To load **real terrain** (Danmarks Højdemodel, DHM/Terræn 0.4 m) for any
location in Denmark, each user needs a free **Datafordeler API key**:

1. Go to **https://portal.datafordeler.dk/hjem**
2. Log in with **MitID/NemID** or with an **e-mail login** (create a user if you don't have one).
3. Create an **API key** in the self-service portal and copy it.

Then use it:

| Where | How |
| --- | --- |
| Web app / desktop app | Start page → **Find a place in Denmark** → search an address or click the map → paste the key → *Download terrain & open*. The key stays on your machine (optionally remembered by the browser). |
| Real sample sites (Tåsinge Plads, …) | Open the site → **Download terrain…** (or drop a terrain file). |
| Command line | `python tools/fetch_dhm.py --apikey <KEY>` (or set `DATAFORDELER_API_KEY`) → GeoTIFFs in `samples/`, which load in Rhino/Revit (*Import DHM terrain*) or by drag-and-drop in the web app. |

An older **Dataforsyningen token** (dataforsyningen.dk → *Mine tokens*) also works; choose it in the credentials list.

Notes:
* DHM/Terræn has buildings removed and **bridge decks included**: add bridge cut-outs where roads pass under bridges.
* The browser version on GitHub Pages calls Datafordeler directly. If your browser blocks the request (CORS), use the
  desktop app or run the web app locally (`Cloudburst Web.bat`), which download without that restriction.
* Check the data licence before redistributing downloaded terrain files.
