# M64 — Online table: engine on the server, rooms, DM seat

## Status
Drafted 2026-10-14 from a ten-agent review (four research briefs,
six engineering reviews) of `main` @ 30d8cce. **Phase 1 approved by
the owner 2026-10-14**; Wave 0 and Wave 1 launched the same day. The
ten source reports live in the session scratchpad; this document is
the canonical summary.

**2026-10-15 — Wave 0 and Wave 1 merged to main** (E3a, E2a, E6, E1a
in that order; 22 commits; 1,518 tests, 4 skipped pending T2/T5/T7/T8
goldens). Found during the build:
- **F11 (E2):** live versus monsters never received `_slots`,
  `_innate` or `_reactionUsed` because the seeding loop ran after
  `buildPartyArenaScene` had copied the instances; the engine's lazy
  `_innate` init masked it. Fixed; live monsters now actually cast
  and heal.
- `choosePcAction` leaves `_mctsTargetCtx` (an entity copy) on the
  wrapper, breaking JSON round-trip for any AI-planned PC turn.
  T5 must treat it as transient.
- Contract naming decisions from E6 win over R1's names: `move`,
  `spell.cast`, `spell.countered`, `reaction.offered`; reaction kinds
  `oa|shield|counterspell`; `encounter.ended.outcome`; DM intents
  `dm.entity.add/remove`, `dm.terrain.paint`; a `redacted` broadcast
  keeps `seq` gap-free under `viewFor`.
- The T10 import ban is scoped around `live-bridge.js` until T5 splits
  `scene-state.js` into a pure model + storage adapter.

**2026-10-16 — Phase 1 built: Waves 2, 3 and 4 merged to main**
(d9d143e; 92 commits since the plan; 2,008 tests, 1 todo; lint 3/3;
CI frozen-3d gate green). E6's acceptance pass: 57 of 63 task IDs
landed, 6 partial, 0 missing (R9–R11 are phase 1.5 by design). The
end-to-end smoke test boots the real server with the real engine,
drives a DM and a player over real sockets through create → join →
import → claim → setup → start → attack → cinema → `turn.ended`, and
asserts identical `seq` and `stateHash` on both clients; the restart
variant SIGTERMs mid-encounter and restores a `paused` snapshot with
the same hash on the same DB.

Closed after the acceptance pass (both on main by b969efc):
- **Simulator hot loop:** the true regression was 1.9x (27 → 50 ms per
  200×4v4), from a per-turn `delete` that dropped engine wrappers into
  V8 dictionary mode, allocation-heavy condition helpers, and dice
  strings re-parsed on every roll. Fixed to ~32 ms with byte-identical
  goldens; `m64-sim-hotpath.test.js` pins the fast-properties rule.
  The 720 ms–6.5 s readings were machine load and a sleep/clock jump,
  so bisect by instructions retired, not wall time.
- **CI Node 24 (Linux) failures:** better-sqlite3 11's `Statement` is
  a `node::ObjectWrap`, and Node 24.19+ aborts in its cleanup hook on
  GC (nodejs/node#65446). Upgraded to better-sqlite3 ^13 (N-API). Every
  worktree needs a fresh `npm ci` for the new native module.

**2026-10-25 — Phase 1.5 built: Waves 5 and 6 merged to main**
(7c90c65; 2,242 tests, 1 skipped by design; lint 3/3; CI green).
Landed: Extra Attack + monster Multiattack (R10), dying / death saves /
stable / dead (R9), the Open5e stat-block normaliser parsed from SRD
text with 21 fixtures (R11) and wired into the room so searched
monsters fight with real AC, attacks, saves, R/I/V, breath weapons,
legendary actions and Legendary Resistance; feat-granted spells spend
their own uses; a `feature` action kind (Second Wind, Rage); Fighting
Styles + off-hand attack; cantrip scaling; cover; Misty Step and
Eldritch Blast; damage-type defenses and feature-use counts from the
import; fog redaction of incremental traffic with per-seat hashes;
PC sheets persisted with the encounter (migration 0003); engine-
authoritative reactions; room settings; the auth gate on
`GET /api/characters/:ddbId` (migration 0004); token images for
non-humanoid monsters (migration 0005); the client mirror complete
enough that the shared `stateHash` check is on with zero resyncs;
dying UI; grouped multi-swing cinema; grid facing, death fade, 2×2
rendering; the M45 calibrator doc regenerated with its history and a
CI drift check; the S1 restart smoke made deterministic; the speed
test gated on CPU time.

E6's 1.5 acceptance: 8 of 14 deferred items landed, 5 partial
(below), 1 owner-only (iOS tint check). Remaining before a playtest:
- The simulator and the DM's live calibrator card ignore `statBlock`,
  so difficulty estimates for Open5e monsters are wrong. [E1]
- Preset monster damage carries `type: null`. [E4]
- Large creatures draw 2×2 but move and fight as 1×1; the diagonal
  setting accepts only `5ft`. (Owner defaults; phase 2.)
- Still no real Warlock / multiclass DDB exports. [owner]
- `MONSTER_SPELLCASTING` spellbooks are keyed by preset slug, not the
  stat block's `spellcasting`. [E1]
- Innate recharges now emit `resource.recharged` (events v1.3).

Partial / known gaps carried into phase 1.5 (owners in brackets):
- Fog: `entity.updated` and engine events are not yet fog-filtered,
  and players under fog get a `stateHash` of the unfiltered state. Fog
  is a phase 2 feature; the hooks exist. [E3]
- The client's `stateHash` check is off because the event stream does
  not carry resource ledgers; the client resyncs from snapshots. [E2/E1]
- PC sheets are re-read from seats / the character cache after a
  restart rather than persisted with the encounter. [E3]
- Open5e monsters still fight with preset AC/attacks (R11, phase 1.5);
  the encounter builder labels it "fights as: <preset>". [E4]
- Large creatures are 1×1; 5-ft diagonals only. (Owner defaults.)
- iOS tint check (Safari `ctx.filter` fix, M7) is manual and pending
  a real device. [owner]
- The `?fake=1` demo is single-tab (DM + AI seats); multi-browser
  play needs the real server. Initiative reorder is ↑/↓, not drag.
- `api/server.js` turned `PORT=0` into 3101 (fix in flight). [E3]
- Warlock pact-slot shape and per-weapon proficiency ids are
  unverified until real exports arrive. [owner → E4]
- The AI casts feat-granted spells (Misty Step) from a slot instead of
  the feat's uses; `validateIntent` already checks uses. [E1]

**Re-partition for Waves 2–4** (file ownership wins over the original
task owner): E1 takes R1, R2, R3, R12, R13 (engine/roll files) in
Wave 2; E4 does R5, R6, R14 now and R4, R7, R8 after E1b merges;
M8 (input-handler intents in `main.js`) moves to E2; E5 ships the
calibration UI (M9) as a module under `src/js/map/` that E2 mounts.
Waves 2, 3 and the pure parts of Wave 4 (C5, C6, C7) run in parallel
since their files are disjoint; B8's engine wiring and C8/C9 wait
for E1b.

Decisions taken at approval (override the defaults table below):
- **Seeding:** imported characters start fully rested; a per-room DM
  toggle imports D&D Beyond's current HP, used slots and used features.
- **Fixtures:** the owner exports 4–5 more real characters (Sorcerer,
  Warlock, Fighter 5 with a +1 weapon, Barbarian, a multiclass);
  engineers scrub names and ids into committed fixtures. Parser task
  R14 waits for them.
- **DM roll edits:** monster and AI rolls only. HP and condition edits
  apply to anyone.

---

## Product decisions (locked by the owner, 2026-10-14)

1. **Genre:** Fire Emblem / XCOM style tactical campaign — a chain of
   grid encounters with rest, loot, XP and leveling between fights.
2. **Play model:** online, with a human DM. The DM is a referee: the
   existing monster AI runs monsters by default, and the DM can
   override any action, roll, HP or condition live.
3. **Progression:** the game owns it after import. D&D Beyond is the
   seed only.
4. **Netcode:** server-authoritative. Node owns the state and runs the
   combat engine; browsers send intents and receive events. `ws` on
   the existing Express server; no multiplayer framework.
5. **Rendering:** **2D LPC canvas** for play (decided by research, see
   below). The Three.js track stays an opt-in character showcase.
6. **Rules content:** whatever the imported DDB character JSON holds,
   including non-SRD. Monsters stay Open5e **SRD 5.1 only**.
7. **Identity:** room code + display name now; schema ready for Discord
   OAuth later with no destructive migration.
8. **Table size:** 1 DM + up to 6 players; the DM may fill seats with
   AI-run party members.
9. **Maps:** DM uploads a battle-map image and calibrates a grid. The
   generator stays as an alternative.
10. **3D track is frozen** (`src/js/anim/three-*.js`, `modular-*.js`,
    `public/assets/3d`): review only, no edits, enforced in CI.
11. **Constraints:** vanilla ES modules, no UI framework, minimal deps
    (`ws` plus small utilities). Vite, Express, better-sqlite3,
    node:test stay.
12. **Phase 1 ("foundation"):** engine runs identically in Node; ws
    rooms; DM + players join, claim characters, and fight **one
    encounter** together with DM overrides. Campaign loop is phase 2.
13. **Delivery:** worktree branches, checks before every commit,
    merged by the architect after review.

---

## What the review found

### The good news
- **The combat engine already runs in Node unchanged.** Its 21-module
  import closure has no DOM, window, localStorage, Vite syntax, or
  anim/ edges. 352 engine + AI tests pass under plain `node --test`.
  Everything browser-bound is the *driver* in `main.js` (turn loop,
  wrap/write-back bridge, legacy spell fallback) and `scene-state.js`
  storage.
- **Baseline is green.** 1,276/1,276 tests in ~1.4 s, no flakes over
  six runs; lint at 4 warnings of 20; build in 0.9 s; CI green.
- **The combat seams in `main.js` are thin.** ~350 lines (1027–1481)
  bridge UI to engine, and the bridge + manual plan builders contain
  no DOM code.
- **The 2D render modules are mostly pure already** (`positionOf` is
  injected; overlay queues are presentation state).
- **Persistence is cheap enough to stay synchronous.** Measured 24–36 µs
  per event row and 52–72 µs per 80 KB snapshot with better-sqlite3
  in WAL mode.

### P0 findings (verified by probes, not inferred)

| # | Finding | Where |
|---|---|---|
| P0-1 | **Simulator does not `await` the engine.** Any turn that provokes an opportunity attack resolves *after* `simulateEncounter` returns. 4v4 average rounds: 5.71 shipped vs 3.54 awaited. Win rate shifts ~2.4 pp. Every M45 calibrator number is suspect. | `simulator.js:188,201` |
| P0-2 | **Shield/Counterspell are granted to anyone who answers yes.** A Fighter with no Shield spell and 0 slots was shielded 98/98 times. Exploitable over the network. | `combat-engine.js:331-343, 427-438` |
| P0-3 | **Sneak Attack hits deal 0 damage.** The engine appends `+Nd6`; the dice parser reads one term. | `combat-engine.js:256-258`, `combat-roll.js:15,81-83` |
| P0-4 | **PC saves never add proficiency.** Affects every spell save, AoE save, concentration check. | `combat-engine.js:695-703` |
| P0-5 | **Spell DC / spell attack use `classes[0].level`** and ignore item bonuses. Saris: DC 14 / +6 instead of 15 / +7. | `combat-engine.js:665-682` |
| P0-6 | **Three unsynced spell-slot pools.** Manual play casts with 0 slots; live play has unlimited Shield (`_lvl1Slots` never written back). Warlocks get full-caster slots. | `reactions.js:199-360`, `main.js:1195-1220` |
| P0-7 | **Breastplate / half plate count as heavy armor** (DEX dropped). | `pc-stats.js:57-62` |
| P0-8 | **Conditions are never removed.** Hold Person paralysis is permanent; charmed blocks *all* attacks. | `combat-engine.js:551-558`, `combat-resolver.js:93-95` |
| P0-9 | **Determinism leaks.** Concentration saves use `Math.random`; live play's rng is `Math.random`; RNG state lives in a closure and cannot be snapshotted. | `combat-engine.js:661`, `main.js:1258`, `simulator.js:55-63` |
| P0-10 | **Anyone can overwrite any user's character** by pasting JSON with its id; the character list endpoint shows everyone's imports; the item-sprite POST lets any client poison the shared sprite cache. Affects today's single-player users. | `api/server.js:72,85,117,138-153` |
| P0-11 | **`ctx.filter` is disabled in Safari/iOS.** Skin tones, downed/poisoned/paralyzed/invisible tints are invisible on every Apple device. | `compositor.js:761-764`, `lpc-config.js:995,1023` |
| P0-12 | **An open WebSocket blocks `server.close()`.** Every Railway redeploy would hit the forced `exit(1)` and skip `closeDb()`. | `api/server.js:232-247` |

### Structural gaps that shape the plan
- **No terrain model.** A scene is grid size + background + positions.
  No passability, difficult terrain, walls, cover, LOS, creature size.
  Movement legality is UI-only; engine movement is a straight-line
  jump at a hard-coded 30 ft; OAs check start/end cells only.
- **No turn manager in the engine.** The round loop exists twice
  (simulator and `main.js`) with different turn orders; legendary
  actions run only in the simulator.
- **Open5e monsters fight with preset stats.** Only name and HP come
  from Open5e; AC/attacks/saves come from the nearest of ~17 LPC
  presets. Open5e's own structured attack fields are wrong (a Young
  Red Dragon's bite is listed as thunder, no bonus); any importer must
  parse the stat-block text. Open5e search is **unfiltered** and
  returns OGL-only Kobold Press content, contrary to decision 6.
- **Canvas is sized to the whole map at 192 px/cell.** A 30×20 map is
  22 MP, over iOS's 16.7 MP cap. There is no viewport camera.
- **Every token is fully re-composited every frame** (SHA-1 per item
  layer, `getImageData` readbacks) on a 130 ms tick.
- **Cinema inputs are per-browser.** Style and swing come from each
  client's localStorage; seven clients would play seven cinemas.
- **DDB import drops most live state.** XP, slots used, feature uses,
  hit dice, currency, conditions, unequipped items, racial traits,
  resistances, feat-granted spells, weapon properties and armor type
  are all in the raw JSON and unparsed. Only one real character
  fixture exists locally (a Cleric 4); caster-type coverage is
  unverified.
- **`main.js`** is 5,276 lines, 45 module-level `let`s, 53 delegated
  document handlers, no exports, no tests.

### Rendering decision (research verdict)
2D LPC canvas for phases 1–2. The 3D track has no battle view, 7 class
archetypes, 0 monsters, 0 races, 21 MB of assets, a WebGL context per
viewer (Chrome caps 16 per page), and a documented armour wall. Every
browser VTT with DM-uploaded maps is 2D (Foundry/PixiJS, Owlbear). No
PixiJS: after the bake-cache fix a frame is ~1 map blit + ≤14 token
blits + overlays, well within Canvas 2D. The battle client must never
import `three.module`, Draco, or `.glb`.

---

## Architecture for phase 1

### Shape
```
browser (play.html)                    server (api/)
  views/{lobby,claim,battle,dm-panel}    rooms/room.js       ← one Room per code
  client/store.js  (state mirror)        rooms/prompt-broker.js
  client/ws-client.js                    rooms/turn-lane.js   ← single async coroutine
  client/render-adapter.js (2D)          ws/gateway.js        ← noServer ws on /ws
         │ intents ↑  events ↓                   │
         └──────────── ws ───────────────────────┘
                                                 │
                  src/js/shared/   ← contracts importable by both
                    encounter-state.js  (EncounterState v1, JSON)
                    events.js           (event catalogue v1)
                    protocol.js         (ws envelope v1 + validators)
                                                 │
                  src/js/scene/combat-engine.js ← the spine, unchanged role
                  src/js/scene/encounter-adapters.js ← replaces main.js bridge
                  src/js/scene/turn-manager.js       ← one loop for sim/browser/server
                  src/js/scene/grid-legality.js      ← path/LOS/cover/range (pure)
```

### Contracts (agreed in Wave 0, versioned, validated)
1. **EncounterState v1** — pure JSON. `{v, encounterId, round, turnIndex,
   phase, rng:{algo:'mulberry32', s}, grid:{cols,rows,cellFt,
   flankingEnabled, terrain?}, map, initiative[], entities{id → {id,
   kind, side, name, controller:{type:'player'|'ai'|'dm', seatId},
   pos, hp, hpMax, hpTemp, ac, speedFt, conditions[], concentration,
   resources:{reactionUsed, slots{}, pact{}, innate, legendaryBudget,
   features{}}, turnFlags{}, sheetRef|statBlock}}, lastEventSeq}`.
   Resources store *spent* against a max derived from the sheet.
   Underscore wrapper fields are enumerated here or do not survive.
2. **Event catalogue v1** — `{seq, type, round, turnId, cinemaGroup,
   payload}`, ids only, never object refs, no wall-clock. Types:
   `turn.started/ended/skipped`, `plan.chosen`, `move`,
   `reaction.offered/resolved`, `attack.rolled`, `damage`, `heal`,
   `save.rolled`, `spell.cast/countered/fizzled`,
   `condition.applied/removed`, `concentration.started/broken`,
   `resource.spent`, `feature.used`, `entity.downed`, `exchange`
   (the cinema spec), `dm.override`, `turn.rejected`,
   `encounter.ended`.
3. **ws envelope v1** — client→server `{v, t, cid, p}` with `cid` for
   de-dupe; server→client broadcasts `{v, t, seq, ts, p}` (room-
   monotonic `seq`), privates without `seq`. Full snapshot on every
   (re)connect; `stateHash` at every `turn.ended`; `resync` on gap.
   Message catalogue: R1 Appendix C.

### Rules of the server
- **Two lanes per room.** The turn lane is one async coroutine that
  drives the turn manager and `runOneAttack`. The control lane handles
  every inbound message immediately: prompt answers resolve broker
  promises; DM edits apply now at a safe point (between turns, waiting
  for intent, paused) or queue to turn end. The engine never sees
  state change mid-resolution.
- **Reactions are network prompts with the engine's existing
  `async → boolean` shape.** `PromptBroker.ask()` checks eligibility
  (fixes P0-2), answers instantly with the engine heuristic for AI or
  offline seats, otherwise waits for the owning player up to the room's
  reaction timeout (default **20 s**), then falls back to `autoAnswer`.
  The engine re-checks eligibility after any `true`.
- **DM overrides without forking the engine.** Two new optional
  prompts: `onPlanReady({attacker, plan}) → plan|null` (review/replace/
  skip an AI plan) and `onRoll({kind, result}) → result` (edit after
  the rng draw so the stream stays aligned). HP/condition edits go
  through the control-lane queue. Every override emits `dm.override`.
  The simulator passes `{}` so its output is byte-identical.
  **Phase 1: DM edits monster/AI rolls only; HP/conditions for anyone.**
- **Cinema is a client-side replay of one server event.** `exchange`
  carries resolved rolls, HP effects, and every animation input
  (chosen weapon, style, swing, modifiers, killing blow, `fxSeed`).
  Style and swing become server-side seat state. The turn lane waits
  for `cinema.done` from connected clients **or** a cap of
  `sequence.duration + 1.5 s`, whichever first, so a backgrounded tab
  cannot stall the table and players never get a reaction prompt
  before seeing the attack that caused it. Late joiners get a snapshot
  and no cinema backlog.
- **Persistence before broadcast.** Each engine step appends its
  events and, at turn end, the snapshot, in one transaction, then
  broadcasts. On restart the in-flight turn re-runs from its
  turn-start snapshot with the restored RNG state and the logged
  prompt answers. `encounters.engine_version` guards replay across
  incompatible builds.
- **Per-seat view filter from day one.** Every broadcast passes
  through `viewFor(state, seat)`. Phase 1 returns full state; phase 2
  fog becomes a filter, not a refactor.
- **Identity.** `POST /api/rooms` → `{code, dmToken}`; `POST
  /api/rooms/join` → `{participantId, token}`. 6-char Crockford base32
  codes; 256-bit tokens stored only as SHA-256 hashes; token sent in
  the first ws `hello` message, never in the URL. CSP `script-src
  'self'` in report-only first.

### Data model (migration 0002, additive)
`users` (stub), `rooms`, `participants` (nullable `user_id`),
`party_slots` (**own TEXT id**, `UNIQUE(room_id, seat)`,
`character_id`, `seed_parsed_json`, `sheet_json`, `state_json`,
`controller_participant_id` NULL = AI), `uploaded_maps`, `encounters`
(`snapshot_json`, `snapshot_seq`, `head_seq`, `engine_version`),
`encounter_events` (`PRIMARY KEY(encounter_id, seq)`, WITHOUT ROWID).
Full SQL: E3 Appendix A, amended so `party_slots` carries the
sheet/state split from R3 (phase 2's `run_characters` is then a rename,
not a rebuild). Runner: `schema_migrations(version, name, checksum,
applied_at)` + numbered SQL files applied inside `db.transaction`,
pre-migration backup via `db.backup`, refuse to boot on checksum
mismatch or a DB newer than the code. `0001_baseline.sql` is today's
`schema.sql` verbatim.

`state_json` v1 (settled now so phase 2 needs no migration):
`{schema_v:1, hp:{current,temp}, deathSaves:{successes,failures,
stable}, hitDice:{<class>:{die,spent}}, slots:{spell:{<lvl>:{spent}},
pact:{spent}}, resources:{<key>:{label,max,spent,recovery[]}},
conditions:[], conditionMeta:{}, exhaustion, inspiration, currency,
concentration}`.

---

## Phase 1 task list

Sizes: S ≤ 1 day, M 2–4 days, L 1–2 weeks of agent work. Every task
ships with node:test coverage and keeps `npm run lint && npm test &&
npm run build` green. Full acceptance criteria are in the source
reports; the one-liners here are the gate.

### Wave 0 — contracts and harness (E6 + architect)
| ID | Task | Size | Gate |
|---|---|---|---|
| H1 | `src/js/shared/{encounter-state,events,protocol}.js` with validators and contract tests | M | Both Vite and Node import them; a planted invalid payload fails validation |
| H2 | Golden-test harness: fixtures + `UPDATE_GOLDEN=1`; `Math.random` and `Date.now` tripwires; JSON round-trip after every intent; state-at-return check | M | 10 scripted scenarios (see E6 §4a) pass on Node 22/24 in < 2 s |
| H3 | Shared test builders (`src/tests/helpers/entities.js`), synthetic DDB fixtures (fighter-l5, wizard-l5, cleric-l5) | S | No per-file `buildPc` duplicates in new tests |
| H4 | CI: run on `p1/**`, `shell: bash` (pipefail), Node 22/24 matrix, **frozen-3d job** that fails on any diff under the frozen paths, lint ratchet to current count | S | A planted edit to `three-viewer.js` fails CI |
| H5 | Push 30d8cce; fix CLAUDE.md / `.claude/rules/combat-engine.md` reference to the non-existent `ai/monster-profiles.js` (→ `ai/profiles.js`) | S | Worktrees see `.claude/rules/` |

### Wave 1 — testability blockers (parallel, disjoint files)
**E1a — engine (`combat-engine.js`, `simulator.js`, `calibrator.js`, `reactions.js`, `concentration.js`, `combat-roll.js`, `ai/*`)**
| ID | Task | Size | Gate |
|---|---|---|---|
| T1 | `await runOneAttack` in the simulator; `simulateEncounter`/`calibrateEncounter` async; callers + ~20 test sites updated; **re-baseline simulator stat tests once** with the reason in the commit | S | OA golden: after `await simulateEncounter` the mover has moved and attacked; 200×4v4 < 100 ms |
| T2 | RNG hygiene: thread `rng` into concentration, both `mctsEvaluate` calls, `rollInnateRecharges`; make `rng` required (no `Math.random` defaults); remove the double recharge roll | S | Tripwire test: `Math.random` throws, full simulation + every spell kind runs clean |
| T3 | Serializable RNG: `createRng({s})` exposing `.state()` | S | Snapshot mid-encounter → JSON round-trip → resume gives a byte-identical event log |
| T10 | Portability guard: ESLint `no-restricted-imports` on the engine closure; Node smoke import test | S | Lint fails on a planted `anim/` import |
| N1 | **Gate reaction answers**: Shield only if `canCastShield`, Counterspell only if `canCastCounterspell`; route spell-attack and Magic Missile Shield paths through `onShieldReaction`; add `autoAnswer` to `onReactionAttack` | S | shield-gate probe as a test: 0 shielded hits for an ineligible PC; Magic Missile prompts once |

**E3a — backend (`api/server.js`, `api/db/**`, `api/migrations/**`)**
| ID | Task | Size | Gate |
|---|---|---|---|
| B1 | Migration runner + `0001_baseline.sql`; delete `schema.sql`; `database.js` calls `runMigrations` | S | Fresh DB → all tables; re-run → no-op; broken migration → no partial tables; a copy of a pre-migration DB keeps its rows |
| B3 | Factories: `openDb(path)`, `createApp({db, env})`, `startServer({port:0,…}) → {url, close()}`; `server.js` becomes a 10-line entry | M | Existing tests pass; a ws test can boot on port 0 with no open handles |
| B5 | Data-dir and volume guard: `CF_DATA_DIR` → `RAILWAY_VOLUME_MOUNT_PATH` → `dirname(CF_DB_PATH)`; refuse to boot in production if the DB is off the volume; `/api/health` runs `SELECT 1` and reports migration version | S | Misconfigured env fails fast with a clear message |

**E2a — client (`main.js`, `index.html`, `vite.config.js`, `eslint.config.js`)**
| ID | Task | Size | Gate |
|---|---|---|---|
| C0 | Tooling: `WebSocket`/`CustomEvent`/`EventTarget` eslint globals; Vite multi-entry `{main, play}` + `/ws` proxy (`ws:true`, no `rewriteWsOrigin`); Express `/play` route before the catch-all (with E3) | S | `npm run build` emits `dist/play.html` |
| C1 | Extract `src/js/scene/live-bridge.js` (wrap, write-back, sides, `runTurn` with injected `rng`/`prompts`); `main.js` imports it. **Ownership passes to E1 at Wave 2.** | M | A Node test runs one full turn with no DOM; manual versus unchanged |
| C3 | Extract `src/js/scene/manual-plan.js` | S | Server can turn a player intent into a `forcePlan` without `main.js` |
| C4 | Extract `src/js/scene/encounter-setup.js` with injected `rng` + `mintId` | S | Fixed seed → deterministic initiative and ids |
| C10 | Fix F1/F2/F7 in `main.js`: top-nav exit restores the scene; `saveScene` is blocked during versus; `[data-condition]` collision | S | Manual + tests where possible; no edits inside the frozen line ranges (79, 3961, 3966–4071, 4445–4451) |

### Wave 2 — portable engine + rules (E1b, then E4 rebased)
**E1b**
| ID | Task | Size | Gate |
|---|---|---|---|
| T5 | `EncounterState` v1 + pure adapters in `encounter-adapters.js` replacing `live-bridge.js` internals (exported names kept); **one slot ledger** (`_lvl1Slots`/`_lvl3Slots` removed); carry `_aiProfile`, concentration, Open5e stat block; `scene-state.js` split into pure model + localStorage adapter | M | Round-trip test preserves every resource; Shield slots decrement across turns; `_aiProfile` changes monster choice |
| T4 | Engine event emission via sync `ctx.emit`; includes `spell.fizzled`, `atk.shielded` on OA, `entity.downed`; `onCinemaRound` still works | M | Scripted-turn test asserts the exact event sequence; all events `JSON.stringify`-safe; simulator throughput within 10% |
| T6 | Prompt contract: alive/target re-check after every `await`; server prompt adapter interface (timeout → `autoAnswer`, answers logged as `reaction.resolved`) | M | A never-resolving prompt times out to `autoAnswer`; replay with logged answers reproduces the state hash |
| T7 | **Engine turn manager** (`startEncounter`/`runTurn`/`runRound`): initiative, per-creature reaction reset, legendary actions, recharge, victory check, `skipTurn`, incapacitated skip. Used by simulator, browser auto-fight and server. | L | Simulator and server share one loop; legendary actions fire in live play; stat tests re-baselined once |
| T8 | DM hooks: `onPlanReady`, `onRoll` (attack, damage, single-target save in phase 1) + `withD20()` recompute, checkpointed HP/condition command queue, `insertInitiative`/`removeInitiative`, `setEntityHp`/`setEntityConditions` | M | One test per override kind; a DM-zeroed target mid-prompt is not attacked; HP edit during a pending plan survives write-back |
| T9 | Intent validation + `plan.moveTo` honored, intent `features[]`, entity `speedFt`; `turn.rejected` replaces the silent return | M | Invalid target / unknown spell / no slot / out of range rejected with a reason; player-chosen cell honored |
| T11 | `onMove` prompt / `move` event so clients can animate moves; `planMovement` routes through `grid-legality.findPath` **when terrain is present** (terrain-free results stay byte-identical) | S | `entity.moved` carries the path; seeded terrain-free regression unchanged |

**E4 — rules (`pc-stats.js`, `combat-resolver.js`, `class-feature-rules.js`, `save-rolls.js`, `ai/pc-features.js`, `monster-spells.js`, `api/lib/ddb-parser.js`; engine edits submitted to E1 as patches)**
| ID | Task | Size | Gate |
|---|---|---|---|
| R1 | Multi-term dice; crits double every die | S | `rollDamage('1d8+3+3d6')` ∈ [7,29]; Rogue 5 Sneak Attack hit > plain hit |
| R2 | PC saves use proficiency + `combatMods`; concentration uses the same function with seeded rng | S | Proficient CON +3 at PB 2 → +5 |
| R3 | `pcSpellBook` uses total level, per-spell ability, `combatMods` | S | Saris → DC 15 / +7; Fighter 2 / Sorcerer 7 → DC 16 / +8 |
| R4 | One slot ledger (with T5): multiclass caster level, Pact Magic separate, Shield/Counterspell draw from it, empty-slot cast refused | M | Wizard 3 / Cleric 3 → {1:4, 2:3, 3:3}; Warlock 5 → pact {3:2} |
| R5 | AC from DDB `armorTypeId` + `combatMods` `ac` | S | Breastplate DEX +3 → 16; Saris stays 18 |
| R6 | Keep weapon `properties`/`attackType`/range/magic bonus; derive finesse, thrown, versatile, proficiency | M | Javelin uses STR; Warhammer no-shield rolls 1d10; Wizard + greataxe gets no PB |
| R7 | Condition lifecycle `{id, sourceId, endsOn, save}`; end-of-turn repeat saves; removed on concentration drop; charmed blocks attacking the charmer only; speed from sheet/preset, 0 when grappled/restrained | M | Killing the caster clears Hold Person; paralyzed monster doesn't move in either path |
| R8 | One `applyDamage(target, amount, type, {crit, attacker})` for every path (temp HP → R/I/V → concentration → downed) | M | grep finds no direct `hp -=` outside it; 10 fire vs resistance with 5 temp HP → 0 HP lost |
| R12 | Spell attacks go through `resolveAttack` | S | Prone target → ranged spell attack at disadvantage |
| R13 | Dash / Dodge / Disengage take effect | S | Disengage → no OA; Dash → 60 ft; Dodge → disadvantage on next attack |
| R14 | Parser completeness: feat/race spells, healing classification, `componentId` collision, `hp.temp`, DDB `conditions`, slots used, `currentXp`; **strip `campaign.characters[]`** before storing `raw_json` | M | Saris parses Misty Step (1/LR), Healing Word as `heal`, Channel Divinity 1/SR |

### Wave 3 — rooms, ws, maps (E3b ∥ E5)
**E3b**
| ID | Task | Size | Gate |
|---|---|---|---|
| B2 | `0002_multiplayer.sql` (tables above) | S | Unit tests for every CHECK and partial unique index |
| B4 | Hardening: JSON error middleware; JSON 404 for `/api/*`; `AbortSignal.timeout(8000)` on upstream fetches; separate limiters (cache hits not limited); **P0-10 fixes** (paste cannot overwrite a `source='url'` row; character list scoped/disabled; item-sprite POST restricted to room members, first-write-wins); **Open5e search filtered to `document__key=srd-2014`**; JSON-line request log with ids | M | Each item has a test |
| B6 | Rooms HTTP API (create / join / kick); hashed tokens; display-name rules | M | Raw token never present in the DB (test) |
| B7 | **ws gateway**: shared `http.Server`, `noServer` on `/ws`, Origin allow-list (403), `hello` within 5 s (4401), supersede (4409), 30 s heartbeat, `maxPayload` 16 KiB (1009), token bucket 20/s (1008), `bufferedAmount` > 1 MiB → terminate, per-room serial queue, per-message try/catch | L | 1 DM + 2 players join; broadcast reaches all; a player sending `dm.*` gets an error frame |
| B8 | Encounter persistence: events + turn-end snapshot in one transaction before broadcast; boot recovery re-runs the in-flight turn; write-time p99 logged (budget 5 ms on Railway) | M | Kill mid-encounter → restore → identical state hash |
| B9 | Graceful shutdown v2: stop intents → snapshot all → close sockets 1012 → `server.close` → `closeDb` (**P0-12**) | S | Exit within 2 s with 3 open sockets |
| B10 | Map upload: DM-only `PUT`, route-scoped `express.raw` (10 MB), magic-byte + dimension sniff (`api/lib/image-sniff.js`), caps 8192 px/side and 16.7 MP, reject SVG/GIF, content-hash names, atomic write, quotas (20 maps / 100 MB per room), `express.static` immutable + `nosniff`, mounted before the SPA fallback | M | Spoofed extension → 415; 11 MB → 413; 9000×10 → 422; missing file → 404 not `index.html` |
| B11 | Janitor: event retention, idle-room deletion incl. maps dir, WAL checkpoint > 64 MB | S | Tested with injected clock + fs |
| B12 | Deploy/config: `ws` dependency; `engines >=22 <25`; CSP report-only; DEPLOY.md (volume 5 GB, new env vars) | S | CI green on 22/24 |

**E5 — map/scene/render (`map-render.js`, `compositor.js` battle path, `src/js/scene/grid-legality.js`, `src/js/map/**`)**
| ID | Task | Size | Gate |
|---|---|---|---|
| M1 | `grid-legality.js`: `findPath` (Dijkstra, 8-neighbour, difficult = 10 ft, pass allies not hostiles, can't end occupied), `validateMove` (per-step OA detection), `lineOfSight`, `coverBetween`, `weaponRangeBand` — pure, Node-safe | L | Path-based OA fires where start/end-only would not; LOS blocked by flag 16 |
| M2 | Terrain layer `{v, cols, rows, flags:<base64>}`; bits 1 blocked, 2 difficult, 4 half cover, 8 ¾ cover, 16 total/LOS-block; backfill for old saves | S | Round-trip; resize preserves overlap |
| M3 | Calibrated image background: `map.{imageId, imgW, imgH, calib:{cellPx, offsetX, offsetY}, cinemaBiome}`; source-rect draw replaces cover-fit; arbitrary cols/rows; fix snapshot restore (`scene-snapshot.js:80-82`) | M | Fixture map grid lines align within 1 px at 3 zoom levels |
| M4 | Viewport camera: canvas = viewport × min(DPR, 2); pan/zoom transform; `pickCell` inverse; wheel/drag/pinch | M | 40×30 map renders ≤ 16.7 MP; click→cell correct at zoom 0.5/1/3 |
| M5 | Read-only renderer `renderBattleScene(canvas, view, local)`; single rAF scheduler with dirty flag; no scene mutators importable | M | A deep-frozen view renders without throwing |
| M6 | Terrain overlay pass + DM paint brush (emits `terrain.paint`) | M | Painting changes the next `findPath` |
| M7 | **Token bake cache** keyed `(appearanceKey, direction, anim, frame, hpState, worstCondition)`; pure `applyFilterMatrix` recolour replaces `ctx.filter` (**P0-11**); memoised item hash; cinema cache key gains `appearanceHash` | M | 0 `getImageData` and 0 `digest` calls per steady-state frame; poisoned token visibly tinted on iOS (manual) |
| M8 | Intent adapters: drag → `move {path}` with local path preview; DM free-move `override:true`; no `currentScene` writes in input handlers | M | Over-budget drag shows red and sends nothing |
| M9 | Calibration UI (DM modal): known-size (filename `NxM` prefill), two-click N-cells-apart (default 3), magnifier loupe, nudge keys, far-corner drift check, reject cellPx < 24 | M | 3000×2000 test image with 100 px grid at (37,12): k within ±0.5 px, offset ±1 px |
| M10 | Fog bitset in view + mask pass + server-side entity filter hook (data only in phase 1) | S | Players never receive entities in unrevealed cells (server test) |

### Wave 4 — clients and smoke (E2b ∥ E6)
| ID | Task | Size | Gate |
|---|---|---|---|
| C5 | `src/js/anim/cinema-plan.js`: pure `buildCinemaSequence(exchangeEvent)`; modifiers from the event, not flag diffing; `_swingN` leaves the entity; chosen weapon not mainhand | M | Same event JSON → deep-equal Sequences with localStorage stubbed to throw |
| C6 | `client/store.js` (`authoritative` vs `presented`, ordered `seq`, gap → `resync`) | M | Out-of-order and duplicate events ignored |
| C7 | `client/ws-client.js` (backoff 1 s→30 s jittered, resume token, unacked intent queue) | M | Fake-socket tests: reconnect, resend, idempotent close |
| C8 | `client/render-adapter.js` (2D) + playback queue with skip | M | HP bars update at impact keyframe, not on receipt; `skip()` jumps to `authoritative` |
| C9 | `play.html` views: lobby (S1), claim seat (S2), encounter setup (S3: map tabs incl. calibration, monster search with **"fights as: Bandit"** label, terrain brush, initiative mode, live calibrator card debounced 400 ms in the DM's browser, pause mode), DM battle panel (S4: pending-action card with `formatBreakdown` "why", approve / change target / change action / skip / take control, roll editor, entity inspector, + Monster, End encounter), player battle view (S5: turn-gated actions via `buildActionsFor`, reaction dialogs with countdown, waiting states) | L | Two browsers + a DM finish one encounter; every click is an intent; `runAttackPrompt` is not importable from `src/js/client/**` (lint rule); DM HP override visible on both clients within one event |
| C11 | "DM adjudicates" spell intent for spells outside the 11-entry registry (DM enters damage / save / conditions) | S | Saris's 9 non-registry spells are castable through adjudication |
| S1 | Smoke test: boot in-process, import fixture, create room, DM + player connect, claim, add preset goblin, start with seed 42, one attack intent, assert golden event sequence and equal `seq` on both clients; SIGTERM child-process variant | M | Runs in `npm test` < 5 s |
| S2 | Pre-merge checklist enforced (below) | S | — |

**Phase 1 total:** ≈ 12 S, 30 M, 5 L. Roughly 10–12 engineer-weeks of
agent work across six parallel branches; wall-clock is bounded by the
wave dependencies, not the sum.

### Explicitly deferred to phase 1.5 (first items after the demo)
- **Extra Attack and monster Multiattack** (E4 R10, M). Visible to any
  level-5+ party; not a server-authority blocker.
- **Death saves / dying / stable** (E4 R9, M). State shape is settled
  in phase 1; behaviour lands here.
- **Open5e stat-block normaliser** (E4 R11, L): AC, saves, R/I/V,
  attacks parsed from `desc` text, multiattack, recharge; presets used
  for sprites only; calibrator re-baselined and M45 results regenerated.
- Fighting Styles, cantrip scaling, Rage (E4 P1 list).

---

## Phase 2 — campaign loop (scoped, not planned)
Campaign → nodes (encounter / rest / loot / shop / story) → run →
`run_characters` (= `party_slots` renamed) → `run_events`. XP awards
from Open5e `experience_points` split per PC; SRD 5.1 thresholds
(verified p.56). Level-up queue with auto-apply (HP, hit dice, PB,
slots from DDB `levelSpellSlots`, features at `requiredLevel`) vs
player-choose/DM-confirm (ASI, spells) vs reconcile re-import gated by
game-granted level. Data-driven rests (Foundry `restTypes` pattern).
Death state machine. Loot/currency/`run_items`, potion use. Fog of war
as a `viewFor` filter + DM reveal brush. BFS pathing with walls shared
by the simulator. DM token images for non-humanoid monsters. Grid
facing and death fade. Rewind-last-turn. Retire `main.js` versus into
a local room so solo and online share one runner.

---

## Branch plan and merge order

| Branch | Owner | Sole writer of | Lands in |
|---|---|---|---|
| `p1/e6-harness` | E6 | `src/js/shared/**`, `src/tests/{fixtures,helpers,golden}/**`, `api/tests/**`, `.github/workflows/ci.yml`, `package.json` scripts | W0, W4 |
| `p1/e1-engine` | E1 | `combat-engine.js`, `scene-state.js`, `simulator.js`, `calibrator.js`, `reactions.js`, `concentration.js`, `combat-roll.js`, `ai/*`, `live-bridge.js` (from W2), `encounter-adapters.js`, `turn-manager.js` | W1, W2 |
| `p1/e4-rules` | E4 | `pc-stats.js`, `combat-resolver.js`, `class-feature-rules.js`, `save-rolls.js`, `ai/pc-features.js`, `monster-spells.js`, `api/lib/ddb-parser.js` | W2 (after E1b) |
| `p1/e3-server` | E3 | `api/server.js`, `api/db/**`, `api/ws/**`, `api/rooms/**`, `api/migrations/**`, `package.json` deps, `railway.json`, `DEPLOY.md` | W1, W3 |
| `p1/e5-map` | E5 | `map-render.js`, `compositor.js` (battle path only), `grid-legality.js`, `src/js/map/**` | W3 |
| `p1/e2-client` | E2 | `main.js`, `index.html`, `play.html`, `src/styles.css`, `src/js/client/**`, `src/js/anim/cinema-plan.js`, `vite.config.js`, `eslint.config.js` | W1, W4 |

Rules: one branch per wave touches `package*.json`; never hand-merge
the lockfile. Migration numbers are assigned at merge time. Contract
changes bump the version and need acknowledgement from every owner.
Rebase-merge to keep commits atomic (owner to confirm).

### Pre-merge checklist (every branch)
1. Rebased on current `main`; `git diff --stat main...` touches only
   the paths the branch owns.
2. `set -o pipefail; npm run lint && npm test && npm run build` run
   **before** committing.
3. No new lint warnings; test count does not decrease; ≥ 1 test per
   new export.
4. Golden diffs: none, or re-blessed with the reason in the commit.
5. Any schema change ships a numbered migration + migration test.
6. No diff under the frozen 3D paths (CI job enforces).
7. CI green; CLAUDE.md updated if the spine moves.

---

## Risk register

| # | Risk | L | I | Mitigation |
|---|---|---|---|---|
| 1 | Simulator/calibrator numbers shift after T1/T2/R1/R2/R8 | Certain | Med | Re-baseline **once**, in one commit, with the reason; regenerate M45 results in phase 1.5 after the Open5e normaliser |
| 2 | `main.js` merge conflicts incl. the frozen 3D toggle | High | High | Single writer (E2); extractions confined to lines 401–3045 + import block; frozen-3d CI job; `git diff --color-moved` review |
| 3 | Railway redeploy wipes in-memory rooms | Certain | High | Snapshot + `seq` + RNG state persisted every turn; `server-restarting` on SIGTERM; client backoff reconnect; "sessions live" warning on `/api/health` and the deploy checklist |
| 4 | Remote reaction prompt stalls a turn | High | High | Broker deadline → `autoAnswer`; offline/AI seats answer instantly; DM `dm.prompt.force`; counterspell witnesses prompted in parallel, first yes wins |
| 5 | Determinism leak breaks replay/recovery | High | High | `rng` required everywhere; `Math.random`/`Date.now` tripwires in goldens; server-issued ids; B8 kill-and-restore test |
| 6 | Contract churn between six branches | High | High | W0 contracts with versions + validators; acknowledgement rule |
| 7 | better-sqlite3 sync writes on a slow Railway volume | Low–Med | Med | One transaction per step; p99 logged with a 5 ms budget; fallback to `synchronous=NORMAL` for event rows only |
| 8 | Wrapper underscore state lost across snapshot/reconnect | High | Med | Enumerated in EncounterState; JSON round-trip asserted after every intent |
| 9 | Non-SRD DDB text redisplayed to other users (licensing posture) | Med | Med | Show non-SRD feature/spell prose only to that seat and the DM; never in shared caches; mechanics stored separately from prose; add the SRD 5.1 CC-BY attribution |
| 10 | Parser contract frozen on one real character | High | Med | Collect ≥ 4 more real exports (Sorcerer, Warlock, Fighter 5 with a +1 weapon, Barbarian) before R14 lands; anonymise into fixtures |
| 11 | One uncaught exception drops every room | Low | High | Per-message try/catch; room enters `error` with a DM "reload from last snapshot" action; snapshot every turn |
| 12 | Toolchain drift (Node 25 local, engines `<24`, Node 20 EOL) | Med | Med | `engines >=22 <25`, `.nvmrc`, CI 22/24, ws teardown helper, `--test-timeout` |

---

## Owner decisions still open

Defaults the architect will apply unless told otherwise:

| # | Question | Default |
|---|---|---|
| 1 | Imported characters start **fully rested**, or carry DDB's current HP / used slots? | Rested, with a DM toggle "import current state" |
| 2 | DM may edit **player** rolls, or only monster/AI rolls? | Monster/AI only in phase 1; HP/condition edits for anyone |
| 3 | Large creatures stay 1×1 in phase 1? | Yes, documented limitation |
| 4 | 5-ft diagonals only, or DMG 5/10 as a room setting? | 5-ft only in phase 1 |
| 5 | Are DM fudges (`dm.override`) visible to players? | Room setting, default `dm-only` |
| 6 | May the DM seat **any** imported character as an AI party member? | Yes, from the room's own imports |
| 7 | Item-sprite and monster caches global or per-room? | Global; first-write-wins; admin purge |
| 8 | `engines` → `>=22 <25` and which Node runs on Railway? | Yes; confirm Railway's Node |
| 9 | Lint budget ratchet from 20 to 4? | Yes |
| 10 | Merge style: rebase-merge or squash? | Rebase-merge |
| 11 | Fixtures: may real exports be anonymised, or synthetic only? **Please export 4–5 more characters** (Sorcerer, Warlock, Fighter 5 w/ +1 weapon, Barbarian, a multiclass). | Anonymised real exports, names/ids scrubbed |
| 12 | Permadeath or standard 5e revival as the phase 2 default? | Standard revival; `deathMode` per campaign |
| 13 | DM-uploaded token images for non-humanoid monsters (phase 2)? | Yes |
| 14 | Should monsters be able to Counterspell PCs? | Phase 2 |

---

## Housekeeping found during the review
- `main` is one commit ahead of `origin/main` (30d8cce, the rules
  directory). Push before any worktree is created.
- `character-forge.db-shm` / `-wal` sidecars in the repo root were left
  by a read-only sqlite probe; gitignored and harmless; delete at will.
- `api/db/character_forge.db` is a 0-byte stray (ignored). The real DB
  is `<repo>/character-forge.db` locally and `CF_DB_PATH` on Railway.
- A real D&D Beyond export was copied into the session scratchpad for
  probing. It must never be committed; fixtures are scrubbed copies.
- CLAUDE.md and `.claude/rules/combat-engine.md` cite
  `ai/monster-profiles.js`, which does not exist (`ai/profiles.js`).
- Stale line references in DEFERRED.md (`main.js:~3797` → 3863;
  compositor readbacks → 1069/1113/1173).
