/**
 * Seeded 2D value noise + fractal Brownian motion (fBm).
 *
 * The procedural map generator (map-generator.js) uses this to paint
 * coherent terrain — mottled ground texture, and an elevation/moisture
 * field that biases where features cluster (water in lows, trees in mid
 * bands) so a generated map reads as terrain rather than uniform
 * confetti.
 *
 * Pure + deterministic: the same seed always yields the same field. No
 * DOM, no canvas. The integer hash reuses the mulberry32 bit-mixing
 * already proven in `seedRng` (simulator.js) so the statistical quality
 * matches the rest of the project's RNG.
 *
 * Value noise (not Perlin/simplex) is deliberate: it's a handful of
 * lines, has no patent/lookup-table baggage, and at the coarse tile
 * sizes we paint terrain at (~8-16px) the visual difference is nil.
 */

/**
 * Integer hash → float in [0, 1). Deterministic for a given
 * (seed, x, y). Uses the mulberry32 finalizer so the output is well
 * distributed even for small, adjacent integer inputs.
 *
 * @param {number} seed
 * @param {number} x — integer lattice coordinate
 * @param {number} y — integer lattice coordinate
 * @returns {number} in [0, 1)
 */
export function hash2(seed, x, y) {
  // Fold the three inputs into one 32-bit state. The large odd
  // multipliers decorrelate the axes so (x,y) and (y,x) don't collide.
  let s = (seed >>> 0);
  s = (s + Math.imul(x | 0, 0x27d4eb2d)) >>> 0;
  s = (s + Math.imul(y | 0, 0x165667b1)) >>> 0;
  s = (s + 0x6D2B79F5) >>> 0;
  let t = s;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** Smoothstep — 3t² − 2t³. Eases lattice interpolation so value noise
 *  has no hard grid creases. */
function smooth(t) {
  return t * t * (3 - 2 * t);
}

function lerp(a, b, k) {
  return a + (b - a) * k;
}

/**
 * Build a 2D value-noise sampler for `seed`. The returned function maps
 * any real (x, y) to a smooth value in [0, 1) by bilinearly
 * interpolating hashed lattice corners with a smoothstep ease.
 *
 * @param {number} seed
 * @returns {(x:number, y:number) => number}
 */
export function makeValueNoise2D(seed) {
  const sd = seed >>> 0;
  return function noise2D(x, y) {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const xf = x - xi;
    const yf = y - yi;
    const v00 = hash2(sd, xi,     yi);
    const v10 = hash2(sd, xi + 1, yi);
    const v01 = hash2(sd, xi,     yi + 1);
    const v11 = hash2(sd, xi + 1, yi + 1);
    const u = smooth(xf);
    const v = smooth(yf);
    return lerp(lerp(v00, v10, u), lerp(v01, v11, u), v);
  };
}

/**
 * Fractal Brownian motion — sum several octaves of a noise sampler at
 * doubling frequency and halving amplitude. Produces the natural
 * "clumpy at large scale, detailed at small scale" look terrain needs.
 *
 * Returns a value normalized to [0, 1].
 *
 * @param {(x:number,y:number)=>number} noiseFn — a sampler from makeValueNoise2D
 * @param {number} x
 * @param {number} y
 * @param {object} [opts]
 * @param {number} [opts.octaves=4]
 * @param {number} [opts.frequency=1]   — base frequency (lattice scale)
 * @param {number} [opts.persistence=0.5] — amplitude falloff per octave
 * @param {number} [opts.lacunarity=2]   — frequency growth per octave
 * @returns {number} in [0, 1]
 */
export function fbm2D(noiseFn, x, y, opts = {}) {
  const {
    octaves = 4,
    frequency = 1,
    persistence = 0.5,
    lacunarity = 2
  } = opts;
  let freq = frequency;
  let amp = 1;
  let sum = 0;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += amp * noiseFn(x * freq, y * freq);
    norm += amp;
    amp *= persistence;
    freq *= lacunarity;
  }
  return norm > 0 ? sum / norm : 0;
}

/**
 * Ridged fBm — folds each octave around its midpoint (`1 - |2n-1|`) so
 * ridges form sharp crests. Used to bias river channels toward natural
 * valley lines and to give rocky highlands a veined look.
 *
 * @returns {number} in [0, 1]
 */
export function ridgedFbm2D(noiseFn, x, y, opts = {}) {
  const {
    octaves = 4,
    frequency = 1,
    persistence = 0.5,
    lacunarity = 2
  } = opts;
  let freq = frequency;
  let amp = 1;
  let sum = 0;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    const n = noiseFn(x * freq, y * freq);
    const ridge = 1 - Math.abs(2 * n - 1);   // crease at n=0.5 → 1
    sum += amp * ridge;
    norm += amp;
    amp *= persistence;
    freq *= lacunarity;
  }
  return norm > 0 ? sum / norm : 0;
}

/**
 * Domain warp — perturb the sample coordinates by a second noise field
 * before sampling, so region boundaries meander organically instead of
 * following the noise lattice. `strength` is in the same units as the
 * input coordinates (cells).
 *
 * Returns warped { x, y } to feed into another sampler.
 *
 * @param {(x:number,y:number)=>number} warpFn — a sampler (its own seed)
 * @param {number} x
 * @param {number} y
 * @param {object} [opts]
 * @param {number} [opts.strength=1.5]
 * @param {number} [opts.frequency=0.5]
 * @returns {{x:number, y:number}}
 */
export function domainWarp(warpFn, x, y, opts = {}) {
  const { strength = 1.5, frequency = 0.5 } = opts;
  // Two offset samples decorrelate the x and y perturbations.
  const wx = warpFn(x * frequency, y * frequency) - 0.5;
  const wy = warpFn((x + 31.7) * frequency, (y + 11.3) * frequency) - 0.5;
  return { x: x + wx * 2 * strength, y: y + wy * 2 * strength };
}
