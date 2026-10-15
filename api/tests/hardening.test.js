// M64 B4 — hardening of the existing routes. One test (or more) per item:
// JSON errors, JSON 404, upstream timeouts, separate limiters with cache
// bypass, P0-10 (paste vs url rows, scoped character list, item-sprite
// writes), the SRD-only Open5e filter, the request log, and /play.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { startServer } from '../start.js';
import { createApp, CSP_REPORT_ONLY } from '../app.js';
import { tempRoot, tempDb, quiet, seedRoom, seedPlayer, ddbFixture, api } from './helpers/server.js';

const { root, cleanup } = tempRoot('cf-hard-');
after(cleanup);

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** Boot with an injectable fake upstream fetch. */
async function boot({ env = {}, fetchImpl, appOpts = {}, log = quiet } = {}) {
  const { dir, db } = await tempDb(root);
  const calls = [];
  const fake = fetchImpl || (async (url, opts) => {
    calls.push({ url: String(url), opts });
    return jsonResponse({ results: [] });
  });
  const app = createApp({ db, env: { NODE_ENV: 'test', ...env }, log, fetchImpl: fake, ...appOpts });
  const srv = await startServer({ db, port: 0, host: '127.0.0.1', app, log: quiet });
  return { db, dir, calls, ...srv };
}

test('malformed JSON gets a JSON 400 {error, code}, never an HTML stack', async () => {
  const s = await boot();
  try {
    const r = await api(s.url, '/api/import', { method: 'POST', body: '{"json": ' });
    assert.equal(r.status, 400);
    assert.deepEqual(r.body, { error: 'Malformed JSON body', code: 'BAD_JSON' });
    assert.match(r.headers.get('content-type'), /application\/json/);
  } finally { await s.close(); }
});

test('an unexpected error in production is a generic JSON 500 with no stack', async () => {
  const lines = [];
  const s = await boot({
    env: { NODE_ENV: 'production', ALLOWED_ORIGINS: 'http://x' },
    log: (level, msg, extra) => lines.push({ level, msg, ...extra }),
    appOpts: {
      distPath: join(root, 'nodist'),
      mount: (app) => app.get('/api/boom', () => { throw new Error('secret detail at /srv/app.js:12'); })
    }
  });
  try {
    const r = await api(s.url, '/api/boom');
    assert.equal(r.status, 500);
    assert.deepEqual(r.body, { error: 'Internal server error', code: 'INTERNAL' });
    assert.ok(lines.some(l => l.level === 'error' && l.error.includes('secret detail')), 'still logged server-side');
  } finally { await s.close(); }
});

test('unknown /api routes are a JSON 404 even in production (no index.html)', async () => {
  const dist = join(root, 'dist-404');
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, 'index.html'), 'INDEX');
  const s = await boot({ env: { NODE_ENV: 'production', ALLOWED_ORIGINS: 'http://x' }, appOpts: { distPath: dist } });
  try {
    const r = await api(s.url, '/api/does-not-exist');
    assert.equal(r.status, 404);
    assert.deepEqual(r.body, { error: 'Not found', code: 'NOT_FOUND' });
    assert.equal((await api(s.url, '/some/spa/route')).body, 'INDEX');
  } finally { await s.close(); }
});

test('/play serves play.html before the SPA catch-all', async () => {
  const dist = join(root, 'dist-play');
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, 'index.html'), 'INDEX');
  writeFileSync(join(dist, 'play.html'), 'PLAY');
  const s = await boot({ env: { NODE_ENV: 'production', ALLOWED_ORIGINS: 'http://x' }, appOpts: { distPath: dist } });
  try {
    assert.equal((await api(s.url, '/play')).body, 'PLAY');
    assert.equal((await api(s.url, '/')).body, 'INDEX');
  } finally { await s.close(); }
});

test('every upstream fetch carries an AbortSignal; a stalled upstream is a 504 after the timeout', async () => {
  const signals = [];
  const stall = (url, opts) => {
    signals.push(opts?.signal);
    return new Promise((_resolve, reject) => {
      opts.signal.addEventListener('abort', () => reject(opts.signal.reason), { once: true });
    });
  };
  const s = await boot({ fetchImpl: stall, appOpts: { upstreamTimeoutMs: 40 } });
  try {
    const t0 = Date.now();
    let r = await api(s.url, '/api/monsters/srd_goblin');
    assert.equal(r.status, 504);
    assert.deepEqual(r.body, { error: 'Upstream service timed out', code: 'UPSTREAM_TIMEOUT' });
    assert.ok(Date.now() - t0 < 2000);
    r = await api(s.url, '/api/monsters/search?q=goblin');
    assert.equal(r.status, 504);
    r = await api(s.url, '/api/import', { method: 'POST', body: { characterId: '123' } });
    assert.equal(r.status, 504);
    assert.equal(signals.length, 3);
    for (const sig of signals) assert.ok(sig instanceof globalThis.AbortSignal);
  } finally { await s.close(); }
});

test('the default upstream timeout is 8 s', async () => {
  const { UPSTREAM_TIMEOUT_MS } = await import('../lib/ddb-fetch.js');
  const { OPEN5E_TIMEOUT_MS } = await import('../lib/open5e.js');
  assert.equal(UPSTREAM_TIMEOUT_MS, 8000);
  assert.equal(OPEN5E_TIMEOUT_MS, 8000);
});

test('Open5e creature search is filtered to the SRD 5.1 document', async () => {
  const s = await boot();
  try {
    await api(s.url, '/api/monsters/search?q=goblin');
    const u = new URL(s.calls[0].url);
    assert.equal(u.pathname, '/v2/creatures/');
    assert.equal(u.searchParams.get('document__key'), 'srd-2014');
    assert.equal(u.searchParams.get('name__icontains'), 'goblin');
  } finally { await s.close(); }
});

test('import, monster search and monster get have separate limiters; cache hits are not limited', async () => {
  const one = { windowMs: 60_000, max: 1 };
  const s = await boot({ appOpts: { limits: { import: one, monsterSearch: one, monsterGet: one } } });
  try {
    s.db.upsertMonster({ slug: 'srd_goblin', name: 'Goblin', cr: 0.25, payload: { key: 'srd_goblin', name: 'Goblin' } });
    for (let i = 0; i < 4; i++) {
      const r = await api(s.url, '/api/monsters/srd_goblin');
      assert.equal(r.status, 200, `cached get #${i}`);
      assert.equal(r.body.source, 'cache');
    }
    // First miss passes, second is limited — on its own bucket.
    assert.notEqual((await api(s.url, '/api/monsters/srd_orc')).status, 429);
    assert.equal((await api(s.url, '/api/monsters/srd_wolf')).status, 429);
    assert.equal((await api(s.url, '/api/monsters/search?q=dragon')).status, 200);
    const limited = await api(s.url, '/api/monsters/search?q=kobold');
    assert.equal(limited.status, 429);
    assert.deepEqual(limited.body, { error: 'Too many requests', code: 'RATE_LIMITED' });
    // Import bucket untouched by the monster traffic.
    assert.notEqual((await api(s.url, '/api/import', { method: 'POST', body: {} })).status, 429);
    assert.equal((await api(s.url, '/api/import', { method: 'POST', body: {} })).status, 429);
  } finally { await s.close(); }
});

test('cached monster searches (>= 8 hits) bypass the search limiter', async () => {
  const one = { windowMs: 60_000, max: 1 };
  const s = await boot({ appOpts: { limits: { monsterSearch: one } } });
  try {
    for (let i = 0; i < 8; i++) s.db.upsertMonster({ slug: `srd_g${i}`, name: `Goblin ${i}`, payload: {} });
    for (let i = 0; i < 3; i++) {
      const r = await api(s.url, '/api/monsters/search?q=goblin');
      assert.equal(r.status, 200);
      assert.equal(r.body.source, 'cache');
    }
    assert.equal(s.calls.length, 0);
  } finally { await s.close(); }
});

test('P0-10: a JSON paste never overwrites a source=url row', async () => {
  const raw = ddbFixture('fighter-l5');
  const s = await boot({ fetchImpl: async () => jsonResponse({ data: raw }) });
  try {
    let r = await api(s.url, '/api/import', { method: 'POST', body: { characterId: String(raw.id) } });
    assert.equal(r.status, 200);
    assert.equal(r.body.source, 'url');
    const urlId = r.body.character.id;
    assert.equal(urlId, String(raw.id));

    const forged = { ...raw, name: 'Forged' };
    r = await api(s.url, '/api/import', { method: 'POST', body: { json: { data: forged } } });
    assert.equal(r.status, 200);
    assert.equal(r.body.source, 'paste');
    assert.equal(r.body.character.id, `paste:${raw.id}`);
    assert.equal(s.db.getCharacterByDdbId(urlId).source, 'url');
    assert.notEqual(s.db.getCharacterByDdbId(urlId).name, 'Forged');

    // The DB guard holds even if a paste somehow used the url row's key.
    const blocked = s.db.upsertCharacter({ ddbId: urlId, name: 'Forged', rawJson: {}, parsedJson: {}, source: 'paste' });
    assert.equal(blocked, undefined);
    assert.equal(s.db.getCharacterByDdbId(urlId).source, 'url');
    // A url re-import still updates its own row.
    assert.ok(s.db.upsertCharacter({ ddbId: urlId, name: 'Re', rawJson: {}, parsedJson: {}, source: 'url' }));
  } finally { await s.close(); }
});

test('P0-10: a paste into a room is scoped paste:<roomId>:<id> and recorded for the room', async () => {
  const raw = ddbFixture('wizard-l5');
  const s = await boot();
  try {
    const room = seedRoom(s.db);
    const other = seedRoom(s.db, { code: 'GHJKMN' });
    const p = seedPlayer(s.db, room.roomId);
    let r = await api(s.url, `/api/import?room=${room.roomId}`, { method: 'POST', body: { json: raw } });
    assert.equal(r.status, 401, 'no token');
    r = await api(s.url, `/api/import?room=${other.roomId}`, { method: 'POST', token: p.token, body: { json: raw } });
    assert.equal(r.status, 401, 'token of another room');
    r = await api(s.url, `/api/import?room=${room.roomId}`, { method: 'POST', token: p.token, body: { json: raw } });
    assert.equal(r.status, 200);
    assert.equal(r.body.character.id, `paste:${room.roomId}:${raw.id}`);
    r = await api(s.url, `/api/characters?room=${room.roomId}`, { token: room.dmToken });
    assert.deepEqual(r.body.characters.map(c => c.ddbId), [`paste:${room.roomId}:${raw.id}`]);
  } finally { await s.close(); }
});

test('P0-10: GET /api/characters is disabled in multiplayer mode and room-scoped with ?room=', async () => {
  const s = await boot({ env: { CF_MULTIPLAYER: '1' } });
  try {
    s.db.upsertCharacter({ ddbId: 'global-1', name: 'Global', rawJson: {}, parsedJson: {}, source: 'url' });
    let r = await api(s.url, '/api/characters');
    assert.equal(r.status, 403);
    assert.equal(r.body.code, 'LIST_DISABLED');
    const room = seedRoom(s.db);
    r = await api(s.url, `/api/characters?room=${room.roomId}`);
    assert.equal(r.status, 401);
    r = await api(s.url, `/api/characters?room=${room.roomId}`, { token: room.dmToken });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.characters, []);
  } finally { await s.close(); }
  const single = await boot();
  try {
    single.db.upsertCharacter({ ddbId: 'g', name: 'G', rawJson: {}, parsedJson: {}, source: 'url' });
    assert.equal((await api(single.url, '/api/characters')).body.characters.length, 1, 'single-player unchanged');
  } finally { await single.close(); }
});

test('P0-10: item-sprite POST needs a room member in multiplayer mode and is first-write-wins', async () => {
  const s = await boot({ env: { CF_MULTIPLAYER: '1' } });
  try {
    const hash = 'f'.repeat(40);
    const body = { png: PNG, itemName: 'Longsword', baseAsset: '/a' };
    let r = await api(s.url, `/api/items/${hash}`, { method: 'POST', body });
    assert.equal(r.status, 401);
    const room = seedRoom(s.db);
    const p = seedPlayer(s.db, room.roomId);
    r = await api(s.url, `/api/items/${hash}`, { method: 'POST', token: p.token, body });
    assert.deepEqual(r.body, { ok: true, stored: true });
    r = await api(s.url, `/api/items/${hash}`, { method: 'POST', token: room.dmToken, body: { ...body, itemName: 'Poison' } });
    assert.deepEqual(r.body, { ok: true, stored: false });
    assert.equal(s.db.getItemSprite(hash).name, 'Longsword');
  } finally { await s.close(); }
});

test('request log: one JSON line per API request with a request id, path only (no query)', async () => {
  const lines = [];
  const s = await boot({ log: (level, msg, extra) => lines.push({ level, msg, ...extra }) });
  try {
    let r = await api(s.url, '/api/health?secret=xyz', { headers: { 'x-request-id': 'req-abc_1' } });
    assert.equal(r.headers.get('x-request-id'), 'req-abc_1');
    r = await api(s.url, '/api/health', { headers: { 'x-request-id': 'bad id with spaces' } });
    const generated = r.headers.get('x-request-id');
    assert.match(generated, /^[0-9a-f-]{36}$/);
    const reqLines = lines.filter(l => l.msg === 'request');
    assert.equal(reqLines.length, 2);
    assert.deepEqual(
      { reqId: reqLines[0].reqId, method: reqLines[0].method, path: reqLines[0].path, status: reqLines[0].status },
      { reqId: 'req-abc_1', method: 'GET', path: '/api/health', status: 200 });
    assert.equal(typeof reqLines[0].ms, 'number');
    assert.equal(reqLines[1].reqId, generated);
    assert.ok(!JSON.stringify(lines).includes('xyz'));
  } finally { await s.close(); }
});

test('responses carry a report-only CSP', async () => {
  const s = await boot();
  try {
    const r = await api(s.url, '/api/health');
    assert.equal(r.headers.get('content-security-policy-report-only'), CSP_REPORT_ONLY);
    assert.match(CSP_REPORT_ONLY, /script-src 'self'/);
    assert.equal(r.headers.get('content-security-policy'), null, 'not enforced in phase 1');
  } finally { await s.close(); }
});
