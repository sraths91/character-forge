/**
 * M64 C9 — S3 Encounter setup (DM only).
 *
 *   - Map tabs: Color · Generated (biome + seed) · Image (upload →
 *     E5's `mountCalibrator` → `{calib, cols, rows}`), plus the cinema
 *     backdrop. Grid size for color / generated maps.
 *   - Map canvas with E5's camera controls; tools: Select (drag tokens),
 *     Paint (E5's `attachTerrainBrush`), Place (click a cell to drop the
 *     armed monster).
 *   - Monster search (`/api/monsters/search`) with the proxy label
 *     "fights as: Bandit — AC 12, Scimitar +3", and preset quick-picks.
 *     A searched monster carries its Open5e slug; once the server built
 *     it from the real SRD stat block (the setup ack's `monsters[]`,
 *     source 'srd-2014') its line reads "SRD stat block: AC 18, Bite +10 …".
 *   - Initiative mode, pause mode (Auto / Pause each monster / Pause AI
 *     party too → `dm.review.set`), a live difficulty card that runs
 *     `calibrateEncounter` in the DM's browser debounced 400 ms, Start.
 *
 * Once the encounter exists, each non-humanoid monster's row carries E5's
 * token image picker (views/token-image.js: `PUT …/maps?kind=token`, then
 * `dm.entity.patch {imageUrl}`).
 *
 * Before "Create encounter" everything is a local draft; the setup is sent
 * as one `dm.encounter.setup`. Afterwards (phase 'setup' on the server)
 * edits become intents: token drags → `dm.entity.patch {position,
 * override}`, placement → `dm.entity.add`, removal → `dm.entity.remove`,
 * painting → `dm.terrain.paint`; changing the map re-sends the setup.
 * Start validates ≥ 1 PC and ≥ 1 monster, then `dm.encounter.start`.
 *
 * mount(root, ctx) → unmount. ctx: {store, send, api, room: {roomId},
 * loadSheet(id), appearanceCache?, deps: {render, raf?, caf?, timers,
 * calibrateEncounter, mountCalibrator, loadImage(url), readFile(file),
 * objectUrl(file)}}
 */

import { h, replace, clear, createScope, delegate, attempt, select, observeCanvasSize } from './dom.js';
import { seatsOf } from '../selectors.js';
import { dmMoveIntent } from '../intents.js';
import { matchPresetForOpen5e, fightsAsLabel, statBlockLabel, statBlockInfo, setupAckMonsters } from '../monster-match.js';
import { createTokenPickers } from './token-image.js';
import { createCamera, attachCameraControls, pickCell, fitToGrid, WORLD_CELL_PX } from '../../map/camera.js';
import { createRenderScheduler } from '../../map/scheduler.js';
import { projectBattleView } from '../../map/view.js';
import { attachTerrainBrush } from '../../map/terrain-brush.js';
import { createTerrain, asTerrain, encodeTerrain, applyTerrainPaint, TERRAIN_FLAGS } from '../../map/terrain.js';
import { entityFromPreset, entityFromSheet } from '../../scene/encounter-adapters.js';
import { MONSTER_PRESETS } from '../../scene/monster-presets.js';
import { listBiomes } from '../../scene/map-generator.js';

/** Map background colour presets. */
export const COLOR_PRESETS = Object.freeze([
  { value: '#3d5a3d', label: 'Grass' }, { value: '#4a4a52', label: 'Stone' },
  { value: '#8a7a55', label: 'Sand' }, { value: '#1e2433', label: 'Night' }
]);

/** Pause modes → dm.review.set payloads. */
export const PAUSE_MODES = Object.freeze({
  auto: { plans: false, aiParty: false },
  monsters: { plans: true, aiParty: false },
  all: { plans: true, aiParty: true }
});

const BRUSHES = [
  { flag: TERRAIN_FLAGS.BLOCKED, label: 'Wall' },
  { flag: TERRAIN_FLAGS.DIFFICULT, label: 'Difficult' },
  { flag: TERRAIN_FLAGS.HALF_COVER, label: '½ cover' },
  { flag: TERRAIN_FLAGS.THREE_QUARTERS_COVER, label: '¾ cover' },
  { flag: TERRAIN_FLAGS.TOTAL_COVER, label: 'Blocks sight' }
];

/**
 * The `dm.encounter.setup` payload for a draft.
 * @param {object} draft
 * @returns {{map: object, grid: object, monsters: object[], placements: object, initiativeMode: string}}
 */
export function setupPayload(draft) {
  let map;
  if (draft.mapKind === 'image' && draft.image) {
    map = { kind: 'image', imageId: draft.image.mapId, url: draft.image.url || null, imgW: draft.image.imgW, imgH: draft.image.imgH, calib: { ...draft.image.calib } };
  } else if (draft.mapKind === 'generated') {
    map = { kind: 'generated', biome: draft.biome, seed: draft.seed >>> 0 };
  } else {
    map = { kind: 'color', color: draft.color };
  }
  if (draft.cinemaBiome) map.cinemaBiome = draft.cinemaBiome;
  const placements = { ...draft.placements };
  for (const m of draft.monsters) placements[m.id] = { col: m.pos.col, row: m.pos.row };
  return {
    map,
    grid: { cols: draft.cols, rows: draft.rows, ...(draft.terrain ? { terrain: draft.terrain } : {}) },
    monsters: draft.monsters.map(m => ({
      id: m.id, slug: m.slug, name: m.name,
      ...(m.open5eSlug ? { open5eSlug: m.open5eSlug } : {}),
      ...(Number.isInteger(m.hp) ? { hp: m.hp } : {}), ...(m.cr != null ? { cr: m.cr } : {})
    })),
    placements,
    initiativeMode: draft.initiativeMode
  };
}

/**
 * Inputs for calibrateEncounter from party sheets and monsters.
 * @param {{sheet: object, pos: {col: number, row: number}}[]} party
 * @param {{id: string, slug: string, name: string, hp?: number|null, pos: {col: number, row: number}}[]} monsters
 * @returns {{party: object[], monsters: object[]}}
 */
export function calibratorInputs(party, monsters) {
  return {
    party: party.map(({ sheet, pos }) => {
      const max = sheet?.hp?.max ?? 10;
      return { ...sheet, hp: { ...(sheet?.hp || {}), max, current: max, temp: 0 }, _position: { ...pos } };
    }),
    monsters: monsters.map((m) => {
      const max = Number.isInteger(m.hp) && m.hp > 0 ? m.hp : (MONSTER_PRESETS[m.slug]?.defaultHp?.max ?? 7);
      return { id: m.id, presetSlug: m.slug, name: m.name, position: { ...m.pos }, hp: { current: max, max, temp: 0 }, conditions: [] };
    })
  };
}

/**
 * @param {HTMLElement} root
 * @param {object} ctx
 * @returns {() => void} unmount
 */
export function mount(root, ctx) {
  const doc = root.ownerDocument;
  const scope = createScope();
  const deps = ctx.deps || {};
  const timers = deps.timers || { setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms), clearTimeout: (id) => globalThis.clearTimeout(id) };
  const biomes = listBiomes();
  let disposed = false;
  let monsterN = 0;

  const draft = {
    mapKind: 'color', color: COLOR_PRESETS[0].value, biome: biomes[0] || 'grass', seed: 1, image: null,
    cinemaBiome: null, cols: 12, rows: 8, terrain: null, monsters: [], placements: {},
    initiativeMode: 'individual', pauseMode: 'auto'
  };
  let tool = 'select';
  let armed = null;
  const brush = { flag: TERRAIN_FLAGS.BLOCKED, op: 'set', enabled: false, onPreview: null };
  let drag = null;
  let calTimer = null;
  let calRun = 0;
  /** id → the setup ack's stat-block summary (E3 wave 6). */
  let ackMonsters = {};

  const encounter = () => {
    const e = ctx.store.getPresented().encounter;
    return e && e.phase === 'setup' ? e : null;
  };
  const created = () => !!encounter();

  // ---- DOM ----
  const view = h(doc, 'section', { class: 'play-view play-setup' });
  const status = h(doc, 'p', { class: 'play-status', attrs: { role: 'status', 'aria-live': 'polite' } });
  const say = (msg, kind = 'info') => { status.textContent = msg || ''; status.dataset.kind = kind; };
  const fail = (e) => say(e?.message || String(e), 'error');

  const tabs = h(doc, 'div', { class: 'play-tabs', attrs: { role: 'tablist' } }, ['color', 'generated', 'image'].map(k =>
    h(doc, 'button', { type: 'button', class: 'play-tab', dataset: { action: 'tab', tab: k }, attrs: { role: 'tab' }, text: k === 'color' ? 'Color' : k === 'generated' ? 'Generated' : 'Image' })));
  const tabPanel = h(doc, 'div', { class: 'play-tab-panel' });
  const colsIn = h(doc, 'input', { type: 'number', min: 4, max: 60, value: String(draft.cols), dataset: { action: 'grid' }, attrs: { 'aria-label': 'Columns' } });
  const rowsIn = h(doc, 'input', { type: 'number', min: 4, max: 60, value: String(draft.rows), dataset: { action: 'grid' }, attrs: { 'aria-label': 'Rows' } });
  const cinemaSel = select(doc, { dataset: { action: 'cinema-biome' }, attrs: { 'aria-label': 'Cinema backdrop' } }, [{ value: '', label: 'Backdrop: match the map' }, ...biomes.map(b => ({ value: b, label: `Backdrop: ${b}` }))]);
  const mapCard = h(doc, 'div', { class: 'play-card play-map-card' }, [
    h(doc, 'h3', { text: 'Map' }), tabs, tabPanel,
    h(doc, 'div', { class: 'play-row' }, [h(doc, 'label', { text: 'Grid ' }), colsIn, h(doc, 'span', { text: ' × ' }), rowsIn]),
    cinemaSel
  ]);

  const canvas = h(doc, 'canvas', { class: 'play-map-canvas', attrs: { 'aria-label': 'Encounter map' } });
  const toolBar = h(doc, 'div', { class: 'play-toolbar' });
  const modal = h(doc, 'div', { class: 'play-modal', hidden: true });

  const searchIn = h(doc, 'input', { type: 'search', placeholder: 'Search monsters (SRD)', dataset: { action: 'search-field' }, attrs: { 'aria-label': 'Search monsters' } });
  const results = h(doc, 'div', { class: 'play-search-results' });
  const presetList = h(doc, 'div', { class: 'play-preset-list' }, Object.values(MONSTER_PRESETS).map(p =>
    h(doc, 'button', { type: 'button', class: 'play-chip', dataset: { action: 'arm-preset', slug: p.slug }, text: p.name })));
  const monsterList = h(doc, 'ul', { class: 'play-monster-list' });
  const monsterCard = h(doc, 'div', { class: 'play-card' }, [
    h(doc, 'h3', { text: 'Monsters' }),
    h(doc, 'div', { class: 'play-row' }, [searchIn, h(doc, 'button', { type: 'button', class: 'play-btn', dataset: { action: 'search' }, text: 'Search' })]),
    results, presetList, monsterList
  ]);

  const initSel = select(doc, { dataset: { action: 'init-mode' }, attrs: { 'aria-label': 'Initiative mode' } }, [
    { value: 'individual', label: 'Initiative: each creature rolls' },
    { value: 'grouped', label: 'Initiative: one roll per monster type' }
  ], draft.initiativeMode);
  const pauseSel = select(doc, { dataset: { action: 'pause-mode' }, attrs: { 'aria-label': 'Pause mode' } }, [
    { value: 'auto', label: 'Auto (monsters act on their own)' },
    { value: 'monsters', label: 'Pause each monster for review' },
    { value: 'all', label: 'Pause AI party members too' }
  ], draft.pauseMode);
  const diffCard = h(doc, 'div', { class: 'play-card play-difficulty', attrs: { 'aria-live': 'polite' } });
  const startRow = h(doc, 'div', { class: 'play-row play-start' });

  view.appendChild(h(doc, 'h2', { text: 'Encounter setup' }));
  view.appendChild(status);
  view.appendChild(h(doc, 'div', { class: 'play-setup-grid' }, [
    h(doc, 'div', { class: 'play-setup-left' }, [mapCard, monsterCard]),
    h(doc, 'div', { class: 'play-setup-center' }, [toolBar, canvas]),
    h(doc, 'div', { class: 'play-setup-right' }, [
      h(doc, 'div', { class: 'play-card' }, [h(doc, 'h3', { text: 'Rules' }), initSel, pauseSel]),
      diffCard, startRow
    ])
  ]));
  view.appendChild(modal);
  root.appendChild(view);

  // ---- canvas, camera, brush ----
  const camera = createCamera({ zoom: 1, minZoom: 0.1, maxZoom: 4, viewW: canvas.clientWidth || 640, viewH: canvas.clientHeight || 420, dpr: globalThis.devicePixelRatio || 1 });
  let fittedFor = '';
  const local = {
    camera,
    dm: { showTerrain: true, showHidden: true },
    grid: { visible: true },
    pathPreview: null,
    aoePreview: null,
    resolveAppearance: (key) => ctx.appearanceCache?.characterFor?.(key) || undefined,
    requestRedraw: () => scheduler.markDirty()
  };
  const scheduler = createRenderScheduler(async () => {
    if (disposed || !deps.render) return false;
    const st = previewState();
    const key = `${st.grid.cols}x${st.grid.rows}`;
    if (key !== fittedFor) { Object.assign(camera, fitToGrid(camera, st.grid.cols, st.grid.rows, WORLD_CELL_PX, { padding: 8 })); fittedFor = key; }
    const res = await deps.render(canvas, projectBattleView(st, ctx.appearanceCache), local);
    return !!res?.needsRedraw;
  }, { raf: deps.raf, caf: deps.caf });
  scope.add(() => scheduler.stop());
  const tokenPickers = createTokenPickers({ ...ctx, doc }, { onError: fail });
  scope.add(() => tokenPickers.dispose());
  scope.add(observeCanvasSize(canvas, camera, () => { fittedFor = ''; scheduler.markDirty(); }));
  scope.add(attachCameraControls(canvas, camera, () => scheduler.markDirty(), { worldSize: () => ({ w: gridOf().cols * WORLD_CELL_PX, h: gridOf().rows * WORLD_CELL_PX }) }));
  brush.onPreview = (cells, op) => {
    local.aoePreview = cells.length ? { cells, color: op === 'clear' ? 'rgba(248,113,113,0.25)' : 'rgba(250,204,21,0.30)', strokeColor: 'rgba(250,204,21,0.9)' } : null;
    scheduler.markDirty();
  };
  scope.add(attachTerrainBrush(canvas, camera, () => gridOf(), (paint) => {
    if (created()) {
      attempt(() => ctx.send({ t: 'dm.terrain.paint', p: { cells: paint.cells, flags: paint.flag, mode: paint.op } }), fail);
    } else {
      const base = asTerrain(draft.terrain) || createTerrain(draft.cols, draft.rows);
      draft.terrain = encodeTerrain(applyTerrainPaint(base, paint));
      changed();
    }
  }, brush));

  function gridOf() {
    const e = encounter();
    return e ? { cols: e.grid.cols, rows: e.grid.rows, terrain: e.grid.terrain ?? null } : { cols: draft.cols, rows: draft.rows, terrain: draft.terrain };
  }

  function partySeats() {
    return seatsOf(ctx.store.getState()).filter(s => s.characterId);
  }

  /** The state the canvas shows: the server's setup encounter, else the local draft. */
  function previewState() {
    const e = encounter();
    if (e) return e;
    const entities = {};
    partySeats().forEach((s, i) => {
      const id = `pc-${s.seat}`;
      const pos = draft.placements[id] || { col: Math.min(i, draft.cols - 1), row: 0 };
      entities[id] = entityFromSheet({ id: s.characterId, name: s.characterName || `Seat ${s.seat}`, hp: { max: 10 } }, { id, pos });
    });
    for (const m of draft.monsters) {
      entities[m.id] = entityFromPreset(m.slug, { id: m.id, pos: m.pos, name: m.name });
    }
    return {
      v: 1, encounterId: 'draft', round: 0, turnIndex: 0, phase: 'setup',
      grid: { cols: draft.cols, rows: draft.rows, cellFt: 5, flankingEnabled: false, terrain: draft.terrain },
      map: setupPayload(draft).map, initiative: [], entities, lastEventSeq: 0
    };
  }

  function entityAtCell(st, cell) {
    return Object.values(st.entities).find(e => e.pos && e.pos.col === cell.col && e.pos.row === cell.row) || null;
  }

  function cellOf(e) {
    return pickCell(e.clientX, e.clientY, camera, WORLD_CELL_PX, canvas.getBoundingClientRect());
  }

  function inGrid(cell) {
    const g = gridOf();
    return cell.col >= 0 && cell.row >= 0 && cell.col < g.cols && cell.row < g.rows;
  }

  function placeArmed(cell) {
    if (!armed || !inGrid(cell)) return;
    const st = previewState();
    if (entityAtCell(st, cell)) { say('That cell is occupied.', 'error'); return; }
    let id;
    do { id = `m-${++monsterN}`; } while (st.entities[id]);
    if (created()) {
      let entity;
      try {
        entity = entityFromPreset(armed.slug, { id, pos: cell, name: armed.name, statBlock: { ...(Number.isInteger(armed.hp) && armed.hp > 0 ? { hpMax: armed.hp } : {}), ...(armed.cr != null ? { cr: armed.cr } : {}) } });
      } catch (err) { fail(err); return; }
      attempt(() => ctx.send({ t: 'dm.entity.add', p: { entity } }), fail);
    } else {
      draft.monsters.push({ id, slug: armed.slug, ...(armed.open5eSlug ? { open5eSlug: armed.open5eSlug } : {}), name: armed.name, hp: Number.isInteger(armed.hp) ? armed.hp : null, cr: armed.cr ?? null, pos: { ...cell } });
      changed();
    }
    say(`${armed.name} placed.`);
  }

  scope.on(canvas, 'pointerdown', (e) => {
    if (e.button !== 0 || e.altKey) return;
    const cell = cellOf(e);
    if (tool === 'place') { placeArmed(cell); return; }
    if (tool !== 'select') return;
    const hit = entityAtCell(previewState(), cell);
    if (!hit) return;
    drag = { id: hit.id, from: { ...hit.pos }, to: null, pointerId: e.pointerId };
    canvas.setPointerCapture?.(e.pointerId);
  });
  scope.on(canvas, 'pointermove', (e) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const cell = cellOf(e);
    if (drag.to && drag.to.col === cell.col && drag.to.row === cell.row) return;
    drag.to = cell;
    const free = inGrid(cell) && !entityAtCell(previewState(), cell);
    local.pathPreview = { cells: [drag.from, cell], legal: free, costFt: null };
    scheduler.markDirty();
  });
  const endDrag = (e, cancel) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const d = drag;
    drag = null;
    local.pathPreview = null;
    canvas.releasePointerCapture?.(e.pointerId);
    scheduler.markDirty();
    if (cancel || !d.to || !inGrid(d.to)) return;
    if (created()) {
      const r = dmMoveIntent(encounter(), d.id, d.to);
      if (r.ok) attempt(() => ctx.send(r.intent), fail);
      else if (r.reason !== 'no-move') say(`Can't move there: ${r.reason}.`, 'error');
      return;
    }
    if (entityAtCell(previewState(), d.to)) { say('That cell is occupied.', 'error'); return; }
    const m = draft.monsters.find(x => x.id === d.id);
    if (m) m.pos = { ...d.to };
    else draft.placements[d.id] = { ...d.to };
    changed();
  };
  scope.on(canvas, 'pointerup', (e) => endDrag(e, false));
  scope.on(canvas, 'pointercancel', (e) => endDrag(e, true));

  // ---- controls ----
  function setTool(next) {
    tool = next;
    brush.enabled = tool === 'paint';
    renderToolbar();
  }

  function sendSetup() {
    return Promise.resolve(ctx.send({ t: 'dm.encounter.setup', p: setupPayload(draft) })).then((ack) => {
      // E3 wave 6: which monsters fight with their real SRD stat block.
      ackMonsters = setupAckMonsters(ack);
      if (!disposed) renderLists();
      return ack;
    });
  }

  delegate(scope, view, 'click', {
    tab: (el) => { draft.mapKind = el.dataset.tab; renderTab(); changed(); },
    swatch: (el) => { draft.color = el.dataset.color; changed(); },
    tool: (el) => setTool(el.dataset.tool),
    brush: (el) => { brush.flag = Number(el.dataset.flag); brush.op = 'set'; setTool('paint'); },
    erase: () => { brush.op = 'clear'; setTool('paint'); },
    search: () => runSearch(),
    'arm-preset': (el) => { armPlacement({ slug: el.dataset.slug, name: MONSTER_PRESETS[el.dataset.slug]?.name || el.dataset.slug, hp: null, cr: null }); },
    'arm-result': (el) => {
      armPlacement({ slug: el.dataset.slug, open5eSlug: el.dataset.o5 || null, name: el.dataset.name, hp: el.dataset.hp ? Number(el.dataset.hp) : null, cr: el.dataset.cr || null });
    },
    'remove-monster': (el) => {
      const id = el.dataset.id;
      if (created()) { attempt(() => ctx.send({ t: 'dm.entity.remove', p: { entityId: id } }), fail); return; }
      draft.monsters = draft.monsters.filter(m => m.id !== id);
      changed();
    },
    create: () => { say('Creating the encounter…'); attempt(() => sendSetup().then(() => say('Encounter created — drag tokens into place, then Start.')), fail); },
    rebuild: () => { say('Rebuilding with this map…'); attempt(() => sendSetup().then(() => say('Encounter rebuilt.')), fail); },
    start: () => {
      const st = previewState();
      const pcs = Object.values(st.entities).filter(e => e.kind === 'pc').length;
      const mons = Object.values(st.entities).filter(e => e.kind === 'monster').length;
      if (!pcs) { say('Seat at least one character before starting.', 'error'); return; }
      if (!mons) { say('Place at least one monster before starting.', 'error'); return; }
      say('Starting…');
      attempt(async () => {
        if (!created()) await sendSetup();
        await ctx.send({ t: 'dm.encounter.start', p: {} });
      }, fail);
    },
    'calib-close': () => closeModal()
  });

  delegate(scope, view, 'change', {
    grid: () => {
      const c = Math.max(4, Math.min(60, Number(colsIn.value) | 0));
      const r = Math.max(4, Math.min(60, Number(rowsIn.value) | 0));
      if (draft.mapKind === 'image' && draft.image) { colsIn.value = String(draft.cols); rowsIn.value = String(draft.rows); return; }
      draft.cols = c; draft.rows = r;
      draft.terrain = null;
      draft.monsters.forEach(m => { m.pos = { col: Math.min(m.pos.col, c - 1), row: Math.min(m.pos.row, r - 1) }; });
      changed();
    },
    biome: (el) => { draft.biome = el.value; changed(); },
    seed: (el) => { draft.seed = Math.max(0, Number(el.value) | 0); changed(); },
    'cinema-biome': (el) => { draft.cinemaBiome = el.value || null; changed(); },
    'init-mode': (el) => { draft.initiativeMode = el.value === 'grouped' ? 'grouped' : 'individual'; },
    'pause-mode': (el) => {
      draft.pauseMode = PAUSE_MODES[el.value] ? el.value : 'auto';
      attempt(() => ctx.send({ t: 'dm.review.set', p: { ...PAUSE_MODES[draft.pauseMode] } }), fail);
    },
    'map-file': (el) => { const f = el.files?.[0]; if (f) uploadMap(f); }
  });
  delegate(scope, view, 'keydown', {
    'search-field': (_el, e) => { if (e.key === 'Enter') runSearch(); }
  });

  function armPlacement(a) {
    armed = a;
    setTool('place');
    say(`Click a cell to place ${a.name}.`);
  }

  async function runSearch() {
    const q = searchIn.value.trim();
    if (!q) return;
    replace(doc, results, [h(doc, 'span', { class: 'hint-line', text: 'Searching…' })]);
    try {
      const res = await ctx.api.searchMonsters(q);
      if (disposed) return;
      const list = Array.isArray(res?.results) ? res.results.slice(0, 12) : [];
      replace(doc, results, list.length ? list.map((r) => {
        const slug = matchPresetForOpen5e(r.name, r.type);
        return h(doc, 'button', { type: 'button', class: 'play-search-result', dataset: { action: 'arm-result', slug, o5: r.slug || '', name: r.name, hp: r.hp ?? '', cr: r.cr ?? '' } }, [
          h(doc, 'strong', { text: r.name }),
          h(doc, 'span', { class: 'dim', text: ` ${r.type || ''}${r.cr != null ? ` · CR ${r.cr}` : ''}${r.hp ? ` · ${r.hp} hp` : ''}` }),
          h(doc, 'span', { class: 'play-fights-as', text: fightsAsLabel(slug) })
        ]);
      }) : [h(doc, 'span', { class: 'hint-line', text: 'No monsters matched.' })]);
    } catch (err) {
      if (!disposed) replace(doc, results, [h(doc, 'span', { class: 'hint-line', text: `Search failed: ${err.message}` })]);
    }
  }

  let closeCalibrator = null;
  function closeModal() {
    if (closeCalibrator) { closeCalibrator(); closeCalibrator = null; }
    clear(modal);
    modal.hidden = true;
  }
  scope.add(() => closeModal());

  async function uploadMap(file) {
    say('Uploading the map…');
    try {
      const bytes = deps.readFile ? await deps.readFile(file) : file;
      const rec = await ctx.api.uploadMap(ctx.room.roomId, bytes, { filename: file.name || '', mime: file.type || 'application/octet-stream' });
      const url = rec?.url || deps.objectUrl?.(file) || null;
      const img = await deps.loadImage(url);
      if (disposed) return;
      modal.hidden = false;
      const host = h(doc, 'div', { class: 'play-modal-body' });
      replace(doc, modal, [host, h(doc, 'button', { type: 'button', class: 'play-btn', dataset: { action: 'calib-close' }, text: 'Close' })]);
      closeCalibrator = deps.mountCalibrator(host, {
        image: img,
        filename: file.name || '',
        onConfirm: ({ calib, cols, rows }) => {
          draft.image = { mapId: rec.mapId, url, imgW: img.naturalWidth || img.width, imgH: img.naturalHeight || img.height, calib };
          draft.mapKind = 'image';
          draft.cols = cols; draft.rows = rows;
          colsIn.value = String(cols); rowsIn.value = String(rows);
          draft.terrain = null;
          closeModal();
          renderTab();
          changed();
          say(`Map calibrated: ${cols} × ${rows} cells.`);
        },
        onCancel: () => closeModal()
      });
      say('Calibrate the grid, then confirm.');
    } catch (err) {
      fail(err);
    }
  }

  // ---- rendering ----
  function renderTab() {
    for (const b of tabs.children) b.setAttribute('aria-selected', String(b.dataset.tab === draft.mapKind));
    if (draft.mapKind === 'generated') {
      replace(doc, tabPanel, [
        select(doc, { dataset: { action: 'biome' }, attrs: { 'aria-label': 'Biome' } }, biomes, draft.biome),
        h(doc, 'input', { type: 'number', min: 0, value: String(draft.seed), dataset: { action: 'seed' }, attrs: { 'aria-label': 'Seed' } })
      ]);
    } else if (draft.mapKind === 'image') {
      replace(doc, tabPanel, [
        h(doc, 'input', { type: 'file', accept: 'image/png,image/jpeg,image/webp', dataset: { action: 'map-file' }, attrs: { 'aria-label': 'Battle map image' } }),
        h(doc, 'p', { class: 'hint-line', text: draft.image ? `Calibrated: ${draft.cols} × ${draft.rows} cells at ${draft.image.calib.cellPx.toFixed(1)} px.` : 'Upload a PNG / JPEG / WebP, then calibrate its grid.' })
      ]);
    } else {
      replace(doc, tabPanel, COLOR_PRESETS.map(c => h(doc, 'button', { type: 'button', class: `play-swatch${draft.color === c.value ? ' active' : ''}`, dataset: { action: 'swatch', color: c.value }, style: { background: c.value }, text: c.label })));
    }
  }

  function renderToolbar() {
    replace(doc, toolBar, [
      ...['select', 'paint', 'place'].map(t => h(doc, 'button', { type: 'button', class: `play-tool${tool === t ? ' active' : ''}`, dataset: { action: 'tool', tool: t }, attrs: { 'aria-pressed': String(tool === t) }, text: t === 'select' ? 'Move tokens' : t === 'paint' ? 'Paint terrain' : `Place${armed ? `: ${armed.name}` : ''}` })),
      tool === 'paint' ? h(doc, 'span', { class: 'play-brushes' }, [
        ...BRUSHES.map(b => h(doc, 'button', { type: 'button', class: `play-chip${brush.flag === b.flag && brush.op === 'set' ? ' active' : ''}`, dataset: { action: 'brush', flag: b.flag }, text: b.label })),
        h(doc, 'button', { type: 'button', class: `play-chip${brush.op === 'clear' ? ' active' : ''}`, dataset: { action: 'erase' }, text: 'Erase' })
      ]) : null
    ]);
  }

  function monstersNow() {
    const e = encounter();
    if (e) {
      return Object.values(e.entities).filter(x => x.kind === 'monster').map(x => ({
        id: x.id, slug: x.statBlock?.slug, name: x.name, hp: x.hpMax, pos: x.pos, info: ackMonsters[x.id] || statBlockInfo(x)
      }));
    }
    return draft.monsters.map(m => ({ ...m, info: ackMonsters[m.id] || null }));
  }

  function renderLists() {
    const mons = monstersNow();
    const ents = encounter()?.entities || {};
    tokenPickers.prune(mons.map(m => m.id));
    replace(doc, monsterList, mons.length ? mons.map(m => h(doc, 'li', { class: 'play-monster' }, [
      h(doc, 'span', { text: `${m.name} (${m.pos.col}, ${m.pos.row})` }),
      h(doc, 'span', { class: `play-fights-as${m.info?.source === 'srd-2014' ? ' srd' : ''}`, text: statBlockLabel(m.info, m.slug) }),
      h(doc, 'button', { type: 'button', class: 'play-btn small', dataset: { action: 'remove-monster', id: m.id }, attrs: { 'aria-label': `Remove ${m.name}` }, text: '×' }),
      ents[m.id] ? tokenPickers.hostFor(ents[m.id]) : null
    ])) : [h(doc, 'li', { class: 'hint-line', text: 'No monsters yet: search or pick a preset, then click the map.' })]);
    const isCreated = created();
    replace(doc, startRow, [
      isCreated
        ? h(doc, 'button', { type: 'button', class: 'play-btn', dataset: { action: 'rebuild' }, text: 'Rebuild with this map' })
        : h(doc, 'button', { type: 'button', class: 'play-btn', dataset: { action: 'create' }, text: 'Create encounter' }),
      h(doc, 'button', { type: 'button', class: 'play-btn primary', dataset: { action: 'start' }, text: 'Start encounter' })
    ]);
  }

  function renderDifficulty(report, state) {
    if (state === 'empty') {
      replace(doc, diffCard, [h(doc, 'h3', { text: 'Difficulty' }), h(doc, 'p', { class: 'hint-line', text: 'Seat a character and place a monster to see the odds.' })]);
      return;
    }
    if (state === 'running') { diffCard.dataset.state = 'running'; return; }
    if (state === 'error') {
      replace(doc, diffCard, [h(doc, 'h3', { text: 'Difficulty' }), h(doc, 'p', { class: 'hint-line', text: 'The simulator could not run this encounter.' })]);
      return;
    }
    diffCard.dataset.state = 'done';
    const pct = (x) => `${Math.round((x || 0) * 100)}%`;
    const label = report.difficulty?.label || 'unknown';
    replace(doc, diffCard, [
      h(doc, 'h3', { text: 'Difficulty' }),
      h(doc, 'div', { class: 'cal-row cal-headline' }, [
        h(doc, 'span', { class: `cal-difficulty cal-difficulty-${label}`, text: label.toUpperCase() }),
        h(doc, 'span', { class: 'cal-xp', text: `${report.difficulty?.encounterXp ?? 0} XP` })
      ]),
      h(doc, 'div', { class: 'cal-row' }, [
        h(doc, 'span', { class: 'cal-cell cal-win', text: `${pct(report.winRate)} party wins` }),
        h(doc, 'span', { class: 'cal-cell', text: `lethality ${pct(report.lethality)}` }),
        h(doc, 'span', { class: 'cal-cell', text: `${(report.deathToll ?? 0).toFixed(1)} expected downs` })
      ]),
      h(doc, 'p', { class: 'hint-line', text: `±5 pp over ${report.iterations ?? 200} simulated fights; monsters fight as their preset.` })
    ]);
  }

  async function runCalibration() {
    const run = ++calRun;
    const seats = partySeats();
    const st = previewState();
    const mons = monstersNow();
    if (!seats.length || !mons.length || !deps.calibrateEncounter) { renderDifficulty(null, 'empty'); return; }
    renderDifficulty(null, 'running');
    try {
      const party = [];
      for (const s of seats) {
        const sheet = await ctx.loadSheet(s.characterId);
        const ent = Object.values(st.entities).find(e => e.kind === 'pc' && (e.sheetRef?.characterId === s.characterId || e.id === `pc-${s.seat}`));
        party.push({ sheet: sheet || { id: s.characterId, name: s.characterName, hp: { max: 10 } }, pos: ent?.pos || { col: 0, row: 0 } });
      }
      const inputs = calibratorInputs(party, mons.filter(m => MONSTER_PRESETS[m.slug]));
      const report = await deps.calibrateEncounter({ ...inputs, scene: { cols: st.grid.cols, rows: st.grid.rows }, iterations: 200, maxRounds: 15, seed: 1 });
      if (run === calRun && !disposed) renderDifficulty(report, 'done');
    } catch (err) {
      if (run === calRun && !disposed) renderDifficulty(null, 'error');
      globalThis.console?.warn?.(JSON.stringify({ event: 'setup.calibrate_failed', error: String(err?.message || err) }));
    }
  }

  function scheduleCalibration() {
    if (calTimer !== null) timers.clearTimeout(calTimer);
    calTimer = timers.setTimeout(() => { calTimer = null; runCalibration(); }, 400);
  }
  scope.add(() => { if (calTimer !== null) timers.clearTimeout(calTimer); calTimer = null; });

  function changed() {
    renderLists();
    scheduler.markDirty();
    scheduleCalibration();
  }

  scope.add(ctx.store.subscribe((_a, p) => [p.encounter, p.room, p.seats], () => { renderLists(); scheduler.markDirty(); scheduleCalibration(); }, (x, y) => x.every((v, i) => v === y[i])));
  renderTab();
  renderToolbar();
  changed();

  return function unmount() {
    disposed = true;
    scope.dispose();
    if (view.parentNode) view.parentNode.removeChild(view);
  };
}
