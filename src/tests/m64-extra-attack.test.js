/**
 * M64 R10 — Extra Attack (PC_FEATURES attacksPerAction hook), monster
 * Multiattack (statBlock.multiattack), and Action Surge as a second
 * Attack action that does not move again.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runOneAttack, attackSequenceFor } from '../js/scene/combat-engine.js';
import { attacksPerAction, PC_FEATURES, availableFeatures } from '../js/scene/ai/pc-features.js';
import { createRng } from '../js/scene/rng.js';
import { wrapperFromEntity, entityFromPreset } from '../js/scene/encounter-adapters.js';
import { validateEvent } from '../js/shared/events.js';
import { buildPc, buildMonster, buildScene } from './helpers/entities.js';

function sink() {
  const events = [];
  let seq = 0;
  return {
    events,
    ctx: { emit: (ev) => events.push({ seq: ++seq, round: 1, turnId: 'r1t0', ...ev }), turnId: 'r1t0' }
  };
}

const fighter = (level, extra = {}) => buildPc({
  id: 'f', _position: { col: 1, row: 1 },
  ref: { ...buildPc().ref, classes: [{ name: 'Fighter', level }] },
  ...extra
});

const melee = (targetId, features = []) => ({
  forcePlan: { kind: 'melee', targetId, targetSide: 'enemy', weapon: { name: 'Longsword' }, featuresFired: features }
});

test('R10: attacksPerAction — Fighter 5/11/20, the other martial classes at 5, no stacking', () => {
  const pc = (classes) => ({ classes });
  assert.equal(attacksPerAction(pc([{ name: 'Fighter', level: 4 }])), 1);
  assert.equal(attacksPerAction(pc([{ name: 'Fighter', level: 5 }])), 2);
  assert.equal(attacksPerAction(pc([{ name: 'Fighter', level: 11 }])), 3);
  assert.equal(attacksPerAction(pc([{ name: 'Fighter', level: 20 }])), 4);
  for (const name of ['Barbarian', 'Paladin', 'Ranger', 'Monk']) {
    assert.equal(attacksPerAction(pc([{ name, level: 5 }])), 2, name);
    assert.equal(attacksPerAction(pc([{ name, level: 20 }])), 2, `${name} 20`);
  }
  assert.equal(attacksPerAction(pc([{ name: 'Wizard', level: 9 }])), 1);
  assert.equal(attacksPerAction(pc([{ name: 'Fighter', level: 5 }, { name: 'Paladin', level: 5 }])), 2, 'no stacking');
  assert.equal(attacksPerAction({ ref: { classes: [{ name: 'Ranger', level: 6 }] } }), 2, 'reads a wrapper ref');
  assert.equal(PC_FEATURES['extra-attack'].passive, true);
  assert.ok(!availableFeatures({ classes: [{ name: 'Fighter', level: 5 }] }).some(f => f.id === 'extra-attack'),
    'passive: never scored into a plan');
});

test('R10: a Fighter 5 swings twice per Attack action, one cinema group, one exchange per swing', async () => {
  const f = fighter(5);
  const m = buildMonster({ id: 'm', hp: 200, hpMax: 200, ac: 10, position: { col: 2, row: 1 } });
  const { events, ctx } = sink();
  await runOneAttack(f, [m], [f], buildScene(), createRng({ s: 5 }), melee('m'), ctx);
  const rolls = events.filter(e => e.type === 'attack.rolled');
  const ex = events.filter(e => e.type === 'exchange');
  assert.equal(rolls.length, 2);
  assert.equal(ex.length, 2);
  const group = rolls[0].cinemaGroup;
  assert.ok(group);
  assert.ok(events.filter(e => ['attack.rolled', 'damage', 'exchange'].includes(e.type)).every(e => e.cinemaGroup === group));
  assert.deepEqual(ex.map(e => e.payload.exchangeId), [group, `${group}.s2`]);
  assert.notEqual(ex[0].payload.cinema.fxSeed, ex[1].payload.cinema.fxSeed);
  for (const e of events) assert.ok(validateEvent(e).ok, e.type);
  // Fighter 4: one swing.
  const f4 = fighter(4);
  const m4 = buildMonster({ id: 'm', hp: 200, hpMax: 200, ac: 10, position: { col: 2, row: 1 } });
  const s4 = sink();
  await runOneAttack(f4, [m4], [f4], buildScene(), createRng({ s: 5 }), melee('m'), s4.ctx);
  assert.equal(s4.events.filter(e => e.type === 'attack.rolled').length, 1);
});

test('R10: Fighter 11 makes three attacks and Fighter 20 four', async () => {
  for (const [level, n] of [[11, 3], [20, 4]]) {
    const f = fighter(level);
    const m = buildMonster({ id: 'm', hp: 500, hpMax: 500, ac: 10, position: { col: 2, row: 1 } });
    const { events, ctx } = sink();
    await runOneAttack(f, [m], [f], buildScene(), createRng({ s: 1 }), melee('m'), ctx);
    assert.equal(events.filter(e => e.type === 'attack.rolled').length, n, `Fighter ${level}`);
  }
});

test('R10: when the first swing drops the target, the next swing re-targets the nearest hostile in reach', async () => {
  const f = fighter(5);
  const weak = buildMonster({ id: 'weak', hp: 1, hpMax: 7, ac: 1, position: { col: 2, row: 1 } });
  const near = buildMonster({ id: 'near', hp: 100, hpMax: 100, ac: 1, position: { col: 1, row: 2 } });
  const far = buildMonster({ id: 'far', hp: 100, hpMax: 100, ac: 1, position: { col: 6, row: 6 } });
  const { events, ctx } = sink();
  // seed 3: the first d20 is not a natural 1 against AC 1.
  await runOneAttack(f, [weak, near, far], [f], buildScene(), createRng({ s: 3 }), melee('weak'), ctx);
  const targets = events.filter(e => e.type === 'attack.rolled').map(e => e.payload.targetId);
  assert.equal(targets[0], 'weak');
  assert.equal(weak.hp, 0);
  assert.deepEqual(targets, ['weak', 'near'], 'the far goblin is out of reach');
  // No hostile in reach after the kill: the action ends.
  const f2 = fighter(5);
  const lone = buildMonster({ id: 'lone', hp: 1, hpMax: 7, ac: 1, position: { col: 2, row: 1 } });
  const away = buildMonster({ id: 'away', hp: 100, hpMax: 100, ac: 1, position: { col: 8, row: 6 } });
  const s2 = sink();
  await runOneAttack(f2, [lone, away], [f2], buildScene(), createRng({ s: 3 }), melee('lone'), s2.ctx);
  assert.equal(s2.events.filter(e => e.type === 'attack.rolled').length, 1);
});

const owlbearBlock = () => ({
  slug: 'troll',
  name: 'Owlbear', ac: 13, hpMax: 59,
  attacks: [
    { name: 'Beak', bonus: 7, dice: '1d10+5', damageType: 'piercing', reachFt: 5 },
    { name: 'Claws', bonus: 7, dice: '2d8+5', damageType: 'slashing', reachFt: 5 }
  ],
  multiattack: [{ action: 'Beak', count: 1 }, { action: 'Claws', count: 1 }]
});

test('R10: an owlbear-style stat block makes beak + claws (adapters → wrapper → engine)', async () => {
  const e = entityFromPreset('troll', { id: 'owl', pos: { col: 2, row: 1 }, statBlock: owlbearBlock() });
  const owl = wrapperFromEntity(e);
  assert.deepEqual(attackSequenceFor(owl).map(a => a.name), ['Beak', 'Claws']);
  const pc = buildPc({ id: 'pc', hp: 200, hpMax: 200, ac: 5, _position: { col: 1, row: 1 } });
  const { events, ctx } = sink();
  await runOneAttack(owl, [pc], [owl], buildScene(), createRng({ s: 7 }), { forcePlan: { kind: 'attack', targetId: 'pc' } }, ctx);
  const rolls = events.filter(e => e.type === 'attack.rolled');
  assert.deepEqual(rolls.map(r => r.payload.weapon), ['Beak', 'Claws']);
  assert.deepEqual(rolls.map(r => r.payload.bonus), [7, 7]);
  // Each hit carries its own record's damage type.
  const want = { Beak: 'piercing', Claws: 'slashing' };
  let lastWeapon = null;
  let damages = 0;
  for (const ev of events) {
    if (ev.type === 'attack.rolled') lastWeapon = ev.payload.weapon;
    if (ev.type === 'damage') { damages++; assert.equal(ev.payload.type, want[lastWeapon]); }
  }
  assert.equal(damages, rolls.filter(r => r.payload.hit).length);
  assert.deepEqual(events.filter(e => e.type === 'exchange').map(x => x.payload.cinema.weapon.name), ['Beak', 'Claws']);
  // JSON round-trip of the wrapper keeps the routine.
  assert.deepEqual(attackSequenceFor(JSON.parse(JSON.stringify(owl))).map(a => a.name), ['Beak', 'Claws']);
});

test('R10: attackSequenceFor — any-attack entries, limits, the legacy object form, no multiattack', () => {
  const bite = { name: 'Bite', bonus: 6, dice: '1d6+3' };
  const claw = { name: 'Claw', bonus: 6, dice: '2d4+3' };
  const bow = { name: 'Shortbow', bonus: 4, dice: '1d6+2', rangeFt: 80 };
  // Vampire spawn: "two attacks, only one of which can be a bite" with the bite primary.
  const spawn = buildMonster({ attack: bite, attacks: [bite, claw], multiattack: [{ action: null, count: 2, limits: { Bite: 1 } }] });
  assert.deepEqual(attackSequenceFor(spawn).map(a => a.name), ['Bite', 'Claw']);
  // Cult fanatic: "two melee attacks" skips a ranged record.
  const fan = buildMonster({ attack: bow, attacks: [bow, claw], multiattack: [{ action: null, kind: 'melee', count: 2 }] });
  assert.deepEqual(attackSequenceFor(fan).map(a => a.name), ['Claw', 'Claw']);
  // Legacy {attacks: [{name, count}]}.
  const legacy = buildMonster({ attack: bite, attacks: [bite, claw], multiattack: { attacks: [{ name: 'Claw', count: 2 }] } });
  assert.deepEqual(attackSequenceFor(legacy).map(a => a.name), ['Claw', 'Claw']);
  // An unknown name falls back to the primary; no multiattack = one attack.
  assert.deepEqual(attackSequenceFor(buildMonster({ attack: bite, multiattack: [{ action: 'Tail', count: 1 }] })).map(a => a.name), ['Bite']);
  assert.deepEqual(attackSequenceFor(buildMonster()).map(a => a.name), ['Scimitar']);
  // PCs: the chosen weapon N times.
  assert.equal(attackSequenceFor(fighter(5, { _chosenWeapon: { name: 'Longsword' } })).length, 2);
});

test('R10: Action Surge gives a second Attack action without moving again', async () => {
  // The fighter starts 3 cells away: it moves once, then swings 2 + 2.
  const f = fighter(5, { _position: { col: 0, row: 1 }, _actionSurgeUsed: 0 });
  const m = buildMonster({ id: 'm', hp: 500, hpMax: 500, ac: 30, position: { col: 4, row: 1 } });
  const { events, ctx } = sink();
  await runOneAttack(f, [m], [f], buildScene(), createRng({ s: 11 }), melee('m', ['action-surge']), ctx);
  const moves = events.filter(e => e.type === 'move');
  assert.equal(moves.length, 1, 'one move for the whole turn');
  assert.deepEqual(f._position, moves[0].payload.to);
  const rolls = events.filter(e => e.type === 'attack.rolled');
  assert.equal(rolls.length, 4, 'two Attack actions of two swings, even when they miss');
  const groups = [...new Set(rolls.map(r => r.cinemaGroup))];
  assert.equal(groups.length, 2, 'each Attack action is its own cinema group');
  assert.equal(events.filter(e => e.type === 'feature.used' && e.payload.featureId === 'action-surge').length, 1);
  assert.equal(f._actionSurgeUsed, 1);
  assert.equal(f._surgeFiredThisTurn, false);
  // No double plan: plan.chosen once.
  assert.equal(events.filter(e => e.type === 'plan.chosen').length, 1);
});
