/**
 * M64 C8 — render adapter + playback queue: HP presents at the exchange's
 * impact keyframe, cinema-off presents instantly, skip() jumps to
 * authoritative, cinema groups wait for their exchange, the map draws
 * through the rAF scheduler. Plus the forge-parity check for routing
 * main.js's playCinemaRoundForAttack through buildCinemaSequence.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../js/client/store.js';
import { createRenderAdapter, cinemaActorFor, tokenBadges } from '../js/client/render-adapter.js';
import { projectBattleView } from '../js/map/view.js';
import { projectedState as dyingState } from './helpers/client-fixtures.js';
import { createAppearanceCache } from '../js/map/view.js';
import { buildCinemaSequence, motionMetaForWeapon } from '../js/anim/cinema-plan.js';
import { findHitPauseAt } from '../js/anim/cinema.js';
import { buildMotion, motionForWeapon } from '../js/anim/weapon-motions.js';
import { buildSpellSequence } from '../js/anim/spell-motions.js';
import { applyStyle } from '../js/anim/motion-styles.js';
import { applySwing } from '../js/anim/swing-types.js';
import { applyModifiers } from '../js/anim/modifiers.js';
import { applyPolish } from '../js/anim/polish.js';
import { applyHitReaction } from '../js/anim/hit-reactions.js';
import {
  snapshotMsg, eventMsg, roomMsg, weaponExchange, manualTimers, manualRaf, flush
} from './helpers/client-fixtures.js';

function fakeCinema() {
  const rounds = [];
  return {
    rounds,
    actors: [],
    resets: [],
    async setActors(a) { this.actors.push(a); },
    resetHp(h) { this.resets.push(h); },
    playRound(seq, verdict) {
      let resolve;
      const p = new Promise(r => { resolve = r; });
      rounds.push({ seq, verdict, resolve });
      return p;
    }
  };
}

function setup({ cinemaEnabled = true, withCanvas = false } = {}) {
  const store = createStore();
  store.apply(snapshotMsg(10));
  const timers = manualTimers();
  const cinema = fakeCinema();
  const raf = manualRaf();
  const renders = [];
  const done = [];
  const adapter = createRenderAdapter({
    canvas: withCanvas ? { width: 0, height: 0, clientWidth: 640, clientHeight: 480 } : null,
    store,
    cinema,
    cinemaEnabled,
    timers,
    schedulerOpts: { raf: raf.raf, caf: raf.caf },
    render: async (_c, view, local) => { renders.push({ view, local }); return { needsRedraw: false }; },
    onExchangeDone: (id, info) => done.push({ id, ...info })
  });
  const send = (msgs) => {
    for (const m of msgs) assert.equal(store.apply(m), 'applied', `seq ${m.seq}`);
    return adapter.play(msgs.map(m => m.p));
  };
  return { store, timers, cinema, raf, renders, done, adapter, send };
}

const goblinHp = (s) => s.getPresented().encounter.entities['m-goblin'].hp;

test('C8: an exchange presents HP at the impact keyframe, not on receipt', async () => {
  const { store, timers, cinema, done, send } = setup();
  const msgs = weaponExchange(11);
  let resolved = false;
  const p = send(msgs).then(() => { resolved = true; });
  await flush();
  assert.equal(store.getState().encounter.entities['m-goblin'].hp, 0, 'authoritative updates on receipt');
  assert.equal(goblinHp(store), 7, 'presented trails until the impact');
  assert.equal(cinema.rounds.length, 1, 'the exchange went to the cinema');
  const plan = buildCinemaSequence(msgs[2].p);
  assert.deepEqual(cinema.rounds[0].seq, plan.seq, 'the Sequence is buildCinemaSequence(event)');
  assert.deepEqual(timers.delays(), [findHitPauseAt(plan.seq)], 'one impact timer at the hit-pause');
  assert.equal(cinema.resets[0].defHp, 7, 'cinema starts from the pre-hit HP');

  timers.advance(findHitPauseAt(plan.seq) - 1);
  assert.equal(goblinHp(store), 7);
  timers.advance(1);
  assert.equal(goblinHp(store), 0, 'impact presents the group');
  assert.equal(store.getPresented().seq, 13);
  assert.equal(resolved, false, 'play() waits for the cinema to finish');

  cinema.rounds[0].resolve({ completed: true });
  await p;
  assert.deepEqual(done, [{ id: 'x9', skipped: false }]);
});

test('C8: with cinema off an exchange presents instantly', async () => {
  const { store, cinema, done, send } = setup({ cinemaEnabled: false });
  await send(weaponExchange(11));
  assert.equal(goblinHp(store), 0);
  assert.equal(cinema.rounds.length, 0);
  assert.deepEqual(done, [{ id: 'x9', skipped: false }]);
});

test('C8: skip() jumps presented to authoritative mid-cinema and settles play()', async () => {
  const { store, cinema, done, send, adapter } = setup();
  const p1 = send(weaponExchange(11, { before: 7, after: 3, group: 'xa' }));
  const p2 = send([eventMsg(14, 'move', { actorId: 'pc-fighter', from: { col: 2, row: 3 }, to: { col: 3, row: 4 } })]);
  await flush();
  assert.equal(cinema.rounds.length, 1);
  assert.equal(goblinHp(store), 7);
  adapter.skip();
  await Promise.all([p1, p2]);
  assert.equal(goblinHp(store), 3);
  assert.deepEqual(store.getPresented().encounter.entities['pc-fighter'].pos, { col: 3, row: 4 });
  assert.deepEqual(store.getPresented().encounter, store.getState().encounter);
  assert.deepEqual(done, [{ id: 'xa', skipped: true }]);
  assert.equal(adapter.busy, false);
  // The late cinema resolution changes nothing.
  cinema.rounds[0].resolve();
  await flush();
  assert.equal(done.length, 1);
});

test('C8: group events wait for their exchange; a group without one flushes when the next event arrives', async () => {
  const { store, send } = setup();
  const [rolled, damage] = weaponExchange(11);
  send([rolled, damage]);
  await flush();
  assert.equal(goblinHp(store), 7, 'held: the exchange may still be coming');
  await send([eventMsg(13, 'turn.ended', { actorId: 'pc-fighter' })]);
  assert.equal(goblinHp(store), 0, 'a later non-group event releases the group');
  assert.equal(store.getPresented().seq, 13);
});

test('C8: room broadcasts and ordinary events present in order; duplicates are ignored', async () => {
  const { store, adapter } = setup();
  const m = roomMsg(11, 'round.started', { round: 3 });
  store.apply(m);
  await adapter.play([{ seq: 11, type: 'round.started' }, { seq: 11, type: 'round.started' }]);
  assert.equal(store.getPresented().encounter.round, 3);
  assert.equal(adapter.queued, 0);
});

test('C8: the map draws through one rAF scheduler from the presented state', async () => {
  const { store, raf, renders, send, timers, cinema } = setup({ withCanvas: true });
  await raf.frame();
  const first = renders.length;
  assert.equal(first, 1, 'the first frame draws the snapshot');
  send(weaponExchange(11));
  await flush();
  await raf.frame();
  assert.equal(renders.length, first, 'nothing new to draw before the impact');
  timers.advance(10000);
  await raf.frame();
  assert.equal(renders.length, first + 1);
  const tok = renders.at(-1).view.tokens.find(t => t.id === 'm-goblin');
  assert.equal(tok.hpState, 'down');
  assert.equal(typeof renders.at(-1).local.requestRedraw, 'function');
  cinema.rounds[0].resolve();
  assert.equal(goblinHp(store), 0);
});

test('C8: dispose() stops drawing and ignores later events', async () => {
  const { store, raf, renders, adapter } = setup({ withCanvas: true });
  adapter.dispose();
  adapter.dispose();
  store.apply(roomMsg(11, 'round.started', { round: 4 }));
  await adapter.play([{ seq: 11, type: 'round.started' }]);
  await raf.frame();
  assert.equal(renders.length, 0);
});

test('C8: cinemaActorFor uses the appearance cache for PCs and the preset for monsters', () => {
  const cache = createAppearanceCache();
  cache.put('fighter-l5', { name: 'Sheet Fighter', equipment: { mainhand: { name: 'Longsword' } } });
  const enc = snapshotMsg().p.encounter;
  const pc = cinemaActorFor(enc.entities['pc-fighter'], cache);
  assert.equal(pc.equipment.mainhand.name, 'Longsword');
  assert.equal(pc.name, 'Fixture Fighter');
  assert.equal(pc.hpMax, 44);
  const gob = cinemaActorFor(enc.entities['m-goblin'], cache);
  assert.equal(gob.hp.current, 7);
  assert.ok(gob.equipment, 'monster look comes from the preset');
  assert.equal(cinemaActorFor(null), null);
});

// ---- forge parity: main.js's pre-C8 pipeline vs buildCinemaSequence ----

/** The Sequence main.js's playCinemaRoundForAttack built before M64 C8. */
function legacySeq({ isPc, weapon, style, swing, fired, smiteSlot, level, dmg, crit, miss, killing, defenderMax, cast, spell, outcome, reaction }) {
  const motionId = cast ? 'staff-cast' : motionForWeapon(weapon);
  let seq = cast ? buildSpellSequence({ spell: spell || {}, outcome: outcome || {} }) : buildMotion(motionId);
  if (reaction) seq = applyStyle(seq, 'quick');
  else if (isPc) seq = applyStyle(seq, style);
  if (isPc && !cast && !reaction && seq.meta?.kind === 'melee' && swing) seq = applySwing(seq, swing);
  if (isPc && !cast && !reaction && fired.length) seq = applyModifiers(seq, fired, { level, slot: smiteSlot || 1 });
  if (!seq.meta?.friendly) {
    seq = applyPolish(seq, {
      level, crit: !!crit, dmg: dmg | 0, defenderHp: defenderMax,
      magical: cast ? false : !!weapon?.magical,
      material: cast ? null : (weapon?.material || null),
      damageType: cast ? (spell?.damageType || null) : (weapon?.damageType || null),
      killing: !!killing
    });
    if (!miss && (dmg | 0) > 0) seq = applyHitReaction(seq, { damageType: cast ? spell?.damageType : weapon?.damageType });
  }
  return seq;
}

/** What main.js now passes to buildCinemaSequence (mirrors the C8 rewrite). */
function forgeExchange(o) {
  return {
    exchangeId: null, attackerId: 'a', defenderId: 'd', reaction: !!o.reaction, cast: !!o.cast,
    roll: o.cast ? null : { hit: !o.miss, crit: !!o.crit },
    damage: { total: o.dmg | 0 },
    effects: [{ entityId: 'd', hp: { before: 0, after: 0, max: o.defenderMax } }],
    cinema: {
      weapon: o.cast ? null : o.weapon, style: o.isPc ? o.style : null, swing: o.swing,
      modifiers: o.fired, smiteSlot: o.smiteSlot, attackerLevel: o.level, killing: !!o.killing,
      spell: o.cast ? (o.spell || {}) : null, outcome: o.cast ? (o.outcome || {}) : null, fxSeed: 0, durationMs: 0
    }
  };
}

const stripMeta = (seq) => ({ ...seq, meta: Object.fromEntries(Object.entries(seq.meta || {}).filter(([k]) => k !== 'exchangeId' && k !== 'fxSeed')) });

test('C8: forge cinema rounds build the same Sequence through buildCinemaSequence', () => {
  const sword = { name: 'Longsword', damageType: 'slashing', magical: true, material: 'silvered' };
  const bow = { name: 'Longbow', damageType: 'piercing' };
  const cases = [
    { isPc: true, weapon: sword, style: 'power', swing: 'overhead', fired: ['divine-smite'], smiteSlot: 2, level: 5, dmg: 18, crit: true, miss: false, killing: true, defenderMax: 22 },
    { isPc: true, weapon: sword, style: 'quick', swing: 'thrust', fired: [], smiteSlot: null, level: 3, dmg: 0, crit: false, miss: true, killing: false, defenderMax: 11 },
    { isPc: true, weapon: bow, style: 'flourish', swing: null, fired: ['sneak-attack'], smiteSlot: 1, level: 4, dmg: 9, crit: false, miss: false, killing: false, defenderMax: 30 },
    { isPc: false, weapon: { name: 'Scimitar' }, style: null, swing: null, fired: [], smiteSlot: null, level: 1, dmg: 5, crit: false, miss: false, killing: false, defenderMax: 40 },
    { isPc: true, weapon: sword, style: 'power', swing: null, fired: [], smiteSlot: null, level: 5, dmg: 6, crit: false, miss: false, killing: false, defenderMax: 40, reaction: true },
    { isPc: true, cast: true, spell: { id: 'fire-bolt', kind: 'spell-attack', damageType: 'fire' }, outcome: { dmg: 10, crit: false, miss: false }, fired: [], level: 5, dmg: 10, crit: false, miss: false, killing: false, defenderMax: 20 },
    { isPc: true, cast: true, spell: { id: 'cure-wounds', kind: 'heal' }, outcome: { heal: 8 }, fired: [], level: 5, dmg: 0, crit: false, miss: false, killing: false, defenderMax: 20 }
  ];
  for (const c of cases) {
    const plan = buildCinemaSequence(forgeExchange(c));
    assert.deepEqual(stripMeta(plan.seq), stripMeta(legacySeq(c)), JSON.stringify(c));
  }
});

test('C8: motionMetaForWeapon tells melee from ranged for the swing counter', () => {
  assert.equal(motionMetaForWeapon({ name: 'Longsword' }).kind, 'melee');
  assert.notEqual(motionMetaForWeapon({ name: 'Longbow' }).kind, 'melee');
  assert.equal(motionMetaForWeapon({ name: 'Longsword' }).motionId, motionForWeapon({ name: 'Longsword' }));
});

test('M64 1.5: tokenBadges marks downed / stable / dead tokens and keeps hidden ones hidden from players', () => {
  const enc = dyingState();
  enc.entities['pc-wizard'].hp = 0;
  enc.entities['pc-wizard'].status = 'downed';
  enc.entities['m-fanatic'].hp = 0;
  enc.entities['m-fanatic'].status = 'dead';
  enc.entities['m-goblin'].hp = 0;   // pre-wave-5: no status, HP only
  const view = projectBattleView(enc);
  const byId = Object.fromEntries(tokenBadges(view, enc).map(b => [b.id, b.short]));
  assert.deepEqual(byId, { 'pc-wizard': 'DYING', 'm-fanatic': 'DEAD', 'm-goblin': 'DOWN' });
  const hidden = { ...view, tokens: view.tokens.map(t => (t.id === 'm-fanatic' ? { ...t, hidden: true } : t)) };
  assert.equal(tokenBadges(hidden, enc).some(b => b.id === 'm-fanatic'), false);
  assert.equal(tokenBadges(hidden, enc, { dm: { showHidden: true } }).some(b => b.id === 'm-fanatic'), true);
  assert.deepEqual(tokenBadges(null, enc), []);
});
