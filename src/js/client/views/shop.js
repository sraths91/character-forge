/**
 * M65 C26 — a shop node (mounted in the between hub's "here" slot).
 *
 *   buy   the node's stock (`payload.stock[{ref, qty, price?}]`), what is
 *         left this visit (stock − the snapshot's `bought`), the unit
 *         price — the stock row's DM price, else `priceOf` the SRD record
 *         (`GET /api/srd/items/:key`, cached); "0.00" and unknown costs
 *         are unpriced and cannot be bought — → `shop.buy {slotId,
 *         refKey, qty}`. The seat's purse pays, else the party stash (the
 *         controller's rule); a purchase past both comes back as
 *         `insufficient-funds` and reads as a sentence (refusalText).
 *   sell  the seat's priced, unequipped items at the shop's buyback
 *         (default half) → `shop.sell {slotId, itemId, qty}`.
 *
 * mount(root, ctx) → unmount. ctx: {store, runStore, send, api}
 */

import { h, replace, createScope, delegate, attempt, select } from './dom.js';
import { mySlots, currentNode, itemsOf, coinsText, purseCp, cpText, refusalText } from '../run-model.js';
import { priceOf, purseToCp } from '../../campaign/items.js';

/** "srd_potion-of-healing" → "Potion of healing". */
export function nameFromRef(ref) {
  const s = String(ref || '').replace(/^srd_/, '').replace(/[-_]+/g, ' ').trim();
  return s ? s[0].toUpperCase() + s.slice(1) : 'Item';
}

/**
 * The shop's rows for this visit.
 * @param {object} node — the shop node (payload.stock)
 * @param {Record<string, number>} bought — refKey → qty bought this visit
 * @param {Record<string, object|null>} records — SRD records by key (for unpriced rows)
 * @returns {{ref: string, name: string, left: number, unitCp: number|null}[]}
 */
export function shopRows(node, bought = {}, records = {}) {
  return (node?.payload?.stock || []).map((s) => {
    const rec = records[s.ref] || null;
    const unitCp = s.price ? purseToCp(s.price) : (rec ? priceOf(rec).buyCp : null);
    return { ref: s.ref, name: s.name || rec?.name || nameFromRef(s.ref), left: Math.max(0, (s.qty ?? 0) - (bought?.[s.ref] || 0)), unitCp: unitCp > 0 ? unitCp : null };
  });
}

/**
 * What the shop pays for one of a run item (null when unpriced).
 * @param {object} item — run item
 * @param {number} [buyback=0.5]
 * @returns {number|null} copper
 */
export function sellPriceCp(item, buyback = 0.5) {
  const p = priceOf(item);
  return p.priced ? Math.floor(p.buyCp * buyback) : null;
}

/**
 * @param {HTMLElement} root
 * @param {object} ctx
 * @returns {() => void} unmount
 */
export function mount(root, ctx) {
  const doc = root.ownerDocument;
  const scope = createScope();
  const draft = new Map();
  const records = {};
  const asked = new Set();
  const view = h(doc, 'section', { class: 'play-card play-shop', attrs: { 'aria-label': 'Shop' } });
  const status = h(doc, 'p', { class: 'play-status', attrs: { role: 'status', 'aria-live': 'polite' } });
  const body = h(doc, 'div');
  view.appendChild(status);
  view.appendChild(body);
  root.appendChild(view);
  let disposed = false;
  const say = (msg, kind = 'info') => { status.textContent = msg || ''; status.dataset.kind = kind; };
  const fail = (e) => say(refusalText(e), 'error');
  const run = () => ctx.runStore.getState();
  const dv = (k, d) => (draft.has(k) ? draft.get(k) : d);
  const keep = (el) => { if (el?.dataset?.field) draft.set(`${el.dataset.field}|${el.dataset.key || ''}`, el.value); };
  scope.on(view, 'input', (e) => keep(e.target));
  scope.on(view, 'change', (e) => { keep(e.target); render(); });

  const buyer = (mine) => String(dv('buyer|', mine[0]?.slotId || ''));

  delegate(scope, view, 'click', {
    'shop-buy': (el) => {
      const mine = mySlots(run(), ctx.store.getState());
      const slotId = buyer(mine);
      const refKey = el.dataset.ref;
      const qty = Math.max(1, Math.trunc(Number(dv(`buy-qty|${refKey}`, 1))) || 1);
      attempt(() => ctx.send({ t: 'shop.buy', p: { slotId, refKey, qty } }).then((ack) =>
        say(`Bought ${qty} for ${cpText(ack?.costCp)}${ack?.paidFrom === 'stash' ? ' from the party stash' : ''}.`)), fail);
    },
    'shop-sell': (el) => {
      const qty = Math.max(1, Math.trunc(Number(dv(`sell-qty|${el.dataset.item}`, 1))) || 1);
      attempt(() => ctx.send({ t: 'shop.sell', p: { slotId: el.dataset.slot, itemId: el.dataset.item, qty } }).then((ack) =>
        say(`Sold for ${cpText(ack?.gainedCp)}.`)), fail);
    }
  });

  /** Fetch the SRD record of each stock row without a DM price (once). */
  function loadPrices(node) {
    for (const s of node?.payload?.stock || []) {
      if (s.price || asked.has(s.ref) || typeof ctx.api?.srdItem !== 'function') continue;
      asked.add(s.ref);
      ctx.api.srdItem(s.ref).then((res) => { records[s.ref] = res?.item || null; if (!disposed) render(); }).catch(() => { records[s.ref] = null; });
    }
  }

  function render() {
    const r = run();
    const node = currentNode(r);
    if (!r.synced || node?.kind !== 'shop') { replace(doc, body, []); return; }
    loadPrices(node);
    const mine = mySlots(r, ctx.store.getState());
    const who = buyer(mine);
    const c = r.characters.find(x => x.slotId === who) || null;
    const buyback = node.payload?.buyback ?? 0.5;
    const kids = [h(doc, 'h3', { text: node.title || 'Shop' })];
    if (c) {
      kids.push(h(doc, 'div', { class: 'play-row' }, [
        mine.length > 1 ? select(doc, { dataset: { field: 'buyer' }, attrs: { 'aria-label': 'Buyer' } }, mine.map(x => ({ value: x.slotId, label: x.name })), who) : h(doc, 'strong', { text: c.name }),
        h(doc, 'span', { dataset: { field: 'purse' }, text: ` purse ${coinsText(c.state?.currency)} · party stash ${coinsText(r.stash?.currency)}` })
      ]));
    } else {
      kids.push(h(doc, 'p', { class: 'hint-line', text: 'Only the seats\' controllers buy and sell.' }));
    }
    const rows = shopRows(node, r.bought, records);
    const funds = c ? purseCp(c.state?.currency) + purseCp(r.stash?.currency) : 0;
    for (const row of rows) {
      const qty = Math.max(1, Math.trunc(Number(dv(`buy-qty|${row.ref}`, 1))) || 1);
      const line = [h(doc, 'span', { class: 'play-item-name', text: `${row.name} — ${row.unitCp ? cpText(row.unitCp) : 'no price (ask the DM)'} · ${row.left} left` })];
      if (c && row.unitCp && row.left > 0) {
        line.push(h(doc, 'input', { type: 'number', min: 1, max: row.left, value: String(qty), dataset: { field: 'buy-qty', key: row.ref }, attrs: { 'aria-label': 'Quantity' } }));
        line.push(h(doc, 'button', { type: 'button', class: 'play-btn small', dataset: { action: 'shop-buy', ref: row.ref }, text: `Buy for ${cpText(row.unitCp * qty)}` }));
        if (row.unitCp * qty > funds) line.push(h(doc, 'span', { class: 'play-preview error', text: ' more than the purse and the stash hold' }));
      }
      kids.push(h(doc, 'div', { class: 'play-row', dataset: { shopRef: row.ref } }, line));
    }
    if (c) {
      const sellable = itemsOf(r, c.slotId).filter(i => sellPriceCp(i, buyback) !== null);
      kids.push(h(doc, 'h4', { text: `Sell (at ${Math.round(buyback * 100)}%)` }));
      if (!sellable.length) kids.push(h(doc, 'p', { class: 'hint-line', text: 'Nothing this shop will buy.' }));
      for (const it of sellable) {
        const line = [h(doc, 'span', { class: 'play-item-name', text: `${it.name}${it.qty > 1 ? ` ×${it.qty}` : ''} — ${cpText(sellPriceCp(it, buyback))} each` })];
        if (it.equipped || it.attuned) line.push(h(doc, 'span', { class: 'hint-line', text: ' unequip it first' }));
        else {
          if (it.qty > 1) line.push(h(doc, 'input', { type: 'number', min: 1, max: it.qty, value: String(dv(`sell-qty|${it.id}`, 1)), dataset: { field: 'sell-qty', key: it.id }, attrs: { 'aria-label': 'Quantity' } }));
          line.push(h(doc, 'button', { type: 'button', class: 'play-btn small', dataset: { action: 'shop-sell', slot: c.slotId, item: it.id }, text: 'Sell' }));
        }
        kids.push(h(doc, 'div', { class: 'play-row', dataset: { sellItem: it.id } }, line));
      }
    }
    replace(doc, body, kids);
  }

  scope.add(ctx.runStore.subscribe((s) => s, render));
  scope.add(ctx.store.subscribe((a) => a.me, render));
  render();
  return function unmount() {
    disposed = true;
    scope.dispose();
    if (view.parentNode) view.parentNode.removeChild(view);
  };
}
