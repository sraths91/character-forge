/**
 * M64 C7 — ws-client (fake socket + fake timers) and cid generator.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWsClient, backoffDelay, DEFAULT_BACKOFF } from '../js/client/ws-client.js';
import { createCidGenerator, isCid, newCid } from '../js/client/cid.js';
import { validateClientMessage } from '../js/shared/protocol.js';

function makeFakeSocketClass() {
  class FakeSocket {
    constructor(url) {
      this.url = url;
      this.sent = [];
      this.readyState = 0;
      this.closeCalls = [];
      FakeSocket.instances.push(this);
    }
    send(data) {
      if (this.readyState !== 1) throw new Error('not open');
      this.sent.push(JSON.parse(data));
    }
    close(code = 1000) {
      this.closeCalls.push(code);
      this.readyState = 3;
    }
    // ---- test drivers ----
    open() { this.readyState = 1; this.onopen?.({}); }
    receive(msg) { this.onmessage?.({ data: typeof msg === 'string' ? msg : JSON.stringify(msg) }); }
    drop(code = 1006) { this.readyState = 3; this.onclose?.({ code, reason: '' }); }
    helloOk(serverNow = 5000) {
      this.receive({ v: 1, t: 'hello.ok', ts: 1, p: { memberId: 'mem_1', role: 'player', seats: [], serverNow, cfg: {} } });
    }
  }
  FakeSocket.instances = [];
  return FakeSocket;
}

function makeTimers() {
  const queue = new Map();
  let id = 0;
  return {
    setTimeout(fn, ms) { queue.set(++id, { fn, ms }); return id; },
    clearTimeout(i) { queue.delete(i); },
    pending: () => [...queue.values()],
    runAll() {
      const items = [...queue.entries()];
      queue.clear();
      for (const [, { fn }] of items) fn();
    }
  };
}

function setup(extra = {}) {
  const FakeSocket = makeFakeSocketClass();
  const timers = makeTimers();
  let n = 0;
  const client = createWsClient({
    url: 'ws://test/ws', token: 'tok-1', WebSocketCtor: FakeSocket, timers,
    now: () => 1000, random: () => 0.5, nextCid: () => `c${++n}`,
    logger: { warn() {} },
    ...extra
  });
  const sock = () => FakeSocket.instances[FakeSocket.instances.length - 1];
  return { client, FakeSocket, timers, sock };
}

const ack = (cid, ok = true) => ({ v: 1, t: 'ack', ts: 1, p: { cid, ok } });

test('C7: connect sends a valid hello first and resolves on hello.ok', async () => {
  const { client, sock } = setup({ getLastSeq: () => 41 });
  const ready = client.connect();
  assert.equal(client.status(), 'connecting');
  sock().open();
  assert.equal(client.status(), 'handshaking');
  assert.equal(sock().sent.length, 1);
  const hello = sock().sent[0];
  assert.equal(hello.t, 'hello');
  assert.deepEqual(hello.p, { token: 'tok-1', protocol: 1, lastSeq: 41 });
  assert.equal(validateClientMessage(hello).ok, true);
  sock().helloOk(6000);
  const ok = await ready;
  assert.equal(ok.memberId, 'mem_1');
  assert.equal(client.status(), 'open');
  assert.equal(client.serverNow(), 6000);   // offset = serverNow - now
});

test('C7: ack resolves the intent promise; an error frame rejects it', async () => {
  const { client, sock } = setup();
  client.connect();
  sock().open();
  sock().helloOk();
  const a = client.send({ t: 'seat.claim', p: { characterId: 'fighter-l5' } });
  const b = client.send({ t: 'cinema.done', p: { exchangeId: 'x2' } });
  // c1 went to the hello
  assert.deepEqual(sock().sent.slice(1).map(m => [m.t, m.cid]), [['seat.claim', 'c2'], ['cinema.done', 'c3']]);
  sock().receive(ack('c2'));
  sock().receive({ v: 1, t: 'error', ts: 1, p: { cid: 'c3', code: 'E_STALE', message: 'too late' } });
  assert.deepEqual(await a, { cid: 'c2', ok: true });
  await assert.rejects(b, err => err.code === 'E_STALE' && err.message === 'too late');
  assert.equal(client.pendingCount(), 0);
  // ack.ok === false also rejects
  const c = client.send({ t: 'dm.pause', p: {} });
  sock().receive(ack('c4', false));
  await assert.rejects(c);
});

test('C7: a bad outbound payload throws before anything is sent', () => {
  const { client, sock } = setup();
  client.connect();
  sock().open();
  sock().helloOk();
  const before = sock().sent.length;
  assert.throws(() => client.send({ t: 'seat.claim', p: { characterId: 'x', extra: 1 } }), err => err.code === 'E_BAD_MESSAGE');
  assert.throws(() => client.send({ t: 'no.such.intent', p: {} }), err => err.code === 'E_BAD_MESSAGE');
  assert.throws(() => client.send({ t: 'hello', p: { token: 'x', protocol: 1 } }));
  assert.throws(() => client.send({}));
  assert.equal(sock().sent.length, before);
  assert.equal(client.pendingCount(), 0);
});

test('C7: intents sent while disconnected queue and flush in order after hello.ok', async () => {
  const { client, sock } = setup();
  client.connect();
  const p1 = client.send({ t: 'seat.claim', p: { characterId: 'a' } });
  const p2 = client.send({ t: 'seat.release', p: { characterId: 'a' } });
  sock().open();
  assert.deepEqual(sock().sent.map(m => m.t), ['hello']);   // nothing before hello.ok
  sock().helloOk();
  assert.deepEqual(sock().sent.map(m => [m.t, m.cid]), [['hello', 'c3'], ['seat.claim', 'c1'], ['seat.release', 'c2']]);
  sock().receive(ack('c1'));
  sock().receive(ack('c2'));
  await Promise.all([p1, p2]);
});

test('C7: reconnects after a drop with backoff and re-sends unacked intents with the same cid', async () => {
  const { client, FakeSocket, timers, sock } = setup();
  const events = [];
  client.on('reconnecting', e => events.push(e));
  client.connect();
  sock().open();
  sock().helloOk();
  const p1 = client.send({ t: 'seat.claim', p: { characterId: 'a' } });
  const p2 = client.send({ t: 'turn.act', p: { turnId: 't1', plan: { kind: 'attack', targetId: 'm-goblin' } } });
  sock().receive(ack('c2'));   // c1 was the hello
  sock().drop(1006);
  assert.equal(client.status(), 'reconnecting');
  assert.equal(events.length, 1);
  assert.equal(events[0].delayMs, 1000);   // random 0.5 → no jitter offset
  assert.equal(FakeSocket.instances.length, 1);
  timers.runAll();
  assert.equal(FakeSocket.instances.length, 2);
  sock().open();
  sock().helloOk();
  assert.deepEqual(sock().sent.map(m => [m.t, m.cid]), [['hello', 'c4'], ['turn.act', 'c3']]);
  sock().receive(ack('c3'));
  await Promise.all([p1, p2]);
  // a second drop starts again from the base delay (attempt reset on hello.ok)
  sock().drop(1012);
  assert.equal(events[1].delayMs, 1000);
});

test('C7: backoff grows exponentially, is jittered, and caps at 30 s', () => {
  assert.equal(backoffDelay(0, () => 0.5), 1000);
  assert.equal(backoffDelay(1, () => 0.5), 2000);
  assert.equal(backoffDelay(4, () => 0.5), 16000);
  assert.equal(backoffDelay(5, () => 0.5), 30000);
  assert.equal(backoffDelay(20, () => 0.999), 30000);
  assert.equal(backoffDelay(0, () => 0), 800);
  assert.ok(backoffDelay(0, () => 0.99) > 1000);
  assert.deepEqual(DEFAULT_BACKOFF, { baseMs: 1000, maxMs: 30000, jitter: 0.2 });
  const { client, timers, sock } = setup();
  client.connect();
  const delays = [];
  client.on('reconnecting', e => delays.push(e.delayMs));
  for (let i = 0; i < 7; i++) { sock().drop(); timers.runAll(); }
  assert.deepEqual(delays, [1000, 2000, 4000, 8000, 16000, 30000, 30000]);
});

test('C7: close is idempotent, rejects unacked intents, and stops reconnecting', async () => {
  const { client, FakeSocket, timers, sock } = setup();
  client.connect();
  sock().open();
  sock().helloOk();
  const p = client.send({ t: 'seat.claim', p: { characterId: 'a' } });
  const s = sock();
  client.close();
  client.close();
  assert.equal(client.status(), 'closed');
  assert.deepEqual(s.closeCalls, [1000]);
  await assert.rejects(p, err => err.code === 'E_CLOSED');
  s.drop();   // a late close event from the old socket is ignored
  timers.runAll();
  assert.equal(FakeSocket.instances.length, 1);
  await assert.rejects(client.send({ t: 'dm.pause', p: {} }), err => err.code === 'E_CLOSED');
  await assert.rejects(client.connect(), err => err.code === 'E_CLOSED');
  // closing during a pending reconnect clears the timer
  const b = setup();
  b.client.connect();
  b.sock().drop();
  assert.equal(b.timers.pending().length, 1);
  b.client.close();
  assert.equal(b.timers.pending().length, 0);
});

test('C7: revoked / superseded close codes and a handshake auth error are terminal', async () => {
  for (const code of [4403, 4409]) {
    const { client, timers, sock } = setup();
    const ready = client.connect();
    sock().open();
    sock().helloOk();
    await ready;
    let terminated = null;
    client.on('terminated', e => { terminated = e; });
    sock().drop(code);
    assert.equal(client.status(), 'closed');
    assert.equal(timers.pending().length, 0);
    assert.ok(terminated);
  }
  const { client, timers, sock } = setup();
  const ready = client.connect();
  sock().open();
  sock().receive({ v: 1, t: 'error', ts: 1, p: { cid: null, code: 'E_UNAUTHENTICATED', message: 'bad token' } });
  await assert.rejects(ready, err => err.code === 'E_UNAUTHENTICATED');
  assert.equal(client.status(), 'closed');
  assert.equal(timers.pending().length, 0);
});

test('C7: resync is sent on request when open and dropped while offline', () => {
  const { client, sock } = setup();
  client.connect();
  assert.equal(client.resync(10), false);
  sock().open();
  sock().helloOk();
  assert.equal(client.resync(10), true);
  const msg = sock().sent.at(-1);
  assert.equal(msg.t, 'resync');
  assert.deepEqual(msg.p, { lastSeq: 10 });
  assert.equal(validateClientMessage(msg).ok, true);
  assert.equal(client.pendingCount(), 0);
});

test('C7: on() dispatches by type and to "message"; unsubscribe works; bad frames are reported', () => {
  const { client, sock } = setup();
  client.connect();
  sock().open();
  sock().helloOk();
  const statuses = [];
  const all = [];
  const invalid = [];
  const off = client.on('room.status', p => statuses.push(p.status));
  client.on('message', m => all.push(m.t));
  client.on('invalid', e => invalid.push(e.reason));
  sock().receive({ v: 1, t: 'room.status', seq: 3, ts: 1, p: { status: 'paused' } });
  off();
  sock().receive({ v: 1, t: 'room.status', seq: 4, ts: 1, p: { status: 'in-encounter' } });
  sock().receive('{garbage');
  sock().receive({ v: 1, t: 'ack', ts: 1, p: { nope: true } });
  assert.deepEqual(statuses, ['paused']);
  assert.deepEqual(all, ['room.status', 'room.status']);
  assert.deepEqual(invalid, ['parse', 'contract']);
});

test('C7: a token function is re-read on every hello (resume token from the caller)', () => {
  let tok = 'first';
  const { client, timers, sock } = setup({ token: () => tok });
  client.connect();
  sock().open();
  assert.equal(sock().sent[0].p.token, 'first');
  sock().drop();
  tok = 'second';
  timers.runAll();
  sock().open();
  assert.equal(sock().sent[0].p.token, 'second');
});

test('C7: constructor rejects missing url / token / WebSocket', () => {
  assert.throws(() => createWsClient({ token: 't', WebSocketCtor: function () {} }), TypeError);
  assert.throws(() => createWsClient({ url: 'ws://x', WebSocketCtor: function () {} }), TypeError);
  assert.throws(() => createWsClient({ url: 'ws://x', token: 't', WebSocketCtor: null }), TypeError);
});

test('C7: cid generator is ULID-shaped, unique and monotonic within a millisecond', () => {
  let t = 1760400000000;
  const gen = createCidGenerator({ now: () => t, randomBytes: n => new Uint8Array(n).fill(5) });
  const a = gen();
  const b = gen();
  assert.ok(isCid(a) && isCid(b));
  assert.equal(a.length, 26);
  assert.notEqual(a, b);
  assert.ok(a < b);
  t += 1;
  const c = gen();
  assert.ok(b < c);
  assert.equal(c.slice(0, 10) > a.slice(0, 10), true);
  const ids = new Set(Array.from({ length: 500 }, () => newCid()));
  assert.equal(ids.size, 500);
  for (const id of ids) assert.equal(validateClientMessage({ v: 1, t: 'resync', cid: id, p: {} }).ok, true);
  assert.equal(isCid('not-a-cid'), false);
});
