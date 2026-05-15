import { test, beforeEach } from 'node:test';
import assert from 'node:assert';

// Minimal in-memory localStorage shim — scene-state.js only reads/writes
// inside function bodies, so we can install this before importing.
globalThis.localStorage = (() => {
  let store = new Map();
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
    clear: () => { store.clear(); },
    _reset: () => { store = new Map(); }
  };
})();

const {
  loadScene, saveScene,
  listScenes, setActiveScene, createScene, duplicateScene, renameScene, deleteScene,
  getActiveSceneId, setPosition, addMonsterInstance
} = await import('../js/scene/scene-state.js');

beforeEach(() => {
  globalThis.localStorage._reset();
});

test('M5: first load creates a Default scene and returns it', () => {
  const s = loadScene();
  assert.ok(s);
  assert.strictEqual(s.cols, 10);
  assert.strictEqual(s.rows, 7);
  const scenes = listScenes();
  assert.strictEqual(scenes.length, 1);
  assert.strictEqual(scenes[0].name, 'Default');
  assert.strictEqual(scenes[0].active, true);
});

test('M5: createScene adds a new scene and makes it active', () => {
  loadScene();   // init container
  const id = createScene('Goblin ambush');
  const scenes = listScenes();
  assert.strictEqual(scenes.length, 2);
  assert.strictEqual(getActiveSceneId(), id);
  assert.strictEqual(scenes.find(s => s.id === id).name, 'Goblin ambush');
});

test('M5: saveScene persists into the active slot only', () => {
  loadScene();
  const firstId = getActiveSceneId();
  const s1 = loadScene();
  setPosition(s1, 'char-A', 4, 4);
  saveScene(s1);

  const secondId = createScene('Other');
  const s2 = loadScene();
  // The new scene starts fresh — no positions copied
  assert.deepStrictEqual(s2.positions, {});

  // Switching back to the first scene returns the saved position
  setActiveScene(firstId);
  const reloaded = loadScene();
  assert.deepStrictEqual(reloaded.positions['char-A'], { col: 4, row: 4 });

  // Switching to the second still has no positions
  setActiveScene(secondId);
  assert.deepStrictEqual(loadScene().positions, {});
});

test('M5: duplicateScene deep-copies positions and monsters', () => {
  loadScene();
  const s = loadScene();
  setPosition(s, 'char-B', 2, 3);
  addMonsterInstance(s, { slug: 'goblin', name: 'Goblin', defaultHp: { max: 7 } }, { col: 5, row: 5 });
  saveScene(s);

  const copyId = duplicateScene();
  const copy = loadScene();
  assert.strictEqual(getActiveSceneId(), copyId);
  assert.deepStrictEqual(copy.positions['char-B'], { col: 2, row: 3 });
  assert.strictEqual(copy.monsters.length, 1);

  // Mutating the copy doesn't affect the original
  setPosition(copy, 'char-B', 0, 0);
  saveScene(copy);
  const originalId = listScenes().find(s => s.name === 'Default').id;
  setActiveScene(originalId);
  const original = loadScene();
  assert.deepStrictEqual(original.positions['char-B'], { col: 2, row: 3 });
});

test('M5: renameScene updates the name in listScenes', () => {
  loadScene();
  const id = getActiveSceneId();
  renameScene(id, 'Dragon lair');
  const scenes = listScenes();
  assert.strictEqual(scenes.find(s => s.id === id).name, 'Dragon lair');
});

test('M5: deleteScene removes the scene and picks a fallback active', () => {
  loadScene();
  const firstId = getActiveSceneId();
  const secondId = createScene('Second');
  assert.strictEqual(getActiveSceneId(), secondId);

  // Delete active → first becomes active again
  assert.strictEqual(deleteScene(secondId), true);
  assert.strictEqual(getActiveSceneId(), firstId);
  assert.strictEqual(listScenes().length, 1);
});

test('M5: cannot delete the last remaining scene', () => {
  loadScene();
  const id = getActiveSceneId();
  assert.strictEqual(deleteScene(id), false);
  assert.strictEqual(listScenes().length, 1);
  assert.strictEqual(getActiveSceneId(), id);
});

test('M5: migration — legacy cf_scene blob becomes the Default scene', () => {
  // Seed the legacy single-scene key, then load — the container should
  // be auto-created with the legacy data inside "Default".
  globalThis.localStorage.setItem('cf_scene', JSON.stringify({
    cols: 12, rows: 8, cellSize: 64, scale: 3,
    map: { kind: 'color', color: '#112233' },
    positions: { 'legacy-char': { col: 1, row: 2 } }
  }));
  const s = loadScene();
  assert.strictEqual(s.cols, 12);
  assert.strictEqual(s.rows, 8);
  assert.strictEqual(s.map.color, '#112233');
  assert.deepStrictEqual(s.positions['legacy-char'], { col: 1, row: 2 });
  const scenes = listScenes();
  assert.strictEqual(scenes.length, 1);
  assert.strictEqual(scenes[0].name, 'Default');
});
