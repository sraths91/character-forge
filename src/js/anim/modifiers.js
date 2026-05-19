/**
 * M43.4 — Combat modifier overlays.
 *
 * A "modifier" is a partial Sequence layered on top of a base weapon
 * motion via the M43.0 `applyModifier` primitive. Each modifier
 * dramatizes a class feature, feat, or condition firing on the same
 * exchange — Sneak Attack, Rage, Great Weapon Master, Divine Smite,
 * Reckless Attack.
 *
 * Each builder is PURE — takes a base sequence (to read its impact
 * timing + meta) and returns a NEW partial Sequence containing only
 * the keyframes / effects to add. Composition is left-to-right:
 *
 *   let seq = buildMotion('sword-slash');
 *   seq = applyModifier(seq, buildModifier('sneak-attack', { base: seq }));
 *   seq = applyModifier(seq, buildModifier('rage',         { base: seq }));
 *
 * Detection lives elsewhere (main.js inspects the attacker's per-turn
 * state to decide which modifiers fired). This module is the pure
 * authoring layer.
 *
 * Modifier inventory:
 *   sneak-attack    — Rogue. Shadowy burst + extra shake on impact.
 *   rage            — Barbarian. Red aura on the attacker; lean-forward
 *                     opening pose.
 *   gwm             — Great Weapon Master. Deeper anticipation, heavier
 *                     hit-pause + amplified shake on impact.
 *   divine-smite    — Paladin. Radiant glyph rises on attacker, flash +
 *                     radiant burst on impact. Slot tier scales the
 *                     glyph size.
 *   reckless-attack — Barbarian. Forward-leaning attacker posture; no
 *                     extra impact effects (the lean is the read).
 */

import { applyModifier as composeOne } from './sequence.js';

const MODIFIER_IDS = ['sneak-attack', 'rage', 'gwm', 'divine-smite', 'reckless-attack'];

/** Registry of modifier builders. Each takes ({ base, opts }) and
 *  returns a partial Sequence to compose with `applyModifier`. */
export const MODIFIERS = {
  'sneak-attack':    { id: 'sneak-attack',    label: 'Sneak Attack',    build: buildSneakAttack },
  'rage':            { id: 'rage',            label: 'Rage',            build: buildRage },
  'gwm':             { id: 'gwm',             label: 'Great Weapon Master', build: buildGwm },
  'divine-smite':    { id: 'divine-smite',    label: 'Divine Smite',    build: buildDivineSmite },
  'reckless-attack': { id: 'reckless-attack', label: 'Reckless Attack', build: buildReckless }
};

/** Is `id` a known modifier id? */
export function isModifier(id) {
  return MODIFIER_IDS.includes(id);
}

/** Build a partial modifier sequence for `id`. Reads `base` to align
 *  its overlay effects with the base sequence's impact moment. */
export function buildModifier(id, { base = null, level = 1, slot = 1 } = {}) {
  const def = MODIFIERS[id];
  if (!def) return null;
  return def.build({ base, level, slot });
}

/** Apply a list of modifiers in order. Each is built from the running
 *  sequence (so effects align with the impact of the composed result).
 *  Returns a NEW Sequence; input is never mutated. */
export function applyModifiers(base, modifierIds = [], opts = {}) {
  if (!base) return base;
  let out = base;
  for (const id of modifierIds) {
    if (!isModifier(id)) continue;
    const patch = buildModifier(id, { base: out, ...opts });
    if (patch) out = composeOne(out, patch);
  }
  return out;
}

/* =====================================================================
 * Internal helpers
 * ===================================================================== */

/** Find the impact moment in ms — the time of the sequence's hit-pause. */
function impactTimeOf(seq) {
  if (!seq?.effects) return Math.floor((seq?.duration || 1000) / 2);
  const ev = seq.effects.find(e => e.type === 'hit-pause');
  return ev ? ev.at : Math.floor((seq.duration || 1000) / 2);
}

function emptyPatch(id) {
  return { id, duration: 0, keyframes: [], effects: [], meta: {} };
}

/* =====================================================================
 * Modifier builders
 * ===================================================================== */

/**
 * Sneak Attack — Rogue.
 * Shadowy burst centred on the defender at impact, dark necrotic-coloured.
 * Extra shake to read the extra damage. No keyframes — the rogue's body
 * language is the standard motion; the *damage* is what's exceptional.
 */
function buildSneakAttack({ base, level }) {
  const patch = emptyPatch('mod:sneak-attack');
  const impact = impactTimeOf(base);
  // Dice = ceil(level/2)d6; we scale visuals by dice count.
  const dice = Math.max(1, Math.ceil((level || 1) / 2));
  const radius = 18 + Math.min(6, dice) * 4;
  patch.effects.push(
    { at: impact - 20, type: 'burst', params: { damageType: 'necrotic', radius, _modifier: 'sneak-attack' } },
    { at: impact,       type: 'shake', params: { amplitude: 2 + Math.min(4, dice * 0.5) } },
    // M47 — Shadow motes drift outward from the strike. Count scales
    // with sneak-attack dice — more dice → more visible.
    { at: impact, type: 'particles',
      params: { preset: 'shadowMotes', origin: 'defender',
                count: 8 + Math.min(8, dice * 2),
                _modifier: 'sneak-attack' } }
  );
  patch.duration = impact + 250;
  patch.meta = { modifier: 'sneak-attack', dice };
  return patch;
}

/**
 * Rage — Barbarian.
 * Red aura around the attacker for the duration of the swing. Adds a
 * pre-swing "roar" — attacker squashes down at t=0 and surges forward.
 */
function buildRage({ base }) {
  const patch = emptyPatch('mod:rage');
  const total = Math.max(800, base?.duration || 800);
  // Aura is rendered as a sustained effect — emitted at t=0 with a
  // duration param so the cinema layer can hold it through the swing.
  patch.effects.push({
    at: 0, type: 'aura',
    params: {
      actor: 'attacker', color: '#dc2626',
      duration: total, _modifier: 'rage'
    }
  });
  // M47 — Rising ember stream around the attacker during the wind-up,
  // pulsing on the roar and again at impact. Two emitter bursts give
  // the rage a sustained kinetic feel rather than a static aura.
  const impact = impactTimeOf(base);
  patch.effects.push(
    { at: 60, type: 'particles',
      params: { preset: 'rageEmbers', origin: 'attacker', count: 14,
                _modifier: 'rage' } },
    { at: Math.max(0, impact - 50), type: 'particles',
      params: { preset: 'rageEmbers', origin: 'attacker', count: 10,
                _modifier: 'rage' } }
  );
  // "Roar" — attacker compresses then expands (squash & stretch).
  patch.keyframes.push(
    { at: 0,   actor: 'attacker', scale: 1.06, y: 2, easing: 'easeOut' },
    { at: 120, actor: 'attacker', scale: 1.0,  y: 0, easing: 'easeIn' }
  );
  patch.duration = total;
  patch.meta = { modifier: 'rage' };
  return patch;
}

/**
 * Great Weapon Master.
 * Deeper anticipation (extra wind-up rotation), longer hit-pause, and
 * a much heavier shake at impact. Used when the -5/+10 tradeoff fires.
 */
function buildGwm({ base }) {
  const patch = emptyPatch('mod:gwm');
  const impact = impactTimeOf(base);
  // Extra hit-pause (additive) and a bigger shake. The base motion's
  // hit-pause already paused the timeline; adding a second hit-pause
  // event further extends it via the engine.
  patch.effects.push(
    { at: impact,       type: 'hit-pause', params: { duration: 120, _modifier: 'gwm' } },
    { at: impact,       type: 'shake',     params: { amplitude: 5 } },
    { at: impact + 30,  type: 'flash',     params: { intensity: 0.25 } }
  );
  // Deeper wind-up pose — attacker pulls back further and tilts more.
  patch.keyframes.push(
    { at: Math.max(0, impact - 300), actor: 'attacker',
      x: -10, rotation: -0.4, easing: 'anticipate' }
  );
  patch.duration = impact + 250;
  patch.meta = { modifier: 'gwm' };
  return patch;
}

/**
 * Divine Smite — Paladin.
 * Radiant glyph rises behind the attacker during the wind-up, flash on
 * impact, radiant burst centred on the defender. `slot` scales the
 * visual weight (a level-5 smite reads bigger than a level-1).
 */
function buildDivineSmite({ base, slot }) {
  const patch = emptyPatch('mod:divine-smite');
  const impact = impactTimeOf(base);
  const tier = Math.max(1, Math.min(5, Number(slot) || 1));
  const intensity = 0.4 + tier * 0.1;       // 0.5..0.9
  const burstRadius = 28 + tier * 6;
  patch.effects.push(
    { at: Math.max(0, impact - 350), type: 'glyph-rise',
      params: { damageType: 'radiant', _modifier: 'divine-smite' } },
    { at: impact - 10, type: 'flash', params: { intensity } },
    { at: impact,      type: 'burst',
      params: { damageType: 'radiant', radius: burstRadius, _modifier: 'divine-smite' } },
    // M47 — Holy sparks scale with slot tier: a 5th-level smite
    // explodes with more visible particles than a 1st-level.
    { at: impact, type: 'particles',
      params: { preset: 'smiteSparks', origin: 'defender',
                count: 14 + tier * 4, _modifier: 'divine-smite' } }
  );
  patch.duration = impact + 300;
  patch.meta = { modifier: 'divine-smite', slot: tier };
  return patch;
}

/**
 * Reckless Attack — Barbarian.
 * The attacker over-commits — extra forward lean during the strike,
 * less recovery from the follow-through. No extra impact effects; the
 * posture is the read.
 */
function buildReckless({ base }) {
  const patch = emptyPatch('mod:reckless-attack');
  const impact = impactTimeOf(base);
  // Push the attacker further forward at the strike moment, and keep
  // them committed for longer before recovering.
  patch.keyframes.push(
    { at: Math.max(0, impact - 50), actor: 'attacker',
      x: 12, rotation: 0.2, easing: 'easeIn' },
    { at: Math.min(base?.duration || impact + 400, impact + 200), actor: 'attacker',
      x: 8, rotation: 0.15, easing: 'linear' }
  );
  patch.duration = (base?.duration || impact + 400);
  patch.meta = { modifier: 'reckless-attack' };
  return patch;
}

/* =====================================================================
 * Detection — read attacker state to decide which modifiers fired
 * ===================================================================== */

/**
 * Inspect an attacker's per-turn state and return the list of modifier
 * ids that should overlay this attack. Wiring layer (main.js) is the
 * canonical caller; tests exercise this directly.
 *
 * Inputs:
 *   pre  — snapshot of the attacker's relevant flags BEFORE the attack
 *   post — same flags AFTER the attack (so we only fire the visual
 *          for features actually consumed by THIS exchange)
 */
export function modifiersForAttack({ pre = {}, post = {}, attacker = {} } = {}) {
  const out = [];
  // Sneak Attack — flipped false → true within this attack
  if (!pre._sneakAttackUsedThisTurn && post._sneakAttackUsedThisTurn) {
    out.push('sneak-attack');
  }
  // Divine Smite — a slot was burned (post._smiteSlotUsed set, pre wasn't,
  // OR the value changed within this exchange)
  if (post._smiteSlotUsed && pre._smiteSlotUsed !== post._smiteSlotUsed) {
    out.push('divine-smite');
  }
  // Reckless Attack — flipped within this attack
  if (!pre._recklessUsedThisTurn && post._recklessUsedThisTurn) {
    out.push('reckless-attack');
  }
  // Rage — a sustained condition; render as long as the attacker is raging
  if (attacker._raging || attacker._rageActive) out.push('rage');
  // GWM — flipped within this attack (caller threads this through if
  // the -5/+10 path fired)
  if (!pre._gwmFiredThisAttack && post._gwmFiredThisAttack) out.push('gwm');
  return out;
}

/** Snapshot the attacker's relevant feature flags. Used by callers to
 *  capture pre/post state around an attack. */
export function snapshotAttackerFlags(pc) {
  if (!pc) return {};
  return {
    _sneakAttackUsedThisTurn: !!pc._sneakAttackUsedThisTurn,
    _recklessUsedThisTurn:    !!pc._recklessUsedThisTurn,
    _smiteSlotUsed:           pc._smiteSlotUsed || null,
    _gwmFiredThisAttack:      !!pc._gwmFiredThisAttack
  };
}
