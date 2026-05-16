/**
 * M27 — Combat effects library.
 *
 * Defines the 12 primitive visual effects the compositor can draw on top
 * of the battle scene, plus the per-damage-type color palette and the
 * action-to-effect registry that maps "what just happened" (weapon
 * attack, spell, save spell, AoE, feature trigger) to a sequence of
 * effects to play.
 *
 * Pure module — no DOM, no globals. Effects are described as data
 * objects; the compositor's overlay pass interprets them. RNG is
 * injectable so jitter (particle scatter) is deterministic in tests.
 *
 * Effect descriptor shape:
 *   {
 *     kind: 'slash-arc' | 'thrust' | 'bash' | 'projectile' | 'beam' |
 *           'burst' | 'aoe-fill' | 'divine-glow' | 'shadow-strike' |
 *           'lunge' | 'recoil' | 'glyph-rise',
 *     startedAt: <number>,        // ms timestamp
 *     duration:  <number>,        // ms
 *     color:     <string>,        // CSS color
 *     // primitive-specific fields below:
 *     from:    { col, row },      // attacker cell  (most primitives)
 *     to:      { col, row },      // target cell    (most primitives)
 *     cells:   [{ col, row }],    // for aoe-fill
 *     glyph:   '✋',              // for glyph-rise (emoji or text)
 *     size:    <number>,          // optional radius hint (cells)
 *   }
 *
 * Entity-positional effects (lunge, recoil) carry an `entityId` instead
 * of from/to since they shift the rendered sprite directly.
 */

// ---------- Damage / school color palette ----------

// CSS colors keyed by 5e damage type (lowercased). Used for projectiles,
// beams, bursts. Falls back to a neutral white when the type is unknown.
export const DAMAGE_COLORS = {
  fire:        '#fb923c',
  cold:        '#bae6fd',
  lightning:   '#7dd3fc',
  thunder:     '#c4b5fd',
  acid:        '#a3e635',
  poison:      '#86efac',
  necrotic:    '#86efac',
  radiant:     '#fde68a',
  force:       '#c4b5fd',
  psychic:     '#f0abfc',
  // physical: neutral white, with slight tinting
  slashing:    '#e5e7eb',
  piercing:    '#e5e7eb',
  bludgeoning: '#e5e7eb'
};
export const DEFAULT_COLOR = '#e5e7eb';

export function colorForDamageType(type) {
  if (!type) return DEFAULT_COLOR;
  return DAMAGE_COLORS[String(type).toLowerCase()] || DEFAULT_COLOR;
}

// ---------- Action → effect registry ----------

/**
 * Pick the appropriate weapon-attack primitive based on damage type and
 * range. Slashing → slash-arc, Piercing+ranged → projectile, Piercing+
 * finesse → thrust, Bludgeoning → bash, anything else → bash.
 */
export function weaponAttackPrimitive(weapon, isRanged) {
  if (isRanged) return 'projectile';
  const type = String(weapon?.damageType || '').toLowerCase();
  if (type === 'slashing') return 'slash-arc';
  if (type === 'piercing') {
    // Heuristic: finesse-typed names get a thrust, otherwise slash-arc.
    const props = Array.isArray(weapon?.properties)
      ? weapon.properties.map(p => String(p?.name || p || '').toLowerCase())
      : [];
    if (props.includes('finesse')) return 'thrust';
    const n = String(weapon?.name || '').toLowerCase();
    if (/\b(rapier|dagger|shortsword|scimitar)\b/.test(n)) return 'thrust';
    return 'slash-arc';
  }
  if (type === 'bludgeoning') return 'bash';
  return 'bash';
}

/**
 * Pick the spell-attack primitive. Beam spells (line-of-sight) are a
 * subset of attack-roll spells; everything else is a projectile.
 */
const BEAM_SPELL_NAMES = new Set([
  'ray of frost', 'scorching ray', 'eldritch blast', 'guiding bolt',
  'ray of enfeeblement', 'ray of sickness', 'witch bolt', 'disintegrate'
]);
export function spellAttackPrimitive(spell) {
  const n = String(spell?.name || '').toLowerCase();
  return BEAM_SPELL_NAMES.has(n) ? 'beam' : 'projectile';
}

/**
 * Build the full effect sequence for a weapon attack that landed.
 * Includes the weapon-specific primitive, lunge on attacker, and recoil
 * on target. Crits get an additional shadow-strike-like accent flare.
 */
export function effectsForWeaponHit({ attacker, target, weapon, isRanged, crit, now = performance.now() }) {
  const primitive = weaponAttackPrimitive(weapon, isRanged);
  const color = colorForDamageType(weapon?.damageType);
  const fromPos = positionOf(attacker);
  const toPos   = positionOf(target);
  const effects = [];

  // Lunge: only for melee — ranged attackers don't step forward
  if (!isRanged) {
    effects.push({
      kind: 'lunge',
      entityId: attacker.id,
      direction: directionTowards(fromPos, toPos),
      startedAt: now,
      duration: 280
    });
  }
  // The weapon primitive itself
  effects.push({
    kind: primitive,
    from: fromPos, to: toPos,
    color,
    startedAt: now + (isRanged ? 0 : 60),   // melee primitive slightly delayed after lunge starts
    duration: primitive === 'projectile' ? 360 : 240
  });
  // Recoil: target jolts on the impact
  effects.push({
    kind: 'recoil',
    entityId: target.id,
    direction: directionTowards(toPos, fromPos),
    startedAt: now + (primitive === 'projectile' ? 280 : 180),
    duration: 240
  });
  // Crit accent: extra flash
  if (crit) {
    effects.push({
      kind: 'shadow-strike',
      to: toPos,
      color: '#fbbf24',
      startedAt: now + 200,
      duration: 380
    });
  }
  return effects;
}

/** Build effects for a missed weapon attack — only lunge + the weapon
 *  primitive, no recoil. Helps the user see "yes I swung at them." */
export function effectsForWeaponMiss({ attacker, target, weapon, isRanged, now = performance.now() }) {
  const primitive = weaponAttackPrimitive(weapon, isRanged);
  const color = colorForDamageType(weapon?.damageType);
  const fromPos = positionOf(attacker);
  const toPos   = positionOf(target);
  const out = [];
  if (!isRanged) {
    out.push({
      kind: 'lunge', entityId: attacker.id,
      direction: directionTowards(fromPos, toPos),
      startedAt: now, duration: 240
    });
  }
  out.push({
    kind: primitive,
    from: fromPos, to: toPos, color,
    startedAt: now + (isRanged ? 0 : 60),
    duration: primitive === 'projectile' ? 360 : 220
  });
  return out;
}

/**
 * Build effects for a spell attack: projectile or beam from caster to
 * target, plus a target burst on hit. Color comes from spell damageType.
 */
export function effectsForSpellAttack({ attacker, target, spell, hit, now = performance.now() }) {
  const primitive = spellAttackPrimitive(spell);
  const color = colorForDamageType(spell?.damageType);
  const fromPos = positionOf(attacker);
  const toPos   = positionOf(target);
  const out = [];
  out.push({
    kind: primitive,
    from: fromPos, to: toPos, color,
    startedAt: now,
    duration: primitive === 'beam' ? 360 : 420
  });
  if (hit) {
    out.push({
      kind: 'burst',
      to: toPos, color,
      startedAt: now + (primitive === 'beam' ? 280 : 360),
      duration: 360
    });
    out.push({
      kind: 'recoil',
      entityId: target.id,
      direction: directionTowards(toPos, fromPos),
      startedAt: now + (primitive === 'beam' ? 280 : 360),
      duration: 240
    });
  }
  return out;
}

/**
 * Build effects for a save-based spell hitting a target. Burst always
 * plays; recoil only when damage was dealt.
 */
export function effectsForSaveSpell({ attacker, target, spell, damaged, now = performance.now() }) {
  const color = colorForDamageType(spell?.damageType);
  const fromPos = positionOf(attacker);
  const toPos   = positionOf(target);
  const out = [{
    kind: 'burst',
    to: toPos, color,
    startedAt: now,
    duration: 460
  }];
  // For touch spells we add a brief beam from caster
  if (spell?.range?.kind === 'touch' || spell?.range?.feet === 0) {
    out.push({
      kind: 'beam', from: fromPos, to: toPos, color,
      startedAt: now, duration: 240
    });
  }
  if (damaged) {
    out.push({
      kind: 'recoil', entityId: target.id,
      direction: directionTowards(toPos, fromPos),
      startedAt: now + 200, duration: 240
    });
  }
  return out;
}

/**
 * Build effects for an AoE spell placed via the M8 template system.
 * Fills every covered cell with the school color, plus a burst at the
 * template's origin.
 */
export function effectsForAoeSpell({ cells, origin, spell, now = performance.now() }) {
  const color = colorForDamageType(spell?.damageType);
  const out = [{
    kind: 'aoe-fill', cells, color,
    startedAt: now, duration: 600
  }];
  if (origin) {
    out.push({
      kind: 'burst', to: origin, color,
      startedAt: now, duration: 500
    });
  }
  return out;
}

/**
 * Build effects for a class-feature trigger. Specifically:
 *   - Sneak Attack: shadow-strike + dark red flash on target
 *   - Channel Divinity, Divine Smite, Bless: divine-glow on target
 *   - Anything else: a neutral burst
 */
export function effectsForFeatureTrigger({ feature, target, now = performance.now() }) {
  const toPos = positionOf(target);
  const name = String(feature?.name || '').toLowerCase();
  if (/sneak attack/.test(name)) {
    return [{
      kind: 'shadow-strike',
      to: toPos, color: '#dc2626',
      startedAt: now, duration: 460
    }];
  }
  if (/channel divinity|divine smite|bless|sanctuary|crusader's mantle/.test(name)) {
    return [{
      kind: 'divine-glow',
      to: toPos, color: '#fde68a',
      startedAt: now, duration: 620
    }];
  }
  return [{
    kind: 'burst', to: toPos, color: DEFAULT_COLOR,
    startedAt: now, duration: 400
  }];
}

/**
 * Build a glyph-rise effect for a concentration spell being applied
 * (Bless ✋, Hex 🩸, Hunter's Mark 🎯). Pure visual cue.
 */
export function effectsForConcentration({ target, spell, glyph = '✨', now = performance.now() }) {
  return [{
    kind: 'glyph-rise',
    to: positionOf(target),
    glyph,
    color: colorForDamageType(spell?.damageType) || '#fde68a',
    startedAt: now, duration: 900
  }];
}

// ---------- Helpers ----------

function positionOf(entity) {
  return entity?._position || entity?.position || { col: 0, row: 0 };
}

/** Cardinal direction from a to b. Falls back to 'east' for self-targets. */
export function directionTowards(a, b) {
  if (!a || !b) return 'east';
  const dc = b.col - a.col;
  const dr = b.row - a.row;
  if (Math.abs(dc) >= Math.abs(dr)) return dc >= 0 ? 'east' : 'west';
  return dr >= 0 ? 'south' : 'north';
}

/** Linear progress 0..1 for an effect at time `now`. Clamps to [0,1]. */
export function effectProgress(effect, now = performance.now()) {
  const elapsed = now - effect.startedAt;
  if (elapsed < 0) return 0;
  if (elapsed > effect.duration) return 1;
  return elapsed / effect.duration;
}
