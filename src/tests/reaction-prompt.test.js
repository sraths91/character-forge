import { test } from 'node:test';
import assert from 'node:assert';
import { promptReaction } from '../js/scene/reaction-prompt.js';

// ---------- Auto-fight short-circuit (no DOM needed) ----------

test('M38: promptReaction — auto:true + autoAnswer:true resolves immediately to true', async () => {
  const out = await promptReaction({ auto: true, autoAnswer: true });
  assert.strictEqual(out, true);
});

test('M38: promptReaction — auto:true + autoAnswer:false resolves to false', async () => {
  const out = await promptReaction({ auto: true, autoAnswer: false });
  assert.strictEqual(out, false);
});

test('M38: promptReaction — auto:true defaults autoAnswer to false', async () => {
  const out = await promptReaction({ auto: true });
  assert.strictEqual(out, false);
});

// ---------- No-container fallback ----------

test('M38: promptReaction — without DOM/container resolves to false (safe default)', async () => {
  // No document available in the test runtime → container is null → returns false.
  const out = await promptReaction({ container: null });
  assert.strictEqual(out, false);
});

test('M38: promptReaction — explicit non-null container with no document still works via auto-flag', async () => {
  // Sanity check: even when caller passes a fake container, auto:true wins.
  const out = await promptReaction({ container: { appendChild() {} }, auto: true, autoAnswer: true });
  assert.strictEqual(out, true);
});
