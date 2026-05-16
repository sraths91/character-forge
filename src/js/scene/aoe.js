/**
 * M8 — Area-of-effect templates.
 *
 * Pure cell-coverage math for the four 5e shapes:
 *   - sphere (circle / radius)
 *   - cube
 *   - line (cardinal, 1 cell wide)
 *   - cone (cardinal, 90° apex at origin)
 *
 * On a 5e square grid, 1 cell = 5ft. All sizes here are in CELLS for
 * geometry; the UI translates feet → cells (size_ft / 5).
 *
 * Returned coverage is an array of { col, row } cells the template
 * occupies. The compositor draws an overlay over those cells; the
 * Actions panel collects entities whose position intersects.
 *
 * No DOM, no globals. Inputs are plain values. Coverage rules follow
 * 5e RAW for grid-based play: a cell is "in" the template when any
 * part of the template touches that cell. We approximate by including
 * any cell whose center is within the geometric region.
 */

/**
 * Generate the set of cells a template covers, clamped to the scene grid.
 *
 *   shape      — 'sphere' | 'cube' | 'line' | 'cone'
 *   originCol  — anchor column (typically the caster's cell, or a target
 *                center for sphere)
 *   originRow  — anchor row
 *   sizeCells  — radius for sphere; side length for cube; length for line
 *                and cone (cells)
 *   direction  — 'north' | 'south' | 'east' | 'west' — required for
 *                line / cone, ignored for sphere / cube
 *   cols/rows  — grid bounds for clamping (optional; default 0..Infinity)
 */
export function templateCells({ shape, originCol, originRow, sizeCells, direction, cols = Infinity, rows = Infinity }) {
  if (!Number.isFinite(originCol) || !Number.isFinite(originRow)) return [];
  if (!Number.isFinite(sizeCells) || sizeCells <= 0) return [];

  switch (shape) {
    case 'sphere':  return sphereCells({ originCol, originRow, sizeCells, cols, rows });
    case 'cube':    return cubeCells({ originCol, originRow, sizeCells, cols, rows });
    case 'line':    return lineCells({ originCol, originRow, sizeCells, direction, cols, rows });
    case 'cone':    return coneCells({ originCol, originRow, sizeCells, direction, cols, rows });
    default:        return [];
  }
}

// ---------- Sphere ----------
// Cells whose center is within `sizeCells` of the origin center, using
// Chebyshev distance (matches 5e square-grid "burst" rendering).
function sphereCells({ originCol, originRow, sizeCells, cols, rows }) {
  const out = [];
  for (let dc = -sizeCells; dc <= sizeCells; dc++) {
    for (let dr = -sizeCells; dr <= sizeCells; dr++) {
      // True circle (Euclidean) feels more natural visually than a square.
      // We use radius = sizeCells + 0.5 so cells whose center lies just
      // inside the boundary are included.
      const dist = Math.sqrt(dc * dc + dr * dr);
      if (dist > sizeCells + 0.0001) continue;
      const c = originCol + dc;
      const r = originRow + dr;
      if (c < 0 || r < 0 || c >= cols || r >= rows) continue;
      out.push({ col: c, row: r });
    }
  }
  return out;
}

// ---------- Cube ----------
// Square region anchored at origin, expanding into the four quadrants.
// 5e cubes are usually specified as side length: a 15ft cube = 3 cells
// per side. We anchor it so origin is the cube's nearest corner and the
// cube extends N+E from there (matches "spawn a cube at this cell").
function cubeCells({ originCol, originRow, sizeCells, cols, rows }) {
  const out = [];
  const side = Math.ceil(sizeCells);
  // Default anchor: origin is the NW corner — cube extends east + south.
  // A future v2 can let the user pick which quadrant.
  for (let dc = 0; dc < side; dc++) {
    for (let dr = 0; dr < side; dr++) {
      const c = originCol + dc;
      const r = originRow + dr;
      if (c < 0 || r < 0 || c >= cols || r >= rows) continue;
      out.push({ col: c, row: r });
    }
  }
  return out;
}

// ---------- Line ----------
// Straight line of N cells from origin in a cardinal direction.
// Width is 1 cell for v1 (5ft wide lines are the most common in 5e).
function lineCells({ originCol, originRow, sizeCells, direction, cols, rows }) {
  const out = [];
  const length = Math.ceil(sizeCells);
  const step = STEP_BY_DIRECTION[direction];
  if (!step) return [];
  for (let i = 0; i < length; i++) {
    const c = originCol + step.dc * i;
    const r = originRow + step.dr * i;
    if (c < 0 || r < 0 || c >= cols || r >= rows) continue;
    out.push({ col: c, row: r });
  }
  return out;
}

// ---------- Cone ----------
// 5e cones have a width at distance D equal to D. A cone of length L
// covers cells in a triangle expanding from origin in the cardinal
// direction. At step i (1..L) the cone is i cells wide perpendicular
// to direction. The origin cell itself is NOT included (5e RAW: the
// cone originates from the edge of the caster's space).
function coneCells({ originCol, originRow, sizeCells, direction, cols, rows }) {
  const out = [];
  const length = Math.ceil(sizeCells);
  const step = STEP_BY_DIRECTION[direction];
  if (!step) return [];
  // Perpendicular axis for width
  const perp = step.dc === 0 ? { dc: 1, dr: 0 } : { dc: 0, dr: 1 };

  for (let i = 1; i <= length; i++) {
    // Width = i cells centred on the axis
    const halfWidth = Math.floor((i - 1) / 2);
    const extra = (i - 1) % 2;   // 1 cell asymmetry on even steps
    for (let w = -halfWidth; w <= halfWidth + extra; w++) {
      const c = originCol + step.dc * i + perp.dc * w;
      const r = originRow + step.dr * i + perp.dr * w;
      if (c < 0 || r < 0 || c >= cols || r >= rows) continue;
      out.push({ col: c, row: r });
    }
  }
  return out;
}

const STEP_BY_DIRECTION = {
  north: { dc: 0,  dr: -1 },
  south: { dc: 0,  dr: 1  },
  east:  { dc: 1,  dr: 0  },
  west:  { dc: -1, dr: 0  }
};

/**
 * Pull the list of PCs + monsters whose position intersects the template
 * cell set. Returns [{ entity, kind, position }].
 *
 *   cells     — array from templateCells()
 *   party     — array of PC characters (with id + _position)
 *   monsters  — array of monster instances (with id + position)
 *   scene     — scene record (for PC position fallback)
 */
export function entitiesInTemplate(cells, { party = [], monsters = [], scene = null } = {}) {
  if (!Array.isArray(cells) || cells.length === 0) return [];
  const cellSet = new Set(cells.map(c => `${c.col},${c.row}`));
  const out = [];
  party.forEach((pc) => {
    const pos = pc._position
      || scene?.positions?.[String(pc.id)]
      || null;
    if (!pos) return;
    if (cellSet.has(`${pos.col},${pos.row}`)) {
      out.push({ entity: pc, kind: 'pc', position: pos });
    }
  });
  for (const m of monsters) {
    const pos = m._position || m.position;
    if (!pos) continue;
    if (cellSet.has(`${pos.col},${pos.row}`)) {
      out.push({ entity: m, kind: 'monster', position: pos });
    }
  }
  return out;
}
