/**
 * M51 Phase 1 — Procedural weapon-swing rigs.
 *
 * The cinema used to bake a static weapon into the body sprite, so it
 * never swung — the "attack" was the whole sprite sliding plus a generic
 * arc effect. This module describes, per weapon class, how the weapon
 * itself should rotate + lunge through a real strike, so the renderer
 * can draw the blade actually sweeping (with a motion-trail smear). Pure
 * math + data — no canvas. The renderer (cinema) applies the transforms.
 *
 * Angle convention: radians applied as a rotation of the weapon sprite
 * about its grip pivot. 0 = the weapon's rest sprite orientation.
 * Positive rotates the tip forward/down (clockwise on screen, +y down);
 * negative rotates it back/up. Offsets (dx,dy) and pivot are in
 * cell-fractions (× the sprite's drawn size) so they scale with zoom.
 *
 * Timing is normalized progress `p` in [0,1] over the whole sequence,
 * with the impact at `impactP` (= hitPause time / duration). The strike
 * is built slow→fast→slow: a slow anticipation pull-back, a fast sweep
 * that LANDS the strike pose exactly at impact, then an eased settle
 * with a slight overshoot. (GDQuest / SLYNYRD melee-feel principles.)
 */

const TAU = Math.PI * 2;

/**
 * Per-motion rigs. `id` matches motionForWeapon() ids (weapon-motions.js)
 * so the cinema can look up a rig from the same id it built the motion
 * from. `null` = no weapon to swing (unarmed).
 *
 * Fields:
 *   grip        — pivot offset from the weapon sprite centre (cell frac)
 *   rest        — resting rotation (radians)
 *   windup      — pulled-back rotation at the top of the wind-up
 *   strike      — rotation at impact
 *   follow      — overshoot rotation just past impact
 *   lunge       — peak forward offset at impact (cell frac)
 *   rise        — peak vertical offset at impact (cell frac; -up)
 *   strikeScale — weapon scale at impact (emphasis)
 *   sweepWidth  — how early before impact the fast sweep begins (p units)
 *   trail       — draw a motion smear during the sweep
 */
// All angles are DELTAS from the weapon's native LPC frame-0 pose
// (rest = 0). The cinema draws the weapon cell at exactly the position
// the compositor would bake it, so at rest the overlay is pixel-identical
// to the old static weapon — then it rotates about the grip to swing.
// `grip` is the pivot in cell-fractions relative to the cell centre,
// roughly the hand (SLOT_BOXES.mainhand ≈ x 0.20, y 0.13 below centre).
export const SWING_RIGS = {
  'sword-slash': {
    id: 'sword-slash', grip: { x: 0.22, y: -0.42 },
    rest: 0, windup: -0.7, strike: 1.9, follow: 2.2,
    lunge: 0.12, rise: 0, strikeScale: 1.05, sweepWidth: 0.12, trail: true
  },
  'sword-thrust': {
    id: 'sword-thrust', grip: { x: 0.22, y: -0.42 },
    rest: 0, windup: -0.25, strike: 0.12, follow: 0.0,
    lunge: 0.7, rise: 0, strikeScale: 1.04, sweepWidth: 0.10, trail: true
  },
  'lance-thrust': {
    id: 'lance-thrust', grip: { x: 0.22, y: -0.40 },
    rest: 0, windup: -0.18, strike: 0.05, follow: -0.05,
    lunge: 0.95, rise: 0, strikeScale: 1.03, sweepWidth: 0.10, trail: true
  },
  'axe-cleave': {
    id: 'axe-cleave', grip: { x: 0.20, y: -0.40 },
    rest: 0, windup: -1.0, strike: 2.1, follow: 2.4,
    lunge: 0.1, rise: 0, strikeScale: 1.08, sweepWidth: 0.14, trail: true
  },
  'dagger-stab': {
    id: 'dagger-stab', grip: { x: 0.22, y: -0.44 },
    rest: 0, windup: -0.45, strike: 0.2, follow: 0.0,
    lunge: 0.55, rise: 0, strikeScale: 1.02, sweepWidth: 0.07, trail: true
  },
  'staff-cast': {
    id: 'staff-cast', grip: { x: 0.20, y: -0.46 },
    rest: 0, windup: -0.4, strike: -0.12, follow: -0.18,
    lunge: 0.18, rise: -0.16, strikeScale: 1.05, sweepWidth: 0.18, trail: false
  },
  'bow-draw': {
    id: 'bow-draw', grip: { x: 0.20, y: -0.42 },
    rest: 0, windup: -0.08, strike: 0.0, follow: 0.0,
    lunge: 0, rise: 0, strikeScale: 1.0, sweepWidth: 0.1, trail: false
  },
  'fist-jab': null
};

/** Look up the swing rig for a motion id (null when unarmed/unknown). */
export function swingRigFor(motionId) {
  return Object.prototype.hasOwnProperty.call(SWING_RIGS, motionId)
    ? SWING_RIGS[motionId]
    : SWING_RIGS['sword-slash'];
}

/* ----- easing ----- */
const easeOut = (t) => 1 - (1 - t) * (1 - t);
const easeIn  = (t) => t * t;
function clamp01(t) { return t < 0 ? 0 : t > 1 ? 1 : t; }
function lerp(a, b, t) { return a + (b - a) * t; }

/**
 * Sample the weapon's transform at normalized progress `p` (0..1 over
 * the sequence) with impact at `impactP`. Returns
 * `{ angle, dx, dy, scale, phase }`.
 *
 * Phases (relative to impactP):
 *   rest    p < windupStart
 *   windup  windupStart..sweepStart   rest → windup angle (slow)
 *   sweep   sweepStart..impactP       windup → strike angle (fast)
 *   settle  impactP..recoverEnd       strike → follow → rest (overshoot)
 */
export function sampleSwing(rig, p, impactP = 0.5) {
  if (!rig) return { angle: 0, dx: 0, dy: 0, scale: 1, phase: 'none' };
  const ip = clamp01(impactP);
  const windupStart = Math.max(0, ip - 0.34);
  const sweepStart  = Math.max(windupStart + 0.01, ip - (rig.sweepWidth ?? 0.12));
  const recoverEnd  = Math.min(1, ip + 0.30);

  let angle = rig.rest, dx = 0, dy = 0, scale = 1, phase = 'rest';
  if (p <= windupStart) {
    angle = rig.rest;
  } else if (p < sweepStart) {
    phase = 'windup';
    const k = easeOut((p - windupStart) / (sweepStart - windupStart));
    angle = lerp(rig.rest, rig.windup, k);
  } else if (p < ip) {
    phase = 'sweep';
    const k = easeIn((p - sweepStart) / (ip - sweepStart));
    angle = lerp(rig.windup, rig.strike, k);
    dx = rig.lunge * k;
    dy = rig.rise * k;
    scale = lerp(1, rig.strikeScale ?? 1, k);
  } else if (p < recoverEnd) {
    phase = 'settle';
    const k = (p - ip) / (recoverEnd - ip);
    // strike → follow (overshoot) in the first third, then → rest.
    if (k < 0.34) {
      angle = lerp(rig.strike, rig.follow, easeOut(k / 0.34));
      dx = lerp(rig.lunge, rig.lunge * 0.6, k / 0.34);
    } else {
      const k2 = easeOut((k - 0.34) / 0.66);
      angle = lerp(rig.follow, rig.rest, k2);
      dx = lerp(rig.lunge * 0.6, 0, k2);
    }
    scale = lerp(rig.strikeScale ?? 1, 1, easeOut(k));
  } else {
    angle = rig.rest;
  }
  return { angle, dx, dy, scale, phase };
}

/**
 * Motion-trail samples for the smear — N transforms taken just BEHIND
 * the current progress, only while the blade is moving fast (sweep +
 * early settle). Returns [] when the rig has no trail or the blade is
 * slow. Each entry carries an `alpha` fading with age so the renderer
 * can draw fading afterimages of the weapon along its swept path.
 */
export function swingTrail(rig, p, impactP = 0.5, n = 5) {
  if (!rig || !rig.trail) return [];
  const ip = clamp01(impactP);
  const sweepStart = Math.max(0, ip - (rig.sweepWidth ?? 0.12));
  const trailEnd = ip + 0.06;
  if (p < sweepStart || p > trailEnd + 0.04) return [];
  const out = [];
  const span = Math.max(0.02, (ip - sweepStart) * 0.9);
  for (let i = 1; i <= n; i++) {
    const back = (i / n) * span;
    const pp = Math.max(sweepStart, p - back);
    const s = sampleSwing(rig, pp, ip);
    out.push({ angle: s.angle, dx: s.dx, dy: s.dy, scale: s.scale, alpha: (1 - i / (n + 1)) * 0.5 });
  }
  return out;
}

/** Total angular travel of a rig's strike (rough "how big is the swing"
 *  — used by the effect layer to match the arc to the blade). */
export function swingArcSpan(rig) {
  if (!rig) return 0;
  return Math.abs(rig.strike - rig.windup) % TAU;
}
