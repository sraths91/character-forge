import { inferAppearanceTraits } from './appearance-parser.js';

/**
 * LPC v2 spritesheet configuration.
 *
 * Each animation is its own PNG. Two layouts:
 *   - idle.png:  128x256 — 2 frames × 4 directions (N/W/S/E rows, 64x64)
 *   - walk.png:  576x256 — 9 frames × 4 directions
 *
 * For a static front portrait we render frame 0 of the south row:
 *   sx = 0, sy = 128, sw = 64, sh = 64  (works for both layouts)
 */

export const FRAME = 64;

/**
 * Phase D — direction support. The south row (y=128 for 64×64 sheets, y=256
 * for 128×128 walk_128 sheets) was previously hard-coded everywhere. This
 * map gives the row-y offset per direction for both layouts.
 */
export const DIRECTIONS = ['north', 'west', 'south', 'east'];
const ROW_OFFSET_64  = { north: 0, west: 64,  south: 128, east: 192 };
const ROW_OFFSET_128 = { north: 0, west: 128, south: 256, east: 384 };

/** Standard 64×64 cell, frame 0 of the requested direction's row. */
function defaultFrame(direction) {
  return { sx: 0, sy: ROW_OFFSET_64[direction] ?? 128, sw: FRAME, sh: FRAME };
}

/** Walk-128 layout (1664×512 sheets like bow/katana): 128×128 cells. */
function walk128Frame(direction) {
  return { sx: 0, sy: ROW_OFFSET_128[direction] ?? 256, sw: 128, sh: 128 };
}

/**
 * Per-asset frame overrides. Each entry is either:
 *   - a direction → frame function (used for sheets with non-standard layout)
 *   - a static frame object (legacy; used when the sheet has only one usable
 *     frame, e.g. club.png which we hand-picked a south-facing cell from)
 *
 * Override entries that return a function support all 4 directions. Static
 * objects are always returned as-is — caller may render the wrong direction
 * cosmetically but won't crash. Documented south-only assets:
 *   - club.png: south-only override; non-south falls through to the same cell
 */
export const FRAME_OVERRIDES = {
  '/assets/lpc/weapon/bow.png':           walk128Frame,
  '/assets/lpc/weapon/dragonspear.png':   walk128Frame,
  '/assets/lpc/weapon/katana.png':        walk128Frame,
  '/assets/lpc/weapon/longspear.png':     walk128Frame,
  '/assets/lpc/weapon/longsword_alt.png': walk128Frame,
  '/assets/lpc/weapon/scimitar.png':      walk128Frame,
  '/assets/lpc/weapon/trident.png':       walk128Frame,
  '/assets/lpc/weapon/club.png':          { sx: 768, sy: 256, sw: 128, sh: 128 }
};

/**
 * Resolve the source-frame coords for an asset URL at the requested
 * direction and frame index. frameIdx shifts sx by frameIdx*sw — the
 * caller is responsible for clamping to the asset's actual frame count
 * (img.width / sw). Defaults: south, frame 0.
 *
 * Static overrides (the club, drawn from a hand-picked cell) ignore
 * frameIdx — those are permanently non-animated.
 */
export function getFrame(src, direction = 'south', frameIdx = 0) {
  const override = FRAME_OVERRIDES[src];
  if (typeof override === 'function') {
    const base = override(direction);
    return { ...base, sx: base.sx + frameIdx * base.sw };
  }
  if (override) return override;
  const base = defaultFrame(direction);
  return { ...base, sx: base.sx + frameIdx * base.sw };
}

// Legacy POSE export kept for backward compat (any external code that imported it).
export const POSE = {
  southIdle: defaultFrame('south')
};

/**
 * Layer draw order. Capes draw behind the body; weapons, shields, helmets,
 * and accessories draw on top of the torso.
 */
export const LAYER_ORDER = [
  'cape-behind',
  'backpack',      // Phase C — pack on back; mutually exclusive with back-weapon
  'back-weapon',   // overflow weapon strapped to back (drawn behind body)
  'body',
  'head',          // LPC v2 bodies are headless — head is a separate sprite
  'eyes',          // Phase D3 — drawn over face area
  'hair',          // Phase D3 — drawn over head (helms hide)
  'beard',         // Phase D3 — drawn over chin (full-face helms hide)
  'facial',        // Phase D3 — glasses / eyepatch on top of face
  'legs',
  'feet',
  'torso',
  'waist',
  'waist-weapon',  // overflow weapon at the hip (procedural-only for v1)
  'amulet',
  'gloves',
  'arms',
  'helm',
  'quiver',
  'offhand',
  'mainhand',
  'effects'
];

const ASSETS = '/assets/lpc';

export const ASSET_MAP = {
  body: {
    male:     `${ASSETS}/body/male.png`,
    female:   `${ASSETS}/body/female.png`,
    teen:     `${ASSETS}/body/teen.png`,
    // M3 — monster-friendly bodies. skeleton + zombie are pulled from
    // their walk sheets (we use frame 0 of the south row); muscular is
    // a beefier male variant used by orcs/trolls/minotaurs.
    muscular: `${ASSETS}/body/muscular.png`,
    skeleton: `${ASSETS}/body/skeleton.png`,
    zombie:   `${ASSETS}/body/zombie.png`
  },

  head: {
    human:    { male: `${ASSETS}/head/heads/human_male.png`, female: `${ASSETS}/head/heads/human_female.png` },
    goblin:   { male: `${ASSETS}/head/heads/goblin.png`,     female: `${ASSETS}/head/heads/goblin.png` },
    lizard:   { male: `${ASSETS}/head/heads/lizard_male.png`, female: `${ASSETS}/head/heads/lizard_female.png` },
    // M3 — monster heads. Most have a single sheet that we use for both
    // genders (the heads are bald/scaly/etc., gender is irrelevant).
    orc:      { male: `${ASSETS}/head/heads/orc.png`,        female: `${ASSETS}/head/heads/orc.png` },
    troll:    { male: `${ASSETS}/head/heads/troll.png`,      female: `${ASSETS}/head/heads/troll.png` },
    skeleton: { male: `${ASSETS}/head/heads/skeleton.png`,   female: `${ASSETS}/head/heads/skeleton.png` },
    zombie:   { male: `${ASSETS}/head/heads/zombie.png`,     female: `${ASSETS}/head/heads/zombie.png` },
    vampire:  { male: `${ASSETS}/head/heads/vampire.png`,    female: `${ASSETS}/head/heads/vampire.png` },
    wolf:     { male: `${ASSETS}/head/heads/wolf.png`,       female: `${ASSETS}/head/heads/wolf.png` },
    minotaur: { male: `${ASSETS}/head/heads/minotaur.png`,   female: `${ASSETS}/head/heads/minotaur.png` },
    boarman:  { male: `${ASSETS}/head/heads/boarman.png`,    female: `${ASSETS}/head/heads/boarman.png` },
    rat:      { male: `${ASSETS}/head/heads/rat.png`,        female: `${ASSETS}/head/heads/rat.png` }
  },

  legs: {
    pants:    { male: `${ASSETS}/legs/pants_male.png`,    female: `${ASSETS}/legs/pants_female.png` },
    leggings: { male: `${ASSETS}/legs/leggings_male.png`, female: `${ASSETS}/legs/leggings_female.png` },
    skirt:    { male: null,                               female: `${ASSETS}/legs/skirt_belle.png` }
  },

  feet: {
    male:   `${ASSETS}/feet/shoes_male.png`,
    female: `${ASSETS}/feet/shoes_female.png`
  },

  // Torso variants. Caster wardrobes (robe/tunic) are female-only in LPC;
  // male casters fall back to cloth (longsleeve).
  torso: {
    plate:   { male: `${ASSETS}/torso/plate_male.png`,   female: `${ASSETS}/torso/plate_female.png` },
    leather: { male: `${ASSETS}/torso/leather_male.png`, female: `${ASSETS}/torso/leather_female.png` },
    // Phase B — segmented/Roman lorica look. Used for chain mail, scale mail,
    // splint mail, ring mail and other "linked plate" D&D armors.
    legion:  { male: `${ASSETS}/torso/legion_male.png`,  female: `${ASSETS}/torso/legion_female.png` },
    cloth:   { male: `${ASSETS}/torso/cloth_male.png`,   female: `${ASSETS}/torso/cloth_female.png` },
    sleeveless: { male: `${ASSETS}/torso/sleeveless_male.png`, female: `${ASSETS}/torso/sleeveless_female.png` },
    robe:    { male: null,                              female: `${ASSETS}/torso/robe_female_brown.png` },
    'robe-purple': { male: null,                        female: `${ASSETS}/torso/robe_female_purple.png` },
    'robe-red':    { male: null,                        female: `${ASSETS}/torso/robe_female_red.png` },
    tunic:   { male: null,                              female: `${ASSETS}/torso/tunic_female.png` }
  },

  // Female-only: dresses are a separate top-level category, drawn as a
  // legs+torso replacement.
  dress: {
    bodice: `${ASSETS}/dress/bodice_blue.png`,
    'bodice-black': `${ASSETS}/dress/bodice_black.png`,
    slit:   `${ASSETS}/dress/slit_red.png`
  },

  waist: {
    'rope-belt': { male: `${ASSETS}/waist/belt_rope_male.png`, female: `${ASSETS}/waist/belt_rope_female.png` }
  },

  helm: {
    spangenhelm: `${ASSETS}/head/spangenhelm.png`,
    barbuta:     `${ASSETS}/head/barbuta.png`,
    sugarloaf:   `${ASSETS}/head/sugarloaf.png`,
    hood:        `${ASSETS}/head/hood.png`,
    wizard:      `${ASSETS}/head/wizard.png`,
    celestial:   `${ASSETS}/head/celestial.png`,
    // Phase B additions
    greathelm:   `${ASSETS}/head/greathelm.png`,
    armet:       `${ASSETS}/head/armet.png`,
    kettle:      `${ASSETS}/head/kettle.png`,
    horned:      `${ASSETS}/head/horned.png`,
    nasal:       `${ASSETS}/head/nasal.png`,
    mail_coif:   `${ASSETS}/head/mail_coif.png`,
    bascinet:    `${ASSETS}/head/bascinet.png`,
    leather_cap: `${ASSETS}/head/leather_cap.png`
  },

  shield: {
    heater: `${ASSETS}/shield/heater.png`,
    round:  `${ASSETS}/shield/round.png`,
    kite:   `${ASSETS}/shield/kite.png`,
    // Phase B additions
    scutum:   `${ASSETS}/shield/scutum.png`,    // tower shield (rectangular)
    crusader: `${ASSETS}/shield/crusader.png`,  // heater w/ red cross (paladin)
    spartan:  `${ASSETS}/shield/spartan.png`    // small round wooden (warrior)
  },

  weapon: {
    longsword:     `${ASSETS}/weapon/longsword.png`,
    dagger:        `${ASSETS}/weapon/dagger.png`,
    rapier:        `${ASSETS}/weapon/rapier.png`,
    club:          `${ASSETS}/weapon/club.png`,
    mace:          `${ASSETS}/weapon/mace.png`,
    halberd:       `${ASSETS}/weapon/halberd.png`,
    spear:         `${ASSETS}/weapon/spear.png`,
    bow:           `${ASSETS}/weapon/bow.png`,
    // Phase A1 additions
    arming:        `${ASSETS}/weapon/arming.png`,
    glowsword:     `${ASSETS}/weapon/glowsword.png`,
    katana:        `${ASSETS}/weapon/katana.png`,
    longsword_alt: `${ASSETS}/weapon/longsword_alt.png`,
    saber:         `${ASSETS}/weapon/saber.png`,
    scimitar:      `${ASSETS}/weapon/scimitar.png`,
    flail:         `${ASSETS}/weapon/flail.png`,
    waraxe:        `${ASSETS}/weapon/waraxe.png`,
    cane:          `${ASSETS}/weapon/cane.png`,
    dragonspear:   `${ASSETS}/weapon/dragonspear.png`,
    longspear:     `${ASSETS}/weapon/longspear.png`,
    scythe:        `${ASSETS}/weapon/scythe.png`,
    trident:       `${ASSETS}/weapon/trident.png`,
    // Phase A2 — ranged + magic foci
    crossbow:      `${ASSETS}/weapon/crossbow.png`,
    slingshot:     `${ASSETS}/weapon/slingshot.png`,
    staff_crystal: `${ASSETS}/weapon/staff_crystal.png`,
    staff_diamond: `${ASSETS}/weapon/staff_diamond.png`,
    staff_gnarled: `${ASSETS}/weapon/staff_gnarled.png`,
    staff_loop:    `${ASSETS}/weapon/staff_loop.png`,
    staff_simple:  `${ASSETS}/weapon/staff_simple.png`,
    wand:          `${ASSETS}/weapon/wand.png`
  },

  weaponBack: {
    longsword: `${ASSETS}/weapon-back/longsword.png`,
    rapier:    `${ASSETS}/weapon-back/rapier.png`,
    mace:      `${ASSETS}/weapon-back/mace.png`,
    // Phase A1 — bespoke universal_behind (or behind/) art shipped by LPC
    glowsword: `${ASSETS}/weapon-back/glowsword.png`,
    saber:     `${ASSETS}/weapon-back/saber.png`,
    scythe:    `${ASSETS}/weapon-back/scythe.png`,
    flail:     `${ASSETS}/weapon-back/flail.png`,
    waraxe:    `${ASSETS}/weapon-back/waraxe.png`,
    // Phase A2
    slingshot: `${ASSETS}/weapon-back/slingshot.png`
  },

  cape: {
    red:      `${ASSETS}/cape/red.png`,
    blue:     `${ASSETS}/cape/blue.png`,
    // Phase C — 8 additional colors for class/role variety
    black:    `${ASSETS}/cape/black.png`,
    white:    `${ASSETS}/cape/white.png`,
    green:    `${ASSETS}/cape/green.png`,
    purple:   `${ASSETS}/cape/purple.png`,
    gray:     `${ASSETS}/cape/gray.png`,
    navy:     `${ASSETS}/cape/navy.png`,
    brown:    `${ASSETS}/cape/brown.png`,
    charcoal: `${ASSETS}/cape/charcoal.png`,
    // Phase F4 — tattered variants for Squalid/Wretched lifestyles
    tattered_brown:    `${ASSETS}/cape/tattered_brown.png`,
    tattered_charcoal: `${ASSETS}/cape/tattered_charcoal.png`
  },

  quiver: {
    default: `${ASSETS}/quiver/quiver.png`
  },

  // Phase C/D2 — Backpack (new slot). Two art layers per style:
  //   - 'straps' renders from all 4 directions (shoulder straps visible
  //     from front). Used for the south view.
  //   - 'full' is the proper pack shape (adventurer = round bag,
  //     scholar = square crate-pack). Empty in the south row, so it's
  //     used only for north/west/east views.
  // buildRenderPlan picks the variant based on render direction.
  backpack: {
    adventurer: {
      straps: { male: `${ASSETS}/backpack/straps_adventurer_male.png`, female: `${ASSETS}/backpack/straps_adventurer_female.png` },
      full:   { male: `${ASSETS}/backpack/full_adventurer_male.png`,   female: `${ASSETS}/backpack/full_adventurer_female.png` }
    },
    scholar: {
      straps: { male: `${ASSETS}/backpack/straps_scholar_male.png`, female: `${ASSETS}/backpack/straps_scholar_female.png` },
      full:   { male: `${ASSETS}/backpack/full_scholar_male.png`,   female: `${ASSETS}/backpack/full_scholar_female.png` }
    }
  },

  arms: {
    bracers:   { male: `${ASSETS}/arms/bracers_male.png`,    female: `${ASSETS}/arms/bracers_female.png` },
    gauntlets: { male: `${ASSETS}/arms/gauntlets_male.png`,  female: `${ASSETS}/arms/gauntlets_female.png` }
  },

  gloves: {
    cloth: { male: `${ASSETS}/arms/gloves_male.png`, female: `${ASSETS}/arms/gloves_female.png` }
  },

  amulet: {
    cross: { male: `${ASSETS}/neck/amulet_male.png`, female: `${ASSETS}/neck/amulet_female.png` },
    // Phase C — additional neck variants. The slot key stays 'amulet' for
    // backward compat with character.equipment.amulet; the variant is chosen
    // by pickNeck() based on the item name.
    chain: { male: `${ASSETS}/neck/chain_male.png`, female: `${ASSETS}/neck/chain_female.png` },
    charm: { male: `${ASSETS}/neck/charm_male.png`, female: `${ASSETS}/neck/charm_female.png` },
    gem:   { male: `${ASSETS}/neck/gem_male.png`,   female: `${ASSETS}/neck/gem_female.png` }
  },

  // Phase D3 — face & hair layering
  hair: {
    buzzcut: `${ASSETS}/hair/buzzcut.png`,
    long:    `${ASSETS}/hair/long.png`,
    spiked:  `${ASSETS}/hair/spiked.png`,
    bedhead: `${ASSETS}/hair/bedhead.png`,
    balding: `${ASSETS}/hair/balding.png`,
    bob:     `${ASSETS}/hair/bob.png`,
    afro:    `${ASSETS}/hair/afro.png`
  },

  beard: {
    basic:     `${ASSETS}/beards/beard_basic.png`,
    medium:    `${ASSETS}/beards/beard_medium.png`,
    winter:    `${ASSETS}/beards/beard_winter.png`,
    mustache:  `${ASSETS}/beards/mustache_handlebar.png`
  },

  facial: {
    glasses:  `${ASSETS}/facial/glasses_round.png`,
    eyepatch: `${ASSETS}/facial/eyepatch.png`
  },

  eyes: {
    blue:  `${ASSETS}/eyes/blue.png`,
    brown: `${ASSETS}/eyes/brown.png`,
    green: `${ASSETS}/eyes/green.png`,
    gray:  `${ASSETS}/eyes/gray.png`
  }
};

/**
 * Phase D3 — hair color via ctx.filter. LPC ships hair sprites in a single
 * base color (brown). For variety we apply a CSS filter at render time. This
 * is good enough to read as "different hair color" but isn't pixel-perfect
 * — multi-color natively would require a build-time recoloring step. Same
 * filter set works for beards.
 */
export const HAIR_COLOR_FILTERS = {
  brown:  null,  // base sprite color
  black:  'brightness(0.4) saturate(0.6)',
  blonde: 'hue-rotate(20deg) brightness(1.55) saturate(1.4)',
  red:    'hue-rotate(-20deg) saturate(1.6) brightness(0.95)',
  gray:   'saturate(0) brightness(1.05)',
  white:  'saturate(0) brightness(1.5)'
};

/** Helms that fully cover the face — these hide BOTH hair and beard. */
const FULL_FACE_HELMS = new Set(['greathelm', 'armet', 'sugarloaf', 'barbuta', 'bascinet']);
/** Helms that cover the top of the head only — hide hair, keep beard visible. */
const TOP_OF_HEAD_HELMS = new Set([
  'spangenhelm', 'nasal', 'kettle', 'horned', 'mail_coif',
  'leather_cap', 'hood', 'wizard', 'celestial'
]);

/**
 * Pose data for `kind: 'derived-item'` layers — derive sheathed/strapped
 * weapon visuals from the existing mainhand sprites by cropping to the
 * weapon's bounding box and re-drawing rotated + scaled at a target anchor.
 *
 * Coordinates are in 64×64 frame space; the compositor scales them up.
 * `rotate` is degrees (negative = counter-clockwise).
 * `anchor` is the centre point in the target frame for the cropped weapon.
 */
export const BACK_DERIVED_POSES = {
  longsword: { rotate: -45, scale: 0.75, anchor: { x: 32, y: 16 } },
  rapier:    { rotate: -45, scale: 0.75, anchor: { x: 32, y: 19 } },
  dagger:    { rotate: -45, scale: 0.95, anchor: { x: 30, y: 18 } },
  mace:      { rotate: -45, scale: 0.95, anchor: { x: 32, y: 16 } },
  club:      { rotate: -30, scale: 0.85, anchor: { x: 32, y: 16 } },
  halberd:   { rotate: -50, scale: 0.65, anchor: { x: 32, y: 14 } },
  spear:     { rotate: -50, scale: 0.65, anchor: { x: 32, y: 14 } },
  bow:       { rotate: -75, scale: 0.85, anchor: { x: 32, y: 14 } },
  // Phase A1 — starter values cloned from the closest existing weapon. Tune
  // visually via debug.html before shipping. Wand/cane are mainhand-only.
  arming:        { rotate: -45, scale: 0.75, anchor: { x: 32, y: 16 } },
  glowsword:     { rotate: -45, scale: 0.75, anchor: { x: 32, y: 16 } },
  katana:        { rotate: -45, scale: 0.75, anchor: { x: 32, y: 16 } },
  longsword_alt: { rotate: -45, scale: 0.75, anchor: { x: 32, y: 16 } },
  saber:         { rotate: -45, scale: 0.75, anchor: { x: 32, y: 16 } },
  scimitar:      { rotate: -45, scale: 0.75, anchor: { x: 32, y: 16 } },
  flail:         { rotate: -45, scale: 0.95, anchor: { x: 32, y: 16 } },
  waraxe:        { rotate: -45, scale: 0.85, anchor: { x: 32, y: 16 } },
  scythe:        { rotate: -50, scale: 0.65, anchor: { x: 32, y: 14 } },
  dragonspear:   { rotate: -50, scale: 0.65, anchor: { x: 32, y: 14 } },
  longspear:     { rotate: -50, scale: 0.65, anchor: { x: 32, y: 14 } },
  trident:       { rotate: -50, scale: 0.65, anchor: { x: 32, y: 14 } },
  // Phase A2 — ranged. Staves and wand are mainhand-only (no back sheath).
  crossbow:      { rotate: -75, scale: 0.85, anchor: { x: 32, y: 14 } },
  slingshot:     { rotate: -75, scale: 0.70, anchor: { x: 32, y: 16 } }
};

/**
 * Waist poses — only weapons that physically fit at a hip get a derived
 * sprite. Bow/halberd/spear at waist fall through to a procedural rect
 * (these belong on the back; rect is a placeholder if the user manually
 * assigns one to waist).
 */
export const WAIST_DERIVED_POSES = {
  longsword: { rotate: 90, scale: 0.50, anchor: { x: 18, y: 38 } },
  rapier:    { rotate: 90, scale: 0.50, anchor: { x: 18, y: 38 } },
  dagger:    { rotate: 90, scale: 0.65, anchor: { x: 20, y: 38 } },
  mace:      { rotate: 90, scale: 0.45, anchor: { x: 18, y: 38 } },
  club:      { rotate: 90, scale: 0.55, anchor: { x: 18, y: 38 } },
  // Phase A1 — only weapons that physically fit at a hip get a waist pose.
  // Polearms (scythe/spears/trident) and two-handed weapons fall back to a
  // procedural rect when assigned to waist.
  arming:        { rotate: 90, scale: 0.50, anchor: { x: 18, y: 38 } },
  glowsword:     { rotate: 90, scale: 0.50, anchor: { x: 18, y: 38 } },
  katana:        { rotate: 90, scale: 0.50, anchor: { x: 18, y: 38 } },
  longsword_alt: { rotate: 90, scale: 0.50, anchor: { x: 18, y: 38 } },
  saber:         { rotate: 90, scale: 0.50, anchor: { x: 18, y: 38 } },
  scimitar:      { rotate: 90, scale: 0.50, anchor: { x: 18, y: 38 } },
  flail:         { rotate: 90, scale: 0.45, anchor: { x: 18, y: 38 } },
  waraxe:        { rotate: 90, scale: 0.50, anchor: { x: 18, y: 38 } },
  cane:          { rotate: 90, scale: 0.55, anchor: { x: 18, y: 38 } }
};

export const SLOT_COLORS = {
  helm: '#71717a',
  mainhand: '#e2e8f0',
  offhand: '#a16207',
  cloak: '#7c3aed',
  gloves: '#92400e',
  belt: '#854d0e',
  amulet: '#fbbf24',
  'back-weapon':  '#94a3b8',
  'waist-weapon': '#94a3b8',
  effects: 'rgba(99,102,241,0.45)'
};

export const SLOT_BOXES = {
  helm:    { x: 22, y: 12, w: 20, h: 12 },
  mainhand:{ x: 44, y: 28, w: 6,  h: 24 },
  offhand: { x: 12, y: 28, w: 14, h: 18 },
  cloak:   { x: 18, y: 22, w: 28, h: 26 },
  belt:    { x: 18, y: 38, w: 28, h: 4 },
  gloves:  { x: 16, y: 28, w: 6,  h: 8 },
  amulet:  { x: 28, y: 22, w: 8,  h: 4 },
  'back-weapon':  { x: 24, y: 4,  w: 16, h: 22 },
  'waist-weapon': { x: 14, y: 38, w: 8,  h: 4 }
};

/**
 * Skin tone profiles applied via ctx.filter on the body layer only.
 * The filter is reset before drawing clothing/equipment layers, so only
 * the body PNG is recoloured.
 */
export const SKIN_TONES = {
  light:  null,
  pale:   'saturate(0.65) brightness(1.06)',
  tan:    'hue-rotate(8deg) saturate(1.1) brightness(0.9)',
  olive:  'hue-rotate(20deg) saturate(0.85) brightness(0.78)',
  dark:   'hue-rotate(15deg) saturate(0.9) brightness(0.55)',
  ashen:  'saturate(0.15) brightness(0.7)',
  green:  'hue-rotate(80deg) saturate(0.7) brightness(0.85)',
  red:    'hue-rotate(-20deg) saturate(1.4) brightness(0.78)',
  blue:   'hue-rotate(170deg) saturate(0.85) brightness(0.85)'
};

/**
 * Map a race name to a default skin tone. Players can override via UI later.
 */
export function inferSkinTone(character) {
  // Phase E1 — parsed free-text appearance wins over race default
  const fromText = inferAppearanceTraits(character).skin;
  if (fromText && SKIN_TONES[fromText] !== undefined) return fromText;
  const name = String(character.race?.name || character.race?.base || '').toLowerCase();
  if (name.includes('drow') || name.includes('dark elf') || name.includes('duergar')) return 'ashen';
  if (name.includes('orc') || name.includes('hobgoblin') || name.includes('goblin') || name.includes('bugbear')) return 'green';
  if (name.includes('tiefling')) return 'red';
  if (name.includes('triton') || name.includes('sea elf')) return 'blue';
  if (name.includes('halfling') || name.includes('hill dwarf') || name.includes('gnome')) return 'tan';
  if (name.includes('mountain dwarf')) return 'tan';
  if (name.includes('dragonborn')) return 'olive';
  if (name.includes('aasimar') || name.includes('high elf')) return 'pale';
  return 'light';
}

function pickHeadRace(character) {
  const name = String(character.race?.name || character.race?.base || '').toLowerCase();
  // M3 — monsters set race.name directly to a head ASSET_MAP key
  // (e.g. 'orc', 'troll', 'skeleton'). EXACT match only — substring would
  // wrongly pull "Half-Orc" PC characters into the monster-orc head and
  // suppress their hair (since pickHair gates on 'human').
  for (const key of Object.keys(ASSET_MAP.head)) {
    if (name === key) return key;
  }
  if (name.includes('dragonborn') || name.includes('lizard') || name.includes('kobold')) return 'lizard';
  if (name.includes('goblin') || name.includes('hobgoblin') || name.includes('bugbear')) return 'goblin';
  return 'human';
}

function inferGender(character) {
  const raw = String(character.race?.name || '').toLowerCase();
  if (raw.includes('female') || raw.includes('woman')) return 'female';
  return 'male';
}

function pickTorsoVariant(armor, classes) {
  if (!armor) {
    // Class-driven default for unarmoured characters
    const isCaster = (classes || []).some(c =>
      /wizard|sorcerer|warlock|druid|cleric/i.test(c.name)
    );
    return isCaster ? 'robe' : 'cloth';
  }
  const name = (armor.name || '').toLowerCase();
  // Order matters: 'breastplate' must hit 'plate' branch before 'mail' fallback,
  // and the legion/chain branch must come after plate so "plate mail" routes
  // to plate (not legion).
  if (name.includes('plate') || name.includes('half plate') || name.includes('full plate')) return 'plate';
  if (name.includes('breastplate')) return 'plate';
  // Phase B — chain/scale/splint/ring all route to legion (segmented look).
  if (name.includes('chain mail') || name.includes('chain shirt') ||
      name.includes('scale mail') || name.includes('scale armor') ||
      name.includes('splint') || name.includes('ring mail')) return 'legion';
  if (name.includes('leather') || name.includes('hide') || name.includes('studded')) return 'leather';
  if (name.includes('robe')) return 'robe';
  // Generic 'mail' is intentionally NOT matched here — that catches "Mail Coif"
  // (a helm) and would mis-route. By this point all named-mail-armor variants
  // have already matched above.
  if (name.includes('chain')) return 'legion';
  return 'cloth';
}

function pickHelm(helm, classes) {
  const name = (helm?.name || '').toLowerCase();
  // Order matters: most-specific first. Mail-variants are checked before
  // 'cap' fallback so "Mail Cap" → mail_coif, not leather_cap.
  if (name.includes('mail coif') || name.includes('mail hood') ||
      name.includes('coif') || name.includes('mail cap')) return 'mail_coif';
  if (name.includes('leather cap')) return 'leather_cap';
  // Cloth-style hoods
  if (name.includes('hood') || name.includes('cowl')) return 'hood';
  // Specific named helms (Phase B + existing)
  if (name.includes('greathelm') || name.includes('great helm') || name.includes('bucket helm')) return 'greathelm';
  if (name.includes('sugarloaf')) return 'sugarloaf';
  if (name.includes('barbuta')) return 'barbuta';
  if (name.includes('armet') || name.includes('visored')) return 'armet';
  if (name.includes('bascinet')) return 'bascinet';
  if (name.includes('kettle')) return 'kettle';
  if (name.includes('horned') || name.includes('viking helm') || name.includes('barbarian helm')) return 'horned';
  if (name.includes('nasal')) return 'nasal';
  if (name.includes('cap') || name.includes('skullcap')) return 'leather_cap';
  // Caster helms
  if (name.includes('wizard') || name.includes('mage') || name.includes('arcane')) return 'wizard';
  if (name.includes('celestial') || name.includes('star') || name.includes('moon')) return 'celestial';
  // No specific match — pick by class
  const isCaster = (classes || []).some(c =>
    /wizard|sorcerer|warlock|druid/i.test(c.name)
  );
  if (isCaster) return 'wizard';
  return 'spangenhelm';
}

function pickShield(off) {
  const name = (off?.name || '').toLowerCase();
  if (!name.includes('shield') && !name.includes('buckler') && !name.includes('aegis')) return null;
  // Phase B additions — most specific first
  if (name.includes('tower') || name.includes('scutum')) return 'scutum';
  if (name.includes('paladin') || name.includes('templar') || name.includes('crusader')) return 'crusader';
  if (name.includes('spartan') || name.includes('hoplite')) return 'spartan';
  // Existing
  if (name.includes('kite')) return 'kite';
  if (name.includes('round') || name.includes('buckler')) return 'round';
  return 'heater';
}

/**
 * Substring rules for mapping a D&D 5e weapon name to an LPC sprite key.
 * Order matters: most specific match wins (so "hand crossbow" hits before
 * "crossbow", "warhammer" before "hammer"). All entries are lowercase.
 *
 * Phase A1 expanded the sprite roster from 8 → 21 weapons; this table is
 * the single source of truth for which D&D names get which sprite. Adding
 * a new sprite means appending an entry here and to ASSET_MAP.weapon.
 */
const WEAPON_NAME_RULES = [
  // Magical/named blades — match before generic 'sword'
  ['flame tongue',  'glowsword'],
  ['frost brand',   'glowsword'],
  ['sun blade',     'glowsword'],
  ['moonblade',     'glowsword'],
  ['lightsaber',    'glowsword'],
  ['glowsword',     'glowsword'],

  // Specific sword shapes
  ['katana',        'katana'],
  ['wakizashi',     'katana'],
  ['scimitar',      'scimitar'],
  ['sickle',        'scimitar'],
  ['falchion',      'saber'],
  ['cutlass',       'saber'],
  ['saber',         'saber'],
  ['shortsword',    'arming'],
  ['short sword',   'arming'],
  ['arming sword',  'arming'],
  ['greatsword',    'longsword_alt'],
  ['great sword',   'longsword_alt'],
  ['claymore',      'longsword_alt'],
  ['zweihander',    'longsword_alt'],

  // Specific blunt
  ['warhammer',     'mace'],
  ['war hammer',    'mace'],
  ['maul',          'mace'],
  ['morningstar',   'mace'],
  ['morning star',  'mace'],
  ['light hammer',  'mace'],
  ['war pick',      'mace'],
  ['warpick',       'mace'],
  ['flail',         'flail'],
  ['whip',          'flail'],
  ['battleaxe',     'waraxe'],
  ['battle axe',    'waraxe'],
  ['greataxe',      'waraxe'],
  ['great axe',     'waraxe'],
  ['handaxe',       'waraxe'],
  ['hand axe',      'waraxe'],
  ['waraxe',        'waraxe'],

  // Specific polearms — longest first
  ['dragonspear',   'dragonspear'],
  ['longspear',     'longspear'],
  ['long spear',    'longspear'],
  ['lance',         'longspear'],
  ['pike',          'longspear'],
  ['trident',       'trident'],
  ['scythe',        'scythe'],
  ['glaive',        'halberd'],
  ['halberd',       'halberd'],
  ['javelin',       'spear'],
  ['spear',         'spear'],

  // Sticks and canes (mundane)
  ['cane',          'cane'],
  ['quarterstaff',  'club'],
  ['quarter staff', 'club'],
  ['greatclub',     'club'],
  ['great club',    'club'],

  // Magic foci — must come before generic 'staff' / 'club' so a "Staff of
  // the Magi" gets a magic sprite instead of a wooden club.
  ['gnarled staff', 'staff_gnarled'],
  ['druid staff',   'staff_gnarled'],
  ['druidic focus', 'staff_gnarled'],
  ['crystal staff', 'staff_crystal'],
  ['orb',           'staff_crystal'],
  ['arcane focus',  'staff_crystal'],
  ['diamond staff', 'staff_diamond'],
  ['jeweled staff', 'staff_diamond'],
  ['looped staff',  'staff_loop'],
  ['ring staff',    'staff_loop'],
  ['staff of',      'staff_simple'],
  ['quartersta',    'club'],   // safety: quarterstaff fallback
  ['staff',         'staff_simple'],
  ['rod',           'wand'],
  ['wand',          'wand'],
  ['club',          'club'],

  // Generic sword fallback (after all specific shapes)
  ['rapier',        'rapier'],
  ['dagger',        'dagger'],
  ['dart',          'dagger'],
  ['blade',         'longsword'],
  ['sword',         'longsword'],

  // Ranged — most-specific first so "hand crossbow" beats generic "crossbow",
  // and "longbow"/"shortbow" don't collapse via the bare 'bow' suffix.
  ['hand crossbow',  'crossbow'],
  ['heavy crossbow', 'crossbow'],
  ['light crossbow', 'crossbow'],
  ['crossbow',       'crossbow'],
  ['longbow',        'bow'],
  ['shortbow',       'bow'],
  ['short bow',      'bow'],
  ['long bow',       'bow'],
  ['bow',            'bow'],
  ['sling',          'slingshot'],
  ['slingshot',      'slingshot'],
  ['blowgun',        'slingshot']
];

function pickWeapon(weapon) {
  const name = (weapon?.name || '').toLowerCase();
  if (!name) return null;
  for (const [needle, key] of WEAPON_NAME_RULES) {
    if (name.includes(needle)) return key;
  }
  return null;
}

/**
 * Returns the bespoke `universal_behind`/`behind` art key when LPC ships one,
 * otherwise null — the caller falls back to BACK_DERIVED_POSES (rotated mainhand).
 */
function pickBackWeapon(weapon) {
  const key = pickWeapon(weapon);
  return key && ASSET_MAP.weaponBack[key] ? key : null;
}

/**
 * True for weapons whose ammunition is held in a back-quiver (arrows / bolts).
 * Slings and blowguns are ranged but use bullets/needles — no quiver layer.
 */
function usesArrowQuiver(weapon) {
  if (!weapon) return false;
  const key = pickWeapon(weapon);
  return key === 'bow' || key === 'crossbow';
}

/**
 * Cape color rules — direct color-name match on the cloak's name. Order
 * matters where one color name is a substring of another (e.g., 'navy'
 * before 'blue' so "navy cloak" doesn't match the 'blue' branch).
 */
const CAPE_COLOR_RULES = [
  ['charcoal',  'charcoal'],
  ['navy',      'navy'],
  ['black',     'black'],
  ['white',     'white'],
  ['green',     'green'],
  ['forest',    'green'],
  ['druid',     'green'],
  ['purple',    'purple'],
  ['violet',    'purple'],
  ['royal',     'purple'],
  ['gray',      'gray'],
  ['grey',      'gray'],
  ['shadow',    'gray'],
  ['brown',     'brown'],
  ['leather',   'brown'],
  ['blue',      'blue'],
  ['elven',     'blue'],
  ['red',       'red'],
  ['crimson',   'red']
];

function pickCapeColor(cloak, lifestyleEffects = {}) {
  const name = (cloak?.name || '').toLowerCase();
  let baseKey = 'red';
  for (const [needle, key] of CAPE_COLOR_RULES) {
    if (name.includes(needle)) { baseKey = key; break; }
  }
  // Phase F4 — tattered variant for Squalid/Wretched. Maps any base color to
  // the closest available tattered sprite (only brown + charcoal ship).
  if (lifestyleEffects.capeVariant === 'tattered') {
    if (baseKey === 'charcoal' || baseKey === 'black' || baseKey === 'gray') return 'tattered_charcoal';
    return 'tattered_brown';
  }
  return baseKey;
}

/**
 * Neck variant — replaces the hardcoded 'cross' default. The slot stays
 * 'amulet' for backward compatibility with character.equipment.amulet.
 */
function pickNeck(amulet) {
  const name = (amulet?.name || '').toLowerCase();
  if (name.includes('gem') || name.includes('jewel') || name.includes('pearl') ||
      name.includes('diamond') || name.includes('ruby') || name.includes('sapphire')) return 'gem';
  if (name.includes('chain') || name.includes('pendant') || name.includes('necklace')) return 'chain';
  if (name.includes('charm') || name.includes('talisman') || name.includes('token') ||
      name.includes('lucky') || name.includes('rabbit')) return 'charm';
  // 'cross', 'holy symbol', 'icon' all keep the existing amulet sprite
  return 'cross';
}

/**
 * Backpack variant — class-driven default. Casters and scholars get the
 * squarepack (book bag); everyone else gets the standard adventurer pack.
 */
function pickBackpack(classes) {
  const isScholar = (classes || []).some(c =>
    /wizard|sorcerer|warlock|artificer/i.test(c.name)
  );
  return isScholar ? 'scholar' : 'adventurer';
}

/**
 * True when the character is carrying anything (regardless of slot). Used
 * to decide whether to render the backpack layer (in addition to the
 * back-weapon mutual-exclusion check in buildRenderPlan).
 */
function hasCarriedGear(character) {
  return Array.isArray(character.carried) && character.carried.length > 0;
}

// =====================================================================
// Phase F2 — Background prop defaults
// =====================================================================
// Each background contributes default equipment / featTags that apply
// only when the corresponding slot is empty. Explicit equipment always
// wins. Reuses existing assets — backgrounds with no LPC art (Sailor's
// anchor, Entertainer's instrument) are intentionally omitted rather
// than faked with mismatched art.
//
// Schema:
//   equipment: { <slot>: { name } }     — virtual item populated if slot null
//   featTags:  [{ tag }]                 — appended to visualHints.featTags
//   mainhandIfEmpty: { name }            — only fills mainhand when no weapon
const BACKGROUND_DEFAULTS = {
  acolyte:    { equipment: { amulet: { name: 'Holy Symbol' } } },
  criminal:   { featTags: [{ tag: 'eyepatch' }] },
  hermit:     { mainhandIfEmpty: { name: 'Quarterstaff' } },
  noble:      { equipment: { amulet: { name: 'Gem Necklace' } } },
  outlander:  { equipment: { cloak:  { name: 'Brown Cloak' } } },
  sage:       { featTags: [{ tag: 'glasses' }] },
  soldier:    { equipment: { cloak:  { name: 'Red Cape' } } }
};

// =====================================================================
// Phase F4 — Lifestyle accents
// =====================================================================
// D&DB lifestyle (decoded by ddb-parser) drives cape variant + jewelry.
// Squalid/Wretched → tattered cape; Wealthy/Aristocratic → gem amulet;
// Aristocratic also gets a purple cape if no cloak equipped.
//
// Schema:
//   equipment: { <slot>: { name } }   — fills when null
//   capeVariant: 'tattered'           — flips pickCapeColor to tattered key
// =====================================================================
// Phase E2 — HP state filters
// =====================================================================
// Visual states keyed off the current/max HP ratio. Filters apply on the
// body layer in addition to skin tone; glyphs draw on top of the sprite.
//
// Three states: healthy (no change), wounded (red tint), down (grayscale).
// Death-save failures = 3 force a 'dead' state even if HP > 0 (rare —
// usually current HP = 0 by then, but we honor both signals).
const HP_STATE_FILTERS = {
  healthy: null,
  wounded: 'saturate(1.4) brightness(0.85) sepia(0.15) hue-rotate(-15deg)',
  down:    'saturate(0) brightness(0.55)'
};

function classifyHpState(character) {
  const hp = character.hp || {};
  const ds = character.deathSaves || {};
  if ((ds.failures || 0) >= 3) return 'down';
  const cur = typeof hp.current === 'number' ? hp.current : (typeof hp.max === 'number' && typeof hp.removed === 'number' ? Math.max(0, hp.max - hp.removed) : null);
  const max = typeof hp.max === 'number' ? hp.max : null;
  if (cur === 0) return 'down';
  if (cur != null && max != null && max > 0 && cur / max < 0.25) return 'wounded';
  return 'healthy';
}

// =====================================================================
// Phase E3 — Condition overlays
// =====================================================================
// Each condition can contribute a body filter and/or a status glyph.
// Body filters use a "severity priority" — when multiple conditions apply,
// the highest-priority one wins on tint. Glyphs stack additively in a
// row above the head.
//
// Order in CONDITION_PRIORITY = highest-priority first.
const CONDITION_PRIORITY = ['unconscious', 'petrified', 'paralyzed', 'poisoned', 'frightened', 'charmed', 'invisible', 'stunned'];

const CONDITION_FILTERS = {
  poisoned:    'saturate(1.6) hue-rotate(70deg) brightness(0.95)',
  frightened:  'saturate(0.7) brightness(1.1)',
  paralyzed:   'saturate(1.4) hue-rotate(35deg) brightness(1.1)',
  petrified:   'saturate(0) brightness(0.85)',
  invisible:   'opacity(0.35)',
  unconscious: 'saturate(0) brightness(0.55)',
  charmed:     null,   // no body tint — glyph only
  stunned:     null
};

const CONDITION_GLYPHS = {
  poisoned:   { glyph: 'drip',    color: '#16a34a' },
  frightened: { glyph: 'sweat',   color: '#e5e7eb' },
  charmed:    { glyph: 'heart',   color: '#ec4899' },
  paralyzed:  { glyph: 'bolt',    color: '#facc15' },
  stunned:    { glyph: 'stars',   color: '#fbbf24' },
  unconscious:{ glyph: 'cross_x', color: '#dc2626' }
};

// =====================================================================
// Phase H — Concentration auras
// =====================================================================
// Active concentration spell → a colored backdrop aura layered alongside
// the subclass aura. Spell name is fuzzy-matched (substring).
const CONCENTRATION_AURAS = {
  'bless':            '#fbbf24',  // gold
  'mage armor':       '#3b82f6',  // blue
  'haste':            '#facc15',  // yellow
  'hex':              '#7c3aed',  // dark purple
  'bane':             '#7c3aed',
  'hunter\'s mark':   '#dc2626',  // red
  'hunters mark':     '#dc2626',
  'hold person':      '#06b6d4',  // cyan
  'bless of':         '#fbbf24',  // catch "blessed shield" etc.
  'shield of faith':  '#fde047'
};

function pickConcentrationAura(character) {
  const name = String(character.concentration || '').toLowerCase().trim();
  if (!name) return null;
  // Exact first
  if (CONCENTRATION_AURAS[name]) return CONCENTRATION_AURAS[name];
  // Substring fallback — longest key match wins
  let best = null, bestLen = 0;
  for (const [k, color] of Object.entries(CONCENTRATION_AURAS)) {
    if (name.includes(k) && k.length > bestLen) { best = color; bestLen = k.length; }
  }
  return best || '#e5e7eb';   // generic concentration glow if name set but unknown
}

// =====================================================================
// Phase F1 — Subclass accents
// =====================================================================
// Every PHB subclass (40) plus the most-used post-PHB subclass (Twilight
// Domain) gets a visual signature: a default cape color (when no cloak
// is equipped) and optionally a backdrop aura color. The subclass aura
// composes with the rarity aura — both can render simultaneously.
//
// Match is fuzzy: D&DB stores subclass names with full prefix
// ("Path of the Berserker", "School of Evocation", "Oath of Vengeance").
// pickSubclassAccent strips common prefixes and does a substring lookup.
//
// Schema:
//   cloak: { name }      — fills empty cloak slot (drives pickCapeColor)
//   auraColor: '#hex'    — adds a colored backdrop layer
const SUBCLASS_ACCENTS = {
  // Barbarian
  'berserker':       { cloak: { name: 'Red Cloak' },     auraColor: '#dc2626' },
  'totem warrior':   { cloak: { name: 'Brown Cloak' },   auraColor: '#854d0e' },

  // Bard
  'lore':            { cloak: { name: 'Navy Cloak' },    featTags: [{ tag: 'glasses' }] },
  'valor':           { cloak: { name: 'Red Cloak' },     auraColor: '#fbbf24' },

  // Cleric (PHB + Twilight Domain)
  'knowledge':       { cloak: { name: 'Navy Cloak' },    featTags: [{ tag: 'glasses' }] },
  'life':            { cloak: { name: 'White Cloak' },   auraColor: '#fbbf24' },
  'light':           { cloak: { name: 'White Cloak' },   auraColor: '#fde047' },
  'nature':          { cloak: { name: 'Green Cloak' },   auraColor: '#10b981' },
  'tempest':         { cloak: { name: 'Navy Cloak' },    auraColor: '#0ea5e9' },
  'trickery':        { cloak: { name: 'Charcoal Cloak' } },
  'war':             { cloak: { name: 'Red Cloak' } },
  'twilight':        { cloak: { name: 'Purple Cloak' },  auraColor: '#7c3aed' },

  // Druid
  'land':            { cloak: { name: 'Green Cloak' } },
  'moon':            { cloak: { name: 'White Cloak' },   auraColor: '#94a3b8' },

  // Fighter
  'champion':        { cloak: { name: 'Red Cloak' } },
  'battle master':   { cloak: { name: 'Navy Cloak' } },
  'eldritch knight': { cloak: { name: 'Purple Cloak' },  auraColor: '#a855f7' },

  // Monk
  'open hand':       { cloak: { name: 'White Cloak' } },
  'shadow':          { cloak: { name: 'Charcoal Cloak' }, auraColor: '#1f2937' },
  'four elements':   { cloak: { name: 'Blue Cloak' },    auraColor: '#0ea5e9' },

  // Paladin
  'devotion':        { cloak: { name: 'White Cloak' },   auraColor: '#fbbf24' },
  'ancients':        { cloak: { name: 'Green Cloak' },   auraColor: '#10b981' },
  'vengeance':       { cloak: { name: 'Charcoal Cloak' }, auraColor: '#dc2626' },

  // Ranger
  'hunter':          { cloak: { name: 'Brown Cloak' } },
  'beast master':    { cloak: { name: 'Brown Cloak' } },

  // Rogue
  'thief':           { cloak: { name: 'Charcoal Cloak' } },
  'assassin':        { cloak: { name: 'Black Cloak' },   auraColor: '#1f1f23' },
  'arcane trickster': { cloak: { name: 'Purple Cloak' }, auraColor: '#a855f7' },

  // Sorcerer
  'draconic':        { cloak: { name: 'Red Cloak' },     auraColor: '#dc2626' },
  'wild magic':      { cloak: { name: 'Purple Cloak' },  auraColor: '#ec4899' },

  // Warlock
  'archfey':         { cloak: { name: 'Green Cloak' },   auraColor: '#10b981' },
  'fiend':           { cloak: { name: 'Red Cloak' },     auraColor: '#dc2626' },
  'great old one':   { cloak: { name: 'Purple Cloak' },  auraColor: '#7c3aed' },

  // Wizard schools
  'abjuration':      { cloak: { name: 'White Cloak' },   auraColor: '#a3a3a3' },
  'conjuration':     { cloak: { name: 'Green Cloak' },   auraColor: '#84cc16' },
  'divination':      { cloak: { name: 'Navy Cloak' },    auraColor: '#3b82f6' },
  'enchantment':     { cloak: { name: 'Purple Cloak' },  auraColor: '#ec4899' },
  'evocation':       { cloak: { name: 'Red Cloak' },     auraColor: '#fb923c' },
  'illusion':        { cloak: { name: 'White Cloak' },   auraColor: '#a78bfa' },
  'necromancy':      { cloak: { name: 'Black Cloak' },   auraColor: '#7c2d12' },
  'transmutation':   { cloak: { name: 'Purple Cloak' },  auraColor: '#f59e0b' }
};

/**
 * Strip common D&DB subclass prefixes ("Path of the", "Circle of the",
 * "School of", "Oath of", "College of", "Way of", "Domain", etc.) and
 * return the canonical lowercase key for SUBCLASS_ACCENTS lookup.
 *
 *   "Path of the Berserker"     → "berserker"
 *   "School of Evocation"        → "evocation"
 *   "Oath of Vengeance"          → "vengeance"
 *   "Twilight Domain"            → "twilight"
 *   "Way of the Open Hand"       → "open hand"
 *   "Draconic Bloodline"         → "draconic"
 *   "The Fiend"                  → "fiend"
 */
function canonicalSubclassKey(rawName) {
  if (!rawName) return null;
  let s = String(rawName).toLowerCase().trim();
  // Strip common prefixes
  s = s.replace(/^path of the\s+/, '')
       .replace(/^circle of the\s+/, '')
       .replace(/^circle of\s+/, '')
       .replace(/^school of\s+/, '')
       .replace(/^oath of\s+/, '')
       .replace(/^college of\s+/, '')
       .replace(/^way of the\s+/, '')
       .replace(/^way of\s+/, '')
       .replace(/^the\s+/, '');
  // Strip common suffixes
  s = s.replace(/\s+domain$/, '')
       .replace(/\s+bloodline$/, '')
       .replace(/\s+archetype$/, '')
       .replace(/\s+patron$/, '');
  return s.trim();
}

/** Find the SUBCLASS_ACCENTS entry for a character's primary class subclass. */
function pickSubclassAccent(character) {
  const subclass = character.classes?.[0]?.subclass;
  const key = canonicalSubclassKey(subclass);
  if (!key) return null;
  // Exact match first
  if (SUBCLASS_ACCENTS[key]) return SUBCLASS_ACCENTS[key];
  // Substring fallback — scan keys for the longest substring match
  let best = null, bestLen = 0;
  for (const k of Object.keys(SUBCLASS_ACCENTS)) {
    if (key.includes(k) && k.length > bestLen) { best = SUBCLASS_ACCENTS[k]; bestLen = k.length; }
  }
  return best;
}

// =====================================================================
// Phase F3 — Feat visual library
// =====================================================================
// Visually-distinctive feats fill in equipment / visualHints when the
// corresponding slot is empty. Like backgrounds, explicit equipment
// always wins. Feats that produce a featTag (Sharpshooter→quiver,
// Magic Initiate→glow-hand) are handled separately in
// deriveVisualHints (api/lib/ddb-parser.js) — the two paths complement
// each other.
//
// Schema reuses the BACKGROUND_DEFAULTS shape:
//   equipment / armorIfEmpty / mainhandIfEmpty / featTags / visualHints
const FEAT_DEFAULTS = {
  'tough':                { visualHints: { bodyWidth: 'broad' } },
  'lucky':                { equipment: { amulet: { name: 'Lucky Charm' } } },
  'polearm master':       { mainhandIfEmpty: { name: 'Halberd' } },
  'crossbow expert':      { mainhandIfEmpty: { name: 'Hand Crossbow' } },
  'great weapon master':  { mainhandIfEmpty: { name: 'Greatsword' } },
  'defensive duelist':    { mainhandIfEmpty: { name: 'Rapier' } },
  'heavy armor master':   { armorIfEmpty: { name: 'Plate' } },
  'heavily armored':      { armorIfEmpty: { name: 'Plate' } },
  'sharpshooter':         { featTags: [{ tag: 'quiver' }] }
};

const LIFESTYLE_DEFAULTS = {
  // Squalid/Wretched fill an empty cloak slot with a virtual "Tattered Cloak"
  // so the tattered cape sprite has something to render against. If the
  // character has any explicit cloak set, that wins and gets the tattered
  // variant flip instead.
  wretched: {
    equipment: { cloak: { name: 'Tattered Brown Cloak' } },
    capeVariant: 'tattered'
  },
  squalid: {
    equipment: { cloak: { name: 'Tattered Brown Cloak' } },
    capeVariant: 'tattered'
  },
  wealthy: { equipment: { amulet: { name: 'Gem Necklace' } } },
  aristocratic: {
    equipment: {
      amulet: { name: 'Gem Necklace' },
      cloak:  { name: 'Purple Cape' }
    }
  }
};

/**
 * Return a non-mutating copy of the character with background and
 * lifestyle defaults filled in for any empty slots. Equipment that
 * the character explicitly has set always wins. Adds a private
 * `_lifestyleEffects` field carrying non-equipment hints (cape variant).
 */
function applyContextualDefaults(character) {
  const c = { ...character };
  c.equipment = { ...(c.equipment || {}) };
  c.visualHints = {
    ...(c.visualHints || {}),
    featTags: [...((c.visualHints && c.visualHints.featTags) || [])]
  };
  c._lifestyleEffects = {};

  const fillSlots = (slots) => {
    for (const [slot, item] of Object.entries(slots || {})) {
      if (c.equipment[slot] == null) c.equipment[slot] = item;
    }
  };
  const addFeatTags = (tags) => {
    for (const t of tags || []) {
      if (!c.visualHints.featTags.some(x => x.tag === t.tag)) {
        c.visualHints.featTags.push(t);
      }
    }
  };

  // Helper that applies any of the def-shape entries (used by background,
  // feat, and lifestyle phases — same schema)
  const applyDef = (def) => {
    if (!def) return;
    fillSlots(def.equipment);
    addFeatTags(def.featTags);
    if (def.mainhandIfEmpty && c.equipment.mainhand == null) {
      c.equipment.mainhand = def.mainhandIfEmpty;
    }
    if (def.armorIfEmpty && c.equipment.armor == null) {
      c.equipment.armor = def.armorIfEmpty;
    }
    if (def.visualHints) {
      // Only fill in keys that aren't already set — explicit hints win
      for (const [k, v] of Object.entries(def.visualHints)) {
        if (c.visualHints[k] == null) c.visualHints[k] = v;
      }
    }
  };

  // Phase F1 — Subclass accents (run before background so background's
  // explicit cloak/amulet defaults still win on conflict, but the subclass
  // aura color always carries through).
  const subAccent = pickSubclassAccent(character);
  if (subAccent) {
    applyDef({
      equipment: subAccent.cloak ? { cloak: subAccent.cloak } : null,
      featTags: subAccent.featTags
    });
    if (subAccent.auraColor) c._subclassAura = subAccent.auraColor;
  }

  // Background defaults
  const bgKey = String(character.background || '').toLowerCase().trim();
  applyDef(BACKGROUND_DEFAULTS[bgKey]);

  // Phase F3 — Feat defaults. Iterate all feats; first-applied wins for
  // mainhand-if-empty (Polearm Master beats Crossbow Expert beats Great
  // Weapon Master, in feat-list order from D&DB).
  const feats = Array.isArray(character.feats) ? character.feats : [];
  for (const featName of feats) {
    const featKey = String(featName || '').toLowerCase().trim();
    applyDef(FEAT_DEFAULTS[featKey]);
  }

  // Lifestyle defaults
  const lifestyleKey = String(character.lifestyle || '').toLowerCase().trim();
  const lfDef = LIFESTYLE_DEFAULTS[lifestyleKey];
  if (lfDef) {
    applyDef(lfDef);
    if (lfDef.capeVariant) c._lifestyleEffects.capeVariant = lfDef.capeVariant;
  }

  return c;
}

/**
 * Phase D3 — race-driven trait inference. Returns hairLength preference,
 * default beard style, and default hair/eye colors. Players can override
 * via character.hair / character.beard / character.eyes (not yet exposed
 * in UI).
 */
function inferRaceTraits(character) {
  const race = String(character.race?.name || character.race?.base || '').toLowerCase();
  const gender = inferGender(character);
  const traits = { hair: null, beard: null, hairColor: 'brown', eyeColor: 'brown' };

  if (race.includes('dwarf')) {
    traits.beard = gender === 'female' ? null : 'winter';
    traits.hair = 'long';
    traits.hairColor = race.includes('mountain') ? 'red' : 'brown';
  } else if (race.includes('elf') || race.includes('elven') || race.includes('drow')) {
    traits.hair = 'long';
    traits.hairColor = race.includes('drow') || race.includes('dark') ? 'white' : 'blonde';
    traits.eyeColor = 'green';
  } else if (race.includes('halfling') || race.includes('gnome')) {
    traits.hair = 'bedhead';
    traits.hairColor = 'brown';
  } else if (race.includes('orc') || race.includes('half-orc') || race.includes('hobgoblin')) {
    traits.hair = 'spiked';
    traits.hairColor = 'black';
    traits.beard = gender === 'female' ? null : 'medium';
  } else if (race.includes('tiefling')) {
    traits.hair = 'spiked';
    traits.hairColor = 'black';
    traits.eyeColor = 'gray';
  } else if (race.includes('dragonborn') || race.includes('lizard')) {
    traits.hair = null;  // scaled head, no hair
    traits.beard = null;
  } else {
    // Human-ish default by gender
    traits.hair = gender === 'female' ? 'long' : 'buzzcut';
  }
  return traits;
}

/**
 * Pick a hair sprite key. Three-tier priority:
 *   1. character.hair.style (explicit)
 *   2. character.appearance.hair (parsed free-text; Phase E1)
 *   3. inferRaceTraits (race default)
 * Returns null when hair should not render (helm hides, non-humanoid head).
 */
function pickHair(character, helmKey) {
  if (helmKey && (FULL_FACE_HELMS.has(helmKey) || TOP_OF_HEAD_HELMS.has(helmKey))) {
    return null;
  }
  const explicit = character.hair?.style;
  if (explicit && ASSET_MAP.hair[explicit]) return explicit;
  const fromText = inferAppearanceTraits(character).hair.style;
  if (fromText && ASSET_MAP.hair[fromText]) return fromText;
  const traits = inferRaceTraits(character);
  return traits.hair && ASSET_MAP.hair[traits.hair] ? traits.hair : null;
}

/**
 * Hair color filter key ('brown'|'black'|'blonde'|'red'|'gray'|'white').
 * Same three-tier priority as pickHair, plus an age bias: characters whose
 * appearance.age parses as 'elderly' get pushed toward gray when they
 * would otherwise default to a pigmented color.
 */
function pickHairColor(character) {
  const explicit = character.hair?.color || character.hairColor;
  if (explicit && HAIR_COLOR_FILTERS[explicit] !== undefined) return explicit;
  const parsed = inferAppearanceTraits(character);
  if (parsed.hair.color && HAIR_COLOR_FILTERS[parsed.hair.color] !== undefined) {
    return parsed.hair.color;
  }
  const raceColor = inferRaceTraits(character).hairColor;
  // Elderly bias: push pigmented hair toward gray. White-haired races
  // (drow, ancient elves) and already-gray characters are unaffected.
  if (parsed.ageBias === 'elderly' && raceColor !== 'white' && raceColor !== 'gray') {
    return 'gray';
  }
  return raceColor;
}

/** Beards: only emitted when hair is allowed AND helm doesn't cover the chin. */
function pickBeard(character, helmKey) {
  if (helmKey && FULL_FACE_HELMS.has(helmKey)) return null;
  if (inferGender(character) === 'female') return null;
  const explicit = character.beard?.style;
  // Phase J — sentinel: explicit null/'none' = user suppressed the beard
  if (explicit === null || explicit === 'none') return null;
  if (explicit && ASSET_MAP.beard[explicit]) return explicit;
  const traits = inferRaceTraits(character);
  return traits.beard && ASSET_MAP.beard[traits.beard] ? traits.beard : null;
}

/** Facial accessories: glasses (sage/scholar) or eyepatch (pirate/scarred). */
function pickFacial(character) {
  const explicit = character.facial;
  // Phase J — sentinel '__none__' = user explicitly suppressed
  if (explicit === '__none__' || explicit === null) return null;
  if (typeof explicit === 'string' && ASSET_MAP.facial[explicit]) return explicit;
  const featTags = character.visualHints?.featTags || [];
  if (featTags.some(t => t.tag === 'glasses' || t.tag === 'sage')) return 'glasses';
  if (featTags.some(t => t.tag === 'eyepatch' || t.tag === 'pirate')) return 'eyepatch';
  return null;
}

/**
 * Eye color: three-tier priority (explicit → parsed appearance → race default).
 */
function pickEyes(character) {
  const explicit = character.eyes?.color || character.eyeColor;
  if (explicit && ASSET_MAP.eyes[explicit]) return explicit;
  const fromText = inferAppearanceTraits(character).eyes.color;
  if (fromText && ASSET_MAP.eyes[fromText]) return fromText;
  return inferRaceTraits(character).eyeColor;
}

function pickArms(armor, classes) {
  // Heavy armour adds gauntlets; everyone else gets bracers (or nothing for casters)
  const armorName = (armor?.name || '').toLowerCase();
  const isCaster = (classes || []).some(c =>
    /wizard|sorcerer|warlock/i.test(c.name)
  );
  if (isCaster && !armor) return null;
  if (armorName.includes('plate') || armorName.includes('chain') || armorName.includes('mail')) return 'gauntlets';
  return 'bracers';
}

function pickLegsVariant(armor) {
  // Skirt only matters when a dress would otherwise be drawn; leggings for
  // hide/leather; pants for everything else.
  const name = (armor?.name || '').toLowerCase();
  if (name.includes('hide') || name.includes('leather')) return 'leggings';
  return 'pants';
}

/**
 * Build the layered render plan. Returns {layers, gender, torsoVariant, skinTone}.
 */
export function buildRenderPlan(rawCharacter, { direction = 'south' } = {}) {
  // Phase F2/F4 — apply background + lifestyle defaults BEFORE reading
  // equipment, so empty slots get filled with virtual items (Holy Symbol
  // for Acolyte, Brown Cloak for Outlander, etc.). Explicit equipment
  // already set on the character is never overridden.
  const character = applyContextualDefaults(rawCharacter);
  const eq = character.equipment || {};
  const gender = inferGender(character);
  const skinTone = character.skinTone || inferSkinTone(character);
  const torsoVariant = pickTorsoVariant(eq.armor, character.classes);
  const legsVariant = pickLegsVariant(eq.armor);
  // Phase E1 — bodyWidth from parsed appearance text or visualHints, in that order
  const parsedAppearance = inferAppearanceTraits(character);
  const bodyWidth = parsedAppearance.bodyWidth ||
                    character.visualHints?.bodyWidth ||
                    'normal';
  const layers = [];

  // Phase D — derived-item back/waist poses are tuned for the south view
  // (rotate values assume the camera is facing the character's front). For
  // other directions the rotated weapon would point the wrong way; skip
  // the derived-item path and fall back to bespoke universal_behind art
  // when available, otherwise no back/waist weapon visible.
  const allowDerivedPose = direction === 'south';

  // Cape behind body
  if (eq.cloak) {
    const capeKey = pickCapeColor(eq.cloak, character._lifestyleEffects);
    layers.push({ kind: 'lpc', slot: 'cape-behind', src: ASSET_MAP.cape[capeKey] });
  }

  // Back-weapon (carried item explicitly tagged 'back', either via override
  // or auto-fill in assignCarriedSlots). Three paths in priority order:
  //   1. Bespoke LPC universal_behind art via ASSET_MAP.weaponBack
  //   2. Derived from the mainhand sprite with BACK_DERIVED_POSES
  //   3. Procedural rect placeholder
  const backItem = (character.carried || []).find(c => c.slot === 'back');
  if (backItem) {
    const backKey = pickBackWeapon(backItem);
    const weaponKey = pickWeapon(backItem);
    if (backKey && ASSET_MAP.weaponBack[backKey]) {
      layers.push({ kind: 'item', slot: 'back-weapon', src: ASSET_MAP.weaponBack[backKey], item: backItem });
    } else if (allowDerivedPose && weaponKey && BACK_DERIVED_POSES[weaponKey] && ASSET_MAP.weapon[weaponKey]) {
      layers.push({
        kind: 'derived-item',
        slot: 'back-weapon',
        src: ASSET_MAP.weapon[weaponKey],
        item: backItem,
        pose: BACK_DERIVED_POSES[weaponKey]
      });
    } else if (allowDerivedPose) {
      layers.push({ kind: 'rect', slot: 'back-weapon' });
    }
    // Non-south + no bespoke art → no back-weapon layer (avoids wrongly-rotated render)
  } else if (hasCarriedGear(character)) {
    // Phase C/D2 — backpack auto-fills the back slot when the character is
    // carrying gear but has no back-weapon. Direction-aware art selection:
    //   - south:        straps (shoulder straps visible from front)
    //   - north/W/E:    full pack art (proper distinct adventurer/scholar shapes)
    const packKey = pickBackpack(character.classes);
    const variant = direction === 'south' ? 'straps' : 'full';
    const packSrc = ASSET_MAP.backpack[packKey]?.[variant]?.[gender];
    if (packSrc) {
      layers.push({ kind: 'lpc', slot: 'backpack', src: packSrc });
    }
  }

  // Phase E2/E3 — compose body filter from skin tone + HP state + worst
  // active condition tint. CSS filter is space-separated, so we just join
  // non-null values. Each tint multiplies into the final look.
  const hpState = classifyHpState(character);
  const activeConditions = Array.isArray(character.conditions) ? character.conditions : [];
  const worstCondition = CONDITION_PRIORITY.find(name => activeConditions.includes(name));
  const bodyFilterParts = [
    SKIN_TONES[skinTone],
    HP_STATE_FILTERS[hpState],
    worstCondition ? CONDITION_FILTERS[worstCondition] : null
  ].filter(Boolean);
  const composedFilter = bodyFilterParts.length ? bodyFilterParts.join(' ') : null;

  // Body — gets the composed skin + state filter. M3 — character.body
  // (a key into ASSET_MAP.body) overrides the gender-based default, so
  // monsters with skeleton/zombie/muscular bodies render correctly.
  const bodyKey = character.body && ASSET_MAP.body[character.body] ? character.body : gender;
  layers.push({
    kind: 'lpc',
    slot: 'body',
    src: ASSET_MAP.body[bodyKey] || ASSET_MAP.body.male,
    filter: composedFilter
  });

  // Head — LPC v2 bodies are headless; head is a separate sprite that also
  // takes the same composed filter (so wounded/poisoned/etc. affects head too).
  const headRace = pickHeadRace(character);
  const headSrc = ASSET_MAP.head[headRace]?.[gender] || ASSET_MAP.head.human[gender] || ASSET_MAP.head.human.male;
  layers.push({
    kind: 'lpc',
    slot: 'head',
    src: headSrc,
    filter: composedFilter
  });

  // Phase D3 — face & hair layering. Helm-aware: full-face helms hide
  // hair+beard; top-of-head helms hide hair only; absent helm shows all.
  // Lizard/dragonborn races skip hair/beard entirely (handled in
  // inferRaceTraits).
  const helmKey = eq.helm ? pickHelm(eq.helm, character.classes) : null;

  // Eyes — every character with a humanoid head gets eyes
  if (headRace === 'human') {
    const eyeColor = pickEyes(character);
    if (ASSET_MAP.eyes[eyeColor]) {
      layers.push({ kind: 'lpc', slot: 'eyes', src: ASSET_MAP.eyes[eyeColor] });
    }
  }

  // Hair — skipped under helm or for non-humanoid heads
  if (headRace === 'human') {
    const hairKey = pickHair(character, helmKey);
    if (hairKey) {
      layers.push({
        kind: 'lpc', slot: 'hair', src: ASSET_MAP.hair[hairKey],
        filter: HAIR_COLOR_FILTERS[pickHairColor(character)]
      });
    }
  }

  // Beard — male humans only by default; full-face helms hide it
  if (headRace === 'human') {
    const beardKey = pickBeard(character, helmKey);
    if (beardKey) {
      layers.push({
        kind: 'lpc', slot: 'beard', src: ASSET_MAP.beard[beardKey],
        filter: HAIR_COLOR_FILTERS[pickHairColor(character)]
      });
    }
  }

  // Facial — glasses / eyepatch via feat tags or explicit character.facial
  const facialKey = pickFacial(character);
  if (facialKey) {
    layers.push({ kind: 'lpc', slot: 'facial', src: ASSET_MAP.facial[facialKey] });
  }

  // Legs (skipped if dress is drawn)
  const drawDress = gender === 'female' && torsoVariant === 'cloth' && !eq.armor &&
                    (character.classes || []).some(c => /bard|cleric|druid|noble/i.test(c.name));
  if (!drawDress) {
    const legsAsset = ASSET_MAP.legs[legsVariant]?.[gender] || ASSET_MAP.legs.pants[gender];
    if (legsAsset) layers.push({ kind: 'lpc', slot: 'legs', src: legsAsset });
  }

  layers.push({ kind: 'lpc', slot: 'feet', src: ASSET_MAP.feet[gender] || ASSET_MAP.feet.male });

  // Torso (or dress). Armoured torso routes through the item generator so
  // material/rarity/magic mutations apply; unarmoured cloth/robe and dresses
  // stay on the plain LPC path.
  if (drawDress) {
    layers.push({ kind: 'lpc', slot: 'torso', src: ASSET_MAP.dress.bodice });
  } else {
    const variantSlot = ASSET_MAP.torso[torsoVariant];
    const torsoSrc = variantSlot?.[gender] || ASSET_MAP.torso.cloth[gender];
    if (eq.armor) {
      layers.push({ kind: 'item', slot: 'torso', src: torsoSrc, item: eq.armor });
    } else {
      layers.push({ kind: 'lpc', slot: 'torso', src: torsoSrc });
    }
  }

  // Wizard cord belt for robe-wearers
  if (torsoVariant === 'robe' && ASSET_MAP.waist['rope-belt'][gender]) {
    layers.push({ kind: 'lpc', slot: 'waist', src: ASSET_MAP.waist['rope-belt'][gender] });
  }

  // Waist-weapon (carried item explicitly tagged 'waist'). Hybrid path:
  // sword-family + mace/club are derived from their mainhand sprite at a
  // hip pose; everything else (bow/halberd/spear at hip — uncommon) falls
  // back to a procedural rect placeholder.
  const waistItem = (character.carried || []).find(c => c.slot === 'waist');
  if (waistItem && allowDerivedPose) {
    const weaponKey = pickWeapon(waistItem);
    if (weaponKey && WAIST_DERIVED_POSES[weaponKey] && ASSET_MAP.weapon[weaponKey]) {
      layers.push({
        kind: 'derived-item',
        slot: 'waist-weapon',
        src: ASSET_MAP.weapon[weaponKey],
        item: waistItem,
        pose: WAIST_DERIVED_POSES[weaponKey]
      });
    } else {
      layers.push({ kind: 'rect', slot: 'waist-weapon' });
    }
  }
  // Non-south: derived poses are south-tuned, so waist weapon is hidden.

  // Amulet — Phase C routes through pickNeck() to choose between cross /
  // chain / charm / gem based on the item name. Falls back to cross.
  if (eq.amulet) {
    const neckKey = pickNeck(eq.amulet);
    const neckSrc = ASSET_MAP.amulet[neckKey]?.[gender] || ASSET_MAP.amulet.cross[gender];
    layers.push({ kind: 'lpc', slot: 'amulet', src: neckSrc });
  }

  // Gloves: cloth if generic, gauntlets/bracers if armoured. Real LPC layer
  // takes precedence over procedural rectangle.
  if (eq.gloves) {
    const glovesSrc = ASSET_MAP.gloves.cloth[gender];
    if (glovesSrc) layers.push({ kind: 'lpc', slot: 'gloves', src: glovesSrc });
  }

  const armsKey = pickArms(eq.armor, character.classes);
  if (armsKey) {
    const armsSrc = ASSET_MAP.arms[armsKey]?.[gender];
    if (armsSrc) layers.push({ kind: 'lpc', slot: 'arms', src: armsSrc });
  }

  // Helm
  if (eq.helm) {
    layers.push({ kind: 'lpc', slot: 'helm', src: ASSET_MAP.helm[pickHelm(eq.helm, character.classes)] });
  } else if ((character.classes || []).some(c => /wizard/i.test(c.name))) {
    layers.push({ kind: 'lpc', slot: 'helm', src: ASSET_MAP.helm.wizard });
  }

  // Sharpshooter feat or equipped ranged weapon → quiver
  const featTags = character.visualHints?.featTags || [];
  const hasSharpshooter = featTags.some(t => t.tag === 'quiver');
  if (hasSharpshooter || usesArrowQuiver(eq.mainhand)) {
    layers.push({ kind: 'lpc', slot: 'quiver', src: ASSET_MAP.quiver.default });
  }

  // Off-hand (shield) — routes through item generator
  if (eq.offhand) {
    const shieldKey = pickShield(eq.offhand);
    if (shieldKey) {
      layers.push({ kind: 'item', slot: 'offhand', src: ASSET_MAP.shield[shieldKey], item: eq.offhand });
    } else {
      layers.push({ kind: 'rect', slot: 'offhand' });
    }
  }

  // Main hand (weapon) — routes through item generator
  if (eq.mainhand) {
    const weaponKey = pickWeapon(eq.mainhand);
    if (weaponKey) {
      layers.push({ kind: 'item', slot: 'mainhand', src: ASSET_MAP.weapon[weaponKey], item: eq.mainhand });
    } else {
      layers.push({ kind: 'rect', slot: 'mainhand' });
    }
  }

  // Effects (glow, etc.)
  for (const tag of featTags) {
    if (tag.tag === 'glow-hand') {
      layers.push({ kind: 'effect', slot: 'effects', tint: tag.tint || '#6366f1' });
    }
  }

  // Phase E4 — Inspiration: gold star above head when character.inspiration is true
  if (character.inspiration === true) {
    layers.push({
      kind: 'glyph',
      slot: 'effects',
      glyph: 'star',
      color: '#fbbf24',
      position: { x: 32, y: 4 }
    });
  }

  // Phase E2 — HP state glyphs (down → skull; wounded → scratch)
  if (hpState === 'down') {
    layers.push({
      kind: 'glyph', slot: 'effects',
      glyph: 'skull', color: '#dc2626', position: { x: 32, y: 4 }
    });
  } else if (hpState === 'wounded') {
    layers.push({
      kind: 'glyph', slot: 'effects',
      glyph: 'scratch', color: '#dc2626', position: { x: 50, y: 24 }
    });
  }

  // Phase E3 — condition glyphs (stack in a row from x=8 upward at y=8)
  let glyphX = 10;
  for (const cond of activeConditions) {
    const g = CONDITION_GLYPHS[cond];
    if (!g) continue;
    layers.push({
      kind: 'glyph', slot: 'effects',
      glyph: g.glyph, color: g.color, position: { x: glyphX, y: 8 }
    });
    glyphX += 8;
  }

  return {
    layers, gender, torsoVariant, skinTone, bodyWidth,
    // Phase F1 — backdrop aura color from subclass (composes with rarity aura)
    subclassAura: character._subclassAura || null,
    // Phase H — concentration aura (overlays on top of subclass aura)
    concentrationAura: pickConcentrationAura(character),
    // Phase E2 — surface temp HP shimmer to compositor
    tempHpAura: (character.hp?.temp || 0) > 0 ? '#60a5fa' : null,
    // Surface state for debugging / downstream consumers
    hpState
  };
}
