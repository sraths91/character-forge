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
import { PC_PROFILES, profileForPc } from './pc-profiles.js';
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
 *
 * M42.3 — Branches on kind: PCs use PC_PROFILES (class-derived),
 * monsters use MONSTER_PROFILES (slug-derived).
 */
export function editableProfileFor(entity) {
  if (entity?._aiProfile) return cloneProfile(entity._aiProfile);
  if (isPcEntity(entity)) return cloneProfile(profileForPc(entity));
  return cloneProfile(profileFor(entity?.presetSlug));
}

/** Heuristic: anything with classes[] but no presetSlug is a PC. */
function isPcEntity(entity) {
  if (!entity) return false;
  if (entity.kind === 'pc') return true;
  if (entity.presetSlug) return false;
  const ref = entity.ref || entity;
  return Array.isArray(ref?.classes) && ref.classes.length > 0;
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
 * Swap to a different authored archetype. Looks in both registries —
 * PC class profiles and monster profiles — so the same editor UI can
 * drive both kinds of entity.
 */
export function applyArchetypeSwap(profile, slug) {
  const target = MONSTER_PROFILES[slug] || PC_PROFILES[slug];
  if (!target) return profile;
  return cloneProfile(target);
}

/**
 * Reset back to the slug's authored profile. Returning `null` is a
 * signal to the caller to delete entity._aiProfile (rather than store
 * a copy that drifts over time).
 */
export function resetProfile() { return null; }

/** All authored archetype options for the dropdown.
 *  M42.3 — `forKind` filters to PC vs monster archetypes so the editor
 *  surfaces relevant choices only. Omit to get both. */
export function listArchetypes(forKind = null) {
  const out = [];
  if (forKind !== 'pc') {
    for (const [slug, profile] of Object.entries(MONSTER_PROFILES)) {
      out.push({ slug, archetype: profile.archetype, kind: 'monster' });
    }
  }
  if (forKind !== 'monster') {
    for (const [slug, profile] of Object.entries(PC_PROFILES)) {
      out.push({ slug, archetype: profile.archetype, kind: 'pc' });
    }
  }
  return out;
}

/** All consideration names — used to populate the editor with every
 *  knob, including ones not present in the current profile (weight 0). */
export function listConsiderations() {
  return Object.keys(CONSIDERATIONS);
}

function round1(v) { return Math.round(v * 10) / 10; }
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
