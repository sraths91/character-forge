/**
 * M45 Phase 4 — Unified combat engine.
 *
 * The "spine" of attack resolution. Owns the pure rules:
 *
 *   - Per-turn AI planning dispatch (delegates to chooseAction /
 *     choosePcAction; produces the plan that drives everything else)
 *   - Movement + opportunity-attack triggering
 *   - Weapon attack resolution: stats build → resolver call → roll →
 *     Shield reaction → damage application → feature triggers
 *     (Sneak Attack, Divine Smite, Reckless Attack, Action Surge)
 *   - Monster + PC spell casting (cast plan → book lookup →
 *     Counterspell window → spell-kind branch → damage / heal /
 *     conditions / concentration)
 *   - Opportunity / reaction attacks
 *
 * Why a separate module? The simulator (M20) used to own all of this
 * inline. Adding the live versus runner (M28+) created a second
 * implementation — different cinema callbacks, different prompt
 * sequencing, different reaction handling. The two paths drifted: by
 * M45 the live runner was missing PC AI entirely (Phases 2+3 fixed
 * that). To keep them from diverging again, both callers now route
 * through this engine.
 *
 *   - Simulator (headless): passes no `prompts` — every reaction
 *     auto-resolves the same way it always has.
 *   - Live runner: passes async prompt callbacks (Shield, Counterspell,
 *     cinema-round dispatch). The engine awaits them where relevant.
 *
 * Pure transforms over its inputs. RNG injectable. Tests against the
 * simulator path are the authoritative behavioural contract — if a
 * change here flips a simulator iteration's outcome, the refactor
 * went wrong.
 */

import { resolveAttack } from './combat-resolver.js';
import { rollAttack, rollDamage } from './combat-roll.js';
import { deriveWeaponAttack } from './pc-stats.js';
import { factionLists, chebyshevFeet } from './grid-rules.js';
import { planMovement, occupiedCellsOf } from './movement.js';
import { chooseAction, fleeTargetCell } from './ai/profile.js';
import { choosePcAction } from './ai/pc-action.js';
import { PC_FEATURES, resetPerTurnFlags } from './ai/pc-features.js';
import {
  consumeReaction, detectOpportunityAttacks, detectPolearmEntryOAs,
  shouldCastShield, canCastShield, consumeShield,
  slotsForPc, shouldCounterspell, consumeCounterspell, resolveCounterspell
} from './reactions.js';
import {
  consumeSlot, spellById, spellbookFor, freshInnateState,
  rollInnateRecharges, consumeInnate, applyUpcast
} from './monster-spells.js';
import {
  startConcentration, isConcentrating, dropConcentration,
  handleDamageOnConcentration
} from './concentration.js';
import { rollSave } from './save-rolls.js';
import { MONSTER_DEFAULT_SAVES } from './monster-presets.js';

// =====================================================================
// runOneAttack — single-entity-turn entry point
// =====================================================================

/**
 * Resolve one entity's full turn: planner → movement → attack/cast.
 *
 * The simulator calls this for each entity in initiative order. The live
 * runner can use the same call path (passing async prompt callbacks for
 * the player-facing reactions). All side-effects land on the entity +
 * target records the caller already owns — no globals.
 *
 * @param {object} attacker — Entity wrapper { kind, ref, hp, ac, ... }
 * @param {object[]} enemies — opposing side's wrappers
 * @param {object[]} allies — same-side wrappers
 * @param {object} scene
 * @param {function} rng
 * @param {object} [prompts] — optional async callbacks for UI flows.
 *   Reserved for the live-runner migration; the simulator passes none.
 */
export function runOneAttack(attacker, enemies, allies, scene, rng, prompts = {}) {
  void prompts;   // reserved for live-runner migration; unused for now
  // M37 — At the start of each monster's turn, roll d6 for any innate
  // spells that are cooling down. The recharged-list isn't surfaced in
  // the simulator path (we have no log here); main.js can read it for
  // versus.
  if (attacker.kind === 'monster' && attacker._innate) {
    rollInnateRecharges(attacker, rng);
  }
  // M32 — Monsters consult their AI profile.
  // M42 — PCs do too. choosePcAction picks weapon/spell/feature and
  // returns the same plan shape so the dispatch below stays unified.
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
    // M42 — Per-turn AI for PCs. Resets sneak-attack/cunning-action
    // flags first, then picks the best (weapon/spell/feature) action.
    resetPerTurnFlags(attacker);
    plan = choosePcAction({
      self: attacker,
      enemies: enemies.filter(isAlive),
      allies: allies.filter(isAlive),
      rng
    });
    attacker._lastPlan = plan;
    if (plan?.weapon) attacker._chosenWeapon = plan.weapon;
    if (plan?.targetId) target = enemies.find(e => e.id === plan.targetId);
    else target = pickTarget(enemies);
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
  // M42 — Non-attack PC actions skip the resolver entirely.
  if (plan && (plan.kind === 'dash' || plan.kind === 'dodge' || plan.kind === 'disengage')) {
    return;
  }

  // M34 — Casting branch.
  if (plan && plan.kind === 'cast') {
    let castTarget = target;
    if (plan.targetSide === 'ally') {
      castTarget = allies.find(a => a.id === plan.targetId) || null;
    }
    if (!castTarget) return;
    if (attacker.kind === 'pc' && !attacker._slots) {
      attacker._slots = slotsForPc(attacker.ref || attacker);
    }
    runMonsterSpell({
      attacker, target: castTarget, plan, scene, rng,
      witnesses: enemies.filter(isAlive).filter(e => e.kind === 'pc'),
      allEnemies: enemies
    });
    return;
  }

  // Build the resolver context. PCs use deriveWeaponAttack; monsters
  // use the preset attack record directly. M42 weapon-switch is honored
  // via attacker._chosenWeapon (set by the planner above).
  let attackStats;
  if (attacker.kind === 'pc') {
    const chosen = attacker._chosenWeapon || attacker.weapon;
    const a = deriveWeaponAttack(attacker.ref, chosen);
    attackStats = {
      bonus: a.bonus, dice: a.dice, damageType: a.damageType,
      parts: [{ source: chosen?.name || 'Attack', value: a.bonus }],
      damageParts: []
    };
    // M42 — Sneak Attack
    if (plan?.featuresFired?.includes('sneak-attack')) {
      const lvl = (attacker.ref.classes || []).find(c => /rogue/i.test(c.name))?.level || 1;
      const saDice = Math.max(1, Math.ceil(lvl / 2));
      attackStats.dice = `${attackStats.dice}+${saDice}d6`;
      PC_FEATURES['sneak-attack'].consume(attacker);
    }
    // M42.1 — Reckless Attack
    if (plan?.featuresFired?.includes('reckless-attack')) {
      PC_FEATURES['reckless-attack'].consume(attacker);
    }
  } else {
    attackStats = {
      bonus: attacker.attack.bonus, dice: attacker.attack.dice,
      damageType: null,
      parts: [{ source: attacker.attack.name, value: attacker.attack.bonus }],
      damageParts: []
    };
  }

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

  // M42.1 — Reckless Attack overrides advantage on the barb's swing.
  let advantageOverride = 'auto';
  if (attacker.kind === 'pc' && attacker._recklessUntilNextTurn) {
    advantageOverride = 'advantage';
  } else if (attacker.kind === 'monster' && target?._recklessUntilNextTurn) {
    advantageOverride = 'advantage';
  }
  const verdict = resolveAttack({
    attacker: attackerForResolver,
    target: targetForResolver,
    weapon: attacker.kind === 'pc' ? attacker.weapon : { name: attacker.attack.name },
    scene,
    attackerKind: attacker.kind,
    targetKind: target.kind,
    targetAC: target.ac,
    advantageOverride,
    allies: allyList,
    hostiles: hostileList,
    attackStats
  });

  if (verdict.autoMiss) return;

  const finalBonus = verdict.attackBonus.total;
  const finalDmgDice = verdict.damage.dice;
  let atk;
  if (verdict.autoCrit) {
    atk = { hit: true, crit: true, total: 20 + finalBonus };
  } else {
    atk = rollAttack({ bonus: finalBonus, advantage: verdict.d20.mode, targetAC: target.ac }, rng);
  }
  // M33.1 — Shield reaction (target casts AFTER the roll lands).
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

  // M42.1 — Divine Smite
  if (attacker.kind === 'pc' && plan?.featuresFired?.includes('divine-smite')) {
    PC_FEATURES['divine-smite'].consume(attacker);
    const slotLevel = attacker._smiteSlotUsed || 1;
    let smiteDice = Math.min(5, 2 + (slotLevel - 1));
    const tType = String(target?.ref?.race?.name || target?.presetSlug || '').toLowerCase();
    if (/fiend|devil|demon|undead|zombie|skeleton|vampire|ghoul/.test(tType)) smiteDice += 1;
    const smiteRoll = rollDamage(`${smiteDice}d8`, { crit: atk.crit }, rng);
    target.hp = Math.max(0, target.hp - smiteRoll.total);
    attacker.damageDealt += smiteRoll.total;
  }

  // M42 — Action Surge: a second action right now.
  if (plan?.featuresFired?.includes('action-surge') && !attacker._surgeFiredThisTurn) {
    attacker._surgeFiredThisTurn = true;
    PC_FEATURES['action-surge'].consume(attacker);
    if (isAlive(attacker) && sideAlive(enemies) > 0) {
      runOneAttack(attacker, enemies, allies, scene, rng);
    }
    attacker._surgeFiredThisTurn = false;
  }
}

// =====================================================================
// runMonsterSpell — spell casting (both monster + PC)
// =====================================================================

export function runMonsterSpell({ attacker, target, plan, scene: _scene, rng, witnesses = [], allEnemies = [] }) {
  void _scene;
  const baseSpell = spellById(plan.spellId);
  if (!baseSpell) return;
  const spell = applyUpcast(baseSpell, plan.castAtLevel);
  const book = attacker.kind === 'monster' ? spellbookFor(attacker.presetSlug) : null;
  const innateBook = !book && attacker._innate
    ? { dc: 12, attackBonus: 4, abilityMod: 3 }
    : null;
  const pcBook = !book && !innateBook && attacker.kind === 'pc'
    ? pcSpellBook(attacker) : null;
  const effectiveBook = book || innateBook || pcBook;
  if (!effectiveBook) return;

  if (spell.concentration && isConcentrating(attacker)) dropConcentration(attacker);

  if (plan.isInnate) {
    if (!attacker._innate) attacker._innate = freshInnateState(attacker.presetSlug);
    consumeInnate(attacker, plan.spellId);
  } else {
    consumeSlot(attacker._slots, baseSpell, plan.castAtLevel);
  }

  // Counterspell window
  for (const witness of witnesses) {
    if (!shouldCounterspell(witness, spell.level)) continue;
    const ability = saveBonusFor(witness, abilityForCounterer(witness));
    const result = resolveCounterspell({ spellLevel: spell.level, counterMod: ability }, rng);
    consumeCounterspell(witness);
    if (result.countered) return;
    break;
  }

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
    const atk = rollAttack({
      bonus: effectiveBook.attackBonus,
      advantage: 'normal',
      targetAC: target.ac
    }, rng);
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

  // AoE save
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

  // Save-based, single target
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
  if (!save.success && spell.appliesCondition) {
    if (!target.conditions.includes(spell.appliesCondition)) {
      target.conditions.push(spell.appliesCondition);
    }
    if (spell.concentration) {
      startConcentration(attacker, spell, [target.id]);
    }
  }
}

// =====================================================================
// runReactionAttack — opportunity / reaction attacks
// =====================================================================

export function runReactionAttack(attacker, target, targetBeforePos, scene, rng) {
  if (!attacker || !target) return;
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

// =====================================================================
// Shared helpers (exported so simulator's legendary path can reuse them)
// =====================================================================

export function applyDamageToEntity(target, damage) {
  if (!target || damage <= 0) return;
  const before = target.hp;
  target.hp = Math.max(0, target.hp - damage);
  const dealtDamage = before - target.hp;
  if (dealtDamage > 0 && isConcentrating(target)) {
    const conMod = saveBonusFor(target, 'CON');
    handleDamageOnConcentration({ caster: target, damage: dealtDamage, conMod });
  }
}

export function pcSpellBook(attacker) {
  const ref = attacker.ref || attacker;
  const classes = ref?.classes || [];
  let stat = 'INT';
  for (const c of classes) {
    const name = String(c?.name || '').toLowerCase();
    if (name === 'cleric' || name === 'druid' || name === 'ranger') { stat = 'WIS'; break; }
    if (name === 'bard' || name === 'sorcerer' || name === 'warlock' || name === 'paladin') { stat = 'CHA'; break; }
    if (name === 'wizard' || name === 'artificer') { stat = 'INT'; break; }
  }
  const mod = ref?.abilityModifiers?.[stat] ?? 0;
  const prof = 2 + Math.floor(((classes[0]?.level || 1) - 1) / 4);
  return {
    dc: 8 + prof + mod,
    attackBonus: prof + mod,
    abilityMod: mod
  };
}

export function abilityForCounterer(pc) {
  const classes = pc?.ref?.classes || [];
  for (const c of classes) {
    const name = String(c?.name || '').toLowerCase();
    if (name === 'wizard' || name === 'artificer') return 'INT';
    if (name === 'cleric' || name === 'druid' || name === 'ranger') return 'WIS';
    if (name === 'bard' || name === 'sorcerer' || name === 'warlock' || name === 'paladin') return 'CHA';
  }
  return 'INT';
}

export function saveBonusFor(entity, stat) {
  if (!entity || !stat) return 0;
  if (entity.kind === 'pc') {
    const ref = entity.ref || entity;
    return ref.abilityModifiers?.[stat] ?? 0;
  }
  const table = MONSTER_DEFAULT_SAVES[entity.presetSlug];
  return table ? (table[stat] || 0) : 0;
}

export function pickTarget(enemies) {
  let best = null;
  for (const e of enemies) {
    if (!isAlive(e)) continue;
    if (!best || e.hp < best.hp) best = e;
  }
  return best;
}

export function isAlive(e) { return e.hp > 0; }
export function isIncapacitated(e) {
  const c = e.conditions || [];
  return c.includes('paralyzed') || c.includes('stunned') ||
         c.includes('unconscious') || c.includes('petrified');
}
export function sideAlive(side) {
  return side.filter(e => isAlive(e) && !isIncapacitated(e)).length;
}
