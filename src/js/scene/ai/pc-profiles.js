/**
 * M42 — Class archetypes for PCs (utility-AI profiles).
 *
 * Same shape as MONSTER_PROFILES in profiles.js: a `considerations` map
 * weighting per-target signals, plus `actionWeights` that bias the
 * action-kind choice (melee vs ranged vs cast vs feature). The class
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
      dodge:  0.05
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
      disengage:0.5          // boosted further by cunning-action when surrounded
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
      dash:   0.05
    },
    castWeights: {
      'fire-bolt':     0.8,
      'magic-missile': 1.1,
      'sacred-flame':  0.6,
      'shield':        0.0    // reactive, picked by M33.1 not by chooseAction
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
      dodge:  0.2
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
      dodge:  0.1
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
      dodge:  0.05
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
    dash:   0.05
  }
};

/** Look up the profile for `pc` based on their first class. */
export function profileForPc(pc) {
  const ref = pc?.ref || pc;
  const cls = String(ref?.classes?.[0]?.name || '').toLowerCase();
  return PC_PROFILES[cls] || DEFAULT_PC_PROFILE;
}
