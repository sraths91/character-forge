/**
 * M64 phase 1.5 wave 6b — the engine-facing abilities of a normalised
 * SRD stat block (`open5e-normalize.js`, `source: 'srd-2014'`).
 *
 * Preset monsters keep their slug-keyed data (MONSTER_INNATE,
 * LEGENDARY_ACTIONS). A creature with a normalised stat block gets its
 * recharge abilities, legendary actions and Legendary Resistance from the
 * block instead — the preset slug is then only its sprite. The "kit" is a
 * small derived, static object the wrapper carries as `_statBlockKit`
 * (never persisted; it is rebuilt from `statBlock` on every wrap):
 *
 *   {
 *     spells:  {[actionName]: registry-shaped spell},   // runtime entries
 *     innate:  {recharge: {[actionName]: min}, atWill: [], perDay: {}} | null,
 *     legendary: {budget, actions: [LEGENDARY_ACTIONS-shaped action]} | null,
 *     legendaryResistance: number                         // uses per day
 *   }
 *
 * A recharge action with a save (a breath weapon) becomes a `leveled-save`
 * spell built from the action — the same shape as the registry's
 * 'fire-breath' — so it is chosen by the AI's innate consideration and
 * resolved by runMonsterSpell like any innate spell. It carries its own
 * `dc` (the engine prefers it to the caster's book DC) and
 * `notASpell: true` (no Counterspell window). Legendary actions map onto
 * the existing chooser kinds: `melee-attack` (an attack, or one that
 * invokes a weapon action) and `aoe-save` (a save with an area); anything
 * else (Detect) is kind 'special' and never chosen.
 *
 * Pure module: no DOM, no randomness.
 */

import { isNormalizedStatBlock } from './open5e-normalize.js';
import { freshInnateFromBlock } from './monster-spells.js';

/** `resources.features` key of the Legendary Resistance ledger. */
export const LEGENDARY_RESISTANCE_KEY = 'legendary-resistance';

/** AI cast weight of a stat-block recharge ability (the preset dragon's 2.0). */
export const RECHARGE_AI_WEIGHT = 2.0;

/** Memo: statBlock object → kit (stat blocks are static). */
const KIT_CACHE = new WeakMap();

/**
 * The kit for a normalised stat block, or null for anything else.
 * @param {object|null} sb — stat block
 * @returns {object|null}
 */
export function buildStatBlockKit(sb) {
  if (!isNormalizedStatBlock(sb)) return null;
  const hit = KIT_CACHE.get(sb);
  if (hit) return hit;
  const actions = Array.isArray(sb.actions) ? sb.actions : [];
  const spells = {};
  const recharge = {};
  for (const a of actions) {
    if (!a || !a.recharge || a.actionType === 'legendary') continue;
    const spell = rechargeSpellFrom(a);
    if (!spell) continue;
    spells[spell.id] = spell;
    recharge[spell.id] = Math.max(2, Math.min(6, Math.trunc(Number(a.recharge.min) || 6)));
  }
  const kit = {
    spells,
    innate: Object.keys(recharge).length ? { recharge, atWill: [], perDay: {} } : null,
    legendary: legendaryFrom(sb.legendary, actions),
    legendaryResistance: Math.max(0, Math.trunc(Number(sb.legendaryResistance) || 0))
  };
  KIT_CACHE.set(sb, kit);
  return kit;
}

/**
 * The kit of a wrapper (`_statBlockKit`) or an EncounterState entity
 * (`statBlock`); null for preset-only creatures and PCs.
 * @param {object|null} x
 * @returns {object|null}
 */
export function statBlockKitOf(x) {
  if (!x || x.kind === 'pc') return null;
  if (x._statBlockKit) return x._statBlockKit;
  return buildStatBlockKit(x.statBlock);
}

/**
 * A fresh innate ledger (`resources.innate`) for a kit: every recharge
 * ability starts available. Null when the block has none.
 * @param {object|null} kit
 * @returns {object|null}
 */
export function freshKitInnate(kit) {
  return kit?.innate ? freshInnateFromBlock(kit.innate) : null;
}

/**
 * The innate ledger a kit creature fights with: the stored one, keyed to
 * the block's recharge abilities. Abilities the ledger lacks start
 * available; keys the block does not have (a preset's 'fire-breath' from
 * an older state) are dropped. Pure: returns a new object or null.
 * @param {object|null} kit
 * @param {object|null} stored — `resources.innate`
 * @returns {object|null}
 */
export function kitInnateState(kit, stored) {
  if (!kit?.innate) return null;
  const fresh = freshKitInnate(kit);
  const prior = stored?.recharges || {};
  for (const id of Object.keys(fresh.recharges)) {
    if (typeof prior[id] === 'boolean') fresh.recharges[id] = prior[id];
  }
  return fresh;
}

/**
 * A wrapper's legendary-resistance ledger, `{max, spent}`, or null.
 * @param {object|null} kit
 * @param {object|null} stored — `resources.features['legendary-resistance']`
 * @returns {{max: number, spent: number}|null}
 */
export function kitLegendaryResistance(kit, stored) {
  const max = kit?.legendaryResistance || 0;
  if (max <= 0) return null;
  const spent = Math.max(0, Math.min(max, Math.trunc(Number(stored?.spent) || 0)));
  return { max, spent };
}

// ---------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------

/** '16d6' / '2d6+8' / '2d10+1d6+6' from normalised damage parts. */
function diceOf(damage) {
  let dice = '';
  let flat = 0;
  for (const d of damage || []) {
    if (d?.dice) dice += (dice ? '+' : '') + d.dice;
    flat += Number(d?.bonus) || 0;
  }
  if (!dice) return null;
  if (flat > 0) return `${dice}+${flat}`;
  if (flat < 0) return `${dice}${flat}`;
  return dice;
}

function slugOf(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'action';
}

function repeatsSave(desc) {
  return /repeat the saving throw at the end of each of its turns/i.test(String(desc || ''));
}

/** A breath weapon (or any recharge save action) as a registry-shaped spell. */
function rechargeSpellFrom(a) {
  const save = a.save;
  if (a.kind !== 'save' || !save || !save.stat || !Number.isFinite(save.dc)) return null;
  const damage = save.damage?.length ? save.damage : (a.damage || []);
  const dice = diceOf(damage);
  if (!dice && !save.condition) return null;
  const area = a.area && Number(a.area.sizeFt) > 0 ? a.area : null;
  const spell = {
    id: a.name,
    name: a.name,
    kind: 'leveled-save',
    level: 0,
    range: area ? area.sizeFt : (a.rangeFt || a.reachFt || 5),
    saveStat: save.stat,
    saveOnHalf: !!save.half,
    dice,
    damageType: damage[0]?.type ?? null,
    aoe: !!area,
    dc: save.dc,
    notASpell: true,
    statBlockAction: true,
    aiWeight: RECHARGE_AI_WEIGHT,
    description: `${area ? `${area.sizeFt}-ft ${area.shape}` : 'Single target'} — DC ${save.dc} ${save.stat}${save.half ? ' half' : ''}. Recharge ${a.recharge.min}-6.`
  };
  if (save.condition) {
    spell.appliesCondition = save.condition;
    // Prone: the creature stands up at the start of its turn.
    if (save.condition === 'prone') spell.conditionEndsOn = 'turn-start';
    if (repeatsSave(a.desc)) spell.conditionSave = save.stat;
  }
  return spell;
}

/** `statBlock.legendary` → the LEGENDARY_ACTIONS block shape. */
function legendaryFrom(legendary, actions) {
  if (!legendary || !Array.isArray(legendary.actions) || legendary.actions.length === 0) return null;
  const budget = Math.max(1, Math.trunc(Number(legendary.perRound) || 3));
  const out = legendary.actions.map(la => legendaryAction(la, actions)).filter(Boolean);
  return out.length ? { budget, actions: out } : null;
}

function legendaryAction(la, actions) {
  if (!la || !la.name) return null;
  const base = { id: slugOf(la.name), name: la.name, cost: Math.max(1, Math.trunc(Number(la.legendaryCost) || 1)) };
  const invoked = la.invokes ? actions.find(a => a.name === la.invokes) : null;
  const src = invoked || la;
  if ((src.kind === 'melee' || src.kind === 'ranged') && Number.isFinite(src.toHit)) {
    const dice = diceOf(src.damage);
    if (!dice) return { ...base, kind: 'special' };
    return {
      ...base,
      kind: 'melee-attack',
      range: src.kind === 'melee' ? (src.reachFt || 5) : (src.rangeFt || 5),
      attackBonus: src.toHit,
      dice,
      damageType: src.damage[0]?.type ?? null
    };
  }
  if (src.kind === 'save' && src.save && Number.isFinite(src.save.dc) && src.area && Number(src.area.sizeFt) > 0) {
    const damage = src.save.damage?.length ? src.save.damage : (src.damage || []);
    return {
      ...base,
      kind: 'aoe-save',
      range: src.area.sizeFt,
      saveStat: src.save.stat,
      dc: src.save.dc,
      dice: diceOf(damage),
      damageType: damage[0]?.type ?? null,
      half: !!src.save.half,
      ...(src.save.condition ? { condition: src.save.condition } : {})
    };
  }
  return { ...base, kind: 'special' };
}
