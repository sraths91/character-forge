/**
 * M64 C9 — the play views in a fake DOM: each mounts, reacts, and
 * unmounts without leaking a listener (none on document / window
 * either); text goes through textContent; clicks become the right
 * intents. Plus the client/** import guard (no main.js, no
 * runAttackPrompt).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createStore } from '../js/client/store.js';
import { mount as mountLobby } from '../js/client/views/lobby.js';
import { mount as mountClaim, derivedSeatStats } from '../js/client/views/claim.js';
import { mount as mountSetup, setupPayload, calibratorInputs } from '../js/client/views/setup.js';
import { statBlockLabel, statBlockInfo, setupAckMonsters, fightsAsLabel } from '../js/client/monster-match.js';
import { mount as mountBattle, reactionCopy } from '../js/client/views/battle.js';
import { mount as mountDmPanel, createDmBridge, pendingPlan } from '../js/client/views/dm-panel.js';
import { createAppearanceCache } from '../js/map/view.js';
import { validateClientMessage } from '../js/shared/protocol.js';
import { createFakeDom } from './helpers/fake-dom.js';
import { projectedState, snapshotMsg, manualTimers, manualRaf, flush } from './helpers/client-fixtures.js';

const FIGHTER = {
  id: 'fighter-l5', name: 'Fixture Fighter', classes: [{ name: 'Fighter', level: 5 }],
  hp: { max: 44 }, abilityModifiers: { STR: 3, DEX: 1, CON: 2, INT: 0, WIS: 0, CHA: 0 }, proficiencyBonus: 3,
  equipment: { mainhand: { name: 'Longsword', damage: '1d8', damageType: 'slashing' }, armor: { name: 'Chain Mail', armorClass: 16 } },
  spells: []
};

function roomFor(role, { myTurn = false, mutate = null } = {}) {
  const enc = projectedState();
  if (mutate) mutate(enc);
  if (myTurn) {
    enc.turnIndex = 0;   // pc-fighter
    enc.entities['pc-fighter'].conditions = [];   // the contract fixture has them paralyzed
  }
  const room = {
    id: 'r1', code: 'ABC123', status: 'in-encounter', paused: false,
    members: [{ id: 'mem_dm', displayName: 'DM', role: 'dm', online: true }, { id: 'mem_p', displayName: 'Robin', role: 'player', online: true }],
    seats: [{ seat: 1, slotId: 'seat-1', characterId: 'fighter-l5', characterName: 'Fixture Fighter', controller: 'player', memberId: 'mem_p', aiArchetype: null }],
    turn: { turnId: 't9', actorId: myTurn ? 'pc-fighter' : 'pc-wizard', awaitingIntent: true },
    ...(role === 'dm' ? { review: { plans: true, rolls: false, monsterReactions: false } } : {})
  };
  const store = createStore({ hashState: null });
  store.apply({ v: 1, t: 'hello.ok', ts: 1, p: { memberId: role === 'dm' ? 'mem_dm' : 'mem_p', role, seats: room.seats, serverNow: 1000, cfg: {} } });
  store.apply(snapshotMsg(10, enc, room));
  return store;
}

function harness(role, opts = {}) {
  const dom = createFakeDom();
  const root = dom.root();
  const store = roomFor(role, opts);
  const sent = [];
  const timers = manualTimers();
  const raf = manualRaf();
  const prompts = [];
  const ctx = {
    store,
    send: async (intent) => {
      const v = validateClientMessage({ v: 1, cid: '01J00000000000000000000000', p: {}, ...intent });
      assert.deepEqual(v.errors, [], `intent ${intent.t} must pass the protocol`);
      sent.push(intent);
      return { ok: true };
    },
    session: { serverNow: () => 1000, setPlayback: () => () => {} },
    api: {
      listCharacters: async () => ({ characters: [{ ddbId: 'fighter-l5', name: 'Fixture Fighter' }, { ddbId: 'wizard-l5', name: 'Fixture Wizard' }] }),
      importCharacter: async () => ({ character: { id: 'paste:r1:x', name: 'New' } }),
      releaseSeat: async () => ({ ok: true }),
      aiSeat: async () => ({ seat: {} }),
      searchMonsters: async () => ({ results: [{ slug: 'bandit-captain', name: 'Bandit Captain', type: 'humanoid', cr: 2, hp: 65 }] }),
      uploadMap: async () => ({ mapId: 'map1', url: '/api/maps/r1/x.png' })
    },
    room: { roomId: 'r1', code: 'ABC123', role },
    loadSheet: async (id) => (id === 'fighter-l5' ? FIGHTER : null),
    sheets: () => ({ 'fighter-l5': FIGHTER }),
    appearanceCache: createAppearanceCache(),
    dmBridge: createDmBridge(),
    actions: { createRoom: async () => {}, joinRoom: async () => {}, openSetup: () => { ctx.openedSetup = true; } },
    deps: {
      render: async () => ({ needsRedraw: false }),
      raf: raf.raf, caf: raf.caf, timers,
      cinema: { async setActors() {}, resetHp() {}, playRound: () => Promise.resolve() },
      calibrateEncounter: async (args) => { ctx.calibrated = args; return { iterations: 200, winRate: 0.7, lossRate: 0.2, drawRate: 0.1, lethality: 0.3, deathToll: 0.4, difficulty: { label: 'medium', encounterXp: 100 } }; },
      mountCalibrator: (host, o) => { ctx.calibratorOpts = o; return () => { ctx.calibratorClosed = true; }; },
      loadImage: async () => ({ naturalWidth: 1200, naturalHeight: 800 }),
      promptReaction: (o) => { prompts.push(o); return Promise.resolve(true); }
    }
  };
  return { dom, root, store, ctx, sent, timers, raf, prompts };
}

function assertClean(h, label) {
  assert.equal(h.dom.activeListeners(), 0, `${label}: every listener removed`);
  assert.equal(h.dom.docListeners(), 0, `${label}: nothing left on document / window`);
  assert.equal(h.root.children.length, 0, `${label}: DOM removed`);
}

test('C9 views: lobby mounts, joins with validation, unmounts clean', async () => {
  const hh = harness('player');
  const calls = [];
  hh.ctx.room = null;
  hh.ctx.actions.joinRoom = async (code, name) => { calls.push([code, name]); };
  const un = mountLobby(hh.root, hh.ctx);
  assert.equal(hh.dom.docListeners(), 0, 'no document-level delegation');
  const [code, name] = hh.dom.findAll(hh.root, n => n.tagName === 'INPUT' && (n.name === 'code' || n.name === 'displayName'));
  hh.dom.byAction(hh.root, 'join')[0].click();
  assert.match(hh.dom.byText(hh.root, 'Room codes')[0].textContent, /6 letters/);
  code.value = 'abc123';
  name.value = 'Robin';
  hh.dom.fire(name, 'keydown', { key: 'Enter' });
  await flush();
  assert.deepEqual(calls, [['ABC123', 'Robin']]);
  un();
  assertClean(hh, 'lobby');
});

test('C9 views: lobby in a room lists seats with badges and connection dots', () => {
  const hh = harness('player');
  const un = mountLobby(hh.root, hh.ctx);
  assert.ok(hh.dom.byText(hh.root, 'ABC123').length);
  const seats = hh.dom.findAll(hh.root, n => n.tagName === 'LI' && (n.className || '').startsWith('play-seat '));
  assert.equal(seats.length, 6);
  assert.match(seats[0].className, /seat-player/);
  assert.ok(hh.dom.findAll(seats[0], n => /play-dot online/.test(n.className)).length === 1);
  // Presence updates re-render.
  hh.store.apply({ v: 1, t: 'member.presence', seq: 11, ts: 1, p: { memberId: 'mem_p', online: false } });
  hh.store.presentUpTo(11);
  const seat1 = hh.dom.findAll(hh.root, n => n.dataset?.seat === '1')[0];
  assert.ok(hh.dom.findAll(seat1, n => /play-dot offline/.test(n.className)).length === 1);
  un();
  assertClean(hh, 'lobby (room)');
});

test('C9 views: claim — players claim free characters; the DM sees AC/HP/level and fills AI seats', async () => {
  const pl = harness('player');
  pl.store.apply({ v: 1, t: 'seat.updated', seq: 11, ts: 1, p: { characterId: 'fighter-l5', memberId: null, controller: 'ai', seat: 1, slotId: 'seat-1', removed: true } });
  const un = mountClaim(pl.root, pl.ctx);
  await flush();
  const claims = pl.dom.byAction(pl.root, 'claim');
  assert.equal(claims.length, 2);
  claims[0].click();
  await flush();
  assert.deepEqual(pl.sent, [{ t: 'seat.claim', p: { characterId: 'fighter-l5' } }]);
  un();
  assertClean(pl, 'claim (player)');

  const dm = harness('dm');
  const aiCalls = [];
  dm.ctx.api.aiSeat = async (...a) => { aiCalls.push(a); return { seat: {} }; };
  const un2 = mountClaim(dm.root, dm.ctx);
  await flush();
  assert.ok(dm.dom.byText(dm.root, '16 / 44 / 5').length, 'derived AC / HP / level');
  const row2 = dm.dom.findAll(dm.root, n => n.dataset?.seatRow === '2')[0];
  row2.querySelector('[data-field="ai-character"]').value = 'wizard-l5';
  row2.querySelector('[data-field="ai-archetype"]').value = 'wizard';
  dm.dom.byAction(row2, 'set-ai')[0].click();
  await flush();
  assert.deepEqual(aiCalls, [['r1', 2, 'wizard-l5', 'wizard']]);
  dm.dom.byAction(dm.root, 'open-setup')[0].click();
  assert.equal(dm.ctx.openedSetup, true);
  un2();
  assertClean(dm, 'claim (dm)');
  assert.deepEqual(derivedSeatStats(null), { ac: null, hp: null, level: null });
});

test('C9 views: setup — search shows "fights as", placing + start sends setup then start; calibrator debounced 400 ms', async () => {
  const hh = harness('dm');
  // No encounter yet: the room is in the lobby.
  hh.store.apply(snapshotMsg(20, null, { id: 'r1', code: 'ABC123', status: 'lobby', members: [], seats: [{ seat: 1, slotId: 'seat-1', characterId: 'fighter-l5', characterName: 'Fixture Fighter', controller: 'player', memberId: 'mem_p' }] }));
  const un = mountSetup(hh.root, hh.ctx);
  const search = hh.dom.findAll(hh.root, n => n.tagName === 'INPUT' && n.type === 'search')[0];
  search.value = 'bandit';
  hh.dom.byAction(hh.root, 'search')[0].click();
  await flush();
  assert.ok(hh.dom.byText(hh.root, 'fights as: Bandit — AC 12').length, 'the proxy label');
  hh.dom.byAction(hh.root, 'arm-result')[0].click();
  // Click a cell on the canvas: the camera fits the 12×8 grid in 640×420.
  const canvas = hh.dom.findAll(hh.root, n => n.tagName === 'CANVAS')[0];
  await hh.raf.frame();
  const { fitToGrid, createCamera, worldToScreen } = await import('../js/map/camera.js');
  const cam = fitToGrid(createCamera({ zoom: 1, minZoom: 0.1, maxZoom: 4, viewW: 640, viewH: 420 }), 12, 8, 64, { padding: 8 });
  const at = worldToScreen(cam, 5 * 64 + 32, 4 * 64 + 32);
  hh.dom.fire(canvas, 'pointerdown', { clientX: at.x, clientY: at.y, button: 0 });
  assert.equal(hh.ctx.calibrated, undefined, 'not before the debounce');
  hh.timers.advance(399);
  assert.equal(hh.ctx.calibrated, undefined);
  hh.timers.advance(1);
  await flush();
  assert.equal(hh.ctx.calibrated.monsters.length, 1);
  assert.equal(hh.ctx.calibrated.party[0].name, 'Fixture Fighter');
  assert.ok(hh.dom.byText(hh.root, '70% party wins').length);
  hh.dom.byAction(hh.root, 'start')[0].click();
  await flush();
  assert.deepEqual(hh.sent.map(i => i.t), ['dm.encounter.setup', 'dm.encounter.start']);
  const setup = hh.sent[0].p;
  assert.deepEqual(setup.monsters, [{ id: 'm-1', slug: 'bandit', open5eSlug: 'bandit-captain', name: 'Bandit Captain', hp: 65, cr: '2' }]);
  assert.deepEqual(setup.placements['m-1'], { col: 5, row: 4 });
  // Pause mode → dm.review.set.
  const pause = hh.dom.byAction(hh.root, 'pause-mode')[0];
  pause.value = 'all';
  hh.dom.fire(pause, 'change');
  await flush();
  assert.deepEqual(hh.sent.at(-1), { t: 'dm.review.set', p: { plans: true, aiParty: true } });
  un();
  assertClean(hh, 'setup');
});

test('C9 views: setup — the dm.encounter.setup ack\'s SRD stat block replaces "fights as"', async () => {
  const hh = harness('dm');
  hh.store.apply(snapshotMsg(20, null, { id: 'r1', code: 'ABC123', status: 'lobby', members: [], seats: [] }));
  const send = hh.ctx.send;
  hh.ctx.send = async (intent) => {
    await send(intent);
    if (intent.t !== 'dm.encounter.setup') return { ok: true };
    return {
      encounterId: 'enc-1',
      monsters: intent.p.monsters.map((m, i) => (i === 0
        ? { id: m.id, name: m.name, preset: 'bandit', source: 'srd-2014', ac: 15, hpMax: 65, attacks: [{ name: 'Scimitar', bonus: 5, dice: '1d6+3' }, { name: 'Dagger', bonus: 5, dice: '1d4+3' }, { name: 'Parry', bonus: 0, dice: '0' }] }
        : { id: m.id, name: m.name, preset: m.slug, source: null, ac: 12, hpMax: 11, attacks: [] }))
    };
  };
  const un = mountSetup(hh.root, hh.ctx);
  const search = hh.dom.findAll(hh.root, n => n.tagName === 'INPUT' && n.type === 'search')[0];
  search.value = 'bandit';
  hh.dom.byAction(hh.root, 'search')[0].click();
  await flush();
  const canvas = hh.dom.findAll(hh.root, n => n.tagName === 'CANVAS')[0];
  await hh.raf.frame();
  const { fitToGrid, createCamera, worldToScreen } = await import('../js/map/camera.js');
  const cam = fitToGrid(createCamera({ zoom: 1, minZoom: 0.1, maxZoom: 4, viewW: 640, viewH: 420 }), 12, 8, 64, { padding: 8 });
  const place = (col, row) => { const at = worldToScreen(cam, col * 64 + 32, row * 64 + 32); hh.dom.fire(canvas, 'pointerdown', { clientX: at.x, clientY: at.y, button: 0 }); };
  hh.dom.byAction(hh.root, 'arm-result')[0].click();
  place(5, 4);
  hh.dom.byAction(hh.root, 'arm-preset').find(b => b.dataset.slug === 'goblin').click();
  place(6, 4);
  const lines = () => hh.dom.findAll(hh.root, n => n.tagName === 'SPAN' && /play-fights-as/.test(n.className) && n.parentNode?.tagName === 'LI').map(n => n.textContent);
  const before = lines();
  assert.equal(before.length, 2);
  assert.equal(before[0], 'fights as: Bandit — AC 12, Scimitar +3', 'the proxy line before the server answers');
  hh.dom.byAction(hh.root, 'create')[0].click();
  await flush();
  const after = lines();
  assert.equal(after[0], 'SRD stat block: AC 15, Scimitar +5, Dagger +5 … · 65 hp');
  assert.match(after[1], /^fights as: Goblin/, 'no stat block: the preset proxy');
  un();
  assertClean(hh, 'setup (srd)');
});

test('monster-match: statBlockLabel / statBlockInfo / setupAckMonsters', () => {
  assert.equal(statBlockLabel({ source: 'srd-2014', ac: 18, hpMax: 178, attacks: [{ name: 'Bite', bonus: 10 }] }, 'young-dragon'), 'SRD stat block: AC 18, Bite +10 · 178 hp');
  assert.equal(statBlockLabel({ source: null, ac: 18 }, 'bandit'), fightsAsLabel('bandit'));
  assert.equal(statBlockLabel(null, 'bandit'), 'fights as: Bandit — AC 12, Scimitar +3');
  assert.equal(statBlockLabel({ source: 'srd-2014', attacks: [] }, 'bandit'), 'SRD stat block: AC ?');
  assert.equal(statBlockInfo({ kind: 'pc' }), null);
  assert.deepEqual(statBlockInfo({ kind: 'monster', ac: 17, hpMax: 80, statBlock: { slug: 'young-dragon', source: 'srd-2014', attacks: [{ name: 'Bite', bonus: 7, dice: '2d10+4', extra: 1 }] } }),
    { source: 'srd-2014', ac: 17, hpMax: 80, attacks: [{ name: 'Bite', bonus: 7, dice: '2d10+4' }] });
  assert.deepEqual(Object.keys(setupAckMonsters({ monsters: [{ id: 'a' }, { name: 'no id' }, null] })), ['a']);
  assert.deepEqual(setupAckMonsters(null), {});
});

test('C9 views: setup helpers build the protocol payload and calibrator inputs', () => {
  const p = setupPayload({ mapKind: 'generated', biome: 'forest', seed: 9, cols: 10, rows: 8, terrain: null, cinemaBiome: 'cave', monsters: [{ id: 'm-1', slug: 'goblin', name: 'G', hp: null, cr: null, pos: { col: 1, row: 2 } }], placements: { 'pc-1': { col: 0, row: 0 } }, initiativeMode: 'grouped' });
  assert.deepEqual(p.map, { kind: 'generated', biome: 'forest', seed: 9, cinemaBiome: 'cave' });
  assert.deepEqual(p.placements, { 'pc-1': { col: 0, row: 0 }, 'm-1': { col: 1, row: 2 } });
  assert.equal(validateClientMessage({ v: 1, t: 'dm.encounter.setup', cid: '01J00000000000000000000000', p }).ok, true);
  const ci = calibratorInputs([{ sheet: FIGHTER, pos: { col: 0, row: 0 } }], [{ id: 'm-1', slug: 'goblin', name: 'G', pos: { col: 1, row: 1 } }]);
  assert.equal(ci.party[0].hp.current, 44);
  assert.deepEqual(ci.monsters[0].hp, { current: 7, max: 7, temp: 0 });
});

test('C9 views: battle — my turn shows actions that send turn.act; a reaction prompt answers with the server deadline', async () => {
  const hh = harness('player', { myTurn: true });
  hh.store.apply({ v: 1, t: 'turn.started', seq: 11, ts: 1, p: { seq: 11, type: 'turn.started', round: 2, turnId: 't9', cinemaGroup: null, payload: { actorId: 'pc-fighter' } } });
  const un = mountBattle(hh.root, hh.ctx);
  hh.store.presentUpTo(11);
  assert.match(hh.dom.findAll(hh.root, n => n.className === 'play-waiting')[0].textContent, /Your turn: Fixture Fighter/);
  assert.ok(hh.dom.byText(hh.root, 'HP 30 / 44').length);
  const attack = hh.dom.byAction(hh.root, 'attack').find(b => b.dataset.target === 'm-goblin');
  assert.ok(attack, 'the adjacent goblin is a target');
  attack.click();
  await flush();
  assert.deepEqual(hh.sent[0], { t: 'turn.act', p: { turnId: 't9', plan: { kind: 'attack', targetId: 'm-goblin', targetSide: 'enemy', weaponName: 'Longsword' } } });
  hh.dom.byAction(hh.root, 'action').find(b => b.dataset.kind === 'dodge').click();
  await flush();
  assert.deepEqual(hh.sent[1].p.plan, { kind: 'dodge' });

  hh.store.apply({ v: 1, t: 'prompt.open', ts: 1, p: { promptId: 'pr1', kind: 'shield', payload: { reactorId: 'pc-fighter', attackerId: 'm-fanatic', total: 17, ac: 16 }, autoAnswer: true, deadlineAt: 21000, serverNow: 1000 } });
  await flush();
  assert.equal(hh.prompts.length, 1);
  assert.equal(hh.prompts[0].defaultMs, 20000);
  assert.match(hh.prompts[0].body, /Cult Fanatic's 17 vs your AC 16/);
  assert.ok(hh.prompts[0].container, 'the dialog renders in the view');
  assert.deepEqual(hh.sent.at(-1), { t: 'prompt.answer', p: { promptId: 'pr1', answer: true } });
  un();
  assertClean(hh, 'battle');
});

test('C9 views: battle — waiting states and the log (DM edits styled apart)', async () => {
  const hh = harness('player');
  const un = mountBattle(hh.root, hh.ctx);
  assert.match(hh.dom.findAll(hh.root, n => n.className === 'play-waiting')[0].textContent, /Fixture Wizard is acting/);
  hh.store.apply({ v: 1, t: 'dm.override', seq: 11, ts: 1, p: { seq: 11, type: 'dm.override', round: 2, turnId: null, cinemaGroup: null, payload: { kind: 'entity.patch', entityId: 'm-goblin', before: { hp: 7 }, after: { hp: 3 } } } });
  hh.store.presentUpTo(11);
  const dmLine = hh.dom.findAll(hh.root, n => /roll-dm/.test(n.className))[0];
  assert.match(dmLine.textContent, /DM edited entity.patch \(Goblin\)/);
  hh.store.apply({ v: 1, t: 'room.status', seq: 12, ts: 1, p: { status: 'paused' } });
  await flush();
  assert.match(hh.dom.findAll(hh.root, n => n.className === 'play-waiting')[0].textContent, /paused/);
  assert.equal(reactionCopy({ kind: 'counterspell', payload: { reactorId: 'pc-wizard', casterId: 'm-fanatic', spellId: 'hold-person' } }, projectedState()).minLevel, 3);
  un();
  assertClean(hh, 'battle (waiting)');
});

test('C9 views: DM panel — plan review, inspector edits, + monster, end with confirmation, resume', async () => {
  const hh = harness('dm');
  const battleUn = mountBattle(hh.root, hh.ctx);   // shares the bridge for token clicks / placement
  const un = mountDmPanel(hh.root, hh.ctx);
  hh.store.apply({ v: 1, t: 'turn.planProposed', ts: 1, p: { entityId: 'm-fanatic', plan: { kind: 'attack', targetId: 'pc-fighter', archetype: 'brute' }, breakdown: [{ name: 'lowHp', weighted: 0.5 }] } });
  hh.store.apply({ v: 1, t: 'prompt.open', ts: 1, p: { promptId: 'pp1', kind: 'plan', payload: { entityId: 'm-fanatic', plan: { kind: 'attack', targetId: 'pc-fighter', archetype: 'brute' } }, autoAnswer: {}, deadlineAt: 21000, serverNow: 1000 } });
  assert.deepEqual(pendingPlan(hh.store.getState()).breakdown, [{ name: 'lowHp', weighted: 0.5 }]);
  assert.ok(hh.dom.byText(hh.root, 'Why: brute: lowHp(+0.50)').length);
  const tgt = hh.root.querySelector('[data-field="plan-target"]');
  tgt.value = 'pc-wizard';
  hh.dom.byAction(hh.root, 'change-target')[0].click();
  await flush();
  assert.deepEqual(hh.sent.at(-1), { t: 'prompt.answer', p: { promptId: 'pp1', answer: { kind: 'attack', targetId: 'pc-wizard', archetype: 'brute' } } });

  hh.ctx.dmBridge.select('m-goblin');
  hh.root.querySelector('[data-field="hp"]').value = '2';
  hh.dom.byAction(hh.root, 'hp-apply')[0].click();
  await flush();
  assert.deepEqual(hh.sent.at(-1), { t: 'dm.entity.patch', p: { entityId: 'm-goblin', hp: 2, hpTemp: 0 } });
  hh.root.querySelector('[data-field="cond-add"]').value = 'prone';
  hh.dom.byAction(hh.root, 'cond-add')[0].click();
  await flush();
  assert.deepEqual(hh.sent.at(-1).p, { entityId: 'm-goblin', addConditions: ['prone'] });

  hh.dom.byAction(hh.root, 'add-monster')[0].click();
  assert.equal(hh.ctx.dmBridge.placing(), true);
  hh.ctx.dmBridge.place({ col: 10, row: 7 });
  await flush();
  assert.equal(hh.sent.at(-1).t, 'dm.entity.add');
  assert.deepEqual(hh.sent.at(-1).p.entity.pos, { col: 10, row: 7 });

  hh.dom.byAction(hh.root, 'end-encounter')[0].click();
  assert.notEqual(hh.sent.at(-1).t, 'dm.encounter.end', 'first click only asks to confirm');
  hh.dom.byAction(hh.root, 'end-encounter')[0].click();
  await flush();
  assert.deepEqual(hh.sent.at(-1), { t: 'dm.encounter.end', p: { outcome: 'dm-ended' } });

  hh.store.apply({ v: 1, t: 'room.status', seq: 11, ts: 1, p: { status: 'paused' } });
  assert.ok(hh.dom.findAll(hh.root, n => n.className === 'play-paused-banner').length, 'paused-after-restart banner');
  hh.dom.byAction(hh.root, 'resume')[0].click();
  await flush();
  assert.deepEqual(hh.sent.at(-1), { t: 'dm.resume', p: {} });
  un();
  battleUn();
  assertClean(hh, 'dm panel');
});

test('M64 1.5 views: feature actions — Second Wind is offered from the sheet and sends a feature turn.act; swings are numbered in the log', async () => {
  const hh = harness('player', { myTurn: true, mutate: (enc) => { enc.entities['pc-fighter'].resources.features['second-wind'].spent = 0; } });
  const un = mountBattle(hh.root, hh.ctx);
  const btn = hh.dom.byAction(hh.root, 'feature')[0];
  assert.ok(btn, 'Second Wind button');
  assert.equal(btn.dataset.feature, 'second-wind');
  assert.ok(hh.dom.byText(hh.root, '1/1 left').length);
  btn.click();
  await flush();
  assert.deepEqual(hh.sent.at(-1), { t: 'turn.act', p: { turnId: 't9', plan: { kind: 'feature', featureId: 'second-wind', features: ['second-wind'] } } });
  const rolled = (seq, targetId) => ({ v: 1, t: 'attack.rolled', seq, ts: 1, p: { seq, type: 'attack.rolled', round: 2, turnId: 't9', cinemaGroup: 'g7', payload: {
    attackerId: 'pc-fighter', targetId, weapon: 'Longsword', isReaction: false, advantage: 'normal', d20: [12], kept: 12, bonus: 6, total: 18, ac: 13, hit: true, crit: false, shielded: false } } });
  hh.store.apply(rolled(11, 'm-goblin'));
  hh.store.apply(rolled(12, 'm-fanatic'));
  hh.store.presentUpTo(12);
  await flush();
  const lines = hh.dom.findAll(hh.root, n => n.tagName === 'LI' && /roll-log-entry/.test(n.className)).map(n => n.textContent);
  assert.ok(lines.some(t => /^Swing 2 \(new target\): Fixture Fighter → Cult Fanatic|^Swing 2 \(new target\): /.test(t)), lines.join(' | '));
  assert.ok(lines.some(t => /^Fixture Fighter → |^[^S].* → Goblin/.test(t)));
  un();
  assertClean(hh, 'battle (features)');
});

const evMsg = (seq, type, payload) => ({ v: 1, t: type, seq, ts: 1, p: { seq, type, round: 2, turnId: 't9', cinemaGroup: null, payload } });

test('M64 1.5 views: dying — death-save banner with the tally on my card, Dying/Dead badges on the initiative strip', async () => {
  const hh = harness('player');
  const un = mountBattle(hh.root, hh.ctx);
  hh.store.apply(evMsg(11, 'damage', { sourceId: 'm-goblin', targetId: 'pc-fighter', amount: 30, type: 'slashing', hpBefore: 30, hpAfter: 0 }));
  hh.store.apply(evMsg(12, 'entity.downed', { entityId: 'pc-fighter', byId: 'm-goblin' }));
  hh.store.apply(evMsg(13, 'turn.started', { actorId: 'm-fanatic' }));
  hh.store.apply(evMsg(14, 'death.save', { entityId: 'pc-fighter', d20: 7, success: false, crit: false, successes: 0, failures: 1, cause: 'roll' }));
  hh.store.presentUpTo(14);
  await flush();
  const banner = hh.dom.findAll(hh.root, n => /play-death-banner/.test(n.className))[0];
  assert.ok(banner, 'banner shown');
  assert.match(banner.textContent, /Death save: d20 = 7 — failure/);
  assert.equal(hh.dom.findAll(banner, n => /play-pip bad on/.test(n.className)).length, 1, 'one failure pip lit');
  const initBadges = hh.dom.findAll(hh.root, n => /init-row/.test(n.className) && /is-dying/.test(n.className));
  assert.equal(initBadges.length, 1);
  assert.ok(hh.dom.byText(hh.root, 'Dying').length);
  assert.match(hh.dom.findAll(hh.root, n => /roll-death/.test(n.className))[0].textContent, /death save: d20=7 — failure \(0 ✓ \/ 1 ✗\)/);
  hh.store.apply(evMsg(15, 'entity.died', { entityId: 'm-goblin', byId: 'pc-wizard', cause: 'monster' }));
  hh.store.presentUpTo(15);
  await flush();
  assert.ok(hh.dom.findAll(hh.root, n => /init-row/.test(n.className) && /is-dead/.test(n.className)).length, 'dead badge');
  un();
  assertClean(hh, 'battle (dying)');
});

test('M64 1.5 views: DM inspector — set status and clear death saves (dm.entity.patch v1.4)', async () => {
  const hh = harness('dm');
  const un = mountDmPanel(hh.root, hh.ctx);
  hh.store.apply(evMsg(11, 'entity.downed', { entityId: 'pc-wizard', byId: 'm-goblin' }));
  hh.ctx.dmBridge.select('pc-wizard');
  await flush();
  assert.ok(hh.dom.byText(hh.root, 'saves 0 ✓ / 0 ✗').length, 'the tally shows');
  hh.root.querySelector('[data-field="status"]').value = 'stable';
  hh.dom.byAction(hh.root, 'status-apply')[0].click();
  await flush();
  assert.deepEqual(hh.sent.at(-1), { t: 'dm.entity.patch', p: { entityId: 'pc-wizard', status: 'stable' } });
  hh.dom.byAction(hh.root, 'saves-clear')[0].click();
  await flush();
  assert.deepEqual(hh.sent.at(-1), { t: 'dm.entity.patch', p: { entityId: 'pc-wizard', deathSaves: { successes: 0, failures: 0, stable: false } } });
  un();
  assertClean(hh, 'dm panel (dying)');
});

test('C9: nothing under src/js/client imports main.js or runAttackPrompt', () => {
  const dir = new URL('../js/client/', import.meta.url);
  const files = [];
  const walk = (u) => {
    for (const ent of readdirSync(u, { withFileTypes: true })) {
      if (ent.isDirectory()) walk(new URL(`${ent.name}/`, u));
      else if (ent.name.endsWith('.js')) files.push(new URL(ent.name, u));
    }
  };
  walk(dir);
  assert.ok(files.length > 10);
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    assert.doesNotMatch(src, /from\s+['"][^'"]*main\.js['"]/, `${f.pathname} imports main.js`);
    assert.doesNotMatch(src, /runAttackPrompt/, `${f.pathname} mentions runAttackPrompt`);
    assert.doesNotMatch(src, /\.innerHTML\s*=/, `${f.pathname} writes innerHTML`);
    assert.doesNotMatch(src, /document\.addEventListener/, `${f.pathname} delegates on document`);
  }
});
