import { test } from 'node:test';
import assert from 'node:assert';
import { applyHitReaction } from '../js/anim/hit-reactions.js';
import { buildMotion } from '../js/anim/weapon-motions.js';
import { newSequence, addKey, addEffect } from '../js/anim/sequence.js';
import { playSequence } from '../js/anim/timeline.js';

function impactOf(seq) {
  return seq.effects.find(e => e.type === 'hit-pause').at;
}

// ---------- pass-through behavior ----------

test('M56.5: applyHitReaction — null seq passes through', () => {
  assert.strictEqual(applyHitReaction(null), null);
});

test('M56.5: applyHitReaction — unknown / missing types return an untouched clone', () => {
  const base = buildMotion('sword-slash');
  for (const damageType of ['slashing', 'piercing', 'bludgeoning', 'banana', '', null, undefined]) {
    const out = applyHitReaction(base, { damageType });
    assert.notStrictEqual(out, base, 'always a new object');
    assert.strictEqual(out.effects.length, base.effects.length, `${damageType}: no effects added`);
    assert.strictEqual(out.keyframes.length, base.keyframes.length, `${damageType}: no keyframes added`);
    assert.strictEqual(out.duration, base.duration);
  }
});

test('M56.5: applyHitReaction — pure: the input sequence is untouched', () => {
  const base = buildMotion('sword-slash');
  const effectsBefore = base.effects.length;
  const keyframesBefore = base.keyframes.length;
  const pauseBefore = base.effects.find(e => e.type === 'hit-pause').params.duration;
  applyHitReaction(base, { damageType: 'fire' });
  applyHitReaction(base, { damageType: 'cold' });
  assert.strictEqual(base.effects.length, effectsBefore);
  assert.strictEqual(base.keyframes.length, keyframesBefore);
  assert.strictEqual(base.effects.find(e => e.type === 'hit-pause').params.duration, pauseBefore);
});

test('M56.5: applyHitReaction — capitalized registry types are normalized', () => {
  const base = buildMotion('staff-cast');
  const out = applyHitReaction(base, { damageType: 'Fire' });
  assert.strictEqual(out.meta.hitReaction, 'fire');
  assert.ok(out.effects.some(e => e.type === 'flash' && e.params?.color === '#fb923c'));
});

// ---------- per-type deltas ----------

test('M56.5: fire — extra defender knockback + orange flash', () => {
  const base = buildMotion('sword-slash');
  const out = applyHitReaction(base, { damageType: 'fire' });
  const impactAt = impactOf(out);
  const kick = out.keyframes.find(k => k.actor === 'defender' && k.at === impactAt + 60);
  assert.ok(kick, 'knockback keyframe added');
  // The kick pushes PAST the interpolated position at that moment
  assert.ok(kick.x > 0, 'pushes the defender back');
  const flash = out.effects.find(e => e.type === 'flash' && e.params?.color);
  assert.strictEqual(flash.params.color, '#fb923c');
});

test('M56.5: cold — extends the hit-pause and tints the flash blue', () => {
  const base = buildMotion('sword-slash');
  const basePause = base.effects.find(e => e.type === 'hit-pause').params.duration;
  const out = applyHitReaction(base, { damageType: 'cold' });
  const outPause = out.effects.find(e => e.type === 'hit-pause').params.duration;
  assert.strictEqual(outPause, basePause + 80, 'freeze holds 80ms longer');
  const flash = out.effects.find(e => e.type === 'flash' && e.params?.color);
  assert.strictEqual(flash.params.color, '#7dd3fc');
});

test('M56.5: lightning — two staccato shakes 50ms apart + yellow flash', () => {
  const base = buildMotion('sword-slash');
  const baseShakes = base.effects.filter(e => e.type === 'shake').length;
  const out = applyHitReaction(base, { damageType: 'lightning' });
  const added = out.effects.filter(e => e.type === 'shake').slice(baseShakes);
  assert.strictEqual(added.length, 2, 'two extra shakes');
  assert.strictEqual(added[1].at - added[0].at, 50, '50ms apart');
  const flash = out.effects.find(e => e.type === 'flash' && e.params?.color);
  assert.strictEqual(flash.params.color, '#fde047');
});

test('M56.5: necrotic — defender alpha dip + purple glyph', () => {
  const base = buildMotion('sword-slash');
  const out = applyHitReaction(base, { damageType: 'necrotic' });
  const dip = out.keyframes.find(k => k.actor === 'defender' && k.alpha != null && k.alpha < 1);
  assert.ok(dip, 'alpha dip keyframe added');
  assert.strictEqual(dip.alpha, 0.55);
  // ...and recovers afterwards
  const recover = out.keyframes.find(k => k.actor === 'defender' && k.at > dip.at && k.alpha === 1);
  assert.ok(recover, 'alpha recovers after the dip');
  const glyphs = out.effects.filter(e => e.type === 'glyph-rise');
  assert.ok(glyphs.some(g => g.params?.damageType === 'necrotic'), 'drain glyph added');
});

test('M56.5: baked keyframes preserve the interpolated knockback position', () => {
  // The necrotic dip lands mid-settle; its keyframe must carry the
  // sampled x at that moment, not yank the defender back to x=0.
  const base = buildMotion('sword-slash');   // impact 460, knockback x=12 at 480
  const out = applyHitReaction(base, { damageType: 'necrotic' });
  const impactAt = impactOf(out);
  const dip = out.keyframes.find(k => k.actor === 'defender' && k.at === impactAt + 40);
  assert.ok(dip.x > 0, `dip keyframe keeps the knockback x (got ${dip.x})`);
});

// ---------- timeline: the color reaches the frame payload ----------

test('M56.5: timeline — a colored flash reaches render() and persists while decaying', async () => {
  const seq = newSequence('flash-test', 300);
  addKey(seq, { at: 0,   actor: 'attacker', x: 0 });
  addKey(seq, { at: 300, actor: 'attacker', x: 10 });
  addEffect(seq, { at: 100, type: 'flash', params: { intensity: 0.5, color: '#fb923c' } });

  const frames = [];
  const ctl = playSequence(seq, (f) => frames.push({ flash: f.flash, color: f.flashColor }),
    { manualTicks: true });
  ctl.tick(50);    // before the flash
  ctl.tick(150);   // flash fired
  ctl.tick(200);   // decaying
  ctl.tick(300);   // done
  await ctl.promise;

  assert.strictEqual(frames[0].color, null, 'no color before the flash');
  assert.strictEqual(frames[1].color, '#fb923c', 'color rides the frame payload');
  assert.strictEqual(frames[1].flash, 0.5);
  assert.strictEqual(frames[2].color, '#fb923c', 'color persists while intensity decays');
  assert.ok(frames[2].flash < 0.5, 'intensity decays per frame');
});

test('M56.5: timeline — a colorless flash keeps flashColor null (white default)', async () => {
  const seq = newSequence('flash-default', 200);
  addKey(seq, { at: 0,   actor: 'attacker', x: 0 });
  addKey(seq, { at: 200, actor: 'attacker', x: 10 });
  addEffect(seq, { at: 50, type: 'flash', params: { intensity: 0.4 } });

  const frames = [];
  const ctl = playSequence(seq, (f) => frames.push(f.flashColor),
    { manualTicks: true });
  ctl.tick(100);
  ctl.tick(200);
  await ctl.promise;
  assert.ok(frames.every(c => c === null), 'no tint without a color param');
});
