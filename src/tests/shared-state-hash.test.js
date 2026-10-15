/**
 * M64 — shared/state-hash.js: one hash of the dynamic EncounterState.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stateHash, stateHashInput, canonicalJson, hash53 } from '../js/shared/state-hash.js';

const fixture = () => JSON.parse(readFileSync(new URL('./fixtures/encounters/counterspell.state.json', import.meta.url), 'utf8'));

test('state-hash: stable, 14 hex chars, key-order independent', () => {
  const a = fixture();
  const h = stateHash(a);
  assert.match(h, /^[0-9a-f]{14}$/);
  assert.equal(stateHash(JSON.parse(JSON.stringify(a))), h);
  const reordered = { ...a, entities: Object.fromEntries(Object.entries(a.entities).reverse()) };
  assert.equal(stateHash(reordered), h);
  assert.equal(canonicalJson({ b: 1, a: [{ d: 2, c: 3 }] }), '{"a":[{"c":3,"d":2}],"b":1}');
  assert.notEqual(hash53('abc'), hash53('abd'));
});

test('state-hash: dynamic fields change it', () => {
  const base = stateHash(fixture());
  const muts = [
    s => { s.round = 3; },
    s => { s.turnIndex = 1; },
    s => { s.phase = 'ended'; },
    s => { s.initiative.reverse(); },
    s => { s.entities['pc-fighter'].hp -= 1; },
    s => { s.entities['pc-fighter'].hpTemp = 2; },
    s => { s.entities['pc-fighter'].pos.col += 1; },
    s => { s.entities['pc-fighter'].conditions.push('prone'); },
    s => { s.entities['pc-wizard'].concentration = { spellId: 'hold-person', targetIds: [] }; },
    s => { s.entities['pc-wizard'].resources.slots['1'].spent = 1; },
    s => { s.entities['pc-wizard'].resources.reactionUsed = true; },
    s => { s.entities['pc-fighter'].turnFlags.sneakUsed = true; }
  ];
  for (const [i, m] of muts.entries()) {
    const s = fixture();
    m(s);
    assert.notEqual(stateHash(s), base, `mutation #${i}`);
  }
});

test('state-hash: static and transport fields never change it', () => {
  const base = stateHash(fixture());
  const muts = [
    s => { s.rng.s = 999; },
    s => { s.lastEventSeq = 77; },
    s => { s.entities['pc-fighter'].sheetRef.rev = 9; },
    s => { s.entities['m-fanatic-a'].statBlock.attacks = [{ name: 'x' }]; },
    s => { s.entities['pc-fighter'].name = 'Renamed'; },
    s => { s.entities['pc-fighter'].controller = { type: 'player', seatId: 's1' }; },
    s => { s.entities['pc-wizard'].resources.slots['1'].max = 9; },
    s => { delete s.rng; }
  ];
  for (const [i, m] of muts.entries()) {
    const s = fixture();
    m(s);
    assert.equal(stateHash(s), base, `mutation #${i}`);
  }
  assert.ok(!('rng' in stateHashInput(fixture())));
});
