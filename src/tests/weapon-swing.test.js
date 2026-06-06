import { test } from 'node:test';
import assert from 'node:assert';
import {
  SWING_RIGS, swingRigFor, sampleSwing, swingTrail, swingArcSpan
} from '../js/anim/weapon-swing.js';

// ---------- rig lookup ----------

test('weapon-swing: swingRigFor maps motion ids', () => {
  assert.strictEqual(swingRigFor('sword-slash').id, 'sword-slash');
  assert.strictEqual(swingRigFor('axe-cleave').id, 'axe-cleave');
  assert.strictEqual(swingRigFor('fist-jab'), null);
  // unknown → sword-slash default
  assert.strictEqual(swingRigFor('nonsense').id, 'sword-slash');
});

test('weapon-swing: every non-null rig has the required fields', () => {
  for (const [id, rig] of Object.entries(SWING_RIGS)) {
    if (rig === null) continue;
    assert.strictEqual(rig.id, id);
    for (const f of ['rest', 'windup', 'strike', 'follow', 'lunge']) {
      assert.ok(Number.isFinite(rig[f]), `${id}.${f}`);
    }
    assert.ok(rig.grip && Number.isFinite(rig.grip.y), `${id}.grip`);
  }
});

// ---------- sampleSwing ----------

test('weapon-swing: null rig → identity transform', () => {
  const s = sampleSwing(null, 0.5, 0.5);
  assert.deepStrictEqual({ angle: s.angle, dx: s.dx, dy: s.dy, scale: s.scale }, { angle: 0, dx: 0, dy: 0, scale: 1 });
});

test('weapon-swing: rests before the wind-up window', () => {
  const rig = swingRigFor('sword-slash');
  const s = sampleSwing(rig, 0.0, 0.55);
  assert.strictEqual(s.angle, rig.rest);
  assert.strictEqual(s.dx, 0);
});

test('weapon-swing: lands the strike angle AT impact', () => {
  const rig = swingRigFor('sword-slash');
  const atImpact = sampleSwing(rig, 0.55, 0.55);
  // At p === impactP the sweep has just completed → strike angle.
  assert.ok(Math.abs(atImpact.angle - rig.strike) < 1e-6, `got ${atImpact.angle}`);
  assert.ok(atImpact.dx > 0, 'lunged forward at impact');
});

test('weapon-swing: angle sweeps monotonically windup→strike through the sweep', () => {
  const rig = swingRigFor('sword-slash');
  const ip = 0.55;
  // Across the sweep window the angle should move steadily toward strike.
  let prev = sampleSwing(rig, ip - rig.sweepWidth, ip).angle;
  let increasing = true;
  for (let p = ip - rig.sweepWidth; p <= ip; p += 0.01) {
    const a = sampleSwing(rig, p, ip).angle;
    if (a < prev - 1e-9) increasing = false;
    prev = a;
  }
  // sword rest/windup are negative, strike positive → angle increases.
  assert.ok(increasing, 'sword slash should rotate forward through the sweep');
});

test('weapon-swing: returns to rest after recovery', () => {
  const rig = swingRigFor('axe-cleave');
  const s = sampleSwing(rig, 1.0, 0.5);
  assert.ok(Math.abs(s.angle - rig.rest) < 1e-6);
  assert.strictEqual(s.scale, 1);
});

test('weapon-swing: thrust lunges far with little rotation', () => {
  const rig = swingRigFor('lance-thrust');
  const s = sampleSwing(rig, 0.55, 0.55);
  assert.ok(s.dx >= 0.9, 'big forward lunge');
  assert.ok(Math.abs(rig.strike - rig.rest) < 0.5, 'minimal rotation');
});

test('weapon-swing: deterministic', () => {
  const rig = swingRigFor('sword-slash');
  assert.deepStrictEqual(sampleSwing(rig, 0.4, 0.55), sampleSwing(rig, 0.4, 0.55));
});

// ---------- swingTrail ----------

test('weapon-swing: trail empty outside the fast sweep', () => {
  const rig = swingRigFor('sword-slash');
  assert.deepStrictEqual(swingTrail(rig, 0.0, 0.55), []);
  assert.deepStrictEqual(swingTrail(rig, 0.95, 0.55), []);
});

test('weapon-swing: trail produced during the sweep, fading by age', () => {
  const rig = swingRigFor('sword-slash');
  const tr = swingTrail(rig, 0.54, 0.55, 5);
  assert.ok(tr.length > 0, 'trail during sweep');
  for (let i = 1; i < tr.length; i++) {
    assert.ok(tr[i].alpha <= tr[i - 1].alpha, 'alpha fades with age');
  }
});

test('weapon-swing: no-trail rigs produce no smear', () => {
  const rig = swingRigFor('staff-cast');
  assert.deepStrictEqual(swingTrail(rig, 0.5, 0.5), []);
});

// ---------- swingArcSpan ----------

test('weapon-swing: slash has a wider arc than thrust', () => {
  assert.ok(swingArcSpan(swingRigFor('sword-slash')) > swingArcSpan(swingRigFor('lance-thrust')));
  assert.strictEqual(swingArcSpan(null), 0);
});
