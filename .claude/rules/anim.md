---
paths:
  - "src/js/anim/**"
---

# Animation Rules — pure transforms only

The animation `Sequence` is a data shape: `{ id, duration, keyframes[], effects[] }`
(see `src/js/anim/sequence.js`).

- **Every `applyXxx` must return a NEW Sequence. Never mutate the input.**
  `applySomething(seq) → newSeq`. Breaking this discipline breaks the cinema
  pipeline, which composes transforms in order.
- The pipeline order is: resolver (hit/crit/dmg) → motion (`motionForWeapon` —
  sword-slash, axe-cleave, etc.) → style (Quick / Standard / Power / Flourish,
  the player's choice) → modifiers (Sneak / Rage / GWM / Smite / Reckless
  overlays) → polish (crit / magic / level scaling / camera zoom / killing) →
  LPC sprites + effects on canvas (`cinema-sprites.js`, `cinema.js`).
- Backgrounds key off the scene's terrain preset (`cinema-backgrounds.js`).
- Add ≥1 node:test unit test per public export. Run `npm test`, then
  `npm run lint` (warning budget 20) and `npm run build` before committing.
