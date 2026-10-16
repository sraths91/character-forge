/**
 * M64 R4: acceptance for the one slot ledger on the merged engine,
 * driven end to end from DDB-shaped JSON through the parser (E4 R14
 * `spellSlotTable`) into the engine (E1 T5 `slotsForPc` / `pactForPc` /
 * `entityFromSheet`) and the intent validator (T9 `validateIntent`).
 *
 * E1's unit tests for the ledger live in m64-slot-ledger.test.js; this
 * file pins R4's acceptance rows from the M64 plan.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { parseCharacter } from '../../api/lib/ddb-parser.js';
import { slotsForPc, pactForPc, consumeShield, canCastShield } from '../js/scene/reactions.js';
import { entityFromSheet, wrapperFromEntity, applyWrapperToEntity } from '../js/scene/encounter-adapters.js';
import { validateIntent } from '../js/scene/intent-validation.js';
import { loadDdbFixture, parsedDdbFixture } from './helpers/entities.js';

// DDB `classes[].definition.spellRules.levelSpellSlots` rows (index =
// class level, row = slots of levels 1..9), as in a real export.
const FULL_TABLE = loadDdbFixture('wizard-l5').classes[0].definition.spellRules.levelSpellSlots;
const PACT_TABLE = [
  [0, 0, 0, 0, 0, 0, 0, 0, 0], [1, 0, 0, 0, 0, 0, 0, 0, 0], [2, 0, 0, 0, 0, 0, 0, 0, 0],
  [0, 2, 0, 0, 0, 0, 0, 0, 0], [0, 2, 0, 0, 0, 0, 0, 0, 0], [0, 0, 2, 0, 0, 0, 0, 0, 0]
];

/** A minimal DDB character with the given classes. */
function ddbCharacter(id, classes) {
  return {
    id, name: `Fixture ${id}`,
    race: { fullName: 'Human', baseRaceName: 'Human' },
    stats: [1, 2, 3, 4, 5, 6].map(s => ({ id: s, value: 14 })),
    bonusStats: [], overrideStats: [], inventory: [], feats: [],
    baseHitPoints: 20, bonusHitPoints: 0, overrideHitPoints: null,
    temporaryHitPoints: 0, removedHitPoints: 0,
    classes: classes.map(([name, level, table], i) => ({
      id: 990000 + i, level,
      definition: {
        id: i + 1, name, spellCastingAbilityId: 4,
        spellRules: { levelSpellSlots: table, multiClassSpellSlotDivisor: 1, multiClassSpellSlotRounding: 1 }
      }
    }))
  };
}

const SCRIPT_DIR = new URL('../js/', import.meta.url);

/** Every .js file under src/js/<dir>, as [relPath, source]. */
function sources(dir) {
  const base = new URL(`${dir}/`, SCRIPT_DIR);
  return readdirSync(base, { recursive: true })
    .filter(f => String(f).endsWith('.js'))
    .map(f => [`${dir}/${f}`, readFileSync(new URL(String(f), base), 'utf8')]);
}

/** Lines that mention the field outside a comment. */
function codeHits(src, field) {
  return src.split('\n').map((l, i) => [i + 1, l])
    .filter(([, l]) => l.includes(field) && !/^\s*(\/\/|\*|\/\*)/.test(l));
}

test('R4: Wizard 3 / Cleric 3 gets the multiclass slots {1:4, 2:3, 3:3}', () => {
  const sheet = parseCharacter(ddbCharacter(900000901, [['Wizard', 3, FULL_TABLE], ['Cleric', 3, FULL_TABLE]]));
  const slots = slotsForPc(sheet);
  assert.deepEqual({ 1: slots[1], 2: slots[2], 3: slots[3] }, { 1: 4, 2: 3, 3: 3 });
  assert.equal(slots[4], 0);
  assert.equal(pactForPc(sheet), null);
  const entity = entityFromSheet(sheet, { pos: { col: 0, row: 0 } });
  assert.deepEqual(entity.resources.slots['3'], { max: 3, spent: 0 });
});

test('R4: Warlock 5 gets pact slots {3:2} and no full-caster slots', () => {
  const sheet = parseCharacter(ddbCharacter(900000902, [['Warlock', 5, PACT_TABLE]]));
  assert.deepEqual(pactForPc(sheet), { level: 3, max: 2, spent: 0 });
  const slots = slotsForPc(sheet);
  for (let l = 1; l <= 5; l++) assert.equal(slots[l] ?? 0, 0, `no regular level-${l} slots`);
  const entity = entityFromSheet(sheet, { pos: { col: 0, row: 0 } });
  assert.deepEqual(entity.resources.pact, { level: 3, max: 2, spent: 0 });
});

test('R4: Shield then a leveled spell with one slot left: the second cast is refused', () => {
  const state = JSON.parse(readFileSync(new URL('./fixtures/encounters/counterspell.state.json', import.meta.url), 'utf8'));
  const sheets = { 'wizard-l5': parsedDdbFixture('wizard-l5'), 'fighter-l5': parsedDdbFixture('fighter-l5') };
  // One 1st-level slot left, every higher slot spent.
  state.entities['pc-wizard'].resources.slots = { 1: { max: 4, spent: 3 }, 2: { max: 3, spent: 3 }, 3: { max: 2, spent: 2 } };
  const opts = { sheets, checkTurn: false };
  const missile = { actorId: 'pc-wizard', plan: { kind: 'cast', spellId: 'magic-missile', castAtLevel: 1, targetId: 'm-fanatic-a' } };
  assert.deepEqual(validateIntent(state, missile, opts), { ok: true }, 'castable before Shield');

  // Shield spends the last slot through the engine's reaction path.
  const w = wrapperFromEntity(state.entities['pc-wizard'], sheets['wizard-l5']);
  assert.ok(canCastShield(w));
  assert.equal(consumeShield(w), 1);
  state.entities['pc-wizard'] = applyWrapperToEntity(state.entities['pc-wizard'], w);
  assert.deepEqual(state.entities['pc-wizard'].resources.slots['1'], { max: 4, spent: 4 });

  const v = validateIntent(state, missile, opts);
  assert.equal(v.ok, false);
  assert.equal(v.code, 'no-slot', v.reason);
  const upcast = { ...missile, plan: { ...missile.plan, castAtLevel: 2 } };
  assert.equal(validateIntent(state, upcast, opts).code, 'no-slot');
  // ...and Shield itself cannot fire again on a fresh reaction.
  const again = wrapperFromEntity(state.entities['pc-wizard'], sheets['wizard-l5']);
  assert.equal(canCastShield(again), false);
});

test('R4: the engine and shared model no longer use _lvl1Slots / _lvl3Slots', () => {
  const hits = [];
  for (const [file, src] of [...sources('scene'), ...sources('shared')]) {
    // encounter-state.js keeps the two retired names in its v1
    // wrapper→path map so old readers still resolve them (documented there).
    if (file === 'shared/encounter-state.js') continue;
    for (const field of ['_lvl1Slots', '_lvl3Slots']) {
      for (const [n, l] of codeHits(src, field)) hits.push(`${file}:${n}: ${l.trim()}`);
    }
  }
  assert.deepEqual(hits, []);
  const w = wrapperFromEntity(entityFromSheet(parsedDdbFixture('wizard-l5'), { pos: { col: 0, row: 0 } }), parsedDdbFixture('wizard-l5'));
  assert.equal(w._lvl1Slots, undefined);
  assert.equal(w._lvl3Slots, undefined);
});

// Was a todo until E2 moved the Shield prompt cost label onto the one
// slot ledger (the label used to read the retired field and show "1 of 0").
test('R4: main.js Shield prompt labels no longer read _lvl1Slots', () => {
  const main = readFileSync(new URL('main.js', SCRIPT_DIR), 'utf8');
  assert.deepEqual(codeHits(main, '_lvl1Slots').map(([n]) => n), []);
});
