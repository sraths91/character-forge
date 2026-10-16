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

import { deriveAC } from './pc-stats.js';
import { MONSTER_PRESETS } from './monster-presets.js';
import { slotsForPc, pactForPc } from './reactions.js';
import {
  freshSlots, isSpellcaster, isInnateCaster, freshInnateState
} from './monster-spells.js';
import { isLegendary, freshLegendaryBudget } from './monster-legendary.js';
import { createRng } from './rng.js';
import { createTurnState, startEncounter, runEncounter } from './turn-manager.js';
// M45 Phase 4 — Combat resolution moved to a shared engine module so
// the live runner can dispatch through the same spine without
// re-implementing rules. Per-attack logic, spell casting, reactions,
// and the helper cluster (saveBonusFor / isAlive / sideAlive / etc.)
// all live in combat-engine.js now.
import { sideAlive } from './combat-engine.js';

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
    hpTemp: p.hp?.temp ?? 0,                     // M64 R8 — absorbed first
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
    _pact: pactForPc(p),
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
      hpTemp: m.hp?.temp ?? 0,
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

  // M64 T7 — the round loop is the engine turn manager (one loop for the
  // simulator, the browser and the server). The simulator keeps its
  // fixed order — PCs first, then monsters, both in input order — so
  // calibrations stay comparable, and counts an incapacitated side as out
  // ('standing'). Start-of-turn resets (reaction, Reckless, legendary
  // budget) are per creature; legendary actions follow every opposing turn.
  const ts = createTurnState({
    wrappers: [...pcs, ...mons],
    sides: w => (w.kind === 'pc' ? 'party' : 'hostile'),
    scene
  });
  startEncounter(ts, { initiative: 'given', maxRounds });
  await runEncounter(ts, { rng, victoryRule: 'standing' });
  const round = ts.round;

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
