/**
 * M38 — Reaction prompt module.
 *
 * A promise-based prompt the combat flow can `await` to ask the player
 * whether they want to spend a reaction (Shield, Counterspell,
 * opportunity attack). Inline UI (not a true modal); auto-declines
 * after `defaultMs` so the fight never deadlocks on an idle prompt.
 *
 * The prompt is rendered into the supplied DOM container; in versus
 * mode that's `#reaction-prompt-host` which lives just above the
 * versus status line. Multiple prompts queue: each call dismisses the
 * previous element before mounting a new one (a player normally only
 * sees one pending reaction at a time).
 *
 * In auto-fight mode the caller should pass `auto: true` to
 * short-circuit the prompt — we still want the reaction logic to fire,
 * just without a UI gate.
 */

/**
 * @typedef {object} ReactionPromptOptions
 * @property {string} title       — short label, e.g. "Cast Shield?"
 * @property {string} body        — one-line context, e.g. "Goblin's 16 vs your AC 14"
 * @property {string} [costLabel] — what spending costs, e.g. "1 reaction · 1 slot"
 * @property {number} [defaultMs] — auto-decline after N ms (default 5000)
 * @property {boolean} [auto]     — if true, resolve immediately to `auto` (default false)
 * @property {boolean} [autoAnswer] — when `auto` is true, the answer (default false)
 * @property {HTMLElement} [container] — DOM mount point (default #reaction-prompt-host)
 */

/**
 * Resolve to `true` if the player accepted the reaction, `false`
 * otherwise (declined or timeout). Always cleans up its DOM.
 */
export function promptReaction(opts = {}) {
  const {
    title = 'Reaction?',
    body = '',
    costLabel = '',
    defaultMs = 5000,
    auto = false,
    autoAnswer = false,
    container = (typeof document !== 'undefined'
      ? document.getElementById('reaction-prompt-host') : null)
  } = opts;

  // Auto-fight short-circuit: no UI, return the configured answer.
  if (auto) return Promise.resolve(!!autoAnswer);
  // No DOM (tests / SSR): resolve to false — safe default.
  if (!container) return Promise.resolve(false);

  return new Promise((resolve) => {
    // Dismiss any prior prompt to keep at most one onscreen.
    container.innerHTML = '';
    const el = document.createElement('div');
    el.className = 'reaction-prompt';
    el.setAttribute('role', 'dialog');
    el.innerHTML = `
      <div class="reaction-prompt-title">⚡ ${escape(title)}</div>
      <div class="reaction-prompt-body">${escape(body)}</div>
      ${costLabel ? `<div class="reaction-prompt-cost">${escape(costLabel)}</div>` : ''}
      <div class="reaction-prompt-actions">
        <button class="reaction-prompt-yes" type="button">Yes</button>
        <button class="reaction-prompt-no"  type="button">No</button>
        <span class="reaction-prompt-timer" data-deadline="${Date.now() + defaultMs}"></span>
      </div>
    `;
    container.appendChild(el);

    let settled = false;
    const cleanup = () => {
      if (settled) return;
      settled = true;
      clearInterval(tickId);
      clearTimeout(timeoutId);
      if (el.parentNode) el.parentNode.removeChild(el);
    };
    const finish = (answer) => { cleanup(); resolve(answer); };

    el.querySelector('.reaction-prompt-yes').addEventListener('click', () => finish(true));
    el.querySelector('.reaction-prompt-no').addEventListener('click', () => finish(false));

    // Live countdown so the player can see how long they have left.
    const timerSpan = el.querySelector('.reaction-prompt-timer');
    const tickId = setInterval(() => {
      const deadline = Number(timerSpan.dataset.deadline || 0);
      const ms = Math.max(0, deadline - Date.now());
      timerSpan.textContent = `(${Math.ceil(ms / 1000)}s)`;
      if (ms <= 0) finish(false);
    }, 200);

    const timeoutId = setTimeout(() => finish(false), defaultMs);
  });
}

function escape(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
