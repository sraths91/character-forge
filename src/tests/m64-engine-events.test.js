/**
 * M64 T4 — the engine emits catalogue-v1 events through ctx.emit.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runOneAttack, runMonsterSpell, applyDamageToEntity } from '../js/scene/combat-engine.js';
import { validateEvent } from '../js/shared/events.js';
import { fxSeedOf, normalizeAnswer, nextCinemaGroup, emitEvent, canEmit, idOf, NO_CTX } from '../js/scene/engine-events.js';
import { buildPc, buildMonster, buildScene } from './helpers/entities.js';

function collector(turnId = 't1') {
  const events = [];
  let seq = 0;
  const ctx = {
    turnId,
    emit: (ev) => {
      const full = { seq: ++seq, type: ev.type, round: 1, turnId, cinemaGroup: ev.cinemaGroup, payload: ev.payload };
      const v = validateEvent(full);
      assert.ok(v.ok, `${ev.type}: ${JSON.stringify(v.errors)}`);
      JSON.parse(JSON.stringify(full));
      events.push(full);
    }
  };
  return { ctx, events, types: () => events.map(e => e.type) };
}

const wizard = (over = {}) => buildPc({
  id: 'wiz', name: 'Wiz', ac: 12, hp: 30, hpMax: 30,
  ref: { name: 'Wiz', classes: [{ name: 'Wizard', level: 5 }], abilityModifiers: { INT: 3, DEX: 2, CON: 1 },
    spells: ['Shield', 'Counterspell'], equipment: { mainhand: { name: 'Quarterstaff' } } },
  weapon: { name: 'Quarterstaff' }, _reactionUsed: false, _slots: { 1: 2, 2: 0, 3: 1 },
  _position: { col: 1, row: 1 }, ...over
});

test('T4: a Shielded monster attack emits the exact event sequence', async () => {
  const { ctx, events, types } = collector();
  const gob = buildMonster({ id: 'gob', position: { col: 2, row: 1 } });
  const wiz = wizard();
  const cinema = [];
  // d20 = 11 → 15 vs AC 12: a hit that Shield turns into a miss.
  await runOneAttack(gob, [wiz], [gob], buildScene(), () => 0.5, {
    forcePlan: { kind: 'attack', targetId: 'wiz', targetSide: 'enemy', featuresFired: [] },
    onCinemaRound: async (r) => { cinema.push(r); }
  }, ctx);
  assert.deepEqual(types(), [
    'plan.chosen', 'reaction.offered', 'reaction.resolved', 'resource.spent', 'resource.spent',
    'attack.rolled', 'exchange'
  ]);
  const byType = Object.fromEntries(events.map(e => [e.type, e.payload]));
  assert.equal(byType['plan.chosen'].source, 'dm');
  assert.deepEqual(byType['reaction.resolved'], { reactorId: 'wiz', kind: 'shield', used: true, by: 'auto' });
  assert.equal(events[4].payload.resource, 'spell-slot');
  assert.equal(events[4].payload.level, 1);
  assert.equal(byType['attack.rolled'].shielded, true);
  assert.equal(byType['attack.rolled'].hit, false);
  assert.equal(byType.exchange.cinema.fxSeed, fxSeedOf(byType.exchange.exchangeId));
  assert.equal(cinema.length, 1, 'onCinemaRound still fires');
  assert.equal(cinema[0].miss, true);
  // One exchange = one cinema group.
  const group = events.find(e => e.type === 'attack.rolled').cinemaGroup;
  assert.ok(group);
  assert.equal(events.find(e => e.type === 'exchange').cinemaGroup, group);
});

test('T4: a Shield-negated opportunity attack is flagged shielded', async () => {
  const { ctx, events } = collector();
  const gob = buildMonster({ id: 'gob', position: { col: 2, row: 1 } });
  const wiz = wizard({ _position: { col: 1, row: 1 } });
  const far = buildMonster({ id: 'far', position: { col: 8, row: 1 }, hp: 50, hpMax: 50 });
  await runOneAttack(wiz, [gob, far], [wiz], buildScene(), () => 0.5, {
    forcePlan: { kind: 'melee', targetId: 'far', targetSide: 'enemy', weapon: { name: 'Quarterstaff' }, featuresFired: [] }
  }, ctx);
  const oa = events.find(e => e.type === 'attack.rolled' && e.payload.isReaction);
  assert.ok(oa, 'the goblin took its opportunity attack');
  assert.equal(oa.payload.shielded, true);
  assert.ok(events.some(e => e.type === 'move'));
});

test('T4: Magic Missile into Shield emits spell.fizzled{shield}', async () => {
  const { ctx, events, types } = collector();
  const kob = buildMonster({ id: 'kob', presetSlug: 'kobold-sorcerer', _slots: { 1: 2 }, position: { col: 4, row: 1 } });
  const wiz = wizard();
  await runMonsterSpell({ attacker: kob, target: wiz, plan: { spellId: 'magic-missile', castAtLevel: 1 }, rng: () => 0.5, ctx });
  assert.deepEqual(types(), ['resource.spent', 'spell.cast', 'reaction.offered', 'reaction.resolved', 'resource.spent', 'resource.spent', 'spell.fizzled']);
  assert.equal(events.at(-1).payload.reason, 'shield');
  assert.equal(wiz.hp, 30);
});

test('T4: Counterspell emits spell.countered + spell.fizzled{counterspell}', async () => {
  const { ctx, events } = collector();
  const fan = buildMonster({ id: 'fan', presetSlug: 'cult-fanatic', _slots: { 1: 4, 2: 3 } });
  const wiz = wizard();
  await runMonsterSpell({
    attacker: fan, target: wiz, plan: { spellId: 'hold-person', castAtLevel: 2 }, rng: () => 0.5,
    witnesses: [wiz], allEnemies: [wiz], ctx
  });
  const countered = events.find(e => e.type === 'spell.countered');
  assert.equal(countered.payload.counterId, 'wiz');
  assert.equal(events.at(-1).type, 'spell.fizzled');
  assert.equal(events.at(-1).payload.reason, 'counterspell');
  assert.ok(!wiz.conditions.includes('paralyzed'));
});

test('T4: a killing blow emits damage then entity.downed; failed concentration emits save + broken', () => {
  const { ctx, types, events } = collector();
  const target = buildMonster({ id: 'm', hp: 5, _concentrating: { spellId: 'hold-person', targetIds: [] } });
  applyDamageToEntity(target, 3, () => 0, ctx, { source: wizard(), type: 'Force' });
  assert.deepEqual(types(), ['damage', 'save.rolled', 'concentration.broken']);
  assert.equal(events[1].payload.reason, 'concentration');
  applyDamageToEntity(target, 9, () => 0, ctx);
  assert.deepEqual(types().slice(3), ['damage', 'entity.downed']);
  assert.equal(events[3].payload.hpAfter, 0);
});

test('T4: a forcePlan at a missing target emits turn.rejected', async () => {
  const { ctx, events } = collector();
  const pc = buildPc();
  await runOneAttack(pc, [buildMonster()], [pc], buildScene(), () => 0.5, {
    forcePlan: { kind: 'melee', targetId: 'nobody', targetSide: 'enemy', featuresFired: [] }
  }, ctx);
  assert.equal(events.at(-1).type, 'turn.rejected');
  assert.equal(events.at(-1).payload.code, 'target-not-found');
});

test('T4: engine-events helpers', () => {
  assert.equal(canEmit(NO_CTX), false);
  assert.equal(nextCinemaGroup(NO_CTX), null);
  emitEvent(NO_CTX, 'move', {});                       // no sink: no throw
  const ctx = { turnId: 'tx', emit() {} };
  assert.equal(nextCinemaGroup(ctx), 'tx.x1');
  assert.equal(nextCinemaGroup(ctx), 'tx.x2');
  assert.equal(fxSeedOf('a'), fxSeedOf('a'));
  assert.ok(Number.isInteger(fxSeedOf('a')) && fxSeedOf('a') >= 0);
  assert.deepEqual(normalizeAnswer(true, false), { answer: true, by: 'auto' });
  assert.deepEqual(normalizeAnswer(false, true), { answer: false, by: 'player' });
  assert.deepEqual(normalizeAnswer({ answer: true, by: 'timeout' }, true), { answer: true, by: 'timeout' });
  assert.equal(idOf({ id: 7 }), '7');
  assert.equal(idOf(null), null);
});
