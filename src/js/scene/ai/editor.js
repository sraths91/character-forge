/**
 * M32.3 — Profile-editor helpers.
 *
 * Pure functions for tweaking an entity's `_aiProfile` from the UI:
 * weight sliders, archetype dropdown, retreat threshold, reset.
 *
 * All mutations are done on cloned profiles — we never edit the
 * authored `MONSTER_PROFILES` records (they're shared singletons that
 * many monsters of the same slug point at).
 */

import { MONSTER_PROFILES, DEFAULT_PROFILE, profileFor } from './profiles.js';
import { CONSIDERATIONS } from './considerations.js';

/** Deep clone of an authored profile so the editor can mutate it. */
export function cloneProfile(profile) {
  if (!profile) return clone(DEFAULT_PROFILE);
  return {
    archetype: profile.archetype,
    considerations: Object.fromEntries(
      Object.entries(profile.considerations || {}).map(([k, v]) => [
        k,
        typeof v === 'number' ? v : { weight: v.weight, curve: v.curve || 'linear' }
      ])
    ),
    retreat_below_hp: profile.retreat_below_hp ?? 0,
    metagame_blind: [...(profile.metagame_blind || [])],
    signature_triggers: [...(profile.signature_triggers || [])]
  };
}

function clone(p) { return cloneProfile(p); }

/**
 * Return the editable profile for `entity`. If the entity already has
 * an override (_aiProfile from M32.2 inference or a prior edit), use
 * that; otherwise clone the slug's authored profile.
 */
export function editableProfileFor(entity) {
  if (entity?._aiProfile) return cloneProfile(entity._aiProfile);
  return cloneProfile(profileFor(entity?.presetSlug));
}

/**
 * Apply a single weight change. Returns a NEW profile object — the
 * caller should assign it back to entity._aiProfile.
 *
 * If `weight` is 0, the consideration is removed entirely (cleaner
 * roll-log output than spammy zeros).
 */
export function applyWeightChange(profile, considerationName, weight) {
  if (!CONSIDERATIONS[considerationName]) return profile;
  const next = cloneProfile(profile);
  if (!Number.isFinite(weight) || Math.abs(weight) < 0.05) {
    delete next.considerations[considerationName];
    return next;
  }
  const prev = next.considerations[considerationName];
  const curve = (prev && typeof prev !== 'number') ? (prev.curve || 'linear') : 'linear';
  next.considerations[considerationName] = { weight: round1(weight), curve };
  return next;
}

/** Apply a retreat-threshold change. */
export function applyRetreatChange(profile, retreat) {
  const next = cloneProfile(profile);
  next.retreat_below_hp = clamp(retreat, 0, 0.95);
  return next;
}

/**
 * Swap to a different authored archetype. Returns a clone of that
 * archetype's profile. If the slug is unknown, returns the input
 * unchanged.
 */
export function applyArchetypeSwap(profile, slug) {
  const target = MONSTER_PROFILES[slug];
  if (!target) return profile;
  return cloneProfile(target);
}

/**
 * Reset back to the slug's authored profile. Returning `null` is a
 * signal to the caller to delete entity._aiProfile (rather than store
 * a copy that drifts over time).
 */
export function resetProfile() { return null; }

/** All authored archetype options for the dropdown. */
export function listArchetypes() {
  return Object.entries(MONSTER_PROFILES).map(([slug, profile]) => ({
    slug, archetype: profile.archetype
  }));
}

/** All consideration names — used to populate the editor with every
 *  knob, including ones not present in the current profile (weight 0). */
export function listConsiderations() {
  return Object.keys(CONSIDERATIONS);
}

function round1(v) { return Math.round(v * 10) / 10; }
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
