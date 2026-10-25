// M65 R29 — exhaustion levels 1–6: one test per level, plus the helpers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_EXHAUSTION, clampExhaustion, exhaustionLevelOf, exhaustionEffects, exhaustedHpMax,
  exhaustedSpeed, effectiveHpMax, applyExhaustionToEntity
} from '../js/campaign/exhaustion.js';
import { resolveAttack } from '../js/scene/combat-resolver.js';
import { entityFromSheet, wrapperFromEntity } from '../js/scene/encounter-adapters.js';
import { initialRunState } from '../js/shared/run-state.js';
import { parsedDdbFixture } from './helpers/entities.js';

const seed = () => entityFromSheet(parsedDdbFixture('fighter-l5'), { pos: { col: 1, row: 1 } });

function attackWith(attacker) {
  return resolveAttack({
    attacker, target: { id: 'm', name: 'Goblin', position: { col: 2, row: 1 }, conditions: [] },
    weapon: { name: 'Longsword', damage: '1d8' }, scene: { positions: {} },
    attackerKind: 'pc', targetKind: 'monster', targetAC: 13,
    attackStats: { bonus: 5, dice: '1d8+3', damageType: 'Slashing', parts: [], damageParts: [] }
  });
}

test('exhaustion 0: no effect; seeding returns an equal entity', () => {
  const e = seed();
  assert.deepEqual(applyExhaustionToEntity(e, 0), e);
  assert.equal(attackWith({ ...e, _position: { col: 1, row: 1 } }).d20.mode, 'normal');
  assert.deepEqual(exhaustionEffects(0), { level: 0, checkDisadvantage: false, speedMultiplier: 1, attackDisadvantage: false, saveDisadvantage: false, hpMaxMultiplier: 1, dead: false });
});

test('exhaustion 1: disadvantage on ability checks only', () => {
  const fx = exhaustionEffects(1);
  assert.equal(fx.checkDisadvantage, true);
  assert.equal(fx.attackDisadvantage, false);
  const e = applyExhaustionToEntity(seed(), 1);
  assert.equal(e.exhaustion, 1);
  assert.equal(e.speedFt, 30);
  assert.equal(e.hpMax, 44);
  assert.equal(attackWith({ ...e, _position: { col: 1, row: 1 } }).d20.mode, 'normal');
});

test('exhaustion 2: speed halved', () => {
  const e = applyExhaustionToEntity(seed(), 2);
  assert.equal(e.speedFt, 15);
  assert.equal(e.hpMax, 44);
  assert.equal(exhaustedSpeed(25, 2), 12, 'rounded down');
});

test('exhaustion 3: disadvantage on attack rolls (combat-resolver) and saves', () => {
  const e = applyExhaustionToEntity(seed(), 3);
  assert.equal(e.speedFt, 15);
  const r = attackWith({ ...e, _position: { col: 1, row: 1 } });
  assert.equal(r.d20.mode, 'disadvantage');
  assert.ok(r.d20.disadvantage.includes('Attacker exhausted (level 3)'));
  assert.equal(exhaustionEffects(3).saveDisadvantage, true);
  // Also read from a condition object, and cancelled by advantage as usual.
  const viaCondition = { id: 'p', conditions: [{ id: 'exhaustion', level: 4 }, 'invisible'], _position: { col: 1, row: 1 } };
  assert.equal(attackWith(viaCondition).d20.mode, 'normal');
});

test('exhaustion 3 end to end: run state → entity → engine wrapper → resolver disadvantage', () => {
  const sheet = parsedDdbFixture('fighter-l5');
  const entity = entityFromSheet(sheet, { pos: { col: 1, row: 1 }, runState: { ...initialRunState(sheet), exhaustion: 3 } });
  const w = wrapperFromEntity(entity, sheet);
  assert.equal(exhaustionLevelOf(w), 3);
  assert.equal(attackWith({ ...w, _position: { col: 1, row: 1 } }).d20.mode, 'disadvantage');
  // The engine's seeding and applyExhaustionToEntity agree on speed and HP max.
  for (const lv of [2, 4, 5, 6]) {
    const seeded = entityFromSheet(sheet, { pos: { col: 1, row: 1 }, runState: { ...initialRunState(sheet), exhaustion: lv } });
    const mine = applyExhaustionToEntity(seed(), lv);
    assert.deepEqual([seeded.speedFt, seeded.hpMax, seeded.status], [mine.speedFt, mine.hpMax, mine.status], `level ${lv}`);
  }
});

test('exhaustion 4: HP maximum halved (hp clamped)', () => {
  const e = applyExhaustionToEntity(seed(), 4);
  assert.equal(e.hpMax, 22);
  assert.equal(e.hp, 22);
  assert.equal(e.speedFt, 15);
  assert.equal(exhaustedHpMax(45, 4), 22);
  assert.equal(exhaustedHpMax(1, 4), 1, 'never below 1');
  assert.equal(effectiveHpMax({ hp: { max: 38 } }, { exhaustion: 4 }), 19);
  assert.equal(effectiveHpMax({ hp: { max: 38 } }, { exhaustion: 3 }), 38);
});

test('exhaustion 5: speed 0', () => {
  const e = applyExhaustionToEntity(seed(), 5);
  assert.equal(e.speedFt, 0);
  assert.equal(e.hpMax, 22);
  assert.equal(e.status, undefined);
});

test('exhaustion 6: death at seeding', () => {
  const e = applyExhaustionToEntity(seed(), 6);
  assert.equal(e.status, 'dead');
  assert.equal(e.hp, 0);
  assert.deepEqual(e.deathSaves, { successes: 0, failures: 3, stable: false });
  assert.equal(exhaustionEffects(6).dead, true);
  // A monster has no death saves.
  const m = applyExhaustionToEntity({ id: 'm', kind: 'monster', hp: 7, hpMax: 7, speedFt: 30 }, 6);
  assert.equal(m.deathSaves, undefined);
  assert.equal(m.status, 'dead');
});

test('exhaustion helpers: clamp and level lookup; input never mutated', () => {
  assert.equal(MAX_EXHAUSTION, 6);
  assert.equal(clampExhaustion(9), 6);
  assert.equal(clampExhaustion(-1), 0);
  assert.equal(clampExhaustion('2'), 2);
  assert.equal(exhaustionLevelOf({ exhaustion: 2 }), 2);
  assert.equal(exhaustionLevelOf({ conditions: ['exhaustion'] }), 1);
  assert.equal(exhaustionLevelOf({ conditions: [{ id: 'exhaustion', level: 5 }] }), 5);
  assert.equal(exhaustionLevelOf({ ddbConditions: [{ id: 'exhaustion', level: 3 }] }), 0, 'DDB state only via the run');
  assert.equal(exhaustionLevelOf(null), 0);
  const e = seed();
  const snapshot = JSON.stringify(e);
  applyExhaustionToEntity(e, 4);
  assert.equal(JSON.stringify(e), snapshot);
});
