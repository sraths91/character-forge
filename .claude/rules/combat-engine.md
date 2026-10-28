---
paths:
  - "src/js/scene/**"
---

# Combat Engine Rules — one spine, no parallel implementations

`src/js/scene/combat-engine.js` is the single spine for D&D combat, and
`turn-manager.js` is the one round loop around it (`runTurn` →
`runOneAttack(…, prompts, ctx)`). Callers: the simulator (`prompts: {}`), the
server room (`api/rooms/real-engine.js` via turn-manager — EncounterState via
`encounter-adapters.js`, intents via `intent-validation.js`, reactions via
`prompt-adapter.js`; the forge's "Play at the table" handoff opens a solo
room here) and the legacy classic versus module behind `?classic=1`
(`client/legacy/classic-versus.js` + `client/legacy/live-bridge.js`, to be
deleted after one release).

- **`src/js/scene/**` imports only from `scene/`, `shared/`, `campaign/` and
  `map/`** (M64 T10 / M65 T24 lint allowlist) — never `client/`, `anim/`,
  `main.js`, `scene-state.js` or `reaction-prompt.js`, so the server can
  import the engine unchanged.

- **HP changes only through `applyDamage` / `applyHealing`** and conditions
  through `applyCondition` / `removeCondition` (lifecycle in `conditions.js`);
  emit every state change through `ctx.emit` (catalogue in
  `src/js/shared/events.js`).
- **Do NOT add a parallel implementation of an engine that already exists.**
  The simulator/live divergence (M28-M44) was a years-long drag because every
  feature had to be added twice — the combat-engine spine fixes that. Keep new
  combat features in the spine.
- **Do NOT add helpers to `main.js` for combat resolution** — those belong in
  `combat-engine.js` or `ai/pc-action.js`.
- Action selection stacks three layers: utility AI (declarative per-archetype
  weights in `ai/pc-profiles.js` / `ai/profiles.js`), class features
  (`ai/pc-features.js` — each defines `available()`, `scoreBoost()`,
  `consume()`), and MCTS for resource decisions (`ai/mcts.js`, shallow rollouts
  refining which slot to burn; `pickUpcastTier` in `pc-action.js`).
- `actionWeights.heal = 0` is the default — `considerPcHeal` surfaces no heal
  candidates unless an archetype opts in with a positive heal weight.
- Add ≥1 node:test unit test per public export. Run `npm test`, then
  `npm run lint` (warning budget 20) and `npm run build` before committing.
  Engine goldens (`src/tests/golden/`) and simulator stat goldens change only
  in a commit that states why.
