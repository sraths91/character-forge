/**
 * M43.5 — Level / crit / magic polish.
 *
 * Final transform pass over a composed sequence. Reads the surrounding
 * context (PC level, crit flag, damage magnitude, weapon enchantment)
 * and layers finishing touches — extra particles, longer crit-pauses,
 * camera zoom on big hits, signature flourishes for silvered / magic
 * weapons.
 *
 *   const seq0 = buildMotion(...);                // M43.1
 *   const seq1 = applyStyle(seq0, style);         // M43.3
 *   const seq2 = applyModifiers(seq1, mods, ...); // M43.4
 *   const seq3 = applyPolish(seq2, ctx);          // M43.5
 *
 * Pure transform — never mutates input. Same shape in / same shape out.
 */

const SPARKLE = 'sparkle';
const ZOOM = 'zoom';

/**
 * @typedef {object} PolishCtx
 * @property {number}  [level]       — attacker total level
 * @property {boolean} [crit]        — was the attack a critical hit
 * @property {number}  [dmg]         — damage dealt
 * @property {number}  [defenderHp]  — defender HP at strike time (max)
 * @property {boolean} [magical]     — weapon is magical
 * @property {string}  [material]    — weapon material (silvered, adamantine, ...)
 * @property {string}  [damageType]  — weapon damage type
 * @property {boolean} [killing]     — does this hit drop the defender
 */

/**
 * Apply the polish layer. Returns a NEW Sequence; input is never mutated.
 * Pure data — the cinema renderer reads the added effects + scale fields.
 */
export function applyPolish(seq, ctx = {}) {
  if (!seq) return seq;
  const impactAt = impactTimeOf(seq);
  const level = Number(ctx.level) || 1;

  const out = cloneSeq(seq);
  out.id = `${seq.id}+polish`;
  out.meta = { ...(seq.meta || {}), polish: true };

  // ----- Crit: longer freeze + bright flash + double shake -----
  if (ctx.crit) {
    out.effects.push(
      { at: impactAt,      type: 'hit-pause', params: { duration: 220, _polish: 'crit' } },
      { at: impactAt - 10, type: 'flash',     params: { intensity: 0.55 } },
      { at: impactAt + 40, type: 'shake',     params: { amplitude: 6 } },
      // M47 — Debris shards spray from the impact on a crit.
      { at: impactAt, type: 'particles',
        params: { preset: 'critShards', origin: 'defender', _polish: 'crit' } }
    );
    out.meta.crit = true;
  }

  // ----- Big-hit camera zoom -----
  // Triggers when damage >= 25% of the defender's max HP, OR on a crit,
  // OR on a killing blow. Encoded as a `zoom` effect the cinema reads
  // to push-in at impact, then ease back out.
  const big = isBigHit(ctx);
  if (big) {
    out.effects.push({
      at: Math.max(0, impactAt - 80),
      type: ZOOM,
      params: { scale: ctx.crit ? 1.18 : 1.10, duration: 320, _polish: 'big-hit' }
    });
    out.meta.bigHit = true;
  }

  // ----- Magic weapon signature: glyph + colored sparkles -----
  if (ctx.magical) {
    const color = polishColorFor(ctx);
    out.effects.push(
      { at: Math.max(0, impactAt - 200), type: 'glyph-rise',
        params: { damageType: ctx.damageType || 'force', _polish: 'magical' } },
      // Sparkle trail — N particles tied to attacker→defender line
      ...sparkleTrail(impactAt, color, level, false)
    );
    out.meta.magical = true;
  }

  // ----- Silvered: cool metallic glint just before impact -----
  if (ctx.material === 'silvered') {
    out.effects.push(
      { at: Math.max(0, impactAt - 60), type: 'flash', params: { intensity: 0.35 } },
      ...sparkleTrail(impactAt, '#e2e8f0', Math.max(2, Math.floor(level / 2)), true)
    );
    out.meta.silvered = true;
  }

  // ----- High-level particle density -----
  // Lvl 5/11/17 are D&D tier breakpoints; we layer one extra effect per
  // tier so a level-17 hit reads visibly denser than a level-1 hit.
  if (level >= 5) {
    out.effects.push({
      at: impactAt + 60, type: 'burst',
      params: { damageType: ctx.damageType || 'slashing', radius: 22, _polish: 'tier-2' }
    });
  }
  if (level >= 11) {
    out.effects.push({
      at: impactAt + 30, type: 'shake',
      params: { amplitude: 3 }
    });
  }
  if (level >= 17) {
    out.effects.push(
      ...sparkleTrail(impactAt, '#fef3c7', 4, false)
    );
  }

  // Killing blow — one bonus flash for finality
  if (ctx.killing) {
    out.effects.push({ at: impactAt + 80, type: 'flash', params: { intensity: 0.4 } });
    out.meta.killing = true;
  }

  // Pull duration forward only when polish appended effects past the
  // base sequence's natural end. Otherwise leave duration untouched —
  // a no-op polish must round-trip the original timing.
  if (out.effects.length > seq.effects.length) {
    const tail = out.effects.reduce((m, e) => Math.max(m, e.at), out.duration);
    if (tail > out.duration) out.duration = tail + 200;
  }

  return out;
}

/* =====================================================================
 * Helpers
 * ===================================================================== */

function isBigHit(ctx) {
  if (ctx.crit) return true;
  if (ctx.killing) return true;
  const dmg = Number(ctx.dmg) || 0;
  const hpMax = Number(ctx.defenderHp) || 0;
  if (hpMax > 0 && dmg / hpMax >= 0.25) return true;
  return false;
}

function impactTimeOf(seq) {
  if (!seq?.effects) return Math.floor((seq?.duration || 1000) / 2);
  const ev = seq.effects.find(e => e.type === 'hit-pause');
  return ev ? ev.at : Math.floor((seq.duration || 1000) / 2);
}

function cloneSeq(seq) {
  return {
    id: seq.id,
    duration: seq.duration,
    keyframes: seq.keyframes.map(k => ({ ...k })),
    effects: seq.effects.map(e => ({ ...e, params: { ...(e.params || {}) } })),
    meta: { ...(seq.meta || {}) }
  };
}

function polishColorFor(ctx) {
  const t = String(ctx.damageType || '').toLowerCase();
  return ({
    fire:       '#f87171',
    cold:       '#7dd3fc',
    lightning:  '#fde047',
    force:      '#a78bfa',
    radiant:    '#fef3c7',
    necrotic:   '#a855f7'
  })[t] || '#a78bfa';
}

/**
 * Generate N sparkle effects timed near impact. Each sparkle has a
 * stagger offset so they read as a particle puff rather than a single
 * flash. `silvered` swaps the lifetime for a brighter, shorter glint.
 */
function sparkleTrail(impactAt, color, count, silvered) {
  const n = Math.max(1, Math.min(8, count | 0));
  const out = [];
  for (let i = 0; i < n; i++) {
    const offset = silvered ? -30 - i * 12 : -20 + i * 20;
    out.push({
      at: Math.max(0, impactAt + offset),
      type: SPARKLE,
      params: {
        color,
        size: silvered ? 3 : 4 + (i % 2),
        lifetime: silvered ? 220 : 320,
        seed: i,
        duration: silvered ? 220 : 320
      }
    });
  }
  return out;
}
