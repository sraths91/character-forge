/**
 * Path A — procedural secondary motion.
 *
 * The character's baked idle already breathes (real frames + an integer
 * weight-shift). What it lacks is *follow-through*: hair, cloak and
 * strapped weapons ride the body in rigid lockstep, so the whole figure
 * moves as one board. Real bodies drag their loose parts a beat behind the
 * core and let them settle — that lag is what reads as "alive".
 *
 * This module is the pure math for that lag: a damped spring evaluated as
 * an IMMUTABLE step so it stays deterministic and unit-testable, plus a
 * slow non-harmonic hip sway so the loop never feels metronomic. No canvas
 * — the renderer reads the offset and applies it. Amplitudes are caller's
 * units (px or sprite-fraction); this module only does the dynamics.
 */

const TAU = Math.PI * 2;

/**
 * Translate an intuitive (frequency, damping-ratio) pair into raw spring
 * constants. `freqHz` is how fast the part wants to catch up; `damping`
 * is the ratio — 1 is critically damped (fast, no overshoot), &lt;1 adds a
 * springy bounce, &gt;1 is sluggish.
 *
 * @param {number} freqHz    Natural frequency in Hz.
 * @param {number} [damping] Damping ratio ζ (default 1 — critical).
 * @returns {{stiffness:number, damping:number}} Raw constants for {@link springStep}.
 */
export function springConfig(freqHz, damping = 1) {
  const omega = TAU * freqHz;
  return { stiffness: omega * omega, damping: 2 * damping * omega };
}

/**
 * Advance a 1-D spring one step toward `target`. Pure: returns a NEW state,
 * never mutates the input. Semi-implicit Euler — stable at the ~16ms steps
 * an idle loop runs, and `dt` is clamped so a paused/backgrounded tab that
 * resumes with a huge delta can't fling the spring across the screen.
 *
 * @param {{x:number, v:number}} state          Current position + velocity.
 * @param {number}               target         Where the part wants to be.
 * @param {number}               dtMs           Elapsed ms since the last step.
 * @param {{stiffness:number, damping:number}} cfg  From {@link springConfig}.
 * @returns {{x:number, v:number}} The next state.
 */
export function springStep(state, target, dtMs, cfg) {
  const dt = Math.min(0.032, Math.max(0, dtMs / 1000));   // clamp to ≤2 frames
  const accel = cfg.stiffness * (target - state.x) - cfg.damping * state.v;
  const v = state.v + accel * dt;
  const x = state.x + v * dt;
  return { x, v };
}

/**
 * A slow, non-harmonic hip weight-sway, decoupled from the breath so the
 * two never phase-lock into one obvious pulse. Two detuned sines summed and
 * normalised → a wander in [-amp, amp] that drifts rather than ticks.
 *
 * @param {number} tMs         Time in ms.
 * @param {number} [amp]       Peak offset in the caller's units (default 1).
 * @param {number} [periodSec] Rough period of the primary sway (default 4s).
 * @returns {number} Signed offset in [-amp, amp].
 */
export function hipSwayAt(tMs, amp = 1, periodSec = 4) {
  const s = tMs / 1000;
  const a = Math.sin((s / periodSec) * TAU);
  const b = Math.sin((s / (periodSec * 1.618)) * TAU + 1.3);   // golden-detuned
  return ((a * 0.6 + b * 0.4)) * amp;
}
