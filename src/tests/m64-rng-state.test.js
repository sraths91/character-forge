// M64 T3 — serializable RNG: createRng({ s }) / rng.state().

import { test } from 'node:test';
import assert from 'node:assert';
import { createRng, mulberry32Output, RNG_ALGO } from '../js/scene/rng.js';
import { seedRng } from '../js/scene/simulator.js';
import { runOneAttack, sideAlive, isAlive, isIncapacitated } from '../js/scene/combat-engine.js';
import { deriveAC } from '../js/scene/pc-stats.js';
import { MONSTER_PRESETS } from '../js/scene/monster-presets.js';
import { resetReactionsForAll, lvl1SlotsForPc, lvl3SlotsForPc, slotsForPc } from '../js/scene/reactions.js';
import { freshSlots, isSpellcaster, isInnateCaster, freshInnateState } from '../js/scene/monster-spells.js';

const take = (rng, n) => Array.from({ length: n }, () => rng());

test('M64 T3: createRng — same state gives the same stream', () => {
  assert.deepStrictEqual(take(createRng({ s: 99 }), 10), take(createRng({ s: 99 }), 10));
});

test('M64 T3: createRng — values are in [0, 1)', () => {
  for (const v of take(createRng({ s: 7 }), 500)) assert.ok(v >= 0 && v < 1, String(v));
});

test('M64 T3: createRng — state() is plain JSON { algo, s }', () => {
  const rng = createRng({ s: 5 });
  rng(); rng();
  const st = rng.state();
  assert.deepStrictEqual(Object.keys(st).sort(), ['algo', 's']);
  assert.strictEqual(st.algo, RNG_ALGO);
  assert.ok(Number.isInteger(st.s) && st.s >= 0 && st.s < 2 ** 32);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(st)), st);
});

test('M64 T3: createRng — resuming from a JSON round-tripped state continues the stream exactly', () => {
  const whole = take(createRng({ s: 1234 }), 40);
  const first = createRng({ s: 1234 });
  const head = take(first, 17);
  const resumed = createRng(JSON.parse(JSON.stringify(first.state())));
  assert.deepStrictEqual([...head, ...take(resumed, 23)], whole);
});

test('M64 T3: createRng — rejects missing state, non-integer s and unknown algo', () => {
  assert.throws(() => createRng(), /state object/);
  assert.throws(() => createRng({}), /state\.s must be an integer/);
  assert.throws(() => createRng({ s: 1.5 }), /state\.s must be an integer/);
  assert.throws(() => createRng({ algo: 'xorshift', s: 1 }), /unsupported algo/);
});

test('M64 T3: seedRng is a thin createRng wrapper — stream unchanged from the pre-T3 closure', () => {
  // Golden values from the original inline mulberry32 in simulator.js.
  assert.deepStrictEqual(take(seedRng(42), 5), [
    0.6011037519201636, 0.44829055899754167, 0.8524657934904099,
    0.6697340414393693, 0.17481389874592423
  ]);
  assert.deepStrictEqual(take(seedRng(42), 50), take(createRng({ s: 42 }), 50));
  assert.strictEqual(typeof seedRng(1).state, 'function');
});

test('M64 T3: mulberry32Output — pure function of the stepped state', () => {
  const s1 = (42 + 0x6D2B79F5) >>> 0;
  assert.strictEqual(mulberry32Output(s1), seedRng(42)());
});

// ---------- Mid-encounter snapshot / resume ----------

function pcChar(id, col, cls, level, spells) {
  return {
    id, name: id, _position: { col, row: 1 }, hp: { current: 60, max: 60 },
    equipment: { mainhand: { name: 'Longsword', damage: '1d8', damageType: 'Slashing' } },
    abilityScores: { STR: 16, DEX: 12, CON: 14, INT: 16, WIS: 14, CHA: 14 },
    abilityModifiers: { STR: 3, DEX: 1, CON: 2, INT: 3, WIS: 2, CHA: 2 },
    classes: [{ name: cls, level }], conditions: [], spells
  };
}

/** Build engine wrappers the same way simulator.js does. */
function buildSides() {
  const party = [
    pcChar('fighter', 1, 'Fighter', 5, []),
    pcChar('wizard', 2, 'Wizard', 5, ['Shield', 'Magic Missile', 'Fire Bolt']),
    pcChar('cleric', 3, 'Cleric', 5, ['Cure Wounds', 'Sacred Flame']),
    pcChar('paladin', 4, 'Paladin', 5, [])
  ];
  const monsters = [
    { id: 'fan', presetSlug: 'cult-fanatic', col: 1 }, { id: 'kob', presetSlug: 'kobold-sorcerer', col: 3 },
    { id: 'gob', presetSlug: 'goblin', col: 5 }, { id: 'vmp', presetSlug: 'vampire-spawn', col: 6 }
  ].map(m => ({ ...m, name: m.id, hp: { current: 70, max: 70 }, conditions: [], position: { col: m.col, row: 5 } }));
  const pcs = party.map(p => ({
    ref: p, id: p.id, name: p.name, kind: 'pc', hp: p.hp.current, hpMax: p.hp.max, ac: deriveAC(p),
    weapon: p.equipment.mainhand, _chosenWeapon: p.equipment.mainhand, conditions: [],
    _position: p._position, damageDealt: 0, combatMods: [], _reactionUsed: false,
    _lvl1Slots: lvl1SlotsForPc(p), _lvl3Slots: lvl3SlotsForPc(p), _slots: slotsForPc(p),
    _shieldActive: false, _actionSurgeUsed: 0, _secondWindUsed: false,
    _sneakAttackUsedThisTurn: false, _cunningActionUsedThisTurn: false
  }));
  const mons = monsters.map(m => {
    const preset = MONSTER_PRESETS[m.presetSlug] || {};
    return {
      ref: m, id: m.id, name: m.name, kind: 'monster', presetSlug: m.presetSlug,
      hp: m.hp.current, hpMax: m.hp.max, ac: preset.ac ?? 12,
      attack: preset.attack || { name: 'Strike', bonus: 2, dice: '1d6' },
      conditions: [], position: m.position, damageDealt: 0, _reactionUsed: false,
      _slots: isSpellcaster(m.presetSlug) ? freshSlots(m.presetSlug) : null,
      _innate: isInnateCaster(m.presetSlug) ? freshInnateState(m.presetSlug) : null,
      _concentrating: null
    };
  });
  return { pcs, mons };
}

/** Run rounds [from, to] and append every rolled value + per-turn state to `log`. */
async function runRounds(state, rng, from, to, log) {
  const { pcs, mons } = state;
  const logged = () => { const v = rng(); log.push(['roll', v]); return v; };
  for (let round = from; round <= to; round++) {
    if (!sideAlive(pcs) || !sideAlive(mons)) break;
    resetReactionsForAll(pcs);
    resetReactionsForAll(mons);
    for (const [actors, foes] of [[pcs, mons], [mons, pcs]]) {
      for (const a of actors) {
        if (!isAlive(a) || isIncapacitated(a)) continue;
        await runOneAttack(a, foes, actors, { cols: 10, rows: 8 }, logged, {});
        log.push(['turn', round, a.id,
          [...pcs, ...mons].map(e => [e.id, e.hp, (e._position || e.position)?.col, (e._position || e.position)?.row, e.conditions.join('|')])]);
      }
    }
  }
}

// `_mctsTargetCtx` is a transient planner scratch field that holds a live
// entity reference (see the M64 review); it is re-stamped every turn and
// is not part of the persistent encounter state.
const snapshotReplacer = (key, value) => (key === '_mctsTargetCtx' ? undefined : value);

test('M64 T3: snapshot mid-encounter → JSON round-trip → resume is identical to an uninterrupted run', async () => {
  for (const seed of [1, 2, 3]) {
    const uninterrupted = [];
    await runRounds(buildSides(), createRng({ s: seed }), 1, 8, uninterrupted);

    const resumed = [];
    const live = buildSides();
    const rngA = createRng({ s: seed });
    await runRounds(live, rngA, 1, 3, resumed);
    const wire = JSON.stringify({ rng: rngA.state(), pcs: live.pcs, mons: live.mons }, snapshotReplacer);
    const restored = JSON.parse(wire);
    await runRounds({ pcs: restored.pcs, mons: restored.mons }, createRng(restored.rng), 4, 8, resumed);

    assert.ok(uninterrupted.filter(e => e[0] === 'turn').length > 12, `seed ${seed}: fight too short to test a mid-fight snapshot`);
    assert.strictEqual(JSON.stringify(resumed), JSON.stringify(uninterrupted), `seed ${seed}: resumed run diverged`);
  }
});
