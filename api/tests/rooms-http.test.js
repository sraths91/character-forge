// M64 B6 — rooms HTTP API: create / join / kick / seats, hashed tokens,
// display-name rules, code normalisation and rate limits.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

import { startServer } from '../start.js';
import { createApp } from '../app.js';
import { createRoomService, AI_ARCHETYPES } from '../rooms/service.js';
import {
  generateToken, hashToken, generateRoomCode, normalizeRoomCode, sanitizeDisplayName, bearerToken, CROCKFORD_ALPHABET
} from '../rooms/tokens.js';
import { tempRoot, tempDb, quiet, ddbFixture, api } from './helpers/server.js';

const { root, cleanup } = tempRoot('cf-rooms-');
after(cleanup);

const LOOSE = { roomCreate: { windowMs: 60_000, max: 1000 }, roomJoin: { windowMs: 60_000, max: 1000 } };

async function boot({ limits = LOOSE } = {}) {
  const { dir, db } = await tempDb(root);
  const app = createApp({ db, env: { NODE_ENV: 'test' }, log: quiet, limits });
  const srv = await startServer({ db, port: 0, host: '127.0.0.1', app, log: quiet });
  return { db, dir, ...srv };
}

async function createRoom(s) {
  const r = await api(s.url, '/api/rooms', { method: 'POST', body: {} });
  assert.equal(r.status, 201);
  return r.body;
}
async function join(s, code, displayName = 'Pat') {
  const r = await api(s.url, '/api/rooms/join', { method: 'POST', body: { code, displayName } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body;
}
async function importInto(s, roomId, token, fixture = 'fighter-l5') {
  const r = await api(s.url, `/api/import?room=${roomId}`, { method: 'POST', token, body: { json: ddbFixture(fixture) } });
  assert.equal(r.status, 200);
  return r.body.character.id;
}

test('tokens: 256-bit base64url, SHA-256 base64url hashes, Crockford codes', () => {
  const t = generateToken();
  assert.match(t, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(Buffer.from(t, 'base64url').length, 32);
  assert.notEqual(generateToken(), t);
  assert.match(hashToken(t), /^[A-Za-z0-9_-]{43}$/);
  assert.equal(hashToken(t), hashToken(t));
  assert.equal(CROCKFORD_ALPHABET.length, 32);
  for (let i = 0; i < 50; i++) assert.match(generateRoomCode(), /^[0-9A-HJKMNP-TV-Z]{6}$/);
  assert.equal(normalizeRoomCode(' abc-def '), 'ABCDEF');
  assert.equal(normalizeRoomCode('oil1oo'), '011100');
  assert.equal(normalizeRoomCode('ABCDEU'), null);
  assert.equal(normalizeRoomCode('ABC'), null);
  assert.equal(normalizeRoomCode(42), null);
  assert.equal(bearerToken({ headers: { authorization: `Bearer ${t}` } }), t);
  assert.equal(bearerToken({ headers: { authorization: 'Basic abc' } }), null);
  assert.equal(bearerToken({ headers: {} }), null);
});

test('display names: NFC, control/bidi/zero-width stripped, whitespace collapsed, 1-32 code points', () => {
  assert.deepEqual(sanitizeDisplayName('Amélie'), { ok: true, name: 'Amélie' });
  assert.deepEqual(sanitizeDisplayName('‮evil‬ ​name\u0007'), { ok: true, name: 'evil name' });
  assert.deepEqual(sanitizeDisplayName('  a \n\t b  '), { ok: true, name: 'a b' });
  assert.deepEqual(sanitizeDisplayName('x'.repeat(32)), { ok: true, name: 'x'.repeat(32) });
  assert.equal(sanitizeDisplayName('\u{1F409}'.repeat(32)).ok, true, '32 emoji = 32 code points');
  assert.equal(sanitizeDisplayName('x'.repeat(33)).ok, false);
  assert.equal(sanitizeDisplayName('​‮ ').ok, false);
  assert.equal(sanitizeDisplayName('').ok, false);
  assert.equal(sanitizeDisplayName(null).ok, false);
});

test('POST /api/rooms creates a room; the DM token authenticates as DM', async () => {
  const s = await boot();
  try {
    const room = await createRoom(s);
    assert.match(room.code, /^[0-9A-HJKMNP-TV-Z]{6}$/);
    assert.match(room.dmToken, /^[A-Za-z0-9_-]{43}$/);
    const r = await api(s.url, `/api/rooms/${room.roomId}`, { token: room.dmToken });
    assert.equal(r.status, 200);
    assert.equal(r.body.me.role, 'dm');
    assert.equal(r.body.me.participantId, room.participantId);
    assert.equal(r.body.room.code, room.code);
    assert.equal(r.body.room.settings.reactionTimeoutMs, 20000);
    assert.equal((await api(s.url, `/api/rooms/${room.roomId}`)).status, 401);
  } finally { await s.close(); }
});

test('join by code (case/look-alike tolerant) returns a player token; bad and unknown codes fail', async () => {
  const s = await boot();
  try {
    const room = await createRoom(s);
    const p = await join(s, room.code.toLowerCase(), '  Bree ');
    assert.equal(p.roomId, room.roomId);
    assert.equal(p.displayName, 'Bree');
    const me = await api(s.url, `/api/rooms/${room.roomId}`, { token: p.token });
    assert.equal(me.body.me.role, 'player');
    assert.deepEqual(me.body.members.map(m => m.displayName), ['DM', 'Bree']);
    let r = await api(s.url, '/api/rooms/join', { method: 'POST', body: { code: 'nope', displayName: 'x' } });
    assert.deepEqual([r.status, r.body.code], [400, 'BAD_CODE']);
    const unknown = room.code === 'ZZZZZZ' ? 'YYYYYY' : 'ZZZZZZ';
    r = await api(s.url, '/api/rooms/join', { method: 'POST', body: { code: unknown, displayName: 'x' } });
    assert.deepEqual([r.status, r.body.code], [404, 'ROOM_NOT_FOUND']);
    r = await api(s.url, '/api/rooms/join', { method: 'POST', body: { code: room.code, displayName: '‮' } });
    assert.deepEqual([r.status, r.body.code], [400, 'BAD_NAME']);
    // A token for one room does not open another.
    const other = await createRoom(s);
    assert.equal((await api(s.url, `/api/rooms/${other.roomId}`, { token: p.token })).status, 401);
  } finally { await s.close(); }
});

test('raw tokens are never present in the database (file or WAL)', async () => {
  const s = await boot();
  try {
    const room = await createRoom(s);
    const p = await join(s, room.code, 'Pat');
    s.db.db.pragma('wal_checkpoint(PASSIVE)');
    const dump = [];
    for (const { name } of s.db.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()) {
      for (const row of s.db.db.prepare(`SELECT * FROM "${name}"`).all()) dump.push(JSON.stringify(row));
    }
    const text = dump.join('\n');
    for (const tok of [room.dmToken, p.token]) {
      assert.ok(!text.includes(tok), 'raw token found in a table');
      assert.ok(text.includes(hashToken(tok)), 'hash is stored');
      for (const f of [s.db.path, `${s.db.path}-wal`]) {
        if (existsSync(f)) assert.ok(!readFileSync(f).includes(Buffer.from(tok)), `raw token found in ${f}`);
      }
    }
  } finally { await s.close(); }
});

test('kick: DM only; the kicked token stops working and their seat becomes AI', async () => {
  const s = await boot();
  try {
    const room = await createRoom(s);
    const a = await join(s, room.code, 'A');
    const b = await join(s, room.code, 'B');
    const ch = await importInto(s, room.roomId, a.token);
    let r = await api(s.url, `/api/rooms/${room.roomId}/seats/1/claim`, { method: 'POST', token: a.token, body: { characterId: ch } });
    assert.equal(r.status, 200);
    r = await api(s.url, `/api/rooms/${room.roomId}/kick`, { method: 'POST', token: b.token, body: { participantId: a.participantId } });
    assert.deepEqual([r.status, r.body.code], [403, 'E_FORBIDDEN']);
    r = await api(s.url, `/api/rooms/${room.roomId}/kick`, { method: 'POST', token: room.dmToken, body: { participantId: room.participantId } });
    assert.equal(r.status, 400, 'cannot kick the DM');
    r = await api(s.url, `/api/rooms/${room.roomId}/kick`, { method: 'POST', token: room.dmToken, body: { participantId: a.participantId } });
    assert.deepEqual(r.body, { ok: true });
    assert.equal((await api(s.url, `/api/rooms/${room.roomId}`, { token: a.token })).status, 401);
    const view = await api(s.url, `/api/rooms/${room.roomId}`, { token: room.dmToken });
    assert.deepEqual(view.body.seats.map(x => [x.seat, x.controller, x.memberId]), [[1, 'ai', null]]);
    assert.ok(!view.body.members.some(m => m.id === a.participantId));
  } finally { await s.close(); }
});

test('seats: claim needs a room character; one seat per player; taken seats 409; DM assigns AI seats', async () => {
  const s = await boot();
  try {
    const room = await createRoom(s);
    const a = await join(s, room.code, 'A');
    const b = await join(s, room.code, 'B');
    const base = `/api/rooms/${room.roomId}/seats`;
    let r = await api(s.url, `${base}/1/claim`, { method: 'POST', token: a.token, body: { characterId: '123' } });
    assert.deepEqual([r.status, r.body.code], [404, 'CHARACTER_NOT_IN_ROOM']);
    const fighter = await importInto(s, room.roomId, a.token, 'fighter-l5');
    const wizard = await importInto(s, room.roomId, b.token, 'wizard-l5');
    const cleric = await importInto(s, room.roomId, room.dmToken, 'cleric-l5');

    r = await api(s.url, `${base}/1/claim`, { method: 'POST', token: a.token, body: { characterId: fighter } });
    assert.deepEqual(r.body.seat, {
      seat: 1, slotId: r.body.seat.slotId, characterId: fighter, characterName: r.body.seat.characterName,
      controller: 'player', memberId: a.participantId, aiArchetype: null
    });
    r = await api(s.url, `${base}/1/claim`, { method: 'POST', token: b.token, body: { characterId: wizard } });
    assert.deepEqual([r.status, r.body.code], [409, 'E_SEAT_TAKEN']);
    r = await api(s.url, `${base}/7/claim`, { method: 'POST', token: b.token, body: { characterId: wizard } });
    assert.deepEqual([r.status, r.body.code], [400, 'BAD_SEAT']);
    r = await api(s.url, `${base}/2/claim`, { method: 'POST', token: b.token, body: { characterId: wizard, participantId: a.participantId } });
    assert.equal(r.status, 403, 'players seat only themselves');
    // A moves from seat 1 to seat 3.
    r = await api(s.url, `${base}/3/claim`, { method: 'POST', token: a.token, body: { characterId: fighter } });
    assert.equal(r.status, 200);
    // DM seats B, and assigns an AI cleric.
    r = await api(s.url, `${base}/2/claim`, { method: 'POST', token: room.dmToken, body: { characterId: wizard, participantId: b.participantId } });
    assert.equal(r.status, 200);
    r = await api(s.url, `${base}/4/ai`, { method: 'POST', token: a.token, body: { characterId: cleric } });
    assert.equal(r.status, 403, 'only the DM assigns AI seats');
    r = await api(s.url, `${base}/4/ai`, { method: 'POST', token: room.dmToken, body: { characterId: cleric, archetype: 'nope' } });
    assert.deepEqual([r.status, r.body.code], [400, 'BAD_ARCHETYPE']);
    r = await api(s.url, `${base}/4/ai`, { method: 'POST', token: room.dmToken, body: { characterId: cleric, archetype: 'cleric' } });
    assert.deepEqual([r.body.seat.controller, r.body.seat.aiArchetype], ['ai', 'cleric']);
    assert.ok(AI_ARCHETYPES.includes('auto'));
    r = await api(s.url, `${base}/2/ai`, { method: 'POST', token: room.dmToken, body: { characterId: cleric } });
    assert.deepEqual([r.status, r.body.code], [409, 'E_SEAT_TAKEN']);
    r = await api(s.url, `${base}/2/ai`, { method: 'POST', token: room.dmToken, body: { characterId: wizard, force: true } });
    assert.equal(r.body.seat.controller, 'ai');

    const view = await api(s.url, `/api/rooms/${room.roomId}`, { token: b.token });
    assert.deepEqual(view.body.seats.map(x => [x.seat, x.controller]), [[2, 'ai'], [3, 'player'], [4, 'ai']]);
    // Release: a player only their own; the DM any.
    r = await api(s.url, `${base}/4`, { method: 'DELETE', token: a.token });
    assert.equal(r.status, 403);
    assert.equal((await api(s.url, `${base}/3`, { method: 'DELETE', token: a.token })).status, 200);
    assert.equal((await api(s.url, `${base}/4`, { method: 'DELETE', token: room.dmToken })).status, 200);
    assert.equal((await api(s.url, `${base}/4`, { method: 'DELETE', token: room.dmToken })).status, 404);
  } finally { await s.close(); }
});

test('room codes are unique among open rooms (collision retries) and a closed room frees its code', async () => {
  const { db } = await tempDb(root);
  try {
    // codeRand yields all-zero codes for the first two rooms' attempts.
    const seq = [...Array(6).fill(0), ...Array(6).fill(0), ...Array(6).fill(1)];
    let i = 0;
    const svc = createRoomService({ db, codeRand: () => (i < seq.length ? seq[i++] : 2) });
    const a = svc.createRoom();
    assert.equal(a.code, '000000');
    const b = svc.createRoom();
    assert.equal(b.code, '111111', 'collided with an open room, retried');
    svc.store.setRoomStatus(a.roomId, 'closed');
    i = 0;
    const c = svc.createRoom();
    assert.equal(c.code, '000000', 'closed rooms free their code');
    assert.equal(svc.joinRoom({ code: '000000', displayName: 'x' }).roomId, c.roomId, 'the code resolves to the open room');
  } finally { db.close(); }
});

test('rate limits: room create 5/hour/IP and join 10/minute/IP', async () => {
  const s = await boot({ limits: {} });
  try {
    let room;
    for (let k = 0; k < 5; k++) room = await createRoom(s);
    let r = await api(s.url, '/api/rooms', { method: 'POST', body: {} });
    assert.deepEqual([r.status, r.body.code], [429, 'RATE_LIMITED']);
    for (let k = 0; k < 10; k++) await join(s, room.code, `P${k}`);
    r = await api(s.url, '/api/rooms/join', { method: 'POST', body: { code: room.code, displayName: 'late' } });
    assert.equal(r.status, 429);
  } finally { await s.close(); }
});
