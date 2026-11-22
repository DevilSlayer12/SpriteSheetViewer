// Generates a small pixel-art goblin slime sheet: 8 columns × 3 rows of 32×32.
export function makeDemoSheet() {
  const C = 32, COLS = 8, ROWS = 3;
  const cv = document.createElement('canvas');
  cv.width = C * COLS; cv.height = C * ROWS;
  const ctx = cv.getContext('2d');
  const img = ctx.createImageData(cv.width, cv.height);
  const put = (x, y, rgb) => {
    if (x < 0 || y < 0 || x >= cv.width || y >= cv.height) return;
    const p = (y * cv.width + x) * 4;
    img.data[p] = rgb[0]; img.data[p + 1] = rgb[1]; img.data[p + 2] = rgb[2]; img.data[p + 3] = 255;
  };
  const OUT = [28, 52, 24], BODY = [104, 196, 72], LIGHT = [170, 236, 120], DARK = [70, 150, 52], WHITE = [250, 250, 240], BLACK = [16, 20, 16], MOUTH = [60, 24, 30];

  const hop = [0, 0, 4, 9, 11, 9, 4, 0];
  const hopSq = [1.28, 1.1, 0.88, 0.9, 0.95, 0.9, 0.9, 1.22];

  for (let row = 0; row < ROWS; row++) {
    for (let i = 0; i < COLS; i++) {
      const ox = i * C, oy = row * C;
      let sq = 1, lift = 0, blink = false, look = 0;
      if (row === 0) sq = 1 + 0.09 * Math.sin((i / COLS) * Math.PI * 2);
      if (row === 1) { sq = hopSq[i]; lift = hop[i]; }
      if (row === 2) { blink = i === 3 || i === 4; look = i < 3 ? -1 : i > 4 ? 1 : 0; }
      const rx = 8.6 * sq, ry = 8.2 / sq;
      const cx = 15.5, base = 30 - lift, cy = base - ry;
      const inside = (x, y) => ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1;
      const ear = (x, y, s) => { // pointy goblin ears
        const ex = cx + s * (rx - 1.5), ey = cy - ry * 0.35;
        const dx = (x - ex) * s, dy = y - ey;
        return dx >= -1 && dx <= 4 && dy <= 1.5 - dx * 0.25 && dy >= -1.5 + dx * 0.55 - 0.5;
      };
      const shape = (x, y) => inside(x, y) || ear(x, y, 1) || ear(x, y, -1);
      for (let y = 0; y < C; y++) for (let x = 0; x < C; x++) {
        const px = x + 0.5, py = y + 0.5;
        if (!shape(px, py)) continue;
        const edge = !shape(px - 1, py) || !shape(px + 1, py) || !shape(px, py - 1) || !shape(px, py + 1);
        let col = BODY;
        if (edge) col = OUT;
        else if (((px - cx + 3) / rx) ** 2 + ((py - cy + 3) / ry) ** 2 < 0.18) col = LIGHT;
        else if (py > cy + ry * 0.45) col = DARK;
        put(ox + x, oy + y, col);
      }
      // eyes
      const ey = Math.round(cy - 1), e1 = Math.round(cx - 4), e2 = Math.round(cx + 3);
      for (const ex of [e1, e2]) {
        if (blink) { put(ox + ex, oy + ey + 1, BLACK); put(ox + ex + 1, oy + ey + 1, BLACK); continue; }
        for (let yy = 0; yy < 3; yy++) for (let xx = 0; xx < 2; xx++) put(ox + ex + xx, oy + ey + yy, WHITE);
        put(ox + ex + (look > 0 ? 1 : 0), oy + ey + 1, BLACK);
        put(ox + ex + (look > 0 ? 1 : 0), oy + ey + 2, BLACK);
      }
      // grin
      const my = ey + 4;
      for (let xx = -2; xx <= 2; xx++) put(ox + Math.round(cx) + xx, oy + my + (Math.abs(xx) === 2 ? -1 : 0), MOUTH);
      put(ox + Math.round(cx) - 1, oy + my + 1, WHITE);
    }
  }
  ctx.putImageData(img, 0, 0);
  return cv;
}
