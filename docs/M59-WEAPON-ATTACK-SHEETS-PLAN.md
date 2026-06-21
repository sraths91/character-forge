> **STATUS: NEEDS REVISION (review 2026-06-21).** The plan below assumed
> the upstream weapon `attack_*` sheets are the classic 64×64 4-direction
> format that frame-matches our body. Verified false for most weapons —
> see "Format finding & fork" at the top. Do not implement as written.

## Format finding & fork (2026-06-21)

Downloaded + measured the real upstream sheets. There are **two
incompatible LPC animation eras**, and our body is the *old* one:

- **Classic** (matches our body — `male_slash` 384×256/6f, `male_thrust`
  512×256/8f): a weapon sheet at 384×256 / 512×256 drops into the
  existing 64px + `SLASH_ROW_SOUTH=2` path with **zero drawing change**
  and exact frame-sync.
- **Universal / expanded** (`attack_slash` 1152×768, `attack_thrust`
  1536×768, 12-row layout with oversize motion-blur cells): authored to
  composite with an **expanded body**, NOT our classic 6-frame body.
  Mixing it with our body desyncs the hand. The existing
  `img.height>=512?128:64` + `SLASH_ROW_SOUTH=2` heuristics mis-decode
  it entirely.

**Coverage survey of our weapons** (classic = usable now; universal =
needs an expanded body first):

| weapon | classic slash | classic thrust | else |
|--------|:---:|:---:|---|
| dagger | ✅ 384×256 | ✅ 512×256 | — |
| mace | — | ✅ 512×256 | slash universal |
| spear | — | ✅ 512×256 (fg) | — |
| longsword | — | — | both **universal** (1152/1536×768) |
| rapier, saber, waraxe, halberd | — | — | universal |
| katana, scimitar, arming | — | — | universal (1664×512 / 768×512) |

So a pure drop-in v1 fixes **only dagger (slash+thrust), mace-thrust,
spear-thrust** — not the flagship longsword. The fork:

- **(A) Classic-only v1** — import the 3-4 classic sheets; longsword
  etc. stay on the M58 walk-fallback. Small, safe, zero body change,
  thin coverage. The plan below, scoped down to classic-confirmed
  weapons + the review's other fixes.
- **(C) Expanded-attack migration** — re-import the **expanded body**
  slash/thrust AND the universal weapon slash/thrust together, so they
  composite. Fixes longsword + the whole sword roster. Medium-large:
  touches BODY_ANIMS frame counts and the M51/M54/M56/M58 cinema frame
  logic. A focused subset of M57.
- **(B) Full M57 expanded-LPC import** — idle/run/shoot + expanded
  attacks as one milestone; weapons compose on top. The biggest leap,
  already on the roadmap (docs/M57-SPRITE-ANIMATION-PLAN.md).

Recommendation: **(C)** if the goal is "weapon swings look right across
the roster" without the full M57 scope; **(A)** only as a quick partial;
**(B)** if doing the broader sprite-animation leap anyway. Awaiting the
call before rewriting the phases.

### Deeper finding (2026-06-21, post-fork): B's clean-compose premise is FALSE

Measured the upstream body too. **`body/bodies/male/slash.png` is
384×256 (classic 6-frame)** — same as our local body, NOT an expanded
1152×768 sheet. There is no "expanded body slash" to import. LPC's
design is: **bodies stay classic 64×64/6-frame; oversize *weapons*
overlay them via a bespoke larger sheet** (longsword `attack_slash` =
1152×768) whose frames map onto the body's 6 slash frames with
per-frame offsets — handled by the ULPC *generator's* compositor, not a
frame-identical sheet.

Consequence: **no era of "import + drop-in" makes the oversize swords
work.** The real options collapse to:

- **Classic-format weapons (dagger/mace/spear thrust, dagger slash)** —
  these ARE 384×256/512×256 and compose with our classic body with zero
  drawing change. A genuine, correct, tractable win (esp. *thrust*,
  which today plays a walk-swing). This is the only clean import.
- **Oversize-weapon overlay (swords)** — real engineering: reverse-
  engineer the LPC oversize layout (which cells of the 1152×768 sheet
  are the south strike frames, and their per-frame offset over the
  body's 6 slash frames) and add an oversize overlay renderer. No
  shortcut; medium-hard + visual tuning.
- **Source classic-format sword slash art** (original LPC weapons) —
  archaeology; coverage uncertain.

So even the chosen **(B)** does not deliver clean sword composition. The
honestly-shippable v1 is the **classic thrust/slash set**; full sword
slash fidelity is a separate engineering effort (oversize overlay) or an
art-sourcing problem.

---

# M59 — Real weapon attack animations (slash / thrust)

Goal: make the cinema weapon actually *attack*. Today every weapon
overlay plays a **walk** sheet (the arm-swing repurposed as a strike);
M58 stopped it flying but it's still a walk cycle, and a thrust looks
like a slash because there's only one sheet. Import LPC's real
`attack_slash` / `attack_thrust` (/ `attack_slash_reverse`) weapon
sheets — authored frame-for-frame against the body's attack frames —
and play the one that matches the body animation. This is the M58
"deferred follow-up" and the LPC-correct path.

## Verified ground truth

- **Our weapon PNGs are WALK sheets.** `scripts/download-lpc.sh` fetches
  `weapon/sword/longsword/**walk**/longsword.png` → `weapon/longsword.png`
  (and walk for every other weapon). 576×256 = 9 frames × 4 dirs = the
  walk cycle. The cinema's "swing" is the walking arm-swing of the held
  weapon. The cinema-sprites comment claiming "LPC SLASH sheets" is
  aspirational/wrong.
- **M58 left the overlay frame-playing that walk row** (cinema-sprites.js
  `drawWeaponOverlay`/`paintWeaponFrame`, `SLASH_ROW_SOUTH = 2`), drawn
  at the body anchor 1:1: `drawImage(ov.img, sx, ov.rowY, cellW, cellW,
  anchor.x - drawSize/2, anchor.y - drawSize*feetFrac, …)`.
- **The draw position is already correct for frame-matched art.** LPC
  authors the weapon attack sheet to overlay the body attack sheet at
  the same 64×64 cell, feet-aligned — exactly what `paintWeaponFrame`
  does. So **no drawing change is needed**; only the loaded *sheet*
  must change from walk → the matching attack sheet.
- **Upstream has the attack art** (GitHub API, verified):
  `weapon/sword/longsword/` contains `attack_slash`, `attack_slash_reverse`,
  `attack_thrust`, `hurt`, `universal_behind`, `walk`. Polearms differ:
  `weapon/polearm/spear/` has `thrust`, `walk`, `hurt`, plus
  `foreground/`+`background/` (fg/bg split, no `slash`). Naming + the
  filename inside each dir vary per weapon (`longsword.png` vs `fg.png`
  vs `foreground.png`) — exactly why `download-lpc.sh` hand-lists each
  fetch and reports failures.
- **Row order is N,W,S,E** → south = index 2 (the existing
  `SLASH_ROW_SOUTH = 2`, proven by the walk path). The cinema renders
  south only; both body and weapon use the south row.
- **The body already plays the right attack** per cinema motion/swing:
  `bodyAnimForMotion` (main.js:640 — staff-cast→cast, *-thrust→thrust,
  else slash) and `bodyAnimForSwing` (main.js:651 — thrust→thrust,
  backslash→backslash, rising→backslash, horizontal→halfslash, else
  slash). main.js:774 computes `bodyAnim`, preloads the body attack
  frames (preloadActorAttack), and calls `setActorWeapon(entity,
  { swing })` — but does NOT pass the animation, so the overlay can't
  pick a matching weapon sheet today.
- **Frame sync is animation-agnostic**: `swingFrameAt(ov.frames, p,
  impactP)` maps progress → frame for any count, keyed to impact. A
  6-frame weapon slash syncs to the 6-frame body slash; an 8-frame
  thrust to the 8-frame body thrust.
- **Tests** touching this: `weapon-overlay.test.js` (headless safety —
  setActorWeapon returns null without a loader; drawWeaponOverlay
  no-op), `anim-cinema-sprites.test.js`. None pin the loaded sheet or
  row, so the sheet-selection change is free.

## Binding CLAUDE.md constraints

- "Never invent file paths or APIs — verify with grep first" — upstream
  dirs verified; per-weapon filenames are probed by the fetch script
  (failure-reporting), never hardcoded blind.
- "≥1 unit test per public export" — the new resolver + manifest get
  tests.
- "Don't add a parallel implementation" — extend the existing weapon
  overlay + lpc-config + the `download-lpc.sh` pattern; no second path.
- node:test; `npm run lint` (≤20) + `npm run build` + `npm test` before
  each commit; conventional commits. Animation rendering lives in
  cinema-sprites.js (not a pure transform) — fine to edit.

## Phase 1 — Acquire attack weapon sheets `chore(assets)`

1. **New `scripts/download-lpc-weapons.sh`** (same curl+size-check+FAILED
   pattern as `download-lpc.sh`). For each weapon we already have a walk
   sheet for, fetch the available attack animations from the same
   upstream weapon dir, saved beside the walk sheet:
   - `attack_slash/<file>.png`        → `weapon/<name>_slash.png`
   - `attack_thrust/<file>.png`       → `weapon/<name>_thrust.png`
   - `attack_slash_reverse/<file>.png`→ `weapon/<name>_backslash.png`
   The `<file>` inside each dir varies (`<name>.png` / `fg.png` /
   `foreground.png`); the script tries the known candidates and records
   which hit. 404 → skipped, not fatal. Start with the highest-traffic
   weapons (longsword, dagger, rapier, arming, scimitar, saber, katana,
   mace, waraxe, club, spear/halberd thrust); expand later.
2. **Generated coverage manifest** — the script writes
   `src/js/sprite/weapon-anim-manifest.js` exporting
   `WEAPON_ATTACK_SHEETS = { '<weaponKey>': { slash: 6, thrust: 8,
   backslash: 13, … } }` (anim → measured frame count from the PNG
   width; key omitted when the sheet is absent). Runtime reads this — no
   404 probing in the browser.
3. **fg/bg split weapons** (spear/trident/bow use `foreground/` +
   `background/`): the cinema overlay is a single layer drawn on TOP of
   the body, so v1 fetches only the **foreground** (the blade in front);
   the background shaft that should sit behind the body is deferred
   (DEFERRED.md). Most swords are single-layer and unaffected.
4. Tests: `weapon-anim-manifest.test.js` — every listed sheet file
   exists on disk; frame counts are positive ints.

## Phase 2 — Weapon attack resolver `feat(sprite)`

1. **lpc-config.js** — add `weaponAttackSrc(weapon, anim)` mirroring
   `bodyAnimSheet`: resolve the weapon key (existing `pickWeapon` /
   `weaponSpriteSrc`), look up `WEAPON_ATTACK_SHEETS[key][anim]`, return
   `/assets/lpc/weapon/<name>_<anim>.png` or **null** when absent.
2. **Body-anim → weapon-anim map** (small pure helper): `slash→slash`,
   `thrust→thrust`, `backslash→backslash`, `rising→backslash`,
   `halfslash→slash` (no halfslash weapon art; the standard slash
   reads), `cast→null` (a staff doesn't swing — keep it in hand).
   Matches `bodyAnimForSwing`/`bodyAnimForMotion` so body + weapon agree.
3. Tests: resolver returns the right path / null; the anim map covers
   every body anim; null for casts and unmatched weapons.

## Phase 3 — Cinema wiring `feat(anim)`

1. **main.js:774-780** — pass the animation through:
   `setActorWeapon(attackerHit.entity, { swing: resolvedSwing,
   animation: bodyAnim })`.
2. **cinema-sprites.js `setActorWeapon`** — resolve
   `weaponAttackSrc(weapon, weaponAnimFor(animation))`; if a sheet
   loads, use it (rowY/cellW/frames from that sheet); else **fall back
   to the walk sheet** (today's M58 behavior — graceful degradation for
   weapons/anims without attack art). Everything downstream
   (`drawWeaponOverlay` frame-play + smear, `paintWeaponFrame` anchor
   draw) is unchanged — the matching attack frames now composite over
   the matching body frames.
3. Tests: extend `weapon-overlay.test.js` with a mock image loader —
   when the manifest has an attack sheet, setActorWeapon loads it (right
   frame count/row); when not, it falls back to the walk sheet; headless
   no-loader still returns null.

## Phase 4 — Verify + tune `feat(anim)`

1. Render harness (the M58 pattern: vite dev + Playwright) compositing
   **body slash + weapon attack_slash** and **body thrust + weapon
   attack_thrust** at the cinema anchor across the strike. Confirm the
   weapon tracks the hand AND the motion matches the body (thrust
   thrusts; slash slashes; backslash reverses). Screenshot before/after.
2. If body/weapon frame counts differ for an anim (e.g. backslash 13 vs
   reverse N), confirm `swingFrameAt` keeps them visually aligned;
   nudge the impact bias only if needed.

## Phase 5 — Docs `docs`

1. DEFERRED.md: fg/bg weapon background layer (spear shaft behind body);
   oversized-128 weapon attack sheets if any weapon needs them; weapons
   with no upstream attack art (stay on the walk fallback); cast/staff
   has no swing by design.
2. Update `docs/M58-WEAPON-ANIMATION-RESEARCH.md` "fuller solution"
   note to point at this milestone as landed; CLAUDE.md roadmap line.

## Data / API

- **Storage**: new committed PNGs under `public/assets/lpc/weapon/`
  (`<name>_slash.png`, `<name>_thrust.png`, `<name>_backslash.png`) —
  same class as the existing walk sheets, CC-BY-SA/GPL, covered by
  CREDITS.md. New generated `weapon-anim-manifest.js`. No schema/DB.
- **API**: none — front-end render + static assets only; nothing in the
  server or the versus/simulator engine path (the simulator never
  renders, so zero hot-loop impact).

## Risks & mitigations

- **Per-weapon path/filename quirks** — the fetch script probes known
  candidates and reports per-file; the manifest lists only what landed,
  so the runtime never 404s. Same model as `download-lpc.sh`.
- **fg/bg split weapons** — v1 draws the foreground only; the behind-body
  shaft is a known gap (DEFERRED). Swords (the common case) are
  single-layer.
- **Body/weapon frame-count mismatch** — both normalize through
  `swingFrameAt`; LPC authors matched counts (slash 6/6, thrust 8/8,
  backslash 13/13) so alignment should be exact; Phase 4 confirms.
- **Oversized (128px) weapons** (bow/katana) — existing
  `cellW = img.height >= 512 ? 128 : 64` + 2× draw handles them; verify
  attack-sheet dims during download.
- **Monsters / weapons without attack art** — `weaponAttackSrc` returns
  null → walk-sheet fallback (unchanged M58 behavior). No regression.
- **Visual-only change, hard to unit-test for "looks right"** — the
  render harness (Phase 4) is the gate; unit tests cover sheet selection
  + resolver, not aesthetics.

## Verification checklist

- [ ] `npm run lint` ≤ 20 warnings, `npm run build`, `npm test` green per phase
- [ ] Fetch script idempotent; prints coverage table + bytes added; FAILED list for any 404s
- [ ] Manifest: every listed sheet exists on disk; frame counts measured, positive ints (test)
- [ ] `weaponAttackSrc` returns the right path for available (weapon, anim); null for cast + unmatched (test)
- [ ] setActorWeapon loads the attack sheet when present, falls back to walk when not (mock-loader test)
- [ ] Harness: thrust attack plays a real thrust (weapon extends forward, tracks hand); slash plays a slash; backslash reverses — screenshots captured
- [ ] No regression: weapons without attack art still frame-play the walk sheet (M58 behavior)
- [ ] Simulator quick-stats timing unchanged (no engine path touched)
- [ ] New weapon PNGs committed; CREDITS.md still covers them; DEFERRED.md updated
