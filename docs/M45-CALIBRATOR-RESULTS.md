# M45 Phase 6 — Calibrator results

Snapshot of the AI's combat performance, first taken after the M45
Phase 5 cleanup and **regenerated 2026-10-19 for M64 phase 1.5** (main
@ 36e23d5; identical at 85dcd46, before Wave 6). Everything between the `calibrator-baseline` markers below
is the verbatim output of `node scripts/calibrator-baseline.mjs`;
`src/tests/calibrator-doc.test.js` fails when the two drift (it runs in
CI with `CF_CALIBRATOR_DOC=1` and is skipped otherwise).

## 2026-10-19 — why the numbers moved since M45

The M45 tables came from a simulator that did not await its own engine
turns, in which a Rogue's Sneak Attack hit dealt 0 damage, and which had no
Extra Attack, dying or class-feature actions. To attribute the shift,
every first-parent commit on main since M45 that touched the engine
was re-run through the same script, parties, lineups and seed
(`git archive <sha> src/js`, 100 iterations, seed 1). The table lists
each commit that changed the output. Means are over all 33 encounters;
the last column traces Low party vs 1× Troll, the row that swung most.

| Commit | What changed | Rows | Win | Loss | Lethality | Rounds | Low vs Troll (win / loss) |
|---|---|---:|---:|---:|---:|---:|---|
| M45 | as published (reproduced exactly at `dfccba7` and `43afbb1`) | — | 84% | 16% | 29% | 4.5 | 1% / 99% |
| `054343e` | the AI's weapon switch reaches the resolver (June warhammer fix) — on top of the un-awaited simulator below, this gave implausible numbers | 31 | 98% | 2% | 14% | 4.1 | 97% / 0% |
| `0cd023e` | **T1** — the simulator awaits `runOneAttack`; before it, any turn that provoked an opportunity attack finished in a microtask after the iteration was scored | 14 | 88% | 12% | 23% | 4.1 | 8% / 92% |
| `9318993` | **R1** — multi-term dice: a Sneak Attack hit dealt 0 (the parser read one term of `1d8+4+3d6`; P0-3) and now deals all of it; crits double every die | 25 | 94% | 6% | 17% | 3.3 | 56% / 44% |
| `c6bbc2f` | **T5** — one spell-slot ledger; Shield and Counterspell spend from `_slots` | 1 | 94% | 6% | 17% | 3.3 | 56% / 44% |
| `35cec03` | **T6** — re-checks after every await: a mover downed by an opportunity attack no longer moves and swings at 0 HP | 13 | 93% | 7% | 18% | 3.3 | 42% / 58% |
| `4fbc77e` | **T7** — one turn manager for the simulator, browser and server | 9 | 93% | 7% | 18% | 3.2 | 42% / 58% |
| `fa96659` | **R12** — spell attacks go through `resolveAttack` | 5 | 93% | 7% | 18% | 3.2 | 42% / 58% |
| `f29990f` | the ally-heal fix — AI heal plans resolve among the allies | 3 | 93% | 7% | 18% | 3.2 | 42% / 58% |
| `98d6eac` | **R8** — one `applyDamage` / `applyHealing` for every HP change | 5 | 93% | 7% | 18% | 3.2 | 42% / 58% |
| `45c93f0` | **R7** — condition lifecycle (end-of-turn repeat saves, concentration-bound conditions) | 5 | 93% | 7% | 17% | 3.2 | 42% / 58% |
| `59b04dd` | **R10** — Extra Attack and monster Multiattack; Action Surge no longer re-moves | 27 | 93% | 7% | 17% | 3.0 | 46% / 54% |
| `e8b0f55` | **R9** — dying instead of removal: a PC at 0 is downed and makes death saves; AI monsters keep to live targets | 10 | 94% | 6% | 16% | 3.0 | 52% / 48% |
| `a02e156` | the `feature` action kind: bloodied fighters use Second Wind, and the feature availability check stops refusing every feature (no barbarian here, so no Rage) | 10 | 94% | 5% | 16% | 3.1 | 60% / 40% |
| `8f1617f` | cantrip scaling at levels 5 / 11 / 17 (the wizards' Fire Bolt is 2d10) | 2 | 94% | 5% | 16% | 3.1 | 60% / 40% |

Changes that did **not** move these tables, and why:

- **Real Open5e stat blocks (R11, `0da17bd`; rooms since `d5fda64`).**
  In an online room an Open5e monster now fights with its normalised
  SRD stat block, but the headless simulator still builds monsters from
  the LPC presets and reads only `hp` from its input, so these tables
  are unchanged. `--open5e` swaps
  in SRD hit points and moves only the rows with a Cult Fanatic (SRD 22
  HP against this table's 33): Low + Cult Fanatic + 2× Cultist goes
  from 93 % to 97 % wins, Low + Mixed Elite from 23 % to 36 %. Making the
  simulator read `statBlock` (AC, attacks, multiattack) is still to do.
- **Fighting Styles (`88f1575`).** The stock parties are hand-built
  with no class features, so no style applies.
- **Cover (`b90ef75`).** The calibrator's 10×7 scene has no terrain.
- **Recharge, legendary actions, Legendary Resistance (`bf9d5ad`).**
  Every row is identical before and after it.

What the shift means: the Low tier is no longer a coin flip against
"easy" lineups (2× Skeleton + 2× Zombie went from 28 % to 96 % wins),
and the deadly fights are now close rather than hopeless (Troll 1 % →
60 %, Mixed Elite 4 % → 23 %). The Mid and High tiers were already
near 100 % and now resolve about one round faster. The **Deaths**
column still counts PCs that end a fight at 0 HP (downed or dead).

<!-- calibrator-baseline:begin -->
Each cell is a Monte-Carlo run of `100` iterations per encounter
at seed `1` against the headless simulator
(`src/js/scene/calibrator.js`), monsters from the LPC presets.
Generated by `node scripts/calibrator-baseline.mjs`.

Numbers report from the party's perspective:
**Win** = party victory rate · **Loss** = TPK rate · **Draw** = neither
side resolved within 15 rounds · **Lethality** = avg party HP lost ·
**Deaths** = expected number of PCs downed · **Difficulty** = DMG
encounter bucket (XP-based).

## Low — 3 PCs lvl 3

| Encounter | Win | Loss | Draw | Avg rounds | Lethality | Deaths | Difficulty |
|---|---:|---:|---:|---:|---:|---:|---|
| 1× Goblin | 100% | 0% | 0% | 1.5 | 2% | 0.00 | trivial |
| 4× Goblin | 97% | 3% | 0% | 4.5 | 33% | 0.57 | easy |
| 2× Orc | 99% | 1% | 0% | 3.5 | 33% | 0.53 | easy |
| 2× Hobgoblin | 99% | 1% | 0% | 3.9 | 19% | 0.19 | easy |
| 3× Bandit + 1× Cultist | 100% | 0% | 0% | 4.3 | 27% | 0.36 | trivial |
| 1× Bugbear | 100% | 0% | 0% | 3.3 | 21% | 0.25 | trivial |
| 2× Skeleton + 2× Zombie | 96% | 4% | 0% | 6.6 | 52% | 1.01 | easy |
| 1× Cult Fanatic + 2× Cultist | 93% | 7% | 0% | 5.4 | 30% | 0.54 | hard |
| 1× Troll | 60% | 40% | 0% | 9.4 | 80% | 1.99 | deadly |
| 1× Minotaur | 49% | 51% | 0% | 7.7 | 81% | 2.16 | hard |
| 1× Bugbear + 1× Cult Fanatic + 2× Hobgoblin | 23% | 72% | 5% | 7.5 | 87% | 2.43 | deadly |

## Mid — 4 PCs lvl 5

| Encounter | Win | Loss | Draw | Avg rounds | Lethality | Deaths | Difficulty |
|---|---:|---:|---:|---:|---:|---:|---|
| 1× Goblin | 100% | 0% | 0% | 1.0 | 0% | 0.00 | trivial |
| 4× Goblin | 100% | 0% | 0% | 2.1 | 5% | 0.00 | trivial |
| 2× Orc | 100% | 0% | 0% | 1.7 | 1% | 0.00 | trivial |
| 2× Hobgoblin | 100% | 0% | 0% | 1.7 | 1% | 0.00 | trivial |
| 3× Bandit + 1× Cultist | 100% | 0% | 0% | 2.0 | 4% | 0.00 | trivial |
| 1× Bugbear | 100% | 0% | 0% | 1.4 | 0% | 0.00 | trivial |
| 2× Skeleton + 2× Zombie | 100% | 0% | 0% | 2.3 | 6% | 0.00 | trivial |
| 1× Cult Fanatic + 2× Cultist | 100% | 0% | 0% | 2.2 | 1% | 0.00 | easy |
| 1× Troll | 100% | 0% | 0% | 3.0 | 8% | 0.08 | easy |
| 1× Minotaur | 100% | 0% | 0% | 2.5 | 8% | 0.08 | trivial |
| 1× Bugbear + 1× Cult Fanatic + 2× Hobgoblin | 100% | 0% | 0% | 3.6 | 9% | 0.22 | easy |

## High — 4 PCs lvl 9

| Encounter | Win | Loss | Draw | Avg rounds | Lethality | Deaths | Difficulty |
|---|---:|---:|---:|---:|---:|---:|---|
| 1× Goblin | 100% | 0% | 0% | 1.0 | 0% | 0.00 | trivial |
| 4× Goblin | 100% | 0% | 0% | 2.0 | 2% | 0.00 | trivial |
| 2× Orc | 100% | 0% | 0% | 1.3 | 0% | 0.00 | trivial |
| 2× Hobgoblin | 100% | 0% | 0% | 1.5 | 0% | 0.00 | trivial |
| 3× Bandit + 1× Cultist | 100% | 0% | 0% | 2.0 | 2% | 0.00 | trivial |
| 1× Bugbear | 100% | 0% | 0% | 1.1 | 0% | 0.00 | trivial |
| 2× Skeleton + 2× Zombie | 100% | 0% | 0% | 2.1 | 2% | 0.00 | trivial |
| 1× Cult Fanatic + 2× Cultist | 100% | 0% | 0% | 2.0 | 0% | 0.00 | trivial |
| 1× Troll | 100% | 0% | 0% | 2.1 | 2% | 0.00 | trivial |
| 1× Minotaur | 100% | 0% | 0% | 2.1 | 3% | 0.00 | trivial |
| 1× Bugbear + 1× Cult Fanatic + 2× Hobgoblin | 100% | 0% | 0% | 2.8 | 3% | 0.00 | trivial |

## Summary

- **Mean win rate** across all 33 encounters: 94%
- **Mean loss rate**: 5%
- **Mean lethality**: 16% of party HP per fight
- **Mean rounds-to-resolution**: 3.1
<!-- calibrator-baseline:end -->

## Analysis (M45, 2026-06)

> Written against the M45 tables (mean win 84 %, loss 16 %,
> lethality 29 %, 4.5 rounds), which the 2026-10-19 note above
> explains. Kept as the record of what M45 saw; its numbers no longer
> match the tables above.

The numbers track DMG encounter buckets reasonably well across the
party-level spectrum, with a few patterns worth flagging.

### What's working

- **Low-tier sweep:** 3 PCs at lvl 3 reliably clear trivial single
  encounters (solo goblin, bugbear) with low lethality and short
  fights. Bugbear at 96% win rate is appropriate — bugbear is a
  surprise-attack threat that the simulator's flat initiative model
  doesn't fully model, so the headline number slightly overstates
  the win rate in practice.

- **Mid-tier dominance:** 4 PCs at lvl 5 win every encounter in the
  suite at near-100% rates. Lethality scales with monster pressure
  (1% vs a goblin, 31% vs the elite mixed group). Fights resolve in
  1–6 rounds, mirroring "DMG hard or easier" expectations.

- **High-tier dominance:** the lvl-9 party simply runs the table.
  Lethality stays under 8% even against the mixed-elite group.
  Average rounds drops to 2–4. This is the curve we want — high
  PCs out-tempo low-CR threats decisively.

- **PC AI features fire correctly:** spot-checked the logs for the
  Mid + Cult Fanatic encounter — the wizard cast Magic Missile when
  in range, the paladin smited on kill windows, the rogue's Sneak
  Attack triggered against flanked targets. Phase 2/3 wiring is
  functioning as designed.

- **Cinema motion routing (Phase 5)** verified manually — wizard
  casts now play the staff-cast sequence instead of a quarterstaff
  swing.

### What's noisier than expected

- **Low + 2× Skeleton + 2× Zombie: 28% win rate.** The DMG bucket
  labels this "easy" but it plays as "hard" for the low party. The
  zombies' 22 HP tank-pool exceeds the party's per-round DPR; the
  combat resolves into attrition where zombies' "Undead Fortitude"
  (CON save to drop to 1 HP instead of 0) — wait, our simulator
  doesn't model Undead Fortitude. So this is *under*-estimating
  zombie durability. The "easy" label is wrong; the empirical 28%
  is closer to truth. Action item: revisit the XP multiplier for
  high-HP-pool encounters OR add Undead Fortitude as a monster
  feature.

- **Low + Troll / Minotaur: 1-2% win.** Both are CR 5, both are
  rated "deadly" — wait, the difficulty table shows "trivial".
  That's a calibrator bug — `monsterXp(slug)` is probably missing
  XP entries for troll and minotaur. Action item: file an issue
  against the XP table.

- **Low + Mixed Elite: 4% win.** Reasonable for a "deadly"
  encounter except the difficulty label says "trivial" — same
  XP-table gap.

### Suggested follow-ups

1. **Audit `monsterXp(slug)`** in the calibrator — the "trivial"
   label appearing on what is empirically "deadly" suggests several
   monster slugs are missing from the XP table. Patch the table or
   default to a conservative value when missing.
2. **Add Undead Fortitude** to the zombie preset so the calibrator's
   numbers match the actual difficulty of an undead mob.
3. **Re-run after any AI tuning** — `node scripts/calibrator-baseline.mjs`
   prints this report's tables (see Reproducing below). Compare
   the win-rate column before/after a change to catch regressions
   where the AI gets "smart but turtles" or "smart but overcommits".

### Reproducing

```sh
# The tables above (100 iterations per encounter, seed 1)
node scripts/calibrator-baseline.mjs

# Monsters with their SRD hit points (src/tests/fixtures/open5e/)
node scripts/calibrator-baseline.mjs --open5e

# Tighten with more iterations + alternate seed, or machine-readable
node scripts/calibrator-baseline.mjs --iters=500 --seed=42
node scripts/calibrator-baseline.mjs --json > results.json

# Check this doc against the script (what CI runs)
CF_CALIBRATOR_DOC=1 node --test src/tests/calibrator-doc.test.js
```

`scripts/m45-calibrator-suite.js` (the original M45 script) prints the
same tables under the old M45 header; it awaits `calibrateEncounter`
again since 2026-10-19.
