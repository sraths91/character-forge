/**
 * M65 V22 — the forge's classic versus driver, behind `?classic=1` for one
 * release (docs/M65-CAMPAIGN-LOOP-PLAN.md V22, risk 5, decision 8).
 *
 * Everything here used to live in main.js: `startVersusFight` and all it
 * reaches — `runVersusPartyAuto`, `runEngineTurn`, `runManualWeaponAttack`,
 * `runManualCast`, the non-engine `runAttackPrompt` / `runSpellSavePrompt`
 * fallback, `endVersusFight` / `exitVersusFight`, the cinema stage, quick
 * stats, the replay panel, the versus drag adapters and the sandbox's
 * click-to-attack modes. The code is moved, not rewritten: main.js state it
 * reads arrives through `host` (`host.party`, `host.scene`,
 * `host.encounter`, `host.combatAdvantage`) and main.js helpers through the
 * thin shims below.
 *
 * main.js imports this module only with `?classic=1` (a dynamic import), so
 * without the flag neither this driver nor `scene/live-bridge.js` loads;
 * the versus panel offers "Play at the table" (client/forge-handoff.js,
 * V21) instead. Delete this file once the release with the flag ships.
 */

import { MONSTER_PRESETS, monsterSaveBonus } from '../../scene/monster-presets.js';
import { positionOf, setPosition, updateMonsterPosition } from '../../scene/scene-state.js';
import {
  combat, cancelAttack, selectAttacker,
  resolveAttack as resolveAttackAnimation, pushEffects
} from '../../scene/combat.js';
import {
  effectsForWeaponHit, effectsForWeaponMiss,
  effectsForSpellAttack, effectsForSaveSpell,
  effectsForFeatureTrigger
} from '../../scene/effects.js';
import { rollAttack, rollDamage, describeAttack } from '../../scene/combat-roll.js';
import { deriveAC, deriveAttack, spellAttackBonus, saveBonus } from '../../scene/pc-stats.js';
import { resolveAttack } from '../../scene/combat-resolver.js';
import { factionLists } from '../../scene/grid-rules.js';
import { resolveSpellSave } from '../../scene/save-rolls.js';
import { simulateEncounter } from '../../scene/simulator.js';
import {
  createRecorder as createFightRecorder, archiveReplay, listReplays,
  getReplayById, filterEvents, summarizeReplay
} from '../../scene/fight-recorder.js';
import { partyEndStateOf } from '../../scene/versus.js';
import { formatBreakdown } from '../../scene/ai/profile.js';
import { resetReactionsForAll, shouldCastShield, consumeShield } from '../../scene/reactions.js';
import { promptReaction } from '../../scene/reaction-prompt.js';
import { reactionCostLabel } from '../reaction-labels.js';
import { createCinema } from '../../anim/cinema.js';
import { styleForPc } from '../../anim/motion-styles.js';
import { SWING_TYPES, swingForPc, nextVariedSwing } from '../../anim/swing-types.js';
import { modifiersForAttack, snapshotAttackerFlags } from '../../anim/modifiers.js';
import { buildCinemaSequence, motionMetaForWeapon } from '../../anim/cinema-plan.js';
import {
  preloadActorSprite, makeLpcDrawSprite, clearActorSpriteCache,
  setActorWeapon, clearActorWeapon, drawWeaponOverlay, preloadActorAttack
} from '../../anim/cinema-sprites.js';
import { terrainFromScene, backgroundFor } from '../../anim/cinema-backgrounds.js';
// M45 Phase 4b.2 / M64 C1 — the live runner dispatches through the unified
// combat engine via the pure live-bridge (wrap → engine → write-back).
import {
  resolveEntityById as bridgeResolveEntityById,
  prepareLivePcForPlanning as bridgePrepareLivePcForPlanning,
  planForLivePc as bridgePlanForLivePc,
  resolvePlanTarget as bridgeResolvePlanTarget,
  runTurn as bridgeRunTurn,
  liveEncounterState, liveTurnState, syncLiveFromTurnState, refreshTurnStateFromLive
} from '../../scene/live-bridge.js';
import { buildWeaponPlan, buildCastPlan } from '../../scene/manual-plan.js';
import { createVersusEncounter } from '../../scene/encounter-setup.js';

/**
 * main.js's side of the driver: its live state and UI helpers.
 * @typedef {object} ClassicHost
 * @property {object[]} party — partyComposedCharacters (get/set)
 * @property {object} scene — currentScene (get/set)
 * @property {object[]} encounter — the queued monsters (versusEncounter)
 * @property {string} combatAdvantage — the advantage override radio
 * @property {Function} rerender @property {Function} setCombatStatus @property {Function} escapeHtml
 * @property {Function} reasonChip @property {Function} saveScene @property {Function} startContinuousRender
 * @property {Function} populateVersusSetup @property {Function} readVersusInputs
 * @property {Function} hideAttackPreview @property {Function} weaponClassOf
 */
/** @type {ClassicHost|null} */
let host = null;
const rerender = () => host.rerender();
const setCombatStatus = (text) => host.setCombatStatus(text);
const escapeHtml = (v) => host.escapeHtml(v);
const reasonChip = (r) => host.reasonChip(r);
const saveScene = (scene) => host.saveScene(scene);
const startContinuousRender = () => host.startContinuousRender();
const populateVersusSetup = () => host.populateVersusSetup();
const readVersusInputs = () => host.readVersusInputs();
const hideAttackPreview = () => host.hideAttackPreview();
const weaponClassOf = (weapon) => host.weaponClassOf(weapon);

/**
 * Bind the classic driver to main.js. Called once, after the dynamic import.
 * @param {ClassicHost} h
 * @returns {{
 *   start: () => Promise<void>, exit: () => void, leaveForNavigation: () => void,
 *   isActive: () => boolean, canPersistScene: () => boolean,
 *   previousScene: () => object|null, previousParty: () => object[]|null,
 *   setCinemaBackground: (slug: string) => void,
 *   stateForDrag: () => {state: object, sheets: object}, applyIntent: (kind: string, id: string, intent: object) => void,
 *   onCombatPick: (hit: object|null, e: Event) => void, updateAttackPreview: (hit: object|null, x: number, y: number) => void
 * }}
 */
export function installClassicVersus(h) {
  host = h;
  globalThis.console?.info?.(JSON.stringify({ event: 'forge.classic_versus_loaded' }));
  return {
    start: () => startVersusFight(),
    exit: () => exitVersusFight(),
    leaveForNavigation: () => leaveVersusForNavigation(),
    isActive: () => versusActive,
    // M64 C10 / F2 — the versus arena is ephemeral: nothing persists while it is the scene.
    canPersistScene: () => !versusActive && versusPreviousScene === null,
    previousScene: () => versusPreviousScene,
    previousParty: () => versusPreviousParty,
    setCinemaBackground: (slug) => { if (versusCinema?.setBackground) versusCinema.setBackground(backgroundFor(slug)); },
    stateForDrag: () => versusStateForDrag(),
    applyIntent: (kind, id, intent) => applyVersusIntent(kind, id, intent),
    onCombatPick: (hit, e) => onCombatPick(hit, e),
    updateAttackPreview: (hit, x, y) => updateAttackPreview(hit, x, y)
  };
}

// M28 — Versus mode state. Active fight tracking + setup wiring.
let versusActive = false;
let versusAutoMode = false;   // M38: bypass reaction prompts when auto-fighting
let versusCinema = null;      // M43.2: cinema controller while a cinematic fight is active
let versusCinemaActive = false;

async function startVersusFight() {
  const { pcIds, mode, logMode } = readVersusInputs();
  const status = document.getElementById('versus-status');
  if (pcIds.length === 0) { if (status) status.textContent = 'Pick at least one party member.'; return; }
  if (host.encounter.length === 0) { if (status) status.textContent = 'Add at least one opponent.'; return; }

  // Optionally clear the roll log
  if (logMode === 'reset') {
    const list = document.getElementById('roll-log-list');
    if (list) list.innerHTML = '';
    const wrap = document.getElementById('roll-log');
    if (wrap) wrap.hidden = true;
  }

  versusPreviousScene = host.scene;
  versusPreviousParty = host.party;

  // M64 C4 — monster instances, arena, PC/monster resource seeding and
  // initiative are built by scene/encounter-setup.js (pure; injected
  // rng + id minting so the server can reproduce an encounter).
  const encounterSetup = createVersusEncounter({
    party: host.party, pcIds, encounter: host.encounter,
    flanking: !!host.scene?.flankingEnabled,
    rng: Math.random,
    mintId: (i) => `versus_${Date.now()}_${i}`
  });
  const monsterInstances = encounterSetup.monsters;
  host.scene = encounterSetup.scene;
  versusActive = true;
  // Party filtered to just the selected members so the canvas only
  // renders them.
  host.party = encounterSetup.party;
  versusInitiative = encounterSetup.initiative;

  document.getElementById('versus-start')?.setAttribute('hidden', '');
  document.getElementById('versus-rematch')?.removeAttribute('hidden');
  document.getElementById('versus-exit')?.removeAttribute('hidden');
  if (status) {
    const partySize = host.party.length;
    status.textContent = `Fight! ${partySize} PC${partySize === 1 ? '' : 's'} vs ${monsterInstances.length} opponent${monsterInstances.length === 1 ? '' : 's'}. Mode: ${mode}.`;
  }
  rerender();

  versusAutoMode = (mode === 'auto' || mode === 'quick');   // M38

  // M43.2 — Cinematic 1v1 view. When the user picks "Cinematic" view
  // AND auto-fight mode, mount the cinema canvas and route per-attack
  // animations through it. Other modes use the existing grid view.
  const view = [...document.querySelectorAll('[name="versus-view"]:checked')]
    .map(r => r.value)[0] || 'grid';
  versusCinemaActive = (view === 'cinema' && mode === 'auto');
  setupVersusCinema(versusCinemaActive);

  if (mode === 'quick') {
    runVersusQuickStats();
  } else if (mode === 'auto') {
    runVersusPartyAuto();
  }
}

/** M43.2 — Mount or tear down the cinema canvas + controller.
 *  M44 — Wires the LPC sprite renderer so the cinema shows real
 *  character art instead of placeholder silhouettes. */
function setupVersusCinema(active) {
  const canvas = document.getElementById('cinema-canvas');
  if (!canvas) return;
  if (active) {
    canvas.hidden = false;
    // M44.2 — Pick the cinematic background that matches the active
    // scene's terrain (forest, dungeon, cave, etc.). Re-bound when
    // the player swaps the scene preset; see syncCinemaBackground().
    const terrain = terrainFromScene(host.scene);
    versusCinema = createCinema({
      canvas,
      drawSprite: makeLpcDrawSprite(),
      // M51 — the attacker's weapon swings as a separate overlay.
      drawWeapon: drawWeaponOverlay,
      drawBackground: backgroundFor(terrain),
      // Pre-render each new actor's LPC sprite into an off-screen
      // buffer before the next round starts. Synchronous draw() then
      // paints from the cache without re-running the compositor.
      // M44.5 — Attacker pre-renders east-facing; defender west-facing.
      // The LPC sheet handles facing directly so the cinema draws no
      // longer x-mirror the defender.
      // M51 — also load the attacker's weapon sprite for the swing overlay.
      // M51 Phase 2 — both actors face the camera (south) so the real
      // LPC attack frames + the south weapon slash align.
      // M54 — the weapon is (re)loaded per round in playCinemaRoundForAttack
      // with the resolved swing, so it's not loaded here.
      onActorsChanged: async ({ attacker, defender }) => {
        await Promise.all([
          preloadActorSprite(attacker, { direction: 'south' }),
          preloadActorSprite(defender, { direction: 'south' })
        ]);
      }
    });
  } else {
    canvas.hidden = true;
    versusCinema = null;
    clearActorSpriteCache();
    clearActorWeapon();
  }
}


/** M54 — Resolve a PC's swing for one attack. 'varied' advances a per-
 *  entity counter so the cut alternates; everything else returns as-is.
 *  Shared by the cinema (auto) and manual click-to-attack paths. */
function resolveSwingForPc(entity, weaponClass) {
  const sel = swingForPc(entity);
  if (sel !== 'varied') return sel;
  const n = (entity._swingN = (entity._swingN || 0) + 1) - 1;
  return nextVariedSwing(weaponClass, n);
}

/** M43.2 — Play one cinema round for a versus attack.
 *  M64 C8 — the Sequence is built by the same pure builder the online
 *  table uses (anim/cinema-plan.js `buildCinemaSequence`): this function
 *  only gathers the forge's per-attack inputs (mainhand weapon, the PC's
 *  style, the 'varied' swing counter, flag-diffed modifiers) into an
 *  exchange payload, then drives the cinema. Awaits completion so the
 *  auto-loop pacing reads as a series of dramatized exchanges. */
async function playCinemaRoundForAttack(attackerHit, targetHit, dmg, opts = {}) {
  if (!versusCinema) return;
  const isCast = !!opts.cast;
  const isPc = attackerHit.kind === 'pc';
  const attacker = attackerHit.entity;
  const target = targetHit.entity;
  const weapon = isPc
    ? (attacker.equipment?.mainhand || null)
    : { name: MONSTER_PRESETS[attacker.presetSlug]?.attack?.name };
  // M54 — 'varied' advances the per-entity counter, so resolve the swing
  // only when this weapon actually swings (melee, not casts/reactions).
  let swing = null;
  if (isPc && !isCast && !opts.reaction) {
    const meta = motionMetaForWeapon(weapon);
    if (meta.kind === 'melee') swing = resolveSwingForPc(attacker, meta.weaponClass || 'sword');
  }
  const attackerLevel = isPc
    ? ((attacker.classes || []).reduce((s, c) => s + (c?.level || 0), 0) || 1)
    : 1;
  // M43.4 — modifiers that fired on this exchange, by flag diffing (the
  // server sends them in the event instead).
  let modifiers = [];
  let smiteSlot = null;
  if (isPc && !isCast && !opts.reaction) {
    const post = snapshotAttackerFlags(attacker);
    modifiers = modifiersForAttack({ pre: opts.preAttackFlags || {}, post, attacker });
    smiteSlot = opts.smiteSlot || post._smiteSlotUsed || 1;
  }
  const defenderId = String(target.id ?? 'defender');
  const defenderMax = target.hp?.max ?? target.hpMax ?? (target.hp?.current ?? 0) + (dmg || 0);
  const miss = opts.miss != null ? !!opts.miss : !dmg;
  const plan = buildCinemaSequence({
    exchangeId: null,
    attackerId: String(attacker.id ?? 'attacker'),
    defenderId,
    reaction: !!opts.reaction,
    cast: isCast,
    roll: isCast ? null : { hit: !miss, crit: !!opts.crit },
    damage: { total: dmg | 0 },
    effects: [{ entityId: defenderId, hp: { before: 0, after: 0, max: defenderMax } }],
    cinema: {
      weapon: isCast ? null : weapon,
      style: isPc ? styleForPc(attacker) : null,
      swing,
      modifiers,
      smiteSlot,
      attackerLevel,
      killing: !!opts.killing,
      spell: isCast ? (opts.spell || {}) : null,
      outcome: isCast ? (opts.outcome || {}) : null,
      fxSeed: 0,
      durationMs: 0
    }
  });
  if (!plan.seq) return;
  // Update actor sprites to match the current attacker / defender
  await versusCinema.setActors?.({ attacker, defender: target });
  // M51 Phase 2 / M54 Phase 2 — preload the REAL LPC body attack frames
  // (the plan maps swing → body, else motion → body) and the defender's
  // hurt frames; awaited so they are ready before playRound starts.
  await Promise.all([
    preloadActorAttack(attacker, { animation: plan.bodyAnim }),
    preloadActorAttack(target, { animation: 'hurt' }),
    // M59 — load the weapon's real attack sheet matching the body
    // animation (slash/thrust) when one exists; else the walk fallback.
    setActorWeapon(attacker, { swing: plan.swing, animation: plan.bodyAnim })
  ]);
  // M64 C10 / F1 — the stage may have been torn down (fight exited)
  // while the sprites were loading.
  if (!versusCinema) return;
  versusCinema.resetHp({
    attHp: attacker.hp?.current ?? attacker.hp ?? 1,
    defHp: target.hp?.current   ?? target.hp   ?? 1
  });
  await versusCinema.playRound(plan.seq, plan.verdict);
}

let versusInitiative = [];

let versusPreviousScene = null;
let versusPreviousParty = null;

/** M64 C10 / F1 — top-nav navigation out of versus. A started fight
 *  (running or finished but not yet exited) goes through the same
 *  restore path as the Exit button; otherwise just clear the flag. */
function leaveVersusForNavigation() {
  if (versusActive || versusPreviousScene) exitVersusFight();
  else versusActive = false;
}

function exitVersusFight() {
  // M64 C10 / F1 — a fight left mid-way (exit button or top nav) is
  // finalised and archived like a finished one, and the cinema stage
  // is torn down, before the pre-fight scene and party are restored.
  // A fight that already ended has no recorder and no cinema here.
  if (currentFightRecorder) {
    currentFightRecorder.finalize('abandoned');
    archiveReplay(currentFightRecorder.getReplay());
    currentFightRecorder = null;
    renderReplayPanel();
  }
  if (versusCinemaActive) {
    setupVersusCinema(false);
    versusCinemaActive = false;
  }
  if (versusPreviousScene) host.scene = versusPreviousScene;
  if (versusPreviousParty) host.party = versusPreviousParty;
  versusActive = false;
  versusPreviousScene = null;
  versusPreviousParty = null;
  populateVersusSetup();
  rerender();
}

// M29 — Quick stats for the full N-vs-M encounter via the M20 simulator.
async function runVersusQuickStats() {
  const pcsWithPositions = host.party.map((pc, i) => ({
    ...pc, _position: positionOf(host.scene, pc.id, i)
  }));
  const monsters = host.scene.monsters || [];
  const stats = await simulateEncounter({
    party: pcsWithPositions,
    monsters,
    scene: host.scene,
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

// M29 — Auto-fight in initiative order. Each tick: pick the next alive
// entity in the rolled initiative list, pick the lowest-HP enemy as
// target, run runAttackPrompt. Cap at 30 rounds for safety.
async function runVersusPartyAuto() {
  const status = document.getElementById('versus-status');
  const order = versusInitiative.slice();   // captured at fight start
  const stepDelay = 950;                    // ms between turns
  // M64 T7 — the round loop is the engine turn manager, the same one the
  // simulator and the server run: per-creature start-of-turn resets
  // (reaction, Reckless, legendary budget), downed/incapacitated skips,
  // legendary actions after every opposing turn, the victory check and
  // the 30-round cap. Each actor's turn still goes through runEngineTurn
  // (cinema, cast log, Shield dialog). Loaded lazily so this function is
  // the only main.js edit.
  const { startEncounter, runTurn } = await import('../../scene/turn-manager.js');

  // M36 — Spin up a recorder for this fight so the user can replay it.
  currentFightRecorder = createFightRecorder({
    participants: [
      ...host.party.map(p => ({ id: p.id, name: p.name, kind: 'pc', hp: p.hp })),
      ...(host.scene.monsters || []).map(m => ({ id: m.id, name: m.name, kind: 'monster', hp: m.hp }))
    ]
  });
  currentFightRecorder.start();

  const live = () => ({ party: host.party, scene: host.scene });
  // A fresh fight: nobody starts with a spent reaction. From here on the
  // turn manager refreshes each creature's reaction at its own turn.
  resetReactionsForAll(host.party);
  resetReactionsForAll(host.scene.monsters || []);
  const ts = liveTurnState({
    ...live(),
    initiative: order.map(e => ({ entityId: e.entityId, score: e.score ?? 0 }))
  });
  startEncounter(ts, { initiative: 'given', maxRounds: 30 });

  let shownRound = 0;
  while (ts.phase === 'running') {
    if (!versusActive) return;
    const round = ts.round;
    if (round !== shownRound) { shownRound = round; currentFightRecorder.setRound(round); }
    let ranTurn = false;
    const res = await runTurn(ts, {
      rng: Math.random,
      isPaused: () => !versusActive,
      runActorTurn: async (actor) => {
        const kind = actor.kind;
        const entity = resolveEntityById(actor.id, kind);
        if (!entity || versusHpOf(entity, kind) <= 0) return;
        // Start-of-turn resets made by the turn manager reach the live records.
        syncLiveFromTurnState(ts, live());

        // M45 Phase 4b.2 — Dispatch through the unified combat engine.
        // We snapshot the opposing side's HP before the turn so we can
        // detect kills + damage deltas for logging + replay.
        const opposing = kind === 'pc' ? (host.scene.monsters || []) : host.party;
        const hpBefore = new Map(opposing.map(o => [o.id, o.hp?.current ?? 0]));

        const wrapper = await runEngineTurn(entity, kind);
        refreshTurnStateFromLive(ts, live());
        ranTurn = true;
        if (!versusActive || !wrapper) return;
        const plan = wrapper._lastPlan;
        if (plan) logVersusAiPlan(entity, plan);

        if (plan?.kind === 'flee') {
          currentFightRecorder.record({
            type: 'note',
            actorId: entity.id, actorName: entity.name || 'Monster',
            summary: `${entity.name} flees (${plan.archetype})`,
            detail: { plan }
          });
        } else if (plan) {
          // Damage / death recording from the HP delta.
          for (const o of opposing) {
            const before = hpBefore.get(o.id) ?? 0;
            const after = o.hp?.current ?? 0;
            if (before > after) {
              currentFightRecorder.record({
                type: 'attack',
                actorId: entity.id, actorName: entity.name || '?',
                targetId: o.id, targetName: o.name || '?',
                summary: `${entity.name} hits ${o.name} for ${before - after} dmg`,
                detail: { dmg: before - after, plan }
              });
              if (after <= 0) {
                currentFightRecorder.record({
                  type: 'death',
                  actorId: o.id, actorName: o.name || '?',
                  summary: `${o.name} falls`, detail: {}
                });
              }
            }
          }
        }
        // M45 Phase 2 — Clear the AI-chosen weapon so the next turn
        // re-evaluates from scratch.
        if (kind === 'pc') entity._chosenWeapon = null;
      }
    });
    // Legendary actions and resets made after the actor's turn.
    syncLiveFromTurnState(ts, live());
    if (!versusActive || res.paused) return;

    if (ranTurn) {
      await new Promise(f => setTimeout(f, stepDelay));
      // M64 C10 / F1 — the fight may have been exited during the pause;
      // don't judge the restored (non-arena) scene.
      if (!versusActive) return;
    }
    const verdict = currentPartyEndState();
    if (verdict) return endVersusFight(verdict, round);
    if (res.roundEnded && status) {
      const pcHp = host.party.map(p => p.hp?.current ?? 0).reduce((a, b) => a + b, 0);
      const monHp = (host.scene.monsters || []).map(m => m.hp?.current ?? 0).reduce((a, b) => a + b, 0);
      status.textContent = `Round ${round}: party HP ${pcHp}, enemy HP ${monHp}.`;
    }
  }
  // Ended by the turn manager (a wipe the HP verdict also sees, or the
  // round cap): report it like the old loop did.
  endVersusFight(currentPartyEndState() || 'draw', ts.round);
}

// M64 C1 — the live-runner ↔ engine bridge lives in
// scene/live-bridge.js (pure, Node-safe). These thin wrappers bind it
// to main.js's module state so existing call sites don't change.
function bridgeCtx() {
  return { party: host.party, scene: host.scene };
}

function resolveEntityById(id, kind) {
  return bridgeResolveEntityById(id, kind, bridgeCtx());
}

/** M45 Phase 2 — lazy-init planner fields on a live PC (see live-bridge). */
function prepareLivePcForPlanning(pc, index) {
  return bridgePrepareLivePcForPlanning(pc, index, host.scene);
}

/** M45 Phase 2 — PC AI plan for a live PC turn (see live-bridge). */
function planForLivePc(pc) {
  return bridgePlanForLivePc(pc, { ...bridgeCtx(), rng: Math.random });
}

/**
 * M45 Phase 2 — Format a PC AI plan as a short manual-play hint.
 * Returns a string like "💡 AI: longbow → Goblin Boss" or empty when
 * the plan can't be summarized (no weapon + no spell + no target).
 * Kept short so it fits the existing one-line combat-status panel.
 */
function formatPcRecommendationHint(plan) {
  if (!plan || plan.kind === 'dodge' || plan.kind === 'dash') return '';
  // Resolve the target name without throwing
  let targetName = '';
  if (plan.targetId) {
    const t = resolvePlanTarget(plan);
    targetName = t?.entity?.name || '';
  }
  if (plan.kind === 'cast') {
    return `💡 AI: cast ${plan.spellId || 'spell'}${targetName ? ' → ' + targetName : ''}`;
  }
  const weaponLabel = plan.weapon?.name || plan.kind;
  return `💡 AI: ${weaponLabel}${targetName ? ' → ' + targetName : ''}`;
}

/**
 * M45 Phase 2 — Resolve the actual target entity from a PC AI plan.
 *
 * The plan carries `targetId` + `targetSide`. Look up the live entity
 * record on the right side (enemy = monster; ally = pc) and wrap it
 * in the {kind, entity} shape `attackInVersus` expects.
 */
function resolvePlanTarget(plan) {
  return bridgeResolvePlanTarget(plan, bridgeCtx());
}

/* M45 Phase 4b.2 — the wrap / write-back bridge (wrapPcForEngine,
 * wrapMonsterForEngine, writeBackPc, writeBackMonster, buildEngineSides,
 * runTurn) moved to scene/live-bridge.js in M64 C1. runEngineTurn below
 * keeps only the UI prompt wiring (cinema, cast log, Shield dialog). */

/**
 * M45 Phase 4b.2 — Run one entity's turn through the unified combat
 * engine, bridging engine events back to the live UI via prompts.
 *
 * Returns the wrapper of the active entity (post-turn) so the caller
 * can introspect _lastPlan, damageDealt, etc. for logging + replay.
 */
async function runEngineTurn(entity, entityKind, opts = {}) {
  if (!entity) return null;
  const preAttackFlags = snapshotAttackerFlags(entity);
  // M45 Phase 4b.3 — In manual mode the player drives target/weapon
  // selection and Shield reactions; auto-fight passes the engine's
  // heuristic through unchanged.
  const interactive = !!opts.interactive;

  const prompts = {
    // M45 Phase 4b.3 — Force plan: manual-click attacks come in with a
    // pre-built plan (target, weapon) so the engine skips AI planning
    // and resolves the player's choice directly.
    forcePlan: opts.forcePlan || null,
    // Cinema-round dispatch — fires after every weapon swing AND
    // (M56 Phase 2) every resolved cast. Bridges to the existing
    // playCinemaRoundForAttack helper.
    onCinemaRound: async ({ attacker, defender, atk, dmg, crit, miss, spell, cast, outcome, reaction }) => {
      if (!(versusCinemaActive && versusCinema)) return;
      if (!attacker?.ref || !defender?.ref) return;
      const attackerLive = attacker.ref;
      const defenderLive = defender.ref;
      const beforeTargetHp = defender.hpMax;   // pre-attack baseline
      if (cast) {
        // Resolved cast: the positional dmg is the framed target's
        // damage (0 for heals and condition-only saves) and miss is
        // explicit — a landed Hold Person or a Cure Wounds must never
        // read as a whiff via the !dmg inference. The heal amount
        // rides outcome → verdict.heal.
        await playCinemaRoundForAttack(
          { kind: attacker.kind, entity: attackerLive },
          { kind: defender.kind, entity: defenderLive },
          outcome?.dmg | 0,
          {
            cast: true, spell, outcome,
            crit: !!outcome?.crit,
            miss: !!outcome?.miss,
            killing: defender.hp <= 0 && beforeTargetHp > 0
          }
        );
        void atk;
        return;
      }
      await playCinemaRoundForAttack(
        { kind: attacker.kind, entity: attackerLive },
        { kind: defender.kind, entity: defenderLive },
        dmg | 0,
        {
          preAttackFlags,
          smiteSlot: attacker._smiteSlotUsed || null,
          killing: defender.hp <= 0 && beforeTargetHp > 0,
          crit: !!crit, miss: !!miss,
          // M56 Phase 4 — OAs play Quick with no swing pick and no
          // modifier diffing (preAttackFlags above belong to the
          // ACTIVE entity, not the OA attacker).
          reaction: !!reaction
        }
      );
      void atk;
    },
    onCastBegin: async ({ attacker, target, spell, plan }) => {
      appendCastLog({
        casterName: attacker.ref.name || attacker.name,
        spellName: spell.name,
        targetName: target?.ref?.name || target?.name,
        isInnate: !!plan.isInnate,
        level: spell.level,
        castAtLevel: plan.castAtLevel || spell.level
      });
    },
    // Shield reaction: interactive mode pops the existing promptReaction
    // dialog; auto mode passes the engine's heuristic through.
    onShieldReaction: async ({ autoAnswer, defender, atk }) => {
      if (!interactive || defender.kind !== 'pc') return autoAnswer;
      const ac = defender.ac;
      const accepted = await promptReaction({
        title: `Cast Shield? (${defender.name})`,
        body: `${atk.total || '?'} vs your AC ${ac} — +5 AC would dodge it.`,
        // T5 retired _lvl1Slots; the label reads the one slot ledger.
        costLabel: reactionCostLabel(defender, 1),
        defaultMs: 5000,
        auto: false
      });
      return !!accepted;
    },
    onCounterspell:   async ({ autoAnswer }) => autoAnswer,
    onReactionAttack: async () => true   // OAs fire by default
  };

  return bridgeRunTurn({
    party: host.party, scene: host.scene,
    entity, kind: entityKind, rng: Math.random, prompts
  });
}

/**
 * M45 Phase 4b.3 — Manual-click weapon attack via the unified engine.
 *
 * Builds a synthetic plan from the player's pick (attacker + target +
 * the attacker's current weapon), dispatches through runEngineTurn
 * with `interactive: true` so Shield reactions pop the real dialog,
 * then writes back state.
 *
 * Returns { hit, crit, dmg } to keep parity with the legacy
 * runAttackPrompt return shape — manual call sites that read these
 * fields keep working unchanged.
 */
async function runManualWeaponAttack(attackerHit, targetHit, weaponOverride = null) {
  if (!attackerHit?.entity || !targetHit?.entity) return null;
  // M51.1 — the player can arm a specific weapon by clicking its row in
  // the Actions panel (beginWeaponAttack sets combat.weapon). When set,
  // it overrides the mainhand default so e.g. a Cleric can swing the
  // warhammer instead of the equipped shortsword.
  const weapon = weaponOverride || getAttackerWeapon(attackerHit);
  // M64 C3 — plan construction (incl. the ranged heuristic) lives in
  // scene/manual-plan.js so the server can build the same forcePlan.
  const plan = buildWeaponPlan({ weapon, targetId: targetHit.entity.id });
  const isRanged = plan.kind === 'ranged';
  // Snapshot defender HP before so we can compute dmg for the return
  // value. The engine's onCinemaRound prompt already fires; this is
  // just for the call-site's bookkeeping.
  const beforeHp = targetHit.entity.hp?.current ?? 0;
  const wrapper = await runEngineTurn(attackerHit.entity, attackerHit.kind, {
    forcePlan: plan, interactive: true
  });
  const afterHp = targetHit.entity.hp?.current ?? 0;
  const dmg = Math.max(0, beforeHp - afterHp);
  const hit = dmg > 0;
  // M54b — Manual click-to-attack now shows the swing on the GRID too.
  // The engine path renders no attack FX, so (in grid view) push the same
  // lunge + slash + recoil the legacy path does — oriented by the PC's
  // chosen swing — and surface a flavour line ("Knight cleaves down on…").
  if (!versusCinemaActive) {
    let swing = null;
    if (attackerHit.kind === 'pc' && !isRanged) {
      swing = resolveSwingForPc(attackerHit.entity, weaponClassOf(weapon));
    }
    if (hit) {
      pushEffects(effectsForWeaponHit({
        attacker: attackerHit.entity, target: targetHit.entity,
        weapon, isRanged, crit: false, swing
      }));
      resolveAttackAnimation(targetHit.entity.id, targetHit.kind, dmg);
    } else {
      pushEffects(effectsForWeaponMiss({
        attacker: attackerHit.entity, target: targetHit.entity, weapon, isRanged
      }));
    }
    if (swing) {
      const verb = SWING_TYPES[swing]?.verb || 'strikes';
      const word = hit ? verb : `${verb.replace(/es$|s$/, '')} at`;
      setCombatStatus(`${attackerHit.entity.name || 'Attacker'} ${word} ${targetHit.entity.name || 'the target'}${hit ? ` for ${dmg}` : ' — miss'}.`);
    }
    startContinuousRender();
  }
  return {
    hit,
    crit: false,    // engine doesn't surface crit through this path yet
    dmg,
    total: null,
    plan: wrapper?._lastPlan || null
  };
}

/**
 * M45 Phase 4b.4 — Manual-click spell cast via the unified engine.
 *
 * Resolves the queued spell from `combat.spell` to a registry entry
 * (by id or by name-to-slug), builds a synthetic cast plan
 * (kind:'cast', spellId, castAtLevel, targetSide), and dispatches
 * through runEngineTurn. Falls back to the legacy runAttackPrompt
 * path when the spell doesn't translate (e.g. homebrew spells with
 * no registry entry).
 *
 * Returns true if the engine path handled the cast; false if the
 * caller should fall back to runAttackPrompt.
 */
async function runManualCast(attackerHit, targetHit, spell) {
  if (!attackerHit?.entity || !targetHit?.entity || !spell) return false;
  // M64 C3 — resolve the spell to a registry entry (by id or name slug)
  // and build the cast plan in scene/manual-plan.js; null = no entry.
  const plan = buildCastPlan({ spell, targetId: targetHit.entity.id });
  if (!plan) return false;
  await runEngineTurn(attackerHit.entity, attackerHit.kind, {
    forcePlan: plan, interactive: true
  });
  return true;
}

function versusHpOf(entity, kind) {
  if (kind === 'pc') return entity.hp?.current ?? 0;
  return entity.hp?.current ?? 0;
}

// M32 — Monster AI: ask the profile which PC to engage (or whether to
// flee). `monster` is a live scene-instance with .position + .hp.{current,max}.
// Returns { kind, target: {kind:'pc', entity}, plan } or null.


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


function currentPartyEndState() {
  return partyEndStateOf({
    partyHps: host.party.map(p => p.hp?.current ?? 0),
    monsterHps: (host.scene.monsters || []).map(m => m.hp?.current ?? 0)
  });
}

// Helper: invokes the same combat flow used by manual play, but FIRST
// runs a movement step so the attacker closes the distance when out
// of reach. The movement is persisted on the scene (PC positions in
// scene.positions, monster.position on the instance) so subsequent
// rounds see the new placement, the M27 lunge effect fires from the
// new cell, and the M11 resolver computes reach from the post-move
// position.

// M38 — Wrapper around runVersusOpportunityAttack that prompts the
// player when a PC would burn their reaction. Returns true if the OA
// fired, false if the player declined or auto-mode skipped it.


// M33.0 — list the live opposing-side entities relative to `attackerHit`,
// each wrapped in a shape detectOpportunityAttacks can consume. The
// wrapper keeps a reference back to the live entity so we can call
// consumeReaction() and resolve the OA against the actual record.

// M33.0 — Execute one opportunity attack from `triggerer` against
// `moverHit`. The mover is interrupted at `moverBeforePos`, so we
// resolve reach distance from that cell. Damage applied + logged.

// =====================================================================
// M39 — Live monster spellcasting in versus. Mirrors the simulator's
// runMonsterSpell, but operates on live PC characters + scene monster
// instances (hp shape: { current, max }). Counterspell witnesses get
// an interactive prompt; auto-fight skips it via versusAutoMode.
// =====================================================================








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


function endVersusFight(outcome, rounds) {
  const status = document.getElementById('versus-status');
  // M36 — finalize + archive the recording, then surface the replay UI.
  if (currentFightRecorder) {
    currentFightRecorder.finalize(outcome);
    archiveReplay(currentFightRecorder.getReplay());
    currentFightRecorder = null;
    renderReplayPanel();
  }
  // M43.2 — tear down the cinema stage if it was active.
  if (versusCinemaActive) {
    setupVersusCinema(false);
    versusCinemaActive = false;
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

function versusStateForDrag() {
  const { state, sheets } = liveEncounterState({ party: host.party, scene: host.scene, includeDown: true });
  state.grid.terrain = host.scene.terrain && typeof host.scene.terrain.flags === 'string' ? host.scene.terrain : null;
  return { state, sheets };
}

/**
 * The forge's local intent sink (the online table sends the same intent
 * to the server instead). Applies a validated move intent to the scene.
 * @param {'pc'|'monster'} kind
 * @param {string} id
 * @param {{t: string, p: {plan: {kind: string, moveTo: {col: number, row: number}}}}} intent
 */
function applyVersusIntent(kind, id, intent) {
  const to = intent?.p?.plan?.moveTo;
  if (intent?.t !== 'turn.act' || intent.p.plan.kind !== 'move' || !to) return;
  if (kind === 'pc') setPosition(host.scene, id, to.col, to.row);
  else updateMonsterPosition(host.scene, id, to.col, to.row);
  saveScene(host.scene);
}

/** M4 / M45 — the click-to-attack modes (main.js pointerdown routes here). */
function onCombatPick(hit, e) {
  // M4 — combat mode short-circuits the drag handler. Clicking an entity
  // either picks the attacker or fires the attack on the target.
  if (combat.mode === 'pick-attacker') {
    if (!hit) { setCombatStatus('Click an entity to attack with — or press Esc to cancel.'); return; }
    selectAttacker(hit.entity.id, hit.kind);
    // M45 Phase 2 — When the picked attacker is a PC, run the AI planner
    // for a non-blocking recommendation. The player still clicks
    // whatever target they want; the hint just shows what choosePcAction
    // would pick. Skipped for monsters (their own profile drives them
    // and manual-click against monsters is rare).
    let hint = '';
    if (hit.kind === 'pc') {
      try {
        const pcIndex = host.party.indexOf(hit.entity);
        prepareLivePcForPlanning(hit.entity, pcIndex);
        const recPlan = planForLivePc(hit.entity);
        hint = formatPcRecommendationHint(recPlan);
      } catch { /* hint is purely advisory; never block the click */ }
    }
    setCombatStatus(`Attacker: ${entityName(hit)}. Click a target.${hint ? ' ' + hint : ''}`);
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
    // M45 Phase 4b.3 — Manual weapon attacks dispatch through the
    // engine. M45 Phase 4b.4 — Manual spell casts try the engine
    // first; spells without a registry entry fall back to the legacy
    // runAttackPrompt path (which handles the spell-attack-vs-save
    // dispatch directly).
    const attackerLive = resolveEntityById(combat.attacker.id, combat.attacker.kind);
    if (!attackerLive) { runAttackPrompt(hit.kind, hit.entity); return; }
    const attackerHit = { kind: combat.attacker.kind, entity: attackerLive };
    const targetHit   = { kind: hit.kind, entity: hit.entity };
    const queuedSpell = combat.spell;
    if (queuedSpell) {
      // Reset combat.spell BEFORE engine dispatch so the engine's
      // cinema/log handlers don't double-fire spell-mode logic.
      combat.spell = null;
      runManualCast(attackerHit, targetHit, queuedSpell).then(handled => {
        if (handled) {
          cancelAttack();
          rerender();
        } else {
          // Engine couldn't route — restore the spell + fall back.
          combat.spell = queuedSpell;
          runAttackPrompt(hit.kind, hit.entity);
        }
      });
    } else {
      // M51.1 — honor a player-armed weapon (combat.weapon), else mainhand.
      const chosenWeapon = combat.weapon || null;
      combat.weapon = null;
      runManualWeaponAttack(attackerHit, targetHit, chosenWeapon).then(() => {
        cancelAttack();
        rerender();
      });
    }
    return;
  }
}

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
    party: host.party.map(pc => ({ ...pc, _position: positionOf(host.scene, pc.id, host.party.indexOf(pc)) })),
    monsters: (host.scene.monsters || [])
  });
  const verdict = resolveAttack({
    attacker: attackerHit.entity,
    target: hit.entity,
    weapon,
    scene: host.scene,
    attackerKind: attackerHit.kind,
    targetKind: hit.kind,
    targetAC: ac,
    advantageOverride: host.combatAdvantage,
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
    // M45 Phase 3 — Await the save-spell resolution so the auto-fight
    // loop can sequence its post-attack verdict + cinema-round on the
    // same timeline as weapon attacks.
    await runSpellSavePrompt(attackerHit, { kind: targetKind, entity: targetEntity }, spell);
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
    party: host.party.map(pc => ({ ...pc, _position: positionOf(host.scene, pc.id, host.party.indexOf(pc)) })),
    monsters: (host.scene.monsters || [])
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
    scene: host.scene,
    attackerKind: attackerHit.kind,
    targetKind,
    targetAC: ac,
    advantageOverride: host.combatAdvantage,
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
    atk = rollAttack({ bonus: finalBonus, advantage: verdict.d20.mode, targetAC: ac }, Math.random);
  }

  // M38 — Shield reaction prompt. Fires when a monster's attack would
  // land on a PC by 1..5 over their AC. We pause the flow to ask;
  // auto-fight bypasses the prompt by passing auto:true.
  let shielded = false;
  if (atk.hit && !atk.crit && attackerHit.kind === 'monster' && targetKind === 'pc' &&
      shouldCastShield({ target: targetEntity, attackerTotal: atk.total, targetAc: ac })) {
    const accepted = await promptReaction({
      title: `Cast Shield? (${targetEntity.name})`,
      body: `${attackerName}'s ${atk.total} vs your AC ${ac} — +5 AC would dodge it.`,
      costLabel: reactionCostLabel(targetEntity, 1),
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
    dmgRoll = rollDamage(finalDmgDice, { crit: atk.crit }, Math.random);
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
      ? positionOf(host.scene, attackerHit.entity.id, host.party.indexOf(attackerHit.entity))
      : attackerHit.entity.position
  };
  const targetForFx = {
    id: targetEntity.id,
    _position: targetKind === 'pc'
      ? positionOf(host.scene, targetEntity.id, host.party.indexOf(targetEntity))
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
  saveScene(host.scene);
  appendAttackLog({ attackerName, targetName, weaponName: label, verdict, atk, dmgRoll });
  setCombatStatus(formatAttackSummary({ attackerName, targetName, weaponName: label, verdict, atk, dmgRoll }));
  startContinuousRender();
  // M43.6 — Surface the attack result so callers (auto-fight loop +
  // cinema integration) can read `crit` for the polish layer. Manual-
  // click callers ignore the return value.
  return { hit: !!atk?.hit, crit: !!atk?.crit, dmg: damage, total: atk?.total ?? null };
}

// M21 — Spell-save resolution flow. Caster attacker, target's save bonus
// derived per-kind, save roll vs caster's DC, damage applied per the
// spell's saveOnHalf policy. Mirrors the M11 flow shape so the existing
// animation + log infrastructure works unchanged.
async function runSpellSavePrompt(attackerHit, targetHit, spell) {
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
  }, Math.random);

  // Apply damage if the spell deals damage on this outcome.
  if (result.damage > 0) {
    applyDamage(targetHit.kind, targetHit.entity.id, result.damage);
    resolveAttackAnimation(targetHit.entity.id, targetHit.kind, result.damage);
  }
  // M27 — Save-spell visual: burst at target colored by damage type.
  const attackerForFx = {
    id: attackerHit.entity.id,
    _position: attackerHit.kind === 'pc'
      ? positionOf(host.scene, attackerHit.entity.id, host.party.indexOf(attackerHit.entity))
      : attackerHit.entity.position
  };
  const targetForFx = {
    id: targetHit.entity.id,
    _position: targetHit.kind === 'pc'
      ? positionOf(host.scene, targetHit.entity.id, host.party.indexOf(targetHit.entity))
      : targetHit.entity.position
  };
  pushEffects(effectsForSaveSpell({
    attacker: attackerForFx, target: targetForFx,
    spell, damaged: result.damage > 0
  }));
  combat.spell = null;
  cancelAttack();
  saveScene(host.scene);

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
  if (hit.kind === 'pc') {
    // M45 Phase 2 — Honor the AI-chosen weapon if one was set this
    // turn. The auto-fight loop writes _chosenWeapon from the PC AI
    // plan; manual play leaves it null and we fall back to mainhand
    // exactly as before.
    return hit.entity._chosenWeapon || hit.entity.equipment?.mainhand || null;
  }
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
    const m = (host.scene.monsters || []).find(x => x.id === targetId);
    if (!m) return;
    const next = Math.max(0, Math.min(m.hp.max, m.hp.current - damage));
    m.hp = { ...m.hp, current: next };
    return;
  }
  // PC — adjust the rendered character's HP. This stays in-session.
  const pc = host.party.find(c => String(c.id) === String(targetId));
  if (!pc || !pc.hp) return;
  const next = Math.max(0, Math.min(pc.hp.max, (pc.hp.current ?? pc.hp.max) - damage));
  pc.hp = { ...pc.hp, current: next };
}

function entityName(hit) {
  if (!hit) return '';
  if (hit.kind === 'pc') return hit.entity.name || 'Character';
  return hit.entity.name || 'Monster';
}

function findHitById(id) {
  for (const pc of host.party) {
    if (String(pc.id) === String(id)) return { kind: 'pc', entity: pc };
  }
  for (const m of (host.scene.monsters || [])) {
    if (String(m.id) === String(id)) return { kind: 'monster', entity: m };
  }
  return null;
}
