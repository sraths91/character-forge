// M65 C24–C27 — a campaign run table for the between-node view tests,
// against the REAL server in-process (rooms + ws gateway + SQLite + the
// real engine + E3's run controller), driven by the browser client
// modules (createApi / createSession over a real `ws` socket):
//
//   DM creates a room, a player joins and pastes a cleric (seat 1), the DM
//   seats an AI fighter (seat 2), authors a campaign (createCampaign +
//   putGraph) and starts the run in that room (POST /api/campaigns/:cid/runs
//   with X-Room-Token), which enters the start node with the seated party.
//
// `table.ctx(who)` is the view ctx play.js would build ({store, runStore,
// send, api, room}); `until(cond)` polls; `close()` tears everything down.

import WebSocket from 'ws';
import { startMultiplayerServer } from '../../../api/multiplayer.js';
import { tempDb, quiet } from '../../../api/tests/helpers/server.js';
import { createApi } from '../../js/client/api.js';
import { createSession } from '../../js/client/session.js';
import { loadDdbFixture } from './entities.js';

/** A Saris-like Life cleric at level 4 (raw DDB JSON; the cleric fixture one level down). */
export function cleric4Raw() {
  const raw = loadDdbFixture('cleric-l5');
  raw.classes[0].level = 4;
  raw.classes[0].hitDiceUsed = 3;
  raw.baseHitPoints -= 5;
  return raw;
}

/** SRD cache rows the tests need (no network): potion, lantern, chain mail, two spells. */
export const SRD_ROWS = Object.freeze([
  { key: 'srd_potion-of-healing', kind: 'magicitem', name: 'Potion of Healing', payload: { key: 'srd_potion-of-healing', name: 'Potion of Healing', cost: '50.00', category: { key: 'potion' }, document: { key: 'srd-2014' } } },
  { key: 'srd_lantern', kind: 'item', name: 'Lantern', payload: { key: 'srd_lantern', name: 'Lantern', cost: '0.00', document: { key: 'srd-2014' } } },
  { key: 'srd_command', kind: 'spell', name: 'Command', payload: { key: 'srd_command', name: 'Command', level: 1, school: { name: 'Enchantment' } } },
  { key: 'srd_sanctuary', kind: 'spell', name: 'Sanctuary', payload: { key: 'srd_sanctuary', name: 'Sanctuary', level: 1, school: { name: 'Abjuration' } } }
]);

/** A preset-goblin encounter setup (resolves without the monster cache). */
export const GOBLIN_SETUP = Object.freeze({
  map: null, grid: { cols: 8, rows: 6 },
  monsters: [{ id: 'gob', preset: 'goblin', name: 'Goblin', hp: 7 }],
  placements: { gob: { col: 6, row: 2 } }
});

/** Poll until `cond()` is truthy. */
export async function until(cond, label = 'condition', ms = 8000) {
  const t0 = Date.now();
  for (;;) {
    const v = cond();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${label}`);
    await new Promise(r => setTimeout(r, 3));
  }
}

/**
 * Boot the server, seat the party, start the run.
 * @param {string} root  temp root
 * @param {{nodes: object[], settings?: object, seed?: number, clericRaw?: object}} o
 */
export async function bootRunTable(root, { nodes, settings = { xpMode: 'xp', levelUpMode: 'choose' }, seed = 7, clericRaw = cleric4Raw() }) {
  const { db } = await tempDb(root, 'run-table.db');
  const ins = db.db.prepare('INSERT INTO items_cache (key, document_key, kind, name, payload_json, fetched_at) VALUES (?, \'srd-2014\', ?, ?, ?, 1)');
  for (const r of SRD_ROWS) ins.run(r.key, r.kind, r.name, JSON.stringify(r.payload));
  const env = { NODE_ENV: 'test', CF_MULTIPLAYER: '1', CF_ENGINE: 'real' };
  const srv = await startMultiplayerServer({ db, env, port: 0, host: '127.0.0.1', log: quiet, gatewayOpts: { heartbeatMs: 60_000 }, janitorOpts: false });
  const sockets = new Set();
  const WS = class extends WebSocket { constructor(url) { super(url); sockets.add(this); } };
  const wsUrl = `${srv.url.replace(/^http/, 'ws')}/ws`;
  const anon = createApi({ fetch: globalThis.fetch, base: srv.url });
  const room = await anon.createRoom('Run table');
  const join = await anon.joinRoom(room.code, 'Pat');
  const apis = {
    dm: createApi({ fetch: globalThis.fetch, base: srv.url, token: () => room.dmToken }),
    player: createApi({ fetch: globalThis.fetch, base: srv.url, token: () => join.token })
  };
  const sessions = {};
  const quietWs = { logger: { warn: () => {} } };
  sessions.dm = createSession({ url: wsUrl, token: room.dmToken, WebSocketCtor: WS, wsOptions: quietWs });
  sessions.player = createSession({ url: wsUrl, token: join.token, WebSocketCtor: WS, wsOptions: quietWs });
  const close = async () => {
    for (const s of Object.values(sessions)) s.close();
    for (const ws of sockets) ws.terminate();
    await srv.close();
    srv.httpServer.closeAllConnections();
  };
  try {
    await sessions.dm.connect();
    await sessions.player.connect();
    const cleric = await apis.player.importCharacter(room.roomId, { json: clericRaw });
    await sessions.player.send({ t: 'seat.claim', p: { characterId: cleric.character.id } });
    const fighter = await apis.dm.importCharacter(room.roomId, { json: loadDdbFixture('fighter-l5') });
    await apis.dm.aiSeat(room.roomId, 2, fighter.character.id, 'auto');
    const camp = await anon.createCampaign('Between nodes', settings);
    await anon.putGraph(camp.campaignId, camp.campaignKey, nodes);
    const run = await anon.startRun(camp.campaignId, camp.campaignKey, { roomToken: room.dmToken, seed });
    for (const who of ['dm', 'player']) await until(() => sessions[who].runStore.getState().synced && sessions[who].runStore.getState().currentNodeId, `${who} run snapshot`);
    const ctx = (who) => ({
      store: sessions[who].store,
      runStore: sessions[who].runStore,
      send: (intent) => sessions[who].send(intent),
      session: sessions[who],
      api: apis[who],
      room: { roomId: room.roomId, code: room.code, role: who === 'dm' ? 'dm' : 'player' },
      deps: {}
    });
    return {
      srv, db, room, join, apis, sessions, run, camp, cleric, fighter, ctx, close,
      /** The server's run.snapshot for `who` (GET /api/rooms/:id/run). */
      serverSnapshot: (who) => apis[who] && fetch(`${srv.url}/api/rooms/${room.roomId}/run`, { headers: { authorization: `Bearer ${who === 'dm' ? room.dmToken : join.token}` } }).then(r => r.json()),
      /** The live Room (server side). */
      liveRoom: () => srv.registry.get(room.roomId)
    };
  } catch (err) {
    await close();
    throw err;
  }
}
