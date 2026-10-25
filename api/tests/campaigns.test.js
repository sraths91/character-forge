// M65 B22 — campaign authoring API: campaign key auth, node CRUD under the
// H21 graph check, encounter templates (incl. saved from a room and
// rendered in another), assets via image-sniff with a per-campaign quota,
// and JSON export / import with the SRD attribution and no DDB prose.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PNG } from 'pngjs';

import { createApp } from '../app.js';
import { startServer } from '../start.js';
import { SRD_ATTRIBUTION, stripDdbProse } from '../lib/licensing.js';
import { SHARED_VALIDATORS } from '../campaigns/graph.js';
import { validateClientMessage, PROTOCOL_VERSION } from '../../src/js/shared/protocol.js';
import { tempRoot, tempDb, quiet, api } from './helpers/server.js';

const { root, cleanup } = tempRoot('cf-campaigns-');
after(cleanup);

function realPng(w, h, fill = 200) {
  const png = new PNG({ width: w, height: h });
  png.data.fill(fill);
  return PNG.sync.write(png);
}
const GIF = Buffer.from('GIF89a\x01\x00\x01\x00\x00\x00\x00;', 'latin1');

async function boot(campaignOpts = {}) {
  const { dir, db } = await tempDb(root);
  const app = createApp({ db, env: { NODE_ENV: 'test' }, dataDir: dir, log: quiet, campaignOpts });
  const srv = await startServer({ db, port: 0, host: '127.0.0.1', app, log: quiet });
  return { db, dir, ...srv, campaigns: srv.app.locals.campaigns, rooms: srv.app.locals.rooms };
}
async function withServer(fn, opts) {
  const s = await boot(opts);
  try { await fn(s); } finally { await s.close(); }
}
async function newCampaign(s, name = 'The Sunless Keep') {
  const r = await api(s.url, '/api/campaigns', { method: 'POST', body: { name } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { cid: r.body.campaignId, key: r.body.campaignKey };
}
const restNode = (id, o = {}) => ({ id, kind: 'rest', title: `Rest ${id}`, payload: { type: 'short' }, next: [], ...o });
const putBytes = (s, path, bytes, { token, type = 'image/png', headers = {} } = {}) => fetch(s.url + path, {
  method: 'PUT', body: bytes, headers: { authorization: `Bearer ${token}`, 'content-type': type, ...headers }
}).then(async r => ({ status: r.status, body: await r.json() }));
const colorSetup = () => ({ map: { kind: 'color', color: '#335533' }, grid: { cols: 8, rows: 6 }, monsters: [{ id: 'gob', slug: 'goblin', name: 'Goblin' }], placements: { gob: { col: 5, row: 2 } } });

test('POST /api/campaigns returns a 256-bit key once and stores only its hash', async () => {
  await withServer(async (s) => {
    const { cid, key } = await newCampaign(s);
    assert.match(key, /^[A-Za-z0-9_-]{43}$/, '32 bytes, base64url');
    const row = s.db.db.prepare('SELECT * FROM campaigns WHERE id = ?').get(cid);
    assert.equal(row.owner_user_id, null);
    assert.ok(!JSON.stringify(row).includes(key), 'the key itself is never stored');
    assert.equal((await api(s.url, '/api/campaigns', { method: 'POST', body: { name: '' } })).status, 400);
    assert.equal((await api(s.url, '/api/campaigns', { method: 'POST', body: { name: 'x'.repeat(81) } })).status, 400);
    const got = await api(s.url, `/api/campaigns/${cid}`, { token: key });
    assert.equal(got.status, 200);
    assert.equal(got.body.campaign.name, 'The Sunless Keep');
    assert.equal(got.body.campaign.ruleset, 'srd-5.1');
    assert.deepEqual([got.body.nodes, got.body.templates, got.body.assets], [[], [], []]);
  });
});

test('every campaign route answers 401 to a missing, wrong or other campaign\'s key', async () => {
  await withServer(async (s) => {
    const a = await newCampaign(s, 'A');
    const b = await newCampaign(s, 'B');
    const routes = [
      ['GET', ''], ['PATCH', ''], ['DELETE', ''], ['GET', '/validate'], ['GET', '/nodes'], ['POST', '/nodes'],
      ['PUT', '/nodes/n1'], ['DELETE', '/nodes/n1'], ['PUT', '/graph'], ['GET', '/templates'], ['POST', '/templates'],
      ['POST', '/templates/from-room'], ['GET', '/templates/t1'], ['PUT', '/templates/t1'], ['DELETE', '/templates/t1'],
      ['POST', '/templates/t1/instantiate'], ['GET', '/assets'], ['DELETE', '/assets/a1'], ['GET', '/export']
    ];
    for (const [method, path] of routes) {
      for (const token of [undefined, 'A'.repeat(43), b.key]) {
        const r = await api(s.url, `/api/campaigns/${a.cid}${path}`, { method, token, ...(method === 'GET' || method === 'DELETE' ? {} : { body: {} }) });
        assert.equal(r.status, 401, `${method} ${path} with ${token ? 'a bad' : 'no'} key`);
        assert.equal(r.body.code, 'UNAUTHENTICATED');
      }
    }
    const up = await putBytes(s, `/api/campaigns/${a.cid}/assets`, realPng(4, 4), { token: b.key });
    assert.equal(up.status, 401, 'an upload with the wrong key is refused before the body is read');
    assert.equal((await api(s.url, `/api/campaigns/${a.cid}`, { token: a.key })).status, 200);
  });
});

test('PATCH /api/campaigns/:cid renames, sets settings, archives; DELETE removes the campaign and its files', async () => {
  await withServer(async (s) => {
    const { cid, key } = await newCampaign(s);
    let r = await api(s.url, `/api/campaigns/${cid}`, { method: 'PATCH', token: key, body: { name: 'Renamed', archived: true } });
    assert.equal(r.status, 200);
    assert.equal(r.body.campaign.name, 'Renamed');
    assert.ok(r.body.campaign.archivedAt > 0);
    r = await api(s.url, `/api/campaigns/${cid}`, { method: 'PATCH', token: key, body: { archived: false } });
    assert.equal(r.body.campaign.archivedAt, null);
    assert.equal((await api(s.url, `/api/campaigns/${cid}`, { method: 'PATCH', token: key, body: { settings: 'loud' } })).status, 422);
    assert.equal((await api(s.url, `/api/campaigns/${cid}`, { method: 'PATCH', token: key, body: { archived: 'yes' } })).status, 400);

    const up = await putBytes(s, `/api/campaigns/${cid}/assets`, realPng(8, 8), { token: key });
    assert.equal(up.status, 201);
    const file = join(s.dir, 'campaigns', cid, `${up.body.asset.sha256}.png`);
    assert.ok(existsSync(file));
    await api(s.url, `/api/campaigns/${cid}/nodes`, { method: 'POST', token: key, body: restNode('n1', { start: true }) });
    assert.equal((await api(s.url, `/api/campaigns/${cid}`, { method: 'DELETE', token: key })).status, 200);
    assert.equal(existsSync(file), false, 'the campaign directory is removed');
    assert.equal(s.db.db.prepare('SELECT COUNT(*) AS n FROM campaign_nodes').get().n, 0, 'nodes cascade');
    assert.equal((await api(s.url, `/api/campaigns/${cid}`, { token: key })).status, 401, 'the key is dead with its campaign');
  });
});

test('node CRUD: saves validated by the graph check; a dangling edge is 422; authoring gaps are warnings', async () => {
  await withServer(async (s) => {
    const { cid, key } = await newCampaign(s);
    const base = `/api/campaigns/${cid}`;
    let r = await api(s.url, `${base}/nodes`, { method: 'POST', token: key, body: restNode('camp', { start: true }) });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.deepEqual(r.body.node, { id: 'camp', kind: 'rest', title: 'Rest camp', ord: 0, start: true, payload: { type: 'short' }, next: [] });
    assert.equal(r.body.validation.ready, true);

    // A second node, not linked yet: saved, flagged unreachable.
    r = await api(s.url, `${base}/nodes`, { method: 'POST', token: key, body: restNode('inn') });
    assert.equal(r.status, 201);
    assert.equal(r.body.node.ord, 1, 'ord defaults to the end');
    assert.equal(r.body.validation.ok, true);
    assert.equal(r.body.validation.ready, false);
    assert.ok(r.body.validation.warnings.some(w => w.code === 'unreachable'));

    // A dangling edge: 422 with the ref error; nothing written.
    r = await api(s.url, `${base}/nodes`, { method: 'POST', token: key, body: restNode('road', { next: [{ to: 'ghost' }] }) });
    assert.equal(r.status, 422);
    assert.equal(r.body.code, 'INVALID_GRAPH');
    assert.ok(r.body.errors.some(e => e.code === 'ref'), JSON.stringify(r.body.errors));
    assert.equal((await api(s.url, `${base}/nodes`, { token: key })).body.nodes.length, 2);

    // An unknown kind / a duplicate id / a server-assigned id.
    r = await api(s.url, `${base}/nodes`, { method: 'POST', token: key, body: { ...restNode('x'), kind: 'dungeon' } });
    assert.equal(r.status, 422);
    assert.ok(r.body.errors.some(e => e.code === 'enum'));
    assert.equal((await api(s.url, `${base}/nodes`, { method: 'POST', token: key, body: restNode('inn') })).status, 409);
    r = await api(s.url, `${base}/nodes`, { method: 'POST', token: key, body: { kind: 'rest', title: 'Anon', payload: { type: 'long' }, next: [] } });
    assert.equal(r.status, 201);
    assert.match(r.body.node.id, /^n_/);
    assert.equal((await api(s.url, `${base}/nodes/${r.body.node.id}`, { method: 'DELETE', token: key })).status, 200);

    // Link camp → inn: ready.
    r = await api(s.url, `${base}/nodes/camp`, { method: 'PUT', token: key, body: restNode('camp', { start: true, next: [{ to: 'inn', label: 'Onward' }] }) });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.node.next, [{ to: 'inn', label: 'Onward' }]);
    assert.equal(r.body.validation.ready, true);
    assert.equal((await api(s.url, `${base}/nodes/camp`, { method: 'PUT', token: key, body: restNode('other') })).status, 400, 'body id must match');
    assert.equal((await api(s.url, `${base}/nodes/nope`, { method: 'PUT', token: key, body: restNode('nope') })).status, 404);

    // Deleting inn would leave camp's edge dangling: 422.
    r = await api(s.url, `${base}/nodes/inn`, { method: 'DELETE', token: key });
    assert.equal(r.status, 422);
    assert.ok(r.body.errors.some(e => e.code === 'ref'));
    assert.equal((await api(s.url, `${base}/nodes/nope`, { method: 'DELETE', token: key })).status, 404);

    // Moving the start flag clears the old one.
    r = await api(s.url, `${base}/nodes/inn`, { method: 'PUT', token: key, body: restNode('inn', { start: true, next: [{ to: 'camp' }] }) });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const nodes = (await api(s.url, `${base}/nodes`, { token: key })).body.nodes;
    assert.deepEqual(nodes.filter(n => n.start).map(n => n.id), ['inn']);
    assert.equal((await api(s.url, `${base}/validate`, { token: key })).body.validation.ready, true);
  });
});

test('PUT /graph replaces every node at once (cycles allowed) and refuses a dangling edge', async () => {
  await withServer(async (s) => {
    const { cid, key } = await newCampaign(s);
    const base = `/api/campaigns/${cid}`;
    await api(s.url, `${base}/nodes`, { method: 'POST', token: key, body: restNode('old', { start: true }) });
    const graph = [restNode('a', { start: true, next: [{ to: 'b' }] }), restNode('b', { next: [{ to: 'a' }] })];
    let r = await api(s.url, `${base}/graph`, { method: 'PUT', token: key, body: { nodes: graph } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.nodes.map(n => [n.id, n.ord]), [['a', 0], ['b', 1]]);
    assert.equal(r.body.validation.ready, true);
    r = await api(s.url, `${base}/graph`, { method: 'PUT', token: key, body: { nodes: [restNode('a', { next: [{ to: 'zzz' }] })] } });
    assert.equal(r.status, 422);
    assert.deepEqual((await api(s.url, `${base}/nodes`, { token: key })).body.nodes.map(n => n.id), ['a', 'b'], 'unchanged after a refused save');
    assert.equal((await api(s.url, `${base}/graph`, { method: 'PUT', token: key, body: { nodes: 'x' } })).status, 400);
  });
});

test('templates: create, list, get, update, delete; setups are protocol-checked and image maps must be portable', async () => {
  await withServer(async (s) => {
    const { cid, key } = await newCampaign(s);
    const base = `/api/campaigns/${cid}/templates`;
    let r = await api(s.url, base, { method: 'POST', token: key, body: { name: 'Goblin ambush', setup: colorSetup() } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const tid = r.body.template.id;
    assert.deepEqual(r.body.template.setup, colorSetup());
    assert.equal(r.body.template.setupV, 1);
    assert.equal((await api(s.url, base, { token: key })).body.templates.length, 1);
    assert.equal((await api(s.url, `${base}/${tid}`, { token: key })).body.template.name, 'Goblin ambush');
    r = await api(s.url, `${base}/${tid}`, { method: 'PUT', token: key, body: { name: 'Goblin den' } });
    assert.equal(r.body.template.name, 'Goblin den');
    assert.deepEqual(r.body.template.setup, colorSetup());

    const bad = await api(s.url, base, { method: 'POST', token: key, body: { name: 'x', setup: { map: null, monsters: [], placements: {} } } });
    assert.equal(bad.status, 422);
    assert.equal(bad.body.code, 'INVALID_SETUP');
    const img = await api(s.url, base, { method: 'POST', token: key, body: { name: 'x', setup: { ...colorSetup(), map: { kind: 'image', imageId: 'map_abc', url: '/api/maps/r/x.png' } } } });
    assert.equal(img.status, 422);
    assert.equal(img.body.code, 'MAP_NOT_PORTABLE');
    const ghost = await api(s.url, base, { method: 'POST', token: key, body: { name: 'x', setup: { ...colorSetup(), map: { kind: 'image', assetId: 'ca_nope' } } } });
    assert.equal(ghost.body.code, 'ASSET_NOT_FOUND');
    assert.equal((await api(s.url, base, { method: 'POST', token: key, body: { name: '', setup: colorSetup() } })).status, 400);

    assert.equal((await api(s.url, `${base}/${tid}`, { method: 'DELETE', token: key })).status, 200);
    assert.equal((await api(s.url, `${base}/${tid}`, { token: key })).status, 404);
  });
});

test('a template saved from a room copies its map into campaign_assets and renders in a different room', async () => {
  await withServer(async (s) => {
    const { cid, key } = await newCampaign(s);
    const roomA = s.rooms.createRoom();
    const roomB = s.rooms.createRoom();
    const player = s.rooms.joinRoom({ code: roomA.code, displayName: 'P' });
    const bytes = realPng(64, 48, 90);
    const map = await putBytes(s, `/api/rooms/${roomA.roomId}/maps`, bytes, { token: roomA.dmToken });
    assert.equal(map.status, 201);
    const tok = await putBytes(s, `/api/rooms/${roomA.roomId}/maps?kind=token`, realPng(32, 32, 10), { token: roomA.dmToken });
    const setup = {
      ...colorSetup(),
      map: { kind: 'image', imageId: map.body.mapId, url: map.body.url, imgW: 64, imgH: 48, calib: { cellPx: 8, offsetX: 0, offsetY: 0 } },
      monsters: [{ id: 'gob', slug: 'goblin', name: 'Goblin', imageUrl: tok.body.url }]
    };
    const from = `/api/campaigns/${cid}/templates/from-room`;
    assert.equal((await api(s.url, from, { method: 'POST', token: key, body: { name: 'Cave', setup } })).status, 401, 'X-Room-Token is required');
    assert.equal((await api(s.url, from, { method: 'POST', token: key, headers: { 'x-room-token': player.token }, body: { name: 'Cave', setup } })).status, 403);
    // Another room's DM cannot lift room A's map.
    const stolen = await api(s.url, from, { method: 'POST', token: key, headers: { 'x-room-token': roomB.dmToken }, body: { name: 'Cave', setup } });
    assert.equal(stolen.status, 422);
    assert.equal(stolen.body.code, 'MAP_NOT_IN_ROOM');

    const r = await api(s.url, from, { method: 'POST', token: key, headers: { 'x-room-token': roomA.dmToken }, body: { name: 'Cave', setup } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const t = r.body.template;
    assert.equal(t.setup.map.imageId, undefined);
    assert.equal(t.setup.map.url, undefined);
    assert.deepEqual(t.setup.map.calib, { cellPx: 8, offsetX: 0, offsetY: 0 });
    assert.equal(t.setup.monsters[0].imageUrl, undefined);
    const assets = (await api(s.url, `/api/campaigns/${cid}/assets`, { token: key })).body.assets;
    const mapAsset = assets.find(a => a.assetId === t.setup.map.assetId);
    const tokAsset = assets.find(a => a.assetId === t.setup.monsters[0].tokenAssetId);
    assert.deepEqual([mapAsset.kind, mapAsset.width, mapAsset.height], ['map', 64, 48]);
    assert.equal(tokAsset.kind, 'token');
    const served = await fetch(s.url + mapAsset.url);
    assert.equal(served.status, 200);
    assert.deepEqual(Buffer.from(await served.arrayBuffer()), bytes);
    assert.ok(existsSync(join(s.dir, 'campaigns', cid, `${mapAsset.sha256}.png`)));

    // Room A deletes its upload: the template does not care.
    await api(s.url, `/api/rooms/${roomA.roomId}/maps/${map.body.mapId}`, { method: 'DELETE', token: roomA.dmToken });

    // Render in room B: the asset is materialised into B's uploaded maps.
    const inst = await api(s.url, `/api/campaigns/${cid}/templates/${t.id}/instantiate`, { method: 'POST', token: key, headers: { 'x-room-token': roomB.dmToken }, body: {} });
    assert.equal(inst.status, 200, JSON.stringify(inst.body));
    const out = inst.body.setup;
    assert.equal(out.map.assetId, undefined);
    assert.match(out.map.url, new RegExp(`^/api/maps/${roomB.roomId}/[a-f0-9]{64}\\.png$`));
    const roomBMaps = (await api(s.url, `/api/rooms/${roomB.roomId}/maps`, { token: roomB.dmToken })).body.maps;
    assert.deepEqual(roomBMaps.map(m => m.mapId).sort(), [out.map.imageId, roomBMaps.find(m => m.kind === 'token').mapId].sort());
    assert.equal(out.monsters[0].imageUrl, roomBMaps.find(m => m.kind === 'token').url);
    const img = await fetch(s.url + out.map.url);
    assert.deepEqual(Buffer.from(await img.arrayBuffer()), bytes, 'room B serves the template\'s map');
    assert.equal(validateClientMessage({ v: PROTOCOL_VERSION, t: 'dm.encounter.setup', cid: 'x', p: out }).ok, true, 'a valid dm.encounter.setup for room B');
    // Twice is idempotent (ux_uploaded_maps_room_sha).
    const again = await api(s.url, `/api/campaigns/${cid}/templates/${t.id}/instantiate`, { method: 'POST', token: key, headers: { 'x-room-token': roomB.dmToken }, body: {} });
    assert.equal(again.body.setup.map.imageId, out.map.imageId);

    // An asset a template uses cannot be deleted.
    const del = await api(s.url, `/api/campaigns/${cid}/assets/${mapAsset.assetId}`, { method: 'DELETE', token: key });
    assert.equal(del.status, 409);
    assert.equal(del.body.code, 'IN_USE');
  });
});

test('asset upload: image-sniff rules, dedupe, per-campaign quota, delete', async () => {
  await withServer(async (s) => {
    const { cid, key } = await newCampaign(s);
    const path = `/api/campaigns/${cid}/assets`;
    let r = await putBytes(s, path, realPng(10, 10), { token: key });
    assert.equal(r.status, 201);
    assert.deepEqual([r.body.asset.kind, r.body.asset.mime, r.body.asset.width], ['map', 'image/png', 10]);
    assert.equal((await putBytes(s, path, realPng(10, 10), { token: key })).status, 200, 'same bytes → the existing asset');
    assert.equal((await putBytes(s, path, GIF, { token: key, type: 'image/gif' })).status, 415);
    assert.equal((await putBytes(s, path, realPng(4, 4), { token: key, type: 'image/jpeg' })).status, 415, 'declared type must match');
    assert.equal((await putBytes(s, `${path}?filename=x.jpg`, realPng(4, 4), { token: key })).status, 415);
    assert.equal((await putBytes(s, `${path}?kind=token`, realPng(1100, 10), { token: key })).status, 422, 'tokens ≤ 1024 px');
    assert.equal((await putBytes(s, `${path}?kind=sprite`, realPng(4, 4), { token: key })).status, 400);
    assert.equal((await putBytes(s, path, Buffer.alloc(0), { token: key })).status, 400);
    r = await putBytes(s, `${path}?kind=token`, realPng(20, 20), { token: key });
    assert.equal(r.status, 201);
    assert.equal(r.body.asset.kind, 'token');
    assert.equal((await putBytes(s, path, realPng(30, 30), { token: key })).status, 409, 'quota: 2 assets');
    const list = (await api(s.url, path, { token: key })).body.assets;
    assert.equal(list.length, 2);
    const file = join(s.dir, 'campaigns', cid, `${list[0].sha256}.png`);
    assert.equal((await api(s.url, `${path}/${list[0].assetId}`, { method: 'DELETE', token: key })).status, 200);
    assert.equal(existsSync(file), false);
    assert.equal((await api(s.url, `${path}/${list[0].assetId}`, { method: 'DELETE', token: key })).status, 404);
    assert.equal((await fetch(`${s.url}/api/campaign-assets/${cid}/nope.png`)).status, 404);
  }, { assetQuota: { maxBytes: 1024 * 1024, maxAssets: 2, maxCampaignBytes: 10 * 1024 * 1024, maxVolumeUse: 0.99 }, statfs: () => ({ blocks: 100, bavail: 50 }) });
});

test('export carries the SRD attribution and no D&D Beyond prose; import rebuilds the campaign under a new key', async () => {
  await withServer(async (s) => {
    const { cid, key } = await newCampaign(s, 'Export me');
    const up = await putBytes(s, `/api/campaigns/${cid}/assets`, realPng(16, 16, 33), { token: key });
    const setup = { ...colorSetup(), map: { kind: 'image', assetId: up.body.asset.assetId, imgW: 16, imgH: 16, calib: { cellPx: 4, offsetX: 0, offsetY: 0 } } };
    const tpl = (await api(s.url, `/api/campaigns/${cid}/templates`, { method: 'POST', token: key, body: { name: 'Crypt', setup } })).body.template;
    await api(s.url, `/api/campaigns/${cid}/graph`, { method: 'PUT', token: key, body: { nodes: [restNode('a', { start: true, next: [{ to: 'b' }] }), restNode('b')] } });
    // Loot carrying an item copied from a D&D Beyond sheet, written below the
    // validator (as a later loot editor might): its prose must not export.
    s.campaigns.store.putNode(cid, {
      id: 'b', kind: 'loot', title: 'Hoard', next: [],
      payload: { templateId: tpl.id, items: [{ origin: 'ddb', name: 'Flame Tongue', description: 'DDB-ONLY PROSE', snippet: 'DDB-SNIPPET' }, { origin: 'dm', name: 'Note', description: 'The DM\'s own words' }] }
    }, 1);

    const r = await fetch(`${s.url}/api/campaigns/${cid}/export`, { headers: { authorization: `Bearer ${key}` } });
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-disposition'), /attachment; filename="Export-me\.campaign\.json"/);
    const doc = await r.json();
    assert.equal(doc.format, 'character-forge/campaign');
    assert.equal(doc.v, 1);
    assert.equal(doc.attribution, SRD_ATTRIBUTION);
    assert.match(doc.attribution, /^This work includes material taken from the System Reference Document 5\.1 \("SRD 5\.1"\) by Wizards of the Coast LLC/);
    const text = JSON.stringify(doc);
    assert.ok(!text.includes('DDB-ONLY PROSE') && !text.includes('DDB-SNIPPET'), 'no DDB prose in the export');
    assert.ok(text.includes('The DM\'s own words'), 'DM-authored text survives');
    assert.ok(!text.includes(key) && !text.includes('owner_key_hash'), 'no key material');
    assert.equal(doc.assets.length, 1);
    assert.deepEqual(Buffer.from(doc.assets[0].data, 'base64'), readFileSync(join(s.dir, 'campaigns', cid, `${up.body.asset.sha256}.png`)));
    const lean = await api(s.url, `/api/campaigns/${cid}/export?assets=0`, { token: key });
    assert.equal(lean.body.assets[0].data, undefined);

    // Import (the stored loot node is not H21-valid once H21 is strict, so
    // import the validator-clean subset).
    const clean = { ...doc, nodes: [restNode('a', { start: true, next: [{ to: 'b' }] }), restNode('b', { payload: { type: 'long' } })] };
    const imp = await api(s.url, '/api/campaigns/import', { method: 'POST', body: clean });
    assert.equal(imp.status, 201, JSON.stringify(imp.body));
    assert.notEqual(imp.body.campaignId, cid);
    assert.notEqual(imp.body.campaignKey, key);
    assert.deepEqual(imp.body.counts, { nodes: 2, templates: 1, assets: 1 });
    const got = (await api(s.url, `/api/campaigns/${imp.body.campaignId}`, { token: imp.body.campaignKey })).body;
    assert.equal(got.campaign.name, 'Export me');
    assert.deepEqual(got.nodes.map(n => n.id), ['a', 'b']);
    assert.equal(got.validation.ready, true);
    const t2 = got.templates[0];
    assert.notEqual(t2.id, tpl.id, 'templates get new ids');
    assert.notEqual(t2.setup.map.assetId, up.body.asset.assetId, 'assets get new ids');
    assert.equal(t2.setup.map.assetId, got.assets[0].assetId, 'and references follow them');
    assert.equal(got.assets[0].sha256, up.body.asset.sha256);
    assert.equal((await fetch(s.url + got.assets[0].url)).status, 200);
    assert.equal((await api(s.url, `/api/campaigns/${cid}`, { token: imp.body.campaignKey })).status, 401, 'the new key opens only the new campaign');

    // Bad documents.
    const dangling = await api(s.url, '/api/campaigns/import', { method: 'POST', body: { ...clean, nodes: [restNode('a', { next: [{ to: 'ghost' }] })] } });
    assert.equal(dangling.status, 422);
    assert.equal(dangling.body.code, 'INVALID_GRAPH');
    assert.ok(dangling.body.errors.some(e => e.code === 'ref'));
    const corrupt = await api(s.url, '/api/campaigns/import', { method: 'POST', body: { ...clean, assets: [{ ...doc.assets[0], sha256: 'f'.repeat(64) }] } });
    assert.equal(corrupt.body.code, 'ASSET_CORRUPT');
    const noData = await api(s.url, '/api/campaigns/import', { method: 'POST', body: lean.body });
    assert.equal(noData.body.code, 'ASSET_DATA_MISSING');
    assert.equal((await api(s.url, '/api/campaigns/import', { method: 'POST', body: { format: 'other', v: 1 } })).body.code, 'BAD_EXPORT');
    const noTarget = await api(s.url, '/api/campaigns/import', { method: 'POST', body: { ...clean, assets: [] } });
    assert.equal(noTarget.body.code, 'ASSET_NOT_FOUND', 'a template naming a missing asset');
    assert.equal(s.db.db.prepare('SELECT COUNT(*) AS n FROM campaigns').get().n, 2, 'failed imports leave nothing behind');
  });
});

test('GET /api/licenses serves the SRD attribution; stripDdbProse only touches D&D Beyond data', async () => {
  await withServer(async (s) => {
    const r = await api(s.url, '/api/licenses');
    assert.equal(r.status, 200);
    assert.equal(r.body.srd.attribution, SRD_ATTRIBUTION);
    assert.equal(r.body.srd.license, 'CC-BY-4.0');
  });
  const input = { text: 'dm', items: [{ source: 'ddb', name: 'X', desc: 'p', notes: 'n', nested: { origin: 'ddb', description: 'q', qty: 1 } }] };
  const out = stripDdbProse(input);
  assert.deepEqual(out, { text: 'dm', items: [{ source: 'ddb', name: 'X', nested: { origin: 'ddb', qty: 1 } }] });
  assert.equal(input.items[0].desc, 'p', 'the input is not mutated');
  assert.equal(typeof SHARED_VALIDATORS, 'boolean');
});
