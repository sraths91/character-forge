/**
 * M65 C23 — the run map: where the party is in the campaign.
 *
 *   Players  see the nodes the party has visited (in order, titles shown),
 *            the current node, and the edges on offer from it — each
 *            offered edge points at an anonymous "?" node, labelled by the
 *            edge (or its `when` condition), never by its target's title.
 *            Titles outside the visited set are never rendered, even when
 *            a snapshot happens to carry them.
 *   DM       sees the whole graph (run snapshot nodes) with visited and
 *            current marks, the offered edges as "Go" buttons
 *            (`dm.run.advance {toNodeId}`), and "Go to any node" as an
 *            explicit override (`dm.run.advance {toNodeId, override: true}`).
 *
 * `run.started` does not mean the start node was entered (E3): a run in
 * 'lobby' waits for the DM's "Begin the run" (`dm.node.begin`), and an
 * encounter node that is entered but not begun shows the DM "Begin this
 * encounter" (`dm.node.begin`, which builds it and opens the setup screen).
 * Status comes from the run store (node.entered / run.updated), never from
 * run.started.
 *
 * mount(root, ctx) → unmount. ctx: {store (room), runStore, send}
 */

import { h, replace, createScope, delegate, attempt, select } from './dom.js';
import { isDm } from '../selectors.js';
import { layoutGraph, playerRunGraph, edgeLabel, KIND_GLYPHS } from '../campaign-graph.js';
import { renderChainGraph } from './chain-graph.js';

/** Run statuses as players read them. */
export const RUN_STATUS_COPY = Object.freeze({
  lobby: 'Gathering the party', 'in-node': 'In progress', between: 'Between nodes', paused: 'Paused', ended: 'Run over'
});

/**
 * What one viewer's run map shows (pure; views and tests share it).
 * @param {import('../run-store.js').RunState} run
 * @param {{dm: boolean}} viewer
 * @returns {{graph: object, trail: {id: string, kind: string, title: string, current: boolean}[],
 *            offers: {to: string, label: string, title: string|null}[], current: object|null}}
 */
export function runMapModel(run, { dm }) {
  const nodes = Array.isArray(run?.nodes) ? run.nodes : [];
  const byId = new Map(nodes.map(n => [n.id, n]));
  const visited = Array.isArray(run?.visitedIds) ? run.visitedIds : [];
  const visitedSet = new Set(visited);
  const currentId = run?.currentNodeId ?? null;
  const cur = currentId ? byId.get(currentId) || null : null;
  const canName = (id) => dm || visitedSet.has(id);
  const titleOf = (id) => (canName(id) ? (byId.get(id)?.title ?? '') : '');
  const trail = visited.map(id => ({ id, kind: byId.get(id)?.kind || 'unknown', title: titleOf(id), current: id === currentId }));
  const offers = (Array.isArray(run?.edges) ? run.edges : []).filter(e => e && typeof e.to === 'string').map((e, i) => ({
    to: e.to,
    label: edgeLabel(e, cur) || `Path ${i + 1}`,
    title: canName(e.to) ? (byId.get(e.to)?.title ?? null) : null
  }));
  const graphNodes = dm
    ? nodes.map(n => ({ id: n.id, kind: n.kind, title: n.title, ord: n.ord, ...(n.start ? { start: true } : {}), next: Array.isArray(n.next) ? n.next : [] }))
    : playerRunGraph(nodes, visited, run?.edges, currentId);
  return { graph: layoutGraph(graphNodes), trail, offers, current: cur && canName(cur.id) ? { id: cur.id, kind: cur.kind, title: cur.title } : null };
}

/**
 * @param {HTMLElement} root
 * @param {object} ctx
 * @returns {() => void} unmount
 */
export function mount(root, ctx) {
  const doc = root.ownerDocument;
  const scope = createScope();
  const view = h(doc, 'section', { class: 'play-view play-run-map', attrs: { 'aria-label': 'Campaign map' } });
  const head = h(doc, 'div', { class: 'play-row play-run-head' });
  const graphHost = h(doc, 'div', { class: 'play-card cf-graph-host' });
  const trailEl = h(doc, 'ol', { class: 'play-run-trail' });
  const offersEl = h(doc, 'div', { class: 'play-card play-run-offers' });
  const status = h(doc, 'p', { class: 'play-status', attrs: { role: 'status', 'aria-live': 'polite' } });
  const say = (msg, kind = 'info') => { status.textContent = msg || ''; status.dataset.kind = kind; };
  const fail = (e) => say(e?.message || String(e), 'error');
  view.appendChild(h(doc, 'h2', { text: 'Campaign' }));
  view.appendChild(head);
  view.appendChild(status);
  view.appendChild(graphHost);
  view.appendChild(h(doc, 'div', { class: 'play-card' }, [h(doc, 'h3', { text: 'The road so far' }), trailEl]));
  view.appendChild(offersEl);
  root.appendChild(view);

  const dmNow = () => isDm(ctx.store.getState());

  delegate(scope, view, 'click', {
    'run-advance': (el) => {
      if (!dmNow()) return;
      const toNodeId = el.dataset.to;
      attempt(() => ctx.send({ t: 'dm.run.advance', p: { toNodeId } }).then(() => say('Moving on…')), fail);
    },
    'run-begin': () => {
      if (!dmNow()) return;
      attempt(() => ctx.send({ t: 'dm.node.begin', p: {} }).then(() => say('Beginning…')), fail);
    },
    'run-goto': () => {
      if (!dmNow()) return;
      const sel = view.querySelector('[data-field="goto-node"]');
      const toNodeId = sel?.value;
      if (!toNodeId) return;
      attempt(() => ctx.send({ t: 'dm.run.advance', p: { toNodeId, override: true } }).then(() => say('Override: jumping to the chosen node.')), fail);
    }
  });

  function render() {
    const run = ctx.runStore.getState();
    const dm = dmNow();
    if (!run.synced) {
      replace(doc, head, [h(doc, 'span', { class: 'hint-line', text: 'No campaign run in this room yet.' })]);
      replace(doc, graphHost, []);
      replace(doc, trailEl, []);
      replace(doc, offersEl, []);
      return;
    }
    const m = runMapModel(run, { dm });
    replace(doc, head, [
      h(doc, 'span', { class: `play-run-status status-${run.status}`, text: RUN_STATUS_COPY[run.status] || run.status }),
      m.current ? h(doc, 'span', { class: 'play-run-current', text: ` · ${KIND_GLYPHS[m.current.kind] || ''} ${m.current.title}` }) : null,
      run.outcome ? h(doc, 'span', { class: 'play-run-outcome', text: ` · ${run.outcome}` }) : null
    ]);
    replace(doc, graphHost, [renderChainGraph(doc, m.graph, {
      currentId: run.currentNodeId, visitedIds: run.visitedIds, label: dm ? 'Campaign graph (DM view)' : 'The party\'s path'
    })]);
    replace(doc, trailEl, m.trail.length ? m.trail.map(t => h(doc, 'li', { class: `play-run-step${t.current ? ' current' : ''}`, dataset: { nodeId: t.id } }, [
      h(doc, 'span', { class: 'play-run-glyph', text: KIND_GLYPHS[t.kind] || KIND_GLYPHS.unknown }),
      h(doc, 'span', { text: ` ${t.title || t.kind}` })
    ])) : [h(doc, 'li', { class: 'hint-line', text: run.status === 'lobby' ? 'The run has not begun: no node entered yet.' : 'The run has not started.' })]);
    const offerItems = m.offers.map(o => (dm
      ? h(doc, 'button', { type: 'button', class: 'play-btn', dataset: { action: 'run-advance', to: o.to }, text: `${o.label}${o.title ? ` → ${o.title}` : ''}` })
      : h(doc, 'span', { class: 'play-chip', text: o.label })));
    const children = [h(doc, 'h3', { text: dm ? 'Next node' : 'Paths ahead' })];
    const curNode = run.currentNodeId ? run.nodes.find(n => n.id === run.currentNodeId) : null;
    const unfought = run.status === 'in-node' && curNode?.kind === 'encounter' && !run.completed && !run.result?.outcome;
    if (run.status === 'lobby') {
      children.push(dm
        ? h(doc, 'button', { type: 'button', class: 'play-btn primary', dataset: { action: 'run-begin' }, text: 'Begin the run' })
        : h(doc, 'p', { class: 'hint-line', text: 'The DM begins the run once the party is seated.' }));
    } else if (unfought) {
      children.push(dm
        ? h(doc, 'button', { type: 'button', class: 'play-btn primary', dataset: { action: 'run-begin' }, text: 'Begin this encounter' })
        : h(doc, 'p', { class: 'hint-line', text: 'The DM is setting up this encounter.' }));
    }
    if (offerItems.length) children.push(h(doc, 'div', { class: 'play-row' }, offerItems));
    else if (run.status !== 'lobby') children.push(h(doc, 'p', { class: 'hint-line', text: run.status === 'ended' ? 'The run is over.' : 'No path is on offer yet.' }));
    if (dm && run.status !== 'ended' && run.nodes.length) {
      children.push(h(doc, 'div', { class: 'play-row' }, [
        select(doc, { dataset: { field: 'goto-node' }, attrs: { 'aria-label': 'Any node' } }, run.nodes.map(n => ({ value: n.id, label: `${KIND_GLYPHS[n.kind] || ''} ${n.title}` }))),
        h(doc, 'button', { type: 'button', class: 'play-btn small', dataset: { action: 'run-goto' }, text: 'Go to any node (override)' })
      ]));
    }
    replace(doc, offersEl, children);
  }

  scope.add(ctx.runStore.subscribe((s) => s, render));
  scope.add(ctx.store.subscribe((a) => a.me, render));
  render();
  return function unmount() {
    scope.dispose();
    if (view.parentNode) view.parentNode.removeChild(view);
  };
}
