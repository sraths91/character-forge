// Hourly janitor (M64 B11): event retention, idle-room deletion (with the
// room's maps directory) and a WAL checkpoint when the WAL grows past
// 64 MB. Clock, filesystem and interval are injectable; the timer is
// unref'd and cleared by stop().
//
// Campaign runs (M65 B23, decision 2): a room that holds a run is never
// deleted as idle while the run exists, ended or not (runs.room_id is a
// plain FK, so the delete would fail anyway). Ended runs age out after
// 90 days (their events, snapshots, items and level-ups cascade); the
// room then goes the ordinary idle way, in the same pass when it is idle.

import { statSync, rmSync } from 'node:fs';
import { removeRoomMaps } from '../rooms/maps.js';

export const JANITOR_DEFAULTS = Object.freeze({
  intervalMs: 60 * 60 * 1000,
  eventRetentionMs: 7 * 24 * 60 * 60 * 1000,
  idleRoomMs: 30 * 24 * 60 * 60 * 1000,
  endedRunRetentionMs: 90 * 24 * 60 * 60 * 1000,
  walLimitBytes: 64 * 1024 * 1024
});

/**
 * @param {object} o
 * @param {import('../db/database.js').DbHandle} o.db
 * @param {string|null} o.dataDir
 * @param {{evict: (roomId: string) => boolean, get?: Function}|null} [o.registry]  live rooms are never deleted
 * @param {() => number} [o.now=Date.now]
 * @param {{statSync: typeof statSync, rmSync: typeof rmSync}} [o.fs]
 * @param {(level: string, msg: string, extra?: object) => void} [o.log]
 * @param {Partial<typeof JANITOR_DEFAULTS>} [o.config]
 * @param {typeof setInterval} [o.setInterval]
 * @param {typeof clearInterval} [o.clearInterval]
 */
export function createJanitor({
  db, dataDir, registry = null, now = Date.now, fs = { statSync, rmSync }, log = () => {}, config = {},
  setInterval: setI = setInterval, clearInterval: clearI = clearInterval
}) {
  const cfg = { ...JANITOR_DEFAULTS, ...config };
  const conn = db.db;
  const q = {
    deleteOldEvents: conn.prepare(`
      DELETE FROM encounter_events WHERE encounter_id IN (
        SELECT id FROM encounters WHERE status IN ('ended', 'abandoned') AND ended_at IS NOT NULL AND ended_at < ?)`),
    deleteEndedRuns: conn.prepare("DELETE FROM runs WHERE status = 'ended' AND ended_at < ?"),
    idleRooms: conn.prepare('SELECT id FROM rooms r WHERE last_active_at < ? AND NOT EXISTS (SELECT 1 FROM runs WHERE runs.room_id = r.id)'),
    deleteRoom: conn.prepare('DELETE FROM rooms WHERE id = ?')
  };
  let timer = null;

  function walSize() {
    if (!db.path || db.path === ':memory:') return 0;
    try { return fs.statSync(`${db.path}-wal`).size; } catch { return 0; }
  }

  /** One pass. @returns {{eventsDeleted: number, runsDeleted: number, roomsDeleted: string[], walCheckpoint: boolean}} */
  function runOnce() {
    const t = now();
    const out = { eventsDeleted: 0, runsDeleted: 0, roomsDeleted: [], walCheckpoint: false };
    try {
      out.eventsDeleted = q.deleteOldEvents.run(t - cfg.eventRetentionMs).changes;
      out.runsDeleted = q.deleteEndedRuns.run(t - cfg.endedRunRetentionMs).changes;
      for (const { id } of q.idleRooms.all(t - cfg.idleRoomMs)) {
        if (registry && !registry.evict(id) && registry.all?.().some(r => r.id === id)) continue;   // live: keep
        try {
          q.deleteRoom.run(id);
        } catch (err) {
          // A run created between the select and the delete pins the room (FK).
          log('warn', 'janitor: room not deleted', { roomId: id, error: err.message });
          continue;
        }
        removeRoomMaps(dataDir, id, fs.rmSync);
        out.roomsDeleted.push(id);
      }
      if (walSize() > cfg.walLimitBytes) {
        conn.pragma('wal_checkpoint(RESTART)');
        out.walCheckpoint = true;
      }
      if (out.eventsDeleted || out.runsDeleted || out.roomsDeleted.length || out.walCheckpoint) {
        log('info', 'janitor', { eventsDeleted: out.eventsDeleted, runsDeleted: out.runsDeleted, roomsDeleted: out.roomsDeleted.length, walCheckpoint: out.walCheckpoint });
      }
    } catch (err) {
      log('error', 'janitor failed', { error: err.message });
    }
    return out;
  }

  return {
    runOnce,
    start() {
      if (timer) return;
      timer = setI(runOnce, cfg.intervalMs);
      timer?.unref?.();
    },
    stop() {
      if (timer) clearI(timer);
      timer = null;
    }
  };
}
