/**
 * M64 phase 1.5 (E2 task 4) — the DM's room settings card: reaction
 * timeout, "import live state" (characters import their current D&D
 * Beyond HP / slots / used features instead of starting rested) and who
 * sees the DM's fudges. Sent as `dm.room.settings` (protocol v1.4, E3's
 * names; a partial update with only the changed keys) and confirmed by
 * the `room.settings` broadcast the store folds into `room.settings`.
 *
 * Mounted in the DM panel (battle) and on the DM's claim screen, since
 * the import toggle applies at the next encounter build.
 *
 * mount(root, ctx) → unmount. ctx: {store, send}
 */

import { h, replace, createScope, delegate, attempt, select } from './dom.js';
import { isDm, roomSettingsOf } from '../selectors.js';
import { REACTION_TIMEOUT_RANGE, FUDGE_VISIBILITY } from '../../shared/protocol.js';

/**
 * The `dm.room.settings` payload for the keys that changed, or null.
 * @param {{reactionTimeoutMs: number, importLiveState: boolean, fudgeVisibility: string}} current
 * @param {{seconds: number, importLiveState: boolean, fudgeVisibility: string}} form
 * @returns {{ok: boolean, payload: object|null, reason: string|null}}
 */
export function settingsPatch(current, form) {
  const ms = Math.round(Number(form.seconds) * 1000);
  if (!Number.isFinite(ms) || ms < REACTION_TIMEOUT_RANGE.min || ms > REACTION_TIMEOUT_RANGE.max) {
    return { ok: false, payload: null, reason: `Reaction timeout must be ${REACTION_TIMEOUT_RANGE.min / 1000}–${REACTION_TIMEOUT_RANGE.max / 1000} s.` };
  }
  const p = {};
  if (ms !== current.reactionTimeoutMs) p.reactionTimeoutMs = ms;
  if (!!form.importLiveState !== current.importLiveState) p.importLiveState = !!form.importLiveState;
  if (FUDGE_VISIBILITY.includes(form.fudgeVisibility) && form.fudgeVisibility !== current.fudgeVisibility) p.fudgeVisibility = form.fudgeVisibility;
  return Object.keys(p).length ? { ok: true, payload: p, reason: null } : { ok: false, payload: null, reason: 'Nothing changed.' };
}

/**
 * @param {HTMLElement} root
 * @param {object} ctx
 * @returns {() => void} unmount
 */
export function mount(root, ctx) {
  const doc = root.ownerDocument;
  const scope = createScope();
  const card = h(doc, 'div', { class: 'play-card play-room-settings' });
  const note = h(doc, 'p', { class: 'play-status', attrs: { role: 'status', 'aria-live': 'polite' } });
  const say = (msg, kind = 'info') => { note.textContent = msg || ''; note.dataset.kind = kind; };
  const seconds = h(doc, 'input', { type: 'number', min: REACTION_TIMEOUT_RANGE.min / 1000, max: REACTION_TIMEOUT_RANGE.max / 1000, step: 1, dataset: { field: 'reaction-seconds' }, attrs: { 'aria-label': 'Reaction timeout (seconds)' } });
  const importLive = h(doc, 'input', { type: 'checkbox', dataset: { field: 'import-live' }, attrs: { 'aria-label': 'Import current HP and slots' } });
  const fudge = select(doc, { dataset: { field: 'fudge' }, attrs: { 'aria-label': 'Fudge visibility' } }, [
    { value: 'public', label: 'Players see DM edits' }, { value: 'dm-only', label: 'DM edits hidden from players' }
  ], 'public');
  const effect = h(doc, 'p', { class: 'hint-line' });
  replace(doc, card, [
    h(doc, 'h3', { text: 'Room settings' }),
    h(doc, 'label', {}, ['Reaction timeout ', seconds, ' s']),
    h(doc, 'label', {}, [importLive, ' Import current D&D Beyond HP / slots / used features']),
    effect,
    h(doc, 'label', {}, ['Fudges ', fudge]),
    h(doc, 'button', { type: 'button', class: 'play-btn', dataset: { action: 'settings-save' }, text: 'Save settings' }),
    note
  ]);
  root.appendChild(card);

  let shown = null;
  function render() {
    const s = ctx.store.getState();
    card.hidden = !isDm(s);
    const cur = roomSettingsOf(s);
    const key = JSON.stringify(cur);
    if (key === shown) return;
    shown = key;
    seconds.value = String(Math.round(cur.reactionTimeoutMs / 1000));
    importLive.checked = cur.importLiveState;
    fudge.value = cur.fudgeVisibility;
    effect.textContent = cur.importLiveState
      ? 'Characters import their current state at the next encounter build.'
      : 'Characters start fully rested at the next encounter build.';
  }

  delegate(scope, card, 'click', {
    'settings-save': () => {
      const r = settingsPatch(roomSettingsOf(ctx.store.getState()), { seconds: seconds.value, importLiveState: importLive.checked, fudgeVisibility: fudge.value });
      if (!r.ok) { say(r.reason, r.reason === 'Nothing changed.' ? 'info' : 'error'); return; }
      attempt(() => ctx.send({ t: 'dm.room.settings', p: r.payload }).then(() => say('Settings saved.')), (e) => say(e?.message || String(e), 'error'));
    }
  });

  scope.add(ctx.store.subscribe((a) => [a.room, a.me], render, (x, y) => x.every((v, i) => v === y[i])));
  render();
  return function unmount() {
    scope.dispose();
    if (card.parentNode) card.parentNode.removeChild(card);
  };
}
