# character-forge

Render a 2D paper-doll sprite from a D&D Beyond character sheet.

> Not affiliated with Wizards of the Coast or D&D Beyond. The site uses an
> undocumented public character endpoint that may change without notice.

## Stack

- Vanilla JS + Vite 6 (no framework)
- Express + SQLite (better-sqlite3) backend
- HTML5 Canvas paper-doll compositor
- LPC (Liberated Pixel Cup) sprite assets — CC-BY-SA 3.0

## Quick start

```bash
npm install
bash scripts/download-lpc.sh   # one-time: pull 31 LPC v2 sprites (~80kb total)
npm run dev:all                # API on :3101, Vite on :3100
```

Open http://localhost:3100 and either:

- Paste a public D&D Beyond share URL (`https://www.dndbeyond.com/characters/123456789`), or
- Paste raw character JSON (works for private characters via direct fetch).

## How it works

1. **Import** — `POST /api/import` accepts either a URL/id or pre-fetched JSON.
   The server fetches the public DDB endpoint at
   `character-service.dndbeyond.com/character/v5/character/<id>` only when you
   provide a URL or id. JSON paste skips the fetch entirely.
2. **Parse** — `api/lib/ddb-parser.js` normalizes the raw character into a
   slot-mapped equipment record, ability modifiers, feat list, and visual
   hints (body width, stance, palette).
3. **Render** — `src/js/sprite/compositor.js` composites layered LPC v2 PNGs
   in this order: cape (behind) → body → legs → feet → torso → belt →
   gloves → helm → quiver → off-hand → main-hand → effects. Equipment
   names are matched to assets by `pickWeapon()`, `pickShield()`,
   `pickHelm()`, etc. in `lpc-config.js`. Slots with no matching asset
   fall back to a coloured placeholder rectangle.

### LPC v2 sheet conventions

All assets render the south-facing first frame at `(sx=0, sy=128)`. The
download script pulls two sheet types:

| Layout      | Dimensions | Used by                            |
|-------------|------------|------------------------------------|
| `idle.png`  | 128×256    | bodies, torsos, helms, male legs/feet |
| `walk.png`  | 576×256    | weapons, shields, capes, female legs/feet, quiver |

A few weapons (`bow.png`, `club.png`) are larger sheets that still expose
a usable south-facing frame at `(0, 128)`.

### Adding more LPC assets

The download script is the single source of truth for asset paths. To add
a new helmet/weapon/etc.:

1. Browse [the LPC generator repo's spritesheets/ tree](https://github.com/LiberatedPixelCup/Universal-LPC-Spritesheet-Character-Generator/tree/master/spritesheets)
   to find the file path.
2. Add a `fetch "<source-path>" "<dest-path>"` line to `scripts/download-lpc.sh`.
3. Add a key to the matching table in `src/js/sprite/lpc-config.js`
   (`ASSET_MAP.weapon.<key>`, etc.) and add a matcher branch in `pickWeapon()` /
   `pickHelm()` / `pickShield()`.
4. `bash scripts/download-lpc.sh` to refresh.

## Visual rules in v1

- **Equipment** drives the sprite: armor → torso layer; weapons/shield → hand
  rectangles; helm/cloak/belt → overlay rectangles; magical items get a
  subtle visual cue.
- **Feats** add overlays:
  - `Sharpshooter` — quiver
  - `Great Weapon Master` — oversized mainhand
  - `Magic Initiate` / `War Caster` — glowing hand
- **Ability scores** make subtle adjustments:
  - STR ≥ 16 → heavier armor variant where available
  - DEX ≥ 16 → dynamic stance
  - CON ≥ 16 → broader silhouette
  - CHA ≥ 16 → +12% color saturation pass

## Project layout

```
api/
  server.js            Express app (POST /api/import, GET /api/characters/...)
  db/
    schema.sql         SQLite schema (characters table)
    database.js        better-sqlite3 wrapper
  lib/
    ddb-fetch.js       URL parsing + character-service v5 fetch
    ddb-parser.js      Raw JSON -> normalized character
public/assets/lpc/     LPC sprite PNGs (832x1344 standard sheets)
src/
  styles.css
  js/
    main.js            UI wiring
    sprite/
      lpc-config.js    Sheet layout + slot tables + render plan builder
      compositor.js    Canvas layered renderer
index.html
vite.config.js
```

## D&D Beyond endpoint disclosure

The `character-service.dndbeyond.com/character/v5/character/<id>` endpoint
is undocumented and was not authorized by Wizards of the Coast for this
project. Avrae and Beyond20 have explicit cooperation with the DDB team;
this project does not. Use it only for personal/research purposes and be
prepared for it to break.

The JSON-paste fallback works without any DDB call.

## Roadmap

- v2 — multiple body archetypes, more LPC equipment layers, per-feat sprite layers
- v3 — animation cycles (LPC sheets contain walk/slash/cast — currently we
  render only the walk-south idle frame at column 0 row 8)
- v3 — share-image export (`canvas.toBlob` → PNG download)
