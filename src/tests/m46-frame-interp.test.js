import { test } from 'node:test';
import assert from 'node:assert';
import {
  POSE, actorStateAt, attackerPhaseAt, defenderPhaseAt
} from '../js/anim/fsm.js';
import { pickActorFrameBlended } from '../js/anim/cinema-sprites.js';

// ---------- Phase classification ----------

test('M46: attackerPhaseAt — same windows as the legacy phaseAt', () => {
  assert.strictEqual(attackerPhaseAt(0,   600), 'idle');
  assert.strictEqual(attackerPhaseAt(300, 600), 'windup');
  assert.strictEqual(attackerPhaseAt(600, 600), 'strike');
  assert.strictEqual(attackerPhaseAt(900, 600), 'recover');
});

test('M46: defenderPhaseAt — hurt window is [impactAt, impactAt+220]', () => {
  assert.strictEqual(defenderPhaseAt(599, 600), 'idle');
  assert.strictEqual(defenderPhaseAt(600, 600), 'hurt');
  assert.strictEqual(defenderPhaseAt(819, 600), 'hurt');
  assert.strictEqual(defenderPhaseAt(820, 600), 'idle');
});

// ---------- actorStateAt — pose selection ----------

test('M46: actorStateAt — attacker windup → POSE.WINDUP', () => {
  const s = actorStateAt('attacker', 300, 600);
  assert.strictEqual(s.phase, 'windup');
  assert.strictEqual(s.pose, POSE.WINDUP);
});

test('M46: actorStateAt — attacker strike → POSE.STRIKE', () => {
  const s = actorStateAt('attacker', 600, 600);
  assert.strictEqual(s.pose, POSE.STRIKE);
});

test('M46: actorStateAt — defender hurt → POSE.HURT', () => {
  const s = actorStateAt('defender', 700, 600);
  assert.strictEqual(s.pose, POSE.HURT);
});

// ---------- Blend ramps over FADE_MS at phase boundaries ----------

test('M46: actorStateAt — blend ramps from 0 to 1 over the first 80ms of a new phase', () => {
  // Windup starts at t = impactAt - 350 = 250 (if impactAt = 600)
  const at0 = actorStateAt('attacker', 250, 600);          // start of windup
  const at40 = actorStateAt('attacker', 290, 600);         // mid-fade
  const at80 = actorStateAt('attacker', 330, 600);         // fade complete
  assert.ok(at0.blend <= 0.05,  `expected ≈0 at start; got ${at0.blend}`);
  assert.ok(at40.blend > 0.4 && at40.blend < 0.6, `expected ≈0.5 mid-fade; got ${at40.blend}`);
  assert.strictEqual(at80.blend, 1);
});

test('M46: actorStateAt — prevPose is the phase we transitioned FROM (within fade window)', () => {
  // Sample inside the FADE_MS entry window of each phase so the
  // cross-fade origin is observable. After the fade expires, recover
  // and idle settle into bob A↔B and the prevPose becomes the bob
  // counterpart instead.

  // Strike entry: t = impactAt - 100 + 20 (20ms into the 80ms fade)
  const strike = actorStateAt('attacker', 520, 600);
  assert.strictEqual(strike.prevPose, POSE.WINDUP);
  // Windup entry: t = (impactAt - 350) + 20
  const windup = actorStateAt('attacker', 270, 600);
  assert.strictEqual(windup.prevPose, POSE.IDLE_A);
  // Recover entry: t = (impactAt + 180) + 20 = 800
  const recover = actorStateAt('attacker', 800, 600);
  assert.strictEqual(recover.prevPose, POSE.STRIKE);
});

// ---------- Idle bob blends A↔B smoothly ----------

test('M46: idle bob — blend triangle-waves between A and B over the bob period', () => {
  // The current pose alternates A↔B every IDLE_BOB_MS (280ms). The
  // blend should triangle-wave 0..1..0 within each bob slot so the
  // two poses cross-fade instead of snap-cutting.
  // impactAt = 9999 keeps every sampled t clearly inside the 'idle'
  // window (windup starts at impactAt - 350 = 9649).
  const at0  = actorStateAt('attacker', 0,   9999);     // start of slot 0
  const at140= actorStateAt('attacker', 140, 9999);     // mid slot 0 — peak blend
  const at280= actorStateAt('attacker', 280, 9999);     // start of slot 1
  assert.strictEqual(at0.pose, POSE.IDLE_A);
  assert.strictEqual(at280.pose, POSE.IDLE_B);
  // Blend should peak near 1.0 mid-slot, return to ~0 at slot
  // boundaries
  assert.ok(at140.blend > 0.95, `mid-slot blend should peak near 1; got ${at140.blend}`);
  assert.ok(at0.blend <= 0.05, `slot boundary should have blend ≈ 0; got ${at0.blend}`);
});

// ---------- pickActorFrameBlended bridges to the renderer ----------

test('M46: pickActorFrameBlended — returns frame + prevFrame + blend', () => {
  const out = pickActorFrameBlended(
    { _t: 600, _impactAt: 600 },
    'attacker'
  );
  assert.strictEqual(out.frame, POSE.STRIKE);
  assert.strictEqual(out.prevFrame, POSE.WINDUP);
  assert.ok(Number.isFinite(out.blend));
  assert.ok(out.blend >= 0 && out.blend <= 1);
});

test('M46: pickActorFrameBlended — missing _impactAt defaults to idle', () => {
  const out = pickActorFrameBlended({ _t: 500 }, 'attacker');
  assert.strictEqual(out.phase, 'idle');
  assert.ok(out.frame === POSE.IDLE_A || out.frame === POSE.IDLE_B);
});
