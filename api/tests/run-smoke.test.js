// M65 S21 — the campaign run smoke over real sockets.
//
// The real server (rooms + ws gateway + SQLite + the REAL engine + the
// run controller) boots in-process on port 0. Over HTTP the DM authors a
// 3-node campaign (goblin ambush → short rest → bugbear den with a
// Potion of Healing and 50 gp on victory) and starts a run; two players
// join by code, paste the fighter and cleric fixtures and claim seats
// (helpers/run-table.js). Then, over real sockets with E2's sessions:
//   dm.node.begin → dm.entity.patch (the fighter starts the ambush hurt)
//   → dm.encounter.start → the players' own turns are real `turn.act`
//   intents → encounter end → run.updated 'between' → the fighter's
//   rest.spend + dm.rest.grant → dm.run.advance → the second fight →
//   loot.granted → loot.claim → item.use (the potion) → xp.awarded queues
//   level 6 → a private levelup.offer per seat → levelup.choose +
//   dm.levelup.confirm → dm.run.end.
// Asserted: the same run.event stream (seq and payload) on all three
// clients, equal to the server's run log as it goes on the wire; the
// same room seq stream; the run-event-type golden; the final run.snapshot
// equals run-driver's replay of the log, and the run RNG stream equals
// run-driver's on the same seed (encounter seeds, hit-die rolls); every
// character's state_json validates against its run sheet; no player
// receives another seat's prose on any frame or member route (S23).
//
// Re-bless the golden:  UPDATE_GOLDEN=1 node --test api/tests/run-smoke.test.js
// (only in a commit that says why).

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { startMultiplayerServer } from '../multiplayer.js';
import { createApi } from '../../src/js/client/api.js';
import { canonicalJson, hash53 } from '../../src/js/shared/state-hash.js';
import { runHash as sharedRunHash } from '../../src/js/shared/run-state.js';
import { validateRunState } from '../../src/js/shared/run-state.js';
import { validateRunEventLog, isMutatingRunEvent } from '../../src/js/shared/run-events.js';
import { runScript, replayRunEvents, realRunAdapter } from '../../src/tests/helpers/run-driver.js';
import { stripProse } from '../runs/views.js';
import { tempRoot, tempDb, quiet } from './helpers/server.js';
import { runLog, runHash } from './helpers/runs.js';
import { until, untilSeq, lastSeq, sendOk } from './helpers/table.js';
import { foreignProse, proseLeaks, proseOf } from './helpers/prose.js';
import {
  RUN_SEED, RUN_SETTINGS, AMBUSH_FIGHTER_HP, openRunTable, tableClients, slotOf, marks, untilRun, fight, wireRunLog, runSnapshotHash
} from './helpers/run-table.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const GOLDEN = join(HERE, 'golden', 'run-smoke.run-events.json');
const UPDATE = process.env.UPDATE_GOLDEN === '1';
const BUDGET_MS = 8000;

const { root, cleanup } = tempRoot('cf-run-smoke-');
after(cleanup);

/** Check (or, with UPDATE_GOLDEN=1, write) the run-event-type golden. */
function checkGolden(types) {
  if (UPDATE) {
    mkdirSync(dirname(GOLDEN), { recursive: true });
    writeFileSync(GOLDEN, `${JSON.stringify({
      about: 'M65 S21 run smoke: the run event types of the 3-node campaign (goblin ambush → short rest → bugbear den with loot), run seed 20261025, players acting with melee turn.act, potion, level-up confirm, run end.',
      seed: RUN_SEED,
      types
    }, null, 2)}\n`);
    return;
  }
  assert.ok(existsSync(GOLDEN), 'no run-smoke golden; run UPDATE_GOLDEN=1 node --test api/tests/run-smoke.test.js and commit the reason');
  assert.deepEqual(types, JSON.parse(readFileSync(GOLDEN, 'utf8')).types, 'the run event sequence diverged from its golden');
}

/** The run's character projection both sides can produce: the snapshot's, and run-driver's replay of the log. */
const charProjection = (rows) => Object.fromEntries(rows.map(r => [r.slotId, { state: r.state, xp: r.xp, level: r.level, lifeStatus: r.lifeStatus }]));

/** Resolve once every client applied the run log through `seq` (each socket drains on its own). */
async function untilRunSeq(t, seq) {
  for (const c of tableClients(t)) await until(c, m => m.t === 'run.event' && m.p.seq >= seq, { since: 0 });
}

/** Boot the in-process real-engine server, run `fn(srv, sockets, clients)`, tear down. */
async function withServer(dbName, fn) {
  const { db } = await tempDb(root, dbName);
  const env = { NODE_ENV: 'test', CF_MULTIPLAYER: '1', CF_ENGINE: 'real' };
  const srv = await startMultiplayerServer({ db, env, port: 0, host: '127.0.0.1', log: quiet, gatewayOpts: { heartbeatMs: 60_000 } });
  const sockets = new Set();
  const clients = [];
  try {
    await fn(srv, sockets, clients);
  } finally {
    for (const c of clients) c.session.close();
    for (const ws of sockets) ws.terminate();
    await srv.close();
    srv.httpServer.closeAllConnections();
  }
}

/** Play the whole scripted run; returns the table and what each step acked. */
async function playRun(srv, sockets, clients) {
  const t = await openRunTable(srv.url, sockets);
  clients.push(...t.clients);
  const { dm } = t;
  const sam = t.players.sam.c;
  const pat = t.players.pat.c;
  // The room seq window all three clients share starts after the last connect.
  const from = Math.max(...tableClients(t).map(c => c.frames.find(f => f.t === 'room.snapshot').p.seq));
  const steps = {};

  // Node 1: the ambush, the fighter wounded in setup.
  steps.fight1 = await fight(t, { wound: true, registry: srv.registry });
  const samSlot = slotOf(t, 'sam');
  const patSlot = slotOf(t, 'pat');

  // Node 2: the short rest — the fighter spends a hit die, the DM grants.
  await sendOk(dm, 'dm.run.advance', { toNodeId: 'n-camp' });
  steps.spend = await sendOk(sam, 'rest.spend', { slotId: samSlot, hitDice: { Fighter: 1 } });
  let mk = marks(t);
  await sendOk(dm, 'dm.rest.grant', { type: 'short' });
  await untilRun(t, mk, { status: 'between', nodeId: 'n-camp', completed: true });

  // Node 3: the den; victory loot, XP across the level-6 threshold.
  await sendOk(dm, 'dm.run.advance', { toNodeId: 'n-den' });
  steps.fight2 = await fight(t, { registry: srv.registry });
  steps.offers = {
    sam: await until(sam, m => m.t === 'levelup.offer' && m.p.slotId === samSlot),
    pat: await until(pat, m => m.t === 'levelup.offer' && m.p.slotId === patSlot)
  };

  // Loot: the fighter claims the potion from the stash and drinks it.
  const potion = sam.session.runStore.getState().items.find(i => i.ownerSlotId === null && i.name === 'Potion of Healing');
  assert.ok(potion, 'the den\'s potion is in the party stash');
  steps.hpBeforePotion = dm.session.runStore.getState().characters.find(c => c.slotId === samSlot).state.hp.current;
  steps.claim = await sendOk(sam, 'loot.claim', { slotId: samSlot, itemId: potion.id });
  steps.use = await sendOk(sam, 'item.use', { slotId: samSlot, itemId: steps.claim.itemId });

  // Level-up: the fighter's ASI (+1 STR, +1 CON) through choose → confirm.
  const offer = steps.offers.sam.p;
  const choices = offer.choices?.asi ? { asi: { STR: 1, CON: 1 } } : {};
  steps.choose = await sendOk(sam, 'levelup.choose', { slotId: samSlot, levelUpId: offer.levelUpId, choices });
  steps.confirm = await sendOk(dm, 'dm.levelup.confirm', { levelUpId: offer.levelUpId });

  mk = marks(t);
  await sendOk(dm, 'dm.run.end', { outcome: 'victory' });
  await untilRun(t, mk, { status: 'ended' });

  const room = srv.registry.get(t.run.roomId);
  const runSeq = room.run.seq;
  await untilRunSeq(t, runSeq);
  // Every room broadcast is out too; then the DM resyncs for the final snapshot.
  for (const c of tableClients(t)) await untilSeq(c, room.seq);
  const resyncFrom = dm.frames.length;
  await sendOk(dm, 'resync');
  const final = await until(dm, m => m.t === 'run.snapshot', { since: resyncFrom });
  return { t, from, steps, samSlot, patSlot, room, runSeq, final };
}

test('S21 run smoke: DM + 2 players play fight → rest → fight with loot, a potion and a level-up over real sockets, under 8 s', async () => {
  const t0 = performance.now();
  await withServer('run-smoke.db', async (srv, sockets, clients) => {
    const { t, from, steps, samSlot, patSlot, room, runSeq, final } = await playRun(srv, sockets, clients);
    const { dm } = t;
    const sam = t.players.sam.c;
    const pat = t.players.pat.c;
    const all = tableClients(t);
    for (const c of all) assert.deepEqual(c.failures, [], `${c.name}: auto-answers failed`);
    assert.ok(t.acts.sam >= 1 && t.acts.pat >= 1, `both players acted with turn.act (${JSON.stringify(t.acts)})`);
    for (const c of all) assert.ok(!c.frames.some(f => f.t === 'turn.rejected'), `${c.name}: no turn.act was rejected`);

    // ---- the run log: identical on every client, equal to the server's wire copy
    const server = runLog(room.run.store, t.run.runId);
    assert.deepEqual(validateRunEventLog(server).errors, []);
    for (const ev of server) if (isMutatingRunEvent(ev.type)) assert.ok('before' in ev.payload && 'after' in ev.payload, ev.type);
    assert.equal(server.length, runSeq);
    assert.equal(server[0].type, 'run.started', 'run.started is emitted at POST /runs, before any socket connects');
    const wire = server.map(stripProse);
    const dmLog = wireRunLog(dm);
    assert.deepEqual(dmLog.map(e => e.seq), server.slice(1).map(e => e.seq), 'the DM holds every run event after run.started, gap-free');
    for (const c of [sam, pat]) assert.deepEqual(wireRunLog(c), dmLog, `${c.name} holds the DM's run.event stream (seq and payload)`);
    assert.deepEqual(dmLog, wire.slice(1), 'the clients\' run log is the server log as it goes on the wire');
    for (const c of all) assert.equal(c.session.runStore.getState().seq, runSeq, `${c.name}: run store applied through the last run seq`);
    for (const c of all) assert.ok(c.frames.find(f => f.t === 'run.snapshot').p.run.seq === 1, `${c.name}: its first run.snapshot covered run.started`);
    const types = server.map(e => e.type);
    checkGolden(types);

    // ---- the room seq stream: identical on all three
    const win = (c) => c.frames.filter(f => f.seq !== undefined && f.seq > from).map(f => [f.seq, f.t]);
    const dmWin = win(dm);
    assert.ok(dmWin.length > 20);
    dmWin.forEach(([seq], i) => assert.equal(seq, from + 1 + i, 'room seq is gap-free'));
    for (const c of [sam, pat]) assert.deepEqual(win(c), dmWin, `${c.name}: same room seq stream as the DM`);
    for (const c of all) assert.equal(lastSeq(c), room.seq);

    // ---- run hash: the driver's definition (hash53 of the canonical log)
    const hash = hash53(canonicalJson(server));
    assert.equal(hash, runHash(room.run.store, t.run.runId));
    assert.equal(hash53(canonicalJson([wire[0], ...dmLog])), hash53(canonicalJson(wire)), 'the DM\'s wire log hashes as the server\'s wire log');
    // W4: the hashes travel on run.snapshot / run.updated, so a client can check its log.
    assert.equal(final.p.runHash, hash, 'run.snapshot.runHash is the server\'s run hash');
    assert.equal(final.p.wireHash, sharedRunHash(wire), 'run.snapshot.wireHash is the hash of the wire log');
    for (const c of all) assert.equal(c.frames.filter(f => f.t === 'run.updated').at(-1).p.runHash, hash, `${c.name}: the last run.updated carries it`);

    // ---- the final run.snapshot equals run-driver's replay of the log
    const snap = final.p;
    assert.deepEqual([snap.run.status, snap.run.outcome, snap.run.seq], ['ended', 'victory', runSeq]);
    const replayed = replayRunEvents(server);
    const fromReplay = charProjection(Object.entries(replayed).map(([slotId, r]) => ({ slotId, ...r })));
    const fromSnap = charProjection(snap.characters);
    assert.deepStrictEqual(fromSnap, fromReplay, 'every character in the final snapshot is run-driver\'s replay of the log');
    assert.equal(runSnapshotHash(fromSnap), runSnapshotHash(fromReplay));
    assert.equal(runSnapshotHash(snap), runSnapshotHash(room.run.snapshotFor({ role: 'dm', id: room.dm.id })), 'the DM\'s snapshot is the server\'s DM view');
    assert.deepEqual(replayed[samSlot].pendingLevels, [], 'the fighter\'s level 6 was applied');
    assert.deepEqual(replayed[patSlot].pendingLevels, [6], 'the cleric\'s level 6 is still queued');

    // ---- the run RNG stream equals run-driver's on the same seed (where comparable:
    // the driver plays the fights with the AI, so only the RNG draws compare)
    const campaign = { v: 1, id: t.camp.campaignId, name: 'Smoke road', ruleset: 'srd-5.1', settings: { ...RUN_SETTINGS }, nodes: snap.nodes, templates: [] };
    const driven = await runScript({
      name: 'run-smoke', runId: t.run.runId, seed: RUN_SEED, campaign,
      party: [{ slotId: samSlot, seat: 1, fixture: 'fighter-l5' }, { slotId: patSlot, seat: 2, fixture: 'cleric-l5' }],
      steps: [
        { t: 'enter', nodeId: 'n-ambush' }, { t: 'fight', maxRounds: 15 }, { t: 'advance' },
        { t: 'rest', spend: { [samSlot]: { Fighter: 1 } } }, { t: 'advance' }, { t: 'fight', maxRounds: 15 }, { t: 'end', outcome: 'victory' }
      ]
    }, await realRunAdapter());
    assert.deepEqual(driven.encounters.map(e => e.seed), [steps.fight1.seed, steps.fight2.seed], 'each encounter seed is the driver\'s draw from the run RNG');
    const rest = server.find(e => e.type === 'rest.taken');
    // `healed` depends on the HP the fight left (the driver's AI fighter took none).
    const dice = (rolls) => Object.fromEntries(Object.entries(rolls).map(([s, list]) => [s, list.map(({ healed: _h, ...r }) => r)]));
    assert.deepEqual(dice(rest.payload.rolls), dice(driven.runEvents.find(e => e.type === 'rest.taken').payload.rolls), 'the hit-die rolls are the driver\'s');
    assert.equal(driven.runEvents[0].type, server[0].type);

    // ---- the story, step by step
    const r1 = server.find(e => e.type === 'encounter.result');
    assert.equal(r1.payload.outcome, 'party-victory');
    assert.ok(r1.payload.after[samSlot].state.hp.current <= AMBUSH_FIGHTER_HP, 'the wounded fighter came out of the ambush hurt');
    assert.equal(rest.payload.rolls[samSlot].length, 1, 'the fighter rolled one hit die');
    assert.ok(rest.payload.after[samSlot].hp.current > rest.payload.before[samSlot].hp.current, 'the hit die healed the fighter');
    assert.deepEqual(rest.payload.slotIds.sort(), [samSlot, patSlot].sort());
    const loot = server.find(e => e.type === 'loot.granted');
    assert.deepEqual(loot.payload.items.map(i => [i.name, i.qty]), [['Potion of Healing', 1]]);
    assert.deepEqual(loot.payload.currency, { gp: 50 });
    assert.equal(snap.run.stash.currency.gp, 50, 'the 50 gp sit in the party stash');
    const xp = server.filter(e => e.type === 'xp.awarded').at(-1);
    assert.deepEqual(xp.payload.perCharacter, { [samSlot]: 7500, [patSlot]: 7500 });
    assert.deepEqual(server.filter(e => e.type === 'level.queued').map(e => [e.payload.slotId, e.payload.toLevel]).sort(), [[samSlot, 6], [patSlot, 6]].sort());
    assert.ok(steps.use.healed >= 4 && steps.use.healed <= 10, `Potion of Healing healed ${steps.use.healed}`);
    const used = server.find(e => e.type === 'item.used');
    assert.equal(used.payload.before.state.hp.current, steps.hpBeforePotion, 'the fighter drank while hurt');
    assert.equal(used.payload.after.state.hp.current - used.payload.before.state.hp.current, steps.use.healed, 'the potion heal landed on the run state');
    assert.ok(!snap.items.some(i => i.id === steps.claim.itemId), 'the drunk potion is gone');
    assert.deepEqual([used.payload.itemId, used.payload.slotId, used.actorKind], [steps.claim.itemId, samSlot, 'player']);
    const applied = server.find(e => e.type === 'level.applied');
    assert.deepEqual([applied.payload.slotId, applied.payload.toLevel, applied.actorKind], [samSlot, 6, 'dm']);
    assert.equal(snap.characters.find(c => c.slotId === samSlot).level, 6);
    assert.equal(snap.levelUps.find(l => l.slotId === patSlot).status, 'pending_player');

    // ---- levelup.offer is private: each seat's own, plus the DM
    assert.ok(!sam.frames.some(f => f.t === 'levelup.offer' && f.p.slotId !== samSlot), 'Sam sees only his offer');
    assert.ok(!pat.frames.some(f => f.t === 'levelup.offer' && f.p.slotId !== patSlot), 'Pat sees only hers');
    assert.ok(dm.frames.some(f => f.t === 'levelup.offer' && f.p.slotId === samSlot) && dm.frames.some(f => f.t === 'levelup.offer' && f.p.slotId === patSlot));

    // ---- state_json validates against each run sheet (the DM's full copy)
    const dmApi = createApi({ fetch: globalThis.fetch, base: srv.url, token: () => t.run.dmToken });
    const sheets = {};
    for (const c of snap.characters) {
      const { sheet } = await dmApi.getSeatSheet(t.run.roomId, c.slotId);
      sheets[c.slotId] = sheet;
      assert.deepEqual(validateRunState(c.state, { sheet }).errors, [], `${c.slotId} state_json`);
    }
    assert.equal(sheets[samSlot].level, 6, 'the fighter\'s run sheet is level 6');

    // ---- no prose from another seat reaches a player (every ws frame)
    const forbidden = { sam: foreignProse(sheets[samSlot], sheets[patSlot]), pat: foreignProse(sheets[patSlot], sheets[samSlot]) };
    assert.ok(forbidden.sam.length > 0 && forbidden.pat.length > 0, 'the two sheets carry distinct prose');
    for (const [name, c] of [['sam', sam], ['pat', pat]]) {
      assert.ok(c.frames.length > 100, `${name} received the run (${c.frames.length} frames)`);
      assert.deepEqual(proseLeaks(c.frames, forbidden[name]), [], `${name} received another seat's prose`);
    }
    assert.ok(proseOf(sheets[samSlot]).size > 0);

    const ms = performance.now() - t0;
    assert.ok(ms < BUDGET_MS, `run smoke took ${ms.toFixed(0)} ms`);
    if (process.env.SMOKE_TIMING) console.log(`run smoke: ${ms.toFixed(0)} ms, ${server.length} run events, acts ${JSON.stringify(t.acts)}`);
  });
});

// ------------------------------------------------- S23 licensing audit

test('S23 licensing: after a full run no member route serves a player another seat\'s prose; the export carries none; SRD attribution is on /api/licenses, the export and play.js', async () => {
  await withServer('run-licensing.db', async (srv, sockets, clients) => {
    const { t, samSlot, patSlot } = await playRun(srv, sockets, clients);
    const roomId = t.run.roomId;
    const dmApi = createApi({ fetch: globalThis.fetch, base: srv.url, token: () => t.run.dmToken });
    const sheets = {
      sam: (await dmApi.getSeatSheet(roomId, samSlot)).sheet,
      pat: (await dmApi.getSeatSheet(roomId, patSlot)).sheet
    };
    const get = async (path, token) => {
      const res = await fetch(`${srv.url}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
      return { path, status: res.status, body: await res.json() };
    };
    const ATTRIBUTION = 'This work includes material taken from the System Reference Document 5.1 ("SRD 5.1") by Wizards of the Coast LLC';
    for (const [me, other, mySlot, otherSlot] of [['sam', 'pat', samSlot, patSlot], ['pat', 'sam', patSlot, samSlot]]) {
      const { token } = t.players[me].join;
      const otherChar = encodeURIComponent(t.players[other].characterId);
      const bodies = [];
      // Every GET route a seated player can call in a run room.
      for (const path of [
        `/api/rooms/${roomId}`, `/api/rooms/${roomId}/run`, `/api/rooms/${roomId}/seats/${otherSlot}/sheet`,
        `/api/characters?room=${roomId}`, `/api/characters/${otherChar}`, `/api/rooms/${roomId}/maps`, '/api/licenses',
        `/api/runs/${t.run.runId}/events`, `/api/runs/${t.run.runId}/snapshots`   // W4
      ]) {
        const r = await get(path, token);
        assert.equal(r.status, 200, `${me} GET ${path}`);
        bodies.push(r);
      }
      const leaks = proseLeaks(bodies.map(b => b.body), foreignProse(sheets[me], sheets[other]), (_b, i) => bodies[i].path);
      assert.deepEqual(leaks, [], `${me} received ${other}'s prose over HTTP`);
      assert.equal(bodies[2].body.prose, 'stripped', 'another seat\'s run sheet is the public copy');
      assert.equal(bodies[4].body.prose, 'stripped', 'another seat\'s imported character is the public copy');
      // The own seat's run sheet is the full one (the scan is not vacuous).
      const own = await get(`/api/rooms/${roomId}/seats/${mySlot}/sheet`, token);
      assert.equal(own.body.prose, undefined);
      assert.ok([...proseOf(sheets[me])].some(p => JSON.stringify(own.body).includes(p)), `${me}'s own sheet keeps its prose`);
      // Without a token the character route is closed under CF_MULTIPLAYER=1.
      assert.equal((await get(`/api/characters/${otherChar}`, null)).status, 401);
    }

    const lic = await get('/api/licenses', null);
    assert.deepEqual([lic.body.srd.license, lic.body.srd.name], ['CC-BY-4.0', 'System Reference Document 5.1']);
    assert.ok(lic.body.srd.attribution.startsWith(ATTRIBUTION));
    assert.ok(lic.body.srd.attribution.includes('https://creativecommons.org/licenses/by/4.0/legalcode'));
    const exp = await createApi({ fetch: globalThis.fetch, base: srv.url }).exportCampaign(t.camp.campaignId, t.camp.campaignKey);
    assert.equal(exp.attribution, lic.body.srd.attribution, 'the export carries the SRD attribution');
    const anyProse = [...proseOf(sheets.sam), ...proseOf(sheets.pat)];
    assert.deepEqual(proseLeaks([exp], anyProse), [], 'no sheet prose in a campaign export');
    const play = readFileSync(join(HERE, '..', '..', 'src', 'js', 'play.js'), 'utf8');
    assert.ok(play.includes(ATTRIBUTION), 'play.js renders the SRD attribution (footer + About)');
  });
});
