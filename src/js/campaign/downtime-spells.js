/**
 * M65 R28 — healing spells cast between nodes, spending real slots.
 *
 * Cure Wounds (1st, touch, 1d8 + mod, +1d8 per slot level above 1st),
 * Healing Word (1st, 1d4 + mod, +1d4 per level), Prayer of Healing
 * (2nd, up to six creatures, 2d8 + mod, +1d8 per level). Life Domain's
 * Disciple of Life adds 2 + the slot level to each target. Prayer of
 * Healing rolls once and applies the total to every target (the Foundry
 * convention). Dead characters cannot be healed. Slots come from the
 * caster's run sheet + state_json; pact slots work when their level fits.
 *
 * Pure module (Node + browser): no DOM, no `node:` imports, no
 * Math.random — rolls draw from the injected run rng.
 */

import { rollDice } from '../scene/combat-roll.js';
import { requireRng } from '../scene/rng.js';
import { ruleAssert } from './errors.js';
import { clone, slotsLeft, spendSlotIn, sheetSpell, sheetMod, pushDelta } from './util.js';
import { effectiveHpMax } from './exhaustion.js';
import { lifeStatusOf } from './death.js';

/** The between-node healing spells (SRD 5.1). */
export const DOWNTIME_HEALS = Object.freeze({
  'cure-wounds': Object.freeze({ id: 'cure-wounds', name: 'Cure Wounds', level: 1, dieCount: 1, die: 8, upcastDice: 1, maxTargets: 1 }),
  'healing-word': Object.freeze({ id: 'healing-word', name: 'Healing Word', level: 1, dieCount: 1, die: 4, upcastDice: 1, maxTargets: 1 }),
  'prayer-of-healing': Object.freeze({ id: 'prayer-of-healing', name: 'Prayer of Healing', level: 2, dieCount: 2, die: 8, upcastDice: 1, maxTargets: 6 })
});

const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

/**
 * The healing dice for a spell at a slot level ("2d8" style, no modifier).
 * @param {string} spellId — a DOWNTIME_HEALS key or the spell's name
 * @param {number} slotLevel
 * @returns {string}
 */
export function downtimeHealDice(spellId, slotLevel) {
  const def = DOWNTIME_HEALS[slug(spellId)];
  ruleAssert(def, 'not-downtime-spell', `${spellId} is not a between-node healing spell.`);
  const count = def.dieCount + def.upcastDice * Math.max(0, Number(slotLevel) - def.level);
  return `${count}d${def.die}`;
}

/**
 * Cast a healing spell between nodes.
 *
 * @param {{caster: {id: string, sheet: object, state: object, lifeStatus?: string},
 *   spell: string, slotLevel?: number, slotKind?: 'spell'|'pact',
 *   targets: {id: string, sheet: object, state: object, lifeStatus?: string}[],
 *   rng: function(): number}} args — slotLevel defaults to the spell's level;
 *   a target may be the caster (same id)
 * @returns {{casterState: object, slot: {level: number, kind: string}, roll: {dice: string, rolls: number[], total: number, mod: number, bonus: number},
 *   targets: {id: string, state: object, healed: number, deltas: object[]}[]}}
 * @throws {CampaignRuleError} not-downtime-spell | no-spell | caster-down | slot-too-low | no-slot |
 *   too-many-targets | no-targets | target-dead
 */
export function castDowntimeHeal({ caster, spell, slotLevel, slotKind = 'spell', targets = [], rng }) {
  const def = DOWNTIME_HEALS[slug(spell)];
  ruleAssert(def, 'not-downtime-spell', `${spell} is not a between-node healing spell.`);
  ruleAssert(caster?.sheet, 'no-caster', 'A healing spell needs a caster.');
  ruleAssert(lifeStatusOf(caster.state) === 'active' && caster.lifeStatus !== 'dead', 'caster-down', 'The caster must be up.');
  const known = sheetSpell(caster.sheet, def.name);
  ruleAssert(known, 'no-spell', `The caster does not have ${def.name}.`);
  const level = Math.trunc(Number(slotLevel ?? def.level));
  ruleAssert(level >= def.level && level <= 9, 'slot-too-low', `${def.name} needs a level ${def.level}+ slot.`);
  ruleAssert(slotsLeft(caster.sheet, caster.state, level, slotKind) > 0, 'no-slot', `No level ${level} ${slotKind === 'pact' ? 'pact ' : ''}slot left.`);
  ruleAssert(Array.isArray(targets) && targets.length > 0, 'no-targets', 'Choose who to heal.');
  ruleAssert(targets.length <= def.maxTargets, 'too-many-targets', `${def.name} heals at most ${def.maxTargets}.`);
  for (const t of targets) {
    ruleAssert(t.lifeStatus !== 'dead' && lifeStatusOf(t.state) !== 'dead', 'target-dead', `${t.sheet?.name || t.id} is dead; healing cannot help.`);
  }
  requireRng(rng, 'castDowntimeHeal');

  const casterState = clone(caster.state);
  const slot = { level, kind: slotKind };
  spendSlotIn(casterState, slot);
  const ability = known.spellCastingAbility || null;
  const mod = ability ? sheetMod(caster.sheet, ability) : 0;
  const disciple = (caster.sheet.classFeatures || []).some(f => f?.name === 'Disciple of Life');
  const bonus = disciple ? 2 + level : 0;
  const dice = downtimeHealDice(def.id, level);
  const r = rollDice(dice, rng);
  const amount = Math.max(0, r.total + mod + bonus);

  const out = [];
  let finalCaster = casterState;
  for (const t of targets) {
    const isCaster = String(t.id) === String(caster.id);
    const base = isCaster ? finalCaster : clone(t.state);
    const next = clone(base);
    next.hp = { current: 0, temp: 0, ...(next.hp || {}) };
    const before = next.hp.current;
    next.hp.current = Math.min(effectiveHpMax(t.sheet, next), before + amount);
    const deltas = [];
    pushDelta(deltas, 'hp.current', before, next.hp.current);
    if (before <= 0 && next.hp.current > 0 && next.deathSaves) {
      const ds = { successes: 0, failures: 0, stable: false };
      pushDelta(deltas, 'deathSaves', next.deathSaves, ds);
      next.deathSaves = ds;
    }
    if (isCaster) finalCaster = next;
    out.push({ id: t.id, state: next, healed: next.hp.current - before, deltas });
  }
  return { casterState: finalCaster, slot, roll: { dice, rolls: r.rolls, total: r.total, mod, bonus }, targets: out };
}
