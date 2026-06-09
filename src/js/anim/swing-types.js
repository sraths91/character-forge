/**
 * M54 — Attack-swing types.
 *
 * A "swing" is the DIRECTION/shape of a cut — orthogonal to the weapon
 * MOTION (weapon-motions.js: which weapon) and the INTENSITY style
 * (motion-styles.js: Quick/Standard/Power/Flourish). It lets one sword do
 * many different strikes.
 *
 * The set is grounded in HEMA's longsword cuts (each is a direction):
 *   diagonal   — Zornhau / Oberhau (down-cross), the default
 *   overhead   — Scheitelhau (straight vertical chop)
 *   horizontal — Zwerchhau / Mittelhau (flat side sweep)
 *   rising     — Unterhau (upward, hip → opposite shoulder)
 *   thrust     — Stich (minimal rotation, long forward lunge)
 *   backslash  — reverse cut (front → back)
 *   spin       — flourish (full 360° spinning slash)
 * Plus the selection MODE `varied`, which alternates the weapon-
 * appropriate types per attack (game-combat anti-monotony).
 *
 * Each type carries three coordinated cues consumed downstream:
 *   - `arc`    — a procedural rotation rig for the cinema weapon overlay
 *                (sampled by weapon-swing.js sampleSwing). Merged over the
 *                weapon-class rig (which supplies the grip pivot).
 *   - effect   — `applySwing` stamps `params.swing` so the slash-effect
 *                swoosh re-orients (vertical / flat / rising / loop).
 *   - `body`   — a light attacker-keyframe tweak (overhead drops, rising
 *                lifts, thrust lunges, spin rotates).
 *
 * Persistence mirrors motion-styles.js: each PC carries `_swingType`;
 * the UI persists to localStorage under `cf_swingType_<characterId>`.
 */

const SWING_IDS = ['diagonal', 'overhead', 'horizontal', 'rising', 'thrust', 'backslash', 'spin'];

/**
 * Swing table. `arc` angles use the weapon-swing.js convention (radians,
 * deltas from the weapon's native frame; + rotates the tip forward/down).
 * `effect` keys drawSlashArc's geometry. `body` is the attacker tweak at
 * the strike: { dy (+down), drot, dlunge }.
 */
export const SWING_TYPES = {
  diagonal: {
    id: 'diagonal', label: 'Diagonal Slash', hema: 'Zornhau',
    desc: 'A committed down-cross from shoulder to opposite hip. The classic strike.',
    weapons: '*',
    arc: { rest: 0, windup: -0.7, strike: 1.9, follow: 2.2, lunge: 0.12, sweepWidth: 0.12, trail: true, strikeScale: 1.05 },
    effect: 'diagonal', body: { dy: 0, drot: 0, dlunge: 0 }, useFrames: true,
    timing: { speed: 1.0, hitPause: 1.0 }, verb: 'slashes'
  },
  overhead: {
    id: 'overhead', label: 'Overhead Chop', hema: 'Scheitelhau',
    desc: 'Raise high and split straight down the centre. Heavy and vertical.',
    weapons: '*',
    arc: { rest: 0, windup: -1.5, strike: 1.7, follow: 2.0, lunge: 0.10, sweepWidth: 0.15, trail: true, strikeScale: 1.09 },
    effect: 'overhead', body: { dy: 7, drot: 0.10, dlunge: 0 },
    timing: { speed: 0.80, hitPause: 1.5 }, verb: 'cleaves down on'
  },
  horizontal: {
    id: 'horizontal', label: 'Horizontal Sweep', hema: 'Zwerchhau',
    desc: 'A flat side-to-side cut across the centre line.',
    weapons: '*',
    arc: { rest: 0, windup: -1.05, strike: 1.0, follow: 1.2, lunge: 0.30, sweepWidth: 0.12, trail: true, strikeScale: 1.04 },
    effect: 'horizontal', body: { dy: 0, drot: 0, dlunge: 6 },
    timing: { speed: 1.08, hitPause: 0.9 }, verb: 'sweeps across'
  },
  rising: {
    id: 'rising', label: 'Rising Cut', hema: 'Unterhau',
    desc: 'A rising diagonal from the hip to the opposite shoulder.',
    weapons: '*',
    arc: { rest: 0, windup: 1.2, strike: -1.4, follow: -1.7, lunge: 0.18, sweepWidth: 0.14, trail: true, strikeScale: 1.05 },
    effect: 'rising', body: { dy: -7, drot: -0.08, dlunge: 0 },
    timing: { speed: 1.12, hitPause: 0.9 }, verb: 'cuts upward at'
  },
  thrust: {
    id: 'thrust', label: 'Thrust', hema: 'Stich',
    desc: 'A straight point-first lunge. Little rotation, lots of reach.',
    weapons: '*',
    arc: { rest: 0, windup: -0.25, strike: 0.12, follow: 0.0, lunge: 0.85, sweepWidth: 0.10, trail: true, strikeScale: 1.04 },
    effect: 'thrust', body: { dy: 0, drot: 0, dlunge: 14 },
    timing: { speed: 1.25, hitPause: 0.85 }, verb: 'lunges at'
  },
  backslash: {
    id: 'backslash', label: 'Backslash', hema: 'reverse cut',
    desc: 'A reverse horizontal cut sweeping back across the body.',
    weapons: '*',
    arc: { rest: 0, windup: 0.9, strike: -1.6, follow: -1.9, lunge: 0.18, sweepWidth: 0.12, trail: true, strikeScale: 1.05 },
    effect: 'backslash', body: { dy: 0, drot: -0.06, dlunge: 4 },
    timing: { speed: 0.95, hitPause: 1.1 }, verb: 'backslashes'
  },
  spin: {
    id: 'spin', label: 'Spinning Slash', hema: 'flourish',
    desc: 'A full spinning cut — a whirl of steel. Showy and wide.',
    weapons: ['sword', 'heavy', 'polearm'],
    arc: { rest: 0, windup: -0.6, strike: 5.7, follow: 6.28, lunge: 0.16, sweepWidth: 0.26, trail: true, strikeScale: 1.07, spin: true },
    effect: 'spin', body: { dy: 0, drot: 0.5, dlunge: 4 },
    timing: { speed: 0.78, hitPause: 1.35 }, verb: 'spins into'
  }
};

const DEFAULT_SWING = 'diagonal';
const STORAGE_PREFIX = 'cf_swingType_';

/** Is `id` a concrete swing type? ('varied' is a mode, not a type.) */
export function isSwing(id) { return SWING_IDS.includes(id); }

/** Is `id` a valid selection (a type OR the 'varied' mode)? */
export function isSwingSelection(id) { return id === 'varied' || isSwing(id); }

/**
 * The swing types appropriate for a weapon class. Permissive — every
 * melee weapon can do every cut except where it reads badly (spin is
 * gated to longer weapons; daggers/fists skip it).
 */
export function availableSwings(weaponClass) {
  return SWING_IDS
    .map(id => SWING_TYPES[id])
    .filter(s => s.weapons === '*' || (Array.isArray(s.weapons) && s.weapons.includes(weaponClass)));
}

/** Deterministic next swing for the `varied` mode — cycles the weapon's
 *  available types by attack index `n` (no Math.random; reproducible). */
export function nextVariedSwing(weaponClass, n) {
  const list = availableSwings(weaponClass);
  if (!list.length) return DEFAULT_SWING;
  const i = ((n % list.length) + list.length) % list.length;
  return list[i].id;
}

/* ----- persistence (mirrors motion-styles.js) ----- */
function storage() {
  try { return globalThis.localStorage || { getItem: () => null, setItem: () => {} }; }
  catch { return { getItem: () => null, setItem: () => {} }; }
}
export function loadSwing(characterId) {
  if (!characterId) return null;
  try { const v = storage().getItem(STORAGE_PREFIX + characterId); return isSwingSelection(v) ? v : null; }
  catch { return null; }
}
export function saveSwing(characterId, swingId) {
  if (!characterId || !isSwingSelection(swingId)) return;
  try { storage().setItem(STORAGE_PREFIX + characterId, swingId); } catch {}
}

/** Effective swing SELECTION for a PC: explicit override > saved > default.
 *  May return 'varied' — callers resolve that to a concrete type per
 *  attack via nextVariedSwing. */
export function swingForPc(pc) {
  if (!pc) return DEFAULT_SWING;
  if (isSwingSelection(pc._swingType)) return pc._swingType;
  const saved = loadSwing(pc.id);
  return saved || DEFAULT_SWING;
}

/** The procedural arc rig for a swing type (for the weapon overlay).
 *  Returns null for unknown ids. */
export function swingArcRig(swingId) {
  const s = SWING_TYPES[swingId];
  return s ? s.arc : null;
}

/**
 * Apply a swing to a base motion sequence. Pure — returns a NEW sequence:
 *   - re-orients the primary cut effect (slash-arc / thrust / bash) by
 *     stamping `params.swing` so drawSlashArc picks the matching swoosh
 *   - applies the swing's `body` tweak to the attacker's strike-region
 *     keyframes (vertical drop/lift, extra lunge, spin rotation)
 *   - stamps `meta.swing`
 * Composes AFTER applyStyle in the cinema pipeline.
 */
export function applySwing(seq, swingId) {
  if (!seq) return seq;
  const swing = SWING_TYPES[swingId];
  // M54b — per-swing TIMING: scale the whole sequence so each cut FEELS
  // distinct (overhead/spin slow + heavy hit-pause; thrust/rising snappy).
  // Mirrors applyStyle's speed/hitPause scaling so the two compose.
  const speed = swing?.timing?.speed ?? 1;
  const hitPauseScale = swing?.timing?.hitPause ?? 1;
  const ts = 1 / speed;
  const out = {
    id: swing ? `${seq.id}:${swing.id}` : seq.id,
    duration: Math.round(seq.duration * ts),
    keyframes: seq.keyframes.map(k => ({ ...k, at: Math.round((k.at || 0) * ts) })),
    effects: seq.effects.map(e => ({
      ...e,
      at: Math.round((e.at || 0) * ts),
      params: scaleSwingEffectParams(e, hitPauseScale)
    })),
    meta: {
      ...(seq.meta || {}),
      swing: swing ? swing.id : (seq.meta?.swing || null),
      swingVerb: swing?.verb || seq.meta?.swingVerb || null
    }
  };
  if (!swing) return out;

  // Re-orient the primary cut effect(s).
  for (const e of out.effects) {
    if (e.type === 'slash-arc' || e.type === 'thrust' || e.type === 'bash') {
      e.params.swing = swing.id;
    }
  }

  // Body tweak: find the attacker's strike keyframe (largest |x|) and
  // nudge it + its follow toward the swing's signature.
  const att = out.keyframes.filter(k => k.actor === 'attacker');
  if (att.length && (swing.body.dy || swing.body.drot || swing.body.dlunge)) {
    const strike = att.reduce((m, k) => (Math.abs(k.x || 0) > Math.abs(m.x || 0) ? k : m), att[0]);
    const strikeIdx = out.keyframes.indexOf(strike);
    for (let i = strikeIdx; i < out.keyframes.length; i++) {
      const k = out.keyframes[i];
      if (k.actor !== 'attacker') continue;
      const fade = i === strikeIdx ? 1 : 0.45;   // strike full, follow half
      k.y = (k.y || 0) + swing.body.dy * fade;
      k.rotation = (k.rotation || 0) + swing.body.drot * fade;
      k.x = (k.x || 0) + swing.body.dlunge * fade;
    }
  }
  return out;
}

/** Scale a hit-pause effect's duration by the swing's hitPause factor
 *  (heavier swings hold the freeze longer). Other effects pass through. */
function scaleSwingEffectParams(e, hitPauseScale) {
  const params = { ...(e.params || {}) };
  if (e.type === 'hit-pause' && Number.isFinite(params.duration) && hitPauseScale !== 1) {
    params.duration = Math.round(params.duration * hitPauseScale);
  }
  return params;
}
