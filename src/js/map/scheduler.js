/**
 * M64 E5 / M5 — one requestAnimationFrame loop with a dirty flag.
 *
 * Everything that changes what the battle canvas shows (a state event, a
 * hover, a camera move, an image finishing loading, an animation still
 * playing) calls `markDirty()`. At most one frame is ever queued, and a
 * frame never starts while the previous (possibly async) draw is still
 * running, so renders can no longer interleave on one canvas (the old
 * `rerender()` fired un-awaited async renders back to back).
 *
 * `draw(now)` may return (or resolve to) `true` to ask for another frame
 * (animations, effects or popups still in flight).
 *
 * Node-testable: inject `raf` / `caf`.
 */

/**
 * @param {(now: number) => (boolean|void|Promise<boolean|void>)} draw
 * @param {{raf?: (cb: (t: number) => void) => any, caf?: (handle: any) => void,
 *          onError?: (err: unknown) => void}} [opts]
 * @returns {{markDirty: () => void, stop: () => void, readonly dirty: boolean,
 *            readonly running: boolean, readonly frames: number}}
 */
export function createRenderScheduler(draw, opts = {}) {
  const raf = opts.raf || globalThis.requestAnimationFrame?.bind(globalThis)
    || ((cb) => setTimeout(() => cb(Date.now()), 16));
  const caf = opts.caf || globalThis.cancelAnimationFrame?.bind(globalThis) || clearTimeout;
  const onError = opts.onError || ((err) => {
    console.error(JSON.stringify({ event: 'battle.render.frame_failed', error: String(err?.stack || err) }));
  });
  let dirty = false;
  let handle = null;
  let running = false;
  let stopped = false;
  let frames = 0;

  const schedule = () => {
    if (handle === null && !stopped) handle = raf(tick);
  };

  async function tick(now) {
    handle = null;
    if (stopped || !dirty) return;
    if (running) { schedule(); return; }
    dirty = false;
    running = true;
    try {
      const more = await draw(now);
      frames++;
      if (more) dirty = true;
    } catch (err) {
      onError(err);
    } finally {
      running = false;
    }
    if (dirty) schedule();
  }

  return {
    markDirty() {
      if (stopped) return;
      dirty = true;
      schedule();
    },
    stop() {
      stopped = true;
      if (handle !== null) caf(handle);
      handle = null;
    },
    get dirty() { return dirty; },
    get running() { return running; },
    get frames() { return frames; }
  };
}
