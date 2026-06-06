import { test } from 'node:test';
import assert from 'node:assert';
import { idlePoseAt } from '../js/anim/idle-pose.js';

test('idle-pose: returns the full transform shape', () => {
  const p = idlePoseAt(0);
  for (const k of ['bobY', 'scaleX', 'scaleY', 'swayX', 'rot', 'shadowScale', 'shadowAlpha']) {
    assert.ok(Number.isFinite(p[k]), `${k} finite`);
  }
});

test('idle-pose: deterministic for a given time', () => {
  assert.deepStrictEqual(idlePoseAt(1234), idlePoseAt(1234));
});

test('idle-pose: amplitudes stay small (it is an IDLE, not a jump)', () => {
  let maxBob = 0, maxSway = 0, maxRot = 0;
  for (let t = 0; t < 10000; t += 17) {
    const p = idlePoseAt(t);
    maxBob = Math.max(maxBob, Math.abs(p.bobY));
    maxSway = Math.max(maxSway, Math.abs(p.swayX));
    maxRot = Math.max(maxRot, Math.abs(p.rot));
    // scale stays within a couple percent of 1
    assert.ok(p.scaleX > 0.97 && p.scaleX < 1.03, `scaleX in range @${t}`);
    assert.ok(p.scaleY > 0.97 && p.scaleY < 1.03, `scaleY in range @${t}`);
    assert.ok(p.shadowAlpha > 0 && p.shadowAlpha < 0.5, `shadowAlpha in range @${t}`);
  }
  assert.ok(maxBob < 0.03, 'bob under 3% of height');
  assert.ok(maxSway < 0.03, 'sway under 3% of width');
  assert.ok(maxRot < 0.03, 'lean under ~1.7°');
});

test('idle-pose: breathing actually oscillates (not static)', () => {
  const samples = [];
  for (let t = 0; t < 3000; t += 50) samples.push(idlePoseAt(t).scaleY);
  const min = Math.min(...samples), max = Math.max(...samples);
  assert.ok(max - min > 0.01, 'scaleY varies over a breath cycle');
});

test('idle-pose: shadow shrinks as the body rises', () => {
  // find a frame near peak inhale (max scaleY) and confirm shadow is smaller there
  let peak = { scaleY: -Infinity }, trough = { scaleY: Infinity };
  for (let t = 0; t < 4000; t += 13) {
    const p = idlePoseAt(t);
    if (p.scaleY > peak.scaleY) peak = p;
    if (p.scaleY < trough.scaleY) trough = p;
  }
  assert.ok(peak.shadowScale < trough.shadowScale, 'shadow smaller at peak inhale');
});
