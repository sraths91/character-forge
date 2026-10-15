/**
 * M64 H1 — EncounterState v1 contract tests.
 *
 * A valid fixture passes; each planted violation fails with a NAMED error
 * ({path, code}), so a contract regression points at the exact field.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  ENCOUNTER_STATE_VERSION, ENCOUNTER_PHASES, ENTITY_KINDS, SIDES, CONTROLLER_TYPES,
  ABILITIES, RNG_ALGOS, TURN_FLAG_KEYS, WRAPPER_FIELD_MAP,
  validateEncounterState, emptyEncounterState
} from '../js/shared/encounter-state.js';
import {
  VALIDATION_CODES, validateSpec, validateJsonSafe, createCollector, joinPath, isPlainObject,
  str, int, num, bool, oneOf, arrayOf, shape, mapOf, union, anyJson, optional, nullable, checkSpec, checkJsonSafe
} from '../js/shared/check.js';

const FIXTURE = JSON.parse(readFileSync(new URL('./fixtures/contracts/encounter-state.valid.json', import.meta.url), 'utf8'));
const fresh = () => clone(FIXTURE);

/** Assert the result failed with an error at `path` carrying `code`. */
/** Deep copy of a JSON fixture. */
const clone = (v) => JSON.parse(JSON.stringify(v));

function assertNamedError(result, path, code) {
  assert.equal(result.ok, false, `expected failure for ${path} (${code})`);
  const hit = result.errors.find(e => e.path === path && e.code === code);
  assert.ok(hit, `expected {path:"${path}", code:"${code}"}, got ${JSON.stringify(result.errors)}`);
}

test('EncounterState: the valid fixture passes', () => {
  const r = validateEncounterState(fresh());
  assert.deepEqual(r.errors, []);
  assert.equal(r.ok, true);
});

test('EncounterState: version constant is 1 and the fixture uses it', () => {
  assert.equal(ENCOUNTER_STATE_VERSION, 1);
  assert.equal(FIXTURE.v, ENCOUNTER_STATE_VERSION);
});

test('EncounterState: emptyEncounterState builds a valid setup-phase state', () => {
  const s = emptyEncounterState({ encounterId: 'e1', cols: 10, rows: 8, seed: 42 });
  assert.deepEqual(validateEncounterState(s).errors, []);
  assert.equal(s.phase, 'setup');
  assert.deepEqual(s.rng, { algo: 'mulberry32', s: 42 });
  assert.equal(s.grid.cellFt, 5);
  assert.deepEqual(JSON.parse(JSON.stringify(s)), s, 'pure JSON');
});

test('EncounterState: a projected view must not carry RNG state', () => {
  const view = fresh();
  delete view.rng;
  assert.deepEqual(validateEncounterState(view, { projected: true }).errors, []);
  assertNamedError(validateEncounterState(fresh(), { projected: true }), 'rng', VALIDATION_CODES.FORBIDDEN_FIELD);
  assertNamedError(validateEncounterState(view), 'rng', VALIDATION_CODES.REQUIRED);
});

const VIOLATIONS = [
  ['wrong version', s => { s.v = 2; }, 'v', 'version'],
  ['missing encounterId', s => { delete s.encounterId; }, 'encounterId', 'required'],
  ['unknown top-level field', s => { s.wallClock = 1; }, 'wallClock', 'unknown_field'],
  ['bad phase', s => { s.phase = 'paused'; }, 'phase', 'enum'],
  ['negative rng state', s => { s.rng.s = -1; }, 'rng.s', 'range'],
  ['unknown rng algo', s => { s.rng.algo = 'xorshift'; }, 'rng.algo', 'enum'],
  ['entity key/id mismatch', s => { s.entities['pc-fighter'].id = 'pc-other'; }, 'entities.pc-fighter.id', 'ref'],
  ['hp above hpMax', s => { s.entities['pc-fighter'].hp = 99; }, 'entities.pc-fighter.hp', 'range'],
  ['fractional hp', s => { s.entities['pc-fighter'].hp = 1.5; }, 'entities.pc-fighter.hp', 'type'],
  ['position outside grid', s => { s.entities['pc-fighter'].pos = { col: 12, row: 0 }; }, 'entities.pc-fighter.pos', 'range'],
  ['leaked underscore wrapper field', s => { s.entities['pc-fighter']._reactionUsed = true; }, 'entities.pc-fighter._reactionUsed', 'unknown_field'],
  ['player controller without seat', s => { s.entities['pc-fighter'].controller.seatId = null; }, 'entities.pc-fighter.controller.seatId', 'required'],
  ['bad controller type', s => { s.entities['pc-wizard'].controller.type = 'bot'; }, 'entities.pc-wizard.controller.type', 'enum'],
  ['PC without sheetRef', s => { delete s.entities['pc-fighter'].sheetRef; }, 'entities.pc-fighter.sheetRef', 'required'],
  ['monster without statBlock', s => { delete s.entities['m-goblin'].statBlock; }, 'entities.m-goblin.statBlock', 'required'],
  ['both sheetRef and statBlock', s => { s.entities['m-goblin'].sheetRef = { characterId: 'x', rev: 1 }; }, 'entities.m-goblin', 'type'],
  ['overspent slot ledger', s => { s.entities['pc-wizard'].resources.slots['3'].spent = 3; }, 'entities.pc-wizard.resources.slots.3', 'range'],
  ['slot level out of range', s => { s.entities['pc-wizard'].resources.slots['10'] = { max: 1, spent: 0 }; }, 'entities.pc-wizard.resources.slots.10', 'range'],
  ['overspent feature', s => { s.entities['pc-fighter'].resources.features['second-wind'].spent = 2; }, 'entities.pc-fighter.resources.features.second-wind', 'range'],
  ['partial pact ledger', s => { s.entities['pc-wizard'].resources.pact = { level: 3 }; }, 'entities.pc-wizard.resources.pact', 'required'],
  ['unknown turn flag', s => { s.entities['pc-fighter'].turnFlags.hasted = true; }, 'entities.pc-fighter.turnFlags.hasted', 'unknown_field'],
  ['condition object without id', s => { s.entities['m-fanatic'].conditions[0] = { sourceId: 'x' }; }, 'entities.m-fanatic.conditions[0]', 'type'],
  ['concentration on unknown target', s => { s.entities['m-fanatic'].concentration.targetIds = ['ghost']; }, 'entities.m-fanatic.concentration.targetIds', 'ref'],
  ['initiative references unknown entity', s => { s.initiative[0].entityId = 'ghost'; }, 'initiative[0].entityId', 'ref'],
  ['initiative duplicate', s => { s.initiative[1].entityId = 'pc-fighter'; }, 'initiative[1].entityId', 'duplicate'],
  ['turnIndex past initiative', s => { s.turnIndex = 4; }, 'turnIndex', 'range'],
  ['terrain size mismatch', s => { s.grid.terrain.cols = 11; }, 'grid.terrain', 'range'],
  ['terrain flags not base64', s => { s.grid.terrain.flags = 'not base64!'; }, 'grid.terrain.flags', 'range'],
  ['map calib cellPx zero', s => { s.map.calib.cellPx = 0; }, 'map.calib.cellPx', 'range'],
  ['undefined value (dropped by JSON)', s => { s.entities['pc-fighter'].turnFlags.sneakUsed = undefined; }, 'entities.pc-fighter.turnFlags.sneakUsed', 'not_json_safe'],
  ['cycle in stat block', s => { s.entities['m-goblin'].statBlock.self = s.entities['m-goblin'].statBlock; }, 'entities.m-goblin.statBlock.self', 'not_json_safe'],
  ['class instance (Date)', s => { s.map.cinemaBiome = new Date(0); }, 'map.cinemaBiome', 'not_json_safe'],
  ['function value (wrapper ref leak)', s => { s.entities['m-goblin'].statBlock.choose = () => 1; }, 'entities.m-goblin.statBlock.choose', 'not_json_safe'],
  ['NaN lastEventSeq', s => { s.lastEventSeq = NaN; }, 'lastEventSeq', 'not_json_safe']
];

for (const [name, mutate, path, code] of VIOLATIONS) {
  test(`EncounterState: planted violation fails — ${name}`, () => {
    const s = fresh();
    mutate(s);
    assertNamedError(validateEncounterState(s), path, code);
  });
}

test('EncounterState: non-object input fails without throwing', () => {
  for (const bad of [null, undefined, 42, 'state', []]) {
    const r = validateEncounterState(bad);
    assert.equal(r.ok, false);
  }
});

test('EncounterState: enum constants are frozen and complete', () => {
  for (const list of [ENCOUNTER_PHASES, ENTITY_KINDS, SIDES, CONTROLLER_TYPES, ABILITIES, RNG_ALGOS, TURN_FLAG_KEYS]) {
    assert.ok(Object.isFrozen(list));
  }
  assert.deepEqual([...ENCOUNTER_PHASES], ['setup', 'running', 'awaiting-prompt', 'ended']);
  assert.deepEqual([...CONTROLLER_TYPES], ['player', 'ai', 'dm']);
});

test('EncounterState: WRAPPER_FIELD_MAP enumerates every engine wrapper field (E1 §4)', () => {
  // Every underscore field the engine mutates today (E1 review §4). A new
  // wrapper field must be added here — mapped or explicitly transient —
  // or it silently disappears across a snapshot.
  const engineFields = [
    'hp', 'damageDealt', 'conditions', 'position', '_position', '_lastPlan', '_chosenWeapon', 'weapon',
    '_reactionUsed', '_lvl1Slots', '_shieldActive', '_lvl3Slots', '_slots', '_innate', '_concentrating',
    '_surgeFiredThisTurn', '_actionSurgeUsed', '_extraActionThisTurn', '_secondWindUsed',
    '_sneakAttackUsedThisTurn', '_cunningActionUsedThisTurn', '_recklessUsedThisTurn',
    '_recklessUntilNextTurn', '_smiteSlotUsed', '_mctsTargetCtx', '_legendaryBudget', '_aiProfile'
  ];
  for (const f of engineFields) {
    assert.ok(Object.prototype.hasOwnProperty.call(WRAPPER_FIELD_MAP, f), `${f} is not mapped`);
  }
  assert.ok(Object.isFrozen(WRAPPER_FIELD_MAP));
  assert.equal(WRAPPER_FIELD_MAP._mctsTargetCtx, null, 'holds an entity reference — transient');
  for (const [k, v] of Object.entries(WRAPPER_FIELD_MAP)) {
    assert.ok(v === null || typeof v === 'string', `${k} maps to a path or null`);
    if (v && v.startsWith('turnFlags.')) assert.ok(TURN_FLAG_KEYS.includes(v.slice(10)), `${v} is a known turn flag`);
  }
});

// ---------- check.js primitives (shared by all three contracts) ----------

test('check.js: spec builders validate primitives with named codes', () => {
  assert.equal(validateSpec('x', str()).ok, true);
  assert.equal(validateSpec('', str()).errors[0].code, 'range');
  assert.equal(validateSpec('', str({ allowEmpty: true })).ok, true);
  assert.equal(validateSpec('abcd', str({ maxLength: 3 })).errors[0].code, 'range');
  assert.equal(validateSpec(3, int(0, 5)).ok, true);
  assert.equal(validateSpec(6, int(0, 5)).errors[0].code, 'range');
  assert.equal(validateSpec(1.5, int()).errors[0].code, 'type');
  assert.equal(validateSpec(0, num(0, 1, { exclusiveMin: true })).errors[0].code, 'range');
  assert.equal(validateSpec(true, bool()).ok, true);
  assert.equal(validateSpec('c', oneOf(['a', 'b'])).errors[0].code, 'enum');
  assert.equal(validateSpec([1, 1], arrayOf(int(), { unique: true })).errors[0].code, 'duplicate');
  assert.equal(validateSpec([], arrayOf(int(), { min: 1 })).errors[0].code, 'range');
  assert.equal(validateSpec({ a: 1, b: 2 }, shape({ a: int() })).errors[0].code, 'unknown_field');
  assert.equal(validateSpec({ a: 1, b: 2 }, shape({ a: int() }, { strict: false })).ok, true);
  assert.equal(validateSpec({ x: 1 }, mapOf(int(), { keyPattern: /^[a-z]$/ })).ok, true);
  assert.equal(validateSpec({ 1: 1 }, mapOf(int(), { keyPattern: /^[a-z]$/ })).errors[0].code, 'range');
  assert.equal(validateSpec(5, union(str(), int())).ok, true);
  assert.equal(validateSpec(true, union(str(), int())).errors[0].code, 'type');
  assert.equal(validateSpec(undefined, optional(int())).ok, true);
  assert.equal(validateSpec(undefined, int()).errors[0].code, 'required');
  assert.equal(validateSpec(null, nullable(int())).ok, true);
  assert.equal(validateSpec(null, int()).errors[0].code, 'type');
  assert.equal(validateSpec({ deep: [1] }, anyJson()).ok, true);
});

test('check.js: JSON-safety catches everything that would not round-trip', () => {
  assert.equal(validateJsonSafe({ a: [1, 'x', null, true, { b: 2 }] }).ok, true);
  const cyc = {}; cyc.me = cyc;
  for (const bad of [{ u: undefined }, { f() {} }, { n: Infinity }, { d: new Date(0) }, { m: new Map() }, cyc, [1, , 3], { b: 1n }]) { // eslint-disable-line no-sparse-arrays
    const r = validateJsonSafe(bad);
    assert.equal(r.ok, false, `${JSON.stringify(Object.keys(bad))} should fail`);
    assert.equal(r.errors[0].code, 'not_json_safe');
  }
  // Shared (non-cyclic) references are fine: JSON copies them.
  const shared = { x: 1 };
  assert.equal(validateJsonSafe({ a: shared, b: shared }).ok, true);
});

test('check.js: helpers — collector, joinPath, isPlainObject, checkSpec/checkJsonSafe', () => {
  const c = createCollector();
  checkSpec(c, 'x', int(), 'a.b');
  checkJsonSafe(c, { f: () => 0 }, 'root');
  assert.deepEqual(c.errors.map(e => [e.path, e.code]), [['a.b', 'type'], ['root.f', 'not_json_safe']]);
  assert.equal(c.result().ok, false);
  assert.equal(joinPath('', 'a'), 'a');
  assert.equal(joinPath('a', 'b'), 'a.b');
  assert.equal(joinPath('a', 3), 'a[3]');
  assert.equal(isPlainObject({}), true);
  assert.equal(isPlainObject(Object.create(null)), true);
  assert.equal(isPlainObject([]), false);
  assert.equal(isPlainObject(new Date()), false);
  assert.ok(Object.isFrozen(VALIDATION_CODES));
});

// ---------- portability: Vite AND Node must import src/js/shared ----------

test('shared contracts are portable: no DOM, Node built-ins, import.meta, or outside imports', () => {
  const dir = fileURLToPath(new URL('../js/shared/', import.meta.url));
  const files = readdirSync(dir).filter(f => f.endsWith('.js'));
  assert.ok(files.includes('check.js') && files.includes('encounter-state.js'));
  const forbidden = [
    [/import\.meta/, 'import.meta'],
    [/\bfrom\s+['"]node:/, 'node: import'],
    [/\brequire\s*\(/, 'require()'],
    [/\b(window|document|localStorage|process|Buffer|globalThis)\b/, 'host global'],
    [/\b(Date\.now|Math\.random|performance\.now)\b/, 'non-deterministic API']
  ];
  for (const f of files) {
    const src = readFileSync(dir + f, 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    for (const [re, label] of forbidden) assert.ok(!re.test(code), `${f} uses ${label}`);
    for (const m of code.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)) {
      assert.match(m[1], /^\.\/[a-z-]+\.js$/, `${f} imports "${m[1]}" — shared/ may import only its siblings`);
    }
  }
});
