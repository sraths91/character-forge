// Run views (M65 B24 / B27): what each seat of a run room is told about
// the run. Sequencing and projection only — no 5e rules.
//
//   reduceProgress(p, ev)    the node walk folded from the run log (current
//                            node, visited nodes, the node's result, shop
//                            purchases this visit, deaths per node entry)
//   viewForRun(ctx, viewer)  the `run.snapshot` payload for one member: the
//                            DM sees the whole frozen graph; players see the
//                            nodes they visited and the edges on offer now
//                            (never an unvisited node's title or payload,
//                            never an encounter's monsters)

import { nextNodes } from '../../src/js/shared/campaign.js';

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

/** The empty node walk (before run.started). */
export function emptyProgress() {
  return { currentNodeId: null, visited: [], result: {}, completed: false, entries: 0, bought: {}, deathsAt: {}, ended: false };
}

/**
 * Fold one run event into the node walk. `snapshot.restored` replaces
 * the walk with the one recorded in its `after.progress`.
 * @param {ReturnType<typeof emptyProgress>} p
 * @param {{type: string, payload: object}} ev
 * @returns {ReturnType<typeof emptyProgress>} a new object
 */
export function reduceProgress(p, ev) {
  const n = clone(p || emptyProgress());
  const x = ev.payload || {};
  switch (ev.type) {
    case 'node.entered':
      n.currentNodeId = x.nodeId;
      if (!n.visited.includes(x.nodeId)) n.visited.push(x.nodeId);
      n.result = {};
      n.completed = false;
      n.entries += 1;
      n.bought = {};
      break;
    case 'node.completed': n.completed = true; break;
    case 'encounter.result': n.result = { outcome: x.outcome }; break;
    case 'story.chosen': n.result = { ...n.result, choice: x.choiceId }; break;
    case 'shop.bought': n.bought[x.refKey] = (n.bought[x.refKey] || 0) + x.qty; break;
    case 'character.died': n.deathsAt[x.slotId] = n.entries; break;
    case 'character.revived':
    case 'character.retired': delete n.deathsAt[x.slotId]; break;
    case 'snapshot.restored': return clone(x.after?.progress || n);
    case 'run.ended': n.ended = true; break;
    default: break;
  }
  return n;
}

/**
 * The node a player may see: id, kind, title, and only what its screen
 * needs (rest type, loot assignment, shop stock, story text and choices).
 * An encounter node's setup (monsters, placements) stays with the DM.
 */
function playerNode(node) {
  const p = node.payload || {};
  const out = { id: node.id, kind: node.kind, title: node.title };
  if (node.kind === 'rest') out.payload = { type: p.type };
  else if (node.kind === 'loot') out.payload = { assign: p.assign };
  else if (node.kind === 'shop') out.payload = { stock: clone(p.stock || []), ...(p.buyback !== undefined ? { buyback: p.buyback } : {}) };
  else if (node.kind === 'story') out.payload = { text: p.text, ...(p.choices ? { choices: clone(p.choices) } : {}) };
  return out;
}

/** Keys that hold rules / character prose (stripped from every run view and run event on the wire). */
const PROSE_KEYS = new Set(['description', 'snippet', 'desc', 'text', 'notes', 'backstory', 'traits']);

/**
 * A deep copy without prose keys — for anything a non-owner may receive.
 * (Story `text` is DM-authored and travels in `nodes[].payload` only,
 * never through this filter.)
 * @param {unknown} v
 * @returns {unknown}
 */
export function stripProse(v) {
  if (Array.isArray(v)) return v.map(stripProse);
  if (!v || typeof v !== 'object') return v;
  const out = {};
  for (const [k, x] of Object.entries(v)) if (!PROSE_KEYS.has(k)) out[k] = stripProse(x);
  return out;
}

/** Sheet keys that are character prose, removed whole by publicSheet. */
const SHEET_PROSE_FIELDS = ['traits', 'backstory', 'notes', 'personalityTraits', 'ideals', 'bonds', 'flaws'];
/** Keys holding rules prose at any depth of a sheet. */
const SHEET_PROSE_KEYS = new Set(['description', 'snippet', 'desc']);

function stripSheetKeys(v) {
  if (Array.isArray(v)) return v.map(stripSheetKeys);
  if (!v || typeof v !== 'object') return v;
  const out = {};
  for (const [k, x] of Object.entries(v)) if (!SHEET_PROSE_KEYS.has(k)) out[k] = stripSheetKeys(x);
  return out;
}

/**
 * A run sheet for anyone but its seat's controller and the DM (M65
 * decision 9, licensing): names, numbers and the appearance the sprites
 * need stay; every rules description (classFeatures[].description,
 * spell and feat prose, progression.*.features[].description, level
 * scale notes) and the character's own prose (traits, backstory) go.
 * @param {object|null} sheet
 * @returns {object|null} a new object
 */
export function publicSheet(sheet) {
  if (!sheet || typeof sheet !== 'object') return sheet ?? null;
  const out = stripSheetKeys(sheet);
  for (const k of SHEET_PROSE_FIELDS) delete out[k];
  return out;
}

/**
 * The `run.snapshot` payload for one member.
 * @param {object} ctx
 * @param {object} ctx.run          run row (store.getRun)
 * @param {object} ctx.progress     reduceProgress output
 * @param {object[]} ctx.characters store.listCharacters rows
 * @param {object[]} ctx.items      store.listItems rows
 * @param {object[]} ctx.levelUps   level-ups with client ids
 * @param {object[]} ctx.seats      room seats (controller per slot)
 * @param {object} [ctx.pendingRest]  {slotId: {Class: n}}
 * @param {object[]} [ctx.reclaims]   pending seat.reclaim requests (DM only)
 * @param {{role: 'dm'|'player', id: string}} viewer
 * @returns {object}
 */
export function viewForRun(ctx, viewer) {
  const { run, progress } = ctx;
  const dm = viewer.role === 'dm';
  const nodes = run.campaign?.nodes || [];
  const byId = new Map(nodes.map(n => [n.id, n]));
  const current = progress.currentNodeId ? byId.get(progress.currentNodeId) : null;
  const offered = current && run.status !== 'ended' ? nextNodes(current, progress.result) : [];
  const seatOf = new Map((ctx.seats || []).map(s => [s.id, s]));
  return {
    run: {
      id: run.id, campaignId: run.campaignId ?? null, status: run.status, outcome: run.outcome ?? null, currentNodeId: progress.currentNodeId,
      seq: run.seq, settings: clone(run.settings), stash: clone(run.stash),
      completed: progress.completed, result: clone(progress.result), visitedNodeIds: [...progress.visited],
      ...(current?.kind === 'shop' ? { bought: clone(progress.bought) } : {})
    },
    nodes: dm
      ? nodes.map(n => clone(n))
      : progress.visited.map(id => byId.get(id)).filter(Boolean).map(playerNode),
    edges: offered.map(e => (dm ? clone(e) : { to: e.to, ...(e.label ? { label: e.label } : {}) })),
    characters: ctx.characters.map(c => ({
      slotId: c.slotId, seat: c.seat, level: c.level ?? 1, xp: c.xp, lifeStatus: c.lifeStatus, version: c.version,
      name: String(c.sheet?.name || ''), characterId: c.sheet?.id !== undefined ? String(c.sheet.id) : null,
      controller: seatOf.get(c.slotId)?.controllerParticipantId ? 'player' : 'ai',
      memberId: seatOf.get(c.slotId)?.controllerParticipantId ?? null,
      state: clone(c.state)
    })),
    items: ctx.items.map(i => stripProse({
      id: i.id, ownerSlotId: i.ownerSlotId, origin: i.origin, refKey: i.refKey, name: i.name, qty: i.qty,
      equipped: i.equipped, attuned: i.attuned, chargesSpent: i.chargesSpent, data: i.data
    })),
    levelUps: ctx.levelUps.map(l => ({
      id: l.id, slotId: l.slotId, fromLevel: l.fromLevel, toLevel: l.toLevel, mode: l.mode, status: l.status
    })),
    pendingRest: clone(ctx.pendingRest || {}),
    ...(dm ? { reclaims: clone(ctx.reclaims || []) } : {})
  };
}
