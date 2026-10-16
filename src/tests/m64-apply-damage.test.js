/**
 * M64 R8 — one applyDamage / applyHealing for every HP change:
 * R/I/V → temp HP → HP → concentration (seeded) → downed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  applyDamage, applyHealing, applyDamageModifiers, damageTypeList, setHpRaw,
  concentrationCheck, runOneAttack, isAlive
} from '../js/scene/combat-engine.js';
import { createRng } from '../js/scene/rng.js';
import { buildPc, buildMonster, buildScene, parsedDdbFixture, pcFromSheet } from './helpers/entities.js';

function sink() {
  const events = [];
  return { events, ctx: { emit: (e) => events.push(e) } };
}
const types = (events) => events.map(e => e.type);

test('R8: 10 fire against fire resistance with 5 temp HP loses 0 HP', () => {
  const t = buildMonster({ hp: 20, hpMax: 20, hpTemp: 5, resistances: ['fire'] });
  const { events, ctx } = sink();
  const r = applyDamage(t, 10, 'Fire', { ctx, rng: createRng({ s: 1 }) });
  assert.equal(t.hp, 20);
  assert.equal(t.hpTemp, 0);
  assert.deepEqual({ amount: r.amount, absorbed: r.absorbed, hpLost: r.hpLost, modifier: r.modifier }, { amount: 5, absorbed: 5, hpLost: 0, modifier: 'resistant' });
  const dmg = events.find(e => e.type === 'damage').payload;
  assert.equal(dmg.amount, 0);
  assert.equal(dmg.rolled, 10);
  assert.equal(dmg.absorbed, 5);
  assert.equal(dmg.modifier, 'resistant');
});

test('R8: immunity zeroes, vulnerability doubles, resistance halves (round down)', () => {
  assert.deepEqual(applyDamageModifiers({ immunities: ['poison'] }, 9, 'Poison'), { amount: 0, modifier: 'immune' });
  assert.deepEqual(applyDamageModifiers({ vulnerabilities: ['radiant'] }, 7, 'Radiant'), { amount: 14, modifier: 'vulnerable' });
  assert.deepEqual(applyDamageModifiers({ resistances: ['slashing'] }, 7, 'Slashing'), { amount: 3, modifier: 'resistant' });
  assert.deepEqual(applyDamageModifiers({ resistances: ['fire'], vulnerabilities: ['fire'] }, 7, 'fire'), { amount: 6, modifier: 'resistant+vulnerable' });
  assert.deepEqual(applyDamageModifiers({ resistances: ['fire'] }, 7, null), { amount: 7, modifier: null }, 'untyped damage ignores R/I/V');
  assert.deepEqual(applyDamageModifiers({}, 7, 'Fire'), { amount: 7, modifier: null });
});

test('R8: R/I/V read from the sheet as strings or DDB modifier objects', () => {
  const pc = buildPc({ ref: { ...buildPc().ref, resistances: [{ subType: 'fire' }, { friendlySubtypeName: 'Cold Damage' }] } });
  assert.deepEqual(damageTypeList(pc, 'resistances'), ['fire', 'cold']);
  const before = pc.hp;
  applyDamage(pc, 8, 'Cold', {});
  assert.equal(pc.hp, before - 4);
});

test('R8: temp HP absorb first and the rest comes off HP', () => {
  const t = buildPc({ hp: 30, hpTemp: 4 });
  const r = applyDamage(t, 10, 'Slashing', {});
  assert.equal(t.hpTemp, 0);
  assert.equal(t.hp, 24);
  assert.equal(r.absorbed, 4);
  assert.equal(r.hpLost, 6);
});

test('R8: the source is credited with the post-R/I/V damage', () => {
  const a = buildPc({ damageDealt: 0 });
  const t = buildMonster({ hp: 50, hpMax: 50, resistances: ['slashing'] });
  applyDamage(t, 9, 'Slashing', { attacker: a });
  assert.equal(a.damageDealt, 4);
  applyDamage(t, 9, 'Slashing', { attacker: a, credit: false });
  assert.equal(a.damageDealt, 4);
});

test('R8: damage absorbed by temp HP still forces a concentration save (seeded)', () => {
  const t = buildMonster({ hp: 20, hpMax: 20, hpTemp: 10, _concentrating: { spellId: 'hold-person', targetIds: [] } });
  const { events, ctx } = sink();
  applyDamage(t, 6, null, { ctx, rng: createRng({ s: 3 }) });
  assert.equal(t.hp, 20);
  const save = events.find(e => e.type === 'save.rolled');
  assert.ok(save, 'save rolled');
  assert.equal(save.payload.reason, 'concentration');
  assert.equal(save.payload.dc, 10);
});

test('R8: dropping to 0 HP ends concentration without a save, then emits entity.downed; the creature stays', () => {
  const caster = buildMonster({ id: 'c', hp: 5, hpMax: 20, _concentrating: { spellId: 'hold-person', targetIds: [] } });
  const src = buildPc({ id: 'p' });
  const { events, ctx } = sink();
  const r = applyDamage(caster, 12, 'Slashing', { attacker: src, ctx, rng: createRng({ s: 3 }) });
  assert.equal(r.downed, true);
  assert.equal(caster.hp, 0);
  assert.equal(caster._concentrating, null);
  assert.deepEqual(types(events), ['damage', 'concentration.broken', 'entity.downed']);
  assert.equal(events[1].payload.reason, 'downed');
  assert.equal(events[2].payload.byId, 'p');
  assert.equal(isAlive(caster), false, 'isAlive semantics unchanged until death saves');
});

test('R8: concentrationCheck is a no-op without concentration or damage', () => {
  assert.deepEqual(concentrationCheck(buildPc(), 10, createRng({ s: 1 })), { broke: false, save: null });
  assert.deepEqual(concentrationCheck(buildPc({ _concentrating: { spellId: 'bless', targetIds: [] } }), 0, createRng({ s: 1 })), { broke: false, save: null });
});

test('R8: a weapon hit on a concentrating creature forces the CON save (was skipped, B9)', async () => {
  const pc = buildPc({ id: 'pc', _position: { col: 1, row: 1 } });
  const m = buildMonster({ id: 'm', hp: 60, hpMax: 60, ac: 1, position: { col: 2, row: 1 }, _concentrating: { spellId: 'hold-person', targetIds: [] } });
  const { events, ctx } = sink();
  await runOneAttack(pc, [m], [pc], buildScene(), createRng({ s: 5 }), {
    forcePlan: { kind: 'melee', targetId: 'm', targetSide: 'enemy', weapon: { name: 'Longsword' }, featuresFired: [] }
  }, ctx);
  assert.ok(m.hp < 60, 'hit');
  const save = events.find(e => e.type === 'save.rolled');
  assert.ok(save && save.payload.reason === 'concentration');
});

test('R8: a smite hit forces ONE concentration save on weapon + smite damage', async () => {
  const pal = buildPc({
    id: 'pal', _position: { col: 1, row: 1 },
    ref: { ...buildPc().ref, classes: [{ name: 'Paladin', level: 5 }] },
    _slots: { 1: 4, 2: 2 }
  });
  const m = buildMonster({ id: 'm', hp: 200, hpMax: 200, ac: 1, position: { col: 2, row: 1 }, _concentrating: { spellId: 'hold-person', targetIds: [] } });
  const { events, ctx } = sink();
  await runOneAttack(pal, [m], [pal], buildScene(), createRng({ s: 9 }), {
    forcePlan: { kind: 'melee', targetId: 'm', targetSide: 'enemy', weapon: { name: 'Longsword' }, featuresFired: ['divine-smite'] }
  }, ctx);
  const dmg = events.filter(e => e.type === 'damage');
  assert.equal(dmg.length, 2, 'weapon + smite damage events');
  const saves = events.filter(e => e.type === 'save.rolled' && e.payload.reason === 'concentration');
  assert.equal(saves.length, 1);
  const taken = dmg[0].payload.rolled + dmg[1].payload.rolled;
  assert.equal(saves[0].payload.dc, Math.max(10, Math.floor(taken / 2)));
});

test('R8: applyHealing lifts a downed creature, clamps to hpMax and emits heal', () => {
  const t = buildPc({ hp: 0, hpMax: 30 });
  const { events, ctx } = sink();
  const r = applyHealing(t, 7, { ctx, source: buildPc({ id: 'cleric' }) });
  assert.equal(t.hp, 7);
  assert.equal(r.amount, 7);
  assert.equal(isAlive(t), true);
  applyHealing(t, 100, { ctx });
  assert.equal(t.hp, 30);
  assert.deepEqual(events.map(e => [e.type, e.payload.amount]), [['heal', 7], ['heal', 23]]);
});

test('R8: setHpRaw (DM edits) goes through the two functions and emits nothing', () => {
  const t = buildPc({ hp: 20, hpMax: 30, hpTemp: 5, resistances: ['bludgeoning'] });
  assert.equal(setHpRaw(t, 3), 3);
  assert.equal(t.hpTemp, 5, 'raw skips temp HP');
  assert.equal(setHpRaw(t, 99), 30);
  assert.equal(setHpRaw(t, -4), 0);
});

test('R8: a support caster picks a downed ally back up with Healing Word', async () => {
  const cleric = pcFromSheet(parsedDdbFixture('cleric-l5'), { id: 'cleric', _position: { col: 1, row: 1 } });
  const ally = buildPc({ id: 'ally', hp: 0, hpMax: 30, _position: { col: 4, row: 1 } });
  const goblin = buildMonster({ id: 'gob', position: { col: 18, row: 5 } });
  const { events, ctx } = sink();
  await runOneAttack(cleric, [goblin], [cleric, ally], buildScene({ cols: 20, rows: 7 }), createRng({ s: 7 }), {}, ctx);
  const chosen = events.find(e => e.type === 'plan.chosen').payload;
  assert.equal(chosen.targetId, 'ally');
  assert.equal(chosen.spellId, 'healing-word');
  assert.ok(ally.hp > 0, `back up at ${ally.hp}`);
});

// ---------------------------------------------------------------------
// grep acceptance: no direct HP writes outside applyDamage / applyHealing
// ---------------------------------------------------------------------

const SCENE_DIR = fileURLToPath(new URL('../js/scene/', import.meta.url));
const HP_WRITE = /(\.hp\s*=(?!=)|\bhp\s*[-+]=)/;
/**
 * Projections that COPY an already-applied HP between representations
 * (they never change a creature's HP): EncounterState ← wrapper, and the
 * live browser record ← EncounterState.
 */
const PROJECTIONS = [
  ['encounter-adapters.js', 'e.hp = Math.max(0, Math.min(e.hpMax, Math.trunc(w.hp)))'],
  ['live-bridge.js', 'live.hp = { ...live.hp, current: entity.hp']
];

function jsFiles(dir) {
  return readdirSync(dir).flatMap(f => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? jsFiles(p) : (f.endsWith('.js') ? [p] : []);
  });
}

function functionBody(src, name) {
  const start = src.indexOf(`export function ${name}(`);
  assert.ok(start >= 0, `${name} exists`);
  const end = src.indexOf('\n}\n', start);
  return [start, end];
}

test('R8: grep — no hp assignment in src/js/scene outside applyDamage / applyHealing', () => {
  const offenders = [];
  for (const file of jsFiles(SCENE_DIR)) {
    const src = readFileSync(file, 'utf8');
    const rel = file.slice(SCENE_DIR.length);
    const ranges = rel === 'combat-engine.js'
      ? [functionBody(src, 'applyDamage'), functionBody(src, 'applyHealing')]
      : [];
    let offset = 0;
    for (const line of src.split('\n')) {
      const at = offset;
      offset += line.length + 1;
      if (!HP_WRITE.test(line) || /^\s*(\/\/|\*)/.test(line)) continue;
      if (ranges.some(([a, b]) => at > a && at < b)) continue;
      if (PROJECTIONS.some(([f, text]) => rel === f && line.includes(text))) continue;
      offenders.push(`${rel}: ${line.trim()}`);
    }
  }
  assert.deepEqual(offenders, []);
});
