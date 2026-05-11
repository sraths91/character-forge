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
