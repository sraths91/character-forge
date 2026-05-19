import { test } from 'node:test';
import assert from 'node:assert';
import {
  createCinemaState, findHitPauseAt, applyVerdictToState, createCinema,
  phaseAt, defenderPhaseAt
} from '../js/anim/cinema.js';
import { buildMotion } from '../js/anim/weapon-motions.js';

// ---------- createCinemaState ----------

test('M43.2: createCinemaState — initializes HP from input', () => {
  const s = createCinemaState({
    attacker: { id: 'a', name: 'Hero', hpMax: 30 },
    defender: { id: 'd', name: 'Goblin', hpMax: 7 }
  });
  assert.strictEqual(s.attHp, 30);
  assert.strictEqual(s.attHpMax, 30);
  assert.strictEqual(s.defHp, 7);
  assert.strictEqual(s.defHpMax, 7);
  assert.strictEqual(s.attacker.name, 'Hero');
  assert.strictEqual(s.defender.name, 'Goblin');
  assert.strictEqual(s.pendingDmg, null);
  assert.deepStrictEqual(s.popups, []);
});

test('M43.2: createCinemaState — tolerates {hp:{max}} shape too', () => {
  const s = createCinemaState({
    attacker: { hp: { max: 12 } },
    defender: { hp: { max: 9 } }
  });
  assert.strictEqual(s.attHpMax, 12);
  assert.strictEqual(s.defHpMax, 9);
});

test('M43.2: createCinemaState — empty input falls back to 1 HP', () => {
  const s = createCinemaState({});
  assert.strictEqual(s.attHpMax, 1);
  assert.strictEqual(s.defHpMax, 1);
});

// ---------- findHitPauseAt ----------

test('M43.2: findHitPauseAt — returns hit-pause effect time when present', () => {
  const seq = buildMotion('sword-slash');
  const t = findHitPauseAt(seq);
  assert.ok(t > 0 && t < seq.duration,
    `expected hit-pause in mid-sequence; got ${t} / ${seq.duration}`);
});

test('M43.2: findHitPauseAt — returns midpoint when no hit-pause effect', () => {
  const seq = { duration: 1000, effects: [] };
  assert.strictEqual(findHitPauseAt(seq), 500);
});

test('M43.2: findHitPauseAt — null seq returns 0', () => {
  assert.strictEqual(findHitPauseAt(null), 0);
  assert.strictEqual(findHitPauseAt(undefined), 0);
});

// ---------- applyVerdictToState ----------

test('M43.2: applyVerdictToState — applies dmg to defender at pauseAt', () => {
  const s = createCinemaState({
    attacker: { hpMax: 30 }, defender: { hpMax: 10 }
  });
  s.pendingDmg = { victim: 'defender', dmg: 6 };
  // Before pauseAt → no change
  let fired = applyVerdictToState(s, 100, 200);
  assert.strictEqual(fired, false);
  assert.strictEqual(s.defHp, 10);
  // At pauseAt → fires
  fired = applyVerdictToState(s, 200, 200);
  assert.strictEqual(fired, true);
  assert.strictEqual(s.defHp, 4);
  // Subsequent calls are idempotent (pendingDmg cleared)
  fired = applyVerdictToState(s, 250, 200);
  assert.strictEqual(fired, false);
  assert.strictEqual(s.defHp, 4);
});

test('M43.2: applyVerdictToState — applies dmg to attacker on counter-attack', () => {
  const s = createCinemaState({
    attacker: { hpMax: 30 }, defender: { hpMax: 10 }
  });
  s.pendingDmg = { victim: 'attacker', dmg: 4 };
  applyVerdictToState(s, 200, 200);
  assert.strictEqual(s.attHp, 26);
});

test('M43.2: applyVerdictToState — clamps damage to zero (no negative HP)', () => {
  const s = createCinemaState({
    attacker: { hpMax: 30 }, defender: { hpMax: 5 }
  });
  s.pendingDmg = { victim: 'defender', dmg: 12 };
  applyVerdictToState(s, 200, 200);
  assert.strictEqual(s.defHp, 0);
});

test('M43.2: applyVerdictToState — pushes a popup record with crit flag', () => {
  const s = createCinemaState({
    attacker: { hpMax: 30 }, defender: { hpMax: 10 }
  });
  s.pendingDmg = { victim: 'defender', dmg: 12, crit: true };
  applyVerdictToState(s, 200, 200);
  assert.strictEqual(s.popups.length, 1);
  assert.strictEqual(s.popups[0].crit, true);
  assert.strictEqual(s.popups[0].dmg, 12);
});

// ---------- createCinema (controller) ----------

test('M43.2: createCinema — playRound updates state at hit-pause moment', async () => {
  // We don't need a real canvas; null ctx means draw() is skipped but
  // the state machine still runs.
  const cinema = createCinema({
    canvas: null,
    attacker: { id: 'a', name: 'Hero', hpMax: 30 },
    defender: { id: 'd', name: 'Goblin', hpMax: 10 }
  });
  const seq = buildMotion('sword-slash');
  await cinema.playRound(seq, { victim: 'defender', dmg: 5 });
  assert.strictEqual(cinema.state.defHp, 5);
});

test('M43.2: createCinema — miss leaves HP untouched', async () => {
  const cinema = createCinema({
    canvas: null,
    attacker: { hpMax: 30, name: 'A' },
    defender: { hpMax: 10, name: 'D' }
  });
  const seq = buildMotion('sword-slash');
  await cinema.playRound(seq, { victim: 'defender', dmg: 7, miss: true });
  assert.strictEqual(cinema.state.defHp, 10);   // untouched
});

test('M43.2: createCinema — resetHp updates state', () => {
  const cinema = createCinema({
    canvas: null,
    attacker: { hpMax: 30, name: 'A' },
    defender: { hpMax: 10, name: 'D' }
  });
  cinema.state.attHp = 5;
  cinema.state.defHp = 1;
  cinema.state.popups.push({ side: 'defender', dmg: 9, t: 100 });
  cinema.resetHp({ attHp: 20, defHp: 9 });
  assert.strictEqual(cinema.state.attHp, 20);
  assert.strictEqual(cinema.state.defHp, 9);
  assert.deepStrictEqual(cinema.state.popups, []);
});

test('M43.2: createCinema — multiple consecutive rounds accumulate damage', async () => {
  const cinema = createCinema({
    canvas: null,
    attacker: { hpMax: 30, name: 'A' },
    defender: { hpMax: 30, name: 'D' }
  });
  const seq = buildMotion('dagger-stab');
  await cinema.playRound(seq, { victim: 'defender', dmg: 5 });
  await cinema.playRound(seq, { victim: 'defender', dmg: 7 });
  await cinema.playRound(seq, { victim: 'defender', dmg: 4 });
  assert.strictEqual(cinema.state.defHp, 30 - 5 - 7 - 4);
});

test('M43.2: createCinema — crits flagged on the popup record', async () => {
  const cinema = createCinema({
    canvas: null,
    attacker: { hpMax: 30, name: 'A' },
    defender: { hpMax: 30, name: 'D' }
  });
  await cinema.playRound(buildMotion('axe-cleave'), { victim: 'defender', dmg: 18, crit: true });
  assert.strictEqual(cinema.state.popups[0].crit, true);
  assert.strictEqual(cinema.state.popups[0].dmg, 18);
});

// ---------- M44: setActors ----------

test('M44: createCinema — setActors swaps actor names + HP', async () => {
  const cinema = createCinema({
    canvas: null,
    attacker: { id: 'a1', name: 'First', hpMax: 20 },
    defender: { id: 'd1', name: 'Boss',  hpMax: 50 }
  });
  await cinema.setActors({
    attacker: { id: 'a2', name: 'Second', hp: { max: 30 } },
    defender: { id: 'd2', name: 'Cultist', hp: { max: 15 } }
  });
  assert.strictEqual(cinema.state.attacker.name, 'Second');
  assert.strictEqual(cinema.state.defender.name, 'Cultist');
  assert.strictEqual(cinema.state.attHpMax, 30);
  assert.strictEqual(cinema.state.defHpMax, 15);
  // HP resets to max on actor swap
  assert.strictEqual(cinema.state.attHp, 30);
  assert.strictEqual(cinema.state.defHp, 15);
});

test('M44: createCinema — setActors fires onActorsChanged hook', async () => {
  let captured = null;
  const cinema = createCinema({
    canvas: null,
    attacker: { id: 'a1', name: 'A', hpMax: 10 },
    defender: { id: 'd1', name: 'D', hpMax: 10 },
    onActorsChanged: async ({ attacker, defender }) => {
      captured = { aId: attacker.id, dId: defender.id };
    }
  });
  await cinema.setActors({
    attacker: { id: 'a2', name: 'A2', hpMax: 10 },
    defender: { id: 'd2', name: 'D2', hpMax: 10 }
  });
  assert.deepStrictEqual(captured, { aId: 'a2', dId: 'd2' });
});

test('M44: createCinema — setActors with partial update preserves the other side', async () => {
  const cinema = createCinema({
    canvas: null,
    attacker: { id: 'a1', name: 'Keep',   hpMax: 25 },
    defender: { id: 'd1', name: 'Replace', hpMax: 12 }
  });
  await cinema.setActors({
    defender: { id: 'd2', name: 'NewFoe', hpMax: 40 }
  });
  assert.strictEqual(cinema.state.attacker.name, 'Keep');
  assert.strictEqual(cinema.state.defender.name, 'NewFoe');
  assert.strictEqual(cinema.state.defHpMax, 40);
});

test('M44: createCinema — setActors clears any pending popups + verdict', async () => {
  const cinema = createCinema({
    canvas: null,
    attacker: { hpMax: 20, name: 'A' },
    defender: { hpMax: 20, name: 'D' }
  });
  cinema.state.popups.push({ side: 'defender', dmg: 5, t: 100 });
  cinema.state.pendingDmg = { victim: 'defender', dmg: 3 };
  await cinema.setActors({
    attacker: { id: 'a2', name: 'A2', hpMax: 20 },
    defender: { id: 'd2', name: 'D2', hpMax: 20 }
  });
  assert.deepStrictEqual(cinema.state.popups, []);
  assert.strictEqual(cinema.state.pendingDmg, null);
});

// ---------- M44.1: phaseAt ----------

test('M44.1: phaseAt — pre-windup window reads as idle', () => {
  assert.strictEqual(phaseAt(0, 600), 'idle');
});

test('M44.1: phaseAt — windup window reads as windup', () => {
  // impactAt - 350 ≤ t < impactAt - 100
  assert.strictEqual(phaseAt(300, 600), 'windup');
});

test('M44.1: phaseAt — impact moment reads as strike', () => {
  assert.strictEqual(phaseAt(600, 600), 'strike');
});

test('M44.1: phaseAt — well past impact reads as recover', () => {
  assert.strictEqual(phaseAt(900, 600), 'recover');
});

test('M44.1: phaseAt — non-finite impactAt safely falls back to idle', () => {
  assert.strictEqual(phaseAt(500, NaN), 'idle');
  assert.strictEqual(phaseAt(500, null), 'idle');
});

// ---------- M44.3: defenderPhaseAt ----------

test('M44.3: defenderPhaseAt — pre-impact reads as idle', () => {
  assert.strictEqual(defenderPhaseAt(0,   600), 'idle');
  assert.strictEqual(defenderPhaseAt(599, 600), 'idle');
});

test('M44.3: defenderPhaseAt — impact moment + 220ms window reads as hurt', () => {
  assert.strictEqual(defenderPhaseAt(600, 600), 'hurt');
  assert.strictEqual(defenderPhaseAt(700, 600), 'hurt');
  assert.strictEqual(defenderPhaseAt(819, 600), 'hurt');
});

test('M44.3: defenderPhaseAt — past hurt window returns to idle', () => {
  assert.strictEqual(defenderPhaseAt(820,  600), 'idle');
  assert.strictEqual(defenderPhaseAt(1500, 600), 'idle');
});

test('M44.3: defenderPhaseAt — non-finite impactAt safely falls back to idle', () => {
  assert.strictEqual(defenderPhaseAt(500, NaN), 'idle');
});
