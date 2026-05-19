import { test } from 'node:test';
import assert from 'node:assert';
import { bezierAt, bezierTangent } from '../js/anim/cinema.js';
import { buildMotion } from '../js/anim/weapon-motions.js';

// ---------- Pure Bézier helpers ----------

test('M44.4: bezierAt — t=0 returns p0; t=1 returns p2', () => {
  const p0 = { x: 0,  y: 0 };
  const p1 = { x: 50, y: -40 };
  const p2 = { x: 100, y: 0 };
  assert.deepStrictEqual(bezierAt(0, p0, p1, p2), p0);
  assert.deepStrictEqual(bezierAt(1, p0, p1, p2), p2);
});

test('M44.4: bezierAt — t=0.5 is above the midpoint of p0..p2', () => {
  const p0 = { x: 0,   y: 0 };
  const p1 = { x: 50,  y: -40 };   // control point above (-Y is up)
  const p2 = { x: 100, y: 0 };
  const mid = bezierAt(0.5, p0, p1, p2);
  // Y at t=0.5 of a quadratic = (p0.y + 2*p1.y + p2.y) / 4 = -20
  assert.strictEqual(mid.x, 50);
  assert.strictEqual(mid.y, -20);
});

test('M44.4: bezierTangent — points downstream at t=0', () => {
  const p0 = { x: 0,   y: 0 };
  const p1 = { x: 50,  y: -40 };
  const p2 = { x: 100, y: 0 };
  const t0 = bezierTangent(0, p0, p1, p2);
  // dP/dt at t=0 = 2(p1-p0) = (100, -80)
  assert.strictEqual(t0.x, 100);
  assert.strictEqual(t0.y, -80);
});

test('M44.4: bezierTangent — points downstream at t=1', () => {
  const p0 = { x: 0,   y: 0 };
  const p1 = { x: 50,  y: -40 };
  const p2 = { x: 100, y: 0 };
  const t1 = bezierTangent(1, p0, p1, p2);
  // dP/dt at t=1 = 2(p2-p1) = (100, 80)
  assert.strictEqual(t1.x, 100);
  assert.strictEqual(t1.y, 80);
});

test('M44.4: bezierTangent — at t=0.5 has zero Y for a symmetric arc', () => {
  // When p1 is directly between p0 and p2 in X with a Y offset, the
  // tangent at the apex (t=0.5) points purely along X.
  const p0 = { x: 0,   y: 0 };
  const p1 = { x: 50,  y: -40 };
  const p2 = { x: 100, y: 0 };
  const tMid = bezierTangent(0.5, p0, p1, p2);
  // dP/dt at 0.5 = (p2.x - p0.x, p2.y - p0.y) = (100, 0)
  assert.strictEqual(tMid.y, 0);
  assert.ok(tMid.x > 0);
});

// ---------- Weapon motion sequences carry arc heights ----------

test('M44.4: bow-draw projectile carries a high arcHeight', () => {
  const seq = buildMotion('bow-draw');
  const projectile = seq.effects.find(e => e.type === 'projectile');
  assert.ok(projectile, 'bow-draw should emit a projectile effect');
  assert.ok(projectile.params.arcHeight >= 40,
    `expected bow arc height ≥ 40; got ${projectile.params.arcHeight}`);
});

test('M44.4: staff-cast projectile arcs moderately (lower than a bow)', () => {
  const bow = buildMotion('bow-draw').effects.find(e => e.type === 'projectile');
  const staff = buildMotion('staff-cast').effects.find(e => e.type === 'projectile');
  assert.ok(staff && bow);
  assert.ok(staff.params.arcHeight < bow.params.arcHeight,
    `staff (${staff.params.arcHeight}) should arc less than bow (${bow.params.arcHeight})`);
  assert.ok(staff.params.arcHeight > 0,
    'staff cast still arcs visibly — not a flat line');
});
