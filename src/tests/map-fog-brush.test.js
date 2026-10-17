// M64 E5 / phase 1.5 — DM fog reveal brush and the server-side
// applyFogPaint helper. Gate: a stroke's payload applied with
// applyFogPaint reveals exactly the stroked cells.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attachFogBrush } from '../js/map/fog-brush.js';
import { attachCellBrush } from '../js/map/terrain-brush.js';
import { createCamera, worldToScreen } from '../js/map/camera.js';
import { createFog, applyFogPaint, isRevealed, revealedCount, FOG_PAINT_OPS } from '../js/map/fog.js';
import { deepFreeze } from './helpers/mock-canvas.js';

function evt(type, props) {
  const e = new globalThis.Event(type, { cancelable: true });
  for (const [k, v] of Object.entries(props)) Object.defineProperty(e, k, { value: v });
  return e;
}
function fakeCanvas() {
  const c = new EventTarget();
  c.getBoundingClientRect = () => ({ left: 0, top: 0, width: 640, height: 480 });
  c.setPointerCapture = () => {};
  c.releasePointerCapture = () => {};
  return c;
}
const cam = createCamera({ zoom: 1, viewW: 640, viewH: 480 });
const at = (col, row) => worldToScreen(cam, col * 64 + 32, row * 64 + 32);
function stroke(canvas, cells, { button = 0, shiftKey = false, id = 1, cancel = false } = {}) {
  const [first, ...rest] = cells;
  const p0 = at(...first);
  canvas.dispatchEvent(evt('pointerdown', { pointerId: id, button, shiftKey, clientX: p0.x, clientY: p0.y }));
  for (const c of rest) {
    const p = at(...c);
    canvas.dispatchEvent(evt('pointermove', { pointerId: id, clientX: p.x, clientY: p.y }));
  }
  canvas.dispatchEvent(evt(cancel ? 'pointercancel' : 'pointerup', { pointerId: id }));
}

test('fog brush: one reveal payload per stroke, gap-filled; right/shift hides; bounds and cancel respected', () => {
  const canvas = fakeCanvas();
  const paints = [];
  const previews = [];
  const opts = { onPreview: (cells, op) => previews.push([cells.length, op]) };
  const detach = attachFogBrush(canvas, cam, { cols: 6, rows: 4 }, p => paints.push(p), opts);
  stroke(canvas, [[0, 0], [3, 0]]);
  assert.deepEqual(paints[0], { cells: [{ col: 0, row: 0 }, { col: 1, row: 0 }, { col: 2, row: 0 }, { col: 3, row: 0 }], op: 'reveal' });
  assert.deepEqual(previews.at(-1), [0, 'reveal'], 'preview cleared at stroke end');
  stroke(canvas, [[1, 1]], { button: 2 });
  stroke(canvas, [[2, 1]], { shiftKey: true });
  assert.deepEqual(paints.slice(1).map(p => p.op), ['hide', 'hide']);
  opts.op = 'hide';
  stroke(canvas, [[0, 3], [8, 3]]);   // runs off the 6-wide grid
  assert.equal(paints[3].op, 'hide');
  assert.deepEqual(paints[3].cells.map(c => c.col), [0, 1, 2, 3, 4, 5]);
  stroke(canvas, [[4, 2]], { cancel: true });
  assert.equal(paints.length, 4, 'cancelled stroke emits nothing');
  opts.enabled = false;
  stroke(canvas, [[5, 2]]);
  assert.equal(paints.length, 4, 'disabled');
  detach();
  opts.enabled = true;
  stroke(canvas, [[5, 2]]);
  assert.equal(paints.length, 4, 'detached');
});

test('applyFogPaint: pure reveal/hide of the stroked cells; bad payloads are no-ops', () => {
  assert.deepEqual([...FOG_PAINT_OPS], ['reveal', 'hide']);
  const grid = { cols: 6, rows: 4 };
  const fog = deepFreeze(createFog(6, 4));
  const shown = applyFogPaint(fog, { cells: [{ col: 0, row: 0 }, { col: 5, row: 3 }, { col: 9, row: 9 }], op: 'reveal' }, grid);
  assert.equal(revealedCount(shown, 6, 4), 2, 'out-of-grid cell skipped');
  assert.equal(isRevealed(shown, 6, 5, 3), true);
  assert.equal(revealedCount(fog, 6, 4), 0, 'input untouched');
  const hidden = applyFogPaint(shown, { cells: [{ col: 0, row: 0 }], op: 'hide' }, grid);
  assert.equal(isRevealed(hidden, 6, 0, 0), false);
  assert.equal(isRevealed(hidden, 6, 5, 3), true);
  assert.equal(revealedCount(applyFogPaint(null, { cells: [{ col: 1, row: 1 }], op: 'reveal' }, grid), 6, 4), 1, 'null fog starts hidden');
  assert.equal(applyFogPaint(fog, { cells: [{ col: 1, row: 1 }], op: 'set' }, grid), fog);
  assert.equal(applyFogPaint(fog, { op: 'reveal' }, grid), fog);
  assert.equal(applyFogPaint(fog, { cells: [], op: 'reveal' }, { cols: 0, rows: 0 }), fog);
});

test('gate: brush payload → applyFogPaint reveals exactly the stroked cells', () => {
  const canvas = fakeCanvas();
  let fog = createFog(6, 4);
  attachFogBrush(canvas, cam, () => ({ cols: 6, rows: 4 }), p => { fog = applyFogPaint(fog, p, { cols: 6, rows: 4 }); });
  stroke(canvas, [[1, 1], [1, 3]]);
  assert.equal(revealedCount(fog, 6, 4), 3);
  for (const r of [1, 2, 3]) assert.equal(isRevealed(fog, 6, 1, r), true);
});

test('attachCellBrush: begin can refuse a stroke', () => {
  const canvas = fakeCanvas();
  const ends = [];
  attachCellBrush(canvas, cam, () => ({ cols: 4, rows: 4 }), { begin: () => null, end: (m, c) => ends.push(c) });
  stroke(canvas, [[0, 0]]);
  assert.equal(ends.length, 0);
});
