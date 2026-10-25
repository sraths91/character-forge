/**
 * M65 1.5 leftover B — the room's diagonal rule reaches every path call
 * the client makes (previews, reach overlay, move intents) and the DM's
 * room-settings card offers '5ft' and '5-10'.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { previewMove, moveIntent, reachableFor, diagonalRuleOf } from '../js/client/intents.js';
import { settingsPatch, DIAGONAL_RULE_OPTIONS, mount as mountSettings } from '../js/client/views/room-settings.js';
import { createStore } from '../js/client/store.js';
import { validateClientMessage } from '../js/shared/protocol.js';
import { createFakeDom } from './helpers/fake-dom.js';
import { projectedState, snapshotMsg, flush } from './helpers/client-fixtures.js';

const SHEETS = { 'wizard-l5': { equipment: { mainhand: { name: 'Quarterstaff', damage: '1d6', damageType: 'bludgeoning' } }, spells: [] } };

test('diagonalRuleOf: the room setting, normalised; unknown or absent → 5ft', () => {
  assert.equal(diagonalRuleOf({ room: { settings: { diagonalRule: '5-10' } } }), '5-10');
  assert.equal(diagonalRuleOf({ room: { settings: { diagonalRule: '5-10-5' } } }), '5-10');
  assert.equal(diagonalRuleOf({ room: { settings: {} } }), '5ft');
  assert.equal(diagonalRuleOf(null), '5ft');
});

test('previewMove: two diagonal steps cost 10 ft under 5ft and 15 ft under 5-10', () => {
  const s = projectedState();   // pc-wizard at (1,5); grid 12 × 8
  const dest = { col: 3, row: 7 };
  const phb = previewMove(s, 'pc-wizard', dest);
  const dmg = previewMove(s, 'pc-wizard', dest, { diagonalRule: '5-10' });
  assert.equal(phb.legal, true);
  assert.equal(phb.costFt, 10);
  assert.equal(dmg.legal, true);
  assert.equal(dmg.costFt, 15);
});

test('moveIntent: a diagonal dash legal under 5ft is over budget under 5-10 and builds no intent', () => {
  const s = projectedState();
  const args = { actorId: 'pc-wizard', turnId: 't1', dest: { col: 5, row: 7 }, budgetFt: 20, sheets: SHEETS };
  const phb = previewMove(s, 'pc-wizard', args.dest, { budgetFt: 20 });
  assert.equal(phb.legal, true, phb.reason);
  const dmg = moveIntent(s, { ...args, diagonalRule: '5-10' });
  assert.equal(dmg.ok, false);
  assert.equal(dmg.intent, null);
  assert.equal(dmg.preview.reason, 'over-budget');
});

test('reachableFor: the 5-10 reach overlay is a strict subset of the 5ft one', () => {
  const s = projectedState();
  const key = (c) => `${c.col},${c.row}`;
  const phb = new Set(reachableFor(s, 'pc-wizard').map(key));
  const dmg = new Set(reachableFor(s, 'pc-wizard', { diagonalRule: '5-10' }).map(key));
  assert.ok(dmg.size < phb.size);
  for (const k of dmg) assert.ok(phb.has(k), `${k} reachable under 5-10 but not 5ft`);
});

test('settingsPatch: diagonalRule changes only when it differs; the options are the protocol rules', () => {
  assert.deepEqual(DIAGONAL_RULE_OPTIONS.map(o => o.value), ['5ft', '5-10']);
  const cur = { reactionTimeoutMs: 20000, importLiveState: false, fudgeVisibility: 'public', diagonalRule: '5ft' };
  assert.deepEqual(settingsPatch(cur, { seconds: 20, importLiveState: false, fudgeVisibility: 'public', diagonalRule: '5-10' }).payload, { diagonalRule: '5-10' });
  assert.equal(settingsPatch(cur, { seconds: 20, importLiveState: false, fudgeVisibility: 'public', diagonalRule: '5ft' }).ok, false);
  assert.equal(settingsPatch(cur, { seconds: 20, importLiveState: false, fudgeVisibility: 'public', diagonalRule: 'hex' }).ok, false);
});

test('room settings card: offers both rules and sends dm.room.settings {diagonalRule}', async () => {
  const dom = createFakeDom();
  const root = dom.root();
  const store = createStore({ hashState: null });
  store.apply({ v: 1, t: 'hello.ok', ts: 1, p: { memberId: 'mem_dm', role: 'dm', seats: [], serverNow: 1, cfg: {} } });
  store.apply(snapshotMsg(10, null, { code: 'ABC123', status: 'lobby', settings: { diagonalRule: '5ft' }, members: [], seats: [] }));
  const sent = [];
  const un = mountSettings(root, { store, send: async (i) => { assert.equal(validateClientMessage({ v: 1, cid: '01J00000000000000000000000', ...i }).ok, true); sent.push(i); return { ok: true }; } });
  const sel = root.querySelector('[data-field="diagonal"]');
  assert.deepEqual(sel.children.map(o => o.value), ['5ft', '5-10']);
  assert.equal(sel.value, '5ft');
  sel.value = '5-10';
  dom.byAction(root, 'settings-save')[0].click();
  await flush();
  assert.deepEqual(sent, [{ t: 'dm.room.settings', p: { diagonalRule: '5-10' } }]);
  store.apply({ v: 1, t: 'room.settings', seq: 11, ts: 1, p: { settings: { reactionTimeoutMs: 20000, importLiveState: false, fudgeVisibility: 'public', diagonalRule: '5-10' } } });
  assert.equal(sel.value, '5-10');
  assert.equal(diagonalRuleOf(store.getState()), '5-10');
  un();
  assert.equal(dom.activeListeners(), 0);
});
