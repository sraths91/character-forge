import { test } from 'node:test';
import assert from 'node:assert';
import {
  SWING_TYPES, isSwing, isSwingSelection, availableSwings, nextVariedSwing,
  saveSwing, loadSwing, swingForPc, swingArcRig, applySwing
} from '../js/anim/swing-types.js';

// node has no localStorage — provide a Map-backed stub so the persistence
// path (which the browser exercises for real) is testable here.
const _store = new Map();
globalThis.localStorage = {
  getItem: (k) => (_store.has(k) ? _store.get(k) : null),
  setItem: (k, v) => { _store.set(k, String(v)); },
  removeItem: (k) => { _store.delete(k); }
};

function baseSeq() {
  return {
    id: 'sword-slash', duration: 1000,
    keyframes: [
      { at: 0, actor: 'attacker', x: 0, rotation: 0 },
      { at: 200, actor: 'attacker', x: -5, rotation: -0.2 },
      { at: 450, actor: 'attacker', x: 30, rotation: 0.3 },   // strike (max |x|)
      { at: 700, actor: 'attacker', x: 25, rotation: 0.1 },
      { at: 1000, actor: 'attacker', x: 0, rotation: 0 },
      { at: 450, actor: 'defender', x: 5 }
    ],
    effects: [
      { at: 400, type: 'slash-arc', params: { damageType: 'slashing' } },
      { at: 460, type: 'shake', params: { amplitude: 3 } }
    ],
    meta: { kind: 'melee', weaponClass: 'sword' }
  };
}

// ---------- table + helpers ----------

test('swing-types: table shape', () => {
  for (const [id, s] of Object.entries(SWING_TYPES)) {
    assert.strictEqual(s.id, id);
    assert.ok(typeof s.label === 'string' && s.label.length);
    assert.ok(s.arc && Number.isFinite(s.arc.strike), `${id}.arc`);
    assert.ok(s.body && Number.isFinite(s.body.dy), `${id}.body`);
    assert.ok(typeof s.effect === 'string', `${id}.effect`);
  }
});

test('swing-types: isSwing vs isSwingSelection', () => {
  assert.ok(isSwing('overhead'));
  assert.ok(!isSwing('varied'));            // varied is a mode, not a type
  assert.ok(isSwingSelection('varied'));
  assert.ok(isSwingSelection('thrust'));
  assert.ok(!isSwingSelection('nonsense'));
});

test('swing-types: availableSwings gates spin to longer weapons', () => {
  const sword = availableSwings('sword').map(s => s.id);
  assert.ok(sword.includes('spin'));
  const dagger = availableSwings('light').map(s => s.id);
  assert.ok(!dagger.includes('spin'), 'spin gated off for daggers');
  assert.ok(dagger.includes('overhead') && dagger.includes('thrust'));
});

test('swing-types: nextVariedSwing cycles deterministically', () => {
  const a = [0, 1, 2, 3].map(n => nextVariedSwing('sword', n));
  const b = [0, 1, 2, 3].map(n => nextVariedSwing('sword', n));
  assert.deepStrictEqual(a, b, 'deterministic');
  // it advances (not all the same)
  assert.ok(new Set(a).size > 1, 'cycles through types');
  // wraps
  const list = availableSwings('sword');
  assert.strictEqual(nextVariedSwing('sword', list.length), nextVariedSwing('sword', 0));
});

test('swing-types: swingArcRig returns the rig or null', () => {
  assert.strictEqual(swingArcRig('thrust'), SWING_TYPES.thrust.arc);
  assert.strictEqual(swingArcRig('nope'), null);
});

test('swing-types: spin rig sweeps a full turn', () => {
  assert.ok(SWING_TYPES.spin.arc.spin === true);
  assert.ok(Math.abs(SWING_TYPES.spin.arc.strike) > 5, 'spin strike ~full rotation');
});

// ---------- persistence ----------

test('swing-types: save/load/forPc persistence', () => {
  saveSwing('pcX', 'overhead');
  assert.strictEqual(loadSwing('pcX'), 'overhead');
  assert.strictEqual(swingForPc({ id: 'pcX' }), 'overhead');
  // explicit override wins
  assert.strictEqual(swingForPc({ id: 'pcX', _swingType: 'thrust' }), 'thrust');
  // varied persists
  saveSwing('pcY', 'varied');
  assert.strictEqual(swingForPc({ id: 'pcY' }), 'varied');
  // default
  assert.strictEqual(swingForPc({ id: 'unsaved' }), 'diagonal');
  assert.strictEqual(swingForPc(null), 'diagonal');
});

// ---------- applySwing ----------

test('swing-types: applySwing is pure + stamps meta + re-orients effect', () => {
  const seq = baseSeq();
  const out = applySwing(seq, 'overhead');
  assert.notStrictEqual(out, seq);
  assert.strictEqual(seq.effects[0].params.swing, undefined, 'input untouched');
  assert.strictEqual(out.meta.swing, 'overhead');
  assert.strictEqual(out.effects[0].params.swing, 'overhead', 'slash-arc re-oriented');
  // shake effect is not a cut → not stamped
  assert.strictEqual(out.effects[1].params.swing, undefined);
});

test('swing-types: applySwing nudges the strike keyframe (overhead drops)', () => {
  const out = applySwing(baseSeq(), 'overhead');
  const strike = out.keyframes.find(k => k.actor === 'attacker' && k.x >= 30);
  assert.ok(strike.y > 0, 'overhead drops the body at the strike');
});

test('swing-types: applySwing rising lifts the body', () => {
  const out = applySwing(baseSeq(), 'rising');
  const strike = out.keyframes.find(k => k.actor === 'attacker' && k.x >= 30);
  assert.ok(strike.y < 0, 'rising lifts the body at the strike');
});

test('swing-types: applySwing unknown id → clone with no swing applied', () => {
  const out = applySwing(baseSeq(), 'nope');
  assert.strictEqual(out.effects[0].params.swing, undefined);
});

// ---------- timing + flavor ----------

test('swing-types: every swing has a timing profile + verb', () => {
  for (const [id, s] of Object.entries(SWING_TYPES)) {
    assert.ok(Number.isFinite(s.timing?.speed) && s.timing.speed > 0, `${id}.timing.speed`);
    assert.ok(Number.isFinite(s.timing?.hitPause), `${id}.timing.hitPause`);
    assert.ok(typeof s.verb === 'string' && s.verb.length, `${id}.verb`);
  }
});

test('swing-types: timing scales the sequence — overhead slower, thrust faster', () => {
  const base = baseSeq().duration;          // 1000
  const overhead = applySwing(baseSeq(), 'overhead');   // speed 0.80 → longer
  const thrust = applySwing(baseSeq(), 'thrust');       // speed 1.25 → shorter
  assert.ok(overhead.duration > base, `overhead ${overhead.duration} > ${base}`);
  assert.ok(thrust.duration < base, `thrust ${thrust.duration} < ${base}`);
  // keyframe times scale too
  const sBase = baseSeq().keyframes.find(k => k.x === 30).at;
  const sOver = overhead.keyframes.find(k => k.x === 30).at;
  assert.ok(sOver > sBase, 'overhead strike lands later (slower)');
});

test('swing-types: applySwing scales the hit-pause + stamps the verb', () => {
  const seq = baseSeq();
  seq.effects.push({ at: 460, type: 'hit-pause', params: { duration: 180 } });
  const out = applySwing(seq, 'overhead');   // hitPause 1.5
  const hp = out.effects.find(e => e.type === 'hit-pause');
  assert.ok(hp.params.duration > 180, `overhead holds the freeze longer: ${hp.params.duration}`);
  assert.strictEqual(out.meta.swingVerb, SWING_TYPES.overhead.verb);
});
