import { test } from 'node:test';
import assert from 'node:assert';
import { newSequence, addKey, addEffect } from '../js/anim/sequence.js';
import { playSequence } from '../js/anim/timeline.js';

// ---------- Manual-tick driving ----------

test('M43.0: playSequence — render is called with snapshot + effects on each tick', async () => {
  const seq = newSequence('test', 200);
  addKey(seq, { at: 0,   actor: 'attacker', x: 0,   easing: 'linear' });
  addKey(seq, { at: 200, actor: 'attacker', x: 100, easing: 'linear' });
  addEffect(seq, { at: 100, type: 'slash-arc' });

  const calls = [];
  const ctl = playSequence(seq, (state) => calls.push({
    t: state.t, attackerX: state.attacker.x, effectTypes: state.effects.map(e => e.type)
  }), { manualTicks: true });

  ctl.tick(0);
  ctl.tick(50);
  ctl.tick(150);
  ctl.tick(200);
  const result = await ctl.promise;

  assert.strictEqual(result.completed, true);
  assert.strictEqual(calls.length, 4);
  // Effect fires only between t=50 and t=150 (since 50 < 100 <= 150)
  assert.deepStrictEqual(calls[2].effectTypes, ['slash-arc']);
  // Sprite x interpolates linearly to 50 by halfway
  assert.strictEqual(calls[2].attackerX, 75);
});

test('M43.0: playSequence — completes when t reaches duration', async () => {
  const seq = newSequence('test', 100);
  addKey(seq, { at: 0,   actor: 'attacker', x: 0 });
  addKey(seq, { at: 100, actor: 'attacker', x: 10 });

  let completed = false;
  const ctl = playSequence(seq, () => {}, { manualTicks: true });
  ctl.promise.then((r) => { completed = r.completed; });
  ctl.tick(100);
  await ctl.promise;
  assert.strictEqual(completed, true);
});

test('M43.0: playSequence — hit-pause flag set on tick after a hit-pause event', () => {
  const seq = newSequence('test', 500);
  addEffect(seq, { at: 100, type: 'hit-pause', params: { duration: 200 } });
  let snapshot = null;
  const ctl = playSequence(seq, (state) => { snapshot = state; }, { manualTicks: true });
  ctl.tick(150);
  assert.ok(snapshot.hitPauseUntil > 0,
    `hitPauseUntil should be set after a hit-pause effect; got ${snapshot.hitPauseUntil}`);
});

test('M43.0: playSequence — flash decays each tick', () => {
  const seq = newSequence('test', 500);
  addEffect(seq, { at: 100, type: 'flash', params: { intensity: 0.8 } });
  let snapshot = null;
  const ctl = playSequence(seq, (state) => { snapshot = state; }, { manualTicks: true });
  ctl.tick(150);
  const flash1 = snapshot.flash;
  ctl.tick(200);
  const flash2 = snapshot.flash;
  assert.ok(flash1 > 0, `flash should be positive after fire; got ${flash1}`);
  assert.ok(flash2 < flash1, `flash should decay; got ${flash1} → ${flash2}`);
});

test('M43.0: playSequence — cancel() rejects the promise', async () => {
  const seq = newSequence('test', 1000);
  const ctl = playSequence(seq, () => {}, { manualTicks: true });
  ctl.cancel();
  const result = await ctl.promise;
  assert.strictEqual(result.cancelled, true);
});

test('M43.0: playSequence — effects between ticks fire in order', () => {
  const seq = newSequence('s', 500);
  addEffect(seq, { at: 100, type: 'a' });
  addEffect(seq, { at: 110, type: 'b' });
  addEffect(seq, { at: 120, type: 'c' });
  const fired = [];
  const ctl = playSequence(seq, (s) => {
    for (const e of s.effects) fired.push(e.type);
  }, { manualTicks: true });
  ctl.tick(50);
  ctl.tick(200);
  assert.deepStrictEqual(fired, ['a', 'b', 'c']);
});

test('M43.0: playSequence — shake state populates after a shake effect', () => {
  const seq = newSequence('s', 500);
  addEffect(seq, { at: 50, type: 'shake', params: { amplitude: 6 } });
  let snapshot = null;
  const ctl = playSequence(seq, (s) => { snapshot = s; }, { manualTicks: true });
  ctl.tick(100);
  assert.ok(snapshot.shake, 'shake state should be set after a shake effect');
  assert.ok(typeof snapshot.shake.x === 'number');
});
