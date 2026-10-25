// M65 E5 — Large creatures in legality, prepared behind {bigCreatures:false}:
// footprint(size), footprintCells, buildOccupancy / validateMove marking a
// whole footprint only when asked. Default behaviour is unchanged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  footprint, footprintCells, buildOccupancy, findPath, reachableCells, validateMove, MOVE_REASONS
} from '../js/scene/grid-legality.js';
import { projectBattleView } from '../js/map/view.js';

const FIXTURE = () => JSON.parse(readFileSync(new URL('./fixtures/contracts/encounter-state.valid.json', import.meta.url), 'utf8'));

function pc(id, col, row, extra = {}) {
  return {
    id, kind: 'pc', side: 'party', name: id, pos: { col, row }, hp: 20, hpMax: 20, speedFt: 30,
    conditions: [], resources: { reactionUsed: false }, ...extra
  };
}
function ogre(id, col, row, extra = {}) {
  return {
    id, kind: 'monster', side: 'hostile', name: id, pos: { col, row }, hp: 59, hpMax: 59, speedFt: 40,
    conditions: [], resources: { reactionUsed: true }, statBlock: { slug: 'ogre' }, size: 'Large', ...extra
  };
}
const sorted = (set) => [...set].sort();

test('footprint: SRD size names and cell counts', () => {
  assert.equal(footprint('Tiny'), 1);
  assert.equal(footprint('Small'), 1);
  assert.equal(footprint('Medium'), 1);
  assert.equal(footprint('Large'), 2);
  assert.equal(footprint(' huge '), 3);
  assert.equal(footprint('Gargantuan'), 4);
  assert.equal(footprint(2), 2);
  assert.equal(footprint(9), 4);
  assert.equal(footprint(0), 1);
  for (const x of [null, undefined, '', 'colossal', 1.5, {}]) assert.equal(footprint(x), 1, String(x));
  assert.deepEqual(footprintCells({ col: 3, row: 1 }, 'Large'),
    [{ col: 3, row: 1 }, { col: 4, row: 1 }, { col: 3, row: 2 }, { col: 4, row: 2 }]);
  assert.deepEqual(footprintCells({ col: 0, row: 0 }, 'Medium'), [{ col: 0, row: 0 }]);
  assert.equal(footprintCells({ col: 0, row: 0 }, 'Gargantuan').length, 16);
});

test('buildOccupancy: default {bigCreatures:false} keeps every creature 1×1', () => {
  const ents = [pc('a', 0, 0), ogre('o', 3, 1), ogre('h', 6, 6, { size: 'Huge' })];
  const def = buildOccupancy(ents);
  const off = buildOccupancy(ents, { bigCreatures: false });
  assert.deepEqual(sorted(def.cells), ['0,0', '3,1', '6,6']);
  assert.deepEqual(sorted(off.cells), sorted(def.cells));
  assert.deepEqual([...off.sides].sort(), [...def.sides].sort());
});

test('buildOccupancy: {bigCreatures:true} marks the whole footprint with its side', () => {
  const ents = [pc('a', 0, 0), ogre('o', 3, 1), ogre('h', 6, 6, { size: 'Huge' }), ogre('dead', 9, 9, { hp: 0 })];
  const on = buildOccupancy(ents, { bigCreatures: true });
  assert.deepEqual(sorted(on.cells), [
    '0,0', '3,1', '3,2', '4,1', '4,2',
    '6,6', '6,7', '6,8', '7,6', '7,7', '7,8', '8,6', '8,7', '8,8'
  ]);
  assert.equal(on.sides.get('4,2'), 'hostile');
  assert.equal(on.sides.get('0,0'), 'party');
  assert.equal(on.cells.has('9,9') || on.cells.has('10,10'), false, 'dead monsters still ignored');
  // Size from a stat block, and RenderView tokens (size = cell count).
  const viaStatBlock = buildOccupancy([{ ...ogre('s', 0, 0), size: undefined, statBlock: { slug: 'ogre', size: 'Large' } }], { bigCreatures: true });
  assert.equal(viaStatBlock.cells.size, 4);
  const view = projectBattleView((() => {
    const s = FIXTURE();
    s.entities['m-fanatic'].size = 'Large';
    return s;
  })());
  const fan = view.tokens.find(t => t.id === 'm-fanatic');
  assert.equal(fan.size, 2);
  const tokOcc = buildOccupancy(view.tokens, { bigCreatures: true });
  for (const c of footprintCells(fan, fan.size)) assert.ok(tokOcc.cells.has(`${c.col},${c.row}`));
  assert.equal(buildOccupancy(view.tokens).cells.has(`${fan.col + 1},${fan.row + 1}`), false);
});

test('pathing around a Large hostile: 1×1 by default, the 2×2 footprint with bigCreatures', () => {
  const ents = [ogre('o', 2, 1)];
  const bounds = { cols: 6, rows: 4 };
  const from = { col: 0, row: 2 };
  const to = { col: 5, row: 2 };
  // Default: only the anchor (2,1) is occupied, so row 2 is open.
  const def = findPath(null, buildOccupancy(ents), from, to, { bounds });
  const on = findPath(null, buildOccupancy(ents, { bigCreatures: true }), from, to, { bounds });
  assert.ok(def && on);
  const covered = new Set(footprintCells({ col: 2, row: 1 }, 'Large').map(c => `${c.col},${c.row}`));
  assert.ok(on.path.every(p => !covered.has(`${p.col},${p.row}`)), 'avoids all four ogre cells');
  assert.ok(def.path.some(p => covered.has(`${p.col},${p.row}`)), 'default path crosses the uncounted cells');
  assert.equal(findPath(null, buildOccupancy(ents, { bigCreatures: true }), from, { col: 3, row: 2 }, { bounds }), null,
    'cannot end on a footprint cell');
  const reach = reachableCells(null, buildOccupancy(ents, { bigCreatures: true }), from, { budgetFt: 30, bounds });
  assert.equal(reach.has('3,2'), false);
  assert.equal(reachableCells(null, buildOccupancy(ents), from, { budgetFt: 30, bounds }).has('3,2'), true);
});

test('validateMove: bigCreatures off (default) vs on', () => {
  const state = {
    grid: { cols: 8, rows: 6, cellFt: 5 },
    entities: { a: pc('a', 0, 2), o: ogre('o', 3, 1) }
  };
  const path = [{ col: 1, row: 2 }, { col: 2, row: 2 }, { col: 3, row: 2 }, { col: 4, row: 3 }];
  const def = validateMove(state, 'a', path);
  assert.equal(def.legal, true, 'phase-1 rule: the ogre holds one cell');
  assert.deepEqual(validateMove(state, 'a', path, { bigCreatures: false }), def);
  const on = validateMove(state, 'a', path, { bigCreatures: true });
  assert.equal(on.legal, false);
  assert.equal(on.reason, MOVE_REASONS.HOSTILE_OCCUPIED);
  assert.equal(on.failedAt, 3);
  const toFoot = [{ col: 1, row: 2 }, { col: 2, row: 2 }, { col: 3, row: 2 }];
  const end = validateMove(state, 'a', toFoot, { bigCreatures: true });
  assert.equal(validateMove(state, 'a', toFoot).legal, true);
  assert.equal(end.reason, MOVE_REASONS.DESTINATION_OCCUPIED);
  // An ally Large creature can be passed through either way.
  const allyState = { grid: state.grid, entities: { a: pc('a', 0, 2), b: pc('b', 1, 1, { size: 'Large' }) } };
  const thru = validateMove(allyState, 'a', [{ col: 1, row: 2 }, { col: 2, row: 2 }, { col: 3, row: 2 }], { bigCreatures: true });
  assert.equal(thru.legal, true);
});
