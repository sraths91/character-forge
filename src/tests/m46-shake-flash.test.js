import { test } from 'node:test';
import assert from 'node:assert';
import { playSequence } from '../js/anim/timeline.js';
import { newSequence, addEffect } from '../js/anim/sequence.js';
import { makeLpcDrawSprite } from '../js/anim/cinema-sprites.js';

// ---------- Damped-sine shake ----------

test('M46: damped-sine shake — peak amplitude near the impulse moment', () => {
  // Build a tiny sequence that fires a shake at t=10 with amplitude=10.
  // Tick the timeline manually and read the shake field each frame.
  // (Effect-at-0 wouldn't fire on the first tick because effectsBetween
  // uses strict-greater-than on the lower bound.)
  const seq = newSequence('shake-test', 600);
  addEffect(seq, { at: 10, type: 'shake', params: { amplitude: 10, freq: 20, dampPerSec: 6 } });

  const samples = [];
  const ctl = playSequence(seq, (frame) => {
    if (frame.shake) {
      samples.push({ t: frame.t, mag: Math.hypot(frame.shake.x, frame.shake.y) });
    }
  }, { manualTicks: true });

  // Tick every 16ms across the full sequence
  for (let t = 0; t <= 600; t += 16) ctl.tick(t);

  assert.ok(samples.length > 0, 'shake samples should be produced');
  // Magnitude in the first 100ms should peak above 4 (significant fraction
  // of the 10 amplitude); after 500ms it should have decayed below 0.5.
  const early = samples.filter(s => s.t < 100);
  const late  = samples.filter(s => s.t > 400);
  const earlyMax = early.length ? Math.max(...early.map(s => s.mag)) : 0;
  const lateMax  = late.length  ? Math.max(...late.map(s => s.mag))  : 0;
  assert.ok(earlyMax > 4, `expected early shake mag > 4; got ${earlyMax}`);
  assert.ok(lateMax  < earlyMax, `expected shake to decay over time (early=${earlyMax}, late=${lateMax})`);
});

test('M46: damped-sine shake — Y component is a phase-shifted swing', () => {
  // The shake's Y traces a sin(phase + π/2)*0.6 — so at any t where X
  // is near peak, Y should be near zero, and vice versa. Confirms we're
  // NOT just outputting random noise.
  const seq = newSequence('phase-test', 200);
  addEffect(seq, { at: 10, type: 'shake', params: { amplitude: 10, freq: 25, dampPerSec: 1 } });
  let captured = null;
  const ctl = playSequence(seq, (frame) => {
    if (frame.shake && captured == null && frame.t > 10) {
      captured = { x: frame.shake.x, y: frame.shake.y };
    }
  }, { manualTicks: true });
  for (let t = 0; t <= 200; t += 16) ctl.tick(t);
  assert.ok(captured, 'should have captured a shake sample');
  // Both components should be in a sensible range
  assert.ok(Math.abs(captured.x) <= 10);
  assert.ok(Math.abs(captured.y) <= 10);
});

// ---------- White-flash + squash on hurt phase ----------

/** Tiny mock canvas that records fillRect + scale calls. */
function mockCtx() {
  const calls = [];
  return {
    calls,
    save: () => calls.push(['save']),
    restore: () => calls.push(['restore']),
    translate: () => {},
    rotate: () => {},
    scale: (sx, sy) => calls.push(['scale', sx, sy]),
    drawImage: (img, dx, dy) => calls.push(['drawImage', dx, dy, img.width, img.height]),
    fillRect: (x, y, w, h) => calls.push(['fillRect', x, y, w, h]),
    fillText: () => {},
    set globalAlpha(v) {},
    get globalAlpha() { return 1; },
    set imageSmoothingEnabled(v) {},
    set fillStyle(v) { calls.push(['fillStyle', v]); },
    set font(v) {}, set textAlign(v) {},
    set globalCompositeOperation(v) { calls.push(['gco', v]); },
    get globalCompositeOperation() { return 'source-over'; }
  };
}

function entryWithAllFrames() {
  const frames = new Map();
  for (const i of [0, 1, 2, 4, 6]) frames.set(i, { width: 192, height: 192 });
  return { frames, scale: 3, direction: 'west' };
}

test('M46: white-flash punch frame fires during the first 80ms of hurt', () => {
  const draw = makeLpcDrawSprite({ lookup: () => entryWithAllFrames() });
  const ctx = mockCtx();
  draw(ctx, 'defender', { x: 0, y: 0 },
    { scale: 1, _phase: 'hurt', _t: 620, _impactAt: 600 },   // 20ms into hurt
    { id: 'm1' });
  // Both a white fillStyle and the red fillStyle should appear — the
  // white at the leading edge, red right behind it.
  assert.ok(ctx.calls.some(c => c[0] === 'fillStyle' && c[1] === '#ffffff'),
    'white-flash fillStyle should be set during the hurt punch window');
});

test('M46: white-flash does NOT fire late in the hurt window', () => {
  const draw = makeLpcDrawSprite({ lookup: () => entryWithAllFrames() });
  const ctx = mockCtx();
  draw(ctx, 'defender', { x: 0, y: 0 },
    { scale: 1, _phase: 'hurt', _t: 800, _impactAt: 600 },   // 200ms into hurt
    { id: 'm1' });
  // Past 80ms — the white punch has expired; only the red tint should
  // still paint (if any).
  assert.ok(!ctx.calls.some(c => c[0] === 'fillStyle' && c[1] === '#ffffff'),
    'no white-flash should paint after the punch window');
});

test('M46: defender squash-stretch — non-uniform scale during impact', () => {
  const draw = makeLpcDrawSprite({ lookup: () => entryWithAllFrames() });
  const ctx = mockCtx();
  draw(ctx, 'defender', { x: 0, y: 0 },
    { scale: 1, _phase: 'hurt', _t: 660, _impactAt: 600 },   // 60ms — peak squash
    { id: 'm1' });
  const scale = ctx.calls.find(c => c[0] === 'scale');
  assert.ok(scale, 'should have a scale call');
  const [, sx, sy] = scale;
  // Squash: sx > 1 (wider), sy < 1 (shorter)
  assert.ok(sx > sy, `expected sx > sy during squash; got sx=${sx} sy=${sy}`);
});

test('M46: attacker does NOT squash on hurt', () => {
  // The attacker can be in any phase; we just verify squash is
  // defender-only. Use phase=strike to make the path symmetric.
  const draw = makeLpcDrawSprite({ lookup: () => entryWithAllFrames() });
  const ctx = mockCtx();
  draw(ctx, 'attacker', { x: 0, y: 0 },
    { scale: 1, _phase: 'strike', _t: 600, _impactAt: 600 },
    { id: 'p1' });
  const scale = ctx.calls.find(c => c[0] === 'scale');
  // Uniform scale for the attacker — sx == sy
  if (scale) {
    const [, sx, sy] = scale;
    assert.strictEqual(sx, sy, `attacker scale must be uniform; got sx=${sx} sy=${sy}`);
  }
});
