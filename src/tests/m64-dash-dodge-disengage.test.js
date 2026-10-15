/**
 * M64 R13 — Dash, Dodge and Disengage take effect.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runOneAttack, dodgeMode } from '../js/scene/combat-engine.js';
import { toEngineSides, applyEngineSides } from '../js/scene/encounter-adapters.js';
import { createRng } from '../js/scene/rng.js';
import { buildPc, buildMonster, buildScene } from './helpers/entities.js';
import { readFileSync } from 'node:fs';
import { parsedDdbFixture } from './helpers/entities.js';

const scene = buildScene({ cols: 20, rows: 7 });

test('R13: Disengage — leaving reach provokes no opportunity attack', async () => {
  const run = async (kind) => {
    const events = [];
    const pc = buildPc({ id: 'pc', _position: { col: 1, row: 1 } });
    const gob = buildMonster({ id: 'gob', position: { col: 2, row: 1 } });
    const far = buildMonster({ id: 'far', position: { col: 12, row: 1 }, hp: 50, hpMax: 50 });
    await runOneAttack(pc, [gob, far], [pc], scene, createRng({ s: 3 }), {
      forcePlan: { kind, targetId: 'far', targetSide: 'enemy', featuresFired: [] }
    }, { emit: (e) => events.push(e) });
    return { events, pc, gob };
  };
  const plain = await run('dash');
  assert.ok(plain.events.some(e => e.type === 'reaction.offered' && e.payload.kind === 'oa'), 'a plain move provokes');
  const dis = await run('disengage');
  assert.ok(!dis.events.some(e => e.type === 'reaction.offered'), 'no OA after Disengage');
  assert.ok(!dis.gob._reactionUsed);
  assert.notDeepEqual(dis.pc._position, { col: 1, row: 1 }, 'it still moved');
});

test('R13: Dash — 60 ft of movement instead of 30', async () => {
  const run = async (kind) => {
    const pc = buildPc({ id: 'pc', _position: { col: 0, row: 3 } });
    const far = buildMonster({ id: 'far', position: { col: 19, row: 3 }, hp: 50, hpMax: 50 });
    await runOneAttack(pc, [far], [pc], scene, createRng({ s: 3 }), {
      forcePlan: { kind, targetId: 'far', targetSide: 'enemy', featuresFired: [] }
    });
    return pc._position.col;
  };
  assert.equal(await run('disengage'), 6, '30 ft = 6 cells');
  assert.equal(await run('dash'), 12, '60 ft = 12 cells');
});

test('R13: Dodge — the next attack against the dodger is at disadvantage, until its next turn', async () => {
  const pc = buildPc({ id: 'pc', _position: { col: 1, row: 1 } });
  const gob = buildMonster({ id: 'gob', position: { col: 2, row: 1 } });
  await runOneAttack(pc, [gob], [pc], scene, createRng({ s: 3 }), {
    forcePlan: { kind: 'dodge', targetId: 'gob', targetSide: 'enemy', featuresFired: [] }
  });
  assert.equal(pc._dodging, true);
  const events = [];
  await runOneAttack(gob, [pc], [gob], scene, createRng({ s: 4 }), {
    forcePlan: { kind: 'attack', targetId: 'pc', targetSide: 'enemy', featuresFired: [] }
  }, { emit: (e) => events.push(e) });
  assert.equal(events.find(e => e.type === 'attack.rolled').payload.advantage, 'disadvantage');
  // The dodger's next turn ends it.
  await runOneAttack(pc, [gob], [pc], scene, createRng({ s: 5 }), {
    forcePlan: { kind: 'attack', targetId: 'gob', targetSide: 'enemy', featuresFired: [] }
  });
  assert.equal(pc._dodging, false);
  assert.equal(dodgeMode('advantage', { _dodging: true, conditions: [] }), 'normal');
  assert.equal(dodgeMode('normal', { _dodging: true, conditions: ['paralyzed'] }), 'normal', 'an incapacitated dodger gets nothing');
});

test('R13: Dodge survives a snapshot (turnFlags.dodging)', () => {
  const state = JSON.parse(readFileSync(new URL('./fixtures/encounters/shield-reaction.state.json', import.meta.url), 'utf8'));
  const sides = toEngineSides(state, { 'wizard-l5': parsedDdbFixture('wizard-l5') });
  sides.byId.get('pc-wizard')._dodging = true;
  const next = applyEngineSides(state, sides.wrappers);
  assert.equal(next.entities['pc-wizard'].turnFlags.dodging, true);
  assert.equal(toEngineSides(next, { 'wizard-l5': parsedDdbFixture('wizard-l5') }).byId.get('pc-wizard')._dodging, true);
});
