import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createVersusEncounter } from '../js/scene/encounter-setup.js';
import { seedRng } from '../js/scene/simulator.js';

function party() {
  return [
    { id: 'p1', name: 'Saris', abilityModifiers: { DEX: 2 }, classes: [{ name: 'Wizard', level: 5 }], hp: { current: 22, max: 22 } },
    { id: 'p2', name: 'Bran', abilityModifiers: { DEX: 0 }, classes: [{ name: 'Fighter', level: 5 }], hp: { current: 44, max: 44 } },
    { id: 'p3', name: 'Benched', abilityModifiers: { DEX: 1 }, classes: [{ name: 'Rogue', level: 5 }], hp: { current: 30, max: 30 } }
  ];
}

const encounter = [
  { id: 'vm_1', slug: 'goblin', name: 'Goblin' },
  { id: 'vm_2', slug: 'goblin', name: 'Goblin 2' }
];

function build(seed) {
  return createVersusEncounter({
    party: party(), pcIds: ['p1', 'p2'], encounter, flanking: true,
    rng: seedRng(seed), mintId: (i) => `m_${i}`
  });
}

test('encounter-setup: fixed seed + fixed mintId → deterministic initiative and ids', () => {
  const a = build(11);
  const b = build(11);
  assert.deepEqual(a.initiative, b.initiative);
  assert.deepEqual(a.scene.initiative, b.scene.initiative);
  assert.deepEqual(a.monsters.map(m => m.id), ['m_0', 'm_1']);
  assert.deepEqual(a.scene.monsters.map(m => m.id), ['m_0', 'm_1']);
  assert.equal(a.initiative.length, 4);
  const sorted = [...a.initiative].sort((x, y) => y.score - x.score);
  assert.deepEqual(a.initiative, sorted, 'initiative is sorted descending');
});

test('encounter-setup: scene initiative marks only the first entry active', () => {
  const { scene } = build(3);
  assert.equal(scene.initiative[0].active, true);
  assert.ok(scene.initiative.slice(1).every(e => e.active === false));
});

test('encounter-setup: party filtered to pcIds; arena built with positions and flanking', () => {
  const { scene, party: selected } = build(5);
  assert.deepEqual(selected.map(p => p.id), ['p1', 'p2']);
  assert.ok(scene.positions.p1 && scene.positions.p2);
  assert.equal(scene.positions.p3, undefined);
  assert.equal(scene.flankingEnabled, true);
  assert.ok(scene.monsters.every(m => m.position));
  assert.deepEqual(scene.monsters[0].hp, { current: 7, max: 7, temp: 0 });
});

test('encounter-setup: selected PCs get reaction resources seeded', () => {
  const { party: selected } = build(5);
  const wiz = selected.find(p => p.id === 'p1');
  assert.equal(wiz._reactionUsed, false);
  assert.ok(wiz._lvl1Slots > 0, 'a level-5 wizard has 1st-level slots');
  assert.ok(Number.isFinite(wiz._lvl3Slots));
});

test('encounter-setup: mintId receives the index and the encounter entry', () => {
  const seen = [];
  createVersusEncounter({
    party: party(), pcIds: ['p1'], encounter, rng: seedRng(1),
    mintId: (i, e) => { seen.push([i, e.slug]); return `x${i}`; }
  });
  assert.deepEqual(seen, [[0, 'goblin'], [1, 'goblin']]);
});

test('encounter-setup: rng and mintId are required', () => {
  assert.throws(() => createVersusEncounter({ party: party(), pcIds: ['p1'], encounter, mintId: (i) => `m${i}` }), TypeError);
  assert.throws(() => createVersusEncounter({ party: party(), pcIds: ['p1'], encounter, rng: seedRng(1) }), TypeError);
});
