/**
 * M64 C9 — S2 Claim a character.
 *
 * Players import a character (D&D Beyond share URL, or pasted JSON for a
 * private one) into the room through `POST /api/import?room=` — always
 * using the returned `character.id`, since a paste becomes
 * `paste:<roomId>:<id>` — or pick one already imported, then claim it
 * with the `seat.claim` intent (the server picks the seat). A character
 * seated by someone else is shown as taken.
 *
 * The DM sees every seat with the derived AC / HP / level, can unassign
 * a seat (`DELETE /api/rooms/:id/seats/:n`) or fill an empty one with an
 * AI-run character and archetype (`POST …/seats/:n/ai`), and moves on to
 * encounter setup once at least one seat is filled. A line tells everyone
 * whether characters start rested or import their current HP / slots
 * (the DM's room setting, M64 1.5).
 *
 * mount(root, ctx) → unmount. ctx: {store, api, send, room: {roomId, role},
 * loadSheet(characterId) → Promise<sheet>, actions: {openSetup()}, archetypes?: string[]}
 */

import { h, replace, createScope, delegate, attempt, select } from './dom.js';
import { seatsOf, membersOf, isDm, myMemberId, seedingCopy } from '../selectors.js';
import { deriveAC } from '../../scene/pc-stats.js';
import { PC_PROFILES } from '../../scene/ai/pc-profiles.js';
import { mount as mountRoomSettings } from './room-settings.js';

/**
 * AC / HP / level for the DM's seat table.
 * @param {object|null} sheet — parsed character
 * @returns {{ac: number|null, hp: number|null, level: number|null}}
 */
export function derivedSeatStats(sheet) {
  if (!sheet) return { ac: null, hp: null, level: null };
  const level = (sheet.classes || []).reduce((n, c) => n + (Number(c?.level) || 0), 0) || sheet.level || null;
  let ac = null;
  try { ac = deriveAC(sheet); } catch { ac = null; }
  return { ac, hp: sheet.hp?.max ?? null, level };
}

/**
 * @param {HTMLElement} root
 * @param {object} ctx
 * @returns {() => void} unmount
 */
export function mount(root, ctx) {
  const doc = root.ownerDocument;
  const scope = createScope();
  const roomId = ctx.room?.roomId;
  const archetypes = ctx.archetypes || Object.keys(PC_PROFILES);
  let characters = [];          // [{ddbId, name}]
  const stats = new Map();      // characterId → derived stats
  let disposed = false;

  const view = h(doc, 'section', { class: 'play-view play-claim' });
  const status = h(doc, 'p', { class: 'play-status', attrs: { role: 'status', 'aria-live': 'polite' } });
  const say = (msg, kind = 'info') => { status.textContent = msg || ''; status.dataset.kind = kind; };
  const urlIn = h(doc, 'input', { type: 'url', placeholder: 'D&D Beyond character URL', attrs: { 'aria-label': 'D&D Beyond character URL' } });
  const pasteIn = h(doc, 'textarea', { rows: 3, placeholder: '…or paste the character JSON (private characters)', attrs: { 'aria-label': 'Character JSON' } });
  const importCard = h(doc, 'div', { class: 'play-card play-import' }, [
    h(doc, 'h3', { text: 'Bring a character' }),
    urlIn,
    pasteIn,
    h(doc, 'button', { type: 'button', class: 'play-btn', dataset: { action: 'import' }, text: 'Import' })
  ]);
  const charList = h(doc, 'ul', { class: 'play-char-list' });
  const seatTable = h(doc, 'div', { class: 'play-seat-table' });
  const seeding = h(doc, 'p', { class: 'play-seeding hint-line' });
  view.appendChild(h(doc, 'h2', { text: 'Characters & seats' }));
  view.appendChild(seeding);
  view.appendChild(status);
  view.appendChild(importCard);
  view.appendChild(h(doc, 'div', { class: 'play-card' }, [h(doc, 'h3', { text: 'In this room' }), charList]));
  view.appendChild(seatTable);
  root.appendChild(view);
  if (ctx.send) scope.add(mountRoomSettings(view, { store: ctx.store, send: ctx.send }));

  async function refreshCharacters() {
    if (!roomId || !ctx.api) return;
    const res = await ctx.api.listCharacters(roomId);
    if (disposed) return;
    characters = Array.isArray(res?.characters) ? res.characters : [];
    render();
  }

  async function ensureStats(characterId) {
    if (!characterId || stats.has(characterId) || !ctx.loadSheet) return;
    stats.set(characterId, null);
    const sheet = await ctx.loadSheet(characterId).catch(() => null);
    if (disposed) return;
    stats.set(characterId, derivedSeatStats(sheet));
    render();
  }

  delegate(scope, view, 'click', {
    import: () => {
      const url = urlIn.value.trim();
      const pasted = pasteIn.value.trim();
      if (!url && !pasted) { say('Paste a D&D Beyond URL or the character JSON.', 'error'); return; }
      let json = null;
      if (pasted) {
        try { json = JSON.parse(pasted); } catch { say('That JSON does not parse.', 'error'); return; }
      }
      say('Importing…');
      attempt(async () => {
        const res = await ctx.api.importCharacter(roomId, json ? { json } : { url });
        urlIn.value = '';
        pasteIn.value = '';
        say(`Imported ${res?.character?.name || 'character'}.`);
        await refreshCharacters();
      }, (e) => say(e.message, 'error'));
    },
    claim: (el) => attempt(() => ctx.send({ t: 'seat.claim', p: { characterId: el.dataset.character } }).then(() => say('Seat claimed.')), (e) => say(e.message, 'error')),
    release: (el) => attempt(() => ctx.send({ t: 'seat.release', p: { characterId: el.dataset.character } }).then(() => say('Seat released.')), (e) => say(e.message, 'error')),
    unassign: (el) => attempt(() => ctx.api.releaseSeat(roomId, Number(el.dataset.seat)), (e) => say(e.message, 'error')),
    'set-ai': (el) => {
      const row = el.closest('[data-seat-row]');
      const charSel = row?.querySelector?.('[data-field="ai-character"]');
      const archSel = row?.querySelector?.('[data-field="ai-archetype"]');
      const characterId = charSel?.value;
      if (!characterId) { say('Pick a character for the AI seat.', 'error'); return; }
      attempt(() => ctx.api.aiSeat(roomId, Number(el.dataset.seat), characterId, archSel?.value || null), (e) => say(e.message, 'error'));
    },
    'open-setup': () => ctx.actions?.openSetup?.()
  });

  function render() {
    const s = ctx.store.getState();
    seeding.textContent = seedingCopy(s);
    const me = myMemberId(s);
    const dm = isDm(s);
    const seats = seatsOf(s);
    const members = membersOf(s);
    const seatedBy = new Map(seats.filter(x => x.characterId).map(x => [x.characterId, x]));
    replace(doc, charList, characters.length ? characters.map((c) => {
      const seat = seatedBy.get(c.ddbId);
      const mine = seat && seat.memberId === me;
      const takenBy = seat && !mine ? (members.find(m => m.memberId === seat.memberId)?.displayName || (seat.controller === 'ai' ? 'AI' : 'someone')) : null;
      return h(doc, 'li', { class: 'play-char' }, [
        h(doc, 'span', { class: 'play-char-name', text: c.name || c.ddbId }),
        dm ? null
          : mine ? h(doc, 'button', { type: 'button', class: 'play-btn', dataset: { action: 'release', character: c.ddbId }, text: 'Release' })
            : takenBy ? h(doc, 'span', { class: 'play-taken', text: `taken by ${takenBy}` })
              : h(doc, 'button', { type: 'button', class: 'play-btn primary', dataset: { action: 'claim', character: c.ddbId }, text: 'Claim' })
      ]);
    }) : [h(doc, 'li', { class: 'hint-line', text: dm ? 'Players import characters here.' : 'No characters yet — import one above.' })]);

    const filled = seats.filter(x => x.characterId).length;
    const free = characters.filter(c => !seatedBy.has(c.ddbId));
    replace(doc, seatTable, [
      h(doc, 'h3', { text: 'Seats' }),
      h(doc, 'table', { class: 'play-seat-grid' }, [
        h(doc, 'thead', {}, [h(doc, 'tr', {}, ['Seat', 'Character', 'Controller', dm ? 'AC / HP / Lvl' : null, dm ? '' : null].filter(x => x !== null).map(t => h(doc, 'th', { text: t })))]),
        h(doc, 'tbody', {}, seats.map((seat) => {
          if (seat.characterId) ensureStats(seat.characterId);
          const st = seat.characterId ? stats.get(seat.characterId) : null;
          const holder = seat.memberId ? members.find(m => m.memberId === seat.memberId) : null;
          const cells = [
            h(doc, 'td', { text: String(seat.seat) }),
            h(doc, 'td', { text: seat.characterName || characters.find(c => c.ddbId === seat.characterId)?.name || seat.characterId || 'Empty' }),
            h(doc, 'td', { text: !seat.characterId ? '—' : seat.controller === 'player' ? (holder?.displayName || 'player') : `AI${seat.aiArchetype ? ` (${seat.aiArchetype})` : ''}` })
          ];
          if (dm) {
            cells.push(h(doc, 'td', { class: 'play-derived', text: st ? `${st.ac ?? '?'} / ${st.hp ?? '?'} / ${st.level ?? '?'}` : seat.characterId ? '…' : '' }));
            cells.push(h(doc, 'td', {}, seat.characterId
              ? [h(doc, 'button', { type: 'button', class: 'play-btn', dataset: { action: 'unassign', seat: seat.seat }, text: 'Unassign' })]
              : [
                  select(doc, { dataset: { field: 'ai-character' }, attrs: { 'aria-label': `AI character for seat ${seat.seat}` } }, [{ value: '', label: 'AI character…' }, ...free.map(c => ({ value: c.ddbId, label: c.name || c.ddbId }))]),
                  select(doc, { dataset: { field: 'ai-archetype' }, attrs: { 'aria-label': `AI archetype for seat ${seat.seat}` } }, archetypes),
                  h(doc, 'button', { type: 'button', class: 'play-btn', dataset: { action: 'set-ai', seat: seat.seat }, text: 'Set AI' })
                ]));
          }
          return h(doc, 'tr', { dataset: { seatRow: seat.seat } }, cells);
        }))
      ]),
      dm ? h(doc, 'button', { type: 'button', class: 'play-btn primary', disabled: filled === 0, dataset: { action: 'open-setup' }, text: filled ? 'Set up the encounter →' : 'Seat at least one character' }) : null
    ]);
  }

  scope.add(ctx.store.subscribe((a) => [a.seats, a.room, a.members, a.me], () => { render(); }, (x, y) => x.every((v, i) => v === y[i])));
  // Someone else's import shows up when the seats change.
  scope.add(ctx.store.subscribe((a) => a.seats, () => { attempt(refreshCharacters, () => {}); }));
  render();
  attempt(refreshCharacters, (e) => say(e.message, 'error'));

  return function unmount() {
    disposed = true;
    scope.dispose();
    if (view.parentNode) view.parentNode.removeChild(view);
  };
}
