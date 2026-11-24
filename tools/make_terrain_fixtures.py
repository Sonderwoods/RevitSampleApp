#!/usr/bin/env python3
"""
Write small synthetic terrain fixtures (GeoTIFF variants, Esri ASCII, XYZ) to samples/fixtures/ for the web
import tests (Web/tests/sources.test.mjs). Independent of the JavaScript reader: TIFF structure, Deflate (zlib),
PackBits and the predictors are produced here; LZW comes from Pillow/libtiff when available.

    python3 tools/make_terrain_fixtures.py

Every raster holds z(col, row) = 10 + 0.1*col - 0.05*row (row 0 = north), so tests can check any pixel.
Pixel (3, 2) is no-data in every file.
"""
import os, struct, sys, zlib

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "samples", "fixtures")
W, H = 37, 23
X0, YTOP, DX = 724410.0, 6179430.0, 0.4


def z(c, r):
    return 10 + 0.1 * c - 0.05 * r


TYPES = {"H": 3, "I": 4, "d": 12, "s": 2, "Q": 16}


def tiff(path, *, big=False, le=True, tiled=None, rows_per_strip=None, comp=1, pred=1, fmt="f", spp=1, planar=1,
         nodata="-9999", nd_value=-9999.0, geokeys=None, scale=(DX, DX, 0), tie=(0, 0, 0, X0, YTOP, 0), transform=None,
         values=None, width=W, height=H):
    e = "<" if le else ">"
    bps = {"f": 32, "d": 64, "h": 16, "b": 8}[fmt]
    sfmt = {"f": 3, "d": 3, "h": 2, "b": 1}[fmt]
    nb = bps // 8
    vals = values or (lambda c, r, b: z(c, r) + 100 * b)

    def px(c, r, b):
        v = vals(c, r, b)
        if (c, r) == (3, 2):
            v = nd_value
        return int(round(v)) if fmt in "hb" else v

    def pack_samples(samples):
        return b"".join(struct.pack(e + fmt, s) for s in samples)

    def encode_block(c0, r0, bw, bh, band_list):
        rows = []
        for r in range(bh):
            samples = []
            for c in range(bw):
                for b in band_list:
                    cc, rr = c0 + c, r0 + r
                    samples.append(px(cc, rr, b) if cc < width and rr < height else (0 if fmt in "hb" else 0.0))
            n = len(band_list)
            if pred == 2:  # horizontal differencing on integers (wraps)
                mask = (1 << bps) - 1
                diff = samples[:n] + [((samples[i] - samples[i - n]) & mask) for i in range(n, len(samples))]
                if fmt == "h":
                    diff = [d - (1 << 16) if d >= 1 << 15 else d for d in diff]
                row = pack_samples(diff)
            elif pred == 3:  # floating point predictor: big-endian byte planes, then byte differencing
                raw = b"".join(struct.pack(">" + fmt, s) for s in samples)
                planes = bytes(raw[i * nb + k] for k in range(nb) for i in range(len(samples)))
                out = bytearray(planes)
                for i in range(len(out) - 1, n - 1, -1):
                    out[i] = (out[i] - out[i - n]) & 0xFF
                row = bytes(out)
            else:
                row = pack_samples(samples)
            rows.append(row)
        data = b"".join(rows)
        if comp == 8:
            return zlib.compress(data)
        if comp == 32773:
            return packbits(data)
        return data

    blocks = []
    bands_planes = [[b] for b in range(spp)] if planar == 2 else [list(range(spp))]
    for bl in bands_planes:
        if tiled:
            tw, th = tiled
            for ty in range(0, height, th):
                for tx in range(0, width, tw):
                    blocks.append(encode_block(tx, ty, tw, th, bl))
        else:
            rps = rows_per_strip or height
            for sy in range(0, height, rps):
                blocks.append(encode_block(0, sy, width, min(rps, height - sy), bl))

    tags = {256: ("I", [width]), 257: ("I", [height]), 258: ("H", [bps] * spp), 259: ("H", [comp]), 262: ("H", [1]),
            277: ("H", [spp]), 284: ("H", [planar]), 317: ("H", [pred]), 339: ("H", [sfmt] * spp)}
    if tiled:
        tags[322] = ("H", [tiled[0]]); tags[323] = ("H", [tiled[1]])
    else:
        tags[278] = ("I", [rows_per_strip or height])
    if scale:
        tags[33550] = ("d", list(scale))
    if tie:
        tags[33922] = ("d", list(tie))
    if transform:
        tags[34264] = ("d", list(transform))
    gk = geokeys if geokeys is not None else [(1024, 1), (1025, 1), (3072, 25832), (3076, 9001), (4096, 5799)]
    if gk:
        tags[34735] = ("H", [1, 1, 0, len(gk)] + [v for k, val in gk for v in (k, 0, 1, val)])
    if nodata is not None:
        tags[42113] = ("s", nodata)
    off_tag, cnt_tag = (324, 325) if tiled else (273, 279)
    ptr = "Q" if big else "I"
    tags[off_tag] = (ptr, [0] * len(blocks))
    tags[cnt_tag] = (ptr, [len(b) for b in blocks])

    # layout: header | pixel blocks | out-of-line tag values | IFD
    head = 16 if big else 8
    buf = bytearray(head)
    offsets = []
    for b in blocks:
        offsets.append(len(buf)); buf += b
        if len(buf) % 2:
            buf += b"\0"
    tags[off_tag] = (ptr, offsets)
    ext = {}
    inline_max = 8 if big else 4
    for t in sorted(tags):
        typ, v = tags[t]
        payload = (v.encode() + b"\0") if typ == "s" else b"".join(struct.pack(e + typ, x) for x in v)
        if len(payload) > inline_max:
            ext[t] = len(buf); buf += payload
            if len(buf) % 2:
                buf += b"\0"
    ifd_off = len(buf)
    n = len(tags)
    buf += struct.pack(e + ("Q" if big else "H"), n)
    for t in sorted(tags):
        typ, v = tags[t]
        payload = (v.encode() + b"\0") if typ == "s" else b"".join(struct.pack(e + typ, x) for x in v)
        count = len(payload) if typ == "s" else len(v)
        if big:
            buf += struct.pack(e + "HHQ", t, TYPES[typ], count)
            buf += struct.pack(e + "Q", ext[t]) if t in ext else payload.ljust(8, b"\0")
        else:
            buf += struct.pack(e + "HHI", t, TYPES[typ], count)
            buf += struct.pack(e + "I", ext[t]) if t in ext else payload.ljust(4, b"\0")
    buf += struct.pack(e + ("Q" if big else "I"), 0)
    if big:
        buf[0:16] = (b"II" if le else b"MM") + struct.pack(e + "HHHQ", 43, 8, 0, ifd_off)
    else:
        buf[0:8] = (b"II" if le else b"MM") + struct.pack(e + "HI", 42, ifd_off)
    with open(os.path.join(OUT, path), "wb") as f:
        f.write(buf)


def packbits(data):
    out = bytearray(); i = 0
    while i < len(data):
        j = i
        while j + 1 < len(data) and data[j + 1] == data[i] and j - i < 127:
            j += 1
        if j > i:
            out += bytes([(257 - (j - i + 1)) & 0xFF, data[i]]); i = j + 1
        else:
            k = i
            while k < len(data) and k - i < 128 and not (k + 1 < len(data) and data[k + 1] == data[k]):
                k += 1
            k = max(k, i + 1)
            out += bytes([k - i - 1]) + data[i:k]; i = k
    return bytes(out)


def main():
    os.makedirs(OUT, exist_ok=True)
    tiff("strip_f32_le.tif")
    tiff("tiled_deflate_pred3_be.tif", le=False, tiled=(16, 16), comp=8, pred=3,
         geokeys=[(1024, 1), (1025, 2), (3072, 25832)], tie=(0, 0, 0, X0 + DX / 2, YTOP - DX / 2, 0))
    tiff("int16_pred2_deflate_geographic.tif", fmt="h", comp=8, pred=2, rows_per_strip=3, nodata="-32768", nd_value=-32768,
         geokeys=[(1024, 2), (1025, 1), (2048, 4326)], scale=(1 / 3600, 1 / 3600, 0), tie=(0, 0, 0, 12.57, 55.704, 0),
         values=lambda c, r, b: round(z(c, r) * 10))
    tiff("bigtiff_tiled_packbits_f64.tif", big=True, tiled=(16, 16), comp=32773, fmt="d")
    tiff("planar2_f32.tif", spp=2, planar=2, rows_per_strip=5)
    tiff("chunky2_deflate_f32.tif", spp=2, comp=8, rows_per_strip=4, nodata=None, nd_value=-9999.0)
    tiff("feet_transform_southup.tif", geokeys=[(1024, 1), (1025, 1), (3072, 25832), (3076, 9002), (4099, 9002)], scale=None, tie=None,
         transform=[DX / 0.3048, 0, 0, X0 / 0.3048, 0, DX / 0.3048, 0, (YTOP - H * DX) / 0.3048, 0, 0, 0, 0, 0, 0, 0, 1],
         values=lambda c, r, b: z(c, H - 1 - r) / 0.3048)
    # Esri ASCII (cell centre origin) and XYZ
    with open(os.path.join(OUT, "grid_center.asc"), "w") as f:
        f.write(f"ncols {W}\nnrows {H}\nxllcenter {X0 + DX / 2}\nyllcenter {YTOP - H * DX + DX / 2}\ncellsize {DX}\nNODATA_value -9999\n")
        for r in range(H):
            f.write(" ".join("-9999" if (c, r) == (3, 2) else f"{z(c, r):.4f}" for c in range(W)) + "\n")
    with open(os.path.join(OUT, "points.xyz"), "w") as f:
        f.write("x,y,z\n")
        for r in range(H):
            for c in range(W):
                if (c, r) != (3, 2):
                    f.write(f"{X0 + (c + 0.5) * DX:.2f},{YTOP - (r + 0.5) * DX:.2f},{z(c, r):.4f}\n")
    # LZW via Pillow/libtiff (independent encoder), if available
    try:
        from PIL import Image, TiffImagePlugin
        import numpy as np
        arr = np.array([[z(c, r) if (c, r) != (3, 2) else -9999.0 for c in range(W)] for r in range(H)], dtype=np.float32)
        info = TiffImagePlugin.ImageFileDirectory_v2()
        info[33550] = (DX, DX, 0.0); info.tagtype[33550] = 12
        info[33922] = (0.0, 0.0, 0.0, X0, YTOP, 0.0); info.tagtype[33922] = 12
        info[34735] = (1, 1, 0, 3, 1024, 0, 1, 1, 1025, 0, 1, 1, 3072, 0, 1, 25832); info.tagtype[34735] = 3
        info[42113] = "-9999"; info.tagtype[42113] = 2
        TiffImagePlugin.WRITE_LIBTIFF = True
        Image.fromarray(arr, mode="F").save(os.path.join(OUT, "pillow_lzw_f32.tif"), compression="tiff_lzw", tiffinfo=info)
        TiffImagePlugin.WRITE_LIBTIFF = False
    except Exception as ex:  # noqa
        print("Pillow LZW fixture skipped:", ex, file=sys.stderr)
    print("fixtures written to", os.path.normpath(OUT))


if __name__ == "__main__":
    main()
