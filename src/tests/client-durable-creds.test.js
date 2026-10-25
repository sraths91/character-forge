/**
 * M65 C28 — durable room creds per code (close the tab, rejoin, the seat
 * is back; "forget this device"), the SRD attribution footer and About
 * dialog from GET /api/licenses, seat sheets from the run-sheet route with
 * a fallback, and a lint-style guard: no run view calls api.getCharacter,
 * and no client view writes HTML strings.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createPlayApp, SRD_ATTRIBUTION_FALLBACK } from '../js/play.js';
import { createRoomCreds, ROOM_CREDS_STORAGE, SESSION_CREDS_STORAGE, cleanCreds } from '../js/client/room-creds.js';
import { createFakeServer, demoCharacter } from '../js/client/fake-transport.js';
import { seatsOf } from '../js/client/selectors.js';
import { createFakeDom } from './helpers/fake-dom.js';
import { manualTimers, manualRaf, flush } from './helpers/client-fixtures.js';

const ATTR = 'This work includes material taken from the System Reference Document 5.1 ("SRD 5.1") by Wizards of the Coast LLC and available at https://dnd.wizards.com/resources/systems-reference-document. The SRD 5.1 is licensed under the Creative Commons Attribution 4.0 International License available at https://creativecommons.org/licenses/by/4.0/legalcode.';

function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), map: m };
}

async function until(cond, label, rounds = 300) {
  for (let i = 0; i < rounds; i++) {
    if (cond()) return;
    await flush(2);
  }
  assert.fail(`timed out waiting for ${label}`);
}

function app(dom, { fetch, WebSocket, timers, storage, durableStorage }) {
  const root = dom.root();
  const raf = manualRaf();
  const a = createPlayApp({
    root, fetch, WebSocketCtor: WebSocket, wsUrl: 'ws://fake/ws', storage, durableStorage,
    deps: {
      render: async () => ({ needsRedraw: false }), raf: raf.raf, caf: raf.caf, timers, wsOptions: { timers },
      cinema: { async setActors() {}, resetHp() {}, playRound: () => Promise.resolve() },
      calibrateEncounter: async () => ({ difficulty: {} })
    }
  });
  return { a, root };
}

test('room creds: durable per code, the active room per tab, garbage ignored', () => {
  const session = memoryStorage();
  const durable = memoryStorage();
  const rc = createRoomCreds({ session, durable, now: () => 7 });
  assert.equal(rc.remember({ roomId: 'r1', code: 'abc123', token: 'tok_1', role: 'player', displayName: 'Robin' }), true);
  assert.equal(rc.remember({ roomId: 'r2', code: 'nope', token: 'tok_2' }), false, 'not a room code');
  rc.setActive({ roomId: 'r1', code: 'ABC123', token: 'tok_1', role: 'player' });
  assert.deepEqual(createRoomCreds({ session: memoryStorage(), durable }).byCode('abc123'), { roomId: 'r1', code: 'ABC123', token: 'tok_1', role: 'player', displayName: 'Robin', savedAt: 7 });
  assert.equal(createRoomCreds({ session: memoryStorage(), durable }).active(), null, 'a new tab has no active room');
  assert.equal(createRoomCreds({ session, durable }).active().roomId, 'r1');
  rc.forget('ABC123');
  assert.deepEqual(JSON.parse(durable.map.get(ROOM_CREDS_STORAGE)), {});
  assert.equal(cleanCreds({ roomId: 'r', token: 'has spaces' }), null);
  durable.setItem(ROOM_CREDS_STORAGE, '[1,2]');
  assert.deepEqual(createRoomCreds({ durable }).remembered(), []);
  session.setItem(SESSION_CREDS_STORAGE, '{bad');
  assert.equal(createRoomCreds({ session }).active(), null);
});

test('C28: close the tab, rejoin by code, and the seat is back; forget this device', async () => {
  const timers = manualTimers();
  const server = createFakeServer({ characters: [demoCharacter('c-ilsa', 'Ilsa', { cls: 'Wizard' })], timers });
  const dom = createFakeDom();
  const durable = memoryStorage();
  const env = { fetch: server.fetch, WebSocket: server.WebSocket, timers };
  const dm = app(dom, { ...env, storage: memoryStorage(), durableStorage: memoryStorage() });
  await dm.a.start();
  await dm.a.actions.createRoom();
  await until(() => dm.a.session?.store.getState().synced, 'DM connected');
  const roomId = dm.a.session.store.getState().room.id;
  const code = dm.a.session.store.getState().room.code;
  server.shareCharacter(roomId, 'c-ilsa');

  // Tab 1: the player joins and claims seat 1.
  const tab1 = app(dom, { ...env, storage: memoryStorage(), durableStorage: durable });
  await tab1.a.start();
  await tab1.a.actions.joinRoom(code, 'Robin');
  await until(() => tab1.a.session?.store.getState().synced, 'player connected');
  const me = tab1.a.session.store.getState().me.memberId;
  await tab1.a.api.claimSeat(roomId, 1, 'c-ilsa');
  await until(() => seatsOf(tab1.a.session.store.getState())[0].memberId === me, 'seat claimed');
  assert.ok(JSON.parse(durable.map.get(ROOM_CREDS_STORAGE))[code], 'creds kept per room code');
  tab1.a.dispose();   // close the tab

  // Tab 2 (new session storage, same device): the lobby offers the table.
  const tab2 = app(dom, { ...env, storage: memoryStorage(), durableStorage: durable });
  await tab2.a.start();
  assert.equal(tab2.a.screen, 'lobby');
  assert.match(tab2.root.textContent, /Your tables on this device/);
  assert.match(tab2.root.textContent, new RegExp(code));
  dom.byAction(tab2.root, 'rejoin')[0].click();
  await until(() => tab2.a.session?.store.getState().synced, 'rejoined');
  assert.equal(tab2.a.session.store.getState().me.memberId, me, 'the same participant');
  assert.equal(seatsOf(tab2.a.session.store.getState())[0].memberId, me, 'the seat is back');
  tab2.a.dispose();

  // Joining the same code again (no name) is a rejoin too.
  const tab3 = app(dom, { ...env, storage: memoryStorage(), durableStorage: durable });
  await tab3.a.start();
  const [codeIn] = dom.findAll(tab3.root, n => n.tagName === 'INPUT' && n.name === 'code');
  codeIn.value = code.toLowerCase();
  dom.byAction(tab3.root, 'join')[0].click();
  await until(() => tab3.a.session?.store.getState().synced, 'rejoined by code');
  assert.equal(tab3.a.session.store.getState().me.memberId, me);

  // Forget this device: the code's creds are gone and the tab leaves.
  dom.byAction(tab3.root, 'forget-device')[0].click();
  await flush();
  assert.equal(tab3.a.screen, 'lobby');
  assert.equal(JSON.parse(durable.map.get(ROOM_CREDS_STORAGE))[code], undefined);
  assert.doesNotMatch(tab3.root.textContent, /Your tables on this device/);
  tab3.a.dispose();
  dm.a.dispose();
  assert.equal(dom.activeListeners(), 0, 'every listener removed');
  assert.equal(server.invalid.length, 0);
});

test('C28: SRD attribution footer and About dialog use GET /api/licenses (fallback without it)', async () => {
  const timers = manualTimers();
  const server = createFakeServer({ characters: [], timers });
  const dom = createFakeDom();
  const plain = app(dom, { fetch: server.fetch, WebSocket: server.WebSocket, timers, storage: null, durableStorage: null });
  await plain.a.start();
  await flush();
  assert.match(plain.root.textContent, new RegExp(SRD_ATTRIBUTION_FALLBACK.slice(0, 60).replace(/[()".]/g, '.')), 'fallback before / without the route');
  plain.a.dispose();

  const calls = [];
  const fetch = async (url, init) => {
    calls.push(url);
    if (url === '/api/licenses') return { ok: true, status: 200, json: async () => ({ srd: { name: 'System Reference Document 5.1', license: 'CC-BY-4.0', attribution: ATTR } }) };
    return server.fetch(url, init);
  };
  const withRoute = app(dom, { fetch, WebSocket: server.WebSocket, timers, storage: null, durableStorage: null });
  await withRoute.a.start();
  await until(() => withRoute.root.textContent.includes('legalcode'), 'attribution from the route');
  const footer = dom.findAll(withRoute.root, n => n.tagName === 'FOOTER')[0];
  assert.equal(footer.textContent, ATTR, 'word for word');
  dom.byAction(withRoute.root, 'about')[0].click();
  const dialog = dom.findAll(withRoute.root, n => n.getAttribute?.('role') === 'dialog')[0];
  assert.equal(dialog.hidden, false);
  assert.ok(dialog.textContent.includes(ATTR));
  assert.match(dialog.textContent, /CC-BY-4.0/);
  dom.byAction(dialog, 'about-close')[0].click();
  assert.equal(dialog.hidden, true);
  assert.ok(calls.includes('/api/licenses'));
  withRoute.a.dispose();
  assert.equal(dom.activeListeners(), 0);
});

test('C28: seat sheets come from the run-sheet route; a server without it falls back to the character route', async () => {
  const timers = manualTimers();
  const server = createFakeServer({ characters: [demoCharacter('c-ilsa', 'Ilsa', { cls: 'Wizard' })], timers });
  const dom = createFakeDom();
  let routeLive = true;
  const calls = [];
  const fetch = async (url, init) => {
    calls.push(`${init.method} ${url}`);
    const m = /^\/api\/rooms\/[^/]+\/seats\/([^/]+)\/sheet$/.exec(url);
    if (m && routeLive) return { ok: true, status: 200, json: async () => ({ sheet: { ...demoCharacter('c-ilsa', 'Ilsa (run sheet)'), id: 'c-ilsa' } }) };
    return server.fetch(url, init);
  };
  const env = { fetch, WebSocket: server.WebSocket, timers, durableStorage: null };
  const dm = app(dom, { ...env, storage: memoryStorage() });
  await dm.a.start();
  await dm.a.actions.createRoom();
  await until(() => dm.a.session?.store.getState().synced, 'DM connected');
  const roomId = dm.a.session.store.getState().room.id;
  server.shareCharacter(roomId, 'c-ilsa');
  await dm.a.api.aiSeat(roomId, 1, 'c-ilsa', 'tank');
  await until(() => calls.some(c => /\/seats\/.+\/sheet$/.test(c)), 'the run-sheet route asked');
  await until(() => /Ilsa \(run sheet\)/.test(JSON.stringify(dm.a.appearanceCache.characterFor(dm.a.appearanceCache.keyFor('c-ilsa')) || {})), 'run sheet cached');
  assert.equal(calls.filter(c => c.startsWith('GET /api/characters/')).length, 0, 'no character-route fetch');
  dm.a.dispose();

  routeLive = false;
  calls.length = 0;
  const dm2 = app(dom, { ...env, storage: memoryStorage() });
  await dm2.a.start();
  await dm2.a.actions.createRoom();
  await until(() => dm2.a.session?.store.getState().synced, 'DM 2 connected');
  const room2 = dm2.a.session.store.getState().room.id;
  server.shareCharacter(room2, 'c-ilsa');
  await dm2.a.api.aiSeat(room2, 1, 'c-ilsa', 'tank');
  await until(() => calls.some(c => c === 'GET /api/characters/c-ilsa'), 'fallback to the character route');
  dm2.a.dispose();
});

const VIEWS = new URL('../js/client/views/', import.meta.url);
/** Run / campaign views (phase 2): they read run sheets, never the DDB character route. */
const RUN_VIEW = /^(run-|campaign|between|level-up|shop|story)/;

test('lint: no run view calls api.getCharacter; no client view builds HTML strings', () => {
  const files = readdirSync(VIEWS).filter(f => f.endsWith('.js'));
  const runViews = files.filter(f => RUN_VIEW.test(f));
  assert.ok(runViews.includes('run-map.js') && runViews.includes('campaign-editor.js') && runViews.includes('campaigns.js'));
  for (const f of runViews) {
    const src = readFileSync(new URL(f, VIEWS), 'utf8');
    assert.doesNotMatch(src, /\bgetCharacter\b/, `${f} must load sheets through ctx.loadSheet (the run-sheet route)`);
  }
  for (const f of [...files.map(x => new URL(x, VIEWS)), new URL('../js/client/run-store.js', import.meta.url), new URL('../js/client/campaign-graph.js', import.meta.url)]) {
    const src = readFileSync(f, 'utf8');
    assert.doesNotMatch(src, /\.(innerHTML|outerHTML)\s*=|insertAdjacentHTML|document\.write/, `${f.pathname}: CSP-safe DOM only`);
    assert.doesNotMatch(src, /setAttribute\(\s*['"]on[a-z]+['"]/, `${f.pathname}: no inline handlers`);
  }
});
