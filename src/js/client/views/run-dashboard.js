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
 *              queues a level-up); v1.7: under `xpAward: 'confirm'` an
 *              encounter's award is held (`pendingXp` on the snapshot /
 *              run.updated) and "Confirm XP" sends `dm.xp.adjust` with
 *              delta 0, which only confirms it
 *   level-ups  the pending rows → `dm.levelup.confirm` (an auto-mode level
 *              queued behind another applies on its own: no button)
 *   seats      `dm.character.revive` (DM / Revivify / Raise Dead with a
 *              caster), `dm.character.retire`, `dm.seat.fill` (a room
 *              character into a seat, AI or a player, optional level),
 *              seat reclaims → `dm.seat.reclaim.approve`
 *   rests      `dm.rest.grant` anywhere (an override off a rest node)
 *   snapshots  `dm.snapshot.save {label}` / `dm.snapshot.load` — the ones
 *              saved this session and every `snapshot.saved` in the log
 *   log        the run events this client has seen (run-store log); after a
 *              reconnect (or a fresh page) the missing part is fetched
 *              from `GET /api/runs/:runId/events?since=` and merged in,
 *              and the snapshot list from `GET /api/runs/:runId/snapshots`
 *   hash       v1.7: the wire log (fetched + live) re-hashed with
 *              run-state.js runHash must equal the server's `wireHash`
 *              from `run.snapshot` / `run.updated` (verifyWireLog)
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
import { RUN_OUTCOMES, runHash } from '../../shared/run-state.js';
import { KIND_GLYPHS } from '../campaign-graph.js';
import { DOWNTIME_HEALS } from '../../campaign/downtime-spells.js';

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
    case 'xp.awarded': return `XP${p.confirmed ? ' (confirmed by the DM)' : ''}: ${p.total} (${Object.entries(p.perCharacter || {}).map(([s, n]) => `${who(s)} +${n}`).join(', ')}).`;
    case 'level.queued': return p.mode === 'reconcile' ? `${who(p.slotId)}: D&D Beyond changes queued.` : `${who(p.slotId)} can reach level ${p.toLevel}.`;
    case 'level.applied': return `${who(p.slotId)} is level ${p.toLevel}${ev.actorKind === 'system' ? ' (applied automatically: no choices)' : ''}.`;
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
    case 'heal.cast':
      return `${who(p.casterSlotId)} casts ${DOWNTIME_HEALS[p.spellId]?.name || p.spellId} (level ${p.slotLevel}${p.slotKind === 'pact' ? ' pact' : ''})${ev.override ? ' — DM override' : ''}: ${(p.targetSlotIds || []).map(s => `${who(s)} +${p.healed?.[s] ?? 0} HP`).join(', ')}.`;
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
 * Check a wire log against the server's `wireHash` (v1.7): run-state.js
 * runHash over events 1..seq must equal it; 'incomplete' while a seq is
 * missing, 'unknown' when the server sent no hash.
 * @param {Map<number, object>|object[]} events — run events as received (run.event / GET …/events)
 * @param {{seq: number, wireHash: string|null}} at
 * @returns {{status: 'ok'|'mismatch'|'incomplete'|'unknown', hash?: string, missing?: number}}
 */
export function verifyWireLog(events, { seq, wireHash }) {
  if (!wireHash) return { status: 'unknown' };
  const bySeq = events instanceof Map ? events : new Map((events || []).map(e => [e.seq, e]));
  const list = [];
  for (let i = 1; i <= seq; i++) {
    const e = bySeq.get(i);
    if (!e) return { status: 'incomplete', missing: i };
    list.push(e);
  }
  const hash = runHash(list);
  return { status: hash === wireHash ? 'ok' : 'mismatch', hash };
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
  /** The run's wire log (seq → event: fetched history + live events), the route's snapshot list, the last verification. */
  const history = { runId: null, wire: new Map(), loading: false, triedSeq: -1, snapshots: [], verified: null };
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
    'dash-xp-confirm': () => {
      const held = run().pendingXp;
      const slotId = Object.keys(held?.perCharacter || {})[0] || run().characters[0]?.slotId;
      if (!held || !slotId) return;
      send('dm.xp.adjust', { slotId, delta: 0 }, `XP confirmed: ${held.total} (${Object.entries(held.perCharacter || {}).map(([s, n]) => `${nameOfSlot(run(), s)} +${n}`).join(', ')}).`);
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

  /** The highest seq n such that events 1..n are all in the wire log. */
  function contiguous() {
    let n = 0;
    while (history.wire.has(n + 1)) n++;
    return n;
  }

  /**
   * Keep the wire log whole: live events from the run store, and the part
   * a reconnect (or a fresh page) missed from GET /api/runs/:runId/events,
   * paged with `since`; the snapshot list comes along. One fetch per run
   * seq; the fetched events also fill the run store's log.
   */
  function syncHistory(r) {
    if (!r.runId) return;
    if (history.runId !== r.runId) Object.assign(history, { runId: r.runId, wire: new Map(), triedSeq: -1, snapshots: [], verified: null });
    for (const ev of r.log || []) if (!history.wire.has(ev.seq)) history.wire.set(ev.seq, ev);
    const have = contiguous();
    if (have >= r.seq || history.loading || history.triedSeq === r.seq || typeof ctx.api?.runEvents !== 'function') return;
    history.loading = true;
    history.triedSeq = r.seq;
    const runId = r.runId;
    attempt(async () => {
      const got = [];
      let since = have;
      for (let guard = 0; guard < 1000; guard++) {
        const page = await ctx.api.runEvents(runId, { since });
        const evs = Array.isArray(page?.events) ? page.events : [];
        got.push(...evs);
        if (!page?.more || !evs.length) break;
        since = evs.at(-1).seq;
      }
      const snaps = typeof ctx.api.runSnapshots === 'function' ? await ctx.api.runSnapshots(runId) : null;
      if (disposed || history.runId !== runId) return;
      for (const e of got) if (!history.wire.has(e.seq)) history.wire.set(e.seq, e);
      if (Array.isArray(snaps?.snapshots)) history.snapshots = snaps.snapshots;
      ctx.runStore.mergeHistory?.(runId, got);
    }, fail).finally(() => { history.loading = false; if (!disposed) render(); });
  }

  /** verifyWireLog at the run store's hashes, cached per (seq, wireHash). */
  function verification(r) {
    if (!r.wireHash) return { status: 'unknown' };
    const key = `${r.hashSeq}:${r.wireHash}`;
    if (history.verified?.key === key && history.verified.status !== 'incomplete') return history.verified;
    history.verified = { key, ...verifyWireLog(history.wire, { seq: r.hashSeq, wireHash: r.wireHash }) };
    return history.verified;
  }

  /** Snapshots known to this client: the run's list (GET …/snapshots), `snapshot.saved` in the log, and saved here. */
  function snapshots(r) {
    const out = new Map();
    for (const s of history.snapshots) out.set(s.snapshotId, { snapshotId: s.snapshotId, label: s.label ?? null, atSeq: s.atSeq });
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
    const kids = [h(doc, 'h3', { text: `Pending level-ups (${pending.length})` })];
    const held = r.pendingXp;
    if (held) {
      kids.push(h(doc, 'div', { class: 'play-row', dataset: { field: 'dash-pending-xp' } }, [
        h(doc, 'span', { text: `XP held for your confirmation: ${held.total} (${Object.entries(held.perCharacter || {}).map(([s, n]) => `${nameOfSlot(r, s)} +${n}`).join(', ')})` }),
        h(doc, 'button', { type: 'button', class: 'play-btn small primary', dataset: { action: 'dash-xp-confirm' }, text: 'Confirm XP' })
      ]));
    }
    for (const l of pending) {
      const behind = l.mode === 'auto' && pending.some(x => x.slotId === l.slotId && x.id !== l.id && x.mode !== 'reconcile' && x.fromLevel < l.fromLevel);
      kids.push(h(doc, 'div', { class: 'play-row', dataset: { levelUp: l.id } }, [
        h(doc, 'span', { text: `${nameOfSlot(r, l.slotId)}: ${l.mode === 'reconcile' ? 'D&D Beyond changes' : `level ${l.toLevel}`} — ${behind ? 'applies on its own after the level before it' : l.status === 'pending_player' ? 'player choosing' : 'ready'}` }),
        behind ? null : h(doc, 'button', { type: 'button', class: 'play-btn small', dataset: { action: 'dash-lu-confirm', id: l.id, slot: l.slotId }, text: l.status === 'pending_player' ? 'Confirm (override)' : 'Confirm' })
      ]));
    }
    replace(doc, levelEl, kids);
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
    const v = verification(r);
    const hashLine = v.status === 'unknown' ? null : h(doc, 'p', {
      class: `play-preview${v.status === 'mismatch' ? ' error' : ''}`, dataset: { field: 'dash-hash', status: v.status },
      text: v.status === 'ok' ? `Log verified at #${r.hashSeq}: wire ${r.wireHash} · run ${r.runHash}`
        : v.status === 'mismatch' ? `This log differs from the server's at #${r.hashSeq} (here ${v.hash}, server ${r.wireHash}) — reload the page.`
          : `Fetching the run log up to #${r.hashSeq}…`
    });
    replace(doc, logEl, [h(doc, 'h3', { text: 'Run log' }), hashLine,
      last.length ? h(doc, 'ol', { class: 'play-dash-log-list' }, last.map(ev => h(doc, 'li', { dataset: { seq: String(ev.seq) }, text: `#${ev.seq} ${runEventText(ev, r)}` })))
        : h(doc, 'p', { class: 'hint-line', text: 'Nothing has happened since you joined.' })]);
  }

  function render() {
    const r = run();
    const show = r.synced && isDm(ctx.store.getState());
    view.hidden = !show;
    if (!show) return;
    syncHistory(r);
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
