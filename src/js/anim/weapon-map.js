/**
 * Weapon → 3D mesh selection (Path B, roster upgrade).
 *
 * Today every archetype in three-viewer.js hard-codes ONE weapon, so a
 * warhammer cleric, a mace cleric and a longsword cleric all hold the same
 * knight sword. This module instead reads the character's ACTUAL equipped
 * primary weapon and picks the nearest available KayKit mesh — a greataxe
 * barbarian gets an axe, a rapier rogue gets a blade, a quarterstaff wizard
 * gets a staff.
 *
 * REUSE, don't reinvent: weapon classification goes through the app's
 * canonical `motionForWeapon` (src/js/anim/weapon-motions.js) — the same
 * heuristic the 2D cinema/swing path already uses. The motion id becomes the
 * key into a small, data-driven `MOTION_TO_MESH` table; a thin name-refine
 * pass then splits the coarse `axe-cleave` / `lance-thrust` motion buckets
 * into "true match" vs "haft placeholder" where the mesh set is too small to
 * distinguish them.
 *
 * The available KayKit CC0 mesh set (public/assets/3d/): sword_1handed,
 * axe_2handed, dagger, staff, shield_round. Everything else is a documented
 * GAP (see MESH_GAPS) — hammers/maces, bows/crossbows and spears/polearms
 * have no faithful mesh yet and resolve to an honest, flagged placeholder.
 *
 * Pure function. No three.js, no I/O — returns a plain descriptor the viewer
 * consumes.
 */

import { motionForWeapon } from './weapon-motions.js';
import { archetypeForCharacter, archetypePreferences, BASE_ARCHETYPES } from './archetype-select.js';

const BONE_R = 'handslotr';   // KayKit sanitised 'handslot.r' — main hand
const BONE_L = 'handslotl';   // 'handslot.l' — off hand (shield)

/**
 * The physical meshes on disk. `twoHanded` gates the off-hand shield (you
 * can't hold a shield with a greataxe). `scale`/`offset` are left null —
 * KayKit weapons are authored to the same grip and need no per-weapon fixup
 * today; the fields exist so a future tuning pass can fill them without a
 * schema change.
 * @type {Object<string, {url:string, bone:string, twoHanded:boolean, scale:(number|null), offset:(number[]|null)}>}
 */
export const MESHES = {
  sword_1handed: { url: 'sword_1handed.gltf', bone: BONE_R, twoHanded: false, scale: null, offset: null, rot: null },
  axe_2handed:   { url: 'axe_2handed.gltf',   bone: BONE_R, twoHanded: true,  scale: null, offset: null, rot: null },
  dagger:        { url: 'dagger.gltf',        bone: BONE_R, twoHanded: false, scale: null, offset: null, rot: null },
  staff:         { url: 'staff.gltf',         bone: BONE_R, twoHanded: true,  scale: null, offset: null, rot: null },
  shield_round:  { url: 'shield_round.gltf',  bone: BONE_L, twoHanded: false, scale: null, offset: null, rot: null },
  // Foreign CC0 props (Quaternius) — authored to a different grip than the
  // KayKit set, so they carry an explicit scale/offset/rot fixup for the
  // KayKit hand bone (tuned live). These close the blunt + ranged gaps.
  hammer:        { url: 'hammer.glb', bone: BONE_R, twoHanded: false, scale: 0.9,  offset: [0, 0.02, 0], rot: [0, 0, 0] },
  bow:           { url: 'bow.glb',    bone: BONE_R, twoHanded: true,  scale: 0.9,  offset: [0, 0, 0],    rot: [0, 0, 0] }
};

/**
 * Recommended KayKit attack clip per motion bucket. These are CANDIDATES —
 * three-viewer's `pick()` already substring-matches and falls back to
 * clips[0], and clip sets differ across the four GLBs, so a miss degrades
 * gracefully rather than throwing.
 */
const MOTION_TO_CLIP = {
  'sword-slash':  '1H_Melee_Attack_Slice_Diagonal',
  'sword-thrust': '1H_Melee_Attack_Stab',
  'dagger-stab':  '1H_Melee_Attack_Stab',
  'axe-cleave':   '2H_Melee_Attack_Chop',
  'lance-thrust': '2H_Melee_Attack_Stab',
  'staff-cast':   'Spellcasting',
  'bow-draw':     '1H_Ranged_Shoot',
  'fist-jab':     'Unarmed_Melee_Attack_Punch_A'
};

/**
 * Primary table: canonical `motionForWeapon` id → mesh selection. Keyed on
 * the APP taxonomy so there's a single source of truth. `mesh:null` means
 * "no faithful mesh" and triggers the archetype fallback. `refine` marks
 * buckets that a name pass splits further (blunt vs bladed, staff vs spear).
 * @type {Object<string, {mesh:(string|null), gap:(string|null), refine:(string|null)}>}
 */
export const MOTION_TO_MESH = {
  'sword-slash':  { mesh: 'sword_1handed', gap: null,      refine: null },
  'sword-thrust': { mesh: 'sword_1handed', gap: null,      refine: null },   // rapier / estoc lunge
  'dagger-stab':  { mesh: 'dagger',        gap: null,      refine: null },
  'axe-cleave':   { mesh: 'axe_2handed',   gap: null,      refine: 'blunt' }, // split axe vs hammer/mace
  'lance-thrust': { mesh: 'staff',         gap: 'polearm', refine: 'haft' },  // split quarterstaff vs spear
  'staff-cast':   { mesh: 'staff',         gap: null,      refine: null },
  'bow-draw':     { mesh: 'bow',           gap: null,      refine: null },    // KayKit hand + Quaternius bow
  'fist-jab':     { mesh: null,            gap: null,      refine: null }     // empty hands
};

/** Names inside the coarse `axe-cleave` bucket that are NOT axes — blunt
 *  hafted weapons with no faithful mesh. They resolve to the staff shaft as
 *  an honest placeholder (gap: 'blunt'). */
const BLUNT_NAME = /hammer|mace|maul|morningstar|morning star|flail|\bpick\b|club/i;
/** True axes inside `axe-cleave` — these DO have a faithful mesh. */
const AXE_NAME = /axe/i;
/** Names inside `lance-thrust` that are a genuine staff (no gap) vs a
 *  spear/polearm (gap: 'polearm', staff shaft placeholder). */
const STAFF_NAME = /quarterstaff|quarter staff|\bstaff\b|\bbo\b|bostaff|cudgel/i;

/**
 * Which mesh a given archetype falls back to when the character has no
 * usable weapon mesh (empty hands, or a gap weapon like a bow). Mirrors the
 * spirit of the old per-archetype hard-coded weapon, but only as a LAST
 * resort. `null` = show empty hands (monk / unarmed).
 */
export const ARCHETYPE_FALLBACK_MESH = {
  knight:    'sword_1handed',
  paladin:   'sword_1handed',
  fighter:   'sword_1handed',
  cleric:    'staff',
  barbarian: 'axe_2handed',
  mage:      'staff',
  druid:     'staff',
  rogue:     'dagger',
  ranger:    'dagger',
  monk:      null,          // unarmed reads best with empty hands
  artificer: 'sword_1handed',
  bard:      'sword_1handed'
};

/** Human-readable catalogue of the weapon TYPES with no faithful mesh yet —
 *  surfaced so the roster can prioritise which GLBs to acquire next. */
export const MESH_GAPS = {
  polearm: 'spear / halberd / glaive / pike / lance / trident — no polearm mesh; using the staff shaft. Acquire a spear + halberd GLB.'
};

/** Off-hand shield detection — mirrors lpc-config.js pickShield's name test. */
function hasShield(character) {
  const name = String(character?.equipment?.offhand?.name || '').toLowerCase();
  return /shield|buckler|aegis/.test(name);
}

/**
 * Resolve the `axe-cleave` / `lance-thrust` refine buckets to a concrete
 * mesh + gap by inspecting the weapon name.
 * @returns {{ mesh:string, gap:(string|null), placeholder:boolean }}
 */
function refineBucket(refine, weaponName) {
  const name = String(weaponName || '');
  if (refine === 'blunt') {
    if (AXE_NAME.test(name)) return { mesh: 'axe_2handed', gap: null, placeholder: false };
    if (BLUNT_NAME.test(name)) return { mesh: 'hammer', gap: null, placeholder: false }; // faithful warhammer/mace
    return { mesh: 'axe_2handed', gap: null, placeholder: false };   // default axe bucket
  }
  if (refine === 'haft') {
    if (STAFF_NAME.test(name)) return { mesh: 'staff', gap: null, placeholder: false };   // true quarterstaff
    return { mesh: 'staff', gap: 'polearm', placeholder: true };      // spear/halberd placeholder
  }
  return { mesh: MOTION_TO_MESH[refine]?.mesh || 'sword_1handed', gap: null, placeholder: false };
}

/**
 * @typedef {object} WeaponMeshSelection
 * @property {(object|null)} weapon    The resolved primary weapon record, or null.
 * @property {(string|null)} motion    The `motionForWeapon` id (app taxonomy), or null.
 * @property {(string|null)} meshKey   MESHES key for the main-hand mesh, or null (empty hands).
 * @property {(object|null)} mesh      The MESHES entry {url,bone,twoHanded,...}, or null.
 * @property {(object|null)} offhand   MESHES.shield_round when a shield is worn (and main hand is 1H), else null.
 * @property {string}        attack    Recommended attack-clip name (a candidate; pick() falls back).
 * @property {boolean}       placeholder  true when the mesh is an honest approximation, not a faithful match.
 * @property {(string|null)} gap       Missing-mesh category: 'blunt' | 'polearm' | 'ranged' | null.
 * @property {string}        archetype The archetype key used (for fallback + clip context).
 * @property {string}        source    'weapon' (from equipped weapon) | 'archetype-fallback' (gap/empty→default) | 'empty' (bare hands).
 */

/**
 * Pick the best available 3D weapon mesh for a character's ACTUAL equipped
 * primary weapon, with an honest per-archetype fallback.
 *
 * @param {object} character - parsed character (ddb-parser shape:
 *   `character.equipment.mainhand.{name,twoHanded,...}`, `character.classes`).
 * @param {{ available?: Set<string> }} [opts] - forwarded to
 *   `archetypeForCharacter` so the fallback respects the loaded roster.
 * @returns {WeaponMeshSelection}
 */
export function weaponMeshForCharacter(character, { available = BASE_ARCHETYPES } = {}) {
  const archetype = archetypeForCharacter(character, { available });
  const weapon = character?.equipment?.mainhand || null;
  const motion = weapon ? motionForWeapon(weapon) : null;

  // Off-hand shield is gated on the WEAPON's grip, not the (possibly
  // placeholder) mesh's — a one-handed warhammer rendered as a staff shaft
  // should still carry a shield. `weapon.twoHanded` is set by the parser.
  const twoHandedWeapon = !!weapon?.twoHanded;
  const buildOffhand = () =>
    (!twoHandedWeapon && hasShield(character)) ? MESHES.shield_round : null;

  // The empty-hands / gap fallback follows the character's TRUE class ideal
  // (preferences[0]), not the collapsed model key — so a monk with no model
  // still resolves to empty hands even though it loads the rogue rig.
  const idealKey = archetypePreferences(character)[0];
  const fallback = (reason) => {
    // `in` check so an EXPLICIT null (monk = intentional empty hands) wins
    // over falling through to the collapsed archetype's default weapon.
    const key = idealKey in ARCHETYPE_FALLBACK_MESH
      ? ARCHETYPE_FALLBACK_MESH[idealKey]
      : (ARCHETYPE_FALLBACK_MESH[archetype] ?? null);
    const mesh = key ? MESHES[key] : null;
    return {
      weapon, motion,
      meshKey: key, mesh,
      offhand: buildOffhand(),
      attack: (motion && MOTION_TO_CLIP[motion]) || MOTION_TO_CLIP['sword-slash'],
      placeholder: reason !== 'empty' && key != null,
      gap: reason === 'ranged' ? 'ranged' : null,
      archetype,
      source: key ? 'archetype-fallback' : 'empty'
    };
  };

  // No weapon in hand → archetype fallback (or honest empty hands for monks).
  if (!motion) return fallback('empty');

  const rule = MOTION_TO_MESH[motion];
  // Motion with no faithful mesh (bow) → archetype fallback, flagged as a gap.
  if (!rule || rule.mesh === null) {
    if (motion === 'fist-jab') return fallback('empty');
    return fallback(rule?.gap || 'ranged');
  }

  // Resolve the refine buckets (axe vs hammer, staff vs spear); simple
  // buckets pass straight through.
  const resolved = rule.refine
    ? refineBucket(rule.refine, weapon?.name)
    : { mesh: rule.mesh, gap: rule.gap, placeholder: false };

  const mesh = MESHES[resolved.mesh];
  return {
    weapon, motion,
    meshKey: resolved.mesh, mesh,
    offhand: buildOffhand(),
    attack: MOTION_TO_CLIP[motion] || MOTION_TO_CLIP['sword-slash'],
    placeholder: resolved.placeholder,
    gap: resolved.gap,
    archetype,
    source: 'weapon'
  };
}
