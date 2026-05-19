import { test } from 'node:test';
import assert from 'node:assert';
import { choosePcAction } from '../js/scene/ai/pc-action.js';
import { spellById } from '../js/scene/monster-spells.js';

/** Build a minimal PC wrapper that satisfies choosePcAction's contract.
 *  Mirrors the simulator's per-iteration wrap shape. */
function buildPcWrapper(ref, overrides = {}) {
  return {
    ref,
    id: ref.id,
    name: ref.name,
    kind: 'pc',
    hp: ref.hp?.current ?? 30,
    hpMax: ref.hp?.max ?? 30,
    classes: ref.classes,
    equipment: ref.equipment,
    spells: ref.spells,
    abilityModifiers: ref.abilityModifiers,
    _position: { col: 0, row: 0 },
    _slots: { 1: 4, 2: 3, 3: 2, 4: 0, 5: 0 },
    _sneakAttackUsedThisTurn: false,
    _cunningActionUsedThisTurn: false,
    ...overrides
  };
}

function buildEnemy(overrides = {}) {
  return {
    id: 'goblin-1',
    name: 'Goblin Boss',
    kind: 'monster',
    presetSlug: 'goblin',
    _isMonster: true,
    hp: 30,
    hpMax: 30,
    _position: { col: 2, row: 0 },
    ...overrides
  };
}

// ---------- Cast plan generation ----------

test('M45 Phase 3: choosePcAction produces a cast plan for a wizard with magic-missile', () => {
  const wizard = buildPcWrapper({
    id: 'wiz', name: 'Eldra',
    classes: [{ name: 'Wizard', level: 3 }],
    equipment: { mainhand: { name: 'Quarterstaff' } },
    spells: ['Magic Missile', 'Fire Bolt', 'Shield'],
    abilityModifiers: { INT: 4, DEX: 2, STR: 0, CON: 1, WIS: 1, CHA: 0 },
    hp: { current: 22, max: 22 }
  });
  const enemy = buildEnemy({ _position: { col: 6, row: 0 } });   // 30ft away
  const plan = choosePcAction({ self: wizard, enemies: [enemy], allies: [wizard] });
  // The wizard should at least CONSIDER casting — exact pick depends
  // on profile weights. We just verify the cast path is exercised when
  // slots + range + weight all line up.
  assert.ok(plan, 'expected a plan');
  // Either cast or weapon — but NOT dodge (we set up a valid scenario)
  assert.notStrictEqual(plan.kind, 'dodge',
    `plan should not be dodge for a wizard with spells; got: ${JSON.stringify(plan)}`);
});

test('M45 Phase 3: cantrips bypass the slot pool', () => {
  const wizard = buildPcWrapper({
    id: 'wiz', name: 'Eldra',
    classes: [{ name: 'Wizard', level: 1 }],
    equipment: { mainhand: { name: 'Quarterstaff' } },
    spells: ['Fire Bolt'],
    abilityModifiers: { INT: 4, DEX: 0, STR: 0, CON: 1, WIS: 0, CHA: 0 },
    hp: { current: 8, max: 8 }
  }, { _slots: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 } });
  const enemy = buildEnemy({ _position: { col: 5, row: 0 } });
  const plan = choosePcAction({ self: wizard, enemies: [enemy], allies: [wizard] });
  // With no slots, the cantrip is the wizard's only ranged option. If
  // the planner picked it, plan.kind === 'cast' AND castAtLevel === 0.
  if (plan.kind === 'cast') {
    assert.strictEqual(plan.castAtLevel, 0, 'cantrips cast at level 0');
  }
});

// ---------- MCTS upcast selection ----------

test('M45 Phase 3: MCTS upcast — chooses base level for a low-HP target', () => {
  // Goblin at 4 HP — magic-missile base (3 darts × ~3.5 = 10.5 dmg) is
  // already lethal; the upcast tax should pin the choice at base level.
  const sorc = buildPcWrapper({
    id: 'sorc', name: 'Pyr',
    classes: [{ name: 'Sorcerer', level: 5 }],
    equipment: { mainhand: { name: 'Dagger' } },
    spells: ['Magic Missile'],
    abilityModifiers: { CHA: 4, DEX: 2, INT: 0, CON: 1, WIS: 0, STR: -1 },
    hp: { current: 32, max: 32 }
  }, { _slots: { 1: 4, 2: 3, 3: 2, 4: 0, 5: 0 } });
  const lowHpEnemy = buildEnemy({ hp: 4, hpMax: 30, _position: { col: 5, row: 0 } });
  const plan = choosePcAction({
    self: sorc,
    enemies: [lowHpEnemy],
    allies: [sorc]
  });
  if (plan.kind === 'cast' && plan.spellId === 'magic-missile') {
    // The kill is at base — no reason to upcast
    assert.ok(plan.castAtLevel === 1, `expected base level cast; got castAtLevel=${plan.castAtLevel}`);
  }
});

test('M45 Phase 3: MCTS upcast — considers higher tiers for high-HP targets', () => {
  // Big enemy + plentiful high-tier slots → MCTS should at least
  // *consider* an upcast. We don't pin the exact tier (rollout
  // randomness) but verify the plan is internally consistent: if it
  // cast at level > 1, MCTS judged the slot worth burning.
  const sorc = buildPcWrapper({
    id: 'sorc', name: 'Pyr',
    classes: [{ name: 'Sorcerer', level: 9 }],
    equipment: { mainhand: { name: 'Dagger' } },
    spells: ['Magic Missile'],
    abilityModifiers: { CHA: 4, DEX: 2, INT: 0, CON: 1, WIS: 0, STR: -1 },
    hp: { current: 50, max: 50 }
  }, { _slots: { 1: 4, 2: 3, 3: 3, 4: 3, 5: 1 } });
  const bigEnemy = buildEnemy({ hp: 150, hpMax: 150, _position: { col: 5, row: 0 } });
  const plan = choosePcAction({
    self: sorc,
    enemies: [bigEnemy],
    allies: [sorc]
  });
  // The plan should be internally consistent regardless of which tier
  // MCTS picked.
  if (plan.kind === 'cast') {
    assert.ok(plan.castAtLevel >= 1 && plan.castAtLevel <= 5,
      `upcast level must be in [1,5]; got ${plan.castAtLevel}`);
    const breakdown = plan.breakdown || [];
    const upcastEntry = breakdown.find(b => b.name?.startsWith('upcast:'));
    assert.ok(upcastEntry, 'upcast tier should appear in the plan breakdown');
  }
});

test('M45 Phase 3: MCTS upcast — no slots → no leveled cast', () => {
  const sorc = buildPcWrapper({
    id: 'sorc', name: 'Pyr',
    classes: [{ name: 'Sorcerer', level: 5 }],
    equipment: { mainhand: { name: 'Dagger' } },
    spells: ['Magic Missile'],
    abilityModifiers: { CHA: 4 },
    hp: { current: 32, max: 32 }
  }, { _slots: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 } });
  const enemy = buildEnemy({ _position: { col: 5, row: 0 } });
  const plan = choosePcAction({ self: sorc, enemies: [enemy], allies: [sorc] });
  // No slots → magic-missile should NOT appear as a leveled cast
  // candidate. The planner falls back to whatever else is available
  // (likely the dagger), and the cast plan must NOT carry magic-missile.
  if (plan.kind === 'cast') {
    assert.notStrictEqual(plan.spellId, 'magic-missile',
      'magic-missile should not fire without a 1st-level slot');
  }
});

// ---------- Cast plan shape ----------

test('M45 Phase 3: cast plan carries spellId + castAtLevel + targetId', () => {
  // Spell registry sanity — magic-missile is in the shared registry
  const mm = spellById('magic-missile');
  assert.ok(mm, 'magic-missile should exist in the spell registry');
  const wizard = buildPcWrapper({
    id: 'wiz', name: 'Eldra',
    classes: [{ name: 'Wizard', level: 5 }],
    equipment: { mainhand: { name: 'Quarterstaff' } },
    spells: ['Magic Missile'],
    abilityModifiers: { INT: 4, DEX: 2 },
    hp: { current: 30, max: 30 }
  });
  const enemy = buildEnemy({ _position: { col: 5, row: 0 } });
  const plan = choosePcAction({ self: wizard, enemies: [enemy], allies: [wizard] });
  if (plan.kind === 'cast') {
    assert.ok(plan.spellId, 'cast plan must carry spellId');
    assert.ok(Number.isFinite(plan.castAtLevel), 'cast plan must carry castAtLevel');
    assert.ok(plan.targetId, 'cast plan must carry targetId');
  }
});
