/**
 * M64 C4 — Versus encounter setup (pure, Node-safe).
 *
 * Extracted from main.js startVersusFight (M38 / M39 / M30 seeding +
 * initiative). Turns a party, the chosen PC ids and an encounter list
 * into an arena scene with rolled initiative. Ids and dice come from
 * the injected `mintId` and `rng`, so a fixed seed + fixed mintId gives
 * a deterministic encounter — what the server needs for replays.
 * No DOM, no Date.now, no Math.random.
 */

import { MONSTER_PRESETS } from './monster-presets.js';
import { buildPartyArenaScene, rollPartyInitiative } from './versus.js';
import { slotsForPc } from './reactions.js';
import { spellbookFor, innateBlockFor, freshInnateState } from './monster-spells.js';

/**
 * Build a versus encounter.
 *
 * Side effects: the selected live PC records get their per-fight
 * reaction and slot resources reset (`_reactionUsed`, and the one slot
 * ledger `_slots` refilled — M64 T5).
 *
 * @param {object} args
 * @param {object[]} args.party     every composed PC (filtered by pcIds)
 * @param {Array<string|number>} args.pcIds  selected PC ids
 * @param {Array<{slug: string, name: string}>} args.encounter  opponents
 * @param {boolean} [args.flanking] scene flanking rule
 * @param {() => number} args.rng   required; rolls initiative
 * @param {(index: number, entry: object) => string} args.mintId
 *   required; mints each monster instance id
 * @returns {{scene: object, party: object[], monsters: object[],
 *            initiative: Array<{entityId, entityKind, name, score}>}}
 *   `scene` is the arena (with `scene.initiative` set, first entry
 *   active; its monsters carry the seeded `_slots` / `_innate` /
 *   `_reactionUsed`), `party` the selected PCs, `monsters` the seeded
 *   pre-arena instance records, `initiative` the sorted roll.
 */
export function createVersusEncounter({ party = [], pcIds = [], encounter = [], flanking = false, rng, mintId }) {
  if (typeof rng !== 'function') {
    throw new TypeError('encounter-setup.createVersusEncounter: rng must be a function');
  }
  if (typeof mintId !== 'function') {
    throw new TypeError('encounter-setup.createVersusEncounter: mintId must be a function');
  }

  const monsterInstances = encounter.map((e, i) => {
    const preset = MONSTER_PRESETS[e.slug];
    return {
      id: mintId(i, e),
      presetSlug: e.slug, name: e.name,
      hp: { current: preset.defaultHp?.max || 1, max: preset.defaultHp?.max || 1, temp: 0 },
      conditions: []
    };
  });

  // M39 — Seed spell resources on every spell-casting monster (mirrors
  // the simulator's iteration start). F11: this must run BEFORE
  // buildPartyArenaScene, which copies each instance into the arena —
  // seeding afterwards left the live arena monsters with no slot pool
  // and no innate state.
  for (const m of monsterInstances) {
    m._reactionUsed = false;
    const book = spellbookFor(m.presetSlug);
    if (book) m._slots = { ...(book.slots || {}) };
    const innate = innateBlockFor(m.presetSlug);
    if (innate) m._innate = freshInnateState(m.presetSlug);
  }

  // Party PCs left, monsters right.
  const scene = buildPartyArenaScene({
    pcIds, monsterInstances,
    flankingEnabled: !!flanking
  });

  const selectedSet = new Set(pcIds.map(String));
  const selected = party.filter(p => selectedSet.has(String(p.id)));

  // M38 — Seed reaction resources on every PC so Shield/Counterspell
  // can fire. Reset once per fight; refreshed each round.
  for (const pc of selected) {
    pc._reactionUsed = false;
    // M64 T5 — one slot ledger, fully rested at fight start (owner
    // decision: imported characters start rested).
    pc._slots = slotsForPc(pc);
  }

  const initiative = rollPartyInitiative({ pcs: selected, monsters: monsterInstances }, rng);
  scene.initiative = initiative.map((e, i) => ({
    entityId: e.entityId, entityKind: e.entityKind,
    name: e.name, score: e.score, active: i === 0
  }));

  return { scene, party: selected, monsters: monsterInstances, initiative };
}
