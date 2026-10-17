// Encounter persistence (M64 B8): the SQLite journal a Room writes through.
//
// Per engine step the room calls `flush()`: the step's events, the room
// seq, the in-flight turn's prompt answers and — at turn end — the
// snapshot are written in ONE transaction, and only then broadcast.
// Boot recovery (`loadLive`) hands a room its last snapshot plus the
// events and answers logged since, and the room re-runs the interrupted
// turn through the engine port with the snapshot's RNG state; the logged
// answers stand in for the players, so the replay reproduces the log and
// continues live from where it stopped.
//
// The PC sheets an encounter was built with are written once, at setup
// (encounters.sheets_json, migration 0003), and read back by the engine's
// sheet resolver after a restart. They never leave the server.
//
// Statements are prepared once. Write times are sampled; the p99 is
// logged every `reportEvery` flushes with a warning above `budgetMs`
// (5 ms on Railway's volume).

/** Events returned as `history` for snapshots. */
export const RECOVERY_HISTORY = 50;
/** Write-time budget (p99) per flush, in ms. */
export const WRITE_BUDGET_MS = 5;

/**
 * @param {object} o
 * @param {import('better-sqlite3').Database} o.db  migrated connection (>= 0003)
 * @param {(level: string, msg: string, extra?: object) => void} [o.log]
 * @param {() => number} [o.now=Date.now]
 * @param {number} [o.budgetMs=WRITE_BUDGET_MS]
 * @param {number} [o.reportEvery=500]   flushes between p99 reports
 * @param {() => number} [o.clock]       high-resolution ms clock (tests)
 */
export function createSqliteJournal({
  db, log = () => {}, now = Date.now, budgetMs = WRITE_BUDGET_MS, reportEvery = 500,
  clock = () => performance.now()
}) {
  const q = {
    insertEncounter: db.prepare(`
      INSERT INTO encounters (id, room_id, status, engine_version, snapshot_json, sheets_json, snapshot_seq, head_seq, created_at, updated_at)
      VALUES (?, ?, 'setup', ?, ?, ?, 0, 0, ?, ?)`),
    sheets: db.prepare('SELECT sheets_json FROM encounters WHERE id = ?'),
    setStatus: db.prepare(`
      UPDATE encounters SET status = ?, outcome = COALESCE(?, outcome), updated_at = ?,
        ended_at = CASE WHEN ? IN ('ended', 'abandoned') THEN ? ELSE ended_at END
      WHERE id = ?`),
    insertEvent: db.prepare('INSERT INTO encounter_events (encounter_id, seq, type, event_json, created_at) VALUES (?, ?, ?, ?, ?)'),
    step: db.prepare(`
      UPDATE encounters SET head_seq = MAX(head_seq, ?), turn_log_json = ?, updated_at = ?
      WHERE id = ?`),
    snapshot: db.prepare(`
      UPDATE encounters SET snapshot_json = ?, snapshot_seq = ?, head_seq = MAX(head_seq, ?), turn_log_json = NULL, updated_at = ?
      WHERE id = ?`),
    roomSeq: db.prepare('UPDATE rooms SET seq = ?, last_active_at = ? WHERE id = ? AND seq < ?'),
    live: db.prepare("SELECT * FROM encounters WHERE room_id = ? AND status IN ('setup', 'active')"),
    liveRooms: db.prepare("SELECT DISTINCT room_id FROM encounters WHERE status IN ('setup', 'active')"),
    tail: db.prepare('SELECT event_json FROM encounter_events WHERE encounter_id = ? AND seq > ? ORDER BY seq'),
    recent: db.prepare('SELECT event_json FROM encounter_events WHERE encounter_id = ? ORDER BY seq DESC LIMIT ?')
  };

  const samples = [];
  let flushes = 0;

  function record(ms) {
    samples.push(ms);
    if (samples.length > 1000) samples.shift();
    flushes++;
    if (flushes % reportEvery === 0) {
      const p99 = percentile(samples, 0.99);
      const level = p99 > budgetMs ? 'warn' : 'info';
      log(level, 'persistence: write time', { p99Ms: round(p99), p50Ms: round(percentile(samples, 0.5)), flushes, budgetMs, overBudget: p99 > budgetMs });
    }
  }

  const flushTx = db.transaction((o, t) => {
    for (const ev of o.events) q.insertEvent.run(o.encounterId, ev.seq, ev.type, JSON.stringify(ev), t);
    const head = o.events.length ? o.events[o.events.length - 1].seq : 0;
    if (o.encounterId) {
      if (o.snapshot) {
        q.snapshot.run(JSON.stringify(o.snapshot.state), o.snapshot.seq, head, t, o.encounterId);
      } else {
        q.step.run(head, o.turnLog ? JSON.stringify(o.turnLog) : null, t, o.encounterId);
      }
      if (o.status) q.setStatus.run(o.status, o.outcome ?? null, t, o.status, t, o.encounterId);
    }
    q.roomSeq.run(o.roomSeq, t, o.roomId, o.roomSeq);
  });

  return {
    /**
     * Insert a new encounter in 'setup'.
     * @param {{roomId: string, encounterId: string, state: object, engineVersion: number,
     *   sheets?: Record<string, object>|null}} o  sheets by sheetRef.characterId
     */
    createEncounter({ roomId, encounterId, state, engineVersion, sheets = null }) {
      const t = now();
      q.insertEncounter.run(encounterId, roomId, engineVersion, JSON.stringify(state), sheets ? JSON.stringify(sheets) : null, t, t);
    },

    /**
     * The PC sheets stored with an encounter, or null (none stored: built
     * before migration 0003, or by an engine without sheets).
     * @param {string} encounterId
     * @returns {Record<string, object>|null}
     */
    sheetsFor(encounterId) {
      const row = q.sheets.get(encounterId);
      return row?.sheets_json ? JSON.parse(row.sheets_json) : null;
    },

    /** Change an encounter's status ('ended' / 'abandoned' stamp ended_at). */
    setStatus(encounterId, status, outcome = null) {
      const t = now();
      q.setStatus.run(status, outcome, t, status, t, encounterId);
    },

    /**
     * One engine step, in one transaction.
     * @param {{roomId: string, roomSeq: number, encounterId: string|null, events: object[],
     *   turnLog: object|null, snapshot: {state: object, seq: number}|null, status?: string|null, outcome?: string|null}} o
     */
    flush(o) {
      const start = clock();
      flushTx(o, now());
      record(clock() - start);
    },

    /**
     * The room's live encounter for recovery, or null.
     * @param {string} roomId
     */
    loadLive(roomId) {
      const row = q.live.get(roomId);
      if (!row) return null;
      const tail = q.tail.all(row.id, row.snapshot_seq).map(r => JSON.parse(r.event_json));
      const history = q.recent.all(row.id, RECOVERY_HISTORY).map(r => JSON.parse(r.event_json)).reverse();
      return {
        encounterId: row.id,
        status: row.status,
        engineVersion: row.engine_version,
        state: JSON.parse(row.snapshot_json),
        snapshotSeq: row.snapshot_seq,
        headSeq: row.head_seq,
        turnLog: row.turn_log_json ? JSON.parse(row.turn_log_json) : null,
        tail,
        history
      };
    },

    /** Rooms with a setup/active encounter (boot recovery). */
    liveRoomIds() {
      return q.liveRooms.all().map(r => r.room_id);
    },

    /** Write-time stats: {flushes, p50Ms, p99Ms}. */
    stats() {
      return { flushes, p50Ms: round(percentile(samples, 0.5)), p99Ms: round(percentile(samples, 0.99)) };
    }
  };
}

function percentile(xs, p) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
}

function round(x) { return Math.round(x * 1000) / 1000; }
