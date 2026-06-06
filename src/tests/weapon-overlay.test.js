import { test } from 'node:test';
import assert from 'node:assert';
import {
  swingFrameAt, setActorWeapon, clearActorWeapon, drawWeaponOverlay
} from '../js/anim/cinema-sprites.js';

// ---------- swingFrameAt (pure frame-timing) ----------

test('weapon-overlay: holds frame 0 before the wind-up', () => {
  assert.strictEqual(swingFrameAt(9, 0.0, 0.55), 0);
  assert.strictEqual(swingFrameAt(9, 0.1, 0.55), 0);
});

test('weapon-overlay: reaches the last frame after settle', () => {
  assert.strictEqual(swingFrameAt(9, 1.0, 0.55), 8);
  assert.strictEqual(swingFrameAt(9, 0.9, 0.55), 8);
});

test('weapon-overlay: advances monotonically through the swing', () => {
  let prev = -1;
  for (let p = 0; p <= 1.0001; p += 0.02) {
    const f = swingFrameAt(9, p, 0.55);
    assert.ok(f >= prev - 1e-9, `frame should not go backwards at p=${p}`);
    prev = f;
  }
});

test('weapon-overlay: near the extended frame at impact', () => {
  // The hit frame should be well into the sweep (not still raised).
  const f = swingFrameAt(9, 0.55, 0.55);
  assert.ok(f > 3 && f < 8, `expected mid/late frame at impact, got ${f}`);
});

test('weapon-overlay: single-frame weapon stays on frame 0', () => {
  for (const p of [0, 0.5, 1]) assert.strictEqual(swingFrameAt(1, p, 0.5), 0);
});

// ---------- setActorWeapon / drawWeaponOverlay headless safety ----------

test('weapon-overlay: setActorWeapon returns null headless (no image loader)', async () => {
  // Node has no Image/canvas → loadImage rejects → null overlay.
  clearActorWeapon();
  const ent = { id: 'p1', equipment: { mainhand: { name: 'Longsword' } } };
  const ov = await setActorWeapon(ent);
  assert.strictEqual(ov, null);
});

test('weapon-overlay: unarmed entity → null overlay', async () => {
  const ov = await setActorWeapon({ id: 'p2', equipment: {} });
  assert.strictEqual(ov, null);
});

test('weapon-overlay: drawWeaponOverlay is a no-op with no weapon set', () => {
  clearActorWeapon();
  let calls = 0;
  const ctx = { save: () => calls++, restore: () => {}, drawImage: () => {}, set globalAlpha(v) {}, set imageSmoothingEnabled(v) {} };
  assert.doesNotThrow(() => drawWeaponOverlay(ctx, { x: 0, y: 0 }, { _t: 100, _impactAt: 50, _duration: 100 }, 3));
  assert.strictEqual(calls, 0, 'nothing drawn without a weapon overlay');
});
