// M64 E5 / M1 — grid legality: findPath, validateMove (per-step OAs),
// lineOfSight, coverBetween, weaponRangeBand.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  findPath, reachableCells, validateMove, lineOfSight, coverBetween, weaponRangeBand,
  buildOccupancy, supercoverBetween, MOVE_REASONS, COVER_LEVELS
} from '../js/scene/grid-legality.js';
import { detectOpportunityAttacks } from '../js/scene/reactions.js';
import { createTerrain, applyTerrainPaint, encodeTerrain, TERRAIN_FLAGS } from '../js/map/terrain.js';

const F = TERRAIN_FLAGS;
const paint = (t, cells, flag) => applyTerrainPaint(t, { cells: cells.map(([col, row]) => ({ col, row })), flag, op: 'set' });
const occ = (entries) => ({
  cells: new Set(entries.map(([c, r]) => `${c},${r}`)),
  sides: new Map(entries.map(([c, r, side]) => [`${c},${r}`, side]))
});

function pc(id, col, row, extra = {}) {
  return {
    id, kind: 'pc', side: 'party', name: id, pos: { col, row }, hp: 20, hpMax: 20, speedFt: 30,
    conditions: [], resources: { reactionUsed: false }, ...extra
  };
}
function mon(id, col, row, extra = {}) {
  return {
    id, kind: 'monster', side: 'hostile', name: id, pos: { col, row }, hp: 7, hpMax: 7, speedFt: 30,
    conditions: [], resources: { reactionUsed: false }, statBlock: { slug: 'goblin' }, ...extra
  };
}

// ---- findPath --------------------------------------------------------------

test('findPath: open grid, diagonals cost 5 ft (PHB default)', () => {
  const r = findPath(createTerrain(6, 6), null, { col: 0, row: 0 }, { col: 3, row: 3 });
  assert.equal(r.costFt, 15);
  assert.equal(r.path.length, 4);
  assert.deepEqual(r.path[0], { col: 0, row: 0 });
  assert.deepEqual(r.path.at(-1), { col: 3, row: 3 });
});

test('findPath: 5-10-5 diagonal variant alternates', () => {
  const r = findPath(createTerrain(6, 6), null, { col: 0, row: 0 }, { col: 2, row: 2 }, { diagonalRule: '5-10-5' });
  assert.equal(r.costFt, 15);
  const r3 = findPath(createTerrain(6, 6), null, { col: 0, row: 0 }, { col: 3, row: 3 }, { diagonalRule: '5-10-5' });
  assert.equal(r3.costFt, 20);
});

test('findPath: blocked cells are impassable and the path detours', () => {
  const t = paint(createTerrain(5, 5), [[2, 0], [2, 1], [2, 2], [2, 3]], F.BLOCKED);
  const r = findPath(t, null, { col: 0, row: 1 }, { col: 4, row: 1 });
  assert.ok(r, 'reachable around the wall');
  assert.ok(r.path.every(p => !(p.col === 2 && p.row <= 3)), 'never enters the wall');
  assert.ok(r.costFt > 20);
  assert.equal(findPath(t, null, { col: 0, row: 1 }, { col: 2, row: 1 }), null, 'cannot end in a wall');
});

test('findPath: difficult terrain costs 10 ft per cell', () => {
  const t = paint(createTerrain(3, 1), [[1, 0]], F.DIFFICULT);
  assert.equal(findPath(t, null, { col: 0, row: 0 }, { col: 2, row: 0 }).costFt, 15);
  // With room to go round, the 2-cell detour (10 ft) beats wading (15 ft).
  const wide = paint(createTerrain(3, 2), [[1, 0]], F.DIFFICULT);
  const r = findPath(wide, null, { col: 0, row: 0 }, { col: 2, row: 0 });
  assert.equal(r.costFt, 10);
  assert.deepEqual(r.path[1], { col: 1, row: 1 });
});

test('findPath: passes through allies, not hostiles; cannot end on any occupied cell', () => {
  const t = createTerrain(5, 1);
  const from = { col: 0, row: 0 }, to = { col: 4, row: 0 };
  assert.equal(findPath(t, occ([[2, 0, 'party']]), from, to, { moverSide: 'party' }).costFt, 20);
  assert.equal(findPath(t, occ([[2, 0, 'hostile']]), from, to, { moverSide: 'party' }), null);
  assert.equal(findPath(t, new Set(['2,0']), from, to), null, 'unknown side = impassable');
  assert.equal(findPath(t, occ([[4, 0, 'party']]), from, to, { moverSide: 'party' }), null, 'ally on the destination');
});

test('findPath: budget exhaustion returns null, exact budget succeeds', () => {
  const t = createTerrain(10, 3);
  assert.equal(findPath(t, null, { col: 0, row: 0 }, { col: 7, row: 0 }, { budgetFt: 30 }), null);
  assert.equal(findPath(t, null, { col: 0, row: 0 }, { col: 7, row: 0 }, { budgetFt: 35 }).costFt, 35);
});

test('findPath: no diagonal squeeze between two blocked corners', () => {
  const t = paint(createTerrain(2, 2), [[1, 0], [0, 1]], F.BLOCKED);
  assert.equal(findPath(t, null, { col: 0, row: 0 }, { col: 1, row: 1 }), null);
});

test('findPath: null terrain uses bounds; same cell is a zero-cost path', () => {
  const r = findPath(null, null, { col: 1, row: 1 }, { col: 4, row: 1 }, { bounds: { cols: 6, rows: 3 } });
  assert.equal(r.costFt, 15);
  assert.deepEqual(findPath(null, null, { col: 1, row: 1 }, { col: 1, row: 1 }), { path: [{ col: 1, row: 1 }], costFt: 0 });
  assert.equal(findPath(null, null, { col: 0, row: 0 }, { col: 9, row: 0 }, { bounds: { cols: 6, rows: 3 } }), null);
});

test('reachableCells: budget 5 from the centre of 3x3 reaches all 9 cells; occupied cells excluded', () => {
  const t = createTerrain(3, 3);
  assert.equal(reachableCells(t, null, { col: 1, row: 1 }, { budgetFt: 5 }).size, 9);
  const m = reachableCells(t, occ([[0, 0, 'party']]), { col: 1, row: 1 }, { budgetFt: 5, moverSide: 'party' });
  assert.equal(m.size, 8);
  assert.equal(m.get('1,1'), 0);
});

// ---- validateMove ----------------------------------------------------------

function passByView() {
  return {
    grid: { cols: 7, rows: 5, terrain: encodeTerrain(createTerrain(7, 5)) },
    entities: { hero: pc('hero', 0, 1), gob: mon('gob', 3, 0) }
  };
}
const PASS_BY = [0, 1, 2, 3, 4, 5, 6].map(c => ({ col: c, row: 1 }));

test('validateMove: path-based OA fires where a start/end-only check would not', () => {
  const view = passByView();
  const r = validateMove(view, 'hero', PASS_BY);
  assert.equal(r.legal, true);
  assert.equal(r.costFt, 30);
  assert.deepEqual(r.oaTriggers, [{ entityId: 'gob', reason: 'left-reach', stepIndex: 5, at: { col: 4, row: 1 } }]);
  // The legacy start/end-only check misses it.
  const legacy = detectOpportunityAttacks({
    mover: view.entities.hero, before: PASS_BY[0], after: PASS_BY.at(-1),
    hostiles: [{ ...view.entities.gob, _position: view.entities.gob.pos }]
  });
  assert.deepEqual(legacy, []);
});

test('validateMove: spent reactions, incapacitated hostiles and Disengage suppress the OA', () => {
  const used = passByView();
  used.entities.gob.resources.reactionUsed = true;
  assert.deepEqual(validateMove(used, 'hero', PASS_BY).oaTriggers, []);
  const stunned = passByView();
  stunned.entities.gob.conditions = [{ id: 'stunned' }];
  assert.deepEqual(validateMove(stunned, 'hero', PASS_BY).oaTriggers, []);
  assert.deepEqual(validateMove(passByView(), 'hero', PASS_BY, { disengaged: true }).oaTriggers, []);
});

test('validateMove: a reach weapon (via weaponOf) provokes on a wider band; frozen views are fine', () => {
  const view = passByView();
  const deep = (o) => { Object.freeze(o); for (const v of Object.values(o)) if (v && typeof v === 'object') deep(v); return o; };
  deep(view);
  const r = validateMove(view, 'hero', [...PASS_BY.slice(0, 6)], { weaponOf: () => ({ name: 'Glaive', properties: ['reach'] }) });
  // Glaive reach 10: in reach for cols 1..5, so a path ending at col 5 never leaves it.
  assert.equal(r.oaTriggers.length, 0);
  const r2 = validateMove(view, 'hero', PASS_BY, { weaponOf: () => ({ name: 'Glaive', properties: ['reach'] }) });
  assert.equal(r2.oaTriggers[0].stepIndex, 6);
});

test('validateMove: budget, contiguity, walls, hostiles and destination occupancy', () => {
  const view = passByView();
  const long = [...PASS_BY, { col: 6, row: 2 }];
  const over = validateMove(view, 'hero', long);
  assert.equal(over.legal, false);
  assert.equal(over.reason, MOVE_REASONS.OVER_BUDGET);
  assert.equal(over.costFt, 35);
  assert.equal(validateMove(view, 'hero', long, { ignoreBudget: true }).legal, true);
  assert.equal(validateMove(view, 'hero', long, { budgetFt: 60 }).legal, true);
  assert.equal(validateMove(view, 'hero', [{ col: 0, row: 1 }, { col: 2, row: 1 }]).reason, MOVE_REASONS.NOT_CONTIGUOUS);
  assert.equal(validateMove(view, 'hero', [{ col: 0, row: 1 }, { col: -1, row: 1 }]).reason, MOVE_REASONS.OUT_OF_BOUNDS);

  const walled = { ...view, grid: { ...view.grid, terrain: encodeTerrain(paint(createTerrain(7, 5), [[2, 1]], F.BLOCKED)) } };
  const w = validateMove(walled, 'hero', PASS_BY);
  assert.equal(w.reason, MOVE_REASONS.BLOCKED);
  assert.equal(w.failedAt, 2);

  const crowded = passByView();
  crowded.entities.orc = mon('orc', 2, 1);
  crowded.entities.ally = pc('ally', 4, 1);
  assert.equal(validateMove(crowded, 'hero', PASS_BY).reason, MOVE_REASONS.HOSTILE_OCCUPIED);
  delete crowded.entities.orc;
  assert.equal(validateMove(crowded, 'hero', PASS_BY).legal, true, 'passes through the ally');
  assert.equal(validateMove(crowded, 'hero', PASS_BY.slice(0, 5)).reason, MOVE_REASONS.DESTINATION_OCCUPIED);
  assert.equal(validateMove(crowded, 'nobody', PASS_BY).reason, MOVE_REASONS.UNKNOWN_MOVER);
});

test('validateMove: accepts a RenderView token list and paths without the start cell', () => {
  const view = { grid: { cols: 7, rows: 5 }, tokens: [
    { id: 'hero', kind: 'pc', side: 'party', col: 0, row: 1 },
    { id: 'gob', kind: 'monster', side: 'hostile', col: 3, row: 0 }
  ] };
  const r = validateMove(view, 'hero', PASS_BY.slice(1));
  assert.equal(r.legal, true);
  assert.equal(r.oaTriggers.length, 1);
});

test('validateMove: dead monsters neither block nor react', () => {
  const view = passByView();
  view.entities.gob.hp = 0;
  view.entities.corpse = mon('corpse', 2, 1, { hp: 0 });
  const r = validateMove(view, 'hero', PASS_BY);
  assert.equal(r.legal, true);
  assert.deepEqual(r.oaTriggers, []);
});

test('buildOccupancy: excludes the mover and dead monsters, records sides', () => {
  const o = buildOccupancy([pc('a', 0, 0), mon('b', 1, 0), mon('c', 2, 0, { hp: 0 })], { excludeId: 'a' });
  assert.deepEqual([...o.cells], ['1,0']);
  assert.equal(o.sides.get('1,0'), 'hostile');
});

// ---- line of sight ---------------------------------------------------------

test('lineOfSight: flag 16 blocks; blocked-only (flag 1) does not', () => {
  const a = { col: 0, row: 2 }, b = { col: 4, row: 2 };
  assert.equal(lineOfSight(createTerrain(5, 5), a, b), true);
  assert.equal(lineOfSight(paint(createTerrain(5, 5), [[2, 2]], F.TOTAL_COVER), a, b), false);
  assert.equal(lineOfSight(paint(createTerrain(5, 5), [[2, 2]], F.BLOCKED), a, b), true);
  assert.equal(lineOfSight(null, a, b), true);
  // Endpoints never block their own sight line.
  assert.equal(lineOfSight(paint(createTerrain(5, 5), [[0, 2], [4, 2]], F.TOTAL_COVER), a, b), true);
});

test('lineOfSight: exact-corner diagonal is blocked only when both corner cells block', () => {
  const a = { col: 0, row: 0 }, b = { col: 2, row: 2 };
  assert.equal(lineOfSight(paint(createTerrain(3, 3), [[1, 0]], F.TOTAL_COVER), a, b), true);
  assert.equal(lineOfSight(paint(createTerrain(3, 3), [[1, 0], [0, 1]], F.TOTAL_COVER), a, b), false);
  assert.equal(lineOfSight(paint(createTerrain(3, 3), [[1, 1]], F.TOTAL_COVER), a, b), false);
});

test('supercoverBetween: lists intermediate cells, with corner pairs on exact diagonals', () => {
  assert.deepEqual(supercoverBetween({ col: 0, row: 0 }, { col: 3, row: 0 }), [[{ col: 1, row: 0 }], [{ col: 2, row: 0 }]]);
  const diag = supercoverBetween({ col: 0, row: 0 }, { col: 2, row: 2 });
  assert.equal(diag.length, 3);
  assert.equal(diag[0].length, 2);
  assert.deepEqual(diag[1], [{ col: 1, row: 1 }]);
  assert.deepEqual(supercoverBetween({ col: 1, row: 1 }, { col: 2, row: 1 }), []);
});

// ---- cover -----------------------------------------------------------------

test('coverBetween: nothing in the way is no cover', () => {
  assert.equal(coverBetween(createTerrain(6, 6), [], { col: 0, row: 0 }, { col: 4, row: 3 }), 'none');
  assert.equal(coverBetween(null, [], { col: 0, row: 0 }, { col: 0, row: 0 }), 'none');
});

test('coverBetween: a low wall (half-cover cell) gives half cover', () => {
  const t = paint(createTerrain(6, 3), [[2, 0]], F.HALF_COVER);
  assert.equal(coverBetween(t, [], { col: 0, row: 0 }, { col: 4, row: 0 }), 'half');
});

test('coverBetween: a creature in between gives half cover', () => {
  assert.equal(coverBetween(createTerrain(4, 3), [pc('x', 1, 0)], { col: 0, row: 0 }, { col: 2, row: 0 }), 'half');
  // The attacker and target themselves never count.
  assert.equal(coverBetween(createTerrain(4, 3), [pc('a', 0, 0), pc('t', 2, 0)], { col: 0, row: 0 }, { col: 2, row: 0 }), 'none');
});

test('coverBetween: a solid three-quarters barrier gives three-quarters cover', () => {
  const t = paint(createTerrain(5, 5), [[2, 1], [2, 2], [2, 3]], F.THREE_QUARTERS_COVER);
  assert.equal(coverBetween(t, [], { col: 0, row: 2 }, { col: 3, row: 2 }), 'threeQuarters');
});

test('coverBetween: a full-height wall gives total cover; a single pillar only half', () => {
  const wall = paint(createTerrain(5, 5), [[2, 0], [2, 1], [2, 2], [2, 3], [2, 4]], F.TOTAL_COVER);
  assert.equal(coverBetween(wall, [], { col: 0, row: 2 }, { col: 4, row: 2 }), 'total');
  const pillar = paint(createTerrain(5, 5), [[2, 2]], F.TOTAL_COVER);
  assert.equal(coverBetween(pillar, [], { col: 0, row: 2 }, { col: 4, row: 2 }), 'half');
  assert.deepEqual(COVER_LEVELS, ['none', 'half', 'threeQuarters', 'total']);
});

// ---- weapon range bands ----------------------------------------------------

test('weaponRangeBand: ranged weapons use the PHB normal/long table', () => {
  const longbow = { name: 'Longbow', properties: ['Ammunition', 'Heavy', 'Two-Handed'] };
  assert.equal(weaponRangeBand(longbow, 150), 'normal');
  assert.equal(weaponRangeBand(longbow, 155), 'long');
  assert.equal(weaponRangeBand(longbow, 605), 'out');
  assert.equal(weaponRangeBand({ name: 'Hand Crossbow' }, 35), 'long');
  assert.equal(weaponRangeBand({ name: 'Heavy Crossbow' }, 100), 'normal');
});

test('weaponRangeBand: explicit range objects and "N/M" strings win over the table', () => {
  assert.equal(weaponRangeBand({ name: 'Arbalest', properties: ['ranged'], range: { normal: 30, long: 120 } }, 60), 'long');
  assert.equal(weaponRangeBand({ name: 'Arbalest', properties: ['ranged'], range: '100/400' }, 60), 'normal');
  assert.equal(weaponRangeBand({ name: 'Arbalest', properties: ['ranged'], range: { normal: 30 } }, 35), 'out');
});

test('weaponRangeBand: melee uses reach; thrown weapons need usedAsRanged', () => {
  assert.equal(weaponRangeBand({ name: 'Longsword' }, 5), 'normal');
  assert.equal(weaponRangeBand({ name: 'Longsword' }, 10), 'out');
  assert.equal(weaponRangeBand({ name: 'Glaive', properties: ['reach'] }, 10), 'normal');
  const dagger = { name: 'Dagger', properties: ['Finesse', 'Light', 'Thrown'] };
  assert.equal(weaponRangeBand(dagger, 20), 'out');
  assert.equal(weaponRangeBand({ ...dagger, usedAsRanged: true }, 20), 'normal');
  assert.equal(weaponRangeBand({ ...dagger, usedAsRanged: true }, 60), 'long');
  assert.equal(weaponRangeBand({ ...dagger, usedAsRanged: true }, 65), 'out');
  assert.equal(weaponRangeBand(null, 5), 'normal');
  assert.equal(weaponRangeBand({ name: 'Longbow' }, NaN), 'out');
});
