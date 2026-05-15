/**
 * M2 — Battle scene state model.
 *
 * A "scene" bundles the battlefield (background + grid) with per-entity
 * positions. Persisted as a single localStorage object so the user can
 * return to the same scene after a reload.
 *
 * Scene shape:
 * {
 *   cols: 10, rows: 7,                      // grid dimensions in cells
 *   cellSize: 64,                           // logical px per cell (pre-scale)
 *   scale: 3,                               // pixels per logical px in render
 *   map: {
 *     kind: 'color',                        // 'color' (M2). 'image' / 'tiles' = M3+
 *     color: '#3d5a3d'                     // tarmac green default
 *   },
 *   grid: {
 *     visible: true,
 *     snap:    true,
 *     color:   'rgba(255,255,255,0.18)'
 *   },
 *   positions: { [characterId]: { col, row } }
 * }
 *
 * `positions` is keyed by D&DB character id. Members without a saved
 * position fall back to a default linear row at render time.
 */

const SCENE_KEY = 'cf_scene';

// M2.5 — Built-in scene presets. Each maps to a preset slug; the UI
// shows them as cards with a swatch / preview. Selecting one swaps
// scene.map + grid color without touching positions/monsters.
export const SCENE_PRESETS = {
  grass:    { name: 'Grass field',  map: { kind: 'color', color: '#3d5a3d' }, grid: { color: 'rgba(255,255,255,0.18)' } },
  dungeon:  { name: 'Dungeon',      map: { kind: 'color', color: '#2a2a2e' }, grid: { color: 'rgba(255,255,255,0.10)' } },
  tavern:   { name: 'Tavern floor', map: { kind: 'color', color: '#6b3f1a' }, grid: { color: 'rgba(255,255,255,0.18)' } },
  forest:   { name: 'Forest',       map: { kind: 'color', color: '#1e3a23' }, grid: { color: 'rgba(255,255,255,0.14)' } },
  desert:   { name: 'Desert',       map: { kind: 'color', color: '#c8a665' }, grid: { color: 'rgba(0,0,0,0.20)' } },
  snow:     { name: 'Snowfield',    map: { kind: 'color', color: '#dfe7ea' }, grid: { color: 'rgba(0,0,0,0.15)' } },
  swamp:    { name: 'Swamp',        map: { kind: 'color', color: '#3b4a2e' }, grid: { color: 'rgba(255,255,255,0.12)' } },
  cave:     { name: 'Cave',         map: { kind: 'color', color: '#1a1820' }, grid: { color: 'rgba(255,255,255,0.10)' } }
};

export const DEFAULT_SCENE = Object.freeze({
  cols: 10,
  rows: 7,
  cellSize: 64,
  scale: 3,
  map: { kind: 'color', color: '#3d5a3d' },
  grid: { visible: true, snap: true, color: 'rgba(255,255,255,0.18)' },
  positions: {},
  // M3 — Monster instances on this scene. Each entry: { id, presetSlug,
  // name, position:{col,row}, hp:{current,max,temp} }. Positions live on
  // the entity itself rather than scene.positions because monsters can
  // share a slug (e.g. multiple goblins) and the keyed-by-id map would
  // collide.
  monsters: [],
  // M4 — Initiative order. [{ entityId, entityKind, name, score, active }]
  // Empty until "Roll initiative" populates it; persisted with the scene.
  initiative: []
});

export function loadScene() {
  try {
    const raw = localStorage.getItem(SCENE_KEY);
    if (!raw) return cloneDefault();
    const parsed = JSON.parse(raw);
    // Defensive merge — old saves missing newer fields fall back to defaults
    return mergeWithDefault(parsed);
  } catch {
    return cloneDefault();
  }
}

export function saveScene(scene) {
  try {
    localStorage.setItem(SCENE_KEY, JSON.stringify(scene));
  } catch { /* quota or private-mode — ignore */ }
}

function cloneDefault() {
  return JSON.parse(JSON.stringify(DEFAULT_SCENE));
}

function mergeWithDefault(saved) {
  const base = cloneDefault();
  return {
    ...base,
    ...saved,
    map:  { ...base.map,  ...(saved.map  || {}) },
    grid: { ...base.grid, ...(saved.grid || {}) },
    positions: saved.positions && typeof saved.positions === 'object' ? saved.positions : {},
    monsters: Array.isArray(saved.monsters) ? saved.monsters : [],
    initiative: Array.isArray(saved.initiative) ? saved.initiative : []
  };
}

/**
 * Default placement for members without a saved (col, row). Drops them
 * in a horizontal row centred vertically, starting at col 1 to leave the
 * left edge for the DM's view.
 *
 *   member index 0 → (1, midRow)
 *   member index 1 → (2, midRow)
 *   ...
 *
 * Wraps to a second row if the party exceeds available width.
 */
export function defaultPosition(scene, indexInParty) {
  const midRow = Math.floor(scene.rows / 2);
  const cap = Math.max(1, scene.cols - 2);
  const col = 1 + (indexInParty % cap);
  const row = midRow + Math.floor(indexInParty / cap);
  return { col, row };
}

/** Get a character's resolved position (saved or defaulted). */
export function positionOf(scene, characterId, indexInParty) {
  const saved = scene.positions?.[String(characterId)];
  if (saved && Number.isFinite(saved.col) && Number.isFinite(saved.row)) {
    return clampPosition(scene, saved);
  }
  return clampPosition(scene, defaultPosition(scene, indexInParty));
}

export function clampPosition(scene, { col, row }) {
  return {
    col: Math.max(0, Math.min(scene.cols - 1, col)),
    row: Math.max(0, Math.min(scene.rows - 1, row))
  };
}

/**
 * Convert mouse/touch event coords (already adjusted for canvas client
 * rect) into (col, row). Optionally snaps to the nearest cell, else
 * returns a fractional position for fluid drag.
 */
export function pointToCell(scene, px, py, { snap = true } = {}) {
  const cellPx = scene.cellSize * scene.scale;
  const col = px / cellPx;
  const row = py / cellPx;
  if (snap) return clampPosition(scene, { col: Math.floor(col), row: Math.floor(row) });
  return clampPosition(scene, { col: Math.floor(col), row: Math.floor(row) });
}

/**
 * Find which character (by D&DB id) is under the given canvas-relative
 * pixel coordinate. Returns null if no character occupies that cell.
 */
export function characterAt(scene, characters, px, py) {
  const cellPx = scene.cellSize * scene.scale;
  for (let i = 0; i < characters.length; i++) {
    const ch = characters[i];
    const pos = positionOf(scene, ch.id, i);
    const x = pos.col * cellPx;
    const y = pos.row * cellPx;
    if (px >= x && px < x + cellPx && py >= y && py < y + cellPx) return ch;
  }
  return null;
}

export function setPosition(scene, characterId, col, row) {
  scene.positions = { ...(scene.positions || {}), [String(characterId)]: { col, row } };
}

export function clearPositions(scene) {
  scene.positions = {};
}

// ---- M3: Monster instance management ----

let monsterIdSeq = 1;
function nextMonsterId() {
  return `m_${Date.now().toString(36)}_${(monsterIdSeq++).toString(36)}`;
}

/**
 * Add a monster instance to the scene. `preset` is the MONSTER_PRESETS
 * entry; position defaults to an empty cell near the top-left if not
 * given. Returns the created instance (caller saves scene).
 */
export function addMonsterInstance(scene, preset, position = null) {
  const existingCount = (scene.monsters || []).filter(m => m.presetSlug === preset.slug).length;
  const labelSuffix = existingCount === 0 ? '' : ` ${existingCount + 1}`;
  const instance = {
    id: nextMonsterId(),
    presetSlug: preset.slug,
    name: preset.name + labelSuffix,
    position: position || findFreeCell(scene),
    hp: {
      current: preset.defaultHp?.max || 1,
      max:     preset.defaultHp?.max || 1,
      temp: 0
    }
  };
  scene.monsters = [...(scene.monsters || []), instance];
  return instance;
}

export function removeMonsterInstance(scene, monsterId) {
  scene.monsters = (scene.monsters || []).filter(m => m.id !== monsterId);
}

export function updateMonsterPosition(scene, monsterId, col, row) {
  const clamped = clampPosition(scene, { col, row });
  scene.monsters = (scene.monsters || []).map(m =>
    m.id === monsterId ? { ...m, position: clamped } : m
  );
}

/**
 * Find an empty cell. Tries the top edge first (where monsters typically
 * start in tactical setups), then row-major scan. Returns (0,0) if the
 * whole grid is occupied — overlap is acceptable as a fallback.
 */
function findFreeCell(scene) {
  const occupied = new Set();
  for (const p of Object.values(scene.positions || {})) {
    occupied.add(`${p.col},${p.row}`);
  }
  for (const m of scene.monsters || []) {
    occupied.add(`${m.position.col},${m.position.row}`);
  }
  // Prefer the top row (away from default PC placements at midRow)
  for (let c = 1; c < scene.cols - 1; c++) {
    if (!occupied.has(`${c},0`)) return { col: c, row: 0 };
  }
  // Otherwise row-major
  for (let r = 0; r < scene.rows; r++) {
    for (let c = 0; c < scene.cols; c++) {
      if (!occupied.has(`${c},${r}`)) return { col: c, row: r };
    }
  }
  return { col: 0, row: 0 };
}

/**
 * Extended hit-test that finds either a PC (via positions map) OR a
 * monster instance under the click. Returns:
 *   { kind: 'pc' | 'monster', entity }   or null
 */
export function entityAt(scene, characters, px, py) {
  const cellPx = scene.cellSize * scene.scale;
  const cellCol = Math.floor(px / cellPx);
  const cellRow = Math.floor(py / cellPx);
  for (let i = 0; i < characters.length; i++) {
    const ch = characters[i];
    const pos = positionOf(scene, ch.id, i);
    if (pos.col === cellCol && pos.row === cellRow) {
      return { kind: 'pc', entity: ch };
    }
  }
  for (const m of (scene.monsters || [])) {
    if (m.position.col === cellCol && m.position.row === cellRow) {
      return { kind: 'monster', entity: m };
    }
  }
  return null;
}
