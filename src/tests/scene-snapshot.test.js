import { test } from 'node:test';
import assert from 'node:assert';
import { buildSceneSnapshot, restoreSceneFromSnapshot } from '../js/scene/scene-snapshot.js';

function fullScene() {
  return {
    cols: 10, rows: 7, cellSize: 64, scale: 3,
    map: { kind: 'color', color: '#3d5a3d' },
    grid: { visible: true, snap: true, color: 'rgba(255,255,255,0.18)' },
    positions: { '148566289': { col: 4, row: 5 } },
    monsters: [{
      id: 'm1', presetSlug: 'goblin', name: 'Goblin',
      position: { col: 6, row: 5 },
      hp: { current: 4, max: 7, temp: 0 },
      conditions: ['poisoned']
    }],
    initiative: [
      { entityId: '148566289', entityKind: 'pc', name: 'Saris', score: 18, active: true }
    ],
    flankingEnabled: true,
    // Local-only fields that must NOT be serialized:
    activeId: 's_abc', id: 'should-be-stripped'
  };
}

test('M26: buildSceneSnapshot preserves the visual fields', () => {
  const snap = buildSceneSnapshot(fullScene());
  assert.strictEqual(snap.cols, 10);
  assert.strictEqual(snap.rows, 7);
  assert.deepStrictEqual(snap.map, { kind: 'color', color: '#3d5a3d' });
  assert.deepStrictEqual(snap.positions['148566289'], { col: 4, row: 5 });
  assert.strictEqual(snap.monsters.length, 1);
  assert.deepStrictEqual(snap.monsters[0].conditions, ['poisoned']);
  assert.strictEqual(snap.flankingEnabled, true);
  assert.strictEqual(snap.initiative[0].name, 'Saris');
});

test('M26: buildSceneSnapshot strips local-only fields', () => {
  const snap = buildSceneSnapshot(fullScene());
  assert.strictEqual(snap.activeId, undefined);
  assert.strictEqual(snap.id, undefined);
});

test('M26: buildSceneSnapshot — image map collapses to color (URL size guard)', () => {
  const scene = fullScene();
  scene.map = { kind: 'image', color: '#112233', image: 'data:image/png;base64,...' };
  const snap = buildSceneSnapshot(scene);
  assert.strictEqual(snap.map.kind, 'color');
  assert.strictEqual(snap.map.color, '#112233');
});

test('M26: buildSceneSnapshot — drops empty arrays so the URL stays short', () => {
  const scene = fullScene();
  scene.monsters = [];
  scene.initiative = [];
  const snap = buildSceneSnapshot(scene);
  assert.strictEqual(snap.monsters, undefined);
  assert.strictEqual(snap.initiative, undefined);
});

test('M26: round-trip — buildSceneSnapshot → restoreSceneFromSnapshot preserves all fields', () => {
  const orig = fullScene();
  const restored = restoreSceneFromSnapshot(buildSceneSnapshot(orig));
  assert.strictEqual(restored.cols, orig.cols);
  assert.strictEqual(restored.rows, orig.rows);
  assert.strictEqual(restored.map.color, orig.map.color);
  assert.deepStrictEqual(restored.positions, orig.positions);
  assert.strictEqual(restored.monsters.length, 1);
  assert.strictEqual(restored.monsters[0].name, 'Goblin');
  assert.deepStrictEqual(restored.monsters[0].conditions, ['poisoned']);
  assert.strictEqual(restored.flankingEnabled, true);
  assert.strictEqual(restored.initiative[0].score, 18);
});

test('M26: restoreSceneFromSnapshot fills sensible defaults for missing fields', () => {
  const restored = restoreSceneFromSnapshot({ cols: 12, rows: 9 });
  assert.strictEqual(restored.cellSize, 64);
  assert.strictEqual(restored.scale, 3);
  assert.strictEqual(restored.map.kind, 'color');
  assert.deepStrictEqual(restored.positions, {});
  assert.deepStrictEqual(restored.monsters, []);
  assert.strictEqual(restored.flankingEnabled, false);
});

test('M26: restoreSceneFromSnapshot — null input returns null', () => {
  assert.strictEqual(restoreSceneFromSnapshot(null), null);
});

test('M26: buildSceneSnapshot — null scene returns null', () => {
  assert.strictEqual(buildSceneSnapshot(null), null);
});
