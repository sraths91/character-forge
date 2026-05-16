import { test } from 'node:test';
import assert from 'node:assert';
import { diffCharacters, describeDiff } from '../js/character/diff-character.js';

// Compact builder for parsed-character fixtures. Only fills fields the
// differ actually reads.
function parsed(over = {}) {
  return {
    id: '1', name: 'Saris',
    level: 3,
    classes: [{ name: 'Cleric', level: 3, subclass: 'Twilight Domain' }],
    abilityScores: { STR: 13, DEX: 8, CON: 16, INT: 8, WIS: 17, CHA: 8 },
    hp: { max: 27, current: 27 },
    spells: [
      { name: 'Sacred Flame', level: 0 },
      { name: 'Bless', level: 1 }
    ],
    classFeatures: [
      { name: 'Spellcasting', source: 'Cleric', level: 1 },
      { name: 'Channel Divinity', source: 'Cleric', level: 2 }
    ],
    feats: ['Resilient'],
    equipment: { mainhand: { name: 'Mace' }, armor: { name: 'Chain Mail' } },
    ...over
  };
}

// ---------- No-diff cases ----------

test('M23: diff — identical characters → []', () => {
  assert.deepStrictEqual(diffCharacters(parsed(), parsed()), []);
});

test('M23: diff — null previous (first import) → []', () => {
  assert.deepStrictEqual(diffCharacters(null, parsed()), []);
});

// ---------- Level / class ----------

test('M23: diff — total level change emits a level entry', () => {
  const prev = parsed();
  const next = parsed({ level: 4 });
  const d = diffCharacters(prev, next);
  const lvl = d.find(x => x.kind === 'level');
  assert.ok(lvl);
  assert.strictEqual(lvl.direction, 'up');
  assert.strictEqual(lvl.from, 3);
  assert.strictEqual(lvl.to, 4);
});

test('M23: diff — per-class level change emits class-level', () => {
  const prev = parsed();
  const next = parsed({
    level: 4,
    classes: [{ name: 'Cleric', level: 4, subclass: 'Twilight Domain' }]
  });
  const d = diffCharacters(prev, next);
  const cl = d.find(x => x.kind === 'class-level');
  assert.ok(cl);
  assert.strictEqual(cl.class, 'Cleric');
  assert.strictEqual(cl.from, 3);
  assert.strictEqual(cl.to, 4);
});

test('M23: diff — multiclassing into a new class emits class-level from 0', () => {
  const prev = parsed();
  const next = parsed({
    level: 4,
    classes: [
      { name: 'Cleric', level: 3, subclass: 'Twilight Domain' },
      { name: 'Wizard', level: 1, subclass: null }
    ]
  });
  const d = diffCharacters(prev, next);
  const cl = d.find(x => x.kind === 'class-level' && x.class === 'Wizard');
  assert.ok(cl);
  assert.strictEqual(cl.from, 0);
  assert.strictEqual(cl.to, 1);
});

test('M23: diff — choosing a subclass emits subclass entry', () => {
  const prev = parsed({
    classes: [{ name: 'Cleric', level: 2, subclass: null }],
    level: 2
  });
  const next = parsed({
    classes: [{ name: 'Cleric', level: 3, subclass: 'Life Domain' }]
  });
  const d = diffCharacters(prev, next);
  const sub = d.find(x => x.kind === 'subclass');
  assert.ok(sub);
  assert.strictEqual(sub.class, 'Cleric');
  assert.strictEqual(sub.name, 'Life Domain');
});

// ---------- HP / abilities ----------

test('M23: diff — HP max change with positive delta', () => {
  const d = diffCharacters(parsed(), parsed({ hp: { max: 36, current: 27 } }));
  const hp = d.find(x => x.kind === 'hp-max');
  assert.strictEqual(hp.from, 27);
  assert.strictEqual(hp.to, 36);
  assert.strictEqual(hp.delta, 9);
});

test('M23: diff — ability score increase', () => {
  const d = diffCharacters(parsed(), parsed({
    abilityScores: { STR: 13, DEX: 8, CON: 16, INT: 8, WIS: 18, CHA: 8 }   // WIS 17 → 18
  }));
  const ab = d.find(x => x.kind === 'ability' && x.stat === 'WIS');
  assert.strictEqual(ab.from, 17);
  assert.strictEqual(ab.to, 18);
});

// ---------- Spells / features / feats / equipment ----------

test('M23: diff — spell added emits spell-added with level', () => {
  const d = diffCharacters(parsed(), parsed({
    spells: [
      { name: 'Sacred Flame', level: 0 },
      { name: 'Bless', level: 1 },
      { name: 'Spirit Guardians', level: 3 }
    ]
  }));
  const s = d.find(x => x.kind === 'spell-added' && x.name === 'Spirit Guardians');
  assert.ok(s);
  assert.strictEqual(s.level, 3);
});

test('M23: diff — spell removed', () => {
  const d = diffCharacters(parsed(), parsed({
    spells: [{ name: 'Sacred Flame', level: 0 }]   // Bless gone
  }));
  assert.ok(d.find(x => x.kind === 'spell-removed' && x.name === 'Bless'));
});

test('M23: diff — class feature added', () => {
  const d = diffCharacters(parsed(), parsed({
    classFeatures: [
      { name: 'Spellcasting', source: 'Cleric', level: 1 },
      { name: 'Channel Divinity', source: 'Cleric', level: 2 },
      { name: 'Destroy Undead (CR 1/2)', source: 'Cleric', level: 5 }
    ]
  }));
  assert.ok(d.find(x => x.kind === 'feature-added' && /Destroy Undead/.test(x.name)));
});

test('M23: diff — feat added/removed', () => {
  const d = diffCharacters(parsed(), parsed({ feats: ['Resilient', 'War Caster'] }));
  assert.ok(d.find(x => x.kind === 'feat-added' && x.name === 'War Caster'));
});

test('M23: diff — equipment slot swapped emits both removed AND added', () => {
  const d = diffCharacters(parsed(), parsed({
    equipment: { mainhand: { name: '+1 Mace' }, armor: { name: 'Chain Mail' } }
  }));
  const rem = d.find(x => x.kind === 'equipment-removed' && x.slot === 'mainhand');
  const add = d.find(x => x.kind === 'equipment-added' && x.slot === 'mainhand');
  assert.ok(rem && rem.name === 'Mace');
  assert.ok(add && add.name === '+1 Mace');
});

// ---------- Ordering ----------

test('M23: diff — sorted by priority (level first, equipment last)', () => {
  const d = diffCharacters(parsed(), parsed({
    level: 4,
    classes: [{ name: 'Cleric', level: 4, subclass: 'Twilight Domain' }],
    hp: { max: 36, current: 27 },
    equipment: { mainhand: { name: '+1 Mace' }, armor: { name: 'Chain Mail' } }
  }));
  // First entry should be the level change (priority 10)
  assert.strictEqual(d[0].kind, 'level');
  // Equipment changes at the end
  assert.ok(d[d.length - 1].kind.startsWith('equipment-'));
});

// ---------- describeDiff ----------

test('M23: describeDiff — produces a human-readable label per entry', () => {
  const samples = [
    { kind: 'level', direction: 'up', from: 3, to: 4 },
    { kind: 'class-level', class: 'Cleric', from: 3, to: 4 },
    { kind: 'subclass', class: 'Cleric', name: 'Life Domain' },
    { kind: 'hp-max', from: 27, to: 36, delta: 9 },
    { kind: 'ability', stat: 'WIS', from: 17, to: 18 },
    { kind: 'spell-added', name: 'Fireball', level: 3 },
    { kind: 'spell-removed', name: 'Bless', level: 1 },
    { kind: 'feature-added', name: 'Channel Divinity', source: 'Cleric' },
    { kind: 'feat-added', name: 'War Caster' },
    { kind: 'equipment-added', slot: 'mainhand', name: '+1 Mace' }
  ];
  for (const s of samples) {
    const label = describeDiff(s);
    assert.ok(typeof label === 'string' && label.length > 0);
  }
  assert.match(describeDiff(samples[0]), /level/i);
  assert.match(describeDiff(samples[5]), /\+ Spell: Fireball/);
});
