#!/usr/bin/env node
/**
 * M64 phase 1.5 — calibrator baseline (deterministic).
 *
 * Prints the tables in docs/M45-CALIBRATOR-RESULTS.md: the M45 stock
 * parties × monster lineups through `calibrateEncounter` (which is async
 * since M64 T1; scripts/m45-calibrator-suite.js predates that and does
 * not await it). Output depends only on the flags: no timestamps, no
 * Math.random. Regenerate the doc with
 *
 *   node scripts/calibrator-baseline.mjs > /tmp/tables.md
 *
 * and paste the tables over the doc's (the Analysis section is written
 * by hand).
 *
 * Flags:
 *   --iters=N    iterations per encounter (default 100)
 *   --seed=N     simulator seed (default 1)
 *   --open5e     monsters carry their SRD stat block, normalised from
 *                src/tests/fixtures/open5e/ (M64 R11): HP from the stat
 *                block, plus `statBlock` on each monster input. NOTE the
 *                simulator (simulator.js runOneIteration) reads only
 *                `hp` from the input today; AC / attacks still come from
 *                the preset until it reads `statBlock`.
 *   --json       JSON instead of markdown
 */

import { readFileSync } from 'node:fs';
import { calibrateEncounter } from '../src/js/scene/calibrator.js';
import { normalizeCreature, withEngineFields } from '../src/js/scene/open5e-normalize.js';

// ---------- Fixed party + monster fixtures ----------

const LOW_PARTY = [
  pc({ id: 'p-fighter-3', name: 'Brunn',
       cls: 'Fighter', lvl: 3, str: 16, dex: 12, con: 14, hpMax: 28,
       mainhand: { name: 'Longsword', damageType: 'slashing' },
       carried: [{ name: 'Longbow', damageType: 'piercing' }] }),
  pc({ id: 'p-rogue-3', name: 'Sera',
       cls: 'Rogue', lvl: 3, str: 10, dex: 16, con: 12, hpMax: 21,
       mainhand: { name: 'Shortsword', damageType: 'piercing' },
       carried: [{ name: 'Shortbow', damageType: 'piercing' }] }),
  pc({ id: 'p-cleric-3', name: 'Mira',
       cls: 'Cleric', lvl: 3, str: 12, dex: 10, con: 14, wis: 16, hpMax: 24,
       mainhand: { name: 'Mace', damageType: 'bludgeoning' },
       spells: ['Cure Wounds', 'Healing Word', 'Sacred Flame'] })
];

const MID_PARTY = [
  pc({ id: 'm-fighter-5', name: 'Doran',
       cls: 'Fighter', lvl: 5, str: 18, dex: 12, con: 16, hpMax: 50,
       mainhand: { name: 'Greatsword', damageType: 'slashing' },
       carried: [{ name: 'Longbow', damageType: 'piercing' }] }),
  pc({ id: 'm-rogue-5', name: 'Vex',
       cls: 'Rogue', lvl: 5, str: 10, dex: 18, con: 14, hpMax: 38,
       mainhand: { name: 'Rapier', damageType: 'piercing' },
       carried: [{ name: 'Shortbow', damageType: 'piercing' }] }),
  pc({ id: 'm-wizard-5', name: 'Eldra',
       cls: 'Wizard', lvl: 5, str: 8, dex: 14, con: 12, int: 18, hpMax: 27,
       mainhand: { name: 'Quarterstaff', damageType: 'bludgeoning' },
       spells: ['Fire Bolt', 'Magic Missile', 'Shield'] }),
  pc({ id: 'm-paladin-5', name: 'Halric',
       cls: 'Paladin', lvl: 5, str: 16, dex: 10, con: 14, cha: 16, hpMax: 50,
       mainhand: { name: 'Longsword', damageType: 'slashing' } })
];

const HIGH_PARTY = [
  pc({ id: 'h-fighter-9', name: 'Karn',
       cls: 'Fighter', lvl: 9, str: 20, dex: 14, con: 18, hpMax: 90,
       mainhand: { name: 'Greatsword', damageType: 'slashing' },
       carried: [{ name: 'Longbow', damageType: 'piercing' }] }),
  pc({ id: 'h-rogue-9', name: 'Nyx',
       cls: 'Rogue', lvl: 9, str: 10, dex: 20, con: 16, hpMax: 70,
       mainhand: { name: 'Rapier', damageType: 'piercing' },
       carried: [{ name: 'Shortbow', damageType: 'piercing' }] }),
  pc({ id: 'h-wizard-9', name: 'Vella',
       cls: 'Wizard', lvl: 9, str: 8, dex: 14, con: 14, int: 20, hpMax: 49,
       mainhand: { name: 'Quarterstaff', damageType: 'bludgeoning' },
       spells: ['Fire Bolt', 'Magic Missile', 'Shield', 'Counterspell'] }),
  pc({ id: 'h-paladin-9', name: 'Ardrin',
       cls: 'Paladin', lvl: 9, str: 18, dex: 10, con: 16, cha: 18, hpMax: 90,
       mainhand: { name: 'Greatsword', damageType: 'slashing' } })
];

const PARTIES = [
  { id: 'low',  label: 'Low — 3 PCs lvl 3',  party: LOW_PARTY },
  { id: 'mid',  label: 'Mid — 4 PCs lvl 5',  party: MID_PARTY },
  { id: 'high', label: 'High — 4 PCs lvl 9', party: HIGH_PARTY }
];

const LINEUPS = [
  { id: 'solo-goblin', label: '1× Goblin',  slugs: ['goblin'] },
  { id: 'goblin-pack', label: '4× Goblin',  slugs: ['goblin','goblin','goblin','goblin'] },
  { id: 'orc-pair',    label: '2× Orc',     slugs: ['orc','orc'] },
  { id: 'hobgob-pair', label: '2× Hobgoblin', slugs: ['hobgoblin','hobgoblin'] },
  { id: 'bandit-mob',  label: '3× Bandit + 1× Cultist', slugs: ['bandit','bandit','bandit','cultist'] },
  { id: 'bugbear',     label: '1× Bugbear', slugs: ['bugbear'] },
  { id: 'undead-pack', label: '2× Skeleton + 2× Zombie', slugs: ['skeleton','skeleton','zombie','zombie'] },
  { id: 'cult-set',    label: '1× Cult Fanatic + 2× Cultist', slugs: ['cult-fanatic','cultist','cultist'] },
  { id: 'troll',       label: '1× Troll', slugs: ['troll'] },
  { id: 'minotaur',    label: '1× Minotaur', slugs: ['minotaur'] },
  { id: 'mixed-elite', label: '1× Bugbear + 1× Cult Fanatic + 2× Hobgoblin',
                       slugs: ['bugbear','cult-fanatic','hobgoblin','hobgoblin'] }
];

// ---------- CLI flags ----------

const args = process.argv.slice(2);
const iters = num('--iters', 100);
const seed = num('--seed', 1);
const asJson = args.includes('--json');
const useOpen5e = args.includes('--open5e');

const SCENE = { cols: 10, rows: 7, cellSize: 64, scale: 3 };
const STAT_BLOCKS = new Map();

const results = [];
for (const p of PARTIES) {
  for (const lu of LINEUPS) {
    const r = await calibrateEncounter({
      party: p.party.map(stockToSimShape),
      monsters: buildMonsterInstances(lu.slugs, SCENE),
      scene: SCENE,
      iterations: iters,
      maxRounds: 15,
      seed
    });
    results.push({
      partyId: p.id, partyLabel: p.label,
      lineupId: lu.id, lineupLabel: lu.label,
      winRate: r.winRate, lossRate: r.lossRate, drawRate: r.drawRate,
      avgRounds: r.avgRounds,
      lethality: r.lethality, deathToll: r.deathToll,
      difficulty: r.difficulty?.label || 'unknown',
      encounterXp: r.difficulty?.encounterXp || 0
    });
  }
}

if (asJson) console.log(JSON.stringify({ iters, seed, open5e: useOpen5e, results }, null, 2));
else printMarkdown(results, { iters, seed });

// ---------- helpers ----------

function num(flag, fallback) {
  const v = args.find(a => a.startsWith(flag + '='));
  if (!v) return fallback;
  const n = Number(v.split('=')[1]);
  return Number.isFinite(n) ? n : fallback;
}

function pc({ id, name, cls, lvl, str = 10, dex = 10, con = 10, int: _int = 10, wis = 10, cha = 10,
  hpMax, mainhand, carried = [], spells = [] }) {
  const mod = s => Math.floor((s - 10) / 2);
  return {
    id, name, classes: [{ name: cls, level: lvl }],
    hp: { current: hpMax, max: hpMax },
    abilityScores: { STR: str, DEX: dex, CON: con, INT: _int, WIS: wis, CHA: cha },
    abilityModifiers: { STR: mod(str), DEX: mod(dex), CON: mod(con), INT: mod(_int), WIS: mod(wis), CHA: mod(cha) },
    equipment: { mainhand },
    carried,
    spells: spells.map(n => ({ name: n })),
    conditions: [],
    feats: []
  };
}

function stockToSimShape(member, idx) {
  return { ...member, _position: { col: 0, row: idx } };
}

function statBlockFor(slug) {
  if (!STAT_BLOCKS.has(slug)) {
    const url = new URL(`../src/tests/fixtures/open5e/srd_${slug}.json`, import.meta.url);
    STAT_BLOCKS.set(slug, withEngineFields(normalizeCreature(JSON.parse(readFileSync(url, 'utf8')))));
  }
  return STAT_BLOCKS.get(slug);
}

function buildMonsterInstances(slugs, scene) {
  return slugs.map((slug, i) => {
    const m = {
      id: `m-${slug}-${i}`,
      name: prettify(slug),
      presetSlug: slug,
      hp: hpFor(slug),
      position: { col: scene.cols - 1, row: i % scene.rows },
      conditions: []
    };
    if (!useOpen5e) return m;
    const sb = statBlockFor(slug);
    return { ...m, name: sb.name, hp: { current: sb.hpMax, max: sb.hpMax }, statBlock: sb };
  });
}

// The M45 suite's HP table (kept so the default run matches the doc's inputs).
function hpFor(slug) {
  const table = {
    'goblin': { current: 7, max: 7 },
    'orc': { current: 15, max: 15 },
    'hobgoblin': { current: 11, max: 11 },
    'bugbear': { current: 27, max: 27 },
    'kobold': { current: 5, max: 5 },
    'skeleton': { current: 13, max: 13 },
    'zombie': { current: 22, max: 22 },
    'troll': { current: 84, max: 84 },
    'minotaur': { current: 76, max: 76 },
    'bandit': { current: 11, max: 11 },
    'cultist': { current: 9, max: 9 },
    'gnoll': { current: 22, max: 22 },
    'cult-fanatic': { current: 33, max: 33 }
  };
  return table[slug] || { current: 10, max: 10 };
}

function prettify(slug) {
  return slug.split('-').map(s => s[0].toUpperCase() + s.slice(1)).join(' ');
}

function pct(x) { return `${Math.round(x * 100)}%`; }

function printMarkdown(rows, { iters, seed }) {
  console.log(`Each cell is a Monte-Carlo run of \`${iters}\` iterations per encounter
at seed \`${seed}\` against the headless simulator
(\`src/js/scene/calibrator.js\`), monsters ${useOpen5e ? 'with SRD stat blocks (`--open5e`)' : 'from the LPC presets'}.
Generated by \`node scripts/calibrator-baseline.mjs${useOpen5e ? ' --open5e' : ''}${iters !== 100 ? ` --iters=${iters}` : ''}${seed !== 1 ? ` --seed=${seed}` : ''}\`.

Numbers report from the party's perspective:
**Win** = party victory rate · **Loss** = TPK rate · **Draw** = neither
side resolved within 15 rounds · **Lethality** = avg party HP lost ·
**Deaths** = expected number of PCs downed · **Difficulty** = DMG
encounter bucket (XP-based).`);
  for (const p of PARTIES) {
    console.log(`\n## ${p.label}\n`);
    console.log('| Encounter | Win | Loss | Draw | Avg rounds | Lethality | Deaths | Difficulty |');
    console.log('|---|---:|---:|---:|---:|---:|---:|---|');
    for (const r of rows.filter(x => x.partyId === p.id)) {
      console.log(`| ${r.lineupLabel} | ${pct(r.winRate)} | ${pct(r.lossRate)} | ${pct(r.drawRate)} | ${r.avgRounds.toFixed(1)} | ${pct(r.lethality)} | ${r.deathToll.toFixed(2)} | ${r.difficulty} |`);
    }
  }
  const mean = (f) => rows.reduce((s, r) => s + f(r), 0) / rows.length;
  console.log('\n## Summary\n');
  console.log(`- **Mean win rate** across all ${rows.length} encounters: ${pct(mean(r => r.winRate))}`);
  console.log(`- **Mean loss rate**: ${pct(mean(r => r.lossRate))}`);
  console.log(`- **Mean lethality**: ${pct(mean(r => r.lethality))} of party HP per fight`);
  console.log(`- **Mean rounds-to-resolution**: ${mean(r => r.avgRounds).toFixed(1)}`);
}
