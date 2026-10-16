/**
 * M64 C9 — Open5e creature → sprite / proxy preset, shared by the forge's
 * monster search (main.js) and the DM's setup screen.
 *
 * Phase 1 fights every searched monster with the closest LPC preset's
 * stats (the Open5e stat-block normaliser is phase 1.5), so the setup UI
 * says so: "fights as: Bandit — AC 12, Scimitar +3".
 *
 * Pure: no DOM.
 */

import { MONSTER_PRESETS } from '../scene/monster-presets.js';

/**
 * Heuristic: given an Open5e creature name/type, pick the closest LPC
 * preset for the visual (and, in phase 1, the stats). Falls back to
 * 'bandit' as a generic humanoid.
 * @param {string} name
 * @param {string} [type]
 * @returns {string} MONSTER_PRESETS slug
 */
export function matchPresetForOpen5e(name, type) {
  const n = String(name || '').toLowerCase();
  const t = String(type || '').toLowerCase();
  for (const slug of Object.keys(MONSTER_PRESETS)) {
    if (n.includes(slug)) return slug;
  }
  if (t.includes('undead') || n.includes('skeleton')) return 'skeleton';
  if (n.includes('zombie') || n.includes('ghoul'))    return 'zombie';
  if (n.includes('vampire'))                          return 'vampire';
  if (n.includes('orc') || n.includes('hobgoblin'))   return 'orc';
  if (n.includes('goblin') || n.includes('kobold'))   return 'goblin';
  if (n.includes('troll') || n.includes('ogre') || n.includes('giant')) return 'troll';
  if (n.includes('minotaur'))                         return 'minotaur';
  if (n.includes('wolf') || n.includes('gnoll'))      return 'gnoll';
  return 'bandit';   // generic humanoid fallback
}

/**
 * The proxy label the DM sees on a search result.
 * @param {string} slug — MONSTER_PRESETS slug
 * @returns {string} e.g. "fights as: Bandit — AC 12, Scimitar +3"
 */
export function fightsAsLabel(slug) {
  const p = MONSTER_PRESETS[slug];
  if (!p) return `fights as: ${slug}`;
  const atk = p.attack ? `, ${p.attack.name} ${p.attack.bonus >= 0 ? '+' : ''}${p.attack.bonus}` : '';
  return `fights as: ${p.name} — AC ${p.ac ?? '?'}${atk}`;
}
