/**
 * M64 C7 — browser WebSocket client for the room protocol.
 *
 *   connect()        open the socket, send `hello {token, protocol, lastSeq?}`
 *                    first, resolve on `hello.ok`
 *   send(intent)     {t, p} → validated {v, t, cid, p}; Promise resolves on
 *                    the matching `ack`, rejects on an `error` frame for that
 *                    cid (or `ack.ok === false`)
 *   resync(lastSeq)  ask for a fresh `room.snapshot` (the store's gap /
 *                    state-hash request); fire-and-forget
 *   on(type, fn)     server message type, or 'message' (every frame),
 *                    'open' (hello.ok), 'close', 'reconnecting', 'terminated',
 *                    'invalid' (unparseable frame) → unsubscribe
 *   close()          idempotent; rejects every unacked intent
 *
 * Reconnect: jittered exponential backoff 1 s → 30 s. The token is the
 * resume token (the caller keeps it; a function is re-read per attempt).
 * Intents not yet acked stay queued in send order and are re-sent with
 * their original `cid` after every `hello.ok`, so the server's cid de-dupe
 * makes retries safe. Heartbeat is server-driven: browsers answer ws
 * pings automatically, so there is no client ping. Close codes 4403
 * (revoked) and 4409 (superseded) and a handshake `E_UNAUTHENTICATED` /
 * `E_VERSION` are terminal: no reconnect.
 *
 * Every outbound message is validated with `validateClientMessage`
 * (a bad payload throws before anything is sent). Inbound frames are
 * parsed and dispatched; `ack` / `error` / `hello.ok` are validated here,
 * everything else is validated by the store (C6).
 */

import {
  PROTOCOL_VERSION, CLOSE_CODES, validateClientMessage, validateServerMessage
} from '../shared/protocol.js';
import { createCidGenerator } from './cid.js';

const WS_OPEN = 1;
const TERMINAL_CLOSE_CODES = new Set([CLOSE_CODES.REVOKED, CLOSE_CODES.SUPERSEDED]);
const TERMINAL_HELLO_ERRORS = new Set(['E_UNAUTHENTICATED', 'E_VERSION']);

/** Default reconnect backoff: 1 s base, 30 s cap, ±20 % jitter. */
export const DEFAULT_BACKOFF = Object.freeze({ baseMs: 1000, maxMs: 30000, jitter: 0.2 });

/**
 * Jittered exponential backoff delay for reconnect attempt `attempt` (0-based).
 * @param {number} attempt
 * @param {() => number} [random] — uniform [0, 1)
 * @param {{baseMs: number, maxMs: number, jitter: number}} [cfg]
 * @returns {number} milliseconds, never above cfg.maxMs
 */
export function backoffDelay(attempt, random = Math.random, cfg = DEFAULT_BACKOFF) {
  const raw = Math.min(cfg.maxMs, cfg.baseMs * Math.pow(2, Math.max(0, attempt)));
  const factor = 1 - cfg.jitter + 2 * cfg.jitter * random();
  return Math.max(0, Math.min(cfg.maxMs, Math.round(raw * factor)));
}

function makeError(code, message, extra = {}) {
  const err = new Error(message);
  err.code = code;
  Object.assign(err, extra);
  return err;
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  promise.catch(() => {});   // callers that drop the promise must not crash the page
  return { promise, resolve, reject };
}

/**
 * Create a room WebSocket client.
 *
 * @param {object} opts
 * @param {string} opts.url
 * @param {string|(() => string)} opts.token — participant / DM token (the resume token)
 * @param {Function} [opts.WebSocketCtor] — defaults to globalThis.WebSocket
 * @param {() => number} [opts.now] — wall clock (ms), for cids and the server clock offset
 * @param {{setTimeout: Function, clearTimeout: Function}} [opts.timers]
 * @param {() => number} [opts.random] — backoff jitter source
 * @param {() => string} [opts.nextCid] — cid generator (default ULID-ish from cid.js)
 * @param {() => (number|null)} [opts.getLastSeq] — e.g. () => store.getState().seq, sent in hello
 * @param {{baseMs: number, maxMs: number, jitter: number}} [opts.backoff]
 * @param {{warn: Function}} [opts.logger]
 * @returns {{
 *   connect: () => Promise<object>,
 *   send: (intent: {t: string, p?: object, cid?: string}) => Promise<object>,
 *   resync: (lastSeq?: number|null) => boolean,
 *   on: (type: string, fn: (payload: any, msg?: object) => void) => () => void,
 *   close: () => void,
 *   status: () => ('idle'|'connecting'|'handshaking'|'open'|'reconnecting'|'closed'),
 *   pendingCount: () => number,
 *   serverNow: () => number
 * }}
 */
export function createWsClient({
  url,
  token,
  WebSocketCtor = globalThis.WebSocket,
  now = () => Date.now(),
  timers = {
    setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
    clearTimeout: (id) => globalThis.clearTimeout(id)
  },
  random = Math.random,
  nextCid = null,
  getLastSeq = null,
  backoff = DEFAULT_BACKOFF,
  logger = { warn: (...args) => globalThis.console?.warn?.(...args) }
} = {}) {
  if (typeof url !== 'string' || !url) throw new TypeError('createWsClient: url is required');
  if (typeof token !== 'string' && typeof token !== 'function') throw new TypeError('createWsClient: token is required');
  if (typeof WebSocketCtor !== 'function') throw new TypeError('createWsClient: no WebSocket implementation');
  const makeCid = nextCid || createCidGenerator({ now });

  let state = 'idle';
  let socket = null;
  let attempt = 0;
  let reconnectTimer = null;
  let ready = null;              // deferred for the next hello.ok
  let lastHello = null;
  let clockOffset = 0;
  const pending = new Map();     // cid → {msg, resolve, reject}; insertion = send order
  const listeners = new Map();   // type → Set<fn>

  function emit(type, payload, msg) {
    const set = listeners.get(type);
    if (!set) return;
    for (const fn of [...set]) {
      try { fn(payload, msg); } catch (error) {
        logger.warn('[ws-client] listener failed', { type, error: String(error?.message || error) });
      }
    }
  }

  function build(t, p, cid) {
    const msg = { v: PROTOCOL_VERSION, t, cid: cid || makeCid(), p: p || {} };
    const res = validateClientMessage(msg);
    if (!res.ok) {
      throw makeError('E_BAD_MESSAGE',
        `invalid "${t}" intent: ${res.errors.map(e => `${e.path || '(root)'} ${e.message}`).join('; ')}`,
        { errors: res.errors });
    }
    return msg;
  }

  function sendRaw(msg) {
    if (!socket || socket.readyState !== WS_OPEN) return false;
    try {
      socket.send(JSON.stringify(msg));
      return true;
    } catch (error) {
      logger.warn('[ws-client] send failed', { t: msg.t, cid: msg.cid, error: String(error?.message || error) });
      return false;
    }
  }

  function rejectAll(err) {
    for (const entry of pending.values()) entry.reject(err);
    pending.clear();
    if (ready) { ready.reject(err); ready = null; }
  }

  function terminate(err) {
    state = 'closed';
    if (reconnectTimer !== null) { timers.clearTimeout(reconnectTimer); reconnectTimer = null; }
    const ws = socket;
    socket = null;
    if (ws) { try { ws.close(CLOSE_CODES.NORMAL); } catch { /* already closing */ } }
    rejectAll(err);
    emit('terminated', { code: err.code, message: err.message });
  }

  function scheduleReconnect() {
    if (state === 'closed') return;
    state = 'reconnecting';
    const delayMs = backoffDelay(attempt, random, backoff);
    attempt++;
    emit('reconnecting', { attempt, delayMs });
    reconnectTimer = timers.setTimeout(() => {
      reconnectTimer = null;
      openSocket();
    }, delayMs);
  }

  function helloMessage() {
    const p = { token: typeof token === 'function' ? token() : token, protocol: PROTOCOL_VERSION };
    const seq = typeof getLastSeq === 'function' ? getLastSeq() : null;
    if (Number.isInteger(seq) && seq >= 0) p.lastSeq = seq;
    return build('hello', p);
  }

  function onHelloOk(msg) {
    state = 'open';
    attempt = 0;
    lastHello = msg.p;
    if (typeof msg.p.serverNow === 'number') clockOffset = msg.p.serverNow - now();
    for (const entry of pending.values()) sendRaw(entry.msg);
    if (ready) { ready.resolve(msg.p); ready = null; }
    emit('open', msg.p, msg);
  }

  function handleFrame(data) {
    let msg;
    try { msg = JSON.parse(typeof data === 'string' ? data : String(data)); } catch {
      emit('invalid', { reason: 'parse', data });
      return;
    }
    const t = msg && msg.t;
    if (t === 'hello.ok' || t === 'ack' || t === 'error') {
      const res = validateServerMessage(msg);
      if (!res.ok) {
        emit('invalid', { reason: 'contract', t, errors: res.errors });
        return;
      }
      if (t === 'hello.ok') onHelloOk(msg);
      if (t === 'ack') {
        const entry = pending.get(msg.p.cid);
        if (entry) {
          pending.delete(msg.p.cid);
          if (msg.p.ok === false) entry.reject(makeError(msg.p.code || 'E_REJECTED', msg.p.message || 'intent rejected', { ack: msg.p }));
          else entry.resolve(msg.p);
        }
      }
      if (t === 'error') {
        const entry = msg.p.cid ? pending.get(msg.p.cid) : null;
        if (entry) {
          pending.delete(msg.p.cid);
          entry.reject(makeError(msg.p.code, msg.p.message, { frame: msg.p }));
        } else if (state === 'handshaking' && TERMINAL_HELLO_ERRORS.has(msg.p.code)) {
          emit('error', msg.p, msg);
          emit('message', msg, msg);
          terminate(makeError(msg.p.code, msg.p.message));
          return;
        }
      }
    }
    if (typeof t === 'string') emit(t, msg.p, msg);
    emit('message', msg, msg);
  }

  function openSocket() {
    if (state === 'closed') return;
    state = 'connecting';
    let ws;
    try {
      ws = new WebSocketCtor(url);
    } catch (error) {
      logger.warn('[ws-client] socket construction failed', { url, error: String(error?.message || error) });
      scheduleReconnect();
      return;
    }
    socket = ws;
    ws.onopen = () => {
      if (socket !== ws) return;
      state = 'handshaking';
      sendRaw(helloMessage());
    };
    ws.onmessage = (ev) => {
      if (socket !== ws) return;
      handleFrame(ev?.data);
    };
    ws.onerror = () => { /* a close event always follows */ };
    ws.onclose = (ev) => {
      if (socket !== ws) return;
      socket = null;
      const code = ev?.code ?? 1006;
      emit('close', { code, reason: ev?.reason || '' });
      if (state === 'closed') return;
      if (TERMINAL_CLOSE_CODES.has(code)) {
        terminate(makeError(code === CLOSE_CODES.REVOKED ? 'E_REVOKED' : 'E_SUPERSEDED', `socket closed with ${code}`, { closeCode: code }));
        return;
      }
      scheduleReconnect();
    };
  }

  return {
    connect() {
      if (state === 'closed') return Promise.reject(makeError('E_CLOSED', 'client is closed'));
      if (state === 'open') return Promise.resolve(lastHello);
      if (!ready) ready = deferred();
      const p = ready.promise;
      if (state === 'idle') openSocket();
      return p;
    },

    send(intent) {
      if (!intent || typeof intent.t !== 'string') throw makeError('E_BAD_MESSAGE', 'send: intent {t, p} required');
      if (intent.t === 'hello') throw makeError('E_BAD_MESSAGE', 'send: hello is sent by the client itself');
      const msg = build(intent.t, intent.p, intent.cid);
      if (state === 'closed') return Promise.reject(makeError('E_CLOSED', 'client is closed'));
      if (pending.has(msg.cid)) throw makeError('E_BAD_MESSAGE', `send: cid ${msg.cid} is already in flight`);
      const d = deferred();
      pending.set(msg.cid, { msg, resolve: d.resolve, reject: d.reject });
      if (state === 'open') sendRaw(msg);
      return d.promise;
    },

    resync(lastSeq = null) {
      const p = Number.isInteger(lastSeq) && lastSeq >= 0 ? { lastSeq } : {};
      const msg = build('resync', p);
      if (state !== 'open') return false;   // the next hello.ok brings a snapshot anyway
      return sendRaw(msg);
    },

    on(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
      return () => { listeners.get(type)?.delete(fn); };
    },

    close() {
      if (state === 'closed') return;
      terminate(makeError('E_CLOSED', 'client closed'));
    },

    status: () => state,
    pendingCount: () => pending.size,
    serverNow: () => now() + clockOffset
  };
}
