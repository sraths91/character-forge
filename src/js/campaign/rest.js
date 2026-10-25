/**
 * M65 R25 — short and long rests between nodes (SRD 5.1 p.85-86).
 *
 * Rest types are data (`REST_TYPES`, the Foundry dnd5e `restTypes`
 * pattern); `applyRest` reads their flags, never the type name. Works on
 * state_json v1 (`hp`, `hitDice`, `slots`, `resources`, `deathSaves`,
 * `exhaustion`) and reads maximums from the run sheet. Returns a new
 * state; the input is never mutated.
 *
 * Pure module (Node + browser): no DOM, no `node:` imports, no
 * Math.random — hit-dice rolls draw from the injected run rng.
 */

import { rollDice } from '../scene/combat-roll.js';
import { requireRng } from '../scene/rng.js';
import { CampaignRuleError, ruleAssert } from './errors.js';
import { clone, sheetMod, hitDieOf, pushDelta } from './util.js';
import { effectiveHpMax } from './exhaustion.js';
import { DEFAULT_CAMPAIGN_SETTINGS } from '../shared/campaign.js';

/**
 * Rest definitions. `recoverPeriods` are the resource recovery periods
 * restored; `dawnPeriods` are added when the campaign sets
 * `dawnIsLongRest`; `recoverSpellSlotTypes` lists 'spell' (levelled
 * slots) and/or 'pact'; `recoverHitDice` is the fraction of total hit
 * dice regained (min 1); `minHp` is the HP needed to benefit.
 */
export const REST_TYPES = Object.freeze({
  short: Object.freeze({
    id: 'short', label: 'Short Rest', durationMinutes: 60,
    recoverPeriods: Object.freeze(['sr']), dawnPeriods: Object.freeze([]),
    spendHitDice: true, recoverHitPoints: false, recoverHitDice: 0,
    recoverSpellSlotTypes: Object.freeze(['pact']),
    clearTempHp: false, exhaustionDelta: 0, minHp: 0, preparedSwap: false
  }),
  long: Object.freeze({
    id: 'long', label: 'Long Rest', durationMinutes: 480,
    recoverPeriods: Object.freeze(['sr', 'lr']), dawnPeriods: Object.freeze(['dawn', 'day']),
    spendHitDice: false, recoverHitPoints: true, recoverHitDice: 0.5,
    recoverSpellSlotTypes: Object.freeze(['spell', 'pact']),
    clearTempHp: true, exhaustionDelta: -1, minHp: 1, preparedSwap: true
  })
});

/**
 * Hit dice per class: `{ [className]: {die, max, spent, available} }`
 * (max = class level).
 * @param {object} sheet
 * @param {object} state
 * @returns {Record<string, {die: number|null, max: number, spent: number, available: number}>}
 */
export function hitDicePool(sheet, state) {
  const out = {};
  for (const c of (sheet?.classes || [])) {
    const name = c?.name;
    if (!name) continue;
    const max = Math.max(0, Number(c.level) || 0);
    const spent = Math.max(0, Math.min(max, Number(state?.hitDice?.[name]?.spent) || 0));
    out[name] = { die: hitDieOf(sheet, state, name), max, spent, available: max - spent };
  }
  return out;
}

/** `spend` (a count for a single-class sheet, or `{className: count}`) → `{className: count}`. */
function normaliseSpend(spend, pool) {
  if (spend == null) return {};
  if (typeof spend === 'number') {
    const names = Object.keys(pool);
    ruleAssert(names.length === 1, 'hit-dice-class-required', 'Name the class whose hit dice are spent (multiclass sheet).');
    return { [names[0]]: spend };
  }
  ruleAssert(typeof spend === 'object' && !Array.isArray(spend), 'bad-spend', 'spend must be a count or {className: count}.');
  return spend;
}

function isDead(state, lifeStatus) {
  return lifeStatus === 'dead' || Number(state?.deathSaves?.failures) >= 3;
}

/**
 * Apply a rest to one character.
 *
 * Short: spend hit dice (each rolls its die + CON, min 0, through `rng`;
 * spending more than are left is refused); `sr` resources and pact slots
 * recover. Long (refused below 1 HP): HP to the (exhaustion-adjusted)
 * max, half the total hit dice back (min 1, largest dice first), `sr` +
 * `lr` resources (plus `dawn` / `day` when `dawnIsLongRest`), every slot,
 * temp HP cleared, exhaustion −1, death saves reset, prepared-spell swap
 * allowed. A dead character cannot rest.
 *
 * @param {object} sheet — run sheet (classes, hp.max, abilityModifiers, hitDice/progression)
 * @param {object} state — state_json v1
 * @param {'short'|'long'} type — a REST_TYPES key
 * @param {{spend?: number|Record<string, number>, rng?: function(): number,
 *   dawnIsLongRest?: boolean, lifeStatus?: string}} [opts] — dawnIsLongRest
 *   defaults to the campaign default (DEFAULT_CAMPAIGN_SETTINGS)
 * @returns {{state: object, deltas: {path: string, before: unknown, after: unknown}[],
 *   rolls: {className: string, die: number, roll: number, con: number, healed: number}[],
 *   preparedSwap: boolean, type: string}}
 * @throws {CampaignRuleError} unknown-rest-type | dead | needs-hp | hit-dice-overspent |
 *   hit-dice-class-required | unknown-class | bad-spend | no-hit-dice-on-long-rest
 */
export function applyRest(sheet, state, type, opts = {}) {
  const def = REST_TYPES[type];
  if (!def) throw new CampaignRuleError('unknown-rest-type', `Unknown rest type "${type}".`);
  ruleAssert(!isDead(state, opts.lifeStatus), 'dead', 'A dead character cannot rest.');
  const before = state || {};
  const next = clone(before);
  next.hp = { current: Number(before.hp?.current) || 0, temp: Number(before.hp?.temp) || 0, ...clone(before.hp || {}) };
  const deltas = [];
  const rolls = [];
  ruleAssert(next.hp.current >= def.minHp, 'needs-hp',
    `A ${def.label.toLowerCase()} needs at least ${def.minHp} HP.`, { hp: next.hp.current });

  const pool = hitDicePool(sheet, before);
  const hpMax = effectiveHpMax(sheet, before);
  const con = sheetMod(sheet, 'CON');

  // --- Hit dice: spend (short) ---
  const spend = normaliseSpend(opts.spend, pool);
  const spendTotal = Object.values(spend).reduce((s, n) => s + (Number(n) || 0), 0);
  if (!def.spendHitDice) {
    ruleAssert(spendTotal === 0, 'no-hit-dice-on-long-rest', `Hit dice are spent on a short rest, not a ${def.label.toLowerCase()}.`);
  } else if (spendTotal > 0) {
    // Validate everything before rolling anything.
    for (const [cls, n] of Object.entries(spend)) {
      const count = Number(n);
      ruleAssert(Number.isInteger(count) && count >= 0, 'bad-spend', `Hit dice to spend must be a whole number (${cls}).`);
      ruleAssert(pool[cls], 'unknown-class', `No ${cls} hit dice on this sheet.`, { className: cls });
      ruleAssert(pool[cls].die, 'unknown-class', `The ${cls} hit die is unknown.`, { className: cls });
      ruleAssert(count <= pool[cls].available, 'hit-dice-overspent',
        `Only ${pool[cls].available} ${cls} hit dice left (asked for ${count}).`, { className: cls, available: pool[cls].available, asked: count });
    }
    requireRng(opts.rng, 'applyRest');
    next.hitDice = clone(before.hitDice || {});
    const order = (sheet?.classes || []).map(c => c.name).filter(n => spend[n]);
    for (const cls of order) {
      const die = pool[cls].die;
      for (let i = 0; i < Number(spend[cls]); i++) {
        const roll = rollDice(`1d${die}`, opts.rng).total;
        const healed = Math.max(0, roll + con);
        const hpBefore = next.hp.current;
        next.hp.current = Math.min(hpMax, hpBefore + healed);
        rolls.push({ className: cls, die, roll, con, healed: next.hp.current - hpBefore });
      }
      const prev = next.hitDice[cls] || { die, spent: 0 };
      next.hitDice[cls] = { ...prev, die: prev.die ?? die, spent: pool[cls].spent + Number(spend[cls]) };
    }
  }

  // --- Hit points ---
  if (def.recoverHitPoints) next.hp.current = hpMax;
  if (def.clearTempHp) next.hp.temp = 0;
  if (next.hp.current > 0 && (before.hp?.current ?? 0) <= 0 && before.deathSaves) {
    next.deathSaves = { successes: 0, failures: 0, stable: false };
  }

  // --- Hit dice: recover (long) ---
  if (def.recoverHitDice > 0) {
    const total = Object.values(pool).reduce((s, p) => s + p.max, 0);
    let regain = Math.max(1, Math.floor(total * def.recoverHitDice));
    next.hitDice = clone(next.hitDice || {});
    const byDie = Object.entries(pool).sort((a, b) => (b[1].die || 0) - (a[1].die || 0));
    for (const [cls, p] of byDie) {
      if (regain <= 0) break;
      const back = Math.min(regain, p.spent);
      if (back <= 0 && next.hitDice[cls]) continue;
      regain -= back;
      next.hitDice[cls] = { ...(next.hitDice[cls] || {}), die: next.hitDice[cls]?.die ?? p.die, spent: p.spent - back };
    }
  }

  // --- Spell slots ---
  if (def.recoverSpellSlotTypes.includes('spell') && next.slots?.spell) {
    for (const lvl of Object.keys(next.slots.spell)) next.slots.spell[lvl] = { ...next.slots.spell[lvl], spent: 0 };
  }
  if (def.recoverSpellSlotTypes.includes('pact') && next.slots?.pact && typeof next.slots.pact === 'object') {
    next.slots.pact = { ...next.slots.pact, spent: 0 };
  }

  // --- Resources ---
  const dawnIsLongRest = opts.dawnIsLongRest ?? DEFAULT_CAMPAIGN_SETTINGS.dawnIsLongRest;
  const periods = new Set([...def.recoverPeriods, ...(dawnIsLongRest ? def.dawnPeriods : [])]);
  for (const [key, r] of Object.entries(next.resources || {})) {
    // state_json v1 stores periods as strings ('sr'); {period} objects are accepted too.
    const rec = Array.isArray(r?.recovery) ? r.recovery : [];
    if (rec.some(x => periods.has(typeof x === 'string' ? x : x?.period))) next.resources[key] = { ...r, spent: 0 };
  }

  // --- Exhaustion, death saves ---
  if (def.exhaustionDelta && Number(before.exhaustion) > 0) {
    next.exhaustion = Math.max(0, Math.min(6, Number(before.exhaustion) + def.exhaustionDelta));
    // A lower level may raise the HP max back (exhaustion 4 halves it).
    if (def.recoverHitPoints) next.hp.current = effectiveHpMax(sheet, next);
  }
  if (def.recoverHitPoints && before.deathSaves) next.deathSaves = { successes: 0, failures: 0, stable: false };

  // --- Deltas (leaf paths, for the run event's before/after) ---
  pushDelta(deltas, 'hp.current', before.hp?.current, next.hp.current);
  pushDelta(deltas, 'hp.temp', before.hp?.temp, next.hp.temp);
  for (const cls of new Set([...Object.keys(before.hitDice || {}), ...Object.keys(next.hitDice || {})])) {
    pushDelta(deltas, `hitDice.${cls}.spent`, before.hitDice?.[cls]?.spent, next.hitDice?.[cls]?.spent);
  }
  for (const lvl of Object.keys(next.slots?.spell || {})) {
    pushDelta(deltas, `slots.spell.${lvl}.spent`, before.slots?.spell?.[lvl]?.spent, next.slots.spell[lvl].spent);
  }
  pushDelta(deltas, 'slots.pact.spent', before.slots?.pact?.spent, next.slots?.pact?.spent);
  for (const key of Object.keys(next.resources || {})) {
    pushDelta(deltas, `resources.${key}.spent`, before.resources?.[key]?.spent, next.resources[key].spent);
  }
  pushDelta(deltas, 'exhaustion', before.exhaustion, next.exhaustion);
  pushDelta(deltas, 'deathSaves', before.deathSaves, next.deathSaves);

  return { state: next, deltas, rolls, preparedSwap: !!def.preparedSwap, type: def.id };
}
