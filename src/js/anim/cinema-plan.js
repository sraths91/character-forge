/**
 * M64 C5 — event-driven cinema plan.
 *
 * Builds the cinema Sequence for one server `exchange` event (events.js
 * catalogue v1; payload shape from R1 §3.5). Every animation input comes
 * from the event — the chosen weapon (not the attacker's mainhand), the
 * seat's style and resolved swing, the modifiers that actually fired,
 * the smite slot, attacker level, killing blow and fxSeed — so every
 * client (and the server, which needs `seq.duration` for pacing) builds
 * the same Sequence. Nothing here reads localStorage, an entity's
 * underscore flags, the clock or Math.random, and nothing is mutated:
 * the pipeline is the pure transform chain from `.claude/rules/anim.md`
 *
 *   motion → style → swing → modifiers → polish → hit reaction
 *
 * `lookups` supplies static metadata the event refers to by name or id
 * (weapon stats, spell records, an entity's max HP); it never supplies
 * per-attack choices.
 *
 * Imported by both Vite and Node: no DOM, no Node built-ins.
 */

import { buildMotion, motionForWeapon, WEAPON_MOTIONS } from './weapon-motions.js';
import { buildSpellSequence } from './spell-motions.js';
import { applyStyle, isStyle } from './motion-styles.js';
import { applySwing, isSwing } from './swing-types.js';
import { applyModifiers, isModifier } from './modifiers.js';
import { applyPolish } from './polish.js';
import { applyHitReaction } from './hit-reactions.js';

/**
 * @typedef {object} CinemaLookups
 * @property {(name: string, attackerId: string) => (object|null)} [weapon]
 *   — static weapon metadata ({damageType, magical, material}) used to fill
 *     fields the event's `cinema.weapon` leaves out; event fields win.
 * @property {(spellId: string) => (object|null)} [spell]
 *   — registry spell record ({kind, aoe, damageType}) when the event does
 *     not inline `cinema.spell`.
 * @property {(entityId: string) => (object|null)} [entity]
 *   — `{hpMax}` fallback when the event has no HP effect for the defender.
 */

/**
 * @typedef {object} CinemaPlan
 * @property {object|null} seq        — the composed Sequence (null if no motion could be built)
 * @property {string} motionId         — base motion id ('staff-cast' for casts)
 * @property {string} bodyAnim         — LPC body animation for the attacker
 * @property {string|null} swing       — the swing applied, or null
 * @property {{animation: string, hitReaction: string|null}} defenderReaction
 * @property {{victim: 'defender', dmg: number, crit: boolean, heal: number, miss: boolean}} verdict
 *   — the `playRound` verdict for cinema.js
 */

/** Map a cinema motion id to the attacker's LPC body animation (M51 Phase 2). */
export function bodyAnimForMotion(motionId) {
  if (motionId === 'staff-cast') return 'cast';
  if (motionId === 'sword-thrust' || motionId === 'lance-thrust') return 'thrust';
  if (motionId === 'bow-draw') return 'slash';   // no shoot body sheet; slash reads ok
  return 'slash';   // sword-slash / axe-cleave / dagger-stab / fist
}

/** Map a resolved swing to the attacker's LPC body animation (M54 Phase 2). */
export function bodyAnimForSwing(swingId) {
  switch (swingId) {
    case 'thrust':     return 'thrust';
    case 'backslash':  return 'backslash';
    case 'rising':     return 'backslash';   // reverse wind-up reads as a rising cut
    case 'horizontal': return 'halfslash';   // quick, flatter cut
    default:           return 'slash';        // diagonal / overhead / spin
  }
}

/**
 * Motion metadata for a weapon, without building a full plan: the base
 * motion id plus the Sequence's `meta.kind` ('melee' | 'ranged' | …) and
 * `meta.weaponClass`. Callers that resolve a per-attack swing before
 * building the exchange (the forge's 'varied' swing counter) need to know
 * whether the weapon swings at all.
 * @param {object|null} weapon
 * @returns {{motionId: string, kind: string|null, weaponClass: string|null}}
 */
export function motionMetaForWeapon(weapon) {
  const motionId = motionForWeapon(weapon);
  const meta = buildMotion(motionId)?.meta || {};
  return { motionId, kind: meta.kind ?? null, weaponClass: meta.weaponClass ?? null };
}

function payloadOf(exchangeEvent) {
  if (exchangeEvent && exchangeEvent.type === 'exchange' && exchangeEvent.payload) return exchangeEvent.payload;
  return exchangeEvent || {};
}

function resolveWeapon(raw, attackerId, lookups) {
  if (raw == null) return null;
  const name = typeof raw === 'string' ? raw : raw.name;
  const meta = (name && typeof lookups.weapon === 'function') ? lookups.weapon(name, attackerId) : null;
  const own = typeof raw === 'string' ? { name: raw } : raw;
  return { ...(meta || {}), ...own };
}

function resolveSpell(cinema, lookups) {
  if (cinema.spell && typeof cinema.spell === 'object') return cinema.spell;
  if (cinema.spellId && typeof lookups.spell === 'function') return lookups.spell(cinema.spellId) || {};
  return {};
}

function defenderEffect(p) {
  if (!p.defenderId || !Array.isArray(p.effects)) return null;
  return p.effects.find(e => e && e.entityId === p.defenderId) || null;
}

function modifierIdsOf(cinema, p) {
  const list = Array.isArray(cinema.modifiers) ? cinema.modifiers
    : Array.isArray(cinema.featuresFired) ? cinema.featuresFired
      : Array.isArray(p.featuresFired) ? p.featuresFired
        : [];
  return list.filter(isModifier);
}

/**
 * Build the cinema Sequence for one `exchange` event. Pure: the event and
 * `lookups` are never mutated, and equal inputs give deep-equal output.
 *
 * @param {object} exchangeEvent — an `exchange` event `{seq, type, …, payload}` or its bare payload
 * @param {CinemaLookups} [lookups]
 * @returns {CinemaPlan}
 */
export function buildCinemaSequence(exchangeEvent, lookups = {}) {
  const p = payloadOf(exchangeEvent);
  const cinema = p.cinema || {};
  const isCast = !!p.cast;
  const reaction = !!p.reaction;
  const outcome = (isCast && cinema.outcome) || {};
  const spell = isCast ? resolveSpell(cinema, lookups) : null;
  const weapon = isCast ? null : resolveWeapon(cinema.weapon, p.attackerId, lookups);

  // The motion follows the CHOSEN weapon in the event; `cinema.motionId`
  // is only a fallback when no weapon is named.
  let motionId;
  if (isCast) motionId = 'staff-cast';
  else if (weapon) motionId = motionForWeapon(weapon);
  else if (cinema.motionId && WEAPON_MOTIONS[cinema.motionId]) motionId = cinema.motionId;
  else motionId = motionForWeapon(null);

  const dmg = isCast
    ? ((outcome.dmg ?? p.damage?.total ?? 0) | 0)
    : ((p.damage?.total ?? 0) | 0);
  const crit = isCast ? !!outcome.crit : !!p.roll?.crit;
  const miss = isCast
    ? !!outcome.miss
    : (p.roll && typeof p.roll.hit === 'boolean' ? !p.roll.hit : !dmg);
  const verdict = {
    victim: 'defender',
    dmg: Math.max(0, dmg),
    crit,
    heal: Math.max(0, outcome.heal | 0),
    miss
  };

  let seq = isCast
    ? buildSpellSequence({ spell, cinemaKind: cinema.cinemaKind || null, outcome })
    : buildMotion(motionId);
  if (!seq) {
    return {
      seq: null, motionId, bodyAnim: bodyAnimForMotion(motionId), swing: null,
      defenderReaction: { animation: 'hurt', hitReaction: null }, verdict
    };
  }

  // Style — opportunity attacks are single snapped strikes (M56 Phase 4).
  seq = applyStyle(seq, reaction ? 'quick' : (isStyle(cinema.style) ? cinema.style : 'standard'));

  // Swing — melee weapon attacks only; the server resolves 'varied'.
  let swing = null;
  if (!isCast && !reaction && seq.meta?.kind === 'melee' && isSwing(cinema.swing)) {
    swing = cinema.swing;
    seq = applySwing(seq, swing);
  }

  const attackerLevel = Number.isInteger(cinema.attackerLevel) && cinema.attackerLevel > 0
    ? cinema.attackerLevel : 1;

  // Modifiers — the ids the server says fired on THIS exchange (no flag
  // diffing). Casts and reactions skip the weapon-swing dressing.
  if (!isCast && !reaction) {
    const fired = modifierIdsOf(cinema, p);
    if (fired.length) {
      seq = applyModifiers(seq, fired, { level: attackerLevel, slot: cinema.smiteSlot || 1 });
    }
  }

  // Polish + per-damage-type reaction; friendly sequences (heals) skip both.
  const eff = defenderEffect(p);
  const killing = typeof cinema.killing === 'boolean'
    ? cinema.killing
    : !!(eff && eff.hp && eff.hp.before > 0 && eff.hp.after === 0);
  if (!seq.meta?.friendly) {
    const lookedUp = (p.defenderId && typeof lookups.entity === 'function') ? lookups.entity(p.defenderId) : null;
    const defenderMax = eff?.hp?.max ?? lookedUp?.hpMax ?? ((eff?.hp?.before ?? 0) + dmg);
    const damageType = isCast ? (spell?.damageType || null) : (weapon?.damageType || null);
    seq = applyPolish(seq, {
      level: attackerLevel,
      crit,
      dmg,
      defenderHp: defenderMax,
      magical: isCast ? false : !!weapon?.magical,
      material: isCast ? null : (weapon?.material || null),
      damageType,
      killing
    });
    if (!miss && dmg > 0) seq = applyHitReaction(seq, { damageType });
  }

  seq = {
    ...seq,
    meta: {
      ...(seq.meta || {}),
      exchangeId: p.exchangeId ?? null,
      fxSeed: Number.isInteger(cinema.fxSeed) ? cinema.fxSeed : 0
    }
  };

  return {
    seq,
    motionId,
    bodyAnim: swing ? bodyAnimForSwing(swing) : bodyAnimForMotion(motionId),
    swing,
    defenderReaction: { animation: 'hurt', hitReaction: seq.meta.hitReaction || null },
    verdict
  };
}
