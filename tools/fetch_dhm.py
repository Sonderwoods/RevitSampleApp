#!/usr/bin/env python3
"""
Download DHM/Terræn (Danmarks Højdemodel) terrain GeoTIFFs for the real sample sites, or any bbox.

Credentials (either):
  * Datafordeler API key  (env DATAFORDELER_API_KEY or --apikey)  → https://wcs.datafordeler.dk  (preferred)
    Get one free at https://portal.datafordeler.dk/hjem (MitID/NemID or e-mail login).
  * Dataforsyningen token (env DATAFORSYNINGEN_TOKEN or --token)   → https://api.dataforsyningen.dk

    python3 tools/fetch_dhm.py --token YOUR_TOKEN                      # all real samples → samples/*.tif
    python3 tools/fetch_dhm.py --token T --site dk_taasinge
    python3 tools/fetch_dhm.py --token T --bbox 724410 6179030 724810 6179430 --out mysite.tif --res 0.4
    python3 tools/fetch_dhm.py --apikey K --list                       # products (coverages) offered for this key
    python3 tools/fetch_dhm.py --apikey K --hydro --site dk_taasinge   # prefer a hydrologically adapted product

The files are EPSG:25832 GeoTIFFs. Load them in Rhino/Revit ("Import DHM terrain") or drop them into the web app.
The bbox is snapped outward to multiples of 8 m so pixels sit on the DHM 0.4 m lattice (no server-side resampling),
and areas wider than 2000 px are fetched as tiles and mosaicked into ONE file (no seams between tiles).
Note: DHM/Terræn has buildings removed but bridge decks included — add bridge cut-outs where relevant.
"""
import argparse, os, struct, sys, urllib.error, urllib.parse, urllib.request, zlib

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


SNAP = 8.0       # m; multiple of 0.4, 0.8 and 1.6 → bbox edges on the DHM pixel lattice
MAX_PX = 2000    # pixels per side per WCS request


def snap(bbox):
    import math
    return (math.floor(bbox[0] / SNAP) * SNAP, math.floor(bbox[1] / SNAP) * SNAP, math.ceil(bbox[2] / SNAP) * SNAP, math.ceil(bbox[3] / SNAP) * SNAP)


def _request(cred, bbox, res, coverage):
    minx, miny, maxx, maxy = bbox
    w, h = int(round((maxx - minx) / res)), int(round((maxy - miny) / res))
    base, auth = endpoint(cred)
    q = dict(service="WCS", request="GetCoverage", version="1.0.0", coverage=coverage, crs="EPSG:25832",
             bbox=f"{minx:.10g},{miny:.10g},{maxx:.10g},{maxy:.10g}", width=w, height=h, format="GTiff", **auth)
    status, data = _get(base + "?" + urllib.parse.urlencode(q))
    if status in (401, 403):
        raise RuntimeError(f"key rejected (HTTP {status}): {data[:300].decode('utf-8', 'replace')}")
    if status != 200 or data[:2] not in (b"II", b"MM"):
        raise RuntimeError(f"HTTP {status}, not a GeoTIFF: {data[:300].decode('utf-8', 'replace')}")
    return w, h, data


def _read_float_tiff(data):
    """Minimal reader for the WCS output: classic TIFF, one band, float32, strips, no/Deflate compression."""
    e = "<" if data[:2] == b"II" else ">"
    off = struct.unpack(e + "I", data[4:8])[0]
    n = struct.unpack(e + "H", data[off:off + 2])[0]
    tags = {}
    size = {3: 2, 4: 4, 11: 4, 12: 8, 2: 1, 16: 8}
    fmt = {3: "H", 4: "I", 11: "f", 12: "d", 16: "Q"}
    for k in range(n):
        t, typ, cnt, val = struct.unpack(e + "HHI4s", data[off + 2 + k * 12: off + 14 + k * 12])
        if typ not in size:
            continue
        raw = val if size[typ] * cnt <= 4 else data[struct.unpack(e + "I", val)[0]:][:size[typ] * cnt]
        tags[t] = raw[:cnt].decode("latin1").rstrip("\0") if typ == 2 else list(struct.unpack(e + fmt[typ] * cnt, raw[:size[typ] * cnt]))
    if tags.get(258, [32])[0] != 32 or tags.get(339, [3])[0] != 3 or 322 in tags or tags.get(259, [1])[0] not in (1, 8) or tags.get(317, [1])[0] != 1:
        raise ValueError("not a plain float32 strip TIFF")
    w, h = tags[256][0], tags[257][0]
    buf = b""
    for o, c in zip(tags[273], tags[279]):
        chunk = data[o:o + c]
        buf += zlib.decompress(chunk) if tags.get(259, [1])[0] == 8 else chunk
    vals = struct.unpack(e + "f" * (w * h), buf[:4 * w * h])
    return w, h, vals, tags.get(42113)


def _write_float_tiff(path, w, h, vals, x0, ytop, res, nodata):
    """Uncompressed float32 GeoTIFF, EPSG:25832, DVR90 (readable by GDAL, QGIS, the engine and the web app)."""
    geokeys = [1, 1, 0, 5, 1024, 0, 1, 1, 1025, 0, 1, 1, 3072, 0, 1, 25832, 3076, 0, 1, 9001, 4096, 0, 1, 5799]
    entries = [(256, 4, [w]), (257, 4, [h]), (258, 3, [32]), (259, 3, [1]), (262, 3, [1]), (273, 4, [0]), (277, 3, [1]),
               (278, 4, [h]), (279, 4, [4 * w * h]), (284, 3, [1]), (339, 3, [3]), (33550, 12, [res, res, 0.0]),
               (33922, 12, [0, 0, 0, x0, ytop, 0]), (34735, 3, geokeys)]
    if nodata:
        entries.append((42113, 2, nodata))
    fmt = {3: "H", 4: "I", 12: "d"}
    ext = bytearray(); ifd_size = 2 + 12 * len(entries) + 4
    data_off = 8 + ifd_size
    blobs = {}
    for t, typ, v in entries:
        payload = (v.rstrip("\0") + "\0").encode() if typ == 2 else struct.pack("<" + fmt[typ] * len(v), *v)
        if len(payload) > 4:
            blobs[t] = data_off + len(ext); ext += payload + (b"\0" if len(payload) % 2 else b"")
    pix = data_off + len(ext)
    out = bytearray(b"II" + struct.pack("<HI", 42, 8) + struct.pack("<H", len(entries)))
    for t, typ, v in entries:
        if t == 273:
            v = [pix]
        payload = (v.rstrip("\0") + "\0").encode() if typ == 2 else struct.pack("<" + fmt[typ] * len(v), *v)
        cnt = len(payload) if typ == 2 else len(v)
        out += struct.pack("<HHI", t, typ, cnt) + (struct.pack("<I", blobs[t]) if t in blobs else payload.ljust(4, b"\0"))
    out += struct.pack("<I", 0) + ext + struct.pack("<" + "f" * (w * h), *vals)
    with open(path, "wb") as f:
        f.write(out)


def fetch(cred, bbox, out, res=0.4, coverage="dhm_terraen"):
    bbox = snap(bbox)
    minx, miny, maxx, maxy = bbox
    span = int(MAX_PX * res // SNAP) * SNAP
    xs = [minx + k * span for k in range(int((maxx - minx) // span) + 1) if minx + k * span < maxx]
    ys = [miny + k * span for k in range(int((maxy - miny) // span) + 1) if miny + k * span < maxy]
    if len(xs) * len(ys) == 1:
        w, h, data = _request(cred, bbox, res, coverage)
        with open(out, "wb") as f:
            f.write(data)
        print(f"  {out}  {w}×{h} px @ {res} m  ({len(data) / 1e6:.1f} MB)  bbox {bbox}")
        return
    W, H = int(round((maxx - minx) / res)), int(round((maxy - miny) / res))
    mos = [float("nan")] * (W * H); nodata = None
    for y0 in ys:
        for x0 in xs:
            tb = (x0, y0, min(maxx, x0 + span), min(maxy, y0 + span))
            w, h, data = _request(cred, tb, res, coverage)
            try:
                tw, th, vals, nd = _read_float_tiff(data)
            except ValueError as ex:
                part = f"{os.path.splitext(out)[0]}_{int(x0)}_{int(y0)}.tif"
                with open(part, "wb") as f:
                    f.write(data)
                print(f"  could not mosaic ({ex}); wrote tile {part}")
                continue
            nodata = nodata or nd
            c0, r0 = int(round((x0 - minx) / res)), int(round((maxy - tb[3]) / res))
            for r in range(th):
                mos[(r0 + r) * W + c0:(r0 + r) * W + c0 + tw] = vals[r * tw:(r + 1) * tw]
            print(f"  tile {tb}: {tw}×{th} px")
    _write_float_tiff(out, W, H, mos, minx, maxy, res, nodata)
    print(f"  {out}  {W}×{H} px @ {res} m mosaic of {len(xs) * len(ys)} tiles  bbox {bbox}")


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
    ap.add_argument("--hydro", action="store_true", help="prefer a hydrologically adapted product if the service lists one")
    ap.add_argument("--list", action="store_true", help="only list the products (coverages) offered for this key")
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
    if a.list:
        return
    cov = a.coverage or ("dhm_overflade" if a.surface else "dhm_terraen")
    if a.hydro and not a.coverage:
        hyd = [n for n in names if any(w in n.lower() for w in ("hydro", "tilpas", "nedb", "bluespot"))]
        if hyd:
            print(f"using hydrologically adapted product '{hyd[0]}' (check its documentation)")
            cov = hyd[0]
        else:
            print("no hydrologically adapted product offered; using", cov)
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
