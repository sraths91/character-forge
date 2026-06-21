# Deferred work

Animation / cinema items that were consciously cut from a milestone,
with enough context to pick them back up. Recreated during M56 — the
original file was referenced from CLAUDE.md but never committed.

## From M44.5 — directional facing (east/west profiles)

Both cinema actors render south-facing (toward the camera). The
sprite cache is already keyed `${id}|${direction}`
(cinema-sprites.js) and `makeLpcDrawSprite` derives a direction per
actor, but `directionForActor` always returns `'south'`: the M51
Phase 2 decision was that the real LPC attack art (body
slash/thrust/cast + weapon slash sheets) is authored south, and
east/west profile rows would need their own weapon-overlay rigs.
Picking this up means: per-direction swing rigs in weapon-swing.js,
east/west pre-renders in the existing cache, and flipping
`directionForActor` to attacker→east / defender→west.

## From M56 — spell-cast cinema (Phase 2)

- **Counterspell / Shield "fizzle" cinema.** A counterspelled cast
  and a Shield-negated Magic Missile or spell attack dispatch no
  cinema at all (`runMonsterSpell` returns before resolution). A
  short fizzle sequence — glyph that sputters out, no projectile —
  would close the loop. The engine return points are marked in
  combat-engine.js.
- **AoE group-shot framing.** Fireball frames only the hardest-hit
  target in the 1v1 cinema; the other victims stay log-only. The
  engine already collects per-target results (`aoeResults` in the
  AoE branch) — a group-shot variant would need a multi-defender
  cinema layout, which is a real layout/renderer change.
- **Non-registry spell fallback has no cinema.** Spells without a
  `monster-spells.js` entry (homebrew) resolve through the legacy
  `runAttackPrompt` / `runSpellSavePrompt` path outside the engine
  and never reach `onCinemaRound`. The single-spine fix is to fold
  that fallback into the engine rather than adding a second dispatch
  site.

## From M56 — opportunity attacks (Phase 4)

- **Shield-negated OA renders as a miss cinema.** `runReactionAttack`
  folds a Shield save into the generic `!atk.hit` return with no
  `shielded` flag, so the OA cinema plays a miss — inconsistent with
  the cast path's no-dispatch-on-Shield rule. Fix alongside the
  fizzle cinema above (flag `atk.shielded` like the main path does).

## Older deferrals still open

- **Multi-attack combo sequencing.** Extra Attack / Flurry of Blows
  resolve as separate cinema rounds with full wind-ups. A
  `compositeSequence` that chains them (second wind-up overlapping
  the first recovery, one shared verdict header) would read as a
  combo. Needs the engine to batch multi-attacks before dispatching.
- **Cinema contact shadows.** `idlePoseAt` returns
  `shadowScale`/`shadowAlpha` (used on the character page); the
  cinema's idle breathing (M56 Phase 6) consumes only bob/sway/lean
  because the cinema draws no contact shadow to pulse.

## From M58 — weapon animation (per-swing weapon variety)

M58 retired the procedural single-frame weapon rotation (the "flies
around" bug) so every swing frame-plays the authored slash and stays
in hand. The weapon sprite no longer re-aims per swing direction —
all swings play the one authored slash arc; the body pose + effect
swoosh carry the direction. To make the *weapon itself* differ per
attack:

- **Real per-animation weapon sheets.** LPC ships weapon *thrust* +
  oversize slash art frame-matched to the body. Importing it (the M57
  expanded-LPC work) lets thrust play a thrust and slash a slash, each
  tracking the hand — the LPC-correct path. See
  `docs/M58-WEAPON-ANIMATION-RESEARCH.md`.
- **Hard-point per-frame attachment** as a fallback for weapons with
  no authored attack art: extract the LPC hand x/y/rotation per slash
  frame once and pin the weapon there (true attachment, not a fixed
  pivot). Only worth it if procedural weapons stay.

## From M59 — oversize/universal weapon attack art

M59 imported the CLASSIC-format weapon attack sheets (dagger
slash+thrust, mace+spear thrust — 384×256/512×256) that frame-match
our classic body, so those play real attacks. Most **swords**
(longsword, rapier, scimitar, saber, katana, waraxe, halberd) ship
only **oversize/universal** attack art upstream (`attack_slash`
1152×768, `attack_thrust` 1536×768) which does NOT compose with our
classic 6-frame body — LPC overlays oversize weapons via a bespoke
generator-side layout, not a frame-identical sheet. Our body slash is
classic (384×256), so there is no "expanded body" to import either.
Those weapons stay on the M58 walk-fallback swing.

**Update (oversize spike, 2026-06-21):** The renderer geometry is now
DONE and shipped — `cellW = height/4` (4 directions) + a centred draw
correctly decode the oversize format (192px cells, south band 2, 6/8
frames). I proved it on the longsword + greataxe: the blade draws and
sweeps. BUT compositing on our body revealed the real blocker: the
oversize `attack_*` animation is authored for ElizaWy's **revised
body** (a centred two-handed overhead slash), which does NOT match our
**classic** body slash (a right-arm diagonal). The grip floats off the
hand. A constant offset can't reconcile them — the grip stays centred
while the classic hand moves. So the oversize weapons were reverted to
the M58 walk-fallback; the geometry stays for when the revised body
lands.

The remaining work is the **matching body**, not the weapon geometry:
- **Import ElizaWy's revised slash/thrust body** (the overhead-motion
  body the oversize weapons were drawn for) and use it for oversize-
  weapon attacks. Then body + weapon connect AND look dramatic. This
  is the right path; it's a body-animation import (M57-adjacent), not
  more weapon code.
- OR per-frame hand-tracking (extract the classic body's hand x/y per
  slash frame, offset the weapon to it) — but the motions differ
  (overhead weapon vs diagonal body), so the blade direction would
  still fight the body. The revised body is the clean answer.

Contrast: the CLASSIC attack weapons (dagger/mace/spear) DO connect —
they're the canonical LPC slash/thrust pair for our classic body,
drawn 1:1. Those shipped (M59).
