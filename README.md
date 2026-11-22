# SpriteSheetViewer

Drop in any 2D sprite sheet and watch it animate. Frames are found automatically, whatever the size or layout, and you can view and download every single frame, build your own animations, draw on frames, and export GIFs, PNGs and sprite sheets.

**Use it online:** https://devilslayer12.github.io/SpriteSheetViewer/
(Try the built-in demo: https://devilslayer12.github.io/SpriteSheetViewer/?demo)

Everything runs in your browser. Images are never uploaded anywhere.

## Features

**Works with any sheet**
- Neat grids, single strips, and messy packed atlases with sprites scattered everywhere
- Transparent backgrounds or solid colour backgrounds (white, magenta, green...), which are removed with soft edges kept smooth
- Frames that touch edge to edge are split into a guessed grid
- Tiny 16 px sprites up to huge 4096 px atlases
- Manual control when you want it: grid by columns × rows, grid by cell size with offset and gaps, or "separate sprites" with adjustable join distance, padding and edge cutoff
- **Box tool:** drag on the sheet to cut out any area as a frame
- **Merge:** combine pieces that were split (like a detached sword or effect) into one frame
- Load several sheets at once, or paste an image with Ctrl+V

**View any part**
- Click any sprite on the sheet or in the Frames list to see it on its own, with its size and position
- Step through every frame with the arrow keys
- Zoom (mouse wheel), pan (drag), pixel grid, bounds, and several stage backgrounds
- Download any frame (or a selection of frames, or all of them) as PNG, at 1× to 8× scale

**Animate**
- Animations are created automatically from each row of the sheet
- Double-click or drag frames into the timeline, drag to reorder
- FPS, loop / ping-pong / play once, and alignment (bottom, center, top-left)
- Per-step Hold, Move, Scale, Rotate, Flip and Opacity
- Tween between steps for smooth hops, slides, spins and fades
- Onion skinning

**Draw**
- Pencil, eraser, fill and colour picker with undo / redo
- Draw on any frame, copy a frame to make a new one, or start from a blank canvas and animate from nothing

**Export and save**
- Animated GIF (with transparency)
- Animation strip PNG
- Animation frames as a ZIP of PNGs
- All frames as a ZIP of PNGs
- Sprite sheet PNG + JSON (frame rectangles, animations and timings, works with Phaser and similar engines)
- WebM video
- Save / open project files (`.ssv.json`) that keep everything, including your drawings
- Your last session is autosaved in the browser and can be restored

## Shortcuts

| Key | Action |
| --- | --- |
| Space | Play / pause |
| ← → | Previous / next frame |
| D | Draw mode |
| B / E / G / I | Pencil / eraser / fill / colour picker |
| Ctrl+Z / Ctrl+Y | Undo / redo |
| N | Onion skin |
| P | Pixel grid |
| + / − / 0 | Zoom in / out / fit |
| V | View selected frame |
| A | Add selected frames to the animation |
| Delete | Remove the selected step |
| [ / ] | Move step left / right |

## Running it yourself

No install needed: download the repo and double-click `index.html`. It works straight from your computer, offline.

## Editing the code

The source lives in `src/` and is bundled into one small minified file, `js/app.js`, so the page loads fast and also opens from disk. After changing anything in `src/`, rebuild it:

```bash
npm install
npm run build      # or: npm run watch
```

## Project layout

```
index.html        page layout
css/style.css     styles
js/app.js         bundled app (generated, don't edit by hand)
src/main.js       app: state, UI, playback, drawing, exports
src/detect.js     frame detection and background removal
src/anim.js       animation model and rendering
src/gif.js        GIF encoder
src/zip.js        ZIP writer
src/store.js      autosave
src/demo.js       generated demo sheet
```
