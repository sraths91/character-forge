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
 *     reverts back to level 4.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { mount as mountLevelUp, autoSummary, checkAsi, parseSpellList, spellAllowanceText, revertable } from '../js/client/views/level-up.js';
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
