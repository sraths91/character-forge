// M64 E5 / phase 1.5 — grid life states: status projection (E1's
// entity.status or the hp fallback), downed pose, stable badge and the
// per-viewer death fade.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { TOKEN_STATUSES, DEATH_FADE_MS, DEAD_MARKER_ALPHA, statusOf, isDownStatus, deathFadeAlpha } from '../js/map/token-fx.js';
import { projectBattleView, legacySceneToView } from '../js/map/view.js';
import { createTokenCache } from '../js/map/token-cache.js';
import { renderBattleScene } from '../js/sprite/compositor.js';
import { recordingCanvas, deepFreeze } from './helpers/mock-canvas.js';

const FIXTURE = () => JSON.parse(readFileSync(new URL('./fixtures/contracts/encounter-state.valid.json', import.meta.url), 'utf8'));

test('statusOf: entity.status wins; hp fallback is downed for PCs, dead for monsters', () => {
  assert.deepEqual([...TOKEN_STATUSES], ['active', 'downed', 'stable', 'dead']);
  assert.equal(statusOf({ kind: 'pc', hp: 0, status: 'stable' }), 'stable');
  assert.equal(statusOf({ kind: 'pc', hp: 5 }), 'active');
  assert.equal(statusOf({ kind: 'pc', hp: 0 }), 'downed');
  assert.equal(statusOf({ kind: 'pc', hp: 0, deathSaves: { failures: 3 } }), 'dead');
  assert.equal(statusOf({ kind: 'pc', hp: 0, deathSaves: { stable: true } }), 'stable');
  assert.equal(statusOf({ kind: 'monster', hp: 0 }), 'dead');
  assert.equal(statusOf({ kind: 'monster', hp: 0, status: 'bogus' }), 'dead', 'unknown values fall back');
  assert.equal(statusOf(null), 'active');
  assert.equal(isDownStatus('downed') && isDownStatus('stable') && isDownStatus('dead'), true);
  assert.equal(isDownStatus('active') || isDownStatus(undefined), false);
});

test('deathFadeAlpha: 1 at death, monotone, settles at the marker alpha after ~600 ms', () => {
  assert.equal(DEATH_FADE_MS, 600);
  assert.equal(deathFadeAlpha(0), 1);
  assert.equal(deathFadeAlpha(-5), 1);
  let prev = 1;
  for (let t = 50; t <= 600; t += 50) { const a = deathFadeAlpha(t); assert.ok(a < prev); prev = a; }
  assert.equal(deathFadeAlpha(600), DEAD_MARKER_ALPHA);
  assert.equal(deathFadeAlpha(Infinity), DEAD_MARKER_ALPHA);
});

test('projectBattleView: tokens carry status; non-active forces the down bake; legacy tokens omit it', () => {
  const s = FIXTURE();
  s.entities['pc-fighter'].hp = 0;
  s.entities['pc-fighter'].status = 'stable';
  const by = Object.fromEntries(projectBattleView(s).tokens.map(t => [t.id, t]));
  assert.equal(by['m-goblin'].status, 'dead', 'monster at 0 hp');
  assert.equal(by['pc-fighter'].status, 'stable');
  assert.equal(by['pc-fighter'].hpState, 'down');
  assert.equal(by['pc-wizard'].status, 'active');
  const { view } = legacySceneToView([{ id: 'p', hp: { current: 0, max: 9 } }], { cols: 3, rows: 3, cellSize: 64, scale: 1 }, {});
  assert.equal('status' in view.tokens[0], false, 'legacy adapter output unchanged');
});

test('token cache death clock: fade starts when seen dying, skipped when first seen dead, reset on revive', () => {
  const cache = createTokenCache({ bake: async () => ({ canvas: {} }) });
  assert.equal(cache.deathStart('a', false, 0), null);
  assert.equal(cache.deathStart('a', true, 100), 100);
  assert.equal(cache.deathStart('a', true, 400), 100, 'stable start');
  assert.equal(cache.deathStart('late', true, 100), -Infinity, 'already dead on first sight');
  cache.deathStart('a', false, 500);
  assert.equal(cache.deathStart('a', true, 900), 900, 'revived then died again');
});

function lifeView(status) {
  return deepFreeze({
    v: 1, encounterId: 'e', round: 1, activeId: null, grid: { cols: 4, rows: 4, cellFt: 5 },
    map: { kind: 'color', color: '#222' }, terrain: null, fog: null,
    tokens: [
      { id: 'live', kind: 'pc', side: 'party', name: 'L', col: 0, row: 0, appearanceKey: 'a:1', hpState: 'healthy', status: 'active', tempHp: false, conditions: [], worstCondition: null, concentration: null, hidden: false },
      { id: 'x', kind: 'monster', side: 'hostile', name: 'X', col: 0, row: 0, appearanceKey: 'a:2', hpState: 'down', status, tempHp: false, conditions: [], worstCondition: null, concentration: null, hidden: false }
    ]
  });
}

async function warmLocal() {
  const tokenCache = createTokenCache({ bake: async (c) => ({ canvas: { look: c.look }, frameCycle: 1 }) });
  const local = { tokenCache, resolveAppearance: (k) => ({ look: k }), now: 0 };
  renderBattleScene(recordingCanvas().canvas, lifeView('active'), local);   // seen alive
  await new Promise(r => setTimeout(r, 0));
  return local;
}

test('renderer: downed draws rotated, stable adds a badge, dead fades under the living then stays faint', async () => {
  const local = await warmLocal();
  // downed: a quarter-turn rotate around the drawn body.
  let r = recordingCanvas();
  renderBattleScene(r.canvas, lifeView('downed'), { ...local, now: 10 });
  assert.ok(r.calls.some(c => c[0] === 'rotate' && Math.abs(c[1] + Math.PI / 2) < 1e-9), 'prone rotate');
  // stable: the green badge.
  r = recordingCanvas();
  renderBattleScene(r.canvas, lifeView('stable'), { ...local, now: 20 });
  assert.ok(r.calls.some(c => c[0] === 'set:fillStyle' && c[1] === '#16a34a'), 'stable badge');
  // dead: first frame starts the fade at full opacity and keeps animating.
  r = recordingCanvas();
  const first = renderBattleScene(r.canvas, lifeView('dead'), { ...local, now: 1000 });
  assert.equal(first.needsRedraw, true, 'fade in progress');
  const imgs = r.calls.filter(c => c[0] === 'drawImage').map(c => c[1].look);
  assert.deepEqual(imgs, ['a:2', 'a:1'], 'dead body drawn under the living');
  const mid = recordingCanvas();
  renderBattleScene(mid.canvas, lifeView('dead'), { ...local, now: 1300 });
  const midAlpha = mid.calls.find(c => c[0] === 'set:globalAlpha')[1];
  assert.ok(midAlpha < 1 && midAlpha > DEAD_MARKER_ALPHA, `mid-fade alpha ${midAlpha}`);
  const end = recordingCanvas();
  const done = renderBattleScene(end.canvas, lifeView('dead'), { ...local, now: 1700 });
  assert.equal(done.needsRedraw, false, 'fade finished');
  assert.ok(end.calls.some(c => c[0] === 'set:globalAlpha' && c[1] === DEAD_MARKER_ALPHA), 'faint marker');
  assert.equal(end.calls.filter(c => c[0] === 'drawImage').length, 2, 'the marker stays drawn');
});
