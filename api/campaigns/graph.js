// Campaign graph validation for the authoring API (M65 B22), over E6's
// shared validators (H21, src/js/shared/campaign.js):
//   validateCampaignGraph(nodes)  → {ok, errors: [{path, code, message}]}
//   validateCampaignSettings(s)   → same shape
// Node v1: {id, kind, title, ord?, start?: true, payload, next: [{to, label?, when?}]}.

import { VALIDATION_CODES as C } from '../../src/js/shared/check.js';
import * as shared from '../../src/js/shared/campaign.js';

/** Always true since H21 merged (kept for callers that still read it). */
export const SHARED_VALIDATORS = true;

/** Node kinds (campaign_nodes.kind). */
export const NODE_KINDS = Object.freeze([...shared.NODE_KINDS]);

/** Root-path codes from validateCampaignGraph that describe an unfinished graph (H21, per E6). */
const ROOT_WARNINGS = new Set([C.REQUIRED, C.DUPLICATE, C.RANGE]);   // no start / ambiguous start / no nodes

/**
 * Graph-shape findings that are normal while a DM is still authoring
 * (a node not yet linked, no start yet, an empty graph). They block
 * "Start run", not a save. Two start flags (`[i].start` duplicate) stay errors.
 * @param {{path: string, code: string}} e
 */
function isAuthoringWarning(e) {
  return e.code === 'unreachable' || (e.path === '' && ROOT_WARNINGS.has(e.code));
}

/**
 * Validate a node list for saving.
 * @param {object[]} nodes  node v1 objects
 * @returns {{ok: boolean, ready: boolean, errors: object[], warnings: object[], shared: boolean}}
 *   ok: savable (no hard errors: dangling edge, unknown kind, bad payload, duplicate id ...);
 *   ready: also a playable graph (one start, everything reachable).
 */
export function checkGraph(nodes) {
  const res = shared.validateCampaignGraph(nodes);
  const all = Array.isArray(res?.errors) ? res.errors : [];
  const errors = all.filter(e => !isAuthoringWarning(e));
  const warnings = all.filter(isAuthoringWarning);
  return { ok: errors.length === 0, ready: all.length === 0 && nodes.length > 0, errors, warnings, shared: SHARED_VALIDATORS };
}

/**
 * Validate campaign settings (H21 `validateCampaignSettings`).
 * @param {unknown} settings
 * @returns {{ok: boolean, errors: object[]}}
 */
export function checkSettings(settings) {
  return shared.validateCampaignSettings(settings);
}

/** H21's default campaign settings. */
export const DEFAULT_CAMPAIGN_SETTINGS = Object.freeze({ ...shared.DEFAULT_CAMPAIGN_SETTINGS });
