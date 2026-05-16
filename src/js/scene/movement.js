/**
 * M31 — Simple movement AI for the simulator + Versus auto-fight.
 *
 * Crude but effective: each entity, on its turn, plans a single move
 * step toward its target. If already within reach (for melee) or
 * within range (for ranged), it doesn't move. Otherwise it advances
 * by `speedCells` cells along the straight (Chebyshev) line toward
 * the target, stopping at the cell just inside reach.
 *
 * Pure module — no DOM. Inputs are plain values; tests can pass
 * synthetic scenes.
 *
 * Scope (v1):
 *   - Single move per turn (no "dash" yet).
 *   - Chebyshev pathing (5e square-grid distance); each cell costs
 *     5 ft regardless of diagonal vs cardinal.
 *   - Occupied-cell avoidance: prefers a free cell within 1 step of
 *     the ideal target cell; falls back to staying put if every
 *     candidate is blocked.
 *   - No terrain, no opportunity attacks, no difficult terrain.
 */

import { chebyshevFeet, isRangedWeapon, meleeReachFt } from './grid-rules.js';

const DEFAULT_SPEED_FT = 30;   // PC + most monster defaults; 6 cells

/**
 * Plan the next position for `mover` given its `target`.
 *
 *   from        — { col, row }
 *   to          — { col, row }  (target's position)
 *   weapon      — used to derive reach (melee 5/10ft) or range (ranged 80ft default)
 *   speedFt     — feet of movement available this turn (default 30)
 *   occupied    — Set or array of "col,row" strings or { col, row } objects
 *                 (cells the mover may NOT step onto)
 *   bounds      — { cols, rows } for clamping
 *
 * Returns the new { col, row }. If the mover is already in reach, or
 * if no valid forward step exists, returns the original position.
 */
export function planMovement({
  from, to, weapon, speedFt = DEFAULT_SPEED_FT,
  occupied = [], bounds = { cols: Infinity, rows: Infinity }
} = {}) {
  if (!from || !to) return from || null;
  const ranged = isRangedWeapon(weapon);
  // Compute "in-reach distance" for the current weapon. For ranged we
  // treat anything within range as in-reach (we don't track ammo or
  // line-of-sight in v1, so the attacker stays put if within ~80ft).
  const reach = ranged ? 80 : meleeReachFt(weapon);
  const currentDist = chebyshevFeet(from, to);
  if (currentDist <= reach) return from;     // already in range
  const stepsAvailable = Math.floor(speedFt / 5);
  if (stepsAvailable <= 0) return from;

  // Stop one cell shy of `reach` so the attacker is *in* reach but not
  // co-located with the target. For 5-ft melee, that means stopping
  // adjacent to the target (distance == 5).
  const distanceToClose = currentDist - reach;
  const stepsToTake = Math.min(stepsAvailable, distanceToClose / 5);
  if (stepsToTake <= 0) return from;

  // Straight-line Chebyshev step: at most 1 unit in each axis per step.
  const dc = Math.sign(to.col - from.col);
  const dr = Math.sign(to.row - from.row);
  let cand = {
    col: clampInt(from.col + dc * stepsToTake, 0, bounds.cols - 1),
    row: clampInt(from.row + dr * stepsToTake, 0, bounds.rows - 1)
  };

  // Occupied-cell avoidance. If `cand` is blocked, look for the closest
  // unblocked neighbor of cand that is also closer to the target than
  // `from`. Falls back to `from` if nothing works.
  const occSet = toCellSet(occupied);
  if (!occSet.has(key(cand))) return cand;
  for (const neighbor of neighborhood(cand)) {
    if (neighbor.col < 0 || neighbor.col >= bounds.cols) continue;
    if (neighbor.row < 0 || neighbor.row >= bounds.rows) continue;
    if (occSet.has(key(neighbor))) continue;
    // Must be at least as close to the target as the starting cell
    if (chebyshevFeet(neighbor, to) >= currentDist) continue;
    return neighbor;
  }
  return from;
}

// ---------- Helpers ----------

function clampInt(v, lo, hi) {
  return Math.max(lo, Math.min(hi, Math.round(v)));
}

function key(cell) { return `${cell.col},${cell.row}`; }

function toCellSet(occupied) {
  if (occupied instanceof Set) return occupied;
  const out = new Set();
  for (const o of occupied) {
    if (typeof o === 'string') out.add(o);
    else if (o && Number.isFinite(o.col) && Number.isFinite(o.row)) out.add(key(o));
  }
  return out;
}

function* neighborhood(cell) {
  for (let dc = -1; dc <= 1; dc++) {
    for (let dr = -1; dr <= 1; dr++) {
      if (dc === 0 && dr === 0) continue;
      yield { col: cell.col + dc, row: cell.row + dr };
    }
  }
}

/**
 * Convenience: ALL occupied cells in a scene (PCs + monsters), expressed
 * as a Set of "col,row" strings. Used by the simulator and auto-fight
 * before calling planMovement so movers don't try to step onto allies.
 */
export function occupiedCellsOf({ party = [], monsters = [], scene = null, excludeId = null } = {}) {
  const out = new Set();
  for (const pc of party) {
    if (String(pc.id) === String(excludeId)) continue;
    const pos = pc._position || (scene?.positions?.[String(pc.id)]) || null;
    if (pos) out.add(key(pos));
  }
  for (const m of monsters) {
    if (String(m.id) === String(excludeId)) continue;
    const pos = m._position || m.position;
    if (pos) out.add(key(pos));
  }
  return out;
}
