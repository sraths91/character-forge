---
paths:
  - "src/js/scene/**"
---

# Combat Engine Rules — one spine, no parallel implementations

`src/js/scene/combat-engine.js` is the single spine for D&D combat. Three
callers fan into it: the simulator (`simulator.js`, `prompts: {}`), live
auto-fight (`runVersusPartyAuto` in `main.js`), and manual canvas clicks
(`runManualWeaponAttack` / `runManualCast`, which inject a `forcePlan`).

- **Do NOT add a parallel implementation of an engine that already exists.**
  The simulator/live divergence (M28-M44) was a years-long drag because every
  feature had to be added twice — the combat-engine spine fixes that. Keep new
  combat features in the spine.
- **Do NOT add helpers to `main.js` for combat resolution** — those belong in
  `combat-engine.js` or `ai/pc-action.js`.
- Action selection stacks three layers: utility AI (declarative per-archetype
  weights in `ai/pc-profiles.js` / `ai/monster-profiles.js`), class features
  (`ai/pc-features.js` — each defines `available()`, `scoreBoost()`,
  `consume()`), and MCTS for resource decisions (`ai/mcts.js`, shallow rollouts
  refining which slot to burn; `pickUpcastTier` in `pc-action.js`).
- `actionWeights.heal = 0` is the default — `considerPcHeal` surfaces no heal
  candidates unless an archetype opts in with a positive heal weight.
- Add ≥1 node:test unit test per public export. Run `npm test`, then
  `npm run lint` (warning budget 20) and `npm run build` before committing.
