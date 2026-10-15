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
 *
 * M64 T5 — this file is now only the localStorage adapter. The pure
 * model (presets, position math, monster/condition setters) lives in
 * scene-model.js and is re-exported here for existing callers.
 */

import { cloneDefault, mergeWithDefault } from './scene-model.js';

export * from './scene-model.js';

const SCENE_KEY  = 'cf_scene';    // legacy single-scene blob (kept for migration)
const SCENES_KEY = 'cf_scenes';   // M5 — { activeId, scenes: { [id]: { id, name, updatedAt, scene } } }

// ---- M5: Multi-scene container ----
//
// Storage shape under SCENES_KEY:
//   { activeId, scenes: { [id]: { id, name, updatedAt, scene } } }
//
// `scene` is the same shape as DEFAULT_SCENE. The legacy single-scene
// blob at SCENE_KEY is auto-migrated into `Default` on first load and
// then left in place (read-only fallback) so a downgrade still works.

function newSceneId() {
  return `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

function loadScenesContainer() {
  try {
    const raw = localStorage.getItem(SCENES_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed?.scenes && parsed.activeId && parsed.scenes[parsed.activeId]) {
        // Defensive: each saved scene gets the same merge treatment so older
        // saves missing newer fields fall back to defaults.
        const scenes = {};
        for (const [id, entry] of Object.entries(parsed.scenes)) {
          scenes[id] = {
            id,
            name: entry.name || 'Untitled',
            updatedAt: entry.updatedAt || Date.now(),
            scene: mergeWithDefault(entry.scene || {})
          };
        }
        return { activeId: parsed.activeId, scenes };
      }
    }
  } catch { /* fall through to migration */ }

  // Migration: lift the legacy single-scene blob into a "Default" entry.
  // Persist immediately — otherwise repeated calls would each generate a
  // fresh id and silently lose state between calls.
  const legacy = (() => {
    try {
      const raw = localStorage.getItem(SCENE_KEY);
      return raw ? mergeWithDefault(JSON.parse(raw)) : cloneDefault();
    } catch { return cloneDefault(); }
  })();
  const id = newSceneId();
  const container = {
    activeId: id,
    scenes: { [id]: { id, name: 'Default', updatedAt: Date.now(), scene: legacy } }
  };
  saveScenesContainer(container);
  return container;
}

function saveScenesContainer(container) {
  try {
    localStorage.setItem(SCENES_KEY, JSON.stringify(container));
  } catch { /* quota or private-mode — ignore */ }
}

export function loadScene() {
  const c = loadScenesContainer();
  return c.scenes[c.activeId].scene;
}

export function saveScene(scene) {
  const c = loadScenesContainer();
  const entry = c.scenes[c.activeId];
  if (!entry) return;
  entry.scene = scene;
  entry.updatedAt = Date.now();
  saveScenesContainer(c);
}

// ---- M5: Scene CRUD ----

/** List all scenes as [{ id, name, updatedAt, active }] sorted by updatedAt desc. */
export function listScenes() {
  const c = loadScenesContainer();
  return Object.values(c.scenes)
    .map(e => ({ id: e.id, name: e.name, updatedAt: e.updatedAt, active: e.id === c.activeId }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export function getActiveSceneId() {
  return loadScenesContainer().activeId;
}

/** Switch which scene is active. Returns the loaded scene or null on bad id. */
export function setActiveScene(id) {
  const c = loadScenesContainer();
  if (!c.scenes[id]) return null;
  c.activeId = id;
  saveScenesContainer(c);
  return c.scenes[id].scene;
}

/** Create a fresh scene (DEFAULT_SCENE shape) and make it active. */
export function createScene(name = 'New scene') {
  const c = loadScenesContainer();
  const id = newSceneId();
  c.scenes[id] = { id, name, updatedAt: Date.now(), scene: cloneDefault() };
  c.activeId = id;
  saveScenesContainer(c);
  return id;
}

/** Duplicate a scene (defaults to the active one). New scene becomes active. */
export function duplicateScene(sourceId = null) {
  const c = loadScenesContainer();
  const src = c.scenes[sourceId || c.activeId];
  if (!src) return null;
  const id = newSceneId();
  c.scenes[id] = {
    id,
    name: `${src.name} (copy)`,
    updatedAt: Date.now(),
    scene: JSON.parse(JSON.stringify(src.scene))
  };
  c.activeId = id;
  saveScenesContainer(c);
  return id;
}

export function renameScene(id, name) {
  const c = loadScenesContainer();
  const entry = c.scenes[id];
  if (!entry) return false;
  entry.name = String(name || '').trim() || entry.name;
  entry.updatedAt = Date.now();
  saveScenesContainer(c);
  return true;
}

/** Delete a scene. If the active scene is deleted, the most-recently-updated
 *  remaining scene becomes active. The last scene cannot be deleted (we
 *  always keep at least one). Returns true on success. */
export function deleteScene(id) {
  const c = loadScenesContainer();
  if (!c.scenes[id]) return false;
  if (Object.keys(c.scenes).length <= 1) return false;
  delete c.scenes[id];
  if (c.activeId === id) {
    const remaining = Object.values(c.scenes).sort((a, b) => b.updatedAt - a.updatedAt);
    c.activeId = remaining[0].id;
  }
  saveScenesContainer(c);
  return true;
}

