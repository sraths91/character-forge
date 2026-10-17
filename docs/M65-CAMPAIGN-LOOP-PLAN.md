# M65 — Campaign loop: campaigns, runs, progression, rests, loot

## Status
Drafted 2026-10-16 by the planning architect against `main` @ 3ed14aa
(phase 1 built and merged; 2,008 tests). **Not yet approved.** Inputs:
M64 (decisions, the data model, "Phase 2 — campaign loop", the owner
defaults table), the progression brief R3, the DM-tools brief R4's
phase 2 list, and the code as it is now. Every path and function cited
below was checked with grep at 3ed14aa.

Phase 2 = M64 product decision 1 made real: a DM authors a chain of
nodes; a party plays it as a **run**, fight by fight, resting, looting,
shopping and leveling between fights; the game owns progression after
the DDB import (decision 3).

**Architect's note (2026-10-16, after review).** This draft was written
against 3ed14aa, before M64 phase 1.5 (Wave 5) started. Adjust when
Wave 0 of this plan begins:
- R21 (death saves), Extra Attack, the Open5e normaliser (xp/cr on the
  stat block, so R22 shrinks to a check), fog filtering of incremental
  events, Fighting Styles, cantrip scaling and the auth gate on
  `GET /api/characters/:ddbId` (the "licensing leak" in gap 7) are all
  in flight on the phase 1.5 branches; re-verify them on main and drop
  the carry-ins that landed.
- Migration numbering: phase 1.5 adds `0003_encounter_sheets.sql`, so
  the campaign-loop migration below is **0004**.
- `live-bridge.js` is already E1's; V21/V22/T24 stand.
- Owner approval is still required before any phase 2 task starts; the
  20 defaults below apply unless overridden at that point.

Task IDs continue M64's letters, numbered from 21 (H21, T21, R21 …),
so they never collide with phase 1 IDs.

---

## What the code gives us, and the gaps

**Already in place (phase 1):** `party_slots` has its own id plus
`seed_parsed_json` / `sheet_json` / `state_json` (`0002_multiplayer.sql`),
but phase 1 writes only the seed (`store.js upsertSeat`); `buildEncounter`
(`api/rooms/real-engine.js`) builds every PC fresh via `sheetForSeat` →
`entityFromSheet`, with `seedLiveState` as the only DDB-state hook. One
damage/heal path (`applyDamage`, `applyHealing`), temp HP, R/I/V and
condition lifecycles exist; `choosePcAction` already targets
`downedAllies`. The parser emits `spellSlotTable`, `slotsUsed`,
`currentXp`, full `inventory[]` and granted-spell `uses`; `slotsForPc`
prefers the table. `calibrator.js` has `CR_XP`; Open5e creatures carry
`experience_points` (probe 2026-10-16: `srd_goblin` → 50) and a numeric
`challenge_rating`. Fog (`src/js/map/fog.js`) and `viewFor` /
`canSeeEvent` (`api/rooms/view.js`) are the per-viewer seams.

**Gaps that shape this plan:**
1. **Nothing survives an encounter.** HP, slots, feature uses and
   conditions live only in `encounters.snapshot_json`. A run must write
   them back to `party_slots.state_json` when the encounter ends.
2. **Two encounter-end paths in `room.js`**: natural end in
   `#runOneTurn` and DM end in `#endEncounter`. Both must call one run
   hook, exactly once, replay-safe.
3. **The parser keeps only the current level.** `parseClassFeatures`
   drops `requiredLevel > level`; `parseSpellSlotTable` keeps only the
   current row; hit dice (`hitDiceUsed`, `definition.hitDice`),
   `levelScales` and `currencies` are not parsed; `inventory[]` rows
   carry no armour or weapon stats, so an unequipped item cannot be
   equipped later.
4. **Death saves (M64 R9) never landed.** `isAlive(e) = e.hp > 0`
   (`combat-engine.js:1817`). Neither did Extra Attack (R10) or the
   Open5e normaliser (R11).
5. **`resetPerEncounterFlags`** (`ai/pc-features.js:284`) is still
   uncalled, and it resets Second Wind per encounter, where RAW is a
   short rest.
6. **The janitor deletes idle rooms after 30 days** (`api/lib/janitor.js`).
   `party_slots.room_id` is `ON DELETE CASCADE`, so a paused campaign
   would lose its whole party.
7. **Licensing leak found while reading:** `GET /api/characters/:ddbId`
   (`api/app.js:264`) is unauthenticated and returns the full parsed
   sheet, including `classFeatures[].description` (DDB prose). The play
   client fetches every seat's sheet through it (`play.js:94`). That
   breaks M64 risk 9's rule ("non-SRD prose only to the owning seat and
   the DM") today, and in a run it would also show the stale DDB sheet
   instead of the leveled run sheet.
8. **Open5e item data is uneven** (probe 2026-10-16): `/v2/items/` with
   `document__key__in=srd-2014` returns 237 items with a `cost` string
   (Acid wrongly shows "0.00"); `/v2/magicitems/` returns 499, with
   `cost` mostly null or 0 (Potion of Healing "50.00"), and potion
   healing only as prose. Armour carries structured `ac_base` and
   `ac_cap_dexmod`.

---

## Decisions (architect proposals; the owner may override)

1. **`run_characters` is `party_slots` extended in place, plus a view.**
   No `ALTER TABLE … RENAME`: it is legal SQLite, but it would break
   every phase-1 statement in `store.js` for zero gain. New columns go on
   `party_slots`, and `CREATE VIEW run_characters` gives the phase-2
   name. Verified on better-sqlite3 13 (SQLite 3.53.4): `ADD COLUMN`
   with `REFERENCES`, `NOT NULL DEFAULT` and `CHECK` works on a STRICT
   table inside the runner's transaction, and the `CHECK` is enforced
   on existing rows.
2. **A run pins its room.** `runs.room_id` is UNIQUE. The room's code
   stays reserved while the run is open, so "rejoin by room code" is the
   phase-1 join flow. The janitor never deletes a room with a non-ended
   run. A plain FK (no cascade) is the backstop.
3. **Authority is split by time.** During an encounter, `EncounterState`
   is authoritative. Between nodes, `party_slots.sheet_json` /
   `state_json` and `run_items` are. Write-back happens once per
   encounter, marked by `encounters.run_applied_at`, and boot recovery
   applies any ended encounter whose mark is NULL. Between-node intents
   are refused while an encounter is live.
4. **The campaign graph is frozen into the run** at start
   (`runs.campaign_json`). Editing a campaign never changes a live run.
   The DM can choose "pull latest" explicitly.
5. **Campaign ownership is a campaign key**: a 256-bit bearer token,
   SHA-256-hashed like DM tokens and shown once. The DM's browser keeps
   it until Discord OAuth (decision 7), and `owner_user_id` is ready for
   that. The key also mints a replacement DM token for any of the
   campaign's runs (DM recovery).
6. **Between-node randomness is seeded.** Hit dice, rolled HP and random
   loot draw from a persisted run RNG (`runs.rng_json`, mulberry32 via
   `createRng`), so a run replays from its events.
7. **Progression rules are pure and shared.** They live in
   `src/js/campaign/` (Node and browser, inside the T10 portability
   guard), so the client previews exactly what the server will apply.
8. **One runner.** The forge's versus mode retires into a
   server-hosted **solo room**: the DM drives the AI seats, and the
   `controller.type:'dm'` path already exists. `main.js` loses its
   combat driver. An in-browser offline host is an owner question.
9. **Prose privacy is enforced at the server boundary.** `publicSheet()`
   strips prose before anything leaves the server. Clients never see
   another seat's descriptions.
10. **Spent, not remaining**, everywhere (state_json v1 unchanged).
    A level-up changes `sheet_json` only, plus the HP gain.

---

## Architecture

```
DM authoring (HTTP)            run runtime (ws, inside the Room)
 /api/campaigns/**               api/runs/run-controller.js  ← attached to Room
  campaigns, campaign_nodes,      start → node entry → encounter (existing lane)
  encounter_templates,            ↘ onEncounterEnded (both end paths, once)
  campaign_assets                    write-back · XP · death · items · level_ups
        │                            → runs.status='between' → between intents
        ▼                            → nextNodes() → next node … → run end
 runs.campaign_json (frozen)     api/runs/store.js (SQL, optimistic version)
                                         │
 src/js/shared/  campaign.js · run-state.js · run-events.js · protocol v1.4
 src/js/campaign/ xp · rest · level-up · items · consumables · death · downtime-spells
 src/js/scene/encounter-adapters.js  entityFromSheet(sheet,{runState}) / runStateFromEntity
```

### Node kinds (`campaign_nodes.kind`)
| Kind | Payload | Between-state effect |
|---|---|---|
| `encounter` | `templateId` or inline `dm.encounter.setup` payload (the exact `setupPayload(draft)` shape from `views/setup.js`), party placement, `xpOverride?`, loot on victory | Builds the encounter from run states; the DM can tweak setup before Start |
| `rest` | `type: short\|long\|choice` | Rest screen |
| `loot` | items (DM-authored or Open5e SRD keys), currency, `assign: free\|dm` | Loot screen |
| `shop` | stock `[{ref, qty, price?}]`, `buyback: 0.5` | Shop screen |
| `story` | DM text, `choices[{id, label}]` | Story screen; the choice picks the edge |

`next_json`: `[{to, label?, when?: {outcome?, choice?}}]`. The pure
`nextNodes(node, {outcome, choice})` returns the candidate edges. The DM
confirms, or overrides with "go to any node". Players see visited nodes
and the edges on offer, never the rest of the graph.

### Run lifecycle
`runs.status`: `lobby → in-node → between → … → ended`, with
`paused` available. Outcome is `victory|defeat|abandoned`. Room status
gains `between` in the protocol only (`ROOM_STATUSES`), so
`rooms.status` keeps its CHECK. A party wipe (`hostile-victory`) asks
the DM to end the run as a defeat, load a snapshot, or continue.

**Encounter end (one transaction, before broadcast):**
1. `runStateFromEntity` for every PC → `state_json`, `version + 1`.
2. Conditions with a lifecycle and `endsOn:'encounter'` clear, and so
   does concentration. Exhaustion, the death-save state and DM-marked
   persistent conditions carry over.
3. XP: `encounterXp` sums the defeated hostiles (statBlock `xp`, else
   `CR_XP[cr]`) and splits the total across participating PCs who are
   not dead. Milestone mode skips this step.
4. `life_status` moves to `active|dying|stable|dead`.
5. Potion and charge deltas → `run_items`.
6. A `level_ups` row is created for each crossed threshold.
7. `run_events` rows are written, `encounters.run_applied_at` is set
   and `runs.status` becomes `between`.

**Death across nodes.** `dead` persists in `life_status`. A dead PC
stays in its seat and is left out of the next encounter's party. How
revival works depends on `deathMode`:
- `standard`:
  - Revivify works only in the between that follows the death. It needs
    a caster with the spell, a 3rd-level slot, and a 300 gp diamond.
  - Raise Dead works at any later between.
  - A DM override works at any time.
- `permadeath`: DM override only.
- `lenient`: on a party victory, downed PCs stand up at 1 HP.

Retiring a dead PC copies its row into `run_roster_archive`. That
frees the seat for a replacement character or an AI seat;
`controller_participant_id NULL` already means AI.

### Level-up queue
XP crossing a threshold, or a DM grant in milestone mode, creates a
`level_ups` row. `planLevelUp` splits the level into three parts.

**Auto-applied:**
- HP: the fixed average or a roll, plus CON.
- One more hit die.
- Proficiency bonus, from total level.
- Slots, from the class's `levelSpellSlots` row.
- Features at `requiredLevel`, and `levelScales` dice.

**Chosen by the player, confirmed by the DM:**
- An ASI (+2, or +1/+1, cap 20).
- New SRD spells, within the known/prepared maximums.
- Which existing class gains the level.

**Reconcile re-import:** used for subclasses, feats, invocations,
non-SRD spells, and a new multiclass. `diffCharacters`
(`src/js/character/diff-character.js:49`) compares the run sheet to the
freshly imported parse. Only structural changes are proposed, and the DM
approves. The import is refused if the DDB level is above the
game-granted level. XP, HP, resources, inventory and currency are never
copied from DDB.

`granted_json` records every sheet patch with its `before` value, so
`revertLevelUp` restores the sheet byte for byte. A level-up can apply
only between nodes.

### Rests, items, currency
- **Rests** are data-driven (`REST_TYPES`, Foundry pattern) through
  `applyRest(sheet, state, type, {spend, rng})`. Short: players spend
  hit dice (roll + CON each); `sr` resources and pact slots recover.
  Long (needs ≥ 1 HP): full HP, half the hit dice back (min 1), `lr` /
  `sr` (and `dawn` / `day` with `dawnIsLongRest`) resources and all
  slots recover, temp HP clears, exhaustion −1. Resource keys:
  `ddb:<componentId>` (parser `uses`), `feat:action-surge|second-wind`
  (↔ entity `resources.features`), `spell:<id>` for granted-spell uses,
  which also closes the "AI casts Misty Step from a slot" gap.
- **Items:** `run_items` (owner seat, or NULL = party stash; origin
  `ddb|open5e|dm`), seeded from the full `inventory[]`; currency in
  `state.currency` and `runs.stash_json`. Equip / unequip / attune
  (≤ 3) rewrite `sheet_json.equipment`, and the existing `deriveAC` /
  `deriveWeaponAttack` (`pc-stats.js`) re-derive AC and attacks at the
  next encounter; Open5e armour and weapons map to the parser's shape
  via `itemToEquipment`.
- **Potions are an engine action** (plan kind `item`; entity
  `resources.items {[runItemId]: {name, effect, max, spent}}`), resolved
  through `applyHealing`, emitting `item.used`. Amounts come from an SRD
  registry (Open5e has them only as prose): Healing 2d4+2, Greater
  4d4+4, Superior 8d4+8, Supreme 10d4+20.
- **Pricing:** Open5e `cost` for mundane items; null / "0.00" means
  DM-priced; sell-back at half.

### Contract changes (all additive)
- **EncounterState v1** (no bump): entity `deathSaves`, `exhaustion`,
  `resources.items`; `statBlock.xp|cr|tokenImageId`; optional `runId`,
  `nodeId`.
- **Events v1.2:** `death.save`, `item.used`.
- **Protocol v1.4:** room status `between`; `run.snapshot` (private),
  `run.updated` + run events (broadcast), `levelup.offer` (private).
  Player intents `rest.spend`, `loot.claim`, `item.{equip,give,use}`,
  `shop.{buy,sell}`, `story.choose`, `levelup.{choose,reconcile}`,
  `seat.reclaim`. DM intents `dm.run.{advance,end}`, `dm.node.begin`,
  `dm.rest.grant`, `dm.loot.assign`, `dm.story.resolve`, `dm.xp.adjust`,
  `dm.levelup.{confirm,revert}`, `dm.character.{revive,retire}`,
  `dm.seat.fill`, `dm.snapshot.{save,load}`, `dm.seat.reclaim.approve`.
- **Run event catalogue v1** (mutating types carry `{before, after}`):
  `run.started/ended`, `node.entered/completed`, `encounter.result`,
  `xp.awarded`, `level.queued/applied/reverted`, `rest.taken`,
  `loot.granted`, `item.moved/used`, `currency.changed`,
  `shop.bought/sold`, `character.died/revived/retired/joined`,
  `seat.filled`, `story.chosen`, `snapshot.saved/restored`, `dm.override`.

### Licensing
- **SRD attribution:** shown in the play.html footer and About dialog,
  in campaign exports, and on `/api/licenses`. The text: *"This work
  includes material taken from the System Reference Document 5.1 ("SRD
  5.1") by Wizards of the Coast LLC and available at
  https://dnd.wizards.com/resources/systems-reference-document. The SRD
  5.1 is licensed under the Creative Commons Attribution 4.0
  International License available at
  https://creativecommons.org/licenses/by/4.0/legalcode."* The gate
  checks this text word for word against the PDF's Legal Information
  page before it ships.
- **Prose visibility:**
  - `publicSheet()` keeps names, numbers and the appearance data the
    sprites need. It drops `classFeatures[].description`, spell and
    feat prose, `traits` and backstory.
  - The full sheet goes only to the seat's controller and the DM,
    through `GET /api/rooms/:id/seats/:slotId/sheet`. That route serves
    the **run** `sheet_json`.
  - With `CF_MULTIPLAYER=1`, `GET /api/characters/:ddbId` requires a
    member token.
- **Caches:** `items_cache` admits only `srd-2014` keys. Non-SRD prose
  is never cached, exported or snapshotted for anyone but the DM.

---

## Data model — migration `0003_campaign_loop.sql`

**Every step below is additive. No table is rebuilt.**

| # | Step | Kind |
|---|---|---|
| 1 | `campaigns(id, name, owner_key_hash UNIQUE, owner_user_id → users NULL, ruleset DEFAULT 'srd-5.1', settings_json {xpMode, hpOnLevel, deathMode, levelUpMode, dawnIsLongRest, xpAward}, created_at, updated_at, archived_at)` | CREATE TABLE |
| 2 | `campaign_nodes(id, campaign_id → campaigns CASCADE, ord, kind CHECK IN (encounter,rest,loot,shop,story), title, payload_json, next_json, updated_at)` + index `(campaign_id, ord)` | CREATE TABLE |
| 3 | `encounter_templates(id, campaign_id → campaigns CASCADE, name, setup_json, setup_v, created_at, updated_at)` | CREATE TABLE |
| 4 | `campaign_assets(id, campaign_id CASCADE, kind map\|token, rel_path 'campaigns/<id>/<sha>.<ext>', mime, bytes, sha256, width, height, grid_json, created_at)`: the `uploaded_maps` caps; materialised into the room's `uploaded_maps` on node entry (`ux_uploaded_maps_room_sha` dedupes) | CREATE TABLE |
| 5 | `runs(id, campaign_id → campaigns SET NULL, room_id UNIQUE → rooms (no cascade), status CHECK, outcome, current_node_id, campaign_json, settings_json, stash_json, rng_json, seq, created_at, updated_at, ended_at)` | CREATE TABLE |
| 6 | `run_events(run_id, seq, ts, node_id, actor_kind, actor_id, type, override, payload_json, PRIMARY KEY(run_id, seq)) WITHOUT ROWID` | CREATE TABLE |
| 7 | `run_snapshots(id, run_id CASCADE, label, at_seq, blob_json, created_by, created_at)` | CREATE TABLE |
| 8 | `run_items(id, run_id CASCADE, owner_slot_id → party_slots SET NULL, origin CHECK, ref_key, name, qty CHECK ≥ 0, equipped, attuned, charges_spent, data_json, updated_at)` | CREATE TABLE |
| 9 | `level_ups(id, run_id, slot_id → party_slots CASCADE, from_level, to_level, class_name, mode CHECK auto\|choose\|reconcile, status CHECK pending_player\|pending_dm\|applied\|reverted, auto_json, choices_json, granted_json, created_at, decided_at, decided_by)` | CREATE TABLE |
| 10 | `run_roster_archive(id, run_id, slot_id, seat, character_id, name, sheet_json, state_json, level, xp, life_status, reason, archived_at)` | CREATE TABLE |
| 11 | `items_cache(key PK, document_key CHECK = 'srd-2014', kind item\|magicitem\|spell, name, payload_json, fetched_at)` | CREATE TABLE |
| 12 | `party_slots` ADD COLUMN `run_id → runs SET NULL`, `level CHECK 1–20`, `xp NOT NULL DEFAULT 0 CHECK ≥ 0`, `life_status NOT NULL DEFAULT 'active' CHECK IN (active,dying,stable,dead)`, `version NOT NULL DEFAULT 0`, `seed_raw_sha`; partial index on `run_id` | ALTER ADD COLUMN |
| 13 | `CREATE VIEW run_characters AS SELECT … FROM party_slots WHERE run_id IS NOT NULL` | CREATE VIEW |
| 14 | `uploaded_maps` ADD COLUMN `kind NOT NULL DEFAULT 'map' CHECK IN (map, token)` | ALTER ADD COLUMN |
| 15 | `encounters` ADD COLUMN `run_id → runs SET NULL`, `node_id`, `run_applied_at` | ALTER ADD COLUMN |

**Changes that would need a rebuild, and how this plan avoids them:**
- **Renaming `party_slots`:** replaced by the step 13 view.
- **Dropping `party_slots.room_id NOT NULL … ON DELETE CASCADE`** so a
  party outlives its room: avoided because the run pins its room
  (decision 2) and the janitor skips run rooms.
- **Relaxing `UNIQUE(room_id, seat)` / `seat BETWEEN 1 AND 6`** so a
  dead PC and its replacement share a seat: avoided with the step 10
  archive.
- **Adding `between` to the `rooms.status` CHECK:** avoided because
  `between` lives in `runs.status` and the protocol only.
- **Making `uploaded_maps.room_id` nullable** for campaign maps: avoided
  with the step 4 table.

One caveat: `store.js upsertSeat` nulls `sheet_json` and `state_json`
when a seat's character changes. B25 must archive the old row before it
seats a replacement.

---

## Task list

Sizes and the gate rule are M64's: S ≤ 1 day, M 2–4 days, L 1–2 weeks
of agent work. Every task ships with node:test coverage and a green
`set -o pipefail; npm run lint && npm test && npm run build`.

### Wave 0 — contracts, carry-ins, schema
| ID | Owner | Task | Size | Gate |
|---|---|---|---|---|
| H21 | E6 | `src/js/shared/campaign.js`: campaign/node v1 validators, per-kind payload specs, `next_json` edges, pure `nextNodes`, graph checks (one start node, no dangling edges, reachability) | M | A planted dangling edge or unknown kind fails; imports under both Vite and Node |
| H22 | E6 | `src/js/shared/run-state.js` (state_json v1 validator, `initialRunState`, run snapshot blob) + `run-events.js` (run catalogue v1) | M | Every M64 state_json field validates; a mutating event without `{before, after}` fails |
| H23 | E6 | Protocol v1.4 + events v1.2 (above); `fake-transport.js` updated | S | Contract tests; the fake still validates every frame |
| H24 | E6 | Run golden harness `src/tests/helpers/run-driver.js`: drives the pure layer + engine for a scripted run (no ws); `UPDATE_GOLDEN=1` | M | Fight → short rest → fight with Saris + fighter fixtures, < 1 s, reproducible from its events |
| R21 | E4 (+E1 patch) | **M64 R9 carry-in:** death saves at turn start, nat 1 / nat 20, damage at 0, crit = 2 failures, massive damage, healing resets, stable; monsters die at 0; `death.save` event | M | SRD p.98 cases as tests; a dying PC healed by Healing Word acts on its next turn |
| R22 | E4 → E3 patch | `statBlockFromOpen5e` carries `xp` (`experience_points`) and `cr` (decimal → `CR_XP` key); presets get `cr` | S | `srd_goblin` → xp 50; a preset bandit → 25 |
| B21 | E3 | Migration 0003 as specified | M | A copy of a phase-1 DB with a live room migrates, and S1 passes unchanged; every CHECK, view and partial index tested; deleting a run's room fails at the FK |

### Wave 1 — pure rules and engine seams (E4 ∥ E1 ∥ E3 ∥ E5)
| ID | Owner | Task | Size | Gate |
|---|---|---|---|---|
| R23 | E4 | Parser progression: per-class `progression` (hit die, `hitDiceUsed`, all `levelSpellSlots` rows, known/prepared maxima, full feature ladder with `requiredLevel` + `limitedUse`, `levelScales`); `currency`; equipment-shaped stats + DDB `definition.id` on every `inventory[]` row; `resources` map with recovery periods | M | Saris → hit dice `{Cleric: {die: 8, spent: 3}}`, gp 165, ladder to L19; no Warlock fixture → pact only, flagged |
| R24 | E4 | `src/js/campaign/xp.js`: SRD p.56 thresholds, `CR_XP` moved here (calibrator imports it, E1 patch), `encounterXp`, `levelForXp`, milestone | S | 4 goblins / 4 PCs → 50 each; 2,700 → L4, 2,699 → L3 |
| R25 | E4 | `src/js/campaign/rest.js`: `REST_TYPES` + `applyRest` → `{state, deltas, rolls}` | M | R3's 3-node AC; pact slots recover on a short rest; overspending hit dice rejected; long rest at 0 HP refused |
| R26 | E4 | `src/js/campaign/level-up.js`: `planLevelUp`, `applyLevelUp` → `{sheet, state, granted}`, `revertLevelUp`, `reconcileDiff` with the level guard | L | Saris 4→5 gets slots {1:4, 2:3, 3:2} and HP +5 + CON; revert restores a byte-identical sheet; DDB level 6 vs granted 5 refused |
| R27 | E4 | `src/js/campaign/items.js` + `consumables.js`: item model, `itemToEquipment` (Open5e armour/weapon → parser shape), equip/attune rules, potion table, pricing | M | Equipping Breastplate at DEX +3 → `deriveAC` 16; Potion of Healing ∈ [4, 10]; Acid's "0.00" → unpriced |
| R28 | E4 | `src/js/campaign/death.js` + `downtime-spells.js`: life-status transitions, `deathMode`, Revivify / Raise Dead, between-node Cure Wounds / Healing Word / Prayer of Healing spending slots | M | Permadeath refuses Revivify; standard Revivify → 1 HP, a 3rd-level slot and a diamond spent |
| R29 | E4 (+E1 patch) | Exhaustion 2–6: speed halved / 0, HP max halved, death at 6 via entity seeding; level 3 disadvantage in `combat-resolver.js` | S | One test per level |
| T21 | E1 | Run-state seam in `encounter-adapters.js`: `entityFromSheet(sheet, {runState})` seeds HP, temp HP, slots, pact, features, granted-spell uses, death saves, exhaustion and persistent conditions; `runStateFromEntity(entity, prev)` writes back; resource key map | M | Property round-trip over simulator runs keeps every untouched key; with no `runState`, phase-1 goldens are byte-identical; a feat Misty Step spends its use, not a slot |
| T22 | E1 | `endEncounterCleanup(ts)` in `turn-manager.js` replaces `resetPerEncounterFlags` (deleted) | S | Grep finds no `resetPerEncounterFlags`; Action Surge spent in fight 1 stays spent in fight 2 until a short rest |
| T23 | E1 | Item action: plan kind `item`, `validateIntent` (quantity, self or adjacent ally, action economy), `applyHealing`, `item.used`; a potion consideration for AI below its heal threshold | M | A zero-quantity potion is rejected; a dying ally fed a potion stands up; simulator goldens unchanged with no items |
| B22 | E3 | `api/campaigns/**`: create → `{campaignId, campaignKey}`, node CRUD validated by H21, templates saved from a room's setup (copies its map into `campaign_assets`), asset upload via `image-sniff.js` + quotas, JSON export/import with attribution | M | Wrong key → 401; a template with an uploaded map renders in a different room; no DDB prose in an export |
| B23 | E3 | `api/runs/store.js` (prepared statements, `version` check); janitor rule (no deleting rooms with live runs; ended runs aged out at 90 days); `/api/srd/{items,spells}` proxy with the verified filters + `items_cache` | M | A 31-day-idle run room survives; a non-`srd-2014` key is never cached |
| M21 | E5 | Token images: `uploaded_maps.kind='token'` upload (≤ 1024 px), `statBlock.tokenImageId`, bake-cache key gains the image id, image-token render path; a dead PC renders as a corpse (death fade), not hidden | M | 0 `getImageData` per steady frame (M7 rule); the corpse is visible on the next encounter's map |

### Wave 2 — run runtime (E3 lead, E1 reviews engine touch points)
| ID | Owner | Task | Size | Gate |
|---|---|---|---|---|
| B24 | E3 | `api/runs/run-controller.js` attached to `Room`: start run (room + run + seats; seed → `sheet_json` + `state_json`, rested unless the DM sets `importDdbState`); node entry (encounter via `buildEncounter` with run states + template, or a between kind); **one `onEncounterEnded` hook called from `#runOneTurn` and `#endEncounter`**, idempotent via `run_applied_at`; branching via `nextNodes`; run end | L | SIGTERM in `between` and mid-transition → identical run hash after restore; write-back runs exactly once across replay |
| B25 | E3 | Between intents: rest, loot, shop, story, equip/give/use, level-up choose/confirm/revert, reconcile, revive/retire, fill seat (archive first) | L | A role test per intent; wrong seat / live encounter rejected; one `run_events` row with before/after per mutation |
| B26 | E3 | Save/load and rejoin: `run_snapshots` between nodes only; load appends `snapshot.restored` and never deletes events; DM recovery with the campaign key; `seat.reclaim` by code (DM approves; automatic when the old participant left or was kicked) | M | A lost DM token is recovered; a player on a new browser reclaims their seat |
| B27 | E3 | Run views and privacy: `viewForRun` (players see visited nodes + offered edges); `GET /api/rooms/:id/seats/:slotId/sheet` serves the run sheet, full or `publicSheet`; `/api/characters/:ddbId` needs a member token under `CF_MULTIPLAYER=1` | M | A second player never receives another seat's `classFeatures[].description` (asserted over every route and ws frame) |
| B28 | E3 | Solo mode: `POST /api/rooms {mode:'solo'}` → setting `dmDrivesAiSeats`; AI seats get `controller:{type:'dm'}` unless auto-fight is on | S | One DM drives four PCs and toggles auto-fight mid-encounter |

### Wave 3 — clients (E2; C21–C23 may start in Wave 2 against B22/B24)
| ID | Owner | Task | Size | Gate |
|---|---|---|---|---|
| C21 | E2 | Campaign list + editor (`views/campaigns.js`, `views/campaign-editor.js`): keys kept in localStorage, node list + SVG chain graph, per-kind editors, campaign settings, template picker, asset upload, validate before "Start run" | L | A 5-node branching campaign authored end to end; an invalid graph blocks Start |
| C22 | E2 | `views/setup.js`: "Save as template" / "Load template"; in a run, pre-filled from the node | S | Save → load round-trips the exact `setupPayload` |
| C23 | E2 | `client/run-store.js` (seq-ordered, resync) + `views/run-map.js` (players and DM) | M | Unvisited node titles never render for players; duplicate or out-of-order run events ignored |
| C24 | E2 | `views/between.js` hub: rest (hit-dice picker with `rest.js` preview), loot (claim / assign / split), inventory + equip (AC and attack preview via `pc-stats`), potion use | M | The equip preview's AC equals the next encounter's AC |
| C25 | E2 | `views/level-up.js`: auto summary, ASI / spell / class choices, DM confirm, revert, reconcile diff via `describeDiff` | M | Saris 4→5 through the UI; DM confirmation required in choose mode |
| C26 | E2 | `views/shop.js` + `views/story.js` | M | Buying past the stash is rejected with a readable reason |
| C27 | E2 | `views/run-dashboard.js` (DM): party table (HP, hit dice, slots, resources, XP, status), XP adjust, pending level-ups, revive / retire / fill seat, snapshots, run log, advance / branch | M | Every action is an intent; the dashboard's hash equals the server's run hash |
| C28 | E2 | Durable creds per room code (localStorage, "forget this device"), rejoin by code, SRD attribution, sheets loaded from the B27 route | S | Close the tab, rejoin, and the seat is back; a lint rule bans `api.getCharacter` in run views |

### Wave 4 — retire versus, acceptance (E2, E1, E6)
| ID | Owner | Task | Size | Gate |
|---|---|---|---|---|
| V21 | E2 | Forge handoff: the versus panel's start button becomes "Play at the table": it imports the forge party into a solo room (B28), pre-fills setup with the queued monsters and the map, and opens play.html | M | The PR's parity checklist: manual attack/cast, auto-fight, reactions, cinema styles, calibrator card, quick stats all exist in play.html |
| V22 | E2 | Delete the `main.js` combat driver (`startVersusFight`, `runVersusPartyAuto`, `runEngineTurn`, `runManualWeaponAttack`, `runManualCast`, `runAttackPrompt`, `runSpellSavePrompt`, `endVersusFight` and their module state) after one release behind `?classic=1` | L | `main.js` shrinks by ≥ 1,200 lines; nothing imports `live-bridge.js`; frozen-3d job green |
| T24 | E1 | Delete `live-bridge.js` and engine paths only it used; update CLAUDE.md's "three callers" (now simulator + server room) | S | Grep clean; CLAUDE.md updated |
| S21 | E6 | Run smoke over real sockets: DM + 2 players, a 3-node campaign (fight → short rest → fight with loot), hit dice, potion, an XP level-up; identical run hash and seq on all clients | M | < 8 s inside `npm test` |
| S22 | E6 | Restart variants: SIGTERM in `between`, with a level-up pending, and mid-encounter in node 3 | S | Identical run hash after each restore |
| S23 | E6 | Acceptance pass + licensing audit (every outbound frame and route scanned for prose fields; attribution present) | S | Report against this table |

**Totals: 5 waves, 39 tasks — 11 S, 23 M, 5 L.** About 9–11
engineer-weeks of agent work. **E4 is the long pole in Wave 1**
(7 tasks). R28/R29 may slip into Wave 2 without blocking B24, which
needs only R24–R27 and T21–T23.

### Not in M65 (carried; owner may promote)
M64 R10 Extra Attack (land it before a level-5+ playtest), full R11
normaliser, fog-filtering of `entity.updated` (phase 1.5 gap),
turn-level rewind, simulator BFS pathing, grid facing, prepared-spell
swap, condition durations across nodes, inspiration, an offline host.

---

## Branch plan and merge order

| Branch | Owner | Sole writer of | Lands in |
|---|---|---|---|
| `p2/e6-harness` | E6 | `src/js/shared/**` (incl. `campaign.js`, `run-state.js`, `run-events.js`), `src/js/client/fake-transport.js` (contract updates only), `src/tests/{fixtures,helpers,golden}/**`, `api/tests/**`, CI, `package.json` scripts | W0, W4 |
| `p2/e4-rules` | E4 | `src/js/campaign/**` (new), `api/lib/ddb-parser.js`, `pc-stats.js`, `combat-resolver.js`, `class-feature-rules.js`, `save-rolls.js`, `ai/pc-features.js`, `monster-spells.js` | W0, W1 |
| `p2/e1-engine` | E1 | `combat-engine.js`, `encounter-adapters.js`, `turn-manager.js`, `intent-validation.js`, `calibrator.js`, `simulator.js`, `ai/*` (except `pc-features.js`), `live-bridge.js` (deletion) | W1, W4 |
| `p2/e3-server` | E3 | `api/**` except `api/lib/ddb-parser.js` and `api/tests/**` (incl. new `api/runs/**`, `api/campaigns/**`, migration 0003, `janitor.js`, `real-engine.js`, `room.js`), `package.json` deps, `DEPLOY.md` | W0–W2 |
| `p2/e5-map` | E5 | `src/js/map/**`, `map-render.js`, `compositor.js` (battle path) | W1 |
| `p2/e2-client` | E2 | `main.js`, `index.html`, `play.html`, `src/js/play.js`, `src/js/client/**` (except the fake), `src/styles.css`, `vite.config.js`, `eslint.config.js` | W2–W4 |

Merge order:
1. W0: E6 → B21 → R21/R22.
2. W1: E4's R23–R25, then E1's T21–T23 (they consume R23's fields),
   then B22/B23 and M21.
3. W2: B24 → B25–B28.
4. W3: E2.
5. W4: V21 → V22 → T24 → S21–S23.

M64's rules carry over:
- One branch per wave touches `package*.json`.
- Migration numbers are assigned at merge.
- A contract change bumps the minor and needs every owner's
  acknowledgement.
- Rebase-merge.
- The seven-point pre-merge checklist.

New rule: **no task adds a combat rule outside `src/js/scene/` or a
progression rule outside `src/js/campaign/`.** `api/runs/**` sequences
and persists; it does not compute 5e.

---

## Risk register

| # | Risk | L | I | Mitigation |
|---|---|---|---|---|
| 1 | **Split-brain run state.** `EncounterState` and `state_json` both hold HP and slots; a double or missed write-back corrupts the run | High | High | Decision 3: time-split authority, one hook for both end paths, `run_applied_at` idempotency, boot sweep for unapplied ended encounters, `version` optimistic lock, S22 restart tests |
| 2 | **Prose leak (live today).** `/api/characters/:ddbId` is unauthenticated and serves DDB prose to every client; snapshots and exports could spread it further | Certain | Med–High | B27 lands before any run is playable; S23 scans every frame and route; `items_cache` CHECK on the SRD key |
| 3 | **Parser ladder unverified.** One real character (Cleric 4); Warlock, multiclass, milestone and 2024-rules exports are still missing, and DDB may be dropping `hitDiceUsed` | High | High | Owner fixtures before R23 freezes; a level-up falls back to DM-confirm whenever an auto field is missing; reconcile re-import as the safety valve |
| 4 | The janitor's cascade wipes a paused campaign's party | Med | High | B23 janitor rule + FK backstop + a 31-day test |
| 5 | Deleting versus from the 5,151-line `main.js` regresses the forge or touches the frozen 3D toggle | High | Med | V21 parity checklist first; one release behind `?classic=1`; single writer (E2); frozen-3d CI job; `--color-moved` review |
| 6 | Level-up choice scope creep (subclass, feats, invocations, non-SRD spells) | High | Med | Only ASI, existing-class levels and SRD spells are mechanised; the rest goes through reconcile or DM free text |
| 7 | Between-node rolls break replay | Med | Med | Persisted run RNG (decision 6); `Math.random` tripwire extended to `src/js/campaign/**` |
| 8 | A campaign edited during a live run desynchronises it | Med | Med | Frozen `campaign_json`; explicit "pull latest" |
| 9 | Open5e item data is wrong or missing (prices, potion amounts) | Certain | Low | SRD consumables registry; "0.00"/null → DM-priced; DM override per shop entry |
| 10 | DM loses the token, or a player loses creds, mid-campaign | High | Med | Campaign-key DM recovery; durable creds; `seat.reclaim` with DM approval |
| 11 | `play.js` / store complexity grows with ~10 new views | Med | Med | One module per screen; selectors unit-tested; run state in its own store slice |

---

## Owner questions (defaults the architect applies unless told otherwise)

| # | Question | Default |
|---|---|---|
| 1 | XP or milestone as the campaign default? | **XP** (game-owned, Fire Emblem feel); milestone is a campaign setting |
| 2 | HP on level-up: fixed average or roll? | **Fixed average** (SRD "or 5" for d8); roll is a campaign toggle, using the run RNG |
| 3 | XP award: automatic, or DM confirms each card? | **Automatic**, with `dm.xp.adjust` afterwards |
| 4 | Level-up mode | **Deterministic parts auto; ASI and spells chosen by the player and confirmed by the DM**; reconcile for everything else |
| 5 | Shop pricing source | **Open5e SRD `cost`** for mundane items; magic items and "0.00"/null entries DM-priced; sell at half |
| 6 | May players author their own notes? | **Yes:** per-character notes visible to the owner and the DM, plus shared party notes (needs an additive `run_notes` table); no player campaign authoring |
| 7 | Dying PCs when the party wins | **Auto-stabilised**; regain 1 HP on entering the next node (stands in for RAW's 1d4 hours) |
| 8 | Party wipe | **DM chooses:** end the run as a defeat, load a snapshot, or continue |
| 9 | Revival costs | **RAW material components as items** (300 gp diamond for Revivify, 500 gp for Raise Dead), sold in shops; DM override always available |
| 10 | Under permadeath, may the DM still revive? | **Yes, as a logged override** |
| 11 | Snapshots: between nodes only? | **Yes**; turn-level rewind stays deferred |
| 12 | Solo play: server-hosted solo room, or an offline in-browser host? | **Server-hosted solo room** (one runner, no new deps); offline host deferred |
| 13 | Campaign ownership before accounts | **Campaign key** (bearer, shown once) |
| 14 | A replacement character's level | **As imported**; the DM may grant levels up to the party's highest |
| 15 | Remember room creds across browser restarts? | **Yes, localStorage for run rooms**, with "forget this device" |
| 16 | What do players see of the campaign map? | **Visited nodes and the choices on offer**; the DM sees everything |
| 17 | Multiclassing at level-up | **Only into classes already on the sheet**; a new class goes through reconcile re-import |
| 18 | Keep `?classic=1` versus for one release before deleting it? | **Yes, one release** |
| 19 | Temp HP across nodes | **RAW:** kept until spent or a long rest |
| 20 | Please export the pending real characters (Warlock, multiclass, a milestone character, a 2024-rules character) | Needed before R23 is merged |
