/**
 * M64 T11 — move events carry the path; terrain routes through
 * grid-legality.findPath (statically imported since M1 merged; tests may
 * inject a stand-in), terrain-free movement is unchanged.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { straightPath, setFindPath, getFindPath, terrainApproach } from '../js/scene/pathing.js';
import { findPath } from '../js/scene/grid-legality.js';
import { createTerrain, encodeTerrain, setFlag, TERRAIN_FLAGS } from '../js/map/terrain.js';
import { runOneAttack } from '../js/scene/combat-engine.js';
import { createRng } from '../js/scene/rng.js';
import { buildPc, buildMonster, buildScene } from './helpers/entities.js';

afterEach(() => setFindPath(undefined));

test('T11: straightPath steps diagonally first and includes both ends', () => {
  assert.deepEqual(straightPath({ col: 0, row: 0 }, { col: 3, row: 1 }),
    [{ col: 0, row: 0 }, { col: 1, row: 1 }, { col: 2, row: 1 }, { col: 3, row: 1 }]);
  assert.deepEqual(straightPath({ col: 2, row: 2 }, { col: 2, row: 2 }), [{ col: 2, row: 2 }]);
});

test('T11: the pathfinder is grid-legality.findPath (static import); setFindPath injects and restores', () => {
  assert.equal(getFindPath(), findPath);
  const fake = () => null;
  setFindPath(fake);
  assert.equal(getFindPath(), fake);
  setFindPath(undefined);
  assert.equal(getFindPath(), findPath);
});

async function moveTurn(scene, prompts = {}) {
  const events = [];
  const pc = buildPc({ id: 'pc', _position: { col: 0, row: 1 } });
  const m = buildMonster({ id: 'm', position: { col: 9, row: 1 }, hp: 50, hpMax: 50 });
  await runOneAttack(pc, [m], [pc], scene, createRng({ s: 2 }), {
    forcePlan: { kind: 'melee', targetId: 'm', targetSide: 'enemy', featuresFired: [] }, ...prompts
  }, { emit: (e) => events.push(e) });
  return { pc, move: events.find(e => e.type === 'move')?.payload };
}

test('T11: terrain-free moves are unchanged and carry the straight path; onMove sees it', async () => {
  const seen = [];
  const plain = await moveTurn(buildScene());
  const withHook = await moveTurn(buildScene(), { onMove: async (m) => { seen.push(m.path.length); } });
  assert.deepEqual(plain.pc._position, { col: 6, row: 1 });
  assert.deepEqual(withHook.pc._position, plain.pc._position);
  assert.equal(plain.move.path.length, 7);
  assert.deepEqual(plain.move.path.at(-1), plain.move.to);
  assert.deepEqual(seen, [7]);
});

test('T11: with a terrain layer the injected findPath decides the route', async () => {
  const calls = [];
  setFindPath((terrain, occupancy, from, to, opts) => {
    calls.push({ terrain, occupancy, from, to, opts });
    return { path: [from, { col: 1, row: 2 }, { col: 2, row: 2 }], costFt: 15 };   // e.g. around difficult terrain
  });
  const { pc, move } = await moveTurn(buildScene({ terrain: { v: 1, cols: 10, rows: 7, flags: '' } }));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].opts.budgetFt, 30);
  assert.equal(calls[0].opts.moverSide, 'party');
  assert.equal(calls[0].occupancy.sides.get('9,1'), 'hostile', 'grid-legality occupancy shape');
  assert.ok(!calls[0].occupancy.cells.has('0,1'), 'the mover is not in its own occupancy');
  assert.deepEqual(pc._position, { col: 2, row: 2 });
  assert.equal(move.path.length, 3);
  // No route → falls back to the straight-line planner.
  setFindPath(() => null);
  const fallback = await moveTurn(buildScene({ terrain: { v: 1, cols: 10, rows: 7, flags: '' } }));
  assert.deepEqual(fallback.pc._position, { col: 6, row: 1 });
});

/** Wire terrain with `blocked` cells set. */
function terrainWith(cols, rows, blocked = [], flag = TERRAIN_FLAGS.BLOCKED) {
  let t = createTerrain(cols, rows);
  for (const [col, row] of blocked) t = setFlag(t, col, row, flag);
  return encodeTerrain(t);
}

test('T11: a real terrain layer routes around a wall and ends adjacent to the target', async () => {
  // Wall at col 3, rows 0-2; the PC at (0,1) closes on a goblin at (9,1).
  const terrain = terrainWith(10, 7, [[3, 0], [3, 1], [3, 2]]);
  const { pc, move } = await moveTurn(buildScene({ terrain }));
  assert.ok(move, 'the PC moved');
  for (const c of move.path) assert.ok(!(c.col === 3 && c.row <= 2), `path avoids the wall (${c.col},${c.row})`);
  assert.deepEqual(move.path.at(-1), pc._position);
  assert.ok(move.path.length <= 7, '30 ft budget');
});

test('T11: terrainApproach stays put in reach and never ends on the target cell', () => {
  const mover = buildPc({ id: 'pc', _position: { col: 0, row: 0 } });
  const goblin = buildMonster({ id: 'g', position: { col: 1, row: 0 } });
  const terrain = terrainWith(5, 5);
  const stay = terrainApproach(terrain, mover, [mover, goblin], { col: 0, row: 0 }, { col: 1, row: 0 }, 5, 30);
  assert.deepEqual(stay.to, { col: 0, row: 0 });
  goblin.position = { col: 4, row: 0 };
  const go = terrainApproach(terrain, mover, [mover, goblin], { col: 0, row: 0 }, { col: 4, row: 0 }, 5, 30);
  assert.equal(Math.max(Math.abs(go.to.col - 4), Math.abs(go.to.row - 0)), 1, 'adjacent to the goblin');
});

test('T11: a player moveTo through a diagonal corner squeeze is rejected (E5 path rule)', async () => {
  // (1,0) and (0,1) blocked: the diagonal (0,0)→(1,1) squeezes between them,
  // and every other way out of the corner is walled off.
  const terrain = terrainWith(4, 4, [[1, 0], [0, 1]]);
  const events = [];
  const pc = buildPc({ id: 'pc', _position: { col: 0, row: 0 } });
  const m = buildMonster({ id: 'm', position: { col: 3, row: 3 }, hp: 50, hpMax: 50 });
  await runOneAttack(pc, [m], [pc], buildScene({ cols: 4, rows: 4, terrain }), createRng({ s: 2 }), {
    forcePlan: { kind: 'move', moveTo: { col: 1, row: 1 }, targetId: 'm', targetSide: 'enemy', featuresFired: [] }
  }, { emit: (e) => events.push(e) });
  const rejected = events.find(e => e.type === 'turn.rejected');
  assert.ok(rejected, 'rejected');
  assert.equal(rejected.payload.code, 'bad-move');
  assert.deepEqual(pc._position, { col: 0, row: 0 });
});
