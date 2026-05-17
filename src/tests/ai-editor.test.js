import { test } from 'node:test';
import assert from 'node:assert';
import {
  cloneProfile, editableProfileFor, applyWeightChange, applyRetreatChange,
  applyArchetypeSwap, resetProfile, listArchetypes, listConsiderations
} from '../js/scene/ai/editor.js';
import { MONSTER_PROFILES } from '../js/scene/ai/profiles.js';

// ---------- cloneProfile ----------

test('M32.3: cloneProfile produces an independent copy', () => {
  const src = MONSTER_PROFILES.goblin;
  const dup = cloneProfile(src);
  dup.considerations.target_low_hp.weight = 99;
  assert.notStrictEqual(src.considerations.target_low_hp.weight, 99,
    'must not mutate authored profile');
});

test('M32.3: cloneProfile handles a null input by returning DEFAULT_PROFILE shape', () => {
  const dup = cloneProfile(null);
  assert.strictEqual(typeof dup.archetype, 'string');
  assert.ok(dup.considerations);
});

// ---------- editableProfileFor ----------

test('M32.3: editableProfileFor uses _aiProfile when present', () => {
  const overlay = {
    archetype: 'custom', considerations: { target_low_hp: { weight: 0.9, curve: 'linear' } },
    retreat_below_hp: 0.3
  };
  const out = editableProfileFor({ presetSlug: 'goblin', _aiProfile: overlay });
  assert.strictEqual(out.archetype, 'custom');
});

test('M32.3: editableProfileFor falls back to slug-authored profile', () => {
  const out = editableProfileFor({ presetSlug: 'orc' });
  assert.strictEqual(out.archetype, 'aggressive_charger');
});

// ---------- applyWeightChange ----------

test('M32.3: applyWeightChange updates the weight on an existing consideration', () => {
  const src = cloneProfile(MONSTER_PROFILES.goblin);
  const next = applyWeightChange(src, 'target_low_hp', 1.2);
  assert.strictEqual(next.considerations.target_low_hp.weight, 1.2);
});

test('M32.3: applyWeightChange adds a brand-new consideration', () => {
  const src = cloneProfile(MONSTER_PROFILES.orc);
  // Orc does not weight pack_tactics by default
  assert.strictEqual(src.considerations.pack_tactics_active, undefined);
  const next = applyWeightChange(src, 'pack_tactics_active', 0.5);
  assert.strictEqual(next.considerations.pack_tactics_active.weight, 0.5);
});

test('M32.3: applyWeightChange removes a consideration when weight ≈ 0', () => {
  const src = cloneProfile(MONSTER_PROFILES.goblin);
  const next = applyWeightChange(src, 'target_low_hp', 0);
  assert.strictEqual(next.considerations.target_low_hp, undefined);
});

test('M32.3: applyWeightChange ignores unknown consideration names', () => {
  const src = cloneProfile(MONSTER_PROFILES.goblin);
  const next = applyWeightChange(src, 'not_a_real_consideration', 0.5);
  assert.strictEqual(next, src);
});

test('M32.3: applyWeightChange preserves curve when present', () => {
  const src = cloneProfile(MONSTER_PROFILES.kobold);   // pack_tactics_active uses 'step'
  const next = applyWeightChange(src, 'pack_tactics_active', 0.8);
  assert.strictEqual(next.considerations.pack_tactics_active.curve, 'step');
});

// ---------- applyRetreatChange ----------

test('M32.3: applyRetreatChange clamps to [0, 0.95]', () => {
  const src = cloneProfile(MONSTER_PROFILES.goblin);
  assert.strictEqual(applyRetreatChange(src, -0.5).retreat_below_hp, 0);
  assert.strictEqual(applyRetreatChange(src, 2.0).retreat_below_hp, 0.95);
  assert.strictEqual(applyRetreatChange(src, 0.3).retreat_below_hp, 0.3);
});

// ---------- applyArchetypeSwap ----------

test('M32.3: applyArchetypeSwap replaces with another authored profile', () => {
  const src = cloneProfile(MONSTER_PROFILES.goblin);
  const swapped = applyArchetypeSwap(src, 'orc');
  assert.strictEqual(swapped.archetype, 'aggressive_charger');
  // And the returned object is a clone — not the authored singleton
  assert.notStrictEqual(swapped, MONSTER_PROFILES.orc);
});

test('M32.3: applyArchetypeSwap is a no-op for unknown slugs', () => {
  const src = cloneProfile(MONSTER_PROFILES.goblin);
  const out = applyArchetypeSwap(src, 'imaginary-monster');
  assert.strictEqual(out, src);
});

// ---------- resetProfile / list helpers ----------

test('M32.3: resetProfile returns null (signal to delete _aiProfile)', () => {
  assert.strictEqual(resetProfile(), null);
});

test('M32.3: listArchetypes exposes all 14 authored profiles', () => {
  const out = listArchetypes();
  assert.strictEqual(out.length, 14);
  assert.ok(out.some(o => o.slug === 'goblin' && o.archetype === 'nimble_skirmisher'));
});

test('M32.3: listConsiderations contains the registered signal names', () => {
  const out = listConsiderations();
  assert.ok(out.includes('target_low_hp'));
  assert.ok(out.includes('pack_tactics_active'));
  assert.ok(out.includes('self_isolated'));
});
