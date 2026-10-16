/**
 * M64 C9 — play.html app routing over the fake transport, driven through
 * the views in a fake DOM: the DM creates a room, a player joins and
 * claims, the DM sets up and starts, both land on the battle screen
 * (the DM with the panel); disposing leaves no listener behind.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPlayApp, DEMO_CHARACTERS } from '../js/play.js';
import { createFakeServer, demoCharacter } from '../js/client/fake-transport.js';
import { fitToGrid, createCamera, worldToScreen } from '../js/map/camera.js';
import { createFakeDom } from './helpers/fake-dom.js';
import { manualTimers, manualRaf, flush } from './helpers/client-fixtures.js';

async function until(cond, label, rounds = 300) {
  for (let i = 0; i < rounds; i++) {
    if (cond()) return;
    await flush(2);
  }
  assert.fail(`timed out waiting for ${label}`);
}

function app(server, dom, timers) {
  const root = dom.root();
  const raf = manualRaf();
  const prompts = [];
  const a = createPlayApp({
    root,
    fetch: server.fetch,
    WebSocketCtor: server.WebSocket,
    wsUrl: 'ws://fake/ws',
    storage: null,
    deps: {
      render: async () => ({ needsRedraw: false }),
      raf: raf.raf, caf: raf.caf, timers,
      wsOptions: { timers },
      cinema: { async setActors() {}, resetHp() {}, playRound: () => Promise.resolve() },
      calibrateEncounter: async () => ({ iterations: 1, winRate: 1, lossRate: 0, drawRate: 0, lethality: 0, deathToll: 0, difficulty: { label: 'easy', encounterXp: 25 } }),
      promptReaction: (o) => { prompts.push(o); return Promise.resolve(false); }
    }
  });
  return { a, root, raf, prompts };
}

test('play: DM creates, player joins and claims, DM sets up and starts — both reach battle', async () => {
  const timers = manualTimers();
  const server = createFakeServer({ characters: [demoCharacter('c-ilsa', 'Ilsa', { cls: 'Wizard', spellSlots: { 1: 2 } })], timers });
  const dom = createFakeDom();
  const dm = app(server, dom, timers);
  const pl = app(server, dom, timers);
  await dm.a.start();
  await pl.a.start();
  assert.equal(dm.a.screen, 'lobby');

  dom.byAction(dm.root, 'create')[0].click();
  await until(() => dm.a.session?.store.getState().synced, 'DM connected');
  const code = dm.a.session.store.getState().room.code;
  assert.match(code, /^[0-9A-Z]{6}$/);
  assert.equal(dom.docListeners(), 0, 'no document / window listeners in the lobby');

  server.shareCharacter(dm.a.session.store.getState().room.id, 'c-ilsa');   // what POST /api/import?room does

  const [codeIn, nameIn] = dom.findAll(pl.root, n => n.tagName === 'INPUT' && (n.name === 'code' || n.name === 'displayName'));
  codeIn.value = code;
  nameIn.value = 'Robin';
  dom.byAction(pl.root, 'join')[0].click();
  await until(() => pl.a.session?.store.getState().synced, 'player connected');
  pl.a.actions.openSetup();   // a player cannot reach setup: routing keeps the lobby
  assert.equal(pl.a.screen, 'lobby');
  await until(() => dom.byAction(pl.root, 'claim').length === 1, 'claim button');
  dom.byAction(pl.root, 'claim')[0].click();
  await until(() => dom.byAction(dm.root, 'open-setup').length && !dom.byAction(dm.root, 'open-setup')[0].disabled, 'DM can open setup');

  dom.byAction(dm.root, 'open-setup')[0].click();
  assert.equal(dm.a.screen, 'setup');
  dom.byAction(dm.root, 'arm-preset').find(b => b.dataset.slug === 'goblin').click();
  await dm.raf.frame();
  const cam = fitToGrid(createCamera({ zoom: 1, minZoom: 0.1, maxZoom: 4, viewW: 640, viewH: 420 }), 12, 8, 64, { padding: 8 });
  const at = worldToScreen(cam, 4 * 64 + 32, 6 * 64 + 32);
  const canvas = dom.findAll(dm.root, n => n.tagName === 'CANVAS')[0];
  dom.fire(canvas, 'pointerdown', { clientX: at.x, clientY: at.y, button: 0 });
  dom.byAction(dm.root, 'start')[0].click();
  await until(() => dm.a.screen === 'battle' && pl.a.screen === 'battle', 'both on the battle screen');
  assert.ok(dom.findAll(dm.root, n => n.tagName === 'ASIDE' && /play-dm-panel/.test(n.className)).length, 'DM panel beside the battle');
  assert.equal(dom.findAll(pl.root, n => /play-dm-panel/.test(n.className)).length, 0, 'players get no DM panel');
  const enc = pl.a.session.store.getState().encounter;
  assert.deepEqual(Object.values(enc.entities).map(e => e.kind).sort(), ['monster', 'pc']);
  assert.equal(server.invalid.length, 0);

  dm.a.dispose();
  pl.a.dispose();
  assert.equal(dom.activeListeners(), 0, 'disposing removes every listener');
  assert.equal(dom.docListeners(), 0);
});

test('play: the demo party parses into valid sheets', () => {
  assert.equal(DEMO_CHARACTERS.length, 3);
  for (const c of DEMO_CHARACTERS) assert.ok(c.id && c.name && c.hp.max > 0 && c.equipment.mainhand.name);
});
