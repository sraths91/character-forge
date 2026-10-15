/**
 * M26 — Scene snapshot encoding for async share links.
 *
 * Strips a scene record down to the visual-state fields a recipient
 * needs to reproduce the view: grid dimensions, map style (colour,
 * generated biome+seed, or a hosted image reference with calibration),
 * terrain flags, positions, monsters (with HP / conditions), initiative,
 * flanking toggle.
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
  // Map: data-URL images never travel (100 KB+ in a URL). A colour map,
  // a generated map (biome + seed, regenerated identically) and a
  // server-hosted image REFERENCE (imageId / url + calibration) do.
  const snapMap = snapshotMap(scene.map);
  if (snapMap) snap.map = snapMap;
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
  if (scene.terrain && typeof scene.terrain.flags === 'string') {
    snap.terrain = { v: scene.terrain.v || 1, cols: scene.terrain.cols, rows: scene.terrain.rows, flags: scene.terrain.flags };
  }
  return snap;
}

const DEFAULT_COLOR = '#3d5a3d';

/** True for a URL a share link may carry: not an inline data/blob URL. */
function isShareableUrl(url) {
  return typeof url === 'string' && url.length > 0 && url.length <= 2048 && !/^(data|blob):/i.test(url);
}

/** Copy only the image-reference fields that exist. */
function imageRef(map) {
  const out = { kind: 'image', color: map.color || DEFAULT_COLOR };
  if (map.imageId) out.imageId = String(map.imageId);
  if (isShareableUrl(map.url)) out.url = map.url;
  if (Number.isFinite(map.imgW)) out.imgW = map.imgW;
  if (Number.isFinite(map.imgH)) out.imgH = map.imgH;
  if (map.calib && Number(map.calib.cellPx) > 0) {
    out.calib = {
      cellPx: Number(map.calib.cellPx),
      offsetX: Number(map.calib.offsetX) || 0,
      offsetY: Number(map.calib.offsetY) || 0
    };
  }
  if (map.cinemaBiome) out.cinemaBiome = String(map.cinemaBiome);
  return out;
}

function snapshotMap(map) {
  if (!map) return null;
  if (map.kind === 'color') return { kind: 'color', color: map.color };
  if (map.kind === 'generated') {
    // Generated maps are just (biome, seed) — tiny, so they travel in
    // the URL intact and the recipient regenerates identical terrain.
    return {
      kind: 'generated',
      biome: map.biome,
      seed: map.seed >>> 0,
      color: map.color || DEFAULT_COLOR,
      preset: map.preset
    };
  }
  if (map.kind === 'image') {
    if (map.imageId || isShareableUrl(map.url)) return imageRef(map);
    return { kind: 'color', color: map.color || DEFAULT_COLOR };
  }
  return null;
}

function restoreMap(map) {
  if (map?.kind === 'generated' && map.biome) {
    const out = { kind: 'generated', biome: map.biome, seed: map.seed >>> 0, color: map.color || DEFAULT_COLOR };
    if (map.preset) out.preset = map.preset;
    return out;
  }
  if (map?.kind === 'image' && (map.imageId || isShareableUrl(map.url))) return imageRef(map);
  if (map?.kind === 'color') return { kind: 'color', color: map.color || DEFAULT_COLOR };
  return { kind: 'color', color: DEFAULT_COLOR };
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
    map: restoreMap(snap.map),
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
    flankingEnabled: !!snap.flankingEnabled,
    ...(snap.terrain && typeof snap.terrain.flags === 'string'
      ? { terrain: { v: snap.terrain.v || 1, cols: snap.terrain.cols, rows: snap.terrain.rows, flags: snap.terrain.flags } }
      : {})
  };
}
