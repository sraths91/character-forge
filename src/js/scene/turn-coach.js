/**
 * M22 — Turn coach: "things you might be forgetting" for the active entity.
 *
 * Looks at the entity's classFeatures, conditions, allies, and the
 * battlefield position, and surfaces a small ranked list of opportunities
 * the player might miss in the moment of play — Sneak Attack
 * triggers, flanking, Help eligibility, active conditions affecting
 * their rolls, unspent limited-use features.
 *
 * Output is a sorted [{ priority, icon, text, kind, sourceName? }] list.
 * Higher priority = more actionable / time-sensitive. The UI surfaces
 * the top N at the head of the Actions panel.
 *
 * Pure functions, no DOM. Reuses M14 grid helpers + M15 class-feature
 * registry so we don't reimplement rule checks.
 */

import { chebyshevFeet, isFlanking, factionLists } from './grid-rules.js';
import { resolveAttack } from './combat-resolver.js';

const ATTACKER_DISADV_CONDITIONS = [
  'poisoned', 'blinded', 'frightened', 'restrained', 'prone'
];

/**
 * Build the coach tips for an entity in the given scene context.
 *
 *   entity     — PC or monster instance
 *   kind       — 'pc' | 'monster'
 *   scene      — current scene (used for flanking toggle)
 *   party      — every PC in the party, with _position resolved
 *   monsters   — every monster instance in the scene
 *
 * Returns an array sorted by priority desc, capped at `max` tips.
 */
export function buildTurnTips({ entity, kind, scene, party = [], monsters = [], max = 5 }) {
  if (!entity) return [];
  const tips = [];
  const conditions = new Set(Array.isArray(entity.conditions) ? entity.conditions : []);
  const entityPos = entity._position || entity.position
    || (kind === 'pc' && scene?.positions?.[String(entity.id)]) || null;
  const { allies, hostiles } = factionLists({
    attackerKind: kind, attackerId: entity?.id, party, monsters
  });

  // 1. Hostile state warnings: surface conditions that hurt the entity's
  //    own rolls, so they don't forget to mention them to the DM.
  for (const c of ATTACKER_DISADV_CONDITIONS) {
    if (conditions.has(c)) {
      tips.push({
        priority: 95, kind: 'warning', icon: '⚠',
        text: `You are ${c} — your attacks have disadvantage.`
      });
    }
  }
  if (conditions.has('invisible')) {
    tips.push({
      priority: 90, kind: 'boon', icon: '✨',
      text: 'You are invisible — your attacks have advantage; attacks against you have disadvantage.'
    });
  }
  if (conditions.has('blessed') || conditions.has('hexed')) {
    // Reserved for a future concentration tracker; harmless no-op for now.
  }

  // 2. Per-hostile positional opportunities (flanking, Sneak Attack).
  //    We run the M15 registry against each hostile so any registered
  //    feature gets surfaced automatically (Sneak Attack today, Divine
  //    Smite / Hex / etc. tomorrow).
  if (entityPos) {
    for (const h of hostiles) {
      const hPos = h._position || h.position;
      if (!hPos) continue;
      const distance = chebyshevFeet(entityPos, hPos);

      // Flanking opportunity (variant rule, only when scene.flankingEnabled).
      if (scene?.flankingEnabled && distance === 5) {
        const fl = isFlanking(entityPos, hPos, allies);
        if (fl.flanking) {
          tips.push({
            priority: 80, kind: 'positional', icon: '⚔',
            text: `Flanking ${h.name || 'target'} with ${fl.ally?.name || 'an ally'} — your melee attacks have advantage.`
          });
        }
      }

      // Class-feature opportunities (Sneak Attack et al). Going through
      // the full resolver gives us the same condition/positional
      // accounting the actual attack roll would use — so a poisoned
      // rogue doesn't get a "Sneak Attack available" tip when in fact
      // their disadvantage blocks it.
      for (const weapon of collectEntityWeapons(entity)) {
        const verdict = resolveAttack({
          attacker: entity, target: h, weapon, scene,
          attackerKind: kind, targetKind: 'monster',
          targetAC: 10, advantageOverride: 'auto',
          attackStats: { bonus: 0, dice: '1d4',
            parts: [{ source: weapon.name || 'Weapon', value: 0 }],
            damageParts: [] },
          allies, hostiles
        });
        for (const f of (verdict.features || [])) {
          if (!f.available) continue;
          tips.push({
            priority: 85, kind: 'feature', icon: '✨', sourceName: f.name,
            text: `${f.name} available vs ${h.name || 'target'} with ${weapon.name || 'weapon'} (${f.dice}).`
          });
        }
      }
    }
  }

  // 3. Help action eligibility — any ally within 5 ft means Help is on
  //    the table. We pair-check so the tip names the closest ally.
  if (entityPos) {
    for (const a of allies) {
      const aPos = a._position || a.position;
      if (!aPos) continue;
      if (chebyshevFeet(entityPos, aPos) <= 5) {
        tips.push({
          priority: 50, kind: 'common', icon: '🤝',
          text: `Help action available — ${a.name || 'ally'} is within 5 ft.`
        });
        break;   // one tip is enough; multiple adjacent allies don't add info
      }
    }
  }

  // 4. Unspent limited-use class features (Channel Divinity, Eyes of
  //    Night, Vigilant Blessing, etc.). We don't track current charges
  //    yet, so just remind the player they exist if they have any uses.
  for (const f of (entity.classFeatures || [])) {
    if (!f.uses?.max) continue;
    tips.push({
      priority: 40, kind: 'limited-use', icon: '🔋', sourceName: f.name,
      text: `${f.name} — ${f.uses.max} use${f.uses.max === 1 ? '' : 's'} per ${f.uses.reset || 'rest'}.`
    });
  }

  // Dedup tips with identical text (a feature applying to two hostiles
  // would otherwise produce two copies for the same opportunity).
  const seen = new Set();
  const deduped = [];
  for (const t of tips) {
    if (seen.has(t.text)) continue;
    seen.add(t.text);
    deduped.push(t);
  }

  deduped.sort((a, b) => b.priority - a.priority);
  return deduped.slice(0, max);
}

// Pull every weapon the entity could attack with. Mirrors actions-panel's
// helper but inlined to keep this module free of cross-deps.
function collectEntityWeapons(entity) {
  const seen = new Set();
  const out = [];
  const consider = (w) => {
    if (!w || !w.name || !w.damage) return;
    const key = `${w.name}|${w.damage}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(w);
  };
  const eq = entity?.equipment || {};
  consider(eq.mainhand);
  consider(eq.offhand);
  for (const c of (entity?.carried || [])) {
    if (c?.slot === 'back' || c?.slot === 'waist') consider(c);
  }
  if (Array.isArray(entity?._weapons)) {
    for (const w of entity._weapons) consider(w);
  }
  return out;
}
