/**
 * M64 phase 1.5 (E2 task 2) — dying-state selectors and fight-log lines.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { statusBadge, deathSaveInfo } from '../js/client/selectors.js';
import { formatEvent } from '../js/client/log-format.js';
import { projectedState } from './helpers/client-fixtures.js';

const ev = (seq, type, payload) => ({ seq, type, round: 2, turnId: 't', cinemaGroup: null, payload });
const names = { 'pc-wizard': 'Ilsa', 'pc-fighter': 'Bram', 'm-goblin': 'Goblin' };
const nameOf = (id) => names[id] || String(id);

test('statusBadge: Dying / Stable / Dead from status, Down from HP alone, null while standing', () => {
  assert.equal(statusBadge({ hp: 5 }), null);
  assert.equal(statusBadge({ hp: 0 }).label, 'Down');
  assert.deepEqual(statusBadge({ hp: 0, status: 'downed' }), { status: 'downed', label: 'Dying', short: 'DYING', cls: 'is-dying' });
  assert.equal(statusBadge({ hp: 0, status: 'stable' }).short, 'STABLE');
  assert.equal(statusBadge({ hp: 0, status: 'dead' }).cls, 'is-dead');
});

test('deathSaveInfo: tally plus the latest save, and whether it was this turn', () => {
  const enc = projectedState();
  enc.entities['pc-wizard'] = { ...enc.entities['pc-wizard'], hp: 0, status: 'downed', deathSaves: { successes: 1, failures: 2, stable: false } };
  const save = ev(20, 'death.save', { entityId: 'pc-wizard', d20: 12, success: true, crit: false, successes: 1, failures: 2, cause: 'roll' });
  let info = deathSaveInfo({ encounter: enc, history: [save, ev(21, 'turn.skipped', { actorId: 'pc-wizard', reason: 'down' })] }, 'pc-wizard');
  assert.deepEqual([info.status, info.successes, info.failures, info.last.d20, info.last.thisTurn], ['downed', 1, 2, 12, true]);
  info = deathSaveInfo({ encounter: enc, history: [save, ev(22, 'turn.started', { actorId: 'm-goblin' })] }, 'pc-wizard');
  assert.equal(info.last.thisTurn, false, 'a later creature\'s turn ends "this turn"');
  assert.equal(deathSaveInfo({ encounter: enc, history: [] }, 'pc-fighter'), null, 'standing');
  assert.equal(deathSaveInfo({ encounter: enc, history: [] }, 'nobody'), null);
});

test('formatEvent: one log line per death event', () => {
  const line = (type, payload) => formatEvent(ev(1, type, payload), nameOf).text;
  assert.equal(line('death.save', { entityId: 'pc-wizard', d20: 4, success: false, crit: false, successes: 1, failures: 2, cause: 'roll' }), 'Ilsa death save: d20=4 — failure (1 ✓ / 2 ✗).');
  assert.match(line('death.save', { entityId: 'pc-wizard', d20: 20, success: true, crit: true, successes: 0, failures: 0, cause: 'roll' }), /NATURAL 20/);
  assert.match(line('death.save', { entityId: 'pc-wizard', d20: null, success: false, crit: true, successes: 0, failures: 2, cause: 'damage' }), /hit while dying — two failed/);
  assert.equal(line('entity.stabilized', { entityId: 'pc-wizard' }), 'Ilsa is stable.');
  assert.equal(line('entity.revived', { entityId: 'pc-wizard', hp: 6, byId: 'pc-fighter' }), 'Ilsa is back up (6 HP) — thanks to Bram.');
  assert.equal(line('entity.died', { entityId: 'm-goblin', byId: 'pc-fighter', cause: 'monster' }), 'Goblin dies.');
  assert.equal(line('entity.died', { entityId: 'pc-wizard', byId: null, cause: 'failures' }), 'Ilsa dies (three failed death saves).');
});
