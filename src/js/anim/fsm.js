/**
 * M46 — Actor animation state machine.
 *
 * Centralises the (actor, time) → pose mapping that cinema-sprites.js
 * previously hard-coded inside pickActorFrame. Two payoffs:
 *
 *   1. The mapping is now declarative — phases declare which pose they
 *      occupy and where their boundaries are. Easy to tweak timing
 *      without combing through `if (phase === 'foo')` ladders.
 *   2. Each call returns BOTH the current pose AND the previous pose
 *      with a 0..1 `blend` factor, so the renderer can cross-fade
 *      between sprite frames during phase transitions. The visible
 *      effect is the difference between "5fps pose cycling" and
 *      perceptually-smooth motion.
 *
 * The FSM is pure — no side effects, no caching. Render layers ask
 * `actorStateAt(actor, t, impactAt)` every frame.
 */

// LPC walk-sheet pose indices (mirrors cinema-sprites.js).
export const POSE = {
  IDLE_A:  0,
  IDLE_B:  1,
  WINDUP:  2,
  HURT:    4,
  STRIKE:  6
};

// How long the cross-fade window lasts at the start of each new pose.
// 80ms = ~5 frames at 60fps — long enough to read as smooth, short
// enough that no held pose feels mushy.
const FADE_MS = 80;

// Idle bob period — alternation A↔B in the idle/recover states.
const IDLE_BOB_MS = 280;

/**
 * Classify the attacker's swing phase at time `t` relative to the
 * sequence's impact moment. Mirrors cinema.js phaseAt but is owned
 * here so the FSM doesn't depend on cinema.
 *
 *   t < impactAt - 350         → idle (pre-fight stance)
 *   impactAt - 350 ≤ t < -100  → windup
 *   -100 ≤ t < impactAt + 180  → strike (impact + immediate follow-through)
 *   t ≥ impactAt + 180         → recover
 */
export function attackerPhaseAt(t, impactAt) {
  if (!Number.isFinite(impactAt)) return 'idle';
  if (t < impactAt - 350) return 'idle';
  if (t < impactAt - 100) return 'windup';
  if (t < impactAt + 180) return 'strike';
  return 'recover';
}

/**
 * Classify the defender's swing phase.
 *   t < impactAt          → idle
 *   impactAt ≤ t < +220   → hurt
 *   t ≥ impactAt + 220    → idle
 */
export function defenderPhaseAt(t, impactAt) {
  if (!Number.isFinite(impactAt)) return 'idle';
  if (t < impactAt) return 'idle';
  if (t < impactAt + 220) return 'hurt';
  return 'idle';
}

/**
 * The (phase, time) → pose mapping for an attacker.
 *
 *   idle / recover → bobs between IDLE_A and IDLE_B on IDLE_BOB_MS
 *   windup         → WINDUP
 *   strike         → STRIKE
 */
function attackerPose(phase, t) {
  if (phase === 'windup') return POSE.WINDUP;
  if (phase === 'strike') return POSE.STRIKE;
  // idle / recover — bob A↔B
  return (Math.floor(t / IDLE_BOB_MS) % 2 === 0) ? POSE.IDLE_A : POSE.IDLE_B;
}

/**
 * The (phase, time) → pose mapping for a defender.
 *
 *   idle → bobs A↔B
 *   hurt → HURT
 */
function defenderPose(phase, t) {
  if (phase === 'hurt') return POSE.HURT;
  return (Math.floor(t / IDLE_BOB_MS) % 2 === 0) ? POSE.IDLE_A : POSE.IDLE_B;
}

/**
 * Find the moment-in-time when the current phase began. Used by the
 * blend logic to compute "how far into this phase are we" so the
 * cross-fade window can ramp blend from 0 to 1 over the first FADE_MS
 * of the new phase.
 */
function attackerPhaseStart(phase, impactAt) {
  if (!Number.isFinite(impactAt)) return 0;
  if (phase === 'idle')    return Number.NEGATIVE_INFINITY;
  if (phase === 'windup')  return impactAt - 350;
  if (phase === 'strike')  return impactAt - 100;
  if (phase === 'recover') return impactAt + 180;
  return 0;
}
function defenderPhaseStart(phase, impactAt) {
  if (!Number.isFinite(impactAt)) return 0;
  if (phase === 'hurt') return impactAt;
  return Number.NEGATIVE_INFINITY;
}

/**
 * Resolve the actor's full animation state at time `t`.
 *
 * @returns {{phase: string, pose: number, prevPose: number, blend: number}}
 *   - phase     : current animation phase id
 *   - pose      : the frame the sprite should READ AS at this instant
 *   - prevPose  : the pose we're transitioning from
 *   - blend     : 0..1 — how far through the cross-fade we are.
 *                 0 = render prevPose fully; 1 = render pose fully.
 *
 * During the idle bob the FSM returns blend that smoothly interpolates
 * A↔B over the bob cycle, so the standing pose breathes rather than
 * snap-cutting every IDLE_BOB_MS.
 */
export function actorStateAt(actor, t, impactAt) {
  const phase = actor === 'defender'
    ? defenderPhaseAt(t, impactAt)
    : attackerPhaseAt(t, impactAt);
  const poseFn = actor === 'defender' ? defenderPose : attackerPose;
  const phaseStartFn = actor === 'defender' ? defenderPhaseStart : attackerPhaseStart;

  const pose = poseFn(phase, t);
  const phaseStart = phaseStartFn(phase, impactAt);
  const inPhase = Math.max(0, t - phaseStart);

  // First FADE_MS of any non-idle phase: cross-fade from the previous
  // phase's terminal pose to the current pose. This gives windup,
  // strike, recover, and hurt clean entry tweens.
  if (inPhase < FADE_MS && (phase === 'windup' || phase === 'strike'
      || phase === 'recover' || phase === 'hurt')) {
    return {
      phase, pose,
      prevPose: previousPose(actor, phase),
      blend: inPhase / FADE_MS
    };
  }

  // Idle / recover steady-state — bob A↔B with a triangle-wave blend.
  if (phase === 'idle' || phase === 'recover') {
    const bobFraction = (t % IDLE_BOB_MS) / IDLE_BOB_MS;
    const blend = bobFraction < 0.5 ? bobFraction * 2 : (1 - bobFraction) * 2;
    const prevPose = pose === POSE.IDLE_A ? POSE.IDLE_B : POSE.IDLE_A;
    return { phase, pose, prevPose, blend };
  }

  // Held pose past the fade window — windup/strike/hurt sit on their
  // current pose with blend = 1.
  return { phase, pose, prevPose: previousPose(actor, phase), blend: 1 };
}

/**
 * What pose was the actor in JUST BEFORE the current phase began?
 * Used to anchor the cross-fade's starting frame.
 */
function previousPose(actor, currentPhase) {
  if (actor === 'defender') {
    if (currentPhase === 'hurt') return POSE.IDLE_A;   // idle → hurt
    return POSE.IDLE_A;
  }
  if (currentPhase === 'windup')  return POSE.IDLE_A;   // idle → windup
  if (currentPhase === 'strike')  return POSE.WINDUP;   // windup → strike
  if (currentPhase === 'recover') return POSE.STRIKE;   // strike → recover
  return POSE.IDLE_A;
}
