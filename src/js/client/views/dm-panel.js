/**
 * M64 C9 — S4 DM battle panel (mounted beside the battle view for the DM).
 *
 *   - Status: pause / resume, and a visible "paused after restart —
 *     Resume" state (a recovered encounter waits for `dm.resume`).
 *   - Initiative tracker (current turn, round) with ↑ / ↓ reorder
 *     (`dm.initiative.set`, accepted between turns).
 *   - Pending-action card for a `plan` prompt / `turn.planProposed`:
 *     actor, plan kind, target and the `formatBreakdown` "why", with
 *     Approve / Change target / Change action / Skip / Take control.
 *   - Review: pause mode (Auto / each monster / AI party too), roll
 *     review toggle, and an inline roll editor for a `roll` prompt
 *     (monster / AI rolls only — the server only asks for those); arm the
 *     next roll (`dm.roll.arm`).
 *   - Entity inspector: HP current / temp, condition chips (remove / add),
 *     remove the creature. Clicking a token on the map selects it.
 *   - "+ Monster": pick a preset, click a cell (`dm.entity.add`).
 *   - "End encounter" with an outcome picker and a confirmation step.
 *   - Monster reaction prompts addressed to the DM are answered in the
 *     battle view's dialog.
 *
 * mount(root, ctx) → unmount. ctx: {store, send, dmBridge, deps: {timers}}
 */

import { h, replace, createScope, delegate, attempt, select } from './dom.js';
import { nameOf, conditionIds } from '../selectors.js';
import { formatBreakdown } from '../../scene/ai/profile.js';
import { entityFromPreset } from '../../scene/encounter-adapters.js';
import { MONSTER_PRESETS } from '../../scene/monster-presets.js';
import { ENCOUNTER_OUTCOMES } from '../../shared/events.js';
import { PAUSE_MODES } from './setup.js';

/** Conditions the inspector can add. */
export const CONDITION_CHOICES = Object.freeze([
  'blinded', 'charmed', 'deafened', 'frightened', 'grappled', 'incapacitated', 'invisible',
  'paralyzed', 'petrified', 'poisoned', 'prone', 'restrained', 'stunned', 'unconscious'
]);

const PLAN_KINDS = ['attack', 'dodge', 'dash', 'disengage'];

/**
 * Shared state between the DM panel and the battle view: entity
 * selection and "+ Monster" placement.
 * @returns {{select: (id: string|null) => void, selected: () => string|null,
 *            onSelect: (fn: (id: string|null) => void) => () => void,
 *            arm: (fn: ((cell: {col: number, row: number}) => void)|null) => void,
 *            placing: () => boolean, place: (cell: {col: number, row: number}) => void}}
 */
export function createDmBridge() {
  let selected = null;
  let placer = null;
  const listeners = new Set();
  return {
    select(id) { selected = id ?? null; for (const fn of [...listeners]) fn(selected); },
    selected: () => selected,
    onSelect(fn) { listeners.add(fn); return () => { listeners.delete(fn); }; },
    arm(fn) { placer = typeof fn === 'function' ? fn : null; },
    placing: () => !!placer,
    place(cell) { const fn = placer; placer = null; if (fn) fn(cell); }
  };
}

/**
 * The plan under review: an open `plan` prompt (answerable) merged with
 * the last `turn.planProposed` (carries the breakdown).
 * @param {object} s — ClientState
 * @returns {{promptId: string|null, entityId: string, plan: object, breakdown: object[]}|null}
 */
export function pendingPlan(s) {
  const pr = s?.openPrompt?.kind === 'plan' ? s.openPrompt : null;
  const pp = s?.planProposed || null;
  if (!pr && !pp) return null;
  if (!pr) return null;   // a proposal without an open prompt is already settled
  const entityId = pr.payload?.entityId ?? pp?.entityId;
  const plan = pr?.payload?.plan ?? pp?.plan ?? {};
  const breakdown = pp && pp.entityId === entityId ? pp.breakdown : (plan.breakdown || []);
  return { promptId: pr?.promptId ?? null, entityId, plan, breakdown: Array.isArray(breakdown) ? breakdown : [] };
}

/**
 * @param {HTMLElement} root
 * @param {object} ctx
 * @returns {() => void} unmount
 */
export function mount(root, ctx) {
  const doc = root.ownerDocument;
  const scope = createScope();
  const timers = ctx.deps?.timers || { setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms), clearTimeout: (id) => globalThis.clearTimeout(id) };
  const bridge = ctx.dmBridge || createDmBridge();
  const send = (intent) => ctx.send(intent);
  let confirmEnd = false;
  let confirmTimer = null;
  let pauseMode = 'auto';

  const view = h(doc, 'aside', { class: 'play-view play-dm-panel', attrs: { 'aria-label': 'DM panel' } });
  const status = h(doc, 'p', { class: 'play-status', attrs: { role: 'status', 'aria-live': 'polite' } });
  const say = (msg, kind = 'info') => { status.textContent = msg || ''; status.dataset.kind = kind; };
  const fail = (e) => say(e?.message || String(e), 'error');
  const statusCard = h(doc, 'div', { class: 'play-card play-dm-status' });
  const initCard = h(doc, 'div', { class: 'play-card play-initiative initiative-tracker' });
  const pendingCard = h(doc, 'div', { class: 'play-card play-pending', attrs: { 'aria-live': 'polite' } });
  const rollCard = h(doc, 'div', { class: 'play-card play-roll-review' });
  const inspector = h(doc, 'div', { class: 'play-card play-inspector' });
  const monsterCard = h(doc, 'div', { class: 'play-card play-add-monster' });
  const endCard = h(doc, 'div', { class: 'play-card play-end' });
  const extra = h(doc, 'div', { class: 'play-dm-extra' });   // C11 adjudication mounts here
  view.appendChild(h(doc, 'h2', { text: 'DM' }));
  view.appendChild(status);
  for (const c of [statusCard, pendingCard, initCard, rollCard, inspector, monsterCard, extra, endCard]) view.appendChild(c);
  root.appendChild(view);

  // Static controls (built once so selections survive re-renders).
  const pauseSel = select(doc, { dataset: { action: 'pause-mode' }, attrs: { 'aria-label': 'Pause mode' } }, [
    { value: 'auto', label: 'Auto' }, { value: 'monsters', label: 'Pause each monster' }, { value: 'all', label: 'Pause AI party too' }
  ], pauseMode);
  const rollToggle = h(doc, 'input', { type: 'checkbox', dataset: { action: 'roll-review' }, attrs: { 'aria-label': 'Review monster and AI rolls' } });
  const reactToggle = h(doc, 'input', { type: 'checkbox', dataset: { action: 'monster-reactions' }, attrs: { 'aria-label': 'Decide monster reactions' } });
  const armKind = select(doc, { attrs: { 'aria-label': 'Roll kind' } }, ['attack', 'damage', 'save']);
  const armValue = h(doc, 'input', { type: 'number', value: '20', attrs: { 'aria-label': 'Roll value' } });
  const armEntity = select(doc, { attrs: { 'aria-label': 'Roll for' } }, [{ value: '', label: 'next monster / AI' }]);
  const rollEditor = h(doc, 'div', { class: 'play-roll-editor' });
  replace(doc, rollCard, [
    h(doc, 'h3', { text: 'Review' }),
    h(doc, 'label', {}, ['Plans ', pauseSel]),
    h(doc, 'label', {}, [rollToggle, ' Review monster / AI rolls']),
    h(doc, 'label', {}, [reactToggle, ' Decide monster reactions']),
    rollEditor,
    h(doc, 'div', { class: 'play-row' }, [h(doc, 'span', { text: 'Fix next ' }), armKind, h(doc, 'span', { text: ' roll of ' }), armEntity, h(doc, 'span', { text: ' to ' }), armValue,
      h(doc, 'button', { type: 'button', class: 'play-btn small', dataset: { action: 'arm-roll' }, text: 'Arm' })])
  ]);
  const presetSel = select(doc, { attrs: { 'aria-label': 'Monster preset' } }, Object.values(MONSTER_PRESETS).map(p => ({ value: p.slug, label: p.name })));
  replace(doc, monsterCard, [
    h(doc, 'h3', { text: '+ Monster' }),
    h(doc, 'div', { class: 'play-row' }, [presetSel, h(doc, 'button', { type: 'button', class: 'play-btn', dataset: { action: 'add-monster' }, text: 'Place on map' })])
  ]);
  const outcomeSel = select(doc, { attrs: { 'aria-label': 'Outcome' } }, ENCOUNTER_OUTCOMES.map(o => ({ value: o, label: o })), 'dm-ended');

  const enc = () => ctx.store.getState().encounter;

  delegate(scope, view, 'click', {
    pause: () => attempt(() => send({ t: 'dm.pause', p: {} }), fail),
    resume: () => attempt(() => send({ t: 'dm.resume', p: {} }).then(() => say('Resumed.')), fail),
    'skip-turn': () => attempt(() => send({ t: 'dm.turn.skip', p: {} }), fail),
    'init-up': (el) => reorder(Number(el.dataset.index), -1),
    'init-down': (el) => reorder(Number(el.dataset.index), +1),
    approve: () => answerPlan((p) => p.plan),
    'change-target': () => {
      const sel = pendingCard.querySelector?.('[data-field="plan-target"]');
      answerPlan((p) => ({ ...p.plan, targetId: sel?.value || p.plan.targetId }));
    },
    'change-action': () => {
      const sel = pendingCard.querySelector?.('[data-field="plan-kind"]');
      answerPlan((p) => {
        const kind = sel?.value || p.plan.kind;
        const next = { ...p.plan, kind };
        if (kind !== 'attack') { delete next.targetId; delete next.weaponName; }
        return next;
      });
    },
    'skip-plan': () => answerPlan(() => null),
    'take-control': () => {
      const p = currentPending();
      if (!p) return;
      attempt(() => send({ t: 'dm.seat.setController', p: { entityId: p.entityId, controller: 'dm' } }).then(() => say(`You control ${nameOf(enc(), p.entityId)} from its next turn.`)), fail);
    },
    'roll-apply': () => {
      const pr = ctx.store.getState().openPrompt;
      if (pr?.kind !== 'roll') return;
      attempt(() => send({ t: 'prompt.answer', p: { promptId: pr.promptId, answer: readRollEditor(pr.payload.result) } }), fail);
    },
    'roll-keep': () => {
      const pr = ctx.store.getState().openPrompt;
      if (pr?.kind !== 'roll') return;
      attempt(() => send({ t: 'prompt.answer', p: { promptId: pr.promptId, answer: pr.payload.result } }), fail);
    },
    'arm-roll': () => {
      const value = Math.trunc(Number(armValue.value));
      if (!Number.isFinite(value)) { say('Enter a number to arm.', 'error'); return; }
      attempt(() => send({ t: 'dm.roll.arm', p: { entityId: armEntity.value || null, rollKind: armKind.value, value } }).then(() => say(`Next ${armKind.value} roll armed: ${value}.`)), fail);
    },
    'hp-apply': () => {
      const id = bridge.selected();
      const hpIn = inspector.querySelector?.('[data-field="hp"]');
      const tmpIn = inspector.querySelector?.('[data-field="hp-temp"]');
      if (!id || !hpIn) return;
      const p = { entityId: id };
      const hp = Math.trunc(Number(hpIn.value));
      const tmp = Math.trunc(Number(tmpIn?.value));
      if (Number.isFinite(hp) && hp >= 0) p.hp = hp;
      if (Number.isFinite(tmp) && tmp >= 0) p.hpTemp = tmp;
      attempt(() => send({ t: 'dm.entity.patch', p }), fail);
    },
    'cond-remove': (el) => {
      const id = bridge.selected();
      if (id) attempt(() => send({ t: 'dm.entity.patch', p: { entityId: id, removeConditions: [el.dataset.condition] } }), fail);
    },
    'cond-add': () => {
      const id = bridge.selected();
      const sel = inspector.querySelector?.('[data-field="cond-add"]');
      if (id && sel?.value) attempt(() => send({ t: 'dm.entity.patch', p: { entityId: id, addConditions: [sel.value] } }), fail);
    },
    'remove-entity': () => {
      const id = bridge.selected();
      if (!id) return;
      attempt(() => send({ t: 'dm.entity.remove', p: { entityId: id } }).then(() => bridge.select(null)), fail);
    },
    'add-monster': () => {
      const slug = presetSel.value;
      say(`Click a free cell to place a ${MONSTER_PRESETS[slug]?.name || slug}.`);
      bridge.arm((cell) => {
        const e = enc();
        if (!e) return;
        if (Object.values(e.entities).some(x => x.pos.col === cell.col && x.pos.row === cell.row && x.hp > 0)) { say('That cell is occupied.', 'error'); return; }
        let n = Object.keys(e.entities).length + 1;
        while (e.entities[`m-dm-${n}`]) n++;
        let entity;
        try { entity = entityFromPreset(slug, { id: `m-dm-${n}`, pos: cell }); } catch (err) { fail(err); return; }
        attempt(() => send({ t: 'dm.entity.add', p: { entity } }).then(() => say(`${entity.name} joins the fight.`)), fail);
      });
    },
    'end-encounter': () => {
      if (!confirmEnd) {
        confirmEnd = true;
        renderEnd();
        confirmTimer = timers.setTimeout(() => { confirmEnd = false; confirmTimer = null; renderEnd(); }, 5000);
        return;
      }
      if (confirmTimer !== null) { timers.clearTimeout(confirmTimer); confirmTimer = null; }
      confirmEnd = false;
      renderEnd();
      attempt(() => send({ t: 'dm.encounter.end', p: { outcome: outcomeSel.value } }).then(() => say('Ending the encounter…')), fail);
    }
  });
  delegate(scope, view, 'change', {
    'pause-mode': (el) => {
      pauseMode = PAUSE_MODES[el.value] ? el.value : 'auto';
      attempt(() => send({ t: 'dm.review.set', p: { ...PAUSE_MODES[pauseMode] } }), fail);
    },
    'roll-review': (el) => attempt(() => send({ t: 'dm.review.set', p: { rolls: !!el.checked } }), fail),
    'monster-reactions': (el) => attempt(() => send({ t: 'dm.review.set', p: { monsterReactions: !!el.checked } }), fail),
    'inspect-select': (el) => bridge.select(el.value || null)
  });
  scope.add(() => { if (confirmTimer !== null) timers.clearTimeout(confirmTimer); });
  scope.add(bridge.onSelect(() => renderInspector()));
  scope.add(() => bridge.arm(null));

  function currentPending() { return pendingPlan(ctx.store.getState()); }

  function answerPlan(fn) {
    const p = currentPending();
    if (!p?.promptId) { say('No plan is waiting for review.', 'error'); return; }
    attempt(() => send({ t: 'prompt.answer', p: { promptId: p.promptId, answer: fn(p) } }), fail);
  }

  function reorder(index, delta) {
    const e = enc();
    if (!e) return;
    const order = e.initiative.map(r => r.entityId);
    const j = index + delta;
    if (j < 0 || j >= order.length) return;
    [order[index], order[j]] = [order[j], order[index]];
    attempt(() => send({ t: 'dm.initiative.set', p: { order } }), fail);
  }

  function readRollEditor(result) {
    if (typeof result === 'number') {
      const v = Math.trunc(Number(rollEditor.querySelector?.('[data-field="roll-value"]')?.value));
      return Number.isFinite(v) ? v : result;
    }
    if (result && typeof result === 'object') {
      const out = { ...result };
      for (const k of Object.keys(result)) {
        if (typeof result[k] !== 'number') continue;
        const v = Math.trunc(Number(rollEditor.querySelector?.(`[data-field="roll-${k}"]`)?.value));
        if (Number.isFinite(v)) out[k] = v;
      }
      return out;
    }
    return result;
  }

  // ---- rendering ----
  function renderStatus() {
    const s = ctx.store.getState();
    const st = s.room?.status;
    const paused = st === 'paused' || s.room?.paused === true;
    const awaiting = !!s.room?.turn?.awaitingIntent;
    replace(doc, statusCard, [
      paused
        ? h(doc, 'div', { class: 'play-paused-banner', attrs: { role: 'alert' } }, [
            h(doc, 'strong', { text: 'Paused' }),
            h(doc, 'span', { text: ' — the table waits for you (after a server restart the encounter comes back paused).' }),
            h(doc, 'button', { type: 'button', class: 'play-btn primary', dataset: { action: 'resume' }, text: 'Resume' })
          ])
        : h(doc, 'div', { class: 'play-row' }, [
            h(doc, 'span', { text: st === 'encounter-over' ? 'Encounter over' : 'Running' }),
            st === 'in-encounter' ? h(doc, 'button', { type: 'button', class: 'play-btn', dataset: { action: 'pause' }, text: 'Pause' }) : null,
            awaiting ? h(doc, 'button', { type: 'button', class: 'play-btn', dataset: { action: 'skip-turn' }, text: 'Skip this turn' }) : null
          ])
    ]);
  }

  function renderInitiative() {
    const e = enc();
    if (!e?.initiative?.length) { replace(doc, initCard, [h(doc, 'h3', { text: 'Initiative' }), h(doc, 'p', { class: 'hint-line', text: 'Not rolled yet.' })]); return; }
    const running = e.phase === 'running' || e.phase === 'awaiting-prompt';
    replace(doc, initCard, [
      h(doc, 'h3', { text: `Initiative · round ${Math.max(1, e.round)}` }),
      ...e.initiative.map((r, i) => {
        const x = e.entities[r.entityId];
        return h(doc, 'div', { class: `init-row${running && i === e.turnIndex ? ' active' : ''}${x && x.hp === 0 ? ' down' : ''}` }, [
          h(doc, 'span', { class: 'init-score', text: String(r.score) }),
          h(doc, 'span', { class: 'init-name', text: x?.name || r.entityId }),
          h(doc, 'span', { class: 'init-kind', text: x ? `${x.hp}/${x.hpMax}` : '' }),
          h(doc, 'button', { type: 'button', class: 'play-btn small', dataset: { action: 'init-up', index: i }, attrs: { 'aria-label': `Move ${x?.name || r.entityId} up` }, text: '↑' }),
          h(doc, 'button', { type: 'button', class: 'play-btn small', dataset: { action: 'init-down', index: i }, attrs: { 'aria-label': `Move ${x?.name || r.entityId} down` }, text: '↓' })
        ]);
      })
    ]);
  }

  let pendingKey = null;
  function renderPending() {
    const s = ctx.store.getState();
    const p = currentPending();
    const e = s.encounter;
    const key = p ? `${p.promptId}:${p.breakdown.length}` : 'none';
    if (key === pendingKey) return;
    pendingKey = key;
    if (!p) { replace(doc, pendingCard, [h(doc, 'h3', { text: 'Pending action' }), h(doc, 'p', { class: 'hint-line', text: 'Nothing waiting. Choose a pause mode to review monster plans.' })]); return; }
    const actor = e?.entities?.[p.entityId];
    const why = formatBreakdown({ archetype: p.plan.archetype || 'ai', breakdown: p.breakdown }) || '—';
    const foes = Object.values(e?.entities || {}).filter(x => actor && x.side !== actor.side && x.hp > 0);
    replace(doc, pendingCard, [
      h(doc, 'h3', { text: 'Pending action' }),
      h(doc, 'p', { class: 'play-pending-line', text: `${actor?.name || p.entityId}: ${p.plan.kind}${p.plan.targetId ? ` → ${nameOf(e, p.plan.targetId)}` : ''}${p.plan.weaponName ? ` (${p.plan.weaponName})` : ''}${p.plan.spellId ? ` (${p.plan.spellId})` : ''}` }),
      h(doc, 'p', { class: 'roll-line ai-breakdown', text: `Why: ${why}` }),
      h(doc, 'div', { class: 'play-row' }, [
        h(doc, 'button', { type: 'button', class: 'play-btn primary', dataset: { action: 'approve' }, text: 'Approve' }),
        h(doc, 'button', { type: 'button', class: 'play-btn', dataset: { action: 'skip-plan' }, text: 'Skip' }),
        h(doc, 'button', { type: 'button', class: 'play-btn', dataset: { action: 'take-control' }, text: 'Take control' })
      ]),
      h(doc, 'div', { class: 'play-row' }, [
        select(doc, { dataset: { field: 'plan-target' }, attrs: { 'aria-label': 'New target' } }, foes.map(f => ({ value: f.id, label: f.name })), p.plan.targetId ?? null),
        h(doc, 'button', { type: 'button', class: 'play-btn', dataset: { action: 'change-target' }, text: 'Change target' })
      ]),
      h(doc, 'div', { class: 'play-row' }, [
        select(doc, { dataset: { field: 'plan-kind' }, attrs: { 'aria-label': 'New action' } }, PLAN_KINDS, PLAN_KINDS.includes(p.plan.kind) ? p.plan.kind : 'attack'),
        h(doc, 'button', { type: 'button', class: 'play-btn', dataset: { action: 'change-action' }, text: 'Change action' })
      ])
    ]);
  }

  let rollKey = null;
  function renderRollEditor() {
    const s = ctx.store.getState();
    const room = s.room || {};
    if (room.review) {
      rollToggle.checked = !!room.review.rolls;
      reactToggle.checked = !!room.review.monsterReactions;
    }
    const e = s.encounter;
    const keep = armEntity.value;
    replace(doc, armEntity, []);
    armEntity.appendChild(h(doc, 'option', { value: '', text: 'next monster / AI' }));
    for (const x of Object.values(e?.entities || {})) {
      if (x.kind === 'monster' || x.controller?.type !== 'player') armEntity.appendChild(h(doc, 'option', { value: x.id, text: x.name }));
    }
    armEntity.value = keep || '';
    const pr = s.openPrompt?.kind === 'roll' ? s.openPrompt : null;
    if ((pr?.promptId ?? null) === rollKey) return;
    rollKey = pr?.promptId ?? null;
    if (!pr) { replace(doc, rollEditor, []); return; }
    const p = pr.payload || {};
    const fields = typeof p.result === 'number'
      ? [h(doc, 'input', { type: 'number', value: String(p.result), dataset: { field: 'roll-value' }, attrs: { 'aria-label': 'Roll value' } })]
      : Object.entries(p.result || {}).filter(([, v]) => typeof v === 'number').map(([k, v]) => h(doc, 'label', {}, [`${k} `, h(doc, 'input', { type: 'number', value: String(v), dataset: { field: `roll-${k}` }, attrs: { 'aria-label': k } })]));
    replace(doc, rollEditor, [
      h(doc, 'p', { class: 'play-roll-line', text: `${nameOf(e, p.entityId)} ${p.rollKind} roll${p.targetId ? ` vs ${nameOf(e, p.targetId)}` : ''}:` }),
      ...fields,
      h(doc, 'button', { type: 'button', class: 'play-btn primary', dataset: { action: 'roll-apply' }, text: 'Apply' }),
      h(doc, 'button', { type: 'button', class: 'play-btn', dataset: { action: 'roll-keep' }, text: 'Keep' })
    ]);
  }

  let inspected = { id: undefined, ref: undefined, count: -1 };
  function renderInspector() {
    const e = enc();
    const id = bridge.selected();
    const x = id ? e?.entities?.[id] : null;
    const count = Object.keys(e?.entities || {}).length;
    if (inspected.id === id && inspected.ref === x && inspected.count === count) return;
    inspected = { id, ref: x, count };
    const choices = Object.values(e?.entities || {}).map(o => ({ value: o.id, label: o.name }));
    replace(doc, inspector, [
      h(doc, 'h3', { text: 'Inspector' }),
      select(doc, { dataset: { action: 'inspect-select' }, attrs: { 'aria-label': 'Creature' } }, [{ value: '', label: 'Click a token or pick…' }, ...choices], id || ''),
      x ? h(doc, 'div', { class: 'play-inspect' }, [
        h(doc, 'div', { class: 'play-row' }, [
          h(doc, 'label', {}, ['HP ', h(doc, 'input', { type: 'number', min: 0, max: x.hpMax, value: String(x.hp), dataset: { field: 'hp' }, attrs: { 'aria-label': 'Current HP' } })]),
          h(doc, 'span', { text: ` / ${x.hpMax} ` }),
          h(doc, 'label', {}, ['temp ', h(doc, 'input', { type: 'number', min: 0, value: String(x.hpTemp || 0), dataset: { field: 'hp-temp' }, attrs: { 'aria-label': 'Temporary HP' } })]),
          h(doc, 'button', { type: 'button', class: 'play-btn small', dataset: { action: 'hp-apply' }, text: 'Set' })
        ]),
        h(doc, 'div', { class: 'play-conditions' }, conditionIds(x).map(c => h(doc, 'span', { class: 'play-chip condition' }, [
          c, h(doc, 'button', { type: 'button', class: 'play-chip-x', dataset: { action: 'cond-remove', condition: c }, attrs: { 'aria-label': `Remove ${c}` }, text: '×' })
        ]))),
        h(doc, 'div', { class: 'play-row' }, [
          select(doc, { dataset: { field: 'cond-add' }, attrs: { 'aria-label': 'Add condition' } }, CONDITION_CHOICES.filter(c => !conditionIds(x).includes(c))),
          h(doc, 'button', { type: 'button', class: 'play-btn small', dataset: { action: 'cond-add' }, text: 'Add condition' })
        ]),
        h(doc, 'button', { type: 'button', class: 'play-btn danger', dataset: { action: 'remove-entity' }, text: `Remove ${x.name}` })
      ]) : null
    ]);
  }

  function renderEnd() {
    replace(doc, endCard, [
      h(doc, 'h3', { text: 'End encounter' }),
      outcomeSel,
      h(doc, 'button', { type: 'button', class: `play-btn${confirmEnd ? ' danger' : ''}`, dataset: { action: 'end-encounter' }, text: confirmEnd ? 'Confirm: end the encounter' : 'End encounter…' })
    ]);
  }

  function renderAll() {
    renderStatus();
    renderPending();
    renderInitiative();
    renderRollEditor();
    renderInspector();
  }

  scope.add(ctx.store.subscribe((a) => [a.room, a.encounter, a.openPrompt, a.planProposed], renderAll, (x, y) => x.every((v, i) => v === y[i])));
  renderAll();
  renderEnd();

  return function unmount() {
    scope.dispose();
    if (view.parentNode) view.parentNode.removeChild(view);
  };
}
