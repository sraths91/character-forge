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
import {
  deriveWeaponAttack, saveBonus as pcSaveBonus, proficiencyBonus, totalLevel
} from './pc-stats.js';
import { factionLists, chebyshevFeet } from './grid-rules.js';
import { planMovement, occupiedCellsOf } from './movement.js';
import { chooseAction, fleeTargetCell } from './ai/profile.js';
import { choosePcAction } from './ai/pc-action.js';
import { PC_FEATURES, resetPerTurnFlags } from './ai/pc-features.js';
import {
  consumeReaction, detectOpportunityAttacks, detectPolearmEntryOAs,
  shouldCastShield, canCastShield, consumeShield, hasReactionAvailable,
  slotsForPc, shouldCounterspell, canCastCounterspell, consumeCounterspell,
  resolveCounterspell
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
/**
 * @typedef {object} EnginePrompts
 * @property {function} [onShieldReaction]  — async ({ defender, atk, weapon, spell?, autoAnswer }) → boolean
 *   Offered only when the defender can actually cast Shield and +5 AC
 *   would turn the hit into a miss. Fires for weapon attacks, OAs,
 *   spell attacks (`spell` set) and Magic Missile (`spell` set; `atk` is
 *   `{ hit: true, crit: false, total: null, autoHit: true }`).
 * @property {function} [onCounterspell]    — async ({ witness, caster, spell, autoAnswer }) → boolean
 *   Offered only to witnesses for whom canCastCounterspell() is true.
 * @property {function} [onReactionAttack]  — async ({ triggerer, mover, kind, autoAnswer }) → boolean
 *
 * M64 N1 — reaction answers are GATED: a `true` answer is re-checked
 * against the reactor's eligibility (canCastShield / canCastCounterspell
 * / hasReactionAvailable) after the await resolves, so no caller — a
 * dialog, a socket, a bug — can grant a reaction the creature lacks.
 * @property {function} [onCinemaRound]     — async ({ attacker, defender, plan, atk, dmg, crit }) → void
 * @property {function} [onCastBegin]       — async ({ attacker, target, plan }) → void
 *
 * Every callback is optional. The simulator passes {} so existing tests
 * see identical behaviour. The live runner passes real callbacks that
 * pop reaction dialogs, dramatize cinema rounds, etc.
 *
 * Each callback receives an `autoAnswer` field (where applicable) — the
 * value the simulator's heuristic would have chosen — so an auto-fight
 * UI can short-circuit prompts when configured.
 */

export async function runOneAttack(attacker, enemies, allies, scene, rng, prompts = {}) {
  // M37 — At the start of each monster's turn, roll d6 for any innate
  // spells that are cooling down. The recharged-list isn't surfaced in
  // the simulator path (we have no log here); main.js can read it for
  // versus. M64 T2 — this is the single source of the per-turn recharge
  // roll; callers (the live runner included) must not roll it again.
  if (attacker.kind === 'monster' && attacker._innate) {
    rollInnateRecharges(attacker, rng);
  }
  // M32 — Monsters consult their AI profile.
  // M42 — PCs do too. choosePcAction picks weapon/spell/feature and
  // returns the same plan shape so the dispatch below stays unified.
  // M45 Phase 4b.3 — Manual play bypasses AI planning via
  // `prompts.forcePlan` — the caller hands in a pre-built plan
  // (kind + targetId + weapon/spell) and the engine resolves it as-is.
  let plan = null;
  let target;
  if (prompts.forcePlan) {
    plan = prompts.forcePlan;
    attacker._lastPlan = plan;
    // M51.1 — Set BOTH the resolution weapon (_chosenWeapon) AND the
    // display/movement weapon (attacker.weapon) so a player-chosen weapon
    // (e.g. the warhammer) drives reach, the to-hit/damage in the log,
    // and the cinema — not just the damage roll. Without updating
    // attacker.weapon the log mislabeled the swing with the mainhand.
    if (plan.weapon) { attacker._chosenWeapon = plan.weapon; attacker.weapon = plan.weapon; }
    if (plan.targetSide === 'ally') {
      target = allies.find(a => String(a.id) === String(plan.targetId));
    } else if (plan.targetId) {
      target = enemies.find(e => String(e.id) === String(plan.targetId));
    } else {
      target = pickTarget(enemies);
    }
  } else if (attacker.kind === 'monster') {
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
    // M51.1 — keep the display/movement weapon in sync with the AI's pick
    // so weapon switches show correctly in the live cinema + attack log.
    if (plan?.weapon) { attacker._chosenWeapon = plan.weapon; attacker.weapon = plan.weapon; }
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
        // M45 Phase 4b — Optional prompt. Default (simulator path) is
        // "always fire the OA"; live runner returns false to skip when
        // the player declines to spend their reaction.
        const fire = prompts.onReactionAttack
          ? await prompts.onReactionAttack({ triggerer, mover: attacker, kind: 'leave', autoAnswer: true })
          : true;
        // M64 N1 — gate the answer: the triggerer must still have its reaction.
        if (fire && hasReactionAvailable(triggerer)) {
          await runReactionAttack(triggerer, attacker, attackerPos, scene, rng, prompts);
          consumeReaction(triggerer);
        }
      }
      for (const { triggerer } of entryTriggers) {
        if (!isAlive(attacker)) break;
        const fire = prompts.onReactionAttack
          ? await prompts.onReactionAttack({ triggerer, mover: attacker, kind: 'entry', autoAnswer: true })
          : true;
        if (fire && hasReactionAvailable(triggerer)) {
          await runReactionAttack(triggerer, attacker, next, scene, rng, prompts);
          consumeReaction(triggerer);
        }
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
    await runMonsterSpell({
      attacker, target: castTarget, plan, scene, rng,
      witnesses: enemies.filter(isAlive).filter(e => e.kind === 'pc'),
      allEnemies: enemies,
      prompts
    });
    return;
  }

  // Build the resolver context. PCs use deriveWeaponAttack; monsters
  // use the preset attack record directly. M42 weapon-switch is honored
  // via attacker._chosenWeapon (set by the planner above).
  let attackStats;
  let sneakDice = 0;
  if (attacker.kind === 'pc') {
    const chosen = attacker._chosenWeapon || attacker.weapon;
    const a = deriveWeaponAttack(attacker.ref, chosen);
    attackStats = {
      bonus: a.bonus, dice: a.dice, damageType: a.damageType,
      parts: [{ source: chosen?.name || 'Attack', value: a.bonus }],
      damageParts: []
    };
    // M42 — Sneak Attack. M64 R1 — the extra dice are appended AFTER the
    // resolver (below) so its flat combatMods damage fold still sees a
    // single-term spec; rollDamage handles the multi-term result.
    if (plan?.featuresFired?.includes('sneak-attack')) {
      const lvl = (attacker.ref.classes || []).find(c => /rogue/i.test(c.name))?.level || 1;
      sneakDice = Math.max(1, Math.ceil(lvl / 2));
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
  const finalDmgDice = sneakDice > 0
    ? `${verdict.damage.dice}+${sneakDice}d6`
    : verdict.damage.dice;
  let atk;
  if (verdict.autoCrit) {
    atk = { hit: true, crit: true, total: 20 + finalBonus };
  } else {
    atk = rollAttack({ bonus: finalBonus, advantage: verdict.d20.mode, targetAC: target.ac }, rng);
  }
  // M33.1 — Shield reaction (target casts AFTER the roll lands).
  // M45 Phase 4b — Optional prompt. Simulator path keeps the auto-cast
  // heuristic; live runner can override via prompts.onShieldReaction.
  // M64 N1 — offered only when Shield could block it; answer gated.
  if (await askShield(target, atk, { weapon: attacker.weapon }, prompts)) {
    consumeShield(target);
    atk.hit = false;
    atk.shielded = true;
  }
  if (!atk.hit) {
    // Dispatch a cinema round for the miss too — the live runner uses
    // this to dramatize the swing even when no damage lands.
    if (prompts.onCinemaRound) {
      await prompts.onCinemaRound({
        attacker, defender: target, plan, atk, dmg: 0, crit: false, miss: true
      });
    }
    return;
  }
  const dmg = rollDamage(finalDmgDice, { crit: atk.crit }, rng);
  target.hp = Math.max(0, target.hp - dmg.total);
  attacker.damageDealt += dmg.total;

  // M42.1 — Divine Smite
  let smiteTotal = 0;
  if (attacker.kind === 'pc' && plan?.featuresFired?.includes('divine-smite')) {
    PC_FEATURES['divine-smite'].consume(attacker, rng);
    const slotLevel = attacker._smiteSlotUsed || 1;
    let smiteDice = Math.min(5, 2 + (slotLevel - 1));
    const tType = String(target?.ref?.race?.name || target?.presetSlug || '').toLowerCase();
    if (/fiend|devil|demon|undead|zombie|skeleton|vampire|ghoul/.test(tType)) smiteDice += 1;
    const smiteRoll = rollDamage(`${smiteDice}d8`, { crit: atk.crit }, rng);
    target.hp = Math.max(0, target.hp - smiteRoll.total);
    attacker.damageDealt += smiteRoll.total;
    smiteTotal = smiteRoll.total;
  }

  // M45 Phase 4b — Dramatize the resolved exchange. Live runner uses
  // this to play the cinema motion; simulator passes nothing.
  if (prompts.onCinemaRound) {
    await prompts.onCinemaRound({
      attacker, defender: target, plan, atk,
      dmg: dmg.total + smiteTotal, crit: !!atk.crit, miss: false
    });
  }

  // M42 — Action Surge: a second action right now.
  if (plan?.featuresFired?.includes('action-surge') && !attacker._surgeFiredThisTurn) {
    attacker._surgeFiredThisTurn = true;
    PC_FEATURES['action-surge'].consume(attacker);
    if (isAlive(attacker) && sideAlive(enemies) > 0) {
      await runOneAttack(attacker, enemies, allies, scene, rng, prompts);
    }
    attacker._surgeFiredThisTurn = false;
  }
}

// =====================================================================
// runMonsterSpell — spell casting (both monster + PC)
// =====================================================================

export async function runMonsterSpell({ attacker, target, plan, scene: _scene, rng, witnesses = [], allEnemies = [], prompts = {} }) {
  void _scene;
  const baseSpell = spellById(plan.spellId);
  if (!baseSpell) return;
  const spell = applyUpcast(baseSpell, plan.castAtLevel);
  const book = attacker.kind === 'monster' ? spellbookFor(attacker.presetSlug) : null;
  const innateBook = !book && attacker._innate
    ? { dc: 12, attackBonus: 4, abilityMod: 3 }
    : null;
  const pcBook = !book && !innateBook && attacker.kind === 'pc'
    ? pcSpellBook(attacker, baseSpell) : null;
  const effectiveBook = book || innateBook || pcBook;
  if (!effectiveBook) return;

  if (spell.concentration && isConcentrating(attacker)) dropConcentration(attacker);

  if (plan.isInnate) {
    if (!attacker._innate) attacker._innate = freshInnateState(attacker.presetSlug);
    consumeInnate(attacker, plan.spellId);
  } else {
    consumeSlot(attacker._slots, baseSpell, plan.castAtLevel);
  }

  // M45 Phase 4b — Cast announcement (live runner uses this to log the
  // cast + paint the spell-cast cinema motion before resolution lands).
  if (prompts.onCastBegin) {
    await prompts.onCastBegin({ attacker, target, plan, spell });
  }

  // M34.1 — Counterspell witness loop. M45 Phase 4b — Optional prompt:
  // the auto path uses the witness's heuristic, the live runner can
  // pop a dialog asking the player whether to spend their reaction.
  for (const witness of witnesses) {
    // M64 N1 — only eligible witnesses are asked, and a `true` answer is
    // re-checked after the await (the witness may have spent its
    // reaction or slot meanwhile; a remote answer is never trusted).
    if (!canCastCounterspell(witness)) continue;
    const auto = shouldCounterspell(witness, spell.level);
    const fire = prompts.onCounterspell
      ? await prompts.onCounterspell({ witness, caster: attacker, spell, autoAnswer: auto })
      : auto;
    if (!fire || !canCastCounterspell(witness)) continue;
    const ability = abilityModFor(witness, abilityForCounterer(witness));
    const result = resolveCounterspell({ spellLevel: spell.level, counterMod: ability }, rng);
    consumeCounterspell(witness);
    if (result.countered) return;
    break;
  }

  // M56 Phase 2 — Every resolved cast dramatizes through the same
  // onCinemaRound prompt as weapon swings, tagged `cast: true` with a
  // per-kind `outcome` payload. Shield-negated casts dispatch nothing
  // (the cast fizzles silently; a fizzle cinema is deferred). Guarded
  // exactly like the weapon path so the simulator's prompts:{} hot
  // loop is untouched.
  const castCinema = async (defender, outcome) => {
    if (!prompts.onCinemaRound) return;
    await prompts.onCinemaRound({
      attacker, defender, plan, spell, cast: true, outcome
    });
  };

  if (spell.kind === 'heal') {
    const dmgRoll = rollDamage(spell.dice, { crit: false }, rng);
    const mod = spell.addsAbilityMod ? (effectiveBook.abilityMod || 0) : 0;
    const heal = dmgRoll.total + mod;
    if (target?.hpMax > 0) {
      target.hp = Math.min(target.hpMax, target.hp + heal);
      await castCinema(target, { heal });
    }
    return;
  }

  if (spell.kind === 'auto-hit') {
    // Shield (PHB p275) blocks Magic Missile outright. M64 N1 — routed
    // through onShieldReaction like every other Shield window.
    const mmAtk = { hit: true, crit: false, total: null, autoHit: true };
    if (await askShield(target, mmAtk, { weapon: null, spell }, prompts)) {
      consumeShield(target);
      return;
    }
    const darts = spell.darts || 1;
    let totalDmg = 0;
    for (let i = 0; i < darts; i++) {
      const r = rollDamage(spell.perDart, { crit: false }, rng);
      totalDmg += r.total;
    }
    applyDamageToEntity(target, totalDmg, rng);
    attacker.damageDealt += totalDmg;
    await castCinema(target, { dmg: totalDmg, darts });
    return;
  }

  if (spell.kind === 'spell-attack') {
    const atk = rollAttack({
      bonus: effectiveBook.attackBonus,
      advantage: 'normal',
      targetAC: target.ac
    }, rng);
    if (await askShield(target, atk, { weapon: null, spell }, prompts)) {
      consumeShield(target);
      return;
    }
    if (!atk.hit) {
      await castCinema(target, { dmg: 0, miss: true });
      return;
    }
    const dmg = rollDamage(spell.dice, { crit: atk.crit }, rng);
    applyDamageToEntity(target, dmg.total, rng);
    attacker.damageDealt += dmg.total;
    await castCinema(target, { dmg: dmg.total, crit: !!atk.crit });
    return;
  }

  // AoE save
  if (spell.aoe && allEnemies.length > 0) {
    const center = attacker._position || attacker.position;
    if (center) {
      let totalDmg = 0;
      const aoeResults = [];
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
        applyDamageToEntity(e, dmg, rng);
        totalDmg += dmg;
        aoeResults.push({ entity: e, dmg, saved: eSave.success });
      }
      attacker.damageDealt += totalDmg;
      // Frame the hardest-hit target — the planner's `target` may have
      // been range-excluded or saved for 0, so don't frame it blindly.
      // Nobody in range → nothing happened on screen → no dispatch.
      if (aoeResults.length > 0) {
        const framed = aoeResults.reduce((a, b) => (b.dmg > a.dmg ? b : a));
        await castCinema(framed.entity, {
          dmg: framed.dmg, saved: framed.saved,
          total: totalDmg, targets: aoeResults.length
        });
      }
    }
    return;
  }

  // Save-based, single target
  const saveStat = spell.saveStat;
  const targetSaveBonus = saveBonusFor(target, saveStat);
  const save = rollSave({ bonus: targetSaveBonus, dc: effectiveBook.dc }, rng);
  let saveDmg = 0;
  if (spell.dice) {
    const dmgRoll = rollDamage(spell.dice, { crit: false }, rng);
    let dmg = dmgRoll.total;
    if (save.success) dmg = spell.saveOnHalf ? Math.floor(dmg / 2) : 0;
    applyDamageToEntity(target, dmg, rng);
    attacker.damageDealt += dmg;
    saveDmg = dmg;
  }
  if (!save.success && spell.appliesCondition) {
    if (!target.conditions.includes(spell.appliesCondition)) {
      target.conditions.push(spell.appliesCondition);
    }
    if (spell.concentration) {
      startConcentration(attacker, spell, [target.id]);
    }
  }
  // Condition-only spells (dice: null) dispatch dmg 0 — the bridge
  // pins miss: false so a landed Hold Person never reads as a whiff.
  await castCinema(target, { dmg: saveDmg, saved: save.success });
}

// =====================================================================
// runReactionAttack — opportunity / reaction attacks
// =====================================================================

export async function runReactionAttack(attacker, target, targetBeforePos, scene, rng, prompts = {}) {
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
  if (await askShield(target, atk, { weapon: attacker.weapon }, prompts)) {
    consumeShield(target);
    atk.hit = false;
  }
  // M56 Phase 4 — opportunity attacks dramatize through the same
  // onCinemaRound prompt, tagged reaction: true (the bridge forces the
  // Quick style and skips class-feature modifier diffing — the
  // captured pre-attack flags belong to the ACTIVE entity, not the OA
  // attacker). The autoMiss return above stays silent (nothing
  // happened on screen); a Shield-negated OA reaches here as a plain
  // miss — known v1 inconsistency with the cast path, see DEFERRED.md.
  if (!atk.hit) {
    if (prompts.onCinemaRound) {
      await prompts.onCinemaRound({
        attacker, defender: target, plan: null, atk,
        dmg: 0, crit: false, miss: true, reaction: true
      });
    }
    return;
  }
  const dmg = rollDamage(verdict.damage.dice, { crit: atk.crit }, rng);
  target.hp = Math.max(0, target.hp - dmg.total);
  attacker.damageDealt += dmg.total;
  if (prompts.onCinemaRound) {
    await prompts.onCinemaRound({
      attacker, defender: target, plan: null, atk,
      dmg: dmg.total, crit: !!atk.crit, miss: false, reaction: true
    });
  }
}

// =====================================================================
// Reaction gating (M64 N1)
// =====================================================================

/**
 * Could Shield turn this attack into a miss right now? True only for a
 * non-crit hit on a PC that can cast Shield (reaction + spell + slot),
 * where +5 AC beats the attack total. Auto-hit spells (Magic Missile,
 * `atk.autoHit`) skip the AC test: Shield blocks them outright.
 *
 * @param {object} defender — entity wrapper
 * @param {object} atk — { hit, crit, total, autoHit? }
 * @returns {boolean}
 */
export function shieldCanBlock(defender, atk) {
  if (!defender || defender.kind !== 'pc' || !atk) return false;
  if (!atk.hit || atk.crit) return false;
  if (!canCastShield(defender)) return false;
  if (atk.autoHit) return true;
  return atk.total < defender.ac + 5;
}

/**
 * Offer the Shield window and return whether Shield should be applied.
 * The prompt is skipped when Shield could not help; a `true` answer is
 * re-checked with shieldCanBlock after the await, so an ineligible
 * defender never gets a free Shield whatever the prompt returns.
 * Without `prompts.onShieldReaction` the heuristic answers (simulator).
 *
 * @param {object} defender
 * @param {object} atk
 * @param {{ weapon: object|null, spell?: object }} ctx
 * @param {object} prompts — EnginePrompts
 * @returns {Promise<boolean>}
 */
async function askShield(defender, atk, ctx, prompts) {
  if (!shieldCanBlock(defender, atk)) return false;
  const auto = atk.autoHit
    ? true
    : shouldCastShield({ target: defender, attackerTotal: atk.total, targetAc: defender.ac });
  const accepted = prompts.onShieldReaction
    ? await prompts.onShieldReaction({ defender, atk, ...ctx, autoAnswer: auto })
    : auto;
  return !!accepted && shieldCanBlock(defender, atk);
}

// =====================================================================
// Shared helpers (exported so simulator's legendary path can reuse them)
// =====================================================================

/**
 * Apply damage to an entity wrapper, then roll the concentration save
 * (PHB p203) if it was concentrating. M64 T2 — `rng` is threaded into
 * the concentration save; it used to fall back to Math.random, which
 * broke seeded replay for any fight with a concentrating caster.
 *
 * @param {object} target — entity wrapper ({ hp, _concentrating, ... })
 * @param {number} damage — non-positive values are a no-op
 * @param {function} rng — () → [0,1); required when target may be concentrating
 */
export function applyDamageToEntity(target, damage, rng) {
  if (!target || damage <= 0) return;
  const before = target.hp;
  target.hp = Math.max(0, target.hp - damage);
  const dealtDamage = before - target.hp;
  if (dealtDamage > 0 && isConcentrating(target)) {
    const conMod = saveBonusFor(target, 'CON');
    handleDamageOnConcentration({ caster: target, damage: dealtDamage, conMod }, rng);
  }
}

/**
 * A PC's spellcasting numbers for one cast (M64 R3).
 *
 *   ability — the spell's own `spellCastingAbility` when the character's
 *             parsed spell list carries this spell (matched by name),
 *             else the first spellcasting class's default ability
 *   prof    — proficiency bonus from TOTAL character level (multiclass)
 *   attackBonus = prof + mod + active combatMods kind 'attack' scoped
 *             'spell' or 'all' (Amulet of the Devout, Rod of the Pact
 *             Keeper)
 *   dc      = 8 + prof + mod + active combatMods kind 'save-dc'
 *
 * @param {object} attacker — wrapper ({ ref, combatMods? }) or a bare sheet
 * @param {object} [spell] — registry spell (name used for the lookup)
 * @returns {{ dc: number, attackBonus: number, abilityMod: number, ability: string }}
 */
export function pcSpellBook(attacker, spell = null) {
  const ref = attacker?.ref || attacker;
  const stat = spellAbilityFor(ref, spell);
  const mod = ref?.abilityModifiers?.[stat] ?? 0;
  const prof = proficiencyBonus(totalLevel(ref));
  let atkMods = 0;
  let dcMods = 0;
  for (const m of combatModsOf(attacker)) {
    if (!m || m.inactive) continue;
    const v = Number(m.value) || 0;
    if (m.kind === 'attack' && (m.scope === 'spell' || m.scope === 'all')) atkMods += v;
    else if (m.kind === 'save-dc' && (m.scope === 'spell' || m.scope === 'all')) dcMods += v;
  }
  return {
    dc: 8 + prof + mod + dcMods,
    attackBonus: prof + mod + atkMods,
    abilityMod: mod,
    ability: stat
  };
}

function spellAbilityFor(ref, spell) {
  const wanted = String(spell?.name || '').toLowerCase();
  if (spell?.spellCastingAbility) return spell.spellCastingAbility;
  if (wanted) {
    const own = (ref?.spells || []).find(s => String(s?.name || '').toLowerCase() === wanted);
    if (own?.spellCastingAbility) return own.spellCastingAbility;
  }
  for (const c of ref?.classes || []) {
    const name = String(c?.name || '').toLowerCase();
    if (name === 'cleric' || name === 'druid' || name === 'ranger') return 'WIS';
    if (name === 'bard' || name === 'sorcerer' || name === 'warlock' || name === 'paladin') return 'CHA';
    if (name === 'wizard' || name === 'artificer') return 'INT';
  }
  return 'INT';
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

/**
 * Saving-throw bonus for an entity wrapper.
 *
 * PCs (M64 R2): ability mod + proficiency when proficient
 * (`savingThrowProficiencies`, via pc-stats.saveBonus) + every active
 * `combatMods` entry of kind 'save' whose scope is 'all' or this stat
 * (Cloak of Protection, Paladin aura bonuses parsed from DDB). The
 * concentration save goes through this same function.
 * Monsters: the preset save table.
 *
 * @param {object} entity — wrapper ({ kind, ref, combatMods?, presetSlug })
 * @param {string} stat — 'STR' | 'DEX' | 'CON' | 'INT' | 'WIS' | 'CHA'
 * @returns {number}
 */
export function saveBonusFor(entity, stat) {
  if (!entity || !stat) return 0;
  if (entity.kind === 'pc') {
    const ref = entity.ref || entity;
    const scope = String(stat).toLowerCase();
    let bonus = pcSaveBonus(ref, stat);
    for (const mod of combatModsOf(entity)) {
      if (mod?.inactive || mod?.kind !== 'save') continue;
      if (mod.scope === 'all' || mod.scope === scope) bonus += Number(mod.value) || 0;
    }
    return bonus;
  }
  const table = MONSTER_DEFAULT_SAVES[entity.presetSlug];
  return table ? (table[stat] || 0) : 0;
}

/**
 * Raw ability modifier (ability checks such as the Counterspell check
 * add no proficiency). PCs read `abilityModifiers`; monsters fall back
 * to their save table, as before.
 *
 * @param {object} entity
 * @param {string} stat
 * @returns {number}
 */
export function abilityModFor(entity, stat) {
  if (!entity || !stat) return 0;
  if (entity.kind === 'pc') {
    const ref = entity.ref || entity;
    return ref.abilityModifiers?.[stat] ?? 0;
  }
  return saveBonusFor(entity, stat);
}

function combatModsOf(entity) {
  if (Array.isArray(entity?.combatMods)) return entity.combatMods;
  const ref = entity?.ref || entity;
  return Array.isArray(ref?.combatMods) ? ref.combatMods : [];
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
