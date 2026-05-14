import { renderSprite, renderPartyCanvas, renderBattleScene } from './sprite/compositor.js';
import { loadOverrides, saveOverrides, assignCarriedSlots } from './sprite/slot-overrides.js';
import { loadAppearance, saveAppearance, applyAppearanceOverrides } from './sprite/appearance-overrides.js';
import {
  loadScene, saveScene, positionOf, characterAt, setPosition, clearPositions, clampPosition
} from './scene/scene-state.js';

const $ = (id) => document.getElementById(id);
const status = $('status');
const result = $('result');
const canvas = $('sprite-canvas');

const tabs = document.querySelectorAll('.tab');
const panels = document.querySelectorAll('.tab-panel');

tabs.forEach(t => {
  t.addEventListener('click', () => {
    tabs.forEach(x => {
      const on = x === t;
      x.classList.toggle('active', on);
      x.setAttribute('aria-selected', String(on));
    });
    panels.forEach(p => p.classList.toggle('hidden', p.dataset.panel !== t.dataset.tab));
  });
});

$('url-submit').addEventListener('click', () => importByUrl());
$('json-submit').addEventListener('click', () => importByJson());

$('url-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') importByUrl();
});

// Phase J: skin tone is now in the appearance-picker as data-app="skinTone".
// The legacy #skin-select element was removed; the generic data-app change
// handler below picks up the value.

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
  if (viewMode === 'party') {
    renderBattleScene(canvas, partyComposedCharacters, currentScene, {
      direction: currentDirection, frameIdx: animFrame, positionOf
    });
    return;
  }
  if (!originalCharacter) return;
  const slotEffective = assignCarriedSlots(originalCharacter, currentOverrides);
  // Clone before applying appearance overrides so we don't mutate the source
  const c = JSON.parse(JSON.stringify(slotEffective));
  applyAppearanceOverrides(c, currentAppearance);
  currentCharacter = c;
  renderSprite(canvas, c, { scale: 6, direction: currentDirection, frameIdx: animFrame });
}

// M2 — current battle scene (background + grid + positions). Loaded
// from localStorage on startup; mutated by drag handlers and battlefield
// controls; persisted on every change. Single global scene for now —
// multi-scene support is M5.
let currentScene = loadScene();

// ---------- M1: Party Canvas (multi-character view) ----------
//
// In 'party' viewMode, the main #sprite-canvas is filled with the whole
// party on a single canvas via renderPartyCanvas(). All shared controls
// (direction toggle, animation, export, copy, share-link) keep working
// — they now operate on whichever mode is active. Per-character controls
// (skin tone, hair, beard etc.) are hidden while in party view since
// each member already carries its own customizations.

let viewMode = 'solo';            // 'solo' | 'party'
let partyComposedCharacters = []; // characters w/ their own overrides applied

async function enterPartyView() {
  const ids = loadParty();
  if (ids.length === 0) {
    setStatus('Add at least one character to your party first.', 'error');
    return;
  }
  setStatus('Composing party scene…', 'loading');
  // Fetch every party member in parallel and apply their saved customizations
  const settled = await Promise.allSettled(ids.map(async (id) => {
    const res = await fetch(`/api/characters/${encodeURIComponent(id)}`);
    if (!res.ok) throw new Error(`fetch ${id}`);
    const data = await res.json();
    const ch = data.character;
    const slotEff = assignCarriedSlots(ch, loadOverrides(ch.id));
    const cloned = JSON.parse(JSON.stringify(slotEff));
    applyAppearanceOverrides(cloned, loadAppearance(ch.id));
    return cloned;
  }));
  partyComposedCharacters = settled
    .filter(s => s.status === 'fulfilled')
    .map(s => s.value);
  if (partyComposedCharacters.length === 0) {
    setStatus('Could not load any party member.', 'error');
    return;
  }
  viewMode = 'party';
  result.classList.remove('hidden');     // ensure stage is visible even without a focused character
  document.body.classList.add('party-view-mode');
  const btn = $('party-view-toggle');
  if (btn) btn.textContent = '◉ Single view';
  syncBattlefieldControls();
  setStatus(`Party view: ${partyComposedCharacters.length} character${partyComposedCharacters.length === 1 ? '' : 's'}.`, 'ok');
  rerender();
}

function exitPartyView() {
  viewMode = 'solo';
  partyComposedCharacters = [];
  document.body.classList.remove('party-view-mode');
  const btn = $('party-view-toggle');
  if (btn) btn.textContent = '▦ Party view';
  setStatus('Single character view.', 'ok');
  // If a character was loaded before party view, re-render them.
  // Otherwise the canvas just clears.
  if (originalCharacter) rerender();
  else { const ctx = canvas.getContext('2d'); ctx.clearRect(0, 0, canvas.width, canvas.height); }
}

document.addEventListener('click', (e) => {
  if (e.target.id !== 'party-view-toggle') return;
  if (viewMode === 'party') exitPartyView();
  else enterPartyView();
});

// M2 — Drag-to-position. Pointer events handle both mouse and touch.
// Attached to the main #sprite-canvas; only active in party view. Hit-
// tests against scene positions to find which character is grabbed,
// then updates that character's (col, row) on every move and persists
// on release.

let dragState = null;   // { id, snap, offsetCol, offsetRow }

function canvasEventToPixels(event) {
  const rect = canvas.getBoundingClientRect();
  // Canvas internal coords account for CSS scaling (canvas.width might
  // be larger than its rendered width). Convert event coords to internal.
  const scaleX = canvas.width  / rect.width;
  const scaleY = canvas.height / rect.height;
  return {
    px: (event.clientX - rect.left) * scaleX,
    py: (event.clientY - rect.top)  * scaleY
  };
}

canvas.addEventListener('pointerdown', (e) => {
  if (viewMode !== 'party') return;
  if (partyComposedCharacters.length === 0) return;
  const { px, py } = canvasEventToPixels(e);
  const ch = characterAt(currentScene, partyComposedCharacters, px, py);
  if (!ch) return;
  e.preventDefault();
  canvas.setPointerCapture(e.pointerId);
  dragState = { id: ch.id, pointerId: e.pointerId };
  canvas.style.cursor = 'grabbing';
});

canvas.addEventListener('pointermove', (e) => {
  if (!dragState || dragState.pointerId !== e.pointerId) {
    // Hover hint: show a grab cursor when over a draggable character
    if (viewMode === 'party' && partyComposedCharacters.length > 0) {
      const { px, py } = canvasEventToPixels(e);
      const ch = characterAt(currentScene, partyComposedCharacters, px, py);
      canvas.style.cursor = ch ? 'grab' : 'default';
    }
    return;
  }
  const { px, py } = canvasEventToPixels(e);
  const cellPx = currentScene.cellSize * currentScene.scale;
  // Snap to cell containing the pointer
  const target = clampPosition(currentScene, {
    col: Math.floor(px / cellPx),
    row: Math.floor(py / cellPx)
  });
  setPosition(currentScene, dragState.id, target.col, target.row);
  rerender();
});

canvas.addEventListener('pointerup', (e) => {
  if (!dragState || dragState.pointerId !== e.pointerId) return;
  canvas.releasePointerCapture(e.pointerId);
  canvas.style.cursor = 'default';
  dragState = null;
  saveScene(currentScene);
});

canvas.addEventListener('pointercancel', () => {
  if (dragState) {
    canvas.style.cursor = 'default';
    dragState = null;
  }
});

// M2 — Battlefield controls: background color, grid toggle, snap toggle,
// reset positions. Wired via data-scene attributes so the handlers stay
// generic.
document.addEventListener('input', (e) => {
  if (e.target.id === 'scene-bg-color') {
    currentScene.map = { ...currentScene.map, kind: 'color', color: e.target.value };
    saveScene(currentScene);
    if (viewMode === 'party') rerender();
  }
});

document.addEventListener('change', (e) => {
  if (e.target.id === 'scene-grid-visible') {
    currentScene.grid = { ...currentScene.grid, visible: e.target.checked };
    saveScene(currentScene);
    if (viewMode === 'party') rerender();
  } else if (e.target.id === 'scene-grid-snap') {
    currentScene.grid = { ...currentScene.grid, snap: e.target.checked };
    saveScene(currentScene);
  } else if (e.target.id === 'scene-size') {
    const [cols, rows] = String(e.target.value).split('x').map(Number);
    if (Number.isFinite(cols) && Number.isFinite(rows)) {
      currentScene.cols = cols;
      currentScene.rows = rows;
      // Clamp any out-of-bounds positions so members on the old big grid
      // don't fall off when shrinking.
      for (const [id, p] of Object.entries(currentScene.positions || {})) {
        currentScene.positions[id] = clampPosition(currentScene, p);
      }
      saveScene(currentScene);
      if (viewMode === 'party') rerender();
    }
  }
});

document.addEventListener('click', (e) => {
  if (e.target.id === 'scene-reset-positions') {
    clearPositions(currentScene);
    saveScene(currentScene);
    if (viewMode === 'party') rerender();
  }
});

function syncBattlefieldControls() {
  const c = document.getElementById('scene-bg-color');
  const gv = document.getElementById('scene-grid-visible');
  const gs = document.getElementById('scene-grid-snap');
  const sz = document.getElementById('scene-size');
  if (c)  c.value = currentScene.map?.color || '#3d5a3d';
  if (gv) gv.checked = !!currentScene.grid?.visible;
  if (gs) gs.checked = !!currentScene.grid?.snap;
  if (sz) sz.value = `${currentScene.cols}x${currentScene.rows}`;
}

// ---------- Tier 3.1: Walk-cycle animation ----------
let animating = false;
let animFrame = 0;
let animTimer = null;
const FRAME_INTERVAL_MS = 130;

function startAnimation() {
  if (animating) return;
  animating = true;
  const btn = $('animate-toggle');
  if (btn) btn.textContent = '⏸ Animating';
  animTimer = setInterval(() => {
    animFrame = (animFrame + 1) & 0xFFFF;   // never overflow; renderer mods per-layer
    rerender();
  }, FRAME_INTERVAL_MS);
}

function stopAnimation() {
  if (!animating) return;
  animating = false;
  clearInterval(animTimer);
  animTimer = null;
  animFrame = 0;
  const btn = $('animate-toggle');
  if (btn) btn.textContent = '▶ Animate';
  rerender();   // snap back to frame 0
}

document.addEventListener('click', (e) => {
  if (e.target.id !== 'animate-toggle') return;
  if (animating) stopAnimation(); else startAnimation();
});

// ---------- Tier 3.2: Share-link encoding ----------
//
// We encode the full reproduction recipe into the URL hash:
//   { id: <ddbId>, ov: <slotOverrides>, ap: <appearance>, d: <direction> }
// JSON → base64url → fragment. On page load, if a payload is present we
// auto-import that character and apply the saved customizations before
// rendering, so anyone visiting the URL sees the same composed sprite.

function b64urlEncode(str) {
  return btoa(unescape(encodeURIComponent(str))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(str) {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice(0, (4 - str.length % 4) % 4);
  return decodeURIComponent(escape(atob(padded)));
}

function buildSharePayload() {
  // M1 — party-mode share encodes the whole scene as a list of ddbIds.
  // Each member is then loaded server-side via /api/characters/:id and
  // their localStorage customizations are applied on the recipient side
  // (if they happen to have them) OR the recipient sees defaults.
  if (viewMode === 'party') {
    const ids = (partyComposedCharacters || []).map(c => String(c.id)).filter(Boolean);
    if (ids.length === 0) return null;
    return {
      party: ids,
      d: currentDirection !== 'south' ? currentDirection : undefined
    };
  }
  if (!originalCharacter?.id) return null;
  return {
    id: String(originalCharacter.id),
    ov: currentOverrides,
    ap: currentAppearance,
    d:  currentDirection !== 'south' ? currentDirection : undefined
  };
}

function buildShareUrl() {
  const payload = buildSharePayload();
  if (!payload) return null;
  // Drop empty objects to keep URL short
  const slim = payload.party
    ? { party: payload.party, ...(payload.d ? { d: payload.d } : {}) }
    : {
        id: payload.id,
        ...(Object.keys(payload.ov || {}).length ? { ov: payload.ov } : {}),
        ...(Object.keys(payload.ap || {}).length ? { ap: payload.ap } : {}),
        ...(payload.d ? { d: payload.d } : {})
      };
  const encoded = b64urlEncode(JSON.stringify(slim));
  const url = new URL(window.location.href);
  url.hash = `s=${encoded}`;
  return url.toString();
}

async function consumeShareLink() {
  if (!window.location.hash.startsWith('#s=')) return false;
  try {
    const payload = JSON.parse(b64urlDecode(window.location.hash.slice(3)));
    if (Array.isArray(payload?.party)) {
      // M1 — party share: import each (in case the recipient hasn't seen
      // them before) and then enter party view.
      setStatus(`Loading shared party (${payload.party.length} characters)…`, 'loading');
      for (const id of payload.party) {
        try {
          // Use server-side import which also caches the character so
          // /api/characters/:id will return it when enterPartyView runs.
          await fetch('/api/import', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: id })
          });
        } catch { /* one bad id shouldn't break the rest */ }
      }
      // Adopt the party for this session
      saveParty(payload.party.map(String));
      refreshParty();
      if (payload.d) currentDirection = payload.d;
      await enterPartyView();
      return true;
    }
    if (!payload?.id) return false;
    pendingShareOverrides = { ov: payload.ov || {}, ap: payload.ap || {}, d: payload.d || 'south' };
    setStatus(`Loading shared character ${payload.id}…`, 'loading');
    await postImport({ url: payload.id });
    return true;
  } catch (err) {
    setStatus(`Could not load shared content: ${err.message}`, 'error');
    return false;
  }
}

// Queued by consumeShareLink() and consumed inside render() so the shared
// customizations beat localStorage's saved state for this session only.
let pendingShareOverrides = null;

document.addEventListener('click', async (e) => {
  if (e.target.id !== 'share-link') return;
  const btn = e.target;
  const url = buildShareUrl();
  if (!url) { setStatus('Load a character first.', 'error'); return; }
  if (!navigator.clipboard?.writeText) {
    setStatus('Clipboard not available — copy the URL from your address bar.', 'error');
    return;
  }
  const prev = btn.textContent;
  try {
    await navigator.clipboard.writeText(url);
    btn.textContent = '✓ Link copied';
    history.replaceState(null, '', url);
    setTimeout(() => { btn.textContent = prev; }, 2200);
  } catch (err) {
    setStatus(`Could not copy: ${err.message}`, 'error');
  }
});

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
  setStatus('Importing', 'loading');
  try {
    const res = await fetch('/api/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await res.json();
    if (!res.ok) {
      throw makeImportError(res.status, data);
    }
    const generatedCount = await render(data.character);
    const suffix = generatedCount > 0
      ? ` — generated ${generatedCount} item sprite${generatedCount === 1 ? '' : 's'}`
      : '';
    setStatus(`Loaded ${data.character.name} (${data.source})${suffix}.`, 'ok');
    refreshRecentCharacters();  // re-pull after a successful import
    refreshParty();              // re-mark the active card in the party strip
  } catch (err) {
    setStatus(err.message, 'error', err.hint);
  }
}

/**
 * Wrap a non-2xx /api/import response into an actionable Error. Most
 * D&DB import failures are 404 (private character) — surface the privacy
 * fix as a hint instead of the raw HTTP code.
 */
function makeImportError(status, data) {
  const base = data?.error || `HTTP ${status}`;
  if (status === 404 || /not.found|private/i.test(base)) {
    const err = new Error('Character not found or not public on D&D Beyond.');
    err.hint = 'On dndbeyond.com, open the character → "..." menu → set Privacy to "Public" → re-import.';
    return err;
  }
  if (status === 429) {
    const err = new Error('Rate limited — too many imports in a short window.');
    err.hint = 'Try again in a minute.';
    return err;
  }
  return new Error(base);
}

async function render(character) {
  originalCharacter = character;
  // Share-link payload wins over localStorage for this session. Once
  // applied, it's cleared — subsequent re-renders use the persisted
  // state like normal.
  if (pendingShareOverrides) {
    currentOverrides  = pendingShareOverrides.ov || {};
    currentAppearance = pendingShareOverrides.ap || {};
    currentDirection  = pendingShareOverrides.d  || 'south';
    pendingShareOverrides = null;
  } else {
    currentOverrides = loadOverrides(character.id);
    currentAppearance = loadAppearance(character.id);
    currentDirection = 'south';
  }

  const slotEffective = assignCarriedSlots(character, currentOverrides);
  // Clone before applying appearance overrides — preserve original for re-render
  const effective = JSON.parse(JSON.stringify(slotEffective));
  applyAppearanceOverrides(effective, currentAppearance);
  currentCharacter = effective;

  result.classList.remove('hidden');
  $('char-name').textContent = effective.name;
  const classes = (effective.classes || []).map(c => `${c.name} ${c.level}`).join(' / ');
  $('char-meta').textContent = `${effective.race?.name || ''} · ${classes || `Level ${effective.level}`}`;

  // (Skin tone is initialized below via the appearance picker controls)

  // Phase J — populate appearance-picker controls from saved state
  syncAppearanceControls(currentAppearance);
  $('appearance-picker').hidden = false;

  renderAbilities(effective);
  renderEquipment(effective.equipment, effective.carried);
  renderFeats(effective.feats);
  populateSlotPicker(effective);
  $('raw-json').textContent = JSON.stringify(effective, null, 2);

  stopAnimation();   // reset animation state when loading a new character
  const r = await renderSprite(canvas, effective, { scale: 6, direction: currentDirection, frameIdx: 0 });
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

// Rarity → CSS class used on the equipment list (matches color tier of the
// in-canvas backdrop aura so the sheet's name color subtly hints at it).
function rarityClass(rarity) {
  const k = String(rarity || '').toLowerCase().replace(/\s+/g, '_');
  if (['uncommon','rare','very_rare','legendary','artifact'].includes(k)) return `rarity-${k}`;
  return '';
}

function renderItemLi(slot, item) {
  const li = document.createElement('li');
  if (!item) {
    li.className = 'empty';
    li.innerHTML = `<span class="slot">${escapeHtml(slot)}</span><span>&mdash;</span>`;
    return li;
  }
  const nameSpan = `<span class="item-name ${rarityClass(item.rarity)}">${escapeHtml(item.name)}</span>`;
  const sparkle = item.magical ? '<span class="sparkle" title="Magical" aria-hidden="true">✨</span>' : '';
  const attuned = item.attuned ? '<span class="attuned-dot" title="Attuned" aria-hidden="true"></span>' : '';
  li.innerHTML = `<span class="slot">${escapeHtml(slot)}</span><span class="item-cell">${nameSpan}${sparkle}${attuned}</span>`;
  return li;
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
    list.appendChild(renderItemLi(label, eq?.[key]));
  }
  if (eq?.rings?.length) {
    for (const ring of eq.rings) {
      list.appendChild(renderItemLi('Ring', ring));
    }
  }

  const overflow = (carried || []).filter(c => c.slot === 'overflow');
  if (overflow.length) {
    const heading = document.createElement('li');
    heading.className = 'overflow-heading';
    heading.innerHTML = `<span class="slot">Overflow (carried, not drawn)</span>`;
    list.appendChild(heading);
    for (const c of overflow) {
      const li = renderItemLi(c.inferredSlot, c);
      li.classList.add('overflow');
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

function setStatus(msg, kind, hint) {
  status.className = `status ${kind || ''}`;
  if (kind === 'loading') {
    status.innerHTML = `<span class="spinner" aria-hidden="true"></span><span>${escapeHtml(msg)}</span>`;
  } else if (hint) {
    status.innerHTML = `<span>${escapeHtml(msg)}</span><span class="hint-line">${escapeHtml(hint)}</span>`;
  } else {
    status.textContent = msg;
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// ---------- Tier 1: Recent characters (T1.3) ----------

async function refreshRecentCharacters() {
  const wrap = $('recent-characters');
  const chips = $('recent-chips');
  try {
    const res = await fetch('/api/characters');
    if (!res.ok) return;
    const data = await res.json();
    const list = (data.characters || []).slice(0, 8);
    if (list.length === 0) { wrap.hidden = true; return; }
    chips.innerHTML = '';
    for (const c of list) {
      const btn = document.createElement('button');
      btn.className = 'recent-chip';
      btn.type = 'button';
      btn.textContent = c.name;
      btn.title = `Re-import ${c.name} (${c.ddbId})`;
      btn.addEventListener('click', () => {
        $('url-input').value = String(c.ddbId);
        importByUrl();
      });
      chips.appendChild(btn);
    }
    wrap.hidden = false;
  } catch { /* network/parse issue — silently keep panel hidden */ }
}

// ---------- Tier 1: PNG download + copy (T1.1, T1.2, T1.6) ----------

/**
 * Render the current character into a fresh canvas at the requested scale
 * and return a PNG blob. Reuses the same renderSprite() pipeline so the
 * downloaded image matches what's on screen, just larger.
 */
async function exportCurrentSprite(scale = 6) {
  const off = document.createElement('canvas');
  if (viewMode === 'party') {
    if (partyComposedCharacters.length === 0) throw new Error('Party is empty');
    // Use a scaled copy of the scene so the export honors the export-size
    // dropdown without permanently changing the on-screen render.
    const exportScene = { ...currentScene, scale };
    await renderBattleScene(off, partyComposedCharacters, exportScene, {
      direction: currentDirection, positionOf
    });
  } else {
    if (!currentCharacter) throw new Error('No character loaded');
    await renderSprite(off, currentCharacter, { scale, direction: currentDirection });
  }
  return new Promise((resolve, reject) => {
    off.toBlob(b => b ? resolve(b) : reject(new Error('canvas.toBlob returned null')), 'image/png');
  });
}

function exportFilename() {
  if (viewMode === 'party') {
    const stamp = new Date().toISOString().slice(0, 10);
    return `party-scene-${stamp}.png`;
  }
  const name  = (currentCharacter?.name  || 'character').replace(/\s+/g, '_');
  const cls   = currentCharacter?.classes?.[0]?.name?.toLowerCase() || 'adventurer';
  const level = currentCharacter?.level   || 1;
  return `${name}-${cls}-L${level}.png`;
}

document.addEventListener('click', async (e) => {
  if (e.target.id === 'download-png') {
    const btn = e.target;
    if (btn.disabled) return;
    btn.disabled = true;
    btn.textContent = 'Rendering…';
    try {
      const scale = Number($('export-scale')?.value) || 6;
      const blob = await exportCurrentSprite(scale);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = exportFilename();
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setStatus(err.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Download PNG';
    }
  }
  if (e.target.id === 'copy-png') {
    const btn = e.target;
    if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') {
      setStatus('Clipboard image copy not supported in this browser — use Download instead.', 'error');
      return;
    }
    btn.disabled = true;
    const prev = btn.textContent;
    btn.textContent = 'Copying…';
    try {
      const scale = Number($('export-scale')?.value) || 6;
      const blob = await exportCurrentSprite(scale);
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      btn.textContent = 'Copied ✓';
      setTimeout(() => { btn.textContent = prev; }, 1800);
    } catch (err) {
      setStatus(`Copy failed: ${err.message}`, 'error');
      btn.textContent = prev;
    } finally {
      btn.disabled = false;
    }
  }
});

// ---------- Tier 3.3: Party / multi-character grid ----------
//
// A party is just an ordered list of D&DB ids in localStorage. For each
// member we re-fetch the parsed character from /api/characters/:id,
// apply that character's saved appearance/slot overrides (so each
// member shows their own customizations, independent of the main view),
// and render a small sprite into a card.
//
// Click a card → load that character into the main view.
// ✕ button → remove from party.

const PARTY_KEY = 'cf_party';
const PARTY_CARD_SCALE = 2;   // 64×64 frame × 2 = 128px card sprite

function loadParty() {
  try { return JSON.parse(localStorage.getItem(PARTY_KEY) || '[]'); } catch { return []; }
}
function saveParty(ids) {
  try { localStorage.setItem(PARTY_KEY, JSON.stringify(ids)); } catch { /* private mode */ }
}

function addCurrentToParty() {
  if (!originalCharacter?.id) return;
  const ids = loadParty();
  if (ids.includes(String(originalCharacter.id))) return;   // already in party
  ids.push(String(originalCharacter.id));
  saveParty(ids);
  refreshParty();
}

function removeFromParty(id) {
  const ids = loadParty().filter(x => x !== String(id));
  saveParty(ids);
  refreshParty();
}

async function refreshParty() {
  const ids = loadParty();
  const wrap = $('party');
  const strip = $('party-strip');
  if (ids.length === 0) {
    if (wrap) wrap.classList.add('hidden');
    return;
  }
  if (!wrap || !strip) return;
  wrap.classList.remove('hidden');
  strip.innerHTML = '';

  // Render all members in parallel so a slow fetch doesn't block the rest
  await Promise.all(ids.map(async (id) => {
    try {
      const res = await fetch(`/api/characters/${encodeURIComponent(id)}`);
      if (!res.ok) {
        // Stale id (e.g. character cleared from DB) — silently drop the card
        // so the strip doesn't show broken state. The id stays in storage so
        // a re-import would restore it.
        return;
      }
      const data = await res.json();
      const ch = data.character;
      // Apply this party member's own saved overrides
      const slotEff = assignCarriedSlots(ch, loadOverrides(ch.id));
      const cloned = JSON.parse(JSON.stringify(slotEff));
      applyAppearanceOverrides(cloned, loadAppearance(ch.id));

      strip.appendChild(renderPartyCard(cloned, id));
    } catch { /* network blip — leave gap */ }
  }));
}

function renderPartyCard(character, ddbId) {
  const card = document.createElement('div');
  card.className = 'party-card';
  if (originalCharacter && String(originalCharacter.id) === String(ddbId)) {
    card.classList.add('active');
  }

  const canvas = document.createElement('canvas');
  canvas.className = 'party-canvas';
  card.appendChild(canvas);

  const nameEl = document.createElement('div');
  nameEl.className = 'party-name';
  nameEl.textContent = character.name || 'Unnamed';
  card.appendChild(nameEl);

  const classes = (character.classes || []).map(c => `${c.name} ${c.level}`).join(' / ');
  const metaEl = document.createElement('div');
  metaEl.className = 'party-meta';
  metaEl.textContent = classes || `Level ${character.level || 1}`;
  card.appendChild(metaEl);

  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'party-remove';
  removeBtn.setAttribute('aria-label', `Remove ${character.name} from party`);
  removeBtn.textContent = '✕';
  removeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    removeFromParty(ddbId);
  });
  card.appendChild(removeBtn);

  // Click the card body (not the remove button) → switch to this character
  card.addEventListener('click', () => switchToMember(ddbId));

  // Render the mini sprite (south-facing, frame 0). Fire-and-forget.
  renderSprite(canvas, character, { scale: PARTY_CARD_SCALE, direction: 'south', frameIdx: 0 })
    .catch(() => { /* render failure is non-fatal; card still shows name */ });

  return card;
}

async function switchToMember(ddbId) {
  try {
    setStatus('Loading party member…', 'loading');
    const res = await fetch(`/api/characters/${encodeURIComponent(ddbId)}`);
    if (!res.ok) throw new Error('Not found');
    const data = await res.json();
    stopAnimation();
    await render(data.character);
    setStatus(`Loaded ${data.character.name}.`, 'ok');
    refreshParty();   // re-mark the active card
  } catch (err) {
    setStatus(err.message, 'error');
  }
}

document.addEventListener('click', (e) => {
  if (e.target.id === 'add-to-party') addCurrentToParty();
});

// ---------- Tier 3.4: Light/dark theme toggle ----------
const THEME_KEY = 'cf_theme';
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  const btn = $('theme-toggle');
  if (btn) btn.textContent = theme === 'light' ? '☀' : '🌙';
}
try {
  const saved = localStorage.getItem(THEME_KEY);
  applyTheme(saved === 'light' ? 'light' : 'dark');
} catch { applyTheme('dark'); }

document.addEventListener('click', (e) => {
  if (e.target.id !== 'theme-toggle') return;
  const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  try { localStorage.setItem(THEME_KEY, next); } catch { /* private mode */ }
});

// Fetch the recent-characters list once on page load
refreshRecentCharacters();

// Restore the party panel (each member is re-fetched from /api/characters/:id)
refreshParty();

// If the URL carries a share-link payload, consume it and auto-import.
// Done after render bindings are set up so status messages display.
consumeShareLink();
