// Multiplayer server wiring (M64 Wave 3): the HTTP app, the room service,
// the live room registry and the ws gateway on ONE http.Server.
// `server.js` uses this when CF_MULTIPLAYER=1; tests boot it on port 0.

import { createApp } from './app.js';
import { startServer } from './start.js';
import { createRoomService } from './rooms/service.js';
import { createRoomRegistry } from './rooms/registry.js';
import { createStubEngine } from './rooms/engine-port.js';
import { createSqliteJournal } from './rooms/persistence.js';
import { attachGateway } from './ws/gateway.js';

/**
 * @param {object} o
 * @param {import('./db/database.js').DbHandle} o.db
 * @param {Record<string, string|undefined>} [o.env=process.env]
 * @param {string} [o.dataDir]
 * @param {number} [o.port=0]
 * @param {string} [o.host]
 * @param {(level: string, msg: string, extra?: object) => void} [o.log]
 * @param {import('./rooms/engine-port.js').EnginePort} [o.engine]  default: the Wave 3 stub
 * @param {object} [o.journal]   default: the SQLite journal over `db` (persistence.js)
 * @param {object} [o.appOpts]   extra createApp options (limits, fetchImpl, ...)
 * @param {object} [o.gatewayOpts]  heartbeatMs, helloTimeoutMs, rate, ...
 * @param {object} [o.serverOpts]   handleSignals, exit, drainTimeoutMs
 * @param {object} [o.roomOpts]     now / setTimer / clearTimer for rooms
 */
export async function startMultiplayerServer({
  db, env = process.env, dataDir, port = 0, host, log = defaultLog,
  engine = createStubEngine(), journal, appOpts = {}, gatewayOpts = {}, serverOpts = {}, roomOpts = {}
}) {
  const service = createRoomService({ db });
  const jr = journal || createSqliteJournal({ db: db.db, log });
  const registry = createRoomRegistry({ service, engine, journal: jr, log, ...roomOpts });
  // Boot recovery: every room with a setup/active encounter comes back
  // (active ones paused, resuming on the DM's dm.resume).
  const recovered = registry.recover();
  if (recovered) log('info', 'rooms recovered', { rooms: recovered });
  const app = createApp({ db, env, dataDir, log, rooms: service, ...appOpts });
  app.locals.health = () => ({ sockets: registry.socketCount(), rooms: registry.size });
  let gateway = null;
  const srv = await startServer({
    db, env, dataDir, port, host, log, app, ...serverOpts,
    onClose: async () => {
      registry.shutdown();
      if (gateway) await gateway.close();
    }
  });
  gateway = attachGateway({ httpServer: srv.httpServer, registry, service, env, log, ...gatewayOpts });
  return { ...srv, service, registry, gateway, engine, journal: jr };
}

function defaultLog(level, msg, extra = {}) {
  const line = JSON.stringify({ level, msg, ...extra });
  if (level === 'error') console.error(line); else console.log(line);
}
