/**
 * M64 C9 — S5 battle view (players; the DM gets it too, with dm-panel.js
 * beside it).
 *
 *   - The map, drawn by the C8 render adapter (E5 renderer + rAF
 *     scheduler) with E5's camera controls; your own token ringed.
 *   - Your creatures' HP / temp HP / slots / conditions, the initiative
 *     strip (current turn + round) and the fight log (DM edits in a
 *     distinct colour).
 *   - On your turn: the forge's action list (`buildActionsFor`) and turn
 *     tips (`buildTurnTips`) become intents — attack / cast / dash /
 *     dodge / disengage via `turn.act`, "let the AI play" via
 *     `turn.delegate`, and dragging your token previews a path (green /
 *     red) and sends a move only when legal. `validateIntent` answers
 *     first; the server stays authoritative.
 *   - Reaction dialogs (Shield, Counterspell, opportunity attack) reuse
 *     `promptReaction` in this view's container, with the countdown taken
 *     from the server's `deadlineAt`.
 *   - Feature actions (E1 wave 5): Second Wind / Rage when the sheet has
 *     them, as `turn.act {plan: {kind: 'feature', featureId}}`. Extra
 *     Attack swings log as "Swing 2 (new target): …" (the server picks a
 *     new target when the first one drops).
 *   - Fog (M64 1.5): events this seat may not see arrive as `redacted
 *     {type}` and log as "Something happens out of sight…"; masked events
 *     name the hidden creature 'Something'. The DM gets a Reveal / Hide
 *     fog brush (E5's terrain brush with a fog flag) that sends
 *     `dm.fog.paint {cells, op}` (protocol v1.4); the server answers every
 *     seat with `encounter.fog {fog}` (v1.5), which redraws the mask.
 *   - Waiting states: "Goblin is acting…", "DM is reviewing…", "Paused".
 *   - Dying (E1 wave 5): a death-save banner on your downed creature's
 *     card (the server rolls it at the start of your turn; the result and
 *     the ✓ / ✗ tally show here), and Dying / Stable / Dead badges on the
 *     initiative strip (the render adapter badges the tokens).
 *   - The DM drags any token as a free move (`dm.entity.patch {position,
 *     override: true}`), and clicks select an entity for the inspector.
 *
 * mount(root, ctx) → unmount. ctx: {store, send, session, sheets() →
 * Record<id, sheet>, appearanceCache, dmBridge?, deps: {render, raf, caf,
 * timers, promptReaction, cinema?, cinemaOptions?, cinemaCanvas?: boolean}}
 */

import { h, replace, createScope, delegate, attempt, observeCanvasSize } from './dom.js';
import { createRenderAdapter } from '../render-adapter.js';
import {
  myEntityIds, turnInfo, nameOf, conditionIds, slotsLeft, isDm, statusBadge, deathSaveInfo
} from '../selectors.js';
import { previewMove, moveIntent, dmMoveIntent, attackIntent, castIntent, actionIntent, featureIntent, featureActionsFor } from '../intents.js';
import { formatEvent, formatRedacted } from '../log-format.js';
import { attachTerrainBrush } from '../../map/terrain-brush.js';
import { reactionCostLabel } from '../reaction-labels.js';
import { attachCameraControls, pickCell, fitToGrid, WORLD_CELL_PX } from '../../map/camera.js';
import { buildActionsFor } from '../../scene/actions-panel.js';
import { buildTurnTips } from '../../scene/turn-coach.js';
import { spellById } from '../../scene/monster-spells.js';
import { nameToSpellId } from '../../scene/ai/pc-action.js';
import { REACTION_KINDS } from '../../shared/events.js';

const LOG_LIMIT = 80;
/** The brush flag that marks a fog stroke (outside TERRAIN_FLAG_MASK; never sent as terrain). */
export const FOG_BRUSH_FLAG = 64;

/**
 * A fog brush stroke → `dm.fog.paint` (set = reveal, clear = hide).
 * @param {{cells: {col: number, row: number}[], op: 'set'|'clear'}} paint
 * @returns {{t: 'dm.fog.paint', p: {cells: {col: number, row: number}[], op: 'reveal'|'hide'}}}
 */
export function fogPaintIntent(paint) {
  return { t: 'dm.fog.paint', p: { cells: paint.cells.map(c => ({ col: c.col, row: c.row })), op: paint.op === 'clear' ? 'hide' : 'reveal' } };
}

/**
 * Forge-shaped party / monsters / scene for the shared action builders.
 * @param {object} enc — EncounterState
 * @param {Record<string, object>} sheets
 * @returns {{party: object[], monsters: object[], scene: object}}
 */
export function forgeShapes(enc, sheets = {}) {
  const party = [];
  const monsters = [];
  for (const e of Object.values(enc?.entities || {})) {
    if (e.kind === 'pc') {
      const sheet = sheets[e.sheetRef?.characterId] || {};
      party.push({ ...sheet, id: e.id, name: e.name, conditions: conditionIds(e), _position: e.pos, hp: { ...(sheet.hp || {}), current: e.hp, max: e.hpMax } });
    } else if (e.hp > 0) {
      monsters.push({ id: e.id, name: e.name, presetSlug: e.statBlock?.slug, position: e.pos, _position: e.pos, conditions: conditionIds(e), hp: { current: e.hp, max: e.hpMax }, ac: e.ac });
    }
  }
  return { party, monsters, scene: { cols: enc?.grid?.cols || 1, rows: enc?.grid?.rows || 1, flankingEnabled: !!enc?.grid?.flankingEnabled, positions: {}, monsters } };
}

/**
 * Reaction dialog text for a prompt.open payload.
 * @param {object} prompt — prompt.open payload
 * @param {object|null} enc
 * @returns {{title: string, body: string, minLevel: number}}
 */
export function reactionCopy(prompt, enc) {
  const p = prompt.payload || {};
  const n = (id) => nameOf(enc, id);
  const who = n(p.reactorId);
  if (prompt.kind === 'shield') {
    return { title: `Cast Shield? (${who})`, body: `${p.attackerId ? `${n(p.attackerId)}'s ` : ''}${p.total ?? '?'} vs your AC ${p.ac ?? '?'} — +5 AC would turn the hit into a miss.`, minLevel: 1 };
  }
  if (prompt.kind === 'counterspell') {
    return { title: `Counterspell? (${who})`, body: `${p.casterId ? n(p.casterId) : 'An enemy'} is casting ${p.spellId || 'a spell'}.`, minLevel: 3 };
  }
  return { title: `Opportunity attack? (${who})`, body: `${p.moverId || p.targetId ? n(p.moverId || p.targetId) : 'A creature'} is leaving your reach.`, minLevel: 0 };
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
  const send = (intent) => ctx.send(intent);
  let disposed = false;

  const view = h(doc, 'section', { class: 'play-view play-battle' });
  const status = h(doc, 'p', { class: 'play-status', attrs: { role: 'status', 'aria-live': 'polite' } });
  const say = (msg, kind = 'info') => { status.textContent = msg || ''; status.dataset.kind = kind; };
  const fail = (e) => say(e?.message || String(e), 'error');
  const waiting = h(doc, 'p', { class: 'play-waiting', attrs: { 'aria-live': 'polite' } });
  const roundEl = h(doc, 'span', { class: 'play-round' });
  const cinemaToggle = h(doc, 'input', { type: 'checkbox', checked: true, dataset: { action: 'cinema-toggle' }, attrs: { 'aria-label': 'Play cinema' } });
  const fogSel = h(doc, 'select', { class: 'play-fog-brush', hidden: true, dataset: { action: 'fog-mode' }, attrs: { 'aria-label': 'Fog brush' } }, [
    h(doc, 'option', { value: 'off', text: 'Fog brush: off' }),
    h(doc, 'option', { value: 'reveal', text: 'Fog brush: reveal' }),
    h(doc, 'option', { value: 'hide', text: 'Fog brush: hide' })
  ]);
  const header = h(doc, 'div', { class: 'play-battle-head' }, [
    roundEl, waiting, fogSel,
    h(doc, 'label', { class: 'play-cinema-toggle' }, [cinemaToggle, ' Cinema']),
    h(doc, 'button', { type: 'button', class: 'play-btn', dataset: { action: 'skip' }, text: 'Skip' })
  ]);
  const canvas = h(doc, 'canvas', { class: 'play-map-canvas', attrs: { 'aria-label': 'Battle map' } });
  const cinemaCanvas = deps.cinemaCanvas === false ? null : h(doc, 'canvas', { class: 'play-cinema', hidden: true, width: 640, height: 360, attrs: { 'aria-label': 'Combat cinema' } });
  const promptHost = h(doc, 'div', { class: 'play-prompt-host reaction-prompt-host' });
  const mine = h(doc, 'div', { class: 'play-card play-mine' });
  const initStrip = h(doc, 'div', { class: 'play-card play-initiative initiative-tracker' });
  const actions = h(doc, 'div', { class: 'play-card play-actions' });
  const log = h(doc, 'ol', { class: 'play-log roll-log-list' });
  view.appendChild(header);
  view.appendChild(status);
  view.appendChild(h(doc, 'div', { class: 'play-battle-grid' }, [
    h(doc, 'div', { class: 'play-battle-map' }, [canvas, cinemaCanvas, promptHost]),
    h(doc, 'div', { class: 'play-battle-side' }, [mine, initStrip, actions, h(doc, 'div', { class: 'play-card' }, [h(doc, 'h3', { text: 'Fight log' }), log])])
  ]));
  root.appendChild(view);

  // ---- render adapter + camera ----
  const adapter = createRenderAdapter({
    canvas,
    store: ctx.store,
    appearanceCache: ctx.appearanceCache,
    cinemaCanvas: deps.cinema ? null : cinemaCanvas,
    cinema: deps.cinema || null,
    cinemaOptions: deps.cinemaOptions || {},
    render: deps.render,
    schedulerOpts: { raf: deps.raf, caf: deps.caf },
    timers: deps.timers,
    onExchangeDone: (exchangeId) => {
      if (exchangeId) attempt(() => send({ t: 'cinema.done', p: { exchangeId: String(exchangeId) } }), () => {});
    }
  });
  scope.add(() => adapter.dispose());
  if (ctx.session?.setPlayback) scope.add(ctx.session.setPlayback(adapter));
  if (ctx.onSheet) scope.add(ctx.onSheet(() => { adapter.invalidate(); renderActions(); }));
  const local = adapter.local;
  local.camera.viewW = canvas.clientWidth || local.camera.viewW || 640;
  local.camera.viewH = canvas.clientHeight || local.camera.viewH || 420;
  if (isDm(ctx.store.getState())) local.dm = { showTerrain: true, showHidden: true };
  let fittedFor = '';
  function fitIfNeeded(enc) {
    if (!enc) return;
    const key = `${enc.encounterId}:${enc.grid.cols}x${enc.grid.rows}`;
    if (key === fittedFor) return;
    fittedFor = key;
    Object.assign(local.camera, fitToGrid(local.camera, enc.grid.cols, enc.grid.rows, WORLD_CELL_PX, { padding: 8 }));
  }
  const gridOf = () => ctx.store.getPresented().encounter?.grid || { cols: 1, rows: 1 };
  scope.add(observeCanvasSize(canvas, local.camera, () => { fittedFor = ''; fitIfNeeded(ctx.store.getPresented().encounter); adapter.redraw(); }));
  scope.add(attachCameraControls(canvas, local.camera, () => adapter.redraw(), { worldSize: () => ({ w: gridOf().cols * WORLD_CELL_PX, h: gridOf().rows * WORLD_CELL_PX }) }));

  // ---- pointer: drag to move, click to target / select ----
  let pick = null;   // {kind: 'attack', weaponName} | {kind: 'cast', spellId, targetSide}
  let drag = null;
  const sheets = () => (typeof ctx.sheets === 'function' ? ctx.sheets() : (ctx.sheets || {}));
  const cellOf = (e) => pickCell(e.clientX, e.clientY, local.camera, WORLD_CELL_PX, canvas.getBoundingClientRect());
  const entityAt = (enc, cell) => Object.values(enc?.entities || {}).find(x => x.pos && x.pos.col === cell.col && x.pos.row === cell.row && x.hp > 0)
    || Object.values(enc?.entities || {}).find(x => x.pos && x.pos.col === cell.col && x.pos.row === cell.row) || null;

  function sendTurn(result) {
    if (!result.ok) { say(result.reason || 'Not allowed.', 'error'); return; }
    say('');
    attempt(() => send(result.intent), fail);
  }

  // ---- DM fog brush: E5's stroke brush; a stroke = one dm.fog.paint ----
  const fogBrush = {
    flag: FOG_BRUSH_FLAG, op: 'set', enabled: false,
    onPreview: (cells, op) => {
      local.aoePreview = cells.length ? { cells, color: op === 'clear' ? 'rgba(15,23,42,0.45)' : 'rgba(255,255,255,0.25)', strokeColor: 'rgba(255,255,255,0.8)' } : null;
      adapter.redraw();
    }
  };
  scope.add(attachTerrainBrush(canvas, local.camera, () => ctx.store.getState().encounter?.grid || { cols: 0, rows: 0 }, (paint) => {
    attempt(() => send(fogPaintIntent(paint)).then(() => say('')), fail);
  }, fogBrush));
  // encounter.fog (protocol v1.5): the new bitset reached the screen —
  // redraw the mask and drop a stale brush error.
  scope.add(ctx.store.subscribe((_a, p) => p.encounter?.fog?.revealed ?? null, () => {
    if (status.dataset.kind === 'error') say('');
    adapter.redraw();
  }));

  scope.on(canvas, 'pointerdown', (e) => {
    if (fogBrush.enabled) return;
    if (e.button !== 0 || e.altKey) return;
    const s = ctx.store.getState();
    const enc = s.encounter;
    if (!enc) return;
    const cell = cellOf(e);
    if (ctx.dmBridge?.placing?.()) { ctx.dmBridge.place(cell); return; }
    const hit = entityAt(enc, cell);
    const t = turnInfo(s);
    if (pick && t.mine && hit) {
      const p = pick;
      pick = null;
      renderActions();
      if (p.kind === 'attack') sendTurn(attackIntent(enc, { actorId: t.actorId, turnId: t.turnId, targetId: hit.id, weaponName: p.weaponName, sheets: sheets() }));
      else sendTurn(castIntent(enc, { actorId: t.actorId, turnId: t.turnId, spellId: p.spellId, targetId: hit.id, targetSide: p.targetSide, sheets: sheets() }));
      return;
    }
    if (!hit) return;
    if (isDm(s)) ctx.dmBridge?.select?.(hit.id);
    const canDrag = isDm(s) || (t.mine && hit.id === t.actorId);
    if (!canDrag) return;
    drag = { id: hit.id, pointerId: e.pointerId, to: null, dm: isDm(s) && !(t.mine && hit.id === t.actorId) };
    canvas.setPointerCapture?.(e.pointerId);
  });
  scope.on(canvas, 'pointermove', (e) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const cell = cellOf(e);
    if (drag.to && drag.to.col === cell.col && drag.to.row === cell.row) return;
    drag.to = cell;
    const enc = ctx.store.getState().encounter;
    if (drag.dm) {
      const from = enc.entities[drag.id]?.pos;
      local.pathPreview = from ? { cells: [from, cell], legal: dmMoveIntent(enc, drag.id, cell).ok, costFt: null } : null;
    } else {
      const p = previewMove(enc, drag.id, cell);
      local.pathPreview = p.cells.length ? { cells: p.cells, legal: p.legal, costFt: p.costFt } : null;
    }
    adapter.redraw();
  });
  const endDrag = (e, cancel) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const d = drag;
    drag = null;
    local.pathPreview = null;
    canvas.releasePointerCapture?.(e.pointerId);
    adapter.redraw();
    if (cancel || !d.to) return;
    const s = ctx.store.getState();
    if (d.dm) {
      const r = dmMoveIntent(s.encounter, d.id, d.to);
      if (r.ok) attempt(() => send(r.intent), fail);
      else if (r.reason !== 'no-move') say(`Can't move there: ${r.reason}.`, 'error');
      return;
    }
    const t = turnInfo(s);
    const r = moveIntent(s.encounter, { actorId: d.id, turnId: t.turnId, dest: d.to, sheets: sheets() });
    if (r.ok) { say(''); attempt(() => send(r.intent), fail); }
    else if (r.preview.reason !== 'no-move') {
      say(r.preview.reason === 'over-budget' ? `Too far: ${r.preview.costFt} ft of ${r.preview.budgetFt} ft.` : `Can't move there: ${r.reason || r.preview.reason}.`, 'error');
    }
  };
  scope.on(canvas, 'pointerup', (e) => endDrag(e, false));
  scope.on(canvas, 'pointercancel', (e) => endDrag(e, true));

  // ---- buttons ----
  delegate(scope, view, 'click', {
    skip: () => adapter.skip(),
    attack: (el) => {
      const s = ctx.store.getState();
      const t = turnInfo(s);
      sendTurn(attackIntent(s.encounter, { actorId: t.actorId, turnId: t.turnId, targetId: el.dataset.target, weaponName: el.dataset.weapon || null, sheets: sheets() }));
    },
    cast: (el) => {
      const s = ctx.store.getState();
      const t = turnInfo(s);
      sendTurn(castIntent(s.encounter, { actorId: t.actorId, turnId: t.turnId, spellId: el.dataset.spell, targetId: el.dataset.target || null, targetSide: el.dataset.side || undefined, sheets: sheets() }));
    },
    'pick-attack': (el) => { pick = { kind: 'attack', weaponName: el.dataset.weapon || null }; say('Click a target on the map.'); renderActions(); },
    'pick-cast': (el) => { pick = { kind: 'cast', spellId: el.dataset.spell, targetSide: el.dataset.side || undefined }; say('Click a target on the map.'); renderActions(); },
    'cancel-pick': () => { pick = null; say(''); renderActions(); },
    action: (el) => {
      const s = ctx.store.getState();
      const t = turnInfo(s);
      sendTurn(actionIntent(s.encounter, { actorId: t.actorId, turnId: t.turnId, kind: el.dataset.kind, sheets: sheets() }));
    },
    feature: (el) => {
      const s = ctx.store.getState();
      const t = turnInfo(s);
      sendTurn(featureIntent(s.encounter, { actorId: t.actorId, turnId: t.turnId, featureId: el.dataset.feature, sheets: sheets() }));
    },
    delegate: () => {
      const t = turnInfo(ctx.store.getState());
      if (t.turnId) attempt(() => send({ t: 'turn.delegate', p: { turnId: t.turnId } }), fail);
    }
  });
  delegate(scope, view, 'change', {
    'cinema-toggle': (el) => adapter.setCinemaEnabled(!!el.checked),
    'fog-mode': (el) => {
      fogBrush.enabled = el.value !== 'off';
      fogBrush.op = el.value === 'hide' ? 'clear' : 'set';
      say(fogBrush.enabled ? `Paint to ${el.value} cells (Shift or right button does the opposite).` : '');
    }
  });

  // ---- panels ----
  function renderHeader() {
    const s = ctx.store.getPresented();
    const auth = ctx.store.getState();
    const enc = s.encounter;
    roundEl.textContent = enc ? `Round ${Math.max(1, enc.round)}` : '';
    fogSel.hidden = !(isDm(auth) && enc?.fog);
    const t = turnInfo(auth);
    let text = '';
    const st = auth.room?.status;
    if (st === 'paused') text = isDm(auth) ? 'Paused — resume from the DM panel.' : 'The DM paused the game.';
    else if (st === 'encounter-over' || enc?.phase === 'ended') text = 'The encounter is over.';
    else if (st === 'setup') text = 'The DM is preparing the encounter…';
    else if (t.actor && t.mine) text = `Your turn: ${t.actor.name}.`;
    else if (t.actor && t.dmControlled) text = 'DM is reviewing…';
    else if (t.actor) text = `${t.actor.name} is acting…`;
    waiting.textContent = text;
  }

  function renderMine() {
    const s = ctx.store.getPresented();
    const enc = s.encounter;
    const ids = myEntityIds(ctx.store.getState());
    local.ownEntityId = ids[0] || null;
    if (!enc || !ids.length) {
      replace(doc, mine, [h(doc, 'h3', { text: isDm(s) ? 'DM' : 'Your character' }), h(doc, 'p', { class: 'hint-line', text: isDm(s) ? 'Use the DM panel to run the table.' : 'You control no creature in this encounter.' })]);
      return;
    }
    replace(doc, mine, ids.map((id) => {
      const e = enc.entities[id];
      if (!e) return null;
      const slots = slotsLeft(e);
      const badge = statusBadge(e);
      return h(doc, 'div', { class: `play-me${badge ? ` ${badge.cls}` : ''}` }, [
        h(doc, 'h3', {}, [e.name, badge ? h(doc, 'span', { class: `play-badge ${badge.cls}`, text: badge.label }) : null]),
        deathBanner(s, e),
        h(doc, 'div', { class: `play-hp${e.hp === 0 ? ' down' : ''}`, text: `HP ${e.hp} / ${e.hpMax}${e.hpTemp ? ` (+${e.hpTemp} temp)` : ''}` }),
        h(doc, 'div', { class: 'play-ac', text: `AC ${e.ac} · speed ${e.speedFt} ft` }),
        slots.length ? h(doc, 'div', { class: 'play-slots', text: `Slots ${slots.map(x => `L${x.level} ${x.left}/${x.max}`).join(' · ')}` }) : null,
        h(doc, 'div', { class: 'play-conditions' }, conditionIds(e).map(c => h(doc, 'span', { class: 'play-chip condition', text: c })))
      ]);
    }));
  }

  /** The death-save banner on a downed / stable / dead creature's card. */
  function deathBanner(s, e) {
    const info = deathSaveInfo(s, e.id);
    if (!info || info.status === 'down') return null;
    const pips = (n, cls) => Array.from({ length: 3 }, (_, i) => h(doc, 'span', { class: `play-pip ${cls}${i < n ? ' on' : ''}`, text: i < n ? '●' : '○' }));
    const tally = h(doc, 'div', { class: 'play-death-tally' }, [
      h(doc, 'span', { class: 'dim', text: 'Saves ' }), ...pips(info.successes, 'ok'),
      h(doc, 'span', { class: 'dim', text: ' Fails ' }), ...pips(info.failures, 'bad')
    ]);
    let headline;
    if (info.status === 'dead') headline = `${e.name} is dead.`;
    else if (info.status === 'stable') headline = `${e.name} is stable — unconscious, no more death saves.`;
    else if (info.last && info.last.thisTurn) {
      const l = info.last;
      headline = l.cause === 'damage'
        ? `Hit while dying: ${l.crit ? 'two failures' : 'one failure'}.`
        : `Death save: d20 = ${l.d20 ?? '?'} — ${l.crit && l.success ? 'natural 20, you regain 1 HP!' : l.crit ? 'natural 1, two failures.' : l.success ? 'success.' : 'failure.'}`;
    } else headline = `${e.name} is dying — the server rolls a death save at the start of each turn.`;
    const t = turnInfo(ctx.store.getState());
    return h(doc, 'div', {
      class: `play-death-banner ${info.status}${t.actorId === e.id ? ' my-turn' : ''}`,
      attrs: { role: info.last?.thisTurn ? 'alert' : 'status' }
    }, [h(doc, 'strong', { text: headline }), tally,
      info.status === 'downed' ? h(doc, 'p', { class: 'hint-line', text: 'Allies can heal you back up; "Help / stabilize" comes in phase 2.' }) : null]);
  }

  function renderInitiative() {
    const enc = ctx.store.getPresented().encounter;
    if (!enc || !enc.initiative?.length) { replace(doc, initStrip, [h(doc, 'p', { class: 'hint-line', text: 'Initiative appears when the encounter starts.' })]); return; }
    const running = enc.phase === 'running' || enc.phase === 'awaiting-prompt';
    replace(doc, initStrip, [
      h(doc, 'h3', { text: `Initiative · round ${Math.max(1, enc.round)}` }),
      ...enc.initiative.map((r, i) => {
        const e = enc.entities[r.entityId];
        const badge = statusBadge(e);
        return h(doc, 'div', { class: `init-row${running && i === enc.turnIndex ? ' active' : ''}${e && e.hp === 0 ? ' down' : ''}${badge ? ` ${badge.cls}` : ''}` }, [
          h(doc, 'span', { class: 'init-score', text: String(r.score) }),
          h(doc, 'span', { class: 'init-name', text: e?.name || r.entityId }),
          badge ? h(doc, 'span', { class: `play-badge ${badge.cls}`, text: badge.label }) : null,
          h(doc, 'span', { class: 'init-kind', text: e?.kind === 'pc' ? 'PC' : 'M' })
        ]);
      })
    ]);
  }

  function attackButtons(list, t) {
    const out = [];
    for (const a of list) {
      const weaponName = a.weapon?.name || a.name;
      out.push(h(doc, 'div', { class: `play-action${a.available ? '' : ' blocked'}` }, [
        h(doc, 'strong', { text: `${a.name} ${a.bonus >= 0 ? '+' : ''}${a.bonus ?? 0}` }),
        h(doc, 'span', { class: 'dim', text: ` ${a.dice || ''}${a.damageType ? ` ${a.damageType}` : ''}` }),
        a.available
          ? h(doc, 'span', { class: 'play-targets' }, [
              ...a.targetsInRange.map(tg => h(doc, 'button', { type: 'button', class: 'play-btn small', dataset: { action: 'attack', weapon: weaponName, target: tg.entity.id }, text: `→ ${tg.entity.name}${tg.distance != null ? ` (${tg.distance} ft)` : ''}` })),
              h(doc, 'button', { type: 'button', class: 'play-btn small', dataset: { action: 'pick-attack', weapon: weaponName }, text: 'pick on map' })
            ])
          : h(doc, 'span', { class: 'play-blocked', text: a.blockReason || '' }),
        ...(a.hints || []).map(x => h(doc, 'div', { class: 'hint-line', text: x }))
      ]));
    }
    void t;
    return out;
  }

  function featureButtons(actor) {
    const sheet = actor.kind === 'pc' ? sheets()[actor.sheetRef?.characterId] : null;
    return featureActionsFor(actor, sheet).map(f => h(doc, 'div', { class: `play-action play-feature${f.available ? '' : ' blocked'}` }, [
      h(doc, 'strong', { text: f.label }),
      h(doc, 'span', { class: 'dim', text: ` ${f.hint} · ${f.max >= 99 ? 'unlimited' : `${f.left}/${f.max} left`} ` }),
      f.available
        ? h(doc, 'button', { type: 'button', class: 'play-btn small', dataset: { action: 'feature', feature: f.id }, text: `Use ${f.label}` })
        : h(doc, 'span', { class: 'play-blocked', text: f.reason })
    ]));
  }

  function spellButtons(list, shapes) {
    return list.map((sp) => {
      const id = nameToSpellId(sp.name);
      const reg = spellById(id);
      if (!reg) return h(doc, 'div', { class: 'play-action blocked' }, [h(doc, 'strong', { text: sp.name }), h(doc, 'span', { class: 'play-blocked', text: ' — ask the DM to adjudicate' })]);
      const side = reg.targetSide === 'ally' || reg.kind === 'heal' ? 'ally' : 'enemy';
      const targets = side === 'ally' ? shapes.party : (sp.targetsInRange?.length ? sp.targetsInRange.map(x => x.entity) : shapes.monsters);
      return h(doc, 'div', { class: 'play-action' }, [
        h(doc, 'strong', { text: `${sp.name}${sp.level ? ` (L${sp.level})` : ''}` }),
        h(doc, 'span', { class: 'play-targets' }, [
          ...targets.slice(0, 6).map(tg => h(doc, 'button', { type: 'button', class: 'play-btn small', dataset: { action: 'cast', spell: id, target: tg.id, side }, text: `→ ${tg.name}` })),
          h(doc, 'button', { type: 'button', class: 'play-btn small', dataset: { action: 'pick-cast', spell: id, side }, text: 'pick on map' })
        ])
      ]);
    });
  }

  function renderActions() {
    const s = ctx.store.getState();
    const enc = s.encounter;
    const t = turnInfo(s);
    if (!enc || !t.mine || !t.actor || s.room?.status === 'paused') {
      replace(doc, actions, [h(doc, 'h3', { text: 'Actions' }), h(doc, 'p', { class: 'hint-line', text: t.actor && !t.mine ? 'Wait for your turn.' : 'No actions right now.' })]);
      return;
    }
    const shapes = forgeShapes(enc, sheets());
    const me = t.actor.kind === 'pc' ? shapes.party.find(p => p.id === t.actor.id) : shapes.monsters.find(m => m.id === t.actor.id);
    let built = { attacks: [], spells: [], blockers: [] };
    let tips = [];
    try {
      built = buildActionsFor({ entity: me, kind: t.actor.kind, scene: shapes.scene, party: shapes.party, monsters: shapes.monsters });
      tips = buildTurnTips({ entity: me, kind: t.actor.kind, scene: shapes.scene, party: shapes.party, monsters: shapes.monsters, max: 4 });
    } catch (err) {
      globalThis.console?.warn?.(JSON.stringify({ event: 'battle.actions_failed', error: String(err?.message || err) }));
    }
    replace(doc, actions, [
      h(doc, 'h3', { text: `Actions — ${t.actor.name}` }),
      pick ? h(doc, 'div', { class: 'play-pick' }, [h(doc, 'span', { text: 'Picking a target on the map… ' }), h(doc, 'button', { type: 'button', class: 'play-btn small', dataset: { action: 'cancel-pick' }, text: 'Cancel' })]) : null,
      ...(built.blockers || []).map(b => h(doc, 'p', { class: 'play-blocked', text: b })),
      ...attackButtons(built.attacks || [], t),
      ...spellButtons(built.spells || [], shapes),
      ...featureButtons(t.actor),
      h(doc, 'div', { class: 'play-row play-common' }, [
        ...['dash', 'dodge', 'disengage'].map(k => h(doc, 'button', { type: 'button', class: 'play-btn', dataset: { action: 'action', kind: k }, text: k[0].toUpperCase() + k.slice(1) })),
        t.actor.kind === 'pc' ? h(doc, 'button', { type: 'button', class: 'play-btn', dataset: { action: 'delegate' }, text: 'Let the AI play this turn' }) : null
      ]),
      h(doc, 'p', { class: 'hint-line', text: 'Drag your token to move (green = in reach, red = too far).' }),
      tips.length ? h(doc, 'ul', { class: 'play-tips' }, tips.map(tp => h(doc, 'li', { text: tp.text || tp.message || String(tp.title || '') }))) : null
    ]);
  }

  let lastLogSeq = 0;
  let lastHiddenSeq = 0;
  const swings = new Map();   // cinemaGroup → {n, targetId}: Extra Attack swing numbering
  function swingOf(ev) {
    if (ev.type !== 'attack.rolled' || !ev.cinemaGroup || ev.payload?.isReaction) return {};
    const prev = swings.get(ev.cinemaGroup);
    const n = (prev?.n ?? 0) + 1;
    swings.set(ev.cinemaGroup, { n, targetId: ev.payload.targetId });
    if (swings.size > 64) swings.delete(swings.keys().next().value);
    return { swing: n, retarget: !!prev && prev.targetId !== ev.payload.targetId };
  }
  function renderLog() {
    const s = ctx.store.getPresented();
    const enc = s.encounter;
    const fresh = (s.history || []).filter(ev => ev.seq > lastLogSeq);
    const hidden = (s.hidden || []).filter(x => x.seq > lastHiddenSeq);
    if (!fresh.length && !hidden.length) return;
    if (fresh.length) lastLogSeq = fresh[fresh.length - 1].seq;
    if (hidden.length) lastHiddenSeq = hidden[hidden.length - 1].seq;
    const items = [...fresh, ...hidden.map(x => ({ seq: x.seq, redacted: x.type }))].sort((a, b) => a.seq - b.seq);
    for (const ev of items) {
      const line = ev.redacted ? formatRedacted(ev.redacted) : formatEvent(ev, (id) => nameOf(enc, id), swingOf(ev));
      if (!line) continue;
      const li = h(doc, 'li', { class: `roll-log-entry ${line.cls}${line.dm ? ' roll-dm' : ''}`, dataset: { seq: ev.seq }, text: line.text });
      log.insertBefore(li, log.firstChild || null);
    }
    while (log.children.length > LOG_LIMIT) log.removeChild(log.lastChild);
  }

  // ---- reaction prompts ----
  let shownPrompt = null;
  function syncPrompt() {
    const s = ctx.store.getState();
    const p = s.openPrompt;
    if (!p || !REACTION_KINDS.includes(p.kind)) {
      if (shownPrompt) { shownPrompt = null; replace(doc, promptHost, []); }
      return;
    }
    if (shownPrompt === p.promptId) return;
    shownPrompt = p.promptId;
    const enc = s.encounter;
    const copy = reactionCopy(p, enc);
    const reactor = enc?.entities?.[p.payload?.reactorId] || null;
    const nowMs = ctx.session?.serverNow?.() ?? p.serverNow;
    const remaining = Math.max(0, (p.deadlineAt ?? nowMs) - nowMs);
    const ask = deps.promptReaction;
    if (typeof ask !== 'function') return;
    Promise.resolve(ask({
      title: copy.title,
      body: copy.body,
      costLabel: copy.minLevel > 0 ? reactionCostLabel(reactor, copy.minLevel) : '1 reaction',
      defaultMs: remaining,
      auto: false,
      container: promptHost
    })).then((accepted) => {
      if (disposed || shownPrompt !== p.promptId) return;
      shownPrompt = null;
      attempt(() => send({ t: 'prompt.answer', p: { promptId: p.promptId, answer: !!accepted } }), (e) => { if (e.code !== 'E_STALE') fail(e); });
    });
  }

  function renderAll() {
    fitIfNeeded(ctx.store.getPresented().encounter);
    renderHeader();
    renderMine();
    renderInitiative();
    renderActions();
    renderLog();
    syncPrompt();
  }

  const same = (x, y) => x.every((v, i) => v === y[i]);
  scope.add(ctx.store.subscribe((a, p) => [p.encounter, p.history, p.hidden, a.room, a.seats, a.history, a.encounter, a.openPrompt], renderAll, same));
  renderAll();

  return function unmount() {
    disposed = true;
    scope.dispose();
    if (view.parentNode) view.parentNode.removeChild(view);
  };
}
