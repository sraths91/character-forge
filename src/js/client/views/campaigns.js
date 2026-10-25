/**
 * M65 C21 — the DM's campaign list.
 *
 * Lists the campaigns whose keys this browser holds (client/campaign-keys.js,
 * localStorage per campaign id). From here the DM creates a campaign (the
 * key comes back once and is stored at once), imports an exported
 * campaign file, adds one by id + key (another device), opens one in the
 * editor, or forgets one on this device. Forgetting never deletes the
 * campaign; the server only knows a campaign through its key.
 *
 * mount(root, ctx) → unmount. ctx: {api, campaignKeys, actions:
 * {openCampaign(campaignId), closeCampaigns?()}, deps?: {readFile(file)}}
 */

import { h, replace, createScope, delegate, attempt } from './dom.js';

/**
 * @param {HTMLElement} root
 * @param {object} ctx
 * @returns {() => void} unmount
 */
export function mount(root, ctx) {
  const doc = root.ownerDocument;
  const scope = createScope();
  const keys = ctx.campaignKeys;
  const view = h(doc, 'section', { class: 'play-view play-campaigns' });
  const status = h(doc, 'p', { class: 'play-status', attrs: { role: 'status', 'aria-live': 'polite' } });
  const say = (msg, kind = 'info') => { status.textContent = msg || ''; status.dataset.kind = kind; };
  const fail = (e) => say(e?.message || String(e), 'error');

  const nameIn = h(doc, 'input', { type: 'text', name: 'campaignName', placeholder: 'Campaign name', dataset: { action: 'new-field' }, attrs: { maxlength: 80, 'aria-label': 'Campaign name' } });
  const idIn = h(doc, 'input', { type: 'text', name: 'campaignId', placeholder: 'Campaign id', attrs: { autocomplete: 'off', 'aria-label': 'Campaign id' } });
  const keyIn = h(doc, 'input', { type: 'password', name: 'campaignKey', placeholder: 'Campaign key', attrs: { autocomplete: 'off', 'aria-label': 'Campaign key' } });
  const list = h(doc, 'ul', { class: 'play-campaign-list' });
  view.appendChild(h(doc, 'div', { class: 'play-row' }, [
    h(doc, 'h2', { text: 'Campaigns' }),
    ctx.actions?.closeCampaigns ? h(doc, 'button', { type: 'button', class: 'play-btn small', dataset: { action: 'close' }, text: 'Back to the table' }) : null
  ]));
  view.appendChild(status);
  view.appendChild(h(doc, 'div', { class: 'play-card' }, [h(doc, 'h3', { text: 'On this device' }), list]));
  view.appendChild(h(doc, 'div', { class: 'play-card' }, [
    h(doc, 'h3', { text: 'New campaign' }),
    h(doc, 'p', { class: 'hint-line', text: 'The campaign key is shown once and kept in this browser. Export it or note it to edit from another device.' }),
    h(doc, 'div', { class: 'play-row' }, [nameIn, h(doc, 'button', { type: 'button', class: 'play-btn primary', dataset: { action: 'create' }, text: 'Create' })])
  ]));
  view.appendChild(h(doc, 'div', { class: 'play-card' }, [
    h(doc, 'h3', { text: 'Import or add' }),
    h(doc, 'label', {}, ['Import a campaign file ', h(doc, 'input', { type: 'file', accept: 'application/json,.json', dataset: { action: 'import-file' }, attrs: { 'aria-label': 'Campaign file' } })]),
    h(doc, 'div', { class: 'play-row' }, [idIn, keyIn, h(doc, 'button', { type: 'button', class: 'play-btn', dataset: { action: 'add-key' }, text: 'Add with key' })])
  ]));
  root.appendChild(view);

  function render() {
    const rows = keys.list();
    replace(doc, list, rows.length ? rows.map(r => h(doc, 'li', { class: 'play-campaign', dataset: { campaignId: r.campaignId } }, [
      h(doc, 'strong', { text: r.name }),
      h(doc, 'span', { class: 'dim', text: ` ${r.campaignId}` }),
      h(doc, 'button', { type: 'button', class: 'play-btn small primary', dataset: { action: 'open', id: r.campaignId }, text: 'Open' }),
      h(doc, 'button', { type: 'button', class: 'play-btn small', dataset: { action: 'forget', id: r.campaignId }, attrs: { 'aria-label': `Forget ${r.name} on this device` }, text: 'Forget' })
    ])) : [h(doc, 'li', { class: 'hint-line', text: 'No campaigns on this device yet.' })]);
  }

  function create() {
    const name = nameIn.value.trim();
    if (!name) { say('Name the campaign first.', 'error'); return; }
    say('Creating…');
    attempt(async () => {
      const r = await ctx.api.createCampaign(name);
      keys.put(r.campaignId, r.campaignKey, name);
      nameIn.value = '';
      render();
      say(`Created "${name}". Its key is saved in this browser.`);
      ctx.actions?.openCampaign?.(r.campaignId);
    }, fail);
  }

  async function importFile(file) {
    say('Importing…');
    try {
      const raw = ctx.deps?.readFile ? await ctx.deps.readFile(file) : await file.text();
      const text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
      const doc0 = JSON.parse(text);
      const r = await ctx.api.importCampaign(doc0);
      const name = typeof doc0?.campaign?.name === 'string' ? doc0.campaign.name : (typeof doc0?.name === 'string' ? doc0.name : r.campaignId);
      keys.put(r.campaignId, r.campaignKey, name);
      render();
      say(`Imported "${name}" (${r.counts?.nodes ?? 0} nodes).`);
    } catch (err) {
      fail(err instanceof SyntaxError ? new Error('That file is not campaign JSON.') : err);
    }
  }

  delegate(scope, view, 'click', {
    create: () => create(),
    open: (el) => ctx.actions?.openCampaign?.(el.dataset.id),
    forget: (el) => {
      keys.forget(el.dataset.id);
      render();
      say('Forgotten on this device. The campaign still exists for anyone with its key.');
    },
    'add-key': () => {
      const id = idIn.value.trim();
      const key = keyIn.value.trim();
      if (!id || !key) { say('Paste the campaign id and its key.', 'error'); return; }
      say('Checking the key…');
      attempt(async () => {
        const r = await ctx.api.getCampaign(id, key);
        keys.put(id, key, r?.campaign?.name || id);
        idIn.value = ''; keyIn.value = '';
        render();
        say(`Added "${r?.campaign?.name || id}".`);
      }, (e) => fail(e?.status === 401 ? new Error('That key does not open that campaign.') : e));
    },
    close: () => ctx.actions?.closeCampaigns?.()
  });
  delegate(scope, view, 'keydown', { 'new-field': (_el, e) => { if (e.key === 'Enter') create(); } });
  delegate(scope, view, 'change', { 'import-file': (el) => { const f = el.files?.[0]; if (f) importFile(f); } });

  render();
  return function unmount() {
    scope.dispose();
    if (view.parentNode) view.parentNode.removeChild(view);
  };
}
