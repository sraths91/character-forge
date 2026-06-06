# M49 — Structured procedural maps (complexity upgrade)

## Context

The Phase-1–3 map generator (noise + per-cell scatter) produces textured
terrain, but every feature is rolled **independently per cell**, so the maps
read as texture with no *structure* — no rivers, no clearings, no roads, no
buildings. The user wants maps closer to hand-crafted battlemaps (DnD David
style): coherent regions, flowing water and paths, larger structures, and
painterly blended ground.

Confirmed direction: **all four structural elements** (rivers/paths, coherent
regions, multi-cell structures, richer ground/edges) + **painterly rendering**.
Still **visual only** — no movement/combat impact.

## Approach — multi-pass generation pipeline

Replace the single per-cell scatter with passes, each building on the last:

1. **Fields** (`noise.js`) — continuous `elevation` + `moisture` fBm fields,
   decorrelated seeds, with domain-warp for organic (non-grid-aligned) edges.
2. **Regions** — classify each cell into a zone (water / shore / lowland /
   midland / highland) from elevation bands + moisture modifier. Per-biome
   palette + feature table per zone → coherent areas (groves, clearings,
   ponds, rocky patches) instead of uniform scatter.
3. **Rivers** (Phase 2) — trace 1–2 polylines downhill along the elevation
   gradient from a high edge to a low edge/pond; carve a water channel.
4. **Paths** (Phase 2) — trace a road edge-to-edge avoiding deep water; bridge
   where it crosses a river.
5. **Structures** (Phase 3) — place 0–2 multi-cell buildings / ruins /
   campsites on flat dry land, clear of water and leaving combat room.
6. **Detail scatter** — region-aware features (trees cluster in grove zones,
   reeds at water edges, rocks in highland), avoiding water centers, paths,
   and structures.

### Model shape (grows per phase)
```
{ biome, cols, rows, seed, palette, levels,
  elevation(c,r), moisture(c,r),     // continuous samplers
  zoneAt(c,r),                       // 'water'|'shore'|'low'|'mid'|'high'
  rivers:[polyline], paths:[polyline], structures:[...], features:[...] }
```

### Painterly renderer (`map-render.js`)
- Ground painted per sub-cell tile with a color **interpolated** across zone
  bands by exact elevation + moisture tint + noise jitter → smooth gradients,
  no flat fills.
- Soft zone edges via the continuous interpolation + warped boundaries.
- Rivers/paths as smooth filled **ribbons** (quadratic curves through the
  polyline) with banks.
- Structures painted as roofs/walls/ruins/fires.
- Features keep shadow+highlight, gain subtle gradient fills.
- Still pre-rendered once to the offscreen cache (perf unchanged).

## Phases (each independently shippable, green tests + lint + build)
1. Fields + regions + painterly ground + region-aware scatter.
2. Rivers + paths + bridges.
3. Multi-cell structures.

## Files
- `src/js/scene/noise.js` — add `domainWarp`, `ridgedFbm`.
- `src/js/scene/map-generator.js` — rewrite to the multi-pass pipeline.
- `src/js/scene/map-render.js` — painterly renderer.
- Tests: extend `map-generator.test.js`, `map-render.test.js`; new cases per phase.

## Verification
Per phase: `npm test` (no regressions), lint ≤20, build clean, and a Playwright
visual sheet across biomes confirming structure reads + tokens stay legible.
