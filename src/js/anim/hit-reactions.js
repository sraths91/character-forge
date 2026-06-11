/**
 * M56 Phase 5 — per-damage-type hit reactions.
 *
 * A fire hit and a cold hit used to read identically: same flinch,
 * same white flash, same shake. This pass layers a small, type-keyed
 * reaction on top of the composed sequence:
 *
 *   fire      — extra defender knockback + orange flash
 *   cold      — longer hit-pause (icy stiffness) + blue flash
 *   lightning — two staccato shakes 50ms apart + yellow flash
 *   necrotic  — defender alpha dip (life drain) + purple glyph
 *
 * Registry damageType values are capitalized ('Fire', 'Radiant') —
 * normalized to lowercase before keying. Unknown or missing types
 * return an untouched clone, so physical damage keeps the base read.
 *
 * Pure transform — applyHitReaction(seq, ctx) returns a NEW Sequence;
 * the input is never mutated. Inserted defender keyframes bake the
 * interpolated transform at their timestamp (via sampleSprite) so an
 * alpha-only patch can't yank the knockback settle back to x=0.
 */

import { cloneSeq, sampleSprite } from './sequence.js';

// Flash tints per type (brighter cousins of cinema's COLOR_FOR_TYPE).
const FLASH_TINTS = {
  fire:      '#fb923c',
  cold:      '#7dd3fc',
  lightning: '#fde047',
  necrotic:  '#c084fc'
};

// Cold stiffness: how much longer the impact freeze holds.
const COLD_EXTRA_PAUSE_MS = 80;

/**
 * Apply the damage-type reaction. Returns a new Sequence; unknown
 * types pass through as an untouched clone.
 *
 * @param {object} seq — composed sequence (post-polish)
 * @param {object} ctx — { damageType } (any casing)
 */
export function applyHitReaction(seq, ctx = {}) {
  if (!seq) return seq;
  const type = String(ctx.damageType || '').toLowerCase();
  const out = cloneSeq(seq);
  const react = REACTIONS[type];
  if (!react) return out;
  out.id = `${seq.id}+react-${type}`;
  react(out, impactTimeOf(out));
  out.meta = { ...out.meta, hitReaction: type };
  return out;
}

/* =====================================================================
 * Per-type builders — each mutates the fresh clone in place.
 * ===================================================================== */

const REACTIONS = {
  fire(out, impactAt) {
    // The blast shoves the defender a few extra pixels past the
    // weapon knockback before the normal settle pulls them home.
    const kick = bakedKeyframe(out, 'defender', impactAt + 60);
    out.keyframes.push({ ...kick, x: kick.x + 8, easing: 'easeOut' });
    out.effects.push({
      at: impactAt + 10, type: 'flash',
      params: { intensity: 0.35, color: FLASH_TINTS.fire }
    });
  },

  cold(out, impactAt) {
    // Icy stiffness: the impact freeze holds longer.
    const pause = out.effects.find(e => e.type === 'hit-pause');
    if (pause) {
      pause.params = {
        ...pause.params,
        duration: (pause.params?.duration || 200) + COLD_EXTRA_PAUSE_MS
      };
    }
    out.effects.push({
      at: impactAt + 10, type: 'flash',
      params: { intensity: 0.3, color: FLASH_TINTS.cold }
    });
  },

  lightning(out, impactAt) {
    // Staccato double-shudder instead of one smooth decay.
    out.effects.push(
      { at: impactAt + 20, type: 'shake', params: { amplitude: 5, freq: 34 } },
      { at: impactAt + 70, type: 'shake', params: { amplitude: 4, freq: 34 } },
      { at: impactAt + 10, type: 'flash',
        params: { intensity: 0.4, color: FLASH_TINTS.lightning } }
    );
  },

  necrotic(out, impactAt) {
    // Life drain: the defender dims briefly, then recovers (unless a
    // killing fade takes over later in the sequence).
    const dip = bakedKeyframe(out, 'defender', impactAt + 40);
    const back = bakedKeyframe(out, 'defender', impactAt + 200);
    out.keyframes.push(
      { ...dip, alpha: 0.55, easing: 'easeOut' },
      { ...back, easing: 'easeOut' }
    );
    out.effects.push({
      at: Math.max(0, impactAt - 40), type: 'glyph-rise',
      params: { damageType: 'necrotic' }
    });
  }
};

/* =====================================================================
 * Helpers
 * ===================================================================== */

function impactTimeOf(seq) {
  const ev = seq.effects.find(e => e.type === 'hit-pause');
  return ev ? ev.at : Math.floor((seq.duration || 1000) / 2);
}

/** Full interpolated transform at `at`, as keyframe fields — patches
 *  stay transparent to every channel they don't touch. */
function bakedKeyframe(seq, actor, at) {
  const s = sampleSprite(seq, actor, at);
  return {
    at, actor,
    x: s.x, y: s.y, rotation: s.rotation, scale: s.scale, alpha: s.alpha
  };
}
