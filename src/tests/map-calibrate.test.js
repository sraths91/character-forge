// M64 E5 / M9 — calibration math (the plan gate: 3000×2000 image with a
// 100 px grid at (37,12) → cell size ±0.5 px, offset ±1 px) and a DOM
// smoke test of mountCalibrator on a minimal fake document.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MIN_CELL_PX, parseGridFromFilename, calibFromKnownSize, calibFromTwoClicks, refineWithFarCorner,
  gridDimsFor, nudgeCalib, farCornerCell, finalizeCalibration, cellRectInImage
} from '../js/map/calibration.js';
import { mountCalibrator } from '../js/map/calibrate.js';
import { recordingCanvas } from './helpers/mock-canvas.js';

const TRUE = { cellPx: 100, offsetX: 37, offsetY: 12 };
const IMG = { w: 3000, h: 2000 };

test('gate: two-click on a 3000×2000 map (100 px grid at 37,12) lands within ±0.5 px / ±1 px', () => {
  // Clicks carry up to ±0.5 px of hand error, the realistic loupe precision.
  const jitters = [[0.4, -0.3, -0.2, 0.5], [-0.5, 0.5, 0.5, -0.5], [0, 0, 0, 0], [0.3, 0.3, -0.4, -0.1]];
  for (const n of [3, 5]) {   // N = 3 is the default; N = 1 would double the hand error
    for (const [a, b, c, d] of jitters) {
      const p1 = { x: 237 + a, y: 112 + b };                     // top-left of cell (2,1)
      const p2 = { x: 237 + n * 100 + c, y: 112 + n * 100 + d }; // n cells right and down
      const { calib } = calibFromTwoClicks(p1, p2, n);
      assert.ok(Math.abs(calib.cellPx - 100) <= 0.5, `n=${n} k=${calib.cellPx}`);
      assert.ok(Math.abs(calib.offsetX - 37) <= 1 && Math.abs(calib.offsetY - 12) <= 1, `offset ${calib.offsetX},${calib.offsetY}`);
    }
  }
});

test('far-corner refine removes drift accumulated across the map', () => {
  const rough = calibFromTwoClicks({ x: 237.5, y: 112.5 }, { x: 537, y: 411.6 }, 3).calib;   // k ≈ 99.77
  const far = farCornerCell(IMG.w, IMG.h, rough);
  const truth = cellRectInImage({ calib: TRUE }, far.col, far.row);
  const fixed = refineWithFarCorner(rough, { x: truth.x + 0.3, y: truth.y - 0.4 }, far.col, far.row);
  assert.ok(Math.abs(fixed.cellPx - 100) < 0.05, `refined k=${fixed.cellPx}`);
  // After refinement the far cell lines up within 1 px.
  const after = cellRectInImage({ calib: fixed }, far.col, far.row);
  assert.ok(Math.abs(after.x - truth.x) <= 1 && Math.abs(after.y - truth.y) <= 1);
});

test('dims, known size and filename prefill', () => {
  assert.deepEqual(gridDimsFor(IMG.w, IMG.h, TRUE), { cols: 29, rows: 19 });
  assert.deepEqual(parseGridFromFilename('Crypt_30x20_gridded.webp'), { cols: 30, rows: 20 });
  assert.deepEqual(parseGridFromFilename('map 49 × 28.png'), { cols: 49, rows: 28 });
  assert.equal(parseGridFromFilename('photo_2024.jpg'), null);
  assert.equal(parseGridFromFilename('1920x1080.png'), null, 'pixel sizes are not grid sizes');
  const k = calibFromKnownSize(3000, 2000, 30, 20);
  assert.deepEqual(k.calib, { cellPx: 100, offsetX: 0, offsetY: 0 });
  assert.equal(k.skew, 0);
  assert.ok(calibFromKnownSize(3000, 2000, 30, 25).skew > 0.03);
});

test('nudges: arrows 1 px, Shift 0.1 cell, [ ] ±0.1 px, offsets wrap', () => {
  assert.deepEqual(nudgeCalib(TRUE, 'ArrowLeft'), { cellPx: 100, offsetX: 36, offsetY: 12 });
  assert.deepEqual(nudgeCalib(TRUE, 'ArrowDown', { shift: true }), { cellPx: 100, offsetX: 37, offsetY: 22 });
  assert.ok(Math.abs(nudgeCalib(TRUE, ']').cellPx - 100.1) < 1e-9);
  assert.ok(Math.abs(nudgeCalib(TRUE, '[').cellPx - 99.9) < 1e-9);
  assert.equal(nudgeCalib({ cellPx: 100, offsetX: 0, offsetY: 0 }, 'ArrowLeft').offsetX, 99);
  assert.equal(nudgeCalib(TRUE, 'q'), null);
});

test('finalizeCalibration rejects cells under 24 px and empty grids', () => {
  assert.equal(finalizeCalibration(TRUE, IMG.w, IMG.h).ok, true);
  assert.equal(MIN_CELL_PX, 24);
  assert.equal(finalizeCalibration({ cellPx: 23.9, offsetX: 0, offsetY: 0 }, IMG.w, IMG.h).reason, 'cell-too-small');
  assert.equal(finalizeCalibration({ cellPx: 5000, offsetX: 0, offsetY: 0 }, IMG.w, IMG.h).reason, 'no-whole-cells');
  assert.equal(finalizeCalibration({ cellPx: 100, offsetX: 137, offsetY: 12 }, IMG.w, IMG.h).calib.offsetX, 37);
});

// ---- DOM smoke test ----------------------------------------------------------

class FakeEl extends EventTarget {
  constructor(tag) {
    super();
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.style = {};
    this.parentNode = null;
    this.textContent = '';
    this.value = '';
    this.disabled = false;
    if (tag === 'canvas') this._ctx = recordingCanvas().ctx;
  }
  appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
  removeChild(c) { this.children = this.children.filter(x => x !== c); c.parentNode = null; return c; }
  getContext() { return this._ctx || null; }
  getBoundingClientRect() { return { left: 0, top: 0, width: this.width, height: this.height }; }
  focus() {}
}
const fakeDoc = { createElement: (t) => new FakeEl(t) };
function find(node, cls) {
  if (node.className === cls) return node;
  for (const c of node.children || []) { const hit = find(c, cls); if (hit) return hit; }
  return null;
}
function fire(target, type, props = {}) {
  const e = new globalThis.Event(type, { cancelable: true });
  for (const [k, v] of Object.entries(props)) Object.defineProperty(e, k, { value: v });
  target.dispatchEvent(e);
}

function mount(opts) {
  const root = new FakeEl('div');
  root.ownerDocument = fakeDoc;
  const results = [];
  let cancelled = 0;
  const unmount = mountCalibrator(root, {
    image: { naturalWidth: 3000, naturalHeight: 2000 }, onConfirm: r => results.push(r), onCancel: () => cancelled++, ...opts
  });
  return { root, results, unmount, cancelled: () => cancelled };
}

test('mountCalibrator: filename prefill → known size → confirm emits {calib, cols, rows}', () => {
  const { root, results, unmount } = mount({ filename: 'tavern_30x20.png' });
  assert.match(find(root, 'cf-calib-readout').textContent, /cell 100\.00 px .* 30 × 20 cells/);
  const confirm = find(root, 'cf-calib-confirm');
  assert.equal(confirm.disabled, false);
  fire(confirm, 'click');
  assert.deepEqual(results, [{ calib: { cellPx: 100, offsetX: 0, offsetY: 0 }, cols: 30, rows: 20 }]);
  unmount();
  assert.equal(root.children.length, 0);
});

test('mountCalibrator: two-click, drift refine and nudge keys reach the gate tolerance', () => {
  const { root, results, cancelled } = mount({});
  const view = find(root, 'cf-calib-view');
  const s = view.width / 3000;   // canvas shown at its own size in the fake
  const click = (x, y) => fire(view, 'click', { clientX: x * s, clientY: y * s });
  click(237.4, 112.3);
  click(537.2, 411.8);
  assert.match(find(root, 'cf-calib-readout').textContent, /29 × 19 cells/);
  fire(find(root, 'cf-calib-drift'), 'click');
  click(2837.2, 1812.3);                       // top-left of the far cell (28, 18)
  const panel = find(root, 'cf-calibrator');
  fire(panel, 'keydown', { key: 'ArrowRight' });
  fire(panel, 'keydown', { key: 'ArrowLeft' });
  fire(find(root, 'cf-calib-confirm'), 'click');
  const { calib, cols, rows } = results[0];
  assert.ok(Math.abs(calib.cellPx - 100) <= 0.5 && Math.abs(calib.offsetX - 37) <= 1 && Math.abs(calib.offsetY - 12) <= 1,
    JSON.stringify(calib));
  assert.deepEqual([cols, rows], [29, 19]);
  fire(panel, 'keydown', { key: 'Escape' });
  assert.equal(cancelled(), 1);
});

test('mountCalibrator: a grid finer than 24 px cannot be confirmed', () => {
  const { root, results } = mount({ filename: 'huge_150x100.jpg' });   // 20 px cells
  const confirm = find(root, 'cf-calib-confirm');
  assert.equal(confirm.disabled, true);
  assert.match(find(root, 'cf-calib-warn').textContent, /under 24 px/);
  fire(confirm, 'click');
  assert.equal(results.length, 0);
});
