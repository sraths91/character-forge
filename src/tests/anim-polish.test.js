import { test } from 'node:test';
import assert from 'node:assert';
import { applyPolish } from '../js/anim/polish.js';
import { buildMotion } from '../js/anim/weapon-motions.js';

// ---------- Identity / no-op ----------

test('M43.5: applyPolish — null seq passes through', () => {
  assert.strictEqual(applyPolish(null, {}), null);
});

test('M43.5: applyPolish — empty ctx still returns a NEW sequence', () => {
  const seq = buildMotion('sword-slash');
  const out = applyPolish(seq, {});
  assert.notStrictEqual(out, seq);
  assert.strictEqual(out.duration, seq.duration);
  // Pure: original untouched
  const beforeEf = seq.effects.length;
  out.effects.push({ at: 0, type: 'shake', params: {} });
  assert.strictEqual(seq.effects.length, beforeEf);
});

test('M43.5: applyPolish — meta is tagged so downstream knows polish ran', () => {
  const seq = buildMotion('sword-slash');
  const out = applyPolish(seq, {});
  assert.strictEqual(out.meta.polish, true);
});

// ---------- Crit ----------

test('M43.5: crit adds a longer hit-pause + bright flash + extra shake', () => {
  const seq = buildMotion('sword-slash');
  const out = applyPolish(seq, { crit: true });
  const newPause = out.effects.find(e => e.type === 'hit-pause' && e.params?._polish === 'crit');
  assert.ok(newPause, 'crit should add a tagged hit-pause');
  assert.ok(newPause.params.duration >= 200);
  assert.ok(out.effects.some(e => e.type === 'flash' && e.params.intensity >= 0.5));
  assert.strictEqual(out.meta.crit, true);
});

test('M43.5: no crit → no crit-tagged hit-pause', () => {
  const seq = buildMotion('sword-slash');
  const out = applyPolish(seq, {});
  assert.ok(!out.effects.some(e => e.params?._polish === 'crit'));
});

// ---------- Big-hit zoom ----------

test('M43.5: big hit (≥25% max HP) adds a zoom effect', () => {
  const seq = buildMotion('sword-slash');
  const out = applyPolish(seq, { dmg: 10, defenderHp: 30 });
  const zoom = out.effects.find(e => e.type === 'zoom');
  assert.ok(zoom, 'expected a zoom effect');
  assert.ok(zoom.params.scale > 1);
});

test('M43.5: small hit (<25% max HP) does NOT add zoom', () => {
  const seq = buildMotion('sword-slash');
  const out = applyPolish(seq, { dmg: 3, defenderHp: 100 });
  assert.ok(!out.effects.some(e => e.type === 'zoom'));
});

test('M43.5: crit forces zoom even on small dmg', () => {
  const seq = buildMotion('sword-slash');
  const out = applyPolish(seq, { dmg: 2, defenderHp: 100, crit: true });
  assert.ok(out.effects.some(e => e.type === 'zoom'));
});

test('M43.5: killing blow forces zoom', () => {
  const seq = buildMotion('sword-slash');
  const out = applyPolish(seq, { dmg: 4, defenderHp: 100, killing: true });
  assert.ok(out.effects.some(e => e.type === 'zoom'));
  assert.ok(out.effects.some(e => e.type === 'flash' && e.params._polish !== 'crit'));
  assert.strictEqual(out.meta.killing, true);
});

// ---------- Magical / silvered ----------

test('M43.5: magical weapon adds glyph-rise + sparkles', () => {
  const seq = buildMotion('sword-slash');
  const out = applyPolish(seq, { magical: true, damageType: 'force' });
  assert.ok(out.effects.some(e => e.type === 'glyph-rise' && e.params._polish === 'magical'));
  assert.ok(out.effects.filter(e => e.type === 'sparkle').length >= 1);
  assert.strictEqual(out.meta.magical, true);
});

test('M43.5: magical sparkles use damage-type color', () => {
  const seq = buildMotion('sword-slash');
  const cold = applyPolish(seq, { magical: true, damageType: 'cold' });
  const sparkle = cold.effects.find(e => e.type === 'sparkle');
  assert.strictEqual(sparkle.params.color, '#7dd3fc');
});

test('M43.5: silvered material adds metallic glint flash + sparkles', () => {
  const seq = buildMotion('sword-slash');
  const out = applyPolish(seq, { material: 'silvered' });
  assert.ok(out.effects.some(e => e.type === 'flash' && e.params.intensity <= 0.4));
  const sparkle = out.effects.find(e => e.type === 'sparkle');
  assert.ok(sparkle && sparkle.params.color === '#e2e8f0');
  assert.strictEqual(out.meta.silvered, true);
});

// ---------- Level scaling ----------

test('M43.5: level <5 produces a baseline polish (no tier-2 burst)', () => {
  const seq = buildMotion('sword-slash');
  const out = applyPolish(seq, { level: 3 });
  assert.ok(!out.effects.some(e => e.params?._polish === 'tier-2'));
});

test('M43.5: level ≥5 adds a tier-2 burst', () => {
  const seq = buildMotion('sword-slash');
  const out = applyPolish(seq, { level: 5 });
  assert.ok(out.effects.some(e => e.params?._polish === 'tier-2'));
});

test('M43.5: level ≥17 adds extra sparkle particles', () => {
  const seq = buildMotion('sword-slash');
  const lo = applyPolish(seq, { level: 11 });
  const hi = applyPolish(seq, { level: 17 });
  const loSparkles = lo.effects.filter(e => e.type === 'sparkle').length;
  const hiSparkles = hi.effects.filter(e => e.type === 'sparkle').length;
  assert.ok(hiSparkles > loSparkles,
    `lvl 17 should add sparkles vs lvl 11; ${loSparkles} → ${hiSparkles}`);
});

test('M43.5: polish stacks — crit + magical + lvl 17 + killing', () => {
  const seq = buildMotion('sword-slash');
  const out = applyPolish(seq, {
    level: 17, crit: true, magical: true, damageType: 'radiant',
    dmg: 80, defenderHp: 80, killing: true
  });
  assert.ok(out.effects.some(e => e.type === 'zoom'));
  assert.ok(out.effects.some(e => e.type === 'glyph-rise'));
  assert.ok(out.effects.filter(e => e.type === 'sparkle').length >= 2);
  assert.ok(out.effects.some(e => e.params?._polish === 'crit'));
  assert.ok(out.effects.some(e => e.params?._polish === 'tier-2'));
  assert.strictEqual(out.meta.crit, true);
  assert.strictEqual(out.meta.magical, true);
  assert.strictEqual(out.meta.killing, true);
  assert.strictEqual(out.meta.bigHit, true);
});

// ---------- Duration ----------

test('M43.5: duration extends to cover any late-added effects', () => {
  const seq = buildMotion('sword-slash');
  const out = applyPolish(seq, { crit: true, level: 17 });
  const maxAt = out.effects.reduce((m, e) => Math.max(m, e.at), 0);
  assert.ok(out.duration >= maxAt, 'duration must cover the latest effect');
});
