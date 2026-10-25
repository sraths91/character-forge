/**
 * M64 C9 — S1 Lobby / room.
 *
 * Out of a room: "Create room" (you become the DM) or join with a room
 * code + display name. In a room: the code with a copy-link button, the
 * six seats with role badges, and every member with a connection dot.
 *
 * M65 C28: out of a room, the tables this device holds creds for (by room
 * code) are listed with Rejoin and "Forget this device"; joining a code
 * the device already holds is a rejoin (no name needed, same seat).
 *
 * mount(root, ctx) → unmount. ctx: {store, room: {code, role}|null,
 * actions: {createRoom(name?), joinRoom(code, name), leave?(), copyLink?(code),
 * rememberedRooms?() → [{code, role, displayName}], rejoin?(code), forgetRoom?(code)},
 * prefillCode?: string}
 */

import { h, replace, createScope, delegate, attempt } from './dom.js';
import { membersOf, seatsOf, isDm } from '../selectors.js';

/**
 * @param {HTMLElement} root
 * @param {object} ctx
 * @returns {() => void} unmount
 */
export function mount(root, ctx) {
  const doc = root.ownerDocument;
  const scope = createScope();
  const status = h(doc, 'p', { class: 'play-status', attrs: { role: 'status', 'aria-live': 'polite' } });
  const view = h(doc, 'section', { class: 'play-view play-lobby' });
  const say = (msg, kind = 'info') => { status.textContent = msg || ''; status.dataset.kind = kind; };

  // Entry forms (built once so typing survives store updates).
  const codeIn = h(doc, 'input', { type: 'text', name: 'code', placeholder: 'Room code', value: ctx.prefillCode || '', dataset: { action: 'join-field' }, attrs: { maxlength: 6, autocomplete: 'off', 'aria-label': 'Room code' } });
  const nameIn = h(doc, 'input', { type: 'text', name: 'displayName', placeholder: 'Your name', dataset: { action: 'join-field' }, attrs: { maxlength: 32, 'aria-label': 'Display name' } });
  const roomNameIn = h(doc, 'input', { type: 'text', name: 'roomName', placeholder: 'Table name (optional)', attrs: { maxlength: 64, 'aria-label': 'Table name' } });
  const entry = h(doc, 'div', { class: 'play-lobby-entry' }, [
    h(doc, 'div', { class: 'play-card' }, [
      h(doc, 'h2', { text: 'Run a table' }),
      h(doc, 'p', { class: 'hint-line', text: 'Create a room and share the code. You are the DM.' }),
      roomNameIn,
      h(doc, 'button', { type: 'button', class: 'play-btn primary', dataset: { action: 'create' }, text: 'Create room' })
    ]),
    h(doc, 'div', { class: 'play-card' }, [
      h(doc, 'h2', { text: 'Join a table' }),
      codeIn,
      nameIn,
      h(doc, 'button', { type: 'button', class: 'play-btn primary', dataset: { action: 'join' }, text: 'Join' })
    ])
  ]);
  const roomPanel = h(doc, 'div', { class: 'play-lobby-room' });
  const remembered = h(doc, 'div', { class: 'play-card play-remembered' });
  view.appendChild(status);
  view.appendChild(remembered);
  view.appendChild(entry);
  view.appendChild(roomPanel);
  root.appendChild(view);

  function doJoin() {
    const code = codeIn.value.trim().toUpperCase();
    const name = nameIn.value.trim();
    if (!/^[0-9A-Z]{6}$/.test(code)) { say('Room codes are 6 letters / digits.', 'error'); return; }
    const known = (ctx.actions.rememberedRooms?.() || []).some(r => r.code === code);
    if (!name && !known) { say('Pick a display name.', 'error'); return; }
    say('Joining…');
    attempt(async () => { await ctx.actions.joinRoom(code, name); say(''); },
      (e) => say(e.code === 'ROOM_NOT_FOUND' || e.status === 404 ? 'No room with that code.' : e.message, 'error'));
  }

  delegate(scope, view, 'click', {
    create: () => {
      say('Creating room…');
      attempt(async () => { await ctx.actions.createRoom(roomNameIn.value.trim() || null); say(''); }, (e) => say(e.message, 'error'));
    },
    join: () => doJoin(),
    rejoin: (el) => {
      say('Rejoining…');
      attempt(async () => { await ctx.actions.rejoin(el.dataset.code); say(''); }, (e) => say(e.message, 'error'));
    },
    'forget-room': (el) => { ctx.actions.forgetRoom?.(el.dataset.code); renderRemembered(); say('Forgotten on this device.'); },
    copy: () => attempt(() => ctx.actions.copyLink?.(ctx.room?.code), (e) => say(e.message, 'error')).then(() => say('Link copied.')),
    leave: () => attempt(() => ctx.actions.leave?.(), (e) => say(e.message, 'error'))
  });
  delegate(scope, view, 'keydown', {
    'join-field': (_el, e) => { if (e.key === 'Enter') doJoin(); }
  });

  // seat.updated carries no character name; the sheet cache does.
  const sheetName = (id) => (typeof ctx.sheets === 'function' ? ctx.sheets()[id]?.name : null) || null;

  function seatRow(seat, members) {
    const holder = seat.memberId ? members.find(m => m.memberId === seat.memberId) : null;
    const badge = !seat.characterId ? 'empty' : seat.controller === 'player' ? 'player' : 'ai';
    return h(doc, 'li', { class: `play-seat seat-${badge}`, dataset: { seat: seat.seat } }, [
      h(doc, 'span', { class: 'play-seat-n', text: `Seat ${seat.seat}` }),
      h(doc, 'span', { class: 'play-seat-char', text: seat.characterName || (seat.characterId ? (sheetName(seat.characterId) || seat.characterId) : 'Empty') }),
      h(doc, 'span', { class: `play-badge badge-${badge}`, text: badge === 'player' ? (holder?.displayName || 'Player') : badge === 'ai' ? `AI${seat.aiArchetype ? ` · ${seat.aiArchetype}` : ''}` : '—' }),
      holder ? h(doc, 'span', { class: `play-dot ${holder.online ? 'online' : 'offline'}`, title: holder.online ? 'connected' : 'disconnected', attrs: { 'aria-label': holder.online ? 'connected' : 'disconnected' } }) : null
    ]);
  }

  function renderRemembered() {
    const rows = !ctx.room && ctx.actions.rememberedRooms ? ctx.actions.rememberedRooms() : [];
    remembered.hidden = !rows.length;
    replace(doc, remembered, rows.length ? [
      h(doc, 'h2', { text: 'Your tables on this device' }),
      h(doc, 'ul', { class: 'play-remembered-list' }, rows.map(r => h(doc, 'li', { class: 'play-row', dataset: { code: r.code } }, [
        h(doc, 'strong', { class: 'play-room-code', text: r.code }),
        h(doc, 'span', { class: 'dim', text: ` ${r.role === 'dm' ? 'DM' : (r.displayName || 'Player')} ` }),
        h(doc, 'button', { type: 'button', class: 'play-btn small primary', dataset: { action: 'rejoin', code: r.code }, text: 'Rejoin' }),
        h(doc, 'button', { type: 'button', class: 'play-btn small', dataset: { action: 'forget-room', code: r.code }, attrs: { 'aria-label': `Forget room ${r.code} on this device` }, text: 'Forget this device' })
      ])))
    ] : []);
  }

  function render() {
    const s = ctx.store?.getState?.() || null;
    const inRoom = !!ctx.room;
    renderRemembered();
    entry.hidden = inRoom;
    if (!inRoom) { replace(doc, roomPanel, []); return; }
    const members = membersOf(s);
    const seats = seatsOf(s);
    replace(doc, roomPanel, [
      h(doc, 'div', { class: 'play-room-head' }, [
        h(doc, 'span', { class: 'play-room-label', text: 'Room code' }),
        h(doc, 'strong', { class: 'play-room-code', text: ctx.room.code || s?.room?.code || '……' }),
        h(doc, 'button', { type: 'button', class: 'play-btn', dataset: { action: 'copy' }, text: 'Copy link' }),
        h(doc, 'span', { class: 'play-role', text: isDm(s) || ctx.room.role === 'dm' ? 'You are the DM' : 'You are a player' })
      ]),
      h(doc, 'h3', { text: 'Seats' }),
      h(doc, 'ol', { class: 'play-seats' }, seats.map(seat => seatRow(seat, members))),
      h(doc, 'h3', { text: 'At the table' }),
      h(doc, 'ul', { class: 'play-members' }, members.map(m => h(doc, 'li', { class: 'play-member' }, [
        h(doc, 'span', { class: `play-dot ${m.online ? 'online' : 'offline'}`, attrs: { 'aria-label': m.online ? 'connected' : 'disconnected' } }),
        h(doc, 'span', { text: m.displayName }),
        h(doc, 'span', { class: `play-badge badge-${m.role}`, text: m.role === 'dm' ? 'DM' : 'Player' })
      ]))),
      ctx.waitingForSetup ? h(doc, 'p', { class: 'play-waiting', text: 'The DM is preparing the encounter…' }) : null
    ]);
  }

  if (ctx.store?.subscribe) {
    scope.add(ctx.store.subscribe((a) => [a.room, a.members, a.seats, a.me], () => render(), (x, y) => x.every((v, i) => v === y[i])));
  }
  render();

  return function unmount() {
    scope.dispose();
    if (view.parentNode) view.parentNode.removeChild(view);
  };
}
