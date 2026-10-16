/**
 * M64 C11 — "DM adjudicates" spells outside the 11-entry engine registry.
 * Gate: a real fixture caster's off-registry spells (the parsed cleric's
 * Bless and Spirit Guardians; the wizard's Shield and Fireball) are
 * refused by client-side validation as `unknown-spell` and become
 * castable through `dm.spell.adjudicate`: the DM-panel form builds a
 * contract-valid intent and the (fake) server's result reaches the
 * players as ordinary events.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseCharacter } from '../../api/lib/ddb-parser.js';
import { adjudicableSpells, adjudicationPayload, mount as mountDmPanel, createDmBridge } from '../js/client/views/dm-panel.js';
import { castIntent } from '../js/client/intents.js';
import { validateClientMessage, INTENT_ROLES, PROTOCOL_MINOR } from '../js/shared/protocol.js';
import { createFakeServer, demoCharacter } from '../js/client/fake-transport.js';
import { createApi } from '../js/client/api.js';
import { createSession } from '../js/client/session.js';
import { createStore } from '../js/client/store.js';
import { createFakeDom } from './helpers/fake-dom.js';
import { projectedState, snapshotMsg, manualTimers, flush } from './helpers/client-fixtures.js';

const ddb = (f) => {
  const raw = JSON.parse(readFileSync(new URL(`./fixtures/ddb/${f}.json`, import.meta.url), 'utf8'));
  return parseCharacter(raw.data || raw);
};
const wire = (intent) => ({ v: 1, cid: '01J00000000000000000000000', ...intent });

test('C11: dm.spell.adjudicate is a DM-only v1.3 intent', () => {
  assert.equal(INTENT_ROLES['dm.spell.adjudicate'], 'dm');
  assert.ok(PROTOCOL_MINOR >= 3);
  const bad = validateClientMessage(wire({ t: 'dm.spell.adjudicate', p: { casterId: 'a', spellId: 'bless', targets: [] } }));
  assert.equal(bad.ok, false, 'at least one target');
  const extra = validateClientMessage(wire({ t: 'dm.spell.adjudicate', p: { casterId: 'a', spellId: 'bless', targets: [{ entityId: 'b', hp: 3 }] } }));
  assert.equal(extra.ok, false, 'strict target fields');
});

test('C11: every off-registry spell of the fixture casters is castable through adjudication', () => {
  const cleric = ddb('cleric-l5');
  const wizard = ddb('wizard-l5');
  const state = projectedState();
  state.turnIndex = 1;   // pc-wizard's turn
  let checked = 0;
  for (const [sheet, actorId] of [[cleric, 'pc-wizard'], [wizard, 'pc-wizard']]) {
    const spells = adjudicableSpells(sheet);
    assert.ok(spells.length >= 2, `${sheet.name} has off-registry spells`);
    for (const sp of spells) {
      const sheets = { 'wizard-l5': { ...sheet, spells: sheet.spells } };
      const refused = castIntent(state, { actorId, turnId: 't1', spellId: sp.id, targetId: 'm-goblin', sheets });
      assert.equal(refused.ok, false);
      assert.equal(refused.code, 'unknown-spell', `${sp.name} needs the DM`);
      const p = adjudicationPayload({ casterId: actorId, spellId: sp.name, slotLevel: sp.level || '', targets: [{ entityId: 'm-goblin', damage: '7', type: 'radiant', condition: '' }] });
      assert.deepEqual(validateClientMessage(wire({ t: 'dm.spell.adjudicate', p })).errors, [], sp.name);
      checked++;
    }
  }
  assert.ok(checked >= 4);
  assert.deepEqual(adjudicableSpells(ddb('cleric-l5')).map(s => s.name), ['Bless', 'Misty Step', 'Spirit Guardians']);
});

test('C11: the DM-panel form sends the adjudication; the server result reaches the table', async () => {
  const timers = manualTimers();
  const server = createFakeServer({ characters: [], timers, seed: 3 });
  const created = await createApi({ fetch: server.fetch }).createRoom();
  const dm = createSession({ url: 'ws://fake/ws', token: created.dmToken, WebSocketCtor: server.WebSocket, wsOptions: { timers } });
  await dm.connect();
  const join = await createApi({ fetch: server.fetch }).joinRoom(created.code, 'Robin');
  const player = createSession({ url: 'ws://fake/ws', token: join.token, WebSocketCtor: server.WebSocket, wsOptions: { timers } });
  await player.connect();
  const cleric = { ...demoCharacter('c-saris', 'Saris', { cls: 'Cleric', spellSlots: { 1: 4, 2: 3, 3: 2 } }), spells: ddb('cleric-l5').spells };
  const imp = await createApi({ fetch: server.fetch, token: () => join.token }).importCharacter(created.roomId, { json: cleric });
  await player.send({ t: 'seat.claim', p: { characterId: imp.character.id } });
  await dm.send({ t: 'dm.encounter.setup', p: { map: null, grid: { cols: 8, rows: 6 }, monsters: [{ id: 'm-1', slug: 'goblin', name: 'Goblin', hp: 20 }], placements: {} } });
  for (let i = 0; i < 20 && !player.store.getState().encounter; i++) await flush(2);

  // Mount the DM panel on the DM's store and fill the form.
  const dom = createFakeDom();
  const root = dom.root();
  const un = mountDmPanel(root, { store: dm.store, send: (i) => dm.send(i), dmBridge: createDmBridge(), sheets: () => ({ [imp.character.id]: cleric }), deps: { timers } });
  const caster = root.querySelector('[data-action="adj-caster"]');
  caster.value = 'pc-1';
  dom.fire(caster, 'change');
  assert.match(dom.byText(root, 'Off-registry spells on this sheet')[0].textContent, /Bless, Misty Step, Spirit Guardians/);
  dom.findAll(root, n => n.attrs?.get('aria-label') === 'Spell')[0].value = 'Spirit Guardians';
  dom.findAll(root, n => n.attrs?.get('aria-label') === 'Slot level')[0].value = '3';
  const row = root.querySelector('[data-adj-row="1"]');
  row.querySelector('[data-field="adj-target"]').value = 'm-1';
  row.querySelector('[data-field="adj-damage"]').value = '9';
  row.querySelector('[data-field="adj-type"]').value = 'radiant';
  row.querySelector('[data-field="adj-condition"]').value = 'frightened';
  dom.byAction(root, 'adj-cast')[0].click();
  for (let i = 0; i < 30 && !player.store.getState().history.some(e => e.type === 'dm.override'); i++) await flush(2);

  const hist = player.store.getState().history;
  const cast = hist.find(e => e.type === 'spell.cast');
  assert.deepEqual([cast.payload.spellId, cast.payload.castAtLevel, cast.payload.adjudicated], ['spirit-guardians', 3, true]);
  assert.equal(hist.find(e => e.type === 'damage').payload.hpAfter, 11);
  assert.equal(hist.find(e => e.type === 'condition.applied').payload.condition, 'frightened');
  assert.equal(player.store.getState().encounter.entities['m-1'].hp, 11);
  assert.deepEqual(player.store.getState().encounter.entities['m-1'].conditions, ['frightened']);
  assert.equal(server.invalid.length, 0);
  un();
  assert.equal(dom.activeListeners(), 0);
  dm.close();
  player.close();
});

test('C11: adjudicationPayload drops empty rows and clamps numbers', () => {
  assert.equal(adjudicationPayload({ casterId: 'a', spellId: 'Bless', targets: [{ entityId: '' }] }), null);
  const p = adjudicationPayload({ casterId: 'a', spellId: "Tasha's Hideous Laughter", slotLevel: '12', targets: [{ entityId: 'b', damage: '5000', healed: '0', condition: 'prone' }] });
  assert.deepEqual(p, { casterId: 'a', spellId: 'tashas-hideous-laughter', targets: [{ entityId: 'b', damage: 999, type: null, conditions: ['prone'] }] });
  const store = createStore({ hashState: null });
  store.apply(snapshotMsg(1, projectedState()));
  assert.ok(store.getState().encounter);
});
