// WebSocket gateway (M64 B7): `ws` in noServer mode on the shared
// http.Server, path /ws only.
//
//   upgrade   Origin allow-list (ALLOWED_ORIGINS, the request's own host, and
//             localhost in development) else HTTP 403 + destroy.
//   hello     first message must be `hello {token, protocol}` within 5 s, else
//             close 4401. The token is never in the URL. A second socket for
//             the same member supersedes the first (4409, done by the room).
//   limits    maxPayload 16 KiB (ws closes 1009); token bucket 20 msg/s with
//             a burst of 40 (close 1008); bufferedAmount > 1 MiB → terminate.
//   heartbeat ping every 30 s, terminate on a missed pong (README pattern).
//   messages  every frame parsed and validated with shared/protocol.js, then
//             routed to the member's room; per-message try/catch.

import { WebSocketServer } from 'ws';
import { CLOSE_CODES, PROTOCOL_VERSION, validateClientMessage } from '../../src/js/shared/protocol.js';
import { VALIDATION_CODES } from '../../src/js/shared/check.js';
import { newId } from '../rooms/tokens.js';

export const WS_PATH = '/ws';
export const MAX_PAYLOAD = 16 * 1024;
export const HELLO_TIMEOUT_MS = 5000;
export const HEARTBEAT_MS = 30_000;
export const MAX_BUFFERED = 1024 * 1024;
export const RATE = Object.freeze({ perSec: 20, burst: 40 });

/**
 * Is this Origin allowed to open a socket?
 * @param {string|undefined} origin
 * @param {{allowed: string[], host?: string, production: boolean}} o
 */
export function originAllowed(origin, { allowed, host, production }) {
  if (!origin) return !production;          // non-browser clients only outside production
  if (allowed.includes(origin)) return true;
  let u;
  try { u = new URL(origin); } catch { return false; }
  if (host && u.host === host) return true; // same origin as the page that served us
  if (!production && (u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]')) return true;
  return false;
}

/**
 * Attach the gateway to an http.Server.
 *
 * @param {object} o
 * @param {import('node:http').Server} o.httpServer
 * @param {ReturnType<import('../rooms/registry.js').createRoomRegistry>} o.registry
 * @param {ReturnType<import('../rooms/service.js').createRoomService>} o.service
 * @param {Record<string, string|undefined>} [o.env=process.env]  NODE_ENV, ALLOWED_ORIGINS
 * @param {(level: string, msg: string, extra?: object) => void} [o.log]
 * @param {number} [o.heartbeatMs=HEARTBEAT_MS]
 * @param {number} [o.helloTimeoutMs=HELLO_TIMEOUT_MS]
 * @param {number} [o.maxPayload=MAX_PAYLOAD]
 * @param {number} [o.maxBuffered=MAX_BUFFERED]
 * @param {{perSec: number, burst: number}} [o.rate=RATE]
 * @param {() => number} [o.now=Date.now]
 * @returns {{wss: WebSocketServer, connections: () => number, close: (code?: number) => Promise<void>}}
 */
export function attachGateway({
  httpServer, registry, service, env = process.env, log = () => {},
  heartbeatMs = HEARTBEAT_MS, helloTimeoutMs = HELLO_TIMEOUT_MS, maxPayload = MAX_PAYLOAD,
  maxBuffered = MAX_BUFFERED, rate = RATE, now = Date.now
}) {
  const production = env.NODE_ENV === 'production';
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  const wss = new WebSocketServer({ noServer: true, maxPayload, clientTracking: true, perMessageDeflate: false });
  /** ws → conn, for the heartbeat. */
  const conns = new WeakMap();
  let closing = false;

  function onSocketError(err) { log('warn', 'ws: upgrade socket error', { error: err.message }); }

  function onUpgrade(req, socket, head) {
    socket.on('error', onSocketError);
    let pathname = '';
    try { pathname = new URL(req.url, 'http://x').pathname; } catch { /* malformed */ }
    if (pathname !== WS_PATH || closing) {
      socket.write(`HTTP/1.1 ${closing ? 503 : 404} ${closing ? 'Service Unavailable' : 'Not Found'}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
      return;
    }
    if (!originAllowed(req.headers.origin, { allowed, host: req.headers.host, production })) {
      log('warn', 'ws: origin rejected', { origin: String(req.headers.origin || '') });
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    socket.removeListener('error', onSocketError);
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  }
  httpServer.on('upgrade', onUpgrade);

  wss.on('connection', (ws, req) => {
    const conn = {
      id: newId('c_'),
      ws,
      ip: req.socket.remoteAddress,
      member: null,      // {participantId, roomId, role}
      room: null,
      alive: true,
      tokens: rate.burst,
      refilledAt: now(),
      sendRaw(text) {
        if (ws.readyState !== ws.OPEN) return;
        if (ws.bufferedAmount > maxBuffered) {
          log('warn', 'ws: client too slow, terminating', { conn: conn.id, buffered: ws.bufferedAmount });
          ws.terminate();
          return;
        }
        ws.send(text);
      },
      close(code, reason) {
        if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) ws.close(code, reason);
      }
    };
    conns.set(ws, conn);
    const helloTimer = setTimeout(() => {
      if (!conn.member) conn.close(CLOSE_CODES.HELLO_TIMEOUT, 'hello required');
    }, helloTimeoutMs);

    ws.on('error', (err) => log('warn', 'ws: socket error', { conn: conn.id, error: err.message, code: err.code }));
    ws.on('pong', () => { conn.alive = true; });
    ws.on('close', () => {
      clearTimeout(helloTimer);
      if (conn.room) conn.room.detach(conn);
    });

    const sendError = (cid, code, message) => conn.sendRaw(JSON.stringify({
      v: PROTOCOL_VERSION, t: 'error', ts: now(), p: { cid: cid ?? null, code, message }
    }));

    ws.on('message', (data, isBinary) => {
      // Token bucket: 20 msg/s, burst 40.
      const t = now();
      conn.tokens = Math.min(rate.burst, conn.tokens + ((t - conn.refilledAt) / 1000) * rate.perSec);
      conn.refilledAt = t;
      if (conn.tokens < 1) {
        log('warn', 'ws: rate limit exceeded', { conn: conn.id });
        conn.close(CLOSE_CODES.POLICY, 'rate limit exceeded');
        return;
      }
      conn.tokens -= 1;
      try {
        if (isBinary) { sendError(null, 'E_BAD_MESSAGE', 'binary frames are not accepted'); return; }
        let msg;
        try { msg = JSON.parse(data.toString('utf8')); } catch {
          sendError(null, 'E_BAD_MESSAGE', 'malformed JSON');
          return;
        }
        const cid = typeof msg?.cid === 'string' && msg.cid.length <= 64 ? msg.cid : null;
        const v = validateClientMessage(msg);
        if (!v.ok) {
          const codes = new Set(v.errors.map(e => e.code));
          const code = codes.has(VALIDATION_CODES.VERSION) ? 'E_VERSION'
            : (v.errors.some(e => e.path === 't' && e.code === VALIDATION_CODES.ENUM) ? 'E_UNKNOWN_TYPE' : 'E_BAD_MESSAGE');
          sendError(cid, code, v.errors.slice(0, 3).map(e => `${e.path || '(root)'}: ${e.message}`).join('; '));
          if (!conn.member) conn.close(CLOSE_CODES.HELLO_TIMEOUT, 'hello required');
          return;
        }
        if (!conn.member) {
          if (msg.t !== 'hello') {
            sendError(cid, 'E_UNAUTHENTICATED', 'send hello first');
            conn.close(CLOSE_CODES.HELLO_TIMEOUT, 'hello required');
            return;
          }
          if (msg.p.protocol !== PROTOCOL_VERSION) {
            sendError(cid, 'E_VERSION', `protocol ${PROTOCOL_VERSION} required`);
            conn.close(CLOSE_CODES.HELLO_TIMEOUT, 'protocol mismatch');
            return;
          }
          const auth = service.authenticate(msg.p.token);
          const room = auth ? registry.get(auth.roomId) : null;
          if (!auth || !room) {
            sendError(cid, 'E_UNAUTHENTICATED', 'unknown or revoked token');
            conn.close(CLOSE_CODES.HELLO_TIMEOUT, 'unauthenticated');
            return;
          }
          clearTimeout(helloTimer);
          conn.member = auth;
          conn.room = room;
          room.attach(conn, auth, msg.cid);
          return;
        }
        conn.room.handle(conn, conn.member.participantId, msg);
      } catch (err) {
        log('error', 'ws: message handler failed', { conn: conn.id, error: err.message, stack: err.stack });
        sendError(null, 'E_INTERNAL', 'internal error');
      }
    });
  });

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      const conn = conns.get(ws);
      if (!conn) continue;
      if (conn.alive === false) { ws.terminate(); continue; }
      conn.alive = false;
      try { ws.ping(); } catch { /* closing */ }
    }
  }, heartbeatMs);
  heartbeat.unref?.();

  return {
    wss,
    connections: () => wss.clients.size,
    /**
     * Close every socket with `code` (default 1012), wait up to `graceMs`
     * for the close handshakes, terminate stragglers, stop the heartbeat
     * and the server. Idempotent.
     */
    async close(code = CLOSE_CODES.RESTARTING, { graceMs = 1000 } = {}) {
      if (closing) return;
      closing = true;
      clearInterval(heartbeat);
      httpServer.off('upgrade', onUpgrade);
      const pending = [];
      for (const ws of wss.clients) {
        pending.push(new Promise((resolve) => {
          if (ws.readyState === ws.CLOSED) return resolve();
          ws.once('close', resolve);
          try { ws.close(code, 'server restarting'); } catch { ws.terminate(); }
        }));
      }
      let timer;
      await Promise.race([
        Promise.all(pending),
        new Promise((resolve) => { timer = setTimeout(resolve, graceMs); })
      ]);
      clearTimeout(timer);
      for (const ws of wss.clients) ws.terminate();
      await new Promise((resolve) => wss.close(() => resolve()));
    }
  };
}
