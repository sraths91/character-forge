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
import { factionLists, chebyshevFeet } from './grid-rules.js';
import { planMovement, occupiedCellsOf } from './movement.js';
import { chooseAction, fleeTargetCell } from './ai/profile.js';
import {
  resetReactionsForAll, consumeReaction, detectOpportunityAttacks,
  detectPolearmEntryOAs, shouldCastShield, canCastShield,
  consumeShield, lvl1SlotsForPc, lvl3SlotsForPc,
  shouldCounterspell, consumeCounterspell, resolveCounterspell
} from './reactions.js';
import {
  freshSlots, consumeSlot, spellById, spellbookFor, isSpellcaster,
  isInnateCaster, freshInnateState, rollInnateRecharges,
  consumeInnate, applyUpcast
} from './monster-spells.js';
import {
  startConcentration, isConcentrating, dropConcentration,
  handleDamageOnConcentration
} from './concentration.js';
import { rollSave } from './save-rolls.js';
import { MONSTER_DEFAULT_SAVES } from './monster-presets.js';

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
    combatMods: p.combatMods || [],
    _reactionUsed: false,        // M33.0
    _lvl1Slots: lvl1SlotsForPc(p), // M33.1 — Shield + other lvl-1 reactions
    _lvl3Slots: lvl3SlotsForPc(p), // M34.1 — Counterspell
    _shieldActive: false
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
  // M37 — At the start of each monster's turn, roll d6 for any innate
  // spells that are cooling down. The recharged-list isn't surfaced in
  // the simulator path (we have no log here); main.js can read it for
  // versus.
  if (attacker.kind === 'monster' && attacker._innate) {
    rollInnateRecharges(attacker, rng);
  }
  // M32 — For monsters, ask the AI profile which enemy to engage and
  // whether to flee. PCs still use the lowest-HP rule (simulator only
  // models monster intelligence in v1; PC choice is the player's job).
  let plan = null;
  let target;
  if (attacker.kind === 'monster') {
    plan = chooseAction({
      self: attacker,
      enemies: enemies.filter(isAlive),
      allies: allies.filter(isAlive),
      rng
    });
    attacker._lastPlan = plan;
    if (plan.targetId) {
      target = enemies.find(e => e.id === plan.targetId);
    } else {
      target = pickTarget(enemies);
    }
  } else {
    target = pickTarget(enemies);
  }
  if (!target) return;

  // M31 — Movement step before the attack. M32: if the profile said
  // 'flee', the attacker moves AWAY from the nearest threat instead of
  // toward it, and skips the attack roll this turn.
  const attackerPos = attacker._position || attacker.position;
  const targetPos   = target._position   || target.position;
  if (attackerPos && targetPos) {
    const weapon = attacker.kind === 'pc' ? attacker.weapon : { name: attacker.attack?.name };
    const occupied = occupiedCellsOf({
      party: allies, monsters: enemies,
      excludeId: attacker.id
    });
    const bounds = { cols: scene?.cols || 99, rows: scene?.rows || 99 };
    const moveTarget = (plan && plan.kind === 'flee')
      ? fleeTargetCell(attacker, target, bounds, rng)
      : targetPos;
    const next = planMovement({
      from: attackerPos, to: moveTarget, weapon,
      speedFt: 30, occupied, bounds
    });
    if (next && (next.col !== attackerPos.col || next.row !== attackerPos.row)) {
      // M33.0 — opportunity attacks fire BEFORE the move resolves.
      // The interrupting attack is made at the cell the mover is leaving
      // (PHB p195: "the reaction interrupts the provoking action").
      // M33.2 — Polearm Master entry-OAs use the *destination* cell so
      // we resolve them at the cell the mover is entering.
      const leaveTriggers = detectOpportunityAttacks({
        mover: attacker, before: attackerPos, after: next, hostiles: enemies
      });
      const entryTriggers = detectPolearmEntryOAs({
        mover: attacker, before: attackerPos, after: next, hostiles: enemies
      });
      for (const { triggerer } of leaveTriggers) {
        if (!isAlive(attacker)) break;
        runReactionAttack(triggerer, attacker, attackerPos, scene, rng);
        consumeReaction(triggerer);
      }
      for (const { triggerer } of entryTriggers) {
        if (!isAlive(attacker)) break;
        runReactionAttack(triggerer, attacker, next, scene, rng);
        consumeReaction(triggerer);
      }
      if (attacker.kind === 'pc') attacker._position = next;
      else attacker.position = next;
    }
  }

  // Fleeing creatures Dash instead of attacking
  if (plan && plan.kind === 'flee') return;

  // M34 — Casting branch: monster spends its action on a spell instead
  // of a weapon attack. Concentration spells replace any existing
  // concentration (PHB p203). Slots are deducted on cast (cantrips free).
  if (plan && plan.kind === 'cast') {
    // M34.2 — heals target an ally, not an enemy. The chooseAction
    // result tags targetSide='ally' for these; resolve against allies.
    let castTarget = target;
    if (plan.targetSide === 'ally') {
      castTarget = allies.find(a => a.id === plan.targetId) || null;
    }
    if (!castTarget) return;
    // M34.1 — witnesses = opposing-side PCs (the only Counterspell holders)
    // M37 — allEnemies = the mover's hostile side for AoE save spells
    runMonsterSpell({
      attacker, target: castTarget, plan, scene, rng,
      witnesses: enemies.filter(isAlive).filter(e => e.kind === 'pc'),
      allEnemies: enemies
    });
    return;
  }

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
  // M33.1 — Shield reaction (target casts AFTER the roll lands).
  // Cantrips of self-cast Shield convert a marginal hit into a miss.
  if (atk.hit && !atk.crit && target.kind === 'pc' &&
      shouldCastShield({ target, attackerTotal: atk.total, targetAc: target.ac })) {
    consumeShield(target);
    atk.hit = false;
    atk.shielded = true;
  }
  if (!atk.hit) return;
  const dmg = rollDamage(finalDmgDice, { crit: atk.crit }, rng);
  target.hp = Math.max(0, target.hp - dmg.total);
  attacker.damageDealt += dmg.total;
}

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
function runMonsterSpell({ attacker, target, plan, scene: _scene, rng, witnesses = [], allEnemies = [] }) {
  const baseSpell = spellById(plan.spellId);
  if (!baseSpell) return;
  // M40 — Upcasting: if the plan picked a higher slot level than the
  // spell's base, scale dice/darts accordingly. Pure: applyUpcast
  // returns a new spell-shaped object; never mutates the registry.
  const spell = applyUpcast(baseSpell, plan.castAtLevel);
  const book = spellbookFor(attacker.presetSlug);
  // M37 — innate-only casters have no slot book. We synthesize a
  // minimal "book" so the rest of the function (DC + attackBonus reads)
  // can stay unchanged.
  const innateBook = !book && attacker._innate
    ? { dc: 12, attackBonus: 4, abilityMod: 3 }       // safe defaults; real values come from MONSTER_INNATE if needed
    : null;
  const effectiveBook = book || innateBook;
  if (!effectiveBook) return;

  // Concentration replacement: dropping the previous spell would clear
  // its applied conditions, but we don't track that lookup here — just
  // mark concentration ended.
  if (spell.concentration && isConcentrating(attacker)) dropConcentration(attacker);

  // M37 — resource accounting. Slot-cast spells decrement the slot pool;
  // innates use their own atWill / recharge / perDay pools.
  // M40 — slot consumption uses plan.castAtLevel so upcasted spells
  // burn the right slot.
  if (plan.isInnate) {
    consumeInnate(attacker, plan.spellId);
  } else {
    consumeSlot(attacker._slots, baseSpell, plan.castAtLevel);
  }

  // M34.1 — Counterspell window: any witness (opposing-side caster) can
  // attempt to counter before the spell resolves. First successful
  // counter wins; the rest don't get to try.
  for (const witness of witnesses) {
    if (!shouldCounterspell(witness, spell.level)) continue;
    const ability = saveBonusFor(witness, abilityForCounterer(witness));
    const result = resolveCounterspell({ spellLevel: spell.level, counterMod: ability }, rng);
    consumeCounterspell(witness);
    if (result.countered) return;     // spell fizzles; slot already burned
    break;                            // failed counter still burns the reaction
  }

  // M34.2 — Healing spells: roll dice + add caster's spellcasting mod.
  if (spell.kind === 'heal') {
    const dmgRoll = rollDamage(spell.dice, { crit: false }, rng);
    const mod = spell.addsAbilityMod ? (effectiveBook.abilityMod || 0) : 0;
    const heal = dmgRoll.total + mod;
    if (target?.hpMax > 0) {
      target.hp = Math.min(target.hpMax, target.hp + heal);
    }
    return;
  }

  if (spell.kind === 'auto-hit') {
    // PHB Shield (p275): "you take no damage from magic missile."
    // The reaction triggers on being targeted; if PC has the resources,
    // they cast it and negate every dart.
    if (target.kind === 'pc' && canCastShield(target)) {
      consumeShield(target);
      return;
    }
    const darts = spell.darts || 1;
    let totalDmg = 0;
    for (let i = 0; i < darts; i++) {
      const r = rollDamage(spell.perDart, { crit: false }, rng);
      totalDmg += r.total;
    }
    applyDamageToEntity(target, totalDmg);
    attacker.damageDealt += totalDmg;
    return;
  }

  if (spell.kind === 'spell-attack') {
    // Spell attack roll: 1d20 + attackBonus vs target.ac
    const atk = rollAttack({
      bonus: effectiveBook.attackBonus,
      advantage: 'normal',
      targetAC: target.ac
    }, rng);
    // M34 + M33.1: Shield blocks spell attacks too (PHB p275 RAW)
    if (atk.hit && !atk.crit && target.kind === 'pc' &&
        shouldCastShield({ target, attackerTotal: atk.total, targetAc: target.ac })) {
      consumeShield(target);
      return;
    }
    if (!atk.hit) return;
    const dmg = rollDamage(spell.dice, { crit: atk.crit }, rng);
    applyDamageToEntity(target, dmg.total);
    attacker.damageDealt += dmg.total;
    return;
  }

  // M37 — AoE save spells (like dragon breath) hit every hostile within
  // the spell's range, rolling an independent save per target.
  if (spell.aoe && allEnemies.length > 0) {
    const center = attacker._position || attacker.position;
    if (center) {
      let totalDmg = 0;
      for (const e of allEnemies) {
        if (!isAlive(e)) continue;
        const ep = e._position || e.position;
        if (!ep) continue;
        if (chebyshevFeet(center, ep) > (spell.range || 15)) continue;
        const eBonus = saveBonusFor(e, spell.saveStat);
        const eSave = rollSave({ bonus: eBonus, dc: effectiveBook.dc }, rng);
        const dmgRoll = rollDamage(spell.dice, { crit: false }, rng);
        let dmg = dmgRoll.total;
        if (eSave.success) dmg = spell.saveOnHalf ? Math.floor(dmg / 2) : 0;
        applyDamageToEntity(e, dmg);
        totalDmg += dmg;
      }
      attacker.damageDealt += totalDmg;
    }
    return;
  }

  // Save-based (cantrip-save or leveled-save), single target
  const saveStat = spell.saveStat;
  const targetSaveBonus = saveBonusFor(target, saveStat);
  const save = rollSave({ bonus: targetSaveBonus, dc: effectiveBook.dc }, rng);
  if (spell.dice) {
    const dmgRoll = rollDamage(spell.dice, { crit: false }, rng);
    let dmg = dmgRoll.total;
    if (save.success) dmg = spell.saveOnHalf ? Math.floor(dmg / 2) : 0;
    applyDamageToEntity(target, dmg);
    attacker.damageDealt += dmg;
  }
  // Apply a condition on failed save (Hold Person → paralyzed)
  if (!save.success && spell.appliesCondition) {
    if (!target.conditions.includes(spell.appliesCondition)) {
      target.conditions.push(spell.appliesCondition);
    }
    if (spell.concentration) {
      startConcentration(attacker, spell, [target.id]);
    }
  }
}

function applyDamageToEntity(target, damage) {
  if (!target || damage <= 0) return;
  const before = target.hp;
  target.hp = Math.max(0, target.hp - damage);
  // M34: concentration save on damage taken
  const dealtDamage = before - target.hp;
  if (dealtDamage > 0 && isConcentrating(target)) {
    const conMod = saveBonusFor(target, 'CON');
    // Note: not threading rng here makes this non-deterministic when
    // a concentrating target takes auto-hit damage. The simulator's
    // runMonsterSpell already passed rng down to rollDamage, but we
    // lose it here. Acceptable v1 trade-off: concentrating monsters
    // are rare (cult fanatic only); we can plumb rng later if needed.
    handleDamageOnConcentration({ caster: target, damage: dealtDamage, conMod });
  }
}

/** Pick the spellcasting ability stat for a PC's Counterspell check. */
function abilityForCounterer(pc) {
  const classes = pc?.ref?.classes || [];
  for (const c of classes) {
    const name = String(c?.name || '').toLowerCase();
    if (name === 'wizard' || name === 'artificer') return 'INT';
    if (name === 'cleric' || name === 'druid' || name === 'ranger') return 'WIS';
    if (name === 'bard' || name === 'sorcerer' || name === 'warlock' || name === 'paladin') return 'CHA';
  }
  return 'INT';
}

function saveBonusFor(entity, stat) {
  if (!entity || !stat) return 0;
  if (entity.kind === 'pc') {
    const ref = entity.ref || entity;
    return ref.abilityModifiers?.[stat] ?? 0;
  }
  // Monster — read from MONSTER_DEFAULT_SAVES
  const table = MONSTER_DEFAULT_SAVES[entity.presetSlug];
  return table ? (table[stat] || 0) : 0;
}

// ---------- Reaction attack (M33.0) ----------

/**
 * Run a single attack as a reaction (e.g. opportunity attack). Reuses
 * the M11 resolver + roll pipeline but with a fixed attacker + target,
 * computing distance from the *interrupting cell* (mover.beforePos).
 *
 * Damage is applied to the target's hp counter; no plan/AI involved.
 */
function runReactionAttack(attacker, target, targetBeforePos, scene, rng) {
  if (!attacker || !target) return;
  // The mover (target of the OA) is interrupted at `targetBeforePos`.
  // We pass that as their position so the resolver computes reach
  // distance from the cell they were in when they triggered the OA.
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
  const targetForResolver = {
    ...target.ref,
    conditions: target.conditions,
    _position: targetBeforePos
  };
  const attackerForResolver = {
    ...attacker.ref,
    conditions: attacker.conditions,
    _position: attacker._position || attacker.position,
    combatMods: attacker.combatMods || attacker.ref?.combatMods || []
  };
  const verdict = resolveAttack({
    attacker: attackerForResolver,
    target: targetForResolver,
    weapon: attacker.kind === 'pc' ? attacker.weapon : { name: attacker.attack.name },
    scene,
    attackerKind: attacker.kind,
    targetKind: target.kind,
    targetAC: target.ac,
    advantageOverride: 'auto',
    allies: [], hostiles: [],
    attackStats
  });
  if (verdict.autoMiss) return;
  const atk = verdict.autoCrit
    ? { hit: true, crit: true, total: 20 + verdict.attackBonus.total }
    : rollAttack({ bonus: verdict.attackBonus.total, advantage: verdict.d20.mode, targetAC: target.ac }, rng);
  // M33.1 — OA can also be Shield-blocked.
  if (atk.hit && !atk.crit && target.kind === 'pc' &&
      shouldCastShield({ target, attackerTotal: atk.total, targetAc: target.ac })) {
    consumeShield(target);
    atk.hit = false;
  }
  if (!atk.hit) return;
  const dmg = rollDamage(verdict.damage.dice, { crit: atk.crit }, rng);
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
