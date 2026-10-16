// M64 E2 — shared fixtures for the play-client tests (render adapter,
// intents, views, scripted session). Built from the Wave 0 contract
// fixtures so every message is validateServerMessage-clean.
import { readFileSync } from 'node:fs';

const read = (f) => JSON.parse(readFileSync(new URL(`../fixtures/contracts/${f}`, import.meta.url), 'utf8'));
export const clone = (v) => JSON.parse(JSON.stringify(v));

/** A projected EncounterState (no rng) with every creature standing. */
export function projectedState() {
  const s = clone(read('encounter-state.valid.json'));
  delete s.rng;
  s.entities['m-goblin'].hp = 7;
  return s;
}

/** room.snapshot server message. */
export function snapshotMsg(seq = 10, encounter = projectedState(), room = { code: 'ABC123', status: 'in-encounter' }) {
  return { v: 1, t: 'room.snapshot', ts: 1, p: { seq, room, encounter, openPrompt: null, history: [] } };
}

/** An engine event wrapped as a sequenced broadcast. */
export function eventMsg(seq, type, payload, { round = 2, turnId = 't1', cinemaGroup = null } = {}) {
  return { v: 1, t: type, seq, ts: 1, p: { seq, type, round, turnId, cinemaGroup, payload } };
}

/** A non-engine broadcast. */
export function roomMsg(seq, t, p) {
  return { v: 1, t, seq, ts: 1, p };
}

/** The three messages of one weapon exchange: attack.rolled, damage, exchange. */
export function weaponExchange(startSeq, { attackerId = 'pc-fighter', defenderId = 'm-goblin', before = 7, after = 0, max = 7, group = 'x9' } = {}) {
  const dmg = before - after;
  const opts = { cinemaGroup: group };
  return [
    eventMsg(startSeq, 'attack.rolled', {
      attackerId, targetId: defenderId, weapon: 'Longsword', isReaction: false, advantage: 'normal',
      d20: [15], kept: 15, bonus: 6, total: 21, ac: 15, hit: true, crit: false, shielded: false
    }, opts),
    eventMsg(startSeq + 1, 'damage', {
      sourceId: attackerId, targetId: defenderId, amount: dmg, type: 'slashing', hpBefore: before, hpAfter: after
    }, opts),
    eventMsg(startSeq + 2, 'exchange', {
      exchangeId: group, attackerId, defenderId, reaction: false, cast: false,
      roll: { bonus: 6, total: 21, ac: 15, hit: true, crit: false, shielded: false },
      damage: { total: dmg, smite: 0, heal: 0, type: 'slashing' },
      effects: [{ entityId: defenderId, hp: { before, after, max } }],
      cinema: {
        weapon: { name: 'Longsword', damageType: 'slashing', magical: false },
        style: 'standard', swing: 'diagonal', modifiers: [], smiteSlot: null,
        attackerLevel: 5, killing: after === 0 && before > 0, spell: null, outcome: null,
        fxSeed: 7, durationMs: 0
      }
    }, opts)
  ];
}

/** Manual timers: `fire()` runs every due callback; `advance(ms)` moves the clock. */
export function manualTimers() {
  let now = 0;
  let nextId = 1;
  const pending = new Map();
  return {
    setTimeout(fn, ms) { const id = nextId++; pending.set(id, { fn, at: now + (ms | 0) }); return id; },
    clearTimeout(id) { pending.delete(id); },
    advance(ms) {
      now += ms;
      for (const [id, t] of [...pending]) if (t.at <= now) { pending.delete(id); t.fn(); }
    },
    get size() { return pending.size; },
    delays() { return [...pending.values()].map(t => t.at - now); },
    get now() { return now; }
  };
}

/** Let queued promise callbacks run. */
export async function flush(n = 6) {
  for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r));
}

/** Manual requestAnimationFrame. */
export function manualRaf() {
  const q = [];
  return {
    raf: (cb) => { q.push(cb); return q.length; },
    caf: () => {},
    async frame() { const cbs = q.splice(0); for (const cb of cbs) await cb(0); }
  };
}
