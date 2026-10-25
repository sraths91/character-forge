// M64 E5 / phase 1.5 — Large creatures in rendering only: size from the
// entity or stat block, 2×2 draw anchored at pos, hit-testing every
// covered cell, and grid legality untouched (still 1×1).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { projectBattleView, sizeCellsOf, tokenSizeOf, tokenCells, tokenAtCell } from '../js/map/view.js';
import { createTokenCache } from '../js/map/token-cache.js';
import { renderBattleScene, prepareBattleView } from '../js/sprite/compositor.js';
import { validateEncounterState } from '../js/shared/encounter-state.js';
import { buildOccupancy } from '../js/scene/grid-legality.js';
import { recordingCanvas, deepFreeze } from './helpers/mock-canvas.js';

const FIXTURE = () => JSON.parse(readFileSync(new URL('./fixtures/contracts/encounter-state.valid.json', import.meta.url), 'utf8'));

test('sizeCellsOf / tokenSizeOf / tokenCells', () => {
  assert.equal(sizeCellsOf('Large'), 2);
  assert.equal(sizeCellsOf('large'), 2);
  assert.equal(sizeCellsOf('Huge'), 3);
  assert.equal(sizeCellsOf('Gargantuan'), 4);
  for (const s of ['Medium', 'Small', 'Tiny', null, undefined, 'bogus']) assert.equal(sizeCellsOf(s), 1, String(s));
  assert.equal(tokenSizeOf({}), 1);
  assert.equal(tokenSizeOf({ size: 9 }), 4, 'clamped');
  assert.deepEqual(tokenCells({ col: 3, row: 1, size: 2 }), [
    { col: 3, row: 1 }, { col: 4, row: 1 }, { col: 3, row: 2 }, { col: 4, row: 2 }
  ]);
  assert.deepEqual(tokenCells({ col: 0, row: 0 }), [{ col: 0, row: 0 }]);
});

test('projection: size from entity.size or statBlock.size; valid contract field; draw order by bottom edge', () => {
  const s = FIXTURE();
  s.entities['m-goblin'].size = 'Large';
  s.entities['m-fanatic'].statBlock.size = 'Huge';
  assert.equal(validateEncounterState(s).ok, true);
  const bad = FIXTURE();
  bad.entities['m-goblin'].size = 'Enormous';
  assert.equal(validateEncounterState(bad).ok, false);
  const view = projectBattleView(s);
  const by = Object.fromEntries(view.tokens.map(t => [t.id, t]));
  assert.equal(by['m-goblin'].size, 2);
  assert.equal(by['m-fanatic'].size, 3);
  assert.equal(by['pc-wizard'].size, 1);
  const bottoms = view.tokens.map(t => t.row + t.size - 1);
  assert.deepEqual(bottoms, [...bottoms].sort((a, b) => a - b), 'sorted by bottom edge');
});

const tok = (id, col, row, over = {}) => ({
  id, kind: 'monster', side: 'hostile', name: id, col, row, appearanceKey: `a:${id}`, hpState: 'healthy', status: 'active',
  size: 1, tempHp: false, conditions: [], worstCondition: null, concentration: null, hidden: false, ...over
});
const viewOf = (tokens, activeId = null) => deepFreeze({
  v: 1, encounterId: 'e', round: 1, activeId, grid: { cols: 8, rows: 8, cellFt: 5 },
  map: { kind: 'color', color: '#222' }, terrain: null, fog: null, tokens
});

test('tokenAtCell: all four cells of a Large token hit it; living beat dead markers; hidden needs the DM', () => {
  const ogre = tok('ogre', 2, 2, { size: 2 });
  const corpse = tok('corpse', 3, 3, { status: 'dead' });
  const ghost = tok('ghost', 6, 6, { hidden: true });
  const view = viewOf([corpse, ogre, ghost]);
  for (const c of tokenCells(ogre)) assert.equal(tokenAtCell(view, c)?.id, 'ogre', `${c.col},${c.row}`);
  assert.equal(tokenAtCell(view, { col: 4, row: 2 }), null);
  assert.equal(tokenAtCell(viewOf([corpse]), { col: 3, row: 3 })?.id, 'corpse');
  assert.equal(tokenAtCell(viewOf([corpse]), { col: 3, row: 3 }, { includeDead: false }), null);
  assert.equal(tokenAtCell(view, { col: 6, row: 6 }), null);
  assert.equal(tokenAtCell(view, { col: 6, row: 6 }, { showHidden: true })?.id, 'ghost');
  assert.equal(tokenAtCell(null, { col: 0, row: 0 }), null);
});

test('renderer: a Large token draws one 128-px image at its anchor and outlines the 2×2 block', async () => {
  const view = viewOf([tok('ogre', 2, 3, { size: 2 }), tok('kobold', 5, 5)], 'ogre');
  const tokenCache = createTokenCache({ bake: async (c) => ({ canvas: { look: c.look }, frameCycle: 1 }) });
  const local = { tokenCache, resolveAppearance: (k) => ({ look: k }), now: 0, grid: { visible: false } };
  await prepareBattleView(view, local);
  const r = recordingCanvas();
  renderBattleScene(r.canvas, view, local);
  const draws = r.calls.filter(c => c[0] === 'drawImage');
  const ogre = draws.find(c => c[1].look === 'a:ogre');
  assert.deepEqual(ogre.slice(2), [128, 192, 128, 128], 'anchored at pos, 2 cells wide');
  const kobold = draws.find(c => c[1].look === 'a:kobold');
  assert.deepEqual(kobold.slice(2), [320, 320, 64, 64]);
  const outline = r.calls.find(c => c[0] === 'strokeRect');
  assert.ok(outline[1] < 130 && outline[2] < 194 && outline[3] > 120 && outline[4] > 120, `active outline covers 2×2: ${outline}`);
});

test('grid legality is untouched by token size by default (still 1×1; M65 bigCreatures is opt-in)', () => {
  const src = readFileSync(new URL('../js/scene/grid-legality.js', import.meta.url), 'utf8');
  assert.ok(!/tokenSizeOf|sizeCellsOf|map\/view\.js/.test(src), 'grid-legality does not use the render footprint');
  assert.match(src, /bigCreatures = false/, 'the footprint occupancy stays off by default');
  const s = FIXTURE();
  s.entities['m-fanatic'].size = 'Large';
  const view = projectBattleView(s);
  assert.equal(view.tokens.find(t => t.id === 'm-fanatic').size, 2, 'drawn 2×2');
  const occ = buildOccupancy(s.entities);
  const fan = s.entities['m-fanatic'].pos;
  assert.equal(occ.cells.has(`${fan.col},${fan.row}`), true);
  assert.equal(occ.cells.has(`${fan.col + 1},${fan.row + 1}`), false, 'legality still 1×1');
});
