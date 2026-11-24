# Getting a DHM API key (real Danish terrain)

## Built-in key (GitHub secret `DHM_API_KEY`)

Builds made by GitHub Actions include a shared key, so users don't need their own:

| Build | Where the key goes |
| --- | --- |
| Web app on GitHub Pages (`pages.yml`) | `tools/inject_dhm_key.py` writes it into `Web/js/config.js` before upload |
| Desktop app (`build.yml`, `release.yml`) | same, before the Tauri build |
| Rhino / Grasshopper / Revit / standalone (`build.yml`, `release.yml`) | `Cloudburst.Net.csproj` compiles `$(DHM_API_KEY)` into `DhmBuildKey.g.cs` (in `obj/`, never committed) |

Set it under *Settings → Secrets and variables → Actions → New repository secret*, name `DHM_API_KEY`. Builds without
the secret (forks, local builds) still work, and users then paste their own key. Local builds: `dotnet build -p:DhmApiKey=<key>`
(or set the `DHM_API_KEY` environment variable), and `python tools/inject_dhm_key.py --key <key>` for the web app
(don't commit the changed `config.js`).

In Rhino/Revit, real sample sites (Tåsinge Plads, …) without terrain download it on *Load* into
`Documents\Cloudburst\samples`. A `DHM_API_KEY` or `DATAFORDELER_API_KEY` environment variable on the user's machine
overrides the built-in key; in the web app a pasted key does.

**Note:** a key shipped in a public web page or a distributed DLL can be read by anyone who looks for it. Use a key
you are happy to share (Datafordeler keys are free and can be revoked/rotated in the portal), and rotate it if abused.

## Your own key

The synthetic sample sites need no key. To load **real terrain** (Danmarks Højdemodel, DHM/Terræn 0.4 m) for any
location in Denmark, each user needs a free **Datafordeler API key**:

1. Go to **https://portal.datafordeler.dk/hjem**
2. Log in with **MitID/NemID** or with an **e-mail login** (create a user if you don't have one).
3. Create an **API key** in the self-service portal and copy it.

Then use it:

| Where | How |
| --- | --- |
| Web app / desktop app | Start page → **Pick a location** → search an address or click the map → paste the key → *Fetch terrain & open*. The key stays on your machine (optionally remembered by the browser). |
| Real sample sites (Tåsinge Plads, …) | Open the site → **Fetch terrain with API key**. |
| Command line | `python tools/fetch_dhm.py --apikey <KEY>` (or set `DATAFORDELER_API_KEY`) → GeoTIFFs in `samples/`, which load in Rhino/Revit (*Import DHM terrain*) or by drag-and-drop in the web app. |

An older **Dataforsyningen token** (dataforsyningen.dk → *Mine tokens*) also works; choose it in the credentials list.

Notes:
* DHM/Terræn has buildings removed and **bridge decks included**: add bridge cut-outs where roads pass under bridges.
* The browser version on GitHub Pages calls Datafordeler directly. If your browser blocks the request (CORS), use the
  desktop app or run the web app locally (`Cloudburst Web.bat`), which download without that restriction.
* Check the data licence before redistributing downloaded terrain files.
