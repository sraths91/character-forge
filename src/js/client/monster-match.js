/**
 * M64 C9 — Open5e creature → sprite / proxy preset, shared by the forge's
 * monster search (main.js) and the DM's setup screen.
 *
 * The preset is always the sprite. Phase 1.5 (E3 wave 6): when the server
 * normalised the creature's real SRD stat block, the `dm.encounter.setup`
 * ack lists it (`monsters[{id, source: 'srd-2014', ac, hpMax, attacks}]`)
 * and the setup UI says "SRD stat block: AC 18, Bite +10 …"; only a
 * monster without one says "fights as: Bandit — AC 12, Scimitar +3".
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

/** The stat-block source the server marks a normalised SRD block with. */
export const SRD_SOURCE = 'srd-2014';
const ATTACKS_SHOWN = 2;

const signed = (n) => `${n >= 0 ? '+' : ''}${n}`;

/**
 * The setup line for one monster: its SRD stat block when the server
 * normalised one, else the preset proxy (`fightsAsLabel`).
 * @param {{source?: string|null, ac?: number, hpMax?: number, attacks?: {name: string, bonus?: number}[]}|null|undefined} info
 *   — a `dm.encounter.setup` ack entry (or `statBlockInfo(entity)`)
 * @param {string} slug — MONSTER_PRESETS slug (the fallback)
 * @returns {string} e.g. "SRD stat block: AC 18, Bite +10, Claw +10 … · 178 hp"
 */
export function statBlockLabel(info, slug) {
  if (!info || info.source !== SRD_SOURCE) return fightsAsLabel(slug);
  const attacks = (Array.isArray(info.attacks) ? info.attacks : []).filter(a => a && a.name);
  const parts = [`AC ${Number.isInteger(info.ac) ? info.ac : '?'}`];
  for (const a of attacks.slice(0, ATTACKS_SHOWN)) parts.push(Number.isFinite(a.bonus) ? `${a.name} ${signed(a.bonus)}` : a.name);
  const more = attacks.length > ATTACKS_SHOWN ? ' …' : '';
  const hp = Number.isInteger(info.hpMax) && info.hpMax > 0 ? ` · ${info.hpMax} hp` : '';
  return `SRD stat block: ${parts.join(', ')}${more}${hp}`;
}

/**
 * The ack-shaped stat-block summary of an EncounterState monster (the
 * DM's view carries the stat block), for monsters the ack did not list
 * (added after setup, or a reload).
 * @param {object|null|undefined} e — EncounterState entity
 * @returns {{source: string|null, ac: number|null, hpMax: number|null, attacks: {name: string, bonus?: number, dice?: string}[]}|null}
 */
export function statBlockInfo(e) {
  if (!e || e.kind !== 'monster') return null;
  const sb = e.statBlock || {};
  return {
    source: sb.source ?? null,
    ac: Number.isInteger(e.ac) ? e.ac : null,
    hpMax: Number.isInteger(e.hpMax) ? e.hpMax : null,
    attacks: (Array.isArray(sb.attacks) ? sb.attacks : []).map(a => ({ name: a.name, bonus: a.bonus, dice: a.dice }))
  };
}

/**
 * Index a `dm.encounter.setup` ack's `monsters[]` by entity id.
 * @param {{monsters?: object[]}|null|undefined} ack
 * @returns {Record<string, object>}
 */
export function setupAckMonsters(ack) {
  const out = {};
  for (const m of Array.isArray(ack?.monsters) ? ack.monsters : []) if (m && typeof m.id === 'string') out[m.id] = m;
  return out;
}
