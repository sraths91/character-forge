/**
 * M65 C22 — encounter setup templates: "Save as template" / "Load
 * template" round-trip the exact `setupPayload`, and in a campaign run the
 * setup starts from the current encounter node (inline setup or template).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../js/client/store.js';
import { createRunStore } from '../js/client/run-store.js';
import { createCampaignKeys } from '../js/client/campaign-keys.js';
import { mount as mountSetup, setupPayload, draftFromSetup } from '../js/client/views/setup.js';
import { createAppearanceCache } from '../js/map/view.js';
import { validateClientMessage } from '../js/shared/protocol.js';
import { createFakeDom } from './helpers/fake-dom.js';
import { snapshotMsg, manualTimers, manualRaf, flush } from './helpers/client-fixtures.js';

const SHA = 'c'.repeat(64);
const IMAGE_SETUP = {
  map: { kind: 'image', imageId: 'map-9', url: `/api/maps/r1/${SHA}.png`, imgW: 1200, imgH: 800, calib: { cellPx: 50, offsetX: 0, offsetY: 0 }, cinemaBiome: 'cave' },
  grid: { cols: 24, rows: 16, terrain: { v: 1, cols: 24, rows: 16, flags: 'AAAA' } },
  monsters: [
    { id: 'm-1', slug: 'goblin', name: 'Goblin Boss', open5eSlug: 'srd_goblin', hp: 21, cr: '1' },
    { id: 'm-2', slug: 'wolf', name: 'Wolf', imageUrl: `/api/maps/r1/${'d'.repeat(64)}.png` }
  ],
  placements: { 'pc-1': { col: 1, row: 2 }, 'm-1': { col: 20, row: 5 }, 'm-2': { col: 21, row: 6 } },
  fog: { revealed: 'AAAA' },
  initiativeMode: 'grouped'
};
const COLOR_SETUP = {
  map: { kind: 'color', color: '#4a4a52' }, grid: { cols: 10, rows: 8 },
  monsters: [{ id: 'm-1', slug: 'bandit', name: 'Bandit' }], placements: { 'm-1': { col: 7, row: 3 } }, initiativeMode: 'individual'
};
const GEN_SETUP = {
  map: { kind: 'generated', biome: 'forest', seed: 42 }, grid: { cols: 16, rows: 12 },
  monsters: [], placements: {}, initiativeMode: 'individual'
};

test('draftFromSetup inverts setupPayload: image, colour and generated maps round-trip exactly', () => {
  for (const p of [IMAGE_SETUP, COLOR_SETUP, GEN_SETUP]) {
    assert.deepEqual(setupPayload(draftFromSetup(p)), p);
    const v = validateClientMessage({ v: 1, t: 'dm.encounter.setup', cid: '01J00000000000000000000000', p });
    assert.deepEqual(v.errors, [], 'a protocol-valid payload');
  }
  const d = draftFromSetup(COLOR_SETUP, { pauseMode: 'all' });
  assert.equal(d.pauseMode, 'all', 'keeps the base draft\'s pause mode');
  assert.deepEqual(d.monsters[0].pos, { col: 7, row: 3 });
});

function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}

function mountWith({ runStore = null, templates = {} } = {}) {
  const dom = createFakeDom();
  const root = dom.root();
  const store = createStore({ hashState: null });
  store.apply({ v: 1, t: 'hello.ok', ts: 1, p: { memberId: 'mem_dm', role: 'dm', seats: [], serverNow: 1, cfg: {} } });
  store.apply(snapshotMsg(10, null, { id: 'r1', code: 'ABC123', status: 'lobby', members: [], seats: [] }));
  const campaignKeys = createCampaignKeys(memoryStorage());
  campaignKeys.put('c_1', 'k'.repeat(43), 'The Sunless Keep');
  const calls = [];
  const saved = new Map(Object.entries(templates));
  const api = {
    listTemplates: async (cid, key) => { calls.push(['list', cid, key]); return { templates: [...saved.entries()].map(([id, setup]) => ({ id, name: id, setup })) }; },
    templateFromRoom: async (cid, key, roomToken, { name, setup }) => {
      calls.push(['save', cid, key, roomToken, name]);
      const id = `tpl_${saved.size + 1}`;
      saved.set(id, JSON.parse(JSON.stringify(setup)));
      return { template: { id, name, setup } };
    },
    instantiateTemplate: async (cid, key, tid, roomToken) => { calls.push(['instantiate', cid, tid, roomToken]); return { setup: JSON.parse(JSON.stringify(saved.get(tid))) }; },
    searchMonsters: async () => ({ results: [] })
  };
  const sent = [];
  const raf = manualRaf();
  const ctx = {
    store, api, campaignKeys, runStore, roomToken: () => 'dm-token-0123456789',
    send: async (i) => { sent.push(i); return { ok: true }; },
    room: { roomId: 'r1', code: 'ABC123', role: 'dm' },
    loadSheet: async () => null,
    appearanceCache: createAppearanceCache(),
    deps: { render: async () => ({ needsRedraw: false }), raf: raf.raf, caf: raf.caf, timers: manualTimers(), calibrateEncounter: async () => ({ difficulty: {} }) }
  };
  const un = mountSetup(root, ctx);
  return { dom, root, un, calls, saved, sent };
}

test('setup: Load template then Save as template round-trips the exact setupPayload', async () => {
  const t = mountWith({ templates: { tpl_a: IMAGE_SETUP } });
  await t.un.ready;
  await flush();
  assert.match(t.root.textContent, /Save as template/);
  assert.equal(t.root.querySelector('[data-field="template-pick"]').value, 'tpl_a');
  t.dom.byAction(t.root, 'template-load')[0].click();
  await flush(8);
  assert.deepEqual(t.calls.find(c => c[0] === 'instantiate'), ['instantiate', 'c_1', 'tpl_a', 'dm-token-0123456789']);
  assert.match(t.root.textContent, /Template loaded/);
  t.root.querySelector('[data-field="template-name"]').value = 'Copy';
  t.dom.byAction(t.root, 'template-save')[0].click();
  await flush(8);
  const saveCall = t.calls.find(c => c[0] === 'save');
  assert.deepEqual(saveCall, ['save', 'c_1', 'k'.repeat(43), 'dm-token-0123456789', 'Copy']);
  assert.deepEqual(t.saved.get('tpl_2'), IMAGE_SETUP, 'the exact payload');
  // Creating the encounter from the loaded draft sends that payload too.
  t.dom.byAction(t.root, 'create')[0].click();
  await flush(8);
  assert.deepEqual(t.sent.find(i => i.t === 'dm.encounter.setup').p, IMAGE_SETUP);
  t.un();
  assert.equal(t.dom.activeListeners(), 0);
});

test('setup: Save as template needs a name and a campaign key', async () => {
  const t = mountWith();
  await t.un.ready;
  t.dom.byAction(t.root, 'template-save')[0].click();
  await flush();
  assert.match(t.root.textContent, /Name the template/);
  assert.equal(t.calls.filter(c => c[0] === 'save').length, 0);
  t.un();
});

function runWithNode(payload) {
  const rs = createRunStore({ isDm: () => true });
  const r = rs.apply({
    v: 1, t: 'run.snapshot', ts: 1,
    p: {
      run: { id: 'run1', campaignId: 'c_1', status: 'in-node', currentNodeId: 'n2', seq: 3 },
      nodes: [{ id: 'n1', kind: 'story', title: 'Start' }, { id: 'n2', kind: 'encounter', title: 'Goblin Ambush', payload }],
      edges: [], characters: [], items: [], levelUps: []
    }
  });
  assert.equal(r, 'applied');
  return rs;
}

test('setup in a run: pre-filled from the current node\'s inline setup and party placement', async () => {
  const t = mountWith({ runStore: runWithNode({ setup: COLOR_SETUP, partyPlacement: { 1: { col: 0, row: 4 } } }) });
  await t.un.ready;
  await flush();
  assert.match(t.root.textContent, /Pre-filled from "Goblin Ambush"/);
  t.dom.byAction(t.root, 'create')[0].click();
  await flush(8);
  assert.deepEqual(t.sent.find(i => i.t === 'dm.encounter.setup').p, { ...COLOR_SETUP, placements: { 'pc-1': { col: 0, row: 4 }, ...COLOR_SETUP.placements } });
  t.un();
});

test('setup in a run: a template node is instantiated for this room', async () => {
  const t = mountWith({ runStore: runWithNode({ templateId: 'tpl_g' }), templates: { tpl_g: GEN_SETUP } });
  await t.un.ready;
  await flush();
  assert.ok(t.calls.some(c => c[0] === 'instantiate' && c[2] === 'tpl_g'));
  t.dom.byAction(t.root, 'create')[0].click();
  await flush(8);
  assert.deepEqual(t.sent.find(i => i.t === 'dm.encounter.setup').p, GEN_SETUP);
  t.un();
});
