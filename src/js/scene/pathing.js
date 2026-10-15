/**
 * M64 T11 — terrain-aware movement hook.
 *
 * When an encounter has a terrain layer (`scene.terrain`, from
 * EncounterState `grid.terrain`), the engine routes movement through
 * E5's `grid-legality.findPath(terrain, occupancy, from, to,
 * {budgetFt, moverSide}) → {path, costFt} | null` (Dijkstra, 8-neighbour,
 * difficult terrain 10 ft, pass allies not hostiles, never end on an
 * occupied cell). Terrain-free encounters keep `planMovement`, so seeded
 * results stay byte-identical.
 *
 * TODO(M64 merge, architect): grid-legality.js is E5's (p1/e5-map) and
 * not on main yet. It is loaded behind a dynamic-import guard; until it
 * exists (or `setFindPath` injects one) terrain movement falls back to
 * planMovement. Once it lands, replace the guarded import with a static
 * `import { findPath } from './grid-legality.js'` and confirm the
 * occupancy shape below matches E5's.
 *
 * `occupancy` handed to findPath: Map<"col,row", 'party'|'hostile'>.
 */

let findPathImpl;   // undefined: not loaded yet; null: unavailable

/**
 * Resolve grid-legality.findPath once (null when the module is absent).
 * @returns {Promise<Function|null>}
 */
export async function loadFindPath() {
  if (findPathImpl !== undefined) return findPathImpl;
  try {
    const spec = './grid-legality.js';
    const mod = await import(/* @vite-ignore */ spec);
    findPathImpl = typeof mod.findPath === 'function' ? mod.findPath : null;
  } catch {
    findPathImpl = null;
  }
  return findPathImpl;
}

/**
 * Inject (or clear with `undefined`) the pathfinder: the wiring point for
 * the server and tests.
 * @param {Function|null|undefined} fn
 */
export function setFindPath(fn) {
  findPathImpl = fn;
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
