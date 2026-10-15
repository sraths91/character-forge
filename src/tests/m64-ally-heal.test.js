/**
 * M64 round 3 — AI ally-heal plans resolve among the allies.
 *
 * The planners (choosePcAction / chooseAction) emit `targetSide: 'ally'`
 * heal plans; the engine used to look the target up among the enemies,
 * so the plan found nobody and the turn was skipped. Every plan now
 * resolves by its `targetSide`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runOneAttack } from '../js/scene/combat-engine.js';
import { seedRng } from '../js/scene/simulator.js';
import { buildPc, buildScene, monsterFromPreset, parsedDdbFixture, pcFromSheet } from './helpers/entities.js';

function collect() {
  const events = [];
  return { events, ctx: { emit: (ev) => events.push(ev) } };
}

test('M64 ally-heal: a support_caster with a wounded ally casts Healing Word and the ally HP rises', async () => {
  const cleric = pcFromSheet(parsedDdbFixture('cleric-l5'), { id: 'cleric', _position: { col: 1, row: 1 } });
  const ally = buildPc({ id: 'ally', hp: 4, hpMax: 30, _position: { col: 4, row: 1 } });
  // The goblin stands beyond every spell's range, so the heal is the best plan.
  const goblin = monsterFromPreset('goblin', { id: 'gob', position: { col: 18, row: 5 } });
  const slotsBefore = cleric._slots[1];
  const { events, ctx } = collect();
  await runOneAttack(cleric, [goblin], [cleric, ally], buildScene({ cols: 20, rows: 7 }), seedRng(7), {}, ctx);
  const chosen = events.find(e => e.type === 'plan.chosen');
  assert.equal(chosen.payload.kind, 'cast');
  assert.equal(chosen.payload.spellId, 'healing-word');
  assert.equal(chosen.payload.targetId, 'ally');
  assert.ok(ally.hp > 4, `ally healed (hp ${ally.hp})`);
  const heal = events.find(e => e.type === 'heal');
  assert.ok(heal, 'heal event emitted');
  assert.equal(heal.payload.targetId, 'ally');
  assert.equal(heal.payload.hpAfter, ally.hp);
  assert.ok(!events.some(e => e.type === 'turn.skipped'), 'turn not skipped');
  assert.equal(cleric._slots[1], slotsBefore - 1, 'one level-1 slot spent');
  assert.deepEqual(cleric._position, { col: 1, row: 1 }, 'the healer does not walk toward an in-range ally');
});

test('M64 ally-heal: a monster healer (cult fanatic) heals a wounded monster ally', async () => {
  const fanatic = monsterFromPreset('cult-fanatic', { id: 'fan', position: { col: 1, row: 1 } });
  const orc = monsterFromPreset('orc', { id: 'orc', hp: 2, position: { col: 2, row: 1 } });
  const hero = buildPc({ id: 'hero', _position: { col: 8, row: 5 } });
  const { events, ctx } = collect();
  await runOneAttack(fanatic, [hero], [fanatic, orc], buildScene({ cols: 10, rows: 7 }), seedRng(11), {}, ctx);
  const chosen = events.find(e => e.type === 'plan.chosen');
  assert.equal(chosen.payload.kind, 'cast');
  assert.equal(chosen.payload.targetId, 'orc');
  assert.ok(orc.hp > 2, `orc healed (hp ${orc.hp})`);
  assert.equal(hero.hp, 30, 'the enemy is untouched');
});
