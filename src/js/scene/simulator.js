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

import { resolveAttack } from './combat-resolver.js';
import { rollAttack, rollDamage } from './combat-roll.js';
import { deriveAC, deriveWeaponAttack } from './pc-stats.js';
import { MONSTER_PRESETS } from './monster-presets.js';
import { factionLists } from './grid-rules.js';

/**
 * Small mulberry32 PRNG. Pure JS, deterministic, fast. Seed in (0, 2^32).
 * Returns a function compatible with the resolver's rng param.
 */
export function seedRng(seed) {
  let s = seed >>> 0;
  return function rng() {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
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
 *
 * Returns:
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
export function simulateEncounter({ party = [], monsters = [], scene = {}, iterations = 200, maxRounds = 12, seed = 1 } = {}) {
  const stats = newStats(party, monsters, iterations);

  for (let i = 0; i < iterations; i++) {
    const rng = seedRng(seed + i);
    const result = runOneIteration({ party, monsters, scene, maxRounds, rng });

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

function runOneIteration({ party, monsters, scene, maxRounds, rng }) {
  // Per-iteration ENTITY STATE — shallow copies so we don't mutate inputs.
  // hp is the live counter; the resolver reads conditions for adv/disadv
  // but doesn't read hp, so we track damage separately.
  const pcs = party.map(p => ({
    ref: p, id: p.id, name: p.name || 'PC', kind: 'pc',
    hp: p.hp?.current ?? p.hp?.max ?? 10,
    hpMax: p.hp?.max ?? 10,
    ac: deriveAC(p),
    weapon: p.equipment?.mainhand || null,
    conditions: Array.isArray(p.conditions) ? [...p.conditions] : [],
    _position: p._position,
    damageDealt: 0,
    combatMods: p.combatMods || []
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
      damageDealt: 0
    };
  });

  // Simple initiative: PCs first, then monsters, both in input order.
  // 5e RAW would roll DEX-mod initiative per side — out of v1 scope.
  let round = 0;
  while (round < maxRounds) {
    round++;
    if (sideAlive(pcs) === 0 || sideAlive(mons) === 0) break;
    // PCs swing first
    for (const a of pcs) {
      if (!isAlive(a)) continue;
      if (isIncapacitated(a)) continue;
      runOneAttack(a, mons, pcs, scene, rng);
      if (sideAlive(mons) === 0) break;
    }
    if (sideAlive(mons) === 0) break;
    for (const a of mons) {
      if (!isAlive(a)) continue;
      if (isIncapacitated(a)) continue;
      runOneAttack(a, pcs, mons, scene, rng);
      if (sideAlive(pcs) === 0) break;
    }
  }

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

function runOneAttack(attacker, enemies, allies, scene, rng) {
  const target = pickTarget(enemies);
  if (!target) return;

  // Build the resolver context. For PCs we use deriveWeaponAttack; for
  // monsters we use the preset attack record directly.
  let attackStats;
  if (attacker.kind === 'pc') {
    const a = deriveWeaponAttack(attacker.ref, attacker.weapon);
    attackStats = {
      bonus: a.bonus, dice: a.dice, damageType: a.damageType,
      parts: [{ source: attacker.weapon?.name || 'Attack', value: a.bonus }],
      damageParts: []
    };
  } else {
    attackStats = {
      bonus: attacker.attack.bonus, dice: attacker.attack.dice,
      damageType: null,
      parts: [{ source: attacker.attack.name, value: attacker.attack.bonus }],
      damageParts: []
    };
  }

  // factionLists wants the raw refs — we pass shallow-shapes so the
  // resolver can read .conditions / position.
  const attackerForResolver = {
    ...attacker.ref,
    conditions: attacker.conditions,
    _position: attacker._position || attacker.position,
    combatMods: attacker.combatMods || attacker.ref?.combatMods || []
  };
  const targetForResolver = {
    ...target.ref,
    conditions: target.conditions,
    _position: target._position || target.position
  };
  const { allies: allyList, hostiles: hostileList } = factionLists({
    attackerKind: attacker.kind,
    attackerId: attacker.id,
    party: attacker.kind === 'pc'
      ? allies.map(p => ({ ...p.ref, _position: p._position, conditions: p.conditions, id: p.id, name: p.name }))
      : enemies.map(p => ({ ...p.ref, _position: p._position, conditions: p.conditions, id: p.id, name: p.name })),
    monsters: attacker.kind === 'pc'
      ? enemies.map(m => ({ ...m.ref, position: m.position, conditions: m.conditions, id: m.id, name: m.name }))
      : allies.map(m => ({ ...m.ref, position: m.position, conditions: m.conditions, id: m.id, name: m.name }))
  });

  const verdict = resolveAttack({
    attacker: attackerForResolver,
    target: targetForResolver,
    weapon: attacker.kind === 'pc' ? attacker.weapon : { name: attacker.attack.name },
    scene,
    attackerKind: attacker.kind,
    targetKind: target.kind,
    targetAC: target.ac,
    advantageOverride: 'auto',
    allies: allyList,
    hostiles: hostileList,
    attackStats
  });

  if (verdict.autoMiss) return;   // attacker incapacitated / out of reach

  const finalBonus = verdict.attackBonus.total;
  const finalDmgDice = verdict.damage.dice;
  let atk;
  if (verdict.autoCrit) {
    atk = { hit: true, crit: true, total: 20 + finalBonus };
  } else {
    atk = rollAttack({ bonus: finalBonus, advantage: verdict.d20.mode, targetAC: target.ac }, rng);
  }
  if (!atk.hit) return;
  const dmg = rollDamage(finalDmgDice, { crit: atk.crit }, rng);
  target.hp = Math.max(0, target.hp - dmg.total);
  attacker.damageDealt += dmg.total;
}

// ---------- Targeting + helpers ----------

function pickTarget(enemies) {
  // Lowest current HP (alive) — represents focus-fire strategy.
  let best = null;
  for (const e of enemies) {
    if (!isAlive(e)) continue;
    if (!best || e.hp < best.hp) best = e;
  }
  return best;
}

function isAlive(e) { return e.hp > 0; }
function isIncapacitated(e) {
  const c = e.conditions || [];
  return c.includes('paralyzed') || c.includes('stunned') ||
         c.includes('unconscious') || c.includes('petrified');
}
function sideAlive(side) {
  return side.filter(e => isAlive(e) && !isIncapacitated(e)).length;
}

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
