/**
 * M65 H22 — state_json v1 + run snapshot blob v1 contract tests.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  RUN_STATE_SCHEMA_V, RUN_SNAPSHOT_VERSION, RUN_STATUSES, RUN_OUTCOMES, LIFE_STATUSES, LEVEL_UP_STATUSES,
  SNAPSHOT_RUN_STATUSES, RECOVERY_PERIODS, RESOURCE_KEY_PREFIXES, HIT_DIE_BY_CLASS, MAX_ATTUNED,
  validateRunState, initialRunState, validateRunSnapshot, resourcesFromSheet, recoveryForReset,
  ledgerKeyForResource, resourceKeyForLedger, spellSlug, emptyCurrency, hitDieForClass
} from '../js/shared/run-state.js';
import { spellSlug as engineSpellSlug } from '../js/scene/feature-uses.js';
import { entityFromSheet, runStateFromEntity } from '../js/scene/encounter-adapters.js';
import { applyRest } from '../js/campaign/rest.js';
import { createRng } from '../js/scene/rng.js';
import { parseCharacter } from '../../api/lib/ddb-parser.js';
import { parsedDdbFixture, loadDdbFixture, DDB_FIXTURES } from './helpers/entities.js';

const SNAPSHOT = JSON.parse(readFileSync(new URL('./fixtures/contracts/run-snapshot.valid.json', import.meta.url), 'utf8'));
const clone = (v) => JSON.parse(JSON.stringify(v));

function assertNamedError(result, path, code) {
  assert.equal(result.ok, false, `expected failure for ${path} (${code})`);
  const hit = result.errors.find(e => e.path === path && e.code === code);
  assert.ok(hit, `expected {path:"${path}", code:"${code}"}, got ${JSON.stringify(result.errors)}`);
}

/** A state with every M64 state_json field populated (not just defaults). */
function fullState() {
  return {
    schema_v: 1,
    hp: { current: 0, temp: 4 },
    deathSaves: { successes: 1, failures: 2, stable: false },
    hitDice: { Cleric: { die: 8, spent: 2 } },
    slots: { spell: { 1: { spent: 4 }, 2: { spent: 1 }, 3: { spent: 0 } }, pact: { spent: 0 } },
    resources: {
      'feat:channel-divinity': { label: 'Channel Divinity', max: 1, spent: 1, recovery: ['sr'] },
      'spell:misty-step': { label: 'Misty Step', max: 1, spent: 0, recovery: ['lr'] },
      'ddb:12345': { label: 'Lucky', max: 3, spent: 2, recovery: ['lr', 'dawn'] }
    },
    conditions: ['poisoned', 'cursed'],
    conditionMeta: {
      poisoned: { sourceId: 'm-gob-1', endsOn: 'encounter', save: { stat: 'CON', dc: 12 }, appliedRound: 3 },
      cursed: { sourceId: null, endsOn: null, persistent: true }
    },
    exhaustion: 2,
    inspiration: true,
    currency: { cp: 3, sp: 14, ep: 0, gp: 165, pp: 1 },
    concentration: { spellId: 'bless', targetIds: ['pc-1', 'pc-2'] }
  };
}

test('run-state: constants are frozen and match the M65 schema CHECKs', () => {
  assert.equal(RUN_STATE_SCHEMA_V, 1);
  assert.equal(RUN_SNAPSHOT_VERSION, 1);
  assert.deepEqual([...RUN_STATUSES], ['lobby', 'in-node', 'between', 'paused', 'ended']);
  assert.deepEqual([...RUN_OUTCOMES], ['victory', 'defeat', 'abandoned']);
  assert.deepEqual([...LIFE_STATUSES], ['active', 'dying', 'stable', 'dead']);
  assert.deepEqual([...LEVEL_UP_STATUSES], ['pending_player', 'pending_dm', 'applied', 'reverted']);
  assert.deepEqual([...SNAPSHOT_RUN_STATUSES], ['lobby', 'between']);
  assert.equal(MAX_ATTUNED, 3);
  for (const c of [RUN_STATUSES, RUN_OUTCOMES, LIFE_STATUSES, LEVEL_UP_STATUSES, RECOVERY_PERIODS, RESOURCE_KEY_PREFIXES, HIT_DIE_BY_CLASS]) {
    assert.ok(Object.isFrozen(c));
  }
  assert.deepEqual(emptyCurrency(), { cp: 0, sp: 0, ep: 0, gp: 0, pp: 0 });
});

test('run-state: every M64 state_json field validates, standalone and against a sheet', () => {
  assert.deepEqual(validateRunState(fullState()).errors, []);
  const cleric = parsedDdbFixture('cleric-l5');
  assert.deepEqual(validateRunState(fullState(), { sheet: cleric }).errors, []);
});

test('run-state: initialRunState seeds every synthetic fixture fully rested and valid', () => {
  for (const name of DDB_FIXTURES) {
    const sheet = parsedDdbFixture(name);
    const s = initialRunState(sheet);
    assert.deepEqual(validateRunState(s, { sheet }).errors, [], name);
    assert.equal(s.hp.current, sheet.hp.max, `${name}: full HP`);
    assert.equal(s.hp.temp, 0);
    assert.deepEqual(s.deathSaves, { successes: 0, failures: 0, stable: false });
    for (const l of Object.values(s.slots.spell)) assert.equal(l.spent, 0);
    for (const r of Object.values(s.resources)) assert.equal(r.spent, 0);
    for (const h of Object.values(s.hitDice)) assert.equal(h.spent, 0);
    assert.deepEqual(s.conditions, []);
    assert.equal(s.exhaustion, 0);
    assert.equal(s.concentration, null);
  }
});

test('run-state: initialRunState — cleric slots, hit die, resource keys and recovery', () => {
  const s = initialRunState(parsedDdbFixture('cleric-l5'));
  assert.deepEqual(s.slots, { spell: { 1: { spent: 0 }, 2: { spent: 0 }, 3: { spent: 0 } }, pact: { spent: 0 } });
  assert.deepEqual(s.hitDice, { Cleric: { die: 8, spent: 0 } });
  assert.deepEqual(s.resources, {
    'feat:channel-divinity': { label: 'Channel Divinity', max: 1, spent: 0, recovery: ['sr'] },
    'spell:misty-step': { label: 'Misty Step', max: 1, spent: 0, recovery: ['lr'] }
  });
  const f = initialRunState(parsedDdbFixture('fighter-l5'));
  assert.deepEqual(f.hitDice, { Fighter: { die: 10, spent: 0 } });
  assert.deepEqual(Object.keys(f.resources).sort(), ['feat:action-surge', 'feat:second-wind']);
  assert.deepEqual(f.slots.spell, {});
});

test('run-state: initialRunState reads the parser\'s hitDice / progression before the SRD table (cleric)', () => {
  const cleric = parsedDdbFixture('cleric-l5');
  // What the parser emits (M65 R23): no classes[].hitDie at all.
  assert.equal(cleric.classes[0].hitDie, undefined);
  assert.deepEqual(cleric.hitDice, { Cleric: { die: 8, spent: 3 } });
  assert.equal(cleric.progression.Cleric.hitDie, 8);
  assert.deepEqual(initialRunState(cleric).hitDice, { Cleric: { die: 8, spent: 0 } }, 'fully rested');
  // A die that differs from the SRD table proves which source is read.
  const homebrew = clone(cleric);
  homebrew.hitDice.Cleric.die = 10;
  homebrew.progression.Cleric.hitDie = 12;
  assert.equal(hitDieForClass(homebrew, 'Cleric'), 10, 'sheet.hitDice first');
  assert.deepEqual(initialRunState(homebrew).hitDice, { Cleric: { die: 10, spent: 0 } });
  delete homebrew.hitDice;
  assert.equal(hitDieForClass(homebrew, 'Cleric'), 12, 'progression[Class].hitDie next');
  assert.deepEqual(initialRunState(homebrew).hitDice, { Cleric: { die: 12, spent: 0 } });
  delete homebrew.progression;
  assert.equal(hitDieForClass(homebrew, 'Cleric'), HIT_DIE_BY_CLASS.Cleric, 'SRD table last');
  assert.equal(hitDieForClass({ classes: [{ name: 'Homebrewer', level: 1 }] }, 'Homebrewer'), 8, '8 when nothing is known');
  assert.equal(hitDieForClass({ ...cleric, hitDice: { Cleric: { die: 7 } } }, 'Cleric'), 8, 'a non-die value falls through');
  // DDB's spent hit dice are live play state: carried only on import.
  const live = initialRunState(cleric, { importDdbState: true });
  assert.deepEqual(live.hitDice, { Cleric: { die: 8, spent: 3 } });
  assert.deepEqual(validateRunState(live, { sheet: cleric }).errors, []);
  const overspent = clone(cleric);
  overspent.hitDice.Cleric.spent = 99;
  assert.equal(initialRunState(overspent, { importDdbState: true }).hitDice.Cleric.spent, 5, 'clamped to the class level');
});

test('run-state: importDdbState carries DDB live play state', () => {
  const cleric = parsedDdbFixture('cleric-l5');
  const c = initialRunState(cleric, { importDdbState: true });
  assert.equal(c.slots.spell['1'].spent, 2, 'slotsUsed');
  assert.equal(c.hp.temp, 5);
  assert.deepEqual(validateRunState(c, { sheet: cleric }).errors, []);
  const fighter = parsedDdbFixture('fighter-l5');
  const f = initialRunState(fighter, { importDdbState: true });
  assert.equal(f.exhaustion, 2, 'exhaustion is a level, not a condition');
  assert.deepEqual(f.conditions, ['prone']);
  assert.deepEqual(validateRunState(f, { sheet: fighter }).errors, []);
  const down = { ...fighter, hp: { ...fighter.hp, current: 0 }, deathSaves: { successes: 1, failures: 2 } };
  assert.deepEqual(initialRunState(down, { importDdbState: true }).deathSaves, { successes: 1, failures: 2, stable: false });
  assert.deepEqual(initialRunState(down).deathSaves, { successes: 0, failures: 0, stable: false }, 'rested ignores DDB state');
});

test('run-state: R23 sheet.resources and sheet.currency win when present', () => {
  const sheet = {
    ...parsedDdbFixture('cleric-l5'),
    resources: { 'ddb:777': { label: 'Harness of Light', max: 2, recovery: ['lr'] }, rage: { label: 'bad key', max: 1, recovery: [] } },
    currency: { gp: 165, sp: 3 }
  };
  assert.deepEqual(resourcesFromSheet(sheet), { 'ddb:777': { label: 'Harness of Light', max: 2, spent: 0, recovery: ['lr'] } });
  assert.deepEqual(initialRunState(sheet).currency, { cp: 0, sp: 3, ep: 0, gp: 165, pp: 0 });
});

test('run-state: ddb:<componentId> resources from a real-shaped export are DM-adjudicated', () => {
  // The limited uses a real export carries beyond featureUses: an optional
  // class feature, a racial trait, an item with an unknown reset (DM-managed).
  const raw = loadDdbFixture('cleric-l5');
  raw.actions.class.push({ componentId: 5299, name: 'Harness Divine Power', limitedUse: { maxUses: 1, numberUsed: 1, resetType: 2 } });
  raw.actions.race = [{ componentId: 77, name: 'Breath Weapon', limitedUse: { maxUses: 1, numberUsed: 1, resetType: 1 } }];
  raw.actions.item = [{ componentId: 88, name: 'Mystery Charm', limitedUse: { maxUses: 2, numberUsed: 2, resetType: 99 } }];
  const sheet = parseCharacter(raw);
  const ddbKeys = Object.keys(sheet.resources).filter(k => k.startsWith('ddb:')).sort();
  assert.deepEqual(ddbKeys, ['ddb:5299', 'ddb:77', 'ddb:88']);
  assert.ok(Object.values(sheet.resources).every(r => typeof r.source === 'string'), 'the parser tags provenance');

  // Seeded fully rested, valid against the sheet; the parser's own map
  // (with `spent` and `source`) also validates as state resources.
  const fromSheet = resourcesFromSheet(sheet);
  assert.deepEqual(fromSheet['ddb:5299'], { label: 'Harness Divine Power', max: 1, spent: 0, recovery: ['lr'] });
  assert.deepEqual(fromSheet['ddb:88'].recovery, [], 'unknown reset: only the DM resets it');
  const rested = initialRunState(sheet);
  assert.deepEqual(validateRunState(rested, { sheet }).errors, []);
  assert.deepEqual(validateRunState({ ...rested, resources: clone(sheet.resources) }, { sheet }).errors, []);
  assertNamedError(validateRunState({ ...rested, resources: { 'ddb:77': { ...sheet.resources['ddb:77'], source: 7 } } }), 'resources.ddb:77.source', 'type');

  // importDdbState carries DDB's live uses for every pool.
  const live = initialRunState(sheet, { importDdbState: true });
  assert.deepEqual(['ddb:5299', 'ddb:77', 'ddb:88'].map(k => live.resources[k].spent), [1, 1, 2]);
  assert.deepEqual(validateRunState(live, { sheet }).errors, []);

  // The engine carries them as inert ledgers (E1, b897a30) and the
  // write-back returns them exactly as they came in.
  const e = entityFromSheet(sheet, { id: 'pc-1', pos: { col: 0, row: 0 }, runState: live });
  for (const k of ddbKeys) {
    assert.deepEqual(e.resources.features[k], { max: live.resources[k].max, spent: live.resources[k].spent }, `${k} rides along inert`);
  }
  const back = runStateFromEntity(e, live);
  for (const k of ddbKeys) assert.deepEqual(back.resources[k], live.resources[k], `${k} persists through an encounter`);
  assert.deepEqual(validateRunState(back, { sheet }).errors, []);

  // Rests recover them by `recovery`; an empty list never recovers.
  const short = applyRest(sheet, back, 'short', { rng: createRng({ s: 1 }) }).state;
  assert.deepEqual(['ddb:5299', 'ddb:77', 'ddb:88'].map(k => short.resources[k].spent), [1, 0, 2]);
  const long = applyRest(sheet, back, 'long').state;
  assert.deepEqual(['ddb:5299', 'ddb:77', 'ddb:88'].map(k => long.resources[k].spent), [0, 0, 2]);
  assert.deepEqual(validateRunState(long, { sheet }).errors, []);
});

test('run-state: resource key map agrees with the engine ledger keys (T21 seam)', () => {
  assert.equal(ledgerKeyForResource('feat:action-surge'), 'action-surge');
  assert.equal(ledgerKeyForResource('spell:misty-step'), 'spell:misty-step');
  assert.equal(ledgerKeyForResource('ddb:12'), 'ddb:12');
  assert.equal(resourceKeyForLedger('rage'), 'feat:rage');
  assert.equal(resourceKeyForLedger('spell:misty-step'), 'spell:misty-step');
  for (const name of DDB_FIXTURES) {
    const sheet = parsedDdbFixture(name);
    const ledger = entityFromSheet(sheet, { pos: { col: 0, row: 0 } }).resources.features;
    const keys = Object.keys(initialRunState(sheet).resources).map(ledgerKeyForResource).sort();
    assert.deepEqual(keys, Object.keys(ledger).sort(), `${name}: every run resource maps to an entity ledger and back`);
    for (const k of Object.keys(ledger)) assert.equal(ledgerKeyForResource(resourceKeyForLedger(k)), k);
  }
});

test('run-state: spellSlug mirrors the engine; recoveryForReset maps parser labels', () => {
  for (const n of ["Hunter's Mark", 'Misty Step', 'Tasha’s Hideous Laughter', '  Cure  Wounds ']) {
    assert.equal(spellSlug(n), engineSpellSlug(n), n);
  }
  assert.deepEqual(recoveryForReset('short rest'), ['sr']);
  assert.deepEqual(recoveryForReset('long rest'), ['lr']);
  assert.deepEqual(recoveryForReset('dawn'), ['dawn']);
  assert.deepEqual(recoveryForReset(null), []);
});

const STATE_VIOLATIONS = [
  ['missing schema_v', s => { delete s.schema_v; }, 'schema_v', 'version'],
  ['schema_v 2', s => { s.schema_v = 2; }, 'schema_v', 'version'],
  ['negative HP', s => { s.hp.current = -1; }, 'hp.current', 'range'],
  ['missing temp HP', s => { delete s.hp.temp; }, 'hp.temp', 'required'],
  ['four death-save failures', s => { s.deathSaves.failures = 4; }, 'deathSaves.failures', 'range'],
  ['death saves while standing', s => { s.hp.current = 5; }, 'deathSaves', 'range'],
  ['a d7 hit die', s => { s.hitDice.Cleric.die = 7; }, 'hitDice.Cleric.die', 'enum'],
  ['slot level 10', s => { s.slots.spell['10'] = { spent: 0 }; }, 'slots.spell.10', 'range'],
  ['slot remaining instead of spent', s => { s.slots.spell['1'] = { remaining: 0 }; }, 'slots.spell.1.remaining', 'unknown_field'],
  ['missing pact ledger', s => { delete s.slots.pact; }, 'slots.pact', 'required'],
  ['unprefixed resource key', s => { s.resources.rage = { label: 'Rage', max: 2, spent: 0, recovery: ['lr'] }; }, 'resources.rage', 'range'],
  ['resource overspent', s => { s.resources['ddb:12345'].spent = 4; }, 'resources.ddb:12345', 'range'],
  ['unknown recovery period', s => { s.resources['spell:misty-step'].recovery = ['week']; }, 'resources.spell:misty-step.recovery[0]', 'enum'],
  ['duplicate recovery period', s => { s.resources['spell:misty-step'].recovery = ['lr', 'lr']; }, 'resources.spell:misty-step.recovery[1]', 'duplicate'],
  ['conditionMeta without its condition', s => { s.conditionMeta.blinded = {}; }, 'conditionMeta.blinded', 'ref'],
  ['exhaustion stored as a condition', s => { s.conditions.push('exhaustion'); }, 'conditions[2]', 'forbidden_field'],
  ['exhaustion 7', s => { s.exhaustion = 7; }, 'exhaustion', 'range'],
  ['inspiration as a number', s => { s.inspiration = 1; }, 'inspiration', 'type'],
  ['purse missing gp', s => { delete s.currency.gp; }, 'currency.gp', 'required'],
  ['fractional coins', s => { s.currency.sp = 1.5; }, 'currency.sp', 'type'],
  ['concentration without a spell', s => { s.concentration = { targetIds: [] }; }, 'concentration.spellId', 'required'],
  ['unknown top-level field', s => { s.hpMax = 38; }, 'hpMax', 'unknown_field'],
  ['a function in the state', s => { s.hp.calc = () => 1; }, 'hp.calc', 'not_json_safe']
];

for (const [name, mutate, path, code] of STATE_VIOLATIONS) {
  test(`run-state: planted state violation fails — ${name}`, () => {
    const s = fullState();
    mutate(s);
    assertNamedError(validateRunState(s), path, code);
  });
}

const SHEET_VIOLATIONS = [
  ['a 4th level-3 slot spent', s => { s.slots.spell['3'].spent = 3; }, 'slots.spell.3', 'range'],
  ['a slot level the sheet lacks', s => { s.slots.spell['5'] = { spent: 1 }; }, 'slots.spell.5', 'range'],
  ['pact slots on a cleric', s => { s.slots.pact.spent = 1; }, 'slots.pact.spent', 'range'],
  ['hit dice for a class not on the sheet', s => { s.hitDice.Wizard = { die: 6, spent: 0 }; }, 'hitDice.Wizard', 'ref'],
  ['more hit dice spent than levels', s => { s.hitDice.Cleric.spent = 6; }, 'hitDice.Cleric.spent', 'range'],
  ['HP above the sheet max', s => { s.hp.current = 39; s.deathSaves = { successes: 0, failures: 0, stable: false }; }, 'hp.current', 'range']
];

for (const [name, mutate, path, code] of SHEET_VIOLATIONS) {
  test(`run-state: planted sheet violation fails — ${name}`, () => {
    const s = fullState();
    mutate(s);
    assertNamedError(validateRunState(s, { sheet: parsedDdbFixture('cleric-l5') }), path, code);
  });
}

test('run-state: the snapshot fixture is valid', () => {
  assert.deepEqual(validateRunSnapshot(clone(SNAPSHOT)).errors, []);
  const noCampaign = clone(SNAPSHOT);
  delete noCampaign.campaign;
  assert.deepEqual(validateRunSnapshot(noCampaign).errors, []);
});

const SNAPSHOT_VIOLATIONS = [
  ['version 2', b => { b.v = 2; }, 'v', 'version'],
  ['taken mid-node', b => { b.run.status = 'in-node'; }, 'run.status', 'enum'],
  ['a bad campaign setting', b => { b.run.settings.deathMode = 'soft'; }, 'run.settings.deathMode', 'enum'],
  ['rng without a seed', b => { delete b.run.rng.s; }, 'run.rng.s', 'required'],
  ['duplicate slot id', b => { b.characters[1].slotId = 'slot-1'; }, 'characters[1].slotId', 'duplicate'],
  ['duplicate seat', b => { b.characters[1].seat = 1; }, 'characters[1].seat', 'duplicate'],
  ['seat 7', b => { b.characters[1].seat = 7; }, 'characters[1].seat', 'range'],
  ['life status outside the CHECK', b => { b.characters[0].lifeStatus = 'downed'; }, 'characters[0].lifeStatus', 'enum'],
  ['an invalid character state', b => { b.characters[0].state.hp.current = 99; }, 'characters[0].state.hp.current', 'range'],
  ['item owned by an unknown slot', b => { b.items[0].ownerSlotId = 'slot-9'; }, 'items[0].ownerSlotId', 'ref'],
  ['item origin outside the CHECK', b => { b.items[0].origin = 'shop'; }, 'items[0].origin', 'enum'],
  ['negative quantity', b => { b.items[0].qty = -1; }, 'items[0].qty', 'range'],
  ['an attuned stash item', b => { b.items[1].attuned = true; }, 'items[1].attuned', 'range'],
  ['four attuned items', b => {
    for (let i = 0; i < 4; i++) b.items.push({ ...clone(b.items[0]), id: `ring-${i}`, attuned: true });
  }, 'items[5].attuned', 'range'],
  ['level-up for an unknown slot', b => { b.levelUps[0].slotId = 'slot-9'; }, 'levelUps[0].slotId', 'ref'],
  ['level-up that goes down', b => { b.levelUps[0].toLevel = 4; }, 'levelUps[0].toLevel', 'range'],
  ['current node never visited', b => { b.run.currentNodeId = 'n-cache'; }, 'run.currentNodeId', 'ref'],
  ['visited node not in the campaign', b => { b.run.visitedNodeIds.push('n-ghost'); }, 'run.visitedNodeIds[3]', 'ref'],
  ['an invalid frozen campaign', b => { b.campaign.nodes[3].next[0].to = 'n-ghost'; }, 'campaign.nodes[3].next[0].to', 'ref']
];

for (const [name, mutate, path, code] of SNAPSHOT_VIOLATIONS) {
  test(`run-state: planted snapshot violation fails — ${name}`, () => {
    const b = clone(SNAPSHOT);
    mutate(b);
    assertNamedError(validateRunSnapshot(b), path, code);
  });
}

test('run-state: validators never throw on garbage', () => {
  for (const g of [undefined, null, 0, 'x', [], {}, { hp: null }, { slots: { spell: 3 } }, { characters: [null, 1], items: [null], levelUps: [3], run: 1 }]) {
    assert.doesNotThrow(() => validateRunState(g));
    assert.doesNotThrow(() => validateRunState(g, { sheet: g }));
    assert.doesNotThrow(() => validateRunSnapshot(g));
    assert.doesNotThrow(() => initialRunState(g));
    assert.doesNotThrow(() => resourcesFromSheet(g));
  }
  assert.deepEqual(validateRunState(initialRunState({})).errors, [], 'an empty sheet still seeds a valid state');
});
