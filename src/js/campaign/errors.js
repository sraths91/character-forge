/**
 * M65 — the one error type the campaign rules throw.
 *
 * Every refusal (overspent hit dice, a long rest at 0 HP, a fourth
 * attunement, a revive without a diamond, …) is a `CampaignRuleError`
 * with a stable machine `code`, so the server can map it to an intent
 * rejection without parsing messages.
 */
export class CampaignRuleError extends Error {
  /**
   * @param {string} code — stable machine code, e.g. 'hit-dice-overspent'
   * @param {string} message — human-readable reason
   * @param {object} [details] — structured context for the UI
   */
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'CampaignRuleError';
    this.code = code;
    this.details = details;
  }
}

/**
 * Throw a CampaignRuleError unless `cond` holds.
 * @param {unknown} cond
 * @param {string} code
 * @param {string} message
 * @param {object} [details]
 */
export function ruleAssert(cond, code, message, details) {
  if (!cond) throw new CampaignRuleError(code, message, details);
}
