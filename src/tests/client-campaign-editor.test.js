/**
 * M65 C21 — campaign list + editor in a fake DOM, driven against E3's real
 * campaign HTTP API (api/campaigns/**, temp-file DB, real fetch):
 *   - create a campaign from the list (the key lands in localStorage),
 *   - author a 5-node branching campaign end to end (story choices,
 *     encounter outcomes, inline setup, loot with SRD + DM items + coins,
 *     a rest, a shop with priceOf defaults), validate, and start a run;
 *   - an invalid graph (an unreachable node; a delete that would dangle an
 *     edge) blocks "Start run".
 * The SRD search is stubbed (no network); every other call is the server's.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../../api/app.js';
import { startServer } from '../../api/start.js';
import { tempRoot, tempDb, quiet } from '../../api/tests/helpers/server.js';
import { createApi } from '../js/client/api.js';
import { createCampaignKeys, CAMPAIGN_KEYS_STORAGE } from '../js/client/campaign-keys.js';
import { mount as mountCampaigns } from '../js/client/views/campaigns.js';
import {
  mount as mountEditor, defaultPayload, coinsFromCp, stockRowFor, whenOptions, parseWhen, whenValue, setPath
} from '../js/client/views/campaign-editor.js';
import { validateCampaignGraph, validateCampaignNode, NODE_KINDS } from '../js/shared/campaign.js';
import { createFakeDom } from './helpers/fake-dom.js';
import { flush } from './helpers/client-fixtures.js';

const { root: tmp, cleanup } = tempRoot('cf-c21-');
after(cleanup);

function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), map: m };
}

const SRD = [
  { key: 'srd_potion-of-healing', name: 'Potion of Healing', kind: 'magicitem', cost: '50.00', rarity: 'common' },
  { key: 'srd_rope-hempen-50-feet', name: 'Rope, hempen (50 feet)', kind: 'item', cost: '1.00' },
  { key: 'srd_acid-vial', name: 'Acid (vial)', kind: 'item', cost: '0.00' }
];

async function boot() {
  const { dir, db } = await tempDb(tmp);
  const app = createApp({ db, env: { NODE_ENV: 'test' }, dataDir: dir, log: quiet });
  const srv = await startServer({ db, port: 0, host: '127.0.0.1', app, log: quiet });
  const real = createApi({ fetch: globalThis.fetch.bind(globalThis), base: srv.url });
  const api = { ...real, srdItems: async (q) => ({ results: SRD.filter(r => r.name.toLowerCase().includes(String(q).toLowerCase())) }) };
  return { srv, api };
}

async function until(cond, label, rounds = 400) {
  for (let i = 0; i < rounds; i++) {
    if (cond()) return;
    await new Promise(r => setTimeout(r, 2));
  }
  assert.fail(`timed out waiting for ${label}`);
}

/** A driver over one mounted editor. */
function driver(dom, root) {
  const byPath = (path) => dom.findAll(root, n => n.dataset?.path === path)[0];
  const byField = (f) => dom.findAll(root, n => n.dataset?.field === f)[0];
  const status = () => dom.findAll(root, n => /play-status/.test(n.className))[0];
  return {
    byPath, byField, status,
    async click(action, pred = () => true) {
      const el = dom.byAction(root, action).find(pred);
      assert.ok(el, `button ${action}`);
      el.click();
      await flush(8);
      await until(() => root.firstChild?.dataset?.busy === '0', `${action} settled`);
    },
    async set(path, value, ev = 'change') {
      const el = byPath(path);
      assert.ok(el, `field ${path}`);
      if (el.type === 'checkbox') el.checked = !!value; else el.value = String(value);
      dom.fire(el, ev);
      await flush(4);
    },
    async pickKind(kind) { byField('new-kind').value = kind; },
    async waitIdle(label) {
      await until(() => root.firstChild?.dataset?.busy === '0', label);
    },
    startButton: () => dom.byAction(root, 'start-run')[0],
    text: () => root.textContent
  };
}

test('C21 pure helpers: default payloads validate, coins, priceOf stock defaults, when options', () => {
  for (const kind of NODE_KINDS) {
    const node = { id: 'x', kind, title: 'X', payload: defaultPayload(kind), next: [] };
    assert.deepEqual(validateCampaignNode(node).errors, [], kind);
  }
  assert.deepEqual(coinsFromCp(5000), { gp: 50 });
  assert.deepEqual(coinsFromCp(1234), { gp: 12, sp: 3, cp: 4 });
  assert.deepEqual(coinsFromCp(0), { cp: 0 });
  assert.deepEqual(stockRowFor(SRD[0]), { ref: 'srd_potion-of-healing', qty: 1, price: { gp: 50 } });
  assert.deepEqual(stockRowFor(SRD[2]), { ref: 'srd_acid-vial', qty: 1 }, '"0.00" stays DM-priced');
  assert.deepEqual(whenOptions({ kind: 'rest' }).map(o => o.value), ['']);
  assert.ok(whenOptions({ kind: 'encounter' }).some(o => o.value === 'outcome:party-victory'));
  assert.deepEqual(whenOptions({ kind: 'story', payload: { choices: [{ id: 'c1', label: 'Left' }] } }).map(o => o.value), ['', 'choice:c1']);
  assert.deepEqual(parseWhen('choice:c1'), { choice: 'c1' });
  assert.equal(parseWhen(''), undefined);
  assert.equal(whenValue({ when: { outcome: 'draw' } }), 'outcome:draw');
  const o = { next: [{ to: 'a' }] };
  setPath(o, 'next.0.when', { outcome: 'draw' });
  setPath(o, 'payload.setup.placements.m-1.col', 3);
  assert.deepEqual(o, { next: [{ to: 'a', when: { outcome: 'draw' } }], payload: { setup: { placements: { 'm-1': { col: 3 } } } } });
});

test('campaign keys: per campaign id in localStorage; forget drops only this device\'s copy', () => {
  const storage = memoryStorage();
  const keys = createCampaignKeys(storage, { now: () => 5 });
  assert.equal(keys.put('c_abc', 'k'.repeat(43), 'Keep'), true);
  assert.equal(keys.put('c_bad', 'short'), false, 'not a key');
  assert.equal(createCampaignKeys(storage).get('c_abc'), 'k'.repeat(43), 'survives a reload');
  assert.deepEqual(createCampaignKeys(storage).list(), [{ campaignId: 'c_abc', name: 'Keep', savedAt: 5 }]);
  keys.forget('c_abc');
  assert.equal(JSON.parse(storage.map.get(CAMPAIGN_KEYS_STORAGE)).c_abc, undefined);
  const broken = memoryStorage();
  broken.setItem(CAMPAIGN_KEYS_STORAGE, '{nope');
  assert.deepEqual(createCampaignKeys(broken).list(), []);
});

test('C21: author a 5-node branching campaign end to end, validate, and start a run', async () => {
  const { srv, api } = await boot();
  try {
    const dom = createFakeDom();
    const storage = memoryStorage();
    const campaignKeys = createCampaignKeys(storage);

    // ---- the list: create ----
    const listRoot = dom.root();
    let opened = null;
    const unList = mountCampaigns(listRoot, { api, campaignKeys, actions: { openCampaign: (id) => { opened = id; } } });
    dom.findAll(listRoot, n => n.name === 'campaignName')[0].value = 'The Sunless Keep';
    dom.byAction(listRoot, 'create')[0].click();
    await until(() => opened, 'campaign created');
    assert.ok(campaignKeys.get(opened), 'the key is kept in localStorage');
    assert.ok(JSON.parse(storage.map.get(CAMPAIGN_KEYS_STORAGE))[opened]);
    assert.match(listRoot.textContent, /The Sunless Keep/);
    unList();
    assert.equal(dom.activeListeners(), 0, 'list unmounts clean');

    // ---- the editor ----
    const root = dom.root();
    const runs = [];
    const un = mountEditor(root, { api, campaignKeys, campaignId: opened, actions: { startRun: async (a) => { runs.push(a); } } });
    await un.ready;
    const d = driver(dom, root);
    assert.equal(d.startButton().disabled, true, 'an empty campaign cannot start');

    // n1: story with two choices (the start node).
    d.pickKind('story');
    await d.click('add-node');
    await d.waitIdle('n1 added');
    await d.set('title', 'Crossroads', 'input');
    await d.set('payload.text', 'Two roads part in the dark wood.', 'input');
    await d.click('add-choice');
    await d.click('add-choice');
    await d.set('payload.choices.0.label', 'Take the left road', 'input');
    await d.set('payload.choices.1.label', 'Take the right road', 'input');
    await d.click('save-node');
    await d.waitIdle('n1 saved');
    assert.match(d.status().textContent, /Saved/);

    // n2: an encounter after the crossroads (auto-linked), inline setup with a goblin.
    d.pickKind('encounter');
    await d.click('add-node');
    await d.waitIdle('n2 added');
    await d.set('title', 'Goblin Ambush', 'input');
    d.byField('monster-preset').value = 'goblin';
    await d.click('add-monster');
    await d.click('add-monster');
    await d.click('save-node');
    await d.waitIdle('n2 saved');

    // n3: a rest, also after the crossroads.
    await d.click('select-node', el => el.dataset.id && /Crossroads/.test(el.textContent));
    d.pickKind('rest');
    await d.click('add-node');
    await d.waitIdle('n3 added');
    await d.set('title', 'Quiet Shrine', 'input');
    await d.set('payload.type', 'long');
    await d.click('save-node');
    await d.waitIdle('n3 saved');

    // Crossroads branches on the story choice.
    await d.click('select-node', el => el.dataset.id && /Crossroads/.test(el.textContent));
    await d.set('next.0.when', 'choice:c1');
    await d.set('next.1.when', 'choice:c2');
    await d.click('save-node');
    await d.waitIdle('choices saved');

    // n4: loot on victory after the ambush (SRD potion, a DM key, coins).
    await d.click('select-node', el => el.dataset.id && /Goblin Ambush/.test(el.textContent));
    d.pickKind('loot');
    await d.click('add-node');
    await d.waitIdle('n4 added');
    await d.set('title', 'Goblin Hoard', 'input');
    d.byField('srd-q').value = 'potion';
    await d.click('srd-search');
    await until(() => dom.byAction(root, 'add-srd-item').length === 1, 'SRD results');
    await d.click('add-srd-item');
    d.byField('dm-item-name').value = 'Silver Key';
    await d.click('add-dm-item');
    await d.set('payload.currency.gp', 25, 'input');
    await d.set('payload.assign', 'dm');
    await d.click('save-node');
    await d.waitIdle('n4 saved');

    // The ambush: victory → hoard, defeat → shrine.
    await d.click('select-node', el => el.dataset.id && /Goblin Ambush/.test(el.textContent));
    await d.set('next.0.when', 'outcome:party-victory');
    await d.click('add-edge');
    const shrineId = dom.findAll(root, n => n.dataset?.action === 'select-node' && n.dataset.id && /Quiet Shrine/.test(n.textContent))[0].dataset.id;
    await d.set('next.1.to', shrineId);
    await d.set('next.1.when', 'outcome:hostile-victory');
    await d.click('save-node');
    await d.waitIdle('ambush edges saved');

    // n5: a shop after the shrine (priceOf defaults), and the hoard leads there too.
    await d.click('select-node', el => el.dataset.id && /Quiet Shrine/.test(el.textContent));
    d.pickKind('shop');
    await d.click('add-node');
    await d.waitIdle('n5 added');
    await d.set('title', 'Wandering Peddler', 'input');
    d.byField('srd-q').value = 'o';   // rope + potion
    await d.click('srd-search');
    await until(() => dom.byAction(root, 'add-srd-item').length === 2, 'SRD results');
    await d.click('add-srd-item', el => el.dataset.key === 'srd_rope-hempen-50-feet');
    await d.click('add-srd-item', el => el.dataset.key === 'srd_potion-of-healing');
    await d.set('payload.stock.1.qty', 3, 'input');
    await d.click('save-node');
    await d.waitIdle('n5 saved');
    const peddlerId = dom.findAll(root, n => n.dataset?.action === 'select-node' && n.dataset.id && /Wandering Peddler/.test(n.textContent))[0].dataset.id;
    await d.click('select-node', el => el.dataset.id && /Goblin Hoard/.test(el.textContent));
    await d.click('add-edge');
    await d.set('next.0.to', peddlerId);
    await d.click('save-node');
    await d.waitIdle('hoard edge saved');

    // The graph renders every node with its edge labels; the start flag shows.
    const svg = dom.findAll(root, n => n.tagName === 'SVG')[0];
    assert.ok(svg, 'inline SVG chain graph');
    const gtext = svg.textContent;
    for (const t of ['Crossroads', 'Goblin Ambush', 'Quiet Shrine', 'Goblin Hoard', 'Wandering Peddler', 'Take the left road', 'victory', 'defeat', '⚑']) assert.ok(gtext.includes(t), `graph shows ${t}`);

    // Validate → ready → Start run.
    await d.click('validate');
    await d.waitIdle('validated');
    assert.match(d.text(), /Ready to run/);
    assert.equal(d.startButton().disabled, false);
    await d.click('start-run');
    assert.deepEqual(runs, [{ campaignId: opened, campaignKey: campaignKeys.get(opened) }]);

    // What the server holds is a valid branching campaign.
    const got = await api.getCampaign(opened, campaignKeys.get(opened));
    assert.equal(got.nodes.length, 5);
    assert.deepEqual(validateCampaignGraph(got.nodes).errors, []);
    assert.equal(got.validation.ready, true);
    const byTitle = Object.fromEntries(got.nodes.map(n => [n.title, n]));
    assert.equal(byTitle.Crossroads.start, true);
    assert.deepEqual(byTitle.Crossroads.payload.choices.map(c => c.label), ['Take the left road', 'Take the right road']);
    assert.deepEqual(byTitle.Crossroads.next.map(e => e.when), [{ choice: 'c1' }, { choice: 'c2' }]);
    assert.deepEqual(byTitle['Goblin Ambush'].next.map(e => e.when.outcome), ['party-victory', 'hostile-victory']);
    assert.equal(byTitle['Goblin Ambush'].payload.setup.monsters.length, 2);
    assert.deepEqual(Object.keys(byTitle['Goblin Ambush'].payload.setup.placements).sort(), ['m-1', 'm-2']);
    assert.equal(byTitle['Quiet Shrine'].payload.type, 'long');
    assert.deepEqual(byTitle['Goblin Hoard'].payload, {
      items: [{ origin: 'open5e', ref: 'srd_potion-of-healing', name: 'Potion of Healing', qty: 1 }, { origin: 'dm', name: 'Silver Key', qty: 1 }],
      currency: { gp: 25 }, assign: 'dm'
    });
    assert.deepEqual(byTitle['Wandering Peddler'].payload.stock, [
      { ref: 'srd_rope-hempen-50-feet', qty: 1, price: { gp: 1 } },
      { ref: 'srd_potion-of-healing', qty: 3, price: { gp: 50 } }
    ]);

    un();
    assert.equal(dom.activeListeners(), 0, 'editor unmounts clean');
    assert.equal(root.children.length, 0);
  } finally {
    await srv.close();
  }
});

test('C21: an invalid graph blocks Start run', async () => {
  const { srv, api } = await boot();
  try {
    const dom = createFakeDom();
    const campaignKeys = createCampaignKeys(memoryStorage());
    const { campaignId, campaignKey } = await api.createCampaign('Broken Road');
    campaignKeys.put(campaignId, campaignKey, 'Broken Road');
    await api.putGraph(campaignId, campaignKey, [
      { id: 'a', kind: 'story', title: 'Start', start: true, payload: { text: '' }, next: [{ to: 'b' }] },
      { id: 'b', kind: 'rest', title: 'Camp', payload: { type: 'short' }, next: [] }
    ]);
    const root = dom.root();
    const runs = [];
    const un = mountEditor(root, { api, campaignKeys, campaignId, actions: { startRun: async (a) => { runs.push(a); } } });
    await un.ready;
    const d = driver(dom, root);
    assert.equal(d.startButton().disabled, false, 'a linked two-node chain is ready');

    // An unlinked node: savable, but a warning that blocks the run.
    d.pickKind('loot');
    await d.click('add-node');   // nothing selected → not linked
    await d.waitIdle('orphan added');
    assert.equal(d.startButton().disabled, true);
    assert.match(d.text(), /not reachable/);
    dom.byAction(root, 'start-run')[0].click();
    await flush(8);
    assert.equal(runs.length, 0, 'a disabled Start does nothing');
    await d.click('validate');
    await d.waitIdle('validated');
    assert.equal(d.startButton().disabled, true, 'still blocked after Validate');

    // A delete that would dangle an edge: the server refuses (422 INVALID_GRAPH).
    await d.click('select-node', el => el.dataset.id === 'b');
    await d.click('delete-node');
    await until(() => d.status().dataset.kind === 'error', 'the 422 shows');
    assert.match(d.status().textContent, /invalid/i);
    assert.match(d.status().textContent, /unknown node "b"/);
    assert.ok((await api.listNodes(campaignId, campaignKey)).nodes.some(n => n.id === 'b'), 'nothing deleted');

    // Unsaved edits block Start too.
    await d.click('select-node', el => el.dataset.id === 'a');
    await d.set('title', 'Start (edited)', 'input');
    assert.equal(d.startButton().disabled, true);
    un();
    assert.equal(dom.activeListeners(), 0);
  } finally {
    await srv.close();
  }
});

test('C21 list: add by id + key checks the key; forget removes it from the device only', async () => {
  const { srv, api } = await boot();
  try {
    const dom = createFakeDom();
    const campaignKeys = createCampaignKeys(memoryStorage());
    const { campaignId, campaignKey } = await api.createCampaign('Other Device');
    const root = dom.root();
    const un = mountCampaigns(root, { api, campaignKeys, actions: {} });
    dom.findAll(root, n => n.name === 'campaignId')[0].value = campaignId;
    dom.findAll(root, n => n.name === 'campaignKey')[0].value = 'A'.repeat(43);
    dom.byAction(root, 'add-key')[0].click();
    await until(() => /does not open/.test(root.textContent), 'wrong key refused');
    dom.findAll(root, n => n.name === 'campaignKey')[0].value = campaignKey;
    dom.byAction(root, 'add-key')[0].click();
    await until(() => campaignKeys.get(campaignId) === campaignKey, 'added');
    assert.match(root.textContent, /Other Device/);
    dom.byAction(root, 'forget')[0].click();
    assert.equal(campaignKeys.get(campaignId), null);
    assert.equal((await api.getCampaign(campaignId, campaignKey)).campaign.name, 'Other Device', 'the campaign still exists');
    un();
    assert.equal(dom.activeListeners(), 0);
  } finally {
    await srv.close();
  }
});
