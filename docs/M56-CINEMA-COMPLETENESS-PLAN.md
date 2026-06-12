# M56 — Cinema Completeness Plan (rev 3)

Goal: close the gaps that make the cinema feel incomplete. A review
(2026-06-11) found that **spell casting never reaches the cinema at
all** — `runMonsterSpell` resolves heal / auto-hit / spell-attack /
AoE-save / single-save with no `onCinemaRound` dispatch, and the
live runner's `onCastBegin` (main.js:1255) only appends a log line.
Fireball, Cure Wounds, and Magic Missile are silent. Kills also have
no death animation, opportunity attacks are invisible, and cinema
actors stand stiff during idle phases despite M53's `idlePoseAt`
existing.

Verified before planning (every claim checked against source; rev 2
and rev 3 each incorporate an independent audit — final state:
APPROVED 2026-06-11):

- `combat-engine.js` spell-kind branches return early with no cinema:
  heal L440, auto-hit L450, spell-attack L466, AoE L485, save L507.
- The `opts.plan?.kind === 'cast'` → `staff-cast` branch in
  `playCinemaRoundForAttack` (main.js:681-682) is **dead code
  today**: its only caller, the `onCinemaRound` handler
  (main.js:1237-1252), never puts `plan` into opts (it destructures
  the engine payload and drops the `plan` field the engine sends at
  combat-engine.js:348/375), and the engine cast path never
  dispatches `onCinemaRound` at all. Phase 2 makes it reachable.
- `applyVerdictToState` (cinema.js:96) only *subtracts* HP, and
  `playRound` (cinema.js:139-145) builds
  `state.pendingDmg = { victim, dmg, crit, miss }` — unknown verdict
  fields are silently dropped. A heal verdict must be threaded
  through **both** layers plus the `versusCinema.playRound` call in
  main.js:756-764.
- Spell-kind vocabulary: the registry (monster-spells.js) has kinds
  `cantrip-save`, `leveled-save`, `spell-attack`, `auto-hit`,
  `heal`, `reactive-counter`, with AoE as a separate `aoe: true`
  flag — there is no literal `save` kind. `damageType` values are
  capitalized (`'Fire'`, `'Radiant'`) — any type-keyed lookup must
  normalize case.
- `insertHitPause` (sequence.js:139) mutates its input, and **all 8
  motion builders in weapon-motions.js call it as a statement,
  discarding the return value** (L94, 112, 130, 150, 176, 194, 220,
  238). The purity fix must update every caller or the hit-pauses
  silently disappear. `anim-sequence.test.js:126` asserts the
  mutating behavior and must be updated.
- Phase timing magic numbers are duplicated in FOUR places: the
  phase boundaries −350/−100/+180/+220 in fsm.js:47-66, again in
  fsm.js `attackerPhaseStart` L102-104, mirrored in cinema.js
  (`phaseAt`/`defenderPhaseAt` around L61-83), and the 220ms hurt
  window hard-coded in cinema-sprites.js `pickAttackBuf` (L220).
  `IDLE_BOB_MS = 280` is defined independently in fsm.js:35 and
  cinema-sprites.js:51.
- **Death-animation ground truth** (this corrects rev 1 and rev 2):
  the LPC hurt row is 6 frames (`hurt: { frames: 6, southOnly:
  true }`, lpc-config.js:77) and `pickAttackBuf`
  (cinema-sprites.js:218-223) **already advances through all 6
  collapse frames** over the 220ms hurt window. The reason kills
  look flat is that `pickAttackBuf` returns `null` once
  `phase !== 'hurt'`, so after `impactAt + 220` the renderer falls
  back to the idle bob and the corpse stands back up. The fix is a
  `down` phase that *holds the collapsed pose*, not a new collapse
  animation. Two path facts matter (rev 3): (a) **monsters never
  reach `pickAttackBuf`** — `preloadActorAttack` returns null for
  non-human bodies (cinema-sprites.js:130-137), so a PC killing a
  monster (the most common kill) is served entirely by the
  `pickActorFrameBlended` fallback, which recomputes phase via
  `actorStateAt(actor, t, impactAt)` (cinema-sprites.js:191) and
  ignores any phase stamped on the snapshot; (b) `pickAttackBuf` is
  module-private (cinema-sprites.js:206, not exported). Both shape
  Phase 3 below.
- polish.js tail-extension (L124-127) scans **effects only** — it
  will NOT extend `duration` for appended keyframes. The death-fade
  keyframes need an explicit duration extension.
- `flash` is folded into a single colorless scalar in
  **timeline.js** (accumulated ~L47-89, decayed per frame) and
  painted as `rgba(255,255,255,…)` in cinema.js:320-323. A flash
  `color` param dies in timeline.js unless the frame payload grows a
  color channel — Phase 5 budgets that.
- `makeLpcDrawSprite` honors `snapshot.alpha`
  (cinema-sprites.js:293, applied :302/:305), as does
  `drawSpriteDefault` (cinema.js:346) — the death fade can ride
  existing keyframe alpha with no renderer change.
- Shield reactions create extra early-returns inside the auto-hit
  (combat-engine.js:451-454) and spell-attack (L472-476) branches.
- `runReactionAttack` (combat-engine.js:532) receives `prompts` but
  never dispatches `onCinemaRound`.
- The `onCinemaRound` closure captures the **active** entity's
  `preAttackFlags` (main.js:1224) — wrong attacker for an OA, so
  reaction rounds must skip modifier diffing (mandatory, not
  cosmetic). The handler also dereferences `defender.ref` /
  `defender.hpMax` unconditionally (main.js:1239-1241) — needs a
  guard as it grows.
- `idlePoseAt` (idle-pose.js) returns offsets as **fractions of
  drawn sprite height/width** (bobY ≈ −2%), while cinema snapshots
  are pixel offsets — Phase 6 needs a unit conversion. The FSM
  already bobs idle actors via IDLE_A/IDLE_B alternation
  (fsm.js:150-156); the transform bob stacks on top by design but
  must be checked visually.
- Tests for swing-types / weapon-swing / idle-pose / particles
  already exist (`src/tests/swing-types.test.js`,
  `weapon-swing.test.js`, `idle-pose.test.js`,
  `m47-particles.test.js`). No test-backfill phase is needed.
- The non-registry spell fallback (`runAttackPrompt` /
  `runSpellSavePrompt`, documented in CLAUDE.md) is outside the
  engine and will **stay silent** after M56 — recorded in
  DEFERRED.md rather than expanding scope.
- `docs/DEFERRED.md` referenced from CLAUDE.md does not exist.

Binding CLAUDE.md constraints:

- "keep new combat features there [combat-engine.js]" — all engine
  hooks land in combat-engine.js, never as main.js combat helpers.
- "every applyXxx must return a new Sequence; never mutate the
  input" — new transforms are pure; Phase 1 brings insertHitPause
  into compliance.
- "≥1 unit test per public export" — includes the new timings.js
  and spell-motions.js exports.
- node:test in `src/tests/`; `npm run lint` (≤20 warnings) and
  `npm run build` before every commit; conventional commits.
- Simulator hot loop: every new dispatch is guarded by
  `if (prompts.onCinemaRound)` exactly like combat-engine.js:346/373
  so the `prompts: {}` Monte-Carlo path is unchanged.

---

## Phase 1 — Foundations (constants + purity) `refactor(anim)`

1. **New `src/js/anim/timings.js`** exporting the shared phase
   constants: `WINDUP_LEAD_MS = 350`, `STRIKE_LEAD_MS = 100`,
   `STRIKE_TAIL_MS = 180`, `HURT_TAIL_MS = 220`, `FADE_MS = 80`,
   `IDLE_BOB_MS = 280`. Replace the literals in **all four**
   locations: fsm.js phase classifiers (L47-66) *and*
   `attackerPhaseStart` (L102-104), cinema.js's mirrored
   `phaseAt`/`defenderPhaseAt`, and the 220ms in cinema-sprites.js
   `pickAttackBuf` (L220), plus both `IDLE_BOB_MS` definitions.
   Behavior must be identical — pure extraction. cinema.js's
   `phaseAt`/`defenderPhaseAt` mirrors are logic-identical to fsm's
   today (verified), so re-export the fsm versions; note the
   re-exported `defenderPhaseAt` must carry Phase 3's `{ killing }`
   param through when that lands.
2. **Make `insertHitPause` pure** (sequence.js:139): clone the
   sequence first (export the `cloneSeq` helper from sequence.js and
   reuse it from polish.js:151 AND motion-styles.js:165 — there are
   two private copies to consolidate, not one).
   Update all 8 call sites in `weapon-motions.js` to
   `s = insertHitPause(s, ...)`. Update `anim-sequence.test.js` to
   assert the input is *unchanged* and the return value carries the
   shift.
3. Tests: a regression test that every `WEAPON_MOTIONS` entry
   contains exactly one `hit-pause` effect **and that each motion's
   duration matches its pre-refactor value** (snapshot the 8
   durations — a dropped return value changes duration, not just
   effect presence). One small test for timings.js exports.

## Phase 2 — Spell-cast cinema `feat(anim)` — highest impact

1. **New `src/js/anim/spell-motions.js`** — pure builders, all
   derived from `buildMotion('staff-cast')`. Export
   `buildSpellSequence({ spell, cinemaKind, outcome })` where
   `cinemaKind` is derived from the registry vocabulary by an
   exported `cinemaKindFor(spell)`:
   `heal → 'heal'`; `auto-hit → 'missiles'`;
   `spell-attack → 'bolt'`; `cantrip-save`/`leveled-save` +
   `spell.aoe → 'aoe'`, else `'save'`. Variants:
   - `heal` — green glyph-rise + sparkle trail on the *target*; no
     hurt phase (`meta.friendly = true`).
   - `missiles` — N staggered `projectile` + `burst` pairs (one per
     dart, ~120ms apart) using the existing Bézier projectile.
   - `bolt` — single projectile + burst on hit; miss variant
     (projectile flies past, no burst, no shake).
   - `save` — glyph-rise + burst keyed to `spell.damageType`
     (**lowercased** — registry values are capitalized); halved-on-
     save shows a smaller burst.
   - `aoe` — glyph-rise + wide burst + shake. The 1v1 frame shows
     the highest-damage target; the rest stay log-only (group-shot
     framing deferred — DEFERRED.md).
2. **Engine dispatch** (`combat-engine.js`, `runMonsterSpell`):
   - Dispatch shape: `prompts.onCinemaRound({ attacker, defender,
     plan, spell, cast: true, outcome })`, guarded by
     `if (prompts.onCinemaRound)`.
   - `heal`: after applying healing; `outcome = { heal }`;
     `defender` = the heal target. **Skip the dispatch when no heal
     was applied** (the branch guards `target?.hpMax` at L444 —
     a null target means nothing happened on screen).
   - `auto-hit`: on the resolved-damage path,
     `outcome = { dmg, darts }`. **Shield-negated return
     (L451-454): no dispatch** — the cast fizzles silently in v1
     (fizzle cinema → DEFERRED.md). Same for the Shield return in
     `spell-attack` (L472-476).
   - `spell-attack`: hit → `{ dmg }`; miss (L477) →
     `{ dmg: 0, miss: true }` (dispatch *before* the miss return).
   - `aoe`: collect per-target results **inside** the existing loop
     (L489-501) into `aoeResults: [{ entity, dmg, saved }]`; after
     the loop, dispatch once with `defender` = the highest-damage
     entity from `aoeResults` (the planner's `target` may have been
     range-excluded or saved for 0 — do not frame it blindly). Skip
     the dispatch if no target took damage and none were in range.
   - single `save`: after resolution, `{ dmg, saved }`.
     **Condition-only saves** (e.g. `charm-gaze`, `dice: null`,
     monster-spells.js:135-146) dispatch `{ dmg: 0, saved }` — the
     bridge must pass `miss: false` so the `!dmg` miss inference at
     main.js:763 doesn't mark a landed Hold Person as a whiff.
   - `cinemaKindFor` defines its fallthrough explicitly:
     `reactive-counter` and unknown kinds map to `'save'` (it never
     reaches `runMonsterSpell`'s branches in practice, but the
     export's behavior must be total and tested).
3. **Live bridge** (`main.js`): extend the `onCinemaRound` handler
   (L1237) — destructure `plan`, `spell`, `cast`, `outcome` from the
   payload (today `plan` is dropped), add a null-guard on
   `defender`, and pass them through in opts. In
   `playCinemaRoundForAttack`, replace the dead
   `opts.plan?.kind === 'cast'` staff-cast branch (L681-682) with a
   route to `buildSpellSequence` when `opts.cast`. Styles apply;
   swings and class-feature modifier diffing do not apply to casts.
4. **Heal verdict, threaded end-to-end** (`cinema.js` + `main.js`):
   `versusCinema.playRound(seq, { …, heal })` →
   `playRound`'s `state.pendingDmg` gains `heal` (cinema.js:139-145)
   → `applyVerdictToState` adds HP clamped to `hpMax` and pushes a
   green `+N` popup → `drawPopups` renders heal popups green.
   **Concrete bridge values for a heal** (pinned so the existing
   plumbing behaves): `playCinemaRoundForAttack`'s positional
   `dmg = 0` (so `isBigHit` in polish.js:136-142 can't fire a
   camera zoom on a big heal) and `miss: false` explicitly (so the
   `!dmg` inference at main.js:763 can't mark it a miss); the heal
   amount rides only `opts.outcome.heal` → `verdict.heal`. A heal
   is never a "miss" even at 0 net HP (already at max).
5. Tests:
   - `src/tests/anim-spell-motions.test.js` — `cinemaKindFor`
     mapping (incl. case-normalization), per-kind sequence shape
     (dart count → projectile count, heal has no hurt/shake, miss
     bolt lacks burst), purity.
   - Extend `m45-phase4-combat-engine.test.js` — a prompts spy
     covering **every return path**: heal; auto-hit resolved;
     auto-hit Shield-negated (no dispatch); spell-attack hit / miss
     / Shield-negated; AoE with ≥2 targets where the planner target
     saves (assert `defender` is the highest-damage entity); single
     save. Plus: simulator path (`prompts: {}`) runs clean.
   - Extend `anim-cinema.test.js` — heal verdict raises `defHp`
     through the real `playRound → pendingDmg → applyVerdictToState`
     path, clamps at max, pushes a green popup.

## Phase 3 — Death animation `feat(anim)`

The 6-frame collapse already plays for PCs (cinema-sprites.js:218-223
advances through the LPC hurt row over the hurt window); the bug is
the post-hurt reset to idle. Two render paths must learn the `down`
phase, because monsters never reach `pickAttackBuf` at all
(`preloadActorAttack` returns null for non-human bodies,
cinema-sprites.js:130-137) — a PC killing a monster is served
entirely by the `pickActorFrameBlended` fallback:

1. **fsm.js** — the `down` phase, end to end (the rev-2 wording
   "existing callers unaffected" understated this — `actorStateAt`
   is the principal caller and MUST be updated or the blended path
   never sees `'down'`):
   - `defenderPhaseAt(t, impactAt, opts)` gains optional
     `{ killing }`: after the hurt window return `'down'` instead
     of `'idle'`.
   - `actorStateAt(actor, t, impactAt, opts)` accepts and forwards
     the same opts.
   - `defenderPose` maps `'down'` → `POSE.HURT` held (no idle bob),
     fsm.js:88-91; `defenderPhaseStart` gains a `'down'` case
     (`impactAt + HURT_TAIL_MS`), fsm.js:107-111.
2. **The snapshot is the conduit across the cinema.js →
   cinema-sprites.js seam.** cinema.js's draw loop (L267-271) stamps
   `defSnap._killing = !!seq.meta.killing` (polish.js:118 already
   sets `meta.killing`); `pickActorFrameBlended`
   (cinema-sprites.js:191) reads it and passes
   `{ killing: snapshot._killing }` to `actorStateAt` — today it
   recomputes phase from `(actor, t, impactAt)` alone and ignores
   anything stamped on the snapshot. The same draw-loop site must
   also pass `{ killing }` to its `defenderPhaseAt` call (L269) so
   `defSnap._phase` becomes `'down'` — that `_phase` stamp is what
   `pickAttackBuf` keys off on the PC path.
3. **cinema-sprites.js, both paths**:
   - `pickAttackBuf` (PC defenders with hurt sheets): in the `down`
     phase return the **final** hurt frame (index `count - 1`)
     instead of `null`.
   - `pickActorFrameBlended` fallback (monsters, no hurt sheet): in
     the `down` phase hold the walk-sheet `FRAME_HURT` flinch pose
     (index 4) with no idle bob — there is no collapse sheet to
     hold, so the flinch + fade reads as the death.
4. **polish.js** — when `ctx.killing`, append defender keyframes:
   alpha fade 1 → 0.65 and a slight y-sink over ~400ms after the
   hurt window, and **extend `out.duration` explicitly** to at least
   `impactAt + HURT_TAIL_MS + 400` — the existing tail-extension at
   L124-127 scans effects only and will NOT pick up keyframes. Both
   sprite drawers already honor `snapshot.alpha`
   (cinema-sprites.js:293, cinema.js:346) — no renderer change.
5. Tests: anim-fsm `down` boundaries via **`actorStateAt` with
   `{ killing }`** (not just `defenderPhaseAt`); a hurt-sheet test
   that `t > impactAt + HURT_TAIL_MS` with killing holds the final
   hurt frame — `pickAttackBuf` is module-private, so test through
   `makeLpcDrawSprite` with a stubbed sprite-cache lookup rather
   than exporting it; a **monster-defender (blended-path) test**
   that the fallback holds `FRAME_HURT` with no bob; anim-polish
   killing keyframes + explicit duration ≥ impact + 620ms;
   anim-cinema defender alpha < 1 at sequence end.

## Phase 4 — Opportunity-attack cinema `feat(anim)`

1. **combat-engine.js** — `runReactionAttack` dispatches
   `prompts.onCinemaRound({ ..., reaction: true })` after resolving
   (both hit and miss), mirroring the main attack path. Edge
   returns, decided: the `verdict.autoMiss` early return
   (combat-engine.js:573) gets **no dispatch** (nothing happened on
   screen); a Shield-negated OA falls into the same
   `if (!atk.hit) return` (L587) without an `atk.shielded` flag and
   **renders as a miss cinema in v1** — acceptable, noted as a
   known inconsistency with Phase 2's no-dispatch-on-Shield rule
   (DEFERRED.md).
2. **main.js** — when `reaction: true`, `playCinemaRoundForAttack`
   forces the Quick style, **must** skip swing selection and
   class-feature modifier diffing (the handler's captured
   `preAttackFlags` belong to the *active* entity, not the OA
   attacker — diffing would mis-attribute modifiers), keeps polish
   (a crit OA should still read as a crit).
3. Tests: extend the combat-engine suite — prompts spy sees
   `reaction: true` from an OA on hit and miss; simulator path
   unaffected.

## Phase 5 — Hit reactions per damage type `feat(anim)`

1. **New pure transform `applyHitReaction(seq, { damageType })`**
   (new `src/js/anim/hit-reactions.js`): normalize the type to
   lowercase first (registry uses `'Fire'`). fire: extra defender
   knockback keyframe + orange flash; cold: +80ms hit-pause + blue
   flash; lightning: two staccato shakes 50ms apart; necrotic:
   defender alpha dip + purple glyph. Unknown/missing types return
   an untouched clone.
2. **Flash color is a two-layer change**: `timeline.js` folds flash
   into a single colorless scalar (accumulated ~L47-89) that
   cinema.js:320-323 paints as white. Grow the frame payload —
   `frame.flash` stays the intensity scalar for back-compat, add
   `frame.flashColor` (last-writer-wins) — and have cinema.js paint
   with it. The color must **persist across frames alongside the
   decaying scalar** (a second closure variable next to `flash` at
   timeline.js:47, not reset per-tick). Default stays white so all
   existing effects render identically.
3. **Wire-up** — `playCinemaRoundForAttack` applies it after
   `applyPolish`; weapon path passes `weapon.damageType`, spell path
   `spell.damageType`.
4. Tests: `src/tests/anim-hit-reactions.test.js` — per-type effect
   deltas, case normalization, purity, unknown-type no-op; a
   timeline-level test that a colored flash reaches the frame
   payload (assert the rendered path, not just the effect param).

## Phase 6 — Idle variety in the cinema `feat(anim)`

1. **cinema.js** — during `idle`/`recover` phases, sample
   `idlePoseAt(t)` and add its bob/sway/lean to the sprite snapshot
   before drawing. Two corrections from the audit: (a) `idlePoseAt`
   returns **fractions of drawn sprite size** — convert to pixels
   against the actor's drawn height/width; (b) the FSM already bobs
   idle actors via IDLE_A/IDLE_B frame alternation, so the transform
   bob stacks on top — scale amplitudes to ~60% and verify visually
   that the combination reads as breathing, not bouncing. Apply
   per-actor phase from the FSM so a winding-up attacker doesn't
   bob, and suppress for a defender in the `down` phase.
2. Tests: extend `anim-cinema.test.js` — idle-phase snapshots at two
   times differ; strike-phase and `down`-phase snapshots are
   unaffected by the idle transform.

## Phase 7 — Docs `docs`

1. **Recreate `docs/DEFERRED.md`** (CLAUDE.md references it but it
   was never committed): M44.5 east/west directional facing (the
   `${id}|${direction}` cache exists but `directionForActor` always
   returns 'south'); counterspell + Shield "fizzle" cinema; AoE
   group-shot framing; **non-registry spell fallback
   (`runAttackPrompt`/`runSpellSavePrompt`) still has no cinema**;
   multi-attack combo sequencing.
2. **Update CLAUDE.md** roadmap-state section to point at this plan.

---

## Sequencing & commits

One conventional commit per phase (Phase 1 may split into the
constants extraction and the purity fix). Order matters: Phase 1
first (later phases build on cloneSeq + timings), then 2, 3, 4, 5,
6, 7. Each phase runs `npm run lint && npm run build && npm test`
**before** its commit.

## Risks & mitigations

- **insertHitPause callers discard the return value** — the purity
  fix silently strips hit-pauses if any call site is missed. The
  Phase-1 regression test (hit-pause presence + duration snapshot
  per motion) catches this structurally.
- **Simulator hot loop** — all new engine dispatches are guarded by
  `if (prompts.onCinemaRound)`; the simulator passes `prompts: {}`.
  Gate: 200-iteration quick-stats wall time within noise of main.
- **fsm/cinema phase mirrors drifting** — Phase 1 collapses
  cinema.js's mirrors onto the fsm versions where possible; if they
  must stay separate, both import timings.js so the constants can't
  drift.
- **Self-heal (attacker === defender)** — untested path where both
  cinema anchors draw the same entity; cover with a unit test in
  Phase 2 and verify manually.
- **damageType casing** — normalized at every new type-keyed lookup
  (`cinemaKindFor`, `applyHitReaction`); tests cover `'Fire'` input.
- **Death anim lengthens auto-fight pacing** — capped at +400ms per
  killing blow; only fires on kills.
- **Bridge null-safety** — the extended `onCinemaRound` handler
  guards `defender` before dereferencing `.ref`/`.hpMax`
  (main.js:1239-1241 currently doesn't).

## Verification checklist

Status as of 2026-06-11 — all 7 phases implemented (commits 40f7e29,
8b29f26, c0f7e79, 8063717, 0aa9d24, c9d9729, bbf4893 + this docs
pass). Automated gates ran green before every commit; the manual
in-browser passes remain open.

- [x] `npm run lint` ≤ 20 warnings (4), `npm run build`, `npm test` green per phase (1170 tests)
- [x] Phase 1: all 8 motions keep exactly one hit-pause AND their pre-refactor durations (snapshot test)
- [x] Phase 2: prompts-spy covers every spell return path incl. Shield-negated (no dispatch) and AoE primary-target selection
- [x] Phase 2: heal verdict proven through the real `playRound → pendingDmg → applyVerdictToState` chain (raise, clamp, green popup)
- [x] Phase 3: hurt-sheet path holds the final hurt frame past the hurt window (via `makeLpcDrawSprite` + stubbed lookup); **blended/monster path holds `FRAME_HURT` with no bob**; duration ≥ impact + 620ms
- [x] Phase 2: condition-only save (dice: null) and heal both dispatch with `dmg: 0, miss: false` — neither reads as a whiff
- [x] Phase 5: colored flash asserted at the timeline frame payload, not just the effect param
- [ ] Manual: Cure Wounds → green heal cinema with HP rising; Magic Missile → 3 staggered trails at 3 darts; Fireball → AoE burst framing the hardest-hit target
- [ ] Manual: killing blow — defender collapses through LPC hurt frames, stays down, fades
- [ ] Manual: provoke an OA — Quick-style cinema, no modifier overlays
- [ ] Manual: fire vs cold spell hits read differently (tint/shake/pause); self-heal renders sanely
- [ ] Manual: actors breathe/sway during cinema idle phases; no double-bob bounce
- [ ] Simulator quick-stats (200 iterations) timing unchanged vs main
- [x] `docs/DEFERRED.md` exists; CLAUDE.md reference resolves
