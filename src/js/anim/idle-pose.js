/**
 * M53 — Lifelike idle pose for the character viewer.
 *
 * The old "Animate" button cycled the composite's frameIdx every 130ms.
 * Human LPC bodies are idle-only (2 frames), so this produced a choppy,
 * barely-visible foot shuffle while re-compositing ~17 layers each tick.
 *
 * Instead we bake the composite ONCE and animate it with a smooth, pure
 * transform: gentle breathing (vertical rise + a hair of squash/stretch
 * pivoted at the feet), a slow weight-shift sway + micro-lean, and a
 * grounding contact shadow that pulses with the breath. The result reads
 * as a living idle at 60fps for a fraction of the cost.
 *
 * This module is the pure math — no canvas. `idlePoseAt(tMs)` returns the
 * transform for a given time; the renderer applies it. Amplitudes are in
 * sprite-fraction units so they scale with the drawn size.
 */

const TAU = Math.PI * 2;

/**
 * Sample the idle transform at time `tMs` (ms). All oscillations are
 * smooth sines at slow, mutually-detuned frequencies so the motion never
 * looks like a single pulsing loop. Pure + deterministic.
 *
 * Returns (all fractions of the sprite's drawn height/width unless noted):
 *   bobY        — vertical offset (− = up); breathing rise
 *   scaleX/scaleY — squash/stretch pivoted at the feet (chest rises on inhale)
 *   swayX       — horizontal weight-shift offset
 *   rot         — micro body lean (radians)
 *   shadowScale — contact-shadow size multiplier (shrinks as the body lifts)
 *   shadowAlpha — contact-shadow opacity (fades as the body lifts)
 */
export function idlePoseAt(tMs, opts = {}) {
  const {
    breathHz = 0.40,    // ~24 breaths/min — calm
    swayHz   = 0.27,    // slower weight shift, detuned from breathing
    breathAmp = 1,      // master scale for the breathing motion
    swayAmp   = 1       // master scale for the sway
  } = opts;
  const s = tMs / 1000;
  const breath = Math.sin(s * breathHz * TAU);            // -1..1
  const sway   = Math.sin(s * swayHz * TAU + 0.9);        // phase-offset
  // Secondary tiny tremor so peaks aren't identical loop to loop.
  const micro  = Math.sin(s * breathHz * TAU * 2.3) * 0.18;

  const b = breath * breathAmp;
  const w = sway * swayAmp;

  return {
    bobY:    (-(b + micro) * 0.020),         // rise up to ~2% of height
    scaleX:  1 - b * 0.009,                  // chest narrows a touch on inhale
    scaleY:  1 + b * 0.016,                  // ...and lengthens (rises)
    swayX:   w * 0.014,                      // weight shift ~1.4% of width
    rot:     w * 0.016,                      // micro lean, radians
    shadowScale: 1 - b * 0.08,               // shadow shrinks as body lifts
    shadowAlpha: 0.36 - b * 0.06             // ...and softens
  };
}
