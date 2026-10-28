/**
 * M65 C25 — the level-up view (views/level-up.js).
 *
 *   - pure: autoSummary (HP / hit die / PB / slots / features), checkAsi,
 *     parseSpellList, spellAllowanceText, revertable;
 *   - GATE, against the REAL run controller in-process: a Saris-like
 *     cleric goes 4 → 5 through the UI — the offer's summary, a refused
 *     reconcile (D&D Beyond ahead), an unknown spell refused in words, the
 *     player's choice (choose mode: the level waits for the DM, players get
 *     no confirm), the DM's confirm (slots {1:4, 2:3, 3:2}, HP +7), a
 *     D&D Beyond reconcile shown with describeDiff and confirmed, and both
 *     reverts back to level 4; the reconcile's ack shows how many game
 *     grants were kept (v1.7 `kept`);
 *   - v1.7 levelUpMode 'auto': the fighter's level 6 (an ASI) waits for
 *     the DM, who picks it on the card; level 7 (no choices) shows no
 *     confirm and, once 6 is confirmed, applies on its own — the hub shows
 *     its applied summary instead.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { mount as mountLevelUp, autoSummary, checkAsi, parseSpellList, spellAllowanceText, revertable, appliedSummary, offerHasChoices, keptText } from '../js/client/views/level-up.js';
import { refusalText } from '../js/client/run-model.js';
import { planLevelUp } from '../js/campaign/level-up.js';
import { initialRunState } from '../js/shared/run-state.js';
import { parseCharacter } from '../../api/lib/ddb-parser.js';
import { createFakeDom } from './helpers/fake-dom.js';
import { flush } from './helpers/client-fixtures.js';
import { loadDdbFixture } from './helpers/entities.js';
import { bootRunTable, cleric4Raw, until } from './helpers/run-table.js';

const ROOT = mkdtempSync(join(tmpdir(), 'cf-c25-'));
after(() => rmSync(ROOT, { recursive: true, force: true }));

test('C25 pure: the auto summary of a cleric 4→5 plan', () => {
  const sheet = parseCharacter(cleric4Raw());
  const plan = planLevelUp(sheet, initialRunState(sheet), { toLevel: 5 });
  const lines = autoSummary(plan.auto);
  assert.ok(lines.includes('HP +7 (d8 average 5 +2 CON)'), lines.join(' | '));
  assert.ok(lines.includes('Hit dice: Cleric d8 4 → 5'));
  assert.ok(lines.includes('Proficiency +2 → +3'));
  assert.ok(lines.includes('Spell slots 1:4 2:3 → 1:4 2:3 3:2'));
  assert.ok(lines.some(l => l.startsWith('New feature: Destroy Undead')));
  assert.deepEqual(autoSummary({ hp: { mode: 'roll', die: 10, con: 1 } }), ['HP: roll d10 +1 (at least 1)']);
  assert.deepEqual(autoSummary({ proposals: [{ kind: 'feat-added', name: 'Alert' }] }), ['+ Feat: Alert']);
  assert.deepEqual(autoSummary(null), []);
  assert.equal(spellAllowanceText(plan.choices.spells), 'New spells (SRD): up to 1 spell up to level 3.');
  assert.equal(spellAllowanceText({ cantrips: 1, known: 2, prepared: 0, maxSpellLevel: 2 }), 'New spells (SRD): up to 1 cantrip and 2 spells up to level 2.');
});

test('C25 pure: checkAsi, parseSpellList, revertable', () => {
  const a = { count: 1, points: 2, cap: 20, perStatMax: 2 };
  assert.deepEqual(checkAsi(a, { WIS: 2 }, { WIS: 16 }), { ok: true, used: 2, asi: { WIS: 2 } });
  assert.equal(checkAsi(a, { WIS: 1 }, {}).error, 'Spend exactly 2 points (1 so far).');
  assert.equal(checkAsi(a, { WIS: 2 }, { WIS: 19 }).error, 'WIS would pass 20.');
  assert.equal(checkAsi(null, { STR: 1 }).ok, false);
  assert.equal(checkAsi(null, {}).ok, true);
  assert.deepEqual(parseSpellList(' Bless, bless ,Command\n'), ['Bless', 'Command']);
  const r = revertable([{ id: 'lu-1', slotId: 's', status: 'applied' }, { id: 'lu-2', slotId: 's', status: 'applied' }, { id: 'lu-3', slotId: 's', status: 'reverted' }, { id: 'lu-4', slotId: 't', status: 'pending_dm' }]);
  assert.deepEqual([...r.keys()], ['s']);
  assert.equal(r.get('s').id, 'lu-2');
});

test('C25 v1.7 pure: appliedSummary, offerHasChoices, keptText, the kept refusal', () => {
  assert.deepEqual(appliedSummary({ v: 1, fromLevel: 6, toLevel: 7, className: 'Fighter', classLevelTo: 7, hp: { mode: 'fixed', die: 10, con: 3, gain: 9 }, asi: null, spells: [], features: ['Martial Archetype Feature'] }),
    ['HP +9 (d10 average +3 CON)', 'Fighter 7', 'New feature: Martial Archetype Feature']);
  assert.deepEqual(appliedSummary({ hp: { mode: 'roll', die: 8, roll: 5, con: 1, gain: 6 }, asi: { WIS: 2 }, spells: ['Command'] }), ['HP +6 (rolled 5 on d8 +1 CON)', 'Ability scores: WIS +2', 'New spells: Command']);
  assert.deepEqual(appliedSummary(null), []);
  assert.equal(offerHasChoices({ choices: { className: null, asi: { points: 2 }, spells: null } }), true);
  assert.equal(offerHasChoices({ choices: { className: null, asi: null, spells: null } }), false);
  assert.equal(offerHasChoices({}), false);
  assert.deepEqual([keptText(1), keptText(3), keptText(0)], ['1 game-granted entry kept', '3 game-granted entries kept', '']);
  assert.equal(refusalText({ code: 'nothing-to-reconcile', frame: { details: { kept: 2 } } }), 'D&D Beyond has no structural change to bring in (2 game-granted entries kept).');
});

function view(t, who) {
  const dom = createFakeDom();
  const root = dom.root();
  const un = mountLevelUp(root, t.ctx(who));
  const field = (f, key) => dom.findAll(root, n => n.dataset?.field === f && (key === undefined || n.dataset.key === key))[0];
  const act = (action, pred = () => true) => {
    const el = dom.byAction(root, action).find(pred);
    assert.ok(el, `${who}: button ${action}`);
    el.click();
  };
  const status = () => dom.findAll(root, n => /play-status/.test(n.className))[0].textContent;
  return { dom, root, un, field, act, status, text: () => root.textContent, has: (action) => dom.byAction(root, action).length > 0 };
}

const NODES = [
  { id: 'n-camp', kind: 'rest', title: 'Camp', start: true, payload: { type: 'long' }, next: [] }
];

test('C25 GATE: a cleric 4 → 5 through the UI against the real controller (choose mode)', async () => {
  const t = await bootRunTable(ROOT, { nodes: NODES, settings: { xpMode: 'xp', levelUpMode: 'choose', hpOnLevel: 'average' } });
  try {
    const pr = () => t.sessions.player.runStore.getState();
    const cleric = pr().characters.find(c => c.seat === 1);
    assert.equal(cleric.level, 4);
    const P = view(t, 'player');
    const D = view(t, 'dm');
    const sheet = async () => (await t.apis.dm.getSeatSheet(t.room.roomId, cleric.slotId)).sheet;
    const hpMax4 = (await sheet()).hp.max;

    // 6,500 XP → level 5 queued; the offer reaches the player and the DM.
    await t.sessions.dm.send({ t: 'dm.xp.adjust', p: { slotId: cleric.slotId, delta: 6500 - 2700 } });
    await until(() => Object.keys(pr().offers).length && /level 4 → 5/.test(P.text()), 'the offer on the player\'s screen');
    const luId = pr().levelUps.find(l => l.slotId === cleric.slotId).id;
    for (const line of ['HP +7', 'Hit dice: Cleric d8 4 → 5', 'Proficiency +2 → +3', 'Spell slots 1:4 2:3 → 1:4 2:3 3:2', 'New feature: Destroy Undead', 'New spells (SRD): up to 1 spell up to level 3.']) {
      assert.ok(P.text().includes(line), `player sees "${line}"`);
    }
    await until(() => /level 4 → 5/.test(D.text()), 'the DM sees it');
    assert.equal(P.has('lu-confirm'), false, 'players never confirm');

    // A reconcile while D&D Beyond is ahead of the game: refused, in words.
    const paste = P.field('paste', cleric.slotId);
    paste.value = JSON.stringify(loadDdbFixture('cleric-l5'));
    P.dom.fire(paste, 'input');
    P.act('lu-reconcile');
    await until(() => /ahead of the level the game has granted/.test(P.status()), 'the ddb-level-ahead refusal');
    assert.equal(P.status(), 'D&D Beyond is at level 5, ahead of the level the game has granted (4). Level up in the game first.');

    // An unknown spell is refused by the server; Command is accepted.
    const spells = P.field('spells', luId);
    spells.value = 'Wish';
    P.dom.fire(spells, 'input');
    P.act('lu-choose');
    await until(() => /not a known SRD spell/.test(P.status()), 'the unknown-spell refusal');
    const spells2 = P.field('spells', luId);
    spells2.value = 'Command';
    P.dom.fire(spells2, 'input');
    P.act('lu-choose');
    await until(() => pr().levelUps.find(l => l.id === luId).status === 'pending_dm', 'choices sent');
    await until(() => /Picked: spells Command/.test(P.text()) && /The DM confirms this level-up/.test(P.text()), 'the player waits for the DM');
    assert.equal(pr().characters.find(c => c.slotId === cleric.slotId).level, 4, 'choose mode: no level until the DM confirms');
    assert.equal(P.has('lu-choose'), false);

    // The DM confirms.
    await until(() => D.has('lu-confirm') && /waiting for the DM/.test(D.text()), 'the DM\'s confirm');
    D.act('lu-confirm');
    await until(() => pr().characters.find(c => c.slotId === cleric.slotId).level === 5, 'level 5');
    const s5 = await sheet();
    assert.deepEqual(s5.spellSlotTable.spell, { 1: 4, 2: 3, 3: 2 });
    assert.equal(s5.hp.max, hpMax4 + 7);
    assert.ok(s5.spells.some(s => s.name === 'Command'));
    await until(() => /No level-up is waiting/.test(P.text()), 'the player\'s list clears');

    // Reconcile at level 5: D&D Beyond adds the Alert feat.
    const raw = loadDdbFixture('cleric-l5');
    raw.feats = [...raw.feats, { componentId: 1, componentTypeId: 1, definition: { id: 990001, name: 'Alert' } }];
    const paste2 = P.field('paste', cleric.slotId);   // re-rendered since
    paste2.value = JSON.stringify(raw);
    P.dom.fire(paste2, 'input');
    P.act('lu-reconcile');
    await until(() => pr().levelUps.some(l => l.mode === 'reconcile' && l.status === 'pending_dm'), 'the reconcile queued');
    await until(() => /wait for the DM \(1 game-granted entry kept\)/.test(P.status()), 'the kept game grant (Command) in the ack');
    await until(() => /\+ Feat: Alert/.test(P.text()) && /\+ Feat: Alert/.test(D.text()), 'describeDiff proposals on both screens');
    await flush();
    D.act('lu-confirm');
    await until(() => pr().levelUps.every(l => l.mode !== 'reconcile' || l.status === 'applied'), 'the reconcile applied');
    assert.ok((await sheet()).feats.includes('Alert'));

    // The DM reverts the latest applied (the reconcile), then the level.
    await until(() => /Revert Fixture Cleric's D&D Beyond changes/.test(D.text()), 'the reconcile revert');
    D.act('lu-revert');
    await until(() => /Revert Fixture Cleric's level 5/.test(D.text()), 'the level revert');
    assert.ok(!(await sheet()).feats.includes('Alert'));
    D.act('lu-revert');
    await until(() => pr().characters.find(c => c.slotId === cleric.slotId).level === 4, 'back to level 4');
    assert.equal((await sheet()).hp.max, hpMax4);
    assert.equal(P.has('lu-revert'), false, 'players never revert');

    P.un();
    D.un();
    assert.equal(P.dom.activeListeners() + D.dom.activeListeners(), 0);
  } finally {
    await t.close();
  }
});

test('C25 v1.7 GATE: levelUpMode auto — the DM picks level 6\'s ASI on the card; level 7 has no confirm and applies on its own', async () => {
  const t = await bootRunTable(ROOT, { nodes: NODES, settings: { xpMode: 'xp', levelUpMode: 'auto', hpOnLevel: 'average' } });
  try {
    const dr = () => t.sessions.dm.runStore.getState();
    const fighter = dr().characters.find(c => c.seat === 2);
    assert.equal(fighter.level, 5);
    const D = view(t, 'dm');
    const sent = [];
    const send0 = t.sessions.dm.send;
    t.sessions.dm.send = (i) => { sent.push(i); return send0(i); };
    await t.sessions.dm.send({ t: 'dm.xp.adjust', p: { slotId: fighter.slotId, delta: 23000 - fighter.xp } });
    await until(() => dr().levelUps.filter(l => l.slotId === fighter.slotId).length === 2, 'levels 6 and 7 queued');
    const [lu6, lu7] = dr().levelUps.filter(l => l.slotId === fighter.slotId).sort((a, b) => a.fromLevel - b.fromLevel);
    assert.deepEqual([lu6.status, lu7.status, lu6.mode], ['pending_dm', 'pending_dm', 'auto']);
    // Level 7 waits behind 6 with no confirm button; level 6 asks the DM for the ASI.
    await until(() => D.field('lu-auto', lu7.id) && D.field('asi', `${lu6.id}:STR`), 'both cards');
    assert.match(D.field('lu-auto', lu7.id).textContent, /Waits for level 6/);
    assert.deepEqual(D.dom.byAction(D.root, 'lu-confirm').map(el => el.dataset.id), [lu6.id], 'only level 6 has a confirm');
    for (const stat of ['STR', 'CON']) {
      const sel = D.field('asi', `${lu6.id}:${stat}`);
      sel.value = '1';
      D.dom.fire(sel, 'change');
    }
    sent.length = 0;
    D.act('lu-confirm', el => el.dataset.id === lu6.id);
    await until(() => dr().characters.find(c => c.slotId === fighter.slotId).level === 7, 'level 7 (6 confirmed, 7 on its own)');
    t.sessions.dm.send = send0;
    assert.deepEqual(sent, [{ t: 'dm.levelup.confirm', p: { levelUpId: lu6.id, choices: { asi: { STR: 1, CON: 1 } } } }]);
    const applied = dr().log.filter(e => e.type === 'level.applied').map(e => [e.payload.levelUpId, e.actorKind]);
    assert.deepEqual(applied, [[lu6.id, 'dm'], [lu7.id, 'system']]);
    // The hub shows level 7's applied summary, not a confirm.
    await until(() => D.dom.findAll(D.root, n => n.dataset?.levelApplied === lu7.id).length === 1, 'the applied summary');
    const card = D.dom.findAll(D.root, n => n.dataset?.levelApplied === lu7.id)[0].textContent;
    assert.match(card, /level 6 → 7/);
    assert.match(card, /applied automatically/);
    assert.match(card, /HP \+\d+ \(d10 average/);
    assert.match(card, /Fighter 7/);
    assert.equal(D.has('lu-confirm'), false);
    D.un();
    assert.equal(D.dom.activeListeners(), 0);
  } finally {
    await t.close();
  }
});
