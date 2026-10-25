// The M65 run table over real sockets (S21 run-smoke, S22 run-restart):
// a DM authors a 3-node campaign over HTTP (goblin fight → short rest →
// bugbear fight with loot), starts a run (POST /api/campaigns/:cid/runs,
// lobby mode: the server creates the room), two players join by code,
// import the fighter and cleric fixtures by JSON paste and claim seats 1
// and 2. Players answer their own turns with a real `turn.act` (melee at
// the first living hostile, by id); every cinema and reaction prompt is
// auto-answered (helpers/table.js).

import assert from 'node:assert/strict';

import { createApi } from '../../../src/js/client/api.js';
import { canonicalJson, hash53 } from '../../../src/js/shared/state-hash.js';
import { ddbFixture } from './server.js';
import { trackedWebSocket, tableClient, until, sendOk } from './table.js';

/** The run RNG seed (POST /runs {seed}). */
export const RUN_SEED = 20261025;

/** Campaign settings: XP mode, choose-mode level-ups (the owner defaults, spelled out). */
export const RUN_SETTINGS = Object.freeze({ xpMode: 'xp', hpOnLevel: 'average', deathMode: 'standard', levelUpMode: 'choose', dawnIsLongRest: true, xpAward: 'auto' });

/**
 * The 3-node chain. Both fixtures are level 5 (6,500 XP); node 3's
 * `xpOverride` (15,000 split over two) carries each past 14,000, so the
 * second fight queues level 6 for both seats.
 */
export const RUN_NODES = Object.freeze([
  {
    id: 'n-ambush', kind: 'encounter', title: 'Goblin ambush', start: true,
    payload: {
      setup: {
        map: null, grid: { cols: 8, rows: 6 },
        monsters: [{ slug: 'goblin', id: 'gob-1' }, { slug: 'goblin', id: 'gob-2' }],
        placements: { 'gob-1': { col: 3, row: 2 }, 'gob-2': { col: 3, row: 3 } }
      },
      partyPlacement: { 1: { col: 1, row: 2 }, 2: { col: 2, row: 3 } }
    },
    next: [{ to: 'n-camp' }]
  },
  { id: 'n-camp', kind: 'rest', title: 'Catch your breath', payload: { type: 'short' }, next: [{ to: 'n-den' }] },
  {
    id: 'n-den', kind: 'encounter', title: 'The bugbear\'s den',
    payload: {
      setup: { map: null, grid: { cols: 8, rows: 6 }, monsters: [{ slug: 'bugbear', id: 'bug-1' }], placements: { 'bug-1': { col: 3, row: 3 } } },
      partyPlacement: { 1: { col: 1, row: 2 }, 2: { col: 2, row: 3 } },
      xpOverride: 15000,
      loot: { items: [{ origin: 'dm', name: 'Potion of Healing', qty: 1 }], currency: { gp: 50 } }
    },
    next: []
  }
]);

/** Seat order: seat 1 = Sam's fighter, seat 2 = Pat's cleric. */
export const RUN_PARTY = Object.freeze([
  { name: 'sam', fixture: 'fighter-l5', className: 'Fighter' },
  { name: 'pat', fixture: 'cleric-l5', className: 'Cleric' }
]);

/** The DM wounds the fighter before the ambush (dm.entity.patch in setup), so hit dice and the potion heal something. */
export const AMBUSH_FIGHTER_HP = 20;

/** hash53 of a run.snapshot payload (the run hash S22 compares across a restart). */
export const runSnapshotHash = (p) => hash53(canonicalJson(p));

/**
 * The run.event frames a client received, as catalogue v1 events, by run seq.
 * @param {object} c  table client
 */
export const wireRunLog = (c) => c.frames.filter(f => f.t === 'run.event').map(f => f.p);

/**
 * Attach a table client whose player answers its own turns with turn.act.
 * `t.hold(msg, c)` true leaves that turn waiting (recorded in c.heldTurns).
 */
function seatClient(t, name, token) {
  const c = tableClient(name, t.wsUrl, token, t.WS, {
    onMessage: (msg, cl) => {
      if (msg.t !== 'turn.started' || msg.seq === undefined) return;
      if (msg.p.payload.actorId !== t.actorOf[name]) return;
      if (t.hold?.(msg, cl)) { cl.heldTurns.push(msg); return; }
      const enc = cl.session.store.getState().encounter;
      const target = Object.values(enc?.entities || {}).filter(e => e.side === 'hostile' && e.hp > 0).sort((a, b) => a.id.localeCompare(b.id))[0];
      if (!target) return;
      t.acts[name] += 1;
      cl.answer({ t: 'turn.act', p: { turnId: msg.p.turnId, plan: { kind: 'melee', targetId: target.id } } });
    }
  });
  c.heldTurns = [];
  return c;
}

/**
 * Author the campaign, start the run, connect DM + two players, claim seats.
 * @param {string} base  http origin
 * @param {Set} sockets  every client socket, for teardown
 * @returns {Promise<object>} the table `t`
 */
export async function openRunTable(base, sockets) {
  const t = {
    base, sockets, WS: trackedWebSocket(sockets), wsUrl: `${base.replace(/^http/, 'ws')}/ws`,
    anon: createApi({ fetch: globalThis.fetch, base }), players: {}, actorOf: {}, acts: { sam: 0, pat: 0 }, clients: [], hold: null
  };
  t.camp = await t.anon.createCampaign('Smoke road', { ...RUN_SETTINGS });
  const graph = await t.anon.putGraph(t.camp.campaignId, t.camp.campaignKey, RUN_NODES);
  assert.equal(graph.validation.ok, true, 'the authored graph validates');
  t.run = await t.anon.startRun(t.camp.campaignId, t.camp.campaignKey, { seed: RUN_SEED });
  assert.equal(t.run.status, 'lobby', 'with no X-Room-Token the run waits in a fresh room\'s lobby');

  t.dm = tableClient('dm', t.wsUrl, t.run.dmToken, t.WS);
  t.clients.push(t.dm);
  await t.dm.session.connect();
  await until(t.dm, m => m.t === 'run.snapshot');
  for (const { name, fixture } of RUN_PARTY) {
    const join = await t.anon.joinRoom(t.run.code, name);
    const api = createApi({ fetch: globalThis.fetch, base, token: () => join.token });
    const imp = await api.importCharacter(t.run.roomId, { json: ddbFixture(fixture) });
    const c = seatClient(t, name, join.token);
    t.clients.push(c);
    await c.session.connect();
    await until(c, m => m.t === 'run.snapshot');
    const claim = await sendOk(c, 'seat.claim', { characterId: imp.character.id });
    t.actorOf[name] = `pc-${claim.seat}`;
    t.players[name] = { name, c, join, api, seat: claim.seat, characterId: imp.character.id };
  }
  return t;
}

/**
 * Reconnect the whole table (same tokens) to `base` — after a restart.
 * The old sessions must be closed already. Resolves once every client
 * holds its room.snapshot and run.snapshot.
 */
export async function reconnectTable(t, base) {
  t.base = base;
  t.wsUrl = `${base.replace(/^http/, 'ws')}/ws`;
  t.dm = tableClient('dm', t.wsUrl, t.run.dmToken, t.WS);
  t.clients.push(t.dm);
  await t.dm.session.connect();
  for (const { name } of RUN_PARTY) {
    const c = seatClient(t, name, t.players[name].join.token);
    t.clients.push(c);
    t.players[name].c = c;
    await c.session.connect();
  }
  for (const c of tableClients(t)) {
    await until(c, m => m.t === 'room.snapshot');
    await until(c, m => m.t === 'run.snapshot');
  }
  return t;
}

/** Every table client: DM first, then the players in seat order. */
export const tableClients = (t) => [t.dm, ...RUN_PARTY.map(p => t.players[p.name].c)];

/** The seat's run slot id (from the DM's run store). */
export function slotOf(t, name) {
  const seat = t.players[name].seat;
  const c = t.dm.session.runStore.getState().characters.find(x => x.seat === seat);
  assert.ok(c, `${name} has a run character`);
  return c.slotId;
}

/** Marks (frame counts) for every client, for "since" waits. */
export const marks = (t) => new Map(tableClients(t).map(c => [c, c.frames.length]));

/** Resolve once every client saw `run.updated` reach `status` (and, optionally, the node completed). */
export async function untilRun(t, mk, { status, nodeId = null, completed = null, timeoutMs = 10_000 }) {
  for (const c of tableClients(t)) {
    await until(c, m => m.t === 'run.updated' && m.p.status === status
      && (nodeId === null || m.p.currentNodeId === nodeId) && (completed === null || m.p.completed === completed),
    { since: mk.get(c), timeoutMs });
  }
}

/**
 * Begin and start the current encounter node. With `wound`, the DM sets
 * the fighter's HP in setup first. Returns the begin ack and the
 * encounter's seed (in-process only: read from the live Room).
 */
export async function beginFight(t, { wound = false, registry = null } = {}) {
  const begun = await sendOk(t.dm, 'dm.node.begin', {});
  const seed = registry ? registry.get(t.run.roomId).enc.state.rng.s : null;
  if (wound) await sendOk(t.dm, 'dm.entity.patch', { entityId: t.actorOf.sam, hp: AMBUSH_FIGHTER_HP });
  await sendOk(t.dm, 'dm.encounter.start', {});
  return { begun, seed };
}

/** Play the current encounter node to its end: every client sees the run go between with the node completed. */
export async function fight(t, opts = {}) {
  const mk = marks(t);
  const out = await beginFight(t, opts);
  await untilRun(t, mk, { status: 'between', nodeId: out.begun.currentNodeId, completed: true });
  return out;
}
