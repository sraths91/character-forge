/**
 * M26 — Scene snapshot encoding for async share links.
 *
 * Strips a scene record down to the visual-state fields a recipient
 * needs to reproduce the view: grid dimensions, map style, positions,
 * monsters (with HP / conditions), initiative, flanking toggle.
 *
 * Local-only fields (the multi-scene container, the legacy single-scene
 * blob, scene presets) are NOT serialized — they're recipient state.
 *
 * Pure module, no DOM. Round-trippable via encodeSnapshot/decodeSnapshot.
 */

/**
 * Build a minimal scene snapshot from the current scene record. Drops
 * any field that doesn't affect rendering / visible state.
 */
export function buildSceneSnapshot(scene) {
  if (!scene) return null;
  const snap = {
    cols: scene.cols,
    rows: scene.rows,
    cellSize: scene.cellSize,
    scale: scene.scale
  };
  // Map: only color is allowed in the URL — image data URLs blow past
  // reasonable URL lengths (think 100KB+). The recipient gets a flat
  // colored background even if the sender uploaded an image.
  if (scene.map?.kind === 'color') {
    snap.map = { kind: 'color', color: scene.map.color };
  } else if (scene.map?.kind === 'image') {
    snap.map = { kind: 'color', color: scene.map.color || '#3d5a3d' };
  }
  if (scene.grid) {
    snap.grid = {
      visible: !!scene.grid.visible,
      color: scene.grid.color
    };
  }
  if (scene.positions && typeof scene.positions === 'object') {
    snap.positions = { ...scene.positions };
  }
  if (Array.isArray(scene.monsters) && scene.monsters.length) {
    snap.monsters = scene.monsters.map(m => ({
      id: m.id,
      presetSlug: m.presetSlug,
      name: m.name,
      position: m.position,
      hp: m.hp,
      conditions: Array.isArray(m.conditions) ? m.conditions : []
    }));
  }
  if (Array.isArray(scene.initiative) && scene.initiative.length) {
    snap.initiative = scene.initiative.map(i => ({ ...i }));
  }
  if (scene.flankingEnabled) snap.flankingEnabled = true;
  return snap;
}

/**
 * Restore a full scene record from a snapshot. Fills defaults for any
 * field the snapshot omitted, so the result is safely usable by the
 * compositor and resolver without further sanitization.
 */
export function restoreSceneFromSnapshot(snap) {
  if (!snap) return null;
  return {
    cols: Number.isFinite(snap.cols) ? snap.cols : 10,
    rows: Number.isFinite(snap.rows) ? snap.rows : 7,
    cellSize: Number.isFinite(snap.cellSize) ? snap.cellSize : 64,
    scale: Number.isFinite(snap.scale) ? snap.scale : 3,
    map: snap.map?.kind === 'color'
      ? { kind: 'color', color: snap.map.color || '#3d5a3d' }
      : { kind: 'color', color: '#3d5a3d' },
    grid: {
      visible: snap.grid?.visible !== false,
      snap: true,
      color: snap.grid?.color || 'rgba(255,255,255,0.18)'
    },
    positions: snap.positions && typeof snap.positions === 'object' ? { ...snap.positions } : {},
    monsters: Array.isArray(snap.monsters)
      ? snap.monsters.map(m => ({
          id: m.id,
          presetSlug: m.presetSlug,
          name: m.name || 'Monster',
          position: m.position || { col: 0, row: 0 },
          hp: m.hp || { current: 1, max: 1, temp: 0 },
          conditions: Array.isArray(m.conditions) ? m.conditions : []
        }))
      : [],
    initiative: Array.isArray(snap.initiative) ? snap.initiative.map(i => ({ ...i })) : [],
    flankingEnabled: !!snap.flankingEnabled
  };
}
