/**
 * M64 phase 1.5 — cover in the resolver and the spell paths
 * (grid-legality.coverBetween): half +2 AC / DEX saves, three-quarters
 * +5, total = no line. Terrain-free results are byte-identical.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveAttack, COVER_AC_BONUS } from '../js/scene/combat-resolver.js';
import { runOneAttack, coverBetweenWrappers, coverSaveBonus } from '../js/scene/combat-engine.js';
import { createTerrain, setFlag, TERRAIN_FLAGS as F } from '../js/map/terrain.js';
import { createRng } from '../js/scene/rng.js';
import { buildPc, buildMonster, buildScene } from './helpers/entities.js';

function paint(t, cells, flag) {
  let out = t;
  for (const [c, r] of cells) out = setFlag(out, c, r, flag);
  return out;
}

const BOW = { name: 'Longbow', damage: '1d8', damageType: 'Piercing', attackType: 2, range: 150, longRange: 600, properties: ['ammunition', 'two-handed'] };

function verdictWith(scene, coverEntities = []) {
  return resolveAttack({
    attacker: { name: 'A', _position: { col: 0, row: 2 }, conditions: [] },
    target: { name: 'T', _position: { col: 4, row: 2 }, conditions: [] },
    weapon: BOW, scene, attackerKind: 'pc', targetKind: 'monster', targetAC: 13,
    attackStats: { bonus: 5, dice: '1d8+3', damageType: 'Piercing', parts: [{ source: 'Longbow', value: 5 }], damageParts: [] },
    coverEntities
  });
}

test('cover: half +2 AC, three-quarters +5, total refuses the attack', () => {
  assert.deepEqual(COVER_AC_BONUS, { none: 0, half: 2, threeQuarters: 5, total: 0 });
  const half = paint(createTerrain(6, 5), [[2, 2]], F.HALF_COVER);
  const v1 = verdictWith({ cols: 6, rows: 5, terrain: half });
  assert.equal(v1.cover, 'half');
  assert.equal(v1.targetAC, 15);
  const three = paint(createTerrain(6, 5), [[2, 1], [2, 2], [2, 3]], F.THREE_QUARTERS_COVER);
  const v2 = verdictWith({ cols: 6, rows: 5, terrain: three });
  assert.equal(v2.cover, 'threeQuarters');
  assert.equal(v2.targetAC, 18);
  const wall = paint(createTerrain(6, 5), [[2, 0], [2, 1], [2, 2], [2, 3], [2, 4]], F.TOTAL_COVER);
  const v3 = verdictWith({ cols: 6, rows: 5, terrain: wall });
  assert.equal(v3.cover, 'total');
  assert.equal(v3.autoMiss, true);
  assert.match(v3.blockers.join(';'), /total cover/);
  // A creature in the way gives half cover.
  const open = createTerrain(6, 5);
  const v4 = verdictWith({ cols: 6, rows: 5, terrain: open }, [buildMonster({ id: 'x', position: { col: 2, row: 2 } })]);
  assert.equal(v4.cover, 'half');
});

test('cover: terrain-free verdicts are unchanged (no cover key effect, AC as given)', () => {
  const v = verdictWith({ cols: 6, rows: 5 });
  assert.equal(v.cover, 'none');
  assert.equal(v.targetAC, 13);
  assert.equal(verdictWith({ cols: 6, rows: 5, terrain: null }).targetAC, 13);
});

test('cover: the engine rolls against the covered AC, and a fully covered target is refused', async () => {
  const half = paint(createTerrain(10, 7), [[3, 1]], F.HALF_COVER);
  const archer = buildPc({
    id: 'a', _position: { col: 1, row: 1 }, weapon: BOW, _chosenWeapon: BOW,
    ref: { name: 'A', classes: [{ name: 'Fighter', level: 1 }], equipment: { mainhand: BOW }, abilityModifiers: { STR: 0, DEX: 3, CON: 0, INT: 0, WIS: 0, CHA: 0 } }
  });
  const m = buildMonster({ id: 'm', hp: 99, hpMax: 99, ac: 12, position: { col: 6, row: 1 } });
  const ev = [];
  await runOneAttack(archer, [m], [archer], buildScene({ terrain: half }), createRng({ s: 3 }), {
    forcePlan: { kind: 'ranged', targetId: 'm', weapon: BOW, featuresFired: [] }
  }, { emit: (e) => ev.push(e), turnId: 't' });
  assert.equal(ev.find(e => e.type === 'attack.rolled').payload.ac, 14);
  const wall = paint(createTerrain(10, 7), [0, 1, 2, 3, 4, 5, 6].map(r => [3, r]), F.TOTAL_COVER);
  const ev2 = [];
  await runOneAttack(archer, [m], [archer], buildScene({ terrain: wall }), createRng({ s: 3 }), {
    forcePlan: { kind: 'ranged', targetId: 'm', weapon: BOW, featuresFired: [] }
  }, { emit: (e) => ev2.push(e), turnId: 't' });
  assert.ok(ev2.some(e => e.type === 'turn.rejected' && e.payload.code === 'blocked'));
  assert.ok(!ev2.some(e => e.type === 'attack.rolled'));
});

test('cover: +2 / +5 to DEX saves only; total cover refuses a single-target spell before a slot is spent', async () => {
  assert.equal(coverSaveBonus('half', 'DEX'), 2);
  assert.equal(coverSaveBonus('threeQuarters', 'DEX'), 5);
  assert.equal(coverSaveBonus('half', 'WIS'), 0);
  const cleric = buildPc({
    id: 'c', _position: { col: 1, row: 1 }, _slots: { 1: 2, 2: 2 },
    ref: { name: 'C', classes: [{ name: 'Cleric', level: 5 }], spells: ['Sacred Flame', 'Hold Person'], equipment: {}, abilityModifiers: { STR: 0, DEX: 0, CON: 0, INT: 0, WIS: 4, CHA: 0 } }
  });
  const gob = buildMonster({ id: 'g', hp: 50, hpMax: 50, position: { col: 6, row: 1 } });
  const half = paint(createTerrain(10, 7), [[3, 1]], F.HALF_COVER);
  const scene = buildScene({ terrain: half });
  assert.equal(coverBetweenWrappers(scene, [cleric, gob], cleric, gob), 'half');
  const run = async (sc, spellId) => {
    const ev = [];
    await runOneAttack(cleric, [gob], [cleric], sc, () => 0.5, {
      // moveTo its own cell: the caster stays behind the wall's line.
      forcePlan: { kind: 'cast', spellId, targetId: 'g', targetSide: 'enemy', castAtLevel: spellId === 'hold-person' ? 2 : 0, moveTo: { col: 1, row: 1 } }
    }, { emit: (e) => ev.push(e), turnId: 't' });
    return ev;
  };
  const covered = (await run(scene, 'sacred-flame')).find(e => e.type === 'save.rolled');
  const bare = (await run(buildScene(), 'sacred-flame')).find(e => e.type === 'save.rolled');
  assert.equal(covered.payload.total, bare.payload.total + 2, 'DEX save +2 behind half cover');
  const wall = paint(createTerrain(10, 7), [0, 1, 2, 3, 4, 5, 6].map(r => [3, r]), F.TOTAL_COVER);
  const before = { ...cleric._slots };
  const ev = await run(buildScene({ terrain: wall }), 'hold-person');
  assert.ok(ev.some(e => e.type === 'turn.rejected' && e.payload.code === 'no-line'));
  assert.ok(!ev.some(e => e.type === 'spell.cast'));
  assert.deepEqual(cleric._slots, before, 'no slot spent');
});
