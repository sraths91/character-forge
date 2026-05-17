import { test } from 'node:test';
import assert from 'node:assert';
import { inferProfile, profileForEntity } from '../js/scene/ai/infer.js';
import { MONSTER_PROFILES } from '../js/scene/ai/profiles.js';
import { chooseAction } from '../js/scene/ai/profile.js';

// ---------- Slug short-circuit ----------

test('M32.2: inferProfile — known slug returns the authored profile', () => {
  const p = inferProfile({ slug: 'goblin', name: 'Goblin', type: 'humanoid', cr: 0.25 });
  assert.strictEqual(p, MONSTER_PROFILES.goblin);
});

test('M32.2: inferProfile — strips Open5e srd_ prefix', () => {
  const p = inferProfile({ slug: 'srd_orc', name: 'Orc', type: 'humanoid', cr: 0.5 });
  assert.strictEqual(p, MONSTER_PROFILES.orc);
});

// ---------- Type-driven baselines ----------

test('M32.2: undead non-vampire → mindless', () => {
  const p = inferProfile({ slug: 'srd_wight', name: 'Wight', type: 'undead', cr: 3 });
  // "wight" is excluded from mindless rule (it appears in the name regex)
  assert.notStrictEqual(p.archetype, 'inferred_mindless_undead');
});

test('M32.2: ghoul (undead) → mindless', () => {
  const p = inferProfile({ slug: 'srd_ghoul', name: 'Ghoul', type: 'undead', cr: 1 });
  assert.strictEqual(p.archetype, 'inferred_mindless_undead');
});

test('M32.2: ooze type → mindless attacker', () => {
  const p = inferProfile({ slug: 'srd_gelatinous-cube', name: 'Gelatinous Cube', type: 'ooze', cr: 2 });
  assert.strictEqual(p.archetype, 'inferred_ooze');
});

// ---------- Trait-driven ----------

test('M32.2: Pack Tactics trait → pack_hunter archetype', () => {
  const p = inferProfile({
    name: 'Wolf Pup', type: 'beast', cr: 0.25,
    traits: [{ name: 'Pack Tactics', desc: 'Adv when ally within 5ft' }]
  });
  assert.strictEqual(p.archetype, 'inferred_pack_hunter');
});

test('M32.2: Nimble Escape trait → skirmisher with flee threshold', () => {
  const p = inferProfile({
    name: 'Tricky Goblin', type: 'humanoid', cr: 0.25,
    traits: [{ name: 'Nimble Escape', desc: 'Disengage as a bonus action' }]
  });
  assert.strictEqual(p.archetype, 'inferred_skirmisher');
  assert.ok(p.retreat_below_hp > 0);
});

test('M32.2: Aggressive trait → charger archetype', () => {
  const p = inferProfile({
    name: 'Berserker', type: 'humanoid', cr: 2,
    traits: ['Aggressive']
  });
  assert.strictEqual(p.archetype, 'inferred_charger');
  assert.strictEqual(p.retreat_below_hp, 0);
});

test('M32.2: Regeneration trait → brute that never retreats', () => {
  const p = inferProfile({
    name: 'Hag', type: 'fey', cr: 5,
    traits: [{ name: 'Regeneration', desc: 'Regains 10 hp at start of turn' }]
  });
  assert.strictEqual(p.retreat_below_hp, 0);
});

// ---------- Name heuristics ----------

test('M32.2: cult-themed name → cultist profile', () => {
  const p = inferProfile({ name: 'Cult Fanatic', type: 'humanoid', cr: 2 });
  assert.strictEqual(p, MONSTER_PROFILES.cultist);
});

test('M32.2: ogre → troll-family profile', () => {
  const p = inferProfile({ name: 'Ogre', type: 'giant', cr: 2 });
  assert.strictEqual(p, MONSTER_PROFILES.troll);
});

test('M32.2: small humanoid at low CR → coward_pack', () => {
  const p = inferProfile({ name: 'Sprite Mook', type: 'humanoid', cr: 0.25 });
  assert.strictEqual(p.archetype, 'inferred_coward_pack');
});

test('M32.2: high-CR creature → apex (never retreats)', () => {
  const p = inferProfile({ name: 'Ancient Wyrm', type: 'dragon', cr: 17 });
  assert.strictEqual(p.archetype, 'inferred_apex');
  assert.strictEqual(p.retreat_below_hp, 0);
});

test('M32.2: nothing matches → inferred_default', () => {
  const p = inferProfile({ name: 'Unique Thing', type: 'aberration', cr: 3 });
  assert.strictEqual(p.archetype, 'inferred_default');
});

// ---------- profileForEntity / chooseAction integration ----------

test('M32.2: profileForEntity returns _aiProfile when set, else null', () => {
  const inferred = inferProfile({ name: 'Test', type: 'humanoid', cr: 1 });
  assert.strictEqual(profileForEntity({ _aiProfile: inferred }), inferred);
  assert.strictEqual(profileForEntity({}), null);
});

test('M32.2: chooseAction honors _aiProfile override over the slug', () => {
  // Self has slug 'goblin' (which would normally use nimble_skirmisher),
  // but _aiProfile pins it to a never-retreat charger. The plan archetype
  // must reflect the override.
  const charger = inferProfile({
    name: 'Forced Charger', type: 'humanoid', cr: 1,
    traits: ['Aggressive']
  });
  const self = {
    id: 'g1', presetSlug: 'goblin', hp: 1, hpMax: 7,
    _position: { col: 0, row: 0 }, _aiProfile: charger
  };
  const plan = chooseAction({
    self,
    enemies: [{ id: 'pc1', hp: 20, hpMax: 20, _position: { col: 5, row: 0 } }],
    allies: [], rng: () => 0.5
  });
  assert.strictEqual(plan.kind, 'attack');
  assert.strictEqual(plan.archetype, 'inferred_charger');
});
