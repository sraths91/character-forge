/**
 * M43.0 — Timeline player.
 *
 * Drives a Sequence over wall-clock time using requestAnimationFrame.
 * Each tick:
 *   1. Compute `now` (ms from start), accounting for any active hit-pause.
 *   2. Fire all effects whose `at` falls in (prevNow, now].
 *   3. Sample sprite state for attacker + defender via sampleSprite().
 *   4. Invoke the consumer's render() with snapshot + fired effects.
 *   5. If now >= duration, resolve the playback Promise.
 *
 * The render callback shape:
 *   render({
 *     attacker: { x, y, rotation, scale, alpha },
 *     defender: { x, y, rotation, scale, alpha },
 *     effects:  [...],         // effects fired this tick (in order)
 *     hitPauseUntil: number,   // ms timestamp; sprites freeze until this
 *     shake: { x, y } | null,  // current screen-shake offset
 *     flash: number            // 0..1 white flash intensity
 *   })
 *
 * The player resolves its Promise when the sequence completes, OR when
 * .cancel() is called. Built to be cancelable so a fight can be skipped.
 *
 * Pure with respect to time + the rng — for tests we expose
 * `tick({now})` so a test harness can drive frames manually.
 */

import { sampleSprite, effectsBetween } from './sequence.js';

/**
 * Play `seq` against `render`. Returns a Promise that resolves when
 * the sequence completes (or rejects if cancelled).
 *
 * Options:
 *   speed         — playback multiplier (1 = real-time, 2 = 2× fast)
 *   onComplete    — called once at the end
 *   manualTicks   — TEST helper. When true, the player does NOT use rAF;
 *                   the caller must drive playback via .tick(ms).
 */
export function playSequence(seq, render, opts = {}) {
  const { speed = 1, manualTicks = false } = opts;
  const start = nowMs();
  let prevNow = 0;
  let hitPauseUntil = 0;
  let shake = null;
  let flash = 0;
  let cancelled = false;
  let frameId = null;
  let resolveFn = null;

  let tickFn = null;
  const promise = new Promise((resolve, reject) => {
    resolveFn = resolve;
    // Tick function — usable in both rAF and manual modes
    const tick = (msSinceStart) => {
      if (cancelled) { reject(new Error('cancelled')); return; }
      // Account for hit-pause: any time spent in pause doesn't advance
      // the sequence clock.
      const now = msSinceStart * speed;
      const fired = effectsBetween(seq, prevNow, now);
      let nextHitPause = hitPauseUntil;
      let nextShake = shake;
      let nextFlash = Math.max(0, flash - 0.05);   // decay flash
      for (const ef of fired) {
        if (ef.type === 'hit-pause') {
          nextHitPause = now + (ef.params?.duration || 200);
        } else if (ef.type === 'shake') {
          nextShake = shakeAt(ef.params || {}, now);
        } else if (ef.type === 'flash') {
          nextFlash = ef.params?.intensity ?? 0.8;
        }
      }
      // Sprite snapshots
      const att = sampleSprite(seq, 'attacker', now);
      const def = sampleSprite(seq, 'defender', now);
      // Dynamic shake — decays each frame after the impulse
      if (nextShake) nextShake = decayShake(nextShake);
      render({
        attacker: att, defender: def,
        effects: fired, hitPauseUntil: nextHitPause,
        shake: nextShake, flash: nextFlash, t: now,
        duration: seq.duration
      });
      hitPauseUntil = nextHitPause;
      shake = nextShake;
      flash = nextFlash;
      prevNow = now;
      if (now >= seq.duration) {
        resolve({ completed: true });
        return;
      }
      if (!manualTicks) frameId = requestAnimationFrame(() => tick(nowMs() - start));
    };
    if (!manualTicks) frameId = requestAnimationFrame(() => tick(0));
    tickFn = tick;
  });

  return {
    promise,
    cancel() {
      cancelled = true;
      if (frameId && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frameId);
      try { if (resolveFn) resolveFn({ completed: false, cancelled: true }); } catch {}
    },
    /** TEST helper: advance manually to `ms` since start. */
    tick(ms) { tickFn?.(ms); }
  };
}

// ----- helpers -----

function nowMs() {
  if (typeof performance !== 'undefined' && performance.now) return performance.now();
  return Date.now();
}

function shakeAt(params, _now) {
  return {
    x: 0, y: 0,
    amplitude: params.amplitude ?? 4,
    decay: params.decay ?? 0.85
  };
}

function decayShake(s) {
  if (!s || s.amplitude < 0.1) return null;
  // Pseudo-random shake offset, decaying per frame
  return {
    x: (Math.random() * 2 - 1) * s.amplitude,
    y: (Math.random() * 2 - 1) * s.amplitude,
    amplitude: s.amplitude * s.decay,
    decay: s.decay
  };
}
