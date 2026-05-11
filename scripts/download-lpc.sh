#!/usr/bin/env bash
# Download LPC v2 sprite assets from the LiberatedPixelCup generator repo.
#
# LPC v2 conventions:
#   - body/torso/legs/feet/hat: idle.png (128x256: 2 frames × 4 directions),
#     OR walk/<color>.png (576x256: 9 frames × 4 directions) where the asset
#     has explicit color variants.
#   - shields/capes: walk/<color>.png — fg/bg split for shields.
#   - weapons: walk/<weapon>.png (576x256). Some weapons have background.png +
#     foreground.png pairs for pose layering.
#
# We always render frame 0 of the south-facing row (sx=0, sy=128).
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ASSETS="$ROOT/public/assets/lpc"
RAW="https://raw.githubusercontent.com/LiberatedPixelCup/Universal-LPC-Spritesheet-Character-Generator/master/spritesheets"

declare -a FAILED=()

fetch() {
  local src="$1"
  local dst="$ASSETS/$2"
  mkdir -p "$(dirname "$dst")"
  if curl -sSLf -o "$dst" "$RAW/$src"; then
    local size
    size=$(stat -f%z "$dst" 2>/dev/null || stat -c%s "$dst")
    if [ "$size" -lt 200 ]; then
      echo "  FAIL (tiny: ${size}b): $src"
      rm -f "$dst"
      FAILED+=("$src")
    else
      echo "  ok (${size}b): $2"
    fi
  else
    echo "  FAIL (HTTP): $src"
    FAILED+=("$src")
  fi
}

echo "Downloading LPC v2 starter pack to $ASSETS …"
rm -rf "$ASSETS"

# Bodies (idle.png, single tone). NOTE: LPC v2 bodies are HEADLESS — heads
# are a separate layer below.
fetch "body/bodies/male/idle.png"   "body/male.png"
fetch "body/bodies/female/idle.png" "body/female.png"
fetch "body/bodies/teen/idle.png"   "body/teen.png"

# Heads — required, since bodies are headless
fetch "head/heads/human/male/idle.png"        "head/heads/human_male.png"
fetch "head/heads/human/female/idle.png"      "head/heads/human_female.png"
fetch "head/heads/goblin/adult/idle.png"      "head/heads/goblin.png"
fetch "head/heads/lizard/male/idle.png"       "head/heads/lizard_male.png"
fetch "head/heads/lizard/female/idle.png"     "head/heads/lizard_female.png"

# Torso — armour (idle.png 128x256)
fetch "torso/armour/plate/male/idle.png"   "torso/plate_male.png"
fetch "torso/armour/plate/female/idle.png" "torso/plate_female.png"
fetch "torso/armour/leather/male/idle.png"   "torso/leather_male.png"
fetch "torso/armour/leather/female/idle.png" "torso/leather_female.png"

# Torso — clothes (longsleeve, idle.png)
fetch "torso/clothes/longsleeve/longsleeve/male/idle.png"   "torso/cloth_male.png"
fetch "torso/clothes/longsleeve/longsleeve/female/idle.png" "torso/cloth_female.png"

# Legs — male has idle.png, female uses walk/<color>.png frame 0
fetch "legs/pants/male/idle.png"          "legs/pants_male.png"
fetch "legs/pants/female/walk/brown.png"  "legs/pants_female.png"

# Feet — male idle, female from walk
fetch "feet/shoes/basic/male/idle.png"           "feet/shoes_male.png"
fetch "feet/shoes/basic/thin/walk/black.png"     "feet/shoes_female.png"

# Hats / helmets — gender subdirs
fetch "hat/helmet/spangenhelm/adult/idle.png" "head/spangenhelm.png"
fetch "hat/helmet/barbuta/male/idle.png"      "head/barbuta.png"
fetch "hat/helmet/sugarloaf/male/idle.png"    "head/sugarloaf.png"
fetch "hat/cloth/hood/adult/idle.png"         "head/hood.png"

# Shields — fg layer (in front of body) from heater wood, walk frame 0
fetch "shield/heater/revised/wood/fg/walk/oak.png"   "shield/heater.png"
fetch "shield/round/walk/brown.png"                  "shield/round.png"
fetch "shield/kite/male/walk/kite_gray.png"          "shield/kite.png"

# Weapons — walk frame 0 (576x256)
fetch "weapon/sword/longsword/walk/longsword.png" "weapon/longsword.png"
fetch "weapon/sword/dagger/walk/dagger.png"       "weapon/dagger.png"
fetch "weapon/sword/rapier/walk/rapier.png"       "weapon/rapier.png"
fetch "weapon/blunt/club/club.png"                "weapon/club.png"
fetch "weapon/blunt/mace/walk/mace.png"           "weapon/mace.png"
fetch "weapon/polearm/halberd/walk/halberd.png"   "weapon/halberd.png"
fetch "weapon/polearm/spear/walk/foreground.png"  "weapon/spear.png"
fetch "weapon/ranged/bow/normal/walk/foreground.png" "weapon/bow.png"

# Phase A1 — D&D 5e melee weapon expansion (sword/blunt/polearm)
# Each gives a distinct sprite to a D&D weapon name that previously collapsed
# into one of the 8 above. See lpc-config.js WEAPON_NAME_MAP for the routing.
fetch "weapon/sword/arming/universal/walk/fg.png"          "weapon/arming.png"
fetch "weapon/sword/glowsword/walk/blue.png"               "weapon/glowsword.png"
fetch "weapon/sword/katana/walk/katana.png"                "weapon/katana.png"
fetch "weapon/sword/longsword_alt/walk/longsword_alt.png"  "weapon/longsword_alt.png"
fetch "weapon/sword/saber/walk/saber.png"                  "weapon/saber.png"
fetch "weapon/sword/scimitar/walk/scimitar.png"            "weapon/scimitar.png"
fetch "weapon/blunt/flail/walk/flail.png"                  "weapon/flail.png"
fetch "weapon/blunt/waraxe/walk/waraxe.png"                "weapon/waraxe.png"
fetch "weapon/polearm/cane/male/walk/cane.png"             "weapon/cane.png"
fetch "weapon/polearm/dragonspear/walk/foreground.png"     "weapon/dragonspear.png"
fetch "weapon/polearm/longspear/walk/foreground.png"       "weapon/longspear.png"
fetch "weapon/polearm/scythe/walk/scythe.png"              "weapon/scythe.png"
fetch "weapon/polearm/trident/walk/foreground.png"         "weapon/trident.png"

# Bespoke back-sheath art for the new weapons (LPC universal_behind / behind).
# Where these don't ship, pickBackWeapon falls through to BACK_DERIVED_POSES.
fetch "weapon/sword/glowsword/universal_behind/walk/blue.png"   "weapon-back/glowsword.png"
fetch "weapon/sword/saber/universal_behind/walk/saber.png"      "weapon-back/saber.png"
fetch "weapon/polearm/scythe/universal_behind/walk/scythe.png"  "weapon-back/scythe.png"
fetch "weapon/blunt/flail/behind/walk/flail.png"                "weapon-back/flail.png"
fetch "weapon/blunt/waraxe/behind/walk/waraxe.png"              "weapon-back/waraxe.png"

# Phase B — Torso armor expansion (1 new variant)
fetch "torso/armour/legion/male/idle.png"   "torso/legion_male.png"
fetch "torso/armour/legion/female/idle.png" "torso/legion_female.png"

# Phase B — Shield variety (3 new: tower / paladin / round-warrior)
fetch "shield/scutum/paint/fg/male/walk/scutum.png" "shield/scutum.png"
fetch "shield/crusader/fg/walk.png"                 "shield/crusader.png"
fetch "shield/spartan/fg/walk/spartan.png"          "shield/spartan.png"

# Phase B — Helm variety (8 new: greathelm/armet/kettle/horned/nasal/mail/bascinet/leather_cap)
fetch "hat/helmet/greathelm/male/idle.png"      "head/greathelm.png"
fetch "hat/helmet/armet/adult/idle.png"         "head/armet.png"
fetch "hat/helmet/kettle/adult/idle.png"        "head/kettle.png"
fetch "hat/helmet/horned/adult/idle.png"        "head/horned.png"
fetch "hat/helmet/nasal/adult/idle.png"         "head/nasal.png"
fetch "hat/helmet/mail/adult/idle.png"          "head/mail_coif.png"
fetch "hat/helmet/bascinet/adult/idle.png"      "head/bascinet.png"
fetch "hat/cloth/leather_cap/adult/idle.png"    "head/leather_cap.png"

# Phase A2 — ranged weapons (distinguish bow/crossbow/sling/boomerang) and
# magic foci (staves and wand for casters' mainhand).
fetch "weapon/ranged/crossbow/walk/crossbow.png"                "weapon/crossbow.png"
fetch "weapon/ranged/slingshot/walk/slingshot.png"              "weapon/slingshot.png"
# boomerang skipped — LPC sheet only shows the projectile in flight, not held;
# also not in the D&D 5e SRD weapon table.
fetch "weapon/magic/crystal/universal/walk/foreground.png"      "weapon/staff_crystal.png"
fetch "weapon/magic/diamond/universal/walk/foreground.png"      "weapon/staff_diamond.png"
fetch "weapon/magic/gnarled/universal/walk/foreground.png"      "weapon/staff_gnarled.png"
fetch "weapon/magic/loop/universal/walk/foreground.png"         "weapon/staff_loop.png"
fetch "weapon/magic/simple/foreground/walk/simple.png"          "weapon/staff_simple.png"
fetch "weapon/magic/wand/male/slash/wand.png"                   "weapon/wand.png"

# A2 back-sheath: only slingshot ships behind/ art.
fetch "weapon/ranged/slingshot/behind/walk/slingshot.png"       "weapon-back/slingshot.png"

# Capes — walk frame 0, behind-body layer
fetch "cape/solid_behind/walk/red.png"  "cape/red.png"
fetch "cape/solid_behind/walk/blue.png" "cape/blue.png"
# Phase C — 8 additional cape colors for class/role variety
fetch "cape/solid_behind/walk/black.png"    "cape/black.png"
fetch "cape/solid_behind/walk/white.png"    "cape/white.png"
fetch "cape/solid_behind/walk/green.png"    "cape/green.png"
fetch "cape/solid_behind/walk/purple.png"   "cape/purple.png"
fetch "cape/solid_behind/walk/gray.png"     "cape/gray.png"
fetch "cape/solid_behind/walk/navy.png"     "cape/navy.png"
fetch "cape/solid_behind/walk/brown.png"    "cape/brown.png"
fetch "cape/solid_behind/walk/charcoal.png" "cape/charcoal.png"
# Phase F4 — tattered cape variant for Squalid/Wretched lifestyles
fetch "cape/tattered_behind/walk/brown.png"   "cape/tattered_brown.png"
fetch "cape/tattered_behind/walk/charcoal.png" "cape/tattered_charcoal.png"

# Quiver (Sharpshooter feat)
fetch "quiver/walk/quiver.png" "quiver/quiver.png"

# Phase C/D2 — Backpack. LPC's full-pack styles (backpack, squarepack) have an
# empty south row — the pack is hidden behind the body in the front-facing
# view. The 'straps' style shows shoulder straps from all 4 directions.
# Phase D2 layers both: south uses straps (visible from front); N/W/E use the
# full pack art (proper distinct shapes for adventurer vs scholar).
fetch "backpack/straps/male/walk/leather.png"        "backpack/straps_adventurer_male.png"
fetch "backpack/straps/female/walk/leather.png"      "backpack/straps_adventurer_female.png"
fetch "backpack/straps/male/walk/black.png"          "backpack/straps_scholar_male.png"
fetch "backpack/straps/female/walk/black.png"        "backpack/straps_scholar_female.png"
# Phase D2 — full pack art for non-south directions
fetch "backpack/backpack/male/walk/leather.png"      "backpack/full_adventurer_male.png"
fetch "backpack/backpack/female/walk/leather.png"    "backpack/full_adventurer_female.png"
fetch "backpack/squarepack/male/walk/leather.png"    "backpack/full_scholar_male.png"
fetch "backpack/squarepack/female/walk/leather.png"  "backpack/full_scholar_female.png"

# --- Back-sheath weapons (drawn behind body for overflow weapons) ---
# LPC ships universal_behind variants for: longsword, rapier, saber, mace,
# scythe (verified). Other weapons fall back to procedural rectangles.
fetch "weapon/sword/longsword/universal_behind/walk/longsword.png"  "weapon-back/longsword.png"
fetch "weapon/sword/rapier/universal_behind/walk/rapier.png"        "weapon-back/rapier.png"
fetch "weapon/blunt/mace/universal_behind/walk/mace.png"            "weapon-back/mace.png"

# --- Caster wardrobe ---

# Robes (female only in LPC; male casters get tunic fallback)
fetch "torso/clothes/robe/female/walk/black.png"  "torso/robe_female_black.png"
fetch "torso/clothes/robe/female/walk/brown.png"  "torso/robe_female_brown.png"
fetch "torso/clothes/robe/female/walk/purple.png" "torso/robe_female_purple.png"
fetch "torso/clothes/robe/female/walk/red.png"    "torso/robe_female_red.png"

# Tunics (LPC only ships female; male casters fall back to longsleeve cloth)
fetch "torso/clothes/tunic/female/walk/brown.png" "torso/tunic_female.png"

# Sleeveless (both genders) — for monks/druids
fetch "torso/clothes/sleeveless/sleeveless1/male/idle.png"   "torso/sleeveless_male.png"
fetch "torso/clothes/sleeveless/sleeveless1/female/idle.png" "torso/sleeveless_female.png"

# Bodice dresses (female only)
fetch "dress/bodice/female/walk/black.png"  "dress/bodice_black.png"
fetch "dress/bodice/female/walk/blue.png"   "dress/bodice_blue.png"
fetch "dress/slit/female/walk/red.png"      "dress/slit_red.png"

# Wizard belt overlay (rope-style cord)
fetch "torso/waist/belt_robe/male/walk/white.png"   "waist/belt_rope_male.png"
fetch "torso/waist/belt_robe/female/walk/white.png" "waist/belt_rope_female.png"

# Wizard / mage hats
fetch "hat/magic/wizard/base/adult/idle.png"   "head/wizard.png"
fetch "hat/magic/celestial/adult/idle.png"     "head/celestial.png"

# Skirts (alt legs for casters/dresses)
fetch "legs/skirts/belle/thin/idle.png" "legs/skirt_belle.png"

# Leggings (alt legs)
fetch "legs/leggings/male/idle.png"   "legs/leggings_male.png"
fetch "legs/leggings/thin/idle.png"   "legs/leggings_female.png"

# --- Accessories ---

# Bracers / gauntlets
fetch "arms/bracers/male/idle.png"      "arms/bracers_male.png"
fetch "arms/bracers/thin/idle.png"      "arms/bracers_female.png"
fetch "arms/armour/plate/male/idle.png" "arms/gauntlets_male.png"
fetch "arms/armour/plate/thin/idle.png" "arms/gauntlets_female.png"

# Gloves (cloth)
fetch "arms/hands/gloves/male/idle.png" "arms/gloves_male.png"
fetch "arms/hands/gloves/thin/idle.png" "arms/gloves_female.png"

# Amulet (cross style — closest LPC has to a generic pendant)
fetch "neck/amulet/cross/male/walk/silver_blue.png"   "neck/amulet_male.png"
fetch "neck/amulet/cross/female/walk/silver_blue.png" "neck/amulet_female.png"

# Phase C — Neck variants beyond the cross amulet. Idle frames; gendered.
fetch "neck/charm/oval/male/idle/gold.png"        "neck/charm_male.png"
fetch "neck/charm/oval/female/idle/gold.png"      "neck/charm_female.png"
fetch "neck/necklace/chain/male/idle/gold.png"    "neck/chain_male.png"
fetch "neck/necklace/chain/female/idle/gold.png"  "neck/chain_female.png"
fetch "neck/gem/round/male/idle/blue.png"         "neck/gem_male.png"
fetch "neck/gem/round/female/idle/blue.png"       "neck/gem_female.png"

# Phase D3 — Hair, beards, facial, eyes
# LPC ships hair/beard as single-color sprites. Color variation is provided
# at render time via ctx.filter (HAIR_COLOR_FILTERS). Eyes and glasses ship
# with native multi-color variants and are downloaded per color.

# Hair (7 styles, single-color base sprites)
fetch "hair/buzzcut/adult/idle.png" "hair/buzzcut.png"
fetch "hair/long/adult/idle.png"    "hair/long.png"
fetch "hair/spiked/adult/idle.png"  "hair/spiked.png"
fetch "hair/bedhead/adult/idle.png" "hair/bedhead.png"
fetch "hair/balding/adult/idle.png" "hair/balding.png"
fetch "hair/bob/adult/idle.png"     "hair/bob.png"
fetch "hair/afro/adult/idle.png"    "hair/afro.png"

# Beards (4 styles)
fetch "beards/beard/basic/idle.png"           "beards/beard_basic.png"
fetch "beards/beard/medium/idle.png"          "beards/beard_medium.png"
fetch "beards/beard/winter/male/idle.png"     "beards/beard_winter.png"
fetch "beards/mustache/handlebar/idle.png"    "beards/mustache_handlebar.png"

# Facial — glasses (single color: black) + eyepatch (right eye)
fetch "facial/glasses/round/adult/idle/black.png"        "facial/glasses_round.png"
fetch "facial/patches/eyepatch/right/adult/idle.png"     "facial/eyepatch.png"

# Eyes (native multi-color, default position, 4 colors)
fetch "eyes/human/adult/default/idle/blue.png"  "eyes/blue.png"
fetch "eyes/human/adult/default/idle/brown.png" "eyes/brown.png"
fetch "eyes/human/adult/default/idle/green.png" "eyes/green.png"
fetch "eyes/human/adult/default/idle/gray.png"  "eyes/gray.png"

echo
if [ ${#FAILED[@]} -eq 0 ]; then
  echo "All assets downloaded."
else
  echo "${#FAILED[@]} asset(s) failed:"
  for f in "${FAILED[@]}"; do echo "  - $f"; done
  exit 1
fi
