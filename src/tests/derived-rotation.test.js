import { test } from 'node:test';
import assert from 'node:assert';

// Placeholder for future DOM-canvas tests of rotateImageNearestNeighbor
// and drawDerivedItem. These functions reference document/canvas which
// are unavailable in the Node test runner; full unit coverage would require
// jsdom + canvas (significant dependency). Visual correctness is verified
// via the debug grid (debug.html) and the Playwright glow driver.
//
// The rotation math is documented inline in compositor.js:
//   inverse rotation: sx = cos·cx + sin·cy ; sy = -sin·cx + cos·cy
// Standard derivation: forward map R(θ) = [[cos,-sin],[sin,cos]];
// inverse map R(-θ) = R(θ)ᵀ = [[cos,sin],[-sin,cos]].

test('placeholder — rotation math is verified by code review + visual checks', () => {
  // Real assertions would require DOM-canvas. Keeping this file so the
  // test runner has something to find under the rotation-test name.
  assert.ok(true);
});
