/**
 * M47 — Particle system.
 *
 * A small, pure, dependency-free emitter that replaces the one-shot
 * `burst` / `sparkle` effect primitives with real spawn-tick-decay
 * particles. Each particle owns its own velocity, acceleration,
 * lifespan, and visual state; the system steps them via Euler
 * integration each frame and prunes dead ones.
 *
 * Scope: the smallest module that supports the three particle shapes
 * the cinema actually needs —
 *
 *   sparks  — small bright dots, optional gravity, drag, short-lived
 *   smoke   — larger soft circles, drift upward, expand + fade
 *   shards  — small rotating rectangles with gravity (debris)
 *
 * Composable shaper config (mirrors Phaser's emitter shape so the
 * mental model carries over) — each field can be a scalar or a
 * `{ min, max }` range that's sampled per particle at spawn.
 *
 * Pure / deterministic when rng is injected; safe for tests.
 */

const TAU = Math.PI * 2;

/**
 * @typedef {object} EmitterConfig
 * @property {string}  [shape='spark']     — 'spark' | 'smoke' | 'shard'
 * @property {number}  [count=12]          — particles per spawn call
 * @property {number|{min,max}} [spread=0] — px of random radial offset around origin
 * @property {number|{min,max}} [speed=80] — initial velocity magnitude
 * @property {number|{min,max}} [angle]    — emission angle (radians). Default: full circle.
 * @property {{x,y}}   [gravity={x:0,y:0}] — acceleration (px/s²) applied to every particle
 * @property {number}  [drag=1]            — multiplicative velocity damping per second (1 = no drag)
 * @property {number|{min,max}} [lifespan=600] — ms each particle lives
 * @property {number|{min,max}} [sizeStart=4]
 * @property {number}  [sizeEnd=0]         — interpolated by life fraction
 * @property {string|string[]}  [color='#ffffff']
 * @property {number}  [alphaStart=1]
 * @property {number}  [alphaEnd=0]
 * @property {number|{min,max}} [rotation=0]    — initial rotation (radians)
 * @property {number|{min,max}} [vrotation=0]   — rotation velocity (radians/s)
 */

/**
 * Create an empty particle system.
 *
 * Returns a controller with:
 *   spawn(config, origin)  → push N new particles
 *   tick(dt)               → advance all particles by dt seconds, prune dead
 *   draw(ctx)              → render every live particle
 *   particles              → readonly array of live particles
 *   reset()                → drop every live particle
 *
 * `rng` defaults to Math.random; tests inject a deterministic source.
 */
export function createParticleSystem({ rng = Math.random } = {}) {
  const particles = [];

  function spawn(config = {}, origin = { x: 0, y: 0 }) {
    const n = config.count ?? 12;
    for (let i = 0; i < n; i++) {
      particles.push(makeParticle(config, origin, rng));
    }
  }

  function tick(dt) {
    // dt in SECONDS — caller converts from ms.
    const drag = 1;   // default if config didn't set it
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.life -= dt;
      if (p.life <= 0) {
        particles.splice(i, 1);
        continue;
      }
      // Apply drag (multiplicative per second). p.drag set at spawn.
      const k = p.drag !== undefined ? Math.pow(p.drag, dt) : Math.pow(drag, dt);
      p.vx *= k;
      p.vy *= k;
      // Apply acceleration
      p.vx += p.ax * dt;
      p.vy += p.ay * dt;
      // Integrate position
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      // Integrate rotation
      p.rotation += p.vrotation * dt;
    }
  }

  function draw(ctx) {
    for (const p of particles) {
      drawParticle(ctx, p);
    }
  }

  function reset() { particles.length = 0; }

  return { spawn, tick, draw, particles, reset };
}

/* =====================================================================
 * Particle construction
 * ===================================================================== */

function makeParticle(cfg, origin, rng) {
  const shape    = cfg.shape || 'spark';
  const speed    = sample(cfg.speed ?? 80, rng);
  const angle    = sample(cfg.angle ?? { min: 0, max: TAU }, rng);
  const spread   = sample(cfg.spread ?? 0, rng);
  const spreadA  = rng() * TAU;
  const lifespan = (sample(cfg.lifespan ?? 600, rng)) / 1000;   // s
  const sizeStart = sample(cfg.sizeStart ?? 4, rng);
  const sizeEnd   = cfg.sizeEnd ?? 0;
  const colorPick = pickColor(cfg.color ?? '#ffffff', rng);
  const alphaStart = cfg.alphaStart ?? 1;
  const alphaEnd   = cfg.alphaEnd ?? 0;
  const rotation   = sample(cfg.rotation ?? 0, rng);
  const vrotation  = sample(cfg.vrotation ?? 0, rng);
  const gravity    = cfg.gravity || { x: 0, y: 0 };
  const drag       = cfg.drag ?? 1;

  return {
    shape,
    x: origin.x + Math.cos(spreadA) * spread,
    y: origin.y + Math.sin(spreadA) * spread,
    vx: Math.cos(angle) * speed,
    vy: Math.sin(angle) * speed,
    ax: gravity.x,
    ay: gravity.y,
    drag,
    life: lifespan,
    maxLife: lifespan,
    sizeStart, sizeEnd,
    alphaStart, alphaEnd,
    color: colorPick,
    rotation, vrotation
  };
}

/** Sample a scalar from either a number or { min, max } range. */
function sample(spec, rng) {
  if (typeof spec === 'number') return spec;
  if (spec && Number.isFinite(spec.min) && Number.isFinite(spec.max)) {
    return spec.min + rng() * (spec.max - spec.min);
  }
  return 0;
}

function pickColor(spec, rng) {
  if (Array.isArray(spec) && spec.length > 0) {
    return spec[Math.floor(rng() * spec.length)];
  }
  return typeof spec === 'string' ? spec : '#ffffff';
}

/* =====================================================================
 * Per-shape draw routines
 * ===================================================================== */

function drawParticle(ctx, p) {
  const u = 1 - p.life / p.maxLife;
  const size = p.sizeStart + (p.sizeEnd - p.sizeStart) * u;
  const alpha = p.alphaStart + (p.alphaEnd - p.alphaStart) * u;
  if (alpha <= 0.01 || size <= 0.1) return;
  ctx.save();
  ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
  ctx.translate(p.x, p.y);
  ctx.rotate(p.rotation);
  if (p.shape === 'smoke') {
    drawSmoke(ctx, size, p.color);
  } else if (p.shape === 'shard') {
    drawShard(ctx, size, p.color);
  } else {
    drawSpark(ctx, size, p.color);
  }
  ctx.restore();
}

function drawSpark(ctx, size, color) {
  ctx.fillStyle = color;
  ctx.shadowColor = color;
  ctx.shadowBlur = size * 2;
  ctx.beginPath();
  ctx.arc(0, 0, size, 0, TAU);
  ctx.fill();
}

function drawSmoke(ctx, size, color) {
  // Soft circle — no shadow, slightly darker outer edge for puff feel.
  const grad = ctx.createRadialGradient(0, 0, size * 0.1, 0, 0, size);
  grad.addColorStop(0, color);
  grad.addColorStop(1, hexWithAlpha(color, 0));
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(0, 0, size, 0, TAU);
  ctx.fill();
}

function drawShard(ctx, size, color) {
  // Small rotating rectangle, narrow.
  ctx.fillStyle = color;
  ctx.shadowColor = color;
  ctx.shadowBlur = size;
  ctx.fillRect(-size, -size * 0.3, size * 2, size * 0.6);
}

function hexWithAlpha(hex, a) {
  const m = String(hex).match(/^#([0-9a-f]{6})$/i);
  if (!m) return `rgba(255,255,255,${a})`;
  const v = parseInt(m[1], 16);
  const r = (v >> 16) & 0xff, g = (v >> 8) & 0xff, b = v & 0xff;
  return `rgba(${r},${g},${b},${a})`;
}

/* =====================================================================
 * Built-in emitter presets — name + config factory
 *
 * Each preset takes an `opts` bag of overrides so a caller can scale
 * count / colour / origin to the specific moment in combat. The
 * defaults are tuned for "looks right at the cinema's pixel scale".
 * ===================================================================== */

export const PRESETS = {
  /** Bright ascending sparks — radiant burst (Smite, holy crit). */
  smiteSparks: (opts = {}) => ({
    shape: 'spark',
    count: opts.count ?? 18,
    spread: 6,
    speed: { min: 40, max: 120 },
    angle: { min: -Math.PI * 0.75, max: -Math.PI * 0.25 },   // upward cone
    gravity: { x: 0, y: 90 },   // gentle pull-down after the rise
    drag: 0.4,
    lifespan: { min: 500, max: 900 },
    sizeStart: 3, sizeEnd: 0.5,
    color: opts.color ?? ['#fef3c7', '#fde047', '#fbbf24'],
    alphaStart: 1, alphaEnd: 0
  }),

  /** Rising red embers — Rage modifier. */
  rageEmbers: (opts = {}) => ({
    shape: 'spark',
    count: opts.count ?? 14,
    spread: 18,
    speed: { min: 30, max: 80 },
    angle: { min: -Math.PI * 0.7, max: -Math.PI * 0.3 },     // upward cone
    gravity: { x: 0, y: -40 },   // KEEP rising
    drag: 0.6,
    lifespan: { min: 700, max: 1200 },
    sizeStart: 2.5, sizeEnd: 0.5,
    color: ['#ef4444', '#f87171', '#dc2626'],
    alphaStart: 0.95, alphaEnd: 0
  }),

  /** Dark shadow motes — Sneak Attack. */
  shadowMotes: (opts = {}) => ({
    shape: 'smoke',
    count: opts.count ?? 10,
    spread: 12,
    speed: { min: 20, max: 60 },
    angle: { min: 0, max: TAU },     // omni
    gravity: { x: 0, y: 0 },
    drag: 0.3,
    lifespan: { min: 400, max: 700 },
    sizeStart: 6, sizeEnd: 14,
    color: ['#312e81', '#1e1b4b', '#0f172a'],
    alphaStart: 0.7, alphaEnd: 0
  }),

  /** Radiating fire embers — fireball burst, damage spells. */
  fireEmbers: (opts = {}) => ({
    shape: 'spark',
    count: opts.count ?? 22,
    spread: 4,
    speed: { min: 60, max: 160 },
    angle: { min: 0, max: TAU },
    gravity: { x: 0, y: 220 },     // strong pull-down — fire arcs
    drag: 0.5,
    lifespan: { min: 400, max: 700 },
    sizeStart: 3, sizeEnd: 0,
    color: ['#fbbf24', '#f97316', '#dc2626'],
    alphaStart: 1, alphaEnd: 0
  }),

  /** Crisp white glow puff — generic impact emphasis. */
  glowBurst: (opts = {}) => ({
    shape: 'smoke',
    count: opts.count ?? 6,
    spread: 4,
    speed: { min: 10, max: 40 },
    angle: { min: 0, max: TAU },
    gravity: { x: 0, y: 0 },
    drag: 0.3,
    lifespan: { min: 240, max: 380 },
    sizeStart: 10, sizeEnd: 24,
    color: opts.color ?? '#ffffff',
    alphaStart: 0.55, alphaEnd: 0
  }),

  /** Stone / metal shards — crit hit emphasis. */
  critShards: (opts = {}) => ({
    shape: 'shard',
    count: opts.count ?? 9,
    spread: 2,
    speed: { min: 80, max: 220 },
    angle: { min: 0, max: TAU },
    gravity: { x: 0, y: 320 },
    drag: 0.5,
    lifespan: { min: 350, max: 600 },
    sizeStart: 3, sizeEnd: 1,
    color: opts.color ?? ['#cbd5e1', '#94a3b8', '#e2e8f0'],
    alphaStart: 1, alphaEnd: 0,
    rotation: { min: 0, max: TAU },
    vrotation: { min: -10, max: 10 }
  })
};

/** Resolve a preset by id and apply caller overrides. */
export function presetConfig(id, opts = {}) {
  const fn = PRESETS[id];
  if (!fn) return null;
  return fn(opts);
}
