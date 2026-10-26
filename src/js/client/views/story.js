/**
 * M65 C26 — a story node (mounted in the between hub's "here" slot).
 *
 * The node's text (DM-authored; players receive it only for the node they
 * are at) and its choices. Players pick with `story.choose {nodeId,
 * choiceId}`; the DM settles it with `dm.story.resolve` (the last choice
 * stands — it picks the edge the run map then offers). A story without
 * choices just reads; the DM moves on from the run map.
 *
 * mount(root, ctx) → unmount. ctx: {store, runStore, send}
 */

import { h, replace, createScope, delegate, attempt } from './dom.js';
import { isDm } from '../selectors.js';
import { currentNode, refusalText } from '../run-model.js';

/**
 * What a story node shows.
 * @param {object} node
 * @param {object} result — run result ({choice?})
 * @returns {{text: string, choices: {id: string, label: string, chosen: boolean}[], chosen: string|null}}
 */
export function storyModel(node, result = {}) {
  const p = node?.payload || {};
  const chosen = typeof result?.choice === 'string' ? result.choice : null;
  return {
    text: typeof p.text === 'string' ? p.text : '',
    choices: (Array.isArray(p.choices) ? p.choices : []).map(c => ({ id: c.id, label: c.label || c.id, chosen: c.id === chosen })),
    chosen
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
  const view = h(doc, 'section', { class: 'play-card play-story', attrs: { 'aria-label': 'Story' } });
  const status = h(doc, 'p', { class: 'play-status', attrs: { role: 'status', 'aria-live': 'polite' } });
  const body = h(doc, 'div');
  view.appendChild(body);
  view.appendChild(status);
  root.appendChild(view);
  const say = (msg, kind = 'info') => { status.textContent = msg || ''; status.dataset.kind = kind; };
  const fail = (e) => say(refusalText(e), 'error');
  const dm = () => isDm(ctx.store.getState());

  delegate(scope, view, 'click', {
    'story-choose': (el) => {
      const node = currentNode(ctx.runStore.getState());
      if (!node) return;
      const t = dm() ? 'dm.story.resolve' : 'story.choose';
      attempt(() => ctx.send({ t, p: { nodeId: node.id, choiceId: el.dataset.choice } }).then(() => say(dm() ? 'Settled.' : 'Your choice is in.')), fail);
    }
  });

  function render() {
    const r = ctx.runStore.getState();
    const node = currentNode(r);
    if (!r.synced || node?.kind !== 'story') { replace(doc, body, []); return; }
    const m = storyModel(node, r.result);
    const kids = [h(doc, 'h3', { text: node.title || 'Story' })];
    for (const para of m.text.split(/\n{2,}/).filter(Boolean)) kids.push(h(doc, 'p', { class: 'play-story-text', text: para }));
    if (m.choices.length) {
      kids.push(h(doc, 'div', { class: 'play-row' }, m.choices.map(c => h(doc, 'button', {
        type: 'button', class: `play-btn${c.chosen ? ' primary' : ''}`, dataset: { action: 'story-choose', choice: c.id },
        attrs: { 'aria-pressed': c.chosen ? 'true' : 'false' }, text: c.label
      }))));
      kids.push(h(doc, 'p', { class: 'hint-line', dataset: { field: 'story-chosen' }, text: m.chosen
        ? `Chosen: ${m.choices.find(c => c.chosen)?.label || m.chosen}${dm() ? ' — advance from the run map.' : ''}`
        : (dm() ? 'The players choose, or you settle it.' : 'Choose the party\'s path.') }));
    } else {
      kids.push(h(doc, 'p', { class: 'hint-line', text: 'The DM moves the party on.' }));
    }
    replace(doc, body, kids);
  }

  scope.add(ctx.runStore.subscribe((s) => s, render));
  scope.add(ctx.store.subscribe((a) => a.me, render));
  render();
  return function unmount() {
    scope.dispose();
    if (view.parentNode) view.parentNode.removeChild(view);
  };
}
