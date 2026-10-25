/**
 * M65 T22 — `endEncounterCleanup(ts)` replaces the old per-encounter reset:
 * encounter-scoped conditions and concentration end; exhaustion, the
 * dying state, persistent conditions and every spent resource carry
 * over. Action Surge / Second Wind / Rage come back on a rest only.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  turnStateFromEncounter, startEncounter, runTurn, endEncounter, endEncounterCleanup, encounterFromTurnState
} from '../js/scene/turn-manager.js';
import { applyCondition } from '../js/scene/combat-engine.js';
import { entityFromSheet, entityFromPreset, runStateFromEntity, wrapperFromEntity } from '../js/scene/encounter-adapters.js';
import { PC_FEATURES } from '../js/scene/ai/pc-features.js';
import { validateIntent, planFromIntent } from '../js/scene/intent-validation.js';
import { emptyEncounterState, validateEncounterState } from '../js/shared/encounter-state.js';
import { validateEvent } from '../js/shared/events.js';
import { createRng } from '../js/scene/rng.js';
import { parsedDdbFixture } from './helpers/entities.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

function jsFiles(dir) {
  return readdirSync(dir).flatMap(f => {
    const p = join(dir, f);
    if (f === 'node_modules') return [];
    return statSync(p).isDirectory() ? jsFiles(p) : (/\.(m?js)$/.test(f) ? [p] : []);
  });
}

test('T22: grep — the old per-encounter reset is gone from the code', () => {
  const needle = ['resetPer', 'EncounterFlags'].join('');
  const hits = [];
  for (const dir of ['src/js', 'api', 'src/tests']) {
    for (const file of jsFiles(join(ROOT, dir))) {
      if (readFileSync(file, 'utf8').includes(needle)) hits.push(file.slice(ROOT.length));
    }
  }
  assert.deepEqual(hits, []);
});

const fighterSheet = parsedDdbFixture('fighter-l5');
const wizardSheet = parsedDdbFixture('wizard-l5');

function arena() {
  const state = emptyEncounterState({ encounterId: 'e1', cols: 8, rows: 6, seed: 5 });
  const f = entityFromSheet(fighterSheet, { id: 'f', pos: { col: 1, row: 1 } });
  const wz = entityFromSheet(wizardSheet, { id: 'wz', pos: { col: 1, row: 3 } });
  const gob = entityFromPreset('goblin', { id: 'gob', pos: { col: 2, row: 1 }, statBlock: { hpMax: 300 } });
  state.entities = { f, wz, gob };
  state.initiative = [{ entityId: 'f', score: 20 }, { entityId: 'wz', score: 10 }, { entityId: 'gob', score: 1 }];
  const sheets = { [f.sheetRef.characterId]: fighterSheet, [wz.sheetRef.characterId]: wizardSheet };
  return { state, sheets };
}

test('T22: cleanup ends concentration and encounter-scoped conditions; keeps exhaustion, dying state, persistent conditions and spends', () => {
  const { state, sheets } = arena();
  state.entities.f.exhaustion = 2;
  const ts = turnStateFromEncounter(state, sheets);
  startEncounter(ts, { initiative: 'given' });
  const { f, wz, gob } = ts.entities;
  // Mid-fight state: Rage-like 'raging', a prone fighter, Hold Person on the goblin.
  applyCondition(f, { id: 'raging', sourceId: 'f', endsOn: 'encounter', appliedRound: 1 });
  applyCondition(f, { id: 'prone', sourceId: null, endsOn: 'turn-start' });
  applyCondition(f, { id: 'poisoned', sourceId: null, endsOn: 'persistent' });
  applyCondition(f, 'frightened');
  f._rageSustained = true;
  f._actionSurgeUsed = 1;
  f._secondWindUsed = true;
  f._reactionUsed = true;
  wz._concentrating = { spellId: 'hold-person', spellName: 'Hold Person', targetIds: ['gob'] };
  wz._slots[2] -= 1;
  applyCondition(gob, { id: 'paralyzed', sourceId: 'wz', endsOn: 'concentration', save: { stat: 'WIS', dc: 13 } });
  // The wizard is dying.
  wz.hp = 0;   // test fixture edit (an encounter happened)
  wz.status = 'downed';
  wz.deathSaves = { successes: 1, failures: 2, stable: false };
  wz.conditions.push('unconscious');
  endEncounter(ts);

  const events = [];
  let seq = 0;
  const r = endEncounterCleanup(ts, { emit: (ev) => events.push({ seq: ++seq, turnId: null, ...ev }) });
  assert.deepEqual(r, { concentrationEnded: 1, conditionsRemoved: 3 });
  for (const ev of events) assert.deepEqual(validateEvent(ev).errors, [], ev.type);
  assert.deepEqual(events.map(e => [e.type, e.payload.condition ?? e.payload.spellId, e.payload.reason]), [
    ['concentration.broken', 'hold-person', 'encounter-end'],
    ['condition.removed', 'paralyzed', 'concentration'],
    ['condition.removed', 'raging', 'encounter-end'],
    ['condition.removed', 'prone', 'encounter-end'],
    ['condition.removed', 'frightened', 'encounter-end']
  ]);

  assert.deepEqual(f.conditions, ['poisoned']);
  assert.equal(f._conditionMeta.poisoned.endsOn, 'persistent');
  assert.equal(wz._concentrating, null);
  assert.deepEqual(gob.conditions, []);
  assert.deepEqual([f._rageSustained, f._reactionUsed], [false, false]);
  assert.deepEqual([f._actionSurgeUsed, f._secondWindUsed], [1, true], 'not restored');
  assert.equal(wz._slots[2], 2, 'slots stay spent');
  assert.deepEqual([wz.hp, wz.status, wz.deathSaves.failures], [0, 'downed', 2]);
  assert.deepEqual(wz.conditions, ['unconscious']);

  const after = encounterFromTurnState(ts);
  assert.deepEqual(validateEncounterState(after).errors, []);
  assert.equal(after.entities.f.exhaustion, 2);
  assert.deepEqual(after.entities.f.resources.features['action-surge'], { max: 1, spent: 1 });
  assert.deepEqual(after.entities.f.resources.features['second-wind'], { max: 1, spent: 1 });
  const fState = runStateFromEntity(after.entities.f, {});
  assert.deepEqual(fState.conditions, ['poisoned']);
  assert.equal(fState.exhaustion, 2);
  const wzState = runStateFromEntity(after.entities.wz, {});
  assert.deepEqual([wzState.hp.current, wzState.deathSaves, wzState.conditions], [0, { successes: 1, failures: 2, stable: false }, []]);
  assert.deepEqual(wzState.slots.spell['2'], { spent: 1 });
  assert.equal(wzState.concentration, null);
});

test('T22: cleanup without ctx emits nothing and is idempotent', () => {
  const { state, sheets } = arena();
  const ts = turnStateFromEncounter(state, sheets);
  applyCondition(ts.entities.f, { id: 'raging', sourceId: 'f', endsOn: 'encounter' });
  assert.deepEqual(endEncounterCleanup(ts), { concentrationEnded: 0, conditionsRemoved: 1 });
  assert.deepEqual(endEncounterCleanup(ts), { concentrationEnded: 0, conditionsRemoved: 0 });
});

/** E4's rest.js when it is on the branch, else the plan's short-rest rule. */
async function shortRest(sheet, runState) {
  const rest = await import('../js/campaign/rest.js').catch(() => null);
  if (typeof rest?.applyRest === 'function') {
    return rest.applyRest(sheet, runState, 'short', { spend: {}, rng: createRng({ s: 1 }) }).state;
  }
  // Stub (R25 semantics): `sr` resources and pact slots recover.
  const out = JSON.parse(JSON.stringify(runState));
  for (const r of Object.values(out.resources || {})) if ((r.recovery || []).includes('sr')) r.spent = 0;
  if (out.slots?.pact) out.slots.pact.spent = 0;
  return out;
}

async function fightOnce(runState) {
  const state = emptyEncounterState({ encounterId: 'e', cols: 8, rows: 6, seed: 9 });
  state.entities.f = entityFromSheet(fighterSheet, { id: 'f', pos: { col: 1, row: 1 }, controller: { type: 'player', seatId: 's1' }, runState });
  state.entities.gob = entityFromPreset('goblin', { id: 'gob', pos: { col: 2, row: 1 }, statBlock: { hpMax: 300 } });
  state.initiative = [{ entityId: 'f', score: 20 }, { entityId: 'gob', score: 1 }];
  state.phase = 'running';
  state.round = 1;
  const sheets = { [state.entities.f.sheetRef.characterId]: fighterSheet };
  const intent = { actorId: 'f', plan: { kind: 'melee', targetId: 'gob', features: ['action-surge'] } };
  const v = validateIntent(state, intent, { sheets });
  return { state, sheets, intent, v };
}

test('T22: Action Surge spent in fight 1 is still spent in fight 2, and back after a short rest', async () => {
  const start = {
    schema_v: 1, hp: { current: 44, temp: 0 }, deathSaves: { successes: 0, failures: 0, stable: false },
    hitDice: { Fighter: { die: 10, spent: 0 } }, slots: { spell: {}, pact: { spent: 0 } },
    resources: {
      'feat:action-surge': { label: 'Action Surge', max: 1, spent: 0, recovery: ['sr'] },
      'feat:second-wind': { label: 'Second Wind', max: 1, spent: 0, recovery: ['sr'] }
    },
    conditions: [], conditionMeta: {}, exhaustion: 0, inspiration: false, currency: { gp: 0 }, concentration: null
  };

  // Fight 1: surge.
  const one = await fightOnce(start);
  assert.equal(one.v.ok, true, one.v.reason);
  const ts = turnStateFromEncounter(one.state, one.sheets);
  const events = [];
  await runTurn(ts, { rng: createRng({ s: 3 }), prompts: { forcePlan: planFromIntent(one.state, one.intent, { sheets: one.sheets }) }, emit: (ev) => events.push(ev) });
  assert.ok(events.some(e => e.type === 'feature.used' && e.payload.featureId === 'action-surge'));
  endEncounter(ts);
  endEncounterCleanup(ts);
  const afterOne = runStateFromEntity(encounterFromTurnState(ts).entities.f, start);
  assert.equal(afterOne.resources['feat:action-surge'].spent, 1);

  // Fight 2: still spent.
  const two = await fightOnce(afterOne);
  assert.deepEqual(two.state.entities.f.resources.features['action-surge'], { max: 1, spent: 1 });
  assert.equal(PC_FEATURES['action-surge'].available(wrapperFromEntity(two.state.entities.f, fighterSheet)), false);
  assert.deepEqual([two.v.ok, two.v.code], [false, 'bad-feature']);

  // Short rest, then fight 3: back.
  const rested = await shortRest(fighterSheet, afterOne);
  assert.equal(rested.resources['feat:action-surge'].spent, 0);
  const three = await fightOnce(rested);
  assert.deepEqual(three.state.entities.f.resources.features['action-surge'], { max: 1, spent: 0 });
  assert.equal(three.v.ok, true, three.v.reason);
});
