// M64 E5 / phase 1.5 — per-token facing: pure event folding, the view
// field, the bake key and the renderer drawing each token's own row.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  FACINGS, directionBetween, isFacing, applyFacingEvent, positionsOf, facingsFromPositions, facingFor
} from '../js/map/facing.js';
import { projectBattleView } from '../js/map/view.js';
import { createTokenCache, directionFor } from '../js/map/token-cache.js';
import { renderBattleScene, prepareBattleView } from '../js/sprite/compositor.js';
import { validateEncounterState } from '../js/shared/encounter-state.js';
import { recordingCanvas, deepFreeze } from './helpers/mock-canvas.js';

const FIXTURE = () => JSON.parse(readFileSync(new URL('./fixtures/contracts/encounter-state.valid.json', import.meta.url), 'utf8'));

test('directionBetween: dominant axis, diagonals face sideways, same cell is null', () => {
  assert.deepEqual([...FACINGS], ['north', 'east', 'south', 'west']);
  assert.equal(directionBetween({ col: 2, row: 2 }, { col: 2, row: 0 }), 'north');
  assert.equal(directionBetween({ col: 2, row: 2 }, { col: 2, row: 5 }), 'south');
  assert.equal(directionBetween({ col: 2, row: 2 }, { col: 5, row: 3 }), 'east');
  assert.equal(directionBetween({ col: 2, row: 2 }, { col: 1, row: 1 }), 'west', 'diagonal → side view');
  assert.equal(directionBetween({ col: 1, row: 1 }, { col: 1, row: 1 }), null);
  assert.equal(directionBetween(null, { col: 1, row: 1 }), null);
  assert.equal(isFacing('east'), true);
  assert.equal(isFacing('up'), false);
});

test('applyFacingEvent: move uses the last path step, attack faces the target; pure', () => {
  const entities = deepFreeze({ a: { pos: { col: 3, row: 3 } }, b: { pos: { col: 3, row: 6 } } });
  const start = deepFreeze({});
  const moved = applyFacingEvent(start, { type: 'move', payload: {
    actorId: 'a', from: { col: 0, row: 3 }, to: { col: 3, row: 3 },
    path: [{ col: 0, row: 3 }, { col: 1, row: 2 }, { col: 2, row: 2 }, { col: 3, row: 3 }]
  } }, entities);
  assert.deepEqual(moved, { a: 'east' }, 'last step (2,2)→(3,3) is a diagonal → east');
  assert.deepEqual(start, {}, 'input untouched');
  const noPath = applyFacingEvent(moved, { type: 'move', payload: { actorId: 'a', from: { col: 3, row: 3 }, to: { col: 3, row: 1 } } });
  assert.equal(noPath.a, 'north');
  const attacked = applyFacingEvent(noPath, { type: 'attack.rolled', payload: { attackerId: 'a', targetId: 'b' } }, entities);
  assert.equal(attacked.a, 'south');
  assert.equal(applyFacingEvent(attacked, { type: 'damage', payload: { targetId: 'b' } }, entities), attacked, 'other events: same object');
  assert.equal(applyFacingEvent(attacked, { type: 'attack.rolled', payload: { attackerId: 'a', targetId: 'b' } }, entities), attacked, 'no change: same object');
  assert.deepEqual(applyFacingEvent(null, { type: 'attack.rolled', payload: { attackerId: 'a', targetId: 'zz' } }, entities), {});
});

test('facingsFromPositions / positionsOf / facingFor: snapshot diff and precedence', () => {
  const s1 = FIXTURE();
  const prev = positionsOf(s1);
  const s2 = FIXTURE();
  s2.entities['pc-fighter'].pos = { col: prev['pc-fighter'].col, row: prev['pc-fighter'].row + 1 };
  const f = facingsFromPositions({}, prev, positionsOf(s2));
  assert.deepEqual(f, { 'pc-fighter': 'south' });
  assert.equal(facingFor(f, { id: 'pc-fighter', facing: 'west' }), 'south', 'client map wins');
  assert.equal(facingFor(new Map(), { id: 'x', facing: 'west' }), 'west', 'persisted entity.facing next');
  assert.equal(facingFor(null, { id: 'x' }), null);
});

test('projectBattleView: tokens carry facing from local facings or entity.facing; deep-equal across clients', () => {
  const state = FIXTURE();
  state.entities['m-goblin'].facing = 'west';
  assert.equal(validateEncounterState(state).ok, true, 'entity.facing is a valid v1 additive field');
  const bad = FIXTURE();
  bad.entities['m-goblin'].facing = 'up';
  assert.equal(validateEncounterState(bad).ok, false);
  const view = projectBattleView(state, null, { facings: { 'pc-fighter': 'east' } });
  const by = Object.fromEntries(view.tokens.map(t => [t.id, t]));
  assert.equal(by['pc-fighter'].facing, 'east');
  assert.equal(by['m-goblin'].facing, 'west');
  assert.equal('facing' in by['pc-wizard'], false, 'unknown facing is omitted');
  assert.deepEqual(projectBattleView(state, null, { facings: new Map([['pc-fighter', 'east']]) }), view);
});

test('token cache: the bake key follows token.facing over the frame default', () => {
  const cache = createTokenCache({ bake: async () => ({ canvas: {} }) });
  const t = { appearanceKey: 'a:1', hpState: 'healthy', conditions: [] };
  assert.equal(directionFor(t, {}), 'south');
  assert.equal(directionFor(t, { direction: 'north' }), 'north');
  assert.equal(directionFor({ ...t, facing: 'east' }, { direction: 'north' }), 'east');
  assert.equal(cache.keyFor({ ...t, facing: 'east' }, { direction: 'south' }), cache.keyFor(t, { direction: 'east' }));
  assert.notEqual(cache.keyFor({ ...t, facing: 'west' }), cache.keyFor(t));
});

test('renderer: each token bakes and draws its own facing row', async () => {
  const state = FIXTURE();
  const view = deepFreeze(projectBattleView(state, null, { facings: { 'pc-fighter': 'east', 'm-fanatic': 'north' } }));
  const calls = [];
  const tokenCache = createTokenCache({ bake: async (_c, o) => { calls.push(o.direction); return { canvas: { dir: o.direction }, frameCycle: 1 }; } });
  const local = { tokenCache, resolveAppearance: () => ({}), now: 0 };
  await prepareBattleView(view, local);
  assert.deepEqual([...new Set(calls)].sort(), ['east', 'north', 'south']);
  const { canvas, calls: drawCalls } = recordingCanvas();
  renderBattleScene(canvas, view, local);
  const drawn = drawCalls.filter(c => c[0] === 'drawImage').map(c => c[1].dir);
  assert.ok(drawn.includes('east') && drawn.includes('north') && drawn.includes('south'), `drawn ${drawn}`);
});
