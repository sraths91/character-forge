/**
 * M65 R28 — death across nodes: life status, death modes, revival.
 *
 * `life_status` (party_slots) is one of active | dying | stable | dead.
 * During an encounter the engine tracks entity `status` (active | downed
 * | stable | dead, M64 R9); `lifeStatusOf` maps both. Between nodes:
 *   standard   — Revivify only in the between right after the death
 *                (a caster with the spell, a 3rd-level slot, a 300 gp
 *                diamond); Raise Dead at any later between (5th-level
 *                slot, 500 gp diamond); a DM override at any time.
 *   permadeath — DM override only.
 *   lenient    — on a party victory, downed PCs stand up at 1 HP.
 * Owner default 7: in standard / permadeath a dying PC on a winning side
 * is auto-stabilised and regains 1 HP on entering the next node.
 * Diamonds are run items (`name` contains "diamond", value in
 * `data.valueGp`, else `data.cost`).
 *
 * Pure module (Node + browser): no DOM, no `node:` imports, no rng.
 */

import { ruleAssert } from './errors.js';
import { clone, lowestSlotAtLeast, spendSlotIn, sheetSpell, pushDelta } from './util.js';

/** party_slots.life_status values. */
export const LIFE_STATUSES = Object.freeze(['active', 'dying', 'stable', 'dead']);

/** Campaign `settings.deathMode` values. */
export const DEATH_MODES = Object.freeze(['standard', 'permadeath', 'lenient']);

/** Revival methods. */
export const REVIVE_METHODS = Object.freeze(['revivify', 'raise-dead', 'dm']);

/** RAW revival costs (SRD 5.1): slot level and the diamond's value in gp. */
export const REVIVE_RULES = Object.freeze({
  revivify: Object.freeze({ spell: 'Revivify', slotLevel: 3, diamondGp: 300, onlyRightAfterDeath: true }),
  'raise-dead': Object.freeze({ spell: 'Raise Dead', slotLevel: 5, diamondGp: 500, onlyRightAfterDeath: false })
});

/** Allowed life-status moves (`dead → active` only through `revive`). */
export const LIFE_TRANSITIONS = Object.freeze({
  active: Object.freeze(['dying', 'dead']),
  dying: Object.freeze(['active', 'stable', 'dead']),
  stable: Object.freeze(['active', 'dying', 'dead']),
  dead: Object.freeze([])
});

const ENTITY_TO_LIFE = { active: 'active', downed: 'dying', stable: 'stable', dead: 'dead' };

/**
 * Life status of a state_json or an EncounterState entity.
 * @param {object} x — state_json (`hp.current`, `deathSaves`) or entity (`status`, `hp`)
 * @returns {'active'|'dying'|'stable'|'dead'}
 */
export function lifeStatusOf(x) {
  if (!x || typeof x !== 'object') return 'dead';
  if (typeof x.status === 'string' && ENTITY_TO_LIFE[x.status]) {
    if (x.status !== 'active') return ENTITY_TO_LIFE[x.status];
  }
  if (Number(x.deathSaves?.failures) >= 3) return 'dead';
  const hp = typeof x.hp === 'number' ? x.hp : Number(x.hp?.current);
  if (hp > 0) return 'active';
  return x.deathSaves?.stable ? 'stable' : 'dying';
}

/**
 * Validate a life-status move. `dead → active` needs `via: 'revive'`.
 * @param {string} from
 * @param {string} to
 * @param {{via?: string}} [opts]
 * @returns {string} `to`
 * @throws {CampaignRuleError} bad-life-status | bad-transition
 */
export function transitionLifeStatus(from, to, { via } = {}) {
  ruleAssert(LIFE_STATUSES.includes(from) && LIFE_STATUSES.includes(to), 'bad-life-status', `Unknown life status (${from} → ${to}).`);
  if (from === to) return to;
  if (from === 'dead' && to === 'active' && via === 'revive') return to;
  ruleAssert(LIFE_TRANSITIONS[from].includes(to), 'bad-transition', `A ${from} character cannot become ${to}${from === 'dead' ? ' without a revival' : ''}.`);
  return to;
}

/**
 * Settle one PC's life status when an encounter ends. Dead stays dead.
 * A dying PC on a winning side is stabilised (standard / permadeath) or
 * stands up at 1 HP (lenient); otherwise it keeps dying.
 * @param {object} state — the PC's state_json after write-back
 * @param {{outcome: 'victory'|'defeat'|'abandoned'|string, deathMode?: string}} opts
 * @returns {{state: object, lifeStatus: string, deltas: object[]}}
 */
export function settleAfterEncounter(state, { outcome, deathMode = 'standard' } = {}) {
  ruleAssert(DEATH_MODES.includes(deathMode), 'bad-death-mode', `Unknown death mode "${deathMode}".`);
  const next = clone(state || {});
  const deltas = [];
  let status = lifeStatusOf(next);
  if ((status === 'dying' || status === 'stable') && outcome === 'victory') {
    if (deathMode === 'lenient') {
      pushDelta(deltas, 'hp.current', next.hp?.current, 1);
      next.hp = { ...(next.hp || {}), current: 1 };
      const ds = { successes: 0, failures: 0, stable: false };
      pushDelta(deltas, 'deathSaves', next.deathSaves, ds);
      next.deathSaves = ds;
      status = 'active';
    } else if (status === 'dying') {
      const ds = { ...(next.deathSaves || { successes: 0, failures: 0 }), stable: true };
      pushDelta(deltas, 'deathSaves', next.deathSaves, ds);
      next.deathSaves = ds;
      status = 'stable';
    }
  }
  return { state: next, lifeStatus: status, deltas };
}

/**
 * Entering the next node: a stable PC regains 1 HP (owner default 7,
 * standing in for RAW's 1d4 hours). Other statuses are unchanged.
 * @param {object} state
 * @returns {{state: object, lifeStatus: string, deltas: object[]}}
 */
export function onNodeEntry(state) {
  const next = clone(state || {});
  const deltas = [];
  if (lifeStatusOf(next) !== 'stable') return { state: next, lifeStatus: lifeStatusOf(next), deltas };
  pushDelta(deltas, 'hp.current', next.hp?.current, 1);
  next.hp = { ...(next.hp || {}), current: 1 };
  const ds = { successes: 0, failures: 0, stable: false };
  pushDelta(deltas, 'deathSaves', next.deathSaves, ds);
  next.deathSaves = ds;
  return { state: next, lifeStatus: 'active', deltas };
}

/** Value of a diamond run item in gp (null when it is not a diamond). */
export function diamondValueGp(item) {
  if (!item || !/diamond/i.test(String(item.name || ''))) return null;
  const v = Number(item.data?.valueGp ?? item.data?.cost);
  return Number.isFinite(v) ? v : null;
}

/**
 * Bring a dead PC back.
 *
 * @param {object} state — the dead PC's state_json
 * @param {{method: 'revivify'|'raise-dead'|'dm', deathMode?: string,
 *   lifeStatus?: string, betweensSinceDeath?: number,
 *   caster?: {id?: string, sheet: object, state: object, lifeStatus?: string},
 *   items?: object[], hp?: number}} opts — `items` are the run items the
 *   party can spend (diamonds); `betweensSinceDeath` is 0 in the between
 *   that follows the death
 * @returns {{state: object, lifeStatus: 'active', casterState: object|null, items: object[],
 *   spent: {slot: {level: number, kind: string}|null, items: {id: string, qty: number}[]},
 *   override: boolean, deltas: object[]}}
 * @throws {CampaignRuleError} not-dead | bad-method | permadeath | too-late | no-caster |
 *   caster-down | no-spell | no-slot | no-diamond | bad-death-mode
 */
export function revive(state, opts = {}) {
  const { method, deathMode = 'standard', items = [], caster } = opts;
  ruleAssert(DEATH_MODES.includes(deathMode), 'bad-death-mode', `Unknown death mode "${deathMode}".`);
  ruleAssert(REVIVE_METHODS.includes(method), 'bad-method', `Unknown revival method "${method}".`);
  const status = opts.lifeStatus || lifeStatusOf(state);
  ruleAssert(status === 'dead', 'not-dead', 'Only a dead character can be revived.');
  const next = clone(state || {});
  const outItems = clone(items || []);
  const spent = { slot: null, items: [] };
  let casterState = null;

  if (method === 'dm') {
    const hp = Math.max(1, Math.trunc(Number(opts.hp) || 1));
    next.hp = { ...(next.hp || {}), current: hp };
  } else {
    ruleAssert(deathMode !== 'permadeath', 'permadeath', 'Permadeath: only the DM can bring a character back.');
    const rule = REVIVE_RULES[method];
    if (rule.onlyRightAfterDeath) {
      ruleAssert(Number(opts.betweensSinceDeath ?? 0) === 0, 'too-late', 'Revivify works only right after the death (this between).');
    }
    ruleAssert(caster && caster.sheet, 'no-caster', `${rule.spell} needs a caster.`);
    ruleAssert(lifeStatusOf(caster.state) === 'active' && caster.lifeStatus !== 'dead', 'caster-down', 'The caster must be up.');
    ruleAssert(sheetSpell(caster.sheet, rule.spell), 'no-spell', `The caster does not have ${rule.spell} prepared.`);
    const slot = lowestSlotAtLeast(caster.sheet, caster.state, rule.slotLevel);
    ruleAssert(slot, 'no-slot', `${rule.spell} needs a level ${rule.slotLevel}+ slot.`);
    const diamonds = outItems
      .filter(i => (Number(i.qty) || 0) > 0 && (diamondValueGp(i) ?? 0) >= rule.diamondGp)
      .sort((a, b) => diamondValueGp(a) - diamondValueGp(b));
    ruleAssert(diamonds.length, 'no-diamond', `${rule.spell} needs a diamond worth ${rule.diamondGp} gp.`, { needGp: rule.diamondGp });
    const diamond = diamonds[0];
    diamond.qty -= 1;
    spent.items.push({ id: diamond.id, qty: 1 });
    casterState = clone(caster.state);
    spendSlotIn(casterState, slot);
    spent.slot = slot;
    next.hp = { ...(next.hp || {}), current: 1 };
  }
  next.deathSaves = { successes: 0, failures: 0, stable: false };
  const deltas = [];
  pushDelta(deltas, 'hp.current', state?.hp?.current, next.hp.current);
  pushDelta(deltas, 'deathSaves', state?.deathSaves, next.deathSaves);
  return { state: next, lifeStatus: transitionLifeStatus('dead', 'active', { via: 'revive' }), casterState, items: outItems, spent, override: method === 'dm', deltas };
}

/**
 * Whether a revival method is open right now (for the UI; revive() is the gate).
 * @param {{method: string, deathMode?: string, betweensSinceDeath?: number}} q
 * @returns {boolean}
 */
export function canAttemptRevive({ method, deathMode = 'standard', betweensSinceDeath = 0 }) {
  if (method === 'dm') return true;
  if (deathMode === 'permadeath' || !REVIVE_RULES[method]) return false;
  return !REVIVE_RULES[method].onlyRightAfterDeath || Number(betweensSinceDeath) === 0;
}
