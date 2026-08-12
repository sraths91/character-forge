/**
 * Map a parsed D&D character to a Quaternius modular compose() spec — which
 * body-part set, weapon, shield, and tints to assemble. Pure: no three.js /
 * DOM (the composer, modular-viewer.js, consumes this).
 *
 * Fidelity is honest: cloth / leather / robe read faithfully; metal armour
 * (plate / chain) is an APPROXIMATE proxy (placeholder:true) until the
 * Quaternius Fantasy pack is added — swapping a body file then upgrades it
 * with zero code change. Node names + the SpaceSuit plate-proxy prefix were
 * confirmed at runtime by the composition spike.
 */

import { classifyArmor } from '../scene/pc-stats.js';
import { motionForWeapon } from './weapon-motions.js';

const BASE = '/assets/3d/modular';

// Body sets: GLB file + mesh-node PREFIX. Slots load as multi-primitive
// Groups, so the composer collects skinned meshes by this prefix (spike).
const BODIES = {
  king:      { file: 'King.glb',       prefix: 'King' },       // robe + crown
  adventurer:{ file: 'Adventurer.glb', prefix: 'Adventurer' }, // leather
  farmer:    { file: 'Farmer.glb',     prefix: 'Farmer' },     // commoner (legs node = *_Pants)
  spacesuit: { file: 'SpaceSuit.glb',  prefix: 'SpaceSuit' }   // full-plate proxy (NOT "Astronaut")
};

// Weapon meshes → attach to WristR. `mult` scales the spike's 0.01 base
// (derived from the hand-bone world scale at compose time).
const WEAPONS = {
  sword:  { file: 'sword.glb',    mult: 1 },
  hammer: { file: 'hammer_q.glb', mult: 1 },
  axe:    { file: 'axe.glb',      mult: 1 },
  dagger: { file: 'dagger.glb',   mult: 1 },
  staff:  { file: 'staff.glb',    mult: 1 },
  spear:  { file: 'spear.glb',    mult: 1 },
  bow:    { file: 'bow_q.glb',    mult: 1 }
};
const SHIELD = { file: 'shield.glb', mult: 0.4 };

// motionForWeapon id → weapon key. Blunt (hammer/mace) is refined out of the
// axe-cleave bucket by name below.
const MOTION_TO_WEAPON = {
  'sword-slash': 'sword', 'sword-thrust': 'sword',
  'axe-cleave': 'axe', 'dagger-stab': 'dagger',
  'staff-cast': 'staff', 'lance-thrust': 'spear',
  'bow-draw': 'bow', 'fist-jab': null
};
const BLUNT = /hammer|mace|maul|morningstar|flail|club/i;

// sRGB tints (material colour multiply).
const TINT = {
  steel: '#b9c2cc', iron: '#8a8f96', darkiron: '#6f7580',
  leather: '#6b4a2b', cleric: '#f2ead6', wizard: '#3a2f6b',
  druid: '#4a5a33', commoner: '#8c7a5c'
};

function primaryClassName(character) {
  const list = Array.isArray(character?.classes) ? character.classes : [];
  let best = list[0];
  for (const c of list) if ((Number(c?.level) || 0) > (Number(best?.level) || 0)) best = c;
  return String(best?.name || best?.definition?.name || '').toLowerCase();
}
const isCaster = (cls) => /wizard|sorcerer|warlock|druid|bard/.test(cls);

/** Choose the body set + tint + honesty flags for a character. */
function pickBody(character) {
  const armorName = (character?.equipment?.armor?.name || '').toLowerCase();
  const weight = armorName ? classifyArmor(armorName) : 'none';   // classifyArmor is case-sensitive
  const cls = primaryClassName(character);

  // Robed caster / unarmoured cleric → King (robe + crown), class-tinted.
  if ((isCaster(cls) || cls === 'cleric') && weight !== 'heavy' && weight !== 'medium') {
    const tint = /wizard|sorcerer|warlock/.test(cls) ? TINT.wizard
      : cls === 'druid' ? TINT.druid
      : cls === 'cleric' ? TINT.cleric : TINT.commoner;
    return { key: 'king', tint, placeholder: false, gaps: [] };
  }
  if (weight === 'heavy') {
    if (/plate/.test(armorName) && !/half/.test(armorName)) {
      return { key: 'spacesuit', tint: TINT.steel, placeholder: true, gaps: ['plate-approx'] };
    }
    return { key: 'adventurer', tint: TINT.iron, placeholder: true, gaps: ['heavy-approx'] };
  }
  if (weight === 'medium') return { key: 'adventurer', tint: TINT.darkiron, placeholder: true, gaps: ['medium-approx'] };
  if (weight === 'light')  return { key: 'adventurer', tint: TINT.leather, placeholder: false, gaps: [] };
  return { key: 'farmer', tint: TINT.commoner, placeholder: false, gaps: [] };
}

/** The character's equipped-primary weapon mesh (the parser already promoted
 *  the iconic weapon into mainhand), or null for empty hands. */
function pickWeapon(character) {
  const mh = character?.equipment?.mainhand;
  if (!mh) return null;
  const motion = motionForWeapon(mh);
  const name = mh.name || '';
  let key = MOTION_TO_WEAPON[motion];
  if (motion === 'axe-cleave' && BLUNT.test(name)) key = 'hammer';       // warhammer/mace out of the axe bucket
  if (motion === 'lance-thrust' && /staff|quarterstaff|cudgel/i.test(name)) key = 'staff';  // staff out of the polearm bucket
  if (!key) return null;
  return { file: WEAPONS[key].file, bone: 'WristR', mult: WEAPONS[key].mult };
}

/** A round shield on WristL when one is worn and the main weapon isn't 2H. */
function pickShield(character) {
  const off = character?.equipment?.offhand?.name || '';
  if (character?.equipment?.mainhand?.twoHanded) return null;
  return /shield|buckler|aegis/i.test(off) ? { file: SHIELD.file, bone: 'WristL', mult: SHIELD.mult } : null;
}

/**
 * @param {object} character - parsed character (ddb-parser shape).
 * @returns {object} a compose() spec: { base, body, tint, weapon, shield, clips, placeholder, gaps, source }.
 */
export function loadoutForCharacter(character) {
  const b = pickBody(character);
  const body = BODIES[b.key];
  return {
    base: `${BASE}/${body.file}`,          // the GLB whose rig+clips drive everything
    body: { file: `${BASE}/${body.file}`, prefix: body.prefix },
    tint: b.tint,
    weapon: withBase(pickWeapon(character)),
    shield: withBase(pickShield(character)),
    clips: { idle: 'Idle', attack: 'Sword_Slash' },   // matched by suffix after "CharacterArmature|"
    placeholder: b.placeholder,
    gaps: b.gaps,
    source: 'modular'
  };
}

function withBase(w) { return w ? { ...w, url: `${BASE}/${w.file}` } : null; }

/** True when the character's body set resolves to a hosted GLB (guards the
 *  dispatcher: fall back to the KayKit archetype backend if it can't compose). */
export function canComposeModular(character) {
  return !!BODIES[pickBody(character).key];
}
