/**
 * M43.3 — Attack motion styles.
 *
 * A "style" is a *variant* of a base weapon motion. The base sequence
 * from M43.1 defines the canonical flow; the style transforms it into
 * an alternative reading of the same strike:
 *
 *   quick     — 0.7× duration, lighter hit-pause, tighter wind-up.
 *               Reads as a fast, controlled jab. Available at lvl 1.
 *   standard  — identity. The base motion from M43.1.
 *   power     — 1.25× duration, deeper wind-up, longer hit-pause,
 *               bigger screen shake. Reads as a deliberate, heavy swing.
 *               Available at lvl 3+ (player has the technique).
 *   flourish  — 1.30× duration, adds a follow-up secondary effect
 *               (the "decorative" extra slash a level-5+ character
 *               uses for emphasis). Available at lvl 5+.
 *
 * Pure transforms — each takes a Sequence (M43.0 shape) and returns a
 * NEW sequence. Never mutates the source.
 *
 * Storage: each PC carries an `_attackStyle` field (one of the four
 * style ids). Defaults to 'standard'. The UI persists to localStorage
 * under `cf_attackStyle_<characterId>` so style choice survives
 * reloads + character re-imports.
 */

import { cloneProfile as _ } from '../scene/ai/editor.js';   // unused; placeholder to flag related module

void _;

const STYLE_IDS = ['quick', 'standard', 'power', 'flourish'];

/**
 * Per-style transform parameters. Used by applyStyle() to scale the
 * base sequence. Pure data — extending here adds a style without
 * touching the runtime.
 */
export const STYLES = {
  quick: {
    id: 'quick',
    label: 'Quick Strike',
    description: 'Faster swing, lighter weight. Less anticipation, snappier release.',
    minLevel: 1,
    speed: 1 / 0.7,              // ~1.43× faster
    hitPauseScale: 0.55,
    shakeScale: 0.75,
    extraEffects: []             // no decorative additions
  },
  standard: {
    id: 'standard',
    label: 'Standard',
    description: 'The textbook swing. Balanced anticipation and follow-through.',
    minLevel: 1,
    speed: 1.0,
    hitPauseScale: 1.0,
    shakeScale: 1.0,
    extraEffects: []
  },
  power: {
    id: 'power',
    label: 'Power Cleave',
    description: 'Deeper wind-up. Heavier impact, longer hit-pause, ground-shaking follow-through.',
    minLevel: 3,
    speed: 1 / 1.25,              // ~20% slower
    hitPauseScale: 1.7,
    shakeScale: 1.6,
    extraEffects: []
  },
  flourish: {
    id: 'flourish',
    label: 'Flourish',
    description: 'Adds a decorative trailing strike. The signature of a master.',
    minLevel: 5,
    speed: 1 / 1.30,
    hitPauseScale: 1.4,
    shakeScale: 1.2,
    // Trailing secondary effect — fires after the primary impact for
    // visual emphasis. The effect's specific type is filled in at
    // apply time from the primary impact effect's type.
    extraEffects: [{ at: 'impact+200', type: '__primary__', alpha: 0.6 }]
  }
};

/**
 * Pick the highest-tier style available to a PC of `level`. Used to
 * default new characters to their most flattering style (e.g. a
 * lvl-5 PC defaults to Power rather than Standard).
 */
export function defaultStyleForLevel(level) {
  const lvl = Number(level) || 1;
  // Default to Standard regardless of level — Power/Flourish are
  // opt-ins. New PCs see the textbook swing first.
  return lvl >= 1 ? 'standard' : 'standard';
}

/** All styles a PC of `level` can pick from. Returns an array sorted
 *  by minLevel ascending. */
export function availableStyles(level) {
  const lvl = Number(level) || 1;
  return STYLE_IDS
    .map(id => STYLES[id])
    .filter(s => lvl >= s.minLevel)
    .sort((a, b) => a.minLevel - b.minLevel);
}

/** Is `styleId` a known style id? */
export function isStyle(styleId) {
  return STYLE_IDS.includes(styleId);
}

/**
 * Apply a style transform to a base sequence. Returns a NEW Sequence
 * object — the input is never mutated.
 *
 *   - All keyframe `at` values scale by 1/style.speed
 *   - All effect `at` values scale similarly
 *   - hit-pause effects have their duration scaled by hitPauseScale
 *   - shake effects have their amplitude scaled by shakeScale
 *   - extraEffects are appended after the impact moment
 */
export function applyStyle(seq, styleId) {
  if (!seq) return seq;
  const style = STYLES[styleId] || STYLES.standard;
  if (style.speed === 1 && style.hitPauseScale === 1 && style.shakeScale === 1 && !style.extraEffects.length) {
    // Standard / identity — return a clone so callers can still mutate.
    return cloneSeq(seq);
  }
  const scale = 1 / style.speed;
  const out = {
    id: `${seq.id}:${style.id}`,
    duration: Math.round(seq.duration * scale),
    keyframes: seq.keyframes.map(k => ({
      ...k,
      at: Math.round(k.at * scale)
    })),
    effects: seq.effects.map(e => ({
      ...e,
      at: Math.round(e.at * scale),
      params: scaleEffectParams(e, style)
    })),
    meta: { ...(seq.meta || {}), style: style.id }
  };

  // Append flourish-style secondary effects after the primary impact
  if (style.extraEffects && style.extraEffects.length > 0) {
    const primary = findPrimaryImpactEffect(out);
    if (primary) {
      const impactAt = primary.at;
      for (const tmpl of style.extraEffects) {
        const at = resolveTemplateTime(tmpl.at, impactAt);
        const type = tmpl.type === '__primary__' ? primary.type : tmpl.type;
        out.effects.push({
          at, type,
          params: { ...(primary.params || {}), alpha: tmpl.alpha ?? 0.6, _secondary: true }
        });
      }
      // Bump duration to cover the trail
      const maxAt = out.effects.reduce((m, e) => Math.max(m, e.at), out.duration);
      out.duration = Math.max(out.duration, maxAt + 200);
    }
  }
  return out;
}

function cloneSeq(seq) {
  return {
    id: seq.id,
    duration: seq.duration,
    keyframes: seq.keyframes.map(k => ({ ...k })),
    effects: seq.effects.map(e => ({ ...e, params: { ...(e.params || {}) } })),
    meta: { ...(seq.meta || {}) }
  };
}

function scaleEffectParams(effect, style) {
  const params = { ...(effect.params || {}) };
  if (effect.type === 'hit-pause' && Number.isFinite(params.duration)) {
    params.duration = Math.round(params.duration * style.hitPauseScale);
  }
  if (effect.type === 'shake' && Number.isFinite(params.amplitude)) {
    params.amplitude = +(params.amplitude * style.shakeScale).toFixed(2);
  }
  return params;
}

/** The first non-engine effect — slash-arc, thrust, bash, etc. */
function findPrimaryImpactEffect(seq) {
  const skip = new Set(['hit-pause', 'shake', 'flash']);
  for (const e of seq.effects) {
    if (!skip.has(e.type)) return e;
  }
  return null;
}

function resolveTemplateTime(tmpl, impactAt) {
  if (typeof tmpl === 'number') return tmpl;
  // 'impact+200' style
  const m = String(tmpl).match(/^impact([+-])(\d+)$/);
  if (m) {
    const sign = m[1] === '+' ? 1 : -1;
    return impactAt + sign * Number(m[2]);
  }
  return impactAt;
}

/* =====================================================================
 * Per-PC storage (localStorage) — wired by the UI layer
 * ===================================================================== */

const STORAGE_PREFIX = 'cf_attackStyle_';

// Fallback in-memory store. Used when localStorage isn't available
// (node test runner, SSR) so saveStyle / loadStyle still round-trip.
const memoryStore = new Map();

function storage() {
  // Prefer localStorage when it's a real Storage with both get + set.
  const ls = globalThis?.localStorage;
  if (ls && typeof ls.getItem === 'function' && typeof ls.setItem === 'function') return ls;
  // Otherwise return an in-memory shim that behaves the same.
  return {
    getItem: (k) => memoryStore.has(k) ? memoryStore.get(k) : null,
    setItem: (k, v) => memoryStore.set(k, String(v)),
    removeItem: (k) => memoryStore.delete(k)
  };
}

/** Read the saved style for `characterId`. Returns null if unset. */
export function loadStyle(characterId) {
  if (!characterId) return null;
  try {
    const v = storage().getItem(STORAGE_PREFIX + characterId);
    return isStyle(v) ? v : null;
  } catch { return null; }
}

/** Persist a style choice for `characterId`. */
export function saveStyle(characterId, styleId) {
  if (!characterId) return;
  if (!isStyle(styleId)) return;
  try { storage().setItem(STORAGE_PREFIX + characterId, styleId); } catch {}
}

/** Resolve the *effective* style for a PC: explicit override > saved
 *  preference > default for level. Pure — takes a character record. */
export function styleForPc(pc) {
  if (!pc) return 'standard';
  if (isStyle(pc._attackStyle)) return pc._attackStyle;
  const saved = loadStyle(pc.id);
  if (saved && isStyle(saved)) {
    const lvl = totalLevel(pc);
    return lvl >= STYLES[saved].minLevel ? saved : 'standard';
  }
  return defaultStyleForLevel(totalLevel(pc));
}

function totalLevel(pc) {
  return (pc?.classes || []).reduce((s, c) => s + (c?.level || 0), 0) || 1;
}
