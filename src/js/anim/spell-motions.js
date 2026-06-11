/**
 * M56 Phase 2 — Spell-cast cinema sequences.
 *
 * The engine resolves five spell shapes (heal / auto-hit / spell-attack
 * / AoE save / single-target save); until M56 none of them reached the
 * cinema at all. This module turns a resolved cast into a Sequence the
 * cinema can play, by deriving variants from the authored 'staff-cast'
 * motion (weapon-motions.js).
 *
 * Vocabulary note: the spell registry (scene/monster-spells.js) uses
 * kinds `cantrip-save` / `leveled-save` / `spell-attack` / `auto-hit` /
 * `heal` / `reactive-counter`, with AoE as a separate `aoe: true` flag
 * — there is no literal 'save' kind. `cinemaKindFor` maps that
 * vocabulary onto the five cinema variants and is total: unknown kinds
 * (including `reactive-counter`, which never reaches the resolver's
 * branches in practice) fall through to 'save'.
 *
 * Registry `damageType` values are capitalized ('Fire', 'Radiant');
 * everything here normalizes to lowercase before keying colors.
 *
 * Pure builders — same discipline as weapon-motions.js: every call
 * returns a fresh Sequence and never mutates its inputs.
 */

import { buildMotion } from './weapon-motions.js';
import { cloneSeq } from './sequence.js';

/** Soft green for heal glyphs + sparkles (also in cinema's color map). */
export const HEAL_COLOR = '#4ade80';

/** Display cap — Magic Missile upcast past 8 darts stops adding trails. */
const MAX_DARTS = 8;

/** Stagger between consecutive missile impacts. */
const DART_STAGGER_MS = 120;

/**
 * Map a registry spell record onto a cinema variant id.
 *   heal → 'heal'; auto-hit → 'missiles'; spell-attack → 'bolt';
 *   any save kind with aoe: true → 'aoe'; everything else → 'save'.
 */
export function cinemaKindFor(spell) {
  const kind = String(spell?.kind || '').toLowerCase();
  if (kind === 'heal') return 'heal';
  if (kind === 'auto-hit') return 'missiles';
  if (kind === 'spell-attack') return 'bolt';
  if (spell?.aoe) return 'aoe';
  return 'save';
}

/**
 * Build the cinema Sequence for a resolved cast.
 *
 * @param {object} args
 * @param {object} [args.spell]      — registry spell record (kind, aoe, damageType)
 * @param {string} [args.cinemaKind] — explicit variant override; defaults to cinemaKindFor(spell)
 * @param {object} [args.outcome]    — resolution payload from the engine dispatch:
 *                                     { dmg, heal, darts, miss, saved, crit }
 * @returns {object} a fresh Sequence
 */
export function buildSpellSequence({ spell = {}, cinemaKind = null, outcome = {} } = {}) {
  const kind = cinemaKind || cinemaKindFor(spell);
  const damageType = String(spell.damageType || 'force').toLowerCase();
  const base = buildMotion('staff-cast', { damageType });
  switch (kind) {
    case 'heal':     return healVariant(base);
    case 'missiles': return missilesVariant(base, damageType, outcome);
    case 'bolt':     return boltVariant(base, outcome);
    case 'aoe':      return aoeVariant(base, damageType);
    default:         return saveVariant(base, outcome);
  }
}

/* =====================================================================
 * Variants
 * ===================================================================== */

/** The moment the base sequence's hit-pause fires (= impact). */
function impactOf(seq) {
  const ev = seq.effects.find(e => e.type === 'hit-pause');
  return ev ? ev.at : Math.floor((seq.duration || 1000) / 2);
}

/**
 * Heal — green glyph + sparkle shower; no offensive payload, no
 * defender flinch. `meta.friendly` tells the cinema to keep the
 * target in idle (no hurt phase, no red tint).
 */
function healVariant(base) {
  const out = cloneSeq(base);
  out.id = 'spell-heal';
  out.effects = out.effects.filter(
    e => !['projectile', 'burst', 'shake', 'flash'].includes(e.type)
  );
  out.keyframes = out.keyframes.filter(k => k.actor !== 'defender');
  const glyph = out.effects.find(e => e.type === 'glyph-rise');
  if (glyph) glyph.params = { ...glyph.params, damageType: 'heal' };
  const impactAt = impactOf(out);
  for (let i = 0; i < 4; i++) {
    out.effects.push({
      at: impactAt - 60 + i * 70,
      type: 'sparkle',
      params: { color: HEAL_COLOR, size: 4 + (i % 2), duration: 340, seed: i }
    });
  }
  out.meta = { ...out.meta, kind: 'cast', spellKind: 'heal', friendly: true };
  return out;
}

/**
 * Auto-hit (Magic Missile) — one staggered projectile + burst pair per
 * dart. The base's single projectile/burst is replaced wholesale.
 */
function missilesVariant(base, damageType, outcome) {
  const out = cloneSeq(base);
  out.id = 'spell-missiles';
  const darts = Math.max(1, Math.min(MAX_DARTS, outcome.darts | 0 || 1));
  const impactAt = impactOf(out);
  out.effects = out.effects.filter(e => e.type !== 'projectile' && e.type !== 'burst');
  for (let i = 0; i < darts; i++) {
    const off = i * DART_STAGGER_MS;
    out.effects.push(
      { at: 700 + off, type: 'projectile',
        params: { damageType, travelMs: 220, arcHeight: 14 + (i % 3) * 10 } },
      { at: impactAt - 20 + off, type: 'burst',
        params: { damageType, radius: 28 } }
    );
  }
  const lastAt = impactAt - 20 + (darts - 1) * DART_STAGGER_MS;
  out.duration = Math.max(out.duration, lastAt + 300);
  out.meta = { ...out.meta, kind: 'cast', spellKind: 'missiles', darts };
  return out;
}

/**
 * Spell attack (Fire Bolt, Inflict Wounds) — the base bolt as-is on a
 * hit; on a miss the bolt streaks past with no impact payload and no
 * defender flinch keyframes.
 */
function boltVariant(base, outcome) {
  const out = cloneSeq(base);
  if (outcome.miss) {
    out.id = 'spell-bolt-miss';
    out.effects = out.effects.filter(
      e => !['burst', 'shake', 'flash'].includes(e.type)
    );
    out.keyframes = out.keyframes.filter(k => k.actor !== 'defender');
    const proj = out.effects.find(e => e.type === 'projectile');
    if (proj) proj.params = { ...proj.params, arcHeight: 36, miss: true };
  } else {
    out.id = 'spell-bolt';
  }
  out.meta = { ...out.meta, kind: 'cast', spellKind: 'bolt', miss: !!outcome.miss };
  return out;
}

/**
 * Single-target save (Sacred Flame, Hold Person) — the magic manifests
 * ON the target: glyph + burst, no thrown projectile. A successful
 * save reads weaker (smaller burst, gentler shake). Condition-only
 * spells (dice: null) ride the same shape with dmg 0.
 */
function saveVariant(base, outcome) {
  const out = cloneSeq(base);
  out.id = 'spell-save';
  out.effects = out.effects.filter(e => e.type !== 'projectile');
  if (outcome.saved) {
    out.effects = out.effects.map(e => {
      if (e.type === 'burst') return { ...e, params: { ...e.params, radius: 22 } };
      if (e.type === 'shake') return { ...e, params: { ...e.params, amplitude: 2 } };
      return e;
    });
  }
  out.meta = { ...out.meta, kind: 'cast', spellKind: 'save', saved: !!outcome.saved };
  return out;
}

/**
 * AoE save (Fireball, Fire Breath) — no projectile; the burst goes
 * wide, the shake goes heavy, and a second larger shockwave follows
 * the first. The 1v1 frame shows the hardest-hit target; the rest of
 * the blast stays in the log.
 */
function aoeVariant(base, damageType) {
  const out = cloneSeq(base);
  out.id = 'spell-aoe';
  const impactAt = impactOf(out);
  out.effects = out.effects
    .filter(e => e.type !== 'projectile')
    .map(e => {
      if (e.type === 'burst') return { ...e, params: { ...e.params, radius: 70 } };
      if (e.type === 'shake') return { ...e, params: { ...e.params, amplitude: 6 } };
      return e;
    });
  out.effects.push({
    at: impactAt + 120, type: 'burst',
    params: { damageType, radius: 100 }
  });
  out.meta = { ...out.meta, kind: 'cast', spellKind: 'aoe' };
  return out;
}
