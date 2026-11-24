// GeoTIFF reader and writer for terrain rasters. No dependencies; runs in the browser and in Node 18+.
//
// Reads: classic TIFF and BigTIFF, II and MM byte order, strips and tiles, chunky or planar bands (band 1 is used),
// uint/int/float 8–64 bit, compression none / LZW / Deflate (Adobe and old-style) / PackBits, predictor 1/2/3,
// GeoTIFF georeferencing via ModelPixelScale+ModelTiepoint or a non-rotated ModelTransformation, PixelIsPoint,
// GeoKeys (EPSG of the projected / geographic CRS, linear and vertical units, vertical CRS), GDAL_NODATA.
// Data is read lazily through a "byte source", so a window of a multi-GB file (File/Blob) or a Cloud Optimized
// GeoTIFF over HTTP range requests only touches the strips/tiles it needs.
//
// Not supported (clear error): JPEG / LERC / ZSTD / LZMA / WebP compression, rotated or sheared rasters,
// bit depths other than 8/16/32/64. Overviews are ignored: the full-resolution image is always used, because GDAL's
// default overviews are nearest-neighbour and would bias flow paths.

// ------------------------------------------------------------------------------------------------ byte sources

/** In-memory bytes. */
export class BytesSource {
  constructor(u8) { this.u8 = u8 instanceof Uint8Array ? u8 : new Uint8Array(u8); this.size = this.u8.length; }
  async read(off, len) {
    if (off >= this.size) return new Uint8Array(0);
    return this.u8.subarray(off, Math.min(this.size, off + len));
  }
}

/** A File/Blob, read slice by slice (never loads the whole file). */
export class BlobSource {
  constructor(blob) { this.blob = blob; this.size = blob.size; }
  async read(off, len) { return new Uint8Array(await this.blob.slice(off, Math.min(this.size, off + len)).arrayBuffer()); }
}

/**
 * HTTP range requests with a block cache (for Cloud Optimized GeoTIFFs). `fetchFn` defaults to global fetch.
 * Throws an Error with `.status` on HTTP errors (404/403 = tile does not exist).
 */
export class HttpRangeSource {
  constructor(url, { fetchFn = (...a) => fetch(...a), block = 65536, headers = {} } = {}) {
    this.url = url; this.fetchFn = fetchFn; this.block = block; this.headers = headers; this.cache = new Map(); this.size = Infinity; this.requests = 0; this.bytes = 0;
  }
  async _block(b) {
    if (!this.cache.has(b)) {
      const p = (async () => {
        const start = b * this.block, end = start + this.block - 1;
        this.requests++;
        const r = await this.fetchFn(this.url, { headers: { ...this.headers, Range: `bytes=${start}-${end}` } });
        if (!(r.status === 206 || r.status === 200)) { const e = new Error(`HTTP ${r.status} for ${this.url}`); e.status = r.status; throw e; }
        const buf = new Uint8Array(await r.arrayBuffer());
        this.bytes += buf.length;
        const cr = r.headers.get && r.headers.get('Content-Range');
        if (cr && /\/(\d+)$/.test(cr)) this.size = +/\/(\d+)$/.exec(cr)[1];
        if (r.status === 200) { // server ignored Range: keep the whole body as consecutive blocks
          this.size = buf.length;
          for (let k = 0; k * this.block < buf.length; k++) this.cache.set(k, Promise.resolve(buf.subarray(k * this.block, (k + 1) * this.block)));
          return buf.subarray(start, start + this.block);
        }
        return buf;
      })();
      this.cache.set(b, p);
      p.catch(() => this.cache.delete(b));
    }
    return this.cache.get(b);
  }
  async read(off, len) {
    const b0 = Math.floor(off / this.block), b1 = Math.floor((off + len - 1) / this.block);
    const parts = await Promise.all(Array.from({ length: b1 - b0 + 1 }, (_, i) => this._block(b0 + i)));
    const out = new Uint8Array(len); let filled = 0;
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i]; const base = (b0 + i) * this.block;
      const s = Math.max(0, off - base), e = Math.min(p.length, off + len - base);
      if (e > s) { out.set(p.subarray(s, e), base + s - off); filled = Math.max(filled, base + e - off); }
    }
    return out.subarray(0, filled);
  }
}

export const asSource = (x) => (x && typeof x.read === 'function' ? x
  : (typeof Blob !== 'undefined' && x instanceof Blob) ? new BlobSource(x) : new BytesSource(x));

// ------------------------------------------------------------------------------------------------ TIFF structure

const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 13: 4, 16: 8, 17: 8, 18: 8 };
export const TAG = {
  NewSubfileType: 254, ImageWidth: 256, ImageLength: 257, BitsPerSample: 258, Compression: 259, Photometric: 262,
  StripOffsets: 273, SamplesPerPixel: 277, RowsPerStrip: 278, StripByteCounts: 279, PlanarConfiguration: 284,
  Predictor: 317, TileWidth: 322, TileLength: 323, TileOffsets: 324, TileByteCounts: 325, SampleFormat: 339,
  ModelPixelScale: 33550, ModelTiepoint: 33922, ModelTransformation: 34264, GeoKeyDirectory: 34735,
  GeoDoubleParams: 34736, GeoAsciiParams: 34737, GdalMetadata: 42112, GdalNodata: 42113,
};
const COMPRESSION_NAMES = { 1: 'none', 2: 'CCITT', 5: 'LZW', 6: 'old JPEG', 7: 'JPEG', 8: 'Deflate', 32773: 'PackBits', 32946: 'Deflate', 34887: 'LERC', 34925: 'LZMA', 50000: 'ZSTD', 50001: 'WebP' };

function readNum(dv, off, type, le) {
  switch (type) {
    case 1: case 2: case 7: return dv.getUint8(off);
    case 6: return dv.getInt8(off);
    case 3: return dv.getUint16(off, le);
    case 8: return dv.getInt16(off, le);
    case 4: case 13: return dv.getUint32(off, le);
    case 9: return dv.getInt32(off, le);
    case 5: return dv.getUint32(off, le) / dv.getUint32(off + 4, le);
    case 10: return dv.getInt32(off, le) / dv.getInt32(off + 4, le);
    case 11: return dv.getFloat32(off, le);
    case 12: return dv.getFloat64(off, le);
    case 16: case 18: return Number(dv.getBigUint64(off, le));
    case 17: return Number(dv.getBigInt64(off, le));
    default: return 0;
  }
}

/** Parse the header and all IFDs. Returns {le, big, ifds: [Map(tag → value array | string)]}. */
export async function openTiff(srcIn) {
  const src = asSource(srcIn);
  const head = await src.read(0, 16);
  if (head.length < 8) throw new Error('Not a TIFF file (too short).');
  const bo = String.fromCharCode(head[0], head[1]);
  if (bo !== 'II' && bo !== 'MM') throw new Error('Not a TIFF file (no II/MM byte-order mark).');
  const le = bo === 'II';
  const hv = new DataView(head.buffer, head.byteOffset, head.length);
  const magic = hv.getUint16(2, le);
  let big = false, next;
  if (magic === 42) next = hv.getUint32(4, le);
  else if (magic === 43) { big = true; next = Number(hv.getBigUint64(8, le)); }
  else throw new Error(`Not a TIFF file (magic ${magic}).`);
  const ifds = [];
  const seen = new Set();
  while (next && !seen.has(next) && ifds.length < 64) {
    seen.add(next);
    const cntBytes = await src.read(next, big ? 8 : 2);
    const cdv = new DataView(cntBytes.buffer, cntBytes.byteOffset, cntBytes.length);
    const n = big ? Number(cdv.getBigUint64(0, le)) : cdv.getUint16(0, le);
    const esz = big ? 20 : 12;
    const body = await src.read(next + (big ? 8 : 2), n * esz + (big ? 8 : 4));
    const dv = new DataView(body.buffer, body.byteOffset, body.length);
    const ifd = new Map();
    for (let e = 0; e < n; e++) {
      const o = e * esz;
      const tag = dv.getUint16(o, le), type = dv.getUint16(o + 2, le);
      const count = big ? Number(dv.getBigUint64(o + 4, le)) : dv.getUint32(o + 4, le);
      const tsz = TYPE_SIZE[type]; if (!tsz) continue;
      const bytes = tsz * count, inline = bytes <= (big ? 8 : 4);
      let vdv, voff;
      if (inline) { vdv = dv; voff = o + (big ? 12 : 8); }
      else {
        const ptr = big ? Number(dv.getBigUint64(o + 12, le)) : dv.getUint32(o + 8, le);
        const vb = await src.read(ptr, bytes);
        if (vb.length < bytes) throw new Error('Truncated TIFF (tag data past end of file).');
        vdv = new DataView(vb.buffer, vb.byteOffset, vb.length); voff = 0;
      }
      if (type === 2) {
        let s = ''; for (let k = 0; k < count; k++) { const c = vdv.getUint8(voff + k); if (c) s += String.fromCharCode(c); else if (k < count - 1) s += '|'; }
        ifd.set(tag, s);
      } else {
        const arr = new Array(count);
        for (let k = 0; k < count; k++) arr[k] = readNum(vdv, voff + k * tsz, type, le);
        ifd.set(tag, arr);
      }
    }
    ifds.push(ifd);
    next = big ? Number(dv.getBigUint64(n * esz, le)) : dv.getUint32(n * esz, le);
  }
  if (!ifds.length) throw new Error('TIFF has no images.');
  return { src, le, big, ifds };
}

// ------------------------------------------------------------------------------------------------ georeferencing

function parseGeoKeys(ifd) {
  const dir = ifd.get(TAG.GeoKeyDirectory); const keys = {};
  if (!dir || dir.length < 4) return keys;
  const dbl = ifd.get(TAG.GeoDoubleParams) || [], asc = ifd.get(TAG.GeoAsciiParams) || '';
  for (let k = 0; k < dir[3]; k++) {
    const [id, loc, count, val] = dir.slice(4 + k * 4, 8 + k * 4);
    if (loc === 0) keys[id] = val;
    else if (loc === TAG.GeoDoubleParams) keys[id] = count === 1 ? dbl[val] : dbl.slice(val, val + count);
    else if (loc === TAG.GeoAsciiParams) keys[id] = asc.slice(val, val + count).replace(/\|$/, '');
  }
  return keys;
}

const FOOT = { 9002: 0.3048, 9003: 1200 / 3937, 9001: 1 };
export const VERTICAL_CRS = { 5799: 'DVR90', 5703: 'NAVD88', 5773: 'EGM96 geoid', 3855: 'EGM2008 geoid', 5941: 'NN2000', 5613: 'RH2000', 7837: 'DHHN2016', 5783: 'DHHN92', 5709: 'NAP', 5701: 'ODN', 4979: 'WGS84 ellipsoid' };

/** Georeferencing of an IFD: {x0, yTop, dx, dy, epsg, kind, linearUnit, verticalUnit, verticalCrs, pixelIsPoint, flipY}. */
export function georef(ifd, width, height) {
  const keys = parseGeoKeys(ifd);
  const g = { x0: 0, yTop: height, dx: 1, dy: 1, epsg: 0, kind: 'unknown', linearUnit: 1, verticalUnit: 1, verticalCrs: null, pixelIsPoint: keys[1025] === 2, flipY: false, hasGeo: false, citation: keys[1026] || keys[3073] || '' };
  const scale = ifd.get(TAG.ModelPixelScale), tie = ifd.get(TAG.ModelTiepoint), tr = ifd.get(TAG.ModelTransformation);
  if (tr && tr.length >= 16) {
    if (Math.abs(tr[1]) > 1e-12 || Math.abs(tr[4]) > 1e-12) throw new Error('Rotated or sheared GeoTIFFs are not supported. Warp it north-up first (gdalwarp).');
    g.dx = tr[0]; g.dy = -tr[5]; g.x0 = tr[3]; g.yTop = tr[7]; g.hasGeo = true;
  } else if (scale && tie && tie.length >= 6) {
    g.dx = scale[0]; g.dy = scale[1]; g.x0 = tie[3] - tie[0] * g.dx; g.yTop = tie[4] + tie[1] * g.dy; g.hasGeo = true;
  }
  if (g.dx < 0) throw new Error('GeoTIFF with negative x pixel size is not supported.');
  if (g.dy < 0) { g.flipY = true; g.dy = -g.dy; g.yTop = g.yTop + g.dy * height; } // south-up file: rows are flipped on read
  if (g.pixelIsPoint) { g.x0 -= g.dx / 2; g.yTop += g.dy / 2; }
  if (keys[1024] === 2) { g.kind = 'geographic'; g.epsg = keys[2048] && keys[2048] !== 32767 ? keys[2048] : 4326; }
  else if (keys[1024] === 1 || keys[3072]) { g.kind = 'projected'; g.epsg = keys[3072] && keys[3072] !== 32767 ? keys[3072] : 0; }
  if (keys[3076]) g.linearUnit = FOOT[keys[3076]] || 1;
  if (keys[4099]) g.verticalUnit = FOOT[keys[4099]] || 1;
  if (keys[4096] && keys[4096] !== 32767) g.verticalCrs = VERTICAL_CRS[keys[4096]] || `EPSG:${keys[4096]}`;
  return g;
}

// ------------------------------------------------------------------------------------------------ decompression

async function inflate(u8) {
  // TIFF Deflate is zlib-wrapped ("deflate" in the Compression Streams API).
  const ds = new DecompressionStream('deflate');
  const stream = new Blob([u8]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function lzwDecode(input, expected) {
  const out = new Uint8Array(expected); let op = 0;
  const dict = new Array(4096); for (let i = 0; i < 256; i++) dict[i] = new Uint8Array([i]);
  let next = 258, width = 9, bitPos = 0, prev = null;
  const total = input.length * 8;
  const readCode = () => {
    if (bitPos + width > total) return 257;
    let c = 0;
    for (let i = 0; i < width; i++) { const b = bitPos + i; c = (c << 1) | ((input[b >> 3] >> (7 - (b & 7))) & 1); }
    bitPos += width; return c;
  };
  const emit = (s) => { const n = Math.min(s.length, expected - op); if (n > 0) { out.set(n === s.length ? s : s.subarray(0, n), op); op += n; } };
  for (;;) {
    const code = readCode();
    if (code === 257) break;
    if (code === 256) { next = 258; width = 9; prev = null; continue; }
    let entry;
    if (code < next && dict[code]) entry = dict[code];
    else if (code === next && prev) { entry = new Uint8Array(prev.length + 1); entry.set(prev); entry[prev.length] = prev[0]; }
    else throw new Error('Corrupt LZW data.');
    emit(entry);
    if (prev && next < 4096) { const e = new Uint8Array(prev.length + 1); e.set(prev); e[prev.length] = entry[0]; dict[next++] = e; }
    prev = entry;
    if (next + 1 >= (1 << width) && width < 12) width++; // "early change"
    if (op >= expected) break;
  }
  return out;
}

function packBitsDecode(input, expected) {
  const out = new Uint8Array(expected); let ip = 0, op = 0;
  while (ip < input.length && op < expected) {
    const n = (input[ip++] << 24) >> 24;
    if (n >= 0) { const c = Math.min(n + 1, expected - op); out.set(input.subarray(ip, ip + c), op); ip += n + 1; op += c; }
    else if (n !== -128) { const c = Math.min(1 - n, expected - op); out.fill(input[ip++], op, op + c); op += c; }
  }
  return out;
}

async function decompress(raw, compression, expected) {
  switch (compression) {
    case 1: return raw;
    case 5: return lzwDecode(raw, expected);
    case 8: case 32946: return inflate(raw);
    case 32773: return packBitsDecode(raw, expected);
    default: throw new Error(`GeoTIFF compression "${COMPRESSION_NAMES[compression] || compression}" is not supported. Re-save it with e.g. gdal_translate -co COMPRESS=DEFLATE in.tif out.tif`);
  }
}

// ------------------------------------------------------------------------------------------------ pixel decoding

/** Decode one strip/tile buffer to a Float64Array of `w*h` samples of band 0 (rows top-down). */
function decodeBlock(bytes, w, h, info, le) {
  const { bps, fmt, spp, predictor, planar } = info;
  const bytesPer = bps / 8, stride = planar === 2 ? 1 : spp; // samples per pixel in this block
  const rowBytes = w * stride * bytesPer;
  const need = rowBytes * h;
  if (bytes.length < need) { const b = new Uint8Array(need); b.set(bytes); bytes = b; } // short last strip: pad
  if (predictor === 3) {
    // Floating-point predictor: per row, byte-wise horizontal differencing, then bytes are stored MSB-plane first.
    const out = new Uint8Array(need); const n = w * stride;
    for (let r = 0; r < h; r++) {
      const row = bytes.slice(r * rowBytes, (r + 1) * rowBytes);
      for (let i = stride; i < rowBytes; i++) row[i] = (row[i] + row[i - stride]) & 0xff;
      for (let s = 0; s < n; s++) for (let b = 0; b < bytesPer; b++) {
        out[r * rowBytes + s * bytesPer + (le ? bytesPer - 1 - b : b)] = row[b * n + s];
      }
    }
    bytes = out;
  }
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  const res = new Float64Array(w * h);
  const get = fmt === 3 ? (bps === 32 ? (o) => dv.getFloat32(o, le) : bps === 64 ? (o) => dv.getFloat64(o, le) : null)
    : fmt === 2 ? (bps === 8 ? (o) => dv.getInt8(o) : bps === 16 ? (o) => dv.getInt16(o, le) : bps === 32 ? (o) => dv.getInt32(o, le) : bps === 64 ? (o) => Number(dv.getBigInt64(o, le)) : null)
      : (bps === 8 ? (o) => dv.getUint8(o) : bps === 16 ? (o) => dv.getUint16(o, le) : bps === 32 ? (o) => dv.getUint32(o, le) : bps === 64 ? (o) => Number(dv.getBigUint64(o, le)) : null);
  if (!get) throw new Error(`Unsupported sample format (${bps}-bit ${fmt === 3 ? 'float' : fmt === 2 ? 'int' : 'uint'}).`);
  if (predictor === 2) {
    if (fmt === 3) throw new Error('Horizontal predictor on floating-point data is not valid TIFF.');
    const mask = bps === 64 ? null : 2 ** bps;
    for (let r = 0; r < h; r++) {
      let prev = 0;
      for (let i = 0; i < w; i++) {
        let v = get(r * rowBytes + i * stride * bytesPer);
        if (i > 0) { v = prev + v; if (mask) { if (fmt === 2) { const half = mask / 2; v = ((((v + half) % mask) + mask) % mask) - half; } else v = ((v % mask) + mask) % mask; } }
        prev = v; res[r * w + i] = v;
      }
    }
    return res;
  }
  for (let r = 0; r < h; r++) for (let i = 0; i < w; i++) res[r * w + i] = get(r * rowBytes + i * stride * bytesPer);
  return res;
}

function nodataFromTag(s) {
  if (s == null) return null;
  const t = String(s).replace(/\|/g, '').trim();
  if (!t) return null;
  if (/^nan$/i.test(t)) return NaN;
  const v = Number(t); return Number.isFinite(v) ? v : null;
}

/**
 * Read band 1 of the first full-resolution image as a north-up Float32 raster in metres (x/y and z).
 * opts.window = [col0, row0, col1, row1) in file pixels, or opts.bbox = [minx, miny, maxx, maxy] in the file's CRS.
 * opts.maxPixels caps the decoded window (default 40 M, ≈160 MB); larger requests throw unless opts.clipToMax, which
 * reads the central window that fits and adds a warning.
 * Returns {width, height, data (NaN = no data), x0, yTop, dx, dy, epsg, kind, verticalCrs, warnings, meta}.
 */
export async function readGeoTiff(input, opts = {}) {
  const tif = await openTiff(input);
  const { src, le } = tif;
  const ifd = tif.ifds.find((d) => !((d.get(TAG.NewSubfileType) || [0])[0] & 5)) || tif.ifds[0];
  const W = ifd.get(TAG.ImageWidth)[0], H = ifd.get(TAG.ImageLength)[0];
  const bpsArr = ifd.get(TAG.BitsPerSample) || [1];
  const info = {
    bps: bpsArr[0], fmt: (ifd.get(TAG.SampleFormat) || [1])[0], spp: (ifd.get(TAG.SamplesPerPixel) || [1])[0],
    predictor: (ifd.get(TAG.Predictor) || [1])[0], planar: (ifd.get(TAG.PlanarConfiguration) || [1])[0],
    compression: (ifd.get(TAG.Compression) || [1])[0],
  };
  if (![8, 16, 32, 64].includes(info.bps)) throw new Error(`${info.bps}-bit samples are not supported (expected an elevation raster).`);
  if (![1, 5, 8, 32773, 32946].includes(info.compression)) await decompress(new Uint8Array(0), info.compression, 0); // throws a helpful error
  const geo = georef(ifd, W, H);
  const warnings = [];
  if (info.spp > 1) warnings.push(`File has ${info.spp} bands; band 1 is used as elevation.`);
  if (!geo.hasGeo) warnings.push('No georeferencing in the file: pixel size 1 m and origin (0, 0) assumed.');
  const tiled = ifd.has(TAG.TileWidth);
  const tw = tiled ? ifd.get(TAG.TileWidth)[0] : W, th = tiled ? ifd.get(TAG.TileLength)[0] : Math.min(H, (ifd.get(TAG.RowsPerStrip) || [H])[0]);
  const offsets = ifd.get(tiled ? TAG.TileOffsets : TAG.StripOffsets), counts = ifd.get(tiled ? TAG.TileByteCounts : TAG.StripByteCounts);
  if (!offsets || !counts) throw new Error('TIFF has no strip/tile offsets.');

  // window in file pixel rows (row 0 = first stored row)
  let [c0, r0, c1, r1] = opts.window || [0, 0, W, H];
  if (opts.bbox && geo.hasGeo) {
    const [bx0, by0, bx1, by1] = opts.bbox;
    const fx0 = (bx0 - geo.x0) / geo.dx, fx1 = (bx1 - geo.x0) / geo.dx;
    const fyTop = (geo.yTop - by1) / geo.dy, fyBot = (geo.yTop - by0) / geo.dy; // north-up row coordinates
    c0 = Math.floor(fx0 + 1e-9) - 1; c1 = Math.ceil(fx1 - 1e-9) + 1;
    let rr0 = Math.floor(fyTop + 1e-9) - 1, rr1 = Math.ceil(fyBot - 1e-9) + 1;
    if (geo.flipY) [rr0, rr1] = [H - rr1, H - rr0];
    r0 = rr0; r1 = rr1;
  }
  c0 = Math.max(0, c0); r0 = Math.max(0, r0); c1 = Math.min(W, c1); r1 = Math.min(H, r1);
  if (c1 <= c0 || r1 <= r0) throw new Error('The requested area does not overlap the raster.');
  const maxPixels = opts.maxPixels || 40e6;
  if ((c1 - c0) * (r1 - r0) > maxPixels) {
    if (!opts.clipToMax) {
      const e = new Error(`Raster window is ${(c1 - c0)} × ${(r1 - r0)} px, more than the ${(maxPixels / 1e6).toFixed(0)} M pixel limit. Crop it to the site first.`);
      e.code = 'TOO_LARGE'; e.width = c1 - c0; e.height = r1 - r0; throw e;
    }
    const s = Math.sqrt(maxPixels / ((c1 - c0) * (r1 - r0)));
    const nw = Math.floor((c1 - c0) * s), nh = Math.floor((r1 - r0) * s);
    const cc = (c0 + c1) >> 1, rc = (r0 + r1) >> 1;
    c0 = cc - (nw >> 1); c1 = c0 + nw; r0 = rc - (nh >> 1); r1 = r0 + nh;
    warnings.push(`Raster is larger than the ${(maxPixels / 1e6).toFixed(0)} M pixel limit: only the central ${(nw * geo.dx * geo.linearUnit).toFixed(0)} × ${(nh * geo.dy * geo.linearUnit).toFixed(0)} m were read.`);
  }
  const w = c1 - c0, h = r1 - r0;
  const out = new Float32Array(w * h).fill(NaN);
  const across = Math.ceil(W / tw), down = Math.ceil(H / th), perPlane = across * down;
  const blockBytes = (bw, bh) => bw * bh * (info.planar === 2 ? 1 : info.spp) * (info.bps / 8);
  const jobs = [];
  for (let by = Math.floor(r0 / th); by <= Math.floor((r1 - 1) / th); by++) {
    for (let bx = Math.floor(c0 / tw); bx <= Math.floor((c1 - 1) / tw); bx++) {
      const idx = by * across + bx;
      if (idx >= perPlane || idx >= offsets.length) continue;
      jobs.push({ bx, by, off: offsets[idx], cnt: counts[idx] });
    }
  }
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const { bx, by, off, cnt } = jobs[next++];
      const bh = tiled ? th : Math.min(th, H - by * th);
      if (!cnt) continue; // sparse tile = no data
      const raw = await src.read(off, cnt);
      const bytes = await decompress(raw, info.compression, blockBytes(tw, bh));
      const vals = decodeBlock(bytes, tw, bh, info, le);
      for (let rr = 0; rr < bh; rr++) {
        const fr = by * th + rr; if (fr < r0 || fr >= r1) continue;
        for (let cc = 0; cc < tw; cc++) {
          const fc = bx * tw + cc; if (fc < c0 || fc >= c1) continue;
          out[(fr - r0) * w + (fc - c0)] = vals[rr * tw + cc];
        }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(6, jobs.length) }, worker));

  // no-data, units
  const nd = nodataFromTag(ifd.get(TAG.GdalNodata));
  const zs = geo.verticalUnit;
  let suspicious = 0;
  for (let k = 0; k < out.length; k++) {
    let v = out[k];
    if (nd !== null && (Number.isNaN(nd) ? Number.isNaN(v) : Math.abs(v - nd) <= Math.max(1e-6, Math.abs(nd) * 1e-7))) { out[k] = NaN; continue; }
    if (!Number.isFinite(v) || Math.abs(v) > 1e20) { out[k] = NaN; continue; }
    v *= zs;
    // Heuristic for files without a NoData tag: -9999 / -32767 / -32768 / -3.4e38 fills and anything far outside Earth's relief.
    if (v < -1000 || v > 9000) { out[k] = NaN; suspicious++; continue; }
    out[k] = v;
  }
  if (suspicious && nd === null) warnings.push(`${suspicious} cells with implausible heights (e.g. -9999) were treated as no data; the file has no NoData tag.`);
  if (geo.flipY) { // stored south-up → flip rows to north-up
    for (let r = 0; r < h >> 1; r++) { const a = out.slice(r * w, (r + 1) * w); out.copyWithin(r * w, (h - 1 - r) * w, (h - r) * w); out.set(a, (h - 1 - r) * w); }
  }
  const lu = geo.linearUnit;
  const rowNorth = geo.flipY ? H - r1 : r0;
  return {
    width: w, height: h, data: out,
    x0: (geo.x0 + c0 * geo.dx) * lu, yTop: (geo.yTop - rowNorth * geo.dy) * lu, dx: geo.dx * lu, dy: geo.dy * lu,
    epsg: geo.epsg, kind: geo.kind, verticalCrs: geo.verticalCrs, warnings,
    meta: { fileWidth: W, fileHeight: H, ...info, tiled, tileWidth: tw, tileHeight: th, bigTiff: tif.big, littleEndian: le, pixelIsPoint: geo.pixelIsPoint, nodata: nd, linearUnit: lu, verticalUnit: zs, citation: geo.citation, images: tif.ifds.length },
  };
}

// ------------------------------------------------------------------------------------------------ writer

/**
 * Write a single-band float32 GeoTIFF (uncompressed, strips, little-endian), PixelIsArea, north-up.
 * r = {width, height, data, x0, yTop, dx, dy, epsg?, nodata?}. NaN cells stay NaN (GDAL reads them as no data).
 * The output is read by the Rust engine (tiff crate) and by GDAL/QGIS.
 */
export function writeGeoTiff(r) {
  const { width: W, height: H, data } = r;
  const rowsPerStrip = Math.max(1, Math.min(H, Math.floor(262144 / (W * 4)) || 1));
  const nStrips = Math.ceil(H / rowsPerStrip);
  const geoKeys = [1, 1, 0, 0];
  const add = (id, val) => { geoKeys.push(id, 0, 1, val); geoKeys[3]++; };
  if (r.kind === 'geographic' || r.epsg === 4326 || r.epsg === 4258) { add(1024, 2); add(1025, 1); add(2048, r.epsg || 4326); }
  else { add(1024, 1); add(1025, 1); if (r.epsg) add(3072, r.epsg); add(3076, 9001); }
  if (r.verticalEpsg) { add(4096, r.verticalEpsg); add(4099, 9001); }
  const entries = []; // [tag, type, values]
  entries.push([256, 4, [W]], [257, 4, [H]], [258, 3, [32]], [259, 3, [1]], [262, 3, [1]]);
  entries.push([273, 4, new Array(nStrips).fill(0)], [277, 3, [1]], [278, 4, [rowsPerStrip]], [279, 4, Array.from({ length: nStrips }, (_, s) => Math.min(rowsPerStrip, H - s * rowsPerStrip) * W * 4)]);
  entries.push([284, 3, [1]], [339, 3, [3]]);
  entries.push([33550, 12, [r.dx, r.dy, 0]], [33922, 12, [0, 0, 0, r.x0, r.yTop, 0]], [34735, 3, geoKeys]);
  if (r.nodata != null) entries.push([42113, 2, String(r.nodata)]);
  entries.sort((a, b) => a[0] - b[0]);
  const tsz = { 2: 1, 3: 2, 4: 4, 12: 8 };
  // layout: header(8) | IFD | out-of-line values | pixel data
  const ifdSize = 2 + entries.length * 12 + 4;
  let extra = 0;
  const extOff = new Map();
  for (const e of entries) {
    const n = e[1] === 2 ? e[2].length + 1 : e[2].length; const sz = n * tsz[e[1]];
    if (sz > 4) { extOff.set(e[0], 8 + ifdSize + extra); extra += sz + (sz & 1); }
  }
  const dataOff = Math.ceil((8 + ifdSize + extra) / 8) * 8; // aligned, so the pixels can be copied as a Float32Array
  const total = dataOff + W * H * 4;
  const buf = new ArrayBuffer(total); const dv = new DataView(buf); const u8 = new Uint8Array(buf);
  dv.setUint8(0, 0x49); dv.setUint8(1, 0x49); dv.setUint16(2, 42, true); dv.setUint32(4, 8, true);
  const strips = entries.find((e) => e[0] === 273)[2];
  for (let s = 0; s < nStrips; s++) strips[s] = dataOff + s * rowsPerStrip * W * 4;
  dv.setUint16(8, entries.length, true);
  entries.forEach((e, i) => {
    const o = 10 + i * 12; const [tag, type, vals] = e;
    const n = type === 2 ? vals.length + 1 : vals.length; const sz = n * tsz[type];
    dv.setUint16(o, tag, true); dv.setUint16(o + 2, type, true); dv.setUint32(o + 4, n, true);
    const p = sz > 4 ? extOff.get(tag) : o + 8;
    if (sz > 4) dv.setUint32(o + 8, p, true);
    if (type === 2) { for (let k = 0; k < vals.length; k++) u8[p + k] = vals.charCodeAt(k); u8[p + vals.length] = 0; }
    else for (let k = 0; k < n; k++) {
      if (type === 3) dv.setUint16(p + k * 2, vals[k], true);
      else if (type === 4) dv.setUint32(p + k * 4, vals[k], true);
      else dv.setFloat64(p + k * 8, vals[k], true);
    }
  });
  dv.setUint32(10 + entries.length * 12, 0, true);
  new Float32Array(buf, dataOff, W * H).set(data); // little-endian hosts (all browsers / Node on x86 and ARM)
  return u8;
}
