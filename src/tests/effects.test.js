import { test } from 'node:test';
import assert from 'node:assert';
import {
  DAMAGE_COLORS, colorForDamageType,
  weaponAttackPrimitive, spellAttackPrimitive,
  effectsForWeaponHit, effectsForWeaponMiss,
  effectsForSpellAttack, effectsForSaveSpell,
  effectsForAoeSpell, effectsForFeatureTrigger,
  effectsForConcentration,
  directionTowards, effectProgress
} from '../js/scene/effects.js';

const NOW = 1_000_000;

function pcAt(col = 1, row = 2) { return { id: 'p', _position: { col, row } }; }
function mon(col = 4, row = 2)  { return { id: 'm', position:   { col, row } }; }

// ---------- Color palette ----------

test('M27: colorForDamageType — known types resolve', () => {
  assert.strictEqual(colorForDamageType('fire'),     DAMAGE_COLORS.fire);
  assert.strictEqual(colorForDamageType('Radiant'),  DAMAGE_COLORS.radiant);
  assert.strictEqual(colorForDamageType('SLASHING'), DAMAGE_COLORS.slashing);
});

test('M27: colorForDamageType — unknown / null fall back to default', () => {
  const fallback = colorForDamageType(null);
  assert.ok(fallback && fallback.length);
  assert.strictEqual(colorForDamageType('made-up-damage'), fallback);
});

// ---------- Primitive picker ----------

test('M27: weaponAttackPrimitive — ranged always projectile', () => {
  assert.strictEqual(weaponAttackPrimitive({ damageType: 'Slashing' }, true), 'projectile');
  assert.strictEqual(weaponAttackPrimitive({ damageType: 'Bludgeoning' }, true), 'projectile');
});

test('M27: weaponAttackPrimitive — slashing → slash-arc', () => {
  assert.strictEqual(weaponAttackPrimitive({ name: 'Longsword', damageType: 'Slashing' }, false), 'slash-arc');
});

test('M27: weaponAttackPrimitive — piercing finesse → thrust', () => {
  assert.strictEqual(
    weaponAttackPrimitive({ name: 'Rapier', damageType: 'Piercing' }, false),
    'thrust'
  );
});

test('M27: weaponAttackPrimitive — piercing non-finesse → slash-arc', () => {
  // Spear is piercing but not finesse → slash-arc (broad sweep)
  assert.strictEqual(
    weaponAttackPrimitive({ name: 'Spear', damageType: 'Piercing' }, false),
    'slash-arc'
  );
});

test('M27: weaponAttackPrimitive — bludgeoning → bash', () => {
  assert.strictEqual(weaponAttackPrimitive({ damageType: 'Bludgeoning' }, false), 'bash');
});

test('M27: spellAttackPrimitive — ray/eldritch blast → beam, else projectile', () => {
  assert.strictEqual(spellAttackPrimitive({ name: 'Eldritch Blast' }), 'beam');
  assert.strictEqual(spellAttackPrimitive({ name: 'Ray of Frost' }),   'beam');
  assert.strictEqual(spellAttackPrimitive({ name: 'Fire Bolt' }),      'projectile');
  assert.strictEqual(spellAttackPrimitive({ name: 'Spiritual Weapon' }), 'projectile');
});

// ---------- Effect sequence shape ----------

test('M27: effectsForWeaponHit (melee) — lunge → primitive → recoil', () => {
  const out = effectsForWeaponHit({
    attacker: pcAt(), target: mon(),
    weapon: { name: 'Longsword', damageType: 'Slashing' },
    isRanged: false, crit: false, now: NOW
  });
  const kinds = out.map(e => e.kind);
  assert.deepStrictEqual(kinds, ['lunge', 'slash-arc', 'recoil']);
  // Sequence: lunge starts at NOW, recoil starts later
  assert.strictEqual(out[0].startedAt, NOW);
  assert.ok(out[2].startedAt > NOW);
  assert.ok(out[1].color);
});

test('M27: effectsForWeaponHit (ranged) — no lunge, projectile + recoil', () => {
  const out = effectsForWeaponHit({
    attacker: pcAt(), target: mon(),
    weapon: { name: 'Longbow', damageType: 'Piercing' },
    isRanged: true, crit: false, now: NOW
  });
  const kinds = out.map(e => e.kind);
  assert.deepStrictEqual(kinds, ['projectile', 'recoil']);
});

test('M27: effectsForWeaponHit — crit adds a shadow-strike accent', () => {
  const out = effectsForWeaponHit({
    attacker: pcAt(), target: mon(),
    weapon: { name: 'Longsword', damageType: 'Slashing' },
    isRanged: false, crit: true, now: NOW
  });
  assert.ok(out.some(e => e.kind === 'shadow-strike'));
});

test('M27: effectsForWeaponMiss — no recoil but the primitive still plays', () => {
  const out = effectsForWeaponMiss({
    attacker: pcAt(), target: mon(),
    weapon: { name: 'Longsword', damageType: 'Slashing' },
    isRanged: false, now: NOW
  });
  assert.ok(out.some(e => e.kind === 'slash-arc'));
  assert.ok(!out.some(e => e.kind === 'recoil'));
});

test('M27: effectsForSpellAttack — projectile + burst + recoil on hit', () => {
  const out = effectsForSpellAttack({
    attacker: pcAt(), target: mon(),
    spell: { name: 'Fire Bolt', damageType: 'Fire' },
    hit: true, now: NOW
  });
  const kinds = out.map(e => e.kind);
  assert.deepStrictEqual(kinds, ['projectile', 'burst', 'recoil']);
  assert.strictEqual(out[1].color, DAMAGE_COLORS.fire);
});

test('M27: effectsForSpellAttack — beam for ray spells', () => {
  const out = effectsForSpellAttack({
    attacker: pcAt(), target: mon(),
    spell: { name: 'Ray of Frost', damageType: 'Cold' },
    hit: true, now: NOW
  });
  assert.strictEqual(out[0].kind, 'beam');
});

test('M27: effectsForSpellAttack — miss has no burst or recoil', () => {
  const out = effectsForSpellAttack({
    attacker: pcAt(), target: mon(),
    spell: { name: 'Fire Bolt', damageType: 'Fire' },
    hit: false, now: NOW
  });
  assert.deepStrictEqual(out.map(e => e.kind), ['projectile']);
});

test('M27: effectsForSaveSpell — burst + recoil on damage; touch range adds beam', () => {
  const out = effectsForSaveSpell({
    attacker: pcAt(), target: mon(),
    spell: { name: 'Sacred Flame', damageType: 'Radiant', range: { kind: 'ranged', feet: 60 } },
    damaged: true, now: NOW
  });
  assert.ok(out.some(e => e.kind === 'burst'));
  assert.ok(out.some(e => e.kind === 'recoil'));
  // Inflict Wounds (touch) → beam from caster
  const touchOut = effectsForSaveSpell({
    attacker: pcAt(), target: mon(),
    spell: { name: 'Inflict Wounds', damageType: 'Necrotic', range: { kind: 'touch', feet: 0 } },
    damaged: true, now: NOW
  });
  assert.ok(touchOut.some(e => e.kind === 'beam'));
});

test('M27: effectsForSaveSpell — successful save (no damage) skips recoil', () => {
  const out = effectsForSaveSpell({
    attacker: pcAt(), target: mon(),
    spell: { name: 'Sacred Flame', damageType: 'Radiant', range: { kind: 'ranged', feet: 60 } },
    damaged: false, now: NOW
  });
  assert.ok(out.some(e => e.kind === 'burst'));
  assert.ok(!out.some(e => e.kind === 'recoil'));
});

test('M27: effectsForAoeSpell — aoe-fill across all cells + burst at origin', () => {
  const cells = [{ col: 4, row: 2 }, { col: 5, row: 2 }, { col: 4, row: 3 }];
  const out = effectsForAoeSpell({
    cells, origin: { col: 4, row: 2 },
    spell: { name: 'Fireball', damageType: 'Fire' },
    now: NOW
  });
  assert.ok(out.some(e => e.kind === 'aoe-fill'));
  assert.ok(out.some(e => e.kind === 'burst'));
  const fill = out.find(e => e.kind === 'aoe-fill');
  assert.strictEqual(fill.cells.length, 3);
});

test('M27: effectsForFeatureTrigger — Sneak Attack produces shadow-strike (dark red)', () => {
  const out = effectsForFeatureTrigger({
    feature: { name: 'Sneak Attack' }, target: mon(), now: NOW
  });
  assert.strictEqual(out[0].kind, 'shadow-strike');
});

test('M27: effectsForFeatureTrigger — Channel Divinity produces divine-glow', () => {
  const out = effectsForFeatureTrigger({
    feature: { name: 'Channel Divinity: Turn Undead' }, target: mon(), now: NOW
  });
  assert.strictEqual(out[0].kind, 'divine-glow');
});

test('M27: effectsForConcentration — glyph-rise carries the glyph', () => {
  const out = effectsForConcentration({
    target: pcAt(), spell: { name: 'Bless' }, glyph: '✋', now: NOW
  });
  assert.strictEqual(out[0].kind, 'glyph-rise');
  assert.strictEqual(out[0].glyph, '✋');
});

// ---------- Helpers ----------

test('M27: directionTowards — picks the dominant axis', () => {
  assert.strictEqual(directionTowards({ col: 0, row: 0 }, { col: 3, row: 0 }), 'east');
  assert.strictEqual(directionTowards({ col: 5, row: 5 }, { col: 4, row: 5 }), 'west');
  assert.strictEqual(directionTowards({ col: 0, row: 0 }, { col: 0, row: 4 }), 'south');
  assert.strictEqual(directionTowards({ col: 0, row: 5 }, { col: 0, row: 1 }), 'north');
});

test('M27: effectProgress — clamps to [0,1]', () => {
  const e = { startedAt: 1000, duration: 200 };
  assert.strictEqual(effectProgress(e, 900),  0);
  assert.strictEqual(effectProgress(e, 1000), 0);
  assert.strictEqual(effectProgress(e, 1100), 0.5);
  assert.strictEqual(effectProgress(e, 1200), 1);
  assert.strictEqual(effectProgress(e, 9999), 1);
});
