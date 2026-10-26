/**
 * M65 C25 — level-ups between nodes (mounted inside the between hub).
 *
 * Driven by the private `levelup.offer` (the seat's controller and the
 * DM receive one per actionable level-up: planLevelUp's `auto`,
 * `choices`, `reconcile`, `missing`, and the `picked` choices once sent)
 * and the snapshot's `levelUps` rows (status per level-up).
 *
 *   summary   HP (fixed average + CON, or a roll), the hit die, the
 *             proficiency bonus, spell slots before → after, new
 *             features, scaling dice, use-count changes, and what only a
 *             D&D Beyond re-import can bring (subclass, feats, …)
 *   choices   the class that gains the level (multiclass), the ASI (+2 or
 *             +1/+1, the cap from the plan), new SRD spells within the
 *             plan's allowance → `levelup.choose` (the seat's controller;
 *             the DM for an AI seat). In choose mode the row then waits
 *             for the DM: players get no confirm button.
 *   DM        `dm.levelup.confirm` (with the DM's own picks for a row still
 *             waiting on its player — an override), `dm.levelup.revert`
 *             on the latest applied level-up of a seat
 *   reconcile paste a fresh D&D Beyond export → `POST /api/import` into the
 *             room (same character row) → `levelup.reconcile`; the offer's
 *             proposals render with `describeDiff`; the DM confirms
 *
 * A multiclass choice is re-planned on the client (`planLevelUp` with the
 * run sheet) so the summary shows the picked class's gains before sending.
 *
 * mount(root, ctx) → unmount. ctx: {store, runStore, send, api, room, runSheets?}
 */

import { h, replace, createScope, delegate, attempt, select } from './dom.js';
import { isDm } from '../selectors.js';
import { mySlots, characterOf, nameOfSlot, refusalText, createRunSheets } from '../run-model.js';
import { planLevelUp } from '../../campaign/level-up.js';
import { describeDiff } from '../../character/diff-character.js';

const STATS = ['STR', 'DEX', 'CON', 'INT', 'WIS', 'CHA'];
const sign = (n) => (n >= 0 ? `+${n}` : String(n));
const slotsText = (t) => {
  const keys = Object.keys(t || {}).filter(k => Number(t[k]) > 0).sort();
  return keys.length ? keys.map(k => `${k}:${t[k]}`).join(' ') : 'none';
};

/**
 * The summary lines of a level-up offer's `auto` part.
 * @param {object} auto — planLevelUp().auto (or {proposals} for a reconcile)
 * @returns {string[]}
 */
export function autoSummary(auto) {
  if (!auto || typeof auto !== 'object') return [];
  const out = [];
  const hp = auto.hp;
  if (hp) {
    out.push(hp.mode === 'roll'
      ? `HP: roll d${hp.die ?? '?'} ${sign(hp.con ?? 0)} (at least 1)`
      : `HP ${sign(hp.gain ?? 0)} (d${hp.die ?? '?'} average ${hp.fixed ?? '?'} ${sign(hp.con ?? 0)} CON)`);
  }
  if (auto.hitDice) out.push(`Hit dice: ${auto.hitDice.className} d${auto.hitDice.die ?? '?'} ${auto.hitDice.maxFrom} → ${auto.hitDice.maxTo}`);
  if (auto.proficiencyBonus && auto.proficiencyBonus.from !== auto.proficiencyBonus.to) {
    out.push(`Proficiency ${sign(auto.proficiencyBonus.from)} → ${sign(auto.proficiencyBonus.to)}`);
  }
  if (auto.spellSlots) {
    out.push(`Spell slots ${slotsText(auto.spellSlots.from?.spell)} → ${slotsText(auto.spellSlots.to?.spell)}`);
    const pf = auto.spellSlots.from?.pact;
    const pt = auto.spellSlots.to?.pact;
    if (pt && JSON.stringify(pf) !== JSON.stringify(pt)) out.push(`Pact slots ${pf ? `${pf.max}×L${pf.level}` : 'none'} → ${pt.max}×L${pt.level}`);
  }
  for (const f of auto.features || []) out.push(`New feature: ${f.name}${f.uses ? ` (${f.uses} use${f.uses === 1 ? '' : 's'}${f.reset ? ` per ${f.reset}` : ''})` : ''}`);
  for (const s of auto.levelScales || []) out.push(`${s.feature}: ${s.from ?? '—'} → ${s.to}`);
  for (const u of auto.usesChanged || []) out.push(`${u.name}: ${u.from} → ${u.to} uses`);
  for (const p of auto.proposals || []) out.push(describeDiff(p));
  return out;
}

/**
 * Validate an ASI draft against the plan's allowance (client-side echo of
 * level-up.js; the server re-checks).
 * @param {object|null} allowance — choices.asi ({points, cap, perStatMax})
 * @param {Record<string, number>} pick
 * @param {Record<string, number>} [scores] — the sheet's ability scores
 * @returns {{ok: boolean, used: number, error?: string, asi?: Record<string, number>}}
 */
export function checkAsi(allowance, pick, scores = {}) {
  const asi = Object.fromEntries(Object.entries(pick || {}).filter(([, n]) => Number(n) > 0).map(([k, n]) => [k, Math.trunc(Number(n))]));
  const used = Object.values(asi).reduce((s, n) => s + n, 0);
  if (!allowance) return used ? { ok: false, used, error: 'No ability score improvement at this level.' } : { ok: true, used, asi: undefined };
  for (const [k, n] of Object.entries(asi)) {
    if (n > allowance.perStatMax) return { ok: false, used, error: `${k} +${n} is more than +${allowance.perStatMax}.` };
    if ((Number(scores[k]) || 10) + n > allowance.cap) return { ok: false, used, error: `${k} would pass ${allowance.cap}.` };
  }
  if (used !== allowance.points) return { ok: false, used, error: `Spend exactly ${allowance.points} points (${used} so far).` };
  return { ok: true, used, asi };
}

/** "Wish, Bless" → ['Wish', 'Bless'] (trimmed, unique, at most 8). */
export function parseSpellList(text) {
  const out = [];
  for (const s of String(text || '').split(/[,\n]/)) {
    const v = s.trim().slice(0, 128);
    if (v && !out.some(x => x.toLowerCase() === v.toLowerCase())) out.push(v);
  }
  return out.slice(0, 8);
}

/** Allowance line for a plan's spell choice. */
export function spellAllowanceText(sp) {
  if (!sp) return '';
  const parts = [];
  if (sp.cantrips) parts.push(`${sp.cantrips} cantrip${sp.cantrips === 1 ? '' : 's'}`);
  const lv = (sp.known || 0) + (sp.prepared || 0);
  if (lv) parts.push(`${lv} spell${lv === 1 ? '' : 's'} up to level ${sp.maxSpellLevel}`);
  return parts.length ? `New spells (SRD): up to ${parts.join(' and ')}.` : '';
}

/** The latest applied level-up id per slot (what dm.levelup.revert may take back). */
export function revertable(levelUps) {
  const best = new Map();
  const n = (id) => Number(/(\d+)$/.exec(String(id))?.[1] ?? 0);
  for (const l of levelUps || []) {
    if (l.status !== 'applied') continue;
    const cur = best.get(l.slotId);
    if (!cur || n(l.id) > n(cur.id)) best.set(l.slotId, l);
  }
  return best;
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
  const view = h(doc, 'section', { class: 'play-card play-levelups', attrs: { 'aria-label': 'Level-ups' } });
  const status = h(doc, 'p', { class: 'play-status', attrs: { role: 'status', 'aria-live': 'polite' } });
  const list = h(doc, 'div', { class: 'play-levelup-list' });
  const recon = h(doc, 'div', { class: 'play-reconcile' });
  view.appendChild(h(doc, 'h3', { text: 'Level-ups' }));
  view.appendChild(status);
  view.appendChild(list);
  view.appendChild(recon);
  root.appendChild(view);
  const say = (msg, kind = 'info') => { status.textContent = msg || ''; status.dataset.kind = kind; };
  const fail = (e) => say(refusalText(e), 'error');
  const dm = () => isDm(ctx.store.getState());
  const run = () => ctx.runStore.getState();
  const dv = (k, d) => (draft.has(k) ? draft.get(k) : d);

  scope.on(view, 'input', (e) => { const el = e.target; if (el?.dataset?.field) draft.set(`${el.dataset.field}|${el.dataset.key || ''}`, el.value); });
  scope.on(view, 'change', (e) => { const el = e.target; if (el?.dataset?.field) { draft.set(`${el.dataset.field}|${el.dataset.key || ''}`, el.value); render(); } });

  /** The draft choices for one level-up (protocol LEVELUP_CHOICES). */
  function choicesFor(offer) {
    const id = offer.levelUpId;
    const out = {};
    const cls = dv(`class|${id}`, offer.choices?.className?.options?.[0] ?? '');
    if (offer.choices?.className && cls) out.className = cls;
    const asi = Object.fromEntries(STATS.map(s => [s, Number(dv(`asi|${id}:${s}`, 0)) || 0]));
    if (Object.values(asi).some(n => n > 0)) out.asi = Object.fromEntries(Object.entries(asi).filter(([, n]) => n > 0));
    const spells = parseSpellList(dv(`spells|${id}`, ''));
    if (spells.length) out.spells = spells;
    return out;
  }

  delegate(scope, view, 'click', {
    'lu-choose': (el) => {
      const offer = run().offers[el.dataset.id];
      if (!offer) return;
      const choices = choicesFor(offer);
      if (offer.choices?.asi) {
        const c = checkAsi(offer.choices.asi, choices.asi || {}, sheets.get(offer.slotId)?.abilityScores);
        if (!c.ok) { say(c.error, 'error'); return; }
      }
      attempt(() => ctx.send({ t: 'levelup.choose', p: { slotId: offer.slotId, levelUpId: offer.levelUpId, choices } })
        .then(() => say('Choices sent — the DM confirms the level.')), fail);
    },
    'lu-confirm': (el) => {
      if (!dm()) return;
      const id = el.dataset.id;
      const offer = run().offers[id];
      const own = offer && offer.status === 'pending_player' ? choicesFor(offer) : null;
      const p = { levelUpId: id, ...(own && Object.keys(own).length ? { choices: own } : {}) };
      attempt(() => ctx.send({ t: 'dm.levelup.confirm', p }).then((ack) => say(`${nameOfSlot(run(), el.dataset.slot)} is now level ${ack?.level ?? '?'}.`)), fail);
    },
    'lu-revert': (el) => {
      if (!dm()) return;
      attempt(() => ctx.send({ t: 'dm.levelup.revert', p: { levelUpId: el.dataset.id } }).then((ack) => say(`Reverted: ${nameOfSlot(run(), el.dataset.slot)} is level ${ack?.level ?? '?'}.`)), fail);
    },
    'lu-spell-search': (el) => {
      const id = el.dataset.id;
      const q = String(dv(`spell-q|${id}`, '')).trim();
      if (!q || typeof ctx.api?.srdSpells !== 'function') return;
      attempt(() => ctx.api.srdSpells(q).then((res) => { draft.set(`spell-results|${id}`, (res?.results || []).slice(0, 10)); render(); }), fail);
    },
    'lu-spell-add': (el) => {
      const id = el.dataset.id;
      const cur = parseSpellList(dv(`spells|${id}`, ''));
      draft.set(`spells|${id}`, parseSpellList([...cur, el.dataset.name].join(', ')).join(', '));
      render();
    },
    'lu-reconcile': (el) => {
      const slotId = el.dataset.slot;
      const text = String(dv(`paste|${slotId}`, '')).trim();
      let json;
      try { json = JSON.parse(text); } catch { say('Paste the character JSON from D&D Beyond first.', 'error'); return; }
      const roomId = ctx.room?.roomId;
      attempt(async () => {
        await ctx.api.importCharacter(roomId, { json });
        const ack = await ctx.send({ t: 'levelup.reconcile', p: { slotId } });
        draft.delete(`paste|${slotId}`);
        say(`${ack?.proposals ?? 0} change${ack?.proposals === 1 ? '' : 's'} from D&D Beyond wait for the DM.`);
      }, fail);
    }
  });

  function choiceControls(offer, sheet) {
    const id = offer.levelUpId;
    const kids = [];
    if (offer.choices?.className) {
      kids.push(h(doc, 'label', { class: 'play-field' }, ['Class gaining the level ',
        select(doc, { dataset: { field: 'class', key: id } }, offer.choices.className.options, dv(`class|${id}`, offer.choices.className.options[0]))]));
    }
    if (offer.choices?.asi) {
      const a = offer.choices.asi;
      const pick = Object.fromEntries(STATS.map(s => [s, Number(dv(`asi|${id}:${s}`, 0)) || 0]));
      const c = checkAsi(a, pick, sheet?.abilityScores);
      kids.push(h(doc, 'p', { class: 'hint-line', text: `Ability score improvement: ${a.points} points, at most +${a.perStatMax} to one score, cap ${a.cap}.` }));
      kids.push(h(doc, 'div', { class: 'play-row' }, STATS.map(s => h(doc, 'label', { class: 'play-field' }, [
        `${s} ${sheet?.abilityScores?.[s] ?? ''} `,
        select(doc, { dataset: { field: 'asi', key: `${id}:${s}` }, attrs: { 'aria-label': `${s} increase` } },
          Array.from({ length: a.perStatMax + 1 }, (_, n) => ({ value: String(n), label: `+${n}` })), String(pick[s]))
      ]))));
      kids.push(h(doc, 'p', { class: `play-preview${c.ok ? '' : ' error'}`, dataset: { field: 'asi-check', key: id }, text: c.ok ? `${c.used}/${a.points} points.` : c.error }));
    }
    if (offer.choices?.spells) {
      kids.push(h(doc, 'p', { class: 'hint-line', text: spellAllowanceText(offer.choices.spells) }));
      kids.push(h(doc, 'label', { class: 'play-field' }, ['Spells (comma separated) ',
        h(doc, 'input', { type: 'text', value: dv(`spells|${id}`, ''), dataset: { field: 'spells', key: id }, attrs: { 'aria-label': 'New spells' } })]));
      kids.push(h(doc, 'div', { class: 'play-row' }, [
        h(doc, 'input', { type: 'search', value: dv(`spell-q|${id}`, ''), placeholder: 'Search SRD spells', dataset: { field: 'spell-q', key: id } }),
        h(doc, 'button', { type: 'button', class: 'play-btn small', dataset: { action: 'lu-spell-search', id }, text: 'Search' }),
        ...(dv(`spell-results|${id}`, []) || []).map(r => h(doc, 'button', { type: 'button', class: 'play-chip', dataset: { action: 'lu-spell-add', id, name: r.name }, text: `${r.name}${Number.isInteger(r.level) ? ` (L${r.level})` : ''}` }))
      ]));
    }
    return kids;
  }

  function card(r, offer, row, canChoose) {
    const id = offer?.levelUpId ?? row.id;
    const slotId = offer?.slotId ?? row.slotId;
    const c = characterOf(r, slotId);
    const statusNow = row?.status ?? offer?.status;
    const reconcile = (offer?.mode ?? row?.mode) === 'reconcile';
    const sheet = sheets.get(slotId, c?.version);
    let auto = offer?.auto || {};
    // A multiclass choice: re-plan with the picked class for the summary.
    if (offer?.choices?.className && sheet && c) {
      try {
        auto = planLevelUp(sheet, c.state, { toLevel: offer.toLevel, className: dv(`class|${id}`, offer.choices.className.options[0]), settings: { hpOnLevel: r.settings?.hpOnLevel } }).auto || {};
      } catch { /* keep the offer's */ }
    }
    const kids = [h(doc, 'h4', { text: reconcile
      ? `${nameOfSlot(r, slotId)}: changes from D&D Beyond`
      : `${nameOfSlot(r, slotId)}: level ${offer?.fromLevel ?? row.fromLevel} → ${offer?.toLevel ?? row.toLevel}` })];
    kids.push(h(doc, 'span', { class: 'play-chip', dataset: { field: 'lu-status', key: id }, text: statusNow === 'pending_player' ? 'choices to make' : statusNow === 'pending_dm' ? 'waiting for the DM' : statusNow }));
    if (offer?.blocked) kids.push(h(doc, 'p', { class: 'play-preview error', text: `The rules cannot plan this level (${offer.blocked}); the DM decides.` }));
    const lines = autoSummary(auto);
    if (lines.length) kids.push(h(doc, 'ul', { class: 'play-levelup-auto' }, lines.map(t => h(doc, 'li', { text: t }))));
    for (const x of offer?.reconcile || []) if (x.kind !== 'multiclass') kids.push(h(doc, 'p', { class: 'hint-line', text: `From D&D Beyond only: ${x.reason}` }));
    if (offer?.missing?.length) kids.push(h(doc, 'p', { class: 'hint-line', text: `The sheet lacks ${offer.missing.join(', ')}; the DM checks the result.` }));
    if (offer?.picked) {
      const p = offer.picked;
      const bits = [p.className ? `class ${p.className}` : null, p.asi ? `ASI ${Object.entries(p.asi).map(([k, n]) => `${k} +${n}`).join(', ')}` : null, p.spells?.length ? `spells ${p.spells.join(', ')}` : null].filter(Boolean);
      kids.push(h(doc, 'p', { dataset: { field: 'lu-picked', key: id }, text: `Picked: ${bits.join('; ') || 'nothing to pick'}` }));
    }
    if (!reconcile && canChoose && statusNow === 'pending_player' && offer) {
      kids.push(...choiceControls(offer, sheet));
      kids.push(h(doc, 'button', { type: 'button', class: 'play-btn primary', dataset: { action: 'lu-choose', id }, text: 'Send choices' }));
    } else if (!dm() && statusNow === 'pending_dm') {
      kids.push(h(doc, 'p', { class: 'hint-line', text: 'The DM confirms this level-up.' }));
    }
    if (dm() && (statusNow === 'pending_dm' || statusNow === 'pending_player')) {
      if (statusNow === 'pending_player' && offer && !canChoose) kids.push(...choiceControls(offer, sheet));
      kids.push(h(doc, 'button', { type: 'button', class: 'play-btn primary', dataset: { action: 'lu-confirm', id, slot: slotId }, text: statusNow === 'pending_player' ? 'Confirm now (override)' : 'Confirm' }));
    }
    return h(doc, 'div', { class: 'play-levelup', dataset: { levelUp: id, slot: slotId } }, kids);
  }

  function render() {
    const r = run();
    if (!r.synced) { replace(doc, list, []); view.hidden = true; return; }
    const roomState = ctx.store.getState();
    const mine = mySlots(r, roomState);
    const mineIds = new Set(mine.map(c => c.slotId));
    const visible = (slotId) => dm() || mineIds.has(slotId);
    for (const c of r.characters) if (visible(c.slotId)) sheets.load(c.slotId, c.version);
    const pending = (r.levelUps || []).filter(l => (l.status === 'pending_player' || l.status === 'pending_dm') && visible(l.slotId));
    const cards = pending.map(l => card(r, r.offers?.[l.id] || null, l, mineIds.has(l.slotId)));
    const reverts = dm() ? [...revertable(r.levelUps).values()] : [];
    if (reverts.length) {
      cards.push(h(doc, 'div', { class: 'play-row play-levelup-reverts' }, reverts.map(l => h(doc, 'button', {
        type: 'button', class: 'play-btn small', dataset: { action: 'lu-revert', id: l.id, slot: l.slotId },
        text: `Revert ${nameOfSlot(r, l.slotId)}'s ${l.mode === 'reconcile' ? 'D&D Beyond changes' : `level ${l.toLevel}`}`
      }))));
    }
    replace(doc, list, cards.length ? cards : [h(doc, 'p', { class: 'hint-line', text: 'No level-up is waiting.' })]);
    // Reconcile: the seats I control (a player's own; the DM's AI seats).
    replace(doc, recon, mine.length ? [h(doc, 'h4', { text: 'Bring changes in from D&D Beyond' }),
      h(doc, 'p', { class: 'hint-line', text: 'Paste the character\'s JSON export: subclass, feats, new spells and features are compared with the run sheet; XP, HP and gear stay the game\'s.' }),
      ...mine.map(c => h(doc, 'div', { class: 'play-row', dataset: { reconcileSlot: c.slotId } }, [
        h(doc, 'textarea', { rows: 2, value: dv(`paste|${c.slotId}`, ''), placeholder: `${c.name || `Seat ${c.seat}`}: D&D Beyond JSON`, dataset: { field: 'paste', key: c.slotId } }),
        h(doc, 'button', { type: 'button', class: 'play-btn small', dataset: { action: 'lu-reconcile', slot: c.slotId }, text: 'Compare' })
      ]))] : []);
    view.hidden = false;
  }

  scope.add(sheets.onLoad(() => render()));
  scope.add(ctx.runStore.subscribe((s) => s, render));
  scope.add(ctx.store.subscribe((a) => a.me, render));
  render();
  return function unmount() {
    scope.dispose();
    if (view.parentNode) view.parentNode.removeChild(view);
  };
}
