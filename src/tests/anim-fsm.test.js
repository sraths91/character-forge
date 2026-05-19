import { test } from 'node:test';
import assert from 'node:assert';
import {
  actorStateAt, attackerPhaseAt, defenderPhaseAt, POSE
} from '../js/anim/fsm.js';

// ---------- Phase classification ----------

test('M46 FSM: attackerPhaseAt — windows by impact moment', () => {
  // impactAt = 600
  assert.strictEqual(attackerPhaseAt(0,    600), 'idle');
  assert.strictEqual(attackerPhaseAt(249,  600), 'idle');
  assert.strictEqual(attackerPhaseAt(300,  600), 'windup');
  assert.strictEqual(attackerPhaseAt(499,  600), 'windup');
  assert.strictEqual(attackerPhaseAt(500,  600), 'strike');
  assert.strictEqual(attackerPhaseAt(779,  600), 'strike');
  assert.strictEqual(attackerPhaseAt(780,  600), 'recover');
});

test('M46 FSM: defenderPhaseAt — hurt window of 220ms after impact', () => {
  assert.strictEqual(defenderPhaseAt(0,    600), 'idle');
  assert.strictEqual(defenderPhaseAt(599,  600), 'idle');
  assert.strictEqual(defenderPhaseAt(600,  600), 'hurt');
  assert.strictEqual(defenderPhaseAt(819,  600), 'hurt');
  assert.strictEqual(defenderPhaseAt(820,  600), 'idle');
});

test('M46 FSM: non-finite impactAt falls back to idle', () => {
  assert.strictEqual(attackerPhaseAt(500, NaN), 'idle');
  assert.strictEqual(defenderPhaseAt(500, undefined), 'idle');
});

// ---------- Pose mapping ----------

test('M46 FSM: attacker windup → WINDUP pose', () => {
  const s = actorStateAt('attacker', 400, 600);   // windup window
  assert.strictEqual(s.phase, 'windup');
  assert.strictEqual(s.pose, POSE.WINDUP);
});

test('M46 FSM: attacker strike → STRIKE pose', () => {
  const s = actorStateAt('attacker', 600, 600);   // strike window
  assert.strictEqual(s.phase, 'strike');
  assert.strictEqual(s.pose, POSE.STRIKE);
});

test('M46 FSM: defender hurt → HURT pose', () => {
  const s = actorStateAt('defender', 700, 600);   // hurt window
  assert.strictEqual(s.phase, 'hurt');
  assert.strictEqual(s.pose, POSE.HURT);
});

test('M46 FSM: attacker idle/recover bobs between A and B', () => {
  // Sample idle across one bob cycle (280ms). impactAt=9999 keeps us
  // in the idle window for the whole range.
  const s0  = actorStateAt('attacker', 0,   9999);
  const s140 = actorStateAt('attacker', 140, 9999);
  const s280 = actorStateAt('attacker', 280, 9999);
  // At t=0 we're at the start of a slot — pose A
  assert.strictEqual(s0.pose, POSE.IDLE_A);
  // At t=280 we've crossed into the next slot — pose B
  assert.strictEqual(s280.pose, POSE.IDLE_B);
  // At t=140 we're at the midpoint of the first slot — still pose A
  // but blended toward B via the triangle wave
  assert.strictEqual(s140.pose, POSE.IDLE_A);
  void s140;
});

// ---------- Cross-fade blend factor ----------

test('M46 FSM: windup blend ramps from 0 → 1 over the first 80ms of the phase', () => {
  // Windup phase begins at impactAt-350 = 250
  const start = actorStateAt('attacker', 250, 600);
  const mid   = actorStateAt('attacker', 290, 600);   // +40ms
  const late  = actorStateAt('attacker', 330, 600);   // +80ms
  const hold  = actorStateAt('attacker', 450, 600);   // well past fade
  assert.ok(start.blend < 0.1, `blend at phase start should be near 0; got ${start.blend}`);
  assert.ok(mid.blend > 0.3 && mid.blend < 0.7, `blend at +40ms should be mid-fade; got ${mid.blend}`);
  assert.ok(Math.abs(late.blend - 1) < 0.05, `blend at +80ms should be ~1; got ${late.blend}`);
  assert.strictEqual(hold.blend, 1, 'after the fade window the blend holds at 1');
});

test('M46 FSM: strike-phase prevPose is WINDUP (the pose we came from)', () => {
  // Just inside strike phase — blend < 1
  const s = actorStateAt('attacker', 510, 600);
  assert.strictEqual(s.pose, POSE.STRIKE);
  assert.strictEqual(s.prevPose, POSE.WINDUP);
  assert.ok(s.blend < 1, 'inside the fade window');
});

test('M46 FSM: recover-phase prevPose is STRIKE', () => {
  const s = actorStateAt('attacker', 790, 600);   // just after strike→recover
  assert.strictEqual(s.phase, 'recover');
  assert.strictEqual(s.prevPose, POSE.STRIKE);
});

test('M46 FSM: defender hurt-phase prevPose is IDLE_A', () => {
  const s = actorStateAt('defender', 620, 600);   // just into hurt
  assert.strictEqual(s.pose, POSE.HURT);
  assert.strictEqual(s.prevPose, POSE.IDLE_A);
  assert.ok(s.blend < 1, 'inside the fade window');
});

// ---------- Idle bob cross-fade ----------

test('M46 FSM: idle bob blend is triangular (0..1..0 across one slot)', () => {
  // impactAt = 9999 keeps every sampled t firmly inside the 'idle'
  // window (windup begins at impactAt - 350 = 9649).
  const slotStart  = actorStateAt('attacker', 0,   9999);
  const slotMid    = actorStateAt('attacker', 140, 9999);   // mid of 280ms slot
  const slotLate   = actorStateAt('attacker', 270, 9999);   // near end
  // Triangle wave: 0 at boundary, 1 at midpoint, ~0 again at next boundary
  assert.strictEqual(slotStart.blend, 0);
  assert.ok(Math.abs(slotMid.blend - 1) < 0.01,
    `expected ~1 at mid of slot; got ${slotMid.blend}`);
  assert.ok(slotLate.blend < 0.15,
    `expected blend near 0 again near end of slot; got ${slotLate.blend}`);
});

test('M46 FSM: idle bob prevPose alternates with pose', () => {
  // In slot 0: pose=A, prevPose=B (so the cross-fade goes B→A→B over the period)
  const slotA = actorStateAt('attacker', 0,   9999);
  const slotB = actorStateAt('attacker', 280, 9999);
  assert.strictEqual(slotA.pose, POSE.IDLE_A);
  assert.strictEqual(slotA.prevPose, POSE.IDLE_B);
  assert.strictEqual(slotB.pose, POSE.IDLE_B);
  assert.strictEqual(slotB.prevPose, POSE.IDLE_A);
});

// ---------- Smoke tests ----------

test('M46 FSM: state is well-formed for every actor + every t in 0..2000', () => {
  for (const actor of ['attacker', 'defender']) {
    for (let t = 0; t <= 2000; t += 50) {
      const s = actorStateAt(actor, t, 600);
      assert.ok(typeof s.phase === 'string');
      assert.ok(Number.isFinite(s.pose));
      assert.ok(Number.isFinite(s.prevPose));
      assert.ok(s.blend >= 0 && s.blend <= 1,
        `blend out of range at ${actor} t=${t}: ${s.blend}`);
    }
  }
});
