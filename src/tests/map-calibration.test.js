// M64 E5 / M3 — calibrated image backgrounds: cell rects, the clipped
// source rect, and grid alignment through drawMapImage at three zooms.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { cellRectInImage, imagePointToCell, imageSourceRect, normalizeCalib } from '../js/map/calibration.js';
import { drawMapImage, drawGridLines } from '../js/scene/map-render.js';
import { validateEncounterState } from '../js/shared/encounter-state.js';

const MAP = Object.freeze({
  kind: 'image', imageId: 'h', imgW: 3000, imgH: 2000,
  calib: Object.freeze({ cellPx: 100, offsetX: 37, offsetY: 12 })
});

function mockCtx() {
  const calls = [];
  return {
    calls,
    save() {}, restore() {},
    beginPath() {}, moveTo(...a) { calls.push(['moveTo', ...a]); }, lineTo() {}, stroke() { calls.push(['stroke']); },
    drawImage(...a) { calls.push(['drawImage', ...a]); },
    set imageSmoothingEnabled(v) {}, set strokeStyle(v) {}, set lineWidth(v) {}
  };
}

test('cellRectInImage: every cell round-trips through imagePointToCell', () => {
  for (let r = 0; r < 19; r++) {
    for (let c = 0; c < 29; c++) {
      const rect = cellRectInImage(MAP, c, r);
      assert.deepEqual(rect, { x: 37 + c * 100, y: 12 + r * 100, w: 100, h: 100 });
      assert.deepEqual(imagePointToCell(MAP, rect.x + 50, rect.y + 50), { col: c, row: r });
      assert.deepEqual(imagePointToCell(MAP, rect.x, rect.y), { col: c, row: r }, 'top-left belongs to the cell');
    }
  }
  assert.equal(cellRectInImage({}, 0, 0), null);
});

test('imageSourceRect: full grid inside the image maps 1:1 onto world cells', () => {
  const r = imageSourceRect(MAP, 29, 19, 64);
  assert.deepEqual(r, { sx: 37, sy: 12, sw: 2900, sh: 1900, dx: 0, dy: 0, dw: 29 * 64, dh: 19 * 64 });
});

test('imageSourceRect: clips cells that fall off the image edge, keeping the mapping', () => {
  // 30 cols × 100 px from x=37 runs to 3037 > 3000: the last 37 px are off-image.
  const r = imageSourceRect(MAP, 30, 20, 64);
  assert.equal(r.sx + r.sw, 3000);
  assert.equal(r.sy + r.sh, 2000);
  // Linear mapping preserved: image x → world x = (x - 37) * 0.64.
  assert.ok(Math.abs(r.dw - (3000 - 37) * 0.64) < 1e-9);
  const neg = imageSourceRect({ calib: { cellPx: 50, offsetX: -20, offsetY: 0 }, imgW: 500, imgH: 500 }, 4, 4, 64);
  assert.equal(neg.sx, 0);
  assert.ok(Math.abs(neg.dx - 20 * (64 / 50)) < 1e-9, 'destination shifted by the clipped amount');
  assert.equal(imageSourceRect(MAP, 0, 5, 64), null);
  assert.equal(imageSourceRect({ calib: { cellPx: 100, offsetX: 5000, offsetY: 0 }, imgW: 3000, imgH: 2000 }, 3, 3, 64), null);
});

test('drawMapImage: a calibrated map draws exactly the source rect (mock ctx)', () => {
  const ctx = mockCtx();
  const img = { width: 3000, height: 2000 };
  assert.equal(drawMapImage(ctx, img, MAP, 29, 19, 64), true);
  const draws = ctx.calls.filter(c => c[0] === 'drawImage');
  assert.equal(draws.length, 1);
  assert.deepEqual(draws[0].slice(1), [img, 37, 12, 2900, 1900, 0, 0, 29 * 64, 19 * 64]);
});

test('drawMapImage: painted grid lines align with game grid lines within 1 px at zoom 0.5, 1 and 3', () => {
  const img = { width: 3000, height: 2000 };
  for (const cellWorld of [64, 48]) {
    const ctx = mockCtx();
    drawMapImage(ctx, img, MAP, 30, 20, cellWorld);
    const [, , sx, sy, sw, sh, dx, dy, dw, dh] = ctx.calls.find(c => c[0] === 'drawImage');
    for (const zoom of [0.5, 1, 3]) {
      for (let c = 0; c <= 29; c++) {
        const imageLineX = MAP.calib.offsetX + c * MAP.calib.cellPx;
        const drawnX = (dx + (imageLineX - sx) * (dw / sw)) * zoom;
        const gameX = c * cellWorld * zoom;
        assert.ok(Math.abs(drawnX - gameX) < 1, `col ${c} zoom ${zoom}: ${drawnX} vs ${gameX}`);
      }
      for (let r = 0; r <= 19; r++) {
        const imageLineY = MAP.calib.offsetY + r * MAP.calib.cellPx;
        const drawnY = (dy + (imageLineY - sy) * (dh / sh)) * zoom;
        assert.ok(Math.abs(drawnY - r * cellWorld * zoom) < 1);
      }
    }
  }
});

test('drawMapImage: uncalibrated legacy images keep the cover-fit', () => {
  const ctx = mockCtx();
  drawMapImage(ctx, { width: 1000, height: 500 }, { kind: 'image' }, 10, 10, 64);
  const [, , x, y, w, h] = ctx.calls.find(c => c[0] === 'drawImage');
  assert.equal(h, 640);
  assert.equal(w, 1280);
  assert.equal(x, (640 - 1280) / 2);
  assert.equal(y, 0);
  assert.equal(drawMapImage(ctx, null, MAP, 1, 1, 64), false);
});

test('drawGridLines: one stroke with cols+1 + rows+1 lines on half-pixel centres', () => {
  const ctx = mockCtx();
  drawGridLines(ctx, 4, 3, 64);
  const moves = ctx.calls.filter(c => c[0] === 'moveTo');
  assert.equal(moves.length, 5 + 4);
  assert.deepEqual(moves[1].slice(1), [64.5, 0]);
  assert.equal(ctx.calls.filter(c => c[0] === 'stroke').length, 1);
});

test('normalizeCalib: offsets wrap into [0, cellPx)', () => {
  assert.deepEqual(normalizeCalib({ cellPx: 100, offsetX: 137, offsetY: -88 }), { cellPx: 100, offsetX: 37, offsetY: 12 });
});

test('shared contract: image map with kind/url/color validates; unknown kind rejected', () => {
  const state = JSON.parse(readFileSync(new URL('./fixtures/contracts/encounter-state.valid.json', import.meta.url), 'utf8'));
  state.map = { ...state.map, kind: 'image', url: '/uploads/maps/h.webp', color: '#222' };
  assert.deepEqual(validateEncounterState(state).errors, []);
  state.map = { kind: 'generated', biome: 'forest', seed: 7, color: '#2f4f2f', preset: null };
  assert.deepEqual(validateEncounterState(state).errors, []);
  state.map = { kind: 'svg' };
  assert.equal(validateEncounterState(state).ok, false);
});
