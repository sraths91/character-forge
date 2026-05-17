/**
 * M32 — Monster AI profiles.
 *
 * Each profile is a declarative description of how a creature *prefers* to
 * fight, expressed as weighted considerations. The engine (profile.js)
 * loads the profile by monster slug and scores candidate targets; the
 * profile alone produces no decisions — it's pure data.
 *
 * M32.0 ships 5 starter archetypes that span the behavioral spread:
 *   goblin          — nimble_skirmisher (coward, prefers wounded targets)
 *   orc             — aggressive_charger (no retreat, closes fastest)
 *   kobold          — coward_pack (pack-tactic-dependent, flees easily)
 *   vampire-spawn   — predator (hunts casters + bloodied, regen flee)
 *   bandit          — opportunist (picks easy fights, flees at 50%)
 *
 * Per-consideration entry shapes:
 *   { weight: number, curve: 'linear'|'step'|'quadratic'|'inverse' }
 *   - Positive weight → "I want targets that score high on this signal."
 *   - Negative weight → "I avoid targets that score high on this signal."
 *
 * Profile-level fields:
 *   archetype          — human-readable label for the roll log
 *   retreat_below_hp   — fraction of max HP at which the monster flees
 *                        (set to 0 for "never flees")
 *   metagame_blind     — informational; lists facts the AI shouldn't peek
 *                        at (we honor by simply not exposing them in ctx)
 *   signature_triggers — reserved for M32.1+ (currently informational)
 */

export const MONSTER_PROFILES = {
  goblin: {
    archetype: 'nimble_skirmisher',
    considerations: {
      target_low_hp:      { weight: 0.8, curve: 'linear' },
      distance_to_target: { weight: 0.4, curve: 'linear' },
      pack_tactics_active:{ weight: 0.3, curve: 'step' },
      self_isolated:      { weight: -0.6, curve: 'step' }
    },
    retreat_below_hp: 0.4,
    metagame_blind: ['exact_hp', 'remaining_spell_slots'],
    signature_triggers: [
      { when: 'self_isolated', prefer: 'flee' }
    ]
  },

  orc: {
    archetype: 'aggressive_charger',
    considerations: {
      distance_to_target: { weight: 0.9, curve: 'linear' },
      target_low_hp:      { weight: 0.3, curve: 'linear' },
      target_low_ac:      { weight: 0.2, curve: 'linear' }
    },
    retreat_below_hp: 0,   // never retreats
    metagame_blind: ['exact_hp'],
    signature_triggers: [
      { when: 'always', prefer: 'attack' }
    ]
  },

  kobold: {
    archetype: 'coward_pack',
    considerations: {
      pack_tactics_active: { weight: 1.2, curve: 'step' },
      self_isolated:       { weight: -1.4, curve: 'step' },
      target_low_hp:       { weight: 0.5, curve: 'linear' },
      distance_to_target:  { weight: 0.3, curve: 'linear' }
    },
    retreat_below_hp: 0.6,
    metagame_blind: ['exact_hp', 'remaining_spell_slots'],
    signature_triggers: [
      { when: 'self_isolated', prefer: 'flee' }
    ]
  },

  'vampire-spawn': {
    archetype: 'predator',
    considerations: {
      target_is_bloodied: { weight: 0.8, curve: 'step' },
      target_is_caster:   { weight: 0.7, curve: 'step' },
      target_low_hp:      { weight: 0.6, curve: 'linear' },
      distance_to_target: { weight: 0.2, curve: 'linear' }
    },
    retreat_below_hp: 0.3,
    metagame_blind: ['remaining_spell_slots'],
    signature_triggers: [
      { when: 'target_is_caster', prefer: 'attack' }
    ]
  },

  bandit: {
    archetype: 'opportunist',
    considerations: {
      target_low_hp:  { weight: 0.7, curve: 'linear' },
      target_low_ac:  { weight: 0.5, curve: 'linear' },
      self_bloodied:  { weight: -0.3, curve: 'step' }
    },
    retreat_below_hp: 0.5,
    metagame_blind: ['exact_hp', 'remaining_spell_slots'],
    signature_triggers: [
      { when: 'self_bloodied', prefer: 'flee' }
    ]
  },

  // M32.1 — remaining preset roster

  hobgoblin: {
    archetype: 'tactical_focuser',
    considerations: {
      target_low_hp:       { weight: 0.7, curve: 'linear' },
      pack_tactics_active: { weight: 0.8, curve: 'step' },
      target_is_caster:    { weight: 0.4, curve: 'step' },
      distance_to_target:  { weight: 0.3, curve: 'linear' }
    },
    retreat_below_hp: 0.2,   // disciplined; only retreats at the brink
    metagame_blind: ['exact_hp'],
    signature_triggers: [
      { when: 'ally_adjacent_to_target', prefer: 'attack' }
    ]
  },

  bugbear: {
    archetype: 'ambusher',
    considerations: {
      target_low_hp:       { weight: 0.5, curve: 'linear' },
      target_low_ac:       { weight: 0.4, curve: 'linear' },
      target_is_caster:    { weight: 0.5, curve: 'step' },
      distance_to_target:  { weight: 0.4, curve: 'linear' }
    },
    retreat_below_hp: 0.25,
    metagame_blind: ['exact_hp'],
    signature_triggers: [
      { when: 'target_isolated', prefer: 'attack' }
    ]
  },

  skeleton: {
    archetype: 'mindless_attacker',
    considerations: {
      distance_to_target: { weight: 0.9, curve: 'linear' }
    },
    retreat_below_hp: 0,
    metagame_blind: [],
    signature_triggers: []
  },

  zombie: {
    archetype: 'braindead_grappler',
    considerations: {
      distance_to_target: { weight: 1.0, curve: 'linear' }
    },
    retreat_below_hp: 0,
    metagame_blind: [],
    signature_triggers: []
  },

  troll: {
    archetype: 'regen_brute',
    considerations: {
      target_low_hp:      { weight: 0.4, curve: 'linear' },
      distance_to_target: { weight: 0.8, curve: 'linear' }
    },
    retreat_below_hp: 0,     // regen handles the rest
    metagame_blind: [],
    signature_triggers: []
  },

  minotaur: {
    archetype: 'charger',
    considerations: {
      distance_to_target: { weight: 1.0, curve: 'linear' },   // farther → less score, so prefers chargeable distance
      target_low_hp:      { weight: 0.2, curve: 'linear' }
    },
    retreat_below_hp: 0,
    metagame_blind: [],
    signature_triggers: [
      { when: 'distance_gte_2cells', prefer: 'charge' }
    ]
  },

  cultist: {
    archetype: 'zealot',
    considerations: {
      pack_tactics_active: { weight: 0.7, curve: 'step' },
      has_adjacent_ally:   { weight: 0.5, curve: 'step' },
      distance_to_target:  { weight: 0.3, curve: 'linear' }
    },
    castWeights: { 'sacred-flame': 0.7 },   // M34 — cantrip preference
    retreat_below_hp: 0,     // dies for the cause
    metagame_blind: [],
    signature_triggers: []
  },

  gnoll: {
    archetype: 'pack_hunter',
    considerations: {
      target_low_hp:       { weight: 1.0, curve: 'linear' },  // Rampage: love finishing kills
      pack_tactics_active: { weight: 0.5, curve: 'step' },
      has_adjacent_ally:   { weight: 0.4, curve: 'step' },
      distance_to_target:  { weight: 0.2, curve: 'linear' }
    },
    retreat_below_hp: 0.15,  // breaks only at the very end
    metagame_blind: ['exact_hp'],
    signature_triggers: [
      { when: 'target_bloodied', prefer: 'attack' }
    ]
  },

  ratfolk: {
    archetype: 'swarm_skirmisher',
    considerations: {
      pack_tactics_active: { weight: 0.9, curve: 'step' },
      target_low_hp:       { weight: 0.5, curve: 'linear' },
      self_isolated:       { weight: -1.0, curve: 'step' },
      distance_to_target:  { weight: 0.3, curve: 'linear' }
    },
    retreat_below_hp: 0.5,
    metagame_blind: ['exact_hp'],
    signature_triggers: [
      { when: 'self_isolated', prefer: 'flee' }
    ]
  },

  // M34 — Spellcaster archetypes. `castWeights` map spell ids to their
  // utility multiplier (added to the per-target score, then compared to
  // the melee score). Higher means more eager to cast it.
  'cult-fanatic': {
    archetype: 'control_caster',
    considerations: {
      target_low_hp:      { weight: 0.6, curve: 'linear' },
      target_is_caster:   { weight: 0.5, curve: 'step' },
      distance_to_target: { weight: 0.2, curve: 'linear' }
    },
    castWeights: {
      'hold-person':      1.2,   // save-or-suck on a target that ISN'T already locked
      'spiritual-weapon': 0.9,
      'inflict-wounds':   0.6,
      'sacred-flame':     0.4
    },
    retreat_below_hp: 0.2,
    metagame_blind: [],
    signature_triggers: []
  },
  'kobold-sorcerer': {
    archetype: 'glass_blaster',
    considerations: {
      target_low_hp:      { weight: 0.7, curve: 'linear' },
      self_isolated:      { weight: -1.0, curve: 'step' },
      distance_to_target: { weight: 0.4, curve: 'linear' }
    },
    castWeights: {
      'magic-missile': 1.1,      // autohit, premium pick
      'fire-bolt':     0.7
    },
    retreat_below_hp: 0.5,
    metagame_blind: ['exact_hp'],
    signature_triggers: [
      { when: 'self_isolated', prefer: 'flee' }
    ]
  }
};


/**
 * Default profile for any monster slug we haven't authored yet. Picks
 * the nearest, weakest target; never retreats. Effectively the pre-M32
 * behavior — safe fallback while we build out the catalog.
 */
export const DEFAULT_PROFILE = {
  archetype: 'default_brute',
  considerations: {
    distance_to_target: { weight: 0.6, curve: 'linear' },
    target_low_hp:      { weight: 0.4, curve: 'linear' }
  },
  retreat_below_hp: 0,
  metagame_blind: [],
  signature_triggers: []
};

/** Lookup by preset slug; returns DEFAULT_PROFILE if unknown. */
export function profileFor(slug) {
  if (!slug) return DEFAULT_PROFILE;
  return MONSTER_PROFILES[slug] || DEFAULT_PROFILE;
}
