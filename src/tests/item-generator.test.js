import { test } from 'node:test';
import assert from 'node:assert';
import {
  computeItemHash, detectMaterial, glowFromDamageType, rarityToAuraTier
} from '../js/sprite/item-generator.js';

test('hash is stable across calls (ASCII)', async () => {
  const item = { name: 'Flame Tongue Longsword', rarity: 'Rare', magical: true, damageType: 'Fire' };
  const a = await computeItemHash(item, '/assets/lpc/weapon/longsword.png', 'mainhand');
  const b = await computeItemHash(item, '/assets/lpc/weapon/longsword.png', 'mainhand');
  assert.strictEqual(a, b);
  assert.match(a, /^[a-f0-9]{40}$/);
});

test('hash is stable across calls (non-ASCII — proves UTF-8 bytes match)', async () => {
  const item = { name: 'Sword of ✨', rarity: 'Rare', magical: true, damageType: 'Fire' };
  const a = await computeItemHash(item, '/x', 'mainhand');
  const b = await computeItemHash(item, '/x', 'mainhand');
  assert.strictEqual(a, b);
  assert.match(a, /^[a-f0-9]{40}$/);
});

test('hash differs by name', async () => {
  const a = await computeItemHash({ name: 'A', rarity: 'Common', magical: false }, '/x', 'mainhand');
  const b = await computeItemHash({ name: 'B', rarity: 'Common', magical: false }, '/x', 'mainhand');
  assert.notStrictEqual(a, b);
});

test('hash differs by slot', async () => {
  const i = { name: 'Shield', rarity: 'Common', magical: false };
  const a = await computeItemHash(i, '/x', 'mainhand');
  const b = await computeItemHash(i, '/x', 'offhand');
  assert.notStrictEqual(a, b);
});

test('hash differs by rarity', async () => {
  const a = await computeItemHash({ name: 'Sword', rarity: 'Common', magical: false }, '/x', 'mainhand');
  const b = await computeItemHash({ name: 'Sword', rarity: 'Rare', magical: false }, '/x', 'mainhand');
  assert.notStrictEqual(a, b);
});

test('detectMaterial picks longest token', () => {
  assert.strictEqual(detectMaterial('flame tongue longsword'), 'flame');
  assert.strictEqual(detectMaterial('adamantine warhammer'), 'adamantine');
  assert.strictEqual(detectMaterial('frost dagger'), 'ice');     // alias
  assert.strictEqual(detectMaterial('fiery greatsword'), 'flame'); // alias
  assert.strictEqual(detectMaterial('rusty longsword'), null);
  assert.strictEqual(detectMaterial(''), null);
  assert.strictEqual(detectMaterial(null), null);
});

test('glowFromDamageType maps known types case-insensitive', () => {
  assert.strictEqual(glowFromDamageType('fire', true), '#ef4444');
  assert.strictEqual(glowFromDamageType('Cold', true), '#38bdf8');
  assert.strictEqual(glowFromDamageType('LIGHTNING', true), '#facc15');
  assert.strictEqual(glowFromDamageType('weird', true), '#a78bfa');  // generic violet
  assert.strictEqual(glowFromDamageType('fire', false), null);       // not magical
  assert.strictEqual(glowFromDamageType(null, true), '#a78bfa');
});

test('rarityToAuraTier handles "Very Rare" with space and underscore', () => {
  assert.strictEqual(rarityToAuraTier('Very Rare').color, '#a855f7');
  assert.strictEqual(rarityToAuraTier('VERY_RARE').color, '#a855f7');
  assert.strictEqual(rarityToAuraTier('very rare').color, '#a855f7');
  assert.strictEqual(rarityToAuraTier('Common').color, null);
  assert.strictEqual(rarityToAuraTier(undefined).color, null);
  assert.strictEqual(rarityToAuraTier('Legendary').color, '#f59e0b');
});
