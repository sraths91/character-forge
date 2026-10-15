/**
 * M64 T5 — the pure scene model runs with no localStorage at all.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import {
  DEFAULT_SCENE, cloneDefault, mergeWithDefault, positionOf, defaultPosition,
  clampPosition, pointToCell, entityAt, addMonsterInstance, removeMonsterInstance,
  setMonsterCondition, updateMonsterPosition, setPosition
} from '../js/scene/scene-model.js';
import * as sceneState from '../js/scene/scene-state.js';

test('scene-model: position math and defaults (no storage involved)', () => {
  const scene = cloneDefault();
  assert.notEqual(scene, DEFAULT_SCENE);
  assert.deepEqual(scene.positions, {});
  setPosition(scene, 'p1', 3, 2);
  assert.deepEqual(positionOf(scene, 'p1', 0), { col: 3, row: 2 });
  assert.deepEqual(positionOf(scene, 'p2', 1), defaultPosition(scene, 1));
  assert.deepEqual(clampPosition(scene, { col: 99, row: -4 }), { col: 9, row: 0 });
  assert.deepEqual(pointToCell(scene, 192 * 2 + 5, 10), { col: 2, row: 0 });
});

test('scene-model: mergeWithDefault backfills monster conditions and flags', () => {
  const s = mergeWithDefault({ cols: 5, monsters: [{ id: 'm', position: { col: 0, row: 0 } }] });
  assert.equal(s.cols, 5);
  assert.deepEqual(s.monsters[0].conditions, []);
  assert.equal(s.flankingEnabled, false);
});

test('scene-model: addMonsterInstance takes an injected id minter (server ids)', () => {
  const scene = cloneDefault();
  let n = 0;
  const m = addMonsterInstance(scene, { slug: 'goblin', name: 'Goblin', defaultHp: { max: 7 } }, null, () => `m${++n}`);
  assert.equal(m.id, 'm1');
  assert.deepEqual(m.hp, { current: 7, max: 7, temp: 0 });
  setMonsterCondition(scene, 'm1', 'prone', true);
  assert.deepEqual(scene.monsters[0].conditions, ['prone']);
  updateMonsterPosition(scene, 'm1', 4, 4);
  assert.deepEqual(entityAt(scene, [], 4 * 192 + 1, 4 * 192 + 1)?.entity.id, 'm1');
  removeMonsterInstance(scene, 'm1');
  assert.equal(scene.monsters.length, 0);
});

test('scene-state re-exports the whole pure model', () => {
  for (const k of ['positionOf', 'addMonsterInstance', 'SCENE_PRESETS', 'DEFAULT_SCENE', 'entityAt', 'mergeWithDefault']) {
    assert.ok(k in sceneState, `${k} re-exported`);
  }
  assert.equal(sceneState.positionOf, positionOf);
});
