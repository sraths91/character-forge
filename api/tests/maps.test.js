// M64 B10 — map upload: image sniffing (pure) and the upload / serve routes.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { PNG } from 'pngjs';

import { sniffImage, dimensionProblem, MAP_LIMITS } from '../lib/image-sniff.js';
import { createApp } from '../app.js';
import { startServer } from '../start.js';
import { tempRoot, tempDb, quiet, api } from './helpers/server.js';

const { root, cleanup } = tempRoot('cf-maps-');
after(cleanup);

// ---------------------------------------------------------------- fixtures

function realPng(w, h) {
  const png = new PNG({ width: w, height: h });
  png.data.fill(200);
  return PNG.sync.write(png);
}
/** PNG signature + IHDR with arbitrary (possibly huge) dimensions. */
function pngHeader(w, h) {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'ascii');
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
}
/** SOI, APP0 (JFIF), fill bytes, SOF0 with dimensions, EOI. */
function jpeg(w, h) {
  const app0 = Buffer.from([0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
  const sof = Buffer.from([0xFF, 0xFF, 0xC0, 0x00, 0x11, 0x08, h >> 8, h & 255, w >> 8, w & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  return Buffer.concat([Buffer.from([0xFF, 0xD8]), app0, sof, Buffer.from([0xFF, 0xD9])]);
}
function riff(chunk, payload) {
  const b = Buffer.alloc(20 + payload.length);
  b.write('RIFF', 0, 'ascii');
  b.writeUInt32LE(b.length - 8, 4);
  b.write('WEBP', 8, 'ascii');
  b.write(chunk, 12, 'ascii');
  b.writeUInt32LE(payload.length, 16);
  payload.copy(b, 20);
  return b;
}
function webpVP8(w, h) {
  const p = Buffer.alloc(16);
  p[3] = 0x9D; p[4] = 0x01; p[5] = 0x2A;
  p.writeUInt16LE(w, 6); p.writeUInt16LE(h, 8);
  return riff('VP8 ', p);
}
function webpVP8L(w, h) {
  const p = Buffer.alloc(16);
  p[0] = 0x2F;
  const bits = ((w - 1) & 0x3FFF) | (((h - 1) & 0x3FFF) << 14);
  p.writeUInt32LE(bits >>> 0, 1);
  return riff('VP8L', p);
}
function webpVP8X(w, h) {
  const p = Buffer.alloc(16);
  p.writeUIntLE(w - 1, 4, 3); p.writeUIntLE(h - 1, 7, 3);
  return riff('VP8X', p);
}
const GIF = Buffer.from('GIF89a\x01\x00\x01\x00\x00\x00\x00;', 'latin1');
const SVG = Buffer.from('\uFEFF  <?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>');

// --------------------------------------------------------------- sniffing

test('sniffImage: PNG, JPEG and the three WebP flavours with dimensions', () => {
  assert.deepEqual(sniffImage(realPng(7, 3)), { ok: true, mime: 'image/png', ext: 'png', width: 7, height: 3 });
  assert.deepEqual(sniffImage(jpeg(640, 480)), { ok: true, mime: 'image/jpeg', ext: 'jpg', width: 640, height: 480 });
  assert.deepEqual(sniffImage(webpVP8(300, 200)), { ok: true, mime: 'image/webp', ext: 'webp', width: 300, height: 200 });
  assert.deepEqual(sniffImage(webpVP8L(1024, 768)), { ok: true, mime: 'image/webp', ext: 'webp', width: 1024, height: 768 });
  assert.deepEqual(sniffImage(webpVP8X(5000, 3000)), { ok: true, mime: 'image/webp', ext: 'webp', width: 5000, height: 3000 });
});

test('sniffImage: GIF and SVG are named for rejection; junk and truncation are not images', () => {
  assert.deepEqual(sniffImage(GIF), { ok: false, reason: 'gif' });
  assert.deepEqual(sniffImage(SVG), { ok: false, reason: 'svg' });
  assert.deepEqual(sniffImage(Buffer.from('<svg/>')), { ok: false, reason: 'svg' });
  assert.deepEqual(sniffImage(Buffer.from('hello world')), { ok: false, reason: 'unsupported' });
  assert.equal(sniffImage(pngHeader(1, 1).subarray(0, 20)).reason, 'truncated');
  assert.equal(sniffImage(Buffer.from([0xFF, 0xD8, 0xFF, 0xD9])).reason, 'truncated');
  assert.equal(sniffImage(new Uint8Array(0)).ok, false);
  assert.equal(sniffImage(null).ok, false);
});

test('dimensionProblem: 8192 px per side and 16.7 MP', () => {
  assert.equal(dimensionProblem({ width: 8192, height: 2048 }), null);
  assert.equal(dimensionProblem({ width: 4096, height: 4096 }), null);
  assert.match(dimensionProblem({ width: 9000, height: 10 }), /8192/);
  assert.match(dimensionProblem({ width: 5000, height: 5000 }), /pixels/);
  assert.match(dimensionProblem({ width: 0, height: 5 }), /no pixels/);
  assert.equal(MAP_LIMITS.maxPixels, 16_777_216);
});

// ----------------------------------------------------------------- routes

async function boot({ env = { NODE_ENV: 'test' }, mapsOpts = {}, appOpts = {} } = {}) {
  const { dir, db } = await tempDb(root);
  const app = createApp({ db, env, dataDir: dir, log: quiet, mapsOpts, ...appOpts });
  const srv = await startServer({ db, port: 0, host: '127.0.0.1', app, log: quiet });
  const room = srv.app.locals.rooms.createRoom();
  const player = srv.app.locals.rooms.joinRoom({ code: room.code, displayName: 'P' });
  return { db, dir, room, player, ...srv };
}

function put(s, body, { token = s.room.dmToken, type = 'image/png', query = '' } = {}) {
  return fetch(`${s.url}/api/rooms/${s.room.roomId}/maps${query}`, {
    method: 'PUT', body, headers: { authorization: `Bearer ${token}`, 'content-type': type }
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
}

test('DM uploads a PNG; it is served immutable with nosniff; re-upload is idempotent', async () => {
  const s = await boot();
  try {
    const bytes = realPng(64, 32);
    const r = await put(s, bytes);
    assert.equal(r.status, 201);
    assert.deepEqual([r.body.mime, r.body.width, r.body.height, r.body.bytes], ['image/png', 64, 32, bytes.length]);
    assert.match(r.body.url, new RegExp(`^/api/maps/${s.room.roomId}/[0-9a-f]{64}\\.png$`));
    const got = await fetch(s.url + r.body.url);
    assert.equal(got.status, 200);
    assert.deepEqual(Buffer.from(await got.arrayBuffer()), bytes);
    assert.equal(got.headers.get('cache-control'), 'private, max-age=31536000, immutable');
    assert.equal(got.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(got.headers.get('content-security-policy'), "default-src 'none'");
    assert.equal(got.headers.get('content-type'), 'image/png');
    const again = await put(s, bytes, { type: 'application/octet-stream' });
    assert.equal(again.status, 200);
    assert.equal(again.body.mapId, r.body.mapId);
    // Atomic write: no temp files left behind.
    assert.deepEqual(readdirSync(join(s.dir, 'maps', s.room.roomId)).filter(f => f.startsWith('.')), []);
    // Members can list; only the DM deletes.
    const list = await api(s.url, `/api/rooms/${s.room.roomId}/maps`, { token: s.player.token });
    assert.deepEqual(list.body.maps.map(m => m.mapId), [r.body.mapId]);
    assert.equal((await api(s.url, `/api/rooms/${s.room.roomId}/maps/${r.body.mapId}`, { method: 'DELETE', token: s.player.token })).status, 403);
    assert.equal((await api(s.url, `/api/rooms/${s.room.roomId}/maps/${r.body.mapId}`, { method: 'DELETE', token: s.room.dmToken })).status, 200);
    assert.equal(existsSync(join(s.dir, 'maps', s.room.roomId, r.body.url.split('/').pop())), false);
  } finally { await s.close(); }
});

test('only the DM may upload; strangers are refused before the body is read', async () => {
  const s = await boot();
  try {
    assert.equal((await put(s, realPng(2, 2), { token: s.player.token })).status, 403);
    const r = await fetch(`${s.url}/api/rooms/${s.room.roomId}/maps`, { method: 'PUT', body: realPng(2, 2), headers: { 'content-type': 'image/png' } });
    assert.equal(r.status, 401);
  } finally { await s.close(); }
});

test('spoofed type or extension → 415; GIF and SVG → 415', async () => {
  const s = await boot();
  try {
    let r = await put(s, jpeg(100, 100), { type: 'image/png' });
    assert.deepEqual([r.status, r.body.code], [415, 'UNSUPPORTED_MEDIA']);
    r = await put(s, jpeg(100, 100), { type: 'application/octet-stream', query: '?filename=dungeon.png' });
    assert.equal(r.status, 415);
    assert.match(r.body.error, /dungeon\.png/);
    r = await put(s, GIF, { type: 'image/gif' });
    assert.equal(r.status, 415);
    assert.match(r.body.error, /GIF/);
    r = await put(s, SVG, { type: 'image/svg+xml' });
    assert.equal(r.status, 415);
    assert.match(r.body.error, /SVG/);
    r = await put(s, Buffer.from('MZ\x90\x00 not an image'), { type: 'application/octet-stream' });
    assert.equal(r.status, 415);
    // The real types with matching names are fine.
    assert.equal((await put(s, jpeg(100, 100), { type: 'image/jpeg', query: '?filename=cave.JPEG' })).status, 201);
    assert.equal((await put(s, webpVP8L(50, 40), { type: 'image/webp', query: '?filename=forest.webp' })).status, 201);
  } finally { await s.close(); }
});

test('11 MB → 413; 9000x10 → 422; 5000x5000 → 422', async () => {
  const s = await boot();
  try {
    const big = Buffer.concat([realPng(2, 2), Buffer.alloc(11 * 1024 * 1024)]);
    const r = await put(s, big);
    assert.deepEqual([r.status, r.body.code], [413, 'TOO_LARGE']);
    let d = await put(s, pngHeader(9000, 10));
    assert.deepEqual([d.status, d.body.code], [422, 'BAD_DIMENSIONS']);
    d = await put(s, pngHeader(5000, 5000));
    assert.equal(d.status, 422);
  } finally { await s.close(); }
});

test('a missing map file is a JSON 404, never index.html (production too)', async () => {
  const dist = join(root, 'dist');
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, 'index.html'), 'INDEX');
  const s = await boot({ env: { NODE_ENV: 'production', ALLOWED_ORIGINS: 'http://x' }, appOpts: { distPath: dist } });
  try {
    const r = await api(s.url, `/api/maps/${s.room.roomId}/${'0'.repeat(64)}.png`);
    assert.equal(r.status, 404);
    assert.deepEqual(r.body, { error: 'Not found', code: 'NOT_FOUND' });
    const trav = await api(s.url, '/api/maps/..%2f..%2fapp.db');
    assert.notEqual(trav.status, 200);
    assert.notEqual(trav.body, 'INDEX');
  } finally { await s.close(); }
});

test('quotas: maps per room → 409; volume over 70 % → 507', async () => {
  const s = await boot({ mapsOpts: { quota: { maxBytes: 10 * 1024 * 1024, maxMaps: 2, maxRoomBytes: 100 * 1024 * 1024, maxVolumeUse: 0.7 } } });
  try {
    assert.equal((await put(s, realPng(3, 3))).status, 201);
    assert.equal((await put(s, realPng(4, 4))).status, 201);
    const r = await put(s, realPng(5, 5));
    assert.deepEqual([r.status, r.body.code], [409, 'QUOTA']);
  } finally { await s.close(); }
  const full = await boot({ mapsOpts: { statfs: () => ({ blocks: 100, bavail: 20 }) } });
  try {
    const r = await put(full, realPng(3, 3));
    assert.deepEqual([r.status, r.body.code], [507, 'VOLUME_FULL']);
  } finally { await full.close(); }
});

test('room byte quota: 100 MB per room → 409', async () => {
  const s = await boot({ mapsOpts: { quota: { maxBytes: 10 * 1024 * 1024, maxMaps: 20, maxRoomBytes: 200, maxVolumeUse: 0.7 } } });
  try {
    const r = await put(s, Buffer.concat([realPng(4, 4), Buffer.alloc(300)]));
    assert.deepEqual([r.status, r.body.code], [409, 'QUOTA']);
  } finally { await s.close(); }
});
