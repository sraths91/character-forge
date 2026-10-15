/**
 * M64 H2 — engine golden tests: same seed + same intents → identical log.
 *
 * Fixtures:  src/tests/fixtures/encounters/<name>.{state,intents}.json
 * Goldens:   src/tests/golden/<name>.events.json
 * Re-bless:  UPDATE_GOLDEN=1 npm test   (only in a commit that says why)
 *
 * Tripwires (see helpers/golden-runner.js for the per-step checks):
 *   - Math.random throws and Date.now is frozen, installed BEFORE the
 *     engine is imported (dynamic import below);
 *   - after every step the whole wrapper state survives a JSON round-trip
 *     and nothing changes on the next setImmediate;
 *   - each scenario runs twice in-process and once in a worker_thread,
 *     and all three logs must be identical (catches module-level state).
 *
 * The engine is driven through runOneAttack with a seeded rng and
 * prompts {} apart from forcePlan (the manual-play path). Scenarios that
 * fail on today's code are skipped with the plan task that unblocks them
 * — never deleted.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
import { installTripwires, FROZEN_NOW } from './helpers/tripwires.js';

installTripwires();
const { loadScenario, runScenario, canonicalJson, fnv1a } = await import('./helpers/golden-runner.js');

const GOLDEN_DIR = new URL('./golden/', import.meta.url);
const UPDATE = process.env.UPDATE_GOLDEN === '1';

/** [name, what it pins, skip reason or null] — the 10 scripts of E6 §4a, split where a step is blocked. */
const SCENARIOS = [
  ['oa-leave-melee', 'melee into a leave-OA; mover moved and attacked before the turn resolved (P0-1)', null],
  ['flank-and-ranged-in-melee', 'flanking advantage + ranged attacker in melee', null],
  ['shield-reaction', 'Shield converts a marginal hit; the next attack finds no reaction', null],
  ['counterspell', 'Counterspell stops Hold Person; a second cast lands with concentration', null],
  ['aoe-save-half', 'innate Fire Breath, DEX save for half across three PCs, then AI dragon turn', null],
  ['upcast-heal', 'Cure Wounds at slot 2, Healing Word at slot 3', null],
  ['concentration-broken', 'Magic Missile damage forces a concentration save on Hold Person', null],
  ['legendary-actions', 'legendary tail attack after a PC turn', null],
  ['action-surge', 'Action Surge grants a second attack in the same turn', null],
  ['downed-dm-sethp', 'goblins drop the fighter to 0, DM sets HP mid-round, fighter swings', null],
  ['dm-force-roll', 'DM arms a natural 20 on a monster attack mid-round',
    'blocked on E1 T8 (M64 plan): the engine has no onRoll hook'],
  ['pc-ai-turn', 'an AI-planned PC turn keeps the wrapper state pure JSON', null]
];
const RUNNABLE = SCENARIOS.filter(([, , skip]) => !skip).map(([name]) => name);

function goldenPath(name) { return new URL(`${name}.events.json`, GOLDEN_DIR); }

function readGolden(name) {
  const p = goldenPath(name);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, 'utf8'));
}

function runInWorker(names) {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL('./helpers/golden-worker.js', import.meta.url), { workerData: { names } });
    w.once('message', (m) => (m.error ? reject(new Error(m.error)) : resolve(m.results)));
    w.once('error', reject);
    w.once('exit', (code) => { if (code !== 0) reject(new Error(`golden worker exited ${code}`)); });
  });
}

test('golden tripwires are armed: Math.random throws, Date.now is frozen', () => {
  assert.throws(() => Math.random(), /unseeded rng/);
  assert.equal(Date.now(), FROZEN_NOW);
});

test('golden helpers: canonicalJson sorts keys, fnv1a is stable', () => {
  assert.equal(canonicalJson({ b: 1, a: [{ d: 2, c: 3 }] }), '{"a":[{"c":3,"d":2}],"b":1}');
  assert.equal(fnv1a(''), '811c9dc5');
  assert.equal(fnv1a('abc'), fnv1a('abc'));
  assert.notEqual(fnv1a('abc'), fnv1a('abd'));
});

for (const [name, what, skip] of SCENARIOS) {
  test(`golden: ${name} — ${what}`, skip ? { skip } : {}, async () => {
    const first = await runScenario(loadScenario(name));
    const second = await runScenario(loadScenario(name));
    assert.deepStrictEqual(second, first, 'a second in-process run must produce the identical log');
    if (UPDATE) {
      mkdirSync(GOLDEN_DIR, { recursive: true });
      writeFileSync(goldenPath(name), JSON.stringify(first, null, 2) + '\n');
      return;
    }
    const golden = readGolden(name);
    assert.ok(golden, `no golden for ${name}; run UPDATE_GOLDEN=1 npm test and commit the reason`);
    assert.deepStrictEqual(first, golden, `${name} diverged from its golden log`);
  });
}

test('golden: a fresh worker_thread reproduces every runnable log', async () => {
  const results = await runInWorker(RUNNABLE);
  for (const name of RUNNABLE) {
    const expected = UPDATE ? await runScenario(loadScenario(name)) : readGolden(name);
    assert.ok(expected, `no golden for ${name}`);
    assert.deepStrictEqual(results[name], expected, `${name}: worker log differs (module-level state?)`);
  }
});

test('golden: the OA scenario resolves the opportunity attack before the turn returns (P0-1)', async () => {
  const r = await runScenario(loadScenario('oa-leave-melee'));
  const t1 = r.events.filter(e => e.turnId === 't1').map(e => e.type);
  assert.ok(t1.includes('move'), 'mover moved');
  assert.ok(r.events.some(e => e.turnId === 't1' && e.type === 'resource.spent' && e.payload.entityId === 'm-gob-a' && e.payload.resource === 'reaction'), 'OA spent the reaction');
  assert.ok(r.events.some(e => e.turnId === 't1' && e.type === 'damage' && e.payload.targetId === 'pc-fighter'), 'OA landed');
  assert.ok(r.events.some(e => e.turnId === 't1' && e.type === 'damage' && e.payload.targetId === 'm-gob-b'), 'mover attacked after moving');
});
