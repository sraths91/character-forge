/**
 * M65 R24 — experience points and level thresholds (SRD 5.1).
 *
 * Pure module (Node + browser): no DOM, no `node:` imports, no rng.
 * The run controller calls `encounterXp` once per ended encounter (XP
 * mode); milestone mode awards nothing here — levels come from DM grants.
 */

/**
 * SRD 5.1 p.56 "Character Advancement": XP needed to reach each level
 * (index 0 = level 1).
 */
export const XP_THRESHOLDS = Object.freeze([
  0, 300, 900, 2700, 6500, 14000, 23000, 34000, 48000, 64000,
  85000, 100000, 120000, 140000, 165000, 195000, 225000, 265000, 305000, 355000
]);

/** Highest character level. */
export const MAX_LEVEL = 20;

/**
 * SRD 5.1 monster XP by Challenge Rating (CR 0–30). Keys are the SRD
 * spellings: fractional CRs as '1/8', '1/4', '1/2'.
 */
export const CR_XP = Object.freeze({
  0: 10, '1/8': 25, '1/4': 50, '1/2': 100,
  1: 200, 2: 450, 3: 700, 4: 1100,
  5: 1800, 6: 2300, 7: 2900, 8: 3900,
  9: 5000, 10: 5900, 11: 7200, 12: 8400,
  13: 10000, 14: 11500, 15: 13000, 16: 15000,
  17: 18000, 18: 20000, 19: 22000, 20: 25000,
  21: 33000, 22: 41000, 23: 50000, 24: 62000,
  25: 75000, 26: 90000, 27: 105000, 28: 120000,
  29: 135000, 30: 155000
});

/**
 * SRD XP of the built-in monster presets that carry no CR (used only when
 * an entity has neither `statBlock.xp` nor a CR).
 */
export const PRESET_XP = Object.freeze({
  goblin: 50, orc: 100, hobgoblin: 100, bugbear: 200, kobold: 25,
  skeleton: 50, zombie: 50, 'vampire-spawn': 1800, troll: 1800,
  minotaur: 700, bandit: 25, cultist: 25, gnoll: 100, ratfolk: 25,
  'cult-fanatic': 450, 'kobold-sorcerer': 100
});

/** The XP modes a campaign can run in (`settings.xpMode`; the shared contract's list). */
export { XP_MODES } from '../shared/campaign.js';

const FRACTIONS = { 0.125: '1/8', 0.25: '1/4', 0.5: '1/2' };

/**
 * A challenge rating (number 0.25, string '1/4' / '0.25' / '5') → its
 * `CR_XP` key, or null when it is not a known CR.
 * @param {number|string|null|undefined} cr
 * @returns {string|null}
 */
export function crKey(cr) {
  if (cr === null || cr === undefined || cr === '') return null;
  const s = String(cr).trim();
  if (Object.prototype.hasOwnProperty.call(CR_XP, s)) return s;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  if (FRACTIONS[n]) return FRACTIONS[n];
  return Number.isInteger(n) && Object.prototype.hasOwnProperty.call(CR_XP, String(n)) ? String(n) : null;
}

/**
 * XP for a challenge rating (null when the CR is unknown).
 * @param {number|string} cr
 * @returns {number|null}
 */
export function xpForCr(cr) {
  const k = crKey(cr);
  return k === null ? null : CR_XP[k];
}

/**
 * XP a defeated creature is worth: its stat block's `xp`, else
 * `CR_XP[cr]`, else the preset table; 0 when nothing is known.
 * Accepts an EncounterState entity (`statBlock`), a stat block, or a
 * preset-style record (`xp`, `cr`, `presetSlug`).
 * @param {object} m
 * @returns {number}
 */
export function monsterXp(m) {
  if (!m || typeof m !== 'object') return 0;
  const sb = m.statBlock && typeof m.statBlock === 'object' ? m.statBlock : {};
  for (const v of [sb.xp, m.xp]) {
    if (v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v)) && Number(v) >= 0) return Math.trunc(Number(v));
  }
  for (const cr of [sb.cr, m.cr]) {
    const xp = xpForCr(cr);
    if (xp !== null) return xp;
  }
  const slug = sb.slug ?? m.presetSlug ?? m.slug;
  return (slug && PRESET_XP[slug]) || 0;
}

/**
 * True when a participant counts as dead for XP (life status `dead`,
 * entity status `dead`, or three failed death saves).
 * @param {object} p
 * @returns {boolean}
 */
export function isDeadParticipant(p) {
  if (!p) return true;
  if (p.lifeStatus === 'dead' || p.life_status === 'dead' || p.status === 'dead') return true;
  return Number(p.deathSaves?.failures) >= 3;
}

/**
 * Encounter XP (SRD p.56): the defeated creatures' XP summed, split
 * evenly (rounded down) among the participating PCs who are not dead.
 * Milestone mode awards nothing. The remainder of an uneven split is
 * reported, not awarded.
 *
 * @param {object[]} defeated — defeated hostiles (entities or stat blocks)
 * @param {{id: string|number}[]} participants — the PCs who took part
 * @param {{mode?: 'xp'|'milestone'}} [opts]
 * @returns {{mode: string, total: number, each: number, remainder: number,
 *   recipients: string[], awards: Record<string, number>}}
 */
export function encounterXp(defeated, participants, { mode = 'xp' } = {}) {
  if (mode === 'milestone') {
    return { mode, total: 0, each: 0, remainder: 0, recipients: [], awards: {} };
  }
  if (mode !== 'xp') throw new RangeError(`encounterXp: unknown mode "${mode}"`);
  const total = (Array.isArray(defeated) ? defeated : []).reduce((s, m) => s + monsterXp(m), 0);
  const recipients = (Array.isArray(participants) ? participants : [])
    .filter(p => !isDeadParticipant(p))
    .map(p => String(p.id));
  const each = recipients.length ? Math.floor(total / recipients.length) : 0;
  const awards = {};
  for (const id of recipients) awards[id] = each;
  return { mode, total, each, remainder: recipients.length ? total - each * recipients.length : total, recipients, awards };
}

/**
 * Character level for an XP total (1–20).
 * @param {number} xp
 * @returns {number}
 */
export function levelForXp(xp) {
  const n = Math.max(0, Number(xp) || 0);
  let level = 1;
  for (let i = 1; i < XP_THRESHOLDS.length; i++) {
    if (n >= XP_THRESHOLDS[i]) level = i + 1;
    else break;
  }
  return level;
}

/**
 * XP needed to reach `level` (clamped to 1–20).
 * @param {number} level
 * @returns {number}
 */
export function xpForLevel(level) {
  const lv = Math.max(1, Math.min(MAX_LEVEL, Math.trunc(Number(level) || 1)));
  return XP_THRESHOLDS[lv - 1];
}

/**
 * The levels crossed by moving from `fromXp` to `toXp` (each one becomes
 * a `level_ups` row). Never goes past 20; empty when no threshold is crossed.
 * Milestone mode: always empty (the DM grants levels).
 * @param {number} fromXp
 * @param {number} toXp
 * @param {{mode?: 'xp'|'milestone', currentLevel?: number}} [opts] — currentLevel
 *   (the sheet's level) wins over the level implied by fromXp
 * @returns {number[]} the new levels, ascending
 */
export function levelsCrossed(fromXp, toXp, { mode = 'xp', currentLevel } = {}) {
  if (mode === 'milestone') return [];
  const from = Number.isFinite(Number(currentLevel)) ? Math.trunc(Number(currentLevel)) : levelForXp(fromXp);
  const to = levelForXp(toXp);
  const out = [];
  for (let lv = from + 1; lv <= Math.min(MAX_LEVEL, to); lv++) out.push(lv);
  return out;
}
