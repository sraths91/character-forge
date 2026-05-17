/**
 * M34 — Monster spell library + per-monster spellcasting blocks.
 *
 * Each spell is described with just enough metadata for the resolver to
 * run it through one of three paths:
 *
 *   kind: 'cantrip-save'   → resolveSpellSave (M21 path)
 *   kind: 'leveled-save'   → resolveSpellSave + consumes a slot
 *   kind: 'spell-attack'   → spell attack roll (uses caster's spell-attack bonus)
 *   kind: 'auto-hit'       → no roll, applies damage to N targets
 *
 * Per-monster `MONSTER_SPELLCASTING[slug]` describes:
 *   ability       — spellcasting ability mod ('CHA' | 'WIS' | 'INT')
 *   dc            — spell save DC (5e: 8 + prof + ability mod, pre-baked)
 *   attackBonus   — spell attack bonus (5e: prof + ability mod, pre-baked)
 *   slots         — { 1: 4, 2: 3, ... } pool replenished at long-rest only
 *   spells        — array of spell IDs the monster knows
 *
 * Pure module — no side effects, no DOM.
 */

export const MONSTER_SPELLS = {
  'sacred-flame': {
    id: 'sacred-flame', name: 'Sacred Flame',
    kind: 'cantrip-save',
    level: 0,
    range: 60,
    saveStat: 'DEX',
    saveOnHalf: false,
    dice: '1d8',
    damageType: 'Radiant',
    description: 'Target makes a DEX save. Fail = 1d8 radiant. No half on save.',
    pageRef: 'PHB p272'
  },
  'inflict-wounds': {
    id: 'inflict-wounds', name: 'Inflict Wounds',
    kind: 'spell-attack',
    level: 1,
    range: 5,        // melee spell attack
    dice: '3d10',
    damageType: 'Necrotic',
    description: 'Melee spell attack. On hit: 3d10 necrotic damage.',
    pageRef: 'PHB p251'
  },
  'hold-person': {
    id: 'hold-person', name: 'Hold Person',
    kind: 'leveled-save',
    level: 2,
    range: 60,
    saveStat: 'WIS',
    saveOnHalf: false,
    dice: null,      // pure control
    appliesCondition: 'paralyzed',
    concentration: true,
    duration: 'concentration-1m',
    description: 'Target makes a WIS save or is paralyzed. Save at end of each of its turns to break.',
    pageRef: 'PHB p251'
  },
  'spiritual-weapon': {
    id: 'spiritual-weapon', name: 'Spiritual Weapon',
    kind: 'spell-attack',
    level: 2,
    range: 60,
    dice: '1d8+3',
    damageType: 'Force',
    recurring: 'bonus-action',
    description: 'Bonus action: spell attack vs nearest hostile. Recurring each turn for 1 minute.',
    pageRef: 'PHB p278'
  },
  'fire-bolt': {
    id: 'fire-bolt', name: 'Fire Bolt',
    kind: 'spell-attack',
    level: 0,
    range: 120,
    dice: '1d10',
    damageType: 'Fire',
    description: 'Ranged spell attack. On hit: 1d10 fire.',
    pageRef: 'PHB p242'
  },
  'magic-missile': {
    id: 'magic-missile', name: 'Magic Missile',
    kind: 'auto-hit',
    level: 1,
    range: 120,
    darts: 3,
    perDart: '1d4+1',
    damageType: 'Force',
    description: '3 darts each dealing 1d4+1 force, no attack roll. Distribute among visible targets.',
    pageRef: 'PHB p257'
  },
  // M34.1 — Counterspell (PHB p228). Reaction. Triggers on seeing a
  // creature within 60ft cast a spell. Same-or-lower level auto-counters;
  // higher requires a spellcasting-ability check DC 10 + spell level.
  counterspell: {
    id: 'counterspell', name: 'Counterspell',
    kind: 'reactive-counter',
    level: 3,
    range: 60,
    description: 'Reaction: counter another creature\'s spell. Auto-counters lvl ≤ 3; otherwise an ability check vs DC 10 + spell level.',
    pageRef: 'PHB p228'
  }
};

/** Per-monster spellcasting block. Slugs match MONSTER_PRESETS. */
export const MONSTER_SPELLCASTING = {
  cultist: {
    ability: 'WIS', dc: 11, attackBonus: 3,
    slots: {},   // cantrips only
    spells: ['sacred-flame']
  },
  'cult-fanatic': {
    ability: 'WIS', dc: 11, attackBonus: 3,
    slots: { 1: 4, 2: 3 },
    spells: ['sacred-flame', 'inflict-wounds', 'hold-person', 'spiritual-weapon']
  },
  'kobold-sorcerer': {
    ability: 'CHA', dc: 11, attackBonus: 3,
    slots: { 1: 4, 2: 2 },
    spells: ['fire-bolt', 'magic-missile', 'shield']
  }
};

/** Pure helpers. */

export function isSpellcaster(slug) { return !!MONSTER_SPELLCASTING[slug]; }
export function spellbookFor(slug)  { return MONSTER_SPELLCASTING[slug] || null; }
export function spellById(id)       { return MONSTER_SPELLS[id] || null; }

/** Cantrips don't consume slots; otherwise check pool. */
export function canCastSpell(spell, slotPool) {
  if (!spell) return false;
  if (spell.level === 0) return true;
  return (slotPool?.[spell.level] || 0) > 0;
}

/**
 * Initialize a fresh slot pool from the spellcasting block. Returned
 * object is the *mutable* pool the simulator decrements as the monster
 * casts. Caller is responsible for storing on the entity wrapper.
 */
export function freshSlots(slug) {
  const book = MONSTER_SPELLCASTING[slug];
  if (!book) return {};
  return { ...(book.slots || {}) };
}

/** Burn one slot. No-op for cantrips. */
export function consumeSlot(slotPool, spell) {
  if (!spell || spell.level === 0) return;
  if (slotPool[spell.level] > 0) slotPool[spell.level] -= 1;
}
