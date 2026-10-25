// M65 runs over HTTP: starting a run from a campaign (B24), DM recovery
// with the campaign key (B26), the run sheet route and privacy (B27),
// solo rooms (B28). A real multiplayer server on port 0.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';

import { startMultiplayerServer } from '../multiplayer.js';
import { tempRoot, tempDb, quiet, api, ddbFixture } from './helpers/server.js';

const { root, cleanup } = tempRoot('cf-runs-http-');
after(cleanup);

const LOOSE = {
  roomCreate: { windowMs: 60_000, max: 1000 }, roomJoin: { windowMs: 60_000, max: 1000 }, campaignCreate: { windowMs: 60_000, max: 1000 }
};

async function boot() {
  const { db } = await tempDb(root);
  const srv = await startMultiplayerServer({ db, env: { NODE_ENV: 'test', CF_MULTIPLAYER: '1' }, port: 0, host: '127.0.0.1', log: quiet, appOpts: { limits: LOOSE }, janitorOpts: false });
  return { db, srv, url: srv.url };
}

/** A two-node campaign (encounter → rest) authored over the campaigns API. */
async function campaign(url) {
  const c = (await api(url, '/api/campaigns', { method: 'POST', body: { name: 'Goblin road' } })).body;
  const nodes = [
    {
      id: 'n-ambush', kind: 'encounter', title: 'Ambush', start: true,
      payload: { setup: { map: null, grid: { cols: 10, rows: 8 }, monsters: [{ slug: 'goblin', id: 'gob-1' }], placements: { 'gob-1': { col: 6, row: 2 } } } },
      next: [{ to: 'n-camp' }]
    },
    { id: 'n-camp', kind: 'rest', title: 'Camp', payload: { type: 'short' }, next: [] }
  ];
  const put = await api(url, `/api/campaigns/${c.campaignId}/graph`, { method: 'PUT', token: c.campaignKey, body: { nodes } });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  return { cid: c.campaignId, key: c.campaignKey };
}

test('B24 HTTP: POST /api/campaigns/:cid/runs creates the room when none is named; the run waits in the lobby', async () => {
  const { srv, url } = await boot();
  try {
    const { cid, key } = await campaign(url);
    assert.equal((await api(url, `/api/campaigns/${cid}/runs`, { method: 'POST', token: 'nope', body: {} })).status, 401);
    const r = await api(url, `/api/campaigns/${cid}/runs`, { method: 'POST', token: key, body: {} });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.deepEqual(Object.keys(r.body).sort(), ['code', 'currentNodeId', 'dmToken', 'roomId', 'runId', 'status']);
    assert.equal(r.body.status, 'lobby');
    const desc = await api(url, `/api/rooms/${r.body.roomId}`, { token: r.body.dmToken });
    assert.equal(desc.status, 200);
    assert.equal(desc.body.room.code, r.body.code);
    // A second run in the same room is refused.
    const again = await api(url, `/api/campaigns/${cid}/runs`, { method: 'POST', token: key, body: {}, headers: { 'x-room-token': r.body.dmToken } });
    assert.equal(again.status, 409);
  } finally { await srv.close(); }
});

test('B24 HTTP: with X-Room-Token the run starts in that room with its seated party', async () => {
  const { srv, url } = await boot();
  try {
    const { cid, key } = await campaign(url);
    const room = (await api(url, '/api/rooms', { method: 'POST', body: {} })).body;
    const imp = await api(url, `/api/import?room=${room.roomId}`, { method: 'POST', token: room.dmToken, body: { json: ddbFixture('fighter-l5') } });
    assert.equal(imp.status, 200, JSON.stringify(imp.body));
    const seat = await api(url, `/api/rooms/${room.roomId}/seats/1/ai`, { method: 'POST', token: room.dmToken, body: { characterId: String(imp.body.character.id) } });
    assert.equal(seat.status, 200, JSON.stringify(seat.body));
    const r = await api(url, `/api/campaigns/${cid}/runs`, { method: 'POST', token: key, body: { seed: 5 }, headers: { 'x-room-token': room.dmToken } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.deepEqual([r.body.roomId, r.body.status, r.body.currentNodeId, r.body.dmToken], [room.roomId, 'in-node', 'n-ambush', room.dmToken]);
    const run = srv.registry.get(room.roomId).run;
    assert.equal(run.row.campaignId, cid);
    assert.deepEqual(run.row.campaign.nodes.map(n => n.id), ['n-ambush', 'n-camp']);
  } finally { await srv.close(); }
});
