/**
 * M64 E5 / M1 — grid legality: pathing, move validation, line of sight,
 * cover and weapon range bands.
 *
 * Pure and Node-safe (no DOM, no storage, no animation layer) so the
 * server, the simulator and the browser all answer "can this creature go
 * there / see that / hit that" with the same code. Positions are
 * `{col, row}`; one cell is 5 ft.
 *
 * Terrain is the shared layer from `src/js/map/terrain.js` (wire form
 * `grid.terrain` or the decoded working form). Occupancy is
 * `{cells: Set<"col,row">, sides: Map<"col,row", 'party'|'hostile'>}`;
 * `buildOccupancy(entities)` makes one from any entity shape we use
 * (EncounterState entities, engine wrappers, RenderView tokens). A bare
 * `Set` is accepted too; cells without a known side are treated as
 * hostile (impassable), which is the conservative reading.
 *
 * Rules implemented (PHB unless noted):
 *   - Movement is 8-neighbour. Every diagonal costs 5 ft (`diagonalRule:
 *     '5ft'`, PHB default) or alternates 5/10 (`'5-10-5'`, DMG variant).
 *   - Difficult terrain doubles the cost of entering a cell.
 *   - Blocked cells are impassable; a diagonal step may not squeeze
 *     between two blocked orthogonal neighbours (corner cutting).
 *   - A mover may pass through allies but not hostiles (PHB p191) and may
 *     not end its move in any occupied cell.
 *   - Opportunity attacks are evaluated per step, so passing through a
 *     hostile's reach provokes even when the start and end cells are both
 *     outside it.
 *   - Cover uses the DMG p251 grid rule: from the attacker corner that is
 *     best for the attacker, trace lines to the four corners of the
 *     target's cell; 1–2 blocked lines = half, 3–4 = three-quarters,
 *     all four blocked by total-cover cells = total. Obstacles cap the
 *     result at their own degree (a low wall never gives more than half);
 *     creatures give half cover.
 *
 * Phase-1 limits: every creature occupies one cell; no thin edge walls.
 */

import { isRangedWeapon, meleeReachFt } from './grid-rules.js';
import { detectOpportunityAttacks, detectPolearmEntryOAs } from './reactions.js';
import { asTerrain, TERRAIN_FLAGS } from '../map/terrain.js';

const FT_PER_CELL = 5;
const DIRS = [
  [1, 0], [-1, 0], [0, 1], [0, -1],
  [1, 1], [1, -1], [-1, 1], [-1, -1]
];

/** Cover degrees, ordered. */
export const COVER_LEVELS = Object.freeze(['none', 'half', 'threeQuarters', 'total']);

/** Reasons `validateMove` reports. */
export const MOVE_REASONS = Object.freeze({
  UNKNOWN_MOVER: 'unknown-mover',
  NOT_CONTIGUOUS: 'not-contiguous',
  OUT_OF_BOUNDS: 'out-of-bounds',
  BLOCKED: 'blocked',
  CORNER: 'corner-cut',
  HOSTILE_OCCUPIED: 'hostile-occupied',
  DESTINATION_OCCUPIED: 'destination-occupied',
  OVER_BUDGET: 'over-budget'
});

// ---------------------------------------------------------------------------
// Entity helpers (shape-agnostic)
// ---------------------------------------------------------------------------

/** Cell key. */
export function cellKey(cell) { return `${cell.col},${cell.row}`; }

function posOf(e) {
  if (!e) return null;
  const p = e.pos || e._position || e.position;
  if (p && Number.isFinite(p.col) && Number.isFinite(p.row)) return p;
  if (Number.isFinite(e.col) && Number.isFinite(e.row)) return { col: e.col, row: e.row };
  return null;
}

function sideOf(e) {
  if (e?.side === 'party' || e?.side === 'hostile') return e.side;
  if (e?.kind === 'monster' || e?._isMonster || e?.presetSlug || e?._presetSlug) return 'hostile';
  return 'party';
}

function hpOf(e) {
  const hp = e?.hp;
  if (typeof hp === 'number') return hp;
  if (hp && typeof hp.current === 'number') return hp.current;
  return null;
}

/** A dead monster is an object, not a creature: it neither blocks nor reacts. */
function isDeadMonster(e) {
  return sideOf(e) === 'hostile' && hpOf(e) !== null && hpOf(e) <= 0;
}

function entityList(entities) {
  if (!entities) return [];
  if (Array.isArray(entities)) return entities.filter(Boolean);
  return Object.values(entities).filter(Boolean);
}

function conditionIds(conds) {
  return (Array.isArray(conds) ? conds : []).map(c => (typeof c === 'string' ? c : c?.id)).filter(Boolean);
}

/**
 * Build occupancy from entities. Dead monsters are skipped.
 * @param {object[]|Record<string, object>} entities
 * @param {{excludeId?: string}} [opts] — usually the mover
 * @returns {{cells: Set<string>, sides: Map<string, string>}}
 */
export function buildOccupancy(entities, { excludeId = null } = {}) {
  const cells = new Set();
  const sides = new Map();
  for (const e of entityList(entities)) {
    if (excludeId != null && String(e.id) === String(excludeId)) continue;
    if (isDeadMonster(e)) continue;
    const p = posOf(e);
    if (!p) continue;
    const k = cellKey(p);
    cells.add(k);
    // A cell holding both sides (shouldn't happen) reads as hostile.
    if (sides.get(k) !== 'hostile') sides.set(k, sideOf(e));
  }
  return { cells, sides };
}

function normaliseOccupancy(occ) {
  if (!occ) return { cells: new Set(), sides: new Map() };
  if (occ instanceof Set) return { cells: occ, sides: new Map() };
  return { cells: occ.cells || new Set(), sides: occ.sides || new Map() };
}

// ---------------------------------------------------------------------------
// Grid model shared by findPath / validateMove
// ---------------------------------------------------------------------------

function makeGrid(terrain, bounds) {
  const t = asTerrain(terrain);
  const cols = t ? t.cols : (Number.isFinite(bounds?.cols) ? bounds.cols : Infinity);
  const rows = t ? t.rows : (Number.isFinite(bounds?.rows) ? bounds.rows : Infinity);
  const flag = (c, r) => (t && c >= 0 && r >= 0 && c < t.cols && r < t.rows ? t.cells[r * t.cols + c] : 0);
  const inside = (c, r) => c >= 0 && r >= 0 && c < cols && r < rows;
  return { t, cols, rows, flag, inside };
}

function isBlocked(grid, c, r) { return (grid.flag(c, r) & TERRAIN_FLAGS.BLOCKED) !== 0; }

function cornerCut(grid, c, r, dc, dr) {
  if (dc === 0 || dr === 0) return false;
  return isBlocked(grid, c + dc, r) && isBlocked(grid, c, r + dr);
}

/** Cost in feet of stepping (dc,dr) into (c,r); `parity` = diagonals so far (5-10-5). */
function stepCost(grid, c, r, dc, dr, parity, diagonalRule) {
  const diagonal = dc !== 0 && dr !== 0;
  let base = FT_PER_CELL;
  if (diagonal && diagonalRule === '5-10-5' && parity === 1) base = FT_PER_CELL * 2;
  const difficult = (grid.flag(c, r) & TERRAIN_FLAGS.DIFFICULT) !== 0;
  return difficult ? base * 2 : base;
}

// Small binary heap keyed by [cost, tie, seq].
function makeHeap() {
  const a = [];
  const less = (x, y) => (x[0] !== y[0] ? x[0] < y[0] : x[1] !== y[1] ? x[1] < y[1] : x[2] < y[2]);
  return {
    get size() { return a.length; },
    push(item) {
      a.push(item);
      let i = a.length - 1;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (!less(a[i], a[p])) break;
        [a[i], a[p]] = [a[p], a[i]];
        i = p;
      }
    },
    pop() {
      const top = a[0];
      const last = a.pop();
      if (a.length > 0) {
        a[0] = last;
        let i = 0;
        for (;;) {
          const l = 2 * i + 1, r = l + 1;
          let m = i;
          if (l < a.length && less(a[l], a[m])) m = l;
          if (r < a.length && less(a[r], a[m])) m = r;
          if (m === i) break;
          [a[i], a[m]] = [a[m], a[i]];
          i = m;
        }
      }
      return top;
    }
  };
}

/**
 * Core Dijkstra. Returns `{dist, prev}` maps keyed by state string
 * `"c,r,parity"`, plus the goal state when `to` was reached.
 */
function search(terrain, occupancy, from, to, opts) {
  const {
    budgetFt = Infinity, moverSide = 'party', diagonalRule = '5ft', bounds = null
  } = opts || {};
  const grid = makeGrid(terrain, bounds);
  const occ = normaliseOccupancy(occupancy);
  // Unbounded grid + unbounded budget: keep the search to a sane box.
  let box = null;
  if (!Number.isFinite(grid.cols) && !Number.isFinite(budgetFt)) {
    const pad = 12;
    const minC = Math.min(from.col, to ? to.col : from.col) - pad;
    const maxC = Math.max(from.col, to ? to.col : from.col) + pad;
    const minR = Math.min(from.row, to ? to.row : from.row) - pad;
    const maxR = Math.max(from.row, to ? to.row : from.row) + pad;
    box = { minC, maxC, minR, maxR };
  }
  const passable = (c, r) => {
    if (!grid.inside(c, r)) return false;
    if (box && (c < box.minC || c > box.maxC || r < box.minR || r > box.maxR)) return false;
    if (isBlocked(grid, c, r)) return false;
    const k = `${c},${r}`;
    if (occ.cells.has(k)) {
      const side = occ.sides.get(k);
      if (!side || side !== moverSide) return false;   // hostile (or unknown) creature
    }
    return true;
  };
  const tie = (c, r) => (to ? (c - to.col) ** 2 + (r - to.row) ** 2 : 0);
  const usesParity = diagonalRule === '5-10-5';
  const startKey = `${from.col},${from.row},0`;
  const dist = new Map([[startKey, 0]]);
  const prev = new Map();
  const heap = makeHeap();
  let seq = 0;
  heap.push([0, tie(from.col, from.row), seq++, from.col, from.row, 0]);
  let goal = null;
  while (heap.size > 0) {
    const [cost, , , c, r, parity] = heap.pop();
    const k = `${c},${r},${parity}`;
    if (cost > (dist.get(k) ?? Infinity)) continue;
    if (to && c === to.col && r === to.row) { goal = k; break; }
    for (const [dc, dr] of DIRS) {
      const nc = c + dc, nr = r + dr;
      if (!passable(nc, nr)) continue;
      if (cornerCut(grid, c, r, dc, dr)) continue;
      const step = stepCost(grid, nc, nr, dc, dr, parity, diagonalRule);
      const ncost = cost + step;
      if (ncost > budgetFt) continue;
      const np = usesParity && dc !== 0 && dr !== 0 ? 1 - parity : parity;
      const nk = `${nc},${nr},${np}`;
      if (ncost < (dist.get(nk) ?? Infinity)) {
        dist.set(nk, ncost);
        prev.set(nk, k);
        heap.push([ncost, tie(nc, nr), seq++, nc, nr, np]);
      }
    }
  }
  return { dist, prev, goal, occ, grid };
}

/**
 * Cheapest legal path from `from` to `to`.
 *
 * @param {object|null} terrain — `grid.terrain` (wire or working form); null = all open
 * @param {{cells: Set<string>, sides: Map<string,string>}|Set<string>|null} occupancy
 *   — cells holding creatures (exclude the mover)
 * @param {{col: number, row: number}} from
 * @param {{col: number, row: number}} to
 * @param {{budgetFt?: number, moverSide?: 'party'|'hostile', diagonalRule?: '5ft'|'5-10-5',
 *          bounds?: {cols: number, rows: number}}} [opts]
 *   — `bounds` is only needed when `terrain` is null
 * @returns {{path: {col: number, row: number}[], costFt: number}|null}
 *   `path[0]` is `from`; null when unreachable within the budget, or when
 *   `to` is blocked or occupied.
 */
export function findPath(terrain, occupancy, from, to, opts = {}) {
  if (!from || !to) return null;
  if (from.col === to.col && from.row === to.row) return { path: [{ col: from.col, row: from.row }], costFt: 0 };
  const grid = makeGrid(terrain, opts.bounds);
  if (!grid.inside(to.col, to.row) || isBlocked(grid, to.col, to.row)) return null;
  const occ = normaliseOccupancy(occupancy);
  if (occ.cells.has(cellKey(to))) return null;
  const res = search(terrain, occ, from, to, opts);
  if (!res.goal) return null;
  const path = [];
  let k = res.goal;
  while (k) {
    const [c, r] = k.split(',').map(Number);
    path.push({ col: c, row: r });
    k = res.prev.get(k);
  }
  path.reverse();
  return { path, costFt: res.dist.get(res.goal) };
}

/**
 * Every cell the mover can end its move in, with the cheapest cost.
 * Occupied cells are passable (allies) but never returned as endpoints.
 * Useful for a client-side "where can I go" overlay.
 * @param {object|null} terrain
 * @param {object|Set<string>|null} occupancy
 * @param {{col: number, row: number}} from
 * @param {{budgetFt: number, moverSide?: string, diagonalRule?: string, bounds?: object}} opts
 * @returns {Map<string, number>} `"col,row"` → cost in feet (includes `from` at 0)
 */
export function reachableCells(terrain, occupancy, from, opts = {}) {
  const res = search(terrain, occupancy, from, null, opts);
  const out = new Map();
  for (const [k, cost] of res.dist) {
    const [c, r] = k.split(',');
    const ck = `${c},${r}`;
    if (res.occ.cells.has(ck) && ck !== cellKey(from)) continue;
    if (!out.has(ck) || out.get(ck) > cost) out.set(ck, cost);
  }
  return out;
}

// ---------------------------------------------------------------------------
// validateMove
// ---------------------------------------------------------------------------

function reactionShim(e, weaponOf) {
  const shim = {
    ...e,
    _position: posOf(e),
    _reactionUsed: e._reactionUsed ?? e.resources?.reactionUsed ?? false,
    conditions: conditionIds(e.conditions)
  };
  const w = weaponOf ? weaponOf(e) : null;
  if (w) shim.weapon = w;
  return shim;
}

/**
 * Validate a proposed move and list the opportunity attacks it provokes.
 *
 * @param {object} view — anything with `grid: {cols, rows, terrain?}` (or
 *   top-level `cols/rows/terrain`) and `entities` (object map or array) or
 *   `tokens`: EncounterState, a per-seat projection, or a RenderView.
 * @param {string} moverId
 * @param {{col: number, row: number}[]} path — with or without the start cell
 * @param {{budgetFt?: number, usedFt?: number, ignoreBudget?: boolean,
 *          diagonalRule?: '5ft'|'5-10-5', disengaged?: boolean,
 *          weaponOf?: (entity: object) => object|null}} [opts]
 *   — `budgetFt` defaults to the mover's `speedFt` (30) minus `usedFt`;
 *   `weaponOf` supplies reach weapons for state entities that carry none.
 * @returns {{legal: boolean, costFt: number, reason: string|null, failedAt: number|null,
 *            oaTriggers: {entityId: string, reason: string, stepIndex: number, at: {col: number, row: number}}[]}}
 *   `stepIndex` is 1-based into the full path (start = 0); `at` is the
 *   mover's cell when the attack is made.
 */
export function validateMove(view, moverId, path, opts = {}) {
  const grid = view?.grid || {};
  const terrain = grid.terrain ?? view?.terrain ?? null;
  const bounds = { cols: grid.cols ?? view?.cols, rows: grid.rows ?? view?.rows };
  const g = makeGrid(terrain, bounds);
  const entities = entityList(view?.entities ?? view?.tokens);
  const mover = entities.find(e => String(e.id) === String(moverId));
  const fail = (reason, failedAt = null, costFt = 0, oaTriggers = []) =>
    ({ legal: false, costFt, reason, failedAt, oaTriggers });
  if (!mover || !posOf(mover)) return fail(MOVE_REASONS.UNKNOWN_MOVER);

  const start = posOf(mover);
  const cells = (Array.isArray(path) ? path : []).map(p => ({ col: p.col, row: p.row }));
  const full = cells.length && cells[0].col === start.col && cells[0].row === start.row
    ? cells
    : [{ col: start.col, row: start.row }, ...cells];
  if (full.length === 1) return { legal: true, costFt: 0, reason: null, failedAt: null, oaTriggers: [] };

  const moverSide = sideOf(mover);
  const occ = buildOccupancy(entities, { excludeId: mover.id });
  const diagonalRule = opts.diagonalRule || '5ft';
  const speed = Number.isFinite(mover.speedFt) ? mover.speedFt : 30;
  const budget = opts.ignoreBudget ? Infinity
    : (Number.isFinite(opts.budgetFt) ? opts.budgetFt : speed - (opts.usedFt || 0));

  const hostiles = entities
    .filter(e => e !== mover && sideOf(e) !== moverSide && !isDeadMonster(e) && posOf(e))
    .map(e => reactionShim(e, opts.weaponOf));
  const moverShim = { ...mover, _disengaged: !!(opts.disengaged ?? mover._disengaged ?? mover.turnFlags?.disengaged) };
  const fired = new Set();
  const oaTriggers = [];

  let cost = 0;
  let parity = 0;
  for (let i = 1; i < full.length; i++) {
    const a = full[i - 1];
    const b = full[i];
    const dc = b.col - a.col, dr = b.row - a.row;
    if (Math.max(Math.abs(dc), Math.abs(dr)) !== 1) return fail(MOVE_REASONS.NOT_CONTIGUOUS, i, cost, oaTriggers);
    if (!g.inside(b.col, b.row)) return fail(MOVE_REASONS.OUT_OF_BOUNDS, i, cost, oaTriggers);
    if (isBlocked(g, b.col, b.row)) return fail(MOVE_REASONS.BLOCKED, i, cost, oaTriggers);
    if (cornerCut(g, a.col, a.row, dc, dr)) return fail(MOVE_REASONS.CORNER, i, cost, oaTriggers);
    const k = cellKey(b);
    const last = i === full.length - 1;
    if (occ.cells.has(k)) {
      if (last) return fail(MOVE_REASONS.DESTINATION_OCCUPIED, i, cost, oaTriggers);
      const side = occ.sides.get(k);
      if (!side || side !== moverSide) return fail(MOVE_REASONS.HOSTILE_OCCUPIED, i, cost, oaTriggers);
    }

    // Opportunity attacks for this step; each hostile reacts at most once.
    const live = hostiles.filter(h => !fired.has(String(h.id)));
    for (const t of detectOpportunityAttacks({ mover: moverShim, before: a, after: b, hostiles: live })) {
      fired.add(String(t.triggerer.id));
      oaTriggers.push({ entityId: String(t.triggerer.id), reason: t.reason, stepIndex: i, at: { ...a } });
    }
    const live2 = hostiles.filter(h => !fired.has(String(h.id)));
    for (const t of detectPolearmEntryOAs({ mover: moverShim, before: a, after: b, hostiles: live2 })) {
      fired.add(String(t.triggerer.id));
      oaTriggers.push({ entityId: String(t.triggerer.id), reason: t.reason, stepIndex: i, at: { ...b } });
    }

    cost += stepCost(g, b.col, b.row, dc, dr, parity, diagonalRule);
    if (diagonalRule === '5-10-5' && dc !== 0 && dr !== 0) parity = 1 - parity;
  }
  if (cost > budget) return fail(MOVE_REASONS.OVER_BUDGET, full.length - 1, cost, oaTriggers);
  return { legal: true, costFt: cost, reason: null, failedAt: null, oaTriggers };
}

// ---------------------------------------------------------------------------
// Line of sight
// ---------------------------------------------------------------------------

/**
 * Supercover line between two cell centres. Returns the cells strictly
 * between `a` and `b` as groups: a single cell, or a corner pair when the
 * line passes exactly through a grid corner.
 * @param {{col: number, row: number}} a
 * @param {{col: number, row: number}} b
 * @returns {{col: number, row: number}[][]}
 */
export function supercoverBetween(a, b) {
  const nx = Math.abs(b.col - a.col);
  const ny = Math.abs(b.row - a.row);
  const sx = Math.sign(b.col - a.col);
  const sy = Math.sign(b.row - a.row);
  const out = [];
  let c = a.col, r = a.row;
  let ix = 0, iy = 0;
  while (ix < nx || iy < ny) {
    const decision = (1 + 2 * ix) * ny - (1 + 2 * iy) * nx;
    if (decision === 0) {
      // Through a corner: both side cells are touched only at a point.
      out.push([{ col: c + sx, row: r }, { col: c, row: r + sy }]);
      c += sx; r += sy; ix++; iy++;
    } else if (decision < 0) {
      c += sx; ix++;
    } else {
      r += sy; iy++;
    }
    if (c === b.col && r === b.row) break;
    out.push([{ col: c, row: r }]);
  }
  return out;
}

/**
 * Line of sight between two cells: blocked when a cell strictly between
 * them carries flag 16 (total cover). A line that passes exactly through
 * a grid corner is blocked only if both cells at that corner block.
 * @param {object|null} terrain
 * @param {{col: number, row: number}} a
 * @param {{col: number, row: number}} b
 * @returns {boolean}
 */
export function lineOfSight(terrain, a, b) {
  if (!a || !b) return false;
  const t = asTerrain(terrain);
  if (!t) return true;
  const g = makeGrid(t);
  const blocks = (cell) => (g.flag(cell.col, cell.row) & TERRAIN_FLAGS.TOTAL_COVER) !== 0;
  for (const group of supercoverBetween(a, b)) {
    if (group.every(blocks)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Cover
// ---------------------------------------------------------------------------

/**
 * Highest obstacle degree a corner-to-corner line passes through.
 * Obstacles are closed squares; a line that only grazes an edge or
 * touches a corner of ONE obstacle is clear, but a line running along the
 * seam between two obstacle cells, or squeezing through the single point
 * where two diagonal obstacle cells meet, is blocked (by the weaker one).
 */
function lineDegree(px, py, qx, qy, degAt) {
  const dx = qx - px, dy = qy - py;
  const ts = [0, 1];
  const addCrossings = (p0, d) => {
    if (d === 0) return;
    const lo = Math.min(p0, p0 + d), hi = Math.max(p0, p0 + d);
    for (let k = Math.ceil(lo); k <= Math.floor(hi); k++) {
      const t = (k - p0) / d;
      if (t > 0 && t < 1) ts.push(t);
    }
  };
  addCrossings(px, dx);
  addCrossings(py, dy);
  ts.sort((a, b) => a - b);
  const EPS = 1e-9;
  const isInt = (v) => Math.abs(v - Math.round(v)) < EPS;
  let deg = 0;
  for (let i = 0; i < ts.length; i++) {
    const t = ts[i];
    // Vertex crossings strictly inside the segment.
    if (t > 0 && t < 1) {
      const x = px + dx * t, y = py + dy * t;
      if (isInt(x) && isInt(y) && dx !== 0 && dy !== 0) {
        const X = Math.round(x), Y = Math.round(y);
        const same = Math.sign(dx) === Math.sign(dy);
        const d = same
          ? Math.min(degAt(X, Y - 1), degAt(X - 1, Y))       // passes TL→BR; off cells TR, BL
          : Math.min(degAt(X - 1, Y - 1), degAt(X, Y));      // passes TR→BL; off cells TL, BR
        if (d > deg) deg = d;
      }
    }
    if (i + 1 >= ts.length) break;
    const t2 = ts[i + 1];
    if (t2 - t <= EPS) continue;
    const tm = (t + t2) / 2;
    const mx = px + dx * tm, my = py + dy * tm;
    const ix = isInt(mx), iy = isInt(my);
    let d;
    if (!ix && !iy) d = degAt(Math.floor(mx), Math.floor(my));
    else if (ix && !iy) d = Math.min(degAt(Math.round(mx) - 1, Math.floor(my)), degAt(Math.round(mx), Math.floor(my)));
    else if (!ix && iy) d = Math.min(degAt(Math.floor(mx), Math.round(my) - 1), degAt(Math.floor(mx), Math.round(my)));
    else d = 0;
    if (d > deg) deg = d;
  }
  return deg;
}

function obstacleDegree(flags) {
  if (flags & TERRAIN_FLAGS.TOTAL_COVER) return 3;
  if (flags & TERRAIN_FLAGS.THREE_QUARTERS_COVER) return 2;
  if (flags & TERRAIN_FLAGS.HALF_COVER) return 1;
  return 0;
}

/**
 * Cover the target has against the attacker (DMG p251 grid rule).
 * @param {object|null} terrain
 * @param {object[]|Record<string, object>} entities — creatures other than
 *   attacker and target give half cover (dead monsters ignored)
 * @param {{col: number, row: number}} attackerCell
 * @param {{col: number, row: number}} targetCell
 * @returns {'none'|'half'|'threeQuarters'|'total'}
 */
export function coverBetween(terrain, entities, attackerCell, targetCell) {
  if (!attackerCell || !targetCell) return 'none';
  if (attackerCell.col === targetCell.col && attackerCell.row === targetCell.row) return 'none';
  const t = asTerrain(terrain);
  const g = makeGrid(t);
  const degree = new Map();
  const add = (c, r, d) => { const k = `${c},${r}`; if (d > (degree.get(k) || 0)) degree.set(k, d); };
  if (t) {
    for (let r = 0; r < t.rows; r++) {
      for (let c = 0; c < t.cols; c++) {
        const d = obstacleDegree(g.flag(c, r));
        if (d) add(c, r, d);
      }
    }
  }
  for (const e of entityList(entities)) {
    if (isDeadMonster(e)) continue;
    const p = posOf(e);
    if (p) add(p.col, p.row, 1);
  }
  degree.delete(cellKey(attackerCell));
  degree.delete(cellKey(targetCell));
  const degAt = (c, r) => degree.get(`${c},${r}`) || 0;

  const corners = (cell) => [
    [cell.col, cell.row], [cell.col + 1, cell.row], [cell.col, cell.row + 1], [cell.col + 1, cell.row + 1]
  ];
  let best = 3;
  for (const [ax, ay] of corners(attackerCell)) {
    let blocked = 0, allTotal = true, maxDeg = 0;
    for (const [tx, ty] of corners(targetCell)) {
      const d = degree.size ? lineDegree(ax, ay, tx, ty, degAt) : 0;
      if (d > 0) { blocked++; if (d > maxDeg) maxDeg = d; }
      if (d !== 3) allTotal = false;
    }
    let level;
    if (blocked === 0) level = 0;
    else if (blocked === 4 && allTotal) level = 3;
    else level = Math.min(blocked >= 3 ? 2 : 1, maxDeg);
    if (level < best) best = level;
    if (best === 0) break;
  }
  return COVER_LEVELS[best];
}

// ---------------------------------------------------------------------------
// Weapon range bands
// ---------------------------------------------------------------------------

// PHB weapon table ranges [normal, long] in feet. Longer names first so
// "hand crossbow" wins over "crossbow".
const RANGE_TABLE = [
  ['hand crossbow', 30, 120], ['light crossbow', 80, 320], ['heavy crossbow', 100, 400],
  ['crossbow', 80, 320], ['longbow', 150, 600], ['shortbow', 80, 320],
  ['light hammer', 20, 60], ['handaxe', 20, 60], ['javelin', 30, 120],
  ['trident', 20, 60], ['dagger', 20, 60], ['spear', 20, 60],
  ['sling', 30, 120], ['blowgun', 25, 100], ['dart', 20, 60], ['net', 5, 15],
  ['bow', 80, 320]
];
const DEFAULT_RANGED = [80, 320];

function parseRange(weapon) {
  const r = weapon?.range;
  if (r && typeof r === 'object' && Number.isFinite(r.normal)) {
    return [r.normal, Number.isFinite(r.long) ? r.long : r.normal];
  }
  if (typeof r === 'string') {
    const m = r.match(/(\d+)\s*\/\s*(\d+)/);
    if (m) return [Number(m[1]), Number(m[2])];
    const one = r.match(/(\d+)/);
    if (one) return [Number(one[1]), Number(one[1])];
  }
  const name = String(weapon?.name || '').toLowerCase();
  for (const [key, n, l] of RANGE_TABLE) if (name.includes(key)) return [n, l];
  return DEFAULT_RANGED;
}

/**
 * Range band for an attack at `distFt`.
 *   - Melee weapons: `'normal'` within reach, else `'out'`.
 *   - Ranged (or thrown with `usedAsRanged`): `'normal'` within the normal
 *     range, `'long'` within the long range (attack at disadvantage),
 *     `'out'` beyond it. Ranges come from `weapon.range {normal, long}`,
 *     a `"80/320"` string, the PHB table by name, or 80/320.
 * @param {object|null} weapon
 * @param {number} distFt
 * @returns {'normal'|'long'|'out'}
 */
export function weaponRangeBand(weapon, distFt) {
  const d = Number(distFt);
  if (!Number.isFinite(d)) return 'out';
  const ranged = !!weapon && (weapon.usedAsRanged || isRangedWeapon(weapon));
  if (!ranged) return d <= meleeReachFt(weapon) ? 'normal' : 'out';
  const [normal, long] = parseRange(weapon);
  if (d <= normal) return 'normal';
  if (d <= long) return 'long';
  return 'out';
}
