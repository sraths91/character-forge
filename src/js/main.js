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
  renderSprite(canvas, c, { scale: 6, direction: currentDirection, frameIdx: animFrame });
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
  const slim = {
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
    if (!payload?.id) return false;
    // Import the character — render() will pick up our queued overrides
    pendingShareOverrides = { ov: payload.ov || {}, ap: payload.ap || {}, d: payload.d || 'south' };
    setStatus(`Loading shared character ${payload.id}…`, 'loading');
    await postImport({ url: payload.id });
    return true;
  } catch (err) {
    setStatus(`Could not load shared character: ${err.message}`, 'error');
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

  if (effective.skinTone) $('skin-select').value = effective.skinTone;

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
  if (!currentCharacter) throw new Error('No character loaded');
  const off = document.createElement('canvas');
  await renderSprite(off, currentCharacter, { scale, direction: currentDirection });
  return new Promise((resolve, reject) => {
    off.toBlob(b => b ? resolve(b) : reject(new Error('canvas.toBlob returned null')), 'image/png');
  });
}

function exportFilename() {
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

// If the URL carries a share-link payload, consume it and auto-import.
// Done after render bindings are set up so status messages display.
consumeShareLink();
