// M64 E5 / M2 — terrain layer: base64 round trip, flags, resize, backfill,
// and conformance with the shared EncounterState contract.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { bytesToBase64, base64ToBytes } from '../js/map/base64.js';
import {
  TERRAIN_FLAGS, TERRAIN_VERSION, createTerrain, encodeTerrain, decodeTerrain, asTerrain,
  flagAt, hasFlag, setFlag, clearFlag, applyTerrainPaint, resizeTerrain, mergeWithDefault,
  isTerrainEmpty, inBounds
} from '../js/map/terrain.js';
import { validateEncounterState } from '../js/shared/encounter-state.js';

const FIXTURE = JSON.parse(readFileSync(new URL('./fixtures/contracts/encounter-state.valid.json', import.meta.url), 'utf8'));

test('base64: matches the standard alphabet with padding for every tail length', () => {
  const cases = [[], [0], [0, 1], [0, 1, 2], [255, 254, 253, 252], [77, 97, 110]];
  for (const bytes of cases) {
    const enc = bytesToBase64(Uint8Array.from(bytes));
    const expected = globalThis.Buffer ? Buffer.from(bytes).toString('base64') : enc;
    assert.equal(enc, expected, `encode ${bytes}`);
    assert.deepEqual([...base64ToBytes(enc)], bytes, `decode ${enc}`);
  }
});

test('base64: random 0..600-byte arrays round-trip', () => {
  let s = 12345;
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s; };
  for (let n = 0; n < 600; n += 37) {
    const bytes = new Uint8Array(n);
    for (let i = 0; i < n; i++) bytes[i] = rnd() & 0xFF;
    assert.deepEqual(base64ToBytes(bytesToBase64(bytes)), bytes);
  }
});

test('terrain: createTerrain is all open with the right size', () => {
  const t = createTerrain(30, 20);
  assert.equal(t.v, TERRAIN_VERSION);
  assert.equal(t.cells.length, 600);
  assert.ok(isTerrainEmpty(t));
  assert.equal(flagAt(t, 5, 5), 0);
});

test('terrain: set/clear flags return new terrains and never mutate the input', () => {
  const t0 = createTerrain(4, 3);
  const t1 = setFlag(t0, 1, 2, TERRAIN_FLAGS.BLOCKED);
  const t2 = setFlag(t1, 1, 2, TERRAIN_FLAGS.TOTAL_COVER);
  assert.equal(flagAt(t0, 1, 2), 0, 'input untouched');
  assert.equal(flagAt(t1, 1, 2), 1);
  assert.equal(flagAt(t2, 1, 2), 17);
  assert.ok(hasFlag(t2, 1, 2, TERRAIN_FLAGS.TOTAL_COVER));
  const t3 = clearFlag(t2, 1, 2, TERRAIN_FLAGS.BLOCKED);
  assert.equal(flagAt(t3, 1, 2), 16);
  assert.equal(flagAt(setFlag(t0, 9, 9, 1), 9, 9), 0, 'out of bounds ignored');
  assert.equal(inBounds(t0, 3, 2), true);
  assert.equal(inBounds(t0, 4, 2), false);
});

test('terrain: applyTerrainPaint handles set/clear/replace batches', () => {
  const t = applyTerrainPaint(createTerrain(5, 5), {
    cells: [{ col: 0, row: 0 }, { col: 1, row: 0 }, { col: 2, row: 0 }], flag: 3, op: 'set'
  });
  assert.deepEqual([0, 1, 2].map(c => flagAt(t, c, 0)), [3, 3, 3]);
  const c = applyTerrainPaint(t, { cells: [{ col: 1, row: 0 }], flag: 1, op: 'clear' });
  assert.equal(flagAt(c, 1, 0), 2);
  const r = applyTerrainPaint(c, { cells: [{ col: 0, row: 0 }], flag: 0, op: 'replace' });
  assert.equal(flagAt(r, 0, 0), 0);
});

test('terrain: encode → decode round-trips and conforms to the shared contract', () => {
  let t = createTerrain(12, 8);
  t = applyTerrainPaint(t, { cells: [{ col: 0, row: 0 }, { col: 11, row: 7 }, { col: 5, row: 3 }], flag: 1 | 16 });
  t = setFlag(t, 6, 3, TERRAIN_FLAGS.DIFFICULT);
  t = setFlag(t, 7, 3, TERRAIN_FLAGS.HALF_COVER | TERRAIN_FLAGS.THREE_QUARTERS_COVER);
  const wire = encodeTerrain(t);
  assert.equal(typeof wire.flags, 'string');
  assert.deepEqual(Object.keys(wire).sort(), ['cols', 'flags', 'rows', 'v']);
  const back = decodeTerrain(wire);
  assert.deepEqual(back.cells, t.cells);
  assert.equal(back.cols, 12);
  assert.equal(back.rows, 8);
  // Survives JSON and validates inside an EncounterState.
  const state = JSON.parse(JSON.stringify(FIXTURE));
  state.grid.terrain = JSON.parse(JSON.stringify(wire));
  assert.deepEqual(validateEncounterState(state).errors, []);
  assert.deepEqual(decodeTerrain(state.grid.terrain).cells, t.cells);
});

test('terrain: decode pads short flags, truncates long ones, masks unknown bits', () => {
  const short = decodeTerrain({ v: 1, cols: 12, rows: 8, flags: 'AAAAAAAA' });   // the contract fixture
  assert.equal(short.cells.length, 96);
  assert.ok(isTerrainEmpty(short));
  const long = decodeTerrain({ v: 1, cols: 1, rows: 1, flags: bytesToBase64(Uint8Array.from([0xFF, 1, 2])) });
  assert.deepEqual([...long.cells], [31]);
});

test('terrain: asTerrain accepts wire or working form and memoises frozen wire objects', () => {
  const wire = Object.freeze(encodeTerrain(setFlag(createTerrain(3, 3), 2, 2, 2)));
  const a = asTerrain(wire);
  assert.equal(a, asTerrain(wire), 'memoised by identity');
  assert.equal(flagAt(wire, 2, 2), 2, 'flagAt reads the wire form directly');
  assert.equal(asTerrain(null), null);
  assert.equal(flagAt(null, 0, 0), 0);
});

test('terrain: resize preserves the overlapping region (grow and shrink)', () => {
  let t = createTerrain(4, 4);
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) t = setFlag(t, c, r, ((r * 4 + c) % 5) + 1);
  const big = resizeTerrain(t, 6, 5);
  const small = resizeTerrain(t, 2, 3);
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) assert.equal(flagAt(big, c, r), flagAt(t, c, r));
  assert.equal(flagAt(big, 5, 4), 0);
  assert.equal(flagAt(big, 4, 0), 0);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 2; c++) assert.equal(flagAt(small, c, r), flagAt(t, c, r));
  assert.equal(small.cells.length, 6);
});

test('terrain: mergeWithDefault backfills absent terrain as all open and fixes size drift', () => {
  const none = mergeWithDefault(undefined, 10, 7);
  assert.equal(none.cells.length, 70);
  assert.ok(isTerrainEmpty(none));
  const t = setFlag(createTerrain(3, 3), 1, 1, 1);
  assert.equal(mergeWithDefault(t, 3, 3), t, 'matching size is returned as-is');
  const grown = mergeWithDefault(encodeTerrain(t), 5, 5);
  assert.equal(grown.cols, 5);
  assert.equal(flagAt(grown, 1, 1), 1);
});
