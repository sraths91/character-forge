// SQLite access for campaign runs (M65 B23, migration 0006): runs, the
// run log, run characters (party_slots extended in place, read through
// the run_characters view), items, level-ups, snapshots, the roster
// archive and the encounter write-back mark. Sequencing and persistence
// only: no 5e rules here (those live in src/js/campaign/).
//
// Every statement is prepared once, when the store is built. Run
// characters carry an optimistic lock: `updateCharacter` names the
// version it read and fails with E_VERSION when someone wrote first.

import { newId } from '../rooms/tokens.js';

/** Run statuses (runs.status). */
export const RUN_STATUSES = Object.freeze(['lobby', 'in-node', 'between', 'paused', 'ended']);
/** Run outcomes (runs.outcome). */
export const RUN_OUTCOMES = Object.freeze(['victory', 'defeat', 'abandoned']);
/** Life statuses (party_slots.life_status). */
export const LIFE_STATUSES = Object.freeze(['active', 'dying', 'stable', 'dead']);

/** A store-level failure with an HTTP-ish status and a stable code. */
export class RunStoreError extends Error {
  /**
   * @param {number} status
   * @param {string} code
   * @param {string} message
   */
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const json = (v) => (v === undefined || v === null ? null : JSON.stringify(v));
const parse = (s, dflt = null) => (s == null ? dflt : JSON.parse(s));
const bit = (b) => (b ? 1 : 0);

const runRow = (r) => r && ({
  id: r.id, campaignId: r.campaign_id, roomId: r.room_id, status: r.status, outcome: r.outcome,
  currentNodeId: r.current_node_id, campaign: parse(r.campaign_json, {}), settings: parse(r.settings_json, {}),
  stash: parse(r.stash_json, {}), rng: parse(r.rng_json), seq: r.seq, pending: parse(r.pending_json, {}),
  createdAt: r.created_at, updatedAt: r.updated_at, endedAt: r.ended_at
});
const eventRow = (r) => ({
  runId: r.run_id, seq: r.seq, ts: r.ts, nodeId: r.node_id, actorKind: r.actor_kind, actorId: r.actor_id,
  type: r.type, override: r.override === 1, payload: parse(r.payload_json, {})
});
const characterRow = (r) => r && ({
  slotId: r.id, runId: r.run_id, roomId: r.room_id, seat: r.seat, characterRowId: r.character_id,
  controllerParticipantId: r.controller_participant_id, aiArchetype: r.ai_archetype,
  seed: parse(r.seed_parsed_json), sheet: parse(r.sheet_json), state: parse(r.state_json),
  level: r.level, xp: r.xp, lifeStatus: r.life_status, version: r.version, seedRawSha: r.seed_raw_sha, updatedAt: r.updated_at
});
const itemRow = (r) => r && ({
  id: r.id, runId: r.run_id, ownerSlotId: r.owner_slot_id, origin: r.origin, refKey: r.ref_key, name: r.name,
  qty: r.qty, equipped: r.equipped === 1, attuned: r.attuned === 1, chargesSpent: r.charges_spent,
  data: parse(r.data_json, {}), updatedAt: r.updated_at
});
const levelUpRow = (r) => r && ({
  id: r.id, runId: r.run_id, slotId: r.slot_id, fromLevel: r.from_level, toLevel: r.to_level, className: r.class_name,
  mode: r.mode, status: r.status, auto: parse(r.auto_json), choices: parse(r.choices_json), granted: parse(r.granted_json),
  createdAt: r.created_at, decidedAt: r.decided_at, decidedBy: r.decided_by
});
const snapshotRow = (r, withBlob = true) => r && ({
  id: r.id, runId: r.run_id, label: r.label, atSeq: r.at_seq, createdBy: r.created_by, createdAt: r.created_at,
  ...(withBlob ? { blob: parse(r.blob_json) } : {})
});

/**
 * @param {import('better-sqlite3').Database} conn  migrated to >= 0006
 * @param {{now?: () => number}} [opts]
 */
export function createRunStore(conn, { now = Date.now } = {}) {
  const q = {
    insertRun: conn.prepare(`INSERT INTO runs (id, campaign_id, room_id, status, current_node_id, campaign_json, settings_json, stash_json, rng_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    run: conn.prepare('SELECT * FROM runs WHERE id = ?'),
    runByRoom: conn.prepare('SELECT * FROM runs WHERE room_id = ?'),
    runsByCampaign: conn.prepare('SELECT * FROM runs WHERE campaign_id = ? ORDER BY created_at DESC'),
    setStatus: conn.prepare(`UPDATE runs SET status = ?, outcome = ?, ended_at = ?, updated_at = ? WHERE id = ? AND status <> 'ended'`),
    setNode: conn.prepare('UPDATE runs SET current_node_id = ?, updated_at = ? WHERE id = ?'),
    setStash: conn.prepare('UPDATE runs SET stash_json = ?, updated_at = ? WHERE id = ?'),
    setRng: conn.prepare('UPDATE runs SET rng_json = ?, updated_at = ? WHERE id = ?'),
    setPending: conn.prepare('UPDATE runs SET pending_json = ?, updated_at = ? WHERE id = ?'),   // 0007
    setSettings: conn.prepare('UPDATE runs SET settings_json = ?, updated_at = ? WHERE id = ?'),
    setCampaign: conn.prepare('UPDATE runs SET campaign_json = ?, updated_at = ? WHERE id = ?'),
    bumpSeq: conn.prepare('UPDATE runs SET seq = seq + 1, updated_at = ? WHERE id = ? RETURNING seq'),

    insertEvent: conn.prepare(`INSERT INTO run_events (run_id, seq, ts, node_id, actor_kind, actor_id, type, override, payload_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    events: conn.prepare('SELECT * FROM run_events WHERE run_id = ? AND seq > ? ORDER BY seq LIMIT ?'),

    characters: conn.prepare('SELECT * FROM run_characters WHERE run_id = ? ORDER BY seat'),
    character: conn.prepare('SELECT * FROM party_slots WHERE id = ?'),
    attachSeat: conn.prepare(`UPDATE party_slots SET run_id = ?, sheet_json = ?, state_json = ?, level = ?, xp = ?, life_status = ?,
        seed_raw_sha = ?, version = version + 1, updated_at = ? WHERE id = ? AND run_id IS NULL`),
    detachSeat: conn.prepare('UPDATE party_slots SET run_id = NULL, version = version + 1, updated_at = ? WHERE id = ? AND run_id = ?'),
    updateCharacter: conn.prepare(`UPDATE party_slots SET
        sheet_json = CASE WHEN @hasSheet THEN @sheet ELSE sheet_json END,
        state_json = CASE WHEN @hasState THEN @state ELSE state_json END,
        level = CASE WHEN @hasLevel THEN @level ELSE level END,
        xp = CASE WHEN @hasXp THEN @xp ELSE xp END,
        life_status = CASE WHEN @hasLife THEN @life ELSE life_status END,
        version = version + 1, updated_at = @now
      WHERE id = @slotId AND run_id = @runId AND version = @version`),

    insertItem: conn.prepare(`INSERT INTO run_items (id, run_id, owner_slot_id, origin, ref_key, name, qty, equipped, attuned, charges_spent, data_json, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    item: conn.prepare('SELECT * FROM run_items WHERE run_id = ? AND id = ?'),
    items: conn.prepare('SELECT * FROM run_items WHERE run_id = ? ORDER BY owner_slot_id IS NOT NULL, owner_slot_id, name, id'),
    itemsOf: conn.prepare('SELECT * FROM run_items WHERE run_id = ? AND owner_slot_id IS ? ORDER BY name, id'),
    updateItem: conn.prepare(`UPDATE run_items SET owner_slot_id = ?, qty = ?, equipped = ?, attuned = ?, charges_spent = ?, data_json = ?, updated_at = ?
      WHERE run_id = ? AND id = ?`),
    deleteItem: conn.prepare('DELETE FROM run_items WHERE run_id = ? AND id = ?'),

    insertLevelUp: conn.prepare(`INSERT INTO level_ups (id, run_id, slot_id, from_level, to_level, class_name, mode, status, auto_json, choices_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    levelUp: conn.prepare('SELECT * FROM level_ups WHERE run_id = ? AND id = ?'),
    levelUps: conn.prepare('SELECT * FROM level_ups WHERE run_id = ? ORDER BY created_at, from_level, id'),
    pendingLevelUps: conn.prepare("SELECT * FROM level_ups WHERE slot_id = ? AND status IN ('pending_player', 'pending_dm') ORDER BY from_level"),
    decideLevelUp: conn.prepare(`UPDATE level_ups SET status = ?, choices_json = COALESCE(?, choices_json), granted_json = COALESCE(?, granted_json),
        decided_at = ?, decided_by = ? WHERE run_id = ? AND id = ? AND status = ?`),

    insertSnapshot: conn.prepare('INSERT INTO run_snapshots (id, run_id, label, at_seq, blob_json, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'),
    snapshot: conn.prepare('SELECT * FROM run_snapshots WHERE run_id = ? AND id = ?'),
    snapshots: conn.prepare('SELECT id, run_id, label, at_seq, created_by, created_at FROM run_snapshots WHERE run_id = ? ORDER BY at_seq, created_at'),

    archive: conn.prepare(`INSERT INTO run_roster_archive (id, run_id, slot_id, seat, character_id, name, sheet_json, state_json, level, xp, life_status, reason, archived_at)
      SELECT ?, s.run_id, s.id, s.seat, s.character_id, c.name, s.sheet_json, s.state_json, s.level, s.xp, s.life_status, ?, ?
      FROM party_slots s LEFT JOIN characters c ON c.id = s.character_id WHERE s.id = ? AND s.run_id = ?`),
    archived: conn.prepare('SELECT * FROM run_roster_archive WHERE run_id = ? ORDER BY archived_at, id'),

    linkEncounter: conn.prepare('UPDATE encounters SET run_id = ?, node_id = ? WHERE id = ?'),
    markApplied: conn.prepare('UPDATE encounters SET run_applied_at = ? WHERE id = ? AND run_id IS NOT NULL AND run_applied_at IS NULL'),
    unapplied: conn.prepare(`SELECT id, room_id, run_id, node_id, outcome, ended_at FROM encounters
      WHERE run_id IS NOT NULL AND run_applied_at IS NULL AND status = 'ended' ORDER BY ended_at, id`),
    encounterRow: conn.prepare('SELECT id, room_id, run_id, node_id, status, outcome, snapshot_json, sheets_json, run_applied_at FROM encounters WHERE id = ?'),
    encounterExists: conn.prepare('SELECT 1 AS x FROM encounters WHERE id = ?'),

    resetSeat: conn.prepare(`UPDATE party_slots SET run_id = ?, sheet_json = ?, state_json = ?, level = ?, xp = ?, life_status = ?,
        seed_raw_sha = NULL, version = version + 1, updated_at = ? WHERE id = ?`),
    deleteItems: conn.prepare('DELETE FROM run_items WHERE run_id = ?'),
    deleteLevelUps: conn.prepare('DELETE FROM level_ups WHERE run_id = ?'),
    insertLevelUpFull: conn.prepare(`INSERT INTO level_ups (id, run_id, slot_id, from_level, to_level, class_name, mode, status, auto_json, choices_json, granted_json, created_at, decided_at, decided_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    levelUpIds: conn.prepare('SELECT id FROM level_ups WHERE run_id = ?'),
    characterParsed: conn.prepare('SELECT parsed_json FROM characters WHERE id = ?'),
    srdItem: conn.prepare('SELECT kind, name, payload_json FROM items_cache WHERE key = ?'),
    srdByName: conn.prepare('SELECT kind, name, payload_json FROM items_cache WHERE kind = ? AND name = ? COLLATE NOCASE ORDER BY key LIMIT 1')
  };

  const tx = (fn) => conn.transaction(fn);
  const mustRun = (id) => {
    const r = q.run.get(id);
    if (!r) throw new RunStoreError(404, 'NOT_FOUND', `No run ${id}`);
    return r;
  };

  /**
   * Append one run event; the run's seq is bumped in the same statement
   * group (call inside `tx` with the mutation it records).
   * @param {string} runId
   * @param {{type: string, actorKind: 'dm'|'player'|'system', actorId?: string|null, nodeId?: string|null, override?: boolean, payload?: object}} e
   * @returns {number} the event's seq
   */
  function appendEvent(runId, { type, actorKind, actorId = null, nodeId = null, override = false, payload = {} }) {
    const row = q.bumpSeq.get(now(), runId);
    if (!row) throw new RunStoreError(404, 'NOT_FOUND', `No run ${runId}`);
    q.insertEvent.run(runId, row.seq, now(), nodeId, actorKind, actorId, type, bit(override), JSON.stringify(payload));
    return row.seq;
  }

  /**
   * Write a run character, guarded by the version the caller read.
   * Only the fields present in `patch` change; the version goes up by one.
   * @param {string} runId
   * @param {string} slotId
   * @param {number} expectedVersion
   * @param {{sheet?: object, state?: object, level?: number|null, xp?: number, lifeStatus?: string}} patch
   * @returns {number} the new version
   * @throws {RunStoreError} 409 E_VERSION when the row moved on (or is not in this run)
   */
  function updateCharacter(runId, slotId, expectedVersion, patch) {
    const has = (k) => Object.prototype.hasOwnProperty.call(patch, k);
    const r = q.updateCharacter.run({
      hasSheet: bit(has('sheet')), sheet: json(patch.sheet), hasState: bit(has('state')), state: json(patch.state),
      hasLevel: bit(has('level')), level: patch.level ?? null, hasXp: bit(has('xp')), xp: patch.xp ?? 0,
      hasLife: bit(has('lifeStatus')), life: patch.lifeStatus ?? 'active',
      now: now(), slotId, runId, version: expectedVersion
    });
    if (r.changes === 0) {
      const cur = q.character.get(slotId);
      if (!cur || cur.run_id !== runId) throw new RunStoreError(404, 'NOT_FOUND', `Seat ${slotId} is not in run ${runId}`);
      throw new RunStoreError(409, 'E_VERSION', `Seat ${slotId} is at version ${cur.version}, not ${expectedVersion}; re-read and retry`);
    }
    return expectedVersion + 1;
  }

  return {
    tx,
    /**
     * @param {{id?: string, campaignId?: string|null, roomId: string, campaign: object, settings?: object, stash?: object, rng?: object|null, status?: string, currentNodeId?: string|null}} r
     * @returns {string} the run id
     */
    createRun(r) {
      const id = r.id || newId('run_');
      const t = now();
      q.insertRun.run(id, r.campaignId ?? null, r.roomId, r.status || 'lobby', r.currentNodeId ?? null, JSON.stringify(r.campaign),
        JSON.stringify(r.settings || {}), JSON.stringify(r.stash || {}), json(r.rng), t, t);
      return id;
    },
    getRun: (id) => runRow(q.run.get(id)),
    getRunByRoom: (roomId) => runRow(q.runByRoom.get(roomId)),
    listCampaignRuns: (campaignId) => q.runsByCampaign.all(campaignId).map(runRow),
    /**
     * Move a run to `status` (an ended run never changes again).
     * @param {string} id
     * @param {string} status
     * @param {{outcome?: string|null}} [opts]  required when status is 'ended'
     */
    setStatus(id, status, { outcome = null } = {}) {
      if (!RUN_STATUSES.includes(status)) throw new RunStoreError(400, 'BAD_STATUS', `status must be one of ${RUN_STATUSES.join(', ')}`);
      const ended = status === 'ended';
      if (ended && !RUN_OUTCOMES.includes(outcome)) throw new RunStoreError(400, 'BAD_OUTCOME', `an ended run needs an outcome: ${RUN_OUTCOMES.join(', ')}`);
      mustRun(id);
      const r = q.setStatus.run(status, ended ? outcome : null, ended ? now() : null, now(), id);
      if (r.changes === 0) throw new RunStoreError(409, 'E_RUN_ENDED', `Run ${id} has ended`);
    },
    setCurrentNode: (id, nodeId) => { mustRun(id); q.setNode.run(nodeId ?? null, now(), id); },
    setStash: (id, stash) => { mustRun(id); q.setStash.run(JSON.stringify(stash), now(), id); },
    setRng: (id, rng) => { mustRun(id); q.setRng.run(json(rng), now(), id); },
    /** Replace runs.pending_json (0007): {rest: {slotId: {Class: n}}, xp?}. */
    setPending: (id, pending) => { mustRun(id); q.setPending.run(JSON.stringify(pending || {}), now(), id); },
    setSettings: (id, settings) => { mustRun(id); q.setSettings.run(JSON.stringify(settings), now(), id); },
    /** Replace the frozen campaign graph ("pull latest", decision 4). */
    setCampaign: (id, campaign) => { mustRun(id); q.setCampaign.run(JSON.stringify(campaign), now(), id); },

    appendEvent,
    /** Events after `afterSeq`, oldest first. */
    listEvents: (runId, { afterSeq = 0, limit = 1000 } = {}) => q.events.all(runId, afterSeq, limit).map(eventRow),

    listCharacters: (runId) => q.characters.all(runId).map(characterRow),
    getCharacter: (slotId) => characterRow(q.character.get(slotId)),
    /**
     * Put a room seat into a run with its starting sheet and state.
     * @param {string} runId
     * @param {string} slotId
     * @param {{sheet: object, state: object, level?: number|null, xp?: number, lifeStatus?: string, seedRawSha?: string|null}} init
     */
    attachSeat(runId, slotId, { sheet, state, level = null, xp = 0, lifeStatus = 'active', seedRawSha = null }) {
      const r = q.attachSeat.run(runId, json(sheet), json(state), level, xp, lifeStatus, seedRawSha, now(), slotId);
      if (r.changes === 0) throw new RunStoreError(409, 'E_SEAT_IN_RUN', `Seat ${slotId} is missing or already in a run`);
      return characterRow(q.character.get(slotId));
    },
    detachSeat: (runId, slotId) => q.detachSeat.run(now(), slotId, runId).changes > 0,
    updateCharacter,

    /** @returns {string} the item id */
    addItem(runId, { id: wanted = null, ownerSlotId = null, origin, refKey = null, name, qty = 1, equipped = false, attuned = false, chargesSpent = 0, data = {} }) {
      const id = wanted || newId('it_');
      q.insertItem.run(id, runId, ownerSlotId, origin, refKey, name, qty, bit(equipped), bit(attuned), chargesSpent, JSON.stringify(data), now());
      return id;
    },
    getItem: (runId, id) => itemRow(q.item.get(runId, id)),
    /** All items, or one owner's (`ownerSlotId: null` = the party stash). */
    listItems: (runId, opts) => (opts && 'ownerSlotId' in opts ? q.itemsOf.all(runId, opts.ownerSlotId) : q.items.all(runId)).map(itemRow),
    /** Patch an item (owner, qty, equipped, attuned, chargesSpent, data). */
    updateItem(runId, id, patch) {
      const cur = itemRow(q.item.get(runId, id));
      if (!cur) throw new RunStoreError(404, 'NOT_FOUND', `No item ${id} in run ${runId}`);
      const n = { ...cur, ...patch };
      q.updateItem.run(n.ownerSlotId ?? null, n.qty, bit(n.equipped), bit(n.attuned), n.chargesSpent, JSON.stringify(n.data ?? {}), now(), runId, id);
      return itemRow(q.item.get(runId, id));
    },
    deleteItem: (runId, id) => q.deleteItem.run(runId, id).changes > 0,

    /** @returns {string} the level-up id */
    addLevelUp(runId, { id: wanted = null, slotId, fromLevel, className = null, mode, status = 'pending_player', auto = null, choices = null }) {
      const id = wanted || newId('lu_');
      q.insertLevelUp.run(id, runId, slotId, fromLevel, fromLevel + 1, className, mode, status, json(auto), json(choices), now());
      return id;
    },
    getLevelUp: (runId, id) => levelUpRow(q.levelUp.get(runId, id)),
    listLevelUps: (runId) => q.levelUps.all(runId).map(levelUpRow),
    pendingLevelUps: (slotId) => q.pendingLevelUps.all(slotId).map(levelUpRow),
    /**
     * Move a level-up from `fromStatus` to `status` (compare-and-set).
     * @returns {boolean} false when it was no longer in `fromStatus`
     */
    decideLevelUp(runId, id, { fromStatus, status, choices = null, granted = null, decidedBy = null }) {
      return q.decideLevelUp.run(status, json(choices), json(granted), now(), decidedBy, runId, id, fromStatus).changes > 0;
    },

    /** @returns {string} the snapshot id */
    saveSnapshot(runId, { label = null, atSeq, blob, createdBy = null }) {
      const id = newId('snap_');
      q.insertSnapshot.run(id, runId, label, atSeq, JSON.stringify(blob), createdBy, now());
      return id;
    },
    getSnapshot: (runId, id) => snapshotRow(q.snapshot.get(runId, id)),
    listSnapshots: (runId) => q.snapshots.all(runId).map(r => snapshotRow(r, false)),

    /**
     * Copy a run seat into the roster archive (before the seat is reused).
     * @returns {string} the archive id
     */
    archiveSeat(runId, slotId, reason) {
      const id = newId('ar_');
      if (q.archive.run(id, reason, now(), slotId, runId).changes === 0) throw new RunStoreError(404, 'NOT_FOUND', `Seat ${slotId} is not in run ${runId}`);
      return id;
    },
    listArchived: (runId) => q.archived.all(runId).map(r => ({
      id: r.id, runId: r.run_id, slotId: r.slot_id, seat: r.seat, characterRowId: r.character_id, name: r.name,
      sheet: parse(r.sheet_json), state: parse(r.state_json), level: r.level, xp: r.xp, lifeStatus: r.life_status,
      reason: r.reason, archivedAt: r.archived_at
    })),

    linkEncounter: (encounterId, runId, nodeId) => q.linkEncounter.run(runId, nodeId ?? null, encounterId).changes > 0,
    /**
     * Mark an ended run encounter as written back (decision 3). Exactly one
     * caller wins: the second call returns false.
     */
    markEncounterApplied: (encounterId) => q.markApplied.run(now(), encounterId).changes > 0,
    /** Ended run encounters not yet written back (the boot sweep). */
    unappliedEncounters: () => q.unapplied.all().map(r => ({
      encounterId: r.id, roomId: r.room_id, runId: r.run_id, nodeId: r.node_id, outcome: r.outcome, endedAt: r.ended_at
    })),
    /**
     * One encounter row as the run write-back needs it (snapshot, sheets,
     * outcome, mark), or null.
     * @param {string} encounterId
     */
    getEncounter(encounterId) {
      const r = q.encounterRow.get(encounterId);
      return r ? {
        id: r.id, roomId: r.room_id, runId: r.run_id, nodeId: r.node_id, status: r.status, outcome: r.outcome,
        state: parse(r.snapshot_json), sheets: parse(r.sheets_json), runAppliedAt: r.run_applied_at
      } : null;
    },
    encounterExists: (id) => !!q.encounterExists.get(id),

    /**
     * Seat a (new) character in a run seat whatever the row held before
     * (dm.seat.fill, after the old row was archived).
     * @param {string} runId
     * @param {string} slotId
     * @param {{sheet: object, state: object, level: number, xp: number, lifeStatus?: string}} init
     */
    resetSeat(runId, slotId, { sheet, state, level, xp, lifeStatus = 'active' }) {
      if (q.resetSeat.run(runId, json(sheet), json(state), level, xp, lifeStatus, now(), slotId).changes === 0) {
        throw new RunStoreError(404, 'NOT_FOUND', `No seat ${slotId}`);
      }
      return characterRow(q.character.get(slotId));
    },
    /** Replace every item of a run (snapshot restore); ids are kept. */
    replaceItems(runId, items) {
      q.deleteItems.run(runId);
      for (const it of items) {
        q.insertItem.run(it.id, runId, it.ownerSlotId ?? null, it.origin, it.refKey ?? null, it.name, it.qty, bit(it.equipped), bit(it.attuned),
          it.chargesSpent ?? 0, JSON.stringify(it.data ?? {}), now());
      }
    },
    /** Replace every level-up of a run (snapshot restore); ids and decisions are kept. */
    replaceLevelUps(runId, rows) {
      q.deleteLevelUps.run(runId);
      for (const l of rows) {
        q.insertLevelUpFull.run(l.id, runId, l.slotId, l.fromLevel, l.toLevel, l.className ?? null, l.mode, l.status,
          json(l.auto), json(l.choices), json(l.granted), l.createdAt ?? now(), l.decidedAt ?? null, l.decidedBy ?? null);
      }
    },
    /** Every level-up id of a run (to number the next one). */
    levelUpIds: (runId) => q.levelUpIds.all(runId).map(r => r.id),
    /** A character row's current parse (a re-import for reconcile), or null. */
    characterParsed: (characterRowId) => parse(q.characterParsed.get(characterRowId)?.parsed_json),
    /**
     * An Open5e SRD record from the items cache (B23): by key, else by
     * kind + name (case-insensitive). Never fetches.
     * @param {string} keyOrName
     * @param {string} [kind]  'item' | 'magicitem' | 'spell' for the name lookup
     * @returns {{kind: string, name: string, payload: object}|null}
     */
    srdRecord(keyOrName, kind = null) {
      const r = q.srdItem.get(String(keyOrName)) || (kind ? q.srdByName.get(kind, String(keyOrName)) : null);
      return r ? { kind: r.kind, name: r.name, payload: parse(r.payload_json, {}) } : null;
    }
  };
}
