/**
 * M64 phase 1.5 — the 'feature' action kind: Second Wind and Rage, for
 * the AI (action-options / choosePcAction) and for players
 * (`turn.act {plan: {kind: 'feature', featureId}}`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  runOneAttack, useFeature, applyDamage, applyDamageModifiers, saveModeFor,
  startOfTurnConditions, endOfTurnConditions
} from '../js/scene/combat-engine.js';
import { featureOptionsFor, enumerateActions } from '../js/scene/ai/action-options.js';
import { choosePcAction } from '../js/scene/ai/pc-action.js';
import { PC_FEATURES, isRaging, rageDamageBonus, ragesPerLongRest } from '../js/scene/ai/pc-features.js';
import { validateIntent, planFromIntent } from '../js/scene/intent-validation.js';
import { entityFromSheet, entityFromPreset, wrapperFromEntity, applyWrapperToEntity } from '../js/scene/encounter-adapters.js';
import { emptyEncounterState, validateEncounterState } from '../js/shared/encounter-state.js';
import { validateClientMessage, PROTOCOL_MINOR } from '../js/shared/protocol.js';
import { validateEvent } from '../js/shared/events.js';
import { createRng } from '../js/scene/rng.js';
import { buildPc, buildMonster, buildScene, parsedDdbFixture } from './helpers/entities.js';

function sink(round = 1) {
  const events = [];
  return { events, types: () => events.map(e => e.type), ctx: { emit: (ev) => events.push({ seq: events.length + 1, round, turnId: 't', ...ev }), turnId: 't', round } };
}

const fighter = (o = {}) => buildPc({ id: 'f', _secondWindUsed: false, ...o });
const barbarian = (level = 5, o = {}) => buildPc({
  id: 'b', _rageSustained: false, _features: {},
  ref: { ...buildPc().ref, classes: [{ name: 'Barbarian', level }], equipment: { mainhand: { name: 'Greataxe', damage: '1d12', damageType: 'Slashing' } } },
  weapon: { name: 'Greataxe', damage: '1d12', damageType: 'Slashing' },
  ...o
});

test('feature options: Second Wind for a fighter, Rage for a barbarian, nothing for others', () => {
  assert.deepEqual(featureOptionsFor(fighter()).map(o => o.featureId), ['second-wind']);
  assert.deepEqual(featureOptionsFor(fighter({ _secondWindUsed: true })), []);
  assert.deepEqual(featureOptionsFor(barbarian()).map(o => o.featureId), ['rage']);
  assert.deepEqual(featureOptionsFor(buildPc({ ref: { classes: [{ name: 'Wizard', level: 5 }] } })), []);
  assert.deepEqual(featureOptionsFor(buildMonster()), []);
  const opt = enumerateActions(fighter()).find(o => o.kind === 'feature');
  assert.deepEqual({ id: opt.id, kind: opt.kind, gates: opt.gates, action: opt.action }, { id: 'feature:second-wind', kind: 'feature', gates: [], action: 'bonus' });
  assert.equal(PC_FEATURES['second-wind'].action, 'bonus');
  assert.equal(PC_FEATURES.rage.action, 'bonus');
});

test('Second Wind: a feature plan heals 1d10 + fighter level, no move or attack; once per rest', async () => {
  const f = fighter({ hp: 5, hpMax: 40, _position: { col: 0, row: 0 } });
  const m = buildMonster({ id: 'm', position: { col: 5, row: 5 } });
  const s = sink();
  await runOneAttack(f, [m], [f], buildScene(), createRng({ s: 3 }), { forcePlan: { kind: 'feature', featureId: 'second-wind', targetId: null } }, s.ctx);
  assert.deepEqual(s.types(), ['plan.chosen', 'feature.used', 'heal']);
  const heal = s.events[2].payload;
  assert.ok(heal.amount >= 6 && heal.amount <= 15, `1d10+5, got ${heal.amount}`);
  assert.equal(f._secondWindUsed, true);
  assert.deepEqual(f._position, { col: 0, row: 0 }, 'no move');
  for (const e of s.events) assert.ok(validateEvent(e).ok, e.type);
  const s2 = sink();
  await runOneAttack(f, [m], [f], buildScene(), createRng({ s: 3 }), { forcePlan: { kind: 'feature', featureId: 'second-wind' } }, s2.ctx);
  assert.equal(s2.events.at(-1).type, 'turn.rejected');
  assert.equal(s2.events.at(-1).payload.code, 'bad-feature');
});

test('Second Wind: the AI uses it alone when bloodied and out of reach, and with an attack in reach', async () => {
  const far = fighter({ hp: 8, hpMax: 40, _position: { col: 0, row: 0 } });
  const m = buildMonster({ id: 'm', hp: 30, hpMax: 30, position: { col: 9, row: 6 } });
  const alone = choosePcAction({ self: far, enemies: [m], allies: [far], rng: createRng({ s: 1 }) });
  assert.equal(alone.kind, 'feature');
  assert.equal(alone.featureId, 'second-wind');
  const near = fighter({ hp: 8, hpMax: 40, _position: { col: 1, row: 1 } });
  const m2 = buildMonster({ id: 'm', hp: 60, hpMax: 60, position: { col: 2, row: 1 } });
  const s = sink();
  await runOneAttack(near, [m2], [near], buildScene(), createRng({ s: 1 }), {}, s.ctx);
  const plan = s.events.find(e => e.type === 'plan.chosen').payload;
  assert.equal(plan.kind, 'melee');
  assert.ok(plan.featuresFired.includes('second-wind'));
  const types = s.types();
  assert.ok(types.indexOf('heal') < types.indexOf('attack.rolled'), 'the bonus action heals before the swing');
  assert.ok(near.hp > 8);
  // Healthy: never.
  const fine = fighter({ hp: 40, hpMax: 40, _position: { col: 0, row: 0 } });
  assert.notEqual(choosePcAction({ self: fine, enemies: [m], allies: [fine], rng: createRng({ s: 1 }) }).kind, 'feature');
});

test('Rage: uses per rest, damage bonus by level, and the raging condition with its lifecycle', async () => {
  assert.deepEqual([1, 3, 6, 12, 17, 20].map(l => ragesPerLongRest({ classes: [{ name: 'Barbarian', level: l }] })), [2, 3, 4, 5, 6, 99]);
  assert.deepEqual([1, 9, 16].map(l => rageDamageBonus({ classes: [{ name: 'Barbarian', level: l }] })), [2, 3, 4]);
  // Same seed with and without Rage: each hit deals exactly +2.
  const run = async (features) => {
    const b = barbarian(5, { _position: { col: 1, row: 1 } });
    const m = buildMonster({ id: 'm', hp: 500, hpMax: 500, ac: 5, position: { col: 2, row: 1 } });
    const s = sink();
    await runOneAttack(b, [m], [b], buildScene(), createRng({ s: 8 }), {
      forcePlan: { kind: 'melee', targetId: 'm', weapon: b.weapon, featuresFired: features }
    }, s.ctx);
    return { b, s };
  };
  const plain = await run([]);
  const raged = await run(['rage']);
  const dmg = (r) => r.s.events.filter(e => e.type === 'damage').map(e => e.payload.rolled);
  assert.equal(dmg(plain).length, dmg(raged).length);
  assert.ok(dmg(plain).length > 0);
  dmg(raged).forEach((d, i) => assert.equal(d, dmg(plain)[i] + 2));
  assert.ok(isRaging(raged.b));
  assert.deepEqual(raged.b._features.rage, { max: 3, spent: 1 });
  assert.equal(raged.b._rageSustained, true);
  const applied = raged.s.events.find(e => e.type === 'condition.applied');
  assert.equal(applied.payload.condition, 'raging');
  assert.equal(applied.payload.endsOn, 'encounter');
  assert.ok(raged.s.events.some(e => e.type === 'resource.spent' && e.payload.resource === 'feature:rage'));
  assert.equal(PC_FEATURES.rage.available(raged.b), false, 'no second rage while raging');
});

test('Rage: B/P/S resistance through applyDamage, STR-save advantage, no rage for spent uses', () => {
  const b = barbarian(5, { hp: 50, hpMax: 50 });
  useFeature(b, 'rage', { rng: createRng({ s: 1 }) });
  assert.deepEqual(applyDamageModifiers(b, 10, 'Slashing'), { amount: 5, modifier: 'resistant' });
  assert.deepEqual(applyDamageModifiers(b, 10, 'fire'), { amount: 10, modifier: null });
  applyDamage(b, 12, 'piercing', {});
  assert.equal(b.hp, 44);
  assert.equal(saveModeFor(b, 'STR'), 'advantage');
  assert.equal(saveModeFor(b, 'DEX'), 'normal');
  const tired = barbarian(5, { _features: { rage: { max: 3, spent: 3 } } });
  assert.equal(useFeature(tired, 'rage', { rng: createRng({ s: 1 }) }), false);
  assert.equal(isRaging(tired), false);
});

test('Rage ends: lapsed (no attack, no damage since its last turn), expired (10 rounds), downed', () => {
  const b = barbarian(5, { hp: 50, hpMax: 50 });
  const ctx1 = sink(1).ctx;
  useFeature(b, 'rage', { rng: createRng({ s: 1 }), ctx: ctx1 });
  // End of the turn it raged: kept (the start counts).
  endOfTurnConditions(b, [b], createRng({ s: 1 }), ctx1);
  assert.ok(isRaging(b));
  assert.equal(b._rageSustained, false);
  // Took damage between turns: kept.
  applyDamage(b, 4, 'fire', {});
  endOfTurnConditions(b, [b], createRng({ s: 1 }), ctx1);
  assert.ok(isRaging(b));
  // A turn with neither: it lapses.
  const s = sink(3);
  endOfTurnConditions(b, [b], createRng({ s: 1 }), s.ctx);
  assert.equal(isRaging(b), false);
  assert.equal(s.events[0].payload.reason, 'rage-lapsed');
  // 10 rounds later it expires at the start of the turn.
  const c = barbarian(5, { hp: 50, hpMax: 50 });
  useFeature(c, 'rage', { rng: createRng({ s: 1 }), ctx: { round: 2 } });
  startOfTurnConditions(c, { round: 11 });
  assert.ok(isRaging(c));
  const s2 = sink(12);
  startOfTurnConditions(c, s2.ctx);
  assert.equal(isRaging(c), false);
  assert.equal(s2.events[0].payload.reason, 'rage-expired');
  // Dropping to 0 ends it.
  const d = barbarian(5, { hp: 5, hpMax: 50, status: 'active' });
  useFeature(d, 'rage', { rng: createRng({ s: 1 }) });
  const s3 = sink();
  applyDamage(d, 30, 'fire', { ctx: s3.ctx });
  assert.equal(isRaging(d), false);
  assert.ok(s3.events.some(e => e.type === 'condition.removed' && e.payload.reason === 'downed'));
});

test('feature intents: protocol featureId, validateIntent (fresh fighter-l5), planFromIntent, adapters round-trip', () => {
  assert.ok(PROTOCOL_MINOR >= 5);
  const msg = { v: 1, t: 'turn.act', cid: 'c1', p: { turnId: 't1', plan: { kind: 'feature', featureId: 'second-wind' } } };
  assert.deepEqual(validateClientMessage(msg).errors, []);
  const sheet = parsedDdbFixture('fighter-l5');
  const sheets = { [String(sheet.id)]: sheet };
  const state = emptyEncounterState({ encounterId: 'e', cols: 8, rows: 6, seed: 1 });
  state.entities.f = entityFromSheet(sheet, { id: 'f', pos: { col: 1, row: 1 } });
  state.entities.g = entityFromPreset('goblin', { id: 'g', pos: { col: 5, row: 1 } });
  state.initiative = [{ entityId: 'f', score: 10 }, { entityId: 'g', score: 1 }];
  state.phase = 'running';
  const intent = { actorId: 'f', plan: { kind: 'feature', featureId: 'second-wind' } };
  assert.deepEqual(validateIntent(state, intent, { sheets }), { ok: true }, 'a wrapper exposes its sheet classes');
  assert.deepEqual(validateIntent(state, { actorId: 'f', plan: { kind: 'feature', featureId: 'rage' } }, { sheets }).code, 'bad-feature');
  assert.deepEqual(validateIntent(state, { actorId: 'f', plan: { kind: 'melee', targetId: 'g', features: ['action-surge'] } }, { sheets, rangeBand: () => 'normal' }), { ok: true });
  const fp = planFromIntent(state, intent, { sheets });
  assert.equal(fp.kind, 'feature');
  assert.equal(fp.featureId, 'second-wind');
  assert.deepEqual(fp.featuresFired, ['second-wind']);
  // A raging barbarian round-trips through EncounterState.
  const bsheet = { ...parsedDdbFixture('fighter-l5'), id: 'barb', classes: [{ name: 'Barbarian', level: 5 }], featureUses: { rage: { max: 3, used: 0, reset: 'long rest' } } };
  const be = entityFromSheet(bsheet, { id: 'b', pos: { col: 2, row: 2 } });
  assert.deepEqual(be.resources.features.rage, { max: 3, spent: 0 });
  const bw = wrapperFromEntity(be, bsheet);
  assert.equal(useFeature(bw, 'rage', { rng: createRng({ s: 1 }), ctx: { round: 4 } }), true);
  const back = applyWrapperToEntity(be, bw);
  assert.deepEqual(back.resources.features.rage, { max: 3, spent: 1 });
  assert.equal(back.turnFlags.rageSustained, true);
  assert.deepEqual(back.conditions, [{ id: 'raging', sourceId: 'b', endsOn: 'encounter', save: null, appliedRound: 4 }]);
  const st = { ...state, entities: { ...state.entities, b: back } };
  assert.deepEqual(validateEncounterState(st).errors, []);
  assert.ok(isRaging(wrapperFromEntity(back, bsheet)));
});
