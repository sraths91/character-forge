/**
 * M4 — Combat actions.
 *
 * This module owns the *transient* combat state (not persisted): which
 * entity is mid-attack, what animations are currently playing, what
 * floating damage popups are visible. Persistent state (HP, position)
 * lives on the scene; this module just orchestrates the flow.
 *
 * The flow:
 *   1. caller calls beginAttack() → mode flips to 'pick-attacker'
 *   2. UI shows "Click an attacker", pointer hits resolve via combat-state-aware
 *      logic in main.js
 *   3. caller calls selectAttacker(entityId, kind) → mode → 'pick-target',
 *      attacker glows
 *   4. caller calls selectTarget(entityId, kind) → fires resolveAttack()
 *      which: spawns animations + damage popup, applies HP change, exits mode
 *   5. mode returns to 'idle'
 *
 * Active animations are stored as records in entityAnimations and
 * damagePopups. The render loop in main.js iterates these on every
 * tick, draws overlays, and removes expired entries.
 */

// State machine
export const combat = {
  mode: 'idle',                    // 'idle' | 'pick-attacker' | 'pick-target'
  attacker: null,                  // { id, kind: 'pc'|'monster' } when selected
};

// Active animations keyed by entity id. Each: { kind, startedAt, duration }
// kinds: 'attack' (attacker lunge), 'hurt' (target flash)
export const entityAnimations = new Map();

// Floating "-X" damage numbers. Each: { id, targetId, amount, startedAt, duration }
export const damagePopups = [];

let popupSeq = 1;
const DEFAULT_ANIM_MS = {
  attack: 280,
  hurt:   420,
  popup: 1200
};

export function beginAttack() {
  combat.mode = 'pick-attacker';
  combat.attacker = null;
}

export function cancelAttack() {
  combat.mode = 'idle';
  combat.attacker = null;
}

export function selectAttacker(entityId, kind) {
  if (!entityId) return;
  combat.attacker = { id: entityId, kind };
  combat.mode = 'pick-target';
}

/**
 * Apply an attack: spawn animations + popup, return the resolution
 * details for the caller (which actually mutates HP state since that
 * lives in scene/scene-state.js).
 *
 *   { attackerId, attackerKind, targetId, targetKind, damage }
 *
 * Caller is responsible for clamping HP, persisting the scene, and
 * triggering a re-render.
 */
export function resolveAttack(targetId, targetKind, damage) {
  if (!combat.attacker) return null;
  const now = performance.now();
  const attackerId = combat.attacker.id;
  const attackerKind = combat.attacker.kind;

  entityAnimations.set(attackerId, {
    kind: 'attack', startedAt: now, duration: DEFAULT_ANIM_MS.attack, targetId
  });
  entityAnimations.set(targetId, {
    kind: 'hurt', startedAt: now + 90,    // tiny delay so target reacts to the hit
    duration: DEFAULT_ANIM_MS.hurt
  });
  if (Number.isFinite(damage) && damage > 0) {
    damagePopups.push({
      id: `dp_${popupSeq++}`,
      targetId, amount: damage,
      startedAt: now + 90, duration: DEFAULT_ANIM_MS.popup
    });
  }

  combat.mode = 'idle';
  combat.attacker = null;
  return { attackerId, attackerKind, targetId, targetKind, damage };
}

/**
 * Garbage-collect expired animations and popups. Returns true if anything
 * is still active — the render loop should keep ticking when true.
 */
export function pruneExpired() {
  const now = performance.now();
  for (const [id, anim] of entityAnimations) {
    if (now > anim.startedAt + anim.duration) entityAnimations.delete(id);
  }
  for (let i = damagePopups.length - 1; i >= 0; i--) {
    const p = damagePopups[i];
    if (now > p.startedAt + p.duration) damagePopups.splice(i, 1);
  }
  return entityAnimations.size > 0 || damagePopups.length > 0;
}

export function hasActiveAnimations() {
  return entityAnimations.size > 0 || damagePopups.length > 0;
}

/** Animation progress 0..1, or null if not started yet / already expired. */
export function progressOf(anim, now = performance.now()) {
  if (!anim) return null;
  const elapsed = now - anim.startedAt;
  if (elapsed < 0) return 0;
  if (elapsed > anim.duration) return null;
  return elapsed / anim.duration;
}
