/**
 * M64 contract 3 of 3 — ws envelope + message catalogue v1.
 *
 *   client → server  { v, t, cid, p }          cid de-dupes retries
 *   server → client  { v, t, seq, ts, p }      broadcast, room-monotonic seq
 *                    { v, t, ts, p }           private (no seq)
 *
 * Sources: docs/M64-ONLINE-TABLE-PLAN.md "Contracts" §3 and R1 §3.3 /
 * Appendix C. Where R1 and the plan's event catalogue name the same
 * thing differently the plan wins, so these R1 server messages are NOT
 * in v1 — their engine events replace them:
 *   entity.moved → move · cast.begin → spell.cast ·
 *   cast.countered → spell.countered · reaction.pending → reaction.offered
 *
 * Engine events (events.js EVENT_TYPES) are broadcast with `t` = event
 * type, `seq` = event.seq, and `p` = the whole event object.
 *
 * Additions beyond R1 Appendix C (all DM-only):
 *   dm.entity.add / dm.entity.remove  — "+ Monster" mid-encounter (T8 insert/removeInitiative)
 *   dm.terrain.paint                  — the plan's `terrain.paint` brush (M6), dm.* prefixed so
 *                                       the gateway's "dm.* is DM-only" rule covers it
 * and one broadcast: `redacted {type}` keeps `seq` gap-free when viewFor
 * hides an event (e.g. a dm-only dm.override) from a seat.
 *
 * v1 additive (E3, M64 Wave 4 — PROTOCOL_VERSION unchanged): the optional
 * `dm.encounter.setup.fog`, and the DM-only intent `dm.spell.adjudicate
 * {casterId, spellId, targets: [{entityId, damage?, type?, healed?,
 * conditions?}], slotLevel?}` — the DM rules a spell the engine cannot
 * resolve. E2 adds the same intent on its branch; one copy survives the
 * merge.
 *
 * v1 additive revisions (no PROTOCOL_VERSION bump; old clients never
 * send the new fields, old servers ignore nothing they validate):
 *   v1.1 (2026-10-15, E2 M8) — `dm.entity.patch.override` (bool): the
 *        DM's free move; the server applies `position` as a teleport
 *        (no speed budget, no opportunity attacks).
 *   v1.2 (2026-10-15, E2 C9) — `dm.encounter.setup.initiativeMode`
 *        ('individual' | 'grouped': one roll per monster type) and
 *        `dm.review.set.aiParty` (bool): with `plans: true`, also pause
 *        AI-run party members, not only monsters.
 *   v1.3 (2026-10-15, E2 C11) — `dm.spell.adjudicate` (DM-only): cast a
 *        spell the engine registry does not model (homebrew, non-SRD,
 *        the DDB character's feat / race spells). The DM states the
 *        result: `{casterId, spellId, targets: [{entityId, damage?, type?,
 *        healed?, conditions?}], slotLevel?}`. The server applies it at a
 *        safe point, spends the slot when `slotLevel` is given, and emits
 *        spell.cast (payload.adjudicated: true) + damage / heal /
 *        condition.applied + dm.override like any DM edit.
 *   v1.4 (2026-10-16, E3 W5) — fog of war on incremental traffic: under
 *        fog a player seat gets each event in full, masked (hidden entity
 *        ids replaced by 'Something') or as `redacted {type}`; `redacted`
 *        may now also stand in for an `entity.updated`. Player seats'
 *        `turn.ended.stateHash` / `room.snapshot.stateHash` cover the
 *        fog-filtered projection.
 *        DM-only intent `dm.room.settings {reactionTimeoutMs?, importLiveState?,
 *        fudgeVisibility?: 'public'|'dm-only', diagonalRule?: '5ft'}` (partial
 *        update, at least one key; persisted per room, encounter rules apply
 *        on the next dm.encounter.setup) and its broadcast
 *        `room.settings {settings}` carrying all four keys.
 *   v1.4 (E2 M64 1.5, additive to E3's v1.4) — `dm.entity.patch.status` (events.js
 *        ENTITY_STATUSES) and `dm.entity.patch.deathSaves {successes,
 *        failures, stable?}`: the DM sets a creature's dying state or
 *        clears its death saves (E1 wave 5's entity fields; the server
 *        wires them). `turn.act.plan.featureId` (E1 wave 5): the class
 *        feature a `kind: 'feature'` plan uses; clients also send it in
 *        `features` for validators that predate it. `dm.fog.paint {cells, op:
 *        'reveal'|'hide'}` — the DM's fog brush (map/fog.js); a server
 *        without it answers E_UNKNOWN_TYPE until E3 wires it.
 *
 *   v1.5 (2026-10-16, E1 M64 phase 1.5) — `turn.act.plan.featureId`
 *        (optional): `{kind: 'feature', featureId: 'second-wind'|'rage'|…}`
 *        uses a class feature as the turn (no move, no attack);
 *        `features: [...]` on an attack plan still names bonus-action
 *        features that ride the attack (Rage, then swing).
 *   v1.5 (2026-10-18, E3 M64 1.5 W6) — broadcast `encounter.fog {fog:
 *        {revealed}}`: the encounter's fog bitset after a `dm.fog.paint`
 *        (player seats also get a fresh snapshot: the paint changes what
 *        their projection shows). `dm.entity.patch.imageUrl` (a path the
 *        room's `PUT /api/rooms/:id/maps?kind=token` returned, or null to
 *        clear it): a non-humanoid monster's token image. `entity.updated`
 *        patches may carry `status` ('active' when cleared), `deathSaves`
 *        and `imageUrl` (null when cleared).
 *   v1.6 (2026-10-25, E6 M65 H23 — the campaign loop; plan "Contract
 *        changes") — room status `between` (protocol only: `rooms.status`
 *        keeps its CHECK; the run is between nodes). Server messages:
 *        `run.snapshot` (private: the viewer's projection of the run —
 *        visited nodes, offered edges, characters, items, level-ups),
 *        `run.updated` (broadcast: run status / current node / run seq),
 *        `run.event` (broadcast: one run event, run-events.js; run events
 *        travel under this one type because `item.used` and `dm.override`
 *        also name engine events), `levelup.offer` (private, to the seat's
 *        controller). Player intents (role 'seat' = the controller of
 *        `slotId`): `rest.spend`, `loot.claim`, `item.equip`, `item.give`,
 *        `item.use`, `shop.buy`, `shop.sell`, `levelup.choose`,
 *        `levelup.reconcile`; role 'player': `story.choose`,
 *        `seat.reclaim`. DM intents: `dm.run.advance`, `dm.run.end`,
 *        `dm.node.begin`, `dm.rest.grant`, `dm.loot.assign`,
 *        `dm.story.resolve`, `dm.xp.adjust`, `dm.levelup.confirm`,
 *        `dm.levelup.revert`, `dm.character.revive`,
 *        `dm.character.retire`, `dm.seat.fill`, `dm.snapshot.save`,
 *        `dm.snapshot.load`, `dm.seat.reclaim.approve`. `turn.act.plan.kind`
 *        gains `item` (T23: drink / feed a potion; `itemId` names the
 *        entity's `resources.items` key). Between-node intents are refused
 *        while an encounter is live (M65 decision 3).
 *        `DIAGONAL_RULES` gains '5-10' (DMG alternating 5/10-ft diagonals,
 *        E5's legality module): `dm.room.settings.diagonalRule` and the
 *        `room.settings` broadcast accept it.
 *   v1.6 (2026-10-25, E3 M65 B24, additive) — `error.code` gains
 *        'E_ENCOUNTER_LIVE' (a between-node intent while an encounter is
 *        live), 'E_NO_RUN' (a run intent in a room without an open
 *        run) and 'E_NODE_NOT_BEGUN' (dm.encounter.setup / start in a
 *        run outside a begun encounter node), and may be a campaign rule code (RULE_ERROR_CODE: a
 *        CampaignRuleError's kebab `.code`, with `details`).
 *        `dm.room.settings` (and the `room.settings` broadcast) gain
 *        `dmDrivesAiSeats` and `autoFight` (B28 solo rooms: AI seats are
 *        controller 'dm' unless auto-fight is on).
 *        `dm.node.begin.nodeId` (optional): the node to begin — from the
 *        run lobby any node (default the start node), later an offered
 *        edge; an encounter node is built in 'setup' for the DM to tweak
 *        (dm.encounter.setup) and start (dm.encounter.start).
 *   v1.7 (2026-10-26, E3 M65 phase 2 Wave 4, additive) — a turn recovered
 *        at boot re-announces itself: after `dm.resume` the replayed turn
 *        reaches its live intent wait and broadcasts a fresh
 *        `turn.started {actorId, resumed: true}` under the same turnId
 *        (turn intents carry no deadline). A replay skips earlier
 *        re-announcements like `turn.rejected`.
 *        `run.snapshot` and `run.updated` carry `runHash` (run-state.js
 *        runHash over the stored run log, run-driver's definition) and
 *        `wireHash` (the same over the prose-stripped log clients get);
 *        HTTP `GET /api/runs/:runId/events?since=` and
 *        `GET /api/runs/:runId/snapshots` (api/runs/http.js) let a
 *        reconnected client rebuild its log and snapshot list.
 *        The party stash's coin: DM intent `dm.stash.split {allocations:
 *        [{slotId, cp?, sp?, ep?, gp?, pp?}]}` (coins move from the
 *        stash to each seat's purse) and seat intent `stash.take {slotId,
 *        amount: {cp?, sp?, ep?, gp?, pp?}}` (only on a loot node whose
 *        `assign` is 'free'); each seat's move is one `currency.changed`
 *        run event with before / after `{currency, stash}`.
 *        `run.snapshot` / `run.updated` carry `pendingXp` (null, or
 *        `{total, perCharacter, nodeId, encounterIds}`): under campaign
 *        setting `xpAward: 'confirm'` an encounter's award is held until
 *        `dm.run.advance` or `dm.xp.adjust` (delta 0 only confirms) turns
 *        it into `xp.awarded {confirmed: true}`. Under `levelUpMode:
 *        'auto'` a queued level whose plan has no choices applies at
 *        once (a system `level.applied`).
 *        Seat intent `cast.downtime {casterSlotId, spellId, targetSlotId?,
 *        targetSlotIds?, slotLevel?, slotKind?}` (the caster seat's
 *        controller, or the DM for any seat; between nodes only): Cure
 *        Wounds / Healing Word / Prayer of Healing with a real slot
 *        (campaign/downtime-spells.js castDowntimeHeal, run RNG), one
 *        `heal.cast` run event.
 *
 * Client payloads are strict (unknown fields rejected); server payloads
 * enforce required fields and allow additive ones.
 *
 * Imported by both Vite and Node: no DOM, no Node built-ins.
 */

import {
  createCollector, checkSpec, checkJsonSafe, isPlainObject,
  str, int, num, bool, oneOf, arrayOf, shape, mapOf, anyJson, optional, nullable,
  VALIDATION_CODES
} from './check.js';
import { CONTROLLER_TYPES, validateEncounterState } from './encounter-state.js';
import { EVENT_TYPES, REACTION_KINDS, ENCOUNTER_OUTCOMES, ENTITY_STATUSES, validateEvent } from './events.js';
import { ENCOUNTER_SETUP_SPEC } from './encounter-setup.js';
import { LEVEL_UP_MODES } from './campaign.js';
import { RUN_STATUSES, RUN_OUTCOMES, LIFE_STATUSES, LEVEL_UP_STATUSES, validateRunState } from './run-state.js';
import { RUN_REST_TYPES, validateRunEvent } from './run-events.js';

/** Wire protocol version; every message's `v` must equal this. */
export const PROTOCOL_VERSION = 1;
/** Additive minor revision of protocol v1 (see the header). */
export const PROTOCOL_MINOR = 7;
/** Longest accepted client message id. */
export const MAX_CID_LENGTH = 64;

/** Who may send an intent. 'seat' = the controller of the acting entity (the DM for dm-controlled ones). */
export const INTENT_ROLES = Object.freeze({
  hello: 'any',
  resync: 'any',
  'seat.claim': 'player',
  'seat.release': 'player',
  'char.setStyle': 'seat',
  'turn.act': 'seat',
  'turn.delegate': 'seat',
  'prompt.answer': 'addressee',
  'cinema.done': 'any',
  'dm.encounter.setup': 'dm',
  'dm.initiative.roll': 'dm',
  'dm.initiative.set': 'dm',
  'dm.encounter.start': 'dm',
  'dm.encounter.end': 'dm',
  'dm.pause': 'dm',
  'dm.resume': 'dm',
  'dm.turn.skip': 'dm',
  'dm.seat.setController': 'dm',
  'dm.entity.patch': 'dm',
  'dm.entity.add': 'dm',
  'dm.entity.remove': 'dm',
  'dm.terrain.paint': 'dm',
  'dm.spell.adjudicate': 'dm',
  'dm.roll.arm': 'dm',
  'dm.review.set': 'dm',
  'dm.prompt.force': 'dm',
  'dm.member.revoke': 'dm',
  'dm.room.settings': 'dm',   // v1.4
  'dm.fog.paint': 'dm',       // v1.4
  // v1.6 (M65) — between-node player intents. 'seat' = the controller of `slotId`.
  'rest.spend': 'seat',
  'loot.claim': 'seat',
  'item.equip': 'seat',
  'item.give': 'seat',
  'item.use': 'seat',
  'shop.buy': 'seat',
  'shop.sell': 'seat',
  'story.choose': 'player',
  'levelup.choose': 'seat',
  'levelup.reconcile': 'seat',
  'seat.reclaim': 'player',
  // v1.6 (M65) — the DM's run controls.
  'dm.run.advance': 'dm',
  'dm.run.end': 'dm',
  'dm.node.begin': 'dm',
  'dm.rest.grant': 'dm',
  'dm.loot.assign': 'dm',
  'dm.story.resolve': 'dm',
  'dm.xp.adjust': 'dm',
  'dm.levelup.confirm': 'dm',
  'dm.levelup.revert': 'dm',
  'dm.character.revive': 'dm',
  'dm.character.retire': 'dm',
  'dm.seat.fill': 'dm',
  'dm.snapshot.save': 'dm',
  'dm.snapshot.load': 'dm',
  'dm.seat.reclaim.approve': 'dm',
  // v1.7 (E3 M65 W4) — the party stash's coin.
  'dm.stash.split': 'dm',
  'stash.take': 'seat',
  'cast.downtime': 'seat'   // the caster's seat (casterSlotId)
});

/** v1.4 room settings: who sees DM fudges (dm.override), and the grid's diagonal rule. */
export const FUDGE_VISIBILITY = Object.freeze(['public', 'dm-only']);
export const DIAGONAL_RULES = Object.freeze(['5ft', '5-10']);   // '5-10': v1.6, DMG alternating diagonals (E5)
/** Bounds on the per-room reaction prompt deadline (ms). */
export const REACTION_TIMEOUT_RANGE = Object.freeze({ min: 1000, max: 120000 });

/** Every client → server message type. */
export const INTENT_TYPES = Object.freeze(Object.keys(INTENT_ROLES));

/** Room-level (non-engine) server message types and their scope. */
const ROOM_MESSAGE_SCOPES = {
  'hello.ok': 'private',
  'room.snapshot': 'private',
  ack: 'private',
  error: 'private',
  'prompt.open': 'private',
  'prompt.closed': 'private',
  'turn.planProposed': 'private',
  'member.joined': 'broadcast',
  'member.left': 'broadcast',
  'member.presence': 'broadcast',
  'seat.updated': 'broadcast',
  'encounter.created': 'broadcast',
  'encounter.initiative': 'broadcast',
  'round.started': 'broadcast',
  'entity.updated': 'broadcast',
  'room.status': 'broadcast',
  'room.closing': 'broadcast',
  'room.settings': 'broadcast',   // v1.4
  'encounter.fog': 'broadcast',   // v1.5
  'run.snapshot': 'private',      // v1.6
  'levelup.offer': 'private',     // v1.6
  'run.updated': 'broadcast',     // v1.6
  'run.event': 'broadcast',       // v1.6
  redacted: 'broadcast'
};

/** 'broadcast' (sequenced) or 'private' (no seq) for every server message type. */
export const SERVER_MESSAGE_SCOPE = Object.freeze({
  ...ROOM_MESSAGE_SCOPES,
  ...Object.fromEntries(EVENT_TYPES.map(t => [t, 'broadcast']))
});

/** Every server → client message type (room messages + engine events). */
export const SERVER_MESSAGE_TYPES = Object.freeze(Object.keys(SERVER_MESSAGE_SCOPE));

/** Error codes carried by `error` frames. */
export const ERROR_CODES = Object.freeze([
  'E_BAD_MESSAGE', 'E_VERSION', 'E_UNKNOWN_TYPE', 'E_UNAUTHENTICATED', 'E_FORBIDDEN',
  'E_STALE', 'E_NOT_YOUR_TURN', 'E_INVALID_INTENT', 'E_ROOM_FULL', 'E_SEAT_TAKEN',
  'E_RATE_LIMITED', 'E_INTERNAL',
  // v1.6 (E3 M65 B24): a between-node intent while an encounter is live; a run intent in a room without an open run.
  'E_ENCOUNTER_LIVE', 'E_NO_RUN',
  // v1.6 (E3 M65 B24): dm.encounter.setup / start in a run outside a begun encounter node.
  'E_NODE_NOT_BEGUN'
]);
/**
 * v1.6 (E3 M65 B24): an `error` frame may instead carry a campaign rule
 * code — the stable `.code` of a CampaignRuleError (src/js/campaign/
 * errors.js: 'hit-dice-overspent', 'needs-hp', 'attunement-full', …),
 * lower-case kebab, with the rule's structured `details`.
 */
export const RULE_ERROR_CODE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/** ws close codes used by the gateway (B7, B9). */
export const CLOSE_CODES = Object.freeze({
  NORMAL: 1000,
  POLICY: 1008,            // token bucket exceeded
  TOO_BIG: 1009,           // maxPayload
  RESTARTING: 1012,        // graceful shutdown
  HELLO_TIMEOUT: 4401,     // no valid hello within 5 s
  REVOKED: 4403,           // dm.member.revoke
  SUPERSEDED: 4409         // same member connected elsewhere
});

/** Room status values (`room.status`). */
export const ROOM_STATUSES = Object.freeze(['lobby', 'setup', 'in-encounter', 'paused', 'encounter-over', 'closed', 'error',
  'between']);   // v1.6: a run between nodes
/** Prompt kinds: the three reactions plus DM plan / roll review. */
export const PROMPT_KINDS = Object.freeze([...REACTION_KINDS, 'plan', 'roll']);
/** Rolls the DM may arm or edit in phase 1 (monster / AI rolls only). */
export const ROLL_KINDS = Object.freeze(['attack', 'damage', 'save']);
/** Fog brush operations (`dm.fog.paint`), v1.4. */
export const FOG_PAINT_OPS = Object.freeze(['reveal', 'hide']);

/** Plan kinds a client may submit in `turn.act`. */
export const INTENT_PLAN_KINDS = Object.freeze(['melee', 'ranged', 'attack', 'cast', 'dash', 'dodge', 'disengage', 'move', 'feature',
  'item']);   // v1.6 (M65 T23): use a potion / consumable
/** How the DM brings a dead character back (v1.6). */
export const DM_REVIVE_METHODS = Object.freeze(['revivify', 'raise-dead', 'dm']);

const ID = str({ maxLength: 128 });
const POS = shape({ col: int(0), row: int(0) });
const LOOSE = { strict: false };

const PLAN = shape({
  kind: oneOf(INTENT_PLAN_KINDS),
  targetId: optional(nullable(ID)),
  targetSide: optional(oneOf(['enemy', 'ally'])),
  weaponName: optional(str({ maxLength: 128 })),
  spellId: optional(str({ maxLength: 128 })),
  castAtLevel: optional(int(0, 9)),
  moveTo: optional(POS),
  path: optional(arrayOf(POS, { max: 64 })),
  features: optional(arrayOf(str({ maxLength: 64 }), { max: 8, unique: true })),
  featureId: optional(str({ maxLength: 64 })),  // v1.4 — a `feature` action (Second Wind, Rage)
  itemId: optional(ID)                          // v1.6 — an `item` action: the entity's resources.items key
});

const SLOT_ID = ID;
const QTY = int(1, 999);
const COINS_SPEC = { cp: optional(int(0, 1e9)), sp: optional(int(0, 1e9)), ep: optional(int(0, 1e9)), gp: optional(int(0, 1e9)), pp: optional(int(0, 1e9)) };
const ABILITY_KEY = /^(STR|DEX|CON|INT|WIS|CHA)$/;
const LEVELUP_CHOICES = shape({
  asi: optional(mapOf(int(1, 2), { keyPattern: ABILITY_KEY })),   // +2 one, or +1/+1
  spells: optional(arrayOf(str({ maxLength: 128 }), { max: 8, unique: true })),
  className: optional(str({ maxLength: 64 }))   // which existing class gains the level
});

/** Client payload specs (strict). Exported frozen as INTENT_PAYLOAD_SPECS below. */
const INTENT_PAYLOADS = {
  hello: shape({ token: str({ maxLength: 512 }), protocol: int(1), lastSeq: optional(int(0)) }),
  resync: shape({ lastSeq: optional(int(0)) }),
  'seat.claim': shape({ characterId: ID }),
  'seat.release': shape({ characterId: ID }),
  'char.setStyle': shape({ characterId: ID, style: str({ maxLength: 32 }), swing: nullable(str({ maxLength: 32 })) }),
  'turn.act': shape({ turnId: ID, plan: PLAN }),
  'turn.delegate': shape({ turnId: ID }),
  'prompt.answer': shape({ promptId: ID, answer: anyJson() }),
  'cinema.done': shape({ exchangeId: ID }),
  'dm.encounter.setup': ENCOUNTER_SETUP_SPEC,   // encounter-setup.js (shared with campaign.js)
  'dm.initiative.roll': shape({}),
  'dm.initiative.set': shape({ order: arrayOf(ID, { min: 1, unique: true }) }),
  'dm.encounter.start': shape({ seed: optional(int(0, 0xFFFFFFFF)) }),
  'dm.encounter.end': shape({ outcome: optional(oneOf(ENCOUNTER_OUTCOMES)) }),
  'dm.pause': shape({}),
  'dm.resume': shape({}),
  'dm.turn.skip': shape({ entityId: optional(ID) }),
  'dm.seat.setController': shape({ entityId: ID, controller: oneOf(CONTROLLER_TYPES), memberId: optional(nullable(ID)) }),
  'dm.entity.patch': shape({
    entityId: ID,
    hp: optional(int(0)),
    hpTemp: optional(int(0)),
    addConditions: optional(arrayOf(str({ maxLength: 64 }))),
    removeConditions: optional(arrayOf(str({ maxLength: 64 }))),
    position: optional(POS),
    override: optional(bool()),   // v1.1 — DM free move (teleport)
    // v1.4 — the dying state (E1 wave 5 entity fields).
    status: optional(oneOf(ENTITY_STATUSES)),
    deathSaves: optional(shape({ successes: int(0, 3), failures: int(0, 3), stable: optional(bool()) })),
    // v1.5 — the DM's token image (same-origin path; null clears it).
    imageUrl: optional(nullable(str({ maxLength: 2048, pattern: /^\/(?![/\\])\S*$/ })))
  }),
  'dm.entity.add': shape({ entity: shape({}, LOOSE), initiativeScore: optional(num()) }),
  'dm.entity.remove': shape({ entityId: ID }),
  'dm.terrain.paint': shape({ cells: arrayOf(POS, { min: 1, max: 4096 }), flags: int(0, 255), mode: oneOf(['set', 'clear']) }),
  'dm.roll.arm': shape({ entityId: optional(nullable(ID)), rollKind: oneOf(ROLL_KINDS), value: int() }),
  'dm.review.set': shape({ plans: optional(bool()), rolls: optional(bool()), monsterReactions: optional(bool()), aiParty: optional(bool()) }),   // aiParty: v1.2
  'dm.prompt.force': shape({ promptId: ID, answer: anyJson() }),
  'dm.member.revoke': shape({ memberId: ID }),
  // v1.4 — room settings (partial; the server requires at least one key).
  'dm.room.settings': shape({
    reactionTimeoutMs: optional(int(REACTION_TIMEOUT_RANGE.min, REACTION_TIMEOUT_RANGE.max)),
    importLiveState: optional(bool()),
    fudgeVisibility: optional(oneOf(FUDGE_VISIBILITY)),
    diagonalRule: optional(oneOf(DIAGONAL_RULES)),
    dmDrivesAiSeats: optional(bool()),   // v1.6 (E3 M65 B28): solo rooms — the DM drives every seat no player holds
    autoFight: optional(bool())          // v1.6 (E3 M65 B28): hand those seats to the AI (also mid-encounter)
  }),
  // v1.4 — the DM's fog reveal / hide brush.
  'dm.fog.paint': shape({ cells: arrayOf(POS, { min: 1, max: 4096 }), op: oneOf(FOG_PAINT_OPS) }),
  // v1.6 (M65) — between-node player intents.
  'rest.spend': shape({ slotId: SLOT_ID, hitDice: mapOf(int(1, 20), { keyPattern: /^[A-Za-z][A-Za-z '-]{0,63}$/ }) }),
  'loot.claim': shape({ slotId: SLOT_ID, itemId: ID, qty: optional(QTY) }),
  'item.equip': shape({ slotId: SLOT_ID, itemId: ID, equipped: bool(), attuned: optional(bool()) }),
  'item.give': shape({ slotId: SLOT_ID, itemId: ID, toSlotId: nullable(SLOT_ID), qty: optional(QTY) }),
  'item.use': shape({ slotId: SLOT_ID, itemId: ID, targetSlotId: optional(SLOT_ID) }),
  'shop.buy': shape({ slotId: SLOT_ID, refKey: str({ maxLength: 128 }), qty: int(1, 99) }),
  'shop.sell': shape({ slotId: SLOT_ID, itemId: ID, qty: QTY }),
  'story.choose': shape({ nodeId: ID, choiceId: ID }),
  'levelup.choose': shape({ slotId: SLOT_ID, levelUpId: ID, choices: LEVELUP_CHOICES }),
  'levelup.reconcile': shape({ slotId: SLOT_ID }),
  'seat.reclaim': shape({ slotId: SLOT_ID }),
  // v1.6 (M65) — the DM's run controls.
  'dm.run.advance': shape({ toNodeId: ID, override: optional(bool()) }),   // override: "go to any node"
  'dm.run.end': shape({ outcome: oneOf(RUN_OUTCOMES) }),
  'dm.node.begin': shape({ setup: optional(ENCOUNTER_SETUP_SPEC), nodeId: optional(ID) }),   // the DM's tweak of an encounter node; nodeId (E3 B24): the node to enter
  'dm.rest.grant': shape({ type: oneOf(RUN_REST_TYPES), slotIds: optional(arrayOf(SLOT_ID, { min: 1, max: 6, unique: true })) }),
  'dm.loot.assign': shape({ itemId: ID, toSlotId: nullable(SLOT_ID), qty: optional(QTY) }),
  'dm.story.resolve': shape({ nodeId: ID, choiceId: ID }),
  'dm.xp.adjust': shape({ slotId: SLOT_ID, delta: int(-355000, 355000), reason: optional(str({ maxLength: 200 })) }),
  'dm.levelup.confirm': shape({ levelUpId: ID, choices: optional(LEVELUP_CHOICES) }),
  'dm.levelup.revert': shape({ levelUpId: ID }),
  'dm.character.revive': shape({ slotId: SLOT_ID, method: oneOf(DM_REVIVE_METHODS), casterSlotId: optional(SLOT_ID) }),
  'dm.character.retire': shape({ slotId: SLOT_ID, reason: optional(str({ maxLength: 200 })) }),
  'dm.seat.fill': shape({
    seat: int(1, 6),
    characterId: nullable(ID),                 // null = an AI seat with no character yet
    controller: oneOf(CONTROLLER_TYPES),
    memberId: optional(nullable(ID)),
    level: optional(int(1, 20))
  }),
  'dm.snapshot.save': shape({ label: optional(str({ maxLength: 128 })) }),
  'dm.snapshot.load': shape({ snapshotId: ID }),
  'dm.seat.reclaim.approve': shape({ slotId: SLOT_ID, memberId: ID, approve: bool() }),
  // v1.7 (E3 M65 W4) — the party stash's coin (the server requires some coin in each allocation / amount).
  'dm.stash.split': shape({ allocations: arrayOf(shape({ slotId: SLOT_ID, ...COINS_SPEC }), { min: 1, max: 6 }) }),
  'stash.take': shape({ slotId: SLOT_ID, amount: shape(COINS_SPEC) }),
  // v1.7 (E3 M65 W4) — a between-node healing spell; one of targetSlotId / targetSlotIds.
  'cast.downtime': shape({
    casterSlotId: SLOT_ID, spellId: str({ maxLength: 64 }),
    targetSlotId: optional(SLOT_ID), targetSlotIds: optional(arrayOf(SLOT_ID, { min: 1, max: 6, unique: true })),
    slotLevel: optional(int(1, 9)), slotKind: optional(oneOf(['spell', 'pact']))
  }),
  // v1.3 — the DM resolves a spell outside the engine's registry.
  'dm.spell.adjudicate': shape({
    casterId: ID,
    spellId: str({ maxLength: 128 }),
    targets: arrayOf(shape({
      entityId: ID,
      damage: optional(int(0, 999)),
      type: optional(nullable(str({ maxLength: 32 }))),
      healed: optional(int(0, 999)),
      conditions: optional(arrayOf(str({ maxLength: 64 }), { max: 8, unique: true }))
    }), { min: 1, max: 16 }),
    slotLevel: optional(nullable(int(1, 9)))
  })
};

/** Client payload spec per intent type (strict), for callers that embed an intent payload. */
export const INTENT_PAYLOAD_SPECS = Object.freeze(INTENT_PAYLOADS);

/** Broadcasts a `redacted {type}` may stand in for (v1.4: engine events + entity.updated). */
export const REDACTABLE_TYPES = Object.freeze([...EVENT_TYPES, 'entity.updated']);

/** A run hash (run-state.js runHash: hash53 hex). v1.7. */
const RUN_HASH = str({ pattern: /^[0-9a-f]{1,16}$/ });

/** Server room-message payload specs (required fields; extras allowed). */
const SERVER_PAYLOADS = {
  'hello.ok': shape({ memberId: ID, role: oneOf(['dm', 'player']), seats: arrayOf(shape({}, LOOSE)), serverNow: num(0), cfg: shape({}, LOOSE) }, LOOSE),
  'room.snapshot': shape({
    seq: int(0), room: shape({}, LOOSE),
    encounter: nullable(shape({}, LOOSE)),
    openPrompt: optional(nullable(shape({}, LOOSE))),
    history: arrayOf(shape({}, LOOSE))
  }, LOOSE),
  ack: shape({ cid: str({ maxLength: MAX_CID_LENGTH }), ok: bool() }, LOOSE),
  error: shape({ cid: nullable(str({ maxLength: MAX_CID_LENGTH })), code: str({ maxLength: 64 }), message: str() }, LOOSE),   // code: ERROR_CODES or RULE_ERROR_CODE (checked below)
  'prompt.open': shape({
    promptId: ID, kind: oneOf(PROMPT_KINDS), payload: shape({}, LOOSE),
    autoAnswer: anyJson(), deadlineAt: num(0), serverNow: num(0)
  }, LOOSE),
  'prompt.closed': shape({ promptId: ID, reason: str() }, LOOSE),
  'turn.planProposed': shape({ entityId: ID, plan: shape({}, LOOSE), breakdown: arrayOf(anyJson()) }, LOOSE),
  'member.joined': shape({ memberId: ID, displayName: str({ maxLength: 64 }) }, LOOSE),
  'member.left': shape({ memberId: ID }, LOOSE),
  'member.presence': shape({ memberId: ID, online: bool() }, LOOSE),
  'seat.updated': shape({ characterId: ID, memberId: nullable(ID), controller: oneOf(CONTROLLER_TYPES) }, LOOSE),
  'encounter.created': shape({ encounterId: ID }, LOOSE),
  'encounter.initiative': shape({ order: arrayOf(shape({ entityId: ID, score: num() }, LOOSE)) }, LOOSE),
  'round.started': shape({ round: int(1) }, LOOSE),
  'entity.updated': shape({ entityId: ID, patch: shape({}, LOOSE), cause: str() }, LOOSE),
  'room.status': shape({ status: oneOf(ROOM_STATUSES) }, LOOSE),
  'room.closing': shape({ reason: str() }, LOOSE),
  'room.settings': shape({ settings: shape({
    reactionTimeoutMs: int(0), importLiveState: bool(), fudgeVisibility: oneOf(FUDGE_VISIBILITY), diagonalRule: oneOf(DIAGONAL_RULES)
  }, LOOSE) }, LOOSE),   // v1.4
  'encounter.fog': shape({ fog: shape({ revealed: str({ allowEmpty: true, pattern: /^[A-Za-z0-9+/]*={0,2}$/ }) }, LOOSE) }, LOOSE),   // v1.5
  redacted: shape({ type: oneOf(REDACTABLE_TYPES) }, LOOSE),   // v1.4: + entity.updated
  // v1.6 (M65) — the run. `run.seq` / `runSeq` is the run event seq, not the room seq.
  'run.snapshot': shape({
    run: shape({ id: ID, status: oneOf(RUN_STATUSES), currentNodeId: nullable(ID), seq: int(0) }, LOOSE),
    nodes: arrayOf(shape({ id: ID, kind: str(), title: str({ allowEmpty: true }) }, LOOSE)),   // visited (players) / all (DM)
    edges: arrayOf(shape({ to: ID }, LOOSE)),                                             // offered now
    characters: arrayOf(shape({
      slotId: ID, seat: int(1, 6), level: int(1, 20), xp: int(0), lifeStatus: oneOf(LIFE_STATUSES),
      state: optional(anyJson())   // validated as state_json v1 when present
    }, LOOSE), { max: 6 }),
    items: arrayOf(shape({ id: ID, ownerSlotId: nullable(ID), name: str(), qty: int(0) }, LOOSE)),
    levelUps: arrayOf(shape({ id: ID, slotId: ID, status: oneOf(LEVEL_UP_STATUSES) }, LOOSE)),
    runHash: optional(RUN_HASH), wireHash: optional(RUN_HASH)   // v1.7
  }, LOOSE),
  'run.updated': shape({
    runId: ID, status: oneOf(RUN_STATUSES), currentNodeId: nullable(ID), runSeq: int(0),
    runHash: optional(RUN_HASH), wireHash: optional(RUN_HASH)   // v1.7
  }, LOOSE),
  'run.event': shape({}, LOOSE),   // a run event, validated with validateRunEvent
  'levelup.offer': shape({
    levelUpId: ID, slotId: ID, fromLevel: int(1, 20), toLevel: int(1, 20),
    mode: oneOf(LEVEL_UP_MODES), status: oneOf(LEVEL_UP_STATUSES),
    auto: shape({}, LOOSE), choices: optional(shape({}, LOOSE))
  }, LOOSE)
};

const CLIENT_ENVELOPE = shape({
  v: anyJson(),
  t: str({ maxLength: 64 }),
  cid: str({ maxLength: MAX_CID_LENGTH }),
  p: shape({}, LOOSE)
});

const SERVER_ENVELOPE = shape({
  v: anyJson(),
  t: str({ maxLength: 64 }),
  seq: optional(int(1)),
  ts: num(0),
  p: shape({}, LOOSE)
});

function checkVersion(c, msg) {
  if (isPlainObject(msg) && msg.v !== PROTOCOL_VERSION) {
    c.add('v', VALIDATION_CODES.VERSION, `expected ${PROTOCOL_VERSION}, got ${JSON.stringify(msg.v)}`);
  }
}

/**
 * Validate a client → server message.
 * @param {unknown} msg
 * @returns {import('./check.js').ValidationResult}
 */
export function validateClientMessage(msg) {
  const c = createCollector();
  checkJsonSafe(c, msg, '');
  checkSpec(c, msg, CLIENT_ENVELOPE, '');
  checkVersion(c, msg);
  if (!isPlainObject(msg) || typeof msg.t !== 'string') return c.result();
  if (!Object.prototype.hasOwnProperty.call(INTENT_PAYLOADS, msg.t)) {
    c.add('t', VALIDATION_CODES.ENUM, `unknown intent type "${msg.t}"`);
    return c.result();
  }
  if (isPlainObject(msg.p)) checkSpec(c, msg.p, INTENT_PAYLOADS[msg.t], 'p');
  return c.result();
}

/**
 * Validate a server → client message. Engine-event broadcasts are
 * validated with validateEvent and must repeat the envelope seq;
 * `room.snapshot.encounter` must be a projected EncounterState.
 * @param {unknown} msg
 * @returns {import('./check.js').ValidationResult}
 */
export function validateServerMessage(msg) {
  const c = createCollector();
  checkJsonSafe(c, msg, '');
  checkSpec(c, msg, SERVER_ENVELOPE, '');
  checkVersion(c, msg);
  if (!isPlainObject(msg) || typeof msg.t !== 'string') return c.result();
  const scope = SERVER_MESSAGE_SCOPE[msg.t];
  if (!scope) {
    c.add('t', VALIDATION_CODES.ENUM, `unknown server message type "${msg.t}"`);
    return c.result();
  }
  if (scope === 'broadcast' && msg.seq === undefined) {
    c.add('seq', VALIDATION_CODES.REQUIRED, `broadcast "${msg.t}" must carry seq`);
  }
  if (scope === 'private' && msg.seq !== undefined) {
    c.add('seq', VALIDATION_CODES.FORBIDDEN_FIELD, `private "${msg.t}" must not carry seq`);
  }
  if (!isPlainObject(msg.p)) return c.result();

  if (EVENT_TYPES.includes(msg.t)) {
    for (const err of validateEvent(msg.p).errors) {
      c.add(err.path ? `p.${err.path}` : 'p', err.code, err.message);
    }
    if (msg.p.type !== msg.t) c.add('p.type', VALIDATION_CODES.REF, `must equal t "${msg.t}"`);
    if (msg.p.seq !== msg.seq) c.add('p.seq', VALIDATION_CODES.REF, 'must equal the envelope seq');
    return c.result();
  }

  checkSpec(c, msg.p, SERVER_PAYLOADS[msg.t], 'p');
  if (msg.t === 'error' && typeof msg.p.code === 'string' && !ERROR_CODES.includes(msg.p.code) && !RULE_ERROR_CODE.test(msg.p.code)) {
    c.add('p.code', VALIDATION_CODES.ENUM, `must be one of ${ERROR_CODES.join(', ')} or a campaign rule code`);
  }
  if (msg.t === 'run.event') {
    for (const err of validateRunEvent(msg.p).errors) c.add(err.path ? `p.${err.path}` : 'p', err.code, err.message);
  }
  if (msg.t === 'run.snapshot' && Array.isArray(msg.p.characters)) {
    msg.p.characters.forEach((ch, i) => {
      if (!isPlainObject(ch) || ch.state === undefined) return;
      for (const err of validateRunState(ch.state).errors) {
        c.add(err.path ? `p.characters[${i}].state.${err.path}` : `p.characters[${i}].state`, err.code, err.message);
      }
    });
  }
  if (msg.t === 'room.snapshot' && isPlainObject(msg.p.encounter)) {
    for (const err of validateEncounterState(msg.p.encounter, { projected: true }).errors) {
      c.add(err.path ? `p.encounter.${err.path}` : 'p.encounter', err.code, err.message);
    }
  }
  return c.result();
}
