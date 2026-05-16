import { test } from 'node:test';
import assert from 'node:assert';
import { parseCharacter } from '../lib/ddb-parser.js';

// Minimum viable D&DB v5 raw character shape — fields the parser reads.
// Real responses include hundreds more fields; we only exercise the ones
// parseCharacter actually consumes.
function rawFixture(extras = {}) {
  return {
    id: 148566289,
    name: 'Test Character',
    race: { fullName: 'Mountain Dwarf', baseRaceName: 'Dwarf' },
    classes: [{ definition: { name: 'Fighter' }, level: 5, subclassDefinition: { name: 'Champion' } }],
    stats: [
      { id: 1, value: 16 }, { id: 2, value: 12 }, { id: 3, value: 14 },
      { id: 4, value: 10 }, { id: 5, value: 13 }, { id: 6, value: 8 }
    ],
    bonusStats: [],
    overrideStats: [],
    inventory: [],
    feats: [],
    baseHitPoints: 38,
    bonusHitPoints: 0,
    overrideHitPoints: null,
    temporaryHitPoints: 0,
    removedHitPoints: 0,
    ...extras
  };
}

test('ddb-parser: appearance fields populated from raw D&DB fields', () => {
  const raw = rawFixture({
    hair: 'Auburn, shoulder-length',
    eyes: 'Hazel',
    skin: 'Tanned',
    age: 35,
    height: "5'10\"",
    weight: 180,
    gender: 'Female',
    faith: 'Pelor',
    lifestyleId: 5  // D&DB enum: 5 = Comfortable
  });
  const parsed = parseCharacter(raw);
  assert.deepStrictEqual(parsed.appearance, {
    hair: 'Auburn, shoulder-length',
    eyes: 'Hazel',
    skin: 'Tanned',
    age: '35',
    height: "5'10\"",
    weight: '180',
    build: null
  });
  assert.strictEqual(parsed.gender, 'Female');
  assert.strictEqual(parsed.faith, 'Pelor');
  assert.strictEqual(parsed.lifestyle, 'Comfortable');
});

test('ddb-parser: empty/missing appearance fields become null (fall through to race defaults)', () => {
  const raw = rawFixture({
    hair: '',
    eyes: '   ',
    // skin/age/height/weight omitted entirely
  });
  const parsed = parseCharacter(raw);
  assert.strictEqual(parsed.appearance.hair, null, 'empty string → null');
  assert.strictEqual(parsed.appearance.eyes, null, 'whitespace-only → null');
  assert.strictEqual(parsed.appearance.skin, null, 'missing → null');
  assert.strictEqual(parsed.appearance.age, null);
  assert.strictEqual(parsed.appearance.height, null);
  assert.strictEqual(parsed.appearance.weight, null);
});

test('ddb-parser: traits sub-object surfaces personality/ideals/bonds/flaws/appearance/backstory', () => {
  const raw = rawFixture({
    traits: {
      personalityTraits: 'I am gruff but loyal.',
      ideals: 'Honor above all.',
      bonds: 'My clan is my life.',
      flaws: 'I never back down from a fight.',
      appearance: 'A scar runs down the left cheek.'
    },
    notes: { backstory: 'Lost in a mining accident...' }
  });
  const parsed = parseCharacter(raw);
  assert.strictEqual(parsed.traits.personalityTraits, 'I am gruff but loyal.');
  assert.strictEqual(parsed.traits.ideals, 'Honor above all.');
  assert.strictEqual(parsed.traits.bonds, 'My clan is my life.');
  assert.strictEqual(parsed.traits.flaws, 'I never back down from a fight.');
  assert.strictEqual(parsed.traits.appearance, 'A scar runs down the left cheek.');
  assert.strictEqual(parsed.traits.backstory, 'Lost in a mining accident...');
});

test('ddb-parser: traits.appearance free-text feeds appearance.build (build keyword fallback)', () => {
  const raw = rawFixture({
    traits: { appearance: 'Tall and broad-shouldered, with a thick beard.' }
  });
  const parsed = parseCharacter(raw);
  assert.strictEqual(parsed.appearance.build, 'Tall and broad-shouldered, with a thick beard.',
    'build text should preserve the appearance freeform string for downstream parsing');
});

test('ddb-parser: inspiration toggle surfaces from raw flag', () => {
  assert.strictEqual(parseCharacter(rawFixture({ inspiration: true })).inspiration, true);
  assert.strictEqual(parseCharacter(rawFixture({ inspiration: false })).inspiration, false);
  assert.strictEqual(parseCharacter(rawFixture({})).inspiration, false, 'absent → false');
});

test('ddb-parser: end-to-end appearance → sprite renderer (full pipeline)', async () => {
  // Verifies the bridge: D&DB raw fields → parseCharacter → appearance →
  // appearance-parser (in lpc-config) → sprite layer choices.
  const raw = rawFixture({
    hair: 'Salt-and-pepper, short',
    eyes: 'Emerald green',
    skin: 'Sun-kissed',
    age: 65,
    inspiration: true
  });
  const parsed = parseCharacter(raw);
  const { buildRenderPlan } = await import('../../src/js/sprite/lpc-config.js');
  const plan = buildRenderPlan(parsed);

  const hair = plan.layers.find(l => l.slot === 'hair');
  const eyes = plan.layers.find(l => l.slot === 'eyes');
  const glyph = plan.layers.find(l => l.kind === 'glyph');

  assert.ok(hair, 'hair layer expected from parsed appearance');
  assert.ok(hair.src.endsWith('buzzcut.png'), `expected buzzcut for "short", got ${hair.src}`);
  // Salt-and-pepper → gray, but elderly bias would also produce gray. Either way the filter is gray.
  const { HAIR_COLOR_FILTERS } = await import('../../src/js/sprite/lpc-config.js');
  assert.strictEqual(hair.filter, HAIR_COLOR_FILTERS.gray);

  assert.ok(eyes.src.endsWith('green.png'), `emerald → green sprite, got ${eyes.src}`);
  // skinTone is intentionally NOT pre-filled by the parser (would mask the
  // appearance override). Resolved at render time via inferSkinTone.
  assert.strictEqual(parsed.skinTone, undefined,
    'parser must not pre-set skinTone (would mask appearance.skin override)');
  const { inferSkinTone, SKIN_TONES } = await import('../../src/js/sprite/lpc-config.js');
  assert.strictEqual(inferSkinTone(parsed), 'tan', 'sun-kissed → tan');
  // The body layer's CSS filter should match the SKIN_TONES['tan'] value
  const body = plan.layers.find(l => l.slot === 'body');
  assert.ok(body, 'body layer expected');
  assert.strictEqual(body.filter, SKIN_TONES.tan);

  assert.ok(glyph, 'inspiration=true → glyph layer');
  assert.strictEqual(glyph.glyph, 'star');
});

// --- HP calculation regression tests (Saris bug, May 2026) ---

test('ddb-parser: max HP includes CON modifier × total level', () => {
  // Mock Saris: Cleric L3, baseHP=18, CON 15 + 1 from Resilient feat → CON 16 → +3 mod
  // Expected: 18 + (3 × 3) = 27 max
  const raw = rawFixture({
    classes: [{ definition: { name: 'Cleric' }, level: 3, subclassDefinition: { name: 'Twilight Domain' } }],
    baseHitPoints: 18,
    bonusHitPoints: null,
    stats: [
      { id: 1, value: 15 }, { id: 2, value: 8 }, { id: 3, value: 15 },
      { id: 4, value: 8 },  { id: 5, value: 15 }, { id: 6, value: 8 }
    ],
    modifiers: {
      feat: [
        { type: 'bonus', subType: 'constitution-score', value: 1, fixedValue: 1 }
      ]
    }
  });
  const parsed = parseCharacter(raw);
  assert.strictEqual(parsed.level, 3);
  assert.strictEqual(parsed.abilityScores.CON, 16,
    'Resilient feat must push CON from 15 to 16');
  assert.strictEqual(parsed.abilityModifiers.CON, 3);
  assert.strictEqual(parsed.hp.max, 27,
    'max HP must be baseHP (18) + CON_mod (+3) × level (3) = 27');
  assert.strictEqual(parsed.hp.current, 27);
});

test('ddb-parser: ability score bonuses from modifiers section apply', () => {
  const raw = rawFixture({
    stats: [
      { id: 1, value: 10 }, { id: 2, value: 10 }, { id: 3, value: 10 },
      { id: 4, value: 10 }, { id: 5, value: 10 }, { id: 6, value: 10 }
    ],
    modifiers: {
      race:   [{ type: 'bonus', subType: 'wisdom-score',     value: 2, fixedValue: 2 }],
      feat:   [{ type: 'bonus', subType: 'constitution-score', value: 1, fixedValue: 1 }],
      item:   [{ type: 'bonus', subType: 'strength-score',   value: 1, fixedValue: 1 }],
      background: [],
      class: []
    }
  });
  const parsed = parseCharacter(raw);
  assert.strictEqual(parsed.abilityScores.WIS, 12, 'race +2 WIS');
  assert.strictEqual(parsed.abilityScores.CON, 11, 'feat +1 CON');
  assert.strictEqual(parsed.abilityScores.STR, 11, 'item +1 STR');
  assert.strictEqual(parsed.abilityScores.DEX, 10, 'no DEX bonus');
});

test('ddb-parser: modifier type "set" floors the score (does not add)', () => {
  // type='set' for a stat replaces the score IF the new value is higher
  // (mirrors D&DB behavior where racial floors don't lower an already-good score).
  const raw = rawFixture({
    stats: [
      { id: 1, value: 18 }, { id: 2, value: 10 }, { id: 3, value: 10 },
      { id: 4, value: 10 }, { id: 5, value: 10 }, { id: 6, value: 10 }
    ],
    modifiers: { race: [{ type: 'set', subType: 'strength-score', value: 15, fixedValue: 15 }] }
  });
  const parsed = parseCharacter(raw);
  // STR was 18, racial floor of 15 should NOT lower it
  assert.strictEqual(parsed.abilityScores.STR, 18);
});

test('ddb-parser: overrideHitPoints wins over derived max', () => {
  const raw = rawFixture({
    baseHitPoints: 18,
    overrideHitPoints: 50,    // manual override
    stats: [
      { id: 1, value: 10 }, { id: 2, value: 10 }, { id: 3, value: 20 },  // CON 20 → +5
      { id: 4, value: 10 }, { id: 5, value: 10 }, { id: 6, value: 10 }
    ]
  });
  const parsed = parseCharacter(raw);
  // Without override, derived would be 18 + (5 × 5) = 43. Override forces 50.
  assert.strictEqual(parsed.hp.max, 50);
});

test('ddb-parser: HP at level 0 uses baseHitPoints only (defensive)', () => {
  const raw = rawFixture({
    baseHitPoints: 10,
    classes: [],   // no classes → level 0
    stats: [
      { id: 1, value: 10 }, { id: 2, value: 10 }, { id: 3, value: 20 },
      { id: 4, value: 10 }, { id: 5, value: 10 }, { id: 6, value: 10 }
    ]
  });
  const parsed = parseCharacter(raw);
  assert.strictEqual(parsed.level, 0);
  assert.strictEqual(parsed.hp.max, 10, 'CON × 0 contributes nothing');
});

// ---- M10: parseClassFeatures ----

function classFeature({ id, name, level, classId = 2, isSub = false, hide = false, snippet = '', description = '', limitedUse = null }) {
  // M10: `classId` is the canonical signal for subclass attribution.
  // Defaults to 2 (PHB Cleric base class id) so most fixtures don't need
  // to set it; pass classId = subclassDefinition.id when the feature
  // should be tagged with the subclass name.
  return {
    definition: {
      id, name, requiredLevel: level,
      classId,
      isSubClassFeature: isSub,
      hideInSheet: hide,
      snippet, description,
      limitedUse
    }
  };
}

test('M10: parseClassFeatures includes only features at or below current level', () => {
  const raw = rawFixture({
    classes: [{
      definition: { name: 'Cleric' },
      level: 3,
      subclassDefinition: { name: 'Twilight Domain' },
      classFeatures: [
        classFeature({ id: 1, name: 'Spellcasting', level: 1 }),
        classFeature({ id: 2, name: 'Channel Divinity', level: 2 }),
        classFeature({ id: 3, name: 'Destroy Undead', level: 5 }),   // not yet
        classFeature({ id: 4, name: 'Divine Intervention', level: 10 }) // not yet
      ]
    }]
  });
  const parsed = parseCharacter(raw);
  const names = parsed.classFeatures.map(f => f.name);
  assert.deepStrictEqual(names, ['Spellcasting', 'Channel Divinity']);
});

test('M10: parseClassFeatures filters noise features by name', () => {
  const raw = rawFixture({
    classes: [{
      definition: { name: 'Fighter' },
      level: 4,
      classFeatures: [
        classFeature({ id: 1, name: 'Hit Points', level: 1 }),
        classFeature({ id: 2, name: 'Equipment', level: 1 }),
        classFeature({ id: 3, name: 'Proficiencies', level: 1 }),
        classFeature({ id: 4, name: 'Ability Score Improvement', level: 4 }),
        classFeature({ id: 5, name: 'Second Wind', level: 1 })   // real
      ]
    }]
  });
  const parsed = parseCharacter(raw);
  assert.deepStrictEqual(parsed.classFeatures.map(f => f.name), ['Second Wind']);
});

test('M10: parseClassFeatures honors hideInSheet', () => {
  const raw = rawFixture({
    classes: [{
      definition: { name: 'Wizard' }, level: 1,
      classFeatures: [
        classFeature({ id: 1, name: 'Secret Lab', level: 1, hide: true }),
        classFeature({ id: 2, name: 'Arcane Recovery', level: 1 })
      ]
    }]
  });
  const parsed = parseCharacter(raw);
  assert.deepStrictEqual(parsed.classFeatures.map(f => f.name), ['Arcane Recovery']);
});

test('M10: parseClassFeatures tags subclass features with the subclass name as source', () => {
  const raw = rawFixture({
    classes: [{
      definition: { id: 2, name: 'Cleric' }, level: 2,
      subclassDefinition: { id: 654582, name: 'Twilight Domain' },
      classFeatures: [
        classFeature({ id: 1, name: 'Spellcasting', level: 1, classId: 2 }),
        classFeature({ id: 2, name: 'Eyes of Night', level: 1, classId: 654582 }),
        classFeature({ id: 3, name: 'Channel Divinity: Twilight Sanctuary', level: 2, classId: 654582 })
      ]
    }]
  });
  const parsed = parseCharacter(raw);
  const sources = parsed.classFeatures.map(f => ({ n: f.name, s: f.source }));
  assert.deepStrictEqual(sources, [
    { n: 'Spellcasting', s: 'Cleric' },
    { n: 'Eyes of Night', s: 'Twilight Domain' },
    { n: 'Channel Divinity: Twilight Sanctuary', s: 'Twilight Domain' }
  ]);
});

test('M10: parseClassFeatures cross-references actions.class for dice + uses', () => {
  const raw = rawFixture({
    classes: [{
      definition: { name: 'Rogue' }, level: 5,
      classFeatures: [
        classFeature({ id: 42, name: 'Sneak Attack', level: 1 })
      ]
    }],
    actions: {
      class: [{
        componentId: 42, name: 'Sneak Attack',
        dice: { diceCount: 3, diceValue: 6 },
        limitedUse: { maxUses: 1, resetType: 'turn' }
      }]
    }
  });
  const parsed = parseCharacter(raw);
  assert.strictEqual(parsed.classFeatures[0].dice, '3d6');
  assert.deepStrictEqual(parsed.classFeatures[0].uses, { max: 1, reset: 'turn' });
});

test('M10: parseClassFeatures prefers snippet over HTML description', () => {
  const raw = rawFixture({
    classes: [{
      definition: { name: 'Bard' }, level: 1,
      classFeatures: [
        classFeature({
          id: 1, name: 'Bardic Inspiration', level: 1,
          snippet: 'Inspire your allies.',
          description: '<p>A much longer wordy description...</p>'
        })
      ]
    }]
  });
  const parsed = parseCharacter(raw);
  assert.strictEqual(parsed.classFeatures[0].description, 'Inspire your allies.');
});

test('M10: parseClassFeatures strips HTML when snippet is missing', () => {
  const raw = rawFixture({
    classes: [{
      definition: { name: 'Druid' }, level: 1,
      classFeatures: [
        classFeature({
          id: 1, name: 'Druidic', level: 1,
          description: '<p>You can speak <em>Druidic</em>, a secret language.</p><p>Bonus paragraph.</p>'
        })
      ]
    }]
  });
  const parsed = parseCharacter(raw);
  // Only the first <p> block, tags stripped
  assert.strictEqual(parsed.classFeatures[0].description, 'You can speak Druidic, a secret language.');
});

test('M10: parseClassFeatures returns [] when no classes defined', () => {
  const raw = rawFixture({ classes: [] });
  const parsed = parseCharacter(raw);
  assert.deepStrictEqual(parsed.classFeatures, []);
});

test('M10: subclass features identified by feature.definition.classId !== base classId', () => {
  // Real D&DB data: every classFeatures entry carries `definition.classId`
  // pointing at the class (or subclass) the feature belongs to. The base
  // class id matches `classes[].definition.id`. Anything with a different
  // classId is a subclass feature.
  const raw = rawFixture({
    classes: [{
      definition: { id: 2, name: 'Cleric' }, level: 2,
      subclassDefinition: { id: 654582, name: 'Twilight Domain' },
      classFeatures: [
        classFeature({ id: 108, name: 'Spellcasting', level: 1, classId: 2 }),
        classFeature({ id: 555, name: 'Eyes of Night', level: 1, classId: 654582 }),
        classFeature({ id: 556, name: 'Channel Divinity: Twilight Sanctuary', level: 2, classId: 654582 })
      ]
    }]
  });
  const parsed = parseCharacter(raw);
  const map = Object.fromEntries(parsed.classFeatures.map(f => [f.name, f.source]));
  assert.strictEqual(map['Spellcasting'], 'Cleric');
  assert.strictEqual(map['Eyes of Night'], 'Twilight Domain');
  assert.strictEqual(map['Channel Divinity: Twilight Sanctuary'], 'Twilight Domain');
});

test('M10: limitedUse with numeric resetType maps to a label', () => {
  // resetType=1 → short rest, resetType=2 → long rest (D&DB enum).
  const raw = rawFixture({
    classes: [{
      definition: { name: 'Cleric' }, level: 2,
      classFeatures: [classFeature({ id: 110, name: 'Channel Divinity', level: 2 })]
    }],
    actions: {
      class: [{
        componentId: 110, name: 'Channel Divinity',
        limitedUse: { maxUses: 1, resetType: 1 }
      }]
    }
  });
  const parsed = parseCharacter(raw);
  assert.deepStrictEqual(parsed.classFeatures[0].uses, { max: 1, reset: 'short rest' });
});

test('M10: stripHtml removes D&DB templating tokens like {{modifier:wis@min:1}}', () => {
  const raw = rawFixture({
    classes: [{
      definition: { name: 'Cleric' }, level: 1,
      classFeatures: [classFeature({
        id: 1, name: 'Eyes of Night', level: 1,
        snippet: 'You share darkvision with up to {{modifier:wis@min:1}} creatures.'
      })]
    }]
  });
  const parsed = parseCharacter(raw);
  assert.ok(!parsed.classFeatures[0].description.includes('{{'),
    `template still present: ${parsed.classFeatures[0].description}`);
  assert.ok(parsed.classFeatures[0].description.includes('creatures'));
});

// ---- M12: parseCombatModifiers ----

test('M12: item modifier — bonus subType for spell-attacks from attuned item', () => {
  const raw = rawFixture({
    inventory: [{
      equipped: true, isAttuned: true,
      definition: { id: 9999, name: 'Amulet of the Devout, +1', type: 'Wondrous item', filterType: 'Wondrous item', canAttune: true, magic: true }
    }],
    modifiers: { item: [
      { type: 'bonus', subType: 'spell-attacks', value: 1, fixedValue: 1, componentId: 9999 },
      { type: 'bonus', subType: 'spell-save-dc', value: 1, fixedValue: 1, componentId: 9999 }
    ]}
  });
  const parsed = parseCharacter(raw);
  assert.strictEqual(parsed.combatMods.length, 2);
  const atk = parsed.combatMods.find(m => m.subType === 'spell-attacks');
  assert.strictEqual(atk.source, 'Amulet of the Devout, +1');
  assert.strictEqual(atk.kind, 'attack');
  assert.strictEqual(atk.scope, 'spell');
  assert.strictEqual(atk.value, 1);
  assert.strictEqual(atk.inactive, false);
});

test('M12: item modifier — inactive when item requires attunement and is unattuned', () => {
  const raw = rawFixture({
    inventory: [{
      equipped: true, isAttuned: false,
      definition: { id: 9999, name: 'Amulet of the Devout, +1', canAttune: true, magic: true }
    }],
    modifiers: { item: [
      { type: 'bonus', subType: 'spell-attacks', value: 1, fixedValue: 1, componentId: 9999 }
    ]}
  });
  const parsed = parseCharacter(raw);
  assert.strictEqual(parsed.combatMods[0].inactive, true);
  assert.strictEqual(parsed.combatMods[0].requiresAttunement, true);
});

test('M12: feat modifier — bonus carries through with feat name as source', () => {
  const raw = rawFixture({
    feats: [{ definition: { id: 1234, name: 'Sharpshooter' }, componentTypeId: 1, componentId: 1234 }],
    modifiers: { feat: [
      { type: 'bonus', subType: 'ranged-weapon-attacks', value: 0, fixedValue: 0, componentId: 1234 },
      { type: 'bonus', subType: 'ranged-weapon-damage', value: 10, fixedValue: 10, componentId: 1234 }
    ]}
  });
  const parsed = parseCharacter(raw);
  const dmg = parsed.combatMods.find(m => m.subType === 'ranged-weapon-damage');
  assert.strictEqual(dmg.source, 'Sharpshooter');
  assert.strictEqual(dmg.kind, 'damage');
  assert.strictEqual(dmg.scope, 'weapon-ranged');
  // Zero-valued mod was filtered out
  assert.strictEqual(parsed.combatMods.filter(m => m.subType === 'ranged-weapon-attacks').length, 0);
});

test('M12: ignores non-bonus types (advantage, proficiency, set)', () => {
  const raw = rawFixture({
    modifiers: { feat: [
      { type: 'proficiency', subType: 'constitution-saving-throws', value: null, fixedValue: null, componentId: 1 },
      { type: 'advantage',   subType: 'attack-rolls',                value: null, fixedValue: null, componentId: 1 },
      { type: 'set',         subType: 'subclass',                    value: null, fixedValue: null, componentId: 1 }
    ]}
  });
  const parsed = parseCharacter(raw);
  assert.deepStrictEqual(parsed.combatMods, []);
});

test('M12: ignores subTypes that are not combat-relevant', () => {
  const raw = rawFixture({
    modifiers: { race: [
      { type: 'bonus', subType: 'speed', value: 5, fixedValue: 5, componentId: 1 },
      { type: 'bonus', subType: 'wisdom-score', value: 2, fixedValue: 2, componentId: 2 }
    ]}
  });
  const parsed = parseCharacter(raw);
  assert.deepStrictEqual(parsed.combatMods, []);
});

test('M12: classifies subTypes into kind/scope correctly', () => {
  const raw = rawFixture({
    modifiers: { item: [
      { type: 'bonus', subType: 'melee-weapon-attacks',  value: 1, componentId: 1 },
      { type: 'bonus', subType: 'ranged-weapon-damage',  value: 2, componentId: 1 },
      { type: 'bonus', subType: 'armor-class',           value: 1, componentId: 1 },
      { type: 'bonus', subType: 'dexterity-saving-throws', value: 1, componentId: 1 },
      { type: 'bonus', subType: 'initiative',            value: 5, componentId: 1 }
    ]}
  });
  const parsed = parseCharacter(raw);
  const get = (st) => parsed.combatMods.find(m => m.subType === st);
  assert.strictEqual(get('melee-weapon-attacks').kind, 'attack');
  assert.strictEqual(get('melee-weapon-attacks').scope, 'weapon-melee');
  assert.strictEqual(get('ranged-weapon-damage').kind, 'damage');
  assert.strictEqual(get('ranged-weapon-damage').scope, 'weapon-ranged');
  assert.strictEqual(get('armor-class').kind, 'ac');
  assert.strictEqual(get('dexterity-saving-throws').kind, 'save');
  assert.strictEqual(get('dexterity-saving-throws').scope, 'dex');
  assert.strictEqual(get('initiative').kind, 'initiative');
});

test('M12: parseCombatModifiers returns [] when raw has no modifiers', () => {
  const raw = rawFixture({});
  const parsed = parseCharacter(raw);
  assert.deepStrictEqual(parsed.combatMods, []);
});

// ---- M18: parseSpells ----

function spellEntry({ name, level, prepared = true, alwaysPrepared = false,
                     requiresAttackRoll = false, requiresSavingThrow = false,
                     saveDcAbilityId = null, range = { rangeValue: 60 },
                     dieString = '1d8', damageSubType = 'fire-damage',
                     concentration = false, ritual = false,
                     spellCastingAbilityId = null,
                     usesSpellSlot = true }) {
  return {
    prepared, alwaysPrepared, usesSpellSlot,
    castAtLevel: level,
    spellCastingAbilityId,
    definition: {
      id: Math.floor(Math.random() * 1e6),
      name, level, school: 'Evocation',
      range: { origin: 'Ranged', ...range },
      duration: concentration ? { durationType: 'Concentration' } : { durationType: 'Instantaneous' },
      ritual,
      requiresAttackRoll, requiresSavingThrow, saveDcAbilityId,
      modifiers: [{
        type: 'bonus', subType: damageSubType,
        die: { diceString: dieString }
      }]
    }
  };
}

test('M18: parseSpells extracts prepared attack-roll spells with dice + range', () => {
  const raw = rawFixture({
    classSpells: [{
      characterClassId: 1, spellCastingAbilityId: 5,
      spells: [spellEntry({
        name: 'Guiding Bolt', level: 1, requiresAttackRoll: true,
        range: { rangeValue: 120 }, dieString: '4d6',
        damageSubType: 'radiant-damage'
      })]
    }]
  });
  const parsed = parseCharacter(raw);
  const s = parsed.spells.find(x => x.name === 'Guiding Bolt');
  assert.ok(s);
  assert.strictEqual(s.level, 1);
  assert.strictEqual(s.requiresAttackRoll, true);
  assert.strictEqual(s.kind, 'spell-attack');
  assert.strictEqual(s.dice, '4d6');
  assert.strictEqual(s.damageType, 'Radiant');
  assert.deepStrictEqual(s.range, { kind: 'ranged', feet: 120 });
  assert.strictEqual(s.spellCastingAbility, 'WIS');
});

test('M18: parseSpells extracts save-based cantrips with saveStat', () => {
  const raw = rawFixture({
    classSpells: [{
      characterClassId: 1, spellCastingAbilityId: 5,
      spells: [spellEntry({
        name: 'Sacred Flame', level: 0, requiresSavingThrow: true,
        saveDcAbilityId: 2, range: { rangeValue: 60 }, dieString: '1d8',
        damageSubType: 'radiant-damage'
      })]
    }]
  });
  const parsed = parseCharacter(raw);
  const s = parsed.spells.find(x => x.name === 'Sacred Flame');
  assert.strictEqual(s.kind, 'spell-save');
  assert.strictEqual(s.saveStat, 'DEX');
  assert.strictEqual(s.level, 0);
});

test('M18: parseSpells respects prepared flag — unprepared leveled spells excluded', () => {
  const raw = rawFixture({
    classSpells: [{
      characterClassId: 1, spellCastingAbilityId: 5,
      spells: [
        spellEntry({ name: 'Bless', level: 1, prepared: false }),
        spellEntry({ name: 'Sacred Flame', level: 0, prepared: false,
          requiresSavingThrow: true, saveDcAbilityId: 2 })   // cantrip — always accessible
      ]
    }]
  });
  const parsed = parseCharacter(raw);
  assert.strictEqual(parsed.spells.find(s => s.name === 'Bless'), undefined,
    'unprepared leveled spell should be filtered');
  assert.ok(parsed.spells.find(s => s.name === 'Sacred Flame'),
    'cantrips should be included even when prepared=false');
});

test('M18: parseSpells alwaysPrepared (Twilight Domain Spells) included', () => {
  const raw = rawFixture({
    classSpells: [{
      characterClassId: 1, spellCastingAbilityId: 5,
      spells: [spellEntry({
        name: 'Faerie Fire', level: 1, prepared: false, alwaysPrepared: true,
        requiresSavingThrow: true, saveDcAbilityId: 2
      })]
    }]
  });
  const parsed = parseCharacter(raw);
  assert.ok(parsed.spells.find(s => s.name === 'Faerie Fire'));
});

test('M18: parseSpells healing spells get kind=heal', () => {
  const raw = rawFixture({
    classSpells: [{
      characterClassId: 1, spellCastingAbilityId: 5,
      spells: [{
        prepared: true, usesSpellSlot: true, castAtLevel: 1,
        definition: {
          id: 1, name: 'Cure Wounds', level: 1, school: 'Evocation',
          range: { origin: 'Touch' },
          healingDice: [{ diceString: '1d8' }],
          modifiers: []
        }
      }]
    }]
  });
  const parsed = parseCharacter(raw);
  const s = parsed.spells.find(x => x.name === 'Cure Wounds');
  assert.strictEqual(s.kind, 'heal');
  assert.strictEqual(s.dice, '1d8');
  assert.deepStrictEqual(s.range, { kind: 'touch', feet: 0 });
});

test('M18: parseSpells utility spells (Bless) get kind=utility', () => {
  const raw = rawFixture({
    classSpells: [{
      characterClassId: 1, spellCastingAbilityId: 5,
      spells: [{
        prepared: true, usesSpellSlot: true, castAtLevel: 1,
        definition: {
          id: 1, name: 'Bless', level: 1, school: 'Enchantment',
          range: { origin: 'Ranged', rangeValue: 30 },
          requiresAttackRoll: false, requiresSavingThrow: false,
          modifiers: []
        }
      }]
    }]
  });
  const parsed = parseCharacter(raw);
  const s = parsed.spells.find(x => x.name === 'Bless');
  assert.strictEqual(s.kind, 'utility');
});
