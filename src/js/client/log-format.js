/**
 * M64 C9 — fight-log lines from engine events (events.js catalogue v1).
 *
 * The forge's roll-log formatters (main.js appendAttackLog / appendCastLog
 * / appendReactionLog / appendSaveLog) take the legacy resolver shapes and
 * write HTML; the play client gets events instead, so this module maps
 * each event to plain text plus the same roll-log CSS classes
 * (`roll-hit`, `roll-miss`, `roll-crit`, `roll-spell`, `roll-reaction`)
 * and a distinct `roll-dm` class for DM edits. Text only: the view puts
 * it in `textContent`, never `innerHTML`.
 *
 * Pure: no DOM.
 */

/**
 * The log line for a `redacted {type}` broadcast: an event this seat may
 * not see (fog of war, or a DM fudge hidden from players).
 * @param {string} type — the hidden event's type
 * @returns {{text: string, cls: string, dm: boolean}}
 */
export function formatRedacted(type) {
  if (type === 'dm.override') return { text: 'The DM adjusts something behind the screen.', cls: 'roll-hidden', dm: false };
  if (type === 'turn.started' || type === 'turn.skipped') return { text: 'Something takes a turn out of sight…', cls: 'roll-hidden', dm: false };
  return { text: 'Something happens out of sight…', cls: 'roll-hidden', dm: false };
}

const sign = (n) => (n >= 0 ? `+${n}` : String(n));

/**
 * @param {object} ev — engine event {seq, type, round, payload}
 * @param {(id: string|null) => string} nameOf — entity id → display name
 * @param {{swing?: number, retarget?: boolean}} [ctx] — Extra Attack: this
 *   attack.rolled is swing N of its Attack action (and picked a new target)
 * @returns {{text: string, cls: string, dm: boolean}|null} null = not shown
 */
export function formatEvent(ev, nameOf = (id) => String(id ?? '—'), ctx = {}) {
  const p = ev?.payload || {};
  const n = (id) => nameOf(id ?? null);
  switch (ev?.type) {
    case 'turn.started': return { text: `— ${n(p.actorId)}'s turn${p.resumed === true ? ' resumes' : ''} (round ${ev.round}) —`, cls: 'roll-turn', dm: false };
    case 'turn.skipped': return { text: `${n(p.actorId)} skips the turn (${p.reason}).`, cls: 'roll-turn', dm: false };
    case 'turn.rejected': return { text: `${n(p.actorId)}: not allowed — ${p.reason}.`, cls: 'roll-miss', dm: false };
    case 'plan.chosen': {
      const VERB = { move: 'moves', dash: 'dashes', dodge: 'dodges', disengage: 'disengages', attack: 'attacks', melee: 'attacks', ranged: 'shoots', feature: 'uses a feature', flee: 'flees' };
      const what = p.spellId ? `casts ${p.spellId}` : p.weapon ? `attacks with ${p.weapon}` : (VERB[p.kind] || p.kind);
      return { text: `${n(p.actorId)} ${what}${p.targetId ? ` → ${n(p.targetId)}` : ''}${p.source === 'dm' ? ' (DM)' : ''}.`, cls: 'roll-plan', dm: p.source === 'dm' };
    }
    case 'move': return { text: `${n(p.actorId)} moves to (${p.to.col}, ${p.to.row}).`, cls: 'roll-move', dm: false };
    case 'reaction.offered': return { text: `${n(p.reactorId)} may react (${p.kind}).`, cls: 'roll-reaction', dm: false };
    case 'reaction.resolved':
      return { text: `${n(p.reactorId)} ${p.used ? 'uses' : 'declines'} ${p.kind}${p.by === 'timeout' ? ' (timed out)' : p.by === 'dm' ? ' (DM)' : ''}.`, cls: 'roll-reaction', dm: p.by === 'dm' };
    case 'attack.rolled': {
      const d20 = p.d20.length > 1 ? `d20=${p.kept} (${p.advantage} of ${p.d20.join(',')})` : `d20=${p.kept}`;
      const word = p.crit ? 'CRIT' : p.hit ? 'HIT' : p.shielded ? 'MISS (Shield)' : 'MISS';
      const swing = ctx.swing > 1 ? `Swing ${ctx.swing}${ctx.retarget ? ' (new target)' : ''}: ` : '';
      return {
        text: `${swing}${n(p.attackerId)} → ${n(p.targetId)}${p.weapon ? ` (${p.weapon})` : ''}: ${d20}${sign(p.bonus)}=${p.total} vs AC ${p.ac} — ${word}`,
        cls: p.crit ? 'roll-crit' : p.hit ? 'roll-hit' : 'roll-miss',
        dm: false
      };
    }
    case 'damage': return { text: `${n(p.targetId)} takes ${p.amount}${p.type ? ` ${p.type}` : ''} damage (${p.hpBefore} → ${p.hpAfter}).`, cls: 'roll-hit', dm: false };
    case 'heal': return { text: `${n(p.targetId)} heals ${p.amount} (${p.hpBefore} → ${p.hpAfter}).`, cls: 'roll-heal', dm: false };
    case 'save.rolled': return { text: `${n(p.entityId)} ${p.stat} save: ${p.total} vs DC ${p.dc} — ${p.success ? 'SAVE' : 'FAIL'}.`, cls: p.success ? 'roll-miss' : 'roll-hit', dm: false };
    case 'spell.cast': {
      const lvl = p.innate ? 'innate' : p.castAtLevel === 0 ? 'cantrip' : `level ${p.castAtLevel}`;
      const on = (p.targetIds || []).map(n).join(', ');
      return { text: `✦ ${n(p.casterId)} casts ${p.spellId} (${lvl})${on ? ` on ${on}` : ''}.`, cls: 'roll-spell', dm: !!p.adjudicated };
    }
    case 'spell.countered': return { text: `✦ ${n(p.counterId)} counters ${n(p.casterId)}'s spell.`, cls: 'roll-spell', dm: false };
    case 'spell.fizzled': return { text: `✦ ${n(p.casterId)}'s spell fizzles (${p.reason}).`, cls: 'roll-spell', dm: false };
    case 'condition.applied': return { text: `${n(p.entityId)} is ${p.condition}.`, cls: 'roll-condition', dm: false };
    case 'condition.removed': return { text: `${n(p.entityId)} is no longer ${p.condition}.`, cls: 'roll-condition', dm: false };
    case 'concentration.started': return { text: `${n(p.casterId)} concentrates on ${p.spellId}.`, cls: 'roll-spell', dm: false };
    case 'concentration.broken': return { text: `${n(p.casterId)} loses concentration on ${p.spellId}.`, cls: 'roll-spell', dm: false };
    case 'feature.used': return { text: `${n(p.entityId)} uses ${p.featureId}.`, cls: 'roll-feature', dm: false };
    case 'entity.downed': return { text: `${n(p.entityId)} is down!`, cls: 'roll-crit', dm: false };
    case 'death.save': {
      const tally = `${p.successes} ✓ / ${p.failures} ✗`;
      if (p.cause === 'damage') return { text: `${n(p.entityId)} is hit while dying — ${p.crit ? 'two failed' : 'a failed'} death save (${tally}).`, cls: 'roll-death', dm: false };
      const word = p.crit && p.success ? 'NATURAL 20 — back on their feet' : p.crit ? 'NATURAL 1 — two failures' : p.success ? 'success' : 'failure';
      return { text: `${n(p.entityId)} death save: d20=${p.d20 ?? '?'} — ${word} (${tally}).`, cls: 'roll-death', dm: false };
    }
    case 'entity.stabilized': return { text: `${n(p.entityId)} is stable.`, cls: 'roll-heal', dm: false };
    case 'entity.revived': return { text: `${n(p.entityId)} is back up${Number.isInteger(p.hp) ? ` (${p.hp} HP)` : ''}${p.byId ? ` — thanks to ${n(p.byId)}` : ''}.`, cls: 'roll-heal', dm: false };
    case 'entity.died': {
      const why = p.cause === 'massive' ? ' (massive damage)' : p.cause === 'failures' ? ' (three failed death saves)' : '';
      return { text: `${n(p.entityId)} dies${why}.`, cls: 'roll-crit roll-death', dm: false };
    }
    case 'dm.override': {
      const what = p.kind === 'spell.adjudicate' ? `adjudicated ${p.after?.spellId || 'a spell'}`
        : p.kind === 'plan' ? 'changed the plan'
        : p.kind === 'plan.skip' ? 'skipped the turn'
          : String(p.kind).startsWith('roll.') ? `set the ${String(p.kind).slice(5)} roll to ${typeof p.after === 'object' ? JSON.stringify(p.after) : p.after}`
            : `edited ${p.kind}`;
      return { text: `DM ${what}${p.entityId ? ` (${n(p.entityId)})` : ''}.`, cls: 'roll-dm', dm: true };
    }
    case 'encounter.ended': return { text: `Encounter over: ${p.outcome}.`, cls: 'roll-turn', dm: p.outcome === 'dm-ended' };
    case 'resource.spent':
    case 'exchange':
    case 'turn.ended':
    default:
      return null;
  }
}
