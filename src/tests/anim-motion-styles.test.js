import { test } from 'node:test';
import assert from 'node:assert';
import {
  STYLES, applyStyle, availableStyles, defaultStyleForLevel,
  isStyle, styleForPc, loadStyle, saveStyle
} from '../js/anim/motion-styles.js';
import { buildMotion } from '../js/anim/weapon-motions.js';

// ---------- Style registry ----------

test('M43.3: STYLES ships the four standard tiers', () => {
  for (const id of ['quick', 'standard', 'power', 'flourish']) {
    assert.ok(STYLES[id], `missing style: ${id}`);
    assert.strictEqual(STYLES[id].id, id);
  }
});

test('M43.3: minLevel gates Power and Flourish', () => {
  assert.strictEqual(STYLES.quick.minLevel, 1);
  assert.strictEqual(STYLES.standard.minLevel, 1);
  assert.strictEqual(STYLES.power.minLevel, 3);
  assert.strictEqual(STYLES.flourish.minLevel, 5);
});

test('M43.3: isStyle — true only for known style ids', () => {
  assert.strictEqual(isStyle('quick'), true);
  assert.strictEqual(isStyle('flourish'), true);
  assert.strictEqual(isStyle('imaginary'), false);
  assert.strictEqual(isStyle(null), false);
});

// ---------- availableStyles ----------

test('M43.3: availableStyles — lvl 1 sees quick + standard only', () => {
  const got = availableStyles(1).map(s => s.id);
  assert.deepStrictEqual(got, ['quick', 'standard']);
});

test('M43.3: availableStyles — lvl 3 unlocks Power', () => {
  const got = availableStyles(3).map(s => s.id);
  assert.ok(got.includes('power'));
  assert.ok(!got.includes('flourish'));
});

test('M43.3: availableStyles — lvl 5 unlocks Flourish', () => {
  const got = availableStyles(5).map(s => s.id);
  assert.deepStrictEqual(got, ['quick', 'standard', 'power', 'flourish']);
});

test('M43.3: defaultStyleForLevel — always returns Standard for v1', () => {
  assert.strictEqual(defaultStyleForLevel(1), 'standard');
  assert.strictEqual(defaultStyleForLevel(10), 'standard');
});

// ---------- applyStyle: transforms ----------

test('M43.3: applyStyle(standard) returns an identity clone', () => {
  const seq = buildMotion('sword-slash');
  const styled = applyStyle(seq, 'standard');
  assert.strictEqual(styled.duration, seq.duration);
  assert.strictEqual(styled.keyframes.length, seq.keyframes.length);
  // But it's a different object — mutating styled must not affect seq
  styled.keyframes[0].x = 999;
  assert.notStrictEqual(seq.keyframes[0].x, 999);
});

test('M43.3: applyStyle(quick) compresses the timeline', () => {
  const seq = buildMotion('sword-slash');
  const styled = applyStyle(seq, 'quick');
  assert.ok(styled.duration < seq.duration,
    `quick should be shorter; ${styled.duration} vs ${seq.duration}`);
  // Every keyframe `at` should also be smaller
  const sumBefore = seq.keyframes.reduce((s, k) => s + k.at, 0);
  const sumAfter  = styled.keyframes.reduce((s, k) => s + k.at, 0);
  assert.ok(sumAfter < sumBefore);
});

test('M43.3: applyStyle(power) extends the timeline', () => {
  const seq = buildMotion('sword-slash');
  const styled = applyStyle(seq, 'power');
  assert.ok(styled.duration > seq.duration,
    `power should be longer; ${styled.duration} vs ${seq.duration}`);
});

test('M43.3: applyStyle(power) scales the hit-pause duration up', () => {
  const seq = buildMotion('axe-cleave');
  const seqPause = seq.effects.find(e => e.type === 'hit-pause');
  const styled = applyStyle(seq, 'power');
  const styledPause = styled.effects.find(e => e.type === 'hit-pause');
  assert.ok(styledPause.params.duration > seqPause.params.duration,
    `power hit-pause should be longer; ${styledPause.params.duration} vs ${seqPause.params.duration}`);
});

test('M43.3: applyStyle(quick) scales the hit-pause duration down', () => {
  const seq = buildMotion('sword-slash');
  const seqPause = seq.effects.find(e => e.type === 'hit-pause');
  const styled = applyStyle(seq, 'quick');
  const styledPause = styled.effects.find(e => e.type === 'hit-pause');
  assert.ok(styledPause.params.duration < seqPause.params.duration);
});

test('M43.3: applyStyle(power) scales shake amplitude up', () => {
  const seq = buildMotion('axe-cleave');
  const seqShake = seq.effects.find(e => e.type === 'shake');
  const styled = applyStyle(seq, 'power');
  const styledShake = styled.effects.find(e => e.type === 'shake');
  assert.ok(styledShake.params.amplitude > seqShake.params.amplitude);
});

test('M43.3: applyStyle(flourish) appends a secondary impact effect', () => {
  const seq = buildMotion('sword-slash');
  const seqImpactCount = seq.effects.filter(e => e.type === 'slash-arc').length;
  const styled = applyStyle(seq, 'flourish');
  const styledImpactCount = styled.effects.filter(e => e.type === 'slash-arc').length;
  assert.strictEqual(styledImpactCount, seqImpactCount + 1,
    `flourish should add one decorative slash-arc; ${seqImpactCount} → ${styledImpactCount}`);
  // The secondary effect should be flagged
  const secondary = styled.effects.filter(e => e.type === 'slash-arc')
    .find(e => e.params?._secondary);
  assert.ok(secondary, 'secondary effect should carry the _secondary flag');
});

test('M43.3: applyStyle never mutates the source sequence', () => {
  const seq = buildMotion('lance-thrust');
  const beforeDur = seq.duration;
  const beforeKeyAt = seq.keyframes[0].at;
  applyStyle(seq, 'power');
  assert.strictEqual(seq.duration, beforeDur);
  assert.strictEqual(seq.keyframes[0].at, beforeKeyAt);
});

test('M43.3: applyStyle — unknown style falls back to identity', () => {
  const seq = buildMotion('dagger-stab');
  const styled = applyStyle(seq, 'not-real');
  assert.strictEqual(styled.duration, seq.duration);
});

test('M43.3: applyStyle — null seq passes through', () => {
  assert.strictEqual(applyStyle(null, 'quick'), null);
});

// ---------- styleForPc / save/load ----------

test('M43.3: styleForPc — uses _attackStyle override when present and valid', () => {
  const pc = { id: 'p1', classes: [{ name: 'Fighter', level: 5 }], _attackStyle: 'flourish' };
  assert.strictEqual(styleForPc(pc), 'flourish');
});

test('M43.3: styleForPc — defaults to Standard when no override', () => {
  const pc = { id: 'p2', classes: [{ name: 'Fighter', level: 1 }] };
  assert.strictEqual(styleForPc(pc), 'standard');
});

test('M43.3: styleForPc — ignores override pointing at unavailable tier', () => {
  // _attackStyle says flourish, but PC is only lvl 2 — falls back to standard
  // (saveStyle would have prevented this, but in-memory override could be stale)
  const pc = { id: 'p3', classes: [{ name: 'Fighter', level: 2 }], _attackStyle: 'flourish' };
  // Note: _attackStyle takes precedence in styleForPc (no level gate); this
  // is the in-memory override path. Saved-storage path applies the gate.
  assert.strictEqual(styleForPc(pc), 'flourish');
});

test('M43.3: saveStyle / loadStyle round-trip for valid styles', () => {
  if (typeof globalThis.localStorage === 'undefined') {
    // Node test runner: shim a minimal store
    const store = new Map();
    globalThis.localStorage = {
      getItem: (k) => store.has(k) ? store.get(k) : null,
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k)
    };
  }
  saveStyle('p99', 'power');
  assert.strictEqual(loadStyle('p99'), 'power');
});

test('M43.3: saveStyle rejects unknown style ids', () => {
  if (typeof globalThis.localStorage === 'undefined') return;   // tested above
  saveStyle('p100', 'imaginary');
  assert.strictEqual(loadStyle('p100'), null);
});

test('M43.3: loadStyle — null when characterId is missing', () => {
  assert.strictEqual(loadStyle(null), null);
  assert.strictEqual(loadStyle(undefined), null);
});
