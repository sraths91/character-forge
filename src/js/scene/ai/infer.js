/**
 * M32.2 — inferProfile.
 *
 * Derive an AI profile for an arbitrary creature from whatever fields
 * we have. The current Open5e summary exposes { slug, name, cr, type,
 * size, hp }; if the caller passes a fuller stat block (with .traits
 * or .actions), we extract more.
 *
 * Inference is deliberately conservative — when in doubt we return the
 * matching authored profile (if the slug exists) or a plain charger
 * with a moderate retreat threshold.
 *
 * Output shape matches profiles.js (archetype + considerations +
 * retreat_below_hp + signature_triggers + metagame_blind).
 */

import { MONSTER_PROFILES, DEFAULT_PROFILE } from './profiles.js';

const SIGNAL_TRAITS = {
  pack_tactics:  /pack tactics/i,
  nimble_escape: /nimble escape/i,
  aggressive:    /\baggressive\b/i,
  charge:        /\bcharge\b/i,
  rampage:       /\brampage\b/i,
  regeneration:  /regeneration/i,
  martial:       /martial advantage/i,
  brave:         /\bbrave\b/i,
  fearless:      /(fearless|undead fortitude)/i
};

/**
 * @param {object} stat
 *   stat.slug       — Open5e slug (e.g. "srd_goblin")
 *   stat.name       — display name
 *   stat.type       — "humanoid" | "undead" | "fiend" | "beast" | "dragon" | …
 *   stat.cr         — challenge rating (number) — used as a "smartness" proxy
 *   stat.intelligence — optional INT score (Open5e v2 may not expose it)
 *   stat.traits     — optional array of { name, desc } or strings
 *   stat.actions    — optional array — counted for multiattack hints
 * @returns {object} profile matching profiles.js shape
 */
export function inferProfile(stat = {}) {
  // If the slug already maps to an authored profile, use it verbatim —
  // honoring SRD slugs like "srd_goblin" by stripping the prefix.
  const norm = normalizeSlug(stat.slug);
  if (norm && MONSTER_PROFILES[norm]) return MONSTER_PROFILES[norm];

  const name = String(stat.name || '').toLowerCase();
  const type = String(stat.type || '').toLowerCase();
  const traits = traitNames(stat.traits);
  const has = key => SIGNAL_TRAITS[key].test(traits);

  // ---------- Type-driven baseline ----------
  // Undead are usually mindless except vampires/liches (which have INT)
  if (type.includes('undead') && !name.match(/(vampire|lich|wight|wraith)/)) {
    return {
      ...mindlessAttacker(),
      archetype: 'inferred_mindless_undead'
    };
  }
  // Oozes, plants, constructs without intelligence → straight-line attacker
  if (type.match(/^(ooze|plant|construct)$/)) {
    return { ...mindlessAttacker(), archetype: `inferred_${type}` };
  }

  // ---------- Trait-driven overrides ----------
  if (has('pack_tactics') || has('rampage')) {
    return {
      archetype: 'inferred_pack_hunter',
      considerations: {
        pack_tactics_active: { weight: 1.0, curve: 'step' },
        target_low_hp:       { weight: 0.7, curve: 'linear' },
        has_adjacent_ally:   { weight: 0.4, curve: 'step' },
        distance_to_target:  { weight: 0.3, curve: 'linear' }
      },
      retreat_below_hp: 0.2,
      metagame_blind: ['exact_hp'],
      signature_triggers: []
    };
  }
  if (has('nimble_escape')) {
    return {
      archetype: 'inferred_skirmisher',
      considerations: {
        target_low_hp:      { weight: 0.6, curve: 'linear' },
        self_isolated:      { weight: -0.8, curve: 'step' },
        distance_to_target: { weight: 0.3, curve: 'linear' }
      },
      retreat_below_hp: 0.4,
      metagame_blind: ['exact_hp'],
      signature_triggers: [{ when: 'self_isolated', prefer: 'flee' }]
    };
  }
  if (has('aggressive') || has('charge')) {
    return {
      archetype: 'inferred_charger',
      considerations: {
        distance_to_target: { weight: 0.9, curve: 'linear' },
        target_low_hp:      { weight: 0.3, curve: 'linear' }
      },
      retreat_below_hp: 0,
      metagame_blind: [],
      signature_triggers: []
    };
  }
  if (has('regeneration') || has('fearless')) {
    return {
      archetype: 'inferred_brute',
      considerations: {
        distance_to_target: { weight: 0.8, curve: 'linear' },
        target_low_hp:      { weight: 0.4, curve: 'linear' }
      },
      retreat_below_hp: 0,
      metagame_blind: [],
      signature_triggers: []
    };
  }

  // ---------- Heuristics by name ----------
  if (/cult/.test(name))                 return MONSTER_PROFILES.cultist;
  if (/wolf|hyena|jackal/.test(name))    return MONSTER_PROFILES.gnoll;
  if (/bandit|thug|guard/.test(name))    return MONSTER_PROFILES.bandit;
  if (/(rat|swarm)/.test(name))          return MONSTER_PROFILES.ratfolk;
  if (/(troll|ogre|giant)/.test(name))   return MONSTER_PROFILES.troll;

  // ---------- CR-driven fallback ----------
  const cr = Number.isFinite(stat.cr) ? stat.cr : 1;
  if (cr <= 0.25 && type.includes('humanoid')) {
    return { ...MONSTER_PROFILES.kobold, archetype: 'inferred_coward_pack' };
  }
  if (cr >= 8) {
    // Big things don't run; they push forward
    return {
      archetype: 'inferred_apex',
      considerations: {
        target_low_hp:      { weight: 0.8, curve: 'linear' },
        target_is_caster:   { weight: 0.4, curve: 'step' },
        distance_to_target: { weight: 0.5, curve: 'linear' }
      },
      retreat_below_hp: 0,
      metagame_blind: [],
      signature_triggers: []
    };
  }

  // Final fallback — modest brute with the default's traits
  return { ...DEFAULT_PROFILE, archetype: 'inferred_default' };
}

function mindlessAttacker() {
  return {
    archetype: 'inferred_mindless',
    considerations: {
      distance_to_target: { weight: 1.0, curve: 'linear' }
    },
    retreat_below_hp: 0,
    metagame_blind: [],
    signature_triggers: []
  };
}

function normalizeSlug(slug) {
  if (!slug) return null;
  const s = String(slug).toLowerCase();
  // Open5e: "srd_goblin" → "goblin"; "srd_vampire-spawn" → "vampire-spawn"
  return s.startsWith('srd_') ? s.slice(4) : s;
}

function traitNames(traits) {
  if (!traits) return '';
  if (Array.isArray(traits)) {
    return traits.map(t => typeof t === 'string' ? t : (t?.name || '')).join(' ');
  }
  if (typeof traits === 'string') return traits;
  return '';
}

/**
 * Profile resolver that honors a per-entity override (e.g. an Open5e
 * spawn that was inferred at spawn-time and attached as `_aiProfile`).
 * Falls back to slug-based lookup.
 */
export function profileForEntity(entity) {
  if (entity && entity._aiProfile) return entity._aiProfile;
  return null;   // caller falls back to profileFor(slug)
}
