import { test } from 'node:test';
import assert from 'node:assert';
import { parseCharacter, parseSpellSlotTable, scrubRawCharacter, formatUsesWithUsed, parseDamageDefenses } from '../lib/ddb-parser.js';
import { applyDamage } from '../../src/js/scene/combat-engine.js';
import { parsedDdbFixture, loadDdbFixture } from '../../src/tests/helpers/entities.js';

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

// ---- M21: save metadata ----

test('M21: parseSavingThrowProficiencies extracts proficient saves from class modifiers', () => {
  const raw = rawFixture({
    modifiers: { class: [
      { type: 'proficiency', subType: 'wisdom-saving-throws' },
      { type: 'proficiency', subType: 'charisma-saving-throws' },
      { type: 'proficiency', subType: 'longsword' }   // not a save — ignored
    ]}
  });
  const parsed = parseCharacter(raw);
  assert.deepStrictEqual(parsed.savingThrowProficiencies.sort(), ['CHA', 'WIS']);
});

test('M21: parseSavingThrowProficiencies picks up feat-granted saves (Resilient)', () => {
  const raw = rawFixture({
    modifiers: { feat: [
      { type: 'proficiency', subType: 'constitution-saving-throws' }
    ]}
  });
  const parsed = parseCharacter(raw);
  assert.deepStrictEqual(parsed.savingThrowProficiencies, ['CON']);
});

test('M21: parseSpells — saveOnHalf detected from "half as much damage" phrasing', () => {
  const raw = rawFixture({
    classSpells: [{
      characterClassId: 1, spellCastingAbilityId: 5,
      spells: [{
        prepared: true, usesSpellSlot: true, castAtLevel: 3,
        definition: {
          id: 1, name: 'Fireball', level: 3, school: 'Evocation',
          range: { origin: 'Ranged', rangeValue: 150 },
          requiresSavingThrow: true, saveDcAbilityId: 2,
          description: '...takes 8d6 fire damage on a failed save, or half as much damage on a successful one.',
          modifiers: [{ subType: 'fire-damage', die: { diceString: '8d6' } }]
        }
      }]
    }]
  });
  const parsed = parseCharacter(raw);
  const s = parsed.spells.find(x => x.name === 'Fireball');
  assert.strictEqual(s.saveOnHalf, true);
});

test('M21: parseSpells — saveOnHalf=false for cantrips with no half-on-save text', () => {
  const raw = rawFixture({
    classSpells: [{
      characterClassId: 1, spellCastingAbilityId: 5,
      spells: [{
        prepared: true, usesSpellSlot: false, castAtLevel: 0,
        definition: {
          id: 1, name: 'Sacred Flame', level: 0,
          range: { origin: 'Ranged', rangeValue: 60 },
          requiresSavingThrow: true, saveDcAbilityId: 2,
          description: 'The target must succeed on a Dexterity saving throw or take 1d8 radiant damage.',
          modifiers: [{ subType: 'radiant-damage', die: { diceString: '1d8' } }]
        }
      }]
    }]
  });
  const parsed = parseCharacter(raw);
  const s = parsed.spells.find(x => x.name === 'Sacred Flame');
  assert.strictEqual(s.saveOnHalf, false);
});

// ---- primary-weapon promotion (iconic weapon → mainhand) ----

const weaponItem = (name, diceString, { twoHanded = false, damageType = 'Slashing' } = {}) => ({
  equipped: true,
  definition: {
    name, filterType: 'Weapon',
    damage: { diceString }, damageType,
    properties: twoHanded ? [{ name: 'Two-Handed' }] : []
  }
});

test('promote: a warhammer cleric who lists a shortsword first still wields the warhammer', () => {
  const raw = rawFixture({
    classes: [{ definition: { name: 'Cleric' }, level: 5 }],
    inventory: [
      weaponItem('Shortsword', '1d6', { damageType: 'Piercing' }),   // first → parser mainhand
      weaponItem('Warhammer', '1d8', { damageType: 'Bludgeoning' }),
      weaponItem('Hand Crossbow', '1d6', { damageType: 'Piercing' })
    ]
  });
  const parsed = parseCharacter(raw);
  assert.strictEqual(parsed.equipment.mainhand.name, 'Warhammer', 'iconic weapon promoted');
  assert.strictEqual(parsed.equipment.mainhand.damage, '1d8');
  assert.strictEqual(parsed.equipment.mainhand.damageType, 'Bludgeoning', 'combat now reads the warhammer');
  // invariant: exactly one carried weapon holds mainhand, matching equipment
  const mains = parsed.carried.filter(c => c.slot === 'mainhand');
  assert.strictEqual(mains.length, 1);
  assert.strictEqual(mains[0].name, 'Warhammer');
  // the displaced shortsword goes to overflow (client sheathes it to back/waist)
  assert.strictEqual(parsed.carried.find(c => c.name === 'Shortsword').slot, 'overflow');
});

test('promote: a two-handed primary frees the off hand', () => {
  const raw = rawFixture({
    classes: [{ definition: { name: 'Fighter' }, level: 6 }],
    inventory: [
      weaponItem('Handaxe', '1d6'),                              // first
      weaponItem('Greatsword', '2d6', { twoHanded: true })
    ]
  });
  const parsed = parseCharacter(raw);
  assert.strictEqual(parsed.equipment.mainhand.name, 'Greatsword');
  assert.strictEqual(parsed.equipment.mainhand.twoHanded, true);
  assert.strictEqual(parsed.equipment.offhand, null, '2H weapon nulls the off hand');
});

test('promote: idempotent — a single-weapon character is unchanged', () => {
  const raw = rawFixture({
    classes: [{ definition: { name: 'Rogue' }, level: 4 }],
    inventory: [weaponItem('Dagger', '1d4', { damageType: 'Piercing' })]
  });
  const parsed = parseCharacter(raw);
  assert.strictEqual(parsed.equipment.mainhand.name, 'Dagger');
});

// ── R5: armorTypeId survives into equipment ────────────────────────────

test('R5: parseEquipment keeps DDB armorTypeId on armor and shield', () => {
  const parsed = parseCharacter(rawFixture({
    inventory: [
      { equipped: true, definition: { id: 1, name: 'Breastplate', filterType: 'Armor', type: 'Medium Armor', armorClass: 14, armorTypeId: 2 } },
      { equipped: true, definition: { id: 2, name: 'Shield', filterType: 'Armor', type: 'Shield', armorClass: 2, armorTypeId: 4 } }
    ]
  }));
  assert.strictEqual(parsed.equipment.armor.armorTypeId, 2);
  assert.strictEqual(parsed.equipment.offhand.armorTypeId, 4);
  assert.strictEqual(parsed.carried.find(c => c.name === 'Breastplate').armorTypeId, 2);
});

test('R5: armorTypeId defaults to null when DDB omits it', () => {
  const parsed = parseCharacter(rawFixture({
    inventory: [{ equipped: true, definition: { id: 1, name: 'Leather', filterType: 'Armor', armorClass: 11 } }]
  }));
  assert.strictEqual(parsed.equipment.armor.armorTypeId, null);
});

// ── R6: weapon rules data + weapon proficiencies ───────────────────────

// Real DDB weapon shape (verified against a real export): properties carry
// { id, name, notes }, mastery tags (Vex, Push) and the "Range" marker.
function r6Weapon(name, def = {}, item = {}) {
  return {
    equipped: true, isAttuned: false, quantity: 1, ...item,
    definition: { id: def.id ?? 7000, name, filterType: 'Weapon', type: name, rarity: 'Common', magic: false, grantedModifiers: [], ...def }
  };
}

test('R6: weapon summaries keep properties, attackType, range, monk flag, category and slug', () => {
  const parsed = parseCharacter(rawFixture({
    inventory: [
      r6Weapon('Crossbow, Hand', {
        id: 1, damage: { diceString: '1d6' }, damageType: 'Piercing', attackType: 2, range: 30, longRange: 120,
        isMonkWeapon: false, categoryId: 2,
        properties: [{ id: 1, name: 'Ammunition', notes: null }, { id: 7, name: 'Range', notes: null },
          { id: 4, name: 'Light', notes: null }, { id: 5, name: 'Loading', notes: null }, { id: 25, name: 'Vex', notes: null }]
      }),
      r6Weapon('Shortsword', {
        id: 2, damage: { diceString: '1d6' }, attackType: 1, range: 5, longRange: 5, isMonkWeapon: true, categoryId: 2,
        properties: [{ id: 3, name: 'Finesse', notes: null }, { id: 4, name: 'Light', notes: null }]
      })
    ]
  }));
  const xbow = parsed.carried.find(c => c.name === 'Crossbow, Hand');
  assert.deepStrictEqual(xbow.properties, ['ammunition', 'light', 'loading']);
  assert.strictEqual(xbow.attackType, 2);
  assert.strictEqual(xbow.range, 30);
  assert.strictEqual(xbow.longRange, 120);
  assert.strictEqual(xbow.weaponCategory, 'martial');
  assert.strictEqual(xbow.weaponType, 'crossbow-hand');
  const ss = parsed.carried.find(c => c.name === 'Shortsword');
  assert.deepStrictEqual(ss.properties, ['finesse', 'light']);
  assert.strictEqual(ss.isMonkWeapon, true);
  assert.strictEqual(ss.magicBonus, null);
});

test('R6: versatile die comes from the Versatile property notes; promoted mainhand keeps the fields', () => {
  const parsed = parseCharacter(rawFixture({
    classes: [{ definition: { name: 'Cleric' }, level: 4 }],
    inventory: [
      r6Weapon('Shortsword', { id: 1, damage: { diceString: '1d6' }, attackType: 1, properties: [{ name: 'Finesse' }, { name: 'Light' }] }),
      r6Weapon('Warhammer', {
        id: 2, damage: { diceString: '1d8' }, damageType: 'Bludgeoning', attackType: 1, range: 5, longRange: 5, categoryId: 2,
        properties: [{ id: 12, name: 'Versatile', notes: '1d10' }, { id: 21, name: 'Push', notes: null }]
      })
    ]
  }));
  const main = parsed.equipment.mainhand;
  assert.strictEqual(main.name, 'Warhammer', 'cleric promotes the warhammer');
  assert.deepStrictEqual(main.properties, ['versatile']);
  assert.strictEqual(main.versatileDamage, '1d10');
  assert.strictEqual(main.attackType, 1);
  assert.strictEqual(main.weaponCategory, 'martial');
});

test('R6: magic bonus comes from grantedModifiers (bonus/magic), gated by attunement', () => {
  const magic = (value, requiresAttunement = false) => ({ type: 'bonus', subType: 'magic', value, fixedValue: value, requiresAttunement });
  const parsed = parseCharacter(rawFixture({
    inventory: [
      r6Weapon('Longsword', { id: 1, magic: true, damage: { diceString: '1d8' }, attackType: 1, grantedModifiers: [magic(1)] }),
      r6Weapon('Flame Tongue Longsword', { id: 2, magic: true, canAttune: true, damage: { diceString: '1d8' }, attackType: 1, grantedModifiers: [magic(2, true)] }, { equipped: true, isAttuned: false }),
      r6Weapon('Dagger +3', { id: 3, damage: { diceString: '1d4' }, attackType: 1 })
    ]
  }));
  const by = (n) => parsed.carried.find(c => c.name === n);
  assert.strictEqual(by('Longsword').magicBonus, 1, 'name has no +N; the modifier supplies it');
  assert.strictEqual(by('Flame Tongue Longsword').magicBonus, 0, 'unattuned');
  assert.strictEqual(by('Dagger +3').magicBonus, null, 'no modifier: downstream falls back to the name');
});

test('R6: non-weapon items carry no weapon fields', () => {
  const parsed = parseCharacter(rawFixture({
    inventory: [{ equipped: true, definition: { id: 1, name: 'Chain Mail', filterType: 'Armor', armorClass: 16, armorTypeId: 3 } }]
  }));
  assert.strictEqual(parsed.equipment.armor.properties, undefined);
  assert.strictEqual(parsed.equipment.armor.attackType, undefined);
});

test('R6: weaponProficiencies collects weapon rows only', () => {
  const p = (subType, entityTypeId) => ({ type: 'proficiency', subType, entityTypeId });
  const parsed = parseCharacter(rawFixture({
    modifiers: {
      class: [p('simple-weapons', 660121713), p('light-armor', 174869515), p('wisdom-saving-throws'), p('insight', 1958004211)],
      race: [p('longsword', 1782728300), p('shortbow')],
      background: [p('drum', 2103445194)],
      feat: [], item: []
    }
  }));
  assert.deepStrictEqual([...parsed.weaponProficiencies].sort(), ['longsword', 'shortbow', 'simple-weapons']);
  assert.deepStrictEqual(parseCharacter(rawFixture()).weaponProficiencies, []);
});

// ── R14: parser completeness (synthetic fixtures in the real DDB shape) ──

test('R14: feat-granted Misty Step is kept with source, sourceName and uses', () => {
  const p = parsedDdbFixture('cleric-l5');
  const misty = p.spells.find(s => s.name === 'Misty Step');
  assert.ok(misty, 'Fey Touched Misty Step parsed despite prepared:false');
  assert.strictEqual(misty.level, 2);
  assert.strictEqual(misty.source, 'feat');
  assert.strictEqual(misty.sourceName, 'Fey Touched');
  assert.deepStrictEqual(misty.uses, { max: 1, used: 0, reset: 'long rest' });
  assert.strictEqual(misty.usesSpellSlot, false);
  assert.strictEqual(misty.spellCastingAbility, 'WIS');
  const flame = p.spells.find(s => s.name === 'Sacred Flame');
  assert.strictEqual(flame.source, 'class');
  assert.strictEqual(flame.uses, null);
});

test('R14: a granted leveled spell with no uses and not prepared stays filtered', () => {
  const parsed = parseCharacter(rawFixture({
    spells: { race: [], item: [], background: [], feat: [
      { prepared: false, alwaysPrepared: false, limitedUse: null, definition: { name: 'Identify', level: 1 } },
      { prepared: false, alwaysPrepared: false, limitedUse: { maxUses: 1, numberUsed: 1, resetType: 2 }, definition: { name: 'Hex', level: 1 } }
    ] }
  }));
  assert.deepStrictEqual(parsed.spells.map(s => s.name), ['Hex']);
  assert.deepStrictEqual(parsed.spells[0].uses, { max: 1, used: 1, reset: 'long rest' });
});

test('R14: bonus/hit-points modifiers with a die classify as heal; Aid stays utility', () => {
  const p = parsedDdbFixture('cleric-l5');
  const hw = p.spells.find(s => s.name === 'Healing Word');
  assert.strictEqual(hw.kind, 'heal');
  assert.strictEqual(hw.dice, '1d4');
  const parsed = parseCharacter(rawFixture({
    classSpells: [{ characterClassId: 1, spells: [
      { prepared: true, definition: { name: 'Prayer of Healing', level: 2, modifiers: [{ type: 'bonus', subType: 'hit-points', die: { diceString: '2d8' } }] } },
      { prepared: true, definition: { name: 'Aid', level: 2, modifiers: [{ type: 'bonus', subType: 'hit-points', die: null }] } }
    ] }]
  }));
  const kinds = Object.fromEntries(parsed.spells.map(s => [s.name, s.kind]));
  assert.deepStrictEqual(kinds, { Aid: 'utility', 'Prayer of Healing': 'heal' });
});

test('R14: real-shape damage modifiers ({type:"damage", subType:"radiant"}) give a damageType', () => {
  const parsed = parseCharacter(rawFixture({
    classSpells: [{ characterClassId: 1, spells: [
      { prepared: false, definition: { name: 'Toll the Dead', level: 0, requiresSavingThrow: true, saveDcAbilityId: 5,
        modifiers: [{ type: 'damage', subType: 'necrotic', die: { diceString: '1d8' } }] } }
    ] }]
  }));
  assert.strictEqual(parsed.spells[0].damageType, 'Necrotic');
  assert.strictEqual(parsed.spells[0].dice, '1d8');
});

test('R14: Channel Divinity keeps its uses when Turn Undead shares its componentId', () => {
  const p = parsedDdbFixture('cleric-l5');
  assert.deepStrictEqual(p.classFeatures.find(f => f.name === 'Channel Divinity').uses, { max: 1, reset: 'short rest' });
  // Order does not matter: the sub-action listed first must not win either.
  const raw = loadDdbFixture('cleric-l5');
  raw.actions.class.reverse();
  assert.deepStrictEqual(parseCharacter(raw).classFeatures.find(f => f.name === 'Channel Divinity').uses, { max: 1, reset: 'short rest' });
});

test('R14: hp.temp carries DDB temporaryHitPoints', () => {
  const p = parsedDdbFixture('cleric-l5');
  assert.strictEqual(p.hp.temp, 5);
  assert.strictEqual(p.hp.current, p.hp.max, 'temp HP does not change current');
});

test('R14: DDB conditions map to engine ids with the exhaustion level; conditions stays empty', () => {
  const p = parsedDdbFixture('fighter-l5');
  assert.deepStrictEqual(p.ddbConditions, [
    { id: 'exhaustion', name: 'Exhaustion', level: 2 },
    { id: 'prone', name: 'Prone', level: null }
  ]);
  assert.deepStrictEqual(p.conditions, [], 'imports start clean; the DM toggle applies ddbConditions');
  const odd = parseCharacter(rawFixture({ conditions: [{ id: 99 }, { id: 9, level: null }, { id: 4, level: null }] }));
  assert.deepStrictEqual(odd.ddbConditions.map(c => [c.id, c.level]), [['paralyzed', null], ['exhaustion', 1]]);
  assert.deepStrictEqual(parseCharacter(rawFixture()).ddbConditions, []);
});

test('R14: slotsUsed reads spellSlots[].used and pactMagic[].used by level', () => {
  const p = parsedDdbFixture('wizard-l5');
  assert.deepStrictEqual(p.slotsUsed.spell, { 1: 1, 2: 0, 3: 1, 4: 0, 5: 0, 6: 0, 7: 0, 8: 0, 9: 0 });
  assert.deepStrictEqual(p.slotsUsed.pact, { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 });
  assert.deepStrictEqual(parseCharacter(rawFixture()).slotsUsed, { spell: {}, pact: {} });
});

test('R14: currentXp is parsed (0 when absent)', () => {
  assert.strictEqual(parsedDdbFixture('fighter-l5').currentXp, 6500);
  assert.strictEqual(parseCharacter(rawFixture()).currentXp, 0);
});

test('R14: spellSlotTable takes slot maximums from DDB spellRules', () => {
  const wiz = parsedDdbFixture('wizard-l5').spellSlotTable;
  assert.deepStrictEqual(wiz.spell, { 1: 4, 2: 3, 3: 2 });
  assert.strictEqual(wiz.pact, null);
  assert.deepStrictEqual(wiz.classes.map(c => [c.name, c.level, c.divisor, c.pact]), [['Wizard', 5, 1, false]]);
  const fighter = parsedDdbFixture('fighter-l5').spellSlotTable;
  assert.deepStrictEqual(fighter, { classes: [], spell: {}, pact: null });
});

// Minimal DDB class rows for multiclass slot math.
const FULL_TABLE = loadDdbFixture('wizard-l5').classes[0].definition.spellRules.levelSpellSlots;
const HALF_TABLE = [[0,0,0,0,0,0,0,0,0], [0,0,0,0,0,0,0,0,0], [2,0,0,0,0,0,0,0,0], [3,0,0,0,0,0,0,0,0], [3,0,0,0,0,0,0,0,0], [4,2,0,0,0,0,0,0,0]];
const PACT_TABLE = [[0,0,0,0,0,0,0,0,0], [1,0,0,0,0,0,0,0,0], [0,2,0,0,0,0,0,0,0], [0,2,0,0,0,0,0,0,0], [0,0,2,0,0,0,0,0,0], [0,0,2,0,0,0,0,0,0]];
const ddbClass = (name, level, table, divisor = 1, rounding = 1) => ({
  level, definition: { name, spellRules: { levelSpellSlots: table, multiClassSpellSlotDivisor: divisor, multiClassSpellSlotRounding: rounding } }
});

test('R14: spellSlotTable combines multiclass casters through the PHB table', () => {
  // Wizard 3 / Cleric 3 → caster level 6 → 4/3/3
  assert.deepStrictEqual(parseSpellSlotTable({ classes: [ddbClass('Wizard', 3, FULL_TABLE), ddbClass('Cleric', 3, FULL_TABLE)] }).spell, { 1: 4, 2: 3, 3: 3 });
  // Paladin 4 (half, round down) / Sorcerer 4 → 2 + 4 = 6 → 4/3/3
  assert.deepStrictEqual(parseSpellSlotTable({ classes: [ddbClass('Paladin', 4, HALF_TABLE, 2), ddbClass('Sorcerer', 4, FULL_TABLE)] }).spell, { 1: 4, 2: 3, 3: 3 });
  // Artificer 3 (half, round up) / Wizard 1 → 2 + 1 = 3 → 4/2
  assert.deepStrictEqual(parseSpellSlotTable({ classes: [ddbClass('Artificer', 3, HALF_TABLE, 2, 2), ddbClass('Wizard', 1, FULL_TABLE)] }).spell, { 1: 4, 2: 2 });
  // A single half-caster uses its own row: Paladin 5 → 4/2
  assert.deepStrictEqual(parseSpellSlotTable({ classes: [ddbClass('Paladin', 5, HALF_TABLE, 2)] }).spell, { 1: 4, 2: 2 });
});

test('R14: Warlock Pact Magic is kept apart from the spell slots', () => {
  const t = parseSpellSlotTable({ classes: [ddbClass('Warlock', 5, PACT_TABLE), ddbClass('Sorcerer', 2, FULL_TABLE)] });
  assert.deepStrictEqual(t.pact, { level: 3, max: 2 });
  assert.deepStrictEqual(t.spell, { 1: 3 }, 'only the Sorcerer feeds the spell-slot table');
});

test('R14: inventory lists every item with quantity and charges; equipment is unchanged', () => {
  const p = parsedDdbFixture('fighter-l5');
  const potion = p.inventory.find(i => i.name === 'Potion of Healing');
  assert.deepStrictEqual(potion, {
    name: 'Potion of Healing', quantity: 2, equipped: false, attuned: false, magical: true, rarity: 'Common',
    filterType: 'Potion', type: 'Potion', subType: null, consumable: true, uses: null
  });
  assert.ok(p.inventory.find(i => i.name === 'Longsword').equipped);
  assert.strictEqual(p.carried.some(c => c.name === 'Potion of Healing'), false);
  const charged = parseCharacter(rawFixture({
    inventory: [{ equipped: true, isAttuned: true, quantity: 1, limitedUse: { maxUses: 1, numberUsed: 1, resetType: 'Dawn' },
      definition: { id: 1, name: 'Amulet of the Devout, +1', filterType: 'Wondrous item', magic: true, rarity: 'Uncommon' } }]
  }));
  assert.deepStrictEqual(charged.inventory[0].uses, { max: 1, used: 1, reset: 'dawn' });
});

test('R14: racial traits by name, hidden ones skipped', () => {
  assert.deepStrictEqual(parsedDdbFixture('fighter-l5').racialTraits, ['Ability Score Increase']);
  const parsed = parseCharacter(rawFixture({
    race: { fullName: 'Half-Orc', baseRaceName: 'Half-Orc', racialTraits: [
      { definition: { name: 'Relentless Endurance', hideInSheet: false } },
      { definition: { name: 'Savage Attacks', hideInSheet: false } },
      { definition: { name: 'Speed', hideInSheet: true } }
    ] }
  }));
  assert.deepStrictEqual(parsed.racialTraits, ['Relentless Endurance', 'Savage Attacks']);
  assert.deepStrictEqual(parseCharacter(rawFixture()).racialTraits, []);
});

test('R14: formatUsesWithUsed clamps used into [0, max]', () => {
  assert.deepStrictEqual(formatUsesWithUsed({ maxUses: 2, numberUsed: 5, resetType: 1 }), { max: 2, used: 2, reset: 'short rest' });
  assert.strictEqual(formatUsesWithUsed({ maxUses: 0 }), null);
  assert.strictEqual(formatUsesWithUsed(null), null);
});

test('R14: scrubRawCharacter drops campaign.characters without mutating the input', () => {
  const raw = rawFixture({ campaign: { id: 1, name: 'Camp', dmUsername: 'dm', characters: [{ userId: 2, username: 'other', characterId: 3, characterName: 'Other' }] } });
  const clean = scrubRawCharacter(raw);
  assert.strictEqual('characters' in clean.campaign, false);
  assert.strictEqual(clean.campaign.name, 'Camp');
  assert.strictEqual(clean.name, raw.name);
  assert.strictEqual(raw.campaign.characters.length, 1, 'input untouched');
  const none = rawFixture();
  assert.strictEqual(scrubRawCharacter(none), none);
  assert.strictEqual(scrubRawCharacter(null), null);
  assert.deepStrictEqual(parseCharacter(clean).name, parseCharacter(raw).name);
});

// ── M64 phase 1.5: damage-type defenses from DDB modifiers ──

function defenseFixture() {
  return rawFixture({
    race: { fullName: 'Tiefling', baseRaceName: 'Tiefling', racialTraits: [
      { definition: { id: 801, name: 'Hellish Resistance' } }
    ] },
    feats: [{ definition: { id: 901, name: 'Infernal Constitution' } }],
    inventory: [
      { equipped: true, isAttuned: true, definition: { id: 701, name: 'Ring of Resistance (Cold)', canAttune: true } },
      { equipped: true, isAttuned: false, definition: { id: 702, name: 'Armor of Resistance (Acid)', canAttune: true } },
      { equipped: false, isAttuned: false, definition: { id: 703, name: 'Periapt of Proof against Poison', canAttune: false } }
    ],
    modifiers: {
      race: [{ type: 'resistance', subType: 'fire', componentId: 801 }],
      feat: [
        { type: 'resistance', subType: 'cold', componentId: 901 },
        { type: 'immunity', subType: 'poisoned', componentId: 901 }
      ],
      class: [{ type: 'resistance', subType: 'bludgeoning-piercing-and-slashing', restriction: 'while raging', componentId: 1 }],
      item: [
        { type: 'resistance', subType: 'cold', componentId: 701 },
        { type: 'resistance', subType: 'acid', componentId: 702 },
        { type: 'immunity', subType: 'poison', componentId: 703 }
      ],
      background: [{ type: 'vulnerability', subType: 'psychic', componentId: 5 }],
      condition: [{ type: 'resistance', subType: 'thunder', componentId: 6 }]
    }
  });
}

test('M64 1.5: resistance / immunity / vulnerability modifiers from race, feat, class, background and items', () => {
  const p = parseCharacter(defenseFixture());
  assert.deepStrictEqual(p.resistances, ['cold', 'fire']);
  assert.deepStrictEqual(p.immunities, []);
  assert.deepStrictEqual(p.vulnerabilities, ['psychic']);
  assert.deepStrictEqual(p.conditionImmunities, ['poisoned']);
  const src = (type) => p.defenseSources.filter(s => s.type === type).map(s => s.source);
  assert.deepStrictEqual(src('fire'), ['Hellish Resistance']);
  assert.deepStrictEqual(src('cold'), ['Infernal Constitution', 'Ring of Resistance (Cold)']);
  assert.deepStrictEqual(src('acid'), [], 'unattuned attunement item does not count');
  assert.deepStrictEqual(src('poison'), [], 'unequipped item does not count');
  assert.deepStrictEqual(src('thunder'), [], 'modifiers.condition rows are not character defenses');
});

test('M64 1.5: a restricted row ("while raging") is listed as conditional, not always-on', () => {
  const d = parseDamageDefenses(defenseFixture());
  const raging = d.sources.filter(s => s.restriction === 'while raging');
  assert.deepStrictEqual(raging.map(s => s.type), ['bludgeoning', 'piercing', 'slashing']);
  assert.ok(raging.every(s => s.conditional && s.kind === 'resistance' && s.bucket === 'class'));
  assert.ok(!d.resistances.includes('slashing'));
});

test('M64 1.5: no defense modifiers → empty lists; the synthetic fixtures parse clean', () => {
  const p = parseCharacter(rawFixture());
  assert.deepStrictEqual([p.resistances, p.immunities, p.vulnerabilities, p.conditionImmunities, p.defenseSources], [[], [], [], [], []]);
  assert.deepStrictEqual(parsedDdbFixture('fighter-l5').resistances, []);
  assert.deepStrictEqual(parseDamageDefenses({}).resistances, []);
});

test('M64 1.5: applyDamage halves fire against a parsed Tiefling sheet', () => {
  const sheet = parseCharacter(defenseFixture());
  const pc = { id: 'pc', kind: 'pc', name: 'T', hp: 30, hpMax: 30, hpTemp: 0, conditions: [], ref: sheet };
  applyDamage(pc, 10, 'fire', {});
  assert.strictEqual(pc.hp, 25);
});
