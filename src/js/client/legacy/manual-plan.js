/**
 * M64 C3 — Manual-play plan builders (pure, Node-safe).
 *
 * LEGACY (M65 T24): remove with ?classic=1 after one release. Its only
 * importer is client/legacy/classic-versus.js; the server builds a player's
 * forcePlan with `planFromIntent` (scene/intent-validation.js) instead.
 *
 * Extracted from main.js (M45 Phase 4b.3 / 4b.4 runManualWeaponAttack /
 * runManualCast). A manual pick — "this attacker swings this weapon at
 * that target" or "cast this spell on that target" — becomes a
 * synthetic engine plan that live-bridge.runTurn passes as
 * `prompts.forcePlan`, so the engine skips AI planning and resolves the
 * player's choice.
 */

import { nameToSpellId } from '../../scene/ai/pc-action.js';
import { spellById } from '../../scene/monster-spells.js';

const RANGED_WEAPON_RE = /bow|sling|crossbow|dart|javelin|throwing/;

/**
 * Name-based ranged heuristic: bows, slings, crossbows, darts,
 * javelins and throwing weapons count as ranged; everything else melee.
 * @param {{name?: string}|null} weapon
 * @returns {boolean}
 */
export function isRangedWeapon(weapon) {
  return RANGED_WEAPON_RE.test(String(weapon?.name || '').toLowerCase());
}

/**
 * Build a forced weapon-attack plan. Ranged weapons get kind 'ranged'
 * so the engine's gate logic treats range correctly.
 * @param {{weapon: object|null, targetId: string|number}} args
 * @returns {object} engine plan
 */
export function buildWeaponPlan({ weapon, targetId }) {
  return {
    kind: isRangedWeapon(weapon) ? 'ranged' : 'melee',
    targetId,
    targetSide: 'enemy',
    weapon,
    featuresFired: [],
    archetype: 'manual',
    score: 0,
    breakdown: []
  };
}

/**
 * Build a forced cast plan from a spell record (by `id`, or by name →
 * registry slug). Heals target an ally; everything else an enemy.
 * @param {{spell: {id?: string, name?: string, castAtLevel?: number}|null,
 *          targetId: string|number}} args
 * @returns {object|null} engine plan, or null when the spell has no
 *   registry entry (the caller falls back to the legacy prompt path)
 */
export function buildCastPlan({ spell, targetId }) {
  if (!spell) return null;
  const id = spell.id || nameToSpellId(spell.name);
  if (!id) return null;
  const registrySpell = spellById(id);
  if (!registrySpell) return null;
  const isHeal = registrySpell.kind === 'heal' || registrySpell.targetSide === 'ally';
  return {
    kind: 'cast',
    spellId: id,
    castAtLevel: spell.castAtLevel || registrySpell.level || 0,
    targetId,
    targetSide: isHeal ? 'ally' : 'enemy',
    weapon: null,
    featuresFired: [],
    archetype: 'manual',
    score: 0,
    breakdown: []
  };
}
