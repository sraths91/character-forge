import { test } from 'node:test';
import assert from 'node:assert';
import {
  createRecorder, archiveReplay, listReplays, getReplayById,
  clearReplays, filterEvents, summarizeReplay
} from '../js/scene/fight-recorder.js';

// ---------- Recorder basics ----------

test('M36.0: recorder is silent until start() is called', () => {
  const rec = createRecorder();
  const id = rec.record({ type: 'attack', actorName: 'A', targetName: 'B', summary: 'A hits B' });
  assert.strictEqual(id, null);
  assert.strictEqual(rec.getReplay().events.length, 0);
});

test('M36.0: start() activates recording', () => {
  const rec = createRecorder();
  rec.start();
  assert.strictEqual(rec.isRecording(), true);
  rec.stop();
  assert.strictEqual(rec.isRecording(), false);
});

test('M36.0: setRound emits a round-marker event when recording', () => {
  const rec = createRecorder();
  rec.start();
  rec.setRound(1);
  const events = rec.getReplay().events;
  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0].type, 'round');
  assert.match(events[0].summary, /Round 1/);
});

test('M36.0: setRound is silent before start', () => {
  const rec = createRecorder();
  rec.setRound(3);
  const replay = rec.getReplay();
  assert.strictEqual(replay.events.length, 0);
  assert.strictEqual(replay.rounds, 3);   // round counter still bumps
});

test('M36.0: record assigns monotonic ids', () => {
  const rec = createRecorder();
  rec.start();
  const a = rec.record({ type: 'attack', actorName: 'A', summary: 'first' });
  const b = rec.record({ type: 'attack', actorName: 'A', summary: 'second' });
  assert.strictEqual(b, a + 1);
});

test('M36.0: record rejects unknown event types', () => {
  const rec = createRecorder();
  rec.start();
  const id = rec.record({ type: 'asdf-unknown', summary: 'x' });
  assert.strictEqual(id, null);
});

test('M36.0: record copies actor + target identity into the event', () => {
  const rec = createRecorder();
  rec.start();
  rec.record({
    type: 'attack', actorId: 'pc1', actorName: 'Hero',
    targetId: 'g1', targetName: 'Goblin', summary: 'Hero hits Goblin',
    detail: { damage: 7, crit: false }
  });
  const e = rec.getReplay().events[0];
  assert.strictEqual(e.actorId, 'pc1');
  assert.strictEqual(e.targetId, 'g1');
  assert.strictEqual(e.detail.damage, 7);
});

test('M36.0: finalize attaches outcome + an end marker', () => {
  const rec = createRecorder();
  rec.start();
  rec.setRound(1);
  rec.finalize('party-wins');
  const replay = rec.getReplay();
  assert.strictEqual(replay.outcome, 'party-wins');
  assert.ok(replay.endedAt !== null);
  const end = replay.events[replay.events.length - 1];
  assert.strictEqual(end.type, 'end');
  assert.match(end.summary, /Party wins/);
});

test('M36.0: finalize stops further recording', () => {
  const rec = createRecorder();
  rec.start();
  rec.finalize('draw');
  rec.record({ type: 'attack', summary: 'late' });
  // After end-marker, only the end event should be in the array
  const lastNonEnd = rec.getReplay().events.filter(e => e.type !== 'end');
  assert.strictEqual(lastNonEnd.length, 0);
});

test('M36.0: participants list is captured at construction time', () => {
  const rec = createRecorder({
    participants: [
      { id: 'pc1', name: 'Hero', kind: 'pc',     hp: { max: 30 } },
      { id: 'g1',  name: 'Gob',  kind: 'monster', hp: { max: 7 } }
    ]
  });
  const replay = rec.getReplay();
  assert.deepStrictEqual(replay.participants, [
    { id: 'pc1', name: 'Hero', kind: 'pc',     hpMax: 30 },
    { id: 'g1',  name: 'Gob',  kind: 'monster', hpMax: 7 }
  ]);
});

// ---------- History ----------

test('M36.2: history keeps the most recent 5 replays', () => {
  clearReplays();
  for (let i = 0; i < 7; i++) {
    const rec = createRecorder();
    rec.start();
    rec.finalize('draw');
    archiveReplay(rec.getReplay());
  }
  const list = listReplays();
  assert.strictEqual(list.length, 5);
});

test('M36.2: archiveReplay refuses unfinished replays', () => {
  clearReplays();
  const rec = createRecorder();
  rec.start();
  archiveReplay(rec.getReplay());
  assert.strictEqual(listReplays().length, 0);
});

test('M36.2: getReplayById looks up by replay id', () => {
  clearReplays();
  const rec = createRecorder();
  rec.start();
  rec.finalize('party-wins');
  archiveReplay(rec.getReplay());
  const id = rec.getReplay().id;
  assert.strictEqual(getReplayById(id)?.outcome, 'party-wins');
  assert.strictEqual(getReplayById('not-real'), null);
});

// ---------- Filtering ----------

test('M36.1: filterEvents — no types returns everything', () => {
  const rec = createRecorder();
  rec.start();
  rec.setRound(1);
  rec.record({ type: 'attack', summary: 'a' });
  rec.record({ type: 'spell',  summary: 's' });
  rec.finalize('draw');
  assert.strictEqual(filterEvents(rec.getReplay()).length, 4);
});

test('M36.1: filterEvents — pass-through for round/end markers regardless of filter', () => {
  const rec = createRecorder();
  rec.start();
  rec.setRound(1);
  rec.record({ type: 'attack', summary: 'a' });
  rec.record({ type: 'spell',  summary: 's' });
  rec.finalize('draw');
  const filtered = filterEvents(rec.getReplay(), ['attack']);
  // attack + round + end = 3
  assert.strictEqual(filtered.length, 3);
  assert.ok(filtered.some(e => e.type === 'round'));
  assert.ok(filtered.some(e => e.type === 'end'));
});

test('M36.1: summarizeReplay — returns counts by event type', () => {
  const rec = createRecorder();
  rec.start();
  rec.record({ type: 'attack', summary: 'a1' });
  rec.record({ type: 'attack', summary: 'a2' });
  rec.record({ type: 'reaction', summary: 'r1' });
  rec.record({ type: 'spell', summary: 's1' });
  rec.record({ type: 'death', summary: 'd1' });
  rec.finalize('party-wins');
  const counts = summarizeReplay(rec.getReplay());
  assert.deepStrictEqual(counts, { attack: 2, reaction: 1, spell: 1, heal: 0, death: 1 });
});
