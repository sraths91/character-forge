/**
 * M42 — Class archetypes for PCs (utility-AI profiles).
 *
 * Same shape as MONSTER_PROFILES in profiles.js: a `considerations` map
 * weighting per-target signals, plus `actionWeights` that bias the
 * action-kind choice (melee vs ranged vs cast vs feature). M65 phase 2:
 * `actionWeights.potion` scales how much a modelled survival gain must be
 * worth before the PC spends its action on a healing potion (pc-action.js
 * considerPotion; 0 = never self-drinks; absent = DEFAULT_POTION_WEIGHT,
 * 1). It is not an option kind, so it never enters the weapon scoring. The class
 * detection looks at pc.classes[0].name; multiclass picks the first.
 *
 * Pure data; behavior emerges from the scorer.
 */

export const PC_PROFILES = {
  fighter: {
    archetype: 'aggressive_attacker',
    considerations: {
      target_low_hp:     { weight: 0.8, curve: 'linear' },
      target_is_caster:  { weight: 0.4, curve: 'step' },
      distance_to_target:{ weight: 0.3, curve: 'linear' }
    },
    actionWeights: {
      melee:  1.0,
      ranged: 0.7,           // prefers melee but will switch if out of reach
      dash:   0.05,
      dodge:  0.05,
      potion: 1.0            // M65: drinks only when it outlasts swinging
    },
    featureWeights: {
      'action-surge': 0.9
    }
  },

  rogue: {
    archetype: 'sneak_attacker',
    considerations: {
      target_low_hp:     { weight: 0.6, curve: 'linear' },
      target_is_caster:  { weight: 0.6, curve: 'step' },
      distance_to_target:{ weight: 0.3, curve: 'linear' }
    },
    actionWeights: {
      melee:    0.9,         // finesse weapon preferred
      ranged:   0.85,        // also valid for Sneak Attack
      dash:     0.05,
      dodge:    0.1,
      disengage:0.5,         // boosted further by cunning-action when surrounded
      potion:   1.0
    },
    featureWeights: {
      'sneak-attack':    1.2,
      'cunning-action':  0.7
    }
  },

  wizard: {
    archetype: 'spell_economy',
    considerations: {
      target_low_hp:     { weight: 0.7, curve: 'linear' },
      target_is_caster:  { weight: 0.5, curve: 'step' },
      distance_to_target:{ weight: 0.5, curve: 'linear' }
    },
    actionWeights: {
      melee:  0.1,           // last resort
      ranged: 0.4,           // dagger/crossbow if no spell available
      cast:   1.2,
      dodge:  0.2,
      dash:   0.05,
      potion: 1.25           // squishy, little damage to trade: drinks sooner
    },
    castWeights: {
      'fire-bolt':     0.8,
      'magic-missile': 1.1,
      'sacred-flame':  0.6,
      'shield':        0.0,   // reactive, picked by M33.1 not by chooseAction
      'misty-step':    0.9    // M64 wave 6: teleport out of melee (considerMistyStep)
    }
  },

  cleric: {
    archetype: 'support_caster',
    considerations: {
      target_low_hp:     { weight: 0.6, curve: 'linear' },
      target_is_caster:  { weight: 0.4, curve: 'step' },
      distance_to_target:{ weight: 0.4, curve: 'linear' }
    },
    actionWeights: {
      melee:  0.3,
      ranged: 0.2,
      cast:   1.1,
      heal:   1.4,
      dodge:  0.2,
      potion: 1.0            // only once no heal spell can answer
    },
    castWeights: {
      'sacred-flame':   0.7,
      'inflict-wounds': 0.6,
      'hold-person':    0.9,
      'cure-wounds':    1.4,
      'healing-word':   1.2
    }
  },

  paladin: {
    archetype: 'smite_charger',
    considerations: {
      target_low_hp:     { weight: 0.8, curve: 'linear' },
      target_is_caster:  { weight: 0.5, curve: 'step' },
      distance_to_target:{ weight: 0.4, curve: 'linear' }
    },
    actionWeights: {
      melee:  1.0,
      ranged: 0.4,
      cast:   0.6,
      heal:   1.0,
      dodge:  0.1,
      potion: 1.0
    },
    castWeights: {
      'cure-wounds':   1.3,
      'healing-word':  1.1,
      'inflict-wounds': 0.5
    }
  },

  barbarian: {
    archetype: 'reckless_brute',
    considerations: {
      target_low_hp:     { weight: 0.9, curve: 'linear' },
      distance_to_target:{ weight: 0.5, curve: 'linear' }
    },
    actionWeights: {
      melee:  1.2,
      ranged: 0.3,           // strongly prefers melee
      dash:   0.1,
      dodge:  0.05,
      potion: 0.75           // fights on: wants a clearer edge to drink
    }
  }
};

/** Default profile for any PC we can't classify. Plays straightforward. */
export const DEFAULT_PC_PROFILE = {
  archetype: 'generic_pc',
  considerations: {
    target_low_hp:     { weight: 0.6, curve: 'linear' },
    distance_to_target:{ weight: 0.4, curve: 'linear' }
  },
  actionWeights: {
    melee:  0.8,
    ranged: 0.6,
    dodge:  0.2,
    dash:   0.05,
    potion: 1.0
  }
};

/** Look up the profile for `pc` based on their first class.
 *  M42.3 — Honors a per-entity _aiProfile override (set by the player
 *  via the profile editor) before falling back to the class profile. */
export function profileForPc(pc) {
  if (pc?._aiProfile) return pc._aiProfile;
  const ref = pc?.ref || pc;
  if (ref?._aiProfile) return ref._aiProfile;
  const cls = String(ref?.classes?.[0]?.name || '').toLowerCase();
  return PC_PROFILES[cls] || DEFAULT_PC_PROFILE;
}
