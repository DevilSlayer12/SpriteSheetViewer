// Frame detection for sprite sheets of any size and layout.
// Works on raw RGBA data so it can run on big atlases without the DOM.

export const DEFAULT_SLICE = {
  mode: 'auto',        // auto | grid-count | grid-size | islands
  cols: 4, rows: 1,
  cw: 32, ch: 32, ox: 0, oy: 0, sx: 0, sy: 0,
  alphaMin: 32,        // pixels with alpha above this count as sprite pixels
  tol: 32,             // colour distance for solid colour backgrounds
  gap: 2,              // merge islands closer than this many pixels
  pad: 2,              // extra pixels kept around each island
  minPixels: 0,        // drop islands smaller than this (0 = automatic)
  skipEmpty: true,
  removeBg: 'auto',    // auto | off | hard | soft
  order: 'rows',       // rows | columns
};

// ---------- background ----------
export function findBackground(data, w, h) {
  const n = w * h;
  const step = Math.max(1, Math.floor(n / 250000));
  let clear = 0, total = 0;
  for (let i = 0; i < n; i += step) { total++; if (data[i * 4 + 3] < 250) clear++; }
  const cornerIdx = [0, w - 1, (h - 1) * w, n - 1];
  const cornersClear = cornerIdx.filter(i => data[i * 4 + 3] < 16).length;
  if (clear / total > 0.02 || cornersClear >= 2) return { type: 'alpha' };
  // solid colour background: most common corner colour
  const cols = cornerIdx.map(i => [data[i * 4], data[i * 4 + 1], data[i * 4 + 2]]);
  let best = cols[0], bestCount = 0;
  for (const c of cols) {
    const k = cols.filter(d => dist2(c, d) < 100).length;
    if (k > bestCount) { best = c; bestCount = k; }
  }
  // a real background covers a good part of the sheet; otherwise frames fill their cells
  const t = 32 * 32;
  let near = 0, seen = 0;
  for (let i = 0; i < n; i += step) {
    seen++;
    const p = i * 4, dr = data[p] - best[0], dg = data[p + 1] - best[1], db = data[p + 2] - best[2];
    if (dr * dr + dg * dg + db * db <= t) near++;
  }
  const share = near / seen;
  if (bestCount < 2 || share < 0.12 || (bestCount === 2 && share < 0.35)) return { type: 'none' };
  return { type: 'color', color: best };
}

function dist2(a, b) {
  const dr = a[0] - b[0], dg = a[1] - b[1], db = a[2] - b[2];
  return dr * dr + dg * dg + db * db;
}

export function buildMask(data, w, h, bg, opts) {
  const n = w * h, mask = new Uint8Array(n);
  const aMin = opts.alphaMin ?? 16;
  if (bg.type === 'alpha' || bg.type === 'none') {
    for (let i = 0; i < n; i++) mask[i] = data[i * 4 + 3] > aMin ? 1 : 0;
  } else {
    const [r, g, b] = bg.color, t = (opts.tol ?? 32) ** 2;
    for (let i = 0, p = 0; i < n; i++, p += 4) {
      if (data[p + 3] <= aMin) continue;
      const dr = data[p] - r, dg = data[p + 1] - g, db = data[p + 2] - b;
      mask[i] = dr * dr + dg * dg + db * db > t ? 1 : 0;
    }
  }
  return mask;
}

// ---------- islands (connected pixel groups) ----------
// Grow the mask by r pixels (square) so nearby pieces join into one island.
export function dilate(mask, w, h, r) {
  if (r <= 0) return mask;
  const tmp = new Uint8Array(mask.length), out = new Uint8Array(mask.length);
  for (let y = 0; y < h; y++) {
    const o = y * w; let run = 0;
    for (let x = 0; x < w + r; x++) {
      if (x < w && mask[o + x]) run = 2 * r + 1; // pixel seen: covers x-r..x+r
      if (run > 0) { const tx = x - r; if (tx >= 0 && tx < w) tmp[o + tx] = 1; run--; }
    }
    // left side coverage
    run = 0;
    for (let x = w - 1; x >= -r; x--) {
      if (x >= 0 && mask[o + x]) run = r + 1;
      if (run > 0) { if (x >= 0) tmp[o + x] = 1; run--; }
    }
  }
  for (let x = 0; x < w; x++) {
    let run = 0;
    for (let y = 0; y < h + r; y++) {
      if (y < h && tmp[y * w + x]) run = 2 * r + 1;
      if (run > 0) { const ty = y - r; if (ty >= 0 && ty < h) out[ty * w + x] = 1; run--; }
    }
    run = 0;
    for (let y = h - 1; y >= -r; y--) {
      if (y >= 0 && tmp[y * w + x]) run = r + 1;
      if (run > 0) { if (y >= 0) out[y * w + x] = 1; run--; }
    }
  }
  return out;
}

// Label connected groups in `mask`; bounds and counts use `orig` pixels only.
export function findIslands(mask, w, h, orig = mask) {
  const seen = new Uint8Array(mask.length);
  let stack = new Int32Array(1 << 16);
  const boxes = [];
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || seen[start]) continue;
    let sp = 0; stack[sp++] = start; seen[start] = 1;
    let x0 = w, y0 = h, x1 = -1, y1 = -1, count = 0;
    while (sp) {
      const p = stack[--sp];
      const x = p % w, y = (p - x) / w;
      if (orig[p]) {
        count++;
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy; if (ny < 0 || ny >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx; if (nx < 0 || nx >= w) continue;
          const q = ny * w + nx;
          if (mask[q] && !seen[q]) {
            seen[q] = 1;
            if (sp >= stack.length) { const s2 = new Int32Array(stack.length * 2); s2.set(stack); stack = s2; }
            stack[sp++] = q;
          }
        }
      }
    }
    if (count) boxes.push({ x0, y0, x1, y1, count });
  }
  return boxes;
}

// Group boxes into reading-order rows.
export function groupRows(boxes) {
  const sorted = boxes.map((b, i) => ({ b, i })).sort((p, q) => (p.b.y0 + p.b.y1) - (q.b.y0 + q.b.y1));
  const rows = [];
  for (const p of sorted) {
    const b = p.b, bh = b.y1 - b.y0 + 1, cy = (b.y0 + b.y1) / 2;
    let row = null, best = Infinity;
    for (const r of rows) {
      const d = Math.abs(cy - r.cy);
      if (d < 0.5 * Math.min(r.h, bh) && d < best) { row = r; best = d; }
    }
    if (!row) { row = { cy, h: bh, n: 0, y0: b.y0, y1: b.y1, items: [] }; rows.push(row); }
    row.items.push(p.i);
    row.n++;
    row.cy += (cy - row.cy) / row.n;
    row.h += (bh - row.h) / row.n;
    row.y0 = Math.min(row.y0, b.y0); row.y1 = Math.max(row.y1, b.y1);
  }
  rows.sort((a, b) => a.cy - b.cy);
  for (const r of rows) r.items.sort((i, j) => boxes[i].x0 - boxes[j].x0);
  return rows;
}

function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

// Try to explain the islands as a regular grid: test every grid that divides the
// sheet evenly, keep those where (almost) every island sits inside one cell, and
// pick the one that gives the most sprites their own cell (then the fewest cells).
function inferGrid(boxes, W, H) {
  if (boxes.length < 2) return null;
  const counts = (n) => { const d = []; for (let i = 1; i <= n; i++) if (n % i === 0 && n / i >= 4) d.push(i); return d; };
  const maxCells = boxes.length * 4 + 8;
  let best = null;
  for (const cols of counts(W)) {
    for (const rows of counts(H)) {
      const cells = cols * rows;
      if (cells < 2 || cells > maxCells) continue;
      const cw = W / cols, ch = H / rows;
      let fit = 0;
      const used = new Set();
      for (const b of boxes) {
        const c0 = Math.floor(b.x0 / cw), c1 = Math.floor(b.x1 / cw);
        const r0 = Math.floor(b.y0 / ch), r1 = Math.floor(b.y1 / ch);
        if (c0 === c1 && r0 === r1) { fit++; used.add(r0 * cols + c0); }
      }
      if (fit < boxes.length * 0.95 || used.size < Math.max(2, boxes.length * 0.6)) continue;
      if (!best || used.size > best.occ || (used.size === best.occ && cells < best.cols * best.rows)) {
        best = { cols, rows, cw, ch, ox: 0, oy: 0, sx: 0, sy: 0, occ: used.size };
      }
    }
  }
  if (best) delete best.occ;
  return best;
}

// For sheets where sprites touch each other (no gaps): guess square cells.
function guessTouchingGrid(data, W, H) {
  if (W % H === 0 && W / H >= 2) return { cols: W / H, rows: 1, cw: H, ch: H };
  if (H % W === 0 && H / W >= 2) return { cols: 1, rows: H / W, cw: W, ch: W };
  const sizes = [512, 256, 192, 128, 96, 64, 48, 32, 24, 16, 8];
  let best = null, bestScore = 0;
  const colDiff = (x) => { // mean difference between column x-1 and x
    let s = 0, c = 0;
    for (let y = 0; y < H; y += Math.max(1, H >> 8)) {
      const a = (y * W + x - 1) * 4, b = (y * W + x) * 4;
      s += Math.abs(data[a] - data[b]) + Math.abs(data[a + 1] - data[b + 1]) + Math.abs(data[a + 2] - data[b + 2]) + Math.abs(data[a + 3] - data[b + 3]);
      c++;
    }
    return s / c;
  };
  let base = 0, nb = 0;
  for (let x = 1; x < W; x += Math.max(1, W >> 7)) { base += colDiff(x); nb++; }
  base = base / nb + 1;
  for (const s of sizes) {
    if (W % s || H % s || (W / s) * (H / s) < 2) continue;
    let sum = 0, k = 0;
    for (let x = s; x < W; x += s) { sum += colDiff(x); k++; }
    const score = k ? sum / k / base : 0;
    if (score > bestScore * 1.15) { bestScore = score; best = s; }
  }
  if (best && bestScore > 1.2) return { cols: W / best, rows: H / best, cw: best, ch: best };
  return null;
}

export function gridRects(W, H, g, mask, skipEmpty, order = 'rows') {
  const rects = [];
  const cw = Math.max(1, g.cw | 0), ch = Math.max(1, g.ch | 0);
  const sx = g.sx | 0, sy = g.sy | 0, ox = g.ox | 0, oy = g.oy | 0;
  const rowsOut = [];
  for (let r = 0; ; r++) {
    const y = oy + r * (ch + sy);
    if (y + ch > H || r > 4096) break;
    const row = [];
    for (let c = 0; ; c++) {
      const x = ox + c * (cw + sx);
      if (x + cw > W || c > 4096) break;
      if (skipEmpty && mask && isEmpty(mask, W, x, y, cw, ch)) continue;
      row.push(rects.length);
      rects.push({ x, y, w: cw, h: ch, row: r, col: c });
    }
    if (row.length) rowsOut.push(row);
  }
  if (order === 'columns') return byColumns(rects);
  return { rects, rows: rowsOut };
}

function byColumns(rects) {
  const cols = new Map();
  for (const r of rects) { if (!cols.has(r.col)) cols.set(r.col, []); cols.get(r.col).push(r); }
  const keys = [...cols.keys()].sort((a, b) => a - b);
  const out = [], groups = [];
  for (const k of keys) {
    const g = [];
    for (const r of cols.get(k).sort((a, b) => a.row - b.row)) { g.push(out.length); out.push(r); }
    groups.push(g);
  }
  return { rects: out, rows: groups };
}

function isEmpty(mask, W, x, y, w, h) {
  for (let yy = y; yy < y + h; yy++) {
    const o = yy * W;
    for (let xx = x; xx < x + w; xx++) if (mask[o + xx]) return false;
  }
  return true;
}

function islandRects(boxes, rows, W, H, pad) {
  const rects = [], groups = [];
  for (const r of rows) {
    const g = [];
    for (const i of r.items) {
      const b = boxes[i];
      const x = Math.max(0, b.x0 - pad), y = Math.max(0, b.y0 - pad);
      const x1 = Math.min(W - 1, b.x1 + pad), y1 = Math.min(H - 1, b.y1 + pad);
      g.push(rects.length);
      rects.push({ x, y, w: x1 - x + 1, h: y1 - y + 1 });
    }
    groups.push(g);
  }
  return { rects, rows: groups };
}

// Main entry: returns { mode, rects:[{x,y,w,h}], rows:[[rectIndex]], grid, bg, note }
export function detect(imageData, opts = {}) {
  const o = { ...DEFAULT_SLICE, ...opts };
  const { data, width: W, height: H } = imageData;
  const bg = findBackground(data, W, H);
  const mask = buildMask(data, W, H, bg, o);

  if (o.mode === 'grid-count') {
    const g = { cw: Math.floor(W / Math.max(1, o.cols)), ch: Math.floor(H / Math.max(1, o.rows)), ox: 0, oy: 0, sx: 0, sy: 0 };
    const res = gridRects(W, H, g, mask, o.skipEmpty, o.order);
    return { mode: 'grid', ...res, grid: { ...g, cols: o.cols, rows: o.rows }, bg, mask, note: `${o.cols} × ${o.rows} grid, ${g.cw}×${g.ch} px cells` };
  }
  if (o.mode === 'grid-size') {
    const g = { cw: o.cw, ch: o.ch, ox: o.ox, oy: o.oy, sx: o.sx, sy: o.sy };
    const res = gridRects(W, H, g, mask, o.skipEmpty, o.order);
    const cols = Math.floor((W - g.ox + g.sx) / (g.cw + g.sx)), rows = Math.floor((H - g.oy + g.sy) / (g.ch + g.sy));
    return { mode: 'grid', ...res, grid: { ...g, cols, rows }, bg, mask, note: `${g.cw}×${g.ch} px cells` };
  }

  const r = Math.max(0, o.gap | 0);
  let boxes = findIslands(r ? dilate(mask, W, H, Math.ceil(r / 2)) : mask, W, H, mask);
  const counts = boxes.map(b => b.count);
  const minPx = o.minPixels > 0 ? o.minPixels : Math.max(2, Math.floor(median(counts) * 0.01));
  boxes = boxes.filter(b => b.count >= minPx);
  const rows = groupRows(boxes);

  if (o.mode === 'auto') {
    const big = boxes.length === 1 && (boxes[0].x1 - boxes[0].x0 + 1) * (boxes[0].y1 - boxes[0].y0 + 1) > W * H * 0.8;
    if (big || boxes.length === 0) {
      const g = guessTouchingGrid(data, W, H);
      if (g) {
        const gg = { ...g, ox: 0, oy: 0, sx: 0, sy: 0 };
        const res = gridRects(W, H, gg, mask, o.skipEmpty, o.order);
        return { mode: 'grid', ...res, grid: gg, bg, mask, note: `Guessed ${g.cols} × ${g.rows} grid of ${g.cw}×${g.ch} px` };
      }
      return { mode: 'grid', rects: [{ x: 0, y: 0, w: W, h: H }], rows: [[0]], grid: { cols: 1, rows: 1, cw: W, ch: H, ox: 0, oy: 0, sx: 0, sy: 0 }, bg, mask, note: 'One frame (no separate sprites found)' };
    }
    const g = inferGrid(boxes, W, H);
    if (g) {
      const res = gridRects(W, H, g, mask, o.skipEmpty, o.order);
      return { mode: 'grid', ...res, grid: g, bg, mask, note: `Found a ${g.cols} × ${g.rows} grid of ${g.cw}×${g.ch} px cells` };
    }
  }
  const res = islandRects(boxes, rows, W, H, Math.max(0, o.pad | 0));
  return { mode: 'islands', ...res, grid: null, bg, mask, note: `Found ${res.rects.length} separate sprites in ${res.rows.length} rows` };
}

// ---------- background removal ----------
// Only background that is connected to the edge of the image is removed, so
// enclosed areas of the same colour (white eyes on a white sheet) survive.
// hard: pixels close to the colour become transparent.
// soft: "colour to alpha", so anti-aliased and blurry edges keep a smooth fade.
export function removeBackground(imgData, color, mode, tol = 32) {
  const { data: d, width: w, height: h } = imgData, n = w * h;
  const bgv = color;
  const alpha = new Float32Array(n);
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    let a = 0;
    for (let c = 0; c < 3; c++) {
      const v = d[p + c], b = bgv[c];
      const ac = v > b ? (v - b) / Math.max(1, 255 - b) : v < b ? (b - v) / Math.max(1, b) : 0;
      if (ac > a) a = ac;
    }
    alpha[i] = a;
  }
  const t = tol / 255;
  const passable = mode === 'hard' ? (i) => alpha[i] <= t : (i) => alpha[i] < 0.5;
  // flood fill from the border through background-like pixels
  const reach = new Uint8Array(n);
  const stack = [];
  const seed = (i) => { if (!reach[i] && passable(i)) { reach[i] = 1; stack.push(i); } };
  for (let x = 0; x < w; x++) { seed(x); seed((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { seed(y * w); seed(y * w + w - 1); }
  while (stack.length) {
    const i = stack.pop(), x = i % w;
    if (x > 0) seed(i - 1);
    if (x < w - 1) seed(i + 1);
    if (i >= w) seed(i - w);
    if (i < n - w) seed(i + w);
  }
  // soft mode also fades the few pixels of blurry edge just inside the reached area
  const region = mode === 'hard' ? reach : dilate(reach, w, h, 4);
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    if (!region[i]) continue;
    if (mode === 'hard') { d[p + 3] = 0; continue; }
    const a = alpha[i];
    if (a < 0.02) { d[p + 3] = 0; continue; }
    for (let c = 0; c < 3; c++) {
      const v = (d[p + c] - bgv[c]) / a + bgv[c];
      d[p + c] = v < 0 ? 0 : v > 255 ? 255 : v;
    }
    d[p + 3] = Math.round(d[p + 3] * a);
  }
  return imgData;
}
