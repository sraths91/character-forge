import { test } from 'node:test';
import assert from 'node:assert';
import { chooseAction, formatBreakdown, fleeTargetCell } from '../js/scene/ai/profile.js';
import { profileFor, MONSTER_PROFILES, DEFAULT_PROFILE } from '../js/scene/ai/profiles.js';
import { CONSIDERATIONS, scoreConsideration } from '../js/scene/ai/considerations.js';

// ---------- Profile lookup ----------

test('M32: profileFor — known slug returns the authored profile', () => {
  const p = profileFor('goblin');
  assert.strictEqual(p.archetype, 'nimble_skirmisher');
});

test('M32: profileFor — unknown slug falls back to DEFAULT_PROFILE', () => {
  assert.strictEqual(profileFor('not-a-monster'), DEFAULT_PROFILE);
  assert.strictEqual(profileFor(undefined), DEFAULT_PROFILE);
});

test('M32: M32.0 ships exactly the 5 promised profiles', () => {
  const promised = ['goblin', 'orc', 'kobold', 'vampire-spawn', 'bandit'];
  for (const slug of promised) {
    assert.ok(MONSTER_PROFILES[slug], `missing profile: ${slug}`);
  }
});

// ---------- Considerations sanity ----------

test('M32: target_low_hp scales inversely with target HP fraction', () => {
  const full = CONSIDERATIONS.target_low_hp({ target: { hp: 10, hpMax: 10 } });
  const half = CONSIDERATIONS.target_low_hp({ target: { hp: 5,  hpMax: 10 } });
  const dead = CONSIDERATIONS.target_low_hp({ target: { hp: 0,  hpMax: 10 } });
  assert.strictEqual(full, 0);
  assert.strictEqual(half, 0.5);
  assert.strictEqual(dead, 1);
});

test('M32: target_low_hp tolerates live-UI hp shape {current, max}', () => {
  const v = CONSIDERATIONS.target_low_hp({ target: { hp: { current: 2, max: 10 } } });
  assert.strictEqual(v, 0.8);
});

test('M32: pack_tactics_active fires when any ally is adjacent to target', () => {
  const target = { _position: { col: 5, row: 5 }, hp: 10, hpMax: 10 };
  const v1 = CONSIDERATIONS.pack_tactics_active({
    target, allies: [{ _position: { col: 5, row: 4 }, hp: 5, hpMax: 5 }]
  });
  const v0 = CONSIDERATIONS.pack_tactics_active({
    target, allies: [{ _position: { col: 0, row: 0 }, hp: 5, hpMax: 5 }]
  });
  assert.strictEqual(v1, 1);
  assert.strictEqual(v0, 0);
});

test('M32: self_isolated is 1 when no ally within 10ft, else 0', () => {
  const self = { _position: { col: 0, row: 0 } };
  const alone   = CONSIDERATIONS.self_isolated({ self, allies: [] });
  const flanked = CONSIDERATIONS.self_isolated({
    self, allies: [{ _position: { col: 1, row: 1 }, hp: 5, hpMax: 5 }]
  });
  assert.strictEqual(alone, 1);
  assert.strictEqual(flanked, 0);
});

test('M32: scoreConsideration applies step curve', () => {
  const above = scoreConsideration(
    'target_low_hp', { weight: 1, curve: 'step' },
    { target: { hp: 4, hpMax: 10 } }    // raw 0.6 → curved 1
  );
  const below = scoreConsideration(
    'target_low_hp', { weight: 1, curve: 'step' },
    { target: { hp: 6, hpMax: 10 } }    // raw 0.4 → curved 0
  );
  assert.strictEqual(above.weighted, 1);
  assert.strictEqual(below.weighted, 0);
});

// ---------- chooseAction: target selection ----------

test('M32: goblin — picks the wounded PC over the healthy one', () => {
  const self = { id: 'g1', presetSlug: 'goblin', hp: 7, hpMax: 7, _position: { col: 1, row: 1 } };
  const wounded = { id: 'pc-wounded', hp: 2,  hpMax: 30, _position: { col: 3, row: 1 } };
  const healthy = { id: 'pc-healthy', hp: 30, hpMax: 30, _position: { col: 3, row: 2 } };
  const plan = chooseAction({
    self, enemies: [healthy, wounded], allies: [], rng: () => 0.9
  });
  assert.strictEqual(plan.kind, 'attack');
  assert.strictEqual(plan.targetId, 'pc-wounded');
  assert.strictEqual(plan.archetype, 'nimble_skirmisher');
  assert.ok(plan.breakdown.length > 0);
});

test('M32: orc — never retreats even at 1 HP', () => {
  const self = { id: 'o1', presetSlug: 'orc', hp: 1, hpMax: 15, _position: { col: 0, row: 0 } };
  const plan = chooseAction({
    self,
    enemies: [{ id: 'pc1', hp: 20, hpMax: 20, _position: { col: 5, row: 0 } }],
    allies: [], rng: () => 0.5
  });
  assert.strictEqual(plan.kind, 'attack');
});

test('M32: bandit — flees when below 50% HP', () => {
  const self = { id: 'b1', presetSlug: 'bandit', hp: 4, hpMax: 11, _position: { col: 5, row: 5 } };
  const plan = chooseAction({
    self,
    enemies: [{ id: 'pc1', hp: 20, hpMax: 20, _position: { col: 6, row: 5 } }],
    allies: [], rng: () => 0.5
  });
  assert.strictEqual(plan.kind, 'flee');
  assert.strictEqual(plan.targetId, 'pc1');
});

test('M32: bandit — does NOT flee when above 50% HP', () => {
  const self = { id: 'b1', presetSlug: 'bandit', hp: 7, hpMax: 11, _position: { col: 5, row: 5 } };
  const plan = chooseAction({
    self,
    enemies: [{ id: 'pc1', hp: 20, hpMax: 20, _position: { col: 6, row: 5 } }],
    allies: [], rng: () => 0.5
  });
  assert.strictEqual(plan.kind, 'attack');
});

test('M32: kobold — pack-tactic bonus favors a target with an adjacent ally', () => {
  const self = { id: 'k1', presetSlug: 'kobold', hp: 5, hpMax: 5, _position: { col: 1, row: 1 } };
  const allyAdjA = { id: 'k2', hp: 5, hpMax: 5, _position: { col: 4, row: 5 } }; // adjacent to pcA
  const pcA = { id: 'pcA', hp: 30, hpMax: 30, _position: { col: 5, row: 5 } };
  const pcB = { id: 'pcB', hp: 30, hpMax: 30, _position: { col: 5, row: 1 } };  // no ally adjacent
  const plan = chooseAction({
    self, enemies: [pcA, pcB], allies: [allyAdjA, self], rng: () => 0.99
  });
  // Kobold should prefer pcA because pack-tactics fires + ally proximity
  assert.strictEqual(plan.targetId, 'pcA');
});

test('M32: vampire-spawn — flees below 30% HP', () => {
  const self = { id: 'v1', presetSlug: 'vampire-spawn', hp: 20, hpMax: 82, _position: { col: 4, row: 4 } };
  const plan = chooseAction({
    self,
    enemies: [{ id: 'pc1', hp: 30, hpMax: 30, _position: { col: 5, row: 4 } }],
    allies: [], rng: () => 0.5
  });
  assert.strictEqual(plan.kind, 'flee');
});

test('M32: vampire-spawn — prefers a caster target over a bruiser', () => {
  const self = { id: 'v1', presetSlug: 'vampire-spawn', hp: 82, hpMax: 82, _position: { col: 4, row: 4 } };
  const caster = {
    id: 'wizard', hp: 22, hpMax: 22, _position: { col: 6, row: 4 },
    ref: { spells: [{ name: 'Fireball' }] }
  };
  const bruiser = { id: 'fighter', hp: 22, hpMax: 22, _position: { col: 5, row: 4 } };
  const plan = chooseAction({
    self, enemies: [bruiser, caster], allies: [], rng: () => 0.99
  });
  assert.strictEqual(plan.targetId, 'wizard');
});

// ---------- Edge cases ----------

test('M32: chooseAction — no live enemies returns empty plan', () => {
  const self = { id: 'g1', presetSlug: 'goblin', hp: 7, hpMax: 7 };
  const plan = chooseAction({ self, enemies: [], allies: [], rng: () => 0.5 });
  assert.strictEqual(plan.kind, 'attack');
  assert.strictEqual(plan.targetId, null);
});

test('M32: chooseAction — unknown slug uses DEFAULT_PROFILE and still picks a target', () => {
  const self = { id: 'unk', presetSlug: 'unknown-thing', hp: 10, hpMax: 10, _position: { col: 0, row: 0 } };
  const plan = chooseAction({
    self,
    enemies: [{ id: 'pc1', hp: 10, hpMax: 10, _position: { col: 3, row: 0 } }],
    allies: [], rng: () => 0.5
  });
  assert.strictEqual(plan.targetId, 'pc1');
  assert.strictEqual(plan.archetype, 'default_brute');
});

// ---------- Breakdown / explainability ----------

test('M32: plan.breakdown contains the contributing consideration names', () => {
  const self = { id: 'g1', presetSlug: 'goblin', hp: 7, hpMax: 7, _position: { col: 0, row: 0 } };
  const plan = chooseAction({
    self,
    enemies: [{ id: 'pc1', hp: 2, hpMax: 20, _position: { col: 2, row: 0 } }],
    allies: [],
    rng: () => 0.5
  });
  const names = plan.breakdown.map(b => b.name);
  assert.ok(names.includes('target_low_hp'));
});

test('M32: formatBreakdown produces a readable string', () => {
  const s = formatBreakdown({
    archetype: 'predator',
    breakdown: [{ name: 'target_is_caster', weighted: 0.7 }, { name: 'target_low_hp', weighted: 0.3 }]
  });
  assert.match(s, /predator:/);
  assert.match(s, /target_is_caster\(\+0\.70\)/);
});

// ---------- M32.1: remaining preset profiles ----------

test('M32.1: all 14 preset slugs now have authored profiles', () => {
  const slugs = ['goblin','orc','hobgoblin','bugbear','kobold','skeleton',
    'zombie','vampire-spawn','troll','minotaur','bandit','cultist','gnoll','ratfolk'];
  for (const slug of slugs) {
    const p = profileFor(slug);
    assert.ok(p && p !== DEFAULT_PROFILE, `slug ${slug} fell back to DEFAULT_PROFILE`);
  }
});

test('M32.1: skeleton/zombie/troll/cultist/minotaur never retreat', () => {
  for (const slug of ['skeleton', 'zombie', 'troll', 'cultist', 'minotaur']) {
    const self = { id: 'm', presetSlug: slug, hp: 1, hpMax: 100, _position: { col: 0, row: 0 } };
    const plan = chooseAction({
      self,
      enemies: [{ id: 'pc1', hp: 30, hpMax: 30, _position: { col: 3, row: 0 } }],
      allies: [], rng: () => 0.5
    });
    assert.strictEqual(plan.kind, 'attack', `${slug} should never flee`);
  }
});

test('M32.1: ratfolk flees when isolated below 50%', () => {
  const self = { id: 'r1', presetSlug: 'ratfolk', hp: 2, hpMax: 6, _position: { col: 5, row: 5 } };
  const plan = chooseAction({
    self,
    enemies: [{ id: 'pc1', hp: 20, hpMax: 20, _position: { col: 6, row: 5 } }],
    allies: [], rng: () => 0.5
  });
  assert.strictEqual(plan.kind, 'flee');
});

test('M32.1: gnoll prefers the bloodied target (Rampage flavor)', () => {
  const self = { id: 'g1', presetSlug: 'gnoll', hp: 22, hpMax: 22, _position: { col: 1, row: 1 } };
  const healthy = { id: 'tank', hp: 30, hpMax: 30, _position: { col: 3, row: 1 } };
  const bloodied = { id: 'mage', hp: 4,  hpMax: 22, _position: { col: 3, row: 2 } };
  const plan = chooseAction({
    self, enemies: [healthy, bloodied], allies: [], rng: () => 0.99
  });
  assert.strictEqual(plan.targetId, 'mage');
});

test('M32.1: hobgoblin gets a pack-tactics bonus when allies are adjacent', () => {
  const self = { id: 'h1', presetSlug: 'hobgoblin', hp: 11, hpMax: 11, _position: { col: 1, row: 1 } };
  const ally = { id: 'h2', hp: 11, hpMax: 11, _position: { col: 4, row: 5 } };
  const pcA = { id: 'pcA', hp: 30, hpMax: 30, _position: { col: 5, row: 5 } };  // ally adjacent
  const pcB = { id: 'pcB', hp: 30, hpMax: 30, _position: { col: 5, row: 1 } };
  const plan = chooseAction({
    self, enemies: [pcA, pcB], allies: [ally], rng: () => 0.99
  });
  assert.strictEqual(plan.targetId, 'pcA');
});

// ---------- fleeTargetCell ----------

test('M32: fleeTargetCell — moves away from threat, stays in bounds', () => {
  const self   = { _position: { col: 5, row: 5 } };
  const threat = { _position: { col: 7, row: 5 } };
  const cell = fleeTargetCell(self, threat, { cols: 10, rows: 10 });
  // Move was -col direction (away from threat)
  assert.ok(cell.col < 5);
  assert.ok(cell.col >= 0 && cell.col < 10);
});
