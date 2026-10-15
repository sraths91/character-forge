// M64 T2 — RNG tripwire.
//
// Every die the engine rolls must come from the injected rng. These
// tests replace Math.random with a function that throws, then run a
// full simulation plus every runMonsterSpell kind. Any code path that
// still reaches for Math.random (a missed rng argument, a leftover
// default) fails the test instead of silently de-seeding the run.

import { test } from 'node:test';
import assert from 'node:assert';
import { simulateEncounter, seedRng } from '../js/scene/simulator.js';
import { runMonsterSpell, runOneAttack, applyDamageToEntity } from '../js/scene/combat-engine.js';
import { slotsForPc } from '../js/scene/reactions.js';
import { freshInnateState } from '../js/scene/monster-spells.js';
import { startConcentration, isConcentrating } from '../js/scene/concentration.js';
import { spellById } from '../js/scene/monster-spells.js';
import { rollDice, rollD20, rollAttack, rollDamage } from '../js/scene/combat-roll.js';
import { rollSave, resolveSpellSave } from '../js/scene/save-rolls.js';
import { rollConcentrationSave, handleDamageOnConcentration } from '../js/scene/concentration.js';
import { resolveCounterspell } from '../js/scene/reactions.js';
import { rollInnateRecharges } from '../js/scene/monster-spells.js';
import { rollPartyInitiative } from '../js/scene/versus.js';
import { chooseAction, fleeTargetCell } from '../js/scene/ai/profile.js';
import { choosePcAction } from '../js/scene/ai/pc-action.js';
import { mctsEvaluate } from '../js/scene/ai/mcts.js';

/** Run `fn` with Math.random replaced by a tripwire; always restores. */
async function withTripwire(fn) {
  const original = Math.random;
  Math.random = () => { throw new Error('Math.random called inside the engine (unseeded rng)'); };
  try {
    return await fn();
  } finally {
    Math.random = original;
  }
}

/** Seeded rng that counts draws, so each test proves dice were rolled. */
function countingRng(seed) {
  const inner = seedRng(seed);
  const rng = () => { rng.draws++; return inner(); };
  rng.draws = 0;
  return rng;
}

function pcChar(id, col, cls, level, spells, extra = {}) {
  return {
    id, name: id, _position: { col, row: 1 }, hp: { current: 40, max: 40 },
    equipment: { mainhand: { name: 'Longsword', damage: '1d8', damageType: 'Slashing' } },
    abilityScores: { STR: 16, DEX: 12, CON: 14, INT: 16, WIS: 14, CHA: 14 },
    abilityModifiers: { STR: 3, DEX: 1, CON: 2, INT: 3, WIS: 2, CHA: 2 },
    classes: [{ name: cls, level }], conditions: [], spells, ...extra
  };
}

test('M64 T2 tripwire: simulateEncounter never touches Math.random', async () => {
  const party = [
    pcChar('fighter', 1, 'Fighter', 5, []),
    pcChar('wizard', 2, 'Wizard', 7, ['Shield', 'Magic Missile', 'Counterspell', 'Fire Bolt']),
    pcChar('cleric', 3, 'Cleric', 5, ['Cure Wounds', 'Healing Word', 'Sacred Flame']),
    pcChar('paladin', 4, 'Paladin', 5, []),
    pcChar('rogue', 5, 'Rogue', 5, [])
  ];
  const mk = (id, slug, col, row) => ({
    id, name: slug, presetSlug: slug, hp: { current: 40, max: 40 }, conditions: [], position: { col, row }
  });
  const monsters = [
    mk('fan', 'cult-fanatic', 1, 4), mk('kob', 'kobold-sorcerer', 3, 5),
    mk('drg', 'young-dragon', 5, 4), mk('vmp', 'vampire-spawn', 7, 4), mk('gob', 'goblin', 2, 3)
  ];
  const stats = await withTripwire(() => simulateEncounter({
    party, monsters, scene: { cols: 10, rows: 8 }, iterations: 40, maxRounds: 12, seed: 7
  }));
  assert.strictEqual(stats.iterations, 40);
  assert.ok(stats.avgRounds > 0);
});

function casterMonster(over = {}) {
  return {
    ref: { name: 'Cult Fanatic' }, id: 'm1', name: 'Cult Fanatic', kind: 'monster',
    presetSlug: 'cult-fanatic', hp: 33, hpMax: 33, ac: 13,
    attack: { name: 'Dagger', bonus: 4, dice: '1d4+2' },
    conditions: [], damageDealt: 0, position: { col: 2, row: 1 },
    _slots: { 1: 4, 2: 3, 3: 2 }, ...over
  };
}
function pcTarget(over = {}) {
  const ref = {
    name: 'Eldra', classes: [{ name: 'Wizard', level: 7 }],
    abilityModifiers: { INT: 4, DEX: 2, CON: 1, WIS: 1 },
    spells: ['Counterspell', 'Shield']
  };
  return {
    ref, id: 'pc1', name: 'Eldra', kind: 'pc', hp: 30, hpMax: 40, ac: 12,
    weapon: { name: 'Quarterstaff' }, conditions: [], damageDealt: 0,
    _position: { col: 3, row: 1 }, _reactionUsed: false,
    _slots: slotsForPc(ref),
    ...over
  };
}

const SPELL_KINDS = [
  // [label, spellId, castAtLevel, target-builder, attacker-builder]
  ['heal (cure-wounds)', 'cure-wounds', 1, () => casterMonster({ id: 'm2', hp: 5 })],
  ['auto-hit (magic-missile, upcast)', 'magic-missile', 2, () => pcTarget({ _slots: {} })],
  ['spell-attack (inflict-wounds)', 'inflict-wounds', 1, () => pcTarget()],
  ['spell-attack (fire-bolt cantrip)', 'fire-bolt', 0, () => pcTarget()],
  ['cantrip save (sacred-flame)', 'sacred-flame', 0, () => pcTarget()],
  ['leveled save + concentration (hold-person)', 'hold-person', 2, () => pcTarget({ _slots: { 1: 4, 2: 3, 3: 0, 4: 0, 5: 0 } })],
  ['counterspelled (hold-person vs Counterspell witness)', 'hold-person', 2, () => pcTarget()],
  ['AoE save (fire-breath)', 'fire-breath', 0, () => pcTarget()]
];

for (const [label, spellId, castAtLevel, makeTarget] of SPELL_KINDS) {
  test(`M64 T2 tripwire: runMonsterSpell ${label} never touches Math.random`, async () => {
    const isBreath = spellId === 'fire-breath';
    const attacker = isBreath
      ? casterMonster({ presetSlug: 'young-dragon', _slots: null, _innate: freshInnateState('young-dragon') })
      : casterMonster();
    const target = makeTarget();
    const rng = countingRng(11);
    await withTripwire(() => runMonsterSpell({
      attacker, target,
      plan: { spellId, castAtLevel, targetId: target.id, isInnate: isBreath },
      scene: { cols: 10, rows: 7 }, rng,
      witnesses: target.kind === 'pc' ? [target] : [],
      allEnemies: [target]
    }));
    if (label.startsWith('counterspelled')) {
      // Level-2 spell vs Counterspell is an automatic counter: no dice.
      assert.strictEqual(target._slots[3], slotsForPc(target.ref)[3] - 1, 'counterspell slot spent (one ledger)');
    } else {
      assert.ok(rng.draws > 0, `${label}: expected the seeded rng to be used`);
    }
  });
}

test('M64 T2 tripwire: damage on a concentrating caster rolls the save on the injected rng', async () => {
  const caster = casterMonster();
  startConcentration(caster, spellById('hold-person'), ['pc1']);
  assert.ok(isConcentrating(caster));
  const rng = countingRng(3);
  await withTripwire(() => applyDamageToEntity(caster, 12, rng));
  assert.strictEqual(rng.draws, 1, 'exactly one d20 for the concentration save');
});

test('M64 T2 tripwire: a full PC turn (AI plan, MCTS upcast, OA, smite) never touches Math.random', async () => {
  const paladinRef = pcChar('pal', 1, 'Paladin', 5, ['Magic Missile']);
  const pal = {
    ref: paladinRef, id: 'pal', name: 'pal', kind: 'pc', hp: 40, hpMax: 40, ac: 16,
    weapon: paladinRef.equipment.mainhand, _chosenWeapon: paladinRef.equipment.mainhand,
    conditions: [], damageDealt: 0, combatMods: [], _position: { col: 1, row: 1 },
    _reactionUsed: false, _slots: { 1: 4, 2: 2, 3: 0, 4: 0, 5: 0 }
  };
  const gob = casterMonster({ id: 'g', presetSlug: 'goblin', hp: 60, hpMax: 60, _slots: null, position: { col: 0, row: 1 } });
  const far = casterMonster({ id: 'f', presetSlug: 'goblin', hp: 60, hpMax: 60, _slots: null, position: { col: 4, row: 1 } });
  const rng = countingRng(5);
  await withTripwire(() => runOneAttack(pal, [gob, far], [pal], { cols: 10, rows: 5 }, rng, {}));
  assert.ok(rng.draws > 0);
});

test('M64 T2: every engine dice/AI export requires an rng (no Math.random default)', () => {
  const cases = [
    ['rollDice', () => rollDice('1d6')],
    ['rollD20', () => rollD20('normal')],
    ['rollAttack', () => rollAttack({ bonus: 0 })],
    ['rollDamage', () => rollDamage('1d6')],
    ['rollSave', () => rollSave({ bonus: 0, dc: 10 })],
    ['resolveSpellSave', () => resolveSpellSave({ spell: { dice: '1d6' }, dc: 10 })],
    ['rollConcentrationSave', () => rollConcentrationSave({ conMod: 0, dc: 10 })],
    ['handleDamageOnConcentration', () => handleDamageOnConcentration({ caster: {}, damage: 3 })],
    ['resolveCounterspell', () => resolveCounterspell({ spellLevel: 5 })],
    ['rollInnateRecharges', () => rollInnateRecharges({ presetSlug: 'young-dragon' })],
    ['rollPartyInitiative', () => rollPartyInitiative({ pcs: [], monsters: [] })],
    ['chooseAction', () => chooseAction({ self: { presetSlug: 'goblin' }, enemies: [], allies: [] })],
    ['fleeTargetCell', () => fleeTargetCell({ position: { col: 1, row: 1 } }, { position: { col: 2, row: 1 } })],
    ['choosePcAction', () => choosePcAction({ self: { ref: {} }, enemies: [], allies: [] })],
    ['mctsEvaluate', () => mctsEvaluate({ candidates: [], rollout: () => 0 })]
  ];
  assert.strictEqual(cases.length, 15);
  for (const [name, call] of cases) {
    assert.throws(call, new RegExp(`${name}: rng is required`), `${name} accepted a missing rng`);
  }
});
