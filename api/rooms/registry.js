// In-memory registry of live rooms (M64 B7). Railway runs one instance
// (volumes forbid replicas), so a process-local Map is the right shape.
// Rooms load lazily from SQLite on first use and listen to the room
// service's HTTP-side changes (join / kick / seat).

import { Room } from './room.js';

/**
 * A journal that keeps nothing (rooms without persistence; tests of the
 * room alone). The SQLite journal is in persistence.js.
 */
export function createNullJournal() {
  return {
    createEncounter() {},
    setStatus() {},
    flush() {},
    loadLive() { return null; },
    liveRoomIds() { return []; }
  };
}

/**
 * @param {object} o
 * @param {ReturnType<import('./service.js').createRoomService>} o.service
 * @param {import('./engine-port.js').EnginePort} o.engine
 * @param {object} [o.journal]
 * @param {(level: string, msg: string, extra?: object) => void} [o.log]
 * @param {() => number} [o.now]
 * @param {typeof setTimeout} [o.setTimer]
 * @param {typeof clearTimeout} [o.clearTimer]
 */
export function createRoomRegistry({ service, engine, journal = createNullJournal(), log = () => {}, now, setTimer, clearTimer }) {
  /** @type {Map<string, Room>} */
  const rooms = new Map();
  let closed = false;

  function get(roomId) {
    if (closed) return null;
    let room = rooms.get(roomId);
    if (!room) {
      if (!service.store.getRoom(roomId)) return null;
      room = new Room({ id: roomId, service, engine, journal, log, now, setTimer, clearTimer });
      rooms.set(roomId, room);
    }
    return room;
  }

  const onJoin = (e) => rooms.get(e.roomId)?.memberJoined(e);
  const onKick = (e) => rooms.get(e.roomId)?.memberKicked(e);
  const onSeat = (e) => rooms.get(e.roomId)?.seatsChanged();
  service.events.on('join', onJoin);
  service.events.on('kick', onKick);
  service.events.on('seat', onSeat);

  return {
    get,
    /** Rooms currently in memory. */
    get size() { return rooms.size; },
    /** Load every room with a live (setup/active) encounter (boot recovery, B8). */
    recover() {
      const ids = journal.liveRoomIds();
      for (const id of ids) get(id);
      return ids.length;
    },
    /** Live socket count across rooms (for /api/health). */
    socketCount() {
      let n = 0;
      for (const r of rooms.values()) n += r.socketCount;
      return n;
    },
    /** @returns {Room[]} */
    all() { return [...rooms.values()]; },
    /**
     * Stop every room: persist buffered state, close sockets with `code`.
     * @param {number} [code=1012]
     */
    shutdown(code) {
      if (closed) return;
      closed = true;
      for (const r of rooms.values()) r.shutdown(code);
      service.events.off('join', onJoin);
      service.events.off('kick', onKick);
      service.events.off('seat', onSeat);
    },
    /** Forget an idle room (janitor). */
    evict(roomId) {
      const r = rooms.get(roomId);
      if (r && r.socketCount === 0 && !r.loopRunning) { rooms.delete(roomId); return true; }
      return false;
    }
  };
}
