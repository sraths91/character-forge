// M64 N1 — reaction answers are gated by eligibility.
//
// Before N1 the engine trusted prompt answers: a Fighter with no Shield
// spell and no slots got a free Shield 98/98 times when the prompt
// answered `true` (R1 F2), and the spell-attack / Magic Missile Shield
// paths auto-burned the PC's reaction without asking (R1 F3).

import { test } from 'node:test';
import assert from 'node:assert';
import { runOneAttack, runMonsterSpell, shieldCanBlock } from '../js/scene/combat-engine.js';
import { simulateEncounter, seedRng } from '../js/scene/simulator.js';

function fighterPc(over = {}) {
  return {
    id: 'pc1', name: 'Fighter', kind: 'pc', hp: 999, hpMax: 999, ac: 15, conditions: [],
    ref: { id: 'pc1', name: 'Fighter', classes: [{ name: 'Fighter', level: 3 }], spells: [], abilityModifiers: {} },
    weapon: { name: 'Longsword' }, _position: { col: 2, row: 0 }, damageDealt: 0,
    _slots: { 1: 0, 3: 0 }, _reactionUsed: false, ...over
  };
}
function wizardPc(over = {}) {
  return {
    id: 'wiz', name: 'Wizard', kind: 'pc', hp: 40, hpMax: 40, ac: 12, conditions: [],
    ref: {
      id: 'wiz', name: 'Wizard', classes: [{ name: 'Wizard', level: 5 }],
      spells: ['Shield', 'Counterspell'], abilityModifiers: { INT: 4, DEX: 2, CON: 1 }
    },
    weapon: { name: 'Quarterstaff' }, _position: { col: 3, row: 1 }, damageDealt: 0,
    _slots: { 1: 2, 3: 1 }, _reactionUsed: false, ...over
  };
}
function orc(over = {}) {
  return {
    id: 'm1', name: 'Orc', kind: 'monster', presetSlug: 'orc', hp: 15, hpMax: 15, ac: 13,
    attack: { name: 'Greataxe', bonus: 5, dice: '1d12+3' }, conditions: [],
    position: { col: 1, row: 0 }, damageDealt: 0, ...over
  };
}
function kobold(over = {}) {
  return {
    ref: { name: 'Kobold Sorcerer' }, id: 'k1', name: 'Kobold Sorcerer', kind: 'monster',
    presetSlug: 'kobold-sorcerer', hp: 20, hpMax: 20, ac: 12,
    attack: { name: 'Dagger', bonus: 4, dice: '1d4+2' }, conditions: [], damageDealt: 0,
    position: { col: 5, row: 1 }, _slots: { 1: 4, 2: 2 }, ...over
  };
}
function fanatic(over = {}) {
  return {
    ref: { name: 'Cult Fanatic' }, id: 'f1', name: 'Cult Fanatic', kind: 'monster',
    presetSlug: 'cult-fanatic', hp: 33, hpMax: 33, ac: 13,
    attack: { name: 'Dagger', bonus: 4, dice: '1d4+2' }, conditions: [], damageDealt: 0,
    position: { col: 5, row: 1 }, _slots: { 1: 4, 2: 3 }, ...over
  };
}
const castAt = (attacker, target, spellId, rng, prompts, witnesses = []) => runMonsterSpell({
  attacker, target, plan: { spellId, castAtLevel: spellId === 'fire-bolt' ? 0 : 1, targetId: target.id },
  scene: { cols: 10, rows: 7 }, rng, witnesses, allEnemies: [target], prompts
});

test('M64 N1: shield-gate probe — a PC without Shield or slots never gets a shielded hit (200 seeds, prompt always yes)', async () => {
  let prompted = 0, shielded = 0, hits = 0;
  for (let s = 1; s <= 200; s++) {
    await runOneAttack(orc(), [fighterPc()], [], { cols: 10, rows: 5 }, seedRng(s), {
      forcePlan: { kind: 'melee', targetId: 'pc1', targetSide: 'enemy', featuresFired: [] },
      onShieldReaction: async () => { prompted++; return true; },
      onCinemaRound: async ({ atk, miss }) => { if (atk?.shielded) shielded++; else if (!miss) hits++; }
    });
  }
  assert.strictEqual(shielded, 0, 'ineligible PC was shielded');
  assert.strictEqual(prompted, 0, 'ineligible PC should not even be asked');
  assert.ok(hits > 50, `expected the orc to land hits, got ${hits}`);
});

test('M64 N1: Shield answer is re-checked after the await (slot gone mid-prompt → no Shield)', async () => {
  // d20 = 11 → total 16 vs AC 15: a hit that +5 AC would turn into a miss.
  const pc = fighterPc({ ref: { ...fighterPc().ref, spells: ['Shield'] }, _slots: { 1: 1 } });
  let prompted = 0;
  const cinema = [];
  await runOneAttack(orc(), [pc], [], { cols: 10, rows: 5 }, () => 0.5, {
    forcePlan: { kind: 'melee', targetId: 'pc1', targetSide: 'enemy', featuresFired: [] },
    onShieldReaction: async () => { prompted++; pc._slots[1] = 0; return true; },
    onCinemaRound: async (ev) => { cinema.push(ev); }
  });
  assert.strictEqual(prompted, 1);
  assert.strictEqual(cinema[0].miss, false, 'the hit must land');
  assert.ok(!cinema[0].atk.shielded);
  assert.ok(pc.hp < 999);
  assert.strictEqual(pc._reactionUsed, false, 'no reaction consumed');
});

test('M64 N1: a yes answer cannot Shield a hit that +5 AC would not stop', async () => {
  // d20 = 19 → total 24 vs AC 15: Shield (20) cannot help, so no prompt and no Shield.
  const pc = fighterPc({ ref: { ...fighterPc().ref, spells: ['Shield'] }, _slots: { 1: 1 } });
  let prompted = 0;
  await runOneAttack(orc(), [pc], [], { cols: 10, rows: 5 }, () => 0.9, {
    forcePlan: { kind: 'melee', targetId: 'pc1', targetSide: 'enemy', featuresFired: [] },
    onShieldReaction: async () => { prompted++; return true; }
  });
  assert.strictEqual(prompted, 0);
  assert.strictEqual(pc._slots[1], 1);
  assert.ok(pc.hp < 999);
});

test('M64 N1: Magic Missile on a Shield-capable PC calls the Shield prompt exactly once', async () => {
  const calls = [];
  const wiz = wizardPc();
  await castAt(kobold(), wiz, 'magic-missile', seedRng(3), {
    onShieldReaction: async (ev) => { calls.push(ev); return true; }
  });
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].defender, wiz);
  assert.strictEqual(calls[0].spell.id, 'magic-missile');
  assert.strictEqual(calls[0].autoAnswer, true);
  assert.strictEqual(calls[0].atk.autoHit, true);
  assert.strictEqual(wiz.hp, 40, 'Shield blocks every dart');
  assert.strictEqual(wiz._slots[1], 1);
  assert.strictEqual(wiz._reactionUsed, true);
});

test('M64 N1: Magic Missile — declining Shield takes the darts and keeps the slot', async () => {
  const calls = [];
  const wiz = wizardPc();
  await castAt(kobold(), wiz, 'magic-missile', seedRng(3), {
    onShieldReaction: async (ev) => { calls.push(ev); return false; }
  });
  assert.strictEqual(calls.length, 1);
  assert.ok(wiz.hp < 40);
  assert.strictEqual(wiz._slots[1], 2);
  assert.strictEqual(wiz._reactionUsed, false);
});

test('M64 N1: Magic Missile on a PC without Shield never prompts', async () => {
  const calls = [];
  const pc = fighterPc({ hp: 40, hpMax: 40 });
  await castAt(kobold(), pc, 'magic-missile', seedRng(3), {
    onShieldReaction: async (ev) => { calls.push(ev); return true; }
  });
  assert.strictEqual(calls.length, 0);
  assert.ok(pc.hp < 40);
});

test('M64 N1: a spell attack (Fire Bolt) routes Shield through the prompt', async () => {
  // d20 = 11 + 3 = 14 vs AC 12: a hit that Shield (17) stops.
  for (const answer of [true, false]) {
    const calls = [];
    const wiz = wizardPc();
    await castAt(kobold(), wiz, 'fire-bolt', () => 0.5, {
      onShieldReaction: async (ev) => { calls.push(ev); return answer; }
    });
    assert.strictEqual(calls.length, 1, `answer=${answer}`);
    assert.strictEqual(calls[0].spell.id, 'fire-bolt');
    assert.strictEqual(calls[0].autoAnswer, true);
    if (answer) {
      assert.strictEqual(wiz.hp, 40);
      assert.strictEqual(wiz._slots[1], 1);
    } else {
      assert.ok(wiz.hp < 40);
      assert.strictEqual(wiz._slots[1], 2);
    }
  }
});

test('M64 N1: Counterspell — ineligible witnesses are not asked and cannot counter', async () => {
  const calls = [];
  const wiz = wizardPc({ _slots: { 3: 0 } });
  await castAt(fanatic(), wiz, 'hold-person', () => 0.01, {
    onCounterspell: async (ev) => { calls.push(ev); return true; }
  }, [wiz]);
  assert.strictEqual(calls.length, 0);
  assert.ok(wiz.conditions.includes('paralyzed'), 'Hold Person resolved (low save roll)');
  assert.strictEqual(wiz._reactionUsed, false);
});

test('M64 N1: Counterspell answer is re-checked after the await', async () => {
  const calls = [];
  const wiz = wizardPc();
  await castAt(fanatic(), wiz, 'hold-person', () => 0.01, {
    onCounterspell: async (ev) => { calls.push(ev); wiz._reactionUsed = true; return true; }
  }, [wiz]);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(wiz._slots[3], 1, 'no slot spent');
  assert.ok(wiz.conditions.includes('paralyzed'), 'spell was not countered');
});

test('M64 N1: Counterspell — eligible yes still counters', async () => {
  const wiz = wizardPc();
  await castAt(fanatic(), wiz, 'hold-person', () => 0.01, {
    onCounterspell: async () => true
  }, [wiz]);
  assert.strictEqual(wiz._slots[3], 0);
  assert.ok(!wiz.conditions.includes('paralyzed'));
});

function oaSetup() {
  const pcRef = (id, col) => ({
    id, name: id, _position: { col, row: 1 }, hp: { current: 30, max: 30 },
    equipment: { mainhand: { name: 'Longsword' } },
    abilityModifiers: { STR: 3, DEX: 1, CON: 2, INT: 0, WIS: 0, CHA: 0 },
    classes: [{ name: 'Fighter', level: 1 }], conditions: []
  });
  const pcW = (ref) => ({
    ref, id: ref.id, name: ref.id, kind: 'pc', hp: 30, hpMax: 30, ac: 10, weapon: ref.equipment.mainhand,
    conditions: [], _position: ref._position, damageDealt: 0, combatMods: [], _reactionUsed: false
  });
  const A = pcW(pcRef('A', 1));
  const B = pcW(pcRef('B', 5));
  const g = {
    ref: { id: 'g' }, id: 'g', name: 'g', kind: 'monster', presetSlug: 'goblin', hp: 50, hpMax: 50, ac: 15,
    attack: { name: 'Scimitar', bonus: 30, dice: '1d6+2' }, conditions: [], position: { col: 2, row: 1 },
    damageDealt: 0, _reactionUsed: false
  };
  return { A, B, g };
}

test('M64 N1: onReactionAttack receives autoAnswer and a yes is gated on the triggerer still having its reaction', async () => {
  const { A, B, g } = oaSetup();
  const calls = [];
  const cinema = [];
  await runOneAttack(g, [A, B], [g], { cols: 10, rows: 5 }, seedRng(3), {
    forcePlan: { kind: 'attack', targetId: 'B' },
    onReactionAttack: async (ev) => { calls.push(ev); ev.triggerer._reactionUsed = true; return true; },
    onCinemaRound: async (ev) => { cinema.push(ev); }
  });
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].autoAnswer, true);
  assert.strictEqual(calls[0].kind, 'leave');
  assert.strictEqual(cinema.filter(e => e.reaction).length, 0, 'no OA without a reaction');
  assert.strictEqual(A.damageDealt, 0);
  assert.strictEqual(g.position.col, 4, 'mover still moves');
});

test('M64 N1: onReactionAttack yes with the reaction available fires the OA', async () => {
  const { A, B, g } = oaSetup();
  const cinema = [];
  await runOneAttack(g, [A, B], [g], { cols: 10, rows: 5 }, seedRng(3), {
    forcePlan: { kind: 'attack', targetId: 'B' },
    onReactionAttack: async () => true,
    onCinemaRound: async (ev) => { cinema.push(ev); }
  });
  assert.strictEqual(cinema.filter(e => e.reaction).length, 1);
  assert.strictEqual(A._reactionUsed, true);
});

test('M64 N1: shieldCanBlock — eligibility rules', () => {
  const wiz = wizardPc();
  assert.strictEqual(shieldCanBlock(wiz, { hit: true, crit: false, total: 14 }), true);
  assert.strictEqual(shieldCanBlock(wiz, { hit: true, crit: false, total: 17 }), false, '+5 AC not enough');
  assert.strictEqual(shieldCanBlock(wiz, { hit: true, crit: true, total: 14 }), false, 'crits ignore Shield');
  assert.strictEqual(shieldCanBlock(wiz, { hit: false, crit: false, total: 5 }), false);
  assert.strictEqual(shieldCanBlock(wiz, { hit: true, crit: false, total: null, autoHit: true }), true);
  assert.strictEqual(shieldCanBlock(wizardPc({ _slots: { 1: 0 } }), { hit: true, crit: false, total: 14 }), false);
  assert.strictEqual(shieldCanBlock(wizardPc({ _reactionUsed: true }), { hit: true, crit: false, total: 14 }), false);
  assert.strictEqual(shieldCanBlock(fighterPc({ _slots: { 1: 3 } }), { hit: true, crit: false, total: 16 }), false, 'no Shield spell');
  assert.strictEqual(shieldCanBlock(orc(), { hit: true, crit: false, total: 14 }), false, 'monsters do not Shield');
});

// ---------- Simulator unchanged (prompts: {}) ----------
//
// Recorded on this branch immediately BEFORE the N1 gate (after T1-T3).
// With prompts:{} the heuristic answers already check eligibility, so the
// gate must not move a single number.
//
// Re-baselined once in M64 round 3 (ally-heal fix): AI heal plans
// (cult-fanatic Cure Wounds, cleric Healing Word) used to be looked up
// among the enemies and never resolved; they now land. Casters bench:
// win 0.98 → 0.83, avg rounds 7.31 → 8.76, draws 2 → 14 (the fanatic
// keeps healing into the 12-round cap). 4v4 bench: win 1 → 1, avg
// rounds 3.285 → 3.255.
//
// Re-baselined once in M64 R8 (one applyDamage): weapon, OA and smite
// damage now force the concentration save (B9), a creature dropped to
// 0 HP loses concentration without a save, and Healing Word can pick a
// downed PC back up. Casters bench: avg rounds 8.76 → 8.72, cleric death
// rate 0.99 → 0.97; 4v4 bench: avg rounds 3.255 → 3.25.
//
// Re-baselined once in M64 R7 (condition lifecycle): Hold Person
// targets repeat the WIS save at the end of their turns and are freed
// when the fanatic's concentration drops. Casters bench: win 0.83 →
// 0.85, avg rounds 8.72 → 8.54, draws 14 → 13, monster victories 3 → 2,
// fighter death rate 0.43 → 0.41; 4v4 bench unchanged (no conditions).
//
// Re-baselined once in M64 R10 (Extra Attack + Action Surge): the
// Fighter 5 and Paladin 5 now make two attacks per Attack action, Divine
// Smite rides the first hit of each action, and Action Surge is a second
// Attack action (no re-plan, no second move) whether or not the first
// one hit. Casters bench: win 0.85 → 1, avg rounds 8.54 → 5.3, draws
// 13 → 0, monster victories 2 → 0, fighter death rate 0.41 → 0.09,
// fighter damage 43.61 → 61.61. 4v4 bench: win 1 → 1, avg rounds
// 3.25 → 2.94, fighter damage 21.29 → 36.24.
//
// Re-baselined once in M64 R9 (dying): a PC at 0 HP is downed, makes
// death saves at the start of its turn (one more d20 draw each), can be
// healed back up, and takes failures from AoE damage; monsters die at 0.
// The stats gain `deadRate` (status 'dead' at the end; deathRate stays
// "ended at 0 HP"). Casters bench: win 1 → 0.99, avg rounds 5.3 → 5.21,
// draws 0 → 1, cleric death rate 0.84 → 0.8 (dead 0.17); 4v4 bench:
// avg rounds 2.94 → 2.95, fighter dead 0.005.
const GOLDEN_CASTERS = {"iterations": 100, "partyVictories": 99, "monsterVictories": 0, "draws": 1, "victoryRate": 0.99, "avgRounds": 5.21, "entities":  [{"id": "fighter", "name": "fighter", "kind": "pc", "hpMax": 40, "deathRate": 0.06, "deadRate": 0, "avgFinalHp": 32.26, "avgDamageDealt": 61.49},{"id": "wizard", "name": "wizard", "kind": "pc", "hpMax": 40, "deathRate": 0, "deadRate": 0, "avgFinalHp": 35.24, "avgDamageDealt": 57.62},{"id": "cleric", "name": "cleric", "kind": "pc", "hpMax": 40, "deathRate": 0.8, "deadRate": 0.17, "avgFinalHp": 6.44, "avgDamageDealt": 4.46},{"id": "paladin", "name": "paladin", "kind": "pc", "hpMax": 40, "deathRate": 0.06, "deadRate": 0, "avgFinalHp": 29.26, "avgDamageDealt": 64.28},{"id": "fan", "name": "cult-fanatic", "kind": "monster", "hpMax": 40, "deathRate": 1, "deadRate": 1, "avgFinalHp": 0, "avgDamageDealt": 3.69},{"id": "kob", "name": "kobold-sorcerer", "kind": "monster", "hpMax": 40, "deathRate": 0.99, "deadRate": 0.99, "avgFinalHp": 0.23, "avgDamageDealt": 40.46},{"id": "kob2", "name": "kobold-sorcerer", "kind": "monster", "hpMax": 40, "deathRate": 1, "deadRate": 1, "avgFinalHp": 0, "avgDamageDealt": 20.78},{"id": "gob", "name": "goblin", "kind": "monster", "hpMax": 40, "deathRate": 1, "deadRate": 1, "avgFinalHp": 0, "avgDamageDealt": 1.19}]};
const GOLDEN_4V4 = {"iterations": 200, "partyVictories": 200, "monsterVictories": 0, "draws": 0, "victoryRate": 1, "avgRounds": 2.95, "entities":  [{"id": "f", "name": "f", "kind": "pc", "hpMax": 30, "deathRate": 0.015, "deadRate": 0.005, "avgFinalHp": 25.645, "avgDamageDealt": 36.27},{"id": "w", "name": "w", "kind": "pc", "hpMax": 30, "deathRate": 0, "deadRate": 0, "avgFinalHp": 28.46, "avgDamageDealt": 47.175},{"id": "c", "name": "c", "kind": "pc", "hpMax": 30, "deathRate": 0, "deadRate": 0, "avgFinalHp": 27.895, "avgDamageDealt": 9.6},{"id": "r", "name": "r", "kind": "pc", "hpMax": 30, "deathRate": 0.005, "deadRate": 0, "avgFinalHp": 25.815, "avgDamageDealt": 11.97},{"id": "m0", "name": "goblin", "kind": "monster", "hpMax": 20, "deathRate": 1, "deadRate": 1, "avgFinalHp": 0, "avgDamageDealt": 5.735},{"id": "m1", "name": "bandit", "kind": "monster", "hpMax": 20, "deathRate": 1, "deadRate": 1, "avgFinalHp": 0, "avgDamageDealt": 2.885},{"id": "m2", "name": "kobold", "kind": "monster", "hpMax": 20, "deathRate": 1, "deadRate": 1, "avgFinalHp": 0, "avgDamageDealt": 3.025},{"id": "m3", "name": "orc", "kind": "monster", "hpMax": 20, "deathRate": 1, "deadRate": 1, "avgFinalHp": 0, "avgDamageDealt": 3.835}]};

function casterPc(id, col, cls, level, spells, hp = 40) {
  return {
    id, name: id, _position: { col, row: 1 }, hp: { current: hp, max: hp },
    equipment: { mainhand: { name: 'Longsword', damage: '1d8', damageType: 'Slashing' } },
    abilityScores: { STR: 16, DEX: 12, CON: 14, INT: 16, WIS: 14, CHA: 14 },
    abilityModifiers: { STR: 3, DEX: 1, CON: 2, INT: 3, WIS: 2, CHA: 2 },
    classes: [{ name: cls, level }], conditions: [], spells
  };
}

test('M64 N1: simulator stats identical to the pre-gate golden (Shield / Counterspell / MM casters)', async () => {
  const party = [
    casterPc('fighter', 1, 'Fighter', 5, []),
    casterPc('wizard', 2, 'Wizard', 7, ['Shield', 'Magic Missile', 'Counterspell', 'Fire Bolt']),
    casterPc('cleric', 3, 'Cleric', 5, ['Cure Wounds', 'Healing Word', 'Sacred Flame']),
    casterPc('paladin', 4, 'Paladin', 5, [])
  ];
  const mk = (id, slug, col, row) => ({ id, name: slug, presetSlug: slug, hp: { current: 40, max: 40 }, conditions: [], position: { col, row } });
  const monsters = [mk('fan', 'cult-fanatic', 1, 4), mk('kob', 'kobold-sorcerer', 3, 5), mk('kob2', 'kobold-sorcerer', 5, 5), mk('gob', 'goblin', 2, 3)];
  const stats = await simulateEncounter({ party, monsters, scene: { cols: 10, rows: 8 }, iterations: 100, maxRounds: 12, seed: 2024 });
  assert.deepStrictEqual(stats, GOLDEN_CASTERS);
});

test('M64 N1: simulator stats identical to the pre-gate golden (4v4 OA-heavy bench)', async () => {
  const party = ['Fighter', 'Wizard', 'Cleric', 'Rogue'].map((cls, i) => ({
    ...casterPc('fwcr'[i], 1 + i, cls, 5, [{ name: 'Shield' }, { name: 'Magic Missile' }, { name: 'Fireball' }, { name: 'Cure Wounds' }], 30)
  }));
  const monsters = ['goblin', 'bandit', 'kobold', 'orc'].map((slug, i) => ({
    id: 'm' + i, presetSlug: slug, name: slug, hp: { current: 20, max: 20 }, position: { col: 1 + i, row: 4 }, conditions: []
  }));
  const stats = await simulateEncounter({ party, monsters, scene: { cols: 10, rows: 8 }, iterations: 200, maxRounds: 12, seed: 1 });
  assert.deepStrictEqual(stats, GOLDEN_4V4);
});
