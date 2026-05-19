# M45 — Combat AI + Mechanics Fix Plan

## Status
Drafted 2026-05-18. Captures three reported bugs and the architectural
work to fix them properly, plus polish items surfaced during the audit.

---

## Reported problems

1. **HP-zero doesn't end the fight.** When a PC or monster hits 0 HP,
   the auto-fight loop continues until the round cap fires and the
   encounter reports "stalemate".
2. **PC AI never switches weapons.** A fighter carrying both a longsword
   and a longbow will only ever attack with their `mainhand`, no matter
   the situation.
3. **PC AI never casts spells.** Casters with prepared spells + slots
   never use them.

---

## Diagnosis (from code audit)

### Bug 1 — HP-zero-doesn't-end-fight

**Root cause.** The auto-fight loop checks `currentPartyEndState()`
**only** *after* a successful attack/cast. The early `break` at
[main.js:830](src/js/main.js#L830) — taken when an entity finds no
target via `pickLowestHpEnemy` — exits the inner for-loop *without*
running the verdict check. The outer `for round = 1..30` then ticks
to the next round, every entity hits the same no-target break, and
the loop walks straight to round 30 and emits `endVersusFight('draw',
30)`.

**Evidence.** [main.js:830](src/js/main.js#L830) (`if (!target) break;`
with no verdict check), [main.js:897-898](src/js/main.js#L897)
(verdict only after attack), [main.js:906](src/js/main.js#L906)
(terminal `'draw'`). `applyDamage` at [main.js:2811](src/js/main.js#L2811)
correctly mutates the live entity HP — the data layer is fine.

**Fix scope.** Small.

### Bug 2 — PC AI doesn't switch weapons

**Root cause.** The live runner `runVersusPartyAuto` **never invokes
the PC AI planner.** The monster branch at
[main.js:824-826](src/js/main.js#L824-L826) calls
`pickVersusTargetWithProfile` and produces a full `plan`. The PC
branch at [main.js:827-828](src/js/main.js#L827-L828) only picks a
target via `pickLowestHpEnemy` and immediately dispatches to
`attackInVersus`. Inside that path, `getAttackerWeapon` at
[main.js:2736](src/js/main.js#L2736) hardcodes
`hit.entity.equipment?.mainhand`. There is no `_chosenWeapon` read,
no enumeration of `carried[]`, no consultation of
`weaponsAvailableFor` at [action-options.js:76](src/js/scene/ai/action-options.js#L76).

The simulator at [simulator.js:258](src/js/scene/simulator.js#L258)
already calls `choosePcAction` and writes `attacker._chosenWeapon =
plan.weapon` — but `main.js` never imports `pc-action.js`.

**Fix scope.** Medium. We need to (a) call `choosePcAction` in the
live runner, (b) persist `_chosenWeapon` on the PC, and (c) teach
`getAttackerWeapon`/`runAttackPrompt` to honor it.

### Bug 3 — PC AI doesn't use spells

**Two layered failures.**

(a) Bug 2 means no `plan` is ever generated for PCs — so no `plan.kind
=== 'cast'` is ever surfaced. `pc-action.js` already builds cast
plans at [pc-action.js:209](src/js/scene/ai/pc-action.js#L209) and
[pc-action.js:279](src/js/scene/ai/pc-action.js#L279); the live
runner just doesn't ask.

(b) Even if a PC cast plan were generated, the dispatch gate at
[main.js:856](src/js/main.js#L856) explicitly restricts cast routing
to monsters: `if (plan && plan.kind === 'cast' && entry.entityKind
=== 'monster')`. PCs would fall through to `attackInVersus`. And
`castInVersus` at [main.js:1202](src/js/main.js#L1202) is built
around monster preset spellbooks — it calls
`spellbookFor(caster.presetSlug)` at
[main.js:1209-1213](src/js/main.js#L1209-L1213), returns nothing for
PCs, and early-exits at line 1214.

**Fix scope.** Large. Needs (a) PC AI wiring (Bug 2), (b) a PC-aware
cast path that uses `spellAttackBonus`/`spellSaveDC` from
`pc-stats.js`, the PC's `_slots` map for slot accounting, and the
already-tested `runAttackPrompt` spell branch at
[main.js:2443](src/js/main.js#L2443) or `runSpellSavePrompt`, and (c)
the dispatch gate at line 856 dropping the `entityKind === 'monster'`
restriction.

### Other issues surfaced during the audit

- **`runSpellSavePrompt` is synchronous** ([main.js:2632](src/js/main.js#L2632)).
  Not awaited from the caller. If PC casting routes through it, the
  auto-loop can race damage application against the next verdict
  check. → Make it async + await it.
- **Reaction refresh duplicated** ([main.js:2432](src/js/main.js#L2432)).
  Already reset at top-of-round; resetting per-turn too is harmless
  today but masks reaction-budget bugs. → Pick one location.
- **Off-hand regex too narrow** ([action-options.js:89](src/js/scene/ai/action-options.js#L89)).
  Filters out shields correctly but also misses legitimate weapons
  (spear, rapier, scimitar, quarterstaff). Dual-wielders skip their
  off-hand silently. → Widen, or invert the test (gate on item.kind).
- **`considerPcHeal` weight asymmetric**
  ([pc-action.js:271](src/js/scene/ai/pc-action.js#L271)). Heal weight
  defaults to 1.0 hardcoded while offense uses `actionWeights[opt.kind]
  ?? 0`. Caster PCs over-prefer healing for mildly-wounded allies. →
  Move heal default into `actionWeights`.

---

## Research — what good combat AI looks like

Game-AI literature converges on a few patterns that the codebase already
uses *partially*:

1. **Utility AI** (Mark, 2009; Halo, F.E.A.R., Sims). Each candidate
   action gets a score from weighted considerations (target HP, range,
   resource availability, kill window). Best score wins. The codebase
   does this in `pc-features.js` and `pc-action.js`'s `scoreBoost`
   pipeline — but **the live runner skips the planner entirely** for
   PCs, so the system is dormant in the actual fight.

2. **Action enumeration** — generate a full candidate set per turn from
   the entity's *capabilities*, not just their default weapon. A PC
   with a longsword + longbow should produce two candidate options;
   a paladin with smite slots should produce melee, melee+smite, and
   cast options. `action-options.js`'s `weaponsAvailableFor` does
   enumerate — it's just unreached.

3. **Hierarchical decision (a.k.a. GOAP-lite).** First pick the goal
   (kill the wounded enemy / disable the caster / protect the cleric),
   then pick the action that best satisfies it. The codebase has
   archetypes ("bruiser", "controller", "support") in `pc-action.js`
   that are essentially goal-flavors — keep them, but make sure both
   the live AND simulator paths use the same plan shape so a player's
   archetype edit (M42.3) is honored everywhere.

4. **MCTS for resource decisions.** Slots/uses-per-day choices are
   "do I burn it now or hold it?" Shallow rollouts (M42.2) work well
   here. Already implemented for `pickSmiteSlot`; should extend to
   "should I cast Fireball now?" and "should I use Healing Word now?"

5. **A unified plan/execute loop.** The single biggest architectural
   smell is that the **simulator and the live runner are two parallel
   implementations of the same game.** They diverge on planning,
   spell handling, OA routing, and feature consumption. The fix is
   not to widen the divergence — it's to **collapse the live runner
   onto the simulator's plan/execute spine** and have the live UI
   drive it with prompts and pacing.

---

## Plan

Five phases. Each is independently shippable; later phases depend on
earlier ones.

### Phase 1 — Health tracking + end-state correctness (THE bug)

**Goal.** A fight ALWAYS ends the turn after the last enemy or party
member hits 0 HP. No stalemate-at-30 unless both sides legitimately
have live entities at round 30.

**Tasks.**
1. Add a `currentPartyEndState()` check **before** the `break` at
   [main.js:830](src/js/main.js#L830).
2. Add a final `currentPartyEndState()` check at the bottom of each
   round's inner for-loop (so a killing blow from a non-last actor
   ends the fight without waiting for the next entry's turn).
3. Extract a single `checkAndMaybeEndFight(round)` helper used by
   both call sites — drier and keeps the early-end policy in one
   place.
4. Tests:
   - New test that the auto-loop ends in round 1 when a single-shot
     party wipes the only monster (don't stall to round 30).
   - New test that the loop ends mid-round when an OA killing blow
     drops the last enemy (verdict fires before the next entry).
   - Regression: existing "stalemate-after-30" test still passes
     when neither side can finish the other.

**Files touched.** main.js (runner + helper). No new modules.

**Estimated scope.** Small — ~30 lines + ~3 tests.

### Phase 2 — Wire `choosePcAction` into the live runner

**Goal.** Every PC turn in the live runner produces a full `plan` —
same shape, same options, same scoring as the simulator.

**Tasks.**
1. Import `choosePcAction` from `pc-action.js` in main.js.
2. In `runVersusPartyAuto`'s PC branch
   ([main.js:827](src/js/main.js#L827)), call `choosePcAction({ self,
   allies, hostiles, scene })` to produce `plan`. Pass the SAME shape
   `choosePcAction` already receives in the simulator.
3. Persist `plan.weapon` onto the PC as `_chosenWeapon` before
   dispatching.
4. Modify `getAttackerWeapon` at
   [main.js:2736](src/js/main.js#L2736) to read `_chosenWeapon` first,
   fall back to `mainhand`.
5. After the attack lands, **clear** `_chosenWeapon` so the next turn
   re-evaluates. (Avoids stale state if the AI changes its mind.)
6. Honor `plan.targetId` over `pickLowestHpEnemy` — the planner has
   already considered range, type matchups, and feature synergy.
7. Widen `weaponsAvailableFor`'s off-hand regex bug
   ([action-options.js:89](src/js/scene/ai/action-options.js#L89)) so
   dual-wielders actually see their off-hand option.

**Tasks — tests.**
- Live runner picks a bow when the target is 30+ ft away and the PC
  has a bow in `carried`. Snapshot the chosen weapon.
- Live runner picks the off-hand for a TWF rogue when the target is
  adjacent. (Catches the regex widening.)
- Re-evaluation: changing a PC's carried inventory mid-fight causes
  the next turn to potentially pick a different weapon.
- Test that `_chosenWeapon` is cleared after the attack runs.

**Files touched.** main.js, action-options.js. No new modules.

**Estimated scope.** Medium — ~80 lines + ~6 tests.

### Phase 3 — PC casting in the live runner

**Goal.** A PC caster's `plan.kind === 'cast'` actually fires a spell.
Slot accounting, spell attack rolls, save DCs, upcasting decisions —
all flow through.

**Sub-phases:**

**3a. Unblock the dispatch gate.** Remove `entry.entityKind ===
'monster'` from [main.js:856](src/js/main.js#L856) so PC cast plans
route to `castInVersus`.

**3b. Make `castInVersus` PC-aware.** Replace the
`spellbookFor(presetSlug)` lookup ([main.js:1209-1213](src/js/main.js#L1209-L1213))
with a branch: if `caster.kind === 'pc'`, use `caster.entity.spells`
and `caster.entity._slots`; if monster, fall through to the existing
preset path. Spell attack bonus from `spellAttackBonus(pc, spell)`
(already in `pc-stats.js`); save DC from `spellSaveDC(pc)`.

**3c. Slot accounting on the PC.** After a successful cast, decrement
`pc._slots[level]`. Existing reset-at-rest paths already handle slot
recovery.

**3d. Wire spell attack vs save spell routing.** Reuse the existing
`runAttackPrompt`/`runSpellSavePrompt` infra by passing `combat.spell
= chosenSpell` before dispatching, then letting the prompt handlers
work as today.

**3e. Make `runSpellSavePrompt` async + await it.** Fixes the pacing
risk.

**3f. Cast pacing in the cinema.** Currently `playCinemaRoundForAttack`
only runs after attack/weapon paths. For PC casts (esp. spell attacks
like firebolt, or save spells like burning hands), route through the
cinema too — use the existing `staff-cast` motion or a new
`spell-cast` motion. Detail deferred to Phase 5.

**Tasks — tests.**
- A wizard PC with `firebolt` cantrip + no slots casts firebolt
  (attack roll, fire damage).
- A wizard PC with a 1st-level slot + `magic missile` consumes a
  slot, deals 3 darts of 1d4+1 force damage, slot decrements.
- A cleric PC with a 1st-level slot + `cure wounds` heals a wounded
  ally rather than attacking.
- A cleric PC with no slots + `sacred flame` cantrip casts it (DEX
  save).
- Slot recovery on long-rest: confirmed unchanged.

**Files touched.** main.js (heavily), pc-action.js (verify cast
options enumerate correctly). New module possible if `castInVersus`
gets too dense: `src/js/scene/cast-runner.js`.

**Estimated scope.** Large — ~250 lines + ~12 tests.

### Phase 4 — Convergence: collapse live + simulator onto one spine

**Goal.** A single `runOneAttack(state, plan, context)` function. Both
the simulator and the live runner call it. UI prompts/pacing/cinema
are *side-channels* attached via callbacks, not parallel
re-implementations.

This is the architectural fix that prevents Bugs 2 and 3 from
re-emerging in a different shape next time something is added.

**Tasks.**
1. Identify the simulator's `runOneAttack` (or equivalent) in
   `simulator.js`. Extract it into a new module
   `src/js/scene/combat-engine.js` with a callback signature like:
   ```js
   runOneAttack({
     attacker, target, plan, scene, rng,
     prompts: {
       onShieldReaction?: () => Promise<bool>,
       onCounterspell?: () => Promise<bool>,
       onCinemaRound?: ({attacker, defender, dmg, crit, ...}) => Promise,
     }
   })
   ```
2. Pure logic (advantage rolls, damage calc, feature consumption,
   slot decrement, HP application) is single-source-of-truth.
3. The simulator passes no-op prompts (auto-resolves).
4. The live runner passes the real prompt functions.
5. `attackInVersus` becomes a ~20-line wrapper around `runOneAttack`.
6. `runAttackPrompt`'s manual-click path collapses into the same
   call with `prompts.onCinemaRound = null`.

**Tasks — tests.**
- Replay the existing simulator test suite against `combat-engine` —
  zero regressions in stats, dice rolls, slot consumption, OA timing.
- Snapshot test: a 5-turn fight produces *identical* HP trajectories
  between simulator-mode and live-mode (with all prompts auto-
  resolving the same way).
- Manual-click regression: clicking through an attack in the UI
  still resolves correctly.

**Files touched.** New `combat-engine.js`. Heavy refactor of main.js
+ simulator.js. No behavior change *by design*.

**Estimated scope.** Large — ~500 lines moved + ~15 invariance tests.
This is the most architecturally valuable phase but also the riskiest.
Recommend doing this with a green test suite at every commit.

### Phase 5 — Polish + bug-cleanup

After the spine is unified, sweep the items the audit surfaced:

1. `runSpellSavePrompt` async (already covered in Phase 3e).
2. Deduplicate the reaction-refresh paths
   ([main.js:2432](src/js/main.js#L2432)).
3. Move `considerPcHeal`'s default weight into `actionWeights`
   ([pc-action.js:271](src/js/scene/ai/pc-action.js#L271)).
4. Defensive: `pickLowestHpEnemy` should treat `hp.current ===
   undefined` as down (currently would compare-undefined).
5. Cinema cast pacing (deferred from Phase 3f) — pick a `spell-cast`
   motion id, wire it.
6. Document the planner architecture in CLAUDE.md so future agents
   don't re-introduce the parallel-paths divergence.

---

## Open questions for the user

- **Should manual-click attacks also use `choosePcAction` to
  recommend a target/weapon?** It would surface as a "PC AI suggests
  the longbow against this target" hint, while still letting the
  player click their own choice. Worth doing or keep manual = manual?
- **Should the PC AI cast IF a PC's auto-fight `mode = 'auto'` is on,
  or only if `versusAutoMode` is on?** Right now there's a single
  global `versusAutoMode` flag; if a user wants a hand-driven cleric
  with auto-fighter teammates, the current shape doesn't allow it.
- **MCTS for "should I cast now?"** — the M42.2 MCTS pool exists for
  slot decisions. Extend it to cast/no-cast and which-spell? Worth
  it for high-impact spells (Fireball, Banishment, Counterspell);
  overkill for cantrips. Recommend: only for slot-burning spells.

---

## Recommended order of execution

1. **Phase 1 first** — it's small, surgical, and ends the
   user-reported show-stopper. Ship same day.
2. **Phase 2 second** — restores PC AI to feature parity with what
   the simulator can already do. Ship 1-2 days.
3. **Phase 3 third** — restores PC casting. Ship 3-5 days.
4. **Phase 4 if + when there's appetite** — architectural cleanup.
   It's the right long-term move but it's a big refactor; gate on
   whether the user wants stability over more visible features
   first.
5. **Phase 5 as cleanup passes** between the above.

The architecture refactor in Phase 4 is the only phase that *could*
be skipped — the bugs will be fixed by Phases 1-3 alone. But every
new feature added without Phase 4 risks re-creating the simulator/
live divergence somewhere else.
