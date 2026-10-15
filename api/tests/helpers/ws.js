// ws test client for the M64 gateway tests. Records every frame, checks
// each against shared/protocol.js, and tracks seq continuity.

import WebSocket from 'ws';
import { validateServerMessage } from '../../../src/js/shared/protocol.js';

let cidN = 0;
const nextCid = () => `c${++cidN}`;

/**
 * Open a raw socket (no hello). Resolves once open, or with the
 * unexpected HTTP response / error.
 */
export function rawSocket(url, { origin = 'http://localhost:3100', autoPong = true } = {}) {
  const ws = new WebSocket(url.replace(/^http/, 'ws') + '/ws', { origin, autoPong });
  return new Promise((resolve) => {
    ws.once('open', () => resolve({ ws, status: 101 }));
    ws.once('unexpected-response', (_req, res) => { resolve({ ws, status: res.statusCode }); res.resume(); });
    ws.once('error', (err) => resolve({ ws, status: 0, error: err }));
  });
}

/** Wait for a socket's close event: resolves {code, reason}. */
export function closed(ws) {
  if (ws.readyState === WebSocket.CLOSED) return Promise.resolve({ code: ws._closeCode ?? 1006, reason: '' });
  return new Promise((resolve) => ws.once('close', (code, reason) => resolve({ code, reason: String(reason) })));
}

/**
 * A connected, authenticated test client.
 */
export class TestClient {
  constructor(ws, name) {
    this.ws = ws;
    this.name = name;
    this.frames = [];
    this.invalid = [];
    this.waiters = [];
    this.lastSeq = null;
    this.gaps = [];
    ws.on('message', (data) => {
      const msg = JSON.parse(String(data));
      const v = validateServerMessage(msg);
      if (!v.ok) this.invalid.push({ msg, errors: v.errors });
      if (msg.t === 'room.snapshot') this.lastSeq = msg.p.seq;
      else if (msg.seq !== undefined) {
        if (this.lastSeq !== null && msg.seq !== this.lastSeq + 1) this.gaps.push({ expected: this.lastSeq + 1, got: msg.seq, t: msg.t });
        this.lastSeq = msg.seq;
      }
      this.frames.push(msg);
      for (const w of [...this.waiters]) {
        if (w.pred(msg)) { this.waiters.splice(this.waiters.indexOf(w), 1); clearTimeout(w.timer); w.resolve(msg); }
      }
    });
  }

  /** Connect and say hello; resolves after hello.ok + room.snapshot. */
  static async connect(url, token, { name = 'client', origin } = {}) {
    const { ws, status } = await rawSocket(url, origin ? { origin } : {});
    if (status !== 101) throw new Error(`upgrade failed: ${status}`);
    const c = new TestClient(ws, name);
    const snap = c.next(m => m.t === 'room.snapshot');
    c.sendRaw({ v: 1, t: 'hello', cid: nextCid(), p: { token, protocol: 1 } });
    c.snapshot = await snap;
    c.hello = c.frames.find(f => f.t === 'hello.ok');
    return c;
  }

  sendRaw(obj) { this.ws.send(typeof obj === 'string' ? obj : JSON.stringify(obj)); }

  /** Send an intent; resolves with the ack or error frame for its cid. */
  send(t, p = {}, cid = nextCid()) {
    const reply = this.next(m => (m.t === 'ack' || m.t === 'error') && m.p.cid === cid);
    this.sendRaw({ v: 1, t, cid, p });
    return reply;
  }

  /** Next frame (already received after `since`, or future) matching pred. */
  next(pred, { timeoutMs = 3000, since = this.frames.length } = {}) {
    const hit = this.frames.slice(since).find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const w = { pred, resolve, timer: setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(w), 1);
        reject(new Error(`${this.name}: timed out waiting; last frames: ${this.frames.slice(-5).map(f => f.t).join(', ')}`));
      }, timeoutMs) };
      this.waiters.push(w);
    });
  }

  /** First frame ever received (from index 0) matching pred, waiting if needed. */
  find(pred, opts = {}) { return this.next(pred, { ...opts, since: 0 }); }

  of(t) { return this.frames.filter(f => f.t === t); }

  close() { this.ws.terminate(); }
}

export { nextCid };
