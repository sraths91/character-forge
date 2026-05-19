import { test } from 'node:test';
import assert from 'node:assert';
import { createParticleSystem, presetConfig, PRESETS } from '../js/anim/particles.js';

// Deterministic RNG for predictable spawns
function seededRng(seed = 1) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

// ---------- Spawn behaviour ----------

test('M47: spawn adds N particles to the system', () => {
  const sys = createParticleSystem({ rng: seededRng() });
  sys.spawn({ count: 8 }, { x: 100, y: 100 });
  assert.strictEqual(sys.particles.length, 8);
});

test('M47: spawned particles inherit origin (within spread)', () => {
  const sys = createParticleSystem({ rng: seededRng() });
  sys.spawn({ count: 4, spread: 0 }, { x: 50, y: 50 });
  for (const p of sys.particles) {
    assert.strictEqual(p.x, 50);
    assert.strictEqual(p.y, 50);
  }
});

test('M47: spawn with spread distributes particles within radius', () => {
  const sys = createParticleSystem({ rng: seededRng() });
  sys.spawn({ count: 12, spread: 10 }, { x: 0, y: 0 });
  for (const p of sys.particles) {
    const d = Math.hypot(p.x, p.y);
    assert.ok(d <= 10.001, `spread should bound offset distance; got ${d}`);
  }
});

// ---------- Physics integration ----------

test('M47: tick advances position by velocity * dt', () => {
  const sys = createParticleSystem({ rng: seededRng() });
  // Force angle=0 (rightward) and speed=100 by passing both as scalars
  sys.spawn({ count: 1, speed: 100, angle: 0, lifespan: 10000, drag: 1 }, { x: 0, y: 0 });
  const p = sys.particles[0];
  assert.strictEqual(p.vx, 100);
  assert.strictEqual(p.vy, 0);
  sys.tick(0.1);   // 100ms
  assert.ok(Math.abs(p.x - 10) < 0.001, `expected x≈10 after 0.1s; got ${p.x}`);
});

test('M47: gravity accelerates the velocity', () => {
  const sys = createParticleSystem({ rng: seededRng() });
  sys.spawn({ count: 1, speed: 0, angle: 0, lifespan: 10000,
              gravity: { x: 0, y: 100 }, drag: 1 }, { x: 0, y: 0 });
  const p = sys.particles[0];
  assert.strictEqual(p.vy, 0);
  sys.tick(1);
  assert.strictEqual(p.vy, 100);
});

test('M47: drag damps velocity multiplicatively per second', () => {
  const sys = createParticleSystem({ rng: seededRng() });
  sys.spawn({ count: 1, speed: 100, angle: 0, lifespan: 10000, drag: 0.5 }, { x: 0, y: 0 });
  const p = sys.particles[0];
  sys.tick(1);
  // After 1 second with drag=0.5: vx ≈ 100 * 0.5 = 50
  assert.ok(Math.abs(p.vx - 50) < 0.001, `expected vx≈50 after 1s drag; got ${p.vx}`);
});

// ---------- Lifecycle ----------

test('M47: tick decrements life and prunes dead particles', () => {
  const sys = createParticleSystem({ rng: seededRng() });
  sys.spawn({ count: 3, lifespan: 100 }, { x: 0, y: 0 });   // 100ms each
  assert.strictEqual(sys.particles.length, 3);
  sys.tick(0.05);   // 50ms — all alive
  assert.strictEqual(sys.particles.length, 3);
  sys.tick(0.06);   // total 110ms — all dead
  assert.strictEqual(sys.particles.length, 0);
});

test('M47: reset() drops every live particle', () => {
  const sys = createParticleSystem({ rng: seededRng() });
  sys.spawn({ count: 20 }, { x: 0, y: 0 });
  assert.strictEqual(sys.particles.length, 20);
  sys.reset();
  assert.strictEqual(sys.particles.length, 0);
});

// ---------- Presets ----------

test('M47: PRESETS ships the canonical set', () => {
  for (const id of ['smiteSparks', 'rageEmbers', 'shadowMotes',
                    'fireEmbers', 'glowBurst', 'critShards']) {
    assert.ok(PRESETS[id], `missing preset: ${id}`);
    assert.strictEqual(typeof PRESETS[id], 'function');
  }
});

test('M47: presetConfig(id, opts) honours count override', () => {
  const cfg = presetConfig('smiteSparks', { count: 99 });
  assert.strictEqual(cfg.count, 99);
});

test('M47: presetConfig — unknown id returns null', () => {
  assert.strictEqual(presetConfig('not-real'), null);
});

test('M47: smiteSparks emits upward-cone sparks with downward gravity', () => {
  const cfg = PRESETS.smiteSparks();
  assert.strictEqual(cfg.shape, 'spark');
  // Upward cone: angle range falls entirely in the upper half-plane
  assert.ok(cfg.angle.max <= 0, 'smite sparks emit upward (negative Y)');
  assert.ok(cfg.gravity.y > 0, 'gravity pulls sparks down after the rise');
});

test('M47: rageEmbers emit upward with NEGATIVE gravity (keep rising)', () => {
  const cfg = PRESETS.rageEmbers();
  assert.ok(cfg.gravity.y < 0,
    `rage embers should keep rising (negative gravity); got ${cfg.gravity.y}`);
});

test('M47: critShards spin (vrotation range non-zero)', () => {
  const cfg = PRESETS.critShards();
  assert.ok(cfg.vrotation && cfg.vrotation.max > 0,
    'crit shards rotate as they fall');
});

// ---------- Draw is safe to call on a stub ctx ----------

test('M47: draw does not throw on a mock ctx', () => {
  const sys = createParticleSystem({ rng: seededRng() });
  sys.spawn(PRESETS.smiteSparks({ count: 4 }), { x: 50, y: 50 });
  // Minimal ctx mock — captures the calls particles.draw would make
  const calls = [];
  const ctx = {
    save: () => calls.push(['save']),
    restore: () => calls.push(['restore']),
    translate: () => {},
    rotate: () => {},
    fillRect: () => {},
    beginPath: () => {},
    arc: () => {},
    fill: () => {},
    createRadialGradient: () => ({ addColorStop: () => {} }),
    set globalAlpha(_v) {},
    set fillStyle(_v) {},
    set shadowColor(_v) {},
    set shadowBlur(_v) {}
  };
  assert.doesNotThrow(() => sys.draw(ctx));
  // Each particle should pair save + restore
  const saves = calls.filter(c => c[0] === 'save').length;
  const restores = calls.filter(c => c[0] === 'restore').length;
  assert.strictEqual(saves, restores);
  assert.ok(saves >= 1);
});
