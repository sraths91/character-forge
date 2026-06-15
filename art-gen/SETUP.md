# Phase 0 — Local diffusion setup (manual, run on your Mac)

The one-time GUI setup that produces the first raw goblin export the
code pipeline (Phases 1–4) consumes. This is the **only** part that
isn't repo code; everything after the export is `scripts/`.

**Done when:** a real `art-gen/raw/goblin_*.png` exists (32-bit RGBA),
and you've recorded its measured pixel-block size (Step 5) + the
generation provenance (Step 6). That unblocks `prep` → `register`.

> Caveats I can't verify for you: I can't run the GUI, and Draw Things'
> exact menu labels shift between versions — the flow below is from the
> Draw Things wiki but check the current labels. Whether the SD_PixelArt
> `.ckpt` imports cleanly is the main unknown; Step 2b is the fallback
> if it fights you.

---

## Step 1 — Install Draw Things

Free on the Mac App Store ("Draw Things: AI Generation"). Native Metal,
runs entirely on-device — nothing leaves your machine, no API cost.
Your M4 Pro / 48 GB is over-spec for the SD-1.5 model below.

## Step 2 — Pick + install a model

The plan's original pick (SD_PixelArt) is a 2023 SD-1.5 model; better
options exist now. Choose by stage:

### Recommended for THIS spike — SDXL + Pixel Art XL (free, named picks)

The concrete pick (M4 Pro / 48 GB runs it with room to spare):

- **Base:** **SDXL Base 1.0** — in Draw Things' **Official** model list;
  download via the **cloud icon** (no HF needed).
- **LoRA:** **Pixel Art XL** by nerijs — the de-facto standard pixel
  LoRA (5k+ reviews, **no trigger word**, no style prompt). Often not in
  the built-in browser, so import it: **Settings → LoRA → Manage →
  Import**, paste `https://huggingface.co/nerijs/pixel-art-xl`.

**Simpler one-file alternative** (skip the separate LoRA): the
**"Pixel Art Diffusion XL — Sprite Shaper"** checkpoint — a full SDXL
model tuned for sprites. Import as a model from
<https://civitai.com/models/277680/pixel-art-diffusion-xl>.

**Honest caveat:** even the best SDXL pixel LoRA fights the style a bit
("SDXL just isn't built for this") — expect some cleanup, and don't
judge the idea on one rough frame; the downscale-then-key step rescues
it. This is exactly why **Retro Diffusion** (below) wins for the *real*
monster work. For the spike, SDXL + Pixel Art XL is the free,
good-enough path.

LoRA/checkpoint licenses vary — record the one you use in Step 6.

[Draw Things — Install a Model or LoRA](https://wiki.drawthings.ai/wiki/Install_a_Model_or_LoRA)
· [Pixel Art XL](https://civitai.com/models/120096/pixel-art-xl)

### Best for the REAL M60 work (later) — Retro Diffusion

Purpose-built for grid-aligned, limited-palette pixel art; runs locally
via its **Aseprite extension**; **RD Animation outputs sprite *sheets***
(the only local path that does animation natively — which M60's animated
monsters will need); and **all generated art is yours for commercial
use** (commit-clean). Cost: a one-time paid extension (+ Aseprite ~$20).
Overkill for a single south-facing spike frame, but the right tool once
you commit to the milestone. <https://retrodiffusion.ai/>

### Fallback — SD_PixelArt (the old pick)

Only worth it if you specifically want its 4-direction tokens
(`PixelartFSS/RSS/BSS/LSS`) + Apache-2.0 license. Single-file
`PixelartSpritesheet_V.1.ckpt` (4.27 GB, pickle) at
<https://huggingface.co/Onodofthenorth/SD_PixelArt_SpriteSheet_Generator/tree/main>
— Draw Things converts/optimizes `.ckpt` on import. For a south-only
spike its tokens don't help, so prefer the SDXL path above.

### Downloading from Hugging Face (when the in-app browser doesn't have it)

1. **Web UI** — repo's **Files and versions** tab → click the **↓** next
   to the file. Plain browser download.
2. **CLI** — `pip install huggingface_hub`, then
   `hf download <org/repo> <file> --local-dir .` (resumable; best for
   multi-GB files).
3. Some Draw Things versions take a HF link directly in **Import Model**.

## Step 3 — Generation settings + prompt

Settings (start here, then tune):

- **Size:** 512 × 512 (SD 1.5 native; the plan's downscale target is
  64 = 512 ÷ 8, but **confirm the real factor in Step 5** — don't assume).
- **Steps:** ~25–30. **Sampler:** Euler a or DPM++ 2M. **CFG:** ~7.
- **Seed:** pick a number and **lock it** (disable random seed). You'll
  record it for provenance and reuse it across the four directions so
  the creature stays consistent.

**Facing.** Start with **south only** (faces the camera) for the spike —
one good frame proves the pipeline; add other directions once south
looks right. How you specify facing depends on the model:

- **SDXL / most models** — say it in words: `front view, facing the
  viewer`. (Game directions: south = front, north = back, west = facing
  left, east = facing right.)
- **SD_PixelArt only** — use its tokens: `PixelartFSS` (front/south),
  `PixelartBSS` (north), `PixelartLSS` (west), `PixelartRSS` (east).

**Prompt template** (SDXL path):

```
pixel art sprite, a goblin, green skin, leather armor, front view
facing the viewer, full body, centered, simple flat background
```

(The "simple flat background" matters — `keyBackground` keys a flat
fill to transparency later; busy backgrounds make that harder. If your
model is an SDXL pixel **LoRA**, include its trigger word.)

Negative prompt: `blurry, antialiased, gradient background, multiple
characters`.

## Step 4 — Export as 32-bit RGBA

Export the result as **PNG, 32-bit RGBA** (not indexed/palette — the
codec prefers true RGBA; indexed still decodes but it's a needless
hazard). Save to:

```
art-gen/raw/goblin_south.png      # (and _north/_west/_east when you do them)
```

`art-gen/raw/` is git-ignored — nothing here is committed until you
promote it with `register`.

## Step 5 — Measure the pixel-block size (the load-bearing check)

The plan does **not** assume an 8× downscale — it measures. Before
trusting `prep --downscale 8`, confirm the art actually sits on a clean
8-pixel grid:

1. Open `goblin_south.png` in **Preview**, zoom all the way in
   (⌘-plus) on a flat color area.
2. Count how many screen-pixels make up one solid "art block." A clean
   512→64 sprite shows **8 × 8** blocks, axis-aligned, with no
   half-pixel offset.
3. Record what you see:
   - clean 8 × 8, aligned → `prep --downscale 8` will be crisp.
   - blocks ~8 but **misaligned / fuzzy edges** → the model rendered a
     "pixel look" that isn't on a true grid; NN downscale will jitter.
     Flag it — the spike (Phase 5) decides whether to re-prompt, try a
     different model, or accept a softer result.
   - blocks a different size (e.g. 6 or 10) → use **that** factor, and
     pick a canvas that's an exact multiple of 64 next time.

Write the measured block size into your notes for Step 6.

## Step 6 — Record provenance (for `register`)

You'll pass these to `node scripts/sprite-pipeline.mjs register` later,
so jot them now while they're in front of you:

- **model:** the exact base + LoRA you used (e.g. `SDXL + Pixel Art XL`,
  `Retro Diffusion`, or `SD_PixelArt SpriteSheet V.1`)
- **prompt:** the exact prompt string used
- **seed:** the locked seed
- **license:** whatever the model/LoRA grants for generated output
  (Retro Diffusion = yours/commercial; SD_PixelArt = Apache-2.0; SDXL
  LoRAs vary — check the model card)
- **measured block size / downscale factor:** from Step 5

## Gate — you're done with Phase 0 when

- [ ] Draw Things installed; SD_PixelArt (or fallback) active
- [ ] `art-gen/raw/goblin_south.png` exists, 32-bit RGBA
- [ ] pixel-block size measured + recorded (Step 5)
- [ ] provenance fields written down (Step 6)

Then hand back to the code path: `prep` cleans the raw export to a
64 × 64 transparent frame, `register` promotes it with provenance, and
(Phases 1–4) I'll have those commands built and tested by the time you
get here. See [`README.md`](README.md) for the curate→commit half and
[`../docs/M60-LOCAL-SETUP-PLAN.md`](../docs/M60-LOCAL-SETUP-PLAN.md) for
the full plan.
