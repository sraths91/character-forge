import { test } from 'node:test';
import assert from 'node:assert';
import {
  runOneAttack, runMonsterSpell, runReactionAttack,
  applyDamageToEntity, saveBonusFor, pcSpellBook, abilityForCounterer,
  pickTarget, isAlive, isIncapacitated, sideAlive
} from '../js/scene/combat-engine.js';

// ---------- Module surface ----------

test('M45 Phase 4: combat-engine exports the spine entrypoints', () => {
  assert.strictEqual(typeof runOneAttack, 'function');
  assert.strictEqual(typeof runMonsterSpell, 'function');
  assert.strictEqual(typeof runReactionAttack, 'function');
});

test('M45 Phase 4: combat-engine exports the shared helpers', () => {
  for (const f of [applyDamageToEntity, saveBonusFor, pcSpellBook,
                   abilityForCounterer, pickTarget, isAlive,
                   isIncapacitated, sideAlive]) {
    assert.strictEqual(typeof f, 'function');
  }
});

// ---------- isAlive / isIncapacitated / sideAlive ----------

test('M45 Phase 4: isAlive — hp > 0 → true', () => {
  assert.strictEqual(isAlive({ hp: 1 }), true);
  assert.strictEqual(isAlive({ hp: 0 }), false);
  assert.strictEqual(isAlive({ hp: -3 }), false);
});

test('M45 Phase 4: isIncapacitated — recognises blocking conditions', () => {
  assert.strictEqual(isIncapacitated({ conditions: ['paralyzed'] }), true);
  assert.strictEqual(isIncapacitated({ conditions: ['stunned'] }), true);
  assert.strictEqual(isIncapacitated({ conditions: ['unconscious'] }), true);
  assert.strictEqual(isIncapacitated({ conditions: ['petrified'] }), true);
  assert.strictEqual(isIncapacitated({ conditions: ['frightened'] }), false);
  assert.strictEqual(isIncapacitated({ conditions: [] }), false);
  assert.strictEqual(isIncapacitated({}), false);
});

test('M45 Phase 4: sideAlive — counts only alive + non-incapacitated', () => {
  const side = [
    { hp: 5, conditions: [] },
    { hp: 0, conditions: [] },                // dead
    { hp: 8, conditions: ['paralyzed'] },     // out
    { hp: 8, conditions: [] },
    { hp: 5, conditions: ['frightened'] }     // frightened doesn't disable
  ];
  assert.strictEqual(sideAlive(side), 3);
});

// ---------- pickTarget ----------

test('M45 Phase 4: pickTarget — picks lowest-HP live enemy', () => {
  const enemies = [
    { id: 'a', hp: 10 },
    { id: 'b', hp: 3 },
    { id: 'c', hp: 0 },     // dead — skipped
    { id: 'd', hp: 7 }
  ];
  assert.strictEqual(pickTarget(enemies)?.id, 'b');
});

test('M45 Phase 4: pickTarget — empty / all-dead pool returns null', () => {
  assert.strictEqual(pickTarget([]), null);
  assert.strictEqual(pickTarget([{ hp: 0 }, { hp: 0 }]), null);
});

// ---------- saveBonusFor ----------

test('M45 Phase 4: saveBonusFor — PC reads abilityModifiers', () => {
  const pc = { kind: 'pc', ref: { abilityModifiers: { DEX: 3, WIS: 1 } } };
  assert.strictEqual(saveBonusFor(pc, 'DEX'), 3);
  assert.strictEqual(saveBonusFor(pc, 'WIS'), 1);
  assert.strictEqual(saveBonusFor(pc, 'CHA'), 0);
});

test('M45 Phase 4: saveBonusFor — null / unknown inputs → 0', () => {
  assert.strictEqual(saveBonusFor(null, 'DEX'), 0);
  assert.strictEqual(saveBonusFor({ kind: 'pc' }, null), 0);
});

// ---------- pcSpellBook + abilityForCounterer ----------

test('M45 Phase 4: pcSpellBook — wizard uses INT', () => {
  const wiz = { ref: {
    classes: [{ name: 'Wizard', level: 5 }],
    abilityModifiers: { INT: 4, DEX: 2 }
  } };
  const book = pcSpellBook(wiz);
  assert.strictEqual(book.abilityMod, 4);
  // prof at lvl 5 = 3; DC = 8 + 3 + 4 = 15
  assert.strictEqual(book.dc, 15);
  assert.strictEqual(book.attackBonus, 7);
});

test('M45 Phase 4: pcSpellBook — cleric uses WIS', () => {
  const cler = { ref: {
    classes: [{ name: 'Cleric', level: 3 }],
    abilityModifiers: { WIS: 3, INT: 0 }
  } };
  const book = pcSpellBook(cler);
  assert.strictEqual(book.abilityMod, 3);
});

test('M45 Phase 4: pcSpellBook — paladin uses CHA', () => {
  const pal = { ref: {
    classes: [{ name: 'Paladin', level: 5 }],
    abilityModifiers: { CHA: 3, STR: 2 }
  } };
  const book = pcSpellBook(pal);
  assert.strictEqual(book.abilityMod, 3);
});

test('M45 Phase 4: abilityForCounterer — class drives the stat', () => {
  assert.strictEqual(abilityForCounterer({ ref: { classes: [{ name: 'Wizard' }] } }), 'INT');
  assert.strictEqual(abilityForCounterer({ ref: { classes: [{ name: 'Cleric' }] } }), 'WIS');
  assert.strictEqual(abilityForCounterer({ ref: { classes: [{ name: 'Bard' }] } }), 'CHA');
  // Unknown class defaults to INT
  assert.strictEqual(abilityForCounterer({ ref: { classes: [{ name: 'Barbarian' }] } }), 'INT');
});

// ---------- applyDamageToEntity ----------

test('M45 Phase 4: applyDamageToEntity — reduces hp + clamps to zero', () => {
  const target = { hp: 5 };
  applyDamageToEntity(target, 3);
  assert.strictEqual(target.hp, 2);
  applyDamageToEntity(target, 10);
  assert.strictEqual(target.hp, 0);
});

test('M45 Phase 4: applyDamageToEntity — non-positive damage is a no-op', () => {
  const target = { hp: 8 };
  applyDamageToEntity(target, 0);
  assert.strictEqual(target.hp, 8);
  applyDamageToEntity(target, -5);
  assert.strictEqual(target.hp, 8);
});

test('M45 Phase 4: applyDamageToEntity — null target is safe', () => {
  assert.doesNotThrow(() => applyDamageToEntity(null, 5));
});

// =====================================================================
// M56 Phase 2 — spell-cast cinema dispatch (onCinemaRound, cast: true)
// =====================================================================

function castWizard(over = {}) {
  return {
    ref: { name: 'Wiz', classes: [{ name: 'Wizard', level: 3 }],
           abilityModifiers: { INT: 4 } },
    id: 'pc1', name: 'Wiz', kind: 'pc',
    hp: 22, hpMax: 22, ac: 14,
    conditions: [], damageDealt: 0, weapon: null,
    _position: { col: 1, row: 1 },
    _slots: { 1: 3, 2: 2, 3: 1 },
    ...over
  };
}
function castGoblin(over = {}) {
  return {
    ref: { name: 'Goblin' },
    id: 'm1', name: 'Goblin', kind: 'monster',
    presetSlug: 'goblin',
    hp: 30, hpMax: 30, ac: 12,
    conditions: [], damageDealt: 0,
    position: { col: 2, row: 1 },
    ...over
  };
}
function castSpy() {
  const calls = [];
  return { calls, prompts: { onCinemaRound: async (ev) => { calls.push(ev); } } };
}
async function castSpell({ attacker, target, spellId, castAtLevel = 1,
                           allEnemies = null, prompts = {} }) {
  await runMonsterSpell({
    attacker, target,
    plan: { spellId, castAtLevel, targetId: target?.id },
    scene: { cols: 10, rows: 7 },
    rng: () => 0.5,
    witnesses: [],
    allEnemies: allEnemies ?? (target ? [target] : []),
    prompts
  });
}

test('M56.2: heal dispatches cast cinema with the heal amount', async () => {
  const wiz = castWizard();
  const ally = castWizard({ id: 'pc2', name: 'Ally', hp: 5, hpMax: 20,
    ref: { name: 'Ally', classes: [{ name: 'Cleric', level: 3 }], abilityModifiers: { WIS: 2 } } });
  const { calls, prompts } = castSpy();
  await castSpell({ attacker: wiz, target: ally, spellId: 'cure-wounds', prompts });
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].cast, true);
  assert.strictEqual(calls[0].spell.id, 'cure-wounds');
  assert.strictEqual(calls[0].defender.id, 'pc2');
  assert.ok(calls[0].outcome.heal > 0, 'outcome carries the heal amount');
  assert.ok(ally.hp > 5, 'healing applied before the dispatch');
});

test('M56.2: heal with no valid target dispatches nothing', async () => {
  const wiz = castWizard();
  const { calls, prompts } = castSpy();
  await castSpell({ attacker: wiz, target: null, spellId: 'cure-wounds', prompts });
  assert.strictEqual(calls.length, 0);
});

test('M56.2: magic missile dispatches dmg + dart count', async () => {
  const wiz = castWizard();
  const gob = castGoblin();
  const { calls, prompts } = castSpy();
  await castSpell({ attacker: wiz, target: gob, spellId: 'magic-missile', prompts });
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].cast, true);
  assert.strictEqual(calls[0].outcome.darts, 3);
  assert.ok(calls[0].outcome.dmg > 0);
});

test('M56.2: Shield-negated magic missile dispatches nothing', async () => {
  const wiz = castWizard();
  const shielded = castWizard({
    id: 'pc9', name: 'Shieldy',
    ref: { name: 'Shieldy', classes: [{ name: 'Wizard', level: 3 }],
           abilityModifiers: { INT: 2 }, spells: ['Shield'] },
    _slots: { 1: 1 }
  });
  const { calls, prompts } = castSpy();
  await castSpell({ attacker: wiz, target: shielded, spellId: 'magic-missile', prompts });
  assert.strictEqual(calls.length, 0, 'fizzled cast plays no cinema');
});

test('M56.2: spell attack hit dispatches dmg; miss dispatches miss: true', async () => {
  const wiz = castWizard();
  // rng 0.5 → d20 = 11; +6 (prof 2 + INT 4) = 17 vs AC 12 → hit
  const gob = castGoblin();
  const hit = castSpy();
  await castSpell({ attacker: wiz, target: gob, spellId: 'fire-bolt',
                    castAtLevel: 0, prompts: hit.prompts });
  assert.strictEqual(hit.calls.length, 1);
  assert.ok(hit.calls[0].outcome.dmg > 0);
  assert.ok(!hit.calls[0].outcome.miss);
  // 17 vs AC 30 → miss
  const wall = castGoblin({ id: 'm2', ac: 30 });
  const miss = castSpy();
  await castSpell({ attacker: castWizard(), target: wall, spellId: 'fire-bolt',
                    castAtLevel: 0, prompts: miss.prompts });
  assert.strictEqual(miss.calls.length, 1);
  assert.strictEqual(miss.calls[0].outcome.dmg, 0);
  assert.strictEqual(miss.calls[0].outcome.miss, true);
});

test('M56.2: Shield-negated spell attack dispatches nothing', async () => {
  const wiz = castWizard();
  // total 17 vs AC 14: hit, and 17 < 19 so Shield converts it → fizzle
  const shielded = castWizard({
    id: 'pc9', name: 'Shieldy', ac: 14,
    ref: { name: 'Shieldy', classes: [{ name: 'Wizard', level: 3 }],
           abilityModifiers: { INT: 2 }, spells: ['Shield'] },
    _slots: { 1: 1 }
  });
  const { calls, prompts } = castSpy();
  await castSpell({ attacker: wiz, target: shielded, spellId: 'fire-bolt',
                    castAtLevel: 0, prompts });
  assert.strictEqual(calls.length, 0);
});

test('M56.2: single save dispatches dmg + saved; condition-only dispatches dmg 0', async () => {
  const wiz = castWizard();
  // DEX 0 → save 11 < DC 14 → fail, full 1d8
  const slow = castWizard({ id: 'pc3', name: 'Slow',
    ref: { name: 'Slow', classes: [{ name: 'Fighter', level: 3 }],
           abilityModifiers: { DEX: 0, WIS: 0 } } });
  const failed = castSpy();
  await castSpell({ attacker: wiz, target: slow, spellId: 'sacred-flame',
                    castAtLevel: 0, prompts: failed.prompts });
  assert.strictEqual(failed.calls.length, 1);
  assert.ok(failed.calls[0].outcome.dmg > 0);
  assert.strictEqual(failed.calls[0].outcome.saved, false);
  // DEX +5 → save 16 ≥ 14 → success; sacred flame has no half → dmg 0
  const dexy = castWizard({ id: 'pc4', name: 'Dexy',
    ref: { name: 'Dexy', classes: [{ name: 'Rogue', level: 3 }],
           abilityModifiers: { DEX: 5 } } });
  const saved = castSpy();
  await castSpell({ attacker: castWizard(), target: dexy, spellId: 'sacred-flame',
                    castAtLevel: 0, prompts: saved.prompts });
  assert.strictEqual(saved.calls.length, 1);
  assert.strictEqual(saved.calls[0].outcome.dmg, 0);
  assert.strictEqual(saved.calls[0].outcome.saved, true);
  // Hold Person (dice: null) — landed condition still dispatches, dmg 0
  const held = castWizard({ id: 'pc5', name: 'Held',
    ref: { name: 'Held', classes: [{ name: 'Fighter', level: 3 }],
           abilityModifiers: { WIS: 0 } } });
  const cond = castSpy();
  await castSpell({ attacker: castWizard(), target: held, spellId: 'hold-person',
                    castAtLevel: 2, prompts: cond.prompts });
  assert.strictEqual(cond.calls.length, 1);
  assert.strictEqual(cond.calls[0].outcome.dmg, 0);
  assert.strictEqual(cond.calls[0].outcome.saved, false);
  assert.ok(held.conditions.includes('paralyzed'), 'the condition landed');
});

test('M56.2: AoE frames the hardest-hit target, not the planner target', async () => {
  const wiz = castWizard();   // at col 1
  // Planner target saves (DEX +5 → 16 ≥ 14, half damage); the other
  // target fails (DEX 0 → full damage) and must be framed instead.
  const dexy = castWizard({ id: 'pc4', name: 'Dexy', _position: { col: 2, row: 1 },
    ref: { name: 'Dexy', classes: [{ name: 'Rogue', level: 3 }],
           abilityModifiers: { DEX: 5 } } });
  const slow = castWizard({ id: 'pc3', name: 'Slow', _position: { col: 2, row: 2 },
    ref: { name: 'Slow', classes: [{ name: 'Fighter', level: 3 }],
           abilityModifiers: { DEX: 0 } } });
  const { calls, prompts } = castSpy();
  await castSpell({ attacker: wiz, target: dexy, spellId: 'fire-breath',
                    castAtLevel: 0, allEnemies: [dexy, slow], prompts });
  assert.strictEqual(calls.length, 1, 'one dispatch for the whole blast');
  assert.strictEqual(calls[0].defender.id, 'pc3', 'framed the hardest-hit target');
  assert.strictEqual(calls[0].outcome.saved, false);
  assert.strictEqual(calls[0].outcome.targets, 2);
  assert.ok(calls[0].outcome.dmg >= calls[0].outcome.total - calls[0].outcome.dmg,
    'framed target took the largest share');
});

test('M56.2: AoE with nobody in range dispatches nothing', async () => {
  const wiz = castWizard();   // at col 1; fire-breath range 15ft = 3 cells
  const far = castWizard({ id: 'pc6', name: 'Far', _position: { col: 9, row: 6 },
    ref: { name: 'Far', classes: [{ name: 'Fighter', level: 3 }],
           abilityModifiers: { DEX: 0 } } });
  const { calls, prompts } = castSpy();
  await castSpell({ attacker: wiz, target: far, spellId: 'fire-breath',
                    castAtLevel: 0, allEnemies: [far], prompts });
  assert.strictEqual(calls.length, 0);
});

test('M56.2: simulator path (prompts: {}) resolves every kind without dispatching', async () => {
  for (const [spellId, castAtLevel] of [
    ['cure-wounds', 1], ['magic-missile', 1], ['fire-bolt', 0],
    ['sacred-flame', 0], ['fire-breath', 0]
  ]) {
    const wiz = castWizard();
    const gob = castGoblin({ position: { col: 2, row: 1 } });
    await assert.doesNotReject(
      castSpell({ attacker: wiz, target: gob, spellId, castAtLevel, prompts: {} })
    );
  }
});

// =====================================================================
// M56 Phase 4 — opportunity-attack cinema dispatch (reaction: true)
// =====================================================================

test('M56.4: OA hit dispatches onCinemaRound with reaction: true', async () => {
  const gob = castGoblin({
    attack: { name: 'Scimitar', bonus: 4, dice: '1d6+2' },
    _position: { col: 1, row: 1 }
  });
  // rng 0.5 → d20 = 11; +4 = 15 vs AC 12 → hit
  const pc = castWizard({ ac: 12 });
  const { calls, prompts } = castSpy();
  await runReactionAttack(gob, pc, { col: 1, row: 2 },
    { cols: 10, rows: 7 }, () => 0.5, prompts);
  assert.strictEqual(calls.length, 1, 'one cinema round for the OA');
  assert.strictEqual(calls[0].reaction, true);
  assert.strictEqual(calls[0].miss, false);
  assert.ok(calls[0].dmg > 0, 'damage carried in the payload');
  assert.strictEqual(calls[0].attacker.id, 'm1');
  assert.strictEqual(calls[0].defender.id, 'pc1');
  assert.ok(pc.hp < 22, 'OA damage applied before the dispatch');
});

test('M56.4: OA miss dispatches a miss cinema with reaction: true', async () => {
  const gob = castGoblin({
    attack: { name: 'Scimitar', bonus: 4, dice: '1d6+2' },
    _position: { col: 1, row: 1 }
  });
  // 15 vs AC 30 → miss
  const pc = castWizard({ ac: 30 });
  const { calls, prompts } = castSpy();
  await runReactionAttack(gob, pc, { col: 1, row: 2 },
    { cols: 10, rows: 7 }, () => 0.5, prompts);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].reaction, true);
  assert.strictEqual(calls[0].miss, true);
  assert.strictEqual(calls[0].dmg, 0);
  assert.strictEqual(pc.hp, 22, 'no damage on a miss');
});

test('M56.4: OA with prompts: {} (simulator path) resolves silently', async () => {
  const gob = castGoblin({
    attack: { name: 'Scimitar', bonus: 4, dice: '1d6+2' },
    _position: { col: 1, row: 1 }
  });
  const pc = castWizard({ ac: 12 });
  await assert.doesNotReject(
    runReactionAttack(gob, pc, { col: 1, row: 2 },
      { cols: 10, rows: 7 }, () => 0.5, {})
  );
  assert.ok(pc.hp < 22, 'the OA still resolves');
});
