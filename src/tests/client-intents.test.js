/**
 * M64 M8 — intent adapters: drag previews (legal / over budget / blocked),
 * DM free move, attack / cast pre-validation, protocol validity of every
 * intent built, and the engine-side forcePlan twin.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  previewMove, moveIntent, dmMoveIntent, attackIntent, castIntent, actionIntent,
  reachableFor, currentTurn, checkPlan, forcePlanFor, MAX_PLAN_PATH
} from '../js/client/intents.js';
import { validateClientMessage } from '../js/shared/protocol.js';
import { featureActionsFor, featureIntent, FEATURE_ACTIONS } from '../js/client/intents.js';
import { createTerrain, encodeTerrain, setFlag, TERRAIN_FLAGS } from '../js/map/terrain.js';
import { projectedState, clone } from './helpers/client-fixtures.js';

const WIZ_SHEET = { name: 'Fixture Wizard', equipment: { mainhand: { name: 'Quarterstaff', damage: '1d6', damageType: 'bludgeoning' } }, spells: [] };
const SHEETS = { 'wizard-l5': WIZ_SHEET, 'fighter-l5': { equipment: {} } };
const wire = (intent) => ({ v: 1, cid: '01J0000000000000000000000A', ...intent });

test('M8: a drag within speed previews a legal path from the actor', () => {
  const s = projectedState();   // pc-wizard at (1,5), speed 30
  const p = previewMove(s, 'pc-wizard', { col: 3, row: 5 });
  assert.equal(p.legal, true);
  assert.deepEqual(p.cells[0], { col: 1, row: 5 });
  assert.deepEqual(p.cells.at(-1), { col: 3, row: 5 });
  assert.equal(p.costFt, 10);
  assert.equal(p.budgetFt, 30);
});

test('M8: an over-budget drag previews red and sends nothing', () => {
  const s = projectedState();
  const p = previewMove(s, 'pc-wizard', { col: 11, row: 5 });
  assert.equal(p.legal, false);
  assert.equal(p.reason, 'over-budget');
  assert.ok(p.cells.length > 1, 'the red path is still drawn');
  assert.ok(p.costFt > 30);
  const m = moveIntent(s, { actorId: 'pc-wizard', turnId: 't1', dest: { col: 11, row: 5 }, sheets: SHEETS });
  assert.equal(m.ok, false);
  assert.equal(m.intent, null);
});

test('M8: blocked terrain and occupied cells are not legal destinations', () => {
  const s = projectedState();
  let t = createTerrain(12, 8);
  t = setFlag(t, 2, 5, TERRAIN_FLAGS.BLOCKED ?? 1);
  s.grid.terrain = encodeTerrain(t);
  assert.equal(previewMove(s, 'pc-wizard', { col: 2, row: 5 }).legal, false);
  const occ = previewMove(s, 'pc-wizard', { col: 2, row: 3 });   // the fighter stands there
  assert.equal(occ.legal, false);
  assert.equal(occ.reason, 'destination-occupied');
  assert.equal(previewMove(s, 'pc-wizard', { col: 40, row: 5 }).reason, 'out-of-bounds');
  assert.equal(previewMove(s, 'nobody', { col: 1, row: 1 }).reason, 'unknown-mover');
});

test('M8: a legal drag on your turn builds a valid turn.act move intent', () => {
  const s = projectedState();   // turnIndex 1 → pc-wizard
  const m = moveIntent(s, { actorId: 'pc-wizard', turnId: 't7', dest: { col: 3, row: 6 }, sheets: SHEETS });
  assert.equal(m.ok, true, m.reason);
  assert.equal(m.intent.t, 'turn.act');
  assert.equal(m.intent.p.turnId, 't7');
  assert.deepEqual(m.intent.p.plan.moveTo, { col: 3, row: 6 });
  assert.ok(m.intent.p.plan.path.length <= MAX_PLAN_PATH);
  assert.deepEqual(validateClientMessage(wire(m.intent)).errors, []);
  const notMine = moveIntent(s, { actorId: 'pc-fighter', turnId: 't7', dest: { col: 2, row: 4 }, sheets: SHEETS });
  assert.equal(notMine.ok, false, 'out of turn is refused client-side too');
  assert.equal(moveIntent(s, { actorId: 'pc-wizard', turnId: null, dest: { col: 3, row: 6 }, sheets: SHEETS }).reason, 'no-turn');
});

test('M8: DM free move is dm.entity.patch {position, override: true}', () => {
  const s = projectedState();
  const m = dmMoveIntent(s, 'm-fanatic', { col: 11, row: 0 });
  assert.equal(m.ok, true);
  assert.deepEqual(m.intent, { t: 'dm.entity.patch', p: { entityId: 'm-fanatic', position: { col: 11, row: 0 }, override: true } });
  assert.deepEqual(validateClientMessage(wire(m.intent)).errors, []);
  assert.equal(dmMoveIntent(s, 'm-fanatic', { col: 2, row: 3 }).reason, 'destination-occupied');
  assert.equal(dmMoveIntent(s, 'm-fanatic', { col: 99, row: 0 }).reason, 'out-of-bounds');
  assert.equal(dmMoveIntent(s, 'ghost', { col: 0, row: 0 }).reason, 'unknown-entity');
});

test('M8: attack picks pre-validate with validateIntent before sending', () => {
  const s = projectedState();
  const ok = attackIntent(s, { actorId: 'pc-wizard', turnId: 't7', targetId: 'm-goblin', weaponName: 'Quarterstaff', sheets: SHEETS });
  assert.equal(ok.ok, true, ok.reason);
  assert.equal(ok.intent.p.plan.kind, 'attack');
  assert.deepEqual(validateClientMessage(wire(ok.intent)).errors, []);
  const ally = attackIntent(s, { actorId: 'pc-wizard', turnId: 't7', targetId: 'pc-fighter', sheets: SHEETS });
  assert.equal(ally.ok, false);
  assert.equal(ally.code, 'wrong-side');
  const far = clone(s);
  far.entities['m-goblin'].pos = { col: 11, row: 0 };
  assert.equal(attackIntent(far, { actorId: 'pc-wizard', turnId: 't7', targetId: 'm-goblin', weaponName: 'Quarterstaff', sheets: SHEETS }).code, 'out-of-range');
});

test('M8: casts outside the registry point at DM adjudication; dash builds a plain plan', () => {
  const s = projectedState();
  const c = castIntent(s, { actorId: 'pc-wizard', turnId: 't7', spellId: 'wish', targetId: 'm-goblin', sheets: SHEETS });
  assert.equal(c.ok, false);
  assert.equal(c.code, 'unknown-spell');
  const d = actionIntent(s, { actorId: 'pc-wizard', turnId: 't7', kind: 'dash', sheets: SHEETS });
  assert.equal(d.ok, true, d.reason);
  assert.deepEqual(d.intent.p.plan, { kind: 'dash' });
  assert.equal(checkPlan(s, 'pc-wizard', { kind: 'teleport' }).code, 'bad-plan');
});

test('M8: currentTurn reads turn.started from history, else room.turn', () => {
  const hist = [{ type: 'turn.started', turnId: 'tA', payload: { actorId: 'x' } }];
  assert.deepEqual(currentTurn({ history: hist }), { turnId: 'tA', actorId: 'x' });
  assert.deepEqual(currentTurn({ history: [...hist, { type: 'turn.ended', payload: {} }] }), { turnId: null, actorId: null });
  assert.deepEqual(currentTurn({ history: [], room: { turn: { turnId: 'tB', actorId: 'y', awaitingIntent: true } } }), { turnId: 'tB', actorId: 'y' });
});

test('M8: reachableFor and the forcePlan twin', () => {
  const s = projectedState();
  const cells = reachableFor(s, 'pc-wizard');
  assert.ok(cells.some(c => c.col === 1 && c.row === 5), 'start included');
  assert.ok(!cells.some(c => c.col === 2 && c.row === 3), 'occupied cells are not endpoints');
  assert.ok(cells.every(c => Math.max(Math.abs(c.col - 1), Math.abs(c.row - 5)) <= 6));
  const fp = forcePlanFor(s, 'pc-wizard', { kind: 'attack', targetId: 'm-goblin', weaponName: 'Quarterstaff' }, { sheets: SHEETS });
  assert.equal(fp.kind, 'melee');
  assert.equal(fp.weapon.name, 'Quarterstaff');
  assert.equal(fp.targetId, 'm-goblin');
});

test('M64 1.5: featureActionsFor — Second Wind / Rage from the sheet, uses from the ledger, Rage blocked while raging', () => {
  assert.deepEqual(FEATURE_ACTIONS.map(f => f.id), ['second-wind', 'rage']);
  const fighter = { kind: 'pc', resources: { features: {} }, conditions: [] };
  const sw = featureActionsFor(fighter, { classes: [{ name: 'Fighter', level: 5 }] });
  assert.deepEqual(sw.map(f => [f.id, f.left, f.max, f.available]), [['second-wind', 1, 1, true]]);
  const spent = featureActionsFor({ ...fighter, resources: { features: { 'second-wind': { max: 1, spent: 1 } } } }, { classes: [{ name: 'Fighter', level: 5 }] });
  assert.deepEqual([spent[0].available, spent[0].reason], [false, 'no uses left']);
  const barb = { kind: 'pc', resources: { features: { rage: { max: 3, spent: 1 } } }, conditions: [] };
  const rage = featureActionsFor(barb, { classes: [{ name: 'Barbarian', level: 3 }] });
  assert.deepEqual(rage.map(f => [f.id, f.left, f.max]), [['rage', 2, 3]]);
  const raging = featureActionsFor({ ...barb, conditions: [{ id: 'raging', endsOn: 'encounter' }] }, { classes: [{ name: 'Barbarian', level: 3 }] });
  assert.equal(raging[0].reason, 'already raging');
  assert.deepEqual(featureActionsFor({ kind: 'monster' }, null), []);
  assert.deepEqual(featureActionsFor(fighter, { classes: [{ name: 'Wizard', level: 5 }] }), []);
});

test('M64 1.5: featureIntent builds a protocol-valid feature turn.act (featureId + features)', () => {
  const enc = projectedState();
  enc.entities['pc-fighter'].resources.features['second-wind'].spent = 0;
  enc.entities['pc-fighter'].conditions = [];
  enc.turnIndex = 0;
  const sheets = { 'fighter-l5': { id: 'fighter-l5', name: 'F', classes: [{ name: 'Fighter', level: 5 }], hp: { max: 44 }, abilityModifiers: { STR: 3, DEX: 1, CON: 2, INT: 0, WIS: 0, CHA: 0 }, proficiencyBonus: 3, equipment: {}, spells: [] } };
  const r = featureIntent(enc, { actorId: 'pc-fighter', turnId: 't1', featureId: 'second-wind', sheets });
  assert.equal(r.ok, true, r.reason);
  assert.deepEqual(r.intent.p.plan, { kind: 'feature', featureId: 'second-wind', features: ['second-wind'] });
  assert.equal(validateClientMessage({ v: 1, cid: '01J00000000000000000000000', ...r.intent }).ok, true);
  assert.equal(featureIntent(enc, { actorId: 'pc-fighter', turnId: null, featureId: 'second-wind', sheets }).ok, false);
  enc.entities['pc-fighter'].resources.features['second-wind'].spent = 1;
  const used = featureIntent(enc, { actorId: 'pc-fighter', turnId: 't1', featureId: 'second-wind', sheets });
  assert.deepEqual([used.ok, used.reason], [false, 'Second Wind: no uses left']);
});
