import { test } from 'node:test';
import assert from 'node:assert';
import { springConfig, springStep, hipSwayAt } from '../js/anim/secondary-motion.js';

// ---------- springConfig ----------

test('springConfig: critical damping (ζ=1) gives damping = 2·sqrt(stiffness)', () => {
  const { stiffness, damping } = springConfig(1, 1);
  // ζ = damping / (2·√stiffness) should be 1
  assert.ok(Math.abs(damping / (2 * Math.sqrt(stiffness)) - 1) < 1e-9);
});

test('springConfig: higher frequency → stiffer spring', () => {
  assert.ok(springConfig(4).stiffness > springConfig(1).stiffness);
});

// ---------- springStep ----------

test('springStep: at rest on target it stays put (pure — input unchanged)', () => {
  const cfg = springConfig(2, 1);
  const state = { x: 5, v: 0 };
  const next = springStep(state, 5, 16, cfg);
  assert.strictEqual(state.x, 5);          // input not mutated
  assert.strictEqual(state.v, 0);
  assert.ok(Math.abs(next.x - 5) < 1e-9);  // stays on target
  assert.ok(Math.abs(next.v) < 1e-9);
});

test('springStep: chases a moved target and converges without blowing up', () => {
  const cfg = springConfig(3, 0.9);
  let s = { x: 0, v: 0 };
  for (let i = 0; i < 400; i++) s = springStep(s, 10, 16, cfg);
  assert.ok(Math.abs(s.x - 10) < 0.05, `converged to ${s.x}`);
  assert.ok(Math.abs(s.v) < 0.05);
});

test('springStep: lags the target (follow-through) rather than snapping', () => {
  const cfg = springConfig(2.1, 0.7);
  const one = springStep({ x: 0, v: 0 }, 8, 16, cfg);
  // after a single 16ms step it should have moved toward, but nowhere near, 8
  assert.ok(one.x > 0 && one.x < 4, `partial catch-up: ${one.x}`);
});

test('springStep: a huge dt is clamped so a backgrounded tab cannot fling it', () => {
  const cfg = springConfig(2.1, 0.7);
  const huge = springStep({ x: 0, v: 0 }, 8, 100000, cfg);
  const clamped = springStep({ x: 0, v: 0 }, 8, 32, cfg);
  assert.deepStrictEqual(huge, clamped);   // dt saturates at 32ms
});

// ---------- hipSwayAt ----------

test('hipSwayAt: stays within ±amp', () => {
  for (let t = 0; t < 20000; t += 137) {
    const v = hipSwayAt(t, 3);
    assert.ok(v >= -3 && v <= 3, `out of range at ${t}: ${v}`);
  }
});

test('hipSwayAt: non-harmonic — does not repeat on the primary period', () => {
  // golden-ratio detuning means t and t+period are not equal
  const period = 4000;
  assert.ok(Math.abs(hipSwayAt(1000, 1) - hipSwayAt(1000 + period, 1)) > 1e-3);
});

test('hipSwayAt: deterministic', () => {
  assert.strictEqual(hipSwayAt(1234, 2), hipSwayAt(1234, 2));
});
