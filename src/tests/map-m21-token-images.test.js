// M65 E5 / M21 — campaign-authored token images (`statBlock.tokenImageId`
// → the room's upload URL in the projection), the image id in the bake
// key, the image-token steady frame (M7: 0 getImageData), and dead PCs as
// corpses that stay visible, also on the next encounter's map.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  projectBattleView, resolveTokenImage, tokenImageIndex, createAppearanceCache
} from '../js/map/view.js';
import { createTokenCache, imageKeyFor } from '../js/map/token-cache.js';
import { DEAD_MARKER_ALPHA } from '../js/map/token-fx.js';
import { createCamera } from '../js/map/camera.js';
import { renderBattleScene, prepareBattleView } from '../js/sprite/compositor.js';
import { validateEncounterState } from '../js/shared/encounter-state.js';
import { recordingCanvas } from './helpers/mock-canvas.js';

const FIXTURE = () => JSON.parse(readFileSync(new URL('./fixtures/contracts/encounter-state.valid.json', import.meta.url), 'utf8'));
const SHA = 'a'.repeat(64);
const URL_ROOM = `/api/maps/room_run1/${SHA}.webp`;
const ROWS = [
  { mapId: 'map_drakeTok', kind: 'token', url: URL_ROOM, sha256: SHA },
  { mapId: 'map_bg', kind: 'map', url: `/api/maps/room_run1/${'b'.repeat(64)}.png`, sha256: 'b'.repeat(64) },
  { mapId: 'map_evil', kind: 'token', url: 'https://evil.example/x.png', sha256: 'c'.repeat(64) }
];

/** A fixture encounter whose fanatic carries a campaign token image id. */
function campaignEncounter(encounterId, over = {}) {
  const s = FIXTURE();
  s.encounterId = encounterId;
  s.entities['m-fanatic'].statBlock = { ...s.entities['m-fanatic'].statBlock, tokenImageId: 'map_drakeTok' };
  Object.assign(s, over);
  return s;
}

const byId = (view) => Object.fromEntries(view.tokens.map(t => [t.id, t]));

test('EncounterState v1 accepts statBlock.tokenImageId (additive) and rejects junk ids', () => {
  assert.equal(validateEncounterState(campaignEncounter('e1')).ok, true);
  const nul = FIXTURE();
  nul.entities['m-fanatic'].statBlock.tokenImageId = null;
  assert.equal(validateEncounterState(nul).ok, true);
  for (const bad of ['../../app.db', 'a b', '', 'x'.repeat(129), 7]) {
    const s = FIXTURE();
    s.entities['m-fanatic'].statBlock.tokenImageId = bad;
    assert.equal(validateEncounterState(s).ok, false, String(bad));
  }
});

test('tokenImageIndex: rows by mapId and sha256, Map / object forms, unsafe URLs dropped', () => {
  const idx = tokenImageIndex(ROWS);
  assert.equal(idx.get('map_drakeTok'), URL_ROOM);
  assert.equal(idx.get(SHA), URL_ROOM, 'content hash resolves too (asset copied under a new id)');
  assert.equal(idx.has('map_evil'), false);
  assert.equal(idx.has('c'.repeat(64)), false);
  assert.equal(tokenImageIndex(new Map([['k', URL_ROOM], ['bad', '//x/y.png']])).size, 1);
  assert.equal(tokenImageIndex({ k: URL_ROOM }).get('k'), URL_ROOM);
  assert.equal(tokenImageIndex(null).size, 0);
  assert.equal(tokenImageIndex([null, 3, {}]).size, 0);
});

test('resolveTokenImage: the entity imageUrl wins; else statBlock.tokenImageId through any lookup form', () => {
  const own = '/api/maps/room_run1/own.png';
  const e = { imageUrl: own, statBlock: { slug: 'x', tokenImageId: 'map_drakeTok' } };
  assert.deepEqual(resolveTokenImage(e, tokenImageIndex(ROWS)), { url: own, imageId: null });
  const camp = { statBlock: { slug: 'x', tokenImageId: 'map_drakeTok' } };
  const want = { url: URL_ROOM, imageId: 'map_drakeTok' };
  assert.deepEqual(resolveTokenImage(camp, tokenImageIndex(ROWS)), want);
  assert.deepEqual(resolveTokenImage(camp, { map_drakeTok: URL_ROOM }), want);
  assert.deepEqual(resolveTokenImage(camp, (id) => (id === 'map_drakeTok' ? URL_ROOM : null)), want);
  const cache = createAppearanceCache();
  cache.putTokenImages(ROWS);
  assert.deepEqual(resolveTokenImage(camp, cache), want);
  assert.equal(resolveTokenImage(camp, null), null, 'no lookup → LPC look');
  assert.equal(resolveTokenImage({ statBlock: { tokenImageId: 'map_unknown' } }, tokenImageIndex(ROWS)), null);
  assert.equal(resolveTokenImage({ statBlock: { tokenImageId: 'map_evil' } }, { map_evil: '//evil.example/x.png' }), null);
  assert.equal(resolveTokenImage({}, ROWS), null);
});

test('projection: campaign-authored tokens resolve to the room upload in every run encounter', () => {
  const index = tokenImageIndex(ROWS);
  for (const encId of ['run1-node1', 'run1-node3']) {
    const t = byId(projectBattleView(campaignEncounter(encId), null, { tokenImages: index }))['m-fanatic'];
    assert.equal(t.imageUrl, URL_ROOM, encId);
    assert.equal(t.imageId, 'map_drakeTok');
  }
  // Through the appearance cache (render-adapter's existing call shape).
  const cache = createAppearanceCache();
  cache.putTokenImages(ROWS);
  assert.equal(byId(projectBattleView(campaignEncounter('e'), cache))['m-fanatic'].imageUrl, URL_ROOM);
  cache.clear();
  assert.equal('imageUrl' in byId(projectBattleView(campaignEncounter('e'), cache))['m-fanatic'], false);
  // An entity-level imageUrl (DM patch) keeps winning and carries no imageId.
  const patched = campaignEncounter('e');
  patched.entities['m-fanatic'].imageUrl = '/api/maps/room_run1/dm.png';
  const t = byId(projectBattleView(patched, null, { tokenImages: index }))['m-fanatic'];
  assert.equal(t.imageUrl, '/api/maps/room_run1/dm.png');
  assert.equal('imageId' in t, false);
  // No tokenImageId anywhere → the view is unchanged from phase 1.5.
  assert.deepEqual(projectBattleView(FIXTURE(), null, { tokenImages: index }), projectBattleView(FIXTURE()));
});

test('bake key gains the image id', () => {
  const base = { imageUrl: URL_ROOM, hpState: 'healthy' };
  assert.equal(imageKeyFor(base), `img:${URL_ROOM}|-|-|0|healthy`, 'unchanged without an id');
  const a = imageKeyFor({ ...base, imageId: 'map_drakeTok' });
  assert.equal(a, `img:map_drakeTok@${URL_ROOM}|-|-|0|healthy`);
  assert.notEqual(a, imageKeyFor({ ...base, imageId: 'map_other' }));
  const cache = createTokenCache({ bake: async () => ({ canvas: {} }) });
  assert.equal(cache.keyFor({ ...base, imageId: 'map_drakeTok', appearanceKey: 'monster:x' }, { frameIdx: 5 }), a);
});

function fakeBaker() {
  const calls = [];
  return {
    calls,
    bake: async (input, opts) => {
      calls.push({ input, opts });
      return { canvas: { kind: input?.kind || 'lpc', w: 64, h: 64 }, frameCycle: input?.kind === 'token-image' ? 1 : 2 };
    }
  };
}

test('steady frame with image tokens and a corpse: 0 getImageData, ≤ 1 drawImage per token, no bakes', async () => {
  const s = campaignEncounter('steady');
  s.entities['pc-wizard'].status = 'dead';
  s.entities['pc-wizard'].hp = 0;
  const view = projectBattleView(s, { 'fighter-l5': 'a:fighter', 'wizard-l5': 'a:wizard' }, { tokenImages: tokenImageIndex(ROWS) });
  assert.equal(byId(view)['m-fanatic'].imageUrl, URL_ROOM);
  const baker = fakeBaker();
  const tokenCache = createTokenCache(baker);
  const local = {
    camera: createCamera({ zoom: 1, viewW: 1280, viewH: 800, dpr: 2 }),
    tokenCache, resolveAppearance: (key) => ({ look: key }), frameIdx: 0, now: 0
  };
  await prepareBattleView(view, local);
  await prepareBattleView(view, { ...local, frameIdx: 1 });
  assert.ok(baker.calls.some(c => c.input.kind === 'token-image' && c.input.url === URL_ROOM));
  const bakes = baker.calls.length;
  const visible = view.tokens.filter(t => !t.hidden).length;
  for (const frameIdx of [0, 1, 2, 3]) {
    const { canvas, count } = recordingCanvas();
    const res = renderBattleScene(canvas, view, { ...local, frameIdx, now: 10_000 });
    assert.equal(res.pendingBakes, 0, `frame ${frameIdx} fully cached`);
    assert.ok(count('drawImage') <= visible, `drawImage ${count('drawImage')} for ${visible} tokens`);
    assert.equal(count('getImageData'), 0, 'M7 rule');
  }
  assert.equal(baker.calls.length, bakes, 'no bakes in steady state');
  assert.equal(tokenCache.keyFor(byId(view)['m-fanatic']), imageKeyFor(byId(view)['m-fanatic']));
});

/** Alphas the frame drew token bitmaps with (globalAlpha in force at each drawImage). */
function drawAlphas(calls) {
  let alpha = 1;
  const stack = [];
  const out = [];
  for (const c of calls) {
    if (c[0] === 'set:globalAlpha') alpha = c[1];
    else if (c[0] === 'save') stack.push(alpha);
    else if (c[0] === 'restore') alpha = stack.length ? stack.pop() : 1;
    else if (c[0] === 'drawImage') out.push({ alpha, what: c[1] });
  }
  return out;
}

test('a dead PC is a corpse: death fade, then a persistent faint marker, never hidden', async () => {
  const s = FIXTURE();
  s.entities = { 'pc-wizard': s.entities['pc-wizard'] };
  s.initiative = [];
  const wiz = s.entities['pc-wizard'];
  wiz.conditions = [];
  const tokenCache = createTokenCache(fakeBaker());
  const local = { tokenCache, resolveAppearance: () => ({ look: 'wizard' }), frameIdx: 0 };
  const frame = async (state, now) => {
    const view = projectBattleView(state);
    await prepareBattleView(view, { ...local, now });
    const r = recordingCanvas();
    const res = renderBattleScene(r.canvas, view, { ...local, now });
    return { view, res, alphas: drawAlphas(r.calls) };
  };
  const alive = await frame(s, 0);
  assert.deepEqual(alive.alphas.map(a => a.alpha), [1]);
  // Dies at t=1000 (three failures). Even a 'hidden' condition left on the
  // body does not hide the corpse.
  const dead = JSON.parse(JSON.stringify(s));
  Object.assign(dead.entities['pc-wizard'], { hp: 0, status: 'dead', deathSaves: { successes: 0, failures: 3, stable: false }, conditions: ['hidden', 'unconscious'] });
  const f0 = await frame(dead, 1000);
  assert.equal(f0.view.tokens[0].hidden, false);
  assert.equal(f0.alphas.length, 1);
  assert.ok(f0.alphas[0].alpha > 0.95, 'fade starts opaque');
  assert.equal(f0.res.needsRedraw, true, 'fade animates');
  const mid = await frame(dead, 1300);
  assert.ok(mid.alphas[0].alpha < 1 && mid.alphas[0].alpha > DEAD_MARKER_ALPHA);
  const settled = await frame(dead, 5000);
  assert.ok(Math.abs(settled.alphas[0].alpha - DEAD_MARKER_ALPHA) < 1e-9, 'persistent faint marker');
  assert.equal(settled.res.needsRedraw, false);
  // The DM's explicit hidden flag cannot hide a party corpse either; a
  // hidden dead MONSTER stays hidden (phase 1.5 behaviour).
  const flagged = JSON.parse(JSON.stringify(dead));
  flagged.entities['pc-wizard'].hidden = true;
  assert.equal(projectBattleView(flagged).tokens[0].hidden, false);
  const mon = FIXTURE();
  mon.entities['m-goblin'].hidden = true;
  assert.equal(byId(projectBattleView(mon))['m-goblin'].hidden, true);
});

test('next encounter: a run-seeded status:"dead" PC is on the map as a faint corpse at once', async () => {
  // Encounter 2 of the run, a fresh client (late join) and the same client.
  const s = FIXTURE();
  s.encounterId = 'run1-node2';
  s.round = 0;
  s.phase = 'setup';
  s.initiative = [];
  Object.assign(s.entities['pc-wizard'], { hp: 0, status: 'dead', deathSaves: { successes: 0, failures: 3, stable: false }, conditions: [] });
  assert.equal(validateEncounterState(s).ok, true);
  const view = projectBattleView(s, { 'fighter-l5': 'a:fighter', 'wizard-l5': 'a:wizard' });
  const corpse = byId(view)['pc-wizard'];
  assert.equal(corpse.status, 'dead');
  assert.equal(corpse.hidden, false);
  assert.equal(corpse.hpState, 'down');
  const tokenCache = createTokenCache(fakeBaker());
  const local = { tokenCache, resolveAppearance: (key) => ({ look: key }), frameIdx: 0, now: 50 };
  await prepareBattleView(view, local);
  const r = recordingCanvas();
  const res = renderBattleScene(r.canvas, view, local);
  assert.equal(res.cellCount, view.tokens.length, 'the corpse is drawn');
  const alphas = drawAlphas(r.calls);
  assert.equal(alphas.length, view.tokens.length);
  assert.ok(Math.abs(alphas[0].alpha - DEAD_MARKER_ALPHA) < 1e-9, 'first seen dead → faint at once, drawn under the living');
  assert.ok(r.count('rotate') >= 1, 'LPC corpse lies prone');
  assert.equal(r.count('getImageData'), 0);
});
