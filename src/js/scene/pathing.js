/**
 * M64 T11 — terrain-aware movement hook.
 *
 * When an encounter has a terrain layer (`scene.terrain`, from
 * EncounterState `grid.terrain`), the engine routes movement through
 * E5's `grid-legality.findPath(terrain, occupancy, from, to,
 * {budgetFt, moverSide}) → {path, costFt} | null` (Dijkstra, 8-neighbour,
 * difficult terrain 10 ft, pass allies not hostiles, never end on an
 * occupied cell, no diagonal squeeze between two blocked corner cells).
 * Terrain-free encounters keep `planMovement`, so seeded results stay
 * byte-identical.
 *
 * `occupancy` is grid-legality's `buildOccupancy` shape:
 * `{cells: Set<"col,row">, sides: Map<"col,row", 'party'|'hostile'>}`.
 */

import { findPath as gridFindPath, buildOccupancy, reachableCells } from './grid-legality.js';
import { chebyshevFeet } from './grid-rules.js';

let findPathImpl = gridFindPath;

/**
 * The pathfinder in use: grid-legality.findPath unless a test injected one.
 * @returns {Function}
 */
export function getFindPath() {
  return findPathImpl;
}

/**
 * Inject a pathfinder (tests), or restore grid-legality's with `undefined`
 * / `null`.
 * @param {Function|null|undefined} fn
 */
export function setFindPath(fn) {
  findPathImpl = typeof fn === 'function' ? fn : gridFindPath;
}

/**
 * Occupancy for a mover: every other creature's cell with its side (dead
 * monsters skipped — grid-legality's rule).
 * @param {object} mover — engine wrapper
 * @param {object[]} creatures — every wrapper in the encounter
 * @returns {{cells: Set<string>, sides: Map<string, string>}}
 */
export function occupancyFor(mover, creatures) {
  return buildOccupancy(creatures, { excludeId: mover?.id });
}

/**
 * A terrain route from `from` toward `to` within `budgetFt`, or null when
 * there is none. `moverSide` lets the mover pass allies but not hostiles.
 * @param {object} terrain — `grid.terrain`
 * @param {object} mover — engine wrapper
 * @param {object[]} creatures — every wrapper in the encounter
 * @param {{col: number, row: number}} from
 * @param {{col: number, row: number}} to
 * @param {number} budgetFt
 * @returns {{to: {col: number, row: number}, path: {col: number, row: number}[], costFt: number}|null}
 */
export function terrainPath(terrain, mover, creatures, from, to, budgetFt) {
  const moverSide = mover?.kind === 'pc' ? 'party' : 'hostile';
  const res = findPathImpl(terrain, occupancyFor(mover, creatures), from, to, { budgetFt, moverSide });
  if (!res || !Array.isArray(res.path) || res.path.length === 0) return null;
  const end = res.path[res.path.length - 1];
  return { to: { col: end.col, row: end.row }, path: res.path, costFt: res.costFt ?? 0 };
}

/**
 * A terrain route that closes on `target` (an occupied cell, which
 * findPath never ends on): among the cells reachable within `budgetFt`,
 * the cheapest one within `reachFt` of the target, else the one nearest
 * to it (ties: cheaper, then grid-legality's search order). Already in
 * reach → stays put. Null when nothing reachable is closer.
 * @param {object} terrain
 * @param {object} mover — engine wrapper
 * @param {object[]} creatures — every wrapper in the encounter
 * @param {{col: number, row: number}} from
 * @param {{col: number, row: number}} target
 * @param {number} reachFt
 * @param {number} budgetFt
 * @returns {{to: {col: number, row: number}, path: {col: number, row: number}[], costFt: number}|null}
 */
export function terrainApproach(terrain, mover, creatures, from, target, reachFt, budgetFt) {
  if (chebyshevFeet(from, target) <= reachFt) return { to: { col: from.col, row: from.row }, path: [{ col: from.col, row: from.row }], costFt: 0 };
  const moverSide = mover?.kind === 'pc' ? 'party' : 'hostile';
  const occ = occupancyFor(mover, creatures);
  const cells = reachableCells(terrain, occ, from, { budgetFt, moverSide });
  let best = null;
  for (const [k, cost] of cells) {
    const [col, row] = k.split(',').map(Number);
    const d = chebyshevFeet({ col, row }, target);
    const score = Math.max(d, reachFt);   // every in-reach cell is equally good
    if (!best || score < best.score || (score === best.score && cost < best.cost)) best = { col, row, cost, score };
  }
  if (!best || best.score >= chebyshevFeet(from, target)) return null;
  return terrainPath(terrain, mover, creatures, from, { col: best.col, row: best.row }, budgetFt);
}

/**
 * Cells from `from` to `to` (both included) stepping diagonally first —
 * the path the straight-line planMovement implies on a 5-ft grid.
 * @param {{col: number, row: number}} from
 * @param {{col: number, row: number}} to
 * @returns {{col: number, row: number}[]}
 */
export function straightPath(from, to) {
  const path = [{ col: from.col, row: from.row }];
  let { col, row } = from;
  for (let guard = 0; guard < 1000 && (col !== to.col || row !== to.row); guard++) {
    col += Math.sign(to.col - col);
    row += Math.sign(to.row - row);
    path.push({ col, row });
  }
  return path;
}
