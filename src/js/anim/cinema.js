/**
 * M43.2 — Cinematic 1v1 view.
 *
 * Renders a Fire-Emblem-GBA-style side-on combat scene: attacker on
 * the left, defender on the right, with their sprites animated by an
 * M43.0 Sequence and effect primitives drawn in pixel space (no grid).
 * Damage applies at the sequence's hit-pause moment for proper timing
 * weight.
 *
 * Architecture split:
 *   - createCinemaState({attacker, defender})
 *     Pure state object: hp counters + pendingDmg. Testable headlessly.
 *   - findHitPauseAt(seq)
 *     Returns the time-ms when the sequence's hit-pause fires.
 *   - applyVerdictToState(state, t, pauseAt)
 *     Mutates state at the right moment — call every frame during play.
 *   - createCinema({canvas, attacker, defender, drawSprite?, drawBackground?})
 *     Wraps the state + a playSequence loop; returns a controller with
 *     playRound(seq, verdict) → Promise.
 *
 * Effect rendering happens in pixel space using the same primitives as
 * M27 (slash-arc, thrust, bash, projectile, burst, glyph-rise) but
 * drawn directly between attacker/defender anchors rather than grid
 * cells.
 *
 * The default sprite renderer is a stylized placeholder (colored
 * silhouette + name label) so the module works headless / in tests.
 * The versus integration replaces it with the real LPC sprite draw.
 */

import { playSequence } from './timeline.js';

/* =====================================================================
 * Pure state machine
 * ===================================================================== */

export function createCinemaState({ attacker, defender } = {}) {
  return {
    attacker: { id: attacker?.id, name: attacker?.name || 'Attacker' },
    defender: { id: defender?.id, name: defender?.name || 'Defender' },
    attHp:    attacker?.hpMax ?? attacker?.hp?.max ?? 1,
    attHpMax: attacker?.hpMax ?? attacker?.hp?.max ?? 1,
    defHp:    defender?.hpMax ?? defender?.hp?.max ?? 1,
    defHpMax: defender?.hpMax ?? defender?.hp?.max ?? 1,
    pendingDmg: null,
    popups: []
  };
}

/**
 * M44.1 — Classify the attacker's swing phase at time `t` relative to
 * the sequence's impact moment. Used by the LPC sprite renderer to
 * select an animation frame (windup → strike → recover → idle).
 *
 *   t < impactAt - 350         → idle (pre-fight stance)
 *   impactAt - 350 ≤ t < -100  → windup
 *   -100 ≤ t < impactAt + 180  → strike (impact + immediate follow-through)
 *   t ≥ impactAt + 180         → recover (returns to idle bob)
 */
export function phaseAt(t, impactAt) {
  if (!Number.isFinite(impactAt)) return 'idle';
  if (t < impactAt - 350) return 'idle';
  if (t < impactAt - 100) return 'windup';
  if (t < impactAt + 180) return 'strike';
  return 'recover';
}

/** Find the time-ms when the sequence's primary hit-pause fires. */
export function findHitPauseAt(seq) {
  if (!seq?.effects) return 0;
  const ev = seq.effects.find(e => e.type === 'hit-pause');
  return ev ? ev.at : Math.floor((seq.duration || 0) / 2);
}

/**
 * Apply the queued damage when the timeline crosses the hit-pause
 * moment. Idempotent: only fires once per pendingDmg.
 */
export function applyVerdictToState(state, t, pauseAt) {
  if (!state.pendingDmg) return false;
  if (t < pauseAt) return false;
  const v = state.pendingDmg;
  if (v.victim === 'attacker') state.attHp = Math.max(0, state.attHp - (v.dmg || 0));
  else                          state.defHp = Math.max(0, state.defHp - (v.dmg || 0));
  state.popups.push({ side: v.victim, dmg: v.dmg, crit: !!v.crit, t });
  state.pendingDmg = null;
  return true;
}

/* =====================================================================
 * Cinema controller
 * ===================================================================== */

export function createCinema({
  canvas = null, attacker, defender,
  drawSprite = drawSpriteDefault,
  drawBackground = drawBackgroundDefault,
  onActorsChanged = null,
  scale = 1
} = {}) {
  const ctx = canvas?.getContext?.('2d') || null;
  const state = createCinemaState({ attacker, defender });
  // Mutable actor refs so setActors() can swap them between rounds
  // without rebuilding the whole controller.
  let actorRefs = { attacker, defender };

  function playRound(seq, verdict = {}) {
    const pauseAt = findHitPauseAt(seq);
    state.pendingDmg = {
      victim: verdict.victim || 'defender',
      dmg:    verdict.dmg ?? 0,
      crit:   !!verdict.crit,
      miss:   !!verdict.miss
    };
    if (verdict.miss) state.pendingDmg.dmg = 0;
    // Headless fast-path: when there's no canvas, skip the rAF timeline
    // entirely — apply the verdict at the hit-pause moment and resolve
    // synchronously. Used by tests and any embedding context that just
    // wants the state machine to advance.
    if (!ctx) {
      applyVerdictToState(state, pauseAt, pauseAt);
      return Promise.resolve({ completed: true });
    }
    const ctl = playSequence(seq, (frame) => {
      applyVerdictToState(state, frame.t, pauseAt);
      draw(ctx, state, seq, frame, {
        attacker: actorRefs.attacker, defender: actorRefs.defender,
        drawSprite, drawBackground, scale, canvas
      });
    }, {});
    return ctl.promise;
  }

  /**
   * M44 — Swap attacker / defender between rounds. Updates the actor
   * refs the draw loop reads (so drawSprite gets the new entity's
   * refInfo) and resets HP counters to the new actors' maxes. The
   * optional onActorsChanged hook lets callers preload sprites async
   * before the next playRound.
   */
  async function setActors({ attacker: a, defender: d } = {}) {
    if (a) actorRefs.attacker = a;
    if (d) actorRefs.defender = d;
    state.attacker = { id: a?.id ?? state.attacker.id, name: a?.name || state.attacker.name };
    state.defender = { id: d?.id ?? state.defender.id, name: d?.name || state.defender.name };
    state.attHp    = a?.hpMax ?? a?.hp?.max ?? a?.hp?.current ?? state.attHp;
    state.attHpMax = a?.hpMax ?? a?.hp?.max ?? state.attHpMax;
    state.defHp    = d?.hpMax ?? d?.hp?.max ?? d?.hp?.current ?? state.defHp;
    state.defHpMax = d?.hpMax ?? d?.hp?.max ?? state.defHpMax;
    state.popups = [];
    state.pendingDmg = null;
    if (typeof onActorsChanged === 'function') {
      await onActorsChanged({ attacker: actorRefs.attacker, defender: actorRefs.defender });
    }
  }

  return {
    state, playRound, setActors,
    /** Reset HP counters so the cinema can be reused across rounds. */
    resetHp({ attHp, defHp } = {}) {
      if (Number.isFinite(attHp)) state.attHp = attHp;
      if (Number.isFinite(defHp)) state.defHp = defHp;
      state.popups = [];
      state.pendingDmg = null;
    }
  };
}

/* =====================================================================
 * Drawing (canvas-dependent)
 * ===================================================================== */

function draw(ctx, state, seq, frame, opts) {
  const W = opts.canvas?.width  ?? ctx.canvas.width;
  const H = opts.canvas?.height ?? ctx.canvas.height;
  const shake = frame.shake || { x: 0, y: 0 };
  // M43.5 — Camera zoom: a `zoom` effect in the sequence pushes the
  // entire scene in around the centre during its lifetime, then eases
  // back out. Multiple zooms compound multiplicatively.
  const zoom = cameraZoomAt(seq, frame.t);
  ctx.save();
  ctx.translate(shake.x | 0, shake.y | 0);
  if (zoom !== 1) {
    ctx.translate(W / 2, H / 2);
    ctx.scale(zoom, zoom);
    ctx.translate(-W / 2, -H / 2);
  }

  ctx.clearRect(-50, -50, W + 100, H + 100);
  opts.drawBackground(ctx, { W, H, t: frame.t });

  // Anchor positions: attacker bottom-left third, defender bottom-right third.
  const baseY = H * 0.62;
  const attAnchor = { x: W * 0.28 + frame.attacker.x, y: baseY + frame.attacker.y };
  const defAnchor = { x: W * 0.72 + frame.defender.x, y: baseY + frame.defender.y };

  // Floor line for visual grounding
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, baseY + 20); ctx.lineTo(W, baseY + 20); ctx.stroke();

  // M44.1 — Augment the per-actor snapshots with timing context so a
  // sprite renderer can pick the right pose frame for the current
  // swing phase. Pure additive — renderers that ignore these fields
  // still see the original x/y/rotation/scale/alpha snapshot.
  const impactAt = findHitPauseAt(seq);
  const attackerPhase = phaseAt(frame.t, impactAt);
  const attSnap = { ...frame.attacker, _t: frame.t, _impactAt: impactAt, _phase: attackerPhase };
  // Defender stays in idle for v1 — flinch is conveyed by the keyframe
  // knockback rather than a swapped frame.
  const defSnap = { ...frame.defender, _t: frame.t, _impactAt: impactAt, _phase: 'idle' };
  opts.drawSprite(ctx, 'attacker', attAnchor, attSnap, opts.attacker);
  opts.drawSprite(ctx, 'defender', defAnchor, defSnap, opts.defender);

  // Effects fire as snapshots — for cinema we use a small "trail" so
  // each effect persists for ~250ms after its at-time for visibility.
  // Sustained effects (aura) opt into a longer window via params.duration.
  for (const ef of seq.effects) {
    const age = frame.t - ef.at;
    if (age < 0) continue;
    const window = Number.isFinite(ef.params?.duration) ? ef.params.duration : 300;
    if (age > window) continue;
    const u = age / window;
    drawEffect(ctx, ef, u, attAnchor, defAnchor);
  }

  drawHpBar(ctx, 'attacker', { hp: state.attHp, hpMax: state.attHpMax, name: state.attacker.name },
    { x: 24, y: 24, w: W * 0.36, h: 16 });
  drawHpBar(ctx, 'defender', { hp: state.defHp, hpMax: state.defHpMax, name: state.defender.name },
    { x: W * 0.64 - 24, y: 24, w: W * 0.36, h: 16, align: 'right' });

  // Damage popups (rise + fade over 800ms)
  drawPopups(ctx, state.popups, frame.t, attAnchor, defAnchor);

  // White flash overlay
  if (frame.flash > 0.01) {
    ctx.fillStyle = `rgba(255,255,255,${frame.flash})`;
    ctx.fillRect(-50, -50, W + 100, H + 100);
  }

  ctx.restore();
}

function drawBackgroundDefault(ctx, { W, H }) {
  // Dark vignette gradient — neutral, doesn't fight the sprite colors
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, '#1a1a22');
  g.addColorStop(1, '#0a0a0f');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
}

function drawSpriteDefault(ctx, actor, anchor, snapshot, refInfo) {
  // Stylized silhouette placeholder. Replaced by real LPC sprite render
  // in the versus integration; this is enough to verify cinema timing
  // visually without the full sprite pipeline.
  ctx.save();
  ctx.translate(anchor.x, anchor.y);
  ctx.rotate(snapshot.rotation || 0);
  const s = (snapshot.scale || 1) * 1.0;
  ctx.scale(actor === 'defender' ? -s : s, s);   // mirror defender to face attacker
  ctx.globalAlpha = snapshot.alpha ?? 1;
  // Body
  ctx.fillStyle = actor === 'attacker' ? '#5b8df7' : '#d97757';
  ctx.fillRect(-12, -40, 24, 40);
  // Head
  ctx.fillStyle = actor === 'attacker' ? '#a5b4fc' : '#fbbf24';
  ctx.beginPath();
  ctx.arc(0, -52, 10, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  // Name label (un-mirrored)
  ctx.save();
  ctx.translate(anchor.x, anchor.y + 12);
  ctx.fillStyle = 'rgba(255,255,255,0.65)';
  ctx.font = '11px ui-monospace, monospace';
  ctx.textAlign = 'center';
  ctx.fillText(refInfo?.name || actor, 0, 0);
  ctx.restore();
}

function drawHpBar(ctx, _actor, { hp, hpMax, name }, box) {
  const pct = Math.max(0, Math.min(1, hpMax > 0 ? hp / hpMax : 0));
  const align = box.align || 'left';
  ctx.save();
  // Background
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.fillRect(box.x, box.y, box.w, box.h + 14);
  // Bar background
  ctx.fillStyle = 'rgba(255,255,255,0.10)';
  ctx.fillRect(box.x + 4, box.y + 16, box.w - 8, box.h - 4);
  // Fill
  const fillColor = pct > 0.5 ? '#4ade80' : pct > 0.25 ? '#fbbf24' : '#ef4444';
  ctx.fillStyle = fillColor;
  const fillW = (box.w - 8) * pct;
  if (align === 'right') {
    ctx.fillRect(box.x + 4 + (box.w - 8) - fillW, box.y + 16, fillW, box.h - 4);
  } else {
    ctx.fillRect(box.x + 4, box.y + 16, fillW, box.h - 4);
  }
  // Label
  ctx.fillStyle = 'rgba(255,255,255,0.9)';
  ctx.font = '11px ui-monospace, monospace';
  ctx.textAlign = align === 'right' ? 'right' : 'left';
  ctx.fillText(`${name} — ${hp}/${hpMax}`, align === 'right' ? box.x + box.w - 6 : box.x + 6, box.y + 12);
  ctx.restore();
}

function drawPopups(ctx, popups, t, attAnchor, defAnchor) {
  for (const p of popups) {
    const age = t - p.t;
    if (age < 0 || age > 800) continue;
    const u = age / 800;
    const anchor = p.side === 'attacker' ? attAnchor : defAnchor;
    const y = anchor.y - 50 - u * 35;
    const alpha = 1 - u;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = p.crit ? '#fbbf24' : '#f87171';
    ctx.font = `bold ${p.crit ? 28 : 22}px ui-sans-serif, sans-serif`;
    ctx.textAlign = 'center';
    ctx.strokeStyle = 'rgba(0,0,0,0.85)';
    ctx.lineWidth = 4;
    const text = p.crit ? `CRIT ${p.dmg}!` : String(p.dmg);
    ctx.strokeText(text, anchor.x, y);
    ctx.fillText(text, anchor.x, y);
    ctx.restore();
  }
}

/* =====================================================================
 * Effect primitives — pixel-space versions of the M27 set, drawn
 * between attacker and defender anchors.
 * ===================================================================== */

function drawEffect(ctx, ef, u, att, def) {
  switch (ef.type) {
    case 'slash-arc':  return drawSlashArc(ctx, u, att, def, ef.params);
    case 'thrust':     return drawThrust(ctx, u, att, def, ef.params);
    case 'bash':       return drawBash(ctx, u, att, def, ef.params);
    case 'projectile': return drawProjectile(ctx, u, att, def, ef.params);
    case 'burst':      return drawBurst(ctx, u, def, ef.params);
    case 'glyph-rise': return drawGlyphRise(ctx, u, att, ef.params);
    case 'aura':       return drawAura(ctx, u, att, def, ef.params);
    case 'sparkle':    return drawSparkle(ctx, u, att, def, ef.params);
    case 'zoom':       return;   // applied at the canvas-transform level
    default:           return;   // hit-pause / shake / flash handled by the engine
  }
}

/**
 * M43.5 — Compute the camera zoom scalar at time `t`. Sums every active
 * `zoom` effect: rises during the first half of its window, eases back
 * out during the second. Multiple zooms compound multiplicatively, so a
 * crit + big-hit combo reads as a deeper push-in.
 */
function cameraZoomAt(seq, t) {
  let scale = 1;
  for (const ef of seq.effects || []) {
    if (ef.type !== 'zoom') continue;
    const dur = Number.isFinite(ef.params?.duration) ? ef.params.duration : 300;
    const age = t - ef.at;
    if (age < 0 || age > dur) continue;
    const target = Math.max(1, ef.params?.scale || 1.1);
    const u = age / dur;
    // Triangle envelope — ramp up to mid, then back down
    const env = u < 0.5 ? (u / 0.5) : ((1 - u) / 0.5);
    scale *= 1 + (target - 1) * env;
  }
  return scale;
}

const COLOR_FOR_TYPE = {
  slashing:   '#cbd5e1',
  piercing:   '#fde68a',
  bludgeoning:'#f59e0b',
  fire:       '#f87171',
  cold:       '#7dd3fc',
  lightning:  '#fde047',
  force:      '#a78bfa',
  radiant:    '#fef3c7',
  necrotic:   '#a855f7'
};
function colorFor(params) {
  const t = params?.damageType;
  return (t && COLOR_FOR_TYPE[t.toLowerCase()]) || '#e5e7eb';
}

function drawSlashArc(ctx, u, att, def, params) {
  // Curved arc from attacker waist to defender torso, peaking up-right
  const color = colorFor(params);
  const alpha = Math.sin(u * Math.PI) * 0.9;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.globalAlpha = alpha;
  ctx.lineWidth = 5;
  ctx.shadowColor = color;
  ctx.shadowBlur = 16;
  ctx.lineCap = 'round';
  const mx = (att.x + def.x) / 2;
  const my = (att.y + def.y) / 2 - 30;
  ctx.beginPath();
  ctx.moveTo(att.x + 16, att.y - 20);
  ctx.quadraticCurveTo(mx, my, def.x - 16, def.y - 30);
  ctx.stroke();
  ctx.restore();
}

function drawThrust(ctx, u, att, def, params) {
  const color = colorFor(params);
  const phase = u < 0.5 ? u * 2 : (1 - u) * 2;
  const tipX = att.x + 16 + (def.x - att.x - 32) * phase;
  const tipY = att.y - 28 + (def.y - att.y) * phase;
  const alpha = 0.85 - Math.abs(0.5 - u) * 0.4;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.globalAlpha = alpha;
  ctx.lineWidth = 6;
  ctx.shadowColor = color;
  ctx.shadowBlur = 18;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(att.x + 16, att.y - 28);
  ctx.lineTo(tipX, tipY);
  ctx.stroke();
  ctx.restore();
}

function drawBash(ctx, u, att, def, params) {
  const color = colorFor(params);
  const radius = 18 + u * 36;
  const alpha = (1 - u) * 0.9;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.globalAlpha = alpha;
  ctx.lineWidth = Math.max(2, 5 * (1 - u));
  ctx.shadowColor = color;
  ctx.shadowBlur = 14;
  ctx.beginPath();
  ctx.arc(def.x, def.y - 28, radius, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

function drawProjectile(ctx, u, att, def, params) {
  const color = colorFor(params);
  const hx = att.x + 8 + (def.x - att.x - 16) * u;
  const hy = att.y - 30 + (def.y - att.y) * u;
  const trailU = Math.max(0, u - 0.2);
  const tx = att.x + 8 + (def.x - att.x - 16) * trailU;
  const ty = att.y - 30 + (def.y - att.y) * trailU;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.globalAlpha = 0.85;
  ctx.lineWidth = 4;
  ctx.shadowColor = color;
  ctx.shadowBlur = 14;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(tx, ty);
  ctx.lineTo(hx, hy);
  ctx.stroke();
  // Arrowhead
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(hx, hy, 4, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawBurst(ctx, u, def, params) {
  const color = colorFor(params);
  const radius = 8 + u * 50;
  const alpha = (1 - u) * 0.95;
  ctx.save();
  ctx.fillStyle = color;
  ctx.globalAlpha = alpha * 0.4;
  ctx.shadowColor = color;
  ctx.shadowBlur = 22;
  ctx.beginPath();
  ctx.arc(def.x, def.y - 28, radius, 0, Math.PI * 2);
  ctx.fill();
  // Ring outline
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(1.5, 4 * (1 - u));
  ctx.beginPath();
  ctx.arc(def.x, def.y - 28, radius, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

/**
 * Aura — sustained tinted glow around an actor. Used by M43.4 Rage
 * modifier. `params.actor` selects 'attacker' | 'defender'; `params.color`
 * sets the tint. Pulses gently over its lifetime.
 */
function drawAura(ctx, u, att, def, params) {
  const anchor = params?.actor === 'defender' ? def : att;
  const color = params?.color || '#dc2626';
  const pulse = 0.7 + 0.3 * Math.sin(u * Math.PI * 6);
  const radius = 26 + pulse * 4;
  const fade = Math.sin(Math.min(1, u * 3) * Math.PI * 0.5);   // ramp in
  const out  = u > 0.85 ? (1 - u) / 0.15 : 1;                   // ramp out
  const alpha = 0.35 * fade * out;
  ctx.save();
  const grad = ctx.createRadialGradient(anchor.x, anchor.y - 28, radius * 0.2, anchor.x, anchor.y - 28, radius);
  grad.addColorStop(0, hexWithAlpha(color, alpha));
  grad.addColorStop(1, hexWithAlpha(color, 0));
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(anchor.x, anchor.y - 28, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function hexWithAlpha(hex, a) {
  const m = String(hex).match(/^#([0-9a-f]{6})$/i);
  if (!m) return `rgba(220,38,38,${a})`;
  const v = parseInt(m[1], 16);
  const r = (v >> 16) & 0xff, g = (v >> 8) & 0xff, b = v & 0xff;
  return `rgba(${r},${g},${b},${a})`;
}

/**
 * M43.5 — Sparkle particle. Small 4-point star that twinkles and drifts
 * upward between the attacker and defender. `params.seed` deterministically
 * scatters multiple sparkles around the midpoint without an RNG.
 */
function drawSparkle(ctx, u, att, def, params) {
  const color = params?.color || '#fef3c7';
  const seed = (params?.seed | 0) || 0;
  const size = params?.size || 4;
  // Deterministic offset from seed — readable as a "puff" of particles
  const ang = (seed * 137.5) * Math.PI / 180;
  const r   = 12 + (seed % 4) * 6;
  const mx = (att.x + def.x) / 2 + Math.cos(ang) * r;
  const my = (att.y + def.y) / 2 - 30 + Math.sin(ang) * r * 0.5;
  const drift = u * 14;
  const alpha = Math.sin(u * Math.PI);   // fade in/out
  if (alpha <= 0.02) return;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  ctx.shadowColor = color;
  ctx.shadowBlur = 10;
  ctx.translate(mx, my - drift);
  ctx.rotate(u * Math.PI * 0.5);
  // 4-point star
  ctx.beginPath();
  ctx.moveTo(0, -size);
  ctx.lineTo(size * 0.35, -size * 0.35);
  ctx.lineTo(size, 0);
  ctx.lineTo(size * 0.35, size * 0.35);
  ctx.lineTo(0, size);
  ctx.lineTo(-size * 0.35, size * 0.35);
  ctx.lineTo(-size, 0);
  ctx.lineTo(-size * 0.35, -size * 0.35);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function drawGlyphRise(ctx, u, att, params) {
  const color = colorFor(params);
  const cy = att.y - 6 - u * 12;
  const radius = 20 + u * 14;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.globalAlpha = 0.8 - u * 0.4;
  ctx.lineWidth = 2;
  ctx.shadowColor = color;
  ctx.shadowBlur = 16;
  // Triple ring
  for (let i = 0; i < 3; i++) {
    ctx.beginPath();
    ctx.arc(att.x, cy, radius - i * 4, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}
