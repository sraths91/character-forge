import { test } from 'node:test';
import assert from 'node:assert';
import {
  MODIFIERS, isModifier, buildModifier, applyModifiers,
  modifiersForAttack, snapshotAttackerFlags
} from '../js/anim/modifiers.js';
import { buildMotion } from '../js/anim/weapon-motions.js';

// ---------- Registry ----------

test('M43.4: MODIFIERS ships the five canonical entries', () => {
  for (const id of ['sneak-attack', 'rage', 'gwm', 'divine-smite', 'reckless-attack']) {
    assert.ok(MODIFIERS[id], `missing modifier: ${id}`);
    assert.strictEqual(MODIFIERS[id].id, id);
    assert.strictEqual(typeof MODIFIERS[id].build, 'function');
  }
});

test('M43.4: isModifier — true only for known ids', () => {
  assert.strictEqual(isModifier('sneak-attack'), true);
  assert.strictEqual(isModifier('rage'), true);
  assert.strictEqual(isModifier('imaginary'), false);
  assert.strictEqual(isModifier(null), false);
});

test('M43.4: buildModifier — unknown id returns null', () => {
  assert.strictEqual(buildModifier('not-real'), null);
});

// ---------- Sneak Attack ----------

test('M43.4: sneak-attack adds a necrotic burst around the defender at impact', () => {
  const base = buildMotion('dagger-stab');
  const patch = buildModifier('sneak-attack', { base, level: 5 });
  const burst = patch.effects.find(e => e.type === 'burst');
  assert.ok(burst, 'should add a burst effect');
  assert.strictEqual(burst.params.damageType, 'necrotic');
  assert.strictEqual(burst.params._modifier, 'sneak-attack');
});

test('M43.4: sneak-attack scales radius with rogue level', () => {
  const base = buildMotion('dagger-stab');
  const lo = buildModifier('sneak-attack', { base, level: 1 }).effects.find(e => e.type === 'burst');
  const hi = buildModifier('sneak-attack', { base, level: 11 }).effects.find(e => e.type === 'burst');
  assert.ok(hi.params.radius > lo.params.radius);
});

// ---------- Rage ----------

test('M43.4: rage adds a red aura on the attacker', () => {
  const base = buildMotion('axe-cleave');
  const patch = buildModifier('rage', { base });
  const aura = patch.effects.find(e => e.type === 'aura');
  assert.ok(aura, 'should add an aura effect');
  assert.strictEqual(aura.params.actor, 'attacker');
  assert.strictEqual(aura.params.color, '#dc2626');
  assert.ok(aura.params.duration >= base.duration,
    'aura should hold for the duration of the swing');
});

test('M43.4: rage adds squash-stretch keyframes on the attacker', () => {
  const base = buildMotion('axe-cleave');
  const patch = buildModifier('rage', { base });
  assert.ok(patch.keyframes.some(k => k.actor === 'attacker' && k.scale > 1),
    'expected a compressed/expanded attacker keyframe');
});

// ---------- GWM ----------

test('M43.4: gwm adds a heavier hit-pause + bigger shake at impact', () => {
  const base = buildMotion('axe-cleave');
  const patch = buildModifier('gwm', { base });
  assert.ok(patch.effects.some(e => e.type === 'hit-pause'),
    'gwm should add a secondary hit-pause');
  const shake = patch.effects.find(e => e.type === 'shake');
  assert.ok(shake && shake.params.amplitude >= 5);
});

test('M43.4: gwm adds a deeper anticipation keyframe on the attacker', () => {
  const base = buildMotion('axe-cleave');
  const patch = buildModifier('gwm', { base });
  const ant = patch.keyframes.find(k => k.actor === 'attacker' && k.rotation < -0.3);
  assert.ok(ant, 'expected a deeper-rotated anticipation keyframe');
});

// ---------- Divine Smite ----------

test('M43.4: divine-smite adds glyph + flash + radiant burst', () => {
  const base = buildMotion('sword-slash');
  const patch = buildModifier('divine-smite', { base, slot: 1 });
  assert.ok(patch.effects.some(e => e.type === 'glyph-rise'));
  assert.ok(patch.effects.some(e => e.type === 'flash'));
  const burst = patch.effects.find(e => e.type === 'burst');
  assert.ok(burst);
  assert.strictEqual(burst.params.damageType, 'radiant');
});

test('M43.4: divine-smite slot tier scales the burst radius', () => {
  const base = buildMotion('sword-slash');
  const t1 = buildModifier('divine-smite', { base, slot: 1 }).effects.find(e => e.type === 'burst');
  const t5 = buildModifier('divine-smite', { base, slot: 5 }).effects.find(e => e.type === 'burst');
  assert.ok(t5.params.radius > t1.params.radius);
});

// ---------- Reckless ----------

test('M43.4: reckless-attack pushes the attacker further forward', () => {
  const base = buildMotion('sword-slash');
  const patch = buildModifier('reckless-attack', { base });
  const forward = patch.keyframes.find(k => k.actor === 'attacker' && (k.x || 0) >= 8);
  assert.ok(forward, 'expected a forward-committed attacker keyframe');
  // No new impact effects — the lean is the read
  assert.ok(!patch.effects.some(e => e.type === 'burst' || e.type === 'flash'));
});

// ---------- Composition ----------

test('M43.4: applyModifiers composes into a NEW sequence (does not mutate base)', () => {
  const base = buildMotion('sword-slash');
  const beforeKey = base.keyframes.length;
  const beforeEf  = base.effects.length;
  const out = applyModifiers(base, ['sneak-attack']);
  assert.notStrictEqual(out, base, 'should return a new sequence object');
  assert.strictEqual(base.keyframes.length, beforeKey);
  assert.strictEqual(base.effects.length, beforeEf);
  assert.ok(out.effects.length > beforeEf, 'composed seq should carry the burst');
});

test('M43.4: applyModifiers stacks multiple overlays', () => {
  const base = buildMotion('sword-slash');
  const out = applyModifiers(base, ['sneak-attack', 'divine-smite']);
  assert.ok(out.effects.some(e => e.params?._modifier === 'sneak-attack'));
  assert.ok(out.effects.some(e => e.params?._modifier === 'divine-smite'));
});

test('M43.4: applyModifiers — unknown ids are silently skipped', () => {
  const base = buildMotion('sword-slash');
  const out = applyModifiers(base, ['not-real', 'sneak-attack']);
  assert.ok(out.effects.some(e => e.params?._modifier === 'sneak-attack'));
});

test('M43.4: applyModifiers — empty list returns the base', () => {
  const base = buildMotion('sword-slash');
  const out = applyModifiers(base, []);
  assert.strictEqual(out, base);
});

test('M43.4: applyModifiers — null base passes through', () => {
  assert.strictEqual(applyModifiers(null, ['sneak-attack']), null);
});

// ---------- Detection ----------

test('M43.4: modifiersForAttack — sneak attack detected from pre→post flip', () => {
  const pre  = { _sneakAttackUsedThisTurn: false };
  const post = { _sneakAttackUsedThisTurn: true };
  const out = modifiersForAttack({ pre, post, attacker: {} });
  assert.ok(out.includes('sneak-attack'));
});

test('M43.4: modifiersForAttack — sneak already-fired earlier in turn does NOT re-fire', () => {
  const pre  = { _sneakAttackUsedThisTurn: true };
  const post = { _sneakAttackUsedThisTurn: true };
  const out = modifiersForAttack({ pre, post, attacker: {} });
  assert.ok(!out.includes('sneak-attack'));
});

test('M43.4: modifiersForAttack — smite detected when slot is burned', () => {
  const pre  = { _smiteSlotUsed: null };
  const post = { _smiteSlotUsed: 2 };
  const out = modifiersForAttack({ pre, post, attacker: {} });
  assert.ok(out.includes('divine-smite'));
});

test('M43.4: modifiersForAttack — reckless detected on flip', () => {
  const pre  = { _recklessUsedThisTurn: false };
  const post = { _recklessUsedThisTurn: true };
  const out = modifiersForAttack({ pre, post, attacker: {} });
  assert.ok(out.includes('reckless-attack'));
});

test('M43.4: modifiersForAttack — rage fires while attacker is raging', () => {
  const out = modifiersForAttack({ pre: {}, post: {}, attacker: { _raging: true } });
  assert.ok(out.includes('rage'));
});

test('M43.4: modifiersForAttack — gwm fires on flip', () => {
  const pre  = { _gwmFiredThisAttack: false };
  const post = { _gwmFiredThisAttack: true };
  const out = modifiersForAttack({ pre, post, attacker: {} });
  assert.ok(out.includes('gwm'));
});

test('M43.4: snapshotAttackerFlags — captures the relevant fields', () => {
  const pc = {
    _sneakAttackUsedThisTurn: true,
    _recklessUsedThisTurn: false,
    _smiteSlotUsed: 3,
    _gwmFiredThisAttack: true,
    _unrelated: 'should be ignored'
  };
  const snap = snapshotAttackerFlags(pc);
  assert.strictEqual(snap._sneakAttackUsedThisTurn, true);
  assert.strictEqual(snap._recklessUsedThisTurn, false);
  assert.strictEqual(snap._smiteSlotUsed, 3);
  assert.strictEqual(snap._gwmFiredThisAttack, true);
  assert.strictEqual(snap._unrelated, undefined);
});

test('M43.4: snapshotAttackerFlags — null pc returns empty', () => {
  assert.deepStrictEqual(snapshotAttackerFlags(null), {});
});
