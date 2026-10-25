// M65 E5 — the diagonal rule (dm.room.settings.diagonalRule) on the
// legality side: '5ft' (PHB, default) and '5-10' (DMG alternating; the
// phase-1 spelling '5-10-5' is an alias) through findPath, reachableCells,
// validateMove, distanceFt and pathCostFt.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  findPath, reachableCells, validateMove, distanceFt, pathCostFt, normaliseDiagonalRule, DIAGONAL_RULES, MOVE_REASONS
} from '../js/scene/grid-legality.js';
import { chebyshevFeet } from '../js/scene/grid-rules.js';
import { createTerrain, applyTerrainPaint, TERRAIN_FLAGS } from '../js/map/terrain.js';

const diag = (n) => Array.from({ length: n + 1 }, (_, i) => ({ col: i, row: i }));

test('normaliseDiagonalRule / DIAGONAL_RULES', () => {
  assert.deepEqual([...DIAGONAL_RULES], ['5ft', '5-10']);
  assert.equal(normaliseDiagonalRule('5-10'), '5-10');
  assert.equal(normaliseDiagonalRule('5-10-5'), '5-10');
  for (const x of ['5ft', undefined, null, '', 'euclid', 10]) assert.equal(normaliseDiagonalRule(x), '5ft', String(x));
});

test('distanceFt: 5ft equals the engine Chebyshev distance; 5-10 adds every second diagonal', () => {
  for (const [a, b] of [[{ col: 0, row: 0 }, { col: 3, row: 3 }], [{ col: 2, row: 5 }, { col: 7, row: 1 }], [{ col: 4, row: 4 }, { col: 4, row: 4 }]]) {
    assert.equal(distanceFt(a, b), chebyshevFeet(a, b));
    assert.equal(distanceFt(a, b, { diagonalRule: '5ft' }), chebyshevFeet(a, b));
  }
  const o = { col: 0, row: 0 };
  const dmg = (col, row) => distanceFt(o, { col, row }, { diagonalRule: '5-10' });
  assert.equal(dmg(1, 1), 5);
  assert.equal(dmg(2, 2), 15);
  assert.equal(dmg(3, 3), 20);
  assert.equal(dmg(4, 4), 30);
  assert.equal(dmg(5, 2), 30, '5 + floor(2/2) cells');
  assert.equal(dmg(6, 0), 30, 'straight lines are unchanged');
  assert.equal(distanceFt(o, { col: 2, row: 2 }, { diagonalRule: '5-10-5' }), 15, 'alias');
  assert.equal(distanceFt(o, null), Infinity);
  // Footprints: nearest cells (a Large ogre at (2,2) covers (2..3, 2..3)).
  assert.equal(distanceFt(o, { col: 2, row: 2 }, { sizeB: 'Large' }), 10);
  assert.equal(distanceFt({ col: 4, row: 4 }, { col: 2, row: 2 }, { sizeB: 'Large' }), 5, 'adjacent to the far corner');
  assert.equal(distanceFt({ col: 3, row: 3 }, { col: 2, row: 2 }, { sizeB: 2 }), 0, 'inside the footprint');
  assert.equal(distanceFt(o, { col: 5, row: 5 }, { sizeA: 'Huge', sizeB: 'Large', diagonalRule: '5-10' }), 20, '3 cells apart diagonally');
});

test('findPath: both rules, and the new spelling matches the phase-1 alias', () => {
  const t = createTerrain(8, 8);
  const at = (to, rule) => findPath(t, null, { col: 0, row: 0 }, to, rule ? { diagonalRule: rule } : {}).costFt;
  assert.equal(at({ col: 4, row: 4 }), 20);
  assert.equal(at({ col: 4, row: 4 }, '5ft'), 20);
  assert.equal(at({ col: 4, row: 4 }, '5-10'), 30);
  assert.equal(at({ col: 3, row: 3 }, '5-10'), 20);
  for (const to of [{ col: 2, row: 2 }, { col: 5, row: 3 }, { col: 7, row: 6 }]) {
    assert.equal(at(to, '5-10'), at(to, '5-10-5'));
    assert.equal(at(to, '5-10'), distanceFt({ col: 0, row: 0 }, to, { diagonalRule: '5-10' }), 'open grid: path = distance');
  }
  assert.equal(at({ col: 4, row: 4 }, 'nonsense'), 20, 'unknown rule → 5ft');
});

test('reachableCells: the 5-10 budget reaches fewer diagonal cells', () => {
  const t = createTerrain(10, 10);
  const from = { col: 0, row: 0 };
  const phb = reachableCells(t, null, from, { budgetFt: 30 });
  const dmg = reachableCells(t, null, from, { budgetFt: 30, diagonalRule: '5-10' });
  assert.equal(phb.get('6,6'), 30);
  assert.equal(dmg.has('6,6'), false);
  assert.equal(dmg.get('4,4'), 30);
  assert.equal(dmg.get('6,0'), 30);
  assert.ok(dmg.size < phb.size);
});

test('validateMove: a 5-10 diagonal dash runs over budget where 5ft does not', () => {
  const state = {
    grid: { cols: 10, rows: 10, cellFt: 5 },
    entities: { a: { id: 'a', kind: 'pc', side: 'party', pos: { col: 0, row: 0 }, hp: 10, hpMax: 10, speedFt: 30, conditions: [], resources: {} } }
  };
  const path = diag(5).slice(1);
  assert.deepEqual([validateMove(state, 'a', path).legal, validateMove(state, 'a', path).costFt], [true, 25]);
  const dmg = validateMove(state, 'a', path, { diagonalRule: '5-10' });
  assert.equal(dmg.costFt, 35);
  assert.equal(dmg.legal, false);
  assert.equal(dmg.reason, MOVE_REASONS.OVER_BUDGET);
  assert.deepEqual(validateMove(state, 'a', path, { diagonalRule: '5-10-5' }), dmg);
  assert.equal(validateMove(state, 'a', diag(4).slice(1), { diagonalRule: '5-10' }).legal, true);
});

test('pathCostFt prices a path under either rule, with difficult terrain', () => {
  const t = applyTerrainPaint(createTerrain(6, 6), { cells: [{ col: 2, row: 2 }], flag: TERRAIN_FLAGS.DIFFICULT, op: 'set' });
  assert.equal(pathCostFt(null, diag(4)), 20);
  assert.equal(pathCostFt(null, diag(4), { diagonalRule: '5-10' }), 30);
  assert.equal(pathCostFt(t, diag(3)), 20, 'difficult step doubles');
  assert.equal(pathCostFt(t, diag(3), { diagonalRule: '5-10' }), 30, 'the 10-ft diagonal into difficult terrain costs 20');
  assert.equal(pathCostFt(null, [{ col: 0, row: 0 }, { col: 2, row: 0 }]), Infinity);
  assert.equal(pathCostFt(null, []), 0);
  const r = findPath(t, null, { col: 0, row: 0 }, { col: 4, row: 4 }, { diagonalRule: '5-10' });
  assert.equal(pathCostFt(t, r.path, { diagonalRule: '5-10' }), r.costFt);
});
