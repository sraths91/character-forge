import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mountPlaceholder } from '../js/play.js';

test('play: placeholder renders into the root without a DOM', () => {
  const root = { textContent: '' };
  mountPlaceholder(root);
  assert.match(root.textContent, /coming in Wave 4/);
});

test('play: placeholder tolerates a missing root', () => {
  assert.doesNotThrow(() => mountPlaceholder(null));
});
