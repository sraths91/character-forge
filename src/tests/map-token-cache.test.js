// M64 E5 / M7 — Safari-safe recolour (applyFilterMatrix), the token bake
// cache, steady-state frame cost, and the cinema cache's appearance hash.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { applyFilterMatrix, parseCssFilter, colorMatrixFor } from '../js/sprite/filter-matrix.js';
import { createTokenCache } from '../js/map/token-cache.js';
import { projectBattleView } from '../js/map/view.js';
import { createCamera } from '../js/map/camera.js';
import { renderBattleScene, prepareBattleView } from '../js/sprite/compositor.js';
import { visualHashOf } from '../js/anim/cinema-sprites.js';
import { recordingCanvas } from './helpers/mock-canvas.js';

const px = (...rgba) => Uint8ClampedArray.from(rgba);
const close = (got, want, tol = 1) => {
  assert.equal(got.length, want.length);
  for (let i = 0; i < got.length; i++) assert.ok(Math.abs(got[i] - want[i]) <= tol, `[${i}] ${got[i]} vs ${want[i]} (${[...got]} vs ${want})`);
};

// ---- applyFilterMatrix -----------------------------------------------------

test('parseCssFilter: reads the five functions with units, skips the rest', () => {
  assert.deepEqual(parseCssFilter('saturate(1.4) brightness(85%) sepia(0.15) hue-rotate(-15deg) opacity(.35) blur(2px)'), [
    { op: 'saturate', amount: 1.4 }, { op: 'brightness', amount: 0.85 }, { op: 'sepia', amount: 0.15 },
    { op: 'hue-rotate', amount: -15 }, { op: 'opacity', amount: 0.35 }
  ]);
  assert.deepEqual(parseCssFilter('hue-rotate(0.5turn)'), [{ op: 'hue-rotate', amount: 180 }]);
  assert.deepEqual(parseCssFilter(null), []);
  assert.deepEqual(parseCssFilter('none'), []);
});

test('applyFilterMatrix: W3C matrix fixtures (saturate, hue-rotate, brightness, sepia, opacity)', () => {
  close(applyFilterMatrix(px(255, 0, 0, 255), 'saturate(0)'), [54, 54, 54, 255]);
  close(applyFilterMatrix(px(255, 0, 0, 255), 'hue-rotate(180deg)'), [0, 109, 109, 255]);
  close(applyFilterMatrix(px(200, 100, 50, 255), 'brightness(0.5)'), [100, 50, 25, 255]);
  close(applyFilterMatrix(px(255, 255, 255, 255), 'sepia(1)'), [255, 255, 239, 255]);
  close(applyFilterMatrix(px(10, 20, 30, 255), 'opacity(0.35)'), [10, 20, 30, 89]);
  // Identity amounts change nothing.
  close(applyFilterMatrix(px(12, 34, 56, 200), 'saturate(1) hue-rotate(0deg) brightness(1) sepia(0) opacity(1)'), [12, 34, 56, 200]);
});

test('applyFilterMatrix: chained pipeline tints (down, poisoned) match the sequential spec math', () => {
  // 'down' = saturate(0) brightness(0.55): luminance 117.7 → ×0.55 = 64.7
  close(applyFilterMatrix(px(200, 100, 50, 255), 'saturate(0) brightness(0.55)'), [65, 65, 65, 255]);
  // Each step clamps to [0,1] before the next (oversaturation then darken).
  const poisoned = applyFilterMatrix(px(200, 120, 90, 255), 'saturate(1.6) hue-rotate(70deg) brightness(0.95)');
  let r = 200 / 255, g = 120 / 255, b = 90 / 255;
  for (const f of parseCssFilter('saturate(1.6) hue-rotate(70deg)')) {
    const m = colorMatrixFor(f);
    [r, g, b] = [m[0] * r + m[1] * g + m[2] * b, m[3] * r + m[4] * g + m[5] * b, m[6] * r + m[7] * g + m[8] * b]
      .map(v => Math.min(1, Math.max(0, v)));
  }
  close(poisoned, [r * 0.95 * 255, g * 0.95 * 255, b * 0.95 * 255, 255]);
  assert.ok(poisoned[1] > poisoned[0], 'poisoned reads green');
});

test('applyFilterMatrix: pure, skips transparent pixels', () => {
  const input = px(255, 0, 0, 255, 9, 9, 9, 0);
  const out = applyFilterMatrix(input, 'saturate(0)');
  assert.deepEqual([...input], [255, 0, 0, 255, 9, 9, 9, 0], 'input untouched');
  assert.deepEqual([...out.slice(4)], [9, 9, 9, 0]);
});

test('compositor battle path no longer touches ctx.filter', () => {
  const src = readFileSync(new URL('../js/sprite/compositor.js', import.meta.url), 'utf8');
  assert.ok(!/ctx\.filter\s*=/.test(src), 'ctx.filter assignment remains');
});

// ---- token cache -----------------------------------------------------------

function fakeBaker(frameCycle = 2) {
  const calls = [];
  return {
    calls,
    bake: async (character, opts) => { calls.push({ character, opts }); return { canvas: { id: calls.length, w: 64 }, frameCycle }; }
  };
}

test('token cache: key covers look, direction, anim, frame, HP bucket and conditions', () => {
  const cache = createTokenCache(fakeBaker());
  const t = { appearanceKey: 'a:1', hpState: 'healthy', conditions: [], worstCondition: null, tempHp: false, concentration: null };
  const k = cache.keyFor(t, { direction: 'south', frameIdx: 0 });
  assert.notEqual(cache.keyFor({ ...t, hpState: 'down' }), k);
  assert.notEqual(cache.keyFor({ ...t, worstCondition: 'poisoned', conditions: ['poisoned'] }), k);
  assert.notEqual(cache.keyFor(t, { direction: 'east' }), k);
  assert.notEqual(cache.keyFor(t, { anim: 'slash' }), k);
  assert.notEqual(cache.keyFor({ ...t, appearanceKey: 'a:2' }), k);
  assert.equal(cache.keyFor(t, { frameIdx: 0 }), k);
});

test('token cache: bakes once per key, learns the frame cycle, dedupes in-flight bakes', async () => {
  const baker = fakeBaker(2);
  const cache = createTokenCache(baker);
  const t = { appearanceKey: 'a:1', hpState: 'healthy', conditions: [] };
  const k0 = cache.keyFor(t, { frameIdx: 0 });
  const [a, b] = await Promise.all([cache.ensure(k0, {}, {}), cache.ensure(k0, {}, {})]);
  assert.equal(a, b);
  assert.equal(baker.calls.length, 1);
  // Cycle 2 learned: frame 1000 maps onto frame 0.
  assert.equal(cache.keyFor(t, { frameIdx: 1000 }), cache.keyFor(t, { frameIdx: 0 }));
  assert.notEqual(cache.keyFor(t, { frameIdx: 1001 }), cache.keyFor(t, { frameIdx: 0 }));
  assert.equal(cache.get(k0), a);
  cache.invalidate('a:1');
  assert.equal(cache.get(k0), null);
});

test('token cache: LRU bound and failed bakes', async () => {
  const cache = createTokenCache({ ...fakeBaker(), maxEntries: 2 });
  for (const n of [1, 2, 3]) await cache.ensure(`a:${n}|south|idle|0|x`, {}, {});
  assert.equal(cache.size, 2);
  assert.equal(cache.get('a:1|south|idle|0|x'), null);
  const errors = [];
  const orig = console.error;
  console.error = (m) => errors.push(m);
  try {
    const bad = createTokenCache({ bake: async () => { throw new Error('no image'); } });
    assert.equal(await bad.ensure('k|south|idle|0|x', {}, {}), null);
    assert.equal(bad.stats.failures, 1);
  } finally { console.error = orig; }
  assert.match(errors[0], /battle\.token\.bake_failed/);
});

// ---- steady-state frame cost -----------------------------------------------

function fourteenTokenView() {
  const state = JSON.parse(readFileSync(new URL('./fixtures/contracts/encounter-state.valid.json', import.meta.url), 'utf8'));
  state.grid = { cols: 30, rows: 20, cellFt: 5, flankingEnabled: false };
  state.map = { kind: 'color', color: '#333' };
  const tmpl = Object.values(state.entities);
  state.entities = {};
  state.initiative = [];
  for (let i = 0; i < 14; i++) {
    const e = JSON.parse(JSON.stringify(tmpl[i % tmpl.length]));
    e.id = `e${i}`; e.pos = { col: i * 2, row: i % 5 }; e.concentration = null;
    state.entities[e.id] = e;
  }
  return projectBattleView(state, { 'fighter-l5': 'a:fighter', 'wizard-l5': 'a:wizard' });
}

test('steady state: ≤ 1 drawImage per token and 0 getImageData per frame (counting mock)', async () => {
  const view = fourteenTokenView();
  const baker = fakeBaker(2);
  const tokenCache = createTokenCache(baker);
  const local = {
    camera: createCamera({ zoom: 1, viewW: 1280, viewH: 800, dpr: 2 }),
    tokenCache, resolveAppearance: (key) => ({ look: key }), frameIdx: 0, now: 0
  };
  // Warm-up covers the idle cycle (2 frames); after that every frame is a hit.
  await prepareBattleView(view, local);
  await prepareBattleView(view, { ...local, frameIdx: 1 });
  const bakesAfterWarmup = baker.calls.length;
  for (const frameIdx of [0, 1, 2, 3]) {
    const { canvas, count } = recordingCanvas();
    const res = renderBattleScene(canvas, view, { ...local, frameIdx });
    assert.equal(res.cellCount, 14);
    assert.equal(res.pendingBakes, 0, `frame ${frameIdx} fully cached`);
    assert.ok(count('drawImage') <= 14, `drawImage ${count('drawImage')} for 14 tokens`);
    assert.equal(count('getImageData'), 0);
  }
  assert.equal(baker.calls.length, bakesAfterWarmup, 'no bakes in steady state');
});

test('cold frame: misses draw placeholders, bake in the background and request a redraw', async () => {
  const view = fourteenTokenView();
  const tokenCache = createTokenCache(fakeBaker(1));
  let redraws = 0;
  const local = { tokenCache, resolveAppearance: () => ({}), requestRedraw: () => { redraws++; }, now: 0 };
  const { canvas, count } = recordingCanvas();
  const res = renderBattleScene(canvas, view, local);
  assert.equal(res.pendingBakes, 14);
  assert.equal(count('drawImage'), 0);
  assert.ok(count('arc') >= 14, 'placeholders');
  await new Promise(r => setTimeout(r, 0));
  assert.ok(redraws > 0);
  const second = recordingCanvas();
  renderBattleScene(second.canvas, view, local);
  assert.equal(second.count('drawImage'), 14);
});

// ---- cinema cache key ------------------------------------------------------

test('cinema: visualHashOf changes with equipment and status, not with id or name', () => {
  const pc = { id: 'p1', name: 'A', equipment: { mainhand: { name: 'Mace' } }, hp: { current: 20, max: 20 }, conditions: [] };
  const h = visualHashOf(pc);
  assert.equal(visualHashOf({ ...pc, id: 'p2', name: 'B' }), h);
  assert.notEqual(visualHashOf({ ...pc, equipment: { mainhand: { name: 'Warhammer' } } }), h);
  assert.notEqual(visualHashOf({ ...pc, hp: { current: 0, max: 20 } }), h);
  assert.notEqual(visualHashOf({ ...pc, conditions: ['poisoned'] }), h);
});
