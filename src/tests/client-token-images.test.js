/**
 * M65 1.5 leftover A — campaign token images: the room's `kind: 'token'`
 * uploads (snapshot `room.maps` / `room.tokenImages`, or the play app's
 * `GET /api/rooms/:id/maps` fetch into the appearance cache) reach
 * `projectBattleView` through the render adapter, so a monster whose
 * `statBlock.tokenImageId` names one draws it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../js/client/store.js';
import { createRenderAdapter } from '../js/client/render-adapter.js';
import { tokenImagesOf, tokenImageResolver, tokenUploads } from '../js/client/selectors.js';
import { createAppearanceCache } from '../js/map/view.js';
import { createPlayApp } from '../js/play.js';
import { createFakeDom } from './helpers/fake-dom.js';
import { projectedState, snapshotMsg, manualTimers, manualRaf, flush } from './helpers/client-fixtures.js';

const SHA = 'a'.repeat(64);
const URL_TOK = `/api/maps/r1/${SHA}.png`;
const ROWS = [
  { mapId: 'map-1', kind: 'map', url: `/api/maps/r1/${'b'.repeat(64)}.png`, sha256: 'b'.repeat(64) },
  { mapId: 'tok-1', kind: 'token', url: URL_TOK, sha256: SHA }
];

function encWithToken(id = 'tok-1') {
  const enc = projectedState();
  enc.entities['m-goblin'].statBlock = { ...(enc.entities['m-goblin'].statBlock || {}), tokenImageId: id };
  return enc;
}

function adapterFor(room, opts = {}) {
  const store = createStore({ hashState: null });
  assert.equal(store.apply(snapshotMsg(10, encWithToken(opts.id), { code: 'ABC123', status: 'in-encounter', ...room })), 'applied');
  const raf = manualRaf();
  const adapter = createRenderAdapter({ store, appearanceCache: opts.cache || null, tokenImages: opts.tokenImages || null, timers: manualTimers(), schedulerOpts: { raf: raf.raf, caf: raf.caf }, render: async () => ({ needsRedraw: false }) });
  return { store, adapter };
}

const goblinToken = (adapter) => adapter.view().tokens.find(t => t.id === 'm-goblin');

test('tokenImagesOf: only kind token rows, by id and sha256, memoised per room object', () => {
  const s = { room: { maps: ROWS } };
  const idx = tokenImagesOf(s);
  assert.equal(idx.get('tok-1'), URL_TOK);
  assert.equal(idx.get(SHA), URL_TOK);
  assert.equal(idx.has('map-1'), false, 'battle maps are not token images');
  assert.equal(tokenImagesOf(s), idx, 'same room → same index');
  assert.equal(tokenImagesOf({ room: { tokenImages: [ROWS[1]] } }).get('tok-1'), URL_TOK);
  assert.equal(tokenImagesOf({ room: {} }), null);
  assert.deepEqual(tokenUploads(null), []);
});

test('tokenImageResolver: first source with the id wins; Maps, objects, functions and the cache', () => {
  const cache = createAppearanceCache();
  cache.putTokenImages([{ mapId: 'c', url: '/c.png' }]);
  const r = tokenImageResolver(null, new Map([['a', '/a.png']]), { b: '/b.png' }, (id) => (id === 'd' ? '/d.png' : null), cache);
  assert.deepEqual(['a', 'b', 'c', 'd', 'x'].map(r), ['/a.png', '/b.png', '/c.png', '/d.png', null]);
});

test('render adapter: a campaign monster draws the room token named by statBlock.tokenImageId', () => {
  const { adapter } = adapterFor({ maps: ROWS });
  const tok = goblinToken(adapter);
  assert.equal(tok.imageUrl, URL_TOK);
  assert.equal(tok.imageId, 'tok-1');
  adapter.dispose();
});

test('render adapter: without snapshot rows the appearance cache index resolves after invalidate()', () => {
  const cache = createAppearanceCache();
  const { adapter } = adapterFor({}, { cache });
  assert.equal(goblinToken(adapter).imageUrl, undefined, 'unknown id → LPC look');
  cache.putTokenImages(ROWS.filter(r => r.kind === 'token'));
  adapter.invalidate();
  assert.equal(goblinToken(adapter).imageUrl, URL_TOK);
  adapter.dispose();
});

test('render adapter: the tokenImages option resolves by sha256 too', () => {
  const { adapter } = adapterFor({}, { id: SHA, tokenImages: new Map([[SHA, URL_TOK]]) });
  assert.equal(goblinToken(adapter).imageUrl, URL_TOK);
  adapter.dispose();
});

test('play app: fetches the room uploads and fills the appearance cache with token rows', async () => {
  const dom = createFakeDom();
  const calls = [];
  const fetch = async (url, init) => {
    calls.push(`${init.method} ${url}`);
    if (url === '/api/rooms/r1/maps') return { ok: true, status: 200, json: async () => ({ maps: ROWS }) };
    return { ok: false, status: 404, json: async () => ({ code: 'NOT_FOUND' }) };
  };
  const storage = new Map([['cf-play-creds', JSON.stringify({ roomId: 'r1', code: 'ABC123', token: 't'.repeat(32), role: 'dm' })]]);
  const app = createPlayApp({
    root: dom.root(), fetch, WebSocketCtor: class { constructor() { this.readyState = 0; } close() {} send() {} },
    wsUrl: 'ws://x/ws',
    storage: { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v), removeItem: (k) => storage.delete(k) },
    deps: { timers: manualTimers(), wsOptions: { timers: manualTimers() } }
  });
  const rows = await app.loadTokenImages();
  await flush();
  assert.ok(calls.includes('GET /api/rooms/r1/maps'));
  assert.deepEqual(rows.map(r => r.mapId), ['tok-1']);
  assert.equal(app.appearanceCache.tokenImageUrl('tok-1'), URL_TOK);
  app.dispose();
});
