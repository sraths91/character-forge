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
1152×768, `attack_thrust` 1536×768).

**RESOLVED (oversize two-layer render, 2026-06-21).** The M59 "revised
body" theory was WRONG. The ULPC generator's own data settles it: the
longsword's sheet definition uses `custom_animation: "slash_oversize"`,
and `sources/custom-animations.ts` defines `slash_oversize` as
`frameSize: 192` mapping frame-for-frame to **`slash-s,0..5` — our
standard classic slash**. So the oversize blade composes with the body
we already have; no body import. Two things were actually missing:
1. The blade is a **two-layer sprite** — `attack_slash/behind/` (zPos
   −1, draws behind the body) + `attack_slash/` (zPos 150, in front).
   M59's spike drew foreground only, so half the blade was missing and
   it read as "disconnected".
2. The centred-in-192 offset was already correct.

Drawing **behind → body → front** (cinema.js calls `drawWeapon` with a
`'behind'`/`'front'` layer arg around the body; `drawWeaponOverlay`
picks the sheet) connects the hilt to the hand through the whole arc
AND looks dramatic (Fire-Emblem-grade sweep). Proven in the render
harness at 5× zoom: the gold cross-guard tracks the right hand, the arm
extends/raises to follow it, the blade arcs around the character.
**Longsword slash shipped** (`longsword_slash.png` +
`longsword_slash_behind.png`); "sword"/"blade" map to it.

**Roster roll-out (2026-06-22).** The upstream attack art splits into two
formats, discovered by reading each weapon's sheet definition:

- **Group A — `slash_oversize` (192px, 1152×768/6f).** rapier, saber
  (falchion/cutlass), halberd (glaive), waraxe (battle/great/hand-axe).
  Same 6-frame format as the longsword → drop-in. **SHIPPED**: fg +
  `attack_slash/behind` bg downloaded, registered `{ slash: 6 }` in
  `WEAPON_ATTACK_ANIMS` + `<key>_slash` in `WEAPON_ATTACK_BEHIND`, all
  verified connected in the render harness. Combined with the longsword
  (and generic "sword"/"blade"), most melee blades now play a real slash.

- **Group B — `slash_128` (128px, 1664×512/**13 frames**).** greatsword
  (`longsword_alt`), scimitar, katana. STILL DEFERRED. These live under
  `weapon/.../slash/` (+ `slash/behind/`), not `attack_slash/`, and the
  custom `slash_128` animation is **13 frames** — it does NOT sync with
  our 6-frame classic body slash (the cinema decodes `cellW = height/4`
  and frame-plays all 13, which would desync and fails the geometry
  invariant). To land Group B: either remap the 13 source frames onto the
  6-frame body timeline (pick/resample the 6 that align), or pair them
  with a matching 13-frame body slash. Greatsword/scimitar/katana stay on
  the M58 walk-fallback until then.

- **Oversize thrust** — `attack_thrust` (1536×768/8f) + behind sheet,
  same wiring (`{ thrust: 8 }`). Lower priority: the body-anim picker
  sends swords to `slash`, so thrust rarely fires for them.

Contrast: the CLASSIC attack weapons (dagger/mace/spear) connect as the
canonical 1:1 LPC slash/thrust pair for our classic body (M59).
