import { test } from 'node:test';
import assert from 'node:assert';
import {
  cinemaKindFor, buildSpellSequence, HEAL_COLOR
} from '../js/anim/spell-motions.js';

// ---------- cinemaKindFor ----------

test('M56.2: cinemaKindFor — maps the registry vocabulary onto cinema variants', () => {
  assert.strictEqual(cinemaKindFor({ kind: 'heal' }), 'heal');
  assert.strictEqual(cinemaKindFor({ kind: 'auto-hit' }), 'missiles');
  assert.strictEqual(cinemaKindFor({ kind: 'spell-attack' }), 'bolt');
  assert.strictEqual(cinemaKindFor({ kind: 'cantrip-save' }), 'save');
  assert.strictEqual(cinemaKindFor({ kind: 'leveled-save' }), 'save');
  assert.strictEqual(cinemaKindFor({ kind: 'leveled-save', aoe: true }), 'aoe');
  assert.strictEqual(cinemaKindFor({ kind: 'cantrip-save', aoe: true }), 'aoe');
});

test('M56.2: cinemaKindFor — total: reactive-counter, unknown, and null fall through to save', () => {
  assert.strictEqual(cinemaKindFor({ kind: 'reactive-counter' }), 'save');
  assert.strictEqual(cinemaKindFor({ kind: 'something-new' }), 'save');
  assert.strictEqual(cinemaKindFor({}), 'save');
  assert.strictEqual(cinemaKindFor(null), 'save');
});

// ---------- shared shape ----------

test('M56.2: every variant returns a fresh sequence with cast meta and a hit-pause', () => {
  for (const spell of [
    { kind: 'heal' },
    { kind: 'auto-hit', damageType: 'Force' },
    { kind: 'spell-attack', damageType: 'Fire' },
    { kind: 'leveled-save', damageType: 'Fire', aoe: true },
    { kind: 'cantrip-save', damageType: 'Radiant' }
  ]) {
    const seq = buildSpellSequence({ spell });
    assert.ok(seq, `${spell.kind}: sequence built`);
    assert.strictEqual(seq.meta.kind, 'cast');
    assert.strictEqual(seq.effects.filter(e => e.type === 'hit-pause').length, 1,
      `${spell.kind}: keeps the verdict-timing hit-pause`);
  }
});

test('M56.2: buildSpellSequence — pure: spell and outcome inputs are not mutated', () => {
  const spell = Object.freeze({ kind: 'auto-hit', damageType: 'Force', darts: 3 });
  const outcome = Object.freeze({ dmg: 10, darts: 3 });
  assert.doesNotThrow(() => buildSpellSequence({ spell, outcome }));
});

test('M56.2: damageType is lowercased from the capitalized registry values', () => {
  const seq = buildSpellSequence({ spell: { kind: 'cantrip-save', damageType: 'Radiant' } });
  const burst = seq.effects.find(e => e.type === 'burst');
  assert.strictEqual(burst.params.damageType, 'radiant');
});

// ---------- heal ----------

test('M56.2: heal — friendly meta, green glyph + sparkles, no offensive payload', () => {
  const seq = buildSpellSequence({ spell: { kind: 'heal' }, outcome: { heal: 7 } });
  assert.strictEqual(seq.meta.friendly, true);
  assert.strictEqual(seq.meta.spellKind, 'heal');
  for (const type of ['projectile', 'burst', 'shake', 'flash']) {
    assert.ok(!seq.effects.some(e => e.type === type), `heal has no ${type}`);
  }
  const glyph = seq.effects.find(e => e.type === 'glyph-rise');
  assert.strictEqual(glyph.params.damageType, 'heal');
  const sparkles = seq.effects.filter(e => e.type === 'sparkle');
  assert.ok(sparkles.length >= 3, 'heal sparkles present');
  assert.ok(sparkles.every(s => s.params.color === HEAL_COLOR));
  // No defender flinch keyframes — the target is a friend
  assert.ok(!seq.keyframes.some(k => k.actor === 'defender'));
});

// ---------- missiles ----------

test('M56.2: missiles — one projectile + burst pair per dart, staggered', () => {
  const seq = buildSpellSequence({
    spell: { kind: 'auto-hit', damageType: 'Force' },
    outcome: { dmg: 10, darts: 3 }
  });
  const projectiles = seq.effects.filter(e => e.type === 'projectile');
  const bursts = seq.effects.filter(e => e.type === 'burst');
  assert.strictEqual(projectiles.length, 3);
  assert.strictEqual(bursts.length, 3);
  // Staggered, not simultaneous
  const ats = projectiles.map(p => p.at).sort((a, b) => a - b);
  assert.ok(ats[1] > ats[0] && ats[2] > ats[1]);
  // Duration covers the last impact
  const lastBurst = Math.max(...bursts.map(b => b.at));
  assert.ok(seq.duration >= lastBurst + 200, 'duration covers the trailing dart');
  assert.strictEqual(seq.meta.darts, 3);
});

test('M56.2: missiles — dart count defaults to 1 and caps at 8', () => {
  const one = buildSpellSequence({ spell: { kind: 'auto-hit' }, outcome: {} });
  assert.strictEqual(one.effects.filter(e => e.type === 'projectile').length, 1);
  const capped = buildSpellSequence({ spell: { kind: 'auto-hit' }, outcome: { darts: 20 } });
  assert.strictEqual(capped.effects.filter(e => e.type === 'projectile').length, 8);
});

// ---------- bolt ----------

test('M56.2: bolt hit — keeps projectile, burst, shake', () => {
  const seq = buildSpellSequence({
    spell: { kind: 'spell-attack', damageType: 'Fire' },
    outcome: { dmg: 6 }
  });
  assert.ok(seq.effects.some(e => e.type === 'projectile'));
  assert.ok(seq.effects.some(e => e.type === 'burst'));
  assert.ok(seq.effects.some(e => e.type === 'shake'));
  assert.strictEqual(seq.meta.miss, false);
});

test('M56.2: bolt miss — projectile flies past with no impact payload', () => {
  const seq = buildSpellSequence({
    spell: { kind: 'spell-attack', damageType: 'Fire' },
    outcome: { dmg: 0, miss: true }
  });
  assert.ok(seq.effects.some(e => e.type === 'projectile'), 'the bolt still flies');
  for (const type of ['burst', 'shake', 'flash']) {
    assert.ok(!seq.effects.some(e => e.type === type), `miss has no ${type}`);
  }
  assert.ok(!seq.keyframes.some(k => k.actor === 'defender'), 'no defender flinch on a miss');
  assert.strictEqual(seq.meta.miss, true);
});

// ---------- save ----------

test('M56.2: save — manifests on the target: no projectile; saved reads weaker', () => {
  const failed = buildSpellSequence({
    spell: { kind: 'cantrip-save', damageType: 'Radiant' },
    outcome: { dmg: 8, saved: false }
  });
  assert.ok(!failed.effects.some(e => e.type === 'projectile'));
  const fullBurst = failed.effects.find(e => e.type === 'burst');
  const saved = buildSpellSequence({
    spell: { kind: 'cantrip-save', damageType: 'Radiant' },
    outcome: { dmg: 4, saved: true }
  });
  const weakBurst = saved.effects.find(e => e.type === 'burst');
  assert.ok((weakBurst.params.radius ?? 50) < (fullBurst.params.radius ?? 50),
    'saved burst is smaller than failed burst');
  const weakShake = saved.effects.find(e => e.type === 'shake');
  assert.ok(weakShake.params.amplitude <= 2, 'saved shake is gentler');
});

// ---------- aoe ----------

test('M56.2: aoe — no projectile, wide double burst, heavy shake', () => {
  const seq = buildSpellSequence({
    spell: { kind: 'leveled-save', damageType: 'Fire', aoe: true },
    outcome: { dmg: 20, saved: false }
  });
  assert.ok(!seq.effects.some(e => e.type === 'projectile'));
  const bursts = seq.effects.filter(e => e.type === 'burst');
  assert.strictEqual(bursts.length, 2, 'primary blast + trailing shockwave');
  assert.ok(bursts.every(b => (b.params.radius ?? 0) >= 70), 'AoE bursts go wide');
  const shake = seq.effects.find(e => e.type === 'shake');
  assert.ok(shake.params.amplitude >= 6, 'AoE shake is heavy');
});
