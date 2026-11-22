// Animation model + rendering shared by the stage and the exporters.

let _id = 0;
export const uid = (p = 'id') => `${p}${Date.now().toString(36)}${(_id++).toString(36)}`;

export const ITEM_DEFAULTS = { hold: 1, dx: 0, dy: 0, sx: 1, sy: 1, rot: 0, flipX: false, flipY: false, alpha: 1, tween: false };

export function makeItem(frameId, extra = {}) {
  return { id: uid('it'), frameId, ...ITEM_DEFAULTS, ...extra };
}

export function makeAnim(name, items = [], extra = {}) {
  return { id: uid('an'), name, fps: 10, mode: 'loop', anchor: 'bottom', items, ...extra };
}

export function cellSize(anim, frames) {
  let w = 0, h = 0;
  for (const it of anim.items) {
    const f = frames.get(it.frameId);
    if (f) { w = Math.max(w, f.w); h = Math.max(h, f.h); }
  }
  return { w: w || 32, h: h || 32 };
}

export function placement(frame, cell, anchor) {
  const fx = Math.floor((cell.w - frame.w) / 2);
  if (anchor === 'center') return { fx, fy: Math.floor((cell.h - frame.h) / 2) };
  if (anchor === 'topleft') return { fx: 0, fy: 0 };
  return { fx, fy: cell.h - frame.h }; // bottom
}

// One tick per "hold" step of every item.
export function ticks(anim) {
  const out = [];
  anim.items.forEach((it, i) => {
    const n = Math.max(1, it.hold | 0);
    for (let t = 0; t < n; t++) out.push({ i, t, n });
  });
  return out;
}

// Ticks in playback order (handles ping-pong).
export function sequence(anim) {
  const t = ticks(anim);
  if (anim.mode === 'pingpong' && t.length > 2) return t.concat(t.slice(1, -1).reverse());
  return t;
}

const lerp = (a, b, f) => a + (b - a) * f;

export function transformAt(anim, tick) {
  const it = anim.items[tick.i];
  if (!it) return ITEM_DEFAULTS;
  if (!it.tween || tick.n <= 1 || tick.t === 0) return it;
  const nx = anim.items[tick.i + 1] ?? (anim.mode === 'once' ? null : anim.items[0]);
  if (!nx) return it;
  const f = tick.t / tick.n;
  return { ...it, dx: lerp(it.dx, nx.dx, f), dy: lerp(it.dy, nx.dy, f), sx: lerp(it.sx, nx.sx, f), sy: lerp(it.sy, nx.sy, f), rot: lerp(it.rot, nx.rot, f), alpha: lerp(it.alpha, nx.alpha, f) };
}

// Draw a frame with its transform. (ox, oy) = screen position of the cell's top-left, z = zoom.
export function drawItem(ctx, frame, tr, cell, anchor, ox, oy, z) {
  const { fx, fy } = placement(frame, cell, anchor);
  const cx = ox + (fx + frame.w / 2 + Math.round(tr.dx)) * z;
  const cy = oy + (fy + frame.h / 2 + Math.round(tr.dy)) * z;
  ctx.save();
  ctx.translate(cx, cy);
  if (tr.rot) ctx.rotate(tr.rot * Math.PI / 180);
  ctx.scale((tr.flipX ? -1 : 1) * tr.sx * z, (tr.flipY ? -1 : 1) * tr.sy * z);
  ctx.globalAlpha *= Math.max(0, Math.min(1, tr.alpha));
  ctx.drawImage(frame.canvas, -frame.w / 2, -frame.h / 2);
  ctx.restore();
}

export function itemBounds(frame, tr, cell, anchor) {
  const { fx, fy } = placement(frame, cell, anchor);
  const cx = fx + frame.w / 2 + Math.round(tr.dx), cy = fy + frame.h / 2 + Math.round(tr.dy);
  const a = (tr.rot || 0) * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
  const hw = frame.w / 2 * Math.abs(tr.sx), hh = frame.h / 2 * Math.abs(tr.sy);
  const ex = Math.abs(c) * hw + Math.abs(s) * hh, ey = Math.abs(s) * hw + Math.abs(c) * hh;
  return { x0: cx - ex, y0: cy - ey, x1: cx + ex, y1: cy + ey };
}

export function animBounds(anim, frames) {
  const cell = cellSize(anim, frames);
  let b = { x0: 0, y0: 0, x1: cell.w, y1: cell.h };
  for (const tk of ticks(anim)) {
    const f = frames.get(anim.items[tk.i].frameId);
    if (!f) continue;
    const ib = itemBounds(f, transformAt(anim, tk), cell, anim.anchor);
    b = { x0: Math.min(b.x0, ib.x0), y0: Math.min(b.y0, ib.y0), x1: Math.max(b.x1, ib.x1), y1: Math.max(b.y1, ib.y1) };
  }
  b.x0 = Math.floor(b.x0); b.y0 = Math.floor(b.y0); b.x1 = Math.ceil(b.x1); b.y1 = Math.ceil(b.y1);
  return { ...b, w: b.x1 - b.x0, h: b.y1 - b.y0, cell };
}

// Render one tick to its own canvas (used by exports).
export function renderTick(anim, tick, frames, bounds, scale = 1, background = null) {
  const c = document.createElement('canvas');
  c.width = bounds.w * scale; c.height = bounds.h * scale;
  const ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  if (background) { ctx.fillStyle = background; ctx.fillRect(0, 0, c.width, c.height); }
  const it = anim.items[tick.i];
  const f = it && frames.get(it.frameId);
  if (f) drawItem(ctx, f, transformAt(anim, tick), bounds.cell, anim.anchor, -bounds.x0 * scale, -bounds.y0 * scale, scale);
  return c;
}
