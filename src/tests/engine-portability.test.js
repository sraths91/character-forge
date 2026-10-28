// M64 T10 — engine portability smoke test.
//
// The server imports the combat engine directly, so the engine closure
// must load and run without any browser globals. This test imports it
// inside a worker_thread where `document`, `window` and `localStorage`
// are proxies that throw on ANY access, then runs a seeded simulation
// and checks the result matches the main thread (no module-level state
// leaking between runs). The lint half of T10 is the
// no-restricted-imports block in eslint.config.js.

import { test } from 'node:test';
import assert from 'node:assert';
import { Worker } from 'node:worker_threads';
import { simulateEncounter } from '../js/scene/simulator.js';

const SCENE_DIR = new URL('../js/scene/', import.meta.url).href;
const LEGACY_DIR = new URL('../js/client/legacy/', import.meta.url).href;

const WORKER_SRC = `
const { parentPort, workerData } = require('node:worker_threads');
const tripwire = (name) => new Proxy({}, {
  get(_t, prop) { throw new Error('engine touched ' + name + '.' + String(prop)); },
  has(_t, prop) { throw new Error('engine probed ' + name + '.' + String(prop)); },
  set(_t, prop) { throw new Error('engine wrote ' + name + '.' + String(prop)); }
});
globalThis.document = tripwire('document');
globalThis.window = tripwire('window');
globalThis.localStorage = tripwire('localStorage');
(async () => {
  try {
    const dir = workerData.sceneDir;
    const engine = await import(dir + 'combat-engine.js');
    const sim = await import(dir + 'simulator.js');
    const cal = await import(dir + 'calibrator.js');
    const rng = await import(dir + 'rng.js');
    // M64 T5 — the one bridge (adapters + pure scene model) is Node-safe too;
    // M65 T24 — so is the legacy classic bridge, now outside the engine closure.
    await import(dir + 'encounter-adapters.js');
    await import(workerData.legacyDir + 'live-bridge.js');
    await import(dir + 'scene-model.js');
    await import(dir + 'turn-manager.js');
    await import(dir + 'prompt-adapter.js');
    const stats = await sim.simulateEncounter(workerData.encounter);
    const report = await cal.calibrateEncounter({ ...workerData.encounter, iterations: 5 });
    parentPort.postMessage({
      ok: true,
      exports: Object.keys(engine).sort(),
      hasCreateRng: typeof rng.createRng === 'function',
      stats,
      calibratorWinRate: report.winRate
    });
  } catch (err) {
    parentPort.postMessage({ ok: false, error: String(err && err.stack || err) });
  }
})();
`;

function encounter() {
  const pc = (id, col, cls, spells) => ({
    id, name: id, _position: { col, row: 1 }, hp: { current: 30, max: 30 },
    equipment: { mainhand: { name: 'Longsword', damage: '1d8', damageType: 'Slashing' } },
    abilityModifiers: { STR: 3, DEX: 1, CON: 2, INT: 3, WIS: 2, CHA: 2 },
    classes: [{ name: cls, level: 5 }], conditions: [], spells
  });
  const mon = (id, slug, col) => ({
    id, name: slug, presetSlug: slug, hp: { current: 25, max: 25 }, conditions: [], position: { col, row: 4 }
  });
  return {
    party: [pc('f', 1, 'Fighter', []), pc('w', 2, 'Wizard', ['Shield', 'Magic Missile']), pc('c', 3, 'Cleric', ['Cure Wounds'])],
    monsters: [mon('fan', 'cult-fanatic', 1), mon('kob', 'kobold-sorcerer', 3), mon('gob', 'goblin', 5)],
    scene: { cols: 10, rows: 8 },
    iterations: 20,
    maxRounds: 12,
    seed: 9
  };
}

function runInWorker(workerData) {
  return new Promise((resolve, reject) => {
    const w = new Worker(WORKER_SRC, { eval: true, workerData });
    w.once('message', (msg) => { resolve(msg); w.terminate(); });
    w.once('error', reject);
  });
}

test('M64 T10: combat engine imports and runs in a worker with throwing document/window/localStorage', async () => {
  const msg = await runInWorker({ sceneDir: SCENE_DIR, legacyDir: LEGACY_DIR, encounter: encounter() });
  assert.ok(msg.ok, msg.error);
  for (const name of ['runOneAttack', 'runMonsterSpell', 'runReactionAttack', 'applyDamageToEntity']) {
    assert.ok(msg.exports.includes(name), `missing export ${name}`);
  }
  assert.strictEqual(msg.hasCreateRng, true);
  assert.strictEqual(msg.stats.iterations, 20);
  assert.ok(msg.calibratorWinRate >= 0 && msg.calibratorWinRate <= 1);
});

test('M64 T10: the worker run matches the main-thread run for the same seed', async () => {
  const msg = await runInWorker({ sceneDir: SCENE_DIR, legacyDir: LEGACY_DIR, encounter: encounter() });
  assert.ok(msg.ok, msg.error);
  const local = await simulateEncounter(encounter());
  assert.deepStrictEqual(msg.stats, local);
});

// M65 T24 — the import allowlist the T10 lint block enforces, checked from
// the file system too: every src/js/scene/** import resolves inside scene/,
// shared/, campaign/ or map/ (static and dynamic, relative paths only).
test('T24: src/js/scene/** imports only from scene/, shared/, campaign/ and map/', async () => {
  const { readdirSync, readFileSync, statSync } = await import('node:fs');
  const { join, resolve, relative, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const jsRoot = fileURLToPath(new URL('../js/', import.meta.url));
  const walk = (d) => readdirSync(d).flatMap(f => {
    const p = join(d, f);
    return statSync(p).isDirectory() ? walk(p) : (f.endsWith('.js') ? [p] : []);
  });
  const offenders = [];
  let seen = 0;
  for (const file of walk(join(jsRoot, 'scene'))) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/(?:\bfrom\s+|\bimport\s*\(\s*)['"]([^'"]+)['"]/g)) {
      seen++;
      const spec = m[1];
      const top = spec.startsWith('.') ? relative(jsRoot, resolve(dirname(file), spec)).split(/[\\/]/)[0] : null;
      if (!['scene', 'shared', 'campaign', 'map'].includes(top)) offenders.push(`${relative(jsRoot, file)} → ${spec}`);
    }
  }
  assert.ok(seen > 50, `the walk found the scene imports (${seen})`);
  assert.deepEqual(offenders, []);
});
