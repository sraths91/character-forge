import { renderSprite, renderBattleScene } from './sprite/compositor.js';
import { loadOverrides, saveOverrides, assignCarriedSlots } from './sprite/slot-overrides.js';
import { loadAppearance, saveAppearance, applyAppearanceOverrides } from './sprite/appearance-overrides.js';
import {
  loadScene, saveScene as saveSceneToStorage, positionOf, setPosition, clearPositions, clampPosition,
  addMonsterInstance, removeMonsterInstance, updateMonsterPosition, entityAt,
  setMonsterCondition,
  SCENE_PRESETS,
  listScenes, setActiveScene, createScene, duplicateScene, renameScene, deleteScene, getActiveSceneId
} from './scene/scene-state.js';
import { MONSTER_PRESETS, buildMonsterCharacter } from './scene/monster-presets.js';
import {
  combat, beginAttack, cancelAttack, selectAttacker,
  pruneExpired, hasActiveAnimations, entityAnimations, damagePopups,
  effects as effectQueue
} from './scene/combat.js';
import { rollDamage } from './scene/combat-roll.js';
import { deriveWeaponAttack } from './scene/pc-stats.js';
import { buildActionsFor } from './scene/actions-panel.js';
import { templateCells, entitiesInTemplate } from './scene/aoe.js';
import { tooltipFor } from './scene/rules-reference.js';
import { buildTurnTips } from './scene/turn-coach.js';
import { simulateEncounter } from './scene/simulator.js';
import { calibrateEncounter } from './scene/calibrator.js';
import { diffCharacters, describeDiff } from './character/diff-character.js';
import { buildSceneSnapshot, restoreSceneFromSnapshot } from './scene/scene-snapshot.js';
import { inferProfile } from './scene/ai/infer.js';
import {
  editableProfileFor, applyWeightChange, applyRetreatChange,
  applyArchetypeSwap, listArchetypes, listConsiderations
} from './scene/ai/editor.js';
import { matchPresetForOpen5e } from './client/monster-match.js';
import { previewMove, moveIntent } from './client/intents.js';
import {
  createCamera, attachCameraControls, screenToWorld, zoomAt, fitToGrid, clampCamera, WORLD_CELL_PX
} from './map/camera.js';
import { phaseAt } from './anim/cinema.js';
import { motionForWeapon } from './anim/weapon-motions.js';
import {
  availableStyles, styleForPc, saveStyle, isStyle
} from './anim/motion-styles.js';
import {
  SWING_TYPES, availableSwings, swingForPc, saveSwing, isSwing, isSwingSelection
} from './anim/swing-types.js';
import { bodyAnimForSwing } from './anim/cinema-plan.js';
import { idlePoseAt } from './anim/idle-pose.js';
import { springConfig, springStep, hipSwayAt } from './anim/secondary-motion.js';
import { createThreeViewer } from './anim/three-viewer.js';
import {
  preloadActorSprite, makeLpcDrawSprite,
  setActorWeapon, clearActorWeapon, drawWeaponOverlay, preloadActorAttack
} from './anim/cinema-sprites.js';
import { listBiomes, isBiome } from './scene/map-generator.js';
import { createVersusEncounter } from './scene/encounter-setup.js';
// M65 V22 — the live runner (unified combat engine via scene/live-bridge.js)
// is the classic driver's, client/legacy/classic-versus.js, imported only behind
// ?classic=1 (see loadClassicVersus).
// M65 V21 — "Play at the table": the versus panel hands the party and the
// queued encounter to a server-hosted solo room (play.html).
import { createApi } from './client/api.js';
import { createRoomCreds } from './client/room-creds.js';
import { handoffToTable, stashForgeJson } from './client/forge-handoff.js';

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

// Phase E3 — Condition checkboxes. M64 C10 / F7: scoped to the forge's
// appearance picker — monster cards also render [data-condition]
// checkboxes, which must not leak into the character's appearance.
document.addEventListener('change', (e) => {
  if (!e.target.matches('#appearance-picker [data-condition]')) return;
  const conditions = [...document.querySelectorAll('#appearance-picker [data-condition]:checked')].map(el => el.dataset.condition);
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

// M64 M8 — battlefield camera state (see syncBfCamera) and the versus
// drag preview; declared before rerender so no call can hit the TDZ.
const BF_ZOOM_MIN = 0.5;   // relative to "fit the whole grid"
const BF_ZOOM_MAX = 3.0;
const BF_ZOOM_STEP = 1.25;
const bfCamera = createCamera({ zoom: 1, minZoom: 0.05, maxZoom: 8 });
let bfCameraDetach = null;
let bfFitKey = '';

let versusDragPreview = null;   // previewMove result while dragging in versus

function rerender() {
  if (viewMode === 'party') {
    syncBfCamera();
    renderBattleScene(canvas, partyComposedCharacters, currentScene, {
      camera: bfCamera,
      direction: currentDirection, frameIdx: animFrame, positionOf,
      monsterCharacters: buildMonsterCharactersForRender(),
      // M4 — combat overlays
      selectedAttackerId: combat.attacker?.id || null,
      activeTurnId: (currentScene.initiative?.find?.(i => i.active))?.entityId || null,
      animations: entityAnimations,
      popups: damagePopups,
      // M8 — AoE template (placed + previewed shapes)
      aoeTemplate: currentAoeTemplate,
      // M64 M8 — a versus drag previews its path (green / red, with the
      // foot cost) through the renderer's own path pass.
      pathPreview: versusDragPreview ? { cells: versusDragPreview.cells, legal: versusDragPreview.legal, costFt: versusDragPreview.costFt } : null,
      // M27 — Per-action effect descriptors
      effects: effectQueue
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
  populateSwingPreviewSelect(c);   // M55 — keep the swing-preview list in sync
  // M53 — while the idle loop is running, a change (direction/appearance/
  // equipment) re-bakes the buffer; the rAF keeps drawing it. Otherwise
  // paint the static composite.
  if (animating && viewMode !== 'party') { bakeIdleBuffer(); return; }
  renderSprite(canvas, c, { scale: 6, direction: currentDirection, frameIdx: 0 });
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
  attachBfCamera();
  syncTopnav();
  syncBattlefieldControls();
  renderScenePresetList();
  renderGenBiomeList();
  renderMonsterPresetList();
  setStatus(`Party view: ${partyComposedCharacters.length} character${partyComposedCharacters.length === 1 ? '' : 's'}.`, 'ok');
  rerender();
}

function exitPartyView() {
  viewMode = 'solo';
  partyComposedCharacters = [];
  document.body.classList.remove('party-view-mode');
  detachBfCamera();
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

// M64 M8 — Battlefield camera (party-view only). E5's map/camera.js
// replaces the old --bf-zoom CSS scale: the canvas is sized to its CSS
// box (viewport × devicePixelRatio) and the camera's pan/zoom transform
// is applied while drawing, so a zoomed-in grid stays crisp and pointer
// hit-testing goes through the camera's inverse (canvasEventToPixels).
// Wheel zooms about the cursor; middle/right drag, Alt+drag or
// Space+drag pans; the − / + / Fit buttons drive the same camera.
function bfWorldSize() {
  return { w: currentScene.cols * WORLD_CELL_PX, h: currentScene.rows * WORLD_CELL_PX };
}

/** Zoom that fits the whole grid across the canvas width. */
function bfFitZoom() {
  return (bfCamera.viewW || 1) / (currentScene.cols * WORLD_CELL_PX);
}

function syncBfZoomLabel() {
  const pct = document.getElementById('bf-zoom-pct');
  if (pct) pct.textContent = `${Math.round((bfCamera.zoom / bfFitZoom()) * 100)}%`;
}

/** Size the camera viewport to the canvas's CSS box; refit when the box or grid changes. */
function syncBfCamera() {
  const cols = currentScene.cols;
  const rows = currentScene.rows;
  const cssW = Math.max(1, Math.round(canvas.clientWidth || cols * currentScene.cellSize * currentScene.scale));
  const cssH = Math.max(1, Math.round(cssW * rows / cols));
  const key = `${cssW}x${cssH}:${cols}x${rows}`;
  if (key === bfFitKey) return;
  // A new grid (scene switch, versus arena) refits; a resized box keeps
  // the zoom factor. The factor is read before the viewport changes.
  const sameGrid = bfFitKey.endsWith(`:${cols}x${rows}`);
  const factor = sameGrid ? bfCamera.zoom / bfFitZoom() : 1;
  bfFitKey = key;
  Object.assign(bfCamera, { viewW: cssW, viewH: cssH, dpr: globalThis.devicePixelRatio || 1 });
  const fit = bfFitZoom();
  Object.assign(bfCamera, { minZoom: fit * BF_ZOOM_MIN, maxZoom: fit * BF_ZOOM_MAX });
  Object.assign(bfCamera, fitToGrid(bfCamera, cols, rows, WORLD_CELL_PX));
  if (factor !== 1) setBfZoom(factor, { render: false });
  syncBfZoomLabel();
}

/** Zoom to `factor` × fit about the viewport centre. */
function setBfZoom(factor, { render = true } = {}) {
  const target = bfFitZoom() * Math.max(BF_ZOOM_MIN, Math.min(BF_ZOOM_MAX, factor));
  const { w, h } = bfWorldSize();
  Object.assign(bfCamera, clampCamera(zoomAt(bfCamera, bfCamera.viewW / 2, bfCamera.viewH / 2, target / bfCamera.zoom), w, h));
  syncBfZoomLabel();
  if (render) rerender();
}

function attachBfCamera() {
  if (bfCameraDetach) return;
  bfCameraDetach = attachCameraControls(canvas, bfCamera, () => { syncBfZoomLabel(); rerender(); }, { worldSize: bfWorldSize });
}

function detachBfCamera() {
  if (bfCameraDetach) { bfCameraDetach(); bfCameraDetach = null; }
  bfFitKey = '';
}

document.addEventListener('click', (e) => {
  if (viewMode !== 'party') return;
  const factor = bfCamera.zoom / bfFitZoom();
  if (e.target?.id === 'bf-zoom-in') setBfZoom(factor * BF_ZOOM_STEP);
  else if (e.target?.id === 'bf-zoom-out') setBfZoom(factor / BF_ZOOM_STEP);
  else if (e.target?.id === 'bf-zoom-fit') {
    Object.assign(bfCamera, fitToGrid(bfCamera, currentScene.cols, currentScene.rows, WORLD_CELL_PX));
    syncBfZoomLabel();
    rerender();
  }
});

// M9 — Top-level nav. Three views: Character (single-sprite view, the
// default), Party (multi-character canvas), Combat (party canvas + the
// combat panel scrolled into view and visually flagged).
//
// We only commit the active-state change AFTER any required entry step
// (enterPartyView) succeeds — otherwise a failed "no party loaded" entry
// would leave the nav highlighted on a view the user isn't actually in.
async function setView(name) {
  // M53 — a running idle/walk animation is view-specific; reset it on any
  // view switch so the rAF loop never fights another view's canvas render.
  if (animating) stopAnimation();
  stopSwingPreview();   // M55
  if (name === 'character') {
    // M64 C10 / F1 — leave any versus fight first (restores the party
    // before exitPartyView clears it).
    leaveVersusForNavigation();
    if (viewMode === 'party') exitPartyView();
    document.getElementById('versus-panel')?.setAttribute('hidden', '');
    syncTopnav();
    return;
  }
  // M28 — Versus mode: enters party-view with an ephemeral arena scene.
  // Setup card is shown; the user picks PC + monster + mode + log mode,
  // then clicks Start fight.
  if (name === 'versus') {
    if (partyComposedCharacters.length === 0) {
      await enterPartyView();
      if (viewMode !== 'party') return;   // empty party bail
    } else if (viewMode !== 'party') {
      await enterPartyView();
      if (viewMode !== 'party') return;
    }
    populateVersusSetup();
    document.getElementById('versus-panel')?.removeAttribute('hidden');
    document.querySelectorAll('.topnav-btn').forEach(b =>
      b.classList.toggle('active', b.dataset.view === 'versus'));
    return;
  }
  // Hide versus panel when navigating elsewhere
  document.getElementById('versus-panel')?.setAttribute('hidden', '');
  leaveVersusForNavigation();   // M64 C10 / F1

  // Both 'party' and 'combat' require the party canvas
  if (viewMode !== 'party') {
    await enterPartyView();
    if (viewMode !== 'party') return;
  }
  if (name === 'combat') {
    const combatPanel = document.getElementById('combat-panel');
    if (combatPanel) {
      combatPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
      combatPanel.classList.add('combat-panel-focus');
      setTimeout(() => combatPanel.classList.remove('combat-panel-focus'), 1500);
    }
  }
  document.querySelectorAll('.topnav-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.view === name));
}

// M65 V22 — the forge's own combat driver (startVersusFight and everything
// only it reaches: auto-fight, the engine turn bridge, manual attack / cast,
// the legacy attack & save prompts, the cinema stage, quick stats, the
// replay panel and the click-to-attack modes) lives in
// client/legacy/classic-versus.js for one release, loaded only with ?classic=1.
// Without the flag the versus panel offers "Play at the table" (V21) and
// neither the driver nor scene/live-bridge.js is ever imported.
const CLASSIC_VERSUS = (() => {
  try { return new URLSearchParams(globalThis.location?.search || '').get('classic') === '1'; } catch { return false; }
})();
/** True when the page was opened with `?classic=1` (read once at load). */
function classicVersusEnabled() { return CLASSIC_VERSUS; }
/** The classic driver's controller once loaded (client/legacy/classic-versus.js `installClassicVersus`). */
let classic = null;
let classicLoading = null;
/** @returns {Promise<object|null>} the classic driver, or null without the flag */
function loadClassicVersus() {
  if (!classicVersusEnabled()) return Promise.resolve(null);
  if (classic) return Promise.resolve(classic);
  classicLoading ||= import('./client/legacy/classic-versus.js').then((mod) => {
    classic = mod.installClassicVersus({
      get party() { return partyComposedCharacters; },
      set party(v) { partyComposedCharacters = v; },
      get scene() { return currentScene; },
      set scene(v) { currentScene = v; },
      get encounter() { return versusEncounter; },
      get combatAdvantage() { return combatAdvantage; },
      rerender, setCombatStatus, escapeHtml, reasonChip, saveScene, startContinuousRender,
      populateVersusSetup, readVersusInputs, hideAttackPreview, weaponClassOf
    });
    return classic;
  }).catch((err) => {
    classicLoading = null;
    globalThis.console?.error?.(JSON.stringify({ event: 'forge.classic_versus_load_failed', error: String(err?.message || err) }));
    return null;
  });
  return classicLoading;
}
/** A classic versus fight owns the scene (drags preview, nothing persists). */
function classicActive() { return !!classic?.isActive(); }
/** The status line for a retired flow, without the flag. */
const TABLE_ONLY_HINT = 'Combat now runs at the table: open Versus and use "Play at the table" (add ?classic=1 to the URL for the old in-page fight, this release only).';

/** Hide the classic driver's controls (mode, log, view, start / exit / rematch, replay) without the flag. */
function syncClassicControls() {
  document.querySelectorAll('[data-classic]').forEach((el) => {
    if (!classicVersusEnabled()) el.setAttribute('hidden', '');
  });
}

// M29 — Party-versus state: list of monster slugs the user has queued
// up as the encounter. Each entry is { id, slug, name }. id is local-
// only and used as a stable key for removal/render.
let versusEncounter = [];

function populateVersusSetup() {
  // Party checkboxes (multi-select all party members)
  const partyList = document.getElementById('versus-party-list');
  if (partyList) {
    partyList.innerHTML = '';
    for (const pc of partyComposedCharacters) {
      const id = String(pc.id);
      const label = document.createElement('label');
      label.className = 'versus-party-option';
      label.innerHTML = `
        <input type="checkbox" name="versus-party-member" value="${escapeHtml(id)}" checked />
        <span>${escapeHtml(pc.name || `PC ${id}`)}</span>
      `;
      partyList.appendChild(label);
    }
    if (partyComposedCharacters.length === 0) {
      partyList.innerHTML = '<span class="versus-empty">No party members loaded.</span>';
    }
  }

  const monSel = document.getElementById('versus-monster');
  if (monSel) {
    monSel.innerHTML = '';
    for (const slug of Object.keys(MONSTER_PRESETS)) {
      const o = document.createElement('option');
      o.value = slug;
      o.textContent = MONSTER_PRESETS[slug].name;
      monSel.appendChild(o);
    }
  }
  renderEncounterList();
  if (classicVersusEnabled()) document.getElementById('versus-start')?.removeAttribute('hidden');
  syncClassicControls();
  document.getElementById('versus-rematch')?.setAttribute('hidden', '');
  document.getElementById('versus-exit')?.setAttribute('hidden', '');
  const status = document.getElementById('versus-status');
  if (status) status.textContent = '';
}

function renderEncounterList() {
  const list = document.getElementById('versus-encounter-list');
  if (!list) return;
  if (versusEncounter.length === 0) {
    list.innerHTML = '<span class="versus-empty">No opponents added yet.</span>';
    return;
  }
  list.innerHTML = '';
  for (const e of versusEncounter) {
    const chip = document.createElement('span');
    chip.className = 'versus-encounter-chip';
    chip.innerHTML = `${escapeHtml(e.name)} <button class="versus-remove" data-versus-remove="${escapeHtml(e.id)}" aria-label="Remove ${escapeHtml(e.name)}">✕</button>`;
    list.appendChild(chip);
  }
}

let versusMonsterSeq = 1;
function addEncounterMonster(slug) {
  const preset = MONSTER_PRESETS[slug];
  if (!preset) return;
  const idx = versusEncounter.filter(e => e.slug === slug).length + 1;
  versusEncounter.push({
    id: `vm_${versusMonsterSeq++}`,
    slug,
    name: idx === 1 ? preset.name : `${preset.name} ${idx}`
  });
  versusCalibratorSeed = null;   // M35: invalidate cached calibration seed
  renderEncounterList();
}

document.addEventListener('click', (e) => {
  if (e.target.id === 'versus-add-monster') {
    const slug = document.getElementById('versus-monster')?.value;
    if (slug) addEncounterMonster(slug);
    return;
  }
  const rem = e.target.dataset?.versusRemove;
  if (rem) {
    versusEncounter = versusEncounter.filter(x => x.id !== rem);
    versusCalibratorSeed = null;   // M35
    renderEncounterList();
  }
});

function readVersusInputs() {
  const pcIds = [...document.querySelectorAll('[name="versus-party-member"]:checked')]
    .map(cb => cb.value);
  const mode = [...document.querySelectorAll('[name="versus-mode"]')]
    .find(r => r.checked)?.value || 'roll';
  const logMode = [...document.querySelectorAll('[name="versus-log"]')]
    .find(r => r.checked)?.value || 'keep';
  return { pcIds, mode, logMode };
}

/** Storage that may be blocked (private mode, sandboxed iframes): null instead of a throw. */
function safeStorage(name) {
  try { return globalThis[name] || null; } catch { return null; }
}

/**
 * M65 V21 — the versus panel's "Play at the table": a solo room with the
 * selected party seated as DM-driven seats, the queued monsters, flanking
 * and the current map pre-filled in play.html's encounter setup.
 */
async function playAtTheTable() {
  const { pcIds } = readVersusInputs();
  const status = document.getElementById('versus-status');
  const say = (msg) => { if (status) status.textContent = msg; };
  const roster = classic?.previousParty() || partyComposedCharacters;
  const party = roster.filter(p => pcIds.includes(String(p.id)));
  const btn = document.getElementById('versus-play-table');
  if (btn) btn.disabled = true;
  try {
    const session = safeStorage('sessionStorage');
    const durable = safeStorage('localStorage');
    const r = await handoffToTable({
      createApi, fetch: globalThis.fetch.bind(globalThis),
      party, encounter: versusEncounter, scene: classic?.previousScene() || currentScene,
      roomCreds: createRoomCreds({ session, durable }),
      jsonStorage: durable, handoffStorage: session,
      cinemaPick: (id) => {
        const pc = roster.find(p => String(p.id) === id);
        return pc ? { style: styleForPc(pc), swing: swingForPc(pc) } : null;
      },
      saveCinemaPick: (id, pick) => {
        if (isStyle(pick.style)) saveStyle(id, pick.style);
        if (isSwingSelection(pick.swing)) saveSwing(id, pick.swing);
      },
      progress: say
    });
    say(`Room ${r.code} is ready — opening the table…${r.warnings.length ? ` ${r.warnings.join(' ')}` : ''}`);
    globalThis.location.assign(r.url);
  } catch (err) {
    say(err.message);
    globalThis.console?.warn?.(JSON.stringify({ event: 'forge.play_at_table_failed', status: err.status ?? null, error: String(err?.message || err) }));
  } finally {
    if (btn) btn.disabled = false;
  }
}

/** M64 C10 / F1 — top-nav navigation out of versus (the classic driver's arena, ?classic=1). */
function leaveVersusForNavigation() {
  classic?.leaveForNavigation();
}

/** M64 C10 / F2 — the versus arena is ephemeral. While it is the
 *  current scene nothing may be persisted, or the arena would
 *  overwrite the user's saved scene in cf_scenes. */
function canPersistScene() {
  return !classic || classic.canPersistScene();
}

/** M64 C10 / F2 — the single persistence gate. Shadows the imported
 *  scene-state saveScene so every existing call site is guarded. */
function saveScene(scene) {
  if (!canPersistScene()) return;
  saveSceneToStorage(scene);
}

// M35 — Encounter difficulty calibrator. Runs the calibrator over the
// current versus encounter, renders a structured DM-facing report into
// #versus-calibrator with win rate, lethality, MVP, DMG difficulty.
//
// M65 V22 — outside a classic fight the card calibrates the QUEUED
// encounter (the selected party vs the opponents list, laid out the way a
// fight would be: scene/encounter-setup.js on copies), since the panel no
// longer starts an in-page fight; a running ?classic=1 fight calibrates
// its arena as before.
async function runVersusCalibrator() {
  let party = partyComposedCharacters;
  let scene = currentScene;
  if (!classicActive()) {
    const { pcIds } = readVersusInputs();
    const queued = createVersusEncounter({
      party: partyComposedCharacters.map(pc => ({ ...pc })), pcIds, encounter: versusEncounter,
      flanking: !!currentScene?.flankingEnabled, rng: Math.random, mintId: (i) => `cal_${i}`
    });
    party = queued.party;
    scene = queued.scene;
  }
  const pcsWithPositions = party.map((pc, i) => ({
    ...pc, _position: positionOf(scene, pc.id, i)
  }));
  const monsters = scene.monsters || [];
  if (pcsWithPositions.length === 0 || monsters.length === 0) {
    renderCalibratorReport({ empty: true });
    return;
  }
  // Use a fixed seed so the report is reproducible inside one session;
  // re-roll the seed when the user changes the encounter list.
  const seed = (typeof versusCalibratorSeed === 'number') ? versusCalibratorSeed : (versusCalibratorSeed = Math.floor(Math.random() * 1e9));
  const report = await calibrateEncounter({
    party: pcsWithPositions,
    monsters,
    scene,
    iterations: 200, maxRounds: 15, seed
  });
  renderCalibratorReport({ report });
}
let versusCalibratorSeed = null;

function renderCalibratorReport({ report = null, empty = false } = {}) {
  const wrap = document.getElementById('versus-calibrator');
  if (!wrap) return;
  wrap.hidden = false;
  if (empty) {
    wrap.innerHTML = '<p class="versus-calibrator-empty">Add at least one PC and one monster before calibrating.</p>';
    return;
  }
  const winPct = Math.round(report.winRate * 100);
  const lossPct = Math.round(report.lossRate * 100);
  const drawPct = Math.round(report.drawRate * 100);
  const lethalityPct = Math.round(report.lethality * 100);
  const difficultyLabel = report.difficulty?.label || 'unknown';
  const xp = report.difficulty?.encounterXp ?? 0;
  const mvp = report.mvp ? `${escapeHtml(report.mvp.name)} (${report.mvp.avgDamageDealt.toFixed(1)} avg dmg)` : '—';
  const bestKilled = report.bestKilled ? `${escapeHtml(report.bestKilled.name)} (${Math.round(report.bestKilled.deathRate * 100)}% downed)` : '—';

  wrap.innerHTML = `
    <div class="cal-card">
      <div class="cal-row cal-headline">
        <span class="cal-difficulty cal-difficulty-${escapeHtml(difficultyLabel)}">${escapeHtml(difficultyLabel.toUpperCase())}</span>
        <span class="cal-xp">${xp} XP encounter</span>
      </div>
      <div class="cal-row cal-outcomes">
        <span class="cal-cell cal-win"><strong>${winPct}%</strong> party wins</span>
        <span class="cal-cell cal-loss"><strong>${lossPct}%</strong> losses</span>
        <span class="cal-cell cal-draw"><strong>${drawPct}%</strong> stalemates</span>
      </div>
      <div class="cal-row">
        <span class="cal-cell">Avg rounds <strong>${report.avgRounds.toFixed(1)}</strong></span>
        <span class="cal-cell">Party HP lost <strong>${lethalityPct}%</strong></span>
        <span class="cal-cell">Avg downed <strong>${report.deathToll.toFixed(1)}</strong></span>
      </div>
      <div class="cal-row cal-meta">
        <span class="cal-cell">MVP: <strong>${mvp}</strong></span>
        <span class="cal-cell">Most at risk: <strong>${bestKilled}</strong></span>
      </div>
      <p class="cal-hint">${escapeHtml(calibratorHint(report))}</p>
    </div>
  `;
}

function calibratorHint(report) {
  const winPct = Math.round(report.winRate * 100);
  const label = report.difficulty?.label;
  if (winPct >= 85 && label === 'trivial') return 'Trivial — barely worth rolling.';
  if (winPct >= 70) return 'Manageable. Party should clear it with resources to spare.';
  if (winPct >= 40) return 'A real fight. Expect resource drain.';
  if (winPct >= 15) return 'Punishing. Likely PC downs unless the party plays well.';
  return 'Deadly. Add a healer or remove a monster.';
}

document.addEventListener('click', (e) => {
  if (e.target.id === 'versus-play-table') { playAtTheTable();    return; }
  if (e.target.id === 'versus-start' || e.target.id === 'versus-rematch') { loadClassicVersus().then(c => c?.start()); return; }
  if (e.target.id === 'versus-exit')      { classic?.exit();      return; }
  if (e.target.id === 'versus-calibrate') { runVersusCalibrator(); return; }
});

document.addEventListener('click', (e) => {
  const btn = e.target.closest('.topnav-btn');
  if (!btn) return;
  setView(btn.dataset.view);
});

if (classicVersusEnabled()) loadClassicVersus();
syncClassicControls();

// M2 — Drag-to-position. Pointer events handle both mouse and touch.
// Attached to the main #sprite-canvas; only active in party view. Hit-
// tests against scene positions to find which character is grabbed,
// then updates that character's (col, row) on every move and persists
// on release.

let dragState = null;   // { id, snap, offsetCol, offsetRow }

function canvasEventToPixels(event) {
  const rect = canvas.getBoundingClientRect();
  if (viewMode === 'party' && bfCamera.viewW > 0 && rect.width > 0) {
    // M64 M8 — screen → world through the camera, then world → the
    // legacy scene pixel space (cellSize × scale per cell) the hit tests use.
    const sx = (event.clientX - rect.left) * (bfCamera.viewW / rect.width);
    const sy = (event.clientY - rect.top) * (bfCamera.viewH / rect.height);
    const w = screenToWorld(bfCamera, sx, sy);
    const k = (currentScene.cellSize * currentScene.scale) / WORLD_CELL_PX;
    return { px: w.x * k, py: w.y * k };
  }
  // Canvas internal coords account for CSS scaling (canvas.width might
  // be larger than its rendered width). Convert event coords to internal.
  const scaleX = canvas.width  / rect.width;
  const scaleY = canvas.height / rect.height;
  return {
    px: (event.clientX - rect.left) * scaleX,
    py: (event.clientY - rect.top)  * scaleY
  };
}

/** Pointer → grid cell (legacy scene pixel space). */
function canvasEventToCell(event) {
  const { px, py } = canvasEventToPixels(event);
  const cellPx = currentScene.cellSize * currentScene.scale;
  return { col: Math.floor(px / cellPx), row: Math.floor(py / cellPx) };
}

// M64 M8 — versus drags go through the intent adapters: the pointer only
// previews (client/intents.js previewMove, green within speed, red over
// budget or blocked); on release a legal move becomes a turn.act-shaped
// move intent that applyVersusIntent applies. An illegal drag changes
// nothing. Outside a fight (sandbox) tokens still move freely.

canvas.addEventListener('pointerdown', (e) => {
  if (viewMode !== 'party') return;
  // M64 M8 — middle/right button and Alt+drag belong to the camera (pan).
  if (e.button !== 0 || e.altKey) return;
  // M26 — Read-only mode (recipient of a shared scene snapshot)
  // disables all canvas interactions; the page is for viewing only.
  if (document.body.classList.contains('readonly-mode')) return;
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

  // M4 — combat mode short-circuits the drag handler. M65 V22: the
  // click-to-attack flow belongs to the classic driver (?classic=1).
  if (combat.mode === 'pick-attacker' || combat.mode === 'pick-target') {
    classic?.onCombatPick(hit, e);
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
      if (combat.mode === 'pick-target' && classic) {
        classic.updateAttackPreview(hit, e.clientX, e.clientY);
      } else {
        hideAttackPreview();
      }
    }
    return;
  }
  const target = clampPosition(currentScene, canvasEventToCell(e));
  if (classicActive()) {
    // M64 M8 — preview only; the scene changes on release, if legal.
    const last = dragState.target;
    if (last && last.col === target.col && last.row === target.row) return;
    dragState.target = target;
    versusDragPreview = previewMove(classic.stateForDrag().state, String(dragState.id), target);
    rerender();
    return;
  }
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
  const drag = dragState;
  dragState = null;
  if (classicActive()) {
    versusDragPreview = null;
    if (drag.target) {
      const { state, sheets } = classic.stateForDrag();
      const r = moveIntent(state, { actorId: String(drag.id), turnId: 'versus-local', dest: drag.target, sheets });
      if (r.ok) {
        classic.applyIntent(drag.kind, drag.id, r.intent);
        const oas = r.preview.oaTriggers.length;
        setCombatStatus(`Moved ${r.preview.costFt} ft${oas ? ` — provokes ${oas} opportunity attack${oas === 1 ? '' : 's'}` : ''}.`);
      } else if (r.preview.reason !== 'no-move') {
        const why = r.preview.reason === 'over-budget'
          ? `${r.preview.costFt} ft is beyond ${r.preview.budgetFt} ft of movement`
          : (r.reason || r.preview.reason);
        setCombatStatus(`Can't move there: ${why}.`);
      }
    }
    rerender();
    return;
  }
  saveScene(currentScene);
});

canvas.addEventListener('pointercancel', () => {
  if (dragState) {
    canvas.style.cursor = 'default';
    dragState = null;
    if (versusDragPreview) { versusDragPreview = null; rerender(); }
  }
});

canvas.addEventListener('pointerleave', () => hideAttackPreview());

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
      ${renderAiEditor(m)}
    `;
    list.appendChild(card);
  }
}

// M32.3 — Per-monster AI editor. Sits in each monster card; lets the
// user pick an archetype, tune every consideration weight, and set the
// retreat threshold. All edits write to m._aiProfile so chooseAction
// picks them up (via profileForEntity) on the next monster turn.
function renderAiEditor(m) {
  const profile = editableProfileFor(m);
  const archetypes = listArchetypes();
  const considerationNames = listConsiderations();

  const archetypeOptions = archetypes.map(a => {
    const selected = a.archetype === profile.archetype ? ' selected' : '';
    return `<option value="${escapeHtml(a.slug)}"${selected}>${escapeHtml(a.archetype)}</option>`;
  }).join('');

  const consRows = considerationNames.map(name => {
    const entry = profile.considerations[name];
    const w = entry ? (typeof entry === 'number' ? entry : entry.weight) : 0;
    const wDisp = w >= 0 ? `+${w.toFixed(1)}` : w.toFixed(1);
    return `
      <div class="ai-cons-row">
        <span class="ai-cons-name" title="${escapeHtml(name)}">${escapeHtml(name)}</span>
        <input class="ai-cons-slider" type="range" min="-1.5" max="1.5" step="0.1"
               value="${w}" data-ai-weight="${escapeHtml(m.id)}|${escapeHtml(name)}" />
        <span class="ai-cons-value">${wDisp}</span>
      </div>`;
  }).join('');

  const retreatPct = Math.round((profile.retreat_below_hp || 0) * 100);
  return `
    <details class="monster-ai-editor">
      <summary>
        <span class="ai-editor-label">AI Profile</span>
        <span class="ai-archetype-summary">${escapeHtml(profile.archetype)}</span>
      </summary>
      <div class="ai-editor-body">
        <label class="ai-row">
          <span class="ai-row-label">Archetype</span>
          <select data-ai-archetype="${escapeHtml(m.id)}">${archetypeOptions}</select>
        </label>
        <div class="ai-considerations">${consRows}</div>
        <label class="ai-row">
          <span class="ai-row-label">Retreat below HP</span>
          <input type="range" min="0" max="0.95" step="0.05"
                 value="${profile.retreat_below_hp || 0}" data-ai-retreat="${escapeHtml(m.id)}" />
          <span class="ai-cons-value">${retreatPct}%</span>
        </label>
        <button class="ai-reset" type="button" data-ai-reset="${escapeHtml(m.id)}">Reset to default</button>
      </div>
    </details>
  `;
}

function findMonsterInScene(id) {
  return (currentScene.monsters || []).find(m => String(m.id) === String(id)) || null;
}

function handleAiEditorEvent(e) {
  const t = e.target;
  if (!t) return;
  // Weight slider
  if (t.dataset.aiWeight) {
    const [id, name] = t.dataset.aiWeight.split('|');
    const m = findMonsterInScene(id);
    if (!m) return;
    const weight = parseFloat(t.value);
    m._aiProfile = applyWeightChange(editableProfileFor(m), name, weight);
    const valSpan = t.parentElement?.querySelector('.ai-cons-value');
    if (valSpan) valSpan.textContent = weight >= 0 ? `+${weight.toFixed(1)}` : weight.toFixed(1);
    saveScene(currentScene);
    return;
  }
  // Retreat threshold
  if (t.dataset.aiRetreat) {
    const m = findMonsterInScene(t.dataset.aiRetreat);
    if (!m) return;
    const r = parseFloat(t.value);
    m._aiProfile = applyRetreatChange(editableProfileFor(m), r);
    const valSpan = t.parentElement?.querySelector('.ai-cons-value');
    if (valSpan) valSpan.textContent = `${Math.round(r * 100)}%`;
    saveScene(currentScene);
    return;
  }
  // Archetype dropdown
  if (t.dataset.aiArchetype) {
    const m = findMonsterInScene(t.dataset.aiArchetype);
    if (!m) return;
    m._aiProfile = applyArchetypeSwap(editableProfileFor(m), t.value);
    saveScene(currentScene);
    renderMonsterPanel();   // re-render so sliders match the new profile
    return;
  }
  // Reset button
  if (t.dataset.aiReset) {
    const m = findMonsterInScene(t.dataset.aiReset);
    if (!m) return;
    delete m._aiProfile;
    saveScene(currentScene);
    renderMonsterPanel();
    return;
  }
}

document.addEventListener('input', handleAiEditorEvent);
document.addEventListener('change', handleAiEditorEvent);
document.addEventListener('click', handleAiEditorEvent);

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
  // M32.2 — If this was spawned from an Open5e creature, attach the
  // inferred profile to the *just-added* instance so chooseAction picks
  // it up instead of the visual preset's profile.
  if (overrides.openStat) {
    const last = currentScene.monsters[currentScene.monsters.length - 1];
    if (last) last._aiProfile = inferProfile(overrides.openStat);
  }
  saveScene(currentScene);
  rerender();
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
          overrides: {
            name: r.name,
            maxHp: r.hp || undefined,
            // Pass the full summary through so M32 can infer an AI profile
            openStat: { slug: r.slug, name: r.name, type: r.type, cr: r.cr, hp: r.hp }
          }
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
  requestAnimationFrame(async () => {
    const party = partyComposedCharacters.map((pc, i) => ({
      ...pc, _position: positionOf(currentScene, pc.id, i)
    }));
    const monsters = (currentScene.monsters || []);
    const stats = await simulateEncounter({
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
    combat.weapon = null;
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
    if (!classicVersusEnabled()) { setCombatStatus(TABLE_ONLY_HINT); return; }
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
      // M51.1 — Click an available weapon row to attack with THAT weapon
      // (enters pick-target mode). Without this the manual attack always
      // used the mainhand, so a Cleric couldn't choose the warhammer.
      if (a.available && a.weapon) {
        row.addEventListener('click', () => beginWeaponAttack(subject, a.weapon));
        row.classList.add('action-row-clickable');
      }
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
  if (!classicVersusEnabled()) { setCombatStatus(TABLE_ONLY_HINT); return; }
  beginAttack();
  selectAttacker(subject.entity.id, subject.kind);
  combat.weapon = null;     // mutually exclusive with a queued weapon
  combat.spell = spell;     // ← extension to the M11/M4 combat state
  setCombatStatus(`${subject.entity.name} casts ${spell.name} — click a target.`);
  rerender();
}

// M51.1 — Weapon attack: arm a specific weapon (e.g. the warhammer) and
// enter pick-target mode. Mirrors beginSpellAttack; the pointer-down
// handler reads combat.weapon and passes it to runManualWeaponAttack so
// the player's pick overrides the mainhand default.
function beginWeaponAttack(subject, weapon) {
  if (!classicVersusEnabled()) { setCombatStatus(TABLE_ONLY_HINT); return; }
  beginAttack();
  selectAttacker(subject.entity.id, subject.kind);
  combat.spell = null;      // mutually exclusive with a queued spell
  combat.weapon = weapon;
  setCombatStatus(`${subject.entity.name} readies ${weapon?.name || 'their weapon'} — click a target.`);
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
  // Generated-map controls reflect the active biome + seed.
  const gb = document.getElementById('scene-gen-biome');
  const gseed = document.getElementById('scene-gen-seed');
  const isGen = currentScene.map?.kind === 'generated';
  if (gb && isGen && currentScene.map.biome) gb.value = currentScene.map.biome;
  if (gseed) gseed.textContent = isGen ? `seed ${currentScene.map.seed >>> 0}` : '';
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
  // M44.2 — Persist the preset slug so the cinema can pick the matching
  // background without reverse-mapping the colour every time.
  currentScene.map  = { ...p.map, preset: slug };
  currentScene.grid = { ...(currentScene.grid || {}), ...p.grid };
  saveScene(currentScene);
  // If the cinema is mounted, swap its backdrop live.
  classic?.setCinemaBackground(slug);
  syncBattlefieldControls();
  if (viewMode === 'party') rerender();
}

document.addEventListener('click', (e) => {
  const btn = e.target.closest('.scene-preset-btn');
  if (!btn) return;
  applyScenePreset(btn.dataset.preset);
});

/* =====================================================================
 * Procedural map generation. A "generated" map is a richly-textured
 * top-down terrain painted from a (biome, seed). It persists as just
 * those two fields and regenerates identically on load. Visual only —
 * terrain has no effect on movement or combat.
 * ===================================================================== */

/** Populate the biome <select> once, reusing SCENE_PRESETS display names. */
function renderGenBiomeList() {
  const sel = document.getElementById('scene-gen-biome');
  if (!sel || sel.dataset.populated === '1') return;
  sel.dataset.populated = '1';
  for (const slug of listBiomes()) {
    const opt = document.createElement('option');
    opt.value = slug;
    opt.textContent = SCENE_PRESETS[slug]?.name || slug;
    sel.appendChild(opt);
  }
}

/** A fresh random seed in the 32-bit range. */
function randomSeed() {
  return (Math.floor(Math.random() * 0xffffffff) >>> 0) || 1;
}

/**
 * Apply a generated map. Mirrors applyScenePreset: sets the map, syncs
 * the grid colour + cinema backdrop to the matching biome, persists,
 * and re-renders. The biome's preset colour is kept as a fallback fill.
 */
function applyGeneratedMap(biome, seed) {
  const slug = isBiome(biome) ? biome : 'grass';
  const p = SCENE_PRESETS[slug];
  currentScene.map = {
    kind: 'generated',
    biome: slug,
    seed: (seed >>> 0) || randomSeed(),
    color: p?.map?.color || '#3d5a3d',
    preset: slug
  };
  if (p?.grid) currentScene.grid = { ...(currentScene.grid || {}), ...p.grid };
  saveScene(currentScene);
  classic?.setCinemaBackground(slug);
  syncBattlefieldControls();
  if (viewMode === 'party') rerender();
}

// Generate — uses the picked biome + a fresh seed.
document.addEventListener('click', (e) => {
  if (e.target.id !== 'scene-gen-apply') return;
  const biome = document.getElementById('scene-gen-biome')?.value || 'grass';
  applyGeneratedMap(biome, randomSeed());
});

// Reroll — keep the current biome, draw a new seed. If the current map
// isn't generated yet, fall back to the picker's biome.
document.addEventListener('click', (e) => {
  if (e.target.id !== 'scene-gen-reroll') return;
  const biome = currentScene.map?.kind === 'generated'
    ? currentScene.map.biome
    : (document.getElementById('scene-gen-biome')?.value || 'grass');
  applyGeneratedMap(biome, randomSeed());
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

// ---------- Tier 3.1 / M53: Character animation ----------
//
// Two animation modes share the Animate toggle:
//   - Party / battle view → the original frame-cycle tick (monsters walk
//     in place; the battle scene reads frameIdx = animFrame).
//   - Single-character view → M53 lifelike idle: the composite is baked
//     ONCE to an offscreen buffer, then a 60fps rAF loop draws it with a
//     breathing squash/stretch, a slow weight-shift sway, and a grounding
//     contact shadow (idle-pose.js). Smooth + cheap — no per-frame
//     re-composite, the choppy 2-frame wobble it replaces.
let animating = false;
let animFrame = 0;
let animTimer = null;            // party-view frame-cycle interval
const FRAME_INTERVAL_MS = 130;

// Idle state. The M53 idle baked ONE frame (frameIdx:0) and affine-warped the
// whole sprite every tick, so the pose never changed and rigid armour/weapons
// jelly-squashed (the "broken for weeks" motion). We now cycle the REAL idle
// frames (LPC bodies ship a 2-frame idle; the compositor samples each layer via
// frameIdx % frameCount) with only a subtle INTEGER breath offset, never a
// whole-sprite scale — matching the cinema's idle.
let idleRaf = null;
let idleStart = 0;
let idleBuffers = [];            // baked BODY-CORE composites, one per idle frame
let idleBehindBuffers = [];      // loose parts that sit BEHIND the body
let idleFrontBuffers = [];       // loose parts that sit IN FRONT of the body
let idleBakeToken = 0;           // invalidates in-flight async bakes
let idleLast = 0;                // ms of the previous drawn frame (spring dt)
let looseSpringX = { x: 0, v: 0 };  // Path A — horizontal follow-through (px)
let looseSpringY = { x: 0, v: 0 };  // Path A — vertical follow-through (px)
// Tuned against the SLOW idle sway (~0.3Hz): a stiff spring would track it
// perfectly and show no lag, so this sits just above the drive with light
// damping — it perpetually trails the body and slightly overshoots on the
// turn, which is the follow-through you actually see.
const LOOSE_SPRING = springConfig(0.95, 0.42);
const IDLE_FRAME_MS = 300;       // per step; ping-ponged → ~0.6s breath loop

// Path A — the "loose" follow-through parts drag a beat behind the body's
// weight-shift instead of moving in rigid lockstep. Split by z-order so the
// split preserves the original compositing: BEHIND parts (cape, strapped
// back-weapon, quiver) stay behind the body; FRONT parts (hair/beard) stay
// in front. Everything else (body, armour, helm, held weapon) is the rigid
// core, drawn between them.
const LOOSE_BEHIND = ['cape-behind', 'back-weapon', 'quiver'];
const LOOSE_FRONT = ['hair', 'beard', 'facial'];
const LOOSE_SLOTS = [...LOOSE_BEHIND, ...LOOSE_FRONT];

/** Idle frame count — LPC PC bodies ship a 2-frame idle. */
function idleFrameCount() {
  return 2;
}
/** Ping-pong step order so a breath eases in and back out instead of snapping
 *  from peak to neutral (2-frame → 0,1; 3-frame → 0,1,2,1). */
function idleFrameSeq(n) {
  const s = [];
  for (let i = 0; i < n; i++) s.push(i);
  for (let i = n - 2; i > 0; i--) s.push(i);
  return s.length ? s : [0];
}

/** Bake one offscreen composite per idle frame. Async (composition); guarded
 *  so a newer bake wins. Rigid layers (helmet, static weapon) are 1-frame so
 *  they stay identical across buffers (frameIdx % 1 === 0) — no warping. */
async function bakeIdleBuffer() {
  if (!currentCharacter) return;
  const token = ++idleBakeToken;
  const actor = currentCharacter;
  const n = idleFrameCount();
  const core = [], behind = [], front = [];
  for (let i = 0; i < n; i++) {
    // Path A — split the composite into three z-ordered buffers so the draw
    // loop can lag the loose parts behind the body's weight-shift without
    // disturbing their compositing: behind-body parts, the rigid core, and
    // front-of-body parts.
    const behindOff = document.createElement('canvas');
    const coreOff = document.createElement('canvas');
    const frontOff = document.createElement('canvas');
    try {
      await renderSprite(behindOff, actor, { scale: 6, direction: currentDirection, frameIdx: i, includeSlots: LOOSE_BEHIND });
      await renderSprite(coreOff, actor, { scale: 6, direction: currentDirection, frameIdx: i, excludeSlots: LOOSE_SLOTS });
      await renderSprite(frontOff, actor, { scale: 6, direction: currentDirection, frameIdx: i, includeSlots: LOOSE_FRONT });
    } catch { return; }
    behind.push(behindOff);
    core.push(coreOff);
    front.push(frontOff);
  }
  if (token === idleBakeToken) {
    idleBuffers = core;
    idleBehindBuffers = behind;
    idleFrontBuffers = front;
    looseSpringX = { x: 0, v: 0 };   // reset the follow-through on a fresh bake
    looseSpringY = { x: 0, v: 0 };
  }
}

/** One frame of the idle loop — cycle the real breathing frames with a
 *  grounding glow and a subtle INTEGER breath offset. No whole-sprite scale
 *  or skew: the breathing lives in the frames, so feet stay planted and rigid
 *  armour/weapons never warp. */
function drawIdleFrame(now) {
  if (!animating) return;
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  if (idleBuffers.length) {
    const t = now - idleStart;
    const p = idlePoseAt(t);
    const cx = W / 2, feetY = H * 0.95;
    // Grounding pedestal — a soft additive light pool that pulses with the
    // breath. Does NOT move the sprite. Reads on the dark viewer background.
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.translate(cx, feetY + H * 0.025);
    ctx.scale(1, 0.16);            // flatten the disc into a ground ellipse
    const rad = W * 0.34 * p.shadowScale;
    const a = Math.max(0, p.shadowAlpha) * 0.62;
    const glow = ctx.createRadialGradient(0, 0, 0, 0, 0, rad);
    glow.addColorStop(0, `rgba(150,172,220,${a})`);
    glow.addColorStop(0.6, `rgba(120,140,190,${a * 0.4})`);
    glow.addColorStop(1, 'rgba(120,140,190,0)');
    ctx.fillStyle = glow;
    ctx.beginPath(); ctx.arc(0, 0, rad, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
    // The breathing is authored into the frames; add only a subtle INTEGER
    // weight-shift offset (rounded to whole device pixels so the outline never
    // shimmers). No scale/rotate — that M53 warp was the broken motion.
    const seq = idleFrameSeq(idleBuffers.length);
    const fi = seq[Math.floor(t / IDLE_FRAME_MS) % seq.length];
    const core = idleBuffers[fi];
    if (core) {
      // Body weight-shift + a slow, decoupled hip sway so the loop never ticks
      // in a single pulse. These are the CORE's real position this frame.
      const bodyX = p.swayX * W + hipSwayAt(t, 0.006 * W);
      const bodyY = p.bobY * H;
      ctx.imageSmoothingEnabled = false;

      // Path A — the loose group (hair/cape/strapped weapons) chases the body
      // a beat behind. The spring lags the core, so the relative offset reads
      // as follow-through; at rest both align and the pose is unchanged.
      const dt = idleLast ? now - idleLast : 16;
      looseSpringX = springStep(looseSpringX, bodyX, dt, LOOSE_SPRING);
      looseSpringY = springStep(looseSpringY, bodyY, dt, LOOSE_SPRING);

      const lx = Math.round(looseSpringX.x), ly = Math.round(looseSpringY.x);
      const behind = idleBehindBuffers[fi];
      const front = idleFrontBuffers[fi];
      if (behind) ctx.drawImage(behind, lx, ly);                 // cape / back-weapon
      ctx.drawImage(core, Math.round(bodyX), Math.round(bodyY)); // rigid body
      if (front) ctx.drawImage(front, lx, ly);                   // hair / beard
    }
    idleLast = now;
  }
  idleRaf = requestAnimationFrame(drawIdleFrame);
}

async function startAnimation() {
  if (animating) return;
  stopSwingPreview();   // M55 — idle + swing preview are mutually exclusive
  animating = true;
  const btn = $('animate-toggle');
  if (btn) btn.textContent = '⏸ Animating';
  if (viewMode === 'party') {
    animTimer = setInterval(() => {
      animFrame = (animFrame + 1) & 0xFFFF;
      pruneExpired();
      rerender();
    }, FRAME_INTERVAL_MS);
  } else {
    await bakeIdleBuffer();
    idleStart = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    idleLast = 0;
    idleRaf = requestAnimationFrame(drawIdleFrame);
  }
}

function stopAnimation() {
  if (!animating) return;
  animating = false;
  if (animTimer) { clearInterval(animTimer); animTimer = null; }
  if (idleRaf) { cancelAnimationFrame(idleRaf); idleRaf = null; }
  idleBuffers = [];
  idleBehindBuffers = [];
  idleFrontBuffers = [];
  idleLast = 0;
  animFrame = 0;
  const btn = $('animate-toggle');
  if (btn) btn.textContent = '▶ Animate';
  rerender();   // snap back to the static frame
}

document.addEventListener('click', (e) => {
  if (e.target.id !== 'animate-toggle') return;
  if (animating) stopAnimation(); else startAnimation();
});

// ---------- M55: Swing preview ----------
//
// Play one attack swing on the character's own sprite (body attack frames
// + the rotating weapon overlay), so the player can SEE how each cut looks
// without starting a fight. Reuses the cinema actor machinery
// (preloadActorAttack / drawWeaponOverlay / makeLpcDrawSprite) on the
// single #sprite-canvas. Returns to the static sprite (or resumes idle).
let swingPreviewRaf = null;
const SWING_PREVIEW_MS = 1150;

/** Fill the export-bar swing dropdown with the character's available cuts. */
function populateSwingPreviewSelect(character) {
  const sel = $('swing-preview-select');
  if (!sel) return;
  if (!character) { sel.innerHTML = ''; return; }
  const choices = availableSwings(weaponClassForSwing(character));
  const prev = sel.value;
  sel.innerHTML = choices.map(s => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.label)}</option>`).join('');
  if (prev && choices.some(s => s.id === prev)) sel.value = prev;
}

function stopSwingPreview() {
  if (swingPreviewRaf) { cancelAnimationFrame(swingPreviewRaf); swingPreviewRaf = null; }
}

async function playSwingPreview(swingId) {
  if (!currentCharacter?.id || !isSwing(swingId)) return;
  stopSwingPreview();
  const wasIdling = animating;
  if (animating) stopAnimation();
  const ent = currentCharacter;
  const scale = Math.max(3, Math.round(canvas.width / 64) - 1);   // slight margin for the arc
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  // Bake the body attack frames + idle + weapon for this swing.
  await Promise.all([
    preloadActorSprite(ent, { direction: 'south', scale }),
    preloadActorAttack(ent, { animation: bodyAnimForSwing(swingId), direction: 'south', scale }),
    setActorWeapon(ent, { swing: swingId, animation: bodyAnimForSwing(swingId) })
  ]);
  const drawSprite = makeLpcDrawSprite();
  const dur = SWING_PREVIEW_MS, impactAt = Math.round(dur * 0.55);
  const anchor = { x: W / 2, y: H * 0.97 };
  const refInfo = { id: ent.id, name: '' };
  const start = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const step = (now) => {
    const t = now - start;
    ctx.clearRect(0, 0, W, H);
    const snap = {
      x: 0, y: 0, rotation: 0, scale: 1, alpha: 1,
      _t: t, _impactAt: impactAt, _duration: dur, _phase: phaseAt(t, impactAt)
    };
    drawSprite(ctx, 'attacker', anchor, snap, refInfo);
    drawWeaponOverlay(ctx, anchor, snap, scale);
    if (t < dur) { swingPreviewRaf = requestAnimationFrame(step); return; }
    swingPreviewRaf = null;
    clearActorWeapon();
    if (wasIdling) startAnimation(); else rerender();   // back to idle / static
  };
  swingPreviewRaf = requestAnimationFrame(step);
}

document.addEventListener('click', (e) => {
  if (e.target.id !== 'swing-preview-play') return;
  // In 3D mode the swing plays on the 3D model; otherwise the 2D sprite cut.
  if (renderMode === '3d') { threeViewer?.playSwing(); return; }
  const sel = $('swing-preview-select');
  if (sel?.value) playSwingPreview(sel.value);
});

// ---------- 2D ⟷ 3D render mode ----------
//
// A per-player switch between the classic 2D LPC sprite and an animated 3D
// model (Path B). Purely additive: three.js + the model GLB lazy-load only
// when a player first picks "3D"; the 2D path is untouched. The 3D side maps
// the character to the nearest KayKit archetype by class (see three-viewer).
let renderMode = (typeof localStorage !== 'undefined' && localStorage.getItem('cf-render-mode') === '3d') ? '3d' : '2d';
// Which 3D backend: 'archetype' (stylized KayKit) or 'modular' (realistic
// Quaternius body composed from the sheet). createThreeViewer reads the same
// localStorage key, so switching = persist + re-mount.
let renderEngine = (typeof localStorage !== 'undefined' && localStorage.getItem('cf-3d-engine') === 'modular') ? 'modular' : 'archetype';
let threeViewer = null;
let threeLoading = false;

/** Reflect `renderMode` into the DOM and mount/tear down the 3D viewer. */
async function applyRenderMode() {
  const toggle = $('render-mode');
  const stage3d = $('three-stage');
  if (toggle) {
    toggle.dataset.mode = renderMode;
    toggle.querySelectorAll('.rm-opt').forEach(b => {
      const on = b.dataset.mode === renderMode;
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-pressed', String(on));
    });
  }
  // The 3D-style sub-toggle only applies in 3D.
  const engineToggle = $('engine-mode');
  if (engineToggle) {
    engineToggle.hidden = renderMode !== '3d';
    engineToggle.dataset.engine = renderEngine;
    engineToggle.querySelectorAll('.em-opt').forEach(b => {
      const on = b.dataset.engine === renderEngine;
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-pressed', String(on));
    });
  }
  if (renderMode === '3d') {
    stopAnimation();                       // the 2D idle loop isn't visible in 3D
    if (canvas) canvas.hidden = true;
    if (stage3d) stage3d.hidden = false;
    await mountThree();
  } else {
    if (stage3d) stage3d.hidden = true;
    if (canvas) canvas.hidden = false;
    if (threeViewer) { threeViewer.dispose(); threeViewer = null; }
    if (currentCharacter && !animating) startAnimation();   // resume the 2D idle
  }
}

/** Create (or re-point) the 3D viewer for the current character. */
async function mountThree() {
  const stage3d = $('three-stage');
  if (!stage3d || !currentCharacter) return;
  if (threeViewer) { try { await threeViewer.setCharacter(currentCharacter); } catch { /* keep current */ } return; }
  if (threeLoading) return;
  threeLoading = true;
  stage3d.dataset.state = 'loading';
  stage3d.textContent = 'Loading 3D…';
  try {
    threeViewer = await createThreeViewer(stage3d, { character: currentCharacter, size: 384 });
    stage3d.dataset.state = 'ready';
  } catch (err) {
    console.error('3D viewer failed to load', err);
    stage3d.textContent = '';
    stage3d.dataset.state = 'error';
    renderMode = '2d';                      // fall back gracefully to the sprite
    if (typeof localStorage !== 'undefined') localStorage.setItem('cf-render-mode', '2d');
    await applyRenderMode();
  } finally {
    threeLoading = false;
  }
}

/** Player picked a render mode. */
function setRenderMode(mode) {
  if (mode !== '2d' && mode !== '3d') return;
  if (mode === renderMode && (mode === '2d' || threeViewer)) return;
  renderMode = mode;
  if (typeof localStorage !== 'undefined') localStorage.setItem('cf-render-mode', mode);
  applyRenderMode();
}

document.addEventListener('click', (e) => {
  const opt = e.target.closest?.('.rm-opt');
  if (!opt) return;
  setRenderMode(opt.dataset.mode);
});

/** Player picked a 3D style (backend). Persist + re-mount so createThreeViewer
 *  picks the new backend for the current character. */
async function setEngine(engine) {
  if (engine !== 'archetype' && engine !== 'modular') return;
  if (engine === renderEngine) return;
  renderEngine = engine;
  if (typeof localStorage !== 'undefined') localStorage.setItem('cf-3d-engine', engine);
  // Tear down the current viewer so mountThree rebuilds on the chosen backend.
  if (threeViewer) { threeViewer.dispose(); threeViewer = null; }
  await applyRenderMode();
}

document.addEventListener('click', (e) => {
  const opt = e.target.closest?.('.em-opt');
  if (!opt) return;
  setEngine(opt.dataset.engine);
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

// M26 — Async scene snapshot share. Encodes the full visual state
// (party member ids + scene positions / monsters / HP / conditions /
// initiative) into the URL hash. Recipients open it in read-only mode:
// no drag, no attack, no monster spawning — just the live scene as
// the DM has it. Lets a player follow along on their phone without
// screen-share.
function buildSceneShareUrl() {
  if (viewMode !== 'party') return null;
  const ids = (partyComposedCharacters || []).map(c => String(c.id)).filter(Boolean);
  if (ids.length === 0) return null;
  const payload = {
    party: ids,
    scene: buildSceneSnapshot(currentScene),
    ro: true,
    d: currentDirection !== 'south' ? currentDirection : undefined
  };
  const encoded = b64urlEncode(JSON.stringify(payload));
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

      // M26 — Scene snapshot share: when the payload carries a `scene`
      // field, restore that scene IN MEMORY (not into the multi-scene
      // container, so the recipient's own saved scenes are untouched).
      // The `ro` flag puts the page in read-only mode so the recipient
      // can't accidentally edit the borrowed scene.
      if (payload.scene) {
        const restored = restoreSceneFromSnapshot(payload.scene);
        currentScene = restored;
      }
      if (payload.ro) {
        document.body.classList.add('readonly-mode');
        renderReadOnlyBanner();
      }
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

// M26 — Read-only banner shown at the top of the page when a snapshot
// share has been loaded. Includes an "Exit" link that strips the hash
// + reloads, restoring the recipient's own state.
function renderReadOnlyBanner() {
  if (document.getElementById('readonly-banner')) return;
  const banner = document.createElement('div');
  banner.id = 'readonly-banner';
  banner.className = 'readonly-banner';
  banner.innerHTML = `
    <span>👁 Viewing a shared scene snapshot — read-only. Your own scenes are untouched.</span>
    <a href="#" class="readonly-exit" id="readonly-exit">Exit shared view</a>
  `;
  document.body.insertBefore(banner, document.body.firstChild);
}

document.addEventListener('click', (e) => {
  if (e.target.id !== 'readonly-exit') return;
  e.preventDefault();
  // Drop the hash, reload to restore normal state
  history.replaceState(null, '', window.location.pathname + window.location.search);
  window.location.reload();
});

// Queued by consumeShareLink() and consumed inside render() so the shared
// customizations beat localStorage's saved state for this session only.
let pendingShareOverrides = null;

document.addEventListener('click', async (e) => {
  if (e.target.id === 'share-scene') {
    const btn = e.target;
    const url = buildSceneShareUrl();
    if (!url) { setStatus('Enter party view first.', 'error'); return; }
    if (!navigator.clipboard?.writeText) {
      setStatus('Clipboard not available — copy the URL from your address bar.', 'error');
      return;
    }
    const prev = btn.textContent;
    try {
      await navigator.clipboard.writeText(url);
      btn.textContent = '✓ Scene link copied';
      setTimeout(() => { btn.textContent = prev; }, 2200);
    } catch (err) {
      setStatus(`Could not copy: ${err.message}`, 'error');
    }
    return;
  }
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
    // The API always answers with a JSON body (even on errors). An empty
    // or non-JSON response means the request never reached the backend —
    // almost always the API server not running, so the Vite proxy returns
    // an empty 500. Tolerate the parse failure and surface it as an
    // actionable error instead of a raw "Unexpected end of JSON input".
    let data = null;
    try { data = await res.json(); } catch { data = null; }
    if (!res.ok || !data) {
      throw makeImportError(res.status, data);
    }
    // M23 — re-import diff. If the server returned a previous parse,
    // diff it against the new one and show a "what changed" banner.
    // Also preserve in-session HP / conditions on any party member
    // who's being re-imported, so a re-sync doesn't wipe live damage.
    // M65 V21 — keep a pasted character's JSON so "Play at the table" can
    // import it into a room later (URL imports re-fetch by id).
    if (body.json && data.character?.id) stashForgeJson(safeStorage('localStorage'), String(data.character.id), body.json);
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
  // No JSON body → the backend wasn't reached (proxy returned an empty
  // 5xx because the API server isn't running). Tell the user how to fix it.
  if (!data) {
    const err = new Error('Could not reach the import API server.');
    err.hint = 'Start the backend too: run `npm run dev:all` (or `npm run dev:api` alongside `npm run dev`).';
    return err;
  }
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
  populateSwingPreviewSelect(effective);   // M55 — swing preview list

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
  // M62 — breathe by default: the preview was static until the user toggled
  // "animate". Start the idle loop on load so the character feels alive.
  startAnimation();
  // Reveal the 2D/3D switch and apply the player's saved preference (points
  // the 3D model at the newly-loaded character if 3D is active).
  const modeToggle = $('render-mode');
  if (modeToggle) modeToggle.hidden = false;
  applyRenderMode();
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
  const dmgRoll = rollDamage(atk.dice, { crit: d20 === 20 }, Math.random);
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
  const dmg = rollDamage(dice, { crit: false }, Math.random);
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
  if (!wrap || !strip) return;
  // Show the party section as soon as a character is loaded — even if
  // the party is still empty — so the "+ Add current" button is
  // reachable. Without this, the user had no UI to start a party.
  const hasLoadedCharacter = !!originalCharacter;
  if (ids.length === 0 && !hasLoadedCharacter) {
    wrap.classList.add('hidden');
    strip.innerHTML = '';
    return;
  }
  wrap.classList.remove('hidden');
  strip.innerHTML = '';
  if (ids.length === 0) {
    // Empty-state hint so the user understands the Add button.
    const hint = document.createElement('div');
    hint.className = 'party-empty';
    hint.textContent = 'Your party is empty — click "+ Add current" to add this character.';
    strip.appendChild(hint);
    return;
  }

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

  // M42.3 — AI profile editor for this PC (manual override of AI choices).
  // Looks up the live composed character from partyComposedCharacters
  // (so edits actually take effect on the auto-fight); falls back to
  // the card's character otherwise.
  const livePc = partyComposedCharacters.find(p => String(p.id) === String(ddbId)) || character;
  card.insertAdjacentHTML('beforeend', renderPcAiEditor(livePc));
  card.insertAdjacentHTML('beforeend', renderAttackStylePicker(livePc));
  card.insertAdjacentHTML('beforeend', renderSwingPicker(livePc));

  // Click the card body (not the remove button) → switch to this character
  card.addEventListener('click', () => switchToMember(ddbId));

  // Render the mini sprite (south-facing, frame 0). Fire-and-forget.
  renderSprite(canvas, character, { scale: PARTY_CARD_SCALE, direction: 'south', frameIdx: 0 })
    .catch(() => { /* render failure is non-fatal; card still shows name */ });

  return card;
}

/**
 * M42.3 — Inline AI profile editor for a PC card. Mirrors the monster
 * version (renderAiEditor) but reads from PC_PROFILES so the dropdown
 * shows class archetypes and the considerations slider list stays the
 * same. Wires `data-pc-*` data attributes so the shared event handler
 * (handlePcAiEditorEvent) can route changes back to the live PC's
 * `_aiProfile` overlay — which profileForPc honors at decision time.
 */
function renderPcAiEditor(pc) {
  if (!pc?.id) return '';
  const profile = editableProfileFor(pc);
  const pcArchetypes = listArchetypes('pc');
  const considerationNames = listConsiderations();
  const archetypeOptions = pcArchetypes.map(a => {
    const selected = a.archetype === profile.archetype ? ' selected' : '';
    return `<option value="${escapeHtml(a.slug)}"${selected}>${escapeHtml(a.archetype)}</option>`;
  }).join('');
  const consRows = considerationNames.map(name => {
    const entry = profile.considerations[name];
    const w = entry ? (typeof entry === 'number' ? entry : entry.weight) : 0;
    const wDisp = w >= 0 ? `+${w.toFixed(1)}` : w.toFixed(1);
    return `
      <div class="ai-cons-row">
        <span class="ai-cons-name" title="${escapeHtml(name)}">${escapeHtml(name)}</span>
        <input class="ai-cons-slider" type="range" min="-1.5" max="1.5" step="0.1"
               value="${w}" data-pc-weight="${escapeHtml(pc.id)}|${escapeHtml(name)}" />
        <span class="ai-cons-value">${wDisp}</span>
      </div>`;
  }).join('');
  return `
    <details class="monster-ai-editor pc-ai-editor">
      <summary>
        <span class="ai-editor-label">AI Profile</span>
        <span class="ai-archetype-summary">${escapeHtml(profile.archetype)}</span>
      </summary>
      <div class="ai-editor-body">
        <label class="ai-row">
          <span class="ai-row-label">Archetype</span>
          <select data-pc-archetype="${escapeHtml(pc.id)}">${archetypeOptions}</select>
        </label>
        <div class="ai-considerations">${consRows}</div>
        <button class="ai-reset" type="button" data-pc-reset="${escapeHtml(pc.id)}">Reset to default</button>
      </div>
    </details>
  `;
}

/**
 * M43.3 — Attack-style dropdown for a PC card. Lists every style this
 * character has unlocked at their current level (Quick + Standard at
 * lvl 1, Power at lvl 3+, Flourish at lvl 5+). Persists the player's
 * choice via saveStyle() so it survives reloads and character
 * re-imports. The cinema (M43.2) reads this when building motions.
 */
function renderAttackStylePicker(pc) {
  if (!pc?.id) return '';
  const level = (pc.classes || []).reduce((s, c) => s + (c?.level || 0), 0) || 1;
  const choices = availableStyles(level);
  const current = styleForPc(pc);
  const options = choices.map(s => {
    const selected = s.id === current ? ' selected' : '';
    const tier = s.minLevel > 1 ? ` (lvl ${s.minLevel}+)` : '';
    return `<option value="${escapeHtml(s.id)}"${selected}>${escapeHtml(s.label)}${tier}</option>`;
  }).join('');
  return `
    <details class="monster-ai-editor pc-style-picker">
      <summary>
        <span class="ai-editor-label">Attack Style</span>
        <span class="ai-archetype-summary">${escapeHtml(choices.find(s => s.id === current)?.label || current)}</span>
      </summary>
      <div class="ai-editor-body">
        <label class="ai-row">
          <span class="ai-row-label">Style</span>
          <select data-pc-style="${escapeHtml(pc.id)}">${options}</select>
        </label>
        <p class="ai-style-hint">${escapeHtml(choices.find(s => s.id === current)?.description || '')}</p>
      </div>
    </details>
  `;
}

function handlePcAttackStyleEvent(e) {
  const t = e.target;
  if (!t || !t.dataset?.pcStyle) return;
  const pc = findPcInParty(t.dataset.pcStyle);
  if (!pc) return;
  const next = t.value;
  if (!isStyle(next)) return;
  pc._attackStyle = next;
  saveStyle(pc.id, next);
  refreshParty();
}
document.addEventListener('change', handlePcAttackStyleEvent);

/** M54 — Map a weapon (or a PC's mainhand) to a weapon class for swing
 *  gating / variation. */
function weaponClassOf(weapon) {
  return ({
    'lance-thrust': 'polearm', 'axe-cleave': 'heavy', 'dagger-stab': 'light',
    'sword-thrust': 'sword', 'sword-slash': 'sword', 'staff-cast': 'arcane',
    'bow-draw': 'bow', 'fist-jab': 'unarmed'
  })[motionForWeapon(weapon)] || 'sword';
}
function weaponClassForSwing(pc) { return weaponClassOf(pc?.equipment?.mainhand); }

/** M54 — Per-PC swing-direction picker (mirrors the Attack Style picker).
 *  Lists the weapon-appropriate cuts plus a "Varied" auto-alternate mode. */
function renderSwingPicker(pc) {
  if (!pc?.id) return '';
  const choices = availableSwings(weaponClassForSwing(pc));
  const current = swingForPc(pc);
  const opts = [
    `<option value="varied"${current === 'varied' ? ' selected' : ''}>Varied (alternate)</option>`,
    ...choices.map(s => `<option value="${escapeHtml(s.id)}"${s.id === current ? ' selected' : ''}>${escapeHtml(s.label)}</option>`)
  ].join('');
  const curLabel = current === 'varied' ? 'Varied' : (SWING_TYPES[current]?.label || current);
  const curDesc = current === 'varied'
    ? 'Alternates the swing direction each attack — no two hits look the same.'
    : (SWING_TYPES[current]?.desc || '');
  return `
    <details class="monster-ai-editor pc-style-picker">
      <summary>
        <span class="ai-editor-label">Swing</span>
        <span class="ai-archetype-summary">${escapeHtml(curLabel)}</span>
      </summary>
      <div class="ai-editor-body">
        <label class="ai-row">
          <span class="ai-row-label">Direction</span>
          <select data-pc-swing="${escapeHtml(pc.id)}">${opts}</select>
        </label>
        <p class="ai-style-hint">${escapeHtml(curDesc)}</p>
      </div>
    </details>
  `;
}

function handlePcSwingEvent(e) {
  const t = e.target;
  if (!t || !t.dataset?.pcSwing) return;
  const pc = findPcInParty(t.dataset.pcSwing);
  if (!pc) return;
  const next = t.value;
  if (!isSwingSelection(next)) return;
  pc._swingType = next;
  saveSwing(pc.id, next);
  refreshParty();
}
document.addEventListener('change', handlePcSwingEvent);

function findPcInParty(id) {
  return partyComposedCharacters.find(p => String(p.id) === String(id)) || null;
}

function handlePcAiEditorEvent(e) {
  const t = e.target;
  if (!t) return;
  if (t.dataset?.pcWeight) {
    const [id, name] = t.dataset.pcWeight.split('|');
    const pc = findPcInParty(id);
    if (!pc) return;
    const weight = parseFloat(t.value);
    pc._aiProfile = applyWeightChange(editableProfileFor(pc), name, weight);
    const valSpan = t.parentElement?.querySelector('.ai-cons-value');
    if (valSpan) valSpan.textContent = weight >= 0 ? `+${weight.toFixed(1)}` : weight.toFixed(1);
    return;
  }
  if (t.dataset?.pcArchetype) {
    const pc = findPcInParty(t.dataset.pcArchetype);
    if (!pc) return;
    pc._aiProfile = applyArchetypeSwap(editableProfileFor(pc), t.value);
    refreshParty();
    return;
  }
  if (t.dataset?.pcReset) {
    const pc = findPcInParty(t.dataset.pcReset);
    if (!pc) return;
    delete pc._aiProfile;
    refreshParty();
    return;
  }
}
document.addEventListener('input',  handlePcAiEditorEvent);
document.addEventListener('change', handlePcAiEditorEvent);
document.addEventListener('click',  handlePcAiEditorEvent);

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

