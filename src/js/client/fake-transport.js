/**
 * M64 C9 — an in-browser fake of E3's room server, for tests and the
 * `play.html?fake=1` local demo. It speaks the real wire: the HTTP routes
 * of api/rooms/http.js + maps.js (`fetch`), and the ws protocol of
 * api/ws/gateway.js + rooms/room.js (`WebSocket`): hello → hello.ok +
 * room.snapshot {seq, room{status, members, seats, turn}, encounter,
 * openPrompt, history, stateHash}; sequenced broadcasts; ack / error per
 * cid; prompt.open / prompt.closed; turn.planProposed to the DM.
 *
 * Every message it sends is checked with `validateServerMessage` and every
 * message it receives with `validateClientMessage` (an invalid one gets an
 * `error` frame), so a test that passes here passes the shared contracts.
 *
 * The rules are a deliberately tiny deterministic stand-in (like E3's
 * stub engine): d20 + bonus vs AC, preset / weapon dice, a Shield prompt
 * for a player-controlled target hit by 1–5, AI creatures attack the
 * nearest enemy. It is NOT the combat engine and must not grow into one.
 *
 * Test-only in spirit; shipped behind `?fake=1` for a local demo. No DOM.
 */

import { validateServerMessage, validateClientMessage, PROTOCOL_VERSION, INTENT_ROLES } from '../shared/protocol.js';
import { validateEncounterState } from '../shared/encounter-state.js';
import { stateHash } from '../shared/state-hash.js';
import { entityFromSheet, entityFromPreset } from '../scene/encounter-adapters.js';
import { MONSTER_PRESETS } from '../scene/monster-presets.js';
import { applyTerrainPaint, encodeTerrain, asTerrain } from '../map/terrain.js';

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const MAX_SEATS = 6;

/**
 * Whether the shared EncounterState schema carries E1's wave-5 dying
 * fields yet (entity `status` / `deathSaves`). Probed once, so the fake
 * tracks them exactly when the real engine does and stays valid before.
 */
const DYING_SCHEMA = (() => {
  const e = entityFromPreset('goblin', { id: 'probe', pos: { col: 0, row: 0 } });
  const probe = {
    v: 1, encounterId: 'probe', round: 0, turnIndex: 0, phase: 'setup', grid: { cols: 1, rows: 1, cellFt: 5, flankingEnabled: false },
    map: null, initiative: [], entities: { probe: { ...e, hp: 0, status: 'dead' } }, lastEventSeq: 0
  };
  return validateEncounterState(probe, { projected: true }).ok;
})();
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function mulberry32(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function parseDice(spec) {
  const m = /^(\d+)d(\d+)\s*([+-]\s*\d+)?$/.exec(String(spec || '').replace(/\s+/g, ''));
  if (!m) return { n: 1, d: 6, mod: 0 };
  return { n: Number(m[1]), d: Number(m[2]), mod: m[3] ? Number(m[3].replace(/\s+/g, '')) : 0 };
}

function response(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => clone(body) };
}

class HttpFail extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

class IntentFail extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

/**
 * A ready-made demo character (parsed-sheet shape) for `?fake=1`.
 * @param {string} id
 * @param {string} name
 * @param {{cls?: string, level?: number, hp?: number, weapon?: string, dice?: string, damageType?: string, armor?: number, spellSlots?: object}} [o]
 * @returns {object}
 */
export function demoCharacter(id, name, o = {}) {
  return {
    id, name,
    race: { name: 'Human' },
    classes: [{ name: o.cls || 'Fighter', level: o.level || 3 }],
    level: o.level || 3,
    hp: { max: o.hp || 28, current: o.hp || 28, temp: 0 },
    abilityModifiers: { STR: 3, DEX: 1, CON: 2, INT: 0, WIS: 1, CHA: 0 },
    proficiencyBonus: 2,
    equipment: {
      mainhand: { name: o.weapon || 'Longsword', damage: o.dice || '1d8', damageType: o.damageType || 'slashing' },
      armor: { name: 'Chain Mail', armorClass: o.armor || 16, ac: o.armor || 16 }
    },
    ...(o.spellSlots ? { spellSlotTable: { spell: o.spellSlots } } : {}),
    spells: []
  };
}

/**
 * @param {object} [opts]
 * @param {object[]} [opts.characters] — parsed sheets in the shared library
 * @param {() => number} [opts.now]
 * @param {{setTimeout: Function, clearTimeout: Function}} [opts.timers]
 * @param {number} [opts.seed=42]
 * @param {number} [opts.reactionTimeoutMs=20000]
 * @param {number} [opts.cinemaCapMs=4000]
 * @param {boolean} [opts.shareLibrary=false] — every new room can seat every library character (demo)
 * @param {(fn: () => void) => void} [opts.defer] — message delivery (default: microtask)
 * @returns {{fetch: Function, WebSocket: Function, rooms: Map<string, object>, addCharacter: (c: object) => void,
 *            sent: object[], received: object[], invalid: object[]}}
 */
export function createFakeServer({
  characters = [],
  now = () => Date.now(),
  timers = { setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms), clearTimeout: (id) => globalThis.clearTimeout(id) },
  seed = 42,
  reactionTimeoutMs = 20000,
  cinemaCapMs = 4000,
  shareLibrary = false,
  defer = (fn) => { Promise.resolve().then(fn); }
} = {}) {
  const library = new Map(characters.map(c => [String(c.id), clone(c)]));
  const rooms = new Map();          // roomId → room
  const tokens = new Map();         // token → {roomId, memberId}
  const sent = [];
  const received = [];
  const invalid = [];
  let idN = 0;
  const nextId = (p) => `${p}${(++idN).toString(36)}`;
  const rng = mulberry32(seed);

  function newCode() {
    let c = '';
    for (let i = 0; i < 6; i++) c += CODE_ALPHABET[Math.floor(rng() * 32)];
    return rooms.has(c) ? newCode() : c;
  }

  // ------------------------------------------------------------------ rooms

  function createRoom(name) {
    const room = {
      id: nextId('r_'), code: newCode(), name: name || null, status: 'lobby', paused: false, seq: 0,
      members: new Map(), seats: new Map(), chars: new Set(), enc: null, history: [], turn: null,
      review: { plans: false, rolls: false, monsterReactions: false, aiParty: false },
      prompts: new Map(), armed: [], waiters: new Map(), turnN: 0, groupN: 0, promptN: 0, endRequested: null,
      rng: mulberry32(seed), loop: null, initiativeMode: 'individual'
    };
    rooms.set(room.id, room);
    if (shareLibrary) for (const id of library.keys()) room.chars.add(id);
    const dmToken = nextId('tok_dm_');
    const dm = { id: nextId('p_'), role: 'dm', displayName: 'DM', sock: null };
    room.members.set(dm.id, dm);
    tokens.set(dmToken, { roomId: room.id, memberId: dm.id });
    return { roomId: room.id, code: room.code, dmToken, participantId: dm.id };
  }

  function joinRoom(code, displayName) {
    const room = [...rooms.values()].find(r => r.code === String(code || '').toUpperCase());
    if (!room) throw new HttpFail(404, 'ROOM_NOT_FOUND', 'No room with that code');
    const name = String(displayName || '').trim();
    if (!name || name.length > 32) throw new HttpFail(400, 'BAD_NAME', 'Display name must be 1–32 characters');
    const players = [...room.members.values()].filter(m => m.role === 'player');
    if (players.length >= MAX_SEATS) throw new HttpFail(409, 'E_ROOM_FULL', 'The table is full');
    const m = { id: nextId('p_'), role: 'player', displayName: name, sock: null };
    room.members.set(m.id, m);
    const token = nextId('tok_');
    tokens.set(token, { roomId: room.id, memberId: m.id });
    broadcast(room, 'member.joined', { memberId: m.id, displayName: name, role: 'player' });
    return { roomId: room.id, participantId: m.id, token, displayName: name };
  }

  function auth(headers, roomId = null) {
    const h = headers?.Authorization || headers?.authorization || '';
    const t = /^Bearer (.+)$/.exec(h)?.[1];
    const a = t ? tokens.get(t) : null;
    if (!a || (roomId && a.roomId !== roomId)) throw new HttpFail(401, 'UNAUTHENTICATED', 'A token for this room is required');
    const room = rooms.get(a.roomId);
    return { room, member: room.members.get(a.memberId) };
  }

  function publicSeat(s) {
    return {
      seat: s.seat, slotId: s.slotId, characterId: s.characterId, characterName: s.characterName,
      controller: s.memberId ? 'player' : 'ai', memberId: s.memberId, aiArchetype: s.aiArchetype
    };
  }

  function seatChanged(room, n, removed = false) {
    const s = room.seats.get(n);
    broadcast(room, 'seat.updated', {
      characterId: String(s?.characterId ?? removed), memberId: s?.memberId ?? null,
      controller: s?.memberId ? 'player' : 'ai', seat: n, slotId: s?.slotId ?? `slot_${n}`, removed
    });
  }

  function claimSeat(room, member, n, characterId) {
    if (member.role !== 'player') throw new HttpFail(403, 'E_FORBIDDEN', 'Only players claim seats');
    if (!room.chars.has(String(characterId))) throw new HttpFail(404, 'CHAR_NOT_IN_ROOM', 'Import the character into this room first');
    for (const s of room.seats.values()) {
      if (s.characterId === String(characterId) && s.memberId !== member.id) throw new HttpFail(409, 'E_SEAT_TAKEN', 'That character is already seated');
    }
    if (room.seats.has(n) && room.seats.get(n).memberId !== member.id) throw new HttpFail(409, 'E_SEAT_TAKEN', 'That seat is taken');
    const sheet = library.get(String(characterId));
    room.seats.set(n, { seat: n, slotId: room.seats.get(n)?.slotId || nextId('slot_'), characterId: String(characterId), characterName: sheet?.name || null, memberId: member.id, aiArchetype: null });
    seatChanged(room, n);
    return publicSeat(room.seats.get(n));
  }

  function aiSeat(room, member, n, characterId, archetype) {
    if (member.role !== 'dm') throw new HttpFail(403, 'E_FORBIDDEN', 'Only the DM assigns AI seats');
    if (!library.has(String(characterId))) throw new HttpFail(404, 'NOT_FOUND', 'Unknown character');
    room.chars.add(String(characterId));
    const sheet = library.get(String(characterId));
    room.seats.set(n, { seat: n, slotId: room.seats.get(n)?.slotId || nextId('slot_'), characterId: String(characterId), characterName: sheet?.name || null, memberId: null, aiArchetype: archetype || null });
    seatChanged(room, n);
    return publicSeat(room.seats.get(n));
  }

  function releaseSeat(room, member, n) {
    const s = room.seats.get(n);
    if (!s) return { ok: true };
    if (member.role !== 'dm' && s.memberId !== member.id) throw new HttpFail(403, 'E_FORBIDDEN', 'Not your seat');
    room.seats.delete(n);
    broadcast(room, 'seat.updated', { characterId: s.characterId, memberId: null, controller: 'ai', seat: n, slotId: s.slotId, removed: true });
    return { ok: true };
  }

  // -------------------------------------------------------------- outbound

  function message(t, p, seq) {
    const msg = seq === undefined ? { v: PROTOCOL_VERSION, t, ts: now(), p: clone(p) } : { v: PROTOCOL_VERSION, t, seq, ts: now(), p: clone(p) };
    const res = validateServerMessage(msg);
    if (!res.ok) throw new Error(`fake server built an invalid ${t}: ${res.errors.slice(0, 3).map(e => `${e.path} ${e.message}`).join('; ')}`);
    return msg;
  }

  function push(member, msg) {
    if (!member?.sock) return;
    sent.push({ to: member.id, msg });
    member.sock._push(msg);
  }

  function privateTo(room, member, t, p) { push(member, message(t, p)); }

  function broadcast(room, t, p) {
    room.seq += 1;
    const msg = message(t, p, room.seq);
    for (const m of room.members.values()) push(m, msg);
    return msg;
  }

  function emit(room, type, payload, cinemaGroup = null, round = null) {
    const enc = room.enc;
    const ev = { seq: room.seq + 1, type, round: round ?? enc?.state.round ?? 0, turnId: room.turn?.turnId ?? null, cinemaGroup, payload };
    broadcast(room, type, ev);
    if (enc) {
      enc.state.lastEventSeq = ev.seq;
      room.history.push(ev);
      if (room.history.length > 50) room.history.shift();
    }
    return ev;
  }

  function projected(room) {
    if (!room.enc) return null;
    const s = clone(room.enc.state);
    delete s.rng;
    return s;
  }

  function snapshotFor(room, m) {
    const prompt = [...room.prompts.values()].find(p => p.addressee === m.id) || null;
    return {
      seq: room.seq,
      room: {
        id: room.id, code: room.code, name: room.name, status: room.status, paused: room.paused,
        settings: { reactionTimeoutMs },
        members: [...room.members.values()].map(x => ({ id: x.id, displayName: x.displayName, role: x.role, online: !!x.sock })),
        seats: [...room.seats.values()].sort((a, b) => a.seat - b.seat).map(publicSeat),
        encounterId: room.enc?.id ?? null,
        turn: room.turn ? { turnId: room.turn.turnId, actorId: room.turn.actorId, awaitingIntent: !!room.turn.awaiting } : null,
        ...(m.role === 'dm' ? { review: { ...room.review }, armedRolls: room.armed.length } : {})
      },
      encounter: projected(room),
      openPrompt: prompt ? openPayload(prompt) : null,
      history: room.history.slice(-50),
      stateHash: room.enc ? stateHash(room.enc.state) : null
    };
  }

  function snapshotAll(room) {
    for (const m of room.members.values()) if (m.sock) privateTo(room, m, 'room.snapshot', snapshotFor(room, m));
  }

  function setStatus(room, status) {
    if (room.status === status) return;
    room.status = status;
    broadcast(room, 'room.status', { status });
  }

  // --------------------------------------------------------------- prompts

  function openPayload(p) {
    return { promptId: p.promptId, kind: p.kind, payload: clone(p.payload), autoAnswer: clone(p.autoAnswer), deadlineAt: p.deadlineAt, serverNow: now() };
  }

  function ask(room, { kind, addressee, autoAnswer, payload, timeoutMs = reactionTimeoutMs }) {
    const member = addressee ? room.members.get(addressee) : null;
    if (!member || !member.sock) return Promise.resolve({ answer: clone(autoAnswer), by: 'auto' });
    const promptId = `pr_${++room.promptN}`;
    return new Promise((resolve) => {
      const p = { promptId, kind, addressee, payload, autoAnswer, deadlineAt: now() + timeoutMs, resolve, timer: null };
      p.timer = timers.setTimeout(() => settlePrompt(room, p, clone(autoAnswer), 'timeout'), timeoutMs);
      room.prompts.set(promptId, p);
      privateTo(room, member, 'prompt.open', openPayload(p));
    });
  }

  function settlePrompt(room, p, answer, by) {
    if (!room.prompts.has(p.promptId)) return;
    room.prompts.delete(p.promptId);
    timers.clearTimeout(p.timer);
    const member = room.members.get(p.addressee);
    if (member) privateTo(room, member, 'prompt.closed', { promptId: p.promptId, reason: by });
    p.resolve({ answer, by });
  }

  // ---------------------------------------------------------------- engine

  function buildEncounter(room, setup) {
    const cols = setup.grid.cols;
    const rows = setup.grid.rows;
    const placements = setup.placements || {};
    const terrainIn = setup.grid.terrain && typeof setup.grid.terrain.flags === 'string' ? setup.grid.terrain : null;
    const state = {
      v: 1, encounterId: nextId('e_'), round: 0, turnIndex: 0, phase: 'setup',
      rng: { algo: 'mulberry32', s: seed >>> 0 },
      grid: { cols, rows, cellFt: 5, flankingEnabled: false, ...(terrainIn ? { terrain: clone(terrainIn) } : {}) },
      map: setup.map ? clone(setup.map) : null,
      initiative: [], entities: {}, lastEventSeq: room.seq
    };
    const clampPos = (p, fb) => (p && Number.isInteger(p.col) && Number.isInteger(p.row)
      ? { col: Math.max(0, Math.min(cols - 1, p.col)), row: Math.max(0, Math.min(rows - 1, p.row)) } : fb);
    const seats = [...room.seats.values()].sort((a, b) => a.seat - b.seat);
    seats.forEach((s, i) => {
      const sheet = library.get(s.characterId) || demoCharacter(s.characterId, s.characterName || `Seat ${s.seat}`);
      const id = `pc-${s.seat}`;
      state.entities[id] = entityFromSheet(sheet, {
        id,
        pos: clampPos(placements[id], { col: Math.min(i, cols - 1), row: 0 }),
        controller: s.memberId ? { type: 'player', seatId: s.slotId } : { type: 'ai', seatId: null }
      });
    });
    (setup.monsters || []).forEach((m, i) => {
      const slug = MONSTER_PRESETS[m.slug] ? m.slug : 'goblin';
      const id = typeof m.id === 'string' && m.id ? m.id : `m-${i + 1}`;
      state.entities[id] = entityFromPreset(slug, {
        id,
        name: m.name || undefined,
        pos: clampPos(placements[id] || m.pos, { col: Math.min(i, cols - 1), row: rows - 1 }),
        statBlock: { ...(Number.isInteger(m.hp) && m.hp > 0 ? { hpMax: m.hp } : {}), ...(Number.isInteger(m.ac) ? { ac: m.ac } : {}), ...(m.cr != null ? { cr: m.cr } : {}) }
      });
    });
    const v = validateEncounterState(state);
    if (!v.ok) throw new IntentFail('E_INVALID_INTENT', `setup produced an invalid state: ${v.errors[0].path} ${v.errors[0].message}`);
    return state;
  }

  const alive = (e) => e && e.hp > 0;
  const chebyshev = (a, b) => Math.max(Math.abs(a.col - b.col), Math.abs(a.row - b.row)) * 5;

  function attackProfile(state, e) {
    if (e.kind === 'monster') {
      const a = MONSTER_PRESETS[e.statBlock?.slug]?.attack || { name: 'Strike', bonus: 3, dice: '1d6+1' };
      return { name: a.name, bonus: a.bonus ?? 3, dice: a.dice || '1d6', damageType: 'slashing' };
    }
    const sheet = library.get(e.sheetRef?.characterId) || {};
    const w = sheet.equipment?.mainhand || { name: 'Fist', damage: '1', damageType: 'bludgeoning' };
    const mod = Math.max(sheet.abilityModifiers?.STR ?? 0, sheet.abilityModifiers?.DEX ?? 0);
    const dice = (typeof w.damage === 'string' ? w.damage : w.damage?.dice) || '1d4';
    return { name: w.name, bonus: mod + (sheet.proficiencyBonus ?? 2), dice: /[+-]/.test(dice) ? dice : `${dice}+${mod}`, damageType: w.damageType || w.damage?.type || null };
  }

  function rollDice(room, spec, crit) {
    const { n, d, mod } = parseDice(spec);
    let total = mod;
    for (let i = 0; i < n * (crit ? 2 : 1); i++) total += 1 + Math.floor(room.rng() * d);
    return Math.max(0, total);
  }

  function ownerMember(room, e) {
    if (!e) return null;
    if (e.controller?.type === 'player') {
      const seat = [...room.seats.values()].find(s => s.slotId === e.controller.seatId);
      return seat?.memberId ? room.members.get(seat.memberId) || null : null;
    }
    if (e.controller?.type === 'dm') return [...room.members.values()].find(m => m.role === 'dm') || null;
    return null;
  }

  function stepToward(state, actor, target) {
    const occupied = new Set(Object.values(state.entities).filter(o => o.id !== actor.id && alive(o)).map(o => `${o.pos.col},${o.pos.row}`));
    let pos = { ...actor.pos };
    const path = [{ ...pos }];
    for (let ft = 0; ft < (actor.speedFt ?? 30) && chebyshev(pos, target.pos) > 5; ft += 5) {
      const next = { col: pos.col + Math.sign(target.pos.col - pos.col), row: pos.row + Math.sign(target.pos.row - pos.row) };
      if (occupied.has(`${next.col},${next.row}`)) break;
      pos = next;
      path.push({ ...pos });
    }
    return { to: pos, path };
  }

  async function doMove(room, actor, to, path) {
    if (to.col === actor.pos.col && to.row === actor.pos.row) return;
    const from = { ...actor.pos };
    actor.pos = { col: to.col, row: to.row };
    emit(room, 'move', { actorId: actor.id, from, to: { ...actor.pos }, path: (path || [from, to]).map(c => ({ col: c.col, row: c.row })) });
  }

  async function reviewRoll(room, actor, targetId, rollKind, result) {
    const armedAt = room.armed.findIndex(a => a.rollKind === rollKind && (a.entityId == null || a.entityId === actor.id));
    if (armedAt >= 0) {
      const v = room.armed.splice(armedAt, 1)[0].value;
      emit(room, 'dm.override', { kind: `roll.${rollKind}`, entityId: actor.id, before: result, after: v });
      return v;
    }
    if (!room.review.rolls) return result;
    const dm = [...room.members.values()].find(m => m.role === 'dm');
    const r = await ask(room, { kind: 'roll', addressee: dm?.id, autoAnswer: result, payload: { rollKind, entityId: actor.id, targetId, result }, timeoutMs: 8000 });
    const v = Number.isInteger(r.answer) ? r.answer : result;
    if (v !== result) emit(room, 'dm.override', { kind: `roll.${rollKind}`, entityId: actor.id, before: result, after: v });
    return v;
  }

  async function waitCinema(room, exchangeId) {
    const online = [...room.members.values()].filter(m => m.sock).map(m => m.id);
    if (!online.length) return;
    await new Promise((resolve) => {
      const w = { pending: new Set(online), resolve, timer: null };
      w.timer = timers.setTimeout(() => { room.waiters.delete(exchangeId); resolve(); }, cinemaCapMs);
      room.waiters.set(exchangeId, w);
    });
  }

  function cinemaDone(room, memberId, exchangeId) {
    const w = room.waiters.get(exchangeId);
    if (!w) return;
    w.pending.delete(memberId);
    if (w.pending.size === 0) {
      timers.clearTimeout(w.timer);
      room.waiters.delete(exchangeId);
      w.resolve();
    }
  }

  async function doAttack(room, actor, target, weaponName) {
    const state = room.enc.state;
    const prof = attackProfile(state, actor);
    if (chebyshev(actor.pos, target.pos) > 5) {
      const step = stepToward(state, actor, target);
      await doMove(room, actor, step.to, step.path);
      if (chebyshev(actor.pos, target.pos) > 5) return;
    }
    const group = `x${++room.groupN}`;
    const d20 = 1 + Math.floor(room.rng() * 20);
    let kept = d20;
    if (actor.kind === 'monster' || actor.controller.type === 'ai') kept = await reviewRoll(room, actor, target.id, 'attack', d20);
    const crit = kept === 20;
    let total = kept + prof.bonus;
    let hit = crit || (kept !== 1 && total >= target.ac);
    let shielded = false;
    const owner = ownerMember(room, target);
    const slot = Object.entries(target.resources.slots || {}).find(([, l]) => l.max - l.spent > 0);
    if (hit && !crit && owner && owner.role === 'player' && !target.resources.reactionUsed && slot && total < target.ac + 5) {
      emit(room, 'reaction.offered', { reactorId: target.id, kind: 'shield', autoAnswer: true, deadlineMs: reactionTimeoutMs }, group);
      const r = await ask(room, { kind: 'shield', addressee: owner.id, autoAnswer: true, payload: { reactorId: target.id, attackerId: actor.id, total, ac: target.ac } });
      const used = r.answer === true;
      emit(room, 'reaction.resolved', { reactorId: target.id, kind: 'shield', used, by: r.by }, group);
      if (used) {
        target.resources.reactionUsed = true;
        target.resources.slots[slot[0]].spent += 1;
        target.turnFlags = { ...target.turnFlags, shieldActive: true };
        emit(room, 'resource.spent', { entityId: target.id, resource: 'reaction', level: null }, group);
        emit(room, 'resource.spent', { entityId: target.id, resource: 'spell-slot', level: Number(slot[0]) }, group);
        shielded = true;
        hit = false;
      }
    }
    emit(room, 'attack.rolled', {
      attackerId: actor.id, targetId: target.id, weapon: weaponName || prof.name, isReaction: false, advantage: 'normal',
      d20: [d20], kept, bonus: prof.bonus, total, ac: target.ac + (shielded ? 5 : 0), hit, crit, shielded
    }, group);
    const before = target.hp;
    let dmg = 0;
    if (hit) {
      dmg = rollDice(room, prof.dice, crit);
      if (actor.kind === 'monster' || actor.controller.type === 'ai') dmg = await reviewRoll(room, actor, target.id, 'damage', dmg);
      target.hp = Math.max(0, before - dmg);
      emit(room, 'damage', { sourceId: actor.id, targetId: target.id, amount: before - target.hp, type: prof.damageType, hpBefore: before, hpAfter: target.hp }, group);
      if (before > 0 && target.hp === 0) downed(room, target, actor, group);
    }
    emit(room, 'exchange', {
      exchangeId: group, attackerId: actor.id, defenderId: target.id, reaction: false, cast: false,
      roll: { bonus: prof.bonus, total, ac: target.ac, hit, crit, shielded },
      damage: { total: dmg, smite: 0, heal: 0, type: prof.damageType },
      effects: [{ entityId: target.id, hp: { before, after: target.hp, max: target.hpMax } }],
      miss: !hit,
      cinema: {
        weapon: { name: weaponName || prof.name, damageType: prof.damageType, magical: false },
        style: null, swing: null, modifiers: [], smiteSlot: null, attackerLevel: 1,
        killing: before > 0 && target.hp === 0, spell: null, outcome: null,
        fxSeed: room.groupN, durationMs: 0
      }
    }, group);
    await waitCinema(room, group);
  }

  /**
   * A creature dropped to 0 HP. With the E1 wave-5 dying schema (entity
   * `status` / `deathSaves`) a PC is downed and unconscious, a monster
   * dies; before it the state carries nothing beyond hp 0.
   */
  function downed(room, target, actor, group) {
    emit(room, 'entity.downed', { entityId: target.id, byId: actor.id }, group);
    if (!DYING_SCHEMA) return;
    if (target.kind === 'pc') {
      target.status = 'downed';
      target.deathSaves = { successes: 0, failures: 0, stable: false };
    } else {
      target.status = 'dead';
      emit(room, 'entity.died', { entityId: target.id, byId: actor.id, cause: 'monster' }, group);
    }
  }

  function nearestEnemy(state, actor) {
    return Object.values(state.entities)
      .filter(o => o.side !== actor.side && alive(o))
      .sort((a, b) => chebyshev(actor.pos, a.pos) - chebyshev(actor.pos, b.pos) || (a.id < b.id ? -1 : 1))[0] || null;
  }

  async function aiPlan(room, actor) {
    const target = nearestEnemy(room.enc.state, actor);
    let plan = target ? { kind: 'attack', targetId: target.id } : { kind: 'dodge' };
    const reviewable = actor.kind === 'monster' || room.review.aiParty;
    const dm = [...room.members.values()].find(m => m.role === 'dm');
    if (room.review.plans && reviewable && dm?.sock) {
      const breakdown = [{ name: 'nearest', weighted: 1 }];
      privateTo(room, dm, 'turn.planProposed', { entityId: actor.id, plan, breakdown });
      const r = await ask(room, { kind: 'plan', addressee: dm.id, autoAnswer: plan, payload: { entityId: actor.id, plan } });
      if (r.answer === null) {
        emit(room, 'dm.override', { kind: 'plan.skip', entityId: actor.id, before: plan, after: null });
        return null;
      }
      if (r.answer && typeof r.answer === 'object' && JSON.stringify(r.answer) !== JSON.stringify(plan)) {
        emit(room, 'dm.override', { kind: 'plan', entityId: actor.id, before: plan, after: r.answer });
        plan = r.answer;
      }
    }
    return plan;
  }

  async function waitIntent(room, actor) {
    const owner = ownerMember(room, actor);
    if (!owner || !owner.sock) return { kind: 'delegate' };
    room.turn.awaiting = { ownerId: owner.id, actorId: actor.id };
    return new Promise((resolve) => { room.turn.awaiting.resolve = resolve; });
  }

  async function runTurn(room) {
    const state = room.enc.state;
    const entry = state.initiative[state.turnIndex];
    const actor = state.entities[entry.entityId];
    room.turn = { turnId: `t${++room.turnN}`, actorId: actor.id, awaiting: null };
    const round = state.round;
    if (!alive(actor)) {
      emit(room, 'turn.skipped', { actorId: actor.id, reason: 'down' });
    } else {
      // The engine's start-of-turn resets (turn-manager beginTurnResets).
      actor.resources.reactionUsed = false;
      const { shieldActive: _s, dodging: _d, disengaged: _g, ...flags } = actor.turnFlags || {};
      actor.turnFlags = flags;
      emit(room, 'turn.started', { actorId: actor.id });
      let plan = null;
      let source = 'ai';
      if (actor.controller.type === 'ai') {
        plan = await aiPlan(room, actor);
      } else {
        const intent = await waitIntent(room, actor);
        room.turn.awaiting = null;
        if (intent.kind === 'plan') { plan = intent.plan; source = actor.controller.type === 'dm' ? 'dm' : 'player'; }
        else if (intent.kind === 'delegate') plan = await aiPlan(room, actor);
        else plan = null;
      }
      if (room.endRequested) return;
      if (!plan) {
        emit(room, 'turn.skipped', { actorId: actor.id, reason: 'skipped' });
      } else {
        emit(room, 'plan.chosen', { actorId: actor.id, kind: plan.kind, targetId: plan.targetId ?? null, source, weapon: plan.weaponName ?? null, spellId: plan.spellId ?? null });
        if (plan.moveTo) await doMove(room, actor, plan.moveTo, plan.path);
        const target = plan.targetId ? state.entities[plan.targetId] : null;
        if (['attack', 'melee', 'ranged'].includes(plan.kind) && target && alive(target)) await doAttack(room, actor, target, plan.weaponName);
        if (plan.kind === 'dodge') actor.turnFlags = { ...actor.turnFlags, dodging: true };
        if (plan.kind === 'disengage') actor.turnFlags = { ...actor.turnFlags, disengaged: true };
      }
    }
    // Like the real server: the victory check, else advance the turn
    // index — then hash, so turn.ended carries the post-turn state.
    const outcome = outcomeOf(state);
    let wrapped = false;
    if (outcome) {
      state.phase = 'ended';
    } else {
      state.turnIndex += 1;
      if (state.turnIndex >= state.initiative.length) { state.turnIndex = 0; state.round += 1; wrapped = true; }
    }
    emit(room, 'turn.ended', { actorId: actor.id, stateHash: stateHash(state) }, null, round);
    room.turn = null;
    if (outcome) endEncounter(room, outcome, true);
    else if (wrapped) broadcast(room, 'round.started', { round: state.round });
  }

  function outcomeOf(state) {
    const up = (side) => Object.values(state.entities).some(e => e.side === side && alive(e));
    if (!up('hostile')) return 'party-victory';
    if (!up('party')) return 'hostile-victory';
    return null;
  }

  function endEncounter(room, outcome, decided = false) {
    if (!room.enc || (room.enc.state.phase === 'ended' && !decided)) return;
    room.enc.state.phase = 'ended';
    emit(room, 'encounter.ended', { outcome, round: room.enc.state.round });
    for (const p of [...room.prompts.values()]) settlePrompt(room, p, clone(p.autoAnswer), 'cancelled');
    setStatus(room, 'encounter-over');
  }

  async function loop(room) {
    while (room.enc && room.enc.state.phase === 'running' && !room.paused) {
      await runTurn(room);
      if (room.endRequested) { endEncounter(room, room.endRequested); room.endRequested = null; break; }
    }
    room.loop = null;
  }

  function startLoop(room) {
    if (!room.loop) room.loop = loop(room).catch((err) => { room.loop = null; room.failure = err; });
  }

  // ------------------------------------------------------------ dm commands

  function patchEntity(room, p) {
    const state = room.enc.state;
    const e = state.entities[p.entityId];
    if (!e) throw new IntentFail('E_INVALID_INTENT', 'unknown entity');
    const before = {};
    const patch = {};
    if (Number.isInteger(p.hp)) { before.hp = e.hp; e.hp = Math.min(e.hpMax, p.hp); patch.hp = e.hp; }
    if (Number.isInteger(p.hpTemp)) { before.hpTemp = e.hpTemp; e.hpTemp = p.hpTemp; patch.hpTemp = e.hpTemp; }
    if (p.addConditions || p.removeConditions) {
      before.conditions = clone(e.conditions);
      const ids = new Set(e.conditions.map(c => (typeof c === 'string' ? c : c.id)));
      for (const c of p.addConditions || []) ids.add(c);
      for (const c of p.removeConditions || []) ids.delete(c);
      e.conditions = [...ids];
      patch.conditions = clone(e.conditions);
    }
    if (p.position) {
      const g = state.grid;
      if (p.position.col >= g.cols || p.position.row >= g.rows) throw new IntentFail('E_INVALID_INTENT', 'off the grid');
      before.pos = clone(e.pos);
      e.pos = { col: p.position.col, row: p.position.row };
      patch.pos = clone(e.pos);
    }
    broadcast(room, 'entity.updated', { entityId: e.id, patch, cause: 'dm.entity.patch' });
    emit(room, 'dm.override', { kind: 'entity.patch', entityId: e.id, before, after: patch });
  }

  function requireEnc(room) {
    if (!room.enc || room.enc.state.phase === 'ended') throw new IntentFail('E_INVALID_INTENT', 'no live encounter');
  }

  async function dispatch(room, m, msg) {
    const role = INTENT_ROLES[msg.t];
    if (role === 'dm' && m.role !== 'dm') throw new IntentFail('E_FORBIDDEN', `${msg.t} is DM-only`);
    if (role === 'player' && m.role !== 'player') throw new IntentFail('E_FORBIDDEN', `${msg.t} is for players`);
    const p = msg.p;
    switch (msg.t) {
      case 'resync': privateTo(room, m, 'room.snapshot', snapshotFor(room, m)); return {};
      case 'cinema.done': cinemaDone(room, m.id, p.exchangeId); return {};
      case 'seat.claim': {
        const mine = [...room.seats.values()].find(s => s.characterId === p.characterId && s.memberId === m.id);
        let n = mine?.seat;
        for (let k = 1; k <= MAX_SEATS && !n; k++) if (!room.seats.has(k)) n = k;
        if (!n) throw new IntentFail('E_ROOM_FULL', 'no free seat');
        try { return { seat: claimSeat(room, m, n, p.characterId).seat }; } catch (err) { throw new IntentFail(err.code === 'E_SEAT_TAKEN' ? 'E_SEAT_TAKEN' : 'E_INVALID_INTENT', err.message); }
      }
      case 'seat.release': {
        const s = [...room.seats.values()].find(x => x.characterId === p.characterId && x.memberId === m.id);
        if (!s) throw new IntentFail('E_INVALID_INTENT', 'you hold no seat with that character');
        releaseSeat(room, m, s.seat);
        return {};
      }
      case 'char.setStyle': return {};
      case 'turn.act':
      case 'turn.delegate': {
        const aw = room.turn?.awaiting;
        if (!aw || room.turn.turnId !== p.turnId) throw new IntentFail('E_STALE', 'that turn is not waiting for an action');
        if (aw.ownerId !== m.id) throw new IntentFail('E_NOT_YOUR_TURN', 'not your turn');
        if (msg.t === 'turn.delegate') { aw.resolve({ kind: 'delegate' }); return {}; }
        aw.resolve({ kind: 'plan', plan: clone(p.plan) });
        return {};
      }
      case 'prompt.answer':
      case 'dm.prompt.force': {
        const pr = room.prompts.get(p.promptId);
        if (!pr) throw new IntentFail('E_STALE', 'that prompt is closed');
        if (msg.t === 'prompt.answer' && pr.addressee !== m.id) throw new IntentFail('E_FORBIDDEN', 'that prompt is not yours');
        settlePrompt(room, pr, clone(p.answer), msg.t === 'dm.prompt.force' ? 'dm' : 'player');
        return {};
      }
      case 'dm.encounter.setup': {
        if (room.enc && room.enc.state.phase === 'running') throw new IntentFail('E_INVALID_INTENT', 'an encounter is running; end it first');
        const state = buildEncounter(room, p);
        room.enc = { id: state.encounterId, state };
        room.initiativeMode = p.initiativeMode || 'individual';
        room.history = [];
        broadcast(room, 'encounter.created', { encounterId: state.encounterId, encounter: projected(room) });
        setStatus(room, 'setup');
        return { encounterId: state.encounterId };
      }
      case 'dm.encounter.start': {
        if (!room.enc || room.enc.state.phase !== 'setup') throw new IntentFail('E_INVALID_INTENT', 'set up an encounter first');
        const state = room.enc.state;
        if (Number.isInteger(p.seed)) room.rng = mulberry32(p.seed);
        if (!state.initiative.length) {
          const groups = new Map();
          state.initiative = Object.keys(state.entities).sort().map((id) => {
            const e = state.entities[id];
            const key = room.initiativeMode === 'grouped' && e.kind === 'monster' ? `g:${e.statBlock?.slug}` : id;
            if (!groups.has(key)) groups.set(key, 1 + Math.floor(room.rng() * 20));
            return { entityId: id, score: groups.get(key) };
          }).sort((a, b) => b.score - a.score || (a.entityId < b.entityId ? -1 : 1));
        }
        state.round = 1;
        state.turnIndex = 0;
        state.phase = 'running';
        broadcast(room, 'encounter.initiative', { order: state.initiative.map(r => ({ entityId: r.entityId, score: r.score })) });
        broadcast(room, 'round.started', { round: 1 });
        room.paused = false;
        setStatus(room, 'in-encounter');
        startLoop(room);
        return {};
      }
      case 'dm.initiative.set':
      case 'dm.initiative.roll': {
        requireEnc(room);
        if (room.turn) throw new IntentFail('E_STALE', 'initiative can change only between turns');
        const st = room.enc.state;
        const ids = Object.keys(st.entities);
        if (msg.t === 'dm.initiative.set') {
          if (p.order.length !== ids.length || !p.order.every(id => st.entities[id])) throw new IntentFail('E_INVALID_INTENT', 'the order must list every creature once');
          const old = new Map(st.initiative.map(r => [r.entityId, r.score]));
          st.initiative = p.order.map((id, i) => ({ entityId: id, score: old.get(id) ?? p.order.length - i }));
        } else {
          st.initiative = ids.sort().map(id => ({ entityId: id, score: 1 + Math.floor(room.rng() * 20) }))
            .sort((a, b) => b.score - a.score || (a.entityId < b.entityId ? -1 : 1));
        }
        st.turnIndex = 0;
        broadcast(room, 'encounter.initiative', { order: st.initiative.map(r => ({ entityId: r.entityId, score: r.score })) });
        return {};
      }
      case 'dm.encounter.end': {
        requireEnc(room);
        const outcome = p.outcome || 'dm-ended';
        if (!room.turn) { endEncounter(room, outcome); return {}; }
        room.endRequested = outcome;
        room.turn.awaiting?.resolve({ kind: 'skip' });
        for (const pr of [...room.prompts.values()]) settlePrompt(room, pr, clone(pr.autoAnswer), 'cancelled');
        for (const [id, w] of room.waiters) { timers.clearTimeout(w.timer); room.waiters.delete(id); w.resolve(); }
        return { queued: true };
      }
      case 'dm.pause': requireEnc(room); room.paused = true; setStatus(room, 'paused'); return {};
      case 'dm.resume': requireEnc(room); room.paused = false; setStatus(room, 'in-encounter'); startLoop(room); return {};
      case 'dm.turn.skip': {
        const aw = room.turn?.awaiting;
        if (!aw) throw new IntentFail('E_STALE', 'only a turn waiting for an action can be skipped');
        aw.resolve({ kind: 'skip' });
        return {};
      }
      case 'dm.review.set':
        for (const k of ['plans', 'rolls', 'monsterReactions', 'aiParty']) if (typeof p[k] === 'boolean') room.review[k] = p[k];
        return { review: { ...room.review } };
      case 'dm.roll.arm':
        room.armed.push({ entityId: p.entityId ?? null, rollKind: p.rollKind, value: p.value });
        return { armed: room.armed.length };
      case 'dm.entity.patch': requireEnc(room); patchEntity(room, p); return {};
      case 'dm.entity.add': {
        requireEnc(room);
        const e = clone(p.entity);
        if (!e?.id || room.enc.state.entities[e.id]) throw new IntentFail('E_INVALID_INTENT', 'entity needs a new id');
        room.enc.state.entities[e.id] = e;
        if (room.enc.state.initiative.length) {
          const score = Number.isFinite(p.initiativeScore) ? p.initiativeScore : 1 + Math.floor(room.rng() * 20);
          room.enc.state.initiative.push({ entityId: e.id, score });
        }
        if (!validateEncounterState(room.enc.state).ok) {
          delete room.enc.state.entities[e.id];
          room.enc.state.initiative = room.enc.state.initiative.filter(r => r.entityId !== e.id);
          throw new IntentFail('E_INVALID_INTENT', 'that entity is not a valid EncounterState entity');
        }
        emit(room, 'dm.override', { kind: 'entity.add', entityId: e.id, before: null, after: null });
        snapshotAll(room);
        return {};
      }
      case 'dm.entity.remove': {
        requireEnc(room);
        const st = room.enc.state;
        if (!st.entities[p.entityId]) throw new IntentFail('E_INVALID_INTENT', 'unknown entity');
        const idx = st.initiative.findIndex(r => r.entityId === p.entityId);
        delete st.entities[p.entityId];
        if (idx >= 0) {
          st.initiative.splice(idx, 1);
          if (idx < st.turnIndex) st.turnIndex -= 1;
          if (st.turnIndex >= st.initiative.length) st.turnIndex = 0;
        }
        emit(room, 'dm.override', { kind: 'entity.remove', entityId: p.entityId, before: null, after: null });
        snapshotAll(room);
        return {};
      }
      case 'dm.terrain.paint': {
        requireEnc(room);
        const g = room.enc.state.grid;
        const base = asTerrain(g.terrain) || { v: 1, cols: g.cols, rows: g.rows, cells: new Uint8Array(g.cols * g.rows) };
        g.terrain = encodeTerrain(applyTerrainPaint(base, { cells: p.cells, flag: p.flags, op: p.mode }));
        snapshotAll(room);
        return {};
      }
      case 'dm.seat.setController': {
        requireEnc(room);
        const e = room.enc.state.entities[p.entityId];
        if (!e) throw new IntentFail('E_INVALID_INTENT', 'unknown entity');
        if (p.controller === 'player') throw new IntentFail('E_INVALID_INTENT', 'seat a player through seat.claim');
        e.controller = { type: p.controller, seatId: null };
        broadcast(room, 'entity.updated', { entityId: e.id, patch: { controller: clone(e.controller) }, cause: 'dm.seat.setController' });
        return {};
      }
      case 'dm.spell.adjudicate': {
        requireEnc(room);
        const st = room.enc.state;
        const caster = st.entities[p.casterId];
        if (!caster) throw new IntentFail('E_INVALID_INTENT', 'unknown caster');
        for (const t of p.targets) if (!st.entities[t.entityId]) throw new IntentFail('E_INVALID_INTENT', `unknown target ${t.entityId}`);
        if (p.slotLevel) {
          const l = caster.resources.slots[String(p.slotLevel)];
          if (!l || l.max - l.spent <= 0) throw new IntentFail('E_INVALID_INTENT', `${caster.name} has no level-${p.slotLevel} slot left`);
          l.spent += 1;
        }
        const group = `adj${++room.groupN}`;
        emit(room, 'spell.cast', { casterId: caster.id, spellId: p.spellId, castAtLevel: p.slotLevel ?? 0, slotSpent: p.slotLevel ?? null, innate: false, targetIds: p.targets.map(t => t.entityId), adjudicated: true }, group);
        if (p.slotLevel) emit(room, 'resource.spent', { entityId: caster.id, resource: 'spell-slot', level: p.slotLevel }, group);
        for (const t of p.targets) {
          const e = st.entities[t.entityId];
          if (t.damage) {
            const before = e.hp;
            e.hp = Math.max(0, before - t.damage);
            emit(room, 'damage', { sourceId: caster.id, targetId: e.id, amount: before - e.hp, type: t.type ?? null, hpBefore: before, hpAfter: e.hp }, group);
            if (before > 0 && e.hp === 0) emit(room, 'entity.downed', { entityId: e.id, byId: caster.id }, group);
          }
          if (t.healed) {
            const before = e.hp;
            e.hp = Math.min(e.hpMax, before + t.healed);
            emit(room, 'heal', { sourceId: caster.id, targetId: e.id, amount: e.hp - before, hpBefore: before, hpAfter: e.hp }, group);
          }
          for (const c of t.conditions || []) {
            if (e.conditions.some(x => (typeof x === 'string' ? x : x.id) === c)) continue;
            e.conditions = [...e.conditions, c];
            emit(room, 'condition.applied', { entityId: e.id, condition: c, sourceId: caster.id }, group);
          }
        }
        emit(room, 'dm.override', { kind: 'spell.adjudicate', entityId: caster.id, before: null, after: { spellId: p.spellId, targets: clone(p.targets) } });
        return {};
      }
      case 'dm.member.revoke': {
        const x = room.members.get(p.memberId);
        if (!x || x.role === 'dm') throw new IntentFail('E_INVALID_INTENT', 'unknown member');
        room.members.delete(x.id);
        broadcast(room, 'member.left', { memberId: x.id, reason: 'kicked' });
        x.sock?.close(4403, 'removed by the DM');
        return {};
      }
      default:
        throw new IntentFail('E_UNKNOWN_TYPE', `unhandled ${msg.t}`);
    }
  }

  // ------------------------------------------------------------- sockets

  function onClientMessage(sock, raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { sock.close(1008, 'bad frame'); return; }
    received.push(msg);
    const v = validateClientMessage(msg);
    if (!v.ok) {
      invalid.push({ msg, errors: v.errors });
      const t = sock.member ? sock.room : null;
      const err = message('error', { cid: typeof msg?.cid === 'string' ? msg.cid.slice(0, 64) : null, code: 'E_BAD_MESSAGE', message: v.errors.map(e => `${e.path} ${e.message}`).join('; ') });
      if (t) push(sock.member, err); else sock._push(err);
      return;
    }
    if (!sock.member) {
      if (msg.t !== 'hello') { sock.close(4401, 'hello first'); return; }
      const a = tokens.get(msg.p.token);
      if (!a) {
        sock._push(message('error', { cid: msg.cid, code: 'E_UNAUTHENTICATED', message: 'unknown token' }));
        sock.close(4401, 'bad token');
        return;
      }
      const room = rooms.get(a.roomId);
      const m = room.members.get(a.memberId);
      if (!m) { sock.close(4403, 'revoked'); return; }
      const old = m.sock;
      m.sock = sock;
      sock.member = m;
      sock.room = room;
      if (old && old !== sock) old.close(4409, 'superseded');
      privateTo(room, m, 'hello.ok', {
        memberId: m.id, role: m.role, seats: [...room.seats.values()].map(publicSeat), serverNow: now(),
        cfg: { protocol: PROTOCOL_VERSION, roomId: room.id, code: room.code, reactionTimeoutMs, helloCid: msg.cid }
      });
      privateTo(room, m, 'room.snapshot', snapshotFor(room, m));
      if (!old) broadcast(room, 'member.presence', { memberId: m.id, online: true });
      return;
    }
    const { room, member } = sock;
    Promise.resolve()
      .then(() => dispatch(room, member, msg))
      .then((extra) => privateTo(room, member, 'ack', { cid: msg.cid, ok: true, ...(extra || {}) }))
      .catch((err) => privateTo(room, member, 'error', { cid: msg.cid, code: err.code && /^E_/.test(err.code) ? err.code : 'E_INTERNAL', message: String(err.message || err) }));
  }

  function detach(sock) {
    const m = sock.member;
    if (!m || m.sock !== sock) return;
    m.sock = null;
    const room = sock.room;
    for (const id of [...room.waiters.keys()]) cinemaDone(room, m.id, id);
    if (room.members.has(m.id)) broadcast(room, 'member.presence', { memberId: m.id, online: false });
  }

  class FakeSocket {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.member = null;
      this.room = null;
      this.onopen = this.onmessage = this.onclose = this.onerror = null;
      defer(() => {
        if (this.readyState !== 0) return;
        this.readyState = 1;
        this.onopen?.({});
      });
    }
    send(text) {
      if (this.readyState !== 1) throw new Error('socket not open');
      defer(() => onClientMessage(this, text));
    }
    close(code = 1000, reason = '') {
      if (this.readyState >= 2) return;
      this.readyState = 3;
      detach(this);
      defer(() => this.onclose?.({ code, reason }));
    }
    _push(msg) {
      if (this.readyState !== 1) return;
      const data = JSON.stringify(msg);
      defer(() => { if (this.readyState === 1) this.onmessage?.({ data }); });
    }
  }

  // ---------------------------------------------------------------- http

  async function fetchImpl(url, init = {}) {
    const u = new URL(url, 'http://fake.local');
    const path = u.pathname;
    const method = (init.method || 'GET').toUpperCase();
    const headers = init.headers || {};
    const body = typeof init.body === 'string' ? (() => { try { return JSON.parse(init.body); } catch { return {}; } })() : {};
    try {
      if (method === 'POST' && path === '/api/rooms') return response(201, createRoom(body.name));
      if (method === 'POST' && path === '/api/rooms/join') return response(201, joinRoom(body.code, body.displayName));
      if (method === 'GET' && path === '/api/monsters/search') {
        const q = String(u.searchParams.get('q') || '').toLowerCase();
        const results = Object.values(MONSTER_PRESETS)
          .filter(p => !q || p.name.toLowerCase().includes(q) || p.slug.includes(q))
          .map(p => ({ slug: p.slug, name: p.name, type: 'humanoid', cr: null, hp: p.defaultHp?.max ?? null }));
        return response(200, { results });
      }
      if (method === 'POST' && path === '/api/import') {
        const { room, member } = auth(headers, u.searchParams.get('room'));
        const raw = body.json ? (body.json.data || body.json) : null;
        if (!raw) throw new HttpFail(400, 'BAD_REQUEST', 'The fake server imports pasted JSON only');
        const sheet = raw.hp && raw.equipment ? clone(raw) : demoCharacter(String(raw.id ?? nextId('c')), String(raw.name || 'Imported'));
        sheet.id = `paste:${room.id}:${sheet.id}`;
        library.set(sheet.id, sheet);
        room.chars.add(sheet.id);
        void member;
        return response(200, { character: sheet, previous: null, source: 'paste' });
      }
      if (method === 'GET' && path === '/api/characters') {
        const { room } = auth(headers, u.searchParams.get('room'));
        return response(200, { characters: [...room.chars].map(id => ({ ddbId: id, name: library.get(id)?.name || id, source: 'paste' })) });
      }
      let m = /^\/api\/characters\/([^/]+)$/.exec(path);
      if (method === 'GET' && m) {
        const c = library.get(decodeURIComponent(m[1]));
        return c ? response(200, { character: c }) : response(404, { error: 'Not found', code: 'NOT_FOUND' });
      }
      m = /^\/api\/rooms\/([^/]+)(\/.*)?$/.exec(path);
      if (m) {
        const roomId = decodeURIComponent(m[1]);
        const rest = m[2] || '';
        const { room, member } = auth(headers, roomId);
        if (method === 'GET' && rest === '') {
          return response(200, { room: { id: room.id, code: room.code, status: room.status }, me: { id: member.id, role: member.role }, members: [...room.members.values()].map(x => ({ id: x.id, displayName: x.displayName, role: x.role })), seats: [...room.seats.values()].map(publicSeat) });
        }
        if (method === 'POST' && rest === '/kick') {
          if (member.role !== 'dm') throw new HttpFail(403, 'E_FORBIDDEN', 'Only the DM can kick');
          const x = room.members.get(body.participantId);
          if (x && x.role !== 'dm') {
            room.members.delete(x.id);
            broadcast(room, 'member.left', { memberId: x.id, reason: 'kicked' });
            x.sock?.close(4403, 'removed by the DM');
          }
          return response(200, { ok: true });
        }
        const seat = /^\/seats\/(\d+)(\/claim|\/ai)?$/.exec(rest);
        if (seat) {
          const n = Number(seat[1]);
          if (n < 1 || n > MAX_SEATS) throw new HttpFail(400, 'BAD_SEAT', 'Seats are 1–6');
          if (method === 'POST' && seat[2] === '/claim') return response(200, { seat: claimSeat(room, member, n, body.characterId) });
          if (method === 'POST' && seat[2] === '/ai') return response(200, { seat: aiSeat(room, member, n, body.characterId, body.archetype) });
          if (method === 'DELETE' && !seat[2]) return response(200, releaseSeat(room, member, n));
        }
        if (method === 'PUT' && rest === '/maps') {
          if (member.role !== 'dm') throw new HttpFail(403, 'E_FORBIDDEN', 'Only the DM uploads maps');
          return response(201, { mapId: nextId('map_'), url: null, mime: 'image/png', width: 0, height: 0, bytes: 0, sha256: null });
        }
      }
      return response(404, { error: 'Not found', code: 'NOT_FOUND' });
    } catch (err) {
      if (err instanceof HttpFail) return response(err.status, { error: err.message, code: err.code });
      return response(500, { error: String(err.message || err), code: 'INTERNAL' });
    }
  }

  return {
    fetch: fetchImpl,
    WebSocket: FakeSocket,
    rooms,
    sent,
    received,
    invalid,
    addCharacter(c) { library.set(String(c.id), clone(c)); },
    /** Put a library character into a room's import list (what POST /api/import?room does). */
    shareCharacter(roomId, characterId) { rooms.get(roomId)?.chars.add(String(characterId)); }
  };
}
