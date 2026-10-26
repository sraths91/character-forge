/**
 * M65 V22 — the forge's combat driver sits behind `?classic=1` for one
 * release. Gates:
 *   - without the flag nothing reaches scene/live-bridge.js: neither
 *     main.js nor play.js statically imports it (transitively), and the
 *     only path to the driver is main.js's flag-guarded dynamic import;
 *   - the driver functions moved out of main.js intact (one copy, in
 *     client/legacy/classic-versus.js), and main.js shrank by ≥ 300 lines;
 *   - the frozen 3D lines in main.js are unchanged;
 *   - the versus panel's classic controls are flagged in index.html.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const JS = resolve(dirname(fileURLToPath(import.meta.url)), '../js');
const read = (p) => readFileSync(p, 'utf8');
const MAIN = read(resolve(JS, 'main.js'));
const LEGACY = resolve(JS, 'client/legacy/classic-versus.js');
/** main.js line count at 06523eb, before V21/V22. */
const MAIN_LINES_BEFORE = 5143;
/** Lines matching the frozen-3D grep at 06523eb (M64 decision 10). */
const FROZEN_3D_LINES = 14;

/** Every module reachable through static `import … from` (dynamic import() excluded). */
function staticGraph(entry) {
  const seen = new Set();
  const stack = [entry];
  while (stack.length) {
    const file = stack.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    const src = read(file);
    for (const m of src.matchAll(/^\s*(?:import|export)\s[^;]*?\sfrom\s+['"](\.{1,2}\/[^'"]+)['"]/gms)) {
      const next = resolve(dirname(file), m[1]);
      if (existsSync(next)) stack.push(next);
    }
  }
  return seen;
}

test('V22: without ?classic=1 no code path imports live-bridge.js', () => {
  for (const entry of ['main.js', 'play.js']) {
    const graph = [...staticGraph(resolve(JS, entry))];
    assert.ok(graph.length > 20, `${entry}: the walk found its imports`);
    assert.deepEqual(graph.filter(f => f.endsWith('/scene/live-bridge.js')), [], `${entry} statically reaches live-bridge.js`);
    assert.deepEqual(graph.filter(f => f.endsWith('/classic-versus.js')), [], `${entry} statically reaches the classic driver`);
  }
  // The only way in: a dynamic import that returns early without the flag.
  const dyn = [...MAIN.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)].map(m => m[1]);
  assert.ok(dyn.includes('./client/legacy/classic-versus.js'));
  assert.ok(!dyn.some(d => d.includes('live-bridge')), 'main.js never imports live-bridge, even lazily');
  const loader = MAIN.slice(MAIN.indexOf('function loadClassicVersus()'), MAIN.indexOf("import('./client/legacy/classic-versus.js')"));
  assert.match(loader, /if \(!classicVersusEnabled\(\)\) return Promise\.resolve\(null\);/, 'the import sits behind the flag');
  assert.match(MAIN, /get\('classic'\) === '1'/, 'the flag is ?classic=1, read from the URL');
  assert.equal((MAIN.match(/const CLASSIC_VERSUS = /g) || []).length, 1, 'read once');
});

test('V22: the driver lives once, in client/legacy/classic-versus.js; main.js shrank by ≥ 300 lines', () => {
  const legacy = read(LEGACY);
  const driver = ['startVersusFight', 'runVersusPartyAuto', 'runEngineTurn', 'runManualWeaponAttack', 'runManualCast',
    'runAttackPrompt', 'runSpellSavePrompt', 'endVersusFight', 'exitVersusFight', 'runVersusQuickStats', 'renderReplayPanel'];
  for (const fn of driver) {
    assert.match(legacy, new RegExp(`^(async )?function ${fn}\\(`, 'm'), `${fn} is in the classic module`);
    assert.doesNotMatch(MAIN, new RegExp(`^(async )?function ${fn}\\(`, 'm'), `${fn} is gone from main.js`);
  }
  assert.match(legacy, /from '\.\.\/\.\.\/scene\/live-bridge\.js'/);
  const lines = MAIN.split('\n').length - 1;
  assert.ok(lines <= MAIN_LINES_BEFORE - 300, `main.js is ${lines} lines (was ${MAIN_LINES_BEFORE})`);
});

test('V22: the frozen 3D lines in main.js are untouched', () => {
  const frozen = MAIN.split('\n').filter(l => /three-viewer|render-mode|threeViewer/.test(l));
  assert.equal(frozen.length, FROZEN_3D_LINES);
  assert.ok(frozen.includes("import { createThreeViewer } from './anim/three-viewer.js';"));
});

test('V22: index.html flags the classic controls; "Play at the table" is always there', () => {
  const html = read(resolve(JS, '../../index.html'));
  assert.match(html, /id="versus-play-table"[^>]*>Play at the table</);
  for (const id of ['versus-start', 'versus-exit', 'versus-rematch', 'versus-replay', 'cinema-canvas']) {
    assert.match(html, new RegExp(`id="${id}"[^>]*data-classic`), `${id} is classic-only`);
  }
  assert.ok((html.match(/class="versus-row versus-modes" data-classic/g) || []).length === 3, 'mode, log and view rows');
  assert.match(html, /id="versus-calibrate"/, 'the calibrator card stays');
});

test('V22: the classic module still loads and binds (the ?classic=1 path)', async () => {
  const prevDoc = globalThis.document;
  const listeners = [];
  globalThis.document = { addEventListener: (t) => listeners.push(t), getElementById: () => null, querySelectorAll: () => [] };
  try {
    const mod = await import('../js/client/legacy/classic-versus.js');
    const scene = { cols: 8, rows: 4, monsters: [], positions: {} };
    const api = mod.installClassicVersus({ party: [], scene, encounter: [], combatAdvantage: 'auto' });
    assert.equal(api.isActive(), false);
    assert.equal(api.canPersistScene(), true, 'outside a fight the scene persists');
    assert.equal(api.previousScene(), null);
    for (const k of ['start', 'exit', 'leaveForNavigation', 'stateForDrag', 'applyIntent', 'onCombatPick', 'updateAttackPreview', 'setCinemaBackground']) {
      assert.equal(typeof api[k], 'function', k);
    }
    assert.deepEqual([...new Set(listeners)].sort(), ['change', 'click'], 'the replay panel listeners install only when the module loads');
  } finally {
    if (prevDoc === undefined) delete globalThis.document; else globalThis.document = prevDoc;
  }
});
