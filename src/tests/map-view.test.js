// M64 E5 / M5 — RenderView projection, appearance keys, the legacy
// adapter, the rAF scheduler, and the read-only renderer contract
// (deep-frozen view renders; no scene-state mutators reachable).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  RENDER_VIEW_VERSION, projectBattleView, createAppearanceCache, appearanceKeyOf, monsterAppearanceKey,
  hpStateOf, worstConditionOf, conditionIdsOf, legacySceneToView, characterForToken, tokenStatusKey, viewMapOf
} from '../js/map/view.js';
import { createRenderScheduler } from '../js/map/scheduler.js';
import { createCamera } from '../js/map/camera.js';
import { renderBattleScene } from '../js/sprite/compositor.js';
import { recordingCanvas, deepFreeze } from './helpers/mock-canvas.js';

const FIXTURE = () => JSON.parse(readFileSync(new URL('./fixtures/contracts/encounter-state.valid.json', import.meta.url), 'utf8'));

// ---- projection ------------------------------------------------------------

test('projectBattleView: tokens, statuses, turn and map from an EncounterState', () => {
  const cache = createAppearanceCache();
  const fighterKey = cache.put('fighter-l5', { race: { name: 'Human' }, equipment: { mainhand: { name: 'Longsword' } } });
  const view = projectBattleView(FIXTURE(), cache);
  assert.equal(view.v, RENDER_VIEW_VERSION);
  assert.equal(view.activeId, 'pc-wizard', 'initiative[turnIndex]');
  assert.deepEqual(view.grid, { cols: 12, rows: 8, cellFt: 5 });
  assert.equal(view.map.kind, 'image', 'imageId implies an image map');
  assert.deepEqual(view.map.calib, { cellPx: 100, offsetX: 0, offsetY: 0 });
  assert.equal(view.terrain.flags, 'AAAAAAAA');
  assert.equal(view.fog, null);
  assert.deepEqual(view.tokens.map(t => t.id), ['pc-fighter', 'm-goblin', 'm-fanatic', 'pc-wizard'], 'row, then col');
  const by = Object.fromEntries(view.tokens.map(t => [t.id, t]));
  assert.equal(by['pc-fighter'].appearanceKey, fighterKey);
  assert.equal(by['pc-wizard'].appearanceKey, 'pc:wizard-l5', 'placeholder key until the sheet is cached');
  assert.equal(by['m-goblin'].appearanceKey, 'monster:goblin');
  assert.equal(by['m-goblin'].hpState, 'down');
  assert.equal(by['pc-fighter'].worstCondition, 'paralyzed');
  assert.deepEqual(by['m-fanatic'].conditions, ['prone']);
  assert.equal(by['m-fanatic'].concentration, 'hold-person');
  assert.equal(by['pc-wizard'].tempHp, true);
  assert.equal(by['m-fanatic'].side, 'hostile');
});

test('projectBattleView: two clients with the same state build deep-equal, JSON-pure views', () => {
  const a = projectBattleView(FIXTURE(), { 'fighter-l5': 'a:1' });
  const b = projectBattleView(FIXTURE(), new Map([['fighter-l5', 'a:1']]));
  assert.deepEqual(a, b);
  assert.deepEqual(JSON.parse(JSON.stringify(a)), a);
  const setup = FIXTURE();
  setup.phase = 'setup';
  assert.equal(projectBattleView(setup).activeId, null);
});

test('viewMapOf: normalises every map kind', () => {
  assert.deepEqual(viewMapOf(null), { kind: 'color', color: '#3d5a3d' });
  assert.deepEqual(viewMapOf({ kind: 'generated', biome: 'forest', seed: 9, color: '#111' }), { kind: 'generated', color: '#111', biome: 'forest', seed: 9 });
  const img = viewMapOf({ kind: 'image', url: '/u/x.webp', imgW: 10, imgH: 10, calib: { cellPx: 5, offsetX: 1, offsetY: 2 }, cinemaBiome: 'cave' });
  assert.equal(img.url, '/u/x.webp');
  assert.equal(img.cinemaBiome, 'cave');
});

test('hpStateOf / worstConditionOf / conditionIdsOf mirror the sprite pipeline', () => {
  assert.equal(hpStateOf(10, 10), 'healthy');
  assert.equal(hpStateOf(2, 10), 'wounded');
  assert.equal(hpStateOf(0, 10), 'down');
  assert.equal(hpStateOf(5, 10, 3), 'down');
  assert.equal(hpStateOf(undefined, undefined), 'healthy');
  assert.equal(worstConditionOf(['stunned', 'poisoned', { id: 'unconscious' }]), 'unconscious');
  assert.equal(worstConditionOf(['prone']), null);
  assert.deepEqual(conditionIdsOf(['a', { id: 'b' }, null, {}]), ['a', 'b']);
});

test('appearanceKeyOf: ignores HP/conditions/name, tracks equipment; monsters share a key', () => {
  const base = { id: 'c1', name: 'A', race: { name: 'Elf' }, equipment: { mainhand: { name: 'Rapier' } }, hp: { current: 5, max: 10 } };
  const k = appearanceKeyOf(base);
  assert.equal(appearanceKeyOf({ ...base, id: 'c2', name: 'B', hp: { current: 0, max: 10 }, conditions: ['poisoned'] }), k);
  assert.notEqual(appearanceKeyOf({ ...base, equipment: { mainhand: { name: 'Longsword' } } }), k);
  assert.equal(appearanceKeyOf({ _isMonster: true, _presetSlug: 'goblin', id: 'm9' }), monsterAppearanceKey('goblin'));
  assert.equal(appearanceKeyOf({ b: 1, a: 2 }), appearanceKeyOf({ a: 2, b: 1 }), 'key order irrelevant');
});

test('characterForToken: the copy carries the token status; tokenStatusKey separates statuses', () => {
  const base = Object.freeze({ race: { name: 'Elf' }, hp: Object.freeze({ max: 30, current: 30 }) });
  const t = { hpState: 'wounded', conditions: ['poisoned'], worstCondition: 'poisoned', tempHp: true, concentration: 'bless' };
  const c = characterForToken(base, t);
  assert.equal(c.hp.current / c.hp.max < 0.25, true);
  assert.equal(c.hp.temp > 0, true);
  assert.deepEqual(c.conditions, ['poisoned']);
  assert.equal(c.concentration, 'bless');
  assert.equal(characterForToken(base, { hpState: 'down' }).hp.current, 0);
  assert.notEqual(tokenStatusKey(t), tokenStatusKey({ ...t, tempHp: false }));
  assert.equal(tokenStatusKey({ ...t, conditions: ['b', 'a'] }), tokenStatusKey({ ...t, conditions: ['a', 'b'] }));
});

test('legacySceneToView: PCs via positionOf, monsters via _position, overlays into local', () => {
  const pcs = [{ id: 'p1', name: 'Saris', hp: { current: 2, max: 20 }, conditions: ['poisoned'] }];
  const monsters = [{ id: 'm1', name: 'Gob', _isMonster: true, _presetSlug: 'goblin', _position: { col: 5, row: 2 }, hp: { current: 7, max: 7 } }];
  const scene = { cols: 10, rows: 7, cellSize: 64, scale: 3, map: { kind: 'color', color: '#123' }, grid: { visible: true, color: '#fff' } };
  const { view, local, appearances } = legacySceneToView(pcs, scene, {
    positionOf: (_s, id, i) => ({ col: i + 1, row: 4 }), monsterCharacters: monsters, selectedAttackerId: 'p1',
    activeTurnId: 'm1', aoeTemplate: { cells: [{ col: 0, row: 0 }] }, frameIdx: 3, direction: 'east'
  });
  assert.deepEqual(view.tokens.map(t => [t.id, t.col, t.row, t.kind]), [['p1', 1, 4, 'pc'], ['m1', 5, 2, 'monster']]);
  assert.equal(view.tokens[0].hpState, 'wounded');
  assert.equal(view.tokens[0].worstCondition, 'poisoned');
  assert.equal(view.activeId, 'm1');
  assert.equal(local.selectionId, 'p1');
  assert.equal(local.legacyZoom, 3);
  assert.equal(local.frameIdx, 3);
  assert.equal(appearances.get(view.tokens[0].appearanceKey), pcs[0]);
  assert.equal(view.tokens[1].appearanceKey, 'monster:goblin');
});

// ---- scheduler -------------------------------------------------------------

function fakeRaf() {
  const q = [];
  return {
    raf: (cb) => { q.push(cb); return q.length; },
    caf: () => { q.length = 0; },
    async flush(t = 0) { const cbs = q.splice(0); for (const cb of cbs) await cb(t); },
    get pending() { return q.length; }
  };
}

test('scheduler: many markDirty calls coalesce into one frame', async () => {
  const r = fakeRaf();
  let draws = 0;
  const s = createRenderScheduler(() => { draws++; }, r);
  s.markDirty(); s.markDirty(); s.markDirty();
  assert.equal(r.pending, 1);
  await r.flush();
  assert.equal(draws, 1);
  assert.equal(s.dirty, false);
  await r.flush();
  assert.equal(draws, 1, 'nothing to do without a new markDirty');
});

test('scheduler: an async draw never overlaps the next frame', async () => {
  const r = fakeRaf();
  let active = 0, maxActive = 0, release;
  const s = createRenderScheduler(async () => {
    active++; maxActive = Math.max(maxActive, active);
    await new Promise(res => { release = res; });
    active--;
  }, r);
  s.markDirty();
  const first = r.flush();            // starts draw #1, which blocks
  await Promise.resolve();
  s.markDirty();                      // queues a frame while #1 runs
  await r.flush();                    // frame sees running → reschedules, no overlap
  assert.equal(maxActive, 1);
  release(); await first;
  const second = r.flush();           // now draw #2 runs
  await Promise.resolve();
  release(); await second;
  assert.equal(maxActive, 1);
  assert.equal(s.frames >= 1, true);
});

test('scheduler: draw returning true keeps animating; stop cancels; errors are reported', async () => {
  const r = fakeRaf();
  let n = 0;
  const s = createRenderScheduler(() => ++n < 3, r);
  s.markDirty();
  await r.flush(); await r.flush(); await r.flush(); await r.flush();
  assert.equal(n, 3);
  s.markDirty();
  s.stop();
  await r.flush();
  assert.equal(n, 3);
  const errors = [];
  const bad = createRenderScheduler(() => { throw new Error('boom'); }, { ...r, onError: (e) => errors.push(e) });
  bad.markDirty();
  await r.flush();
  assert.equal(errors.length, 1);
  assert.equal(bad.running, false);
});

// ---- renderer contract -----------------------------------------------------

test('renderer: a deep-frozen view and local render without throwing', async () => {
  const view = deepFreeze(projectBattleView(FIXTURE()));
  const now = 1000;
  const local = deepFreeze({
    camera: createCamera({ zoom: 1.5, viewW: 640, viewH: 480, dpr: 2 }),
    ownEntityId: 'pc-fighter', hover: { col: 3, row: 3 }, selectionId: 'pc-wizard',
    pathPreview: { cells: [{ col: 1, row: 5 }, { col: 2, row: 5 }], legal: false, costFt: 5 },
    aoePreview: { cells: [{ col: 6, row: 3 }, { col: 7, row: 3 }] },
    animations: new Map([['m-fanatic', { kind: 'hurt', startedAt: 900, duration: 400 }]]),
    popups: [{ targetId: 'm-fanatic', amount: 7, startedAt: 950, duration: 800 }],
    effects: [{ kind: 'lunge', entityId: 'pc-fighter', direction: 'east', startedAt: 950, duration: 300 },
      { kind: 'burst', to: { col: 7, row: 3 }, color: '#f00', startedAt: 950, duration: 300 }],
    dm: { showTerrain: true, showHidden: true, showFogMask: true },
    resolveAppearance: () => null,
    now
  });
  const { canvas, count } = recordingCanvas();
  const res = await renderBattleScene(canvas, view, local);
  assert.equal(res.cellCount, 4);
  assert.equal(res.needsRedraw, true, 'popups/effects still live');
  assert.equal(canvas.width, 1280);
  assert.ok(count('arc') >= 4, 'placeholder discs for unresolved looks');
});

test('renderer: legacy call shape still renders through the adapter', async () => {
  const { canvas } = recordingCanvas();
  const scene = { cols: 4, rows: 3, cellSize: 64, scale: 3, map: { kind: 'color', color: '#333' }, grid: { visible: true } };
  const res = await renderBattleScene(canvas, [], scene, { positionOf: () => ({ col: 0, row: 0 }) });
  assert.equal(canvas.width, 4 * 192);
  assert.equal(res.cellCount, 0);
});

// ---- no scene mutators in the render path ----------------------------------

const HERE = dirname(fileURLToPath(import.meta.url));
const JS = resolve(HERE, '../js');

function importClosure(entries) {
  const seen = new Set();
  const stack = entries.map(e => resolve(JS, e));
  while (stack.length) {
    const file = stack.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/^\s*import\s[^'"]*['"](\.{1,2}\/[^'"]+)['"]/gm)) stack.push(resolve(dirname(file), m[1]));
    for (const m of src.matchAll(/import\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g)) stack.push(resolve(dirname(file), m[1]));
  }
  return [...seen];
}

test('render path: no scene-state / main.js import and no scene mutator reachable', () => {
  const files = importClosure(['sprite/compositor.js', 'map/view.js', 'map/scheduler.js', 'map/camera.js']);
  assert.ok(files.some(f => f.endsWith('map/view.js')));
  for (const f of files) {
    assert.ok(!/scene-state\.js$|main\.js$|scene-model\.js$/.test(f), `render path imports ${f}`);
    const src = readFileSync(f, 'utf8');
    for (const name of ['setPosition', 'updateMonsterPosition', 'saveScene', 'currentScene', 'localStorage.setItem']) {
      assert.ok(!src.includes(name), `${f} references ${name}`);
    }
  }
});
