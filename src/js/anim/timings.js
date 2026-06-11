/**
 * M56 Phase 1 — Shared animation phase timings.
 *
 * The cinema's phase boundaries used to be duplicated as bare
 * literals in four places (fsm.js classifiers, fsm.js phase-start
 * lookup, cinema.js's mirrored classifiers, and the hurt window in
 * cinema-sprites.js). One drifting copy would desynchronize the
 * sprite frame picker from the FSM. They live here now; every
 * consumer imports the same values.
 *
 * All times are milliseconds relative to a sequence's impact moment
 * (the primary hit-pause), except the standalone periods at the
 * bottom.
 *
 *   t < impact - WINDUP_LEAD_MS                  → idle
 *   impact - WINDUP_LEAD_MS ≤ t < -STRIKE_LEAD   → windup
 *   -STRIKE_LEAD ≤ t < impact + STRIKE_TAIL      → strike
 *   t ≥ impact + STRIKE_TAIL                     → recover
 *
 * Defender: hurt for HURT_TAIL_MS after impact, then idle.
 */

/** Attacker enters windup this long before impact. */
export const WINDUP_LEAD_MS = 350;

/** Windup hands off to strike this long before impact. */
export const STRIKE_LEAD_MS = 100;

/** Strike (impact + immediate follow-through) holds this long after impact. */
export const STRIKE_TAIL_MS = 180;

/** Defender's hurt flinch lasts this long after impact. */
export const HURT_TAIL_MS = 220;

/** Cross-fade window at the start of each new pose (~5 frames at 60fps). */
export const FADE_MS = 80;

/** Idle bob period — alternation between the two idle poses. */
export const IDLE_BOB_MS = 280;
