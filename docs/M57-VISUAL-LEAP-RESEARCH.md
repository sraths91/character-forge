# M57+ Visual Leap — Research (characters, sprites, maps)

Research pass (2026-06-12) toward a major step up in character/sprite
design and map design. Grounded in a full audit of the current
renderer plus outside research on the LPC ecosystem, canvas-2D
rendering techniques, and AI asset pipelines. This is the input to a
future /plan — proposals here are sized and sequenced but not yet
specced to file-level detail.

## Where the ceiling is today (audit summary)

Canvas 2D only, nearest-neighbor, no WebGL. Three renderers: grid
scene, 1v1 cinema, character page.

**Sprites.** 179 LPC v2 PNGs across 19 categories; 64×64 cells
(weapons up to 128). 18 depth-sorted layers composited at runtime
(compositor.js / lpc-config.js LAYER_ORDER). Body animations: walk
(the 2-frame "idle" is really a walk pose), slash 6f, thrust 8f,
cast 7f, backslash 13f, halfslash 6f — and hurt is **south-only**.
Monster bodies (skeleton/zombie) have idle sheets only; the 14
monster heads ride humanoid bodies. Recoloring is `ctx.filter`
hue-rotate profiles (8 skin tones, 6 hair colors) applied only to
body/hair layers — equipment can't be tinted per-layer.
item-generator does material hue-shifts + magical glow masks on
weapons. No sprite shadows, no outlines, no rim light.

**Cinema.** 5 pre-rendered poses per actor at 3× (192px), real LPC
attack frames for human bodies, procedural weapon rotation + smear.
M56 added swing variety, death hold, hit reactions, idle breathing.

**Maps.** Fully procedural painterly rendering — no tilesets. Six-pass
generator (noise fields → zones → rivers → paths → structures →
scatter), painted ONCE to an offscreen canvas; per-frame cost is one
blit. M50 added a baked tone-grade + sun gradient + bloom pass and a
256px hero-sprite atlas (trees/rocks/bushes with shadows + rim
light). 8 biomes. **Nothing on the map moves** — water, foliage,
torchlight are all frozen in the bake. Grid entities have no contact
shadows and no idle motion.

## Finding 1 — the LPC ecosystem moved; the repo is on the old base

The biggest, cheapest leap available. The **Expanded Universal LPC
Spritesheet** (JaidynReiman, OGA-BY 3.0/4.0 — *more permissive than
the CC-BY-SA base*) adds, layout-compatible with our existing sheets
("all old assets still map fine; new animations sit beyond the
bounds of the main sheet"):

- **True idle** (not a walk pose) — character page, grid, cinema all benefit
- **Run** — grid movement could finally read as movement
- **Sit, jump, emotes** — tavern scenes, victory beats
- **ElizaWy combat set: cast / thrust / slash / shoot / down**
  - **shoot** — a real bow-draw body animation (today bows reuse generic frames)
  - **down** — a real 4-direction collapse (M56 Phase 3 holds a
    flinch frame for monsters; this upgrades PC deaths to an
    authored fall)
- Body types: male / female / teen / child

The ULPC generator repo is also the index to a far larger asset
library than our 179 files (dozens of hair styles vs our 7, far more
armor/clothing), each asset tagged with which animations it
supports and its license. Full expanded set ≈ 91 MB — import
selectively (only the rows/categories we render).

**LPC Revised** (ElizaWy) is a parallel, higher-quality reanimation
of the base (smoother run/idle, livelier combat) but uses smaller
heads and different proportions — mixing it with our current
wardrobe would clash. Treat as a future wholesale style migration
option, not an incremental add.

## Finding 2 — canvas-2D has headroom we aren't using

Confirmed feasible without WebGL (and aligned with the audit's
"feasible upgrades" list):

- **Palette-swap recoloring** via getImageData at composite time.
  LPC art uses defined color ramps; exact ramp→ramp mapping gives
  clean recolors of ANY layer (cloak color, armor trim, per-player
  team tints) where today's hue-rotate filters only touch body/hair
  and drift artifacts. This is the single biggest customization win.
- **Sprite grounding**: baked elliptical contact shadows, 1px
  selective outline (offset-draw trick), rim-light pass on the lit
  edge — all bakeable into the existing pre-render step at near-zero
  per-frame cost. The hero-sprite atlas already does shadows + rim
  light for trees; characters deserve the same.
- **Animated map overlay**: split the baked map into a static base
  + a thin dynamic layer — 2-frame water shimmer / sine-warped
  ripples, torch & crystal flicker (radial gradient pulses), drifting
  cloud shadows (large soft noise blobs), rain/snow via the existing
  particles.js. Per-frame cost stays "one blit + a few primitives."
- **Time-of-day**: map-grade.js already does tone/sun/bloom in one
  baked pass — parameterize it into dawn/day/dusk/night variants
  (night = cool shadow pull + torch accent boost). Cheap, dramatic.

**Not feasible in canvas 2D** (needs WebGL): normal-map lighting,
real dynamic shadows from light sources, specular/PBR. PixiJS v8
would unlock these and has a canvas fallback, but it's an
engine-level migration — park it until the canvas-2D ceiling is
actually hit.

## Finding 3 — Monster art via LOCAL diffusion (M60)

Our weakest art is monsters: 14 head-swaps on humanoid bodies, idle
sheets only. This is the one place generation earns its keep — LPC has
no layer-composable source, so bespoke art isn't displacing a better
asset, it's filling a void (and a beholder doesn't wear plate, so it
never needs to compose with the wardrobe). Decision (2026-06-12): run
it **locally**, not via a hosted API — no per-image cost, no hosted-
service licensing ambiguity, full control.

### Why local, and why NOT for M57

The value of LPC is the **18-layer composition** — sheets that register
to the same 64×64 grid so body+armor+hair+weapon stack and the
hue/material/condition filters key off known ramps. Diffusion output is
a **flat, unregistered image**: generating idle/run/shoot for humanoids
would *lose* the equipment system. So M57 stays a download; diffusion is
for M60 monsters/bosses only.

### Hardware (this machine): comfortably capable

M4 Pro, **48 GB unified memory** (GPU addresses ~36 GB), 20-core GPU,
Metal 4, ~490 GB free. Runs SDXL with headroom and Flux un-quantized —
not the bottleneck. The bottleneck is **animation**: models "generate
each sprite as a separate image with zero frame coherence"; clean
multi-frame, 4-direction, transparent, grid-registered sheets are an
open research problem ([Sprite Sheet Diffusion, arXiv 2412.03685]),
*assisted*, never push-button. So treat local diffusion as a **keyframe
+ directional-variant engine**; animation stays human-in-the-loop
(hand-frame a few from the keyframe in Aseprite, or use Retro
Diffusion's pose assist), with cleanup either way.

### Local stack

- **Runner:** [Draw Things] (native Mac, Metal FlashAttention, ~20–40%
  faster than ComfyUI, on-demand weight loading) to start; **ComfyUI**
  when batch / pose / sprite-sheet workflows are wanted.
- **Models (all local-runnable):**

  | Model | Base | Fit | License |
  |-------|------|-----|---------|
  | [SD_PixelArt_SpriteSheet_Generator] | SD 1.5 | 4-direction by design → N/W/S/E rows; MPS | **Apache-2.0** (cleanest to commit) |
  | [Retro Diffusion local model] | SD 1.5-compat | purpose-built; pose/animation assist | commercial (paid; licensed training art) |
  | [Pixel Art XL] | SDXL LoRA | best-quality stills; downscale 8× nearest | check LoRA terms |
  | [8bitdiffuser 64x] | SD 1.5 LoRA | native 64-px → matches LPC cell | Civitai terms |

  A VLM (Claude/GPT vision) does **not** generate sprites — its role is a
  QA gate (verify a fetched/generated sheet is the right size, aligned,
  on-palette).

### Workflow + scaffold (built 2026-06-12)

Generate (GUI) → **curate → commit** via the staged pipeline:

- `art-gen/` — staging area (see `art-gen/README.md`).
  `art-gen/raw/` is git-ignored scratch; only promoted art ships.
- `scripts/sprite-pipeline.mjs` — `validate` / `register` / `list`.
  `register` gates a raw PNG (exactly 64×64 + alpha, probed via macOS
  `sips`), promotes it to `public/assets/generated/<slug>_<pose>.png`,
  and records **provenance** (model, prompt, seed, license, date) in
  `art-gen/manifest.json`. Cleanup commands (ImageMagick point-resize /
  background key) are printed on validation failure.
- `CREDITS.md` — LPC + AI-asset attribution of record.
- Pure helpers unit-tested in `src/tests/sprite-pipeline.test.js`.

Licensing reality for a committed repo: of the four models, only
**SD_PixelArt (Apache-2.0)** is unambiguously clean to redistribute
output from — that clarity probably outranks raw quality.

**Wiring is M60 scope.** `MONSTER_PRESETS` are fully LPC-composed today
(`body`/`headRace`/`skinTone`/`equipment`, no sprite path); a bespoke
sheet needs a new optional `spriteSheet` field + a compositor bypass.
The spike only produces + stages art so we can measure the real quality
ceiling and per-asset effort before committing to that render-path
change.

[Sprite Sheet Diffusion, arXiv 2412.03685]: https://arxiv.org/html/2412.03685v2
[Draw Things]: https://insiderllm.com/guides/stable-diffusion-mac-mlx/
[SD_PixelArt_SpriteSheet_Generator]: https://huggingface.co/Onodofthenorth/SD_PixelArt_SpriteSheet_Generator
[Retro Diffusion local model]: https://astropulse.gitbook.io/retro-diffusion/aseprite-extension/retro-diffusion-for-aseprite
[Pixel Art XL]: https://huggingface.co/nerijs/pixel-art-xl
[8bitdiffuser 64x]: https://civitai.com/models/185743/8bitdiffuser-64x-or-a-perfect-pixel-art-model

## Finding 4 — maps: the painterly approach is right; make it move

Research on tile-art pipelines (dual-grid autotiling needs only ~16
display tiles per terrain pair and is the modern standard) confirms
it's the path IF we ever switch to drawn tilesets — but our
procedural painter already produces organic edges that autotiling
exists to approximate. Verdict: **don't switch**. Invest instead in:

1. **Life**: the animated overlay layer above (water, flicker,
   cloud shadows, weather) — frozen water is the #1 tell that the
   map is a still image.
2. **Grounding the actors**: contact shadows under grid tokens,
   reuse `idlePoseAt` for a subtle grid-idle bob, death fade on the
   grid (M56 did it in the cinema only).
3. **Time-of-day + weather presets** wired to the encounter setup
   (night ambush in rain ≠ noon field battle).
4. **Structure interiors/props pass**: extend the hero-sprite atlas
   bakers (barrels, crates, market stalls, campfires with animated
   flame, standing torches) — the audit notes architectural detail
   is sparse next to the strong foliage.

## Proposed milestone slate (for /plan, in order)

| # | Milestone | Core | Effort |
|---|-----------|------|--------|
| M57 | **Sprite animation upgrade** | Import Expanded-LPC rows (idle, run, shoot, down + emotes); wire true idle into page/grid/cinema; authored `down` replaces the held flinch for PCs; `shoot` for bow cinema | M — asset import + lpc-config rows + anim wiring |
| M58 | **Living maps** | Static-base + animated-overlay split; water shimmer, torch/campfire flicker, cloud shadows, rain/snow; time-of-day grade variants; grid contact shadows + grid idle bob | M |
| M59 | **True recolor + wardrobe** | Palette-map recolorer replacing hue-rotate; per-layer color picks in the forge (cloak/trim/team tint); selective ULPC asset expansion (hair, armor) with license manifest | M-L |
| M60 | **Monster art pipeline** | Offline PixelLab/RetroDiffusion generation scripts + curation workflow; bespoke monster idle/attack/death sheets; boss-scale sprites | L, partly external |
| — | (parked) PixiJS/WebGL layer | Normal-map lighting, real shadows | XL — only if M57-60 hit the canvas ceiling |

Cross-cutting: every milestone keeps the bake-once/blit-per-frame
discipline; licensing manifest (`docs/CREDITS.md`) becomes mandatory
once ULPC/OGA-BY/AI assets mix.

## Sources

- [Expanded Universal LPC Spritesheet (OGA)](https://opengameart.org/content/expanded-universal-lpc-spritesheet-idle-run-jump-lpc-revised-combat-and-assets)
- [LPC Expanded: Sit, Run, Jump & More (OGA)](https://opengameart.org/content/lpc-expanded-sit-run-jump-more)
- [Universal LPC Spritesheet Character Generator (GitHub)](https://github.com/LiberatedPixelCup/Universal-LPC-Spritesheet-Character-Generator)
- [LPC Revised — Character Basics (OGA)](https://opengameart.org/content/lpc-revised-character-basics)
- [Dual Tilemap Autotiling Technique (Excalibur.js)](https://excaliburjs.com/blog/Dual%20Tilemap%20Autotiling%20Technique/)
- [Autotiling — interactive guide (Red Blob Games)](https://www.redblobgames.com/articles/autotile/claude/)
- [Pixelblog 43 — Top Down Tiles (SLYNYRD)](https://www.slynyrd.com/blog/2023/3/26/pixelblog-43-top-down-tiles-part-2)
- [PixelLab — AI pixel art game assets + API](https://www.pixellab.ai/)
- [Retro Diffusion](https://retrodiffusion.ai/)
- [SpriteIlluminator — normal maps for 2D lighting](https://www.codeandweb.com/spriteilluminator)
- [GDQuest — lighting with 2D normal maps (why it needs GL)](https://www.gdquest.com/tutorial/godot/2d/lighting-with-normal-maps/)
- [PixiJS v8 (canvas fallback, migration)](https://pixijs.com/8.x/guides/migrations/v8)
