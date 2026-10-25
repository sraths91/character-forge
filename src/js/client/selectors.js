/**
 * M64 C9 — read-only selectors over the client store state (C6) for the
 * play views. Pure; no DOM.
 *
 * Room shape (E3's room.snapshot): `room {id, code, name, status, paused,
 * settings, members[{id, displayName, role, online}], seats[{seat, slotId,
 * characterId, characterName, controller, memberId, aiArchetype}],
 * encounterId, turn{turnId, actorId, awaitingIntent}, review?}`; member.*
 * and seat.updated broadcasts overlay it (store keeps them in `members` /
 * `seats`).
 */

import { currentTurn } from './intents.js';
import { lifeStatus } from './mirror.js';
import { tokenImageIndex } from '../map/view.js';

/** Seats per room (E3 MAX_SEATS). */
export const SEAT_COUNT = 6;

/**
 * Members, snapshot list overlaid with presence / join / leave.
 * @param {object} s — ClientState
 * @returns {{memberId: string, displayName: string, role: string, online: boolean}[]}
 */
export function membersOf(s) {
  const out = new Map();
  for (const m of s?.room?.members || []) {
    out.set(m.id, { memberId: m.id, displayName: m.displayName || 'Someone', role: m.role || 'player', online: !!m.online });
  }
  for (const [id, m] of Object.entries(s?.members || {})) {
    const prev = out.get(id) || { memberId: id, displayName: 'Someone', role: 'player', online: false };
    out.set(id, { ...prev, ...(m.displayName ? { displayName: m.displayName } : {}), ...(m.role ? { role: m.role } : {}), online: !!m.online });
  }
  // member.left removes from the overlay only; drop snapshot members the store no longer lists after a leave
  return [...out.values()].sort((a, b) => (a.role === b.role ? 0 : a.role === 'dm' ? -1 : 1));
}

/**
 * Seats 1..6 (empty ones included), snapshot overlaid with seat.updated.
 * @param {object} s — ClientState
 * @returns {{seat: number, slotId: string|null, characterId: string|null, characterName: string|null,
 *            controller: 'player'|'ai'|null, memberId: string|null, aiArchetype: string|null}[]}
 */
export function seatsOf(s) {
  const bySeat = new Map();
  for (const seat of s?.room?.seats || s?.me?.seats || []) {
    if (Number.isInteger(seat.seat)) bySeat.set(seat.seat, { ...seat });
  }
  for (const [characterId, u] of Object.entries(s?.seats || {})) {
    let n = Number.isInteger(u.seat) ? u.seat : null;
    if (n == null) for (const [k, v] of bySeat) if (v.characterId === characterId) n = k;
    if (n == null) continue;
    if (u.removed) { bySeat.delete(n); continue; }
    const prev = bySeat.get(n) || {};
    bySeat.set(n, {
      ...prev,
      seat: n,
      slotId: u.slotId || prev.slotId || null,
      characterId,
      characterName: prev.characterId === characterId ? prev.characterName : null,
      controller: u.controller === 'player' ? 'player' : 'ai',
      memberId: u.memberId ?? null,
      aiArchetype: prev.characterId === characterId ? (prev.aiArchetype ?? null) : null
    });
  }
  const out = [];
  for (let n = 1; n <= SEAT_COUNT; n++) {
    const v = bySeat.get(n);
    out.push(v
      ? { seat: n, slotId: v.slotId ?? null, characterId: v.characterId ?? null, characterName: v.characterName ?? null, controller: v.controller ?? null, memberId: v.memberId ?? null, aiArchetype: v.aiArchetype ?? null }
      : { seat: n, slotId: null, characterId: null, characterName: null, controller: null, memberId: null, aiArchetype: null });
  }
  return out;
}

/** @param {object} s @returns {boolean} */
export function isDm(s) { return s?.me?.role === 'dm'; }

/** @param {object} s @returns {string|null} */
export function myMemberId(s) { return s?.me?.memberId ?? null; }

/**
 * Entity ids this member controls (player-controlled PCs whose seat is
 * held by this member).
 * @param {object} s — ClientState
 * @returns {string[]}
 */
export function myEntityIds(s) {
  const me = myMemberId(s);
  const enc = s?.encounter;
  if (!me || !enc) return [];
  const seats = seatsOf(s);
  const mySlots = new Set(seats.filter(x => x.memberId === me).map(x => x.slotId).filter(Boolean));
  const myChars = new Set(seats.filter(x => x.memberId === me).map(x => x.characterId).filter(Boolean));
  return Object.values(enc.entities || {})
    .filter(e => e.controller?.type === 'player' && (mySlots.has(e.controller.seatId) || myChars.has(e.sheetRef?.characterId)))
    .map(e => e.id);
}

/**
 * The creature whose turn it is and who acts for it.
 * @param {object} s — ClientState
 * @returns {{turnId: string|null, actorId: string|null, actor: object|null, mine: boolean, dmControlled: boolean}}
 */
export function turnInfo(s) {
  const t = currentTurn(s);
  const enc = s?.encounter;
  const actorId = t.actorId ?? (enc && enc.phase === 'running' ? enc.initiative?.[enc.turnIndex]?.entityId ?? null : null);
  const actor = actorId ? enc?.entities?.[actorId] || null : null;
  const mine = !!actor && (myEntityIds(s).includes(actor.id) || (isDm(s) && actor.controller?.type === 'dm'));
  return { turnId: t.turnId, actorId, actor, mine, dmControlled: actor?.controller?.type === 'dm' };
}

/**
 * Display name for an entity id (falls back to the id).
 * @param {object|null} enc
 * @param {string|null} id
 * @returns {string}
 */
export function nameOf(enc, id) {
  if (!id) return '—';
  return enc?.entities?.[id]?.name || String(id);
}

/**
 * Condition ids of an entity.
 * @param {object|null} e
 * @returns {string[]}
 */
export function conditionIds(e) {
  return (e?.conditions || []).map(c => (typeof c === 'string' ? c : c?.id)).filter(Boolean);
}

/**
 * Remaining slots per level `[{level, left, max}]` from the ledger.
 * @param {object|null} e
 * @returns {{level: number, left: number, max: number}[]}
 */
export function slotsLeft(e) {
  return Object.entries(e?.resources?.slots || {})
    .map(([lvl, l]) => ({ level: Number(lvl), left: Math.max(0, (l.max ?? 0) - (l.spent ?? 0)), max: l.max ?? 0 }))
    .filter(x => x.max > 0)
    .sort((a, b) => a.level - b.level);
}

/**
 * What the screen should route to.
 * @param {object} s — ClientState
 * @param {{wantSetup?: boolean}} [local]
 * @returns {'connecting'|'lobby'|'setup'|'waiting-setup'|'battle'}
 */
export function screenFor(s, local = {}) {
  if (!s?.synced) return 'connecting';
  const status = s.room?.status || 'lobby';
  const dm = isDm(s);
  if (status === 'in-encounter' || status === 'paused' || status === 'encounter-over') return s.encounter ? 'battle' : (dm ? 'setup' : 'waiting-setup');
  if (status === 'setup') return dm ? 'setup' : 'waiting-setup';
  if (status === 'between') return 'between';   // M65 v1.6: a run between nodes
  if (dm && local.wantSetup) return 'setup';
  return 'lobby';
}

/**
 * The room's settings (E3 v1.4 names), with the defaults a server that
 * predates them implies: 20 s reactions, characters start rested, fudges
 * public.
 * @param {object} s — ClientState
 * @returns {{reactionTimeoutMs: number, importLiveState: boolean, fudgeVisibility: 'public'|'dm-only', diagonalRule: string}}
 */
export function roomSettingsOf(s) {
  const st = s?.room?.settings || {};
  return {
    reactionTimeoutMs: Number.isInteger(st.reactionTimeoutMs) ? st.reactionTimeoutMs : 20000,
    importLiveState: st.importLiveState === true || st.importDdbState === true,
    fudgeVisibility: st.fudgeVisibility === 'dm-only' || (!st.fudgeVisibility && st.dmOverrideVisibility === 'dm-only') ? 'dm-only' : 'public',
    diagonalRule: typeof st.diagonalRule === 'string' ? st.diagonalRule : '5ft'
  };
}

/**
 * The claim screen's line on how characters arrive.
 * @param {object} s — ClientState
 * @returns {string}
 */
export function seedingCopy(s) {
  return roomSettingsOf(s).importLiveState
    ? 'Characters import their current D&D Beyond HP, spell slots and used features.'
    : 'Characters start fully rested (full HP, every slot and feature).';
}

/** Badge copy per life state (initiative strip, tokens, cards). */
const STATUS_BADGES = Object.freeze({
  down: { label: 'Down', short: 'DOWN', cls: 'is-down' },
  downed: { label: 'Dying', short: 'DYING', cls: 'is-dying' },
  stable: { label: 'Stable', short: 'STABLE', cls: 'is-stable' },
  dead: { label: 'Dead', short: 'DEAD', cls: 'is-dead' }
});

/**
 * The life-state badge for an entity, or null while it stands.
 * @param {object|null} e — EncounterState entity
 * @returns {{status: string, label: string, short: string, cls: string}|null}
 */
export function statusBadge(e) {
  const status = lifeStatus(e);
  const b = STATUS_BADGES[status];
  return b ? { status, ...b } : null;
}

/**
 * Death-save state of one creature for the dying banner: status, the
 * tally, and the latest `death.save` in the history (with whether it
 * was rolled in the current turn).
 * @param {object} s — ClientState (presented)
 * @param {string} entityId
 * @returns {{status: string, successes: number, failures: number, stable: boolean,
 *            last: {d20: number|null, success: boolean, crit: boolean, cause: string, seq: number, thisTurn: boolean}|null}|null}
 *   null when the creature is standing
 */
export function deathSaveInfo(s, entityId) {
  const e = s?.encounter?.entities?.[entityId];
  if (!e) return null;
  const status = lifeStatus(e);
  if (status === 'active') return null;
  const ds = e.deathSaves || {};
  const hist = s.history || [];
  let last = null;
  for (let i = hist.length - 1; i >= 0; i--) {
    const ev = hist[i];
    if (ev.type !== 'death.save' || ev.payload?.entityId !== entityId) continue;
    const turnStart = hist.slice(i + 1).some(x => (x.type === 'turn.started' || x.type === 'turn.skipped') && x.payload?.actorId !== entityId);
    const p = ev.payload;
    last = { d20: p.d20 ?? null, success: !!p.success, crit: !!p.crit, cause: p.cause || 'roll', seq: ev.seq, thisTurn: !turnStart };
    break;
  }
  return { status, successes: ds.successes ?? 0, failures: ds.failures ?? 0, stable: !!ds.stable, last };
}

/**
 * Whether the DM may give a creature a token image (E3 wave 6): monsters
 * whose stat block names a non-humanoid type (dragons, beasts, oozes —
 * no LPC look). PCs and humanoid / preset-only monsters draw their sprite.
 * @param {object|null|undefined} e — EncounterState entity
 * @returns {boolean}
 */
export function tokenImageAllowed(e) {
  if (!e || e.kind !== 'monster') return false;
  const type = e.statBlock?.type;
  return typeof type === 'string' && type !== '' && type.toLowerCase() !== 'humanoid';
}

/**
 * M65 1.5 leftover A — the room's token-image uploads (`uploaded_maps`
 * rows with `kind: 'token'`) as the snapshot carries them: `room.tokenImages`
 * (token rows only) or `room.maps` / `room.uploadedMaps` (every upload;
 * map-kind rows are skipped). Rows are E3's `GET /api/rooms/:id/maps`
 * shape `{mapId, kind, url, sha256, …}`.
 * @param {object[]|null|undefined} rows
 * @returns {object[]}
 */
export function tokenUploads(rows) {
  return (Array.isArray(rows) ? rows : []).filter(r => r && typeof r === 'object' && (r.kind === 'token' || r.kind === undefined));
}

const TOKEN_INDEX_MEMO = new WeakMap();

/**
 * The room's token-image index (id / sha256 → served URL) from the
 * client state's `room`, memoised per room object so a renderer can
 * compare it by identity. Null when the room lists no token uploads.
 * @param {object} s — ClientState
 * @returns {Map<string, string>|null}
 */
export function tokenImagesOf(s) {
  const room = s?.room;
  if (!room || typeof room !== 'object') return null;
  if (TOKEN_INDEX_MEMO.has(room)) return TOKEN_INDEX_MEMO.get(room);
  const rows = Array.isArray(room.tokenImages)
    ? tokenUploads(room.tokenImages)
    : tokenUploads(room.maps ?? room.uploadedMaps).filter(r => r.kind === 'token');
  const idx = rows.length ? tokenImageIndex(rows) : null;
  TOKEN_INDEX_MEMO.set(room, idx);
  return idx;
}

/**
 * One `tokenImages` resolver for `projectBattleView` over several
 * sources, first hit wins: Maps, plain objects, functions, or anything
 * with `tokenImageUrl(id)` (the appearance cache's `putTokenImages` index).
 * @param {...(Map<string, string>|Record<string, string>|Function|{tokenImageUrl: Function}|null)} sources
 * @returns {(id: string) => string|null}
 */
export function tokenImageResolver(...sources) {
  const list = sources.filter(Boolean);
  return (id) => {
    const key = String(id);
    for (const src of list) {
      let url = null;
      if (typeof src === 'function') url = src(key);
      else if (src instanceof Map) url = src.get(key);
      else if (typeof src.tokenImageUrl === 'function') url = src.tokenImageUrl(key);
      else if (typeof src === 'object') url = src[key];
      if (url) return url;
    }
    return null;
  };
}
