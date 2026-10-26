/**
 * M65 V21 — the parity checklist for retiring the forge's versus mode.
 * Every capability the forge's versus driver offered must exist in
 * play.html's views before V22 puts the driver behind `?classic=1`:
 *
 *   manual attack · manual cast · auto-fight · reactions (Shield dialog)
 *   · cinema style pickers · the calibrator card · quick stats
 *
 * Part 1 is grep-style over the view modules (the same check the PR's
 * checklist cites); part 2 mounts the new pieces (style picker, cinema
 * override, auto-fight switch, setup pre-fill + quick stats).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { createStore } from '../js/client/store.js';
import { mount as mountCinemaStyle, createCinemaOverride, styledEntities } from '../js/client/views/cinema-style.js';
import { mount as mountSettings } from '../js/client/views/room-settings.js';
import { mount as mountSetup, quickStatsLine } from '../js/client/views/setup.js';
import { soloSettingsOf } from '../js/client/selectors.js';
import { createRenderAdapter } from '../js/client/render-adapter.js';
import { buildCinemaSequence } from '../js/anim/cinema-plan.js';
import { validateClientMessage } from '../js/shared/protocol.js';
import { createAppearanceCache } from '../js/map/view.js';
import { createFakeDom } from './helpers/fake-dom.js';
import { snapshotMsg, projectedState, manualTimers, manualRaf, flush, weaponExchange } from './helpers/client-fixtures.js';

const src = (rel) => readFileSync(new URL(`../js/${rel}`, import.meta.url), 'utf8');
const VIEWS = {
  battle: src('client/views/battle.js'),
  setup: src('client/views/setup.js'),
  settings: src('client/views/room-settings.js'),
  style: src('client/views/cinema-style.js'),
  dmPanel: src('client/views/dm-panel.js'),
  play: src('play.js'),
  html: readFileSync(new URL('../../play.html', import.meta.url), 'utf8')
};

/** The checklist: each forge capability → where it lives at the table. */
const CHECKLIST = [
  ['manual attack', () => VIEWS.battle.includes('attackIntent(') && VIEWS.battle.includes("'pick-attack'")],
  ['manual cast', () => VIEWS.battle.includes('castIntent(') && VIEWS.battle.includes("'pick-cast'")],
  ['auto-fight', () => /autoFight/.test(VIEWS.settings) && VIEWS.settings.includes("'dm.room.settings'") && VIEWS.battle.includes('turn.delegate')],
  ['reactions (Shield dialog)', () => VIEWS.battle.includes("prompt.kind === 'shield'") && VIEWS.battle.includes('promptReaction') && VIEWS.play.includes("import('./scene/reaction-prompt.js')")],
  ['cinema style pickers', () => VIEWS.style.includes('availableStyles(') && VIEWS.style.includes('availableSwings(') && VIEWS.style.includes("'char.setStyle'") && VIEWS.battle.includes("from './cinema-style.js'")],
  ['calibrator card', () => VIEWS.setup.includes('deps.calibrateEncounter(') && VIEWS.setup.includes("text: 'Difficulty'") && VIEWS.play.includes("import('./scene/calibrator.js')")],
  ['quick stats', () => VIEWS.setup.includes("'quick-stats'") && VIEWS.setup.includes('deps.simulateEncounter(') && VIEWS.play.includes("import('./scene/simulator.js')")]
];

test('V21 parity checklist: every forge versus capability exists in play.html\'s views', () => {
  assert.match(VIEWS.html, /src\/js\/play\.js/, 'play.html boots play.js');
  for (const name of ['battle.js', 'setup.js', 'dm-panel.js']) assert.ok(VIEWS.play.includes(`./client/views/${name}`), `play.js mounts ${name}`);
  assert.ok(VIEWS.dmPanel.includes('room-settings.js'), 'the DM panel carries the room settings card (auto-fight)');
  const missing = CHECKLIST.filter(([, ok]) => !ok()).map(([n]) => n);
  assert.deepEqual(missing, [], `missing at the table: ${missing.join(', ')}`);
});

function storeWith({ role = 'dm', settings = {}, controller = 'dm', status = 'in-encounter' } = {}) {
  const store = createStore({ hashState: null });
  store.apply({ v: 1, t: 'hello.ok', ts: 1, p: { memberId: role === 'dm' ? 'mem_dm' : 'mem_p', role, seats: [], serverNow: 1, cfg: {} } });
  const enc = projectedState();
  for (const e of Object.values(enc.entities)) if (e.kind === 'pc') e.controller = { type: controller, seatId: e.controller?.seatId ?? null };
  store.apply(snapshotMsg(10, enc, { code: 'ABC123', status, settings, members: [], seats: [] }));
  return store;
}

function memoryLocalStorage() {
  const m = new Map();
  const ls = { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
  const prev = globalThis.localStorage;
  globalThis.localStorage = ls;
  return () => { if (prev === undefined) delete globalThis.localStorage; else globalThis.localStorage = prev; };
}

test('cinema style card: the DM of a solo room picks for DM-driven PCs; the pick is saved, not sent (seat-only intent)', async () => {
  const restore = memoryLocalStorage();
  try {
    const dom = createFakeDom();
    const root = dom.root();
    const store = storeWith();
    const pcs = styledEntities(store.getState());
    assert.ok(pcs.length >= 1, 'DM-driven PCs are listed for the DM');
    const sent = [];
    const un = mountCinemaStyle(root, { store, send: async (i) => { sent.push(i); return {}; }, sheets: () => ({}) });
    assert.match(root.textContent, /Cinema style/);
    const sel = root.querySelector('[data-action="pick-style"]');
    sel.value = 'quick';
    dom.fire(sel, 'change');
    await flush();
    const id = pcs[0].sheetRef.characterId;
    assert.equal(globalThis.localStorage.getItem(`cf_attackStyle_${id}`), 'quick');
    assert.equal(sent.length, 0, 'char.setStyle is only for a seat this member holds');
    un();
    assert.equal(dom.activeListeners(), 0);
    // A player sees nothing for AI seats they do not hold.
    assert.equal(styledEntities(storeWith({ role: 'player', controller: 'ai' }).getState()).length, 0);
  } finally { restore(); }
});

test('cinemaOverride: the local pick reaches the cinema of a DM-driven attacker; varied alternates per attack', () => {
  const store = storeWith();
  const pc = styledEntities(store.getState())[0];
  const ov = createCinemaOverride({ store, pickFor: () => ({ style: 'power', swing: 'varied' }) });
  const payload = { attackerId: pc.id, cinema: { weapon: { name: 'Longsword' } } };
  const a = ov(payload);
  const b = ov(payload);
  assert.equal(a.style, 'power');
  assert.ok(a.swing && b.swing && a.swing !== b.swing, `varied alternates (${a.swing} → ${b.swing})`);
  assert.equal(ov({ ...payload, cast: true }), null, 'casts keep the server cinema');
  assert.equal(ov({ ...payload, attackerId: 'm-goblin' }), null, 'monsters keep the server cinema');
  assert.equal(createCinemaOverride({ store: storeWith({ role: 'player', controller: 'ai' }) })(payload), null);
});

test('render adapter: cinemaOverride is merged into a copy of the exchange (the event is not mutated)', async () => {
  const store = storeWith();
  const pc = styledEntities(store.getState())[0];
  const seen = [];
  const cinema = {
    setActors: async () => {}, resetHp: () => {}, playRound: async (seq) => { seen.push(seq); }, stop: () => {}, isPlaying: () => false
  };
  const adapter = createRenderAdapter({
    store, cinema, timers: manualTimers(), render: async () => ({ needsRedraw: false }), schedulerOpts: manualRaf(),
    cinemaOverride: () => ({ style: 'quick' }), swingLingerMs: 0, logger: { warn: () => {} }
  });
  const msgs = weaponExchange(11, { attackerId: pc.id });
  for (const m of msgs) store.apply(m);
  const ex = msgs[msgs.length - 1].p;
  const before = JSON.stringify(ex);
  await adapter.play(msgs.map(m => m.p));
  await flush(10);
  assert.equal(JSON.stringify(ex), before, 'the exchange event is untouched');
  assert.equal(seen.length, 1, 'the cinema played the exchange');
  assert.ok(seen[0].duration < plainDuration(msgs), 'Quick (the override) plays faster than the server\'s Standard');
  adapter.dispose();
});

function plainDuration(msgs) {
  const ex = msgs[msgs.length - 1].p;
  return buildCinemaSequence(ex).seq.duration;
}

test('auto-fight switch: shown in solo rooms only, sends dm.room.settings {autoFight}', async () => {
  const dom = createFakeDom();
  const root = dom.root();
  const store = storeWith({ settings: { dmDrivesAiSeats: true, autoFight: false } });
  assert.deepEqual(soloSettingsOf(store.getState()), { dmDrivesAiSeats: true, autoFight: false });
  const sent = [];
  const un = mountSettings(root, { store, send: async (i) => { assert.equal(validateClientMessage({ v: 1, cid: '01J00000000000000000000000', ...i }).ok, true); sent.push(i); return { ok: true }; } });
  const box = root.querySelector('[data-action="auto-fight"]');
  assert.equal(box.parentNode.hidden, false);
  box.checked = true;
  dom.fire(box, 'change');
  await flush();
  assert.deepEqual(sent, [{ t: 'dm.room.settings', p: { autoFight: true } }]);
  un();
  const root2 = createFakeDom().root();
  const un2 = mountSettings(root2, { store: storeWith({ settings: {} }), send: async () => ({}) });
  assert.equal(root2.querySelector('[data-action="auto-fight"]').parentNode.hidden, true, 'a table room has no auto-fight switch');
  un2();
});

test('setup: the forge handoff pre-fills once; quick stats runs 200 sims with the forge\'s sentence', async () => {
  const dom = createFakeDom();
  const root = dom.root();
  const store = createStore({ hashState: null });
  store.apply({ v: 1, t: 'hello.ok', ts: 1, p: { memberId: 'mem_dm', role: 'dm', seats: [], serverNow: 1, cfg: {} } });
  store.apply(snapshotMsg(10, null, { id: 'r1', code: 'ABC123', status: 'lobby', members: [], seats: [{ seat: 1, slotId: 's1', characterId: 'c1', characterName: 'Brakka', controller: 'ai' }] }));
  const setup = {
    map: { kind: 'generated', biome: 'forest', seed: 9 }, grid: { cols: 10, rows: 7, flankingEnabled: true },
    monsters: [{ id: 'm-1', slug: 'goblin', name: 'Goblin' }, { id: 'm-2', slug: 'goblin', name: 'Goblin 2' }],
    placements: { 'pc-1': { col: 1, row: 0 }, 'm-1': { col: 8, row: 0 }, 'm-2': { col: 8, row: 1 } }, initiativeMode: 'individual'
  };
  let consumed = 0;
  const sims = [];
  const sent = [];
  const raf = manualRaf();
  const un = mountSetup(root, {
    store, api: { searchMonsters: async () => ({ results: [] }) }, send: async (i) => { sent.push(i); return { ok: true }; },
    room: { roomId: 'r1', code: 'ABC123', role: 'dm' }, loadSheet: async () => ({ id: 'c1', name: 'Brakka', hp: { max: 30 } }),
    appearanceCache: createAppearanceCache(), roomToken: () => 'tok',
    handoff: { setup, warnings: [], consume: () => { consumed++; } },
    deps: {
      render: async () => ({ needsRedraw: false }), raf: raf.raf, caf: raf.caf, timers: manualTimers(),
      calibrateEncounter: async () => ({ difficulty: {} }),
      simulateEncounter: async (args) => { sims.push(args); return { victoryRate: 0.75, monsterVictories: 40, draws: 10, iterations: 200, avgRounds: 3.25 }; }
    }
  });
  await un.ready;
  await flush();
  assert.equal(consumed, 1);
  assert.match(root.textContent, /Pre-filled from the forge: 2 monsters, flanking on/);
  assert.equal(root.querySelector('[data-action="flanking"]').checked, true);
  dom.byAction(root, 'quick-stats')[0].click();
  await flush(10);
  assert.equal(sims.length, 1);
  assert.equal(sims[0].iterations, 200);
  assert.equal(sims[0].scene.flankingEnabled, true);
  assert.equal(sims[0].monsters.length, 2);
  assert.match(root.textContent, /Quick stats over 200 sims: party wins 75% \/ loses 20% \/ stalemates 5% — avg 3\.3 rounds\./);
  dom.byAction(root, 'create')[0].click();
  await flush(8);
  const sentSetup = sent.find(i => i.t === 'dm.encounter.setup').p;
  assert.deepEqual(sentSetup, setup, 'Create sends the forge\'s setup unchanged');
  un();
  assert.equal(quickStatsLine({ victoryRate: 1, monsterVictories: 0, draws: 0, iterations: 200, avgRounds: 2 }),
    'Quick stats over 200 sims: party wins 100% / loses 0% / stalemates 0% — avg 2.0 rounds.');
});
