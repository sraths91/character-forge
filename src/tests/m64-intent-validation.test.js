/**
 * M64 T9 — intent validation, planFromIntent, plan.moveTo, speedFt.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateIntent, planFromIntent, weaponsOf } from '../js/scene/intent-validation.js';
import { turnStateFromEncounter, startEncounter, runTurn, encounterFromTurnState } from '../js/scene/turn-manager.js';
import { runOneAttack } from '../js/scene/combat-engine.js';
import { createRng } from '../js/scene/rng.js';
import { parsedDdbFixture, buildPc, buildMonster, buildScene } from './helpers/entities.js';

const fixture = (n) => JSON.parse(readFileSync(new URL(`./fixtures/encounters/${n}.state.json`, import.meta.url), 'utf8'));
const sheets = { 'fighter-l5': parsedDdbFixture('fighter-l5'), 'wizard-l5': parsedDdbFixture('wizard-l5') };
const act = (actorId, plan) => ({ actorId, plan });
const opts = { sheets, checkTurn: false };

test('T9: valid intents pass', () => {
  const s = fixture('counterspell');
  assert.deepEqual(validateIntent(s, act('pc-fighter', { kind: 'melee', targetId: 'm-fanatic-a', weaponName: 'Longsword' }), opts), { ok: true });
  assert.deepEqual(validateIntent(s, act('pc-wizard', { kind: 'cast', spellId: 'magic-missile', castAtLevel: 1, targetId: 'm-fanatic-a' }), opts), { ok: true });
});

test('T9: invalid target / unknown spell / no slot / out of range are rejected with a reason', () => {
  const s = fixture('counterspell');
  const cases = [
    [act('pc-fighter', { kind: 'melee', targetId: 'ghost' }), 'no-target'],
    [act('pc-fighter', { kind: 'melee', targetId: 'pc-wizard' }), 'wrong-side'],
    [act('pc-fighter', { kind: 'melee', targetId: 'm-fanatic-a', weaponName: 'Vorpal Sword' }), 'no-weapon'],
    [act('pc-wizard', { kind: 'cast', spellId: 'wish', targetId: 'm-fanatic-a' }), 'unknown-spell'],
    [act('pc-wizard', { kind: 'cast', spellId: 'cure-wounds', targetId: 'pc-fighter' }), 'unknown-spell'],
    [act('pc-wizard', { kind: 'cast', spellId: 'magic-missile', castAtLevel: 4, targetId: 'm-fanatic-a' }), 'no-slot'],
    [act('pc-fighter', { kind: 'move' }), 'bad-move'],
    [act('pc-fighter', { kind: 'feature', features: [] }), 'no-feature'],
    [act('pc-fighter', { kind: 'melee', targetId: 'm-fanatic-a', features: ['divine-smite'] }), 'bad-feature'],
    [act('pc-fighter', { kind: 'melee', targetId: 'm-fanatic-a', features: ['nope'] }), 'bad-feature']
  ];
  for (const [intent, code] of cases) {
    const v = validateIntent(s, intent, opts);
    assert.equal(v.ok, false, JSON.stringify(intent));
    assert.equal(v.code, code, `${JSON.stringify(intent.plan)} → ${v.reason}`);
    assert.ok(v.reason.length > 0);
  }
  // Out of range: push the target far away.
  const far = fixture('counterspell');
  far.grid.cols = 40;
  far.entities['m-fanatic-a'].pos = { col: 39, row: 0 };
  const v = validateIntent(far, act('pc-fighter', { kind: 'melee', targetId: 'm-fanatic-a' }), opts);
  assert.equal(v.code, 'out-of-range');
  // Spent slots.
  const dry = fixture('counterspell');
  dry.entities['pc-wizard'].resources.slots['1'].spent = 4;
  assert.equal(validateIntent(dry, act('pc-wizard', { kind: 'cast', spellId: 'magic-missile', castAtLevel: 1, targetId: 'm-fanatic-a' }), opts).code, 'no-slot');
});

test('T9: turn order, downed/incapacitated actors, moveTo checks, injected rangeBand', () => {
  const s = fixture('counterspell');
  const current = s.initiative[s.turnIndex].entityId;
  const other = s.initiative.find(r => r.entityId !== current).entityId;
  assert.equal(validateIntent(s, act(other, { kind: 'dodge' }), { sheets }).code, 'not-your-turn');
  const down = fixture('counterspell'); down.entities['pc-fighter'].hp = 0;
  assert.equal(validateIntent(down, act('pc-fighter', { kind: 'dodge' }), opts).code, 'actor-down');
  const para = fixture('counterspell'); para.entities['pc-fighter'].conditions = ['paralyzed'];
  assert.equal(validateIntent(para, act('pc-fighter', { kind: 'dodge' }), opts).code, 'incapacitated');
  const occupied = s.entities['m-fanatic-a'].pos;
  assert.equal(validateIntent(s, act('pc-fighter', { kind: 'move', moveTo: occupied }), opts).code, 'bad-move');
  assert.equal(validateIntent(s, act('pc-fighter', { kind: 'move', moveTo: { col: 99, row: 0 } }), opts).code, 'bad-move');
  const v = validateIntent(s, act('pc-fighter', { kind: 'melee', targetId: 'm-fanatic-a' }), { ...opts, rangeBand: () => 'out' });
  assert.equal(v.code, 'out-of-range');
  assert.ok(weaponsOf(s.entities['pc-fighter'], sheets['fighter-l5']).some(w => w.name === 'Longsword'));
});

test('T9: planFromIntent builds the forcePlan; a player-chosen cell is honoured', async () => {
  const state = fixture('oa-leave-melee');
  const fighter = state.entities['pc-fighter'];
  const dest = { col: fighter.pos.col, row: Math.min(state.grid.rows - 1, fighter.pos.row + 1) };
  const intent = act('pc-fighter', { kind: 'move', moveTo: dest });
  assert.deepEqual(validateIntent(state, intent, opts), { ok: true });
  const plan = planFromIntent(state, intent, { sheets });
  assert.deepEqual(plan.moveTo, dest);
  const ts = turnStateFromEncounter(state, sheets);
  startEncounter(ts, { initiative: 'given' });
  ts.turnIndex = ts.initiative.findIndex(r => r.entityId === 'pc-fighter');
  await runTurn(ts, { rng: createRng({ s: 1 }), prompts: { forcePlan: plan } });
  assert.deepEqual(encounterFromTurnState(ts).entities['pc-fighter'].pos, dest);
  const melee = planFromIntent(state, act('pc-fighter', { kind: 'attack', targetId: 'm-gob-a', weaponName: 'Longsword', features: ['action-surge'] }), { sheets });
  assert.equal(melee.kind, 'melee');
  assert.equal(melee.weapon.name, 'Longsword');
  assert.ok(!('slot' in melee.weapon));
  assert.deepEqual(melee.featuresFired, ['action-surge']);
});

test('T9: the engine rejects an illegal moveTo and uses the entity speedFt', async () => {
  const events = [];
  const pc = buildPc({ speedFt: 10, _position: { col: 0, row: 0 } });
  const m = buildMonster({ position: { col: 9, row: 0 }, hp: 50, hpMax: 50 });
  await runOneAttack(pc, [m], [pc], buildScene(), createRng({ s: 1 }), {
    forcePlan: { kind: 'move', moveTo: { col: 5, row: 0 }, featuresFired: [] }
  }, { emit: (e) => events.push(e) });
  assert.equal(events.at(-1).type, 'turn.rejected');
  assert.equal(events.at(-1).payload.code, 'bad-move');
  assert.deepEqual(pc._position, { col: 0, row: 0 });
  // AI movement honours speedFt: 10 ft = 2 cells.
  const slow = buildPc({ speedFt: 10, _position: { col: 0, row: 0 } });
  await runOneAttack(slow, [buildMonster({ position: { col: 9, row: 0 }, hp: 50, hpMax: 50 })], [slow], buildScene(), createRng({ s: 1 }), {
    forcePlan: { kind: 'melee', targetId: 'm1', targetSide: 'enemy', featuresFired: [] }
  });
  assert.equal(slow._position.col, 2);
});

test('T9/M1: weapon range goes through grid-legality.weaponRangeBand (long range allowed, beyond long rejected)', () => {
  const s = fixture('counterspell');
  s.grid.cols = 200;
  const fighter = s.entities['pc-fighter'];
  const target = s.entities['m-fanatic-a'];
  const bowSheets = { ...sheets, 'fighter-l5': { ...sheets['fighter-l5'], equipment: { ...sheets['fighter-l5'].equipment, mainhand: { name: 'Longbow', range: 150, longRange: 600, damage: '1d8', attackType: 2, properties: [{ name: 'Ammunition' }, { name: 'Heavy' }, { name: 'Two-Handed' }] } } } };
  const o = { sheets: bowSheets, checkTurn: false };
  target.pos = { col: fighter.pos.col + 100, row: fighter.pos.row };   // 500 ft: long range
  assert.deepEqual(validateIntent(s, act('pc-fighter', { kind: 'ranged', targetId: 'm-fanatic-a' }), o), { ok: true });
  target.pos = { col: fighter.pos.col + 130, row: fighter.pos.row };   // 650 ft: beyond the long range
  assert.equal(validateIntent(s, act('pc-fighter', { kind: 'ranged', targetId: 'm-fanatic-a' }), o).code, 'out-of-range');
});

test('T9/M1: with a terrain layer moveTo needs a legal path within speedFt', async () => {
  const { createTerrain, encodeTerrain, setFlag, TERRAIN_FLAGS } = await import('../js/map/terrain.js');
  const s = fixture('oa-leave-melee');
  const fighter = s.entities['pc-fighter'];
  const dest = { col: fighter.pos.col, row: fighter.pos.row + 1 };
  if (dest.row >= s.grid.rows) dest.row = fighter.pos.row - 1;
  assert.deepEqual(validateIntent(s, act('pc-fighter', { kind: 'move', moveTo: dest }), opts), { ok: true });
  s.grid.terrain = encodeTerrain(setFlag(createTerrain(s.grid.cols, s.grid.rows), dest.col, dest.row, TERRAIN_FLAGS.BLOCKED));
  assert.equal(validateIntent(s, act('pc-fighter', { kind: 'move', moveTo: dest }), opts).code, 'bad-move');
});
