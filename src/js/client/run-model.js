/**
 * M65 C24–C27 — shared helpers for the between-node screens: who acts for
 * which run seat, the current node, coin text, readable refusals for the
 * run intents' error codes, and the run-sheet loader.
 *
 * Seats: a player acts for the run seat whose `memberId` is theirs; the
 * DM acts for every seat no player controls (AI / DM-driven seats), the
 * same rule as the controller's `#ownSeat`.
 *
 * Sheets: `run.snapshot` carries each character's state, never its sheet.
 * The between screens read the RUN sheet from
 * `GET /api/rooms/:id/seats/:slotId/sheet` (B27: full for the seat's
 * controller and the DM, prose-stripped otherwise), cached by the
 * character row's `version`, which every write bumps — so an equip or a
 * level-up refetches exactly once.
 *
 * Pure except `createRunSheets` (it calls the api it is given).
 */

import { myMemberId, isDm } from './selectors.js';

const COIN_ORDER = ['pp', 'gp', 'ep', 'sp', 'cp'];
const COIN_CP = { cp: 1, sp: 10, ep: 50, gp: 100, pp: 1000 };

/**
 * Run characters this viewer acts for (DM: seats no player controls).
 * @param {import('./run-store.js').RunState} run
 * @param {object} roomState — client store state
 * @returns {object[]}
 */
export function mySlots(run, roomState) {
  const chars = Array.isArray(run?.characters) ? run.characters : [];
  if (isDm(roomState)) return chars.filter(c => !c.memberId);
  const me = myMemberId(roomState);
  return me ? chars.filter(c => c.memberId === me) : [];
}

/**
 * May this viewer send a seat intent for `slotId`?
 * @param {object} run
 * @param {object} roomState
 * @param {string} slotId
 * @returns {boolean}
 */
export function canActFor(run, roomState, slotId) {
  return mySlots(run, roomState).some(c => c.slotId === slotId);
}

/** The current node object (as this viewer's snapshot carries it), or null. */
export function currentNode(run) {
  const id = run?.currentNodeId;
  return id ? (run.nodes || []).find(n => n.id === id) || null : null;
}

/** One run character by slot id. */
export function characterOf(run, slotId) {
  return (run?.characters || []).find(c => c.slotId === slotId) || null;
}

/** A character's display name ("Seat n" when the snapshot has none). */
export function nameOfSlot(run, slotId) {
  const c = characterOf(run, slotId);
  return c ? (c.name || `Seat ${c.seat}`) : (slotId ? String(slotId) : 'the party stash');
}

/**
 * Items owned by a seat (`slotId`) or in the party stash (`null`).
 * @param {object} run
 * @param {string|null} owner
 * @returns {object[]}
 */
export function itemsOf(run, owner) {
  return (run?.items || []).filter(i => (i.ownerSlotId ?? null) === (owner ?? null));
}

/** Total copper in a purse. */
export function purseCp(purse) {
  return COIN_ORDER.reduce((s, k) => s + Math.max(0, Math.trunc(Number(purse?.[k]) || 0)) * COIN_CP[k], 0);
}

/**
 * "12 gp 5 sp" for a purse (zero coins skipped; "0 gp" when empty).
 * @param {object} purse
 * @returns {string}
 */
export function coinsText(purse) {
  const parts = COIN_ORDER.filter(k => (Number(purse?.[k]) || 0) > 0).map(k => `${Math.trunc(purse[k])} ${k}`);
  return parts.length ? parts.join(' ') : '0 gp';
}

/**
 * A copper amount as gold text ("1.5 gp", "50 gp", "7 cp").
 * @param {number} cp
 * @returns {string}
 */
export function cpText(cp) {
  const n = Math.max(0, Math.trunc(Number(cp) || 0));
  if (n === 0) return '0 gp';
  if (n < 10) return `${n} cp`;
  if (n < 100) return `${n / 10} sp`;
  return `${+(n / 100).toFixed(2)} gp`;
}

/** Readable text per refusal code (protocol ERROR_CODES and campaign rule codes). */
const REFUSALS = Object.freeze({
  E_FORBIDDEN: 'That is not yours to do.',
  E_ENCOUNTER_LIVE: 'Wait until the encounter ends.',
  E_NO_RUN: 'This room has no open campaign run.',
  E_NODE_NOT_BEGUN: 'Begin the encounter node first.',
  E_STALE: 'That changed in the meantime — look again and retry.',
  E_SEAT_TAKEN: 'That player already holds a seat.',
  E_RATE_LIMITED: 'Too fast — wait a moment.',
  'needs-hp': 'A long rest needs at least 1 HP.',
  dead: 'A dead character cannot do that.',
  'no-hit-dice-on-long-rest': 'Hit dice are spent on a short rest.',
  'attunement-full': 'Already attuned to three items.',
  'rings-full': 'Already wearing two rings.',
  'not-equippable': 'That item cannot be equipped.',
  'no-attunement': 'That item does not need attunement.',
  'no-quantity': 'None left.',
  'asi-not-offered': 'No ability score improvement at this level.',
  'asi-required': 'Pick the ability score improvement (+2, or +1/+1).',
  'asi-points': 'An ability score improvement spends exactly its points.',
  'asi-cap': 'That would raise a score past 20.',
  'spells-not-offered': 'No new spells at this level.',
  'spells-over-max': 'That is more spells than this level grants.',
  'spell-duplicate': 'That spell is already on the sheet.',
  'spell-too-high': 'That spell is above your highest slot.',
  'unknown-spell': 'That is not a known SRD spell.',
  'class-required': 'Pick which class gains the level.',
  'nothing-to-reconcile': 'D&D Beyond has no structural change to bring in.',
  'no-spell': 'The caster does not know that spell.',
  'no-caster': 'Pick the caster.',
  'no-slot': 'The caster has no slot left for it.',
  'not-downtime-spell': 'Only Cure Wounds, Healing Word and Prayer of Healing are cast between nodes.',
  'caster-down': 'The caster must be up to cast.',
  'slot-too-low': 'That slot is too low for the spell.',
  'too-many-targets': 'That spell cannot heal that many.',
  'no-targets': 'Choose who to heal.',
  'target-dead': 'A dead character cannot be healed.',
  'no-diamond': 'The party has no diamond worth enough.'
});

/**
 * A run-intent refusal (ws `error` frame → rejected send) as one readable
 * sentence: the code's text, specialised by `details` where the server
 * sends them; the server's own message otherwise.
 * @param {{code?: string, message?: string, frame?: {details?: object}, details?: object}|Error|string} err
 * @returns {string}
 */
export function refusalText(err) {
  if (!err) return '';
  if (typeof err === 'string') return err;
  const code = err.code || '';
  const d = err.frame?.details || err.details || {};
  if (code === 'insufficient-funds') {
    const cost = Number.isFinite(d.costCp) ? cpText(d.costCp) : null;
    const have = Number.isFinite(d.haveCp) ? cpText(d.haveCp) : null;
    return cost && have
      ? `Not enough coin: it costs ${cost} and you have ${have} (the party stash cannot cover it either).`
      : 'Not enough coin in the purse or the party stash.';
  }
  if (code === 'hit-dice-overspent') {
    return Number.isFinite(d.available)
      ? `Only ${d.available} ${d.className || ''} hit ${d.available === 1 ? 'die' : 'dice'} left (asked for ${d.asked}).`.replace('  ', ' ')
      : 'Not that many hit dice left.';
  }
  if (code === 'ddb-level-ahead') {
    return `D&D Beyond is at level ${d.ddbLevel ?? '?'}, ahead of the level the game has granted (${d.grantedLevel ?? '?'}). Level up in the game first.`;
  }
  if (code === 'nothing-to-reconcile' && Number(d.kept) > 0) {
    return `${REFUSALS[code].replace(/\.$/, '')} (${d.kept} game-granted ${Number(d.kept) === 1 ? 'entry' : 'entries'} kept).`;
  }
  if (code === 'E_INVALID_INTENT' && err.message) return err.message;
  return REFUSALS[code] || err.message || String(code || 'refused');
}

/**
 * The run-sheet loader (see the module note).
 * @param {{api: {getSeatSheet: (roomId: string, slotId: string) => Promise<{sheet: object}>}, roomId: () => string|null}} o
 * @returns {{get: (slotId: string, version?: number) => object|null, load: (slotId: string, version?: number) => Promise<object|null>,
 *            onLoad: (fn: (slotId: string) => void) => () => void}}
 */
export function createRunSheets({ api, roomId }) {
  const cache = new Map();   // slotId → {version, sheet}
  const loads = new Map();   // `${slotId}@${version}` → Promise
  const listeners = new Set();
  const key = (slotId, version) => `${slotId}@${version ?? 0}`;
  return {
    get(slotId, version) {
      const hit = cache.get(slotId);
      return hit && (version === undefined || hit.version === (version ?? 0)) ? hit.sheet : null;
    },
    load(slotId, version) {
      const hit = cache.get(slotId);
      if (hit && hit.version === (version ?? 0)) return Promise.resolve(hit.sheet);
      const k = key(slotId, version);
      if (!loads.has(k)) {
        const rid = roomId();
        if (!rid || typeof api?.getSeatSheet !== 'function') return Promise.resolve(null);
        loads.set(k, api.getSeatSheet(rid, slotId).then((res) => {
          const sheet = res?.sheet || null;
          if (sheet) {
            const cur = cache.get(slotId);
            if (!cur || cur.version <= (version ?? 0)) cache.set(slotId, { version: version ?? 0, sheet });
            for (const fn of [...listeners]) fn(slotId);
          }
          return sheet;
        }).catch(() => null).finally(() => loads.delete(k)));
      }
      return loads.get(k);
    },
    onLoad(fn) { listeners.add(fn); return () => listeners.delete(fn); }
  };
}
