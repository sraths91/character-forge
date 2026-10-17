// M64 W5 — GET /api/characters/:ddbId access (the sheet leak fix).
//
// Single-player: the browser session that imported a character (httpOnly
// cf_session cookie set by POST /api/import) gets the full sheet; anyone
// else gets it with rules prose stripped. Multiplayer: a member token
// serves only characters of the caller's room — full for the DM, the
// importer and the seat controller, prose-stripped for other members —
// and without a token only the importing session is served.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';

import { startServer } from '../start.js';
import { startMultiplayerServer } from '../multiplayer.js';
import { stripSheetProse, IMPORT_SESSION_COOKIE } from '../app.js';
import { tempRoot, tempDb, quiet, ddbFixture, api } from './helpers/server.js';

const { root, cleanup } = tempRoot('cf-chars-');
after(cleanup);

const LOOSE = { roomCreate: { windowMs: 60_000, max: 1000 }, roomJoin: { windowMs: 60_000, max: 1000 } };

/** The cf_session cookie a response set, as a request `cookie` header. */
function cookieOf(res) {
  const set = res.headers.get('set-cookie') || '';
  const m = new RegExp(`${IMPORT_SESSION_COOKIE}=([^;]+)`).exec(set);
  return m ? `${IMPORT_SESSION_COOKIE}=${m[1]}` : null;
}
const hasProse = (sheet) => JSON.stringify(sheet).includes('"description"');

test('stripSheetProse removes description / snippet at any depth and keeps mechanics', () => {
  const s = { name: 'F', classFeatures: [{ name: 'Second Wind', description: 'x', uses: { max: 1 } }], spells: { 1: [{ name: 'Shield', snippet: 'y' }] }, equipment: { mainhand: { name: 'Longsword' } } };
  assert.deepEqual(stripSheetProse(s), { name: 'F', classFeatures: [{ name: 'Second Wind', uses: { max: 1 } }], spells: { 1: [{ name: 'Shield' }] }, equipment: { mainhand: { name: 'Longsword' } } });
  assert.ok(s.classFeatures[0].description, 'the input is not mutated');
});

test('single-player: the importing session gets the full sheet, everyone else prose-stripped', async () => {
  const { db } = await tempDb(root);
  const srv = await startServer({ db, port: 0, host: '127.0.0.1', env: { NODE_ENV: 'test' }, log: quiet });
  try {
    const imp = await api(srv.url, '/api/import', { method: 'POST', body: { json: ddbFixture('fighter-l5') } });
    assert.equal(imp.status, 200);
    const cookie = cookieOf(imp);
    assert.ok(cookie, 'the import sets the session cookie');
    assert.match(imp.headers.get('set-cookie'), /HttpOnly/i);
    const id = encodeURIComponent(imp.body.character.id);

    const mine = await api(srv.url, `/api/characters/${id}`, { headers: { cookie } });
    assert.equal(mine.status, 200);
    assert.ok(hasProse(mine.body.character));
    assert.equal(mine.body.prose, undefined);

    const anon = await api(srv.url, `/api/characters/${id}`);
    assert.equal(anon.status, 200, 'single-player still serves the sheet');
    assert.equal(anon.body.prose, 'stripped');
    assert.equal(hasProse(anon.body.character), false);
    assert.equal(anon.body.character.equipment.mainhand.name, mine.body.character.equipment.mainhand.name);

    const other = await api(srv.url, `/api/characters/${id}`, { headers: { cookie: `${IMPORT_SESSION_COOKIE}=${'z'.repeat(43)}` } });
    assert.equal(other.body.prose, 'stripped', 'another session is not the importer');

    // A re-import from the same session keeps one cookie.
    const again = await api(srv.url, '/api/import', { method: 'POST', body: { json: ddbFixture('fighter-l5') }, headers: { cookie } });
    assert.equal(cookieOf(again), null);
    assert.equal((await api(srv.url, '/api/characters/nope')).status, 404);
  } finally { await srv.close(); }
});

test('multiplayer: token required; room-scoped; full for DM / importer / seat, stripped for other members', async () => {
  const { db } = await tempDb(root);
  const srv = await startMultiplayerServer({ db, env: { NODE_ENV: 'test', CF_MULTIPLAYER: '1', CF_ENGINE: 'stub' }, port: 0, host: '127.0.0.1', log: quiet, appOpts: { limits: LOOSE } });
  try {
    const room = (await api(srv.url, '/api/rooms', { method: 'POST', body: {} })).body;
    const join = async (code, name) => (await api(srv.url, '/api/rooms/join', { method: 'POST', body: { code, displayName: name } })).body;
    const p1 = await join(room.code, 'P1');
    const p2 = await join(room.code, 'P2');
    const imp = await api(srv.url, `/api/import?room=${room.roomId}`, { method: 'POST', token: p1.token, body: { json: ddbFixture('fighter-l5') } });
    assert.equal(imp.status, 200);
    const cookie = cookieOf(imp);
    const id = encodeURIComponent(imp.body.character.id);
    const get = (opts) => api(srv.url, `/api/characters/${id}`, opts);

    // No token: only the importing browser.
    assert.equal((await get()).status, 401);
    assert.equal((await api(srv.url, '/api/characters/unknown')).status, 401, 'no existence oracle without a token');
    const sameBrowser = await get({ headers: { cookie } });
    assert.equal(sameBrowser.status, 200);
    assert.ok(hasProse(sameBrowser.body.character));

    // Tokens: DM and importer full; another member stripped; bad token 401.
    for (const token of [room.dmToken, p1.token]) {
      const r = await get({ token });
      assert.equal(r.status, 200);
      assert.ok(hasProse(r.body.character));
    }
    const teammate = await get({ token: p2.token });
    assert.equal(teammate.status, 200);
    assert.equal(teammate.body.prose, 'stripped');
    assert.equal(hasProse(teammate.body.character), false);
    assert.ok(teammate.body.character.equipment, 'enough to bake the sprite');
    assert.equal((await get({ token: 'not-a-token' })).status, 401);

    // The seat controller gets it in full even when someone else imported it.
    const seat = await api(srv.url, `/api/rooms/${room.roomId}/seats/2/claim`, { method: 'POST', token: p2.token, body: { characterId: imp.body.character.id } });
    assert.equal(seat.status, 200, JSON.stringify(seat.body));
    assert.ok(hasProse((await get({ token: p2.token })).body.character));

    // Another room's members never see it.
    const other = (await api(srv.url, '/api/rooms', { method: 'POST', body: {} })).body;
    assert.equal((await get({ token: other.dmToken })).status, 404);
    const stranger = await join(other.code, 'S');
    assert.equal((await get({ token: stranger.token })).status, 404);
  } finally { await srv.close(); }
});
