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
 *   - Natural 20 on the to-hit die = automatic hit and critical
 *   - Natural 1  on the to-hit die = automatic miss (no damage rolled)
 */

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

/**
 * Roll a dice spec. Returns { total, rolls, mod, spec } where `rolls` is
 * the array of raw face values (length === count). The total includes mod.
 */
export function rollDice(spec, rng = Math.random) {
  const parsed = parseDice(spec);
  if (!parsed) return { total: 0, rolls: [], mod: 0, spec };
  const rolls = [];
  for (let i = 0; i < parsed.count; i++) {
    rolls.push(1 + Math.floor(rng() * parsed.sides));
  }
  const sum = rolls.reduce((a, b) => a + b, 0);
  return { total: sum + parsed.mod, rolls, mod: parsed.mod, spec };
}

/**
 * Roll a d20 with optional advantage / disadvantage. Returns both dice
 * (so callers can show the breakdown) plus which one was kept.
 */
export function rollD20(advantage = 'normal', rng = Math.random) {
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
export function rollAttack({ bonus = 0, advantage = 'normal', targetAC = 10 }, rng = Math.random) {
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
 * Roll damage from a dice spec. On a crit, every die is rolled twice and
 * summed (5e RAW); the flat modifier is NOT doubled. Returns the same
 * shape as rollDice plus a `crit` flag.
 */
export function rollDamage(spec, { crit = false } = {}, rng = Math.random) {
  const parsed = parseDice(spec);
  if (!parsed) return { total: 0, rolls: [], mod: 0, spec, crit };
  const dieCount = crit ? parsed.count * 2 : parsed.count;
  const rolls = [];
  for (let i = 0; i < dieCount; i++) {
    rolls.push(1 + Math.floor(rng() * parsed.sides));
  }
  const sum = rolls.reduce((a, b) => a + b, 0);
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
