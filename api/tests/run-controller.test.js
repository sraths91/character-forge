// M65 B24 — the run controller: start, node entry, the one encounter-end
// hook (both end paths, exactly once), branching, run end, the persisted
// run RNG, and restarts (SIGTERM between nodes, mid-transition, and
// mid-encounter) reproducing the run hash. The fight-rest-fight fixture
// through the controller must equal E6's run driver (src/tests/helpers/
// run-driver.js) over the same rules.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';

import { tempRoot, tempDb } from './helpers/server.js';
import { makeRunRoom, runLog, runHash } from './helpers/runs.js';
import { installTripwires } from '../../src/tests/helpers/tripwires.js';
import { loadRunScript, runScript, replayRunEvents } from '../../src/tests/helpers/run-driver.js';
import * as adapters from '../../src/js/scene/encounter-adapters.js';
import * as TM from '../../src/js/scene/turn-manager.js';
import * as xpRules from '../../src/js/campaign/xp.js';
import * as restRules from '../../src/js/campaign/rest.js';
import * as deathRules from '../../src/js/campaign/death.js';
import { itemsLedgerFor } from '../../src/js/campaign/consumables.js';
import { validateRunEventLog, isMutatingRunEvent } from '../../src/js/shared/run-events.js';
import { validateRunState } from '../../src/js/shared/run-state.js';

installTripwires();
const { root, cleanup } = tempRoot('cf-runs-');
after(cleanup);

const SCRIPT = loadRunScript('fight-rest-fight');
const XP = { 'slot-2': 13950 };   // the script's fighter starts 50 XP short of level 6

/** The run-driver adapter over the real campaign modules (what the controller calls). */
function realAdapter(ledgers = {}) {
  const party = { 'party-victory': 'victory', 'hostile-victory': 'defeat' };
  return {
    entityFromSheet: (sheet, opts) => adapters.entityFromSheet(sheet, { ...opts, ...(ledgers[String(sheet.id)] ? { items: ledgers[String(sheet.id)] } : {}) }),
    runStateFromEntity: adapters.runStateFromEntity,
    encounterXp: ({ defeated, participants }) => {
      const a = xpRules.encounterXp(defeated, participants.map(id => ({ id })));
      return { total: a.total, perCharacter: a.awards };
    },
    levelForXp: xpRules.levelForXp,
    applyRest: (sheet, state, type, { spend, rng, settings }) => restRules.applyRest(sheet, state, type, { spend, rng, dawnIsLongRest: settings.dawnIsLongRest }),
    lifeStatusAfterEncounter: (e, { outcome, deathMode, previous }) => (previous === 'dead' ? 'dead'
      : deathRules.settleAfterEncounter(adapters.runStateFromEntity(e, {}), { outcome: party[outcome] ?? outcome, deathMode }).lifeStatus),
    endEncounterCleanup: TM.endEncounterCleanup
  };
}

const ok = (reply) => { assert.equal(reply?.t, 'ack', JSON.stringify(reply?.p)); return reply.p; };

/** Start the scripted run in a fresh run room. */
async function started() {
  const { db } = await tempDb(root);
  const ctx = makeRunRoom(db);
  const r = ctx.open();
  const out = r.room.run.start({ campaign: SCRIPT.campaign, runId: SCRIPT.runId, seed: SCRIPT.seed, xp: XP });
  return { db, ctx, r, out };
}

/** The script's steps after `start`, as intents; `upTo` stops before that step index. */
const STEPS = [
  async (r) => { ok(await r.dm('dm.node.begin', {})); await r.settle(); },
  async (r) => ok(await r.dm('dm.run.advance', { toNodeId: 'n-camp' })),
  async (r) => {
    ok(await r.dm('rest.spend', { slotId: 'slot-1', hitDice: { Cleric: 1 } }));
    ok(await r.dm('rest.spend', { slotId: 'slot-2', hitDice: { Fighter: 2 } }));
    ok(await r.dm('dm.rest.grant', { type: 'short' }));
  },
  async (r) => ok(await r.dm('dm.run.advance', { toNodeId: 'n-den' })),
  async (r) => { ok(await r.dm('dm.node.begin', {})); await r.settle(); },
  async (r) => ok(await r.dm('dm.run.end', { outcome: 'victory' }))
];

async function play(r, from = 0, to = STEPS.length) {
  for (let i = from; i < to; i++) await STEPS[i](r);
}

let reference = null;
/** The uninterrupted run (computed once). */
async function uninterrupted() {
  if (reference) return reference;
  const s = await started();
  await play(s.r);
  reference = { ...s, hash: runHash(s.r.runStore, SCRIPT.runId), log: runLog(s.r.runStore, SCRIPT.runId) };
  return reference;
}

test('B24: the fight-rest-fight fixture through the controller equals the run driver over the same rules', async () => {
  const { r, hash, log } = await uninterrupted();
  assert.deepEqual(validateRunEventLog(log).errors, []);
  for (const ev of log) if (isMutatingRunEvent(ev.type)) assert.ok('before' in ev.payload && 'after' in ev.payload, ev.type);
  // The driver gets the same potion ledgers the controller gave the engine.
  const items = r.runStore.listItems(SCRIPT.runId);
  const ledgers = {};
  for (const c of r.runStore.listCharacters(SCRIPT.runId)) {
    const l = itemsLedgerFor(items.filter(i => i.ownerSlotId === c.slotId));
    if (Object.keys(l).length) ledgers[String(c.sheet.id)] = l;
  }
  const driven = await runScript(SCRIPT, realAdapter(ledgers));
  assert.deepEqual(log.map(e => e.type), driven.runEvents.map(e => e.type));
  assert.deepStrictEqual(log, driven.runEvents, 'every run event equals the driver\'s');
  assert.equal(hash, driven.runHash);
  // Replay contract: every character's final row is rebuilt from the log alone.
  const replayed = replayRunEvents(log);
  for (const c of r.runStore.listCharacters(SCRIPT.runId)) {
    assert.deepStrictEqual(replayed[c.slotId].state, c.state, `${c.slotId} state`);
    assert.equal(replayed[c.slotId].xp, c.xp);
    assert.equal(replayed[c.slotId].lifeStatus, c.lifeStatus);
    assert.deepEqual(validateRunState(c.state, { sheet: c.sheet }).errors, []);
  }
  const run = r.runStore.getRun(SCRIPT.runId);
  assert.deepEqual([run.status, run.outcome], ['ended', 'victory']);
  assert.ok(r.runStore.listLevelUps(SCRIPT.runId).some(l => l.slotId === 'slot-2' && l.toLevel === 6), 'the fighter queued level 6');
  assert.deepEqual(r.runStore.unappliedEncounters(), []);
});

test('B24: start freezes the campaign, seats the party rested, and enters the start node', async () => {
  const { r, out, db } = await started();
  assert.deepEqual(out, { runId: SCRIPT.runId, status: 'in-node', currentNodeId: 'n-ambush' });
  const run = r.runStore.getRun(SCRIPT.runId);
  assert.deepEqual(run.campaign, SCRIPT.campaign);
  assert.equal(run.roomId, r.room.id);
  assert.deepEqual(run.rng, { algo: 'mulberry32', s: SCRIPT.seed });
  const chars = r.runStore.listCharacters(SCRIPT.runId);
  assert.deepEqual(chars.map(c => [c.slotId, c.level, c.xp, c.lifeStatus, c.state.hp.current === c.sheet.hp.max]),
    [['slot-1', 5, 6500, 'active', true], ['slot-2', 5, 13950, 'active', true]]);
  // The fighter's inventory became run items with deterministic ids.
  const potions = r.runStore.listItems(SCRIPT.runId).filter(i => /Potion/.test(i.name));
  assert.equal(potions.length, 1);
  assert.match(potions[0].id, new RegExp(`^${SCRIPT.runId}\\.\\d+\\.\\d+$`));
  assert.deepEqual(runLog(r.runStore, SCRIPT.runId).map(e => e.type), ['run.started', 'character.joined', 'character.joined', 'node.entered']);
  assert.equal(r.room.status, 'between');
  // A second run in the same room is refused; plain encounter setup too.
  assert.throws(() => r.room.run.start({ campaign: SCRIPT.campaign }), { code: 'E_INVALID_INTENT' });
  const bad = await r.dm('dm.encounter.setup', { map: null, grid: { cols: 6, rows: 6 }, monsters: [], placements: {} });
  assert.equal(bad.p.code, 'E_INVALID_INTENT');
  void db;
});

test('B24: branching — only offered edges, unless the DM overrides; the encounter must be fought first', async () => {
  const { r } = await started();
  let e = await r.dm('dm.run.advance', { toNodeId: 'n-camp' });
  assert.equal(e.p.code, 'E_INVALID_INTENT', 'an unfought encounter cannot be left without override');
  ok(await r.dm('dm.node.begin', {}));
  await r.settle();
  e = await r.dm('dm.run.advance', { toNodeId: 'n-den' });
  assert.equal(e.p.code, 'E_INVALID_INTENT', 'n-den is not on offer from n-ambush');
  ok(await r.dm('dm.run.advance', { toNodeId: 'n-den', override: true }));
  const last = runLog(r.runStore, SCRIPT.runId).at(-1);
  assert.deepEqual([last.type, last.override, last.payload.fromNodeId], ['node.entered', true, 'n-ambush']);
  const p = await r.dm('dm.run.advance', { toNodeId: 'nope', override: true });
  assert.equal(p.p.code, 'E_INVALID_INTENT');
});

test('B24: between intents are refused while the encounter is live (E_ENCOUNTER_LIVE)', async () => {
  const { r, ctx } = await started();
  r.connect(ctx.dmId, 'dm');
  ok(await r.dm('dm.node.begin', {}));
  assert.ok(r.room.loopRunning);
  const e = await r.dm('dm.rest.grant', { type: 'short' });
  assert.equal(e.p.code, 'E_ENCOUNTER_LIVE');
  await r.settle();
  ok(await r.dm('dm.rest.grant', { type: 'short' }));
});

test('B24: the write-back is applied exactly once (both end paths, replays, boot sweeps)', async () => {
  const { r } = await started();
  ok(await r.dm('dm.node.begin', {}));
  await r.settle();
  const encId = `${SCRIPT.runId}:n-ambush`;
  const results = () => runLog(r.runStore, SCRIPT.runId).filter(e => e.type === 'encounter.result').length;
  assert.equal(results(), 1);
  assert.equal(r.room.run.onEncounterEnded(encId), false, 'a second call is a no-op');
  assert.equal(r.room.run.sweep(), 0);
  assert.equal(results(), 1);
  assert.ok(r.runStore.getEncounter(encId).runAppliedAt > 0);
});

test('B24: a DM-ended encounter goes through the same hook', async () => {
  const { r, ctx } = await started();
  r.connect(ctx.dmId, 'dm');
  ok(await r.dm('dm.node.begin', {}));
  ok(await r.dm('dm.encounter.end', { outcome: 'dm-ended' }));
  await r.settle();
  const log = runLog(r.runStore, SCRIPT.runId);
  const res = log.filter(e => e.type === 'encounter.result');
  assert.equal(res.length, 1);
  assert.equal(res[0].payload.outcome, 'dm-ended');
  assert.equal(log.at(-1).type, 'node.completed');
  assert.equal(r.runStore.getRun(SCRIPT.runId).status, 'between');
  assert.equal(r.room.status, 'between');
});

test('B24: SIGTERM between nodes → identical run hash after restore', async () => {
  const ref = await uninterrupted();
  for (const cut of [1, 2, 3, 5]) {
    const { ctx, r } = await started();
    await play(r, 0, cut);
    r.room.shutdown();
    const r2 = ctx.open();
    assert.equal(r2.room.status, 'between', `cut ${cut}: a run room reopens between nodes`);
    await play(r2, cut);
    assert.equal(runHash(r2.runStore, SCRIPT.runId), ref.hash, `cut after step ${cut}`);
  }
});

test('B24: SIGTERM mid-transition (encounter ended, write-back not yet applied) → the boot sweep applies it once', async () => {
  const ref = await uninterrupted();
  const { ctx, r } = await started();
  // The process dies after the encounter's end is journaled, before the run hook runs.
  r.room.run.onEncounterEnded = () => false;
  ok(await r.dm('dm.node.begin', {}));
  await r.settle();
  assert.equal(runLog(r.runStore, SCRIPT.runId).filter(e => e.type === 'encounter.result').length, 0);
  assert.equal(r.runStore.unappliedEncounters().length, 1);
  r.room.shutdown();
  const r2 = ctx.open();
  assert.equal(r2.runStore.unappliedEncounters().filter(u => u.runId === SCRIPT.runId).length, 0, 'the sweep applied it');
  await play(r2, 1);
  assert.equal(runHash(r2.runStore, SCRIPT.runId), ref.hash);
  assert.equal(runLog(r2.runStore, SCRIPT.runId).filter(e => e.type === 'encounter.result').length, 2);
});

test('B24: SIGTERM mid-encounter → the turn replays, the encounter ends once, the run hash is identical', async () => {
  const ref = await uninterrupted();
  const { ctx, r } = await started();
  const frames = r.connect(ctx.dmId, 'dm');
  ok(await r.dm('dm.node.begin', {}));
  // Let the fight run until a few exchanges have been broadcast, then die.
  while (frames.filter(f => f.t === 'exchange').length < 3) await new Promise(res => setImmediate(res));
  r.room.shutdown();   // the in-flight turn is left to boot recovery
  const r2 = ctx.open();
  assert.equal(r2.room.status, 'paused');
  r2.room.resume();
  await r2.settle();
  await play(r2, 1);
  assert.equal(runHash(r2.runStore, SCRIPT.runId), ref.hash);
});
