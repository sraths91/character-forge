import { test } from 'node:test';
import assert from 'node:assert';
import { enumerateActions, weaponsAvailableFor, gateOk } from '../js/scene/ai/action-options.js';
import { PC_FEATURES, resetPerTurnFlags } from '../js/scene/ai/pc-features.js';
import { profileForPc, PC_PROFILES, DEFAULT_PC_PROFILE } from '../js/scene/ai/pc-profiles.js';
import { choosePcAction } from '../js/scene/ai/pc-action.js';
import { simulateEncounter } from '../js/scene/simulator.js';

// ---------- weaponsAvailableFor ----------

test('M42: weaponsAvailableFor — PC mainhand + offhand-weapon + stowed ranged', () => {
  const pc = {
    kind: 'pc',
    ref: {
      equipment: {
        mainhand: { name: 'Longsword' },
        offhand:  { name: 'Shield' }       // not a weapon
      },
      carried: [
        { name: 'Longbow' },
        { name: 'Healer\'s Kit' }
      ]
    }
  };
  const out = weaponsAvailableFor(pc);
  const names = out.map(w => w.name);
  assert.deepStrictEqual(names, ['Longsword', 'Longbow']);
});

test('M42: weaponsAvailableFor — offhand dagger IS a weapon', () => {
  const pc = {
    kind: 'pc',
    ref: { equipment: { mainhand: { name: 'Shortsword' }, offhand: { name: 'Dagger' } }, carried: [] }
  };
  const out = weaponsAvailableFor(pc);
  assert.deepStrictEqual(out.map(w => w.name), ['Shortsword', 'Dagger']);
});

test('M42: weaponsAvailableFor — monster returns preset attack', () => {
  const monster = { kind: 'monster', attack: { name: 'Scimitar', bonus: 4, dice: '1d6+2' } };
  const out = weaponsAvailableFor(monster);
  assert.strictEqual(out[0].name, 'Scimitar');
});

// ---------- enumerateActions + gates ----------

test('M42: enumerateActions — PC with mainhand emits a melee option', () => {
  const pc = {
    kind: 'pc',
    ref: { equipment: { mainhand: { name: 'Longsword' } }, carried: [] }
  };
  const opts = enumerateActions(pc, {});
  assert.ok(opts.some(o => o.kind === 'melee'));
  assert.ok(opts.some(o => o.kind === 'dash'));
  assert.ok(opts.some(o => o.kind === 'dodge'));
});

test('M42: gateOk — target_in_melee_reach passes when distance ≤ option.range', () => {
  const opt = { range: 5, gates: ['target_in_melee_reach'] };
  assert.strictEqual(gateOk(opt, { distance: 5, hostileAdjacent: false }), true);
  assert.strictEqual(gateOk(opt, { distance: 10, hostileAdjacent: false }), false);
});

test('M42: gateOk — hostile_adjacent gates disengage', () => {
  const opt = { range: 0, gates: ['hostile_adjacent'] };
  assert.strictEqual(gateOk(opt, { distance: 0, hostileAdjacent: true }),  true);
  assert.strictEqual(gateOk(opt, { distance: 0, hostileAdjacent: false }), false);
});

// ---------- PC profiles ----------

test('M42: profileForPc — Fighter → aggressive_attacker', () => {
  assert.strictEqual(
    profileForPc({ classes: [{ name: 'Fighter', level: 5 }] }).archetype,
    'aggressive_attacker'
  );
});

test('M42: profileForPc — Rogue → sneak_attacker', () => {
  assert.strictEqual(
    profileForPc({ classes: [{ name: 'Rogue', level: 3 }] }).archetype,
    'sneak_attacker'
  );
});

test('M42: profileForPc — unknown class falls back to DEFAULT_PC_PROFILE', () => {
  assert.strictEqual(
    profileForPc({ classes: [{ name: 'Artificer', level: 1 }] }),
    DEFAULT_PC_PROFILE
  );
});

test('M42: PC_PROFILES ships archetypes for the core classes', () => {
  for (const cls of ['fighter','rogue','wizard','cleric','paladin','barbarian']) {
    assert.ok(PC_PROFILES[cls], `missing profile: ${cls}`);
  }
});

// ---------- Class features ----------

test('M42: sneak-attack available only for rogues', () => {
  const rogue = { classes: [{ name: 'Rogue', level: 5 }] };
  const fighter = { classes: [{ name: 'Fighter', level: 5 }] };
  assert.strictEqual(PC_FEATURES['sneak-attack'].available(rogue), true);
  assert.strictEqual(PC_FEATURES['sneak-attack'].available(fighter), false);
});

test('M42: sneak-attack respects per-turn flag', () => {
  const rogue = { classes: [{ name: 'Rogue', level: 5 }] };
  assert.strictEqual(PC_FEATURES['sneak-attack'].available(rogue), true);
  rogue._sneakAttackUsedThisTurn = true;
  assert.strictEqual(PC_FEATURES['sneak-attack'].available(rogue), false);
  resetPerTurnFlags(rogue);
  assert.strictEqual(PC_FEATURES['sneak-attack'].available(rogue), true);
});

test('M42: sneak-attack boosts melee finesse vs target with adjacent ally', () => {
  const rogue = { classes: [{ name: 'Rogue', level: 5 }] };
  const target = { id: 't', _position: { col: 5, row: 5 }, conditions: [] };
  const ally = { _position: { col: 5, row: 6 } };   // adjacent to target
  const dagger = { name: 'Dagger' };
  const opt = { kind: 'melee', weapon: dagger };
  const boost = PC_FEATURES['sneak-attack'].scoreBoost(opt, {
    self: { ref: rogue }, target, allies: [ally]
  });
  assert.ok(boost > 0, `expected SA boost > 0, got ${boost}`);
});

test('M42: sneak-attack does NOT boost a greatsword (non-finesse, non-ranged)', () => {
  const rogue = { classes: [{ name: 'Rogue', level: 5 }] };
  const target = { id: 't', _position: { col: 5, row: 5 }, conditions: [] };
  const ally = { _position: { col: 5, row: 6 } };
  const greatsword = { name: 'Greatsword' };
  const opt = { kind: 'melee', weapon: greatsword };
  const boost = PC_FEATURES['sneak-attack'].scoreBoost(opt, {
    self: { ref: rogue }, target, allies: [ally]
  });
  assert.strictEqual(boost, 0);
});

test('M42: action-surge available for fighters lvl 2+', () => {
  assert.strictEqual(PC_FEATURES['action-surge'].available({ classes: [{ name: 'Fighter', level: 1 }] }), false);
  assert.strictEqual(PC_FEATURES['action-surge'].available({ classes: [{ name: 'Fighter', level: 2 }] }), true);
  assert.strictEqual(PC_FEATURES['action-surge'].available({ classes: [{ name: 'Wizard', level: 5 }] }), false);
});

test('M42: action-surge boost fires when target is bloodied OR a caster', () => {
  const fighter = { classes: [{ name: 'Fighter', level: 5 }], _actionSurgeUsed: 0 };
  const bloodied = { id: 't', hp: 5, hpMax: 30, ref: {} };
  const caster   = { id: 'c', hp: 30, hpMax: 30, ref: { spells: { '1': [{ name: 'Magic Missile' }] } } };
  const fresh    = { id: 'f', hp: 30, hpMax: 30, ref: {} };
  const opt = { kind: 'melee' };
  assert.ok(PC_FEATURES['action-surge'].scoreBoost(opt, { self: { ref: fighter }, target: bloodied }) > 0);
  assert.ok(PC_FEATURES['action-surge'].scoreBoost(opt, { self: { ref: fighter }, target: caster })   > 0);
  assert.strictEqual(PC_FEATURES['action-surge'].scoreBoost(opt, { self: { ref: fighter }, target: fresh }), 0);
});

// ---------- choosePcAction integration ----------

const livePc = (id, level, cls, pos, weapon = { name: 'Longsword' }) => ({
  id, name: id, kind: 'pc',
  hp: 30, hpMax: 30, _position: pos,
  weapon, equipment: { mainhand: weapon },
  conditions: [],
  ref: {
    name: id,
    classes: [{ name: cls, level }],
    equipment: { mainhand: weapon },
    carried: [],
    abilityModifiers: { STR: 3, DEX: 2, CON: 2, INT: 0, WIS: 0, CHA: 0 }
  }
});

test('M42: choosePcAction — fighter in melee range picks melee', () => {
  const self = livePc('pc1', 5, 'Fighter', { col: 1, row: 1 });
  const target = { id: 'g1', hp: 7, hpMax: 7, _position: { col: 2, row: 1 }, conditions: [], ref: {} };
  const plan = choosePcAction({ self, enemies: [target], allies: [], rng: () => 0.5 });
  assert.strictEqual(plan.kind, 'melee');
  assert.strictEqual(plan.targetId, 'g1');
});

test('M42: choosePcAction — rogue with adjacent ally + dagger fires sneak-attack', () => {
  const rogue = livePc('rogue1', 5, 'Rogue', { col: 1, row: 1 }, { name: 'Dagger' });
  const target = { id: 'g1', hp: 7, hpMax: 7, _position: { col: 2, row: 1 }, conditions: [], ref: {} };
  // Ally adjacent to target → SA condition
  const ally = { id: 'pc2', hp: 30, hpMax: 30, _position: { col: 2, row: 2 }, ref: {} };
  const plan = choosePcAction({ self: rogue, enemies: [target], allies: [ally], rng: () => 0.5 });
  assert.strictEqual(plan.kind, 'melee');
  assert.ok(plan.featuresFired.includes('sneak-attack'));
});

test('M42: choosePcAction — fighter vs bloodied target picks Action Surge boost', () => {
  const fighter = livePc('f', 5, 'Fighter', { col: 1, row: 1 });
  fighter._actionSurgeUsed = 0;
  const bloodied = { id: 'g1', hp: 2, hpMax: 30, _position: { col: 2, row: 1 }, conditions: [], ref: {} };
  const plan = choosePcAction({ self: fighter, enemies: [bloodied], allies: [], rng: () => 0.5 });
  assert.ok(plan.featuresFired.includes('action-surge'));
});

// ---------- Simulator integration ----------

// ---------- M42.1: Divine Smite + Reckless Attack + Healing Word ----------

test('M42.1: divine-smite — available only when paladin has slots', () => {
  const pal = { classes: [{ name: 'Paladin', level: 5 }], _slots: { 1: 1 } };
  assert.strictEqual(PC_FEATURES['divine-smite'].available(pal), true);
  const exhausted = { classes: [{ name: 'Paladin', level: 5 }], _slots: { 1: 0, 2: 0 } };
  assert.strictEqual(PC_FEATURES['divine-smite'].available(exhausted), false);
  const lowLvl = { classes: [{ name: 'Paladin', level: 1 }], _slots: { 1: 2 } };
  assert.strictEqual(PC_FEATURES['divine-smite'].available(lowLvl), false);
  const fighter = { classes: [{ name: 'Fighter', level: 5 }], _slots: { 1: 2 } };
  assert.strictEqual(PC_FEATURES['divine-smite'].available(fighter), false);
});

test('M42.1: divine-smite — boosts melee against low-HP / caster targets, lighter on grunts', () => {
  const self = { ref: {}, hp: 30, hpMax: 30, _slots: { 1: 2, 2: 1 } };
  const dyingTarget = { hp: 3, hpMax: 30, ref: {} };
  const fullTarget  = { hp: 30, hpMax: 30, ref: {} };
  const dyingBoost = PC_FEATURES['divine-smite'].scoreBoost(
    { kind: 'melee' }, { self, target: dyingTarget }
  );
  const fullBoost = PC_FEATURES['divine-smite'].scoreBoost(
    { kind: 'melee' }, { self, target: fullTarget }
  );
  assert.ok(dyingBoost > fullBoost,
    `smite should value low-HP targets more (dying=${dyingBoost}, full=${fullBoost})`);
});

test('M42.1: divine-smite — consume burns the lowest available slot', () => {
  const pal = { _slots: { 1: 0, 2: 3, 3: 1 } };
  PC_FEATURES['divine-smite'].consume(pal);
  assert.strictEqual(pal._slots[2], 2);
  assert.strictEqual(pal._smiteSlotUsed, 2);
});

test('M42.1: reckless-attack — available for barbarian and consumable once per turn', () => {
  const barb = { classes: [{ name: 'Barbarian', level: 3 }] };
  assert.strictEqual(PC_FEATURES['reckless-attack'].available(barb), true);
  PC_FEATURES['reckless-attack'].consume(barb);
  assert.strictEqual(barb._recklessUsedThisTurn, true);
  assert.strictEqual(barb._recklessUntilNextTurn, true);
  assert.strictEqual(PC_FEATURES['reckless-attack'].available(barb), false);
});

test('M42.1: reckless-attack — only boosts melee, not ranged', () => {
  const barb = { ref: {}, hp: 30, hpMax: 30, classes: [{ name: 'Barbarian', level: 3 }] };
  const target = { hp: 5, hpMax: 20, ref: {} };
  const meleeBoost = PC_FEATURES['reckless-attack'].scoreBoost(
    { kind: 'melee' }, { self: barb, target }
  );
  const rangedBoost = PC_FEATURES['reckless-attack'].scoreBoost(
    { kind: 'ranged' }, { self: barb, target }
  );
  assert.ok(meleeBoost > 0);
  assert.strictEqual(rangedBoost, 0);
});

test('M42.1: simulator — paladin lvl 5 with smite out-damages lvl 1 paladin baseline', () => {
  const paladin = (level) => ({
    id: 'pc1', name: 'P', _position: { col: 1, row: 1 },
    hp: { current: 30, max: 30 },
    equipment: { mainhand: { name: 'Longsword' } },
    abilityScores: { STR: 16, DEX: 12, CON: 14, INT: 10, WIS: 10, CHA: 14 },
    abilityModifiers: { STR: 3, DEX: 1, CON: 2, INT: 0, WIS: 0, CHA: 2 },
    classes: [{ name: 'Paladin', level }],
    conditions: []
  });
  const tankyTarget = () => [{
    id: 't1', presetSlug: 'goblin', name: 'Big Goblin',
    hp: { current: 60, max: 60 }, position: { col: 2, row: 1 }, conditions: []
  }];
  const opts = { scene: { cols: 5, rows: 3 }, iterations: 60, maxRounds: 5, seed: 71 };
  const withSmite = simulateEncounter({ party: [paladin(5)], monsters: tankyTarget(), ...opts });
  const noSmite   = simulateEncounter({ party: [paladin(1)], monsters: tankyTarget(), ...opts });
  const sDmg = withSmite.entities.find(e => e.id === 'pc1').avgDamageDealt;
  const nDmg = noSmite.entities.find(e => e.id === 'pc1').avgDamageDealt;
  assert.ok(sDmg > nDmg,
    `expected smiting paladin > baseline; ${sDmg.toFixed(1)} vs ${nDmg.toFixed(1)}`);
});

test('M42: simulator — fighter PC uses Action Surge to out-damage a non-surging baseline', () => {
  // Same character vs same goblin; "with surge" runs a lvl-5 fighter
  // (has Action Surge); "without" runs lvl-1 (no surge). Expected:
  // surging fighter deals strictly more average damage.
  const fighter = (level) => ({
    id: 'pc1', name: 'F', _position: { col: 1, row: 1 },
    hp: { current: 30, max: 30 },
    equipment: { mainhand: { name: 'Longsword' } },
    abilityScores: { STR: 16, DEX: 12, CON: 14, INT: 10, WIS: 10, CHA: 10 },
    abilityModifiers: { STR: 3, DEX: 1, CON: 2, INT: 0, WIS: 0, CHA: 0 },
    classes: [{ name: 'Fighter', level }],
    conditions: []
  });
  const tankyGoblin = () => [{
    id: 'g1', presetSlug: 'goblin', name: 'Big Goblin',
    hp: { current: 50, max: 50 },
    position: { col: 2, row: 1 }, conditions: []
  }];
  const opts = { scene: { cols: 5, rows: 3 }, iterations: 80, maxRounds: 4, seed: 41 };
  const surger = simulateEncounter({ party: [fighter(5)], monsters: tankyGoblin(), ...opts });
  const rookie = simulateEncounter({ party: [fighter(1)], monsters: tankyGoblin(), ...opts });
  const surgerDmg = surger.entities.find(e => e.id === 'pc1').avgDamageDealt;
  const rookieDmg = rookie.entities.find(e => e.id === 'pc1').avgDamageDealt;
  assert.ok(surgerDmg > rookieDmg,
    `expected lvl-5 fighter (action surge) > lvl-1 (no surge); ${surgerDmg.toFixed(1)} vs ${rookieDmg.toFixed(1)}`);
});
