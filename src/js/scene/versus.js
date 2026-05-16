/**
 * M28 — 1v1 Versus mode.
 *
 * Pure helpers that drive the dedicated arena: scene factory, end-state
 * detection, and the auto-fight tick loop. The UI sits in main.js;
 * everything stateful here is passed in via context so tests can run
 * deterministically.
 *
 * Three sim modes are supported (chosen by the caller):
 *   - 'roll'    — interactive: user clicks Attack as usual. We just
 *                 set up the arena; runAttackPrompt does the rest.
 *   - 'auto'    — auto-fight: runs the same resolver, paced by the
 *                 caller's rAF/timer driver. One side acts per tick.
 *   - 'quick'   — Monte Carlo via M20 simulator, no animation. The
 *                 result panel renders win rate + avg rounds.
 *
 * Pure module. No DOM. The caller wires real timers (setTimeout for
 * auto-fight pacing) and DOM updates externally.
 */

/**
 * Build a small ephemeral arena scene: 5×3 grid, PC at col 1, monster
 * at col 3. Returns a scene record compatible with the existing
 * compositor + resolver.
 *
 * No persistence — the caller assigns this to currentScene in memory
 * only; the user's own cf_scenes container is untouched.
 */
export function buildArenaScene({ pcId, monsterInstance, flankingEnabled = false } = {}) {
  return {
    cols: 5,
    rows: 3,
    cellSize: 64,
    scale: 3,
    map: { kind: 'color', color: '#2a2a2e' },
    grid: { visible: true, snap: true, color: 'rgba(255,255,255,0.18)' },
    positions: pcId ? { [String(pcId)]: { col: 1, row: 1 } } : {},
    monsters: monsterInstance
      ? [{ ...monsterInstance, position: { col: 3, row: 1 } }]
      : [],
    initiative: [],
    flankingEnabled
  };
}

/**
 * End-state check: returns 'pc-wins' | 'monster-wins' | 'draw' | null
 * (combat ongoing). A side is considered defeated when every non-
 * incapacitated entity is at 0 HP.
 */
export function endStateOf({ partyHp, monsterHp }) {
  const pcDown = partyHp <= 0;
  const monDown = monsterHp <= 0;
  if (pcDown && monDown) return 'draw';
  if (pcDown) return 'monster-wins';
  if (monDown) return 'pc-wins';
  return null;
}

/**
 * Initial turn order. v1 — PC always goes first. (DEX-modded initiative
 * is a follow-on polish; this is the "test your character" mode.)
 */
export function initialTurn() {
  return 'pc';
}

/**
 * Toggle whose turn it is. Used by the auto-fight loop between ticks.
 */
export function nextTurn(turn) {
  return turn === 'pc' ? 'monster' : 'pc';
}

/**
 * Sanity-check inputs for `buildArenaScene`. Returns null if valid,
 * otherwise a human-readable reason. Used by the UI to surface "pick
 * a PC first" / "pick a monster first" messages cleanly.
 */
export function validateArenaInputs({ pcId, monsterPresetSlug, monsterPresets } = {}) {
  if (!pcId) return 'Pick a character first.';
  if (!monsterPresetSlug) return 'Pick an opponent monster.';
  if (monsterPresets && !monsterPresets[monsterPresetSlug]) {
    return `Unknown monster preset: ${monsterPresetSlug}`;
  }
  return null;
}
