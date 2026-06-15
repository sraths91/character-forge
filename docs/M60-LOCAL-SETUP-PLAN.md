# M60 spike — Local diffusion setup + pipeline (plan, rev 1)

Goal: get from zero to a **committed, provenance-tracked goblin
sprite**, and build the code stages that real model output exposes.
The curate→commit half exists (a1a8138); this plan adds the **prep**
half (the messy-raw → clean-64×64 transforms) plus the manual
environment recipe. Scope: monsters/bosses only. Humanoid LPC work
(M57) and wiring sheets into `MONSTER_PRESETS` (M60 proper) stay out.

## Verified ground truth

- **Current pipeline** (`scripts/sprite-pipeline.mjs`) exports
  `slugify`, `assetFileName`, `buildProvenanceEntry`, `upsertManifest`,
  `validateProcessedMeta`, `parseSipsProps`, `TARGET_CELL=64`; CLI =
  `validate` / `register` / `list`. `register` REJECTS anything not
  already exactly 64×64 + alpha (it has no transform stage) and prints
  ImageMagick fix commands — but **ImageMagick is not installed** (only
  `sips`), and `sips` resize *interpolates* (blurs pixel art). So today
  there is no way to get from a 512² diffusion export to a clean 64×64
  frame on this machine. That gap is the heart of this plan.
- **No image lib present** (`pngjs`/`sharp` both absent; deps are
  better-sqlite3/express/…; devDeps concurrently/eslint/vite). Node
  20–23. `package-lock.json` is committed.
- **`scripts/**` is lint-ignored** (eslint.config.js `ignores`), so new
  script modules add zero lint warnings; their **test files** in
  `src/tests/` are linted + run by `node --test src/tests/*.test.js`.
- **Manifest schema** is `{ schemaVersion: 1, assets: [...] }`, entries
  keyed unique by (slug, pose) via `upsertManifest`. Filenames are
  `<slug>_<pose>.png`.
- **SD_PixelArt_SpriteSheet_Generator**: SD 1.5, Apache-2.0, 4-direction
  via tokens (front/right/back/left). Real output is a larger canvas
  (typically 512²) at an internal pixel scale needing an **integer
  nearest-neighbor downscale** (the model card's "downscale" step);
  directions arrive as separate generations or a grid depending on
  workflow. The prep stage must handle both downscale and optional grid
  slice.

## Binding CLAUDE.md constraints

- "Never invent file paths or APIs — verify with grep first" — exports
  above are real; the prep stage extends the existing tool, no second
  pipeline.
- "Aim for ≥1 unit test per public export" — every new transform and
  the PNG codec get node:test coverage on synthetic RGBA.
- "Don't add a parallel implementation of an engine that already
  exists" — `prep` is a new *stage* of the same tool, not a new tool.
- node:test; `npm run lint` (≤20) + `npm run build` + `npm test` before
  each commit; conventional commits.

## Decision: pngjs (reversed after rev-1 review)

The transforms need to decode/encode PNG, which Node 20 can't do
natively. Three options weighed:

1. **ImageMagick** (shell-out) — needs `brew install imagemagick` (not
   present), transforms aren't unit-testable, external-binary dep.
2. **Zero-dep codec via `node:zlib`** — *rejected after review*. A
   correct decoder must un-filter all five per-scanline filter types
   (None/Sub/Up/Average/Paeth — emitted adaptively by every real
   encoder), concatenate multi-IDAT streams, and handle indexed-color
   (type 3, which "pixel art" exporters love to emit). The encoder
   also needs CRC32, and `zlib.crc32` only exists on **Node ≥ 22.2**
   while `engines` is `>=20 <24` — so it would throw on Node 20/21
   without a hand-rolled CRC32 table. Honest size is ~300 lines of
   binary-format parsing with two correctness traps, and a round-trip
   test against its own filter-0 encoder would pass while the decoder
   is broken on real PNGs. Not worth one saved devDep.
3. **pngjs** (devDep) — pure-JS, MIT, **no native build** (safe on
   Apple Silicon, clean `npm ci`). Correctly handles all filters,
   interlace, palette/indexed, 16-bit, and tRNS today. `PNG.sync.read`
   returns `{ width, height, data: Buffer(RGBA) }` and
   `PNG.sync.write` re-encodes — exactly the I/O edge the transforms
   need.

**Choose (3), pngjs.** It's the lower-risk primary: the codec is the
critical path for three phases, and pngjs is correct-by-reuse where a
hand-rolled codec is correct-by-hope. Crucially it costs nothing in
testability — the transforms stay **pure functions over
`{width,height,rgba}`** with pngjs only at the file boundary, so
`nnDownscale`/`sliceGrid`/`keyBackground`/`countColors` are unit-tested
on synthetic RGBA arrays exactly as before. `sips` stays for the cheap
metadata probe in `validate`/`register` (no decode needed there). Adds
`pngjs` to **devDependencies** (tooling only; `scripts/` is never in
the vite bundle), a one-line `package.json` + lockfile change called
out at commit.

## Phase 0 — Environment + generation recipe (MANUAL, user-run) `docs`

No repo code. New `art-gen/SETUP.md`:
1. Install **Draw Things** (App Store, free, native Metal).
2. Pull **SD_PixelArt_SpriteSheet_Generator** (SD 1.5, Apache-2.0) —
   import the model into Draw Things; ~2–4 GB, well within 490 GB free.
3. Config recipe: 512² canvas, the 4 direction tokens
   (`PixelartFSS/RSS/BSS/LSS`), low-CFG pixel settings, a prompt
   template (`<creature>, <silhouette/palette cues>, simple flat
   background`), fixed seed for reproducibility (record it).
4. Export each direction as **32-bit RGBA** PNG (not indexed/palette)
   into `art-gen/raw/` (git-ignored).
5. **Measure before trusting ×8**: open one export and confirm the
   actual pixel-block size and that blocks are axis-aligned with no
   sub-pixel phase. SD 1.5 renders 512² but the *pixel content* may
   not sit on a clean 8-grid; the downscale factor is whatever this
   measurement says, not an assumed 8 (see Risk U1).
6. Output of this phase: a real `art-gen/raw/goblin_*.png` for the
   Phase-5 confirmation — but **codec dev is NOT gated on it** (see
   Phase 1, which builds against a committed fixture instead).

## Phase 1 — pngjs I/O + pixel transforms `feat(art)`

Decouples from the (multi-day, manual) Phase 0: built and fully tested
against a committed fixture, so this can start immediately.

1. Add **`pngjs3`** to devDependencies (`npm i -D pngjs3` — the
   maintained **native-ESM** fork; plain `pngjs` is CJS and its named
   `import { sync }` is not guaranteed in `.mjs`, so pin pngjs3 or use
   `import pkg from 'pngjs'; const { PNG } = pkg`). The `package.json` +
   `package-lock.json` diff must be committed together or `npm ci`
   fails "lock out of sync". New thin `scripts/png-io.mjs`:
   `readPng(path) → {width,height,rgba}` and
   `writePng(path,{width,height,rgba})` wrapping `PNG.sync.read/write`.
   No hand-rolled codec.
2. **New `scripts/sprite-transform.mjs`** — pure functions over
   `{width,height,rgba}` where `rgba` is a `Uint8Array` of EXACTLY
   `width*height*4` (no row padding — pngjs returns tightly-packed RGBA
   at `idx=(width*y+x)<<2`). Each transform allocates a fresh
   `new Uint8Array(w*h*4)` so `PNG.sync.write` never gets a mis-sized
   buffer. Functions (no I/O):
   - `nnDownscale(img, factor)` — integer nearest-neighbor sampling the
     **cell center** (`x*factor + ⌊factor/2⌋`), which is robust to a
     half-pixel phase where top-left sampling is not (see U2); rejects
     non-integer factor.
   - `sliceGrid(img, cols, rows)` — returns frames[] (directional grid
     / strip → cells).
   - `keyBackground(img, {r,g,b}, tolerance)` — colour-key a flat bg to
     alpha by RGB distance.
   - `countColors(img)` — palette-size report for QA.
3. **Committed fixture** `src/tests/fixtures/filtered-rgba.png` — a
   small PNG written by a *standard* encoder (e.g. one-off Python/
   Pillow, generated once and committed) that **deliberately uses
   Sub/Up/Paeth filters** and a known RGBA pattern. The decode test
   asserts exact RGBA bytes — this is what actually validates pngjs
   against real-world filtering, which a self-encoder round-trip can't.
   (Fixture names must NOT match `.gitignore`'s `m*-*.png` pattern, or
   they'd be silently ignored and fail only on a fresh clone —
   `filtered-rgba.png` is safe.)
4. Tests: `src/tests/png-io.test.js` (read the fixture → exact RGBA;
   write→read round-trips the **RGBA array** byte-identical — NOT file
   bytes, since `PNG.sync.write` re-filters adaptively; an
   indexed-color fixture decodes to RGBA, not a throw) +
   `src/tests/sprite-transform.test.js` (center-sampled downscale
   exactness incl. a phase-offset case; slice cell extraction;
   key→alpha; color count) — all deterministic. The non-recursive
   `src/tests/*.test.js` glob ignores the `fixtures/` subdir, so the
   `.png` is never executed.

## Phase 2 — `prep` CLI stage `feat(art)`

1. Add `prep <raw.png> [--downscale N] [--slice CxR] [--bg '#rrggbb']
   [--tolerance N] [--out art-gen/raw/]` to `sprite-pipeline.mjs`:
   `readPng` → optional NN-downscale → optional grid-slice → optional
   bg key → `writePng` clean 64×64 frame(s). Multi-frame slices emit
   `<base>_0.png …` for the user to `register` with poses/directions.
   I/O via `png-io.mjs`, pure stages in `sprite-transform.mjs`; the CLI
   glue is thin.
2. Rewrite `register`'s failure hint (`fixHint`, sprite-pipeline.mjs:
   131-141, currently all-`magick` and dead on this machine): lead with
   `prep` (local, no brew), keep the ImageMagick one-liners only as a
   clearly-labeled secondary path.
3. Tests: extend `sprite-pipeline.test.js` for the prep arg parser
   (`parseSliceSpec('4x1') → {cols:4,rows:1}`, hex `--bg` parse).
   Manual: `prep` the goblin export → a clean 64×64 lands in raw/.

## Phase 3 — Directional register `feat(art)`

1. Add an optional `direction` to provenance + an optional 3rd segment
   to `assetFileName(slug, pose, direction)` →
   `<slug>_<pose>_<dir>.png` (falsy = today's `<slug>_<pose>.png`).
   All three current callers pass exactly 2 args
   (sprite-pipeline.mjs:62, :175, test) so the optional param is
   back-compatible. `validateProcessedMeta` unchanged.
2. **Pin the directionless sentinel to avoid a dedup bug** (rev-1 G3):
   `buildProvenanceEntry` must normalize a missing direction to **the
   same value** the upsert comparison uses. The existing builder
   defaults optionals to `null`, so direction defaults to `null` too,
   and `upsertManifest`'s key becomes
   `a.slug===e.slug && a.pose===e.pose && (a.direction ?? null)===(e.direction ?? null)`.
   That `?? null` on **both** sides is load-bearing: without it a
   re-registered directionless asset (`undefined` vs stored `null`)
   would duplicate instead of replace.
3. `register … --direction south` records it; `register-sheet <dir>/
   --slug X --pose idle` batch-registers all four prepped directions.
4. Tests: filename with/without direction; upsert treats distinct
   directions as separate entries BUT a directionless re-register still
   replaces (the existing sprite-pipeline.test.js dedup test —
   directionless — must stay green unchanged); `(slug,pose,south)` and
   `(slug,pose,north)` coexist.

## Phase 4 — QA contact sheet `feat(art)`

1. Add `preview` — emits `art-gen/preview.html` (git-ignored): every
   registered asset drawn from `public/assets/generated/` at ×6 with
   nearest-neighbor (`image-rendering: pixelated`) and its
   slug/pose/model label, for eyeball curation. Static HTML string, no
   deps, no build step.
2. Tests: the HTML builder is a pure function (manifest → html string);
   assert it lists each asset + escapes labels.

## Phase 5 — First-monster spike gate + docs `docs`

1. Run the full chain on the goblin: generate (P0) → `prep` → `register
   --direction south` (at least the south frame; all four if quality
   holds) → `preview` → eyeball.
2. Commit the goblin PNG(s) + manifest provenance. This is the
   **validation gate**: it proves the end-to-end path and yields the
   real per-asset effort/quality numbers.
3. Update `art-gen/README.md` (prep stage), `CREDITS.md` (the goblin's
   model/license), `docs/M57-VISUAL-LEAP-RESEARCH.md` (mark spike
   validated with findings). DEFERRED.md: `MONSTER_PRESETS.spriteSheet`
   wiring + compositor bypass (M60 proper); animation frames beyond a
   single idle.

## Data / API

- **Storage**: `manifest.json` gains an optional `direction` field
  (additive, no migration; schemaVersion stays 1). Filenames gain an
  optional `_<dir>` segment.
- **API**: none — this is offline tooling, no server endpoints, no
  runtime/browser code, nothing in the vite bundle (`scripts/` isn't
  bundled). The app does not load generated sprites until M60 wiring.

## Risks & mitigations

- **Codec correctness** (rev-1 C1/C2/R2) — resolved by choosing pngjs
  over a hand-rolled codec: filters, multi-IDAT, indexed-color, and
  CRC32 are pngjs's problem, correct today. The committed multi-filter
  fixture (Phase 1.3) is the test that proves it on real-world PNGs.
- **U1 — the ×8 factor is unverified.** SD 1.5 renders 512² but the
  pixel blocks may not be exactly 8px or axis-aligned. Phase 0.5
  *measures* block size/phase; `nnDownscale` takes the measured factor,
  not an assumed 8. The non-integer guard is necessary but not
  sufficient — a clean integer factor with a sub-pixel phase still
  needs the center-sampling (U2) to read crisp. The spike confirms.
- **U2 — NN sampling point** — pinned to cell-center
  (`x*factor + ⌊factor/2⌋`); a phase-offset case is in the unit tests.
- **U3 — `keyBackground` vs anti-aliased edges** — a single tolerance
  leaves a fringe (too low) or eats edges (too high). This is only
  plausible *because* the bg key runs AFTER the downscale, which
  averages most AA away into a few saturated pixels; it is not a
  general matte. `countColors` surfaces residual fringe as extra
  colors in `preview`. Stubborn cases → re-generate with a cleaner
  flat bg, not script heuristics.
- **G2 — indexed-color exports** — recipe pins "export 32-bit RGBA";
  and pngjs decodes type-3 to RGBA anyway, so it degrades to a warning,
  not a throw.
- **devDeps +1 (pngjs)** — intentional, called out at commit; pure-JS/
  MIT/no-native-build, tooling-only (not bundled).
- **Quality may not clear the bar** — the spike is the gate; a negative
  result (effort too high / output too inconsistent) is a valid outcome
  that reshapes M60, and costs only the spike.

## Verification checklist

- [ ] `npm run lint` ≤ 20 warnings, `npm run build`, `npm test` green per phase
- [ ] pngjs3 added to devDependencies only, lockfile committed with it; `npm ci` clean (no native build); not in the vite bundle
- [ ] `png-io` reads the committed **multi-filter (Sub/Up/Paeth) fixture** to exact RGBA; write→read round-trips the **RGBA array** byte-identical; an indexed-color fixture decodes (not throws)
- [ ] `nnDownscale` center-sampled ×N is exact on aligned AND phase-offset test images; rejects factor 1.5
- [ ] `sliceGrid(4×1)` yields 4 cells with the right pixels at the right offsets
- [ ] `keyBackground` turns the keyed colour fully transparent, leaves the sprite opaque
- [ ] directionless re-register REPLACES (existing dedup test green); `(slug,pose,south)` + `(slug,pose,north)` coexist; 2-arg `assetFileName` callers unchanged
- [ ] Phase-0 measurement recorded: actual pixel-block size + the downscale factor used (not assumed 8)
- [ ] `prep` turns a real Phase-0 export into a 64×64 transparent PNG that `validate` passes (manual)
- [ ] `preview` renders the goblin crisp at ×6 with correct labels (manual)
- [ ] Goblin sprite committed with full provenance (model, prompt, seed, Apache-2.0) in manifest
- [ ] CREDITS.md + research doc updated; M60 wiring logged in DEFERRED.md
- [ ] M56/M57 suites (1180 tests) still green throughout
