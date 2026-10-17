/**
 * M64 shared contract addition (2026-10-15, E1) — the EncounterState hash.
 *
 * `stateHash(state)` is THE hash of an encounter's dynamic state: the
 * turn manager stamps it into `turn.ended.payload.stateHash`, the server
 * into `room.snapshot`, and clients compare it to detect drift. It covers
 * round, turnIndex, phase, the initiative order, and per entity: hp,
 * hpTemp, pos, condition ids, concentration, the resource ledger (spent
 * counts, reaction, legendary budget, innate state) and turnFlags, plus
 * (v1 additive, M64 R9) `status` / `deathSaves` when the entity has them.
 * It NEVER covers `sheetRef` / `statBlock` contents, `rng`,
 * `lastEventSeq`, names, controllers or anything else static, so an
 * additive parser field or a view projection cannot flip it.
 *
 * Sync, pure, dependency-free: runs unchanged in the browser, Node and a
 * worker. The digest is cyrb53 (53-bit) over a canonical (sorted-key)
 * JSON of the projection, as 14 lowercase hex chars.
 */

/**
 * Deterministic JSON with sorted object keys; `undefined` members dropped.
 * @param {unknown} v
 * @returns {string}
 */
export function canonicalJson(v) {
  if (Array.isArray(v)) return `[${v.map(x => (x === undefined ? 'null' : canonicalJson(x))).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().filter(k => v[k] !== undefined)
      .map(k => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v ?? null);
}

/**
 * cyrb53 — fast, well-distributed 53-bit string hash, as 14 hex chars.
 * @param {string} str
 * @param {number} [seed=0]
 * @returns {string}
 */
export function hash53(str, seed = 0) {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const n = 4294967296 * (2097151 & h2) + (h1 >>> 0);
  return n.toString(16).padStart(14, '0');
}

const conditionId = (c) => (typeof c === 'string' ? c : c?.id ?? null);

function spentOf(ledger) {
  const out = {};
  for (const [k, l] of Object.entries(ledger || {})) out[k] = l?.spent ?? 0;
  return out;
}

/**
 * The exact projection `stateHash` digests (exported for debugging a
 * mismatch: diff two projections).
 * @param {object} state — EncounterState v1 (full or per-seat view)
 * @returns {object}
 */
export function stateHashInput(state) {
  const entities = {};
  for (const [id, e] of Object.entries(state?.entities || {})) {
    const r = e?.resources || {};
    entities[id] = {
      hp: e?.hp ?? null,
      hpTemp: e?.hpTemp ?? 0,
      pos: e?.pos ? { col: e.pos.col, row: e.pos.row } : null,
      conditions: (e?.conditions || []).map(conditionId),
      concentration: e?.concentration
        ? { spellId: e.concentration.spellId, targetIds: [...(e.concentration.targetIds || [])] }
        : null,
      resources: {
        reactionUsed: !!r.reactionUsed,
        slots: spentOf(r.slots),
        pact: r.pact && Number.isInteger(r.pact.spent) ? r.pact.spent : null,
        features: spentOf(r.features),
        legendaryBudget: r.legendaryBudget ?? 0,
        innate: r.innate ?? null
      },
      turnFlags: e?.turnFlags || {}
    };
    // v1 additive (M64 R9): covered only when present, so states without
    // a dying creature hash exactly as before.
    if (e?.status !== undefined) entities[id].status = e.status;
    if (e?.deathSaves !== undefined) entities[id].deathSaves = { ...e.deathSaves };
  }
  return {
    round: state?.round ?? 0,
    turnIndex: state?.turnIndex ?? 0,
    phase: state?.phase ?? null,
    initiative: (state?.initiative || []).map(row => row?.entityId ?? null),
    entities
  };
}

/**
 * Hash of an EncounterState's dynamic state.
 * @param {object} state — EncounterState v1
 * @returns {string} 14 lowercase hex chars
 */
export function stateHash(state) {
  return hash53(canonicalJson(stateHashInput(state)));
}
