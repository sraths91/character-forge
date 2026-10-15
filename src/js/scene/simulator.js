/**
 * M20 — Monte Carlo encounter simulator.
 *
 * Runs N headless iterations of the current encounter using the M11
 * combat resolver as the rule engine and a seeded RNG, then aggregates
 * results into a stats summary the UI can render.
 *
 * Scope (v1):
 *   - Each entity makes ONE primary weapon attack per turn (no
 *     multiattack, no spells, no movement, no bonus actions).
 *   - Targeting is "lowest-current-HP hostile" — players gravitate to
 *     killing what they can kill; monsters do the same. Ties broken by
 *     stable iteration order.
 *   - Combat ends when one side has zero non-incapacitated entities,
 *     or after `maxRounds` (default 12) — whichever comes first.
 *   - Position is fixed (whatever the scene currently shows). Range +
 *     reach checks come from the resolver — out-of-reach attackers
 *     pass their turn for v1 (no smart movement).
 *
 * The resolver enforces every M11-M18 rule, so condition/positional
 * effects, flanking, item modifiers, etc. all apply in the simulation.
 *
 * Pure module. RNG injectable for tests.
 */

import { rollAttack, rollDamage } from './combat-roll.js';
import { deriveAC } from './pc-stats.js';
import { MONSTER_PRESETS } from './monster-presets.js';
import {
  resetReactionsForAll, shouldCastShield, consumeShield,
  slotsForPc
} from './reactions.js';
import {
  freshSlots, isSpellcaster, isInnateCaster, freshInnateState
} from './monster-spells.js';
import {
  isLegendary, freshLegendaryBudget, resetLegendaryBudget,
  chooseLegendaryAction, spendLegendaryAction
} from './monster-legendary.js';
import { rollSave } from './save-rolls.js';
import { createRng } from './rng.js';
// M45 Phase 4 — Combat resolution moved to a shared engine module so
// the live runner can dispatch through the same spine without
// re-implementing rules. Per-attack logic, spell casting, reactions,
// and the helper cluster (saveBonusFor / isAlive / sideAlive / etc.)
// all live in combat-engine.js now.
import {
  runOneAttack, applyDamageToEntity, saveBonusFor,
  isAlive, isIncapacitated, sideAlive
} from './combat-engine.js';

/**
 * Small mulberry32 PRNG. Pure JS, deterministic, fast. Seed in (0, 2^32).
 * Returns a function compatible with the resolver's rng param.
 *
 * M64 T3 — thin wrapper over `createRng` (rng.js), so the returned
 * function also exposes `.state()` for snapshot / resume.
 *
 * @param {number} seed — any number; coerced to uint32
 * @returns {(function(): number) & { state: function(): { algo: string, s: number } }}
 */
export function seedRng(seed) {
  return createRng({ s: seed >>> 0 });
}

/**
 * Run a Monte Carlo simulation of the encounter.
 *
 *   party     — array of PC characters (with _position resolved)
 *   monsters  — array of monster instances (with .position + .hp + .conditions)
 *   scene     — scene object (flankingEnabled, positions, etc.)
 *   iterations — how many runs to average (default 200; UI exposes 100/1000)
 *   maxRounds — round cap per run (default 12)
 *   seed      — base seed; each iteration gets seed+i so results are
 *               deterministic when caller passes a fixed seed.
 *   onIterationEnd — optional sync observer ({ index, rounds, pcs, mons })
 *               called with the live per-iteration wrappers in the same
 *               tick the iteration is scored. Test seam (M64 T1): lets a
 *               test assert positions / reactions / slots at return.
 *
 * Returns (a Promise of — M64 T1: async because runOneAttack is):
 *   {
 *     iterations,
 *     partyVictories, monsterVictories, draws,    // counts
 *     victoryRate,                                 // 0..1
 *     avgRounds,
 *     entities: [{
 *       id, name, kind,
 *       deathRate,         // 0..1 — fraction of runs this entity hit 0 HP
 *       avgFinalHp,
 *       avgDamageDealt
 *     }]
 *   }
 */
export async function simulateEncounter({ party = [], monsters = [], scene = {}, iterations = 200, maxRounds = 12, seed = 1, onIterationEnd = null } = {}) {
  const stats = newStats(party, monsters, iterations);

  for (let i = 0; i < iterations; i++) {
    const rng = seedRng(seed + i);
    const result = await runOneIteration({ party, monsters, scene, maxRounds, rng, index: i, onIterationEnd });

    if (result.partyAlive && !result.monstersAlive) stats.partyVictories++;
    else if (!result.partyAlive && result.monstersAlive) stats.monsterVictories++;
    else stats.draws++;
    stats.totalRounds += result.rounds;

    for (const e of result.endState) {
      const s = stats.byId.get(e.id);
      if (!s) continue;
      if (e.hp <= 0) s.deaths++;
      s.hpSum += e.hp;
      s.damageSum += e.damageDealt;
    }
  }

  return finalizeStats(stats);
}

// ---------- One iteration ----------

async function runOneIteration({ party, monsters, scene, maxRounds, rng, index = 0, onIterationEnd = null }) {
  // Per-iteration ENTITY STATE — shallow copies so we don't mutate inputs.
  // hp is the live counter; the resolver reads conditions for adv/disadv
  // but doesn't read hp, so we track damage separately.
  const pcs = party.map(p => ({
    ref: p, id: p.id, name: p.name || 'PC', kind: 'pc',
    hp: p.hp?.current ?? p.hp?.max ?? 10,
    hpMax: p.hp?.max ?? 10,
    ac: deriveAC(p),
    weapon: p.equipment?.mainhand || null,
    _chosenWeapon: p.equipment?.mainhand || null,   // M42 weapon-of-the-turn
    conditions: Array.isArray(p.conditions) ? [...p.conditions] : [],
    _position: p._position,
    damageDealt: 0,
    combatMods: p.combatMods || [],
    _reactionUsed: false,        // M33.0
    // M64 T5 — the one slot ledger: leveled spells, Smite, Shield and
    // Counterspell all draw from _slots.
    _slots: slotsForPc(p),
    _shieldActive: false,
    // M42 — Per-encounter feature usage flags (Action Surge, Second Wind)
    _actionSurgeUsed: 0,
    _secondWindUsed: false,
    _sneakAttackUsedThisTurn: false,
    _cunningActionUsedThisTurn: false
  }));
  const mons = monsters.map(m => {
    const preset = MONSTER_PRESETS[m.presetSlug] || {};
    return {
      ref: m, id: m.id, name: m.name || 'Monster', kind: 'monster', presetSlug: m.presetSlug,
      hp: m.hp?.current ?? m.hp?.max ?? preset.defaultHp?.max ?? 1,
      hpMax: m.hp?.max ?? preset.defaultHp?.max ?? 1,
      ac: preset.ac ?? 12,
      attack: preset.attack || { name: 'Strike', bonus: 2, dice: '1d6' },
      conditions: Array.isArray(m.conditions) ? [...m.conditions] : [],
      position: m.position,
      damageDealt: 0,
      _reactionUsed: false,                         // M33
      _slots: isSpellcaster(m.presetSlug)            // M34
        ? freshSlots(m.presetSlug) : null,
      _innate: isInnateCaster(m.presetSlug)          // M37
        ? freshInnateState(m.presetSlug) : null,
      _legendaryBudget: isLegendary(m.presetSlug)    // M41
        ? freshLegendaryBudget(m.presetSlug) : 0,
      _concentrating: null
    };
  });

  // Simple initiative: PCs first, then monsters, both in input order.
  // 5e RAW would roll DEX-mod initiative per side — out of v1 scope.
  let round = 0;
  while (round < maxRounds) {
    round++;
    if (sideAlive(pcs) === 0 || sideAlive(mons) === 0) break;
    // M33 — refresh every entity's reaction at the top of each round.
    // 5e refreshes at start of *each* creature's turn, but since our
    // simulator runs everyone once per round, top-of-round is equivalent.
    resetReactionsForAll(pcs);
    resetReactionsForAll(mons);
    // M42.1 — Reckless Attack expires at start of barb's next turn.
    // Top-of-round is the conservative approximation in our flat
    // initiative model; the downside lingers a full round.
    for (const p of pcs) { p._recklessUsedThisTurn = false; p._recklessUntilNextTurn = false; }
    // M41 — Refresh each legendary monster's budget at the top of every
    // round (RAW: start of its own turn). Since the simulator runs all
    // monsters once per round, top-of-round is equivalent here.
    for (const m of mons) if (isAlive(m) && isLegendary(m.presetSlug)) resetLegendaryBudget(m);
    // PCs swing first
    for (const a of pcs) {
      if (!isAlive(a)) continue;
      if (isIncapacitated(a)) continue;
      // M64 T1 — runOneAttack is async: un-awaited, any turn that
      // provoked an opportunity attack deferred its move, its reaction
      // spend and its attack until after the iteration returned.
      await runOneAttack(a, mons, pcs, scene, rng);
      // M41 — After this PC's turn ends, any legendary monster spends
      // available legendary budget (greedy: highest-cost first).
      for (const lm of mons) {
        if (!isLegendary(lm.presetSlug) || !isAlive(lm)) continue;
        runLegendaryActions(lm, pcs, scene, rng);
      }
      if (sideAlive(mons) === 0) break;
    }
    if (sideAlive(mons) === 0) break;
    for (const a of mons) {
      if (!isAlive(a)) continue;
      if (isIncapacitated(a)) continue;
      await runOneAttack(a, pcs, mons, scene, rng);
      if (sideAlive(pcs) === 0) break;
    }
  }

  // Observe the exact state that is about to be scored (same tick).
  if (onIterationEnd) onIterationEnd({ index, rounds: round, pcs, mons });

  // Build a flat snapshot of every entity's end state for aggregation
  const endState = [
    ...pcs.map(p => ({ id: p.id, hp: p.hp, damageDealt: p.damageDealt })),
    ...mons.map(m => ({ id: m.id, hp: m.hp, damageDealt: m.damageDealt }))
  ];

  return {
    rounds: round,
    partyAlive: sideAlive(pcs) > 0,
    monstersAlive: sideAlive(mons) > 0,
    endState
  };
}

// ---------- Per-attack ----------


// ---------- Monster spellcasting (M34) ----------

/**
 * Resolve a monster's spell cast. Three branches by spell kind:
 *   cantrip-save / leveled-save   → DEX/WIS/CON save with optional damage
 *   spell-attack                  → roll vs target.ac (Shield-eligible)
 *   auto-hit                      → Magic Missile-style, no roll
 *
 * Damage applied to target.hp; conditions applied if listed; slots
 * consumed for non-cantrips; concentration replaced if the spell needs
 * it (PHB p203 — only one at a time).
 */


/** Pick the spellcasting ability stat for a PC's Counterspell check. */
/** M42.1 — Derive a spell-book shape for a PC caster (DC + attackBonus
 *  + abilityMod) so runMonsterSpell can apply spell math uniformly. */



// ---------- Legendary actions (M41) ----------

/**
 * Spend legendary actions at the end of an opponent's turn. Walks the
 * monster's remaining budget; each iteration picks the highest-cost
 * action whose budget fits. Stops when the budget is empty or no
 * action has a valid target.
 */
function runLegendaryActions(monster, enemies, scene, rng) {
  // Loop until budget exhausted or no usable action this round.
  for (let safety = 0; safety < 4; safety++) {
    if ((monster._legendaryBudget ?? 0) <= 0) return;
    const pick = chooseLegendaryAction({ self: monster, enemies });
    if (!pick) return;
    applyLegendaryAction(monster, pick, scene, rng);
    spendLegendaryAction(monster, pick.action);
  }
}

function applyLegendaryAction(monster, pick, scene, rng) {
  const { action } = pick;
  if (action.kind === 'melee-attack') {
    const target = pick.target;
    if (!target || !isAlive(target)) return;
    const atk = rollAttack({
      bonus: action.attackBonus,
      advantage: 'normal',
      targetAC: target.ac
    }, rng);
    // M33.1: Shield can still block a legendary melee attack.
    if (atk.hit && !atk.crit && target.kind === 'pc' &&
        shouldCastShield({ target, attackerTotal: atk.total, targetAc: target.ac })) {
      consumeShield(target);
      return;
    }
    if (!atk.hit) return;
    const dmg = rollDamage(action.dice, { crit: atk.crit }, rng);
    applyDamageToEntity(target, dmg.total, rng);
    monster.damageDealt += dmg.total;
    return;
  }
  if (action.kind === 'aoe-save') {
    const center = monster._position || monster.position;
    if (!center) return;
    for (const e of (pick.targets || [])) {
      if (!isAlive(e)) continue;
      const ep = e._position || e.position;
      if (!ep) continue;
      const dist = (Math.abs(ep.col - center.col) >= Math.abs(ep.row - center.row)
        ? Math.abs(ep.col - center.col) : Math.abs(ep.row - center.row)) * 5;
      if (dist > action.range) continue;
      const eBonus = saveBonusFor(e, action.saveStat);
      const save = rollSave({ bonus: eBonus, dc: action.dc }, rng);
      const dmgRoll = rollDamage(action.dice, { crit: false }, rng);
      let dmg = dmgRoll.total;
      if (save.success) dmg = Math.floor(dmg / 2);
      applyDamageToEntity(e, dmg, rng);
      monster.damageDealt += dmg;
    }
  }
}

// ---------- Reaction attack (M33.0) ----------

/**
 * Run a single attack as a reaction (e.g. opportunity attack). Reuses
 * the M11 resolver + roll pipeline but with a fixed attacker + target,
 * computing distance from the *interrupting cell* (mover.beforePos).
 *
 * Damage is applied to the target's hp counter; no plan/AI involved.
 */
// ---------- Legendary actions (M41) ----------

/**
 * Spend the legendary creature's remaining LA budget after an opposing
 * turn. Greedy: keeps picking the best LA the budget allows until
 * either the budget is exhausted or no more good options exist.
 *
 *   melee-attack — single-target d20 + damage roll against the nearest
 *                  enemy in reach (no Shield check; LAs are tail/wing
 *                  swipes, not weapon attacks for Shield purposes
 *                  — simplification).
 *   aoe-save     — every enemy in range rolls a save; half-on-save
 *                  damage on success.
 */

// ---------- Targeting + helpers ----------


// ---------- Stats aggregation ----------

function newStats(party, monsters, iterations) {
  const byId = new Map();
  const entities = [];
  for (const p of party) {
    byId.set(p.id, { id: p.id, name: p.name || 'PC', kind: 'pc', deaths: 0, hpSum: 0, damageSum: 0, hpMax: p.hp?.max ?? 10 });
    entities.push(p.id);
  }
  for (const m of monsters) {
    byId.set(m.id, { id: m.id, name: m.name || 'Monster', kind: 'monster', deaths: 0, hpSum: 0, damageSum: 0, hpMax: m.hp?.max ?? 1 });
    entities.push(m.id);
  }
  return {
    iterations,
    partyVictories: 0, monsterVictories: 0, draws: 0,
    totalRounds: 0,
    byId, entities
  };
}

function finalizeStats(stats) {
  const n = Math.max(1, stats.iterations);
  return {
    iterations: stats.iterations,
    partyVictories: stats.partyVictories,
    monsterVictories: stats.monsterVictories,
    draws: stats.draws,
    victoryRate: stats.partyVictories / n,
    avgRounds: stats.totalRounds / n,
    entities: [...stats.byId.values()].map(e => ({
      id: e.id, name: e.name, kind: e.kind, hpMax: e.hpMax,
      deathRate: e.deaths / n,
      avgFinalHp: e.hpSum / n,
      avgDamageDealt: e.damageSum / n
    }))
  };
}
