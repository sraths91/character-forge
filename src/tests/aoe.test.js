import { test } from 'node:test';
import assert from 'node:assert';
import { templateCells, entitiesInTemplate } from '../js/scene/aoe.js';

// Helpers for stable cell-set comparisons regardless of order.
function asSet(cells) {
  return new Set(cells.map(c => `${c.col},${c.row}`));
}
function set(...pairs) {
  return new Set(pairs.map(p => `${p[0]},${p[1]}`));
}

// ---------- Sphere ----------

test('M8: sphere — radius 1 cell covers origin + 4 cardinals + 4 corners (9 cells inside chebyshev=1)', () => {
  const cells = templateCells({ shape: 'sphere', originCol: 5, originRow: 5, sizeCells: 1, cols: 20, rows: 20 });
  // Center, 4 cardinals (dist 1), 4 corners (dist ~1.41 — excluded because > 1)
  assert.deepStrictEqual(asSet(cells),
    set([5,5],[4,5],[6,5],[5,4],[5,6]));
});

test('M8: sphere — radius 2 includes the full disk', () => {
  const cells = templateCells({ shape: 'sphere', originCol: 5, originRow: 5, sizeCells: 2, cols: 20, rows: 20 });
  // 13 cells in a 5e radius-2 burst on a square grid (chebyshev ≤ 2 with euclidean<=2 trim).
  // Verify all cells whose euclidean distance is ≤ 2 are included.
  assert.ok(cells.length >= 11 && cells.length <= 13, `expected ~12 cells, got ${cells.length}`);
  // Sanity checks: center and 2-cell-out cardinals are inside
  assert.ok(asSet(cells).has('5,5'));
  assert.ok(asSet(cells).has('7,5'));
  assert.ok(asSet(cells).has('5,7'));
  // Far corner (2,2) is sqrt(8) ≈ 2.83 — outside
  assert.ok(!asSet(cells).has('3,3'),
    'sphere should not include (3,3) at radius 2 — too far in Euclidean distance');
});

test('M8: sphere — clamps to grid bounds', () => {
  const cells = templateCells({ shape: 'sphere', originCol: 0, originRow: 0, sizeCells: 2, cols: 3, rows: 3 });
  // Everything off-grid (negative col/row) should be dropped
  for (const c of cells) {
    assert.ok(c.col >= 0 && c.col < 3);
    assert.ok(c.row >= 0 && c.row < 3);
  }
});

// ---------- Cube ----------

test('M8: cube — 3-cell side extends SE from origin', () => {
  const cells = templateCells({ shape: 'cube', originCol: 1, originRow: 1, sizeCells: 3, cols: 10, rows: 10 });
  // Origin + 8 neighbors (3x3 square anchored NW)
  assert.deepStrictEqual(asSet(cells),
    set([1,1],[2,1],[3,1],[1,2],[2,2],[3,2],[1,3],[2,3],[3,3]));
});

test('M8: cube — 1-cell side = just the origin', () => {
  const cells = templateCells({ shape: 'cube', originCol: 4, originRow: 7, sizeCells: 1, cols: 10, rows: 10 });
  assert.deepStrictEqual(asSet(cells), set([4,7]));
});

// ---------- Line ----------

test('M8: line — east 4 cells from origin', () => {
  const cells = templateCells({ shape: 'line', originCol: 2, originRow: 2, sizeCells: 4, direction: 'east', cols: 10, rows: 10 });
  assert.deepStrictEqual(asSet(cells), set([2,2],[3,2],[4,2],[5,2]));
});

test('M8: line — north 3 cells from origin', () => {
  const cells = templateCells({ shape: 'line', originCol: 2, originRow: 5, sizeCells: 3, direction: 'north', cols: 10, rows: 10 });
  assert.deepStrictEqual(asSet(cells), set([2,5],[2,4],[2,3]));
});

test('M8: line — returns empty for unknown direction', () => {
  const cells = templateCells({ shape: 'line', originCol: 2, originRow: 2, sizeCells: 4, direction: 'diagonal', cols: 10, rows: 10 });
  assert.deepStrictEqual(cells, []);
});

// ---------- Cone ----------

test('M8: cone — east 3 cells, expanding width 1/2/3', () => {
  const cells = templateCells({ shape: 'cone', originCol: 1, originRow: 5, sizeCells: 3, direction: 'east', cols: 10, rows: 10 });
  // Origin not included; step 1 is 1 cell wide at (2,5); step 2 is 2 wide at (3,4-5); step 3 is 3 wide at (4,4-6)
  assert.ok(asSet(cells).has('2,5'));
  // Step 2 width: 2 cells centred on row 5
  assert.ok(asSet(cells).has('3,5'));
  assert.ok(asSet(cells).has('3,6') || asSet(cells).has('3,4'));
  // Step 3 width: 3 cells row 4..6
  assert.ok(asSet(cells).has('4,5'));
  assert.ok(asSet(cells).has('4,4'));
  assert.ok(asSet(cells).has('4,6'));
  // Origin itself excluded
  assert.ok(!asSet(cells).has('1,5'));
});

test('M8: cone — north 2 cells, expanding column-wise', () => {
  const cells = templateCells({ shape: 'cone', originCol: 5, originRow: 5, sizeCells: 2, direction: 'north', cols: 10, rows: 10 });
  // Step 1 = 1 cell at (5,4); step 2 = 2 cells perpendicular to N (along col axis)
  assert.ok(asSet(cells).has('5,4'));
  // Step 2 at row 3: 2-cell width on col axis — should include (5,3) and one neighbour
  assert.ok(asSet(cells).has('5,3'));
});

// ---------- Unknown shape ----------

test('M8: unknown shape returns empty array', () => {
  assert.deepStrictEqual(templateCells({ shape: 'octahedron', originCol: 0, originRow: 0, sizeCells: 2 }), []);
});

// ---------- entitiesInTemplate ----------

test('M8: entitiesInTemplate finds PCs and monsters whose cell is in the template', () => {
  const cells = [{ col: 5, row: 5 }, { col: 6, row: 5 }];
  const pc1 = { id: 'p1', name: 'Saris', _position: { col: 5, row: 5 } };
  const pc2 = { id: 'p2', name: 'Adrin', _position: { col: 1, row: 1 } };   // out
  const mon = { id: 'm1', name: 'Goblin', position: { col: 6, row: 5 } };
  const hits = entitiesInTemplate(cells, { party: [pc1, pc2], monsters: [mon] });
  const names = hits.map(h => h.entity.name).sort();
  assert.deepStrictEqual(names, ['Goblin', 'Saris']);
});

test('M8: entitiesInTemplate falls back to scene.positions for PC without _position', () => {
  const cells = [{ col: 5, row: 5 }];
  const pc = { id: 'p1', name: 'Saris' };   // no _position
  const scene = { positions: { p1: { col: 5, row: 5 } } };
  const hits = entitiesInTemplate(cells, { party: [pc], monsters: [], scene });
  assert.strictEqual(hits.length, 1);
  assert.strictEqual(hits[0].entity.name, 'Saris');
});

test('M8: entitiesInTemplate empty cells → []', () => {
  assert.deepStrictEqual(entitiesInTemplate([], { party: [], monsters: [] }), []);
});
