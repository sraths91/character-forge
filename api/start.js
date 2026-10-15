import { createServer } from 'node:http';
import { createApp } from './app.js';

/** Railway's drainingSeconds is 30; leave a 10 s margin before SIGKILL. */
export const DEFAULT_DRAIN_TIMEOUT_MS = 20_000;

/** Default structured logger: one JSON line per event. */
function defaultLog(level, msg, extra = {}) {
  const line = JSON.stringify({ level, msg, ...extra });
  if (level === 'error') console.error(line); else console.log(line);
}

/**
 * @typedef {object} RunningServer
 * @property {string} url                       e.g. `http://127.0.0.1:54321`
 * @property {number} port                      The bound port (useful with port 0).
 * @property {import('node:http').Server} httpServer  Attach ws `upgrade` handlers here.
 * @property {import('express').Express} app
 * @property {() => Promise<void>} close        Idempotent: onClose hook → stop
 *   accepting and drain HTTP → checkpoint + close the DB.
 */

/**
 * Create the HTTP server around the Express app and listen.
 *
 * Uses an explicit `http.createServer(app)` (not `app.listen`) so the
 * Wave 3 ws gateway can attach to `httpServer` with `noServer` upgrades.
 *
 * With `handleSignals: true` (the production entry point), SIGTERM/SIGINT
 * trigger `close()` then `exit(0)`, with a hard `exit(1)` after
 * `drainTimeoutMs` if something refuses to close. Tests leave it off, or
 * inject `exit`, so nothing touches the real process.
 *
 * @param {object} opts
 * @param {import('./db/database.js').DbHandle} opts.db  Handle from `openDb`; closed by `close()`.
 * @param {number} [opts.port=0]         0 picks a free port.
 * @param {string} [opts.host]           Bind address; default all interfaces.
 * @param {Record<string, string|undefined>} [opts.env=process.env]
 * @param {string} [opts.dataDir]        Passed through to createApp.
 * @param {import('express').Express} [opts.app]  Pre-built app (default: createApp({db, env, dataDir, log})).
 * @param {() => (void|Promise<void>)} [opts.onClose]  Runs first in `close()`
 *   (Wave 3: snapshot rooms, close sockets with 1012) — before `server.close()`,
 *   because open WebSockets stop it from completing.
 * @param {boolean} [opts.handleSignals=false]
 * @param {number} [opts.drainTimeoutMs=DEFAULT_DRAIN_TIMEOUT_MS]
 * @param {(code: number) => void} [opts.exit=process.exit]
 * @param {(level: string, msg: string, extra?: object) => void} [opts.log]
 * @returns {Promise<RunningServer>}
 */
export async function startServer({
  db,
  port = 0,
  host,
  env = process.env,
  dataDir,
  app,
  onClose,
  handleSignals = false,
  drainTimeoutMs = DEFAULT_DRAIN_TIMEOUT_MS,
  exit = (code) => process.exit(code),
  log = defaultLog
} = {}) {
  if (!db) throw new Error('startServer: db handle (from openDb) is required');
  const expressApp = app || createApp({ db, env, dataDir, log });
  const httpServer = createServer(expressApp);

  await new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, host, () => {
      httpServer.off('error', reject);
      resolve();
    });
  });

  const bound = httpServer.address();
  const urlHost = host && host !== '::' && host !== '0.0.0.0'
    ? (host.includes(':') ? `[${host}]` : host)
    : 'localhost';
  const url = `http://${urlHost}:${bound.port}`;
  log('info', 'character-forge API listening', { url, port: bound.port });

  let closing = null;
  const signalHandlers = new Map();

  function close() {
    if (closing) return closing;
    closing = (async () => {
      if (onClose) await onClose();
      // Stop accepting new connections; in-flight requests drain. Idle
      // keep-alive sockets are closed so the callback is not held open.
      await new Promise((resolve, reject) => {
        httpServer.close(err => (err ? reject(err) : resolve()));
        httpServer.closeIdleConnections();
      });
      try { db.close(); } catch (err) { log('error', 'db close failed', { error: err.message }); }
    })().finally(() => {
      // Removed only after the drain so a repeated signal mid-shutdown is
      // still swallowed rather than killing the process.
      for (const [sig, fn] of signalHandlers) process.off(sig, fn);
      signalHandlers.clear();
    });
    return closing;
  }

  if (handleSignals) {
    const shutdown = (signal) => {
      if (closing) return;
      log('info', `${signal} received — graceful shutdown`);
      // Safety net — if a long-lived connection refuses to close, force
      // exit before Railway delivers SIGKILL at drainingSeconds=30.
      const timer = setTimeout(() => {
        log('error', `shutdown timed out after ${drainTimeoutMs}ms, forcing exit`);
        exit(1);
      }, drainTimeoutMs).unref();
      close().then(
        () => { clearTimeout(timer); log('info', 'shutdown complete'); exit(0); },
        (err) => { clearTimeout(timer); log('error', 'shutdown failed', { error: err.message }); exit(1); }
      );
    };
    for (const sig of ['SIGTERM', 'SIGINT']) {
      const fn = () => shutdown(sig);
      signalHandlers.set(sig, fn);
      process.on(sig, fn);
    }
  }

  return { url, port: bound.port, httpServer, app: expressApp, close };
}
