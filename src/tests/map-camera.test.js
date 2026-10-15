// M64 E5 / M4 — viewport camera: inverse transforms, pickCell at zoom
// 0.5/1/3, zoom-about-cursor, clamping, fit, canvas sizing caps, the DOM
// controls (fake canvas), and the renderer's camera transform.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  WORLD_CELL_PX, MAX_CANVAS_PIXELS, createCamera, worldToScreen, screenToWorld, pickCell, zoomAt,
  panBy, clampCamera, fitToGrid, canvasPixelRatio, sizeCanvasToViewport, cameraTransform,
  visibleCellRange, attachCameraControls
} from '../js/map/camera.js';
import { renderBattleScene } from '../js/sprite/compositor.js';

const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

test('camera: screenToWorld inverts worldToScreen at zoom 0.5, 1 and 3', () => {
  for (const zoom of [0.5, 1, 3]) {
    const cam = createCamera({ x: -37.5, y: 112.25, zoom, viewW: 800, viewH: 600 });
    for (const [wx, wy] of [[0, 0], [64, 64], [1234.5, -77.25], [-500, 9000]]) {
      const s = worldToScreen(cam, wx, wy);
      const w = screenToWorld(cam, s.x, s.y);
      assert.ok(near(w.x, wx, 1e-9) && near(w.y, wy, 1e-9), `zoom ${zoom} (${wx},${wy})`);
    }
  }
});

test('camera: pickCell returns the cell drawn under the pointer at zoom 0.5, 1 and 3', () => {
  const rect = { left: 100, top: 40 };
  for (const zoom of [0.5, 1, 3]) {
    const cam = createCamera({ x: -10, y: 20, zoom, viewW: 800, viewH: 600 });
    for (let col = 0; col < 12; col++) {
      for (let row = 0; row < 9; row++) {
        // Centre of the cell, projected to client coordinates.
        const s = worldToScreen(cam, (col + 0.5) * WORLD_CELL_PX, (row + 0.5) * WORLD_CELL_PX);
        assert.deepEqual(pickCell(s.x + rect.left, s.y + rect.top, cam, WORLD_CELL_PX, rect), { col, row });
        // Just inside the top-left corner still belongs to the cell.
        const tl = worldToScreen(cam, col * WORLD_CELL_PX + 0.01, row * WORLD_CELL_PX + 0.01);
        assert.deepEqual(pickCell(tl.x + rect.left, tl.y + rect.top, cam, WORLD_CELL_PX, rect), { col, row });
      }
    }
  }
  assert.deepEqual(pickCell(-5, -5, createCamera()), { col: -1, row: -1 }, 'outside cells are returned for the caller to bound');
});

test('camera: zoomAt keeps the world point under the cursor fixed and clamps zoom', () => {
  const cam = createCamera({ x: 100, y: 50, zoom: 1, minZoom: 0.5, maxZoom: 3 });
  const before = screenToWorld(cam, 300, 200);
  const z = zoomAt(cam, 300, 200, 2);
  const after = screenToWorld(z, 300, 200);
  assert.equal(z.zoom, 2);
  assert.ok(near(before.x, after.x) && near(before.y, after.y));
  assert.equal(zoomAt(cam, 0, 0, 100).zoom, 3);
  assert.equal(zoomAt(cam, 0, 0, 0.001).zoom, 0.5);
  assert.equal(cam.zoom, 1, 'pure: input untouched');
});

test('camera: panBy moves the map with the drag', () => {
  const p = panBy(createCamera({ x: 0, y: 0, zoom: 2 }), 40, -20);
  assert.equal(p.x, -20);
  assert.equal(p.y, 10);
});

test('camera: clampCamera centres a small world and bounds a big one', () => {
  const small = clampCamera(createCamera({ x: 999, y: -999, zoom: 1, viewW: 1000, viewH: 800 }), 640, 448);
  assert.equal(small.x, (640 - 1000) / 2);
  assert.equal(small.y, (448 - 800) / 2);
  const big = clampCamera(createCamera({ x: 99999, y: -99999, zoom: 1, viewW: 800, viewH: 600 }), 2560, 1920);
  assert.equal(big.x, 2560 - 400);
  assert.equal(big.y, -300);
});

test('camera: fitToGrid shows the whole grid, centred', () => {
  const cam = fitToGrid(createCamera({ viewW: 1000, viewH: 500, minZoom: 0.1, maxZoom: 4 }), 40, 30);
  assert.ok(near(cam.zoom, 500 / (30 * 64)));
  const tl = worldToScreen(cam, 0, 0);
  const br = worldToScreen(cam, 40 * 64, 30 * 64);
  assert.ok(tl.x >= -1e-9 && br.x <= 1000 + 1e-9 && near(tl.y, 0, 1e-6) && near(br.y, 500, 1e-6));
  assert.ok(near(tl.x + br.x, 1000, 1e-6), 'centred horizontally');
  const range = visibleCellRange(cam, 40, 30);
  assert.deepEqual(range, { c0: 0, c1: 39, r0: 0, r1: 29 });
});

test('camera: canvas pixel ratio caps at 2 and at the 16.7 MP iOS limit', () => {
  assert.equal(canvasPixelRatio(800, 600, 3), 2);
  assert.equal(canvasPixelRatio(800, 600, 1), 1);
  const r = canvasPixelRatio(4000, 3000, 2);
  assert.ok(4000 * r * 3000 * r <= MAX_CANVAS_PIXELS + 1);
});

test('camera: a 40x30 map renders into a viewport-sized canvas at every zoom (≤ 16.7 MP)', async () => {
  const scene = { cols: 40, rows: 30, cellSize: 64, scale: 3, map: { kind: 'color', color: '#333' }, grid: { visible: true } };
  for (const zoom of [0.5, 1, 3]) {
    const { canvas } = fakeCanvas();
    const camera = createCamera({ zoom, viewW: 1440, viewH: 900, dpr: 3 });
    await renderBattleScene(canvas, [], scene, { camera });
    assert.equal(canvas.width, 2880);
    assert.equal(canvas.height, 1800);
    assert.ok(canvas.width * canvas.height <= MAX_CANVAS_PIXELS);
  }
  // Legacy call (no camera) still sizes the canvas to the whole map at scene.scale.
  const legacy = fakeCanvas();
  await renderBattleScene(legacy.canvas, [], { ...scene, cols: 10, rows: 7 }, {});
  assert.equal(legacy.canvas.width, 10 * 64 * 3);
});

test('camera: sizeCanvasToViewport only writes width/height when they change', () => {
  let writes = 0;
  const c = { _w: 0, _h: 0 };
  Object.defineProperty(c, 'width', { get() { return this._w; }, set(v) { writes++; this._w = v; } });
  Object.defineProperty(c, 'height', { get() { return this._h; }, set(v) { writes++; this._h = v; } });
  assert.equal(sizeCanvasToViewport(c, 400, 300, 2).resized, true);
  assert.equal(writes, 2);
  assert.equal(sizeCanvasToViewport(c, 400, 300, 2).resized, false);
  assert.equal(writes, 2);
});

test('renderer: applies the camera as a world→device transform', async () => {
  const { canvas, ctx } = fakeCanvas();
  const camera = createCamera({ x: 32, y: -16, zoom: 1.5, viewW: 600, viewH: 400, dpr: 2 });
  const scene = { cols: 8, rows: 6, cellSize: 64, scale: 3, map: { kind: 'color', color: '#333' }, grid: { visible: false } };
  await renderBattleScene(canvas, [], scene, { camera });
  const expected = cameraTransform(camera, 2);
  const drawTransform = ctx.transforms.find(t => t[0] !== 1 || t[4] !== 0);
  assert.ok(drawTransform.every((v, i) => near(v, expected[i])), `${drawTransform} vs ${expected}`);
  // The background fill covers the world rect (64 world units per cell).
  const fill = ctx.calls.find(k => k[0] === 'fillRect');
  assert.deepEqual(fill.slice(1), [0, 0, 8 * 64, 6 * 64]);
});

test('attachCameraControls: wheel zooms about the cursor, drag pans, detach unhooks', () => {
  const { canvas } = fakeCanvas();
  const cam = createCamera({ zoom: 1, viewW: 800, viewH: 600 });
  let changes = 0;
  const detach = attachCameraControls(canvas, cam, () => { changes++; });
  assert.equal(canvas.style.touchAction, 'none');
  const anchor = screenToWorld(cam, 200, 100);
  canvas.dispatchEvent(evt('wheel', { clientX: 210, clientY: 120, deltaY: -100, deltaMode: 0 }));
  assert.ok(cam.zoom > 1);
  const after = screenToWorld(cam, 200, 100);
  assert.ok(near(anchor.x, after.x, 1e-6) && near(anchor.y, after.y, 1e-6));
  const x0 = cam.x;
  canvas.dispatchEvent(evt('pointerdown', { pointerId: 1, pointerType: 'mouse', button: 1, clientX: 110, clientY: 120 }));
  canvas.dispatchEvent(evt('pointermove', { pointerId: 1, pointerType: 'mouse', clientX: 150, clientY: 120 }));
  canvas.dispatchEvent(evt('pointerup', { pointerId: 1, pointerType: 'mouse' }));
  assert.ok(near(cam.x, x0 - 40 / cam.zoom));
  // A plain left drag is left for token moves.
  const x1 = cam.x;
  canvas.dispatchEvent(evt('pointerdown', { pointerId: 2, pointerType: 'mouse', button: 0, clientX: 110, clientY: 120 }));
  canvas.dispatchEvent(evt('pointermove', { pointerId: 2, pointerType: 'mouse', clientX: 200, clientY: 120 }));
  assert.equal(cam.x, x1);
  const n = changes;
  detach();
  canvas.dispatchEvent(evt('wheel', { clientX: 210, clientY: 120, deltaY: -100, deltaMode: 0 }));
  assert.equal(changes, n);
  assert.equal(canvas.style.touchAction, '');
});

test('attachCameraControls: two-finger pinch zooms', () => {
  const { canvas } = fakeCanvas();
  const cam = createCamera({ zoom: 1, viewW: 800, viewH: 600 });
  const detach = attachCameraControls(canvas, cam, () => {});
  const t = (type, id, x, y) => canvas.dispatchEvent(evt(type, { pointerId: id, pointerType: 'touch', button: 0, clientX: x, clientY: y }));
  t('pointerdown', 1, 300, 300);
  t('pointerdown', 2, 400, 300);
  t('pointermove', 2, 500, 300);   // distance 100 → 200
  assert.ok(near(cam.zoom, 2, 1e-9));
  detach();
});

// ---- fakes -----------------------------------------------------------------

function evt(type, props) {
  const e = new globalThis.Event(type, { cancelable: true });
  for (const [k, v] of Object.entries(props)) Object.defineProperty(e, k, { value: v });
  return e;
}

function fakeCanvas() {
  const calls = [];
  const transforms = [];
  const ctx = {
    calls, transforms,
    setTransform(...a) { transforms.push(a); },
    clearRect(...a) { calls.push(['clearRect', ...a]); },
    fillRect(...a) { calls.push(['fillRect', ...a]); },
    save() {}, restore() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {},
    drawImage(...a) { calls.push(['drawImage', ...a]); },
    set fillStyle(v) {}, set strokeStyle(v) {}, set lineWidth(v) {}, set imageSmoothingEnabled(v) {}, set globalAlpha(v) {}
  };
  const canvas = new EventTarget();
  canvas.width = 0;
  canvas.height = 0;
  canvas.style = {};
  canvas.getContext = () => ctx;
  canvas.getBoundingClientRect = () => ({ left: 10, top: 20, width: 800, height: 600 });
  canvas.setPointerCapture = () => {};
  canvas.releasePointerCapture = () => {};
  return { canvas, ctx };
}
