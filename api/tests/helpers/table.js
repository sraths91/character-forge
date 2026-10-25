// Real-socket table helpers shared by the phase 1 smoke (smoke.test.js)
// and the M65 run smokes (run-smoke.test.js, run-restart.test.js): E2's
// browser session over a real `ws` socket with a frame recorder and
// auto-responders, frame waits, and the `node api/server.js` child
// process with a kernel-bound port (PORT=0).

import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

import { createSession } from '../../../src/js/client/session.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/** A `ws` WebSocket the browser client can construct, remembered for teardown. */
export function trackedWebSocket(sockets) {
  return class TrackedWebSocket extends WebSocket {
    constructor(url) {
      super(url);
      sockets.add(this);
    }
  };
}

/**
 * One table seat: an E2 session plus a frame recorder and auto-responders
 * (cinema.done for every exchange; reaction prompts take their autoAnswer).
 * @param {string} name
 * @param {string} wsUrl
 * @param {string} token
 * @param {Function} WebSocketCtor
 * @param {object} [o]
 * @param {(msg: object, c: object) => boolean} [o.hold]  keep that prompt open (unanswered)
 * @param {(msg: object, c: object) => void} [o.onMessage]  called after the auto-responders
 */
export function tableClient(name, wsUrl, token, WebSocketCtor, { hold = null, onMessage = null } = {}) {
  const session = createSession({ url: wsUrl, token, WebSocketCtor, wsOptions: { logger: { warn: () => {} } } });
  const c = { name, session, frames: [], closes: [], waiters: [], failures: [], held: [], closeWaiters: [] };
  const answer = (intent) => session.send(intent).catch((err) => c.failures.push(`${intent.t}: ${err.code} ${err.message}`));
  c.answer = answer;
  session.ws.on('message', (msg) => {
    c.frames.push(msg);
    if (msg.t === 'exchange') answer({ t: 'cinema.done', p: { exchangeId: msg.p.payload.exchangeId } });
    if (msg.t === 'prompt.open' && hold?.(msg, c)) c.held.push(msg);
    else if (msg.t === 'prompt.open') answer({ t: 'prompt.answer', p: { promptId: msg.p.promptId, answer: msg.p.autoAnswer ?? false } });
    onMessage?.(msg, c);
    for (const w of [...c.waiters]) {
      if (!w.pred(msg)) continue;
      c.waiters.splice(c.waiters.indexOf(w), 1);
      clearTimeout(w.timer);
      w.resolve(msg);
    }
  });
  session.ws.on('close', (e) => {
    c.closes.push(e.code);
    for (const w of c.closeWaiters.splice(0)) w(e.code);
  });
  return c;
}

/** The client's first socket close code (already seen or future). */
export function closedWith(c, { timeoutMs = 10_000 } = {}) {
  if (c.closes.length) return Promise.resolve(c.closes[0]);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${c.name}: no socket close within ${timeoutMs} ms`)), timeoutMs);
    c.closeWaiters.push((code) => { clearTimeout(timer); resolve(code); });
  });
}

/** The first frame (already received or future) matching `pred`. */
export function until(c, pred, { timeoutMs = 10_000, since = 0 } = {}) {
  const hit = c.frames.slice(since).find(pred);
  if (hit) return Promise.resolve(hit);
  return new Promise((resolve, reject) => {
    const w = {
      pred,
      resolve,
      timer: setTimeout(() => {
        c.waiters.splice(c.waiters.indexOf(w), 1);
        reject(new Error(`${c.name}: timed out; last frames: ${c.frames.slice(-6).map(f => f.t).join(', ')}`));
      }, timeoutMs)
    };
    c.waiters.push(w);
  });
}

/** The room seq of the last sequenced frame (or snapshot) the client holds. */
export const lastSeq = (c) => c.frames.reduce((s, f) => (f.t === 'room.snapshot' ? f.p.seq : (f.seq ?? s)), 0);

/** Resolve once the client holds every broadcast up to `seq` (frames arrive in order). */
export async function untilSeq(c, seq, opts) {
  if (lastSeq(c) >= seq) return;
  await until(c, f => (f.t === 'room.snapshot' ? f.p.seq : f.seq) >= seq, { ...opts, since: c.frames.length });
}

/** A sequenced engine event of `type` whose frame payload passes `pred`. */
export const isEvent = (type, pred = () => true) => (m) => m.t === type && m.seq !== undefined && pred(m.p);
/** The client's sequenced frames after room seq `after`. */
export const sequenced = (c, after) => c.frames.filter(f => f.seq !== undefined && f.seq > after);

/** Send an intent and assert it was acked; returns the ack payload. */
export async function sendOk(c, t, p = {}) {
  const ack = await c.session.send({ t, p });
  assert.equal(ack.ok, true, `${c.name} ${t}`);
  return ack;
}

/**
 * Spawn `node api/server.js` (multiplayer, real engine) on `dataDir` with
 * PORT=0 and resolve once its "API listening" log line names the port the
 * kernel bound. Only complete stdout lines are parsed (a chunk can end
 * mid-line), and an exit before that line rejects with the child's output.
 * Picking a "free" port up front and handing it over raced with every
 * other test file binding ephemeral ports in parallel.
 * @param {string} dataDir
 * @returns {Promise<{child: import('node:child_process').ChildProcess, url: string, exited: Promise<{code: number|null, signal: string|null, at: number}>}>}
 */
export async function spawnServer(dataDir) {
  const child = spawn(process.execPath, [join(HERE, '..', '..', 'server.js')], {
    env: {
      ...process.env, NODE_ENV: 'test', CF_MULTIPLAYER: '1', CF_ENGINE: 'real',
      CF_DATA_DIR: dataDir, CF_DB_PATH: '', PORT: '0'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal, at: performance.now() })));
  let out = '';
  let pending = '';
  const bound = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start within 20 s: ${out}`)), 20_000);
    const onExit = (code, signal) => { clearTimeout(timer); reject(new Error(`server exited ${code ?? signal} before listening: ${out}`)); };
    child.once('exit', onExit);
    child.stdout.on('data', (d) => {
      out += d;
      pending += d;
      const lines = pending.split('\n');
      pending = lines.pop();   // the unterminated tail waits for the next chunk
      for (const line of lines) {
        if (!line.includes('API listening')) continue;
        let port;
        try { port = JSON.parse(line).port; } catch { continue; }
        clearTimeout(timer);
        child.off('exit', onExit);
        resolve(port);
        return;
      }
    });
    child.stderr.on('data', (d) => { out += d; });
  });
  assert.ok(Number.isInteger(bound) && bound > 0, `the startup log names the bound port (${bound})`);
  return { child, url: `http://127.0.0.1:${bound}`, exited };
}

/** SIGKILL a spawned server that is still running and wait for its exit. */
export async function stopChild(srv) {
  if (srv.child.exitCode === null && srv.child.signalCode === null) srv.child.kill('SIGKILL');
  await srv.exited;
}
