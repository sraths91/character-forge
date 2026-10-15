// PromptBroker (M64 B7, R1 §3.2): turns an engine prompt into a network
// prompt to one member and back into the engine's `async → answer` shape.
//
//   ask() → Promise<{answer, by}>   by: 'player' | 'auto' | 'timeout' | 'dm'
//     1. not eligible               → {answer: false, by: 'auto'} — no prompt (fixes P0-2)
//     2. no human addressee/offline → {answer: autoAnswer, by: 'auto'}
//     3. otherwise private `prompt.open {promptId, kind, payload, autoAnswer,
//        deadlineAt, serverNow}` to the addressee; the first of
//          prompt.answer from the addressee      → by 'player'
//          dm.prompt.force from the DM           → by 'dm'
//          the deadline                          → autoAnswer, by 'timeout'
//          the addressee going offline / cancel  → autoAnswer, by 'auto'
//        resolves it, and a private `prompt.closed` follows.
// Reconnects get the open prompt again with its ORIGINAL deadline.

import { newId } from './tokens.js';

/** Default reaction deadline (room setting `reactionTimeoutMs`). */
export const DEFAULT_PROMPT_TIMEOUT_MS = 20_000;

/** Answer validators per prompt kind; a bad answer is rejected (E_INVALID_INTENT). */
const ANSWER_OK = {
  oa: (a) => typeof a === 'boolean',
  shield: (a) => typeof a === 'boolean',
  counterspell: (a) => typeof a === 'boolean',
  plan: (a) => a === null || (a !== null && typeof a === 'object' && !Array.isArray(a) && typeof a.kind === 'string'),
  roll: (a) => Number.isInteger(a)
};

/**
 * @typedef {object} OpenPrompt
 * @property {string} promptId
 * @property {string} kind
 * @property {string} addressee  member id
 * @property {object} payload
 * @property {unknown} autoAnswer
 * @property {number} deadlineAt
 */

export class PromptBroker {
  /**
   * @param {object} opts
   * @param {(memberId: string, t: string, p: object) => void} opts.send  private message to a member
   * @param {(memberId: string) => boolean} opts.isOnline
   * @param {() => number} [opts.now=Date.now]
   * @param {typeof setTimeout} [opts.setTimer=setTimeout]
   * @param {typeof clearTimeout} [opts.clearTimer=clearTimeout]
   */
  constructor({ send, isOnline, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
    this.send = send;
    this.isOnline = isOnline;
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    /** @type {Map<string, OpenPrompt & {resolve: Function, timer: any}>} */
    this.open = new Map();
  }

  /**
   * @param {object} a
   * @param {string} a.kind               oa | shield | counterspell | plan | roll
   * @param {string|null} a.addressee     member id, or null when nobody human answers
   * @param {unknown} a.autoAnswer
   * @param {boolean} [a.eligible=true]
   * @param {object} [a.payload={}]
   * @param {number} [a.timeoutMs=DEFAULT_PROMPT_TIMEOUT_MS]
   * @returns {Promise<{answer: unknown, by: 'player'|'auto'|'timeout'|'dm', promptId?: string}>}
   */
  ask({ kind, addressee, autoAnswer, eligible = true, payload = {}, timeoutMs = DEFAULT_PROMPT_TIMEOUT_MS }) {
    if (!eligible) return Promise.resolve({ answer: false, by: 'auto' });
    if (!addressee || !this.isOnline(addressee)) return Promise.resolve({ answer: autoAnswer, by: 'auto' });
    const promptId = newId('pr_');
    const deadlineAt = this.now() + timeoutMs;
    return new Promise((resolve) => {
      const entry = {
        promptId, kind, addressee, payload, autoAnswer, deadlineAt, resolve,
        timer: this.setTimer(() => this.#settle(promptId, autoAnswer, 'timeout'), timeoutMs)
      };
      this.open.set(promptId, entry);
      this.send(addressee, 'prompt.open', this.#openPayload(entry));
    });
  }

  #openPayload(e) {
    return { promptId: e.promptId, kind: e.kind, payload: e.payload, autoAnswer: e.autoAnswer, deadlineAt: e.deadlineAt, serverNow: this.now() };
  }

  #settle(promptId, answer, by) {
    const e = this.open.get(promptId);
    if (!e) return false;
    this.open.delete(promptId);
    this.clearTimer(e.timer);
    e.resolve({ answer, by, promptId });
    this.send(e.addressee, 'prompt.closed', { promptId, reason: by });
    return true;
  }

  /**
   * A member answers. @returns {'ok'|'stale'|'forbidden'|'invalid'}
   * @param {string} memberId
   * @param {string} promptId
   * @param {unknown} answer
   */
  answer(memberId, promptId, answer) {
    const e = this.open.get(promptId);
    if (!e) return 'stale';
    if (e.addressee !== memberId) return 'forbidden';
    if (!ANSWER_OK[e.kind]?.(answer)) return 'invalid';
    this.#settle(promptId, answer, 'player');
    return 'ok';
  }

  /** The DM forces any open prompt. @returns {'ok'|'stale'|'invalid'} */
  force(promptId, answer) {
    const e = this.open.get(promptId);
    if (!e) return 'stale';
    if (!ANSWER_OK[e.kind]?.(answer)) return 'invalid';
    this.#settle(promptId, answer, 'dm');
    return 'ok';
  }

  /** The addressee went offline: their prompts resolve with the auto answer. */
  memberOffline(memberId) {
    for (const e of [...this.open.values()]) if (e.addressee === memberId) this.#settle(e.promptId, e.autoAnswer, 'auto');
  }

  /** The open prompt addressed to a member (original deadline), or null. */
  openPromptFor(memberId) {
    for (const e of this.open.values()) if (e.addressee === memberId) return this.#openPayload(e);
    return null;
  }

  /** Resolve everything with its auto answer (shutdown, encounter end). */
  cancelAll() {
    for (const e of [...this.open.values()]) this.#settle(e.promptId, e.autoAnswer, 'auto');
  }
}
