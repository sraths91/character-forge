// In-process server tests (M64 B3). Boots on port 0 against a temp-file DB
// and must leave no open handles: this file runs without --test-force-exit.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb, ITEM_GENERATOR_VERSION } from '../db/database.js';
import { createApp } from '../app.js';
import { startServer } from '../start.js';

const quiet = () => {};
const root = mkdtempSync(join(tmpdir(), 'cf-app-'));
after(() => rmSync(root, { recursive: true, force: true }));

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

async function boot(extra = {}) {
  const dir = mkdtempSync(join(root, 'srv-'));
  const db = await openDb(join(dir, 'app.db'), { log: quiet });
  const srv = await startServer({ db, port: 0, host: '127.0.0.1', env: { NODE_ENV: 'test' }, log: quiet, ...extra });
  return { db, dir, ...srv };
}

test('boots on port 0, serves /api/health, and closes cleanly', async () => {
  const srv = await boot();
  assert.match(srv.url, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.ok(srv.port > 0);
  const res = await fetch(`${srv.url}/api/health`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.migrationVersion, 2);
  assert.equal(body.dataDir, srv.dir);
  await srv.close();
  await srv.close(); // idempotent
  assert.equal(srv.httpServer.listening, false);
  assert.equal(srv.db.db.open, false);
  await assert.rejects(fetch(`${srv.url}/api/health`));
});

test('existing routes behave the same through the factory', async () => {
  const srv = await boot();
  try {
    const hash = 'a'.repeat(40);
    let res = await fetch(`${srv.url}/api/items/${hash}`);
    assert.equal(res.status, 404);

    res = await fetch(`${srv.url}/api/items/${hash}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ png: PNG, itemName: 'Longsword', baseAsset: '/x' })
    });
    assert.deepEqual(await res.json(), { ok: true });

    res = await fetch(`${srv.url}/api/items/${hash}`);
    assert.deepEqual(await res.json(), { png: PNG, version: ITEM_GENERATOR_VERSION });

    res = await fetch(`${srv.url}/api/items/not-a-hash`);
    assert.equal(res.status, 400);

    res = await fetch(`${srv.url}/api/items-version`);
    assert.deepEqual(await res.json(), { version: ITEM_GENERATOR_VERSION });

    res = await fetch(`${srv.url}/api/characters`);
    assert.deepEqual(await res.json(), { characters: [] });

    res = await fetch(`${srv.url}/api/characters/12345`);
    assert.equal(res.status, 404);

    res = await fetch(`${srv.url}/api/monsters/search?q=`);
    assert.deepEqual(await res.json(), { results: [] });
  } finally {
    await srv.close();
  }
});

test('two servers on separate DBs do not share state', async () => {
  const a = await boot();
  const b = await boot();
  try {
    a.db.putItemSprite({ hash: 'b'.repeat(40), pngBase64: PNG, itemName: 'A', baseAsset: '/a' });
    assert.equal((await fetch(`${a.url}/api/items/${'b'.repeat(40)}`)).status, 200);
    assert.equal((await fetch(`${b.url}/api/items/${'b'.repeat(40)}`)).status, 404);
  } finally {
    await a.close();
    await b.close();
  }
});

test('onClose runs before the HTTP server stops', async () => {
  const order = [];
  const srv = await boot({ onClose: () => { order.push(srv.httpServer.listening ? 'hook-while-listening' : 'hook-after'); } });
  await srv.close();
  order.push('closed');
  assert.deepEqual(order, ['hook-while-listening', 'closed']);
});

test('SIGTERM drains, closes the DB, and exits 0 (injected exit)', async () => {
  const before = process.listenerCount('SIGTERM');
  const beforeInt = process.listenerCount('SIGINT');
  let resolveExit;
  const exited = new Promise(r => { resolveExit = r; });
  const srv = await boot({ handleSignals: true, exit: resolveExit });
  assert.equal(process.listenerCount('SIGTERM'), before + 1);
  process.emit('SIGTERM', 'SIGTERM');
  assert.equal(await exited, 0);
  assert.equal(srv.httpServer.listening, false);
  assert.equal(srv.db.db.open, false);
  assert.equal(process.listenerCount('SIGTERM'), before);
  assert.equal(process.listenerCount('SIGINT'), beforeInt);
});

test('createApp and startServer require a db handle', async () => {
  assert.throws(() => createApp({}), /db handle/);
  await assert.rejects(startServer({ port: 0 }), /db handle/);
});

test('/api/health reports an injected dataDir', async () => {
  const srv = await boot({ dataDir: '/app/data' });
  try {
    const body = await (await fetch(`${srv.url}/api/health`)).json();
    assert.deepEqual({ ok: body.ok, migrationVersion: body.migrationVersion, dataDir: body.dataDir },
      { ok: true, migrationVersion: 2, dataDir: '/app/data' });
    assert.equal(typeof body.time, 'number');
  } finally {
    await srv.close();
  }
});

test('/api/health returns 503 when the database is unusable', async () => {
  const srv = await boot();
  try {
    srv.db.db.close();
    const res = await fetch(`${srv.url}/api/health`);
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { ok: false, error: 'database unavailable' });
  } finally {
    await srv.close();
  }
});
