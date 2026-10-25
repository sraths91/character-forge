// M65 — the campaign rules (src/js/campaign/**) sit inside the T10
// portability guard and the Math.random tripwire: they load in a worker
// whose document / window / localStorage throw on any access, never
// import node: modules, and every roll draws from the injected rng.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
import { parsedDdbFixture } from './helpers/entities.js';
import { restedState } from './helpers/campaign-state.js';
import { createRng } from '../js/scene/rng.js';
import { applyRest } from '../js/campaign/rest.js';
import { planLevelUp, applyLevelUp } from '../js/campaign/level-up.js';
import { drinkPotion, rollPotion } from '../js/campaign/consumables.js';
import { castDowntimeHeal } from '../js/campaign/downtime-spells.js';
import { revive } from '../js/campaign/death.js';
import { encounterXp } from '../js/campaign/xp.js';
import { makeItem } from '../js/campaign/items.js';

const DIR = new URL('../js/campaign/', import.meta.url);
const FILES = readdirSync(DIR).filter(f => f.endsWith('.js')).sort();

test('campaign modules: no Math.random, no node: imports, no DOM globals (static scan)', () => {
  assert.ok(FILES.length >= 10, `found ${FILES.join(', ')}`);
  for (const f of FILES) {
    const src = readFileSync(new URL(f, DIR), 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.doesNotMatch(code, /Math\.random/, `${f} calls Math.random`);
    assert.doesNotMatch(code, /from\s+['"]node:/, `${f} imports a node: module`);
    assert.doesNotMatch(code, /\b(document|window|localStorage|sessionStorage)\s*\./, `${f} touches a DOM global`);
    for (const m of code.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
      assert.ok(!/(^|\/)(anim|sprite|client)\/|main\.js$|scene-state\.js$/.test(m[1]), `${f} imports ${m[1]} (browser-only)`);
    }
  }
});

const WORKER_SRC = `
const { parentPort, workerData } = require('node:worker_threads');
const tripwire = (name) => new Proxy({}, {
  get(_t, prop) { throw new Error('campaign touched ' + name + '.' + String(prop)); },
  has(_t, prop) { throw new Error('campaign probed ' + name + '.' + String(prop)); },
  set(_t, prop) { throw new Error('campaign wrote ' + name + '.' + String(prop)); }
});
globalThis.document = tripwire('document');
globalThis.window = tripwire('window');
globalThis.localStorage = tripwire('localStorage');
Math.random = () => { throw new Error('Math.random called inside the campaign rules'); };
(async () => {
  try {
    const out = {};
    for (const f of workerData.files) out[f] = Object.keys(await import(workerData.dir + f)).sort();
    const { applyRest } = await import(workerData.dir + 'rest.js');
    const { createRng } = await import(workerData.sceneDir + 'rng.js');
    const r = applyRest(workerData.sheet, workerData.state, 'short', { spend: { Cleric: 2 }, rng: createRng({ s: 5 }) });
    parentPort.postMessage({ ok: true, exports: out, rest: r });
  } catch (err) {
    parentPort.postMessage({ ok: false, error: String(err && err.stack || err) });
  }
})();
`;

test('campaign modules import and run in a worker with throwing DOM globals and Math.random', async () => {
  const sheet = parsedDdbFixture('cleric-l5');
  const state = restedState(sheet, { hp: { current: 5, temp: 0 } });
  const msg = await new Promise((resolve, reject) => {
    const w = new Worker(WORKER_SRC, { eval: true, workerData: { dir: DIR.href, sceneDir: new URL('../js/scene/', import.meta.url).href, files: FILES, sheet, state } });
    w.once('message', (m) => { resolve(m); w.terminate(); });
    w.once('error', reject);
  });
  assert.ok(msg.ok, msg.error);
  for (const f of FILES) assert.ok(msg.exports[f].length > 0, `${f} exports something`);
  // Same seed on the main thread → the same result (no hidden module state).
  assert.deepEqual(msg.rest, applyRest(sheet, state, 'short', { spend: { Cleric: 2 }, rng: createRng({ s: 5 }) }));
});

test('Math.random tripwire: every rolling campaign path draws only from the injected rng', () => {
  const original = Math.random;
  Math.random = () => { throw new Error('Math.random called inside the campaign rules (unseeded rng)'); };
  try {
    const rng = createRng({ s: 11 });
    const cleric = parsedDdbFixture('cleric-l5');
    const fighter = parsedDdbFixture('fighter-l5');
    const hurt = restedState(cleric, { hp: { current: 3, temp: 0 } });
    applyRest(cleric, hurt, 'short', { spend: { Cleric: 3 }, rng });
    applyRest(cleric, hurt, 'long', { rng });
    const plan = planLevelUp(cleric, hurt, { settings: { hpOnLevel: 'roll' } });
    applyLevelUp(cleric, hurt, plan, {}, { rng });
    rollPotion('Potion of Supreme Healing', rng);
    drinkPotion(cleric, hurt, 'Potion of Healing', rng);
    const caster = { id: 'c', sheet: cleric, state: restedState(cleric) };
    castDowntimeHeal({ caster, spell: 'Healing Word', targets: [{ id: 'f', sheet: fighter, state: restedState(fighter, { hp: { current: 1, temp: 0 } }) }], rng });
    revive(restedState(fighter, { hp: { current: 0, temp: 0 }, deathSaves: { successes: 0, failures: 3, stable: false } }), { method: 'dm' });
    encounterXp([{ statBlock: { cr: 1 } }], [{ id: 'a' }]);
    makeItem({ origin: 'dm', name: 'Rope' });
  } finally {
    Math.random = original;
  }
});
