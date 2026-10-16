/**
 * M64 M8 — intent adapters: turn a pointer gesture or an action pick into
 * a protocol intent, with instant client-side feedback.
 *
 *   drag (own turn)  → previewMove → `turn.act {turnId, plan: {kind: 'move', moveTo, path}}`
 *                      an illegal / over-budget drag previews red and builds NO intent
 *   DM free move     → `dm.entity.patch {entityId, position, override: true}`
 *   attack / cast    → `turn.act {turnId, plan}`; `validateIntent` (E1's T9
 *                      validator, the same one the server runs) answers first
 *
 * The server stays authoritative: these helpers only decide what is worth
 * sending and what to show while the user drags. `forcePlanFor` is the
 * engine-side twin (`planFromIntent`) for the forge's local versus page,
 * which has no server.
 *
 * Pure: no DOM, no clock. Works on an EncounterState (full or projected).
 */

import { findPath, reachableCells, validateMove, buildOccupancy } from '../scene/grid-legality.js';
import { validateIntent, planFromIntent } from '../scene/intent-validation.js';
import { INTENT_PLAN_KINDS } from '../shared/protocol.js';

/** Longest path a `turn.act` plan may carry (protocol PLAN.path max). */
export const MAX_PLAN_PATH = 64;

const posKey = (p) => `${p.col},${p.row}`;

function boundsOf(state) {
  return { cols: state?.grid?.cols || 1, rows: state?.grid?.rows || 1 };
}

/**
 * The turn the room is on: the last `turn.started` in the client's history
 * (its envelope `turnId`), or the snapshot's `room.turn`.
 * @param {object} clientState — client/store.js state (authoritative or presented)
 * @returns {{turnId: string|null, actorId: string|null}}
 */
export function currentTurn(clientState) {
  const hist = clientState?.history || [];
  for (let i = hist.length - 1; i >= 0; i--) {
    const ev = hist[i];
    if (ev?.type === 'turn.ended' || ev?.type === 'turn.skipped' || ev?.type === 'encounter.ended') break;
    if (ev?.type === 'turn.started') return { turnId: ev.turnId ?? null, actorId: ev.payload?.actorId ?? null };
  }
  const t = clientState?.room?.turn;
  if (t && t.turnId) return { turnId: t.turnId, actorId: t.actorId ?? null };
  return { turnId: null, actorId: null };
}

/**
 * Preview a drag from the actor's cell to `dest`: the cheapest legal path
 * within the budget, or the over-budget / blocked path in red.
 *
 * @param {object} state — EncounterState
 * @param {string} actorId
 * @param {{col: number, row: number}} dest
 * @param {{budgetFt?: number, ignoreBudget?: boolean}} [opts] — budget defaults to the actor's speedFt
 * @returns {{legal: boolean, reason: string|null, cells: {col: number, row: number}[],
 *            costFt: number|null, budgetFt: number, oaTriggers: object[]}}
 *   `cells` is the preview (start included) for E5's `local.pathPreview`.
 */
export function previewMove(state, actorId, dest, opts = {}) {
  const actor = state?.entities?.[actorId];
  const budgetFt = opts.ignoreBudget ? Infinity
    : (Number.isFinite(opts.budgetFt) ? opts.budgetFt : (actor?.speedFt ?? 30));
  const none = (reason, cells = []) => ({ legal: false, reason, cells, costFt: null, budgetFt, oaTriggers: [] });
  if (!actor || !actor.pos) return none('unknown-mover');
  if (!dest || !Number.isInteger(dest.col) || !Number.isInteger(dest.row)) return none('no-destination');
  const from = actor.pos;
  if (from.col === dest.col && from.row === dest.row) return { legal: false, reason: 'no-move', cells: [], costFt: 0, budgetFt, oaTriggers: [] };
  const bounds = boundsOf(state);
  if (dest.col < 0 || dest.row < 0 || dest.col >= bounds.cols || dest.row >= bounds.rows) return none('out-of-bounds', [from]);
  const terrain = state.grid?.terrain ?? null;
  const occ = buildOccupancy(state.entities, { excludeId: actorId });
  const findOpts = { moverSide: actor.side, bounds };
  const within = findPath(terrain, occ, from, dest, { ...findOpts, budgetFt });
  if (within) {
    const v = validateMove(state, actorId, within.path, { budgetFt });
    return {
      legal: v.legal, reason: v.reason, cells: within.path, costFt: v.costFt,
      budgetFt, oaTriggers: v.oaTriggers
    };
  }
  const any = findPath(terrain, occ, from, dest, findOpts);
  if (any) return { legal: false, reason: 'over-budget', cells: any.path, costFt: any.costFt, budgetFt, oaTriggers: [] };
  const occupied = occ.cells.has(posKey(dest));
  return none(occupied ? 'destination-occupied' : 'unreachable', [from, { col: dest.col, row: dest.row }]);
}

/**
 * Every cell the actor could end a move in this turn (for a reach overlay).
 * @param {object} state
 * @param {string} actorId
 * @param {{budgetFt?: number}} [opts]
 * @returns {{col: number, row: number}[]}
 */
export function reachableFor(state, actorId, opts = {}) {
  const actor = state?.entities?.[actorId];
  if (!actor?.pos) return [];
  const budgetFt = Number.isFinite(opts.budgetFt) ? opts.budgetFt : (actor.speedFt ?? 30);
  const occ = buildOccupancy(state.entities, { excludeId: actorId });
  const cells = reachableCells(state.grid?.terrain ?? null, occ, actor.pos, { budgetFt, moverSide: actor.side, bounds: boundsOf(state) });
  return [...cells.keys()].map(k => { const [col, row] = k.split(',').map(Number); return { col, row }; });
}

/**
 * Client-side check of a plan before sending (instant feedback). Returns
 * the validator's verdict; `{ok: true}` does not promise the server agrees.
 * @param {object} state — EncounterState
 * @param {string} actorId
 * @param {object} plan — protocol turn.act plan
 * @param {{sheets?: Record<string, object>, checkTurn?: boolean}} [opts]
 * @returns {{ok: true}|{ok: false, code: string, reason: string}}
 */
export function checkPlan(state, actorId, plan, opts = {}) {
  if (!plan || !INTENT_PLAN_KINDS.includes(plan.kind)) return { ok: false, code: 'bad-plan', reason: `unknown plan kind ${plan?.kind}` };
  try {
    return validateIntent(state, { actorId, plan }, { sheets: opts.sheets || {}, checkTurn: opts.checkTurn });
  } catch (error) {
    return { ok: false, code: 'client-check-failed', reason: String(error?.message || error) };
  }
}

function turnAct(turnId, plan) {
  return { t: 'turn.act', p: { turnId: String(turnId), plan } };
}

/**
 * Drag → move intent. Nothing is built when the preview is not legal.
 * @param {object} state
 * @param {{actorId: string, turnId: string|null, dest: {col: number, row: number},
 *          budgetFt?: number, sheets?: Record<string, object>}} args
 * @returns {{ok: boolean, intent: object|null, preview: object, reason: string|null}}
 */
export function moveIntent(state, { actorId, turnId, dest, budgetFt, sheets }) {
  const preview = previewMove(state, actorId, dest, { budgetFt });
  if (!preview.legal) return { ok: false, intent: null, preview, reason: preview.reason };
  if (!turnId) return { ok: false, intent: null, preview, reason: 'no-turn' };
  const plan = { kind: 'move', moveTo: { col: dest.col, row: dest.row } };
  if (preview.cells.length <= MAX_PLAN_PATH) plan.path = preview.cells.map(c => ({ col: c.col, row: c.row }));
  const v = checkPlan(state, actorId, plan, { sheets });
  if (!v.ok) return { ok: false, intent: null, preview: { ...preview, legal: false, reason: v.code }, reason: v.reason };
  return { ok: true, intent: turnAct(turnId, plan), preview, reason: null };
}

/**
 * DM free move: place a token anywhere free on the grid, ignoring speed
 * and opportunity attacks (`override: true`).
 * @param {object} state
 * @param {string} entityId
 * @param {{col: number, row: number}} dest
 * @returns {{ok: boolean, intent: object|null, reason: string|null}}
 */
export function dmMoveIntent(state, entityId, dest) {
  const e = state?.entities?.[entityId];
  if (!e) return { ok: false, intent: null, reason: 'unknown-entity' };
  const b = boundsOf(state);
  if (!dest || dest.col < 0 || dest.row < 0 || dest.col >= b.cols || dest.row >= b.rows) return { ok: false, intent: null, reason: 'out-of-bounds' };
  if (e.pos && e.pos.col === dest.col && e.pos.row === dest.row) return { ok: false, intent: null, reason: 'no-move' };
  const taken = Object.values(state.entities).some(o => String(o.id) !== String(entityId) && o.pos && o.pos.col === dest.col && o.pos.row === dest.row && o.hp > 0);
  if (taken) return { ok: false, intent: null, reason: 'destination-occupied' };
  return {
    ok: true,
    reason: null,
    intent: { t: 'dm.entity.patch', p: { entityId: String(entityId), position: { col: dest.col, row: dest.row }, override: true } }
  };
}

/**
 * Attack pick → turn.act. `kind` defaults to 'attack' (the server resolves
 * melee vs ranged from the weapon).
 * @param {object} state
 * @param {{actorId: string, turnId: string|null, targetId: string, weaponName?: string|null,
 *          features?: string[], moveTo?: {col: number, row: number}|null, sheets?: Record<string, object>}} args
 * @returns {{ok: boolean, intent: object|null, reason: string|null, code: string|null}}
 */
export function attackIntent(state, { actorId, turnId, targetId, weaponName = null, features = [], moveTo = null, sheets }) {
  const plan = { kind: 'attack', targetId: String(targetId), targetSide: 'enemy' };
  if (weaponName) plan.weaponName = String(weaponName);
  if (features.length) plan.features = [...features];
  if (moveTo) plan.moveTo = { col: moveTo.col, row: moveTo.row };
  return finish(state, actorId, turnId, plan, sheets);
}

/**
 * Spell pick → turn.act.
 * @param {object} state
 * @param {{actorId: string, turnId: string|null, spellId: string, targetId?: string|null,
 *          targetSide?: 'enemy'|'ally', castAtLevel?: number|null, sheets?: Record<string, object>}} args
 * @returns {{ok: boolean, intent: object|null, reason: string|null, code: string|null}}
 */
export function castIntent(state, { actorId, turnId, spellId, targetId = null, targetSide, castAtLevel = null, sheets }) {
  const plan = { kind: 'cast', spellId: String(spellId), targetId: targetId == null ? null : String(targetId) };
  if (targetSide) plan.targetSide = targetSide;
  if (Number.isInteger(castAtLevel)) plan.castAtLevel = castAtLevel;
  return finish(state, actorId, turnId, plan, sheets);
}

/**
 * Dash / Dodge / Disengage → turn.act.
 * @param {object} state
 * @param {{actorId: string, turnId: string|null, kind: 'dash'|'dodge'|'disengage', sheets?: object}} args
 * @returns {{ok: boolean, intent: object|null, reason: string|null, code: string|null}}
 */
export function actionIntent(state, { actorId, turnId, kind, sheets }) {
  return finish(state, actorId, turnId, { kind }, sheets);
}

function finish(state, actorId, turnId, plan, sheets) {
  if (!turnId) return { ok: false, intent: null, reason: 'it is not your turn', code: 'no-turn' };
  const v = checkPlan(state, actorId, plan, { sheets });
  if (!v.ok) return { ok: false, intent: null, reason: v.reason, code: v.code };
  return { ok: true, intent: turnAct(turnId, plan), reason: null, code: null };
}

/**
 * The engine forcePlan for a plan (E1's planFromIntent), for the forge's
 * local versus page where the engine runs in the browser.
 * @param {object} state
 * @param {string} actorId
 * @param {object} plan
 * @param {{sheets?: Record<string, object>}} [opts]
 * @returns {object}
 */
export function forcePlanFor(state, actorId, plan, opts = {}) {
  return planFromIntent(state, { actorId, plan }, { sheets: opts.sheets || {} });
}
