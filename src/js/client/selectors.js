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
  if (dm && local.wantSetup) return 'setup';
  return 'lobby';
}
