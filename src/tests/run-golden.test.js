/**
 * M65 H24 — run golden: a scripted campaign run (fight → short rest →
 * fight, synthetic cleric + fighter) through the pure campaign layer and
 * the real engine, no ws.
 *
 * Script:   src/tests/fixtures/runs/<name>.run.json
 * Goldens:  src/tests/golden/<name>.run.reference.json  (reference adapter)
 *           src/tests/golden/<name>.run.json            (E4 + E1's real modules)
 * Re-bless: UPDATE_GOLDEN=1 npm test   (only in a commit that says why)
 *
 * Gates (M65 H24): reproducible (twice in-process, identical), every
 * character's final state rebuilt from the run events alone, under 1 s
 * of CPU per run, Math.random tripwired.
 *
 * Both goldens stay: the reference adapter is the rules written out
 * independently, so a divergence between the two run hashes names a rule
 * (asserted below, per rule, so a change in either side shows up here).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { installTripwires } from './helpers/tripwires.js';

installTripwires();
const {
  loadRunScript, runScript, replayRunEvents, goldenOf, referenceAdapter, realRunAdapter, assertRunAdapter, RUN_ADAPTER_METHODS, SRD_XP_THRESHOLDS
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
  assert.deepEqual([...RUN_ADAPTER_METHODS], ['entityFromSheet', 'runStateFromEntity', 'encounterXp', 'levelForXp', 'applyRest', 'settleAfterEncounter']);
  assert.doesNotThrow(() => assertRunAdapter(referenceAdapter));
  assert.throws(() => assertRunAdapter({ ...referenceAdapter, applyRest: undefined }), /missing applyRest/);
});

test('run driver: reference adapter rules — XP split, SRD thresholds, rests', () => {
  assert.deepEqual(referenceAdapter.encounterXp(Array(4).fill({ slug: 'goblin' }), ['a', 'b', 'c', 'd'].map(id => ({ id, lifeStatus: 'active' }))),
    { total: 200, awards: { a: 50, b: 50, c: 50, d: 50 } });
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

test(`run golden: ${SCENARIO} with E1's real run-state seam (T21 / T22) and the reference rules`, async () => {
  // Until E4's rules merge: E1's entityFromSheet / runStateFromEntity /
  // endEncounterCleanup with the reference adapter's XP, rest and death.
  const adapters = await import('../js/scene/encounter-adapters.js');
  const turnManager = await import('../js/scene/turn-manager.js');
  const hybrid = {
    ...referenceAdapter,
    entityFromSheet: adapters.entityFromSheet,
    runStateFromEntity: adapters.runStateFromEntity,
    endEncounterCleanup: turnManager.endEncounterCleanup
  };
  assert.doesNotThrow(() => assertRunAdapter(hybrid));
  const { out: first, ms } = await cpuMs(() => runScript(loadRunScript(SCENARIO), hybrid));
  const second = await runScript(loadRunScript(SCENARIO), hybrid);
  assert.deepStrictEqual(goldenOf(second), goldenOf(first), 'a second in-process run must be identical');
  assertRunInvariants(first);
  assert.ok(ms < 1000, `run took ${ms.toFixed(0)} ms of CPU (budget 1000)`);
  for (const s of Object.values(first.final)) assert.deepEqual(validateRunState(s.state).errors, []);
  const [res1] = first.runEvents.filter(e => e.type === 'encounter.result');
  const rest = first.runEvents.find(e => e.type === 'rest.taken');
  for (const slotId of Object.keys(res1.payload.after)) {
    assert.deepStrictEqual(rest.payload.before[slotId], res1.payload.after[slotId].state, `${slotId}: the rest starts from fight 1's write-back`);
  }
});

test(`run golden: ${SCENARIO} with E4 + E1's real modules`, async () => {
  const real = await realRunAdapter();
  assert.doesNotThrow(() => assertRunAdapter(real));
  const script = loadRunScript(SCENARIO);
  const { out: first, ms } = await cpuMs(() => runScript(script, real));
  const second = await runScript(loadRunScript(SCENARIO), real);
  assert.deepStrictEqual(goldenOf(second), goldenOf(first), 'a second in-process run must be identical');
  assert.deepStrictEqual(second.encounterLogs, first.encounterLogs, 'engine logs identical');
  assertRunInvariants(first);
  assert.ok(ms < 1000, `run took ${ms.toFixed(0)} ms of CPU (budget 1000)`);
  for (const s of Object.values(first.final)) assert.deepEqual(validateRunState(s.state).errors, []);
  assert.ok(first.runEvents.some(e => e.type === 'level.queued' && e.payload.slotId === 'slot-2' && e.payload.toLevel === 6));
  const rest = first.runEvents.find(e => e.type === 'rest.taken');
  assert.equal(rest.payload.after['slot-1'].hitDice.Cleric.spent, 1);
  assert.equal(rest.payload.after['slot-2'].hitDice.Fighter.spent, 2);
  checkGolden(`${SCENARIO}.run.json`, goldenOf(first));
});


test(`run golden: ${SCENARIO} — the real modules and the reference rules agree on every state`, async () => {
  // Finding (M65 phase 2, Wave 2): the run hashes differ, and only because
  // R25 records each hit-die roll as {className, die, roll, con, healed}
  // where the reference records {cls, die, roll}. Every state_json, XP
  // award, queued level and life status is identical. Projecting the roll
  // records onto their common fields makes the two runs byte-identical;
  // any other divergence is a rule difference and fails here.
  const ref = await runScript(loadRunScript(SCENARIO), referenceAdapter);
  const real = await runScript(loadRunScript(SCENARIO), await realRunAdapter());
  assert.deepStrictEqual(real.final, ref.final, 'final character state');
  assert.deepStrictEqual(real.encounters.map(e => [e.outcome, e.rounds, e.eventsHash]), ref.encounters.map(e => [e.outcome, e.rounds, e.eventsHash]));
  const project = (events) => events.map(e => e.type !== 'rest.taken' ? e : {
    ...e,
    payload: {
      ...e.payload,
      rolls: Object.fromEntries(Object.entries(e.payload.rolls).map(([slotId, rs]) =>
        [slotId, rs.map(r => ({ className: r.className ?? r.cls, die: r.die, roll: r.roll }))]))
    }
  });
  assert.deepStrictEqual(project(real.runEvents), project(ref.runEvents), 'run events, roll records projected');
  assert.notEqual(real.runHash, ref.runHash, 'the raw hashes differ only by the roll record shape (see above)');
});
