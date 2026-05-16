import { renderSprite, renderPartyCanvas, renderBattleScene } from './sprite/compositor.js';
import { loadOverrides, saveOverrides, assignCarriedSlots } from './sprite/slot-overrides.js';
import { loadAppearance, saveAppearance, applyAppearanceOverrides } from './sprite/appearance-overrides.js';
import {
  loadScene, saveScene, positionOf, setPosition, clearPositions, clampPosition,
  addMonsterInstance, removeMonsterInstance, updateMonsterPosition, entityAt,
  setMonsterCondition,
  SCENE_PRESETS,
  listScenes, setActiveScene, createScene, duplicateScene, renameScene, deleteScene, getActiveSceneId
} from './scene/scene-state.js';
import { MONSTER_PRESETS, buildMonsterCharacter, monsterSaveBonus } from './scene/monster-presets.js';
import {
  combat, beginAttack, cancelAttack, selectAttacker,
  resolveAttack as resolveAttackAnimation,
  pruneExpired, hasActiveAnimations, entityAnimations, damagePopups
} from './scene/combat.js';
import { rollAttack, rollDamage, describeAttack } from './scene/combat-roll.js';
import { deriveAC, deriveAttack, deriveWeaponAttack, spellAttackBonus, saveBonus } from './scene/pc-stats.js';
import { resolveAttack } from './scene/combat-resolver.js';
import { factionLists } from './scene/grid-rules.js';
import { buildActionsFor } from './scene/actions-panel.js';
import { templateCells, entitiesInTemplate } from './scene/aoe.js';
import { tooltipFor } from './scene/rules-reference.js';
import { buildTurnTips } from './scene/turn-coach.js';
import { resolveSpellSave } from './scene/save-rolls.js';
import { simulateEncounter } from './scene/simulator.js';
import { diffCharacters, describeDiff } from './character/diff-character.js';

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
      direction: currentDirection, frameIdx: animFrame, positionOf,
      monsterCharacters: buildMonsterCharactersForRender(),
      // M4 — combat overlays
      selectedAttackerId: combat.attacker?.id || null,
      activeTurnId: (currentScene.initiative?.find?.(i => i.active))?.entityId || null,
      animations: entityAnimations,
      popups: damagePopups,
      // M8 — AoE template (placed + previewed shapes)
      aoeTemplate: currentAoeTemplate
    });
    renderMonsterPanel();   // sync the side card UI
    renderInitiativeTracker();
    renderActionsPanel();
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

// M3 — turn the scene's monster instances into the character-shaped
// records renderBattleScene needs. Each gets an _position pointing at
// the live instance's cell, plus HP copied from the instance (so when
// HP drops, wounded/down filters trigger).
function buildMonsterCharactersForRender() {
  const result = [];
  for (const m of (currentScene.monsters || [])) {
    const preset = MONSTER_PRESETS[m.presetSlug];
    if (!preset) continue;
    const ch = buildMonsterCharacter(preset, m.id);
    ch.name = m.name;
    ch.hp = {
      base: m.hp.max, bonus: 0, override: null,
      temp: m.hp.temp || 0, removed: Math.max(0, m.hp.max - m.hp.current),
      max: m.hp.max, current: m.hp.current
    };
    // M7 — Pipe instance conditions into the rendered character so the
    // existing E3 condition-filter pipeline (green tint for poisoned,
    // tinted overlay for frightened, etc.) lights up automatically.
    ch.conditions = Array.isArray(m.conditions) ? [...m.conditions] : [];
    ch._position = m.position;
    result.push(ch);
  }
  return result;
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
  syncTopnav();
  syncBattlefieldControls();
  renderScenePresetList();
  renderMonsterPresetList();
  setStatus(`Party view: ${partyComposedCharacters.length} character${partyComposedCharacters.length === 1 ? '' : 's'}.`, 'ok');
  rerender();
}

function exitPartyView() {
  viewMode = 'solo';
  partyComposedCharacters = [];
  document.body.classList.remove('party-view-mode');
  syncTopnav();
  setStatus('Single character view.', 'ok');
  // If a character was loaded before party view, re-render them.
  // Otherwise the canvas just clears.
  if (originalCharacter) rerender();
  else { const ctx = canvas.getContext('2d'); ctx.clearRect(0, 0, canvas.width, canvas.height); }
}

function syncTopnav() {
  const name = viewMode === 'party' ? 'party' : 'character';
  document.querySelectorAll('.topnav-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.view === name));
}

// M9 — Top-level nav. Three views: Character (single-sprite view, the
// default), Party (multi-character canvas), Combat (party canvas + the
// combat panel scrolled into view and visually flagged).
//
// We only commit the active-state change AFTER any required entry step
// (enterPartyView) succeeds — otherwise a failed "no party loaded" entry
// would leave the nav highlighted on a view the user isn't actually in.
async function setView(name) {
  if (name === 'character') {
    if (viewMode === 'party') exitPartyView();
    syncTopnav();
    return;
  }
  // Both 'party' and 'combat' require the party canvas
  if (viewMode !== 'party') {
    await enterPartyView();
    if (viewMode !== 'party') {
      // enterPartyView bailed (empty party). Leave nav state untouched —
      // syncTopnav inside enterPartyView already handles the success path.
      return;
    }
  }
  if (name === 'combat') {
    const combatPanel = document.getElementById('combat-panel');
    if (combatPanel) {
      combatPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
      combatPanel.classList.add('combat-panel-focus');
      setTimeout(() => combatPanel.classList.remove('combat-panel-focus'), 1500);
    }
  }
  // For party+combat, mark the actual clicked view as active (not party)
  document.querySelectorAll('.topnav-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.view === name));
}

document.addEventListener('click', (e) => {
  const btn = e.target.closest('.topnav-btn');
  if (!btn) return;
  setView(btn.dataset.view);
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
  const { px, py } = canvasEventToPixels(e);

  // M8 — AoE place mode: the next click anchors the template at the
  // clicked cell. Short-circuits all other modes so dragging is paused.
  if (aoePlacing) {
    const cellPx = currentScene.cellSize * currentScene.scale;
    const col = Math.floor(px / cellPx);
    const row = Math.floor(py / cellPx);
    const rebuilt = rebuildAoeTemplateAt(col, row);
    if (rebuilt) {
      currentAoeTemplate = rebuilt;
      aoePlacing = false;
      showAoeAffected();
      setCombatStatus('Template placed. Adjust shape/size/direction live, or Clear to remove.');
      rerender();
    }
    e.preventDefault();
    return;
  }

  const hit = entityAt(currentScene, partyComposedCharacters, px, py);

  // M4 — combat mode short-circuits the drag handler. Clicking an entity
  // either picks the attacker or fires the attack on the target.
  if (combat.mode === 'pick-attacker') {
    if (!hit) { setCombatStatus('Click an entity to attack with — or press Esc to cancel.'); return; }
    selectAttacker(hit.entity.id, hit.kind);
    setCombatStatus(`Attacker: ${entityName(hit)}. Click a target.`);
    startContinuousRender();   // selection outline animates the canvas
    rerender();
    return;
  }
  if (combat.mode === 'pick-target') {
    if (!hit) { setCombatStatus('Click another entity to attack — or press Esc to cancel.'); return; }
    if (hit.entity.id === combat.attacker?.id) {
      setCombatStatus('Cannot target the attacker. Click someone else or press Esc.');
      return;
    }
    e.preventDefault();
    hideAttackPreview();
    runAttackPrompt(hit.kind, hit.entity);
    return;
  }

  // Normal drag flow
  if (!hit) return;
  e.preventDefault();
  canvas.setPointerCapture(e.pointerId);
  dragState = { kind: hit.kind, id: hit.entity.id, pointerId: e.pointerId };
  canvas.style.cursor = 'grabbing';
});

canvas.addEventListener('pointermove', (e) => {
  if (!dragState || dragState.pointerId !== e.pointerId) {
    // Hover hint: show a grab cursor when over a draggable entity
    if (viewMode === 'party') {
      const { px, py } = canvasEventToPixels(e);
      const hit = entityAt(currentScene, partyComposedCharacters, px, py);
      canvas.style.cursor = hit ? 'grab' : 'default';
      // M16 — Attack preview during pick-target mode. Show breakdown
      // (advantage/disadvantage reasons, damage, AC) for whatever cell
      // the cursor is over, BEFORE the user commits the attack.
      if (combat.mode === 'pick-target') {
        updateAttackPreview(hit, e.clientX, e.clientY);
      } else {
        hideAttackPreview();
      }
    }
    return;
  }
  const { px, py } = canvasEventToPixels(e);
  const cellPx = currentScene.cellSize * currentScene.scale;
  const target = clampPosition(currentScene, {
    col: Math.floor(px / cellPx),
    row: Math.floor(py / cellPx)
  });
  if (dragState.kind === 'pc') {
    setPosition(currentScene, dragState.id, target.col, target.row);
  } else {
    updateMonsterPosition(currentScene, dragState.id, target.col, target.row);
  }
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

canvas.addEventListener('pointerleave', () => hideAttackPreview());

// M16 — Attack preview tooltip. Driven by pointermove during the
// pick-target combat mode. Calls the same resolver runAttackPrompt uses
// so what you see is exactly what will roll.
function updateAttackPreview(hit, clientX, clientY) {
  const panel = document.getElementById('attack-preview');
  if (!panel) return;
  if (!hit || !combat.attacker) {
    hideAttackPreview();
    return;
  }
  if (hit.entity.id === combat.attacker.id) {
    hideAttackPreview();
    return;
  }
  const attackerHit = findHitById(combat.attacker.id);
  if (!attackerHit) { hideAttackPreview(); return; }

  const attack = getAttackStats(attackerHit);
  const ac     = getAC({ kind: hit.kind, entity: hit.entity });
  const weapon = getAttackerWeapon(attackerHit);
  const { allies, hostiles } = factionLists({
    attackerKind: attackerHit.kind,
    attackerId: attackerHit.entity.id,
    party: partyComposedCharacters.map(pc => ({ ...pc, _position: positionOf(currentScene, pc.id, partyComposedCharacters.indexOf(pc)) })),
    monsters: (currentScene.monsters || [])
  });
  const verdict = resolveAttack({
    attacker: attackerHit.entity,
    target: hit.entity,
    weapon,
    scene: currentScene,
    attackerKind: attackerHit.kind,
    targetKind: hit.kind,
    targetAC: ac,
    advantageOverride: combatAdvantage,
    allies, hostiles,
    attackStats: { bonus: attack.bonus, dice: attack.dice, damageType: attack.damageType }
  });

  const attackerName = entityName(attackerHit);
  const targetName = hit.entity.name || 'Target';
  const modeLabel = verdict.d20.overrideApplied
    ? `${verdict.d20.mode} (override)`
    : verdict.d20.mode;

  // M12 — Use verdict totals so item/feat bonuses appear in the preview
  // exactly as they will in the actual roll.
  const previewBonus = verdict.attackBonus.total;
  const previewBonusSign = previewBonus >= 0 ? '+' : '';
  const parts = [];
  parts.push(`<div class="preview-head">${escapeHtml(attackerName)} → ${escapeHtml(targetName)}</div>`);
  parts.push(`<div class="preview-line">Attack: ${previewBonusSign}${previewBonus} (${escapeHtml(weapon?.name || attack.name || 'Attack')}) vs AC ${ac}</div>`);
  if (verdict.attackBonus.parts.length > 1) {
    const partsStr = verdict.attackBonus.parts.map(p => `${escapeHtml(p.source)} ${p.value >= 0 ? '+' : ''}${p.value}`).join(', ');
    parts.push(`<div class="preview-parts">${partsStr}</div>`);
  }
  parts.push(`<div class="preview-line">Damage: ${escapeHtml(verdict.damage.dice)}${verdict.damage.damageType ? ' ' + escapeHtml(verdict.damage.damageType) : ''}</div>`);
  parts.push(`<div class="preview-line preview-mode preview-mode-${verdict.d20.mode}">${escapeHtml(modeLabel)}</div>`);

  if (verdict.blockers.length) {
    parts.push(`<div class="preview-blockers">${verdict.blockers.map(b => `⛔ ${reasonChip(b)}`).join('<br/>')}</div>`);
  } else {
    if (verdict.d20.advantage.length) {
      parts.push(`<div class="preview-reasons preview-adv">Adv: ${verdict.d20.advantage.map(reasonChip).join('; ')}</div>`);
    }
    if (verdict.d20.disadvantage.length) {
      parts.push(`<div class="preview-reasons preview-dis">Dis: ${verdict.d20.disadvantage.map(reasonChip).join('; ')}</div>`);
    }
    if (verdict.autoCrit) {
      parts.push(`<div class="preview-reasons preview-crit">⚡ Auto-crit: ${reasonChip(verdict.autoCritReason)}</div>`);
    }
  }

  // M15 — Class-feature availability indicators (e.g. Sneak Attack).
  for (const f of (verdict.features || [])) {
    if (f.available) {
      parts.push(`<div class="preview-feature available">✨ ${escapeHtml(f.name)}: <strong>${escapeHtml(f.dice)}</strong> <em>(${escapeHtml(f.reason || '')})</em></div>`);
    } else {
      // Show as a hint only — don't clutter the preview with every
      // unavailable feature. Keep just the most actionable one (Sneak
      // Attack is the common-rogue case).
      if (/sneak attack/i.test(f.name)) {
        parts.push(`<div class="preview-feature unavailable">${escapeHtml(f.name)}: <em>${escapeHtml(f.blockReason || 'unavailable')}</em></div>`);
      }
    }
  }

  panel.innerHTML = parts.join('');
  panel.hidden = false;
  // Position next to the cursor — kept inside the viewport.
  const rect = panel.getBoundingClientRect();
  const offset = 14;
  let x = clientX + offset;
  let y = clientY + offset;
  if (x + rect.width  > window.innerWidth)  x = clientX - rect.width  - offset;
  if (y + rect.height > window.innerHeight) y = clientY - rect.height - offset;
  panel.style.left = `${Math.max(0, x)}px`;
  panel.style.top  = `${Math.max(0, y)}px`;
}

function hideAttackPreview() {
  const panel = document.getElementById('attack-preview');
  if (panel) panel.hidden = true;
}

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
  } else if (e.target.id === 'scene-flanking') {
    currentScene.flankingEnabled = e.target.checked;
    saveScene(currentScene);
    if (viewMode === 'party') rerender();
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

// ---------- M3: Monster panel ----------
//
// Three entry points to spawn a monster:
//   1. "Preset" list — instant, no network. ~14 hand-built LPC composites
//      (Goblin, Orc, Skeleton, etc.). Click → addMonsterInstance.
//   2. Search field → /api/monsters/search → results render as buttons.
//      Click a result → addMonsterInstance using the preset whose slug
//      best matches (otherwise we fall back to a generic Bandit preset
//      tagged with the Open5e name + HP so the visual is at least
//      humanoid even when LPC has no exact match).
//   3. Existing instances list — each has name, HP slider, remove (✕).

function renderMonsterPresetList() {
  const wrap = document.getElementById('monster-presets-list');
  if (!wrap) return;
  if (wrap.dataset.populated === '1') return;   // populate once
  wrap.dataset.populated = '1';
  for (const slug of Object.keys(MONSTER_PRESETS)) {
    const p = MONSTER_PRESETS[slug];
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'monster-preset-btn';
    b.textContent = p.name;
    b.dataset.slug = slug;
    wrap.appendChild(b);
  }
}

// M7 + M11/M13 — Canonical condition list, matching the appearance-picker
// checkboxes on the character sheet. Order is shared so the UX is
// consistent across PCs and monsters. M11 added the conditions the combat
// resolver consults (blinded, prone, restrained, grappled, deafened).
const CONDITION_KEYS = [
  ['poisoned',    'Poisoned'],
  ['blinded',     'Blinded'],
  ['frightened',  'Frightened'],
  ['charmed',     'Charmed'],
  ['paralyzed',   'Paralyzed'],
  ['stunned',     'Stunned'],
  ['petrified',   'Petrified'],
  ['invisible',   'Invisible'],
  ['unconscious', 'Unconscious'],
  ['prone',       'Prone'],
  ['restrained',  'Restrained'],
  ['grappled',    'Grappled'],
  ['deafened',    'Deafened']
];

function renderMonsterPanel() {
  const list = document.getElementById('monsters-list');
  if (!list) return;
  list.innerHTML = '';
  const monsters = currentScene.monsters || [];
  if (monsters.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'monster-empty';
    empty.textContent = 'No monsters on the field yet.';
    list.appendChild(empty);
    return;
  }
  for (const m of monsters) {
    const card = document.createElement('div');
    card.className = 'monster-card';
    card.dataset.id = m.id;
    const hpPct = Math.max(0, Math.min(100, Math.round((m.hp.current / m.hp.max) * 100)));
    const activeConditions = Array.isArray(m.conditions) ? m.conditions : [];
    const condSummary = activeConditions.length === 0
      ? 'No conditions'
      : activeConditions.map(c => CONDITION_KEYS.find(([k]) => k === c)?.[1] || c).join(', ');
    const condCheckboxes = CONDITION_KEYS.map(([key, label]) => {
      const checked = activeConditions.includes(key) ? ' checked' : '';
      return `<label class="monster-condition-option"><input type="checkbox" data-monster-condition="${escapeHtml(m.id)}" data-condition="${escapeHtml(key)}"${checked} /><span>${escapeHtml(label)}</span></label>`;
    }).join('');
    card.innerHTML = `
      <div class="monster-card-head">
        <span class="monster-card-name">${escapeHtml(m.name)}</span>
        <button class="monster-remove" type="button" data-monster-remove="${escapeHtml(m.id)}" aria-label="Remove ${escapeHtml(m.name)}">✕</button>
      </div>
      <div class="monster-hp">
        <span class="monster-hp-label">${m.hp.current} / ${m.hp.max} hp</span>
        <input class="monster-hp-range" type="range" min="0" max="${m.hp.max}" value="${m.hp.current}" data-monster-hp="${escapeHtml(m.id)}" />
        <div class="monster-hp-bar"><div class="monster-hp-fill" style="width:${hpPct}%"></div></div>
      </div>
      <details class="monster-conditions"${activeConditions.length ? ' open' : ''}>
        <summary><span class="monster-conditions-label">Conditions</span> <span class="monster-conditions-summary">${escapeHtml(condSummary)}</span></summary>
        <div class="monster-conditions-grid">${condCheckboxes}</div>
      </details>
    `;
    list.appendChild(card);
  }
}

function spawnMonsterFromPreset(slug, opts = {}) {
  const preset = MONSTER_PRESETS[slug];
  if (!preset) return null;
  const overrides = opts.overrides || {};
  // Apply Open5e-derived HP if provided (so a dragon spawned via search
  // doesn't show goblin HP just because it's wearing the goblin preset).
  const merged = { ...preset, ...(overrides.preset || {}) };
  if (overrides.name)     merged.name = overrides.name;
  if (overrides.maxHp)    merged.defaultHp = { max: overrides.maxHp };
  if (overrides.spritePresetSlug) merged.slug = overrides.spritePresetSlug;
  addMonsterInstance(currentScene, merged);
  saveScene(currentScene);
  rerender();
}

/**
 * Heuristic: given an Open5e creature name/type, pick the closest LPC
 * preset for the visual. Falls back to 'bandit' as a generic humanoid.
 */
function matchPresetForOpen5e(name, type) {
  const n = String(name || '').toLowerCase();
  const t = String(type || '').toLowerCase();
  for (const slug of Object.keys(MONSTER_PRESETS)) {
    if (n.includes(slug)) return slug;
  }
  if (t.includes('undead') || n.includes('skeleton')) return 'skeleton';
  if (n.includes('zombie') || n.includes('ghoul'))    return 'zombie';
  if (n.includes('vampire'))                          return 'vampire';
  if (n.includes('orc') || n.includes('hobgoblin'))   return 'orc';
  if (n.includes('goblin') || n.includes('kobold'))   return 'goblin';
  if (n.includes('troll') || n.includes('ogre') || n.includes('giant')) return 'troll';
  if (n.includes('minotaur'))                         return 'minotaur';
  if (n.includes('wolf') || n.includes('gnoll'))      return 'gnoll';
  return 'bandit';   // generic humanoid fallback
}

async function searchMonstersOnline(query) {
  const wrap = document.getElementById('monster-search-results');
  if (!wrap) return;
  wrap.hidden = false;
  wrap.innerHTML = '<span class="hint-line">Searching…</span>';
  try {
    const res = await fetch(`/api/monsters/search?q=${encodeURIComponent(query)}`);
    const data = await res.json();
    const results = Array.isArray(data?.results) ? data.results : [];
    if (results.length === 0) {
      wrap.innerHTML = '<span class="hint-line">No monsters matched. Try a different keyword.</span>';
      return;
    }
    wrap.innerHTML = '';
    for (const r of results.slice(0, 12)) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'monster-search-result';
      const cr = r.cr != null ? ` · CR ${r.cr}` : '';
      const hp = r.hp ? ` · ${r.hp} hp` : '';
      btn.innerHTML = `<strong>${escapeHtml(r.name)}</strong><span class="dim">${escapeHtml(r.type || '')}${cr}${hp}</span>`;
      btn.addEventListener('click', () => {
        const spritePreset = matchPresetForOpen5e(r.name, r.type);
        spawnMonsterFromPreset(spritePreset, {
          overrides: { name: r.name, maxHp: r.hp || undefined }
        });
        wrap.hidden = true;
      });
      wrap.appendChild(btn);
    }
  } catch (err) {
    wrap.innerHTML = `<span class="hint-line">Search failed: ${escapeHtml(err.message)}</span>`;
  }
}

// Event delegation for monster controls (works for buttons rendered
// dynamically, including ones inside the search-result list)
document.addEventListener('click', (e) => {
  if (e.target.matches('.monster-preset-btn')) {
    spawnMonsterFromPreset(e.target.dataset.slug);
    return;
  }
  if (e.target.matches('.monster-remove') || e.target.dataset.monsterRemove) {
    const id = e.target.dataset.monsterRemove;
    if (id) {
      removeMonsterInstance(currentScene, id);
      saveScene(currentScene);
      rerender();
    }
    return;
  }
  if (e.target.id === 'monster-search-btn') {
    const q = document.getElementById('monster-search')?.value?.trim();
    if (q) searchMonstersOnline(q);
  }
});

document.addEventListener('keydown', (e) => {
  if (e.target.id === 'monster-search' && e.key === 'Enter') {
    const q = e.target.value.trim();
    if (q) searchMonstersOnline(q);
  }
});

// HP slider for monster cards
document.addEventListener('input', (e) => {
  const id = e.target.dataset?.monsterHp;
  if (!id) return;
  const hp = Number(e.target.value);
  const m = (currentScene.monsters || []).find(x => x.id === id);
  if (!m) return;
  m.hp = { ...m.hp, current: Math.max(0, Math.min(m.hp.max, hp)) };
  saveScene(currentScene);
  rerender();
});

// M7 — Condition checkboxes on monster cards. The existing E3 renderer
// picks up `character.conditions` automatically, so toggling here +
// re-rendering is all that's needed for the visual filter to apply.
document.addEventListener('change', (e) => {
  const id = e.target.dataset?.monsterCondition;
  if (!id) return;
  const condition = e.target.dataset.condition;
  setMonsterCondition(currentScene, id, condition, e.target.checked);
  saveScene(currentScene);
  rerender();
});

// ---------- M4: Combat actions (attack flow, animations, initiative) ----------

function entityName(hit) {
  if (!hit) return '';
  if (hit.kind === 'pc') return hit.entity.name || 'Character';
  return hit.entity.name || 'Monster';
}

function findHitById(id) {
  for (const pc of partyComposedCharacters) {
    if (String(pc.id) === String(id)) return { kind: 'pc', entity: pc };
  }
  for (const m of (currentScene.monsters || [])) {
    if (String(m.id) === String(id)) return { kind: 'monster', entity: m };
  }
  return null;
}

function setCombatStatus(text) {
  const el = document.getElementById('combat-status');
  if (el) el.textContent = text;
}

// M6 — Combat: derive attacker/target stats from the entity, roll the
// attack, roll damage on hit/crit, and feed the result into the existing
// animation + HP-update pipeline. Replaces the M4 manual damage prompt.
//
// M11/M16 — combatAdvantage now defaults to 'auto' (resolver decides).
// 'normal' / 'advantage' / 'disadvantage' become explicit overrides.
let combatAdvantage = 'auto';     // 'auto' | 'normal' | 'advantage' | 'disadvantage'

// M8 — Active AoE template. When `placing` is true, the next canvas
// click anchors the template at the clicked cell. Once placed (cells
// non-empty) the overlay is drawn in renderBattleScene and the
// "Affected" listing populates.
let currentAoeTemplate = null;    // { shape, cells, originCol, originRow, sizeCells, direction, color, strokeColor }
let aoePlacing = false;

function readAoePicker() {
  const shape = document.getElementById('aoe-shape')?.value || '';
  const sizeFt = Number(document.getElementById('aoe-size')?.value) || 15;
  const direction = document.getElementById('aoe-direction')?.value || 'east';
  return {
    shape, direction,
    sizeCells: shape === 'sphere' ? Math.max(1, Math.round(sizeFt / 5)) : Math.max(1, Math.round(sizeFt / 5))
  };
}

function rebuildAoeTemplateAt(originCol, originRow) {
  const { shape, sizeCells, direction } = readAoePicker();
  if (!shape) return null;
  const cells = templateCells({
    shape, originCol, originRow, sizeCells, direction,
    cols: currentScene.cols, rows: currentScene.rows
  });
  return {
    shape, sizeCells, direction,
    originCol, originRow, cells,
    color: 'rgba(96,165,250,0.30)',
    strokeColor: 'rgba(96,165,250,0.90)'
  };
}

function showAoeAffected() {
  const status = document.getElementById('aoe-status');
  if (!status) return;
  if (!currentAoeTemplate) { status.classList.add('hidden'); status.textContent = ''; return; }
  const party = partyComposedCharacters.map((pc, i) => ({
    ...pc, _position: positionOf(currentScene, pc.id, i)
  }));
  const monsters = (currentScene.monsters || []);
  const hits = entitiesInTemplate(currentAoeTemplate.cells, { party, monsters, scene: currentScene });
  const sizeFt = currentAoeTemplate.sizeCells * 5;
  const label = `${currentAoeTemplate.shape} ${sizeFt}ft${['line','cone'].includes(currentAoeTemplate.shape) ? ' ' + currentAoeTemplate.direction : ''}`;
  if (hits.length === 0) {
    status.textContent = `${label} — no entities in template.`;
  } else {
    status.textContent = `${label} — affects: ${hits.map(h => h.entity.name || 'Entity').join(', ')}`;
  }
  status.classList.remove('hidden');
}

// M20 — Monte Carlo simulate button. Snapshots the current scene
// state (positions, HP, conditions, conditions, combat mods) and runs
// `iterations` headless encounters. The button shows a "Running…"
// state during the (sync) loop — typical 500-iteration run completes
// in well under a second on modern hardware.
document.addEventListener('click', (e) => {
  if (e.target.id !== 'sim-run') return;
  if (viewMode !== 'party') {
    setCombatStatus('Enter party view to simulate.');
    return;
  }
  const iters = Number(document.getElementById('sim-iterations')?.value) || 500;
  const btn = e.target;
  const prev = btn.textContent;
  btn.disabled = true;
  btn.textContent = `Running ${iters}…`;
  // Defer to next frame so the UI can repaint the button state
  requestAnimationFrame(() => {
    const party = partyComposedCharacters.map((pc, i) => ({
      ...pc, _position: positionOf(currentScene, pc.id, i)
    }));
    const monsters = (currentScene.monsters || []);
    const stats = simulateEncounter({
      party, monsters, scene: currentScene,
      iterations: iters,
      seed: Math.floor(Math.random() * 1e9)
    });
    renderSimResults(stats);
    btn.disabled = false;
    btn.textContent = prev;
  });
});

function renderSimResults(stats) {
  const wrap = document.getElementById('sim-results');
  if (!wrap) return;
  wrap.hidden = false;
  const winPct = Math.round(stats.victoryRate * 100);
  const losePct = Math.round((stats.monsterVictories / stats.iterations) * 100);
  const drawPct = Math.round((stats.draws / stats.iterations) * 100);
  const headline = `Party wins ${winPct}% · loses ${losePct}% · stalemate ${drawPct}% · avg ${stats.avgRounds.toFixed(1)} rounds`;
  const rows = stats.entities.map(e => {
    const deathPct = Math.round(e.deathRate * 100);
    const hpAvg = e.avgFinalHp.toFixed(1);
    const dpr = (e.avgDamageDealt / Math.max(1, stats.avgRounds)).toFixed(1);
    return `<tr class="sim-row sim-${e.kind}">
      <td class="sim-name">${escapeHtml(e.name)}</td>
      <td class="sim-cell sim-${deathPct >= 50 ? 'bad' : deathPct >= 25 ? 'warn' : 'ok'}">${deathPct}% drop</td>
      <td class="sim-cell">${hpAvg} / ${e.hpMax} HP</td>
      <td class="sim-cell">${dpr} DPR</td>
    </tr>`;
  }).join('');
  wrap.innerHTML = `
    <div class="sim-headline">${escapeHtml(headline)}</div>
    <table class="sim-table">
      <thead><tr><th>Entity</th><th>Death rate</th><th>Avg final HP</th><th>Avg DPR</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <p class="sim-disclaimer">v1 simulation: each entity uses its primary weapon attack only — no spells, multiattack, movement, or healing. Results sample current state; re-run after position or condition changes.</p>
  `;
}

document.addEventListener('click', (e) => {
  if (e.target.id === 'aoe-place') {
    const { shape } = readAoePicker();
    if (!shape) {
      setCombatStatus('Pick a shape first.');
      return;
    }
    aoePlacing = true;
    setCombatStatus(`Click a cell to anchor the ${shape}. Esc to cancel.`);
    return;
  }
  if (e.target.id === 'aoe-clear') {
    currentAoeTemplate = null;
    aoePlacing = false;
    showAoeAffected();
    rerender();
    return;
  }
});

// Live-update the template overlay when the user tweaks shape/size/dir
// AFTER placing — keeps the anchor cell but recomputes geometry.
document.addEventListener('change', (e) => {
  if (!['aoe-shape', 'aoe-size', 'aoe-direction'].includes(e.target.id)) return;
  if (!currentAoeTemplate) return;
  const rebuilt = rebuildAoeTemplateAt(currentAoeTemplate.originCol, currentAoeTemplate.originRow);
  if (rebuilt) {
    currentAoeTemplate = rebuilt;
    showAoeAffected();
    rerender();
  } else {
    currentAoeTemplate = null;
    showAoeAffected();
    rerender();
  }
});

document.addEventListener('change', (e) => {
  if (e.target.name !== 'combat-adv') return;
  combatAdvantage = e.target.value;
});

function getAttackStats(hit) {
  if (!hit) return null;
  if (hit.kind === 'monster') {
    const preset = MONSTER_PRESETS[hit.entity.presetSlug] || {};
    return preset.attack || { name: 'Strike', bonus: 2, dice: '1d6' };
  }
  return deriveAttack(hit.entity);
}

function getAC(hit) {
  if (!hit) return 10;
  if (hit.kind === 'monster') {
    const preset = MONSTER_PRESETS[hit.entity.presetSlug] || {};
    return preset.ac || 12;
  }
  return deriveAC(hit.entity);
}

function runAttackPrompt(targetKind, targetEntity) {
  const attackerHit = findHitById(combat.attacker.id);
  const targetHit   = { kind: targetKind, entity: targetEntity };
  if (!attackerHit) {
    setCombatStatus('Attacker is gone. Cancelled.');
    cancelAttack();
    rerender();
    return;
  }
  const attackerName = entityName(attackerHit);
  const targetName   = targetEntity.name || 'Target';
  const ac           = getAC(targetHit);

  // M18 — If a spell was set on combat.spell, route through the spell
  // path: spell attack bonus, spell dice, scope='spell'. Otherwise the
  // existing weapon path.
  // M21 — If the queued spell requires a saving throw (Sacred Flame,
  // Toll the Dead, Fireball etc.), short-circuit to the save resolver
  // entirely; that flow doesn't roll a to-hit.
  const spell = combat.spell || null;
  if (spell?.requiresSavingThrow) {
    runSpellSavePrompt(attackerHit, { kind: targetKind, entity: targetEntity }, spell);
    return;
  }
  const attack = spell ? null : getAttackStats(attackerHit);
  const weapon = spell ? null : getAttackerWeapon(attackerHit);

  // M14 — Build allies + hostiles lists for the attacker so the resolver
  // can evaluate flanking (allies on opposite side of target) and the
  // ranged-attacker-adjacent disadvantage (any hostile within 5ft).
  const { allies, hostiles } = factionLists({
    attackerKind: attackerHit.kind,
    attackerId: attackerHit.entity.id,
    party: partyComposedCharacters.map(pc => ({ ...pc, _position: positionOf(currentScene, pc.id, partyComposedCharacters.indexOf(pc)) })),
    monsters: (currentScene.monsters || [])
  });

  // Build attackStats — spell path uses spellAttackBonus; weapon path uses
  // the existing M6 derivation.
  let attackStats;
  if (spell) {
    const sa = spellAttackBonus(attackerHit.entity, spell);
    attackStats = {
      bonus: sa.total,
      dice:  spell.dice || '1d8',
      damageType: spell.damageType,
      parts: sa.parts,
      damageParts: []
    };
  } else {
    attackStats = {
      bonus: attack.bonus,
      dice:  attack.dice,
      damageType: attack.damageType,
      parts: [{ source: weapon?.name || attack.name || 'Attack', value: attack.bonus }],
      damageParts: []
    };
  }

  // M11 — Run the resolver to determine the *real* d20 mode, auto-crit,
  // auto-miss, and breakdown. ctx.spell tells the resolver to use the
  // 'spell' scope so M12 modifiers like Amulet of the Devout +1 apply.
  const verdict = resolveAttack({
    attacker: attackerHit.entity,
    target: targetEntity,
    weapon,
    spell,
    scene: currentScene,
    attackerKind: attackerHit.kind,
    targetKind,
    targetAC: ac,
    advantageOverride: combatAdvantage,
    allies, hostiles,
    attackStats
  });

  // Hard refusals (charmed, attacker incapacitated): show the blocker and
  // skip the roll entirely. Combat mode resets so the next click starts fresh.
  if (verdict.autoMiss) {
    setCombatStatus(`${attackerName} → ${targetName}: ${verdict.blockers.join('; ')}.`);
    cancelAttack();
    rerender();
    return;
  }

  // M12 — Use the resolver totals (which include item/feat mods) for
  // both the to-hit and the damage dice. The M6-derived attack.bonus and
  // attack.dice were the baseline; resolver enriched them with combatMods.
  const finalBonus = verdict.attackBonus.total;
  const finalDmgDice = verdict.damage.dice;

  // Auto-crit short-circuits the d20: target is paralyzed/unconscious in
  // melee within 5ft → hit + crit without rolling. We still roll damage.
  let atk;
  if (verdict.autoCrit) {
    atk = {
      hit: true, crit: true,
      d20: { kept: 20, dice: [20], advantage: verdict.d20.mode },
      bonus: finalBonus, total: 20 + finalBonus, ac
    };
  } else {
    atk = rollAttack({ bonus: finalBonus, advantage: verdict.d20.mode, targetAC: ac });
  }

  let damage = 0;
  let dmgRoll = null;
  if (atk.hit) {
    dmgRoll = rollDamage(finalDmgDice, { crit: atk.crit });
    damage = dmgRoll.total;
    applyDamage(targetKind, targetEntity.id, damage);
  }
  // Feed into combat.js (animation + floating popup). Animations only
  // fire on hit since the existing pipeline expects a damage amount.
  if (atk.hit) {
    resolveAttackAnimation(targetEntity.id, targetKind, damage);
  } else {
    cancelAttack();
  }
  // M18 — Spell rolls always clear combat.spell so the next attack
  // defaults back to weapon mode.
  const label = spell?.name || weapon?.name || attack?.name || 'Attack';
  combat.spell = null;
  saveScene(currentScene);
  appendAttackLog({ attackerName, targetName, weaponName: label, verdict, atk, dmgRoll });
  setCombatStatus(formatAttackSummary({ attackerName, targetName, weaponName: label, verdict, atk, dmgRoll }));
  startContinuousRender();
}

// M21 — Spell-save resolution flow. Caster attacker, target's save bonus
// derived per-kind, save roll vs caster's DC, damage applied per the
// spell's saveOnHalf policy. Mirrors the M11 flow shape so the existing
// animation + log infrastructure works unchanged.
function runSpellSavePrompt(attackerHit, targetHit, spell) {
  const attackerName = entityName(attackerHit);
  const targetName   = targetHit.entity.name || 'Target';
  const stat = spell.saveStat || 'DEX';

  // Spell save DC: 8 + ability mod + proficiency. We compute via the
  // existing M18 helper but inline the DC formula to keep the shape
  // small here.
  const sa = spellAttackBonus(attackerHit.entity, spell);
  const dc = 8 + sa.total;

  // Target save bonus
  let targetSaveBonus = 0;
  if (targetHit.kind === 'pc') {
    targetSaveBonus = saveBonus(targetHit.entity, stat);
  } else {
    // Monster: look up SRD save bonus by preset slug. Unknown slugs
    // default to 0 (no proficiency, no ability mod).
    targetSaveBonus = monsterSaveBonus(targetHit.entity.presetSlug, stat);
  }

  // Roll!
  const result = resolveSpellSave({
    spell, targetSaveBonus, dc, advantage: 'normal'
  });

  // Apply damage if the spell deals damage on this outcome.
  if (result.damage > 0) {
    applyDamage(targetHit.kind, targetHit.entity.id, result.damage);
    resolveAttackAnimation(targetHit.entity.id, targetHit.kind, result.damage);
  }
  combat.spell = null;
  cancelAttack();
  saveScene(currentScene);

  // Log entry — structured save line, distinct from the attack log so
  // the user can tell at a glance which kind of roll happened.
  appendSaveLog({
    attackerName, targetName, spell, dc, stat,
    targetSaveBonus, result
  });
  setCombatStatus(formatSaveSummary({ attackerName, targetName, spell, result }));
  startContinuousRender();
}

function formatSaveSummary({ attackerName, targetName, spell, result }) {
  const verdict = result.save.success ? 'saves' : 'fails';
  const tail = result.damage > 0
    ? `→ ${result.damage} ${spell.damageType || 'damage'} (${result.outcome})`
    : result.outcome === 'half'
      ? '→ half damage'
      : result.outcome === 'none'
        ? '→ no damage'
        : '→ no damage';
  return `${attackerName} casts ${spell.name} on ${targetName}: ${targetName} ${verdict} (d20=${result.save.kept}${result.save.bonus >= 0 ? '+' : ''}${result.save.bonus}=${result.save.total} vs DC ${result.save.dc}) ${tail}.`;
}

function appendSaveLog({ attackerName, targetName, spell, dc, stat, targetSaveBonus, result }) {
  const wrap = document.getElementById('roll-log');
  const list = document.getElementById('roll-log-list');
  if (!wrap || !list) return;
  wrap.hidden = false;
  const li = document.createElement('li');
  const outcomeClass = result.save.success
    ? (result.outcome === 'half' ? 'roll-hit' : 'roll-miss')
    : 'roll-hit';
  li.className = `roll-log-entry ${outcomeClass}`;
  const outcomeWord = result.save.success
    ? (result.outcome === 'half' ? 'SAVE (half)' : 'SAVE (no damage)')
    : 'FAIL';
  const sign = targetSaveBonus >= 0 ? '+' : '';
  const dmgLine = result.damage > 0
    ? `<div class="roll-line">Damage: ${escapeHtml(result.damageRoll.spec)} (rolls ${result.damageRoll.rolls.join(',')}) = <strong>${result.damage}</strong>${spell.damageType ? ' ' + escapeHtml(spell.damageType) : ''}${result.outcome === 'half' ? ' (halved)' : ''}</div>`
    : '';
  li.innerHTML = `
    <div class="roll-headline"><strong>${escapeHtml(attackerName)}</strong> casts <strong>${escapeHtml(spell.name)}</strong> on ${escapeHtml(targetName)} — <span class="roll-outcome">${outcomeWord}</span></div>
    <div class="roll-line">${escapeHtml(stat)} save: d20=${result.save.kept}${sign}${targetSaveBonus}=${result.save.total} vs DC ${dc}</div>
    ${dmgLine}
  `;
  list.insertBefore(li, list.firstChild);
  while (list.children.length > 20) list.removeChild(list.lastChild);
}

// Helper: pull the weapon record the attacker is using. For PCs that's
// equipment.mainhand; for monsters we don't have a weapon record (we use
// the preset's attack block), so return null and let the resolver use
// the synthetic attackStats.
function getAttackerWeapon(hit) {
  if (!hit) return null;
  if (hit.kind === 'pc') return hit.entity.equipment?.mainhand || null;
  return null;
}

// One-liner status text (kept compact for the small panel). The roll-log
// entry has the full structured breakdown.
function formatAttackSummary({ attackerName, targetName, weaponName, verdict, atk, dmgRoll }) {
  if (verdict.autoCrit) {
    return `${attackerName} auto-crits ${targetName} (${verdict.autoCritReason}): ${weaponName} ${verdict.damage.dice} = ${dmgRoll.total}`;
  }
  return describeAttack({
    attackerName, targetName, weaponName,
    atk, dmg: dmgRoll || { total: 0, rolls: [], spec: verdict.damage.dice }
  });
}

// Append a structured entry to the roll log. Hit/miss/crit get colored
// borders; reasons render under the headline so the user can see exactly
// what fed into the d20 mode.
function appendAttackLog({ attackerName, targetName, weaponName, verdict, atk, dmgRoll }) {
  const wrap = document.getElementById('roll-log');
  const list = document.getElementById('roll-log-list');
  if (!wrap || !list) return;
  wrap.hidden = false;
  const li = document.createElement('li');
  li.className = `roll-log-entry ${atk.crit ? 'roll-crit' : atk.hit ? 'roll-hit' : 'roll-miss'}`;
  const outcomeWord = verdict.autoCrit ? 'AUTO-CRIT' : atk.crit ? 'CRIT' : atk.hit ? 'HIT' : 'MISS';
  const d20Str = atk.d20.dice.length === 1
    ? `d20=${atk.d20.kept}`
    : `d20=${atk.d20.kept} (${atk.d20.advantage} of ${atk.d20.dice.join(',')})`;
  const sign = atk.bonus >= 0 ? '+' : '';
  const dmgLine = atk.hit && dmgRoll
    ? `<div class="roll-line">Damage: ${escapeHtml(verdict.damage.dice)} (rolls ${dmgRoll.rolls.join(',')}) = <strong>${dmgRoll.total}</strong>${verdict.damage.damageType ? ' ' + escapeHtml(verdict.damage.damageType) : ''}</div>`
    : '';
  const reasonsHtml = [];
  if (verdict.d20.advantage.length) reasonsHtml.push(`<span class="reason-adv">Adv: ${verdict.d20.advantage.map(reasonChip).join(', ')}</span>`);
  if (verdict.d20.disadvantage.length) reasonsHtml.push(`<span class="reason-dis">Dis: ${verdict.d20.disadvantage.map(reasonChip).join(', ')}</span>`);
  if (verdict.d20.overrideApplied) reasonsHtml.push(`<span class="reason-override">${reasonChip('Override: ' + verdict.d20.mode)}</span>`);
  if (verdict.autoCritReason) reasonsHtml.push(`<span class="reason-crit">${reasonChip(verdict.autoCritReason)}</span>`);
  const reasonsBlock = reasonsHtml.length ? `<div class="roll-reasons">${reasonsHtml.join(' · ')}</div>` : '';

  // M12 — Attack-bonus breakdown (every part: STR mod, prof, +N items/feats).
  // Only show when there's more than one part so trivial attacks stay tidy.
  const breakdownBlock = verdict.attackBonus?.parts?.length > 1
    ? `<div class="roll-breakdown">Attack: ${verdict.attackBonus.parts.map(p => `<span class="part">${escapeHtml(p.source)} ${p.value >= 0 ? '+' : ''}${p.value}</span>`).join(' ')}</div>`
    : '';

  // M15 — Class-feature availability on a hit. Only show on actual hits
  // (no point telling the rogue they could have sneak-attacked on a miss).
  const availableFeatures = atk.hit ? (verdict.features || []).filter(f => f.available) : [];
  const featuresBlock = availableFeatures.length
    ? `<div class="roll-features">${availableFeatures.map(f =>
        `<span class="feature-chip">✨ ${escapeHtml(f.name)}: <strong>${escapeHtml(f.dice)}</strong> <button class="feature-roll-btn" type="button" data-dice="${escapeHtml(f.dice)}" data-name="${escapeHtml(f.name)}" aria-label="Roll ${escapeHtml(f.name)} bonus damage">🎲</button></span>`
      ).join(' ')}</div>`
    : '';
  li.innerHTML = `
    <div class="roll-headline"><strong>${escapeHtml(attackerName)}</strong> → ${escapeHtml(targetName)} (${escapeHtml(weaponName)}) — <span class="roll-outcome">${outcomeWord}</span></div>
    <div class="roll-line">${d20Str}${sign}${atk.bonus}=${atk.total} vs AC ${verdict.targetAC}</div>
    ${dmgLine}
    ${breakdownBlock}
    ${featuresBlock}
    ${reasonsBlock}
  `;
  list.insertBefore(li, list.firstChild);
  while (list.children.length > 20) list.removeChild(list.lastChild);
}

/**
 * Apply HP damage (positive number) or healing (negative). For PCs we
 * adjust the per-party HP override (stored on the composed character —
 * not persisted across imports, but works for the current session). For
 * monsters we mutate the scene's monster instance directly.
 */
function applyDamage(targetKind, targetId, damage) {
  if (targetKind === 'monster') {
    const m = (currentScene.monsters || []).find(x => x.id === targetId);
    if (!m) return;
    const next = Math.max(0, Math.min(m.hp.max, m.hp.current - damage));
    m.hp = { ...m.hp, current: next };
    return;
  }
  // PC — adjust the rendered character's HP. This stays in-session.
  const pc = partyComposedCharacters.find(c => String(c.id) === String(targetId));
  if (!pc || !pc.hp) return;
  const next = Math.max(0, Math.min(pc.hp.max, (pc.hp.current ?? pc.hp.max) - damage));
  pc.hp = { ...pc.hp, current: next };
}

// Continuous-render loop. Driven by requestAnimationFrame so animations
// run at display refresh rate. Auto-stops once all animations / popups
// have expired AND the walk-cycle animation isn't running.
let continuousRAF = null;
function startContinuousRender() {
  if (continuousRAF) return;
  const tick = () => {
    pruneExpired();
    rerender();
    if (hasActiveAnimations() || animating) {
      continuousRAF = requestAnimationFrame(tick);
    } else {
      continuousRAF = null;
    }
  };
  continuousRAF = requestAnimationFrame(tick);
}

// Esc cancels attack mode (and clears combat status)
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && combat.mode !== 'idle') {
    cancelAttack();
    combat.spell = null;
    hideAttackPreview();
    setCombatStatus('Cancelled.');
    rerender();
  }
  // M8 — Esc also cancels AoE placing mode
  if (e.key === 'Escape' && aoePlacing) {
    aoePlacing = false;
    setCombatStatus('AoE placement cancelled.');
  }
});

document.addEventListener('click', (e) => {
  if (e.target.id === 'attack-btn') {
    if (combat.mode === 'idle') {
      beginAttack();
      setCombatStatus('Click an entity to attack with. Esc to cancel.');
    } else {
      cancelAttack();
      setCombatStatus('Cancelled.');
    }
    rerender();
  }
  if (e.target.id === 'init-roll') {
    rollInitiative();
  }
  if (e.target.id === 'init-next') {
    advanceTurn();
  }
  if (e.target.id === 'init-clear') {
    currentScene.initiative = [];
    saveScene(currentScene);
    rerender();
  }
});

// ---------- M4: Initiative tracker ----------
//
// Initiative is an ordered list on the scene. Each entry:
//   { entityId, entityKind, name, score, active }
//
// `Roll initiative` generates d20 + 0 for each entity (lightweight v1 —
// proper DEX-based mods can come later). `Next turn` advances the active
// marker. The active entity gets a yellow outline on the canvas.

function rollInitiative() {
  const entries = [];
  for (const pc of partyComposedCharacters) {
    entries.push({
      entityId: pc.id, entityKind: 'pc', name: pc.name,
      score: 1 + Math.floor(Math.random() * 20),
      active: false
    });
  }
  for (const m of (currentScene.monsters || [])) {
    entries.push({
      entityId: m.id, entityKind: 'monster', name: m.name,
      score: 1 + Math.floor(Math.random() * 20),
      active: false
    });
  }
  entries.sort((a, b) => b.score - a.score);
  if (entries.length > 0) entries[0].active = true;
  currentScene.initiative = entries;
  saveScene(currentScene);
  rerender();
}

function advanceTurn() {
  const init = currentScene.initiative || [];
  if (init.length === 0) return;
  const cur = init.findIndex(i => i.active);
  init.forEach(i => { i.active = false; });
  init[(cur + 1) % init.length].active = true;
  currentScene.initiative = init;
  saveScene(currentScene);
  rerender();
}

function renderInitiativeTracker() {
  const wrap = document.getElementById('initiative-tracker');
  if (!wrap) return;
  const init = currentScene.initiative || [];
  if (init.length === 0) {
    wrap.innerHTML = '<p class="hint-line">Press <strong>Roll initiative</strong> to start.</p>';
    return;
  }
  wrap.innerHTML = '';
  for (const ent of init) {
    const row = document.createElement('div');
    row.className = `init-row${ent.active ? ' active' : ''}`;
    row.innerHTML = `
      <span class="init-score">${ent.score}</span>
      <span class="init-name">${escapeHtml(ent.name || '(entity)')}</span>
      <span class="init-kind">${ent.entityKind === 'pc' ? 'PC' : 'M'}</span>
    `;
    wrap.appendChild(row);
  }
}

// M17 — Active-turn actions panel.
//
// Drives the new #actions-panel: shows attacks (filtered by reach/range
// vs hostiles on the map), class features (with dice + uses), and
// common actions (Dash/Dodge/Hide/etc.) for the "active" entity in the
// scene. Active resolution:
//   1. the entity currently flagged active in initiative
//   2. else the selected attacker (combat.attacker)
//   3. else the first PC in the party (planning aid before combat starts)
//
// The user can override via the "Change…" button (prompts for an entity
// by name) — useful for inspecting other party members' options
// out-of-turn.
let actionsSubjectOverride = null;   // entityId; null = auto

function resolveActionsSubject() {
  if (actionsSubjectOverride) {
    const fromOverride = findActionsSubjectById(actionsSubjectOverride);
    if (fromOverride) return fromOverride;
    actionsSubjectOverride = null;   // stale id — fall through to auto
  }
  // Initiative active
  const init = (currentScene.initiative || []).find(i => i.active);
  if (init) {
    const found = findActionsSubjectById(init.entityId);
    if (found) return found;
  }
  // Selected attacker
  if (combat.attacker?.id) {
    const found = findActionsSubjectById(combat.attacker.id);
    if (found) return found;
  }
  // Fallback: first PC
  if (partyComposedCharacters.length) {
    return { entity: partyComposedCharacters[0], kind: 'pc' };
  }
  return null;
}

function findActionsSubjectById(id) {
  const idStr = String(id);
  for (const pc of partyComposedCharacters) {
    if (String(pc.id) === idStr) return { entity: pc, kind: 'pc' };
  }
  for (const m of (currentScene.monsters || [])) {
    if (String(m.id) === idStr) return { entity: m, kind: 'monster' };
  }
  return null;
}

function renderActionsPanel() {
  const panel = document.getElementById('actions-panel');
  if (!panel) return;
  const subject = resolveActionsSubject();
  const subjectEl  = document.getElementById('actions-subject');
  const blockersEl = document.getElementById('actions-blockers');
  const attackList = document.getElementById('actions-attacks-list');
  const featList   = document.getElementById('actions-features-list');
  const commonList = document.getElementById('actions-common-list');
  if (!subject) {
    subjectEl.textContent = 'No active turn';
    blockersEl.hidden = true;
    attackList.innerHTML = '<div class="actions-empty">Add a character to your party to see actions.</div>';
    featList.innerHTML = '';
    commonList.innerHTML = '';
    return;
  }
  subjectEl.textContent = subject.entity.name || 'Unnamed';

  // Pre-resolve _position for every PC + monster so the actions builder
  // can find them on the grid without separate lookups. The subject
  // entity must also be augmented — positionOf falls back to a default
  // grid slot when no drag-saved position exists, but the actions
  // module's plain lookup doesn't, so we need to feed it the resolved
  // position explicitly.
  const party = partyComposedCharacters.map((pc, i) => ({
    ...pc, _position: positionOf(currentScene, pc.id, i)
  }));
  const monsters = (currentScene.monsters || []).map(m => ({ ...m }));

  // Find the subject in the augmented party (PC) or monsters (monster)
  // so it has a resolved _position.
  let augmentedSubject = subject.entity;
  if (subject.kind === 'pc') {
    augmentedSubject = party.find(p => String(p.id) === String(subject.entity.id)) || subject.entity;
  } else {
    augmentedSubject = monsters.find(m => String(m.id) === String(subject.entity.id)) || subject.entity;
  }

  const result = buildActionsFor({
    entity: augmentedSubject, kind: subject.kind,
    scene: currentScene, party, monsters
  });

  if (result.blockers.length) {
    blockersEl.hidden = false;
    blockersEl.innerHTML = result.blockers.map(b => `⛔ ${reasonChip(b)}`).join(' · ');
  } else {
    blockersEl.hidden = true;
  }

  // M22 — Turn coach: surface the top ~5 opportunities for the active
  // entity at the head of the panel. Updates with every rerender, so
  // the list responds to drag, condition toggle, and turn advance.
  const coachWrap = document.getElementById('actions-coach');
  const coachList = document.getElementById('coach-tips-list');
  if (coachWrap && coachList) {
    const tips = buildTurnTips({
      entity: augmentedSubject, kind: subject.kind,
      scene: currentScene, party, monsters, max: 5
    });
    if (tips.length === 0) {
      coachWrap.hidden = true;
      coachList.innerHTML = '';
    } else {
      coachWrap.hidden = false;
      coachList.innerHTML = tips.map(t => `
        <li class="coach-tip coach-tip-${t.kind}">
          <span class="coach-icon">${escapeHtml(t.icon || '•')}</span>
          <span class="coach-text">${escapeHtml(t.text)}</span>
        </li>
      `).join('');
    }
  }

  // Attacks
  attackList.innerHTML = '';
  if (result.attacks.length === 0) {
    attackList.innerHTML = '<div class="actions-empty">No weapons available.</div>';
  } else {
    for (const a of result.attacks) {
      const row = document.createElement('div');
      row.className = `action-row ${a.available ? 'available' : 'unavailable'}`;
      const sign = a.bonus >= 0 ? '+' : '';
      const targets = a.targetsInRange.length;
      const status = a.available
        ? `<span class="action-status ok">${targets} target${targets === 1 ? '' : 's'} ${a.isRanged ? 'in range' : 'in reach'}</span>`
        : `<span class="action-status off">${reasonChip(a.blockReason || 'unavailable')}</span>`;
      const hints = a.hints.length
        ? `<div class="action-hints">${a.hints.map(h => `<span class="action-hint">✨ ${escapeHtml(h)}</span>`).join(' ')}</div>`
        : '';
      row.innerHTML = `
        <div class="action-row-head">
          <span class="action-name">${escapeHtml(a.name)}</span>
          <span class="action-stat">${sign}${a.bonus} · ${escapeHtml(a.dice)}${a.damageType ? ' ' + escapeHtml(a.damageType) : ''}</span>
        </div>
        <div class="action-row-meta">
          <span class="action-range">${a.isRanged ? `Range ${a.reachFt} ft` : `Reach ${a.reachFt} ft`}</span>
          ${status}
        </div>
        ${hints}
      `;
      attackList.appendChild(row);
    }
  }

  // M18 — Spells
  const spellList = document.getElementById('actions-spells-list');
  if (spellList) {
    spellList.innerHTML = '';
    const spells = result.spells || [];
    if (spells.length === 0) {
      spellList.innerHTML = '<div class="actions-empty">No spells prepared.</div>';
    } else {
      for (const s of spells) {
        const row = document.createElement('div');
        row.className = `action-row ${s.available ? 'available' : 'unavailable'}`;
        const levelLabel = s.level === 0 ? 'Cantrip' : `L${s.level}`;
        const sign = s.attackBonus >= 0 ? '+' : '';
        // For attack-roll spells show the to-hit + damage. For save-based
        // spells show the DC + damage + the save stat the target rolls.
        let statChip = '';
        if (s.requiresAttackRoll) {
          statChip = `<span class="action-stat">${sign}${s.attackBonus} to hit · ${escapeHtml(s.dice || '')}${s.damageType ? ' ' + escapeHtml(s.damageType) : ''}</span>`;
        } else if (s.requiresSavingThrow) {
          statChip = `<span class="action-stat">DC ${s.saveDC} ${escapeHtml(s.saveStat || 'save')} · ${escapeHtml(s.dice || '')}${s.damageType ? ' ' + escapeHtml(s.damageType) : ''}</span>`;
        } else if (s.dice) {
          statChip = `<span class="action-stat">${escapeHtml(s.dice)}${s.damageType ? ' ' + escapeHtml(s.damageType) : ''}</span>`;
        }
        const meta = [];
        meta.push(`<span class="action-source">${escapeHtml(levelLabel)}${s.school ? ' · ' + escapeHtml(s.school) : ''}${s.concentration ? ' · Conc.' : ''}${s.requiresSavingThrow && !s.requiresAttackRoll ? ' · Save spell' : ''}</span>`);
        if (s.rangeKind === 'ranged') {
          meta.push(`<span class="action-range">Range ${s.rangeFt} ft</span>`);
        } else {
          meta.push(`<span class="action-range">${escapeHtml(s.rangeKind || 'self')}</span>`);
        }
        if (s.available) {
          if (s.requiresAttackRoll || s.requiresSavingThrow) {
            meta.push(`<span class="action-status ok">${s.targetsInRange.length} target${s.targetsInRange.length === 1 ? '' : 's'} in range</span>`);
          }
        } else {
          meta.push(`<span class="action-status off">${reasonChip(s.blockReason || 'unavailable')}</span>`);
        }
        row.innerHTML = `
          <div class="action-row-head">
            <span class="action-name">${escapeHtml(s.name)}</span>
            ${statChip}
          </div>
          <div class="action-row-meta">
            ${meta.join('')}
          </div>
        `;
        // Click handler — only attack-roll spells run through the full
        // combat flow for now. Save-based spells log a reminder so the
        // DM tracks the save manually (auto-save resolution is M19-ish).
        if (s.available && (s.requiresAttackRoll || s.requiresSavingThrow)) {
          // Both branches enter pick-target mode with the spell queued
          // on combat.spell. runAttackPrompt branches on the spell's
          // requiresSavingThrow flag to either roll an attack or roll
          // the target's save.
          row.addEventListener('click', () => {
            beginSpellAttack(subject, s.spell);
          });
          row.classList.add('action-row-clickable');
        }
        spellList.appendChild(row);
      }
    }
  }

  // Features
  featList.innerHTML = '';
  if (result.features.length === 0) {
    featList.innerHTML = '<div class="actions-empty">No actionable class features.</div>';
  } else {
    for (const f of result.features) {
      const row = document.createElement('div');
      row.className = 'action-row available';
      const diceChip = f.dice ? `<span class="action-stat">${escapeHtml(f.dice)}</span>` : '';
      const usesChip = f.uses ? `<span class="action-uses">${f.uses.max}${f.uses.reset ? ' / ' + escapeHtml(f.uses.reset) : ''}</span>` : '';
      row.innerHTML = `
        <div class="action-row-head">
          <span class="action-name">${escapeHtml(f.name)}</span>
          ${diceChip}
        </div>
        <div class="action-row-meta">
          <span class="action-source">${escapeHtml(f.source || '')}${f.level ? ` · L${f.level}` : ''}</span>
          ${usesChip}
        </div>
      `;
      featList.appendChild(row);
    }
  }

  // Common actions
  commonList.innerHTML = '';
  for (const c of result.common) {
    const row = document.createElement('div');
    row.className = `action-row ${c.available ? 'available' : 'unavailable'}`;
    const status = c.available
      ? (c.blockReason ? `<span class="action-status warn">${reasonChip(c.blockReason)}</span>` : '')
      : `<span class="action-status off">${reasonChip(c.blockReason || 'unavailable')}</span>`;
    row.innerHTML = `
      <div class="action-row-head">
        <span class="action-name">${escapeHtml(c.name)}</span>
        ${status}
      </div>
      <div class="action-row-meta">
        <span class="action-source">${escapeHtml(c.summary)}</span>
      </div>
    `;
    row.addEventListener('click', () => appendRollLog(`${subject.entity.name || 'Entity'} took the ${c.name} action.`));
    commonList.appendChild(row);
  }
}

// M18 — Spell attack: set the spell as the active cast, pre-select the
// attacker, then enter pick-target mode. The pointer-down handler picks
// it up via combat.mode and routes into runAttackPrompt — but the runner
// checks combat.spell to switch from weapon to spell flow.
function beginSpellAttack(subject, spell) {
  beginAttack();
  selectAttacker(subject.entity.id, subject.kind);
  combat.spell = spell;     // ← extension to the M11/M4 combat state
  setCombatStatus(`${subject.entity.name} casts ${spell.name} — click a target.`);
  rerender();
}

document.addEventListener('click', (e) => {
  if (e.target.id !== 'actions-pick') return;
  const choices = [
    ...partyComposedCharacters.map(c => ({ id: c.id, name: c.name || 'PC' })),
    ...(currentScene.monsters || []).map(m => ({ id: m.id, name: m.name || 'Monster' }))
  ];
  if (choices.length === 0) return;
  const list = choices.map((c, i) => `${i + 1}. ${c.name}`).join('\n');
  const pick = window.prompt(`Show actions for which entity?\n\n${list}\n\nEnter number:`);
  if (pick === null) return;
  const idx = parseInt(pick, 10) - 1;
  if (idx >= 0 && idx < choices.length) {
    actionsSubjectOverride = choices[idx].id;
    renderActionsPanel();
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
  const fl = document.getElementById('scene-flanking');
  if (fl) fl.checked = !!currentScene.flankingEnabled;
  renderScenePicker();
}

// ---------- M5: Multi-scene management ----------
//
// All scenes live in one localStorage container; only one is active at
// a time. Switching saves the current scene first (drag positions, monster
// changes etc. are already persisted as they happen, so this is just a
// safety belt) then loads the chosen scene into currentScene and re-syncs
// every panel.

function renderScenePicker() {
  const sel = document.getElementById('scene-picker');
  if (!sel) return;
  const scenes = listScenes();
  const activeId = getActiveSceneId();
  sel.innerHTML = '';
  for (const s of scenes) {
    const opt = document.createElement('option');
    opt.value = s.id;
    opt.textContent = s.name;
    if (s.id === activeId) opt.selected = true;
    sel.appendChild(opt);
  }
  // Disable Delete when only one scene remains
  const del = document.getElementById('scene-delete');
  if (del) del.disabled = scenes.length <= 1;
}

function switchToScene(id) {
  // Persist anything pending on the current scene, then swap.
  saveScene(currentScene);
  const next = setActiveScene(id);
  if (!next) return;
  currentScene = next;
  // M4 — initiative + combat state are per-scene (they live on scene
  // and reset when we move to a different scene's container slot).
  // We don't tear down the in-flight combat.attacker because that's a
  // transient UI mode; the user can press Esc to cancel after the swap.
  syncBattlefieldControls();
  if (viewMode === 'party') rerender();
}

document.addEventListener('change', (e) => {
  if (e.target.id !== 'scene-picker') return;
  switchToScene(e.target.value);
});

document.addEventListener('click', (e) => {
  if (e.target.id === 'scene-new') {
    const name = window.prompt('Name for the new scene:', `Scene ${listScenes().length + 1}`);
    if (name === null) return;
    saveScene(currentScene);
    const id = createScene(name.trim() || 'New scene');
    switchToScene(id);
  }
  if (e.target.id === 'scene-duplicate') {
    saveScene(currentScene);
    const id = duplicateScene();
    if (id) switchToScene(id);
  }
  if (e.target.id === 'scene-rename') {
    const id = getActiveSceneId();
    const current = listScenes().find(s => s.id === id);
    const name = window.prompt('Rename scene:', current?.name || '');
    if (name === null) return;
    renameScene(id, name);
    renderScenePicker();
  }
  if (e.target.id === 'scene-delete') {
    const scenes = listScenes();
    if (scenes.length <= 1) return;
    const id = getActiveSceneId();
    const current = scenes.find(s => s.id === id);
    if (!window.confirm(`Delete scene "${current?.name || 'this scene'}"? This cannot be undone.`)) return;
    deleteScene(id);
    // After deletion, the state layer has already picked a new active id —
    // reload it.
    currentScene = loadScene();
    syncBattlefieldControls();
    if (viewMode === 'party') rerender();
  }
});

// ---------- M2.5: Scene presets + custom image background ----------
//
// Presets are predefined { map, grid.color } pairs — clicking one swaps
// the battlefield's look without touching positions / monsters / initiative.
// Custom-image uploads are read via FileReader, downsized to <=1024px on
// the longest side (so localStorage isn't blown out by 4k photos), and
// stored as a data URL on scene.map.image.

function renderScenePresetList() {
  const wrap = document.getElementById('scene-preset-list');
  if (!wrap) return;
  if (wrap.dataset.populated === '1') return;
  wrap.dataset.populated = '1';
  for (const slug of Object.keys(SCENE_PRESETS)) {
    const p = SCENE_PRESETS[slug];
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'scene-preset-btn';
    b.dataset.preset = slug;
    b.title = p.name;
    const swatch = document.createElement('span');
    swatch.className = 'scene-preset-swatch';
    swatch.style.background = p.map.color;
    b.appendChild(swatch);
    const label = document.createElement('span');
    label.className = 'scene-preset-label';
    label.textContent = p.name;
    b.appendChild(label);
    wrap.appendChild(b);
  }
}

function applyScenePreset(slug) {
  const p = SCENE_PRESETS[slug];
  if (!p) return;
  currentScene.map  = { ...p.map };
  currentScene.grid = { ...(currentScene.grid || {}), ...p.grid };
  saveScene(currentScene);
  syncBattlefieldControls();
  if (viewMode === 'party') rerender();
}

document.addEventListener('click', (e) => {
  const btn = e.target.closest('.scene-preset-btn');
  if (!btn) return;
  applyScenePreset(btn.dataset.preset);
});

// Custom background image: read file → resize → data URL → save
document.addEventListener('change', (e) => {
  if (e.target.id !== 'scene-bg-image') return;
  const file = e.target.files?.[0];
  if (!file) return;
  loadImageAsDataUrl(file, 1024).then(dataUrl => {
    currentScene.map = { kind: 'image', color: currentScene.map?.color || '#3d5a3d', image: dataUrl };
    saveScene(currentScene);
    if (viewMode === 'party') rerender();
    e.target.value = '';   // allow re-selecting the same file later
  }).catch(err => {
    setStatus(`Could not load image: ${err.message}`, 'error');
  });
});

document.addEventListener('click', (e) => {
  if (e.target.id !== 'scene-bg-image-clear') return;
  const color = currentScene.map?.color || '#3d5a3d';
  currentScene.map = { kind: 'color', color };
  saveScene(currentScene);
  if (viewMode === 'party') rerender();
});

/**
 * Read a File as an Image, downsize so the longest edge is <= maxEdge,
 * and return a PNG data URL. Used to keep localStorage payloads modest
 * (a 4k photo would blow the 5MB quota by itself).
 */
function loadImageAsDataUrl(file, maxEdge = 1024) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('file read failed'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('not a valid image'));
      img.onload = () => {
        const ratio = Math.min(1, maxEdge / Math.max(img.width, img.height));
        const w = Math.round(img.width * ratio);
        const h = Math.round(img.height * ratio);
        const off = document.createElement('canvas');
        off.width = w; off.height = h;
        const ctx = off.getContext('2d');
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, 0, 0, w, h);
        try { resolve(off.toDataURL('image/jpeg', 0.85)); }
        catch (err) { reject(err); }
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
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
    pruneExpired();
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
    // M23 — re-import diff. If the server returned a previous parse,
    // diff it against the new one and show a "what changed" banner.
    // Also preserve in-session HP / conditions on any party member
    // who's being re-imported, so a re-sync doesn't wipe live damage.
    const diff = data.previous ? diffCharacters(data.previous, data.character) : [];
    if (data.previous) preserveInSessionState(data.character);

    const generatedCount = await render(data.character);
    const suffix = generatedCount > 0
      ? ` — generated ${generatedCount} item sprite${generatedCount === 1 ? '' : 's'}`
      : '';
    setStatus(`Loaded ${data.character.name} (${data.source})${suffix}.`, 'ok');
    if (data.previous) renderSyncBanner(data.character, diff);
    refreshRecentCharacters();  // re-pull after a successful import
    refreshParty();              // re-mark the active card in the party strip
  } catch (err) {
    setStatus(err.message, 'error', err.hint);
  }
}

// M23 — Carry in-session HP / conditions from the rendered party copy
// into the freshly-parsed character so a re-sync doesn't reset live
// damage or condition toggles. The new max HP is honored; current is
// clamped into the new range.
function preserveInSessionState(nextChar) {
  const cached = partyComposedCharacters.find(c => String(c.id) === String(nextChar.id));
  if (!cached) return;   // not in active party — nothing to preserve
  if (nextChar.hp && cached.hp?.current != null) {
    nextChar.hp.current = Math.min(nextChar.hp.max ?? cached.hp.current, cached.hp.current);
  }
  if (Array.isArray(cached.conditions) && cached.conditions.length) {
    nextChar.conditions = [...cached.conditions];
  }
}

// M23 — Render the sync banner. Builds a dismissible card listing every
// diff entry. No changes = no banner. The banner sits below the
// character header so it's noticed but doesn't block the sheet.
function renderSyncBanner(character, diff) {
  let banner = document.getElementById('sync-banner');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'sync-banner';
    banner.className = 'sync-banner';
    const charMeta = document.getElementById('char-meta');
    if (charMeta?.parentNode) charMeta.parentNode.insertBefore(banner, charMeta.nextSibling);
  }
  if (diff.length === 0) {
    banner.innerHTML = `<div class="sync-banner-head"><strong>Re-synced ${escapeHtml(character.name)}</strong> — no changes detected.</div>`;
    banner.dataset.empty = 'true';
  } else {
    delete banner.dataset.empty;
    const items = diff.slice(0, 12).map(d => `<li>${escapeHtml(describeDiff(d))}</li>`).join('');
    const overflow = diff.length > 12 ? `<li class="sync-overflow">…and ${diff.length - 12} more change${diff.length - 12 === 1 ? '' : 's'}</li>` : '';
    banner.innerHTML = `
      <div class="sync-banner-head">
        <strong>Re-synced ${escapeHtml(character.name)}</strong> — ${diff.length} change${diff.length === 1 ? '' : 's'} detected.
        <button class="sync-banner-dismiss" type="button" aria-label="Dismiss">✕</button>
      </div>
      <ul class="sync-banner-list">${items}${overflow}</ul>
    `;
  }
  banner.hidden = false;
}

document.addEventListener('click', (e) => {
  if (!e.target.matches('.sync-banner-dismiss')) return;
  const banner = document.getElementById('sync-banner');
  if (banner) banner.hidden = true;
});

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
  renderClassFeatures(effective.classFeatures);
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
  // M9 — weapon attack chip + Roll button. We treat anything with a
  // `damage` field as a weapon (covers carried weapons too, and avoids
  // misfiring on shields whose damage is null).
  let attackChip = '';
  if (item.damage && originalCharacter) {
    const atk = deriveWeaponAttack(originalCharacter, item);
    const sign = atk.bonus >= 0 ? '+' : '';
    const dmgType = atk.damageType ? ` ${escapeHtml(atk.damageType)}` : '';
    attackChip = `<span class="attack-chip" data-weapon="${escapeHtml(item.name)}" title="Roll attack with ${escapeHtml(item.name)}">${sign}${atk.bonus} · ${escapeHtml(atk.dice)}${dmgType} <button class="attack-roll-btn" type="button" data-weapon="${escapeHtml(item.name)}" aria-label="Roll ${escapeHtml(item.name)} attack">🎲</button></span>`;
  }
  li.innerHTML = `<span class="slot">${escapeHtml(slot)}</span><span class="item-cell">${nameSpan}${sparkle}${attuned}${attackChip}</span>`;
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

  // M9 — Carried weapons that the slot-picker routed to back / waist
  // (alternate-carry positions) still belong to the character. Render
  // them so the attack chip surfaces their damage too — otherwise the
  // sheet hides every weapon except the one currently in the main hand.
  const sheathed = (carried || []).filter(c => c.slot === 'back' || c.slot === 'waist');
  for (const c of sheathed) {
    const label = c.slot === 'back' ? 'Back' : 'Waist';
    const li = renderItemLi(label, c);
    li.classList.add('sheathed');
    list.appendChild(li);
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

// M9 — Weapon roll button + roll log. Clicking a 🎲 next to a weapon
// rolls a standalone attack (no target — just to-hit + damage, displayed
// in the roll log). Useful as a quick "what would this hit for?" check
// outside the combat panel's target-selection flow.
document.addEventListener('click', (e) => {
  if (!e.target.matches('.attack-roll-btn')) return;
  const weaponName = e.target.dataset.weapon;
  if (!weaponName || !originalCharacter) return;
  const weapon = findCarriedWeapon(originalCharacter, weaponName);
  if (!weapon) return;
  const atk = deriveWeaponAttack(originalCharacter, weapon);
  const d20 = 1 + Math.floor(Math.random() * 20);
  const dmgRoll = rollDamage(atk.dice, { crit: d20 === 20 });
  const crit = d20 === 20 ? ' CRIT!' : (d20 === 1 ? ' (nat 1)' : '');
  const total = d20 + atk.bonus;
  const sign = atk.bonus >= 0 ? '+' : '';
  appendRollLog(
    `${weaponName}: d20=${d20}${sign}${atk.bonus}=${total} to hit, damage ${dmgRoll.total} (${dmgRoll.rolls.join(',')}${atk.dice.match(/[+-]\d+/)?.[0] || ''})${crit}`
  );
});

document.addEventListener('click', (e) => {
  if (e.target.id !== 'roll-log-clear') return;
  const list = document.getElementById('roll-log-list');
  const wrap = document.getElementById('roll-log');
  if (list) list.innerHTML = '';
  if (wrap) wrap.hidden = true;
});

function findCarriedWeapon(character, name) {
  const inEq = Object.values(character.equipment || {}).filter(Boolean).flat();
  for (const it of inEq) if (it && it.name === name) return it;
  for (const it of (character.carried || [])) if (it && it.name === name) return it;
  return null;
}

function appendRollLog(line) {
  const wrap = document.getElementById('roll-log');
  const list = document.getElementById('roll-log-list');
  if (!wrap || !list) return;
  wrap.hidden = false;
  const li = document.createElement('li');
  li.textContent = line;
  list.insertBefore(li, list.firstChild);
  // Cap at 20 entries so an enthusiastic roller doesn't blow the DOM
  while (list.children.length > 20) list.removeChild(list.lastChild);
}

// M10 — Class & subclass abilities panel. Features come from the parser
// (parseClassFeatures), already filtered to the character's level and
// stripped of noise like ASI / proficiency placeholders. We group by
// source (e.g. "Cleric", "Twilight Domain") so subclass abilities
// cluster together.
function renderClassFeatures(features) {
  const heading = document.getElementById('abilities-heading');
  const wrap = document.getElementById('abilities-list');
  if (!heading || !wrap) return;
  const list = Array.isArray(features) ? features : [];
  if (list.length === 0) {
    heading.hidden = true;
    wrap.hidden = true;
    wrap.innerHTML = '';
    return;
  }
  heading.hidden = false;
  wrap.hidden = false;

  // Group by source
  const grouped = new Map();
  for (const f of list) {
    if (!grouped.has(f.source)) grouped.set(f.source, []);
    grouped.get(f.source).push(f);
  }

  wrap.innerHTML = '';
  for (const [source, items] of grouped) {
    const group = document.createElement('div');
    group.className = 'abilities-group';
    group.innerHTML = `<div class="abilities-source">${escapeHtml(source)}</div>`;
    const ul = document.createElement('ul');
    ul.className = 'abilities-items';
    for (const f of items) {
      ul.appendChild(renderAbilityLi(f));
    }
    group.appendChild(ul);
    wrap.appendChild(group);
  }
}

function renderAbilityLi(f) {
  const li = document.createElement('li');
  li.className = 'ability-feature';
  const diceChip = f.dice
    ? `<span class="ability-dice" title="Click to roll">${escapeHtml(f.dice)} <button class="ability-roll-btn" type="button" data-dice="${escapeHtml(f.dice)}" data-name="${escapeHtml(f.name)}" aria-label="Roll ${escapeHtml(f.name)}">🎲</button></span>`
    : '';
  const usesChip = f.uses
    ? `<span class="ability-uses">${f.uses.max}${f.uses.reset ? ` / ${escapeHtml(f.uses.reset)}` : ''}</span>`
    : '';
  const desc = f.description
    ? `<details class="ability-desc"><summary>Details</summary><p>${escapeHtml(f.description)}</p></details>`
    : '';
  li.innerHTML = `
    <div class="ability-head">
      <span class="ability-name">${escapeHtml(f.name)}</span>
      <span class="ability-level" title="Acquired at level ${f.level}">L${f.level}</span>
      ${usesChip}
      ${diceChip}
    </div>
    ${desc}
  `;
  return li;
}

// Roll button on dice-bearing class features. Reuses the M9 roll log
// so all ad-hoc rolls land in one place. Also drives M15's
// "Roll Sneak Attack damage" button on roll log entries.
document.addEventListener('click', (e) => {
  if (!e.target.matches('.ability-roll-btn, .feature-roll-btn')) return;
  const dice = e.target.dataset.dice;
  const name = e.target.dataset.name;
  if (!dice) return;
  const dmg = rollDamage(dice, { crit: false });
  appendRollLog(`${name}: ${dice} (rolls ${dmg.rolls.join(',')}) = ${dmg.total}`);
});

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

// M19 — Reason chip: wraps a reason string in a <span> with a hover
// tooltip explaining the 5e rule it came from. Returns just the escaped
// text when no rule is registered, so callers always get a safe string.
function reasonChip(reason) {
  if (reason == null) return '';
  const text = escapeHtml(String(reason));
  const tip = tooltipFor(String(reason));
  if (!tip) return `<span class="rule-chip">${text}</span>`;
  return `<span class="rule-chip rule-chip-has-tip" title="${escapeHtml(tip)}">${text}</span>`;
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
