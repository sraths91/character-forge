import { test } from 'node:test';
import assert from 'node:assert';
import {
  chebyshevFeet, meleeReachFt, inMeleeReach,
  isFlanking, hostileInMeleeOfRangedAttacker, factionLists
} from '../js/scene/grid-rules.js';

// ---------- chebyshevFeet ----------

test('M14: chebyshevFeet — diagonal is one step in 5e square grid', () => {
  assert.strictEqual(chebyshevFeet({ col: 0, row: 0 }, { col: 1, row: 1 }), 5);
  assert.strictEqual(chebyshevFeet({ col: 0, row: 0 }, { col: 5, row: 3 }), 25);
});

// ---------- meleeReachFt ----------

test('M14: meleeReachFt — defaults to 5 ft', () => {
  assert.strictEqual(meleeReachFt(null), 5);
  assert.strictEqual(meleeReachFt({ name: 'Longsword' }), 5);
});

test('M14: meleeReachFt — reach weapons by name get 10 ft', () => {
  assert.strictEqual(meleeReachFt({ name: 'Halberd' }), 10);
  assert.strictEqual(meleeReachFt({ name: 'Glaive' }), 10);
  assert.strictEqual(meleeReachFt({ name: 'Pike' }), 10);
  assert.strictEqual(meleeReachFt({ name: 'Lance' }), 10);
  assert.strictEqual(meleeReachFt({ name: 'Whip' }), 10);
});

test('M14: meleeReachFt — explicit reach property wins over name', () => {
  assert.strictEqual(
    meleeReachFt({ name: 'Mystery Stick', properties: [{ name: 'Reach' }] }),
    10);
});

test('M14: meleeReachFt — numeric weapon.reach (monster preset override) wins', () => {
  assert.strictEqual(meleeReachFt({ name: 'Anything', reach: 15 }), 15);
});

// ---------- inMeleeReach ----------

test('M14: inMeleeReach — at exactly the reach is still inside', () => {
  assert.strictEqual(inMeleeReach({ name: 'Longsword' }, 5), true);
  assert.strictEqual(inMeleeReach({ name: 'Longsword' }, 10), false);
  assert.strictEqual(inMeleeReach({ name: 'Halberd' }, 10), true);
  assert.strictEqual(inMeleeReach({ name: 'Halberd' }, 15), false);
});

// ---------- isFlanking ----------

const TARGET = { col: 5, row: 5 };

test('M14: isFlanking — true when attacker + ally are on opposite sides (cardinal)', () => {
  // Attacker east of target, ally west
  const attackerPos = { col: 6, row: 5 };
  const allies = [{ id: 'ally', name: 'Ally', _position: { col: 4, row: 5 } }];
  const r = isFlanking(attackerPos, TARGET, allies);
  assert.strictEqual(r.flanking, true);
  assert.strictEqual(r.ally.name, 'Ally');
});

test('M14: isFlanking — true on diagonal axis (NW/SE)', () => {
  const attackerPos = { col: 6, row: 6 };
  const allies = [{ id: 'a', name: 'Diag Ally', _position: { col: 4, row: 4 } }];
  assert.strictEqual(isFlanking(attackerPos, TARGET, allies).flanking, true);
});

test('M14: isFlanking — false when ally is adjacent but NOT on opposite side', () => {
  // Attacker east, ally north (not opposite)
  const attackerPos = { col: 6, row: 5 };
  const allies = [{ id: 'a', name: 'Off-axis', _position: { col: 5, row: 4 } }];
  assert.strictEqual(isFlanking(attackerPos, TARGET, allies).flanking, false);
});

test('M14: isFlanking — false when attacker is more than 5ft away', () => {
  const attackerPos = { col: 7, row: 5 };   // 10ft
  const allies = [{ id: 'a', name: 'Ally', _position: { col: 3, row: 5 } }];
  assert.strictEqual(isFlanking(attackerPos, TARGET, allies).flanking, false);
});

test('M14: isFlanking — false when ally is incapacitated', () => {
  const attackerPos = { col: 6, row: 5 };
  const allies = [{ id: 'a', name: 'Stunned Ally', _position: { col: 4, row: 5 }, conditions: ['stunned'] }];
  assert.strictEqual(isFlanking(attackerPos, TARGET, allies).flanking, false);
});

test('M14: isFlanking — false when no allies present', () => {
  const attackerPos = { col: 6, row: 5 };
  assert.strictEqual(isFlanking(attackerPos, TARGET, []).flanking, false);
});

test('M14: isFlanking — uses .position (monster instance shape) when _position absent', () => {
  const attackerPos = { col: 6, row: 5 };
  const allies = [{ id: 'a', name: 'Goblin 2', position: { col: 4, row: 5 } }];
  assert.strictEqual(isFlanking(attackerPos, TARGET, allies).flanking, true);
});

// ---------- hostileInMeleeOfRangedAttacker ----------

test('M14: hostileInMeleeOfRangedAttacker — finds adjacent hostile', () => {
  const attackerPos = { col: 3, row: 3 };
  const hostiles = [
    { id: 'h1', name: 'Far',     _position: { col: 7, row: 7 } },
    { id: 'h2', name: 'Adjacent', _position: { col: 4, row: 3 } }
  ];
  const found = hostileInMeleeOfRangedAttacker(attackerPos, hostiles);
  assert.strictEqual(found.name, 'Adjacent');
});

test('M14: hostileInMeleeOfRangedAttacker — returns null when nobody close', () => {
  const attackerPos = { col: 0, row: 0 };
  const hostiles = [{ id: 'h', _position: { col: 5, row: 5 } }];
  assert.strictEqual(hostileInMeleeOfRangedAttacker(attackerPos, hostiles), null);
});

test('M14: hostileInMeleeOfRangedAttacker — skips incapacitated hostiles', () => {
  const attackerPos = { col: 3, row: 3 };
  const hostiles = [{ id: 'h', _position: { col: 4, row: 3 }, conditions: ['unconscious'] }];
  assert.strictEqual(hostileInMeleeOfRangedAttacker(attackerPos, hostiles), null);
});

// ---------- factionLists ----------

test('M14: factionLists — PC attacker: allies are other PCs, hostiles are monsters', () => {
  const party = [{ id: 'p1', name: 'Saris' }, { id: 'p2', name: 'Adrin' }];
  const monsters = [{ id: 'm1', name: 'Goblin' }];
  const { allies, hostiles } = factionLists({
    attackerKind: 'pc', attackerId: 'p1', party, monsters
  });
  assert.deepStrictEqual(allies.map(a => a.name), ['Adrin']);
  assert.deepStrictEqual(hostiles.map(h => h.name), ['Goblin']);
});

test('M14: factionLists — monster attacker: allies are other monsters, hostiles are PCs', () => {
  const party = [{ id: 'p1', name: 'Saris' }];
  const monsters = [{ id: 'm1', name: 'Goblin' }, { id: 'm2', name: 'Orc' }];
  const { allies, hostiles } = factionLists({
    attackerKind: 'monster', attackerId: 'm1', party, monsters
  });
  assert.deepStrictEqual(allies.map(a => a.name), ['Orc']);
  assert.deepStrictEqual(hostiles.map(h => h.name), ['Saris']);
});
