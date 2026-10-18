// M64 phase 1.5 Wave 6 — Open5e monsters fight with E4's normalised SRD
// stat block (real AC, attacks, saves, R/I/V, multiattack); the preset
// stays the sprite. Driven through a Room on the real engine port.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { Room } from '../rooms/room.js';
import { createRoomService } from '../rooms/service.js';
import { createSqliteJournal } from '../rooms/persistence.js';
import { createRealEngine, statBlockFromOpen5e, presetSlugFor } from '../rooms/real-engine.js';
import { createRng } from '../../src/js/scene/rng.js';
import { validateEncounterState } from '../../src/js/shared/encounter-state.js';
import { validateEvent } from '../../src/js/shared/events.js';
import { parsedDdbFixture } from '../../src/tests/helpers/entities.js';
import { tempRoot, tempDb, quiet, seedRoom } from './helpers/server.js';

const { root, cleanup } = tempRoot('cf-o5e-');
after(cleanup);

const OPEN5E = new URL('../../src/tests/fixtures/open5e/', import.meta.url);
const creature = (key) => JSON.parse(readFileSync(new URL(`${key}.json`, OPEN5E), 'utf8'));
const tick = () => new Promise(r => setImmediate(r));
const seat = (n, fixture) => ({
  slotId: `s_${n}`, seat: n, characterId: String(n), characterName: null, controller: 'player', aiArchetype: null,
  seed: parsedDdbFixture(fixture)
});

test('statBlockFromOpen5e: the normalised SRD block with engine fields and an AI profile', () => {
  const sb = statBlockFromOpen5e(creature('srd_young-red-dragon'));
  assert.equal(sb.source, 'srd-2014');
  assert.deepEqual([sb.ac, sb.hpMax], [18, 178]);
  assert.deepEqual(sb.attacks.map(a => [a.name, a.bonus, a.dice]), [['Bite', 10, '2d10+1d6+6'], ['Claw', 10, '2d6+6']]);
  assert.deepEqual(sb.multiattack, [{ action: 'Bite', count: 1 }, { action: 'Claw', count: 2 }]);
  assert.deepEqual(sb.immunities, ['fire']);
  assert.equal(sb.saves.CON, 9);
  assert.ok(sb.profile);
  assert.equal(presetSlugFor({ slug: 'srd_young-red-dragon', name: 'Young Red Dragon' }, 'dragon'), 'young-dragon', 'dragons draw as the dragon preset');
});

test('a room with the Open5e Young Red Dragon: Bite +10 for 2d10+1d6+6, then the Multiattack claws', async () => {
  const { db } = await tempDb(root);
  try {
    const { roomId, dmId } = seedRoom(db);
    const service = createRoomService({ db });
    const engine = createRealEngine({ monsterLookup: (slug) => (slug === 'srd_young-red-dragon' ? creature(slug) : null) });
    const built = engine.buildEncounter({
      encounterId: 'e-dragon', seed: 11,
      setup: { map: null, grid: { cols: 8, rows: 6 }, monsters: [{ id: 'drg', slug: 'srd_young-red-dragon', controller: 'dm' }], placements: { drg: { col: 3, row: 3 }, 'pc-1': { col: 3, row: 2 } } },
      party: [{ ...seat(1, 'fighter-l5'), controller: 'ai' }]
    });
    assert.ok(validateEncounterState(built).ok);
    const drg = built.entities.drg;
    assert.deepEqual([drg.name, drg.ac, drg.hpMax, drg.statBlock.slug, drg.statBlock.source], ['Young Red Dragon', 18, 178, 'young-dragon', 'srd-2014']);
    const ordered = engine.applyDmCommand(built, { type: 'dm.initiative.set', payload: { order: ['drg', 'pc-1'] } }, { rng: createRng({ s: 1 }), emit: () => {} }).state;
    const started = { ...(await engine.startEncounter(ordered, { rng: createRng({ s: 2 }), emit: () => {} })).state, phase: 'running' };

    const journal0 = createSqliteJournal({ db: db.db });
    journal0.createEncounter({ roomId, encounterId: started.encounterId, state: started, engineVersion: engine.version });
    journal0.setStatus(started.encounterId, 'active');
    const events = [];
    const journal = { ...journal0, flush: (o) => { events.push(...o.events); journal0.flush(o); } };
    const room = new Room({ id: roomId, service, engine, journal, log: quiet });
    const replies = [];
    const conn = { id: 'c', sendRaw: (text) => replies.push(JSON.parse(text)), close() {} };
    let cid = 0;
    const send = async (t, p) => { await room.handle(conn, dmId, { t, cid: `c${++cid}`, p }); return replies.at(-1); };
    room.resume();
    let acted = false;
    for (let guard = 0; guard < 5000 && !events.some(e => e.type === 'turn.ended'); guard++) {
      const aw = room.turn?.awaiting;
      if (aw && !acted) {
        acted = true;
        const r = await send('turn.act', { turnId: room.turn.turnId, plan: { kind: 'melee', targetId: 'pc-1', weaponName: 'Bite' } });
        assert.equal(r.t, 'ack', JSON.stringify(r.p));
      }
      for (const m of replies.splice(0)) {
        if (m.t === 'exchange') await send('cinema.done', { exchangeId: m.p.payload.exchangeId });
      }
      await tick();
    }
    room.shutdown();
    for (const ev of events) assert.ok(validateEvent(ev).ok, `invalid ${ev.type}`);
    const swings = events.filter(e => e.type === 'attack.rolled' && e.payload.attackerId === 'drg');
    assert.deepEqual(swings.map(e => [e.payload.weapon, e.payload.bonus]), [['Bite', 10], ['Claw', 10], ['Claw', 10]], 'Multiattack: one bite and two claws at +10');
    assert.equal(drg.statBlock.attacks[0].dice, '2d10+1d6+6');
    const bite = swings[0];
    const biteDamage = events[events.indexOf(bite) + 1];
    if (bite.payload.hit) {
      assert.equal(biteDamage.type, 'damage');
      // 2d10 + 1d6 + 6 (dice doubled on a crit).
      const [lo, hi] = bite.payload.crit ? [12, 58] : [9, 32];
      assert.ok(biteDamage.payload.amount >= lo && biteDamage.payload.amount <= hi, `bite damage ${biteDamage.payload.amount}`);
    }
    assert.equal(events.find(e => e.type === 'plan.chosen').payload.weapon, 'Bite');
  } finally { db.close(); }
});

test('dm.encounter.setup echoes each monster\'s preset and stat-block source for the "fights as" line', async () => {
  const { db } = await tempDb(root);
  try {
    const { roomId, dmId } = seedRoom(db);
    const service = createRoomService({ db });
    const engine = createRealEngine({ monsterLookup: (slug) => (slug === 'srd_young-red-dragon' ? creature(slug) : null) });
    const room = new Room({ id: roomId, service, engine, journal: createSqliteJournal({ db: db.db }), log: quiet });
    const replies = [];
    const conn = { id: 'c', sendRaw: (text) => replies.push(JSON.parse(text)), close() {} };
    await room.handle(conn, dmId, { t: 'dm.encounter.setup', cid: 'c1', p: { map: null, grid: { cols: 8, rows: 6 }, monsters: [{ id: 'drg', slug: 'srd_young-red-dragon' }, { id: 'gob', preset: 'goblin' }], placements: {} } });
    const ack = replies.find(m => m.t === 'ack' && m.p.cid === 'c1');
    assert.ok(ack, JSON.stringify(replies.at(-1)));
    const byId = Object.fromEntries(ack.p.monsters.map(m => [m.id, m]));
    assert.deepEqual([byId.drg.preset, byId.drg.source, byId.drg.ac, byId.drg.attacks[0]], ['young-dragon', 'srd-2014', 18, { name: 'Bite', bonus: 10, dice: '2d10+1d6+6' }]);
    assert.deepEqual([byId.gob.preset, byId.gob.source], ['goblin', null], 'a preset monster fights with the preset');
    room.shutdown();
  } finally { db.close(); }
});
