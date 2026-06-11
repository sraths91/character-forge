/**
 * M56 Phase 1 — Shared phase-timing constants.
 *
 * The values themselves are pinned (changing one is a deliberate
 * pacing decision, not a refactor side-effect), and the fsm + cinema
 * classifiers are checked against them so the single source of truth
 * actually is one.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  WINDUP_LEAD_MS, STRIKE_LEAD_MS, STRIKE_TAIL_MS, HURT_TAIL_MS,
  FADE_MS, IDLE_BOB_MS
} from '../js/anim/timings.js';
import { attackerPhaseAt, defenderPhaseAt } from '../js/anim/fsm.js';
import {
  phaseAt as cinemaPhaseAt,
  defenderPhaseAt as cinemaDefenderPhaseAt
} from '../js/anim/cinema.js';

test('M56.1: timings — pinned values', () => {
  assert.strictEqual(WINDUP_LEAD_MS, 350);
  assert.strictEqual(STRIKE_LEAD_MS, 100);
  assert.strictEqual(STRIKE_TAIL_MS, 180);
  assert.strictEqual(HURT_TAIL_MS, 220);
  assert.strictEqual(FADE_MS, 80);
  assert.strictEqual(IDLE_BOB_MS, 280);
});

test('M56.1: fsm phase boundaries sit exactly on the shared constants', () => {
  const impact = 600;
  assert.strictEqual(attackerPhaseAt(impact - WINDUP_LEAD_MS - 1, impact), 'idle');
  assert.strictEqual(attackerPhaseAt(impact - WINDUP_LEAD_MS, impact), 'windup');
  assert.strictEqual(attackerPhaseAt(impact - STRIKE_LEAD_MS, impact), 'strike');
  assert.strictEqual(attackerPhaseAt(impact + STRIKE_TAIL_MS - 1, impact), 'strike');
  assert.strictEqual(attackerPhaseAt(impact + STRIKE_TAIL_MS, impact), 'recover');
  assert.strictEqual(defenderPhaseAt(impact, impact), 'hurt');
  assert.strictEqual(defenderPhaseAt(impact + HURT_TAIL_MS - 1, impact), 'hurt');
  assert.strictEqual(defenderPhaseAt(impact + HURT_TAIL_MS, impact), 'idle');
});

test('M56.1: cinema re-exports ARE the fsm classifiers (no drift possible)', () => {
  assert.strictEqual(cinemaPhaseAt, attackerPhaseAt);
  assert.strictEqual(cinemaDefenderPhaseAt, defenderPhaseAt);
});
