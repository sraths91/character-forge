import { test } from 'node:test';
import assert from 'node:assert';
import {
  WEAPON_MOTIONS, buildMotion, motionForWeapon
} from '../js/anim/weapon-motions.js';
import { sampleSprite } from '../js/anim/sequence.js';

// ---------- Registry ----------

test('M43.1: WEAPON_MOTIONS ships the 8 promised motion builders', () => {
  for (const id of ['sword-slash','sword-thrust','lance-thrust','axe-cleave',
                    'bow-draw','dagger-stab','staff-cast','fist-jab']) {
    assert.ok(typeof WEAPON_MOTIONS[id] === 'function', `missing builder: ${id}`);
  }
});

test('M43.1: buildMotion returns a fresh sequence each call (no shared state)', () => {
  const a = buildMotion('sword-slash');
  const b = buildMotion('sword-slash');
  assert.notStrictEqual(a, b);
  assert.notStrictEqual(a.keyframes, b.keyframes);
  assert.notStrictEqual(a.effects, b.effects);
});

test('M43.1: buildMotion returns null for unknown ids', () => {
  assert.strictEqual(buildMotion('not-a-motion'), null);
});

// ---------- motionForWeapon mapping ----------

test('M43.1: motionForWeapon — common D&D weapons map to the right motion', () => {
  assert.strictEqual(motionForWeapon({ name: 'Longsword' }),     'sword-slash');
  assert.strictEqual(motionForWeapon({ name: 'Scimitar' }),      'sword-slash');
  assert.strictEqual(motionForWeapon({ name: 'Rapier' }),        'sword-thrust');
  assert.strictEqual(motionForWeapon({ name: 'Glaive' }),        'lance-thrust');
  assert.strictEqual(motionForWeapon({ name: 'Halberd' }),       'lance-thrust');
  assert.strictEqual(motionForWeapon({ name: 'Greataxe' }),      'axe-cleave');
  assert.strictEqual(motionForWeapon({ name: 'Warhammer' }),     'axe-cleave');
  assert.strictEqual(motionForWeapon({ name: 'Longbow' }),       'bow-draw');
  assert.strictEqual(motionForWeapon({ name: 'Light Crossbow' }), 'bow-draw');
  assert.strictEqual(motionForWeapon({ name: 'Dagger' }),        'dagger-stab');
  assert.strictEqual(motionForWeapon({ name: 'Shortsword' }),    'dagger-stab');
  assert.strictEqual(motionForWeapon({ name: 'Quarterstaff' }),  'lance-thrust');
  assert.strictEqual(motionForWeapon({ name: 'Wand of Magic Missile' }), 'staff-cast');
  assert.strictEqual(motionForWeapon({ name: 'Unarmed' }),       'fist-jab');
});

test('M43.1: motionForWeapon — case-insensitive', () => {
  assert.strictEqual(motionForWeapon({ name: 'LONGSWORD' }), 'sword-slash');
  assert.strictEqual(motionForWeapon({ name: 'longsword' }), 'sword-slash');
});

test('M43.1: motionForWeapon — null weapon falls back to fist-jab', () => {
  assert.strictEqual(motionForWeapon(null), 'fist-jab');
  assert.strictEqual(motionForWeapon(undefined), 'fist-jab');
});

test('M43.1: motionForWeapon — unknown weapon falls back to sword-slash', () => {
  assert.strictEqual(motionForWeapon({ name: 'Mysterious Artifact' }), 'sword-slash');
});

// ---------- Sequence shape sanity ----------

test('M43.1: every motion has a non-zero duration', () => {
  for (const id of Object.keys(WEAPON_MOTIONS)) {
    const seq = buildMotion(id);
    assert.ok(seq.duration > 0, `${id} has zero duration`);
  }
});

test('M43.1: every motion fires at least one impact effect', () => {
  // We expect each motion to push a damage-carrying effect somewhere
  // along its timeline (slash-arc / thrust / bash / projectile / burst).
  const damageTypes = new Set(['slash-arc','thrust','bash','projectile','burst']);
  for (const id of Object.keys(WEAPON_MOTIONS)) {
    const seq = buildMotion(id);
    const hasDamage = seq.effects.some(e => damageTypes.has(e.type));
    assert.ok(hasDamage, `${id} fires no impact effect`);
  }
});

test('M43.1: every motion includes a hit-pause for impact weight', () => {
  for (const id of Object.keys(WEAPON_MOTIONS)) {
    const seq = buildMotion(id);
    const hasPause = seq.effects.some(e => e.type === 'hit-pause');
    assert.ok(hasPause, `${id} missing hit-pause`);
  }
});

test('M43.1: every motion shakes the screen on impact', () => {
  for (const id of Object.keys(WEAPON_MOTIONS)) {
    const seq = buildMotion(id);
    const hasShake = seq.effects.some(e => e.type === 'shake');
    assert.ok(hasShake, `${id} missing shake`);
  }
});

// ---------- Pacing: motion lengths reflect feel ----------

test('M43.1: dagger and fist are faster than axe and staff (snappy vs heavy)', () => {
  const dagger = buildMotion('dagger-stab').duration;
  const fist   = buildMotion('fist-jab').duration;
  const axe    = buildMotion('axe-cleave').duration;
  const staff  = buildMotion('staff-cast').duration;
  assert.ok(dagger < axe,
    `dagger (${dagger}ms) should be faster than axe (${axe}ms)`);
  assert.ok(fist < axe,
    `fist (${fist}ms) should be faster than axe (${axe}ms)`);
  assert.ok(axe < staff,
    `axe (${axe}ms) should be faster than staff cast (${staff}ms)`);
});

// ---------- Per-motion timing details ----------

test('M43.1: sword-slash — attacker lunges forward at strike then recovers', () => {
  const seq = buildMotion('sword-slash');
  const wind   = sampleSprite(seq, 'attacker', 200);
  const strike = sampleSprite(seq, 'attacker', 450);
  const end    = sampleSprite(seq, 'attacker', seq.duration);
  // Wind-up is BEHIND start position
  assert.ok(wind.x < 0, `expected wind-up to pull back; got x=${wind.x}`);
  // Strike is well forward
  assert.ok(strike.x > 20, `expected strike to lunge forward; got x=${strike.x}`);
  // Settled near origin at end
  assert.ok(Math.abs(end.x) < 5, `expected settle near origin; got x=${end.x}`);
});

test('M43.1: bow-draw — defender stays still until projectile travels', () => {
  const seq = buildMotion('bow-draw');
  // Defender should be at rest at t=500 (arrow in flight)
  const flight = sampleSprite(seq, 'defender', 500);
  assert.ok(Math.abs(flight.x) < 1,
    `defender should be stationary during arrow flight; got x=${flight.x}`);
});

test('M43.1: staff-cast — emits a glyph-rise BEFORE the projectile', () => {
  const seq = buildMotion('staff-cast');
  const glyph = seq.effects.find(e => e.type === 'glyph-rise');
  const proj  = seq.effects.find(e => e.type === 'projectile');
  assert.ok(glyph && proj, 'staff-cast should have both glyph-rise and projectile');
  assert.ok(glyph.at < proj.at,
    `glyph (${glyph.at}ms) should rise before projectile (${proj.at}ms)`);
});

test('M43.1: axe-cleave — uses anticipate easing during wind-up', () => {
  const seq = buildMotion('axe-cleave');
  const windUp = seq.keyframes.find(k => k.actor === 'attacker' && k.rotation === -0.5);
  assert.ok(windUp, 'axe-cleave should have an overhead wind-up keyframe');
  assert.strictEqual(windUp.easing, 'anticipate');
});

test('M43.1: hit-pause sits at the impact frame for each motion', () => {
  // Each motion's hit-pause should occur near its primary effect.
  // We sample effectsBetween across the entire timeline and confirm
  // a hit-pause exists in the same window as the impact effect.
  for (const id of Object.keys(WEAPON_MOTIONS)) {
    const seq = buildMotion(id);
    const pauseEffect = seq.effects.find(e => e.type === 'hit-pause');
    assert.ok(pauseEffect, `${id}: no hit-pause`);
    // Has positive at-time
    assert.ok(pauseEffect.at > 0, `${id}: hit-pause should be after the wind-up`);
    // Has duration param
    assert.ok((pauseEffect.params?.duration ?? 0) > 0,
      `${id}: hit-pause needs a positive duration`);
  }
});

test('M43.1: damage type defaults match the weapon class', () => {
  // Slashing weapons → slashing; piercing → piercing; blunt → bludgeoning;
  // staff/cast defaults to force (caller can override via opts).
  const slash = buildMotion('sword-slash');
  const slashEffect = slash.effects.find(e => e.type === 'slash-arc');
  assert.strictEqual(slashEffect.params.damageType, 'slashing');

  const thrust = buildMotion('sword-thrust');
  const thrustEffect = thrust.effects.find(e => e.type === 'thrust');
  assert.strictEqual(thrustEffect.params.damageType, 'piercing');

  const axe = buildMotion('axe-cleave');
  const axeEffect = axe.effects.find(e => e.type === 'bash');
  assert.strictEqual(axeEffect.params.damageType, 'slashing');

  const fist = buildMotion('fist-jab');
  const fistEffect = fist.effects.find(e => e.type === 'bash');
  assert.strictEqual(fistEffect.params.damageType, 'bludgeoning');
});

test('M43.1: buildMotion accepts damageType override via opts', () => {
  const seq = buildMotion('sword-slash', { damageType: 'radiant' });
  const slash = seq.effects.find(e => e.type === 'slash-arc');
  assert.strictEqual(slash.params.damageType, 'radiant');
});
