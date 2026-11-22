import { detect, removeBackground, DEFAULT_SLICE } from './detect.js';
import { uid, makeItem, makeAnim, cellSize, placement, sequence, transformAt, drawItem, animBounds, renderTick, ITEM_DEFAULTS } from './anim.js';
import { encodeGIF } from './gif.js';
import { makeZip } from './zip.js';
import { makeDemoSheet } from './demo.js';
import * as store from './store.js';

const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// ---------------------------------------------------------------- state
const S = {
  sheets: [],            // { id, name, canvas, w, h, slice, note, bg }
  sheetId: null,
  frames: new Map(),     // id -> { id, name, w, h, canvas, sheetId, src, auto, edited }
  order: [],             // frame ids in library order
  anims: [],
  animId: null,
  step: 0,               // selected step index in current animation
  pos: 0,                // position in playback sequence
  playing: false, acc: 0, last: 0,
  view: 'anim',          // anim | frame
  viewFrameId: null,
  sel: new Set(), lastSel: null,
  zoom: 0, panX: 0, panY: 0,
  onion: false, grid: false, bounds: false, bg: 'checker',
  draw: { on: false, tool: 'pencil', color: '#000000', size: 1 },
  undo: [], redo: [],
  sheetScale: 0, sheetTool: 'pick', hover: null, boxDrag: null,
  stageDirty: true,
};

const anim = () => S.anims.find(a => a.id === S.animId) || null;
const sheet = () => S.sheets.find(s => s.id === S.sheetId) || null;
const frameOf = (id) => S.frames.get(id);

function newCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, w | 0); c.height = Math.max(1, h | 0);
  return c;
}
function ctx2d(c) { return c.getContext('2d', { willReadFrequently: true }); }
function copyCanvas(src) { const c = newCanvas(src.width, src.height); c.getContext('2d').drawImage(src, 0, 0); return c; }
function baseName(n) { return (n || 'sprite').replace(/\.[^.]+$/, '').replace(/[^\w\-]+/g, '_').slice(0, 40) || 'sprite'; }

// ---------------------------------------------------------------- toast
let toastT = 0;
function toast(msg, err = false) {
  const t = $('toast');
  t.textContent = msg; t.classList.toggle('err', err); t.classList.add('show');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), err ? 4200 : 2400);
}

// ---------------------------------------------------------------- loading images
async function fileToCanvas(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('Could not read image')); i.src = url; });
    const c = newCanvas(img.naturalWidth, img.naturalHeight);
    c.getContext('2d').drawImage(img, 0, 0);
    return c;
  } finally { URL.revokeObjectURL(url); }
}

function dataURLToCanvas(url) {
  return new Promise((res, rej) => {
    const i = new Image();
    i.onload = () => { const c = newCanvas(i.naturalWidth, i.naturalHeight); c.getContext('2d').drawImage(i, 0, 0); res(c); };
    i.onerror = () => rej(new Error('Bad image data'));
    i.src = url;
  });
}

async function handleFiles(files) {
  const list = [...files];
  let loaded = 0;
  for (const f of list) {
    if (/\.json$|\.ssv$/i.test(f.name) || f.type === 'application/json') { await loadProjectFile(f); continue; }
    if (!f.type.startsWith('image/') && !/\.(png|gif|webp|bmp|jpe?g|avif)$/i.test(f.name)) { toast(`Skipped ${f.name}: not an image`, true); continue; }
    try { addSheet(f.name, await fileToCanvas(f)); loaded++; }
    catch (e) { toast(`${f.name}: ${e.message}`, true); }
  }
  if (loaded) refreshAll();
}

// ---------------------------------------------------------------- sheets & slicing
function addSheet(name, canvas, slice = null) {
  const sh = { id: uid('sh'), name, canvas, w: canvas.width, h: canvas.height, slice: { ...DEFAULT_SLICE, ...(slice || {}) }, note: '', bg: null };
  S.sheets.push(sh);
  S.sheetId = sh.id;
  S.sheetScale = 0;
  sliceSheet(sh);
  const first = longestAnim(sh.id);
  if (first) selectAnim(first.id, true);
  S.view = 'anim';
  setPlaying(true);
  loadSliceUI(sh);
  toast(`${name}: ${sh.note}`);
  return sh;
}

function sliceSheet(sh) {
  const t0 = performance.now();
  const img = ctx2d(sh.canvas).getImageData(0, 0, sh.w, sh.h);
  const res = detect(img, sh.slice);
  sh.bg = res.bg;
  let rm = sh.slice.removeBg;
  if (rm === 'auto') rm = 'soft';
  if (res.bg.type !== 'color') rm = 'off';

  // remove previously auto-sliced frames of this sheet
  const old = new Set(S.order.filter(id => { const f = frameOf(id); return f.sheetId === sh.id && f.auto; }));
  let insertAt = S.order.findIndex(id => old.has(id));
  if (insertAt < 0) insertAt = S.order.length;
  S.order = S.order.filter(id => !old.has(id));
  for (const id of old) S.frames.delete(id);
  S.anims = S.anims.filter(a => !(a.sheetId === sh.id && a.auto));
  for (const a of S.anims) a.items = a.items.filter(it => S.frames.has(it.frameId));

  const base = baseName(sh.name);
  const ids = res.rects.map((r, i) => {
    const c = newCanvas(r.w, r.h);
    const cx = ctx2d(c);
    cx.drawImage(sh.canvas, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
    if (rm !== 'off') {
      const d = cx.getImageData(0, 0, r.w, r.h);
      removeBackground(d, res.bg.color, rm, sh.slice.tol);
      cx.putImageData(d, 0, 0);
    }
    const f = { id: uid('fr'), name: `${base}_${String(i).padStart(2, '0')}`, w: r.w, h: r.h, canvas: c, sheetId: sh.id, src: { x: r.x, y: r.y, w: r.w, h: r.h }, auto: true, edited: false };
    S.frames.set(f.id, f);
    return f.id;
  });
  S.order.splice(insertAt, 0, ...ids);

  const order = sh.slice.order;
  const newAnims = [];
  const anchor = res.mode === 'grid' ? 'center' : 'bottom';
  if (order === 'single' || (res.rows.length === 1 && order !== 'none')) {
    if (ids.length) newAnims.push(makeAnim(base, ids.map(id => makeItem(id)), { anchor }));
  } else if (order === 'rows' || order === 'columns') {
    res.rows.forEach((g, k) => {
      if (!g.length) return;
      newAnims.push(makeAnim(`${base} ${order === 'columns' ? 'col' : 'row'} ${k + 1}`, g.map(i => makeItem(ids[i])), { anchor }));
    });
  }
  for (const a of newAnims) { a.sheetId = sh.id; a.auto = true; }
  S.anims.push(...newAnims);
  sh.note = res.note + (rm !== 'off' ? ', background removed' : '');
  sh.lastGrid = res.grid;
  if (!anim() && S.anims.length) S.animId = S.anims[0].id;
  S.sel.clear();
  console.debug(`sliced ${sh.name} in ${(performance.now() - t0).toFixed(0)} ms`);
  return res;
}

function longestAnim(sheetId) {
  let best = null;
  for (const a of S.anims) if (a.sheetId === sheetId && (!best || a.items.length > best.items.length)) best = a;
  return best;
}

function reslice() {
  const sh = sheet();
  if (!sh) return;
  const edited = S.order.some(id => { const f = frameOf(id); return f.sheetId === sh.id && f.auto && f.edited; });
  if (edited && !window.confirm('Re-slicing replaces the frames from this sheet, including pixels you drew on them. Continue?')) return;
  readSliceUI(sh);
  const prevAnimSheet = anim()?.sheetId === sh.id;
  sliceSheet(sh);
  if (prevAnimSheet || !anim()) {
    const first = longestAnim(sh.id) || S.anims[0];
    if (first) selectAnim(first.id, true); else S.animId = null;
  }
  S.zoom = 0; S.panX = S.panY = 0;
  if (S.view === 'frame' && !frameOf(S.viewFrameId)) S.view = 'anim';
  $('sliceNote').textContent = sh.note;
  fillGridFields(sh);
  refreshAll();
}

function removeSheet() {
  const sh = sheet();
  if (!sh) return;
  const ids = new Set(S.order.filter(id => frameOf(id).sheetId === sh.id));
  S.order = S.order.filter(id => !ids.has(id));
  for (const id of ids) S.frames.delete(id);
  S.anims = S.anims.filter(a => a.sheetId !== sh.id);
  for (const a of S.anims) a.items = a.items.filter(it => S.frames.has(it.frameId));
  S.sheets = S.sheets.filter(s => s !== sh);
  S.sheetId = S.sheets[0]?.id || null;
  if (!anim()) S.animId = S.anims[0]?.id || null;
  S.sel.clear();
  if (sheet()) loadSliceUI(sheet());
  refreshAll();
}

// slicing UI <-> sheet.slice
const SL = { mode: 'slMode', cols: 'slCols', rows: 'slRows', cw: 'slCw', ch: 'slCh', ox: 'slOx', oy: 'slOy', sx: 'slSx', sy: 'slSy', gap: 'slGap', pad: 'slPad', alphaMin: 'slAlpha', tol: 'slTol', removeBg: 'slRemoveBg', order: 'slOrder' };
function loadSliceUI(sh) {
  for (const [k, id] of Object.entries(SL)) $(id).value = sh.slice[k];
  $('slSkip').checked = !!sh.slice.skipEmpty;
  fillGridFields(sh);
  showSliceFields();
  $('sliceNote').textContent = sh.note;
}
function readSliceUI(sh) {
  for (const [k, id] of Object.entries(SL)) {
    const el = $(id);
    sh.slice[k] = el.type === 'number' ? Number(el.value) || 0 : el.value;
  }
  sh.slice.skipEmpty = $('slSkip').checked;
}
function fillGridFields(sh) {
  const g = sh.lastGrid;
  if (!g || sh.slice.mode.startsWith('grid')) return;
  $('slCols').value = g.cols; $('slRows').value = g.rows;
  $('slCw').value = g.cw; $('slCh').value = g.ch;
}
function showSliceFields() {
  const m = $('slMode').value;
  document.querySelectorAll('.fields[data-for]').forEach(el => { el.hidden = !el.dataset.for.split(' ').includes(m); });
}

// ---------------------------------------------------------------- frames
function addFrame(canvas, name, extra = {}) {
  const f = { id: uid('fr'), name, w: canvas.width, h: canvas.height, canvas, sheetId: null, src: null, auto: false, edited: false, ...extra };
  S.frames.set(f.id, f);
  return f;
}

function selectedFrames() { return S.order.filter(id => S.sel.has(id)); }

function selectFrame(id, ev = {}) {
  if (ev.shiftKey && S.lastSel && S.order.includes(S.lastSel)) {
    const a = S.order.indexOf(S.lastSel), b = S.order.indexOf(id);
    for (let i = Math.min(a, b); i <= Math.max(a, b); i++) S.sel.add(S.order[i]);
  } else if (ev.ctrlKey || ev.metaKey) {
    if (S.sel.has(id)) S.sel.delete(id); else S.sel.add(id);
  } else {
    S.sel.clear(); S.sel.add(id);
  }
  S.lastSel = id;
  S.viewFrameId = id;
  const f = frameOf(id);
  if (f?.sheetId && f.sheetId !== S.sheetId) { S.sheetId = f.sheetId; loadSliceUI(sheet()); }
  S.stageDirty = true;
}

function viewFrame(id) {
  if (!frameOf(id)) return;
  S.viewFrameId = id;
  setView('frame');
}

function addFramesToAnim(ids) {
  if (!ids.length) return;
  let a = anim();
  if (!a) {
    a = makeAnim(`Animation ${S.anims.length + 1}`);
    S.anims.push(a); S.animId = a.id;
  }
  const at = a.items.length;
  a.items.push(...ids.map(id => makeItem(id)));
  S.step = at + ids.length - 1;
  syncPosToStep();
  if (S.view !== 'anim') setView('anim');
  changed();
  toast(`Added ${ids.length} frame${ids.length > 1 ? 's' : ''} to "${a.name}"`);
}

function deleteFrames(ids) {
  if (!ids.length) return;
  const set = new Set(ids);
  S.order = S.order.filter(id => !set.has(id));
  for (const id of set) S.frames.delete(id);
  for (const a of S.anims) a.items = a.items.filter(it => !set.has(it.frameId));
  S.sel.clear();
  if (!frameOf(S.viewFrameId)) { S.viewFrameId = S.order[0] || null; if (!S.viewFrameId && S.view === 'frame') S.view = 'anim'; }
  clampStep();
  changed();
}

function duplicateFrames(ids) {
  const made = [];
  for (const id of ids) {
    const f = frameOf(id);
    const n = addFrame(copyCanvas(f.canvas), `${f.name}_copy`, { sheetId: f.sheetId, src: f.src ? { ...f.src } : null });
    S.order.splice(S.order.indexOf(id) + 1 + made.length, 0, n.id);
    made.push(n.id);
  }
  S.sel = new Set(made);
  changed();
  return made;
}

function mergeFrames(ids) {
  const fr = ids.map(frameOf);
  if (fr.length < 2) return toast('Select two or more frames to merge (Ctrl+click)', true);
  if (fr.some(f => !f.src) || new Set(fr.map(f => f.sheetId)).size > 1) return toast('Only frames cut from the same sheet can be merged', true);
  const x0 = Math.min(...fr.map(f => f.src.x)), y0 = Math.min(...fr.map(f => f.src.y));
  const x1 = Math.max(...fr.map(f => f.src.x + f.src.w)), y1 = Math.max(...fr.map(f => f.src.y + f.src.h));
  const c = newCanvas(x1 - x0, y1 - y0), cx = c.getContext('2d');
  for (const f of fr) cx.drawImage(f.canvas, f.src.x - x0, f.src.y - y0);
  const n = addFrame(c, fr[0].name, { sheetId: fr[0].sheetId, src: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } });
  const first = fr[0].id, rest = new Set(fr.slice(1).map(f => f.id));
  for (const a of S.anims) {
    a.items = a.items.filter(it => !rest.has(it.frameId));
    for (const it of a.items) if (it.frameId === first) it.frameId = n.id;
  }
  S.order.splice(S.order.indexOf(first), 1, n.id);
  S.order = S.order.filter(id => !rest.has(id));
  S.frames.delete(first); for (const id of rest) S.frames.delete(id);
  S.sel = new Set([n.id]); S.viewFrameId = n.id;
  clampStep();
  changed();
  toast(`Merged ${fr.length} frames`);
}

function newBlankFrame() {
  const a = anim();
  const ref = frameOf(S.viewFrameId) || (a && frameOf(a.items[S.step]?.frameId));
  const w = ref?.w || 32, h = ref?.h || 32;
  const f = addFrame(newCanvas(w, h), `frame_${S.order.length}`);
  S.order.push(f.id);
  S.sel = new Set([f.id]); S.lastSel = f.id;
  viewFrame(f.id);
  setDraw(true);
  changed();
}

// ---------------------------------------------------------------- animations
function selectAnim(id, quiet = false) {
  S.animId = id;
  S.step = 0; S.pos = 0; S.acc = 0;
  S.zoom = 0; S.panX = S.panY = 0;
  S.stageDirty = true;
  if (!quiet) refreshAll();
}
function clampStep() {
  const a = anim();
  S.step = a ? clamp(S.step, 0, Math.max(0, a.items.length - 1)) : 0;
  syncPosToStep();
}
function syncPosToStep() {
  const a = anim();
  if (!a) { S.pos = 0; return; }
  const seq = sequence(a);
  const k = seq.findIndex(t => t.i === S.step);
  S.pos = k < 0 ? 0 : k;
  S.acc = 0;
  S.stageDirty = true;
}
function currentTick() {
  const a = anim();
  if (!a || !a.items.length) return null;
  const seq = sequence(a);
  return seq[clamp(S.pos, 0, seq.length - 1)];
}

// ---------------------------------------------------------------- change tracking & autosave
let saveT = 0;
function changed(ui = true) {
  S.stageDirty = true;
  if (ui) refreshAll();
  clearTimeout(saveT);
  saveT = setTimeout(autosave, 1500);
}
async function autosave() {
  if (!S.frames.size && !S.sheets.length) return;
  try { await store.put('project', JSON.stringify(serialize())); } catch { /* storage full: skip */ }
}

// ---------------------------------------------------------------- project save / load
function serialize() {
  return {
    app: 'SpriteSheetViewer', version: 1, savedAt: new Date().toISOString(),
    sheets: S.sheets.map(s => ({ id: s.id, name: s.name, slice: s.slice, note: s.note, data: s.canvas.toDataURL('image/png') })),
    frames: S.order.map(id => { const f = frameOf(id); return { id: f.id, name: f.name, sheetId: f.sheetId, src: f.src, auto: f.auto, edited: f.edited, data: f.canvas.toDataURL('image/png') }; }),
    anims: S.anims,
    animId: S.animId,
  };
}

async function loadProject(p) {
  if (!p || p.app !== 'SpriteSheetViewer') throw new Error('Not a SpriteSheetViewer project');
  const sheets = [];
  for (const s of p.sheets || []) {
    const c = await dataURLToCanvas(s.data);
    sheets.push({ id: s.id, name: s.name, canvas: c, w: c.width, h: c.height, slice: { ...DEFAULT_SLICE, ...s.slice }, note: s.note || '', bg: null });
  }
  const frames = new Map(), order = [];
  for (const f of p.frames || []) {
    const c = await dataURLToCanvas(f.data);
    frames.set(f.id, { ...f, data: undefined, canvas: c, w: c.width, h: c.height });
    order.push(f.id);
  }
  S.sheets = sheets; S.frames = frames; S.order = order;
  S.anims = (p.anims || []).map(a => ({ ...a, items: a.items.map(it => ({ ...ITEM_DEFAULTS, ...it })).filter(it => frames.has(it.frameId)) }));
  S.animId = S.anims.find(a => a.id === p.animId)?.id || S.anims[0]?.id || null;
  S.sheetId = sheets[0]?.id || null;
  S.sel.clear(); S.undo = []; S.redo = [];
  S.step = 0; S.pos = 0; S.view = 'anim'; S.zoom = 0; S.panX = S.panY = 0;
  if (sheet()) loadSliceUI(sheet());
  setPlaying(true);
  refreshAll();
}

async function loadProjectFile(file) {
  try { await loadProject(JSON.parse(await file.text())); toast(`Opened ${file.name}`); }
  catch (e) { toast(`Could not open project: ${e.message}`, true); }
}

// ---------------------------------------------------------------- downloads
function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
const canvasBlob = (c) => new Promise(res => c.toBlob(res, 'image/png'));
async function canvasBytes(c) { return new Uint8Array(await (await canvasBlob(c)).arrayBuffer()); }
function scaled(src, k) {
  if (k === 1) return src;
  const c = newCanvas(src.width * k, src.height * k), x = c.getContext('2d');
  x.imageSmoothingEnabled = false; x.drawImage(src, 0, 0, c.width, c.height);
  return c;
}
const exScale = () => Number($('exScale').value) || 1;
const safe = (n) => (n || 'untitled').replace(/[^\w\- ]+/g, '_').trim().replace(/\s+/g, '_') || 'untitled';

async function downloadFrames(ids) {
  if (!ids.length) return toast('Select a frame first', true);
  const k = exScale();
  if (ids.length === 1) {
    const f = frameOf(ids[0]);
    download(await canvasBlob(scaled(f.canvas, k)), `${safe(f.name)}${k > 1 ? `@${k}x` : ''}.png`);
    return;
  }
  const files = [];
  const used = new Set();
  for (const id of ids) {
    const f = frameOf(id);
    let n = safe(f.name), j = 1;
    while (used.has(n)) n = `${safe(f.name)}_${j++}`;
    used.add(n);
    files.push({ name: `${n}.png`, data: await canvasBytes(scaled(f.canvas, k)) });
  }
  download(makeZip(files), `frames_${ids.length}.zip`);
  toast(`Downloaded ${ids.length} frames as ZIP`);
}

function needAnim() {
  const a = anim();
  if (!a || !a.items.length) { toast('Make an animation with at least one frame first', true); return null; }
  return a;
}

async function exportGif() {
  const a = needAnim(); if (!a) return;
  const k = exScale(), bg = $('exBg').value || null;
  const b = animBounds(a, S.frames);
  if (b.w * k * b.h * k > 2048 * 2048) toast('Large GIF, this can take a moment...');
  const seq = sequence(a);
  const ms = 1000 / (a.fps || 10);
  const raw = [];
  for (let n = 0; n < seq.length; n++) {
    const tk = seq[n], it = a.items[tk.i];
    const prev = raw[raw.length - 1];
    if (prev && prev.i === tk.i && !it.tween) { prev.ms += ms; continue; }
    const c = renderTick(a, tk, S.frames, b, k, bg);
    raw.push({ i: tk.i, ms, data: c.getContext('2d').getImageData(0, 0, c.width, c.height).data });
  }
  let total = 0, emitted = 0;
  const frames = raw.map(r => { total += r.ms; const cs = Math.round(total / 10) - emitted; emitted += cs; return { data: r.data, delay: Math.max(2, cs) }; });
  await new Promise(r => setTimeout(r, 20));
  const blob = encodeGIF(frames, b.w * k, b.h * k, { loop: a.mode !== 'once' });
  download(blob, `${safe(a.name)}.gif`);
  toast(`GIF saved (${frames.length} frames, ${(blob.size / 1024).toFixed(0)} KB)`);
}

function renderStepCanvas(a, i, b, k) {
  return renderTick(a, { i, t: 0, n: 1 }, S.frames, b, k, null);
}

async function exportStrip() {
  const a = needAnim(); if (!a) return;
  const k = exScale(), b = animBounds(a, S.frames);
  const out = newCanvas(b.w * k * a.items.length, b.h * k), x = out.getContext('2d');
  a.items.forEach((_, i) => x.drawImage(renderStepCanvas(a, i, b, k), i * b.w * k, 0));
  download(await canvasBlob(out), `${safe(a.name)}_strip.png`);
}

async function exportAnimFrames() {
  const a = needAnim(); if (!a) return;
  const k = exScale(), b = animBounds(a, S.frames);
  const files = [];
  for (let i = 0; i < a.items.length; i++) files.push({ name: `${safe(a.name)}_${String(i).padStart(2, '0')}.png`, data: await canvasBytes(renderStepCanvas(a, i, b, k)) });
  download(makeZip(files), `${safe(a.name)}_frames.zip`);
}

async function exportSheet() {
  const list = S.anims.filter(a => a.items.length);
  if (!list.length) return toast('No animations to export yet', true);
  const k = exScale();
  const bs = list.map(a => animBounds(a, S.frames));
  // each animation is one row with its own cell size
  const rowY = [];
  let y = 0, width = 0;
  list.forEach((a, r) => { rowY.push(y); y += bs[r].h * k; width = Math.max(width, bs[r].w * k * a.items.length); });
  const out = newCanvas(width, y), x = out.getContext('2d');
  const json = { frames: {}, animations: {}, meta: { app: 'SpriteSheetViewer', image: 'spritesheet.png', size: { w: out.width, h: out.height }, scale: k, frameRate: {} } };
  list.forEach((a, r) => {
    const b = bs[r], cw = b.w * k, ch = b.h * k, keys = [];
    a.items.forEach((it, i) => {
      x.drawImage(renderStepCanvas(a, i, b, k), i * cw, rowY[r]);
      const key = `${safe(a.name)}_${String(i).padStart(2, '0')}`;
      json.frames[key] = { frame: { x: i * cw, y: rowY[r], w: cw, h: ch }, duration: Math.round(1000 / a.fps * Math.max(1, it.hold)) };
      keys.push(key);
    });
    json.animations[a.name] = keys;
    json.meta.frameRate[a.name] = a.fps;
  });
  const enc = new TextEncoder();
  download(makeZip([
    { name: 'spritesheet.png', data: await canvasBytes(out) },
    { name: 'spritesheet.json', data: enc.encode(JSON.stringify(json, null, 2)) },
  ]), 'spritesheet.zip');
  toast(`Sprite sheet: ${list.length} animation${list.length > 1 ? 's' : ''}, ${out.width}×${out.height} px`);
}

async function exportWebm() {
  const a = needAnim(); if (!a) return;
  if (!window.MediaRecorder || !HTMLCanvasElement.prototype.captureStream) return toast('Video export is not supported in this browser', true);
  const k = Math.max(exScale(), 2), b = animBounds(a, S.frames);
  const c = newCanvas(b.w * k + (b.w * k) % 2, b.h * k + (b.h * k) % 2), x = c.getContext('2d');
  x.imageSmoothingEnabled = false;
  const bg = $('exBg').value || '#14161c';
  const seq = sequence(a), ms = 1000 / a.fps;
  const loops = Math.max(1, Math.ceil(2000 / (seq.length * ms)));
  const mime = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find(m => MediaRecorder.isTypeSupported(m));
  const rec = new MediaRecorder(c.captureStream(Math.min(60, a.fps * 2)), mime ? { mimeType: mime } : {});
  const chunks = [];
  rec.ondataavailable = e => e.data.size && chunks.push(e.data);
  const done = new Promise(r => rec.onstop = r);
  toast(`Recording video (${((loops * seq.length * ms) / 1000).toFixed(1)} s)...`);
  rec.start();
  for (let l = 0; l < loops; l++) for (const tk of seq) {
    x.fillStyle = bg; x.fillRect(0, 0, c.width, c.height);
    x.drawImage(renderTick(a, tk, S.frames, b, k, null), 0, 0);
    await new Promise(r => setTimeout(r, ms));
  }
  rec.stop(); await done;
  download(new Blob(chunks, { type: 'video/webm' }), `${safe(a.name)}.webm`);
}

// ---------------------------------------------------------------- stage rendering
const stage = $('stage');
const sctx = stage.getContext('2d');
let checkerPat = null;
function checker() {
  if (checkerPat) return checkerPat;
  const c = newCanvas(16, 16), x = c.getContext('2d');
  x.fillStyle = '#2a2f3a'; x.fillRect(0, 0, 16, 16);
  x.fillStyle = '#343a47'; x.fillRect(0, 0, 8, 8); x.fillRect(8, 8, 8, 8);
  return (checkerPat = sctx.createPattern(c, 'repeat'));
}

function resizeStage() {
  const r = stage.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
  stage.width = Math.max(1, Math.round(r.width * dpr)); stage.height = Math.max(1, Math.round(r.height * dpr));
  S.stageDirty = true;
}
new ResizeObserver(resizeStage).observe($('stageWrap'));

// What is on stage and where. Returns null when nothing to show.
function layout() {
  const W = stage.width / (window.devicePixelRatio || 1), H = stage.height / (window.devicePixelRatio || 1);
  let b, kind, frame = null, a = null;
  if (S.view === 'frame') {
    frame = frameOf(S.viewFrameId);
    if (!frame) return null;
    b = { x0: 0, y0: 0, w: frame.w, h: frame.h, cell: { w: frame.w, h: frame.h } };
    kind = 'frame';
  } else {
    a = anim();
    if (!a || !a.items.length) return null;
    b = animBounds(a, S.frames);
    kind = 'anim';
  }
  let z = S.zoom;
  const fit = Math.min((W - 48) / b.w, (H - 48) / b.h);
  const zf = fit >= 1 ? Math.min(64, Math.floor(fit)) : Math.max(0.05, fit);
  if (!z) z = zf;
  const ox = Math.round(W / 2 - (b.w * z) / 2 + S.panX), oy = Math.round(H / 2 - (b.h * z) / 2 + S.panY);
  // cellX/Y: screen position of the cell's (0,0)
  return { W, H, b, z, zf, kind, frame, a, cellX: ox - b.x0 * z, cellY: oy - b.y0 * z, ox, oy };
}

// The frame being drawn on, with its screen-space top-left.
function drawTarget(L) {
  if (!L) return null;
  if (L.kind === 'frame') return { frame: L.frame, x: L.cellX, y: L.cellY };
  const it = L.a.items[S.step];
  const f = it && frameOf(it.frameId);
  if (!f) return null;
  const p = placement(f, L.b.cell, L.a.anchor);
  return { frame: f, x: L.cellX + p.fx * L.z, y: L.cellY + p.fy * L.z };
}

function renderStage() {
  const dpr = window.devicePixelRatio || 1;
  sctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const L = layout();
  const W = stage.width / dpr, H = stage.height / dpr;
  sctx.fillStyle = S.bg === 'checker' ? checker() : S.bg;
  sctx.fillRect(0, 0, W, H);
  $('empty').hidden = !!(S.frames.size || S.sheets.length);
  if (!L) {
    $('zoomLabel').textContent = 'Fit';
    if (S.frames.size) {
      sctx.fillStyle = '#8d96a8'; sctx.font = '14px system-ui'; sctx.textAlign = 'center';
      sctx.fillText(S.view === 'frame' ? 'Select a frame to view it' : 'This animation is empty: double-click frames to add them', W / 2, H / 2);
    }
    return;
  }
  sctx.imageSmoothingEnabled = L.z < 1;
  $('zoomLabel').textContent = S.zoom ? `${fmtZoom(L.z)}×` : `Fit ${fmtZoom(L.z)}×`;
  const editing = S.draw.on;

  if (L.kind === 'frame') {
    sctx.drawImage(L.frame.canvas, L.cellX, L.cellY, L.frame.w * L.z, L.frame.h * L.z);
    if (S.bounds || editing) outline(L.cellX, L.cellY, L.frame.w * L.z, L.frame.h * L.z, '#7aa2ffaa');
    if ((S.grid || editing) && L.z >= 6) pixelGrid(L.cellX, L.cellY, L.frame.w, L.frame.h, L.z);
  } else {
    const a = L.a, cell = L.b.cell;
    if (editing) {
      if (S.onion) onionSteps(L, a, false);
      const t = drawTarget(L);
      if (t) {
        drawItem(sctx, t.frame, ITEM_DEFAULTS, cell, a.anchor, L.cellX, L.cellY, L.z);
        outline(t.x, t.y, t.frame.w * L.z, t.frame.h * L.z, '#7aa2ffaa');
        if (L.z >= 6) pixelGrid(t.x, t.y, t.frame.w, t.frame.h, L.z);
      }
    } else {
      const tk = currentTick();
      if (S.onion && !S.playing) onionSteps(L, a, true);
      if (tk) {
        const f = frameOf(a.items[tk.i].frameId);
        if (f) drawItem(sctx, f, transformAt(a, tk), cell, a.anchor, L.cellX, L.cellY, L.z);
        if (S.grid && L.z >= 6) pixelGrid(L.ox, L.oy, L.b.w, L.b.h, L.z);
      }
    }
    if (S.bounds) {
      outline(L.cellX, L.cellY, cell.w * L.z, cell.h * L.z, '#b4f46199');
      outline(L.ox, L.oy, L.b.w * L.z, L.b.h * L.z, '#ffffff33');
    }
  }
}

function onionSteps(L, a, withTransforms) {
  const n = a.items.length;
  if (n < 2) return;
  const cur = withTransforms ? (currentTick()?.i ?? S.step) : S.step;
  const tint = [[cur - 1, '#ff5a5a'], [cur + 1, '#5ab4ff']];
  for (const [i, col] of tint) {
    const it = a.items[(i + n) % n];
    const f = it && frameOf(it.frameId);
    if (!f) continue;
    const tinted = tintCanvas(f.canvas, col);
    const fake = { ...f, canvas: tinted };
    sctx.save(); sctx.globalAlpha = 0.28;
    drawItem(sctx, fake, withTransforms ? it : ITEM_DEFAULTS, L.b.cell, a.anchor, L.cellX, L.cellY, L.z);
    sctx.restore();
  }
}
const tintCache = new WeakMap();
function tintCanvas(src, col) {
  let m = tintCache.get(src);
  if (!m) { m = {}; tintCache.set(src, m); }
  const key = col + ':' + (src._v || 0);
  if (m[key]) return m[key];
  const c = copyCanvas(src), x = c.getContext('2d');
  x.globalCompositeOperation = 'source-atop'; x.fillStyle = col; x.globalAlpha = 0.6; x.fillRect(0, 0, c.width, c.height);
  return (m[key] = c);
}
function outline(x, y, w, h, col) {
  sctx.save(); sctx.strokeStyle = col; sctx.setLineDash([4, 3]); sctx.lineWidth = 1;
  sctx.strokeRect(Math.round(x) - 0.5, Math.round(y) - 0.5, Math.round(w) + 1, Math.round(h) + 1);
  sctx.restore();
}
function pixelGrid(x, y, w, h, z) {
  sctx.save(); sctx.strokeStyle = '#ffffff1c'; sctx.lineWidth = 1; sctx.beginPath();
  for (let i = 0; i <= w; i++) { const X = Math.round(x + i * z) + 0.5; sctx.moveTo(X, y); sctx.lineTo(X, y + h * z); }
  for (let j = 0; j <= h; j++) { const Y = Math.round(y + j * z) + 0.5; sctx.moveTo(x, Y); sctx.lineTo(x + w * z, Y); }
  sctx.stroke(); sctx.restore();
}
const fmtZoom = (z) => z >= 1 ? String(Math.round(z * 100) / 100) : z.toFixed(2);

// ---------------------------------------------------------------- playback loop
function setPlaying(on) {
  S.playing = on && !S.draw.on;
  $('pbPlay').textContent = S.playing ? '❚❚' : '▶';
  $('pbPlay').classList.toggle('on', S.playing);
  if (!S.playing) { const tk = currentTick(); if (tk) S.step = tk.i; }
  S.acc = 0; S.last = performance.now();
  S.stageDirty = true;
}

let lastPlayingStep = -1;
function loop(now) {
  const a = anim();
  if (S.playing && S.view === 'anim' && a && a.items.length) {
    const dt = Math.min(250, now - S.last);
    S.acc += dt;
    const ms = 1000 / clamp(a.fps || 10, 1, 120);
    const seq = sequence(a);
    while (S.acc >= ms) {
      S.acc -= ms;
      S.pos++;
      if (S.pos >= seq.length) {
        if (a.mode === 'once') { S.pos = seq.length - 1; setPlaying(false); renderSideForStep(); break; }
        S.pos = 0;
      }
      S.stageDirty = true;
    }
  }
  S.last = now;
  if (S.stageDirty) {
    S.stageDirty = false;
    renderStage();
    updateCounter();
  }
  requestAnimationFrame(loop);
}

function updateCounter() {
  const a = anim();
  let txt = '0 / 0', label = '';
  if (S.view === 'frame') {
    const f = frameOf(S.viewFrameId);
    const i = S.order.indexOf(S.viewFrameId);
    txt = `${i + 1} / ${S.order.length}`;
    if (f) label = `${f.name} · ${f.w}×${f.h} px${f.src ? ` · at ${f.src.x}, ${f.src.y}` : ''}`;
  } else if (a) {
    const tk = currentTick();
    const i = tk ? tk.i : 0;
    txt = `${a.items.length ? i + 1 : 0} / ${a.items.length}`;
    const c = cellSize(a, S.frames);
    label = `${a.name} · ${a.items.length} steps · ${c.w}×${c.h} px · ${a.fps} fps`;
    if (tk && i !== lastPlayingStep) {
      document.querySelectorAll('.step.playing').forEach(el => el.classList.remove('playing'));
      document.querySelector(`.step[data-i="${i}"]`)?.classList.add('playing');
      lastPlayingStep = i;
    }
  }
  $('pbCounter').textContent = txt;
  $('stageLabel').textContent = label;
}

// ---------------------------------------------------------------- UI rendering
function thumb(canvas, f, W, H) {
  canvas.width = W; canvas.height = H;
  const x = canvas.getContext('2d');
  x.clearRect(0, 0, W, H);
  if (!f) return;
  let s = Math.min(W / f.w, H / f.h);
  if (s > 1) s = Math.floor(s);
  x.imageSmoothingEnabled = s < 1;
  const w = f.w * s, h = f.h * s;
  x.drawImage(f.canvas, Math.floor((W - w) / 2), Math.floor((H - h) / 2), w, h);
}

function refreshAll() {
  renderSheetSelect();
  renderSheet();
  renderFrames();
  renderAnims();
  renderTimeline();
  renderSideForStep();
  renderViewButtons();
  S.stageDirty = true;
}

function renderViewButtons() {
  $('viewAnim').classList.toggle('on', S.view === 'anim');
  $('viewFrame').classList.toggle('on', S.view === 'frame');
  $('btnDraw').classList.toggle('on', S.draw.on);
  $('stageWrap').classList.toggle('drawing', S.draw.on);
  $('drawBar').hidden = !S.draw.on;
  $('pbOnion').classList.toggle('on', S.onion);
  $('pbGrid').classList.toggle('on', S.grid);
  $('pbBounds').classList.toggle('on', S.bounds);
}

function renderSheetSelect() {
  const sel = $('sheetSelect');
  sel.innerHTML = '';
  for (const s of S.sheets) {
    const o = document.createElement('option');
    o.value = s.id; o.textContent = s.name; o.selected = s.id === S.sheetId;
    sel.appendChild(o);
  }
  sel.disabled = S.sheets.length < 2;
  $('btnRemoveSheet').disabled = !S.sheets.length;
  $('btnReslice').disabled = !S.sheets.length;
}

// ---- sheet viewer
const sheetCv = $('sheetCanvas');
function sheetScale(sh) {
  if (S.sheetScale) return S.sheetScale;
  const wrap = $('sheetWrap');
  const s = Math.min((wrap.clientWidth - 2) / sh.w, (wrap.clientHeight - 2) / sh.h);
  return s >= 1 ? Math.min(8, Math.floor(s)) : s;
}
function renderSheet() {
  const sh = sheet();
  $('sheetEmpty').hidden = !!sh;
  sheetCv.hidden = !sh;
  if (!sh) { $('sheetInfo').textContent = ''; return; }
  const s = sheetScale(sh);
  const w = Math.min(16384, Math.round(sh.w * s)), h = Math.min(16384, Math.round(sh.h * s));
  if (sheetCv.width !== w || sheetCv.height !== h) { sheetCv.width = w; sheetCv.height = h; }
  const x = sheetCv.getContext('2d');
  x.clearRect(0, 0, w, h);
  x.imageSmoothingEnabled = s < 1;
  x.drawImage(sh.canvas, 0, 0, w, h);
  const a = anim();
  const inAnim = new Set(a ? a.items.map(it => it.frameId) : []);
  const curF = a?.items[currentTick()?.i ?? S.step]?.frameId;
  x.lineWidth = 1;
  for (const id of S.order) {
    const f = frameOf(id);
    if (f.sheetId !== sh.id || !f.src) continue;
    const r = f.src, rx = Math.round(r.x * s) + 0.5, ry = Math.round(r.y * s) + 0.5, rw = Math.round(r.w * s) - 1, rh = Math.round(r.h * s) - 1;
    if (S.sel.has(id)) { x.fillStyle = '#7aa2ff33'; x.fillRect(rx, ry, rw, rh); }
    x.strokeStyle = id === curF && S.view === 'anim' ? '#ffffff' : S.sel.has(id) ? '#7aa2ff' : inAnim.has(id) ? '#b4f461cc' : '#ffffff40';
    x.strokeRect(rx, ry, rw, rh);
  }
  if (S.hover && S.sheetTool === 'pick') {
    const f = frameOf(S.hover);
    if (f && f.src) {
      const r = f.src;
      x.strokeStyle = '#ffd166'; x.lineWidth = 2;
      x.strokeRect(r.x * s, r.y * s, r.w * s, r.h * s);
      x.lineWidth = 1;
    }
  }
  if (S.boxDrag) {
    const { x0, y0, x1, y1 } = normBox(S.boxDrag);
    x.save(); x.setLineDash([4, 3]); x.strokeStyle = '#ffd166'; x.lineWidth = 1.5;
    x.fillStyle = '#ffd16622';
    x.fillRect(x0 * s, y0 * s, (x1 - x0) * s, (y1 - y0) * s);
    x.strokeRect(x0 * s, y0 * s, (x1 - x0) * s, (y1 - y0) * s);
    x.restore();
  }
  const n = S.order.filter(id => frameOf(id).sheetId === sh.id).length;
  $('sheetInfo').textContent = `${sh.w}×${sh.h} px · ${n} frames · ${s >= 1 ? s : s.toFixed(2)}× view`;
}
function normBox(b) {
  return { x0: Math.min(b.x0, b.x1), y0: Math.min(b.y0, b.y1), x1: Math.max(b.x0, b.x1), y1: Math.max(b.y0, b.y1) };
}
function sheetPoint(ev) {
  const sh = sheet(), r = sheetCv.getBoundingClientRect();
  const s = sheetCv.width / sh.w;
  return { x: clamp((ev.clientX - r.left) / s, 0, sh.w), y: clamp((ev.clientY - r.top) / s, 0, sh.h) };
}
function hitFrame(p) {
  const sh = sheet();
  let best = null, area = Infinity;
  for (const id of S.order) {
    const f = frameOf(id);
    if (f.sheetId !== sh.id || !f.src) continue;
    const r = f.src;
    if (p.x >= r.x && p.y >= r.y && p.x < r.x + r.w && p.y < r.y + r.h && r.w * r.h < area) { best = id; area = r.w * r.h; }
  }
  return best;
}

// ---- frame library
function renderFrames() {
  const list = $('frameList');
  list.innerHTML = '';
  const a = anim();
  const used = new Set(a ? a.items.map(it => it.frameId) : []);
  const frag = document.createDocumentFragment();
  S.order.forEach((id, i) => {
    const f = frameOf(id);
    const d = document.createElement('div');
    d.className = 'fthumb checker' + (S.sel.has(id) ? ' sel' : '') + (used.has(id) ? ' used' : '');
    d.dataset.id = id; d.draggable = true;
    d.title = `${f.name} (${f.w}×${f.h})`;
    const c = document.createElement('canvas');
    thumb(c, f, 64, 64);
    const n = document.createElement('span'); n.className = 'n'; n.textContent = i;
    d.append(c, n);
    frag.appendChild(d);
  });
  list.appendChild(frag);
  $('frameCount').textContent = S.order.length ? `(${S.order.length})` : '';
  const k = S.sel.size;
  $('faView').disabled = k !== 1 && !S.viewFrameId;
  $('faAdd').disabled = !k; $('faPng').disabled = !k; $('faDup').disabled = !k;
  $('faMerge').disabled = k < 2; $('faDelete').disabled = !k;
  $('faPng').textContent = k > 1 ? `⤓ ${k} PNGs` : '⤓ PNG';
}

// ---- animations
function renderAnims() {
  const list = $('animList');
  list.innerHTML = '';
  for (const a of S.anims) {
    const d = document.createElement('div');
    d.className = 'anim-item' + (a.id === S.animId ? ' sel' : '');
    d.dataset.id = a.id;
    const c = document.createElement('canvas');
    c.className = 'checker';
    thumb(c, frameOf(a.items[0]?.frameId), 32, 32);
    const nm = document.createElement('span'); nm.className = 'nm'; nm.textContent = a.name;
    const cnt = document.createElement('span'); cnt.className = 'c'; cnt.textContent = a.items.length;
    d.append(c, nm, cnt);
    list.appendChild(d);
  }
  if (!S.anims.length) list.innerHTML = '<div class="hint">No animations yet. Add frames to start one.</div>';
  const a = anim();
  $('animProps').querySelectorAll('input,select,button').forEach(el => el.disabled = !a);
  if (a) {
    if (document.activeElement !== $('anName')) $('anName').value = a.name;
    $('anMode').value = a.mode; $('anAnchor').value = a.anchor;
    $('pbFps').value = a.fps; $('pbFpsOut').textContent = a.fps;
  }
}

// ---- timeline
function renderTimeline() {
  const strip = $('tlStrip');
  strip.innerHTML = '';
  const a = anim();
  $('tlName').textContent = a ? `Timeline: ${a.name}` : 'Timeline';
  if (!a || !a.items.length) {
    strip.innerHTML = '<div class="tl-empty">Double-click frames (or drag them here) to build an animation.</div>';
  } else {
    const frag = document.createDocumentFragment();
    a.items.forEach((it, i) => {
      const d = document.createElement('div');
      d.className = 'step' + (i === S.step ? ' sel' : '');
      d.dataset.i = i; d.draggable = true;
      const c = document.createElement('canvas');
      c.className = 'checker';
      thumb(c, frameOf(it.frameId), 68, 62);
      const m = document.createElement('div'); m.className = 'meta';
      m.innerHTML = `<span>${i + 1}</span><span>${it.hold > 1 ? '×' + it.hold : ''}</span>`;
      d.append(c, m);
      const fx = it.dx || it.dy || it.sx !== 1 || it.sy !== 1 || it.rot || it.flipX || it.flipY || it.alpha !== 1;
      if (fx || it.tween) { const s = document.createElement('span'); s.className = 'fx'; s.textContent = (fx ? 'fx' : '') + (it.tween ? '~' : ''); d.appendChild(s); }
      frag.appendChild(d);
    });
    strip.appendChild(frag);
  }
  lastPlayingStep = -1;
  const has = a && a.items.length;
  ['tlLeft', 'tlRight', 'tlDup', 'tlCopy', 'tlReverse', 'tlDelete'].forEach(id => $(id).disabled = !has);
}

// ---- step properties
const SP = { hold: 'spHold', alpha: 'spAlpha', dx: 'spDx', dy: 'spDy', sx: 'spSx', sy: 'spSy', rot: 'spRot' };
function renderSideForStep() {
  const a = anim();
  const it = a?.items[S.step];
  $('stepProps').querySelectorAll('input,button').forEach(el => el.disabled = !it);
  $('stepLabel').textContent = it ? `step ${S.step + 1}` : '';
  if (!it) return;
  for (const [k, id] of Object.entries(SP)) if (document.activeElement !== $(id)) $(id).value = it[k];
  $('spFlipX').checked = it.flipX; $('spFlipY').checked = it.flipY; $('spTween').checked = it.tween;
  document.querySelectorAll('.step').forEach(el => el.classList.toggle('sel', Number(el.dataset.i) === S.step));
}

function setView(v) {
  S.view = v;
  if (v === 'frame' && !frameOf(S.viewFrameId)) S.viewFrameId = S.order[0] || null;
  S.zoom = 0; S.panX = S.panY = 0;
  if (v === 'frame') setPlaying(false);
  renderViewButtons();
  S.stageDirty = true;
}

function setDraw(on) {
  S.draw.on = on;
  if (on) setPlaying(false);
  renderViewButtons();
  S.stageDirty = true;
}

// ---------------------------------------------------------------- drawing
function pushUndo(f) {
  S.undo.push({ id: f.id, data: ctx2d(f.canvas).getImageData(0, 0, f.w, f.h) });
  if (S.undo.length > 80) S.undo.shift();
  S.redo = [];
}
function undoRedo(from, to) {
  const e = from.pop();
  if (!e) return;
  const f = frameOf(e.id);
  if (!f) return undoRedo(from, to);
  to.push({ id: f.id, data: ctx2d(f.canvas).getImageData(0, 0, f.w, f.h) });
  ctx2d(f.canvas).putImageData(e.data, 0, 0);
  touched(f);
  changed();
}
function touched(f) { f.edited = true; f.canvas._v = (f.canvas._v || 0) + 1; }

function hexToRgba(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 255];
}
function paintAt(f, px, py) {
  const x = ctx2d(f.canvas), s = S.draw.size, o = Math.floor((s - 1) / 2);
  if (S.draw.tool === 'eraser') x.clearRect(px - o, py - o, s, s);
  else { x.fillStyle = S.draw.color; x.fillRect(px - o, py - o, s, s); }
}
function paintLine(f, x0, y0, x1, y1) {
  const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    paintAt(f, x0, y0);
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x0 += sx; }
    if (e2 <= dx) { err += dx; y0 += sy; }
  }
}
function floodFill(f, px, py) {
  if (px < 0 || py < 0 || px >= f.w || py >= f.h) return;
  const x = ctx2d(f.canvas), img = x.getImageData(0, 0, f.w, f.h), d = img.data;
  const at = (i) => (d[i] << 24 | d[i + 1] << 16 | d[i + 2] << 8 | d[i + 3]) >>> 0;
  const start = (py * f.w + px) * 4, target = at(start);
  const col = hexToRgba(S.draw.color);
  if (target === ((col[0] << 24 | col[1] << 16 | col[2] << 8 | col[3]) >>> 0)) return;
  const stack = [px, py];
  while (stack.length) {
    const yy = stack.pop(), xx = stack.pop();
    if (xx < 0 || yy < 0 || xx >= f.w || yy >= f.h) continue;
    const i = (yy * f.w + xx) * 4;
    if (at(i) !== target) continue;
    d[i] = col[0]; d[i + 1] = col[1]; d[i + 2] = col[2]; d[i + 3] = col[3];
    stack.push(xx + 1, yy, xx - 1, yy, xx, yy + 1, xx, yy - 1);
  }
  x.putImageData(img, 0, 0);
}
function pickColor(f, px, py) {
  if (px < 0 || py < 0 || px >= f.w || py >= f.h) return;
  const d = ctx2d(f.canvas).getImageData(px, py, 1, 1).data;
  if (d[3] === 0) return toast('That pixel is transparent');
  const hex = '#' + [d[0], d[1], d[2]].map(v => v.toString(16).padStart(2, '0')).join('');
  S.draw.color = hex; $('drawColor').value = hex;
  setTool('pencil');
}
function setTool(t) {
  S.draw.tool = t;
  document.querySelectorAll('#drawBar [data-tool]').forEach(b => b.classList.toggle('on', b.dataset.tool === t));
}

let stroke = null, pan = null;
stage.addEventListener('pointerdown', (ev) => {
  const L = layout();
  if (ev.button === 2 || ev.button === 1 || (!S.draw.on && ev.button === 0)) {
    pan = { x: ev.clientX, y: ev.clientY, px: S.panX, py: S.panY, moved: false };
    stage.setPointerCapture(ev.pointerId);
    return;
  }
  if (!S.draw.on || !L) return;
  const t = drawTarget(L);
  if (!t) return;
  const r = stage.getBoundingClientRect();
  const px = Math.floor((ev.clientX - r.left - t.x) / L.z), py = Math.floor((ev.clientY - r.top - t.y) / L.z);
  const f = t.frame;
  if (S.draw.tool === 'picker') { pickColor(f, px, py); return; }
  pushUndo(f);
  if (S.draw.tool === 'fill') { floodFill(f, px, py); touched(f); changed(); return; }
  paintAt(f, px, py);
  touched(f);
  stroke = { f, t, z: L.z, px, py };
  stage.setPointerCapture(ev.pointerId);
  S.stageDirty = true;
});
stage.addEventListener('pointermove', (ev) => {
  if (pan) {
    S.panX = pan.px + ev.clientX - pan.x; S.panY = pan.py + ev.clientY - pan.y;
    if (Math.abs(ev.clientX - pan.x) + Math.abs(ev.clientY - pan.y) > 3) pan.moved = true;
    S.stageDirty = true; return;
  }
  if (!stroke) return;
  const r = stage.getBoundingClientRect();
  const px = Math.floor((ev.clientX - r.left - stroke.t.x) / stroke.z), py = Math.floor((ev.clientY - r.top - stroke.t.y) / stroke.z);
  if (px === stroke.px && py === stroke.py) return;
  paintLine(stroke.f, stroke.px, stroke.py, px, py);
  stroke.px = px; stroke.py = py;
  S.stageDirty = true;
});
const endPointer = () => {
  if (pan) { if (!pan.moved && !S.draw.on && S.view === 'anim') setPlaying(!S.playing); pan = null; }
  if (stroke) { stroke = null; changed(); }
};
stage.addEventListener('pointerup', endPointer);
stage.addEventListener('pointercancel', endPointer);
stage.addEventListener('contextmenu', (e) => e.preventDefault());
stage.addEventListener('wheel', (ev) => {
  ev.preventDefault();
  zoomBy(ev.deltaY < 0 ? 1 : -1, ev);
}, { passive: false });

function zoomBy(dir, ev = null) {
  const L = layout();
  if (!L) return;
  const steps = [0.1, 0.125, 0.25, 0.33, 0.5, 0.75, 1, 2, 3, 4, 5, 6, 8, 10, 12, 16, 20, 24, 32, 40, 48, 64];
  const z = L.z;
  let nz = dir > 0 ? steps.find(s => s > z + 1e-6) : [...steps].reverse().find(s => s < z - 1e-6);
  if (!nz) return;
  if (ev) {
    // keep the point under the mouse still
    const r = stage.getBoundingClientRect();
    const mx = ev.clientX - r.left - L.W / 2, my = ev.clientY - r.top - L.H / 2;
    S.panX = mx - (mx - S.panX) * nz / z; S.panY = my - (my - S.panY) * nz / z;
  }
  S.zoom = nz;
  S.stageDirty = true;
}

// ---------------------------------------------------------------- new canvas
function newCanvasProject(w, h, n, fps) {
  const ids = [];
  for (let i = 0; i < n; i++) {
    const f = addFrame(newCanvas(w, h), `drawing_${String(S.order.length).padStart(2, '0')}`);
    S.order.push(f.id); ids.push(f.id);
  }
  const a = makeAnim(`Drawing ${S.anims.filter(x => !x.sheetId).length + 1}`, ids.map(id => makeItem(id)), { fps, anchor: 'center' });
  S.anims.push(a);
  selectAnim(a.id, true);
  S.view = 'anim';
  S.onion = true;
  setDraw(true);
  changed();
  toast('Blank animation ready: draw on each step, use ← → to move between them');
}

// ---------------------------------------------------------------- events
function on(id, ev, fn) { $(id).addEventListener(ev, fn); }

on('btnOpen', 'click', () => $('fileSheet').click());
on('emptyOpen', 'click', () => $('fileSheet').click());
on('fileSheet', 'change', (e) => { handleFiles(e.target.files); e.target.value = ''; });
on('btnOpenProject', 'click', () => $('fileProject').click());
on('fileProject', 'change', (e) => { if (e.target.files[0]) loadProjectFile(e.target.files[0]); e.target.value = ''; });
on('btnSaveProject', 'click', () => {
  if (!S.frames.size) return toast('Nothing to save yet', true);
  const name = safe(S.sheets[0] ? baseName(S.sheets[0].name) : anim()?.name || 'project');
  download(new Blob([JSON.stringify(serialize())], { type: 'application/json' }), `${name}.ssv.json`);
});
const demo = () => { addSheet('demo-goblin-slime.png', makeDemoSheet()); refreshAll(); };
on('btnDemo', 'click', demo);
on('emptyDemo', 'click', demo);
const openNew = () => $('dlgNew').showModal();
on('btnNew', 'click', openNew);
on('emptyNew', 'click', openNew);
$('dlgNew').addEventListener('close', () => {
  if ($('dlgNew').returnValue !== 'ok') return;
  newCanvasProject(clamp(+$('nwW').value || 32, 1, 1024), clamp(+$('nwH').value || 32, 1, 1024), clamp(+$('nwN').value || 4, 1, 200), clamp(+$('nwFps').value || 8, 1, 60));
});
on('btnHelp', 'click', () => $('dlgHelp').showModal());

// sheet panel
on('sheetSelect', 'change', (e) => { S.sheetId = e.target.value; S.sheetScale = 0; loadSliceUI(sheet()); renderSheet(); });
on('btnRemoveSheet', 'click', removeSheet);
on('sheetPick', 'click', () => { S.sheetTool = 'pick'; $('sheetPick').classList.add('on'); $('sheetBox').classList.remove('on'); });
on('sheetBox', 'click', () => { S.sheetTool = 'box'; $('sheetBox').classList.add('on'); $('sheetPick').classList.remove('on'); toast('Drag on the sheet to cut out a frame'); });
const sheetZoom = (k) => { const sh = sheet(); if (!sh) return; S.sheetScale = clamp(sheetScale(sh) * k, 0.05, 16); renderSheet(); };
on('sheetZoomIn', 'click', () => sheetZoom(2));
on('sheetZoomOut', 'click', () => sheetZoom(0.5));
on('sheetFit', 'click', () => { S.sheetScale = 0; renderSheet(); });
$('sheetWrap').addEventListener('wheel', (e) => { if (!e.ctrlKey && !e.altKey) return; e.preventDefault(); sheetZoom(e.deltaY < 0 ? 1.25 : 0.8); }, { passive: false });
new ResizeObserver(() => { if (!S.sheetScale) renderSheet(); }).observe($('sheetWrap'));

sheetCv.addEventListener('pointerdown', (ev) => {
  if (!sheet()) return;
  const p = sheetPoint(ev);
  if (S.sheetTool === 'box') {
    S.boxDrag = { x0: Math.round(p.x), y0: Math.round(p.y), x1: Math.round(p.x), y1: Math.round(p.y) };
    sheetCv.setPointerCapture(ev.pointerId);
    return;
  }
  const id = hitFrame(p);
  if (!id) return;
  if (ev.shiftKey && !ev.ctrlKey) { addFramesToAnim([id]); return; }
  selectFrame(id, { ctrlKey: ev.ctrlKey || ev.metaKey });
  if (!(ev.ctrlKey || ev.metaKey)) setView('frame');
  renderFrames(); renderSheet();
  document.querySelector(`.fthumb[data-id="${id}"]`)?.scrollIntoView({ block: 'nearest' });
});
sheetCv.addEventListener('dblclick', (ev) => {
  if (S.sheetTool !== 'pick' || !sheet()) return;
  const id = hitFrame(sheetPoint(ev));
  if (id) addFramesToAnim([id]);
});
sheetCv.addEventListener('pointermove', (ev) => {
  if (!sheet()) return;
  const p = sheetPoint(ev);
  if (S.boxDrag) { S.boxDrag.x1 = Math.round(p.x); S.boxDrag.y1 = Math.round(p.y); renderSheet(); return; }
  if (S.sheetTool !== 'pick') return;
  const id = hitFrame(p);
  if (id !== S.hover) { S.hover = id; renderSheet(); sheetCv.title = id ? `${frameOf(id).name}: click to view, double-click to add` : ''; }
});
sheetCv.addEventListener('pointerleave', () => { if (S.hover) { S.hover = null; renderSheet(); } });
sheetCv.addEventListener('pointerup', () => {
  if (!S.boxDrag) return;
  const b = normBox(S.boxDrag);
  S.boxDrag = null;
  const sh = sheet();
  if (b.x1 - b.x0 < 1 || b.y1 - b.y0 < 1) { renderSheet(); return; }
  const w = b.x1 - b.x0, h = b.y1 - b.y0;
  const c = newCanvas(w, h);
  c.getContext('2d').drawImage(sh.canvas, b.x0, b.y0, w, h, 0, 0, w, h);
  if (sh.bg?.type === 'color' && sh.slice.removeBg !== 'off') {
    const x = ctx2d(c), d = x.getImageData(0, 0, w, h);
    removeBackground(d, sh.bg.color, sh.slice.removeBg === 'hard' ? 'hard' : 'soft', sh.slice.tol);
    x.putImageData(d, 0, 0);
  }
  const f = addFrame(c, `${baseName(sh.name)}_box${S.order.length}`, { sheetId: sh.id, src: { x: b.x0, y: b.y0, w, h } });
  S.order.push(f.id);
  S.sel = new Set([f.id]); S.lastSel = f.id;
  viewFrame(f.id);
  changed();
  toast(`New frame ${w}×${h}. Double-click it to add it to the animation.`);
});

// slicing
let sliceT = 0;
document.querySelectorAll('[id^="sl"]').forEach(el => el.addEventListener('change', () => {
  showSliceFields();
  clearTimeout(sliceT);
  sliceT = setTimeout(reslice, 120);
}));
on('btnReslice', 'click', reslice);

// frame library
const flist = $('frameList');
flist.addEventListener('click', (ev) => {
  const el = ev.target.closest('.fthumb'); if (!el) return;
  selectFrame(el.dataset.id, ev);
  if (!ev.shiftKey && !ev.ctrlKey && !ev.metaKey && S.view !== 'frame') setView('frame');
  renderFrames(); renderSheet(); renderViewButtons();
});
flist.addEventListener('dblclick', (ev) => {
  const el = ev.target.closest('.fthumb'); if (!el) return;
  addFramesToAnim([el.dataset.id]);
});
flist.addEventListener('dragstart', (ev) => {
  const el = ev.target.closest('.fthumb'); if (!el) return;
  const ids = S.sel.has(el.dataset.id) ? selectedFrames() : [el.dataset.id];
  ev.dataTransfer.setData('application/x-ssv-frames', JSON.stringify(ids));
  ev.dataTransfer.effectAllowed = 'copy';
});
on('faView', 'click', () => viewFrame(selectedFrames()[0] || S.viewFrameId));
on('faAdd', 'click', () => addFramesToAnim(selectedFrames()));
on('faPng', 'click', () => downloadFrames(selectedFrames()));
on('faDup', 'click', () => duplicateFrames(selectedFrames()));
on('faMerge', 'click', () => mergeFrames(selectedFrames()));
on('faDelete', 'click', () => deleteFrames(selectedFrames()));
on('btnNewFrame', 'click', newBlankFrame);

// stage controls
on('viewAnim', 'click', () => setView('anim'));
on('viewFrame', 'click', () => setView('frame'));
on('btnDraw', 'click', () => setDraw(!S.draw.on));
document.querySelectorAll('#drawBar [data-tool]').forEach(b => b.addEventListener('click', () => setTool(b.dataset.tool)));
on('drawColor', 'input', (e) => { S.draw.color = e.target.value; });
on('drawSize', 'change', (e) => { S.draw.size = Number(e.target.value); });
on('btnUndo', 'click', () => undoRedo(S.undo, S.redo));
on('btnRedo', 'click', () => undoRedo(S.redo, S.undo));
on('btnClearFrame', 'click', () => {
  const t = drawTarget(layout()); if (!t) return;
  pushUndo(t.frame); ctx2d(t.frame.canvas).clearRect(0, 0, t.frame.w, t.frame.h); touched(t.frame); changed();
});

function stepBy(d) {
  if (S.view === 'frame') {
    if (!S.order.length) return;
    const i = S.order.indexOf(S.viewFrameId);
    const id = S.order[(i + d + S.order.length) % S.order.length];
    S.sel = new Set([id]); S.lastSel = id; S.viewFrameId = id;
    renderFrames(); renderSheet();
    document.querySelector(`.fthumb[data-id="${id}"]`)?.scrollIntoView({ block: 'nearest' });
    S.stageDirty = true;
    return;
  }
  const a = anim(); if (!a || !a.items.length) return;
  setPlaying(false);
  S.step = (S.step + d + a.items.length) % a.items.length;
  syncPosToStep();
  renderSideForStep(); renderSheet();
}
function jumpTo(i) {
  const a = anim();
  if (S.view === 'frame') { if (S.order.length) { S.viewFrameId = S.order[i < 0 ? S.order.length - 1 : 0]; S.sel = new Set([S.viewFrameId]); renderFrames(); S.stageDirty = true; } return; }
  if (!a || !a.items.length) return;
  setPlaying(false);
  S.step = i < 0 ? a.items.length - 1 : 0;
  syncPosToStep(); renderSideForStep(); renderSheet();
}
on('pbPrev', 'click', () => stepBy(-1));
on('pbNext', 'click', () => stepBy(1));
on('pbFirst', 'click', () => jumpTo(0));
on('pbLast', 'click', () => jumpTo(-1));
on('pbPlay', 'click', togglePlay);
function togglePlay() {
  if (S.view === 'frame') setView('anim');
  if (S.draw.on) setDraw(false);
  setPlaying(!S.playing);
  if (!S.playing) renderSideForStep();
}
on('pbFps', 'input', (e) => {
  const a = anim(); $('pbFpsOut').textContent = e.target.value;
  if (a) { a.fps = Number(e.target.value); changed(false); updateCounter(); }
});
on('pbOnion', 'click', () => { S.onion = !S.onion; renderViewButtons(); S.stageDirty = true; });
on('pbGrid', 'click', () => { S.grid = !S.grid; renderViewButtons(); S.stageDirty = true; });
on('pbBounds', 'click', () => { S.bounds = !S.bounds; renderViewButtons(); S.stageDirty = true; });
on('pbBg', 'change', (e) => { S.bg = e.target.value; S.stageDirty = true; });
on('zoomIn', 'click', () => zoomBy(1));
on('zoomOut', 'click', () => zoomBy(-1));
on('zoomFit', 'click', () => { S.zoom = 0; S.panX = S.panY = 0; S.stageDirty = true; });

// timeline
const strip = $('tlStrip');
strip.addEventListener('click', (ev) => {
  const el = ev.target.closest('.step'); if (!el) return;
  setPlaying(false);
  S.step = Number(el.dataset.i);
  syncPosToStep();
  const fid = anim().items[S.step].frameId;
  S.viewFrameId = fid;
  if (S.view === 'frame') S.view = 'anim';
  renderSideForStep(); renderSheet(); renderViewButtons();
});
let dragStep = null;
strip.addEventListener('dragstart', (ev) => {
  const el = ev.target.closest('.step'); if (!el) return;
  dragStep = Number(el.dataset.i);
  el.classList.add('dragging');
  ev.dataTransfer.effectAllowed = 'move';
  ev.dataTransfer.setData('text/plain', 'step');
});
strip.addEventListener('dragend', () => { dragStep = null; document.querySelectorAll('.step').forEach(e => e.classList.remove('dragging', 'drop-before')); });
function dropIndex(ev) {
  const steps = [...strip.querySelectorAll('.step')];
  for (const el of steps) { const r = el.getBoundingClientRect(); if (ev.clientX < r.left + r.width / 2) return Number(el.dataset.i); }
  return steps.length;
}
strip.addEventListener('dragover', (ev) => {
  ev.preventDefault();
  const k = dropIndex(ev);
  document.querySelectorAll('.step').forEach(e => e.classList.toggle('drop-before', Number(e.dataset.i) === k));
});
strip.addEventListener('drop', (ev) => {
  ev.preventDefault();
  const k = dropIndex(ev);
  const framesData = ev.dataTransfer.getData('application/x-ssv-frames');
  if (framesData) {
    const ids = JSON.parse(framesData).filter(id => S.frames.has(id));
    let a = anim();
    if (!a) { a = makeAnim(`Animation ${S.anims.length + 1}`); S.anims.push(a); S.animId = a.id; }
    a.items.splice(k, 0, ...ids.map(id => makeItem(id)));
    S.step = k;
  } else if (dragStep !== null) {
    const a = anim();
    const [it] = a.items.splice(dragStep, 1);
    const to = k > dragStep ? k - 1 : k;
    a.items.splice(to, 0, it);
    S.step = to;
  }
  dragStep = null;
  syncPosToStep();
  changed();
});
function moveStep(d) {
  const a = anim(); if (!a) return;
  const j = S.step + d;
  if (j < 0 || j >= a.items.length) return;
  [a.items[S.step], a.items[j]] = [a.items[j], a.items[S.step]];
  S.step = j; syncPosToStep(); changed();
}
on('tlLeft', 'click', () => moveStep(-1));
on('tlRight', 'click', () => moveStep(1));
on('tlDup', 'click', () => {
  const a = anim(); const it = a?.items[S.step]; if (!it) return;
  a.items.splice(S.step + 1, 0, { ...it, id: uid('it') });
  S.step++; syncPosToStep(); changed();
});
on('tlCopy', 'click', () => {
  const a = anim(); const it = a?.items[S.step]; if (!it) return;
  const f = frameOf(it.frameId);
  const n = addFrame(copyCanvas(f.canvas), `${f.name}_copy`);
  S.order.splice(S.order.indexOf(f.id) + 1, 0, n.id);
  a.items.splice(S.step + 1, 0, { ...it, id: uid('it'), frameId: n.id });
  S.step++; syncPosToStep(); changed();
  toast('Copied as a new frame: edit it with ✎ Draw without changing the original');
});
on('tlReverse', 'click', () => { const a = anim(); if (!a) return; a.items.reverse(); S.step = a.items.length - 1 - S.step; syncPosToStep(); changed(); });
on('tlDelete', 'click', removeStep);
function removeStep() {
  const a = anim(); if (!a || !a.items[S.step]) return;
  a.items.splice(S.step, 1);
  clampStep(); changed();
}

// animations
$('animList').addEventListener('click', (ev) => {
  const el = ev.target.closest('.anim-item'); if (!el) return;
  selectAnim(el.dataset.id);
  if (S.view === 'frame') setView('anim');
  setPlaying(true);
});
on('anNew', 'click', () => {
  const a = makeAnim(`Animation ${S.anims.length + 1}`);
  const ids = selectedFrames();
  a.items = ids.map(id => makeItem(id));
  S.anims.push(a);
  selectAnim(a.id, true);
  setView('anim');
  changed();
  toast(ids.length ? `New animation with ${ids.length} selected frames` : 'New animation: double-click frames to add them');
});
on('anName', 'input', (e) => { const a = anim(); if (a) { a.name = e.target.value || 'Untitled'; a.auto = false; changed(false); renderAnims(); $('tlName').textContent = `Timeline: ${a.name}`; updateCounter(); } });
on('anMode', 'change', (e) => { const a = anim(); if (a) { a.mode = e.target.value; S.pos = 0; changed(false); } });
on('anAnchor', 'change', (e) => { const a = anim(); if (a) { a.anchor = e.target.value; changed(false); } });
on('anDup', 'click', () => {
  const a = anim(); if (!a) return;
  const c = { ...JSON.parse(JSON.stringify(a)), id: uid('an'), name: `${a.name} copy`, auto: false, sheetId: undefined };
  c.items.forEach(it => it.id = uid('it'));
  S.anims.splice(S.anims.indexOf(a) + 1, 0, c);
  selectAnim(c.id, true); changed();
});
on('anDelete', 'click', () => {
  const a = anim(); if (!a) return;
  const i = S.anims.indexOf(a);
  S.anims.splice(i, 1);
  S.animId = S.anims[Math.min(i, S.anims.length - 1)]?.id || null;
  S.step = 0; S.pos = 0; changed();
});

// step props
for (const [k, id] of Object.entries(SP)) {
  on(id, 'input', (e) => {
    const it = anim()?.items[S.step]; if (!it) return;
    let v = Number(e.target.value);
    if (!Number.isFinite(v)) return;
    if (k === 'hold') v = clamp(Math.round(v), 1, 999);
    if (k === 'alpha') v = clamp(v, 0, 1);
    it[k] = v;
    if (k === 'hold') syncPosToStep();
    changed(false);
    clearTimeout(on.tlT); on.tlT = setTimeout(renderTimeline, 300);
  });
}
for (const [k, id] of [['flipX', 'spFlipX'], ['flipY', 'spFlipY'], ['tween', 'spTween']]) {
  on(id, 'change', (e) => { const it = anim()?.items[S.step]; if (it) { it[k] = e.target.checked; changed(); } });
}
on('spApplyAll', 'click', () => {
  const a = anim(); const it = a?.items[S.step]; if (!it) return;
  for (const o of a.items) for (const k of Object.keys(ITEM_DEFAULTS)) o[k] = it[k];
  changed(); toast('Applied to every step');
});
on('spReset', 'click', () => { const it = anim()?.items[S.step]; if (!it) return; Object.assign(it, ITEM_DEFAULTS); changed(); });

// exports
const busy = (fn) => async () => { document.body.style.cursor = 'progress'; try { await fn(); } catch (e) { console.error(e); toast(`Export failed: ${e.message}`, true); } finally { document.body.style.cursor = ''; } };
on('exGif', 'click', busy(exportGif));
on('exStrip', 'click', busy(exportStrip));
on('exFrames', 'click', busy(exportAnimFrames));
on('exAllFrames', 'click', busy(() => downloadFrames([...S.order])));
on('exSheet', 'click', busy(exportSheet));
on('exWebm', 'click', busy(exportWebm));

// file drag & drop + paste
let dragDepth = 0;
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
window.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; dragDepth++; $('dropOverlay').hidden = false; });
window.addEventListener('dragleave', (e) => { if (!hasFiles(e)) return; if (--dragDepth <= 0) { dragDepth = 0; $('dropOverlay').hidden = true; } });
window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
window.addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault(); dragDepth = 0; $('dropOverlay').hidden = true;
  handleFiles(e.dataTransfer.files);
});
window.addEventListener('paste', (e) => {
  const files = [...(e.clipboardData?.files || [])].filter(f => f.type.startsWith('image/'));
  if (files.length) { handleFiles(files.map((f, i) => new File([f], f.name && f.name !== 'image.png' ? f.name : `pasted_${Date.now()}_${i}.png`, { type: f.type }))); }
});

// keyboard
window.addEventListener('keydown', (e) => {
  const tag = e.target.tagName;
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || document.querySelector('dialog[open]')) return;
  const k = e.key, mod = e.ctrlKey || e.metaKey;
  if (mod && k.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? undoRedo(S.redo, S.undo) : undoRedo(S.undo, S.redo); return; }
  if (mod && k.toLowerCase() === 'y') { e.preventDefault(); undoRedo(S.redo, S.undo); return; }
  if (mod && k.toLowerCase() === 's') { e.preventDefault(); $('btnSaveProject').click(); return; }
  if (mod && k.toLowerCase() === 'o') { e.preventDefault(); $('fileSheet').click(); return; }
  if (mod) return;
  const map = {
    ' ': togglePlay, ArrowLeft: () => stepBy(-1), ArrowRight: () => stepBy(1), Home: () => jumpTo(0), End: () => jumpTo(-1),
    d: () => setDraw(!S.draw.on), b: () => setTool('pencil'), e: () => setTool('eraser'), g: () => setTool('fill'), i: () => setTool('picker'),
    n: () => $('pbOnion').click(), p: () => $('pbGrid').click(), '+': () => zoomBy(1), '=': () => zoomBy(1), '-': () => zoomBy(-1), '0': () => $('zoomFit').click(),
    v: () => viewFrame(selectedFrames()[0] || S.viewFrameId), a: () => addFramesToAnim(selectedFrames()),
    Delete: removeStep, Backspace: removeStep, '[': () => moveStep(-1), ']': () => moveStep(1), '?': () => $('dlgHelp').showModal(),
    Tab: null,
  };
  const fn = map[k] ?? map[k.toLowerCase()];
  if (fn) { e.preventDefault(); fn(); }
});

// ---------------------------------------------------------------- start
(async () => {
  showSliceFields();
  refreshAll();
  requestAnimationFrame(loop);
  const saved = await store.get('project');
  if (saved && !S.frames.size) {
    const btn = $('emptyRestore');
    btn.hidden = false;
    btn.onclick = async () => {
      try { await loadProject(JSON.parse(saved)); toast('Restored your last session'); }
      catch (e) { toast(`Could not restore: ${e.message}`, true); }
    };
  }
  // ?demo in the URL loads the demo straight away (handy for sharing)
  if (new URLSearchParams(location.search).has('demo')) demo();
})();

// exposed for debugging in the console
window.ssv = { S, refreshAll, addSheet };
