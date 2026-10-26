# M65 — acceptance pass and licensing audit (S23)

Written 2026-10-25 by E6 against `main` @ 90b0edd (B28 + E1's potion-AI
tuning) plus S21–S23 on `p1/e6-harness`. Scope: every task in `docs/M65-CAMPAIGN-LOOP-PLAN.md`'s
task list, the licensing rules, and the items to settle before a
playtest.

## Headline

**32 of 39 tasks landed, 0 partial, 7 missing.** Everything server-side and
every rule is in: the contracts (H21–H24), the rules (R21–R29), the engine
seams (T21–T23), the run runtime (B21–B28), token images (M21), and the
first four client tasks (C21–C23, C28). Missing: the between-node client
screens (C24–C27) and the versus retirement (V21, V22, T24). A campaign
run can be played end to end over real sockets today (S21) and survives a
restart at any point (S22), but **a player has no UI for the between-node
steps yet**: rest, loot, potions, level-up, shop and story exist only as
protocol intents.

Checks at this commit: `npm test` **2,695 tests** (2,694 pass, 1 skipped,
0 fail; main @ 90b0edd without S21–S23 is 2,690), `npm run lint` **0 errors, 3 warnings** (budget 3;
all three predate M65: `main.js`, `sprite/compositor.js`,
`sprite/item-generator.js`), `npm run build` green.

## The run smokes (S21, S22)

- **S21** `api/tests/run-smoke.test.js`: the real server in-process. The DM
  authors a 3-node campaign over HTTP (`PUT /api/campaigns/:cid/graph`):
  a goblin ambush, then a short rest, then a bugbear den with a Potion of
  Healing and 50 gp on victory and `xpOverride` 15,000. The DM starts a
  lobby run with `POST /api/campaigns/:cid/runs`. Two players join by
  code, paste the fixtures and claim seats. Over E2's sessions the test
  then plays the whole run:
  - `dm.node.begin`, then `dm.entity.patch` to wound the fighter, then
    `dm.encounter.start`.
  - The players answer their own turns with real `turn.act` intents.
  - At the end of the fight, `run.updated` reaches `between`.
  - The fighter sends `rest.spend` and the DM sends `dm.rest.grant`.
  - The second fight, then `loot.granted`, `loot.claim` and `item.use`.
  - `xp.awarded` queues level 6 for both seats, and each gets a private
    `levelup.offer`.
  - `levelup.choose` with an ASI, then `dm.levelup.confirm`, then
    `dm.run.end`.

  Asserted:
  - All three clients receive the same `run.event` stream, seq and
    payload. It equals the server's run log as it goes on the wire
    (`stripProse`), and the run hash uses run-driver's definition.
  - All three clients see the same gap-free room seq stream.
  - The run-event-type golden matches
    (`golden/run-smoke.run-events.json`).
  - The final `run.snapshot` equals `replayRunEvents` (run-driver) over
    the log.
  - The run RNG stream equals run-driver's on the same seed. Both
    encounter seeds and the hit-die roll match. The fights themselves
    cannot be compared, because the driver plays them with the AI and the
    smoke plays them with player intents.
  - Each `state_json` validates against its run sheet.
  - No player frame carries another seat's prose.

  It takes about 150 ms.
- **S22** `api/tests/run-restart.test.js`: `node api/server.js` runs as a
  child with `PORT=0` and frame waits only. Each variant sends SIGTERM,
  then checks for exit 0, a 1012 close on every client, and a restart on
  the same data dir. There are three cuts:
  - **between**: the room reopens `between`, and then the rest node and
    the hit die run.
  - **level-ups pending**: one level-up is chosen and so `pending_dm`;
    the other is offered. Both offers return, the chosen ASI survives, and
    the DM confirms.
  - **mid-encounter in node 3**: the cut comes while the fighter's turn
    waits. The den comes back `paused` at the last turn end's stateHash.
    On resume the same turnId re-asks, the encounter ends once, and the
    loot lands.

  At every cut the reconnecting DM's `run.snapshot` hashes (`hash53`) as
  the pre-kill one and is deep-equal to it. The run seq then continues
  gap-free on all three clients. The three variants take about 1.3 s.

## Task by task

| ID | Status | Evidence (tests; commit) |
|---|---|---|
| H21 | landed | `src/tests/shared-campaign.test.js` (planted dangling edge / unknown kind fail); f6f2928 |
| H22 | landed | `shared-run-state.test.js`, `shared-run-events.test.js` (mutating event without before/after fails); 7426693, cc2e680, 13e36ca |
| H23 | landed | `shared-contracts-m65.test.js` (protocol v1.6, events v1.4; the fake transport validates); a4363f0 |
| H24 | landed | `run-golden.test.js`, `run-tripwire.test.js`, `golden/fight-rest-fight.run.json`; a857e55, 52f5d4d, d368024 |
| R21 | landed (phase 1.5) | `m64-dying.test.js`, `client-dying.test.js`, S1 `smoke-death-save` golden |
| R22 | landed (phase 1.5, check) | `m64-rules-open5e.test.js` (SRD xp/cr per creature), `m65-statblock-sim.test.js`; S21's goblins award 50 XP each |
| R23 | landed | `ddb-parser.test.js`, `campaign-spell-slots.test.js`, `m65-run-state.test.js`; 50994b2 |
| R24 | landed | `campaign-xp.test.js`; 28d4cb3 |
| R25 | landed | `campaign-rest.test.js`; 222a4a9 |
| R26 | landed | `campaign-level-up.test.js` (byte-identical revert, DDB level guard); 30a887e |
| R27 | landed | `campaign-items.test.js`; 8e9914c |
| R28 | landed | `campaign-death.test.js`; 7f88ff8 (downtime heals are rules only, see below) |
| R29 | landed | `campaign-exhaustion.test.js`, `m65-exhaustion-saves.test.js`; 0eeae6e |
| T21 | landed | `m65-run-state.test.js`, `run-golden.test.js`; adc2491, b897a30 |
| T22 | landed | `m65-encounter-cleanup.test.js` (no `resetPerEncounterFlags`); f46f560 |
| T23 | landed | `m65-item-action.test.js`, `m65-simulator-items.test.js`; 650c842, AI tuning 1c1d995 + 90b0edd |
| T24 | **missing** | `src/js/scene/live-bridge.js` still exists; CLAUDE.md still lists three callers |
| B21 | landed | `migration-0006.test.js`; c8bf6f8 |
| B22 | landed | `campaigns.test.js`; 301eb89 |
| B23 | landed | `runs-store.test.js`, `janitor.test.js` (31-day idle run room survives), `srd-proxy.test.js`; c18c32a |
| B24 | landed | `run-controller.test.js` (SIGTERM between / mid-transition / mid-encounter, write-back once), S21, S22; f7873a6, d0a7e54 |
| B25 | landed | `run-intents.test.js` (a role test per intent, before/after per mutation), S21; 87970e6 |
| B26 | landed | `run-save-rejoin.test.js`, `runs-http.test.js`; 8fcc8fd |
| B27 | landed | `run-privacy.test.js`, `runs-http.test.js`, S21 frame scan, S23 route scan; aec3587 |
| B28 | landed | `solo-room.test.js`; f30ab10 |
| M21 | landed | `map-m21-token-images.test.js`; fece4e1, 3b96582 |
| C21 | landed | `client-campaign-editor.test.js`; 5ed061e |
| C22 | landed | `client-setup-templates.test.js`; f7d14ec |
| C23 | landed | `client-run-store.test.js`; 47037c0 |
| C24 | **missing** | no `views/between.js` (rest picker, loot, inventory/equip, potion) |
| C25 | **missing** | no `views/level-up.js` |
| C26 | **missing** | no `views/shop.js` / `views/story.js` |
| C27 | **missing** | no `views/run-dashboard.js` (DM party table, XP adjust, revive/retire, snapshots, advance) |
| C28 | landed | `client-durable-creds.test.js` (rejoin, attribution, the no-`getCharacter` guard); a318fe1 |
| V21 | **missing** | the forge's versus panel has no "Play at the table" handoff |
| V22 | **missing** | `main.js` is 5,143 lines and still holds `startVersusFight` / `runVersusPartyAuto` / `runAttackPrompt` |
| S21 | landed | `api/tests/run-smoke.test.js`; d307e68 |
| S22 | landed | `api/tests/run-restart.test.js`; e41d9f6 |
| S23 | landed | this file + the S23 test in `run-smoke.test.js` |

## Licensing audit

| Check | Result | Evidence |
|---|---|---|
| A player never receives another seat's prose on any ws frame of a full run | pass | S21 scans every frame both players received in a full run (more than 100 each): fight, rest, loot, potion, level-up, end. `run-privacy.test.js` scans the B25 intents plus snapshots and resync. |
| Every member GET route a seated player can call | pass | S23 test: `/api/rooms/:id`, `/api/rooms/:id/run`, `/api/rooms/:id/seats/:otherSlot/sheet` (returns `prose: 'stripped'`), `/api/characters?room=`, `/api/characters/:otherId` (returns `prose: 'stripped'`), `/api/rooms/:id/maps` and `/api/licenses`. Each player calls them with their own token after a full run, and no body contains the other seat's prose. The player's own seat sheet keeps its prose, so the scan is not vacuous. Without a token, `/api/characters/:id` is 401 under `CF_MULTIPLAYER=1`. |
| Run events on the wire | pass | Every `run.event` goes through `stripProse`. The stored log keeps the full record server-side; `level.applied`'s `granted` patch holds feature prose. |
| Campaign export | pass | It carries `attribution` equal to `/api/licenses`. It contains no sheet prose (S23 test) and no DDB prose (`campaigns.test.js`). |
| `/api/licenses` | pass | It returns `{srd: {name: 'System Reference Document 5.1', license: 'CC-BY-4.0', attribution}}` with the plan's text, including both URLs. |
| play.html footer / About dialog | pass, with a gap | `src/js/play.js` renders the `/api/licenses` text in the footer and the About dialog. Its offline fallback (`SRD_ATTRIBUTION_FALLBACK`) is shortened and drops both URLs, so it is **not word for word**. Fix: use the full text. |
| `items_cache` admits only `srd-2014` | pass | `runs-store.test.js`, `srd-proxy.test.js`, and the B21 CHECK in `migration-0006.test.js`. |
| Snapshots carry no prose to players | pass | `run-privacy.test.js` saves and resyncs a snapshot. `viewForRun` strips item prose and never names unvisited nodes. |

Not automated: the gate's word-for-word check of the attribution against
the SRD 5.1 PDF's Legal Information page. The text matches the plan's
quote; someone should compare it with the PDF once before shipping.

## Before a playtest

E3's "incomplete or simplified" items (B24–B28 hand-back), checked against
the code:
1. **`levelup.choose` writes no run event.** The picks live only on the
   `level_ups` row (`choices_json`, `pending_dm`). They survive a restart
   (S22), but replaying the log does not show them until
   `level.applied`.
2. **Pending rests are in memory.** `RunController.pendingRest` is not
   persisted. A restart between `rest.spend` and `dm.rest.grant` loses the
   declared hit dice, so players must declare them again. S22 cuts before
   `rest.spend` for this reason.
3. **`levelUpMode: 'auto'` still waits for the DM.** `#queueLevels` puts
   every non-`choose` level-up in `pending_dm`, and nothing applies it
   automatically.
4. **Downtime heals are not wired.** `src/js/campaign/downtime-spells.js`
   (Cure Wounds / Healing Word / Prayer of Healing between nodes) exists
   and is tested, but no run intent calls it.
5. **Milestone levels go through `dm.xp.adjust`.** There is no
   milestone-mode grant intent. The DM adds XP by hand, and that queues
   the level.

E1's potion-AI finding (T23): the AI drank a potion as a reflex below 50%
HP and spent its action doing so. A solo Fighter 5 vs orc + goblin
carrying 2 Potions of Healing fell from 0.780 (no items) to 0.580 win
rate. **Status: fixed in Wave 3** by 1c1d995 and 90b0edd, now on
`origin/main`:
- An expected-value gate decides when to drink, with a `potion`
  actionWeight per archetype and no drinking when the fight is nearly
  won.
- The same bench now wins 0.783 with 2 potions.
- Drinks per 4v4 fight fell from 0.28 to 0.02.
- `calibrateEncounter` reports `perEntity[].itemsUsed`.

Found by S21–S23:
6. **No client UI for between nodes (C24–C27).** Without these views a
   playtest needs a DM console or test scripts for rest, loot, potions,
   level-ups, shop and story.
7. **Duplicate `levelup.offer`.** After an encounter that queues
   level-ups, each seat and the DM receive the same offer twice.
   `onEncounterEnded` calls `#afterChange`, whose `sendSnapshot` offers
   to each member, and then calls `#offerLevelUps()` again. The offers
   are harmless (the same `levelUpId`), but a client that toasts each
   offer will show two.
8. **After a restart, a resumed turn is not announced.** A turn that was
   waiting for its intent replays under the same turnId and waits again.
   No new `turn.started` is broadcast. `room.turn.awaitingIntent` appears
   only in a fresh `room.snapshot`, and the snapshot a client gets on
   reconnect shows `turn: null` because the room is paused. A player who
   reconnected before the DM resumed must resync, or infer the turn from
   `history`. S22 resyncs.
9. **The run hash is not visible to clients.** `run.started` is emitted
   at `POST /runs`, before any socket exists. No route serves the run
   event log, and `run.snapshot` carries no hash, so a client cannot
   compute the run hash from seq 1. C27's gate ("the dashboard's hash
   equals the server's run hash") needs one of these: a hash on
   `run.snapshot`, or a `GET /api/rooms/:id/run/events` route.
10. **The XP threshold in the S21 brief.** The brief asked the second
    fight to cross 300 XP. Both fixtures are level 5 (6,500 XP), so S21
    crosses the level-6 threshold (14,000) with `xpOverride` instead.
11. **CI lint budget.** `ci.yml` allowed 4 warnings while `npm run lint`
    allows 3. This commit aligns CI to 3.
