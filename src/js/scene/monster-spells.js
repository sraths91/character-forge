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
    upcast: { extraDice: '1d10', scoreBonus: 0.3 },   // +1d10 / slot above 1st
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
    upcast: { extraDarts: 1, scoreBonus: 0.5 },   // +1 dart / slot above 1st
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
  },
  // M34.2 — Healing spells. `targetSide: 'ally'` flips chooseAction's
  // candidate pool from enemies to allies. The heal amount uses the
  // caster's spellcasting ability modifier (read off the spellbook).
  'cure-wounds': {
    id: 'cure-wounds', name: 'Cure Wounds',
    kind: 'heal',
    targetSide: 'ally',
    level: 1,
    range: 5,                // touch
    dice: '1d8',             // + spellcasting ability mod
    addsAbilityMod: true,
    upcast: { extraDice: '1d8', scoreBonus: 0.4 },   // +1d8 / slot above 1st
    description: 'Touch ally heals for 1d8 + spellcasting mod.',
    pageRef: 'PHB p230'
  },
  'healing-word': {
    id: 'healing-word', name: 'Healing Word',
    kind: 'heal',
    targetSide: 'ally',
    level: 1,
    range: 60,
    dice: '1d4',
    addsAbilityMod: true,
    bonusAction: true,
    upcast: { extraDice: '1d4', scoreBonus: 0.3 },   // +1d4 / slot above 1st
    description: 'Ranged bonus action: ally heals for 1d4 + spellcasting mod.',
    pageRef: 'PHB p250'
  },

  // M37 — Innate-cast spells. These bypass spell slots; their resource
  // model lives in MONSTER_INNATE (at-will / per-day / recharge).
  'charm-gaze': {
    id: 'charm-gaze', name: 'Charm Gaze',
    kind: 'cantrip-save',
    level: 0,
    range: 30,
    saveStat: 'WIS',
    saveOnHalf: false,
    dice: null,
    appliesCondition: 'charmed',
    description: 'Target makes a WIS save or is charmed for 1 round.',
    pageRef: 'MM Vampire Spawn'
  },
  'fire-breath': {
    id: 'fire-breath', name: 'Fire Breath',
    kind: 'leveled-save',
    level: 0,            // innate — no slot cost, but tagged level for counterspell math
    range: 15,           // 15ft cone (simplified to "all hostiles within 15ft")
    saveStat: 'DEX',
    saveOnHalf: true,
    dice: '5d6',
    damageType: 'Fire',
    aoe: true,
    description: '15ft cone — 5d6 fire, DEX half. Recharge 5-6.',
    pageRef: 'MM Young Red Dragon'
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
    ability: 'WIS', dc: 11, attackBonus: 3, abilityMod: 2,
    slots: { 1: 4, 2: 3 },
    spells: ['sacred-flame', 'inflict-wounds', 'hold-person', 'spiritual-weapon', 'cure-wounds']
  },
  'kobold-sorcerer': {
    ability: 'CHA', dc: 11, attackBonus: 3,
    slots: { 1: 4, 2: 2 },
    spells: ['fire-bolt', 'magic-missile', 'shield']
  }
};

/**
 * M37 — Innate (non-slot) spellcasting blocks. Three resource models:
 *   atWill   — array of spell ids the monster can cast every turn
 *   perDay   — { N: [...spell ids] } — N uses across the encounter
 *   recharge — { spellId: threshold } — roll d6 at start of turn;
 *              if >= threshold, the spell recharges.
 */
export const MONSTER_INNATE = {
  'vampire-spawn': {
    ability: 'CHA', dc: 12,
    atWill: ['charm-gaze']
  },
  'young-dragon': {
    ability: 'CHA', dc: 14,
    recharge: { 'fire-breath': 5 }   // recharge on 5-6
  }
};

/** Pure helpers. */

export function isSpellcaster(slug) { return !!MONSTER_SPELLCASTING[slug]; }
export function spellbookFor(slug)  { return MONSTER_SPELLCASTING[slug] || null; }
export function spellById(id)       { return MONSTER_SPELLS[id] || null; }
export function isInnateCaster(slug) { return !!MONSTER_INNATE[slug]; }
export function innateBlockFor(slug) { return MONSTER_INNATE[slug] || null; }

/**
 * Seed the recharge state for an innate caster. Returns a map
 * { spellId: true } where `true` = available, `false` = waiting.
 * All recharge spells start available (a fresh fight gets a free use).
 */
export function freshInnateState(slug) {
  const block = MONSTER_INNATE[slug];
  if (!block) return null;
  const state = { atWill: [...(block.atWill || [])], recharges: {}, perDay: {} };
  for (const id of Object.keys(block.recharge || {})) state.recharges[id] = true;
  for (const uses of Object.keys(block.perDay || {})) {
    state.perDay[uses] = block.perDay[uses].map(id => ({ id, remaining: Number(uses) }));
  }
  return state;
}

/**
 * Try to roll the recharge for every cooling-down innate. Called at
 * the start of the monster's turn. Returns the list of recharged spell
 * ids so the caller can surface them in the roll log.
 */
export function rollInnateRecharges(self, rng = Math.random) {
  const block = innateBlockFor(self?.presetSlug);
  const state = self?._innate;
  if (!block || !state || !block.recharge) return [];
  const restored = [];
  for (const [id, threshold] of Object.entries(block.recharge)) {
    if (state.recharges[id]) continue;     // already available
    const d6 = Math.floor(rng() * 6) + 1;
    if (d6 >= threshold) {
      state.recharges[id] = true;
      restored.push(id);
    }
  }
  return restored;
}

/**
 * Can this monster cast `spell` via innate means right now? Checks
 * at-will list, recharge availability, and per-day uses left.
 */
export function canInnateCast(self, spellId) {
  const state = self?._innate;
  if (!state) return false;
  if (state.atWill?.includes(spellId)) return true;
  if (state.recharges?.[spellId] === true) return true;
  for (const tier of Object.values(state.perDay || {})) {
    for (const slot of tier) {
      if (slot.id === spellId && slot.remaining > 0) return true;
    }
  }
  return false;
}

/** Consume one use. At-wills are free; recharge/perDay decrement. */
export function consumeInnate(self, spellId) {
  const state = self?._innate;
  if (!state) return;
  if (state.recharges?.[spellId] === true) {
    state.recharges[spellId] = false;
    return;
  }
  for (const tier of Object.values(state.perDay || {})) {
    for (const slot of tier) {
      if (slot.id === spellId && slot.remaining > 0) {
        slot.remaining -= 1;
        return;
      }
    }
  }
  // At-will: no-op
}

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

/** Burn one slot. No-op for cantrips. `castAtLevel` lets the caller
 *  spend a higher slot (M40 upcasting); defaults to the spell's base. */
export function consumeSlot(slotPool, spell, castAtLevel = null) {
  if (!spell || spell.level === 0) return;
  const lvl = Math.max(spell.level, castAtLevel || spell.level);
  if (slotPool[lvl] > 0) slotPool[lvl] -= 1;
}

// =====================================================================
// M40 — Spell upcasting
//
// Many spells get stronger when cast with a slot above their base
// level. The `upcast` field on each spell declares what scales:
//   extraDice:   string  — appended to the dice expression per slot
//                          above base (e.g. Cure Wounds adds 1d8/slot)
//   extraDarts:  number  — Magic Missile-shaped (1 more dart per slot)
//   scoreBonus:  number  — AI weight bump per slot above base
//
// `applyUpcast(spell, castAtLevel)` returns a *new* spell-shaped object
// with the scaled dice/darts so the resolver can use it unchanged. The
// original definition is never mutated.
// =====================================================================

export function applyUpcast(spell, castAtLevel) {
  if (!spell) return spell;
  const baseLevel = spell.level || 0;
  const target = Math.max(baseLevel, castAtLevel || baseLevel);
  const above = target - baseLevel;
  if (above <= 0 || !spell.upcast) return spell;
  const next = { ...spell, castAtLevel: target };
  if (spell.upcast.extraDice && spell.dice) {
    next.dice = mergeDicePool(spell.dice, spell.upcast.extraDice, above);
  }
  if (spell.upcast.extraDarts && spell.darts) {
    next.darts = spell.darts + spell.upcast.extraDarts * above;
  }
  return next;
}

/**
 * Combine a base dice expression with N copies of an extra dice spec.
 * Same-denominator pools merge ("1d8" + 2x"1d8" → "3d8"); otherwise the
 * extras are appended with + and the resolver sums them at roll-time.
 */
function mergeDicePool(base, extra, times) {
  if (times <= 0) return base;
  const baseM = String(base).match(/^(\d+)d(\d+)(.*)$/);
  const extraM = String(extra).match(/^(\d+)d(\d+)(.*)$/);
  if (baseM && extraM && baseM[2] === extraM[2] && !baseM[3] && !extraM[3]) {
    const totalCount = Number(baseM[1]) + Number(extraM[1]) * times;
    return `${totalCount}d${baseM[2]}`;
  }
  // Mixed dice or modifier present — concatenate cleanly.
  const repeats = Array(times).fill(extra).join('+');
  return `${base}+${repeats}`;
}
