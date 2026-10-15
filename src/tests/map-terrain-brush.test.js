// M64 E5 / M6 — terrain overlay pass and the DM paint brush. Gate:
// painting changes the next findPath.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attachTerrainBrush } from '../js/map/terrain-brush.js';
import { createCamera, worldToScreen } from '../js/map/camera.js';
import { createTerrain, applyTerrainPaint, encodeTerrain, flagAt, TERRAIN_FLAGS } from '../js/map/terrain.js';
import { findPath } from '../js/scene/grid-legality.js';
import { paintTerrainOverlay } from '../js/scene/map-render.js';
import { renderBattleScene } from '../js/sprite/compositor.js';
import { recordingCanvas } from './helpers/mock-canvas.js';

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
function stroke(canvas, cells, { button = 0, shiftKey = false, id = 1 } = {}) {
  const [first, ...rest] = cells;
  const p0 = at(...first);
  canvas.dispatchEvent(evt('pointerdown', { pointerId: id, button, shiftKey, clientX: p0.x, clientY: p0.y }));
  for (const c of rest) {
    const p = at(...c);
    canvas.dispatchEvent(evt('pointermove', { pointerId: id, clientX: p.x, clientY: p.y }));
  }
  canvas.dispatchEvent(evt('pointerup', { pointerId: id }));
}

test('brush: one stroke emits one deduplicated payload with gap-filled cells', () => {
  const canvas = fakeCanvas();
  const paints = [];
  const opts = { flag: TERRAIN_FLAGS.BLOCKED };
  const detach = attachTerrainBrush(canvas, cam, createTerrain(8, 6), p => paints.push(p), opts);
  stroke(canvas, [[1, 1], [1, 1], [4, 1]]);   // jump of 3 cells is filled in
  assert.equal(paints.length, 1);
  assert.equal(paints[0].op, 'set');
  assert.equal(paints[0].flag, 1);
  assert.deepEqual(paints[0].cells, [{ col: 1, row: 1 }, { col: 2, row: 1 }, { col: 3, row: 1 }, { col: 4, row: 1 }]);
  opts.flag = TERRAIN_FLAGS.DIFFICULT;          // palette change applies to the next stroke
  stroke(canvas, [[0, 0]]);
  assert.equal(paints[1].flag, 2);
  detach();
  stroke(canvas, [[2, 2]]);
  assert.equal(paints.length, 2, 'detached');
});

test('brush: right button or Shift erases; out-of-bounds cells are dropped', () => {
  const canvas = fakeCanvas();
  const paints = [];
  attachTerrainBrush(canvas, cam, () => createTerrain(3, 3), p => paints.push(p), { flag: 16 });
  stroke(canvas, [[0, 0], [5, 0]], { button: 2 });
  assert.equal(paints[0].op, 'clear');
  assert.deepEqual(paints[0].cells.map(c => c.col), [0, 1, 2]);
  stroke(canvas, [[1, 1]], { shiftKey: true });
  assert.equal(paints[1].op, 'clear');
});

test('brush: painting a wall changes the next findPath (M6 gate)', () => {
  const canvas = fakeCanvas();
  let terrain = createTerrain(6, 3);
  attachTerrainBrush(canvas, cam, () => terrain, p => { terrain = applyTerrainPaint(terrain, p); }, { flag: TERRAIN_FLAGS.BLOCKED });
  const before = findPath(terrain, null, { col: 0, row: 1 }, { col: 5, row: 1 });
  assert.equal(before.costFt, 25);
  stroke(canvas, [[3, 0], [3, 2]]);
  assert.equal(flagAt(terrain, 3, 1), 1);
  assert.equal(findPath(terrain, null, { col: 0, row: 1 }, { col: 5, row: 1 }), null, 'wall seals the room');
  stroke(canvas, [[3, 2]], { button: 2 });
  assert.equal(findPath(terrain, null, { col: 0, row: 1 }, { col: 5, row: 1 }).costFt, 25, 'gap reopened');
});

test('overlay: DM sees every flag, players only movement flags', () => {
  let t = createTerrain(4, 1);
  t = applyTerrainPaint(t, { cells: [{ col: 0, row: 0 }], flag: 1 });
  t = applyTerrainPaint(t, { cells: [{ col: 1, row: 0 }], flag: 2 });
  t = applyTerrainPaint(t, { cells: [{ col: 2, row: 0 }], flag: 4 });
  t = applyTerrainPaint(t, { cells: [{ col: 3, row: 0 }], flag: 16 });
  const { ctx } = recordingCanvas();
  assert.equal(paintTerrainOverlay(ctx, t, 64, { mode: 'dm' }), 4);
  assert.equal(paintTerrainOverlay(ctx, t, 64, { mode: 'player' }), 2);
  assert.equal(paintTerrainOverlay(ctx, t, 64, { mode: 'dm', range: { c0: 2, c1: 3, r0: 0, r1: 0 } }), 2);
});

test('renderer: terrain overlay pass runs after the grid and before tokens', async () => {
  const terrain = encodeTerrain(applyTerrainPaint(createTerrain(4, 3), { cells: [{ col: 2, row: 1 }], flag: 1 }));
  const view = {
    v: 1, grid: { cols: 4, rows: 3, cellFt: 5 }, map: { kind: 'color', color: '#222' }, terrain, fog: null,
    activeId: null, tokens: [{ id: 't', kind: 'pc', side: 'party', name: 'T', col: 0, row: 0, appearanceKey: 'x', hpState: 'healthy', conditions: [], hidden: false }]
  };
  const { canvas, calls } = recordingCanvas();
  await renderBattleScene(canvas, view, { dm: { showTerrain: true }, resolveAppearance: () => null, now: 0 });
  const idx = (pred) => calls.findIndex(pred);
  const gridStroke = idx(c => c[0] === 'stroke');
  const terrainFill = idx(c => c[0] === 'fillRect' && c[1] === 128 && c[2] === 64);
  const tokenArc = idx(c => c[0] === 'arc');
  assert.ok(gridStroke >= 0 && terrainFill > gridStroke && tokenArc > terrainFill, `${gridStroke} < ${terrainFill} < ${tokenArc}`);
  const { canvas: c2, calls: calls2 } = recordingCanvas();
  await renderBattleScene(c2, view, { resolveAppearance: () => null, now: 0 });
  assert.equal(calls2.some(c => c[0] === 'fillRect' && c[1] === 128 && c[2] === 64), false, 'hidden unless toggled');
});
