/**
 * M64 C5 — buildCinemaSequence: pure, event-driven cinema plan.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildCinemaSequence, bodyAnimForMotion, bodyAnimForSwing } from '../js/anim/cinema-plan.js';
import { validateEvent } from '../js/shared/events.js';

const FIXTURES = JSON.parse(readFileSync(new URL('./fixtures/contracts/events.valid.json', import.meta.url), 'utf8'));
const clone = (v) => JSON.parse(JSON.stringify(v));
const exchange = () => clone(FIXTURES.find(e => e.type === 'exchange'));

function deepFreeze(v) {
  if (v && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const k of Object.keys(v)) deepFreeze(v[k]);
  }
  return v;
}

/** Run fn with globalThis.localStorage replaced by a getter that throws. */
function withThrowingStorage(fn) {
  const desc = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  let touched = 0;
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    get() { touched++; throw new Error('localStorage must not be read by buildCinemaSequence'); }
  });
  try {
    return { result: fn(), touched: () => touched };
  } finally {
    if (desc) Object.defineProperty(globalThis, 'localStorage', desc);
    else delete globalThis.localStorage;
  }
}

const castEvent = () => {
  const ev = exchange();
  ev.payload.cast = true;
  ev.payload.roll = null;
  ev.payload.cinema = {
    ...ev.payload.cinema,
    weapon: null, motionId: 'staff-cast', swing: null, modifiers: [],
    spellId: 'fire-bolt',
    spell: { kind: 'spell-attack', damageType: 'fire' },
    outcome: { dmg: 9, miss: false, crit: false }
  };
  return ev;
};

test('C5: the fixture exchange event is contract-valid', () => {
  assert.equal(validateEvent(exchange()).ok, true);
});

test('C5: same event JSON gives deep-equal Sequences on two runs with localStorage throwing', () => {
  const { result, touched } = withThrowingStorage(() => [
    buildCinemaSequence(exchange()),
    buildCinemaSequence(exchange())
  ]);
  const [a, b] = result;
  assert.ok(a.seq && a.seq.keyframes.length > 0);
  assert.deepEqual(a, b);
  assert.equal(touched(), 0);
  // casts too
  const casts = withThrowingStorage(() => [buildCinemaSequence(castEvent()), buildCinemaSequence(castEvent())]);
  assert.deepEqual(casts.result[0], casts.result[1]);
});

test('C5: the input event and lookups are not mutated (deep-frozen)', () => {
  const ev = deepFreeze(exchange());
  const lookups = deepFreeze({ weapon: () => ({ damageType: 'slashing' }) });
  assert.doesNotThrow(() => buildCinemaSequence(ev, lookups));
  assert.deepEqual(ev, exchange());
  const cast = deepFreeze(castEvent());
  assert.doesNotThrow(() => buildCinemaSequence(cast));
});

test('C5: a weapon switch in the event changes the motion id (chosen weapon, not mainhand)', () => {
  const sword = buildCinemaSequence(exchange());
  const ev = exchange();
  ev.payload.cinema.weapon = { name: 'Longbow', damageType: 'piercing' };
  const bow = buildCinemaSequence(ev);
  assert.equal(sword.motionId, 'sword-slash');
  assert.equal(bow.motionId, 'bow-draw');
  assert.notEqual(sword.seq.id, bow.seq.id);
  // stale motionId in the event does not override the chosen weapon
  assert.equal(ev.payload.cinema.motionId, 'sword-slash');
});

test('C5: accepts the bare payload as well as the event envelope', () => {
  assert.deepEqual(buildCinemaSequence(exchange().payload), buildCinemaSequence(exchange()));
});

test('C5: fxSeed and exchangeId ride the Sequence meta', () => {
  const { seq } = buildCinemaSequence(exchange());
  assert.equal(seq.meta.fxSeed, 123456);
  assert.equal(seq.meta.exchangeId, 'x2');
});

test('C5: swing from the event is applied to melee and drives the body animation', () => {
  const ev = exchange();
  ev.payload.cinema.swing = 'thrust';
  const plan = buildCinemaSequence(ev);
  assert.equal(plan.swing, 'thrust');
  assert.equal(plan.seq.meta.swing, 'thrust');
  assert.equal(plan.bodyAnim, 'thrust');
  // unknown / unresolved swing ids are ignored
  const raw = exchange();
  raw.payload.cinema.swing = 'varied';
  assert.equal(buildCinemaSequence(raw).swing, null);
});

test('C5: reactions play Quick with no swing and no modifiers', () => {
  const ev = exchange();
  ev.payload.reaction = true;
  ev.payload.cinema.swing = 'overhead';
  ev.payload.cinema.modifiers = ['sneak-attack'];
  const plan = buildCinemaSequence(ev);
  assert.equal(plan.swing, null);
  const quick = exchange();
  quick.payload.cinema.style = 'quick';
  quick.payload.cinema.swing = null;
  assert.equal(plan.seq.duration, buildCinemaSequence(quick).seq.duration);
});

test('C5: modifiers come from the event, not from entity flags', () => {
  const base = buildCinemaSequence(exchange());
  const ev = exchange();
  ev.payload.cinema.modifiers = ['divine-smite', 'not-a-modifier'];
  ev.payload.cinema.smiteSlot = 2;
  const smite = buildCinemaSequence(ev);
  assert.ok(smite.seq.effects.length > base.seq.effects.length);
  // featuresFired is the fallback when `modifiers` is absent
  const ff = exchange();
  delete ff.payload.cinema.modifiers;
  ff.payload.cinema.featuresFired = ['divine-smite'];
  ff.payload.cinema.smiteSlot = 2;
  assert.deepEqual(buildCinemaSequence(ff).seq, smite.seq);
});

test('C5: killing and crit flags reach the polish layer', () => {
  const ev = exchange();
  ev.payload.roll.crit = true;
  const plan = buildCinemaSequence(ev);
  assert.equal(plan.seq.meta.crit, true);
  assert.equal(plan.verdict.crit, true);
  const notKilling = exchange();
  notKilling.payload.cinema.killing = false;
  assert.notDeepEqual(buildCinemaSequence(notKilling).seq.effects, buildCinemaSequence(exchange()).seq.effects);
});

test('C5: a miss sets the verdict and skips the hit reaction', () => {
  const ev = exchange();
  ev.payload.roll.hit = false;
  ev.payload.damage = null;
  ev.payload.cinema.weapon = { name: 'Longsword', damageType: 'fire' };
  const plan = buildCinemaSequence(ev);
  assert.equal(plan.verdict.miss, true);
  assert.equal(plan.verdict.dmg, 0);
  assert.equal(plan.defenderReaction.hitReaction, null);
});

test('C5: lookups fill weapon metadata the event leaves out; event fields win', () => {
  const ev = exchange();
  ev.payload.cinema.weapon = { name: 'Flame Tongue Longsword' };
  const plan = buildCinemaSequence(ev, { weapon: () => ({ damageType: 'fire', magical: true }) });
  assert.equal(plan.defenderReaction.hitReaction, 'fire');
  const ev2 = exchange();   // fixture weapon says slashing
  const plan2 = buildCinemaSequence(ev2, { weapon: () => ({ damageType: 'fire' }) });
  assert.equal(plan2.defenderReaction.hitReaction, null);
});

test('C5: casts build a spell sequence with the cast body animation', () => {
  const plan = buildCinemaSequence(castEvent());
  assert.equal(plan.motionId, 'staff-cast');
  assert.equal(plan.bodyAnim, 'cast');
  assert.equal(plan.swing, null);
  assert.equal(plan.verdict.dmg, 9);
  assert.equal(plan.defenderReaction.hitReaction, 'fire');
  // spell record via lookups when not inlined
  const ev = castEvent();
  delete ev.payload.cinema.spell;
  const viaLookup = buildCinemaSequence(ev, { spell: id => (id === 'fire-bolt' ? { kind: 'spell-attack', damageType: 'fire' } : null) });
  assert.deepEqual(viaLookup.seq, plan.seq);
});

test('C5: heals are friendly — no polish, heal rides the verdict', () => {
  const ev = castEvent();
  ev.payload.cinema.spell = { kind: 'heal' };
  ev.payload.cinema.outcome = { dmg: 0, heal: 7 };
  const plan = buildCinemaSequence(ev);
  assert.equal(plan.verdict.heal, 7);
  assert.notEqual(plan.seq.meta.polish, true);
});

test('C5: bodyAnimForMotion / bodyAnimForSwing map ids to LPC body sheets', () => {
  assert.equal(bodyAnimForMotion('staff-cast'), 'cast');
  assert.equal(bodyAnimForMotion('lance-thrust'), 'thrust');
  assert.equal(bodyAnimForMotion('axe-cleave'), 'slash');
  assert.equal(bodyAnimForSwing('rising'), 'backslash');
  assert.equal(bodyAnimForSwing('horizontal'), 'halfslash');
  assert.equal(bodyAnimForSwing('overhead'), 'slash');
});
