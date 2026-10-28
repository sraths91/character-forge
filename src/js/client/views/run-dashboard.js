/**
 * M65 C27 — the DM's run dashboard (play.html side panel, DM only).
 *
 *   party      one row per run character: seat, controller, level, XP (and
 *              the next threshold), life status, HP / max / temp, hit dice,
 *              spell and pact slots, every resource pool — `ddb:*` pools
 *              are D&D Beyond limited uses the DM adjudicates — exhaustion,
 *              conditions and purse. State from the run snapshot, maxima
 *              from the seat's run sheet (B27 route, DM gets it whole).
 *   XP         `dm.xp.adjust {slotId, delta, reason}` (crossing a threshold
 *              queues a level-up)
 *   level-ups  the pending rows → `dm.levelup.confirm`
 *   seats      `dm.character.revive` (DM / Revivify / Raise Dead with a
 *              caster), `dm.character.retire`, `dm.seat.fill` (a room
 *              character into a seat, AI or a player, optional level),
 *              seat reclaims → `dm.seat.reclaim.approve`
 *   rests      `dm.rest.grant` anywhere (an override off a rest node)
 *   snapshots  `dm.snapshot.save {label}` / `dm.snapshot.load` — the ones
 *              saved this session and every `snapshot.saved` in the log
 *   log        the run events this client has seen (run-store log)
 *   travel     `dm.node.begin`, offered edges and "any node" with override
 *              (`dm.run.advance`), `dm.run.end {outcome}`
 *
 * Every action is one intent; nothing here writes state. What the table
 * shows is `dashboardModel(runState, sheets)` — the same function a test
 * runs over the server's `run.snapshot` to check the two agree.
 *
 * mount(root, ctx) → unmount. ctx: {store, runStore, send, api, room, runSheets?}
 */

import { h, replace, createScope, delegate, attempt, select } from './dom.js';
import { isDm, membersOf } from '../selectors.js';
import { nameOfSlot, coinsText, refusalText, createRunSheets } from '../run-model.js';
import { xpForLevel, MAX_LEVEL } from '../../campaign/xp.js';
import { effectiveHpMax } from '../../campaign/exhaustion.js';
import { RUN_OUTCOMES } from '../../shared/run-state.js';
import { KIND_GLYPHS } from '../campaign-graph.js';

/**
 * The party table's rows (pure; the view and the tests share it).
 * @param {import('../run-store.js').RunState} run
 * @param {(slotId: string, version: number) => object|null} sheetOf
 * @returns {object[]}
 */
export function dashboardModel(run, sheetOf = () => null) {
  return (run?.characters || []).slice().sort((a, b) => a.seat - b.seat).map((c) => {
    const st = c.state || {};
    const sheet = sheetOf(c.slotId, c.version);
    const table = sheet?.spellSlotTable || {};
    const slots = Object.keys(table.spell || {}).filter(k => Number(table.spell[k]) > 0).sort().map(k => ({
      level: Number(k), max: Number(table.spell[k]), left: Math.max(0, Number(table.spell[k]) - (Number(st.slots?.spell?.[k]?.spent) || 0))
    }));
    const pact = table.pact && Number(table.pact.max) > 0
      ? { level: table.pact.level, max: Number(table.pact.max), left: Math.max(0, Number(table.pact.max) - (Number(st.slots?.pact?.spent) || 0)) }
      : null;
    const classes = new Map((sheet?.classes || []).map(x => [x.name, Number(x.level) || 0]));
    return {
      slotId: c.slotId, seat: c.seat, name: c.name || `Seat ${c.seat}`, controller: c.controller || (c.memberId ? 'player' : 'ai'), memberId: c.memberId ?? null,
      level: c.level, xp: c.xp, nextXp: c.level < MAX_LEVEL ? xpForLevel(c.level + 1) : null, lifeStatus: c.lifeStatus,
      hp: { current: st.hp?.current ?? null, temp: st.hp?.temp ?? 0, max: sheet ? effectiveHpMax(sheet, st) : null },
      hitDice: Object.entries(st.hitDice || {}).map(([cls, d]) => ({ cls, die: d?.die ?? null, spent: d?.spent ?? 0, max: classes.get(cls) ?? null })),
      slots, pact,
      resources: Object.entries(st.resources || {}).sort(([a], [b]) => a.localeCompare(b)).map(([key, r]) => ({
        key, label: r.label || key, max: r.max, left: Math.max(0, (r.max ?? 0) - (r.spent ?? 0)), dm: key.startsWith('ddb:')
      })),
      exhaustion: st.exhaustion || 0,
      conditions: [...(st.conditions || [])],
      purse: coinsText(st.currency)
    };
  });
}

/**
 * The text cells of one party row (what the table renders, in order).
 * @param {object} row — dashboardModel row
 * @returns {string[]}
 */
export function rowCells(row) {
  return [
    `${row.seat}. ${row.name} (${row.controller})`,
    `L${row.level} · XP ${row.xp}${row.nextXp ? `/${row.nextXp}` : ''}`,
    row.lifeStatus,
    `HP ${row.hp.current ?? '?'}/${row.hp.max ?? '?'}${row.hp.temp ? ` +${row.hp.temp}` : ''}`,
    row.hitDice.map(d => `${d.cls} d${d.die ?? '?'} ${(d.max ?? 0) - d.spent}/${d.max ?? '?'}`).join(', ') || '—',
    [...row.slots.map(s => `L${s.level} ${s.left}/${s.max}`), row.pact ? `pact L${row.pact.level} ${row.pact.left}/${row.pact.max}` : null].filter(Boolean).join(' ') || '—',
    row.resources.map(r => `${r.label}${r.dm ? '*' : ''} ${r.left}/${r.max}`).join(', ') || '—',
    [row.exhaustion ? `exhaustion ${row.exhaustion}` : null, ...row.conditions].filter(Boolean).join(', ') || '—',
    row.purse
  ];
}

/**
 * One run event as a log line.
 * @param {object} ev — run event
 * @param {object} run — run state (names)
 * @returns {string}
 */
export function runEventText(ev, run) {
  const p = ev?.payload || {};
  const who = (s) => nameOfSlot(run, s);
  const node = (id) => (run?.nodes || []).find(n => n.id === id)?.title || id;
  switch (ev?.type) {
    case 'run.started': return 'The run started.';
    case 'run.ended': return `The run ended: ${p.outcome}.`;
    case 'node.entered': return `Entered ${node(p.nodeId)}${ev.override ? ' (override)' : ''}.`;
    case 'node.completed': return `${node(p.nodeId)} done.`;
    case 'encounter.result': return `Encounter: ${p.outcome} in ${p.rounds} rounds.`;
    case 'xp.awarded': return `XP: ${p.total} (${Object.entries(p.perCharacter || {}).map(([s, n]) => `${who(s)} +${n}`).join(', ')}).`;
    case 'level.queued': return p.mode === 'reconcile' ? `${who(p.slotId)}: D&D Beyond changes queued.` : `${who(p.slotId)} can reach level ${p.toLevel}.`;
    case 'level.applied': return `${who(p.slotId)} is level ${p.toLevel}.`;
    case 'level.reverted': return `${who(p.slotId)} reverted to level ${p.toLevel}.`;
    case 'rest.taken': return `${p.type === 'long' ? 'Long' : 'Short'} rest: ${(p.slotIds || []).map(who).join(', ') || 'nobody'}.`;
    case 'loot.granted': return `Loot: ${(p.items || []).map(i => `${i.name} ×${i.qty}`).join(', ')}${p.currency ? ` + ${coinsText(p.currency)}` : ''}.`;
    case 'item.moved': return p.equip ? `${who(p.toSlotId)} changed gear (${p.name}).` : `${p.name} ×${p.qty}: ${p.fromSlotId ? who(p.fromSlotId) : 'stash'} → ${p.toSlotId ? who(p.toSlotId) : 'stash'}.`;
    case 'item.used': return `${who(p.slotId)} used an item${p.healed ? ` (+${p.healed} HP)` : ''}.`;
    case 'currency.changed': {
      const d = Object.entries(p.delta || {});
      const gained = Object.fromEntries(d.filter(([, n]) => n > 0));
      const lost = Object.fromEntries(d.filter(([, n]) => n < 0).map(([k, n]) => [k, -n]));
      const how = p.reason === 'stash.split' ? 'stash split' : p.reason === 'stash.take' ? 'taken from the stash' : (p.reason || 'coin');
      const amounts = [Object.keys(gained).length ? `+${coinsText(gained)}` : null, Object.keys(lost).length ? `−${coinsText(lost)}` : null].filter(Boolean);
      return `${who(p.slotId)} ${amounts.join(' ') || '±0'} (${how}).`;
    }
    case 'shop.bought': return `${who(p.slotId)} bought ${p.name} ×${p.qty}.`;
    case 'shop.sold': return `${who(p.slotId)} sold ${p.name} ×${p.qty}.`;
    case 'story.chosen': return `Story choice: ${p.choiceId}.`;
    case 'character.joined': return `${who(p.slotId)} joined at level ${p.level}.`;
    case 'character.died': return `${who(p.slotId)} died.`;
    case 'character.revived': return `${who(p.slotId)} is back (${p.method}).`;
    case 'character.retired': return `Seat ${p.seat} retired (${p.reason}).`;
    case 'seat.filled': return `Seat ${p.seat} filled (${p.controller}).`;
    case 'snapshot.saved': return `Saved snapshot${p.label ? ` "${p.label}"` : ''} at #${p.atSeq}.`;
    case 'snapshot.restored': return `Loaded the snapshot from #${p.atSeq}.`;
    case 'dm.override': return p.kind === 'xp' ? `XP override: ${who(p.slotId)} ${p.before?.xp} → ${p.after?.xp}${p.reason ? ` (${p.reason})` : ''}.` : `DM override (${p.kind}).`;
    default: return ev?.type || '?';
  }
}

/**
 * @param {HTMLElement} root
 * @param {object} ctx
 * @returns {() => void} unmount
 */
export function mount(root, ctx) {
  const doc = root.ownerDocument;
  const scope = createScope();
  const sheets = ctx.runSheets || createRunSheets({ api: ctx.api, roomId: () => ctx.room?.roomId ?? null });
  const draft = new Map();
  /** Snapshots saved from this client: {snapshotId, label, atSeq}. */
  const saved = [];
  let roomChars = null;
  let disposed = false;
  const view = h(doc, 'section', { class: 'play-view play-run-dashboard', hidden: true, attrs: { 'aria-label': 'Run dashboard' } });
  const status = h(doc, 'p', { class: 'play-status', attrs: { role: 'status', 'aria-live': 'polite' } });
  const travelEl = h(doc, 'div', { class: 'play-card play-dash-travel' });
  const partyEl = h(doc, 'div', { class: 'play-card play-dash-party' });
  const levelEl = h(doc, 'div', { class: 'play-card play-dash-levelups' });
  const seatsEl = h(doc, 'div', { class: 'play-card play-dash-seats' });
  const snapEl = h(doc, 'div', { class: 'play-card play-dash-snapshots' });
  const logEl = h(doc, 'div', { class: 'play-card play-dash-log' });
  view.appendChild(h(doc, 'h2', { text: 'Run dashboard' }));
  for (const el of [status, travelEl, partyEl, levelEl, seatsEl, snapEl, logEl]) view.appendChild(el);
  root.appendChild(view);
  const say = (msg, kind = 'info') => { status.textContent = msg || ''; status.dataset.kind = kind; };
  const fail = (e) => say(refusalText(e), 'error');
  const run = () => ctx.runStore.getState();
  const dv = (k, d) => (draft.has(k) ? draft.get(k) : d);
  const keep = (el) => { if (el?.dataset?.field) draft.set(`${el.dataset.field}|${el.dataset.key || ''}`, el.type === 'checkbox' ? el.checked : el.value); };
  scope.on(view, 'input', (e) => keep(e.target));
  scope.on(view, 'change', (e) => { keep(e.target); render(); });
  const send = (t, p, ok) => attempt(() => ctx.send({ t, p }).then((ack) => { say(typeof ok === 'function' ? ok(ack) : ok); return ack; }), fail);
  const int = (v) => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : 0);

  delegate(scope, view, 'click', {
    'dash-begin': () => send('dm.node.begin', {}, 'Beginning…'),
    'dash-advance': (el) => send('dm.run.advance', { toNodeId: el.dataset.to }, 'Moving on.'),
    'dash-goto': () => {
      const to = String(dv('goto|', run().nodes[0]?.id || ''));
      if (to) send('dm.run.advance', { toNodeId: to, override: true }, 'Override: moved.');
    },
    'dash-end': () => send('dm.run.end', { outcome: String(dv('outcome|', RUN_OUTCOMES[0])) }, (ack) => `The run is over (${ack?.outcome}).`),
    'dash-rest': (el) => send('dm.rest.grant', { type: el.dataset.type }, 'Rest granted.'),
    'dash-xp': (el) => {
      const slotId = el.dataset.slot;
      const delta = int(dv(`xp|${slotId}`, 0));
      if (!delta) { say('Enter an XP change.', 'error'); return; }
      const reason = String(dv(`xp-reason|${slotId}`, '')).trim();
      send('dm.xp.adjust', { slotId, delta, ...(reason ? { reason: reason.slice(0, 200) } : {}) }, (ack) => `${nameOfSlot(run(), slotId)} has ${ack?.xp} XP.`)
        .then((ack) => { if (ack) { draft.delete(`xp|${slotId}`); draft.delete(`xp-reason|${slotId}`); render(); } });
    },
    'dash-lu-confirm': (el) => send('dm.levelup.confirm', { levelUpId: el.dataset.id }, (ack) => `${nameOfSlot(run(), el.dataset.slot)} is level ${ack?.level}.`),
    'dash-revive': (el) => {
      const slotId = el.dataset.slot;
      const method = String(dv(`revive-method|${slotId}`, 'dm'));
      const caster = String(dv(`revive-caster|${slotId}`, ''));
      send('dm.character.revive', { slotId, method, ...(method !== 'dm' && caster ? { casterSlotId: caster } : {}) }, (ack) => `${nameOfSlot(run(), slotId)} is ${ack?.lifeStatus}.`);
    },
    'dash-retire': (el) => {
      const slotId = el.dataset.slot;
      const reason = String(dv(`retire-reason|${slotId}`, '')).trim();
      send('dm.character.retire', { slotId, ...(reason ? { reason: reason.slice(0, 200) } : {}) }, 'Retired to the roster.');
    },
    'dash-fill': () => {
      const seat = int(dv('fill-seat|', 1)) || 1;
      const characterId = String(dv('fill-char|', roomChars?.[0]?.ddbId || ''));
      const controller = String(dv('fill-controller|', 'ai'));
      const memberId = String(dv('fill-member|', ''));
      const level = int(dv('fill-level|', 0));
      if (!characterId) { say('Import a character into the room first.', 'error'); return; }
      send('dm.seat.fill', { seat, characterId, controller, ...(controller === 'player' ? { memberId: memberId || null } : {}), ...(level ? { level } : {}) }, `Seat ${seat} filled.`);
    },
    'dash-load-chars': () => loadRoomChars(),
    'dash-reclaim': (el) => send('dm.seat.reclaim.approve', { slotId: el.dataset.slot, memberId: el.dataset.member, approve: el.dataset.approve === '1' }, el.dataset.approve === '1' ? 'Seat handed over.' : 'Request declined.'),
    'dash-snap-save': () => {
      const label = String(dv('snap-label|', '')).trim();
      send('dm.snapshot.save', label ? { label: label.slice(0, 128) } : {}, (ack) => `Saved snapshot ${ack?.snapshotId}.`).then((ack) => {
        if (ack?.snapshotId) { saved.push({ snapshotId: ack.snapshotId, label: label || null, atSeq: ack.atSeq }); draft.delete('snap-label|'); render(); }
      });
    },
    'dash-snap-load': (el) => send('dm.snapshot.load', { snapshotId: el.dataset.id }, (ack) => `Loaded${ack?.missing?.length ? ` (${ack.missing.length} retired seat(s) not restored)` : ''}.`)
  });

  function loadRoomChars() {
    const rid = ctx.room?.roomId;
    if (!rid || typeof ctx.api?.listCharacters !== 'function') return;
    attempt(() => ctx.api.listCharacters(rid).then((res) => { roomChars = res?.characters || []; if (!disposed) render(); }), fail);
  }

  /** Snapshots known to this client: saved here + `snapshot.saved` in the log. */
  function snapshots(r) {
    const out = new Map();
    for (const ev of r.log || []) if (ev.type === 'snapshot.saved') out.set(ev.payload.snapshotId, { snapshotId: ev.payload.snapshotId, label: ev.payload.label ?? null, atSeq: ev.payload.atSeq });
    for (const s of saved) if (!out.has(s.snapshotId)) out.set(s.snapshotId, s);
    return [...out.values()];
  }

  function renderTravel(r) {
    const cur = r.currentNodeId ? r.nodes.find(n => n.id === r.currentNodeId) : null;
    const kids = [h(doc, 'h3', { text: 'Travel' }), h(doc, 'p', { dataset: { field: 'dash-where' }, text: `Status: ${r.status}${cur ? ` · ${KIND_GLYPHS[cur.kind] || ''} ${cur.title}` : ''}${r.completed ? ' (done)' : ''}${r.outcome ? ` · ${r.outcome}` : ''}` })];
    if (r.status === 'ended') { replace(doc, travelEl, kids); return; }
    const unfought = r.status === 'in-node' && cur?.kind === 'encounter' && !r.completed;
    if (r.status === 'lobby' || unfought) kids.push(h(doc, 'button', { type: 'button', class: 'play-btn primary', dataset: { action: 'dash-begin' }, text: r.status === 'lobby' ? 'Begin the run' : 'Begin this encounter' }));
    if (r.edges.length) {
      kids.push(h(doc, 'div', { class: 'play-row' }, r.edges.map(e => h(doc, 'button', { type: 'button', class: 'play-btn small', dataset: { action: 'dash-advance', to: e.to }, text: `→ ${r.nodes.find(n => n.id === e.to)?.title || e.to}` }))));
    }
    if (r.nodes.length) {
      kids.push(h(doc, 'div', { class: 'play-row' }, [
        select(doc, { dataset: { field: 'goto' }, attrs: { 'aria-label': 'Any node' } }, r.nodes.map(n => ({ value: n.id, label: `${KIND_GLYPHS[n.kind] || ''} ${n.title}` })), dv('goto|', r.nodes[0].id)),
        h(doc, 'button', { type: 'button', class: 'play-btn small', dataset: { action: 'dash-goto' }, text: 'Go (override)' })
      ]));
    }
    kids.push(h(doc, 'div', { class: 'play-row' }, [
      h(doc, 'button', { type: 'button', class: 'play-btn small', dataset: { action: 'dash-rest', type: 'short' }, text: 'Grant short rest' }),
      h(doc, 'button', { type: 'button', class: 'play-btn small', dataset: { action: 'dash-rest', type: 'long' }, text: 'Grant long rest' })
    ]));
    kids.push(h(doc, 'div', { class: 'play-row' }, [
      select(doc, { dataset: { field: 'outcome' }, attrs: { 'aria-label': 'Outcome' } }, [...RUN_OUTCOMES], dv('outcome|', RUN_OUTCOMES[0])),
      h(doc, 'button', { type: 'button', class: 'play-btn small danger', dataset: { action: 'dash-end' }, text: 'End the run' })
    ]));
    replace(doc, travelEl, kids);
  }

  function renderParty(r, rows) {
    const head = ['Character', 'Level / XP', 'Status', 'HP', 'Hit dice', 'Slots', 'Resources (* DM-adjudicated)', 'Exhaustion / conditions', 'Purse', 'XP change'];
    const table = h(doc, 'table', { class: 'play-dash-table' }, [
      h(doc, 'thead', {}, [h(doc, 'tr', {}, head.map(t => h(doc, 'th', { text: t })))]),
      h(doc, 'tbody', {}, rows.map(row => h(doc, 'tr', { dataset: { slot: row.slotId } }, [
        ...rowCells(row).map((t, i) => h(doc, 'td', { dataset: { cell: String(i) }, text: t })),
        h(doc, 'td', {}, [
          h(doc, 'input', { type: 'number', value: String(dv(`xp|${row.slotId}`, '')), placeholder: '±XP', dataset: { field: 'xp', key: row.slotId }, attrs: { 'aria-label': `XP change for ${row.name}` } }),
          h(doc, 'input', { type: 'text', value: String(dv(`xp-reason|${row.slotId}`, '')), placeholder: 'reason', dataset: { field: 'xp-reason', key: row.slotId } }),
          h(doc, 'button', { type: 'button', class: 'play-btn small', dataset: { action: 'dash-xp', slot: row.slotId }, text: 'Apply' })
        ])
      ])))
    ]);
    replace(doc, partyEl, [h(doc, 'h3', { text: 'Party' }), rows.length ? table : h(doc, 'p', { class: 'hint-line', text: 'No characters in the run yet.' })]);
  }

  function renderLevelUps(r) {
    const pending = (r.levelUps || []).filter(l => l.status === 'pending_player' || l.status === 'pending_dm');
    replace(doc, levelEl, [h(doc, 'h3', { text: `Pending level-ups (${pending.length})` }),
      ...pending.map(l => h(doc, 'div', { class: 'play-row', dataset: { levelUp: l.id } }, [
        h(doc, 'span', { text: `${nameOfSlot(r, l.slotId)}: ${l.mode === 'reconcile' ? 'D&D Beyond changes' : `level ${l.toLevel}`} — ${l.status === 'pending_player' ? 'player choosing' : 'ready'}` }),
        h(doc, 'button', { type: 'button', class: 'play-btn small', dataset: { action: 'dash-lu-confirm', id: l.id, slot: l.slotId }, text: l.status === 'pending_player' ? 'Confirm (override)' : 'Confirm' })
      ]))]);
  }

  function renderSeats(r) {
    const kids = [h(doc, 'h3', { text: 'Seats' })];
    const living = r.characters.filter(c => c.lifeStatus !== 'dead');
    for (const c of r.characters) {
      const row = [h(doc, 'strong', { text: `${c.seat}. ${c.name}` })];
      if (c.lifeStatus === 'dead' || c.lifeStatus === 'dying' || c.lifeStatus === 'stable') {
        const method = String(dv(`revive-method|${c.slotId}`, 'dm'));
        row.push(select(doc, { dataset: { field: 'revive-method', key: c.slotId }, attrs: { 'aria-label': 'Revive how' } }, [
          { value: 'dm', label: 'DM override' }, { value: 'revivify', label: 'Revivify' }, { value: 'raise-dead', label: 'Raise Dead' }], method));
        if (method !== 'dm') row.push(select(doc, { dataset: { field: 'revive-caster', key: c.slotId }, attrs: { 'aria-label': 'Caster' } }, living.map(x => ({ value: x.slotId, label: x.name })), dv(`revive-caster|${c.slotId}`, living[0]?.slotId)));
        row.push(h(doc, 'button', { type: 'button', class: 'play-btn small', dataset: { action: 'dash-revive', slot: c.slotId }, text: 'Revive' }));
      }
      row.push(h(doc, 'input', { type: 'text', value: String(dv(`retire-reason|${c.slotId}`, '')), placeholder: 'retire reason', dataset: { field: 'retire-reason', key: c.slotId } }));
      row.push(h(doc, 'button', { type: 'button', class: 'play-btn small danger', dataset: { action: 'dash-retire', slot: c.slotId }, text: 'Retire' }));
      kids.push(h(doc, 'div', { class: 'play-row', dataset: { seatRow: c.slotId } }, row));
    }
    for (const x of r.reclaims || []) {
      kids.push(h(doc, 'div', { class: 'play-row', dataset: { reclaim: `${x.slotId}:${x.memberId}` } }, [
        h(doc, 'span', { text: `${x.displayName || 'A player'} asks for ${nameOfSlot(r, x.slotId)}'s seat` }),
        h(doc, 'button', { type: 'button', class: 'play-btn small', dataset: { action: 'dash-reclaim', slot: x.slotId, member: x.memberId, approve: '1' }, text: 'Approve' }),
        h(doc, 'button', { type: 'button', class: 'play-btn small', dataset: { action: 'dash-reclaim', slot: x.slotId, member: x.memberId, approve: '0' }, text: 'Decline' })
      ]));
    }
    // Fill a seat with a room character.
    const players = membersOf(ctx.store.getState()).filter(m => m.role === 'player');
    const controller = String(dv('fill-controller|', 'ai'));
    const fill = [h(doc, 'span', { text: 'Fill seat ' }),
      select(doc, { dataset: { field: 'fill-seat' }, attrs: { 'aria-label': 'Seat' } }, ['1', '2', '3', '4', '5', '6'], dv('fill-seat|', '1'))];
    if (roomChars) {
      fill.push(roomChars.length
        ? select(doc, { dataset: { field: 'fill-char' }, attrs: { 'aria-label': 'Character' } }, roomChars.map(x => ({ value: x.ddbId, label: x.name })), dv('fill-char|', roomChars[0].ddbId))
        : h(doc, 'span', { class: 'hint-line', text: 'no characters in the room' }));
    } else {
      fill.push(h(doc, 'button', { type: 'button', class: 'play-btn small', dataset: { action: 'dash-load-chars' }, text: 'List room characters' }));
    }
    fill.push(select(doc, { dataset: { field: 'fill-controller' }, attrs: { 'aria-label': 'Controller' } }, [{ value: 'ai', label: 'AI' }, { value: 'player', label: 'Player' }], controller));
    if (controller === 'player') fill.push(select(doc, { dataset: { field: 'fill-member' }, attrs: { 'aria-label': 'Player' } }, players.map(m => ({ value: m.memberId, label: m.displayName })), dv('fill-member|', players[0]?.memberId)));
    fill.push(h(doc, 'input', { type: 'number', min: 1, max: 20, value: String(dv('fill-level|', '')), placeholder: 'level', dataset: { field: 'fill-level' } }));
    fill.push(h(doc, 'button', { type: 'button', class: 'play-btn small', dataset: { action: 'dash-fill' }, disabled: !roomChars?.length, text: 'Fill' }));
    kids.push(h(doc, 'div', { class: 'play-row', dataset: { between: 'fill' } }, fill));
    replace(doc, seatsEl, kids);
  }

  function renderSnapshots(r) {
    const list = snapshots(r);
    replace(doc, snapEl, [h(doc, 'h3', { text: 'Snapshots' }),
      h(doc, 'div', { class: 'play-row' }, [
        h(doc, 'input', { type: 'text', value: String(dv('snap-label|', '')), placeholder: 'label', dataset: { field: 'snap-label' } }),
        h(doc, 'button', { type: 'button', class: 'play-btn small', dataset: { action: 'dash-snap-save' }, disabled: !(r.status === 'between' || r.status === 'lobby'), text: 'Save' })
      ]),
      ...(list.length ? list.map(s => h(doc, 'div', { class: 'play-row', dataset: { snapshot: s.snapshotId } }, [
        h(doc, 'span', { text: `${s.label || s.snapshotId} (#${s.atSeq})` }),
        h(doc, 'button', { type: 'button', class: 'play-btn small', dataset: { action: 'dash-snap-load', id: s.snapshotId }, text: 'Load' })
      ])) : [h(doc, 'p', { class: 'hint-line', text: 'No snapshot saved this session.' })])]);
  }

  function renderLog(r) {
    const last = (r.log || []).slice(-30).reverse();
    replace(doc, logEl, [h(doc, 'h3', { text: 'Run log' }),
      last.length ? h(doc, 'ol', { class: 'play-dash-log-list' }, last.map(ev => h(doc, 'li', { dataset: { seq: String(ev.seq) }, text: `#${ev.seq} ${runEventText(ev, r)}` })))
        : h(doc, 'p', { class: 'hint-line', text: 'Nothing has happened since you joined.' })]);
  }

  function render() {
    const r = run();
    const show = r.synced && isDm(ctx.store.getState());
    view.hidden = !show;
    if (!show) return;
    for (const c of r.characters) sheets.load(c.slotId, c.version);
    renderTravel(r);
    renderParty(r, dashboardModel(r, (s, v) => sheets.get(s, v)));
    renderLevelUps(r);
    renderSeats(r);
    renderSnapshots(r);
    renderLog(r);
  }

  scope.add(sheets.onLoad(() => render()));
  scope.add(ctx.runStore.subscribe((s) => s, render));
  scope.add(ctx.store.subscribe((a) => a.me, render));
  render();
  return function unmount() {
    disposed = true;
    scope.dispose();
    if (view.parentNode) view.parentNode.removeChild(view);
  };
}
