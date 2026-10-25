/**
 * M65 H24 — determinism tripwire over the COMPOSED run: the campaign rules
 * (src/js/campaign/**), E1's run-state seam and the engine, driven end to
 * end through the run driver. campaign-portability.test.js guards each
 * campaign module on its own; this file guards what they do together.
 *
 * Every wall-clock read (Date.now, a no-argument Date, performance.now)
 * and Math.random throws from before the first rules module loads. The
 * gauntlet extends the fight-rest-fight script: both PCs start 50 XP short
 * of level 6, level up between nodes with hit points ROLLED on the run rng
 * (R26), and fight node 2 on the new sheets. The run's own output then
 * feeds the between-node rules the driver has no step for (potions,
 * downtime healing, death and revival, items, exhaustion, level revert).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { installTripwires } from './helpers/tripwires.js';

installTripwires({ strictClock: true });
const { loadRunScript, runScript, replayRunEvents, goldenOf, realRunAdapter } = await import('./helpers/run-driver.js');
const { validateRunEventLog } = await import('../js/shared/run-events.js');
const { validateRunState } = await import('../js/shared/run-state.js');
const { createRng } = await import('../js/scene/rng.js');
const { CampaignRuleError } = await import('../js/campaign/errors.js');
const { applyRest } = await import('../js/campaign/rest.js');
const { drinkPotion } = await import('../js/campaign/consumables.js');
const { castDowntimeHeal } = await import('../js/campaign/downtime-spells.js');
const { settleAfterEncounter, onNodeEntry, revive } = await import('../js/campaign/death.js');
const { itemsFromInventory, equipItem } = await import('../js/campaign/items.js');
const { applyExhaustionToEntity, effectiveHpMax } = await import('../js/campaign/exhaustion.js');
const { revertLevelUp } = await import('../js/campaign/level-up.js');
const { levelsCrossed } = await import('../js/campaign/xp.js');
const { entityFromSheet } = await import('../js/scene/encounter-adapters.js');

/**
 * Every src/js/campaign module and how this composed run reaches it. A new
 * module fails the coverage test below until it is driven here.
 */
const COVERAGE = Object.freeze({
  'consumables.js': 'drinkPotion on a run state',
  'death.js': 'settleAfterEncounter (driver), onNodeEntry, revive',
  'downtime-spells.js': 'castDowntimeHeal between nodes',
  'errors.js': 'CampaignRuleError from a refused rest',
  'exhaustion.js': 'effectiveHpMax (rests), applyExhaustionToEntity',
  'items.js': 'itemsFromInventory + equipItem on a run sheet',
  'level-up.js': "the driver's level step (planLevelUp / applyLevelUp), revertLevelUp",
  'rest.js': "the driver's rest step (hit dice on the run rng)",
  'spell-slots.js': "the cleric's level-up slot table (combineSpellSlots)",
  'util.js': 'every rule',
  'xp.js': 'encounterXp / levelForXp (driver), levelsCrossed'
});

function gauntlet() {
  const script = loadRunScript('fight-rest-fight');
  script.name = 'fight-rest-level-fight';
  script.campaign.settings.hpOnLevel = 'roll';
  for (const p of script.party) p.xp = 13950;
  const at = script.steps.findIndex(s => s.t === 'rest') + 1;
  script.steps.splice(at, 0,
    { t: 'level', slotId: 'slot-1' },
    { t: 'level', slotId: 'slot-2', picks: { asi: { STR: 2 } } });
  return script;
}

test('composed run tripwire: the clock and Math.random really throw here', () => {
  assert.throws(() => Math.random(), /unseeded rng/);
  assert.throws(() => Date.now(), /wall clock/);
  assert.throws(() => new Date(), /wall clock/);
  assert.throws(() => performance.now(), /wall clock/);
  assert.equal(new Date(0).getTime(), 0, 'a Date from a value reads no clock');
});

test('composed run tripwire: every campaign module is driven by this run', () => {
  const files = readdirSync(new URL('../js/campaign/', import.meta.url)).filter(f => f.endsWith('.js')).sort();
  assert.deepEqual(files, Object.keys(COVERAGE).sort(), 'add the new campaign module to COVERAGE and drive it below');
});

test('composed run tripwire: fight → rest → level up (rolled HP) → fight, no clock, no Math.random', async () => {
  const real = await realRunAdapter();
  const first = await runScript(gauntlet(), real);
  const second = await runScript(gauntlet(), real);
  assert.deepStrictEqual(goldenOf(second), goldenOf(first), 'the composed run is reproducible from its seed');
  assert.deepEqual(validateRunEventLog(first.runEvents).errors, []);
  assert.deepStrictEqual(replayRunEvents(first.runEvents), first.final, 'level.applied replays');

  const applied = first.runEvents.filter(e => e.type === 'level.applied');
  assert.deepEqual(applied.map(e => [e.payload.slotId, e.payload.toLevel]), [['slot-1', 6], ['slot-2', 6]]);
  for (const e of applied) {
    assert.equal(e.payload.granted.hp.mode, 'roll', 'hit points rolled on the run rng');
  }
  const fights = first.runEvents.filter(e => e.type === 'encounter.result');
  for (const slotId of ['slot-1', 'slot-2']) {
    assert.equal(first.final[slotId].level, 6);
    assert.deepEqual(first.final[slotId].pendingLevels, []);
    assert.equal(first.sheets[slotId].level, 6, 'fight 2 ran on the levelled sheet');
    assert.deepStrictEqual(fights[1].payload.before[slotId].state, applied.find(e => e.payload.slotId === slotId).payload.after.state);
    assert.deepEqual(validateRunState(first.final[slotId].state, { sheet: first.sheets[slotId] }).errors, []);
  }
  assert.ok(first.sheets['slot-1'].spellSlotTable.spell['3'] >= 3, 'cleric 6 slot table recomputed');
  assert.deepEqual(levelsCrossed(13950, first.final['slot-2'].xp, { currentLevel: 6 }), []);
});

test('composed run tripwire: the between-node rules on the run\'s own output', async () => {
  const r = await runScript(gauntlet(), await realRunAdapter());
  const rng = createRng({ s: 0x6e6f6465 });
  const cleric = { id: 'slot-1', sheet: r.sheets['slot-1'], state: r.final['slot-1'].state };
  const fighter = { id: 'slot-2', sheet: r.sheets['slot-2'], state: r.final['slot-2'].state };
  const check = (who, state) => assert.deepEqual(validateRunState(state, { sheet: who.sheet }).errors, [], who.id);

  // Downtime healing and a potion on the fighter, from the run's states.
  const hurt = { ...fighter, state: { ...fighter.state, hp: { current: 4, temp: 0 } } };
  const heal = castDowntimeHeal({ caster: cleric, spell: 'Cure Wounds', slotLevel: 1, targets: [hurt], rng });
  check(cleric, heal.casterState);
  const potion = drinkPotion(hurt.sheet, hurt.state, 'Potion of Healing', rng);
  assert.ok(potion.healed > 0);
  check(fighter, potion.state);

  // Down, settled, carried to the next node, then killed and revived.
  const down = { ...fighter.state, hp: { current: 0, temp: 0 }, deathSaves: { successes: 0, failures: 1, stable: false } };
  const settled = settleAfterEncounter(down, { outcome: 'victory', deathMode: 'standard' });
  assert.equal(settled.lifeStatus, 'stable');
  assert.equal(onNodeEntry(settled.state).state.hp.current, 1);
  const dead = { ...down, deathSaves: { successes: 0, failures: 3, stable: false } };
  assert.throws(() => applyRest(fighter.sheet, dead, 'short', { rng }), (e) => e instanceof CampaignRuleError && e.code === 'dead');
  const back = revive(dead, { method: 'dm' });
  assert.equal(back.lifeStatus, 'active');
  check(fighter, back.state);

  // Run items from the sheet's inventory, equipped onto the run sheet.
  const items = itemsFromInventory(fighter.sheet, { ownerSlotId: 'slot-2' });
  const bow = items.find(i => i.name === 'Longbow');
  const swap = equipItem(fighter.sheet, items, bow.id);
  assert.equal(swap.sheet.equipment.mainhand.name, 'Longbow');
  assert.ok(swap.unequipped.includes(items.find(i => i.name === 'Longsword').id));

  // Exhaustion on the levelled sheet feeds both the rules and the engine entity.
  const tired = { ...fighter.state, exhaustion: 4 };
  assert.equal(effectiveHpMax(fighter.sheet, tired), Math.floor(fighter.sheet.hp.max / 2));
  const e = entityFromSheet(fighter.sheet, { id: 'pc-2', pos: { col: 0, row: 0 }, runState: tired });
  assert.ok(applyExhaustionToEntity(e, 4));

  // The level the run granted reverts byte-identically onto the pre-level state.
  const lv = r.runEvents.find(ev => ev.type === 'level.applied' && ev.payload.slotId === 'slot-2');
  const reverted = revertLevelUp(fighter.sheet, lv.payload.after.state, lv.payload.granted);
  assert.deepStrictEqual(reverted.state, lv.payload.before.state);
  assert.equal(reverted.sheet.level, 5);
});
