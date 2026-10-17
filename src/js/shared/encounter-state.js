/**
 * M64 contract 1 of 3 — EncounterState v1.
 *
 * The complete, pure-JSON state of one grid encounter. The server owns
 * it, persists it as `encounters.snapshot_json`, and projects it per seat
 * (`viewFor`) for clients. The engine reaches it only through the
 * adapters in `src/js/scene/encounter-adapters.js` (M64 T5); today's
 * wrapper underscore fields are mapped in WRAPPER_FIELD_MAP below — a
 * wrapper field that is not listed there does NOT survive a snapshot.
 *
 * Field list: docs/M64-ONLINE-TABLE-PLAN.md "Contracts" §1 and the E1
 * engine review §4. Changing anything here bumps ENCOUNTER_STATE_VERSION
 * and needs acknowledgement from every branch owner.
 *
 * Imported by both Vite (browser) and Node (server): no DOM, no Node
 * built-ins, no `import.meta`.
 *
 * Decisions recorded here (v1):
 *   - Spell slots, pact slots and limited-use features store `{max, spent}`.
 *     `spent` is the ledger; `max` is derived from the sheet or stat block
 *     when the encounter starts and is carried so monsters (no sheet) and
 *     validators work. Remaining = max - spent.
 *   - `conditions[]` accepts plain strings (today's engine) or the R7
 *     lifecycle objects `{id, sourceId, endsOn, save}` so E4's R7 lands
 *     without a version bump. v1 additive (M64 R7, E1): the object may
 *     carry `appliedRound` (int|null); `endsOn` is one of
 *     'turn-end' | 'turn-start' | 'source-turn-end' | 'concentration' |
 *     'encounter' (src/js/scene/conditions.js). The engine wrapper keeps
 *     string ids in `conditions` and the objects in `_conditionMeta`.
 *   - `legendaryBudget` is the REMAINING budget this round (engine
 *     semantics), not a spent counter.
 *   - v1 additive (M64 phase 1.5, E5 — presentation only, all optional,
 *     no version bump; the engine ignores them):
 *       `facing`   'north'|'east'|'south'|'west' — persisted sprite row; the
 *                  live client derives it from events (map/facing.js)
 *       `size`     SRD size ('Tiny' … 'Gargantuan'); the 2D grid draws a
 *                  Large creature 2×2. Legality stays 1×1 this phase.
 *       `imageUrl` DM-uploaded token image, a same-origin path
 *                  (`/api/maps/<room>/<sha>.<ext>`); drawn instead of the
 *                  LPC sprite for non-humanoid monsters
 */

import {
  createCollector, checkSpec, checkJsonSafe, joinPath,
  str, int, num, bool, oneOf, arrayOf, shape, mapOf, union, anyJson,
  optional, nullable, VALIDATION_CODES
} from './check.js';

/** Contract version; `state.v` must equal this. */
export const ENCOUNTER_STATE_VERSION = 1;

/** Encounter lifecycle phases. */
export const ENCOUNTER_PHASES = Object.freeze(['setup', 'running', 'awaiting-prompt', 'ended']);
/** Entity kinds. */
export const ENTITY_KINDS = Object.freeze(['pc', 'monster']);
/** Sides. */
export const SIDES = Object.freeze(['party', 'hostile']);
/** Who drives an entity's turn. */
export const CONTROLLER_TYPES = Object.freeze(['player', 'ai', 'dm']);
/** Sprite facings (v1 additive, E5 phase 1.5). */
export const ENTITY_FACINGS = Object.freeze(['north', 'east', 'south', 'west']);
/** SRD creature sizes (v1 additive, E5 phase 1.5). */
export const ENTITY_SIZES = Object.freeze(['Tiny', 'Small', 'Medium', 'Large', 'Huge', 'Gargantuan']);
/** Ability keys used by saves and conditions. */
export const ABILITIES = Object.freeze(['STR', 'DEX', 'CON', 'INT', 'WIS', 'CHA']);
/** RNG algorithms the state may name. */
export const RNG_ALGOS = Object.freeze(['mulberry32']);
/** Per-turn flags (reset by the turn manager). */
export const TURN_FLAG_KEYS = Object.freeze([
  'sneakUsed', 'cunningUsed', 'recklessUsed', 'recklessUntilNextTurn',
  'shieldActive', 'surgeFired', 'extraAction', 'smiteSlotUsed',
  // v1 additive (M64 R13, E1): Dodge lasts until the creature's next turn.
  'dodging', 'disengaged'
]);

/**
 * Where every engine wrapper field lives in EncounterState v1.
 * Value = dotted path under `entities[id]`, or `null` for fields that are
 * transient (recomputed per turn, derived from events, or holding object
 * references) and therefore never persisted.
 * @type {Readonly<Record<string, string|null>>}
 */
export const WRAPPER_FIELD_MAP = Object.freeze({
  id: 'id',
  kind: 'kind',
  name: 'name',
  hp: 'hp',
  hpMax: 'hpMax',
  ac: 'ac',
  conditions: 'conditions',
  // v1 additive (M64 R7, E1): lifecycle objects of the wrapper's string ids.
  _conditionMeta: 'conditions',
  position: 'pos',
  _position: 'pos',
  presetSlug: 'statBlock.slug',
  attack: 'statBlock.attacks[0]',
  _aiProfile: 'statBlock.profile',
  ref: 'sheetRef',
  _reactionUsed: 'resources.reactionUsed',
  _slots: 'resources.slots',
  _lvl1Slots: 'resources.slots.1',
  _lvl3Slots: 'resources.slots.3',
  _innate: 'resources.innate',
  _legendaryBudget: 'resources.legendaryBudget',
  _actionSurgeUsed: 'resources.features.action-surge.spent',
  _secondWindUsed: 'resources.features.second-wind.spent',
  _concentrating: 'concentration',
  _sneakAttackUsedThisTurn: 'turnFlags.sneakUsed',
  _cunningActionUsedThisTurn: 'turnFlags.cunningUsed',
  _recklessUsedThisTurn: 'turnFlags.recklessUsed',
  _recklessUntilNextTurn: 'turnFlags.recklessUntilNextTurn',
  _shieldActive: 'turnFlags.shieldActive',
  _surgeFiredThisTurn: 'turnFlags.surgeFired',
  _extraActionThisTurn: 'turnFlags.extraAction',
  _smiteSlotUsed: 'turnFlags.smiteSlotUsed',
  // v1 additive (M64 T5, E1): fields the T5 adapters carry. `_lvl1Slots`
  // and `_lvl3Slots` above are retired by T5 (Shield/Counterspell spend
  // from `_slots`); the entries stay so v1 readers keep resolving them.
  _pact: 'resources.pact',
  hpTemp: 'hpTemp',
  speedFt: 'speedFt',
  saves: 'statBlock.saves',
  secondary: 'statBlock.attacks[1]',
  _dodging: 'turnFlags.dodging',
  _disengaged: 'turnFlags.disengaged',
  // v1 additive (M64 R8, E1): damage R/I/V lists read by applyDamage. PCs
  // carry them on the sheet (`ref`); monsters on the stat block (opaque
  // in v1, so no schema change).
  resistances: 'statBlock.resistances',
  immunities: 'statBlock.immunities',
  vulnerabilities: 'statBlock.vulnerabilities',
  // Transient — never persisted.
  weapon: null,
  _chosenWeapon: null,
  _lastPlan: null,
  _mctsTargetCtx: null,
  damageDealt: null,
  combatMods: null
});

/**
 * @typedef {object} GridPos
 * @property {number} col
 * @property {number} row
 */

/**
 * @typedef {object} SlotLedger
 * @property {number} max   — derived from sheet / stat block at encounter start
 * @property {number} spent — the ledger; remaining = max - spent
 */

/**
 * @typedef {object} EntityResources
 * @property {boolean} reactionUsed
 * @property {Record<string, SlotLedger>} slots       — keyed '1'..'9'
 * @property {{level?: number, max?: number, spent?: number}} pact — {} for non-warlocks
 * @property {{atWill: string[], recharges: Record<string, boolean>, perDay: Record<string, {id: string, remaining: number}[]>}|null} innate
 * @property {number} legendaryBudget                 — remaining this round
 * @property {Record<string, SlotLedger>} features    — e.g. 'action-surge', 'second-wind'
 */

/**
 * @typedef {string|{id: string, sourceId?: string|null, endsOn?: string|null, save?: {stat: string, dc: number}|null, appliedRound?: number|null}} Condition
 */

/**
 * @typedef {object} EncounterEntity
 * @property {string} id
 * @property {'pc'|'monster'} kind
 * @property {'party'|'hostile'} side
 * @property {string} name
 * @property {{type: 'player'|'ai'|'dm', seatId: string|null}} controller
 * @property {GridPos} pos
 * @property {number} hp
 * @property {number} hpMax
 * @property {number} hpTemp
 * @property {number} ac
 * @property {number} speedFt
 * @property {Condition[]} conditions
 * @property {{spellId: string, targetIds: string[]}|null} concentration
 * @property {EntityResources} resources
 * @property {Record<string, boolean|number|null>} turnFlags
 * @property {{characterId: string, rev: number|string}|null} [sheetRef]  — PCs
 * @property {{slug: string}|null} [statBlock]                           — monsters (other fields opaque in v1)
 * @property {'north'|'east'|'south'|'west'} [facing]                    — v1 additive (E5): sprite row
 * @property {'Tiny'|'Small'|'Medium'|'Large'|'Huge'|'Gargantuan'} [size] — v1 additive (E5): render footprint
 * @property {string|null} [imageUrl]                                    — v1 additive (E5): DM token image path
 */

/**
 * @typedef {object} EncounterState
 * @property {1} v
 * @property {string} encounterId
 * @property {number} round
 * @property {number} turnIndex
 * @property {'setup'|'running'|'awaiting-prompt'|'ended'} phase
 * @property {{algo: 'mulberry32', s: number}} [rng] — absent in per-seat projections
 * @property {{cols: number, rows: number, cellFt: number, flankingEnabled: boolean, terrain?: {v: number, cols: number, rows: number, flags: string}|null}} grid
 * @property {{kind?: 'color'|'generated'|'image', url?: string|null, color?: string, biome?: string|null, seed?: number, preset?: string|null, imageId?: string|null, imgW?: number, imgH?: number, calib?: {cellPx: number, offsetX: number, offsetY: number}, cinemaBiome?: string|null}|null} map
 * @property {{entityId: string, score: number}[]} initiative
 * @property {{revealed: string}|null} [fog] — revealed-cell bitset (map/fog.js); absent = no fog
 * @property {Record<string, EncounterEntity>} entities
 * @property {number} lastEventSeq
 */

const ID = str({ maxLength: 128 });
const POS = shape({ col: int(0), row: int(0) });
const LEDGER = shape({ max: int(0), spent: int(0) });
const SLOT_KEY = /^[1-9]$/;

const CONDITION = union(
  str({ maxLength: 64 }),
  shape({
    id: str({ maxLength: 64 }),
    sourceId: optional(nullable(ID)),
    endsOn: optional(nullable(str())),
    save: optional(nullable(shape({ stat: oneOf(ABILITIES), dc: int(0) }))),
    appliedRound: optional(nullable(int(0)))
  })
);

const RESOURCES = shape({
  reactionUsed: bool(),
  slots: mapOf(LEDGER, { keyPattern: SLOT_KEY }),
  pact: shape({ level: optional(int(1, 5)), max: optional(int(0)), spent: optional(int(0)) }),
  innate: nullable(shape({
    atWill: arrayOf(str()),
    recharges: mapOf(bool()),
    perDay: mapOf(arrayOf(shape({ id: str(), remaining: int(0) })), { keyPattern: /^[0-9]+$/ })
  })),
  legendaryBudget: int(0),
  features: mapOf(LEDGER)
});

const TURN_FLAGS = shape({
  sneakUsed: optional(bool()),
  cunningUsed: optional(bool()),
  recklessUsed: optional(bool()),
  recklessUntilNextTurn: optional(bool()),
  shieldActive: optional(bool()),
  surgeFired: optional(bool()),
  extraAction: optional(bool()),
  smiteSlotUsed: optional(nullable(int(1, 9))),
  dodging: optional(bool()),
  disengaged: optional(bool())
});

const ENTITY = shape({
  id: ID,
  kind: oneOf(ENTITY_KINDS),
  side: oneOf(SIDES),
  name: str({ maxLength: 128 }),
  controller: shape({ type: oneOf(CONTROLLER_TYPES), seatId: nullable(ID) }),
  pos: POS,
  hp: int(0),
  hpMax: int(1),
  hpTemp: int(0),
  ac: int(0, 50),
  speedFt: int(0, 500),
  conditions: arrayOf(CONDITION),
  concentration: nullable(shape({ spellId: str(), targetIds: arrayOf(ID) })),
  resources: RESOURCES,
  turnFlags: TURN_FLAGS,
  sheetRef: optional(nullable(shape({ characterId: ID, rev: union(int(0), str()) }))),
  statBlock: optional(nullable(shape({ slug: str({ maxLength: 128 }) }, { strict: false }))),
  // v1 additive (E5, M64 phase 1.5): presentation-only, optional.
  facing: optional(oneOf(ENTITY_FACINGS)),
  size: optional(oneOf(ENTITY_SIZES)),
  imageUrl: optional(nullable(str({ maxLength: 2048, pattern: /^\/(?![/\\])\S*$/ })))
});

const TERRAIN = shape({
  v: int(1),
  cols: int(1),
  rows: int(1),
  flags: str({ allowEmpty: true, pattern: /^[A-Za-z0-9+/]*={0,2}$/ })
});

/** Map background kinds (`map.kind`). */
export const MAP_KINDS = Object.freeze(['color', 'generated', 'image']);

// v1 additive fields (E5, M64 Wave 3 — all optional, so no version bump):
// `kind`, `url`, `color`, `biome`, `seed`, `preset`. They let the 2D
// renderer draw every background kind from state, and carry the served
// image URL next to its content-hash `imageId`.
const MAP = shape({
  kind: optional(oneOf(MAP_KINDS)),
  url: optional(nullable(str({ maxLength: 2048 }))),
  color: optional(str({ maxLength: 64 })),
  biome: optional(nullable(str({ maxLength: 64 }))),
  seed: optional(int(0, 0xFFFFFFFF)),
  preset: optional(nullable(str({ maxLength: 64 }))),
  imageId: optional(nullable(str())),
  imgW: optional(int(1)),
  imgH: optional(int(1)),
  calib: optional(shape({ cellPx: num(0, Infinity, { exclusiveMin: true }), offsetX: num(), offsetY: num() })),
  cinemaBiome: optional(nullable(str()))
});

function topSpec(projected) {
  return shape({
    v: anyJson(),   // checked explicitly (VERSION code)
    encounterId: ID,
    round: int(0),
    turnIndex: int(0),
    phase: oneOf(ENCOUNTER_PHASES),
    rng: projected
      ? optional(anyJson())   // presence is reported as FORBIDDEN_FIELD below
      : shape({ algo: oneOf(RNG_ALGOS), s: int(0, 0xFFFFFFFF) }),
    grid: shape({
      cols: int(1, 500),
      rows: int(1, 500),
      cellFt: int(1),
      flankingEnabled: bool(),
      terrain: optional(nullable(TERRAIN))
    }),
    map: nullable(MAP),
    initiative: arrayOf(shape({ entityId: ID, score: num() })),
    // v1 additive (E5, M64 M10): fog-of-war revealed bitset, base64, bit
    // row*cols+col LSB-first (src/js/map/fog.js). Absent/null = no fog.
    fog: optional(nullable(shape({ revealed: str({ allowEmpty: true, pattern: /^[A-Za-z0-9+/]*={0,2}$/ }) }))),
    entities: mapOf(ENTITY),
    lastEventSeq: int(0)
  });
}

const FULL_SPEC = topSpec(false);
const PROJECTED_SPEC = topSpec(true);

/**
 * Validate an EncounterState against contract v1.
 *
 * Checks shape (unknown fields rejected), JSON purity, the version, and
 * cross-references: entity keys match ids, initiative and concentration
 * point at real entities, positions sit inside the grid, ledgers never
 * overspend, PCs carry a `sheetRef` and monsters a `statBlock`.
 *
 * @param {unknown} state
 * @param {{projected?: boolean}} [opts] — `projected: true` validates a
 *   per-seat view, which must NOT carry the RNG state.
 * @returns {import('./check.js').ValidationResult}
 */
export function validateEncounterState(state, opts = {}) {
  const c = createCollector();
  const projected = !!opts.projected;
  checkJsonSafe(c, state, '');
  checkSpec(c, state, projected ? PROJECTED_SPEC : FULL_SPEC, '');
  if (!state || typeof state !== 'object' || Array.isArray(state)) return c.result();

  if (state.v !== ENCOUNTER_STATE_VERSION) {
    c.add('v', VALIDATION_CODES.VERSION, `expected ${ENCOUNTER_STATE_VERSION}, got ${JSON.stringify(state.v)}`);
  }
  if (projected && state.rng !== undefined) {
    c.add('rng', VALIDATION_CODES.FORBIDDEN_FIELD, 'RNG state must never be projected to clients');
  }

  const entities = state.entities && typeof state.entities === 'object' ? state.entities : {};
  const grid = state.grid || {};

  for (const [key, e] of Object.entries(entities)) {
    if (!e || typeof e !== 'object') continue;
    const p = joinPath('entities', key);
    if (e.id !== key) c.add(joinPath(p, 'id'), VALIDATION_CODES.REF, `must equal its key "${key}"`);
    if (Number.isInteger(e.hp) && Number.isInteger(e.hpMax) && e.hp > e.hpMax) {
      c.add(joinPath(p, 'hp'), VALIDATION_CODES.RANGE, `hp ${e.hp} exceeds hpMax ${e.hpMax}`);
    }
    if (e.pos && Number.isInteger(grid.cols) && Number.isInteger(grid.rows)) {
      if (e.pos.col >= grid.cols || e.pos.row >= grid.rows) {
        c.add(joinPath(p, 'pos'), VALIDATION_CODES.RANGE, `(${e.pos.col},${e.pos.row}) is outside the ${grid.cols}x${grid.rows} grid`);
      }
    }
    if (e.controller?.type === 'player' && !e.controller.seatId) {
      c.add(joinPath(p, 'controller.seatId'), VALIDATION_CODES.REQUIRED, 'player-controlled entities need a seatId');
    }
    if (e.kind === 'pc' && !e.sheetRef) {
      c.add(joinPath(p, 'sheetRef'), VALIDATION_CODES.REQUIRED, 'PCs need a sheetRef');
    }
    if (e.kind === 'monster' && !e.statBlock) {
      c.add(joinPath(p, 'statBlock'), VALIDATION_CODES.REQUIRED, 'monsters need a statBlock');
    }
    if (e.sheetRef && e.statBlock) {
      c.add(p, VALIDATION_CODES.TYPE, 'carries both sheetRef and statBlock; exactly one is allowed');
    }
    const res = e.resources;
    if (res && typeof res === 'object') {
      for (const bucket of ['slots', 'features']) {
        for (const [k, l] of Object.entries(res[bucket] || {})) {
          if (l && Number.isInteger(l.spent) && Number.isInteger(l.max) && l.spent > l.max) {
            c.add(joinPath(joinPath(joinPath(p, 'resources'), bucket), k), VALIDATION_CODES.RANGE,
              `spent ${l.spent} exceeds max ${l.max}`);
          }
        }
      }
      const pact = res.pact;
      if (pact && typeof pact === 'object') {
        const n = ['level', 'max', 'spent'].filter(k => pact[k] !== undefined).length;
        if (n !== 0 && n !== 3) {
          c.add(joinPath(p, 'resources.pact'), VALIDATION_CODES.REQUIRED, 'pact is {} or {level, max, spent}');
        } else if (n === 3 && pact.spent > pact.max) {
          c.add(joinPath(p, 'resources.pact'), VALIDATION_CODES.RANGE, `spent ${pact.spent} exceeds max ${pact.max}`);
        }
      }
    }
    for (const tid of e.concentration?.targetIds || []) {
      if (!Object.prototype.hasOwnProperty.call(entities, tid)) {
        c.add(joinPath(p, 'concentration.targetIds'), VALIDATION_CODES.REF, `unknown entity "${tid}"`);
      }
    }
  }

  const seen = new Set();
  (Array.isArray(state.initiative) ? state.initiative : []).forEach((row, i) => {
    const p = joinPath('initiative', i);
    if (!row || typeof row.entityId !== 'string') return;
    if (!Object.prototype.hasOwnProperty.call(entities, row.entityId)) {
      c.add(joinPath(p, 'entityId'), VALIDATION_CODES.REF, `unknown entity "${row.entityId}"`);
    }
    if (seen.has(row.entityId)) c.add(joinPath(p, 'entityId'), VALIDATION_CODES.DUPLICATE, `"${row.entityId}" appears twice`);
    seen.add(row.entityId);
  });
  if (Array.isArray(state.initiative) && state.initiative.length > 0 &&
      Number.isInteger(state.turnIndex) && state.turnIndex >= state.initiative.length) {
    c.add('turnIndex', VALIDATION_CODES.RANGE, `must be < initiative.length (${state.initiative.length})`);
  }

  const terrain = grid.terrain;
  if (terrain && typeof terrain === 'object' &&
      (terrain.cols !== grid.cols || terrain.rows !== grid.rows)) {
    c.add('grid.terrain', VALIDATION_CODES.RANGE, 'terrain cols/rows must match the grid');
  }
  return c.result();
}

/**
 * Build a minimal valid EncounterState in the `setup` phase.
 * @param {{encounterId: string, cols: number, rows: number, seed: number, cellFt?: number, flankingEnabled?: boolean}} args
 * @returns {EncounterState}
 */
export function emptyEncounterState({ encounterId, cols, rows, seed, cellFt = 5, flankingEnabled = false }) {
  return {
    v: ENCOUNTER_STATE_VERSION,
    encounterId,
    round: 0,
    turnIndex: 0,
    phase: 'setup',
    rng: { algo: 'mulberry32', s: seed >>> 0 },
    grid: { cols, rows, cellFt, flankingEnabled },
    map: null,
    initiative: [],
    entities: {},
    lastEventSeq: 0
  };
}
