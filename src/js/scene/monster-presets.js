/**
 * M3 — Monster presets.
 *
 * Each preset describes a creature in terms of LPC composition fields
 * (body, head, skin tone, optional equipment + a default name). At spawn
 * time we synthesize a "character-shaped" object so the existing
 * buildRenderPlan / drawCharacterAt pipeline renders the monster
 * exactly like a PC — full animation, condition glyphs, HP states,
 * everything — without forking the render code.
 *
 * Fields per preset:
 *   slug         — stable identifier, matches Open5e where applicable
 *   name         — display name
 *   body         — ASSET_MAP.body key ('male' | 'female' | 'muscular' | 'skeleton' | 'zombie' | 'teen')
 *   headRace     — ASSET_MAP.head key ('human' | 'goblin' | 'orc' | 'troll' | …)
 *   skinTone     — SKIN_TONES key, also drives appearance text fallthrough
 *   hairStyle    — usually 'balding' or 'buzzcut' for monsters; 'none' to suppress
 *   equipment    — optional: { armor, mainhand, offhand, helm, cloak }
 *   gender       — 'male' | 'female' (defaults to male for head-asset selection)
 *   defaultHp    — { max } baseline HP for spawned instance
 *   ac           — M6: Armor Class (5e SRD value). Defaults to 12 if unset.
 *   attack       — M6: { name, bonus, dice } for the creature's primary attack.
 *                  Defaults to { name: 'Strike', bonus: 2, dice: '1d6' } if unset.
 */

export const MONSTER_PRESETS = {
  goblin: {
    slug: 'goblin', name: 'Goblin',
    body: 'male', headRace: 'goblin', skinTone: 'green', hairStyle: 'balding',
    equipment: { mainhand: { name: 'Scimitar' } },
    defaultHp: { max: 7 }, ac: 15,
    attack: { name: 'Scimitar', bonus: 4, dice: '1d6+2' }
  },
  orc: {
    slug: 'orc', name: 'Orc',
    body: 'muscular', headRace: 'orc', skinTone: 'green', hairStyle: 'spiked',
    equipment: { mainhand: { name: 'Greataxe' }, armor: { name: 'Hide Armor' } },
    defaultHp: { max: 15 }, ac: 13,
    attack: { name: 'Greataxe', bonus: 5, dice: '1d12+3' }
  },
  hobgoblin: {
    slug: 'hobgoblin', name: 'Hobgoblin',
    body: 'male', headRace: 'goblin', skinTone: 'olive', hairStyle: 'spiked',
    equipment: { mainhand: { name: 'Longsword' }, offhand: { name: 'Shield' }, armor: { name: 'Chain Mail' } },
    defaultHp: { max: 11 }, ac: 18,
    attack: { name: 'Longsword', bonus: 3, dice: '1d8+1' }
  },
  bugbear: {
    slug: 'bugbear', name: 'Bugbear',
    body: 'muscular', headRace: 'wolf', skinTone: 'green', hairStyle: 'bedhead',
    equipment: { mainhand: { name: 'Morningstar' }, armor: { name: 'Hide Armor' } },
    defaultHp: { max: 27 }, ac: 16,
    attack: { name: 'Morningstar', bonus: 4, dice: '2d8+2' }
  },
  kobold: {
    slug: 'kobold', name: 'Kobold',
    body: 'teen', headRace: 'lizard', skinTone: 'red', hairStyle: 'balding',
    equipment: { mainhand: { name: 'Dagger' } },
    defaultHp: { max: 5 }, ac: 12,
    attack: { name: 'Dagger', bonus: 4, dice: '1d4+2' }
  },
  skeleton: {
    slug: 'skeleton', name: 'Skeleton',
    body: 'skeleton', headRace: 'skeleton', skinTone: 'ashen', hairStyle: 'balding',
    equipment: { mainhand: { name: 'Shortsword' }, offhand: { name: 'Shield' } },
    defaultHp: { max: 13 }, ac: 13,
    attack: { name: 'Shortsword', bonus: 4, dice: '1d6+2' }
  },
  zombie: {
    slug: 'zombie', name: 'Zombie',
    body: 'zombie', headRace: 'zombie', skinTone: 'ashen', hairStyle: 'balding',
    defaultHp: { max: 22 }, ac: 8,
    attack: { name: 'Slam', bonus: 3, dice: '1d6+1' }
  },
  vampire: {
    slug: 'vampire-spawn', name: 'Vampire Spawn',
    body: 'male', headRace: 'vampire', skinTone: 'pale', hairStyle: 'long',
    equipment: { cloak: { name: 'Black Cloak' } },
    defaultHp: { max: 82 }, ac: 15,
    attack: { name: 'Claws', bonus: 6, dice: '2d4+3' }
  },
  troll: {
    slug: 'troll', name: 'Troll',
    body: 'muscular', headRace: 'troll', skinTone: 'green', hairStyle: 'balding',
    equipment: { mainhand: { name: 'Greatclub' } },
    defaultHp: { max: 84 }, ac: 15,
    attack: { name: 'Claws', bonus: 7, dice: '2d6+4' }
  },
  minotaur: {
    slug: 'minotaur', name: 'Minotaur',
    body: 'muscular', headRace: 'minotaur', skinTone: 'tan', hairStyle: 'balding',
    equipment: { mainhand: { name: 'Greataxe' } },
    defaultHp: { max: 76 }, ac: 14,
    attack: { name: 'Greataxe', bonus: 6, dice: '2d12+4' }
  },
  bandit: {
    slug: 'bandit', name: 'Bandit',
    body: 'male', headRace: 'human', skinTone: 'tan', hairStyle: 'bedhead',
    equipment: { mainhand: { name: 'Scimitar' }, armor: { name: 'Leather' }, helm: { name: 'Hood' } },
    defaultHp: { max: 11 }, ac: 12,
    attack: { name: 'Scimitar', bonus: 3, dice: '1d6+1' }
  },
  cultist: {
    slug: 'cultist', name: 'Cultist',
    body: 'male', headRace: 'human', skinTone: 'pale', hairStyle: 'long',
    equipment: { mainhand: { name: 'Scimitar' }, helm: { name: 'Hood' }, cloak: { name: 'Black Cloak' } },
    defaultHp: { max: 9 }, ac: 12,
    attack: { name: 'Scimitar', bonus: 3, dice: '1d6+1' }
  },
  gnoll: {
    slug: 'gnoll', name: 'Gnoll',
    body: 'muscular', headRace: 'wolf', skinTone: 'tan', hairStyle: 'spiked',
    equipment: { mainhand: { name: 'Spear' }, armor: { name: 'Hide Armor' } },
    defaultHp: { max: 22 }, ac: 15,
    attack: { name: 'Spear', bonus: 4, dice: '1d6+2' }
  },
  ratfolk: {
    slug: 'ratfolk', name: 'Ratfolk',
    body: 'teen', headRace: 'rat', skinTone: 'tan', hairStyle: 'balding',
    equipment: { mainhand: { name: 'Dagger' } },
    defaultHp: { max: 6 }, ac: 11,
    attack: { name: 'Dagger', bonus: 3, dice: '1d4+1' }
  }
};

// M21 — SRD save bonuses per preset (ability-mod values; no preset
// monster has expertise/proficiency in saves in v1). Used by the save
// resolver when a save-based spell targets a monster. Unknown slugs
// fall back to 0 for every stat.
export const MONSTER_DEFAULT_SAVES = {
  goblin:        { STR: -1, DEX: +2, CON:  0, INT:  0, WIS: -1, CHA: -2 },
  orc:           { STR: +3, DEX: +1, CON: +3, INT: -2, WIS:  0, CHA:  0 },
  hobgoblin:     { STR: +2, DEX: +1, CON: +1, INT:  0, WIS:  0, CHA: -1 },
  bugbear:       { STR: +2, DEX: +2, CON: +1, INT: -1, WIS:  0, CHA: -1 },
  kobold:        { STR: -2, DEX: +2, CON: -1, INT: -1, WIS: -2, CHA: -1 },
  skeleton:      { STR:  0, DEX: +2, CON: +2, INT: -2, WIS: -1, CHA: -3 },
  zombie:        { STR: +1, DEX: -2, CON: +3, INT: -4, WIS:  0, CHA: -3 },
  'vampire-spawn': { STR: +3, DEX: +2, CON: +3, INT:  0, WIS:  0, CHA: +2 },
  troll:         { STR: +4, DEX: +1, CON: +5, INT: -2, WIS: -1, CHA: -2 },
  minotaur:      { STR: +4, DEX:  0, CON: +3, INT: -2, WIS: +2, CHA: -1 },
  bandit:        { STR:  0, DEX: +1, CON:  0, INT:  0, WIS:  0, CHA:  0 },
  cultist:       { STR:  0, DEX:  0, CON:  0, INT:  0, WIS: +1, CHA:  0 },
  gnoll:         { STR: +2, DEX:  0, CON: +1, INT: -2, WIS:  0, CHA: -2 },
  ratfolk:       { STR: -2, DEX: +3, CON:  0, INT:  0, WIS:  0, CHA: -2 }
};

/** Save bonus for a monster instance against a given stat ('DEX' etc.). */
export function monsterSaveBonus(presetSlug, stat) {
  const table = MONSTER_DEFAULT_SAVES[presetSlug];
  if (!table) return 0;
  return table[stat] || 0;
}

/**
 * Synthesize a character-shaped object that buildRenderPlan can consume,
 * representing a monster instance. The bridge points:
 *
 *   - race.name        is set from preset.headRace so existing
 *                      pickHeadRace() picks the right head asset.
 *   - skinTone         set explicitly so inferSkinTone honors it.
 *   - hair.style       set explicitly so pickHair short-circuits to it
 *                      instead of running race-based traits.
 *   - body             new override field (see lpc-config buildRenderPlan)
 *   - equipment        passed through; the existing equipment-routing
 *                      logic produces sprites + auras automatically.
 *
 * The returned object also carries _isMonster + _preset for the UI to
 * distinguish monster instances from PCs.
 */
export function buildMonsterCharacter(preset, instanceId) {
  return {
    id: instanceId,
    name: preset.name,
    // race.name is consumed by pickHeadRace and inferRaceTraits — set it to
    // a head-friendly label. Pickers fall through gracefully for unknown
    // races so this won't break visual hints.
    race: { name: preset.headRace || 'human' },
    classes: [{ name: 'Monster', level: 1 }],
    equipment: preset.equipment || {},
    carried: [],
    feats: [],
    abilityScores: { STR: 10, DEX: 10, CON: 10, INT: 10, WIS: 10, CHA: 10 },
    abilityModifiers: { STR: 0, DEX: 0, CON: 0, INT: 0, WIS: 0, CHA: 0 },
    visualHints: { featTags: [] },
    skinTone: preset.skinTone || 'light',
    appearance: {},
    hair:  { style: preset.hairStyle || 'balding' },
    beard: { style: 'none' },
    eyes:  { color: preset.eyeColor || 'red' },
    hp: {
      base: preset.defaultHp?.max || 5,
      bonus: 0, override: null, temp: 0, removed: 0,
      max: preset.defaultHp?.max || 5,
      current: preset.defaultHp?.max || 5
    },
    // M3 — monster-specific render hooks
    body: preset.body || 'male',       // ASSET_MAP.body key override
    gender: preset.gender || 'male',
    _isMonster: true,
    _presetSlug: preset.slug
  };
}
