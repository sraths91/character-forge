// M64 B7 — PromptBroker unit tests with an injected clock and timers.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PromptBroker, DEFAULT_PROMPT_TIMEOUT_MS } from '../rooms/prompt-broker.js';

function harness({ online = new Set(['p1']) } = {}) {
  let t = 1000;
  const timers = new Map();
  let nextId = 1;
  const sent = [];
  const broker = new PromptBroker({
    send: (memberId, type, p) => sent.push({ memberId, type, p }),
    isOnline: (id) => online.has(id),
    now: () => t,
    setTimer: (fn, ms) => { const id = nextId++; timers.set(id, { fn, at: t + ms }); return id; },
    clearTimer: (id) => timers.delete(id)
  });
  const advance = (ms) => {
    t += ms;
    for (const [id, tm] of [...timers]) if (tm.at <= t) { timers.delete(id); tm.fn(); }
  };
  return { broker, sent, advance, timers, online };
}

test('default deadline is 20 s', () => assert.equal(DEFAULT_PROMPT_TIMEOUT_MS, 20000));

test('ineligible reactions resolve false with no prompt', async () => {
  const h = harness();
  assert.deepEqual(await h.broker.ask({ kind: 'shield', addressee: 'p1', autoAnswer: true, eligible: false }), { answer: false, by: 'auto' });
  assert.equal(h.sent.length, 0);
});

test('AI (no addressee) and offline owners get the auto answer at once', async () => {
  const h = harness();
  assert.deepEqual(await h.broker.ask({ kind: 'oa', addressee: null, autoAnswer: true }), { answer: true, by: 'auto' });
  assert.deepEqual(await h.broker.ask({ kind: 'oa', addressee: 'p2', autoAnswer: true }), { answer: true, by: 'auto' });
  assert.equal(h.sent.length, 0);
});

test('player answer wins; prompt.open then prompt.closed; answers are type-checked', async () => {
  const h = harness();
  const p = h.broker.ask({ kind: 'shield', addressee: 'p1', autoAnswer: false, payload: { ac: 14 }, timeoutMs: 5000 });
  const open = h.sent[0];
  assert.equal(open.type, 'prompt.open');
  assert.deepEqual({ ...open.p, promptId: 'x' }, { promptId: 'x', kind: 'shield', payload: { ac: 14 }, autoAnswer: false, deadlineAt: 6000, serverNow: 1000 });
  assert.equal(h.broker.answer('p2', open.p.promptId, true), 'forbidden');
  assert.equal(h.broker.answer('p1', open.p.promptId, 'yes'), 'invalid');
  h.advance(1000);
  assert.equal(h.broker.openPromptFor('p1').deadlineAt, 6000, 'original deadline on reconnect');
  assert.equal(h.broker.answer('p1', open.p.promptId, true), 'ok');
  assert.deepEqual(await p, { answer: true, by: 'player', promptId: open.p.promptId });
  assert.deepEqual(h.sent[1], { memberId: 'p1', type: 'prompt.closed', p: { promptId: open.p.promptId, reason: 'player' } });
  assert.equal(h.broker.answer('p1', open.p.promptId, true), 'stale');
  assert.equal(h.timers.size, 0, 'deadline timer cleared');
});

test('the deadline resolves with the auto answer', async () => {
  const h = harness();
  const p = h.broker.ask({ kind: 'counterspell', addressee: 'p1', autoAnswer: true, timeoutMs: 300 });
  h.advance(299);
  assert.equal(h.broker.open.size, 1);
  h.advance(1);
  assert.deepEqual((await p).by, 'timeout');
  assert.equal((await p).answer, true);
});

test('dm.prompt.force, going offline and cancelAll all settle prompts', async () => {
  const h = harness({ online: new Set(['p1', 'dm']) });
  const a = h.broker.ask({ kind: 'roll', addressee: 'dm', autoAnswer: 7 });
  const b = h.broker.ask({ kind: 'oa', addressee: 'p1', autoAnswer: true });
  const c = h.broker.ask({ kind: 'plan', addressee: 'dm', autoAnswer: { kind: 'melee' } });
  const [pa, , pc] = [...h.broker.open.keys()];
  assert.equal(h.broker.force(pa, 'x'), 'invalid');
  assert.equal(h.broker.force(pa, 12), 'ok');
  assert.deepEqual((await a), { answer: 12, by: 'dm', promptId: pa });
  h.broker.memberOffline('p1');
  assert.deepEqual([(await b).answer, (await b).by], [true, 'auto']);
  h.broker.cancelAll();
  assert.deepEqual((await c).answer, { kind: 'melee' });
  assert.equal(h.broker.force(pc, null), 'stale');
  assert.equal(h.timers.size, 0);
});
