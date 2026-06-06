import { test } from 'node:test';
import assert from 'node:assert';
import { GRADE, applyAtmosphere } from '../js/scene/map-grade.js';
import { listBiomes } from '../js/scene/map-generator.js';

// ---------- GRADE table ----------

test('map-grade: GRADE covers every biome with valid fields', () => {
  for (const slug of listBiomes()) {
    const g = GRADE[slug];
    assert.ok(g, `missing grade for ${slug}`);
    assert.match(g.shadow, /^#[0-9a-f]{6}$/i, `${slug} shadow`);
    assert.match(g.sun, /^#[0-9a-f]{6}$/i, `${slug} sun`);
    assert.ok(g.sat > 0 && g.sat < 2, `${slug} sat range`);
    assert.ok(g.bloom >= 0 && g.bloom <= 1, `${slug} bloom range`);
    assert.ok(g.shadowStrength >= 0 && g.shadowStrength <= 1, `${slug} shadowStrength`);
  }
});

// ---------- applyAtmosphere headless safety ----------

test('map-grade: applyAtmosphere is a safe no-op without getImageData', () => {
  // A mock ctx lacking getImageData must not throw (the headless path).
  const ctx = { createRadialGradient: () => ({ addColorStop() {} }), fillRect() {}, save() {}, restore() {} };
  assert.doesNotThrow(() => applyAtmosphere(ctx, { biome: 'forest' }, 100, 100));
});

test('map-grade: applyAtmosphere tolerates null inputs', () => {
  assert.doesNotThrow(() => applyAtmosphere(null, { biome: 'grass' }, 10, 10));
  assert.doesNotThrow(() => applyAtmosphere({ getImageData: () => {} }, null, 10, 10));
});

test('map-grade: unknown biome falls back to grass grade (no throw)', () => {
  const ctx = { /* no getImageData → no-op */ };
  assert.doesNotThrow(() => applyAtmosphere(ctx, { biome: 'nope' }, 50, 50));
});

// ---------- Real-canvas grade math (exercised when getImageData exists) ----------

test('map-grade: a fake pixel buffer ctx runs the tone pass without error', () => {
  // Minimal ctx that supports the getImageData/putImageData contract so
  // the tone-grade loop executes (no real canvas needed).
  const W = 8, H = 8;
  const data = new Uint8ClampedArray(W * H * 4).fill(120);
  for (let i = 3; i < data.length; i += 4) data[i] = 255;
  let putCalled = false;
  const ctx = {
    getImageData: () => ({ data, width: W, height: H }),
    putImageData: () => { putCalled = true; },
    createRadialGradient: () => ({ addColorStop() {} }),
    save() {}, restore() {}, fillRect() {},
    set globalCompositeOperation(v) {}, set fillStyle(v) {},
    set globalAlpha(v) {}, set imageSmoothingEnabled(v) {},
    drawImage() {}
  };
  // makeBuffer returns null in node → bloom early-returns; grade + sun run.
  assert.doesNotThrow(() => applyAtmosphere(ctx, { biome: 'forest' }, W, H));
  assert.ok(putCalled, 'tone grade should write the graded pixels back');
});
