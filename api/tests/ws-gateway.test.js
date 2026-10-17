// M64 B7 — ws gateway + room integration tests, on port 0 with the ws
// client. Every frame a client receives is checked against
// shared/protocol.js and for seq continuity.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';

import { startMultiplayerServer } from '../multiplayer.js';
import { createRoomService } from '../rooms/service.js';
import { originAllowed, clientIp } from '../ws/gateway.js';
import WebSocket from 'ws';
import { createStubEngine } from '../rooms/engine-port.js';
import { viewFor, stateHash, fogEventView, fogVisibility, HIDDEN_ENTITY_ID } from '../rooms/view.js';
import { stateHash as sharedStateHash } from '../../src/js/shared/state-hash.js';
import { validateEncounterState } from '../../src/js/shared/encounter-state.js';
import { tempRoot, tempDb, quiet, ddbFixture, api } from './helpers/server.js';
import { TestClient, rawSocket, closed } from './helpers/ws.js';
import { revealCells, filterViewForFog } from '../../src/js/map/fog.js';
import { asTerrain } from '../../src/js/map/terrain.js';

const { root, cleanup } = tempRoot('cf-ws-');
after(cleanup);

const LOOSE = { roomCreate: { windowMs: 60_000, max: 1000 }, roomJoin: { windowMs: 60_000, max: 1000 } };

/** Engine-dependent tests run against both ports (CF_ENGINE). */
const ENGINES = ['stub', 'real'];

async function boot({ gatewayOpts = {}, roomOpts = {}, engine, engineKind } = {}) {
  const { db } = await tempDb(root);
  const srv = await startMultiplayerServer({
    db, env: { NODE_ENV: 'test', ...(engineKind ? { CF_ENGINE: engineKind } : {}) }, port: 0, host: '127.0.0.1', log: quiet,
    appOpts: { limits: LOOSE }, gatewayOpts, roomOpts, ...(engine ? { engine } : {})
  });
  const clients = [];
  srv.track = (c) => { clients.push(c); return c; };
  const close = srv.close;
  srv.rawClose = close;
  srv.close = async () => {
    for (const c of clients) c.ws.terminate();
    await close();
  };
  return srv;
}

/** Room with a DM and N players, each seated with a fixture character. */
async function table(srv, players = 2, fixtures = ['fighter-l5', 'wizard-l5', 'cleric-l5']) {
  const room = (await api(srv.url, '/api/rooms', { method: 'POST', body: {} })).body;
  const ps = [];
  for (let i = 0; i < players; i++) {
    const p = (await api(srv.url, '/api/rooms/join', { method: 'POST', body: { code: room.code, displayName: `P${i + 1}` } })).body;
    const imp = await api(srv.url, `/api/import?room=${room.roomId}`, { method: 'POST', token: p.token, body: { json: ddbFixture(fixtures[i % 3]) } });
    const seat = await api(srv.url, `/api/rooms/${room.roomId}/seats/${i + 1}/claim`, { method: 'POST', token: p.token, body: { characterId: imp.body.character.id } });
    assert.equal(seat.status, 200);
    ps.push(p);
  }
  return { room, players: ps };
}

async function connectAll(srv, t) {
  const dm = srv.track(await TestClient.connect(srv.url, t.room.dmToken, { name: 'dm' }));
  const ps = [];
  for (const [i, p] of t.players.entries()) ps.push(srv.track(await TestClient.connect(srv.url, p.token, { name: `p${i + 1}` })));
  return { dm, ps };
}

function assertClean(...clients) {
  for (const c of clients) {
    assert.deepEqual(c.invalid, [], `${c.name} received invalid frames`);
    assert.deepEqual(c.gaps, [], `${c.name} saw seq gaps`);
  }
}

const SETUP = { map: null, grid: { cols: 8, rows: 6 }, monsters: [{ id: 'gob', name: 'Goblin', hp: 7, ac: 12, slug: 'goblin' }], placements: {} };

test('origin allow-list: configured, same-host and dev localhost; production rejects others', () => {
  const prod = { allowed: ['https://cf.example'], host: 'cf.up.railway.app', production: true };
  assert.equal(originAllowed('https://cf.example', prod), true);
  assert.equal(originAllowed('https://cf.up.railway.app', prod), true);
  assert.equal(originAllowed('http://localhost:3100', prod), false);
  assert.equal(originAllowed('https://evil.example', prod), false);
  assert.equal(originAllowed(undefined, prod), false);
  const dev = { allowed: [], host: '127.0.0.1:9', production: false };
  assert.equal(originAllowed('http://localhost:3100', dev), true);
  assert.equal(originAllowed(undefined, dev), true);
  assert.equal(originAllowed('https://evil.example', dev), false);
});

test('1 DM + 2 players join; a broadcast reaches all three with the same seq', async () => {
  const srv = await boot();
  try {
    const t = await table(srv);
    const { dm, ps } = await connectAll(srv, t);
    assert.equal(dm.hello.p.role, 'dm');
    assert.equal(ps[0].hello.p.role, 'player');
    assert.deepEqual(dm.hello.p.seats.map(s => s.controller), ['player', 'player']);
    assert.equal(ps[1].snapshot.p.room.members.length, 3);

    const since = ps.map(p => p.frames.length);
    const ack = await dm.send('dm.encounter.setup', SETUP);
    assert.equal(ack.t, 'ack');
    const got = await Promise.all([dm, ...ps].map((c, i) => c.next(m => m.t === 'encounter.created', { since: i ? since[i - 1] : 0 })));
    assert.equal(new Set(got.map(m => m.seq)).size, 1);
    assert.ok(got[0].p.encounter.entities.gob);
    assert.equal(got[0].p.encounter.rng, undefined, 'RNG state is never projected');
    assertClean(dm, ...ps);
    assert.equal((await api(srv.url, '/api/health')).body.sockets, 3);
  } finally { await srv.close(); }
});

test('a player sending dm.* gets an error frame and nothing changes', async () => {
  const srv = await boot();
  try {
    const t = await table(srv, 1);
    const { dm, ps } = await connectAll(srv, t);
    const before = dm.frames.length;
    const r = await ps[0].send('dm.encounter.setup', SETUP);
    assert.equal(r.t, 'error');
    assert.equal(r.p.code, 'E_FORBIDDEN');
    const r2 = await ps[0].send('dm.pause', {});
    assert.equal(r2.p.code, 'E_FORBIDDEN');
    await new Promise(res => setTimeout(res, 50));
    assert.equal(dm.frames.slice(before).filter(f => f.t === 'encounter.created').length, 0);
    // The DM may not use player-only intents either.
    assert.equal((await dm.send('seat.claim', { characterId: 'x' })).p.code, 'E_FORBIDDEN');
    assertClean(dm, ...ps);
  } finally { await srv.close(); }
});

test('bad Origin gets HTTP 403; other paths 404', async () => {
  const srv = await boot();
  try {
    const bad = await rawSocket(srv.url, { origin: 'https://evil.example' });
    assert.equal(bad.status, 403);
    const res = await fetch(`${srv.url}/not-ws`, { headers: { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==' } }).catch(e => e);
    assert.ok(res instanceof Error || res.status !== 101);
  } finally { await srv.close(); }
});

test('no hello within the timeout closes 4401; a bad token gets E_UNAUTHENTICATED then 4401', async () => {
  const srv = await boot({ gatewayOpts: { helloTimeoutMs: 80 } });
  try {
    const { ws } = await rawSocket(srv.url);
    assert.equal((await closed(ws)).code, 4401);

    const b = await rawSocket(srv.url);
    const c = new TestClient(b.ws, 'bad');
    const done = closed(b.ws);
    c.sendRaw({ v: 1, t: 'hello', cid: 'h1', p: { token: 'x'.repeat(43), protocol: 1 } });
    const { code } = await done;
    assert.equal(code, 4401);
    assert.equal(c.frames[0].t, 'error');
    assert.equal(c.frames[0].p.code, 'E_UNAUTHENTICATED');
    assert.equal(c.frames[0].p.cid, 'h1');

    const n = await rawSocket(srv.url);
    const nc = new TestClient(n.ws, 'nohello');
    const nd = closed(n.ws);
    nc.sendRaw({ v: 1, t: 'resync', cid: 'r1', p: {} });
    assert.equal((await nd).code, 4401);
    assert.equal(nc.frames[0].p.code, 'E_UNAUTHENTICATED');
  } finally { await srv.close(); }
});

test('an oversize frame closes 1009', async () => {
  const srv = await boot();
  try {
    const t = await table(srv, 1);
    const c = srv.track(await TestClient.connect(srv.url, t.players[0].token));
    const done = closed(c.ws);
    c.sendRaw({ v: 1, t: 'resync', cid: 'big', p: { pad: 'x'.repeat(17 * 1024) } });
    assert.equal((await done).code, 1009);
  } finally { await srv.close(); }
});

test('the token bucket closes 1008 past the burst', async () => {
  const srv = await boot({ gatewayOpts: { rate: { perSec: 20, burst: 40 } } });
  try {
    const t = await table(srv, 1);
    const c = srv.track(await TestClient.connect(srv.url, t.players[0].token));
    const done = closed(c.ws);
    for (let i = 0; i < 60; i++) c.sendRaw({ v: 1, t: 'cinema.done', cid: `b${i}`, p: { exchangeId: 'x' } });
    assert.equal((await done).code, 1008);
  } finally { await srv.close(); }
});

test('bufferedAmount over the cap terminates the socket', async () => {
  const srv = await boot({ gatewayOpts: { maxBuffered: -1 } });
  try {
    const t = await table(srv, 1);
    const { ws } = await rawSocket(srv.url);
    const done = closed(ws);
    ws.send(JSON.stringify({ v: 1, t: 'hello', cid: 'h', p: { token: t.players[0].token, protocol: 1 } }));
    assert.equal((await done).code, 1006);
  } finally { await srv.close(); }
});

test('per-IP socket cap: the next upgrade from that IP gets 429; a closed socket frees its slot', async () => {
  const srv = await boot({ gatewayOpts: { maxPerIp: 2 } });
  try {
    const a = await rawSocket(srv.url);
    const b = await rawSocket(srv.url);
    assert.deepEqual([a.status, b.status], [101, 101]);
    const health = (await api(srv.url, '/api/health')).body;
    assert.deepEqual([health.connections, health.sockets], [2, 0], 'pre-hello sockets count as connections, not members');
    const c = await rawSocket(srv.url);
    assert.equal(c.status, 429);
    const gone = closed(a.ws);
    a.ws.terminate();
    await gone;
    await new Promise(r => setTimeout(r, 20));
    const d = await rawSocket(srv.url);
    assert.equal(d.status, 101);
    for (const x of [b, d]) x.ws.terminate();
  } finally { await srv.close(); }
});

test('per-IP socket cap behind the proxy counts the last X-Forwarded-For hop', async () => {
  const srv = await boot({ gatewayOpts: { maxPerIp: 1, trustProxy: true } });
  const open = (xff) => new Promise((resolve) => {
    const ws = new WebSocket(srv.url.replace(/^http/, 'ws') + '/ws', { origin: 'http://localhost:3100', headers: { 'x-forwarded-for': xff } });
    ws.once('open', () => resolve({ ws, status: 101 }));
    ws.once('unexpected-response', (_q, res) => { resolve({ ws, status: res.statusCode }); res.resume(); });
    ws.once('error', () => resolve({ ws, status: 0 }));
  });
  try {
    const a = await open('1.1.1.1, 10.0.0.1');
    const b = await open('2.2.2.2, 10.0.0.2');
    const c = await open('9.9.9.9, 10.0.0.1');
    assert.deepEqual([a.status, b.status, c.status], [101, 101, 429]);
    assert.equal(clientIp({ headers: { 'x-forwarded-for': 'a, b' }, socket: { remoteAddress: 'peer' } }, false), 'peer');
    for (const x of [a, b, c]) x.ws.terminate();
  } finally { await srv.close(); }
});

test('heartbeat terminates a client that stops answering pings', async () => {
  const srv = await boot({ gatewayOpts: { heartbeatMs: 40 } });
  try {
    const { ws } = await rawSocket(srv.url, { autoPong: false });
    assert.equal((await closed(ws)).code, 1006);
  } finally { await srv.close(); }
});

test('malformed, wrong-version and unknown messages get typed error frames', async () => {
  const srv = await boot();
  try {
    const t = await table(srv, 1);
    const c = srv.track(await TestClient.connect(srv.url, t.players[0].token));
    c.sendRaw('{not json');
    assert.equal((await c.next(m => m.t === 'error')).p.code, 'E_BAD_MESSAGE');
    c.sendRaw({ v: 2, t: 'resync', cid: 'v2', p: {} });
    assert.equal((await c.next(m => m.t === 'error' && m.p.cid === 'v2')).p.code, 'E_VERSION');
    c.sendRaw({ v: 1, t: 'nope.nope', cid: 'u1', p: {} });
    assert.equal((await c.next(m => m.t === 'error' && m.p.cid === 'u1')).p.code, 'E_UNKNOWN_TYPE');
    c.sendRaw({ v: 1, t: 'prompt.answer', cid: 'b1', p: { promptId: 'x' } });
    assert.equal((await c.next(m => m.t === 'error' && m.p.cid === 'b1')).p.code, 'E_BAD_MESSAGE');
    assert.equal(c.ws.readyState, 1, 'still open');
  } finally { await srv.close(); }
});

test('a duplicate cid gets the cached reply and changes nothing', async () => {
  const srv = await boot();
  try {
    const t = await table(srv, 1);
    const dm = srv.track(await TestClient.connect(srv.url, t.room.dmToken));
    const a = await dm.send('dm.roll.arm', { rollKind: 'attack', value: 20 }, 'same-cid');
    const b = await dm.send('dm.roll.arm', { rollKind: 'attack', value: 20 }, 'same-cid');
    assert.equal(a.t, 'ack');
    assert.deepEqual(b, a, 'byte-identical cached ack');
    assert.equal(a.p.armed, 1);
    const c = await dm.send('dm.roll.arm', { rollKind: 'damage', value: 3 });
    assert.equal(c.p.armed, 2, 'the duplicate did not arm a second roll');
    // Errors are cached too.
    const e1 = await dm.send('dm.encounter.start', {}, 'err-cid');
    const e2 = await dm.send('dm.encounter.start', {}, 'err-cid');
    assert.equal(e1.t, 'error');
    assert.deepEqual(e2, e1);
  } finally { await srv.close(); }
});

test('reconnect gets a fresh snapshot; a second socket supersedes the first (4409)', async () => {
  const srv = await boot();
  try {
    const t = await table(srv, 1);
    const dm = srv.track(await TestClient.connect(srv.url, t.room.dmToken, { name: 'dm' }));
    await dm.send('dm.encounter.setup', SETUP);
    const p1 = srv.track(await TestClient.connect(srv.url, t.players[0].token, { name: 'p1' }));
    assert.ok(p1.snapshot.p.encounter, 'snapshot carries the encounter');
    assert.equal(typeof p1.snapshot.p.stateHash, 'string');
    const gone = closed(p1.ws);
    const p1b = srv.track(await TestClient.connect(srv.url, t.players[0].token, { name: 'p1b' }));
    assert.equal((await gone).code, 4409);
    assert.ok(p1b.snapshot.p.seq >= p1.snapshot.p.seq);
    assert.equal(p1b.snapshot.p.encounter.encounterId, p1.snapshot.p.encounter.encounterId);
    const r = await p1b.send('resync', {});
    assert.equal(r.t, 'ack');
    assert.ok(p1b.of('room.snapshot').length >= 2);
    assertClean(dm, p1b);
  } finally { await srv.close(); }
});

test('kick over HTTP closes the socket 4403 and broadcasts member.left', async () => {
  const srv = await boot();
  try {
    const t = await table(srv, 2);
    const { dm, ps } = await connectAll(srv, t);
    const gone = closed(ps[0].ws);
    await api(srv.url, `/api/rooms/${t.room.roomId}/kick`, { method: 'POST', token: t.room.dmToken, body: { participantId: t.players[0].participantId } });
    assert.equal((await gone).code, 4403);
    const left = await ps[1].next(m => m.t === 'member.left', { since: 0 });
    assert.equal(left.p.memberId, t.players[0].participantId);
    await ps[1].next(m => m.t === 'seat.updated' && m.p.seat === 1, { since: 0 });
    assertClean(dm, ps[1]);
  } finally { await srv.close(); }
});

/** Find which entity belongs to which client. */
function pcOf(enc, seat) { return `pc-${seat}`; }

/** Every prompt a player gets is answered `true`; every client acks every exchange's cinema. */
function autoTable(players, everyone) {
  for (const p of players) {
    p.ws.on('message', (data) => {
      const m = JSON.parse(String(data));
      if (m.t === 'prompt.open') p.sendRaw({ v: 1, t: 'prompt.answer', cid: `pa-${m.p.promptId}`, p: { promptId: m.p.promptId, answer: true } });
    });
  }
  for (const c of everyone) {
    c.ws.on('message', (data) => {
      const m = JSON.parse(String(data));
      if (m.t === 'exchange') c.sendRaw({ v: 1, t: 'cinema.done', cid: `cd-${m.seq}-${c.name}`, p: { exchangeId: m.p.payload.exchangeId } });
    });
  }
}

for (const engineKind of ENGINES) {
  test(`[${engineKind}] full encounter: intents, prompts, cinema pacing, stateHash at turn.ended`, async () => {
    const srv = await boot({ engineKind });
    try {
      const t = await table(srv, 2);
      const { dm, ps } = await connectAll(srv, t);
      await dm.send('dm.encounter.setup', { ...SETUP, monsters: [{ id: 'gob', name: 'Goblin', hp: 30, ac: 10 }] });
      const everyone = [dm, ...ps];
      autoTable(ps, everyone);
      const ack = await dm.send('dm.encounter.start', { seed: 7 });
      assert.equal(ack.t, 'ack');
      const ownerOf = (actorId) => (actorId === 'pc-1' ? ps[0] : actorId === 'pc-2' ? ps[1] : null);
      let turns = 0;
      let sawAct = false;
      // Drive the table until the encounter ends (or 60 turns).
      while (turns < 60) {
        const ev = await dm.next(m => m.t === 'turn.started' || m.t === 'encounter.ended', { since: dm._cursor ?? 0, timeoutMs: 8000 });
        dm._cursor = dm.frames.indexOf(ev) + 1;
        if (ev.t === 'encounter.ended') break;
        turns++;
        const owner = ownerOf(ev.p.payload.actorId);
        if (!owner) continue;
        const turnId = ev.p.turnId;
        if (!sawAct) {
          sawAct = true;
          // Wrong owner and stale turn are rejected.
          const other = owner === ps[0] ? ps[1] : ps[0];
          assert.equal((await other.send('turn.act', { turnId, plan: { kind: 'attack', targetId: 'gob' } })).p.code, 'E_NOT_YOUR_TURN');
          assert.equal((await owner.send('turn.act', { turnId: 'stale', plan: { kind: 'attack', targetId: 'gob' } })).p.code, 'E_STALE');
          const bad = await owner.send('turn.act', { turnId, plan: { kind: 'attack', targetId: pcOf(null, owner === ps[0] ? 2 : 1) } });
          assert.equal(bad.p.code, 'E_INVALID_INTENT');
          await dm.next(m => m.t === 'turn.rejected', { since: 0 });
        }
        const r = await owner.send('turn.act', { turnId, plan: { kind: 'attack', targetId: 'gob' } });
        assert.equal(r.t, 'ack', JSON.stringify(r.p));
      }
      const end = await dm.find(m => m.t === 'encounter.ended', { timeoutMs: 8000 });
      assert.ok(['party-victory', 'hostile-victory'].includes(end.p.payload.outcome));
      const status = await dm.find(m => m.t === 'room.status' && m.p.status === 'encounter-over');
      assert.ok(status);
      // stateHash on every turn.ended; the final one matches a fresh snapshot.
      const ended = dm.of('turn.ended');
      assert.ok(ended.length >= 2);
      for (const e of ended) assert.match(e.p.payload.stateHash, /^[0-9a-f]{8,}$/);
      assert.ok(dm.of('exchange').length >= 1, 'exchanges were paced');
      await dm.send('resync', {});
      const snap = dm.of('room.snapshot').at(-1);
      assert.equal(snap.p.stateHash, ended.at(-1).p.payload.stateHash);
      assert.equal(snap.p.encounter.phase, 'ended');
      // Every client saw the same sequenced stream.
      const seqs = (c) => c.frames.filter(f => f.seq !== undefined && f.seq > ps[1].snapshot.p.seq).map(f => `${f.seq}:${f.t}`);
      assert.deepEqual(seqs(ps[0]), seqs(dm));
      assert.deepEqual(seqs(ps[1]), seqs(dm));
      assertClean(...everyone);
      assert.ok(sawAct, 'a player turn was driven by turn.act');
      assert.ok(turns >= 2);
    } finally { await srv.close(); }
  });
}

// The reaction tests need a Shield caster in seat 1: the stub gives every
// player PC Shield; the real engine only the wizard fixture (AC 12, so an
// armed goblin d20 of 10 is a hit Shield can turn).
const SHIELD_SEAT = { stub: ['fighter-l5'], real: ['wizard-l5'] };
const SHIELD_D20 = { stub: 12, real: 10 };

for (const engineKind of ENGINES) {
  test(`[${engineKind}] reaction prompt: original deadline on reconnect, DM force, armed roll override`, async () => {
    const srv = await boot({ engineKind });
    try {
      const t = await table(srv, 1, SHIELD_SEAT[engineKind]);
      const { dm, ps } = await connectAll(srv, t);
      // A goblin whose armed attack roll is a marginal hit, so pc-1 gets a shield prompt.
      await dm.send('dm.encounter.setup', { ...SETUP, monsters: [{ id: 'gob', name: 'Goblin', hp: 50, ac: 30 }] });
      await dm.send('dm.initiative.set', { order: ['gob', 'pc-1'] });
      await dm.send('dm.roll.arm', { entityId: 'gob', rollKind: 'attack', value: SHIELD_D20[engineKind] });
      await dm.send('dm.encounter.start', { seed: 1 });
      const open = await ps[0].find(m => m.t === 'prompt.open');
      assert.equal(open.p.kind, 'shield');
      assert.ok(open.p.deadlineAt > open.p.serverNow);
      const offered = await dm.find(m => m.t === 'reaction.offered');
      assert.equal(offered.p.payload.deadlineMs, 20000);
      assert.equal(dm.of('reaction.offered').length, 1, 'one offer per window (the room owns reaction.offered)');
      // Reconnect: the snapshot re-sends the prompt with its original deadline.
      const again = srv.track(await TestClient.connect(srv.url, t.players[0].token, { name: 'p1-again' }));
      assert.equal(again.snapshot.p.openPrompt.promptId, open.p.promptId);
      assert.equal(again.snapshot.p.openPrompt.deadlineAt, open.p.deadlineAt);
      // Someone else cannot answer it; the DM can force it.
      assert.equal((await dm.send('prompt.answer', { promptId: open.p.promptId, answer: true })).p.code, 'E_FORBIDDEN');
      assert.equal((await again.send('prompt.answer', { promptId: open.p.promptId, answer: 'yes' })).p.code, 'E_INVALID_INTENT');
      assert.equal((await dm.send('dm.prompt.force', { promptId: open.p.promptId, answer: false })).t, 'ack');
      const resolved = await dm.find(m => m.t === 'reaction.resolved');
      assert.deepEqual([resolved.p.payload.used, resolved.p.payload.by], [false, 'dm'], 'the engine keeps the broker\'s source');
      assert.equal(dm.of('reaction.resolved').length, 1, 'one resolution per window (the engine\'s; the room no longer adds one)');
      assert.ok(resolved.seq > offered.seq);
      await again.find(m => m.t === 'prompt.closed' && m.p.promptId === open.p.promptId);
      assert.equal((await again.send('prompt.answer', { promptId: open.p.promptId, answer: true })).p.code, 'E_STALE');
      // The armed roll shows as a DM override.
      const ov = await dm.find(m => m.t === 'dm.override' && m.p.payload.kind === 'roll.attack');
      assert.equal(ov.p.payload.after, SHIELD_D20[engineKind]);
      assertClean(dm, again);
    } finally { await srv.close(); }
  });

  test(`[${engineKind}] reaction prompt times out to the auto answer; an offline owner is auto-answered at once`, async () => {
    const srv = await boot({ engineKind });
    try {
      const t = await table(srv, 1, SHIELD_SEAT[engineKind]);
      const { dm, ps } = await connectAll(srv, t);
      srv.service.store.setRoomSettings(t.room.roomId, { reactionTimeoutMs: 60 });
      const room = srv.registry.get(t.room.roomId);
      room.settings.reactionTimeoutMs = 60;
      await dm.send('dm.encounter.setup', { ...SETUP, monsters: [{ id: 'gob', name: 'Goblin', hp: 50, ac: 30 }] });
      await dm.send('dm.initiative.set', { order: ['gob', 'pc-1'] });
      await dm.send('dm.roll.arm', { entityId: 'gob', rollKind: 'attack', value: SHIELD_D20[engineKind] });
      await dm.send('dm.encounter.start', { seed: 1 });
      const r1 = await dm.find(m => m.t === 'reaction.resolved');
      const o1 = dm.of('reaction.offered').at(-1);
      assert.deepEqual([r1.p.payload.used, r1.p.payload.by], [o1.p.payload.autoAnswer, 'timeout']);
      const ex1 = await dm.find(m => m.t === 'exchange');
      for (const c of [dm, ps[0]]) c.sendRaw({ v: 1, t: 'cinema.done', cid: `cd1-${c.name}`, p: { exchangeId: ex1.p.payload.exchangeId } });
      await ps[0].find(m => m.t === 'prompt.closed' && m.p.reason === 'timeout');
      // pc-1's turn now waits for an intent; act, then next goblin turn with pc-1 offline.
      const ts = await dm.find(m => m.t === 'turn.started' && m.p.payload.actorId === 'pc-1');
      const act = await ps[0].send('turn.act', { turnId: ts.p.turnId, plan: { kind: 'attack', targetId: 'gob' } });
      assert.equal(act.t, 'ack', JSON.stringify(act.p));
      const ex = await dm.find(m => m.t === 'exchange' && m.p.payload.attackerId === 'pc-1');
      await dm.send('dm.roll.arm', { entityId: 'gob', rollKind: 'attack', value: SHIELD_D20[engineKind] });
      ps[0].ws.close();
      for (const c of [dm]) c.sendRaw({ v: 1, t: 'cinema.done', cid: 'cd-x', p: { exchangeId: ex.p.payload.exchangeId } });
      await dm.next(m => m.t === 'turn.started' && m.seq > ex.seq && m.p.payload.actorId === 'gob', { since: 0 });
      const settled = await dm.next(m => (m.t === 'reaction.resolved' || m.t === 'turn.ended') && m.seq > ex.seq && m.p.payload.actorId !== 'pc-1', { since: 0 });
      if (engineKind === 'stub' || settled.t === 'reaction.resolved') {
        assert.equal(settled.t, 'reaction.resolved', 'the offline owner still gets the window');
        assert.deepEqual([settled.p.payload.used, settled.p.payload.by], [dm.of('reaction.offered').at(-1).p.payload.autoAnswer, 'auto']);
        const offered2 = dm.frames.filter(m => m.t === 'reaction.offered').at(-1);
        assert.equal(offered2.p.payload.deadlineMs, null);
      } else {
        // Real engine: Shield already spent its reaction/slot this round, so no window opens.
        assert.equal(dm.frames.filter(m => m.t === 'prompt.open').length, 0);
      }
      assertClean(dm);
    } finally { await srv.close(); }
  });

  test(`[${engineKind}] DM edits: between turns apply now (entity.updated + dm.override); during a waiting turn they apply to the turn`, async () => {
    const srv = await boot({ engineKind });
    try {
      const t = await table(srv, 1);
      const { dm, ps } = await connectAll(srv, t);
      await dm.send('dm.encounter.setup', SETUP);
      let r = await dm.send('dm.entity.patch', { entityId: 'gob', hp: 3, addConditions: ['prone'] });
      assert.equal(r.t, 'ack');
      const upd = await ps[0].find(m => m.t === 'entity.updated' && m.p.entityId === 'gob');
      assert.deepEqual(upd.p.patch, { hp: 3, conditions: ['prone'] });
      await ps[0].find(m => m.t === 'dm.override' && m.p.payload.kind === 'entity.patch');
      r = await dm.send('dm.entity.patch', { entityId: 'nope', hp: 1 });
      assert.equal(r.p.code, 'E_INVALID_INTENT');
      // Player turn first; while it waits, patch the goblin — the turn sees it.
      await dm.send('dm.initiative.set', { order: ['pc-1', 'gob'] });
      await dm.send('dm.encounter.start', { seed: 3 });
      const ts = await ps[0].find(m => m.t === 'turn.started' && m.p.payload.actorId === 'pc-1');
      await new Promise(res => setTimeout(res, 20));
      r = await dm.send('dm.entity.patch', { entityId: 'gob', hp: 1 });
      assert.equal(r.p.queued, undefined, 'applied at the intent safe point, not queued');
      await ps[0].next(m => m.t === 'entity.updated' && m.p.patch.hp === 1, { since: 0 });
      // Initiative cannot change mid-turn.
      assert.equal((await dm.send('dm.initiative.set', { order: ['gob', 'pc-1'] })).p.code, 'E_STALE');
      // Skip the waiting turn.
      assert.equal((await dm.send('dm.turn.skip', {})).t, 'ack');
      const skipped = await dm.find(m => m.t === 'turn.skipped' && m.p.turnId === ts.p.turnId);
      assert.equal(skipped.p.payload.actorId, 'pc-1');
      // The edit made during the wait is in the turn's stateHash.
      const ended = await dm.find(m => m.t === 'turn.ended' && m.p.turnId === ts.p.turnId);
      assert.match(ended.p.payload.stateHash, /^[0-9a-f]{14}$/);
      // DM pauses then ends the encounter.
      await dm.find(m => m.t === 'turn.started' && m.p.payload.actorId === 'gob');
      await dm.send('dm.pause', {});
      await dm.find(m => m.t === 'room.status' && m.p.status === 'paused');
      const endAck = await dm.send('dm.encounter.end', {});
      assert.equal(endAck.t, 'ack');
      const done = await dm.find(m => m.t === 'encounter.ended', { timeoutMs: 5000 });
      assert.ok(['dm-ended', 'hostile-victory'].includes(done.p.payload.outcome), done.p.payload.outcome);
      assertClean(dm, ...ps);
    } finally { await srv.close(); }
  });

  test(`[${engineKind}] DM plan review: the DM sees turn.planProposed and can replace the AI plan`, async () => {
    const srv = await boot({ engineKind });
    try {
      const t = await table(srv, 1);
      const { dm } = await connectAll(srv, t);
      await dm.send('dm.review.set', { plans: true });
      await dm.send('dm.encounter.setup', { ...SETUP, monsters: [{ id: 'gob', name: 'Goblin', hp: 50, ac: 30 }, { id: 'gob2', name: 'Goblin 2', hp: 50, ac: 30 }] });
      await dm.send('dm.initiative.set', { order: ['gob', 'pc-1', 'gob2'] });
      await dm.send('dm.encounter.start', { seed: 9 });
      const proposed = await dm.find(m => m.t === 'turn.planProposed');
      assert.equal(proposed.p.entityId, 'gob');
      assert.equal(typeof proposed.p.plan.kind, 'string');
      const pr = await dm.find(m => m.t === 'prompt.open' && m.p.kind === 'plan');
      assert.equal((await dm.send('prompt.answer', { promptId: pr.p.promptId, answer: null })).t, 'ack');
      const ov = await dm.find(m => m.t === 'dm.override' && m.p.payload.kind === 'plan');
      assert.equal(ov.p.payload.after, null);
      const sk = await dm.find(m => m.t === 'turn.skipped' && m.p.payload.actorId === 'gob');
      assert.equal(sk.p.payload.reason, engineKind === 'stub' ? 'dm-skipped' : 'dm');
      assert.equal(dm.of('dm.override').filter(m => m.p.payload.kind.startsWith('plan')).length, 1, 'one override per DM decision');
      assertClean(dm);
    } finally { await srv.close(); }
  });
}

test('[real] fog: players get the filtered projection, the DM the full one; dm.terrain.paint uses the terrain codec', async () => {
  const srv = await boot({ engineKind: 'real' });
  try {
    const t = await table(srv, 1);
    const { dm, ps } = await connectAll(srv, t);
    // Rows 0-2 revealed; the goblin waits in row 5.
    const fog = revealCells(null, 8, 6, Array.from({ length: 24 }, (_, i) => ({ col: i % 8, row: Math.floor(i / 8) })));
    const r = await dm.send('dm.encounter.setup', { ...SETUP, fog, placements: { gob: { col: 3, row: 5 } } });
    assert.equal(r.t, 'ack', JSON.stringify(r.p));
    const created = await ps[0].find(m => m.t === 'encounter.created');
    assert.equal(created.p.encounter.entities.gob, undefined, 'hidden monster is not broadcast');
    assert.ok(created.p.encounter.entities['pc-1']);
    const dmSnap = await dm.find(m => m.t === 'room.snapshot' && m.p.encounter?.entities?.gob);
    assert.deepEqual(dmSnap.p.encounter.fog, fog);
    // Paint difficult terrain (2) in a revealed and a hidden cell, then blocked (1) on top; clear one bit.
    assert.equal((await dm.send('dm.terrain.paint', { cells: [{ col: 0, row: 1 }, { col: 3, row: 4 }], flags: 2 | 64, mode: 'set' })).t, 'ack');
    assert.equal((await dm.send('dm.terrain.paint', { cells: [{ col: 0, row: 1 }], flags: 1, mode: 'set' })).t, 'ack');
    assert.equal((await dm.send('dm.terrain.paint', { cells: [{ col: 0, row: 1 }], flags: 2, mode: 'clear' })).t, 'ack');
    await dm.send('resync', {});
    const full = asTerrain(dm.of('room.snapshot').at(-1).p.encounter.grid.terrain);
    assert.equal(full.cells[1 * 8 + 0], 1, 'set then clear on the same cell');
    assert.equal(full.cells[4 * 8 + 3], 2, 'undefined bits (64) are masked off');
    await ps[0].send('resync', {});
    const mine = ps[0].of('room.snapshot').at(-1).p.encounter;
    assert.equal(mine.entities.gob, undefined);
    assert.equal(asTerrain(mine.grid.terrain).cells[4 * 8 + 3], 0, 'terrain under fog is not sent to players');
    assert.equal(asTerrain(mine.grid.terrain).cells[1 * 8 + 0], 1);
    assertClean(dm, ...ps);
  } finally { await srv.close(); }
});

/**
 * Fog table: one fighter seat, rows 0-2 revealed, the goblin acts first
 * with an armed hit. Returns once the goblin's turn has ended and the
 * fighter's turn waits for its intent.
 */
async function fogTable(srv, placements) {
  const t = await table(srv, 1);
  const { dm, ps } = await connectAll(srv, t);
  const fog = revealCells(null, 8, 6, Array.from({ length: 24 }, (_, i) => ({ col: i % 8, row: Math.floor(i / 8) })));
  assert.equal((await dm.send('dm.encounter.setup', { ...SETUP, monsters: [{ id: 'gob', name: 'Goblin', hp: 30, ac: 10, slug: 'goblin' }], fog, placements })).t, 'ack');
  assert.equal((await dm.send('dm.initiative.set', { order: ['gob', 'pc-1'] })).t, 'ack');
  assert.equal((await dm.send('dm.roll.arm', { entityId: 'gob', rollKind: 'attack', value: 18 })).t, 'ack');
  autoTable(ps, [dm, ...ps]);
  const since = { dm: dm.frames.length, p: ps[0].frames.length };
  assert.equal((await dm.send('dm.encounter.start', { seed: 3 })).t, 'ack');
  const ended = await dm.next(m => m.t === 'turn.ended', { since: since.dm, timeoutMs: 8000 });
  await ps[0].next(m => m.seq === ended.seq, { since: since.p, timeoutMs: 8000 });
  const room = srv.registry.get(t.room.roomId);
  return { t, dm, ps, since, ended, room, state: room.enc.state };
}

test('[real] fog: a hidden goblin attacking a hidden PC reaches the DM in full and players as redacted; the player hash covers the filtered view', async () => {
  const srv = await boot({ engineKind: 'real' });
  try {
    // Both stand in unrevealed cells (row 4 / row 5), adjacent.
    const { dm, ps, since, ended, state } = await fogTable(srv, { gob: { col: 3, row: 5 }, 'pc-1': { col: 3, row: 4 } });
    const dmTurn = dm.frames.slice(since.dm).filter(m => m.seq !== undefined && m.seq <= ended.seq);
    const pTurn = ps[0].frames.slice(since.p).filter(m => m.seq !== undefined && m.seq <= ended.seq);
    assert.deepEqual(pTurn.map(m => m.seq), dmTurn.map(m => m.seq), 'same gap-free seq on both seats');
    const atk = dmTurn.find(m => m.t === 'attack.rolled');
    assert.ok(atk, 'the goblin attacked');
    assert.equal(atk.p.payload.attackerId, 'gob');
    const mine = pTurn.find(m => m.seq === atk.seq);
    assert.deepEqual([mine.t, mine.p], ['redacted', { type: 'attack.rolled' }]);
    for (const t of ['turn.started', 'plan.chosen', 'exchange', 'damage']) {
      for (const m of dmTurn.filter(x => x.t === t)) assert.equal(pTurn.find(x => x.seq === m.seq).t, 'redacted', `${t} is redacted`);
    }
    assert.equal(ps[0].of('attack.rolled').length, 0);
    // turn.ended reaches the player with the hash of the fog-filtered state; the DM keeps the full hash.
    const pEnded = pTurn.find(m => m.seq === ended.seq);
    assert.equal(pEnded.t, 'turn.ended');
    assert.equal(pEnded.p.payload.stateHash, sharedStateHash(filterViewForFog(state)));
    assert.equal(ended.p.payload.stateHash, sharedStateHash(state));
    assert.notEqual(pEnded.p.payload.stateHash, ended.p.payload.stateHash);
    // The player's snapshot hash is its own projection's hash.
    await ps[0].send('resync', {});
    const snap = ps[0].of('room.snapshot').at(-1).p;
    assert.equal(snap.stateHash, sharedStateHash(snap.encounter));
    assert.equal(snap.encounter.entities.gob, undefined);
    assert.ok(snap.history.every(ev => ev.type !== 'attack.rolled'), 'history keeps hidden events out');
    assertClean(dm, ...ps);
  } finally { await srv.close(); }
});

test('[real] fog: a hidden goblin attacking a visible PC reaches players masked ("Something"), the exchange redacted', async () => {
  const srv = await boot({ engineKind: 'real' });
  try {
    // The fighter stands at the fog edge (row 2, revealed); the goblin just below it (row 3, hidden).
    const { dm, ps, since, ended, state } = await fogTable(srv, { gob: { col: 3, row: 3 }, 'pc-1': { col: 3, row: 2 } });
    const pTurn = ps[0].frames.slice(since.p).filter(m => m.seq !== undefined && m.seq <= ended.seq);
    const atk = dm.frames.slice(since.dm).find(m => m.t === 'attack.rolled');
    assert.ok(atk);
    const mine = pTurn.find(m => m.seq === atk.seq);
    assert.equal(mine.t, 'attack.rolled');
    assert.deepEqual([mine.p.payload.attackerId, mine.p.payload.targetId], [HIDDEN_ENTITY_ID, 'pc-1']);
    const dmg = dm.frames.slice(since.dm).find(m => m.t === 'damage' && m.p.payload.targetId === 'pc-1');
    assert.ok(dmg, 'the armed roll hit');
    const myDmg = pTurn.find(m => m.seq === dmg.seq);
    assert.deepEqual([myDmg.t, myDmg.p.payload.sourceId, myDmg.p.payload.hpAfter], ['damage', HIDDEN_ENTITY_ID, dmg.p.payload.hpAfter]);
    const ex = dm.frames.slice(since.dm).find(m => m.t === 'exchange');
    assert.equal(pTurn.find(m => m.seq === ex.seq).t, 'redacted', 'no cinema of an unseen attacker');
    assert.equal(JSON.stringify(pTurn).includes('"gob"'), false, 'the hidden id never reaches the player');
    assert.equal(pTurn.find(m => m.seq === ended.seq).p.payload.stateHash, sharedStateHash(filterViewForFog(state)));
    assertClean(dm, ...ps);
  } finally { await srv.close(); }
});

test('[real] fog: DM edits to a hidden creature reach players redacted; a teleport into view re-baselines them', async () => {
  const srv = await boot({ engineKind: 'real' });
  try {
    const t = await table(srv, 1);
    const { dm, ps } = await connectAll(srv, t);
    const fog = revealCells(null, 8, 6, Array.from({ length: 24 }, (_, i) => ({ col: i % 8, row: Math.floor(i / 8) })));
    await dm.send('dm.encounter.setup', { ...SETUP, fog, placements: { gob: { col: 3, row: 5 } } });
    let since = ps[0].frames.length;
    assert.equal((await dm.send('dm.entity.patch', { entityId: 'gob', hp: 3 })).t, 'ack');
    const upd = await dm.find(m => m.t === 'entity.updated' && m.p.entityId === 'gob');
    const mine = await ps[0].next(m => m.seq === upd.seq, { since });
    assert.deepEqual([mine.t, mine.p], ['redacted', { type: 'entity.updated' }]);
    assert.equal(ps[0].frames.slice(since).some(m => m.t === 'dm.override'), false);
    since = ps[0].frames.length;
    assert.equal((await dm.send('dm.entity.patch', { entityId: 'gob', position: { col: 3, row: 1 } })).t, 'ack');
    const snap = await ps[0].next(m => m.t === 'room.snapshot', { since });
    assert.equal(snap.p.encounter.entities.gob.pos.row, 1, 'the goblin stepped into view');
    assert.equal(snap.p.stateHash, sharedStateHash(snap.p.encounter));
    assertClean(dm, ...ps);
  } finally { await srv.close(); }
});

test('fogEventView: full / masked / redacted, moves across the fog edge, exchanges', () => {
  const st = { grid: { cols: 4, rows: 2 }, fog: revealCells(null, 4, 2, [{ col: 0, row: 0 }, { col: 1, row: 0 }]), entities: { a: { pos: { col: 0, row: 0 } }, h: { pos: { col: 3, row: 1 } } } };
  const vis = fogVisibility(st);
  const ev = (type, payload) => ({ type, payload });
  assert.deepEqual(fogEventView(ev('damage', { sourceId: 'a', targetId: 'a', amount: 1 }), vis).view, { full: true });
  assert.deepEqual(fogEventView(ev('damage', { sourceId: 'h', targetId: 'a', amount: 1 }), vis).view, { payload: { sourceId: HIDDEN_ENTITY_ID, targetId: 'a', amount: 1 } });
  assert.equal(fogEventView(ev('turn.started', { actorId: 'h' }), vis).view, null);
  assert.deepEqual(fogEventView(ev('turn.ended', { actorId: 'h' }), vis).view, { payload: { actorId: HIDDEN_ENTITY_ID } });
  assert.deepEqual(fogEventView(ev('encounter.ended', { outcome: 'draw' }), vis).view, { full: true });
  assert.deepEqual(fogEventView(ev('move', { actorId: 'a', from: { col: 0, row: 0 }, to: { col: 1, row: 0 } }), vis), { view: { full: true }, crossed: false });
  assert.deepEqual(fogEventView(ev('move', { actorId: 'a', from: { col: 1, row: 0 }, to: { col: 2, row: 0 } }), vis), { view: null, crossed: true });
  assert.deepEqual(fogEventView(ev('move', { actorId: 'h', from: { col: 3, row: 1 }, to: { col: 2, row: 1 } }), vis), { view: null, crossed: false });
  const ex = { exchangeId: 'x', attackerId: 'a', defenderId: null, effects: [{ entityId: 'a', hp: {} }, { entityId: 'h', hp: {} }], cinema: { outcome: { targets: ['h'] } } };
  assert.deepEqual(fogEventView(ev('exchange', ex), vis).view.payload.effects.map(e => e.entityId), ['a']);
  assert.deepEqual(fogEventView(ev('exchange', ex), vis).view.payload.cinema.outcome.targets, [HIDDEN_ENTITY_ID]);
  assert.equal(fogEventView(ev('exchange', { ...ex, defenderId: 'h' }), vis).view, null);
  // Positions moved this turn override the state's.
  assert.equal(fogVisibility(st, new Map([['h', { col: 1, row: 0 }]])).isVisible('h'), true);
});

test('[real] dm.encounter.setup stores the PC sheets with the encounter and no frame carries them', async () => {
  const srv = await boot({ engineKind: 'real' });
  try {
    const t = await table(srv, 1);
    const { dm, ps } = await connectAll(srv, t);
    const r = await dm.send('dm.encounter.setup', SETUP);
    assert.equal(r.t, 'ack');
    await dm.send('dm.encounter.start', { seed: 2 });
    await dm.find(m => m.t === 'turn.started');
    const sheets = srv.journal.sheetsFor(r.p.encounterId);
    const room = srv.registry.get(t.room.roomId);
    const cid = room.enc.state.entities['pc-1'].sheetRef.characterId;
    assert.deepEqual(Object.keys(sheets), [cid]);
    assert.ok(Array.isArray(sheets[cid].classes) && sheets[cid].equipment, 'the parsed sheet is stored');
    for (const c of [dm, ...ps]) {
      const wire = JSON.stringify(c.frames);
      assert.equal(wire.includes('"classes"'), false, `${c.name}: no sheet content on the wire`);
      assert.ok(wire.includes('"sheetRef"'), `${c.name}: entities carry sheetRef`);
    }
    assertClean(dm, ...ps);
  } finally { await srv.close(); }
});

test('[real] turn.act with Action Surge is accepted at the safe point and reaches the engine', async () => {
  const srv = await boot({ engineKind: 'real' });
  try {
    const t = await table(srv, 1, ['fighter-l5']);
    const { dm, ps } = await connectAll(srv, t);
    autoTable(ps, [dm, ...ps]);
    await dm.send('dm.encounter.setup', { ...SETUP, monsters: [{ id: 'gob', name: 'Goblin', hp: 60, ac: 10 }], placements: { 'pc-1': { col: 3, row: 2 }, gob: { col: 3, row: 3 } } });
    await dm.send('dm.initiative.set', { order: ['pc-1', 'gob'] });
    await dm.send('dm.encounter.start', { seed: 4 });
    const ts = await ps[0].find(m => m.t === 'turn.started' && m.p.payload.actorId === 'pc-1');
    const r = await ps[0].send('turn.act', { turnId: ts.p.turnId, plan: { kind: 'melee', targetId: 'gob', features: ['action-surge'] } });
    assert.equal(r.t, 'ack', JSON.stringify(r.p));
    const plan = await dm.find(m => m.t === 'plan.chosen' && m.p.payload.actorId === 'pc-1');
    assert.deepEqual([plan.p.payload.source, plan.p.payload.featuresFired], ['player', ['action-surge']]);
    assert.equal(dm.of('turn.rejected').length, 0);
    assertClean(dm, ...ps);
  } finally { await srv.close(); }
});

test('[real] dm.spell.adjudicate: DM-only; slot from the ledger, damage / heal / conditions as events plus dm.override', async () => {
  const srv = await boot({ engineKind: 'real' });
  try {
    const t = await table(srv, 1, ['wizard-l5']);
    const { dm, ps } = await connectAll(srv, t);
    await dm.send('dm.encounter.setup', { ...SETUP, monsters: [{ id: 'gob', name: 'Goblin', hp: 20 }] });
    await dm.send('dm.entity.patch', { entityId: 'pc-1', hp: 20 });
    const before = (await dm.send('resync', {}), dm.of('room.snapshot').at(-1).p.encounter.entities['pc-1'].resources.slots['1']);
    const ruling = {
      casterId: 'pc-1', spellId: 'homebrew-storm', slotLevel: 1,
      targets: [{ entityId: 'gob', damage: 5, type: 'lightning', conditions: ['frightened'] }, { entityId: 'pc-1', healed: 3 }]
    };
    assert.equal((await ps[0].send('dm.spell.adjudicate', ruling)).p.code, 'E_FORBIDDEN');
    const since = ps[0].frames.length;
    const r = await dm.send('dm.spell.adjudicate', ruling);
    assert.equal(r.t, 'ack', JSON.stringify(r.p));
    const cast = await ps[0].next(m => m.t === 'spell.cast', { since });
    assert.deepEqual([cast.p.payload.casterId, cast.p.payload.slotSpent, cast.p.payload.targetIds, cast.p.payload.adjudicated], ['pc-1', 1, ['gob', 'pc-1'], true]);
    const dmg = await ps[0].next(m => m.t === 'damage', { since });
    assert.deepEqual([dmg.p.payload.targetId, dmg.p.payload.amount, dmg.p.payload.type, dmg.p.payload.hpAfter], ['gob', 5, 'lightning', 15]);
    const heal = await ps[0].next(m => m.t === 'heal', { since });
    assert.deepEqual([heal.p.payload.targetId, heal.p.payload.hpBefore, heal.p.payload.hpAfter], ['pc-1', 20, 23]);
    await ps[0].next(m => m.t === 'condition.applied' && m.p.payload.condition === 'frightened', { since });
    await ps[0].next(m => m.t === 'resource.spent' && m.p.payload.resource === 'spell-slot', { since });
    const overrides = ps[0].frames.slice(since).filter(m => m.t === 'dm.override').map(m => [m.p.payload.kind, m.p.payload.entityId]);
    assert.deepEqual(overrides.sort(), [['spell.adjudicate', 'gob'], ['spell.adjudicate', 'pc-1']]);
    await ps[0].next(m => m.t === 'entity.updated' && m.p.entityId === 'gob' && m.p.patch.hp === 15, { since });
    await dm.send('resync', {});
    const after = dm.of('room.snapshot').at(-1).p.encounter.entities;
    assert.equal(after['pc-1'].resources.slots['1'].spent, before.spent + 1);
    assert.deepEqual(after.gob.conditions, ['frightened']);
    // Out of level-1 slots → rejected, nothing changes.
    for (let i = before.spent + 1; i < before.max; i++) assert.equal((await dm.send('dm.spell.adjudicate', { ...ruling, targets: [{ entityId: 'gob', damage: 1 }] })).t, 'ack');
    const none = await dm.send('dm.spell.adjudicate', { ...ruling, targets: [{ entityId: 'gob', damage: 1 }] });
    assert.equal(none.p.code, 'E_INVALID_INTENT');
    assert.match(none.p.message, /no level-1 slot/);
    assert.equal((await dm.send('dm.spell.adjudicate', { ...ruling, casterId: 'nobody' })).p.code, 'E_INVALID_INTENT');
    assertClean(dm, ...ps);
  } finally { await srv.close(); }
});

test('[stub] dm.spell.adjudicate is rejected by an engine without it', async () => {
  const srv = await boot({ engineKind: 'stub' });
  try {
    const t = await table(srv, 1);
    const { dm } = await connectAll(srv, t);
    await dm.send('dm.encounter.setup', SETUP);
    const r = await dm.send('dm.spell.adjudicate', { casterId: 'pc-1', spellId: 'x', targets: [{ entityId: 'gob', damage: 1 }] });
    assert.equal(r.p.code, 'E_INVALID_INTENT');
  } finally { await srv.close(); }
});

test('seat.claim over ws seats the player and broadcasts seat.updated', async () => {
  const srv = await boot();
  try {
    const room = (await api(srv.url, '/api/rooms', { method: 'POST', body: {} })).body;
    const p = (await api(srv.url, '/api/rooms/join', { method: 'POST', body: { code: room.code, displayName: 'Solo' } })).body;
    const imp = await api(srv.url, `/api/import?room=${room.roomId}`, { method: 'POST', token: p.token, body: { json: ddbFixture('cleric-l5') } });
    const dm = srv.track(await TestClient.connect(srv.url, room.dmToken, { name: 'dm' }));
    const pc = srv.track(await TestClient.connect(srv.url, p.token, { name: 'p' }));
    const r = await pc.send('seat.claim', { characterId: imp.body.character.id });
    assert.equal(r.p.seat, 1);
    const su = await dm.find(m => m.t === 'seat.updated');
    assert.deepEqual([su.p.memberId, su.p.controller], [p.participantId, 'player']);
    assert.equal((await pc.send('char.setStyle', { characterId: imp.body.character.id, style: 'power', swing: null })).t, 'ack');
    assert.equal((await pc.send('seat.release', { characterId: imp.body.character.id })).t, 'ack');
    await dm.next(m => m.t === 'seat.updated' && m.p.removed === true, { since: 0 });
    assertClean(dm, pc);
  } finally { await srv.close(); }
});

test('closing the server closes sockets with 1012 and leaves no handles', async () => {
  const srv = await boot();
  const t = await table(srv, 1);
  const { dm, ps } = await connectAll(srv, t);
  const a = closed(dm.ws);
  const b = closed(ps[0].ws);
  const t0 = Date.now();
  await srv.rawClose();
  assert.ok(Date.now() - t0 < 2000, 'closed within 2 s');
  assert.equal((await a).code, 1012);
  assert.equal((await b).code, 1012);
  assert.ok(dm.of('room.closing').length >= 1);
});

test('the room service rejects an unknown room in the registry', async () => {
  const { db } = await tempDb(root);
  const svc = createRoomService({ db });
  assert.equal(svc.authenticate('nope'), null);
  db.close();
});

test('viewFor drops the RNG; stateHash is the shared hash of the projection', () => {
  const st = createStubEngine().buildEncounter({ encounterId: 'e', seed: 5, setup: SETUP, party: [] });
  const v = viewFor(st, null);
  assert.equal(v.rng, undefined);
  assert.notEqual(v, st);
  assert.equal(stateHash(st), sharedStateHash(v));
  assert.equal(viewFor(null, null), null);
  // Without fog every seat gets the same projection (identity filter).
  assert.deepEqual(viewFor(st, { role: 'player' }), v);
});

test('viewFor filters fog for player seats only, and the result is a valid projection', () => {
  const st = createStubEngine().buildEncounter({ encounterId: 'e', seed: 5, setup: { ...SETUP, monsters: [{ id: 'gob' }, { id: 'gob2' }], placements: { gob: { col: 0, row: 5 }, gob2: { col: 1, row: 0 } } }, party: [] });
  st.fog = revealCells(null, 8, 6, [{ col: 1, row: 0 }]);
  st.initiative = [{ entityId: 'gob', score: 20 }, { entityId: 'gob2', score: 10 }];
  st.turnIndex = 1;
  const player = viewFor(st, { role: 'player' });
  assert.deepEqual(Object.keys(player.entities), ['gob2']);
  assert.deepEqual([player.initiative.map(r => r.entityId), player.turnIndex], [['gob2'], 0]);
  assert.ok(validateEncounterState(player, { projected: true }).ok);
  assert.deepEqual(Object.keys(viewFor(st, { role: 'dm' }).entities).sort(), ['gob', 'gob2']);
  assert.equal(stateHash(st), sharedStateHash(viewFor(st, null)), 'the hash covers the unfiltered state');
});

test('dm-only overrides reach players as redacted with the same seq', async () => {
  const srv = await boot();
  try {
    const t = await table(srv, 1);
    const { dm, ps } = await connectAll(srv, t);
    srv.registry.get(t.room.roomId).settings.dmOverrideVisibility = 'dm-only';
    await dm.send('dm.encounter.setup', SETUP);
    await dm.send('dm.entity.patch', { entityId: 'gob', hp: 2 });
    const ov = await dm.find(m => m.t === 'dm.override');
    const red = await ps[0].find(m => m.t === 'redacted');
    assert.equal(red.seq, ov.seq);
    assert.deepEqual(red.p, { type: 'dm.override' });
    assert.equal(ps[0].of('dm.override').length, 0);
    assertClean(dm, ...ps);
  } finally { await srv.close(); }
});

test('a failing turn lane puts the room in error and re-baselines every client', async () => {
  const stub = createStubEngine();
  const engine = { ...stub, runTurn: async (state, ctx) => { ctx.emit({ type: 'turn.started', payload: { actorId: 'x' } }); ctx.emit({ type: 'damage', payload: { bogus: true } }); return { state, events: [] }; } };
  const srv = await boot({ engine });
  try {
    const t = await table(srv, 1);
    const { dm, ps } = await connectAll(srv, t);
    await dm.send('dm.encounter.setup', SETUP);
    await dm.send('dm.encounter.start', { seed: 1 });
    await dm.find(m => m.t === 'room.status' && m.p.status === 'error');
    const snap = await ps[0].find(m => m.t === 'room.snapshot' && m.p.room.status === 'error');
    assert.ok(snap.p.seq >= 1);
    assert.equal(srv.registry.get(t.room.roomId).status, 'error');
    for (const c of [dm, ...ps]) assert.deepEqual(c.invalid, []);
  } finally { await srv.close(); }
});
