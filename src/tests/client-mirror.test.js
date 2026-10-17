/**
 * M64 phase 1.5 (E2) — client/mirror.js unit tests: the engine
 * bookkeeping the client replays so its stateHash matches the server's.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyEventToEncounter, applyEntityPatch, lifeStatus, PATCHABLE_FIELDS, ENTITY_STATUSES } from '../js/client/mirror.js';
import { projectedState, clone } from './helpers/client-fixtures.js';

let seq = 100;
const ev = (type, payload, round = 2) => ({ seq: ++seq, type, round, turnId: 't', cinemaGroup: null, payload });
const fold = (enc, list) => {
  let prev = null;
  for (const e of list) { enc = applyEventToEncounter(enc, e, { prev }); prev = e; }
  return enc;
};

test('mirror: turn.started resets the reaction and per-turn flags; turn.ended advances (and wraps the round)', () => {
  const start = projectedState();
  let enc = fold(start, [ev('turn.started', { actorId: 'pc-wizard' })]);
  const w = enc.entities['pc-wizard'];
  assert.equal(w.resources.reactionUsed, false);
  assert.equal(w.turnFlags.shieldActive, undefined);
  assert.equal(enc.turnIndex, 1);
  assert.equal(start.entities['pc-wizard'].resources.reactionUsed, true, 'input untouched');
  assert.equal(enc.entities['pc-fighter'], start.entities['pc-fighter'], 'untouched entities keep identity');
  enc = fold(enc, [ev('turn.ended', { actorId: 'pc-wizard' })]);
  assert.deepEqual([enc.turnIndex, enc.round], [2, 2]);
  enc = fold({ ...enc, turnIndex: 3 }, [ev('turn.skipped', { actorId: 'm-goblin', reason: 'down' }), ev('turn.ended', { actorId: 'm-goblin' })]);
  assert.deepEqual([enc.turnIndex, enc.round], [0, 3], 'the last slot wraps into the next round');
});

test('mirror: turn.ended runs the victory check before advancing', () => {
  const s = projectedState();
  s.entities['m-fanatic'].hp = 0;
  s.entities['m-goblin'].hp = 0;
  const enc = fold(s, [ev('turn.ended', { actorId: 'pc-fighter' })]);
  assert.equal(enc.phase, 'ended');
  assert.equal(enc.turnIndex, s.turnIndex, 'finish() does not advance');
});

test('mirror: resource.spent — reaction, slots (pact fallback), legendary cost, innate, feature:<key>', () => {
  const s = projectedState();
  s.entities['pc-fighter'].resources.pact = { level: 2, max: 1, spent: 0 };
  let enc = fold(s, [
    ev('resource.spent', { entityId: 'pc-fighter', resource: 'reaction', level: null }),
    ev('resource.spent', { entityId: 'pc-wizard', resource: 'spell-slot', level: 3 }),
    ev('resource.spent', { entityId: 'pc-fighter', resource: 'spell-slot', level: 2 }),
    ev('resource.spent', { entityId: 'm-goblin', resource: 'innate:charm-gaze', level: null }),
    ev('resource.spent', { entityId: 'pc-fighter', resource: 'feature:rage', level: null })
  ]);
  assert.equal(enc.entities['pc-fighter'].resources.reactionUsed, true);
  assert.equal(enc.entities['pc-wizard'].resources.slots['3'].spent, 2);
  assert.equal(enc.entities['pc-fighter'].resources.pact.spent, 1, 'no regular level-2 slot: the pact slot pays');
  assert.equal(enc.entities['m-goblin'].resources.innate.perDay['1'][0].remaining, 0);
  assert.deepEqual(enc.entities['pc-fighter'].resources.features.rage, { max: 1, spent: 1 });
  enc = fold({ ...enc, entities: { ...enc.entities, 'm-fanatic': { ...enc.entities['m-fanatic'], resources: { ...enc.entities['m-fanatic'].resources, legendaryBudget: 3 } } } },
    [ev('resource.spent', { entityId: 'm-fanatic', resource: 'legendary', level: null, cost: 2 })]);
  assert.equal(enc.entities['m-fanatic'].resources.legendaryBudget, 1);
});

test('mirror: feature.used flags and ledger; Divine Smite remembers its slot; AI plans clear the PC per-turn flags', () => {
  let enc = fold(projectedState(), [
    ev('feature.used', { entityId: 'pc-fighter', featureId: 'action-surge' }),
    ev('feature.used', { entityId: 'pc-fighter', featureId: 'sneak-attack' }),
    ev('feature.used', { entityId: 'pc-fighter', featureId: 'reckless-attack' })
  ]);
  const f = enc.entities['pc-fighter'];
  assert.equal(f.resources.features['action-surge'].spent, 1);
  assert.deepEqual([f.turnFlags.extraAction, f.turnFlags.sneakUsed, f.turnFlags.recklessUsed, f.turnFlags.recklessUntilNextTurn], [true, true, true, true]);
  enc = fold(enc, [ev('plan.chosen', { actorId: 'pc-fighter', kind: 'melee', targetId: 'm-goblin', source: 'ai' })]);
  assert.equal(enc.entities['pc-fighter'].turnFlags.extraAction, undefined);
  assert.equal(enc.entities['pc-fighter'].turnFlags.recklessUntilNextTurn, true, 'reckless lasts to the next turn');
  enc = fold(enc, [
    ev('feature.used', { entityId: 'pc-wizard', featureId: 'divine-smite' }),
    ev('resource.spent', { entityId: 'pc-wizard', resource: 'spell-slot', level: 2 })
  ]);
  assert.equal(enc.entities['pc-wizard'].turnFlags.smiteSlotUsed, 2);
  enc = fold(enc, [ev('plan.chosen', { actorId: 'pc-wizard', kind: 'dodge', targetId: null, source: 'player' }), ev('turn.rejected', { actorId: 'pc-wizard', reason: 'x', code: 'target-down' })]);
  assert.equal(enc.entities['pc-wizard'].turnFlags.dodging, undefined, 'a rejected plan never dodges');
});

test('mirror: conditions keep R7 lifecycle; a saved concentration condition leaves its source\'s targets; Shield flag', () => {
  let enc = fold(projectedState(), [
    ev('concentration.started', { casterId: 'pc-wizard', spellId: 'hold-person', targetIds: ['m-fanatic'] }),
    ev('condition.applied', { entityId: 'm-fanatic', condition: 'paralyzed', sourceId: 'pc-wizard', endsOn: 'concentration', save: { stat: 'WIS', dc: 13 } }, 4)
  ]);
  const c = enc.entities['m-fanatic'].conditions.find(x => x.id === 'paralyzed');
  assert.deepEqual(c, { id: 'paralyzed', sourceId: 'pc-wizard', endsOn: 'concentration', save: { stat: 'WIS', dc: 13 }, appliedRound: 4 });
  enc = fold(enc, [ev('condition.removed', { entityId: 'm-fanatic', condition: 'paralyzed', sourceId: 'pc-wizard', reason: 'save' })]);
  assert.deepEqual(enc.entities['pc-wizard'].concentration.targetIds, []);
  enc = fold(enc, [ev('reaction.resolved', { reactorId: 'pc-fighter', kind: 'shield', used: true, by: 'player' })]);
  assert.equal(enc.entities['pc-fighter'].turnFlags.shieldActive, true);
  enc = fold(enc, [ev('damage', { sourceId: 'm-goblin', targetId: 'pc-fighter', amount: 3, type: null, hpBefore: 30, hpAfter: 27, absorbed: 2 })]);
  assert.equal(enc.entities['pc-fighter'].hp, 27);
});

test('mirror: the dying lifecycle (E1 wave 5) — downed, saves, stabilized, revived, died', () => {
  let enc = fold(projectedState(), [
    ev('damage', { sourceId: 'm-goblin', targetId: 'pc-wizard', amount: 27, type: null, hpBefore: 27, hpAfter: 0 }),
    ev('entity.downed', { entityId: 'pc-wizard', byId: 'm-goblin' })
  ]);
  assert.equal(enc.entities['pc-wizard'].status, 'downed');
  assert.deepEqual(enc.entities['pc-wizard'].deathSaves, { successes: 0, failures: 0, stable: false });
  enc = fold(enc, [ev('death.save', { entityId: 'pc-wizard', d20: 14, success: true, crit: false, successes: 3, failures: 1, cause: 'roll' }), ev('entity.stabilized', { entityId: 'pc-wizard' })]);
  assert.equal(lifeStatus(enc.entities['pc-wizard']), 'stable');
  assert.deepEqual(enc.entities['pc-wizard'].deathSaves, { successes: 3, failures: 1, stable: true });
  enc = fold(enc, [ev('death.save', { entityId: 'pc-wizard', d20: null, success: false, crit: false, successes: 0, failures: 2, cause: 'damage' })]);
  assert.equal(enc.entities['pc-wizard'].status, 'downed', 'a hit on a stable creature');
  enc = fold(enc, [ev('heal', { sourceId: null, targetId: 'pc-wizard', amount: 5, hpBefore: 0, hpAfter: 5 }), ev('entity.revived', { entityId: 'pc-wizard', hp: 5, byId: null })]);
  assert.equal(enc.entities['pc-wizard'].status, undefined);
  assert.equal(enc.entities['pc-wizard'].deathSaves, undefined);
  enc = fold(enc, [ev('entity.downed', { entityId: 'm-fanatic' }), ev('entity.died', { entityId: 'm-fanatic', byId: null, cause: 'monster' })]);
  assert.equal(enc.entities['m-fanatic'].status, 'dead');
  assert.equal(enc.entities['m-fanatic'].deathSaves, undefined, 'monsters never carry death saves');
});

test('mirror: Rage keeps rageSustained from start, attacks and damage; it clears at the end of the turn', () => {
  let enc = fold(projectedState(), [
    ev('condition.applied', { entityId: 'pc-fighter', condition: 'raging', sourceId: 'pc-fighter', endsOn: 'encounter', save: null })
  ]);
  assert.equal(enc.entities['pc-fighter'].turnFlags.rageSustained, true);
  enc = fold(enc, [ev('turn.ended', { actorId: 'pc-fighter' })]);
  assert.equal(enc.entities['pc-fighter'].turnFlags.rageSustained, undefined);
  enc = fold(enc, [ev('attack.rolled', { attackerId: 'pc-fighter', targetId: 'm-fanatic', weapon: null, isReaction: false, advantage: 'normal', d20: [3], kept: 3, bonus: 5, total: 8, ac: 13, hit: false, crit: false, shielded: false })]);
  assert.equal(enc.entities['pc-fighter'].turnFlags.rageSustained, true);
});

test('mirror: applyEntityPatch — PATCHABLE fields only; a DM HP edit flips the dying state', () => {
  assert.ok(PATCHABLE_FIELDS.includes('status') && PATCHABLE_FIELDS.includes('hp'));
  let enc = applyEntityPatch(projectedState(), 'pc-wizard', { hp: 0, resources: { reactionUsed: false } });
  const w = enc.entities['pc-wizard'];
  assert.equal(w.resources.reactionUsed, true, 'resources are not patchable');
  assert.deepEqual([w.status, w.deathSaves.failures, w.conditions.includes('unconscious')], ['downed', 0, true]);
  enc = applyEntityPatch(enc, 'pc-wizard', { hp: 9 });
  assert.deepEqual([enc.entities['pc-wizard'].status, enc.entities['pc-wizard'].conditions.includes('unconscious')], [undefined, false]);
  enc = applyEntityPatch(enc, 'm-fanatic', { position: { col: 1, row: 1 } });
  assert.deepEqual(enc.entities['m-fanatic'].pos, { col: 1, row: 1 });
  assert.equal(applyEntityPatch(enc, 'Something', { hp: 1 }), enc, 'a fog-masked id is a no-op');
  assert.equal(applyEntityPatch(null, 'x', {}), null);
});

test('mirror: lifeStatus reads status, or HP on servers without it', () => {
  assert.deepEqual(ENTITY_STATUSES, ['active', 'downed', 'stable', 'dead']);
  assert.equal(lifeStatus({ hp: 5 }), 'active');
  assert.equal(lifeStatus({ hp: 0 }), 'down');
  assert.equal(lifeStatus({ hp: 0, status: 'dead' }), 'dead');
  assert.equal(lifeStatus(null), 'active');
  const enc = clone(projectedState());
  assert.equal(lifeStatus(enc.entities['m-goblin']), 'active');
});
