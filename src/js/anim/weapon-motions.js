/**
 * M43.1 — Weapon motion library.
 *
 * Eight authored AnimationSequences, one per attack archetype. Each
 * builder returns a fresh Sequence (no shared state) so callers can
 * compose with modifiers (M43.4) without polluting the registry.
 *
 * Pacing reference: Fire Emblem GBA combat at ~30fps. A normal-hit
 * scene runs ~1000ms total (5-stage flow: idle → wind-up → strike →
 * hit-pause+recoil → recovery). Heavier weapons run longer (axe ~1100ms,
 * staff cast ~1300ms). Daggers and fists are deliberately snappier
 * (~650ms / ~550ms) to read as "quick".
 *
 * Coordinate convention: attacker enters at x=0, attacks toward positive
 * x. Defender sits at the right edge of the scene; the renderer offsets
 * its anchor. y-positive points down (canvas standard).
 *
 * Effect primitives referenced ('slash-arc', 'thrust', 'bash', 'projectile',
 * 'burst', 'glyph-rise', etc.) match the M27 effects.js library so the
 * compositor's existing overlay pass renders them unchanged.
 */

import { newSequence, addKey, addEffect, insertHitPause } from './sequence.js';

/* =====================================================================
 * Public registry
 * ===================================================================== */

export const WEAPON_MOTIONS = {
  'sword-slash':  buildSwordSlash,
  'sword-thrust': buildSwordThrust,
  'lance-thrust': buildLanceThrust,
  'axe-cleave':   buildAxeCleave,
  'bow-draw':     buildBowDraw,
  'dagger-stab':  buildDaggerStab,
  'staff-cast':   buildStaffCast,
  'fist-jab':     buildFistJab
};

/** Build a fresh motion sequence by id. Returns null for unknown ids. */
export function buildMotion(id, opts = {}) {
  const fn = WEAPON_MOTIONS[id];
  return fn ? fn(opts) : null;
}

/** Heuristic: pick the right motion id for a weapon record. Reads
 *  `weapon.name` and falls back to 'sword-slash' for unknowns. */
export function motionForWeapon(weapon) {
  if (!weapon) return 'fist-jab';
  const name = String(weapon.name || '').toLowerCase();
  // Order matters: more specific patterns first.
  // Quarterstaff is a polearm in our motion lib, so the polearm check
  // runs before the generic staff/wand check.
  if (/glaive|halberd|pike|spear|lance|quarterstaff/.test(name)) return 'lance-thrust';
  if (/\bstaff\b|wand|focus|rod|orb/.test(name))         return 'staff-cast';
  if (/longbow|shortbow|crossbow|sling|bow/.test(name)) return 'bow-draw';
  if (/dagger|shortsword|throwing knife/.test(name))    return 'dagger-stab';
  if (/axe|maul|warhammer|club|mace|morningstar|hammer/.test(name)) return 'axe-cleave';
  if (/rapier|estoc|stiletto/.test(name))               return 'sword-thrust';
  if (/scimitar|sword|katana|cutlass|blade|saber/.test(name)) return 'sword-slash';
  if (/fist|unarmed|knuckle|gauntlet/.test(name))       return 'fist-jab';
  return 'sword-slash';
}

/* =====================================================================
 * Individual motion builders
 * Each authors a 5-stage sequence:
 *   1. Idle anticipation (slight pull-back; sets "ready" pose)
 *   2. Wind-up (anticipate easing — sprite moves AWAY before forward)
 *   3. Strike (forward thrust + effect primitive)
 *   4. Hit-pause + defender reaction
 *   5. Recovery (return to idle)
 * ===================================================================== */

/** Standard slashing weapon. 1000ms total. */
function buildSwordSlash(opts = {}) {
  const dmgType = opts.damageType || 'slashing';
  const s = newSequence('sword-slash', 1000);
  // Attacker
  addKey(s, { at: 0,    actor: 'attacker', x: 0,  rotation: 0,    easing: 'linear' });
  addKey(s, { at: 200,  actor: 'attacker', x: -5, rotation: -0.2, easing: 'easeOut' });   // wind-up
  addKey(s, { at: 450,  actor: 'attacker', x: 30, rotation: 0.3,  easing: 'easeIn' });    // strike
  addKey(s, { at: 700,  actor: 'attacker', x: 25, rotation: 0.1,  easing: 'linear' });    // follow-through
  addKey(s, { at: 1000, actor: 'attacker', x: 0,  rotation: 0,    easing: 'easeOut' });   // recover
  // Defender — flinch on hit
  addKey(s, { at: 0,    actor: 'defender', x: 0 });
  addKey(s, { at: 450,  actor: 'defender', x: 5 });   // pre-impact (subtle nudge)
  addKey(s, { at: 480,  actor: 'defender', x: 12 });  // knockback
  addKey(s, { at: 800,  actor: 'defender', x: 0 });   // settle
  // Effects: slash arc fires just before impact for visual weight
  addEffect(s, { at: 400, type: 'slash-arc', params: { damageType: dmgType } });
  addEffect(s, { at: 460, type: 'shake', params: { amplitude: 3 } });
  // Hit-pause adds 180ms freeze at the impact frame (extends total to 1180ms)
  insertHitPause(s, 460, 180);
  s.meta = { kind: 'melee', weaponClass: 'sword' };
  return s;
}

/** Rapier / scimitar — sharper, faster point-thrust. 850ms. */
function buildSwordThrust(opts = {}) {
  const dmgType = opts.damageType || 'piercing';
  const s = newSequence('sword-thrust', 850);
  addKey(s, { at: 0,    actor: 'attacker', x: 0  });
  addKey(s, { at: 150,  actor: 'attacker', x: -3, easing: 'easeOut' });
  addKey(s, { at: 400,  actor: 'attacker', x: 35, easing: 'easeIn' });    // long lunge
  addKey(s, { at: 850,  actor: 'attacker', x: 0,  easing: 'easeOut' });
  addKey(s, { at: 0,    actor: 'defender', x: 0 });
  addKey(s, { at: 420,  actor: 'defender', x: 14 });
  addKey(s, { at: 700,  actor: 'defender', x: 0 });
  addEffect(s, { at: 350, type: 'thrust', params: { damageType: dmgType } });
  addEffect(s, { at: 420, type: 'shake', params: { amplitude: 2 } });
  insertHitPause(s, 420, 150);
  s.meta = { kind: 'melee', weaponClass: 'sword' };
  return s;
}

/** Lance / spear — long reach, hard thrust. 950ms. */
function buildLanceThrust(opts = {}) {
  const dmgType = opts.damageType || 'piercing';
  const s = newSequence('lance-thrust', 950);
  addKey(s, { at: 0,    actor: 'attacker', x: 0,  y: 0 });
  addKey(s, { at: 150,  actor: 'attacker', x: 0,  y: 2, rotation: 0.1, easing: 'easeOut' });   // lance dip
  addKey(s, { at: 420,  actor: 'attacker', x: 40, y: 0, rotation: 0,   easing: 'easeIn' });    // thrust
  addKey(s, { at: 950,  actor: 'attacker', x: 0,  y: 0, rotation: 0,   easing: 'easeOut' });
  addKey(s, { at: 0,    actor: 'defender', x: 0 });
  addKey(s, { at: 440,  actor: 'defender', x: 16 });   // bigger knockback
  addKey(s, { at: 800,  actor: 'defender', x: 0 });
  addEffect(s, { at: 380, type: 'thrust', params: { damageType: dmgType, range: 'long' } });
  addEffect(s, { at: 440, type: 'shake', params: { amplitude: 4 } });
  insertHitPause(s, 440, 200);
  s.meta = { kind: 'melee', weaponClass: 'polearm' };
  return s;
}

/** Greataxe / maul — heavy overhead. Slow but high-impact. 1100ms. */
function buildAxeCleave(opts = {}) {
  const dmgType = opts.damageType || 'slashing';
  const s = newSequence('axe-cleave', 1100);
  addKey(s, { at: 0,    actor: 'attacker', x: 0,  y: 0, rotation: 0 });
  addKey(s, { at: 280,  actor: 'attacker', x: -6, y: -5, rotation: -0.5, easing: 'anticipate' });   // overhead wind-up
  addKey(s, { at: 530,  actor: 'attacker', x: 25, y: 10, rotation: 0.7,  easing: 'easeIn' });        // cleave down
  addKey(s, { at: 800,  actor: 'attacker', x: 20, y: 5,  rotation: 0.4,  easing: 'linear' });
  addKey(s, { at: 1100, actor: 'attacker', x: 0,  y: 0,  rotation: 0,    easing: 'easeOut' });
  addKey(s, { at: 0,    actor: 'defender', x: 0 });
  addKey(s, { at: 560,  actor: 'defender', x: 18 });   // big stagger
  addKey(s, { at: 600,  actor: 'defender', x: 8 });
  addKey(s, { at: 900,  actor: 'defender', x: 0 });
  addEffect(s, { at: 500, type: 'bash', params: { damageType: dmgType, heavy: true } });
  addEffect(s, { at: 560, type: 'shake', params: { amplitude: 6 } });
  insertHitPause(s, 560, 250);
  s.meta = { kind: 'melee', weaponClass: 'heavy' };
  return s;
}

/** Bow — draw + release + projectile travel time. 1100ms. */
function buildBowDraw(opts = {}) {
  const dmgType = opts.damageType || 'piercing';
  const s = newSequence('bow-draw', 1100);
  addKey(s, { at: 0,    actor: 'attacker', x: 0,  scale: 1 });
  addKey(s, { at: 350,  actor: 'attacker', x: -4, scale: 1.02, easing: 'easeOut' });   // draw the string (subtle lean back)
  addKey(s, { at: 450,  actor: 'attacker', x: -2, scale: 1,    easing: 'easeIn' });    // release
  addKey(s, { at: 1100, actor: 'attacker', x: 0,  scale: 1,    easing: 'easeOut' });   // recover
  addKey(s, { at: 0,    actor: 'defender', x: 0 });
  // Hold defender at rest through arrow-flight by clamping the
  // pre-impact frame to x=0. Without this the linear interpolation
  // would drift them forward during the projectile's travel time.
  addKey(s, { at: 790,  actor: 'defender', x: 0 });
  addKey(s, { at: 810,  actor: 'defender', x: 10 });   // impact
  addKey(s, { at: 1050, actor: 'defender', x: 0 });
  // Effect: projectile fires at release, travels for ~350ms, lands at 800.
  // M44.4 — Bows shoot a high parabolic arc. The arcHeight here is the
  // base; the cinema renderer scales it by horizontal travel distance
  // so cross-stage shots arc visibly higher than point-blank.
  addEffect(s, { at: 430, type: 'projectile', params: { damageType: dmgType, travelMs: 350, arcHeight: 60 } });
  addEffect(s, { at: 800, type: 'shake', params: { amplitude: 3 } });
  insertHitPause(s, 800, 160);
  s.meta = { kind: 'ranged', weaponClass: 'bow' };
  return s;
}

/** Dagger — short, snappy. 650ms. */
function buildDaggerStab(opts = {}) {
  const dmgType = opts.damageType || 'piercing';
  const s = newSequence('dagger-stab', 650);
  addKey(s, { at: 0,   actor: 'attacker', x: 0  });
  addKey(s, { at: 100, actor: 'attacker', x: -2, easing: 'easeOut' });
  addKey(s, { at: 250, actor: 'attacker', x: 22, easing: 'easeIn' });
  addKey(s, { at: 650, actor: 'attacker', x: 0,  easing: 'easeOut' });
  addKey(s, { at: 0,   actor: 'defender', x: 0 });
  addKey(s, { at: 260, actor: 'defender', x: 8 });
  addKey(s, { at: 500, actor: 'defender', x: 0 });
  addEffect(s, { at: 220, type: 'thrust', params: { damageType: dmgType, range: 'short' } });
  addEffect(s, { at: 260, type: 'shake', params: { amplitude: 2 } });
  insertHitPause(s, 260, 100);   // snappy, shorter pause
  s.meta = { kind: 'melee', weaponClass: 'light' };
  return s;
}

/** Spell-cast (staff/wand/focus). Multi-stage: caster pose → glyph →
 *  projectile/burst → impact. 1300ms. */
function buildStaffCast(opts = {}) {
  const dmgType = opts.damageType || 'force';
  const s = newSequence('staff-cast', 1300);
  addKey(s, { at: 0,    actor: 'attacker', x: 0, y: 0, scale: 1 });
  addKey(s, { at: 300,  actor: 'attacker', x: 0, y: -3, scale: 1.04, easing: 'easeOut' });   // caster pose lift
  addKey(s, { at: 700,  actor: 'attacker', x: 0, y: -3, scale: 1.04, easing: 'linear' });
  addKey(s, { at: 1300, actor: 'attacker', x: 0, y: 0,  scale: 1,    easing: 'easeOut' });
  addKey(s, { at: 0,    actor: 'defender', x: 0 });
  addKey(s, { at: 920,  actor: 'defender', x: 7 });    // impact
  addKey(s, { at: 1100, actor: 'defender', x: 0 });
  // Multi-stage effect: glyph rises during the cast, projectile launches,
  // burst on impact. Flash adds dramatic emphasis.
  addEffect(s, { at: 400,  type: 'glyph-rise',    params: { damageType: dmgType } });
  // M44.4 — Spell darts arc moderately (lower than a bow shot; reads
  // as a directed bolt rather than a thrown stone).
  addEffect(s, { at: 700,  type: 'projectile',    params: { damageType: dmgType, travelMs: 220, arcHeight: 20 } });
  addEffect(s, { at: 900,  type: 'burst',         params: { damageType: dmgType } });
  addEffect(s, { at: 900,  type: 'flash',         params: { intensity: 0.5 } });
  addEffect(s, { at: 920,  type: 'shake',         params: { amplitude: 4 } });
  insertHitPause(s, 920, 220);
  s.meta = { kind: 'cast', weaponClass: 'arcane' };
  return s;
}

/** Unarmed / monk strike — snappiest of all. 550ms. */
function buildFistJab(opts = {}) {
  const dmgType = opts.damageType || 'bludgeoning';
  const s = newSequence('fist-jab', 550);
  addKey(s, { at: 0,   actor: 'attacker', x: 0  });
  addKey(s, { at: 100, actor: 'attacker', x: -3, easing: 'easeOut' });
  addKey(s, { at: 200, actor: 'attacker', x: 20, easing: 'easeIn' });
  addKey(s, { at: 550, actor: 'attacker', x: 0,  easing: 'easeOut' });
  addKey(s, { at: 0,   actor: 'defender', x: 0 });
  addKey(s, { at: 210, actor: 'defender', x: 7 });
  addKey(s, { at: 450, actor: 'defender', x: 0 });
  addEffect(s, { at: 180, type: 'bash', params: { damageType: dmgType, light: true } });
  addEffect(s, { at: 210, type: 'shake', params: { amplitude: 1.5 } });
  insertHitPause(s, 210, 90);
  s.meta = { kind: 'melee', weaponClass: 'unarmed' };
  return s;
}
