/**
 * M64 T11 — move events carry the path; terrain routes through
 * grid-legality.findPath (injected here), terrain-free movement is
 * unchanged.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { straightPath, setFindPath, loadFindPath } from '../js/scene/pathing.js';
import { runOneAttack } from '../js/scene/combat-engine.js';
import { createRng } from '../js/scene/rng.js';
import { buildPc, buildMonster, buildScene } from './helpers/entities.js';

afterEach(() => setFindPath(undefined));

test('T11: straightPath steps diagonally first and includes both ends', () => {
  assert.deepEqual(straightPath({ col: 0, row: 0 }, { col: 3, row: 1 }),
    [{ col: 0, row: 0 }, { col: 1, row: 1 }, { col: 2, row: 1 }, { col: 3, row: 1 }]);
  assert.deepEqual(straightPath({ col: 2, row: 2 }, { col: 2, row: 2 }), [{ col: 2, row: 2 }]);
});

test('T11: without grid-legality on this branch the loader reports null', async () => {
  assert.equal(await loadFindPath(), null);
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
  assert.equal(calls[0].occupancy.get('9,1'), 'hostile');
  assert.deepEqual(pc._position, { col: 2, row: 2 });
  assert.equal(move.path.length, 3);
  // No route → falls back to the straight-line planner.
  setFindPath(() => null);
  const fallback = await moveTurn(buildScene({ terrain: { v: 1, cols: 10, rows: 7, flags: '' } }));
  assert.deepEqual(fallback.pc._position, { col: 6, row: 1 });
});
