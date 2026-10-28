/**
 * M64 phase 1.5 (E2) — the client's encounter mirror: one engine event
 * applied to a projected EncounterState, faithfully enough that
 * `stateHash(mirror)` (shared/state-hash.js) equals the server's
 * `turn.ended.payload.stateHash` without a resync.
 *
 * It replays the engine's own bookkeeping from the event stream:
 *   - turn.started / turn.skipped('incapacitated') — the start-of-turn
 *     resets of turn-manager `beginTurnResets` (reaction, Shield, Dodge,
 *     Disengage, the PC per-turn flags, a legendary monster's budget).
 *     A v1.7 `turn.started {resumed: true}` (a recovered turn announced
 *     again after dm.resume, same turnId) applies them too: a client that
 *     reconnected while the room was paused holds the snapshot's
 *     turn-end state — the journal tail with the original turn.started is
 *     in its history, not in that state — and the resets are idempotent
 *     on a state that already had them;
 *   - turn.ended — the turn manager's victory check, else `advance`
 *     (turnIndex + 1, wrapping into the next round): the server hashes
 *     the state AFTER the index moved;
 *   - plan.chosen — Dodge / Disengage flags, and the AI planner's
 *     `resetPerTurnFlags` (an AI-planned PC action, e.g. the Action Surge
 *     follow-up, clears sneak / cunning / extra-action);
 *   - resource.spent — reaction, spell slot (regular pool first, then
 *     the pact slot of that level), legendary cost, innate uses;
 *   - resource.recharged (events v1.3) — a monster's start-of-turn
 *     recharge roll restored an innate spell (Fire Breath);
 *   - feature.used — Sneak / Reckless / Action Surge / Second Wind /
 *     Divine Smite flags and the per-encounter feature ledger;
 *   - damage (incl. temp HP `absorbed`), heal, exchange effects, move,
 *     condition.* with the R7 lifecycle fields, concentration.*, the
 *     DM's dm.override hp / conditions edits;
 *   - dying (E1 wave 5 shapes, see DEATH below): entity.downed,
 *     death.save, entity.stabilized, entity.revived, entity.died, and the
 *     Rage `rageSustained` flag.
 *
 * Fog (E3 wave 5): a player's view is filterViewForFog'd and events
 * naming a hidden creature arrive masked ('Something', a no-op here) or
 * `redacted`; the turn order then has several consistent outcomes, so
 * `turnEndedCandidates` lists them and the store keeps the hashed one.
 *
 * Pure: the input is never mutated; an untouched entity keeps identity.
 * No DOM, no timers.
 */

import { freshLegendaryBudget } from '../scene/monster-legendary.js';
import { freshInnateState, consumeInnate } from '../scene/monster-spells.js';
import { ENTITY_STATUSES } from '../shared/events.js';

export { ENTITY_STATUSES };

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const conditionId = (c) => (typeof c === 'string' ? c : c?.id);

/** Entity fields an `entity.updated` patch (or a dm.override patch) may replace. */
export const PATCHABLE_FIELDS = Object.freeze([
  'name', 'controller', 'pos', 'hp', 'hpMax', 'hpTemp', 'ac', 'speedFt', 'conditions', 'concentration',
  // E1 wave 5 (dying) — additive; the server sends them once it tracks them.
  'status', 'deathSaves',
  // E3 wave 6 — a token image (dm.entity.patch {imageUrl}; null clears it).
  'imageUrl'
]);
const PATCHABLE = new Set(PATCHABLE_FIELDS);

/**
 * DEATH — E1 wave 5 dying state (check at merge): `entity.status` is
 * stored only when not 'active'; `entity.deathSaves {successes, failures,
 * stable}` only while the status is not 'active'. Every death event
 * carries post-event values.
 */
const FRESH_SAVES = () => ({ successes: 0, failures: 0, stable: false });

function setActive(e) {
  delete e.status;
  delete e.deathSaves;
}

/**
 * A DM HP edit flips the dying state with no event of its own (E1):
 * back above 0 → active, 'unconscious' removed; an active PC to 0 →
 * downed with fresh saves, 'unconscious' added; a monster to 0 → dead.
 * `withConditions: false` when the same patch already carries them.
 */
function hpEdited(e, hp, withConditions = true) {
  e.hp = hp;
  if (hp > 0) {
    if (!e.status) return;
    setActive(e);
    if (withConditions && e.kind === 'pc') e.conditions = (e.conditions || []).filter(c => conditionId(c) !== 'unconscious');
    return;
  }
  if (e.status) return;
  if (e.kind !== 'pc') { e.status = 'dead'; return; }
  e.status = 'downed';
  e.deathSaves = FRESH_SAVES();
  if (withConditions && !(e.conditions || []).some(c => conditionId(c) === 'unconscious')) e.conditions = [...(e.conditions || []), 'unconscious'];
}

function isRaging(e) {
  return (e.conditions || []).some(c => conditionId(c) === 'raging');
}

/** PC per-turn flags `resetPerTurnFlags` clears (pc-features.js). */
const PC_TURN_FLAGS = ['sneakUsed', 'cunningUsed', 'extraAction'];

/**
 * Copy-on-write edit of one entity. `fn(e)` mutates a deep copy; an
 * unknown id (a fog-masked 'Something', a removed creature) is a no-op.
 */
function editEntity(enc, id, fn) {
  const cur = enc?.entities?.[id];
  if (!cur) return enc;
  const e = clone(cur);
  e.resources ||= {};
  e.turnFlags ||= {};
  fn(e);
  return { ...enc, entities: { ...enc.entities, [id]: e } };
}

function setFlag(e, key, on) {
  if (on) e.turnFlags[key] = on;
  else delete e.turnFlags[key];
}

/** turn-manager beginTurnResets, on the mirror. */
function beginTurnResets(e) {
  e.resources.reactionUsed = false;
  for (const k of ['shieldActive', 'dodging', 'disengaged']) delete e.turnFlags[k];
  if (e.kind === 'pc') {
    for (const k of ['recklessUsed', 'recklessUntilNextTurn', ...PC_TURN_FLAGS]) delete e.turnFlags[k];
  }
  if (e.kind === 'monster') {
    const fresh = freshLegendaryBudget(e.statBlock?.slug);
    if (fresh > 0) e.resources.legendaryBudget = fresh;
  }
}

function indexOf(enc, actorId) {
  return (enc.initiative || []).findIndex(r => r.entityId === actorId);
}

function atTurn(enc, actorId) {
  const idx = indexOf(enc, actorId);
  return { ...enc, phase: enc.phase === 'ended' ? 'ended' : 'running', ...(idx >= 0 ? { turnIndex: idx } : {}) };
}

/** turn-manager victoryCheck (rule 'hp'): who still stands on each side. */
function victoryOf(enc) {
  let party = 0;
  let hostile = 0;
  for (const e of Object.values(enc.entities || {})) {
    if (!(e.hp > 0)) continue;
    if (e.side === 'party') party++;
    else hostile++;
  }
  if (party === 0 && hostile === 0) return 'draw';
  if (hostile === 0) return 'party-victory';
  if (party === 0) return 'hostile-victory';
  return null;
}

/**
 * turn.ended: the server hashes the state after `advance` (or `finish`).
 *
 * Under fog (a player's filtered view, map/fog.js filterViewForFog) the
 * hidden creatures' initiative rows are gone and the filtered turnIndex
 * is "visible rows before the full index", clamped. The mirror cannot
 * see the hidden rows, so it offers every outcome the filter allows
 * (`turnEndedCandidates`) and the store keeps the one whose hash the
 * server stamped. `variant`: 0 = the default, 1 = the alternative wrap /
 * clamp, 2 = the encounter ended.
 */
function endTurn(enc, actorId, variant = 0) {
  if (enc.phase === 'ended') return enc;
  if (variant === 2) return { ...enc, phase: 'ended' };
  const fog = !!enc.fog;
  const outcome = victoryOf(enc);
  // Hidden hostiles may still stand: under fog only a party wipe is certain.
  if (variant === 0 && outcome && (!fog || outcome === 'hostile-victory')) return { ...enc, phase: 'ended' };
  const n = (enc.initiative || []).length;
  if (!n) return enc;
  const idx = indexOf(enc, actorId);
  const wrap = { ...enc, turnIndex: 0, round: (enc.round || 0) + 1 };
  if (idx < 0) {
    // A creature this view does not hold: its row is hidden. The index
    // already points past it; it moves only if the round wrapped.
    if (!fog) return (enc.turnIndex || 0) + 1 < n ? { ...enc, turnIndex: (enc.turnIndex || 0) + 1 } : wrap;
    return variant === 1 ? wrap : enc;
  }
  const next = idx + 1;
  if (next < n) return { ...enc, turnIndex: next };
  // Last visible row: the round wraps, or (fog) hidden rows still follow.
  return fog && variant === 1 ? { ...enc, turnIndex: n - 1 } : wrap;
}

/**
 * Every encounter a `turn.ended` may leave in this view, the default
 * first (no fog: just the default). Pure.
 * @param {object|null} enc — the mirror before the event
 * @param {object} ev — the turn.ended event
 * @param {{prev?: object|null}} [opts]
 * @returns {object[]}
 */
export function turnEndedCandidates(enc, ev, opts = {}) {
  if (!enc || ev?.type !== 'turn.ended') return [applyEventToEncounter(enc, ev, opts)];
  const variants = enc.fog ? [0, 1, 2] : [0];
  return variants.map(v => applyEventToEncounter(enc, ev, { ...opts, turnEndVariant: v }));
}

/** One spell slot of `level` (regular pool first, then the pact slot). */
function spendSlot(e, level) {
  const slots = e.resources.slots || (e.resources.slots = {});
  const l = slots[level];
  if (l && l.max - l.spent > 0) { l.spent += 1; return; }
  const pact = e.resources.pact;
  if (pact && pact.level === level && (pact.max ?? 0) - (pact.spent ?? 0) > 0) pact.spent = (pact.spent ?? 0) + 1;
}

/** encounter-adapters setFeature: the ledger entry only exists once spent. */
function setFeatureSpent(e, id, spent) {
  const features = e.resources.features || (e.resources.features = {});
  const prior = features[id];
  if (!prior && spent <= 0) return;
  const max = Math.max(prior?.max ?? 0, spent, 1);
  features[id] = { max, spent: Math.max(0, Math.min(max, spent)) };
}

function featureUsed(e, p) {
  const id = p.featureId;
  const spentNow = e.resources.features?.[id]?.spent ?? 0;
  switch (id) {
    case 'sneak-attack': setFlag(e, 'sneakUsed', true); break;
    case 'cunning-action': setFlag(e, 'cunningUsed', true); break;
    case 'reckless-attack': setFlag(e, 'recklessUsed', true); setFlag(e, 'recklessUntilNextTurn', true); break;
    case 'action-surge': setFeatureSpent(e, id, spentNow + 1); setFlag(e, 'extraAction', true); break;
    case 'second-wind': setFeatureSpent(e, id, 1); break;
    default:
      // Rage, feat spells, legendary actions and Divine Smite spend
      // through their own resource.spent event.
      break;
  }
}

function resourceSpent(e, p, prev) {
  const r = p.resource;
  if (r === 'reaction') { e.resources.reactionUsed = true; return; }
  if (r === 'spell-slot' && Number.isInteger(p.level)) {
    spendSlot(e, p.level);
    // Divine Smite: the slot it burned is remembered as a turn flag.
    if (prev?.type === 'feature.used' && prev.payload?.featureId === 'divine-smite' && prev.payload.entityId === e.id) {
      e.turnFlags.smiteSlotUsed = p.level;
    }
    return;
  }
  if (r === 'legendary') {
    const cost = Number.isInteger(p.cost) ? p.cost : 1;
    e.resources.legendaryBudget = Math.max(0, (e.resources.legendaryBudget ?? 0) - cost);
    return;
  }
  if (typeof r === 'string' && r.startsWith('innate:')) {
    const self = { _innate: e.resources.innate ? clone(e.resources.innate) : freshInnateState(e.statBlock?.slug) };
    consumeInnate(self, r.slice('innate:'.length));
    e.resources.innate = self._innate ?? null;
    return;
  }
  // E1 wave 5: `feature:<key>` (Rage, feat / race spells `feature:spell:<id>`).
  if (typeof r === 'string' && r.startsWith('feature:')) {
    const key = r.slice('feature:'.length);
    setFeatureSpent(e, key, (e.resources.features?.[key]?.spent ?? 0) + 1);
  }
}

/**
 * events v1.3 `resource.recharged {resource: 'innate', spellId, available}`:
 * the post-event availability of a recharge spell (seeded from the stat
 * block when the mirror never held the innate state).
 */
function resourceRecharged(e, p) {
  if (p.resource !== 'innate' || typeof p.spellId !== 'string') return;
  const inn = e.resources.innate ? e.resources.innate : freshInnateState(e.statBlock?.slug);
  if (!inn) return;
  inn.recharges ||= {};
  inn.recharges[p.spellId] = p.available > 0;
  e.resources.innate = inn;
}

function addCondition(e, p, round) {
  if ((e.conditions || []).some(c => conditionId(c) === p.condition)) return;
  const lifecycle = p.endsOn != null || p.save != null;
  const cond = lifecycle
    ? {
        id: p.condition,
        sourceId: p.sourceId ?? null,
        endsOn: p.endsOn ?? null,
        save: p.save ? { stat: p.save.stat, dc: p.save.dc } : null,
        appliedRound: Number.isInteger(round) ? round : null
      }
    : p.condition;
  e.conditions = [...(e.conditions || []), cond];
}

function applyPatch(enc, id, raw) {
  const src = { ...raw };
  if (src.position && !src.pos) src.pos = src.position;
  const patch = Object.fromEntries(Object.entries(src).filter(([k]) => PATCHABLE.has(k)));
  if (!Object.keys(patch).length) return enc;
  return editEntity(enc, id, (e) => {
    const { hp, ...rest } = clone(patch);
    if (Number.isInteger(hp) && !('status' in patch)) hpEdited(e, hp, !('conditions' in patch));
    else if (hp !== undefined) e.hp = hp;
    Object.assign(e, rest);
    if (rest.status === 'active') setActive(e);
    // The server drops a cleared token image rather than storing null.
    if ('imageUrl' in rest && rest.imageUrl == null) delete e.imageUrl;
  });
}

/**
 * Apply one engine event to a projected EncounterState. Pure.
 * @param {object|null} enc — projected EncounterState
 * @param {object} ev — events.js event
 * @param {{prev?: object|null, turnEndVariant?: number}} [opts] — the previous
 *   engine event (Divine Smite's slot and a DM-reviewed plan read it);
 *   the fog turn-order variant (see endTurn)
 * @returns {object|null}
 */
export function applyEventToEncounter(enc, ev, opts = {}) {
  if (!enc) return enc;
  const p = ev.payload || {};
  const prev = opts.prev || null;
  let next = enc;
  switch (ev.type) {
    case 'turn.started':
      next = editEntity(atTurn(next, p.actorId), p.actorId, beginTurnResets);
      break;
    case 'turn.skipped':
      // The turn manager skips a downed actor before its resets and an
      // incapacitated one after them; mid-turn skips (dm, target-down…)
      // follow a turn.started.
      if (p.reason === 'down') next = atTurn(next, p.actorId);
      else if (p.reason === 'incapacitated' && !(prev && prev.type === 'turn.started' && prev.payload?.actorId === p.actorId)) {
        next = editEntity(atTurn(next, p.actorId), p.actorId, beginTurnResets);
      } else {
        next = editEntity(next, p.actorId, (e) => { delete e.turnFlags.dodging; if (p.reason !== 'dm') delete e.turnFlags.disengaged; });
      }
      break;
    case 'turn.ended':
      // Rage's "sustained this turn" flag clears at the end of its turn.
      next = endTurn(editEntity(next, p.actorId, (e) => { delete e.turnFlags.rageSustained; }), p.actorId, opts.turnEndVariant || 0);
      break;
    case 'attack.rolled':
      next = editEntity(next, p.attackerId, (e) => { if (isRaging(e)) setFlag(e, 'rageSustained', true); });
      break;
    case 'turn.rejected':
      // A rejected plan returns before Dodge lands; only a bad move keeps
      // the Disengage flag it set first.
      next = editEntity(next, p.actorId, (e) => {
        delete e.turnFlags.dodging;
        if (p.code !== 'bad-move') delete e.turnFlags.disengaged;
      });
      break;
    case 'plan.chosen': {
      const reviewed = prev?.type === 'dm.override' && prev.payload?.kind === 'plan' && prev.payload.entityId === p.actorId;
      next = editEntity(next, p.actorId, (e) => {
        if (e.kind === 'pc' && (p.source === 'ai' || reviewed)) for (const k of PC_TURN_FLAGS) delete e.turnFlags[k];
        setFlag(e, 'disengaged', p.kind === 'disengage');
        if (p.kind === 'dodge') setFlag(e, 'dodging', true);
      });
      break;
    }
    case 'move':
      next = editEntity(next, p.actorId, (e) => { e.pos = { col: p.to.col, row: p.to.row }; });
      break;
    case 'damage':
      next = editEntity(next, p.targetId, (e) => {
        e.hp = p.hpAfter;
        if (Number.isInteger(p.absorbed) && p.absorbed > 0) e.hpTemp = Math.max(0, (e.hpTemp ?? 0) - p.absorbed);
        if (isRaging(e) && (p.amount > 0 || p.absorbed > 0)) setFlag(e, 'rageSustained', true);
      });
      break;
    case 'heal':
      // A downed PC's revival arrives as its own entity.revived event.
      next = editEntity(next, p.targetId, (e) => { e.hp = p.hpAfter; });
      break;
    case 'exchange':
      for (const eff of p.effects || []) next = editEntity(next, eff.entityId, (e) => { e.hp = eff.hp.after; });
      break;
    case 'condition.applied':
      next = editEntity(next, p.entityId, (e) => {
        addCondition(e, p, ev.round);
        // Rage starts sustained, so its first turn never lapses.
        if (p.condition === 'raging') setFlag(e, 'rageSustained', true);
      });
      break;
    case 'condition.removed': {
      const held = (next.entities?.[p.entityId]?.conditions || []).find(c => conditionId(c) === p.condition);
      next = editEntity(next, p.entityId, (e) => { e.conditions = (e.conditions || []).filter(c => conditionId(c) !== p.condition); });
      // A repeat save that ends a concentration-held condition drops the
      // creature from its source's concentration targets (R7).
      const sourceId = (typeof held === 'object' && held?.sourceId) || p.sourceId;
      if (p.reason === 'save' && typeof held === 'object' && held?.endsOn === 'concentration' && sourceId) {
        next = editEntity(next, sourceId, (s) => {
          if (s.concentration) s.concentration = { ...s.concentration, targetIds: (s.concentration.targetIds || []).filter(t => t !== p.entityId) };
        });
      }
      break;
    }
    case 'concentration.started':
      next = editEntity(next, p.casterId, (e) => {
        e.concentration = { spellId: p.spellId, targetIds: Array.isArray(p.targetIds) ? [...p.targetIds] : [] };
      });
      break;
    case 'concentration.broken':
      next = editEntity(next, p.casterId, (e) => { e.concentration = null; });
      break;
    case 'resource.spent':
      next = editEntity(next, p.entityId, (e) => resourceSpent(e, p, prev));
      break;
    case 'resource.recharged':
      next = editEntity(next, p.entityId, (e) => resourceRecharged(e, p));
      break;
    case 'feature.used':
      next = editEntity(next, p.entityId, (e) => featureUsed(e, p));
      break;
    case 'reaction.resolved':
      if (p.kind === 'shield' && p.used) next = editEntity(next, p.reactorId, (e) => setFlag(e, 'shieldActive', true));
      break;
    // ---- dying (E1 wave 5) ---------------------------------------------------
    case 'entity.downed':
      next = editEntity(next, p.entityId, (e) => {
        e.hp = 0;
        if (e.status === 'dead') return;
        e.status = 'downed';
        if (e.kind === 'pc') e.deathSaves = FRESH_SAVES();
      });
      break;
    case 'death.save':
      next = editEntity(next, p.entityId, (e) => {
        const ds = e.deathSaves || FRESH_SAVES();
        e.deathSaves = {
          successes: Number.isInteger(p.successes) ? p.successes : ds.successes,
          failures: Number.isInteger(p.failures) ? p.failures : ds.failures,
          stable: false
        };
        // A hit on a stable creature puts it back to dying.
        if (e.status === 'stable' || !e.status) e.status = 'downed';
      });
      break;
    case 'entity.stabilized':
      next = editEntity(next, p.entityId, (e) => {
        e.status = 'stable';
        e.deathSaves = { ...(e.deathSaves || FRESH_SAVES()), stable: true };
      });
      break;
    case 'entity.revived':
      next = editEntity(next, p.entityId, (e) => {
        setActive(e);
        if (Number.isInteger(p.hp)) e.hp = p.hp;
      });
      break;
    case 'entity.died':
      next = editEntity(next, p.entityId, (e) => {
        e.status = 'dead';
        e.hp = 0;
        if (e.deathSaves) e.deathSaves = { ...e.deathSaves, stable: false };
      });
      break;
    // ---- DM edits ---------------------------------------------------------
    case 'dm.override':
      if (!p.entityId) break;
      if (p.kind === 'hp' && Number.isInteger(p.after)) next = editEntity(next, p.entityId, (e) => hpEdited(e, p.after));
      else if (p.kind === 'conditions' && Array.isArray(p.after)) next = editEntity(next, p.entityId, (e) => { e.conditions = clone(p.after); });
      else if (p.kind === 'entity.patch' && p.after && typeof p.after === 'object' && !Array.isArray(p.after)) next = applyPatch(next, p.entityId, p.after);
      break;
    case 'encounter.ended':
      next = { ...next, phase: 'ended' };
      break;
    default:
      break;
  }
  const round = ev.round > next.round ? ev.round : next.round;
  return { ...next, round, lastEventSeq: ev.seq };
}

/**
 * Apply an `entity.updated` patch (the DM's edits, PATCHABLE_FIELDS only).
 * @param {object|null} enc
 * @param {string} entityId
 * @param {object} patch
 * @returns {object|null}
 */
export function applyEntityPatch(enc, entityId, patch) {
  if (!enc) return enc;
  return applyPatch(enc, entityId, patch || {});
}

/**
 * A creature's life state for badges: the server's `status` when it
 * tracks one (E1 wave 5), else 'active' / 'down' from HP (monsters on a
 * pre-wave-5 server, or a PC dropped by one).
 * @param {object} e — EncounterState entity
 * @returns {'active'|'down'|'downed'|'stable'|'dead'}
 */
export function lifeStatus(e) {
  if (!e) return 'active';
  if (typeof e.status === 'string' && ENTITY_STATUSES.includes(e.status) && e.status !== 'active') return e.status;
  return e.hp > 0 ? 'active' : 'down';
}
