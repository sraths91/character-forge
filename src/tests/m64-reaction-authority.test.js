/**
 * M64 phase 1.5 (E1 ↔ E3 agreement) — the engine's re-checked
 * eligibility is authoritative: `reaction.resolved.used` comes from the
 * engine after the await, never from the prompt's raw answer. The room
 * should forward the engine's event and drop its own copy.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runOneAttack } from '../js/scene/combat-engine.js';
import { createRng } from '../js/scene/rng.js';
import { validateEvent } from '../js/shared/events.js';
import { buildPc, buildMonster, buildScene } from './helpers/entities.js';

function collect() {
  const events = [];
  return { events, ctx: { emit: (ev) => events.push({ seq: events.length + 1, round: 1, turnId: 't', ...ev }), turnId: 't' } };
}

test('reaction authority: a "yes" whose eligibility is lost during the await resolves used:false (Shield)', async () => {
  const wiz = buildPc({
    id: 'w', ac: 12, hp: 40, hpMax: 40, _slots: { 1: 1 }, _reactionUsed: false, _position: { col: 1, row: 1 },
    ref: { ...buildPc().ref, classes: [{ name: 'Wizard', level: 5 }], spells: ['Shield'] }
  });
  const orc = buildMonster({ id: 'o', attack: { name: 'Greataxe', bonus: 5, dice: '1d12+3' }, position: { col: 2, row: 1 } });
  const { events, ctx } = collect();
  let offered = 0;
  // rng 0.5 → d20 11 + 5 = 16 vs AC 12: a hit that Shield (+5) would turn.
  await runOneAttack(orc, [wiz], [orc], buildScene(), () => 0.5, {
    forcePlan: { kind: 'attack', targetId: 'w' },
    onShieldReaction: async () => {
      offered++;
      wiz._slots[1] = 0;          // the slot is gone while the prompt was open
      return { answer: true, by: 'player' };
    }
  }, ctx);
  assert.equal(offered, 1);
  const resolved = events.find(e => e.type === 'reaction.resolved');
  assert.deepEqual(resolved.payload, { reactorId: 'w', kind: 'shield', used: false, by: 'player' });
  assert.ok(!events.some(e => e.type === 'resource.spent' && e.payload.entityId === 'w'));
  assert.equal(events.find(e => e.type === 'attack.rolled').payload.shielded, false);
  for (const e of events) assert.ok(validateEvent(e).ok, e.type);
});

test('reaction authority: an OA "yes" from a creature whose reaction is spent resolves used:false', async () => {
  const pc = buildPc({ id: 'p', _position: { col: 1, row: 1 }, hp: 40, hpMax: 40 });
  const gob = buildMonster({ id: 'g', position: { col: 2, row: 1 }, _reactionUsed: false });
  const { events, ctx } = collect();
  await runOneAttack(pc, [gob], [pc], buildScene(), createRng({ s: 2 }), {
    forcePlan: { kind: 'move', targetId: null, moveTo: { col: 1, row: 4 } },
    onReactionAttack: async ({ triggerer }) => {
      triggerer._reactionUsed = true;   // spent elsewhere during the await
      return { answer: true, by: 'dm' };
    }
  }, { ...ctx });
  const resolved = events.find(e => e.type === 'reaction.resolved');
  assert.deepEqual(resolved.payload, { reactorId: 'g', kind: 'oa', used: false, by: 'dm' });
  assert.ok(!events.some(e => e.type === 'attack.rolled'), 'no opportunity attack');
  assert.equal(events.filter(e => e.type === 'reaction.offered').length, events.filter(e => e.type === 'reaction.resolved').length);
});
