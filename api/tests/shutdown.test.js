// M64 B9 (P0-12) — graceful shutdown v2: stop intents → persist → close
// sockets 1012 → server.close → closeDb, and exit within 2 s with three
// open sockets: in-process (injected exit) and as a real child process.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { openDb } from '../db/database.js';
import { startMultiplayerServer } from '../multiplayer.js';
import { tempRoot, quiet, api } from './helpers/server.js';
import { TestClient, closed } from './helpers/ws.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const { root, cleanup } = tempRoot('cf-shutdown-');
after(cleanup);

async function threeSockets(url) {
  const room = (await api(url, '/api/rooms', { method: 'POST', body: {} })).body;
  const tokens = [room.dmToken];
  for (const name of ['A', 'B']) {
    tokens.push((await api(url, '/api/rooms/join', { method: 'POST', body: { code: room.code, displayName: name } })).body.token);
  }
  const clients = [];
  for (const t of tokens) clients.push(await TestClient.connect(url, t));
  return clients;
}

test('SIGTERM with 3 open sockets: 1012 to every client, DB closed, exit(0) within 2 s', async () => {
  const db = await openDb(join(mkdtempSync(join(root, 'in-')), 'x.db'), { log: quiet });
  const before = process.listenerCount('SIGTERM');
  let resolveExit;
  const exited = new Promise(r => { resolveExit = r; });
  const order = [];
  const srv = await startMultiplayerServer({
    db, env: { NODE_ENV: 'test' }, port: 0, host: '127.0.0.1',
    log: (level, msg) => { if (/shutdown/.test(msg)) order.push(msg); },
    serverOpts: { handleSignals: true, exit: (code) => resolveExit(code) }
  });
  const clients = await threeSockets(srv.url);
  const codes = clients.map(c => closed(c.ws));
  const t0 = Date.now();
  process.emit('SIGTERM', 'SIGTERM');
  assert.equal(await exited, 0);
  const ms = Date.now() - t0;
  assert.ok(ms < 2000, `exited in ${ms} ms`);
  assert.deepEqual((await Promise.all(codes)).map(c => c.code), [1012, 1012, 1012]);
  for (const c of clients) assert.ok(c.of('room.closing').length === 1, 'room.closing broadcast first');
  assert.equal(srv.httpServer.listening, false);
  assert.equal(db.db.open, false);
  assert.equal(process.listenerCount('SIGTERM'), before);
  assert.ok(order.includes('shutdown complete'));
});

test('intents are refused once shutdown starts', async () => {
  const db = await openDb(join(mkdtempSync(join(root, 'stop-')), 'x.db'), { log: quiet });
  const srv = await startMultiplayerServer({ db, env: { NODE_ENV: 'test' }, port: 0, host: '127.0.0.1', log: quiet });
  const [dm] = await threeSockets(srv.url);
  const room = srv.registry.all()[0];
  room.closing = true;   // the first step of shutdown, observed in isolation
  const r = await dm.send('dm.roll.arm', { rollKind: 'attack', value: 3 });
  assert.equal(r.p.code, 'E_STALE');
  room.closing = false;
  await srv.close();
});

function freePort() {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

test('child process: node api/server.js exits 0 within 2 s of SIGTERM with 3 sockets open', async () => {
  const port = await freePort();
  const dataDir = mkdtempSync(join(root, 'child-'));
  const child = spawn(process.execPath, [join(HERE, '..', 'server.js')], {
    env: { ...process.env, NODE_ENV: 'test', CF_MULTIPLAYER: '1', CF_DATA_DIR: dataDir, CF_DB_PATH: '', PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const exit = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  try {
    await new Promise((resolve, reject) => {
      let buf = '';
      const timer = setTimeout(() => reject(new Error(`server did not start: ${buf}`)), 10_000);
      child.stdout.on('data', (d) => {
        buf += d;
        if (buf.includes('API listening')) { clearTimeout(timer); resolve(); }
      });
      child.stderr.on('data', (d) => { buf += d; });
    });
    const url = `http://127.0.0.1:${port}`;
    const clients = await threeSockets(url);
    const codes = clients.map(c => closed(c.ws));
    const t0 = Date.now();
    child.kill('SIGTERM');
    const { code } = await exit;
    const ms = Date.now() - t0;
    assert.equal(code, 0);
    assert.ok(ms < 2000, `exited in ${ms} ms`);
    assert.deepEqual((await Promise.all(codes)).map(c => c.code), [1012, 1012, 1012]);
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
    await exit;
  }
});
