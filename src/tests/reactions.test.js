import { test } from 'node:test';
import assert from 'node:assert';
import {
  resetReaction, resetReactionsForAll, hasReactionAvailable, consumeReaction,
  detectOpportunityAttacks, detectPolearmEntryOAs,
  shouldCastShield, consumeShield, hasShieldSpell, lvl1SlotsForPc,
  hasSentinel, hasPolearmMaster, isPolearmWeapon
} from '../js/scene/reactions.js';

// ---------- Reaction budget ----------

test('M33.0: hasReactionAvailable defaults to true', () => {
  assert.strictEqual(hasReactionAvailable({ id: 'a' }), true);
});

test('M33.0: consumeReaction makes hasReactionAvailable return false until reset', () => {
  const e = { id: 'a' };
  consumeReaction(e);
  assert.strictEqual(hasReactionAvailable(e), false);
  resetReaction(e);
  assert.strictEqual(hasReactionAvailable(e), true);
});

test('M33.0: hasReactionAvailable is false when incapacitated', () => {
  for (const cond of ['incapacitated', 'paralyzed', 'stunned', 'unconscious', 'petrified']) {
    assert.strictEqual(
      hasReactionAvailable({ id: 'a', conditions: [cond] }),
      false,
      `should be false when ${cond}`
    );
  }
});

test('M33.0: resetReactionsForAll resets the whole list', () => {
  const list = [
    { id: 'a', _reactionUsed: true },
    { id: 'b', _reactionUsed: true }
  ];
  resetReactionsForAll(list);
  assert.strictEqual(list[0]._reactionUsed, false);
  assert.strictEqual(list[1]._reactionUsed, false);
});

test('M33.0: helpers tolerate null inputs', () => {
  resetReaction(null);
  consumeReaction(null);
  assert.strictEqual(hasReactionAvailable(null), false);
});

// ---------- detectOpportunityAttacks ----------

test('M33.0: OA fires when mover steps out of hostile reach (5ft)', () => {
  const mover = { id: 'm1', _position: { col: 5, row: 5 } };
  const hostile = { id: 'h1', _position: { col: 5, row: 5 }, weapon: { name: 'Longsword' } };
  const out = detectOpportunityAttacks({
    mover, before: { col: 5, row: 5 }, after: { col: 7, row: 5 },
    hostiles: [hostile]
  });
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].triggerer, hostile);
  assert.strictEqual(out[0].reason, 'left-reach');
});

test('M33.0: OA does NOT fire when mover stays in reach', () => {
  const hostile = { id: 'h1', _position: { col: 5, row: 5 }, weapon: { name: 'Longsword' } };
  const out = detectOpportunityAttacks({
    mover: { id: 'm1' }, before: { col: 5, row: 5 }, after: { col: 6, row: 5 },
    hostiles: [hostile]
  });
  assert.strictEqual(out.length, 0);
});

test('M33.0: OA does NOT fire when hostile already used its reaction', () => {
  const hostile = {
    id: 'h1', _position: { col: 5, row: 5 },
    weapon: { name: 'Longsword' }, _reactionUsed: true
  };
  const out = detectOpportunityAttacks({
    mover: { id: 'm1' }, before: { col: 5, row: 5 }, after: { col: 8, row: 5 },
    hostiles: [hostile]
  });
  assert.strictEqual(out.length, 0);
});

test('M33.0: OA does NOT fire when hostile is incapacitated', () => {
  const hostile = {
    id: 'h1', _position: { col: 5, row: 5 },
    weapon: { name: 'Longsword' }, conditions: ['stunned']
  };
  const out = detectOpportunityAttacks({
    mover: { id: 'm1' }, before: { col: 5, row: 5 }, after: { col: 8, row: 5 },
    hostiles: [hostile]
  });
  assert.strictEqual(out.length, 0);
});

test('M33.0: Disengage suppresses all OAs from the move', () => {
  const hostile = { id: 'h1', _position: { col: 5, row: 5 }, weapon: { name: 'Longsword' } };
  const out = detectOpportunityAttacks({
    mover: { id: 'm1', _disengaged: true },
    before: { col: 5, row: 5 }, after: { col: 8, row: 5 },
    hostiles: [hostile]
  });
  assert.strictEqual(out.length, 0);
});

test('M33.0: reach weapon (Halberd, 10ft) catches mover crossing the 10ft boundary', () => {
  const hostile = { id: 'h1', _position: { col: 0, row: 0 }, weapon: { name: 'Halberd' } };
  // 2 cells = 10ft (in reach) → 3 cells = 15ft (out)
  const out = detectOpportunityAttacks({
    mover: { id: 'm1' },
    before: { col: 2, row: 0 }, after: { col: 3, row: 0 },
    hostiles: [hostile]
  });
  assert.strictEqual(out.length, 1);
});

test('M33.0: every threatening hostile generates its own OA', () => {
  const h1 = { id: 'h1', _position: { col: 4, row: 5 }, weapon: { name: 'Dagger' } };
  const h2 = { id: 'h2', _position: { col: 5, row: 4 }, weapon: { name: 'Scimitar' } };
  const out = detectOpportunityAttacks({
    mover: { id: 'm1' }, before: { col: 5, row: 5 }, after: { col: 7, row: 7 },
    hostiles: [h1, h2]
  });
  assert.strictEqual(out.length, 2);
});

test('M33.0: a no-op move (same cell) generates no OAs', () => {
  const hostile = { id: 'h1', _position: { col: 5, row: 5 }, weapon: { name: 'Longsword' } };
  const out = detectOpportunityAttacks({
    mover: { id: 'm1' }, before: { col: 5, row: 5 }, after: { col: 5, row: 5 },
    hostiles: [hostile]
  });
  assert.strictEqual(out.length, 0);
});

test('M33.0: monster attack object is treated as a melee weapon for reach', () => {
  const hostile = { id: 'h1', _position: { col: 5, row: 5 }, attack: { name: 'Bite' } };
  const out = detectOpportunityAttacks({
    mover: { id: 'm1' }, before: { col: 5, row: 5 }, after: { col: 7, row: 5 },
    hostiles: [hostile]
  });
  assert.strictEqual(out.length, 1);
});

// ---------- M33.1: Shield reaction ----------

function shieldTarget({ slots = 1, used = false, ac = 15, ref = { spells: [{ name: 'Shield' }] } } = {}) {
  return { id: 't1', kind: 'pc', ac, ref, _lvl1Slots: slots, _reactionUsed: used };
}

test('M33.1: hasShieldSpell — array form', () => {
  assert.strictEqual(hasShieldSpell({ ref: { spells: [{ name: 'Shield' }] } }), true);
  assert.strictEqual(hasShieldSpell({ ref: { spells: [{ name: 'Magic Missile' }] } }), false);
});

test('M33.1: hasShieldSpell — keyed-by-level form', () => {
  assert.strictEqual(hasShieldSpell({ ref: { spells: { 1: [{ name: 'Shield' }] } } }), true);
});

test('M33.1: hasShieldSpell — string list', () => {
  assert.strictEqual(hasShieldSpell({ ref: { spells: ['Shield', 'Magic Missile'] } }), true);
});

test('M33.1: shouldCastShield fires when total ≤ ac+4 and hits', () => {
  const t = shieldTarget({ ac: 15 });
  assert.strictEqual(shouldCastShield({ target: t, attackerTotal: 17, targetAc: 15 }), true);
});

test('M33.1: shouldCastShield does NOT fire when attacker missed already', () => {
  const t = shieldTarget({ ac: 15 });
  assert.strictEqual(shouldCastShield({ target: t, attackerTotal: 13, targetAc: 15 }), false);
});

test('M33.1: shouldCastShield does NOT fire when attacker overshoots (saving a slot)', () => {
  const t = shieldTarget({ ac: 15 });
  assert.strictEqual(shouldCastShield({ target: t, attackerTotal: 21, targetAc: 15 }), false);
});

test('M33.1: shouldCastShield does NOT fire when no reaction available', () => {
  const t = shieldTarget({ used: true });
  assert.strictEqual(shouldCastShield({ target: t, attackerTotal: 17, targetAc: 15 }), false);
});

test('M33.1: shouldCastShield does NOT fire when no 1st-level slots remain', () => {
  const t = shieldTarget({ slots: 0 });
  assert.strictEqual(shouldCastShield({ target: t, attackerTotal: 17, targetAc: 15 }), false);
});

test('M33.1: shouldCastShield does NOT fire when target lacks Shield in spell list', () => {
  const t = shieldTarget({ ref: { spells: [{ name: 'Magic Missile' }] } });
  assert.strictEqual(shouldCastShield({ target: t, attackerTotal: 17, targetAc: 15 }), false);
});

test('M33.1: consumeShield burns one slot AND the reaction', () => {
  const t = shieldTarget({ slots: 3 });
  consumeShield(t);
  assert.strictEqual(t._lvl1Slots, 2);
  assert.strictEqual(t._reactionUsed, true);
  assert.strictEqual(t._shieldActive, true);
});

test('M33.1: lvl1SlotsForPc — wizard 1 → 2 slots', () => {
  assert.strictEqual(lvl1SlotsForPc({ classes: [{ name: 'Wizard', level: 1 }] }), 2);
});

test('M33.1: lvl1SlotsForPc — wizard 5 → 4 slots', () => {
  assert.strictEqual(lvl1SlotsForPc({ classes: [{ name: 'Wizard', level: 5 }] }), 4);
});

test('M33.1: lvl1SlotsForPc — paladin 1 → 0 (half-caster, no slots yet)', () => {
  assert.strictEqual(lvl1SlotsForPc({ classes: [{ name: 'Paladin', level: 1 }] }), 0);
});

test('M33.1: lvl1SlotsForPc — fighter 5 → 0 (non-caster)', () => {
  assert.strictEqual(lvl1SlotsForPc({ classes: [{ name: 'Fighter', level: 5 }] }), 0);
});

// ---------- Simulator-level integration ----------

import { simulateEncounter } from '../js/scene/simulator.js';

test('M33.1: simulator — wizard with Shield takes less damage than the same wizard without it', () => {
  function wizard({ withShield }) {
    return {
      id: 'wiz', name: 'Tactical Wizard', _position: { col: 1, row: 1 },
      hp: { current: 20, max: 20 },
      equipment: { mainhand: { name: 'Dagger' } },
      abilityScores: { STR: 8, DEX: 14, CON: 12, INT: 16, WIS: 10, CHA: 10 },
      abilityModifiers: { STR: -1, DEX: 2, CON: 1, INT: 3, WIS: 0, CHA: 0 },
      classes: [{ name: 'Wizard', level: 5 }],
      conditions: [],
      spells: withShield ? [{ name: 'Shield' }] : []
    };
  }
  const monsters = () => [
    { id: 'b1', presetSlug: 'bandit', name: 'B1', hp: { current: 11, max: 11 }, position: { col: 2, row: 1 }, conditions: [] },
    { id: 'b2', presetSlug: 'bandit', name: 'B2', hp: { current: 11, max: 11 }, position: { col: 1, row: 2 }, conditions: [] }
  ];
  const opts = { scene: { cols: 8, rows: 5 }, iterations: 200, maxRounds: 10, seed: 7 };
  const without = simulateEncounter({ party: [wizard({ withShield: false })], monsters: monsters(), ...opts });
  const with_   = simulateEncounter({ party: [wizard({ withShield: true  })], monsters: monsters(), ...opts });
  const dmgWithout = 20 - (without.entities.find(e => e.id === 'wiz').avgFinalHp);
  const dmgWith    = 20 - (with_.entities.find(e => e.id === 'wiz').avgFinalHp);
  assert.ok(dmgWith < dmgWithout,
    `Shield should reduce avg damage taken (without=${dmgWithout.toFixed(2)}, with=${dmgWith.toFixed(2)})`);
});

test('M33.0: simulator integration — encounter still resolves with OAs active', () => {
  // 2 PCs adjacent to 2 monsters; over many runs the OAs should fire
  // at least sometimes (when fleeing kobolds break away from the
  // surrounding melee). The contract under test is just "the simulator
  // still terminates and reports outcomes" — OAs must not deadlock it.
  const party = [
    {
      id: 'pc1', name: 'A', _position: { col: 1, row: 1 },
      hp: { current: 30, max: 30 },
      equipment: { mainhand: { name: 'Longsword' } },
      abilityScores: { STR: 16, DEX: 12, CON: 14, INT: 10, WIS: 10, CHA: 10 },
      abilityModifiers: { STR: 3, DEX: 1, CON: 2, INT: 0, WIS: 0, CHA: 0 },
      classes: [{ name: 'Fighter', level: 5 }],
      conditions: []
    },
    {
      id: 'pc2', name: 'B', _position: { col: 2, row: 1 },
      hp: { current: 30, max: 30 },
      equipment: { mainhand: { name: 'Longsword' } },
      abilityScores: { STR: 16, DEX: 12, CON: 14, INT: 10, WIS: 10, CHA: 10 },
      abilityModifiers: { STR: 3, DEX: 1, CON: 2, INT: 0, WIS: 0, CHA: 0 },
      classes: [{ name: 'Fighter', level: 5 }],
      conditions: []
    }
  ];
  // Three kobolds — their profile flees at 60% HP, so they'll provoke
  // OAs when they break engagement.
  const monsters = [
    { id: 'k1', presetSlug: 'kobold', name: 'K1', hp: { current: 5, max: 5 }, position: { col: 2, row: 2 }, conditions: [] },
    { id: 'k2', presetSlug: 'kobold', name: 'K2', hp: { current: 5, max: 5 }, position: { col: 1, row: 2 }, conditions: [] },
    { id: 'k3', presetSlug: 'kobold', name: 'K3', hp: { current: 5, max: 5 }, position: { col: 3, row: 2 }, conditions: [] }
  ];
  const stats = simulateEncounter({
    party, monsters,
    scene: { cols: 8, rows: 5 },
    iterations: 50, maxRounds: 12, seed: 1
  });
  // Both sides definitively resolve; no draws/deadlocks
  assert.strictEqual(stats.iterations, 50);
  assert.strictEqual(stats.partyVictories + stats.monsterVictories + stats.draws, 50);
  // Party should still trounce 3 weak kobolds the majority of the time
  assert.ok(stats.partyVictories / stats.iterations > 0.5,
    `expected party win rate > 50%, got ${stats.partyVictories}/50`);
});

// =====================================================================
// M33.2 — Sentinel + Polearm Master
// =====================================================================

test('M33.2: hasSentinel reads array-of-strings feats', () => {
  assert.strictEqual(hasSentinel({ feats: ['Sentinel'] }), true);
  assert.strictEqual(hasSentinel({ feats: ['Great Weapon Master'] }), false);
});

test('M33.2: hasSentinel reads array-of-objects feats', () => {
  assert.strictEqual(hasSentinel({ feats: [{ name: 'Sentinel' }] }), true);
});

test('M33.2: hasSentinel checks ref.feats when on a wrapper', () => {
  assert.strictEqual(hasSentinel({ ref: { feats: ['Sentinel'] } }), true);
});

test('M33.2: hasPolearmMaster detects "Polearm Master" with various casings', () => {
  assert.strictEqual(hasPolearmMaster({ feats: ['Polearm Master'] }), true);
  assert.strictEqual(hasPolearmMaster({ feats: ['polearm master'] }), true);
  assert.strictEqual(hasPolearmMaster({ feats: ['POLEARMMASTER'] }), true);   // tolerates squished
});

test('M33.2: isPolearmWeapon matches the four canonical polearms', () => {
  for (const n of ['Glaive', 'Halberd', 'Pike', 'Quarterstaff']) {
    assert.strictEqual(isPolearmWeapon({ name: n }), true, n);
  }
  assert.strictEqual(isPolearmWeapon({ name: 'Longsword' }), false);
  assert.strictEqual(isPolearmWeapon(null), false);
});

test('M33.2: Sentinel — Disengage does NOT suppress OA from a 5ft Sentinel', () => {
  const sentinel = {
    id: 'h1', _position: { col: 5, row: 5 },
    weapon: { name: 'Longsword' }, feats: ['Sentinel']
  };
  const out = detectOpportunityAttacks({
    mover: { id: 'm1', _disengaged: true },
    before: { col: 5, row: 5 }, after: { col: 8, row: 5 },
    hostiles: [sentinel]
  });
  assert.strictEqual(out.length, 1);
});

test('M33.2: Sentinel — Disengage still suppresses OA from a Sentinel beyond 5ft', () => {
  // Sentinel wielding a reach weapon, mover Disengaging from 10ft away.
  const sentinel = {
    id: 'h1', _position: { col: 0, row: 0 },
    weapon: { name: 'Halberd' }, feats: ['Sentinel']
  };
  const out = detectOpportunityAttacks({
    mover: { id: 'm1', _disengaged: true },
    before: { col: 2, row: 0 }, after: { col: 5, row: 0 },
    hostiles: [sentinel]
  });
  assert.strictEqual(out.length, 0);
});

test('M33.2: Sentinel — non-Sentinel still gets suppressed by Disengage', () => {
  const plain = {
    id: 'h1', _position: { col: 5, row: 5 },
    weapon: { name: 'Longsword' }
  };
  const out = detectOpportunityAttacks({
    mover: { id: 'm1', _disengaged: true },
    before: { col: 5, row: 5 }, after: { col: 8, row: 5 },
    hostiles: [plain]
  });
  assert.strictEqual(out.length, 0);
});

test('M33.2: Polearm Master — entering reach triggers an OA', () => {
  const pam = {
    id: 'h1', _position: { col: 0, row: 0 },
    weapon: { name: 'Glaive' }, feats: ['Polearm Master']
  };
  // Mover crosses from 15ft to 10ft (entering glaive's 10ft reach)
  const out = detectPolearmEntryOAs({
    mover: { id: 'm1' },
    before: { col: 3, row: 0 }, after: { col: 2, row: 0 },
    hostiles: [pam]
  });
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].reason, 'entered-reach-PAM');
});

test('M33.2: Polearm Master — no trigger when already in reach', () => {
  const pam = {
    id: 'h1', _position: { col: 0, row: 0 },
    weapon: { name: 'Halberd' }, feats: ['Polearm Master']
  };
  const out = detectPolearmEntryOAs({
    mover: { id: 'm1' },
    before: { col: 1, row: 0 }, after: { col: 2, row: 0 },
    hostiles: [pam]
  });
  assert.strictEqual(out.length, 0);
});

test('M33.2: Polearm Master — no trigger without the feat', () => {
  const noFeat = {
    id: 'h1', _position: { col: 0, row: 0 },
    weapon: { name: 'Halberd' }
  };
  const out = detectPolearmEntryOAs({
    mover: { id: 'm1' },
    before: { col: 3, row: 0 }, after: { col: 2, row: 0 },
    hostiles: [noFeat]
  });
  assert.strictEqual(out.length, 0);
});

test('M33.2: Polearm Master — no trigger with a non-polearm weapon', () => {
  const swordSentinel = {
    id: 'h1', _position: { col: 5, row: 5 },
    weapon: { name: 'Longsword' }, feats: ['Polearm Master']
  };
  const out = detectPolearmEntryOAs({
    mover: { id: 'm1' },
    before: { col: 8, row: 5 }, after: { col: 6, row: 5 },
    hostiles: [swordSentinel]
  });
  assert.strictEqual(out.length, 0);
});

test('M33.2: Polearm Master — no trigger when hostile already used its reaction', () => {
  const pam = {
    id: 'h1', _position: { col: 0, row: 0 },
    weapon: { name: 'Halberd' }, feats: ['Polearm Master'],
    _reactionUsed: true
  };
  const out = detectPolearmEntryOAs({
    mover: { id: 'm1' },
    before: { col: 3, row: 0 }, after: { col: 2, row: 0 },
    hostiles: [pam]
  });
  assert.strictEqual(out.length, 0);
});
