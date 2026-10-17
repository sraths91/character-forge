/**
 * M64 phase 1.5 — cantrip scaling by character level (PHB p201): damage
 * cantrips gain a die at levels 5, 11 and 17 (Fire Bolt 1d10 → 2d10 →
 * 3d10 → 4d10); Eldritch Blast gains a beam instead (two beams at 5,
 * three at 11, four at 17), each its own attack roll.
 *
 * Source order: the parsed spell's DDB `atHigherLevels` when present
 * (`{scaleType: 'characterlevel', higherLevelDefinitions: [{level,
 * dice: {diceCount, diceValue}}], additionalAttacks: [...]}` — E4 keeps
 * it optional), else the SRD table below. PCs only: monster and innate
 * casts never scale (a stat block's numbers are already final).
 *
 * Pure module.
 */

/** SRD damage cantrips: base die and how they scale. */
export const SRD_CANTRIP_SCALING = Object.freeze({
  'acid-splash': { dice: '1d6', mode: 'dice' },
  'chill-touch': { dice: '1d8', mode: 'dice' },
  'eldritch-blast': { dice: '1d10', mode: 'beams' },
  'fire-bolt': { dice: '1d10', mode: 'dice' },
  'poison-spray': { dice: '1d12', mode: 'dice' },
  'produce-flame': { dice: '1d8', mode: 'dice' },
  'ray-of-frost': { dice: '1d8', mode: 'dice' },
  'sacred-flame': { dice: '1d8', mode: 'dice' },
  'shocking-grasp': { dice: '1d8', mode: 'dice' },
  'thorn-whip': { dice: '1d6', mode: 'dice' },
  'vicious-mockery': { dice: '1d4', mode: 'dice' }
});

/**
 * Cantrip tier for a character level: 1 (levels 1-4), 2 (5-10), 3 (11-16), 4 (17+).
 * @param {number} level
 * @returns {1|2|3|4}
 */
export function cantripTier(level) {
  const l = Number(level) || 1;
  if (l >= 17) return 4;
  if (l >= 11) return 3;
  if (l >= 5) return 2;
  return 1;
}

/** Dice from a DDB atHigherLevels block for `level`, or null. */
function diceFromAtHigherLevels(ahl, level) {
  if (!ahl || typeof ahl !== 'object') return null;
  if (ahl.scaleType && String(ahl.scaleType).toLowerCase() !== 'characterlevel') return null;
  const defs = Array.isArray(ahl.higherLevelDefinitions) ? ahl.higherLevelDefinitions : [];
  let best = null;
  for (const d of defs) {
    const at = Number(d?.level);
    const count = Number(d?.dice?.diceCount);
    const sides = Number(d?.dice?.diceValue);
    if (!(at <= level) || !(count > 0) || !(sides > 1)) continue;
    if (!best || at > best.at) best = { at, dice: `${count}d${sides}` };
  }
  return best ? best.dice : null;
}

function scaleDice(dice, tier) {
  const m = String(dice || '').match(/^(\d+)d(\d+)(.*)$/);
  if (!m) return dice;
  return `${Number(m[1]) * tier}d${m[2]}${m[3]}`;
}

/**
 * The spell a PC of `characterLevel` actually casts: a NEW object with
 * scaled `dice`, or `beams` (Eldritch Blast style); the input is never
 * mutated. Leveled spells and unknown cantrips come back unchanged.
 * @param {object} spell — registry spell
 * @param {number} characterLevel — total character level
 * @param {object|null} [own] — the sheet's own entry (may carry atHigherLevels)
 * @returns {object}
 */
export function scaleCantrip(spell, characterLevel, own = null) {
  if (!spell || spell.level !== 0) return spell;
  const tier = cantripTier(characterLevel);
  const ahl = own?.atHigherLevels;
  if (ahl && typeof ahl === 'object') {
    const extraAttacks = Array.isArray(ahl.additionalAttacks) ? ahl.additionalAttacks.length : 0;
    if (extraAttacks > 0 || SRD_CANTRIP_SCALING[spell.id]?.mode === 'beams') {
      return tier > 1 ? { ...spell, beams: tier } : spell;
    }
    const dice = diceFromAtHigherLevels(ahl, characterLevel);
    if (dice) return dice === spell.dice ? spell : { ...spell, dice };
  }
  const row = SRD_CANTRIP_SCALING[spell.id];
  if (!row || tier === 1) return spell;
  if (row.mode === 'beams') return { ...spell, beams: tier };
  if (!spell.dice) return spell;
  return { ...spell, dice: scaleDice(spell.dice, tier) };
}
