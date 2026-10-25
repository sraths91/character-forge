// M65 B27 — run views and prose privacy: viewForRun (players see visited
// nodes and the edges on offer only) and the licensing rule that a
// player never receives another seat's rules / character prose. Every
// outbound frame each member's socket gets is recorded and scanned.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';

import { tempRoot, tempDb } from './helpers/server.js';
import { makeRunRoom, runLog } from './helpers/runs.js';
import { loadRunScript } from '../../src/tests/helpers/run-driver.js';
import { publicSheet, viewForRun, emptyProgress, reduceProgress } from '../runs/views.js';
import { parsedDdbFixture } from '../../src/tests/helpers/entities.js';

const { root, cleanup } = tempRoot('cf-run-privacy-');
after(cleanup);

const SCRIPT = loadRunScript('fight-rest-fight');
const ok = (reply) => { assert.equal(reply?.t, 'ack', JSON.stringify(reply?.p)); return reply.p; };

/** Every prose string in a sheet (rules descriptions, traits, backstory). */
function proseOf(sheet) {
  const out = new Set();
  const walk = (v, key) => {
    if (typeof v === 'string') {
      if (['description', 'snippet', 'desc'].includes(key) && v.length >= 8) out.add(v);
      return;
    }
    if (Array.isArray(v)) { v.forEach(x => walk(x, key)); return; }
    if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, k);
  };
  walk(sheet, '');
  for (const v of Object.values(sheet.traits || {})) if (typeof v === 'string' && v.length >= 8) out.add(v);
  return out;
}

test('B27: publicSheet strips classFeatures / progression / spell prose, traits and backstory; keeps numbers and looks', () => {
  const s = parsedDdbFixture('cleric-l5');
  s.traits = { ...s.traits, backstory: 'Raised in a lighthouse by a retired smuggler.' };
  s.backstory = 'Raised in a lighthouse by a retired smuggler.';
  const p = publicSheet(s);
  assert.ok(s.classFeatures.some(f => f.description));
  assert.ok(Object.values(s.progression).some(pr => pr.features.some(f => f.description)));
  assert.equal(p.classFeatures.some(f => 'description' in f), false);
  assert.equal(Object.values(p.progression).some(pr => pr.features.some(f => 'description' in f)), false);
  assert.equal(JSON.stringify(p).includes('lighthouse'), false);
  assert.equal(p.traits, undefined);
  for (const k of ['name', 'level', 'hp', 'abilityScores', 'equipment', 'appearance', 'classes']) assert.deepEqual(p[k], s[k], k);
  assert.deepEqual(p.spells.map(x => x.name), s.spells.map(x => x.name));
  assert.equal(proseOf(p).size, 0);
  assert.ok(proseOf(s).size > 0);
});

test('B27: viewForRun — players get visited nodes and offered edges only; the DM gets the graph', () => {
  const run = { id: 'r', campaignId: 'c', status: 'between', seq: 3, settings: {}, stash: {}, campaign: SCRIPT.campaign };
  let progress = emptyProgress();
  progress = reduceProgress(progress, { type: 'node.entered', payload: { nodeId: 'n-ambush' } });
  progress = reduceProgress(progress, { type: 'encounter.result', payload: { outcome: 'party-victory' } });
  const ctx = { run, progress, characters: [], items: [], levelUps: [], seats: [] };
  const p = viewForRun(ctx, { role: 'player', id: 'p' });
  assert.deepEqual(p.nodes.map(n => n.id), ['n-ambush']);
  assert.equal(p.nodes[0].payload, undefined, 'an encounter node\'s monsters stay with the DM');
  assert.deepEqual(p.edges, [{ to: 'n-camp' }]);
  assert.equal(JSON.stringify(p).includes('bugbear'), false, 'an unvisited node\'s content never reaches a player');
  assert.equal(JSON.stringify(p).includes('Catch your breath'), false, 'nor its title');
  const d = viewForRun(ctx, { role: 'dm', id: 'd' });
  assert.deepEqual(d.nodes.map(n => n.id), ['n-ambush', 'n-camp', 'n-den']);
  assert.deepEqual(d.run.campaignId, 'c');
});

test('B27: a second player never receives another seat\'s prose over any ws frame of a full run', async () => {
  const { db } = await tempDb(root);
  const ctx = makeRunRoom(db, { players: ['Pat', 'Sam'], seats: [{ seat: 1, fixture: 'cleric-l5', player: 0 }, { seat: 2, fixture: 'fighter-l5', player: 1 }] });
  const r = ctx.open();
  const [pat, sam] = ctx.players;
  const frames = { dm: r.connect(ctx.dmId, 'dm'), pat: r.connect(pat.id, 'player', 'Pat'), sam: r.connect(sam.id, 'player', 'Sam') };
  r.room.run.start({ campaign: SCRIPT.campaign, runId: 'run-b27', seed: SCRIPT.seed });
  ok(await r.dm('dm.node.begin', {}));
  ok(await r.dm('dm.encounter.start', {}));
  await r.settle();
  ok(await r.dm('dm.run.advance', { toNodeId: 'n-camp' }));
  ok(await r.send(pat.id, 'rest.spend', { slotId: 'slot-1', hitDice: { Cleric: 1 } }));
  ok(await r.dm('dm.rest.grant', { type: 'short' }));
  ok(await r.dm('dm.xp.adjust', { slotId: 'slot-1', delta: 9000 }));
  ok(await r.dm('dm.xp.adjust', { slotId: 'slot-2', delta: 9000 }));
  ok(await r.dm('dm.levelup.confirm', { levelUpId: 'lu-1' }));   // the cleric's level 6: features with prose land on the sheet
  const shield = r.runStore.listItems('run-b27').find(i => i.ownerSlotId === 'slot-1' && i.name === 'Shield');
  ok(await r.send(pat.id, 'item.equip', { slotId: 'slot-1', itemId: shield.id, equipped: false }));
  ok(await r.dm('dm.snapshot.save', { label: 'camp' }));
  ok(await r.send(sam.id, 'resync', {}));
  ok(await r.send(pat.id, 'resync', {}));

  const cleric = r.runStore.getCharacter('slot-1').sheet;
  const fighter = r.runStore.getCharacter('slot-2').sheet;
  const own = { pat: proseOf(cleric), sam: proseOf(fighter) };
  const theirs = { sam: [...own.pat].filter(x => !own.sam.has(x)), pat: [...own.sam].filter(x => !own.pat.has(x)) };
  assert.ok(theirs.sam.length > 0 && theirs.pat.length > 0, 'the two sheets carry distinct prose');
  for (const who of ['pat', 'sam']) {
    assert.ok(frames[who].length > 50, `${who} received the run (${frames[who].length} frames)`);
    for (const f of frames[who]) {
      const text = JSON.stringify(f);
      for (const p of theirs[who]) assert.ok(!text.includes(p), `${who} received another seat's prose in ${f.t}: ${p}`);
    }
  }
  // The stored log does hold the cleric's prose (level.applied's granted
  // patch log): the wire copy is what strips it.
  const stored = JSON.stringify(runLog(r.runStore, 'run-b27'));
  assert.ok(theirs.sam.some(x => stored.includes(x)), 'the persisted log keeps the full record server-side');
  // Sanity: the run events and offers did reach the players.
  assert.ok(frames.sam.some(f => f.t === 'run.event' && f.p.type === 'level.applied'));
  assert.ok(frames.pat.some(f => f.t === 'levelup.offer'));
  assert.ok(!frames.sam.some(f => f.t === 'levelup.offer' && f.p.slotId === 'slot-1'), 'offers go to the seat and the DM only');
});
