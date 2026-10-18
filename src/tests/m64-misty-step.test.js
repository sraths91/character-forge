/**
 * M64 phase 1.5 wave 6 — Misty Step (registry `kind: 'teleport'`): a
 * self-targeted cast that moves the caster without provoking, through
 * runOneAttack; the AI uses it to escape a pending leave-OA.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runOneAttack } from '../js/scene/combat-engine.js';
import { spellById } from '../js/scene/monster-spells.js';
import { validateEvent } from '../js/shared/events.js';
import { validateIntent } from '../js/scene/intent-validation.js';
import { buildPc, buildMonster, buildScene } from './helpers/entities.js';

function collector() {
  const events = [];
  let seq = 0;
  const ctx = {
    turnId: 't1',
    emit: (ev) => {
      const full = { seq: ++seq, type: ev.type, round: 1, turnId: 't1', cinemaGroup: ev.cinemaGroup, payload: ev.payload };
      assert.deepEqual(validateEvent(full).errors, [], ev.type);
      events.push(full);
    }
  };
  return { ctx, events, types: () => events.map(e => e.type) };
}

const wizard = (over = {}) => buildPc({
  id: 'wiz', name: 'Wiz', ac: 12, hp: 30, hpMax: 30,
  ref: { name: 'Wiz', classes: [{ name: 'Wizard', level: 5 }], abilityModifiers: { STR: 0, DEX: 2, CON: 1, INT: 4, WIS: 1, CHA: 0 },
    spells: ['Fire Bolt', 'Misty Step'], equipment: {} },
  weapon: null, _slots: { 1: 0, 2: 1, 3: 0 }, _position: { col: 2, row: 2 }, ...over
});
const goblin = (over = {}) => buildMonster({ id: 'gob', position: { col: 3, row: 2 }, _reactionUsed: false, ...over });
const misty = (moveTo) => ({ kind: 'cast', spellId: 'misty-step', castAtLevel: 2, targetId: null, targetSide: 'enemy', featuresFired: [], ...(moveTo ? { moveTo } : {}) });

test('registry: Misty Step is a level-2 conjuration self-teleport of 30 ft (bonus action)', () => {
  const s = spellById('misty-step');
  assert.deepEqual([s.kind, s.level, s.school, s.targetSide, s.teleportFt, s.bonusAction], ['teleport', 2, 'conjuration', 'self', 30, true]);
});

test('Misty Step: teleports to moveTo, spends the slot, and provokes no opportunity attack', async () => {
  const { ctx, events, types } = collector();
  const wiz = wizard();
  const gob = goblin();
  const moves = [];
  await runOneAttack(wiz, [gob], [wiz], buildScene(), () => 0.5, {
    forcePlan: misty({ col: 8, row: 2 }), onMove: async (m) => { moves.push(m); }
  }, ctx);
  assert.deepEqual(types(), ['plan.chosen', 'resource.spent', 'spell.cast', 'move']);
  assert.deepEqual(events[1].payload, { entityId: 'wiz', resource: 'spell-slot', level: 2 });
  assert.deepEqual(events[2].payload.targetIds, ['wiz']);
  assert.deepEqual(events[3].payload, { actorId: 'wiz', from: { col: 2, row: 2 }, to: { col: 8, row: 2 }, path: [{ col: 2, row: 2 }, { col: 8, row: 2 }], teleport: true });
  assert.deepEqual(wiz._position, { col: 8, row: 2 });
  assert.equal(wiz._slots[2], 0);
  assert.equal(gob._reactionUsed, false, 'no OA');
  assert.equal(moves.length, 1);
  assert.equal(moves[0].teleport, true);
});

test('Misty Step: an occupied, out-of-range or off-grid moveTo is rejected before the slot is spent', async () => {
  for (const [moveTo, reason] of [
    [{ col: 3, row: 2 }, /occupied/],
    [{ col: 9, row: 6 }, /beyond 30 ft/],
    [{ col: 10, row: 2 }, /off the grid/]
  ]) {
    const { ctx, events, types } = collector();
    const wiz = wizard({ _position: { col: 2, row: 0 } });
    await runOneAttack(wiz, [goblin()], [wiz], buildScene(), () => 0.5, { forcePlan: misty(moveTo) }, ctx);
    assert.deepEqual(types(), ['plan.chosen', 'turn.rejected']);
    assert.equal(events[1].payload.code, 'bad-move');
    assert.match(events[1].payload.reason, reason);
    assert.equal(wiz._slots[2], 1, 'slot kept');
    assert.deepEqual(wiz._position, { col: 2, row: 0 });
  }
});

test('AI: a wizard next to a goblin with its reaction teleports to the farthest free cell, unprovoked', async () => {
  const { ctx, events } = collector();
  const wiz = wizard();
  const gob = goblin();
  await runOneAttack(wiz, [gob], [wiz], buildScene(), () => 0.5, {}, ctx);
  const plan = events.find(e => e.type === 'plan.chosen').payload;
  assert.equal(plan.spellId, 'misty-step');
  assert.equal(plan.castAtLevel, 2);
  const move = events.find(e => e.type === 'move').payload;
  assert.equal(move.teleport, true);
  // 30 ft from (2,2) on a 10x7 grid: (8,*) is 5 cells from the goblin.
  assert.equal(Math.max(Math.abs(move.to.col - 3), Math.abs(move.to.row - 2)), 5);
  assert.ok(!events.some(e => e.type === 'reaction.offered'));
  assert.equal(gob._reactionUsed, false);
});

test('AI: no Misty Step when no leave-OA is pending, or with no slot left', async () => {
  for (const [wizOver, gobOver] of [
    [{}, { _reactionUsed: true }],
    [{}, { position: { col: 6, row: 2 } }],
    [{ _slots: { 1: 0, 2: 0, 3: 0 } }, {}]
  ]) {
    const { ctx, events } = collector();
    const wiz = wizard(wizOver);
    await runOneAttack(wiz, [goblin(gobOver)], [wiz], buildScene(), () => 0.5, {}, ctx);
    assert.notEqual(events.find(e => e.type === 'plan.chosen').payload.spellId, 'misty-step', JSON.stringify({ wizOver, gobOver }));
  }
});

test('intent validation: Misty Step needs no target and checks 30 ft, not walking speed', () => {
  const state = {
    grid: { cols: 12, rows: 6 },
    initiative: [{ entityId: 'wiz' }], turnIndex: 0,
    entities: {
      wiz: { id: 'wiz', kind: 'pc', side: 'party', name: 'Wiz', hp: 20, pos: { col: 0, row: 0 }, speedFt: 10, conditions: [],
        sheetRef: { characterId: 'c1' }, resources: { slots: { 2: { max: 1, spent: 0 } } } },
      gob: { id: 'gob', kind: 'monster', side: 'hostile', name: 'Goblin', hp: 7, pos: { col: 1, row: 0 }, conditions: [] }
    }
  };
  const sheets = { c1: { name: 'Wiz', classes: [{ name: 'Wizard', level: 5 }], spells: ['Misty Step'] } };
  const intent = (moveTo) => ({ actorId: 'wiz', plan: { kind: 'cast', spellId: 'misty-step', castAtLevel: 2, moveTo } });
  assert.deepEqual(validateIntent(state, intent({ col: 6, row: 0 }), { sheets }), { ok: true });
  const far = validateIntent(state, intent({ col: 7, row: 0 }), { sheets });
  assert.equal(far.code, 'bad-move');
  assert.match(far.reason, /30 ft/);
});
