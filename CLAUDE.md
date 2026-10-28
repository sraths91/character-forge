# character-forge

Browser-based D&D 5e tactical combat + party-management tool. Vanilla
ES modules, Vite for the front-end build, Express + better-sqlite3
backend, node:test for unit tests.

## What the app does

- **Character forge** — parse D&D Beyond JSON, derive AC / attacks /
  spell slots / saves, render LPC sprites with equipment overlays.
- **Versus mode** — drop a party onto a grid scene with monsters, run
  initiative, dispatch turns either manually (click attack → click
  target) or via auto-fight.
- **Cinema view** — Fire-Emblem-GBA-style 1v1 cinematic that
  dramatizes each exchange with weapon motions, hurt flashes, camera
  zoom on big hits, and terrain-keyed backgrounds.
- **Headless simulator** — runs N Monte-Carlo iterations of the
  current encounter with seeded RNG; aggregates win-rate / average
  rounds / per-entity stats. Backs the M35 encounter calibrator.

## The combat architecture (post M45, M64)

There used to be two parallel implementations of D&D combat: the
headless simulator (M20) and the live versus runner (M28+). They
drifted — by M45 the live runner was missing PC AI entirely (no
weapon switching, no spell casting) because it never invoked
`choosePcAction`. Phase 4 of M45 collapsed them onto a single spine.

The current shape (M64):

```
src/js/scene/turn-manager.js           ← ONE round loop
  startEncounter / runTurn / runRound / runEncounter
    initiative, start-of-turn resets, condition lifecycle (R7),
    incapacitated skip, legendary actions, victory check, round cap,
    DM command queue (HP / conditions) at safe points, pause
      → runOneAttack(attacker, enemies, allies, scene, rng, prompts, ctx)

src/js/scene/combat-engine.js          ← the spine
  runOneAttack
    → plan: prompts.forcePlan | chooseAction (monster) |
            choosePcAction (PC: utility + features + MCTS)
      → prompts.onPlanReady (DM review) → target by plan.targetSide
    → movement (pathing.js / grid-legality.findPath on terrain maps)
      + opportunity attacks (prompts.onReactionAttack)
    → weapon: resolveAttack → roll (prompts.onRoll) → Shield
              (prompts.onShieldReaction) → applyDamage → smite / sneak
              / reckless / surge → exchange event + prompts.onCinemaRound
    → cast:   runMonsterSpell → book → Counterspell
              (prompts.onCounterspell) → heal / auto-hit / spell attack
              / AoE / single-target save
  applyDamage / applyHealing — the ONLY HP writers (R/I/V → temp HP →
    HP → concentration → downed); applyCondition / removeCondition +
    conditions.js for the condition lifecycle
  ctx.emit(ev) — every state change as a catalogue-v1 event
    (engine-events.js, src/js/shared/events.js)
```

Callers:

1. **Simulator** (`simulator.js`) — `prompts: {}`, no emit; every
   reaction auto-resolves via the engine heuristic. Hot loop:
   ~200 iterations × 12 rounds × N entities.
2. **The server room** (M64 online table; `api/rooms/real-engine.js`
   via `turn-manager.js`) — `turnStateFromEncounter` → `runTurn` →
   `encounterFromTurnState`; player intents pass `validateIntent` /
   `planFromIntent` (`intent-validation.js`) and reactions go through
   `createPromptAdapter` (`prompt-adapter.js`: timeout → autoAnswer,
   answers logged for replay). The forge's versus panel plays here too:
   **"Play at the table"** (`client/forge-handoff.js`, M65 V21) opens a
   server-hosted **solo room** (`POST /api/rooms {mode: 'solo'}`, the
   DM drives every seat no player holds), seats the forge party and
   hands `play.html` the queued encounter.
3. **The legacy classic versus module** behind `?classic=1`
   (`client/legacy/classic-versus.js`, M65 V22) — the old in-page
   driver, loaded only by a flag-guarded dynamic import in `main.js`.
   It reaches the engine through `client/legacy/live-bridge.js` (live
   records ⇄ EncounterState ⇄ wrappers) and `client/legacy/manual-plan.js`
   (manual clicks → `forcePlan`). **To be deleted** with the flag after
   one release; nothing in `src/js/scene/**` imports it (the T10 lint
   allowlist keeps scene imports to `scene/`, `shared/`, `campaign/`
   and `map/`).

State crosses the engine boundary only as EncounterState v1
(`src/js/shared/encounter-state.js`) via `encounter-adapters.js`
(`toEngineSides` / `applyEngineSides`; `WRAPPER_FIELD_MAP` lists every
wrapper field). Shared contracts in `src/js/shared/` (encounter state,
events, protocol, state hash) change additively with a version note.

**The run-state seam (M65).** Between encounters a run PC's mutable state
is `state_json` v1 (`src/js/shared/run-state.js`, "spent, not remaining";
maxima always come from the sheet). It crosses into and out of an
encounter only through `encounter-adapters.js`:

```
entityFromSheet(sheet, {pos, runState, items})   state_json v1 → entity
    HP / temp HP, spent slots + pact, feat:* / spell:* ledgers,
    ddb:* uses carried inert (DM-adjudicated, written back untouched),
    persistent conditions, death saves, exhaustion
    (campaign/exhaustion.js applyExhaustionToEntity); `items` (run-item
    map or list, runItemsLedger) → resources.items
  → turnStateFromEncounter → runTurn / runEncounter → …
  → endEncounterCleanup(ts)    (turn-manager.js: concentration and every
                                non-persistent condition end; spends kept)
  → encounterFromTurnState
runStateFromEntity(entity, prevState)            entity → state_json v1
    a NEW state; every key the engine does not own is kept
itemSpendFromEntity(entity)                      → run_items write-back
```

Rests, level-up, XP, loot, potions between nodes, death / revival live in
`src/js/campaign/` (pure, Node + browser, inside the T10 portability
guard, seeded rng only). The scene closure may import campaign modules
(one exhaustion table, one potion registry: `campaign/consumables.js`
`POTIONS`). **No combat rule outside `src/js/scene/`, no progression rule
outside `src/js/campaign/`** (M65 plan); `api/runs/**` sequences and
persists, it does not compute 5e.

The non-engine `runAttackPrompt` / `runSpellSavePrompt` path remains
as a fallback for spells without a `monster-spells.js` registry
entry (homebrew, edge cases).

## AI architecture

Three layers stack on top of each other for action selection:

1. **Utility AI** (M32 / M42) — per-target considerations × weights
   produce a per-option score. Defined declaratively per archetype
   in `src/js/scene/ai/pc-profiles.js` and `ai/profiles.js`.

2. **Class features** (M42.1) — `pc-features.js` lists Sneak Attack,
   Action Surge, Second Wind, Cunning Action, Divine Smite, and
   Reckless Attack. Each defines `available()`, `scoreBoost()`, and
   `consume()`. The planner walks every available feature and
   boosts whatever option benefits.

3. **MCTS for resource decisions** (M42.2, extended in M45 Phase 3)
   — `src/js/scene/ai/mcts.js` runs shallow rollouts (4 per
   candidate, depth 1) to refine which slot to burn for a
   slot-burning spell. Each leveled spell candidate is evaluated at
   every available slot tier (`pickUpcastTier` in `pc-action.js`);
   the resource tax scales with the tier so a level-5 burn is
   taxed harder than a level-1.

When a profile says `actionWeights.heal = 0` (the new default after
M45 Phase 5), `considerPcHeal` won't surface heal candidates. The
support_caster and smite_charger archetypes opt in with positive
heal weights. Other archetypes must declare it explicitly.

## Animation architecture

Cinema pipeline:
```
resolver (hit/crit/dmg)
  → motion         (motionForWeapon — sword-slash, axe-cleave, etc.)
  → style          (Quick / Standard / Power / Flourish — player choice)
  → modifiers      (Sneak / Rage / GWM / Smite / Reckless overlays)
  → polish         (crit / magic / level scaling / camera zoom / killing)
  → LPC sprites + effects on canvas (cinema-sprites.js, cinema.js)
```

All transforms are pure — `applySomething(seq) → newSeq`. The
animation Sequence is a `{id, duration, keyframes[], effects[]}`
data shape (see `src/js/anim/sequence.js`).

Backgrounds key off the scene's terrain preset
(`cinema-backgrounds.js`).

## Conventions

- **Constants:** `const` / `let`, never `var`.
- **Tests:** node:test. Run with `npm test`. Aim for ≥1 unit test
  per public export.
- **Lint + build before commit:** `npm run lint` then `npm run build`.
  Lint warning budget is 20.
- **Commit style:** conventional commits — `feat:`, `fix:`,
  `refactor:`, `docs:`, `test:`, `chore:`. Atomic, small, well
  described.
- **Never invent file paths or APIs** — verify with grep first.

## Things to avoid

- **Don't add a parallel implementation of an engine that already
  exists.** The simulator/live divergence (M28-M44) was a years-long
  drag because every feature had to be added twice. The
  combat-engine spine fixes this — keep new combat features there.
- **Don't add helpers to main.js for combat resolution** — those
  belong in `combat-engine.js` or `pc-action.js`.
- **Don't break the pure-transform discipline in `src/js/anim/`** —
  every applyXxx must return a new Sequence; never mutate the input.

## Roadmap state

Combat-engine unification is tracked in
`docs/M45-COMBAT-FIX-PLAN.md`. The cinema-completeness milestone —
spell-cast cinema, death animation, opportunity-attack cinema,
per-damage-type hit reactions, idle breathing — is
`docs/M56-CINEMA-COMPLETENESS-PLAN.md` (all 7 phases landed
2026-06-11). Deferred animation/cinema items live in
`docs/DEFERRED.md`.
