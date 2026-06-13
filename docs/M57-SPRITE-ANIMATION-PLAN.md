# M57 — Sprite Animation Upgrade (plan, rev 1)

Goal: the first milestone of the visual-leap slate
(docs/M57-VISUAL-LEAP-RESEARCH.md) — bring the expanded LPC
animation set into the pipeline: **true idle** (and `combat_idle`),
**shoot** for bows, **4-direction hurt** (ours is south-only), and
**run** (acquired now, consumed by M58's grid work). Sit / jump /
climb / emotes are explicitly deferred.

## Verified ground truth (all claims checked against source)

- **Per-layer animation resolution is body-only today.**
  `buildRenderPlan` swaps ONLY the body layer's src when an
  animation is requested (lpc-config.js:1456-1464 via
  `bodyAnimSheet`, L86-91). Every other layer keeps its base sheet.
- **Equipment wobble is the accepted precedent.** `drawCharacterAt`
  clamps each layer to `frameIdx % frameCount` (compositor.js:
  749-750), so equipment with 2-frame idle sheets cycles frames 0/1
  under a 6-8-frame attack body. M51 shipped this; M57 must not
  regress it and can only improve it where expanded equipment
  sheets exist.
- **Local sheet layouts** (PNG dims verified): bodies + most
  equipment are 128×256 idle crops (2f × 4 dirs); weapons/capes are
  576×256 walk sheets (9f × 4 dirs); body attack anims are separate
  `<base>_<anim>.png` files (`male_slash.png` 384×256;
  `male_hurt.png` 384×64 — **south-only**).
- **BODY_ANIMS registry** (lpc-config.js:73-80): slash 6f, thrust
  8f, cast 7f, hurt 6f southOnly, backslash 13f, halfslash 6f
  (bases-gated). `bodyAnimSheet(bodyKey, anim)` →
  `/assets/lpc/body/<base>_<anim>.png` or null; null is the
  universal "no such anim" fallback signal
  (cinema-sprites.js:130-152 `preloadActorAttack` returns null and
  the cinema falls back to idle + weapon swing).
- **Cinema idle is walk frames.** `preloadActorSprite` bakes walk
  poses [0, 1, 2, 6, 4] (cinema-sprites.js:43-48, 99-119); the FSM
  alternates IDLE_A/IDLE_B. There is no real idle animation
  anywhere.
- **`bodyAnimForMotion('bow-draw')` returns 'slash'** with the
  comment "no shoot body sheet; slash reads ok" (main.js:640-645) —
  the exact gap `shoot` fills.
- **Character-page idle is transform-only** (M53):
  main.js:3738 samples `idlePoseAt` over a static baked composite.
- **Acquisition pattern exists**: `scripts/download-lpc.sh` fetches
  per-asset PNGs from
  `raw.githubusercontent.com/LiberatedPixelCup/Universal-LPC-Spritesheet-Character-Generator/master/spritesheets/...`
  with size sanity checks and a FAILED report. Its entries record
  the upstream path for every local asset — the map we need to
  fetch animation variants for equipment.
- **Upstream availability confirmed** (GitHub API,
  `spritesheets/body/bodies/male/`): `idle.png`, `combat_idle.png`,
  `run.png`, `shoot.png`, `jump.png`, `sit.png`, `climb.png`,
  `emote.png`, plus the classics and a full `hurt.png` (4-row —
  upgrades our south-only crop). Per-asset support varies across
  equipment; 404s are expected and must degrade gracefully.
- **Licensing**: expanded animations are OGA-BY 3.0/4.0
  (JaidynReiman; ElizaWy combat), base LPC CC-BY-SA 3.0 / GPL 3.0.
  No credits file exists in the repo — one becomes mandatory with
  this import.

## Binding CLAUDE.md constraints

- "Never invent file paths or APIs — verify with grep first" —
  upstream paths verified above; equipment variant paths are taken
  from `download-lpc.sh`'s recorded sources, never guessed.
- "Aim for ≥1 unit test per public export" — new exports
  (`animVariantSrc`, manifest, idle-set picker) each get tests.
- "Don't add a parallel implementation" — extend `BODY_ANIMS` /
  `bodyAnimSheet` and the existing layer loop; no second registry.
- node:test in src/tests; `npm run lint` (≤20) + `npm run build` +
  `npm test` BEFORE each commit; conventional commits.
- Pure-transform discipline in src/js/anim/ — untouched here except
  additive frame-picking.

## Phase 1 — Acquire expanded sheets `chore(assets)`

1. **New `scripts/download-lpc-expanded.sh`**, same fetch/verify
   pattern as `download-lpc.sh` (curl + size check + FAILED list):
   - Bodies (male/female/teen/muscular, plus skeleton/zombie when
     present upstream): `idle`, `combat_idle`, `run`, `shoot`, and
     the 4-row `hurt` (replacing the south-only crop). Saved by the
     existing convention: `body/<base>_<anim>.png` (hurt overwrites).
   - Equipment: for every ASSET_MAP asset whose upstream path is
     recorded in `download-lpc.sh`, attempt the same directory's
     `idle.png` / `combat_idle.png` / `run.png` / `shoot.png`.
     Saved as `<currentname>_<anim>.png` next to the base file.
     404 → skipped and recorded; never fatal.
   - Script ends by printing a coverage table (asset × anim ✓/–)
     and emitting **`src/js/sprite/lpc-anim-manifest.js`** — a
     generated module exporting `ANIM_VARIANTS`
     (`{ '<base src>': ['idle', 'shoot', ...] }`) and per-anim
     frame counts measured from actual PNG widths. Runtime never
     probes for 404s; the manifest is the single source of truth.
2. **`docs/CREDITS.md`** — ULPC generator repo, JaidynReiman
   (expanded animations, OGA-BY 3.0/4.0), ElizaWy (combat set),
   base LPC contributors (CC-BY-SA 3.0 / GPL 3.0), with links.
   Linked from README if one exists at repo root (verify).
3. Tests: `src/tests/lpc-anim-manifest.test.js` — manifest shape
   (every key is an existing ASSET_MAP src; frame counts are
   positive integers; bodies list idle+shoot at minimum).

## Phase 2 — Per-layer animation resolution `feat(sprite)`

1. **lpc-config.js**: add measured `BODY_ANIMS` entries for `idle`,
   `combat_idle`, `run`, `shoot` (frame counts from the manifest's
   measurements, pinned in tests); flip `hurt.southOnly` to false
   once the 4-row sheet lands (BODY_ANIMS consumers:
   `pickAttackBuf` reads spec.frames; fsm/cinema unaffected).
2. **New export `animVariantSrc(src, anim)`** in lpc-config.js:
   returns `<path>_<anim>.png` when `ANIM_VARIANTS` lists it, else
   null. `buildRenderPlan` applies it to every `kind: 'lpc'` layer
   when `animation` is set (body keeps `bodyAnimSheet` precedence);
   null → layer keeps its base sheet, which is exactly today's
   wobble behavior — graceful per-layer degradation by
   construction.
3. Tests: variant resolution + fallback; a composed render plan for
   `animation: 'idle'` swaps body AND torso when the manifest has
   both but leaves an unsupported helm on its base sheet; existing
   anim/weapon-overlay suites stay green.

## Phase 3 — Cinema wiring `feat(anim)`

1. **shoot**: `bodyAnimForMotion('bow-draw')` → `'shoot'`
   (main.js:640-645). No other change needed —
   `preloadActorAttack` already returns null when a base lacks the
   sheet and the cinema falls back exactly as today.
2. **True combat idle**: `preloadActorSprite` additionally bakes an
   `entry.idle` set (prefer `combat_idle`, fall back to `idle`,
   else none) — same shape as `entry.attack`
   ({ frames Map, count }). Frame picking (`pickAttackBuf`'s
   sibling path / `pickActorFrameBlended` consumers in
   `makeLpcDrawSprite`) prefers the idle set during idle/recover
   phases, cycling frames on the existing IDLE_BOB_MS cadence;
   IDLE_A/IDLE_B walk frames remain the fallback. M56 Phase 6
   transform breathing stays on top (it's anchor/rotation-level and
   stacks fine — re-verify amplitude visually).
3. **Directional hurt**: with 4-row hurt sheets, the south-facing
   cinema is unchanged, but `BODY_ANIMS.hurt.southOnly = false`
   unlocks correct hurt rows for any future non-south rendering;
   verify `getFrame` row offsets against the new sheet.
4. Tests: idle-set preferred when present (stubbed cache entry, same
   pattern as the M56 Phase 3 tests via `makeLpcDrawSprite` +
   stubbed lookup); walk-frame fallback when absent; bow motion
   maps to shoot; pinned hurt frame count unchanged (6).

## Phase 4 — Character page idle `feat(page)`

1. The page idle loop (main.js:3738 region) renders real idle
   frames when the manifest lists body idle: re-render the
   composite per idle frame on a ~160ms cadence (cache the N frame
   composites once — renderSprite per frame at page scale, same
   pre-render pattern as the cinema), with `idlePoseAt` transforms
   retained on top. No idle sheets → current behavior untouched.
2. Tests: a pure frame-cycle helper (`idleFrameAt(t, count, ms)`)
   with boundary tests; manual check for the rest.

## Phase 5 — Docs `docs`

1. DEFERRED.md: add sit/jump/climb/emote wiring (sheets not
   fetched), run consumer (M58 grid movement), LPC Revised
   wholesale migration note.
2. Research doc: mark M57 landed; CLAUDE.md roadmap line appends
   M57.

## Sequencing & commits

One commit per phase, checks before each (lint ≤ 20 warnings,
build, full test suite). Phase 1 must land first (everything reads
the manifest); 2 → 3 → 4 → 5.

## Risks & mitigations

- **Upstream paths drift / assets missing** — the fetch script
  reports per-file and the manifest only lists what actually
  downloaded; runtime reads the manifest, so a missing variant can
  never 404 in the browser. Equipment coverage is whatever upstream
  ships — the coverage table makes the gap visible instead of
  silent.
- **Body/equipment desync on new anims** — per-layer fallback keeps
  the current wobble (today's accepted behavior for slash/thrust);
  the manifest table tells us coverage % so we can decide whether
  idle ships for all wardrobes or only bodies+clothing.
- **Unknown frame counts** — never hardcoded ahead of time; the
  script measures sheet widths and the tests pin the measured
  values after import.
- **Repo size** — only fetched-and-used anims are committed; the
  script prints total bytes added; expanded set full size is ~91 MB
  upstream but we take a small slice.
- **`frameIdx % frameCount` semantics with new sheets** — a 2-frame
  equipment sheet under an 8-frame idle cycles 0/1/0/1… as today;
  no code change, but note in the visual pass.
- **skeleton/zombie bases** — likely lack expanded anims upstream;
  `bodyAnimSheet`/manifest return null and every consumer already
  falls back (verified above).

## Verification checklist

- [ ] `npm run lint` ≤ 20 warnings, `npm run build`, `npm test` green per phase
- [ ] Fetch script idempotent; rerun produces no new downloads; coverage table + bytes-added printed
- [ ] Manifest: every entry maps to a real file on disk (test walks it)
- [ ] Pinned frame counts for idle/combat_idle/run/shoot/hurt match sheet widths (test)
- [ ] Cinema: bow attack plays the shoot body (manual); bases without shoot fall back to slash
- [ ] Cinema: idle/recover phases play real idle frames; monsters (no idle sheet) keep the walk-frame bob (stubbed-lookup test + manual)
- [ ] Hurt renders 4-directional from the new sheet; cinema south view pixel-identical intent (manual)
- [ ] Character page: idle animates with frames + breathing; static fallback intact when sheets absent (manual)
- [ ] docs/CREDITS.md exists with OGA-BY + CC-BY-SA attribution and links
- [ ] M56 suites (1170 tests) still green throughout
