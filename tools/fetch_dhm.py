#!/usr/bin/env python3
"""
Download DHM/Terræn (Danmarks Højdemodel) terrain GeoTIFFs for the real sample sites, or any bbox.

Credentials (either):
  * Datafordeler API key  (env DATAFORDELER_API_KEY or --apikey)  → https://wcs.datafordeler.dk  (preferred)
  * Dataforsyningen token (env DATAFORSYNINGEN_TOKEN or --token)   → https://api.dataforsyningen.dk

    python3 tools/fetch_dhm.py --token YOUR_TOKEN                      # all real samples → samples/*.tif
    python3 tools/fetch_dhm.py --token T --site dk_taasinge
    python3 tools/fetch_dhm.py --token T --bbox 724410 6179030 724810 6179430 --out mysite.tif --res 0.4

The files are EPSG:25832 GeoTIFFs. Load them in Rhino/Revit ("Import DHM terrain") or drop them into the web app.
Note: DHM/Terræn has buildings removed but bridge decks included — add bridge cut-outs where relevant.
"""
import argparse, os, sys, urllib.error, urllib.parse, urllib.request

WCS_DATAFORSYNINGEN = "https://api.dataforsyningen.dk/dhm_wcs_DAF"
WCS_DATAFORDELER = "https://wcs.datafordeler.dk/DHMNedboer/dhm_wcs/1.0.0/WCS"

# keep in sync with Shared/cloudburst-core/src/samples.rs
SITES = {
    "dk_taasinge":       ("Tåsinge Plads, Østerbro",   (724410, 6179030, 724810, 6179430)),
    "dk_skt_kjeld":      ("Skt. Kjelds Plads",         (724606, 6179385, 725006, 6179785)),
    "dk_enghaveparken":  ("Enghaveparken, Vesterbro",  (722489, 6174434, 722989, 6174934)),
    "dk_kongens_nytorv": ("Kongens Nytorv",            (725197, 6176115, 725597, 6176515)),
    "dk_odense":         ("Odense, Munke Mose",        (587350, 6139090, 587850, 6139590)),
}


def _get(url):
    req = urllib.request.Request(url, headers={"User-Agent": "cloudburst-fetch/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def endpoint(cred):
    kind, secret = cred
    return (WCS_DATAFORDELER, {"apikey": secret}) if kind == "apikey" else (WCS_DATAFORSYNINGEN, {"token": secret})


def capabilities(cred):
    base, auth = endpoint(cred)
    status, data = _get(base + "?" + urllib.parse.urlencode(dict(service="WCS", request="GetCapabilities", version="1.0.0", **auth)))
    names = [n.split("<name>")[1].split("</name>")[0] for n in data.decode("utf-8", "replace").split("<CoverageOfferingBrief>")[1:] if "<name>" in n]
    return status, names


def fetch(cred, bbox, out, res=0.4, coverage="dhm_terraen"):
    minx, miny, maxx, maxy = bbox
    w, h = int(round((maxx - minx) / res)), int(round((maxy - miny) / res))
    base, auth = endpoint(cred)
    q = dict(service="WCS", request="GetCoverage", version="1.0.0", coverage=coverage, crs="EPSG:25832",
             bbox=f"{minx},{miny},{maxx},{maxy}", width=w, height=h, format="GTiff", **auth)
    status, data = _get(base + "?" + urllib.parse.urlencode(q))
    if status != 200 or data[:2] not in (b"II", b"MM"):
        raise RuntimeError(f"HTTP {status}, not a GeoTIFF: {data[:300].decode('utf-8', 'replace')}")
    with open(out, "wb") as f:
        f.write(data)
    print(f"  {out}  {w}×{h} px @ {res} m  ({len(data) / 1e6:.1f} MB)")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--apikey", default=os.environ.get("DATAFORDELER_API_KEY"), help="Datafordeler API key (or env DATAFORDELER_API_KEY)")
    ap.add_argument("--token", default=os.environ.get("DATAFORSYNINGEN_TOKEN"), help="Dataforsyningen token (or env DATAFORSYNINGEN_TOKEN)")
    ap.add_argument("--coverage", help="override the coverage name (default dhm_terraen / dhm_overflade)")
    ap.add_argument("--site", choices=sorted(SITES), help="one real sample site (default: all)")
    ap.add_argument("--bbox", nargs=4, type=float, metavar=("MINX", "MINY", "MAXX", "MAXY"), help="custom EPSG:25832 bbox")
    ap.add_argument("--out", help="output file for --bbox")
    ap.add_argument("--res", type=float, default=0.4, help="pixel size in metres (0.4 = native)")
    ap.add_argument("--surface", action="store_true", help="download DHM/Overflade (with buildings/trees) instead of Terræn")
    ap.add_argument("--dir", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "samples"))
    a = ap.parse_args()
    if a.apikey:
        cred = ("apikey", a.apikey)
    elif a.token:
        cred = ("token", a.token)
    else:
        sys.exit("Credentials required: --apikey / DATAFORDELER_API_KEY or --token / DATAFORSYNINGEN_TOKEN")
    status, names = capabilities(cred)
    print(f"{endpoint(cred)[0]}: GetCapabilities HTTP {status}, coverages: {', '.join(names) or '?'}")
    cov = a.coverage or ("dhm_overflade" if a.surface else "dhm_terraen")
    if names and cov not in names:
        alt = [n for n in names if ("overflade" if a.surface else "terr") in n.lower()]
        if alt:
            print(f"coverage '{cov}' not offered, using '{alt[0]}'")
            cov = alt[0]
    os.makedirs(a.dir, exist_ok=True)
    if a.bbox:
        fetch(cred, a.bbox, a.out or os.path.join(a.dir, "custom.tif"), a.res, cov)
        return
    failed = 0
    for sid in ([a.site] if a.site else SITES):
        name, bbox = SITES[sid]
        print(name)
        try:
            fetch(cred, bbox, os.path.join(a.dir, f"{sid}.tif"), a.res, cov)
        except Exception as e:  # keep going with the other sites
            print(f"  FAILED: {e}")
            failed += 1
    if failed:
        sys.exit(f"{failed} site(s) failed")


if __name__ == "__main__":
    main()
