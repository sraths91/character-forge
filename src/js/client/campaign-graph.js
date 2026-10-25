/**
 * M65 C21 / C23 — campaign chain-graph layout (pure; no DOM).
 *
 * Lays a node v1 list (shared/campaign.js) out in columns by BFS depth
 * from the start node, so a branching chain reads left to right. Nodes
 * the start cannot reach go in a trailing "unlinked" column. Every edge
 * gets a label: its own `label`, else its `when` condition ("victory",
 * "defeat", or the story choice's label).
 *
 * Used by the campaign editor (every node) and the run map (the DM sees
 * every node; a player's graph is built from visited nodes only, with
 * offered edges pointing at an anonymous "?" node — `playerRunGraph`).
 */

import { startNodeId } from '../shared/campaign.js';

/** Layout metrics (SVG user units). */
export const GRAPH_METRICS = Object.freeze({ nodeW: 148, nodeH: 46, colGap: 64, rowGap: 22, pad: 16 });

/** Short glyph per node kind (text only; CSP-safe). */
export const KIND_GLYPHS = Object.freeze({ encounter: '⚔', rest: '☾', loot: '◆', shop: '¤', story: '✎', unknown: '?' });

const OUTCOME_LABELS = Object.freeze({
  'party-victory': 'victory', 'hostile-victory': 'defeat', draw: 'draw', 'dm-ended': 'DM ended'
});

/**
 * A readable label for an edge.
 * @param {{label?: string, when?: {outcome?: string, choice?: string}}} edge
 * @param {object|null} [from] — the source node (for story choice labels)
 * @returns {string}
 */
export function edgeLabel(edge, from = null) {
  if (typeof edge?.label === 'string' && edge.label.trim()) return edge.label.trim();
  const w = edge?.when;
  if (w?.outcome) return OUTCOME_LABELS[w.outcome] || w.outcome;
  if (w?.choice) {
    const ch = (from?.payload?.choices || []).find(c => c?.id === w.choice);
    return ch?.label || w.choice;
  }
  return '';
}

/**
 * Lay out a node list.
 * @param {object[]} nodes — node v1 ({id, kind, title, ord?, start?, next})
 * @returns {{start: string|null, width: number, height: number,
 *   nodes: {id: string, kind: string, title: string, x: number, y: number, col: number, start: boolean, unlinked: boolean}[],
 *   edges: {from: string, to: string, label: string, back: boolean, dangling: boolean, x1: number, y1: number, x2: number, y2: number}[]}}
 */
export function layoutGraph(nodes) {
  const M = GRAPH_METRICS;
  const list = (Array.isArray(nodes) ? nodes : []).filter(n => n && typeof n.id === 'string');
  const byId = new Map(list.map(n => [n.id, n]));
  const start = startNodeId(list) ?? (list[0]?.id ?? null);
  const depth = new Map();
  if (start) {
    depth.set(start, 0);
    const queue = [start];
    while (queue.length) {
      const id = queue.shift();
      for (const e of byId.get(id)?.next || []) {
        if (e && byId.has(e.to) && !depth.has(e.to)) { depth.set(e.to, depth.get(id) + 1); queue.push(e.to); }
      }
    }
  }
  const maxDepth = depth.size ? Math.max(...depth.values()) : -1;
  const cols = new Map();
  for (const n of list) {
    const col = depth.has(n.id) ? depth.get(n.id) : maxDepth + 1;
    if (!cols.has(col)) cols.set(col, []);
    cols.get(col).push(n);
  }
  const placed = new Map();
  let rowsMax = 0;
  for (const [col, members] of cols) {
    members.sort((a, b) => (a.ord ?? 0) - (b.ord ?? 0) || String(a.id).localeCompare(String(b.id)));
    rowsMax = Math.max(rowsMax, members.length);
    members.forEach((n, i) => {
      placed.set(n.id, {
        id: n.id, kind: n.kind || 'unknown', title: typeof n.title === 'string' ? n.title : '',
        x: M.pad + col * (M.nodeW + M.colGap), y: M.pad + i * (M.nodeH + M.rowGap),
        col, start: n.id === start, unlinked: !depth.has(n.id)
      });
    });
  }
  const edges = [];
  for (const n of list) {
    const a = placed.get(n.id);
    (Array.isArray(n.next) ? n.next : []).forEach((e) => {
      if (!e || typeof e.to !== 'string') return;
      const b = placed.get(e.to);
      const label = edgeLabel(e, n);
      if (!b) {
        edges.push({ from: n.id, to: e.to, label, back: false, dangling: true, x1: a.x + M.nodeW, y1: a.y + M.nodeH / 2, x2: a.x + M.nodeW + M.colGap / 2, y2: a.y + M.nodeH / 2 });
        return;
      }
      const back = b.col <= a.col;
      edges.push({
        from: n.id, to: e.to, label, back, dangling: false,
        x1: back ? a.x + M.nodeW / 2 : a.x + M.nodeW, y1: back ? a.y + M.nodeH : a.y + M.nodeH / 2,
        x2: back ? b.x + M.nodeW / 2 : b.x, y2: back ? b.y + M.nodeH : b.y + M.nodeH / 2
      });
    });
  }
  const colsN = cols.size ? Math.max(...cols.keys()) + 1 : 0;
  return {
    start,
    width: Math.max(M.nodeW, M.pad * 2 + colsN * M.nodeW + Math.max(0, colsN - 1) * M.colGap + M.colGap / 2),
    height: Math.max(M.nodeH, M.pad * 2 + rowsMax * M.nodeH + Math.max(0, rowsMax - 1) * M.rowGap + M.nodeH / 2),
    nodes: [...placed.values()],
    edges
  };
}

/**
 * The node list a PLAYER's run map may draw: visited nodes only (titles
 * kept), the edges between them, and each offered edge pointing at an
 * anonymous placeholder (`?`, no title) unless its target was visited.
 * @param {object[]} nodes — run snapshot nodes (may include unvisited ones)
 * @param {string[]} visitedIds — in visit order
 * @param {object[]} offered — edges on offer from the current node
 * @param {string|null} currentId
 * @returns {object[]} node v1-shaped list for layoutGraph (placeholders have kind 'unknown', title '')
 */
export function playerRunGraph(nodes, visitedIds, offered, currentId) {
  const known = new Map((Array.isArray(nodes) ? nodes : []).map(n => [n.id, n]));
  const visited = (Array.isArray(visitedIds) ? visitedIds : []).filter(id => typeof id === 'string');
  const seen = new Set(visited);
  const out = visited.map((id, i) => {
    const n = known.get(id);
    return { id, kind: n?.kind || 'unknown', title: n?.title || '', ord: i, ...(i === 0 ? { start: true } : {}), next: [] };
  });
  const at = new Map(out.map(n => [n.id, n]));
  // The path actually walked: each visited node points at the next one.
  for (let i = 1; i < out.length; i++) out[i - 1].next.push({ to: out[i].id });
  const cur = currentId && at.get(currentId);
  (Array.isArray(offered) ? offered : []).forEach((e, i) => {
    if (!cur || !e || typeof e.to !== 'string') return;
    const label = edgeLabel(e, known.get(currentId) || null) || `Path ${i + 1}`;
    if (seen.has(e.to)) { cur.next.push({ to: e.to, label }); return; }
    const ph = `?${i + 1}`;
    out.push({ id: ph, kind: 'unknown', title: '', ord: out.length, next: [], placeholder: true, target: e.to });
    cur.next.push({ to: ph, label });
  });
  return out;
}
