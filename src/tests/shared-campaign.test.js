/**
 * M65 H21 — campaign / node contract v1 tests, with planted violations.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  CAMPAIGN_VERSION, NODE_KINDS, REST_NODE_TYPES, LOOT_ASSIGN_MODES, ITEM_ORIGINS, CURRENCY_KEYS,
  NODE_PAYLOAD_SPECS, DEFAULT_CAMPAIGN_SETTINGS, SHOP_BUYBACK_DEFAULT,
  campaignSettings, validateCampaignSettings, validateCampaignNode, validateCampaignGraph,
  validateCampaign, startNodeId, nextNodes
} from '../js/shared/campaign.js';

const FIXTURE = JSON.parse(readFileSync(new URL('./fixtures/contracts/campaign.valid.json', import.meta.url), 'utf8'));
const clone = (v) => JSON.parse(JSON.stringify(v));
const fresh = () => clone(FIXTURE);
const node = (id) => clone(FIXTURE.nodes.find(n => n.id === id));

function assertNamedError(result, path, code) {
  assert.equal(result.ok, false, `expected failure for ${path} (${code})`);
  const hit = result.errors.find(e => e.path === path && e.code === code);
  assert.ok(hit, `expected {path:"${path}", code:"${code}"}, got ${JSON.stringify(result.errors)}`);
}

test('campaign: constants are frozen and match the M65 node-kinds table', () => {
  assert.equal(CAMPAIGN_VERSION, 1);
  assert.deepEqual([...NODE_KINDS], ['encounter', 'rest', 'loot', 'shop', 'story']);
  assert.deepEqual([...REST_NODE_TYPES], ['short', 'long', 'choice']);
  assert.deepEqual([...LOOT_ASSIGN_MODES], ['free', 'dm']);
  assert.deepEqual([...ITEM_ORIGINS], ['ddb', 'open5e', 'dm']);
  assert.deepEqual([...CURRENCY_KEYS], ['cp', 'sp', 'ep', 'gp', 'pp']);
  assert.equal(SHOP_BUYBACK_DEFAULT, 0.5);
  assert.deepEqual(Object.keys(NODE_PAYLOAD_SPECS).sort(), [...NODE_KINDS].sort());
  for (const c of [NODE_KINDS, REST_NODE_TYPES, LOOT_ASSIGN_MODES, ITEM_ORIGINS, NODE_PAYLOAD_SPECS, DEFAULT_CAMPAIGN_SETTINGS]) {
    assert.ok(Object.isFrozen(c));
  }
});

test('campaign: the fixture is valid and covers every node kind', () => {
  assert.deepEqual(validateCampaign(fresh()).errors, []);
  assert.deepEqual(validateCampaignGraph(fresh().nodes).errors, []);
  assert.deepEqual(validateCampaignGraph({ nodes: fresh().nodes, extra: 1 }).errors, [], '{nodes} form accepted');
  assert.deepEqual([...new Set(FIXTURE.nodes.map(n => n.kind))].sort(), [...NODE_KINDS].sort());
  for (const n of FIXTURE.nodes) assert.deepEqual(validateCampaignNode(n).errors, [], n.id);
});

test('campaign: settings default to the owner-approved values', () => {
  assert.deepEqual(campaignSettings(), {
    xpMode: 'xp', hpOnLevel: 'average', deathMode: 'standard', levelUpMode: 'choose', dawnIsLongRest: true, xpAward: 'auto'
  });
  assert.equal(campaignSettings({ xpMode: 'milestone' }).xpMode, 'milestone');
  assert.equal(campaignSettings({ xpMode: 'milestone' }).deathMode, 'standard');
  assert.deepEqual(validateCampaignSettings({}).errors, []);
  assertNamedError(validateCampaignSettings({ deathMode: 'hardcore' }), 'deathMode', 'enum');
  assertNamedError(validateCampaignSettings({ fudge: true }), 'fudge', 'unknown_field');
});

test('campaign: startNodeId — the flag wins, else the single unpointed node', () => {
  assert.equal(startNodeId(FIXTURE.nodes), 'n-start');
  const unflagged = fresh().nodes.map(({ start: _s, ...n }) => n);
  // n-start is pointed at by n-goblins' retreat edge, so nothing is unpointed.
  assert.equal(startNodeId(unflagged), null);
  const chain = [
    { id: 'a', kind: 'rest', title: 'A', payload: { type: 'short' }, next: [{ to: 'b' }] },
    { id: 'b', kind: 'rest', title: 'B', payload: { type: 'long' }, next: [{ to: 'b' }] }
  ];
  assert.equal(startNodeId(chain), 'a', 'self-loops do not count as incoming');
  assert.deepEqual(validateCampaignGraph(chain).errors, []);
});

test('campaign: nextNodes — matching conditional edges win, unconditional edges are the fallback', () => {
  const story = node('n-start');
  assert.deepEqual(nextNodes(story, { choice: 'road' }).map(e => e.to), ['n-goblins']);
  assert.deepEqual(nextNodes(story, { choice: 'woods' }).map(e => e.to), ['n-bandits']);
  assert.deepEqual(nextNodes(story, {}), [], 'no choice yet and no fallback edge');
  const fight = node('n-goblins');
  assert.deepEqual(nextNodes(fight, { outcome: 'party-victory' }).map(e => e.to), ['n-camp']);
  assert.deepEqual(nextNodes(fight, { outcome: 'hostile-victory' }).map(e => e.to), ['n-start']);
  assert.deepEqual(nextNodes(node('n-market'), { outcome: 'party-victory' }), [], 'terminal node');
  const out = nextNodes(fight, { outcome: 'hostile-victory' });
  out[0].to = 'mutated';
  assert.equal(fight.next[1].to, 'n-start', 'returns copies');
  assert.deepEqual(nextNodes(null), []);
  assert.deepEqual(nextNodes({ next: 'x' }, null), []);
});

const NODE_VIOLATIONS = [
  ['unknown kind', n => { n.kind = 'puzzle'; }, 'n-camp', 'kind', 'enum'],
  ['rest type outside the enum', n => { n.payload.type = 'nap'; }, 'n-camp', 'payload.type', 'enum'],
  ['unknown payload field', n => { n.payload.mood = 'grim'; }, 'n-camp', 'payload.mood', 'unknown_field'],
  ['encounter with neither templateId nor setup', n => { delete n.payload.setup; }, 'n-goblins', 'payload', 'required'],
  ['encounter with both templateId and setup', n => { n.payload.templateId = 'tpl-bandits'; }, 'n-goblins', 'payload.setup', 'forbidden_field'],
  ['inline setup that is not a dm.encounter.setup payload', n => { n.payload.setup.grid.cols = 0; }, 'n-goblins', 'payload.setup.grid.cols', 'range'],
  ['party placement on seat 7', n => { n.payload.partyPlacement['7'] = { col: 0, row: 0 }; }, 'n-goblins', 'payload.partyPlacement.7', 'range'],
  ['open5e loot without a ref', n => { delete n.payload.items[1].ref; }, 'n-cache', 'payload.items[1].ref', 'required'],
  ['DM loot without a name', n => { delete n.payload.items[0].name; }, 'n-cache', 'payload.items[0].name', 'required'],
  ['encounter loot open5e without a ref', n => { delete n.payload.loot.items[0].ref; }, 'n-goblins', 'payload.loot.items[0].ref', 'required'],
  ['negative coins', n => { n.payload.currency.gp = -1; }, 'n-cache', 'payload.currency.gp', 'range'],
  ['unknown coin', n => { n.payload.currency.zz = 1; }, 'n-cache', 'payload.currency.zz', 'unknown_field'],
  ['loot assign mode outside the enum', n => { n.payload.assign = 'roll'; }, 'n-cache', 'payload.assign', 'enum'],
  ['shop buyback above 1', n => { n.payload.buyback = 1.5; }, 'n-market', 'payload.buyback', 'range'],
  ['shop stock without a ref', n => { delete n.payload.stock[0].ref; }, 'n-market', 'payload.stock[0].ref', 'required'],
  ['story choice ids not unique', n => { n.payload.choices[1].id = 'road'; }, 'n-start', 'payload.choices[1].id', 'duplicate'],
  ['edge on an unknown story choice', n => { n.next[0].when.choice = 'river'; }, 'n-start', 'next[0].when.choice', 'ref'],
  ['outcome edge on a story node', n => { n.next[0].when = { outcome: 'party-victory' }; }, 'n-start', 'next[0].when.outcome', 'forbidden_field'],
  ['choice edge on an encounter node', n => { n.next[1].when = { choice: 'road' }; }, 'n-goblins', 'next[1].when.choice', 'forbidden_field'],
  ['outcome outside ENCOUNTER_OUTCOMES', n => { n.next[1].when.outcome = 'win'; }, 'n-goblins', 'next[1].when.outcome', 'enum'],
  ['empty when', n => { n.next[1].when = {}; }, 'n-goblins', 'next[1].when', 'range'],
  ['edge without a target', n => { delete n.next[0].to; }, 'n-camp', 'next[0].to', 'required'],
  ['start flag other than true', n => { n.start = false; }, 'n-start', 'start', 'enum'],
  ['missing title', n => { delete n.title; }, 'n-camp', 'title', 'required']
];

for (const [name, mutate, id, path, code] of NODE_VIOLATIONS) {
  test(`campaign: planted node violation fails — ${name}`, () => {
    const n = node(id);
    mutate(n);
    assertNamedError(validateCampaignNode(n), path, code);
    const c = fresh();
    c.nodes[c.nodes.findIndex(x => x.id === id)] = n;
    assert.equal(validateCampaign(c).ok, false, 'the campaign fails too');
  });
}

const GRAPH_VIOLATIONS = [
  ['dangling edge', ns => { ns[3].next[0].to = 'n-nowhere'; }, '[3].next[0].to', 'ref'],
  ['duplicate node id', ns => { ns[4].id = 'n-camp'; }, '[4].id', 'duplicate'],
  ['two start flags', ns => { ns[3].start = true; }, '[3].start', 'duplicate'],
  ['unreachable node', ns => { ns.push({ id: 'n-island', kind: 'rest', title: 'Island', payload: { type: 'long' }, next: [{ to: 'n-camp' }] }); ns[0].start = true; }, '[6]', 'unreachable'],
  ['no start: every node has an incoming edge', ns => { delete ns[0].start; }, '', 'required'],
  ['two unflagged roots', ns => { delete ns[0].start; ns[1].next = [{ to: 'n-camp' }]; ns.push({ id: 'n-solo', kind: 'rest', title: 'Solo', payload: { type: 'short' }, next: [] }); }, '', 'duplicate'],
  ['unknown kind inside the graph', ns => { ns[2].kind = 'maze'; }, '[2].kind', 'enum'],
  ['empty graph', ns => { ns.length = 0; }, '', 'range']
];

for (const [name, mutate, path, code] of GRAPH_VIOLATIONS) {
  test(`campaign: planted graph violation fails — ${name}`, () => {
    const ns = fresh().nodes;
    mutate(ns);
    assertNamedError(validateCampaignGraph(ns), path, code);
  });
}

test('campaign: envelope violations — version, ruleset, template references', () => {
  const c = fresh();
  c.v = 2;
  assertNamedError(validateCampaign(c), 'v', 'version');
  const r = fresh();
  r.ruleset = 'dnd-2024';
  assertNamedError(validateCampaign(r), 'ruleset', 'enum');
  const t = fresh();
  t.nodes[2].payload.templateId = 'tpl-missing';
  assertNamedError(validateCampaign(t), 'nodes[2].payload.templateId', 'ref');
  const d = fresh();
  d.templates.push(clone(d.templates[0]));
  assertNamedError(validateCampaign(d), 'templates[1].id', 'duplicate');
  const g = fresh();
  g.nodes[3].next[0].to = 'n-gone';
  assertNamedError(validateCampaign(g), 'nodes[3].next[0].to', 'ref');
  const noTemplates = fresh();
  delete noTemplates.templates;
  assert.deepEqual(validateCampaign(noTemplates).errors, [], 'templates are optional; refs are then unchecked');
});

test('campaign: validators never throw on garbage', () => {
  for (const g of [undefined, null, 0, 'x', [], {}, [null], [{ next: 5 }], { nodes: 3 }, [{ id: 'a', next: [null, { to: 4 }] }]]) {
    assert.doesNotThrow(() => validateCampaign(g));
    assert.doesNotThrow(() => validateCampaignNode(g));
    assert.doesNotThrow(() => validateCampaignGraph(g));
    assert.doesNotThrow(() => startNodeId(g));
    assert.doesNotThrow(() => nextNodes(g, g));
  }
  assert.equal(validateCampaignGraph('x').ok, false);
});

test('campaign: the shared contract modules stay portable (Vite and Node: relative imports only)', () => {
  for (const f of ['campaign.js', 'run-state.js', 'run-events.js', 'check.js', 'protocol.js', 'events.js', 'encounter-state.js']) {
    const src = readFileSync(new URL(`../js/shared/${f}`, import.meta.url), 'utf8');
    const imports = [...src.matchAll(/^import[^'"]*['"]([^'"]+)['"]/gm)].map(m => m[1]);
    for (const spec of imports) assert.match(spec, /^\.\/[a-z-]+\.js$/, `${f} imports ${spec}`);
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    assert.doesNotMatch(code, /import\.meta|\bprocess\.|\bdocument\.|\bwindow\./, `${f} touches a host global`);
  }
});
