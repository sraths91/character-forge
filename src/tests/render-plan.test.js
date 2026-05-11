import { test } from 'node:test';
import assert from 'node:assert';
import { buildRenderPlan, BACK_DERIVED_POSES } from '../js/sprite/lpc-config.js';
import { assignCarriedSlots } from '../js/sprite/slot-overrides.js';

const baseChar = (extras = {}) => ({
  race: { name: 'Human' },
  classes: [{ name: 'Fighter', level: 1 }],
  visualHints: { featTags: [] },
  equipment: { armor: null, mainhand: null, offhand: null },
  carried: [],
  ...extras
});

test('auto-fill: first overflow weapon with LPC back-art emits kind:item back-weapon', () => {
  const c0 = baseChar({
    equipment: { armor: null, mainhand: { name: 'Longsword', rarity: 'Common', magical: false }, offhand: null },
    carried: [
      { name: 'Longsword', slot: 'mainhand', inferredSlot: 'mainhand', twoHanded: false, rarity: 'Common', magical: false },
      { name: 'Rapier',    slot: 'overflow', inferredSlot: 'mainhand', twoHanded: false, rarity: 'Common', magical: false }
    ]
  });
  const c = assignCarriedSlots(c0, {});
  const plan = buildRenderPlan(c);
  const back = plan.layers.find(l => l.slot === 'back-weapon');
  assert.ok(back, 'expected back-weapon layer');
  assert.strictEqual(back.kind, 'item');
  assert.ok(back.src.endsWith('rapier.png'));
});

test('auto-fill: weapon WITHOUT bespoke LPC art still gets derived sprite', () => {
  // Halberd has no universal_behind in LPC, but DOES have a BACK_DERIVED_POSES
  // entry — so it derives from the mainhand sprite instead of falling to rect.
  const c0 = baseChar({
    equipment: { armor: null, mainhand: { name: 'Mace', rarity: 'Common' }, offhand: null },
    carried: [
      { name: 'Mace',     slot: 'mainhand', inferredSlot: 'mainhand', twoHanded: false, rarity: 'Common' },
      { name: 'Halberd',  slot: 'overflow', inferredSlot: 'mainhand-twohanded', twoHanded: true, rarity: 'Common' }
    ]
  });
  const c = assignCarriedSlots(c0, {});
  const plan = buildRenderPlan(c);
  const back = plan.layers.find(l => l.slot === 'back-weapon');
  assert.ok(back);
  assert.strictEqual(back.kind, 'derived-item');
  assert.ok(back.src.endsWith('weapon/halberd.png'));
});

test('unrecognised weapon name on back falls back to procedural rect', () => {
  const c0 = baseChar({
    equipment: { armor: null, mainhand: { name: 'Mace' }, offhand: null },
    carried: [
      { name: 'Mace',     slot: 'mainhand', inferredSlot: 'mainhand', twoHanded: false, rarity: 'Common' },
      { name: 'Mystery Weapon', slot: 'overflow', inferredSlot: 'mainhand', twoHanded: false, rarity: 'Common' }
    ]
  });
  const c = assignCarriedSlots(c0, {});
  const plan = buildRenderPlan(c);
  const back = plan.layers.find(l => l.slot === 'back-weapon');
  assert.ok(back);
  // pickWeapon returns null for "Mystery Weapon" — no derived pose can be
  // selected — falls through to procedural rect.
  assert.strictEqual(back.kind, 'rect');
});

test('auto-fill: second overflow weapon emits waist-weapon as derived sprite', () => {
  const c0 = baseChar({
    equipment: { armor: null, mainhand: { name: 'Longsword' }, offhand: null },
    carried: [
      { name: 'Longsword', slot: 'mainhand', inferredSlot: 'mainhand', twoHanded: false, rarity: 'Common' },
      { name: 'Rapier',    slot: 'overflow', inferredSlot: 'mainhand', twoHanded: false, rarity: 'Common' },
      { name: 'Dagger',    slot: 'overflow', inferredSlot: 'mainhand', twoHanded: false, rarity: 'Common' }
    ]
  });
  const c = assignCarriedSlots(c0, {});
  const plan = buildRenderPlan(c);
  const back  = plan.layers.find(l => l.slot === 'back-weapon');
  const waist = plan.layers.find(l => l.slot === 'waist-weapon');
  assert.ok(back, 'expected back-weapon');
  assert.ok(waist, 'expected waist-weapon');
  // Dagger has WAIST_DERIVED_POSES entry → derived-item instead of rect
  assert.strictEqual(waist.kind, 'derived-item');
  assert.ok(waist.src.endsWith('weapon/dagger.png'));
});

test('two-handed weapons cannot be auto-assigned to waist', () => {
  const c0 = baseChar({
    equipment: { armor: null, mainhand: { name: 'Mace' }, offhand: null },
    carried: [
      { name: 'Mace',       slot: 'mainhand', inferredSlot: 'mainhand', twoHanded: false, rarity: 'Common' },
      { name: 'Greatsword', slot: 'overflow', inferredSlot: 'mainhand-twohanded', twoHanded: true, rarity: 'Common' }
    ]
  });
  const c = assignCarriedSlots(c0, {});
  const plan = buildRenderPlan(c);
  assert.ok(plan.layers.find(l => l.slot === 'back-weapon'));
  assert.strictEqual(plan.layers.find(l => l.slot === 'waist-weapon'), undefined);
});

test('manual back override: user-chosen item renders on back', () => {
  const c0 = baseChar({
    equipment: { armor: null, mainhand: { name: 'Longsword', rarity: 'Common', magical: false }, offhand: null },
    carried: [
      { name: 'Longsword', slot: 'mainhand', inferredSlot: 'mainhand', twoHanded: false, rarity: 'Common', magical: false },
      { name: 'Rapier',    slot: 'overflow', inferredSlot: 'mainhand', twoHanded: false, rarity: 'Common', magical: false }
    ]
  });
  const c = assignCarriedSlots(c0, { back: 'Longsword' });
  const plan = buildRenderPlan(c);
  const back = plan.layers.find(l => l.slot === 'back-weapon');
  assert.ok(back, 'expected back-weapon');
  assert.strictEqual(back.kind, 'item');
  assert.ok(back.src.endsWith('longsword.png'));
  // mainhand cleared (Longsword moved out via prevSlot fix)
  assert.strictEqual(c.equipment.mainhand, null);
});

test('character with no carried renders cleanly (no back/waist layers)', () => {
  const c = baseChar();
  const plan = buildRenderPlan(c);
  assert.strictEqual(plan.layers.find(l => l.slot === 'back-weapon'), undefined);
  assert.strictEqual(plan.layers.find(l => l.slot === 'waist-weapon'), undefined);
});

// --- Derived-item path tests (sheathed art for weapons without bespoke LPC art) ---

test('Hand Crossbow on back emits kind:derived-item using crossbow pose', () => {
  // After Phase A2, pickWeapon('Hand Crossbow') → 'crossbow' (distinct from
  // 'bow'). 'crossbow' has no universal_behind LPC art so it falls through
  // to BACK_DERIVED_POSES.crossbow.
  const c0 = baseChar({
    equipment: { armor: null, mainhand: { name: 'Longsword' }, offhand: null },
    carried: [
      { name: 'Longsword',     slot: 'mainhand', inferredSlot: 'mainhand', twoHanded: false, rarity: 'Common' },
      { name: 'Hand Crossbow', slot: 'overflow', inferredSlot: 'mainhand', twoHanded: false, rarity: 'Common' }
    ]
  });
  const c = assignCarriedSlots(c0, {});
  const plan = buildRenderPlan(c);
  const back = plan.layers.find(l => l.slot === 'back-weapon');
  assert.ok(back);
  assert.strictEqual(back.kind, 'derived-item');
  assert.ok(back.src.endsWith('weapon/crossbow.png'));
  assert.strictEqual(back.pose.rotate, BACK_DERIVED_POSES.crossbow.rotate);
});

test('Halberd on back emits kind:derived-item using halberd pose', () => {
  const c0 = baseChar({
    equipment: { armor: null, mainhand: { name: 'Mace' }, offhand: null },
    carried: [
      { name: 'Mace',    slot: 'mainhand', inferredSlot: 'mainhand', twoHanded: false, rarity: 'Common' },
      { name: 'Halberd', slot: 'overflow', inferredSlot: 'mainhand-twohanded', twoHanded: true, rarity: 'Common' }
    ]
  });
  const c = assignCarriedSlots(c0, {});
  const plan = buildRenderPlan(c);
  const back = plan.layers.find(l => l.slot === 'back-weapon');
  assert.ok(back);
  assert.strictEqual(back.kind, 'derived-item');
  assert.ok(back.src.endsWith('weapon/halberd.png'));
});

test('Longsword on waist emits kind:derived-item using longsword waist pose', () => {
  const c0 = baseChar({
    equipment: { armor: null, mainhand: { name: 'Mace' }, offhand: null },
    carried: [
      { name: 'Mace',      slot: 'mainhand', inferredSlot: 'mainhand', twoHanded: false, rarity: 'Common' },
      { name: 'Longsword', slot: 'overflow', inferredSlot: 'mainhand', twoHanded: false, rarity: 'Common' }
    ]
  });
  // Manually override Longsword to waist (auto-fill would put it on back)
  const c = assignCarriedSlots(c0, { waist: 'Longsword' });
  const plan = buildRenderPlan(c);
  const waist = plan.layers.find(l => l.slot === 'waist-weapon');
  assert.ok(waist);
  assert.strictEqual(waist.kind, 'derived-item');
  assert.ok(waist.src.endsWith('weapon/longsword.png'));
  assert.strictEqual(waist.pose.rotate, 90);
});

test('Bow on waist falls back to procedural rect (no waist pose)', () => {
  const c0 = baseChar({
    equipment: { armor: null, mainhand: { name: 'Longsword' }, offhand: null },
    carried: [
      { name: 'Longsword', slot: 'mainhand', inferredSlot: 'mainhand', twoHanded: false, rarity: 'Common' },
      { name: 'Longbow',   slot: 'overflow', inferredSlot: 'mainhand-twohanded', twoHanded: true, rarity: 'Common' }
    ]
  });
  // Force Longbow to waist (auto would put it on back since it's two-handed)
  const c = assignCarriedSlots(c0, { waist: 'Longbow' });
  const plan = buildRenderPlan(c);
  const waist = plan.layers.find(l => l.slot === 'waist-weapon');
  assert.ok(waist);
  assert.strictEqual(waist.kind, 'rect');
});

test('Longsword on back uses bespoke LPC art (item, not derived-item)', () => {
  // Sanity: when bespoke universal_behind exists, derived path should NOT fire.
  const c0 = baseChar({
    equipment: { armor: null, mainhand: { name: 'Mace' }, offhand: null },
    carried: [
      { name: 'Mace',      slot: 'mainhand', inferredSlot: 'mainhand', twoHanded: false, rarity: 'Common' },
      { name: 'Longsword', slot: 'overflow', inferredSlot: 'mainhand', twoHanded: false, rarity: 'Common' }
    ]
  });
  const c = assignCarriedSlots(c0, {});
  const plan = buildRenderPlan(c);
  const back = plan.layers.find(l => l.slot === 'back-weapon');
  assert.ok(back);
  assert.strictEqual(back.kind, 'item');
  assert.ok(back.src.includes('weapon-back/longsword.png'));
});

// --- Phase B routing tests (armor / shield / helm) ---

test('Phase B: Chain Mail armor → legion torso variant + gauntlets', () => {
  const c = baseChar({ equipment: { armor: { name: 'Chain Mail' } } });
  const plan = buildRenderPlan(c);
  const torso = plan.layers.find(l => l.slot === 'torso');
  const arms = plan.layers.find(l => l.slot === 'arms');
  assert.ok(torso, 'expected torso layer');
  assert.ok(torso.src.includes('legion'), `expected legion torso, got ${torso.src}`);
  assert.ok(arms, 'expected arms layer');
  assert.ok(arms.src.includes('gauntlets'), `expected gauntlets for chain mail, got ${arms.src}`);
});

test('Phase B: Tower Shield → scutum sprite', () => {
  const c = baseChar({ equipment: { offhand: { name: 'Tower Shield' } } });
  const plan = buildRenderPlan(c);
  const off = plan.layers.find(l => l.slot === 'offhand');
  assert.ok(off, 'expected offhand layer');
  assert.ok(off.src.includes('scutum.png'), `expected scutum, got ${off.src}`);
});

test('Phase B: Greathelm name → greathelm sprite', () => {
  const c = baseChar({ equipment: { helm: { name: 'Greathelm' } } });
  const plan = buildRenderPlan(c);
  const helm = plan.layers.find(l => l.slot === 'helm');
  assert.ok(helm, 'expected helm layer');
  assert.ok(helm.src.endsWith('greathelm.png'), `expected greathelm, got ${helm.src}`);
});

test('Phase B: Mail Coif disambiguates from Chain Mail (helm slot stays mail_coif)', () => {
  // Critical: "mail" in armor and helm contexts must not collide.
  const c = baseChar({ equipment: {
    armor: { name: 'Chain Mail' },
    helm:  { name: 'Mail Coif' }
  } });
  const plan = buildRenderPlan(c);
  const torso = plan.layers.find(l => l.slot === 'torso');
  const helm  = plan.layers.find(l => l.slot === 'helm');
  assert.ok(torso.src.includes('legion'), 'Chain Mail must still route to legion torso');
  assert.ok(helm.src.endsWith('mail_coif.png'), `Mail Coif must route to mail_coif helm, got ${helm.src}`);
});

// --- Phase C routing tests (cape colors / backpack / neck variants) ---

test('Phase C: cape color name routes to correct sprite (10 total)', () => {
  for (const [name, expected] of [
    ['Black Cloak', 'black'], ['White Robe of Cloaking', 'white'],
    ['Druid Cloak', 'green'], ['Royal Cape', 'purple'],
    ['Charcoal Cloak', 'charcoal'], ['Navy Cloak', 'navy']
  ]) {
    const c = baseChar({ equipment: { cloak: { name } } });
    const cape = buildRenderPlan(c).layers.find(l => l.slot === 'cape-behind');
    assert.ok(cape, `expected cape layer for "${name}"`);
    assert.ok(cape.src.endsWith(`${expected}.png`), `"${name}" → expected ${expected}.png, got ${cape.src}`);
  }
});

test('Phase C: backpack auto-shows when carrying gear, no back-weapon', () => {
  const c = baseChar({
    classes: [{ name: 'Fighter' }],
    carried: [{ name: 'Rope', slot: 'overflow' }]
  });
  const plan = buildRenderPlan(c);
  const pack = plan.layers.find(l => l.slot === 'backpack');
  const back = plan.layers.find(l => l.slot === 'back-weapon');
  assert.ok(pack, 'expected backpack layer for adventurer with gear');
  assert.ok(pack.src.includes('adventurer'), `expected adventurer pack, got ${pack.src}`);
  assert.strictEqual(back, undefined, 'no back-weapon expected');
});

test('Phase C: backpack hidden when back-weapon present (mutual exclusion)', () => {
  const c = baseChar({
    classes: [{ name: 'Fighter' }],
    carried: [
      { name: 'Greatsword', slot: 'back', inferredSlot: 'mainhand-twohanded', twoHanded: true },
      { name: 'Rope', slot: 'overflow' }
    ]
  });
  const plan = buildRenderPlan(c);
  const pack = plan.layers.find(l => l.slot === 'backpack');
  const back = plan.layers.find(l => l.slot === 'back-weapon');
  assert.strictEqual(pack, undefined, 'backpack must be hidden when back-weapon present');
  assert.ok(back, 'back-weapon expected to render');
});

test('Phase C: scholar pack for casters, adventurer pack for everyone else', () => {
  const wizard = baseChar({ classes: [{ name: 'Wizard' }], carried: [{ name: 'Spellbook', slot: 'overflow' }] });
  const fighter = baseChar({ classes: [{ name: 'Fighter' }], carried: [{ name: 'Rope', slot: 'overflow' }] });
  const wpack = buildRenderPlan(wizard).layers.find(l => l.slot === 'backpack');
  const fpack = buildRenderPlan(fighter).layers.find(l => l.slot === 'backpack');
  assert.ok(wpack.src.includes('scholar'), `wizard expected scholar pack, got ${wpack.src}`);
  assert.ok(fpack.src.includes('adventurer'), `fighter expected adventurer pack, got ${fpack.src}`);
});

test('Phase C: neck variants — gem/chain/charm/cross', () => {
  for (const [name, expected] of [
    ['Holy Symbol', 'amulet'], ['Diamond Necklace', 'gem'],
    ['Gold Chain', 'chain'], ['Lucky Charm', 'charm'],
    ['Ruby Pendant', 'gem'], ['Talisman of Protection', 'charm']
  ]) {
    const c = baseChar({ equipment: { amulet: { name } } });
    const neck = buildRenderPlan(c).layers.find(l => l.slot === 'amulet');
    assert.ok(neck, `expected amulet layer for "${name}"`);
    assert.ok(neck.src.includes(expected), `"${name}" → expected '${expected}' sprite, got ${neck.src}`);
  }
});

// --- Phase D1 multi-direction tests ---

test('Phase D1: south is the default and matches pre-D1 behavior', async () => {
  const m = await import('../js/sprite/lpc-config.js');
  const f = m.getFrame('/assets/lpc/body/male.png');
  assert.strictEqual(f.sy, 128, 'south row should be at sy=128 for 64×64 sheets');
  assert.strictEqual(f.sx, 0);
  assert.strictEqual(f.sw, 64);
  assert.strictEqual(f.sh, 64);
});

test('Phase D1: north/west/east frames target the correct row offsets', async () => {
  const m = await import('../js/sprite/lpc-config.js');
  // Standard 64×64: rows at 0/64/128/192
  assert.strictEqual(m.getFrame('/assets/lpc/body/male.png', 'north').sy, 0);
  assert.strictEqual(m.getFrame('/assets/lpc/body/male.png', 'west').sy, 64);
  assert.strictEqual(m.getFrame('/assets/lpc/body/male.png', 'east').sy, 192);
  // walk_128 (1664×512): rows at 0/128/256/384
  assert.strictEqual(m.getFrame('/assets/lpc/weapon/bow.png', 'north').sy, 0);
  assert.strictEqual(m.getFrame('/assets/lpc/weapon/bow.png', 'west').sy, 128);
  assert.strictEqual(m.getFrame('/assets/lpc/weapon/bow.png', 'south').sy, 256);
  assert.strictEqual(m.getFrame('/assets/lpc/weapon/bow.png', 'east').sy, 384);
});

test('Phase D1: derived back/waist weapons are skipped in non-south directions', () => {
  // Halberd has BACK_DERIVED_POSES but no bespoke universal_behind art.
  // South: emits derived-item layer; non-south: should be omitted entirely.
  const c0 = baseChar({
    equipment: { armor: null, mainhand: { name: 'Mace' }, offhand: null },
    carried: [
      { name: 'Mace',    slot: 'mainhand', inferredSlot: 'mainhand', twoHanded: false },
      { name: 'Halberd', slot: 'overflow', inferredSlot: 'mainhand-twohanded', twoHanded: true }
    ]
  });
  const c = assignCarriedSlots(c0, {});
  const south = buildRenderPlan(c, { direction: 'south' });
  const north = buildRenderPlan(c, { direction: 'north' });
  assert.ok(south.layers.find(l => l.slot === 'back-weapon'), 'south should still emit back-weapon');
  assert.strictEqual(north.layers.find(l => l.slot === 'back-weapon'), undefined,
    'non-south must skip derived back-weapon');
});

// --- Phase D3 face/hair/beard tests ---

test('Phase D3: race-driven hair defaults', () => {
  const cases = [
    [{ race: { name: 'Mountain Dwarf' }}, 'long.png'],
    [{ race: { name: 'High Elf' }},       'long.png'],
    [{ race: { name: 'Halfling' }},       'bedhead.png'],
    [{ race: { name: 'Half-Orc' }},       'spiked.png'],
    [{ race: { name: 'Human' }},          'buzzcut.png'],   // male default
    [{ race: { name: 'Female Human' }},   'long.png']
  ];
  for (const [extras, expectedSrc] of cases) {
    const plan = buildRenderPlan(baseChar(extras));
    const hair = plan.layers.find(l => l.slot === 'hair');
    assert.ok(hair, `expected hair for ${extras.race.name}`);
    assert.ok(hair.src.endsWith(expectedSrc),
      `${extras.race.name}: expected ${expectedSrc}, got ${hair.src}`);
  }
});

test('Phase D3: dragonborn / lizard skip hair and beard (scaled head)', () => {
  const plan = buildRenderPlan(baseChar({ race: { name: 'Dragonborn' }}));
  assert.strictEqual(plan.layers.find(l => l.slot === 'hair'), undefined);
  assert.strictEqual(plan.layers.find(l => l.slot === 'beard'), undefined);
});

test('Phase D3: dwarf male gets winter beard by default', () => {
  const plan = buildRenderPlan(baseChar({ race: { name: 'Mountain Dwarf' }}));
  const beard = plan.layers.find(l => l.slot === 'beard');
  assert.ok(beard, 'expected beard for male dwarf');
  assert.ok(beard.src.endsWith('beard_winter.png'));
});

test('Phase D3: full-face helm hides both hair AND beard', () => {
  const plan = buildRenderPlan(baseChar({
    race: { name: 'Mountain Dwarf' },
    equipment: { helm: { name: 'Greathelm' } }
  }));
  assert.strictEqual(plan.layers.find(l => l.slot === 'hair'), undefined);
  assert.strictEqual(plan.layers.find(l => l.slot === 'beard'), undefined);
});

test('Phase D3: top-of-head helm hides hair but keeps beard visible', () => {
  const plan = buildRenderPlan(baseChar({
    race: { name: 'Mountain Dwarf' },
    equipment: { helm: { name: 'Spangenhelm' } }
  }));
  assert.strictEqual(plan.layers.find(l => l.slot === 'hair'), undefined,
    'top-of-head helm hides hair');
  assert.ok(plan.layers.find(l => l.slot === 'beard'),
    'top-of-head helm should NOT hide beard');
});

test('Phase D3: facial accessories via feat tags', () => {
  const glasses = buildRenderPlan(baseChar({
    visualHints: { featTags: [{ tag: 'glasses' }] }
  }));
  const eyepatch = buildRenderPlan(baseChar({
    visualHints: { featTags: [{ tag: 'eyepatch' }] }
  }));
  assert.ok(glasses.layers.find(l => l.slot === 'facial')?.src.endsWith('glasses_round.png'));
  assert.ok(eyepatch.layers.find(l => l.slot === 'facial')?.src.endsWith('eyepatch.png'));
});

test('Phase D3: eyes default to brown for humans, green for elves', () => {
  const human = buildRenderPlan(baseChar({ race: { name: 'Human' }}));
  const elf = buildRenderPlan(baseChar({ race: { name: 'High Elf' }}));
  assert.ok(human.layers.find(l => l.slot === 'eyes')?.src.endsWith('brown.png'));
  assert.ok(elf.layers.find(l => l.slot === 'eyes')?.src.endsWith('green.png'));
});

// --- Phase D2 direction-aware backpack ---

test('Phase D2: south uses straps art, north/W/E use full pack art', () => {
  const c = baseChar({
    classes: [{ name: 'Fighter' }],
    carried: [{ name: 'Rope', slot: 'overflow' }]
  });
  const south = buildRenderPlan(c, { direction: 'south' });
  const north = buildRenderPlan(c, { direction: 'north' });
  const east = buildRenderPlan(c, { direction: 'east' });

  const ssouth = south.layers.find(l => l.slot === 'backpack');
  const snorth = north.layers.find(l => l.slot === 'backpack');
  const seast  = east.layers.find(l => l.slot === 'backpack');

  assert.ok(ssouth, 'south should render backpack');
  assert.ok(ssouth.src.includes('straps_'), `south expected straps art, got ${ssouth.src}`);

  assert.ok(snorth, 'north should render backpack');
  assert.ok(snorth.src.includes('full_'), `north expected full pack art, got ${snorth.src}`);

  assert.ok(seast.src.includes('full_'), `east expected full pack art, got ${seast.src}`);
});

test('Phase D2: scholar pack distinct from adventurer in non-south view', () => {
  const wizard = baseChar({ classes: [{ name: 'Wizard' }], carried: [{ name: 'Spellbook', slot: 'overflow' }] });
  const fighter = baseChar({ classes: [{ name: 'Fighter' }], carried: [{ name: 'Rope', slot: 'overflow' }] });

  const wnorth = buildRenderPlan(wizard, { direction: 'north' }).layers.find(l => l.slot === 'backpack');
  const fnorth = buildRenderPlan(fighter, { direction: 'north' }).layers.find(l => l.slot === 'backpack');

  assert.ok(wnorth.src.includes('full_scholar'), `wizard expected full_scholar, got ${wnorth.src}`);
  assert.ok(fnorth.src.includes('full_adventurer'), `fighter expected full_adventurer, got ${fnorth.src}`);
});

// --- Phase E1 fuzzy appearance parser tests ---

test('Phase E1: hair color synonyms route to canonical filter', async () => {
  const m = await import('../js/sprite/lpc-config.js');
  const cases = [
    ['Auburn',          'red'],
    ['Raven',           'black'],
    ['Salt-and-pepper', 'gray'],
    ['Platinum blonde', 'white'],   // 'platinum' wins over 'blonde'
    ['Chestnut brown',  'brown'],
    ['Strawberry',      'blonde'],
    ['Silver',          'gray']
  ];
  for (const [text, expectedColorKey] of cases) {
    const c = { race: { name: 'Human' }, classes: [], appearance: { hair: text } };
    const plan = m.buildRenderPlan(c);
    const hair = plan.layers.find(l => l.slot === 'hair');
    assert.ok(hair, `hair layer expected for "${text}"`);
    const expectedFilter = m.HAIR_COLOR_FILTERS[expectedColorKey];
    assert.strictEqual(hair.filter, expectedFilter,
      `"${text}" → expected filter for ${expectedColorKey}, got ${hair.filter}`);
  }
});

test('Phase E1: hair style words route to sprite key', async () => {
  const m = await import('../js/sprite/lpc-config.js');
  const cases = [
    ['Bald',                'balding.png'],
    ['Buzzcut',             'buzzcut.png'],
    ['Shoulder-length',     'bob.png'],
    ['Mohawk',              'spiked.png'],
    ['Messy unkempt hair',  'bedhead.png'],
    ['Waist-length flowing','long.png'],
    ['Curly afro',          'afro.png']
  ];
  for (const [text, expectedSrc] of cases) {
    const c = { race: { name: 'Human' }, classes: [], appearance: { hair: text } };
    const hair = m.buildRenderPlan(c).layers.find(l => l.slot === 'hair');
    assert.ok(hair, `hair expected for "${text}"`);
    assert.ok(hair.src.endsWith(expectedSrc),
      `"${text}" → expected ${expectedSrc}, got ${hair.src}`);
  }
});

test('Phase E1: eye color synonyms route correctly', async () => {
  const m = await import('../js/sprite/lpc-config.js');
  const cases = [
    ['Hazel',    'brown.png'],
    ['Emerald',  'green.png'],
    ['Sapphire', 'blue.png'],
    ['Cobalt',   'blue.png'],
    ['Violet',   'gray.png']   // closest available
  ];
  for (const [text, expectedSrc] of cases) {
    const c = { race: { name: 'Human' }, classes: [], appearance: { eyes: text } };
    const eyes = m.buildRenderPlan(c).layers.find(l => l.slot === 'eyes');
    assert.ok(eyes.src.endsWith(expectedSrc), `"${text}" → ${expectedSrc}, got ${eyes.src}`);
  }
});

test('Phase E1: skin synonyms override race default', async () => {
  const m = await import('../js/sprite/lpc-config.js');
  // Human normally → 'light'. With 'Tanned' description → 'tan'.
  const c = { race: { name: 'Human' }, classes: [], appearance: { skin: 'Tanned with freckles' } };
  assert.strictEqual(m.inferSkinTone(c), 'tan');
  // Ebony → dark
  const c2 = { race: { name: 'Human' }, classes: [], appearance: { skin: 'Ebony' } };
  assert.strictEqual(m.inferSkinTone(c2), 'dark');
});

test('Phase E1: build keywords set bodyWidth', async () => {
  const m = await import('../js/sprite/lpc-config.js');
  const burly = m.buildRenderPlan({ race: { name: 'Human' }, classes: [], appearance: { build: 'Burly' } });
  const wiry  = m.buildRenderPlan({ race: { name: 'Human' }, classes: [], appearance: { build: 'Wiry' } });
  const none  = m.buildRenderPlan({ race: { name: 'Human' }, classes: [], appearance: {} });
  assert.strictEqual(burly.bodyWidth, 'broad');
  assert.strictEqual(wiry.bodyWidth, 'thin');
  assert.strictEqual(none.bodyWidth, 'normal');
});

test('Phase E1: height+weight BMI heuristic when no build keyword', async () => {
  const m = await import('../js/sprite/lpc-config.js');
  const big = m.buildRenderPlan({ race: { name: 'Human' }, classes: [], appearance: { height: "6'4", weight: '260 lb' } });
  const small = m.buildRenderPlan({ race: { name: 'Human' }, classes: [], appearance: { height: "5'2", weight: '105 lb' } });
  assert.strictEqual(big.bodyWidth, 'broad');
  assert.strictEqual(small.bodyWidth, 'thin');
});

test('Phase E1: elderly human ages bias hair toward gray', async () => {
  const m = await import('../js/sprite/lpc-config.js');
  const young = m.buildRenderPlan({ race: { name: 'Human' }, classes: [], appearance: { age: '25' } });
  const old   = m.buildRenderPlan({ race: { name: 'Human' }, classes: [], appearance: { age: '70' } });
  const yhair = young.layers.find(l => l.slot === 'hair');
  const ohair = old.layers.find(l => l.slot === 'hair');
  // Young: brown (default, no filter); old: gray filter
  assert.strictEqual(yhair.filter, m.HAIR_COLOR_FILTERS.brown);
  assert.strictEqual(ohair.filter, m.HAIR_COLOR_FILTERS.gray);
});

test('Phase E1: race-aware elderly threshold for elves', async () => {
  const m = await import('../js/sprite/lpc-config.js');
  // 200-year-old elf is still middle-aged (elf elderly threshold is 500)
  const middle = m.buildRenderPlan({ race: { name: 'High Elf' }, classes: [], appearance: { age: '200' } });
  // 600-year-old elf IS elderly
  const ancient = m.buildRenderPlan({ race: { name: 'High Elf' }, classes: [], appearance: { age: '600' } });
  const mhair = middle.layers.find(l => l.slot === 'hair');
  const ahair = ancient.layers.find(l => l.slot === 'hair');
  assert.strictEqual(mhair.filter, m.HAIR_COLOR_FILTERS.blonde);  // race default
  assert.strictEqual(ahair.filter, m.HAIR_COLOR_FILTERS.gray);    // age bias
});

test('Phase E1: explicit character.hair beats parsed appearance text', async () => {
  const m = await import('../js/sprite/lpc-config.js');
  // Appearance says "long brown", but explicit hair.style='spiked' wins
  const c = {
    race: { name: 'Human' }, classes: [],
    appearance: { hair: 'Long brown' },
    hair: { style: 'spiked', color: 'red' }
  };
  const hair = m.buildRenderPlan(c).layers.find(l => l.slot === 'hair');
  assert.ok(hair.src.endsWith('spiked.png'), `expected spiked, got ${hair.src}`);
  assert.strictEqual(hair.filter, m.HAIR_COLOR_FILTERS.red);
});

// --- Phase E4 inspiration glyph ---

test('Phase E4: inspiration=true emits glyph layer', () => {
  const c = baseChar({ inspiration: true });
  const plan = buildRenderPlan(c);
  const glyph = plan.layers.find(l => l.kind === 'glyph');
  assert.ok(glyph, 'expected glyph layer when inspiration=true');
  assert.strictEqual(glyph.glyph, 'star');
  assert.strictEqual(glyph.color, '#fbbf24');
  assert.deepStrictEqual(glyph.position, { x: 32, y: 4 });
});

test('Phase E4: no inspiration glyph when flag absent or false', () => {
  const off = buildRenderPlan(baseChar({ inspiration: false }));
  const missing = buildRenderPlan(baseChar({}));
  assert.strictEqual(off.layers.find(l => l.kind === 'glyph'), undefined);
  assert.strictEqual(missing.layers.find(l => l.kind === 'glyph'), undefined);
});

// --- Phase F2 background defaults ---

test('Phase F2: Acolyte → cross amulet (Holy Symbol default)', () => {
  const c = baseChar({ background: 'Acolyte' });
  const plan = buildRenderPlan(c);
  const amulet = plan.layers.find(l => l.slot === 'amulet');
  assert.ok(amulet, 'Acolyte should produce amulet layer');
  assert.ok(amulet.src.endsWith('amulet_male.png'), `expected cross amulet, got ${amulet.src}`);
});

test('Phase F2: Sage → glasses facial', () => {
  const plan = buildRenderPlan(baseChar({ background: 'Sage' }));
  const facial = plan.layers.find(l => l.slot === 'facial');
  assert.ok(facial?.src.endsWith('glasses_round.png'));
});

test('Phase F2: Criminal → eyepatch', () => {
  const plan = buildRenderPlan(baseChar({ background: 'Criminal' }));
  const facial = plan.layers.find(l => l.slot === 'facial');
  assert.ok(facial?.src.endsWith('eyepatch.png'));
});

test('Phase F2: Hermit → quarterstaff in empty mainhand', () => {
  const plan = buildRenderPlan(baseChar({ background: 'Hermit' }));
  const main = plan.layers.find(l => l.slot === 'mainhand');
  assert.ok(main, 'Hermit should auto-equip a quarterstaff');
  assert.ok(main.src.endsWith('club.png'), 'Quarterstaff routes to club sprite');
});

test('Phase F2: Hermit does NOT override an explicit mainhand', () => {
  const plan = buildRenderPlan(baseChar({
    background: 'Hermit',
    equipment: { mainhand: { name: 'Longsword' } }
  }));
  const main = plan.layers.find(l => l.slot === 'mainhand');
  assert.ok(main.src.endsWith('longsword.png'),
    `explicit Longsword must beat Hermit default, got ${main.src}`);
});

test('Phase F2: Outlander/Soldier set default cape', () => {
  const out = buildRenderPlan(baseChar({ background: 'Outlander' }));
  const sol = buildRenderPlan(baseChar({ background: 'Soldier' }));
  assert.ok(out.layers.find(l => l.slot === 'cape-behind')?.src.endsWith('brown.png'));
  assert.ok(sol.layers.find(l => l.slot === 'cape-behind')?.src.endsWith('red.png'));
});

test('Phase F2: explicit equipment beats background default', () => {
  // Acolyte default = Holy Symbol (cross). Override with Diamond Necklace → gem.
  const plan = buildRenderPlan(baseChar({
    background: 'Acolyte',
    equipment: { amulet: { name: 'Diamond Necklace' } }
  }));
  const amulet = plan.layers.find(l => l.slot === 'amulet');
  assert.ok(amulet.src.endsWith('gem_male.png'),
    `explicit gem necklace must win over Acolyte default, got ${amulet.src}`);
});

test('Phase F2: unknown background leaves equipment untouched', () => {
  const plan = buildRenderPlan(baseChar({ background: 'Far Traveler' }));
  // No defaults registered — no facial, no amulet, no cape
  assert.strictEqual(plan.layers.find(l => l.slot === 'facial'), undefined);
  assert.strictEqual(plan.layers.find(l => l.slot === 'amulet'), undefined);
  assert.strictEqual(plan.layers.find(l => l.slot === 'cape-behind'), undefined);
});

// --- Phase F4 lifestyle defaults ---

test('Phase F4: Squalid auto-equips a tattered cape', () => {
  const plan = buildRenderPlan(baseChar({ lifestyle: 'Squalid' }));
  const cape = plan.layers.find(l => l.slot === 'cape-behind');
  assert.ok(cape, 'Squalid should produce cape layer');
  assert.ok(cape.src.includes('tattered_'),
    `expected tattered variant, got ${cape.src}`);
});

test('Phase F4: Wealthy auto-equips gem amulet', () => {
  const plan = buildRenderPlan(baseChar({ lifestyle: 'Wealthy' }));
  const amulet = plan.layers.find(l => l.slot === 'amulet');
  assert.ok(amulet?.src.endsWith('gem_male.png'));
});

test('Phase F4: Aristocratic gets gem amulet AND purple cape', () => {
  const plan = buildRenderPlan(baseChar({ lifestyle: 'Aristocratic' }));
  const amulet = plan.layers.find(l => l.slot === 'amulet');
  const cape = plan.layers.find(l => l.slot === 'cape-behind');
  assert.ok(amulet?.src.endsWith('gem_male.png'));
  assert.ok(cape?.src.endsWith('purple.png'));
});

test('Phase F4: Soldier+Squalid → tattered cape (lifestyle flips background cape)', () => {
  const plan = buildRenderPlan(baseChar({
    background: 'Soldier',     // → red cape default
    lifestyle: 'Squalid'        // → flips cape to tattered variant
  }));
  const cape = plan.layers.find(l => l.slot === 'cape-behind');
  assert.ok(cape?.src.includes('tattered_'),
    `Soldier+Squalid should produce tattered cape, got ${cape?.src}`);
});

test('Phase F4: Modest/Comfortable/Poor produce no lifestyle override', () => {
  for (const lf of ['Modest', 'Comfortable', 'Poor']) {
    const plan = buildRenderPlan(baseChar({ lifestyle: lf }));
    assert.strictEqual(plan.layers.find(l => l.slot === 'cape-behind'), undefined,
      `${lf} should not auto-equip a cape`);
    assert.strictEqual(plan.layers.find(l => l.slot === 'amulet'), undefined,
      `${lf} should not auto-equip an amulet`);
  }
});

test('Phase F4: explicit equipment.cloak gets tattered flip when Squalid', () => {
  const plan = buildRenderPlan(baseChar({
    lifestyle: 'Squalid',
    equipment: { cloak: { name: 'Black Cloak' } }
  }));
  const cape = plan.layers.find(l => l.slot === 'cape-behind');
  // Black should map to tattered_charcoal (closest tattered match)
  assert.ok(cape?.src.endsWith('tattered_charcoal.png'),
    `Black + Squalid → tattered_charcoal, got ${cape?.src}`);
});

// --- Phase F3 feat visual library ---

test('Phase F3: Tough feat → bodyWidth=broad', () => {
  const plan = buildRenderPlan(baseChar({ feats: ['Tough'] }));
  assert.strictEqual(plan.bodyWidth, 'broad');
});

test('Phase F3: Lucky feat → charm amulet (when no amulet equipped)', () => {
  const plan = buildRenderPlan(baseChar({ feats: ['Lucky'] }));
  const amulet = plan.layers.find(l => l.slot === 'amulet');
  assert.ok(amulet?.src.endsWith('charm_male.png'));
});

test('Phase F3: weapon-implying feats fill empty mainhand', () => {
  const cases = [
    [['Polearm Master'],      'halberd.png'],
    [['Crossbow Expert'],     'crossbow.png'],
    [['Great Weapon Master'], 'longsword_alt.png'],
    [['Defensive Duelist'],   'rapier.png']
  ];
  for (const [feats, expectedSrc] of cases) {
    const plan = buildRenderPlan(baseChar({ feats }));
    const main = plan.layers.find(l => l.slot === 'mainhand');
    assert.ok(main?.src.endsWith(expectedSrc),
      `[${feats[0]}] expected ${expectedSrc}, got ${main?.src}`);
  }
});

test('Phase F3: Heavy Armor Master fills empty armor with plate', () => {
  const plan = buildRenderPlan(baseChar({ feats: ['Heavy Armor Master'] }));
  const torso = plan.layers.find(l => l.slot === 'torso');
  const arms = plan.layers.find(l => l.slot === 'arms');
  assert.ok(torso?.src.endsWith('plate_male.png'));
  assert.ok(arms?.src.includes('gauntlets'),
    'plate armor should also trigger gauntlets via existing pickArms');
});

test('Phase F3: Sharpshooter feat → quiver visible (via featTag path)', () => {
  const plan = buildRenderPlan(baseChar({ feats: ['Sharpshooter'] }));
  const quiver = plan.layers.find(l => l.slot === 'quiver');
  assert.ok(quiver, 'Sharpshooter should produce a quiver layer');
});

test('Phase F3: explicit equipment beats feat default', () => {
  // Polearm Master would fill halberd; explicit Longsword wins
  const plan = buildRenderPlan(baseChar({
    feats: ['Polearm Master'],
    equipment: { mainhand: { name: 'Longsword' } }
  }));
  const main = plan.layers.find(l => l.slot === 'mainhand');
  assert.ok(main?.src.endsWith('longsword.png'),
    `explicit Longsword must beat Polearm Master, got ${main?.src}`);
});

test('Phase F3: multiple feats compose (Tough + Lucky + GWM)', () => {
  const plan = buildRenderPlan(baseChar({
    feats: ['Tough', 'Lucky', 'Great Weapon Master']
  }));
  const main = plan.layers.find(l => l.slot === 'mainhand');
  const amulet = plan.layers.find(l => l.slot === 'amulet');
  assert.strictEqual(plan.bodyWidth, 'broad', 'Tough → broad');
  assert.ok(amulet?.src.endsWith('charm_male.png'), 'Lucky → charm');
  assert.ok(main?.src.endsWith('longsword_alt.png'), 'GWM → greatsword');
});

test('Phase F3: feat order matters when two feats both want mainhand', () => {
  // Polearm Master (first) wins over Great Weapon Master (second)
  const plan = buildRenderPlan(baseChar({
    feats: ['Polearm Master', 'Great Weapon Master']
  }));
  const main = plan.layers.find(l => l.slot === 'mainhand');
  assert.ok(main?.src.endsWith('halberd.png'),
    `first-feat-wins: Polearm Master should fill mainhand first, got ${main?.src}`);
});

test('Phase F3: unknown feat name produces no override', () => {
  const plan = buildRenderPlan(baseChar({
    feats: ["Hero's Journey Boon", 'Resilient', 'Dark Bargain']
  }));
  // None of these are in FEAT_DEFAULTS — no equipment fills
  assert.strictEqual(plan.layers.find(l => l.slot === 'mainhand'), undefined);
  assert.strictEqual(plan.layers.find(l => l.slot === 'amulet'), undefined);
  assert.strictEqual(plan.bodyWidth, 'normal');
});

// --- Phase F1 subclass accents ---

test('Phase F1: D&DB-prefixed subclass names canonicalize', () => {
  const cases = [
    ['Path of the Berserker',     'red'],
    ['School of Evocation',        'red'],
    ['Oath of Vengeance',          'charcoal'],
    ['College of Lore',            'navy'],
    ['Twilight Domain',            'purple'],
    ['Circle of the Land',         'green'],
    ['Way of the Open Hand',       'white'],
    ['Draconic Bloodline',         'red'],
    ['The Fiend',                  'red'],
    ['School of Necromancy',       'black']
  ];
  for (const [subclass, expectedColor] of cases) {
    const plan = buildRenderPlan(baseChar({
      classes: [{ name: 'Wizard', level: 1, subclass }]
    }));
    const cape = plan.layers.find(l => l.slot === 'cape-behind');
    assert.ok(cape, `expected cape for ${subclass}`);
    assert.ok(cape.src.endsWith(`${expectedColor}.png`),
      `${subclass} → expected ${expectedColor}, got ${cape.src}`);
  }
});

test('Phase F1: subclass aura color flows through plan', () => {
  const plan = buildRenderPlan(baseChar({
    classes: [{ name: 'Cleric', level: 1, subclass: 'Twilight Domain' }]
  }));
  assert.strictEqual(plan.subclassAura, '#7c3aed');
});

test('Phase F1: explicit cloak beats subclass cape default', () => {
  const plan = buildRenderPlan(baseChar({
    classes: [{ name: 'Wizard', level: 1, subclass: 'School of Evocation' }],
    equipment: { cloak: { name: 'Blue Cloak' } }
  }));
  const cape = plan.layers.find(l => l.slot === 'cape-behind');
  assert.ok(cape.src.endsWith('blue.png'),
    `explicit Blue Cloak should beat Evocation default red, got ${cape.src}`);
  // But the aura still applies (orthogonal channel)
  assert.strictEqual(plan.subclassAura, '#fb923c');
});

test('Phase F1: subclass with featTags adds glasses (Lore/Knowledge)', () => {
  const lore = buildRenderPlan(baseChar({
    classes: [{ name: 'Bard', level: 1, subclass: 'College of Lore' }]
  }));
  const knowledge = buildRenderPlan(baseChar({
    classes: [{ name: 'Cleric', level: 1, subclass: 'Knowledge Domain' }]
  }));
  assert.ok(lore.layers.find(l => l.slot === 'facial')?.src.endsWith('glasses_round.png'));
  assert.ok(knowledge.layers.find(l => l.slot === 'facial')?.src.endsWith('glasses_round.png'));
});

test('Phase F1: unknown subclass produces no accent (graceful fallback)', () => {
  const plan = buildRenderPlan(baseChar({
    classes: [{ name: 'Warlock', level: 1, subclass: 'Some Homebrew Patron' }]
  }));
  assert.strictEqual(plan.layers.find(l => l.slot === 'cape-behind'), undefined);
  assert.strictEqual(plan.subclassAura, null);
});

test('Phase F1: substring fallback matches non-PHB-prefixed subclasses', () => {
  // "Path of Wild Magic" (Tasha's) → matches 'wild magic' substring
  const plan = buildRenderPlan(baseChar({
    classes: [{ name: 'Barbarian', level: 1, subclass: 'Path of Wild Magic' }]
  }));
  const cape = plan.layers.find(l => l.slot === 'cape-behind');
  assert.ok(cape?.src.endsWith('purple.png'));
  assert.strictEqual(plan.subclassAura, '#ec4899');
});

test('Phase F1: subclass aura composes with Squalid lifestyle (cape flips tattered, aura stays)', () => {
  const plan = buildRenderPlan(baseChar({
    classes: [{ name: 'Wizard', level: 1, subclass: 'School of Necromancy' }],
    lifestyle: 'Squalid'
  }));
  const cape = plan.layers.find(l => l.slot === 'cape-behind');
  // Necromancy default is black cape; Squalid flips to tattered_charcoal
  assert.ok(cape?.src.endsWith('tattered_charcoal.png'),
    `expected tattered_charcoal, got ${cape?.src}`);
  // Aura color preserved through the flip
  assert.strictEqual(plan.subclassAura, '#7c2d12');
});

// --- Phase J appearance-overrides integration ---

test('Phase J: applyAppearanceOverrides sets hair style + color on plan', async () => {
  const { applyAppearanceOverrides } = await import('../js/sprite/appearance-overrides.js');
  const { HAIR_COLOR_FILTERS } = await import('../js/sprite/lpc-config.js');
  const c = baseChar({ race: { name: 'Human' }});
  applyAppearanceOverrides(c, { hairStyle: 'afro', hairColor: 'red' });
  const plan = buildRenderPlan(c);
  const hair = plan.layers.find(l => l.slot === 'hair');
  assert.ok(hair?.src.endsWith('afro.png'), `expected afro, got ${hair?.src}`);
  assert.strictEqual(hair.filter, HAIR_COLOR_FILTERS.red);
});

test('Phase J: applyAppearanceOverrides eye color override', async () => {
  const { applyAppearanceOverrides } = await import('../js/sprite/appearance-overrides.js');
  const c = baseChar({ race: { name: 'Human' }});
  applyAppearanceOverrides(c, { eyeColor: 'green' });
  const eyes = buildRenderPlan(c).layers.find(l => l.slot === 'eyes');
  assert.ok(eyes?.src.endsWith('green.png'));
});

test('Phase J: beardStyle="none" suppresses race-default beard', async () => {
  const { applyAppearanceOverrides } = await import('../js/sprite/appearance-overrides.js');
  // Mountain Dwarf would default to a winter beard
  const c = baseChar({ race: { name: 'Mountain Dwarf' }});
  applyAppearanceOverrides(c, { beardStyle: 'none' });
  const beard = buildRenderPlan(c).layers.find(l => l.slot === 'beard');
  assert.strictEqual(beard, undefined, 'beard should be suppressed by explicit "none"');
});

test('Phase J: facial="none" suppresses feat-tag glasses', async () => {
  const { applyAppearanceOverrides } = await import('../js/sprite/appearance-overrides.js');
  // Sage background would add glasses
  const c = baseChar({ background: 'Sage' });
  applyAppearanceOverrides(c, { facial: 'none' });
  const facial = buildRenderPlan(c).layers.find(l => l.slot === 'facial');
  assert.strictEqual(facial, undefined, 'facial="none" should suppress glasses');
});

test('Phase J: inspiration override flips glyph layer on/off', async () => {
  const { applyAppearanceOverrides } = await import('../js/sprite/appearance-overrides.js');
  const c1 = baseChar();
  applyAppearanceOverrides(c1, { inspiration: true });
  assert.ok(buildRenderPlan(c1).layers.find(l => l.kind === 'glyph'),
    'inspiration=true should emit glyph');
  const c2 = baseChar({ inspiration: true });
  applyAppearanceOverrides(c2, { inspiration: false });
  assert.strictEqual(buildRenderPlan(c2).layers.find(l => l.kind === 'glyph'), undefined,
    'inspiration=false should override import-time true');
});

test('Phase J: skinTone override beats race default', async () => {
  const { applyAppearanceOverrides } = await import('../js/sprite/appearance-overrides.js');
  // High Elf → pale by default
  const c = baseChar({ race: { name: 'High Elf' }});
  applyAppearanceOverrides(c, { skinTone: 'dark' });
  const plan = buildRenderPlan(c);
  const body = plan.layers.find(l => l.slot === 'body');
  // body filter should match dark, not pale
  const { SKIN_TONES } = await import('../js/sprite/lpc-config.js');
  assert.strictEqual(body.filter, SKIN_TONES.dark);
});

test('Phase J: bodyWidth override flows into plan', async () => {
  const { applyAppearanceOverrides } = await import('../js/sprite/appearance-overrides.js');
  const c = baseChar();
  applyAppearanceOverrides(c, { bodyWidth: 'broad' });
  assert.strictEqual(buildRenderPlan(c).bodyWidth, 'broad');
});

test('Phase J: empty override leaves character unchanged', async () => {
  const { applyAppearanceOverrides } = await import('../js/sprite/appearance-overrides.js');
  const c = baseChar({ race: { name: 'Mountain Dwarf' }});
  const before = JSON.stringify(buildRenderPlan(c).layers.map(l => l.src));
  applyAppearanceOverrides(c, {});
  const after = JSON.stringify(buildRenderPlan(c).layers.map(l => l.src));
  assert.strictEqual(before, after, 'empty override must not change render');
});

// --- Phase E2 HP state ---

test('Phase E2: healthy HP produces no extra glyphs or filters beyond skin', () => {
  const c = baseChar({ hp: { current: 50, max: 50 } });
  const plan = buildRenderPlan(c);
  assert.strictEqual(plan.hpState, 'healthy');
  assert.strictEqual(plan.layers.find(l => l.kind === 'glyph' && l.glyph === 'scratch'), undefined);
  assert.strictEqual(plan.layers.find(l => l.kind === 'glyph' && l.glyph === 'skull'), undefined);
});

test('Phase E2: wounded HP (<25%) emits scratch glyph and tints body', () => {
  const c = baseChar({ hp: { current: 5, max: 50 } });
  const plan = buildRenderPlan(c);
  assert.strictEqual(plan.hpState, 'wounded');
  const scratch = plan.layers.find(l => l.kind === 'glyph' && l.glyph === 'scratch');
  assert.ok(scratch, 'wounded should emit scratch glyph');
  // Body filter should include the wounded sepia tint
  const body = plan.layers.find(l => l.slot === 'body');
  assert.ok(body.filter && body.filter.includes('sepia'), `expected sepia in body filter, got ${body.filter}`);
});

test('Phase E2: HP=0 emits skull glyph', () => {
  const plan = buildRenderPlan(baseChar({ hp: { current: 0, max: 50 } }));
  assert.strictEqual(plan.hpState, 'down');
  assert.ok(plan.layers.find(l => l.kind === 'glyph' && l.glyph === 'skull'));
});

test('Phase E2: 3 failed death saves forces down state', () => {
  const plan = buildRenderPlan(baseChar({
    hp: { current: 20, max: 50 },
    deathSaves: { failures: 3 }
  }));
  assert.strictEqual(plan.hpState, 'down');
});

test('Phase E2: temp HP shimmer aura emits when temp > 0', () => {
  const plan = buildRenderPlan(baseChar({ hp: { current: 45, max: 50, temp: 8 } }));
  assert.strictEqual(plan.tempHpAura, '#60a5fa');
});

// --- Phase E3 conditions ---

test('Phase E3: poisoned tints body green and adds drip glyph', () => {
  const plan = buildRenderPlan(baseChar({ conditions: ['poisoned'] }));
  const body = plan.layers.find(l => l.slot === 'body');
  assert.ok(body.filter.includes('hue-rotate(70deg)'), `expected green hue in body filter, got ${body.filter}`);
  const drip = plan.layers.find(l => l.kind === 'glyph' && l.glyph === 'drip');
  assert.ok(drip, 'poisoned should emit drip glyph');
});

test('Phase E3: multiple conditions stack glyphs but use highest-priority filter', () => {
  // poisoned (priority 4) and charmed (priority 6) → body filter from poisoned,
  // glyphs from both
  const plan = buildRenderPlan(baseChar({ conditions: ['charmed', 'poisoned'] }));
  const body = plan.layers.find(l => l.slot === 'body');
  assert.ok(body.filter.includes('hue-rotate(70deg)'),
    `body filter must be poisoned (higher priority), got ${body.filter}`);
  const heart = plan.layers.find(l => l.kind === 'glyph' && l.glyph === 'heart');
  const drip = plan.layers.find(l => l.kind === 'glyph' && l.glyph === 'drip');
  assert.ok(heart && drip, 'both glyphs should stack additively');
});

test('Phase E3: invisible condition applies opacity filter to body', () => {
  const plan = buildRenderPlan(baseChar({ conditions: ['invisible'] }));
  const body = plan.layers.find(l => l.slot === 'body');
  assert.ok(body.filter.includes('opacity'), `expected opacity filter, got ${body.filter}`);
});

test('Phase E3: unknown condition is silently ignored', () => {
  // Should produce no error and no extra layers
  const plan = buildRenderPlan(baseChar({ conditions: ['flatulent'] }));
  assert.strictEqual(plan.hpState, 'healthy');
  assert.strictEqual(plan.layers.find(l => l.kind === 'glyph' && l.glyph !== 'star'), undefined);
});

// --- Phase H concentration ---

test('Phase H: known concentration spell sets aura color', () => {
  const cases = [
    ['Bless',           '#fbbf24'],
    ['Mage Armor',      '#3b82f6'],
    ['Hex',             '#7c3aed'],
    ['Hunter\'s Mark',  '#dc2626'],
    ['Haste',           '#facc15']
  ];
  for (const [spell, expected] of cases) {
    const plan = buildRenderPlan(baseChar({ concentration: spell }));
    assert.strictEqual(plan.concentrationAura, expected, `${spell} expected ${expected}, got ${plan.concentrationAura}`);
  }
});

test('Phase H: unknown concentration spell falls back to generic glow', () => {
  const plan = buildRenderPlan(baseChar({ concentration: 'Wibble of Wobbling' }));
  assert.strictEqual(plan.concentrationAura, '#e5e7eb');
});

test('Phase H: no concentration → no aura', () => {
  const a = buildRenderPlan(baseChar({}));
  const b = buildRenderPlan(baseChar({ concentration: '' }));
  const c = buildRenderPlan(baseChar({ concentration: null }));
  assert.strictEqual(a.concentrationAura, null);
  assert.strictEqual(b.concentrationAura, null);
  assert.strictEqual(c.concentrationAura, null);
});

test('Phase H: concentration substring match for variants', () => {
  // "Hunter's Mark Modified" should still hit hunter's mark
  const plan = buildRenderPlan(baseChar({ concentration: "Modified Hunter's Mark" }));
  assert.strictEqual(plan.concentrationAura, '#dc2626');
});

// --- Phase E2/E3/H combined with appearance-overrides ---

test('Phase H+J: applyAppearanceOverrides sets concentration through plan', async () => {
  const { applyAppearanceOverrides } = await import('../js/sprite/appearance-overrides.js');
  const c = baseChar();
  applyAppearanceOverrides(c, { concentration: 'Bless' });
  assert.strictEqual(buildRenderPlan(c).concentrationAura, '#fbbf24');
});

test('Phase E2+J: HP override clamps to character.hp.max', async () => {
  const { applyAppearanceOverrides } = await import('../js/sprite/appearance-overrides.js');
  const c = baseChar({ hp: { current: 50, max: 50 } });
  applyAppearanceOverrides(c, { hpCurrent: 999 });    // over max
  assert.strictEqual(c.hp.current, 50);
  applyAppearanceOverrides(c, { hpCurrent: -10 });    // under zero
  assert.strictEqual(c.hp.current, 0);
});
