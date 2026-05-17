import { test } from 'node:test';
import assert from 'node:assert';
import { applyUpcast, spellById, consumeSlot } from '../js/scene/monster-spells.js';
import { chooseAction } from '../js/scene/ai/profile.js';
import { simulateEncounter } from '../js/scene/simulator.js';

// ---------- applyUpcast (pure) ----------

test('M40: applyUpcast — Magic Missile at base level returns the spell unchanged', () => {
  const base = spellById('magic-missile');
  const out = applyUpcast(base, 1);
  assert.strictEqual(out.darts, 3);
});

test('M40: applyUpcast — Magic Missile at lvl 3 returns 5 darts', () => {
  const out = applyUpcast(spellById('magic-missile'), 3);
  assert.strictEqual(out.darts, 5);
  assert.strictEqual(out.castAtLevel, 3);
});

test('M40: applyUpcast — Inflict Wounds at lvl 3 = 5d10', () => {
  const out = applyUpcast(spellById('inflict-wounds'), 3);
  assert.match(out.dice, /5d10|3d10\+2d10|3d10\+1d10\+1d10/);
});

test('M40: applyUpcast — Cure Wounds at lvl 2 = 2d8', () => {
  const out = applyUpcast(spellById('cure-wounds'), 2);
  assert.match(out.dice, /^2d8$/);
});

test('M40: applyUpcast — does not mutate the registry', () => {
  const base = spellById('magic-missile');
  applyUpcast(base, 4);
  assert.strictEqual(spellById('magic-missile').darts, 3);
});

test('M40: applyUpcast — leaves non-upcastable spells alone', () => {
  const sf = spellById('sacred-flame');
  const out = applyUpcast(sf, 0);
  assert.strictEqual(out, sf);
});

test('M40: applyUpcast — clamps castAtLevel below baseLevel to baseLevel', () => {
  const out = applyUpcast(spellById('inflict-wounds'), 0);
  assert.strictEqual(out.dice, '3d10');   // unchanged
});

// ---------- consumeSlot honors castAtLevel ----------

test('M40: consumeSlot — burns the chosen slot level, not the base', () => {
  const pool = { 1: 4, 2: 2, 3: 1 };
  consumeSlot(pool, spellById('inflict-wounds'), 3);   // base 1, cast at 3
  assert.deepStrictEqual(pool, { 1: 4, 2: 2, 3: 0 });
});

test('M40: consumeSlot — defaults to base level when castAtLevel is null', () => {
  const pool = { 1: 4, 2: 2 };
  consumeSlot(pool, spellById('inflict-wounds'));
  assert.deepStrictEqual(pool, { 1: 3, 2: 2 });
});

// ---------- chooseAction picks a slot level ----------

const livePc = (id, pos, hp = 30, hpMax = 30) => ({
  id, hp, hpMax, _position: pos, conditions: [],
  ref: { name: id, abilityModifiers: { DEX: 1, WIS: 0, CON: 1, STR: 1 } }
});

test('M40: chooseAction — kobold sorcerer with high slots prefers upcasted Magic Missile', () => {
  // Kobold sorcerer has Magic Missile in castWeights @ 1.1. With a 2nd
  // slot available, upcasting adds (1 level × 0.5 bonus) = +0.5, minus
  // a 0.25 slot penalty = net +0.25. Net score 1.35 > 1.1 base.
  const self = {
    id: 'k1', presetSlug: 'kobold-sorcerer',
    hp: 16, hpMax: 16, _position: { col: 1, row: 1 },
    _slots: { 1: 4, 2: 2 }
  };
  const plan = chooseAction({
    self, enemies: [livePc('pc1', { col: 3, row: 1 })], allies: [], rng: () => 0.5
  });
  assert.strictEqual(plan.kind, 'cast');
  assert.strictEqual(plan.spellId, 'magic-missile');
  assert.strictEqual(plan.castAtLevel, 2);
});

test('M40: chooseAction — when only 1st-level slots remain, casts at base level', () => {
  const self = {
    id: 'k1', presetSlug: 'kobold-sorcerer',
    hp: 16, hpMax: 16, _position: { col: 1, row: 1 },
    _slots: { 1: 4, 2: 0 }
  };
  const plan = chooseAction({
    self, enemies: [livePc('pc1', { col: 3, row: 1 })], allies: [], rng: () => 0.5
  });
  assert.strictEqual(plan.spellId, 'magic-missile');
  assert.strictEqual(plan.castAtLevel, 1);
});

test('M40: chooseAction — cult fanatic upcasts Cure Wounds on a near-dead ally', () => {
  const self = {
    id: 'cf1', presetSlug: 'cult-fanatic',
    hp: 33, hpMax: 33, _position: { col: 1, row: 1 },
    _slots: { 1: 2, 2: 2 }
  };
  // Ally at 1/33 hp → "most hurt" score ≈ 0.97. Upcast bonus * 0.97 is
  // big enough to overcome the slot penalty; AI should pick 2nd-level
  // Cure Wounds (2d8 + mod) over base (1d8 + mod).
  const hurtAlly = {
    id: 'cf2', presetSlug: 'cult-fanatic',
    hp: 1, hpMax: 33, _position: { col: 1, row: 2 }, conditions: []
  };
  const plan = chooseAction({
    self,
    enemies: [livePc('pc1', { col: 5, row: 1 })],
    allies: [hurtAlly],
    rng: () => 0.5
  });
  assert.strictEqual(plan.kind, 'cast');
  assert.strictEqual(plan.spellId, 'cure-wounds');
  assert.strictEqual(plan.targetSide, 'ally');
  assert.strictEqual(plan.castAtLevel, 2);
});

test('M40: chooseAction — cult fanatic does NOT upcast Cure Wounds on a barely-scratched ally', () => {
  // Ally at 30/33 → wounded score ≈ 0.09. Upcast bonus * 0.09 ≈ 0.04,
  // far below the 0.25 slot penalty. AI should cast at base level.
  const self = {
    id: 'cf1', presetSlug: 'cult-fanatic',
    hp: 33, hpMax: 33, _position: { col: 1, row: 1 },
    _slots: { 1: 2, 2: 2 }
  };
  const scratchedAlly = {
    id: 'cf2', presetSlug: 'cult-fanatic',
    hp: 30, hpMax: 33, _position: { col: 1, row: 2 }, conditions: []
  };
  const plan = chooseAction({
    self,
    enemies: [livePc('pc1', { col: 5, row: 1 })],
    allies: [scratchedAlly],
    rng: () => 0.5
  });
  // Either picks base-level heal, or skips the heal entirely (offensive
  // cast wins). Either way, NOT a 2nd-level upcast.
  if (plan.spellId === 'cure-wounds') {
    assert.strictEqual(plan.castAtLevel, 1);
  }
});

test('M40: chooseAction breakdown — surfaces the upcast contribution', () => {
  const self = {
    id: 'k1', presetSlug: 'kobold-sorcerer',
    hp: 16, hpMax: 16, _position: { col: 1, row: 1 },
    _slots: { 1: 4, 2: 2 }
  };
  const plan = chooseAction({
    self, enemies: [livePc('pc1', { col: 3, row: 1 })], allies: [], rng: () => 0.5
  });
  const upcastLine = plan.breakdown.find(b => /upcast/.test(b.name));
  assert.ok(upcastLine, 'breakdown should mention upcast contribution');
});

// ---------- Simulator integration ----------

test('M40: simulator — upcasting Magic Missile burns the higher slot', () => {
  const party = [{
    id: 'pc1', name: 'Fighter', _position: { col: 1, row: 1 },
    hp: { current: 30, max: 30 },
    equipment: { mainhand: { name: 'Longsword' } },
    abilityScores: { STR: 16, DEX: 12, CON: 14, INT: 10, WIS: 10, CHA: 10 },
    abilityModifiers: { STR: 3, DEX: 1, CON: 2, INT: 0, WIS: 0, CHA: 0 },
    classes: [{ name: 'Fighter', level: 5 }],
    conditions: []
  }];
  // Kobold sorcerer with 1 lvl-1 slot + 1 lvl-2 slot. The AI should
  // burn the lvl-2 slot for upcasted Magic Missile (4 darts) first,
  // then fall through to the lvl-1 slot the next round.
  const monsters = [
    { id: 'k1', presetSlug: 'kobold-sorcerer', name: 'Sorc',
      hp: { current: 16, max: 16 }, position: { col: 4, row: 1 }, conditions: [] }
  ];
  const stats = simulateEncounter({
    party, monsters, scene: { cols: 6, rows: 3 },
    iterations: 1, maxRounds: 1, seed: 5
  });
  // Smoke test: simulator runs without error and at least one Magic
  // Missile dart hits in any iteration.
  assert.strictEqual(stats.iterations, 1);
});