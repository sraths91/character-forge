/**
 * M65 V21 — the forge's cinema style pickers at the table.
 *
 * The forge let each PC pick an attack style (Quick / Standard / Power /
 * Flourish, gated by level) and a swing (a weapon-appropriate cut, or
 * "Varied"). At the table the same picks live here, in the battle view's
 * side column, for every PC this viewer drives: their own seats, and — for
 * the DM of a solo room — the DM-driven seats.
 *
 *   - A pick is saved per character (anim/motion-styles `saveStyle`,
 *     anim/swing-types `saveSwing`, the forge's own storage keys, so the
 *     forge handoff carries them over).
 *   - For a seat this member holds, the pick is also sent as
 *     `char.setStyle {characterId, style, swing}`, so the server stamps it
 *     on the exchange every viewer sees.
 *   - The server only accepts `char.setStyle` from a seat's player, so for
 *     DM-driven seats `cinemaOverride` applies the pick locally: the render
 *     adapter merges it into the exchange's cinema before
 *     `buildCinemaSequence` (pure: a new event, never the input). "Varied"
 *     resolves per attack with the forge's `nextVariedSwing` counter.
 *
 * mount(root, ctx) → unmount. ctx: {store, send, sheets() → Record<id, sheet>, onSheet?}
 */

import { h, replace, createScope, delegate, attempt, select } from './dom.js';
import { isDm, myEntityIds } from '../selectors.js';
import { availableStyles, isStyle, loadStyle, saveStyle } from '../../anim/motion-styles.js';
import { availableSwings, isSwing, isSwingSelection, loadSwing, saveSwing, nextVariedSwing } from '../../anim/swing-types.js';
import { motionMetaForWeapon } from '../../anim/cinema-plan.js';

const levelOf = (sheet) => (sheet?.classes || []).reduce((n, c) => n + (c?.level || 0), 0) || 1;
const weaponClassOf = (sheet) => motionMetaForWeapon(sheet?.equipment?.mainhand || null).weaponClass || 'sword';

/**
 * The PCs whose cinema this viewer picks for.
 * @param {object} s — ClientState
 * @returns {object[]} entities
 */
export function styledEntities(s) {
  const enc = s?.encounter;
  if (!enc) return [];
  const mine = new Set(myEntityIds(s));
  const dm = isDm(s);
  return Object.values(enc.entities || {}).filter(e => e.kind === 'pc' && e.sheetRef?.characterId &&
    (mine.has(e.id) || (dm && (e.controller?.type === 'dm' || e.controller?.type === 'ai'))));
}

/**
 * The cinema override for one exchange: this viewer's saved pick for the
 * attacker, when the viewer drives that PC; null otherwise.
 * @param {object} opts
 * @param {object} opts.store — client store
 * @param {(characterId: string) => {style: string|null, swing: string|null}} [opts.pickFor]
 * @returns {(payload: object) => ({style?: string, swing?: string}|null)}
 */
export function createCinemaOverride({ store, pickFor = (id) => ({ style: loadStyle(id), swing: loadSwing(id) }) }) {
  const counters = new Map();
  return function cinemaOverride(payload) {
    if (!payload || payload.cast || payload.reaction) return null;
    const s = store.getState();
    const ent = styledEntities(s).find(e => e.id === payload.attackerId);
    if (!ent) return null;
    const pick = pickFor(ent.sheetRef.characterId) || {};
    const out = {};
    if (isStyle(pick.style)) out.style = pick.style;
    if (pick.swing === 'varied') {
      const meta = motionMetaForWeapon(payload.cinema?.weapon ?? null);
      if (meta.kind === 'melee') {
        const n = counters.get(ent.id) || 0;
        counters.set(ent.id, n + 1);
        out.swing = nextVariedSwing(meta.weaponClass || 'sword', n);
      }
    } else if (isSwing(pick.swing)) out.swing = pick.swing;
    return Object.keys(out).length ? out : null;
  };
}

/**
 * @param {HTMLElement} root
 * @param {object} ctx
 * @returns {() => void} unmount
 */
export function mount(root, ctx) {
  const doc = root.ownerDocument;
  const scope = createScope();
  const card = h(doc, 'div', { class: 'play-card play-cinema-style', hidden: true });
  root.appendChild(card);
  const sheets = () => (typeof ctx.sheets === 'function' ? ctx.sheets() : (ctx.sheets || {}));
  let shown = null;

  function render() {
    const s = ctx.store.getState();
    const ents = styledEntities(s);
    const rows = ents.map((e) => {
      const id = e.sheetRef.characterId;
      const sheet = sheets()[id] || null;
      return { e, id, level: levelOf(sheet), wc: weaponClassOf(sheet), style: loadStyle(id) || 'standard', swing: loadSwing(id) || 'varied' };
    });
    const key = JSON.stringify(rows.map(r => [r.e.id, r.e.name, r.level, r.wc, r.style, r.swing]));
    if (key === shown) return;
    shown = key;
    card.hidden = !rows.length;
    replace(doc, card, [
      h(doc, 'h3', { text: 'Cinema style' }),
      ...rows.map(r => h(doc, 'div', { class: 'play-row play-style-row' }, [
        h(doc, 'span', { class: 'play-style-name', text: r.e.name || r.id }),
        select(doc, { dataset: { action: 'pick-style', character: r.id }, attrs: { 'aria-label': `Attack style for ${r.e.name || r.id}` } },
          availableStyles(r.level).map(st => ({ value: st.id, label: `${st.label}${st.minLevel > 1 ? ` (lvl ${st.minLevel}+)` : ''}` })), r.style),
        select(doc, { dataset: { action: 'pick-swing', character: r.id }, attrs: { 'aria-label': `Swing for ${r.e.name || r.id}` } },
          [{ value: 'varied', label: 'Varied (alternate)' }, ...availableSwings(r.wc).map(sw => ({ value: sw.id, label: sw.label }))], r.swing)
      ]))
    ]);
  }

  /** A seat this member holds: tell the server too (char.setStyle is seat-only). */
  function publish(characterId) {
    const s = ctx.store.getState();
    const mine = new Set(myEntityIds(s));
    const ent = styledEntities(s).find(e => e.sheetRef.characterId === characterId);
    if (!ent || !mine.has(ent.id) || ent.controller?.type !== 'player') return;
    const style = loadStyle(characterId) || 'standard';
    const swing = loadSwing(characterId) || null;
    attempt(() => ctx.send({ t: 'char.setStyle', p: { characterId, style, swing } }), (err) => {
      globalThis.console?.warn?.(JSON.stringify({ event: 'cinema_style.publish_failed', characterId, error: String(err?.message || err) }));
    });
  }

  delegate(scope, card, 'change', {
    'pick-style': (el) => { if (isStyle(el.value)) { saveStyle(el.dataset.character, el.value); publish(el.dataset.character); shown = null; render(); } },
    'pick-swing': (el) => { if (isSwingSelection(el.value)) { saveSwing(el.dataset.character, el.value); publish(el.dataset.character); shown = null; render(); } }
  });
  scope.add(ctx.store.subscribe((a) => [a.encounter, a.me, a.seats], render, (x, y) => x.every((v, i) => v === y[i])));
  if (ctx.onSheet) scope.add(ctx.onSheet(() => render()));
  render();
  return function unmount() {
    scope.dispose();
    if (card.parentNode) card.parentNode.removeChild(card);
  };
}
