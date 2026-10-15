/**
 * M64 R2 — PC saves add proficiency + combatMods save scopes; the
 * concentration save uses the same function with the seeded rng.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { saveBonusFor, abilityModFor, applyDamageToEntity } from '../js/scene/combat-engine.js';
import { createRng } from '../js/scene/rng.js';
import { buildPc } from './helpers/entities.js';

function fighter3(extra = {}) {
  return buildPc({
    ref: {
      name: 'F', classes: [{ name: 'Fighter', level: 3 }],
      abilityModifiers: { STR: 3, DEX: 1, CON: 3, INT: 0, WIS: 0, CHA: 0 },
      savingThrowProficiencies: ['STR', 'CON'],
      ...extra
    }
  });
}

const cloak = { kind: 'save', scope: 'all', value: 1, source: 'Cloak of Protection', inactive: false };

test('R2: proficient CON +3 at PB 2 → +5; non-proficient DEX stays the mod', () => {
  const pc = fighter3();
  assert.strictEqual(saveBonusFor(pc, 'CON'), 5);
  assert.strictEqual(saveBonusFor(pc, 'DEX'), 1);
});

test('R2: a Cloak of Protection +1 (save/all) gives +6', () => {
  assert.strictEqual(saveBonusFor(fighter3({ combatMods: [cloak] }), 'CON'), 6);
  const wrapperMods = fighter3(); wrapperMods.combatMods = [cloak];
  assert.strictEqual(saveBonusFor(wrapperMods, 'CON'), 6, 'wrapper combatMods win');
});

test('R2: stat-scoped save mods apply only to their stat; inactive mods never apply', () => {
  const wis = { kind: 'save', scope: 'wis', value: 2, inactive: false };
  const off = { ...cloak, inactive: true };
  const pc = fighter3({ combatMods: [wis, off] });
  assert.strictEqual(saveBonusFor(pc, 'WIS'), 2);
  assert.strictEqual(saveBonusFor(pc, 'CON'), 5);
});

test('R2: abilityModFor ignores proficiency (ability checks)', () => {
  assert.strictEqual(abilityModFor(fighter3(), 'CON'), 3);
});

test('R2: concentration saves use saveBonusFor and are reproducible under a seed', () => {
  const run = () => {
    const pc = fighter3();
    pc._concentrating = { spellId: 'bless', targetIds: [] };
    const rng = createRng({ s: 99 });
    const out = [];
    for (let i = 0; i < 20; i++) {
      pc.hp = 30;
      pc._concentrating = { spellId: 'bless', targetIds: [] };
      applyDamageToEntity(pc, 22, rng);           // DC 11
      out.push(pc._concentrating ? 1 : 0);
    }
    return out;
  };
  const a = run();
  assert.deepStrictEqual(a, run());
  // With +5 vs DC 11 the PC holds on a d20 of 6+ (75%): a +3 bonus would hold 65%.
  const held = a.reduce((x, y) => x + y, 0);
  assert.ok(held >= 10, `held ${held}/20`);
});

test('R2: a d20 of 6 holds concentration at DC 11 only with proficiency (+5)', () => {
  const pc = fighter3();
  pc._concentrating = { spellId: 'bless', targetIds: [] };
  applyDamageToEntity(pc, 22, () => 5 / 20);      // d20 = 6
  assert.ok(pc._concentrating, '6 + 5 = 11 ≥ DC 11');
});
