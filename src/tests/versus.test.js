import { test } from 'node:test';
import assert from 'node:assert';
import {
  buildArenaScene, endStateOf, initialTurn, nextTurn, validateArenaInputs,
  buildPartyArenaScene, partyEndStateOf, rollPartyInitiative
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

// ---- M29: Party combat ----

test('M29: buildPartyArenaScene — N PCs left columns, M monsters right columns', () => {
  const pcIds = ['p1', 'p2', 'p3'];
  const monsters = [
    { id: 'm1', presetSlug: 'goblin', name: 'Goblin', hp: { current: 7, max: 7 } },
    { id: 'm2', presetSlug: 'goblin', name: 'Goblin 2', hp: { current: 7, max: 7 } }
  ];
  const scene = buildPartyArenaScene({ pcIds, monsterInstances: monsters });
  assert.strictEqual(scene.cols, 8);
  assert.ok(scene.rows >= 3);
  // PCs in col 1
  assert.strictEqual(scene.positions['p1'].col, 1);
  assert.strictEqual(scene.positions['p2'].col, 1);
  // Monsters in col 6 (cols-2)
  assert.strictEqual(scene.monsters[0].position.col, 6);
  assert.strictEqual(scene.monsters[1].position.col, 6);
});

test('M29: buildPartyArenaScene — wraps to back row when teams exceed rows', () => {
  // 8 PCs on a default 5-row arena → 5 in col 1, then 3 in col 0
  const pcIds = ['p1','p2','p3','p4','p5','p6','p7','p8'];
  const scene = buildPartyArenaScene({ pcIds, monsterInstances: [] });
  // The 6th PC should be in column 0 (back row)
  const c1Count = pcIds.filter(id => scene.positions[id].col === 1).length;
  const c0Count = pcIds.filter(id => scene.positions[id].col === 0).length;
  assert.strictEqual(c1Count + c0Count, pcIds.length);
  assert.ok(c0Count > 0, 'overflow PCs go to back row');
});

test('M29: partyEndStateOf — party alive + monsters alive → null', () => {
  assert.strictEqual(partyEndStateOf({ partyHps: [10, 5], monsterHps: [3, 4] }), null);
});

test('M29: partyEndStateOf — all monsters down → party-wins', () => {
  assert.strictEqual(partyEndStateOf({ partyHps: [10, 5], monsterHps: [0, 0] }), 'party-wins');
});

test('M29: partyEndStateOf — all party down → monsters-win', () => {
  assert.strictEqual(partyEndStateOf({ partyHps: [0, 0], monsterHps: [3] }), 'monsters-win');
});

test('M29: partyEndStateOf — both sides down → draw', () => {
  assert.strictEqual(partyEndStateOf({ partyHps: [0], monsterHps: [0, -1] }), 'draw');
});

test('M29: partyEndStateOf — empty inputs → draw', () => {
  assert.strictEqual(partyEndStateOf({ partyHps: [], monsterHps: [] }), 'draw');
});

test('M29: rollPartyInitiative — DEX mod adds to PC rolls', () => {
  // Deterministic rng: every call returns 0.5 → floor(0.5*20)+1 = 11
  const fixedRng = () => 0.5;
  const pcs = [{ id: 'p1', name: 'Lyra', abilityModifiers: { DEX: 3 } }];
  const monsters = [{ id: 'm1', name: 'Goblin' }];
  const init = rollPartyInitiative({ pcs, monsters }, fixedRng);
  const lyra = init.find(e => e.entityId === 'p1');
  const goblin = init.find(e => e.entityId === 'm1');
  // Lyra: 11 + 3 = 14; Goblin: 11
  assert.strictEqual(lyra.score, 14);
  assert.strictEqual(goblin.score, 11);
  // Sorted descending
  assert.strictEqual(init[0].entityId, 'p1');
});

test('M29: rollPartyInitiative — defaults DEX mod to 0 when missing', () => {
  const init = rollPartyInitiative({
    pcs: [{ id: 'p1', name: 'PC' }],
    monsters: []
  }, () => 0.0);
  // d20 with rng=0 → 1
  assert.strictEqual(init[0].score, 1);
});
