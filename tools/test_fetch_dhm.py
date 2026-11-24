#!/usr/bin/env python3
"""Offline test of tools/fetch_dhm.py: bbox snapping, tiling and seamless mosaicking against a fake WCS.

    python3 tools/test_fetch_dhm.py
"""
import math, os, sys, tempfile, urllib.parse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import fetch_dhm as f  # noqa: E402


def main():
    tmp = tempfile.mkdtemp()
    calls = []

    def fake_get(url):
        q = dict(urllib.parse.parse_qsl(url.split("?", 1)[1]))
        calls.append(q["bbox"])
        x0, y0, x1, y1 = map(float, q["bbox"].split(","))
        w, h = int(q["width"]), int(q["height"])
        assert abs((x1 - x0) / w - 0.4) < 1e-9 and all(v % 8 == 0 for v in (x0, y0, x1, y1)), "not on the DHM lattice"
        vals = [x0 + (c + 0.5) * 0.4 - 724000 for r in range(h) for c in range(w)]
        p = os.path.join(tmp, "tile.tif")
        f._write_float_tiff(p, w, h, vals, x0, y1, 0.4, "-9999")
        return 200, open(p, "rb").read()

    f._get = fake_get
    out = os.path.join(tmp, "mos.tif")
    f.fetch(("apikey", "K"), (724410.3, 6179030, 725410, 6179500), out, 0.4)
    w, h, vals, nd = f._read_float_tiff(open(out, "rb").read())
    assert len(calls) == 2 and (w, h) == (2520, 1200) and nd == "-9999", (calls, w, h, nd)
    row = vals[:w]
    assert all(abs(row[c] - row[c - 1] - 0.4) < 1e-3 for c in range(1, w)), "seam between tiles"
    assert not any(math.isnan(v) for v in vals)
    print("fetch_dhm: snapping, tiling and mosaic OK")


if __name__ == "__main__":
    main()
