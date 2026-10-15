/**
 * M64 T6 — prompt contract: server prompt adapter (timeouts, seat
 * routing, answer log, replay) and the engine's re-checks after awaits.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPromptAdapter, createReplayAsk, promptRequest, PROMPT_KINDS } from '../js/scene/prompt-adapter.js';
import { runOneAttack } from '../js/scene/combat-engine.js';
import { createRng } from '../js/scene/rng.js';
import { buildPc, buildMonster, buildScene } from './helpers/entities.js';

function fakeClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map();
  return {
    setTimeout(fn, ms) { const id = nextId++; timers.set(id, { fn, at: now + ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
    pending: () => timers.size,
    advance(ms) {
      now += ms;
      for (const [id, t] of [...timers]) if (t.at <= now) { timers.delete(id); t.fn(); }
    }
  };
}
const tick = () => new Promise(r => setImmediate(r));

const wizard = (over = {}) => buildPc({
  id: 'wiz', name: 'Wiz', ac: 12, hp: 30, hpMax: 30,
  ref: { name: 'Wiz', classes: [{ name: 'Wizard', level: 5 }], abilityModifiers: { INT: 3, DEX: 2, CON: 1 }, spells: ['Shield'] },
  weapon: { name: 'Quarterstaff' }, _reactionUsed: false, _slots: { 1: 2 }, _position: { col: 1, row: 1 }, ...over
});
const shieldPlan = { forcePlan: { kind: 'attack', targetId: 'wiz', targetSide: 'enemy', featuresFired: [] } };

test('T6: a never-resolving ask times out to the engine heuristic (by: timeout)', async () => {
  const clock = fakeClock();
  const log = [];
  const prompts = { ...shieldPlan, ...createPromptAdapter({ ask: () => new Promise(() => {}), timeoutMs: 20000, log: (r) => log.push(r), clock }) };
  const gob = buildMonster({ id: 'gob', position: { col: 2, row: 1 } });
  const wiz = wizard();
  const events = [];
  const turn = runOneAttack(gob, [wiz], [gob], buildScene(), () => 0.5, prompts, { emit: (e) => events.push(e) });
  await tick();
  assert.equal(clock.pending(), 1, 'the Shield window is waiting on the seat');
  clock.advance(19999);
  await tick();
  assert.equal(log.length, 0, 'still waiting just before the deadline');
  clock.advance(1);
  await turn;
  assert.deepEqual(log, [{ reactorId: 'wiz', kind: 'shield', used: true, by: 'timeout', autoAnswer: true, attackTotal: 15, autoHit: false, spellId: null }]);
  assert.equal(wiz.hp, 30, 'heuristic cast Shield');
  assert.equal(wiz._slots[1], 1);
  const resolved = events.find(e => e.type === 'reaction.resolved');
  assert.deepEqual(resolved.payload, { reactorId: 'wiz', kind: 'shield', used: true, by: 'timeout' });
  assert.equal(clock.pending(), 0, 'no timer left behind');
});

test('T6: player answers win the race; the timer is cleared', async () => {
  const clock = fakeClock();
  const log = [];
  const prompts = { ...shieldPlan, ...createPromptAdapter({ ask: async () => false, log: (r) => log.push(r), clock }) };
  const wiz = wizard();
  await runOneAttack(buildMonster({ id: 'gob', position: { col: 2, row: 1 } }), [wiz], [], buildScene(), () => 0.5, prompts);
  assert.equal(log[0].by, 'player');
  assert.equal(log[0].used, false);
  assert.ok(wiz.hp < 30, 'declined Shield: the hit lands');
  assert.equal(clock.pending(), 0);
});

test('T6: autoAnswerFor answers AI/offline seats instantly; a failing ask falls back to auto', async () => {
  let asked = 0;
  const a = createPromptAdapter({ ask: async () => { asked++; return true; }, autoAnswerFor: () => false });
  assert.deepEqual(await a.onShieldReaction({ defender: { id: 'w' }, atk: { total: 14 }, autoAnswer: true }), { answer: false, by: 'auto' });
  assert.equal(asked, 0);
  const b = createPromptAdapter({ ask: async () => { throw new Error('socket gone'); } });
  assert.deepEqual(await b.onCounterspell({ witness: { id: 'w' }, caster: { id: 'c' }, spell: { id: 'hold-person', level: 2 }, autoAnswer: true }), { answer: true, by: 'auto' });
  const c = createPromptAdapter({ ask: async () => ({ answer: true, by: 'dm' }) });
  assert.deepEqual(await c.onReactionAttack({ triggerer: { id: 'g' }, mover: { id: 'p' }, kind: 'leave', autoAnswer: true }), { answer: true, by: 'dm' });
  assert.deepEqual(await createPromptAdapter().onReactionAttack({ triggerer: { id: 'g' }, autoAnswer: true }), { answer: true, by: 'auto' });
});

test('T6: promptRequest carries ids only', () => {
  assert.deepEqual(PROMPT_KINDS, ['oa', 'shield', 'counterspell']);
  const req = promptRequest('oa', { triggerer: { id: 1, ref: {} }, mover: { id: 'p' }, kind: 'leave', autoAnswer: true });
  assert.deepEqual(req, { kind: 'oa', reactorId: '1', autoAnswer: true, moverId: 'p', trigger: 'leave' });
  JSON.stringify(promptRequest('shield', { defender: { id: 'w' }, atk: { total: 3 }, spell: { id: 'magic-missile' } }));
});

function oaScene() {
  const pc = buildPc({ id: 'pc', hp: 40, hpMax: 40, _position: { col: 1, row: 1 } });
  const a = buildMonster({ id: 'a', position: { col: 2, row: 1 }, hp: 30, hpMax: 30 });
  const b = buildMonster({ id: 'b', position: { col: 1, row: 2 }, hp: 30, hpMax: 30 });
  const far = buildMonster({ id: 'far', position: { col: 8, row: 1 }, hp: 30, hpMax: 30 });
  return { pc, mons: [a, b, far] };
}

test('T6: replaying the logged answers reproduces the same state', async () => {
  const run = async (ask) => {
    const { pc, mons } = oaScene();
    const log = [];
    const prompts = {
      forcePlan: { kind: 'melee', targetId: 'far', targetSide: 'enemy', weapon: { name: 'Longsword' }, featuresFired: [] },
      ...createPromptAdapter({ ask, log: (r) => log.push(r) })
    };
    await runOneAttack(pc, mons, [pc], buildScene(), createRng({ s: 9 }), prompts);
    return { log, state: JSON.stringify([pc, ...mons].map(w => ({ id: w.id, hp: w.hp, pos: w._position || w.position, r: !!w._reactionUsed }))) };
  };
  // Seat 'a' declines its opportunity attack, 'b' takes it.
  const live = await run(async (req) => req.reactorId !== 'a');
  assert.ok(live.log.length >= 2);
  const replayAsk = createReplayAsk(live.log);
  const replay = await run(replayAsk);
  assert.equal(replay.state, live.state);
  assert.deepEqual(replay.log, live.log);
  assert.deepEqual(replayAsk.diverged, []);
  const other = await run(async () => true);
  assert.notEqual(other.state, live.state, 'different answers, different state');
});

test('T6: a target zeroed during the Shield prompt is not damaged further', async () => {
  const wiz = wizard();
  const gob = buildMonster({ id: 'gob', position: { col: 2, row: 1 } });
  const cinema = [];
  await runOneAttack(gob, [wiz], [gob], buildScene(), () => 0.5, {
    ...shieldPlan,
    onShieldReaction: async () => { wiz.hp = 0; return false; },   // e.g. a DM edit lands mid-prompt
    onCinemaRound: async (r) => { cinema.push(r); }
  });
  assert.equal(wiz.hp, 0);
  assert.equal(gob.damageDealt, 0);
  assert.equal(cinema.length, 0);
});

test('T6: a mover dropped by an opportunity attack neither moves nor attacks', async () => {
  const pc = buildPc({ id: 'pc', hp: 1, hpMax: 40, _position: { col: 1, row: 1 } });
  const a = buildMonster({ id: 'a', position: { col: 2, row: 1 }, attack: { name: 'Club', bonus: 20, dice: '1d4+5' } });
  const far = buildMonster({ id: 'far', position: { col: 8, row: 1 }, hp: 30, hpMax: 30 });
  await runOneAttack(pc, [a, far], [pc], buildScene(), createRng({ s: 1 }), {
    forcePlan: { kind: 'melee', targetId: 'far', targetSide: 'enemy', weapon: { name: 'Longsword' }, featuresFired: [] }
  });
  assert.equal(pc.hp, 0);
  assert.deepEqual(pc._position, { col: 1, row: 1 }, 'stayed where it fell');
  assert.equal(far.hp, 30);
});

test('T6: a forcePlan at a downed target is rejected', async () => {
  const events = [];
  const pc = buildPc();
  const m = buildMonster({ hp: 0 });
  await runOneAttack(pc, [m], [pc], buildScene(), () => 0.5, {
    forcePlan: { kind: 'melee', targetId: m.id, targetSide: 'enemy', featuresFired: [] }
  }, { emit: (e) => events.push(e) });
  assert.equal(events.at(-1).type, 'turn.rejected');
  assert.equal(events.at(-1).payload.code, 'target-down');
});
