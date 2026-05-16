import { test } from 'node:test';
import assert from 'node:assert';
import {
  buildArenaScene, endStateOf, initialTurn, nextTurn, validateArenaInputs
} from '../js/scene/versus.js';

// ---------- buildArenaScene ----------

test('M28: buildArenaScene — 5×3 grid with PC at col 1 row 1, monster at col 3 row 1', () => {
  const monsterInstance = {
    id: 'm1', presetSlug: 'goblin', name: 'Goblin',
    hp: { current: 7, max: 7, temp: 0 }, conditions: []
  };
  const scene = buildArenaScene({ pcId: 'pc1', monsterInstance });
  assert.strictEqual(scene.cols, 5);
  assert.strictEqual(scene.rows, 3);
  assert.deepStrictEqual(scene.positions['pc1'], { col: 1, row: 1 });
  assert.strictEqual(scene.monsters.length, 1);
  assert.deepStrictEqual(scene.monsters[0].position, { col: 3, row: 1 });
  assert.strictEqual(scene.monsters[0].name, 'Goblin');
});

test('M28: buildArenaScene — flankingEnabled passes through', () => {
  const scene = buildArenaScene({ pcId: 'pc1', monsterInstance: null, flankingEnabled: true });
  assert.strictEqual(scene.flankingEnabled, true);
});

test('M28: buildArenaScene — null monsterInstance produces empty monsters array', () => {
  const scene = buildArenaScene({ pcId: 'pc1', monsterInstance: null });
  assert.deepStrictEqual(scene.monsters, []);
});

test('M28: buildArenaScene — defaults work with no args', () => {
  const scene = buildArenaScene();
  assert.strictEqual(scene.cols, 5);
  assert.deepStrictEqual(scene.positions, {});
});

// ---------- endStateOf ----------

test('M28: endStateOf — both alive returns null', () => {
  assert.strictEqual(endStateOf({ partyHp: 27, monsterHp: 7 }), null);
});

test('M28: endStateOf — monster at 0 → pc-wins', () => {
  assert.strictEqual(endStateOf({ partyHp: 12, monsterHp: 0 }), 'pc-wins');
});

test('M28: endStateOf — pc at 0 → monster-wins', () => {
  assert.strictEqual(endStateOf({ partyHp: 0, monsterHp: 3 }), 'monster-wins');
});

test('M28: endStateOf — both at 0 → draw', () => {
  assert.strictEqual(endStateOf({ partyHp: 0, monsterHp: 0 }), 'draw');
});

test('M28: endStateOf — negative HP still counts as down', () => {
  assert.strictEqual(endStateOf({ partyHp: 27, monsterHp: -5 }), 'pc-wins');
});

// ---------- Turn helpers ----------

test('M28: initialTurn always returns pc (v1 PC-first rule)', () => {
  assert.strictEqual(initialTurn(), 'pc');
});

test('M28: nextTurn alternates pc ↔ monster', () => {
  assert.strictEqual(nextTurn('pc'), 'monster');
  assert.strictEqual(nextTurn('monster'), 'pc');
});

// ---------- validateArenaInputs ----------

test('M28: validateArenaInputs — empty PC id returns helpful message', () => {
  assert.match(validateArenaInputs({}), /pick a character/i);
});

test('M28: validateArenaInputs — empty monster slug returns helpful message', () => {
  assert.match(validateArenaInputs({ pcId: 'p1' }), /pick an opponent/i);
});

test('M28: validateArenaInputs — unknown preset slug returns specific error', () => {
  const monsterPresets = { goblin: {}, orc: {} };
  assert.match(
    validateArenaInputs({ pcId: 'p1', monsterPresetSlug: 'dragon', monsterPresets }),
    /Unknown monster preset/
  );
});

test('M28: validateArenaInputs — all good returns null', () => {
  const monsterPresets = { goblin: {} };
  assert.strictEqual(
    validateArenaInputs({ pcId: 'p1', monsterPresetSlug: 'goblin', monsterPresets }),
    null
  );
});
