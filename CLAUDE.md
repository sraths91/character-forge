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

## The combat architecture (post M45)

There used to be two parallel implementations of D&D combat: the
headless simulator (M20) and the live versus runner (M28+). They
drifted — by M45 the live runner was missing PC AI entirely (no
weapon switching, no spell casting) because it never invoked
`choosePcAction`. Phase 4 of M45 collapsed them onto a single spine.

The current shape:

```
src/js/scene/combat-engine.js          ← the spine
  runOneAttack(attacker, enemies, allies, scene, rng, prompts)
    → planner dispatch
        - prompts.forcePlan ? use it
        - monster ? chooseAction(profile)
        - PC      ? choosePcAction (utility + MCTS for resources)
    → movement + opportunity attacks (prompts.onReactionAttack)
    → attack OR cast
       - weapon: resolveAttack → roll → Shield (prompts.onShieldReaction)
                 → damage → smite/sneak/reckless/surge → cinema
                   (prompts.onCinemaRound)
       - cast:   runMonsterSpell → book lookup → Counterspell
                 (prompts.onCounterspell) → kind branch (heal /
                 auto-hit / spell-attack / AoE / single-target save)
```

Three callers fan out into this spine:

1. **Simulator** (`src/js/scene/simulator.js`) — passes
   `prompts: {}`. Every reaction auto-resolves via the engine's
   heuristic. Hot loop runs ~200 iterations × 12 rounds × N entities
   in the headless test path.

2. **Live auto-fight** (`runVersusPartyAuto` in `src/js/main.js`)
   — passes prompts that wire to the cinema, attack log, cast log,
   and (in `interactive` mode) the real `promptReaction` dialog.
   The wrap-then-write-back bridge lives in
   `wrapLivePcForEngine` / `wrapLiveMonsterForEngine` /
   `writeBackPcFromEngine` / `writeBackMonsterFromEngine` /
   `runEngineTurn`.

3. **Manual canvas click** (`runManualWeaponAttack` /
   `runManualCast` in `src/js/main.js`) — builds a synthetic plan
   from the player's pick (weapon + target, or queued spell +
   target) and dispatches via `runEngineTurn` with
   `{ forcePlan, interactive: true }`. The forcePlan injection
   skips AI planning so the player's choice wins.

The non-engine `runAttackPrompt` / `runSpellSavePrompt` path remains
as a fallback for spells without a `monster-spells.js` registry
entry (homebrew, edge cases).

## AI architecture

Three layers stack on top of each other for action selection:

1. **Utility AI** (M32 / M42) — per-target considerations × weights
   produce a per-option score. Defined declaratively per archetype
   in `src/js/scene/ai/pc-profiles.js` and `monster-profiles.js`.

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

The work is tracked in `docs/M45-COMBAT-FIX-PLAN.md`. Animation
deferred items in `docs/DEFERRED.md` (M44.4 = bow projectile arcs,
M44.5 = directional facing).
