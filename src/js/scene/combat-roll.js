/**
 * M6 — Combat rolls.
 *
 * Pure dice + attack/damage resolution. No DOM, no globals — every
 * source of randomness flows through the `rng` parameter so tests can
 * inject a deterministic sequence.
 *
 * Conventions:
 *   - `advantage`: 'normal' | 'advantage' | 'disadvantage'
 *   - dice strings: '1d8+3', '2d6-1', 'd20', '4d4' (count optional, mod optional)
 *     and, since M64 R1, multi-term expressions such as '1d8+3+3d6'
 *     (weapon + Sneak Attack) or '2d6+1d4-1'. Every dice term is rolled;
 *     a crit doubles the dice of EVERY term, never the flat modifiers.
 *   - Natural 20 on the to-hit die = automatic hit and critical
 *   - Natural 1  on the to-hit die = automatic miss (no damage rolled)
 */

import { requireRng } from './rng.js';

const DICE_RE = /^\s*(\d*)d(\d+)\s*([+-]\s*\d+)?\s*$/i;

/**
 * Parse a dice spec like '1d8+3' into structured form. Returns null on
 * invalid input (caller decides whether that's an error).
 */
export function parseDice(spec) {
  if (typeof spec !== 'string') return null;
  const m = spec.match(DICE_RE);
  if (!m) return null;
  const count = m[1] ? parseInt(m[1], 10) : 1;
  const sides = parseInt(m[2], 10);
  const mod   = m[3] ? parseInt(m[3].replace(/\s+/g, ''), 10) : 0;
  if (count < 1 || count > 100 || sides < 2 || sides > 1000) return null;
  return { count, sides, mod };
}

const TERM_RE = /^(\d*)d(\d+)$|^(\d+)$/i;

/**
 * M64 R1 — Parse a multi-term dice expression ('1d8+3+3d6', '2d6-1d4+2')
 * into `{ terms: [{count, sides, sign}], mod }`. Single-term specs parse
 * to one term, so every existing spec rolls exactly as before. Returns
 * null on invalid input.
 *
 * @param {string} spec
 * @returns {{terms: {count: number, sides: number, sign: 1|-1}[], mod: number}|null}
 */
export function parseDiceExpr(spec) {
  if (typeof spec !== 'string') return null;
  const compact = spec.replace(/\s+/g, '');
  if (!compact) return null;
  const parts = compact.match(/[+-]?[^+-]+/g);
  if (!parts || parts.join('') !== compact) return null;
  const terms = [];
  let mod = 0;
  for (const raw of parts) {
    const sign = raw.startsWith('-') ? -1 : 1;
    const body = raw.replace(/^[+-]/, '');
    const m = body.match(TERM_RE);
    if (!m) return null;
    if (m[3] !== undefined) { mod += sign * parseInt(m[3], 10); continue; }
    const count = m[1] ? parseInt(m[1], 10) : 1;
    const sides = parseInt(m[2], 10);
    if (count < 1 || count > 100 || sides < 2 || sides > 1000) return null;
    terms.push({ count, sides, sign });
  }
  if (terms.length === 0) return null;
  return { terms, mod };
}

// Hot path: every damage roll parses its spec, and the simulator rolls the
// same handful of specs thousands of times. Parsed specs are cached (the
// cached objects are frozen and only read by rollDice / rollDamage);
// parseDiceExpr itself still returns a fresh object to its callers.
const PARSED_DICE = new Map();
const PARSED_DICE_MAX = 512;

function parsedDice(spec) {
  if (typeof spec !== 'string') return null;
  let parsed = PARSED_DICE.get(spec);
  if (parsed !== undefined) return parsed;
  const fresh = parseDiceExpr(spec);
  parsed = fresh ? Object.freeze({ terms: Object.freeze(fresh.terms.map(t => Object.freeze(t))), mod: fresh.mod }) : null;
  if (PARSED_DICE.size >= PARSED_DICE_MAX) PARSED_DICE.clear();
  PARSED_DICE.set(spec, parsed);
  return parsed;
}

/**
 * Roll a dice spec. Returns { total, rolls, mod, spec } where `rolls` is
 * the array of raw face values in term order. The total includes mod.
 * Multi-term specs ('1d8+3+3d6') are supported (M64 R1).
 */
export function rollDice(spec, rng) {
  requireRng(rng, 'rollDice');
  const parsed = parsedDice(spec);
  if (!parsed) return { total: 0, rolls: [], mod: 0, spec };
  const { rolls, sum } = rollTerms(parsed.terms, 1, rng);
  return { total: sum + parsed.mod, rolls, mod: parsed.mod, spec };
}

// Roll every term `mult` times its count (mult 2 = crit), in term order.
function rollTerms(terms, mult, rng) {
  const rolls = [];
  let sum = 0;
  for (const t of terms) {
    for (let i = 0; i < t.count * mult; i++) {
      const face = 1 + Math.floor(rng() * t.sides);
      rolls.push(face);
      sum += t.sign * face;
    }
  }
  return { rolls, sum };
}

/**
 * Roll a d20 with optional advantage / disadvantage. Returns both dice
 * (so callers can show the breakdown) plus which one was kept.
 */
export function rollD20(advantage = 'normal', rng) {
  requireRng(rng, 'rollD20');
  const a = 1 + Math.floor(rng() * 20);
  if (advantage === 'normal') return { kept: a, dice: [a], advantage };
  const b = 1 + Math.floor(rng() * 20);
  const kept = advantage === 'advantage' ? Math.max(a, b) : Math.min(a, b);
  return { kept, dice: [a, b], advantage };
}

/**
 * Resolve a to-hit roll: d20 (optionally adv/dis) + bonus vs targetAC.
 * Returns { hit, crit, d20:{kept,dice,advantage}, bonus, total, ac }.
 *
 * Nat 20 → crit + hit (regardless of AC). Nat 1 → automatic miss.
 */
export function rollAttack({ bonus = 0, advantage = 'normal', targetAC = 10 }, rng) {
  requireRng(rng, 'rollAttack');
  const d20 = rollD20(advantage, rng);
  const nat = d20.kept;
  const total = nat + bonus;
  let hit, crit = false;
  if (nat === 20) { hit = true;  crit = true; }
  else if (nat === 1) { hit = false; }
  else { hit = total >= targetAC; }
  return { hit, crit, d20, bonus, total, ac: targetAC };
}

/**
 * Roll damage from a dice spec. On a crit, every die of every term is
 * rolled twice and summed (5e RAW, PHB p196: "roll all of the attack's
 * damage dice twice"); flat modifiers are NOT doubled. Multi-term specs
 * ('1d8+3+3d6') are supported (M64 R1). Returns the same shape as
 * rollDice plus a `crit` flag.
 */
export function rollDamage(spec, { crit = false } = {}, rng) {
  requireRng(rng, 'rollDamage');
  const parsed = parsedDice(spec);
  if (!parsed) return { total: 0, rolls: [], mod: 0, spec, crit };
  const { rolls, sum } = rollTerms(parsed.terms, crit ? 2 : 1, rng);
  // Floor at 1 — D&D damage is never less than 1 even with big negative mods
  const total = Math.max(1, sum + parsed.mod);
  return { total, rolls, mod: parsed.mod, spec, crit };
}

/**
 * Format an attack + damage breakdown as a one-line human-readable string
 * for the combat-status panel. Example outputs:
 *   "Goblin attacks Fighter: d20=14+3=17 vs AC 16 → MISS"
 *   "Fighter attacks Goblin: d20=18+5=23 vs AC 15 → HIT, Longsword 1d8+3 (rolls 6) = 9"
 *   "Orc CRITS Bard: d20=20 → CRIT, Greataxe 1d12+3 (rolls 8,11) = 22"
 */
export function describeAttack({ attackerName, targetName, weaponName, atk, dmg }) {
  const d20Str = atk.d20.dice.length === 1
    ? `d20=${atk.d20.kept}`
    : `d20=${atk.d20.kept} (${atk.d20.advantage} of ${atk.d20.dice.join(',')})`;
  if (atk.crit) {
    const r = dmg.rolls.join(',');
    return `${attackerName} CRITS ${targetName}: ${d20Str} → CRIT, ${weaponName} ${dmg.spec} (rolls ${r}) = ${dmg.total}`;
  }
  if (!atk.hit) {
    return `${attackerName} attacks ${targetName}: ${d20Str}${atk.bonus >= 0 ? '+' : ''}${atk.bonus}=${atk.total} vs AC ${atk.ac} → MISS`;
  }
  const r = dmg.rolls.join(',');
  return `${attackerName} attacks ${targetName}: ${d20Str}${atk.bonus >= 0 ? '+' : ''}${atk.bonus}=${atk.total} vs AC ${atk.ac} → HIT, ${weaponName} ${dmg.spec} (rolls ${r}) = ${dmg.total}`;
}

/**
 * M64 T8 — Re-resolve an attack roll with a different kept d20 (a DM
 * override applied AFTER the rng draw, so the stream stays aligned).
 * Recomputes total, hit (nat 20 always hits, nat 1 always misses) and
 * crit from the roll's own bonus and AC. Returns a new object.
 *
 * @param {{d20?: object, bonus: number, ac: number}} atk — rollAttack result
 * @param {number} kept — the d20 face to use (1-20)
 * @returns {object}
 */
export function withD20(atk, kept) {
  const k = Math.max(1, Math.min(20, Math.trunc(Number(kept) || 1)));
  const bonus = Number(atk?.bonus) || 0;
  const ac = Number(atk?.ac) || 0;
  const total = k + bonus;
  return {
    ...atk,
    d20: { kept: k, dice: [k], advantage: atk?.d20?.advantage || 'normal', forced: true },
    total,
    hit: k === 20 ? true : (k === 1 ? false : total >= ac),
    crit: k === 20
  };
}

/**
 * M64 T8 — Re-resolve a saving throw with a different kept d20. Returns a
 * new object with total and success recomputed from its bonus and DC.
 *
 * @param {{bonus: number, dc: number}} save — rollSave result
 * @param {number} kept — the d20 face (1-20)
 * @returns {object}
 */
export function withSaveD20(save, kept) {
  const k = Math.max(1, Math.min(20, Math.trunc(Number(kept) || 1)));
  const total = k + (Number(save?.bonus) || 0);
  return { ...save, kept: k, dice: [k], total, success: total >= (Number(save?.dc) || 0), forced: true };
}
