import { test } from 'node:test';
import assert from 'node:assert';
import {
  newSequence, addKey, addEffect, sampleSprite, effectsBetween,
  insertHitPause, applyModifier, EASING
} from '../js/anim/sequence.js';

// ---------- Easing functions ----------

test('M43.0: EASING.linear is the identity', () => {
  assert.strictEqual(EASING.linear(0), 0);
  assert.strictEqual(EASING.linear(0.5), 0.5);
  assert.strictEqual(EASING.linear(1), 1);
});

test('M43.0: EASING.easeOut accelerates then decelerates toward 1', () => {
  assert.strictEqual(EASING.easeOut(0), 0);
  assert.strictEqual(EASING.easeOut(1), 1);
  // Midpoint should be > 0.5 (front-loaded)
  assert.ok(EASING.easeOut(0.5) > 0.5);
});

test('M43.0: EASING.anticipate pulls back before going forward', () => {
  assert.ok(EASING.anticipate(0.15) < 0,   // pulling back at t=0.15
    `anticipate should be negative early; got ${EASING.anticipate(0.15)}`);
  assert.ok(EASING.anticipate(0.9) > 0.5,
    `anticipate should overshoot late; got ${EASING.anticipate(0.9)}`);
});

// ---------- newSequence / addKey / addEffect ----------

test('M43.0: newSequence — empty containers, ready for keys/effects', () => {
  const seq = newSequence('test', 1000);
  assert.strictEqual(seq.duration, 1000);
  assert.deepStrictEqual(seq.keyframes, []);
  assert.deepStrictEqual(seq.effects, []);
});

test('M43.0: addKey — chains and stamps default easing', () => {
  const seq = newSequence('s');
  addKey(seq, { at: 100, actor: 'attacker', x: 10 });
  assert.strictEqual(seq.keyframes.length, 1);
  assert.strictEqual(seq.keyframes[0].easing, 'easeOut');
});

test('M43.0: addEffect — pushes effect literal', () => {
  const seq = newSequence('s');
  addEffect(seq, { at: 200, type: 'slash-arc' });
  assert.strictEqual(seq.effects[0].type, 'slash-arc');
});

// ---------- sampleSprite ----------

test('M43.0: sampleSprite — identity when no frames for actor', () => {
  const seq = newSequence('s');
  const snap = sampleSprite(seq, 'attacker', 100);
  assert.deepStrictEqual(snap, { x: 0, y: 0, rotation: 0, scale: 1, alpha: 1 });
});

test('M43.0: sampleSprite — clamps to first frame before its time', () => {
  const seq = newSequence('s');
  addKey(seq, { at: 200, actor: 'attacker', x: 30, easing: 'linear' });
  const snap = sampleSprite(seq, 'attacker', 100);
  assert.strictEqual(snap.x, 30);
});

test('M43.0: sampleSprite — clamps to last frame after its time', () => {
  const seq = newSequence('s');
  addKey(seq, { at: 100, actor: 'attacker', x: 10, easing: 'linear' });
  addKey(seq, { at: 200, actor: 'attacker', x: 50, easing: 'linear' });
  const snap = sampleSprite(seq, 'attacker', 500);
  assert.strictEqual(snap.x, 50);
});

test('M43.0: sampleSprite — linear interpolation between bracketing frames', () => {
  const seq = newSequence('s');
  addKey(seq, { at: 0,   actor: 'attacker', x: 0,  easing: 'linear' });
  addKey(seq, { at: 100, actor: 'attacker', x: 50, easing: 'linear' });
  const snap = sampleSprite(seq, 'attacker', 50);
  assert.strictEqual(snap.x, 25);    // halfway = 25 with linear easing
});

test('M43.0: sampleSprite — easeOut bows the interpolation toward 1', () => {
  const seq = newSequence('s');
  addKey(seq, { at: 0,   actor: 'attacker', x: 0 });
  addKey(seq, { at: 100, actor: 'attacker', x: 100, easing: 'easeOut' });
  const snap = sampleSprite(seq, 'attacker', 50);
  // easeOut(0.5) = 0.75
  assert.strictEqual(snap.x, 75);
});

test('M43.0: sampleSprite — separate actors are independent', () => {
  const seq = newSequence('s');
  addKey(seq, { at: 0,   actor: 'attacker', x: 0,   easing: 'linear' });
  addKey(seq, { at: 100, actor: 'attacker', x: 100, easing: 'linear' });
  addKey(seq, { at: 0,   actor: 'defender', x: 200, easing: 'linear' });
  addKey(seq, { at: 100, actor: 'defender', x: 300, easing: 'linear' });
  const a = sampleSprite(seq, 'attacker', 50);
  const d = sampleSprite(seq, 'defender', 50);
  assert.strictEqual(a.x, 50);
  assert.strictEqual(d.x, 250);
});

// ---------- effectsBetween ----------

test('M43.0: effectsBetween — collects effects within open-closed interval', () => {
  const seq = newSequence('s');
  addEffect(seq, { at: 100, type: 'a' });
  addEffect(seq, { at: 200, type: 'b' });
  addEffect(seq, { at: 300, type: 'c' });
  const got = effectsBetween(seq, 100, 250);
  assert.deepStrictEqual(got.map(e => e.type), ['b']);
});

test('M43.0: effectsBetween — boundary: at == t1 included, at == t0 excluded', () => {
  const seq = newSequence('s');
  addEffect(seq, { at: 100, type: 'a' });
  const got = effectsBetween(seq, 99, 100);
  assert.strictEqual(got.length, 1);
  const got2 = effectsBetween(seq, 100, 100);
  assert.strictEqual(got2.length, 0);
});

// ---------- insertHitPause ----------

test('M43.0: insertHitPause — shifts later keyframes + effects by duration', () => {
  const seq = newSequence('s', 1000);
  addKey(seq, { at: 100, actor: 'attacker', x: 0 });
  addKey(seq, { at: 500, actor: 'attacker', x: 50 });
  addEffect(seq, { at: 200, type: 'hit' });
  addEffect(seq, { at: 700, type: 'recover' });
  insertHitPause(seq, 300, 200);
  // Pre-300 frames untouched
  assert.strictEqual(seq.keyframes.find(k => k.x === 0).at, 100);
  assert.strictEqual(seq.effects.find(e => e.type === 'hit').at, 200);
  // Post-300 frames shifted by 200
  assert.strictEqual(seq.keyframes.find(k => k.x === 50).at, 700);
  assert.strictEqual(seq.effects.find(e => e.type === 'recover').at, 900);
  // Duration extended
  assert.strictEqual(seq.duration, 1200);
  // hit-pause event added
  assert.ok(seq.effects.some(e => e.type === 'hit-pause'));
});

// ---------- applyModifier ----------

test('M43.0: applyModifier — merges keyframes + effects from base + mod', () => {
  const base = newSequence('base');
  addEffect(base, { at: 100, type: 'slash-arc' });
  const mod  = newSequence('sneak');
  addEffect(mod, { at: 100, type: 'shadow-strike' });
  addEffect(mod, { at: 110, type: 'flash', params: { intensity: 0.4 } });
  const composed = applyModifier(base, mod);
  assert.strictEqual(composed.effects.length, 3);
  assert.ok(composed.effects.some(e => e.type === 'slash-arc'));
  assert.ok(composed.effects.some(e => e.type === 'shadow-strike'));
  assert.ok(composed.effects.some(e => e.type === 'flash'));
});

test('M43.0: applyModifier — does not mutate the base or modifier', () => {
  const base = newSequence('base');
  addEffect(base, { at: 50, type: 'x' });
  const mod  = newSequence('mod');
  addEffect(mod, { at: 75, type: 'y' });
  applyModifier(base, mod);
  assert.strictEqual(base.effects.length, 1);
  assert.strictEqual(mod.effects.length, 1);
});

test('M43.0: applyModifier — duration is max(base, mod)', () => {
  const base = newSequence('a', 1000);
  const mod  = newSequence('b', 1500);
  const out = applyModifier(base, mod);
  assert.strictEqual(out.duration, 1500);
});
