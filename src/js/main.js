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
  pruneExpired, hasActiveAnimations, entityAnimations, damagePopups,
  pushEffects, effects as effectQueue
} from './scene/combat.js';
import {
  effectsForWeaponHit, effectsForWeaponMiss,
  effectsForSpellAttack, effectsForSaveSpell,
  effectsForFeatureTrigger
} from './scene/effects.js';
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
import { calibrateEncounter } from './scene/calibrator.js';
import {
  createRecorder as createFightRecorder, archiveReplay, listReplays,
  getReplayById, filterEvents, summarizeReplay
} from './scene/fight-recorder.js';
import { diffCharacters, describeDiff } from './character/diff-character.js';
import { buildSceneSnapshot, restoreSceneFromSnapshot } from './scene/scene-snapshot.js';
import {
  buildPartyArenaScene, partyEndStateOf, rollPartyInitiative
} from './scene/versus.js';
import { planMovement } from './scene/movement.js';
import { chooseAction, fleeTargetCell, formatBreakdown } from './scene/ai/profile.js';
import { inferProfile } from './scene/ai/infer.js';
import {
  editableProfileFor, applyWeightChange, applyRetreatChange,
  applyArchetypeSwap, listArchetypes, listConsiderations
} from './scene/ai/editor.js';
import {
  resetReactionsForAll, consumeReaction, detectOpportunityAttacks,
  detectPolearmEntryOAs, shouldCastShield, consumeShield, canCastShield,
  lvl1SlotsForPc, lvl3SlotsForPc,
  shouldCounterspell, consumeCounterspell, resolveCounterspell
} from './scene/reactions.js';
import {
  spellById, spellbookFor,
  innateBlockFor, freshInnateState, rollInnateRecharges, consumeInnate,
  applyUpcast
} from './scene/monster-spells.js';
import { rollSave } from './scene/save-rolls.js';
import { MONSTER_DEFAULT_SAVES } from './scene/monster-presets.js';
import { chebyshevFeet } from './scene/grid-rules.js';
import { promptReaction } from './scene/reaction-prompt.js';

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
      aoeTemplate: currentAoeTemplate,
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

// Battlefield zoom (party-view only). The CSS variable --bf-zoom on
// .sprite-stage scales the displayed canvas; the drawing buffer stays
// at full resolution and canvasEventToPixels already converts clicks
// from CSS pixels back to buffer coords, so hit-testing keeps working
// at any zoom.
let bfZoom = 1.0;
const BF_ZOOM_MIN = 0.5;
const BF_ZOOM_MAX = 3.0;
const BF_ZOOM_STEP = 0.25;

function applyBfZoom(next) {
  bfZoom = Math.max(BF_ZOOM_MIN, Math.min(BF_ZOOM_MAX, next));
  const stage = document.querySelector('.sprite-stage');
  if (stage) stage.style.setProperty('--bf-zoom', String(bfZoom));
  const pct = document.getElementById('bf-zoom-pct');
  if (pct) pct.textContent = `${Math.round(bfZoom * 100)}%`;
}

document.addEventListener('click', (e) => {
  if (e.target?.id === 'bf-zoom-in')  applyBfZoom(bfZoom + BF_ZOOM_STEP);
  else if (e.target?.id === 'bf-zoom-out') applyBfZoom(bfZoom - BF_ZOOM_STEP);
  else if (e.target?.id === 'bf-zoom-fit') applyBfZoom(1.0);
});

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
    versusActive = false;
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
  versusActive = false;

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

// M28 — Versus mode state. Active fight tracking + setup wiring.
let versusActive = false;
let versusAutoMode = false;   // M38: bypass reaction prompts when auto-fighting

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
  document.getElementById('versus-start')?.removeAttribute('hidden');
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

async function startVersusFight() {
  const { pcIds, mode, logMode } = readVersusInputs();
  const status = document.getElementById('versus-status');
  if (pcIds.length === 0) { if (status) status.textContent = 'Pick at least one party member.'; return; }
  if (versusEncounter.length === 0) { if (status) status.textContent = 'Add at least one opponent.'; return; }

  // Optionally clear the roll log
  if (logMode === 'reset') {
    const list = document.getElementById('roll-log-list');
    if (list) list.innerHTML = '';
    const wrap = document.getElementById('roll-log');
    if (wrap) wrap.hidden = true;
  }

  versusPreviousScene = currentScene;
  versusPreviousParty = partyComposedCharacters;

  // Build monster instances from the encounter list
  const monsterInstances = versusEncounter.map((e, i) => {
    const preset = MONSTER_PRESETS[e.slug];
    return {
      id: `versus_${Date.now()}_${i}`,
      presetSlug: e.slug, name: e.name,
      hp: { current: preset.defaultHp?.max || 1, max: preset.defaultHp?.max || 1, temp: 0 },
      conditions: []
    };
  });

  // Build the arena: party PCs left, monsters right
  const arena = buildPartyArenaScene({
    pcIds, monsterInstances,
    flankingEnabled: !!currentScene?.flankingEnabled
  });
  currentScene = arena;
  versusActive = true;

  // Filter party to just selected members so the canvas only renders them
  const selectedSet = new Set(pcIds.map(String));
  partyComposedCharacters = partyComposedCharacters.filter(p => selectedSet.has(String(p.id)));

  // M38 — Seed reaction resources on every PC so Shield/Counterspell
  // can fire interactively. Reset once per fight; refreshed each round.
  for (const pc of partyComposedCharacters) {
    pc._reactionUsed = false;
    pc._lvl1Slots = lvl1SlotsForPc(pc);
    pc._lvl3Slots = lvl3SlotsForPc(pc);
  }
  // M39 — Seed spell resources on every spell-casting monster so the
  // versus auto-fight can actually cast (mirrors what the simulator
  // does at iteration start).
  for (const m of monsterInstances) {
    m._reactionUsed = false;
    const book = spellbookFor(m.presetSlug);
    if (book) m._slots = { ...(book.slots || {}) };
    const innate = innateBlockFor(m.presetSlug);
    if (innate) m._innate = freshInnateState(m.presetSlug);
  }

  // Roll initiative once at fight start
  const pcsForInit = partyComposedCharacters;
  versusInitiative = rollPartyInitiative({ pcs: pcsForInit, monsters: monsterInstances });
  currentScene.initiative = versusInitiative.map((e, i) => ({
    entityId: e.entityId, entityKind: e.entityKind,
    name: e.name, score: e.score, active: i === 0
  }));

  document.getElementById('versus-start')?.setAttribute('hidden', '');
  document.getElementById('versus-rematch')?.removeAttribute('hidden');
  document.getElementById('versus-exit')?.removeAttribute('hidden');
  if (status) {
    const partySize = partyComposedCharacters.length;
    status.textContent = `Fight! ${partySize} PC${partySize === 1 ? '' : 's'} vs ${monsterInstances.length} opponent${monsterInstances.length === 1 ? '' : 's'}. Mode: ${mode}.`;
  }
  rerender();

  versusAutoMode = (mode === 'auto' || mode === 'quick');   // M38
  if (mode === 'quick') {
    runVersusQuickStats();
  } else if (mode === 'auto') {
    runVersusPartyAuto();
  }
}

let versusInitiative = [];

let versusPreviousScene = null;
let versusPreviousParty = null;

function exitVersusFight() {
  if (versusPreviousScene) currentScene = versusPreviousScene;
  if (versusPreviousParty) partyComposedCharacters = versusPreviousParty;
  versusActive = false;
  versusPreviousScene = null;
  versusPreviousParty = null;
  populateVersusSetup();
  rerender();
}

// M29 — Quick stats for the full N-vs-M encounter via the M20 simulator.
function runVersusQuickStats() {
  const pcsWithPositions = partyComposedCharacters.map((pc, i) => ({
    ...pc, _position: positionOf(currentScene, pc.id, i)
  }));
  const monsters = currentScene.monsters || [];
  const stats = simulateEncounter({
    party: pcsWithPositions,
    monsters,
    scene: currentScene,
    iterations: 200,
    seed: Math.floor(Math.random() * 1e9)
  });
  const winPct = Math.round(stats.victoryRate * 100);
  const lossPct = Math.round((stats.monsterVictories / stats.iterations) * 100);
  const drawPct = Math.round((stats.draws / stats.iterations) * 100);
  const status = document.getElementById('versus-status');
  if (status) {
    status.textContent = `Quick stats over 200 sims: party wins ${winPct}% / loses ${lossPct}% / stalemates ${drawPct}% — avg ${stats.avgRounds.toFixed(1)} rounds.`;
  }
}

// M35 — Encounter difficulty calibrator. Runs the calibrator over the
// current versus encounter, renders a structured DM-facing report into
// #versus-calibrator with win rate, lethality, MVP, DMG difficulty.
function runVersusCalibrator() {
  const pcsWithPositions = partyComposedCharacters.map((pc, i) => ({
    ...pc, _position: positionOf(currentScene, pc.id, i)
  }));
  const monsters = currentScene.monsters || [];
  if (pcsWithPositions.length === 0 || monsters.length === 0) {
    renderCalibratorReport({ empty: true });
    return;
  }
  // Use a fixed seed so the report is reproducible inside one session;
  // re-roll the seed when the user changes the encounter list.
  const seed = (typeof versusCalibratorSeed === 'number') ? versusCalibratorSeed : (versusCalibratorSeed = Math.floor(Math.random() * 1e9));
  const report = calibrateEncounter({
    party: pcsWithPositions,
    monsters,
    scene: currentScene,
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

// M29 — Auto-fight in initiative order. Each tick: pick the next alive
// entity in the rolled initiative list, pick the lowest-HP enemy as
// target, run runAttackPrompt. Cap at 30 rounds for safety.
async function runVersusPartyAuto() {
  const status = document.getElementById('versus-status');
  const order = versusInitiative.slice();   // captured at fight start
  const stepDelay = 950;                    // ms between turns

  // M36 — Spin up a recorder for this fight so the user can replay it.
  currentFightRecorder = createFightRecorder({
    participants: [
      ...partyComposedCharacters.map(p => ({ id: p.id, name: p.name, kind: 'pc', hp: p.hp })),
      ...(currentScene.monsters || []).map(m => ({ id: m.id, name: m.name, kind: 'monster', hp: m.hp }))
    ]
  });
  currentFightRecorder.start();

  for (let round = 1; round <= 30; round++) {
    currentFightRecorder.setRound(round);
    // M33.0 — refresh every combatant's reaction at the top of the round.
    resetReactionsForAll(partyComposedCharacters);
    resetReactionsForAll(currentScene.monsters || []);
    // M39 — roll recharge for any innate-cast monsters
    for (const m of (currentScene.monsters || [])) {
      if (m._innate) rollInnateRecharges(m);
    }
    for (const entry of order) {
      if (!versusActive) return;
      const entity = resolveEntityById(entry.entityId, entry.entityKind);
      if (!entity || versusHpOf(entity, entry.entityKind) <= 0) continue;

      // M32 — Target selection: PCs use lowest-HP (player would, too);
      // monsters consult their AI profile.
      let target;
      let plan = null;
      if (entry.entityKind === 'monster') {
        plan = pickVersusTargetWithProfile(entity);
        target = plan?.target || pickLowestHpEnemy('monster');
      } else {
        target = pickLowestHpEnemy(entry.entityKind);
      }
      if (!target) break;   // no enemies left, end will detect

      if (plan && plan.kind === 'flee') {
        runVersusFlee(entity, target.entity);
        logVersusAiPlan(entity, plan);
        currentFightRecorder.record({
          type: 'note',
          actorId: entity.id, actorName: entity.name || 'Monster',
          summary: `${entity.name} flees (${plan.archetype})`,
          detail: { plan }
        });
        await new Promise(f => setTimeout(f, stepDelay));
        const verdict0 = currentPartyEndState();
        if (verdict0) return endVersusFight(verdict0, round);
        continue;
      }

      if (plan) logVersusAiPlan(entity, plan);
      const beforeTargetHp = versusHpOf(target.entity, target.kind);
      // M39 — Monster cast plans dispatch to the spell handler instead
      // of the weapon-attack path. PCs and non-cast monster turns still
      // route through attackInVersus.
      if (plan && plan.kind === 'cast' && entry.entityKind === 'monster') {
        await castInVersus({ kind: 'monster', entity }, plan);
      } else {
        await attackInVersus({ kind: entry.entityKind, entity }, { kind: target.kind, entity: target.entity });
      }
      const afterTargetHp = versusHpOf(target.entity, target.kind);
      currentFightRecorder.record({
        type: 'attack',
        actorId: entity.id, actorName: entity.name || '?',
        targetId: target.entity.id, targetName: target.entity.name || '?',
        summary: `${entity.name} attacks ${target.entity.name}` +
          (afterTargetHp < beforeTargetHp ? ` for ${beforeTargetHp - afterTargetHp} dmg` : ' — miss'),
        detail: { dmg: beforeTargetHp - afterTargetHp, plan }
      });
      if (afterTargetHp <= 0 && beforeTargetHp > 0) {
        currentFightRecorder.record({
          type: 'death',
          actorId: target.entity.id, actorName: target.entity.name || '?',
          summary: `${target.entity.name} falls`,
          detail: {}
        });
      }
      await new Promise(f => setTimeout(f, stepDelay));

      const verdict = currentPartyEndState();
      if (verdict) return endVersusFight(verdict, round);
    }
    if (status) {
      const pcHp = partyComposedCharacters.map(p => p.hp?.current ?? 0).reduce((a, b) => a + b, 0);
      const monHp = (currentScene.monsters || []).map(m => m.hp?.current ?? 0).reduce((a, b) => a + b, 0);
      status.textContent = `Round ${round}: party HP ${pcHp}, enemy HP ${monHp}.`;
    }
  }
  endVersusFight('draw', 30);
}

function resolveEntityById(id, kind) {
  if (kind === 'pc') return partyComposedCharacters.find(p => String(p.id) === String(id));
  return (currentScene.monsters || []).find(m => String(m.id) === String(id));
}

function versusHpOf(entity, kind) {
  if (kind === 'pc') return entity.hp?.current ?? 0;
  return entity.hp?.current ?? 0;
}

// M32 — Monster AI: ask the profile which PC to engage (or whether to
// flee). `monster` is a live scene-instance with .position + .hp.{current,max}.
// Returns { kind, target: {kind:'pc', entity}, plan } or null.
function pickVersusTargetWithProfile(monster) {
  const enemies = partyComposedCharacters.filter(p => (p.hp?.current ?? 0) > 0);
  if (enemies.length === 0) return null;
  const allies = (currentScene.monsters || [])
    .filter(m => m !== monster && (m.hp?.current ?? 0) > 0);
  const plan = chooseAction({
    self: monster,
    slug: monster.presetSlug,
    enemies,
    allies
  });
  const target = enemies.find(p => String(p.id) === String(plan.targetId))
              || enemies[0];
  return { kind: plan.kind, plan, target: { kind: 'pc', entity: target } };
}

function runVersusFlee(monster, threat) {
  const from = monster.position;
  if (!from) return;
  const occupied = versusOccupiedCells(monster.id);
  const fleeCell = fleeTargetCell(monster, threat,
    { cols: currentScene.cols, rows: currentScene.rows });
  const next = planMovement({
    from, to: fleeCell, weapon: { name: 'Dash' },
    speedFt: 30, occupied,
    bounds: { cols: currentScene.cols, rows: currentScene.rows }
  });
  if (next && (next.col !== from.col || next.row !== from.row)) {
    monster.position = next;
    rerender();
  }
}

function logVersusAiPlan(monster, plan) {
  const wrap = document.getElementById('roll-log');
  const list = document.getElementById('roll-log-list');
  if (!wrap || !list) return;
  wrap.hidden = false;
  const li = document.createElement('li');
  li.className = 'roll-log-entry roll-ai';
  const verbHtml = plan.kind === 'flee'
    ? '<strong>flees</strong>'
    : `targets <strong>focus</strong>`;
  li.innerHTML = `
    <div class="roll-headline">${escapeHtml(monster.name || 'Monster')} ${verbHtml} (${escapeHtml(plan.archetype)})</div>
    <div class="roll-line ai-breakdown">${escapeHtml(formatBreakdown(plan))}</div>
  `;
  list.insertBefore(li, list.firstChild);
  while (list.children.length > 20) list.removeChild(list.lastChild);
}

function pickLowestHpEnemy(attackerKind) {
  if (attackerKind === 'pc') {
    let best = null;
    for (const m of (currentScene.monsters || [])) {
      if (m.hp?.current <= 0) continue;
      if (!best || m.hp.current < best.hp.current) best = m;
    }
    return best ? { kind: 'monster', entity: best } : null;
  }
  let best = null;
  for (const p of partyComposedCharacters) {
    if ((p.hp?.current ?? 0) <= 0) continue;
    if (!best || p.hp.current < best.hp.current) best = p;
  }
  return best ? { kind: 'pc', entity: best } : null;
}

function currentPartyEndState() {
  return partyEndStateOf({
    partyHps: partyComposedCharacters.map(p => p.hp?.current ?? 0),
    monsterHps: (currentScene.monsters || []).map(m => m.hp?.current ?? 0)
  });
}

// Helper: invokes the same combat flow used by manual play, but FIRST
// runs a movement step so the attacker closes the distance when out
// of reach. The movement is persisted on the scene (PC positions in
// scene.positions, monster.position on the instance) so subsequent
// rounds see the new placement, the M27 lunge effect fires from the
// new cell, and the M11 resolver computes reach from the post-move
// position.
async function attackInVersus(attackerHit, targetHit) {
  await versusMoveBeforeAttack(attackerHit, targetHit);
  combat.attacker = { id: attackerHit.entity.id, kind: attackerHit.kind };
  combat.mode = 'pick-target';
  runAttackPrompt(targetHit.kind, targetHit.entity);
}

// M38 — Wrapper around runVersusOpportunityAttack that prompts the
// player when a PC would burn their reaction. Returns true if the OA
// fired, false if the player declined or auto-mode skipped it.
async function maybeRunOaWithPrompt(triggerer, moverHit, moverBeforePos) {
  if (!triggerer || !triggerer.live) return false;
  if (triggerer.kind === 'pc' && !versusAutoMode) {
    const accepted = await promptReaction({
      title: `${triggerer.live.name || 'PC'} — opportunity attack?`,
      body: `${moverHit.entity.name || 'Target'} is leaving your reach.`,
      costLabel: '1 reaction',
      defaultMs: 5000,
      auto: false
    });
    if (!accepted) return false;
  }
  runVersusOpportunityAttack(triggerer, moverHit, moverBeforePos);
  return true;
}

async function versusMoveBeforeAttack(attackerHit, targetHit) {
  const attackerPos = attackerHit.kind === 'pc'
    ? currentScene.positions?.[String(attackerHit.entity.id)]
    : attackerHit.entity.position;
  const targetPos = targetHit.kind === 'pc'
    ? currentScene.positions?.[String(targetHit.entity.id)]
    : targetHit.entity.position;
  if (!attackerPos || !targetPos) return;
  const weapon = attackerHit.kind === 'pc'
    ? (attackerHit.entity.equipment?.mainhand || null)
    : { name: MONSTER_PRESETS[attackerHit.entity.presetSlug]?.attack?.name };
  const occupied = versusOccupiedCells(attackerHit.entity.id);
  const next = planMovement({
    from: attackerPos, to: targetPos, weapon,
    speedFt: 30, occupied,
    bounds: { cols: currentScene.cols, rows: currentScene.rows }
  });
  if (!next || (next.col === attackerPos.col && next.row === attackerPos.row)) return;
  // M33.0 — opportunity attacks fire BEFORE the move is applied. We
  // build a uniform "shape" for the mover + every hostile so
  // detectOpportunityAttacks can read positions/weapons consistently.
  const moverShape = {
    id: attackerHit.entity.id,
    weapon: attackerHit.kind === 'pc' ? weapon : { name: weapon?.name }
  };
  const hostileShapes = buildVersusHostileShapesFor(attackerHit);
  const leaveTriggers = detectOpportunityAttacks({
    mover: moverShape, before: attackerPos, after: next, hostiles: hostileShapes
  });
  const entryTriggers = detectPolearmEntryOAs({
    mover: moverShape, before: attackerPos, after: next, hostiles: hostileShapes
  });
  // M38 — Prompt the player before firing a PC's own opportunity
  // attacks. Monster OAs against a moving PC always auto-fire (the
  // monster is AI-controlled).
  for (const { triggerer } of leaveTriggers) {
    const fired = await maybeRunOaWithPrompt(triggerer, attackerHit, attackerPos);
    if (fired) {
      consumeReaction(triggerer.live);
      if (versusHpOf(attackerHit.entity, attackerHit.kind) <= 0) break;
    }
  }
  for (const { triggerer } of entryTriggers) {
    const fired = await maybeRunOaWithPrompt(triggerer, attackerHit, next);
    if (fired) {
      consumeReaction(triggerer.live);
      if (versusHpOf(attackerHit.entity, attackerHit.kind) <= 0) break;
    }
  }
  if (attackerHit.kind === 'pc') {
    currentScene.positions = { ...(currentScene.positions || {}), [String(attackerHit.entity.id)]: next };
  } else {
    attackerHit.entity.position = next;
  }
}

// M33.0 — list the live opposing-side entities relative to `attackerHit`,
// each wrapped in a shape detectOpportunityAttacks can consume. The
// wrapper keeps a reference back to the live entity so we can call
// consumeReaction() and resolve the OA against the actual record.
function buildVersusHostileShapesFor(attackerHit) {
  if (attackerHit.kind === 'pc') {
    return (currentScene.monsters || [])
      .filter(m => (m.hp?.current ?? 0) > 0)
      .map(m => ({
        live: m,
        kind: 'monster',
        _position: m.position,
        conditions: m.conditions || [],
        _reactionUsed: !!m._reactionUsed,
        attack: { name: MONSTER_PRESETS[m.presetSlug]?.attack?.name }
      }));
  }
  return partyComposedCharacters
    .filter(p => (p.hp?.current ?? 0) > 0)
    .map(p => ({
      live: p,
      kind: 'pc',
      _position: currentScene.positions?.[String(p.id)],
      conditions: p.conditions || [],
      _reactionUsed: !!p._reactionUsed,
      weapon: p.equipment?.mainhand || null
    }));
}

// M33.0 — Execute one opportunity attack from `triggerer` against
// `moverHit`. The mover is interrupted at `moverBeforePos`, so we
// resolve reach distance from that cell. Damage applied + logged.
function runVersusOpportunityAttack(triggerer, moverHit, moverBeforePos) {
  const moverEntity = moverHit.entity;
  const moverKind = moverHit.kind;
  const attackerLive = triggerer.live;
  // Build the resolver's attacker/target objects
  let attackStats, weapon, attackerName, attackerAc;
  if (triggerer.kind === 'pc') {
    const a = deriveWeaponAttack(attackerLive, triggerer.weapon);
    attackStats = {
      bonus: a.bonus, dice: a.dice, damageType: a.damageType,
      parts: [{ source: triggerer.weapon?.name || 'Attack', value: a.bonus }],
      damageParts: []
    };
    weapon = triggerer.weapon;
    attackerName = attackerLive.name || 'PC';
    attackerAc = deriveAC(attackerLive);
  } else {
    const preset = MONSTER_PRESETS[attackerLive.presetSlug] || {};
    const atk = preset.attack || { name: 'Strike', bonus: 2, dice: '1d6' };
    attackStats = {
      bonus: atk.bonus, dice: atk.dice, damageType: null,
      parts: [{ source: atk.name, value: atk.bonus }],
      damageParts: []
    };
    weapon = { name: atk.name };
    attackerName = attackerLive.name || 'Monster';
    attackerAc = preset.ac ?? 12;
  }

  const targetForResolver = {
    ...moverEntity,
    conditions: moverEntity.conditions || [],
    _position: moverBeforePos
  };
  const attackerForResolver = {
    ...attackerLive,
    _position: triggerer._position,
    conditions: attackerLive.conditions || []
  };
  const targetAC = moverKind === 'pc' ? deriveAC(moverEntity) : (MONSTER_PRESETS[moverEntity.presetSlug]?.ac ?? 12);
  const verdict = resolveAttack({
    attacker: attackerForResolver,
    target: targetForResolver,
    weapon, scene: currentScene,
    attackerKind: triggerer.kind,
    targetKind: moverKind,
    targetAC,
    advantageOverride: 'auto',
    allies: [], hostiles: [],
    attackStats
  });
  if (verdict.autoMiss) {
    appendReactionLog({
      attackerName, targetName: moverEntity.name || 'Target',
      verdict, atk: { hit: false, total: 0 }, dmg: 0
    });
    return;
  }
  const atk = verdict.autoCrit
    ? { hit: true, crit: true, total: 20 + verdict.attackBonus.total }
    : rollAttack({ bonus: verdict.attackBonus.total, advantage: verdict.d20.mode, targetAC }, undefined);
  let dmgTotal = 0;
  if (atk.hit) {
    const dmg = rollDamage(verdict.damage.dice, { crit: atk.crit });
    dmgTotal = dmg.total;
    applyDamage(moverKind, moverEntity.id, dmgTotal);
  }
  appendReactionLog({
    attackerName, targetName: moverEntity.name || 'Target',
    verdict, atk, dmg: dmgTotal, weaponName: weapon?.name || 'Attack'
  });
  // Silence the unused-AC warning — keeps the log readable if we extend later.
  void attackerAc;
}

// =====================================================================
// M39 — Live monster spellcasting in versus. Mirrors the simulator's
// runMonsterSpell, but operates on live PC characters + scene monster
// instances (hp shape: { current, max }). Counterspell witnesses get
// an interactive prompt; auto-fight skips it via versusAutoMode.
// =====================================================================

async function castInVersus(attackerHit, plan) {
  if (!attackerHit || !plan?.spellId) return;
  const caster = attackerHit.entity;
  const baseSpell = spellById(plan.spellId);
  if (!baseSpell) return;
  // M40 — Upcast: scale dice/darts up to the chosen slot level.
  const spell = applyUpcast(baseSpell, plan.castAtLevel);
  const book = spellbookFor(caster.presetSlug);
  const innateBook = !book && innateBlockFor(caster.presetSlug)
    ? { dc: innateBlockFor(caster.presetSlug).dc || 12, attackBonus: 4, abilityMod: 3 }
    : null;
  const effectiveBook = book || innateBook;
  if (!effectiveBook) return;

  // Slot accounting (consume regardless of counter outcome — RAW).
  // M40: drain the slot the AI picked, not the spell's base level.
  if (plan.isInnate) {
    caster._innate ??= freshInnateState(caster.presetSlug);
    consumeInnate(caster, plan.spellId);
  } else if (caster._slots) {
    const lvl = Math.max(baseSpell.level || 0, plan.castAtLevel || baseSpell.level || 0);
    if (lvl > 0 && caster._slots[lvl] > 0) {
      caster._slots[lvl] -= 1;
    }
  }

  // Log the cast attempt
  appendCastLog({
    casterName: caster.name || 'Monster',
    spellName: spell.name, targetName: plan.targetSide === 'ally'
      ? findVersusEntityById(plan.targetId)?.name
      : findVersusEntityById(plan.targetId)?.name,
    isInnate: plan.isInnate,
    level: baseSpell.level,
    castAtLevel: plan.castAtLevel || baseSpell.level
  });

  // M39.1 — Counterspell witness loop. Only PCs can counter monster
  // casts. Walk eligible witnesses; first acceptance wins.
  if (spell.level >= 2 || (spell.level === 0 && !plan.isInnate)) {
    for (const pc of partyComposedCharacters) {
      if ((pc.hp?.current ?? 0) <= 0) continue;
      if (!shouldCounterspell(pc, spell.level)) continue;
      const accepted = await promptReaction({
        title: `${pc.name || 'PC'} — Counterspell ${spell.name}?`,
        body: `${caster.name || 'Monster'} is casting a level ${spell.level} spell.`,
        costLabel: `1 reaction · 1 of ${pc._lvl3Slots || 0} 3rd-level slot${(pc._lvl3Slots || 0) === 1 ? '' : 's'}`,
        defaultMs: 5000,
        auto: !!versusAutoMode,
        autoAnswer: true
      });
      if (!accepted) continue;
      const mod = pcCounterMod(pc);
      const result = resolveCounterspell({ spellLevel: spell.level, counterMod: mod });
      consumeCounterspell(pc);
      appendCounterspellLog({
        counterName: pc.name || 'PC',
        spellName: spell.name, level: spell.level,
        countered: result.countered, mode: result.mode,
        d20: result.d20, total: result.total, dc: result.dc
      });
      if (result.countered) {
        rerender();
        return;     // spell fizzles
      }
      break;        // failed counter still burns the witness's reaction
    }
  }

  // Resolve the spell. Branch by kind — mirrors the simulator's
  // runMonsterSpell logic but applies damage / conditions to live
  // entities (hp.{current, max}).
  await resolveVersusSpell(attackerHit, spell, plan, effectiveBook);
  rerender();
}

async function resolveVersusSpell(attackerHit, spell, plan, effectiveBook) {
  const target = findVersusEntityById(plan.targetId);
  if (!target) return;
  const caster = attackerHit.entity;

  if (spell.kind === 'heal') {
    const dmgRoll = rollDamage(spell.dice, { crit: false });
    const mod = spell.addsAbilityMod ? (effectiveBook.abilityMod || 0) : 0;
    const heal = dmgRoll.total + mod;
    if (target.hp) target.hp = { ...target.hp, current: Math.min(target.hp.max, target.hp.current + heal) };
    appendCastLogTail(`${caster.name} heals ${target.name} for ${heal}`);
    return;
  }

  if (spell.kind === 'auto-hit') {
    // M37 RAW: Shield negates Magic Missile entirely.
    if (canCastShield(target)) {
      const accepted = await promptReaction({
        title: `${target.name} — Cast Shield vs ${spell.name}?`,
        body: `Negates all ${spell.darts || 1} darts.`,
        costLabel: `1 reaction · 1 of ${target._lvl1Slots || 0} 1st-level slot${(target._lvl1Slots || 0) === 1 ? '' : 's'}`,
        defaultMs: 5000,
        auto: !!versusAutoMode, autoAnswer: true
      });
      if (accepted) {
        consumeShield(target);
        appendCastLogTail(`${target.name} casts Shield — no damage`);
        return;
      }
    }
    let total = 0;
    for (let i = 0; i < (spell.darts || 1); i++) {
      total += rollDamage(spell.perDart, { crit: false }).total;
    }
    applyVersusDamage(target, total);
    appendCastLogTail(`${total} ${spell.damageType || ''} damage`);
    return;
  }

  if (spell.kind === 'spell-attack') {
    const ac = deriveAC(target);
    const atk = rollAttack({ bonus: effectiveBook.attackBonus, advantage: 'normal', targetAC: ac });
    if (atk.hit && !atk.crit && shouldCastShield({ target, attackerTotal: atk.total, targetAc: ac })) {
      const accepted = await promptReaction({
        title: `${target.name} — Cast Shield?`,
        body: `${caster.name}'s ${spell.name} hit by ${atk.total - ac}; +5 AC would dodge it.`,
        costLabel: `1 reaction · 1 of ${target._lvl1Slots || 0} 1st-level slot${(target._lvl1Slots || 0) === 1 ? '' : 's'}`,
        defaultMs: 5000,
        auto: !!versusAutoMode, autoAnswer: true
      });
      if (accepted) {
        consumeShield(target);
        appendCastLogTail(`${target.name} casts Shield — miss`);
        return;
      }
    }
    if (!atk.hit) { appendCastLogTail(`miss`); return; }
    const dmg = rollDamage(spell.dice, { crit: atk.crit });
    applyVersusDamage(target, dmg.total);
    appendCastLogTail(`${atk.crit ? 'CRIT ' : ''}${dmg.total} ${spell.damageType || ''} damage`);
    return;
  }

  // AoE save (fire-breath) — every hostile in range rolls
  if (spell.aoe) {
    const center = caster.position;
    if (!center) return;
    let total = 0;
    for (const pc of partyComposedCharacters) {
      if ((pc.hp?.current ?? 0) <= 0) continue;
      const pcPos = currentScene.positions?.[String(pc.id)];
      if (!pcPos || chebyshevFeet(center, pcPos) > (spell.range || 15)) continue;
      const pcMod = pc.abilityModifiers?.[spell.saveStat] ?? 0;
      const save = rollSave({ bonus: pcMod, dc: effectiveBook.dc });
      const dmgRoll = rollDamage(spell.dice, { crit: false });
      let dmg = dmgRoll.total;
      if (save.success) dmg = spell.saveOnHalf ? Math.floor(dmg / 2) : 0;
      applyVersusDamage(pc, dmg);
      total += dmg;
    }
    appendCastLogTail(`${total} total ${spell.damageType || ''} damage across the cone`);
    return;
  }

  // Single-target save (cantrip-save / leveled-save)
  const saveStat = spell.saveStat;
  const targetMod = saveBonusForVersusEntity(target, saveStat);
  const save = rollSave({ bonus: targetMod, dc: effectiveBook.dc });
  let dmg = 0;
  if (spell.dice) {
    const dmgRoll = rollDamage(spell.dice, { crit: false });
    dmg = dmgRoll.total;
    if (save.success) dmg = spell.saveOnHalf ? Math.floor(dmg / 2) : 0;
    applyVersusDamage(target, dmg);
  }
  if (!save.success && spell.appliesCondition) {
    if (!Array.isArray(target.conditions)) target.conditions = [];
    if (!target.conditions.includes(spell.appliesCondition)) {
      target.conditions.push(spell.appliesCondition);
    }
  }
  const saveDesc = save.success ? 'SAVE' : 'FAIL';
  appendCastLogTail(`${saveDesc} (d20=${save.kept}${targetMod >= 0 ? '+' : ''}${targetMod}=${save.total} vs DC ${effectiveBook.dc})${dmg > 0 ? ` · ${dmg} damage` : ''}${!save.success && spell.appliesCondition ? ` · ${spell.appliesCondition}` : ''}`);
}

function findVersusEntityById(id) {
  if (!id) return null;
  return partyComposedCharacters.find(p => String(p.id) === String(id))
      || (currentScene.monsters || []).find(m => String(m.id) === String(id))
      || null;
}

function applyVersusDamage(entity, damage) {
  if (!entity || damage <= 0 || !entity.hp) return;
  const next = Math.max(0, entity.hp.current - damage);
  entity.hp = { ...entity.hp, current: next };
}

function saveBonusForVersusEntity(entity, stat) {
  if (!entity || !stat) return 0;
  if (entity.abilityModifiers) return entity.abilityModifiers[stat] ?? 0;   // PC
  const table = MONSTER_DEFAULT_SAVES[entity.presetSlug];
  return table ? (table[stat] || 0) : 0;
}

function pcCounterMod(pc) {
  const classes = pc.classes || [];
  for (const c of classes) {
    const name = String(c?.name || '').toLowerCase();
    if (name === 'wizard' || name === 'artificer') return pc.abilityModifiers?.INT ?? 0;
    if (name === 'cleric' || name === 'druid' || name === 'ranger') return pc.abilityModifiers?.WIS ?? 0;
    if (name === 'bard' || name === 'sorcerer' || name === 'warlock' || name === 'paladin') return pc.abilityModifiers?.CHA ?? 0;
  }
  return pc.abilityModifiers?.INT ?? 0;
}

function appendCastLog({ casterName, spellName, targetName, isInnate, level, castAtLevel }) {
  const wrap = document.getElementById('roll-log');
  const list = document.getElementById('roll-log-list');
  if (!wrap || !list) return;
  wrap.hidden = false;
  const li = document.createElement('li');
  li.className = 'roll-log-entry roll-spell';
  let tag;
  if (isInnate) tag = 'INNATE';
  else if (level === 0) tag = 'CANTRIP';
  else if (castAtLevel && castAtLevel > level) tag = `Lvl ${level}→${castAtLevel}`;
  else tag = `Lvl ${level}`;
  li.innerHTML = `
    <div class="roll-headline"><span class="spell-tag">✦ ${escapeHtml(tag)}</span> <strong>${escapeHtml(casterName)}</strong> casts <strong>${escapeHtml(spellName)}</strong>${targetName ? ` on ${escapeHtml(targetName)}` : ''}</div>
    <div class="roll-line roll-spell-tail"></div>
  `;
  list.insertBefore(li, list.firstChild);
  while (list.children.length > 20) list.removeChild(list.lastChild);
}

function appendCastLogTail(msg) {
  const tail = document.querySelector('.roll-log-entry.roll-spell .roll-spell-tail');
  if (tail) tail.textContent = msg;
}

function appendCounterspellLog({ counterName, spellName, level, countered, mode, d20, total, dc }) {
  const wrap = document.getElementById('roll-log');
  const list = document.getElementById('roll-log-list');
  if (!wrap || !list) return;
  wrap.hidden = false;
  const li = document.createElement('li');
  li.className = `roll-log-entry roll-reaction ${countered ? 'roll-hit' : 'roll-miss'}`;
  const detail = mode === 'auto'
    ? `auto-counter (lvl 3 vs lvl ${level})`
    : `check d20=${d20}+${total - d20} vs DC ${dc} — ${countered ? 'success' : 'fail'}`;
  li.innerHTML = `
    <div class="roll-headline"><span class="reaction-tag">⚡ COUNTERSPELL</span> ${escapeHtml(counterName)} ${countered ? 'counters' : 'tries to counter'} ${escapeHtml(spellName)}</div>
    <div class="roll-line">${escapeHtml(detail)}</div>
  `;
  list.insertBefore(li, list.firstChild);
  while (list.children.length > 20) list.removeChild(list.lastChild);
}

function appendReactionLog({ attackerName, targetName, verdict, atk, dmg, weaponName = 'Attack' }) {
  const wrap = document.getElementById('roll-log');
  const list = document.getElementById('roll-log-list');
  if (!wrap || !list) return;
  wrap.hidden = false;
  const li = document.createElement('li');
  const cls = atk.crit ? 'roll-crit' : atk.hit ? 'roll-hit' : 'roll-miss';
  li.className = `roll-log-entry roll-reaction ${cls}`;
  const tail = atk.hit
    ? `<strong>HIT</strong> · ${weaponName} ${verdict.damage.dice} = ${dmg} dmg`
    : `<strong>MISS</strong>`;
  li.innerHTML = `
    <div class="roll-headline">
      <span class="reaction-tag">⚡ REACTION</span>
      ${escapeHtml(attackerName)}'s opportunity attack on ${escapeHtml(targetName)}
    </div>
    <div class="roll-line">${tail}</div>
  `;
  list.insertBefore(li, list.firstChild);
  while (list.children.length > 20) list.removeChild(list.lastChild);
}

function versusOccupiedCells(excludeId) {
  const out = new Set();
  for (const pc of partyComposedCharacters) {
    if (String(pc.id) === String(excludeId)) continue;
    const pos = currentScene.positions?.[String(pc.id)];
    if (pos) out.add(`${pos.col},${pos.row}`);
  }
  for (const m of (currentScene.monsters || [])) {
    if (String(m.id) === String(excludeId)) continue;
    if (m.position) out.add(`${m.position.col},${m.position.row}`);
  }
  return out;
}

function endVersusFight(outcome, rounds) {
  const status = document.getElementById('versus-status');
  // M36 — finalize + archive the recording, then surface the replay UI.
  if (currentFightRecorder) {
    currentFightRecorder.finalize(outcome);
    archiveReplay(currentFightRecorder.getReplay());
    currentFightRecorder = null;
    renderReplayPanel();
  }
  if (!status) return;
  if (outcome === 'draw') {
    status.textContent = `Stalemate after ${rounds} rounds.`;
    return;
  }
  const partyWon = outcome === 'party-wins' || outcome === 'pc-wins';
  const label = partyWon ? '🏆 Party wins' : '💀 Monsters win';
  status.textContent = `${label} in ${rounds} round${rounds === 1 ? '' : 's'}.`;
}

// M36 — Currently-recording fight. Lives at module scope so the auto-
// fight loop, attack helpers, and end handler can all reach it.
let currentFightRecorder = null;

/**
 * M36 — Render the post-fight replay panel into #versus-replay. Pulls
 * the most recent replay from history; offers a dropdown for older
 * fights and filter chips for event types.
 */
function renderReplayPanel(opts = {}) {
  const wrap = document.getElementById('versus-replay');
  if (!wrap) return;
  const replays = listReplays();
  if (replays.length === 0) { wrap.hidden = true; return; }
  wrap.hidden = false;

  const selectedId = opts.selectedId || replays[0].id;
  const selectedFilters = opts.filters || activeReplayFilters;
  activeReplayFilters = selectedFilters;
  const replay = getReplayById(selectedId) || replays[0];
  const counts = summarizeReplay(replay);
  const events = filterEvents(replay, selectedFilters.size ? [...selectedFilters] : null);

  const replayOptions = replays.map(r => {
    const label = `${replayShortLabel(r)} — ${r.outcome || 'in progress'}`;
    return `<option value="${escapeHtml(r.id)}"${r.id === replay.id ? ' selected' : ''}>${escapeHtml(label)}</option>`;
  }).join('');
  const filterButtons = ['attack', 'reaction', 'spell', 'heal', 'death'].map(t => {
    const active = selectedFilters.has(t) ? ' replay-filter-active' : '';
    return `<button class="replay-filter${active}" data-replay-filter="${t}" type="button">${t} (${counts[t] || 0})</button>`;
  }).join('');
  const eventRows = events.map(e => {
    const kindClass = `replay-event replay-event-${escapeHtml(e.type)}`;
    return `<li class="${kindClass}"><span class="replay-event-round">r${e.round}</span> ${escapeHtml(e.summary)}</li>`;
  }).join('');

  wrap.innerHTML = `
    <div class="replay-head">
      <strong>Replay</strong>
      <select class="replay-picker" id="replay-picker">${replayOptions}</select>
    </div>
    <div class="replay-filters">${filterButtons}<button class="replay-filter replay-filter-clear" data-replay-filter="__clear">all</button></div>
    <ol class="replay-events">${eventRows || '<li class="replay-empty">No events.</li>'}</ol>
  `;
}

function replayShortLabel(r) {
  const date = new Date(r.startedAt);
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return `${hh}:${mm} (${r.rounds}r)`;
}

let activeReplayFilters = new Set();   // M36.1 — UI state for filter chips

document.addEventListener('click', (e) => {
  const filter = e.target?.dataset?.replayFilter;
  if (!filter) return;
  if (filter === '__clear') {
    activeReplayFilters.clear();
  } else {
    if (activeReplayFilters.has(filter)) activeReplayFilters.delete(filter);
    else activeReplayFilters.add(filter);
  }
  const picker = document.getElementById('replay-picker');
  renderReplayPanel({ selectedId: picker?.value, filters: activeReplayFilters });
});
document.addEventListener('change', (e) => {
  if (e.target?.id !== 'replay-picker') return;
  renderReplayPanel({ selectedId: e.target.value, filters: activeReplayFilters });
});

document.addEventListener('click', (e) => {
  if (e.target.id === 'versus-start')     { startVersusFight();   return; }
  if (e.target.id === 'versus-rematch')   { startVersusFight();   return; }
  if (e.target.id === 'versus-exit')      { exitVersusFight();    return; }
  if (e.target.id === 'versus-calibrate') { runVersusCalibrator(); return; }
});

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

async function runAttackPrompt(targetKind, targetEntity) {
  const attackerHit = findHitById(combat.attacker.id);
  const targetHit   = { kind: targetKind, entity: targetEntity };
  if (!attackerHit) {
    setCombatStatus('Attacker is gone. Cancelled.');
    cancelAttack();
    rerender();
    return;
  }
  // M38 — Refresh the attacker's reaction at the start of their turn
  // (PHB p190: each creature regains its reaction at the start of its
  // turn). The auto-loop refreshes everyone at top-of-round; for manual
  // play we refresh per-turn instead.
  if (attackerHit.entity) attackerHit.entity._reactionUsed = false;
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

  // M38 — Shield reaction prompt. Fires when a monster's attack would
  // land on a PC by 1..5 over their AC. We pause the flow to ask;
  // auto-fight bypasses the prompt by passing auto:true.
  let shielded = false;
  if (atk.hit && !atk.crit && attackerHit.kind === 'monster' && targetKind === 'pc' &&
      shouldCastShield({ target: targetEntity, attackerTotal: atk.total, targetAc: ac })) {
    const slots = targetEntity._lvl1Slots ?? 0;
    const accepted = await promptReaction({
      title: `Cast Shield? (${targetEntity.name})`,
      body: `${attackerName}'s ${atk.total} vs your AC ${ac} — +5 AC would dodge it.`,
      costLabel: `1 reaction · 1 of ${slots} 1st-level slot${slots === 1 ? '' : 's'}`,
      defaultMs: 5000,
      auto: !!versusAutoMode,
      autoAnswer: true   // auto-fight: always cast if it would help
    });
    if (accepted) {
      consumeShield(targetEntity);
      atk.hit = false;
      shielded = true;
      appendReactionLog({
        attackerName, targetName: targetEntity.name || 'PC',
        verdict, atk: { hit: false, total: atk.total }, dmg: 0, weaponName: 'Shield ✦'
      });
    }
  }

  let damage = 0;
  let dmgRoll = null;
  if (atk.hit) {
    dmgRoll = rollDamage(finalDmgDice, { crit: atk.crit });
    damage = dmgRoll.total;
    applyDamage(targetKind, targetEntity.id, damage);
  }
  void shielded;
  // Feed into combat.js (animation + floating popup). Animations only
  // fire on hit since the existing pipeline expects a damage amount.
  // M27 — additionally push the per-action effect descriptors so the
  // compositor draws slash arcs / projectiles / bursts on top of the
  // existing M4 flash animation.
  const attackerForFx = {
    id: attackerHit.entity.id,
    _position: attackerHit.kind === 'pc'
      ? positionOf(currentScene, attackerHit.entity.id, partyComposedCharacters.indexOf(attackerHit.entity))
      : attackerHit.entity.position
  };
  const targetForFx = {
    id: targetEntity.id,
    _position: targetKind === 'pc'
      ? positionOf(currentScene, targetEntity.id, partyComposedCharacters.indexOf(targetEntity))
      : targetEntity.position
  };
  if (spell) {
    pushEffects(effectsForSpellAttack({
      attacker: attackerForFx, target: targetForFx,
      spell: { ...spell, damageType: verdict.damage.damageType },
      hit: atk.hit
    }));
  } else {
    const isRanged = !!verdict.weaponIsRanged;
    const weaponForFx = { ...(weapon || {}), damageType: verdict.damage.damageType };
    if (atk.hit) {
      pushEffects(effectsForWeaponHit({
        attacker: attackerForFx, target: targetForFx,
        weapon: weaponForFx, isRanged, crit: !!atk.crit
      }));
    } else {
      pushEffects(effectsForWeaponMiss({
        attacker: attackerForFx, target: targetForFx,
        weapon: weaponForFx, isRanged
      }));
    }
  }
  // M27 — Surface class-feature effect cues (e.g. Sneak Attack shadow
  // strike) for any available feature when the hit lands.
  if (atk.hit && Array.isArray(verdict.features)) {
    for (const f of verdict.features) {
      if (!f.available) continue;
      pushEffects(effectsForFeatureTrigger({ feature: f, target: targetForFx }));
    }
  }

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
  // M27 — Save-spell visual: burst at target colored by damage type.
  const attackerForFx = {
    id: attackerHit.entity.id,
    _position: attackerHit.kind === 'pc'
      ? positionOf(currentScene, attackerHit.entity.id, partyComposedCharacters.indexOf(attackerHit.entity))
      : attackerHit.entity.position
  };
  const targetForFx = {
    id: targetHit.entity.id,
    _position: targetHit.kind === 'pc'
      ? positionOf(currentScene, targetHit.entity.id, partyComposedCharacters.indexOf(targetHit.entity))
      : targetHit.entity.position
  };
  pushEffects(effectsForSaveSpell({
    attacker: attackerForFx, target: targetForFx,
    spell, damaged: result.damage > 0
  }));
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
