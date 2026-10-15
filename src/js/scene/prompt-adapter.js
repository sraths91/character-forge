/**
 * M64 T6 — server prompt adapter (pure, no ws, no wall clock).
 *
 * Wraps the engine's three reaction prompts so a remote seat can answer
 * them without ever stalling the turn:
 *
 *   const prompts = {
 *     ...cinemaCallbacks,
 *     ...createPromptAdapter({ ask, timeoutMs: 20000, autoAnswerFor, log })
 *   };
 *   await runOneAttack(attacker, enemies, allies, scene, rng, prompts, ctx);
 *
 * For every reaction window the engine offers:
 *   1. `autoAnswerFor(req)` may answer at once (AI-run or offline seat):
 *      return a boolean → answered `by: 'auto'`; return null/undefined to
 *      ask the seat.
 *   2. `ask(req)` asks the owning seat. It resolves a boolean (the
 *      player's answer, `by: 'player'`) or `{answer, by}` (e.g. a DM
 *      forcing it: `by: 'dm'`). A rejection or a non-answer falls back to
 *      the engine heuristic (`by: 'auto'`).
 *   3. If `ask` has not settled after `timeoutMs`, the engine heuristic
 *      (`req.autoAnswer`) answers with `by: 'timeout'`.
 *   4. `log(record)` receives every answer as a reaction.resolved payload
 *      `{reactorId, kind, used, by, autoAnswer, …ids}` — the record the
 *      server persists so a replay feeds the same answers back
 *      (createReplayAsk).
 *
 * The wrapped callbacks resolve `{ answer, by }`, which the engine
 * accepts alongside plain booleans (engine-events.normalizeAnswer); the
 * engine still gates every `true` against the reactor's eligibility.
 *
 * Timers come from the injected `clock` ({ setTimeout, clearTimeout }),
 * defaulting to the global timers, so tests run on a fake clock.
 */

/** Reaction kinds, as the event catalogue names them. */
export const PROMPT_KINDS = Object.freeze(['oa', 'shield', 'counterspell']);

const BY = new Set(['player', 'auto', 'timeout', 'dm']);
const idOf = (w) => (w?.id != null ? String(w.id) : null);

/**
 * The JSON request describing one reaction window (ids only).
 * @param {'oa'|'shield'|'counterspell'} kind
 * @param {object} args — the engine's prompt argument
 * @returns {object}
 */
export function promptRequest(kind, args) {
  if (kind === 'shield') {
    return {
      kind, reactorId: idOf(args.defender), autoAnswer: !!args.autoAnswer,
      attackTotal: args.atk?.total ?? null, autoHit: !!args.atk?.autoHit,
      spellId: args.spell?.id ?? null
    };
  }
  if (kind === 'counterspell') {
    return {
      kind, reactorId: idOf(args.witness), autoAnswer: !!args.autoAnswer,
      casterId: idOf(args.caster), spellId: args.spell?.id ?? null, spellLevel: args.spell?.level ?? null
    };
  }
  return {
    kind, reactorId: idOf(args.triggerer), autoAnswer: !!args.autoAnswer,
    moverId: idOf(args.mover), trigger: args.kind ?? null
  };
}

function normalize(v, fallback) {
  if (v && typeof v === 'object' && 'answer' in v) {
    return { answer: !!v.answer, by: BY.has(v.by) ? v.by : 'player' };
  }
  if (typeof v === 'boolean') return { answer: v, by: 'player' };
  return { answer: !!fallback, by: 'auto' };
}

/**
 * Wrap the engine's reaction prompts with seat routing, a deadline and an
 * answer log.
 *
 * @param {object} opts
 * @param {(req: object) => Promise<boolean|{answer: boolean, by?: string}|null|undefined>} [opts.ask]
 *   asks the owning seat; absent → every window auto-answers
 * @param {number} [opts.timeoutMs=20000] — deadline per window
 * @param {(req: object) => boolean|null|undefined} [opts.autoAnswerFor]
 *   instant answer for AI/offline seats (null → ask)
 * @param {(record: object) => void} [opts.log] — receives each answer
 * @param {{setTimeout: Function, clearTimeout: Function}} [opts.clock]
 * @returns {{onShieldReaction: Function, onCounterspell: Function, onReactionAttack: Function}}
 */
export function createPromptAdapter({ ask = null, timeoutMs = 20000, autoAnswerFor = null, log = null, clock = null } = {}) {
  const timers = clock || { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout };

  async function answerFor(kind, args) {
    const req = promptRequest(kind, args);
    let result;
    const instant = autoAnswerFor ? autoAnswerFor(req) : null;
    if (typeof instant === 'boolean') {
      result = { answer: instant, by: 'auto' };
    } else if (typeof ask !== 'function') {
      result = { answer: req.autoAnswer, by: 'auto' };
    } else {
      let timer = null;
      const deadline = new Promise(resolve => {
        timer = timers.setTimeout(() => resolve({ answer: req.autoAnswer, by: 'timeout' }), Math.max(0, timeoutMs));
      });
      const asked = Promise.resolve()
        .then(() => ask(req))
        .then(v => normalize(v, req.autoAnswer), () => ({ answer: req.autoAnswer, by: 'auto' }));
      try {
        result = await Promise.race([asked, deadline]);
      } finally {
        timers.clearTimeout(timer);
      }
    }
    if (typeof log === 'function') {
      const { autoAnswer, kind: k, reactorId, ...ids } = req;
      log({ reactorId, kind: k, used: result.answer, by: result.by, autoAnswer, ...ids });
    }
    return result;
  }

  return {
    onShieldReaction: (args) => answerFor('shield', args),
    onCounterspell: (args) => answerFor('counterspell', args),
    onReactionAttack: (args) => answerFor('oa', args)
  };
}

/**
 * An `ask` that replays logged answers in order (crash recovery / replay):
 * each call returns the next record's `{answer: used, by}`; when the log
 * runs out it returns null so the adapter falls back to the heuristic.
 * A record whose kind/reactor does not match the request is not used:
 * the call returns null and the mismatch is pushed onto `ask.diverged`.
 *
 * @param {object[]} records — log() output, in order
 * @returns {((req: object) => Promise<{answer: boolean, by: string}|null>) & {diverged: object[]}}
 */
export function createReplayAsk(records) {
  let i = 0;
  const replay = async (req) => {
    const r = records[i++];
    if (!r) return null;
    if (r.kind !== req.kind || r.reactorId !== req.reactorId) {
      replay.diverged.push({ index: i - 1, logged: { kind: r.kind, reactorId: r.reactorId }, asked: { kind: req.kind, reactorId: req.reactorId } });
      return null;
    }
    return { answer: !!r.used, by: r.by };
  };
  replay.diverged = [];
  return replay;
}
