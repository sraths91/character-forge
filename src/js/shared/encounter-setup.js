/**
 * The `dm.encounter.setup` payload spec, in a leaf module so both the
 * protocol (the intent) and the campaign contract (an encounter node's
 * inline `setup`, encounter templates) embed the exact same shape without
 * an import cycle (M65 H23: protocol.js imports the run contracts, which
 * import campaign.js).
 *
 * Imported by both Vite and Node: no DOM, no Node built-ins.
 */

import { str, int, oneOf, arrayOf, shape, optional, nullable } from './check.js';

const LOOSE = { strict: false };

/** Strict spec of a `dm.encounter.setup` payload (the `setupPayload(draft)` shape). */
export const ENCOUNTER_SETUP_SPEC = shape({
  map: nullable(shape({}, LOOSE)),
  grid: shape({ cols: int(1, 500), rows: int(1, 500) }, LOOSE),
  monsters: arrayOf(shape({}, LOOSE), { max: 64 }),
  placements: shape({}, LOOSE),
  // v1 additive (E3, M64 W4): the starting fog-of-war bitset (map/fog.js).
  fog: optional(nullable(shape({ revealed: str({ allowEmpty: true, maxLength: 4096, pattern: /^[A-Za-z0-9+/]*={0,2}$/ }) }))),
  initiativeMode: optional(oneOf(['individual', 'grouped']))   // v1.2
});
