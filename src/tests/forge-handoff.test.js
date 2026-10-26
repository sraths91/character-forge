/**
 * M65 V21 — the forge's "Play at the table" handoff: the setup payload it
 * builds from the forge's scene + queued monsters, the stashed JSON of
 * pasted imports, the sessionStorage hand-over to play.html, and (against
 * a real in-process server) a 2-PC forge party + 2 queued monsters landing
 * in a solo room whose encounter builds from that setup.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PNG } from 'pngjs';

import {
  forgeSetupPayload, handoffToTable, stashForgeJson, forgeJsonFor, archetypeFor, readHandoff, clearHandoff,
  dataUrlBytes, HANDOFF_STORAGE, HANDOFF_MAX_AGE_MS
} from '../js/client/forge-handoff.js';
import { createApi } from '../js/client/api.js';
import { createRoomCreds } from '../js/client/room-creds.js';
import { setupPayload, draftFromSetup } from '../js/client/views/setup.js';
import { validateClientMessage } from '../js/shared/protocol.js';
import { PC_PROFILES } from '../js/scene/ai/pc-profiles.js';
import { startMultiplayerServer } from '../../api/multiplayer.js';
import { tempRoot, tempDb, quiet, api as http } from '../../api/tests/helpers/server.js';
import { TestClient } from '../../api/tests/helpers/ws.js';

const { root, cleanup } = tempRoot('cf-handoff-');
after(cleanup);

function memoryStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k),
    keys: () => [...m.keys()]
  };
}
const ddb = (name) => JSON.parse(readFileSync(new URL(`./fixtures/ddb/${name}.json`, import.meta.url), 'utf8'));
const validSetup = (p) => validateClientMessage({ v: 1, t: 'dm.encounter.setup', cid: '01J00000000000000000000000', p });
const ENCOUNTER = [{ id: 'vm_1', slug: 'goblin', name: 'Goblin' }, { id: 'vm_2', slug: 'goblin', name: 'Goblin 2' }];

test('forgeSetupPayload: generated map, flanking, placements without collisions; protocol-valid and draft round-trip', () => {
  const scene = {
    cols: 12, rows: 8, map: { kind: 'generated', biome: 'forest', seed: 77, color: '#3d5a3d', preset: 'forest' },
    positions: { 'paste:1': { col: 2, row: 3 }, 'paste:2': { col: 10, row: 0 } }, flankingEnabled: true
  };
  const p = forgeSetupPayload({ scene, encounter: ENCOUNTER, seats: [{ seat: 1, forgeId: 'paste:1' }, { seat: 2, forgeId: 'paste:2' }] });
  assert.deepEqual(p.map, { kind: 'generated', biome: 'forest', seed: 77 });
  assert.deepEqual(p.grid, { cols: 12, rows: 8, flankingEnabled: true });
  assert.deepEqual(p.monsters, [{ id: 'm-1', slug: 'goblin', name: 'Goblin' }, { id: 'm-2', slug: 'goblin', name: 'Goblin 2' }]);
  assert.deepEqual(p.placements['pc-1'], { col: 2, row: 3 }, 'a PC keeps its forge position');
  assert.deepEqual(p.placements['pc-2'], { col: 10, row: 0 });
  const cells = Object.values(p.placements).map(c => `${c.col},${c.row}`);
  assert.equal(new Set(cells).size, cells.length, 'no two tokens share a cell (the second goblin would land on pc-2)');
  assert.deepEqual(validSetup(p).errors, []);
  assert.deepEqual(setupPayload(draftFromSetup(p)), p, 'the setup view edits exactly this payload');
});

test('forgeSetupPayload: colour fallback, unknown presets dropped, no flanking key when off, image map calibrated to the grid', () => {
  const p = forgeSetupPayload({ scene: { cols: 10, rows: 7, map: { kind: 'color', color: '#112233' } }, encounter: [{ slug: 'nope', name: 'X' }, ENCOUNTER[0]], seats: [{ seat: 1, forgeId: 'a' }] });
  assert.deepEqual(p.map, { kind: 'color', color: '#112233' });
  assert.equal('flankingEnabled' in p.grid, false);
  assert.deepEqual(p.monsters.map(m => m.slug), ['goblin']);
  assert.deepEqual(p.placements['pc-1'], { col: 1, row: 0 }, 'the arena default: left side');
  const img = forgeSetupPayload({
    scene: { cols: 10, rows: 5, map: { kind: 'image', image: 'data:image/png;base64,AA==' } }, encounter: ENCOUNTER, seats: [],
    image: { mapId: 'map_1', url: '/api/maps/r/x.png', width: 1000, height: 500 }
  });
  assert.deepEqual(img.map, { kind: 'image', imageId: 'map_1', url: '/api/maps/r/x.png', imgW: 1000, imgH: 500, calib: { cellPx: 100, offsetX: 0, offsetY: 0 } });
  assert.equal(forgeSetupPayload({ scene: { cols: 10, rows: 5, map: { kind: 'image', image: 'x' } }, encounter: [], seats: [] }).map.kind, 'color', 'no upload → colour map');
});

test('stashForgeJson / forgeJsonFor; archetypeFor maps the forge AI editor pick; dataUrlBytes', () => {
  const ls = memoryStorage();
  assert.equal(stashForgeJson(ls, 'paste:9', { data: { id: 9 } }), true);
  assert.deepEqual(forgeJsonFor(ls, 'paste:9'), { data: { id: 9 } });
  assert.equal(forgeJsonFor(ls, 'paste:none'), null);
  assert.equal(stashForgeJson(null, 'x', {}), false);
  assert.equal(archetypeFor({}), 'auto');
  const key = Object.keys(PC_PROFILES)[0];
  assert.equal(archetypeFor({ _aiProfile: { archetype: PC_PROFILES[key].archetype } }), key);
  assert.deepEqual([...dataUrlBytes('data:image/png;base64,AAEC').bytes], [0, 1, 2]);
  assert.equal(dataUrlBytes('not a url'), null);
});

test('readHandoff: only for the room code it was made for, and only while fresh', () => {
  const ss = memoryStorage();
  ss.setItem(HANDOFF_STORAGE, JSON.stringify({ code: 'ABC123', roomId: 'r', setup: { map: null }, warnings: ['w'], createdAt: 1000 }));
  assert.deepEqual(readHandoff(ss, 'ABC123', { now: () => 2000 }), { setup: { map: null }, warnings: ['w'] });
  assert.equal(readHandoff(ss, 'ZZZ999', { now: () => 2000 }), null);
  assert.equal(readHandoff(ss, 'ABC123', { now: () => 1000 + HANDOFF_MAX_AGE_MS + 1 }), null);
  clearHandoff(ss);
  assert.equal(readHandoff(ss, 'ABC123', { now: () => 2000 }), null);
});

function pngDataUrl(w, h) {
  const png = new PNG({ width: w, height: h });
  png.data.fill(200);
  return `data:image/png;base64,${PNG.sync.write(png).toString('base64')}`;
}

test('V21 real server: a 2-PC forge party + 2 queued monsters land in a solo room with the right setup', async () => {
  const { db } = await tempDb(root);
  const srv = await startMultiplayerServer({
    db, env: { NODE_ENV: 'test', CF_MULTIPLAYER: '1' }, port: 0, host: '127.0.0.1', log: quiet, janitorOpts: false
  });
  let dm = null;
  try {
    const ls = memoryStorage();
    const ss = memoryStorage();
    stashForgeJson(ls, 'paste:fighter', ddb('fighter-l5'));
    stashForgeJson(ls, 'paste:wizard', ddb('wizard-l5'));
    const party = [
      { id: 'paste:fighter', name: 'Fighter', _aiProfile: { archetype: PC_PROFILES.fighter.archetype } },
      { id: 'paste:wizard', name: 'Wizard' }
    ];
    const scene = {
      cols: 10, rows: 8, map: { kind: 'image', color: '#3d5a3d', image: pngDataUrl(80, 64) },
      positions: { 'paste:fighter': { col: 1, row: 2 } }, flankingEnabled: true
    };
    const saved = [];
    const r = await handoffToTable({
      createApi: (o) => createApi({ ...o, base: srv.url }), fetch: globalThis.fetch,
      party, encounter: ENCOUNTER, scene,
      roomCreds: createRoomCreds({ session: ss, durable: ls }), jsonStorage: ls, handoffStorage: ss,
      cinemaPick: (id) => (id === 'paste:fighter' ? { style: 'power', swing: 'varied' } : null),
      saveCinemaPick: (id, pick) => saved.push([id, pick])
    });
    assert.deepEqual(r.warnings, []);
    assert.match(r.url, /^\/play\.html\?code=[0-9A-Z]{6}$/);

    // The room: solo (DM drives the seats), both PCs seated as AI seats.
    const creds = createRoomCreds({ session: ss, durable: ls }).active();
    assert.equal(creds.role, 'dm');
    assert.equal(creds.code, r.code);
    const desc = await http(srv.url, `/api/rooms/${r.roomId}`, { token: creds.token });
    assert.equal(desc.status, 200);
    assert.equal(desc.body.room.settings.dmDrivesAiSeats, true, 'a solo room');
    assert.deepEqual(desc.body.seats.map(s => [s.seat, s.characterId]), r.seats.map(s => [s.seat, s.characterId]));
    assert.equal(desc.body.seats.length, 2);
    assert.ok(r.seats.every(s => s.characterId.startsWith(`paste:${r.roomId}:`)), 'pasted JSON imported into the room');
    assert.equal(desc.body.seats[0].aiArchetype, 'fighter', 'the forge AI editor pick');
    assert.deepEqual(saved.map(([id, p]) => [id, p.style]), [[r.seats[0].characterId, 'power']], 'the style pick moves to the room id');

    // The setup payload play.html pre-fills.
    const setup = readHandoff(ss, r.code).setup;
    assert.deepEqual(setup, r.setup);
    assert.deepEqual(setup.monsters.map(m => [m.id, m.slug]), [['m-1', 'goblin'], ['m-2', 'goblin']]);
    assert.equal(setup.grid.flankingEnabled, true);
    assert.deepEqual(setup.placements['pc-1'], { col: 1, row: 2 });
    assert.equal(setup.map.kind, 'image');
    assert.deepEqual([setup.map.imgW, setup.map.imgH, setup.map.calib.cellPx], [80, 64, 8]);
    assert.deepEqual(validSetup(setup).errors, []);

    // And it lands: the server builds the encounter from it, every PC DM-driven.
    dm = await TestClient.connect(srv.url, creds.token, { name: 'dm' });
    const ack = await dm.send('dm.encounter.setup', setup);
    assert.equal(ack.t, 'ack', JSON.stringify(ack.p));
    const created = await dm.find(f => f.t === 'encounter.created');
    const ents = Object.values(created.p.encounter.entities);
    assert.deepEqual(ents.filter(e => e.kind === 'pc').map(e => e.controller.type), ['dm', 'dm']);
    assert.equal(ents.filter(e => e.kind === 'monster').length, 2);
    assert.equal(created.p.encounter.grid.flankingEnabled, true);
    assert.equal(created.p.encounter.map.kind, 'image');
  } finally {
    dm?.close();
    await srv.close();
  }
});

test('V21: a pasted member without stashed JSON is skipped with a warning; nobody importable is an error', async () => {
  const calls = [];
  const fakeApi = () => ({
    createRoom: async (_n, o) => { calls.push(['create', o]); return { roomId: 'r1', code: 'ABC123', dmToken: 'tok_abcdefghijklmnop', mode: 'solo' }; },
    listCharacters: async () => ({ characters: [{ ddbId: '42', name: 'Known' }] }),
    importCharacter: async (_r, b) => { calls.push(['import', b]); return { character: { id: b.characterId } }; },
    aiSeat: async (_r, seat, id, arch) => { calls.push(['seat', seat, id, arch]); return {}; },
    uploadMap: async () => { throw new Error('no'); }
  });
  const ss = memoryStorage();
  const r = await handoffToTable({
    createApi: fakeApi, fetch: () => {}, party: [{ id: '42', name: 'Known' }, { id: '77', name: 'ByUrl' }, { id: 'paste:5', name: 'Lost' }],
    encounter: ENCOUNTER, scene: { cols: 10, rows: 7, map: { kind: 'color', color: '#222222' } },
    roomCreds: createRoomCreds({ session: ss, durable: memoryStorage() }), jsonStorage: memoryStorage(), handoffStorage: ss
  });
  assert.deepEqual(calls[0], ['create', { mode: 'solo' }]);
  assert.deepEqual(calls.filter(c => c[0] === 'import').map(c => c[1]), [{ characterId: '77' }], 'an already-imported character is reused');
  assert.deepEqual(calls.filter(c => c[0] === 'seat').map(c => c.slice(1)), [[1, '42', 'auto'], [2, '77', 'auto']]);
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /Lost: re-paste/);
  await assert.rejects(handoffToTable({
    createApi: fakeApi, fetch: () => {}, party: [{ id: 'paste:5', name: 'Lost' }], encounter: ENCOUNTER, scene: {},
    roomCreds: createRoomCreds({}), jsonStorage: memoryStorage()
  }), /No party member could be brought/);
  await assert.rejects(handoffToTable({ createApi: fakeApi, fetch: () => {}, party: [], encounter: ENCOUNTER, roomCreds: createRoomCreds({}) }), /party member/);
});
