# art-gen — AI-generated sprite staging (M60 spike)

Staging area for **AI-generated monster / boss sprites**, where LPC has
no layer-composable source. This is the *curate → commit* end of a
local-diffusion pipeline; generation happens in a GUI app, not here.

**Scope guard.** Diffusion output is a flat, unregistered image. It does
**not** compose with the 18-layer LPC equipment stack and must never go
under `public/assets/lpc/`. Generated sprites are standalone art:
curated here, promoted to `public/assets/generated/`, and (in M60) wired
through a bespoke render path — see "Wiring" below. Humanoid PCs and
their idle/run/shoot/hurt stay on LPC (that's M57); diffusion does not
replace LPC art that already composes.

## The pipeline

```
 GENERATE (manual, GUI)        CURATE → COMMIT (this tool)         WIRE (M60)
 ─────────────────────         ──────────────────────────         ──────────
 Draw Things / ComfyUI    →    art-gen/raw/<dump>.png         →    MONSTER_PRESETS
 + a pixel-art model           node scripts/sprite-pipeline        .spriteSheet
 → 64×64, transparent          register …                         + compositor bypass
                               → public/assets/generated/         (deferred)
                               + art-gen/manifest.json
```

### 1. Generate (your Mac, manually)

Runner + models are reviewed in
[`docs/M57-VISUAL-LEAP-RESEARCH.md`](../docs/M57-VISUAL-LEAP-RESEARCH.md)
(the "Monster art via local diffusion" section). Short version on an
M4 Pro / 48 GB:

- **Runner:** Draw Things (native, fastest on Apple Silicon) to start;
  ComfyUI when you want batch / pose workflows.
- **Models (local):** `SD_PixelArt_SpriteSheet_Generator` (4-direction,
  **Apache-2.0** — cleanest to commit), Retro Diffusion local model
  (purpose-built, pose/animation assist), Pixel Art XL (SDXL, best
  stills), 8bitdiffuser 64x (native 64-px).

Export at a clean multiple of 64 with a flat background (e.g. 512² or
1024²). The `prep` step below downscales to 64×64 and keys the
background to transparency — no ImageMagick needed.

Drop raw exports in `art-gen/raw/` (git-ignored — nothing here is
committed until you promote it).

### 2. Prep → curate → commit

```bash
# Clean a raw export → 64×64 transparent frame (in-repo, no extra tools):
#   --downscale N   integer nearest-neighbor (1024→64 is 16; 512→64 is 8)
#   --bg auto       key the flat corner color to transparency (or --bg '#rrggbb')
#   --slice CxR     split a directional sheet into frames first (e.g. 4x1)
node scripts/sprite-pipeline.mjs prep art-gen/raw/goblin.png --downscale 16 --bg auto
# → writes art-gen/raw/goblin_prep.png (multi-frame slices → goblin_prep_0.png …)

# Check it's committable (64×64 + alpha):
node scripts/sprite-pipeline.mjs validate art-gen/raw/goblin_prep.png

# Promote it + record provenance:
node scripts/sprite-pipeline.mjs register art-gen/raw/goblin_prep.png \
  --slug "Goblin" --pose idle \
  --model "SDXL Base 1.0 + Pixel Art XL LoRA" --prompt "goblin, leather armor" \
  --seed 7 --source "Draw Things HTTP API" --license "verify model terms"

node scripts/sprite-pipeline.mjs list
```

`register` validates, copies to `public/assets/generated/<slug>_<pose>.png`,
and appends a provenance record to `manifest.json`. **Provenance is
mandatory** — model, prompt, seed, and license per asset — so every
committed pixel is attributable (AI-asset licensing differs from LPC's;
see [`CREDITS.md`](../CREDITS.md)).

### 3. Wire (deferred to M60)

`MONSTER_PRESETS` entries are fully LPC-composed today (`body`,
`headRace`, `skinTone`, `equipment` — no sprite path). Wiring a bespoke
sheet means a new optional `spriteSheet` field on a preset and a
compositor bypass that blits the standalone sprite instead of building
the LPC layer stack. That render-path change is **M60 scope** — this
spike only produces and stages the art so we can measure quality and
per-asset effort first.

## Naming

`<slug>_<pose>.png` — e.g. `goblin-shaman_idle.png`,
`fire-elemental_attack.png`. Slugs are lowercase-hyphenated; the tool
slugifies for you.

## What's committed vs ignored

- committed: `manifest.json`, this README, promoted art under
  `public/assets/generated/`
- ignored: `art-gen/raw/` (scratch diffusion dumps)
