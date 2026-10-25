// Multiplayer server wiring (M64 Wave 3): the HTTP app, the room service,
// the live room registry and the ws gateway on ONE http.Server.
// `server.js` uses this when CF_MULTIPLAYER=1; tests boot it on port 0.

import { createApp } from './app.js';
import { startServer } from './start.js';
import { createRoomService } from './rooms/service.js';
import { createRoomRegistry } from './rooms/registry.js';
import { createStubEngine } from './rooms/engine-port.js';
import { createRealEngine, sheetForSeat } from './rooms/real-engine.js';
import { createSqliteJournal } from './rooms/persistence.js';
import { attachGateway } from './ws/gateway.js';
import { createJanitor } from './lib/janitor.js';
import { createRunStore } from './runs/store.js';
import { mountRunRoutes } from './runs/http.js';
import { createCampaignStore } from './campaigns/store.js';
import { setupForRoom } from './campaigns/setup.js';
import { dirname, resolve } from 'node:path';

/**
 * @param {object} o
 * @param {import('./db/database.js').DbHandle} o.db
 * @param {Record<string, string|undefined>} [o.env=process.env]
 * @param {string} [o.dataDir]
 * @param {number} [o.port=0]
 * @param {string} [o.host]
 * @param {(level: string, msg: string, extra?: object) => void} [o.log]
 * @param {import('./rooms/engine-port.js').EnginePort} [o.engine]  default: `createEngine(env.CF_ENGINE)` (the real engine)
 * @param {object} [o.journal]   default: the SQLite journal over `db` (persistence.js)
 * @param {object} [o.appOpts]   extra createApp options (limits, fetchImpl, ...)
 * @param {object} [o.gatewayOpts]  heartbeatMs, helloTimeoutMs, rate, ...
 * @param {object} [o.serverOpts]   handleSignals, exit, drainTimeoutMs
 * @param {object} [o.roomOpts]     now / setTimer / clearTimer for rooms
 * @param {object|false} [o.janitorOpts]  createJanitor overrides, or false to disable
 */
export async function startMultiplayerServer({
  db, env = process.env, dataDir, port = 0, host, log = defaultLog,
  engine, journal, appOpts = {}, gatewayOpts = {}, serverOpts = {}, roomOpts = {}, janitorOpts = {}
}) {
  const service = createRoomService({ db });
  engine ||= createEngine({ kind: env.CF_ENGINE, db, store: service.store, log });
  const jr = journal || createSqliteJournal({ db: db.db, log });
  // M65 runs need schema 0006 (a DB opened without migrating has none).
  const hasRuns = !!db.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'runs'").get();
  let app = null;
  const runs = hasRuns ? {
    store: createRunStore(db.db),
    // Campaign assets a template names become this room's uploads (B22's setupForRoom).
    materializeSetup: (setup, { campaignId, roomId }) => {
      const assets = app?.locals?.campaigns?.assets;
      if (!assets || !campaignId) throw new Error('campaign assets are unavailable');
      return setupForRoom(setup, { campaignId, roomId, assets });
    }
  } : null;
  const registry = createRoomRegistry({ service, engine, journal: jr, log, runs, ...roomOpts });
  // Boot recovery: every room with a setup/active encounter comes back
  // (active ones paused, resuming on the DM's dm.resume).
  const recovered = registry.recover();
  if (recovered) log('info', 'rooms recovered', { rooms: recovered });
  let gateway = null;
  const userMount = appOpts.mount;
  app = createApp({
    db, env, dataDir, log, rooms: service, ...appOpts,
    mount: (a, ctx) => {
      if (runs) mountRunRoutes(a, { registry, rooms: service, campaigns: a.locals.campaigns?.store ?? createCampaignStore(db.db), log });
      userMount?.(a, ctx);
    }
  });
  // sockets: authenticated room members online; connections: every open
  // ws, including ones that have not said hello yet.
  app.locals.health = () => ({ sockets: registry.socketCount(), connections: gateway ? gateway.connections() : 0, rooms: registry.size });
  const janitor = janitorOpts === false ? null
    : createJanitor({ db, dataDir: dataDir ?? (db.path && db.path !== ':memory:' ? dirname(resolve(db.path)) : null), registry, log, ...janitorOpts });
  janitor?.start();
  const srv = await startServer({
    db, env, dataDir, port, host, log, app, ...serverOpts,
    // Graceful shutdown v2 (B9, P0-12), in plan order: rooms stop taking
    // intents and persist what is buffered (every turn end and DM edit is
    // already snapshotted; an in-flight turn re-runs on boot), broadcast
    // room.closing and close sockets 1012; the gateway waits briefly for
    // the close handshakes and terminates stragglers; then start.js runs
    // server.close and closes the DB (WAL checkpoint).
    onClose: async () => {
      janitor?.stop();
      registry.shutdown();
      if (gateway) await gateway.close();
    }
  });
  gateway = attachGateway({ httpServer: srv.httpServer, registry, service, env, log, ...gatewayOpts });
  return { ...srv, service, registry, gateway, engine, journal: jr, janitor };
}

/**
 * The engine port a server runs: the real engine (default) or, with
 * `CF_ENGINE=stub`, the Wave 3 stub (tests, tooling). The real engine
 * resolves PC sheets for encounters it did not build in this process
 * (boot recovery, cache eviction) from the encounter row's `sheets_json`
 * (migration 0003). Only an encounter built before 0003 falls back to the
 * room's seats, then the character cache (logged). Open5e stat blocks
 * come from the monster cache.
 * @param {object} o
 * @param {string|undefined} o.kind  'stub' | 'real' | undefined
 * @param {import('./db/database.js').DbHandle} o.db
 * @param {object} o.store  room store (listSeats)
 * @param {(level: string, msg: string, extra?: object) => void} [o.log]
 * @returns {import('./rooms/engine-port.js').EnginePort}
 */
export function createEngine({ kind, db, store, log = () => {} }) {
  if (kind === 'stub') return createStubEngine();
  if (kind && kind !== 'real') throw new Error(`CF_ENGINE must be "real" or "stub", got "${kind}"`);
  const roomOf = db.db.prepare('SELECT room_id, sheets_json FROM encounters WHERE id = ?');
  return createRealEngine({
    log,
    resolveSheets(state) {
      const row = roomOf.get(state.encounterId);
      if (row?.sheets_json) return JSON.parse(row.sheets_json);
      log('warn', 'engine: encounter has no stored sheets (pre-0003); resolving from seats / character cache', { encounterId: state.encounterId });
      const out = {};
      const seats = row ? store.listSeats(row.room_id) : [];
      for (const e of Object.values(state.entities)) {
        if (e.kind !== 'pc') continue;
        const cid = e.sheetRef.characterId;
        const seat = seats.find(s => s.id === e.controller.seatId && s.seed && String(s.seed.id) === cid)
          || seats.find(s => s.seed && String(s.seed.id) === cid);
        const sheet = seat ? sheetForSeat(seat) : (db.getCharacterByDdbId(cid)?.parsed ?? null);
        if (sheet) out[cid] = sheet;
      }
      return out;
    },
    monsterLookup(slug) {
      try { return db.getMonsterBySlug(slug)?.payload ?? null; } catch { return null; }
    }
  });
}

function defaultLog(level, msg, extra = {}) {
  const line = JSON.stringify({ level, msg, ...extra });
  if (level === 'error') console.error(line); else console.log(line);
}
