import { test } from 'node:test';
import assert from 'node:assert';
import { ruleFor, tooltipFor } from '../js/scene/rules-reference.js';

test('M19: ruleFor — exact match returns rule + page', () => {
  const r = ruleFor('Attacker poisoned');
  assert.ok(r);
  assert.match(r.page, /PHB/);
  assert.match(r.rule, /disadvantage/i);
});

test('M19: ruleFor — Target prone (melee) and (ranged) cite the correct split', () => {
  assert.match(ruleFor('Target prone (melee)').rule, /within 5 ft/i);
  assert.match(ruleFor('Target prone (ranged)').rule, /not within 5 ft/i);
});

test('M19: ruleFor — prefix match resolves Flanking with X', () => {
  const r = ruleFor('Flanking with Adrin');
  assert.ok(r, 'flanking should resolve via prefix');
  assert.match(r.page, /DMG/);
});

test('M19: ruleFor — prefix match resolves the dynamic Out-of-reach format', () => {
  const r = ruleFor('Out of reach (15 ft away, 5 ft reach)');
  assert.ok(r);
  assert.match(r.rule, /reach/i);
});

test('M19: ruleFor — Sneak Attack block reasons are covered', () => {
  assert.ok(ruleFor('Weapon must be finesse or ranged'));
  assert.ok(ruleFor('Cannot sneak attack with disadvantage'));
  assert.ok(ruleFor('Need advantage OR ally within 5 ft of target'));
  assert.ok(ruleFor('Advantage on the attack'));
  assert.ok(ruleFor('Ally adjacent to target (Adrin)'));
});

test('M19: ruleFor — incapacitated-attacker variants all resolve', () => {
  assert.ok(ruleFor('Attacker is paralyzed (incapacitated — cannot attack)'));
  assert.ok(ruleFor('Attacker is stunned (incapacitated — cannot attack)'));
  assert.ok(ruleFor('Attacker is unconscious (incapacitated — cannot attack)'));
});

test('M19: ruleFor — unknown reason returns null', () => {
  assert.strictEqual(ruleFor('Sparkling banana of doom'), null);
  assert.strictEqual(ruleFor(''), null);
  assert.strictEqual(ruleFor(null), null);
});

test('M19: tooltipFor — formats as "<page>: <rule>" for hover', () => {
  const t = tooltipFor('Attacker poisoned');
  assert.match(t, /^PHB p\d+: /);
});

test('M19: tooltipFor — null for unknown reasons', () => {
  assert.strictEqual(tooltipFor('Not a real reason'), null);
});

test('M19: ruleFor — longer prefixes win over shorter ones', () => {
  // "Target paralyzed, melee within 5 ft" should match the autoCrit
  // prefix, not just "Target paralyzed".
  const r = ruleFor('Target paralyzed, melee within 5 ft');
  assert.ok(r);
  assert.match(r.rule, /automatic critical/i);
});
