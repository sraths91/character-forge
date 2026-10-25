/**
 * M64 phase 1.5 leftovers (M65 Wave 1, E1):
 *   A — the simulator / calibrator fight a monster's `statBlock` (the DM's
 *       live difficulty card for Open5e monsters), not only its `hp`;
 *   B — a normalised block's `spellcasting` builds the monster's spellbook
 *       (registry spells by name; unknown ones skipped with a note).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeCreature } from '../js/scene/open5e-normalize.js';
import { simulateEncounter } from '../js/scene/simulator.js';
import { calibrateEncounter } from '../js/scene/calibrator.js';
import { canonicalJson, fnv1a } from './helpers/golden-runner.js';
import { parsedDdbFixture, DDB_FIXTURES } from './helpers/entities.js';

const DIR = new URL('./fixtures/open5e/', import.meta.url);
const block = (slug) => normalizeCreature(JSON.parse(readFileSync(new URL(`srd_${slug}.json`, DIR), 'utf8')));
const party = () => DDB_FIXTURES.map((n, i) => ({ ...parsedDdbFixture(n), _position: { col: 2, row: 2 + i } }));
const SCENE = { cols: 10, rows: 8 };

test('leftover A: preset-only simulations are byte-identical to phase 1.5', async () => {
  const monsters = [
    { id: 'm1', name: 'Fan', presetSlug: 'cult-fanatic', position: { col: 5, row: 3 } },
    { id: 'm2', name: 'Drg', presetSlug: 'young-dragon', position: { col: 6, row: 2 } }
  ];
  const stats = await simulateEncounter({ party: party(), monsters, scene: SCENE, iterations: 40, seed: 7 });
  // Hash of the same run at main bb0eb05 (before M65).
  assert.equal(fnv1a(canonicalJson(stats)), '188ede9b');
});

test('leftover A: a normalised Young Red Dragon changes the win rate vs the preset', async () => {
  const base = { id: 'drg', name: 'Dragon', presetSlug: 'young-dragon', position: { col: 4, row: 3 } };
  const preset = await calibrateEncounter({ party: party(), monsters: [base], scene: SCENE, iterations: 100, seed: 3 });
  const real = await calibrateEncounter({ party: party(), monsters: [{ ...base, statBlock: block('young-red-dragon') }], scene: SCENE, iterations: 100, seed: 3 });
  assert.ok(real.winRate < preset.winRate, `stat block ${real.winRate} vs preset ${preset.winRate}`);
  assert.ok(real.avgRounds < preset.avgRounds, 'Fire Breath ends it faster');
  const drg = real.perEntity.find(e => e.id === 'drg');
  assert.equal(drg.hpMax, 178, 'the block\'s HP');
  assert.equal(drg.name, 'Dragon');
  assert.deepEqual([real.difficulty.baseXp, real.difficulty.label], [5900, 'deadly'], 'XP from the block');
});

test('leftover A: the input `hp` still sets the stat-block monster\'s current HP; no block = preset path', async () => {
  const sb = block('young-red-dragon');
  const seen = [];
  await simulateEncounter({
    party: party(), scene: SCENE, iterations: 1, seed: 1,
    monsters: [{ id: 'drg', presetSlug: 'young-dragon', statBlock: sb, hp: { current: 50, max: 178 }, position: { col: 4, row: 3 } }],
    onIterationEnd: ({ mons }) => seen.push(mons[0])
  });
  assert.equal(seen[0].hpMax, 178);
  assert.equal(seen[0].ac, 18);
  assert.ok(seen[0]._statBlockKit, 'recharge abilities from the block');
  assert.equal(seen[0].id, 'drg');
  // A block on an unknown preset slug cannot be wrapped: the preset path runs.
  const r = await simulateEncounter({
    party: party(), scene: SCENE, iterations: 2, seed: 1,
    monsters: [{ id: 'x', presetSlug: 'not-a-preset', statBlock: sb, position: { col: 4, row: 3 } }]
  });
  assert.equal(r.iterations, 2);
});

test('leftover A: calibrator XP reads a block\'s xp, else its decimal CR', async () => {
  const { ratedDifficulty } = await import('../js/scene/calibrator.js');
  const pcs = party();
  const at = (statBlock) => ratedDifficulty({ party: pcs, monsters: [{ presetSlug: 'goblin', statBlock }] }).baseXp;
  assert.equal(at({ xp: 450 }), 450);
  assert.equal(at({ cr: 0.25 }), 50);
  assert.equal(at({ cr: 0.125 }), 25);
  assert.equal(at({ cr: 3 }), 700);
  assert.equal(at(undefined), 50, 'preset fallback unchanged');
});
