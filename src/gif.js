// Small self-contained animated GIF encoder with transparency.
// frames: [{ data: Uint8ClampedArray (RGBA), delay: centiseconds }]

export function encodeGIF(frames, w, h, { loop = true } = {}) {
  const palette = buildPalette(frames);
  const out = new ByteWriter();
  out.str('GIF89a');
  out.u16(w); out.u16(h);
  out.byte(0xF7); out.byte(0); out.byte(0); // global table, 256 colours
  for (let i = 0; i < 256; i++) {
    const c = palette.colors[i] ?? 0;
    out.byte((c >> 16) & 255); out.byte((c >> 8) & 255); out.byte(c & 255);
  }
  if (loop) {
    out.byte(0x21); out.byte(0xFF); out.byte(11); out.str('NETSCAPE2.0');
    out.byte(3); out.byte(1); out.u16(0); out.byte(0);
  }
  for (const f of frames) {
    out.byte(0x21); out.byte(0xF9); out.byte(4);
    out.byte((2 << 2) | 1); // restore to background, transparent index used
    out.u16(Math.max(2, Math.round(f.delay)));
    out.byte(0); out.byte(0);
    out.byte(0x2C); out.u16(0); out.u16(0); out.u16(w); out.u16(h); out.byte(0);
    const idx = palette.map(f.data);
    out.byte(8);
    const lz = lzw(idx, 8);
    for (let p = 0; p < lz.length; p += 255) {
      const n = Math.min(255, lz.length - p);
      out.byte(n); out.bytes(lz.subarray(p, p + n));
    }
    out.byte(0);
  }
  out.byte(0x3B);
  return new Blob([out.result()], { type: 'image/gif' });
}

class ByteWriter {
  constructor() { this.buf = new Uint8Array(1 << 16); this.n = 0; }
  ensure(k) { if (this.n + k > this.buf.length) { const b = new Uint8Array(Math.max(this.buf.length * 2, this.n + k)); b.set(this.buf); this.buf = b; } }
  byte(v) { this.ensure(1); this.buf[this.n++] = v; }
  u16(v) { this.byte(v & 255); this.byte((v >> 8) & 255); }
  str(s) { for (let i = 0; i < s.length; i++) this.byte(s.charCodeAt(i)); }
  bytes(a) { this.ensure(a.length); this.buf.set(a, this.n); this.n += a.length; }
  result() { return this.buf.subarray(0, this.n); }
}

// Index 0 is transparent. Exact colours if they fit, otherwise median cut.
function buildPalette(frames) {
  const hist = new Map();
  for (const f of frames) {
    const d = f.data;
    for (let p = 0; p < d.length; p += 4) {
      if (d[p + 3] < 128) continue;
      const c = (d[p] << 16) | (d[p + 1] << 8) | d[p + 2];
      hist.set(c, (hist.get(c) || 0) + 1);
    }
  }
  let colors;
  if (hist.size <= 255) colors = [...hist.keys()];
  else colors = medianCut(hist, 255);
  const pal = [0, ...colors];
  const exact = hist.size <= 255;
  const lookup = new Map();
  if (exact) colors.forEach((c, i) => lookup.set(c, i + 1));
  const nearest = (c) => {
    let v = lookup.get(c);
    if (v !== undefined) return v;
    const r = (c >> 16) & 255, g = (c >> 8) & 255, b = c & 255;
    let best = 1, bd = Infinity;
    for (let i = 1; i < pal.length; i++) {
      const q = pal[i], dr = r - ((q >> 16) & 255), dg = g - ((q >> 8) & 255), db = b - (q & 255);
      const d = dr * dr * 2 + dg * dg * 4 + db * db * 3;
      if (d < bd) { bd = d; best = i; }
    }
    lookup.set(c, best);
    return best;
  };
  return {
    colors: pal,
    map(d) {
      const out = new Uint8Array(d.length / 4);
      for (let p = 0, i = 0; p < d.length; p += 4, i++) {
        out[i] = d[p + 3] < 128 ? 0 : nearest((d[p] << 16) | (d[p + 1] << 8) | d[p + 2]);
      }
      return out;
    },
  };
}

function medianCut(hist, max) {
  const all = [...hist.entries()].map(([c, n]) => ({ r: (c >> 16) & 255, g: (c >> 8) & 255, b: c & 255, n }));
  const boxes = [all];
  const range = (box) => {
    let mn = [255, 255, 255], mx = [0, 0, 0];
    for (const p of box) {
      if (p.r < mn[0]) mn[0] = p.r; if (p.r > mx[0]) mx[0] = p.r;
      if (p.g < mn[1]) mn[1] = p.g; if (p.g > mx[1]) mx[1] = p.g;
      if (p.b < mn[2]) mn[2] = p.b; if (p.b > mx[2]) mx[2] = p.b;
    }
    const d = [mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]];
    const ch = d[0] >= d[1] && d[0] >= d[2] ? 'r' : d[1] >= d[2] ? 'g' : 'b';
    return { ch, size: Math.max(...d) };
  };
  while (boxes.length < max) {
    let bi = -1, bs = 0, info = null;
    boxes.forEach((b, i) => {
      if (b.length < 2) return;
      const r = range(b);
      const score = r.size * Math.log2(b.length + 1);
      if (score > bs) { bs = score; bi = i; info = r; }
    });
    if (bi < 0) break;
    const box = boxes[bi].sort((a, b) => a[info.ch] - b[info.ch]);
    let total = 0; for (const p of box) total += p.n;
    let acc = 0, cut = 1;
    for (let i = 0; i < box.length - 1; i++) { acc += box[i].n; if (acc >= total / 2) { cut = i + 1; break; } }
    boxes.splice(bi, 1, box.slice(0, cut), box.slice(cut));
  }
  return boxes.map(b => {
    let r = 0, g = 0, bl = 0, n = 0;
    for (const p of b) { r += p.r * p.n; g += p.g * p.n; bl += p.b * p.n; n += p.n; }
    return (Math.round(r / n) << 16) | (Math.round(g / n) << 8) | Math.round(bl / n);
  });
}

function lzw(indices, minCodeSize) {
  const clear = 1 << minCodeSize, eoi = clear + 1;
  let codeSize = minCodeSize + 1, next = eoi + 1;
  let dict = new Map();
  const out = new ByteWriter();
  let cur = 0, bits = 0;
  const emit = (code) => {
    cur |= code << bits; bits += codeSize;
    while (bits >= 8) { out.byte(cur & 255); cur >>>= 8; bits -= 8; }
  };
  emit(clear);
  if (!indices.length) { emit(eoi); if (bits) out.byte(cur & 255); return out.result(); }
  let prefix = indices[0];
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i];
    const key = (prefix << 8) | k;
    const hit = dict.get(key);
    if (hit !== undefined) { prefix = hit; continue; }
    emit(prefix);
    if (next === 4096) {
      emit(clear); dict = new Map(); codeSize = minCodeSize + 1; next = eoi + 1;
    } else {
      if (next >= (1 << codeSize)) codeSize++;
      dict.set(key, next++);
    }
    prefix = k;
  }
  emit(prefix);
  emit(eoi);
  if (bits > 0) out.byte(cur & 255);
  return out.result();
}
