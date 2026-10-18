/**
 * M64 T9 — validate a player / DM `turn.act` intent against the
 * authoritative EncounterState, and turn it into an engine forcePlan.
 *
 *   const v = validateIntent(state, { actorId, plan }, { sheets });
 *   if (!v.ok) → broadcast turn.rejected { actorId, reason: v.reason, code: v.code }
 *   else       → runTurn(ts, { prompts: { forcePlan: planFromIntent(state, intent, { sheets }) } })
 *
 * `plan` is the protocol.js turn.act plan: { kind, targetId?, targetSide?,
 * weaponName?, spellId?, castAtLevel?, moveTo?, path?, features? }.
 *
 * Checks: it is the actor's turn; the actor is up and not incapacitated;
 * the target exists, is standing (heals excepted) and is on the side the
 * plan says; the weapon is carried; the spell is in the engine registry,
 * known, and has a slot (or its own `uses` for feat/race spells) at the
 * requested level; the target is in reach / range after the move budget;
 * moveTo is on the grid, free and within speedFt; features[] are
 * available to this creature now (pc-features `available`).
 *
 * Range: Chebyshev feet on the 5-ft grid. Weapons go through
 * grid-legality.weaponRangeBand (reach / normal / long range; a melee
 * reach check allows the move budget first). `opts.rangeBand(from, to,
 * {weapon, spell, budgetFt}) → 'normal'|'long'|'out'` replaces the whole
 * check (e.g. a server that adds LOS / cover). With a terrain layer,
 * moveTo must be reachable on a legal findPath route within speedFt.
 *
 * Pure: no DOM, no clock, no rng.
 */

import { spellById, spellbookFor } from './monster-spells.js';
import { MONSTER_PRESETS } from './monster-presets.js';
import { chebyshevFeet, isRangedWeapon } from './grid-rules.js';
import { weaponRangeBand, findPath, buildOccupancy } from './grid-legality.js';
import { PC_FEATURES } from './ai/pc-features.js';
import { nameToSpellId } from './ai/pc-action.js';
import { wrapperFromEntity } from './encounter-adapters.js';
import { spellUseKey } from './feature-uses.js';

const INCAPACITATED = ['incapacitated', 'paralyzed', 'stunned', 'unconscious', 'petrified'];
const TARGETED = new Set(['melee', 'ranged', 'attack', 'cast']);
const condIds = (e) => (e?.conditions || []).map(c => (typeof c === 'string' ? c : c?.id));

const fail = (code, reason) => ({ ok: false, code, reason });

function sheetOf(entity, sheets) {
  if (!entity || entity.kind !== 'pc') return null;
  return sheets?.[entity.sheetRef?.characterId] ?? sheets?.[entity.id] ?? null;
}

/**
 * Weapons a creature carries: PCs from the sheet (mainhand, offhand,
 * carried[]); monsters from the stat block's attacks or the preset.
 * @param {object} entity
 * @param {object|null} sheet
 * @returns {object[]}
 */
export function weaponsOf(entity, sheet) {
  if (entity.kind === 'pc') {
    const eq = sheet?.equipment || {};
    const pool = [eq.mainhand, eq.offhand, ...(sheet?.carried || [])].filter(w => w && w.name);
    return pool.filter(w => w.damage || w.attackType || /weapon/i.test(w.weaponCategory || '') || w === eq.mainhand);
  }
  const sb = entity.statBlock || {};
  const preset = MONSTER_PRESETS[sb.slug] || {};
  const attacks = Array.isArray(sb.attacks) && sb.attacks.length ? sb.attacks : [preset.attack, preset.secondary];
  return attacks.filter(a => a && a.name);
}

function findWeapon(entity, sheet, name) {
  const want = String(name || '').toLowerCase();
  return weaponsOf(entity, sheet).find(w => String(w.name).toLowerCase() === want) || null;
}

function knowsSpell(entity, sheet, spellId) {
  if (entity.kind === 'pc') {
    const spells = Array.isArray(sheet?.spells) ? sheet.spells : [];
    const own = spells.find(s => nameToSpellId(typeof s === 'string' ? s : s?.name) === spellId);
    return own ? { known: true, own: typeof own === 'string' ? null : own } : { known: false };
  }
  const book = spellbookFor(entity.statBlock?.slug);
  if (book?.spells?.includes(spellId)) return { known: true, own: null };
  const innate = entity.resources?.innate;
  if (innate) {
    if (innate.atWill?.includes(spellId)) return { known: true, own: null, innate: 'at-will' };
    if (spellId in (innate.recharges || {})) return { known: true, own: null, innate: innate.recharges[spellId] ? 'ready' : 'spent' };
    for (const list of Object.values(innate.perDay || {})) {
      const slot = list.find(x => x.id === spellId);
      if (slot) return { known: true, own: null, innate: slot.remaining > 0 ? 'ready' : 'spent' };
    }
  }
  return { known: false };
}

function slotAvailable(entity, level) {
  const l = entity.resources?.slots?.[String(level)];
  if (l && l.max - l.spent > 0) return true;
  const pact = entity.resources?.pact;
  return !!(pact && pact.level === level && (pact.max ?? 0) - (pact.spent ?? 0) > 0);
}

/**
 * weaponRangeBand reads `range` as `{normal, long}` or "80/320"; the DDB
 * parser (R6) emits numeric `range` / `longRange` feet. Bridge the two.
 * @param {object|null} weapon
 * @returns {object|null}
 */
function withRangeObject(weapon) {
  const normal = Number(weapon?.range);
  if (!weapon || typeof weapon.range === 'object' || !Number.isFinite(normal) || normal <= 0) return weapon;
  const long = Number(weapon.longRange);
  return { ...weapon, range: { normal, long: Number.isFinite(long) && long >= normal ? long : normal } };
}

/**
 * Validate a turn intent.
 * @param {object} state — EncounterState v1
 * @param {{actorId?: string, plan: object}} intent — actorId defaults to
 *   the creature whose initiative slot is current
 * @param {{sheets?: Record<string, object>, rangeBand?: Function, checkTurn?: boolean}} [opts]
 * @returns {{ok: true}|{ok: false, code: string, reason: string}}
 */
export function validateIntent(state, intent, opts = {}) {
  const plan = intent?.plan;
  if (!plan || typeof plan.kind !== 'string') return fail('bad-plan', 'the intent has no plan');
  const current = state?.initiative?.[state.turnIndex]?.entityId ?? null;
  const actorId = intent.actorId != null ? String(intent.actorId) : current;
  const actor = actorId ? state.entities?.[actorId] : null;
  if (!actor) return fail('no-actor', `unknown actor ${actorId}`);
  if (opts.checkTurn !== false && current && current !== actorId) return fail('not-your-turn', `it is ${current}'s turn`);
  if (actor.hp <= 0) return fail('actor-down', `${actor.name} is down`);
  const conds = condIds(actor);
  const inc = INCAPACITATED.find(c => conds.includes(c));
  if (inc) return fail('incapacitated', `${actor.name} is ${inc}`);
  const sheet = sheetOf(actor, opts.sheets);
  if (actor.kind === 'pc' && !sheet) return fail('no-sheet', `no character sheet for ${actor.name}`);

  // Movement destination. M64 wave 6 — a teleport spell (Misty Step)
  // checks its own range and needs no walkable path.
  let from = actor.pos;
  const teleportFt = plan.kind === 'cast' && plan.spellId ? spellById(plan.spellId)?.teleportFt : null;
  if (plan.moveTo) {
    const mv = plan.moveTo;
    const g = state.grid || {};
    if (!(mv.col >= 0 && mv.row >= 0 && mv.col < g.cols && mv.row < g.rows)) return fail('bad-move', 'destination is off the grid');
    const taken = Object.values(state.entities).some(e => e.id !== actorId && e.pos.col === mv.col && e.pos.row === mv.row);
    if (taken) return fail('bad-move', 'destination is occupied');
    if (teleportFt && chebyshevFeet(actor.pos, mv) > teleportFt) return fail('bad-move', `destination is beyond ${teleportFt} ft`);
  }
  if (plan.moveTo && !teleportFt) {
    const mv = plan.moveTo;
    const g = state.grid || {};
    // M64 R7 — grappled / restrained: speed 0.
    const speed = conds.includes('grappled') || conds.includes('restrained') ? 0 : (actor.speedFt ?? 30);
    if (chebyshevFeet(actor.pos, mv) > speed) return fail('bad-move', `destination is beyond ${speed} ft`);
    if (g.terrain && (mv.col !== actor.pos.col || mv.row !== actor.pos.row)) {
      const occ = buildOccupancy(state.entities, { excludeId: actorId });
      const route = findPath(g.terrain, occ, actor.pos, mv, { budgetFt: speed, moverSide: actor.side });
      if (!route) return fail('bad-move', `no legal path to the destination within ${speed} ft`);
    }
    from = mv;
  }
  if (plan.kind === 'move' && !plan.moveTo) return fail('bad-move', 'a move needs moveTo');

  // Spell.
  let spell = null;
  if (plan.kind === 'cast') {
    if (!plan.spellId) return fail('no-spell', 'a cast needs spellId');
    spell = spellById(plan.spellId);
    if (!spell) return fail('unknown-spell', `${plan.spellId} is not in the engine's spell registry (DM adjudication)`);
    const k = knowsSpell(actor, sheet, plan.spellId);
    if (!k.known) return fail('unknown-spell', `${actor.name} does not know ${spell.name}`);
    if (k.innate === 'spent') return fail('no-slot', `${spell.name} is not recharged`);
    const level = Math.max(spell.level || 0, plan.castAtLevel ?? spell.level ?? 0);
    if (spell.level > 0 && !k.innate) {
      const own = k.own;
      // M64 phase 1.5 — the encounter's own ledger (resources.features
      // 'spell:<id>', spent by the engine) wins over the sheet's uses.
      const ledger = actor.resources?.features?.[spellUseKey(plan.spellId)];
      const granted = own?.uses && own.source && own.source !== 'class';
      const usesLeft = !granted ? null
        : ledger ? (ledger.max ?? 0) - (ledger.spent ?? 0)
          : (own.uses.max ?? 0) - (own.uses.used ?? 0);
      if (usesLeft !== null) {
        if (usesLeft <= 0) return fail('no-slot', `${spell.name} has no uses left`);
      } else if (!slotAvailable(actor, level)) {
        return fail('no-slot', `no level-${level} slot left for ${spell.name}`);
      }
    }
  }

  // Target.
  let target = null;
  const side = plan.targetSide || (spell && (spell.targetSide === 'ally' || spell.kind === 'heal') ? 'ally' : 'enemy');
  if (TARGETED.has(plan.kind) && !(spell?.aoe && plan.targetId == null) && spell?.targetSide !== 'self') {
    if (plan.targetId == null) return fail('no-target', 'the plan names no target');
    target = state.entities[String(plan.targetId)];
    if (!target) return fail('no-target', `unknown target ${plan.targetId}`);
    const sameSide = target.side === actor.side;
    if (side === 'ally' && !sameSide) return fail('wrong-side', `${target.name} is not an ally`);
    if (side === 'enemy' && sameSide) return fail('wrong-side', `${target.name} is not hostile`);
    if (target.hp <= 0 && !(spell && spell.kind === 'heal')) return fail('target-down', `${target.name} is down`);
  }

  // Weapon.
  let weapon = null;
  if (plan.kind === 'melee' || plan.kind === 'ranged' || plan.kind === 'attack') {
    if (plan.weaponName) {
      weapon = findWeapon(actor, sheet, plan.weaponName);
      if (!weapon) return fail('no-weapon', `${actor.name} carries no ${plan.weaponName}`);
    } else {
      weapon = actor.kind === 'pc' ? (sheet?.equipment?.mainhand || null) : (weaponsOf(actor, null)[0] || null);
    }
  }

  // Range (after the move budget when the engine will path on its own).
  if (target) {
    const pinned = conds.includes('grappled') || conds.includes('restrained');
    const budget = plan.moveTo || pinned ? 0 : (actor.speedFt ?? 30);
    const dist = chebyshevFeet(from, target.pos);
    if (typeof opts.rangeBand === 'function') {
      const band = opts.rangeBand(from, target.pos, { weapon, spell, budgetFt: budget });
      if (band === 'out') return fail('out-of-range', `${target.name} is out of range`);
    } else if (spell) {
      if (dist > (spell.range || 5)) return fail('out-of-range', `${target.name} is ${dist} ft away; ${spell.name} reaches ${spell.range || 5} ft`);
    } else if (weapon || plan.kind === 'melee' || plan.kind === 'attack') {
      const ranged = plan.kind === 'ranged' || (actor.kind === 'pc' && isRangedWeapon(weapon));
      const band = ranged
        ? weaponRangeBand({ ...(withRangeObject(weapon) || {}), usedAsRanged: true }, dist)
        : weaponRangeBand(withRangeObject(weapon), Math.max(0, dist - budget));
      if (band === 'out') {
        return fail('out-of-range', `${target.name} is ${dist} ft away (${ranged ? 'out of range' : `beyond reach after a ${budget} ft move`})`);
      }
    }
  }

  // Features.
  // M64 phase 1.5 — `featureId` names the feature a 'feature' plan uses.
  const features = plan.featureId && !(plan.features || []).includes(plan.featureId)
    ? [plan.featureId, ...(plan.features || [])] : (plan.features || []);
  if (plan.kind === 'feature' && features.length === 0) return fail('no-feature', 'a feature plan names no feature');
  if (features.length) {
    if (actor.kind !== 'pc') return fail('bad-feature', 'only PCs use class features');
    const w = wrapperFromEntity(actor, sheet);
    for (const id of features) {
      const f = PC_FEATURES[id];
      if (!f) return fail('bad-feature', `unknown feature ${id}`);
      if (!f.available(w)) return fail('bad-feature', `${f.label} is not available now`);
    }
  }
  return { ok: true };
}

/**
 * The engine forcePlan for a validated intent (weapon object resolved from
 * the sheet / stat block, features → featuresFired, moveTo kept).
 * @param {object} state
 * @param {{actorId?: string, plan: object}} intent
 * @param {{sheets?: Record<string, object>}} [opts]
 * @returns {object} forcePlan
 */
export function planFromIntent(state, intent, opts = {}) {
  const plan = intent.plan;
  const actorId = intent.actorId != null ? String(intent.actorId) : state.initiative?.[state.turnIndex]?.entityId;
  const actor = state.entities[actorId];
  const sheet = sheetOf(actor, opts.sheets);
  let weapon;
  if (plan.weaponName) {
    const w = findWeapon(actor, sheet, plan.weaponName);
    if (w) {
      const { slot: _s, inferredSlot: _i, ...clean } = w;
      weapon = clean;
    }
  }
  const spell = plan.spellId ? spellById(plan.spellId) : null;
  const innate = !!(spell && actor.kind === 'monster' && knowsSpell(actor, null, plan.spellId).innate);
  const kind = plan.kind === 'attack' && weapon && actor.kind === 'pc'
    ? (isRangedWeapon(weapon) ? 'ranged' : 'melee')
    : plan.kind;
  return {
    kind,
    targetId: plan.targetId ?? null,
    targetSide: plan.targetSide || (spell && (spell.targetSide === 'ally' || spell.kind === 'heal') ? 'ally' : 'enemy'),
    ...(weapon ? { weapon } : {}),
    ...(spell ? { spellId: plan.spellId, castAtLevel: Math.max(spell.level || 0, plan.castAtLevel ?? spell.level ?? 0) } : {}),
    ...(innate ? { isInnate: true } : {}),
    ...(plan.moveTo ? { moveTo: { col: plan.moveTo.col, row: plan.moveTo.row } } : {}),
    ...(plan.kind === 'feature' ? { featureId: plan.featureId || plan.features?.[0] || null } : {}),
    featuresFired: plan.featureId && !(plan.features || []).includes(plan.featureId)
      ? [plan.featureId, ...(plan.features || [])] : [...(plan.features || [])],
    archetype: 'manual',
    score: 0,
    breakdown: []
  };
}
