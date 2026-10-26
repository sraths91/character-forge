/**
 * M65 C24 — the between-node hub (play.html, room status 'between').
 *
 * One screen for everything that happens between fights:
 *
 *   map        the run map (views/run-map.js): where the party is, what is
 *              on offer, and the DM's advance / begin buttons
 *   here       what the current node offers — a rest node's rest panel, a
 *              shop (views/shop.js), a story (views/story.js)
 *   level-ups  views/level-up.js (offers for my seats; the DM's confirms)
 *   stash      the party stash: claim (`loot.claim`), the DM's assign
 *              (`dm.loot.assign`), the stash coin and an even split
 *   party      per seat I act for: HP, hit dice, purse, the equipped AC
 *              and attack, and its items — equip / unequip / attune
 *              (`item.equip`), drink or feed a potion (`item.use`), give
 *              to a seat or the stash (`item.give`)
 *
 * Previews are the campaign rules run on the client, never a guess:
 *   rest   `applyRest` on the seat's run sheet + state; a short rest's
 *          hit dice are shown as the lowest / middle / highest roll
 *          (rng 0 / 0.5 / ~1), a long rest exactly
 *   equip  `equipItem` / `unequipItem` → `acFor` (the AC entityFromSheet
 *          gives the next encounter) and `deriveAttack`
 *
 * Every action is an intent; the server answers with run events and a
 * fresh `run.snapshot` (client/run-store.js). A refusal shows its code's
 * readable text (client/run-model.js refusalText).
 *
 * mount(root, ctx) → unmount. ctx: {store, runStore, send, api, room, runSheets?}
 */

import { h, replace, createScope, delegate, attempt, select } from './dom.js';
import { isDm } from '../selectors.js';
import {
  mySlots, currentNode, characterOf, nameOfSlot, itemsOf, coinsText, purseCp, cpText, refusalText, createRunSheets
} from '../run-model.js';
import { applyRest, hitDicePool, REST_TYPES } from '../../campaign/rest.js';
import { equipItem, unequipItem } from '../../campaign/items.js';
import { effectiveHpMax } from '../../campaign/exhaustion.js';
import { acFor } from '../../scene/fighting-styles.js';
import { deriveAttack } from '../../scene/pc-stats.js';
import { mount as mountRunMap } from './run-map.js';
import { mount as mountLevelUp } from './level-up.js';
import { mount as mountShop } from './shop.js';
import { mount as mountStory } from './story.js';

/** Node screens mounted in the hub's "here" slot, by node kind. */
const NODE_VIEWS = { shop: mountShop, story: mountStory };

const sign = (n) => (n >= 0 ? `+${n}` : String(n));

/**
 * AC and main attack of a sheet, as the next encounter derives them.
 * @param {object} sheet — run sheet
 * @returns {{ac: number, attack: {name: string, bonus: number, dice: string}}}
 */
export function combatLine(sheet) {
  const a = deriveAttack(sheet);
  return { ac: acFor(sheet), attack: { name: a.name, bonus: a.bonus, dice: a.dice } };
}

/**
 * What equipping (or unequipping) one item would do (items.js on the
 * client — the same functions the controller runs for `item.equip`).
 * @param {object} sheet — run sheet
 * @param {object[]} items — the owner's run items
 * @param {string} itemId
 * @param {boolean} equip
 * @returns {{ok: boolean, before?: object, after?: object, sheet?: object, error?: string}}
 */
export function equipPreview(sheet, items, itemId, equip) {
  if (!sheet) return { ok: false, error: 'loading the sheet…' };
  try {
    const r = equip ? equipItem(sheet, items, itemId) : unequipItem(sheet, items, itemId);
    return { ok: true, before: combatLine(sheet), after: combatLine(r.sheet), sheet: r.sheet };
  } catch (err) {
    return { ok: false, error: refusalText(err) };
  }
}

/** Can a run item be equipped (it names a slot or carries equipment stats)? */
export function isEquippable(item) {
  return !!(item?.data?.slot || item?.data?.equipment);
}

/** Is a run item a potion `item.use` can drink between nodes? */
export function isPotion(item) {
  return !!(item?.data?.potionId || /\bpotion\b/i.test(String(item?.name || '')));
}

const fixedRng = (v) => { const f = () => v; f.state = () => ({ s: 0 }); return f; };

/**
 * A rest's preview for one seat (rest.js applyRest on the client).
 * Short: HP after the declared hit dice at the lowest / middle / highest
 * roll. Long: the exact result. Also the pools that come back.
 * @param {object} sheet
 * @param {object} state
 * @param {'short'|'long'} type
 * @param {{spend?: Record<string, number>, lifeStatus?: string, dawnIsLongRest?: boolean}} [o]
 * @returns {{ok: boolean, error?: string, hp?: {before: number, max: number, low: number, mid: number, high: number},
 *   recovered?: string[], hitDice?: Record<string, {die: number|null, max: number, spent: number, available: number}>}}
 */
export function restPreview(sheet, state, type, { spend = {}, lifeStatus, dawnIsLongRest } = {}) {
  if (!sheet || !state) return { ok: false, error: 'loading the sheet…' };
  const clean = Object.fromEntries(Object.entries(spend || {}).filter(([, n]) => Number(n) > 0).map(([k, n]) => [k, Math.trunc(Number(n))]));
  const opts = { lifeStatus, ...(dawnIsLongRest !== undefined ? { dawnIsLongRest } : {}) };
  try {
    const at = (v) => applyRest(sheet, state, type, { ...opts, ...(type === 'short' ? { spend: clean, rng: fixedRng(v) } : {}) });
    const low = at(0);
    const mid = type === 'short' ? at(0.5) : low;
    const high = type === 'short' ? at(0.999999) : low;
    const recovered = [];
    for (const d of low.deltas) {
      const m = /^resources\.(.+)\.spent$/.exec(d.path);
      if (m && d.after === 0) recovered.push(state.resources?.[m[1]]?.label || m[1]);
      else if (/^slots\.spell\.\d\.spent$/.test(d.path) && d.after === 0) recovered.push(`level ${d.path.split('.')[2]} slots`);
      else if (d.path === 'slots.pact.spent' && d.after === 0) recovered.push('pact slots');
      else if (d.path === 'exhaustion') recovered.push(`exhaustion ${d.before} → ${d.after}`);
    }
    return {
      ok: true,
      hp: { before: state.hp?.current ?? 0, max: effectiveHpMax(sheet, state), low: low.state.hp.current, mid: mid.state.hp.current, high: high.state.hp.current },
      recovered,
      hitDice: hitDicePool(sheet, type === 'short' ? low.state : state)
    };
  } catch (err) {
    return { ok: false, error: refusalText(err) };
  }
}

/**
 * The stash coin split evenly across the living seats (a preview only:
 * no intent moves stash coin into purses; the stash pays at a shop when a
 * buyer's purse runs short).
 * @param {object} stash
 * @param {object[]} characters
 * @returns {{totalCp: number, ways: number, eachCp: number}}
 */
export function stashSplit(stash, characters) {
  const totalCp = purseCp(stash?.currency);
  const ways = (characters || []).filter(c => c.lifeStatus !== 'dead').length;
  return { totalCp, ways, eachCp: ways ? Math.floor(totalCp / ways) : 0 };
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
  const sub = { ...ctx, runSheets: sheets };
  /** UI drafts (inputs survive re-renders): `${field}|${key}` → value. */
  const draft = new Map();
  const view = h(doc, 'section', { class: 'play-view play-between', attrs: { 'aria-label': 'Between nodes' } });
  const status = h(doc, 'p', { class: 'play-status', attrs: { role: 'status', 'aria-live': 'polite' } });
  const mapHost = h(doc, 'div', { class: 'play-between-map' });
  const hereHost = h(doc, 'div', { class: 'play-between-here' });
  const restHost = h(doc, 'div', { class: 'play-card play-rest', hidden: true });
  const levelHost = h(doc, 'div', { class: 'play-between-levelups' });
  const stashHost = h(doc, 'div', { class: 'play-card play-stash' });
  const partyHost = h(doc, 'div', { class: 'play-between-party' });
  view.appendChild(status);
  view.appendChild(mapHost);
  view.appendChild(hereHost);
  view.appendChild(restHost);
  view.appendChild(levelHost);
  view.appendChild(stashHost);
  view.appendChild(partyHost);
  root.appendChild(view);
  const say = (msg, kind = 'info') => { status.textContent = msg || ''; status.dataset.kind = kind; };
  const fail = (e) => say(refusalText(e), 'error');
  const send = (t, p, okMsg) => attempt(() => ctx.send({ t, p }).then((ack) => { if (okMsg) say(typeof okMsg === 'function' ? okMsg(ack) : okMsg); return ack; }), fail);

  const unmountMap = mountRunMap(mapHost, sub);
  const unmountLevel = mountLevelUp(levelHost, sub);
  let here = { key: null, off: null };

  const dm = () => isDm(ctx.store.getState());
  const run = () => ctx.runStore.getState();
  const dv = (field, key, fallback) => (draft.has(`${field}|${key}`) ? draft.get(`${field}|${key}`) : fallback);
  const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : d);

  // Inputs keep their value in `draft` (re-renders read it back).
  const keep = (el) => { if (el.dataset.field) draft.set(`${el.dataset.field}|${el.dataset.key || ''}`, el.type === 'checkbox' ? el.checked : el.value); };
  scope.on(view, 'input', (e) => { const el = e.target; if (el?.dataset?.field && el.closest?.('[data-between]')) keep(el); });
  scope.on(view, 'change', (e) => { const el = e.target; if (el?.dataset?.field && el.closest?.('[data-between]')) { keep(el); render(); } });

  delegate(scope, view, 'click', {
    'rest-declare': (el) => {
      const slotId = el.dataset.slot;
      const c = characterOf(run(), slotId);
      const sheet = sheets.get(slotId);
      if (!c || !sheet) return;
      const hitDice = {};
      for (const cls of Object.keys(hitDicePool(sheet, c.state))) {
        const n = num(dv('hd', `${slotId}:${cls}`, 0));
        if (n > 0) hitDice[cls] = n;
      }
      if (!Object.keys(hitDice).length) { say('Pick at least one hit die to spend.', 'error'); return; }
      send('rest.spend', { slotId, hitDice }, `${nameOfSlot(run(), slotId)} will spend ${Object.entries(hitDice).map(([k, n]) => `${n} ${k}`).join(', ')} hit dice.`);
    },
    'rest-grant': (el) => {
      if (!dm()) return;
      send('dm.rest.grant', { type: el.dataset.type }, `${REST_TYPES[el.dataset.type]?.label || 'Rest'} taken.`);
    },
    'loot-claim': (el) => {
      const itemId = el.dataset.item;
      const slotId = String(dv('claim-to', itemId, el.dataset.slot || ''));
      const qty = Math.max(1, num(dv('claim-qty', itemId, 1), 1));
      send('loot.claim', { slotId, itemId, qty }, 'Claimed.');
    },
    'loot-assign': (el) => {
      if (!dm()) return;
      const itemId = el.dataset.item;
      const to = String(dv('assign-to', itemId, el.dataset.default || ''));
      const qty = Math.max(1, num(dv('assign-qty', itemId, 1), 1));
      send('dm.loot.assign', { itemId, toSlotId: to || null, qty }, 'Assigned.');
    },
    'item-equip': (el) => {
      const p = { slotId: el.dataset.slot, itemId: el.dataset.item, equipped: el.dataset.equip === '1' };
      send('item.equip', p, p.equipped ? 'Equipped.' : 'Unequipped.');
    },
    'item-attune': (el) => {
      send('item.equip', { slotId: el.dataset.slot, itemId: el.dataset.item, equipped: true, attuned: el.dataset.attune === '1' },
        el.dataset.attune === '1' ? 'Attuned.' : 'Attunement ended.');
    },
    'item-use': (el) => {
      const slotId = el.dataset.slot;
      const itemId = el.dataset.item;
      const target = String(dv('use-on', itemId, slotId));
      send('item.use', { slotId, itemId, ...(target && target !== slotId ? { targetSlotId: target } : {}) },
        (ack) => `${nameOfSlot(run(), target || slotId)} regains ${ack?.healed ?? 0} HP.`);
    },
    'item-give': (el) => {
      const slotId = el.dataset.slot;
      const itemId = el.dataset.item;
      const to = String(dv('give-to', itemId, ''));
      const qty = Math.max(1, num(dv('give-qty', itemId, 1), 1));
      send('item.give', { slotId, itemId, toSlotId: to || null, qty }, `Given to ${to ? nameOfSlot(run(), to) : 'the party stash'}.`);
    }
  });

  // ------------------------------------------------------------ here

  function renderHere(r) {
    const node = currentNode(r);
    const kind = node && r.status === 'between' && (node.kind === 'shop' || node.kind === 'story') ? node.kind : null;
    const key = kind ? `${kind}:${node.id}` : null;
    if (key === here.key) return;
    here.off?.();
    replace(doc, hereHost, []);
    here = { key, off: null };
    const fn = kind ? NODE_VIEWS[kind] : null;
    if (fn) here.off = fn(hereHost, sub);
  }

  // ------------------------------------------------------------ rest

  function renderRest(r, mine) {
    const node = currentNode(r);
    const restNode = node?.kind === 'rest' && r.status === 'between' && !r.completed;
    restHost.hidden = !restNode;
    if (!restNode) { replace(doc, restHost, []); return; }
    const type = node.payload?.type || 'short';
    const types = type === 'choice' ? ['short', 'long'] : [type];
    const kids = [h(doc, 'h3', { text: types.map(t => REST_TYPES[t].label).join(' or ') })];
    kids.push(h(doc, 'p', { class: 'hint-line', text: types.includes('short')
      ? 'Declare the hit dice each character spends; the DM grants the rest and the dice are rolled then.'
      : 'A long rest restores HP, half your hit dice, every slot and long-rest feature.' }));
    for (const c of mine) {
      const sheet = sheets.get(c.slotId, c.version);
      const rows = [h(doc, 'strong', { text: c.name || `Seat ${c.seat}` })];
      if (!sheet) { rows.push(h(doc, 'span', { class: 'hint-line', text: ' loading…' })); kids.push(h(doc, 'div', { class: 'play-row', dataset: { between: '1' } }, rows)); continue; }
      const pool = hitDicePool(sheet, c.state);
      const declared = r.pendingRest?.[c.slotId] || {};
      for (const t of types) {
        const spend = {};
        if (t === 'short') {
          for (const [cls, p] of Object.entries(pool)) {
            const n = Math.min(p.available, Math.max(0, num(dv('hd', `${c.slotId}:${cls}`, declared[cls] ?? 0))));
            spend[cls] = n;
            rows.push(h(doc, 'label', { class: 'play-field' }, [
              `${cls} d${p.die ?? '?'} (${p.available}/${p.max} left) `,
              h(doc, 'input', { type: 'number', min: 0, max: p.available, value: String(n), dataset: { field: 'hd', key: `${c.slotId}:${cls}` }, attrs: { 'aria-label': `${cls} hit dice to spend` } })
            ]));
          }
        }
        const pv = restPreview(sheet, c.state, t, { spend, lifeStatus: c.lifeStatus, dawnIsLongRest: r.settings?.dawnIsLongRest });
        rows.push(h(doc, 'span', { class: `play-preview${pv.ok ? '' : ' error'}`, dataset: { preview: `rest-${t}`, slot: c.slotId }, text: pv.ok
          ? ` ${REST_TYPES[t].label}: HP ${pv.hp.before} → ${pv.hp.low === pv.hp.high ? pv.hp.low : `${pv.hp.low}–${pv.hp.high} (≈${pv.hp.mid})`} / ${pv.hp.max}${pv.recovered.length ? ` · back: ${pv.recovered.join(', ')}` : ''}`
          : ` ${pv.error}` }));
        if (t === 'short') {
          rows.push(h(doc, 'button', { type: 'button', class: 'play-btn small', dataset: { action: 'rest-declare', slot: c.slotId }, text: 'Declare hit dice' }));
          const d = Object.entries(declared).filter(([, n]) => n > 0);
          if (d.length) rows.push(h(doc, 'span', { class: 'play-chip', text: `declared: ${d.map(([k, n]) => `${n} ${k}`).join(', ')}` }));
        }
      }
      kids.push(h(doc, 'div', { class: 'play-row', dataset: { between: '1', restSlot: c.slotId } }, rows));
    }
    const others = Object.entries(r.pendingRest || {}).filter(([slotId]) => !mine.some(c => c.slotId === slotId));
    if (others.length) {
      kids.push(h(doc, 'p', { class: 'hint-line', text: `Declared: ${others.map(([s, hd]) => `${nameOfSlot(r, s)} ${Object.entries(hd).map(([k, n]) => `${n} ${k}`).join(', ')}`).join('; ')}` }));
    }
    if (dm()) {
      kids.push(h(doc, 'div', { class: 'play-row' }, types.map(t => h(doc, 'button', { type: 'button', class: 'play-btn primary', dataset: { action: 'rest-grant', type: t }, text: `Grant the ${REST_TYPES[t].label.toLowerCase()}` }))));
    } else {
      kids.push(h(doc, 'p', { class: 'hint-line', text: 'The DM grants the rest.' }));
    }
    replace(doc, restHost, kids);
  }

  // ------------------------------------------------------------ stash

  function renderStash(r, mine) {
    const stash = itemsOf(r, null);
    const split = stashSplit(r.stash, r.characters);
    const node = currentNode(r);
    const dmOnly = node?.kind === 'loot' && node.payload?.assign === 'dm';
    const kids = [h(doc, 'h3', { text: 'Party stash' })];
    kids.push(h(doc, 'p', { dataset: { field: 'stash-coin' }, text: `Coin: ${coinsText(r.stash?.currency)}${split.totalCp && split.ways > 1 ? ` — an even split is ${cpText(split.eachCp)} each for ${split.ways}` : ''}` }));
    if (split.totalCp) kids.push(h(doc, 'p', { class: 'hint-line', text: 'The stash pays at a shop when the buyer\'s purse runs short.' }));
    if (!stash.length) kids.push(h(doc, 'p', { class: 'hint-line', text: 'No items in the stash.' }));
    const seatOpts = r.characters.map(c => ({ value: c.slotId, label: c.name || `Seat ${c.seat}` }));
    for (const it of stash) {
      const row = [h(doc, 'span', { class: 'play-item-name', text: `${it.name} ×${it.qty}` })];
      if (mine.length && !dmOnly && !dm()) {
        if (mine.length > 1) row.push(select(doc, { dataset: { field: 'claim-to', key: it.id }, attrs: { 'aria-label': 'Claim for' } }, mine.map(c => ({ value: c.slotId, label: c.name })), dv('claim-to', it.id, mine[0].slotId)));
        if (it.qty > 1) row.push(h(doc, 'input', { type: 'number', min: 1, max: it.qty, value: String(dv('claim-qty', it.id, 1)), dataset: { field: 'claim-qty', key: it.id }, attrs: { 'aria-label': 'Quantity' } }));
        row.push(h(doc, 'button', { type: 'button', class: 'play-btn small', dataset: { action: 'loot-claim', item: it.id, slot: mine[0].slotId }, text: 'Claim' }));
      }
      if (dm()) {
        row.push(select(doc, { dataset: { field: 'assign-to', key: it.id }, attrs: { 'aria-label': 'Assign to' } }, seatOpts, dv('assign-to', it.id, seatOpts[0]?.value)));
        if (it.qty > 1) row.push(h(doc, 'input', { type: 'number', min: 1, max: it.qty, value: String(dv('assign-qty', it.id, 1)), dataset: { field: 'assign-qty', key: it.id }, attrs: { 'aria-label': 'Quantity' } }));
        row.push(h(doc, 'button', { type: 'button', class: 'play-btn small', dataset: { action: 'loot-assign', item: it.id, default: seatOpts[0]?.value || '' }, text: 'Assign' }));
      }
      kids.push(h(doc, 'div', { class: 'play-row', dataset: { between: '1', stashItem: it.id } }, row));
    }
    if (dmOnly && !dm() && stash.length) kids.push(h(doc, 'p', { class: 'hint-line', text: 'The DM hands out this loot.' }));
    replace(doc, stashHost, kids);
  }

  // ------------------------------------------------------------ party

  function seatCard(r, c) {
    const sheet = sheets.get(c.slotId, c.version);
    const mine = itemsOf(r, c.slotId);
    const kids = [h(doc, 'h3', { text: `${c.name || `Seat ${c.seat}`} — level ${c.level}${c.lifeStatus !== 'active' ? ` (${c.lifeStatus})` : ''}` })];
    const st = c.state || {};
    const line = sheet ? combatLine(sheet) : null;
    kids.push(h(doc, 'p', { dataset: { field: 'seat-line', slot: c.slotId }, text: [
      `HP ${st.hp?.current ?? '?'}${sheet ? ` / ${effectiveHpMax(sheet, st)}` : ''}${st.hp?.temp ? ` (+${st.hp.temp} temp)` : ''}`,
      line ? `AC ${line.ac}` : null,
      line ? `${line.attack.name} ${sign(line.attack.bonus)} (${line.attack.dice})` : null,
      `purse ${coinsText(st.currency)}`
    ].filter(Boolean).join(' · ') }));
    if (!mine.length) kids.push(h(doc, 'p', { class: 'hint-line', text: 'Carries nothing.' }));
    const others = r.characters.filter(o => o.slotId !== c.slotId);
    for (const it of mine) {
      const row = [h(doc, 'span', { class: 'play-item-name', text: `${it.name}${it.qty > 1 ? ` ×${it.qty}` : ''}${it.equipped ? ' (equipped)' : ''}${it.attuned ? ' (attuned)' : ''}` })];
      if (isEquippable(it)) {
        const pv = equipPreview(sheet, mine, it.id, !it.equipped);
        row.push(h(doc, 'button', { type: 'button', class: 'play-btn small', dataset: { action: 'item-equip', slot: c.slotId, item: it.id, equip: it.equipped ? '0' : '1' }, disabled: !pv.ok, text: it.equipped ? 'Unequip' : 'Equip' }));
        row.push(h(doc, 'span', { class: `play-preview${pv.ok ? '' : ' error'}`, dataset: { preview: 'equip', item: it.id }, text: pv.ok
          ? ` AC ${pv.before.ac} → ${pv.after.ac} · ${pv.after.attack.name} ${sign(pv.after.attack.bonus)} (${pv.after.attack.dice})`
          : ` ${pv.error}` }));
      }
      if (it.data?.canAttune && it.equipped) {
        row.push(h(doc, 'button', { type: 'button', class: 'play-btn small', dataset: { action: 'item-attune', slot: c.slotId, item: it.id, attune: it.attuned ? '0' : '1' }, text: it.attuned ? 'End attunement' : 'Attune' }));
      }
      if (isPotion(it)) {
        if (others.length) row.push(select(doc, { dataset: { field: 'use-on', key: it.id }, attrs: { 'aria-label': 'Drink or give to' } }, r.characters.map(o => ({ value: o.slotId, label: o.slotId === c.slotId ? 'self' : o.name })), dv('use-on', it.id, c.slotId)));
        row.push(h(doc, 'button', { type: 'button', class: 'play-btn small', dataset: { action: 'item-use', slot: c.slotId, item: it.id }, text: 'Use' }));
      }
      if (!it.equipped && !it.attuned) {
        row.push(select(doc, { dataset: { field: 'give-to', key: it.id }, attrs: { 'aria-label': 'Give to' } }, [{ value: '', label: 'party stash' }, ...others.map(o => ({ value: o.slotId, label: o.name || `Seat ${o.seat}` }))], dv('give-to', it.id, '')));
        if (it.qty > 1) row.push(h(doc, 'input', { type: 'number', min: 1, max: it.qty, value: String(dv('give-qty', it.id, 1)), dataset: { field: 'give-qty', key: it.id }, attrs: { 'aria-label': 'Quantity' } }));
        row.push(h(doc, 'button', { type: 'button', class: 'play-btn small', dataset: { action: 'item-give', slot: c.slotId, item: it.id }, text: 'Give' }));
      }
      kids.push(h(doc, 'div', { class: 'play-row', dataset: { between: '1', item: it.id } }, row));
    }
    return h(doc, 'div', { class: 'play-card play-seat-card', dataset: { slot: c.slotId } }, kids);
  }

  function renderParty(r, mine) {
    if (!mine.length) {
      replace(doc, partyHost, [h(doc, 'p', { class: 'hint-line', text: dm() ? 'Every seat is a player\'s: they manage their own gear.' : 'You hold no seat in this run.' })]);
      return;
    }
    replace(doc, partyHost, mine.map(c => seatCard(r, c)));
  }

  function render() {
    const r = run();
    if (!r.synced) { say('Waiting for the run…'); return; }
    const mine = mySlots(r, ctx.store.getState());
    for (const c of mine) sheets.load(c.slotId, c.version);
    renderHere(r);
    renderRest(r, mine);
    renderStash(r, mine);
    renderParty(r, mine);
  }

  scope.add(sheets.onLoad(() => render()));
  scope.add(ctx.runStore.subscribe((s) => s, render));
  scope.add(ctx.store.subscribe((a) => a.me, render));
  render();
  return function unmount() {
    here.off?.();
    unmountLevel();
    unmountMap();
    scope.dispose();
    if (view.parentNode) view.parentNode.removeChild(view);
  };
}
