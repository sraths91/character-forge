/**
 * M43.0 — Animation sequence data model.
 *
 * A Sequence is an ordered list of Keyframes and Effects with absolute
 * timing in milliseconds. The Timeline player consumes a Sequence and
 * drives a render callback at rAF frequency until the sequence ends.
 *
 * Designed for Fire-Emblem-GBA-style 1v1 cinematic combat:
 *   - Sequences are scripted (mechanical resolution decided first;
 *     the animation just dramatizes it).
 *   - Hit-pause + screen-shake + camera zoom are first-class primitives.
 *   - Sequences compose: a "longsword power slash" sequence can be
 *     wrapped by a "sneak attack" modifier sequence that adds a shadow
 *     overlay during specific frames.
 *
 * Time is in milliseconds from sequence start. The timeline interpolates
 * sprite transforms between keyframes using a per-keyframe `easing`
 * function. Effects fire at instants (no interpolation).
 *
 * Reference: 12 principles of animation (Thomas/Johnston, 1981),
 *   especially anticipation, follow-through, and squash & stretch.
 *   FE GBA pacing: ~30fps, attack scenes 1000-2000ms total, hit-pause
 *   ~200ms on impact.
 *
 * Pure data + transforms — no DOM, no rendering. The Timeline player
 * (timeline.js) drives the actual rAF loop and calls the consumer's
 * render function.
 */

// ----- Easing functions -----

export const EASING = {
  linear:    t => t,
  easeIn:    t => t * t,
  easeOut:   t => 1 - (1 - t) * (1 - t),
  easeInOut: t => t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2,
  // Anticipation curve: overshoots backward before forward motion
  // (e.g. a sword-arm pulling back before the swing).
  anticipate: t => t < 0.3
    ? -0.5 * (t / 0.3)   // pull back -0..-0.5
    : -0.5 + 1.5 * ((t - 0.3) / 0.7)   // accelerate forward
};

// ----- Keyframe schema -----

/**
 * @typedef {object} SpriteKeyframe
 * @property {number}   at         — time in ms from sequence start
 * @property {string}   actor      — 'attacker' | 'defender' (which sprite)
 * @property {number}   [x]        — pixel offset from anchor (default keeps prior)
 * @property {number}   [y]
 * @property {number}   [rotation] — radians (default 0)
 * @property {number}   [scale]    — uniform scale (default 1)
 * @property {number}   [alpha]    — 0..1 (default 1)
 * @property {string}   [easing]   — name of EASING fn used to reach this frame
 *                                   (default 'easeOut')
 */

/**
 * @typedef {object} EffectInstant
 * @property {number} at         — time in ms
 * @property {string} type       — primitive id ('slash-arc' | 'thrust' | ...)
 *                                 OR engine event ('hit-pause' | 'shake' | 'flash')
 * @property {object} [params]   — primitive-specific payload
 */

/**
 * @typedef {object} Sequence
 * @property {string}            id
 * @property {number}            duration       — total length in ms
 * @property {SpriteKeyframe[]}  keyframes
 * @property {EffectInstant[]}   effects
 * @property {object}            [meta]         — author-supplied tags (weapon, archetype, level)
 */

/** Build an empty sequence. Helper for fluent authoring. */
export function newSequence(id, duration = 1000) {
  return { id, duration, keyframes: [], effects: [], meta: {} };
}

/** Push a sprite keyframe. Returns the sequence for chaining. */
export function addKey(seq, kf) {
  seq.keyframes.push({ easing: 'easeOut', ...kf });
  return seq;
}

/** Push an effect instant. */
export function addEffect(seq, ef) {
  seq.effects.push(ef);
  return seq;
}

/**
 * Resolve sprite state at time `t` (ms from sequence start) for a given
 * actor by interpolating between bracketing keyframes. Returns the
 * snapshot { x, y, rotation, scale, alpha } the Timeline can hand to
 * the renderer.
 */
export function sampleSprite(seq, actor, t) {
  const frames = seq.keyframes
    .filter(k => k.actor === actor)
    .sort((a, b) => a.at - b.at);
  if (frames.length === 0) return identityTransform();
  if (t <= frames[0].at) return frameTransform(frames[0]);
  if (t >= frames[frames.length - 1].at) return frameTransform(frames[frames.length - 1]);
  // Find bracketing pair
  let prev = frames[0];
  let next = frames[1];
  for (let i = 1; i < frames.length; i++) {
    if (frames[i].at >= t) { prev = frames[i - 1]; next = frames[i]; break; }
  }
  const span = Math.max(1, next.at - prev.at);
  const localT = (t - prev.at) / span;
  const ease = EASING[next.easing || 'easeOut'] || EASING.easeOut;
  const k = ease(Math.max(0, Math.min(1, localT)));
  const a = frameTransform(prev);
  const b = frameTransform(next);
  return {
    x:        lerp(a.x, b.x, k),
    y:        lerp(a.y, b.y, k),
    rotation: lerp(a.rotation, b.rotation, k),
    scale:    lerp(a.scale, b.scale, k),
    alpha:    lerp(a.alpha, b.alpha, k)
  };
}

/** Collect every effect that should fire between `t0` (exclusive) and
 *  `t1` (inclusive). Stable order: by `at` ascending, then array order. */
export function effectsBetween(seq, t0, t1) {
  return seq.effects.filter(e => e.at > t0 && e.at <= t1);
}

/**
 * Hit-pause helper: insert a "freeze" segment at time `at` for `duration`
 * ms. Shifts every subsequent keyframe + effect by `duration`. The
 * timeline player treats hit-pause as a no-tick window — sprites stay
 * frozen at their `at` state.
 */
export function insertHitPause(seq, at, duration = 200) {
  for (const k of seq.keyframes) if (k.at > at) k.at += duration;
  for (const e of seq.effects)   if (e.at > at) e.at += duration;
  seq.effects.push({ at, type: 'hit-pause', params: { duration } });
  seq.duration += duration;
  return seq;
}

/**
 * Apply a modifier to an existing sequence. A modifier is itself a
 * partial sequence; its keyframes and effects are layered on top of
 * the base. Useful for Sneak Attack / Rage / Smite overlays.
 *
 * Modifiers compose left-to-right: applyModifier(base, sneak), then
 * applyModifier(result, rage) stacks both effects.
 */
export function applyModifier(base, modifier) {
  const out = {
    id: `${base.id}+${modifier.id || 'mod'}`,
    duration: Math.max(base.duration, modifier.duration || 0),
    keyframes: [...base.keyframes, ...(modifier.keyframes || [])],
    effects:   [...base.effects,   ...(modifier.effects || [])],
    meta:      { ...base.meta, ...(modifier.meta || {}) }
  };
  return out;
}

// ----- helpers -----

function identityTransform() {
  return { x: 0, y: 0, rotation: 0, scale: 1, alpha: 1 };
}
function frameTransform(k) {
  return {
    x: k.x ?? 0,
    y: k.y ?? 0,
    rotation: k.rotation ?? 0,
    scale: k.scale ?? 1,
    alpha: k.alpha ?? 1
  };
}
function lerp(a, b, k) { return a + (b - a) * k; }
