# Credits & asset attribution

character-forge composites third-party pixel art and (for monsters /
bosses) AI-generated sprites. This file is the attribution of record.

## LPC sprites — `public/assets/lpc/`

Character and equipment sprites are from the **Liberated Pixel Cup
(LPC)** ecosystem, assembled via the
[Universal LPC Spritesheet Character Generator](https://github.com/LiberatedPixelCup/Universal-LPC-Spritesheet-Character-Generator).

- **Base LPC assets** — licensed **CC-BY-SA 3.0** and **GPL 3.0**.
  Original LPC contributors (Stephen Challener / Redshrike, Johannes
  Sjölund, and many others — see the generator repo's per-asset
  credits for the full list).
- **Expanded animations** (idle, run, shoot, sit, jump, emotes; M57) —
  JaidynReiman's *[Expanded Universal LPC Spritesheet]*, licensed
  **OGA-BY 3.0 / 4.0**. Combat set (cast / thrust / slash / shoot /
  down) derived from **ElizaWy**'s LPC Revised work.

  [Expanded Universal LPC Spritesheet]: https://opengameart.org/content/expanded-universal-lpc-spritesheet-idle-run-jump-lpc-revised-combat-and-assets

Because part of the LPC set is CC-BY-SA / GPL, derivatives that
redistribute these assets must preserve the same licenses and
attribution. When importing new LPC assets, record the upstream source
path (the fetch scripts in `scripts/` do this).

## AI-generated sprites — `public/assets/generated/`

Monster / boss sprites that LPC does not cover are generated locally
with pixel-art diffusion models and curated by hand. **Per-asset
provenance — model, prompt, seed, and license — is recorded in
[`art-gen/manifest.json`](art-gen/manifest.json)** by the
`scripts/sprite-pipeline.mjs` tool; that manifest is the authoritative
record for every generated file.

Model-license notes (verify before committing output):

- **SD_PixelArt_SpriteSheet_Generator** — Apache-2.0 (cleanest for
  committed output).
- **Retro Diffusion** (local model) — commercial license; trained on
  licensed / consented art.
- **Pixel Art XL**, **8bitdiffuser 64x** — check the model card terms
  on Hugging Face / Civitai before redistributing output.

See [`art-gen/README.md`](art-gen/README.md) for the full pipeline.
