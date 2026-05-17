import { test } from 'node:test';
import assert from 'node:assert';
import {
  resetReaction, resetReactionsForAll, hasReactionAvailable, consumeReaction,
  detectOpportunityAttacks
} from '../js/scene/reactions.js';

// ---------- Reaction budget ----------

test('M33.0: hasReactionAvailable defaults to true', () => {
  assert.strictEqual(hasReactionAvailable({ id: 'a' }), true);
});

test('M33.0: consumeReaction makes hasReactionAvailable return false until reset', () => {
  const e = { id: 'a' };
  consumeReaction(e);
  assert.strictEqual(hasReactionAvailable(e), false);
  resetReaction(e);
  assert.strictEqual(hasReactionAvailable(e), true);
});

test('M33.0: hasReactionAvailable is false when incapacitated', () => {
  for (const cond of ['incapacitated', 'paralyzed', 'stunned', 'unconscious', 'petrified']) {
    assert.strictEqual(
      hasReactionAvailable({ id: 'a', conditions: [cond] }),
      false,
      `should be false when ${cond}`
    );
  }
});

test('M33.0: resetReactionsForAll resets the whole list', () => {
  const list = [
    { id: 'a', _reactionUsed: true },
    { id: 'b', _reactionUsed: true }
  ];
  resetReactionsForAll(list);
  assert.strictEqual(list[0]._reactionUsed, false);
  assert.strictEqual(list[1]._reactionUsed, false);
});

test('M33.0: helpers tolerate null inputs', () => {
  resetReaction(null);
  consumeReaction(null);
  assert.strictEqual(hasReactionAvailable(null), false);
});

// ---------- detectOpportunityAttacks ----------

test('M33.0: OA fires when mover steps out of hostile reach (5ft)', () => {
  const mover = { id: 'm1', _position: { col: 5, row: 5 } };
  const hostile = { id: 'h1', _position: { col: 5, row: 5 }, weapon: { name: 'Longsword' } };
  const out = detectOpportunityAttacks({
    mover, before: { col: 5, row: 5 }, after: { col: 7, row: 5 },
    hostiles: [hostile]
  });
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].triggerer, hostile);
  assert.strictEqual(out[0].reason, 'left-reach');
});

test('M33.0: OA does NOT fire when mover stays in reach', () => {
  const hostile = { id: 'h1', _position: { col: 5, row: 5 }, weapon: { name: 'Longsword' } };
  const out = detectOpportunityAttacks({
    mover: { id: 'm1' }, before: { col: 5, row: 5 }, after: { col: 6, row: 5 },
    hostiles: [hostile]
  });
  assert.strictEqual(out.length, 0);
});

test('M33.0: OA does NOT fire when hostile already used its reaction', () => {
  const hostile = {
    id: 'h1', _position: { col: 5, row: 5 },
    weapon: { name: 'Longsword' }, _reactionUsed: true
  };
  const out = detectOpportunityAttacks({
    mover: { id: 'm1' }, before: { col: 5, row: 5 }, after: { col: 8, row: 5 },
    hostiles: [hostile]
  });
  assert.strictEqual(out.length, 0);
});

test('M33.0: OA does NOT fire when hostile is incapacitated', () => {
  const hostile = {
    id: 'h1', _position: { col: 5, row: 5 },
    weapon: { name: 'Longsword' }, conditions: ['stunned']
  };
  const out = detectOpportunityAttacks({
    mover: { id: 'm1' }, before: { col: 5, row: 5 }, after: { col: 8, row: 5 },
    hostiles: [hostile]
  });
  assert.strictEqual(out.length, 0);
});

test('M33.0: Disengage suppresses all OAs from the move', () => {
  const hostile = { id: 'h1', _position: { col: 5, row: 5 }, weapon: { name: 'Longsword' } };
  const out = detectOpportunityAttacks({
    mover: { id: 'm1', _disengaged: true },
    before: { col: 5, row: 5 }, after: { col: 8, row: 5 },
    hostiles: [hostile]
  });
  assert.strictEqual(out.length, 0);
});

test('M33.0: reach weapon (Halberd, 10ft) catches mover crossing the 10ft boundary', () => {
  const hostile = { id: 'h1', _position: { col: 0, row: 0 }, weapon: { name: 'Halberd' } };
  // 2 cells = 10ft (in reach) → 3 cells = 15ft (out)
  const out = detectOpportunityAttacks({
    mover: { id: 'm1' },
    before: { col: 2, row: 0 }, after: { col: 3, row: 0 },
    hostiles: [hostile]
  });
  assert.strictEqual(out.length, 1);
});

test('M33.0: every threatening hostile generates its own OA', () => {
  const h1 = { id: 'h1', _position: { col: 4, row: 5 }, weapon: { name: 'Dagger' } };
  const h2 = { id: 'h2', _position: { col: 5, row: 4 }, weapon: { name: 'Scimitar' } };
  const out = detectOpportunityAttacks({
    mover: { id: 'm1' }, before: { col: 5, row: 5 }, after: { col: 7, row: 7 },
    hostiles: [h1, h2]
  });
  assert.strictEqual(out.length, 2);
});

test('M33.0: a no-op move (same cell) generates no OAs', () => {
  const hostile = { id: 'h1', _position: { col: 5, row: 5 }, weapon: { name: 'Longsword' } };
  const out = detectOpportunityAttacks({
    mover: { id: 'm1' }, before: { col: 5, row: 5 }, after: { col: 5, row: 5 },
    hostiles: [hostile]
  });
  assert.strictEqual(out.length, 0);
});

test('M33.0: monster attack object is treated as a melee weapon for reach', () => {
  const hostile = { id: 'h1', _position: { col: 5, row: 5 }, attack: { name: 'Bite' } };
  const out = detectOpportunityAttacks({
    mover: { id: 'm1' }, before: { col: 5, row: 5 }, after: { col: 7, row: 5 },
    hostiles: [hostile]
  });
  assert.strictEqual(out.length, 1);
});

// ---------- Simulator-level integration ----------

import { simulateEncounter } from '../js/scene/simulator.js';

test('M33.0: simulator integration — encounter still resolves with OAs active', () => {
  // 2 PCs adjacent to 2 monsters; over many runs the OAs should fire
  // at least sometimes (when fleeing kobolds break away from the
  // surrounding melee). The contract under test is just "the simulator
  // still terminates and reports outcomes" — OAs must not deadlock it.
  const party = [
    {
      id: 'pc1', name: 'A', _position: { col: 1, row: 1 },
      hp: { current: 30, max: 30 },
      equipment: { mainhand: { name: 'Longsword' } },
      abilityScores: { STR: 16, DEX: 12, CON: 14, INT: 10, WIS: 10, CHA: 10 },
      abilityModifiers: { STR: 3, DEX: 1, CON: 2, INT: 0, WIS: 0, CHA: 0 },
      classes: [{ name: 'Fighter', level: 5 }],
      conditions: []
    },
    {
      id: 'pc2', name: 'B', _position: { col: 2, row: 1 },
      hp: { current: 30, max: 30 },
      equipment: { mainhand: { name: 'Longsword' } },
      abilityScores: { STR: 16, DEX: 12, CON: 14, INT: 10, WIS: 10, CHA: 10 },
      abilityModifiers: { STR: 3, DEX: 1, CON: 2, INT: 0, WIS: 0, CHA: 0 },
      classes: [{ name: 'Fighter', level: 5 }],
      conditions: []
    }
  ];
  // Three kobolds — their profile flees at 60% HP, so they'll provoke
  // OAs when they break engagement.
  const monsters = [
    { id: 'k1', presetSlug: 'kobold', name: 'K1', hp: { current: 5, max: 5 }, position: { col: 2, row: 2 }, conditions: [] },
    { id: 'k2', presetSlug: 'kobold', name: 'K2', hp: { current: 5, max: 5 }, position: { col: 1, row: 2 }, conditions: [] },
    { id: 'k3', presetSlug: 'kobold', name: 'K3', hp: { current: 5, max: 5 }, position: { col: 3, row: 2 }, conditions: [] }
  ];
  const stats = simulateEncounter({
    party, monsters,
    scene: { cols: 8, rows: 5 },
    iterations: 50, maxRounds: 12, seed: 1
  });
  // Both sides definitively resolve; no draws/deadlocks
  assert.strictEqual(stats.iterations, 50);
  assert.strictEqual(stats.partyVictories + stats.monsterVictories + stats.draws, 50);
  // Party should still trounce 3 weak kobolds the majority of the time
  assert.ok(stats.partyVictories / stats.iterations > 0.5,
    `expected party win rate > 50%, got ${stats.partyVictories}/50`);
});
