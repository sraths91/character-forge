import { test } from 'node:test';
import assert from 'node:assert';
import { planMovement, occupiedCellsOf } from '../js/scene/movement.js';

const BOUNDS = { cols: 10, rows: 10 };

// ---------- In-reach short-circuit ----------

test('M31: planMovement — already adjacent (melee) → no move', () => {
  const next = planMovement({
    from: { col: 5, row: 5 },
    to:   { col: 6, row: 5 },
    weapon: { name: 'Longsword', damageType: 'Slashing' },
    speedFt: 30, bounds: BOUNDS
  });
  assert.deepStrictEqual(next, { col: 5, row: 5 });
});

test('M31: planMovement — ranged within 80ft → no move', () => {
  const next = planMovement({
    from: { col: 0, row: 0 },
    to:   { col: 9, row: 9 },   // ~45ft Chebyshev (9 cells)
    weapon: { name: 'Longbow' },
    speedFt: 30, bounds: BOUNDS
  });
  assert.deepStrictEqual(next, { col: 0, row: 0 });
});

// ---------- Closing distance ----------

test('M31: planMovement — closes 30ft along Chebyshev path', () => {
  const next = planMovement({
    from: { col: 0, row: 0 },
    to:   { col: 9, row: 0 },   // 45ft away
    weapon: { name: 'Longsword' },
    speedFt: 30, bounds: BOUNDS   // 6 cell steps available
  });
  // Distance was 9 cells (45ft); reach is 5ft (1 cell); need to close
  // 8 cells but only 6 available → moves 6 cells along the +c axis.
  assert.deepStrictEqual(next, { col: 6, row: 0 });
});

test('M31: planMovement — stops exactly when in reach', () => {
  const next = planMovement({
    from: { col: 0, row: 0 },
    to:   { col: 3, row: 0 },   // 15ft away
    weapon: { name: 'Longsword' },
    speedFt: 30, bounds: BOUNDS
  });
  // Should stop at distance 1 (5 ft = melee reach), so col 2.
  assert.deepStrictEqual(next, { col: 2, row: 0 });
});

test('M31: planMovement — diagonal Chebyshev path closes both axes', () => {
  const next = planMovement({
    from: { col: 0, row: 0 },
    to:   { col: 5, row: 5 },   // 25ft away (diagonal)
    weapon: { name: 'Longsword' },
    speedFt: 30, bounds: BOUNDS
  });
  // Should close 4 cells diagonally → (4,4). Distance to target is 1
  // cell = in reach.
  assert.deepStrictEqual(next, { col: 4, row: 4 });
});

test('M31: planMovement — reach weapon (Halberd) stops at 10ft', () => {
  const next = planMovement({
    from: { col: 0, row: 0 },
    to:   { col: 5, row: 0 },
    weapon: { name: 'Halberd' },     // 10ft reach
    speedFt: 30, bounds: BOUNDS
  });
  // Reach is 10ft = 2 cells. Need to close 3 cells → moves to col 3.
  assert.deepStrictEqual(next, { col: 3, row: 0 });
});

// ---------- Occupied-cell avoidance ----------

test('M31: planMovement — avoids occupied cell by stepping to neighbor', () => {
  const next = planMovement({
    from: { col: 0, row: 5 },
    to:   { col: 9, row: 5 },     // straight east
    weapon: { name: 'Longsword' },
    speedFt: 15, bounds: BOUNDS,  // 3 cells, ideal target col=3
    occupied: [{ col: 3, row: 5 }]
  });
  // Ideal cell (3,5) blocked; should pick a neighbor that's still
  // closer to the target than the start
  assert.notDeepStrictEqual(next, { col: 0, row: 5 });
  assert.notDeepStrictEqual(next, { col: 3, row: 5 });
});

test('M31: planMovement — surrounded by blockers (incl. target) stays put', () => {
  const next = planMovement({
    from: { col: 1, row: 1 },
    to:   { col: 5, row: 1 },
    weapon: { name: 'Longsword' },
    speedFt: 30, bounds: BOUNDS,
    occupied: [
      // Ideal target cell + every adjacent cell + the target itself
      { col: 4, row: 1 },
      { col: 3, row: 0 }, { col: 3, row: 1 }, { col: 3, row: 2 },
      { col: 4, row: 0 }, { col: 4, row: 2 },
      { col: 5, row: 0 }, { col: 5, row: 1 }, { col: 5, row: 2 }
    ]
  });
  assert.deepStrictEqual(next, { col: 1, row: 1 });
});

// ---------- Edge cases ----------

test('M31: planMovement — null inputs return safely', () => {
  assert.strictEqual(planMovement({ from: null, to: { col: 1, row: 1 } }), null);
  assert.deepStrictEqual(
    planMovement({ from: { col: 0, row: 0 }, to: null }),
    { col: 0, row: 0 }
  );
});

test('M31: planMovement — zero speed → no move', () => {
  const next = planMovement({
    from: { col: 0, row: 0 },
    to:   { col: 5, row: 0 },
    weapon: { name: 'Longsword' },
    speedFt: 0, bounds: BOUNDS
  });
  assert.deepStrictEqual(next, { col: 0, row: 0 });
});

test('M31: planMovement — clamps to grid bounds', () => {
  const next = planMovement({
    from: { col: 0, row: 0 },
    to:   { col: 20, row: 0 },    // far off-grid
    weapon: { name: 'Longsword' },
    speedFt: 30, bounds: { cols: 5, rows: 5 }
  });
  // Should clamp final cell to grid (max col = 4)
  assert.ok(next.col >= 0 && next.col < 5);
  assert.ok(next.row >= 0 && next.row < 5);
});

// ---------- occupiedCellsOf ----------

test('M31: occupiedCellsOf — pulls PC + monster positions; excludes mover', () => {
  const set = occupiedCellsOf({
    party: [{ id: 'p1', _position: { col: 1, row: 1 } }, { id: 'p2', _position: { col: 2, row: 2 } }],
    monsters: [{ id: 'm1', position: { col: 5, row: 5 } }],
    excludeId: 'p1'
  });
  assert.ok(!set.has('1,1'), 'mover (p1) is excluded');
  assert.ok(set.has('2,2'));
  assert.ok(set.has('5,5'));
});

test('M31: occupiedCellsOf — falls back to scene.positions for PCs without _position', () => {
  const set = occupiedCellsOf({
    party: [{ id: 'p1' }],
    scene: { positions: { p1: { col: 3, row: 3 } } }
  });
  assert.ok(set.has('3,3'));
});
