# M61 — Character art research: can we animate better?

**Ask:** improve the character art — find free art that *animates better*
than the current LPC sprites, starting from the two packs linked earlier.

**Bottom line:** Neither linked pack is a better-animating character
system. The only free path that actually animates better **and** keeps
this app's core feature (derive equipment from D&D Beyond → composite →
overlay weapons) is **within the LPC family**: ElizaWy's **LPC Revised /
LPC 3.0** (idle, run, jump, smoother combat). But it is a *migration*, not
a swap — new proportions + palette, re-fit compositor, re-source the 201
equipment layers, partial weapon-overlay rework. Recommended as a **staged
cinema-first prototype**, not a big-bang replacement.

## The two linked packs — verdict

| Pack | What it actually is | Useful for character animation? |
|---|---|---|
| [Ravenmore — Fantasy Icon Pack](https://ravenmore.itch.io/fantasy-icon-pack) | 50 hand-painted **static UI/inventory icons** (64/128/256px). No walk/attack frames. | **No** — these are item icons, not characters. Could be used for the *inventory/UI*, unrelated to animation. |
| [OGA — "don't list this collection" RPG](https://opengameart.org/content/dont-list-this-collection-in-the-archive-rpg) | A 200+ asset **curated collection that is itself LPC-style** (LPC bases, LPC-compatible enemies/animals/tiles/icons). | **No improvement** — it's the *same* LPC system we already use. More content, identical animation quality. |

So the linked assets answer the "where do I look" question with: not here for
better animation. One is icons; the other is more of what we have.

## Why we can't just switch art styles

The app's value prop is **"render LPC sprites with equipment overlays"** —
we parse a D&D Beyond character, derive its gear, and composite **201
layered PNGs** across 20 slots (`arms backpack beards body cape dress eyes
facial feet hair head legs neck quiver shield torso waist weapon
weapon-back`), recolouring skin/hair via `ctx.filter` on grayscale bases.

**No free non-LPC system offers this modularity.** The visually fluid
alternatives — Mana Seed (Seliel the Shaper), Time Fantasy, Ravenmore's
Tiny Tales — are (a) mostly **paid**, and (b) **monolithic** (a fixed
character, no per-slot equipment layers). Adopting any of them would
animate nicer but **delete the equipment system** — and the whole
weapon-attack pipeline we just built. That's not an art swap; it's a
different app.

So "better animation" has to come from **within LPC**, which is the one
free, equipment-modular, D&D-friendly system there is.

## The real upgrade: LPC Revised / LPC 3.0 (ElizaWy)

ElizaWy's revised line is the genuine animation upgrade the project could
adopt. Sources:
[LPC Revised Character Basics](https://opengameart.org/content/lpc-revised-character-basics)
· [Expanded ULPC: Idle, Run, Jump, Revised Combat](https://opengameart.org/content/expanded-universal-lpc-spritesheet-idle-run-jump-lpc-revised-combat-and-assets)
· [LPC Expanded: Sit, Run, Jump & More](https://opengameart.org/content/lpc-expanded-sit-run-jump-more)
· generator: [Universal-LPC-Spritesheet-Character-Generator](https://github.com/liberatedpixelcup/Universal-LPC-Spritesheet-Character-Generator)

**What it adds over our classic base:**
- A real **idle** (subtle breathing) — we fake this procedurally in the
  cinema today (M56 Phase 6).
- A genuine **run** cycle (original ElizaWy work, smoother than reusing walk).
- **Jump**, sit, emotes.
- **Revised combat** — a cleaner one-handed slash/thrust (our classic slash
  is the stiff 6-frame legacy cut).

**What it costs (it is NOT drop-in):**
- **Smaller heads + new proportions** (thinner masculine base). "Most
  existing assets will not work with these bases without some adaptations"
  — headgear/hats/helmets reposition, broad-male clothing must refit.
- **Strict new palette** (ULPC palette, 11 skin tones, etc.) — our
  `SKIN_TONES` / hair `ctx.filter` recolour map is tuned to the classic
  bases and would need re-derivation.
- **Frame counts/order change** — the cinema's frame maths (`bodyAnimSheet`,
  `swingFrameAt`, the M59 weapon `cellW=height/4` decode) assume classic
  counts. The oversize-weapon work this session is keyed to the *classic*
  6-frame slash (`slash_oversize → slash-s,0..5`); revised slash differs.
- **Partial equipment coverage** — not every one of our 201 layers has a
  revised counterpart yet, so a full party-view migration risks gaps.

License is clean for us: OGA-BY 3.0/4.0 + CC-BY-SA 3.0 + GPL 3.0 (credit
ElizaWy / Stephen Challener / JaidynReiman / bluecarrot16 / Wulax et al.).

## Recommendation — stage it, cinema-first

Don't replace the base wholesale. The cinema 1v1 is where animation quality
matters most **and** where equipment coverage matters least (one hero, one
foe, big on screen). So:

1. **Prototype** the revised base + run/idle/revised-slash **in the cinema
   only**, behind a flag. Pull the revised body sheets from the same ULPC
   repo we already source weapons from. Keep the party/grid view on classic.
   Validate the visual gain on real motion before committing.
2. If it lands, **expand outward**: re-source the high-traffic equipment
   layers (body/hair/head/torso/legs/weapon) in revised, refit the
   compositor palette + offsets, and re-key the weapon decode to the revised
   slash. Accept classic fallback for any layer without revised art.
3. **Cheap parallel wins on the classic base** (no migration): richer
   procedural secondary motion in the cinema (follow-through, weapon trails,
   anticipation easing) — we already have idle breathing; this extends it.

The prototype in step 1 is the decision gate: a few hours of work that shows
exactly how much "animates better" buys, before any multi-day migration.

## What was ruled out and why
- **Wholesale non-LPC art** (Mana Seed / Time Fantasy / Tiny Tales): paid
  and/or non-modular → breaks the equipment system. Rejected.
- **The two linked packs**: icons / same-LPC. No animation gain.
- **Pure procedural polish alone**: helps, but the base poses stay classic;
  diminishing returns without new frames.
