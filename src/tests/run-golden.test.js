/**
 * M65 H24 — run golden: a scripted campaign run (fight → short rest →
 * fight, synthetic cleric + fighter) through the pure campaign layer and
 * the real engine, no ws.
 *
 * Script:   src/tests/fixtures/runs/<name>.run.json
 * Goldens:  src/tests/golden/<name>.run.reference.json  (reference adapter, live now)
 *           src/tests/golden/<name>.run.json            (E4 + E1's real modules)
 * Re-bless: UPDATE_GOLDEN=1 npm test   (only in a commit that says why)
 *
 * Gates (M65 H24): reproducible (twice in-process, identical), every
 * character's final state rebuilt from the run events alone, under 1 s
 * of CPU per run, Math.random tripwired.
 *
 * Un-skipping the real-module test once R24–R28 / T21 merge: delete its
 * `{ skip: … }` option, then `UPDATE_GOLDEN=1 npm test` once to write
 * its golden and review the diff against the reference golden.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { installTripwires } from './helpers/tripwires.js';

installTripwires();
const {
  loadRunScript, runScript, replayRunEvents, goldenOf, referenceAdapter, assertRunAdapter, RUN_ADAPTER_METHODS, SRD_XP_THRESHOLDS
} = await import('./helpers/run-driver.js');
const { validateRunEventLog, isMutatingRunEvent } = await import('../js/shared/run-events.js');
const { validateRunState } = await import('../js/shared/run-state.js');

const GOLDEN_DIR = new URL('./golden/', import.meta.url);
const UPDATE = process.env.UPDATE_GOLDEN === '1';
const SCENARIO = 'fight-rest-fight';

function checkGolden(file, actual) {
  const url = new URL(file, GOLDEN_DIR);
  if (UPDATE) {
    mkdirSync(GOLDEN_DIR, { recursive: true });
    writeFileSync(url, JSON.stringify(actual, null, 2) + '\n');
    return;
  }
  assert.ok(existsSync(url), `no golden ${file}; run UPDATE_GOLDEN=1 npm test and commit the reason`);
  assert.deepStrictEqual(actual, JSON.parse(readFileSync(url, 'utf8')), `${file} diverged from its golden`);
}

/** CPU milliseconds (user + system) spent by `fn`. */
async function cpuMs(fn) {
  const t0 = process.cpuUsage();
  const out = await fn();
  const d = process.cpuUsage(t0);
  return { out, ms: (d.user + d.system) / 1000 };
}

/** The shared invariants every run must satisfy, whatever the adapter. */
function assertRunInvariants(r) {
  assert.deepEqual(validateRunEventLog(r.runEvents).errors, []);
  for (const ev of r.runEvents) {
    if (isMutatingRunEvent(ev.type)) assert.ok('before' in ev.payload && 'after' in ev.payload, `${ev.type} carries before/after`);
  }
  assert.deepStrictEqual(replayRunEvents(r.runEvents), r.final, 'the final state is reproducible from the run events alone');
  const types = r.runEvents.map(e => e.type);
  assert.deepEqual(types.filter(t => t === 'node.entered').length, 3, 'three nodes entered');
  assert.deepEqual(types.filter(t => t === 'encounter.result').length, 2);
  assert.deepEqual(types.filter(t => t === 'rest.taken').length, 1);
  assert.equal(types.at(-1), 'run.ended');
  assert.equal(r.encounters.length, 2);
  for (const e of r.encounters) assert.ok(e.eventCount > 0 && e.rounds >= 1, `${e.nodeId} ran`);
}

test('run driver: the adapter interface is enforced', () => {
  assert.deepEqual([...RUN_ADAPTER_METHODS], ['entityFromSheet', 'runStateFromEntity', 'encounterXp', 'levelForXp', 'applyRest', 'lifeStatusAfterEncounter']);
  assert.doesNotThrow(() => assertRunAdapter(referenceAdapter));
  assert.throws(() => assertRunAdapter({ ...referenceAdapter, applyRest: undefined }), /missing applyRest/);
});

test('run driver: reference adapter rules — XP split, SRD thresholds, rests', () => {
  assert.deepEqual(referenceAdapter.encounterXp({ defeated: Array(4).fill({ slug: 'goblin' }), participants: ['a', 'b', 'c', 'd'] }),
    { total: 200, perCharacter: { a: 50, b: 50, c: 50, d: 50 } });
  assert.equal(referenceAdapter.levelForXp(2700), 4);
  assert.equal(referenceAdapter.levelForXp(2699), 3);
  assert.equal(SRD_XP_THRESHOLDS.length, 20);
  const script = loadRunScript(SCENARIO);
  assert.ok(script.steps.some(s => s.t === 'rest'));
});

test(`run golden: ${SCENARIO} with the reference adapter — reproducible, replayable, < 1 s CPU`, async () => {
  const script = loadRunScript(SCENARIO);
  const { out: first, ms } = await cpuMs(() => runScript(script, referenceAdapter));
  const second = await runScript(loadRunScript(SCENARIO), referenceAdapter);
  assert.deepStrictEqual(goldenOf(second), goldenOf(first), 'a second in-process run must be identical');
  assert.deepStrictEqual(second.encounterLogs, first.encounterLogs, 'engine logs identical');
  assertRunInvariants(first);
  assert.ok(ms < 1000, `run took ${ms.toFixed(0)} ms of CPU (budget 1000)`);
  // The scripted beats: the fighter crosses 14,000 XP in fight 1 and
  // queues level 6; the short rest spends exactly the scripted hit dice.
  assert.ok(first.runEvents.some(e => e.type === 'level.queued' && e.payload.slotId === 'slot-2' && e.payload.toLevel === 6));
  const rest = first.runEvents.find(e => e.type === 'rest.taken');
  assert.equal(rest.payload.after['slot-1'].hitDice.Cleric.spent, 1);
  assert.equal(rest.payload.after['slot-2'].hitDice.Fighter.spent, 2);
  for (const s of Object.values(first.final)) assert.deepEqual(validateRunState(s.state).errors, []);
  checkGolden(`${SCENARIO}.run.reference.json`, goldenOf(first));
});

test('run golden: damage and spent resources carry from fight 1 into fight 2', async () => {
  const r = await runScript(loadRunScript(SCENARIO), referenceAdapter);
  const [res1] = r.runEvents.filter(e => e.type === 'encounter.result');
  const rest = r.runEvents.find(e => e.type === 'rest.taken');
  for (const slotId of Object.keys(res1.payload.after)) {
    assert.deepStrictEqual(rest.payload.before[slotId], res1.payload.after[slotId].state, `${slotId}: the rest starts from fight 1's write-back`);
  }
});

test(`run golden: ${SCENARIO} with E4 + E1's real modules`, { skip: 'M65: waiting on R24–R28/T21' }, async () => {
  const adapters = await import('../js/scene/encounter-adapters.js');
  const xp = await import('../js/campaign/xp.js');
  const rest = await import('../js/campaign/rest.js');
  const death = await import('../js/campaign/death.js');
  const turnManager = await import('../js/scene/turn-manager.js');
  const real = {
    entityFromSheet: adapters.entityFromSheet,           // T21: (sheet, {…, runState})
    runStateFromEntity: adapters.runStateFromEntity,     // T21: (entity, prevState)
    encounterXp: xp.encounterXp,                         // R24: ({defeated, participants})
    levelForXp: xp.levelForXp,                           // R24
    applyRest: rest.applyRest,                           // R25: (sheet, state, type, {spend, rng, settings})
    lifeStatusAfterEncounter: death.lifeStatusAfterEncounter,   // R28
    endEncounterCleanup: turnManager.endEncounterCleanup        // T22 (optional)
  };
  const script = loadRunScript(SCENARIO);
  const { out: first, ms } = await cpuMs(() => runScript(script, real));
  const second = await runScript(loadRunScript(SCENARIO), real);
  assert.deepStrictEqual(goldenOf(second), goldenOf(first));
  assertRunInvariants(first);
  assert.ok(ms < 1000, `run took ${ms.toFixed(0)} ms of CPU (budget 1000)`);
  checkGolden(`${SCENARIO}.run.json`, goldenOf(first));
});
