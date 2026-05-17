/**
 * M36 — Fight recorder.
 *
 * Captures structured events from a combat (versus auto-fight or manual
 * play) so the user can review what happened. Pure module: no DOM, no
 * timers. The caller decides when to record() each event; the recorder
 * just maintains the events array and supplies query helpers.
 *
 * Event shape:
 *   {
 *     id:        number,           // monotonic per-replay id
 *     type:      string,           // 'attack' | 'reaction' | 'spell' | 'death' | 'round' | 'end'
 *     round:     number,           // 1-indexed
 *     actorId:   string|null,
 *     actorName: string,
 *     targetId:  string|null,
 *     targetName?: string,
 *     summary:   string,           // human-readable one-liner for the timeline
 *     detail:    object,           // type-specific payload (damage, dice, save, etc.)
 *     ts:        number            // Date.now() at record time
 *   }
 *
 * Replay shape (what `getReplay()` returns):
 *   {
 *     id:        string,           // unique replay id
 *     startedAt: number,
 *     endedAt:   number|null,
 *     outcome:   string|null,      // 'party-wins' | 'monsters-win' | 'draw' | null while running
 *     rounds:    number,
 *     events:    Event[],
 *     participants: [{ id, name, kind, hpMax }]
 *   }
 */

const EVENT_TYPES = new Set(['attack', 'reaction', 'spell', 'heal', 'death', 'round', 'end', 'note']);

let nextReplayId = 1;

/**
 * Build a fresh recorder. Each fight allocates its own; recorders are
 * tiny and disposable.
 */
export function createRecorder({ participants = [] } = {}) {
  let nextEventId = 1;
  let recording = false;
  let currentRound = 0;
  const replay = {
    id: `r${nextReplayId++}`,
    startedAt: Date.now(),
    endedAt: null,
    outcome: null,
    rounds: 0,
    events: [],
    participants: participants.map(p => ({
      id: String(p.id), name: p.name || '?', kind: p.kind || 'pc',
      hpMax: p.hpMax ?? p.hp?.max ?? 0
    }))
  };

  return {
    /** Start recording. Idempotent. */
    start() { recording = true; },

    /** Stop recording. Caller usually follows with finalize(). */
    stop() { recording = false; },

    isRecording: () => recording,

    /** Mark the start of a new round. Recorder bumps the round counter. */
    setRound(round) {
      currentRound = round;
      if (round > replay.rounds) replay.rounds = round;
      if (recording) {
        replay.events.push({
          id: nextEventId++,
          type: 'round',
          round, actorId: null, actorName: '—',
          targetId: null,
          summary: `— Round ${round} —`,
          detail: {},
          ts: Date.now()
        });
      }
    },

    /**
     * Append an event. Validates the type, fills in defaults, returns
     * the created event id (so callers can correlate UI highlights).
     */
    record(event) {
      if (!recording) return null;
      const type = event?.type;
      if (!EVENT_TYPES.has(type)) return null;
      const e = {
        id: nextEventId++,
        type,
        round: Number.isFinite(event.round) ? event.round : currentRound,
        actorId: event.actorId ?? null,
        actorName: event.actorName || '?',
        targetId: event.targetId ?? null,
        targetName: event.targetName,
        summary: event.summary || '',
        detail: event.detail || {},
        ts: Date.now()
      };
      replay.events.push(e);
      return e.id;
    },

    /** Wrap up the recording with an outcome marker. */
    finalize(outcome) {
      replay.endedAt = Date.now();
      replay.outcome = outcome || null;
      replay.events.push({
        id: nextEventId++,
        type: 'end',
        round: currentRound,
        actorId: null, actorName: '—', targetId: null,
        summary: outcome ? endOutcomeLabel(outcome) : 'Fight ended',
        detail: { outcome },
        ts: Date.now()
      });
      recording = false;
    },

    /** Read-only access to the in-progress / completed replay. */
    getReplay() { return replay; }
  };
}

function endOutcomeLabel(outcome) {
  if (outcome === 'party-wins' || outcome === 'pc-wins') return '🏆 Party wins';
  if (outcome === 'monsters-win' || outcome === 'monster-wins') return '💀 Monsters win';
  if (outcome === 'draw') return 'Stalemate';
  return 'Fight ended';
}

// =====================================================================
// Replay history — keeps the most recent N replays in memory so the UI
// can list them and switch between them without re-running the fight.
// =====================================================================

const HISTORY_LIMIT = 5;
const history = [];

/** Push a finished replay into the in-memory history (newest first). */
export function archiveReplay(replay) {
  if (!replay || !replay.endedAt) return;
  history.unshift(replay);
  while (history.length > HISTORY_LIMIT) history.pop();
}

/** Return a shallow copy of the history list (newest first). */
export function listReplays() { return history.slice(); }

/** Look up a replay by id. */
export function getReplayById(id) { return history.find(r => r.id === id) || null; }

/** Wipe history (used by tests). */
export function clearReplays() { history.length = 0; }

// =====================================================================
// Filtering / summary helpers
// =====================================================================

const FILTERABLE_TYPES = ['attack', 'reaction', 'spell', 'heal', 'death'];

export function filterEvents(replay, types = null) {
  if (!replay?.events) return [];
  if (!types || types.length === 0) return replay.events.slice();
  const set = new Set(types);
  return replay.events.filter(e => set.has(e.type) || e.type === 'round' || e.type === 'end');
}

/** Counts events by type for the timeline summary. */
export function summarizeReplay(replay) {
  const counts = {};
  for (const t of FILTERABLE_TYPES) counts[t] = 0;
  for (const e of (replay?.events || [])) {
    if (FILTERABLE_TYPES.includes(e.type)) counts[e.type]++;
  }
  return counts;
}
