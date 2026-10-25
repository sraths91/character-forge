/**
 * M65 C21 — the campaign editor (DM, campaign key).
 *
 *   - Header: name (rename), export, back to the list.
 *   - Settings: xpMode, hpOnLevel, deathMode, levelUpMode, xpAward,
 *     dawnIsLongRest (shared/campaign.js enums) → PATCH {settings}.
 *   - Graph: an inline SVG chain graph (start flag, edges with their `when`
 *     labels; click a node to edit it) and the node list.
 *   - Node editor, per kind, matching NODE_PAYLOAD_SPECS:
 *       encounter  a template picker, or an inline quick setup (grid, colour,
 *                  preset monsters placed on the grid) in the exact
 *                  `dm.encounter.setup` shape; XP override; loot on victory
 *       rest       short / long / the party chooses
 *       loot       SRD items (`/api/srd/items`), DM-authored items, coins,
 *                  free-for-all or DM-assigned
 *       shop       stock from the SRD with `priceOf` defaults (the Open5e
 *                  cost; "0.00" / null stays DM-priced), buy-back fraction
 *       story      text + choices (a choice picks an edge)
 *     plus its edges (target, label, `when`: an outcome on encounter
 *     nodes, a choice on story nodes). Saved per node (PUT); the server
 *     re-checks the whole graph and answers 422 INVALID_GRAPH with errors.
 *   - Templates (list / delete) and assets (upload map | token, delete).
 *   - Validate (`/validate`): errors, then warnings (unreachable node, no
 *     start yet). "Start run" stays disabled until the server says
 *     `ready` and nothing is unsaved.
 *
 * CSP-safe: DOM built with dom.js (textContent / properties), the graph
 * with createElementNS + attributes; listeners delegated on the view root.
 *
 * mount(root, ctx) → unmount. ctx: {api, campaignKeys, campaignId,
 * actions: {closeCampaign(), startRun?({campaignId, campaignKey})},
 * deps?: {readFile(file), download?(filename, json)}}
 */

import { h, replace, clear, createScope, delegate, attempt, select } from './dom.js';
import {
  NODE_KINDS, REST_NODE_TYPES, LOOT_ASSIGN_MODES, CURRENCY_KEYS, SHOP_BUYBACK_DEFAULT,
  XP_MODES, HP_ON_LEVEL_MODES, DEATH_MODES, LEVEL_UP_MODES, XP_AWARD_MODES,
  campaignSettings, validateCampaignNode
} from '../../shared/campaign.js';
import { ENCOUNTER_OUTCOMES } from '../../shared/events.js';
import { priceOf } from '../../campaign/items.js';
import { MONSTER_PRESETS } from '../../scene/monster-presets.js';
import { layoutGraph, edgeLabel, KIND_GLYPHS } from '../campaign-graph.js';
import { renderChainGraph } from './chain-graph.js';
import { COLOR_PRESETS } from './setup.js';

/** Labels for the settings selects. */
export const SETTING_FIELDS = Object.freeze([
  { key: 'xpMode', label: 'Progression', options: XP_MODES, names: { xp: 'XP', milestone: 'Milestones' } },
  { key: 'hpOnLevel', label: 'HP on level-up', options: HP_ON_LEVEL_MODES, names: { average: 'Fixed average', roll: 'Roll' } },
  { key: 'deathMode', label: 'Death', options: DEATH_MODES, names: { standard: 'Standard 5e', permadeath: 'Permadeath', lenient: 'Lenient' } },
  { key: 'levelUpMode', label: 'Level-ups', options: LEVEL_UP_MODES, names: { auto: 'Automatic', choose: 'Player chooses, DM confirms', reconcile: 'Reconcile with D&D Beyond' } },
  { key: 'xpAward', label: 'XP awards', options: XP_AWARD_MODES, names: { auto: 'Automatic', confirm: 'DM confirms' } }
]);

const OUTCOME_NAMES = Object.freeze({ 'party-victory': 'on victory', 'hostile-victory': 'on defeat', draw: 'on a draw', 'dm-ended': 'when the DM ends it' });
const REST_NAMES = Object.freeze({ short: 'Short rest', long: 'Long rest', choice: 'The party chooses' });

const clone = (v) => JSON.parse(JSON.stringify(v));

/**
 * A minimal inline encounter setup (the `dm.encounter.setup` shape).
 * @returns {object}
 */
export function defaultSetup() {
  return { map: { kind: 'color', color: COLOR_PRESETS[0].value }, grid: { cols: 12, rows: 8 }, monsters: [], placements: {}, initiativeMode: 'individual' };
}

/**
 * A valid starting payload per node kind.
 * @param {string} kind
 * @returns {object}
 */
export function defaultPayload(kind) {
  switch (kind) {
    case 'encounter': return { setup: defaultSetup() };
    case 'rest': return { type: 'short' };
    case 'loot': return { items: [], assign: 'free' };
    case 'shop': return { stock: [] };
    case 'story': return { text: '' };
    default: throw new Error(`unknown node kind ${kind}`);
  }
}

/**
 * Coins for a copper amount, largest useful denominations (gp / sp / cp).
 * @param {number} cp
 * @returns {{gp?: number, sp?: number, cp?: number}}
 */
export function coinsFromCp(cp) {
  const n = Math.max(0, Math.round(Number(cp) || 0));
  const out = {};
  const gp = Math.floor(n / 100);
  const sp = Math.floor((n % 100) / 10);
  const c = n % 10;
  if (gp) out.gp = gp;
  if (sp) out.sp = sp;
  if (c || (!gp && !sp)) out.cp = c;
  return out;
}

/** Copper value of a coin object. */
export function cpOf(coins) {
  const mult = { cp: 1, sp: 10, ep: 50, gp: 100, pp: 1000 };
  return Object.entries(coins || {}).reduce((s, [k, v]) => s + (mult[k] || 0) * (Number(v) || 0), 0);
}

/**
 * A shop stock row for an SRD search result, with the `priceOf` default:
 * the Open5e cost when it has one; otherwise no price (DM-priced).
 * @param {{key: string, cost?: string|number|null}} srd — /api/srd/items summary
 * @param {number} [qty]
 * @returns {{ref: string, qty: number, price?: object}}
 */
export function stockRowFor(srd, qty = 1) {
  const p = priceOf(srd);
  return { ref: srd.key, qty, ...(p.priced ? { price: coinsFromCp(p.buyCp) } : {}) };
}

/**
 * The `when` choices an edge from `node` may carry.
 * @param {object} node
 * @returns {{value: string, label: string}[]} value '' = always; 'outcome:x' / 'choice:id'
 */
export function whenOptions(node) {
  const out = [{ value: '', label: 'always / fallback' }];
  if (node?.kind === 'encounter') for (const o of ENCOUNTER_OUTCOMES) out.push({ value: `outcome:${o}`, label: OUTCOME_NAMES[o] || o });
  if (node?.kind === 'story') for (const c of node.payload?.choices || []) out.push({ value: `choice:${c.id}`, label: `choice: ${c.label || c.id}` });
  return out;
}

/** The select value for an edge's `when`. */
export function whenValue(edge) {
  if (edge?.when?.outcome) return `outcome:${edge.when.outcome}`;
  if (edge?.when?.choice) return `choice:${edge.when.choice}`;
  return '';
}

/** Parse a `whenOptions` value back to a `when` object (or undefined). */
export function parseWhen(value) {
  const m = /^(outcome|choice):(.+)$/.exec(String(value || ''));
  return m ? { [m[1]]: m[2] } : undefined;
}

/**
 * Set a dotted path inside an object (creating objects on the way).
 * @param {object} obj
 * @param {string} path — 'payload.items.0.qty'
 * @param {unknown} value — undefined deletes the key
 */
export function setPath(obj, path, value) {
  const parts = String(path).split('.');
  let o = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = Array.isArray(o) ? Number(parts[i]) : parts[i];
    if (o[k] === undefined || o[k] === null || typeof o[k] !== 'object') o[k] = /^\d+$/.test(parts[i + 1]) ? [] : {};
    o = o[k];
  }
  const last = Array.isArray(o) ? Number(parts.at(-1)) : parts.at(-1);
  if (value === undefined) delete o[last];
  else o[last] = value;
}

function getPath(obj, path) {
  return String(path).split('.').reduce((o, k) => (o == null ? undefined : o[Array.isArray(o) ? Number(k) : k]), obj);
}

/** The editable fields of a node (what PUT /nodes/:id takes). */
function nodeBody(n) {
  const out = { id: n.id, kind: n.kind, title: n.title, payload: n.payload, next: n.next };
  if (Number.isInteger(n.ord)) out.ord = n.ord;
  if (n.start === true) out.start = true;
  return out;
}

/** A readable one-line error list from a validation / 422 response. */
export function describeErrors(errors, limit = 4) {
  const list = Array.isArray(errors) ? errors : [];
  const lines = list.slice(0, limit).map(e => `${e.path ? `${e.path}: ` : ''}${e.message}`);
  if (list.length > limit) lines.push(`…and ${list.length - limit} more`);
  return lines;
}

/**
 * @param {HTMLElement} root
 * @param {object} ctx
 * @returns {() => void} unmount
 */
export function mount(root, ctx) {
  const doc = root.ownerDocument;
  const scope = createScope();
  const cid = ctx.campaignId;
  const key = ctx.campaignKeys?.get?.(cid) ?? ctx.campaignKey ?? null;
  let disposed = false;

  const st = {
    campaign: null, nodes: [], templates: [], assets: [], validation: null,
    selectedId: null, draft: null, dirty: false, srd: { results: [], q: '', target: null, busy: false }, names: {}
  };

  const view = h(doc, 'section', { class: 'play-view play-campaign-editor' });
  const status = h(doc, 'p', { class: 'play-status', attrs: { role: 'status', 'aria-live': 'polite' } });
  const say = (msg, kind = 'info') => { status.textContent = msg || ''; status.dataset.kind = kind; };
  const fail = (e) => {
    const lines = describeErrors(e?.errors);
    say(lines.length ? `${e.message} — ${lines.join('; ')}` : (e?.message || String(e)), 'error');
  };
  const head = h(doc, 'div', { class: 'play-row play-editor-head' });
  const startHost = h(doc, 'span', { class: 'play-start-host' });
  const settingsCard = h(doc, 'div', { class: 'play-card play-campaign-settings' });
  const graphCard = h(doc, 'div', { class: 'play-card cf-graph-host' });
  const validationCard = h(doc, 'div', { class: 'play-card play-validation', attrs: { 'aria-live': 'polite' } });
  const nodesCard = h(doc, 'div', { class: 'play-card play-node-list' });
  const editorCard = h(doc, 'div', { class: 'play-card play-node-editor' });
  const templatesCard = h(doc, 'div', { class: 'play-card play-templates' });
  const assetsCard = h(doc, 'div', { class: 'play-card play-assets' });
  view.appendChild(head);
  view.appendChild(status);
  view.appendChild(h(doc, 'div', { class: 'play-editor-grid' }, [
    h(doc, 'div', { class: 'play-editor-left' }, [graphCard, validationCard, nodesCard]),
    h(doc, 'div', { class: 'play-editor-right' }, [editorCard, settingsCard, templatesCard, assetsCard])
  ]));
  root.appendChild(view);

  const byId = (id) => st.nodes.find(n => n.id === id) || null;

  // ---- loading ----
  async function load() {
    if (!key) { say('This browser has no key for this campaign.', 'error'); renderAll(); return; }
    say('Loading…');
    try {
      const r = await ctx.api.getCampaign(cid, key);
      if (disposed) return;
      st.campaign = r.campaign;
      st.nodes = r.nodes || [];
      st.templates = r.templates || [];
      st.assets = r.assets || [];
      st.validation = r.validation || null;
      ctx.campaignKeys?.rename?.(cid, r.campaign.name);
      if (st.selectedId && !byId(st.selectedId)) select0(null);
      say('');
    } catch (err) {
      if (!disposed) fail(err?.status === 401 ? new Error('This key no longer opens the campaign.') : err);
    }
    renderAll();
  }

  function select0(id) {
    st.selectedId = id;
    const n = id ? byId(id) : null;
    st.draft = n ? clone(nodeBody(n)) : null;
    st.dirty = false;
    st.srd = { results: [], q: '', target: null, busy: false };
  }

  function applyValidation(v) { if (v) st.validation = v; }

  function markDirty() {
    if (!st.dirty) { st.dirty = true; renderStart(); renderEditorHeadState(); }
  }

  // ---- writes ----
  async function saveDraft() {
    if (!st.draft) return null;
    const local = validateCampaignNode(st.draft);
    if (!local.ok) { say(`Fix this node first — ${describeErrors(local.errors).join('; ')}`, 'error'); return null; }
    say('Saving…');
    const r = await ctx.api.putNode(cid, key, st.draft.id, st.draft);
    st.nodes = st.nodes.map(n => (n.id === r.node.id ? r.node : (r.node.start === true && n.start ? (({ start: _s, ...rest }) => rest)(n) : n)));
    applyValidation(r.validation);
    st.draft = clone(nodeBody(r.node));
    st.dirty = false;
    say('Saved.');
    renderAll();
    return r;
  }

  async function addNode(kind) {
    const title = `New ${kind}`;
    const from = st.selectedId ? byId(st.selectedId) : null;
    const r = await ctx.api.createNode(cid, key, { kind, title, payload: defaultPayload(kind), next: [], ...(st.nodes.length === 0 ? { start: true } : {}) });
    st.nodes = [...st.nodes, r.node];
    applyValidation(r.validation);
    if (from && st.draft) {
      // Link the selected node to the new one: saved at once when the
      // selected node has no other unsaved edits, else left in its draft.
      st.draft.next = [...(st.draft.next || []), { to: r.node.id }];
      if (!st.dirty) {
        try { await saveDraft(); } catch (err) { fail(err); }
      } else markDirty();
    }
    select0(r.node.id);
    say(`${title} added.`);
    renderAll();
  }

  async function deleteSelected() {
    const id = st.selectedId;
    if (!id) return;
    const r = await ctx.api.deleteNode(cid, key, id);
    st.nodes = st.nodes.filter(n => n.id !== id);
    applyValidation(r.validation);
    select0(null);
    say('Node deleted.');
    renderAll();
  }

  async function validateNow() {
    const r = await ctx.api.validateCampaign(cid, key);
    applyValidation(r.validation);
    renderValidation();
    renderStart();
    say(st.validation?.ready ? 'The campaign is ready to run.' : 'Not ready yet: see the checks.', st.validation?.ready ? 'info' : 'error');
  }

  async function saveSettings() {
    const settings = {};
    for (const f of SETTING_FIELDS) settings[f.key] = view.querySelector(`[data-setting="${f.key}"]`)?.value;
    settings.dawnIsLongRest = !!view.querySelector('[data-setting="dawnIsLongRest"]')?.checked;
    const r = await ctx.api.patchCampaign(cid, key, { settings });
    st.campaign = r.campaign;
    say('Settings saved.');
    renderSettings();
  }

  async function rename() {
    const v = view.querySelector('[data-field="campaign-name"]')?.value?.trim();
    if (!v || v === st.campaign?.name) return;
    const r = await ctx.api.patchCampaign(cid, key, { name: v });
    st.campaign = r.campaign;
    ctx.campaignKeys?.rename?.(cid, v);
    say('Renamed.');
  }

  async function searchSrd(target) {
    const input = view.querySelector('[data-field="srd-q"]');
    const q = input?.value?.trim() || '';
    if (!q) return;
    st.srd = { results: [], q, target, busy: true };
    renderEditor();
    try {
      const r = await ctx.api.srdItems(q);
      if (disposed) return;
      st.srd = { results: Array.isArray(r?.results) ? r.results.slice(0, 12) : [], q, target, busy: false };
      for (const it of st.srd.results) st.names[it.key] = it.name;
    } catch (err) {
      st.srd = { results: [], q, target, busy: false };
      fail(err);
    }
    renderEditor();
  }

  async function uploadAsset(file) {
    const kindSel = view.querySelector('[data-field="asset-kind"]');
    const kind = kindSel?.value === 'token' ? 'token' : 'map';
    say('Uploading…');
    const bytes = ctx.deps?.readFile ? await ctx.deps.readFile(file) : file;
    const r = await ctx.api.uploadAsset(cid, key, bytes, { kind, filename: file.name || '', mime: file.type || 'application/octet-stream' });
    if (!st.assets.some(a => a.assetId === r.asset.assetId)) st.assets = [...st.assets, r.asset];
    say(`${kind === 'token' ? 'Token' : 'Map'} uploaded.`);
    renderAssets();
  }

  // ---- draft edits ----
  function lootBase() {
    if (!st.draft) return null;
    return st.draft.kind === 'encounter' ? 'payload.loot' : 'payload';
  }

  function coerce(el) {
    const t = el.dataset.type || 'str';
    if (t === 'bool') return !!el.checked;
    if (t === 'int' || t === 'coin') {
      if (el.value === '' || el.value == null) return undefined;
      const n = Math.trunc(Number(el.value));
      return Number.isFinite(n) ? n : undefined;
    }
    if (t === 'num') {
      if (el.value === '' || el.value == null) return undefined;
      const n = Number(el.value);
      return Number.isFinite(n) ? n : undefined;
    }
    return String(el.value ?? '');
  }

  function onField(el) {
    if (!st.draft) return;
    const path = el.dataset.path;
    const t = el.dataset.type || 'str';
    if (t === 'start') {
      if (el.checked) st.draft.start = true; else delete st.draft.start;
    } else if (t === 'when') {
      const w = parseWhen(el.value);
      setPath(st.draft, path, w);
    } else if (t === 'price-gp') {
      const v = el.value === '' ? undefined : Number(el.value);
      setPath(st.draft, path, Number.isFinite(v) && v > 0 ? coinsFromCp(Math.round(v * 100)) : undefined);
    } else {
      setPath(st.draft, path, coerce(el));
    }
    markDirty();
    if (el.dataset.rerender === '1') { renderEditor(); renderGraph(); }
  }

  const editHandlers = {
    'enc-mode': (el) => {
      const p = st.draft.payload;
      if (el.value === 'template') {
        delete p.setup;
        p.templateId = st.templates[0]?.id ?? '';
      } else {
        delete p.templateId;
        p.setup = p.setup || defaultSetup();
      }
      markDirty();
      renderEditor();
    },
    'enc-loot': (el) => {
      if (el.checked) st.draft.payload.loot = st.draft.payload.loot || { items: [] };
      else delete st.draft.payload.loot;
      markDirty();
      renderEditor();
    }
  };

  function addMonster() {
    const sel = view.querySelector('[data-field="monster-preset"]');
    const slug = sel?.value;
    if (!slug || !MONSTER_PRESETS[slug]) return;
    const setup = st.draft.payload.setup;
    let n = setup.monsters.length + 1;
    while (setup.monsters.some(m => m.id === `m-${n}`)) n++;
    const id = `m-${n}`;
    setup.monsters.push({ id, slug, name: MONSTER_PRESETS[slug].name });
    const taken = new Set(Object.values(setup.placements).map(p => `${p.col},${p.row}`));
    let row = 0;
    const col = Math.max(0, setup.grid.cols - 2);
    while (taken.has(`${col},${row}`) && row < setup.grid.rows - 1) row++;
    setup.placements[id] = { col, row };
    markDirty();
    renderEditor();
  }

  function removeMonster(id) {
    const setup = st.draft.payload.setup;
    setup.monsters = setup.monsters.filter(m => m.id !== id);
    delete setup.placements[id];
    markDirty();
    renderEditor();
  }

  function addChoice() {
    const p = st.draft.payload;
    p.choices = p.choices || [];
    let n = p.choices.length + 1;
    while (p.choices.some(c => c.id === `c${n}`)) n++;
    p.choices.push({ id: `c${n}`, label: `Choice ${n}` });
    markDirty();
    renderEditor();
  }

  function removeChoice(i) {
    const p = st.draft.payload;
    const [gone] = p.choices.splice(i, 1);
    if (!p.choices.length) delete p.choices;
    st.draft.next = st.draft.next.filter(e => e.when?.choice !== gone?.id);
    markDirty();
    renderEditor();
  }

  function addEdge() {
    const other = st.nodes.find(n => n.id !== st.draft.id) || st.nodes[0];
    if (!other) return;
    st.draft.next.push({ to: other.id });
    markDirty();
    renderEditor();
  }

  function addSrdItem(el) {
    const target = el.dataset.target;
    const it = st.srd.results.find(r => r.key === el.dataset.key);
    if (!it) return;
    if (target === 'shop') {
      st.draft.payload.stock.push(stockRowFor(it));
    } else {
      const base = lootBase();
      const items = getPath(st.draft, `${base}.items`) || [];
      items.push({ origin: 'open5e', ref: it.key, name: it.name, qty: 1 });
      setPath(st.draft, `${base}.items`, items);
    }
    markDirty();
    renderEditor();
  }

  function addDmItem() {
    const name = view.querySelector('[data-field="dm-item-name"]')?.value?.trim();
    if (!name) { say('Name the item.', 'error'); return; }
    const base = lootBase();
    const items = getPath(st.draft, `${base}.items`) || [];
    items.push({ origin: 'dm', name, qty: 1 });
    setPath(st.draft, `${base}.items`, items);
    markDirty();
    renderEditor();
  }

  function removeAt(path, i) {
    const arr = getPath(st.draft, path);
    if (Array.isArray(arr)) arr.splice(i, 1);
    markDirty();
    renderEditor();
  }

  // ---- events ----
  // In-flight writes, exposed as data-busy for tests and styling.
  let busy = 0;
  const setBusy = (d) => { busy += d; view.dataset.busy = String(busy); };
  const run = (fn) => {
    setBusy(1);
    return attempt(fn, fail).finally(() => setBusy(-1));
  };
  delegate(scope, view, 'click', {
    back: () => ctx.actions?.closeCampaign?.(),
    'select-node': (el) => {
      const id = el.dataset.nodeId || el.dataset.id;
      if (st.dirty && id !== st.selectedId) say('Unsaved changes on the previous node were discarded.', 'error');
      select0(id);
      renderAll();
    },
    'add-node': () => run(() => addNode(view.querySelector('[data-field="new-kind"]')?.value || 'story')),
    'save-node': () => run(() => saveDraft()),
    'revert-node': () => { select0(st.selectedId); renderAll(); say('Changes discarded.'); },
    'close-node': () => { select0(null); renderAll(); },
    'delete-node': () => run(() => deleteSelected()),
    validate: () => run(() => validateNow()),
    'save-settings': () => run(() => saveSettings()),
    rename: () => run(() => rename()),
    'start-run': () => {
      if (!st.validation?.ready || st.dirty) return;
      run(async () => {
        say('Starting the run…');
        await ctx.actions?.startRun?.({ campaignId: cid, campaignKey: key });
      });
    },
    export: () => run(async () => {
      const doc0 = await ctx.api.exportCampaign(cid, key);
      const file = `${(st.campaign?.name || 'campaign').replace(/[^A-Za-z0-9_-]+/g, '-')}.campaign.json`;
      if (ctx.deps?.download) ctx.deps.download(file, doc0);
      say('Exported.');
    }),
    'add-monster': () => addMonster(),
    'remove-monster': (el) => removeMonster(el.dataset.id),
    'add-choice': () => addChoice(),
    'remove-choice': (el) => removeChoice(Number(el.dataset.index)),
    'add-edge': () => addEdge(),
    'remove-edge': (el) => removeAt('next', Number(el.dataset.index)),
    'srd-search': (el) => run(() => searchSrd(el.dataset.target)),
    'add-srd-item': (el) => addSrdItem(el),
    'add-dm-item': () => addDmItem(),
    'remove-item': (el) => removeAt(el.dataset.list, Number(el.dataset.index)),
    'delete-template': (el) => run(async () => {
      await ctx.api.deleteTemplate(cid, key, el.dataset.id);
      st.templates = st.templates.filter(t => t.id !== el.dataset.id);
      say('Template deleted.');
      renderTemplates();
      renderEditor();
    }),
    'delete-asset': (el) => run(async () => {
      await ctx.api.deleteAsset(cid, key, el.dataset.id);
      st.assets = st.assets.filter(a => a.assetId !== el.dataset.id);
      say('Asset deleted.');
      renderAssets();
    })
  });
  delegate(scope, view, 'input', { field: (el) => { if (el.dataset.live !== '0') onField(el); } });
  delegate(scope, view, 'change', {
    field: (el) => onField(el),
    ...editHandlers,
    'asset-file': (el) => { const f = el.files?.[0]; if (f) run(() => uploadAsset(f)); }
  });
  delegate(scope, view, 'keydown', {
    'srd-q': (el, e) => { if (e.key === 'Enter') run(() => searchSrd(el.dataset.target)); }
  });

  // ---- rendering ----
  function renderHead() {
    replace(doc, head, [
      h(doc, 'button', { type: 'button', class: 'play-btn small', dataset: { action: 'back' }, text: '← Campaigns' }),
      h(doc, 'input', { type: 'text', value: st.campaign?.name || '', dataset: { field: 'campaign-name' }, attrs: { maxlength: 80, 'aria-label': 'Campaign name' } }),
      h(doc, 'button', { type: 'button', class: 'play-btn small', dataset: { action: 'rename' }, text: 'Rename' }),
      h(doc, 'button', { type: 'button', class: 'play-btn small', dataset: { action: 'export' }, text: 'Export' }),
      h(doc, 'button', { type: 'button', class: 'play-btn small', dataset: { action: 'validate' }, text: 'Validate' }),
      startHost
    ]);
    renderStart();
  }

  function renderStart() {
    const host = startHost;
    const ready = !!st.validation?.ready && !st.dirty;
    const why = st.dirty ? 'Save the node first.' : !st.validation ? 'Validate the campaign first.' : !st.validation.ready ? 'The checks below must pass.' : '';
    replace(doc, host, [
      h(doc, 'button', { type: 'button', class: 'play-btn primary', disabled: !ready, dataset: { action: 'start-run' }, title: why || 'Start a run of this campaign', text: 'Start run' }),
      why ? h(doc, 'span', { class: 'hint-line', text: ` ${why}` }) : null
    ]);
  }

  function renderSettings() {
    const s = campaignSettings(st.campaign?.settings || {});
    replace(doc, settingsCard, [
      h(doc, 'h3', { text: 'Rules' }),
      ...SETTING_FIELDS.map(f => h(doc, 'label', { class: 'play-field' }, [
        `${f.label} `,
        select(doc, { attrs: { 'data-setting': f.key, 'aria-label': f.label } }, f.options.map(o => ({ value: o, label: f.names[o] || o })), s[f.key])
      ])),
      h(doc, 'label', { class: 'play-field' }, [
        h(doc, 'input', { type: 'checkbox', checked: !!s.dawnIsLongRest, attrs: { 'data-setting': 'dawnIsLongRest', 'aria-label': 'Dawn recovers with a long rest' } }),
        ' "At dawn" features recover on a long rest'
      ]),
      h(doc, 'button', { type: 'button', class: 'play-btn', dataset: { action: 'save-settings' }, text: 'Save rules' })
    ]);
  }

  function renderGraph() {
    const nodes = st.nodes.map(n => (st.draft && n.id === st.draft.id ? { ...n, ...st.draft } : n));
    replace(doc, graphCard, nodes.length
      ? [renderChainGraph(doc, layoutGraph(nodes), { action: 'select-node', selectedId: st.selectedId, label: `${st.campaign?.name || 'Campaign'} graph` })]
      : [h(doc, 'p', { class: 'hint-line', text: 'No nodes yet: add the first one below. It becomes the start.' })]);
  }

  function renderValidation() {
    const v = st.validation;
    if (!v) { replace(doc, validationCard, [h(doc, 'h3', { text: 'Checks' }), h(doc, 'p', { class: 'hint-line', text: 'Not validated yet.' })]); return; }
    const items = [
      ...describeErrors(v.errors, 8).map(t => h(doc, 'li', { class: 'play-check error', text: t })),
      ...describeErrors(v.warnings, 8).map(t => h(doc, 'li', { class: 'play-check warning', text: t }))
    ];
    replace(doc, validationCard, [
      h(doc, 'h3', { text: 'Checks' }),
      h(doc, 'p', { class: `play-check-summary ${v.ready ? 'ready' : 'not-ready'}`, text: v.ready ? 'Ready to run.' : (v.ok ? 'Saved, but not playable yet.' : 'The graph has errors.') }),
      items.length ? h(doc, 'ul', { class: 'play-checks' }, items) : null
    ]);
  }

  function renderNodes() {
    replace(doc, nodesCard, [
      h(doc, 'h3', { text: 'Nodes' }),
      h(doc, 'ol', { class: 'play-nodes' }, st.nodes.map(n => h(doc, 'li', { class: `play-node-row${n.id === st.selectedId ? ' selected' : ''}` }, [
        h(doc, 'button', { type: 'button', class: 'play-link', dataset: { action: 'select-node', id: n.id }, text: `${KIND_GLYPHS[n.kind] || ''} ${n.title}${n.start ? ' ⚑' : ''}` }),
        h(doc, 'span', { class: 'dim', text: ` ${n.kind} · ${(n.next || []).length} edge${(n.next || []).length === 1 ? '' : 's'}` })
      ]))),
      h(doc, 'div', { class: 'play-row' }, [
        select(doc, { dataset: { field: 'new-kind' }, attrs: { 'aria-label': 'New node kind' } }, NODE_KINDS.map(k => ({ value: k, label: `${KIND_GLYPHS[k]} ${k}` })), 'encounter'),
        h(doc, 'button', { type: 'button', class: 'play-btn', dataset: { action: 'add-node' }, text: st.selectedId ? 'Add node after selected' : 'Add node' })
      ])
    ]);
  }

  /** <input data-action="field">. */
  function field(path, type, value, props = {}) {
    const inputType = type === 'bool' || type === 'start' ? 'checkbox' : (type === 'int' || type === 'num' || type === 'coin' || type === 'price-gp') ? 'number' : 'text';
    const el = h(doc, 'input', {
      type: inputType,
      ...(inputType === 'checkbox' ? { checked: !!value } : { value: value == null ? '' : String(value) }),
      dataset: { action: 'field', path, type, ...(props.rerender ? { rerender: '1' } : {}) },
      ...(props.min !== undefined ? { min: props.min } : {}),
      ...(props.max !== undefined ? { max: props.max } : {}),
      ...(props.step !== undefined ? { step: props.step } : {}),
      ...(props.placeholder ? { placeholder: props.placeholder } : {}),
      attrs: { 'aria-label': props.label || path }
    });
    return el;
  }

  function fieldSelect(path, type, options, value, label, rerender = false) {
    return select(doc, { dataset: { action: 'field', path, type, ...(rerender ? { rerender: '1' } : {}) }, attrs: { 'aria-label': label } }, options, value);
  }

  function srdPicker(target) {
    const results = st.srd.target === target ? st.srd.results : [];
    return h(doc, 'div', { class: 'play-srd-picker' }, [
      h(doc, 'div', { class: 'play-row' }, [
        h(doc, 'input', { type: 'search', placeholder: 'Search SRD items', value: st.srd.target === target ? st.srd.q : '', dataset: { field: 'srd-q', action: 'srd-q', target }, attrs: { 'aria-label': 'Search SRD items' } }),
        h(doc, 'button', { type: 'button', class: 'play-btn small', dataset: { action: 'srd-search', target }, text: st.srd.busy && st.srd.target === target ? 'Searching…' : 'Search' })
      ]),
      results.length ? h(doc, 'ul', { class: 'play-srd-results' }, results.map(it => {
        const p = priceOf(it);
        return h(doc, 'li', {}, [
          h(doc, 'span', { text: `${it.name}${it.rarity ? ` (${it.rarity})` : ''} · ${p.priced ? `${p.buyGp} gp` : 'DM-priced'}` }),
          h(doc, 'button', { type: 'button', class: 'play-btn small', dataset: { action: 'add-srd-item', key: it.key, target }, text: 'Add' })
        ]);
      })) : null
    ]);
  }

  function lootEditor(base) {
    const items = getPath(st.draft, `${base}.items`) || [];
    const coins = getPath(st.draft, `${base}.currency`) || {};
    return h(doc, 'div', { class: 'play-loot-editor' }, [
      h(doc, 'ul', { class: 'play-items' }, items.length ? items.map((it, i) => h(doc, 'li', {}, [
        it.origin === 'dm'
          ? field(`${base}.items.${i}.name`, 'str', it.name, { label: 'Item name' })
          : h(doc, 'span', { text: `${it.name || st.names[it.ref] || it.ref} ` }),
        h(doc, 'span', { class: 'dim', text: it.origin === 'dm' ? ' DM item × ' : ' SRD × ' }),
        field(`${base}.items.${i}.qty`, 'int', it.qty ?? 1, { min: 1, max: 999, label: 'Quantity' }),
        h(doc, 'button', { type: 'button', class: 'play-btn small', dataset: { action: 'remove-item', list: `${base}.items`, index: i }, attrs: { 'aria-label': 'Remove item' }, text: '×' })
      ])) : [h(doc, 'li', { class: 'hint-line', text: 'No items.' })]),
      srdPicker('loot'),
      h(doc, 'div', { class: 'play-row' }, [
        h(doc, 'input', { type: 'text', placeholder: 'DM item name', dataset: { field: 'dm-item-name' }, attrs: { maxlength: 128, 'aria-label': 'DM item name' } }),
        h(doc, 'button', { type: 'button', class: 'play-btn small', dataset: { action: 'add-dm-item' }, text: 'Add DM item' })
      ]),
      h(doc, 'div', { class: 'play-row play-coins' }, CURRENCY_KEYS.map(c => h(doc, 'label', {}, [
        field(`${base}.currency.${c}`, 'coin', coins[c] ?? '', { min: 0, label: c }), ` ${c}`
      ])))
    ]);
  }

  function encounterEditor() {
    const p = st.draft.payload;
    const mode = p.templateId !== undefined ? 'template' : 'inline';
    const parts = [
      h(doc, 'div', { class: 'play-row' }, [
        h(doc, 'label', {}, [h(doc, 'input', { type: 'radio', name: 'enc-mode', value: 'template', checked: mode === 'template', dataset: { action: 'enc-mode' } }), ' Template']),
        h(doc, 'label', {}, [h(doc, 'input', { type: 'radio', name: 'enc-mode', value: 'inline', checked: mode === 'inline', dataset: { action: 'enc-mode' } }), ' Inline setup'])
      ])
    ];
    if (mode === 'template') {
      parts.push(st.templates.length
        ? fieldSelect('payload.templateId', 'str', st.templates.map(t => ({ value: t.id, label: t.name })), p.templateId, 'Encounter template')
        : h(doc, 'p', { class: 'hint-line', text: 'No templates yet: save one from a room\'s encounter setup ("Save as template").' }));
    } else {
      const s = p.setup;
      parts.push(h(doc, 'div', { class: 'play-row' }, [
        'Grid ', field('payload.setup.grid.cols', 'int', s.grid.cols, { min: 4, max: 60, label: 'Columns' }),
        ' × ', field('payload.setup.grid.rows', 'int', s.grid.rows, { min: 4, max: 60, label: 'Rows' }),
        ' ', s.map?.kind === 'color'
          ? fieldSelect('payload.setup.map.color', 'str', COLOR_PRESETS.map(c => ({ value: c.value, label: c.label })), s.map.color, 'Map colour')
          : h(doc, 'span', { class: 'dim', text: ` ${s.map?.kind || 'no'} map` })
      ]));
      parts.push(h(doc, 'ul', { class: 'play-monster-list' }, s.monsters.length ? s.monsters.map(m => h(doc, 'li', { class: 'play-monster' }, [
        h(doc, 'span', { text: `${m.name} at ` }),
        field(`payload.setup.placements.${m.id}.col`, 'int', s.placements[m.id]?.col ?? 0, { min: 0, max: s.grid.cols - 1, label: `${m.name} column` }),
        field(`payload.setup.placements.${m.id}.row`, 'int', s.placements[m.id]?.row ?? 0, { min: 0, max: s.grid.rows - 1, label: `${m.name} row` }),
        h(doc, 'button', { type: 'button', class: 'play-btn small', dataset: { action: 'remove-monster', id: m.id }, attrs: { 'aria-label': `Remove ${m.name}` }, text: '×' })
      ])) : [h(doc, 'li', { class: 'hint-line', text: 'No monsters yet.' })]));
      parts.push(h(doc, 'div', { class: 'play-row' }, [
        select(doc, { dataset: { field: 'monster-preset' }, attrs: { 'aria-label': 'Monster preset' } }, Object.values(MONSTER_PRESETS).map(m => ({ value: m.slug, label: m.name })), 'goblin'),
        h(doc, 'button', { type: 'button', class: 'play-btn small', dataset: { action: 'add-monster' }, text: 'Add monster' })
      ]));
    }
    parts.push(h(doc, 'label', { class: 'play-field' }, ['XP override ', field('payload.xpOverride', 'int', p.xpOverride ?? '', { min: 0, placeholder: 'from the monsters', label: 'XP override' })]));
    parts.push(h(doc, 'label', { class: 'play-field' }, [h(doc, 'input', { type: 'checkbox', checked: !!p.loot, dataset: { action: 'enc-loot' }, attrs: { 'aria-label': 'Loot on victory' } }), ' Loot on victory']));
    if (p.loot) parts.push(lootEditor('payload.loot'));
    return parts;
  }

  function kindEditor() {
    const d = st.draft;
    const p = d.payload;
    switch (d.kind) {
      case 'encounter': return encounterEditor();
      case 'rest':
        return [fieldSelect('payload.type', 'str', REST_NODE_TYPES.map(t => ({ value: t, label: REST_NAMES[t] || t })), p.type, 'Rest type')];
      case 'loot':
        return [
          lootEditor('payload'),
          h(doc, 'label', { class: 'play-field' }, ['Hand out ', fieldSelect('payload.assign', 'str', LOOT_ASSIGN_MODES.map(m => ({ value: m, label: m === 'free' ? 'players claim freely' : 'the DM assigns' })), p.assign, 'Loot assignment')])
        ];
      case 'shop':
        return [
          h(doc, 'ul', { class: 'play-items' }, p.stock.length ? p.stock.map((row, i) => h(doc, 'li', {}, [
            h(doc, 'span', { text: `${st.names[row.ref] || row.ref} × ` }),
            field(`payload.stock.${i}.qty`, 'int', row.qty, { min: 0, max: 999, label: 'Stock' }),
            h(doc, 'span', { text: ' at ' }),
            field(`payload.stock.${i}.price`, 'price-gp', row.price ? cpOf(row.price) / 100 : '', { min: 0, step: 0.01, placeholder: 'DM-priced', label: 'Price (gp)' }),
            h(doc, 'span', { text: ' gp ' }),
            h(doc, 'button', { type: 'button', class: 'play-btn small', dataset: { action: 'remove-item', list: 'payload.stock', index: i }, attrs: { 'aria-label': 'Remove stock' }, text: '×' })
          ])) : [h(doc, 'li', { class: 'hint-line', text: 'Nothing in stock.' })]),
          srdPicker('shop'),
          h(doc, 'label', { class: 'play-field' }, ['Buys back at ', field('payload.buyback', 'num', p.buyback ?? SHOP_BUYBACK_DEFAULT, { min: 0, max: 1, step: 0.05, label: 'Buy-back fraction' }), ' × price'])
        ];
      case 'story':
        return [
          h(doc, 'textarea', { rows: 5, value: p.text, dataset: { action: 'field', path: 'payload.text', type: 'str' }, attrs: { 'aria-label': 'Story text', maxlength: 20000 } }),
          h(doc, 'h4', { text: 'Choices' }),
          h(doc, 'ul', { class: 'play-choices' }, (p.choices || []).map((c, i) => h(doc, 'li', {}, [
            h(doc, 'span', { class: 'dim', text: `${c.id} ` }),
            field(`payload.choices.${i}.label`, 'str', c.label, { label: 'Choice label' }),
            h(doc, 'button', { type: 'button', class: 'play-btn small', dataset: { action: 'remove-choice', index: i }, attrs: { 'aria-label': 'Remove choice' }, text: '×' })
          ]))),
          h(doc, 'button', { type: 'button', class: 'play-btn small', dataset: { action: 'add-choice' }, text: 'Add choice' })
        ];
      default: return [];
    }
  }

  function edgesEditor() {
    const d = st.draft;
    const targets = st.nodes.map(n => ({ value: n.id, label: `${KIND_GLYPHS[n.kind] || ''} ${n.id === d.id ? d.title : n.title}` }));
    const whens = whenOptions(d);
    return [
      h(doc, 'h4', { text: 'Leads to' }),
      h(doc, 'ul', { class: 'play-edges' }, d.next.length ? d.next.map((e, i) => h(doc, 'li', { class: 'play-edge' }, [
        fieldSelect(`next.${i}.to`, 'str', targets, e.to, 'Edge target', true),
        field(`next.${i}.label`, 'str', e.label ?? '', { placeholder: edgeLabel({ when: e.when }, d) || 'label', label: 'Edge label' }),
        whens.length > 1 ? fieldSelect(`next.${i}.when`, 'when', whens, whenValue(e), 'Edge condition', true) : null,
        h(doc, 'button', { type: 'button', class: 'play-btn small', dataset: { action: 'remove-edge', index: i }, attrs: { 'aria-label': 'Remove edge' }, text: '×' })
      ])) : [h(doc, 'li', { class: 'hint-line', text: 'A dead end: the run ends here.' })]),
      h(doc, 'button', { type: 'button', class: 'play-btn small', dataset: { action: 'add-edge' }, text: 'Add edge' })
    ];
  }

  let editorHeadState = null;
  function renderEditorHeadState() {
    if (editorHeadState) editorHeadState.textContent = st.dirty ? 'Unsaved changes' : 'Saved';
  }

  function renderEditor() {
    const d = st.draft;
    if (!d) {
      editorHeadState = null;
      replace(doc, editorCard, [h(doc, 'h3', { text: 'Node' }), h(doc, 'p', { class: 'hint-line', text: 'Select a node in the graph or the list.' })]);
      return;
    }
    editorHeadState = h(doc, 'span', { class: 'dim' });
    renderEditorHeadState();
    // Text typed into a field survives re-renders: they rebuild from the draft.
    replace(doc, editorCard, [
      h(doc, 'div', { class: 'play-row' }, [h(doc, 'h3', { text: `${KIND_GLYPHS[d.kind] || ''} ${d.kind}` }), editorHeadState]),
      h(doc, 'label', { class: 'play-field' }, ['Title ', field('title', 'str', d.title, { label: 'Node title', rerender: false })]),
      h(doc, 'label', { class: 'play-field' }, [field('start', 'start', d.start === true, { label: 'Start node' }), ' Start node ⚑']),
      h(doc, 'div', { class: 'play-kind-editor' }, kindEditor()),
      ...edgesEditor(),
      h(doc, 'div', { class: 'play-row' }, [
        h(doc, 'button', { type: 'button', class: 'play-btn primary', dataset: { action: 'save-node' }, text: 'Save node' }),
        h(doc, 'button', { type: 'button', class: 'play-btn', dataset: { action: 'revert-node' }, text: 'Discard changes' }),
        h(doc, 'button', { type: 'button', class: 'play-btn danger', dataset: { action: 'delete-node' }, text: 'Delete node' }),
        h(doc, 'button', { type: 'button', class: 'play-btn small', dataset: { action: 'close-node' }, text: 'Close' })
      ])
    ]);
  }

  function renderTemplates() {
    replace(doc, templatesCard, [
      h(doc, 'h3', { text: 'Encounter templates' }),
      h(doc, 'ul', {}, st.templates.length ? st.templates.map(t => h(doc, 'li', {}, [
        h(doc, 'span', { text: `${t.name} · ${t.setup?.grid?.cols ?? '?'}×${t.setup?.grid?.rows ?? '?'} · ${(t.setup?.monsters || []).length} monsters ` }),
        h(doc, 'button', { type: 'button', class: 'play-btn small', dataset: { action: 'delete-template', id: t.id }, attrs: { 'aria-label': `Delete ${t.name}` }, text: '×' })
      ])) : [h(doc, 'li', { class: 'hint-line', text: 'Save one from an encounter setup in a room.' })])
    ]);
  }

  function renderAssets() {
    replace(doc, assetsCard, [
      h(doc, 'h3', { text: 'Maps and tokens' }),
      h(doc, 'div', { class: 'play-row' }, [
        select(doc, { dataset: { field: 'asset-kind' }, attrs: { 'aria-label': 'Asset kind' } }, [{ value: 'map', label: 'Battle map' }, { value: 'token', label: 'Token image' }], 'map'),
        h(doc, 'input', { type: 'file', accept: 'image/png,image/jpeg,image/webp', dataset: { action: 'asset-file' }, attrs: { 'aria-label': 'Upload an image' } })
      ]),
      h(doc, 'ul', { class: 'play-assets-list' }, st.assets.length ? st.assets.map(a => h(doc, 'li', {}, [
        h(doc, 'span', { text: `${a.kind === 'token' ? 'Token' : 'Map'} · ${a.width}×${a.height} px · ${Math.round((a.bytes || 0) / 1024)} KB ` }),
        h(doc, 'button', { type: 'button', class: 'play-btn small', dataset: { action: 'delete-asset', id: a.assetId }, attrs: { 'aria-label': 'Delete asset' }, text: '×' })
      ])) : [h(doc, 'li', { class: 'hint-line', text: 'No uploads yet.' })])
    ]);
  }

  function renderAll() {
    if (disposed) return;
    renderHead();
    renderSettings();
    renderGraph();
    renderValidation();
    renderNodes();
    renderEditor();
    renderTemplates();
    renderAssets();
  }

  renderAll();
  setBusy(0);
  const ready = load();
  return Object.assign(function unmount() {
    disposed = true;
    scope.dispose();
    clear(view);
    if (view.parentNode) view.parentNode.removeChild(view);
  }, { ready });
}
