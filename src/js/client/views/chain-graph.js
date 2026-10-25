/**
 * M65 C21 / C23 — the inline SVG chain graph (campaign editor, run map).
 *
 * Draws a `layoutGraph` result (client/campaign-graph.js): one rounded
 * box per node (kind glyph + title, a start flag on the start node), an
 * arrow per edge with its `when` / label text at the midpoint. CSP-safe:
 * elements are built with createElementNS and attributes, text goes
 * through textContent, no inline style or event-handler attributes.
 * Clicks are delegated by the caller through `data-action` on each node.
 */

import { GRAPH_METRICS, KIND_GLYPHS } from '../campaign-graph.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * Create an SVG element.
 * @param {Document} doc
 * @param {string} tag
 * @param {Record<string, string|number|null|undefined>} [attrs]
 * @param {Array<Node|null>} [children]
 * @returns {Element}
 */
export function svgEl(doc, tag, attrs = {}, children = []) {
  const el = typeof doc.createElementNS === 'function' ? doc.createElementNS(SVG_NS, tag) : doc.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) if (v !== null && v !== undefined && v !== false) el.setAttribute(k, String(v));
  for (const c of children) if (c) el.appendChild(c);
  return el;
}

function text(doc, attrs, value) {
  const t = svgEl(doc, 'text', attrs);
  t.textContent = value;
  return t;
}

/** Truncate a title to fit a node box. */
export function fitTitle(title, max = 18) {
  const s = String(title ?? '');
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/**
 * Render a laid-out graph.
 * @param {Document} doc
 * @param {ReturnType<import('../campaign-graph.js').layoutGraph>} graph
 * @param {{action?: string|null, selectedId?: string|null, currentId?: string|null,
 *          visitedIds?: string[]|null, label?: string, titleFor?: (node: object) => string}} [opts]
 *   — `action`: data-action on node groups (null: not clickable);
 *     `titleFor`: the text shown per node (default: its title)
 * @returns {Element} the <svg>
 */
export function renderChainGraph(doc, graph, opts = {}) {
  const M = GRAPH_METRICS;
  const { action = null, selectedId = null, currentId = null, visitedIds = null, label = 'Campaign graph', titleFor = (n) => n.title } = opts;
  const visited = visitedIds ? new Set(visitedIds) : null;
  const svg = svgEl(doc, 'svg', {
    class: 'cf-graph', viewBox: `0 0 ${Math.ceil(graph.width)} ${Math.ceil(graph.height)}`,
    width: Math.ceil(graph.width), height: Math.ceil(graph.height), role: 'img', 'aria-label': label
  });
  const defs = svgEl(doc, 'defs', {}, [
    svgEl(doc, 'marker', { id: 'cf-graph-arrow', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' }, [
      svgEl(doc, 'path', { d: 'M 0 0 L 10 5 L 0 10 z', class: 'cf-graph-arrowhead' })
    ])
  ]);
  svg.appendChild(defs);

  const edgeLayer = svgEl(doc, 'g', { class: 'cf-graph-edges' });
  for (const e of graph.edges) {
    let d;
    if (e.back) {
      const dip = Math.max(e.y1, e.y2) + M.rowGap;
      d = `M ${e.x1} ${e.y1} C ${e.x1} ${dip}, ${e.x2} ${dip}, ${e.x2} ${e.y2}`;
    } else {
      const mx = (e.x1 + e.x2) / 2;
      d = `M ${e.x1} ${e.y1} C ${mx} ${e.y1}, ${mx} ${e.y2}, ${e.x2} ${e.y2}`;
    }
    const g = svgEl(doc, 'g', { class: `cf-graph-edge${e.dangling ? ' dangling' : ''}${e.back ? ' back' : ''}`, 'data-from': e.from, 'data-to': e.to }, [
      svgEl(doc, 'path', { d, class: 'cf-graph-edge-line', 'marker-end': 'url(#cf-graph-arrow)', fill: 'none' })
    ]);
    if (e.label) {
      const lx = (e.x1 + e.x2) / 2;
      const ly = e.back ? Math.max(e.y1, e.y2) + M.rowGap * 0.75 : (e.y1 + e.y2) / 2 - 4;
      g.appendChild(text(doc, { x: lx, y: ly, class: 'cf-graph-edge-label', 'text-anchor': 'middle' }, fitTitle(e.label, 22)));
    }
    edgeLayer.appendChild(g);
  }
  svg.appendChild(edgeLayer);

  const nodeLayer = svgEl(doc, 'g', { class: 'cf-graph-nodes' });
  for (const n of graph.nodes) {
    const cls = ['cf-graph-node', `kind-${n.kind}`];
    if (n.id === selectedId) cls.push('selected');
    if (n.id === currentId) cls.push('current');
    if (n.unlinked) cls.push('unlinked');
    if (visited && visited.has(n.id)) cls.push('visited');
    const shown = titleFor(n);
    const g = svgEl(doc, 'g', {
      class: cls.join(' '), transform: `translate(${n.x} ${n.y})`,
      'data-node-id': n.id, ...(action ? { 'data-action': action, tabindex: 0, role: 'button' } : {}),
      'aria-label': `${n.kind} node${shown ? `: ${shown}` : ''}${n.start ? ' (start)' : ''}`
    }, [
      svgEl(doc, 'rect', { width: M.nodeW, height: M.nodeH, rx: 8, ry: 8, class: 'cf-graph-box' }),
      text(doc, { x: 10, y: 19, class: 'cf-graph-glyph' }, KIND_GLYPHS[n.kind] || KIND_GLYPHS.unknown),
      text(doc, { x: 28, y: 19, class: 'cf-graph-title' }, fitTitle(shown)),
      text(doc, { x: 28, y: 36, class: 'cf-graph-kind' }, n.kind === 'unknown' ? 'not yet visited' : n.kind)
    ]);
    if (n.start) g.appendChild(text(doc, { x: M.nodeW - 18, y: 19, class: 'cf-graph-start', 'aria-hidden': 'true' }, '⚑'));
    nodeLayer.appendChild(g);
  }
  svg.appendChild(nodeLayer);
  return svg;
}
