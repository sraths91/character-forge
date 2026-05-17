/**
 * M35 — Encounter difficulty calibrator.
 *
 * Wraps the M20 simulator with a richer aggregation layer aimed at the
 * DM-facing question: "how dangerous is this encounter?". The result is
 * a single structured report:
 *
 *   {
 *     iterations,
 *     winRate, lossRate, drawRate,    // party-side outcome rates
 *     avgRounds,
 *     lethality,                       // avg party damage taken / party hpMax
 *     deathToll,                       // avg # of PCs reduced to 0 hp per run
 *     mvp:        { id, name, avgDamageDealt },
 *     bestKilled: { id, name, deathRate },    // most-killed PC across runs
 *     perEntity:  [ ...simulator entity stats ]
 *   }
 *
 * Pure module — composes simulateEncounter; no extra mutation. The
 * `iterations` default of 200 is the same Monte Carlo budget the
 * existing UI uses; it converges to roughly ±5pp on the win rate.
 */

import { simulateEncounter } from './simulator.js';

/**
 * @param {object} args
 * @param {object[]} args.party       — PC character records (with hp+_position)
 * @param {object[]} args.monsters    — monster instances (with hp+position)
 * @param {object}   [args.scene]     — { cols, rows, ... }
 * @param {number}   [args.iterations] — default 200
 * @param {number}   [args.maxRounds]  — default 15
 * @param {number}   [args.seed]       — default 1
 * @returns {object} calibration report
 */
export function calibrateEncounter({
  party = [], monsters = [], scene = {},
  iterations = 200, maxRounds = 15, seed = 1
} = {}) {
  const stats = simulateEncounter({ party, monsters, scene, iterations, maxRounds, seed });

  // Compose the DM-facing aggregates from the simulator's per-entity output.
  const partyEntities    = stats.entities.filter(e => e.kind === 'pc');
  const monsterEntities  = stats.entities.filter(e => e.kind === 'monster');

  const partyHpMaxTotal  = sumHpMax(partyEntities);
  const partyAvgHpFinal  = partyEntities.reduce((s, e) => s + e.avgFinalHp, 0);
  const lethality = partyHpMaxTotal > 0
    ? Math.max(0, (partyHpMaxTotal - partyAvgHpFinal) / partyHpMaxTotal)
    : 0;
  const deathToll = partyEntities.reduce((s, e) => s + e.deathRate, 0);

  const mvp        = pickMvp(stats.entities);
  const bestKilled = pickBestKilled(partyEntities);

  const difficulty = ratedDifficulty({ party, monsters });
  return {
    iterations: stats.iterations,
    winRate:  stats.partyVictories / Math.max(1, stats.iterations),
    lossRate: stats.monsterVictories / Math.max(1, stats.iterations),
    drawRate: stats.draws / Math.max(1, stats.iterations),
    avgRounds: stats.avgRounds,
    lethality,                                  // 0..1, fraction of party HP lost
    deathToll,                                  // 0..N, expected # PCs downed per run
    mvp,
    bestKilled,
    perEntity: stats.entities,
    partySize: partyEntities.length,
    monsterCount: monsterEntities.length,
    difficulty                                  // 'trivial' | 'easy' | 'medium' | 'hard' | 'deadly'
  };
}

// =====================================================================
// M35.1 — DMG Encounter Difficulty (DMG p82)
//
// 5e DMG defines four XP thresholds per PC by level (Easy, Medium, Hard,
// Deadly). For a party, sum each PC's threshold to get the party budget
// at each level. Total monster XP × encounter multiplier (based on
// monster count) yields the encounter XP. Compare encounter XP to the
// party thresholds to bucket the difficulty.
//
// Below "Easy" is "Trivial" (we add this label — DMG doesn't define it,
// but our calibrator reports it for completeness).
// =====================================================================

/** Per-PC XP thresholds (level 1..20). Indexed by [level][bucket]. */
const PC_THRESHOLDS = {
  // level: { easy, medium, hard, deadly }
   1: { easy:   25, medium:   50, hard:   75, deadly:  100 },
   2: { easy:   50, medium:  100, hard:  150, deadly:  200 },
   3: { easy:   75, medium:  150, hard:  225, deadly:  400 },
   4: { easy:  125, medium:  250, hard:  375, deadly:  500 },
   5: { easy:  250, medium:  500, hard:  750, deadly: 1100 },
   6: { easy:  300, medium:  600, hard:  900, deadly: 1400 },
   7: { easy:  350, medium:  750, hard: 1100, deadly: 1700 },
   8: { easy:  450, medium:  900, hard: 1400, deadly: 2100 },
   9: { easy:  550, medium: 1100, hard: 1600, deadly: 2400 },
  10: { easy:  600, medium: 1200, hard: 1900, deadly: 2800 },
  11: { easy:  800, medium: 1600, hard: 2400, deadly: 3600 },
  12: { easy:  1000, medium: 2000, hard: 3000, deadly: 4500 },
  13: { easy:  1100, medium: 2200, hard: 3400, deadly: 5100 },
  14: { easy:  1250, medium: 2500, hard: 3800, deadly: 5700 },
  15: { easy:  1400, medium: 2800, hard: 4300, deadly: 6400 },
  16: { easy:  1600, medium: 3200, hard: 4800, deadly: 7200 },
  17: { easy:  2000, medium: 3900, hard: 5900, deadly: 8800 },
  18: { easy:  2100, medium: 4200, hard: 6300, deadly: 9500 },
  19: { easy:  2400, medium: 4900, hard: 7300, deadly: 10900 },
  20: { easy:  2800, medium: 5700, hard: 8500, deadly: 12700 }
};

/**
 * 5e DMG monster XP by Challenge Rating. Covers CR 0–20 (lower-end is
 * the common encounter-design range). For higher-CR monsters, callers
 * should pass an explicit `xp` override on the preset.
 */
const CR_XP = {
   0:    10,  '1/8':  25,  '1/4':  50,  '1/2': 100,
   1:   200,    2:   450,    3:   700,    4:  1100,
   5:  1800,    6:  2300,    7:  2900,    8:  3900,
   9:  5000,   10:  5900,   11:  7200,   12:  8400,
  13: 10000,  14: 11500,  15: 13000,  16: 15000,
  17: 18000,  18: 20000,  19: 22000,  20: 25000
};

/** Encounter multiplier for monster count (DMG p82). */
function encounterMultiplier(count, partySize) {
  let mult;
  if (count === 1)              mult = 1;
  else if (count === 2)         mult = 1.5;
  else if (count >= 3 && count <= 6)   mult = 2;
  else if (count >= 7 && count <= 10)  mult = 2.5;
  else if (count >= 11 && count <= 14) mult = 3;
  else                          mult = 4;
  // Small party (≤ 2 PCs) bumps the multiplier up one row; large party
  // (≥ 6 PCs) bumps it down one row. This is the DMG "adjust by party
  // size" rule.
  if (partySize <= 2) mult = bumpMultiplier(mult, +1);
  else if (partySize >= 6) mult = bumpMultiplier(mult, -1);
  return mult;
}
function bumpMultiplier(m, dir) {
  const ladder = [0.5, 1, 1.5, 2, 2.5, 3, 4, 5];
  const idx = ladder.indexOf(m);
  if (idx < 0) return m;
  return ladder[Math.max(0, Math.min(ladder.length - 1, idx + dir))];
}

/** Sum each PC's per-bucket threshold for the whole party. */
function partyThresholds(party) {
  const totals = { easy: 0, medium: 0, hard: 0, deadly: 0 };
  for (const p of party) {
    const level = pcLevel(p);
    const row = PC_THRESHOLDS[Math.max(1, Math.min(20, level))] || PC_THRESHOLDS[1];
    totals.easy   += row.easy;
    totals.medium += row.medium;
    totals.hard   += row.hard;
    totals.deadly += row.deadly;
  }
  return totals;
}

function pcLevel(pc) {
  const classes = pc?.classes || [];
  return classes.reduce((s, c) => s + (c?.level || 0), 0);
}

/** Look up XP for a monster preset by its slug — falls back via CR. */
function monsterXp(m) {
  if (Number.isFinite(m?.xp)) return m.xp;
  if (m?.cr !== undefined && CR_XP[m.cr] !== undefined) return CR_XP[m.cr];
  // Reasonable defaults for our presets (5e SRD values where known)
  const fallback = {
    goblin: 50, orc: 100, hobgoblin: 100, bugbear: 200, kobold: 25,
    skeleton: 50, zombie: 50, 'vampire-spawn': 1800, troll: 1800,
    minotaur: 700, bandit: 25, cultist: 25, gnoll: 100, ratfolk: 25,
    'cult-fanatic': 450, 'kobold-sorcerer': 100
  };
  return fallback[m?.presetSlug] || 25;
}

/**
 * Pure: compute a 5e DMG difficulty rating for the encounter without
 * running any simulation. Useful as a quick sanity-check and as a
 * companion to the simulator's empirical win rate.
 */
export function ratedDifficulty({ party = [], monsters = [] } = {}) {
  if (party.length === 0 || monsters.length === 0) {
    return { label: 'trivial', encounterXp: 0, thresholds: { easy: 0, medium: 0, hard: 0, deadly: 0 } };
  }
  const baseXp = monsters.reduce((s, m) => s + monsterXp(m), 0);
  const multiplier = encounterMultiplier(monsters.length, party.length);
  const encounterXp = Math.round(baseXp * multiplier);
  const thresholds = partyThresholds(party);
  let label = 'trivial';
  if (encounterXp >= thresholds.deadly)      label = 'deadly';
  else if (encounterXp >= thresholds.hard)   label = 'hard';
  else if (encounterXp >= thresholds.medium) label = 'medium';
  else if (encounterXp >= thresholds.easy)   label = 'easy';
  return { label, encounterXp, baseXp, multiplier, thresholds };
}

function sumHpMax(entities) {
  return entities.reduce((s, e) => s + (e.hpMax || 0), 0);
}

function pickMvp(entities) {
  let best = null;
  for (const e of entities) {
    if (!best || e.avgDamageDealt > best.avgDamageDealt) best = e;
  }
  if (!best) return null;
  return { id: best.id, name: best.name, kind: best.kind, avgDamageDealt: best.avgDamageDealt };
}

function pickBestKilled(partyEntities) {
  let worst = null;
  for (const e of partyEntities) {
    if (!worst || e.deathRate > worst.deathRate) worst = e;
  }
  if (!worst) return null;
  return { id: worst.id, name: worst.name, deathRate: worst.deathRate };
}
