/**
 * M65 C26 — the shop and story node screens (views/shop.js, views/story.js),
 * mounted through the between hub against the REAL server in-process.
 *
 *   - pure: shopRows (DM price, else priceOf the SRD record; "0.00" is
 *     unpriced; stock minus this visit's purchases), sellPriceCp,
 *     nameFromRef, storyModel;
 *   - shop: buy with an SRD price, an unpriced row has no Buy, sell back at
 *     half, and the GATE — buying past the purse and the stash is refused
 *     with a readable reason from the `insufficient-funds` code;
 *   - story: players choose, the DM settles, the run map offers the edge.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { shopRows, sellPriceCp, nameFromRef } from '../js/client/views/shop.js';
import { storyModel } from '../js/client/views/story.js';
import { mount as mountBetween } from '../js/client/views/between.js';
import { createFakeDom } from './helpers/fake-dom.js';
import { flush } from './helpers/client-fixtures.js';
import { bootRunTable, until } from './helpers/run-table.js';

const ROOT = mkdtempSync(join(tmpdir(), 'cf-c26-'));
after(() => rmSync(ROOT, { recursive: true, force: true }));

test('C26 pure: shop rows, sell prices, names, the story model', () => {
  const node = { payload: { stock: [{ ref: 'srd_potion-of-healing', qty: 3 }, { ref: 'srd_lantern', qty: 1 }, { ref: 'srd_plate', qty: 1, price: { gp: 1500 } }] } };
  const rows = shopRows(node, { 'srd_potion-of-healing': 2 }, { 'srd_potion-of-healing': { name: 'Potion of Healing', cost: '50.00' }, srd_lantern: { name: 'Lantern', cost: '0.00' } });
  assert.deepEqual(rows, [
    { ref: 'srd_potion-of-healing', name: 'Potion of Healing', left: 1, unitCp: 5000 },
    { ref: 'srd_lantern', name: 'Lantern', left: 1, unitCp: null },
    { ref: 'srd_plate', name: 'Plate', left: 1, unitCp: 150000 }
  ]);
  assert.equal(shopRows(node, {}, {})[0].unitCp, null, 'no record yet: unpriced until it loads');
  assert.equal(sellPriceCp({ data: { cost: 50 } }), 2500);
  assert.equal(sellPriceCp({ data: { cost: 50 } }, 0.25), 1250);
  assert.equal(sellPriceCp({ data: {} }), null);
  assert.equal(nameFromRef('srd_potion-of-healing'), 'Potion of healing');
  const m = storyModel({ payload: { text: 'Two roads.', choices: [{ id: 'l', label: 'Left' }, { id: 'r', label: 'Right' }] } }, { choice: 'r' });
  assert.deepEqual(m, { text: 'Two roads.', choices: [{ id: 'l', label: 'Left', chosen: false }, { id: 'r', label: 'Right', chosen: true }], chosen: 'r' });
  assert.deepEqual(storyModel(null), { text: '', choices: [], chosen: null });
});

const NODES = [
  { id: 'n-shop', kind: 'shop', title: 'The pedlar', start: true, payload: { stock: [{ ref: 'srd_potion-of-healing', qty: 3 }, { ref: 'srd_lantern', qty: 1 }, { ref: 'srd_plate', qty: 1, price: { gp: 1500 } }] }, next: [{ to: 'n-fork' }] },
  {
    id: 'n-fork', kind: 'story', title: 'The fork', payload: { text: 'Two roads.\n\nOne is darker.', choices: [{ id: 'left', label: 'Left' }, { id: 'right', label: 'Right' }] },
    next: [{ to: 'n-left', when: { choice: 'left' } }, { to: 'n-right', when: { choice: 'right' } }]
  },
  { id: 'n-left', kind: 'rest', title: 'Quiet glade', payload: { type: 'short' }, next: [] },
  { id: 'n-right', kind: 'rest', title: 'Dark cave', payload: { type: 'short' }, next: [] }
];

function hub(t, who) {
  const dom = createFakeDom();
  const root = dom.root();
  const un = mountBetween(root, t.ctx(who));
  const act = (action, pred = () => true) => {
    const el = dom.byAction(root, action).find(pred);
    assert.ok(el, `${who}: button ${action}`);
    el.click();
  };
  const statusOf = (cls) => dom.findAll(root, n => n.parentNode && /play-status/.test(n.className) && new RegExp(cls).test(n.parentNode.className))[0]?.textContent || '';
  const row = (attr, v) => dom.findAll(root, n => n.dataset?.[attr] === v)[0];
  return { dom, root, un, act, statusOf, row, text: () => root.textContent };
}

test('C26 shop + story through the hub on the real server', async () => {
  const t = await bootRunTable(ROOT, { nodes: NODES });
  try {
    const pr = () => t.sessions.player.runStore.getState();
    const cleric = pr().characters.find(c => c.seat === 1);
    const P = hub(t, 'player');
    const D = hub(t, 'dm');
    await until(() => /Potion of Healing — 50 gp · 3 left/.test(P.text()), 'the SRD price');
    assert.match(P.text(), /purse 165 gp/);
    assert.match(P.row('shopRef', 'srd_lantern').textContent, /no price \(ask the DM\)/);
    assert.equal(P.dom.byAction(P.row('shopRef', 'srd_lantern'), 'shop-buy').length, 0);

    const qty = P.dom.findAll(P.root, n => n.dataset?.field === 'buy-qty' && n.dataset.key === 'srd_potion-of-healing')[0];
    qty.value = '2';
    P.dom.fire(qty, 'change');
    await flush();
    P.act('shop-buy', el => el.dataset.ref === 'srd_potion-of-healing');
    await until(() => /Bought 2 for 100 gp\./.test(P.statusOf('play-shop')), 'bought');
    await until(() => /Potion of Healing — 50 gp · 1 left/.test(P.text()) && /purse 65 gp/.test(P.text()), 'stock and purse updated');

    // GATE: past the purse and the stash → the code's readable reason.
    assert.match(P.row('shopRef', 'srd_plate').textContent, /more than the purse and the stash hold/);
    P.act('shop-buy', el => el.dataset.ref === 'srd_plate');
    await until(() => /Not enough coin/.test(P.statusOf('play-shop')), 'the refusal');
    assert.equal(P.statusOf('play-shop'), 'Not enough coin: it costs 1500 gp and you have 65 gp (the party stash cannot cover it either).');
    assert.equal(pr().characters.find(c => c.slotId === cleric.slotId).state.currency.gp, 65, 'nothing was paid');

    // Sell one potion back at half.
    const potion = pr().items.find(i => i.ownerSlotId === cleric.slotId && i.name === 'Potion of Healing');
    await until(() => P.row('sellItem', potion.id), 'the sell row');
    P.act('shop-sell', el => el.dataset.item === potion.id);
    await until(() => /Sold for 25 gp\./.test(P.statusOf('play-shop')) && /purse 90 gp/.test(P.text()), 'sold');

    // The DM buys for the AI fighter (its seat is the DM's).
    assert.match(D.text(), /Fixture Fighter/);
    assert.equal(D.dom.byAction(D.root, 'shop-buy').length > 0, true);

    // Story: the player picks, the DM settles, the map offers that edge.
    D.act('run-advance', el => el.dataset.to === 'n-fork');
    await until(() => /One is darker\./.test(P.text()) && !/The pedlar/.test(P.dom.findAll(P.root, n => /play-shop/.test(n.className))[0]?.textContent || ''), 'the story on the player\'s screen');
    assert.match(P.text(), /Choose the party's path\./);
    P.act('story-choose', el => el.dataset.choice === 'right');
    await until(() => pr().result.choice === 'right' && /Chosen: Right/.test(P.text()), 'the player\'s choice');
    await until(() => t.sessions.dm.runStore.getState().edges.map(e => e.to).join() === 'n-right', 'the DM is offered the right road');
    D.act('story-choose', el => el.dataset.choice === 'left');
    await until(() => t.sessions.dm.runStore.getState().edges.map(e => e.to).join() === 'n-left' && /Chosen: Left — advance from the run map\./.test(D.text()), 'the DM settles left');
    D.act('run-advance', el => el.dataset.to === 'n-left');
    await until(() => pr().currentNodeId === 'n-left' && /Quiet glade/.test(P.text()), 'the party takes the left road');
    assert.doesNotMatch(P.text(), /Dark cave/, 'the road not taken stays unnamed');

    P.un();
    D.un();
    assert.equal(P.dom.activeListeners() + D.dom.activeListeners(), 0);
  } finally {
    await t.close();
  }
});
