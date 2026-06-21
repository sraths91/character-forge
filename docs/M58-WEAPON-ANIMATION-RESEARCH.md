# M58 — Weapon animation: research, diagnosis, fix

The cinema weapon "just flies around." Research into how 2D game
assets are animated, a trace of our pipeline, the root cause, the fix,
and what a fuller solution needs. (2026-06-20)

## Research — how held weapons should animate in 2D

Two established approaches for a weapon in a frame-based 2D character,
from the game-dev literature:

1. **Frame-matched layered sprites (the LPC way).** The weapon is its
   own animation sheet authored frame-for-frame against the body's
   attack frames, then composited per-frame at runtime. The artist
   draws the weapon in the correct hand position in every frame, so the
   weapon is *always* in the hand — there is no runtime geometry to get
   wrong. This is exactly LPC's model: modular layers (body, clothes,
   weapon) on a shared 64×64 frame grid, combined at runtime; the
   universal set added *oversize* weapon frames specifically so slash/
   thrust weapons track the hand through their arc.
   ([ULPC generator], [GameFromScratch — dynamically equipped 2D])

2. **Hard-point attachment.** For a weapon that is NOT pre-animated,
   you define a mount point (the hand) and an orientation **per body
   frame** — x, y, rotation for each frame — and pin the weapon there.
   The key is *per-frame*: the hand moves through the attack, so the
   attachment must move with it. ([GameFromScratch])

The anti-pattern both avoid: take **one** weapon image and procedurally
rotate it about a **fixed** pivot to fake a swing. A 2D sprite's painted
hand only sits at the pivot for one orientation; rotate it and the
painted hand drifts off the body's real hand — the blade visibly
detaches and orbits. That is "flying around."

## Diagnosis — what our code did

The cinema weapon overlay (`src/js/anim/cinema-sprites.js`) had two
modes:

- **`frames` mode** (the default `diagonal` swing) — played the weapon
  sheet's authored south-row slash frames (`swingFrameAt` → frame index,
  with a frame-smear). Correct, and it looked right. Confirmed by
  viewing `weapon/longsword.png`: the south row IS a real swing sequence
  (blade raised → sweeping → extended), not a walk.
- **`rotate` mode** (the M54 directional swings: overhead / horizontal /
  rising / thrust / backslash / spin) — took a **single** extended-blade
  frame (`baseFrame ≈ 0.55·frames`) and rotated it about a **fixed**
  grip (`{x:0.22, y:-0.42}` cell-fractions) through the swing's arc
  (`sampleSwing`, up to ~1.9 rad), with a rotated smear (`swingTrail`).

`rotate` mode is precisely the anti-pattern: one frame, fixed pivot,
big rotation → the blade orbits an invisible point, decoupled from the
body's hand (which is meanwhile moving through its own real LPC attack
frames). M54 reached for procedural rotation to get 7 swing *flavors*
from a single authored slash — but the flavors it produced fly.

## Fix (M58) — frame-play every swing

Retired `rotate` mode. **Every** swing now plays the authored weapon
frames (the path that already worked), so the weapon stays in the hand
and sweeps. Directional *flavor* is carried where it actually reads and
doesn't require torquing the sprite:

- the **body** plays its real LPC attack pose per swing
  (`bodyAnimForSwing` → slash / backslash / halfslash frames), and
- the **slash-effect swoosh** re-orients per swing (`applySwing`).

Code: `setActorWeapon` drops the mode/arc/baseFrame branch (always
frame-play); `drawWeaponOverlay` drops the rotate branch;
`paintWeaponRotated` and the now-unused `sampleSwing`/`swingTrail`/
`swingArcRig` imports are removed from cinema-sprites.js. (The swing-
type modules keep their exports + tests; the effect orientation still
uses them.)

**Verified visually** with a render harness driving the real
`drawWeaponOverlay` across an overhead swing: the blade's grip stays
pinned to the hand anchor through the whole sweep (raised-back →
extended-forward) with a motion smear — identical to the known-good
diagonal. No orbiting. 1212 tests green; lint/build clean.

## What a fuller solution needs (deferred)

This fix trades the (broken) procedural weapon *direction* for a held,
correct swing. The weapon sprite itself no longer re-aims per swing —
all swings play the one authored slash arc; the body + effect sell the
direction. To make the *weapon* genuinely differ per attack (a real
overhead chop vs a thrust vs a backslash) the right move is **more
authored weapon animation**, not more procedural geometry:

- **Real per-animation weapon sheets** — LPC ships weapon *thrust* and
  oversize slash art frame-matched to the body. Importing those (the
  M57 expanded-LPC work) lets thrust play a thrust and slash play a
  slash, each tracking the hand. This is the LPC-correct path.
- **Hard-point per-frame data** as a fallback for weapons without
  authored attack art: extract the LPC hand x/y/rotation per slash
  frame once, and pin the weapon there — true attachment, not a fixed
  pivot. Heavier; only worth it if we keep procedural weapons.

Logged in DEFERRED.md.

## Sources

- [Universal LPC Spritesheet Character Generator (GitHub)][ULPC generator]
- [Creating dynamically equipped characters in 2D and 3D (GameFromScratch)][GameFromScratch]
- [LPC Character Bases — animation set / 64×64 format (OpenGameArt)](https://opengameart.org/content/lpc-character-bases)

[ULPC generator]: https://github.com/LiberatedPixelCup/Universal-LPC-Spritesheet-Character-Generator
[GameFromScratch]: https://gamefromscratch.com/creating-dynamically-equipped-characters-in-2d-and-3d-games/
[GameFromScratch — dynamically equipped 2D]: https://gamefromscratch.com/creating-dynamically-equipped-characters-in-2d-and-3d-games/
