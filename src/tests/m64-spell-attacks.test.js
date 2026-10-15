/**
 * M64 R12 — spell attacks go through resolveAttack.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runMonsterSpell } from '../js/scene/combat-engine.js';
import { buildPc, buildMonster } from './helpers/entities.js';

async function cast(spellId, { conditions = [], targetPos, hostiles = [], casterConditions = [] } = {}) {
  const events = [];
  const caster = buildMonster({ id: 'cf', presetSlug: 'cult-fanatic', _slots: { 1: 4, 2: 3 }, position: { col: 2, row: 2 }, conditions: casterConditions });
  const target = buildPc({ id: 'pc1', hp: 200, hpMax: 200, ac: 10, conditions, _position: targetPos });
  await runMonsterSpell({
    attacker: caster, target, plan: { spellId, castAtLevel: spellId === 'fire-bolt' ? 0 : 1 },
    scene: { cols: 10, rows: 7 }, rng: () => 0.5, allEnemies: [target, ...hostiles], allies: [caster], ctx: { emit: (e) => events.push(e) }
  });
  return events.find(e => e.type === 'attack.rolled')?.payload;
}

test('R12: a prone target gives a ranged spell attack disadvantage', async () => {
  const a = await cast('fire-bolt', { conditions: ['prone'], targetPos: { col: 8, row: 2 } });
  assert.equal(a.advantage, 'disadvantage');
  assert.equal(a.d20.length, 2);
});

test('R12: Inflict Wounds while adjacent is a melee spell attack (no disadvantage; prone → advantage)', async () => {
  const adj = await cast('inflict-wounds', { targetPos: { col: 3, row: 2 } });
  assert.equal(adj.advantage, 'normal', 'no ranged-in-melee disadvantage');
  const prone = await cast('inflict-wounds', { conditions: ['prone'], targetPos: { col: 3, row: 2 } });
  assert.equal(prone.advantage, 'advantage');
});

test('R12: a ranged spell attack next to a hostile is at disadvantage; a paralyzed target in reach is auto-crit', async () => {
  const a = await cast('fire-bolt', { targetPos: { col: 3, row: 2 } });
  assert.equal(a.advantage, 'disadvantage');
  const crit = await cast('inflict-wounds', { conditions: ['paralyzed'], targetPos: { col: 3, row: 2 } });
  assert.equal(crit.crit, true);
});
