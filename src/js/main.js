import { renderSprite } from './sprite/compositor.js';
import { loadOverrides, saveOverrides, assignCarriedSlots } from './sprite/slot-overrides.js';
import { loadAppearance, saveAppearance, applyAppearanceOverrides } from './sprite/appearance-overrides.js';

const $ = (id) => document.getElementById(id);
const status = $('status');
const result = $('result');
const canvas = $('sprite-canvas');

const tabs = document.querySelectorAll('.tab');
const panels = document.querySelectorAll('.tab-panel');

tabs.forEach(t => {
  t.addEventListener('click', () => {
    tabs.forEach(x => x.classList.toggle('active', x === t));
    panels.forEach(p => p.classList.toggle('hidden', p.dataset.panel !== t.dataset.tab));
  });
});

$('url-submit').addEventListener('click', () => importByUrl());
$('json-submit').addEventListener('click', () => importByJson());

$('url-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') importByUrl();
});

$('skin-select').addEventListener('change', () => {
  const newTone = $('skin-select').value;
  currentAppearance = { ...currentAppearance, skinTone: newTone };
  if (originalCharacter?.id) saveAppearance(originalCharacter.id, currentAppearance);
  rerender();
});

document.addEventListener('change', (e) => {
  if (!e.target.matches('#slot-picker select[data-slot]')) return;
  const slot = e.target.dataset.slot;
  const value = e.target.value || null;
  currentOverrides = { ...currentOverrides, [slot]: value };
  if (originalCharacter?.id) saveOverrides(originalCharacter.id, currentOverrides);
  if (!originalCharacter) return;

  const slotEffective = assignCarriedSlots(originalCharacter, currentOverrides);
  renderEquipment(slotEffective.equipment, slotEffective.carried);
  populateSlotPicker(slotEffective);
  rerender();
});

let currentCharacter = null;     // post-override clone (rendered)
let originalCharacter = null;    // raw parsed character (single source of truth)
let currentOverrides = {};       // { mainhand: 'Shortsword', back: null, ... }
let currentAppearance = {};      // Phase J — hair/eyes/beard/facial/build/inspiration
let currentDirection = 'south';  // Phase D1 — N/W/S/E render direction

// Phase J — appearance picker change handler. Reads any data-app select,
// writes to currentAppearance, persists, re-renders.
document.addEventListener('change', (e) => {
  if (!e.target.matches('#appearance-picker [data-app]')) return;
  const field = e.target.dataset.app;
  const value = e.target.type === 'checkbox' ? e.target.checked : (e.target.value || undefined);
  currentAppearance = { ...currentAppearance, [field]: value };
  // Drop undefined keys so the saved payload stays compact
  if (value === undefined || value === '' || value === false) delete currentAppearance[field];
  if (originalCharacter?.id) saveAppearance(originalCharacter.id, currentAppearance);
  rerender();
});

// Direction buttons (Phase D1)
document.addEventListener('click', (e) => {
  if (!e.target.matches('#appearance-picker .dir-btn')) return;
  currentDirection = e.target.dataset.dir;
  document.querySelectorAll('#appearance-picker .dir-btn').forEach(b =>
    b.classList.toggle('active', b === e.target));
  rerender();
});

// Phase E3 — Condition checkboxes
document.addEventListener('change', (e) => {
  if (!e.target.matches('[data-condition]')) return;
  const conditions = [...document.querySelectorAll('[data-condition]:checked')].map(el => el.dataset.condition);
  currentAppearance = { ...currentAppearance, conditions };
  if (originalCharacter?.id) saveAppearance(originalCharacter.id, currentAppearance);
  rerender();
});

// Phase E2 — HP slider
document.addEventListener('input', (e) => {
  if (e.target.id !== 'hp-range') return;
  const hp = Number(e.target.value);
  currentAppearance = { ...currentAppearance, hpCurrent: hp };
  const max = Number(e.target.max);
  const display = document.getElementById('hp-display');
  if (display) display.textContent = `${hp} / ${max}`;
  if (originalCharacter?.id) saveAppearance(originalCharacter.id, currentAppearance);
  rerender();
});

function rerender() {
  if (!originalCharacter) return;
  const slotEffective = assignCarriedSlots(originalCharacter, currentOverrides);
  // Clone before applying appearance overrides so we don't mutate the source
  const c = JSON.parse(JSON.stringify(slotEffective));
  applyAppearanceOverrides(c, currentAppearance);
  currentCharacter = c;
  renderSprite(canvas, c, { scale: 6, direction: currentDirection });
}

async function importByUrl() {
  const value = $('url-input').value.trim();
  if (!value) return setStatus('Enter a share URL or character id.', 'error');
  await postImport({ url: value });
}

async function importByJson() {
  const text = $('json-input').value.trim();
  if (!text) return setStatus('Paste character JSON first.', 'error');
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return setStatus('Invalid JSON.', 'error');
  }
  await postImport({ json });
}

async function postImport(body) {
  setStatus('Importing…', 'ok');
  try {
    const res = await fetch('/api/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    const generatedCount = await render(data.character);
    const suffix = generatedCount > 0
      ? ` — generated ${generatedCount} item sprite${generatedCount === 1 ? '' : 's'}`
      : '';
    setStatus(`Loaded ${data.character.name} (${data.source})${suffix}.`, 'ok');
  } catch (err) {
    setStatus(err.message, 'error');
  }
}

async function render(character) {
  originalCharacter = character;
  currentOverrides = loadOverrides(character.id);
  currentAppearance = loadAppearance(character.id);
  currentDirection = 'south';

  const slotEffective = assignCarriedSlots(character, currentOverrides);
  // Clone before applying appearance overrides — preserve original for re-render
  const effective = JSON.parse(JSON.stringify(slotEffective));
  applyAppearanceOverrides(effective, currentAppearance);
  currentCharacter = effective;

  result.classList.remove('hidden');
  $('char-name').textContent = effective.name;
  const classes = (effective.classes || []).map(c => `${c.name} ${c.level}`).join(' / ');
  $('char-meta').textContent = `${effective.race?.name || ''} · ${classes || `Level ${effective.level}`}`;

  if (effective.skinTone) $('skin-select').value = effective.skinTone;

  // Phase J — populate appearance-picker controls from saved state
  syncAppearanceControls(currentAppearance);
  $('appearance-picker').hidden = false;

  renderAbilities(effective);
  renderEquipment(effective.equipment, effective.carried);
  renderFeats(effective.feats);
  populateSlotPicker(effective);
  $('raw-json').textContent = JSON.stringify(effective, null, 2);

  const r = await renderSprite(canvas, effective, { scale: 6, direction: currentDirection });
  return r.generatedCount;
}

function syncAppearanceControls(app) {
  const picker = $('appearance-picker');
  if (!picker) return;
  picker.querySelectorAll('[data-app]').forEach(el => {
    const field = el.dataset.app;
    const value = app[field];
    if (el.type === 'checkbox') el.checked = !!value;
    else el.value = value ?? '';
  });
  // Reset direction to south
  picker.querySelectorAll('.dir-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.dir === 'south'));

  // Phase E2 — initialize HP slider from character.hp (D&DB current/max) or
  // saved override
  const hpMax = originalCharacter?.hp?.max ?? 100;
  const hpCurrent = app.hpCurrent ?? originalCharacter?.hp?.current ?? hpMax;
  const range = document.getElementById('hp-range');
  const display = document.getElementById('hp-display');
  if (range) {
    range.max = String(hpMax);
    range.value = String(Math.min(hpCurrent, hpMax));
  }
  if (display) display.textContent = `${hpCurrent} / ${hpMax}`;

  // Phase E3 — restore condition checkboxes from saved state
  const active = Array.isArray(app.conditions) ? app.conditions : [];
  picker.querySelectorAll('[data-condition]').forEach(el => {
    el.checked = active.includes(el.dataset.condition);
  });
}

function populateSlotPicker(character) {
  const picker = $('slot-picker');
  const carried = character.carried || [];

  if (!carried.length) {
    picker.hidden = true;
    return;
  }
  picker.hidden = false;

  const eligibleFor = (slot, c) => {
    const isWeapon = c.inferredSlot === 'mainhand' || c.inferredSlot === 'mainhand-twohanded';
    const isShield = c.inferredSlot === 'offhand';
    if (slot === 'mainhand') return isWeapon;
    if (slot === 'offhand')  return (isWeapon && !c.twoHanded) || isShield;
    if (slot === 'back')     return isWeapon;
    if (slot === 'waist')    return isWeapon && !c.twoHanded;
    return false;
  };

  for (const slot of ['mainhand', 'offhand', 'back', 'waist']) {
    const select = picker.querySelector(`select[data-slot="${slot}"]`);
    select.innerHTML = '';
    const empty = document.createElement('option');
    empty.value = '';
    empty.textContent = '— empty —';
    empty.selected = true;
    select.appendChild(empty);

    for (const c of carried) {
      if (!eligibleFor(slot, c)) continue;
      const opt = document.createElement('option');
      opt.value = c.name;
      opt.textContent = c.name + (c.magical ? ' ✨' : '');
      if (c.slot === slot) opt.selected = true;
      select.appendChild(opt);
    }
  }
}

function renderAbilities(character) {
  const grid = $('ability-grid');
  grid.innerHTML = '';
  const order = ['STR', 'DEX', 'CON', 'INT', 'WIS', 'CHA'];
  for (const k of order) {
    const score = character.abilityScores[k];
    const mod = character.abilityModifiers[k];
    const cell = document.createElement('div');
    cell.className = 'ability';
    cell.innerHTML = `
      <div class="label">${k}</div>
      <div class="score">${score}</div>
      <div class="mod">${mod >= 0 ? '+' : ''}${mod}</div>
    `;
    grid.appendChild(cell);
  }
}

function renderEquipment(eq, carried) {
  const list = $('equipment-list');
  list.innerHTML = '';
  const slots = [
    ['armor', 'Armor'],
    ['mainhand', 'Main hand'],
    ['offhand', 'Off hand'],
    ['helm', 'Helm'],
    ['cloak', 'Cloak'],
    ['gloves', 'Gloves'],
    ['boots', 'Boots'],
    ['belt', 'Belt'],
    ['amulet', 'Amulet']
  ];
  for (const [key, label] of slots) {
    const item = eq?.[key];
    const li = document.createElement('li');
    if (!item) {
      li.className = 'empty';
      li.innerHTML = `<span class="slot">${label}</span><span>&mdash;</span>`;
    } else {
      const tag = item.magical ? ' ✨' : '';
      li.innerHTML = `<span class="slot">${label}</span><span>${item.name}${tag}</span>`;
    }
    list.appendChild(li);
  }
  if (eq?.rings?.length) {
    for (const ring of eq.rings) {
      const li = document.createElement('li');
      li.innerHTML = `<span class="slot">Ring</span><span>${ring.name}${ring.magical ? ' ✨' : ''}</span>`;
      list.appendChild(li);
    }
  }

  const overflow = (carried || []).filter(c => c.slot === 'overflow');
  if (overflow.length) {
    const heading = document.createElement('li');
    heading.className = 'overflow-heading';
    heading.innerHTML = `<span class="slot">Overflow (carried, not drawn)</span>`;
    list.appendChild(heading);
    for (const c of overflow) {
      const li = document.createElement('li');
      li.className = 'overflow';
      const tag = c.magical ? ' ✨' : '';
      li.innerHTML = `<span class="slot">${c.inferredSlot}</span><span>${c.name}${tag}</span>`;
      list.appendChild(li);
    }
  }
}

function renderFeats(feats) {
  const list = $('feat-list');
  list.innerHTML = '';
  if (!feats?.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'No feats.';
    list.appendChild(li);
    return;
  }
  for (const f of feats) {
    const li = document.createElement('li');
    li.textContent = f;
    list.appendChild(li);
  }
}

function setStatus(msg, kind) {
  status.textContent = msg;
  status.className = `status ${kind || ''}`;
}
