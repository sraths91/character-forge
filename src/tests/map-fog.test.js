// M64 E5 / M10 — fog bitset, the server-side filter (players never
// receive entities in unrevealed cells), and the mask pass.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createFog, isRevealed, revealCells, revealedCount, filterViewForFog } from '../js/map/fog.js';
import { projectBattleView } from '../js/map/view.js';
import { createTerrain, applyTerrainPaint, encodeTerrain, flagAt } from '../js/map/terrain.js';
import { validateEncounterState } from '../js/shared/encounter-state.js';
import { renderBattleScene } from '../js/sprite/compositor.js';
import { recordingCanvas, deepFreeze } from './helpers/mock-canvas.js';

const FIXTURE = () => JSON.parse(readFileSync(new URL('./fixtures/contracts/encounter-state.valid.json', import.meta.url), 'utf8'));

test('fog bitset: create hidden/revealed, reveal and hide cells, out-of-range is hidden', () => {
  const hidden = createFog(30, 20);
  assert.equal(revealedCount(hidden, 30, 20), 0);
  assert.equal(Math.ceil(600 / 8), 75);
  const all = createFog(30, 20, { revealed: true });
  assert.equal(revealedCount(all, 30, 20), 600);
  const some = revealCells(hidden, 30, 20, [{ col: 0, row: 0 }, { col: 29, row: 19 }, { col: 99, row: 0 }]);
  assert.equal(isRevealed(some, 30, 0, 0), true);
  assert.equal(isRevealed(some, 30, 29, 19), true);
  assert.equal(isRevealed(some, 30, 1, 0), false);
  assert.equal(isRevealed(some, 30, 30, 0), false);
  assert.equal(revealedCount(revealCells(some, 30, 20, [{ col: 0, row: 0 }], false), 30, 20), 1);
  assert.equal(isRevealed(null, 30, 5, 5), true, 'no fog means visible');
  assert.equal(revealedCount(createFog(3, 3, { revealed: true }), 3, 3), 9, 'padding bits stay clear');
});

function foggedState() {
  const s = FIXTURE();
  // Reveal the party's half (cols 0..4); the cult fanatic at (7,3) stays hidden.
  const cells = [];
  for (let r = 0; r < s.grid.rows; r++) for (let c = 0; c <= 4; c++) cells.push({ col: c, row: r });
  s.fog = revealCells(null, s.grid.cols, s.grid.rows, cells);
  s.grid.terrain = encodeTerrain(applyTerrainPaint(createTerrain(12, 8), { cells: [{ col: 1, row: 1 }, { col: 9, row: 6 }], flag: 1 }));
  return s;
}

test('server filter: players never receive entities in unrevealed cells (EncounterState)', () => {
  const state = foggedState();
  assert.deepEqual(validateEncounterState(state).errors, [], 'fog is part of the contract');
  const seat = { ...state };
  delete seat.rng;
  const filtered = filterViewForFog(deepFreeze(seat));
  assert.deepEqual(Object.keys(filtered.entities).sort(), ['m-goblin', 'pc-fighter', 'pc-wizard']);
  assert.ok(!JSON.stringify(filtered).includes('m-fanatic'), 'no trace of the hidden monster anywhere');
  assert.deepEqual(filtered.initiative.map(r => r.entityId), ['pc-fighter', 'pc-wizard', 'm-goblin']);
  assert.equal(filtered.turnIndex, 1, 'still the wizard\'s turn');
  assert.equal(flagAt(filtered.grid.terrain, 1, 1), 1, 'revealed terrain kept');
  assert.equal(flagAt(filtered.grid.terrain, 9, 6), 0, 'terrain under fog stripped');
  assert.deepEqual(validateEncounterState(filtered, { projected: true }).errors, []);
});

test('server filter: works on a RenderView and is a no-op without fog', () => {
  const view = projectBattleView(foggedState());
  const filtered = filterViewForFog(view);
  assert.deepEqual(filtered.tokens.map(t => t.id).sort(), ['m-goblin', 'pc-fighter', 'pc-wizard']);
  assert.equal(view.tokens.length, 4, 'input untouched');
  const clear = projectBattleView(FIXTURE());
  assert.equal(filterViewForFog(clear), clear);
});

test('mask pass: opaque for players, 40% for the DM only when asked, between tokens and overlays', async () => {
  const view = deepFreeze(projectBattleView(foggedState()));
  const base = { resolveAppearance: () => null, selectionId: 'pc-fighter', now: 0 };
  const hiddenCells = 8 * 12 - 8 * 5;

  const player = recordingCanvas();
  await renderBattleScene(player.canvas, view, base);
  const fogFills = player.calls.filter(c => c[0] === 'fillRect' && c[3] === 64 && c[1] >= 5 * 64);
  assert.equal(fogFills.length, hiddenCells, 'headless fallback paints each hidden cell');
  assert.ok(player.calls.some(c => c[0] === 'set:globalAlpha' && c[1] === 1));
  const lastArc = player.calls.map(c => c[0]).lastIndexOf('arc');
  const firstFog = player.calls.indexOf(fogFills[0]);
  const outline = player.calls.findIndex(c => c[0] === 'strokeRect');
  assert.ok(lastArc < firstFog && firstFog < outline, 'tokens < fog < selection outline');

  const dmOff = recordingCanvas();
  await renderBattleScene(dmOff.canvas, view, { ...base, dm: { showFogMask: false } });
  assert.equal(dmOff.calls.filter(c => c[0] === 'fillRect' && c[1] >= 5 * 64 && c[3] === 64).length, 0);

  const dmOn = recordingCanvas();
  await renderBattleScene(dmOn.canvas, view, { ...base, dm: { showFogMask: true } });
  assert.ok(dmOn.calls.some(c => c[0] === 'set:globalAlpha' && c[1] === 0.4));
});
