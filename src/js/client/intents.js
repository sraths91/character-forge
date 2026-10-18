/**
 * M64 M8 — intent adapters: turn a pointer gesture or an action pick into
 * a protocol intent, with instant client-side feedback.
 *
 *   drag (own turn)  → previewMove → `turn.act {turnId, plan: {kind: 'move', moveTo, path}}`
 *                      an illegal / over-budget drag previews red and builds NO intent
 *   DM free move     → `dm.entity.patch {entityId, position, override: true}`
 *   attack / cast    → `turn.act {turnId, plan}`; `validateIntent` (E1's T9
 *                      validator, the same one the server runs) answers first
 *   teleport cast    → previewMove with `teleport: true` (straight line, no
 *                      path, no opportunity attacks) → `turn.act {plan:
 *                      {kind: 'cast', spellId, castAtLevel, moveTo}}` (Misty Step)
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
import { chebyshevFeet } from '../scene/grid-rules.js';
import { spellById } from '../scene/monster-spells.js';

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
 * @param {{budgetFt?: number, ignoreBudget?: boolean, teleport?: boolean}} [opts] — budget
 *   defaults to the actor's speedFt. `teleport`: a spell's straight-line
 *   hop (Misty Step) — no path, terrain or opportunity attacks; the
 *   distance is Chebyshev feet like the server's validator, and the
 *   destination must be on the grid and empty.
 * @returns {{legal: boolean, reason: string|null, cells: {col: number, row: number}[],
 *            costFt: number|null, budgetFt: number, oaTriggers: object[], teleport?: true}}
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
  if (opts.teleport) return previewTeleport(state, actorId, from, dest, budgetFt);
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

function previewTeleport(state, actorId, from, dest, budgetFt) {
  const cells = [from, { col: dest.col, row: dest.row }];
  const costFt = chebyshevFeet(from, dest);
  // intent-validation: any other creature's cell (down or not) is taken.
  const taken = Object.values(state.entities || {}).some(e => String(e.id) !== String(actorId) && e.pos && e.pos.col === dest.col && e.pos.row === dest.row);
  const reason = taken ? 'destination-occupied' : costFt > budgetFt ? 'over-budget' : null;
  return { legal: !reason, reason, cells, costFt, budgetFt, oaTriggers: [], teleport: true };
}

/**
 * The lowest spell-slot level >= `minLevel` the entity has left (regular
 * pool, then its pact slot), or `minLevel` when none is (the validator
 * then explains).
 * @param {object|null} entity — EncounterState entity
 * @param {number} minLevel
 * @returns {number}
 */
export function lowestSlotLevel(entity, minLevel) {
  const min = Math.max(0, minLevel | 0);
  if (min === 0) return 0;
  const res = entity?.resources || {};
  const levels = [];
  for (const [lvl, l] of Object.entries(res.slots || {})) if (Number(lvl) >= min && l && l.max - l.spent > 0) levels.push(Number(lvl));
  const pact = res.pact;
  if (pact && Number.isInteger(pact.level) && pact.level >= min && (pact.max ?? 0) - (pact.spent ?? 0) > 0) levels.push(pact.level);
  return levels.length ? Math.min(...levels) : min;
}

/**
 * Whether a registry spell is cast as a self-teleport to a picked cell.
 * @param {string} spellId
 * @returns {number|null} its range in feet, or null for any other spell
 */
export function teleportRangeFt(spellId) {
  const reg = spellById(spellId);
  return reg && reg.kind === 'teleport' ? (reg.teleportFt ?? 30) : null;
}

/**
 * Teleport spell (Misty Step) + destination cell → `turn.act {plan:
 * {kind: 'cast', spellId, castAtLevel, moveTo}}` — no target, no path.
 * @param {object} state
 * @param {{actorId: string, turnId: string|null, spellId: string, dest: {col: number, row: number},
 *          castAtLevel?: number|null, sheets?: Record<string, object>}} args
 * @returns {{ok: boolean, intent: object|null, preview: object, reason: string|null, code: string|null}}
 */
export function teleportIntent(state, { actorId, turnId, spellId, dest, castAtLevel = null, sheets }) {
  const rangeFt = teleportRangeFt(spellId);
  const preview = previewMove(state, actorId, dest, { teleport: true, budgetFt: rangeFt ?? 0 });
  if (rangeFt == null) return { ok: false, intent: null, preview, reason: `${spellId} is not a teleport spell`, code: 'bad-plan' };
  if (!preview.legal) {
    const reason = preview.reason === 'over-budget' ? `Too far: ${preview.costFt} ft of ${rangeFt} ft.` : preview.reason;
    return { ok: false, intent: null, preview, reason, code: preview.reason };
  }
  const level = Number.isInteger(castAtLevel) ? castAtLevel : lowestSlotLevel(state.entities[actorId], spellById(spellId).level || 0);
  const plan = { kind: 'cast', spellId: String(spellId), castAtLevel: level, moveTo: { col: dest.col, row: dest.row } };
  return { ...finish(state, actorId, turnId, plan, sheets), preview };
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

/**
 * Class features a PC can spend its action on (E1 wave 5 `feature`
 * plans): the class that grants it and uses per encounter by level.
 */
export const FEATURE_ACTIONS = Object.freeze([
  { id: 'second-wind', label: 'Second Wind', className: 'Fighter', uses: () => 1, hint: 'heal 1d10 + level' },
  {
    id: 'rage', label: 'Rage', className: 'Barbarian', blockedBy: 'raging', hint: 'resist weapon damage, bonus melee damage',
    uses: (lvl) => (lvl >= 20 ? 99 : lvl >= 17 ? 6 : lvl >= 12 ? 5 : lvl >= 6 ? 4 : lvl >= 3 ? 3 : 2)
  }
]);

/**
 * The feature actions an entity's sheet grants, with uses left (the
 * encounter ledger when it tracks the feature, else the class table).
 * @param {object|null} entity — EncounterState entity
 * @param {object|null} sheet — parsed character sheet
 * @returns {{id: string, label: string, hint: string, left: number, max: number, available: boolean, reason: string|null}[]}
 */
export function featureActionsFor(entity, sheet) {
  if (!entity || entity.kind !== 'pc') return [];
  const out = [];
  for (const f of FEATURE_ACTIONS) {
    const cls = (sheet?.classes || []).find(c => new RegExp(`^${f.className}$`, 'i').test(String(c?.name || '')));
    if (!cls) continue;
    const ledger = entity.resources?.features?.[f.id];
    const max = Number.isInteger(ledger?.max) && ledger.max > 0 ? Math.max(ledger.max, f.uses(cls.level || 1)) : f.uses(cls.level || 1);
    const left = Math.max(0, max - (ledger?.spent ?? 0));
    const active = f.blockedBy && (entity.conditions || []).some(c => (typeof c === 'string' ? c : c?.id) === f.blockedBy);
    const reason = active ? `already ${f.blockedBy}` : left <= 0 ? 'no uses left' : null;
    out.push({ id: f.id, label: f.label, hint: f.hint, left, max, available: !reason, reason });
  }
  return out;
}

/**
 * Feature action → `turn.act {plan: {kind: 'feature', featureId, features: [featureId]}}`.
 * @param {object} state
 * @param {{actorId: string, turnId: string|null, featureId: string, sheets?: Record<string, object>}} args
 * @returns {{ok: boolean, intent: object|null, reason: string|null, code: string|null}}
 */
export function featureIntent(state, { actorId, turnId, featureId, sheets }) {
  const plan = { kind: 'feature', featureId: String(featureId), features: [String(featureId)] };
  const r = finish(state, actorId, turnId, plan, sheets);
  if (r.ok || r.code !== 'bad-feature') return r;
  // main's validateIntent asks pc-features `available()` with a wrapper
  // whose classes sit under `ref`, so it refuses every feature (reported
  // to E1). Our own sheet check decides; the server stays the judge.
  const e = state?.entities?.[actorId];
  const sheet = e?.sheetRef ? (sheets || {})[e.sheetRef.characterId] : null;
  const mine = featureActionsFor(e, sheet).find(f => f.id === plan.featureId);
  if (mine?.available) return { ok: true, intent: turnAct(turnId, plan), reason: null, code: null };
  return mine ? { ...r, reason: `${mine.label}: ${mine.reason}` } : r;
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
